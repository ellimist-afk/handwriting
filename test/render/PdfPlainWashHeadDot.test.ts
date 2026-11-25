/**
 * A highlighter held on a PDF page: across the tip's start the live stroke reads as its trail (no darker dot), and a
 * page whose highlights have a layer of their own keeps today's pixels there.
 *
 * Before F1 a page read as dark (a page drawn dark, the app's dark pages, or the reader's "Lighten for dark pages"
 * setting) had no layer of its own, and the live pair wore the wash itself: the wet canvas and the head canvas each took
 * the 0.35 opacity (PdfInkCommit.ts dressWet), so the strip's end disc under the tip's round back end was washed twice,
 * as on a note (NoteHighlighterHeadDot.test.ts). Since F1 every PDF page is layered: the pair sits at full opacity
 * inside the highlight group, which carries the wash once (blending normal on a page read as dark): no dot, and the cut
 * must never run there (a cut inside the group leaves a seam about 21 levels lighter).
 *
 * THE PAGE: the PDF page stand-in (pdfHighlightPage.ts), white paper, device scale 1. The highlighter (#ffd60a) is held
 * through the controller's own pen callbacks, 20 px a sample, one a frame, and not lifted. The tip is placed by the
 * page's camera (PdfInkPenPath.ts cameraFor), from the wet renderer's last ribbon point and head.
 *
 * CELL: "Lighten for dark pages" ("lighten"), a page read as dark, under the bound of d3Bound.ts (red first on the plain
 * route before F1; since F1 it holds on the layered route, the group blending normal).
 * GUARDS: a layered page ("darken"), every pixel across the join within 2 of the trail, every
 * pixel recorded, and within 2 of the 685ce486 record when HW_D3_LAYERED_BASE names it; the same page flipped to the dark
 * answer mid-stroke with no dressing of the pair (the pair still sits in the group at full opacity, so
 * a cut gated on a fresh read of the answer would run inside the group; since F1 the group then blends normal).
 *
 * HW_D3_HEAD_EVIDENCE=<dir> writes each screenshot and record there.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/PdfPlainWashHeadDot.test.ts
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { launch, stylesCss } from "./harness";
import type {} from "./pdfHighlightPage";
import type { Pt, RGB } from "./penMarks";
import { behind, boundStats, boxOf, expectBound, expectPlaced, gap, placedOf, placedRecord, readPx, white, type Px } from "./d3Bound";
declare const process: { env: Record<string, string | undefined> };

let browser: Browser, bundle: string;
beforeAll(async () => {
	const result = await build({
		entryPoints: [fileURLToPath(new URL("./pdfHighlightPage.ts", import.meta.url))],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) },
	});
	bundle = result.outputFiles[0]!.text;
	browser = await launch();
}, 180_000);
afterAll(async () => {
	await browser?.close();
});

const A = 0.35;
const yellow: RGB = [255, 214, 10];
const plainWash = (b: RGB) => b.map((v, i) => v * (1 - A) + A * yellow[i]!) as RGB;
const LEVEL: Pt = { x: 1, y: 0 };
/** A page screenshot, typed from playwright itself: the render tsconfig has no node types, so no `Buffer` by name. */
type Png = Awaited<ReturnType<Page["screenshot"]>>;

async function openPdf(assumption: "darken" | "lighten", errors: string[]): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 700, height: 900 }, deviceScaleFactor: 1 });
	page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
	page.on("console", (m) => console.log(`page: ${m.text()}`));
	await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
	await page.addStyleTag({ content: stylesCss() });
	await page.addScriptTag({ content: bundle });
	await page.evaluate((a) => window.pdfHighlight.open(false, a), assumption);
	return page;
}

function keep(name: string, png: Png, record: unknown): void {
	const directory = process.env.HW_D3_HEAD_EVIDENCE;
	if (!directory) return;
	writeFileSync(join(directory, `${name}.png`), png);
	writeFileSync(join(directory, `${name}.json`), JSON.stringify(record, null, 1));
}

/**
 * Place the held tip by the page's camera and read the screenshot under the bound; the paper and trail by name. The same
 * frame is shot again with the head canvas hidden (the strip alone), then the head canvas shown again.
 */
