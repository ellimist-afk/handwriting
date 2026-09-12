/**
 * The note surface's own half of the defect 2127ed6 fixed on the pdf and
 * left NOTED, NOT FIXED: "onPenHover stops firing once a contact is
 * claimed, so the NOTE surface's reticle likely goes stale through its own
 * lasso, pan and space gestures for the same reason."
 *
 * Same mechanism as the pdf, and as the note's own eraser before it (d862eec):
 * `showPenCursor` is wired only to `onPenHover` and arms a 1000ms watchdog
 * (`armHoverWatchdog`/`HOVER_GHOST_MS`) that hides the reticle once hover
 * samples stop. A gesture produces no hover samples - the router sends a
 * claimed contact to `onPenRaw`/`onPenMove` instead - so without a fix the
 * ring goes stale mid-lasso, mid-pan and mid-space and only reappears on
 * release.
 *
 * These drive a REAL gesture through `penDown`/`penRaw`/`penUp` - not the
 * `showLassoCursor`/`showSpaceCursor` wrappers directly - and check the same
 * evidence the pdf's own suite (`PdfInkController.test.ts`, "stays alive
 * through pan, lasso and space") rests on: the watchdog is re-armed (a fresh
 * `setTimeout`) at pen-down and again on the next raw batch, with no fresh
 * hover sample in between, and the reticle is put away at pen-up rather than
 * left for the watchdog.
 *
 * PAN IS THE EXCEPTION, AND IT IS A REVERSAL. This file used to assert that
 * the pan ring persisted through its drag exactly as the lasso's and the
 * space divider's do, and the assertion was green for a defect: Alan,
 * 2026-09-05, on hardware - "pan reticle allows you to like fling it away
 * from the point of pan and it flickers". Persistence was never the problem;
 * COORDINATES were. `InlinePenRouter` maps client points through a rect it
 * freezes at pen-down, and a pan is the one gesture that scrolls the overlay
 * out from under that rect, so every sample of the drag was mapped a little
 * further wrong than the last. The ring persisted, and walked away from the
 * nib while it did.
 *
 * So the pan test below pins the OPPOSITE rule (architect, 1.4.12; Alan's to
 * overturn on screen): the pan drag hides the reticle and wears the grabbing
 * hand instead, the raw batch does not bring it back, and pen-up restores it
 * under the pointer's CURRENT position. The lasso and space tests are
 * untouched - their persistence is real and is still what this file is named
 * for. The rule itself is a pure function, `penReticleShown` (PenCursor.ts),
 * unit-tested both ways in `PenCursor.test.ts` alongside a source assertion
 * that the pan drag's move handler positions nothing.
 *
 * `penCursorEl` is primed by one hover call first, matching the limit each
 * wrapper's own comment states: none of them BUILD the reticle, they only
 * refresh one hover already built.
 *
 * `InkOverlayPlugin.mount()` is far too heavy for this fixture - it wants
 * real canvases and a 2d context - so this uses the same `Object.create`
 * idiom `InlineEraseFresh.test.ts` and `PanClearsSelection.test.ts` use to
 * drive the plugin's own private gesture methods directly. Everything the
 * three gestures under test touch is real code; everything they do not
 * (the strip, the camera sync, the editor dispatch a space gesture would
 * make) is stubbed the same way those two files stub what is not their
 * subject.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";

import {
	InkOverlayPlugin,
	releaseMouseInkQuietlyEverywhere,
	releaseTipModes,
	setPenReticle,
} from "./InkOverlay";
import { SelectionModel } from "../objects/SelectionModel";
import { Camera } from "../camera/Camera";
import { StrokeFrame } from "./StrokeFrame";
import { setTipMode } from "./TipMode";
import { armMouseInkQuietly } from "./MouseInk";
import { PAN_DRAG_CLASS, PEN_HOVER_CLASS } from "./PenCursor";
import type { PenSample } from "../input/PointerRouter";

function sample(x: number, y: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
}

/** A minimal contact/move event: buttons/button 0 so `penContactIntent` reads the mode alone. */
function evAt(x: number, y: number, pointerType?: string): PointerEvent {
	return {
		clientX: x,
		clientY: y,
		buttons: 0,
		button: 0,
		pointerType,
	} as unknown as PointerEvent;
}

