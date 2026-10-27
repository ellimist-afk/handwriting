/**
 * HOW FAR INK MOVES WHEN A CANVAS NOTE GOES FROM THE EDITOR TO READING VIEW. A measurement cell: it changes nothing.
 *
 * Alan's note "Untitled 1" (a canvas note, 14 lines: three of frontmatter, eleven of text, ten led by a tab, one
 * paragraph of hard breaks) holds 5,795 strokes, 1,249 of them carrying a line anchor. The ReadingViewInk rig's
 * Reading view is mounted with that note's text and ink, read from a copy of the vault's two files, and the plugin's
 * own code reads it: the header delta, whether `rowTopIn` gives exact rows for the text's lines, and each stroke's
 * correction with the guard that held it back. Painted pixels confirm a sample of strokes, and two screenshots show the
 * editor (a model) and Reading view.
 *
 * The guard cells: Reading view honours an anchor only as the editor would, under one signature (an open editor's, else
 * the newest anchored stroke's). At the editor's 9946 width, none of the 918 strokes anchored under eleven older widths
 * moves, the 9946 group moves as it did, and the 47 strokes anchored on a frontmatter line stay put.
 *
 * Input: HW_JUMP_DIR holds `Untitled 1.md` and `sidecar.json`. Output: HW_JUMP_OUT (results.json, per-stroke.csv, two
 * pngs). Run: npm run test:render -- ReadingViewJump.
 *
 * The stability cell needs no input: a small note (a nested list, a quote, a table, blank lines between), a stroke anchored
 * on each line, and the correction each is shown with while each section in turn leaves the sizer and comes back.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

declare const process: { env: Record<string, string | undefined> };

const IN = process.env.HW_JUMP_DIR ?? "";
const OUT = process.env.HW_JUMP_OUT ?? "";
const HAVE = IN !== "" && OUT !== "" && existsSync(`${IN}/Untitled 1.md`) && existsSync(`${IN}/sidecar.json`);
const TEXT = HAVE ? readFileSync(`${IN}/Untitled 1.md`, "utf8") : "";
const SIDECAR = HAVE ? readFileSync(`${IN}/sidecar.json`, "utf8") : "";
/** The editor's line tops (world units) as the sidecar's anchors recorded them for lines 4 to 14. */
const EDITOR_TOPS: Record<number, number> = { 4: 0, 5: 25.058, 6: 53.302, 7: 81.547, 8: 109.792, 9: 138.037, 10: 166.282, 11: 194.527, 12: 222.771, 13: 251.016, 14: 279.261 };

let browser: Browser;
let page: Page;
const errors: string[] = [];
const results: Record<string, unknown> = {};

