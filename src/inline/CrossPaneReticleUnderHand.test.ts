/**
 * The 1.4.12 reticle ruling, across PANES.
 *
 * THE RULE AS IT SHIPPED, and it is correct as far as it goes: while a finger
 * or pen is on the glass, a parked mouse's hover reticle is hidden, and it
 * returns when the hand leaves. 1.4.13 gave the pdf surface the same rule.
 * Both halves read `InlinePenRouter.handOnGlass()` - a DERIVED answer whose
 * every term is router state that already heals itself.
 *
 * THE GAP THIS FILE IS ABOUT, recorded as found-not-fixed when the note fix
 * was merged: the answer was per-surface, because the router is per-surface.
 * With two panes open side by side, a finger writing in pane A did not take
 * down the mouse's ring in pane B. The ring in the pane the user is NOT
 * touching stayed lit - the same noise the original ruling was about, and the
 * owner's words for it ("a marker for a pointer nobody is using ... reads as a
 * smudge on the glass", `InlinePenRouter.onHandOnGlass`) apply unchanged.
 *
 * WHY IT TAKES BOTH HALVES GOING GLOBAL, and this is the whole reason this
 * file exists rather than an extra case in `MouseReticleUnderHand.test.ts`.
 * The GATE (`anyHandOnGlass()` read in `showPenCursor`) stops pane B's next
 * mouse sample painting a ring - but a parked mouse sends no next sample, so
 * the gate alone cannot take down a ring that is ALREADY lit in a pane nobody
 * is touching. The EDGE is what does that, and it has to reach every live
 * router rather than only the one the finger landed on. Case 1 below is
 * exactly that edge and is the one that was red.
 *
 * WHAT IS DELIBERATELY NOT GLOBAL: the edge's own QUESTION. The finger's
 * router still asks its OWN `handOnGlass()` before announcing, so the
 * edge-not-level property `onHandOnGlass` documents at length survives - a
 * palm settling beside a working pen sees a hand already on ITS glass and
 * says nothing, and the pen's ring never blinks. Only the ANSWER fans out.
 *
 * TWO SURFACES, and how. `makeRig()` below is duplicated from
 * `MouseReticleUnderHand.test.ts` rather than extracted from it, on purpose:
 * that file is the 1.4.12 acceptance record and must not move under this
 * change. Two calls give two fully independent surfaces - each with its own
 * element fake (`test/routerHarness.ts`, whose `handlers` map is per element),
 * its own `Object.create`d overlay, its own reticle element and its own REAL
 * `InlinePenRouter`. The callback object is wired byte-for-byte the way
 * `InkOverlayPlugin.mount()` wires it, `onHandOnGlass` included, so nothing
 * about the cross-pane behaviour is supplied by the rig: it all has to come
 * out of the router.
 *
 * The rigs share only the module-level fake window. That is fine here and
 * would not be everywhere: `installFakeWindow`'s `winHandlers` is a single Map
 * keyed by event type, so a second router's WINDOW listeners overwrite the
 * first's. Every path this file drives is scroller-level, so none of it
 * depends on window delivery - a later test that needs the end backstop or
 * the ownership mirror on two surfaces at once cannot use this harness as is.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { InkOverlayPlugin, releaseTipModes, setPenReticle } from "./InkOverlay";
import { InlinePenCallbacks, InlinePenRouter } from "./InlinePenRouter";
import { SelectionModel } from "../objects/SelectionModel";
import { Camera } from "../camera/Camera";
import { StrokeFrame } from "./StrokeFrame";
import { setTipMode } from "./TipMode";
import { setMouseInk } from "./MouseInk";
import { PEN_HOVER_CLASS } from "./PenCursor";
import { fakeEl, installFakeWindow } from "../../test/routerHarness";
import type { PenSample } from "../input/PointerRouter";
import { reticleShown } from "../testUtils/ReticleShown";

/**
 * One pointer event. Distinct `pointerId`s per pointer on purpose: the
 * router's touch bookkeeping is keyed by id, and a mouse sharing the finger's
 * id would make it delete the wrong contact.
 */
function ptr(
	type: string,
	pointerType: string,
	pointerId: number,
	x: number,
	y: number,
	buttons = 0
): PointerEvent {
	return {
		type,
		pointerType,
		pointerId,
		isPrimary: true,
		clientX: x,
		clientY: y,
		pressure: buttons === 0 ? 0 : 0.5,
		buttons,
		button: 0,
		timeStamp: 0,
		tiltX: 0,
		tiltY: 0,
		width: 0,
		height: 0,
		preventDefault: () => {},
		stopPropagation: () => {},
	} as unknown as PointerEvent;
}

