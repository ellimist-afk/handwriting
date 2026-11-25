/**
 * A PHONE OR TABLET EXPORT TO PDF CARRIES THE INK, ON ITS WORDS.
 *
 * The mobile app's Export to PDF (obsidian 1.15.1 app.js, printToPdfMobile @2682211) fires no print event. It renders the
 * note into `body > div.print.theme-light`, awaits print(), sets that div's zoom to the dialog's downscale, waits 200 ms,
 * then builds the page it hands to the native side: html shallow, head deep with every script removed, body shallow, the
 * div deep, as one string. A canvas carries no pixels through that string, so before the fix no ink reaches a tablet's
 * PDF at all.
 *
 * Each replay cell runs those steps in Chromium with the plugin live on the page (its observers included), takes the
 * string, loads it into a second page with scripts off, checks that page is styled (the print rule shows `.print`, a
 * paragraph's font is the print chain) and prints it with the dialog's page size, orientation and margin, at scale 1.
 *
 * The PDF is read with the pdf.js Obsidian ships (the same build the render harness loads in PrintStrokes), not by
 * parsing its streams: Skia puts each highlighter run in a transparency group, and a strip draws whole strokes clipped
 * by its viewBox, so a stream read misses ink and boxes ink that is not visible. Each page is rasterised and its
 * pixels are classed by hue: the pen ink is magenta, each marked word a green background box, the highlighter yellow,
 * one stroke across a block break blue. Each marked word is then rendered again, in a window around it, at a resolution
 * that scales with its height; the cross's centre (its core pixels' centroid) must sit within 1 page px of the word's
 * centre (its green box's centre), with exactly one ink blob in the window. Ink twice is visible ink: any magenta blob
 * outside every word's window fails. The word's token comes from pdf.js text content overlapping the green box.
 *
 * The reader is calibrated first (C9): it reads green on the desktop export shape at base (ExportPrintAnchor's page),
 * finds the highlighter, and HW_EMP_PLANT=shift-line (ink one line down) must turn it red.
 *
 * The app page's head is the app's: the whole app.css of Obsidian 1.15.1 read from the app's asar (HW_OBSIDIAN_ASAR;
 * app.css 600178 bytes, sha256 1bca212a...), then the plugin's styles.css, as the clone copies head. The app's print chain
 * (Arial on Windows) differs from the screen's on the default font, and a word late in a wrapped paragraph re-wraps in it
 * (C11's premise); an inked note prints in the font it shows, so its words keep their ink.
 *
 * Margins in inches are the desktop table's; the native side's are not in the bundle, so the margins are untested here.
 * Chromium's print stands in for the Android WebView's.
 *
 * Env: HW_OBSIDIAN_ASAR (required; every cell skips with a loud line without it, so CI skips them), HW_EMP_PLANT
 * (shift-line, box-shown, unstyled, embed-shift, pin-pad-only), HW_EMP_OUT (a directory that keeps each PDF), HW_SHAPE_DIR (C8).
 *
 * Run: npm run test:render -- ExportMobilePdf.
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
if (!HAVE_ASAR) console.log("EXPORT-MOBILE-PDF SKIP: HW_OBSIDIAN_ASAR is unset or missing; every cell in this file is skipped");
if (HAVE_ASAR && !HAVE_SHAPE) console.log("EXPORT-MOBILE-PDF SKIP C8: HW_SHAPE_DIR is unset or lacks Untitled 1.md and sidecar.json");
if (PLANT) console.log("EXPORT-MOBILE-PDF PLANT", PLANT);
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
// The second rule stands in for a theme's paragraph margin in em, on the one line a cell marks (data-probe-em).
const INSTRUMENT_CSS = ".mark-word{background:#00ff00}.markdown-rendered p[data-probe-em]{margin-top:1.5em;margin-bottom:1.5em}";

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
import { attachEmbedInkOnceReady, embedInkChanged, initEmbedInkColumnWidth, initEmbedInkRefresh, placeStrokes, queueReplace, teardownEmbedInk } from "../../src/inline/EmbedInk";
import { disarmPrintSwaps, embedInkPrintSwaps, initEmbedInkPrintCanvas, initEmbedInkPrintPaper, releasePrintStrips } from "../../src/inline/EmbedInkPrint";
import { lineTopIn } from "../../src/inline/EmbedInkLines";
import { measureSpans } from "../../src/inline/EmbedInkMeasure";
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
 * Host ink over the no-ink embeds (o.emb.hostOver). The same two notes with a first word to mark: Plainword in
 * Plain look ("plain"), Innerword in Plain inner ("inner"). "after": host block 4's line runs on past its embed, and
 * its first word after it (Hostpast) is marked. quiet: a third no-ink embed (Quiet look) alone on host block 5, no host
 * ink in its block, its root registered as Plain inner's is.
 */
const EMB_PLAIN_HOST_BLOCKS = ["Plainword opens a plain embedded note with no ink of its own"];
const EMB_PLAIN_INNER_HOST_BLOCKS = ["Innerword opens a plain inner note with no ink by the time it prints"];
const EMB_AFTER_TEXT = " closes the host block after its plain embed";
const EMB_QUIET_PATH = "Quiet look.md";
const EMB_QUIET_BLOCKS = ["A quiet embedded note with no ink and no host ink in its block"];
/**
 * The marked words host ink goes on, by id: hx0 Plainword, hx1 Hostpast, hx2 Innerword, hx3 Pdfbelow (the side embed
 * cells), hx4 Inkpast (EMB-I: after the inked embed on its own line). Each cross is anchored to its word's host block:
 * block 4, but hx4's is block 2, the inked embed's, and any other word's the block it stands in (hx3 on the inked line).
 */
const HOST_OVER_IDS = ["hx0", "hx1", "hx2", "hx3", "hx4"];
const HOST_OVER_BLOCK = { hx4: 2 };
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
let embNodes = null, embOuterNodes = null, embPlainNodes = null, embPlainInnerNodes = null, embQuietNodes = null, embSideNodes = null;
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
/** A view's first paragraph with its first word in a green span (host ink goes on it). */
function markFirst(nodes, id) {
	const p = nodes.blocks[0];
	const words = p.textContent.split(" ");
	p.innerHTML = '<span class="mark-word" id="' + id + '">' + words[0] + "</span> " + words.slice(1).join(" ");
}
function embMount(sections, o) {
	const over = o.emb.hostOver ?? [];
	embOuterNodes = o.emb.nested ? embBuild(sections[2], "Outer look", "emb-outer", EMB_OUTER_BLOCKS, false, "obsidian") : null;
	embNodes = embBuild(embOuterNodes ? embOuterNodes.view : sections[2], "Embed look", "emb-ink", embBlocks, true, o.emb.shape);
	embPlainNodes = o.emb.plain ? embBuild(sections[4], "Plain look", "emb-plain", over.length ? EMB_PLAIN_HOST_BLOCKS : EMB_PLAIN_BLOCKS, false, "obsidian") : null;
	embPlainInnerNodes = embPlainNodes ? embBuild(embPlainNodes.view, "Plain inner", "emb-plain-inner", over.length ? EMB_PLAIN_INNER_HOST_BLOCKS : EMB_PLAIN_INNER_BLOCKS, false, "obsidian") : null;
	if (over.includes("plain")) markFirst(embPlainNodes, "hx0");
	if (over.includes("inner")) markFirst(embPlainInnerNodes, "hx2");
	if (over.includes("after")) {
		// The host's line goes on past the embed, in the same paragraph, as the reading view renders "![[Plain look]] Hostpast ...".
		const para = embPlainNodes.embed.parentElement;
		para.append(" ");
		const w = para.appendChild(document.createElement("span"));
		w.className = "mark-word";
		w.id = "hx1";
		w.textContent = "Hostpast";
		para.append(EMB_AFTER_TEXT);
	}
	embQuietNodes = o.emb.quiet ? embBuild(sections[5], "Quiet look", "emb-quiet", EMB_QUIET_BLOCKS, false, "obsidian") : null;
	if (o.emb.inkedHost) {
		// The inked embed's line goes on past its span, as the reading view renders "![[Embed look]] Inkpast ...", and
		// Inkpast takes a host cross, so the inked embed's block holds a host strip.
		const para = embNodes.embed.parentElement;
		para.append(" ");
		const w = para.appendChild(document.createElement("span"));
		w.className = "mark-word";
		w.id = "hx4";
		w.textContent = "Inkpast";
		para.append(EMB_INKED_AFTER_TEXT);
	}
	if (o.emb.inkLine && o.emb.inkLine.after !== "over") {
		// The inked embed's line runs on past its span ("same": "![[Embed look]] Inkpast ...") or goes on to the line under
		// it in its paragraph ("under": two source lines with no blank line between them, one p, the break a br). Its word
		// takes the host cross of inkLineStrokes; "over" puts that cross on Embedmid, the embed's own word.
		const para = embNodes.embed.parentElement;
		const same = o.emb.inkLine.after === "same";
		if (same) para.append(" ");
		else para.appendChild(document.createElement("br"));
		const w = para.appendChild(document.createElement("span"));
		w.className = "mark-word";
		w.id = "hl0";
		w.textContent = same ? "Inkpast" : "Underword";
		para.append(same ? EMB_INKED_AFTER_TEXT : " closes the inked embed's paragraph");
	}
	embSideNodes = o.emb.pdf ? embSide(o.emb.pdf.where === "inked" ? embNodes.embed.parentElement : sections[4], o.emb.pdf) : null;
	embGrowNodes = o.emb.grow ? embGrow(embNodes) : null;
}
const EMB_INKED_AFTER_TEXT = " closes the inked embed's line";
/** I641-1 cell a: the picture embed in the inked embed's second paragraph (embGrow), or null. */
let embGrowNodes = null;
/**
 * I641-1 cell a (o.emb.grow): a picture embed on its own line in the inked embed's second paragraph, above Embedmid, as
 * the reading view renders three source lines with no blank line between them ("The second line holds", "![[Photo.png]]",
 * "Embedmid near its start"): one p, the breaks as br, the span between them, empty until its img comes in (sideFill).
 * An img is no element the parser closes a p at, so the paragraph parses back whole and the read is the growth alone.
 */
function embGrow(nodes) {
	const para = nodes.blocks[1];
	const word = para.querySelector("#e1");
	const embed = document.createElement("span");
	embed.className = SIDE_KINDS.picture.cls;
	embed.setAttribute("src", SIDE_KINDS.picture.src);
	embed.setAttribute("alt", SIDE_KINDS.picture.src);
	embed.setAttribute("data-probe", "emb-grow");
	para.insertBefore(document.createElement("br"), word);
	para.insertBefore(embed, word);
	para.insertBefore(document.createElement("br"), word);
	return { kind: "picture", span: embed, para };
}
/**
 * The inked embed's crosses placed from this page (z: its zoom, the rects taken back to page px), each on its marked word
 * in the embed's note space: x from its first paragraph's left, y its block's editor top plus the word's centre below its
 * paragraph's top as the page lays it out. The anchors are embStrokes' own.
 */
function embPageStrokes(o, z) {
	const p0 = embNodes.blocks[0].getBoundingClientRect();
	const words = embS.words.map((w, k) => {
		const r = embNodes.view.querySelector("#e" + k).getBoundingClientRect();
		const b = embNodes.blocks[embMarks[k].block].getBoundingClientRect();
		return { ...w, x: r2((r.left + r.width / 2 - p0.left) / z), y: r2(w.top + (r.top + r.height / 2 - b.top) / z) };
	});
	return embStrokes(o, { ...embS, words });
}
/**
 * The side embeds (o.emb.pdf: kind and when its content stands), each as Obsidian 1.15.1 makes its span. pdf:
 * span.internal-embed.pdf-embed (app.js @3018566); its viewer builds its toolbar and page container as divs in it after
 * a 300 ms initDelay (@3018689, @3002532), here empty (no buttons or pages, so the toolbar stands at its own padding and
 * border and the page container, absolute, takes no height). canvas: span.internal-embed.canvas-embed, and inline-embed
 * when shown inline, with its header div.embed-title (an icon span and the file's name) and the board drawn after it
 * (asar byte 2965557 of R2's app.js copy; the board here an svg of fixed size). bases: span.internal-embed.bases-embed,
 * with the view's divs in it (their classes not read past the container; here two divs). picture:
 * span.internal-embed.media-embed.image-embed with its img (a data-URI svg of fixed size). Each child is marked
 * data-probe-kid, for the reads.
 */
const SIDE_KINDS = {
	pdf: { cls: "internal-embed pdf-embed is-loaded", src: "Paper.pdf", kids: () => [sideDiv("pdf-toolbar"), sideDiv("pdf-content-container")] },
	canvas: { cls: "internal-embed canvas-embed inline-embed is-loaded", src: "Board.canvas", kids: () => {
		const title = sideDiv("embed-title");
		title.appendChild(document.createElement("span")).className = "file-embed-icon";
		title.append(" Board");
		const board = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		board.setAttribute("width", "240");
		board.setAttribute("height", "120");
		return [title, board];
	} },
	bases: { cls: "internal-embed bases-embed interactive-child is-loaded", src: "Books.base", kids: () => [sideDiv("bases-header"), sideDiv("bases-view")] },
	// Three embeds of a kind no rule names (a plugin's view, say), each holding a start tag the parser closes a p at that
	// is not a div child: a list first, a div one span down (the div marked too), a rule.
	list: { cls: "internal-embed is-loaded", src: "List.view", kids: () => {
		const ul = document.createElement("ul");
		ul.appendChild(document.createElement("li")).textContent = "Listitem";
		return [ul];
	} },
	deep: { cls: "internal-embed is-loaded", src: "Deep.view", ownMarks: true, kids: () => {
		const wrap = document.createElement("span");
		const d = wrap.appendChild(sideDiv("deep-view"));
		d.setAttribute("data-probe-kid", "");
		d.textContent = "Deepview";
		return [wrap];
	} },
	rule: { cls: "internal-embed is-loaded", src: "Rule.view", kids: () => [document.createElement("hr")] },
	// A Bases embed whose view takes its height from its content (no fixed embed rule): its view 120 px tall.
	tall: { cls: "internal-embed bases-embed interactive-child is-loaded", src: "Shelf.base", kids: () => {
		const view = sideDiv("bases-view");
		view.style.height = "120px";
		return [sideDiv("bases-header"), view];
	} },
	picture: { cls: "internal-embed media-embed image-embed is-loaded", src: "Photo.png", kids: () => {
		const img = document.createElement("img");
		img.setAttribute("src", "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='100'/%3E");
		img.setAttribute("width", "200");
		img.setAttribute("height", "100");
		return [img];
	} },
};
function sideDiv(cls) {
	const d = document.createElement("div");
	d.className = cls;
	return d;
}
/** Put a side embed's children in its span (the viewer built, the board drawn), each marked for the reads (a kind with own marks marks its own). */
function sideFill(n) {
	const kind = SIDE_KINDS[n.kind];
	for (const k of kind.kids()) { if (!kind.ownMarks) k.setAttribute("data-probe-kid", ""); n.span.appendChild(k); }
}
/** Take a side embed's children out of its span again. */
function sideEmpty(n) {
	n.span.replaceChildren();
}
/**
 * A side embed in host block 4's paragraph, as the reading view renders three source lines with no blank line between
 * them ("Pdfabove notes", "![[Paper.pdf]]", "Pdfbelow notes", the embed per kind): one p, the line breaks as br, the
 * embed's span between them. at: "built", its children in the span from the render on; "empty", never (a PDF viewer not
 * built yet); "late", empty at the export's zoom and its build, filled after that build and before the string is taken.
 * Pdfbelow is marked (hx3) and takes the host's cross; Pdfabove is read, not marked. where "inked": the embed and
 * Pdfbelow go on in the inked embed's own line instead (block 2, "![[Embed look]] ![[Paper.pdf]] Pdfbelow notes"), with
 * no Pdfabove and no breaks; that p is passed as section.
 */
function embSide(section, side) {
	const kind = SIDE_KINDS[side.kind];
	const inked = side.where === "inked";
	const para = inked ? section : document.createElement("p");
	if (inked) para.append(" ");
	else {
		para.setAttribute("data-probe-line", "emb-pdf");
		const above = para.appendChild(document.createElement("span"));
		above.id = "pdf-above";
		above.textContent = "Pdfabove";
		para.append(" notes");
		para.appendChild(document.createElement("br"));
	}
	const embed = para.appendChild(document.createElement("span"));
	embed.className = kind.cls;
	embed.setAttribute("src", kind.src);
	embed.setAttribute("alt", kind.src);
	embed.setAttribute("data-probe", "emb-pdf");
	const n = { kind: side.kind, span: embed, para };
	if (side.at === "built") sideFill(n);
	if (side.em) para.setAttribute("data-probe-em", "");
	if (inked) para.append(" ");
	else para.appendChild(document.createElement("br"));
	const w = para.appendChild(document.createElement("span"));
	w.className = "mark-word";
	w.id = "hx3";
	w.textContent = "Pdfbelow";
	para.append(" notes");
	if (!inked) section.replaceChildren(para);
	return n;
}
/**
 * A host cross (magenta, 32 x 14) on each marked word in or after the no-ink embeds, anchored to its word's host block
 * (block 4; HOST_OVER_BLOCK), in the host's note space: x from the first paragraph's left, y the block's top in the
 * probe plus the word's centre below its section's top as the page lays it out. Read on the phone or tablet page once
 * the export's zoom is written (z, that zoom: the rects are zoomed px, taken back to page px), before the zoom's build
 * takes the strokes. The desktop cell takes the same strokes (one saved ink) and reads its own page's places for the log,
 * and each no-ink view's span start inset there for its premise (z 1).
 */
function hostOverStrokes(root, sections, o, space, z = 1) {
	const source = [];
	o.blocks.forEach((b, i) => { if (i > 0) source.push(""); source.push(b); });
	const p0 = root.querySelector("p").getBoundingClientRect();
	const strokes = [], at = {};
	for (const id of HOST_OVER_IDS) {
		const el = root.querySelector("#" + id);
		if (!el) continue;
		const own = sections.findIndex(s => s.contains(el));
		const b = HOST_OVER_BLOCK[id] ?? (own >= 0 ? own : 4), n = 1 + 2 * b;
		const anchor = { line: n, top: space.blockTops[b], key: lineKey(source[n - 1]), width: o.column, fontPx: 16,
			above: aboveOf(newAboveRun(), n, j => lineKey(source[j - 1])) };
		const s0 = sections[b].getBoundingClientRect();
		const w = el.getBoundingClientRect();
		const x = r2((w.left + w.width / 2 - p0.left) / z), y = r2(space.blockTops[b] + (w.top + w.height / 2 - s0.top) / z);
		at[id] = { x, y };
		strokes.push(line("h" + id, x - 16, y, x + 16, y, { anchor }), line("v" + id, x, y - 7, x, y + 7, { anchor }));
	}
	// Each no-ink view's span start inset on this page as read here, for the desktop premise's owed place.
	return { strokes, at, insets: spanInsets() };
}
/**
 * The word of o.emb.inkLine against host block 2 as this page lays it out now (z, the export's zoom: the rects taken back
 * to page px): x from the root's first paragraph's left, dy its centre below block 2's section top. Pass one reads it
 * once the zoom's build has laid the root out at the column width, with no host cross in block 2 (no hold walks that
 * block): the place the editor's column gives the word. A read before that build is the page at the device's width.
 */
function inkLinePlace(root, sections, o, z) {
	const el = document.querySelector(".print #" + (o.emb.inkLine.after === "over" ? "e1" : "hl0"));
	if (!el) return null;
	const p0 = root.querySelector("p").getBoundingClientRect(), s0 = sections[2].getBoundingClientRect(), w = el.getBoundingClientRect();
	return { x: r2((w.left + w.width / 2 - p0.left) / z), dy: r2((w.top + w.height / 2 - s0.top) / z) };
}
/** A host cross (magenta, 32 x 14) at pass one's place, in the host's note space (block 2's probe top plus dy), anchored to block 2's line. */
function inkLineStrokes(o, space, place) {
	const source = [];
	o.blocks.forEach((b, i) => { if (i > 0) source.push(""); source.push(b); });
	const n = 5;
	const anchor = { line: n, top: space.blockTops[2], key: lineKey(source[n - 1]), width: o.column, fontPx: 16,
		above: aboveOf(newAboveRun(), n, j => lineKey(source[j - 1])) };
	const x = place.x, y = r2(space.blockTops[2] + place.dy);
	return { at: { x, y }, strokes: [line("hl0h", x - 16, y, x + 16, y, { anchor }), line("hl0v", x, y - 7, x, y + 7, { anchor })] };
}
/**
 * Each no-ink view's span start inset (border and padding, css px) as this page holds it now; null where
 * the view has no span. The phone and tablet cells read it before the export's zoom is written, for each print's own
 * move of the embed spans' start insets.
 */
