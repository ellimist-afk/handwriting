/**
 * A highlighter held at a slant on a PDF page, on a page read as light and on a page the file itself draws dark: across
 * the join between the settled strip and the live tip the stroke reads as its trail.
 *
 * What the user would see if it fails: while a highlighter stroke is being drawn on a PDF page, a patch as wide as the
 * highlight rides just behind the Pencil tip, off the trail's colour, and is gone at the lift. That is the patch a note
 * showed (NoteHighlighterHeadDot.test.ts) when the strip and the tip each wore the 0.35 wash: the strip's end disc under
 * the tip's back end was washed twice. On a PDF page the pair wore the wash itself only while the page had no highlight
 * layer of its own (PdfInkCommit.ts dressWet); a page whose highlights sit in the page's highlight group has the pair at
 * full opacity inside it and the group carries the wash once.
 *
 * THE PAGES: the PDF page stand-in (pdfHighlightPage.ts) under the real PdfInkController, device scale 1, the reader's
 * default setting ("darken"). Light: white paper, a black glyph. File-dark: paper rgb(30,30,30), a white glyph, so the
 * page reads as dark from its own pixels. Each page is opened once with the highlighter made the tool by a touch far
 * off, then opened again with no strokes, so its shade is read before the pen goes down, as when the highlighter has
 * been picked. Premise: the light page's highlight group multiplies; the file-dark page's does not (a group blending
 * normal, or the pair wearing the wash itself). The highlighter (#ffd60a, 7.6 px wide here) is held through the
 * controller's own pen callbacks, 20 px a sample, one a frame, along a line about 27 degrees below level, and not
 * lifted. The tip is placed by the page's camera (PdfInkPenPath.ts cameraFor), from the wet renderer's last ribbon point
 * and head (d3Bound.ts placedOf).
 *
 * THE READ: every screenshot pixel whose centre lies inside the stroke, 1.5 px in from its long edges, from a half-width
 * behind the strip's last point to the tip's front end (d3Bound.ts readPx), against a trail pixel 60 px behind the tip's
 * start. THE BOUND: no channel more than 2 darker than the trail; none more than 8 lighter; the pixels more than 2 lighter
 * lie within 2 px of each other along the stroke; none within 40 of the page's own paper.
 * The same frame is shot again with the head canvas hidden; how many pixels the strip alone paints off the trail is in
 * the record only. The shared bound of d3Bound.ts (4 darker, 14 lighter within 1.5 px of the disc's edge) is in the
 * record too, not asserted.
 *
 * GUARDS, each page: a highlighter touched down and held still shows its whole dot (no pixel inside the contact width,
 * 1 px in, reads as the page's paper); a pen stroke held at the same slant keeps its tip: the head canvas paints at the
 * strip's last point, the inkiest pixel within 2 px of that point is within 12 of the trail's inkiest (the pen is 1.4 px
 * wide here, so no pixel lies whole inside it), and, when HW_PDF_JOIN_BASE=<dir> names another run's records, every
 * pixel round the join is within 2 of that run's.
 *
 * Every premise is asserted. HW_PDF_JOIN_EVIDENCE=<dir> writes each screenshot and record there.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/PdfHeldHighlighterJoin.test.ts
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
import { behind, boundStats, boxOf, darker, expectPlaced, gap, lighter, placedOf, placedRecord, r2, readPx, white, type Placed, type Px } from "./d3Bound";
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
const darkPaper: RGB = [30, 30, 30];
const plainWash = (b: RGB) => b.map((v, i) => v * (1 - A) + A * yellow[i]!) as RGB;
/** About 27 degrees below level: the join crosses the pixel grid at a slant. */
const TH = 0.47;
const DIR: Pt = { x: Math.cos(TH), y: Math.sin(TH) };
const START: Pt = { x: 100, y: 440 }, LENGTH = 300;
const NIB: Pt = { x: START.x + LENGTH * DIR.x, y: START.y + LENGTH * DIR.y };
/** Bare paper on either page: away from the glyph and the stroke. */
const PAPER_AT: Pt = { x: 500, y: 150 };
const DOT_AT: Pt = { x: 400.5, y: 300.5 };
/** The touch that makes the highlighter the tool, on the page opened before the one read. */
const PRIME_AT: Pt = { x: 560, y: 760 };
/**
 * Pixels read inside the stroke this far in from its long edges. The stand-in's highlighter is 7.6 px wide (half-width
 * 3.8 at pressure 0.5), so 1.5 px in keeps a band 4.6 px wide whose pixels the stroke covers whole.
 */
