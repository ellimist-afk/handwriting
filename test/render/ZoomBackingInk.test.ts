/**
 * Backing store sized from real device px, and ink density/colour on
 * screen for one stroke, on the zoomed host and on the transform host.
 *
 * Two independent reads, both from outside the source so this file works
 * whether or not the source's own reallocation-path record exists or
 * fires:
 *  - BACKING: each ink canvas's backing store (`canvas.width`/`height`)
 *    against `Math.round(rect.width * dpr)` - the source's own claimed
 *    invariant, checked independently (`runTearBacking`, added to this
 *    file's copy of scrollColumnAnchorPage.ts beside `runTearRead`).
 *  - INK: one real pen stroke (`cdpPen.ts`, the same driver InkTileAcceptance
 *    uses), screenshotted and decoded (`pngInk.ts`, the same decoder), non-
 *    background pixel count and darkest sampled colour. Written to a report
 *    keyed by pane+scale; the two builds are compared by diffing their
 *    reports (paired cells, one report each), because this file has no
 *    access to a second tree's build from inside one vitest run.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { penStroke, linePoints } from "./cdpPen";
import { decodePng, countInk } from "./pngInk";

declare const process: { env: Record<string, string | undefined> };
const root = fileURLToPath(new URL("../../", import.meta.url));
let browser: Browser, bundle: string;
const report: unknown[] = [];

beforeAll(async () => {
	browser = await chromium.launch({ headless: true });
	bundle = (await build({
		entryPoints: [root + "test/render/scrollColumnAnchorPage.ts"], bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: root + "test/render/iphoneObsidianStub.ts" },
	})).outputFiles[0]!.text;
}, 180_000);

afterAll(async () => {
	await browser?.close();
	if (process.env.HW_Z3_REPORT) writeFileSync(process.env.HW_Z3_REPORT, JSON.stringify(report, null, 1));
});

const PANES = [
	{ name: "stress", w: 2396, h: 1750, dpr: 1 },
	{ name: "device", w: 945, h: 834, dpr: 2 },
] as const;
const SCALES = [0.1, 0.3] as const;

type Backing = { name: string; backing: { w: number; h: number }; expectedBacking: { w: number; h: number }; released?: boolean };
const HIGHLIGHT_PAIR = new Set(["highlightCanvas", "highlightWetCanvas"]);
/**
 * Live canvases within 1 device px of rect*dpr; the highlight pair exactly 0x0 while "deferred", full like the rest once
 * "lifted"; the wet canvas exactly 0x0 while the overlay holds it released (a scroll or a zoom moved the page with no
 * stroke on it), and like the rest otherwise.
 */
function expectBacking(backing: Backing[], pair: "deferred" | "lifted") {
	expect(backing.map(c => c.name).sort(), "the five ink canvases").toEqual(["committedCanvas", "highlightCanvas", "highlightWetCanvas", "tailCanvas", "wetCanvas"]);
	for (const c of backing) {
		if (pair === "deferred" && HIGHLIGHT_PAIR.has(c.name)) {
			expect.soft(c.backing, `${c.name} backing is 0x0 before any highlighter use`).toEqual({ w: 0, h: 0 });
			continue;
		}
		if (c.name === "wetCanvas" && c.released) {
			expect.soft(c.backing, `${c.name} backing is 0x0 while released`).toEqual({ w: 0, h: 0 });
			continue;
		}
		expect.soft(Math.abs(c.backing.w - c.expectedBacking.w), `${c.name} backing width vs rect*dpr`).toBeLessThanOrEqual(1);
		expect.soft(Math.abs(c.backing.h - c.expectedBacking.h), `${c.name} backing height vs rect*dpr`).toBeLessThanOrEqual(1);
	}
}