beforeAll(async () => {
	if (HAVE) mkdirSync(OUT, { recursive: true });
	const b = await build({ entryPoints: [fileURLToPath(new URL("./readingViewJumpPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) } });
	browser = await chromium.launch({ headless: true });
	page = await browser.newPage({ viewport: { width: 900, height: 700 } });
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addStyleTag({ content: readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8") });
	await page.addScriptTag({ content: b.outputFiles[0]!.text });
});
afterAll(async () => {
	if (HAVE) writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
	await browser?.close();
});

const view = (o: Record<string, unknown>) => page.evaluate((k) => (window as any).jumpView(k), o) as Promise<any>;
const strip = (t: string) => t.replace(/\t/g, "");

it.skipIf(!HAVE)("loads the sidecar", async () => {
	const r = await page.evaluate((s) => (window as any).jumpLoad(s), SIDECAR);
	results.load = r;
	console.log("READING-VIEW-JUMP load", JSON.stringify(r));
	expect(r.strokes).toBe(5795);
	expect(r.damaged).toBe(false);
});

const VARIANTS = [
	{ name: "text as is, 12 px, line height 1.5, tabs eaten by the renderer", text: () => TEXT, font: 12, lh: 1.5, tabsInDom: false },
	{ name: "text as is, 12 px, line height 1.5, tabs kept in the DOM", text: () => TEXT, font: 12, lh: 1.5, tabsInDom: true },
	{ name: "tabs stripped from the text, 12 px, line height 1.5", text: () => strip(TEXT), font: 12, lh: 1.5, tabsInDom: false },
	{ name: "text as is, 12 px, line height 1.66 (the editor's pitch)", text: () => TEXT, font: 12, lh: 1.66, tabsInDom: false },
];
for (const v of VARIANTS) {
	it.skipIf(!HAVE)(`reading view: ${v.name}`, async () => {
		const r = await view({ text: v.text(), font: v.font, lh: v.lh, tabsInDom: v.tabsInDom, ids: [] });
		expect(r.error).toBeUndefined();
		const { csv, ...rest } = r;
		results[v.name] = rest;
		if (v === VARIANTS[0]) writeFileSync(`${OUT}/per-stroke.csv`, csv);
		console.log("READING-VIEW-JUMP", v.name, JSON.stringify({ ...rest, rowReport: undefined, lineStats: undefined }));
		console.log("READING-VIEW-JUMP rows", JSON.stringify(rest.rowReport));
		console.log("READING-VIEW-JUMP lines", JSON.stringify(rest.lineStats));
		expect(errors).toEqual([]);
	});
}

it.skipIf(!HAVE)("painted pixels confirm the corrections of a sample", async () => {
	const per = readFileSync(`${OUT}/per-stroke.csv`, "utf8").split("\n").slice(1).map((l) => l.split(","));
	// One moved stroke per anchored line, one held back per reason, and unanchored strokes at four heights.
	const sample: Array<{ id: string; kind: string; dyPx: number }> = [];
	const seenLine = new Set<string>(), seenWhy = new Set<string>();
	let free = 0;
	for (const c of per) {
		const [id, line, , y, why, , dyPx] = c as [string, string, string, string, string, string, string];
		if (line && why === '"moved"' && !seenLine.has(line)) { seenLine.add(line); sample.push({ id, kind: `moved, line ${line}`, dyPx: Number(dyPx) }); }
		else if (line && why !== '"moved"' && !seenWhy.has(why)) { seenWhy.add(why); sample.push({ id, kind: `held, ${why}`, dyPx: 0 }); }
		else if (!line && free < 4 && Number(y) > free * 400 - 100) { free++; sample.push({ id, kind: `free, y ${y}`, dyPx: 0 }); }
	}
	const rows = [];
	for (const s of sample) {
		const r = await page.evaluate((k) => (window as any).jumpPaint(k), { text: TEXT, font: 12, lh: 1.5, tabsInDom: false, ids: [s.id] });
		rows.push({ ...s, ...r, diff: r.error ? null : Math.round((r.movedPx - s.dyPx) * 100) / 100 });
	}
	results.painted = rows;
	for (const r of rows) console.log("READING-VIEW-JUMP painted", JSON.stringify(r));
	expect(rows.length).toBeGreaterThan(3);
	expect(errors).toEqual([]);
});

it.skipIf(!HAVE)("screenshots: the editor (a model) and Reading view", async () => {
	const base = { text: TEXT, font: 12, lh: 1.5, tabsInDom: false };
	const r = await page.evaluate((k) => (window as any).jumpShot(k), { ...base, ids: null, editor: true, bodyY: 325.5, tops: EDITOR_TOPS });
	results.editorShot = r;
	await page.setViewportSize({ width: 900, height: 700 });
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({ path: `${OUT}/editor-model.png` });
	const v = await page.evaluate((k) => (window as any).jumpShot(k), { ...base, ids: null });
	results.readingShot = v;
	await page.screenshot({ path: `${OUT}/reading-view.png` });
	expect(errors).toEqual([]);
});

/** The signature Alan's editor wrote the 331 newest anchors under. */
const SIG_9946 = { width: 9946, fontPx: 12, charWidth: 7.2 };

it.skipIf(!HAVE)("guard: an open editor at 9946 keeps the 918 older-width strokes where drawn, the 9946 group as it was", async () => {
	const r = await page.evaluate((k) => (window as any).jumpGuard(k), { text: TEXT, font: 12, lh: 1.5, tabsInDom: false, ids: [], sig: SIG_9946 });
	results.guardLive = r;
	console.log("READING-VIEW-JUMP guard live", JSON.stringify(r));
	expect(r.error).toBeUndefined();
	const others = Object.entries(r.groups).filter(([w]) => w !== "9946").map(([, g]) => g as any);
	const other = { n: others.reduce((a, g) => a + g.n, 0), moved: others.reduce((a, g) => a + g.moved, 0) };
	const own = r.groups["9946"];
	const frontmatter = Object.values(r.groups).reduce((a: number, g: any) => a + g.frontmatter, 0);
	const frontmatterMoved = Object.values(r.groups).reduce((a: number, g: any) => a + g.frontmatterMoved, 0);
	expect({ otherN: other.n, otherMoved: other.moved, ownDiffer: own.differ, frontmatter, frontmatterMoved }).toEqual({ otherN: 918, otherMoved: 0, ownDiffer: 0, frontmatter: 47, frontmatterMoved: 0 });
	expect(errors).toEqual([]);
});

it.skipIf(!HAVE)("guard: with no editor open, the newest anchored stroke's signature decides", async () => {
	const r = await page.evaluate((k) => (window as any).jumpGuard(k), { text: TEXT, font: 12, lh: 1.5, tabsInDom: false, ids: [], sig: null });
	results.guardNone = r;
	console.log("READING-VIEW-JUMP guard none", JSON.stringify(r));
	expect(r.error).toBeUndefined();
	const moved = Object.entries(r.groups).filter(([w]) => w !== String(r.newest.width)).reduce((a, [, g]: [string, any]) => a + g.moved, 0);
	expect(moved).toBe(0);
	expect(errors).toEqual([]);
});

it("stability: a stroke on a nested list, quote, table or blank line keeps its correction while a section is detached and attached again", async () => {
	const r = await page.evaluate((k) => (window as any).stableRun(k), { font: 12, lh: 1.5 });
	console.log("READING-VIEW-JUMP stable regime: chromium headless, 900x700 viewport, device scale factor 1, font 12 px, line height 1.5, zoom", r.zoom);
	console.log("READING-VIEW-JUMP stable rows", JSON.stringify(r.rows.map((x: any) => [x.line, x.section, Math.round(x.base * 1000) / 1000])));
	const tol = 0.001;
	const changes: string[] = [];
	for (const a of r.arms) {
		a.detached.forEach((d: number, k: number) => {
			if (Math.abs(d - r.rows[k].base) > tol) changes.push(`line ${r.rows[k].line} (${r.rows[k].section}) while "${a.section}" is detached: correction ${d.toFixed(3)}, attached ${r.rows[k].base.toFixed(3)}`);
		});
		a.reattached.forEach((d: number, k: number) => {
			if (Math.abs(d - r.rows[k].base) > tol) changes.push(`line ${r.rows[k].line} (${r.rows[k].section}) after "${a.section}" is attached again: correction ${d.toFixed(3)}, attached ${r.rows[k].base.toFixed(3)}`);
		});
	}
	console.log("READING-VIEW-JUMP stable arms", JSON.stringify(r.arms.map((a: any) => ({ section: a.section, othersMoved: a.othersMoved, blocksKept: a.blocksKept }))));
	expect(errors).toEqual([]);
	// Premises: the fixture exercises the mechanism and every arm measured what it says.
	expect(r.zoom, "premise: the note is drawn at zoom 1").toBe(1);
	expect(r.strokes, "premise: one stroke on each line from 4 to 20").toBe(17);
	expect(r.blocks, "premise: the view gives five blocks").toBe(5);
	expect(r.repeatable, "premise: two reads of the attached view give the same corrections").toBe(true);
	expect(r.rows.every((x: any) => Math.abs(x.base) > 0.05), "premise: every stroke is shown moved when attached").toBe(true);
	expect(r.arms.map((a: any) => a.section)).toEqual(["nested list", "quote", "table", "first paragraph", "last paragraph"]);
	for (const a of r.arms) {
		expect(a.connectedWhileOut, `premise: "${a.section}" was out of the sizer`).toBe(false);
		expect(a.othersMoved, `premise: the spacer held the other sections still while "${a.section}" was out`).toBeLessThan(0.01);
		expect(a.blocksKept, `premise: the view still knows all five blocks with "${a.section}" out`).toBe(5);
	}
	expect(changes, "the same stroke has the same correction attached, with a section detached, and attached again").toEqual([]);
});
