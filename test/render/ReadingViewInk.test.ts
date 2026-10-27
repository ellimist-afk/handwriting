/**
 * INK IN READING VIEW AND IN AN EXPORT IS DRAWN ON ITS WORDS.
 *
 * Reading view and Export to PDF lay a note's text out by their own rules: an inline title and a Properties block
 * above the text, blank lines folded into paragraph margins. A stroke held at its page position came off the words it
 * was written on, more the further down the note. A stroke that carries a line anchor is now drawn at its page
 * position plus how far its line sits lower in the view than it did in the editor (src/inline/EmbedInkLines.ts).
 *
 * The note (readingViewInkPage.ts): a frontmatter, three one-line paragraphs with two blank lines between each, a
 * three-item list whose second item wraps, a fenced code block of four rows (the second empty) and a paragraph of three
 * lines joined by hard breaks (the first wraps); the editor is modelled as 24 px lines with the frontmatter hidden. One
 * stroke per case, anchored where the editor would anchor it, painted in the view, and its painted centre compared
 * with where it belongs: its block's top plus its offset under its line (a paragraph's first line, exact), one rendered
 * line above the block or at its bottom (a blank line, riding the nearest paragraph), or its row's own top inside a
 * block of several lines (a list item, a code row, a line after a hard break; exact, where the line's share of the
 * block's height would not be).
 * Reading view is post-processed per section with section info; the export once with none, from cached sections.
 * Three reading view cells follow the sections the virtualised renderer attaches and detaches in the sizer on
 * scroll: a section attached after the paint is placed again, a batch of such changes reads no layout and queues one
 * replace, and the teardown leaves no observer on the sizer.
 *
 * Run: npm run test:render -- ReadingViewInk.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import type { InkCase } from "./readingViewInkPage";

/** Reading view and print geometry: the parts the cases read. Not Obsidian's stylesheet; the rules a view applies. */
const VIEW_CSS = `
body { margin: 0; font-family: sans-serif; }
.markdown-preview-view { font-size: 16px; line-height: 1.5; padding: 32px; position: relative; overflow-y: auto; box-sizing: border-box; width: 100%; }
.markdown-rendered > :first-child { margin-top: 0; }
.markdown-rendered p, .markdown-rendered ul { margin-block-start: 1rem; margin-block-end: 1rem; }
.markdown-rendered h1 { font-size: 1.618em; line-height: 1.2; margin-block-start: 1rem; margin-block-end: 1rem; }
.markdown-preview-sizer { max-width: 700px; margin: 0 auto; }
.inline-title { font-size: 2em; line-height: 1.2; font-weight: 700; margin-bottom: 0.5em; }
.metadata-container { padding: 8px 0; }
.metadata-property { height: 30px; }
.mod-frontmatter { display: none; }
.markdown-rendered pre { position: relative; padding: 12px 16px; min-height: 38px; white-space: pre-wrap; overflow-x: auto; }
.markdown-rendered code { font-family: monospace; font-size: 0.875em; padding: 0.15em 0.3em; }
.markdown-rendered pre code { padding: 0; }
`;

const CASES: InkCase[] = [
	{ name: "first paragraph, its line", line: 4, off: 12, block: 3, rule: "top" },
	{ name: "circle on 'is second'", line: 7, off: 12, block: 6, rule: "top" },
	{ name: "underline under 'pargaph'", line: 10, off: 22, block: 9, rule: "top" },
	{ name: "first blank line after the middle paragraph rides it", line: 8, off: 10, block: 6, rule: "below" },
	{ name: "second blank line rides the third paragraph", line: 9, off: 10, block: 9, rule: "above" },
	{ name: "the list's third item, after a wrapped one, at its own top", line: 14, off: 12, block: 11, rule: { item: 2 } },
	{ name: "a code block's empty row", line: 18, off: 10, block: 15, rule: { row: 1 } },
	{ name: "a code block's last row, after an empty one", line: 20, off: 10, block: 15, rule: { row: 3 } },
	{ name: "the third line of a hard-break paragraph whose first line wraps", line: 25, off: 12, block: 22, rule: { brk: 2 } },
];
const NAMED = CASES.map((c) => [c.name, c] as const);