for (const pane of PANES) for (const scale of SCALES) it(`backing store and stroke ink at scale=${scale}, ${pane.name} pane`, async () => {
	const page = await browser.newPage({ viewport: { width: pane.w, height: pane.h }, deviceScaleFactor: pane.dpr });
	try {
		await page.addScriptTag({ content: bundle });
		const read = await page.evaluate(([s, pane_]) => (window as any).scrollColumnAnchor.runTearMount(s, 0, pane_, true, { fx: 0.5, fy: 0.5 }), [scale, { w: pane.w, h: pane.h }]);
		const backing = await page.evaluate(() => (window as any).scrollColumnAnchor.runTearBacking());

		// Z4a folded in here rather than a separate file (time-boxed; see
		// handback): cssScale (ownedEffectiveScale, rect/offset) must read the
		// requested k regardless of which write path (zoom or transform) is
		// live - this is the one claim Z4's "unit" arm makes that a real
		// browser can answer and jsdom cannot (jsdom does no CSS zoom layout).
		expect(read.cssScale, "cssScale reads the requested scale").toBeCloseTo(scale, 3);

		// BACKING claim: the three live ink canvases within 1 device px on both
		// axes; the highlight pair holds no backing at all until the highlighter
		// is first needed (the cell below covers the pair once it is).
		expectBacking(backing as Backing[], "deferred");

		// INK claim: one real pen stroke across the pane centre, sampled from
		// the compositor's own screenshot output (pngInk decodes what the
		// browser actually painted, not what a canvas's backing store holds).
		const cdp = await page.context().newCDPSession(page);
		const cx = pane.w / 2, cy = pane.h / 2, half = Math.min(pane.w, pane.h) / 4;
		const points = linePoints({ x: cx - half, y: cy }, { x: cx + half, y: cy }, 12);
		await penStroke(cdp, points, { pressure: 0.6 });
		await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
		const clip = { x: Math.round(cx - half - 20), y: Math.round(cy - 20), width: Math.round(half * 2 + 40), height: 40 };
		const png = await page.screenshot({ clip });
		const decoded = decodePng(png);
		let nonBackground = 0, darkest = 255;
		for (let i = 0; i < decoded.px.length; i += decoded.channels) {
			const r = decoded.px[i]!, g = decoded.px[i + 1]!, b = decoded.px[i + 2]!;
			const lum = (r + g + b) / 3;
			if (lum < 250) { nonBackground++; darkest = Math.min(darkest, lum); }
		}
		const inkAtLeastSomewhere = countInk(decoded, "blue").n + countInk(decoded, "red").n + countInk(decoded, "green").n;

		const r = { pane: pane.name, scale, dpr: pane.dpr, cssScale: read.cssScale, backing, ink: { nonBackground, darkest, coloredPixels: inkAtLeastSomewhere, totalSampled: decoded.width * decoded.height } };
		report.push(r);
		// eslint-disable-next-line no-console
		console.log(`Z3 ${pane.name}@${scale}: nonBackground=${nonBackground}/${decoded.width * decoded.height} darkest=${darkest.toFixed(1)}`);
		expect(nonBackground, "the stroke left some non-background pixels in the sampled strip").toBeGreaterThan(0);

		await page.evaluate(() => (window as any).scrollColumnAnchor.runTearTeardown());
	} finally {
		await page.close();
	}
}, 120_000);

// The highlight pair once the highlighter is needed: a real pen-down with the
// highlighter selected (the pointer path that lifts the deferral), then the
// pair must carry the same backing as the live three, within 1 device px of
// rect*dpr, and the whole-layer read must see the stroke on the pair.
for (const pane of PANES) for (const scale of SCALES) it(`highlight pair backing after a highlighter stroke at scale=${scale}, ${pane.name} pane`, async () => {
	const page = await browser.newPage({ viewport: { width: pane.w, height: pane.h }, deviceScaleFactor: pane.dpr });
	try {
		await page.addScriptTag({ content: bundle });
		await page.evaluate(([s, pane_]) => (window as any).scrollColumnAnchor.runTearMount(s, 0, pane_, true, { fx: 0.5, fy: 0.5 }), [scale, { w: pane.w, h: pane.h }]);
		const before = await page.evaluate(() => (window as any).scrollColumnAnchor.runTearBacking()) as Backing[];
		expectBacking(before, "deferred");

		const tool = await page.evaluate(() => (window as any).scrollColumnAnchor.runTearSetTool("highlighter"));
		expect(tool, "the next stroke draws with the highlighter").toBe("highlighter");
		// From the pane centre rightward: on the device pane the point a quarter
		// pane left of centre is outside the note (the pen-down lands on the
		// page body and never reaches the overlay), so the stroke starts where
		// the scroller is.
		const cdp = await page.context().newCDPSession(page);
		const cx = pane.w / 2, cy = pane.h / 2, half = Math.min(pane.w, pane.h) / 4;
		// Read once with the pen still down (the backing the pen-down gave the
		// pair, before any later resize can size it again), and once after.
		let penDown: Backing[] | null = null;
		await penStroke(cdp, linePoints({ x: cx, y: cy }, { x: cx + half, y: cy }, 12), {
			pressure: 0.6,
			between: async i => { if (i === 1) penDown = await page.evaluate(() => (window as any).scrollColumnAnchor.runTearBacking()) as Backing[]; },
		});
		await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
		expect(penDown, "the pair was read with the pen down").not.toBeNull();
		expectBacking(penDown!, "lifted");

		const after = await page.evaluate(() => (window as any).scrollColumnAnchor.runTearBacking()) as Backing[];
		expectBacking(after, "lifted");

		// The pair is read, not skipped: the whole-layer read gives the
		// committed highlight layer a real hash, and not the one a blank
		// canvas of its size gives.
		const hashes = await page.evaluate(() => (window as any).scrollColumnAnchor.runTileHash()) as string[];
		const probe = await page.evaluate(() => (window as any).scrollColumnAnchor.runTearHighlightProbe()) as { name: string; index: number; blankHash: string }[];
		const committed = probe.find(p => p.name === "highlightCanvas")!;
		expect(committed.index, "the highlight layer is in the ink layer").toBeGreaterThanOrEqual(0);
		expect(hashes[committed.index], "the highlight layer is read").not.toBe("0x0");
		expect(hashes[committed.index], "the highlight layer holds the stroke").not.toBe(committed.blankHash);
		// eslint-disable-next-line no-console
		console.log(`HL ${pane.name}@${scale}: ${after.filter(c => HIGHLIGHT_PAIR.has(c.name)).map(c => `${c.name} ${c.backing.w}x${c.backing.h} want ${c.expectedBacking.w}x${c.expectedBacking.h}`).join(", ")}; hash ${hashes[committed.index]} blank ${committed.blankHash}`);

		await page.evaluate(() => (window as any).scrollColumnAnchor.runTearTeardown());
	} finally {
		await page.close();
	}
}, 120_000);
