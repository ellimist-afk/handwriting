/**
 * Arm E, the wet tile: pen strips draw into one small tile canvas per
 * overlay, sized once outside strokes. The full wet canvas is written only
 * when the tile moves (its pixels are copied into the full canvas at the
 * same device pixels, then the tile is wiped and its origin moves), at a
 * carry, and at a clear. A strip bigger than the tile, or no grid, draws
 * into the full canvas and is counted. The lift clears both.
 *
 * Contract these cells hold the writer to (all optional here, so the file
 * runs red, not broken, before the arm lands):
 * - configureWetTile(tile, cssWidth, cssHeight, backing, cssScale, hostZoom)
 * - tileOrigin: { x, y } in device px of the full canvas, or null
 * - setWetTile(on): boolean, false (refused) while a stroke is live
 *
 * The drawing runs for real; only the pixels are fake. Every drawing call on
 * either context is recorded, so "a full wet write" is any call that can
 * change the full canvas's pixels.
 */
import { describe, expect, it } from "vitest";
import { WetInkRenderer } from "./WetInkRenderer";
import type { CameraState } from "../camera/coordinates";
import { DEFAULT_PEN } from "./PenStyle";

const DRAWS = new Set(["stroke", "fill", "fillRect", "strokeRect", "drawImage", "putImageData"]);

type Call = { op: string; args: unknown[] };
type Tiled = WetInkRenderer & {
	configureWetTile?: (tile: HTMLCanvasElement, cssWidth: number, cssHeight: number, backing: number, cssScale: number, hostZoom: boolean) => void;
	readonly tileOrigin?: { x: number; y: number } | null;
	setWetTile?: (on: boolean) => boolean;
};

function recordingCanvas(width: number, height: number) {
	const calls: Call[] = [];
	const sizeWrites: string[] = [];
	const ctx = new Proxy({} as CanvasRenderingContext2D, {
		get(_t, prop) {
			if (prop === "getContextAttributes") return () => ({ desynchronized: false });
			return (...args: unknown[]) => { calls.push({ op: String(prop), args }); };
		},
		set() { return true; },
	});
	let w = width, h = height;
	const canvas = {
		get width() { return w; }, set width(v: number) { w = v; sizeWrites.push(`w${v}`); },
		get height() { return h; }, set height(v: number) { h = v; sizeWrites.push(`h${v}`); },
		style: {} as Record<string, string>,
		getContext: () => ctx,
	} as unknown as HTMLCanvasElement;
	const draws = () => calls.filter(c => DRAWS.has(c.op));
	const clears = () => calls.filter(c => c.op === "clearRect");
	return { canvas, calls, sizeWrites, draws, clears };
}

const CSS_W = 1000, CSS_H = 600, BACKING = 2;
const cam: CameraState = { x: 0, y: 0, zoom: 1 };

function rig() {
	const full = recordingCanvas(CSS_W * BACKING, CSS_H * BACKING);
	const tile = recordingCanvas(300, 150);
	const wet = new WetInkRenderer(full.canvas, false) as Tiled;
	wet.applyDpr(BACKING);
	wet.configureWetTile?.(tile.canvas, CSS_W, CSS_H, BACKING, 1, false);
	return { wet, full, tile };
}

/** A stroke of `n` events starting at (x0, y0), stepping (dx, dy) css px per event. */
function stroke(wet: WetInkRenderer, n: number, x0: number, y0: number, dx: number, dy: number): void {
	wet.beginStroke({ x: x0, y: y0, pressure: 0.6, t: 0 }, DEFAULT_PEN);
	for (let i = 1; i < n; i++) wet.appendPoint(cam, DEFAULT_PEN, { x: x0 + i * dx, y: y0 + i * dy, pressure: 0.6, t: i * 4 });
}

