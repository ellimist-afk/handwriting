/**
 * INK TILES AT 10%: independent acceptance for splitting each ink canvas into
 * tiles so no composited canvas is scaled past the GPU's texture limit.
 *
 * The defect: below 1.0 each ink canvas keeps a css box at the visual size and
 * a `scale(1/k)` of its own stretches it back over the band. On a 2,396 css px
 * pane at 10% that scaled extent is 30,360 layout px, and the compositor stops
 * drawing an accelerated canvas layer past 16,384 of them: the ink is in the
 * backing and the stroke is stored, but the screen is blank from 1,638 css px
 * in (the device report, right edge, wide window, 10% only). The rule the fix
 * has to meet: every composited ink canvas keeps its own counter-scale AND
 * its scaled extent stays under the limit on each axis, by tiling.
 *
 * Two panes. The 2,396 x 1,750 css px pane at device pixel ratio 1 is the
 * stress case the ruling names. The 945 x 834 css px pane at device pixel
 * ratio 2 is the device's real 10% geometry (window 1189 x 912, emulation
 * off) and is the case quoted to its user; the grid it needs is whatever the
 * band's layout size times the device pixel ratio says, read from the page,
 * never assumed.
 *
 * WHICH PIXELS THE LIMIT COUNTS (measured, aeed47ef, D3D11, MAX_TEXTURE_SIZE
 * 16384): on the stress pane at ratio 1 the sweep leaves the screen between
 * 1,624 and 1,683 css px from the pane's LEFT edge and between 1,614 and 1,656
 * from its TOP edge, i.e. 16,384 layout px from the visible origin on each
 * axis; on the device pane at ratio 2, whose band is 13,605 x 12,510 layout
 * px = 27,210 x 25,020 device px, nothing is clipped at all. The limit this
 * box applies is therefore in LAYOUT px, not device px, and it is measured
 * from the pane's visible origin. The file compares layout px and records the
 * device figure beside it. A device whose texture limit is smaller than this
 * box's would clip the same band sooner; that number is the device's to give.
 *
 * This file does not read the fix's own fields. It enumerates every canvas
 * inside the ink layer, groups them by on-screen rect (tile i of every layer
 * covers the same rect, so the distinct rects are the grid), and judges:
 *
 * - GEOMETRY: each canvas's scaled extent (css box times its own scale) under
 *   the limit on both axes; the grid covers the band; each canvas's compositor
 *   layer, read through the protocol, within the limit; five layers per tile.
 * - SWEEPS: a real pen (protocol input, `cdpPen.ts`) across the whole pane and
 *   down it, sampled from SCREENSHOT pixels, on screen to the edge, mid-contact
 *   and after the lift; every sample in the store.
 * - CORNER: a stroke 25 px from the far corner is claimed, stored, on screen.
 * - SEAMS: a stroke crossing each tile seam shows no gap on screen while the
 *   pen is down and after it lifts (skipped with the grid stated when the pane
 *   needs one tile).
 * - IDENTITY: at 20% on the default pane and at 100% there is one canvas per
 *   layer with the styles of the unsplit path, and a fixed synthetic shape
 *   hashes to the same raster as the recorded control (`HW_TILE_CONTROL`).
 *
 * On the parent of the fix, where the band's layout size passes the limit,
 * the geometry arm is red (one 30,360 px canvas per layer), the horizontal
 * sweep leaves the screen near 1,638 px, and the seam arm finds no seam. That
 * is the red-first reading this file exists to give.
 *
 * READBACKS COME LAST. A getImageData is a GPU readback, and after a few of
 * them Chromium takes the canvas off the GPU: the canvas is then painted into
 * its parent's content and has no compositor layer of its own, so the
 * texture-limit clip this file exists to detect no longer applies to it. The
 * first run of this file read every backing in full before the sweep and saw
 * no clip on the parent source. So: readings taken before a stroke or a
 * screenshot touch no backing, the screen is always sampled before the store,
 * and the raster hash is the identity arms' last call.
 *
 * GPU only for the pane arms: the clip is a fact of the D3D11 path and the
 * software compositor cannot lay this geometry out inside the budget, so they
 * run under HW_LAG_GPU=1 and are skipped with that reason otherwise. The
 * renderer string and MAX_TEXTURE_SIZE are recorded in every arm. Every
 * number asserted on is written to the JSON named by HW_TILE_REPORT (or
 * HW_LAG_REPORT); the console is not a record. Screenshot strips go to
 * HW_PINCHVIS_PNG_DIR when set.
 */

import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { chromium, type Browser, type Page, type CDPSession } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";
import { penStroke, linePoints } from "./cdpPen";
import { decodePng } from "./pngInk";

declare const process: { env: Record<string, string | undefined> };
let browser: Browser, script: string;
const GPU = process.env.HW_LAG_GPU === "1";
const HOST_LEFT = 300;
const FAR = 11482;
/** The stress pane the ruling names (device pixel ratio 1) and the device's real 10% pane (ratio 2). */
const PANES = [
	{ name: "stress", w: 2396, h: 1750, dpr: 1 },
	{ name: "device", w: 945, h: 834, dpr: 2 },
];
/**
 * The compositor's texture limit on the D3D11 path, the number the fix is
 * about, applied in LAYOUT px (see the file comment: measured, not assumed).
 */
