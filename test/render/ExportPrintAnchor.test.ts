/**
 * EXPORTED INK LANDS ON THE WORD IT WAS DRAWN ON.
 *
 * Obsidian's Export to PDF renders the note into a container of its own: a
 * `.markdown-preview-view.markdown-rendered` with no sizer, the file name as an
 * `h1` only when the export dialog says so, and every top-level block wrapped
 * in its own div. The post-processors run once on that container, so the ink
 * layer is appended to it and anchored by the print branch of `anchorLayer`.
 *
 * Editor x 0 is the text column's left edge and editor y 0 is the first text
 * line's top. A cross is drawn, in note space, on the centre of the first word;
 * the painted cross must land on that word in the exported page, with the file
 * name on and off, for the canvas layer and the vector layer a print swaps in,
 * and with a second page margin (the side-panel value) so the anchor is read
 * from the page rather than assumed.
 *
 * The page's geometry comes from Obsidian's real stylesheet: every rule below
 * is a verbatim slice of app.css 1.13.7 (637090 bytes, sha256
 * f612f1e8f36486fa57f3b8bd45f0c848409d5b168002e757a13c6d286a7b4c41), cited by
 * line, plus this plugin's own styles.css, which the export window copies.
 * Fonts are the browser's fallback; the word's position moves with the font,
 * the offset between ink and word does not.
 *
 * Run: npm run test:render -- ExportPrintAnchor.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

const OBSIDIAN_PRINT_CSS = `
/* app.css:2240-2244 */
body {
  --file-line-width: 700px;
  --file-folding-offset: 24px;
  --file-margins: var(--file-margins-y) var(--file-margins-x);
  --file-margins-x: var(--size-4-8);
  --file-margins-y: var(--size-4-8);
}
/* app.css:2577, 2321, 2421, 2002, 2662, 3122, 2327 (custom properties the rules below read) */
body { --p-spacing: 1rem; --h1-line-height: 1.2; --line-height-normal: 1.5; --h1-weight: 700; --size-4-8: 32px; --font-text-size: 16px; --h1-size: 1.618em; }
/* app.css:4464-4478 */
.markdown-preview-view {
  font-size: var(--font-text-size);
  font-family: var(--font-text);
  line-height: var(--line-height-normal);
  width: 100%;
  height: 100%;
  padding: var(--file-margins);
  position: relative;
  overflow-y: auto;
  overflow-wrap: break-word;
  color: var(--text-normal);
  user-select: text;
  -webkit-user-select: text;
  scrollbar-gutter: stable;
}
/* app.css:4495-4500 */
.markdown-rendered > :first-child {
  margin-top: 0;
}
.markdown-rendered > :last-child {
  margin-bottom: 0;
}
/* app.css:12762-12782 */
h1,
h2,
h3,
h4,
h5,
h6 {
  margin-block-start: var(--p-spacing);
  margin-block-end: var(--p-spacing);
}
h1,
.markdown-rendered h1 {
  --font-weight: var(--h1-weight);
  font-variant: var(--h1-variant);
  letter-spacing: var(--h1-letter-spacing);
  line-height: var(--h1-line-height);
  font-size: var(--h1-size);
  color: var(--h1-color);
  font-weight: var(--font-weight);
  font-style: var(--h1-style);
  font-family: var(--h1-font);
}
/* app.css:14167-14171 */
.markdown-rendered p {
  margin-block-start: var(--p-spacing);
  margin-block-end: var(--p-spacing);
  unicode-bidi: plaintext;
}
/* app.css:3126-3132, inside @media print at 3125 (applied as plain rules: the export prints this window) */
html,
body {
  padding-top: 0 !important;
  overflow: auto !important;
  height: auto !important;
  contain: initial !important;
}
/* app.css:3146-3150, same @media print block */
.print .markdown-preview-view {
  -webkit-print-color-adjust: exact;
  color: initial;
  height: unset !important;
}
`;

const PAGE = `
import { attachEmbedInkOnceReady, initEmbedInkRefresh, teardownEmbedInk } from "../../src/inline/EmbedInk";
import { installObsidianDom } from "./obsidianDom";

installObsidianDom();
const proto = HTMLElement.prototype;
proto.setCssStyles ??= function (s) { for (const k of Object.keys(s)) this.style[k] = s[k]; };
window.createDiv ??= () => document.createElement("div");

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const r2 = v => Math.round(v * 100) / 100;
function stroke(id, pts) {
	const points = pts.map(([x, y], j) => ({ x, y, pressure: 0.5, t: j * 9 }));
	const xs = points.map(p => p.x), ys = points.map(p => p.y), pad = 4;
	return { id, tool: "pen", color: "#ff00ff", width: 3, createdAt: 0, points,
		bbox: { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, width: Math.max(...xs) - Math.min(...xs) + 2 * pad, height: Math.max(...ys) - Math.min(...ys) + 2 * pad } };
}
const line = (id, x0, y0, x1, y1) => stroke(id, Array.from({ length: 12 }, (_, j) => [x0 + (x1 - x0) * j / 11, y0 + (y1 - y0) * j / 11]));