function spanInsets() {
	const inset = n => { const sp = n ? n.view.closest(".inline-embed") : null; if (!sp) return null; const ss = getComputedStyle(sp); return r2(parseFloat(ss.borderLeftWidth) + parseFloat(ss.paddingLeft)); };
	return { plain: inset(embPlainNodes), plainInner: inset(embPlainInnerNodes) };
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
	if (embQuietNodes) embAttachPlain(embQuietNodes, EMB_QUIET_PATH, EMB_QUIET_BLOCKS.length, provide);
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
		if (p === EMB_QUIET_PATH) return zoomWritten ? [] : [line("quiet", 40, 12, 72, 12)];
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
	let hostOver = null;
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
	// The no-ink views' span start insets on this page before the zoom is written, for each print's own move.
	const insetsBeforeZoom = o.emb?.hostOver?.length ? spanInsets() : null;
	// The side embed's line as the render leaves it, before the export's zoom and its build: the base string of a line
	// no build touches.
	const sideLineBefore = embSideNodes ? embSideNodes.para.outerHTML : null;
	// The side line's margins as this page computes them before the zoom, for a held line's inline margins (PDF-7).
	const sideMarginsBefore = embSideNodes ? (cs => [cs.marginTop, cs.marginBottom])(getComputedStyle(embSideNodes.para)) : null;
	// The inked embed's line's margins as this page computes them before the zoom, for a held line's inline margins.
	const inkMarginsBefore = o.emb && (o.emb.inkedHost || o.emb.inkLine) ? (cs => [cs.marginTop, cs.marginBottom])(getComputedStyle(embNodes.embed.parentElement)) : null;
	// Pdfbelow's top in its block where its cross is placed, css px (the read the page is held to after the build).
	const placeRead = (z) => { const g = window.pdfGeom ? window.pdfGeom() : null; return g && g.belowTop !== null ? r2(g.belowTop / z) : null; };
	// A late embed's content stands on the screen the ink was drawn on, so its crosses are placed from this page with the
	// content in; it goes out again before the zoom and comes back after the zoom's build.
	const lateSide = !!embSideNodes && o.emb.pdf.at === "late";
	let pdfPlaceTop = null;
	if (lateSide) {
		sideFill(embSideNodes);
		hostOver = hostOverStrokes(root, sections, o, space, zoomOf(div) * zoomOf(root));
		pdfPlaceTop = placeRead(zoomOf(div) * zoomOf(root));
		sideEmpty(embSideNodes);
	}
	// I641-1 cell a: the picture in the inked embed stands on the screen its ink was drawn on, so the embed's crosses are
	// placed from this page with the img in; it goes out again before the zoom and comes back after the zoom's build.
	const grow = o.emb?.grow ? embGrowNodes : null;
	let growPlace = null, growAtBuild = null;
	if (grow) {
		sideFill(grow);
		embInk = embPageStrokes(o, zoomOf(div) * zoomOf(root));
		growPlace = window.growGeom ? window.growGeom() : null;
		sideEmpty(grow);
	}
	// The zoom, then the app's 200 ms (app.js @2682548). The plugin's whole answer to the zoom (and to a canvas added
	// after it) is built inside its MutationObservers' callbacks, which run before the next frame; the replay waits two
	// frames in place of the 200 ms, so a watch that reacts later than that fails here.
	div.style.zoom = scale.toString();
	zoomWritten = true;
	// The host's crosses over and after the no-ink embeds, placed from this page as the zoom lays it out, read
	// here with no await between, so the zoom's build (an observer callback, a microtask) takes them.
	if (!lateSide && (o.emb?.hostOver?.length || o.emb?.pdf || o.emb?.inkedHost)) {
		hostOver = hostOverStrokes(root, sections, o, space, zoomOf(div) * zoomOf(root));
		if (embSideNodes) pdfPlaceTop = placeRead(zoomOf(div) * zoomOf(root));
	}
	if (hostOver) live = live.concat(hostOver.strokes);
	// The host's cross on the inked embed's line (o.emb.inkLine) at pass one's place, with no await since the zoom was
	// written, so the zoom's build takes it; pass one adds none. The word's place as the zoom lays it out, for the log.
	const inkLineAtZoom = o.emb?.inkLine ? inkLinePlace(root, sections, o, zoomOf(div) * zoomOf(root)) : null;
	const inkLineCross = o.emb?.inkLine?.place ? inkLineStrokes(o, space, o.emb.inkLine.place) : null;
	if (inkLineCross) live = live.concat(inkLineCross.strokes);
	const observersArmed = window.__bodyObservers?.() ?? null;
	// The side embed once the zoom's build is done (its strips cut, its lines held): read where the strip was cut, then a
	// late embed's children enter its span (the viewer built after the hold), before the string is taken.
	let pdfAtBuild = null;
	if (embSideNodes) {
		await frame();
		pdfAtBuild = window.pdfGeom ? window.pdfGeom() : null;
		if (o.emb.pdf.at === "late") sideFill(embSideNodes);
	}
	// The inked embed once the zoom's build is done, then the picture's img enters its span (late), before the string is taken.
	if (grow) {
		await frame();
		growAtBuild = window.growGeom ? window.growGeom() : null;
		sideFill(grow);
	}
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
	const pdfLive = o.emb?.pdf && window.pdfGeom ? window.pdfGeom() : null;
	const growLive = grow && window.growGeom ? window.growGeom() : null;
	// EMB-L, EMB-D: the word's place, the host cross on it, the embed's rows and its ink layer's markup, as the page holds them.
	const inkLineLive = o.emb?.inkLine ? {
		place: inkLinePlace(root, sections, o, zoomOf(div) * zoomOf(root)),
		geom: window.inkLineGeom ? window.inkLineGeom(o.emb.inkLine.after === "over" ? "e1" : "hl0") : null,
		rows: window.growGeom ? window.growGeom() : null,
		layer: (l => (l ? l.outerHTML : null))(embNodes.content.querySelector(":scope > svg.handwriting-embed-ink")),
	} : null;
	const embPlainCanvas = embPlainInnerNodes && o.emb?.plain ? embPlainInnerNodes.content.querySelectorAll(":scope > canvas.handwriting-embed-ink").length : null;
	const embQuietCanvas = embQuietNodes && o.emb?.quiet ? embQuietNodes.content.querySelectorAll(":scope > canvas.handwriting-embed-ink").length : null;
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
	// The lines the hold may write as divs, on the page and in the string: the side embed's (and its string before the
	// build), the inked embed's (and whether its block holds a host strip).
	const lineAt = (doc, key) => { const el = doc.querySelector('.print [data-probe-line="' + key + '"]'); return el ? { tag: el.tagName, html: el.outerHTML } : null; };
	const inkBlock = o.emb && (o.emb.inkedHost || o.emb.inkLine) ? sections[2] : null;
	const inkLive = inkBlock ? div.ownerDocument.querySelector('.print [data-probe-line="emb-ink"]') : null;
	const sideKey = embSideNodes ? embSideNodes.para.getAttribute("data-probe-line") : null;
	const sideLive = sideKey ? div.ownerDocument.querySelector('.print [data-probe-line="' + sideKey + '"]') : null;
	const lines = {
		side: embSideNodes ? { before: sideLineBefore, live: lineAt(div.ownerDocument, sideKey), clone: lineAt(s, sideKey),
			margins: { before: sideMarginsBefore, inline: sideLive ? [sideLive.style.marginTop, sideLive.style.marginBottom] : null } } : null,
		ink: inkBlock ? { live: lineAt(div.ownerDocument, "emb-ink"), clone: lineAt(s, "emb-ink"),
			strip: !!inkBlock.querySelector(":scope > svg.handwriting-embed-ink-strip"), drew: !!embNodes.content.querySelector(":scope > svg.handwriting-embed-ink"),
			margins: { before: inkMarginsBefore, inline: inkLive ? [inkLive.style.marginTop, inkLive.style.marginBottom] : null },
			// The no-ink embed that holds the inked one (nested): its line's tag on the page and in the string.
			outer: embOuterNodes ? [lineAt(div.ownerDocument, "emb-outer"), lineAt(s, "emb-outer")].map(l => (l ? l.tag : null)) : null } : null,
	};
	const held = {
		embLive, embPlainCanvas, embWrap: o.emb ? embS.wrap : null,
		embQuietCanvas, hostOver: hostOver ? hostOver.at : null, hostOverStrokes: hostOver ? hostOver.strokes : null, insetsBeforeZoom, pdfLive, pdfAtBuild, pdfPlaceTop, lines,
		growPlace, growAtBuild, growLive,
		inkLine: o.emb?.inkLine ? { atZoom: inkLineAtZoom, at: inkLineCross ? inkLineCross.at : null, strokes: inkLineCross ? inkLineCross.strokes.length : 0, ...inkLineLive } : null,
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

/**
 * The HELD cells: a paragraph the phone or tablet export held as a div, and a build after the hold. Its own
 * page shape, apart from mobileExport: the export root's blocks come from the test (o.rows), each as the reading view
 * renders it, and the root attaches as an export does, with no section info and the note's cached sections. Blocks:
 * "text" one line; "p" a paragraph of lines with the source's single line feeds as br (an embed's own line its span);
 * bare: the p a direct child of the root, no section wrapper (R3B-2); "quote" the same lines in a blockquote; "list" a
 * loose list, its items' paragraphs; "look" d's div that no hold wrote, with a p's attributes and its margins inline;
 * "pic" a picture embed alone in its paragraph. A line written "*Word ..." has its first word marked and takes a host
 * cross anchored to its own source line, as the editor anchors free ink; an embed's line with ink: true takes a cross
 * 100 px into the span, or 50 px into a picture embed's img (200 x 100). Content can come late: an embed's children (late: n), a Bases view's rows that take
 * 120 px (grow: n), a picture's img (late: n), each out at the zoom's build and in at stage n after it, in from the start
 * where the crosses are placed (the screen the ink was drawn on). Data attributes on the marked words are the reads'
 * instrument, as the green words are.
 */
const ROWS_PATH = "Rows note.md";
/** Each cross its own colour, so a read finds its paths in any strip. */
const ROWS_INK = ["#ff00f0", "#ff00f2", "#ff00f4", "#ff00f6", "#ff00f8", "#ff00fa", "#ff00fc", "#ff00fe"];
/** Late content: [stage, fill, empty]. */
let rowsLate = [];
function rowsSpan(e) {
	const span = document.createElement("span");
	const bases = e.embed === "bases", pic = e.embed === "picture";
	span.className = bases ? "internal-embed bases-embed interactive-child is-loaded" : pic ? SIDE_KINDS.picture.cls : "internal-embed pdf-embed is-loaded";
	const src = bases ? "Books.base" : pic ? SIDE_KINDS.picture.src : "Paper.pdf";
	span.setAttribute("src", src);
	span.setAttribute("alt", src);
	span.setAttribute("data-probe", "rows-embed");
	const kids = () => (bases ? [sideDiv("bases-header"), sideDiv("bases-view")] : pic ? SIDE_KINDS.picture.kids() : [sideDiv("pdf-toolbar"), sideDiv("pdf-content-container")]);
	if (e.late) rowsLate.push([e.late, () => span.append(...kids()), () => span.replaceChildren()]);
	else span.append(...kids());
	if (e.grow) {
		const rows = sideDiv("bases-rows");
		rows.style.height = "120px";
		rowsLate.push([e.grow, () => span.querySelector(".bases-view").appendChild(rows), () => rows.remove()]);
	}
	return span;
}
/** A line's source text: a text line less its mark, an embed's line its wikilink, a plain picture's line its link. */
const rowsSrc = l => (typeof l === "string" ? l.replace(/^\\*/, "") : l.img ? "![](https://example.com/p.png)"
	: l.embed === "bases" ? "![[Books.base]]" : l.embed === "picture" ? "![[Photo.png]]" : "![[Paper.pdf]]");
/**
 * Append one line to its paragraph; a marked line's first word, an inked embed, and an inked plain picture (an img with
 * no embed span, 200 x 100, its cross 50 px into it) noted for its cross.
 */
function rowsLine(into, l, n, marks) {
	if (typeof l !== "string" && l.img) {
		const img = into.appendChild(document.createElement("img"));
		if (l.wide) {
			// As the renderer writes a picture with no size given: no width or height, so the root's max-width sizes it.
			img.setAttribute("src", "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1000' height='500'/%3E");
			img.setAttribute("data-rows-wide", "");
			if (l.ink) marks.push({ el: img, line: n, dy: 50 });
			return;
		}
		img.setAttribute("src", "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='100'/%3E");
		img.setAttribute("width", "200");
		img.setAttribute("height", "100");
		if (l.ink) marks.push({ el: img, line: n, dy: 50 });
		return;
	}
	if (typeof l !== "string") {
		const span = into.appendChild(rowsSpan(l));
		// A picture embed's span is inline: its rect is its line's text box, not the picture, so its cross is read
		// against its img (50 px into the picture); a PDF or Bases span is a block, read itself.
		const pic = l.embed === "picture" ? span.querySelector("img") : null;
		if (l.ink && l.embed === "picture" && !pic) throw new Error("rowsLine: an inked picture embed needs its img in at mount");
		if (l.ink) marks.push({ el: pic ?? span, line: n, dy: pic ? 50 : 100 });
		return;
	}
	if (!l.startsWith("*")) { into.append(l); return; }
	const words = l.slice(1).split(" ");
	const w = into.appendChild(document.createElement("span"));
	w.className = "mark-word";
	w.textContent = words[0];
	into.append(" " + words.slice(1).join(" "));
	marks.push({ el: w, line: n, dy: null });
}
/** A paragraph of lines (a p, or d's div), the breaks as the renderer writes them. */
function rowsPara(tag, lines, first, marks) {
	const p = document.createElement(tag);
	p.setAttribute("dir", "auto");
	lines.forEach((l, i) => {
		if (i > 0) { p.appendChild(document.createElement("br")); p.append("\\n"); }
		rowsLine(p, l, first + i, marks);
	});
	return p;
}
/** Build the root's blocks; the note's source lines, its cached sections, and the marked words with their 1-based lines. */
function rowsMount(root, blocks) {
	const source = [], sections = [], marks = [];
	let lookMargins = null;
	blocks.forEach((b, bi) => {
		if (bi > 0) source.push("");
		const start = source.length;
		const n0 = start + 1;
		const wrap = b.bare ? root : root.appendChild(document.createElement("div"));
		if (b.t === "text" || b.t === "p") {
			wrap.appendChild(rowsPara("p", b.lines, n0, marks));
			b.lines.forEach(l => source.push(rowsSrc(l)));
		} else if (b.t === "quote") {
			const q = wrap.appendChild(document.createElement("blockquote"));
			q.appendChild(rowsPara("p", b.lines, n0, marks));
			b.lines.forEach(l => source.push("> " + rowsSrc(l)));
		} else if (b.t === "list") {
			const ul = wrap.appendChild(document.createElement("ul"));
			b.items.forEach((item, j) => {
				if (j > 0) source.push("");
				const li = ul.appendChild(document.createElement("li"));
				li.appendChild(rowsPara("p", item, source.length + 1, marks));
				item.forEach((l, k) => source.push((k === 0 ? "- " : "  ") + rowsSrc(l)));
			});
		} else if (b.t === "look") {
			const d = wrap.appendChild(rowsPara("div", b.lines, n0, marks));
			d.setAttribute("data-probe", "rows-look");
			lookMargins = d;
			b.lines.forEach((l, k) => source.push((k === 0 ? '<div dir="auto">' : "") + rowsSrc(l) + (k === b.lines.length - 1 ? "</div>" : "")));
		} else if (b.t === "pic") {
			const p = wrap.appendChild(document.createElement("p"));
			p.setAttribute("dir", "auto");
			const span = p.appendChild(document.createElement("span"));
			span.className = SIDE_KINDS.picture.cls;
			span.setAttribute("src", SIDE_KINDS.picture.src);
			span.setAttribute("alt", SIDE_KINDS.picture.src);
			const n = { kind: "picture", span };
			rowsLate.push([b.late, () => sideFill(n), () => sideEmpty(n)]);
			source.push("![[Photo.png]]");
		}
		const type = b.t === "quote" ? "blockquote" : b.t === "list" ? "list" : b.t === "look" ? "html" : "paragraph";
		sections.push({ type, lineStart: start, lineEnd: source.length - 1 });
	});
	// d's div carries a p's margins inline, as a held line does, at the px a p of this root computes.
	if (lookMargins) {
		const cs = getComputedStyle(root.querySelector("p"));
		lookMargins.style.marginTop = cs.marginTop;
		lookMargins.style.marginBottom = cs.marginBottom;
	}
	return { source, sections, text: source.join("\\n"), marks };
}
/** The top of the first character in el that is not white space, client px; null when there is none. */
function firstCharTop(el) {
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	for (let t = walker.nextNode(); t; t = walker.nextNode()) {
		const i = t.data.search(/\\S/);
		if (i < 0) continue;
		const r = document.createRange();
		r.setStart(t, i);
		r.setEnd(t, i + 1);
		const rect = r.getClientRects().item(0);
		return rect ? rect.top : null;
	}
	return null;
}
/** Whether el's first line is text: its first character that is not white space comes before any picture or embed in it. */
function opensOnText(el) {
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (n.nodeType === Node.TEXT_NODE) { if (/\\S/.test(n.data)) return true; continue; }
		if (n.tagName === "IMG" || n.matches(".internal-embed, .markdown-embed")) return false;
	}
	return false;
}
/** How far below its block's content top el's first character stands, page px: its line's half leading over it. */
function leadOf(el, z) {
	const s = getComputedStyle(el), r = el.getBoundingClientRect();
	return (firstCharTop(el) - (r.top + el.clientTop * z + (parseFloat(s.paddingTop) || 0) * z)) / z;
}
/**
 * A cross on each marked word, in the host's note space as the editor takes it: y 0 the first line's top and each source
 * line one line height below the last, so line n's top is (n - 1) x the line height (the anchor's top); the word sits in
 * its line as it sits in its paragraph's line box: the half leading over its first character, then half the word's
 * height. The half leading is read off the word's own block when that block's first line is text, else off the root's
 * first such p (a block opening on a picture has its first character lines down). x from the root's first p's left. An
 * inked embed's cross sits 100 px into its span, its anchor its own line. Read with the page at z (rects taken back to
 * page px).
 */
function rowsStrokes(root, built, o, z) {
	const p0 = root.querySelector("p").getBoundingClientRect();
	const lineH = parseFloat(getComputedStyle(root.querySelector("p")).lineHeight) || 24;
	const textP = [...root.querySelectorAll("p")].find(opensOnText) || null;
	const out = [];
	built.marks.forEach((m, k) => {
		const color = ROWS_INK[k];
		const n = m.line, top = (n - 1) * lineH;
		const anchor = { line: n, top, key: lineKey(built.source[n - 1]), width: o.column, fontPx: 16,
			above: aboveOf(newAboveRun(), n, j => lineKey(built.source[j - 1])) };
		const w = m.el.getBoundingClientRect();
		let x, y;
		if (m.dy !== null) {
			x = r2((w.left - p0.left) / z + 100);
			y = r2(top + m.dy);
		} else {
			const host = m.el.parentElement;
			const lead = leadOf(opensOnText(host) || !textP ? host : textP, z);
			x = r2((w.left + w.width / 2 - p0.left) / z);
			y = r2(top + lead + w.height / 2 / z);
		}
		m.el.setAttribute("data-rows-ink", color);
		m.el.setAttribute("data-rows-line", String(n));
		if (m.dy !== null) m.el.setAttribute("data-rows-dy", String(m.dy));
		out.push(line("rh" + k, x - 16, y, x + 16, y, { anchor, color }), line("rv" + k, x, y - 7, x, y + 7, { anchor, color }));
	});
	return out;
}
/** Run fn with the export div's zoom off, as a build reads, then put it back (no build: the zoom put back is the zoom built at). */
function rowsUnzoomed(div, fn) {
	const zoom = div ? div.style.zoom : "";
	if (zoom) div.style.removeProperty("zoom");
	try { return fn(); } finally { if (zoom) div.style.zoom = zoom; }
}
/** What the measure reads of each block now: its lines, box, rows (kind and count) and each line's top, px in the layer's frame. */
function rowsMeasure(root) {
	const spans = measureSpans(root);
	if (!spans) return null;
	return spans.blocks.map(b => {
		const box = b.box(), rows = b.rows ? b.rows() : null, tops = [];
		for (let i = b.lineStart; i <= b.lineEnd; i++) { const t = lineTopIn(spans, i); tops.push(t === null ? null : r2(t)); }
		return { lineStart: b.lineStart, lineEnd: b.lineEnd, box: box ? { top: r2(box.top), height: r2(box.height) } : null,
			rows: rows ? { kind: rows.kind, count: rows.count } : null, tops };
	});
}
/** The page as one string, as the export takes it (mobileExport's clone). */
function rowsString(div) {
	const s = document.documentElement.cloneNode(false);
	const head = document.head.cloneNode(true);
	head.querySelectorAll("script").forEach(h => h.remove());
	const body = document.body.cloneNode(false);
	body.classList.remove("theme-dark");
	body.classList.add("theme-light");
	body.appendChild(div.cloneNode(true));
	s.append(head, body);
	s.querySelectorAll("style").forEach(h => { h.textContent = h.textContent.replace(/<\\/(style)/gi, "<\\\\/$1"); });
	return "<!doctype html>" + s.outerHTML;
}
const rowsFill = (stage) => { for (const [at, fill] of rowsLate) if (at === stage) fill(); };
/**
 * The export (printToPdfMobile's steps, as mobileExport replays them) of o.rows. replace: once the zoom's build is done,
 * the root's layer watch reads its placement again (queueReplace, the anchor watch's call), before the string is taken.
 */
window.rowsExport = async (o) => {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "is-mobile " + (o.column < 500 ? "is-phone " : "is-tablet ") + "theme-dark";
	Platform.isMobileApp = true;
	Platform.isMobile = true;
	initEmbedInkColumnWidth(() => o.column);
	initEmbedInkPrintPaper(() => o.settings);
	initEmbedInkPrintCanvas(null);
	rowsLate = [];
	let ink = [];
	initEmbedInkRefresh(p => (p === ROWS_PATH ? ink : []));
	const swaps0 = embedInkPrintSwaps();
	const scale = Math.min(2, Math.max(0.1, o.settings.downscalePercent / 100));
	const div = document.body.appendChild(document.createElement("div"));
	div.className = "print theme-light";
	div.setAttribute("aria-hidden", "true");
	const root = div.appendChild(document.createElement("div"));
	root.className = "markdown-preview-view markdown-rendered";
	const built = rowsMount(root, o.rows);
	// The crosses are placed on the screen the ink was drawn on: every late content in.
	for (const [, fill] of rowsLate) fill();
	await frame();
	ink = rowsStrokes(root, built, o, zoomOf(div) * zoomOf(root));
	const place = window.rowsGeom();
	for (const [, , empty] of rowsLate) empty();
	attachEmbedInkOnceReady(root, root, ROWS_PATH, () => ink, undefined, false, {
		section: () => null, cached: () => ({ sections: built.sections, text: built.text }) });
	await Promise.resolve();
	div.style.zoom = scale.toString();
	// One microtask: the zoom's build (the style observer's callback, queued first) has run and held its lines; the
	// layer watch's call that the build's own nodes queue (EmbedInkWatch's sync, then queueReplace) has not. The page
	// and its string as they stand here are the build with no build after the hold.
	await Promise.resolve();
	const atZoom = window.rowsGeom();
	const htmlAtZoom = rowsString(div);
	const swapsAtZoom = embedInkPrintSwaps() - swaps0;
	const stripsAtZoom = [...root.querySelectorAll("svg.handwriting-embed-ink-strip")];
	await frame();
	const atBuild = window.rowsGeom();
	const measureAtBuild = rowsUnzoomed(div, () => rowsMeasure(root));
	for (const stage of [1, 2]) {
		if (!rowsLate.some(([at]) => at === stage)) continue;
		rowsFill(stage);
		await frame(); await frame();
	}
	if (o.replace) { queueReplace(root); await frame(); await frame(); }
	await frame(); await frame();
	const live = window.rowsGeom();
	const measure = rowsUnzoomed(div, () => rowsMeasure(root));
	// Whether any strip the zoom's build cut was taken away by a later build (the late look's, or the layer watch's replace).
	const rebuilt = stripsAtZoom.length > 0 && stripsAtZoom.some(s => !s.isConnected);
	const zf = zoomOf(div) * zoomOf(root);
	const html = rowsString(div);
	const swaps = embedInkPrintSwaps() - swaps0;
	div.remove();
	teardownEmbedInk();
	return { html, zf, swaps, place, atZoom, htmlAtZoom, swapsAtZoom, stripsAtZoom: stripsAtZoom.length, atBuild, live, measureAtBuild, measure, rebuilt, strokes: ink.length };
};
/**
 * The same blocks on screen (a reading view, no export) or in a desktop export at its beforeprint (the screen call that
 * places the print's ink): what the measure reads, and where each stroke is placed (its correction from placeStrokes).
 */
window.rowsLook = async (o) => {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "theme-light";
	Platform.isMobileApp = false;
	Platform.isMobile = false;
	initEmbedInkColumnWidth(() => o.column);
	initEmbedInkPrintPaper(() => o.settings);
	initEmbedInkPrintCanvas(null);
	rowsLate = [];
	let ink = [];
	initEmbedInkRefresh(p => (p === ROWS_PATH ? ink : []));
	const desk = o.where === "desktop";
	const host = desk ? document.body.appendChild(document.createElement("div")) : null;
	if (host) host.className = "print";
	const root = (host ?? document.body).appendChild(document.createElement("div"));
	root.className = "markdown-preview-view markdown-rendered";
	if (!desk) root.style.width = o.column + "px";
	const built = rowsMount(root, o.rows);
	await frame();
	ink = rowsStrokes(root, built, o, 1);
	attachEmbedInkOnceReady(root, root, ROWS_PATH, () => ink, undefined, false, {
		section: () => null, cached: () => ({ sections: built.sections, text: built.text }) });
	await frame(); await frame();
	if (desk) { window.dispatchEvent(new Event("beforeprint")); await frame(); await frame(); }
	const measure = rowsMeasure(root);
	const shown = placeStrokes(root, ink, undefined, 1, ROWS_PATH).strokes;
	const placed = ink.map((s, k) => ({ id: s.id, line: s.lineAnchor.line, top: s.lineAnchor.top, dy: r2(shown[k].bbox.y - s.bbox.y) }));
	const layer = desk ? !!root.querySelector(":scope > svg.handwriting-embed-ink") : !!root.querySelector(":scope > canvas.handwriting-embed-ink");
	if (desk) { window.dispatchEvent(new Event("afterprint")); await frame(); }
	teardownEmbedInk();
	document.body.replaceChildren();
	return { measure, placed, layer };
};
/**
 * The desktop export of o.rows: body theme-light, not the mobile app, the crosses placed on the screen the ink was drawn
 * on (every late content in), the plugin attached, beforeprint. The test then turns the media to print, reads the page as
 * it prints (rowsGeom), and calls rowsDeskEnd.
 */
window.rowsDesk = async (o) => {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "theme-light";
	Platform.isMobileApp = false;
	Platform.isMobile = false;
	initEmbedInkColumnWidth(() => o.column);
	initEmbedInkPrintPaper(() => o.settings);
	initEmbedInkPrintCanvas(null);
	rowsLate = [];
	let ink = [];
	initEmbedInkRefresh(p => (p === ROWS_PATH ? ink : []));
	const swaps0 = embedInkPrintSwaps();
	const div = document.body.appendChild(document.createElement("div"));
	div.className = "print";
	const root = div.appendChild(document.createElement("div"));
	root.className = "markdown-preview-view markdown-rendered";
	const built = rowsMount(root, o.rows);
	for (const [, fill] of rowsLate) fill();
	// A picture with no size given takes its size when it decodes.
	await Promise.all([...root.querySelectorAll("img")].map(i => i.decode().catch(() => null)));
	await frame();
	ink = rowsStrokes(root, built, o, 1);
	const wideOnScreen = window.rowsWide();
	attachEmbedInkOnceReady(root, root, ROWS_PATH, () => ink, undefined, false, {
		section: () => null, cached: () => ({ sections: built.sections, text: built.text }) });
	await frame(); await frame();
	window.dispatchEvent(new Event("beforeprint"));
	await frame(); await frame();
	window.__rowsDesk = { swaps0 };
	return { strokes: ink.length, svg: div.querySelectorAll("svg.handwriting-embed-ink").length, wideOnScreen };
};
/** Each picture with no size given: its height as laid out now, css px (client px over the export's zoom). */
window.rowsWide = () => {
	const div = document.querySelector("body > .print"), root = div && div.querySelector(".markdown-preview-view");
	if (!root) return [];
	const zf = zoomOf(div) * zoomOf(root);
	return [...root.querySelectorAll("img[data-rows-wide]")].map(i => r2(i.getBoundingClientRect().height / zf));
};
window.rowsDeskEnd = async () => {
	window.dispatchEvent(new Event("afterprint"));
	await frame();
	const swaps = embedInkPrintSwaps() - window.__rowsDesk.swaps0;
	teardownEmbedInk();
	document.body.replaceChildren();
	return { swaps };
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
	// The phone or tablet cell's host crosses over and after the no-ink embeds (one saved ink); this page's own
	// places for them, for the log.
	const overHere = o.emb?.hostOver?.length ? hostOverStrokes(root, sections, o, space) : null;
	const hostOverAt = overHere ? overHere.at : null, hostOverInsets = overHere ? overHere.insets : null;
	const strokes = (o.rawStrokes ?? buildStrokes(o, space)).concat(o.hostOverStrokes ?? []);
	const provide = (p) => (p === EMBED_PATH ? embedLive : p === EMB_PATH ? embInk : p === EMB_OUTER_PATH || p === EMB_PLAIN_PATH || p === EMB_PLAIN_INNER_PATH || p === EMB_QUIET_PATH ? [] : p === "Open note.md" ? buildStrokes({ ...o, highlighter: false, span: false, farLeft: false }, space) : strokes);
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
		screenPara, screenVar, before, atBeforeprint: inlineFonts(nodes), hostOverAt, hostOverInsets };
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
	/** Desktop: the phone or tablet cell's host crosses over and after the no-ink embeds (Held.hostOverStrokes). */
	hostOverStrokes?: unknown[];
}
/** Host ink on Plainword ("plain"), Hostpast ("after"), Innerword ("inner"); quiet: a no-ink embed alone on block 5. */
type Over = "plain" | "after" | "inner";
/**
 * pdf: a side embed in host block 4's paragraph (the page's embSide): its kind, and when its children stand in its span.
 * inkedHost: the inked embed's line runs on past its span to Inkpast, which takes a host cross (block 2's strip).
 */
interface Side {
	kind: "pdf" | "canvas" | "bases" | "picture" | "list" | "deep" | "rule" | "tall"; at: "built" | "empty" | "late";
	/** "inked": the embed and Pdfbelow on the inked embed's own line (host block 2), not on block 4. */
	where?: "inked";
	/** The line's margins in em (a p-only rule, data-probe-em); the export's downscale, percent. */
	em?: boolean; percent?: number;
}
/** grow (I641-1 cell a): a picture embed in the inked embed's second paragraph, its img in after the zoom's build (the page's embGrow). */
interface Emb { shape: "obsidian" | "sizer"; anchored: boolean; wrap?: boolean; nested?: boolean; plain?: boolean; hostOver?: Over[]; quiet?: boolean; pdf?: Side; inkedHost?: boolean; grow?: boolean; inkLine?: InkLine }
/**
 * inkLine (EMB-L, EMB-D): a word in the inked embed's block that takes a host cross (the page's inkLineStrokes): "same"
 * Inkpast after the span on its line, "under" Underword on the line under it in its paragraph, "over" Embedmid in the
 * embed. place: where pass one read the word (x from the root's first paragraph, dy below block 2's top, css px); null:
 * no host cross in block 2 (pass one).
 */
type InkAfter = "same" | "under" | "over";
interface InkLine { after: InkAfter; place: { x: number; dy: number } | null }
/** A line the hold may write as a div: its tag and its string, on the page or in the string taken. */
interface LineAt { tag: string; html: string }
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
	embQuietCanvas: number | null; hostOver: Record<string, { x: number; y: number }> | null; hostOverStrokes: unknown[] | null;
	/** Each no-ink view's span start inset on the phone or tablet page before the export's zoom, css px. */
	insetsBeforeZoom?: { plain: number | null; plainInner: number | null } | null;
	/** The side embed cells: Pdfbelow and Pdfabove against their block's strip as the page holds them when the string is taken. */
	pdfLive?: PdfGeom | null;
	/** The same once the zoom's build is done, before a late embed's children enter its span. */
	pdfAtBuild?: PdfGeom | null;
	/** Pdfbelow's top in its block, css px, read where the host's crosses are placed. */
	pdfPlaceTop?: number | null;
	/**
	 * The side embed's line (its string before the build too) and the inked embed's line (EMB-I), on the page and in the
	 * string taken; the side line's margins as computed before the zoom and as inline on the line when the string is taken.
	 */
	lines?: {
		side: { before: string | null; live: LineAt | null; clone: LineAt | null; margins: { before: string[] | null; inline: string[] | null } } | null;
		ink: { live: LineAt | null; clone: LineAt | null; strip: boolean; drew: boolean; margins: { before: string[] | null; inline: string[] | null }; outer: Array<string | null> | null } | null;
	};
	/**
	 * EMB-L, EMB-D: the word's place where the zoom is written and when the string is taken, the host cross drawn (its
	 * place, its stroke count), the reads when the string is taken (INK_LINE_GEOM, GROW_GEOM), the embed's ink layer's markup.
	 */
	inkLine?: {
		atZoom: { x: number; dy: number } | null; place: { x: number; dy: number } | null; at: { x: number; y: number } | null; strokes: number;
		geom: InkLineGeom | null; rows: GrowGeom | null; layer: string | null;
	} | null;
	/** I641-1 cell a (GROW_GEOM): where the embed's crosses are placed (the img in, before the zoom), once the zoom's build is done (the img out), when the string is taken (the img in). */
	growPlace?: GrowGeom | null; growAtBuild?: GrowGeom | null; growLive?: GrowGeom | null;
}
/** Inline --font-text per node ("" none, null no such node). */
interface Inline { div: string | null; root: string | null; inner: string | null; pane?: string | null }
interface DeskMounted { svg: number; strips: number; screenPara: string; screenVar: string; before: Inline; atBeforeprint: Inline; hostOverAt?: Record<string, { x: number; y: number }> | null;
	/** Each no-ink view's span start inset on the desktop page before the print, css px. */
	hostOverInsets?: { plain: number | null; plainInner: number | null } | null }
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
async function pageFor(kind: "tablet" | "phone" | "disarm" | "slices", font: keyof typeof NF_FONTS = "default-16"): Promise<Page> {
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
	await p.addScriptTag({ content: `window.pdfGeom = () => ${PDF_GEOM};` });
	await p.addScriptTag({ content: `window.growGeom = () => ${GROW_GEOM};` });
	await p.addScriptTag({ content: `window.inkLineGeom = ${INK_LINE_GEOM};` });
	await p.addScriptTag({ content: `window.rowsGeom = () => ${ROWS_GEOM};` });
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
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "exportMobilePdfPage.ts" },
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
	console.log("EXPORT-MOBILE-PDF", tag, name, JSON.stringify({ ...(held ?? {}), html: held?.html?.length, ...extra }));