const LIMIT = 16384;
const GPU_ARGS = ["--use-gl=angle", "--use-angle=d3d11", "--enable-gpu-rasterization", "--enable-zero-copy", "--ignore-gpu-blocklist", "--disable-software-rasterizer"];
const farHost = () => !!process.env.HW_DRAW_HOST_CSS;
const pngDir = process.env.HW_PINCHVIS_PNG_DIR;
const report: { gpu: boolean; host: boolean; arms: Record<string, unknown>[] } = { gpu: GPU, host: farHost(), arms: [] };
const control: { arms: Record<string, any>[] } | null = process.env.HW_TILE_CONTROL && existsSync(process.env.HW_TILE_CONTROL) ? JSON.parse(readFileSync(process.env.HW_TILE_CONTROL, "utf8")) : null;

beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./scrollColumnAnchorPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch(GPU ? { headless: true, args: GPU_ARGS } : { headless: true });
	if (pngDir) mkdirSync(pngDir, { recursive: true });
}, 180_000);

afterAll(async () => {
	await browser?.close();
	const out = process.env.HW_TILE_REPORT || process.env.HW_LAG_REPORT;
	if (out) writeFileSync(out, JSON.stringify(report, null, 1));
});

type Layer = { layerId: string; parentLayerId?: string; backendNodeId?: number; width: number; height: number; drawsContent: boolean; paintCount: number };
type Rig = { page: Page; cdp: CDPSession; errors: string[]; layers: () => Layer[]; geo: any };

const call = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(([f, xs]) => (window as any).scrollColumnAnchor[f as string](...(xs as unknown[])), [fn, args] as const);
/** A reading; `backing` false leaves every canvas untouched (no getImageData), for readings taken before a stroke or before a screenshot. */
const read = (page: Page, points: { label: string; x: number; y: number }[] = [], backing = true) => call(page, "runTileRead", points, backing) as Promise<any>;

/** A fresh page, the layer tree subscribed before the mount, the scene mounted at `zoom` on `pane` (default pane when null), far when asked.
 * `forceTransform` stubs `CSS.supports("zoom", ...)` to false before the bundle loads (same technique as `ZoomHostPreexistingZoom.test.ts`), so
 * the overlay's own `hostZoomSupported()` genuinely takes the fallback path - for proving the engineZoom/hostZoom pin, not for asserting the
 * fallback's shape (no coverage here). */
