/**
 * AN EMBEDDED NOTE'S INK PRINTS ON ITS WORDS IN AN EXPORT, DESKTOP AND PHONE OR TABLET; ON SCREEN NOTHING MOVES.
 *
 * In an export Obsidian draws an embed as its static embed (app.js 1.15.1: the PDF export @2684038 renders with
 * displayMode set, the registry @2328651 picks _5): span > .markdown-embed-content > .markdown-preview-view with the note's
 * blocks straight in the view, no sizer. The view carries the embed padding (`.inline-embed > .markdown-embed-content >
 * .markdown-preview-view { padding: var(--embed-padding) }`, 24 px left). The ink layer's left is the text column's inset
 * in the content box (columnInset, EmbedInk.ts): read from the content box's children, the view alone, it was 0, and the
 * ink printed about 24 px left of its words. In an export div the view's own children are read, so it is 24.
 *
 * Export cells (D desktop, M phone and tablet; one embed of an inked note in a host note, the page and readers of
 * ExportMobilePdf.test.ts): each marked word's cross less its word's centre, paired by order down the page, in css px
 * (page px over the print's zoom). Three shapes: real (anchored ink, the shipped shape), legacy (ink saved before
 * anchors), sizer (the same blocks in a sizer: the control, whose column read was always right).
 *   D1, D2, M1, M2: each word's x within 0.1 px of the control's; its y as at base within 0.01 (the fix moves no ink up or
 *   down). Red at base by about 24 in x.
 *   D3, M3: the control's words as at base within 0.01 in x and y (a fix that moved the control would pass D1 and D2).
 *   Every case: the host's words as at base within 0.01.
 * Screen cells (S1 to S4): the same embed on screen, in a reading view and in Live Preview, as Obsidian draws it there
 * (dr: with a sizer) and as a static embed (_5: no sizer, drawn by slides, other plugins' MarkdownRenderer.render and
 * Live Preview code blocks). Each word's cross less its word as at base within 0.01. The static embed stays about 24 px
 * left on screen (this fix leaves it); its look in the running app is a separate job.
 *
 * Base pins are the reads of the red-first run at e4a19340 with no source change.
 *
 * Env: HW_OBSIDIAN_ASAR (required; every cell skips with a loud line without it, so CI skips them; the unit cells in
 * src/inline/EmbedInkColumn.test.ts are the CI guard), HW_EMP_OUT (a directory that keeps each PDF).
 *
 * Run: npm run test:render -- ExportEmbedInkDesktop.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

/** The asar is read as bytes; test/render/node-builtins.d.ts declares only the utf8 read. */
declare module "node:fs" { export function readFileSync(path: string): Uint8Array; }
declare const process: { env: Record<string, string | undefined> };
type Bytes = Awaited<ReturnType<Page["pdf"]>>;
const utf8 = (b: Uint8Array) => new TextDecoder("utf-8").decode(b);

const ASAR = process.env.HW_OBSIDIAN_ASAR ?? "";
const HAVE_ASAR = ASAR !== "" && existsSync(ASAR);
const SHAPE_DIR = process.env.HW_SHAPE_DIR ?? "";
const HAVE_SHAPE = HAVE_ASAR && SHAPE_DIR !== "" && existsSync(`${SHAPE_DIR}/Untitled 1.md`) && existsSync(`${SHAPE_DIR}/sidecar.json`);
const PLANT = process.env.HW_EMP_PLANT ?? "";
const OUT = process.env.HW_EMP_OUT ?? "";
if (!HAVE_ASAR) console.log("EXPORT-EMBED-INK-DESKTOP SKIP: HW_OBSIDIAN_ASAR is unset or missing; every cell in this file is skipped");
if (HAVE_ASAR && !HAVE_SHAPE) console.log("EXPORT-EMBED-INK-DESKTOP SKIP C8: HW_SHAPE_DIR is unset or lacks Untitled 1.md and sidecar.json");
if (PLANT) console.log("EXPORT-EMBED-INK-DESKTOP PLANT", PLANT);
const itA = (HAVE_ASAR ? it : it.skip) as typeof it;
const itShape = (HAVE_SHAPE ? it : it.skip) as typeof it;
const T = 180_000;

/** One file out of an asar archive: header length at 4, JSON length at 12, JSON at 16, files after 8 + header length. */
function asarFile(asar: Uint8Array, path: string): Uint8Array {
	const dv = new DataView(asar.buffer, asar.byteOffset, asar.byteLength);
	const jsonLen = dv.getUint32(12, true);
	const header = JSON.parse(utf8(asar.subarray(16, 16 + jsonLen))) as { files: Record<string, unknown> };
	const base = 8 + dv.getUint32(4, true);
	let node = header as unknown as { files?: Record<string, unknown>; offset?: string; size?: number };
	for (const part of path.split("/")) node = node.files![part] as typeof node;
	const off = Number(node.offset);
	return asar.subarray(base + off, base + off + node.size!);
}

/** Test instrument, not Obsidian's: the marked words print a green box the reader finds. */
const INSTRUMENT_CSS = ".mark-word{background:#00ff00}";

/** ExportPrintAnchor.test.ts's page CSS, verbatim (app.css 1.13.7 slices): the desktop export shape C9 calibrates on. */
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

/** Counts the MutationObservers watching body, before the plugin loads (C5d). */
const OBSERVER_COUNT = `(() => {
	const live = new Set();
	const observe = MutationObserver.prototype.observe, disconnect = MutationObserver.prototype.disconnect;
	MutationObserver.prototype.observe = function (target, options) { if (target === document.body) live.add(this); return observe.call(this, target, options); };
	MutationObserver.prototype.disconnect = function () { live.delete(this); return disconnect.call(this); };
	window.__bodyObservers = () => live.size;
})();`;