/** The lasso ring is `visualToNote(9)` at cssScale 1, centred on the sample. */
function ringAt(x: number, y: number): string {
	return `translate(${x - 9}px, ${y - 9}px)`;
}

interface Proto {
	showPenCursor(this: unknown, s: PenSample, pointerType?: string): void;
	hidePenCursor(this: unknown): void;
	penDown(this: unknown, s: PenSample, ev: PointerEvent): void;
	penUp(this: unknown, ev?: PointerEvent): void;
}

interface Rig {
	router: InlinePenRouter;
	proto: Proto;
	inst: Record<string, unknown>;
	/** What the reticle element was last styled with; `display` is the ring. */
	cursorStyle: Record<string, unknown>;
	/** The scroller's classes, really tracked - `cursor: none` lives here. */
	scrollerClasses: Set<string>;
	/** Deliver an event to the router's own capture handler for its type. */
	fire(ev: PointerEvent): void;
	/**
	 * Idempotent, unlike the 1.4.12 rig's. Case 4 closes a pane inside the
	 * test body and `afterEach` then tears the same rig down; a second real
	 * `dispose()` would decrement the window mirror's refcount for a router
	 * that already left, and the mirror would come down under the pane still
	 * open. Guarded here rather than in the router: nothing in production
	 * disposes a router twice.
	 */
	dispose(): void;
}

function makeRig(): Rig {
	const noop = (): void => undefined;
	const cursorStyle: Record<string, unknown> = { display: "none" };
	const scrollerClasses = new Set<string>();
	const el = fakeEl();

	const inst = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;

	// Gesture state at its real class-field defaults (`Object.create` skips
	// field initialisers, so these are supplied by hand).
	inst.mode = "ink";
	inst.camera = new Camera();
	inst.scale = 1;
	inst.cssScale = 1;
	inst.selection = new SelectionModel();
	inst.lassoPts = [];
	inst.lassoActive = false;
	inst.dragFrom = null;
	inst.dragTotal = null;
	inst.spaceLineY = null;
	inst.spaceIds = [];
	inst.spaceBounds = null;
	inst.spaceClient = null;
	inst.panLast = null;
	inst.spaceFromY = 0;
	inst.spaceTotalDy = 0;
	inst.mobileTools = null;
	inst.hoverWatchdog = null;
	inst.mouseStroke = false;
	inst.frame = new StrokeFrame();

	inst.penCursorEl = {
		setAttribute: noop,
		classList: { add: noop, remove: noop },
		setCssStyles: (styles: Record<string, unknown>) => Object.assign(cursorStyle, styles),
	};

	inst.view = {
		dom: {
			ownerDocument: {
				defaultView: { setTimeout: () => 1, clearTimeout: noop },
			},
		},
		hasFocus: true,
		focus: noop,
		scrollDOM: {
			classList: {
				add: (c: string) => void scrollerClasses.add(c),
				remove: (c: string) => void scrollerClasses.delete(c),
			},
			scrollLeft: 0,
			scrollTop: 0,
		},
	};
	inst.container = { getBoundingClientRect: () => ({ left: 0, top: 0 }) };

	inst.ensurePenTools = noop;
	inst.syncCamera = noop;
	inst.recordPenDownState = noop;
	inst.redrawSelectionUI = noop;
	inst.updateExtent = noop;
	inst.filePath = (): string | null => null;

	const proto = InkOverlayPlugin.prototype as unknown as Proto;

	// The same wiring `InkOverlayPlugin.mount()` gives the router, for the
	// members the reticle depends on. Anything a claimed stroke would feed is
	// a no-op: this file is about which pointer owns the ring, not about ink.
	//
	// `onHandOnGlass` is THIS surface's own stand-down and nothing more - the
	// production body, unchanged by this brief. If the cross-pane cases below
	// pass, they pass because the ROUTER fanned the edge out, not because the
	// rig was taught to.
	const cb: InlinePenCallbacks = {
		onPenDown: (s, ev) => proto.penDown.call(inst, s, ev),
		onPenHover: (s, pt) => proto.showPenCursor.call(inst, s, pt),
		onPenLeave: () => proto.hidePenCursor.call(inst),
		onPinch: () => {},
		onPenRaw: () => {},
		onPenMove: () => {},
		onPenUp: (ev) => proto.penUp.call(inst, ev),
		onHandOnGlass: () => proto.hidePenCursor.call(inst),
	};

	const router = new InlinePenRouter(
		el as unknown as HTMLElement,
		el as unknown as HTMLElement,
		cb
	);
	inst.router = router;

	let disposed = false;
	return {
		router,
		proto,
		inst,
		cursorStyle,
		scrollerClasses,
		fire: (ev: PointerEvent) => {
			const h = el.handlers.get(ev.type);
			if (!h) throw new Error(`router registered no handler for ${ev.type}`);
			h(ev);
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			router.dispose();
		},
	};
}