async function open(zoom: number, pane: { w: number; h: number } | null, far: number, dpr: number, forceTransform = false): Promise<Rig> {
	const w = pane?.w ?? 1397.5, h = pane?.h ?? 800;
	const page = await browser.newPage({ viewport: { width: Math.ceil(HOST_LEFT + w + 20), height: Math.ceil(h + 100) }, deviceScaleFactor: dpr });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(e.message));
	await page.setContent('<!doctype html><body style="margin:0"></body>');
	if (farHost()) await page.addStyleTag({ content: readFileSync(process.env.HW_DRAW_HOST_CSS!, "utf8") });
	await page.addStyleTag({ content: css + readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8") + REAL_OBSIDIAN_CSS });
	if (forceTransform) await page.evaluate(() => {
		const real = CSS.supports.bind(CSS);
		(CSS as unknown as { supports: typeof CSS.supports }).supports = (...a: Parameters<typeof CSS.supports>) => (typeof a[0] === "string" && a[0] === "zoom" ? false : real(...a));
	});
	await page.addScriptTag({ content: script });
	const cdp = await page.context().newCDPSession(page);
	let layers: Layer[] = [];
	cdp.on("LayerTree.layerTreeDidChange", (e: { layers?: Layer[] }) => { if (e.layers) layers = e.layers; });
	await cdp.send("DOM.enable"); await cdp.send("LayerTree.enable");
	const geo = await call(page, "runTileMount", zoom, far, pane, farHost());
	await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
	await page.waitForTimeout(250);
	return { page, cdp, errors, layers: () => layers, geo };
}

async function close(rig: Rig) {
	try { await call(rig.page, "runTileTeardown"); } catch { /* page gone */ }
	try { await rig.cdp.detach(); } catch { /* already detached */ }
	await rig.page.close();
}

/** Compositor layers matched to the tagged canvases by backend node id, plus the whole tree's count: one frame's layer picture. */
async function compositorSnapshot(rig: Rig, label: string) {
	const doc = await rig.cdp.send("DOM.getDocument", { depth: -1 });
	const { nodeIds } = await rig.cdp.send("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: "canvas[data-hw-tile-probe]" });
	const nodes: { index: number; backendNodeId: number }[] = [];
	for (const nodeId of nodeIds) {
		const d = await rig.cdp.send("DOM.describeNode", { nodeId });
		const attrs = d.node.attributes ?? [];
		nodes.push({ index: Number(attrs[attrs.indexOf("data-hw-tile-probe") + 1]), backendNodeId: d.node.backendNodeId });
	}
	const layers = rig.layers();
	const perCanvas = nodes.map(n => ({ index: n.index, layers: layers.filter(l => l.backendNodeId === n.backendNodeId).map(l => ({ id: l.layerId, width: l.width, height: l.height, draws: l.drawsContent, paints: l.paintCount })) }));
	const biggest = [...layers].sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 3).map(l => ({ id: l.layerId, node: l.backendNodeId ?? null, width: l.width, height: l.height, draws: l.drawsContent }));
	return { label, layerCount: layers.length, drawing: layers.filter(l => l.drawsContent).length, canvasLayers: perCanvas.reduce((n, p) => n + p.layers.length, 0), perCanvas, biggest };
}

/**
 * Ink on the SCREEN: a screenshot of `clip` (css px), decoded, and for each
 * point the count of device pixels in a 12 css px wide window across the
 * clip's other axis that differ from the clip's corner pixel by more than 40
 * in any channel. The corner is background: strips are centred on the stroke
 * line and start clear of its first point.
 */
async function screenSamples(page: Page, clip: { x: number; y: number; width: number; height: number }, points: { x: number; y: number }[], axis: "x" | "y", name: string) {
	const png = await page.screenshot({ clip, type: "png" });
	if (pngDir) writeFileSync(`${pngDir}/${name}.png`, png);
	const d = decodePng(new Uint8Array(png));
	const sx = d.width / clip.width, sy = d.height / clip.height;
	const bg = [d.px[0]!, d.px[1]!, d.px[2]!];
	const differs = (i: number) => Math.abs(d.px[i]! - bg[0]!) > 40 || Math.abs(d.px[i + 1]! - bg[1]!) > 40 || Math.abs(d.px[i + 2]! - bg[2]!) > 40;
	const counts = points.map(p => {
		let n = 0;
		if (axis === "x") {
			const cx = (p.x - clip.x) * sx;
			for (let yy = 0; yy < d.height; yy++) for (let xx = Math.max(0, Math.floor(cx - 6 * sx)); xx < Math.min(d.width, Math.ceil(cx + 6 * sx)); xx++) if (differs((yy * d.width + xx) * d.channels)) n++;
		} else {
			const cy = (p.y - clip.y) * sy;
			for (let yy = Math.max(0, Math.floor(cy - 6 * sy)); yy < Math.min(d.height, Math.ceil(cy + 6 * sy)); yy++) for (let xx = 0; xx < d.width; xx++) if (differs((yy * d.width + xx) * d.channels)) n++;
		}
		return n;
	});
	const firstOff = counts.findIndex((n, i) => i > 0 && n === 0);
	const lastOnIdx = counts.length - 1 - [...counts].reverse().findIndex(n => n > 0);
	return { counts, bg, firstOff: firstOff < 0 ? null : points[firstOff]!, lastOn: counts.some(n => n > 0) ? points[lastOnIdx]! : null, gaps: counts.filter((n, i) => n === 0 && i > 0 && i < counts.length - 1 && counts.slice(0, i).some(m => m > 0) && counts.slice(i + 1).some(m => m > 0)).length };
}

function liveness(r: any) {
	expect(r.gl, "WebGL available").not.toBeNull();
	if (GPU) expect(String(r.gl!.renderer), "a hardware renderer, not a software one").not.toMatch(/SwiftShader|Software|llvmpipe/i);
	expect(r.gl!.maxTexture, "the texture limit this file is about").toBeLessThanOrEqual(LIMIT);
	expect(r.rects.host, "host is the pane").toEqual(r.rects.pane);
}

const pen = (rig: Rig) => rig.cdp;
const gridOf = (r: any) => ({ cols: new Set(r.tiles.map((t: any) => t.l.toFixed(1))).size, rows: new Set(r.tiles.map((t: any) => t.t.toFixed(1))).size });
/** The grid the band needs: its layout size over the limit. `needDevice` is the same figure in device px, recorded only. */
const needOf = (r: any) => ({ cols: Math.ceil(r.containerCss.w / LIMIT), rows: Math.ceil(r.containerCss.h / LIMIT) });
const needDevice = (r: any) => ({ cols: Math.ceil(r.containerCss.w * r.dpr / LIMIT), rows: Math.ceil(r.containerCss.h * r.dpr / LIMIT) });
/** A canvas's scaled extent in device px: css box x its own scale x the device pixel ratio. */
const deviceExtent = (c: any, dpr: number) => ({ w: c.scaledExtent.w * dpr, h: c.scaledExtent.h * dpr });

for (const P of PANES) describe.skipIf(!GPU)(`ink tiles at 10% on the ${P.name} pane, ${P.w} x ${P.h} css px at device pixel ratio ${P.dpr} (skipped: needs HW_LAG_GPU=1, the D3D11 compositor is the regime and the software one cannot lay this out in the budget)`, () => {
	const size = { w: P.w, h: P.h };

	it("GEOMETRY: every ink canvas's scaled extent is under the texture limit on both axes, the tiles cover the band five layers deep, and each canvas's compositor layer is within the limit", async () => {
		const rig = await open(0.1, size, FAR, P.dpr);
		try {
			const r = rig.geo;
			const comp = await compositorSnapshot(rig, "mounted");
			const worst = { w: Math.max(...r.canvases.map((c: any) => c.scaledExtent.w)), h: Math.max(...r.canvases.map((c: any) => c.scaledExtent.h)) };
			const worstDevice = { w: worst.w * r.dpr, h: worst.h * r.dpr };
			const need = needOf(r), grid = gridOf(r);
			const area = r.tiles.reduce((n: number, t: any) => n + t.w * t.h, 0), bandArea = r.rects.container.w * r.rects.container.h;
			const layerWorst = Math.max(0, ...comp.perCanvas.flatMap(p => p.layers.flatMap(l => [l.width, l.height])));
			const rec = { arm: "geometry", pane: P, gl: r.gl, dpr: r.dpr, cssScale: r.cssScale, band: r.band, containerCss: r.containerCss, rects: r.rects, canvases: r.canvases.length, layersPerTile: r.layersPerTile, grid, need, tiles: r.tiles, seams: r.seams, worstLayoutExtent: worst, worstDeviceExtent: worstDevice, needDevice: needDevice(r), bandDevice: { w: r.containerCss.w * r.dpr, h: r.containerCss.h * r.dpr }, areaRatio: area / bandArea, reallocs: r.reallocs, compositor: comp, layerWorst, errors: rig.errors, styles: r.canvases.map((c: any) => ({ i: c.index, field: c.field, left: c.left, top: c.top, css: c.css, transform: c.transform, origin: c.origin, backing: c.backing, cssExtent: c.scaledExtent, deviceExtent: deviceExtent(c, r.dpr) })) };
			report.arms.push(rec);
			expect(rig.errors, `page errors: ${rig.errors.join(" | ")}`).toEqual([]);
			liveness(r);
			expect(r.dpr, "the device pixel ratio this pane is mounted at").toBe(P.dpr);
			expect(r.cssScale, "at 10%").toBeCloseTo(0.1, 6);
			expect(r.layersPerTile, "five layers, each with one canvas per tile").toBe(5);
			expect(grid.cols, `enough columns for the band's ${r.containerCss.w} layout px`).toBeGreaterThanOrEqual(need.cols);
			expect(grid.rows, `enough rows for the band's ${r.containerCss.h} layout px`).toBeGreaterThanOrEqual(need.rows);
			expect(area / bandArea, "the tiles cover the band once").toBeCloseTo(1, 2);
			for (const c of r.canvases) {
				expect.soft(c.scaledExtent.w, `canvas ${c.index} (${c.field ?? "tile"}) scaled width, layout px`).toBeLessThan(LIMIT);
				expect.soft(c.scaledExtent.h, `canvas ${c.index} (${c.field ?? "tile"}) scaled height, layout px`).toBeLessThan(LIMIT);
				expect.soft(c.ownScale, `canvas ${c.index} carries its own counter-scale`).toBeCloseTo(10, 3);
			}
			expect(worst.w, "the widest scaled extent, layout px").toBeLessThan(LIMIT);
			expect(worst.h, "the tallest scaled extent, layout px").toBeLessThan(LIMIT);
			for (const p of comp.perCanvas) for (const l of p.layers) {
				expect.soft(l.width, `canvas ${p.index} compositor layer width`).toBeLessThanOrEqual(LIMIT);
				expect.soft(l.height, `canvas ${p.index} compositor layer height`).toBeLessThanOrEqual(LIMIT);
			}
		} finally { await close(rig); }
	}, 240_000);

	it("HORIZONTAL SWEEP: a pen stroke across the whole pane is on screen to the right edge, mid-contact and after the lift, and in the store at every sample", async () => {
		const rig = await open(0.1, size, FAR, P.dpr);
		try {
			const pr = rig.geo.rects.pane;
			const y = Math.round(pr.t + pr.h * 0.5 - 120);
			const from = { x: Math.round(pr.l + 100), y }, to = { x: Math.round(pr.r - 10), y };
			const strip = { x: Math.round(pr.l), y: y - 8, width: Math.round(pr.w), height: 16 };
			const samples = Array.from({ length: 40 }, (_, i) => ({ label: `s${i}`, x: from.x + Math.round((to.x - from.x) * i / 39), y }));
			const pre = await read(rig.page, [], false);
			const midComp0 = await compositorSnapshot(rig, "before");
			let mid: any = null, midComp: any = null;
			await penStroke(pen(rig), linePoints(from, to, 40), { between: async i => { if (i === 32) { await rig.page.waitForTimeout(60); mid = await screenSamples(rig.page, strip, samples.filter(s => s.x <= from.x + (to.x - from.x) * 31 / 40), "x", `${P.name}-hsweep-mid`); midComp = await compositorSnapshot(rig, "mid-contact"); } } });
			await rig.page.waitForTimeout(250);
			const screen = await screenSamples(rig.page, strip, samples, "x", `${P.name}-hsweep-lifted`);
			const comp = await compositorSnapshot(rig, "lifted");
			const post = await read(rig.page, samples);
			const backing = post.hits.map((h: any) => h.backing.pixels);
			const rec = { arm: "hsweep", pane: P, gl: post.gl, from, to, samplesX: samples.map(s => s.x), screen, mid, backing, tilesHit: post.hits.map((h: any) => h.backing.tiles), strokes: post.strokes - pre.strokes, claimed: post.acq.claimed - pre.acq.claimed, offFromPaneLeft: screen.firstOff ? screen.firstOff.x - pr.l : null, midOffFromPaneLeft: mid?.firstOff ? mid.firstOff.x - pr.l : null, compositor: { before: midComp0, mid: midComp, lifted: comp }, reallocs: post.reallocs, errors: rig.errors };
			report.arms.push(rec);
			expect(rig.errors, `page errors: ${rig.errors.join(" | ")}`).toEqual([]);
			liveness(post);
			expect(rec.strokes, "the sweep stored").toBe(1);
			expect(rec.claimed, "the sweep claimed").toBe(1);
			expect(backing.every((n: number) => n > 0), `the sweep is in the store at every sample: ${backing.join(",")}`).toBe(true);
			expect(mid, "a mid-contact reading was taken").not.toBeNull();
			// The wet ribbon at ratio 1 sits under the colour threshold along most of its length while the pen is down (measured:
			// only the samples nearest the pen read as ink), so the mid-contact claim is about the five samples nearest the pen,
			// which on the stress pane straddle the parent's clip.
			expect(mid.counts.slice(-5).every((n: number) => n > 0), `mid-contact: the ink nearest the pen is on screen (${mid.counts.join(",")})`).toBe(true);
			expect(screen.firstOff, `after the lift: on screen to the end (${screen.counts.join(",")})`).toBeNull();
			expect(screen.counts.every(n => n > 0), "every sample on screen").toBe(true);
		} finally { await close(rig); }
	}, 240_000);

	it("VERTICAL SWEEP: a pen stroke down the pane near its right edge is on screen to the bottom edge and in the store at every sample", async () => {
		const rig = await open(0.1, size, FAR, P.dpr);
		try {
			const pr = rig.geo.rects.pane;
			const x = Math.round(pr.l + Math.min(2000, pr.w * 0.85));
			const from = { x, y: Math.round(pr.t + 100) }, to = { x, y: Math.round(pr.b - 10) };
			const strip = { x: x - 8, y: Math.round(pr.t), width: 16, height: Math.round(pr.h) };
			const samples = Array.from({ length: 40 }, (_, i) => ({ label: `s${i}`, x, y: from.y + Math.round((to.y - from.y) * i / 39) }));
			const pre = await read(rig.page, [], false);
			await penStroke(pen(rig), linePoints(from, to, 40));
			await rig.page.waitForTimeout(250);
			const screen = await screenSamples(rig.page, strip, samples, "y", `${P.name}-vsweep-lifted`);
			const post = await read(rig.page, samples);
			const backing = post.hits.map((h: any) => h.backing.pixels);
			const rec = { arm: "vsweep", pane: P, gl: post.gl, from, to, xFromPaneLeft: x - pr.l, samplesY: samples.map(s => s.y), screen, backing, tilesHit: post.hits.map((h: any) => h.backing.tiles), strokes: post.strokes - pre.strokes, claimed: post.acq.claimed - pre.acq.claimed, offFromPaneTop: screen.firstOff ? screen.firstOff.y - pr.t : null, reallocs: post.reallocs, errors: rig.errors };
			report.arms.push(rec);
			expect(rig.errors, `page errors: ${rig.errors.join(" | ")}`).toEqual([]);
			liveness(post);
			expect(rec.strokes, "the sweep stored").toBe(1);
			expect(rec.claimed, "the sweep claimed").toBe(1);
			expect(backing.every((n: number) => n > 0), `in the store at every sample: ${backing.join(",")}`).toBe(true);
			expect(screen.firstOff, `on screen to the bottom (${screen.counts.join(",")})`).toBeNull();
			expect(screen.counts.every(n => n > 0), "every sample on screen").toBe(true);
		} finally { await close(rig); }
	}, 240_000);

	it("CORNER: a stroke starting 25 px from the far corner is claimed, stored, and on screen", async () => {
		const rig = await open(0.1, size, FAR, P.dpr);
		try {
			const pr = rig.geo.rects.pane;
			const from = { x: Math.round(pr.r - 25), y: Math.round(pr.b - 25) }, to = { x: from.x + 15, y: from.y + 6 };
			const midPoint = { label: "mid", x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) };
			const pre = await read(rig.page, [midPoint], false);
			await penStroke(pen(rig), linePoints(from, to, 8));
			await rig.page.waitForTimeout(250);
			const clip = { x: from.x - 20, y: from.y - 20, width: 44, height: 44 };
			const screen = await screenSamples(rig.page, clip, [midPoint], "x", `${P.name}-corner`);
			const post = await read(rig.page, [midPoint]);
			const rec = { arm: "corner", pane: P, from, to, inScroller: pre.hits[0].inScroller, target: pre.hits[0].target, claimed: post.acq.claimed - pre.acq.claimed, strokes: post.strokes - pre.strokes, backing: post.hits[0].backing, screen, errors: rig.errors };
			report.arms.push(rec);
			expect(rig.errors, `page errors: ${rig.errors.join(" | ")}`).toEqual([]);
			expect(rec.inScroller, "the corner is on the scroller's path").toBe(true);
			expect(rec.claimed, "corner contact claimed").toBe(1);
			expect(rec.strokes, "corner stroke stored").toBe(1);
			expect(rec.backing.pixels, "corner ink in the store").toBeGreaterThan(0);
			expect(screen.counts[0], "corner ink on screen").toBeGreaterThan(0);
		} finally { await close(rig); }
	}, 240_000);

	it("SEAMS: a stroke crossing each tile seam shows no gap on screen while the pen is down and after it lifts", async () => {
		const rig = await open(0.1, size, FAR, P.dpr);
		try {
			const g = rig.geo, pr = g.rects.pane;
			const need = needOf(g), grid = gridOf(g);
			const seamsX: number[] = g.seams.x.filter((x: number) => x > pr.l + 200 && x < pr.r - 200);
			const seamsY: number[] = g.seams.y.filter((y: number) => y > pr.t + 200 && y < pr.b - 200);
			const rec: any = { arm: "seams", pane: P, tiles: g.tiles, grid, need, seams: g.seams, inPane: { x: seamsX, y: seamsY }, crossings: [] as any[], errors: rig.errors };
			report.arms.push(rec);
			expect(rig.errors, `page errors: ${rig.errors.join(" | ")}`).toEqual([]);
			liveness(g);
			if (need.cols === 1 && need.rows === 1) {
				// The band fits one tile on this pane: there is no seam to cross. Recorded, not judged.
				rec.skipped = `one tile suffices (band ${g.containerCss.w} x ${g.containerCss.h} layout px, ${g.containerCss.w * g.dpr} x ${g.containerCss.h * g.dpr} device px); grid found ${grid.cols} x ${grid.rows}`;
				expect(grid, "one tile on a pane that needs one").toEqual({ cols: 1, rows: 1 });
				return;
			}
			if (need.cols > 1) expect(seamsX.length, `a vertical seam inside the pane (tiles: ${JSON.stringify(g.tiles)})`).toBeGreaterThan(0);
			if (need.rows > 1) expect(seamsY.length, `a horizontal seam inside the pane (tiles: ${JSON.stringify(g.tiles)})`).toBeGreaterThan(0);
			let n = 0;
			for (const sx of seamsX) {
				const y = Math.round(pr.t + pr.h * 0.5 + 200 + 40 * n++);
				const from = { x: Math.round(sx - 150), y }, to = { x: Math.round(sx + 150), y };
				const strip = { x: Math.round(sx - 100), y: y - 8, width: 200, height: 16 };
				const across = Array.from({ length: 17 }, (_, i) => ({ x: Math.round(sx - 80 + 10 * i), y }));
				let mid: any = null;
				await penStroke(pen(rig), linePoints(from, to, 30), { between: async i => { if (i === 23) { await rig.page.waitForTimeout(60); mid = await screenSamples(rig.page, strip, across.filter(p => p.x <= sx + 60), "x", `${P.name}-seam-x${Math.round(sx - pr.l)}-mid`); } } });
				await rig.page.waitForTimeout(250);
				const lifted = await screenSamples(rig.page, strip, across, "x", `${P.name}-seam-x${Math.round(sx - pr.l)}-lifted`);
				const post = await read(rig.page, across.map((p, i) => ({ label: `a${i}`, ...p })));
				rec.crossings.push({ axis: "x", seamFromPaneLeft: sx - pr.l, from, to, mid, lifted, backing: post.hits.map((h: any) => h.backing) });
				expect(mid, "a mid-contact reading was taken").not.toBeNull();
				expect(mid.counts.every((c: number) => c > 0), `mid-contact across the seam at ${Math.round(sx - pr.l)} px: ${mid.counts.join(",")}`).toBe(true);
				expect(lifted.counts.every(c => c > 0), `after the lift across the seam at ${Math.round(sx - pr.l)} px: ${lifted.counts.join(",")}`).toBe(true);
				expect(post.hits.every((h: any) => h.backing.pixels > 0), "in the store on both sides").toBe(true);
			}
			for (const sy of seamsY) {
				const x = Math.round(pr.l + pr.w * 0.8 + 40 * n++);
				const from = { x, y: Math.round(sy - 150) }, to = { x, y: Math.round(sy + 150) };
				const strip = { x: x - 8, y: Math.round(sy - 100), width: 16, height: 200 };
				const across = Array.from({ length: 17 }, (_, i) => ({ x, y: Math.round(sy - 80 + 10 * i) }));
				let mid: any = null;
				await penStroke(pen(rig), linePoints(from, to, 30), { between: async i => { if (i === 23) { await rig.page.waitForTimeout(60); mid = await screenSamples(rig.page, strip, across.filter(p => p.y <= sy + 60), "y", `${P.name}-seam-y${Math.round(sy - pr.t)}-mid`); } } });
				await rig.page.waitForTimeout(250);
				const lifted = await screenSamples(rig.page, strip, across, "y", `${P.name}-seam-y${Math.round(sy - pr.t)}-lifted`);
				const post = await read(rig.page, across.map((p, i) => ({ label: `a${i}`, ...p })));
				rec.crossings.push({ axis: "y", seamFromPaneTop: sy - pr.t, from, to, mid, lifted, backing: post.hits.map((h: any) => h.backing) });
				expect(mid, "a mid-contact reading was taken").not.toBeNull();
				expect(mid.counts.every((c: number) => c > 0), `mid-contact across the seam at ${Math.round(sy - pr.t)} px: ${mid.counts.join(",")}`).toBe(true);
				expect(lifted.counts.every(c => c > 0), `after the lift across the seam at ${Math.round(sy - pr.t)} px: ${lifted.counts.join(",")}`).toBe(true);
				expect(post.hits.every((h: any) => h.backing.pixels > 0), "in the store on both sides").toBe(true);
			}
			rec.compositor = await compositorSnapshot(rig, "after-seams");
		} finally { await close(rig); }
	}, 300_000);
});

