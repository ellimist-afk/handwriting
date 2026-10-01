/**
 * "Product ruling: hide the mouse reticle when a finger or pen is active."
 * (Alan, 1.4.12.)
 *
 * THE SYMPTOM. With mouse ink armed a parked mouse is still HOVERING, so its
 * hover reticle floats wherever the pointer was last left - bottom right in
 * one vault, mid-screen in another - the entire time a finger is flinging the
 * page or the pen is writing. A ring marking where an unused pointer would
 * land is noise, and on a tablet it reads as a smudge on the glass. NOT a
 * regression: shipped 1.4.11 does exactly the same, because the router's hover
 * gate is `pointerType !== "pen" && !mouseActsAsPen(e)` and an armed mouse
 * passes it.
 *
 * THE RULE. While a touch or pen pointer is active - pointerdown to pointerup,
 * and while a pen HOVERS - the MOUSE's hover reticle is hidden. When the hand
 * goes away, mouse hover behaves exactly as it did. Mouse ink itself is
 * untouched: this hides a reticle, it disarms nothing, and a mouse that draws
 * still draws (the last suite here is that control).
 *
 * THE TWO HALVES, and why it takes two. `InlinePenRouter.handOnGlass()` is the
 * question, read inside `showPenCursor` where the reticle is already decided,
 * and it stops a mouse sample painting a ring while the hand is there.
 * `onHandOnGlass` is the edge, fired when a finger lands with nothing else on
 * the glass, and it takes down a ring that is ALREADY lit - which the gate
 * alone cannot, because a parked mouse sends no further event of any kind. A
 * pen needs no such edge: it announces itself through `onPenHover` and
 * `onPenDown`, both of which repaint the one reticle element AT THE PEN, so
 * the mouse's ring is replaced rather than stranded.
 *
 * WHAT THIS FILE DRIVES. A REAL `InlinePenRouter` on the shared element fake
 * (`test/routerHarness.ts`), wired to the REAL `InkOverlayPlugin` reticle
 * methods with the same callback shape `mount()` uses - so a touch pointerdown
 * here goes through the router's own touch branch, its own palm gate and its
 * own bookkeeping before anything of the surface's runs. The overlay itself is
 * `Object.create`d rather than constructed, the idiom
 * `GestureReticlePersists.test.ts` documents at length: `mount()` wants real
 * canvases and a 2d context, so the gesture fields are seeded by hand and
 * everything the reticle path does not touch is stubbed.
 *
 * `setTipMode("lasso")` throughout, for that same file's reason: it is the
 * cheapest real branch through `penDown` (no ink pipeline, no editor
 * dispatch), and the reticle it paints is a fixed 9px-radius ring centred on
 * the sample - so with the fake's zero-origin rect a transform reads straight
 * back as the client point the ring is standing on. Which pointer is holding
 * the ring is the whole subject here, and that transform is how the tests say
 * it out loud.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { InkOverlayPlugin, releaseTipModes, setPenReticle } from "./InkOverlay";
import { InlinePenCallbacks, InlinePenRouter } from "./InlinePenRouter";
import { SelectionModel } from "../objects/SelectionModel";
import { Camera } from "../camera/Camera";
import { StrokeFrame } from "./StrokeFrame";
import { setTipMode } from "./TipMode";
import { setMouseInk } from "./MouseInk";
import { resetPenInkForTest, setPenInk } from "./PenInk";
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
	inst.viewportPan = { x: 0, y: 0 };
	inst.previewInkOffset = 0;
	inst.boundReadout = { floorX: 0, floorY: 0, bx: 0, width: 0, rawX: 0, cx: 0, rawY: 0, cy: 0,
		dragFrame: false, neverZoomed: false, steady: false, next: 0, fromScale: 0, fromScaleValid: false,
		restCeilX: 0, startX: 0, startY: 0, lastX: 0, lastY: 0, bounded: false, settling: false };

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
		dispose: () => router.dispose(),
	};
}

let undoWindow: () => void;

beforeAll(() => {
	undoWindow = installFakeWindow();
});

afterAll(() => {
	undoWindow();
});

describe("the mouse's hover reticle stands down while a hand is on the glass", () => {
	let rig: Rig;

	beforeEach(() => {
		setPenReticle(true);
		releaseTipModes();
		// Mouse ink ARMED is the whole premise: it is the only state in which
		// a mouse hover reaches `onPenHover` at all (`mouseActsAsPen`), and so
		// the only state in which there is a mouse reticle to hide.
		setMouseInk(true);
		setTipMode("lasso");
		rig = makeRig();
	});

	afterEach(() => {
		rig.dispose();
		setMouseInk(false);
		resetPenInkForTest();
		setPenReticle(true);
		releaseTipModes();
	});

	it("a finger landing takes the parked mouse's ring down, and its lift gives it back", () => {
		// The mouse hovers and is then left alone - the reported state.
		rig.fire(ptr("pointermove", "mouse", 1, 500, 500));
		expect(reticleShown(rig.cursorStyle)).toBe(true);
		expect(rig.cursorStyle.transform).toBe(ringAt(500, 500));
		expect(rig.scrollerClasses.has(PEN_HOVER_CLASS)).toBe(true);

		// A finger lands somewhere else entirely. The mouse sends nothing: it
		// has not moved and is not going to.
		rig.fire(ptr("pointerdown", "touch", 2, 120, 300));

		expect(
			reticleShown(rig.cursorStyle),
			"the mouse's ring was left floating on the page under the writing hand"
		).toBe(false);
		expect(
			rig.scrollerClasses.has(PEN_HOVER_CLASS),
			"`cursor: none` was left over the scroller with no ring under it"
		).toBe(false);

		// The finger leaves. Nothing about the mouse has changed, so its next
		// hover is its ordinary one.
		rig.fire(ptr("pointerup", "touch", 2, 120, 300));
		rig.fire(ptr("pointermove", "mouse", 1, 500, 500));

		expect(reticleShown(rig.cursorStyle), "the mouse never got its reticle back").toBe(true);
		expect(rig.cursorStyle.transform).toBe(ringAt(500, 500));
		expect(rig.scrollerClasses.has(PEN_HOVER_CLASS)).toBe(true);
	});

	it("and a mouse nudged while that finger is still down paints nothing at all", () => {
		// The edge alone is not the rule: a mouse jogged by the wrist holding
		// the tablet, or by the other hand, must not put the smudge back.
		rig.fire(ptr("pointermove", "mouse", 1, 500, 500));
		rig.fire(ptr("pointerdown", "touch", 2, 120, 300));
		expect(reticleShown(rig.cursorStyle)).toBe(false);

		rig.fire(ptr("pointermove", "mouse", 1, 520, 480));

		expect(reticleShown(rig.cursorStyle), "a mouse nudge repainted the ring under the hand").toBe(
			false
		);
		expect(
			rig.scrollerClasses.has(PEN_HOVER_CLASS),
			"a refused sample put `cursor: none` back and left the reader no pointer at all"
		).toBe(false);
		expect(
			rig.cursorStyle.transform,
			"the ring moved to the mouse without being painted"
		).toBe(ringAt(500, 500));
	});

	it("a hovering pen owns the ring, and a mouse moving under it cannot take it back", () => {
		rig.fire(ptr("pointermove", "mouse", 1, 500, 500));
		expect(rig.cursorStyle.transform).toBe(ringAt(500, 500));

		// A pen approaches - hover only, never touching the glass.
		rig.fire(ptr("pointermove", "pen", 3, 120, 300));
		expect(reticleShown(rig.cursorStyle)).toBe(true);
		expect(rig.cursorStyle.transform, "the pen's hover did not take the ring").toBe(
			ringAt(120, 300)
		);

		// The mouse moves while the pen is still in hover range.
		rig.fire(ptr("pointermove", "mouse", 1, 500, 500));

		expect(
			rig.cursorStyle.transform,
			"the mouse stole the ring back from a pen that is on its way to the page"
		).toBe(ringAt(120, 300));
		expect(reticleShown(rig.cursorStyle)).toBe(true);
	});

	it("a pen on the glass keeps it: nothing can paint a mouse ring mid-contact, not even a direct call", () => {
		rig.fire(ptr("pointermove", "mouse", 1, 500, 500));
		expect(rig.cursorStyle.transform).toBe(ringAt(500, 500));

		// A real claimed pen contact, through the router's own pointerdown and
		// the surface's own `penDown`.
		rig.fire(ptr("pointerdown", "pen", 3, 120, 300));
		expect(rig.router.isStroking, "the router did not claim the pen").toBe(true);
		expect(rig.cursorStyle.transform, "the contact did not take the ring").toBe(
			ringAt(120, 300)
		);

		// The router drops a mouse move outright while a contact is claimed,
		// so this reaches the GATE directly, which is what keeps a future
		// caller from reintroducing the smudge - the same reasoning
		// `GestureReticlePersists.test.ts` states for its own mid-pan call.
		rig.proto.showPenCursor.call(rig.inst, { x: 500, y: 500, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 }, "mouse");

		expect(
			rig.cursorStyle.transform,
			"a mouse painted its ring in the middle of a pen stroke"
		).toBe(ringAt(120, 300));

		// And the lift hands the mouse back its ordinary hover.
		rig.fire(ptr("pointerup", "pen", 3, 120, 300));
		expect(rig.router.isStroking).toBe(false);
		rig.fire(ptr("pointermove", "mouse", 1, 500, 500));
		expect(rig.cursorStyle.transform, "the mouse never got its reticle back").toBe(
			ringAt(500, 500)
		);
	});

	it("NEGATIVE CONTROL: with no touch and no pen anywhere, mouse hover is what it always was", () => {
		// Nothing has happened on this router at all, which is the state every
		// desktop mouse-ink user is in for the whole session.
		expect(rig.router.handOnGlass(), "an untouched router claimed a hand was on it").toBe(
			false
		);

		rig.fire(ptr("pointermove", "mouse", 1, 500, 500));

		expect(reticleShown(rig.cursorStyle)).toBe(true);
		expect(rig.cursorStyle.transform).toBe(ringAt(500, 500));
		expect(rig.cursorStyle.width).toBe("18px");
		expect(rig.cursorStyle.height).toBe("18px");
		expect(rig.cursorStyle.backgroundColor).toBe("transparent");
		expect(rig.cursorStyle.opacity).toBe("1");
		expect(rig.scrollerClasses.has(PEN_HOVER_CLASS)).toBe(true);
		// The mouse's exemption from the hover watchdog is untouched too: it
		// is either over the pane or it has sent pointerleave, and firing a
		// timer under it took the pointer away from anyone who paused.
		expect(rig.inst.hoverWatchdog, "a mouse was given the pen's hover watchdog").toBe(null);
	});

	it("NEGATIVE CONTROL: an armed mouse's own gesture is untouched - it claims, and it keeps its ring", () => {
		// "Mouse ink itself is unchanged... a mouse that draws still draws."
		// The left button down is a pen tip while mouse ink is armed, and the
		// hand-on-glass rule must not read that claim as a hand.
		rig.fire(ptr("pointermove", "mouse", 1, 500, 500));
		rig.fire(ptr("pointerdown", "mouse", 1, 500, 500, 1));

		expect(rig.router.isStroking, "mouse ink stopped claiming the left button").toBe(true);
		expect(
			rig.router.handOnGlass(),
			"a mouse gesture was mistaken for a hand and would hide its own ring"
		).toBe(false);
		expect(reticleShown(rig.cursorStyle), "the mouse lost the ring of its own gesture").toBe(true);
		expect(rig.cursorStyle.transform).toBe(ringAt(500, 500));
		expect(rig.inst.mouseStroke, "the gesture was not recorded as a mouse's").toBe(true);
	});

	it("Keyboard mode cannot repaint a claimed mouse cursor after the hide fanout", () => {
		rig.fire(ptr("pointermove", "mouse", 1, 500, 500));
		expect(reticleShown(rig.cursorStyle)).toBe(true);
		setPenInk(false);
		rig.proto.hidePenCursor.call(rig.inst);
		rig.inst.mouseStroke = true;
		rig.proto.showPenCursor.call(
			rig.inst,
			{ x: 520, y: 480, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 },
			"mouse"
		);
		expect(reticleShown(rig.cursorStyle)).toBe(false);
		expect(rig.scrollerClasses.has(PEN_HOVER_CLASS)).toBe(false);
		rig.proto.showPenCursor.call(
			rig.inst,
			{ x: 530, y: 470, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 }
		);
		expect(reticleShown(rig.cursorStyle)).toBe(false);
		expect(rig.scrollerClasses.has(PEN_HOVER_CLASS)).toBe(false);
	});
});
