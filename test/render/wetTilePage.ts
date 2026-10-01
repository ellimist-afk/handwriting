import { WetInkRenderer } from "../../src/ink/WetInkRenderer";
import { DEFAULT_PEN } from "../../src/ink/PenStyle";

type Tiled = WetInkRenderer & {
	configureWetTile?: (tile: HTMLCanvasElement, cssWidth: number, cssHeight: number, backing: number, cssScale: number, hostZoom: boolean) => void;
	readonly tileOrigin?: { x: number; y: number } | null;
	setWetTile?: (on: boolean) => boolean;
};
type Config = { width: number; height: number; backing: number };
type Point = { x: number; y: number; pressure: number };

function makeCanvas(w: number, h: number): HTMLCanvasElement {
	const c = document.body.appendChild(document.createElement("canvas"));
	c.width = w; c.height = h;
	return c;
}

/**
 * Draw one live stroke twice, tile off and tile on, and compare what the
 * user would see before the lift: the off arm's full wet canvas against the
 * on arm's full wet canvas with its tile laid over it at the tile origin.
 * The comparison is made on backing pixels, so it does not depend on how the
 * writer places the tile with CSS.
 */
function compare(config: Config, points: Point[]) {
	document.body.replaceChildren();
	const W = Math.round(config.width * config.backing), H = Math.round(config.height * config.backing);
	const cam = { x: 0, y: 0, zoom: 1 };
	const offCanvas = makeCanvas(W, H), onCanvas = makeCanvas(W, H), tileCanvas = makeCanvas(300, 150);
	const off = new WetInkRenderer(offCanvas, false) as Tiled;
	const on = new WetInkRenderer(onCanvas, false) as Tiled;
	for (const r of [off, on]) r.applyDpr(config.backing);
	const hasContract = typeof on.configureWetTile === "function" && typeof on.setWetTile === "function";
	on.configureWetTile?.(tileCanvas, config.width, config.height, config.backing, 1, false);
	off.configureWetTile?.(makeCanvas(300, 150), config.width, config.height, config.backing, 1, false);
	off.setWetTile?.(false);
	for (const r of [off, on]) {
		r.beginStroke({ ...points[0]!, t: 0 }, DEFAULT_PEN);
		for (let i = 1; i < points.length; i++) r.appendPoint(cam, DEFAULT_PEN, { ...points[i]!, t: i * 4 });
	}
	const origin = on.tileOrigin ?? null;
	const seen = makeCanvas(W, H);
	const sctx = seen.getContext("2d")!;
	sctx.drawImage(onCanvas, 0, 0);
	if (origin) sctx.drawImage(tileCanvas, origin.x, origin.y);
	const a = offCanvas.getContext("2d")!.getImageData(0, 0, W, H).data;
	const b = sctx.getImageData(0, 0, W, H).data;
	let maxDiff = 0, over = 0, offInk = 0, onFullInk = 0;
	const onFull = onCanvas.getContext("2d")!.getImageData(0, 0, W, H).data;
	for (let i = 0; i < a.length; i += 4) {
		let d = 0;
		for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a[i + c]! - b[i + c]!));
		maxDiff = Math.max(maxDiff, d);
		if (d > 2) over++;
		if (a[i + 3]! > 0) offInk++;
		if (onFull[i + 3]! > 0) onFullInk++;
	}
	return { hasContract, origin, maxDiff, over, offInk, onFullInk, tile: { width: tileCanvas.width, height: tileCanvas.height } };
}

(window as any).wetTilePage = { compare };
