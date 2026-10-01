
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
 * `handwriting-pdf-hover` MUST NOT OUTLIVE ITS REASON.
 *
 * The class's rule is `cursor: none` on `.pdf-viewer-container` AND EVERY
 * DESCENDANT (styles.css:397-400). So a stuck class is not "the reticle went
 * missing" - it is no system cursor anywhere inside that viewer. In a popout
 * window holding one PDF leaf the viewer IS most of the window, which is why
 * the device report reads "the entire window not just the pdf".
 *
 * THE STRAND, measured rather than reasoned. `showCursor` paints the class on
 * `probed.scroller` and records that element. pdf.js rebuilds its viewer
 * routinely - "an ordinary Tuesday", in `showCursor`'s own words - so the
 * painted element is often NOT `boundScroller`. The teardown disposer
 * (`unmount`) removes the class from `boundScroller` only, and then clears the
 * record. The painted element keeps `cursor: none`, and nothing holds a
 * reference to it any more, so no later hide can reach it.
 *
 * NOT A REGRESSION FROM `593e482`, and this file exists partly to keep that
 * answer honest. The same scenario was executed against a verbatim copy of
 * `refs/tags/1.4.12` = c6d0003 and stranded identically (received: painted
 * element still carrying the class after `unmount()` on BOTH). Recording the
 * owner made the hide path more precise, not less. The defect is older than
 * that commit.
 *
 * WHAT THIS FILE CANNOT DO, said plainly: there is no Obsidian here, no real
 * popout, no second `document`, no touchpad. Two controller instances over two
 * fake panes stand for two windows, because the thing that breaks is a
 * reference to an element that the remover cannot reach - and element identity
 * is what carries that, in a real popout or here. A harness that cannot open a
 * popout is not evidence about popouts; it is evidence about the reference.
 *
 * Driven through the rig `PdfRouterRectOnResize.test.ts` established: a REAL
 * `PdfInkController`, a REAL `bindTo`, a REAL `InlinePenRouter` registering
 * REAL capture handlers on the fake element, and REAL fired pointer events.
 * `probeViewer` is mocked per-root so a test can change what the probe answers
 * - which is exactly what a pdf.js viewer rebuild does - while `boundScroller`
 * still holds what `bindTo` saw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PenSample } from "../input/PointerRouter";
import { installFakeWindow } from "../../test/routerHarness";

const probe = vi.hoisted(() => ({ byRoot: new Map<unknown, unknown>() }));
vi.mock("./PdfViewerProbe", () => ({
	probeViewer: (root: unknown) => probe.byRoot.get(root) ?? null,
	viewerCanvasOf: () => null,
}));

import { PdfInkController } from "./PdfInkController";

const HOVER = "handwriting-pdf-hover";
/** css px per point; identity keeps the arithmetic legible. */
const SCALE = 1;

class CapturingResizeObserver {
	constructor(public readonly cb: () => void) {}
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
class NoopMutationObserver {
	observe(): void {}
	disconnect(): void {}
	takeRecords(): [] {
		return [];
	}
}

interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

const RECT: Rect = { left: 0, top: 0, width: 300, height: 300 };

/**
 * The router-and-controller-holding element, the `fakeEl` shape from
 * `test/routerHarness.ts` with a class set this file can read.
 */
function fakePane(rect: Rect = RECT) {
	const handlers = new Map<string, (ev: Event) => void>();
	const classes = new Set<string>();
	const cursorStyle: Record<string, unknown> = { display: "none" };
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
		createDiv: cursorChildren(() => ({
			setAttribute: () => {},
			remove: () => {},
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			setCssStyles: (styles: Record<string, unknown>) => void Object.assign(cursorStyle, styles),
			parentElement: el,
		})),
	};
	el.contains = (n: unknown) => n === el;
	return {
		el,
		fire(ev: Event & { type: string }) {
			const h = handlers.get(ev.type);
			if (!h) throw new Error(`the router registered no handler for ${ev.type}`);
			h(ev);
		},
		/** The whole point of the file: is `cursor: none` still on this element? */
		hidesCursor: () => classes.has(HOVER),
		ringVisible: () => cursorStyle.display === "block",
	};
}

function hoverEvent(x: number, y: number, pointerType = "pen"): Event & Record<string, unknown> {
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

function win() {
	return {
		devicePixelRatio: 1,
		navigator: { userAgent: "", platform: "", maxTouchPoints: 0 },
		setTimeout: () => 0,
		clearTimeout: () => {},
		requestAnimationFrame: (cb: () => void) => void cb(),
		getComputedStyle: () => ({ position: "relative" }),
	} as unknown as Window;
}

function probeResult(pane: ReturnType<typeof fakePane>) {
	return {
		scroller: pane.el,
		scaleFactor: SCALE,
		scaleSource: "test",
		pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: RECT.width, heightPx: RECT.height, hasCanvas: true }],
	};
}

