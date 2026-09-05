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
 * `showLassoCursor`/`showPanCursor`/`showSpaceCursor` wrappers directly -
 * and check the same evidence the pdf's own suite
 * (`PdfInkController.test.ts`, "stays alive through pan, lasso and space")
 * rests on: the watchdog is re-armed (a fresh `setTimeout`) at pen-down and
 * again on the next raw batch, with no fresh hover sample in between, and
 * the reticle is put away at pen-up rather than left for the watchdog.
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
import { PEN_HOVER_CLASS } from "./PenCursor";
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
	penUp(this: unknown): void;
}

interface Rig {
	inst: Record<string, unknown>;
	cursorStyle: Record<string, unknown>;
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
	inst.spaceClient = null;
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
		dom: {
			ownerDocument: {
				defaultView: { setTimeout: setTimeoutSpy, clearTimeout: clearTimeoutSpy },
			},
		},
		hasFocus: true,
		focus: noop,
		scrollDOM: {
			classList: { add: noop, remove: noop },
			scrollLeft: 0,
			scrollTop: 0,
		},
	};

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
	return { inst, cursorStyle, setTimeoutSpy, clearTimeoutSpy, proto };
}

describe("the note surface's reticle stays alive through pan, lasso and space", () => {
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

	it("pan: pen-down and the next raw batch each re-arm the watchdog, and pen-up hides it", () => {
		const rig = makeRig();
		rig.proto.showPenCursor.call(rig.inst, sample(10, 10));
		rig.setTimeoutSpy.mockClear();
		setTipMode("pan");

		rig.proto.penDown.call(rig.inst, sample(200, 200), evAt(200, 200));
		expect(rig.setTimeoutSpy, "pen-down did not refresh the reticle").toHaveBeenCalledTimes(1);
		expect(rig.cursorStyle.display).toBe("block");

		rig.proto.penRaw.call(rig.inst, [sample(210, 190)], evAt(210, 190));
		expect(rig.setTimeoutSpy, "the raw batch did not refresh the reticle").toHaveBeenCalledTimes(2);
		expect(rig.cursorStyle.display).toBe("block");

		rig.proto.penUp.call(rig.inst);
		expect(rig.cursorStyle.display, "pen-up left the reticle up instead of hiding it").toBe(
			"none"
		);
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