const INSET = 1.5;
/** The bound's numbers. */
const BOUND = { darker: 2, lighter: 8, lighterThan: 2, band: 2, paperGap: 40 } as const;
/** A page screenshot, typed from playwright itself: the render tsconfig has no node types, so no `Buffer` by name. */
type Png = Awaited<ReturnType<Page["screenshot"]>>;
type Sheet = { name: "light" | "file-dark"; dark: boolean; paper: RGB };
const SHEETS: Record<Sheet["name"], Sheet> = {
	light: { name: "light", dark: false, paper: white },
	"file-dark": { name: "file-dark", dark: true, paper: darkPaper },
};

async function openPdf(sheet: Sheet, errors: string[]): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 700, height: 900 }, deviceScaleFactor: 1 });
	page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
	page.on("console", (m) => console.log(`page: ${m.text()}`));
	await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
	await page.addStyleTag({ content: stylesCss() });
	await page.addScriptTag({ content: bundle });
	await page.evaluate((dark) => window.pdfHighlight.open(dark, "darken"), sheet.dark);
	// The highlighter is the tool before the pen goes down, as when it has been picked: one touch far off and lifted,
	// then the page opened again with no strokes, so the mount's own sync reads the page's shade with the highlighter as
	// the tool (PdfInkBand.ts shadePages reads a live page only then, and never while a pen is down).
	await page.evaluate((p) => window.pdfHighlight.hold("highlighter", p, p), PRIME_AT);
	await page.evaluate(() => window.pdfHighlight.lift());
	await page.evaluate((dark) => window.pdfHighlight.open(dark, "darken"), sheet.dark);
	return page;
}

/** PREMISE: the page's answer, whichever route it takes: light multiplies in a group; file-dark is not multiplied, the group blending normal or the pair wearing the wash itself. */
function expectRead(sheet: Sheet, r: ReturnType<typeof route>, brief: string): void {
	if (sheet.dark) {
		expect(r.groupBlend.includes("multiply"), `premise: the page is read as dark, so nothing multiplies (${brief})`).toBe(false);
		expect(r.groupBlend.includes("normal") || r.pairWashed >= 2, `premise: the page is read as dark: a group blending normal, or the pair washed (${brief})`).toBe(true);
	} else {
		expect(r.groupBlend, `premise: the page is read as light: its highlight group multiplies (${brief})`).toContain("multiply");
	}
}

function keep(name: string, png: Png, record: unknown): void {
	const directory = process.env.HW_PDF_JOIN_EVIDENCE;
	if (!directory) return;
	writeFileSync(join(directory, `${name}.png`), png);
	writeFileSync(join(directory, `${name}.json`), JSON.stringify(record, null, 1));
}

const at = (q: Px) => ({ x: q.x, y: q.y, t: r2(q.t), n: r2(q.n), e: r2(q.e), rgb: q.rgb, alone: q.alone });

/** The worst pixel each way against the trail, the spread along the stroke of those more than 2 lighter, the one nearest the paper. */
function joinStats(px: Px[], trail: RGB, paper: RGB) {
	let dark = { by: 0, at: null as ReturnType<typeof at> | null }, light = { by: 0, at: null as ReturnType<typeof at> | null };
	let near = { gap: Infinity, at: null as ReturnType<typeof at> | null };
	let count = 0, tMin = Infinity, tMax = -Infinity, stripAloneOff = 0;
	for (const q of px) {
		const d = darker(q.rgb, trail), l = lighter(q.rgb, trail), w = gap(q.rgb, paper);
		if (d > dark.by) dark = { by: d, at: at(q) };
		if (l > light.by) light = { by: l, at: at(q) };
		if (w < near.gap) near = { gap: w, at: at(q) };
		if (l > BOUND.lighterThan) {
			count++;
			tMin = Math.min(tMin, q.t);
			tMax = Math.max(tMax, q.t);
		}
		if (q.alone && gap(q.alone, trail) > BOUND.lighterThan) stripAloneOff++;
	}
	return {
		count: px.length,
		aloneRead: px.filter((q) => q.alone !== null).length,
		darker: dark,
		lighter: light,
		lighterBand: count ? { count, tMin: r2(tMin), tMax: r2(tMax), width: r2(tMax - tMin) } : { count: 0, tMin: 0, tMax: 0, width: 0 },
		paper: near,
		stripAloneOff,
	};
}