type Ctl = PdfInkController & { hideCursor(): void; unmount(): void };

describe("the pdf cursor class must not outlive its reason", () => {
	let restoreRO: typeof globalThis.ResizeObserver;
	let restoreMO: typeof globalThis.MutationObserver;
	let uninstallWindow: () => void = () => {};
	let live: Ctl[] = [];

	beforeEach(() => {
		live = [];
		probe.byRoot = new Map();
		uninstallWindow = installFakeWindow();
		restoreRO = globalThis.ResizeObserver;
		restoreMO = globalThis.MutationObserver;
		(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = CapturingResizeObserver;
		(globalThis as unknown as { MutationObserver: unknown }).MutationObserver = NoopMutationObserver;
	});

	afterEach(() => {
		for (const c of live) {
			(c as unknown as { router: { dispose(): void } | null }).router?.dispose();
		}
		live = [];
		(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = restoreRO;
		(globalThis as unknown as { MutationObserver: unknown }).MutationObserver = restoreMO;
		uninstallWindow();
	});

	/** A controller bound to `pane`, with the probe already answering it. */
	function controllerOn(pane: ReturnType<typeof fakePane>): { controller: Ctl; root: object } {
		const root = {};
		probe.byRoot.set(root, probeResult(pane));
		const controller = new PdfInkController(
			root as unknown as HTMLElement,
			win(),
			() => [],
			() => "doc-1",
			() => [],
			() => {}
		) as Ctl;
		(controller as unknown as { bindTo(el: unknown): void }).bindTo(pane.el);
		live.push(controller);
		return { controller, root };
	}

	/** What a pdf.js viewer rebuild does: the probe now answers a different element. */
	function rebuildViewer(root: object, pane: ReturnType<typeof fakePane>): void {
		probe.byRoot.set(root, probeResult(pane));
	}

	// ---- the controls, which must hold before AND after the fix -------------

	it("CONTROL: the ordinary single-window path still hides the cursor and un-hides it", () => {
		// If a fix satisfies the reds below by simply never adding the class,
		// this is what catches it: the feature is that the system cursor DOES
		// go away under the reticle.
		const pane = fakePane();
		const { controller } = controllerOn(pane);

		pane.fire(hoverEvent(150, 150));
		expect(pane.hidesCursor(), "the hover must hide the system cursor").toBe(true);

		controller.hideCursor();
		expect(pane.hidesCursor(), "the hide must give it back").toBe(false);
	});

	it("CONTROL: a hover after a hide hides it again", () => {
		const pane = fakePane();
		const { controller } = controllerOn(pane);
		pane.fire(hoverEvent(150, 150));
		controller.hideCursor();

		pane.fire(hoverEvent(151, 151));

		expect(pane.hidesCursor()).toBe(true);
	});

	// ---- the strand ---------------------------------------------------------

	it("a viewer rebuild then a teardown must not stranded-hide the cursor forever", () => {
		// pdf.js rebuilds its viewer, so the element the class is painted on is
		// NOT the one `bindTo` recorded. The teardown then cleans only the
		// bound one. Received on unmodified production: `true` - the rebuilt
		// scroller still carries `cursor: none`, and no reference to it
		// survives, so nothing can ever take it off.
		const bound = fakePane();
		const rebuilt = fakePane();
		const { controller, root } = controllerOn(bound);
		rebuildViewer(root, rebuilt);

		pane_hover(rebuilt, bound);
		expect(rebuilt.hidesCursor(), "the rebuilt scroller is the one that got painted").toBe(true);

		controller.unmount();

		expect(rebuilt.hidesCursor(), "the teardown must take the class off whatever wore it").toBe(false);
	});

	it("a second controller's hide clears what the first controller painted", () => {
		// The two-instance case: a popout is a second window with its own
		// controller. Whoever hides must be able to find every element that was
		// given the class, not only the ones this instance recorded.
		const paneA = fakePane();
		const paneB = fakePane();
		const { controller: a } = controllerOn(paneA);
		const { controller: b } = controllerOn(paneB);
		void a;

		paneA.fire(hoverEvent(150, 150));
		expect(paneA.hidesCursor(), "A painted its own pane").toBe(true);

		b.hideCursor();

		expect(paneA.hidesCursor(), "B's hide must reach the class A left behind").toBe(false);
	});

	/**
	 * Hover the REBUILT pane. The router is registered on the BOUND element,
	 * so the event is fired there; `showCursor` then paints whatever the probe
	 * currently answers, which is the rebuilt one.
	 */
	function pane_hover(_painted: ReturnType<typeof fakePane>, bound: ReturnType<typeof fakePane>): void {
		bound.fire(hoverEvent(150, 150));
	}
});