const ONE_PAGE = [
	"Handwriting sits on the first line of this paper note, then a second word follows and the line runs on for a while.",
	"Second paragraph, so the page has more than one block.",
];
const ONE_MARKS: Mark[] = [{ block: 0, word: 0 }, { block: 1, word: 0 }];
const ONE_TOKENS = ONE_MARKS.map(m => tokenOf(ONE_PAGE, m));
/**
 * Enough blocks for at least three pages at Letter, each a wrapped paragraph. Block 17 runs about twelve lines and its
 * last word is the late mark (N3): word 40 of a three-line block did not re-wrap between Segoe UI and Arial (moved
 * 0.15 px at 34fe2c6b), so the mark sits where every line break above it counts.
 */
const LONG = Array.from({ length: 36 }, (_, i) => {
	const words = (`Block${String(i).padStart(2, "0")} ` + "words that wrap at the column width and push the next block down the page. ".repeat(i === 17 ? 12 : 4).trim()).split(" ");
	if (i === 17) words[words.length - 1] = "Latemark17";
	return words.join(" ");
});
const LATE: Mark = { block: 17, word: LONG[17]!.split(" ").length - 1 };
const LONG_MARKS: Mark[] = [0, 9, 17, 26, 35].map(block => ({ block, word: 0 })).concat([LATE]);
const LONG_TOKENS = LONG_MARKS.map(m => tokenOf(LONG, m));
/** The late word: the app's print chain re-wraps it (C11's premise); with the note's font it stays on its ink. */
const LATE_TOKEN = tokenOf(LONG, LATE);
const lateLine = (r: Read, name: string) => {
	const w = r.words.find(x => x.token === LATE_TOKEN);
	console.log("EXPORT-MOBILE-PDF LATE", name, JSON.stringify(w ? { page: w.page + 1, dx: w.dx, dy: w.dy, ink: w.ink } : null));
};

const OPTIONS: Array<[string, Partial<Settings>]> = [
	["the saved defaults: Letter, portrait, default margin, 100 %, file name on", {}],
	["A3", { pageSize: "A3" }],
	["A4", { pageSize: "A4" }],
	["A5", { pageSize: "A5" }],
	["Legal", { pageSize: "Legal" }],
	["Tabloid", { pageSize: "Tabloid" }],
	["landscape", { landscape: true }],
	["minimal margin", { margin: "2" }],
	["no margin", { margin: "1" }],
	["downscale 10 %", { downscalePercent: 10 }],
	["downscale 50 %", { downscalePercent: 50 }],
	["file name off", { includeName: false }],
	["A5, landscape, no margin, 10 %", { pageSize: "A5", landscape: true, margin: "1", downscalePercent: 10 }],
	["Tabloid, minimal margin, 50 %", { pageSize: "Tabloid", margin: "2", downscalePercent: 50 }],
];

// ---- C9 (N1): the reader is calibrated on the desktop export shape before any replay cell counts. ----

itA("C9 reader calibration: the desktop export shape at base reads each cross on its word and finds the highlighter", async () => {
	const p = await pageFor("slices");
	const settings: Settings = { ...BASE, margin: "1" };
	const d = await desktopPrint(p, { blocks: ONE_PAGE, marks: ONE_MARKS, settings, highlighter: true, exportShape: true, shiftLine: PLANT === "shift-line" });
	const r = await readPdf(d.pdf, ONE_TOKENS, 1, "C9-desktop-shape");
	log("C9", "desktop shape", null, { mounted: d.mounted, swaps: d.swaps, read: r });
	expect(d.mounted.svg, "premise: the desktop print swap built its vector layer").toBe(1);
	expect(r.words.filter(w => w.token !== null).length, "the reader found every green word with its token").toBe(ONE_TOKENS.length);
	expectOnWords(r, ONE_TOKENS, "C9", { highlighter: true });
	noErrors();
}, T);

// ---- The dialog's options on a one-page note (tablet), with a highlighter stroke. ----

itA.each(OPTIONS)("one-page note, %s: the tablet PDF has the ink, each cross on its word", async (name, over) => {
	const settings = { ...BASE, ...over };
	const held = await replay(await pageFor("tablet"), { blocks: ONE_PAGE, marks: ONE_MARKS, settings, highlighter: true });
	const n = await printNative(held.html, settings);
	const r = await readPdf(n.pdf, ONE_TOKENS, held.zf, `one-page-${name}`);
	log("one-page", name, held, { styled: n.styled, read: r });
	expectStyled(n, name, held.font.screenPara);
	expectOnWords(r, ONE_TOKENS, name, { highlighter: true, move: movesOf(held, ONE_TOKENS) });
	expect(held.canvasShown, "no canvas left showing (it carries no pixels)").toBe(0);
	noErrors();
}, T);

// ---- Long notes (C1 attached, C10 the stroke across a block break, C11's late word), tablet. ----

const LONG_CASES: Array<[string, Partial<Settings>, Partial<Opts>]> = [
	["Letter", {}, {}],
	["A5 landscape, minimal margin", { pageSize: "A5", landscape: true, margin: "2" }, {}],
	["Letter, ink attached to its lines (C1: the plugin's watchers live through the 200 ms)", {}, { attached: true }],
	["Letter, Infinite Canvas note", {}, { canvasNote: true }],
];

itA.each(LONG_CASES)("long note, %s: blocks pushed to later pages take their ink, each cross on its word", async (name, over, extra) => {
	const settings = { ...BASE, ...over };
	const held = await replay(await pageFor("tablet"), { blocks: LONG, marks: LONG_MARKS, settings, span: true, ...extra });
	const n = await printNative(held.html, settings);
	const r = await readPdf(n.pdf, LONG_TOKENS, held.zf, `long-${name}`);
	log("long", name, held, { styled: n.styled, read: r });
	expectStyled(n, name, held.font.screenPara);
	expect(r.pages, "premise: the note crosses at least two page breaks").toBeGreaterThanOrEqual(3);
	if (extra.attached) {
		expect({ strips: held.strips > 0, stripped: held.stripped, boxInline: held.boxInline },
			"C1: the string handed to native holds the strips, the box hidden by class, no inline display").toEqual({ strips: true, stripped: true, boxInline: "" });
	}
	lateLine(r, name);
	expectOnWords(r, LONG_TOKENS, name, { spanZf: held.zf, move: movesOf(held, LONG_TOKENS) });
	expect(held.canvasShown, "no canvas left showing").toBe(0);
	noErrors();
}, T);

// C1's other road: the note's ink is persisted after the zoom's build and before the clone. embedInkChanged asks for the
// print vector with no cut; inside the export div that ask must build the cut again, or the strips go and the box shows.
itA("C1, the note's ink persisted after the build, before the clone: the clone keeps the strips and the box hidden by class", async () => {
	const held = await replay(await pageFor("tablet"), { blocks: LONG, marks: LONG_MARKS, settings: BASE, span: true, persistAfterBuild: true });
	const n = await printNative(held.html, BASE);
	const r = await readPdf(n.pdf, LONG_TOKENS, held.zf, "persist-after-build");
	log("persist after build", "", held, { styled: n.styled, read: r });
	expectStyled(n, "persist after build", held.font.screenPara);
	expect(held.persisted?.stripsBefore ?? 0, "premise: the zoom built the strips before the persist").toBeGreaterThan(0);
	const c = held.clone;
	expect({ strips: c.strips > 0, stripped: c.stripped, boxInline: c.boxInline },
		`the clone after the persist: strips ${c.strips}, box is-stripped ${c.stripped}, box inline display "${c.boxInline}"`).toEqual({ strips: true, stripped: true, boxInline: "" });
	lateLine(r, "persist after build");
	expectOnWords(r, LONG_TOKENS, "persist after build", { spanZf: held.zf, move: movesOf(held, LONG_TOKENS) });
	expect(held.canvasShown, "no canvas left showing").toBe(0);
	noErrors();
}, T);

itA("a root that attaches after the zoom, inside the 200 ms: its ink is in the PDF", async () => {
	const held = await replay(await pageFor("tablet"), { blocks: ONE_PAGE, marks: ONE_MARKS, settings: BASE, late: true });
	const n = await printNative(held.html, BASE);
	const r = await readPdf(n.pdf, ONE_TOKENS, held.zf, "late-attach");
	log("late attach", "", held, { read: r });
	expectStyled(n, "late attach", held.font.screenPara);
	expectOnWords(r, ONE_TOKENS, "late attach", { move: movesOf(held, ONE_TOKENS) });
	noErrors();
}, T);

itA("the zoom written twice: one vector layer, the strips not doubled, no ink twice", async () => {
	const held = await replay(await pageFor("tablet"), { blocks: LONG, marks: LONG_MARKS, settings: BASE, zoomTwice: true });
	const n = await printNative(held.html, BASE);
	const r = await readPdf(n.pdf, LONG_TOKENS, held.zf, "zoom-twice");
	log("zoom twice", "", held, { read: r });
	// Not "at most 7" (the red-first guess): a stroke's padded box can meet the block above, which then gets a clipped strip
	// with no visible ink, so one build makes 9 here. Doubled is a block holding two strips.
	expect({ svg: held.svg, strips: held.strips > 0, doubled: held.doubled }, `one vector layer, strips ${held.strips}, blocks with two strips ${held.doubled}`).toEqual({ svg: 1, strips: true, doubled: 0 });
	lateLine(r, "zoom twice");
	expectOnWords(r, LONG_TOKENS, "zoom twice", { move: movesOf(held, LONG_TOKENS) });
	noErrors();
}, T);

// A stroke that truly crosses a block break stays in both strips: at 100, 50 and 10 % it reads as one whole blue blob, and no
// cross is in the block above's strip for its padding alone.
itA.each([100, 50, 10])("the stroke across the block 0/1 break, one-page note at %i %: one whole blob; each cross on its word", async (pct) => {
	const settings = { ...BASE, downscalePercent: pct };
	const held = await replay(await pageFor("tablet"), { blocks: ONE_PAGE, marks: ONE_MARKS, settings, span: true });
	const n = await printNative(held.html, settings);
	const r = await readPdf(n.pdf, ONE_TOKENS, held.zf, `span-${pct}`);
	log("span", `${pct} %`, held, { styled: n.styled, read: r });
	expectStyled(n, `span ${pct} %`, held.font.screenPara);
	expectOnWords(r, ONE_TOKENS, `span ${pct} %`, { spanZf: held.zf, move: movesOf(held, ONE_TOKENS) });
	noErrors();
}, T);

itA("desktop shape on the mobile steps (not the mobile app): the steps build nothing, as before", async () => {
	const held = await replay(await pageFor("tablet"), { blocks: ONE_PAGE, marks: ONE_MARKS, settings: BASE, mobile: false });
	log("desktop shape on mobile steps", "", held);
	expect({ svg: held.svg, strips: held.strips, canvasShown: held.canvasShown }).toEqual({ svg: 0, strips: 0, canvasShown: 1 });
	noErrors();
}, T);

// ---- C4 to C7, in the render harness. ----

itA("C4: after a re-entry drops the strips, the box shows: no inline display:none left on it", async () => {
	const held = await replay(await pageFor("tablet"), { blocks: LONG, marks: LONG_MARKS, settings: BASE, dropAfterBuild: true });
	log("C4", "", held);
	const d = held.dropped!;
	expect({ stripsBefore: d.stripsBefore > 0, box: d.box, inlineHide: d.boxInline === "none", shown: d.boxShown },
		`strips before the drop ${d.stripsBefore}, box inline display "${d.boxInline}"`).toEqual({ stripsBefore: true, box: true, inlineHide: false, shown: true });
	noErrors();
}, T);

itA("C5a+b: a style write on a child before the zoom builds nothing; zoom \"1\" at 100 % builds once", async () => {
	const held = await replay(await pageFor("tablet"), { blocks: ONE_PAGE, marks: ONE_MARKS, settings: BASE, childStyleBeforeZoom: true });
	log("C5ab", "", held);
	expect(held.zoomAtClone, "premise: 100 % writes zoom \"1\"").toBe("1");
	expect({ svgBeforeZoom: held.svgBeforeZoom, svg: held.svg, swaps: held.swaps }, `strips ${held.strips}`).toEqual({ svgBeforeZoom: 0, svg: 1, swaps: 1 });
	noErrors();
}, T);

itA("C5c: a throw mid-build leaves the div's zoom equal to the scale", async () => {
	const settings = { ...BASE, downscalePercent: 50 };
	const held = await replay(await pageFor("tablet"), { blocks: ONE_PAGE, marks: ONE_MARKS, settings, throwOnBuild: true });
	log("C5c", "", held);
	expect({ throwFired: held.throwFired, zoomAtClone: held.zoomAtClone }, `zoom when the provider threw: "${held.zoomAtThrow}"`).toEqual({ throwFired: true, zoomAtClone: "0.5" });
	noErrors();
}, T);

itA("C5d (own page): the export arms a body observer; after disarmPrintSwaps no body observer is left", async () => {
	const p = await pageFor("disarm");
	const held = await replay(p, { blocks: ONE_PAGE, marks: ONE_MARKS, settings: BASE });
	const after = await p.evaluate(() => (window as unknown as { disarmNow(): number | null }).disarmNow());
	log("C5d", "", held, { afterDisarm: after });
	expect({ armed: (held.observersArmed ?? 0) >= 1, afterDisarm: after }, `body observers during the export ${held.observersArmed}, after teardown ${held.observersAfterTeardown}`).toEqual({ armed: true, afterDisarm: 0 });
	noErrors();
}, T);

itA("C6: canvas note, reach above 0 then 0: padding-left and padding-top stay pinned at the screen px", async () => {
	const held = await replay(await pageFor("tablet"), { blocks: ONE_PAGE, marks: ONE_MARKS, settings: BASE, canvasNote: true, farLeft: true });
	log("C6", "", held);
	expect(held.padsAfter, `screen padding before the zoom ${JSON.stringify(held.pads)}`).toEqual(held.pads);
	noErrors();
}, T);

itA("C7: a mobile build moves the print swaps count; a desktop print moves it as before", async () => {
	const p = await pageFor("tablet");
	const held = await replay(p, { blocks: ONE_PAGE, marks: ONE_MARKS, settings: BASE });
	const d = await desktopPrint(p, { blocks: ONE_PAGE, marks: ONE_MARKS, settings: BASE });
	log("C7", "", held, { desktopSwaps: d.swaps });
	expect({ tablet: held.swaps >= 1, desktop: d.swaps >= 1 }, `swaps: tablet ${held.swaps}, desktop ${d.swaps}`).toEqual({ tablet: true, desktop: true });
	noErrors();
}, T);

// ---- C8: a measurement, no bar. ----

itShape("C8: the string handed to native for Untitled 1 (5795 strokes): its length", async () => {
	const p = await pageFor("tablet");
	const text = readFileSync(`${SHAPE_DIR}/Untitled 1.md`, "utf8").replace(/\r\n/g, "\n").split("\n");
	const start = text[0] === "---" ? text.indexOf("---", 1) + 1 : 0;
	const blocks = text.slice(start).map(l => l.replace(/\t/g, "")).filter(l => l.length > 0);
	const raw = await p.evaluate((s) => (window as unknown as { sidecarStrokes(s: string): unknown[] }).sidecarStrokes(s), readFileSync(`${SHAPE_DIR}/sidecar.json`, "utf8"));
	const held = await replay(p, { blocks, marks: [], settings: BASE, canvasNote: true, rawStrokes: raw });
	log("C8", "Untitled 1", { ...held, space: undefined } as Partial<Held>, { htmlLength: held.html.length, strokes: raw.length });
	expect(raw.length, "premise: the sidecar's strokes were found").toBeGreaterThan(0);
	noErrors();
}, T);

// ---- C11 (N3): the print font re-wraps a late word; the tablet's drift is the desktop's, within 1 px. ----

itA("C11: a word late in a wrapped paragraph, on page 2 or later, lands as the desktop export lands it", async () => {
	const p = await pageFor("tablet");
	const held = await replay(p, { blocks: LONG, marks: LONG_MARKS, settings: BASE });
	const n = await printNative(held.html, BASE);
	const r = await readPdf(n.pdf, LONG_TOKENS, held.zf, "C11-tablet");
	const d = await desktopPrint(p, { blocks: LONG, marks: LONG_MARKS, settings: BASE });
	const rd = await readPdf(d.pdf, LONG_TOKENS, 1, "C11-desktop");
	const late = LONG_MARKS.indexOf(LATE), token = LONG_TOKENS[late]!;
	const move = held.space.printMove[late]!;
	const wt = r.words.find(w => w.token === token), wd = rd.words.find(w => w.token === token);
	log("C11", "", held, { styled: n.styled, printMove: held.space.printMove, tablet: r.words, desktop: rd.words, desktopSwaps: d.swaps });
	expectStyled(n, "C11", held.font.screenPara);
	expect(Math.max(Math.abs(move.dx), Math.abs(move.dy)), `premise: the print font moves the late word in the probe (dx ${move.dx}, dy ${move.dy})`).toBeGreaterThan(2);
	expect(wt && wt.page >= 1, `the late word sits on page 2 or later (page ${wt ? wt.page + 1 : "-"})`).toBe(true);
	const diff = (a?: number | null, b?: number | null) => (a === null || a === undefined || b === null || b === undefined ? null : Math.round((a - b) * 100) / 100);
	const ddx = diff(wt?.dx, wd?.dx), ddy = diff(wt?.dy, wd?.dy);
	expect({ x: near1(ddx), y: near1(ddy) },
		`late word drift, tablet minus desktop: x ${ddx}, y ${ddy} (tablet ${wt?.dx},${wt?.dy}; desktop ${wd?.dx},${wd?.dy})`).toEqual({ x: true, y: true });
	// Every other marked word too: the desktop export is the reference. Raw offsets printed, both paths.
	for (const t of LONG_TOKENS) {
		const a = r.words.find(w => w.token === t), b = rd.words.find(w => w.token === t);
		const tx = diff(a?.dx, b?.dx), ty = diff(a?.dy, b?.dy);
		expect({ x: near1(tx), y: near1(ty) },
			`"${t}" drift, tablet minus desktop: x ${tx}, y ${ty} (tablet page ${a ? a.page + 1 : "-"} ${a?.dx},${a?.dy}; desktop page ${b ? b.page + 1 : "-"} ${b?.dx},${b?.dy})`).toEqual({ x: true, y: true });
	}
	// The bar on both paths: raw, every marked word, the late word too.
	expectOnWords(r, LONG_TOKENS, "C11 tablet", { move: movesOf(held, LONG_TOKENS) });
	expectOnWords(rd, LONG_TOKENS, "C11 desktop");
	noErrors();
}, T);

// ---- C12 (N4, N5) on its own. ----

itA("C12: page 2 is styled by the cloned head and page.pdf gets scale 1", async () => {
	const held = await replay(await pageFor("tablet"), { blocks: ONE_PAGE, marks: ONE_MARKS, settings: { ...BASE, downscalePercent: 50 } });
	const n = await printNative(held.html, BASE);
	log("C12", "", held, { styled: n.styled, scale: n.scale });
	expectStyled(n, "C12", held.font.screenPara);
	noErrors();
}, T);

// ---- C13 (N7): one phone-width case per note type. ----

const PHONE_CASES: Array<[string, string[], Mark[], Partial<Opts>]> = [
	["one-page note", ONE_PAGE, ONE_MARKS, { highlighter: true }],
	["long note", LONG, LONG_MARKS, { span: true }],
	["Infinite Canvas note", LONG, LONG_MARKS, { canvasNote: true }],
];

itA.each(PHONE_CASES)("C13 phone (360 px), %s: each cross on its word", async (name, blocks, marks, extra) => {
	const held = await replay(await pageFor("phone"), { blocks, marks, settings: BASE, column: PHONE.column, ...extra });
	const tokens = marks.map(m => tokenOf(blocks, m));
	const n = await printNative(held.html, BASE);
	const r = await readPdf(n.pdf, tokens, held.zf, `phone-${name}`);
	log("C13", name, held, { styled: n.styled, read: r });
	expectStyled(n, name, held.font.screenPara);
	lateLine(r, `phone ${name}`);
	expectOnWords(r, tokens, `phone ${name}`, { highlighter: extra.highlighter, spanZf: extra.span ? held.zf : undefined, move: movesOf(held, tokens) });
	expect(held.canvasShown, "no canvas left showing").toBe(0);
	noErrors();
}, T);

// ---- Note font: an export with ink prints its text in the font the note shows. ----

/** The nodes that carry an inline --font-text, as "node=value". */
const written = (i: Inline) => Object.entries(i).filter(([, v]) => !!v).map(([k, v]) => `${k}=${v}`);
const valueOf = (w: string | undefined) => (w ?? "").split("=").slice(1).join("=");
/** The font pdf.js gives the first marked word: the reference print's font, in screen or print media. */
const firstFont = (r: Read, tokens: string[]) => fontName(r.words.find(w => w.token === tokens[0])?.font);

// The note's font, mobile: page 2's paragraph font (expectStyled) and the PDF's font per word, against page 2 printed in screen
// media (the font the note shows). One node carries the note's font, the value read on screen before the build.
itA("NF1 mobile: an inked note on the default font prints in the font it shows, not the app's print chain", async () => {
	const held = await replay(await pageFor("tablet"), { blocks: LONG, marks: LONG_MARKS, settings: BASE });
	const n = await printNative(held.html, BASE);
	const ref = await printNative(held.html, BASE, "screen");
	const r = await readPdf(n.pdf, LONG_TOKENS, held.zf, "NF1-mobile");
	const want = firstFont(await readPdf(ref.pdf, LONG_TOKENS, held.zf, "NF1-mobile-screen-ref"), LONG_TOKENS);
	log("NF1", "mobile", { ...held, space: undefined } as Partial<Held>, { styled: n.styled, refStyled: ref.styled, fonts: r.words.map(w => [w.token, w.font]), want });
	expect(want, "premise: the screen-media print names a font").not.toBe("");
	expectStyled(n, "NF1 mobile", held.font.screenPara);
	expectPdfFont(r, LONG_TOKENS, want, "NF1 mobile");
	const w = written(held.font.inline);
	expect({ nodes: w.length, value: valueOf(w[0]) }, `the note's font written once: ${w.join("; ")}`).toEqual({ nodes: 1, value: held.font.screenVar });
	noErrors();
}, T);

// The note's font, desktop: the paragraphs' font in print media (every one in the export) and the PDF's font per word, against
// the same page printed in screen media after the print.
itA("NF1 desktop: an inked note on the default font prints in the font it shows, not the app's print chain", async () => {
	const p = await pageFor("tablet");
	const d = await desktopPrint(p, { blocks: LONG, marks: LONG_MARKS, settings: BASE }, true);
	const r = await readPdf(d.pdf, LONG_TOKENS, 1, "NF1-desktop");
	const want = firstFont(await readPdf(d.screenPdf!, LONG_TOKENS, 1, "NF1-desktop-screen-ref"), LONG_TOKENS);
	log("NF1", "desktop", null, { mounted: d.mounted, during: d.during, after: d.after, fonts: r.words.map(x => [x.token, x.font]), want });
	expect(want, "premise: the screen-media print names a font").not.toBe("");
	expect([...new Set(d.during.paras)], "every paragraph's font in print media is the note's screen font").toEqual([d.mounted.screenPara]);
	expectPdfFont(r, LONG_TOKENS, want, "NF1 desktop");
	const w = written(d.during.inline);
	expect({ nodes: w.length, value: valueOf(w[0]) }, `the note's font written once during the print: ${w.join("; ")}`).toEqual({ nodes: 1, value: d.mounted.screenVar });
	noErrors();
}, T);

// A note with no ink: its export is unchanged. No inline font anywhere, the app's print chain in the PDF. Guard:
// green at base.
itA("NF2a mobile, a note with no ink: no font written, the PDF prints the app's print chain as before", async () => {
	const held = await replay(await pageFor("tablet"), { blocks: ONE_PAGE, marks: ONE_MARKS, settings: BASE, rawStrokes: [] });
	const n = await printNative(held.html, BASE);
	const r = await readPdf(n.pdf, ONE_TOKENS, held.zf, "NF2a-mobile");
	log("NF2a", "mobile", { ...held, space: undefined } as Partial<Held>, { styled: n.styled, fonts: r.words.map(w => [w.token, w.font]) });
	expect({ written: written(held.font.inline), printChain: /Arial/.test(n.styled.font), pdf: /Arial/.test(firstFont(r, ONE_TOKENS)) },
		`no-ink export: page 2 font "${n.styled.font}", PDF font "${firstFont(r, ONE_TOKENS)}"`).toEqual({ written: [], printChain: true, pdf: true });
	noErrors();
}, T);

itA("NF2a desktop, a note with no ink: no font written, the PDF prints the app's print chain as before", async () => {
	const d = await desktopPrint(await pageFor("tablet"), { blocks: ONE_PAGE, marks: ONE_MARKS, settings: BASE, rawStrokes: [] });
	const r = await readPdf(d.pdf, ONE_TOKENS, 1, "NF2a-desktop");
	log("NF2a", "desktop", null, { mounted: d.mounted, during: d.during, after: d.after, fonts: r.words.map(x => [x.token, x.font]) });
	expect({ during: written(d.during.inline), after: written(d.after), printChain: d.during.paras.every(f => /Arial/.test(f)), pdf: /Arial/.test(firstFont(r, ONE_TOKENS)) },
		`no-ink export: print fonts ${JSON.stringify([...new Set(d.during.paras)])}, PDF font "${firstFont(r, ONE_TOKENS)}"`).toEqual({ during: [], after: [], printChain: true, pdf: true });
	noErrors();
}, T);