/** The shared bound's read, for the record only. */
function sharedBound(px: Px[], trail: RGB) {
	const s = boundStats(px, trail);
	return { darker: s.darker.by, lighter: s.lighter.by, lighterThan4: s.lighterThan4, stripsOwn: s.stripsOwn.count };
}

/** The live tool's head canvas, read where the page's helper hides it: its backing alpha at each point (client px). */
async function headAlpha(page: Page, points: Record<string, Pt>) {
	return page.evaluate(async (points) => {
		const hidden = await window.pdfHighlight.tailHidden(true);
		const head = [...document.querySelectorAll<HTMLCanvasElement>("canvas")].find((c) => c.style.visibility === "hidden") ?? null;
		const out: Record<string, number | null> = {};
		let context = "none";
		if (head) {
			const g = head.getContext("2d");
			if (g) {
				context = "2d";
				const box = head.getBoundingClientRect();
				for (const [key, p] of Object.entries(points)) {
					const x = Math.floor(((p.x - box.left) * head.width) / box.width), y = Math.floor(((p.y - box.top) * head.height) / box.height);
					out[key] = x >= 0 && y >= 0 && x < head.width && y < head.height ? g.getImageData(x, y, 1, 1).data[3]! : null;
				}
			}
		}
		const shown = await window.pdfHighlight.tailHidden(false);
		return { hidden, shown, found: head !== null, context, alpha: out };
	}, points);
}

/** Place the held tip by the page's camera and read the screenshot; the same frame again with the head canvas hidden. */
async function readHeld(page: Page, sheet: Sheet) {
	const raw = await page.evaluate(() => window.pdfHighlight.place());
	const placed = raw ? placedOf(raw, DIR) : null;
	const trailAt = placed ? behind(placed, placed.hw + 60) : PAPER_AT;
	const layers = await page.evaluate(() => window.pdfHighlight.layers());
	const png = await page.screenshot({ scale: "css" });
	const hidden = await page.evaluate(() => window.pdfHighlight.tailHidden(true));
	const pngAlone = await page.screenshot({ scale: "css" });
	const shown = await page.evaluate(() => window.pdfHighlight.tailHidden(false));
	const b64 = png.toString("base64"), b64Alone = pngAlone.toString("base64");
	const s = await page.evaluate(({ b64, points }) => window.pdfHighlight.sample(b64, { x: 0, y: 0 }, points, 1), { b64, points: { trail: trailAt, paper: PAPER_AT } });
	let px: Px[] = [];
	if (placed) {
		const bx = boxOf(placed, 1);
		const region = (b: string) => page.evaluate(({ b64, bx }) => window.pdfHighlight.region(b64, bx.x0, bx.y0, bx.w, bx.h), { b64: b, bx });
		const data = await region(b64), alone = await region(b64Alone);
		px = readPx({ data, alone, ...bx, k: 1 }, placed, INSET);
	}
	const trail = s.trail!, paper = s.paper!;
	return { raw, placed, layers, png, pngAlone, trail, paper, trailAt, px, stats: joinStats(px, trail, sheet.paper), shared: sharedBound(px, trail), tail: { hidden, shown } };
}

/** The route the page's highlights take while the stroke is held, for the record: a layer, or the wash on the pair. */
function route(layers: Array<{ tag: string; opacity: string; blend: string; parent: string }>) {
	return {
		pairWashed: layers.filter((l) => l.tag === "canvas" && Number(l.opacity) === A).length,
		groupWash: layers.filter((l) => l.tag !== "canvas" && Number(l.opacity) === A).length,
		groupBlend: layers.filter((l) => l.tag !== "canvas" && Number(l.opacity) === A).map((l) => l.blend),
		pairFull: layers.filter((l) => l.tag === "canvas" && l.parent !== "page" && Number(l.opacity) === 1).length,
	};
}

