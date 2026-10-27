/**
 * What the screen does frame by frame after a pan and a zoom out on Alan's own ink with Infinite Canvas on.
 *
 * Seen on Orion (1.4.23 package 1d091c72, "Untitled 1"): pan, then zoom out; part of the ink is cut by a box, about a second after
 * the fingers lift the box fills, and at that moment "the whole viewport wiggles, not the ink". The box was a zoom stand-in taken
 * while a bounce played over the commit: a small old picture at the layer's corner, its ink 500 to 575 device px from where the
 * sharp ink lands, held about a second.
 *
 * GATE CELLS: the two bounce arms at dpr 2 read the shifts on every frame. While the stand-in is held (the preview's partial picture,
 * blank beyond it) the picture inside its rect sits under 0.25 device px from the path draw with under 1 percent
 * of the rect's path ink blank; from the first frame with no stand-in held, the whole layer leaves no path ink blank and sits under
 * 0.25 device px. At 0.302417 the rect holds no path ink, so only the crisp frames are asserted. The still cells stay arms. Each cell logs one row per animation frame from the zoom commit until two seconds after the
 * sharp raster lands:
 *
 * - the stand-in (held, its rect on the layer), a build pending, a finished raster held;
 * - the inked box of the committed layer (alpha above 0) against the layer's size, device px, and whether it covers the view;
 * - the camera (x, y, zoom), the resting pan, the CSS scale, the layer canvas's screen rect and transform;
 * - one text line's screen rect and the scroller's scroll offsets (a viewport move shows here, an ink-only move does not);
 * - where the layer's ink stands against the whole store drawn by path at the same camera (best-fit shift up to 576 device px,
 *   and px the path draw inks that the layer leaves blank), read on
 *   every second frame and on every frame where the stand-in state changes.
 *
 * Also logged: every call of syncBand, updateExtent, syncCamera, repaintOverStandIn, handleResize and the
 * extent piece that finishes the raster, with the scroller state (scroll offsets and size, the extent spacer, a text line) before
 * and after when it changed; one stroke's start point (device px) in the path draw and where the layer shows it; and the scroll
 * probe's extent lines (diagnostics switched on for the run).
 *
 * Arms: dpr from HW_ARM_DPR (2 or 1.8257), from 100 percent, a pan right and down left unbaked, then a zoom out to 0.5 or 0.302;
 * nothing live, or a bounce playing over the commit and ending 300 ms later (the pan still settling).
 *
 * The gate cell asserts at dpr 2 only; under HW_ARM_DPR=1.8257 the same cell is an arm.
 *
 * Run: HW_ARM_DPR=2 npx vitest run --config vitest.render.mts test/render/ZoomOutStandInWiggle.arm.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const FULL = readFileSync(fileURLToPath(new URL("./fixtures/alan-ink-75d1627a.json", import.meta.url)), "utf8");
// The note's ink, cut to the strokes inside world [900, 3700] x [700, 3000]: at 0.5 its whole raster (about 6.4 M device px a layer) fits the
// desktop cap and, beside the held stand-in, the pair cap, so the settle builds. The whole note (10,265 by 7,025 device
// px at 0.5, 72 M) is over the cap, and has its own arm.
const CUT = { x0: 900, y0: 700, x1: 3700, y1: 3000 };
function cutInk(json: string): string {
	const d = JSON.parse(json);
	d.strokes = (d.strokes as Array<{ pts: number[] }>).filter(st => {
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (let i = 0; i + 1 < st.pts.length; i += 4) { const x = st.pts[i]!, y = st.pts[i + 1]!; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
		return x0 >= CUT.x0 && y0 >= CUT.y0 && x1 <= CUT.x1 && y1 <= CUT.y1;
	});
	return JSON.stringify(d);
}
const CUT_FIXTURE = cutInk(FULL);
const PAGE_ID = "75d1627a-c4d7-4a11-947d-bc26b7f83c20";
const PANE = { w: 1184, h: 824 };
const DSF = Number((globalThis as any).process?.env?.HW_ARM_DPR ?? "2");
const OUT: string = (globalThis as any).process?.env?.HW_ARM_OUT ?? "";
const PATH = "Untitled 1.md";

const ENTRY = `import "./panBakeRepaintPage.ts";
import { inlineInk, overlayForPath } from "../../src/inline/InkOverlay";
import { drawCommitted } from "../../src/ink/StrokeRenderer";
import { clearScrollProbe, formatScrollProbe } from "../../src/inline/ScrollProbe";
import { setDiagnosticsEnabled } from "../../src/diag/DiagSwitch";
import { extentRasterFits, extentPairFits } from "../../src/inline/InkOverlayConstants";
import { Platform } from "obsidian";
const W = window as any;
const t0ref = { t: 0 };
const armExits: any[] = [];
const wholePaints: any[] = [], pathPts = { n: 0 }, inLift = { on: false };
const events: any[] = [];
function scrollState() {
	const sd = document.querySelector(".cm-scroller") as HTMLElement | null, sp = document.querySelector(".handwriting-surface-extent") as HTMLElement | null;
	const line = document.querySelector(".cm-line") as HTMLElement | null;
	return { top: sd?.scrollTop ?? null, left: sd?.scrollLeft ?? null, height: sd?.scrollHeight ?? null, width: sd?.scrollWidth ?? null,
		spacer: sp ? { left: sp.style.left, top: sp.style.top } : null, lineY: line ? line.getBoundingClientRect().top : null };
}
function inkBox(o: any) {
	const c = o.committedCanvas as HTMLCanvasElement, w = c.width, h = c.height, d = o.committedCtx.getImageData(0, 0, w, h).data;
	let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3]! > 0) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
	return n ? { x0, y0, x1, y1, n } : { x0: 0, y0: 0, x1: -1, y1: -1, n: 0 };
}
function shift(o: any, at?: { x: number; y: number }, half = 256) {
	const cam = o.lastPaintCam, b = o.committedBacking, w = o.committedCanvas.width, h = o.committedCanvas.height;
	if (!cam || !b) return null;
	const c = document.createElement("canvas"); c.width = w; c.height = h;
	const x = c.getContext("2d")!; x.setTransform(b, 0, 0, b, 0, 0);
	drawCommitted(x, cam, inlineInk.strokes("${PATH}"), o.cssWidth, o.cssHeight, true, "pen", false, { backing: b, dpr: o.dpr });
	const A = o.committedCtx.getImageData(0, 0, w, h).data, B = x.getImageData(0, 0, w, h).data;
	c.width = 0; c.height = 0;
	// Ink the path draw has and the layer leaves blank, and the reverse, over the whole layer.
	let direct = 0, layer = 0, lost = 0, extra = 0;
	for (let i = 3; i < A.length; i += 4) { const a = A[i]! > 0, bb = B[i]! > 0; if (a) layer++; if (bb) direct++; if (bb && !a) lost++; if (a && !bb) extra++; }
	// Best-fit shift of the layer against the path draw over a central window: a coarse search on 8 px cells over +-64 cells, then a
	// fine search of +-6 px around it with a parabola through the minimum, each axis alone and then the other at the found offset.
	const n = half * 2, cx = Math.max(0, Math.min(w - n, Math.floor((at ? at.x : w / 2) - half))), cy = Math.max(0, Math.min(h - n, Math.floor((at ? at.y : h / 2) - half)));
	const ssd = (sx: number, sy: number) => { let e = 0; for (let yy = cy; yy < cy + n; yy += 2) for (let xx = cx; xx < cx + n; xx += 2) { const by = yy + sy, bx = xx + sx; const q = (by < 0 || bx < 0 || by >= h || bx >= w) ? 0 : B[(by * w + bx) * 4 + 3]!; const dd = A[(yy * w + xx) * 4 + 3]! - q; e += dd * dd; } return e; };
	let bx = 0, by = 0, best = ssd(0, 0);
	for (let gy = -64; gy <= 64; gy += 4) for (let gx = -64; gx <= 64; gx += 4) { const e = ssd(gx * 8, gy * 8); if (e < best) { best = e; bx = gx * 8; by = gy * 8; } }
	for (let r = 32; r >= 1; r = r >> 1) for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]] as const) { const e = ssd(bx + dx, by + dy); if (e < best) { best = e; bx += dx; by += dy; } }
	const fit = (f: (s: number) => number, c0: number) => { const v = [-1, 0, 1].map(s => f(c0 + s)); const den = v[0]! - 2 * v[1]! + v[2]!; return den > 0 ? c0 + 0.5 * (v[0]! - v[2]!) / den : c0; };
	const dx = fit(s => ssd(s, by), bx), dy = fit(s => ssd(bx, s), by);
	let winLayer = 0, winPath = 0;
	for (let yy = cy; yy < cy + n; yy++) for (let xx = cx; xx < cx + n; xx++) { const i = (yy * w + xx) * 4 + 3; if (A[i]! > 0) winLayer++; if (B[i]! > 0) winPath++; }
	return { dx, dy, direct, layer, lost, extra, residual: best, winLayer, winPath };
}
function rectShift(o: any, r: { x: number; y: number; w: number; h: number } | null) {
	// Inside the stand-in's own rect only (device px): the picture's placement, with the blank outside it left out. Counts over the
	// whole rect; best fit over the rect inset by the search reach, integer search +-16 px, then a parabola through the minimum.
	const cam = o.lastPaintCam, b = o.committedBacking, w = o.committedCanvas.width, h = o.committedCanvas.height;
	if (!r || !cam || !b) return null;
	const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y)), x1 = Math.min(w, Math.ceil(r.x + r.w)), y1 = Math.min(h, Math.ceil(r.y + r.h));
	if (!(x1 > x0) || !(y1 > y0)) return null;
	const c = document.createElement("canvas"); c.width = w; c.height = h;
	const x = c.getContext("2d")!; x.setTransform(b, 0, 0, b, 0, 0);
	drawCommitted(x, cam, inlineInk.strokes("${PATH}"), o.cssWidth, o.cssHeight, true, "pen", false, { backing: b, dpr: o.dpr });
	const A = o.committedCtx.getImageData(0, 0, w, h).data, B = x.getImageData(0, 0, w, h).data;
	c.width = 0; c.height = 0;
	let direct = 0, layer = 0, lost = 0, extra = 0;
	for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * w + xx) * 4 + 3, a = A[i]! > 0, bb = B[i]! > 0; if (a) layer++; if (bb) direct++; if (bb && !a) lost++; if (a && !bb) extra++; }
	const R = 16, wx0 = x0 + R, wy0 = y0 + R, wx1 = x1 - R, wy1 = y1 - R;
	if (!(wx1 > wx0) || !(wy1 > wy0)) return { dx: null, dy: null, direct, layer, lost, extra, rect: [x0, y0, x1, y1] };
	const ssd = (sx: number, sy: number) => { let e = 0; for (let yy = wy0; yy < wy1; yy++) for (let xx = wx0; xx < wx1; xx++) { const dd = A[(yy * w + xx) * 4 + 3]! - B[((yy + sy) * w + xx + sx) * 4 + 3]!; e += dd * dd; } return e; };
	let bx = 0, by = 0, best = ssd(0, 0);
	for (let sy = -R; sy <= R; sy += 2) for (let sx = -R; sx <= R; sx += 2) { const e = ssd(sx, sy); if (e < best) { best = e; bx = sx; by = sy; } }
	for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) { const e = ssd(bx + ddx, by + ddy); if (e < best && Math.abs(bx + ddx) <= R && Math.abs(by + ddy) <= R) { best = e; bx += ddx; by += ddy; } }
	const fit = (f: (s: number) => number, c0: number) => { if (Math.abs(c0) >= R) return c0; const v = [-1, 0, 1].map(s => f(c0 + s)); const den = v[0]! - 2 * v[1]! + v[2]!; return den > 0 ? c0 + 0.5 * (v[0]! - v[2]!) / den : c0; };
	const dx = fit(sv => ssd(sv, by), bx), dy = fit(sv => ssd(bx, sv), by);
	return { dx, dy, direct, layer, lost, extra, residual: best, atLimit: Math.abs(bx) >= R || Math.abs(by) >= R, rect: [x0, y0, x1, y1] };
}
function wrapLog(o: any, name: string) {
	const orig = o[name]; if (typeof orig !== "function") return;
	o[name] = function (this: any, ...a: any[]) {
		const before = scrollState(), cam0 = this.lastPaintCam ? { x: this.lastPaintCam.x, y: this.lastPaintCam.y } : null;
		const r = orig.apply(this, a);
		const after = scrollState(), cam1 = this.lastPaintCam ? { x: this.lastPaintCam.x, y: this.lastPaintCam.y } : null;
		const ev: any = { ms: Math.round((performance.now() - t0ref.t) * 10) / 10, call: name, ret: typeof r === "string" ? r : undefined };
		if (JSON.stringify(before) !== JSON.stringify(after)) { ev.before = before; ev.after = after; }
		if (name === "runExtentPiece") ev.rasterDone = !!this.extentRaster && !this.extentBuild;
		if (JSON.stringify(cam0) !== JSON.stringify(cam1)) { ev.cam0 = cam0; ev.cam1 = cam1; }
		if (name !== "runExtentPiece" || ev.rasterDone || ev.before) events.push(ev);
		return r;
	};
}
W.arm = {
	instrument() {
		const o: any = overlayForPath("${PATH}");
		for (const n of ["syncBand", "updateExtent", "syncCamera", "repaintOverStandIn", "runExtentPiece", "handleResize"]) wrapLog(o, n);
		// Whole paints of the committed layer: path points drawn on it during each (none for a copy), in the commit's own task, on a bounce.
		const pc = o.paintCommittedWork, cv = o.committedCanvas;
		o.paintCommittedWork = function (this: any, cam: any, work: any, strokes: any) {
			const p0 = pathPts.n;
			try { return pc.call(this, cam, work, strokes); } finally {
				if (work === "all") wholePaints.push({ ms: Math.round((performance.now() - t0ref.t) * 10) / 10, pts: pathPts.n - p0, inLift: inLift.on, bounce: !!this.bounceState });
			}
		};
		for (const n of ["moveTo", "lineTo", "quadraticCurveTo", "bezierCurveTo", "arc"]) {
			const P: any = CanvasRenderingContext2D.prototype, f = P[n];
			P[n] = function (this: any, ...a: any[]) { if (this.canvas === cv) pathPts.n++; return f.apply(this, a); };
		}
		// armExtentBuild's exit: which of its early returns the settle met, read from its own inputs.
		const arm = o.armExtentBuild;
		o.armExtentBuild = function (this: any, cam: any, strokes: any, floor: any) {
			const path = this.filePath(), backing = this.committedBacking ?? 0, st = this.standIn;
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			for (const s of strokes) { const b = s.bbox; x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); }
			const k = cam.zoom * backing, kx = Math.floor((x0 - cam.x) * k) - 2, ky = Math.floor((y0 - cam.y) * k) - 2;
			const w = Math.ceil((x1 - cam.x) * k) + 2 - kx, h = Math.ceil((y1 - cam.y) * k) + 2 - ky;
			const held = st ? st.pen.width * st.pen.height * (st.hl ? 2 : 1) : 0, hl = strokes.some((s: any) => s.tool === "highlighter") ? 2 : 1;
			const r = arm.call(this, cam, strokes, floor);
			armExits.push({ ms: Math.round((performance.now() - t0ref.t) * 10) / 10, path: path === null ? null : "set", backing, strokes: strokes.length, cam: { ...cam },
				w, h, px: w * h, rasterFits: extentRasterFits(w, h), held, pairFits: held > 0 ? extentPairFits(w * h * hl, held) : null, mobile: !!Platform.isMobile,
				built: !!this.extentBuild });
			return r;
		};
		clearScrollProbe(); setDiagnosticsEnabled(true);
	},
	startClock() { t0ref.t = performance.now(); events.length = 0; armExits.length = 0; wholePaints.length = 0; },
	events() { return events.slice(); },
	armExits() { return armExits.slice(); },
	wholePaints() { return wholePaints.slice(); },
	probe() { const t = formatScrollProbe(); setDiagnosticsEnabled(false); return t.split(String.fromCharCode(10)).filter(l => /extent|spacer|reserve|grant|bounce|settle/i.test(l)).slice(-80); },
	pick() {
		const o: any = overlayForPath("${PATH}"), cam = o.lastPaintCam, b = o.committedBacking, c = o.committedCanvas as HTMLCanvasElement;
		const k = cam.zoom * b; let best: any = null;
		for (const st of inlineInk.strokes("${PATH}") as any[]) {
			const p = st.points?.[0] ?? (st.pts ? { x: st.pts[0], y: st.pts[1] } : null); if (!p) continue;
			const x = (p.x - cam.x) * k, y = (p.y - cam.y) * k;
			if (x < 300 || y < 300 || x > c.width - 300 || y > c.height - 300) continue;
			const d = Math.hypot(x - c.width / 2, y - c.height / 2);
			if (!best || d < best.d) best = { d, id: st.id, wx: p.x, wy: p.y };
		}
		W.arm.picked = best; return best;
	},
	panUnbaked(x: number, y: number) {
		const o: any = overlayForPath("${PATH}");
		o.viewportPan.x = x; o.viewportPan.y = y; o.writeViewportPan();
		return { unbaked: !!o.rasterPanNeedsBake(), canvasMode: !!o.canvasMode };
	},
	commit(zoom: number) { const o: any = overlayForPath("${PATH}"); inLift.on = true; try { return !!o.commitCameraScale(zoom); } finally { inLift.on = false; } },
	sample(i: number, lastKey: string, every = false) {
		const o: any = overlayForPath("${PATH}"), st = o.standIn, cam = o.lastPaintCam, c = o.committedCanvas as HTMLCanvasElement;
		const line = document.querySelector(".cm-line") as HTMLElement | null, sd = document.querySelector(".cm-scroller") as HTMLElement | null;
		const lr = line?.getBoundingClientRect(), cr = c.getBoundingClientRect();
		const key = (st ? "S" : "-") + (o.extentBuild ? "B" : "-") + (o.extentRaster ? "E" : "-");
		const box = inkBox(o);
		const row: any = { t: Math.round(performance.now() * 10) / 10, key,
			standInRect: W.panBake.standInRect(), W: c.width, H: c.height, box,
			covers: box.n > 0 && box.x0 <= 2 && box.y0 <= 2 && box.x1 >= c.width - 3 && box.y1 >= c.height - 3,
			cam: cam ? { x: cam.x, y: cam.y, zoom: cam.zoom } : null, pan: { ...o.viewportPan }, cssScale: o.cssScale,
			canvasRect: { x: cr.left, y: cr.top, w: cr.width, h: cr.height }, canvasTransform: c.style.transform,
			line: lr ? { x: lr.left, y: lr.top, w: lr.width } : null, scroll: sd ? { top: sd.scrollTop, left: sd.scrollLeft } : null,
			bounce: !!o.bounceState };
		if (every || i % 2 === 0 || key !== lastKey) row.shift = shift(o);
		if ((every || i % 2 === 0 || key !== lastKey) && st) row.rectShift = rectShift(o, row.standInRect);
		if (i % 2 === 0 || key !== lastKey) {
			const pk = W.arm.picked;
			if (pk && cam) {
				const k = cam.zoom * o.committedBacking, px = (pk.wx - cam.x) * k, py = (pk.wy - cam.y) * k;
				const local = shift(o, { x: px, y: py }, 80);
				row.edge = !local ? null : local.winLayer === 0 ? { pathX: px, pathY: py, layerX: null, layerY: null, note: "no layer ink within 80 px of the start" }
					: { pathX: px, pathY: py, layerX: px - local.dx, layerY: py - local.dy, dx: local.dx, dy: local.dy, winLayer: local.winLayer, winPath: local.winPath };
			}
		}
		row.scrollState = scrollState();
		return row;
	},
};`;

let browser: Browser, script: string;
beforeAll(async () => {
	const b = await build({
		stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("./", import.meta.url)), sourcefile: "zoomOutStandInWiggleEntry.ts", loader: "ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1700,1000"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function run(zoom: number, live: boolean, every: boolean, fixture = CUT_FIXTURE): Promise<any[]> {
	const context = await browser.newContext({ viewport: null, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:17px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await page.evaluate(([z, s, id, w, h, n]) => (window as any).panBake.mount(z, s, id, w, h, n), [1.0, fixture, PAGE_ID, PANE.w, PANE.h, (JSON.parse(fixture).strokes as unknown[]).length] as const) as any;
		expect(mounted.strokes, "premise: every stroke loaded").toBe((JSON.parse(fixture).strokes as unknown[]).length);
		expect(mounted.canvasMode, "premise: Infinite Canvas on").toBe(true);
		expect(Math.abs(mounted.dpr - DSF), `premise: dpr ${DSF}`).toBeLessThan(0.01);
		await sleep(400);
		await page.evaluate(() => (window as any).panBake.awaitSharp());
		const pan = await page.evaluate(() => (window as any).arm.panUnbaked(-600, -500)) as any;
		expect(pan.unbaked, "premise: the pan is not baked when the zoom commits").toBe(true);
		await page.evaluate(() => (window as any).arm.instrument());
		if (live) await page.evaluate(() => (window as any).panBake.gate("bounce", true));
		const rows = await page.evaluate(async ([z, live, every]) => {
			const A = (window as any).arm, out: any[] = [];
			const t0 = performance.now();
			let key = "", ok = false, i = 0, sharpAt = -1;
			A.startClock();
			out.push({ phase: "before", ...A.sample(i++, key) });
			ok = A.commit(z);
			out.push({ phase: "picked", picked: A.pick() });
			out.push({ phase: "commit", ok, ...A.sample(i++, key, every) });
			if (live) setTimeout(() => (window as any).panBake.gate("bounce", false), 300);
			while (performance.now() - t0 < 8000) {
				await new Promise(r => requestAnimationFrame(() => r(null)));
				const r = A.sample(i++, key, every); key = r.key; r.ms = Math.round((r.t - t0) * 10) / 10; out.push(r);
				if (sharpAt < 0 && !r.key.startsWith("S") && !r.key.includes("B") && i > 3) sharpAt = performance.now();
				if (sharpAt > 0 && performance.now() - sharpAt > 2000) break;
			}
			return out;
		}, [zoom, live, every] as const) as any[];
		const events = await page.evaluate(() => (window as any).arm.events()) as any[];
		const armExits = await page.evaluate(() => (window as any).arm.armExits()) as any[];
		const wholePaints = await page.evaluate(() => (window as any).arm.wholePaints()) as any[];
		const probe = await page.evaluate(() => (window as any).arm.probe()) as string[];
		expect(errors).toEqual([]);
		return Object.assign(rows, { events, probe, armExits, wholePaints });
	} finally { await context.close(); }
}

function summary(rows: any[]) {
	const first = rows.find(r => r.phase === "before");
	const picked = rows.find(r => r.phase === "picked")?.picked ?? null;
	const after = rows.filter(r => r.ms !== undefined);
	const edges = after.filter(r => r.edge).map(r => ({ ms: r.ms, key: r.key, layerX: r.edge.layerX, layerY: r.edge.layerY, dx: r.edge.dx, dy: r.edge.dy, scroll: r.scrollState }));
	const firstWhole = after.find(r => r.covers);
	const lastStand = [...after].reverse().find(r => r.key.startsWith("S"));
	const firstSharp = after.find(r => !r.key.startsWith("S") && !r.key.includes("B"));
	const lineYs = after.map(r => r.line?.y).filter((v: any) => typeof v === "number");
	const canvasXs = after.map(r => r.canvasRect.x), canvasYs = after.map(r => r.canvasRect.y);
	const shifts = after.filter(r => r.shift).map(r => ({ ms: r.ms, key: r.key, dx: r.shift.dx, dy: r.shift.dy, lost: r.shift.lost, direct: r.shift.direct, extra: r.shift.extra, standInRect: r.standInRect, inRect: r.rectShift ?? null }));
	const changes: any[] = [];
	for (let k = 1; k < after.length; k++) {
		const a = after[k - 1], b = after[k];
		const d = (p: any, q: any) => (p === undefined || q === undefined || p === null || q === null) ? 0 : Math.abs(p - q);
		if (a.key !== b.key || d(a.line?.y, b.line?.y) > 0.01 || d(a.line?.x, b.line?.x) > 0.01 || d(a.canvasRect.x, b.canvasRect.x) > 0.01 || d(a.canvasRect.y, b.canvasRect.y) > 0.01
			|| d(a.cam?.x, b.cam?.x) > 1e-6 || d(a.cam?.y, b.cam?.y) > 1e-6 || a.canvasTransform !== b.canvasTransform || d(a.scroll?.top, b.scroll?.top) > 0 || d(a.scroll?.left, b.scroll?.left) > 0)
			changes.push({ ms: b.ms, key: `${a.key}>${b.key}`, line: b.line, canvas: b.canvasRect, transform: b.canvasTransform, cam: b.cam, pan: b.pan, scroll: b.scroll, covers: b.covers, box: b.box, standInRect: b.standInRect });
	}
	return {
		frames: after.length, before: { line: first.line, canvas: first.canvasRect, cam: first.cam },
		firstWholeMs: firstWhole ? firstWhole.ms : null, framesUntilWhole: firstWhole ? after.indexOf(firstWhole) + 1 : null,
		lastStandInMs: lastStand ? lastStand.ms : null, firstSharpMs: firstSharp ? firstSharp.ms : null,
		lineYRange: lineYs.length ? [Math.min(...lineYs), Math.max(...lineYs)] : null,
		canvasXRange: [Math.min(...canvasXs), Math.max(...canvasXs)], canvasYRange: [Math.min(...canvasYs), Math.max(...canvasYs)],
		picked, edges, shifts, changes, events: (rows as any).events, probe: (rows as any).probe, armExits: (rows as any).armExits, wholePaints: (rows as any).wholePaints,
	};
}

for (const zoom of [0.5, 0.302417]) {
	for (const live of [false, true]) {
		const gate = DSF === 2 && live;
		const name = `dpr ${DSF}, 100 to ${zoom}, pan unbaked, ${live ? "bounce over the commit, ends 300 ms later" : "nothing live"}${gate ? ": GATE, the stand-in placed inside its rect, then the crisp layer at the path draw" : ""}`;
		it(name, async () => {
			const rows = await run(zoom, live, gate);
			const s = summary(rows);
			console.log(`ARM ${name}\n${JSON.stringify(s)}`);
			if (OUT) {
				mkdirSync(OUT, { recursive: true });
				const tag = `dpr${DSF}-z${zoom}-${live ? "bounce" : "still"}`;
				writeFileSync(`${OUT}/rows-${tag}.json`, JSON.stringify(rows));
				writeFileSync(`${OUT}/summary-${tag}.json`, JSON.stringify(s, null, 1));
			}
			if (gate) {
				const commit = rows.find(r => r.phase === "commit");
				expect(commit?.ok, "premise: the zoom commit ran").toBe(true);
				const frames = [commit, ...rows.filter(r => r.ms !== undefined)];
				expect(frames.length, "premise: frames read after the commit").toBeGreaterThan(3);
				// At the lift the preview's partial picture stays where it sits, blank beyond it, until the crisp
				// raster fills in. While a stand-in is held and the path draw inks its rect, the picture inside the rect sits at the path
				// draw; from the first frame with no stand-in held on, the whole layer does. At 0.302417 the rect holds no path ink, so
				// that arm asserts the crisp frames only.
				const near = (q: any) => !!q && typeof q.dx === "number" && typeof q.dy === "number" && Math.hypot(q.dx, q.dy) < 0.25;
				// The commit row is read in the lift's own task, before any frame: the screen still shows the last preview frame, and the
				// stand-in is held but not yet copied. It asserts the stand-in held only; the rect check starts
				// at the first animation frame after the commit.
				expect(commit.key.startsWith("S"), "the commit row: the stand-in held").toBe(true);
				const firstCrisp = frames.findIndex(r => !r.key.startsWith("S"));
				expect(firstCrisp, "premise: a frame with no stand-in held").toBeGreaterThanOrEqual(0);
				const held = frames.slice(1, firstCrisp).filter(r => r.rectShift && r.rectShift.direct > 0);
				if (zoom === 0.5) expect(held.length, "premise: frames with the stand-in held and path ink in its rect").toBeGreaterThan(0);
				const badRect = held.filter(r => !(r.rectShift.lost < 0.01 * r.rectShift.direct) || !near(r.rectShift) || r.rectShift.atLimit !== false)
					.map(r => ({ ms: r.ms ?? "commit", key: r.key, inRect: r.rectShift, standInRect: r.standInRect }));
				expect(badRect, "every frame with the stand-in held and path ink in its rect: lost under 1 percent, shift under 0.25 device px, not at the search limit").toEqual([]);
				const badCrisp = frames.slice(firstCrisp).filter(r => !r.shift || r.shift.lost !== 0 || !near(r.shift))
					.map(r => ({ ms: r.ms ?? "commit", key: r.key, shift: r.shift && { dx: r.shift.dx, dy: r.shift.dy, lost: r.shift.lost, direct: r.shift.direct } }));
				expect(badCrisp, "from the first frame with no stand-in held: lost 0 and the layer's ink under 0.25 device px from the path draw").toEqual([]);
			}
		}, 180_000);
	}
}

// The whole note, over the raster cap at 0.5: no build, so no stand-in; the lift's own task paints the layer by path
// once, as commit 1 made it, bounce or not, and nothing paints by path on the bounce.
it.skipIf(DSF !== 2)(`dpr ${DSF}, 100 to 0.5, pan unbaked, bounce over the commit, ends 300 ms later, the whole note over the raster cap: GATE, one paint by path in the lift, the layer at the path draw from the commit`, async () => {
	const rows = await run(0.5, true, true, FULL);
	const s = summary(rows);
	console.log(`ARM over-cap
${JSON.stringify(s)}`);
	if (OUT) { mkdirSync(OUT, { recursive: true }); writeFileSync(`${OUT}/rows-dpr${DSF}-z0.5-bounce-overcap.json`, JSON.stringify(rows)); writeFileSync(`${OUT}/summary-dpr${DSF}-z0.5-bounce-overcap.json`, JSON.stringify(s, null, 1)); }
	const commit = rows.find(r => r.phase === "commit");
	expect(commit?.ok, "premise: the zoom commit ran").toBe(true);
	expect((rows as any).armExits.some((e: any) => e.rasterFits === false), `premise: the raster over the cap (${JSON.stringify((rows as any).armExits)})`).toBe(true);
	expect(commit.key.startsWith("S"), "the commit row: no stand-in held").toBe(false);
	const frames = [commit, ...rows.filter(r => r.ms !== undefined)];
	const bad = frames.filter(r => !r.shift || r.shift.lost !== 0 || !(Math.hypot(r.shift.dx, r.shift.dy) < 0.25))
		.map(r => ({ ms: r.ms ?? "commit", key: r.key, shift: r.shift && { dx: r.shift.dx, dy: r.shift.dy, lost: r.shift.lost, direct: r.shift.direct } }));
	expect(bad, "from the commit row on: lost 0 and the layer's ink under 0.25 device px from the path draw").toEqual([]);
	const wp = (rows as any).wholePaints as Array<{ pts: number; inLift: boolean; bounce: boolean }>, byPath = wp.filter(p => p.pts > 0);
	const seen = { byPath: byPath.length, inLift: byPath.filter(p => p.inLift).length, onBounce: byPath.filter(p => p.bounce && !p.inLift).length };
	expect(seen, `whole paints by path (${JSON.stringify(wp)})`).toEqual({ byPath: 1, inLift: 1, onBounce: 0 });
}, 180_000);