const PAGE = `
import { Platform } from "obsidian";
import { attachEmbedInkOnceReady, embedInkChanged, initEmbedInkColumnWidth, initEmbedInkRefresh, teardownEmbedInk } from "../../src/inline/EmbedInk";
import { disarmPrintSwaps, embedInkPrintSwaps, initEmbedInkPrintCanvas, initEmbedInkPrintPaper, releasePrintStrips } from "../../src/inline/EmbedInkPrint";
import { aboveOf, lineKey, newAboveRun } from "../../src/inline/LineAnchor";
import { installObsidianDom } from "./obsidianDom";

installObsidianDom();
const proto = HTMLElement.prototype;
proto.setCssStyles ??= function (s) { for (const k of Object.keys(s)) this.style[k] = s[k]; };
window.createDiv ??= () => document.createElement("div");

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const r2 = v => Math.round(v * 100) / 100;
const PATH = "Tablet note.md";

function stroke(id, pts, o) {
	const width = o.width ?? 3;
	const points = pts.map(([x, y], j) => ({ x, y, pressure: 0.5, t: j * 9 }));
	const xs = points.map(p => p.x), ys = points.map(p => p.y), pad = 4 + width / 2;
	const s = { id, tool: o.tool ?? "pen", color: o.color ?? "#ff00ff", width, createdAt: 0, points,
		bbox: { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, width: Math.max(...xs) - Math.min(...xs) + 2 * pad, height: Math.max(...ys) - Math.min(...ys) + 2 * pad } };
	if (o.anchor) s.lineAnchor = { ...o.anchor, y: s.bbox.y };
	return s;
}
const line = (id, x0, y0, x1, y1, o = {}) => stroke(id, Array.from({ length: 12 }, (_, j) => [x0 + (x1 - x0) * j / 11, y0 + (y1 - y0) * j / 11]), o);

/** One block's paragraph; each marked word wrapped in a green span m<k>. */
function blockHtml(text, i, marks) {
	const words = text.split(" ");
	marks.forEach((m, k) => { if (m.block === i) words[m.word] = '<span class="mark-word" id="m' + k + '">' + words[m.word] + '</span>'; });
	return "<p>" + words.join(" ") + "</p>";
}
function fillRoot(root, o) {
	if (o.includeName) { const h = root.appendChild(document.createElement("h1")); h.textContent = "Tablet note"; }
	return o.blocks.map((t, i) => { const d = root.appendChild(document.createElement("div")); d.innerHTML = blockHtml(t, i, o.marks); return d; });
}

/** Mark centres in a host whose first p is note space's origin (x 0 the column's left, y 0 the first line's top). */
function readMarks(host, marks) {
	const p0 = host.querySelector("p").getBoundingClientRect();
	return marks.map((m, k) => { const w = host.querySelector("#m" + k).getBoundingClientRect();
		return { x: r2(w.left + w.width / 2 - p0.left), y: r2(w.top + w.height / 2 - p0.top), h: r2(w.height) }; });
}

/**
 * Note space is the editor's: a view of the note at the column width stands in for the editor. Each mark's centre and
 * each block's top are read there, then again with the print font on the same column: how far a re-wrap moves each mark.
 */
async function noteSpace(o) {
	const probe = document.body.appendChild(document.createElement("div"));
	probe.className = "markdown-preview-view markdown-rendered";
	probe.style.cssText = "position:absolute;left:0;top:0;height:auto;padding:0;overflow:visible;width:" + o.column + "px";
	o.blocks.forEach((t, i) => { const d = probe.appendChild(document.createElement("div")); d.innerHTML = blockHtml(t, i, o.marks); });
	await frame();
	const p0 = probe.querySelector("p").getBoundingClientRect();
	const centres = readMarks(probe, o.marks);
	const blockTops = [...probe.children].map(c => r2(c.getBoundingClientRect().top - p0.top));
	const lineH = parseFloat(getComputedStyle(probe.querySelector("p")).lineHeight) || 24;
	const bottom = r2(probe.lastElementChild.getBoundingClientRect().bottom - p0.top);
	probe.style.fontFamily = "var(--font-print)";
	await frame();
	const printed = readMarks(probe, o.marks);
	const screenFont = getComputedStyle(probe.parentElement === document.body ? document.body : probe).getPropertyValue("--font-text");
	probe.remove();
	return { centres, blockTops, lineH, bottom, screenFont: screenFont.trim(),
		printMove: centres.map((c, k) => ({ dx: r2(printed[k].x - c.x), dy: r2(printed[k].y - c.y) })) };
}

/** The crosses (magenta, 32 x 14), the highlighter on mark 0's next line, the stroke across the block 0/1 break, the far-left stroke. */
function buildStrokes(o, space) {
	const source = [];
	o.blocks.forEach((b, i) => { if (i > 0) source.push(""); source.push(b); });
	const anchorFor = b => {
		if (!o.attached) return null;
		const n = 1 + 2 * b;
		return { line: n, top: space.blockTops[b], key: lineKey(source[n - 1]), width: o.column, fontPx: 16,
			above: aboveOf(newAboveRun(), n, j => lineKey(source[j - 1])) };
	};
	const shift = o.shiftLine ? 24 : 0;
	const strokes = [];
	space.centres.forEach((c, k) => {
		const anchor = anchorFor(o.marks[k].block);
		strokes.push(line("h" + k, c.x - 16, c.y + shift, c.x + 16, c.y + shift, { anchor }), line("v" + k, c.x, c.y - 7 + shift, c.x, c.y + 7 + shift, { anchor }));
	});
	if (o.highlighter) {
		const c = space.centres[0];
		strokes.push(line("hl", c.x - 30, c.y + space.lineH + shift, c.x + 30, c.y + space.lineH + shift, { tool: "highlighter", color: "#ffcc00", width: 12, anchor: anchorFor(o.marks[0].block) }));
	}
	if (o.span) {
		const yb = space.blockTops[1];
		strokes.push(line("span", o.column - 40, yb - 30, o.column - 40, yb + 30, { color: "#0000ff", anchor: anchorFor(0) }));
	}
	if (o.farLeft) strokes.push(line("far", -60, space.bottom + 120, -20, space.bottom + 120, { color: "#808080", anchor: anchorFor(o.blocks.length - 1) }));
	return strokes;
}

function attachAll(root, sections, o, provide) {
	if (o.attached) {
		const source = [];
		o.blocks.forEach((b, i) => { if (i > 0) source.push(""); source.push(b); });
		const text = source.join("\\n");
		sections.forEach((el, i) => attachEmbedInkOnceReady(el, root, PATH, provide, undefined, false, {
			section: () => ({ text, lineStart: 2 * i, lineEnd: 2 * i }), cached: () => null }));
	} else attachEmbedInkOnceReady(root, root, PATH, provide);
}

/**
 * A note embedded at the foot of the export root (EMBED_PATH), as ExportEmbedInkClip builds Obsidian's embed: one wrapped
 * paragraph, its first and last words marked (me0, me1). The last word sits where every line break above it counts.
 */
const EMBED_PATH = "Embedded note.md";
const EMBED_WORDS = ("Embedfirst " + "words that wrap at the column width and push the next block down the page. ".repeat(8).trim() + " Embedlate").split(" ");
function embedRoot(root) {
	const wrap = root.appendChild(document.createElement("div"));
	const embed = wrap.appendChild(document.createElement("span"));
	embed.className = "internal-embed markdown-embed inline-embed is-loaded";
	embed.setAttribute("src", "Embedded note");
	const content = embed.appendChild(document.createElement("div"));
	content.className = "markdown-embed-content";
	const inner = content.appendChild(document.createElement("div"));
	inner.className = "markdown-preview-view markdown-rendered";
	const words = EMBED_WORDS.slice();
	words[0] = '<span class="mark-word" id="me0">' + words[0] + "</span>";
	words[words.length - 1] = '<span class="mark-word" id="me1">' + words[words.length - 1] + "</span>";
	const d = inner.appendChild(document.createElement("div"));
	d.innerHTML = "<p>" + words.join(" ") + "</p>";
	return inner;
}
/** The embed's ink: a cross on each marked word, in its own note space (x 0 its first line's left, y 0 its top), read on screen. */
let embedLive = [];
function embedCrosses(inner) {
	const p0 = inner.querySelector("p").getBoundingClientRect();
	return [0, 1].flatMap(k => {
		const w = inner.querySelector("#me" + k).getBoundingClientRect();
		const x = w.left + w.width / 2 - p0.left, y = w.top + w.height / 2 - p0.top;
		return [line("eh" + k, x - 16, y, x + 16, y), line("ev" + k, x, y - 7, x, y + 7)];
	});
}

/** A reading view on screen, outside the export div, with ink: the print must leave its font alone. */
function outsidePane(provide) {
	const pane = document.body.insertBefore(document.createElement("div"), document.body.firstChild);
	pane.className = "markdown-preview-view markdown-rendered";
	pane.innerHTML = "<div><p>An open note on screen, outside the export.</p></div>";
	attachEmbedInkOnceReady(pane, pane, "Open note.md", () => provide("Open note.md"));
	return pane;
}

/** Inline --font-text on each node the fix may write (the export div, its root, an embed's root, a pane outside). */
const inlineFonts = (n) => Object.fromEntries(Object.entries(n).map(([k, el]) => [k, el ? el.style.getPropertyValue("--font-text").trim() : null]));
const paraFonts = (div) => [...div.querySelectorAll("p")].map(p => getComputedStyle(p).fontFamily);

const zoomOf = el => parseFloat(getComputedStyle(el).zoom) || 1;

/**
 * An inked note embedded in the export (o.emb), as Obsidian 1.15.1 renders a markdown embed in a rendered note (app.js:
 * the embed registry @2328651 picks the _5 class when displayMode is set, as the static renderer's embed load @1823845
 * sets it). The span.internal-embed.markdown-embed.inline-embed sits in its line's paragraph, in the host's block for
 * that line (block 2 here). In the span: div.embed-title.markdown-embed-title, then markdown-embed-content >
 * markdown-preview-view with the note's blocks straight in it, no sizer. The plugin's post-processor attaches with
 * el = container = that view and the note's cached sections (PluginOnloadReload.ts). shape "sizer": the same embed with
 * its blocks in a reading view's sizer, each attached as a section. wrap: a fourth paragraph that wraps on screen, its
 * marked word (Embedwrap) the first word of its second line. nested: the inked embed sits inside an embed of a note with
 * no ink (Outer look), on that note's second line. plain: a second embed, of a note with no ink, holding an embed of
 * another (Plain inner, with no ink by the time the export builds), on host block 4. data-probe marks the views and
 * data-probe-line the inked embed's line, for the reads (a test instrument, as the green words are).
 */
const EMB_PATH = "Embed look.md";
const EMB_OUTER_PATH = "Outer look.md";
const EMB_PLAIN_PATH = "Plain look.md";
const EMB_PLAIN_INNER_PATH = "Plain inner.md";
const EMB_SHORT = ["Embedfirst opens the embedded note here", "The second line holds Embedmid near its start", "and the third line ends on Embedlate"];
const EMB_SHORT_MARKS = [{ block: 0, word: 0 }, { block: 1, word: 4 }, { block: 2, word: 6 }];
const EMB_OUTER_BLOCKS = ["An outer embedded note with no ink holds the next note"];
const EMB_PLAIN_BLOCKS = ["A plain embedded note with no ink of its own"];
const EMB_PLAIN_INNER_BLOCKS = ["A plain inner note with no ink by the time it prints"];
/**
 * The wrapped paragraph: its first line's width in css px on screen, and its marked word. The first line is wider than
 * the column the native parse leaves the embed at base and narrower than the live one, with room both ways: 621 and
 * 660 px for an embed in the note, and for one inside another embed 582 (only its own view pinned) and 620. With the
 * marked word after it, the line is wider than the editor's 700 px, so the editor, the desktop print and the live page
 * all wrap it before that word.
 */
const EMB_WRAPS = { top: { lo: 634, hi: 646, word: "Embedwrap" }, nested: { lo: 594, hi: 608, word: "Embedwrapnested" } };
let embBlocks = EMB_SHORT, embMarks = EMB_SHORT_MARKS, embSource = [], embText = "", embWrap = null;
let embInk = [];
let embS = null;
let embNodes = null, embOuterNodes = null, embPlainNodes = null, embPlainInnerNodes = null;
/** Plain words whose one-line width on screen falls between lo and hi, found by measuring. */
function wrapWords(lo, hi) {
	const probe = document.body.appendChild(document.createElement("div"));
	probe.className = "markdown-preview-view markdown-rendered";
	probe.style.cssText = "position:absolute;left:0;top:0;height:auto;padding:0;overflow:visible;width:auto";
	const span = probe.appendChild(document.createElement("p")).appendChild(document.createElement("span"));
	span.style.whiteSpace = "nowrap";
	const at = ws => { span.textContent = ws.join(" "); return span.getBoundingClientRect().width; };
	const fill = "the wrapped line of this embedded note runs across its column in plain words".split(" ");
	const fine = ["a", "an", "and", "also", "about", "across", "against", "anything", "afterwards", "accordingly"];
	const words = [];
	for (let i = 0; at([...words, fill[i % fill.length]]) <= hi - 100; i++) words.push(fill[i % fill.length]);
	let found = null;
	for (const a of fine) for (const b of fine) {
		const w = at([...words, a, b]);
		if (!found && w >= lo && w <= hi) found = [...words, a, b];
	}
	const out = found ?? words;
	const width = r2(at(out));
	probe.remove();
	return { words: out, width };
}
/** One of the embedded note's paragraphs; each marked word wrapped in a green span e<k>, the wrapped line's last word in #ew-last. */
function embP(text, i) {
	const words = text.split(" ");
	embMarks.forEach((m, k) => { if (m.block === i) words[m.word] = '<span class="mark-word" id="e' + k + '">' + words[m.word] + "</span>"; });
	const p = document.createElement("p");
	if (embWrap && i === 3) {
		const last = embWrap.words.length - 1;
		words[last] = '<span id="ew-last">' + words[last] + "</span>";
		p.setAttribute("data-probe", "emb-wrap");
	}
	p.innerHTML = words.join(" ");
	return p;
}
/**
 * The embedded note's own editor, stood in for. x: a view of the note at the editor's column width, x 0 the column's
 * left. y: the editor's own law, y 0 the first line's top and each source line one line height below the last, blank
 * lines too, so line n's top is (n - 1) x the line height; a word sits in its line as it sits in its paragraph.
 */
async function embSpace(o) {
	const wrap = o.emb.nested ? EMB_WRAPS.nested : EMB_WRAPS.top;
	embWrap = o.emb.wrap ? wrapWords(wrap.lo, wrap.hi) : null;
	embBlocks = EMB_SHORT.slice();
	embMarks = EMB_SHORT_MARKS.slice();
	if (embWrap) {
		embBlocks.push(embWrap.words.join(" ") + " " + wrap.word + " closes the wrapped paragraph on its second line");
		embMarks.push({ block: 3, word: embWrap.words.length });
	}
	embSource = [];
	embBlocks.forEach((b, i) => { if (i > 0) embSource.push(""); embSource.push(b); });
	embText = embSource.join("\\n");
	const probe = document.body.appendChild(document.createElement("div"));
	probe.className = "markdown-preview-view markdown-rendered";
	probe.style.cssText = "position:absolute;left:0;top:0;height:auto;padding:0;overflow:visible;width:" + o.column + "px";
	embBlocks.forEach((t, i) => { const d = probe.appendChild(document.createElement("div")); d.appendChild(embP(t, i)); });
	await frame();
	const p0 = probe.querySelector("p").getBoundingClientRect();
	const lineH = parseFloat(getComputedStyle(probe.querySelector("p")).lineHeight) || 24;
	const tops = [...probe.children].map(c => c.getBoundingClientRect().top - p0.top);
	const words = embMarks.map((m, k) => {
		const w = probe.querySelector("#e" + k).getBoundingClientRect();
		const n = 1 + 2 * m.block, top = (n - 1) * lineH;
		return { line: n, top: r2(top), x: r2(w.left + w.width / 2 - p0.left), y: r2(top + (w.top + w.height / 2 - p0.top - tops[m.block])), h: r2(w.height) };
	});
	probe.remove();
	return { lineH, words, wrap: embWrap };
}
/** A cross (32 x 14, magenta) on each marked word in editor space; anchored: each stroke carries its line's anchor, as the editor takes it for free ink. */
function embStrokes(o, space) {
	const out = [];
	space.words.forEach((w, k) => {
		const anchor = o.emb.anchored ? { line: w.line, top: w.top, key: lineKey(embSource[w.line - 1]), width: o.column, fontPx: 16,
			above: aboveOf(newAboveRun(), w.line, j => lineKey(embSource[j - 1])) } : null;
		out.push(line("eh" + k, w.x - 16, w.y, w.x + 16, w.y, { anchor }), line("ev" + k, w.x, w.y - 7, w.x, w.y + 7, { anchor }));
	});
	return out;
}
/**
 * One embed on its own line: in a host block (the block's paragraph holds the span), or in another embed's view (a new
 * paragraph after its blocks). The note's blocks go in the view (in a sizer for "sizer").
 */
function embBuild(into, name, key, blocks, marked, shape) {
	const para = document.createElement("p");
	para.setAttribute("data-probe-line", key);
	if (into.classList.contains("markdown-preview-view")) into.appendChild(para);
	else into.replaceChildren(para);
	const embed = para.appendChild(document.createElement("span"));
	embed.className = "internal-embed markdown-embed inline-embed is-loaded";
	embed.setAttribute("src", name);
	embed.setAttribute("alt", name);
	const title = embed.appendChild(document.createElement("div"));
	title.className = "embed-title markdown-embed-title";
	title.textContent = name;
	const content = embed.appendChild(document.createElement("div"));
	content.className = "markdown-embed-content";
	const view = content.appendChild(document.createElement("div"));
	view.className = "markdown-preview-view markdown-rendered show-indentation-guide";
	view.setAttribute("data-probe", key);
	let box = view;
	if (shape === "sizer") {
		box = view.appendChild(document.createElement("div"));
		box.className = "markdown-preview-sizer markdown-preview-section";
		const pu = box.appendChild(document.createElement("div"));
		pu.className = "markdown-preview-pusher";
		pu.style.width = "1px";
		pu.style.height = "0.1px";
	}
	const els = blocks.map((t, i) => {
		const p = marked ? embP(t, i) : Object.assign(document.createElement("p"), { textContent: t });
		if (shape !== "sizer") return box.appendChild(p);
		const d = box.appendChild(document.createElement("div"));
		d.appendChild(p);
		return d;
	});
	return { embed, content, view, blocks: els };
}
function embMount(sections, o) {
	embOuterNodes = o.emb.nested ? embBuild(sections[2], "Outer look", "emb-outer", EMB_OUTER_BLOCKS, false, "obsidian") : null;
	embNodes = embBuild(embOuterNodes ? embOuterNodes.view : sections[2], "Embed look", "emb-ink", embBlocks, true, o.emb.shape);
	embPlainNodes = o.emb.plain ? embBuild(sections[4], "Plain look", "emb-plain", EMB_PLAIN_BLOCKS, false, "obsidian") : null;
	embPlainInnerNodes = embPlainNodes ? embBuild(embPlainNodes.view, "Plain inner", "emb-plain-inner", EMB_PLAIN_INNER_BLOCKS, false, "obsidian") : null;
}
/** A no-ink embed's attach: its view, its note's cached sections (its blocks, then the line of an embed it holds). */
function embAttachPlain(nodes, path, lines, provide) {
	const v = nodes.view;
	attachEmbedInkOnceReady(v, v, path, () => provide(path), undefined, false, {
		section: () => null, cached: () => ({ sections: Array.from({ length: lines }, (_, i) => ({ type: "paragraph", lineStart: 2 * i, lineEnd: 2 * i })), text: "" }) });
}
/** The embeds' attach, after the host's, as the plugin's post-processor makes it for each: an outer embed before the one it holds. */
function embAttach(o, provide) {
	embInk = embStrokes(o, embS);
	if (embOuterNodes) embAttachPlain(embOuterNodes, EMB_OUTER_PATH, EMB_OUTER_BLOCKS.length + 1, provide);
	const n = embNodes;
	if (o.emb.shape === "sizer") {
		n.blocks.forEach((d, i) => attachEmbedInkOnceReady(d, n.view, EMB_PATH, () => provide(EMB_PATH), undefined, false, {
			section: () => ({ text: embText, lineStart: 2 * i, lineEnd: 2 * i }), cached: () => null }));
	} else {
		attachEmbedInkOnceReady(n.view, n.view, EMB_PATH, () => provide(EMB_PATH), undefined, false, {
			section: () => null,
			cached: () => ({ sections: embBlocks.map((_, i) => ({ type: "paragraph", lineStart: 2 * i, lineEnd: 2 * i })), text: embText }) });
	}
	if (embPlainNodes) {
		embAttachPlain(embPlainNodes, EMB_PLAIN_PATH, EMB_PLAIN_BLOCKS.length + 1, provide);
		embAttachPlain(embPlainInnerNodes, EMB_PLAIN_INNER_PATH, EMB_PLAIN_INNER_BLOCKS.length, provide);
	}
}

/**
 * Replay of printToPdfMobile (app.js 1.15.1 @2682211) with the plugin live. Hooks: childStyleBeforeZoom (C5a),
 * throwOnBuild (C5c: the strokes provider throws once, only while the div's zoom is written and differs from the scale),
 * dropAfterBuild (C4), persistAfterBuild (C1, a persist after the build), farLeft (C6), late, zoomTwice, plantBoxShown
 * (C10's plant), rawStrokes (C8).
 */
window.mobileExport = async (o) => {
	teardownEmbedInk();
	document.body.replaceChildren();
	// The app's body before the export: mobile, dark; the clone turns it light.
	document.body.className = (o.mobile ? "is-mobile " + (o.column < 500 ? "is-phone " : "is-tablet ") : "") + "theme-dark";
	Platform.isMobileApp = o.mobile;
	Platform.isMobile = o.mobile;
	initEmbedInkColumnWidth(() => o.column);
	initEmbedInkPrintPaper(() => o.settings);
	initEmbedInkPrintCanvas(o.canvasNote ? () => true : null);
	const space = await noteSpace(o);
	embS = o.emb ? await embSpace(o) : null;
	let live = o.rawStrokes ?? buildStrokes(o, space);
	const scale = Math.min(2, Math.max(0.1, o.settings.downscalePercent / 100));
	let zoomWritten = false, throwFired = false, zoomAtThrow = null;
	let div = null;
	const provide = (p) => {
		if (p === EMBED_PATH) return embedLive;
		if (p === EMB_PATH) return embInk;
		if (p === EMB_OUTER_PATH || p === EMB_PLAIN_PATH) return [];
		// The no-ink inner embed: one stroke while it attaches (so its root registers and its canvas stands), none by the
		// time the export builds, as a note whose ink was all erased.
		if (p === EMB_PLAIN_INNER_PATH) return zoomWritten ? [] : [line("plain", 40, 12, 72, 12)];
		if (o.throwOnBuild && zoomWritten && !throwFired && div.style.zoom !== String(scale)) {
			throwFired = true;
			zoomAtThrow = div.style.zoom;
			throw new Error("PLANTED-BUILD-THROW");
		}
		return live;
	};
	initEmbedInkRefresh(provide);
	const swaps0 = embedInkPrintSwaps();
	// printToPdfMobile: body.createDiv("print theme-light"), aria-hidden.
	div = document.body.appendChild(document.createElement("div"));
	div.className = "print theme-light";
	div.setAttribute("aria-hidden", "true");
	// print(): a fresh view, the file name when the dialog says so, the sections in the tree, then the post-processors.
	const root = div.appendChild(document.createElement("div"));
	root.className = "markdown-preview-view markdown-rendered";
	const sections = fillRoot(root, { ...o, includeName: o.settings.includeName });
	const inner = o.embed ? embedRoot(root) : null;
	if (o.emb) embMount(sections, o);
	if (o.priorFont) root.style.setProperty("--font-text", o.priorFont);
	// The font the note shows on screen, read before any build.
	const screenPara = getComputedStyle(root.querySelector("p")).fontFamily, screenVar = getComputedStyle(root).getPropertyValue("--font-text").trim();
	if (inner) { await frame(); embedLive = o.embed === "ink" ? embedCrosses(inner) : []; attachEmbedInkOnceReady(inner, inner, EMBED_PATH, () => provide(EMBED_PATH)); }
	if (!o.late) attachAll(root, sections, o, provide);
	if (o.emb) embAttach(o, provide);
	// print() resolves.
	await Promise.resolve();
	if (o.childStyleBeforeZoom) { sections[0].style.color = "black"; root.style.color = "black"; await frame(); await frame(); }
	const svgBeforeZoom = div.querySelectorAll("svg.handwriting-embed-ink").length;
	let pads = null;
	if (o.farLeft) { await frame(); await frame(); const cs = getComputedStyle(root); pads = { left: cs.paddingLeft, top: cs.paddingTop }; }
	// The zoom, then the app's 200 ms (app.js @2682548). The plugin's whole answer to the zoom (and to a canvas added
	// after it) is built inside its MutationObservers' callbacks, which run before the next frame; the replay waits two
	// frames in place of the 200 ms, so a watch that reacts later than that fails here.
	div.style.zoom = scale.toString();
	zoomWritten = true;
	const observersArmed = window.__bodyObservers?.() ?? null;
	if (o.zoomTwice) { await frame(); div.style.zoom = scale.toString(); }
	if (o.late) { await frame(); attachAll(root, sections, o, provide); }
	if (o.farLeft) { await frame(); await frame(); live = live.filter(s => s.id !== "far"); embedInkChanged(PATH); }
	// A persist of the exported note's ink between the zoom's build and the clone (a sync landing, another pane writing):
	// embedInkChanged repaints the root and asks for its print vector again, with no cut.
	let persisted = null;
	if (o.persistAfterBuild) {
		await frame();
		persisted = { stripsBefore: div.querySelectorAll("svg.handwriting-embed-ink-strip").length };
		live = live.slice();
		embedInkChanged(PATH);
	}
	let dropped = null;
	if (o.dropAfterBuild) {
		await frame(); await frame();
		const stripsBefore = div.querySelectorAll("svg.handwriting-embed-ink-strip").length;
		releasePrintStrips(root);
		await frame();
		const box = root.querySelector(":scope > svg.handwriting-embed-ink");
		dropped = { stripsBefore, box: !!box, boxInline: box ? box.style.display : null, boxShown: box ? getComputedStyle(box).display !== "none" : false };
	}
	await frame(); await frame();
	const box = root.querySelector(":scope > svg.handwriting-embed-ink");
	if (o.plantBoxShown && box) { box.classList.remove("is-stripped"); box.style.removeProperty("display"); }
	// The embeds as the page holds them when the string is taken (the build done), for the print's reads.
	const embLive = o.emb && window.embGeom ? window.embGeom() : null;
	const embPlainCanvas = embPlainInnerNodes && o.emb?.plain ? embPlainInnerNodes.content.querySelectorAll(":scope > canvas.handwriting-embed-ink").length : null;
	const zoomAtClone = div.style.zoom;
	const zf = zoomOf(div) * zoomOf(root);
	// The clone (app.js @2682591, @2682815, @2682963).
	const s = document.documentElement.cloneNode(false);
	const head = document.head.cloneNode(true);
	head.querySelectorAll("script").forEach(h => h.remove());
	const body = document.body.cloneNode(false);
	body.classList.remove("theme-dark");
	body.classList.add("theme-light");
	body.appendChild(div.cloneNode(true));
	s.append(head, body);
	s.querySelectorAll("style").forEach(h => { h.textContent = h.textContent.replace(/<\\/(style)/gi, "<\\\\/$1"); });
	const out = "<!doctype html>" + s.outerHTML;
	const cloneBox = s.querySelector(".print > .markdown-preview-view > svg.handwriting-embed-ink");
	const clone = { strips: s.querySelectorAll("svg.handwriting-embed-ink-strip").length,
		stripped: cloneBox ? cloneBox.classList.contains("is-stripped") : null, boxInline: cloneBox ? cloneBox.style.display : null };
	const held = {
		embLive, embPlainCanvas, embWrap: o.emb ? embS.wrap : null,
		html: out, strokes: live.length, zf, zoomAtClone, throwFired, zoomAtThrow, svgBeforeZoom, observersArmed, dropped, persisted, clone, pads,
		padsAfter: { left: root.style.paddingLeft, top: root.style.paddingTop },
		svg: div.querySelectorAll("svg.handwriting-embed-ink").length,
		strips: div.querySelectorAll("svg.handwriting-embed-ink-strip").length,
		doubled: [...root.children].filter(c => c.querySelectorAll(":scope > svg.handwriting-embed-ink-strip").length > 1).length,
		stripped: box ? box.classList.contains("is-stripped") : null,
		boxInline: box ? box.style.display : null,
		canvasShown: [...div.querySelectorAll("canvas.handwriting-embed-ink")].filter(c => c.style.display !== "none" && getComputedStyle(c).display !== "none").length,
		swaps: embedInkPrintSwaps() - swaps0,
		space: { centres: space.centres, printMove: space.printMove, lineH: space.lineH, screenFont: space.screenFont },
		font: { screenPara, screenVar, inline: inlineFonts({ div, root, inner }) },
	};
	div.remove();
	teardownEmbedInk();
	held.observersAfterTeardown = window.__bodyObservers?.() ?? null;
	return held;
};

/** C5d, on a page of its own: arming cannot come back in a page once disarmed. */
window.disarmNow = () => { disarmPrintSwaps(); return window.__bodyObservers?.() ?? null; };

/**
 * The desktop export: body theme-light, not the mobile app, the plugin attached, beforeprint. The test then emulates print,
 * prints with the downscale as page scale, and calls desktopEnd. exportShape: note space is the export root itself and
 * no column provider is set (ExportPrintAnchor's page).
 */
window.desktopMount = async (o) => {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "theme-light";
	Platform.isMobileApp = false;
	Platform.isMobile = false;
	if (!o.exportShape) initEmbedInkColumnWidth(() => o.column);
	initEmbedInkPrintPaper(() => o.settings);
	initEmbedInkPrintCanvas(null);
	let space = o.exportShape ? null : await noteSpace(o);
	embS = o.emb ? await embSpace(o) : null;
	const div = document.body.appendChild(document.createElement("div"));
	div.className = "print";
	const root = div.appendChild(document.createElement("div"));
	root.className = "markdown-preview-view markdown-rendered";
	const sections = fillRoot(root, { ...o, includeName: o.settings.includeName });
	if (o.emb) embMount(sections, o);
	await frame();
	if (o.exportShape) {
		const p0 = root.querySelector("p").getBoundingClientRect();
		space = { centres: readMarks(root, o.marks), blockTops: sections.map(d => r2(d.getBoundingClientRect().top - p0.top)),
			lineH: parseFloat(getComputedStyle(root.querySelector("p")).lineHeight) || 24, bottom: 0, printMove: [], screenFont: "" };
	}
	const strokes = o.rawStrokes ?? buildStrokes(o, space);
	const provide = (p) => (p === EMBED_PATH ? embedLive : p === EMB_PATH ? embInk : p === EMB_OUTER_PATH || p === EMB_PLAIN_PATH || p === EMB_PLAIN_INNER_PATH ? [] : p === "Open note.md" ? buildStrokes({ ...o, highlighter: false, span: false, farLeft: false }, space) : strokes);
	initEmbedInkRefresh(provide);
	const inner = o.embed ? embedRoot(root) : null;
	if (o.priorFont) root.style.setProperty("--font-text", o.priorFont);
	const pane = o.outside ? outsidePane(provide) : null;
	await frame();
	const screenPara = getComputedStyle(root.querySelector("p")).fontFamily, screenVar = getComputedStyle(root).getPropertyValue("--font-text").trim();
	if (inner) { embedLive = o.embed === "ink" ? embedCrosses(inner) : []; attachEmbedInkOnceReady(inner, inner, EMBED_PATH, () => provide(EMBED_PATH)); }
	attachAll(root, sections, o, provide);
	if (o.emb) embAttach(o, provide);
	await frame(); await frame();
	const nodes = { div, root, inner, pane };
	window.__desk = { swaps0: embedInkPrintSwaps(), space, nodes };
	const before = inlineFonts(nodes);
	window.dispatchEvent(new Event("beforeprint"));
	await frame(); await frame();
	return { svg: div.querySelectorAll("svg.handwriting-embed-ink").length, strips: div.querySelectorAll("svg.handwriting-embed-ink-strip").length,
		screenPara, screenVar, before, atBeforeprint: inlineFonts(nodes) };
};
window.twoFrames = async () => { await frame(); await frame(); };
/** In the print media: each paragraph's font in the export, and the inline font on each node. */
window.deskRead = () => ({ paras: paraFonts(window.__desk.nodes.div), inline: inlineFonts(window.__desk.nodes) });
window.desktopEnd = async () => {
	window.dispatchEvent(new Event("afterprint"));
	await frame();
	const swaps = embedInkPrintSwaps() - window.__desk.swaps0;
	const space = window.__desk.space;
	const after = inlineFonts(window.__desk.nodes);
	teardownEmbedInk();
	document.body.replaceChildren();
	return { swaps, after, space: { centres: space.centres, printMove: space.printMove } };
};

/** C8: the largest array of stroke-shaped objects in a sidecar, wherever it sits. */
window.sidecarStrokes = (text) => {
	let best = [];
	const walk = v => {
		if (Array.isArray(v)) {
			if (v.length && v[0] && typeof v[0] === "object" && "points" in v[0]) { if (v.length > best.length) best = v; }
			else v.forEach(walk);
		} else if (v && typeof v === "object") Object.values(v).forEach(walk);
	};
	walk(JSON.parse(text));
	return best;
};

// ---- The same embed on screen. ----
/**
 * Two embed shapes, read from app.js 1.15.1 (sha256 31c39502):
 * "dr": the on-screen markdown embed. The registry @2328651 picks dr (= vx, extends _n) when displayMode is not set. A
 *   reading view section post-processes with no displayMode (@1820670, containerEl the renderer's sizer); a Live
 *   Preview embed widget loads with displayMode false (@2623438). _n makes .markdown-embed-content twice (preview, then
 *   editor); ON's renderer (nu @1789472) builds .markdown-preview-view.markdown-rendered >
 *   .markdown-preview-sizer.markdown-preview-section with the pusher; vx prepends the title and appends
 *   .markdown-embed-link; in preview the renderer's header (.mod-header) holds the inline title. Each section of the
 *   embedded note post-processes with el = that section and containerEl = the embed's sizer.
 * "_5": the static embed (displayMode set): the PDF export @2684038, MarkdownRenderer.render with an app @1822733, a Live
 *   Preview plugin code block @2625668, an embed nested in a _5. No sizer: the blocks straight in the view; one
 *   post-process with el = container = the view (E3's "obsidian" shape).
 * Hosts: "reading": a reading view, its sizer's section > p > span embed; "editor": Live Preview, the embed a block
 * widget div in .cm-content. A _5 sits in a plugin's rendered block in either host.
 * v2 (05:3xZ): the editor host carries CodeMirror's base theme (app.js 1.15.1 @299265, the rules for the editor, scroller,
 * content, lineWrapping and line, scoped to one class as CM scopes them). app.css sets .cm-content width 0 and leaves its
 * growth to that theme (flex-grow 2); v1 had no theme, so its editor column was 0 px wide and its editor rows were void.
 */
const SCR_CM_BASE = ".scr-cm-base{position:relative !important;box-sizing:border-box;display:flex !important;flex-direction:column}" +
	".scr-cm-base .cm-scroller{display:flex !important;align-items:flex-start !important;font-family:monospace;line-height:1.4;height:100%;overflow-x:auto;position:relative;z-index:0;overflow-anchor:none}" +
	".scr-cm-base .cm-content{margin:0;flex-grow:2;flex-shrink:0;display:block;white-space:pre;word-wrap:normal;box-sizing:border-box;min-height:100%;padding:4px 0;outline:none}" +
	".scr-cm-base .cm-lineWrapping{white-space:pre-wrap;white-space:break-spaces;word-break:break-word;overflow-wrap:anywhere;flex-shrink:1}" +
	".scr-cm-base .cm-line{display:block;padding:0 2px 0 6px}";
let scrNodes = null;
function scrDiv(parent, cls) { const d = parent.appendChild(document.createElement("div")); if (cls) d.className = cls; return d; }
function scrHost(kind) {
	const leaf = scrDiv(document.body, "workspace-leaf-content");
	leaf.setAttribute("data-type", "markdown");
	leaf.style.cssText = "position:absolute;left:0;top:0;width:800px;height:1200px";
	const vc = scrDiv(leaf, "view-content");
	vc.style.height = "100%";
	if (kind === "reading") {
		const rv = scrDiv(vc, "markdown-reading-view");
		rv.style.cssText = "width:100%;height:100%";
		const pv = scrDiv(rv, "markdown-preview-view markdown-rendered node-insert-event is-readable-line-width allow-fold-headings allow-fold-lists show-indentation-guide show-properties");
		const sizer = scrDiv(pv, "markdown-preview-sizer markdown-preview-section");
		const pu = scrDiv(sizer, "markdown-preview-pusher");
		pu.style.cssText = "width:1px;height:0.1px";
		const h = scrDiv(sizer, "");
		h.innerHTML = "<p>Hostline of the host note above its embed</p>";
		return { place: (shape) => {
			const sec = scrDiv(sizer, "");
			if (shape === "dr") return sec.appendChild(document.createElement("p")).appendChild(document.createElement("span"));
			return scrDiv(sec, "block-language-probe").appendChild(document.createElement("p")).appendChild(document.createElement("span"));
		} };
	}
	const sv = scrDiv(vc, "markdown-source-view cm-s-obsidian mod-cm6 node-insert-event is-readable-line-width is-live-preview is-folding show-properties");
	if (!document.getElementById("scr-cm-base")) {
		const st = document.head.appendChild(document.createElement("style"));
		st.id = "scr-cm-base";
		st.textContent = SCR_CM_BASE;
	}
	const ed = scrDiv(sv, "cm-editor scr-cm-base");
	const sc = scrDiv(ed, "cm-scroller");
	const cs = scrDiv(sc, "cm-sizer");
	const cc = scrDiv(cs, "cm-contentContainer");
	const content = scrDiv(cc, "cm-content cm-lineWrapping");
	content.setAttribute("contenteditable", "true");
	scrDiv(content, "cm-line").textContent = "Hostline of the host note above its embed";
	return { place: (shape) => {
		if (shape === "dr") { const d = scrDiv(content, ""); d.setAttribute("contenteditable", "false"); return d; }
		const blk = scrDiv(content, "cm-preview-code-block cm-embed-block markdown-rendered cm-lang-probe");
		blk.setAttribute("contenteditable", "false");
		return scrDiv(blk, "block-language-probe").appendChild(document.createElement("p")).appendChild(document.createElement("span"));
	} };
}
function scrEmbed(embed, shape) {
	embed.className = "internal-embed markdown-embed inline-embed is-loaded";
	embed.setAttribute("src", "Embed look");
	embed.setAttribute("alt", "Embed look");
	scrDiv(embed, "embed-title markdown-embed-title").textContent = "Embed look";
	const content = scrDiv(embed, "markdown-embed-content");
	const view = scrDiv(content, shape === "dr" ? "markdown-preview-view markdown-rendered show-indentation-guide allow-fold-headings allow-fold-lists" : "markdown-preview-view markdown-rendered show-indentation-guide");
	let sizer = null;
	let blocks;
	if (shape === "dr") {
		sizer = scrDiv(view, "markdown-preview-sizer markdown-preview-section");
		const pu = scrDiv(sizer, "markdown-preview-pusher");
		pu.style.cssText = "width:1px;height:0.1px";
		scrDiv(scrDiv(sizer, "mod-header mod-ui"), "inline-title").textContent = "Embed look";
		blocks = embBlocks.map((t, i) => { const d = scrDiv(sizer, ""); d.appendChild(embP(t, i)); return d; });
		scrDiv(embed, "markdown-embed-content").style.display = "none";
		scrDiv(embed, "markdown-embed-link");
	} else blocks = embBlocks.map((t, i) => view.appendChild(embP(t, i)));
	return { embed, content, view, sizer, blocks };
}
/** Magenta pixels of the embed's canvas, 8-connected blobs; each blob's box centre in css px of the page. */
function scrBlobs(c) {
	const W = c.width, H = c.height;
	if (!W || !H) return [];
	const ctx = c.getContext("2d");
	if (!ctx) return [];
	const d = ctx.getImageData(0, 0, W, H).data;
	const mask = new Uint8Array(W * H);
	for (let i = 0; i < W * H; i++) { const r = d[4 * i], g = d[4 * i + 1], b = d[4 * i + 2], a = d[4 * i + 3]; if (a >= 96 && r - g >= 80 && b - g >= 80) mask[i] = 1; }
	const rect = c.getBoundingClientRect(), sx = rect.width / W, sy = rect.height / H;
	const out = [];
	const stack = new Int32Array(W * H);
	for (let s = 0; s < W * H; s++) {
		if (mask[s] !== 1) continue;
		let n = 0, top = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
		stack[top++] = s; mask[s] = 2;
		while (top > 0) {
			const q = stack[--top], x = q % W, y = (q - x) / W;
			n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
				const k = yy * W + xx;
				if (mask[k] === 1) { mask[k] = 2; stack[top++] = k; }
			}
		}
		if (n < 4) continue;
		out.push({ n, cx: r2(rect.left + (x0 + x1 + 1) / 2 * sx), cy: r2(rect.top + (y0 + y1 + 1) / 2 * sy), w: r2((x1 - x0 + 1) * sx), h: r2((y1 - y0 + 1) * sy) });
	}
	return out.sort((a, b) => a.cy - b.cy);
}
function scrRead() {
	const n = scrNodes;
	const cr = n.content.getBoundingClientRect();
	const c = n.content.querySelector(":scope > canvas.handwriting-embed-ink");
	const blobs = c ? scrBlobs(c) : [];
	const words = embMarks.map((m, k) => {
		const w = n.view.querySelector("#e" + k).getBoundingClientRect();
		const wx = w.left + w.width / 2, wy = w.top + w.height / 2;
		const b = blobs.length === embMarks.length ? blobs[k] : null;
		return { token: embBlocks[m.block].split(" ")[m.word], found: !!b, dx: b ? r2(b.cx - wx) : null, dy: b ? r2(b.cy - wy) : null, box: b ? [b.w, b.h] : null };
	});
	const at = r => ({ x: r2(r.left - cr.left), y: r2(r.top - cr.top) });
	const vcs = getComputedStyle(n.view);
	return { words, meta: { blobs: blobs.length, canvas: c ? { w: c.width, h: c.height, left: c.style.left, top: c.style.top, at: at(c.getBoundingClientRect()), cssW: r2(c.getBoundingClientRect().width) } : null,
		content: { w: r2(cr.width), x: r2(cr.left) }, viewPad: vcs.paddingLeft, view: at(n.view.getBoundingClientRect()),
		sizer: n.sizer ? at(n.sizer.getBoundingClientRect()) : null, blocks: n.blocks.map(b => at(b.getBoundingClientRect()).x) } };
}
window.screenEmbed = async (o) => {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "theme-light";
	Platform.isMobileApp = false;
	Platform.isMobile = false;
	initEmbedInkColumnWidth(() => o.column);
	embS = await embSpace(o);
	embInk = embStrokes(o, embS);
	initEmbedInkRefresh((p) => (p === EMB_PATH ? embInk : []));
	const host = scrHost(o.host);
	scrNodes = scrEmbed(host.place(o.shape), o.shape);
	await frame();
	const n = scrNodes;
	if (o.shape === "dr") {
		n.blocks.forEach((d, i) => attachEmbedInkOnceReady(d, n.sizer, EMB_PATH, () => embInk, undefined, false, {
			section: () => ({ text: embText, lineStart: 2 * i, lineEnd: 2 * i }), cached: () => null }));
	} else {
		attachEmbedInkOnceReady(n.view, n.view, EMB_PATH, () => embInk, undefined, false, {
			section: () => null,
			cached: () => ({ sections: embBlocks.map((_, i) => ({ type: "paragraph", lineStart: 2 * i, lineEnd: 2 * i })), text: embText }) });
	}
	let first = null, frames = 0;
	for (; frames < 60; frames++) { await frame(); const r = scrRead(); if (r.meta.blobs === embMarks.length) { first = r; break; } }
	for (let i = 0; i < 10; i++) await frame();
	const last = scrRead();
	const same = !!first && JSON.stringify(first.words) === JSON.stringify(last.words);
	teardownEmbedInk();
	document.body.replaceChildren();
	return { words: last.words, meta: { ...last.meta, frames, settled: same, space: embS } };
};
`;

