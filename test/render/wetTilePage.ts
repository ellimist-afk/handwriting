import { WetInkRenderer } from "../../src/ink/WetInkRenderer";
import { DEFAULT_PEN } from "../../src/ink/PenStyle";

type Tiled = WetInkRenderer & {
	configureWetTile?: (tile: HTMLCanvasElement, cssWidth: number, cssHeight: number, backing: number, cssScale: number, hostZoom: boolean) => void;
	readonly tileOrigin?: { x: number; y: number } | null;
	setWetTile?: (on: boolean) => boolean;
};
/**
 * cssScale and hostZoom default to 1 and false, as every caller had before they existed. A caller at note zoom
 * passes the zoom and true, as the overlay does, and runs the page in a browser launched with the device ratio,
 * so the tile finds the grid it finds in the app.
 */
type Config = { width: number; height: number; backing: number; cssScale?: number; hostZoom?: boolean };
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
	const cssScale = config.cssScale ?? 1, hostZoom = config.hostZoom ?? false;
	on.configureWetTile?.(tileCanvas, config.width, config.height, config.backing, cssScale, hostZoom);
	off.configureWetTile?.(makeCanvas(300, 150), config.width, config.height, config.backing, cssScale, hostZoom);
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
	// The contract measure is what the user sees over paper: the alpha difference and, per colour channel, the
	// difference of round(colour x alpha / 255) taken in each arm, the whole number the canvas holds premultiplied.
	// A canvas reports colour apart from alpha, so at a faint pixel one alpha step moves a reported colour channel
	// many steps while the pixel on screen moves by about one; the raw reported-channel difference is kept and
	// printed beside it, not asserted.
	let maxDiff = 0, over = 0, rawMaxDiff = 0, rawOver = 0, offInk = 0, onFullInk = 0;
	type Px = { x: number; y: number; off: number[]; on: number[]; alphaDiff: number; seenDiff: number[] };
	const overPixels: Px[] = [], rawOverPixels: Px[] = [];
	const onFull = onCanvas.getContext("2d")!.getImageData(0, 0, W, H).data;
	for (let i = 0; i < a.length; i += 4) {
		let raw = 0;
		for (let c = 0; c < 4; c++) raw = Math.max(raw, Math.abs(a[i + c]! - b[i + c]!));
		const alphaDiff = Math.abs(a[i + 3]! - b[i + 3]!);
		const seenDiff = [0, 1, 2].map((c) => Math.abs(Math.round(a[i + c]! * a[i + 3]! / 255) - Math.round(b[i + c]! * b[i + 3]! / 255)));
		const d = Math.max(alphaDiff, ...seenDiff);
		maxDiff = Math.max(maxDiff, d);
		rawMaxDiff = Math.max(rawMaxDiff, raw);
		const px = () => ({ x: (i / 4) % W, y: Math.floor(i / 4 / W), off: Array.from(a.slice(i, i + 4)), on: Array.from(b.slice(i, i + 4)), alphaDiff, seenDiff });
		if (d > 2) { over++; if (overPixels.length < 50) overPixels.push(px()); }
		if (raw > 2) { rawOver++; if (rawOverPixels.length < 20) rawOverPixels.push(px()); }
		if (a[i + 3]! > 0) offInk++;
		if (onFull[i + 3]! > 0) onFullInk++;
	}
	return { hasContract, origin, maxDiff, over, rawMaxDiff, rawOver, overPixels, rawOverPixels, offInk, onFullInk, tile: { width: tileCanvas.width, height: tileCanvas.height } };
}

(window as any).wetTilePage = { compare };
