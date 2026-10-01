
/** Extend the existing cursor fixture with its owned clipping parent. */
function cursorChildren(createCursor: () => any): (options?: { cls?: string }) => any {
	return (options) => {
		const cursor = createCursor();
		if (options?.cls !== "handwriting-pdf-cursor-viewport") return cursor;
		const viewport = {
			parentElement: cursor.parentElement,
			classList: { contains: (cls: string) => cls === "handwriting-pdf-cursor-viewport" },
			setCssStyles() {},
			createDiv: () => cursor,
			remove() { cursor.remove(); viewport.parentElement = null; },
		};
		cursor.parentElement = viewport;
		return viewport;
	};
}
/**
 * The defect this pins: `InlinePenRouter` caches the pane element's
 * `getBoundingClientRect()` in `this.rect` and refreshes it in exactly ONE
 * place - its own pointerdown handler. `PdfInkController`'s ResizeObserver
 * invalidated its OWN probe cache on a resize but never told the router, so
 * a HOVER (no pointerdown to refresh it) after a re-layout that MOVED the
 * pane - a split opening or closing beside it - was mapped against the
 * pane's OLD origin. The reticle painted far outside its own pane, and
 * `showCursor`'s `handwriting-pdf-hover` class (`cursor: none` on the whole
 * viewer, styles.css) made the native arrow disappear at the same moment -
 * nothing visible at all.
 *
 * Driven the way `PdfInkController.test.ts`'s "PdfInkController pen
 * reticle" suite drives `bindTo` directly with a `test/routerHarness.ts`
 * `fakeEl` - a REAL `InlinePenRouter`, constructed by the REAL `bindTo`,
 * registers its REAL capture handlers on the fake element, and this file
 * fires REAL pointer events into them. Nothing here calls `showCursor`,
 * `refreshRect` or the resize callback directly - all three are reached
 * only through that real router and a real fired event, which is the one
 * thing the existing suites never did (they call `penDown`/`penRaw` on the
 * controller directly, bypassing the router's own rect entirely, or drive
 * `InkOverlayPlugin`, which has no `PdfInkController` in it at all).
 *
 * `CrossPaneReticleUnderHand.test.ts` cannot certify this: its own header
 * records that its fake window keeps one handler per event type, so a
 * second router silently overwrites the first router's registration -
 * exactly wrong for a two-pane test. It also drives `InkOverlayPlugin`'s
 * routers, never a `PdfInkController`. This file builds two REAL
 * `PdfInkController` instances, each with its own fake scroller (so each
 * gets its own handler map) and keeps both bound throughout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PenSample } from "../input/PointerRouter";
// The router's window-level mirror (armWindowMirror, winRef) needs SOME
// window to register on; this is the same minimal stub
// `PdfInkController.test.ts`'s own reticle suite installs (`installWindow`
// there), lifted from the router's own harness rather than re-invented.
import { installFakeWindow } from "../../test/routerHarness";

// `calls` counts every `probeViewer` that actually runs. This mock is the
// ONLY place such a call can be observed from, which is why item A's
// acceptance is counted here rather than inferred from timings.
const probe = vi.hoisted(() => ({ byRoot: new Map<unknown, unknown>(), calls: 0 }));
vi.mock("./PdfViewerProbe", () => ({
	probeViewer: (root: unknown) => {
		probe.calls++;
		return probe.byRoot.get(root) ?? null;
	},
	viewerCanvasOf: () => null,
}));

import { PdfInkController } from "./PdfInkController";

/** css px per point; identity keeps the pointer-vs-content arithmetic legible. */
const SCALE = 1;

/**
 * Captures every `ResizeObserver` this test run constructs, in construction
 * order, so a test can fire the exact callback `PdfInkController.bindTo`
 * installed - the production code's own callback, not a re-implementation of
 * it - without a real browser ever observing a real resize.
 */