interface Proto {
	showPenCursor(this: unknown, s: PenSample, pointerType?: string): void;
	penDown(this: unknown, s: PenSample, ev: PointerEvent): void;
	penRaw(this: unknown, s: PenSample[], ev: PointerEvent): void;
	/** `ev` is the lift; absent on the blur path. The pan branch reads it. */
	penUp(this: unknown, ev?: PointerEvent): void;
}

interface Rig {
	inst: Record<string, unknown>;
	cursorStyle: Record<string, unknown>;
	/** The scroller's classes, really tracked: the pan drag swaps two of them. */
	scrollerClasses: Set<string>;
	/** The router's rect re-measure, which a pan leaves stale until it runs. */
	refreshRectSpy: ReturnType<typeof vi.fn>;
	setTimeoutSpy: ReturnType<typeof vi.fn>;
	clearTimeoutSpy: ReturnType<typeof vi.fn>;
	proto: Proto;
}

/**
 * A real `InkOverlayPlugin`, built with `Object.create` rather than `new`
 * so `mount()` never runs. Every field the lasso/pan/space paths through
 * `penDown`/`penRaw`/`penUp` touch is seeded; everything else on the class
 * is simply absent, the same shape `InlineEraseFresh.test.ts`'s `makeRig`
 * takes for the erase path.
 */
function makeRig(): Rig {
	const noop = (): void => undefined;
	const cursorStyle: Record<string, unknown> = { display: "none" };
	const scrollerClasses = new Set<string>();
	const refreshRectSpy = vi.fn();
	const setTimeoutSpy = vi.fn(() => 1);
	const clearTimeoutSpy = vi.fn();

	const inst = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;

	// Gesture state, at its real class-field defaults (Object.create skips
	// field initialisers, so these have to be supplied by hand).
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
	inst.spacePlan = null;
	// Placement is covered by the mounted precision suite. This rig tests
	// watchdog lifetime and has no rendered CodeMirror text geometry.
	inst.planSpace = () => ({y:100,from:0,lineHeight:20});
	inst.panLast = null;
	inst.spaceFromY = 0;
	inst.spaceTotalDy = 0;
	inst.mobileTools = null;
	inst.hoverWatchdog = null;
	inst.mouseStroke = false;
	inst.frame = new StrokeFrame();

	// The reticle element. Real classList methods are not needed: the
	// mode-specific LOOK is out of scope here (unchanged, and pinned
	// elsewhere) - only persistence, which lives entirely in `display` and
	// the watchdog's `setTimeout` calls.
	inst.penCursorEl = {
		setAttribute: noop,
		classList: { add: noop, remove: noop },
		setCssStyles: (styles: Record<string, unknown>) => Object.assign(cursorStyle, styles),
	};

	// The CodeMirror EditorView. `winRef` (a getter on the prototype) reads
	// `view.dom.ownerDocument.defaultView`, which is where the watchdog's
	// timer functions have to live for the spies below to see them.
	inst.view = {
		state: EditorState.create({doc:"text"}),
		dom: {
			ownerDocument: {
				defaultView: { setTimeout: setTimeoutSpy, clearTimeout: clearTimeoutSpy },
			},
		},
		hasFocus: true,
		focus: noop,
		scrollDOM: {
			// A REAL class set, unlike the reticle element's below. The look
			// the ring wears is out of scope here; which cursor the SCROLLER
			// wears is not - the pan drag hides the reticle, and hiding it
			// without swapping `cursor: none` for the grabbing hand would
			// leave the surface with no pointer at all, which is the defect
			// the third suite in this file exists to refuse.
			classList: {
				add: (c: string) => void scrollerClasses.add(c),
				remove: (c: string) => void scrollerClasses.delete(c),
			},
			scrollLeft: 0,
			scrollTop: 0,
		},
	};

	// The rect element the router maps client points through, and the one
	// `restoreReticleAfterPan` re-reads at release. Zero origin, so a lift at
	// client (x, y) is a sample at (x, y) and the restore's landing point can
	// be read straight off the transform.
	inst.container = { getBoundingClientRect: () => ({ left: 0, top: 0 }) };

	// Only the rect seam is real. The router caches the overlay's client rect
	// and freezes it for a claimed contact, and a pan is the one gesture that
	// scrolls the overlay out from under it - so the re-measure at pen-up is
	// half of "returns with no jump", and the half an abandoned pan needs on
	// its own.
	inst.router = { refreshRect: refreshRectSpy, isStroking: false };

	// Stubbed because it reaches the strip, the editor or the camera's
	// layout inputs and is not the subject here - the same idiom
	// InlineEraseFresh.test.ts and PanClearsSelection.test.ts use for
	// whatever a gesture under test does not exercise. No file: an empty
	// note means `strokesHere()` is `[]` and `spaceUp`/`lassoUp` take their
	// cheapest real branch rather than reaching the editor dispatch.
	inst.ensurePenTools = noop;
	inst.syncCamera = noop;
	inst.recordPenDownState = noop;
	inst.redrawSelectionUI = noop;
	inst.updateExtent = noop;
	inst.filePath = (): string | null => null;

	const proto = InkOverlayPlugin.prototype as unknown as Proto;
	return {
		inst,
		cursorStyle,
		scrollerClasses,
		refreshRectSpy,
		setTimeoutSpy,
		clearTimeoutSpy,
		proto,
	};
}

