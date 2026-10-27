/**
 * EXPORTED INK IS PRINTED WHOLE, NOT CUT AT THE TEXT'S BOTTOM EDGE.
 *
 * Obsidian's Export to PDF renders the note into a container of its own: a
 * `.markdown-preview-view.markdown-rendered` with no sizer, the file name as an
 * `h1` only when the export dialog says so, and every top-level block wrapped
 * in its own div. The print rules size that container to its text and make
 * html and body scroll containers of the same height, so an absolutely
 * positioned ink layer that runs below the text is cut off the page: a note
 * with a Properties box (not printed) and a few empty lines printed only a
 * strip from the top of its ink.
 *
 * The page here is that container with three empty paragraphs and a line of
 * ink 600 px tall with a bar across its foot. A screenshot counts the rows the
 * ink paints, with the file name on and off, for the canvas (an export that
 * fires no print event) and for the vector layer a print swaps in. One more
 * case narrows the page at print time so the file name wraps onto a second
 * line, which moves the ink down after it was painted; and a reading view
 * printed alongside keeps its own height.
 *
 * The page's geometry comes from Obsidian's real stylesheet: every rule below
 * is a verbatim slice of app.css 1.13.7 (637090 bytes, sha256
 * f612f1e8f36486fa57f3b8bd45f0c848409d5b168002e757a13c6d286a7b4c41), cited by
 * line, plus this plugin's own styles.css, which the export window copies.
 *
 * Run: npm run test:render -- ExportPrintClip.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { decodePng } from "./pngInk";

const OBSIDIAN_PRINT_CSS = `
/* app.css:3190-3192 */
* {
  box-sizing: border-box;
}
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
const line = (id, x0, y0, x1, y1, n = 61) => stroke(id, Array.from({ length: n }, (_, j) => [x0 + (x1 - x0) * j / (n - 1), y0 + (y1 - y0) * j / (n - 1)]));
const MIN_ATTR = "data-handwriting-embed-min-height";

let open = null;

/**
 * The page Obsidian's print() builds: div.print > view; the optional h1; three empty paragraphs, each in its own div;
 * no sizer. Ink: a vertical line from the first line's top to 600 px below it, and a bar across its foot. mode "svg"
 * dispatches beforeprint (the print swap); "canvas" fires no print event. narrowAtPrint narrows the page just before
 * the print starts, so a title that fits on one line wraps onto two.
 */
window.exportClip = async (includeName, mode, narrowAtPrint) => {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "theme-light";
	const print = document.body.appendChild(document.createElement("div")); print.className = "print";
	const root = print.appendChild(document.createElement("div")); root.className = "markdown-preview-view markdown-rendered";
	if (includeName) { const h = root.appendChild(document.createElement("h1")); h.textContent = "Export note with a longer title"; }
	let lastBlock = null;
	for (let i = 0; i < 3; i++) { lastBlock = root.appendChild(document.createElement("div")); lastBlock.innerHTML = "<p></p>"; }
	await frame();
	const strokes = [line("v", 40, 0, 40, 600), line("b", 10, 600, 70, 600, 13)];
	initEmbedInkRefresh(() => strokes);
	attachEmbedInkOnceReady(root, root, "export-clip.md", () => strokes);
	await frame(); await frame();
	const title = root.querySelector(":scope > h1");
	const screenTitleH = title ? title.offsetHeight : 0;
	if (narrowAtPrint) print.style.width = "360px";
	if (mode === "svg") { window.dispatchEvent(new Event("beforeprint")); await frame(); await frame(); }
	const layer = root.querySelector(mode === "svg" ? ":scope > svg.handwriting-embed-ink" : ":scope > canvas.handwriting-embed-ink");
	open = { mode };
	if (!layer) return { error: "no " + mode + " layer" };
	const lr = layer.getBoundingClientRect(), rr = root.getBoundingClientRect();
	const textBottom = r2(lastBlock.getBoundingClientRect().bottom);
	return { textBottom, rootBottom: r2(rr.bottom), layerBottom: r2(lr.bottom), minHeight: root.style.minHeight,
		titleGrew: title ? r2(title.offsetHeight - screenTitleH) : 0,
		// The strip the line and its foot bar run down, the whole viewport tall.
		strip: { x: Math.max(0, Math.floor(lr.left + 40 - 8)), y: 0, width: 16, height: window.innerHeight } };
};