async function heldCell(sheet: Sheet): Promise<void> {
	const errors: string[] = [];
	const page = await openPdf(sheet, errors);
	try {
		await page.evaluate(([a, b]) => window.pdfHighlight.hold("highlighter", a, b), [START, NIB] as const);
		const rd = await readHeld(page, sheet);
		await page.evaluate(() => window.pdfHighlight.lift());
		const record = { sheet: sheet.name, raw: rd.raw, placed: placedRecord(rd.placed), route: route(rd.layers), layers: rd.layers, trailAt: rd.trailAt, trail: rd.trail,
			paper: rd.paper, plainWash: plainWash(sheet.paper), stats: rd.stats, shared: rd.shared, tail: rd.tail, errors };
		const brief = JSON.stringify(record);
		console.log(`PDF_JOIN ${sheet.name}-held ${brief}`);
		keep(`${sheet.name}-held`, rd.png, record);
		keep(`${sheet.name}-held-strip-alone`, rd.pngAlone, { sheet: sheet.name, tail: rd.tail });
		expect(errors, brief).toEqual([]);
		// PREMISES: the page's answer; the tip placed by the camera; the page's own paper; a trail of the one plain wash over it; pixels to read.
		expectRead(sheet, record.route, brief);
		expectPlaced(rd.placed, brief);
		expect(gap(rd.paper, sheet.paper), `premise: the paper reads ${sheet.paper}: ${rd.paper}`).toBeLessThanOrEqual(2);
		expect(gap(rd.trail, plainWash(sheet.paper)), `premise: the trail is the one plain wash ${rd.trail} against ${plainWash(sheet.paper)}`).toBeLessThanOrEqual(3);
		expect(rd.stats.count, `premise: pixels across the join (${brief})`).toBeGreaterThanOrEqual(50);
		expect(rd.stats.aloneRead, `premise: every pixel read again with the head canvas hidden (${brief})`).toBe(rd.stats.count);
		expect(rd.tail, `premise: the strip-alone shot had the head canvas hidden, and it was shown again (${brief})`).toEqual({ hidden: "hidden", shown: "visible" });
		// THE BOUND.
		const s = JSON.stringify(rd.stats);
		expect.soft(rd.stats.darker.by, `${sheet.name}: darker than the trail ${rd.trail} at ${JSON.stringify(rd.stats.darker.at)}; ${s}`).toBeLessThanOrEqual(BOUND.darker);
		expect.soft(rd.stats.lighter.by, `${sheet.name}: lighter than the trail ${rd.trail} at ${JSON.stringify(rd.stats.lighter.at)}; ${s}`).toBeLessThanOrEqual(BOUND.lighter);
		expect.soft(rd.stats.lighterBand.width, `${sheet.name}: the pixels more than 2 lighter spread along the stroke ${JSON.stringify(rd.stats.lighterBand)}`).toBeLessThanOrEqual(BOUND.band);
		expect.soft(rd.stats.paper.gap, `${sheet.name}: a pixel reads as the page's paper ${JSON.stringify(rd.stats.paper.at)}`).toBeGreaterThanOrEqual(BOUND.paperGap);
	} finally {
		await page.close();
	}
}

/** Every screen pixel inside the contact width, 1 px in (the dot is 7.6 px across), around p: how many, and how many read as the page's paper. */
async function dotRead(page: Page, png: Png, p: Pt, rc: number, paper: RGB) {
	const pad = Math.ceil(rc) + 2, x0 = Math.floor(p.x) - pad, y0 = Math.floor(p.y) - pad, w = 2 * pad + 1;
	const data = await page.evaluate(({ b64, x0, y0, w }) => window.pdfHighlight.region(b64, x0, y0, w, w), { b64: png.toString("base64"), x0, y0, w });
	let inside = 0, bare = 0, nearest: { x: number; y: number; d: number; rgb: RGB } | null = null;
	for (let r = 0; r < w; r++) {
		for (let c = 0; c < w; c++) {
			const x = x0 + c, y = y0 + r, d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y);
			if (d > rc - 1) continue;
			const i = (r * w + c) * 3, rgb: RGB = [data[i]!, data[i + 1]!, data[i + 2]!];
			inside++;
			if (gap(rgb, paper) < BOUND.paperGap) {
				bare++;
				if (!nearest || gap(rgb, paper) < gap(nearest.rgb, paper)) nearest = { x, y, d: r2(d), rgb };
			}
		}
	}
	return { inside, bare, nearest };
}

