/**
 * A HUGE NOTE'S OWN READING VIEW IS SHARP: IT DRAWS WHAT IS ON SCREEN AT THE DISPLAY'S RATIO.
 *
 * Reading view drew a note's whole ink box into one canvas held to an area budget, so Alan's Infinite Canvas note
 * (an ink box of 9,241 x 6,025 css px) came out at 0.268 device px per css px on a 1.8257 display: a blown-up
 * thumbnail. Now a Reading view root over that budget draws a tile: the visible rect plus a quarter view each side, at
 * the display's ratio, repainted when a scroll leaves it (src/inline/EmbedInkTile.ts).
 *
 * At Alan's geometry (deviceScaleFactor 1.8257, a 1,400 x 900 view): the tile holds the view at density dpr; one view
 * of scroll repaints once, the two tiles agree device px for device px where they overlap; a scroll inside the margin
 * repaints nothing; the view's scroll range is the whole box's; a one-page note keeps its whole-box canvas and no tile
 * styles. The scroll listener's own JS time is printed, and its median held under 1 ms.
 *
 * Run: npm run test:render -- ReadingViewTile.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

const DPR = 1.8257;
const VIEW_CSS = `
body { margin: 0; font-family: sans-serif; }
.markdown-preview-view { font-size: 16px; line-height: 1.5; padding: 32px; position: relative; overflow: auto; box-sizing: border-box; width: 1400px; height: 900px; }
.markdown-preview-sizer { max-width: 700px; margin: 0 auto; }
`;

let browser: Browser;
let page: Page;
const errors: string[] = [];
beforeAll(async () => {
	const b = await build({ entryPoints: [fileURLToPath(new URL("./readingViewTilePage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) } });
	browser = await chromium.launch({ headless: true });
	page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: DPR });
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addStyleTag({ content: VIEW_CSS });
	await page.addStyleTag({ content: readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8") });
	await page.addScriptTag({ content: b.outputFiles[0]!.text });
});
afterAll(async () => { await browser?.close(); });

it("huge note: the layer holds the view at the display's ratio, and the scroll range is the whole ink box's", async () => {
	const r = await page.evaluate(() => (window as any).mount(true));
	console.log("READING-VIEW-TILE mount", JSON.stringify({ ...r, tile: r.tile, style: r.style }));
	expect(r.error).toBeUndefined();
	expect(r.dpr).toBeCloseTo(DPR, 3);
	expect(r.density, `device px per css px ${r.density}`).toBeGreaterThanOrEqual(DPR - 0.01);
	expect(r.holdsView, "the drawn part covers the view").toBe(true);
	// The ink box starts at the sizer's column; its far edges set the range: 6,025 px of ink below the view's top padding.
	expect(r.scrollHeight).toBeGreaterThanOrEqual(6025);
	// Sideways too: the ink box's right edge, in the view's scrolled content, is the canvas's left less the tile's offset
	// plus the box's 9,241 px.
	const left = parseFloat(/(?:^|;)\s*left:\s*([-\d.]+)px/.exec(r.style ?? "")?.[1] ?? "NaN");
	const boxRight = left - (r.tile?.x ?? 0) + 9241;
	expect(Number.isFinite(boxRight), `the canvas's left from its style: ${r.style}`).toBe(true);
	expect(r.scrollWidth, `scroll width against the box's right edge ${boxRight}`).toBeGreaterThanOrEqual(Math.floor(boxRight));
	expect(r.width * r.height).toBeLessThanOrEqual(16_000_000);
	expect(errors).toEqual([]);
});

it("huge note: a scroll inside the tile's margin repaints nothing", async () => {
	await page.evaluate(() => (window as any).mount(true));
	const r = await page.evaluate(() => (window as any).scrollBy(150));
	console.log("READING-VIEW-TILE small scroll", JSON.stringify({ paints: r.paints, before: r.before, after: r.after }));
	expect(r.paints).toBe(0);
	expect(errors).toEqual([]);
});

it("huge note: one view of scroll repaints once, and the old and new tiles agree device px for device px where they overlap", async () => {
	await page.evaluate(() => (window as any).mount(true));
	const r = await page.evaluate(() => (window as any).scrollBy(900));
	console.log("READING-VIEW-TILE view scroll", JSON.stringify({ paints: r.paints, before: r.before, after: r.after, overlap: r.overlap, inked: r.inked, differ: r.differ, seam: r.seam, missing: r.missing, seamMissing: r.seamMissing, maxDelta: r.maxDelta, where: r.where, density: r.density, holdsView: r.holdsView }));
	expect(r.paints).toBe(1);
	expect(r.holdsView, "the new tile covers the view").toBe(true);
	expect(r.density).toBeGreaterThanOrEqual(DPR - 0.01);
	expect(r.overlap, "the tiles overlap").toBeGreaterThan(0);
	expect(r.inked, "the overlap holds ink, so the comparison discriminates").toBeGreaterThan(1000);
	// Chromium's raster is not exact under a whole-pixel shift: a few px differ by a little. Both bounds hold together.
	expect(r.differ / r.inked, `${r.differ} of ${r.inked} inked px differ`).toBeLessThanOrEqual(0.01);
	expect(r.maxDelta, "largest premultiplied difference, of 255").toBeLessThanOrEqual(64);
	// No ink one tile drew and the other did not. Small differences where Chromium clips a path at a canvas edge are
	// noise; the seam count is printed, not bounded: it does not tell that noise from a dropped stroke.
	expect(r.missing, `${r.missing} px inked on one tile and blank on the other (${r.seamMissing} on a tile edge; seam ${r.seam})`).toBe(0);
	expect(errors).toEqual([]);
});

it("huge note: a repaint at the same scroll, same device origin, changes no px", async () => {
	await page.evaluate(() => (window as any).mount(true));
	const r = await page.evaluate(() => (window as any).scrollBy(0));
	console.log("READING-VIEW-TILE same origin", JSON.stringify({ paints: r.paints, before: r.before, after: r.after, overlap: r.overlap, inked: r.inked, differ: r.differ }));
	expect(r.paints, "the save repainted the layer").toBeGreaterThanOrEqual(1);
	expect({ bx: r.after.bx, by: r.after.by }).toEqual({ bx: r.before.bx, by: r.before.by });
	expect(r.inked).toBeGreaterThan(1000);
	expect(r.differ).toBe(0);
	expect(errors).toEqual([]);
});

it("one-page note: the whole box at the display's ratio, with no tile and no tile styles", async () => {
	const r = await page.evaluate(() => (window as any).mount(false));
	console.log("READING-VIEW-TILE one page", JSON.stringify(r));
	expect(r.error).toBeUndefined();
	expect(r.tile).toBeNull();
	expect(r.holdsView).toBe(true);
	// The grid's last strokes reach past 700 px; the box is the ink's own, drawn whole at the display's ratio.
	expect({ width: r.width, height: r.height }).toEqual({ width: Math.round(r.cssW * DPR), height: Math.round(r.cssH * DPR) });
	expect(r.style).not.toMatch(/border|box-sizing/);
	expect(errors).toEqual([]);
});

it("huge note that shrinks to one page: the whole box again, and none of the tile's styles left", async () => {
	// Record every style property written through setProperty, so the tile's fixed styles can be told from the ones that
	// follow the tile (the checker wants fixed styles through setCssStyles; a property written either way reads the same
	// from the style attribute, so the attribute alone cannot tell the two apart).
	await page.evaluate(() => {
		const w = window as any;
		w.setPropertyNames = [];
		const real = CSSStyleDeclaration.prototype.setProperty;
		w.restoreSetProperty = () => { CSSStyleDeclaration.prototype.setProperty = real; };
		CSSStyleDeclaration.prototype.setProperty = function (this: CSSStyleDeclaration, name: string, ...rest: any[]) {
			w.setPropertyNames.push(name);
			return (real as any).call(this, name, ...rest);
		};
	});
	const big = await page.evaluate(() => (window as any).mount(true));
	const written: string[] = await page.evaluate(() => { (window as any).restoreSetProperty(); return (window as any).setPropertyNames; });
	expect(big.style, "the tile path wrote its styles").toMatch(/border-width/);
	expect(big.style, "the tile's fixed styles are on the layer").toMatch(/box-sizing:\s*content-box/);
	expect(big.style).toMatch(/border-style:\s*solid/);
	expect(big.style).toMatch(/border-color:\s*transparent/);
	expect(written, "the fixed styles go through setCssStyles, not setProperty").not.toEqual(expect.arrayContaining(["box-sizing"]));
	expect(written).not.toEqual(expect.arrayContaining(["border-style"]));
	expect(written).not.toEqual(expect.arrayContaining(["border-color"]));
	expect(written, "the probe sees setProperty at all: the tile's moving border width still uses it").toContain("border-width");
	const r = await page.evaluate(() => (window as any).shrink());
	console.log("READING-VIEW-TILE shrink", JSON.stringify(r));
	expect(r.tile).toBeNull();
	expect(r.style).not.toMatch(/border|box-sizing/);
	expect({ width: r.width, height: r.height }).toEqual({ width: Math.round(r.cssW * DPR), height: Math.round(r.cssH * DPR) });
	expect(errors).toEqual([]);
});

it("huge note in an export's view: the whole box as before, no tile", async () => {
	const r = await page.evaluate(() => (window as any).mount(true, "export"));
	console.log("READING-VIEW-TILE export", JSON.stringify(r));
	expect(r.error).toBeUndefined();
	expect(r.tile).toBeNull();
	expect(r.density, "the whole box at the layer budget").toBeLessThan(0.3);
	expect(r.style).not.toMatch(/border|box-sizing/);
	expect(errors).toEqual([]);
});

it("huge note: the scroll listener's own JS time", async () => {
	await page.evaluate(() => (window as any).mount(true));
	const r = await page.evaluate(() => (window as any).handlerCost(60));
	console.log("READING-VIEW-TILE handler", JSON.stringify({ calls: r.calls, median: r.median, max: r.max }));
	expect(r.error).toBeUndefined();
	expect(r.calls).toBeGreaterThan(30);
	// A coarse guard; the printed max is the number.
	expect(r.median).toBeLessThan(1);
});