/**
 * The reader, in its own page: pdf.js as Obsidian ships it. Each page rasterised at R canvas px per page px; pixels
 * classed by hue (chroma >= 30; ink 300, mark 120, hl 50, span 240, +-28 degrees); 8-connected blobs with their box and
 * core centroid (chroma >= 120). Per green word: a window of centre +- (width / 2 + height + 4) across and
 * +- (height + 4) down, page px, rendered at
 * R = clamp(ceil(8 / (height / 18)), 6, 48). Page px are CSS px of the page: PDF points / 0.75.
 */
const READER_JS = `
import * as pdfjs from "/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
const CLASSES = ["ink", "mark", "hl", "span"];
const HUES = [300, 120, 50, 240];
function classOf(r, g, b) {
	const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
	if (c < 30) return -1;
	let h;
	if (mx === r) h = ((g - b) / c) % 6; else if (mx === g) h = (b - r) / c + 2; else h = (r - g) / c + 4;
	h *= 60; if (h < 0) h += 360;
	for (let k = 0; k < 4; k++) { let d = Math.abs(h - HUES[k]); if (d > 180) d = 360 - d; if (d <= 28) return k; }
	return -1;
}
async function raster(page, R, win) {
	const view = page.view;
	const W = (view[2] - view[0]) / 0.75, H = (view[3] - view[1]) / 0.75;
	const w = win ? { x0: Math.max(0, win.x0), y0: Math.max(0, win.y0), x1: Math.min(W, win.x1), y1: Math.min(H, win.y1) } : { x0: 0, y0: 0, x1: W, y1: H };
	const vp = page.getViewport({ scale: R / 0.75, offsetX: -w.x0 * R, offsetY: -w.y0 * R });
	const cw = Math.max(1, Math.ceil((w.x1 - w.x0) * R)), ch = Math.max(1, Math.ceil((w.y1 - w.y0) * R));
	const canvas = document.createElement("canvas"); canvas.width = cw; canvas.height = ch;
	const g = canvas.getContext("2d", { willReadFrequently: true });
	g.fillStyle = "#ffffff"; g.fillRect(0, 0, cw, ch);
	await page.render({ canvasContext: g, viewport: vp }).promise;
	const d = g.getImageData(0, 0, cw, ch).data;
	const n = cw * ch, cls = new Int8Array(n), chroma = new Uint8Array(n);
	for (let i = 0; i < n; i++) { const r = d[4 * i], gg = d[4 * i + 1], b = d[4 * i + 2]; cls[i] = classOf(r, gg, b); chroma[i] = Math.max(r, gg, b) - Math.min(r, gg, b); }
	const seen = new Uint8Array(n), stack = new Int32Array(n), blobs = [];
	for (let i = 0; i < n; i++) {
		if (cls[i] < 0 || seen[i]) continue;
		const k = cls[i];
		let sp = 0; stack[sp++] = i; seen[i] = 1;
		let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, count = 0, sx = 0, sy = 0, sc = 0;
		while (sp) {
			const j = stack[--sp], x = j % cw, y = (j - x) / cw;
			count++;
			if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
			if (chroma[j] >= 120) { sx += x + 0.5; sy += y + 0.5; sc++; }
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const xx = x + dx, yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= cw || yy >= ch) continue;
				const jj = yy * cw + xx;
				if (!seen[jj] && cls[jj] === k) { seen[jj] = 1; stack[sp++] = jj; }
			}
		}
		blobs.push({ cls: CLASSES[k], count, x0: w.x0 + x0 / R, y0: w.y0 + y0 / R, x1: w.x0 + (x1 + 1) / R, y1: w.y0 + (y1 + 1) / R,
			cx: sc ? w.x0 + sx / sc / R : null, cy: sc ? w.y0 + sy / sc / R : null });
	}
	return { blobs, W, H };
}
const r2 = v => v === null ? null : Math.round(v * 100) / 100;
const overlap = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
/** Green blobs split by a cross's bar merged back into one word box. */
function words(greens, gap) {
	const groups = [];
	for (const b of greens) {
		const near = groups.filter(g => {
			const yo = Math.min(g.y1, b.y1) - Math.max(g.y0, b.y0), xo = Math.min(g.x1, b.x1) - Math.max(g.x0, b.x0);
			return (yo > 0 && xo > -gap) || (xo > 0 && yo > -gap);
		});
		const m = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
		for (const g of near) { m.x0 = Math.min(m.x0, g.x0); m.y0 = Math.min(m.y0, g.y0); m.x1 = Math.max(m.x1, g.x1); m.y1 = Math.max(m.y1, g.y1); groups.splice(groups.indexOf(g), 1); }
		groups.push(m);
	}
	return groups;
}
window.readPdf = async (url, tokens, zf) => {
	const doc = await pdfjs.getDocument({ url }).promise;
	const out = { pages: doc.numPages, words: [], strays: [], hl: 0, spans: [], inks: [] };
	const gap = 3 * zf + 1;
	for (let p = 1; p <= doc.numPages; p++) {
		const page = await doc.getPage(p);
		const view = page.view;
		const { blobs } = await raster(page, 2, null);
		const tc = await page.getTextContent();
		const items = tc.items.filter(it => it.str && it.str.trim()).map(it => {
			const t = it.transform, fh = Math.hypot(t[2], t[3]) || it.height;
			const yb = (view[3] - t[5]) / 0.75;
			// The font the PDF holds for the run: its embedded name (subset prefix and all), loaded by the raster above.
			const font = it.fontName && page.commonObjs.has(it.fontName) ? (page.commonObjs.get(it.fontName)?.name ?? it.fontName) : (tc.styles?.[it.fontName]?.fontFamily ?? null);
			return { str: it.str, font, x0: (t[4] - view[0]) / 0.75, x1: (t[4] - view[0] + it.width) / 0.75, y0: yb - fh * 0.8 / 0.75, y1: yb + fh * 0.2 / 0.75 };
		});
		const windows = [];
		for (const gw of words(blobs.filter(b => b.cls === "mark" && b.count >= 2), gap)) {
			// The window: the word's line only (a height above and below), and a height beyond each end, so the next
			// line's word and its cross stay out.
			// The pad is 4 css px of the note, so at a 10 % downscale the next line's word and its cross stay out too.
			const h = gw.y1 - gw.y0, ww = gw.x1 - gw.x0, hx = ww / 2 + h + 4 * zf, hy = h + 4 * zf;
			const cx = (gw.x0 + gw.x1) / 2, cy = (gw.y0 + gw.y1) / 2;
			const win = { x0: cx - hx, y0: cy - hy, x1: cx + hx, y1: cy + hy };
			windows.push(win);
			const R = Math.min(48, Math.max(6, Math.ceil(8 / (h / 18))));
			const fine = await raster(page, R, win);
			const grown = { x0: gw.x0 - gap, y0: gw.y0 - gap, x1: gw.x1 + gap, y1: gw.y1 + gap };
			const g = fine.blobs.filter(b => b.cls === "mark" && overlap(b, grown) > 0);
			const box = g.length ? { x0: Math.min(...g.map(b => b.x0)), y0: Math.min(...g.map(b => b.y0)), x1: Math.max(...g.map(b => b.x1)), y1: Math.max(...g.map(b => b.y1)) } : gw;
			const word = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2, w: box.x1 - box.x0, h: box.y1 - box.y0 };
			const ink = fine.blobs.filter(b => b.cls === "ink" && b.count >= 4).sort((a, b) => b.count - a.count);
			const big = ink[0];
			const cross = big ? { x: big.cx ?? (big.x0 + big.x1) / 2, y: big.cy ?? (big.y0 + big.y1) / 2 } : null;
			let best = null, bestArea = 0;
			for (const it of items) { const a = overlap(it, gw); if (a > bestArea) { bestArea = a; best = it; } }
			// A word can come in more than one text run: Chromium embeds a variable font (Bahnschrift) as Type3 fonts, and
			// pdf.js gives "Block00" as "Block" and "00". The best run first, as before; else the runs over the word on the
			// best run's line, joined left to right.
			const mid = it => (it.y0 + it.y1) / 2;
			const joined = best ? items.filter(it => overlap(it, gw) > 0 && Math.abs(mid(it) - mid(best)) < (best.y1 - best.y0) / 2)
				.sort((a, b) => a.x0 - b.x0).map(it => it.str).join("") : "";
			const token = best ? (tokens.find(t => best.str.includes(t)) ?? tokens.find(t => joined.includes(t)) ?? null) : null;
			out.words.push({ page: p - 1, token, text: best ? best.str.slice(0, 40) : null, font: best ? best.font : null, R,
				word: { x: r2(word.x), y: r2(word.y), w: r2(word.w), h: r2(word.h) },
				cross: cross ? { x: r2(cross.x), y: r2(cross.y) } : null,
				dx: cross ? r2(cross.x - word.x) : null, dy: cross ? r2(cross.y - word.y) : null, ink: ink.length });
		}
		for (const b of blobs) {
			if (b.cls === "ink" && b.count >= 2 && !windows.some(w => overlap(w, b) > 0)) out.strays.push({ page: p - 1, x0: r2(b.x0), y0: r2(b.y0), x1: r2(b.x1), y1: r2(b.y1), count: b.count });
			// Every ink blob on the page with its core centroid, in the window or not: the embed cells pair them by order.
			if (b.cls === "ink" && b.count >= 40) out.inks.push({ page: p - 1, cx: r2(b.cx ?? (b.x0 + b.x1) / 2), cy: r2(b.cy ?? (b.y0 + b.y1) / 2), count: b.count });
			if (b.cls === "hl" && b.count >= 4) out.hl++;
			if (b.cls === "span" && b.count >= 4) out.spans.push({ page: p - 1, h: r2(b.y1 - b.y0), x: r2((b.x0 + b.x1) / 2) });
		}
	}
	await doc.destroy();
	return out;
};
window.ready = true;
`;