async function dotGuard(sheet: Sheet): Promise<void> {
	const errors: string[] = [];
	const page = await openPdf(sheet, errors);
	try {
		// Touched down and held still: the down sample and one more at the same point, no lift.
		await page.evaluate(([a, b]) => window.pdfHighlight.hold("highlighter", a, b), [DOT_AT, DOT_AT] as const);
		const raw = await page.evaluate(() => window.pdfHighlight.place());
		const layers = await page.evaluate(() => window.pdfHighlight.layers());
		const png = await page.screenshot({ scale: "css" });
		const head = await headAlpha(page, { centre: DOT_AT });
		const rc = raw?.hw ?? 0;
		const dot = await dotRead(page, png, DOT_AT, rc, sheet.paper);
		await page.evaluate(() => window.pdfHighlight.lift());
		const record = { sheet: sheet.name, p: DOT_AT, raw, route: route(layers), rc: r2(rc), head, ...dot, errors };
		const brief = JSON.stringify(record);
		console.log(`PDF_JOIN ${sheet.name}-dot ${brief}`);
		keep(`${sheet.name}-dot`, png, record);
		expect(errors, brief).toEqual([]);
		expectRead(sheet, record.route, brief);
		expect(rc, `premise: the contact half-width is known (${brief})`).toBeGreaterThanOrEqual(3);
		expect(head.alpha.centre ?? 0, `premise: the dot is painted on the head canvas (${brief})`).toBeGreaterThan(0);
		expect(dot.inside, `premise: pixels inside the dot (${brief})`).toBeGreaterThanOrEqual(20);
		// GUARD: every pixel inside the contact width, 1 px in, shows the wash.
		expect(dot.bare, `${sheet.name}: pixels inside the dot that read as the page's paper (${brief})`).toBe(0);
	} finally {
		await page.close();
	}
}

