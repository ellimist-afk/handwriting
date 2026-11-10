/**
 * The pen's whole-pixel smoothing hears its deltas in device px. Above 100 percent the host zoom is a CSS transform (cssScale),
 * and a pen sample has already been divided by it, so one device px is 1 / (devicePixelRatio * cssScale * fontZoom) world px.
 * The pen-down must hand the grid that whole factor, not the font zoom alone, or whole device px read as half px at 200
 * percent and six of them switch the filter off.
 * The same bare overlay as InkOverlayPenPathTransform.test.ts: the real penDown and the real StrokeBuilder, no DOM.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InkOverlayPlugin, setInlineTool } from "./InkOverlay";
import { SelectionModel } from "../objects/SelectionModel";
import { resetTipModeForTest, setTipMode } from "./TipMode";
import { DEFAULT_PEN } from "../ink/PenStyle";
import { COARSE_GRID_RUN, type CoarseGrid, type StrokeBuilder } from "../ink/StrokeBuilder";

/**
 * A bare overlay at css scale `cssScale` and font zoom 1 on a screen at devicePixelRatio 1. The camera maps a sample to world
 * px one to one, as the real one does at font zoom 1 once the router has divided by cssScale.
 */
function penDownAt(cssScale: number): { builder: StrokeBuilder; grid: CoarseGrid } {
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	view.mode = "ink";
	view.scale = cssScale;
	view.cssScale = cssScale;
	view.fontZoom = 1;
	view.erased = [];
	view.eraseFrom = [];
	view.eraseWhole = true;
	view.penCursorEl = null;
	view.router = null;
	view.mobileTools = null;
	view.penStyle = { ...DEFAULT_PEN };
	view.highlighterStyle = { ...DEFAULT_PEN };
	const wet = { shape: true, beginStroke: () => undefined, contactHalfWidth: () => 1 };
	view.wet = wet;
	view.highlightWet = wet;
	view.predReal = [];
	view.predLastTail = [];
	view.tail = {
		clear: () => undefined, drawHead: () => undefined,
		configureInlineBacking: () => undefined,
		placeInline: () => undefined,
		restoreFullSurface: () => undefined,
		prepareLive: () => undefined,
	};
	view.view = { hasFocus: true, focus: () => undefined, dom: { ownerDocument: { defaultView: { devicePixelRatio: 1 } } } };
	view.frame = { locked: false, begin: () => undefined, end: () => undefined, cancel: () => undefined };
	view.camera = { zoom: 1, screenToWorld: (x: number, y: number) => ({ x, y }), snapshot: { x: 0, y: 0, zoom: 1 } };
	view.selection = new SelectionModel();
	view.syncCamera = () => undefined;
	view.captureProbeGeometry = () => undefined;
	view.recordPenDownState = () => undefined;
	view.redrawSelectionUI = () => undefined;
	view.selectionBounds = () => null;
	view.lassoDown = () => undefined;
	view.lassoActive = false;
	view.dragTotal = null;
	view.filePath = () => "note.md";
	view.startFrameTicker = () => undefined;
	view.ensurePenTools = () => undefined;
	view.probeSample = () => undefined;
	view.showEraserCursor = () => undefined;
	view.eraseAt = () => undefined;

	const proto = InkOverlayPlugin.prototype as unknown as { penDown(this: unknown, sample: unknown, ev: unknown): void };
	const at = { x: 50, y: 50 };
	proto.penDown.call(view, { ...at, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 },
		{ buttons: 1, button: 0, clientX: at.x, clientY: at.y, pointerType: "pen" });
	const builder = view.builder as StrokeBuilder;
	expect(builder, "premise: the pen-down started a stroke").toBeTruthy();
	const grid = (builder as unknown as { grid: CoarseGrid | undefined }).grid;
	expect(grid, "premise: a screen at devicePixelRatio 1 runs the grid").toBeTruthy();
	// The verdict is kept across strokes; each cell starts from an engaged grid.
	grid!.engaged = true;
	grid!.run = 0;
	return { builder, grid: grid! };
}

/** Samples one device px apart along x, after the pen-down's own, in world px: 1 / cssScale at devicePixelRatio 1. */
function whole(builder: StrokeBuilder, cssScale: number, n: number): void {
	for (let i = 1; i <= n; i++) builder.add(50 + i / cssScale, 50, 0.5, i * 8);
}

describe("the pen's whole-pixel grid at the host zoom", () => {
	beforeEach(() => { resetTipModeForTest(); setTipMode("nib"); setInlineTool("pen"); });
	afterEach(() => resetTipModeForTest());

	it("at 200 percent, whole device px samples keep the grid engaged", () => {
		// Defect: the grid is told dpr * font zoom = 1 device px per world px, so a 0.5 world px step reads as half a device px.
		const { builder, grid } = penDownAt(2);
		whole(builder, 2, COARSE_GRID_RUN * 2);
		expect(grid.engaged, "whole device px read off-grid at 200 percent").toBe(true);
		expect(grid.devicePxPerWorld, "the grid's device px per world px").toBe(2);
	});

	it("control: at 100 percent, the same whole device px samples keep it engaged", () => {
		const { builder, grid } = penDownAt(1);
		expect(grid.devicePxPerWorld).toBe(1);
		whole(builder, 1, COARSE_GRID_RUN * 2);
		expect(grid.engaged).toBe(true);
	});

	it("control: at 200 percent, half device px samples release it", () => {
		// The grid still tells a fine pen from a coarse one at the host zoom: half device px steps are off-grid.
		const { builder, grid } = penDownAt(2);
		for (let i = 1; i <= COARSE_GRID_RUN * 2; i++) builder.add(50 + i / 4, 50, 0.5, i * 8);
		expect(grid.engaged).toBe(false);
	});
});