// A chosen text font: no write at all, so the export is unchanged by construction; the PDF prints the chosen font. 16
// and 26 px, both paths. Guard: green at base.
//
// Unchanged: each marked word's cross minus word centre equals its base read, both paths, both sizes. The base reads
// come from two runs of the cells with no source change, which read the same on every word. The band is the two reads'
// spread widened by the reader's rounding step (0.01 px), and no spread may pass 0.2 px. The raw 1 px bar
// (expectOnWords) stays at 26 px, green at base. At 16 px the cell does not bar the ink on its word: two base reads pass
// 1 px (mobile Latemark17 1.32 down, desktop Block00 1.07 down), a separate question from this cell's.
const NF_CHOSEN: Array<["bahnschrift-16" | "bahnschrift-26"]> = [["bahnschrift-16"], ["bahnschrift-26"]];
type BaseReads = Record<string, Array<[number, number]>>;
const NF2B_BASE: Record<"bahnschrift-16" | "bahnschrift-26", { mobile: BaseReads; desktop: BaseReads }> = {
	"bahnschrift-16": {
		mobile: { Block00: [[0.39, 0.85], [0.39, 0.85]], Block09: [[0.23, 0.87], [0.23, 0.87]], Block17: [[-0.13, 0.87], [-0.13, 0.87]],
			Latemark17: [[0.3, 1.32], [0.3, 1.32]], Block26: [[0.22, 0.87], [0.22, 0.87]], Block35: [[0.28, 0.87], [0.28, 0.87]] },
		desktop: { Block00: [[-0.22, 1.07], [-0.22, 1.07]], Block09: [[0.12, 0.11], [0.12, 0.11]], Block17: [[-0.16, 0.1], [-0.16, 0.1]],
			Latemark17: [[0.03, 0.09], [0.03, 0.09]], Block26: [[0.12, 0.1], [0.12, 0.1]], Block35: [[0.16, 0.1], [0.16, 0.1]] },
	},
	"bahnschrift-26": {
		mobile: { Block00: [[0.16, 0.34], [0.16, 0.34]], Block09: [[0.44, 0.33], [0.44, 0.33]], Block17: [[-0.03, 0.39], [-0.03, 0.39]],
			Latemark17: [[0.16, -0.09], [0.16, -0.09]], Block26: [[0.1, 0.34], [0.1, 0.34]], Block35: [[0.02, 0.28], [0.02, 0.28]] },
		desktop: { Block00: [[0.12, -0.13], [0.12, -0.13]], Block09: [[-0.1, -0.14], [-0.1, -0.14]], Block17: [[-0.01, -0.12], [-0.01, -0.12]],
			Latemark17: [[0.18, -0.38], [0.18, -0.38]], Block26: [[0.1, -0.13], [0.1, -0.13]], Block35: [[-0.04, -0.14], [-0.04, -0.14]] },
	},
};
const READ_STEP = 0.01;
/** Each marked word found, one ink blob in its window, its cross offset within its base reads' band; no ink outside. */
function expectBaseOffsets(r: Read, tokens: string[], base: BaseReads, name: string, bar1px: boolean) {
	for (const t of tokens) {
		const reads = base[t]!;
		const lo = (k: 0 | 1) => Math.min(...reads.map(v => v[k])), hi = (k: 0 | 1) => Math.max(...reads.map(v => v[k]));
		expect(Math.max(hi(0) - lo(0), hi(1) - lo(1)), `${name}: "${t}" the base reads' spread is 0.2 px at most`).toBeLessThanOrEqual(0.2);
		const w = r.words.find(x => x.token === t);
		const within = (v: number | null | undefined, k: 0 | 1) => v !== null && v !== undefined && v >= lo(k) - READ_STEP - 1e-9 && v <= hi(k) + READ_STEP + 1e-9;
		expect({ found: !!w, ink: w?.ink ?? 0, x: within(w?.dx, 0), y: within(w?.dy, 1) },
			`${name}: "${t}" page ${w ? w.page + 1 : "-"}: cross minus word centre x ${w?.dx}, y ${w?.dy}; base reads x ${lo(0)} to ${hi(0)}, y ${lo(1)} to ${hi(1)}, ±${READ_STEP}: a chosen font is unchanged${bar1px ? "" : "; at 16 px this cell does not bar the ink on its word"}; ink blobs in window ${w?.ink}`)
			.toEqual({ found: true, ink: 1, x: true, y: true });
	}
	expect(r.strays, `${name}: no visible ink outside the marked words' windows (ink twice)`).toEqual([]);
}
itA.each(NF_CHOSEN)("NF2b %s, a chosen text font, inked: no font written, Bahnschrift in the PDF, each cross where it was at base, both paths", async (font) => {
	const p = await pageFor("tablet", font);
	const held = await replay(p, { blocks: LONG, marks: LONG_MARKS, settings: BASE });
	const n = await printNative(held.html, BASE);
	const r = await readPdf(n.pdf, LONG_TOKENS, held.zf, `NF2b-mobile-${font}`);
	const d = await desktopPrint(p, { blocks: LONG, marks: LONG_MARKS, settings: BASE });
	const rd = await readPdf(d.pdf, LONG_TOKENS, 1, `NF2b-desktop-${font}`);
	log("NF2b", font, { ...held, space: undefined } as Partial<Held>, { styled: n.styled, during: d.during, after: d.after, mobileFont: firstFont(r, LONG_TOKENS), desktopFont: firstFont(rd, LONG_TOKENS),
		mobileWords: r.words.map(w => [w.page, w.token, w.text, w.font, w.dx, w.dy]), desktopWords: rd.words.map(w => [w.page, w.token, w.text, w.font, w.dx, w.dy]) });
	expect({ mobile: written(held.font.inline), during: written(d.during.inline), after: written(d.after), mobilePdf: /Bahnschrift/.test(firstFont(r, LONG_TOKENS)), desktopPdf: /Bahnschrift/.test(firstFont(rd, LONG_TOKENS)) },
		`${font}: nothing written (mobile ${JSON.stringify(written(held.font.inline))}, during ${JSON.stringify(written(d.during.inline))}, after ${JSON.stringify(written(d.after))}); PDF fonts mobile "${firstFont(r, LONG_TOKENS)}", desktop "${firstFont(rd, LONG_TOKENS)}"`)
		.toEqual({ mobile: [], during: [], after: [], mobilePdf: true, desktopPdf: true });
	const bar1px = font === "bahnschrift-26";
	expectBaseOffsets(r, LONG_TOKENS, NF2B_BASE[font].mobile, `NF2b mobile ${font}`, bar1px);
	expectBaseOffsets(rd, LONG_TOKENS, NF2B_BASE[font].desktop, `NF2b desktop ${font}`, bar1px);
	if (bar1px) {
		expectOnWords(r, LONG_TOKENS, `NF2b mobile ${font}`, { move: movesOf(held, LONG_TOKENS) });
		expectOnWords(rd, LONG_TOKENS, `NF2b desktop ${font}`);
	}
	noErrors();
}, T);

// A snippet sets only the print font (Georgia) on an inked note on the default chain: the PDF prints Georgia, as at
// base; no font written. Guard: green at base; the print-font gate removed turns it red.
itA("NF2c a snippet's print font (Georgia), inked default-chain note: the PDF prints Georgia, no font written, both paths", async () => {
	const p = await pageFor("tablet", "georgia-print");
	const held = await replay(p, { blocks: ONE_PAGE, marks: ONE_MARKS, settings: BASE });
	const n = await printNative(held.html, BASE);
	const r = await readPdf(n.pdf, ONE_TOKENS, held.zf, "NF2c-mobile");
	const d = await desktopPrint(p, { blocks: ONE_PAGE, marks: ONE_MARKS, settings: BASE });
	const rd = await readPdf(d.pdf, ONE_TOKENS, 1, "NF2c-desktop");
	log("NF2c", "georgia-print", { ...held, space: undefined } as Partial<Held>, { styled: n.styled, during: d.during, after: d.after, mobileFont: firstFont(r, ONE_TOKENS), desktopFont: firstFont(rd, ONE_TOKENS) });
	expect({ mobile: written(held.font.inline), during: written(d.during.inline), mobileStyled: /^"?Georgia/.test(n.styled.font), desktopStyled: d.during.paras.every(f => /^"?Georgia/.test(f)),
		mobilePdf: /Georgia/.test(firstFont(r, ONE_TOKENS)), desktopPdf: /Georgia/.test(firstFont(rd, ONE_TOKENS)) },
		`Georgia print font: page 2 "${n.styled.font}", desktop ${JSON.stringify([...new Set(d.during.paras)])}, PDF mobile "${firstFont(r, ONE_TOKENS)}", desktop "${firstFont(rd, ONE_TOKENS)}"`)
		.toEqual({ mobile: [], during: [], mobileStyled: true, desktopStyled: true, mobilePdf: true, desktopPdf: true });
	noErrors();
}, T);

// A reading view on screen, outside the export div, with ink: no inline font on it at beforeprint, in the print
// or after. Guard: green at base; the scope-off plant (write on every root) turns it red.
itA("NF3a desktop: an open note outside the export keeps its font through the print and after", async () => {
	const d = await desktopPrint(await pageFor("tablet"), { blocks: ONE_PAGE, marks: ONE_MARKS, settings: BASE, outside: true });
	log("NF3a", "outside pane", null, { mounted: d.mounted, during: d.during, after: d.after });
	expect({ premise: d.mounted.before.pane, atBeforeprint: d.mounted.atBeforeprint.pane, during: d.during.inline.pane, after: d.after.pane },
		"the pane outside the export div: inline --font-text before, at beforeprint, in print media, after").toEqual({ premise: "", atBeforeprint: "", during: "", after: "" });
	noErrors();
}, T);

// After afterprint no inline font is left, and a root's own inline font from before the print is back as it was
// (the write is skipped where the root has its own). The keep-on-off plant (skip the removal) turns the first red.
const NF_KEEP: Array<[string, string]> = [["no font of its own", ""], ["its own inline font", "\"Courier New\""]];
itA.each(NF_KEEP)("NF3b desktop, the export root with %s: after afterprint the inline fonts are as before the print", async (name, prior) => {
	const d = await desktopPrint(await pageFor("tablet"), { blocks: ONE_PAGE, marks: ONE_MARKS, settings: BASE, priorFont: prior || undefined });
	log("NF3b", name, null, { mounted: d.mounted, during: d.during, after: d.after });
	expect(d.after, `${name}: inline --font-text after afterprint (before the print ${JSON.stringify(d.mounted.before)})`).toEqual(d.mounted.before);
	if (prior) expect([...new Set(d.during.paras)].map(f => /Courier New/.test(f)), `${name}: the root's own font prints`).toEqual([true]);
	noErrors();
}, T);

// A mobile build runs off before each on; a repeat build (zoom twice) and a late attach end with the value
// written once.
const NF_REBUILD: Array<[string, Partial<Opts>]> = [["the zoom written twice", { zoomTwice: true }], ["a root that attaches after the zoom", { late: true }]];
itA.each(NF_REBUILD)("NF3c mobile, %s: the note's font written once, and it prints", async (name, extra) => {
	const held = await replay(await pageFor("tablet"), { blocks: ONE_PAGE, marks: ONE_MARKS, settings: BASE, ...extra });
	const n = await printNative(held.html, BASE);
	log("NF3c", name, { ...held, space: undefined } as Partial<Held>, { styled: n.styled });
	const w = written(held.font.inline);
	expect({ nodes: w.length, value: valueOf(w[0]) }, `${name}: ${w.join("; ")}`).toEqual({ nodes: 1, value: held.font.screenVar });
	expectStyled(n, `NF3c ${name}`, held.font.screenPara);
	noErrors();
}, T);

// ---- No line break flips. ----
// One paragraph per row, "Firstmark" its first word and "Latemark" its last, Tabloid, no margin, 25 %, one page. Default
// font at 16 px r3 to r128 and 26 px r3 to r64, repeat and prose. Desktop: both marks' cross minus word centre within
// 1 css px (page px / 0.25; 0.48 with the font held in an earlier read), one ink blob each, no stray ink.
//
// Mobile, held to base where the font cannot move it: every mobile row reads its first word 0.63 page px low at 16 px
// and 0.37 at 26 px (2.52 and 1.48 css px) at base with no source change, and the font does not move it, so this cell
// does not bar it. The base reads come from two runs of the cells with no source change, the same on every row. The
// first word's drop must equal its base read (their spread plus the reader's 0.01 px step); every other offset, both
// marks, within 1 page px (4 css px) of its word, one ink blob each, one page, no stray ink. A pin of every offset would
// fail the fix, which moves the first word 2 css px across. A line break flip moves a mark a line or a word (base: 26 of
// the 36 rows, 5.44 to 52.28 css px off or no ink). The steady drop is a separate question from this cell's.

const NF_SETTINGS: Settings = { includeName: true, pageSize: "Tabloid", landscape: false, margin: "1", downscalePercent: 25 };
const NF_SCALE = 0.25;
/** NF4 mobile: the first word's drop in page px at base, two reads per size (every row reads the same). */
const NF4_MOBILE_FIRST_DY: Record<"default-16" | "default-26", [number, number]> = { "default-16": [0.63, 0.63], "default-26": [0.37, 0.37] };
const NF_SENTENCE = "words that wrap at the column width and push the next block down the page.";
const NF_PROSE = ("Notes written by hand keep the shape of the thinking that made them, and a page of typed text beside a sketch reads " +
	"differently from either alone. When a word is circled the circle belongs to that word, so a print that moves the word " +
	"and leaves the circle behind changes what the page says. Long paragraphs wrap many times before their last line, " +
	"and every wrap is a place where a slightly wider or narrower letter can push a word onto the next line. A short " +
	"note rarely shows it; a long journal entry, a lecture transcript or a meeting record can.").split(" ");
function nfParagraph(text: string, r: number): string {
	const n = NF_SENTENCE.split(" ").length * r;
	const words = text === "repeat" ? (NF_SENTENCE + " ").repeat(r).trim().split(" ") : Array.from({ length: n }, (_, i) => NF_PROSE[i % NF_PROSE.length]!);
	words[0] = "Firstmark";
	words[words.length - 1] = "Latemark";
	return words.join(" ");
}
const NF_ROWS: Array<[string, "default-16" | "default-26", number]> = [];
for (const text of ["repeat", "prose"]) {
	for (const r of [3, 6, 12, 16, 24, 32, 48, 64, 96, 128]) NF_ROWS.push([text, "default-16", r]);
	for (const r of [3, 6, 12, 16, 24, 32, 48, 64]) NF_ROWS.push([text, "default-26", r]);
}
const NF_T = 900_000;

for (const path of ["mobile", "desktop"] as const) {
	const bar = path === "mobile" ? "the first word's drop as at base, both marks within 1 page px" : "both marks within 1 css px";
	itA(`NF4 ${path}: no line break flips, default 16 px r3-r128 and 26 px r3-r64, repeat and prose: ${bar}`, async () => {
		const bad: string[] = [];
		for (const [text, font, rr] of NF_ROWS) {
			const para = nfParagraph(text, rr);
			const blocks = [para], tokens = ["Firstmark", "Latemark"];
			const marks: Mark[] = [{ block: 0, word: 0 }, { block: 0, word: para.split(" ").length - 1 }];
			const p = await pageFor("tablet", font);
			const name = `NF4-${path}-${text}-${font}-r${rr}`;
			let r: Read, move: Move | undefined;
			if (path === "mobile") {
				const held = await replay(p, { blocks, marks, settings: NF_SETTINGS });
				r = await readPdf((await printNative(held.html, NF_SETTINGS)).pdf, tokens, held.zf, name);
				move = held.space.printMove[1];
			} else {
				const d = await desktopPrint(p, { blocks, marks, settings: NF_SETTINGS });
				r = await readPdf(d.pdf, tokens, NF_SCALE, name);
				move = (d.space.printMove as Move[])[1];
			}
			const css = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round((v / NF_SCALE) * 100) / 100);
			const row = tokens.map(t => { const w = r.words.find(x => x.token === t); return { t, page: w ? w.page : null, ink: w?.ink ?? 0, dx: css(w?.dx), dy: css(w?.dy), pdx: w?.dx ?? null, pdy: w?.dy ?? null }; });
			let ok: boolean;
			if (path === "mobile") {
				const [lo, hi] = [Math.min(...NF4_MOBILE_FIRST_DY[font]), Math.max(...NF4_MOBILE_FIRST_DY[font])];
				const dy0 = row[0]!.pdy, drop = dy0 !== null && dy0 >= lo - READ_STEP - 1e-9 && dy0 <= hi + READ_STEP + 1e-9;
				ok = r.pages === 1 && r.strays.length === 0 && drop && row.every(x => x.ink === 1 && near1(x.pdx) && near1(x.pdy));
			} else ok = r.pages === 1 && r.strays.length === 0 && row.every(x => x.ink === 1 && near1(x.dx) && near1(x.dy));
			console.log("NF4-ROW " + JSON.stringify({ path, text, font, repeats: rr, ok, pages: r.pages, strays: r.strays.length, move, row }));
			if (!ok) bad.push(`${text} ${font} r${rr}: pages ${r.pages}, strays ${r.strays.length}, ${row.map(x => `${x.t} ink ${x.ink} dx ${x.dx} dy ${x.dy} css px (${x.pdx}, ${x.pdy} page px)`).join(", ")} (print font move in the probe ${move ? `${move.dx}, ${move.dy}` : "-"})`);
		}
		expect(bad, path === "mobile"
			? `NF4 mobile: rows off their ink, of ${NF_ROWS.length}: the first word's drop ${JSON.stringify(NF4_MOBILE_FIRST_DY)} page px ±${READ_STEP} as at base (the font does not move it), both marks within 1 page px`
			: `NF4 desktop: rows off their ink (css px), of ${NF_ROWS.length}`).toEqual([]);
		noErrors();
	}, NF_T);
}

// ---- Embeds: the whole export. ----
// An export with ink in any note inside it prints all its text in the font the screen shows; an export with no ink anywhere
// in it, embeds included, is unchanged and nothing is written.

const EMBED_TOKENS = ["Embedfirst", "Embedlate"];
const NF_EMBED_TOKENS = [...ONE_TOKENS, ...EMBED_TOKENS];
/** One export of ONE_PAGE with a note embedded at its foot, on either path: every paragraph's print font, the PDF, the inline fonts. */
async function nfEmbedExport(path: "mobile" | "desktop", o: Partial<Opts>, name: string) {
	const p = await pageFor("tablet");
	const opts: Opts = { blocks: ONE_PAGE, marks: ONE_MARKS, settings: BASE, ...o };
	if (path === "mobile") {
		const held = await replay(p, opts);
		const n = await printNative(held.html, BASE);
		const ref = await printNative(held.html, BASE, "screen");
		const r = await readPdf(n.pdf, NF_EMBED_TOKENS, held.zf, `${name}-mobile`);
		const rr = await readPdf(ref.pdf, NF_EMBED_TOKENS, held.zf, `${name}-mobile-screen-ref`);
		return { paras: n.styled.paras, screen: held.font.screenPara, screenVar: held.font.screenVar, written: written(held.font.inline), after: [] as string[], r, rr };
	}
	const d = await desktopPrint(p, opts, true);
	const r = await readPdf(d.pdf, NF_EMBED_TOKENS, 1, `${name}-desktop`);
	const rr = await readPdf(d.screenPdf!, NF_EMBED_TOKENS, 1, `${name}-desktop-screen-ref`);
	return { paras: d.during.paras, screen: d.mounted.screenPara, screenVar: d.mounted.screenVar, written: written(d.during.inline), after: written(d.after), r, rr };
}
const pdfFonts = (r: Read, tokens: string[]) => tokens.map(t => fontName(r.words.find(w => w.token === t)?.font));

// A note with no ink that embeds a note with ink. Every block's print font (the outer note's and the embed's) is the
// screen's, in the page and in the PDF. Red first at base.
//
// The embed's ink. Before the column fix the embed's crosses sat 24.16 px left of and 15.86 px above "Embedfirst" on
// both paths, "Embedlate"'s cross outside its window, one stray blob; the font did not move them. The column fix mends
// the 24 px: the embed's layer now starts at its text, so "Embedfirst"'s cross sits on its word across (-0.31 px) and
// the stray moves 24 px right with the crosses. The 15.86 px above is still there; it is neither the font's nor the
// column's, and this cell does not bar it. Held here, as read with the column fix: "Embedfirst" across within 0.2 px of
// that read, down within 0.2 px of the read before the fix (the print font moves the cross 0.15 px; the move from the
// pin is printed), "Embedlate" with no ink in its window, the stray blobs each edge within 0.7 px (0.2 plus one 0.5 px
// raster step).
const NF5A_BASE: Record<"mobile" | "desktop", { first: Array<[number, number]>; strays: Array<{ x0: number; y0: number; x1: number; y1: number }> }> = {
	mobile: { first: [[-0.31, -15.86], [-0.31, -15.86]], strays: [{ x0: 524, y0: 344, x1: 556.5, y1: 359 }] },
	desktop: { first: [[-0.31, -15.86], [-0.31, -15.86]], strays: [{ x0: 589, y0: 368, x1: 621.5, y1: 383 }] },
};
const NF5A_BAND = 0.2, NF5A_EDGE = 0.7;
/** The embed's ink as at base: Embedfirst's cross offset within the band, Embedlate's cross outside its window, the strays. */
function expectEmbedAsBase(r: Read, path: "mobile" | "desktop") {
	const base = NF5A_BASE[path], lo = (k: 0 | 1) => Math.min(...base.first.map(v => v[k])), hi = (k: 0 | 1) => Math.max(...base.first.map(v => v[k]));
	const within = (v: number | null | undefined, k: 0 | 1) => v !== null && v !== undefined && v >= lo(k) - NF5A_BAND - 1e-9 && v <= hi(k) + NF5A_BAND + 1e-9;
	const first = r.words.find(w => w.token === "Embedfirst"), late = r.words.find(w => w.token === "Embedlate");
	const moved = (v: number | null | undefined, k: 0 | 1) => (v === null || v === undefined ? "-" : String(Math.round((v - base.first[0]![k]) * 100) / 100));
	const move = `move from base x ${moved(first?.dx, 0)}, y ${moved(first?.dy, 1)}`;
	console.log(`NF5A-MOVE ${path} Embedfirst ${move}`);
	expect({ found: !!first, ink: first?.ink ?? 0, x: within(first?.dx, 0), y: within(first?.dy, 1) },
		`NF5a ${path} embed: "Embedfirst" page ${first ? first.page + 1 : "-"}: cross minus word centre x ${first?.dx}, y ${first?.dy} (raw), ${move}; base reads x ${lo(0)} to ${hi(0)}, y ${lo(1)} to ${hi(1)}, ±${NF5A_BAND}: the embed's ink offset is there at base and the font does not move it; ink blobs in window ${first?.ink}`)
		.toEqual({ found: true, ink: 1, x: true, y: true });
	expect({ found: !!late, ink: late?.ink ?? -1 }, `NF5a ${path} embed: "Embedlate" page ${late ? late.page + 1 : "-"}: no ink blob in its window, as at base; cross ${JSON.stringify(late?.cross)}`)
		.toEqual({ found: true, ink: 0 });
	const near = (a: number, b: number) => Math.abs(a - b) <= NF5A_EDGE + 1e-9;
	const same = r.strays.length === base.strays.length && r.strays.every((s, i) => s.page === 0 && near(s.x0, base.strays[i]!.x0) && near(s.y0, base.strays[i]!.y0) && near(s.x1, base.strays[i]!.x1) && near(s.y1, base.strays[i]!.y1));
	expect(same, `NF5a ${path} embed: the ink outside the marked words' windows as at base, ${JSON.stringify(r.strays)} vs ${JSON.stringify(base.strays)} ±${NF5A_EDGE} px`).toBe(true);
}
for (const path of ["mobile", "desktop"] as const) {
	itA(`NF5a ${path}: a no-ink note embedding an inked note prints every block in the screen's font, the embed's ink as at base`, async () => {
		const e = await nfEmbedExport(path, { rawStrokes: [], embed: "ink" }, "NF5a");
		log("NF5a", path, null, { paras: e.paras, screen: e.screen, written: e.written, after: e.after, fonts: pdfFonts(e.r, NF_EMBED_TOKENS), ref: pdfFonts(e.rr, NF_EMBED_TOKENS), words: e.r.words,
			refWords: e.rr.words.map(w => [w.token, w.ink, w.dx, w.dy]), strays: e.r.strays, refStrays: e.rr.strays });
		expect(e.paras.length, "premise: the outer note's paragraphs and the embed's").toBe(ONE_PAGE.length + 1);
		expect(e.paras, `${path}: every paragraph's print font is the screen's`).toEqual(e.paras.map(() => e.screen));
		const ref = pdfFonts(e.rr, NF_EMBED_TOKENS);
		expect(ref.every(f => f !== "") && new Set(ref).size === 1, `premise: the screen-media print names one font, ${JSON.stringify(ref)}`).toBe(true);
		expectPdfFont(e.r, NF_EMBED_TOKENS, ref[0]!, `NF5a ${path}`);
		expect({ nodes: e.written.length, value: valueOf(e.written[0]), after: e.after }, `${path}: the note's font written once, gone after: ${e.written.join("; ")}`).toEqual({ nodes: 1, value: e.screenVar, after: [] });
		expectEmbedAsBase(e.r, path);
		noErrors();
	}, T);
}

// A guard: a no-ink note embedding a no-ink note prints as at base, nothing written, the app's print chain.
for (const path of ["mobile", "desktop"] as const) {
	itA(`NF5b ${path}: a no-ink note embedding a no-ink note: nothing written, every block in the app's print chain`, async () => {
		const e = await nfEmbedExport(path, { rawStrokes: [], embed: "plain" }, "NF5b");
		log("NF5b", path, null, { paras: e.paras, written: e.written, after: e.after, fonts: pdfFonts(e.r, NF_EMBED_TOKENS) });
		expect({ paras: e.paras.length, printChain: e.paras.every(f => /Arial/.test(f)), pdf: pdfFonts(e.r, NF_EMBED_TOKENS).every(f => /Arial/.test(f)), written: e.written, after: e.after },
			`${path}: print fonts ${JSON.stringify([...new Set(e.paras)])}, PDF ${JSON.stringify(pdfFonts(e.r, NF_EMBED_TOKENS))}`).toEqual({ paras: ONE_PAGE.length + 1, printChain: true, pdf: true, written: [], after: [] });
		noErrors();
	}, T);
}

// After an export with ink, the next export of a no-ink note is unchanged. Guard: green at base.
for (const path of ["mobile", "desktop"] as const) {
	itA(`NF5c ${path}: an export with ink, then a no-ink note's export: nothing written, the app's print chain`, async () => {
		await nfEmbedExport(path, { rawStrokes: [], embed: "ink" }, "NF5c-first");
		const e = await nfEmbedExport(path, { rawStrokes: [] }, "NF5c-next");
		log("NF5c", path, null, { paras: e.paras, written: e.written, after: e.after, fonts: pdfFonts(e.r, ONE_TOKENS) });
		expect({ printChain: e.paras.every(f => /Arial/.test(f)), pdf: pdfFonts(e.r, ONE_TOKENS).every(f => /Arial/.test(f)), written: e.written, after: e.after },
			`${path}: print fonts ${JSON.stringify([...new Set(e.paras)])}, PDF ${JSON.stringify(pdfFonts(e.r, ONE_TOKENS))}`).toEqual({ printChain: true, pdf: true, written: [], after: [] });
		noErrors();
	}, T);
}

// ---- Embeds: an inked note's ink on its words, phone and tablet against desktop. ----
// One plain embed of an inked note, as Obsidian 1.15.1 renders it in a rendered note (the page's embBuild), attached by
// the plugin's own call. The host: two marked lines above the embed and one below it (Hostafter), anchored, attached
// per section. The phone and tablet export hands the native side an HTML string, which is parsed again: the embed's
// span sits in its line's p, a div start tag closes an open p, so the embed's content box falls out of the span, and
// its view takes the print's --file-margins (32 px on every side) in place of the screen's 0 0 0 24px. At base the
// embed's ink prints about 8 px left of and 32 px above its words there, and the text column is 40 px narrower.
//
// The bar for each embedded word: its phone and tablet row (cross minus word centre, page px over the PDF's zoom) less
// the same case's desktop row, within 1.5 css px across and down. Relative, because the desktop column read moves both
// paths alike and is a separate question. The smallest defect at base is 8.2 px. Crosses are paired with their words by
// order down the page (each marked word on a line of its own), from every ink blob on the page: the harness's window
// misses a cross that lands far off. The host's words keep the harness's own bar (within 1 page px, one blob in the
// window), both paths. Each cell runs the phone and tablet export first: a window arms its export triggers once, at its
// first embed, and a desktop first would arm none.

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
	/** The content box in its host block (index, the host strip there, px), and its span's start border and padding. */
	box?: { block: number; strip: boolean; x: number; y: number }; span?: string;
}
interface EmbGeom {
	ink: EmbView | null; outer: EmbView | null; plain: EmbView | null; plainInner: EmbView | null; quiet?: EmbView | null;
	/** Hostpast's block and the plain embed's, and whether Hostpast's block holds the host's strip. */
	after?: { word: number | null; embed: number | null; strip: boolean | null } | null;
}
/**
 * The embeds' views as laid out now, px from each one's content box (the ink layer's box): padding, inline style, the
 * view's and each paragraph's box, and for the wrapped paragraph the line its line-1 word and Embedwrap sit on. A string
 * expression, so it runs in the app page, in the clone loaded with scripts off, and in the desktop print alike.
 */
