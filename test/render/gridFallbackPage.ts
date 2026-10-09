/**
 * Helpers for GridFallbackPixels.test.ts on top of the scroll column anchor
 * rig: the tear rig's overlay is found by its note path, so this page adds
 * reads and switches without touching the rig.
 */
import "./scrollColumnAnchorPage";
import { setShapeSnap } from "../../src/inline/InkOverlay";

// This page tests the wet tile and the committed draw, not shape snapping. Every pen arm holds the pen still while
// it reads the pen-down screenshots and bitmaps; under load that hold passes ShapeSnap's DWELL_MS and the stroke
// is replaced by a snapped line at pressure 0.5, which reads as a thinner commit. Snap is off for the whole page.
setShapeSnap(false);
import { inlineInk, overlayForPath } from "../../src/inline/InkOverlay";
import { pressureSensitivityEnabled } from "../../src/ink/PenStyle";
import { inkShapingEnabled, centerlineSmoothed } from "../../src/ink/InkShape";

const TEAR_PATH = "scroll-anchor-tear.md";
const overlay = (): any => {
	const o = overlayForPath(TEAR_PATH);
	if (!o) throw new Error("tear rig overlay not mounted");
	return o;
};
const frames = (n: number) => new Promise<void>(res => {
	const step = (left: number) => left <= 0 ? res() : requestAnimationFrame(() => step(left - 1));
	step(n);
});

/** Fit's own commit, the one path allowed below the manual floor, then a settle. */
async function fitCommit(scale: number) {
	const o = overlay();
	if (!o.commitCameraScale(scale, { left: 0, top: 0 }, undefined, false, true)) throw new Error(`fit commit at ${scale} refused`);
	await frames(12);
	await new Promise(res => setTimeout(res, 250));
	await frames(4);
	return { pinchScaleNow: o.pinchScaleNow as number, cssScale: o.cssScale as number };
}

/** The full-canvas arm: the wet tile switched off and the tail sized to the band, as when no grid exists. */
function fullCanvasArm() {
	const o = overlay();
	if (!o.wet.setWetTile(false)) throw new Error("wet tile switch refused");
	const t = o.tail, cfg = t.inlineBacking;
	t.translateSupport = false;
	t.configureInlineBacking(cfg.width, cfg.height, cfg.backing, cfg.cssScale, cfg.hostZoom);
	return { wetTile: o.wet.wetTileEnabled as boolean, tailTileW: t.inlineBacking.tileW as number };
}

/**
 * The wet tile's placement read from the screen: its rect against the wet
 * canvas's rect in device px, beside the tile origin and size in backing px.
 * A backing px is a device px when the fallback holds, so the two agree.
 */
function tileGeometry() {
	const o = overlay();
	const dpr = window.devicePixelRatio;
	const tile = o.wetTileCanvas as HTMLCanvasElement, full = o.wetCanvas as HTMLCanvasElement;
	const tr = tile.getBoundingClientRect(), fr = full.getBoundingClientRect();
	const origin = o.wet.tileOrigin as { x: number; y: number } | null;
	return {
		dpr, origin, backing: { w: tile.width, h: tile.height },
		device: { x: (tr.left - fr.left) * dpr, y: (tr.top - fr.top) * dpr, w: tr.width * dpr, h: tr.height * dpr },
		fullDevice: { w: fr.width * dpr, h: fr.height * dpr }, fullBacking: { w: full.width, h: full.height },
		translate: tile.style.translate,
	};
}

let meter: { events: number; ms: number[]; fullDraws: number; tileGeom: ReturnType<typeof tileGeometry> | null } | null = null;
const DRAW_CALLS = ["fill", "stroke", "drawImage", "fillRect", "putImageData"] as const;

/**
 * Count draws into the full wet canvas and time each penRaw call until
 * meterRead. Instance overrides: the router calls this.penRaw, and the wet
 * renderer draws through its context object.
 */
function meterStart() {
	const o = overlay();
	const m = { events: 0, ms: [] as number[], fullDraws: 0, tileGeom: null as ReturnType<typeof tileGeometry> | null };
	meter = m;
	const ctx = o.wet.ctx as Record<string, (...a: unknown[]) => unknown>;
	for (const name of DRAW_CALLS) {
		const real = Object.getPrototypeOf(ctx)[name] as (...a: unknown[]) => unknown;
		ctx[name] = function (this: unknown, ...a: unknown[]) { if (meter === m) m.fullDraws++; return real.apply(this, a); };
	}
	const penRaw = Object.getPrototypeOf(o).penRaw as (...a: unknown[]) => unknown;
	o.penRaw = function (this: unknown, ...a: unknown[]) {
		const t0 = performance.now();
		try { return penRaw.apply(this, a); } finally {
			if (meter === m) { m.events++; m.ms.push(performance.now() - t0); if (o.wet.tileOrigin) m.tileGeom = tileGeometry(); }
		}
	};
}