/** The dialog's saved settings, as app.js writes them (@2680737). */
interface Settings { includeName: boolean; pageSize: string; landscape: boolean; margin: string; downscalePercent: number }
const BASE: Settings = { includeName: true, pageSize: "Letter", landscape: false, margin: "0", downscalePercent: 100 };
/** The desktop table's inches per margin code (EmbedInkPrint.ts MARGIN_INCHES). */
const MARGIN_IN: Record<string, number> = { "0": 0.4, "2": 0.16, "1": 0 };
const TABLET = { width: 800, height: 1280, column: 700 };
const PHONE = { width: 360, height: 780, column: 312 };

interface Mark { block: number; word: number }
interface Opts {
	blocks: string[]; marks: Mark[]; settings: Settings; mobile?: boolean; column?: number; canvasNote?: boolean; attached?: boolean;
	late?: boolean; zoomTwice?: boolean; highlighter?: boolean; span?: boolean; childStyleBeforeZoom?: boolean; throwOnBuild?: boolean;
	dropAfterBuild?: boolean; persistAfterBuild?: boolean; farLeft?: boolean; shiftLine?: boolean; exportShape?: boolean; rawStrokes?: unknown[];
	/** A note embedded in the export root, with ink or without; a font set inline on the root before the export; a pane outside it. */
	embed?: "ink" | "plain"; priorFont?: string; outside?: boolean;
	/** An inked note embedded on host block 2 as Obsidian 1.15.1 renders it (the page's embBuild); plain: an embed with no ink on block 4. */
	emb?: Emb;
}
interface Emb { shape: "obsidian" | "sizer"; anchored: boolean; wrap?: boolean; nested?: boolean; plain?: boolean }
interface Held {
	html: string; strokes: number; zf: number; zoomAtClone: string; throwFired: boolean; zoomAtThrow: string | null; svgBeforeZoom: number;
	observersArmed: number | null; observersAfterTeardown: number | null; pads: { left: string; top: string } | null;
	padsAfter: { left: string; top: string }; svg: number; strips: number; doubled: number; stripped: boolean | null; boxInline: string | null;
	canvasShown: number; swaps: number;
	dropped: { stripsBefore: number; box: boolean; boxInline: string | null; boxShown: boolean } | null;
	persisted: { stripsBefore: number } | null;
	clone: { strips: number; stripped: boolean | null; boxInline: string | null };
	space: { centres: Array<{ x: number; y: number; h: number }>; printMove: Array<{ dx: number; dy: number }>; lineH: number; screenFont: string };
	font: { screenPara: string; screenVar: string; inline: Inline };
	embLive: EmbGeom | null; embPlainCanvas: number | null; embWrap: { words: string[]; width: number } | null;
}
/** Inline --font-text per node ("" none, null no such node). */
interface Inline { div: string | null; root: string | null; inner: string | null; pane?: string | null }
interface DeskMounted { svg: number; strips: number; screenPara: string; screenVar: string; before: Inline; atBeforeprint: Inline }
interface Word { page: number; token: string | null; text: string | null; font: string | null; R: number; word: { x: number; y: number; w: number; h: number }; cross: { x: number; y: number } | null; dx: number | null; dy: number | null; ink: number }
interface Read { pages: number; words: Word[]; strays: Array<{ page: number; x0: number; y0: number; x1: number; y1: number; count: number }>; hl: number; spans: Array<{ page: number; h: number; x: number }>; inks: Array<{ page: number; cx: number; cy: number; count: number }> }