let undoWindow: () => void;

beforeAll(() => {
	undoWindow = installFakeWindow();
});

afterAll(() => {
	undoWindow();
});

describe("a hand on one pane's glass stands the OTHER pane's mouse reticle down", () => {
	/** The pane the hand is on. */
	let a: Rig;
	/** The pane the mouse was left parked over. */
	let b: Rig;

	beforeEach(() => {
		setPenReticle(true);
		releaseTipModes();
		// Mouse ink ARMED is the whole premise: it is the only state in which
		// a mouse hover reaches `onPenHover` at all (`mouseActsAsPen`), and so
		// the only state in which there is a mouse reticle to hide.
		setMouseInk(true);
		setTipMode("lasso");
		a = makeRig();
		b = makeRig();
	});

	afterEach(() => {
		a.dispose();
		b.dispose();
		setMouseInk(false);
		setPenReticle(true);
		releaseTipModes();
	});

	it("RED-WATCHED: a finger landing in pane A takes down the parked mouse's ring in pane B", () => {
		// The mouse hovers over pane B and is then left alone - the reported
		// state. Pane A has seen nothing at all.
		b.fire(ptr("pointermove", "mouse", 1, 500, 500));
		expect(reticleShown(b.cursorStyle)).toBe(true);
		expect(b.cursorStyle.transform).toBe(ringAt(500, 500));
		expect(b.scrollerClasses.has(PEN_HOVER_CLASS)).toBe(true);

		// A finger lands in the OTHER pane. The mouse sends nothing: it has
		// not moved and is not going to, so nothing but the edge can reach
		// pane B at all.
		a.fire(ptr("pointerdown", "touch", 2, 120, 300));

		expect(
			reticleShown(b.cursorStyle),
			"pane B's ring stayed lit while a finger was writing in pane A"
		).toBe(false);
		expect(
			b.scrollerClasses.has(PEN_HOVER_CLASS),
			"`cursor: none` was left over pane B's scroller with no ring under it"
		).toBe(false);
	});

	it("RED-WATCHED: the finger lifting in pane A gives pane B its ring back on the next mouse move", () => {
		b.fire(ptr("pointermove", "mouse", 1, 500, 500));
		a.fire(ptr("pointerdown", "touch", 2, 120, 300));
		expect(
			reticleShown(b.cursorStyle),
			"pane B's ring stayed lit while a finger was writing in pane A"
		).toBe(false);

		// The finger leaves pane A. Nothing about the mouse has changed, so
		// its next hover over pane B is its ordinary one.
		a.fire(ptr("pointerup", "touch", 2, 120, 300));
		b.fire(ptr("pointermove", "mouse", 1, 500, 500));

		expect(reticleShown(b.cursorStyle), "pane B never got its reticle back").toBe(true);
		expect(b.cursorStyle.transform).toBe(ringAt(500, 500));
		expect(b.scrollerClasses.has(PEN_HOVER_CLASS)).toBe(true);
	});

	it("a mouse nudged over pane B while the finger is still down in pane A paints nothing", () => {
		// The edge alone is not the rule. This is the GATE, cross-pane: a
		// mouse jogged by the wrist holding the tablet must not put the
		// smudge back in the pane nobody is touching.
		b.fire(ptr("pointermove", "mouse", 1, 500, 500));
		a.fire(ptr("pointerdown", "touch", 2, 120, 300));
		expect(reticleShown(b.cursorStyle)).toBe(false);

		b.fire(ptr("pointermove", "mouse", 1, 520, 480));

		expect(
			reticleShown(b.cursorStyle),
			"a mouse nudge repainted pane B's ring under a hand on pane A"
		).toBe(false);
		expect(
			b.scrollerClasses.has(PEN_HOVER_CLASS),
			"a refused sample put `cursor: none` back and left the reader no pointer at all"
		).toBe(false);
		expect(
			b.cursorStyle.transform,
			"the ring moved to the mouse without being painted"
		).toBe(ringAt(500, 500));
	});

	it("closing pane A mid-gesture does not leave pane B's ring suppressed forever", () => {
		// The way a cross-surface answer strands, and the reason the answer is
		// a live-router OR rather than a stored bit: pane A is closed with the
		// finger still down, so its `guardTouches` never sees a pointerup and
		// that router's own `handOnGlass()` stays true for good. `dispose()`
		// takes the router OUT of the set, so nothing asks it any more and the
		// global answer goes false on its own with no cleanup call.
		b.fire(ptr("pointermove", "mouse", 1, 500, 500));
		a.fire(ptr("pointerdown", "touch", 2, 120, 300));
		expect(reticleShown(b.cursorStyle)).toBe(false);
		expect(
			a.router.handOnGlass(),
			"the finger never registered on pane A's own router"
		).toBe(true);

		// The pane closes with the contact still live. In production this is
		// `InkOverlayPlugin.destroy()` -> `unmount()` -> `router.dispose()`.
		a.dispose();

		b.fire(ptr("pointermove", "mouse", 1, 500, 500));

		expect(
			reticleShown(b.cursorStyle),
			"a pane closed with a finger down suppressed the other pane's ring forever"
		).toBe(true);
		expect(b.cursorStyle.transform).toBe(ringAt(500, 500));
		expect(b.scrollerClasses.has(PEN_HOVER_CLASS)).toBe(true);
	});

	it("a hand on pane A does not stop pane A's OWN pen taking the ring", () => {
		// The negative control for the fan-out: standing every surface down is
		// only correct for a MOUSE ring. A pen that lands is not affected by
		// any of this, on its own pane or any other, because both halves are
		// gated on the sample being a mouse's.
		a.fire(ptr("pointerdown", "pen", 3, 120, 300));
		expect(a.router.isStroking, "the router did not claim the pen").toBe(true);
		expect(a.cursorStyle.transform, "the pen's contact did not take the ring").toBe(
			ringAt(120, 300)
		);
		expect(reticleShown(a.cursorStyle)).toBe(true);
	});
});