async function readHeld(page: Page, paperAt: Pt) {
	const raw = await page.evaluate(() => window.pdfHighlight.place());
	const placed = raw ? placedOf(raw, LEVEL) : null;
	const trailAt = placed ? behind(placed, placed.hw + 60) : paperAt;
	const layers = await page.evaluate(() => window.pdfHighlight.layers());
	const png = await page.screenshot({ scale: "css" });
	const hidden = await page.evaluate(() => window.pdfHighlight.tailHidden(true));
	const pngAlone = await page.screenshot({ scale: "css" });
	const shown = await page.evaluate(() => window.pdfHighlight.tailHidden(false));
	const b64 = png.toString("base64"), b64Alone = pngAlone.toString("base64");
	const s = await page.evaluate(({ b64, points }) => window.pdfHighlight.sample(b64, { x: 0, y: 0 }, points, 1), { b64, points: { trail: trailAt, paper: paperAt } });
	let px: Px[] = [];
	if (placed) {
		const bx = boxOf(placed, 1);
		const region = (b: string) => page.evaluate(({ b64, bx }) => window.pdfHighlight.region(b64, bx.x0, bx.y0, bx.w, bx.h), { b64: b, bx });
		const data = await region(b64), alone = await region(b64Alone);
		px = readPx({ data, alone, ...bx, k: 1 }, placed, 2);
	}
	return { raw, placed, layers, png, pngAlone, trail: s.trail!, paper: s.paper!, trailAt, px, stats: boundStats(px, s.trail!), tail: { hidden, shown } };
}

const Y = 560, X0 = 140, X1 = 420, PAPER: Pt = { x: 380, y: 700 };

it("D3 PDF, Lighten for dark pages: a highlighter held, level, 20 px a sample, the pair in a group that blends normal: across the tip's start the bound holds (no darker dot)", async () => {
	const errors: string[] = [];
	const page = await openPdf("lighten", errors);
	try {
		await page.evaluate(([a, b]) => window.pdfHighlight.hold("highlighter", a, b), [{ x: X0, y: Y }, { x: X1, y: Y }] as const);
		const rd = await readHeld(page, PAPER);
		await page.evaluate(() => window.pdfHighlight.lift());
		const washed = rd.layers.filter((l) => l.tag === "canvas" && Number(l.opacity) === A).length;
		const groupNormal = rd.layers.filter((l) => l.tag !== "canvas" && Number(l.opacity) === A && l.blend === "normal").length;
		const pairFull = rd.layers.filter((l) => l.tag === "canvas" && l.parent !== "page" && Number(l.opacity) === 1).length;
		const record = { raw: rd.raw, placed: placedRecord(rd.placed), layers: rd.layers, washed, groupNormal, pairFull, trailAt: rd.trailAt, trail: rd.trail, paper: rd.paper,
			stats: rd.stats, tail: rd.tail, plainWash: plainWash(white), errors };
		const brief = JSON.stringify(record);
		console.log(`D3_HEAD pdf-plain ${brief}`);
		keep("d3-pdf-plain-held", rd.png, record);
		keep("d3-pdf-plain-held-strip-alone", rd.pngAlone, { cell: "pdf-plain-held", tail: rd.tail });
		expect(errors, brief).toEqual([]);
		// PREMISES: a page read as dark is layered too (F1): a group at the wash blending normal, the live pair at full opacity
		// inside it, placed by the camera, white paper, a trail of the one plain wash.
		expect(rd.raw?.layered, `premise: the page has a highlight layer (${brief})`).toBe(true);
		expect(groupNormal, `premise: a highlight group at ${A} blends normal while the stroke is held (${brief})`).toBeGreaterThanOrEqual(1);
		expect(pairFull, `premise: the live pair sits in the group at full opacity (${brief})`).toBeGreaterThanOrEqual(2);
		expect(washed, `premise: no ink canvas wears the wash itself (${brief})`).toBe(0);
		expectPlaced(rd.placed, brief);
		expect(gap(rd.paper, white), `premise: the paper reads white ${rd.paper}`).toBeLessThanOrEqual(2);
		expect(gap(rd.trail, plainWash(white)), `premise: the trail is the one plain wash ${rd.trail} against ${plainWash(white)}`).toBeLessThanOrEqual(3);
		expect(rd.stats.count, `premise: pixels under the bound (${brief})`).toBeGreaterThanOrEqual(50);
		expect(rd.tail, `premise: the strip-alone shot had the head canvas hidden, and it was shown again (${brief})`).toEqual({ hidden: "hidden", shown: "visible" });
		expectBound(rd.stats, rd.trail, "D3 pdf-plain");
	} finally {
		await page.close();
	}
}, 120_000);