/** End a print the last call started, if it started one. */
window.exportClipEnd = async () => {
	if (open && open.mode === "svg") { window.dispatchEvent(new Event("afterprint")); await frame(); }
	open = null;
};

/** A reading view (a sizer root) printed: it is not the print container and must not be grown. */
window.readingViewPrint = async () => {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "theme-light";
	const root = document.body.appendChild(document.createElement("div")); root.className = "markdown-preview-view markdown-rendered";
	const sizer = root.appendChild(document.createElement("div")); sizer.className = "markdown-preview-sizer markdown-preview-section";
	for (let i = 0; i < 3; i++) { const d = sizer.appendChild(document.createElement("div")); d.innerHTML = "<p></p>"; }
	await frame();
	const strokes = [line("v", 40, 0, 40, 600), line("b", 10, 600, 70, 600, 13)];
	initEmbedInkRefresh(() => strokes);
	attachEmbedInkOnceReady(root, root, "reading-view.md", () => strokes);
	await frame(); await frame();
	const painted = { attr: root.getAttribute(MIN_ATTR), minHeight: root.style.minHeight };
	window.dispatchEvent(new Event("beforeprint")); await frame(); await frame();
	const printing = { attr: root.getAttribute(MIN_ATTR), minHeight: root.style.minHeight, svg: !!root.querySelector(":scope > svg.handwriting-embed-ink") };
	window.dispatchEvent(new Event("afterprint")); await frame();
	return { painted, printing };
};
`;

let browser: Browser;
let page: Page;
const errors: string[] = [];
beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "exportPrintClipPage.ts" },
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

/** Rows of the screenshot strip with at least one magenta pixel (the strokes' #ff00ff), and the first and last. */
async function paintedRows(strip: { x: number; y: number; width: number; height: number }) {
	const d = decodePng(await page.screenshot({ clip: strip }));
	let rows = 0, first = -1, last = -1;
	for (let y = 0; y < d.height; y++) {
		for (let x = 0; x < d.width; x++) {
			const o = (y * d.width + x) * d.channels;
			if (d.px[o]! >= 200 && d.px[o + 1]! <= 100 && d.px[o + 2]! >= 200) { rows++; if (first < 0) first = y; last = y; break; }
		}
	}
	return { rows, first, last };
}

const CASES: Array<[string, boolean, "canvas" | "svg", boolean]> = [
	["file name on, canvas, no print event", true, "canvas", false],
	["file name on, vector print layer", true, "svg", false],
	["file name off, canvas, no print event", false, "canvas", false],
	["file name off, vector print layer", false, "svg", false],
	["file name on, vector print layer, page narrowed at print so the title wraps", true, "svg", true],
];

it.each(CASES)("%s: the whole 600 px line of ink is painted on the exported page", async (_name, includeName, mode, narrow) => {
	const r = await page.evaluate(([n, m, w]) => (window as any).exportClip(n, m, w), [includeName, mode, narrow] as const);
	const painted = r.error ? null : await paintedRows(r.strip);
	await page.evaluate(() => (window as any).exportClipEnd());
	console.log("EXPORT-PRINT-CLIP", _name, JSON.stringify({ ...r, painted }));
	expect(r.error, "the page built and painted a layer").toBeUndefined();
	// The fixture is the clipping case: the ink runs at least 400 px below the bottom of the text.
	expect(r.layerBottom - r.textBottom).toBeGreaterThan(400);
	if (narrow) expect(r.titleGrew, "the title wrapped onto a second line at print").toBeGreaterThan(20);
	// The line is 600 px plus its stroke; a cut page paints only the rows above the text's bottom edge.
	expect(painted!.rows, `painted rows ${painted!.first}-${painted!.last}, root bottom ${r.rootBottom}, layer bottom ${r.layerBottom}`).toBeGreaterThanOrEqual(590);
	expect(errors).toEqual([]);
});

it("a reading view printed alongside is not grown: its sizer holds the room, the attribute never lands on it", async () => {
	const r = await page.evaluate(() => (window as any).readingViewPrint());
	console.log("EXPORT-PRINT-CLIP reading view", JSON.stringify(r));
	expect(r.printing.svg, "the print swap ran on the reading view").toBe(true);
	expect(r).toEqual({ painted: { attr: null, minHeight: "" }, printing: { attr: null, minHeight: "", svg: true } });
	expect(errors).toEqual([]);
});
