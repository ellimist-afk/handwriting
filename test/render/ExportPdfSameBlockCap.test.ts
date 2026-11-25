/**
 * AN EXPORT TO PDF: THE HOST'S INK ON THE LINE AFTER A PDF EMBED IN THE SAME PARAGRAPH, AGAINST THE PRINT CAP ON THE EMBED.
 * EACH CELL ASSERTS ITS PREMISE, LOGS ITS ROW AND HOLDS THE BAR (BELOW).
 *
 * Obsidian 1.15.1's app.css caps a PDF embed in print media: inside its @media print block,
 * `.pdf-embed:not(.canvas-node-content){align-items:center;border:none;justify-content:center;max-height:80vh}` (app.asar
 * byte 418065). On screen the embed is `width:100%;height:800px;display:flex` (byte 417199). Chromium's print takes vh
 * from the page's content box (ExportMobilePdfLandscape.test.ts: Letter landscape at 0.4 in printed the span 593 px). At
 * the default margin, 0.4 in a side, 80vh is about 783 px on Letter portrait (979.2 px of content), 591 on Letter
 * landscape (739.2) and 837 on A4 portrait (1045.7): the cap binds on Letter either way up, and not on A4 portrait.
 *
 * The note: the file name; block 0 one paragraph of three source lines with no blank line between them, "Pdfabove notes",
 * "![[Paper.pdf]]", "Pdfbelow notes", as the reading view renders them: one p, the line breaks as br, the embed's span
 * between them (span.internal-embed.pdf-embed, app.js @3018566), the viewer not built yet, so the span is empty
 * (ExportMobilePdf.test.ts's PDF-2 control); block 1 a paragraph (Lastword). A cross on Pdfbelow (the
 * shape asked about), on Pdfabove (the read's zero inside the same block) and on Lastword (the next block), each attached
 * to its block's first line, placed from the page as it lays the note out. The ink is cut one strip per block
 * (EmbedInkPrint.ts buildPrintStrips): Pdfabove's and Pdfbelow's crosses share one strip, placed by the block's top. If
 * the print lays the span out shorter than the page the ink was cut on, Pdfbelow rises inside its block and its cross
 * does not.
 *
 * The cap lifted: a test-side plant, an inline `max-height: none` on the embed's span, written on the page before the
 * export (no effect on screen, where the span has no max-height) and carried in the export's string; an inline style
 * beats the stylesheet's print rule. No src file is touched. With the cap lifted the span prints at its page height: a
 * row that goes to 0 says the cap made it; a row still off says a page break or something else did.
 *
 * Phone and tablet (360 x 780, column 312; 800 x 1280, column 700; the saved 100 % downscale): the export replayed as
 * ExportMobilePdfLandscape.test.ts replays printToPdfMobile (app.js @2682211), then two reads of its string, each loaded
 * with scripts off as the native side loads it:
 *   1. The print layout without pages: the string at a viewport of the paper's content box in print media, so vh is the
 *      print's. Each marked word against its own block's strip, less the same on the page when the string was taken, css
 *      px; and the span's height on the page and after the parse.
 *   2. Chromium's own print of the string (page.pdf: the paper's size and orientation, the default margin, scale 1), read
 *      with ExportMobilePdf.test.ts's pdf.js reader (READER_JS, verbatim at b04241aa): each cross's centre less its green
 *      word's centre, page px, with the page each word printed on, and the embed's blue span as printed. A cross outside
 *      its word's window (the reader's window is about a word's height up and down) has no window row: every ink blob is
 *      logged with its page and centre, an ink blob outside every window is a stray, and the blobs are paired with the
 *      words by order down the pages, as ExportMobilePdf.test.ts's PDF cells pair them (a pairing that holds only while
 *      no cross passes another word).
 * Read 1 has no pages, so a move there is not a page break; read 2 is the print as it pages.
 *
 * Desktop, Letter portrait only: the export mounted as ExportMobilePdf.test.ts's desktopMount mounts it (body
 * theme-light, not the mobile app, the plugin attached, beforeprint), on a page whose viewport is the paper's content box,
 * so the print media the plugin lays out in has the vh page.pdf prints with; then print media, two frames, page.pdf at the
 * same paper and margin, scale 1, afterprint. Its strips are cut at the print-media call.
 *
 * Premise per run: six cross strokes; one strip in each marked word's block (phone and tablet: on the page and after the
 * parse; desktop: in print media); the span empty; the plant on the span before the export exactly when the row lifts the
 * cap; the read in print media at the paper's content height; the app's cap live in the read (a hidden probe span of the
 * embed's classes on the body: its max-height 80vh of the read's viewport, within 0.5 px); the span's print height within
 * 0.5 css px of its page height where the cap cannot bind (lifted, or 80vh over 800); every marked word found once in the
 * PDF; Pdfabove's cross on its word within 1 page px (the read's zero). Where the cap can bind, the span's drop is logged.
 *
 * The bar (1 page px; the rows with the cap kept on Letter, either way up, and the
 * desktop's are cell a): in every row Pdfbelow's and Lastword's crosses on their words in the printed PDF within 1 page
 * px across and down, one ink blob or more in each word's window, and no ink outside every window.
 *
 * More cells, each a test-side option on the same note (one EXPORT-PDF-PRINTCAP ROWS line per run):
 *   b. Letter landscape, the cap kept: a fourth cross drawn over the embed's lower part, 650 px down its 800 (under the
 *      591 px the cap leaves), attached to block 0's first line. Bar: that cross's ink box inside the embed's printed blue
 *      box on its page, within 1 page px. Phone, tablet, desktop.
 *      b-span: that cross as the note's only ink. In b the crosses on Pdfbelow and Lastword sit below the span's top
 *      too, so they would turn the hold on by themselves. Same bar, phone, tablet, desktop.
 *   c. No strips cut: no column width wired (the provider answers null and no Reading view shows the note), so no spans
 *      are held and the layer prints as one box (EmbedInkPrint.ts:755-757, then :865, at b04241aa). The root is given the
 *      column's width inline, test-side, so the page lays the note out at the width the ink was drawn at. Letter portrait,
 *      the cap kept, the export's title off and no Pdfbelow line, so the whole note prints on page 1 with the span at 800
 *      px (a premise: the one box is not cut per block, so a page break moves a block off its ink with the cap or without
 *      it; controls c0, the cap lifted, logged with no bar). Bar: Lastword's cross on its word. Phone, tablet, desktop.
 *      c869 (desktop): the :869 leg, spans held at the screen call and a block that print hides. c-late (desktop): the
 *      print media first, no screen call; logged, no bar.
 *   d. No ink at stake, the embed prints as at base: no ink (phone, tablet, desktop); d2, the host no ink and an inked
 *      embedded note after the PDF's block; d3, the host's ink only above the embed (phone, desktop). Bar: no inline
 *      max-height on the span in print, and the app's cap binds as with no plugin (the span over 5 css px shorter in print
 *      than on the page). Letter portrait. Control m0 (logged): d2's note with the cap lifted, and on A4.
 *   e. The span's style attribute after the export, byte for byte: desktop with no style, its own max-height 600px (its
 *      value stands in print), a raw height:1000px, the 1b plant, beforeprint twice, two roots that can hold one span;
 *      tablet, its own 600px carried in the string.
 *   f1, f3, f6, f8, m, g: more edges of the hold (when it is set, a raw height, a zoom under 1, two embeds, a nested
 *      note, the viewer built); each described where it stands below.
 *
 * Env: HW_OBSIDIAN_ASAR (required; every cell skips with a loud line without it), HW_SB_OUT (a directory that keeps
 * each PDF).
 *
 * Run: npx vitest run --config vitest.render.mts test/render/ExportPdfSameBlockCap.test.ts
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
const OUT = process.env.HW_SB_OUT ?? "";
if (!HAVE_ASAR) console.log("EXPORT-PDF-SAMEBLOCK SKIP: HW_OBSIDIAN_ASAR is unset or missing; every cell in this file is skipped");
const itA = (HAVE_ASAR ? it : it.skip) as typeof it;
const T = 180_000;

/** One file out of an asar archive (ExportMobilePdf.test.ts's reader of it). */
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

/** Test instrument, not Obsidian's: the marked words print a green box, the PDF embed's span a blue one. */
const INSTRUMENT_CSS = ".mark-word{background:#00ff00} .pdf-embed{background:#0000ff} @media print{.sb-noprint{display:none}}";

/** The marked words: id, token, block. Block 0 is the paragraph that holds the PDF embed. */
const MARKS = [
	{ id: "w-above", token: "Pdfabove", block: 0 },
	{ id: "w-below", token: "Pdfbelow", block: 0 },
	{ id: "w-last", token: "Lastword", block: 1 },
] as const;
/** The note's source lines, and each block's first and last line in it (0-based, as the reading view's sections give them). */
const SOURCE = ["Pdfabove notes", "![[Paper.pdf]]", "Pdfbelow notes", "", "Lastword sits in the block after the paragraph"];
const SECTIONS = [{ start: 0, end: 2 }, { start: 4, end: 4 }];
const TOKENS = MARKS.map(m => m.token);