describe("the note surface's reticle stays alive through lasso and space, and stands down through a pan", () => {
	beforeEach(() => {
		setPenReticle(true);
		// NOT a reset that nulls TipMode's listener singleton (the trap
		// PanClearsSelection.test.ts documents at length) - this puts the
		// mode back to "nib" through the real seam and leaves the listener
		// alone.
		releaseTipModes();
	});

	afterEach(() => {
		setPenReticle(true);
		releaseTipModes();
	});

	it("lasso: a fresh loop's pen-down and its raw batch each re-arm the watchdog, and pen-up hides it", () => {
		const rig = makeRig();
		// The pen approached and hovered first, exactly as it would on
		// real hardware before ever touching down.
		rig.proto.showPenCursor.call(rig.inst, sample(10, 10));
		rig.setTimeoutSpy.mockClear();
		setTipMode("lasso");

		rig.proto.penDown.call(rig.inst, sample(200, 200), evAt(200, 200));
		expect(rig.setTimeoutSpy, "pen-down did not refresh the reticle").toHaveBeenCalledTimes(1);
		expect(rig.cursorStyle.display).toBe("block");

		rig.proto.penRaw.call(rig.inst, [sample(210, 205), sample(215, 208)], evAt(215, 208));
		expect(rig.setTimeoutSpy, "the raw batch did not refresh the reticle").toHaveBeenCalledTimes(2);
		expect(rig.cursorStyle.display).toBe("block");

		rig.proto.penUp.call(rig.inst);
		expect(rig.cursorStyle.display, "pen-up left the reticle up instead of hiding it").toBe(
			"none"
		);
	});

	it("pan: pen-down puts the reticle away for the grabbing hand, the raw batch leaves it away, and pen-up brings it back under the pointer", () => {
		const rig = makeRig();
		// Hover first, as the hardware would: ring up, `cursor: none` on.
		rig.proto.showPenCursor.call(rig.inst, sample(10, 10));
		expect(rig.cursorStyle.display).toBe("block");
		expect(rig.scrollerClasses.has(PEN_HOVER_CLASS)).toBe(true);
		rig.setTimeoutSpy.mockClear();
		setTipMode("pan");

		rig.proto.penDown.call(rig.inst, sample(200, 200), evAt(200, 200));
		expect(rig.cursorStyle.display, "the pan kept a ring it cannot position").toBe("none");
		expect(
			rig.scrollerClasses.has(PAN_DRAG_CLASS),
			"the drag hid the reticle and put no cursor in its place"
		).toBe(true);
		expect(
			rig.scrollerClasses.has(PEN_HOVER_CLASS),
			"`cursor: none` was left on the scroller under the grabbing hand"
		).toBe(false);
		expect(
			rig.setTimeoutSpy,
			"a watchdog was armed for a reticle that is not on screen"
		).not.toHaveBeenCalled();

		// The drag itself. `panMove` scrolls the scroller here, which on real
		// hardware is exactly what walked the frozen rect out of date.
		rig.proto.penRaw.call(rig.inst, [sample(210, 190)], evAt(210, 190));
		expect(rig.cursorStyle.display, "the raw batch brought the ring back").toBe("none");
		expect(rig.scrollerClasses.has(PAN_DRAG_CLASS)).toBe(true);

		// Release, somewhere else again: the ring returns UNDER THE LIFT.
		rig.proto.penUp.call(rig.inst, evAt(215, 185));
		expect(rig.cursorStyle.display, "the reticle never came back after the pan").toBe("block");
		expect(
			rig.scrollerClasses.has(PAN_DRAG_CLASS),
			"the grabbing hand outlived the drag"
		).toBe(false);
		expect(rig.scrollerClasses.has(PEN_HOVER_CLASS)).toBe(true);
		// The pan reticle is an 11px-radius ring centred on the sample, and
		// the rig's overlay rect has a zero origin, so this is the lift point
		// and not the pen-down point, not the last raw sample, and not either
		// of them shifted by the scroll the drag just applied.
		expect(rig.cursorStyle.transform, "the ring came back somewhere the pen is not").toBe(
			"translate(204px, 174px)"
		);
	});

	it("pan: a pan abandoned with no lift still re-measures the rect it left stale", () => {
		// `finishActiveStroke` (a window blur mid-pan) calls `onPenUp` with no
		// event, so there is no position and no ring to restore. The rect is
		// stale ALL THE SAME - the pan scrolled the overlay under it, and the
		// only other thing that re-measures is a scroll that is not coming -
		// so the next hover after the blur would put the ring the whole pan
		// distance from the pen unless this runs.
		const rig = makeRig();
		setTipMode("pan");
		rig.proto.penDown.call(rig.inst, sample(200, 200), evAt(200, 200));
		rig.proto.penRaw.call(rig.inst, [sample(260, 120)], evAt(260, 120));
		rig.refreshRectSpy.mockClear();

		rig.proto.penUp.call(rig.inst);

		expect(rig.cursorStyle.display, "a ring was invented for a lift that never happened").toBe(
			"none"
		);
		expect(
			rig.refreshRectSpy,
			"the abandoned pan left the router mapping through a rect it had scrolled away from"
		).toHaveBeenCalledTimes(1);
	});

	it("pan: nothing can paint the ring mid-drag, not even a direct showPenCursor", () => {
		// The call sites that used to paint it are gone, so this reaches the
		// gate that keeps them gone - `penReticleShown` read inside
		// `showPenCursor` itself. A new mode, or a new caller, must not be
		// able to put a ring back where no coordinate can be right.
		const rig = makeRig();
		rig.proto.showPenCursor.call(rig.inst, sample(10, 10));
		setTipMode("pan");
		rig.proto.penDown.call(rig.inst, sample(200, 200), evAt(200, 200));
		expect(rig.cursorStyle.display).toBe("none");

		rig.proto.showPenCursor.call(rig.inst, sample(300, 300));

		expect(rig.cursorStyle.display, "a direct call painted a ring mid-pan").toBe("none");
		// And it REFUSED rather than hid: hiding here would take the grabbing
		// hand off and leave the surface with no pointer at all mid-drag.
		expect(
			rig.scrollerClasses.has(PAN_DRAG_CLASS),
			"the gate took the grabbing hand away mid-drag"
		).toBe(true);
		expect(
			rig.scrollerClasses.has(PEN_HOVER_CLASS),
			"the gate put `cursor: none` back over a hidden reticle"
		).toBe(false);
	});

	it("space: pen-down and the next raw batch each re-arm the watchdog, and pen-up hides it", () => {
		const rig = makeRig();
		rig.proto.showPenCursor.call(rig.inst, sample(10, 10));
		rig.setTimeoutSpy.mockClear();
		setTipMode("space");

		rig.proto.penDown.call(rig.inst, sample(200, 100), evAt(200, 100));
		expect(rig.setTimeoutSpy, "pen-down did not refresh the reticle").toHaveBeenCalledTimes(1);
		expect(rig.cursorStyle.display).toBe("block");

		rig.proto.penRaw.call(rig.inst, [sample(200, 140)], evAt(200, 140));
		expect(rig.setTimeoutSpy, "the raw batch did not refresh the reticle").toHaveBeenCalledTimes(2);
		expect(rig.cursorStyle.display).toBe("block");

		rig.proto.penUp.call(rig.inst);
		expect(rig.cursorStyle.display, "pen-up left the reticle up instead of hiding it").toBe(
			"none"
		);
	});
});