const EMB_GEOM = `(() => {
	const r2 = v => Math.round(v * 100) / 100;
	const pad = s => [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(" ");
	// The export root's blocks as the print cuts them (EmbedInkPrint printBlocks: its children but the title and the
	// layers), and the block an element sits in: its index, and whether the host's ink strip stands in it.
	const root = document.querySelector(".print > .markdown-preview-view");
	const blocks = root ? [...root.children].filter(c => c.tagName !== "H1" && c.tagName !== "CANVAS" && c.namespaceURI === "http://www.w3.org/1999/xhtml") : [];
	const blockOf = el => {
		let b = el;
		while (b && b.parentElement !== root) b = b.parentElement;
		return b && root ? { el: b, i: blocks.indexOf(b), strip: !!b.querySelector(":scope > svg.handwriting-embed-ink-strip") } : null;
	};
	const read = key => {
		const view = document.querySelector('.print [data-probe="' + key + '"]');
		if (!view) return null;
		const cr = view.parentElement.getBoundingClientRect(), vs = getComputedStyle(view);
		const at = r => ({ x: r2(r.left - cr.left), y: r2(r.top - cr.top), w: r2(r.width), h: r2(r.height) });
		const zf = Math.round(view.getBoundingClientRect().width / (parseFloat(vs.width) || 1) * 1e5) / 1e5;
		const out = { style: view.getAttribute("style"), pad: pad(vs), width: vs.width, zf, inSpan: !!view.closest(".inline-embed"),
			view: at(view.getBoundingClientRect()), blocks: [...view.querySelectorAll("p")].map(b => at(b.getBoundingClientRect())) };
		// The content box's place in its host block, and its span's start border and padding (left, top).
		const blk = blockOf(view.parentElement);
		if (blk) { const br = blk.el.getBoundingClientRect(); out.box = { block: blk.i, strip: blk.strip, x: r2(cr.left - br.left), y: r2(cr.top - br.top) }; }
		const span = view.closest(".inline-embed");
		if (span) { const ss = getComputedStyle(span); out.span = [ss.borderLeftWidth, ss.paddingLeft, ss.borderTopWidth, ss.paddingTop].join(" "); }
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
	// The block Hostpast sits in against the plain embed's, and whether that block holds the host's strip.
	const after = (() => {
		const w = document.querySelector(".print #hx1");
		if (!w) return null;
		const b = blockOf(w), v = blockOf(document.querySelector('.print [data-probe="emb-plain"]'));
		return { word: b ? b.i : null, embed: v ? v.i : null, strip: b ? b.strip : null };
	})();
	return { ink: read("emb-ink"), outer: read("emb-outer"), plain: read("emb-plain"), plainInner: read("emb-plain-inner"), quiet: read("emb-quiet"), after };
})()`;

/** One word's box against its block's host strip, px as laid out (zoomed). */
interface PdfRel { x: number; y: number; h: number }
/**
 * The side embed cells' read: Pdfbelow (#hx3) and Pdfabove against the host strip of the block Pdfbelow sits in, and how
 * the line stands: Pdfbelow's and the span's parents, the embed's children (data-probe-kid) left in the span and
 * standing loose in the block, the span's height. A string expression, so it runs in the app page when the string is
 * taken and in the string loaded with scripts off, as EMB_GEOM.
 */
interface PdfGeom { strip: boolean; below: PdfRel | null; above: PdfRel | null; belowParent: string | null; spanParent: string | null; spanKids: number | null; looseKids: number | null; spanH: number | null; belowTop: number | null }
const PDF_GEOM = `(() => {
	const r2 = v => Math.round(v * 100) / 100;
	const w = document.querySelector(".print #hx3");
	if (!w) return null;
	const root = document.querySelector(".print > .markdown-preview-view");
	let b = w;
	while (b && b.parentElement !== root) b = b.parentElement;
	const strip = b ? b.querySelector(":scope > svg.handwriting-embed-ink-strip") : null;
	const sr = strip ? strip.getBoundingClientRect() : null;
	const rel = el => { if (!el || !sr) return null; const r = el.getBoundingClientRect(); return { x: r2(r.left - sr.left), y: r2(r.top - sr.top), h: r2(r.height) }; };
	const span = document.querySelector('.print [data-probe="emb-pdf"]');
	const inSpan = span ? span.querySelectorAll("[data-probe-kid]").length : 0;
	return { strip: !!strip, below: rel(w), above: rel(document.querySelector(".print #pdf-above")),
		belowParent: w.parentElement ? w.parentElement.tagName : null, spanParent: span && span.parentElement ? span.parentElement.tagName : null,
		spanKids: span ? inSpan : null,
		looseKids: b ? b.querySelectorAll("[data-probe-kid]").length - inSpan : null,
		spanH: span ? r2(span.getBoundingClientRect().height) : null,
		belowTop: b ? r2(w.getBoundingClientRect().top - b.getBoundingClientRect().top) : null };
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
const embLog = (tag: string, name: string, extra: Record<string, unknown>) => console.log("EXPORT-MOBILE-PDF", tag, name, JSON.stringify(extra));

const EMB_CASES: Array<[string, Emb]> = [
	["EMB-1 real (the shipped shape, anchored ink)", { shape: "obsidian", anchored: true }],
	["EMB-2 legacy (ink saved before anchors)", { shape: "obsidian", anchored: false }],
	["EMB-3 sizer (the blocks in a sizer, the column read's control)", { shape: "sizer", anchored: true }],
	["EMB-W wrapped embed line, real", { shape: "obsidian", anchored: true, wrap: true }],
	["EMB-W wrapped embed line, legacy", { shape: "obsidian", anchored: false, wrap: true }],
	["EMB-N nested (a no-ink embed holding the inked one), wrapped embed line", { shape: "obsidian", anchored: true, wrap: true, nested: true }],
];
itA.each(EMB_CASES)("%s: each embedded word's ink lands as on desktop; the host's ink on its words, both paths", async (name, emb) => {
	const p = await pageFor("tablet");
	const o = embOpts(emb);
	const tokens = [...EMB_HOST_TOKENS, ...embTokens(emb)];
	const m = await embMobile(p, o, label(name), tokens);
	const d = await embDesktop(p, o, label(name), tokens);
	// Desktop prints the root at a fit zoom of its own (not 1 at 100 %): its page px are taken back to css px by the
	// embed view's zoom as printed.
	const dz = d.geom.ink?.zf ?? 1;
	const bar = embTokens(emb).map(t => {
		const a = m.paired.rows.get(t), b = d.paired.rows.get(t);
		const dx = a && b ? r2n(a.dx / m.held.zf - b.dx / dz) : null, dy = a && b ? r2n(a.dy / m.held.zf - b.dy / dz) : null;
		return { t, ok: dx !== null && dy !== null && Math.abs(dx) <= EMB_BAR && Math.abs(dy) <= EMB_BAR, dx, dy, mobile: a ?? null, desktop: b ?? null };
	});
	const host = { mobile: hostRows(m.r), desktop: hostRows(d.r) };
	embLog("EMB-ROWS", name, { zf: m.held.zf, dz, svg: m.held.svg, plant: PLANT || null, planted: m.planted, wrapWords: m.held.embWrap, bar, host,
		paired: { mobile: [m.paired.same, m.paired.words, m.paired.inks], desktop: [d.paired.same, d.paired.words, d.paired.inks] },
		live: m.held.embLive?.ink ?? null, print: { mobile: m.geom.ink, desktop: d.geom.ink }, strays: { mobile: m.r.strays, desktop: d.r.strays },
		outer: emb.nested ? { live: m.held.embLive?.outer ?? null, mobile: m.geom.outer, desktop: d.geom.outer } : null });
	expect({ mobile: m.held.svg > 0, desktop: d.d.mounted.svg > 0 }, `premise: ${name}: both builds made the ink`).toEqual({ mobile: true, desktop: true });
	if (PLANT === "embed-shift" || PLANT === "pin-pad-only") expect(m.planted, `premise: ${name}: the ${PLANT} plant applied`).toBe(true);
	expect({ mobile: m.paired.same, desktop: d.paired.same },
		`premise: ${name}: every marked word found once, one ink blob per word, same pages (mobile ${m.paired.words} words, ${m.paired.inks} blobs; desktop ${d.paired.words}, ${d.paired.inks})`).toEqual({ mobile: true, desktop: true });
	if (emb.wrap) {
		expect(wrapHolds(m.held.embLive?.ink?.wrap), `premise: ${name}: on the phone and tablet page the paragraph wraps before Embedwrap, ${JSON.stringify(m.held.embLive?.ink?.wrap)}`).toBe(true);
		expect(wrapHolds(d.geom.ink?.wrap), `premise: ${name}: the desktop print wraps the paragraph as the screen does, ${JSON.stringify(d.geom.ink?.wrap)} (line 1 ${JSON.stringify(m.held.embWrap)})`).toBe(true);
		expect(wrapHolds(m.geom.ink?.wrap), `${name}: the phone and tablet print wraps the paragraph as the screen does (line 1's last word on line 1 inside the column, Embedwrap first on line 2), ${JSON.stringify(m.geom.ink?.wrap)}`).toBe(true);
	}
	expect([...host.mobile, ...host.desktop].filter(h => !h.ok), `${name}: the host's crosses on their words, both paths, within 1 page px`).toEqual([]);
	expect(bar.filter(b => !b.ok).map(b => `${b.t}: mobile less desktop ${b.dx}, ${b.dy} css px (mobile ${JSON.stringify(b.mobile)} page px at zf ${m.held.zf}, desktop ${JSON.stringify(b.desktop)} at zf ${dz})`),
		`${name}: each embedded word's cross, phone and tablet less desktop, within ${EMB_BAR} css px`).toEqual([]);
	noErrors();
}, T);

// Cause plant A as a cell: the fix's string as the native side gets it, and the same string with the embed's line written
// as a div (the parse then keeps the content box in its span), print the ink alike. At base they differ by about 8 and 32.
itA("EMB-A: the embed's line as a p or as a div, the embed's ink prints alike, phone and tablet", async () => {
	const p = await pageFor("tablet");
	const o = embOpts({ shape: "obsidian", anchored: true });
	const tokens = [...EMB_HOST_TOKENS, ...EMB_TOKENS_SHORT];
	const held = await replay(p, o);
	const { html } = embPlantHtml(held.html);
	const asDiv = embDivLine(html);
	expect(asDiv, "premise: EMB-A: the inked embed's line found once in the string").not.toBeNull();
	const a = pairByOrder(await readPdf((await printNative(html, BASE)).pdf, tokens, held.zf, "EMB-A-as-is"), tokens);
	const b = pairByOrder(await readPdf((await printNative(asDiv!, BASE)).pdf, tokens, held.zf, "EMB-A-div-line"), tokens);
	const rows = tokens.map(t => { const x = a.rows.get(t), y = b.rows.get(t); return { t, ok: !!x && !!y && Math.abs(x.dx - y.dx) <= 0.5 && Math.abs(x.dy - y.dy) <= 0.5, asIs: x ?? null, asDiv: y ?? null }; });
	embLog("EMB-A", "real", { zf: held.zf, rows, paired: [a.same, a.words, a.inks, b.same, b.words, b.inks] });
	expect({ asIs: a.same, asDiv: b.same }, "premise: EMB-A: one ink blob per marked word in both prints").toEqual({ asIs: true, asDiv: true });
	expect(rows.filter(r => !r.ok), "EMB-A: each cross minus its word, as a p less as a div, within 0.5 page px").toEqual([]);
	noErrors();
}, T);

// Cause plant B as a cell: in the print the native side makes, the inked embed's view has the screen's padding and its
// width and height, and each paragraph sits where it sits on screen, px from the content box the ink layer sits in. At
// base the padding is 32 px on every side and the view is 1 px wider.
itA("EMB-B: the inked embed's view prints at the screen's padding, width and height, its paragraphs where the screen has them", async () => {
	const p = await pageFor("tablet");
	const held = await replay(p, embOpts({ shape: "obsidian", anchored: true }));
	const { html, planted } = embPlantHtml(held.html);
	const g = await cloneGeom(html);
	const live = held.embLive?.ink ?? null, got = g.ink;
	embLog("EMB-B", "real", { zf: held.zf, plant: PLANT || null, planted, live, print: got });
	expect({ live: !!live, print: !!got }, "premise: EMB-B: the inked embed's view read on the page and in the print").toEqual({ live: true, print: true });
	const near = (x: number, y: number) => Math.abs(x - y) <= 0.25;
	const blocks = live!.blocks.length === got!.blocks.length && live!.blocks.every((b, i) => near(b.x, got!.blocks[i]!.x) && near(b.y, got!.blocks[i]!.y));
	expect({ pad: got!.pad, w: near(got!.view.w, live!.view.w), h: near(got!.view.h, live!.view.h), blocks },
		`EMB-B: print view pad ${got!.pad} w ${got!.view.w} h ${got!.view.h}, blocks ${JSON.stringify(got!.blocks)}; on the page pad ${live!.pad} w ${live!.view.w} h ${live!.view.h}, blocks ${JSON.stringify(live!.blocks)} (zoomed px, ±0.25)`)
		.toEqual({ pad: live!.pad, w: true, h: true, blocks: true });
	noErrors();
}, T);

// A guard: an embed of a note with no ink, holding an embed of another note with no ink by the time the export builds
// (one stroke at its attach, none after, so its root registers and the build reaches it), beside an inked embed.
// Nothing is written on either view, and both print as at base (out of their spans, the print's margins). Green at
// base; a plant that pins every embed view, ink or not, turns it red.
itA("EMB-0: a no-ink embed holding a no-ink embed, beside an inked one: nothing written on either view, both print as at base", async () => {
	const p = await pageFor("tablet");
	const tokens = [...EMB_HOST_TOKENS, ...EMB_TOKENS_SHORT];
	const held = await replay(p, embOpts({ shape: "obsidian", anchored: true, plain: true }));
	const { html } = embPlantHtml(held.html);
	const g = await cloneGeom(html);
	const r = await readPdf((await printNative(html, BASE)).pdf, tokens, held.zf, "EMB-0");
	const paired = pairByOrder(r, tokens);
	const live = held.embLive;
	embLog("EMB-0", "real+plain", { zf: held.zf, plainCanvas: held.embPlainCanvas, live: live ? { plain: live.plain, plainInner: live.plainInner } : null,
		print: { plain: g.plain, plainInner: g.plainInner }, paired: [paired.same, paired.words, paired.inks] });
	expect({ live: !!live?.plain && !!live?.plainInner, print: !!g.plain && !!g.plainInner, canvas: (held.embPlainCanvas ?? 0) >= 1 },
		`premise: EMB-0: both no-ink views read on the page and in the print, and the inner one's root registered with its canvas (${held.embPlainCanvas}), so the export builds it`).toEqual({ live: true, print: true, canvas: true });
	expect({ live: [live!.plain!.style, live!.plainInner!.style], print: [g.plain!.style, g.plainInner!.style], pad: [g.plain!.pad, g.plainInner!.pad], inks: paired.same },
		`EMB-0: the no-ink views (outer, inner): inline style on the page and in the print, their print padding (base ${EMB_PLAIN_BASE_PAD}), and no ink but the marked words' (${paired.inks} blobs, ${paired.words} words)`)
		.toEqual({ live: [null, null], print: [null, null], pad: [EMB_PLAIN_BASE_PAD, EMB_PLAIN_BASE_PAD], inks: true });
	noErrors();
}, T);

// ---- The host's ink over an embed with no ink of its own, phone and tablet against desktop. ----
// EMB-0's fixture (a no-ink embed holding a no-ink embed on host block 4, beside the inked one) with host crosses on
// marked words: on the no-ink embed's first word (Plainword, ruling bound 1), on the host's first word after that
// embed in the same paragraph (Hostpast, bound 2), on the inner no-ink embed's first word (Innerword, bound 6). Each
// cross is placed from the phone or tablet page as the export's zoom lays it out; the desktop print takes the same strokes.
// The native parse takes each no-ink view out of its span at the print's --file-margins, and the host's strip moves
// with its block, not with the text in it. The bar: in each print alone, the cross
// less its own word, less that print's own move of the embed spans' start insets, within EMB_BAR css px. The move is
// each span the word sits in, its start inset on the phone or tablet page before the export's zoom is written less the
// same inset as printed, summed: measured in the run, never a constant, and 0 at zoom 1. Where a span the word sits in
// is not in the print the move is not measured and the row fails. The row less desktop is logged, not asserted.
// Premise: on desktop each of these crosses is on its word (the harness's 1 page px, one
// blob in its window) once the move of its embed spans' start insets from the desktop page to its print is taken off,
// so the strokes are placed right. The ruling's read at base: Plainword about 8 px left and 32 px
// high, Hostpast about 64 px high, neither run.
// The strokes are free host ink anchored to the embed's source line, as the editor anchors free ink drawn over an
// embed (the embed is that one line); not covered here: unanchored ink (EMB-2's legacy shape) and attached ink (an
// attach takes source text, and an embed holds none of its paragraph's lines). Bound 2's premise (R2-4): Hostpast and
// the plain embed sit in one host block and that block holds the host's strip, on the page and in the print. R2-1's
// read, logged and not asserted: each no-ink content box's place in its host block, page and print, and its span's
// start border and padding.

const EMB_AFTER_LINE = "![[Plain look]] Hostpast closes the host block after its plain embed";
const OVER_TOKEN: Record<Over, string> = { plain: "Plainword", after: "Hostpast", inner: "Innerword" };
const OVER_BOUND: Record<Over, string> = { plain: "bound 1", after: "bound 2", inner: "bound 6" };
const OVER_DEVICES = [["tablet", TABLET.column], ["phone", PHONE.column]] as const;
const overOpts = (over: Over[], column: number, quiet = false): Opts => ({
	blocks: [...EMB_HOST, over.includes("after") ? EMB_AFTER_LINE : "![[Plain look]]", ...(quiet ? ["![[Quiet look]]"] : [])],
	marks: EMB_HOST_MARKS, settings: { ...BASE }, attached: true, column, emb: { shape: "obsidian", anchored: true, plain: true, hostOver: over, quiet },
});
/** One word's row: its cross minus its centre, phone and tablet less desktop, css px (the EMB cells' bar). */
function overRow(t: string, m: EmbMobile, d: Awaited<ReturnType<typeof embDesktop>>, dz: number) {
	const a = m.paired.rows.get(t), b = d.paired.rows.get(t);
	const dx = a && b ? r2n(a.dx / m.held.zf - b.dx / dz) : null, dy = a && b ? r2n(a.dy / m.held.zf - b.dy / dz) : null;
	return { t, ok: dx !== null && dy !== null && Math.abs(dx) <= EMB_BAR && Math.abs(dy) <= EMB_BAR, dx, dy, mobile: a ?? null, desktop: b ?? null };
}
/** The no-ink embed spans each host word sits in, outer first. */
const OVER_SPANS: Record<string, Array<"plain" | "plainInner">> = { Plainword: ["plain"], Hostpast: [], Innerword: ["plain", "plainInner"] };
/** A print geom's span start inset (its logged border and padding, the first two values), css px; null with no span. */
const printedInset = (s: string | undefined) => (s ? s.split(" ").slice(0, 2).reduce((a, v) => a + (Number.parseFloat(v) || 0), 0) : null);
/** The print's own move of the word's embed spans' start insets, css px (the page before the zoom less the print, summed); null where one is not read. */
function printMoveOf(t: string, m: EmbMobile): number | null {
	let sum = 0;
	for (const k of OVER_SPANS[t] ?? []) {
		const before = m.held.insetsBeforeZoom?.[k] ?? null, printed = printedInset(m.geom[k]?.span);
		if (before === null || printed === null) return null;
		sum += before - printed;
	}
	return r2n(sum);
}
/** One word's row in its own print, css px: its cross minus its centre, x less the print's own move (the bar). */
function ownRow(t: string, m: EmbMobile) {
	const a = m.paired.rows.get(t), move = printMoveOf(t, m);
	const dx = a && move !== null ? r2n(a.dx / m.held.zf - move) : null, dy = a ? r2n(a.dy / m.held.zf) : null;
	return { t, ok: dx !== null && dy !== null && Math.abs(dx) <= EMB_BAR && Math.abs(dy) <= EMB_BAR, dx, dy, move, mobile: a ?? null };
}

const OVER_CASES: Array<[string, Over[]]> = [
	["EMB-H host ink on a no-ink embed's word and on the host's word after it", ["plain", "after"]],
	["EMB-H6 host ink on a word of a no-ink embed inside a no-ink embed", ["inner"]],
];
const OVER_RUNS: Array<[string, Over[], "tablet" | "phone", number]> = OVER_CASES.flatMap(([name, over]) =>
	OVER_DEVICES.map(([dev, column]): [string, Over[], "tablet" | "phone", number] => [`${name}, ${dev}`, over, dev, column]));
itA.each(OVER_RUNS)("%s: each host cross lands on its word in its own print", async (name, over, dev, column) => {
	const p = await pageFor(dev);
	const o = overOpts([...over], column);
	const own = over.map(k => OVER_TOKEN[k]);
	const tokens = [...EMB_HOST_TOKENS, ...EMB_TOKENS_SHORT, ...own];
	const m = await embMobile(p, o, label(name), tokens);
	const d = await embDesktop(p, { ...o, hostOverStrokes: m.held.hostOverStrokes ?? [] }, label(name), tokens);
	const dz = d.geom.ink?.zf ?? 1;
	const rows = over.map(k => ({ bound: OVER_BOUND[k], ...ownRow(OVER_TOKEN[k], m) }));
	// Logged, not asserted: each word's row less its desktop row.
	const lessDesktop = over.map(k => ({ bound: OVER_BOUND[k], ...overRow(OVER_TOKEN[k], m, d, dz) }));
	const liveG = m.held.embLive;
	// The desktop place each cross is owed (RED-RESULT add1): the crosses sit on their words on the desktop page (its own
	// places, at.desktop, match the phone's and tablet's), and desktop's print fit zoom lays a 2 px span border out at 1
	// device px. So each embed span that holds the word moves it left by its start inset (border and padding) on the
	// desktop page less the same inset as printed, summed over those spans, in desktop page px.
	const inset = (s: string | undefined) => (s ? s.split(" ").slice(0, 2).reduce((a, v) => a + (Number.parseFloat(v) || 0), 0) : 0);
	const screenInset = d.d.mounted.hostOverInsets ?? null;
	const owed = (t: string) => r2n(dz * (OVER_SPANS[t] ?? []).reduce((a, k) => a + (screenInset?.[k] ?? 0) - inset(d.geom[k]?.span), 0));
	const deskOn = own.map(t => { const w = d.r.words.find(x => x.token === t); const at = owed(t); return { t, ok: !!w && w.ink === 1 && w.dx !== null && near1(w.dx - at) && near1(w.dy), dx: w?.dx ?? null, dy: w?.dy ?? null, owed: at, ink: w?.ink ?? 0 }; });
	const host = { mobile: hostRows(m.r), desktop: hostRows(d.r) };
	const boxMove = (a: EmbView | null | undefined, b: EmbView | null | undefined) => (a?.box && b?.box ? { dx: r2n(b.box.x - a.box.x), dy: r2n(b.box.y - a.box.y) } : null);
	const box = { plain: { live: liveG?.plain?.box ?? null, print: m.geom.plain?.box ?? null, move: boxMove(liveG?.plain, m.geom.plain), span: liveG?.plain?.span ?? null },
		plainInner: { live: liveG?.plainInner?.box ?? null, print: m.geom.plainInner?.box ?? null, move: boxMove(liveG?.plainInner, m.geom.plainInner), span: liveG?.plainInner?.span ?? null } };
	const after = { live: liveG?.after ?? null, print: m.geom.after ?? null, desktop: d.geom.after ?? null };
	embLog("EMB-H-ROWS", name, { dev, column, zf: m.held.zf, dz, rows, lessDesktop, deskOn, host, box, after, emb: EMB_TOKENS_SHORT.map(t => overRow(t, m, d, dz)),
		at: { mobile: m.held.hostOver, desktop: d.d.mounted.hostOverAt ?? null }, insets: { desktopPage: screenInset, beforeZoom: m.held.insetsBeforeZoom ?? null }, svg: m.held.svg,
		paired: { mobile: [m.paired.same, m.paired.words, m.paired.inks], desktop: [d.paired.same, d.paired.words, d.paired.inks] },
		live: { plain: m.held.embLive?.plain ?? null, plainInner: m.held.embLive?.plainInner ?? null },
		print: { mobile: { plain: m.geom.plain, plainInner: m.geom.plainInner }, desktop: { plain: d.geom.plain, plainInner: d.geom.plainInner } },
		strays: { mobile: m.r.strays, desktop: d.r.strays } });
	expect({ mobile: m.held.svg > 0, desktop: d.d.mounted.svg > 0, crosses: (m.held.hostOverStrokes ?? []).length },
		`premise: ${name}: both builds made the ink, and one host cross per marked word over or after the no-ink embed (${JSON.stringify(m.held.hostOver)})`).toEqual({ mobile: true, desktop: true, crosses: 2 * own.length });
	expect({ mobile: m.paired.same, desktop: d.paired.same },
		`premise: ${name}: every marked word found once, one ink blob per word, same pages (mobile ${m.paired.words} words, ${m.paired.inks} blobs; desktop ${d.paired.words}, ${d.paired.inks})`).toEqual({ mobile: true, desktop: true });
	expect(deskOn.filter(r => !r.ok), `premise: ${name}: on desktop each host cross over or after the no-ink embed sits on its word, within 1 page px of the place its embed spans' insets owe it (owed), one blob in its window`).toEqual([]);
	if (over.includes("after")) {
		const one = (a: EmbGeom["after"]) => !!a && a.word !== null && a.word >= 0 && a.word === a.embed && a.strip === true;
		expect({ live: one(after.live), print: one(after.print) },
			`premise: ${name}: Hostpast and the plain embed in one host block that holds the host's strip, on the page and in the print (${JSON.stringify(after)})`).toEqual({ live: true, print: true });
	}
	expect(rows.filter(r => !r.ok).map(r => `${r.bound} ${r.t}: cross less its word ${r.dx}, ${r.dy} css px after the print's own span move ${r.move} (cross ${JSON.stringify(r.mobile)} page px at zf ${m.held.zf}; span insets before the zoom ${JSON.stringify(m.held.insetsBeforeZoom ?? null)}, printed ${JSON.stringify([m.geom.plain?.span ?? null, m.geom.plainInner?.span ?? null])})`),
		`${name}: each host cross over or after a no-ink embed, in its own print, on its word less that print's own move of its embed spans' start insets, within ${EMB_BAR} css px`).toEqual([]);
	expect([...host.mobile, ...host.desktop].filter(h => !h.ok), `${name}: the host's other crosses on their words, both paths, within 1 page px`).toEqual([]);
	noErrors();
}, T);

// Bound 3, a guard: with host ink over the no-ink embed on block 4 (Plainword), a third no-ink embed alone on block 5
// (Quiet look: one stroke at its attach and none by the export's build, so its root registers and the build reaches
// it, as EMB-0's inner) has no host ink in its block. Nothing is written on its view and it prints as at base. Green
// at base; a plant that pins every embed view turns it red.
itA("EMB-H3: a no-ink embed with no host ink in its block prints as at base, beside one with host ink over it, tablet", async () => {
	const p = await pageFor("tablet");
	const held = await replay(p, overOpts(["plain"], TABLET.column, true));
	const { html } = embPlantHtml(held.html);
	const g = await cloneGeom(html);
	const live = held.embLive?.quiet ?? null;
	embLog("EMB-H3", "tablet", { zf: held.zf, quietCanvas: held.embQuietCanvas, hostOver: held.hostOver, live, print: g.quiet ?? null });
	expect({ live: !!live, print: !!g.quiet, canvas: (held.embQuietCanvas ?? 0) >= 1, crosses: (held.hostOverStrokes ?? []).length, quietStrip: live?.box?.strip ?? null, plainStrip: held.embLive?.plain?.box?.strip ?? null },
		`premise: EMB-H3: the quiet view read on the page and in the print, its root registered with its canvas (${held.embQuietCanvas}), the host's cross over Plainword made, and the host's strip in the plain embed's block, not the quiet one's`)
		.toEqual({ live: true, print: true, canvas: true, crosses: 2, quietStrip: false, plainStrip: true });
	expect({ live: live!.style, print: g.quiet!.style, pad: g.quiet!.pad },
		`EMB-H3: the quiet view: inline style on the page and in the print, and its print padding (base ${EMB_PLAIN_BASE_PAD})`).toEqual({ live: null, print: null, pad: EMB_PLAIN_BASE_PAD });
	noErrors();
}, T);