const PAGE = `
import { Platform } from "obsidian";
import { attachEmbedInkOnceReady, initEmbedInkColumnWidth, initEmbedInkRefresh, teardownEmbedInk } from "../../src/inline/EmbedInk";
import { initEmbedInkPrintCanvas, initEmbedInkPrintPaper, printVectorFor } from "../../src/inline/EmbedInkPrint";
import { aboveOf, lineKey, newAboveRun } from "../../src/inline/LineAnchor";
import { installObsidianDom } from "./obsidianDom";

installObsidianDom();
const proto = HTMLElement.prototype;
proto.setCssStyles ??= function (s) { for (const k of Object.keys(s)) this.style[k] = s[k]; };
window.createDiv ??= () => document.createElement("div");

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const r2 = v => Math.round(v * 100) / 100;
const PATH = "Same block note.md";
const zoomOf = el => parseFloat(getComputedStyle(el).zoom) || 1;

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

function mark(p, id, word) {
	const w = p.appendChild(document.createElement("span"));
	w.className = "mark-word";
	w.id = id;
	w.textContent = word;
}
/**
 * Block 0: "Pdfabove notes", "![[Paper.pdf]]", "Pdfbelow notes" as the reading view renders three lines with no blank line
 * between them: one p, the breaks as br, span.internal-embed.pdf-embed between them, empty (the viewer not built yet).
 * o.lift: the test-side plant, an inline max-height: none on the span. o.own: the span's own inline max-height (cell e).
 */
function pdfSpan(p, o) {
	const embed = p.appendChild(document.createElement("span"));
	embed.className = "internal-embed pdf-embed is-loaded";
	embed.setAttribute("src", "Paper.pdf");
	embed.setAttribute("alt", "Paper.pdf");
	if (o.lift) embed.style.maxHeight = "none";
	else if (o.own) embed.style.maxHeight = o.own;
	// o.spanStyle (cells f3, e): the span's own style attribute, written raw, so a rewrite through the CSSOM shows in its bytes.
	if (o.spanStyle) embed.setAttribute("style", o.spanStyle);
	// o.viewer "built" (cell g): the viewer's toolbar and page container in the span from the render on, as
	// ExportMobilePdf.test.ts's SIDE_KINDS.pdf builds them; "late": they enter after the zoom's build.
	if (o.viewer === "built") viewerFill(embed);
	p.appendChild(document.createElement("br"));
	return embed;
}
function viewerFill(span) {
	for (const cls of ["pdf-toolbar", "pdf-content-container"]) span.appendChild(document.createElement("div")).className = cls;
}
/**
 * o.twoPdf (cell f8): the paragraph one level down in its block (a div in the block's div, as a callout's or a list's content
 * holds its lines, with no indent of its own), two PDF embeds in it, one under the other.
 */
function sameBlock(root, o) {
	const d = root.appendChild(document.createElement("div"));
	const p = (o.twoPdf ? d.appendChild(document.createElement("div")) : d).appendChild(document.createElement("p"));
	mark(p, "w-above", "Pdfabove");
	p.append(" notes");
	p.appendChild(document.createElement("br"));
	pdfSpan(p, o);
	if (o.twoPdf) pdfSpan(p, o);
	// o.noBelow (cell c): no Pdfbelow line, so the note fits page 1 with the span at its screen height. The embed is then the
	// paragraph's last line, which the reading view ends with no br.
	if (o.noBelow) { p.lastChild.remove(); return d; }
	mark(p, "w-below", "Pdfbelow");
	p.append(" notes");
	return d;
}
/**
 * o.embed (cells m, m2): an embedded note as its own block between block 0 and Lastword's, as ExportEmbedInkDesktop.test.ts
 * mounts one (span.markdown-embed > .markdown-embed-content > .markdown-preview-view, its blocks straight in the view):
 * one paragraph, "Embabove notes", with o.embed.pdf a PDF embed's span (empty), "Embbelow notes", as block 0 is.
 */
const EMB_PATH = "Embedded note.md";
function embedBlock(root, o) {
	const d = root.appendChild(document.createElement("div"));
	const embed = d.appendChild(document.createElement("span"));
	embed.className = "internal-embed markdown-embed inline-embed is-loaded";
	embed.setAttribute("src", "Embedded note");
	const content = embed.appendChild(document.createElement("div"));
	content.className = "markdown-embed-content";
	const inner = content.appendChild(document.createElement("div"));
	inner.className = "markdown-preview-view markdown-rendered";
	const p = inner.appendChild(document.createElement("div")).appendChild(document.createElement("p"));
	mark(p, "e-above", "Embabove");
	p.append(" notes");
	p.appendChild(document.createElement("br"));
	// With no PDF a plain line between the words: one right under the other, their green boxes touch and read as one.
	if (o.embed.pdf) pdfSpan(p, { spanStyle: o.embed.style });
	else { p.append("a plain line between the words"); p.appendChild(document.createElement("br")); }
	mark(p, "e-below", "Embbelow");
	p.append(" notes");
	return inner;
}
/** The embedded note's ink: a cross on each of its marked words, in its own note space (x 0 its first line's left, y 0 its top). */
function embedCrosses(inner) {
	const p0 = inner.querySelector("p").getBoundingClientRect();
	return ["e-above", "e-below"].flatMap(id => {
		const w = inner.querySelector("#" + id).getBoundingClientRect();
		const x = r2(w.left + w.width / 2 - p0.left), y = r2(w.top + w.height / 2 - p0.top);
		return [line("h-" + id, x - 16, y, x + 16, y), line("v-" + id, x, y - 7, x, y + 7)];
	});
}
const innerOf = root => root.querySelector(".markdown-embed-content > .markdown-preview-view");
const embPdfOf = root => root.querySelector(".markdown-embed-content .pdf-embed");
/** A paragraph, its first word marked. */
function textBlock(root, text, id) {
	const d = root.appendChild(document.createElement("div"));
	const p = d.appendChild(document.createElement("p"));
	const words = text.split(" ");
	mark(p, id, words[0]);
	p.append(" " + words.slice(1).join(" "));
	return d;
}
function fill(root, o) {
	if (o.settings.includeName) { const h = root.appendChild(document.createElement("h1")); h.textContent = "Same block note"; }
	const blocks = [sameBlock(root, o)];
	if (o.embed) embedBlock(root, o);
	blocks.push(textBlock(root, o.source[o.sections[1].start], "w-last"));
	// o.hideBlock (cell c869): one more block, last, that print media hides (the instrument's .sb-noprint), so the block count
	// at the cut differs from the one held on screen (EmbedInkPrint.ts:869 at b04241aa).
	if (o.hideBlock) {
		const h = root.appendChild(document.createElement("div"));
		h.className = "sb-noprint";
		h.appendChild(document.createElement("p")).textContent = "Hidden in print";
	}
	return blocks;
}
/**
 * A cross (magenta, 32 x 14) on each marked word, attached to its block's first line: x from the first paragraph's left,
 * y and the line's top from that paragraph's top, as this page lays the note out. o.spanInk (cell b): one more, over the
 * embed's span, 3/4 across it and o.spanInk px down from its top, attached to block 0's first line.
 */
function crosses(root, sections, o) {
	const p0r = root.querySelector("p").getBoundingClientRect();
	// o.twoPdf: block 0's paragraph sits in a blockquote; x 0 is the block's left, as the plugin places it.
	const p0 = { top: p0r.top, left: o.twoPdf ? sections[0].getBoundingClientRect().left : p0r.left };
	const strokes = [], at = {};
	const anchorOf = (block) => {
		const n = o.sections[block].start + 1;
		const s = sections[block].getBoundingClientRect();
		return { line: n, top: r2(s.top - p0.top), key: lineKey(o.source[n - 1]), width: o.column, fontPx: 16,
			above: aboveOf(newAboveRun(), n, j => lineKey(o.source[j - 1])) };
	};
	const cross = (id, x, y, anchor) => {
		at[id] = { x, y };
		strokes.push(line("h-" + id, x - 16, y, x + 16, y, { anchor }), line("v-" + id, x, y - 7, x, y + 7, { anchor }));
	};
	for (const m of o.marks) {
		const w = root.querySelector("#" + m.id).getBoundingClientRect();
		cross(m.id, r2(w.left + w.width / 2 - p0.left), r2(w.top + w.height / 2 - p0.top), anchorOf(m.block));
	}
	if (o.spanInk !== undefined) {
		const e = root.querySelector(".pdf-embed").getBoundingClientRect();
		cross("x-span", r2(e.left + e.width * 0.75 - p0.left), r2(e.top + o.spanInk - p0.top), anchorOf(0));
	}
	return { strokes, at };
}
/** The one ink box shown: the layer not stood in for by strips. */
const boxShown = div => [...div.querySelectorAll("svg.handwriting-embed-ink")].filter(s => !s.classList.contains("is-stripped")).length;
function attach(root, sections, o, provide) {
	const text = o.source.join("\\n");
	sections.forEach((el, i) => attachEmbedInkOnceReady(el, root, PATH, provide, undefined, false, {
		section: () => ({ text, lineStart: o.sections[i].start, lineEnd: o.sections[i].end }), cached: () => null }));
}
const shownCanvases = div => [...div.querySelectorAll("canvas.handwriting-embed-ink")].filter(c => getComputedStyle(c).display !== "none").length;

/** printToPdfMobile replayed with the plugin live, as ExportMobilePdfLandscape.test.ts's landExport does it, the note above. */
window.sbExport = async (o) => {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "is-mobile " + (o.column < 500 ? "is-phone " : "is-tablet ") + "theme-dark";
	Platform.isMobileApp = true;
	Platform.isMobile = true;
	initEmbedInkColumnWidth(() => o.noColumn ? null : o.column);
	initEmbedInkPrintPaper(() => o.settings);
	initEmbedInkPrintCanvas(null);
	let live = [], embLive = [];
	const provide = () => live;
	initEmbedInkRefresh(path => path === EMB_PATH ? embLive : live);
	const div = document.body.appendChild(document.createElement("div"));
	div.className = "print theme-light";
	div.setAttribute("aria-hidden", "true");
	const root = div.appendChild(document.createElement("div"));
	root.className = "markdown-preview-view markdown-rendered";
	const sections = fill(root, o);
	const inner = o.embed ? innerOf(root) : null;
	// Cell c: no column width is wired, so the plugin sets none; the note is laid out at the width its ink was drawn at.
	if (o.noColumn) root.style.width = o.column + "px";
	const span = root.querySelector(".pdf-embed"), embPdf = embPdfOf(root);
	// The span before the export: the test-side plant (or its own value), nothing of the plugin's yet.
	const plant = span ? span.style.maxHeight : null, cssBefore = span ? span.style.cssText : null;
	const attrBefore = span ? span.getAttribute("style") : null, embAttrBefore = embPdf ? embPdf.getAttribute("style") : null;
	await frame();
	const ink = crosses(root, sections, o);
	live = o.noInk ? [] : ink.strokes;
	// The embedded note's crosses read here too, on the same layout, before any attach adds its room.
	if (inner) embLive = o.embed.ink ? embedCrosses(inner) : [];
	attach(root, sections, o, provide);
	if (inner) attachEmbedInkOnceReady(inner, inner, EMB_PATH, () => embLive);
	// print() resolves; the zoom, then two frames in place of the app's 200 ms.
	await Promise.resolve();
	const scale = Math.min(2, Math.max(0.1, o.settings.downscalePercent / 100));
	div.style.zoom = scale.toString();
	await frame(); await frame();
	// Cell g, late: the viewer's divs enter the span after the zoom's build, before the string is taken (as ExportMobilePdf.test.ts's late cells do).
	if (o.viewer === "late" && span) { viewerFill(span); await frame(); await frame(); }
	const geom = window.sbGeom();
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
	const held = { html: out, zf, geom, at: ink.at, strokes: live.length, embStrokes: embLive.length,
		strips: div.querySelectorAll("svg.handwriting-embed-ink-strip").length, canvasShown: shownCanvases(div),
		plant, cssBefore, cssBuilt: span ? span.style.cssText : null, box: boxShown(div),
		attr: { before: attrBefore, built: span ? span.getAttribute("style") : null }, emb: { before: embAttrBefore, built: embPdf ? embPdf.getAttribute("style") : null },
		pdfs: root.querySelectorAll(".pdf-embed").length };
	div.remove();
	teardownEmbedInk();
	return held;
};

/**
 * The desktop export, mounted as ExportMobilePdf.test.ts's desktopMount mounts it: body theme-light, not the mobile app,
 * the plugin attached, beforeprint. The test then turns print media on, waits two frames, prints and calls sbDeskEnd.
 */
window.sbDesk = async (o) => {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "theme-light";
	Platform.isMobileApp = false;
	Platform.isMobile = false;
	initEmbedInkColumnWidth(() => o.noColumn ? null : o.column);
	initEmbedInkPrintPaper(() => o.settings);
	initEmbedInkPrintCanvas(null);
	let live = [], embLive = [];
	const provide = () => live;
	initEmbedInkRefresh(path => path === EMB_PATH ? embLive : live);
	const div = document.body.appendChild(document.createElement("div"));
	div.className = "print";
	const root = div.appendChild(document.createElement("div"));
	root.className = "markdown-preview-view markdown-rendered";
	const sections = fill(root, o);
	const inner = o.embed ? innerOf(root) : null;
	if (o.noColumn) root.style.width = o.column + "px";
	const span = root.querySelector(".pdf-embed"), embPdf = embPdfOf(root);
	// The span before the export: the test-side plant (or its own value), nothing of the plugin's yet (cell e's before).
	const plant = span ? span.style.maxHeight : null, cssBefore = span ? span.style.cssText : null;
	const attrBefore = span ? span.getAttribute("style") : null, embAttrBefore = embPdf ? embPdf.getAttribute("style") : null;
	await frame();
	const ink = crosses(root, sections, o);
	live = o.noInk ? [] : ink.strokes;
	// The embedded note's crosses read here too, on the same layout, before any attach adds its room.
	if (inner) embLive = o.embed.ink ? embedCrosses(inner) : [];
	attach(root, sections, o, provide);
	if (inner) attachEmbedInkOnceReady(inner, inner, EMB_PATH, () => embLive);
	await frame(); await frame();
	const screen = { geom: window.sbGeom(), zf: zoomOf(div) * zoomOf(root) };
	// As the print starts, on screen with the ink painted.
	const cssScreen = span ? span.style.cssText : null;
	// o.late (cell c-late): no beforeprint, the print media comes first (a print path that only flips the media, or a root
	// that attaches mid-print). o.twice (cell e): beforeprint twice.
	if (!o.late) {
		window.dispatchEvent(new Event("beforeprint"));
		await frame(); await frame();
		if (o.twice) { window.dispatchEvent(new Event("beforeprint")); await frame(); await frame(); }
	}
	// Cell f1: at the end of the screen call, before the media flips: the span's inline max-height then.
	// heldBlocks: the root's blocks the screen call held (holdWholeBlocks: position relative inline), so a cell names its leg.
	const atScreen = { media: matchMedia("print").matches, maxHeight: span ? span.style.maxHeight : null, attr: span ? span.getAttribute("style") : null,
		emb: embPdf ? embPdf.style.maxHeight : null, heldBlocks: [...root.children].filter(c => c.style && c.style.position === "relative").length };
	return { screen, at: ink.at, strokes: live.length, embStrokes: embLive.length, plant, cssBefore, cssScreen, atScreen,
		attr: { before: attrBefore }, emb: { before: embAttrBefore }, pdfs: root.querySelectorAll(".pdf-embed").length };
};
window.sbFrames = async () => { await frame(); await frame(); };
const deskSpan = () => document.querySelector("body > .print .pdf-embed");
const deskRoot = () => document.querySelector("body > .print > .markdown-preview-view");
/** In print media, as it prints: the read, the zoom, the strips, the canvases shown, the one box shown, the span's style. */
window.sbPrintRead = () => {
	const div = document.querySelector("body > .print");
	const root = div.querySelector(":scope > .markdown-preview-view");
	const embPdf = embPdfOf(root);
	return { geom: window.sbGeom(), zf: zoomOf(div) * zoomOf(root), strips: div.querySelectorAll("svg.handwriting-embed-ink-strip").length, canvasShown: shownCanvases(div),
		box: boxShown(div), css: deskSpan()?.style.cssText ?? null, attr: deskSpan()?.getAttribute("style") ?? null, emb: embPdf ? embPdf.getAttribute("style") : null,
		shown: [...root.children].filter(c => c.offsetParent).length };
};
/** Cell e, two roots: in print media, after the print, the host's root is taken off first, then the embedded note's. */
window.sbOuterFirst = () => {
	const root = deskRoot();
	printVectorFor(root, PATH, false);
	printVectorFor(innerOf(root), EMB_PATH, false);
};
/** After afterprint and a frame, back in screen media: the span's style and its computed max-height, before the page goes. */
window.sbDeskEnd = async () => {
	window.dispatchEvent(new Event("afterprint"));
	await frame();
	const span = deskSpan(), embPdf = embPdfOf(deskRoot());
	const end = { css: span ? span.style.cssText : null, maxHeight: span ? getComputedStyle(span).maxHeight : null,
		attr: span ? span.getAttribute("style") : null, emb: embPdf ? embPdf.getAttribute("style") : null };
	teardownEmbedInk();
	document.body.replaceChildren();
	return end;
};
`;