class CapturingResizeObserver {
	static instances: CapturingResizeObserver[] = [];
	/** every element this instance was asked to observe, in call order - lets a test tell OBSERVATION apart from mere construction. */
	observed: Element[] = [];
	constructor(public readonly cb: () => void) {
		CapturingResizeObserver.instances.push(this);
	}
	observe(el: Element): void {
		this.observed.push(el);
	}
	unobserve(): void {}
	disconnect(): void {}
}

/** A no-op MutationObserver; `mount()` is never called in this file, so this exists only to satisfy the type if something reaches for it. */
class NoopMutationObserver {
	observe(): void {}
	disconnect(): void {}
	takeRecords(): [] {
		return [];
	}
}

function sample(x: number, y: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
}

interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * The router-and-controller-holding element, extracted from
 * `test/routerHarness.ts`'s `fakeEl` with ONE addition: a MUTABLE rect, so a
 * test can move the pane's origin the way a split does and observe what the
 * router does with a hover that follows.
 */
function fakePane(rect: Rect) {
	const handlers = new Map<string, (ev: Event) => void>();
	const classes = new Set<string>();
	let cursorStyle: Record<string, unknown> = { display: "none" };
	let cursorEl: {
		setAttribute: () => void;
		remove: () => void;
		classList: { toggle: () => void; add: () => void; remove: () => void };
		setCssStyles: (styles: Record<string, unknown>) => void;
		parentElement: unknown;
	} | null = null;
	const el = {
		rect,
		handlers,
		scrollLeft: 0,
		scrollTop: 0,
		contains: (_n: unknown) => false,
		style: { touchAction: "" },
		setCssStyles(styles: { touchAction?: string; position?: string }) {
			if (styles.touchAction !== undefined) this.style.touchAction = styles.touchAction;
		},
		classList: {
			add: (c: string) => void classes.add(c),
			remove: (c: string) => void classes.delete(c),
			contains: (c: string) => classes.has(c),
			toggle: (c: string, on?: boolean) => {
				const want = on ?? !classes.has(c);
				if (want) classes.add(c);
				else classes.delete(c);
				return want;
			},
		},
		addEventListener(type: string, h: (ev: Event) => void) {
			handlers.set(type, h);
		},
		removeEventListener() {},
		getBoundingClientRect: () => ({
			left: rect.left,
			top: rect.top,
			right: rect.left + rect.width,
			bottom: rect.top + rect.height,
			width: rect.width,
			height: rect.height,
			x: rect.left,
			y: rect.top,
		}),
		setPointerCapture() {},
		releasePointerCapture() {},
		querySelector: () => null,
		createDiv: cursorChildren(() => {
			cursorEl = {
				setAttribute: () => {},
				remove: () => {},
				classList: { add: () => {}, remove: () => {}, toggle: () => {} },
				setCssStyles: (styles: Record<string, unknown>) => {
					Object.assign(cursorStyle, styles);
				},
				parentElement: el,
			};
			return cursorEl;
		}),
	};
	el.contains = (n: unknown) => n === el;
	return {
		el,
		fire(ev: Event & { type: string }) {
			const h = handlers.get(ev.type);
			if (!h) throw new Error(`the router registered no handler for ${ev.type}`);
			h(ev);
		},
		hasHoverClass: () => classes.has("handwriting-pdf-hover"),
		cursorStyle: () => cursorStyle,
		cursorVisible: () => cursorStyle.display === "block",
		/** transform is `translate(${x}px, ${y}px)`; parsed back out for the assertion. */
		ringTopLeft(): { x: number; y: number } {
			const t = String(cursorStyle.transform ?? "");
			const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(t);
			if (!m) throw new Error(`no transform painted yet: ${t}`);
			return { x: Number(m[1]), y: Number(m[2]) };
		},
		ringSize(): number {
			return Number(String(cursorStyle.width ?? "0px").replace("px", ""));
		},
	};
}