// ---- The host's ink after a side embed in its paragraph, phone and tablet. ----
// Host block 4 is one paragraph of three source lines, "Pdfabove notes", the embed, "Pdfbelow notes" (the page's
// embSide), the rest EMB-H's host. The host's cross goes on Pdfbelow, placed from the phone or tablet page as the
// export's zoom lays it out (hostOverStrokes, as Hostpast), so the host's strip is cut in block 4 from the page as it
// stands. The native side parses the export's string again, and a div start tag closes an open p. The read: Pdfbelow's
// box against its block's strip in the string loaded with scripts off (the native side's parse; a DOMParser parse of the
// same string builds the same tree), less the same on the page when the string is taken, css px; and the embed's
// children (data-probe-kid): after the parse the span still holds every one, none loose in the block. The bar is the
// ruling's 0.5 css px. Pdfabove's move is logged as the read's own zero. The printed PDF's row for Pdfbelow (its cross
// less its word, pairing by order) is logged, not asserted: the 800 px span can put Pdfbelow on a later page than its
// strip's top.
// The parse is read in print media at the device's width and the export page's content height. In a print vh is the
// page's content box (Chromium's print lays an 80vh span on a Letter landscape page at
// the default margin at 593 px), and the app's print rule caps a PDF embed at 80vh (app CSS in the 1.15.1 asar, byte
// 418065). A portrait Letter page at the default margin is 1056 - 2 x 38.4 = 979.2 css px tall (the read's viewport is
// 979), so the cap (783 px) binds on the 800 px span: Pdfbelow moves about 17 px up with no escape, the app's own rule,
// which no hold of the line takes away. Whether that move is in this bound is ruled apart, with
// the same-block rows. So each run reads the parse twice: as the string stands ("capped", logged), and with the
// cap lifted by one test-side rule in the string's head ("lifted", asserted), the escape alone. The width stays the
// device's, so each line wraps as on the page. Premises: the page holds Pdfbelow where its strip was cut (the read once
// the zoom's build is done, less the read when the string is taken, within the bar), so the parse less the page is the
// parse less the cut.
// Held to by every run: the export's print swaps are one for the zoom's build and at most one more for a late entry, so
// a late look that wakes itself goes red. Logged, not asserted ("placed"): Pdfbelow's top in its block when the string
// is taken less where its cross was placed. The crosses are placed before the zoom's build, and the build lays the root
// out at the column width, which can move a line before any hold (PDF-12 phone: -24 at base), so that read is no zero
// for the hold's own move.
// More rows: PDF-7 (c): PDF-5 at 80 %
// with the line's margins in em, the held line's inline margins the line's own before the zoom. PDF-8 to PDF-10 (b):
// an embed of a kind no rule names whose span holds a list first, a div one span down, a rule. PDF-11 and
// PDF-12 are cells of their own below.
// a (PDF-1): a PDF embed, its viewer built. b (PDF-3, PDF-4): an embed of a kind the plugin does not name that holds a
// div, a Canvas embed (its title div and board) and a Bases embed (its view's divs). c (PDF-5): a PDF embed whose
// viewer's divs enter the span after the zoom's build (the hold) and before the string is taken. Control (PDF-2): a PDF
// embed whose viewer never builds (the span empty), nothing to escape. d (PDF-6): a picture embed (an img in its span):
// its line is still a p on the page and in the string, and its string is byte-equal to the line's string before the
// build (no build touches it at base); the string is logged for the base-to-tip compare.

const SIDE_SRC: Record<Side["kind"], string> = { pdf: "Paper.pdf", canvas: "Board.canvas", bases: "Books.base", picture: "Photo.png",
	list: "List.view", deep: "Deep.view", rule: "Rule.view", tall: "Shelf.base" };
/** The children each kind's span holds once its content stands (the page's SIDE_KINDS; deep's one is its div a span down). */
const SIDE_KIDS: Record<Side["kind"], number> = { pdf: 2, canvas: 2, bases: 2, picture: 1, list: 1, deep: 1, rule: 1, tall: 2 };
const PDF_BAR = 0.5;
const pdfOpts = (pdf: Side, column: number): Opts => ({
	blocks: [...EMB_HOST, `Pdfabove notes ![[${SIDE_SRC[pdf.kind]}]] Pdfbelow notes`], marks: EMB_HOST_MARKS, settings: { ...BASE, downscalePercent: pdf.percent ?? BASE.downscalePercent }, attached: true, column,
	emb: { shape: "obsidian", anchored: true, hostOver: [], pdf },
});
/** A portrait page's height in css px (96 per inch): Letter 11 in, A4 297 mm. */
const PAGE_CSS_H: Record<string, number> = { Letter: 1056, A4: 1123 };
/** The export page's content box, css px: the page less both margins (a print's vh), in whole px for the read's viewport. */
const PAGE_CONTENT_H = Math.round(PAGE_CSS_H[BASE.pageSize]! - 2 * MARGIN_IN[BASE.margin]! * 96);
/** One test-side rule in the string's head for the lifted read: the app's print cap on a PDF embed taken off. */
const PDF_CAP_LIFT = "<style>@media print{.print .pdf-embed{max-height:none!important}}</style>";
interface PdfParse { pdf: PdfGeom | null; emb: EmbGeom; lifted: boolean }
/**
 * The string loaded as the native side loads it (scripts off), read in print media at the device's width and the page's
 * content height; lift: with PDF_CAP_LIFT in its head.
 */
async function pdfCloneGeom(html: string, width: number, lift: boolean): Promise<PdfParse> {
	const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: PAGE_CONTENT_H } });
	try {
		const p = await ctx.newPage();
		const h = lift ? html.replace("</head>", `${PDF_CAP_LIFT}</head>`) : html;
		await p.setContent(h);
		await p.emulateMedia({ media: "print" });
		return { pdf: (await p.evaluate(PDF_GEOM)) as PdfGeom | null, emb: (await p.evaluate(EMB_GEOM)) as EmbGeom, lifted: lift && h !== html };
	} finally {
		await ctx.close();
	}
}
/** A word's move against its strip, the parse less the page, css px. */
const pdfMove = (a: PdfRel | null | undefined, b: PdfRel | null | undefined, zf: number) => (a && b ? { dx: r2n((b.x - a.x) / zf), dy: r2n((b.y - a.y) / zf) } : null);
const PDF_CASES: Array<[string, Side]> = [
	["PDF-1 (a) a PDF embed, its viewer built (its toolbar and page container in the span)", { kind: "pdf", at: "built" }],
	["PDF-2 (control) a PDF embed, its viewer not built (the span empty)", { kind: "pdf", at: "empty" }],
	["PDF-3 (b) a Canvas embed, its title div and board in the span", { kind: "canvas", at: "built" }],
	["PDF-4 (b) a Bases embed, its view's divs in the span", { kind: "bases", at: "built" }],
	["PDF-5 (c) a PDF embed whose viewer's divs enter the span after the hold", { kind: "pdf", at: "late" }],
	["PDF-6 (d) a picture embed, its img in the span", { kind: "picture", at: "built" }],
	["PDF-7 (c) a PDF embed whose viewer's divs enter the span after the hold, at 80 %, its line's margins in em", { kind: "pdf", at: "late", percent: 80, em: true }],
	["PDF-8 (b) an embed whose span holds a list first", { kind: "list", at: "built" }],
	["PDF-9 (b) an embed whose div sits one span down in its span", { kind: "deep", at: "built" }],
	["PDF-10 (b) an embed whose span holds a rule", { kind: "rule", at: "built" }],
];
const PDF_RUNS: Array<[string, Side, "tablet" | "phone", number]> = PDF_CASES.flatMap(([name, side]) =>
	OVER_DEVICES.map(([dev, column]): [string, Side, "tablet" | "phone", number] => [`${name}, ${dev}`, side, dev, column]));
const withinBar = (d: { dx: number; dy: number } | null) => !!d && Math.abs(d.dx) <= PDF_BAR && Math.abs(d.dy) <= PDF_BAR;
/** The parse read both ways, and the reads every side cell takes from them. */
async function pdfReads(m: EmbMobile, dev: "tablet" | "phone") {
	const width = (dev === "phone" ? PHONE : TABLET).width;
	const capped = await pdfCloneGeom(m.html, width, false), lifted = await pdfCloneGeom(m.html, width, true);
	const live = m.held.pdfLive ?? null, cut = m.held.pdfAtBuild ?? null, parsed = lifted.pdf, zf = m.held.zf;
	const placeTop = m.held.pdfPlaceTop ?? null;
	const row = m.paired.rows.get("Pdfbelow") ?? null;
	return {
		live, cut, parsed, zf, lifted, capped,
		below: pdfMove(live?.below, parsed?.below, zf), above: pdfMove(live?.above, parsed?.above, zf), sinceCut: pdfMove(cut?.below, live?.below, zf),
		cappedBelow: pdfMove(live?.below, capped.pdf?.below, zf),
		/** The string's read of Pdfbelow's top in its block less the placing read, css px. */
		placed: live?.belowTop != null && placeTop !== null ? r2n(live.belowTop / zf - placeTop) : null,
		print: row ? { ...row, dxCss: r2n(row.dx / zf), dyCss: r2n(row.dy / zf) } : null,
		/** The harness's own print read of Pdfbelow: its cross less its word, page px, and the blobs in its window. */
		printWord: (w => (w ? { dx: w.dx, dy: w.dy, ink: w.ink } : null))(m.r.words.find(x => x.token === "Pdfbelow")),
	};
}
itA.each(PDF_RUNS)("%s: the host's cross on the word after the embed stays on it through the native parse", async (name, side, dev, column) => {
	const p = await pageFor(dev);
	const o = pdfOpts(side, column);
	const tokens = [...EMB_HOST_TOKENS, ...EMB_TOKENS_SHORT, "Pdfbelow"];
	const m = await embMobile(p, o, label(name), tokens);
	const { live, cut, parsed, zf, lifted, capped, below, above, sinceCut, cappedBelow, placed, print } = await pdfReads(m, dev);
	const kids = side.at === "empty" ? 0 : SIDE_KIDS[side.kind];
	const late = side.at === "late";
	const line = m.held.lines?.side ?? null;
	embLog("PDF-ROWS", name, { dev, column, zf, side, below, above, sinceCut, placed, swaps: m.held.swaps,
		capped: { below: cappedBelow, spanH: capped.pdf?.spanH ?? null, kids: capped.pdf?.spanKids ?? null }, live, cut, parsed, print,
		line: { live: line?.live?.tag ?? null, clone: line?.clone?.tag ?? null, sameAsBefore: !!line?.clone && line.clone.html === line.before, margins: line?.margins ?? null, string: line?.clone?.html ?? null },
		paired: [m.paired.same, m.paired.words, m.paired.inks], hostOver: m.held.hostOver, strays: m.r.strays });
	expect({ crosses: (m.held.hostOverStrokes ?? []).length, live: live?.strip ?? null, parsed: parsed?.strip ?? null, kids: live?.spanKids ?? null, cutKids: cut?.spanKids ?? null },
		`premise: ${name}: one host cross on Pdfbelow (${JSON.stringify(m.held.hostOver)}), its block holds the host's strip on the page and after the parse, and the span holds its children on the page when the string is taken (${kids}) and once the zoom's build is done (${side.at === "built" ? kids : 0})`)
		.toEqual({ crosses: 2, live: true, parsed: true, kids, cutKids: side.at === "built" ? kids : 0 });
	expect(withinBar(sinceCut), `premise: ${name}: the page holds Pdfbelow where its strip was cut, the string's read less the build's: ${JSON.stringify(sinceCut)} css px, within ${PDF_BAR}`).toBe(true);
	expect({ lifted: lifted.lifted, viewport: PAGE_CONTENT_H }, `premise: ${name}: the lifted read took its rule, both reads at the page's content height`).toEqual({ lifted: true, viewport: 979 });
	if (side.kind === "picture") {
		expect({ live: line?.live?.tag ?? null, clone: line?.clone?.tag ?? null, same: !!line?.clone && line.clone.html === line.before },
			`${name}: the picture's line still a p on the page and in the string, its string byte-equal to its string before the build (the string in the PDF-ROWS log)`).toEqual({ live: "P", clone: "P", same: true });
	}
	expect(withinBar(below) ? [] : [`Pdfbelow against its strip, the parse (cap lifted) less the page: ${JSON.stringify(below)} css px at zf ${zf} (capped ${JSON.stringify(cappedBelow)}; Pdfabove ${JSON.stringify(above)}; the line on the page a ${line?.live?.tag}; after the parse Pdfbelow in ${parsed?.belowParent}, the span in ${parsed?.spanParent} holding ${parsed?.spanKids} of its children, ${parsed?.looseKids} loose in the block, span ${parsed?.spanH} px; print row ${JSON.stringify(print)})`],
		`${name}: the host's cross on Pdfbelow, its word against its block's strip through the native parse, within ${PDF_BAR} css px`).toEqual([]);
	expect({ span: parsed?.spanKids ?? null, loose: parsed?.looseKids ?? null },
		`${name}: after the parse the span still holds its ${kids} children, none loose in the block`).toEqual({ span: kids, loose: 0 });
	expect(m.held.swaps, `${name}: the export's print swaps: one for the zoom's build${late ? ", at most one more for the late entry" : ""}, then none`).toBeLessThanOrEqual(late ? 2 : 1);
	if (side.em) {
		expect(line?.margins?.inline ?? null, `${name}: the held line's inline margins, read with the zoom off: the line's own before the zoom`).toEqual(line?.margins?.before ?? "no line");
	}
	noErrors();
}, T);

// e, EMB-I: an inked embed's line with host ink in its block is held, as a no-ink embed's line is. EMB-1's inked embed
// (Embed look, host block 2) with its line run on past the span to Inkpast, which takes a host cross anchored to block 2,
// so the inked embed's block holds a host strip and the hold walks it: the line is a div on the page and in the string,
// its computed margins inline. Red at base (a p both ways: the line was passed over). EMB-L reads the host's ink through
// the parse on that line; the other half of e is the whole file: every other note-embed cell (EMB-*) stays green.
const EMB_INKED_LINE = "![[Embed look]] Inkpast closes the inked embed's line";
itA.each(OVER_DEVICES)("EMB-I (e), %s: an inked embed's line, host ink in its block, is held: a div on the page and in the string", async (dev, column) => {
	const p = await pageFor(dev);
	const o: Opts = { blocks: EMB_HOST.map((b, i) => (i === 2 ? EMB_INKED_LINE : b)), marks: EMB_HOST_MARKS, settings: { ...BASE }, attached: true, column,
		emb: { shape: "obsidian", anchored: true, hostOver: [], inkedHost: true } };
	const held = await replay(p, o);
	const ink = held.lines?.ink ?? null;
	embLog("EMB-I", dev, { zf: held.zf, hostOver: held.hostOver, svg: held.svg, ink: ink ? { live: ink.live?.tag ?? null, clone: ink.clone?.tag ?? null, strip: ink.strip, drew: ink.drew } : null });
	expect({ crosses: (held.hostOverStrokes ?? []).length, strip: ink?.strip ?? null, drew: ink?.drew ?? null },
		`premise: EMB-I, ${dev}: one host cross on Inkpast (${JSON.stringify(held.hostOver)}), the inked embed's block holds the host's strip, and the inked embed drew its ink`).toEqual({ crosses: 2, strip: true, drew: true });
	expect({ live: ink?.live?.tag ?? null, clone: ink?.clone?.tag ?? null, margins: ink?.margins.inline ?? null },
		`EMB-I (e), ${dev}: the inked embed's line, on the page and in the string taken, held as a div with its computed margins inline (${JSON.stringify(ink?.margins.before ?? null)})`)
		.toEqual({ live: "DIV", clone: "DIV", margins: ink?.margins.before ?? "no line" });
	noErrors();
}, T);

/** One side cell's line as logged: its tag on the page and in the string, its string, its margins. */
const sideLineLog = (line: NonNullable<Held["lines"]>["side"] | undefined) =>
	({ live: line?.live?.tag ?? null, clone: line?.clone?.tag ?? null, sameAsBefore: !!line?.clone && line.clone.html === line.before, margins: line?.margins ?? null });

// PDF-11 (c): a late entry that takes height. A Bases embed whose view takes its height from its
// content (a view 120 px tall, no fixed embed rule), empty at the zoom's build and filled after it, in host block 4's
// paragraph, with one more block after it (Pdfnext). The host's cross on Pdfbelow is placed from the page with the view
// in, as the screen the ink was drawn on holds it. At the zoom's build the view is out, so Pdfbelow sits higher in its
// block than its cross, and the cut puts the cross in the next block's strip; the late view then moves that block down.
// A hold of the line alone leaves the cross there; a cut made again once the view is in puts it in Pdfbelow's block.
// Checks: Pdfbelow's block holds the host's strip on the page and after the parse; Pdfbelow against that strip, the
// parse less the page, within the bar; the printed cross on Pdfbelow within the harness's own bar (1 page px, one blob
// in its window); the span keeps its children; at most two print swaps.
const TALL_SIDE: Side = { kind: "tall", at: "late" };
itA.each(OVER_DEVICES)("PDF-11 (c) a late entry that takes height, %s: the host's cross on the word after the embed stays on it, through the parse and in print", async (dev, column) => {
	const p = await pageFor(dev);
	const name = `PDF-11 (c) a late Bases view 120 px tall, ${dev}`;
	const o: Opts = { blocks: [...EMB_HOST, `Pdfabove notes ![[${SIDE_SRC.tall}]] Pdfbelow notes`, "Pdfnext closes the host note below the side embed"],
		marks: EMB_HOST_MARKS, settings: { ...BASE }, attached: true, column, emb: { shape: "obsidian", anchored: true, hostOver: [], pdf: TALL_SIDE } };
	const tokens = [...EMB_HOST_TOKENS, ...EMB_TOKENS_SHORT, "Pdfbelow"];
	const m = await embMobile(p, o, label(name), tokens);
	const { live, cut, parsed, zf, below, placed, print, printWord } = await pdfReads(m, dev);
	const grew = live?.belowTop != null && cut?.belowTop != null ? r2n((live.belowTop - cut.belowTop) / zf) : null;
	embLog("PDF-ROWS", name, { dev, column, zf, side: TALL_SIDE, below, placed, grew, swaps: m.held.swaps, live, cut, parsed, print, printWord,
		line: sideLineLog(m.held.lines?.side), paired: [m.paired.same, m.paired.words, m.paired.inks], hostOver: m.held.hostOver, strays: m.r.strays });
	expect({ crosses: (m.held.hostOverStrokes ?? []).length, kids: live?.spanKids ?? null, cutKids: cut?.spanKids ?? null },
		`premise: ${name}: one host cross on Pdfbelow (${JSON.stringify(m.held.hostOver)}), the view out of the span once the zoom's build is done and in it when the string is taken`).toEqual({ crosses: 2, kids: 2, cutKids: 0 });
	expect(grew !== null && grew > 100, `premise: ${name}: the late view moves Pdfbelow down its block on the page after the zoom's build: ${grew} css px, over 100`).toBe(true);
	expect(placed !== null && Math.abs(placed) <= PDF_BAR, `premise: ${name}: the page holds Pdfbelow in its block where its cross was placed (the view in at both reads): ${placed} css px, within ${PDF_BAR}`).toBe(true);
	expect({ live: live?.strip ?? null, parsed: parsed?.strip ?? null }, `${name}: Pdfbelow's block holds the host's strip, on the page when the string is taken and after the parse`).toEqual({ live: true, parsed: true });
	expect(withinBar(below) ? [] : [`Pdfbelow against its strip, the parse less the page: ${JSON.stringify(below)} css px at zf ${zf} (after the parse Pdfbelow in ${parsed?.belowParent}, ${parsed?.looseKids} loose; print row ${JSON.stringify(print)})`],
		`${name}: the host's cross on Pdfbelow, its word against its block's strip through the native parse, within ${PDF_BAR} css px`).toEqual([]);
	expect(printWord !== null && printWord.ink === 1 && near1(printWord.dx) && near1(printWord.dy),
		`${name}: the printed cross on Pdfbelow, its cross less its word within 1 page px, one blob in its window: ${JSON.stringify(printWord)}`).toBe(true);
	expect({ span: parsed?.spanKids ?? null, loose: parsed?.looseKids ?? null }, `${name}: after the parse the span still holds its 2 children, none loose in the block`).toEqual({ span: 2, loose: 0 });
	expect(m.held.swaps, `${name}: the export's print swaps: one for the zoom's build, at most one more for the late entry, then none`).toBeLessThanOrEqual(2);
	noErrors();
}, T);

// PDF-12 (e): one line with an inked note embed and a PDF embed, its viewer built, and host ink on the
// word after both (host block 2: "![[Embed look]] ![[Paper.pdf]] Pdfbelow notes"). The PDF embed's span holds divs and
// has no ink of its own, so its line is held for it: an inked embed in a line does not keep the line from being held.
// Checks: Pdfbelow against its block's strip through the parse (cap lifted) within the bar; the PDF span keeps its
// children; the inked embed's paragraphs against its content box (its ink layer's box), the parse less the page, within
// the bar, so its ink stays on its words. Red at base (the line is not held: the inked embed's divs and the PDF's close
// it), and red on a hold that passes over every line an inked embed sits in. Its printed row is logged only: on the
// phone the zoom's build moves Pdfbelow 24 px up its block from where its cross was placed (placed -24 at base), before
// any hold.
const MIXED_LINE = "![[Embed look]] ![[Paper.pdf]] Pdfbelow notes";
itA.each(OVER_DEVICES)("PDF-12 (e) an inked note embed and a PDF embed in one line, %s: the host's cross on the word after both stays on it, and the inked embed's ink on its words", async (dev, column) => {
	const p = await pageFor(dev);
	const name = `PDF-12 (e) an inked note embed and a PDF embed in one line, ${dev}`;
	const side: Side = { kind: "pdf", at: "built", where: "inked" };
	const o: Opts = { blocks: EMB_HOST.map((b, i) => (i === 2 ? MIXED_LINE : b)), marks: EMB_HOST_MARKS, settings: { ...BASE }, attached: true, column,
		emb: { shape: "obsidian", anchored: true, hostOver: [], pdf: side } };
	const tokens = [...EMB_HOST_TOKENS, ...EMB_TOKENS_SHORT, "Pdfbelow"];
	const m = await embMobile(p, o, label(name), tokens);
	const { live, cut, parsed, zf, lifted, below, cappedBelow, placed, print } = await pdfReads(m, dev);
	const inkLive = m.held.embLive?.ink ?? null, inkParsed = lifted.emb.ink;
	const inkMoves = inkLive && inkParsed && inkLive.blocks.length === inkParsed.blocks.length
		? inkLive.blocks.map((b, i) => ({ dx: r2n((inkParsed.blocks[i]!.x - b.x) / zf), dy: r2n((inkParsed.blocks[i]!.y - b.y) / zf) })) : null;
	embLog("PDF-ROWS", name, { dev, column, zf, side, below, cappedBelow, placed, swaps: m.held.swaps, inkMoves, inkInSpan: { live: inkLive?.inSpan ?? null, parsed: inkParsed?.inSpan ?? null },
		live, cut, parsed, print, line: sideLineLog(m.held.lines?.side), paired: [m.paired.same, m.paired.words, m.paired.inks], hostOver: m.held.hostOver, strays: m.r.strays });
	expect({ crosses: (m.held.hostOverStrokes ?? []).length, live: live?.strip ?? null, parsed: parsed?.strip ?? null, kids: live?.spanKids ?? null, cutKids: cut?.spanKids ?? null, inkBlocks: inkLive?.blocks.length ?? 0 },
		`premise: ${name}: one host cross on Pdfbelow (${JSON.stringify(m.held.hostOver)}), the inked embed's block holds the host's strip on the page and after the parse, the PDF span holds its children, the inked view stands with its three paragraphs`)
		.toEqual({ crosses: 2, live: true, parsed: true, kids: 2, cutKids: 2, inkBlocks: 3 });
	expect(withinBar(below) ? [] : [`Pdfbelow against its strip, the parse (cap lifted) less the page: ${JSON.stringify(below)} css px at zf ${zf} (capped ${JSON.stringify(cappedBelow)}; after the parse Pdfbelow in ${parsed?.belowParent}, the span in ${parsed?.spanParent} holding ${parsed?.spanKids}, ${parsed?.looseKids} loose; print row ${JSON.stringify(print)})`],
		`${name}: the host's cross on Pdfbelow, its word against its block's strip through the native parse, within ${PDF_BAR} css px`).toEqual([]);
	expect({ span: parsed?.spanKids ?? null, loose: parsed?.looseKids ?? null }, `${name}: after the parse the PDF span still holds its 2 children, none loose in the block`).toEqual({ span: 2, loose: 0 });
	expect(inkMoves !== null && inkMoves.every(withinBar),
		`${name}: the inked embed's paragraphs against its content box, the parse less the page: ${JSON.stringify(inkMoves)} css px, within ${PDF_BAR}`).toBe(true);
	expect(m.held.swaps, `${name}: the export's print swaps: one for the zoom's build, then none`).toBeLessThanOrEqual(1);
	noErrors();
}, T);

// I641-1 cell a: content that takes height enters an inked note embed after the zoom, above
// its inked words. The inked embed (Embed look, host block 2) holds a picture embed on its own line in its second
// paragraph, above Embedmid (the page's embGrow): out at the zoom's build, its img (100 px tall) in after that build and
// before the string is taken. The embed's crosses are placed from the page with the img in, as the screen the ink was
// drawn on holds it. The read (GROW_GEOM), in the string loaded with scripts off at the device's width and the page's
// content height, print media: each marked word of the embed (Embedfirst above the picture, Embedmid after it in its
// paragraph, Embedlate in the next one) against its cross in the embed's ink layer: the cross's row (its across stroke's
// centre) less the word's row (its centre), css px, within PDF_BAR. Embedfirst sits above the growth, so its row is the
// read's own zero (a premise). Two ways: no host ink; host ink on Hostafter (host block 3, the block after the embed's),
// where Hostafter against its block's strip, the parse less the zoom's build, keeps the same bar. Tablet. The printed
// rows are logged, not asserted.
interface GrowRow { word: { x: number; y: number } | null; cross: { x: number; y: number } | null }
interface GrowGeom {
	layer: boolean; shown: boolean; paths: number; marks: GrowRow[]; spanKids: number | null; spanH: number | null;
	/** Hostafter (#m0) against its block's strip, px as laid out, and the strip's own cross less the word. */
	host: { strip: boolean; rel: { x: number; y: number } | null } | null;
}
/**
 * The inked embed's marked words (e0 to e2) and its ink layer's crosses (paths 2k and 2k+1: the across and the down
 * stroke of cross k, in stroke order), px from its content box as laid out (zoomed); the picture's span; Hostafter
 * against its block's strip. A string expression, so it runs in the app page and in the string loaded with scripts off.
 */