let browser: Browser;
let bundle = "";
let appCss = "";
let stylesCss = "";
let reader: Page;
const pages = new Map<string, Page>();
const pdfs = new Map<string, Bytes>();
let pdfSeq = 0;
const errors: string[] = [];

/** A page with the app's head (full app.css 1.15.1, styles.css, the instrument), or the C9 slices head. */
async function pageFor(kind: "tablet" | "phone" | "disarm" | "slices" | "screen", font: keyof typeof NF_FONTS = "default-16"): Promise<Page> {
	const key = font === "default-16" ? kind : `${kind}|${font}`;
	const have = pages.get(key);
	if (have) return have;
	const vp = kind === "phone" ? PHONE : kind === "slices" ? { width: 816, height: 1056 } : TABLET;
	const p = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
	p.on("pageerror", error => errors.push(`${key}: ${error.message}`));
	await p.setContent("<!doctype html><html><head></head><body></body></html>");
	await p.addStyleTag({ content: kind === "slices" ? OBSIDIAN_PRINT_CSS : appCss });
	await p.addStyleTag({ content: stylesCss });
	await p.addStyleTag({ content: INSTRUMENT_CSS });
	// After app.css, as Obsidian's appearance settings and a user's snippet sit (the clone copies head, so they ride).
	if (NF_FONTS[font]) await p.addStyleTag({ content: NF_FONTS[font] });
	await p.addScriptTag({ content: OBSERVER_COUNT });
	await p.addScriptTag({ content: `window.embGeom = () => ${EMB_GEOM};` });
	await p.addScriptTag({ content: bundle });
	pages.set(key, p);
	return p;
}

