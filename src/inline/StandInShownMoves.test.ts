/**
 * A picture of the ink kept for a later frame (the extent raster, the zoom stand-in) holds the strokes where they were shown when it
 * was painted. When the line anchors move the shown strokes (lineAnchorsMoved: a picture above entered the height map, a line
 * re-wrapped), every such picture describes the old places and must not be copied again: measured on the k4 lift of
 * ZoomOut203.armD mode "below", where a stand-in painted one measure before picture 0 entered the height map was copied in the
 * queued frame, 761 px off its words, for about 219 ms.
 *
 * Runs the real usableExtent, extentToStandIn, usableStandIn and lineAnchorsMoved on a bare overlay holding one raster.
 */
import { describe, expect, it } from "vitest";

import { InkOverlayPlugin, inkLookKey, inlineInk } from "./InkOverlay";
import type { InkStroke } from "../ink/Stroke";

const PATH = "stand-in-shown-moves.md";
const CAM = { x: 0, y: 0, zoom: 0.5 };

function overlay() {
	const proto = Object.create(InkOverlayPlugin.prototype) as object;
	const o = new Proxy(proto, {
		set(target, key, value) {
			Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
			return true;
		},
	}) as Record<string, unknown>;
	const asked: string[] = [];
	const strokes: readonly InkStroke[] = [{ id: "s1", tool: "pen", bbox: { x: 10, y: 20, width: 30, height: 10 } } as unknown as InkStroke];
	const canvas = () => ({ width: 64, height: 64 }) as unknown as HTMLCanvasElement;
	o.filePath = () => PATH;
	o.committedBacking = 2;
	o.dpr = 1;
	o.cssScale = 0.5;
	o.highlightPairDeferred = false;
	o.pinchHeld = () => false;
	o.previewPaperSettling = false;
	o.retiring = false;
	o.standIn = null;
	o.standInRetryTimer = 0;
	o.inQueuedFrame = true;
	o.damage = { addAll: () => asked.push("addAll") };
	o.frontierCache = { invalidate: () => {} };
	o.scheduleRepaint = (via?: string) => asked.push(via ?? "other");
	// No move yet: the shown places are those of the overlay's first count.
	o.shownMoves = 0;
	// The line anchors report no size for a move here, and the ring of recent moves starts empty: every move is unknown.
	o.lineAnchors = { takeStep: () => null };
	o.shownSteps = Array.from({ length: 16 }, () => ({ step: 0, bound: null }));
	const plugin = o as unknown as InkOverlayPlugin;
	// The raster a whole paint at this zoom left: it holds this store as it is, at the shown places read when it was built.
	const built = 0;
	o.extentRaster = {
		path: PATH, pen: canvas(), hl: null, kx: 0, ky: 0, cam0: { ...CAM }, at: { ...CAM }, world: { x0: 0, y0: 0, x1: 64, y1: 64 },
		backing: 2, dpr: 1, look: inkLookKey(), strokes, generation: inlineInk.generation(PATH), count: strokes.length, shownMoves: built,
	};
	return { o, plugin, strokes, asked };
}

describe("a kept picture of the ink is let go when the line anchors move the shown strokes", () => {
	it("control: with nothing moved, the raster held is used", () => {
		const { plugin, strokes } = overlay();
		expect(plugin.usableExtent(CAM, strokes), "the raster holds this store at this zoom").not.toBeNull();
	});

	it("after lineAnchorsMoved the raster held is not used", () => {
		const { plugin, strokes } = overlay();
		plugin.lineAnchorsMoved(PATH);
		expect(plugin.usableExtent(CAM, strokes), "the raster pictures the strokes at their old places").toBeNull();
	});

	it("the stand-in kept from that raster is refused in the queued frame and kept outside it, where the whole paint defers", () => {
		const { o, plugin, strokes } = overlay();
		plugin.lineAnchorsMoved(PATH);
		// The raster becomes the stand-in when it no longer serves (extentToStandIn, as usableExtent does on a zoom change).
		expect(plugin.usableExtent(CAM, strokes)).toBeNull();
		expect(plugin.standIn, "the stale raster is kept as the stand-in, with the shown places it was built at").not.toBeNull();
		// Outside the queued frame a whole paint finds the stand-in and defers to the queued frame (it draws nothing).
		o.inQueuedFrame = false;
		expect(plugin.usableStandIn(strokes, true, CAM), "outside the queued frame the stand-in is still found, so the paint defers").not.toBeNull();
		// The queued frame checks the shown places and paints by path instead.
		o.inQueuedFrame = true;
		expect(plugin.usableStandIn(strokes, true, CAM), "the queued frame refuses a stand-in painted before the move").toBeNull();
		expect(plugin.standIn, "and lets it go").toBeNull();
	});
});