/**
 * The read: each marked word's box against the one strip in its own block (zoomed px), its block's and its own top below
 * the root's; the PDF embed's span as laid out (its height, its top below the root's, its computed and inline max-height,
 * its cssText, its child count), the app's cap in this media (`cap`: the computed max-height of a hidden probe span of the
 * embed's classes, on the body for the read only), the viewport's height, whether print media is on, the one ink box
 * shown. A string expression, so it runs with scripts off.
 */
interface WordRel { strips: number; x: number | null; y: number | null; h: number; block: number; top: number }
interface Span { h: number; top: number; maxHeight: string; inline: string; css: string; attr: string | null; cap: string | null; kids: number; parent: string | null }
interface Geom { words: Record<string, WordRel | null>; span: Span | null; vh: number; print: boolean; rootW: number; box: number }
const SB_GEOM = `(() => {
	const r2 = v => Math.round(v * 100) / 100;
	const root = document.querySelector(".print > .markdown-preview-view");
	if (!root) return null;
	const rr = root.getBoundingClientRect();
	const blockOf = el => { let b = el; while (b && b.parentElement !== root) b = b.parentElement; return b; };
	const words = {};
	for (const id of ${JSON.stringify(MARKS.map(m => m.id))}) {
		const w = root.querySelector("#" + id);
		const b = w ? blockOf(w) : null;
		if (!w || !b) { words[id] = null; continue; }
		const strips = b.querySelectorAll(":scope > svg.handwriting-embed-ink-strip");
		const s = strips.length === 1 ? strips[0].getBoundingClientRect() : null;
		const r = w.getBoundingClientRect(), br = b.getBoundingClientRect();
		words[id] = { strips: strips.length, x: s ? r2(r.left - s.left) : null, y: s ? r2(r.top - s.top) : null, h: r2(r.height),
			block: r2(br.top - rr.top), top: r2(r.top - rr.top) };
	}
	const span = root.querySelector(".pdf-embed");
	let cap = null;
	if (span) {
		const probe = document.createElement("span");
		probe.className = span.className;
		probe.style.position = "absolute";
		probe.style.visibility = "hidden";
		document.body.appendChild(probe);
		cap = getComputedStyle(probe).maxHeight;
		probe.remove();
	}
	const box = root.querySelectorAll(":scope > svg.handwriting-embed-ink:not(.is-stripped)").length;
	return { words, span: span ? { h: r2(span.getBoundingClientRect().height), top: r2(span.getBoundingClientRect().top - rr.top), maxHeight: getComputedStyle(span).maxHeight,
		inline: span.style.maxHeight, css: span.style.cssText, attr: span.getAttribute("style"), cap, kids: span.childElementCount, parent: span.parentElement ? span.parentElement.tagName : null } : null,
		vh: window.innerHeight, print: matchMedia("print").matches, rootW: r2(rr.width), box };
})()`;

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

/**
 * Cell b's read, added after the reader in the same module (READER_JS above stays verbatim): each page rasterised at 2 canvas
 * px per page px, as the reader's first pass; per page the box round all its blue (span) blobs and every ink blob of 40 px
 * or more with its box and core centroid, page px.
 */
const BOX_JS = `
window.readBoxes = async (url) => {
	const doc = await pdfjs.getDocument({ url }).promise;
	const out = [];
	for (let p = 1; p <= doc.numPages; p++) {
		const page = await doc.getPage(p);
		const { blobs, W, H } = await raster(page, 2, null);
		const blue = blobs.filter(b => b.cls === "span" && b.count >= 4);
		const span = blue.length ? { x0: r2(Math.min(...blue.map(b => b.x0))), y0: r2(Math.min(...blue.map(b => b.y0))), x1: r2(Math.max(...blue.map(b => b.x1))), y1: r2(Math.max(...blue.map(b => b.y1))) } : null;
		const inks = blobs.filter(b => b.cls === "ink" && b.count >= 40).map(b => ({ x0: r2(b.x0), y0: r2(b.y0), x1: r2(b.x1), y1: r2(b.y1),
			cx: r2(b.cx ?? (b.x0 + b.x1) / 2), cy: r2(b.cy ?? (b.y0 + b.y1) / 2), count: b.count }));
		out.push({ page: p - 1, W: r2(W), H: r2(H), span, inks });
	}
	await doc.destroy();
	return out;
};
`;

/** The dialog's saved settings, as app.js writes them (@2680737). */
interface Settings { includeName: boolean; pageSize: string; landscape: boolean; margin: string; downscalePercent: number }
/** The default margin code "0": 0.4 in, the desktop table's (EmbedInkPrint.ts MARGIN_INCHES), as ExportMobilePdf.test.ts prints. */
const MARGIN = "0.4in";
const TABLET = { width: 800, height: 1280, column: 700 };
const PHONE = { width: 360, height: 780, column: 312 };
type Device = "phone" | "tablet";