/**
 * Fonts for the note-font cells. The appearance settings as app.js 1.15.1 updateFontFamily / updateFontSize write them
 * (PF_FONTS): a chosen text font goes to body --font-text-override AND --font-print-override; the size to body
 * --font-text-size and html font-size. georgia-print: a user's snippet that sets only the print font, the text on the
 * default chain.
 */
const NF_FONTS = {
	"default-16": "",
	"default-26": "body{--font-text-size:26px} html{font-size:26px}",
	"bahnschrift-16": "body{--font-text-override:\"Bahnschrift\";--font-print-override:\"Bahnschrift\"}",
	"bahnschrift-26": "body{--font-text-override:\"Bahnschrift\";--font-print-override:\"Bahnschrift\";--font-text-size:26px} html{font-size:26px}",
	"georgia-print": "body{--font-print-override:\"Georgia\"}",
} as const;

beforeAll(async () => {
	if (!HAVE_ASAR) return;
	if (OUT) mkdirSync(OUT, { recursive: true });
	const asar = readFileSync(ASAR);
	appCss = utf8(asarFile(asar, "app.css"));
	stylesCss = readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8");
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "exportEmbedInkDesktopPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) } });
	bundle = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
	const files: Record<string, { contentType: string; body: string | Bytes }> = {
		"/pdf.min.mjs": { contentType: "text/javascript", body: utf8(asarFile(asar, "lib/pdfjs/pdf.min.mjs")) },
		"/pdf.worker.min.mjs": { contentType: "text/javascript", body: utf8(asarFile(asar, "lib/pdfjs/pdf.worker.min.mjs")) },
		"/reader.html": { contentType: "text/html", body: `<!doctype html><html><body><script>window.activeWindow=window;window.activeDocument=document;</script><script type="module">${READER_JS}</script></body></html>` },
	};
	reader = await browser.newPage();
	reader.on("pageerror", error => errors.push(`reader: ${error.message}`));
	await reader.route("http://reader.test/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		const pdf = pdfs.get(path);
		const f = files[path] ?? (pdf ? { contentType: "application/pdf", body: pdf } : undefined);
		return f ? route.fulfill({ status: 200, contentType: f.contentType, body: f.body }) : route.fulfill({ status: 404 });
	});
	await reader.goto("http://reader.test/reader.html");
	await reader.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
}, T);
afterAll(async () => { await browser?.close(); });

const tokenOf = (blocks: string[], m: Mark) => blocks[m.block]!.split(" ")[m.word]!;
const label = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 60);

async function readPdf(pdf: Bytes, tokens: string[], zf: number, name: string): Promise<Read> {
	const path = `/pdf/${++pdfSeq}.pdf`;
	pdfs.set(path, pdf);
	if (OUT) writeFileSync(`${OUT}/${pdfSeq}-${label(name)}.pdf`, pdf);
	try {
		return await reader.evaluate(([u, t, z]) => (window as unknown as { readPdf(u: string, t: string[], z: number): Promise<Read> }).readPdf(u, t, z), [`http://reader.test${path}`, tokens, zf] as const);
	} finally {
		pdfs.delete(path);
	}
}

async function replay(p: Page, o: Opts): Promise<Held> {
	return p.evaluate((x) => (window as unknown as { mobileExport(o: unknown): Promise<Held> }).mobileExport(x),
		{ mobile: true, column: TABLET.column, ...o, plantBoxShown: PLANT === "box-shown" });
}

/**
 * The native side's print, scripts off: the dialog's page size, orientation and margin, scale 1 (app.js @2682963-@2683128).
 * media "screen" is the reference print: the same page in the font the note shows on screen.
 */
async function printNative(html: string, s: Settings, media: "print" | "screen" = "print") {
	const ctx = await browser.newContext({ javaScriptEnabled: false });
	try {
		const p = await ctx.newPage();
		let h = html;
		if (PLANT === "unstyled") h = h.replace(/<style[\s\S]*?<\/style>/gi, "");
		// The reference print only: the app parks a mobile export div off screen in screen media (left -100000px); bring it on.
		if (media === "screen") h = h.replace("</head>", "<style>body>.print{position:static!important;left:auto!important}</style></head>");
		await p.setContent(h);
		await p.emulateMedia({ media });
		const styled = await p.evaluate(() => {
			const d = document.querySelector("body > .print"), para = document.querySelector(".print p");
			return { printShown: !!d && getComputedStyle(d).display !== "none", font: para ? getComputedStyle(para).fontFamily : "", paras: [...document.querySelectorAll(".print p")].map(q => getComputedStyle(q).fontFamily) };
		});
		const m = `${MARGIN_IN[s.margin]}in`;
		const options = { format: s.pageSize, landscape: s.landscape, margin: { top: m, right: m, bottom: m, left: m }, printBackground: true, scale: 1 };
		const pdf = await p.pdf(options);
		return { pdf, styled, scale: options.scale };
	} finally {
		await ctx.close();
	}
}

/**
 * The desktop export on a page: mount, beforeprint, print media, page.pdf at the downscale, afterprint. screenRef: a page.pdf
 * in screen media after the print, the reference for the font the note shows. After, not before: page.pdf runs a print of
 * its own (beforeprint, afterprint), so a reference taken between the export's beforeprint and its print ended the
 * export's print before it was printed, and the print that followed had only the media change.
 */
async function desktopPrint(p: Page, o: Opts, screenRef = false, geomExpr: string | null = null) {
	const mounted = await p.evaluate((x) => (window as unknown as { desktopMount(o: unknown): Promise<DeskMounted> }).desktopMount(x), { column: TABLET.column, ...o });
	const m = `${MARGIN_IN[o.settings.margin]}in`;
	const options = { format: o.settings.pageSize, landscape: o.settings.landscape, margin: { top: m, right: m, bottom: m, left: m },
		printBackground: true, scale: Math.min(2, Math.max(0.1, o.settings.downscalePercent / 100)) };
	let screenPdf: Bytes | null = null;
	await p.emulateMedia({ media: "print" });
	await p.evaluate(() => (window as unknown as { twoFrames(): Promise<void> }).twoFrames());
	const during = await p.evaluate(() => (window as unknown as { deskRead(): { paras: string[]; inline: Inline } }).deskRead());
	// The embed cells' read of the page in print media, as it prints.
	const geom = geomExpr ? ((await p.evaluate(geomExpr)) as EmbGeom) : null;
	const pdf = await p.pdf(options);
	await p.emulateMedia({ media: "screen" });
	if (screenRef) screenPdf = await p.pdf(options);
	const ended = await p.evaluate(() => (window as unknown as { desktopEnd(): Promise<{ swaps: number; after: Inline; space: { centres: unknown[]; printMove: unknown[] } }> }).desktopEnd());
	return { pdf, screenPdf, mounted, during, geom, ...ended };
}

const near1 = (v: number | null | undefined) => v !== null && v !== undefined && Math.abs(v) <= 1;

/**
 * N4: page 2 is styled before page.pdf; N5: page.pdf got scale 1, so the downscale is counted once (as the div's zoom).
 * An inked note on the default font prints its text in the font the note shows
 * (the paragraph's font on screen, read on page 1 before the build), not the app's print chain.
 */