describe("arm E: the wet tile", () => {
	it("has the tile contract", () => {
		const { wet } = rig();
		expect(typeof wet.configureWetTile, "configureWetTile is missing").toBe("function");
		expect(typeof wet.setWetTile, "setWetTile is missing").toBe("function");
		expect(wet.tileOrigin, "tileOrigin is missing").not.toBeUndefined();
	});

	it("sizes the tile once, smaller than the full canvas, and never during a stroke or at the lift", () => {
		const { wet, tile, full } = rig();
		expect(tile.sizeWrites.length, "configure did not size the tile").toBeGreaterThan(0);
		expect(tile.canvas.width * tile.canvas.height, "the tile is not smaller than the full canvas")
			.toBeLessThan(full.canvas.width * full.canvas.height);
		tile.sizeWrites.length = 0;
		full.sizeWrites.length = 0;
		stroke(wet, 25, 100, 100, 3, 2);
		wet.clearStroke(CSS_W, CSS_H);
		expect(tile.sizeWrites, "a stroke or the lift resized the tile").toEqual([]);
		expect(full.sizeWrites, "a stroke or the lift resized the full canvas").toEqual([]);
	});

	it("a 25-event stroke inside one tile makes zero full wet writes", () => {
		const { wet, full, tile } = rig();
		full.calls.length = 0;
		tile.calls.length = 0;
		// 72 x 48 css px of travel, far inside a tile of any useful size.
		stroke(wet, 25, 100, 100, 3, 2);
		expect(full.draws(), "strips inside the tile wrote the full wet canvas").toEqual([]);
		expect(tile.draws().length, "the strips did not reach the tile").toBeGreaterThan(0);
	});

	it("a stroke crossing the tile edge writes the full canvas only by copying the tile, and moves the origin", () => {
		const { wet, full, tile } = rig();
		stroke(wet, 2, 60, 60, 3, 2);
		const first = wet.tileOrigin ? { ...wet.tileOrigin } : null;
		expect(first, "no tile origin after the first strip").not.toBeNull();
		full.calls.length = 0;
		tile.calls.length = 0;
		// 900 css px to the right: many tile widths at backing 2.
		for (let i = 2; i < 150; i++) wet.appendPoint(cam, DEFAULT_PEN, { x: 60 + i * 6, y: 60 + i, pressure: 0.6, t: i * 4 });
		const copies = full.draws();
		expect(copies.length, "crossing the tile edge never copied the tile into the full canvas").toBeGreaterThan(0);
		for (const c of copies) {
			expect(c.op, "the full canvas took a strip, not a tile copy").toBe("drawImage");
			expect(c.args[0], "the full canvas copied something other than the tile").toBe(tile.canvas);
		}
		expect(wet.tileOrigin, "the origin never moved").not.toEqual(first);
		expect(tile.clears().length, "the tile was not wiped after a copy").toBeGreaterThan(0);
	});

	it("copies each tile at whole device pixels of the full canvas", () => {
		const { wet, full } = rig();
		stroke(wet, 150, 60, 60, 6, 1);
		const copies = full.draws().filter(c => c.op === "drawImage");
		expect(copies.length).toBeGreaterThan(0);
		for (const c of copies) {
			const [, dx, dy] = c.args as [unknown, number, number];
			expect(Number.isInteger(dx) && Number.isInteger(dy), `copy at ${dx},${dy} is not on a device pixel`).toBe(true);
		}
	});

	it("the lift clears the tile and the full canvas", () => {
		const { wet, full, tile } = rig();
		stroke(wet, 150, 60, 60, 6, 1);
		full.calls.length = 0;
		tile.calls.length = 0;
		wet.clearStroke(CSS_W, CSS_H);
		expect(tile.clears().length, "the lift left the tile's pixels").toBeGreaterThan(0);
		expect(full.clears().length, "the lift left the full canvas's pixels").toBeGreaterThan(0);
	});

	it("switched off, strips draw into the full canvas as before, and the tile is untouched", () => {
		const { wet, full, tile } = rig();
		expect(wet.setWetTile?.(false), "the switch refused outside a stroke").toBe(true);
		full.calls.length = 0;
		tile.calls.length = 0;
		stroke(wet, 25, 100, 100, 3, 2);
		expect(full.draws().length, "tile off, the strips did not reach the full canvas").toBeGreaterThan(0);
		expect(tile.draws(), "tile off, a strip reached the tile").toEqual([]);
	});

	it("refuses the switch while a stroke is live", () => {
		const { wet, full } = rig();
		stroke(wet, 5, 100, 100, 3, 2);
		expect(wet.setWetTile?.(false), "the switch was taken mid-stroke").toBe(false);
		full.calls.length = 0;
		for (let i = 5; i < 25; i++) wet.appendPoint(cam, DEFAULT_PEN, { x: 100 + i * 3, y: 100 + i * 2, pressure: 0.6, t: i * 4 });
		expect(full.draws(), "a refused switch still moved the stroke to the full canvas").toEqual([]);
	});

	it("where CSS translate is not supported, no tile: strips draw into the full canvas and the tile gets no translate", () => {
		const full = recordingCanvas(CSS_W * BACKING, CSS_H * BACKING);
		const tile = recordingCanvas(300, 150);
		const wet = new WetInkRenderer(full.canvas, false) as Tiled & { tileTranslate?: boolean };
		wet.applyDpr(BACKING);
		wet.tileTranslate = false;
		wet.configureWetTile?.(tile.canvas, CSS_W, CSS_H, BACKING, 1, false);
		full.calls.length = 0;
		stroke(wet, 25, 100, 100, 3, 2);
		expect(full.draws().length, "no translate: the strips did not reach the full canvas").toBeGreaterThan(0);
		expect(tile.draws(), "no translate: a strip reached the tile").toEqual([]);
		expect((tile.canvas.style as unknown as Record<string, string>).translate, "no translate: the tile got a translate").toBeUndefined();
		expect(wet.tileOrigin, "no translate: the tile was placed").toBeNull();
	});
});