/** A paper at the default margin: its content box, css px (the page less 0.4 in a side), rounded for a viewport. */
interface Paper { name: string; pageSize: string; landscape: boolean; content: { width: number; height: number } }
const LETTER_PORTRAIT: Paper = { name: "Letter portrait", pageSize: "Letter", landscape: false, content: { width: 739, height: 979 } };
const PAPERS: Paper[] = [
	LETTER_PORTRAIT,
	{ name: "A4 portrait", pageSize: "A4", landscape: false, content: { width: 717, height: 1046 } },
	{ name: "Letter landscape", pageSize: "Letter", landscape: true, content: { width: 979, height: 739 } },
];
/** The cap binds when the row keeps it and 80vh of the paper's content is under the span's 800 px. */
const binds = (paper: Paper, lift: boolean) => !lift && 0.8 * paper.content.height < 800;

interface Word { page: number; token: string | null; text: string | null; font: string | null; R: number; word: { x: number; y: number; w: number; h: number }; cross: { x: number; y: number } | null; dx: number | null; dy: number | null; ink: number }
interface Read { pages: number; words: Word[]; strays: Array<{ page: number; x0: number; y0: number; x1: number; y1: number; count: number }>; hl: number; spans: Array<{ page: number; h: number; x: number }>; inks: Array<{ page: number; cx: number; cy: number; count: number }> }
interface Held { html: string; zf: number; geom: Geom | null; at: Record<string, { x: number; y: number }>; strokes: number; embStrokes: number; strips: number; canvasShown: number;
	plant: string | null; cssBefore: string | null; cssBuilt: string | null; box: number;
	attr: { before: string | null; built: string | null }; emb: { before: string | null; built: string | null }; pdfs: number }
interface Desk { screen: { geom: Geom | null; zf: number }; at: Record<string, { x: number; y: number }>; strokes: number; embStrokes: number; plant: string | null; cssBefore: string | null; cssScreen: string | null;
	atScreen: { media: boolean; maxHeight: string | null; attr: string | null; emb: string | null; heldBlocks: number }; attr: { before: string | null }; emb: { before: string | null }; pdfs: number }
interface PrintRead { geom: Geom | null; zf: number; strips: number; canvasShown: number; box: number; css: string | null; attr: string | null; emb: string | null; shown: number }
interface DeskEnd { css: string | null; maxHeight: string | null; attr: string | null; emb: string | null }
interface Box { x0: number; y0: number; x1: number; y1: number }
type Boxes = Array<{ page: number; W: number; H: number; span: Box | null; inks: Array<Box & { cx: number; cy: number; count: number }> }>;
type W = Window & {
	sbExport(o: unknown): Promise<Held>; sbDesk(o: unknown): Promise<Desk>; sbFrames(): Promise<void>; sbPrintRead(): PrintRead; sbDeskEnd(): Promise<DeskEnd>; sbOuterFirst(): void;
	readPdf(u: string, t: string[], z: number): Promise<Read>; readBoxes(u: string): Promise<Boxes>;
};

let browser: Browser;
let bundle = "";
let appCss = "";
let stylesCss = "";
let reader: Page;
const pages = new Map<string, Page>();
const pdfs = new Map<string, Bytes>();
let pdfSeq = 0;
const errors: string[] = [];

/** A page with the app's head: the whole app.css of Obsidian 1.15.1, the plugin's styles.css, the instrument. */
async function pageFor(key: string, vp: { width: number; height: number }): Promise<Page> {
	const have = pages.get(key);
	if (have) return have;
	const p = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
	p.on("pageerror", error => errors.push(`${key}: ${error.message}`));
	await p.setContent("<!doctype html><html><head></head><body></body></html>");
	await p.addStyleTag({ content: appCss });
	await p.addStyleTag({ content: stylesCss });
	await p.addStyleTag({ content: INSTRUMENT_CSS });
	await p.addScriptTag({ content: `window.sbGeom = () => ${SB_GEOM};` });
	await p.addScriptTag({ content: bundle });
	pages.set(key, p);
	return p;
}

beforeAll(async () => {
	if (!HAVE_ASAR) return;
	if (OUT) mkdirSync(OUT, { recursive: true });
	const asar = readFileSync(ASAR);
	appCss = utf8(asarFile(asar, "app.css"));
	stylesCss = readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8");
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "exportPdfSameBlockPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) } });
	bundle = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
	const files: Record<string, { contentType: string; body: string | Bytes }> = {
		"/pdf.min.mjs": { contentType: "text/javascript", body: utf8(asarFile(asar, "lib/pdfjs/pdf.min.mjs")) },
		"/pdf.worker.min.mjs": { contentType: "text/javascript", body: utf8(asarFile(asar, "lib/pdfjs/pdf.worker.min.mjs")) },
		"/reader.html": { contentType: "text/html", body: `<!doctype html><html><body><script>window.activeWindow=window;window.activeDocument=document;</script><script type="module">${READER_JS}${BOX_JS}</script></body></html>` },
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

const label = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 60);
const r2n = (v: number) => Math.round(v * 100) / 100;

async function readPdf(pdf: Bytes, tokens: string[], zf: number, name: string): Promise<Read> {
	return (await readBoth(pdf, tokens, zf, name, false)).r;
}
/** The reader's read of one PDF, and with `boxes` cell b's read of it too. */
async function readBoth(pdf: Bytes, tokens: string[], zf: number, name: string, boxes = true): Promise<{ r: Read; boxes: Boxes | null }> {
	const path = `/pdf/${++pdfSeq}.pdf`;
	pdfs.set(path, pdf);
	if (OUT) writeFileSync(`${OUT}/${pdfSeq}-${label(name)}.pdf`, pdf);
	try {
		const url = `http://reader.test${path}`;
		const r = await reader.evaluate(([u, t, z]) => (window as unknown as W).readPdf(u, t, z), [url, tokens, zf] as const);
		return { r, boxes: boxes ? await reader.evaluate((u) => (window as unknown as W).readBoxes(u), url) : null };
	} finally {
		pdfs.delete(path);
	}
}

/** The string loaded as the native side loads it (scripts off), at the paper's content box, read in print media. */
async function parseGeom(html: string, vp: { width: number; height: number }): Promise<Geom | null> {
	const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: vp });
	try {
		const p = await ctx.newPage();
		await p.setContent(html);
		await p.emulateMedia({ media: "print" });
		return (await p.evaluate(SB_GEOM)) as Geom | null;
	} finally {
		await ctx.close();
	}
}

const pdfOptions = (paper: Paper) => ({ format: paper.pageSize, landscape: paper.landscape, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN }, printBackground: true, scale: 1 });

/** The native side's print, scripts off: the dialog's page size, orientation and margin, scale 1 (app.js @2682963-@2683128). */
async function printNative(html: string, paper: Paper): Promise<Bytes> {
	const ctx = await browser.newContext({ javaScriptEnabled: false });
	try {
		const p = await ctx.newPage();
		await p.setContent(html);
		await p.emulateMedia({ media: "print" });
		return await p.pdf(pdfOptions(paper));
	} finally {
		await ctx.close();
	}
}

/** Each marked word in the PDF: how often found, its page (1-based), cross less word centre in page px and in css px, its ink blobs. */
function printedRows(r: Read, zf: number, tokens: readonly string[] = TOKENS) {
	return tokens.map(t => {
		const ws = r.words.filter(x => x.token === t), w = ws[0];
		return { token: t, found: ws.length, page: w ? w.page + 1 : null, dx: w?.dx ?? null, dy: w?.dy ?? null,
			dyCss: w && w.dy !== null ? r2n(w.dy / zf) : null, ink: w?.ink ?? 0 };
	});
}
/**
 * Every ink blob of 40 px or more paired with the marked words by order down the pages, the k-th word from the top taking
 * the k-th blob: a cross outside its word's window still gets a row, with both pages. No rows when the counts differ.
 */
function byOrder(r: Read) {
	const ws = r.words.filter(w => w.token !== null).map(w => ({ token: w.token!, page: w.page, x: w.word.x, y: w.word.y })).sort((a, b) => a.page - b.page || a.y - b.y);
	const inks = [...r.inks].sort((a, b) => a.page - b.page || a.cy - b.cy);
	return { words: ws.length, inks: inks.length, rows: ws.length === inks.length
		? ws.map((w, k) => ({ token: w.token, wordPage: w.page + 1, inkPage: inks[k]!.page + 1, dx: r2n(inks[k]!.cx - w.x), dy: r2n(inks[k]!.cy - w.y) })) : null };
}
/**
 * The read's premise: each marked word found once in the PDF, and Pdfabove (above the span in its own block, the read's
 * zero) with one ink blob in its window and its cross within 1 page px. Pdfbelow's and Lastword's rows are the measure,
 * logged, not asserted.
 */
function expectRead(printed: ReturnType<typeof printedRows>, name: string) {
	const zero = printed[0]!;
	expect({ found: printed.map(w => w.found), zero: { ink: zero.ink, near: zero.dx !== null && zero.dy !== null && Math.abs(zero.dx) <= 1 && Math.abs(zero.dy) <= 1 } },
		`premise: ${name}: each marked word found once in the PDF (${printed.map(w => `${w.token} ${w.found}`).join(", ")}); Pdfabove, the read's zero, one ink blob in its window and its cross within 1 page px (dx ${zero.dx}, dy ${zero.dy})`)
		.toEqual({ found: printed.map(() => 1), zero: { ink: 1, near: true } });
}
/** The app's cap live in a read: the probe's max-height is 80vh of that read's viewport, within 0.5 px. */
const capLive = (g: Geom | null | undefined) => !!g?.span?.cap && Math.abs(Number.parseFloat(g.span.cap) - 0.8 * g.vh) <= 0.5;
/** One word against the bar: found once, one ink blob or more in its window, its cross on it within 1 page px across and down. */
function onWord(printed: ReturnType<typeof printedRows>, token: string) {
	const w = printed.find(x => x.token === token)!;
	return { found: w.found, ink: w.ink >= 1, near: w.dx !== null && w.dy !== null && Math.abs(w.dx) <= 1 && Math.abs(w.dy) <= 1 };
}
const wordLine = (printed: ReturnType<typeof printedRows>, token: string) => {
	const w = printed.find(x => x.token === token)!;
	return `${token} page ${w.page} dx ${w.dx} dy ${w.dy} (css ${w.dyCss}) ink ${w.ink}`;
};
/** The bar: each named word's cross on it; with `strays`, no ink outside every window. */
function expectOnWords(printed: ReturnType<typeof printedRows>, r: Read, name: string, tokens: string[], strays = true) {
	expect({ words: tokens.map(t => onWord(printed, t)), strays: strays ? r.strays.length : 0 },
		`bar: ${name}: ${tokens.map(t => wordLine(printed, t)).join("; ")}; ink outside every window ${r.strays.length}`)
		.toEqual({ words: tokens.map(() => ({ found: 1, ink: true, near: true })), strays: 0 });
}
const strips = (g: Geom | null | undefined) => MARKS.map(m => g?.words[m.id]?.strips ?? null);
const noErrors = () => expect(errors).toEqual([]);
const SAVED: Settings = { includeName: true, pageSize: "Letter", landscape: false, margin: "0", downscalePercent: 100 };
const settingsFor = (paper: Paper): Settings => ({ ...SAVED, pageSize: paper.pageSize, landscape: paper.landscape });