function expectStyled(n: { styled: { printShown: boolean; font: string }; scale: number }, name: string, screen: string) {
	expect({ printShown: n.styled.printShown, printFont: n.styled.font, scale: n.scale },
		`${name}: page 2 styled (.print shown, paragraph font "${n.styled.font}", the note's screen font "${screen}") and page.pdf scale 1`).toEqual({ printShown: true, printFont: screen, scale: 1 });
}
/** A PDF font name without its subset tag ("ABCDEF+"). */
const fontName = (f: string | null | undefined) => (f ?? "").replace(/^[A-Z]{6}\+/, "");
/** The print font in the PDF itself: the font pdf.js gives each marked word's text run. */
function expectPdfFont(r: Read, tokens: string[], want: string, name: string) {
	const got = tokens.map(t => fontName(r.words.find(w => w.token === t)?.font));
	expect(got, `${name}: the PDF's font per marked word (${tokens.join(", ")}), want "${want}"`).toEqual(tokens.map(() => want));
}

type Move = { dx: number; dy: number };
/** Each mark's print-font move from noteSpace (the probe holds the note's text alone, no ink), keyed by its token, and the zf. */
const movesOf = (held: Held, tokens: string[]) => ({ zf: held.zf, by: new Map(tokens.map((t, k) => [t, held.space.printMove[k]] as const)) });

/**
 * The bar: each marked word found with its token, one ink blob in its window, no
 * ink outside, and the cross minus the word centre within 1 page px across and down, raw, on every marked word, the late
 * word too. The print font's own move of that word (probe) is printed beside it, not taken off: it is the cell's premise
 * (the app's print chain would move the word), no longer part of the bar.
 */
function expectOnWords(r: Read, tokens: string[], name: string, o: { highlighter?: boolean; spanZf?: number; move?: { zf: number; by: Map<string, Move | undefined> } } = {}) {
	for (const t of tokens) {
		const w = r.words.find(x => x.token === t);
		const m = o.move?.by.get(t);
		expect({ found: !!w, ink: w?.ink ?? 0, x: near1(w?.dx), y: near1(w?.dy) },
			`${name}: "${t}" page ${w ? w.page + 1 : "-"}: cross minus word centre x ${w?.dx}, y ${w?.dy} (raw); print font move in the probe ${m ? `${m.dx}, ${m.dy}` : "-"} at zf ${o.move?.zf ?? 1}; ink blobs in window ${w?.ink}`).toEqual({ found: true, ink: 1, x: true, y: true });
	}
	expect(r.strays, `${name}: no visible ink outside the marked words' windows (ink twice)`).toEqual([]);
	if (o.highlighter) expect(r.hl, `${name}: the highlighter stroke, one wash`).toBe(1);
	if (o.spanZf !== undefined) {
		const zf = o.spanZf, p1 = r.spans.filter(s => s.page === 0);
		expect({ blobs: p1.length, height: p1.length === 1 && Math.abs(p1[0]!.h - 60 * zf) <= 4 * zf + 1.5 },
			`${name}: the stroke across the block 0/1 break is one blue blob on page 1, height ${p1.map(s => s.h).join(", ")} vs ${60 * zf}`).toEqual({ blobs: 1, height: true });
	}
}
const noErrors = () => expect(errors.filter(e => !e.includes("PLANTED-BUILD-THROW"))).toEqual([]);
const log = (tag: string, name: string, held: Partial<Held> | null, extra: Record<string, unknown> = {}) =>
	console.log("EXPORT-EMBED-INK-DESKTOP", tag, name, JSON.stringify({ ...(held ?? {}), html: held?.html?.length, ...extra }));

const EMB_HOST = ["Hostfirst line of the host note above its embed", "Hostlast line of the host note and the embed comes next", "![[Embed look]]", "Hostafter line of the host note below its embed"];
const EMB_HOST_PLAIN = [...EMB_HOST, "![[Plain look]]"];
const EMB_HOST_MARKS: Mark[] = [{ block: 0, word: 0 }, { block: 1, word: 0 }, { block: 3, word: 0 }];
const EMB_HOST_TOKENS = ["Hostfirst", "Hostlast", "Hostafter"];
const EMB_TOKENS_SHORT = ["Embedfirst", "Embedmid", "Embedlate"];
const embTokens = (emb: Emb) => (emb.wrap ? [...EMB_TOKENS_SHORT, emb.nested ? "Embedwrapnested" : "Embedwrap"] : EMB_TOKENS_SHORT);
const EMB_BAR = 1.5;
/** The no-ink embed's view in print at base: out of its span after the parse, the print's --file-margins (cause3 as-is). */
const EMB_PLAIN_BASE_PAD = "32px 32px 32px 32px";
const embOpts = (emb: Emb): Opts => ({ blocks: emb.plain ? EMB_HOST_PLAIN : EMB_HOST, marks: EMB_HOST_MARKS, settings: { ...BASE }, attached: true, emb });

interface EmbView {
	/** zf: the view's zoom as printed (its box over its css width), for page px to css px. */
	style: string | null; pad: string; width: string; zf: number; inSpan: boolean;
	view: { x: number; y: number; w: number; h: number }; blocks: Array<{ x: number; y: number; w: number; h: number }>;
	wrap?: { lh: number; lastLine: number; lastRight: number; column: number; wordLine: number; wordLeft: number };
}
interface EmbGeom { ink: EmbView | null; outer: EmbView | null; plain: EmbView | null; plainInner: EmbView | null }
/**
 * The embeds' views as laid out now, px from each one's content box (the ink layer's box): padding, inline style, the
 * view's and each paragraph's box, and for the wrapped paragraph the line its line-1 word and Embedwrap sit on. A string
 * expression, so it runs in the app page, in the clone loaded with scripts off, and in the desktop print alike.
 */
const EMB_GEOM = `(() => {
	const r2 = v => Math.round(v * 100) / 100;
	const pad = s => [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(" ");
	const read = key => {
		const view = document.querySelector('.print [data-probe="' + key + '"]');
		if (!view) return null;
		const cr = view.parentElement.getBoundingClientRect(), vs = getComputedStyle(view);
		const at = r => ({ x: r2(r.left - cr.left), y: r2(r.top - cr.top), w: r2(r.width), h: r2(r.height) });
		const zf = Math.round(view.getBoundingClientRect().width / (parseFloat(vs.width) || 1) * 1e5) / 1e5;
		const out = { style: view.getAttribute("style"), pad: pad(vs), width: vs.width, zf, inSpan: !!view.closest(".inline-embed"),
			view: at(view.getBoundingClientRect()), blocks: [...view.querySelectorAll("p")].map(b => at(b.getBoundingClientRect())) };
		const wp = view.querySelector('[data-probe="emb-wrap"]');
		if (wp) {
			const pr = wp.getBoundingClientRect(), ps = getComputedStyle(wp);
			const lh = (parseFloat(ps.lineHeight) || 24) * (pr.width / (parseFloat(ps.width) || pr.width));
			const line = r => Math.round((r.top + r.height / 2 - pr.top) / lh - 0.5) + 1;
			const last = wp.querySelector("#ew-last").getBoundingClientRect(), word = wp.querySelector(".mark-word").getBoundingClientRect();
			out.wrap = { lh: r2(lh), lastLine: line(last), lastRight: r2(last.right - pr.left), column: r2(pr.width), wordLine: line(word), wordLeft: r2(word.left - pr.left) };
		}
		return out;
	};
	return { ink: read("emb-ink"), outer: read("emb-outer"), plain: read("emb-plain"), plainInner: read("emb-plain-inner") };
})()`;

/** The wrapped paragraph lays out as on screen: line 1's last word on line 1 and inside the column, Embedwrap first on line 2. */
const wrapHolds = (w: EmbView["wrap"] | undefined) => !!w && w.lastLine === 1 && w.lastRight <= w.column + 0.5 && w.wordLine === 2 && w.wordLeft <= 1;

