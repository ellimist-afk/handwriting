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

import { InkOverlayPlugin, releaseTipModes, setPenReticle } from "./InkOverlay";
import { SelectionModel } from "../objects/SelectionModel";
import { Camera } from "../camera/Camera";
import { StrokeFrame } from "./StrokeFrame";
import { setTipMode } from "./TipMode";
import type { PenSample } from "../input/PointerRouter";

function sample(x: number, y: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
}

/** A minimal contact/move event: buttons/button 0 so `penContactIntent` reads the mode alone. */
function evAt(x: number, y: number): PointerEvent {
	return {
		clientX: x,
		clientY: y,
		buttons: 0,
		button: 0,
		pointerType: undefined,
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