/** Phone and tablet: each paper, the cap kept then lifted, beside each other. */
const RUNS: Array<[string, Device, Paper, boolean]> = PAPERS.flatMap(paper => [false, true].flatMap(lift => (["phone", "tablet"] as const).map(
	(dev): [string, Device, Paper, boolean] => [`${paper.name}, cap ${lift ? "lifted" : "kept"}, ${dev}`, dev, paper, lift])));

itA.each(RUNS)("%s: the host's ink in the paragraph that holds a PDF embed, the row", async (name, dev, paper, lift) => {
	const vp = dev === "phone" ? PHONE : TABLET;
	const p = await pageFor(dev, vp);
	const settings = settingsFor(paper);
	const held = await p.evaluate((x) => (window as unknown as W).sbExport(x),
		{ source: SOURCE, sections: SECTIONS, marks: MARKS, column: vp.column, settings, lift });
	const zf = held.zf;
	const live = held.geom, parsed = await parseGeom(held.html, paper.content);
	// Read 1: each word against its own block's strip, the parse less the page; its block's and its own move against the root; css px.
	const moves = MARKS.map(m => {
		const a = live?.words[m.id], b = parsed?.words[m.id];
		const ok = !!a && !!b && a.x !== null && a.y !== null && b.x !== null && b.y !== null;
		return { token: m.token, dx: ok ? r2n((b!.x! - a!.x!) / zf) : null, dy: ok ? r2n((b!.y! - a!.y!) / zf) : null,
			block: a && b ? r2n((b.block - a.block) / zf) : null, word: a && b ? r2n((b.top - a.top) / zf) : null };
	});
	const spanDrop = live?.span && parsed?.span ? r2n((live.span.h - parsed.span.h) / zf) : null;
	// Read 2: Chromium's print.
	const r = await readPdf(await printNative(held.html, paper), TOKENS, zf, name);
	const printed = printedRows(r, zf);
	console.log("EXPORT-PDF-SAMEBLOCK ROWS", name, JSON.stringify({ kind: "mobile", dev, column: vp.column, zf, lift, binds: binds(paper, lift),
		print: { format: paper.pageSize, landscape: paper.landscape, margin: MARGIN, scale: 1, how: "page.pdf of the export's string, scripts off, print media" },
		read: { viewport: paper.content, how: "the string, scripts off, print media, at the paper's content box" },
		moves, spanDrop, span: { page: live?.span, parsed: parsed?.span }, printedSpans: r.spans, pages: r.pages, printed, order: byOrder(r), strays: r.strays, inks: r.inks,
		wordsAt: r.words.map(w => ({ token: w.token, page: w.page + 1, word: w.word, cross: w.cross, ink: w.ink })),
		vh: parsed?.vh, printMedia: parsed?.print, rootW: [live?.rootW, parsed?.rootW], strips: held.strips, strokes: held.strokes, canvasShown: held.canvasShown,
		live: live?.words, parsedWords: parsed?.words, at: held.at, plant: held.plant, cssBuilt: held.cssBuilt, cssParsed: parsed?.span?.css, cap: parsed?.span?.cap }));
	expect({ strokes: held.strokes, live: strips(live), parsed: strips(parsed), printMedia: parsed?.print ?? null, vh: parsed?.vh ?? null,
		canvasShown: held.canvasShown, kids: [live?.span?.kids ?? null, parsed?.span?.kids ?? null], plant: held.plant, cap: capLive(parsed) },
		`premise: ${name}: six cross strokes, one strip in each marked word's block on the page and after the parse, the parse in print media at ${paper.content.height} px tall, no canvas showing, the span empty, the plant ${lift ? "on" : "off"} before the export, the app's cap live in the parse (${parsed?.span?.cap})`)
		.toEqual({ strokes: 6, live: [1, 1, 1], parsed: [1, 1, 1], printMedia: true, vh: paper.content.height, canvasShown: 0, kids: [0, 0], plant: lift ? "none" : "", cap: true });
	const bind = binds(paper, lift);
	if (!bind) expect(spanDrop !== null && Math.abs(spanDrop) <= 0.5,
		`premise: ${name}: the print cap cannot bind: the span ${live?.span?.h} px on the page, ${parsed?.span?.h} px after the parse (max-height ${parsed?.span?.maxHeight}), drop ${spanDrop} css px`).toBe(true);
	expectRead(printed, name);
	expectOnWords(printed, r, name, ["Pdfbelow", "Lastword"]);
	noErrors();
}, T);

/** Desktop: Letter portrait, the cap kept then lifted. */
const DESK_RUNS: Array<[string, Paper, boolean]> = [false, true].map(lift => [`desktop, ${LETTER_PORTRAIT.name}, cap ${lift ? "lifted" : "kept"}`, LETTER_PORTRAIT, lift]);

itA.each(DESK_RUNS)("%s: the host's ink in the paragraph that holds a PDF embed, the row", async (name, paper, lift) => {
	const p = await pageFor(`desktop-${paper.name}`, paper.content);
	const settings = settingsFor(paper);
	const mounted = await p.evaluate((x) => (window as unknown as W).sbDesk(x),
		{ source: SOURCE, sections: SECTIONS, marks: MARKS, column: TABLET.column, settings, lift });
	await p.emulateMedia({ media: "print" });
	await p.evaluate(() => (window as unknown as W).sbFrames());
	const during = await p.evaluate(() => (window as unknown as W).sbPrintRead());
	const pdf = await p.pdf(pdfOptions(paper));
	await p.emulateMedia({ media: "screen" });
	const end = await p.evaluate(() => (window as unknown as W).sbDeskEnd());
	const zf = during.zf, screen = mounted.screen;
	const spanDrop = screen.geom?.span && during.geom?.span ? r2n(screen.geom.span.h / screen.zf - during.geom.span.h / zf) : null;
	const r = await readPdf(pdf, TOKENS, zf, name);
	const printed = printedRows(r, zf);
	console.log("EXPORT-PDF-SAMEBLOCK ROWS", name, JSON.stringify({ kind: "desktop", column: TABLET.column, zf, screenZf: screen.zf, lift, binds: binds(paper, lift),
		print: { format: paper.pageSize, landscape: paper.landscape, margin: MARGIN, scale: 1, how: "page.pdf of the live page after beforeprint and print media, viewport the paper's content box" },
		spanDrop, span: { page: screen.geom?.span, print: during.geom?.span }, printedSpans: r.spans, pages: r.pages, printed, order: byOrder(r), strays: r.strays, inks: r.inks,
		wordsAt: r.words.map(w => ({ token: w.token, page: w.page + 1, word: w.word, cross: w.cross, ink: w.ink })),
		vh: during.geom?.vh, printMedia: during.geom?.print, strips: during.strips, strokes: mounted.strokes, canvasShown: during.canvasShown,
		screenWords: screen.geom?.words, printWords: during.geom?.words, at: mounted.at,
		plant: mounted.plant, css: { before: mounted.cssBefore, screen: mounted.cssScreen, print: during.css, after: end.css }, cap: during.geom?.span?.cap }));
	expect({ strokes: mounted.strokes, print: strips(during.geom), printMedia: during.geom?.print ?? null, vh: during.geom?.vh ?? null,
		canvasShown: during.canvasShown, kids: [screen.geom?.span?.kids ?? null, during.geom?.span?.kids ?? null], plant: mounted.plant, cap: capLive(during.geom) },
		`premise: ${name}: six cross strokes, one strip in each marked word's block in print media at ${paper.content.height} px tall, no canvas showing, the span empty, the plant ${lift ? "on" : "off"} before the export, the app's cap live in print media (${during.geom?.span?.cap})`)
		.toEqual({ strokes: 6, print: [1, 1, 1], printMedia: true, vh: paper.content.height, canvasShown: 0, kids: [0, 0], plant: lift ? "none" : "", cap: true });
	const bind = binds(paper, lift);
	if (!bind) expect(spanDrop !== null && Math.abs(spanDrop) <= 0.5,
		`premise: ${name}: the print cap cannot bind: the span ${screen.geom?.span?.h} px on screen, ${during.geom?.span?.h} px in print media (max-height ${during.geom?.span?.maxHeight}), drop ${spanDrop} css px`).toBe(true);
	expectRead(printed, name);
	expectOnWords(printed, r, name, ["Pdfbelow", "Lastword"]);
	noErrors();
}, T);

/*
 * Cells b to e: one export each, phone and tablet as the rows above replay theirs,
 * desktop as the desktop rows mount theirs; one EXPORT-PDF-PRINTCAP ROWS line per run.
 */
type Where = Device | "desktop";
/**
 * A cell's test-side options. column: the column width (desktop 700, phone and tablet their own, by default). percent: the
 * dialog's downscale (100). marks: the ids of the marked words that get a cross (all three). embed: an embedded note as its
 * own block after block 0 (pdf: a PDF embed in it; ink: a cross on each of its two marked words; style: its PDF span's raw
 * style attribute). spanStyle: block 0's span's raw style attribute. viewer: "built" or "late" (cell g). twoPdf: two PDF
 * embeds in block 0, in a blockquote (cell f8). hideBlock: a last block print media hides (cell c869). late: desktop, no
 * beforeprint (cell c-late). twice: desktop, beforeprint twice. outerFirst: desktop, the host's root taken off first, then
 * the embedded note's, in print media after the print.
 */
interface Opts { lift?: boolean; own?: string; spanInk?: number; noColumn?: boolean; noInk?: boolean; noTitle?: boolean;
	column?: number; percent?: number; marks?: string[]; embed?: { pdf?: boolean; ink?: boolean; style?: string }; spanStyle?: string;
	viewer?: "built" | "late"; twoPdf?: boolean; hideBlock?: boolean; late?: boolean; twice?: boolean; outerFirst?: boolean; noBelow?: boolean }