/** A test-only stand-in at base for the other fix shape, and a strip of the fix's width pin (HW_EMP_PLANT). */
const EMB_SHIFT_CSS = "<style>@media print{.print .markdown-embed-content>svg.handwriting-embed-ink{translate:8px 32px}}</style>";
function embPlantHtml(html: string): { html: string; planted: boolean } {
	if (PLANT === "embed-shift") return { html: html.replace("</head>", `${EMB_SHIFT_CSS}</head>`), planted: html.includes("</head>") };
	if (PLANT === "pin-pad-only") {
		const out = html.replace(/(<div[^>]*data-probe="emb-ink"[^>]*style="[^"]*?)max-width:[^;"]*;?\s*/, "$1");
		return { html: out, planted: out !== html };
	}
	return { html, planted: false };
}
/** Cause plant A as a string: the inked embed's line written as a div, so the parse keeps its content box in the span. */
function embDivLine(html: string): string | null {
	const open = '<p data-probe-line="emb-ink">', close = "</div></span></p>";
	const i = html.indexOf(open);
	const j = i < 0 ? -1 : html.indexOf(close, i);
	if (i < 0 || j < 0 || html.indexOf(open, i + 1) >= 0) return null;
	return html.slice(0, i) + '<div data-probe-line="emb-ink">' + html.slice(i + open.length, j) + "</div></span></div>" + html.slice(j + close.length);
}
/** The clone loaded as the native side loads it (scripts off), read in print media. */
async function cloneGeom(html: string): Promise<EmbGeom> {
	const ctx = await browser.newContext({ javaScriptEnabled: false });
	try {
		const p = await ctx.newPage();
		await p.setContent(html);
		await p.emulateMedia({ media: "print" });
		return (await p.evaluate(EMB_GEOM)) as EmbGeom;
	} finally {
		await ctx.close();
	}
}

interface Paired { rows: Map<string, { page: number; dx: number; dy: number }>; same: boolean; words: number; inks: number }
/** Each marked word paired with an ink blob by order down the page: the k-th word from the top takes the k-th blob. */
function pairByOrder(r: Read, tokens: string[]): Paired {
	const words = r.words.filter(w => w.token !== null && tokens.includes(w.token)).sort((a, b) => a.page - b.page || a.word.y - b.word.y);
	const inks = r.inks.slice().sort((a, b) => a.page - b.page || a.cy - b.cy);
	const rows = new Map<string, { page: number; dx: number; dy: number }>();
	const same = words.length === tokens.length && new Set(words.map(w => w.token)).size === tokens.length && words.length === inks.length && words.every((w, i) => w.page === inks[i]!.page);
	if (same) words.forEach((w, i) => rows.set(w.token!, { page: w.page, dx: r2n(inks[i]!.cx - w.word.x), dy: r2n(inks[i]!.cy - w.word.y) }));
	return { rows, same, words: words.length, inks: inks.length };
}
const r2n = (v: number) => Math.round(v * 100) / 100;

interface EmbMobile { held: Held; html: string; planted: boolean; r: Read; paired: Paired; geom: EmbGeom }
async function embMobile(p: Page, o: Opts, name: string, tokens: string[]): Promise<EmbMobile> {
	const held = await replay(p, o);
	const { html, planted } = embPlantHtml(held.html);
	const n = await printNative(html, o.settings);
	const r = await readPdf(n.pdf, tokens, held.zf, `${name}-mobile`);
	return { held, html, planted, r, paired: pairByOrder(r, tokens), geom: await cloneGeom(html) };
}
async function embDesktop(p: Page, o: Opts, name: string, tokens: string[]) {
	const d = await desktopPrint(p, o, false, EMB_GEOM);
	const r = await readPdf(d.pdf, tokens, 1, `${name}-desktop`);
	return { d, r, paired: pairByOrder(r, tokens), geom: d.geom! };
}
/** The host's words: the harness's own bar, each cross within 1 page px of its word, one blob in its window. */
const hostRows = (r: Read) => EMB_HOST_TOKENS.map(t => { const w = r.words.find(x => x.token === t); return { t, ok: !!w && w.ink === 1 && near1(w.dx) && near1(w.dy), dx: w?.dx ?? null, dy: w?.dy ?? null, ink: w?.ink ?? 0 }; });
const embLog = (tag: string, name: string, extra: Record<string, unknown>) => console.log("EXPORT-EMBED-INK-DESKTOP", tag, name, JSON.stringify(extra));

// ---- Export cells: D desktop, M phone and tablet. ----

type DeskPath = "desktop" | "mobile";
type DeskCase = "real" | "legacy" | "sizer";
type Pin = [number, number];
interface DeskRead { words: Record<string, Pin | null>; host: Record<string, Pin | null>; zf: number; same: boolean; counts: [number, number]; strays: Read["strays"] }
const DESK_CASES: Record<DeskCase, Emb> = {
	real: { shape: "obsidian", anchored: true },
	legacy: { shape: "obsidian", anchored: false },
	sizer: { shape: "sizer", anchored: true },
};
const DESK_TOKENS = [...EMB_HOST_TOKENS, ...EMB_TOKENS_SHORT];

/**
 * Base reads at e4a19340, no source change (the red-first run): each word's cross less its word, x and y. Embedded words in
 * css px (page px over the print's zoom), host words in page px as read. null: no pin yet, the cell prints the read and
 * fails.
 */
const DESK_PINS: Record<DeskPath, Record<DeskCase, { words: Record<string, Pin | null>; host: Record<string, Pin | null> }>> = {
	desktop: {
		real: { words: { Embedfirst: [-23.73, -0.42], Embedmid: [-23.94, -0.69], Embedlate: [-23.94, 0] }, host: { Hostfirst: [-0.22, 0.53], Hostlast: [0.1, -0.42], Hostafter: [0.41, -0.44] } },
		legacy: { words: { Embedfirst: [-23.73, -0.42], Embedmid: [-23.71, 7.29], Embedlate: [-23.81, 16.04] }, host: { Hostfirst: [-0.22, 0.53], Hostlast: [0.1, -0.42], Hostafter: [0.41, -0.44] } },
		sizer: { words: { Embedfirst: [-0.05, -0.43], Embedmid: [-0.05, -0.68], Embedlate: [-0.02, -1.03] }, host: { Hostfirst: [-0.22, 0.53], Hostlast: [0.1, -0.42], Hostafter: [0.41, -0.44] } },
	},
	mobile: {
		real: { words: { Embedfirst: [-23.46, -0.12], Embedmid: [-23.72, -0.56], Embedlate: [-24.28, -0.09] }, host: { Hostfirst: [-0.2, -0.14], Hostlast: [0.2, -0.11], Hostafter: [0.23, -0.13] } },
		legacy: { words: { Embedfirst: [-23.46, -0.12], Embedmid: [-23.68, 7.39], Embedlate: [-24.21, 15.89] }, host: { Hostfirst: [-0.2, -0.14], Hostlast: [0.2, -0.11], Hostafter: [0.23, -0.13] } },
		sizer: { words: { Embedfirst: [0.08, -0.11], Embedmid: [-0.08, -0.59], Embedlate: [-0.92, -0.06] }, host: { Hostfirst: [-0.2, -0.14], Hostlast: [0.2, -0.11], Hostafter: [0.23, -0.13] } },
	},
};
/**
 * The bars, css px. The reader takes each cross's centre from the printed page's pixels. Moving a whole embed's ink by the
 * column's inset puts it on a new sub-pixel grid, so two reads of one place part by up to about 0.2 px from word to word.
 * So an exported embed word is held across within half a px of the sizer control's, and down within a quarter px of base
 * (the fix moves nothing up or down; a one px step still shows). The control, the host's words and the screen do not move
 * and keep a hundredth.
 */
const EXPORT_X_BAR = 0.5, EXPORT_Y_BAR = 0.25, PIN_BAR = 0.01;

/**
 * One case's export on both paths, read once and kept for the cells that need it. The phone and tablet export runs first: a
 * page arms its export triggers once, at its first embed, and a desktop print first would arm none.
 */
const deskReads = new Map<DeskCase, Promise<Record<DeskPath, DeskRead>>>();
function deskCase(c: DeskCase): Promise<Record<DeskPath, DeskRead>> {
	let got = deskReads.get(c);
	if (!got) {
		got = (async () => {
			const p = await pageFor("tablet");
			const o = embOpts(DESK_CASES[c]);
			const m = await embMobile(p, o, `desk-${c}`, DESK_TOKENS);
			const d = await embDesktop(p, o, `desk-${c}`, DESK_TOKENS);
			const read = (paired: Paired, zf: number, r: Read): DeskRead => {
				const row = (t: string, z: number): Pin | null => { const v = paired.rows.get(t); return v ? [r2n(v.dx / z), r2n(v.dy / z)] : null; };
				return {
					words: Object.fromEntries(EMB_TOKENS_SHORT.map(t => [t, row(t, zf)])), host: Object.fromEntries(EMB_HOST_TOKENS.map(t => [t, row(t, 1)])),
					zf, same: paired.same, counts: [paired.words, paired.inks], strays: r.strays,
				};
			};
			const out = { mobile: read(m.paired, m.held.zf, m.r), desktop: read(d.paired, d.geom.ink?.zf ?? 1, d.r) };
			console.log("EXPORT-EMBED-INK-DESKTOP READ", c, JSON.stringify(out));
			return out;
		})();
		deskReads.set(c, got);
	}
	return got;
}

const nearPin = (v: number | null | undefined, pin: number | null | undefined, bar: number) =>
	v !== null && v !== undefined && pin !== null && pin !== undefined && Math.abs(v - pin) <= bar + 1e-9;
const fmt = (v: Pin | null | undefined) => (v ? `${v[0]}, ${v[1]}` : "none");

/** Premise: every marked word found once and paired with one ink blob, on the same page. */
function expectPaired(read: DeskRead, name: string) {
	expect(read.same, `premise: ${name}: every marked word found once, one ink blob per word, same pages (${read.counts[0]} words, ${read.counts[1]} blobs)`).toBe(true);
}
/** The host's words as at base, within 0.01, x and y. */
function expectHostAsBase(read: DeskRead, path: DeskPath, c: DeskCase, name: string) {
	const pins = DESK_PINS[path][c].host;
	const off = EMB_HOST_TOKENS.filter(t => !nearPin(read.host[t]?.[0], pins[t]?.[0], PIN_BAR) || !nearPin(read.host[t]?.[1], pins[t]?.[1], PIN_BAR))
		.map(t => `${t}: read ${fmt(read.host[t])}, base ${fmt(pins[t])}`);
	expect(off, `${name}: the host's words as at base within ${PIN_BAR} page px`).toEqual([]);
}

const DESK_FIX: Array<[string, DeskPath, Exclude<DeskCase, "sizer">]> = [
	["D1 desktop, real (anchored ink)", "desktop", "real"],
	["D2 desktop, legacy (ink saved before anchors)", "desktop", "legacy"],
	["M1 phone and tablet, real (anchored ink)", "mobile", "real"],
	["M2 phone and tablet, legacy (ink saved before anchors)", "mobile", "legacy"],
];
itA.each(DESK_FIX)("%s: each embedded word's ink on its words, as on the sizer control; nothing moves up or down", async (name, path, c) => {
	const read = (await deskCase(c))[path], control = (await deskCase("sizer"))[path];
	expectPaired(read, name);
	expectPaired(control, `${name}, the control`);
	expect(Math.abs(read.zf - control.zf) <= 1e-4, `premise: ${name}: the case and the control print at one zoom (${read.zf}, ${control.zf})`).toBe(true);
	const pins = DESK_PINS[path][c].words;
	const x = EMB_TOKENS_SHORT.filter(t => !nearPin(read.words[t]?.[0], control.words[t]?.[0], EXPORT_X_BAR))
		.map(t => `${t}: x ${read.words[t]?.[0] ?? "none"}, the control's ${control.words[t]?.[0] ?? "none"}`);
	const y = EMB_TOKENS_SHORT.filter(t => !nearPin(read.words[t]?.[1], pins[t]?.[1], EXPORT_Y_BAR))
		.map(t => `${t}: y ${read.words[t]?.[1] ?? "none"}, base ${pins[t]?.[1] ?? "none"}`);
	expect(x, `${name}: each embedded word's cross across, within ${EXPORT_X_BAR} css px of the sizer control's (at base about 24 px left)`).toEqual([]);
	expect(y, `${name}: each embedded word's cross down, as at base within ${EXPORT_Y_BAR} css px`).toEqual([]);
	expectHostAsBase(read, path, c, name);
	noErrors();
}, T);

const DESK_CONTROL: Array<[string, DeskPath]> = [["D3 desktop", "desktop"], ["M3 phone and tablet", "mobile"]];
itA.each(DESK_CONTROL)("%s, the sizer control: its words and the host's as at base, x and y", async (name, path) => {
	const read = (await deskCase("sizer"))[path];
	expectPaired(read, name);
	const pins = DESK_PINS[path].sizer.words;
	const off = EMB_TOKENS_SHORT.filter(t => !nearPin(read.words[t]?.[0], pins[t]?.[0], PIN_BAR) || !nearPin(read.words[t]?.[1], pins[t]?.[1], PIN_BAR))
		.map(t => `${t}: read ${fmt(read.words[t])}, base ${fmt(pins[t])}`);
	expect(off, `${name}: the control's embedded words as at base within ${PIN_BAR} css px`).toEqual([]);
	expectHostAsBase(read, path, "sizer", name);
	noErrors();
}, T);

// ---- Screen cells: the same embed on screen. ----
// Each case mounts one host (a reading view or Live Preview) with the embed in one shape (dr: the on-screen embed, with its
// sizer; _5: the static embed, no sizer), attaches as the plugin's post-processor does, and reads the embed's own canvas:
// magenta blobs, paired with the marked words by order (one cross per line). Rows: cross centre less word centre, css px.
// Its own page ("screen"), so no export arming reaches it.

const SCR_CASES: Array<[string, "reading" | "editor", "dr" | "_5"]> = [
	["S1 reading view, dr (sizer)", "reading", "dr"],
	["S2 Live Preview, dr (sizer)", "editor", "dr"],
	["S3 reading view, _5 (static, no sizer)", "reading", "_5"],
	["S4 Live Preview, _5 (static, no sizer)", "editor", "_5"],
];
/** Base reads at e4a19340 (the red-first run). _5 sits about 24 px left on screen, which this fix leaves. */
const SCR_PINS: Record<string, Record<string, Pin | null>> = {
	"S1 reading view, dr (sizer)": { Embedfirst: [0.13, -0.1], Embedmid: [0, -0.1], Embedlate: [0.23, -0.1] },
	"S2 Live Preview, dr (sizer)": { Embedfirst: [0.13, -0.09], Embedmid: [0, -0.09], Embedlate: [0.23, -0.09] },
	"S3 reading view, _5 (static, no sizer)": { Embedfirst: [-23.87, 0], Embedmid: [-24, 0], Embedlate: [-23.77, 0] },
	"S4 Live Preview, _5 (static, no sizer)": { Embedfirst: [-23.87, 0], Embedmid: [-24, 0], Embedlate: [-23.77, 0] },
};
interface ScrWord { token: string; found: boolean; dx: number | null; dy: number | null; box: number[] | null }
itA.each(SCR_CASES)("%s: on screen each embedded word's ink as at base, x and y", async (name, host, shape) => {
	const p = await pageFor("screen");
	const r = await p.evaluate((x) => (window as unknown as { screenEmbed(o: unknown): Promise<{ words: ScrWord[]; meta: Record<string, unknown> }> }).screenEmbed(x),
		{ column: TABLET.column, host, shape, emb: { shape: "obsidian", anchored: true } });
	console.log("EXPORT-EMBED-INK-DESKTOP SCREEN", JSON.stringify({ name, words: r.words, meta: r.meta }));
	expect(r.words.map(w => w.found), `premise: ${name}: the embed's canvas holds one cross blob per marked word`).toEqual(r.words.map(() => true));
	expect(((r.meta.content as { w?: number } | undefined)?.w ?? 0) > 100, `premise: ${name}: the embed's column is laid out (${JSON.stringify(r.meta.content)})`).toBe(true);
	const pins = SCR_PINS[name]!;
	const off = r.words.filter(w => !nearPin(w.dx, pins[w.token]?.[0], PIN_BAR) || !nearPin(w.dy, pins[w.token]?.[1], PIN_BAR))
		.map(w => `${w.token}: read ${w.dx}, ${w.dy}, base ${fmt(pins[w.token])}`);
	expect(off, `${name}: each embedded word's cross as at base within ${PIN_BAR} css px (on screen nothing moves)`).toEqual([]);
	noErrors();
}, T);