/**
 * The mouse exemption, which reached the pdf surface and not this one.
 *
 * `armHoverWatchdog` exists for a pen that leaves HOVER RANGE without sending
 * pointerleave - digitizers differ, and the reticle is otherwise simply left
 * on screen. A mouse cannot do that: it is either over the pane or it has sent
 * pointerleave. So the watchdog protects a mouse against nothing, and firing
 * it under one took the pointer away from anyone who paused for a second -
 * mid-hover, and worse, mid-drag, where `hidePenCursor` also strips
 * PEN_HOVER_CLASS and its `cursor: none` while the button is still down.
 *
 * `PdfInkController.showCursor` was fixed for exactly this (a7eba85, alan,
 * hardware, mouse ink armed) and this surface was left with no exemption at
 * all. Same shape as the three in-gesture wrappers themselves: they pass no
 * `pointerType`, deliberately, because the hardware claims belong to the hover
 * and the pen-down that already happened - so the surface has to answer for
 * them from what it wrote down at contact, which is what `mouseStroke` is.
 *
 * And ONLY for those callers. `mouseStroke` is written at pen-down and not
 * cleared at pen-up (only a file switch or unmount resets it), so an explicit
 * "pen" has to be believed over the field, or the next pen hover after any
 * mouse stroke would inherit the mouse's exemption and lose the pen's only
 * guard against a stranded reticle.
 */