function meterRead() {
	const m = meter;
	meter = null;
	if (!m) return null;
	const sorted = [...m.ms].sort((a, b) => a - b);
	const q = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : 0;
	return { events: m.events, fullDraws: m.fullDraws, perEvent: m.events ? m.fullDraws / m.events : 0,
		totalMs: m.ms.reduce((a, b) => a + b, 0), p50: q(0.5), p90: q(0.9), max: sorted.at(-1) ?? 0, tileGeom: m.tileGeom };
}

/** What the live layers are: wet tile backing and grid, tail mode and grid, backing, ratio. */
function layers() {
	const o = overlay();
	const tail = o.tail.inlineGrid as { grid: number | null; mode: string } | null;
	return {
		dpr: window.devicePixelRatio, cssScale: o.cssScale as number, pinchScaleNow: o.pinchScaleNow as number,
		backing: o.committedBacking as number, hostZoom: o.hostZoomSupported() as boolean,
		tile: { w: (o.wetTileCanvas as HTMLCanvasElement).width, h: (o.wetTileCanvas as HTMLCanvasElement).height, grid: o.wet.tileGrid as number | null, on: o.wet.wetTileEnabled as boolean },
		tail: { w: (o.tailCanvas as HTMLCanvasElement).width, h: (o.tailCanvas as HTMLCanvasElement).height, grid: tail?.grid ?? null, mode: tail?.mode ?? "none", tileW: o.tail.inlineBacking?.tileW as number },
		band: { w: (o.committedCanvas as HTMLCanvasElement).width, h: (o.committedCanvas as HTMLCanvasElement).height },
	};
}

/**
 * Ink weight and centroid in one canvas's bitmap, mapped to absolute device px
 * through the canvas's rect, over an absolute device px window. Pixel centres;
 * alpha is the weight. Read after the screenshots: a readback can change how
 * the canvas is rastered after it.
 */
function canvasInk(field: "wetTileCanvas" | "wetCanvas" | "committedCanvas", win: { x0: number; x1: number; y0: number; y1: number }) {
	const o = overlay();
	const dpr = window.devicePixelRatio;
	const c = o[field] as HTMLCanvasElement;
	const r = c.getBoundingClientRect();
	const ox = r.left * dpr, oy = r.top * dpr;
	const sx = c.width / (r.width * dpr), sy = c.height / (r.height * dpr);
	const bx0 = Math.max(0, Math.floor((win.x0 - ox) * sx)), bx1 = Math.min(c.width, Math.ceil((win.x1 - ox) * sx));
	const by0 = Math.max(0, Math.floor((win.y0 - oy) * sy)), by1 = Math.min(c.height, Math.ceil((win.y1 - oy) * sy));
	if (!(bx1 > bx0 && by1 > by0)) return { field, w: 0, cx: NaN, cy: NaN };
	const d = c.getContext("2d")!.getImageData(bx0, by0, bx1 - bx0, by1 - by0).data;
	let w = 0, wx = 0, wy = 0;
	for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
		const a = d[((y - by0) * (bx1 - bx0) + (x - bx0)) * 4 + 3]! / 255;
		if (!a) continue;
		const ax = ox + (x + 0.5) / sx, ay = oy + (y + 0.5) / sy;
		if (ax < win.x0 || ax >= win.x1 || ay < win.y0 || ay >= win.y1) continue;
		w += a; wx += a * ax; wy += a * ay;
	}
	return { field, w, cx: wx / w, cy: wy / w };
}

/**
 * Commit draw source, per stroke (looped runs only): tile flushes, strips and
 * where each strip went while the pen was down; then every committed paint
 * from pen-down to the read, split into the draw at the lift itself
 * (markCommittedPaint outside a repaint) and whole or damaged repaints
 * (paintCommittedWork), each with the backing, ratio and camera it drew at.
 */
type Cam = { x: number; y: number; zoom: number } | null;
type CommitDraw = { kind: "lift" | "repaint"; tool?: string; work?: string; strokes?: number; backing: number; dpr: number; overlayDpr: number; cssScale: number;
	pinchPreview: boolean; cam: Cam; lastPaintCam: Cam; paintCam: Cam; floor: { backing: number; dpr: number } | null;
	stroke?: { width: number; points: number; pressureMin: number | null; pressureMax: number | null } | null };