interface Run {
	where: Where; paper: Paper; zf: number; pageZf: number; strokes: number; embStrokes: number;
	/** Phone and tablet: on the page after the build. Desktop: on screen, before beforeprint. */
	page: Geom | null;
	/** Phone and tablet: the export's string parsed in print media. Desktop: in print media as it prints. */
	print: Geom | null;
	strips: number; canvasShown: number; plant: string | null; pdfs: number;
	css: { before: string | null; built?: string | null; screen?: string | null; print: string | null; after?: string | null; afterMax?: string | null };
	/** The span's style attribute, byte for byte (null: none): before the export, at the end of the desktop's screen call, in print, after. */
	attr: { before: string | null; atScreen?: string | null; built?: string | null; print: string | null; after?: string | null };
	/** The embedded note's PDF span's style attribute, likewise. */
	emb: { before: string | null; print: string | null; after?: string | null };
	atScreen: Desk["atScreen"] | null; shown: number | null;
	r: Read; boxes: Boxes; printed: ReturnType<typeof printedRows>; at: Record<string, { x: number; y: number }>;
}
const EMB_TOKENS = ["Embabove", "Embbelow"];
async function exportRun(where: Where, paper: Paper, x: Opts, name: string): Promise<Run> {
	// noTitle: the dialog's file name off, so the export holds no title.
	const settings: Settings = { ...settingsFor(paper), includeName: !x.noTitle, downscalePercent: x.percent ?? 100 };
	const marks = x.marks ? MARKS.filter(m => x.marks!.includes(m.id)) : MARKS;
	const own = x.noBelow ? TOKENS.filter(t => t !== "Pdfbelow") : TOKENS;
	const tokens = x.embed ? [...own, ...EMB_TOKENS] : own;
	const o = { source: SOURCE, sections: SECTIONS, settings, ...x, marks };
	if (where === "desktop") {
		const p = await pageFor(`desktop-${paper.name}`, paper.content);
		const mounted = await p.evaluate((v) => (window as unknown as W).sbDesk(v), { ...o, column: x.column ?? TABLET.column });
		await p.emulateMedia({ media: "print" });
		await p.evaluate(() => (window as unknown as W).sbFrames());
		const during = await p.evaluate(() => (window as unknown as W).sbPrintRead());
		const pdf = await p.pdf(pdfOptions(paper));
		if (x.outerFirst) await p.evaluate(() => (window as unknown as W).sbOuterFirst());
		await p.emulateMedia({ media: "screen" });
		const end = await p.evaluate(() => (window as unknown as W).sbDeskEnd());
		const { r, boxes } = await readBoth(pdf, tokens, during.zf, name);
		return { where, paper, zf: during.zf, pageZf: mounted.screen.zf, strokes: mounted.strokes, embStrokes: mounted.embStrokes, page: mounted.screen.geom, print: during.geom,
			strips: during.strips, canvasShown: during.canvasShown, plant: mounted.plant, pdfs: mounted.pdfs,
			css: { before: mounted.cssBefore, screen: mounted.cssScreen, print: during.css, after: end.css, afterMax: end.maxHeight },
			attr: { before: mounted.attr.before, atScreen: mounted.atScreen.attr, print: during.attr, after: end.attr },
			emb: { before: mounted.emb.before, print: during.emb, after: end.emb }, atScreen: mounted.atScreen, shown: during.shown,
			r, boxes: boxes!, printed: printedRows(r, during.zf, tokens), at: mounted.at };
	}
	const vp = where === "phone" ? PHONE : TABLET;
	const p = await pageFor(where, vp);
	const held = await p.evaluate((v) => (window as unknown as W).sbExport(v), { ...o, column: x.column ?? vp.column });
	const parsed = await parseGeom(held.html, paper.content);
	const { r, boxes } = await readBoth(await printNative(held.html, paper), tokens, held.zf, name);
	return { where, paper, zf: held.zf, pageZf: held.zf, strokes: held.strokes, embStrokes: held.embStrokes, page: held.geom, print: parsed, strips: held.strips,
		canvasShown: held.canvasShown, plant: held.plant, pdfs: held.pdfs, css: { before: held.cssBefore, built: held.cssBuilt, print: parsed?.span?.css ?? null },
		attr: { before: held.attr.before, built: held.attr.built, print: parsed?.span?.attr ?? null }, emb: { before: held.emb.before, print: held.emb.built },
		atScreen: null, shown: null, r, boxes: boxes!, printed: printedRows(r, held.zf, tokens), at: held.at };
}
/** The span's page height less its print height, css px. */
const dropOf = (u: Run) => u.page?.span && u.print?.span ? r2n(u.page.span.h / u.pageZf - u.print.span.h / u.zf) : null;
function logRun(cell: string, name: string, x: Opts, u: Run, extra: Record<string, unknown> = {}) {
	console.log("EXPORT-PDF-PRINTCAP ROWS", name, JSON.stringify({ cell, where: u.where, paper: u.paper.name, opts: x, zf: u.zf, pageZf: u.pageZf, strokes: u.strokes,
		embStrokes: u.embStrokes, pdfs: u.pdfs, attr: u.attr, emb: u.emb, atScreen: u.atScreen, shown: u.shown, strips: u.strips, wordStrips: { page: strips(u.page), print: strips(u.print) }, box: { page: u.page?.box ?? null, print: u.print?.box ?? null },
		canvasShown: u.canvasShown, plant: u.plant, css: u.css, span: { page: u.page?.span, print: u.print?.span }, spanDrop: dropOf(u),
		vh: u.print?.vh, printMedia: u.print?.print, pages: u.r.pages, printed: u.printed, strays: u.r.strays, inks: u.r.inks, printedSpans: u.r.spans, boxes: u.boxes,
		wordsAt: u.r.words.map(w => ({ token: w.token, page: w.page + 1, word: w.word, cross: w.cross, ink: w.ink })), at: u.at, ...extra }));
}
const LETTER_LANDSCAPE = PAPERS[2]!;
const WHERE: Where[] = ["phone", "tablet", "desktop"];
/** Cell b's cross: 650 px down the span's 800, under the 591 px the cap leaves on Letter landscape. */
const SPAN_INK = 650;
/**
 * b: the three words' crosses and the cross over the span. b-span: the cross over the span alone, so the only ink below
 * the embed's top is over the embed itself (Pdfbelow's and Lastword's crosses sit below the span's top too).
 */
const B_RUNS: Array<[string, Where, Opts]> = [
	...WHERE.map((w): [string, Where, Opts] => [`b: ${LETTER_LANDSCAPE.name}, cap kept, ink over the embed's lower part, ${w}`, w, { spanInk: SPAN_INK }]),
	...WHERE.map((w): [string, Where, Opts] => [`b-span: ${LETTER_LANDSCAPE.name}, cap kept, the cross over the embed's lower part as the note's only ink, ${w}`, w,
		{ spanInk: SPAN_INK, marks: [] }]),
];

itA.each(B_RUNS)("%s", async (name, where, x) => {
	const only = x.marks?.length === 0;
	const u = await exportRun(where, LETTER_LANDSCAPE, x, name);
	// The cross over the span: the ink blobs right of every word's window (the words' crosses sit on each line's first word).
	const right = Math.max(...u.r.words.map(w => w.word.x + w.word.w / 2 + w.word.h + 4 * u.zf));
	const over = u.boxes.flatMap(b => b.inks.filter(k => k.cx > right).map(k => ({ page: b.page, ink: k, span: b.span })));
	const one = over.length === 1 ? over[0]! : null;
	const inside = one && one.span ? { x0: one.ink.x0 >= one.span.x0 - 1, y0: one.ink.y0 >= one.span.y0 - 1, x1: one.ink.x1 <= one.span.x1 + 1, y1: one.ink.y1 <= one.span.y1 + 1 } : null;
	logRun(only ? "b-span" : "b", name, x, u, { right: r2n(right), over, inside, offset: one?.span ? r2n(one.ink.cy - one.span.y0) : null });
	expect({ strokes: u.strokes, printMedia: u.print?.print ?? null, vh: u.print?.vh ?? null, canvasShown: u.canvasShown, plant: u.plant, cap: capLive(u.print), over: over.length },
		`premise: ${name}: ${only ? "two" : "eight"} cross strokes, print media at ${LETTER_LANDSCAPE.content.height} px tall, no canvas showing, no plant, the app's cap live (${u.print?.span?.cap}), one ink blob right of every word's window (${over.length})`)
		.toEqual({ strokes: only ? 2 : 8, printMedia: true, vh: LETTER_LANDSCAPE.content.height, canvasShown: 0, plant: "", cap: true, over: 1 });
	// b-span has no cross on Pdfabove, so no read's zero: each marked word found once is its read premise.
	if (only) expect(u.printed.map(w => w.found), `premise: ${name}: each marked word found once in the PDF (${u.printed.map(w => `${w.token} ${w.found}`).join(", ")})`)
		.toEqual(u.printed.map(() => 1));
	else expectRead(u.printed, name);
	expect(inside, `bar b: ${name}: the cross over the span, ink box ${JSON.stringify(one?.ink)} on page ${one ? one.page + 1 : null}, inside the embed's printed box there ${JSON.stringify(one?.span)} within 1 page px`)
		.toEqual({ x0: true, y0: true, x1: true, y1: true });
	noErrors();
}, T);

/**
 * Cell c, no strips cut: the export without its title, so the whole note prints on page 1 (a premise) and no page break is
 * at stake: the one box is not cut per block, so a block that moves to the next page leaves its ink behind with the cap or
 * without it. The control c0 (title on, the cap lifted by the plant, logged, no bar) shows that page break alone.
 * Two legs, told apart by the blocks the screen call held (`position: relative` inline at its end):
 *   c (:865): no column width wired, so no spans are held at the screen call (:755-757) and none at the cut (:865); none held.
 *   c869 (:869, desktop): spans held at the screen call, then a last block print media hides (the instrument's
 *   .sb-noprint), so the cut finds another block count and keeps the one box (:869); all three held.
 *   c-late (desktop): no beforeprint, the print media first (a path that only flips the media, a root that attaches
 *   mid-print): only the print-media call runs, after the print took its page count. Logged, no bar (no hold is
 *   set there).
 */