function moveEvent(x: number, y: number, pointerType = "pen"): Event & Record<string, unknown> {
	return {
		type: "pointermove",
		pointerType,
		pointerId: 3,
		isPrimary: true,
		clientX: x,
		clientY: y,
		pressure: 0,
		buttons: 0,
		button: -1,
		timeStamp: performance.now(),
		tiltX: 0,
		tiltY: 0,
		width: 0,
		height: 0,
		preventDefault: () => {},
		stopPropagation: () => {},
	} as unknown as Event & Record<string, unknown>;
}

/** Frames `schedule()` queued, drained only by an explicit `drainFrames()`. */
let frameQueue: (() => void)[] = [];

/** Run every queued frame and answer how many ran. */
function drainFrames(): number {
	const queued = frameQueue;
	frameQueue = [];
	for (const f of queued) f();
	return queued.length;
}

function win() {
	return {
		devicePixelRatio: 1,
		navigator: { userAgent: "", platform: "", maxTouchPoints: 0 },
		setTimeout: () => 0,
		clearTimeout: () => {},
		// Captured, never run on its own: item A's counts are "synchronous +
		// deferred", and the only way to tell those apart is to hold the frame
		// until a test drains it. Nothing here drains implicitly, so the
		// existing cases behave exactly as they did when this returned 0.
		requestAnimationFrame: (cb: () => void) => frameQueue.push(cb),
		getComputedStyle: () => ({ position: "relative" }),
	} as unknown as Window;
}

/**
 * Every router this file's tests construct, so `afterEach` can dispose each
 * one. `anyHandOnGlass()` (InlinePenRouter.ts) walks a MODULE-LEVEL set of
 * live routers - not one scoped to a test - so a router left live after its
 * `it` block ends can make a LATER test's "hand on glass" read true for
 * reasons that have nothing to do with what that later test is doing.
 */
let liveControllers: PdfInkController[] = [];

/** Build a controller, probe it with `rect`, and bind it - a real router included. */
function makeController(root: object, rect: Rect) {
	const pane = fakePane(rect);
	probe.byRoot.set(root, {
		scroller: pane.el,
		scaleFactor: SCALE,
		scaleSource: "test",
		pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: rect.width, heightPx: rect.height, hasCanvas: true }],
	});
	const controller = new PdfInkController(
		root as unknown as HTMLElement,
		win(),
		() => [],
		() => "doc-1",
		() => [],
		() => {}
	);
	(controller as unknown as { bindTo(el: unknown): void }).bindTo(pane.el);
	liveControllers.push(controller);
	return { controller, pane };
}