const GROW_GEOM = `(() => {
	const r2 = v => Math.round(v * 100) / 100;
	const view = document.querySelector('.print [data-probe="emb-ink"]');
	if (!view) return null;
	const box = view.parentElement, cr = box.getBoundingClientRect();
	const layer = box.querySelector(":scope > svg.handwriting-embed-ink");
	const paths = layer ? [...layer.querySelectorAll("path")] : [];
	const mid = r => ({ x: r2(r.left + r.width / 2 - cr.left), y: r2(r.top + r.height / 2 - cr.top) });
	const marks = [0, 1, 2].map(k => {
		const w = view.querySelector("#e" + k), h = paths[2 * k], v = paths[2 * k + 1];
		const hr = h ? h.getBoundingClientRect() : null, vr = v ? v.getBoundingClientRect() : null;
		return { word: w ? mid(w.getBoundingClientRect()) : null, cross: hr && vr ? { x: mid(vr).x, y: mid(hr).y } : null };
	});
	const span = document.querySelector('.print [data-probe="emb-grow"]');
	const root = document.querySelector(".print > .markdown-preview-view");
	const hw = document.querySelector(".print #m0");
	let host = null;
	if (hw && root) {
		let b = hw;
		while (b && b.parentElement !== root) b = b.parentElement;
		const strip = b ? b.querySelector(":scope > svg.handwriting-embed-ink-strip") : null;
		const sr = strip ? strip.getBoundingClientRect() : null, r = hw.getBoundingClientRect();
		host = { strip: !!strip, rel: sr ? { x: r2(r.left - sr.left), y: r2(r.top - sr.top) } : null };
	}
	return { layer: !!layer, shown: !!layer && getComputedStyle(layer).display !== "none", paths: paths.length, marks,
		spanKids: span ? span.children.length : null, spanH: span ? r2(span.getBoundingClientRect().height) : null, host };
})()`;
/** The string loaded as the native side loads it (scripts off), read in print media at the device's width and the page's content height. */
async function growParse(html: string, width: number): Promise<GrowGeom | null> {
	const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: PAGE_CONTENT_H } });
	try {
		const p = await ctx.newPage();
		await p.setContent(html);
		await p.emulateMedia({ media: "print" });
		return (await p.evaluate(GROW_GEOM)) as GrowGeom | null;
	} finally {
		await ctx.close();
	}
}
/** Each embed row of one read: the word's row (want), its cross's row (got), got less want, and across; css px (z: the read's zoom). */
const growRows = (g: GrowGeom | null | undefined, z: number) => EMB_TOKENS_SHORT.map((t, k) => {
	const row = g?.marks[k], w = row?.word ?? null, c = row?.cross ?? null;
	const want = w ? r2n(w.y / z) : null, got = c ? r2n(c.y / z) : null;
	return { t, want, got, delta: want !== null && got !== null ? r2n(got - want) : null, dx: w && c ? r2n((c.x - w.x) / z) : null };
});
const GROW_WAYS: Array<[string, Mark[]]> = [["no host ink", []], ["host ink on Hostafter, the block after the embed", [{ block: 3, word: 0 }]]];
itA.each(GROW_WAYS)("I641-1 cell a, %s, tablet: content that takes height enters an inked note embed after the zoom, above its inked words; each of its ink rows on its word through the native parse", async (way, marks) => {
	const p = await pageFor("tablet");
	const name = `I641-1 cell a, ${way}, tablet`;
	const o: Opts = { blocks: EMB_HOST, marks, settings: { ...BASE }, attached: true, column: TABLET.column, emb: { shape: "obsidian", anchored: true, grow: true } };
	const hostInk = marks.length > 0;
	const tokens = [...(hostInk ? ["Hostafter"] : []), ...EMB_TOKENS_SHORT];
	const m = await embMobile(p, o, label(name), tokens);
	const zf = m.held.zf;
	const parsed = await growParse(m.html, TABLET.width);
	const place = m.held.growPlace ?? null, atBuild = m.held.growAtBuild ?? null, live = m.held.growLive ?? null;
	const rows = growRows(parsed, zf);
	const midAt = (g: GrowGeom | null, z: number) => (g?.marks[1]?.word ? r2n(g.marks[1].word.y / z) : null);
	const grew = midAt(live, zf) !== null && midAt(atBuild, zf) !== null ? r2n(midAt(live, zf)! - midAt(atBuild, zf)!) : null;
	const hostRel = (g: GrowGeom | null) => g?.host?.rel ?? null;
	const hostMove = hostRel(atBuild) && hostRel(parsed) ? { dx: r2n((hostRel(parsed)!.x - hostRel(atBuild)!.x) / zf), dy: r2n((hostRel(parsed)!.y - hostRel(atBuild)!.y) / zf) } : null;
	const print = tokens.map(t => (w => ({ t, page: w ? w.page + 1 : null, dx: w?.dx ?? null, dy: w?.dy ?? null, ink: w?.ink ?? 0 }))(m.r.words.find(x => x.token === t)));
	embLog("GROW-ROWS", name, { zf, grew, swaps: m.held.swaps, parse: rows, live: growRows(live, zf), atBuild: growRows(atBuild, zf), place: growRows(place, 1),
		span: { place: place?.spanKids ?? null, atBuild: atBuild?.spanKids ?? null, live: live?.spanKids ?? null, parse: parsed?.spanKids ?? null, h: parsed?.spanH ?? null },
		layer: { live: live ? [live.layer, live.shown, live.paths] : null, parse: parsed ? [parsed.layer, parsed.shown, parsed.paths] : null },
		host: { atBuild: atBuild?.host ?? null, live: live?.host ?? null, parse: parsed?.host ?? null, move: hostMove }, print, strays: m.r.strays });
	expect({ layer: parsed?.layer ?? null, shown: parsed?.shown ?? null, paths: parsed?.paths ?? null, place: place?.spanKids ?? null, atBuild: atBuild?.spanKids ?? null, live: live?.spanKids ?? null, parse: parsed?.spanKids ?? null },
		`premise: ${name}: the embed's ink layer stands and shows in the parse with its 6 strokes, and the picture's img is in its span where the crosses are placed, out once the zoom's build is done, in when the string is taken and after the parse`)
		.toEqual({ layer: true, shown: true, paths: 6, place: 1, atBuild: 0, live: 1, parse: 1 });
	expect(grew !== null && grew > 50, `premise: ${name}: the late img moves Embedmid down the embed's content box after the zoom's build: ${grew} css px, over 50`).toBe(true);
	const first = rows[0]!;
	expect(first.delta !== null && Math.abs(first.delta) <= PDF_BAR,
		`premise: ${name}: Embedfirst, above the growth, the read's own zero: its cross's row less its word's row through the parse: ${JSON.stringify(first)} css px, within ${PDF_BAR}`).toBe(true);
	if (hostInk) {
		expect({ atBuild: atBuild?.host?.strip ?? null, parse: parsed?.host?.strip ?? null }, `premise: ${name}: Hostafter's block holds the host's strip once the zoom's build is done and after the parse`).toEqual({ atBuild: true, parse: true });
		expect(withinBar(hostMove) ? [] : [`Hostafter against its block's strip, the parse less the zoom's build: ${JSON.stringify(hostMove)} css px at zf ${zf}`],
			`${name}: the host's strip on Hostafter keeps its own ${PDF_BAR} css px`).toEqual([]);
	}
	expect(rows.filter(r => r.delta === null || Math.abs(r.delta) > PDF_BAR).map(r => `${r.t}: want ${r.want}, got ${r.got}, delta ${r.delta} css px`),
		`${name}: each of the embed's ink rows on its word's row through the native parse, within ${PDF_BAR} css px (zf ${zf}, grew ${grew})`).toEqual([]);
	expect(m.held.swaps, `${name}: the export's print swaps: one for the zoom's build, at most one more for the late entry, then none`).toBeLessThanOrEqual(2);
	noErrors();
}, T);

// ---- Host ink in the inked embed's block, phone and tablet: the line held, the host's ink on its words. ----
//
// EMB-L: host block 2 holds the inked embed (Embed look) and a host cross anchored to block 2's line. Four shapes: (a)
// Inkpast, the line run on past the span; (b) Underword, on the line under the embed in its paragraph (a br); (c) the
// cross over Embedmid, the embed's own word; (d) nested: the inked embed on the second line of a no-ink embed's note
// (Outer look, host block 2), its line run on past its span to Inkpast inside the outer embed. The cross is placed in two
// passes, with no wait: pass one exports the page with the word and no host cross in block 2 (no hold walks that block)
// and reads the word's place in it once the zoom's build has laid the root out at the column width; pass two draws the
// cross there. Read before that build, the place is the page at the device's width, a row off on the phone, where the
// root re-wraps at the column. The bounds, one list: a, the inked embed's line held, a div on the page and in the string
// with its computed margins inline; b, the cross's ink box on its word after the native parse within PDF_BAR across and
// down (a hold that moved the line on the page fails here, where the word against its strip reads 0); c, the embed's own
// rows (each its cross's less its word's), the parse less the page, within PDF_BAR, and its ink layer as in pass one:
// the layer's top in its content box after the parse, and its markup in the string. Pass one has no host ink in the
// inked embed's block, so its string is the one EMB-D holds byte-equal to base (its sha256 is logged for that compare):
// c is the layer as at base. Logged: the word against its strip, the parse less the page; the layer's sha256 and top.
// Nested, a premise: the outer embed's line is a div on the page and in the string (held for the outer span, base too).
// Red at base on a and b (the inked embed's line is a p, and the parse drops the words under the embed's title 8 px
// under the strip).
//
// EMB-D: no host ink in the inked embed's block (host ink in the other blocks; none at all). The line stays a p with no
// margins written on it, the embed's own rows hold, and the export string's sha256 is logged (two runs, one string) for
// the base-to-tip compare. Green at base.
interface InkRel {
	block: number; strips: number; parent: string | null; x: number | null; y: number | null; w: number; h: number;
	paths: Array<{ x0: number; y0: number; x1: number; y1: number }>;
}
interface InkLineGeom { word: InkRel | null; controls: Array<InkRel | null>; layer: { top: number; html: string } | null; print: boolean; vh: number }
/**
 * One marked word of the export root (id) against the one host strip in its own block, zoomed px: its box's top-left
 * less the strip's, and every path's box in that strip against the strip's (one path per pen stroke, in the strip's
 * order); the host's marks m0 to m2 likewise, the read's controls; the inked embed's ink layer, its top less its content
 * box's (zoomed px) and its markup. A function's source, so it runs in the app page and in the string loaded with
 * scripts off.
 */
const INK_LINE_GEOM = `((id) => {
	const r2 = v => Math.round(v * 100) / 100;
	const root = document.querySelector(".print > .markdown-preview-view");
	if (!root) return null;
	const blocks = [...root.children].filter(c => c.tagName !== "H1" && c.tagName !== "CANVAS" && c.namespaceURI === "http://www.w3.org/1999/xhtml");
	const rel = (wid) => {
		const w = root.querySelector("#" + wid);
		let b = w;
		while (b && b.parentElement !== root) b = b.parentElement;
		if (!w || !b) return null;
		const strips = [...b.querySelectorAll(":scope > svg.handwriting-embed-ink-strip")];
		const s = strips.length === 1 ? strips[0] : null;
		const wr = w.getBoundingClientRect(), sr = s ? s.getBoundingClientRect() : null;
		const paths = s && sr ? [...s.querySelectorAll("path")].map(p => { const r = p.getBoundingClientRect();
			return { x0: r2(r.left - sr.left), y0: r2(r.top - sr.top), x1: r2(r.right - sr.left), y1: r2(r.bottom - sr.top) }; }) : [];
		return { block: blocks.indexOf(b), strips: strips.length, parent: w.parentElement ? w.parentElement.tagName : null,
			x: sr ? r2(wr.left - sr.left) : null, y: sr ? r2(wr.top - sr.top) : null, w: r2(wr.width), h: r2(wr.height), paths };
	};
	const view = document.querySelector('.print [data-probe="emb-ink"]');
	const box = view ? view.parentElement : null, l = box ? box.querySelector(":scope > svg.handwriting-embed-ink") : null;
	const layer = l ? { top: r2(l.getBoundingClientRect().top - box.getBoundingClientRect().top), html: l.outerHTML } : null;
	return { word: rel(id), controls: ["m0", "m1", "m2"].map(rel), layer, print: matchMedia("print").matches, vh: innerHeight };
})`;
/** The string loaded as the native side loads it (scripts off), read in print media at the device's width and the page's content height. */
async function inkLineParse(html: string, width: number, id: string): Promise<{ geom: InkLineGeom | null; rows: GrowGeom | null }> {
	const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: PAGE_CONTENT_H } });
	try {
		const p = await ctx.newPage();
		await p.setContent(html);
		await p.emulateMedia({ media: "print" });
		return { geom: (await p.evaluate(`${INK_LINE_GEOM}(${JSON.stringify(id)})`)) as InkLineGeom | null, rows: (await p.evaluate(GROW_GEOM)) as GrowGeom | null };
	} finally {
		await ctx.close();
	}
}
/** The cross's ink box (its block's strip's two paths) less its word's centre, css px; null when a read is missing or the strip holds another count. */
function crossOnWord(w: InkRel | null | undefined, zf: number) {
	if (!w || w.x === null || w.y === null || w.paths.length !== 2) return null;
	const x0 = Math.min(...w.paths.map(q => q.x0)), x1 = Math.max(...w.paths.map(q => q.x1));
	const y0 = Math.min(...w.paths.map(q => q.y0)), y1 = Math.max(...w.paths.map(q => q.y1));
	return { cx: r2n(((x0 + x1) / 2 - (w.x + w.w / 2)) / zf), cy: r2n(((y0 + y1) / 2 - (w.y + w.h / 2)) / zf) };
}
/** The embed's own rows (growRows: each its cross's less its word's), the parse less the page, css px. */
function rowMoves(page: GrowGeom | null | undefined, parse: GrowGeom | null | undefined, zf: number) {
	const a = growRows(page, zf), b = growRows(parse, zf);
	return a.map((r, k) => { const q = b[k]!;
		return { t: r.t, dy: r.delta !== null && q.delta !== null ? r2n(q.delta - r.delta) : null, dx: r.dx !== null && q.dx !== null ? r2n(q.dx - r.dx) : null }; });
}
const rowsHold = (m: ReturnType<typeof rowMoves>) => m.length === 3 && m.every(r => r.dy !== null && r.dx !== null && Math.abs(r.dy) <= PDF_BAR && Math.abs(r.dx) <= PDF_BAR);
const sha256 = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), b => b.toString(16).padStart(2, "0")).join("");
const inkLineOpts = (after: InkAfter, text: string, column: number, place: InkLine["place"], marks: Mark[] = EMB_HOST_MARKS, nested = false): Opts => ({
	blocks: EMB_HOST.map((b, i) => (i === 2 ? text : b)), marks, settings: { ...BASE }, attached: true, column,
	emb: { shape: "obsidian", anchored: true, hostOver: [], inkLine: { after, place }, ...(nested ? { nested: true } : {}) } });
/** How far the embed's ink layer's top in its content box may stand from pass one's after the parse, css px: two reads, each rounded to 0.01. */
const LAYER_BAR = 0.02;
const INK_LINE_CASES: Array<[string, InkAfter, string, boolean]> = [
	["EMB-L (a) Inkpast, on the inked embed's own line after its span", "same", EMB_INKED_LINE, false],
	["EMB-L (b) Underword, on the line under the inked embed in its paragraph", "under", "![[Embed look]] Underword closes the inked embed's paragraph", false],
	["EMB-L (c) host ink over Embedmid, the inked embed's own word", "over", "![[Embed look]]", false],
	["EMB-L (d) nested, Inkpast after the inked embed inside a no-ink embed's note", "same", "![[Outer look]]", true],
];
const INK_LINE_RUNS = INK_LINE_CASES.flatMap(([name, after, text, nested]) =>
	OVER_DEVICES.map(([dev, column]): [string, InkAfter, string, boolean, "tablet" | "phone", number] => [`${name}, ${dev}`, after, text, nested, dev, column]));
itA.each(INK_LINE_RUNS)("%s: the line held, the host's cross on its word through the native parse, the embed's own ink on its words", async (name, after, text, nested, dev, column) => {
	const p = await pageFor(dev);
	const width = (dev === "phone" ? PHONE : TABLET).width;
	const id = after === "over" ? "e1" : "hl0";
	const first = await replay(p, inkLineOpts(after, text, column, null, EMB_HOST_MARKS, nested));
	const place = first.inkLine?.place ?? null;
	const held = await replay(p, inkLineOpts(after, text, column, place, EMB_HOST_MARKS, nested));
	const zf = held.zf, il = held.inkLine ?? null, ink = held.lines?.ink ?? null;
	const parsed = await inkLineParse(held.html, width, id), firstParsed = await inkLineParse(first.html, width, id);
	const a = il?.geom?.word ?? null, b = parsed.geom?.word ?? null;
	const pageInk = crossOnWord(a, zf), parseInk = crossOnWord(b, zf);
	const split = a?.y != null && b?.y != null ? r2n((b.y - a.y) / zf) : null;
	const controls = (il?.geom?.controls ?? []).map((c, k) => { const d = parsed.geom?.controls[k] ?? null;
		return { k, strips: [c?.strips ?? null, d?.strips ?? null], dy: c?.y != null && d?.y != null ? r2n((d.y - c.y) / zf) : null }; });
	const rows = rowMoves(il?.rows, parsed.rows, zf);
	// The embed's ink layer, pass one (no host ink in its block: the string as at base) and pass two: its markup on the page
	// and in the string after the parse (sha256), and its top in its content box after the parse, css px.
	const layerOf = async (g: InkLineGeom | null, page: string | null | undefined, z: number) =>
		({ page: page ? await sha256(page) : null, parse: g?.layer ? await sha256(g.layer.html) : null, top: g?.layer ? r2n(g.layer.top / z) : null });
	const layer = { first: await layerOf(firstParsed.geom, first.inkLine?.layer, first.zf), held: await layerOf(parsed.geom, il?.layer, zf) };
	const layerTop = layer.first.top !== null && layer.held.top !== null ? r2n(layer.held.top - layer.first.top) : null;
	const fails: string[] = [];
	if (!(ink?.live?.tag === "DIV" && ink.clone?.tag === "DIV" && JSON.stringify(ink.margins.inline) === JSON.stringify(ink.margins.before)))
		fails.push(`a: the line on the page a ${ink?.live?.tag}, in the string a ${ink?.clone?.tag}, inline margins ${JSON.stringify(ink?.margins.inline ?? null)} (computed ${JSON.stringify(ink?.margins.before ?? null)})`);
	if (!(parseInk && Math.abs(parseInk.cx) <= PDF_BAR && Math.abs(parseInk.cy) <= PDF_BAR))
		fails.push(`b: the cross's ink box less its word after the parse ${JSON.stringify(parseInk)} css px (on the page ${JSON.stringify(pageInk)}; the word against its strip, the parse less the page, ${split}; after the parse the word in a ${b?.parent})`);
	if (!rowsHold(rows)) fails.push(`c: the embed's own rows, the parse less the page: ${JSON.stringify(rows)} css px`);
	if (!(layerTop !== null && Math.abs(layerTop) <= LAYER_BAR))
		fails.push(`c: the embed's ink layer's top in its content box after the parse, less pass one's: ${layerTop} css px (${layer.held.top}, pass one ${layer.first.top})`);
	if (!(layer.held.parse !== null && layer.held.parse === layer.first.parse && layer.held.page === layer.first.page))
		fails.push(`c: the embed's ink layer's markup, in the string after the parse and on the page, not pass one's: ${JSON.stringify(layer)}`);
	embLog("INK-LINE", name, { dev, column, zf, zfFirst: first.zf, after, nested, place, atZoom: il?.atZoom ?? null, at: il?.at ?? null, placeAtString: il?.place ?? null,
		pageInk, parseInk, split, controls, rows, layer, layerTop, firstSha: await sha256(first.html), swaps: held.swaps, fails,
		line: { live: ink?.live?.tag ?? null, clone: ink?.clone?.tag ?? null, margins: ink?.margins ?? null, strip: ink?.strip ?? null, drew: ink?.drew ?? null, outer: ink?.outer ?? null },
		word: { page: a, parse: b }, read: { print: parsed.geom?.print ?? null, vh: parsed.geom?.vh ?? null } });
	expect({ place: place !== null, crosses: il?.strokes ?? null, zoom: held.zf === first.zf, strip: ink?.strip ?? null, drew: ink?.drew ?? null,
		block: [a?.block ?? null, b?.block ?? null], strips: [a?.strips ?? null, b?.strips ?? null], paths: [a?.paths.length ?? null, b?.paths.length ?? null] },
		`premise: ${name}: pass one read the word's place (${JSON.stringify(place)}), pass two drew one host cross there at the same zoom (${first.zf}, ${held.zf}), host block 2 holds one host strip of two paths on the page and after the parse, and the inked embed drew its ink`)
		.toEqual({ place: true, crosses: 2, zoom: true, strip: true, drew: true, block: [2, 2], strips: [1, 1], paths: [2, 2] });
	expect(pageInk !== null && Math.abs(pageInk.cx) <= 1 && Math.abs(pageInk.cy) <= 1,
		`premise: ${name}: on the page when the string is taken the cross's ink box is on its word within 1 css px: ${JSON.stringify(pageInk)}`).toBe(true);
	expect({ print: parsed.geom?.print ?? null, vh: parsed.geom?.vh ?? null }, `premise: ${name}: the parse read in print media at the page's content height`)
		.toEqual({ print: true, vh: PAGE_CONTENT_H });
	expect(controls.filter(c => c.strips[0] !== 1 || c.strips[1] !== 1 || c.dy === null || Math.abs(c.dy) > PDF_BAR),
		`premise: ${name}: the controls, Hostfirst, Hostlast and Hostafter against their own blocks' strips, the parse less the page, within ${PDF_BAR} css px`).toEqual([]);
	if (nested) {
		expect(ink?.outer ?? null, `premise: ${name}: the no-ink embed's line, holding the inked one, a div on the page and in the string`).toEqual(["DIV", "DIV"]);
	}
	noErrors();
	expect(fails, `${name}: the line held (a), the host's cross on its word through the native parse within ${PDF_BAR} css px (b), the embed's own rows and its ink layer as in pass one (c)`).toEqual([]);
}, T);

const INK_QUIET_WAYS: Array<[string, Mark[]]> = [["host ink in the other blocks, none in the inked embed's", EMB_HOST_MARKS], ["no host ink at all", []]];
const INK_QUIET_RUNS = INK_QUIET_WAYS.flatMap(([way, marks]) =>
	OVER_DEVICES.map(([dev, column]): [string, Mark[], "tablet" | "phone", number] => [`EMB-D ${way}, ${dev}`, marks, dev, column]));
itA.each(INK_QUIET_RUNS)("%s: the inked embed's line a p with nothing written on it, the embed's own ink on its words, the export string logged", async (name, marks, dev, column) => {
	const p = await pageFor(dev);
	const width = (dev === "phone" ? PHONE : TABLET).width;
	const o = inkLineOpts("same", EMB_INKED_LINE, column, null, marks);
	const one = await replay(p, o), two = await replay(p, o);
	const sha = { one: await sha256(one.html), two: await sha256(two.html) };
	const ink = one.lines?.ink ?? null, il = one.inkLine ?? null;
	const parsed = await inkLineParse(one.html, width, "hl0");
	const rows = rowMoves(il?.rows, parsed.rows, one.zf);
	embLog("INK-QUIET", name, { dev, column, zf: one.zf, sha, bytes: one.html.length, lineSha: ink?.clone ? await sha256(ink.clone.html) : null,
		layerSha: il?.layer ? await sha256(il.layer) : null, rows, swaps: one.swaps,
		layerParse: parsed.geom?.layer ? { top: r2n(parsed.geom.layer.top / one.zf), sha: await sha256(parsed.geom.layer.html) } : null,
		line: { live: ink?.live?.tag ?? null, clone: ink?.clone?.tag ?? null, margins: ink?.margins ?? null, strip: ink?.strip ?? null, drew: ink?.drew ?? null } });
	expect({ strip: ink?.strip ?? null, drew: ink?.drew ?? null, crosses: il?.strokes ?? null, same: sha.one === sha.two },
		`premise: ${name}: no host strip in the inked embed's block, the inked embed drew its ink, no host cross on its line, and two runs give one export string`)
		.toEqual({ strip: false, drew: true, crosses: 0, same: true });
	expect({ live: ink?.live?.tag ?? null, clone: ink?.clone?.tag ?? null, inline: ink?.margins.inline ?? null },
		`${name}: the inked embed's line a p on the page and in the string, no margins written on it`).toEqual({ live: "P", clone: "P", inline: ["", ""] });
	expect(rowsHold(rows), `${name}: the embed's own rows, the parse less the page: ${JSON.stringify(rows)} css px, within ${PDF_BAR}`).toBe(true);
	noErrors();
}, T);

// ---- HELD: a paragraph the export held as a div keeps its rows at a later build. ----
// The page's rowsExport: the export root's blocks as the reading view renders them, attached as an export attaches
// (no section info, the note's cached sections). The bound's paragraph: four source lines with single line feeds (text,
// text, a no-ink PDF embed, text), one p with the breaks as br, host ink on lines two and four (Rowtwo, Rowfour), each
// cross anchored to its own line as the editor anchors free ink, placed from the page as the screen the ink was drawn on
// holds it. Read (ROWS_GEOM) in the string loaded with scripts off at the device's width and the page's content height,
// print media, with the app's print cap on a PDF embed lifted (PDF_CAP_LIFT, the escape alone; the capped read is
// logged): each cross's row (its across stroke's centre) less its word's row (its centre), css px, within PDF_BAR.
// a: a build after the hold, from late height in a later block (a picture's img in after the zoom's build, a block
// after it). b: the late height the held embed's own (a Bases view's rows, 120 px, in after the build; a PDF embed's
// span is 800 px by the app's rule whatever its viewer holds, so its own content takes no height). c: no build after
// the hold. d: a div no hold wrote, with a p's attributes and its margins inline (R3B-6), is no row host, in the export,
// on screen and in a desktop export's beforeprint. The break read's finds: R3B-1 ink on the embed's own line (logged
// only), R3B-2 the paragraph a direct root child, R3B-3 a loose list and a quote whose lines are held, R3B-4 two held
// paragraphs, the second held at the late look and a build after both, R3B-5 the plain export (no late content), whose
// layer watch's replace after the zoom's build is a build after the hold.
interface RowsMark { id: string; line: number; host: string | null; word: { x: number; y: number }; cross: { x: number; y: number } | null; wordBlock: number; crossBlock: number; copies: number }
interface RowsGeom { zf: number; marks: RowsMark[]; blockTops: number[]; blocks: string[]; spans: Array<{ kids: number; h: number; parent: string }>; strips: number }
interface RowsBlockRead { lineStart: number; lineEnd: number; box: { top: number; height: number } | null; rows: { kind: string; count: number } | null; tops: Array<number | null> }
interface RowsHeld {
	html: string; zf: number; swaps: number; place: RowsGeom | null; atBuild: RowsGeom | null; live: RowsGeom | null;
	/** The page, its string and the print swaps once the zoom's build is done, before any later build (rowsExport); the strips it cut. */
	atZoom: RowsGeom | null; htmlAtZoom: string; swapsAtZoom: number; stripsAtZoom: number;
	measureAtBuild: RowsBlockRead[] | null; measure: RowsBlockRead[] | null; rebuilt: boolean; strokes: number;
}
type RowsLine = string | { embed: "pdf" | "bases" | "picture"; late?: number; grow?: number; ink?: boolean } | { img: true; ink?: boolean; wide?: boolean };
interface RowsBlock { t: "text" | "p" | "quote" | "list" | "look" | "pic"; lines?: RowsLine[]; items?: RowsLine[][]; bare?: boolean; late?: number }
/**
 * Each marked word (its text; "embed" for an inked embed's line) and its cross (the widest path of its colour in any
 * strip: the across stroke), client px as laid out (zoomed); each root child's tag and its first child's, and its top
 * from the root's; each embed span's children, height and parent. An inked embed's word is 100 css px into its span. A
 * string expression: it runs in the app page and in the string loaded with scripts off.
 */