const heldBlocks = (u: Run) => u.atScreen?.heldBlocks ?? null;
/** Cell c's note: no Pdfbelow line (the note then fits page 1 with the span at 800 px), crosses on Pdfabove and Lastword. */
const C_NOTE: Opts = { noBelow: true, marks: ["w-above", "w-last"], noTitle: true };
const C_RUNS: Array<[string, Where, Opts]> = [
	...WHERE.map((w): [string, Where, Opts] => [`c: ${LETTER_PORTRAIT.name}, cap kept, no column width (no strips cut, :865), no title, no Pdfbelow line, ${w}`, w, { ...C_NOTE, noColumn: true }]),
	[`c0: ${LETTER_PORTRAIT.name}, cap lifted (the plant), no column width (no strips cut), title on, phone; a control, logged`, "phone", { noColumn: true, lift: true }],
	[`c0: ${LETTER_PORTRAIT.name}, cap lifted (the plant), no column width (no strips cut, :865), no title, no Pdfbelow line, desktop; a control, logged`, "desktop", { ...C_NOTE, noColumn: true, lift: true }],
	[`c869: ${LETTER_PORTRAIT.name}, cap kept, a block print hides (no strips cut, :869), no title, no Pdfbelow line, desktop`, "desktop", { ...C_NOTE, hideBlock: true }],
];
itA.each(C_RUNS)("%s", async (name, where, x) => {
	const u = await exportRun(where, LETTER_PORTRAIT, x, name);
	const cell = x.lift ? "c0" : x.hideBlock ? "c869" : "c";
	logRun(cell, name, x, u);
	const below = !x.noBelow;
	expect({ strokes: u.strokes, strips: u.strips, wordStrips: strips(u.print), box: u.print?.box ?? null, printMedia: u.print?.print ?? null, vh: u.print?.vh ?? null,
		canvasShown: u.canvasShown, plant: u.plant, cap: capLive(u.print), ...(where === "desktop" ? { held: heldBlocks(u), shown: u.shown } : {}) },
		`premise: ${name}: ${below ? "six" : "four"} cross strokes, no strip cut (${u.strips}; in each marked word's block ${JSON.stringify(strips(u.print))}), the one ink box shown in print, print media at ${LETTER_PORTRAIT.content.height} px tall, no canvas showing, the plant ${x.lift ? "on" : "off"}, the app's cap live (${u.print?.span?.cap})${where === "desktop" ? `, blocks held at the screen call ${heldBlocks(u)}, blocks laid out in print ${u.shown}` : ""}`)
		.toEqual({ strokes: below ? 6 : 4, strips: 0, wordStrips: [0, below ? 0 : null, 0], box: 1, printMedia: true, vh: LETTER_PORTRAIT.content.height, canvasShown: 0, plant: x.lift ? "none" : "", cap: true,
			...(where === "desktop" ? { held: x.hideBlock ? 3 : 0, shown: 2 } : {}) });
	expectRead(u.printed, name);
	if (x.lift) return noErrors();
	expect(u.printed.map(w => w.page), `premise: ${name}: every marked word prints on page 1 (${u.printed.map(w => `${w.token} ${w.page}`).join(", ")})`).toEqual(u.printed.map(() => 1));
	expectOnWords(u.printed, u.r, name, ["Lastword"], false);
	noErrors();
}, T);

itA(`c-late: ${LETTER_PORTRAIT.name}, cap kept, print media first (no beforeprint), no title, no Pdfbelow line, desktop; logged`, async () => {
	const name = `c-late: ${LETTER_PORTRAIT.name}, cap kept, print media first, no title, no Pdfbelow line, desktop`;
	const x: Opts = { ...C_NOTE, late: true };
	const u = await exportRun("desktop", LETTER_PORTRAIT, x, name);
	logRun("c-late", name, x, u, { rows: ["Lastword"].map(t => wordLine(u.printed, t)) });
	expect({ strokes: u.strokes, strips: u.strips, box: u.print?.box ?? null, printMedia: u.print?.print ?? null, held: heldBlocks(u), atScreenMedia: u.atScreen?.media ?? null, cap: capLive(u.print) },
		`premise: ${name}: four cross strokes, no strip cut (${u.strips}), the one ink box in print, print media, no block held before the media flipped, the app's cap live`)
		.toEqual({ strokes: 4, strips: 0, box: 1, printMedia: true, held: 0, atScreenMedia: false, cap: true });
	expectRead(u.printed, name);
	noErrors();
}, T);

/**
 * Cell d and its two other forms: the embed prints as at base where no ink is at stake.
 *   d: no ink at all, the root still attached.
 *   d2: the host has no ink of its own; an embedded note after block 0 has ink (a cross on each of its words); the PDF is
 *       in the host's block 0. The embedded note's layer moves with its block.
 *   d3: the host's ink only above the embed (one cross, on Pdfabove).
 * Bar: in print the span has no inline max-height, and the app's cap binds as with no plugin (the span over 5 css px
 * shorter in print than on the page). Letter portrait.
 */
const D_RUNS: Array<[string, Where, Opts]> = [
	...WHERE.map((w): [string, Where, Opts] => [`d: ${LETTER_PORTRAIT.name}, no ink, ${w}`, w, { noInk: true }]),
	...(["phone", "desktop"] as const).map((w): [string, Where, Opts] => [`d2: ${LETTER_PORTRAIT.name}, the host no ink, an inked embedded note after the PDF's block, ${w}`, w, { noInk: true, embed: { ink: true } }]),
	...(["phone", "desktop"] as const).map((w): [string, Where, Opts] => [`d3: ${LETTER_PORTRAIT.name}, the host's ink only above the embed (Pdfabove), ${w}`, w, { marks: ["w-above"] }]),
];
itA.each(D_RUNS)("%s", async (name, where, x) => {
	const u = await exportRun(where, LETTER_PORTRAIT, x, name);
	const drop = dropOf(u);
	const cell = x.embed ? "d2" : x.marks ? "d3" : "d";
	logRun(cell, name, x, u, { drop });
	const want = { strokes: x.noInk ? 0 : 2, embStrokes: x.embed ? 4 : 0, found: u.printed.map(() => 1), printMedia: true, vh: LETTER_PORTRAIT.content.height, plant: "", kids: [0, 0], cap: true };
	expect({ strokes: u.strokes, embStrokes: u.embStrokes, found: u.printed.map(w => w.found), printMedia: u.print?.print ?? null,
		vh: u.print?.vh ?? null, plant: u.plant, kids: [u.page?.span?.kids ?? null, u.print?.span?.kids ?? null], cap: capLive(u.print) },
		`premise: ${name}: ${want.strokes} host strokes, ${want.embStrokes} in the embedded note, each marked word found once in the PDF, print media at ${LETTER_PORTRAIT.content.height} px tall, no plant, the span empty, the app's cap live (${u.print?.span?.cap})`)
		.toEqual(want);
	if (cell === "d") expect({ strips: u.strips, box: [u.page?.box ?? null, u.print?.box ?? null] }, `premise: ${name}: no strip, no ink box`).toEqual({ strips: 0, box: [0, 0] });
	if (cell === "d3") expectRead(u.printed, name);
	expect({ inline: u.print?.span?.inline ?? null, binds: drop !== null && drop > 5 },
		`bar d: ${name}: in print the span has no inline max-height ("${u.print?.span?.inline}", cssText "${u.print?.span?.css}") and the app's cap binds as with no plugin: ${u.page?.span?.h} px on the page, ${u.print?.span?.h} px in print (max-height ${u.print?.span?.maxHeight}), drop ${drop} css px`)
		.toEqual({ inline: "", binds: true });
	noErrors();
}, T);

/**
 * Control m0, logged, no bar: d2's note (the host no ink, an inked embedded note after the PDF's block) with the host's cap
 * lifted by the plant, and A4 (the cap cannot bind) with it kept: the embedded note's crosses against its words, so a row
 * off in d2 is told from the cap or from something else.
 */
const M0_RUNS: Array<[string, Where, Paper, Opts]> = (["phone", "desktop"] as const).flatMap((w): Array<[string, Where, Paper, Opts]> => [
	[`m0: ${LETTER_PORTRAIT.name}, d2's note, the host's cap lifted (the plant), ${w}; a control, logged`, w, LETTER_PORTRAIT, { noInk: true, embed: { ink: true }, lift: true }],
	[`m0: ${PAPERS[1]!.name}, d2's note, the cap kept (it cannot bind), ${w}; a control, logged`, w, PAPERS[1]!, { noInk: true, embed: { ink: true } }],
]);
itA.each(M0_RUNS)("%s", async (name, where, paper, x) => {
	const u = await exportRun(where, paper, x, name);
	logRun("m0", name, x, u, { rows: EMB_TOKENS.map(t => wordLine(u.printed, t)) });
	expect({ strokes: u.strokes, embStrokes: u.embStrokes, found: u.printed.map(w => w.found), printMedia: u.print?.print ?? null },
		`premise: ${name}: no host stroke, four in the embedded note, each marked word found once, print media`)
		.toEqual({ strokes: 0, embStrokes: 4, found: u.printed.map(() => 1), printMedia: true });
	noErrors();
}, T);

/**
 * Cell e: the span's style attribute after the export, byte for byte. Desktop, Letter portrait, with ink:
 * no style; its own max-height 600px (its value also stands in print, unrewritten); a raw "height:1000px" (f3's span,
 * written as an attribute, so a CSSOM rewrite shows as "height: 1000px;"); the 1b plant (its value still none after);
 * the raw "height:1000px" with beforeprint twice; two roots that can hold one span (an inked embedded note that holds a PDF,
 * its span's raw "height:800px", inside an inked host), the host's root taken off first, then the embedded note's. Tablet,
 * its own 600px: the export's string carries the span's own cssText.
 */