// Harness engine supports CSS zoom; hostZoom pinned true; the transform
// fallback in applyViewportBox has no harness coverage (same pin as
// ScrollExpansion.test.ts:52-53 / scrollExpansionPage.ts:98). The style/width
// asserts below are for that one form only, not "host-form-aware" - there is
// no live branch, because the fallback form is unreachable here.
/**
 * IDENTITY AWAY FROM THE LIMIT: the unsplit path must be the one that runs.
 * One canvas per layer, the styles the single-canvas box gives, and a fixed
 * synthetic shape's raster hash equal to the control's when a control JSON
 * from the parent source is named by HW_TILE_CONTROL. The hash is the last
 * call on the page (a readback; see the file comment).
 */
for (const zoom of [0.2, 1]) it(`IDENTITY at ${zoom * 100}% on the default pane: one canvas per layer with the single-canvas styles, and the fixed shape's raster hashes as the control's`, async () => {
	const rig = await open(zoom, null, 0, 2);
	try {
		const r = await call(rig.page, "runTileDraw", null, 200, 881) as any;
		const hashes = await call(rig.page, "runTileHash") as string[];
		const committed = r.canvases.find((c: any) => c.field === "committedCanvas");
		const rec = { arm: `identity-${zoom}`, cssScale: r.cssScale, canvases: r.canvases.length, tiles: r.tiles.length, styles: r.canvases.map((c: any) => ({ field: c.field, left: c.left, top: c.top, css: c.css, transform: c.transform, origin: c.origin, backing: c.backing })), containerCss: r.containerCss, rasterHashes: hashes, committedHash: committed ? hashes[committed.index] : null, strokes: r.strokes, reallocs: r.reallocs, errors: rig.errors };
		report.arms.push(rec);
		expect(rig.errors, `page errors: ${rig.errors.join(" | ")}`).toEqual([]);
		// The pin, checked before any host-form-specific shape assert below: the
		// harness engine actually supports css zoom, and the overlay's own gate
		// agrees. A run where either is false is a different host form (no
		// coverage here) and the asserts past this point are not
		// claimed for it - see the file header and the stubbed-engine cell below.
		expect(r.engineZoom, "the harness engine supports css zoom").toBe(true);
		expect(r.hostZoom, "the overlay's host-form gate agrees with the engine").toBe(r.engineZoom);
		// REVISED 2026-09-14 (Z8 class): cssScale is MEASURED BACK on the zoom
		// host as the container's rect width over its offset width - the rect
		// is the host's zoomed layout box snapped to 1/64 css px, the offset
		// width is the unzoomed layout width rounded to an integer, so the
		// measurement sits within one part in that integer of the request. A
		// fixed digit count was a claim about the engine's grid, not about what
		// the commit actually settled at. Same derivation and field as
		// LagAtLowZoom's :335 fix (fd04036e).
		expect(r.containerOffsetWidth, "the read carries the container's offset width").toBeGreaterThan(0);
		expect(Math.abs(r.cssScale - zoom), `at ${zoom} within the measurement's own bound, 2 x ${zoom} / ${r.containerOffsetWidth}`).toBeLessThanOrEqual(2 * zoom / r.containerOffsetWidth);
		expect(r.strokes, "the shape stored").toBeGreaterThan(0);
		expect(r.canvases.length, "five layers and the wet tile").toBe(6);
		// The four band layers share one box; the live tail and the wet tile
		// have their own compact backings and are read apart.
		const bandLayers = r.canvases.filter((c: any) => c.field !== "tailCanvas" && c.field !== "wetTileCanvas");
		const wetTile = r.canvases.find((c: any) => c.field === "wetTileCanvas");
		expect(wetTile, "the wet tile canvas is read").toBeTruthy();
		expect(wetTile.backing.w * wetTile.backing.h, "the wet tile is smaller than the band").toBeLessThan(committed.backing.w * committed.backing.h);
		expect(bandLayers.length, "four band layers").toBe(4);
		expect(new Set(bandLayers.map((c: any) => c.rectKey)).size, "one tile").toBe(1);
		const tail = r.canvases.find((c: any) => c.field === "tailCanvas"), t = r.tailBacking;
		expect(tail, "the tail canvas is read").toBeTruthy();
		expect(t, "the tail's own backing is read").toBeTruthy();
		if (t.grid) {
			const side = Math.ceil(256 * t.backing / t.grid) * t.grid;
			const tile = { w: Math.min(side, Math.floor(t.fullW / t.grid) * t.grid), h: Math.min(side, Math.floor(t.fullH / t.grid) * t.grid) };
			expect({ w: tail.backing.w, h: tail.backing.h }, "the tail is the tile, 256 css px on the joint grid").toEqual(tile);
			expect(tile.w * tile.h, "the tile is smaller than the band").toBeLessThan(committed.backing.w * committed.backing.h);
			for (const v of [t.originX, t.originY]) expect(v % t.grid, "the tile origin is on the grid").toBe(0);
		} else {
			expect({ w: tail.backing.w, h: tail.backing.h }, "no joint grid: the tail keeps the full band").toEqual({ w: committed.backing.w, h: committed.backing.h });
		}
		for (const [lo, hi, tlo, thi] of [[committed.rect.l, committed.rect.r, tail.rect.l, tail.rect.r], [committed.rect.t, committed.rect.b, tail.rect.t, tail.rect.b]] as [number, number, number, number][])
			expect(tlo >= lo - 0.01 && thi <= hi + 0.01, `the tail ${tlo}..${thi} is inside the band ${lo}..${hi}`).toBe(true);
		for (const c of bandLayers) {
			// Under the zoom host, canvasLayerBox(..., hostZoom=true) returns no
			// transform and the unscaled band box (ZoomScale.ts, d2c03af1): the
			// counter-scale shape below was the transform-host's, and that
			// fallback branch has no coverage in this harness - it
			// is unreachable here, not asserted for.
			expect.soft(c.transform, `${c.field} transform`).toBe("");
			expect.soft(["", "0px"], `${c.field} left is the single-canvas box's`).toContain(c.left);
			expect.soft(["", "0px"], `${c.field} top is the single-canvas box's`).toContain(c.top);
			// REVISED 2026-09-14 (D1): compared against `containerOffsetWidth`, the
			// exact same `container.offsetWidth` production reads as `layoutW`
			// (InkOverlay.ts:3188), not the separately-measured `containerCss.w` -
			// so the only real difference left is computeCanvasSize's own backing
			// rounding (Raster.ts:39-45: cssW = round(cssWidth*backing)/backing).
			// That identity gives an EXACT bound, 0.5*css.w/backing.w, measured
			// from this canvas's own actual backing store rather than assumed
			// from a flat digit count (the old `toBeCloseTo(_, 0)` passed by only
			// 0.06 px here and can exceed 0.5 at other offsetWidth/backing pairs).
			if (zoom < 1) {
				// +1e-9: an exact half-integer tie in cssWidth*backing can resolve
				// either way in float rounding vs. the bound's own arithmetic: a
				// closeness claim, not an exactness one (E7).
				const bound = 0.5 * c.css.w / c.backing.w + 1e-9;
				expect.soft(Math.abs(c.css.w - r.containerOffsetWidth), `${c.field} css width vs the container's offset width, within the backing-store rounding bound 0.5 * css.w / backing.w (+1e-9 tie slack) = ${bound}`).toBeLessThanOrEqual(bound);
			}
		}
		expect(committed, "the committed canvas is tile 0 of its layer").toBeTruthy();
		const ctl = control?.arms.find(a => a.arm === rec.arm);
		if (ctl) {
			expect(rec.styles, "the DOM styles equal the control's").toEqual(ctl.styles);
			expect(rec.committedHash, "the committed raster equals the control's").toBe(ctl.committedHash);
		}
	} finally { await close(rig); }
}, 240_000);