async function penGuard(sheet: Sheet): Promise<void> {
	const errors: string[] = [];
	const page = await openPdf(sheet, errors);
	try {
		await page.evaluate(([a, b]) => window.pdfHighlight.hold("pen", a, b, "#1060e0"), [START, NIB] as const);
		const raw = await page.evaluate(() => window.pdfHighlight.place());
		const placed = raw ? placedOf(raw, DIR) : null;
		const brief0 = JSON.stringify({ raw });
		expect(placed, `premise: the pen's last strip point and head are known (${brief0})`).not.toBeNull();
		const p: Placed = placed!;
		const trailAt = behind(p, 40);
		const head = await headAlpha(page, { m: p.m, trail: trailAt });
		const png = await page.screenshot({ scale: "css" });
		const b64 = png.toString("base64");
		// The pen here is 1.4 px wide, so no pixel lies whole inside it: each place is read as its inkiest pixel within 2 px.
		const bx = boxOf(p, 1);
		const data = await page.evaluate(({ b64, bx }) => window.pdfHighlight.region(b64, bx.x0, bx.y0, bx.w, bx.h), { b64, bx });
		const pixels: Array<{ x: number; y: number; rgb: RGB }> = [];
		for (let r = 0; r < bx.h; r++) for (let c = 0; c < bx.w; c++) {
			const i = (r * bx.w + c) * 3;
			pixels.push({ x: bx.x0 + c, y: bx.y0 + r, rgb: [data[i]!, data[i + 1]!, data[i + 2]!] });
		}
		const tb = { x0: Math.floor(trailAt.x) - 2, y0: Math.floor(trailAt.y) - 2, w: 5, h: 5 };
		const tdata = await page.evaluate(({ b64, tb }) => window.pdfHighlight.region(b64, tb.x0, tb.y0, tb.w, tb.h), { b64, tb });
		const inkiest = (list: RGB[]) => list.reduce((best, q) => (gap(q, sheet.paper) > gap(best, sheet.paper) ? q : best), list[0]!);
		const trailList: RGB[] = [];
		for (let i = 0; i < tdata.length; i += 3) trailList.push([tdata[i]!, tdata[i + 1]!, tdata[i + 2]!]);
		const trail = inkiest(trailList);
		const joinList = pixels.filter((q) => Math.hypot(q.x + 0.5 - p.m.x, q.y + 0.5 - p.m.y) <= 2).map((q) => q.rgb);
		const joinInk = joinList.length ? inkiest(joinList) : sheet.paper;
		const basePath = process.env.HW_PDF_JOIN_BASE;
		let base: { against: string; compared: number; missing: number; worst: number; at: unknown } | null = null;
		if (basePath) {
			const kept = JSON.parse(readFileSync(join(basePath, `${sheet.name}-pen.json`), "utf8")) as { pixels: Array<{ x: number; y: number; rgb: RGB }> };
			const byXY = new Map(kept.pixels.map((q) => [`${q.x},${q.y}`, q.rgb]));
			let compared = 0, missing = 0, worst = 0, at: unknown = null;
			for (const q of pixels) {
				const was = byXY.get(`${q.x},${q.y}`);
				if (!was) {
					missing++;
					continue;
				}
				compared++;
				if (gap(q.rgb, was) > worst) {
					worst = gap(q.rgb, was);
					at = { ...q, was };
				}
			}
			base = { against: basePath, compared, missing, worst, at };
		}
		await page.evaluate(() => window.pdfHighlight.lift());
		const record = { sheet: sheet.name, raw, placed: placedRecord(p), head, trail, joinInk, joinGap: gap(joinInk, trail), base, errors };
		const brief = JSON.stringify(record);
		console.log(`PDF_JOIN ${sheet.name}-pen ${brief}`);
		keep(`${sheet.name}-pen`, png, { ...record, pixels });
		expect(errors, brief).toEqual([]);
		expect(head.found && head.context, `premise: the head canvas is found and read (${brief})`).toBe("2d");
		expect(gap(trail, sheet.paper), `premise: the trail shows the pen ${trail}`).toBeGreaterThanOrEqual(100);
		expect(joinList.length, `premise: pixels at the join (${brief})`).toBeGreaterThanOrEqual(9);
		// GUARDS: the head canvas paints at the strip's last point, the join reads as the trail, and, when a base record
		// is named, every pixel round the join is within 2 of it.
		expect.soft(head.alpha.m ?? 0, `${sheet.name}: the head canvas at the strip's last point (${brief})`).toBeGreaterThan(0);
		expect.soft(gap(joinInk, trail), `${sheet.name}: the join's inkiest pixel ${joinInk} against the trail's ${trail} (${brief})`).toBeLessThanOrEqual(12);
		if (base) {
			expect.soft(base.missing, `${sheet.name}: pixels with no base record (${JSON.stringify(base)})`).toBe(0);
			expect.soft(base.worst, `${sheet.name}: a pixel off its base colour ${JSON.stringify(base)}`).toBeLessThanOrEqual(2);
		}
	} finally {
		await page.close();
	}
}

it("PDF page read as light: a highlighter held at about 27 degrees, 20 px a sample: across the join no pixel more than 2 darker than the trail, none more than 8 lighter, the lighter ones within 2 px along the stroke, no paper", async () => {
	await heldCell(SHEETS.light);
}, 120_000);

it("PDF page the file draws dark: a highlighter held at about 27 degrees, 20 px a sample: across the join no pixel more than 2 darker than the trail, none more than 8 lighter, the lighter ones within 2 px along the stroke, no paper", async () => {
	await heldCell(SHEETS["file-dark"]);
}, 120_000);

it("guard, PDF page read as light: a highlighter touched down and held still shows its whole dot", async () => {
	await dotGuard(SHEETS.light);
}, 120_000);

it("guard, PDF page the file draws dark: a highlighter touched down and held still shows its whole dot", async () => {
	await dotGuard(SHEETS["file-dark"]);
}, 120_000);

it("guard, PDF page read as light: a pen stroke held at a slant keeps its tip: the head canvas paints at the strip's last point and the join reads as the trail", async () => {
	await penGuard(SHEETS.light);
}, 120_000);

it("guard, PDF page the file draws dark: a pen stroke held at a slant keeps its tip: the head canvas paints at the strip's last point and the join reads as the trail", async () => {
	await penGuard(SHEETS["file-dark"]);
}, 120_000);