const E_RUNS: Array<[string, Where, Opts, string | null]> = [
	[`e: desktop, ${LETTER_PORTRAIT.name}, with ink, the span with no inline style`, "desktop", {}, null],
	[`e: desktop, ${LETTER_PORTRAIT.name}, with ink, the span's own max-height 600px`, "desktop", { own: "600px" }, "max-height: 600px;"],
	[`e: desktop, ${LETTER_PORTRAIT.name}, with ink, the span's raw style height:1000px`, "desktop", { spanStyle: "height:1000px" }, "height:1000px"],
	[`e: desktop, ${LETTER_PORTRAIT.name}, with ink, the 1b plant max-height none`, "desktop", { lift: true }, "max-height: none;"],
	[`e: desktop, ${LETTER_PORTRAIT.name}, with ink, the span's raw style height:1000px, beforeprint twice`, "desktop", { spanStyle: "height:1000px", twice: true }, "height:1000px"],
	[`e: desktop, ${LETTER_PORTRAIT.name}, with ink, two roots: an inked embedded note's PDF (raw height:800px) in an inked host, host off first`, "desktop",
		{ embed: { pdf: true, ink: true, style: "height:800px" }, outerFirst: true }, null],
	[`e: tablet, ${LETTER_PORTRAIT.name}, with ink, the span's own max-height 600px`, "tablet", { own: "600px" }, "max-height: 600px;"],
];
itA.each(E_RUNS)("%s", async (name, where, x, before) => {
	const u = await exportRun(where, LETTER_PORTRAIT, x, name);
	logRun("e", name, x, u);
	expect({ strokes: u.strokes, embStrokes: u.embStrokes, before: u.attr.before, embBefore: x.embed ? u.emb.before : null, printMedia: u.print?.print ?? null, vh: u.print?.vh ?? null, cap: capLive(u.print) },
		`premise: ${name}: six cross strokes${x.embed ? " and four in the embedded note" : ""}, the span's style attribute before the export ${JSON.stringify(u.attr.before)}${x.embed ? `, the embedded note's PDF's ${JSON.stringify(u.emb.before)}` : ""}, print media at ${LETTER_PORTRAIT.content.height} px tall, the app's cap live (${u.print?.span?.cap})`)
		.toEqual({ strokes: 6, embStrokes: x.embed ? 4 : 0, before, embBefore: x.embed ? x.embed.style ?? null : null, printMedia: true, vh: LETTER_PORTRAIT.content.height, cap: true });
	if (where === "desktop") {
		const own = x.own ?? (x.lift ? "none" : undefined);
		expect({ after: u.attr.after, afterMax: u.css.afterMax, ...(own ? { print: u.attr.print } : {}), ...(x.embed ? { emb: u.emb.after } : {}) },
			`bar e: ${name}: the span's style attribute before the export ${JSON.stringify(u.attr.before)}, at the end of the screen call ${JSON.stringify(u.attr.atScreen)}, in print ${JSON.stringify(u.attr.print)}, after afterprint ${JSON.stringify(u.attr.after)} (max-height ${u.css.afterMax})${x.embed ? `; the embedded note's PDF's before ${JSON.stringify(u.emb.before)}, in print ${JSON.stringify(u.emb.print)}, after ${JSON.stringify(u.emb.after)}` : ""}`)
			.toEqual({ after: u.attr.before, afterMax: own ?? "none", ...(own ? { print: u.attr.before } : {}), ...(x.embed ? { emb: u.emb.before } : {}) });
	} else {
		expect({ string: u.css.print },
			`bar e: ${name}: the export's string carries the span's own cssText: before "${u.css.before}", after the build "${u.css.built}", in the string "${u.css.print}"`)
			.toEqual({ string: u.css.before });
	}
	noErrors();
}, T);

/** Cell f1: desktop, at the end of the beforeprint call, before the media flips, the hold is on the span. */
itA.each([LETTER_PORTRAIT, LETTER_LANDSCAPE].map((paper): [string, Paper] => [`f1: desktop, ${paper.name}, cap kept, the hold at the screen call`, paper]))("%s", async (name, paper) => {
	const x: Opts = {};
	const u = await exportRun("desktop", paper, x, name);
	logRun("f1", name, x, u);
	expect({ strokes: u.strokes, held: heldBlocks(u), cap: capLive(u.print) }, `premise: ${name}: six cross strokes, both blocks held at the screen call (${heldBlocks(u)}), the app's cap live in print`)
		.toEqual({ strokes: 6, held: 2, cap: true });
	expect({ media: u.atScreen?.media ?? null, maxHeight: u.atScreen?.maxHeight ?? null },
		`bar f1: ${name}: at the end of the beforeprint call, print media ${u.atScreen?.media}, the span's inline max-height "${u.atScreen?.maxHeight}" (attribute ${JSON.stringify(u.atScreen?.attr)})`)
		.toEqual({ media: false, maxHeight: "none" });
	noErrors();
}, T);

/**
 * More rows of cell a's shape: Letter portrait unless named, the cap kept. Premise: the strokes,
 * print media at the paper's content height, no canvas showing, the app's cap live, every marked word found once, the
 * read's zero (Pdfabove) on its word; per row its own premise. Bar: the named words' crosses on their words within 1 page
 * px, no ink outside every window.
 *   f3 (#height): the span's raw style height:1000px (a stand-in for #height=1000), phone, tablet, desktop; and
 *      height:400px, where the cap cannot bind (also: the span's print height within 0.5 css px of its page height).
 *   f6: zoom under 1: desktop with a 900 px column (the paper's 739 px: the fit's zoom about 0.82); a phone at 70 %.
 *   f8: two PDF embeds in block 0, one under the other, a level down in the block (a div in its div); desktop, phone.
 *   m: an inked embedded note with its own PDF embed, the host's ink only on Pdfabove; desktop, phone. Bar: Embbelow's
 *      row less Embabove's (the embedded note's zero, above its PDF) within 1 page px, each with ink, no strays.
 *   g: the PDF's viewer built (its toolbar and page container in the span); desktop, phone, tablet; and its
 *      divs entering after the zoom's build (phone, tablet). Phone and tablet need linesToHold (EmbedInkMobileExport.ts) in the tree:
 *      without it they skip, with a loud line.
 */
const HOLDS_DIV_LINES = readFileSync(fileURLToPath(new URL("../../src/inline/EmbedInkMobileExport.ts", import.meta.url)), "utf8").includes("function linesToHold");
if (!HOLDS_DIV_LINES) console.log("EXPORT-PDF-PRINTCAP SKIP: linesToHold (EmbedInkMobileExport.ts) is not in this tree; cell g's phone and tablet rows are skipped");
interface RowCell { cell: string; where: Where; paper: Paper; x: Opts; bar: string[]; skip?: boolean }
const ROW_CELLS: RowCell[] = [
	...WHERE.map((where): RowCell => ({ cell: "f3", where, paper: LETTER_PORTRAIT, x: { spanStyle: "height:1000px" }, bar: ["Pdfbelow", "Lastword"] })),
	...(["phone", "desktop"] as const).map((where): RowCell => ({ cell: "f3-400", where, paper: LETTER_PORTRAIT, x: { spanStyle: "height:400px" }, bar: ["Pdfbelow", "Lastword"] })),
	{ cell: "f6", where: "desktop", paper: LETTER_PORTRAIT, x: { column: 900 }, bar: ["Pdfbelow", "Lastword"] },
	{ cell: "f6", where: "phone", paper: LETTER_PORTRAIT, x: { percent: 70 }, bar: ["Pdfbelow", "Lastword"] },
	...(["phone", "desktop"] as const).map((where): RowCell => ({ cell: "f8", where, paper: LETTER_PORTRAIT, x: { twoPdf: true }, bar: ["Pdfbelow", "Lastword"] })),
	...(["phone", "desktop"] as const).map((where): RowCell => ({ cell: "m", where, paper: LETTER_PORTRAIT, x: { marks: ["w-above"], embed: { pdf: true, ink: true } }, bar: EMB_TOKENS })),
	...WHERE.map((where): RowCell => ({ cell: "g", where, paper: LETTER_PORTRAIT, x: { viewer: "built" }, bar: ["Pdfbelow", "Lastword"], skip: where !== "desktop" && !HOLDS_DIV_LINES })),
	...(["phone", "tablet"] as const).map((where): RowCell => ({ cell: "g-late", where, paper: LETTER_PORTRAIT, x: { viewer: "late" }, bar: ["Pdfbelow", "Lastword"], skip: !HOLDS_DIV_LINES })),
];
const rowName = (c: RowCell) => `${c.cell}: ${c.paper.name}, cap kept, ${JSON.stringify(c.x)}, ${c.where}`;
for (const c of ROW_CELLS) {
	(c.skip ? it.skip : itA)(rowName(c), async () => {
		const name = rowName(c);
		const u = await exportRun(c.where, c.paper, c.x, name);
		const drop = dropOf(u);
		logRun(c.cell, name, c.x, u, { drop, rows: c.bar.map(t => wordLine(u.printed, t)) });
		const strokes = 2 * (c.x.marks?.length ?? MARKS.length);
		const kids = c.x.viewer ? 2 : 0;
		expect({ strokes: u.strokes, embStrokes: u.embStrokes, printMedia: u.print?.print ?? null, vh: u.print?.vh ?? null, canvasShown: u.canvasShown, cap: capLive(u.print), plant: u.plant,
			pdfs: u.pdfs, kids: u.page?.span?.kids ?? null },
			`premise: ${name}: ${strokes} host strokes${c.x.embed ? " and four in the embedded note" : ""}, print media at ${c.paper.content.height} px tall, no canvas showing, the app's cap live (${u.print?.span?.cap}), no plant, ${c.x.twoPdf ? 2 : c.x.embed?.pdf ? 2 : 1} PDF spans, ${kids} children in the span on the page`)
			.toEqual({ strokes, embStrokes: c.x.embed?.ink ? 4 : 0, printMedia: true, vh: c.paper.content.height, canvasShown: 0, cap: true, plant: "",
				pdfs: c.x.twoPdf || c.x.embed?.pdf ? 2 : 1, kids });
		if (c.cell === "f6") expect(u.zf < 0.99, `premise: ${name}: the export prints at a zoom under 1 (${u.zf})`).toBe(true);
		if (c.x.spanStyle) {
			const h = Number.parseFloat(c.x.spanStyle.split(":")[1]!);
			expect(Math.abs((u.page?.span?.h ?? 0) / u.pageZf - h) <= 0.5, `premise: ${name}: the span ${u.page?.span?.h} px on the page (zoom ${u.pageZf}), its style's ${h}`).toBe(true);
			if (h * 1 < 0.8 * c.paper.content.height) expect(drop !== null && Math.abs(drop) <= 0.5,
				`bar f3: ${name}: the cap cannot bind, the span prints as at base: ${u.page?.span?.h} px on the page, ${u.print?.span?.h} px in print, drop ${drop} css px`).toBe(true);
		}
		expectRead(u.printed, name);
		if (c.cell === "m") {
			// Against the embedded note's own zero (Embabove, above its PDF): the m0 controls print both its crosses about 16 px
			// above their words with the cap lifted and on A4 alike, so the cap's part is Embbelow's row less Embabove's.
			const a = u.printed.find(w => w.token === "Embabove")!, b = u.printed.find(w => w.token === "Embbelow")!;
			const rel = a.dx !== null && a.dy !== null && b.dx !== null && b.dy !== null ? { dx: r2n(b.dx - a.dx), dy: r2n(b.dy - a.dy) } : null;
			expect({ ink: [a.ink >= 1, b.ink >= 1], near: rel !== null && Math.abs(rel.dx) <= 1 && Math.abs(rel.dy) <= 1, strays: u.r.strays.length },
				`bar m: ${name}: ${wordLine(u.printed, "Embabove")}; ${wordLine(u.printed, "Embbelow")}; Embbelow less Embabove ${JSON.stringify(rel)}; ink outside every window ${u.r.strays.length}`)
				.toEqual({ ink: [true, true], near: true, strays: 0 });
		} else expectOnWords(u.printed, u.r, name, c.bar);
		noErrors();
	}, T);
}