let source: { flushes: number; strips: number; stripsOnTile: number; draws: CommitDraw[] } | null = null;
function sourceStart() {
	const o = overlay();
	const wet = o.wet;
	source = { flushes: 0, strips: 0, stripsOnTile: 0, draws: [] };
	if (o.__commitSource) return;
	o.__commitSource = true;
	const flush = wet.flushTile, target = wet.target, paint = o.paintCommittedWork, mark = o.markCommittedPaint;
	// The stroke the lift draws, as the store holds it at that moment: its width and pressures are the width inputs drawStroke reads.
	const lastStroke = (self: any) => {
		const path = self.lastPath as string | null;
		const s = (path ? inlineInk.strokes(path) : []).at(-1) as any;
		if (!s) return null;
		const pr = ((s.points ?? []) as { pressure?: number }[]).map(p => p.pressure).filter((p): p is number => typeof p === "number");
		const ctx = self.committedCtx as CanvasRenderingContext2D, cv = self.committedCanvas as HTMLCanvasElement, m = ctx.getTransform(), rc = cv.getBoundingClientRect(); return { width: s.width, points: (s.points ?? []).length, pressureMin: pr.length ? Math.min(...pr) : null, pressureMax: pr.length ? Math.max(...pr) : null, pressureFirst: pr[0] ?? null, pressureLast: pr.at(-1) ?? null, pressureProfile: s.pressureProfile ?? null, widthMode: s.widthMode ?? null, device: s.device ?? null, tool: s.tool, pressureOn: pressureSensitivityEnabled(), shaping: inkShapingEnabled(), smooth: centerlineSmoothed(s.tool === "highlighter"), ctxScale: [m.a, m.d], ctxShift: [m.e, m.f], canvas: [cv.width, cv.height], canvasCss: [rc.width, rc.height], t: performance.now(),
			ts: (s.points ?? []).map((p: any) => p.t), xs: (s.points ?? []).map((p: any) => Math.round(p.x * 100) / 100), ys: (s.points ?? []).map((p: any) => Math.round(p.y * 100) / 100),
			dtLe1: (s.points ?? []).reduce((n: number, p: any, i: number, a: any[]) => n + (i > 0 && p.t - a[i - 1].t <= 1 ? 1 : 0), 0) };
	};
	let inRepaint = 0;
	const cam = (c: any) => (c ? { x: c.x, y: c.y, zoom: c.zoom } : null);
	// The lift draw's own inputs (InkOverlay.ts, the drawStroke after markCommittedPaint): paintCam is the last paint's camera
	// under a pinch preview, else the camera; the floor is committedFloorFor(committedBacking, dpr).
	const draw = (self: any, extra: Partial<CommitDraw> & { kind: CommitDraw["kind"] }): CommitDraw => ({
		backing: self.committedBacking, dpr: window.devicePixelRatio, overlayDpr: self.dpr, cssScale: self.cssScale, pinchPreview: !!self.pinchPreview,
		cam: cam(self.camera?.snapshot), lastPaintCam: cam(self.lastPaintCam),
		paintCam: cam(self.pinchPreview && self.lastPaintCam ? self.lastPaintCam : self.camera?.snapshot),
		floor: self.committedBacking === null ? null : { backing: self.committedBacking, dpr: self.dpr }, ...extra,
	});
	wet.flushTile = function (...a: unknown[]) { if (source && !this.tileBlank && this.tilePlaced) source.flushes++; return flush.apply(this, a); };
	wet.target = function (...a: unknown[]) { const r = target.apply(this, a); if (source) { source.strips++; if (r === this.tileCtx) source.stripsOnTile++; } return r; };
	o.paintCommittedWork = function (c: unknown, work: unknown, strokes: readonly unknown[]) {
		if (source) source.draws.push(draw(this, { kind: "repaint", work: work === "all" ? "all" : `damage x${(work as unknown[]).length}`, strokes: strokes.length }));
		inRepaint++;
		try { return paint.call(this, c, work, strokes); } finally { inRepaint--; }
	};
	o.markCommittedPaint = function (tool: string) {
		if (source && !inRepaint) source.draws.push(draw(this, { kind: "lift", tool, stroke: lastStroke(this) }));
		return mark.call(this, tool);
	};
}
function sourceRead() {
	return source;
}

(window as any).gridFallback = { fitCommit, fullCanvasArm, tileGeometry, meterStart, meterRead, layers, canvasInk, sourceStart, sourceRead };
