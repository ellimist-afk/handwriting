import { describe, it, expect, beforeEach } from "vitest";
import { nibIsLit, type MobileToolsHost } from "./MobileTools";
import { markPenSeen, resetPenToolsForTest } from "./PenToolsMode";

/**
 * MobileTools itself has no test harness (DOM-heavy, cannot be constructed
 * under the suite - see the file's own comments). nibIsLit is the pure seam
 * that fell out of splitting the light's predicate from the click chain's
 * (design doc 1.4.6 §6a, "the pen button unhilights when the mouse hands
 * the tool back"): pin it directly with a fake host.
 */
const fakeHost = (over: Partial<MobileToolsHost> = {}): MobileToolsHost => ({
	exec: () => {},
	activeTool: () => "pen",
	eraserOn: () => false,
	eraserWholeStroke: () => false,
	setEraserWholeStroke: () => {},
	lassoOn: () => false,
	spaceOn: () => false,
	panOn: () => false,
	activeColor: () => "#000000",
	eraserRadiusPx: () => 10,
	setEraserRadiusPx: () => {},
	inkSizeMult: () => 1,
	setInkSizeMult: () => {},
	canUndo: () => false,
	canRedo: () => false,
	canPasteInk: () => false,
	mouseInkOn: () => false,
	setMouseInk: () => {},
	armMouseInkQuietly: () => {},
	recordingOn: () => false,
	hasInkSelection: () => false,
	palette: () => [],
	pickColor: () => {},
	...over,
});

describe("nibIsLit", () => {
	beforeEach(() => resetPenToolsForTest());

	it("is lit for a pen that has been seen this session, mouse ink off", () => {
		markPenSeen();
		expect(nibIsLit(fakeHost({ activeTool: () => "pen", mouseInkOn: () => false }), "pen")).toBe(true);
	});

	it("is dark for a mouse user with mouse ink off and no pen seen", () => {
		expect(nibIsLit(fakeHost({ activeTool: () => "pen", mouseInkOn: () => false }), "pen")).toBe(
			false
		);
	});

	it("is lit for a mouse user with mouse ink armed, no pen seen", () => {
		expect(nibIsLit(fakeHost({ activeTool: () => "pen", mouseInkOn: () => true }), "pen")).toBe(true);
	});

	it("is dark when the tip is claimed by another mode, even if mouse ink is on", () => {
		expect(
			nibIsLit(
				fakeHost({ activeTool: () => "pen", mouseInkOn: () => true, eraserOn: () => true }),
				"pen"
			)
		).toBe(false);
	});

	it("is dark when the nominal tool is not this nib", () => {
		markPenSeen();
		expect(nibIsLit(fakeHost({ activeTool: () => "highlighter" }), "pen")).toBe(false);
	});

	it("checks the highlighter independently of the pen", () => {
		expect(
			nibIsLit(fakeHost({ activeTool: () => "highlighter", mouseInkOn: () => true }), "highlighter")
		).toBe(true);
	});
});