describe("with one pane open the rule is exactly what 1.4.12 shipped", () => {
	/**
	 * The negative control the brief asks for. `MouseReticleUnderHand.test.ts`
	 * is the real record and is untouched by this change; this is the same
	 * behaviour re-asserted through a set that happens to hold one router, so
	 * a regression that only shows up with `liveRouters.size === 1` cannot
	 * hide behind the two-pane cases above.
	 */
	let rig: Rig;

	beforeEach(() => {
		setPenReticle(true);
		releaseTipModes();
		setMouseInk(true);
		setTipMode("lasso");
		rig = makeRig();
	});

	afterEach(() => {
		rig.dispose();
		setMouseInk(false);
		setPenReticle(true);
		releaseTipModes();
	});

	it("a finger landing takes the parked mouse's ring down, and its lift gives it back", () => {
		rig.fire(ptr("pointermove", "mouse", 1, 500, 500));
		expect(reticleShown(rig.cursorStyle)).toBe(true);
		expect(rig.cursorStyle.transform).toBe(ringAt(500, 500));

		rig.fire(ptr("pointerdown", "touch", 2, 120, 300));
		expect(reticleShown(rig.cursorStyle), "the one-pane stand-down changed").toBe(false);
		expect(rig.scrollerClasses.has(PEN_HOVER_CLASS)).toBe(false);

		rig.fire(ptr("pointerup", "touch", 2, 120, 300));
		rig.fire(ptr("pointermove", "mouse", 1, 500, 500));
		expect(reticleShown(rig.cursorStyle), "the one-pane return changed").toBe(true);
		expect(rig.cursorStyle.transform).toBe(ringAt(500, 500));
		expect(rig.scrollerClasses.has(PEN_HOVER_CLASS)).toBe(true);
	});

	it("an untouched router says no hand is on the glass", () => {
		expect(
			rig.router.handOnGlass(),
			"an untouched router claimed a hand was on it"
		).toBe(false);
	});
});
