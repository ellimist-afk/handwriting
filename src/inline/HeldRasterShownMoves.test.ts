/**
 * A zoom preview's held raster (putUpHeldRaster) shows a kept picture of the ink: the extent raster or the zoom stand-in. A shown move
 * (lineAnchorsMoved) keeps the strokes and the store generation, so only shownMoves tells that the picture holds the old places. The
 * extent branch already compares it (extentHolds); the stand-in branch of heldRasterSource and the held raster's own check in
 * writeHeldRaster must compare it too, strictly: a held picture one move behind is never put up and never kept up.
 *
 * Runs the real heldRasterSource, writeHeldRaster, takeDownHeldRaster and lineAnchorsMoved on a bare overlay holding one stand-in.
 */
import { describe, expect, it } from "vitest";

import { InkOverlayPlugin, inkLookKey, inlineInk } from "./InkOverlay";
import type { InkStroke } from "../ink/Stroke";

const PATH = "held-raster-shown-moves.md";
const CAM = { x: 0, y: 0, zoom: 0.5 };

function overlay() {
	const proto = Object.create(InkOverlayPlugin.prototype) as object;
	const o = new Proxy(proto, {
		set(target, key, value) {
			Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
			return true;
		},
	}) as Record<string, unknown>;
	const strokes: readonly InkStroke[] = [{ id: "s1", tool: "pen", bbox: { x: 10, y: 20, width: 30, height: 10 } } as unknown as InkStroke];
	const canvas = () => ({ width: 64, height: 64, remove: () => {}, style: {} }) as unknown as HTMLCanvasElement;
	o.filePath = () => PATH;
	o.freeStrokes = () => inlineInk.strokes(PATH);
	o.committedBacking = 2;
	o.dpr = 1;
	o.cssScale = 0.5;
	o.highlightPairDeferred = false;
	o.extentRaster = null;
	o.heldRaster = null;
	o.heldRasterClip = null;
	o.committedCanvas = { width: 64, height: 64, style: { width: "64px", height: "64px", transform: "" } };
	o.container = { style: { left: "0px", top: "0px", transform: "" } };
	o.frontierCache = { invalidate: () => {} };
	o.scheduleRepaint = () => {};
	// No move yet. The line anchors report no size for a move, and the ring of recent moves starts empty.
	o.shownMoves = 0;
	o.lineAnchors = { takeStep: () => null };
	o.shownSteps = Array.from({ length: 16 }, () => ({ step: 0, bound: null }));
	const plugin = o as unknown as InkOverlayPlugin;
	// The stand-in a landing kept, painted at the shown places of move 0, picturing exactly the strokes the layer paints.
	o.standIn = {
		path: PATH, pen: canvas(), hl: null, at: { ...CAM }, backing: 2, dpr: 1, look: inkLookKey(), strokes, count: strokes.length,
		generation: inlineInk.generation(PATH), mark: null, shownMoves: 0, store: inlineInk.strokes(PATH),
	};
	return { o, plugin, strokes };
}

/** The held raster putUpHeldRaster leaves over the stand-in, read when its source was picked at move `moves`. */
function holdStandIn(o: Record<string, unknown>, moves: number) {
	const st = o.standIn as NonNullable<InkOverlayPlugin["standIn"]>;
	o.heldRaster = {
		src: st, f: 1, path: PATH, count: inlineInk.strokes(PATH).length, generation: inlineInk.generation(PATH),
		inner: { style: { transform: "" } }, scroll: { x: 0, y: 0 }, offX: 0, offY: 0, rasterScale: Number.NaN,
		box: "64px 64px", transform: "", hidden: [], shownMoves: moves, penTiles: [], hlTiles: [], hlWrap: null,
	};
}

describe("a held raster is never a picture of the ink from before a shown move", () => {
	it("control: a stand-in at the current shown places is held", () => {
		const { plugin, strokes } = overlay();
		expect(plugin.heldRasterSource(PATH, CAM, strokes), "the stand-in pictures these strokes at these places").not.toBeNull();
	});

	it("a stand-in one move behind is not held", () => {
		const { o, plugin, strokes } = overlay();
		plugin.lineAnchorsMoved(PATH);
		expect(o.shownMoves, "premise: one move").toBe(1);
		expect(plugin.heldRasterSource(PATH, CAM, strokes), "the stand-in pictures the strokes at their old places").toBeNull();
	});

	it("control: a held raster with no move stays up through writeHeldRaster", () => {
		const { o, plugin } = overlay();
		holdStandIn(o, 0);
		plugin.writeHeldRaster(0, 0);
		expect(o.heldRaster, "nothing moved, the picture still holds").not.toBeNull();
	});

	it("a held raster comes down at the next writeHeldRaster after a shown move", () => {
		const { o, plugin } = overlay();
		holdStandIn(o, 0);
		plugin.lineAnchorsMoved(PATH);
		expect([o.shownMoves, o.standIn !== null], "premise: one move, the stand-in still kept").toEqual([1, true]);
		plugin.writeHeldRaster(0, 0);
		expect(o.heldRaster, "the held picture shows the old places and is taken down").toBeNull();
	});
});