const ROWS_GEOM = `(() => {
	const r2 = v => Math.round(v * 100) / 100;
	const div = document.querySelector("body > .print"), root = document.querySelector(".print > .markdown-preview-view");
	if (!div || !root) return null;
	const zf = (parseFloat(getComputedStyle(div).zoom) || 1) * (parseFloat(getComputedStyle(root).zoom) || 1);
	const kids = [...root.children].filter(c => !c.matches("canvas.handwriting-embed-ink, svg.handwriting-embed-ink")), rt = root.getBoundingClientRect().top;
	const blockOf = el => { let b = el; while (b && b.parentElement !== root) b = b.parentElement; return b ? kids.indexOf(b) : -1; };
	const marks = [...root.querySelectorAll("[data-rows-ink]")].map(w => {
		const color = w.getAttribute("data-rows-ink"), dy = w.getAttribute("data-rows-dy"), r = w.getBoundingClientRect();
		let best = null, at = -1, copies = 0;
		for (const p of root.querySelectorAll('svg.handwriting-embed-ink-strip path[fill="' + color + '"]')) {
			const pr = p.getBoundingClientRect();
			if (!(pr.width > 0)) continue;
			copies++;
			if (best && pr.width <= best.width) continue;
			best = pr;
			at = blockOf(p);
		}
		return { id: w.classList.contains("mark-word") ? w.textContent : "embed", line: Number(w.getAttribute("data-rows-line")),
			host: w.parentElement ? w.parentElement.tagName : null,
			word: { x: r2(dy === null ? r.left + r.width / 2 : r.left + 100 * zf), y: r2(dy === null ? r.top + r.height / 2 : r.top + Number(dy) * zf) },
			cross: best ? { x: r2(best.left + best.width / 2), y: r2(best.top + best.height / 2) } : null, wordBlock: blockOf(w), crossBlock: at, copies };
	});
	return { zf, marks, blockTops: kids.map(c => r2(c.getBoundingClientRect().top - rt)),
		blocks: kids.map(c => c.tagName + (c.firstElementChild ? ">" + c.firstElementChild.tagName : "")),
		spans: [...root.querySelectorAll('[data-probe="rows-embed"]')].map(s => ({ kids: s.children.length, h: r2(s.getBoundingClientRect().height), parent: s.parentElement ? s.parentElement.tagName : "" })),
		strips: root.querySelectorAll("svg.handwriting-embed-ink-strip").length };
})()`;
/** The string loaded as the native side loads it (scripts off), print media, the device's width, the page's content height; lift: PDF_CAP_LIFT in its head. */
async function rowsParse(html: string, width: number, lift: boolean): Promise<RowsGeom | null> {
	const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: PAGE_CONTENT_H } });
	try {
		const p = await ctx.newPage();
		await p.setContent(lift ? html.replace("</head>", `${PDF_CAP_LIFT}</head>`) : html);
		await p.emulateMedia({ media: "print" });
		return (await p.evaluate(ROWS_GEOM)) as RowsGeom | null;
	} finally {
		await ctx.close();
	}
}
/** Each mark of one read: its word's row (want), its cross's row (got), got less want, and across; css px at the read's own zoom. */
const rowRows = (g: RowsGeom | null | undefined) => (g?.marks ?? []).map(m => {
	const want = r2n(m.word.y / g!.zf), got = m.cross ? r2n(m.cross.y / g!.zf) : null;
	return { id: m.id, line: m.line, want, got, delta: got !== null ? r2n(got - want) : null, dx: m.cross ? r2n((m.cross.x - m.word.x) / g!.zf) : null,
		host: m.host, wordBlock: m.wordBlock, crossBlock: m.crossBlock };
});
type RowRow = ReturnType<typeof rowRows>[number];
const offRow = (r: RowRow) => r.delta === null || Math.abs(r.delta) > PDF_BAR;
const rowLines = (rows: RowRow[]) => rows.map(r => `${r.id} (line ${r.line}): want ${r.want}, got ${r.got}, delta ${r.delta} css px`);
/** How far the late content moved the root's blocks down after the zoom's build, css px: the most any block moved. */
const rowsGrew = (h: RowsHeld) => {
	const a = h.atBuild?.blockTops ?? [], b = h.live?.blockTops ?? [];
	return a.length && a.length === b.length ? r2n(Math.max(...b.map((t, i) => (t - a[i]!) / (h.live?.zf ?? 1)))) : null;
};
/**
 * One export of `rows` on the device, and both reads of its string. at "zoom": the string taken once the zoom's build is
 * done, before any later build (c); else the string taken when the export takes it, after every late entry.
 */
async function rowsRun(dev: "tablet" | "phone", rows: RowsBlock[], extra: Record<string, unknown> = {}, at: "zoom" | "string" = "string") {
	const p = await pageFor(dev);
	const d = dev === "phone" ? PHONE : TABLET;
	const held = (await p.evaluate((x) => (window as unknown as { rowsExport(o: unknown): Promise<RowsHeld> }).rowsExport(x),
		{ column: d.column, settings: { ...BASE }, rows, ...extra })) as RowsHeld;
	const html = at === "zoom" ? held.htmlAtZoom : held.html;
	const lifted = await rowsParse(html, d.width, true), capped = await rowsParse(html, d.width, false);
	const live = at === "zoom" ? held.atZoom : held.live;
	return { held, at, page: live, lifted, capped, rows: rowRows(lifted), cappedRows: rowRows(capped), liveRows: rowRows(live), grew: rowsGrew(held) };
}
type RowsRun = Awaited<ReturnType<typeof rowsRun>>;
const rowsLog = (name: string, r: RowsRun, extra: Record<string, unknown> = {}) => embLog("HELD-ROWS", name, {
	at: r.at, zf: r.held.zf, swaps: r.held.swaps, swapsAtZoom: r.held.swapsAtZoom, stripsAtZoom: r.held.stripsAtZoom, rebuilt: r.held.rebuilt, grew: r.grew, strokes: r.held.strokes,
	parse: r.rows, capped: r.cappedRows, live: r.liveRows, atZoom: rowRows(r.held.atZoom), atBuild: rowRows(r.held.atBuild), place: rowRows(r.held.place),
	blocks: { live: r.page?.blocks ?? null, parse: r.lifted?.blocks ?? null },
	spans: { live: r.page?.spans ?? null, parse: r.lifted?.spans ?? null }, measure: r.held.measure, measureAtBuild: r.held.measureAtBuild, ...extra });
/**
 * The premises every held-paragraph run holds to: each mark's cross stands in a strip on the page when the string is
 * taken and after the parse, each embed span keeps its children through the parse, and each marked word on a held line
 * (`heldIds`) sits in a div on the page and after the parse.
 */
function expectRowsPremise(name: string, r: RowsRun, heldIds: string[]) {
	const crosses = (g: RowsGeom | null | undefined) => (g?.marks ?? []).map(m => [m.id, !!m.cross] as const);
	const want = crosses(r.page).map(([id]) => [id, true] as const);
	expect({ live: crosses(r.page), parse: crosses(r.lifted), any: want.length > 0 }, `premise: ${name}: each mark's cross in a strip, on the page and after the parse`)
		.toEqual({ live: want, parse: want, any: true });
	expect((r.lifted?.spans ?? []).map(s => s.kids), `premise: ${name}: each embed span keeps its children through the parse`).toEqual((r.page?.spans ?? []).map(s => s.kids));
	const hosts = (g: RowsGeom | null | undefined) => heldIds.map(id => g?.marks.find(m => m.id === id)?.host ?? null);
	expect({ live: hosts(r.page), parse: hosts(r.lifted) }, `premise: ${name}: the held lines' words (${heldIds.join(", ")}) in a div on the page and after the parse`)
		.toEqual({ live: heldIds.map(() => "DIV"), parse: heldIds.map(() => "DIV") });
}
const expectOnRows = (name: string, r: RowsRun) => expect(rowLines(r.rows.filter(offRow)),
	`${name}: each host cross on its word's row through the native parse (cap lifted), within ${PDF_BAR} css px (zf ${r.held.zf}, swaps ${r.held.swaps}, grew ${r.grew})`).toEqual([]);
const RW_TOP: RowsBlock = { t: "text", lines: ["Rowsfirst opens the host note above the held paragraph"] };
const RW_NEXT: RowsBlock = { t: "text", lines: ["Rowsnext closes the host note below"] };
const RW_PDF = { embed: "pdf" } as const;
/** The bound's paragraph: text, text, the embed's own line, text; ink on lines two and four. */
const rwPara = (embed: RowsLine, o: Partial<RowsBlock> = {}, w = "Row"): RowsBlock =>
	({ t: "p", lines: [`${w}one opens the held paragraph`, `*${w}two holds host ink on its first word`, embed, `*${w}four holds host ink after the embed`], ...o });
const rwPic = (late: number): RowsBlock => ({ t: "pic", late });
const RW_HELD = ["Rowtwo", "Rowfour"];

itA.each(OVER_DEVICES)("HELD a, %s: a held paragraph built again after the hold (late height in a later block): each host cross on its word's row through the parse", async (dev) => {
	const name = `HELD a, ${dev}`;
	const r = await rowsRun(dev, [RW_TOP, rwPara(RW_PDF), rwPic(1), RW_NEXT]);
	rowsLog(name, r);
	expectRowsPremise(name, r, RW_HELD);
	expect(r.grew !== null && r.grew > 50 && r.held.swaps >= 2, `premise: ${name}: the late img moves the blocks below it (${r.grew} css px, over 50) and the late look builds the root again (swaps ${r.held.swaps}, at least 2)`).toBe(true);
	expectOnRows(name, r);
	noErrors();
}, T);

itA.each(OVER_DEVICES)("HELD b, %s: a held paragraph built again after the hold (late height the held embed's own): each host cross on its word's row through the parse", async (dev) => {
	const name = `HELD b, ${dev}`;
	const r = await rowsRun(dev, [RW_TOP, rwPara({ embed: "bases", grow: 1 }), RW_NEXT]);
	rowsLog(name, r);
	expectRowsPremise(name, r, RW_HELD);
	const four = (g: RowsGeom | null | undefined) => g?.marks.find(m => m.id === "Rowfour")?.word.y ?? null;
	const moved = four(r.held.live) !== null && four(r.held.atBuild) !== null ? r2n((four(r.held.live)! - four(r.held.atBuild)!) / r.held.zf) : null;
	expect(moved !== null && moved > 100 && r.held.swaps >= 2, `premise: ${name}: the late rows move Rowfour down its paragraph (${moved} css px, over 100) and the late look builds the root again (swaps ${r.held.swaps}, at least 2)`).toBe(true);
	expectOnRows(name, r);
	noErrors();
}, T);

// c reads the string taken once the zoom's build is done, before any later build: in this harness the layer watch's
// replace follows every zoom's build (the build's own svg is a new child of the root, EmbedInkWatch's sync, then
// queueReplace), so the string the export takes 200 ms later is never one with no build after the hold. That plain
// export, its string taken when the export takes it, is R3B-5's.
itA.each(OVER_DEVICES)("HELD c, %s: a held paragraph with no build after the hold: each host cross on its word's row through the parse, as at base", async (dev) => {
	const name = `HELD c, ${dev}`;
	const r = await rowsRun(dev, [RW_TOP, rwPara(RW_PDF), RW_NEXT], {}, "zoom");
	rowsLog(name, r);
	expectRowsPremise(name, r, RW_HELD);
	expect({ swaps: r.held.swapsAtZoom, strips: r.held.stripsAtZoom > 0 }, `premise: ${name}: the string taken after one build, the zoom's, that cut strips and held the lines`).toEqual({ swaps: 1, strips: true });
	expectOnRows(name, r);
	noErrors();
}, T);

const RW_INK_WAYS: Array<[string, RowsBlock[]]> = [
	["no build after the hold", [RW_TOP, rwPara({ embed: "pdf", ink: true }), RW_NEXT]],
	["a build after the hold", [RW_TOP, rwPara({ embed: "pdf", ink: true }), rwPic(1), RW_NEXT]],
];
itA.each(RW_INK_WAYS)("HELD embed line, %s, tablet: host ink on the embed's own line, 100 px into the PDF span: each host cross on its word's row through the parse, the embed's on the span", async (way, rows) => {
	const name = `HELD embed line, ${way}, tablet`;
	const r = await rowsRun("tablet", rows);
	rowsLog(name, r, { embedLine: r.rows.find(x => x.id === "embed") ?? null });
	expectRowsPremise(name, r, RW_HELD);
	expect(r.rows.some(x => x.id === "embed"), `premise: ${name}: the embed's line has a cross`).toBe(true);
	expectOnRows(name, r);
	noErrors();
}, T);

// A plain picture (an img with no embed span) alone on its line: no hold (no embed), its rows read from the paragraph.
const RW_IMG_WAYS: Array<[string, RowsBlock[]]> = [
	["text then a plain picture, ink on the picture's line", [RW_TOP, { t: "p", lines: ["*Imgover holds host ink above the picture", { img: true, ink: true }] }, RW_NEXT]],
	["a plain picture then two text lines, ink on both", [RW_TOP, { t: "p", lines: [{ img: true }, "*Imgunder holds host ink under the picture", "*Imgthird holds host ink on line three"] }, RW_NEXT]],
];
itA.each(RW_IMG_WAYS)("ROWS plain picture, %s, tablet and phone: each host cross on its word's row through the parse", async (way, rows) => {
	for (const dev of ["tablet", "phone"] as const) {
		const name = `ROWS plain picture, ${way}, ${dev}`;
		const r = await rowsRun(dev, rows);
		rowsLog(name, r);
		expect(r.rows.length, `premise: ${name}: two crosses`).toBe(2);
		expectOnRows(name, r);
	}
	noErrors();
}, T);

// Both embed shapes, PDF and picture: a picture embed's own line, and either shape opening its paragraph with two text
// lines under it. No hold premise: the rows are read through the parse whether a hold wrote the paragraph or not.
const RW_EMB_WAYS: Array<[string, RowsBlock[], number]> = [
	["a picture embed's own line between text lines, ink on it and on the text", [RW_TOP, rwPara({ embed: "picture", ink: true }), RW_NEXT], 3],
	["a PDF embed then two text lines, ink on both", [RW_TOP, { t: "p", lines: [RW_PDF, "*Pdfunder holds host ink under the embed", "*Pdfthird holds host ink on line three"] }, RW_NEXT], 2],
	["a picture embed then two text lines, ink on both", [RW_TOP, { t: "p", lines: [{ embed: "picture" }, "*Picunder holds host ink under the embed", "*Picthird holds host ink on line three"] }, RW_NEXT], 2],
];
itA.each(RW_EMB_WAYS)("ROWS embed, %s, tablet and phone: each host cross on its word's row through the parse", async (way, rows, crosses) => {
	for (const dev of ["tablet", "phone"] as const) {
		const name = `ROWS embed, ${way}, ${dev}`;
		const r = await rowsRun(dev, rows);
		rowsLog(name, r);
		expect(r.rows.filter(x => x.got !== null).length, `premise: ${name}: ${crosses} crosses, each in a strip after the parse`).toBe(crosses);
		expectOnRows(name, r);
	}
	noErrors();
}, T);

/** The desktop print of rows: mounted and beforeprint, then print media and the page read as it prints, then afterprint. */
async function rowsDeskRun(rows: RowsBlock[], settings: Settings) {
	const p = await pageFor("tablet");
	const mounted = (await p.evaluate((x) => (window as unknown as { rowsDesk(o: unknown): Promise<{ strokes: number; svg: number; wideOnScreen: number[] }> }).rowsDesk(x),
		{ column: TABLET.column, settings, rows })) as { strokes: number; svg: number; wideOnScreen: number[] };
	await p.emulateMedia({ media: "print" });
	await p.evaluate(() => (window as unknown as { twoFrames(): Promise<void> }).twoFrames());
	const page = (await p.evaluate(() => (window as unknown as { rowsGeom(): unknown }).rowsGeom())) as RowsGeom | null;
	const widePrinted = (await p.evaluate(() => (window as unknown as { rowsWide(): number[] }).rowsWide())) as number[];
	await p.emulateMedia({ media: "screen" });
	const ended = (await p.evaluate(() => (window as unknown as { rowsDeskEnd(): Promise<{ swaps: number }> }).rowsDeskEnd())) as { swaps: number };
	return { mounted, page, rows: rowRows(page), widePrinted, swaps: ended.swaps };
}
const RW_WIDE: RowsBlock[] = [RW_TOP, { t: "p", lines: [{ img: true, wide: true }, "*Wideunder holds host ink under the picture", "*Widethird holds host ink on line three"] }, RW_NEXT];
// The desktop print: a PDF embed's own line, both embed shapes as above, a plain picture alone on its line with ink on it
// or opening its paragraph with ink on the two text lines under it; a wide picture with no size given, which the print
// sizes again (its column narrower than the screen's), opening its paragraph; the plain picture with ink on it at a
// print downscale under 1.
const RW_DESK_WAYS: Array<[string, RowsBlock[], number, number]> = [
	["a PDF embed's own line between text lines, ink on it and on the text", [RW_TOP, rwPara({ embed: "pdf", ink: true }), RW_NEXT], 3, 100],
	...RW_EMB_WAYS.map(([way, rows, n]): [string, RowsBlock[], number, number] => [way, rows, n, 100]),
	...RW_IMG_WAYS.map(([way, rows]): [string, RowsBlock[], number, number] => [way, rows, 2, 100]),
	["a wide plain picture the print sizes again, then two text lines, ink on both", RW_WIDE, 2, 100],
	["text then a plain picture, ink on the picture's line, downscale 80", RW_IMG_WAYS[0]![1], 2, 80],
];
// The control: a paragraph of three text lines, no picture or embed, ink on lines two and three, printed at the same
// downscale. The print lays its text out at its own zoom, whose rounded font metrics put every text line's word a
// fixed part of a px off the cross the screen placed (the control's offset, no embed involved); each way's text rows
// are read less that offset, a cross on an embed's or a picture's own line as it is.
const RW_DESK_CONTROL: RowsBlock[] = [RW_TOP, { t: "p", lines: ["Textone opens a paragraph of text only", "*Texttwo holds host ink on line two", "*Textthree holds host ink on line three"] }, RW_NEXT];
itA.each(RW_DESK_WAYS)("ROWS desktop print, %s: each host cross on its word's row as the page prints", async (way, rows, crosses, downscale) => {
	const name = `ROWS desktop print, ${way}`;
	const settings = { ...BASE, downscalePercent: downscale };
	const c = await rowsDeskRun(RW_DESK_CONTROL, settings);
	const r = await rowsDeskRun(rows, settings);
	const cd = c.rows.map(x => x.delta);
	const off = cd.length === 2 && cd.every(d => d !== null) ? r2n((cd[0]! + cd[1]!) / 2) : null;
	// A cross on an embed's or a picture's own line is read against the box, not a word: no text offset to take off.
	const less = r.rows.map(x => ({ ...x, less: x.delta === null ? null : x.id === "embed" ? x.delta : off !== null ? r2n(x.delta - off) : null }));
	embLog("DESK-ROWS", name, { mounted: r.mounted, swaps: r.swaps, widePrinted: r.widePrinted, control: c.rows, off, rows: less, blocks: r.page?.blocks ?? null, strips: r.page?.strips ?? null });
	expect({ svg: c.mounted.svg > 0, crosses: cd.filter(d => d !== null).length, near: cd.every(d => d !== null && Math.abs(d) <= PDF_BAR), spread: off !== null && Math.abs(cd[0]! - cd[1]!) <= 0.2 },
		`premise: ${name}: the control's two crosses print, each within ${PDF_BAR} css px of its word's row, one offset for both (${JSON.stringify(c.rows)})`).toEqual({ svg: true, crosses: 2, near: true, spread: true });
	expect({ svg: r.mounted.svg > 0, crosses: r.rows.filter(x => x.got !== null).length },
		`premise: ${name}: the print swap built its vector layer and each of the ${crosses} crosses stands in a strip as the page prints`).toEqual({ svg: true, crosses });
	const wide = r.mounted.wideOnScreen.map((h, k) => Math.abs(h - (r.widePrinted[k] ?? h)) > 5);
	expect(wide, `premise: ${name}: each wide picture prints at another height than on screen (screen ${r.mounted.wideOnScreen.join(", ")}, print ${r.widePrinted.join(", ")} css px)`)
		.toEqual(r.mounted.wideOnScreen.map(() => true));
	expect(less.filter(x => x.less === null || Math.abs(x.less) > PDF_BAR).map(x => `${x.id} (line ${x.line}): want ${x.want}, got ${x.got}, delta ${x.delta}, less the control's ${off}: ${x.less} css px`),
		`${name}: each host cross on its word's row as the page prints, less the control's offset, within ${PDF_BAR} css px (zf ${r.page?.zf})`).toEqual([]);
	noErrors();
}, T);

itA("HELD R3B-2, tablet: the held paragraph a direct child of the root, built again after the hold: each host cross on its word's row", async () => {
	const name = "HELD R3B-2, tablet";
	const r = await rowsRun("tablet", [RW_TOP, rwPara(RW_PDF, { bare: true }), rwPic(1), RW_NEXT]);
	rowsLog(name, r);
	expectRowsPremise(name, r, RW_HELD);
	// The held line itself is the root's child: a div whose first element is its first line's break (no wrapper's p or div).
	expect({ live: r.held.live?.blocks[1] ?? null, parse: r.lifted?.blocks[1] ?? null, grew: r.grew !== null && r.grew > 50, swaps: r.held.swaps >= 2 },
		`premise: ${name}: the held line is the root's second child, a div, on the page and after the parse; a build follows the hold (grew ${r.grew}, swaps ${r.held.swaps})`)
		.toEqual({ live: "DIV>BR", parse: "DIV>BR", grew: true, swaps: true });
	expectOnRows(name, r);
	noErrors();
}, T);

const RW_LIST: RowsBlock = { t: "list", items: [["Itemone opens the loose list"], ["Itemtwo holds the embed on its next line", RW_PDF], ["*Itemthree holds host ink below the embed"]] };
const RW_QUOTE: RowsBlock = { t: "quote", lines: ["Quoteone opens the quote", "*Quotetwo holds host ink", RW_PDF, "*Quotefour holds host ink after the embed"] };
itA("HELD R3B-3, tablet: a loose list and a quote whose lines the export held, built again after the hold: rows as at base (the list's from its items, the quote none)", async () => {
	const name = "HELD R3B-3, tablet";
	const r = await rowsRun("tablet", [RW_TOP, RW_LIST, RW_QUOTE, rwPic(1), RW_NEXT]);
	rowsLog(name, r);
	expectRowsPremise(name, r, ["Quotetwo"]);
	expect({ spans: (r.held.live?.spans ?? []).map(s => s.parent), grew: r.grew !== null && r.grew > 50, swaps: r.held.swaps >= 2 },
		`premise: ${name}: both embeds' lines held as divs, and a build follows the hold (grew ${r.grew}, swaps ${r.held.swaps})`).toEqual({ spans: ["DIV", "DIV"], grew: true, swaps: true });
	const rows = (r.held.measure ?? []).map(b => b.rows);
	expect({ list: rows.length > 1 ? rows[1] : "no block", quote: rows.length > 2 ? rows[2] : "no block" },
		`${name}: after the build that follows the hold, the measure reads the list's rows from its items and the quote none, as at base (tops ${JSON.stringify((r.held.measure ?? []).slice(1, 3).map(b => b.tops))})`)
		.toEqual({ list: { kind: "list", count: 3 }, quote: null });
	noErrors();
}, T);

itA("HELD R3B-4, tablet: two held paragraphs, the second held at the late look, then a build after both: each of the four host crosses on its word's row", async () => {
	const name = "HELD R3B-4, tablet";
	const r = await rowsRun("tablet", [RW_TOP, rwPara(RW_PDF), rwPara({ embed: "pdf", late: 1 }, {}, "Again"), rwPic(2), RW_NEXT]);
	rowsLog(name, r);
	expectRowsPremise(name, r, [...RW_HELD, "Againtwo", "Againfour"]);
	expect({ second: rowRows(r.held.atBuild).filter(x => x.id.startsWith("Again")).map(x => x.host), grew: r.grew !== null && r.grew > 50, swaps: r.held.swaps >= 3 },
		`premise: ${name}: the second paragraph is still a p once the zoom's build is done (its embed empty), then held at the late look, and a build follows both holds (grew ${r.grew}, swaps ${r.held.swaps}, at least 3)`)
		.toEqual({ second: ["P", "P"], grew: true, swaps: true });
	expectOnRows(name, r);
	noErrors();
}, T);

// R3B-5: the plain export, no late content; its layer watch's replace follows the zoom's build (the comment above c).
// "replace" calls the anchor watch's queueReplace once more after the build. rebuilt (whether that later build took the
// zoom's strips away) is logged only: at base the replace builds again at the even share, here it keeps the rows.
const RW_PLAIN_WAYS: Array<[string, Record<string, unknown>]> = [["the plain export", {}], ["the anchor watch's replace too", { replace: true }]];
itA.each(RW_PLAIN_WAYS)("HELD R3B-5, %s, tablet: no late content, a build after the hold all the same: each host cross on its word's row", async (way, extra) => {
	const name = `HELD R3B-5, ${way}, tablet`;
	const r = await rowsRun("tablet", [RW_TOP, rwPara(RW_PDF), RW_NEXT], extra);
	rowsLog(name, r);
	expectRowsPremise(name, r, RW_HELD);
	expect({ swaps: r.held.swaps }, `premise: ${name}: no late look, one print swap (the zoom's) (rebuilt ${r.held.rebuilt})`).toEqual({ swaps: 1 });
	expectOnRows(name, r);
	noErrors();
}, T);

const RW_LOOK: RowsBlock = { t: "look", lines: ["Lookone opens the lookalike block", "*Looktwo holds host ink on its first word", RW_PDF, "*Lookfour holds host ink after the embed"] };
/** A block read's even share for its 0-based line i: what lineTopIn gives a block with no rows (EmbedInkLines.ts). */
const evenShare = (b: RowsBlockRead, i: number) => (b.box ? r2n(b.box.top + ((i - b.lineStart) * b.box.height) / (b.lineEnd - b.lineStart + 1)) : null);
/** d's reads of the lookalike block (block 2): its rows, and each of its lines' tops less the even share. */
const lookReads = (m: RowsBlockRead[] | null) => {
	const b = m?.[2] ?? null;
	return { rows: b ? b.rows : "no block", off: b ? b.tops.map((t, k) => (t === null ? null : r2n(t - evenShare(b, b.lineStart + k)!))) : null };
};
itA("HELD d (R3B-6), tablet export: a div no hold wrote, with a p's attributes and its margins inline, is no row host after a build that follows the hold", async () => {
	const name = "HELD d, tablet export";
	const r = await rowsRun("tablet", [RW_TOP, rwPara(RW_PDF), RW_LOOK, rwPic(1), RW_NEXT]);
	const look = lookReads(r.held.measure);
	rowsLog(name, r, { look });
	expectRowsPremise(name, r, RW_HELD);
	expect({ grew: r.grew !== null && r.grew > 50, swaps: r.held.swaps >= 2 }, `premise: ${name}: a build follows the hold (grew ${r.grew}, swaps ${r.held.swaps})`).toEqual({ grew: true, swaps: true });
	expect({ rows: look.rows, off: look.off?.map(v => v !== null && Math.abs(v) <= PDF_BAR) ?? null },
		`${name}: the lookalike block has no rows and each of its lines' tops is the even share, as at base (off ${JSON.stringify(look.off)} px)`).toEqual({ rows: null, off: [true, true, true, true] });
	noErrors();
}, T);

interface RowsLooked { measure: RowsBlockRead[] | null; placed: Array<{ id: string; line: number; top: number; dy: number }>; layer: boolean }
for (const where of ["screen", "desktop"] as const) {
	itA(`HELD d (R3B-6), tablet ${where}: the same lookalike div is no row host, and its ink is placed at the even share as at base`, async () => {
		const name = `HELD d, tablet ${where}`;
		const p = await pageFor("tablet");
		const got = (await p.evaluate((x) => (window as unknown as { rowsLook(o: unknown): Promise<RowsLooked> }).rowsLook(x),
			{ column: TABLET.column, settings: { ...BASE }, rows: [RW_TOP, rwPara(RW_PDF), RW_LOOK, RW_NEXT], where })) as RowsLooked;
		const look = lookReads(got.measure);
		const b = got.measure?.[2] ?? null;
		// Each lookalike stroke's line top as placed (its correction plus its anchor's top) less the even share.
		const placedOff = got.placed.filter(s => b && s.line - 1 >= b.lineStart && s.line - 1 <= b.lineEnd).map(s => ({ id: s.id, line: s.line, off: r2n(s.dy + s.top - evenShare(b!, s.line - 1)!) }));
		embLog("HELD-LOOK", name, { measure: got.measure, placed: got.placed, look, placedOff, layer: got.layer });
		expect({ layer: got.layer, para: got.measure?.[1]?.rows ?? "no block", strokes: placedOff.length },
			`premise: ${name}: the ink layer stands, the measure reads the held paragraph's own p as four rows, and four lookalike strokes are placed`).toEqual({ layer: true, para: { kind: "breaks", count: 4 }, strokes: 4 });
		expect({ rows: look.rows, placed: placedOff.map(s => Math.abs(s.off) <= PDF_BAR) },
			`${name}: the lookalike block has no rows and its ink is placed at the even share, as at base (${JSON.stringify(placedOff)})`).toEqual({ rows: null, placed: [true, true, true, true] });
		noErrors();
	}, T);
}
