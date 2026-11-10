/**
 * The pen-down routes to the lasso's resize and rotate handles: the input kind reaches the handle test (a finger's target is
 * larger), and a bare tip on a handle outside the box's grab pad (the rotate knob, above the box) grabs the selection
 * instead of inking. A selection with a text box shows no handles, so a tip on the knob's place dissolves it and inks.
 * The same bare overlay as InlineEraserSelection.test.ts: the real penDown, the real selection model, no DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InkOverlayPlugin, setInlineTool } from "./InkOverlay";
import { SelectionModel } from "../objects/SelectionModel";
import { resetTipModeForTest, setTipMode } from "./TipMode";
import { DEFAULT_PEN } from "../ink/PenStyle";
import { handlePoints } from "./LassoTransform";
import type { TextBoxData } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

/** The selection's world bounds, at camera zoom 1. */
const BOUNDS = { x: 0, y: 0, width: 100, height: 100 };
const INSIDE = { x: 50, y: 50 };
/** The rotate knob's centre: 30 world px above the box's top, well outside the 8 px grab pad. */
const KNOB = handlePoints(BOUNDS, 1).rotate;
const STROKE = { id: "s1", tool: "pen", color: "#000", width: 1, points: [{ x: 50, y: 50, pressure: 0.5, t: 0 }], bbox: { x: 49, y: 49, width: 2, height: 2 }, createdAt: 0 } as InkStroke;

interface Rig {
	penDown(at: { x: number; y: number }, pointerType?: string): void;
	mode(): string;
	grabbed: ReturnType<typeof vi.fn>;
	erased: ReturnType<typeof vi.fn>;
	wetDown: ReturnType<typeof vi.fn>;
	headDown: ReturnType<typeof vi.fn>;
	pressureState(): { gain: number; observesPen: boolean };
	selection: SelectionModel;
}

function makeRig(): Rig {
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const grabbed = vi.fn();
	const erased = vi.fn();

	view.mode = "ink";
	view.scale = 1;
	view.erased = [];
	view.eraseFrom = [];
	view.eraseWhole = true;
	view.penCursorEl = null;
	view.router = null;
	// stripPenDown takes a nullable strip and no-ops on null.
	view.mobileTools = null;
	view.penStyle = { ...DEFAULT_PEN };
	view.highlighterStyle = { ...DEFAULT_PEN };
	const wetDown = vi.fn();
	const headDown = vi.fn();
	const wet = {
		shape: true,
		beginStroke: wetDown,
		contactHalfWidth: () => 1,
	};
	view.wet = wet;
	view.highlightWet = wet;
	view.predReal = [];
	view.predLastTail = [];
	view.tail = {
		clear: () => undefined, drawHead: headDown,
		configureInlineBacking: () => undefined,
		placeInline: () => undefined,
		restoreFullSurface: () => undefined,
		prepareLive: () => undefined,
	};
	// focusClaimedPenEditor's whole contract: already focused, nothing to do.
	view.view = { hasFocus: true, focus: () => undefined };
	view.frame = { locked: false, begin: () => undefined, end: () => undefined, cancel: () => undefined };
	// The lasso's handle test reads the camera's zoom: a selection's handles are sized in screen px.
	view.camera = { screenToWorld: (x: number, y: number) => ({ x, y }), snapshot: { x: 0, y: 0, zoom: 1 } };

	// A live selection: one stroke id is enough, since the grab test asks
	// `isEmpty` and then consults `selectionBounds` rather than the members.
	// Object.create skips field initialisers, so the model is built here
	// rather than inherited - the real class, not a stand-in for isEmpty.
	const selection = new SelectionModel();
	selection.selectExactly(["s1"]);
	view.selection = selection;

	// Own properties, so the prototype's versions never run: each of these
	// reaches the editor, the store or the canvas, and none is the subject.
	view.syncCamera = () => undefined;
	view.captureProbeGeometry = () => undefined;
	view.recordPenDownState = () => undefined;
	view.redrawSelectionUI = () => undefined;
	view.selectionBounds = () => BOUNDS;
	view.lassoDown = grabbed;
	view.lassoActive = false;
	view.dragTotal = null;
	view.filePath = () => "note.md";
	view.startFrameTicker = () => undefined;
	view.ensurePenTools = () => undefined;
	view.probeSample = () => undefined;
	view.showEraserCursor = () => undefined;
	view.eraseAt = erased;

	const proto = InkOverlayPlugin.prototype as unknown as {
		penDown(this: unknown, sample: unknown, ev: unknown): void;
	};
	return {
		penDown(at, pointerType = "pen") {
			const sample = { ...at, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
			// A plain tip: no eraser end (bit 32), no side button (bit 2).
			const ev = { buttons: 1, button: 0, clientX: at.x, clientY: at.y, pointerType };
			proto.penDown.call(view, sample, ev);
		},
		mode: () => view.mode as string,
		selection,
		grabbed,
		erased,
		wetDown,
		headDown,
		pressureState: () => ({
			gain: view.strokeGain as number,
			observesPen: view.strokePenGesture as boolean,
		}),
	};
}

describe("the pen-down and the lasso's handles", () => {
	beforeEach(() => resetTipModeForTest());
	afterEach(() => resetTipModeForTest());

	it("in lasso mode hands the lasso the input kind: a finger, a mouse or a pen", () => {
		// Defect: the lasso never learns the input, so a finger gets the pen's 12 px handle target.
		for (const [pointerType, input] of [["touch", "touch"], ["mouse", "mouse"], ["pen", "pen"]] as const) {
			setTipMode("lasso");
			const rig = makeRig();
			rig.penDown(INSIDE, pointerType);
			expect(rig.grabbed, pointerType).toHaveBeenCalledTimes(1);
			expect(rig.grabbed.mock.calls[0]![1], pointerType).toBe(input);
		}
	});

	it("a bare pen or mouse tip on the rotate knob grabs the selection, with its input", () => {
		// Defect: the knob sits outside the grab pad, so the tip dissolves the selection and inks over the knob.
		for (const pointerType of ["pen", "mouse"] as const) {
			setTipMode("nib");
			setInlineTool("pen");
			const rig = makeRig();
			rig.penDown(KNOB, pointerType);
			expect(rig.mode(), pointerType).toBe("lasso");
			expect(rig.grabbed, pointerType).toHaveBeenCalledTimes(1);
			expect(rig.grabbed.mock.calls[0]![1], pointerType).toBe(pointerType);
			expect(rig.wetDown, pointerType).not.toHaveBeenCalled();
		}
	});

	it("a bare tip on the knob's place with a text box selected dissolves the selection and inks (control)", () => {
		// Defect: a mixed selection gets handles and the tip grabs it.
		setTipMode("nib");
		setInlineTool("pen");
		const rig = makeRig();
		rig.selection.selectByLasso([{ x: -10, y: -10 }, { x: 110, y: -10 }, { x: 110, y: 110 }, { x: -10, y: 110 }], [STROKE], [{ id: "b1" } as TextBoxData],
			() => ({ x: 20, y: 20, width: 10, height: 10 }));
		rig.penDown(KNOB, "pen");
		expect(rig.grabbed).not.toHaveBeenCalled();
		expect(rig.mode()).toBe("ink");
	});
});