describe("the note surface's reticle is exempt from the watchdog under a mouse", () => {
	beforeEach(() => {
		setPenReticle(true);
		releaseTipModes();
	});

	afterEach(() => {
		setPenReticle(true);
		releaseTipModes();
	});

	it("a hovering mouse gets the ring and no timer", () => {
		const rig = makeRig();

		rig.proto.showPenCursor.call(rig.inst, sample(10, 10), "mouse");

		expect(rig.cursorStyle.display).toBe("block");
		expect(rig.setTimeoutSpy, "a mouse was given the pen's hover watchdog").not.toHaveBeenCalled();
	});

	it("and neither does it get one mid-lasso, where the wrapper passes no pointerType", () => {
		const rig = makeRig();
		rig.proto.showPenCursor.call(rig.inst, sample(10, 10), "mouse");
		rig.setTimeoutSpy.mockClear();
		setTipMode("lasso");

		rig.proto.penDown.call(rig.inst, sample(200, 200), evAt(200, 200, "mouse"));
		rig.proto.penRaw.call(rig.inst, [sample(210, 205), sample(215, 208)], evAt(215, 208, "mouse"));

		expect(rig.cursorStyle.display, "the ring went out under a mouse mid-drag").toBe("block");
		expect(
			rig.setTimeoutSpy,
			"a mouse mid-lasso was armed with a watchdog that will hide its ring"
		).not.toHaveBeenCalled();
	});

	it("a stale watchdog from an earlier pen hover is taken down, not left to fire", () => {
		// The pdf clears its timer on every refresh and re-arms only for a
		// pen; leaving this one armed would let the PEN's watchdog fire in
		// the middle of the mouse gesture that replaced it.
		const rig = makeRig();
		rig.proto.showPenCursor.call(rig.inst, sample(10, 10), "pen");
		expect(rig.setTimeoutSpy).toHaveBeenCalledTimes(1);

		rig.proto.showPenCursor.call(rig.inst, sample(12, 12), "mouse");

		expect(rig.clearTimeoutSpy, "the pen's watchdog was left running under a mouse").toHaveBeenCalled();
		expect(rig.inst.hoverWatchdog).toBe(null);
	});

	it("but an explicit pen is still believed, after a mouse stroke and during its own", () => {
		const rig = makeRig();
		setTipMode("lasso");
		// A whole mouse gesture, so `mouseStroke` is set and never cleared.
		rig.proto.penDown.call(rig.inst, sample(200, 200), evAt(200, 200, "mouse"));
		rig.proto.penUp.call(rig.inst);
		rig.setTimeoutSpy.mockClear();

		rig.proto.showPenCursor.call(rig.inst, sample(10, 10), "pen");
		expect(rig.setTimeoutSpy, "the pen inherited the mouse's exemption").toHaveBeenCalledTimes(1);

		// And a pen gesture writes the field back, so its own wrappers arm too.
		rig.proto.penDown.call(rig.inst, sample(200, 200), evAt(200, 200, "pen"));
		rig.proto.penRaw.call(rig.inst, [sample(210, 205)], evAt(210, 205, "pen"));
		expect(rig.setTimeoutSpy).toHaveBeenCalledTimes(3);
	});
});