/** A layered page's read: the premises of the layered route, then every pixel across the join within 2 of the trail and of the 685ce486 record. */
async function layeredGuard(name: string, flip: boolean): Promise<void> {
	const errors: string[] = [];
	const page = await openPdf("darken", errors);
	try {
		const firstTo = flip ? { x: 300, y: Y } : { x: X1, y: Y };
		await page.evaluate(([a, b]) => window.pdfHighlight.hold("highlighter", a, b), [{ x: X0, y: Y }, firstTo] as const);
		const before = await page.evaluate(() => window.pdfHighlight.place());
		const layersBefore = await page.evaluate(() => window.pdfHighlight.layers());
		if (flip) {
			// The answer flips to dark with no event behind it: nothing dresses the pair again, so it stays in the group at full opacity.
			await page.evaluate(() => window.pdfHighlight.setAssumption("lighten"));
			await page.evaluate((b) => window.pdfHighlight.holdTo(b), { x: X1, y: Y });
		}
		const rd = await readHeld(page, PAPER);
		await page.evaluate(() => window.pdfHighlight.lift());
		// The lift's paint is the first since the flip: there the group takes the dark answer's blend.
		const layersLift = flip ? await page.evaluate(() => window.pdfHighlight.layers()) : [];
		const pixels = rd.px.map((q) => ({ x: q.x, y: q.y, rgb: q.rgb }));
		const basePath = process.env.HW_D3_LAYERED_BASE;
		let base: { against: string; compared: number; missing: number; worst: number; at: unknown } | null = null;
		if (basePath) {
			const kept = JSON.parse(readFileSync(join(basePath, `d3-${name}.json`), "utf8")) as { pixels: Array<{ x: number; y: number; rgb: RGB }> };
			const byXY = new Map(kept.pixels.map((q) => [`${q.x},${q.y}`, q.rgb]));
			let compared = 0, missing = 0, worst = 0, at: unknown = null;
			for (const q of pixels) {
				const was = byXY.get(`${q.x},${q.y}`);
				if (!was) {
					missing++;
					continue;
				}
				compared++;
				const g = gap(q.rgb, was);
				if (g > worst) {
					worst = g;
					at = { ...q, was };
				}
			}
			base = { against: basePath, compared, missing, worst, at };
		}
		const groupWash = layersBefore.filter((l) => l.tag !== "canvas" && Number(l.opacity) === A).length;
		const pairFull = layersBefore.filter((l) => l.tag === "canvas" && l.parent !== "page" && Number(l.opacity) === 1).length;
		let worst = { gap: 0, at: null as unknown };
		for (const q of rd.px) if (gap(q.rgb, rd.trail) > worst.gap) worst = { gap: gap(q.rgb, rd.trail), at: { x: q.x, y: q.y, t: q.t, n: q.n, rgb: q.rgb } };
		const record = { flip, before, after: rd.raw, placed: placedRecord(rd.placed), layersBefore, layers: rd.layers, ...(flip ? { layersLift } : {}), groupWash, pairFull, trailAt: rd.trailAt,
			trail: rd.trail, paper: rd.paper, stats: rd.stats, worst, base, errors };
		const brief = JSON.stringify(record);
		console.log(`D3_HEAD ${name} ${brief}`);
		keep(`d3-${name}`, rd.png, { ...record, pixels });
		expect(errors, brief).toEqual([]);
		// PREMISES: the layered route at pen-down (a group carries the wash, the pair at full opacity inside it), placed by the camera.
		expect(before?.layered, `premise: the page has a highlight layer at pen-down (${brief})`).toBe(true);
		expect(groupWash, `premise: a highlight group wears the wash (${brief})`).toBeGreaterThanOrEqual(1);
		expect(pairFull, `premise: the live pair sits in the group at full opacity (${brief})`).toBeGreaterThanOrEqual(2);
		if (flip) expect(layersLift.filter((l) => l.tag !== "canvas" && l.blend === "normal").length, `premise: the answer now reads dark: the group blends normal at the lift's paint (${brief})`).toBeGreaterThanOrEqual(1);
		expectPlaced(rd.placed, brief);
		expect(gap(rd.paper, white), `premise: the paper reads white ${rd.paper}`).toBeLessThanOrEqual(2);
		expect(gap(rd.trail, white), `premise: the trail shows the wash ${rd.trail}`).toBeGreaterThanOrEqual(40);
		expect(rd.px.length, `premise: pixels across the join (${brief})`).toBeGreaterThanOrEqual(50);
		// GUARD: every pixel across the join within 2 of the trail, and of the 685ce486 record when named.
		expect.soft(worst.gap, `${name}: a pixel across the join off the trail ${rd.trail} at ${JSON.stringify(worst.at)}`).toBeLessThanOrEqual(2);
		if (base) {
			expect.soft(base.missing, `${name}: pixels with no 685ce486 record (${JSON.stringify(base)})`).toBe(0);
			expect.soft(base.worst, `${name}: a pixel off its 685ce486 colour ${JSON.stringify(base)}`).toBeLessThanOrEqual(2);
		}
	} finally {
		await page.close();
	}
}

it("D3 guard, layered PDF page: a highlighter held where highlights have a layer: the join keeps today's pixels", async () => {
	await layeredGuard("pdf-layered-held", false);
}, 120_000);

it("D3 guard, N3: a layered page whose answer flips to dark (Lighten for dark pages) mid-stroke, the pair not dressed again: the join keeps today's pixels", async () => {
	await layeredGuard("pdf-layered-flip-held", true);
}, 120_000);