describe("PdfInkController: the router's rect on a resize", () => {
	let restoreRO: typeof globalThis.ResizeObserver;
	let restoreMO: typeof globalThis.MutationObserver;
	let uninstallWindow: () => void = () => {};

	beforeEach(() => {
		liveControllers = [];
		probe.calls = 0;
		frameQueue = [];
		uninstallWindow = installFakeWindow();
		CapturingResizeObserver.instances = [];
		restoreRO = globalThis.ResizeObserver;
		restoreMO = globalThis.MutationObserver;
		(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = CapturingResizeObserver;
		(globalThis as unknown as { MutationObserver: unknown }).MutationObserver = NoopMutationObserver;
	});

	afterEach(() => {
		for (const c of liveControllers) {
			(c as unknown as { router: { dispose(): void } | null }).router?.dispose();
		}
		liveControllers = [];
		(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = restoreRO;
		(globalThis as unknown as { MutationObserver: unknown }).MutationObserver = restoreMO;
		uninstallWindow();
	});

	/**
	 * Acceptance 1 + 2 (this test IS the sameness the negative control runs
	 * against - see the handback for the reverted run's numbers): a 350px-wide
	 * pane whose origin moves to x=350 (a second pane opening to its left,
	 * the split shape the brief traces on hardware), then a mouse hover at a
	 * client point that is only really over the pane AFTER the move.
	 */
	it("keeps the reticle inside its own pane after the pane's origin moves", () => {
		const rect: Rect = { left: 0, top: 0, width: 350, height: 600 };
		const { pane } = makeController({}, rect);

		// The pane splits: it now starts at x=350, same width. Nothing has
		// told the router yet - this is the moment `this.rect` goes stale.
		rect.left = 350;
		const ro = CapturingResizeObserver.instances[0]!;
		// Production must actually OBSERVE the scroller, not merely construct
		// an observer around it - `instances[0]` existing proves construction
		// only; this proves the pane element itself was the argument to
		// `.observe(...)`, by object identity.
		expect(ro.observed).toEqual([pane.el]);
		expect(ro.observed[0]).toBe(pane.el);
		ro.cb(); // the exact callback PdfInkController.bindTo installed

		// A client point that is only really over the pane's new box
		// (350..700) - well outside its old one (0..350).
		pane.fire(moveEvent(400, 300));

		expect(pane.cursorVisible()).toBe(true);
		const ring = pane.ringTopLeft();
		const size = pane.ringSize();
		// The ring's rect, inside the parent's OWN box (0,0)-(350,600) in the
		// scroller's local content frame (scrollLeft/Top are 0 throughout).
		expect(ring.x).toBeCloseTo(50 - size / 2, 6); // 400 - 350 (new left) - r
		expect(ring.y).toBeCloseTo(300 - size / 2, 6);
		expect(ring.x).toBeGreaterThanOrEqual(0);
		expect(ring.x + size).toBeLessThanOrEqual(rect.width);
		expect(ring.y).toBeGreaterThanOrEqual(0);
		expect(ring.y + size).toBeLessThanOrEqual(rect.height);
	});

	/**
	 * Acceptance 3: the arrow half. `showCursor` sets `handwriting-pdf-hover`
	 * (`cursor: none` on the whole viewer, styles.css:399) on every paint; the
	 * fix's `hideCursor()` inside the resize callback must take it back off
	 * immediately, not leave it hanging until the next hover repaints.
	 */
	it("drops handwriting-pdf-hover on a resize, before any fresh hover re-adds it", () => {
		const rect: Rect = { left: 0, top: 0, width: 350, height: 600 };
		const { pane } = makeController({}, rect);

		pane.fire(moveEvent(100, 100));
		expect(pane.hasHoverClass()).toBe(true); // the ordinary hover behaviour

		rect.left = 350;
		const ro = CapturingResizeObserver.instances[0]!;
		ro.cb();
		expect(pane.hasHoverClass()).toBe(false); // the arrow is back, unasked
		expect(pane.cursorVisible()).toBe(false); // and the stranded ring is down too

		pane.fire(moveEvent(400, 300));
		expect(pane.hasHoverClass()).toBe(true); // a fresh hover repaints both
		expect(pane.cursorVisible()).toBe(true);
	});

	/**
	 * Acceptance 4: two panes, same document, BOTH open throughout - a
	 * close-a-pane control proves nothing here, since closing is exactly what
	 * silently heals the stale rect on hardware (the brief's own finding).
	 * Two real `PdfInkController`s, two real routers, two fake scrollers (so
	 * each keeps its own handler map - the trap `CrossPaneReticleUnderHand`'s
	 * header names for a SHARED fake window). Only pane B resizes; pane A's
	 * ring must be unaffected.
	 */
	it("two open panes on the same document: a resize in one does not strand the other, and the resized one recovers", () => {
		const rootA = {};
		const rootB = {};
		const rectA: Rect = { left: 0, top: 0, width: 350, height: 600 };
		const rectB: Rect = { left: 0, top: 0, width: 350, height: 600 };
		const { pane: paneA } = makeController(rootA, rectA);
		const { pane: paneB } = makeController(rootB, rectB);
		expect(CapturingResizeObserver.instances).toHaveLength(2);
		// Each observer must be watching ITS OWN pane's scroller, not merely
		// exist - the second observer's argument, by identity, is paneB's
		// element, proving production actually observes it rather than only
		// constructing an observer.
		expect(CapturingResizeObserver.instances[1]!.observed).toEqual([paneB.el]);
		expect(CapturingResizeObserver.instances[1]!.observed[0]).toBe(paneB.el);

		// Establish a visible ring in both panes first.
		paneA.fire(moveEvent(120, 80));
		paneB.fire(moveEvent(120, 80));
		expect(paneA.cursorVisible()).toBe(true);
		expect(paneB.cursorVisible()).toBe(true);
		const ringABefore = paneA.ringTopLeft();

		// Only B splits open further, moving to x=350.
		rectB.left = 350;
		CapturingResizeObserver.instances[1]!.cb();

		// A is untouched: no resize fired for it, its ring stays exactly put.
		expect(paneA.cursorVisible()).toBe(true);
		expect(paneA.ringTopLeft()).toEqual(ringABefore);

		// B recovers on the next hover, at its NEW origin.
		expect(paneB.cursorVisible()).toBe(false);
		paneB.fire(moveEvent(400, 300));
		expect(paneB.cursorVisible()).toBe(true);
		const ringB = paneB.ringTopLeft();
		const sizeB = paneB.ringSize();
		expect(ringB.x).toBeCloseTo(50 - sizeB / 2, 6);
		expect(ringB.x).toBeGreaterThanOrEqual(0);
		expect(ringB.x + sizeB).toBeLessThanOrEqual(rectB.width);
	});

	/**
	 * The brief's open question, partly closed: `showCursor` returns a
	 * `ReticleOutcome`; every real caller ignores it (it is diagnostic), but
	 * nothing stops a test reading it back the same way the existing "PdfInkController
	 * pen reticle" suite reads other private members - a cast, not a
	 * production change. Reachable, and it answers what a stale-but-not-yet-
	 * fixed hover WOULD have returned: "wrote", with the ring already shown to
	 * be off-pane above. This is in-test evidence for the mechanism, not for
	 * what happened on Alan's hardware while the pointer was invisible there -
	 * that half is device-only and this file cannot reach it.
	 */
	it("showCursor still reports \"wrote\" for the stale-rect hover (the mechanism, not the device symptom)", () => {
		const rect: Rect = { left: 0, top: 0, width: 350, height: 600 };
		const { controller, pane } = makeController({}, rect);
		rect.left = 350;
		// Deliberately no refreshRect/hideCursor here: this probes what
		// showCursor's RETURN VALUE was for the exact stale-rect hover the
		// fix now prevents from ever reaching users, by calling it directly
		// with a sample computed the way the OLD (unrefreshed) router would
		// have produced it - clientX 400 against the STALE left of 0.
		const priv = controller as unknown as {
			showCursor(s: PenSample, pointerType?: string): string;
		};
		const staleSample = sample(400 - 0, 300 - 0); // stale rect.left was 0
		const outcome = priv.showCursor(staleSample, "mouse");
		expect(outcome).toBe("wrote");
		// And "wrote" here painted the ring at content x=400, well outside a
		// 350-wide pane - the off-pane paint the brief traces, evidenced
		// in-test rather than only reasoned about.
		const ring = pane.ringTopLeft();
		const size = pane.ringSize();
		expect(ring.x + size).toBeGreaterThan(rect.width);
	});

	/**
	 * ITEM A: the resize callback is genuinely SCAN-FREE.
	 *
	 * `hideCursor` used to take a `probe()` as its fourth statement, and the
	 * ResizeObserver callback calls `invalidateProbe()` immediately before it - so
	 * that probe could never be served from cache. Every delivery ran
	 * `probeViewer` in full, synchronously, inside the callback, even with no
	 * cursor on screen; `probeViewer` reads `clientWidth`, `clientHeight`,
	 * `offsetTop`, `offsetLeft` and a rect off every page div, and pdf.js keeps
	 * every page div alive. Dragging a split divider fires resize continuously.
	 *
	 * THREE conditions, because a warm-cache-only result is exactly what made the
	 * rejected "hide before invalidate" reorder look adequate - it was measured at
	 * 7 + 1 warm and 8 + 1 cold, shifting the scan rather than removing it. The
	 * requirement is scan-free, and one condition cannot show that.
	 *
	 * On "deferred": `schedule()` queues its work on a frame, and this file never
	 * calls `mount()` (see the header), so `this.mounted` is false and `schedule()`
	 * returns at its own guard. Deferred is therefore 0 here in every condition,
	 * including on the reverted source - the number item A is about is the
	 * SYNCHRONOUS one, and the reverted run is what gives it meaning.
	 */
	describe("the resize callback takes no layout scan (item A)", () => {
		const rectOf = (): Rect => ({ left: 0, top: 0, width: 350, height: 600 });

		it("A(i) warm cache: a delivery runs no probeViewer at all", () => {
			const { pane } = makeController({}, rectOf());
			pane.fire(moveEvent(100, 100));
			expect(pane.hasHoverClass()).toBe(true); // a real cursor is up, and the cache is warm

			probe.calls = 0;
			CapturingResizeObserver.instances[0]!.cb();
			const synchronous = probe.calls;
			const deferred = (drainFrames(), probe.calls - synchronous);

			expect(synchronous).toBe(0);
			expect(deferred).toBe(0);
			// and the callback still did its job
			expect(pane.hasHoverClass()).toBe(false);
		});

		it("A(ii) cold cache: a delivery still runs no probeViewer", () => {
			const { controller, pane } = makeController({}, rectOf());
			pane.fire(moveEvent(100, 100));
			// Cold on purpose. The callback invalidates as its first statement
			// anyway, so this condition is the one the old code could never serve
			// from cache - and the one a reorder leaves scanning.
			(controller as unknown as { probedValid: boolean }).probedValid = false;

			probe.calls = 0;
			CapturingResizeObserver.instances[0]!.cb();
			const synchronous = probe.calls;
			const deferred = (drainFrames(), probe.calls - synchronous);

			expect(synchronous).toBe(0);
			expect(deferred).toBe(0);
		});

		it("A(iii) eight deliveries before a frame: zero synchronous probeViewer calls", () => {
			const { pane } = makeController({}, rectOf());
			pane.fire(moveEvent(100, 100));

			probe.calls = 0;
			const ro = CapturingResizeObserver.instances[0]!;
			for (let i = 0; i < 8; i++) ro.cb();
			const synchronous = probe.calls;
			const deferred = (drainFrames(), probe.calls - synchronous);

			// The measured shape of the defect was 8 + 0 here: one full scan per
			// delivery, none of it coalesced by `schedule()`, because the scan sat
			// outside the frame.
			expect(synchronous).toBe(0);
			expect(deferred).toBe(0);
		});

		/**
		 * Acceptance 2, and the case the probe existed to serve: pdf.js rebuilds
		 * its viewer, so the element `showCursor` put the class ON is no longer the
		 * element a fresh probe returns - and it is not `boundScroller` either.
		 * Only a recorded owner can take the class off it.
		 *
		 * The hover is painted AFTER the swap, so the class lands on the new
		 * scroller while `boundScroller` still names the old one. Clearing only
		 * `boundScroller` leaves `cursor: none` over the whole rebuilt viewer with
		 * nothing on screen to explain it - which is the red this case watches.
		 */
		it("A(2) viewer replacement: the class comes off the element that received it", () => {
			const root = {};
			const { controller, pane } = makeController(root, rectOf());
			const rebuilt = fakePane(rectOf());
			probe.byRoot.set(root, {
				scroller: rebuilt.el,
				scaleFactor: SCALE,
				scaleSource: "test",
				pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 350, heightPx: 600, hasCanvas: true }],
			});
			(controller as unknown as { invalidateProbe(): void }).invalidateProbe();

			// The pointer still arrives on the bound element; the class lands on
			// whatever the probe now returns, which is the rebuilt one.
			pane.fire(moveEvent(100, 100));
			expect(rebuilt.hasHoverClass()).toBe(true);
			expect(pane.hasHoverClass()).toBe(false);

			(controller as unknown as { hideCursor(): void }).hideCursor();
			expect(rebuilt.hasHoverClass()).toBe(false);
		});
	});
});