let browser: Browser;
let page: Page;
const errors: string[] = [];
beforeAll(async () => {
	const b = await build({ entryPoints: [fileURLToPath(new URL("./readingViewInkPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) } });
	browser = await chromium.launch({ headless: true });
	page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addStyleTag({ content: VIEW_CSS });
	await page.addStyleTag({ content: readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8") });
	await page.addScriptTag({ content: b.outputFiles[0]!.text });
});
afterAll(async () => { await browser?.close(); });

const frames = () => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

it.each(NAMED)("reading view: %s, painted within 1 px of where its line is rendered", async (_name, c) => {
	const r = await page.evaluate((k) => (window as any).readingView(k), c);
	console.log("READING-VIEW-INK", _name, JSON.stringify(r));
	expect(r.error, "a layer was painted").toBeUndefined();
	expect(Math.abs(r.dy) <= 1, `painted ${r.painted} minus wanted ${r.want}: ${r.dy}`).toBe(true);
	if (typeof c.rule === "object") expect(Math.abs(r.want - r.estimate) > 2, `the case discriminates: the estimate ${r.estimate}`).toBe(true);
	expect(errors).toEqual([]);
});

it("reading view: a stroke with no anchor keeps its page position", async () => {
	const r = await page.evaluate((k) => (window as any).readingView(k), { name: "none", line: 0, off: 40, block: 3, rule: "top" });
	console.log("READING-VIEW-INK unanchored", JSON.stringify(r));
	expect(Math.abs(r.dy) <= 1, `painted ${r.painted} minus page position ${r.want}: ${r.dy}`).toBe(true);
});

it("reading view: a section the renderer attaches after the paint is placed on its line, with no resize and no new render", async () => {
	const r = await page.evaluate((k) => (window as any).reattach(k), CASES[1]!);
	console.log("READING-VIEW-INK reattach", JSON.stringify(r));
	expect(r.error, "a layer was painted").toBeUndefined();
	expect(Math.abs(r.dy) <= 1, `painted ${r.painted} minus wanted ${r.want}: ${r.dy}`).toBe(true);
	expect(Math.abs(r.before - r.want) > 5, `the case discriminates: before the attach ${r.before}`).toBe(true);
	expect(errors).toEqual([]);
});

it("reading view: a batch of sections changed in the sizer reads no layout and queues one replace", async () => {
	const r = await page.evaluate((k) => (window as any).sizerBatch(k), CASES[1]!);
	console.log("READING-VIEW-INK sizer batch", JSON.stringify(r));
	expect({ reads: r.reads, queued: r.queued }, `read: ${r.where.join("; ")}`).toEqual({ reads: 0, queued: 1 });
	expect(errors).toEqual([]);
});

it("reading view: the teardown leaves no observer on the sizer", async () => {
	const r = await page.evaluate((k) => (window as any).sizerWatch(k), CASES[1]!);
	console.log("READING-VIEW-INK sizer watch", JSON.stringify(r));
	expect(r.watching, "the sections in the sizer are watched while the view is").toBeGreaterThan(0);
	expect(r.afterTeardown).toBe(0);
});

it.each(NAMED)("export: %s, on its line in the screen layer and in the print layer", async (_name, c) => {
	const r = await page.evaluate((k) => (window as any).exportPrint(k, false), c);
	await page.evaluate(() => (window as any).endPrint());
	console.log("READING-VIEW-INK export", _name, JSON.stringify(r));
	expect({ canvas: Math.abs(r.canvas - r.canvasWant) <= 1, svg: Math.abs(r.svg - r.svgWant) <= 1 },
		`canvas ${r.canvas} want ${r.canvasWant}; print layer ${r.svg} want ${r.svgWant}`).toEqual({ canvas: true, svg: true });
	expect(errors).toEqual([]);
});

it.each(NAMED.slice(1, 3))("export, print media: %s, in the strip cut for its block", async (_name, c) => {
	await page.evaluate((k) => (window as any).exportPrint(k, false), c);
	await page.emulateMedia({ media: "print" });
	await frames();
	const r = await page.evaluate((k) => (window as any).printStrips(k), c);
	await page.emulateMedia({ media: "screen" });
	await page.evaluate(() => (window as any).endPrint());
	console.log("READING-VIEW-INK strips", _name, JSON.stringify(r));
	expect(r.strips, "the print media cut the layer into strips").toBeGreaterThan(0);
	expect(Math.abs(r.painted - r.want) <= 1, `painted ${r.painted} want ${r.want}`).toBe(true);
	expect(errors).toEqual([]);
});

it("export: before the note's text is read the stroke keeps its page position; once read, it is on its line", async () => {
	const c = CASES[1]!;
	const r = await page.evaluate((k) => (window as any).exportPrint(k, true), c);
	await page.evaluate(() => (window as any).endPrint());
	console.log("READING-VIEW-INK late text", JSON.stringify(r));
	expect(Math.abs(r.before - r.pagePosition) <= 1, `before the text ${r.before}, page position ${r.pagePosition}`).toBe(true);
	expect(Math.abs(r.canvas - r.canvasWant) <= 1, `after the text ${r.canvas}, want ${r.canvasWant}`).toBe(true);
	expect(Math.abs(r.pagePosition - r.canvasWant) > 5, "the case discriminates: page position is off the line").toBe(true);
});