/**
 * The third way a reticle is taken down, which the exemption above deleted.
 *
 * An armed mouse's ring is hidden by `pointerleave` and by nothing else: the
 * suite above is the exemption that takes the watchdog away from it, on the
 * correct grounds that a mouse is either over the pane or has sent that
 * event. Turning mouse ink OFF is neither. The hotkey, the command palette
 * and the strip's own put-down (`disarmMouseInkQuietly`) all reach that edge
 * with the pointer sitting still over the note, so no pointerleave is coming
 * and no watchdog is armed - and the ring stayed lit with `PEN_HOVER_CLASS`'s
 * `cursor: none` still on the scroller, leaving the surface with no pointer
 * at all (adversarial review, 2026-09-04).
 *
 * `hidePenCursorsEverywhere` is the fix and this drives it through a REAL OFF
 * edge, `releaseMouseInkQuietlyEverywhere` - the strip's quiet put-down - so
 * the wiring is under test and not just the helper.
 *
 * Constructed rather than `Object.create`d, unlike the rigs above, and for
 * the reason `PenToolsEscapeHatch.test.ts`'s `noteOverlay` gives: the fan-out
 * walks the module's own `instances` set, which only the constructor adds to,
 * so an `Object.create`d overlay would let this pass with the fan-out
 * deleted. `state.field` answers `undefined`, which is `mount`'s own "not a
 * file-backed editor" exit, so the constructor stays cheap.
 */
describe("the note surface's reticle goes away when mouse ink is switched off under it", () => {
	const noop = (): void => undefined;

	interface Live {
		overlay: { hidePenCursor(): void; destroy(): void };
		cursorStyle: Record<string, unknown>;
		scrollerClasses: Set<string>;
	}

	function liveOverlay(): Live {
		const cursorStyle: Record<string, unknown> = { display: "none" };
		const scrollerClasses = new Set<string>();
		const dom = {
			parentElement: { setCssStyles: noop },
			ownerDocument: {
				defaultView: {
					setTimeout: () => 1,
					clearTimeout: noop,
					getComputedStyle: () => ({ position: "relative" }),
					cancelAnimationFrame: noop,
				},
			},
			style: { removeProperty: noop },
			setCssStyles: noop,
		};
		const view = {
			dom,
			hasFocus: true,
			focus: noop,
			scrollDOM: {
				addEventListener: noop,
				removeEventListener: noop,
				classList: {
					add: (c: string) => void scrollerClasses.add(c),
					remove: (c: string) => void scrollerClasses.delete(c),
				},
				setCssStyles: noop,
				style: { removeProperty: noop },
				scrollLeft: 0,
				scrollTop: 0,
			},
			// mount()'s "not a file-backed editor" exit; see the block comment.
			state: { field: () => undefined },
		};
		const overlay = new InkOverlayPlugin(view as never) as unknown as Record<string, unknown>;
		overlay.container = null;
		overlay.mobileTools = null;
		overlay.penCursorEl = {
			setAttribute: noop,
			classList: { add: noop, remove: noop },
			setCssStyles: (styles: Record<string, unknown>) => Object.assign(cursorStyle, styles),
		};
		return { overlay: overlay as unknown as Live["overlay"], cursorStyle, scrollerClasses };
	}

	beforeEach(() => {
		setPenReticle(true);
		releaseTipModes();
	});

	afterEach(() => {
		setPenReticle(true);
		releaseTipModes();
	});

	it("the ring goes out and the hover class comes off, with the pointer never moving", () => {
		const live = liveOverlay();
		try {
			armMouseInkQuietly();
			// The mouse hovers: ring up, and `cursor: none` over the scroller.
			(live.overlay as unknown as Proto).showPenCursor.call(
				live.overlay,
				sample(10, 10),
				"mouse"
			);
			expect(live.cursorStyle.display).toBe("block");
			expect(live.scrollerClasses.has(PEN_HOVER_CLASS)).toBe(true);

			// Mouse ink off - no pointer event of any kind.
			releaseMouseInkQuietlyEverywhere();

			expect(live.cursorStyle.display, "the reticle was stranded on screen").toBe("none");
			expect(
				live.scrollerClasses.has(PEN_HOVER_CLASS),
				"cursor:none was left on the scroller after mouse ink went off"
			).toBe(false);
		} finally {
			live.overlay.destroy();
		}
	});
});