/** The page Obsidian's print() builds: div.print > view; the optional h1; each block in its own div; no sizer. */
window.exportPrint = async (includeName, mode, margin) => {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "theme-light";
	if (margin) document.body.style.setProperty("--file-margins", margin); else document.body.style.removeProperty("--file-margins");
	const print = document.body.appendChild(document.createElement("div")); print.className = "print";
	const root = print.appendChild(document.createElement("div")); root.className = "markdown-preview-view markdown-rendered";
	if (includeName) { const h = root.appendChild(document.createElement("h1")); h.textContent = "Export note"; }
	const block = html => { const d = root.appendChild(document.createElement("div")); d.innerHTML = html; };
	block('<p><span id="w1">Handwriting</span> sits on the first line of this paper note, then a second word follows and the line runs on for a while.</p>');
	block("<p>A second paragraph, so the page has more than one block.</p>");
	await frame();
	const p = root.querySelector("p"), w = document.getElementById("w1");
	const pr = p.getBoundingClientRect(), wr = w.getBoundingClientRect();
	// Note space: x 0 is the text column's left, y 0 the first line's top. The cross sits on the first word's centre.
	const cx = r2(wr.left + wr.width / 2 - pr.left), cy = r2(wr.top + wr.height / 2 - pr.top);
	const strokes = [line("h", cx - 18, cy, cx + 18, cy), line("v", cx, cy - 18, cx, cy + 18)];
	initEmbedInkRefresh(() => strokes);
	attachEmbedInkOnceReady(root, root, "export-print.md", () => strokes);
	await frame(); await frame();
	if (mode === "svg") { window.dispatchEvent(new Event("beforeprint")); await frame(); await frame(); }
	const layer = root.querySelector(mode === "svg" ? ":scope > svg.handwriting-embed-ink" : ":scope > canvas.handwriting-embed-ink");
	if (!layer) return { error: "no " + mode + " layer" };
	const lr = layer.getBoundingClientRect();
	let painted;
	if (mode === "canvas") {
		// Where the cross is actually painted: the bounding box of its pixels.
		const g = layer.getContext("2d"), d = g.getImageData(0, 0, layer.width, layer.height).data;
		let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
		for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) if (d[(y * layer.width + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
		if (x1 < 0) return { error: "nothing painted" };
		const sx = layer.width / lr.width, sy = layer.height / lr.height;
		painted = { x: lr.left + ((x0 + x1 + 1) / 2) / sx, y: lr.top + ((y0 + y1 + 1) / 2) / sy };
	} else {
		// The vector layer draws note coordinates through its viewBox.
		const vb = (layer.getAttribute("viewBox") || "0 0 0 0").split(" ").map(Number);
		painted = { x: lr.left + cx - vb[0], y: lr.top + cy - vb[1] };
	}
	if (mode === "svg") { window.dispatchEvent(new Event("afterprint")); await frame(); }
	const word = { x: wr.left + wr.width / 2, y: wr.top + wr.height / 2 };
	return { padding: getComputedStyle(root).padding, textLeft: r2(pr.left - root.getBoundingClientRect().left),
		dx: r2(painted.x - word.x), dy: r2(painted.y - word.y) };
};
`;

let browser: Browser;
let page: Page;
const errors: string[] = [];
beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "exportPrintAnchorPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) } });
	browser = await chromium.launch({ headless: true });
	page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
	page.on("pageerror", error => errors.push(error.message));
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addStyleTag({ content: OBSIDIAN_PRINT_CSS });
	await page.addStyleTag({ content: readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8") });
	await page.addScriptTag({ content: b.outputFiles[0]!.text });
});
afterAll(async () => { await browser?.close(); });

const CASES: Array<[string, boolean, "canvas" | "svg", string | null, string]> = [
	["file name on, canvas", true, "canvas", null, "32px"],
	["file name on, vector print layer", true, "svg", null, "32px"],
	["file name off, canvas", false, "canvas", null, "32px"],
	["file name off, vector print layer", false, "svg", null, "32px"],
	["file name off, side-panel margins, canvas", false, "canvas", "20px", "20px"],
	["file name on, side-panel margins, vector print layer", true, "svg", "20px", "20px"],
];

it.each(CASES)("%s: the exported cross lands on the word it was drawn on, within 1 px", async (_name, includeName, mode, margin, padding) => {
	const r = await page.evaluate(([n, m, g]) => (window as any).exportPrint(n, m, g), [includeName, mode, margin] as const);
	console.log("EXPORT-PRINT-ANCHOR", _name, JSON.stringify(r));
	expect(r.error, "the page built and painted a layer").toBeUndefined();
	// The page really is the export's shape: the text column starts inside the root's padding.
	expect(r.padding).toBe(padding);
	expect(r.textLeft).toBe(parseFloat(padding));
	// Painted cross centre minus word centre, page px: both within 1 px, reported together.
	expect({ x: Math.abs(r.dx) <= 1, y: Math.abs(r.dy) <= 1 }, `painted cross minus word centre: x ${r.dx}, y ${r.dy}`).toEqual({ x: true, y: true });
	expect(errors).toEqual([]);
});