/**
 * THE PIN CAN FAIL: prove `engineZoom`/`hostZoom` actually catch the wrong
 * host form, before the shape asserts above ever run into it as 10 confusing
 * soft reds (5 canvases x transform + css.w). Stubs the engine to disagree
 * with itself the way `ZoomHostPreexistingZoom.test.ts` does; does not assert
 * the fallback's own shape (no harness coverage) - only that the
 * disagreement the pin exists to catch is real and measured, not assumed.
 */
it("IDENTITY at 20%: under a stubbed non-zoom engine, the pin catches it before the shape asserts would", async () => {
	const rig = await open(0.2, null, 0, 2, true);
	try {
		const r = await call(rig.page, "runTileDraw", null, 200, 881) as any;
		expect(rig.errors, `page errors: ${rig.errors.join(" | ")}`).toEqual([]);
		expect(r.engineZoom, "the stub took: the harness engine no longer reports css zoom support").toBe(false);
		expect(r.hostZoom, "production's own gate agrees with the stub: it took the transform-fallback path for real").toBe(false);
		// Downstream of the pin, measured rather than assumed: this is exactly
		// what would have reddened, one soft assert per canvas per check, had
		// the pin not stopped the arm first (5 canvases: committedCanvas,
		// wetCanvas, tailCanvas, highlightCanvas, highlightWetCanvas; the wet
		// tile has its own box and is not one of them).
		const five = r.canvases.filter((c: any) => c.field !== "wetTileCanvas");
		const transformMismatches = five.filter((c: any) => c.transform !== "").length;
		expect(transformMismatches, "every canvas actually carries the fallback's own scale transform here").toBe(5);
		const cssMismatches = five.filter((c: any) => Math.abs(c.css.w - r.containerCss.w) > 0.5).length;
		expect(cssMismatches, "every canvas's css width is the fallback's counter-sized one here, not the unscaled band box").toBe(5);
	} finally { await close(rig); }
}, 240_000);
