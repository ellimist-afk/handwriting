/**
 * A PHONE OR TABLET EXPORT TO PDF ON A LANDSCAPE PAGE: THE HOST'S INK AFTER A PDF EMBED, ON ITS WORDS.
 *
 * Obsidian 1.15.1's app.css caps a PDF embed in print media: inside its @media print block,
 * `.pdf-embed:not(.canvas-node-content){align-items:center;border:none;justify-content:center;max-height:80vh}` (app.asar
 * byte 418065). On screen the embed is 800 px tall (`.internal-embed.pdf-embed:not(.image-embed){...;height:800px}`, byte
 * 417199). A phone or tablet export cuts the host's ink into one strip per block from the page as it stands
 * (EmbedInkMobileExport, buildPrintStrips), and the native side lays the export's string out again for the paper. In a
 * print, vh is the page's: on a page under 1000 css px tall (Letter or A4 in landscape, 816 or 794 px) 80vh is under 800,
 * so the embed prints shorter than on the page the ink was cut on, and every block after it sits higher in the print.
 *
 * The question, a measure: does the host's ink in a block after the embed print on its words?
 *
 * The note: the file name; block 0 a paragraph (Earlyword, before the embed); block 1 "![[Paper.pdf]]" alone on its line
 * (the reading view's p holding the embed's span, app.js @3018566, the viewer not built yet: the span empty); block 2
 * (Laterword, right after the embed); block 3 (Lastword, the block after that). A cross on each of the three words,
 * attached to its line, placed from the phone or tablet page as it lays the note out before the export (the editor holds
 * the embed at the same 800 px). The export is replayed as ExportMobilePdf.test.ts replays printToPdfMobile (app.js
 * @2682211): the plugin live on the page, the div's zoom written, two frames for the 200 ms, head and div cloned into one
 * string.
 *
 * Two reads of that string, each loaded with scripts off, as the native side loads it:
 *   1. The print layout, with vh taken as the page box: the string at a viewport of the page's size in print media. Each
 *      marked word's box against its own block's strip, less the same on the phone or tablet page when the string was
 *      taken, css px. The bar: 0.5 css px across and down.
 *   2. Chromium's own print of the string at the dialog's page (page.pdf: size, orientation, the default margin, scale 1),
 *      read with ExportMobilePdf.test.ts's pdf.js reader (READER_JS, verbatim at b04241aa): each cross's centre against
 *      its green word's centre within 1 page px, one ink blob in each word's window, no ink outside them. The embed's
 *      span carries a blue background (a test instrument, as the green words are), so the reader's blue blob is the
 *      embed's printed height: which vh Chromium's print takes, measured, not assumed.
 *
 * Cases: LAND, a landscape page under 1000 px tall (the read at 1056 x 780, so 80vh is 624; the print Letter landscape,
 * 816 px tall); PORT, the portrait control (the read at 794 x 1123, 80vh 898.4; the print A4 portrait, where 80vh is over
 * 800 whether vh is the page box, 1123, or its content box, 1046). Phone (360 x 780, column 312) and tablet (800 x 1280,
 * column 700), at the saved 100 % downscale (zoom 1).
 *
 * Premise, per run: three crosses, one strip in each marked word's block on the page and after the parse, the parse in
 * print media at the case's viewport; and the cap binds in LAND (the parsed span over 100 px shorter than the page's) and
 * not in PORT (within 0.5 px). A LAND row on its words is only an answer when the blocks after the embed moved.
 *
 * Env: HW_OBSIDIAN_ASAR (required; every cell skips with a loud line without it), HW_LAND_OUT (a directory that keeps
 * each PDF).
 *
 * Run: npx vitest run --config vitest.render.mts test/render/ExportMobilePdfLandscape.test.ts
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
const OUT = process.env.HW_LAND_OUT ?? "";
if (!HAVE_ASAR) console.log("EXPORT-MOBILE-LANDSCAPE SKIP: HW_OBSIDIAN_ASAR is unset or missing; every cell in this file is skipped");
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
/**
 * body.land-cap (LAND only): the app's own print cap again, test-side, as a rule an inline value does not beat. The plugin
 * holds a PDF embed above drawn ink at its screen height in print (inline max-height, print-cap-01), so without this the
 * cap no longer binds and LAND would not move the blocks after the embed; with it they still move, and the strips must
 * carry them.
 */
const INSTRUMENT_CSS = ".mark-word{background:#00ff00} .pdf-embed{background:#0000ff} @media print{body.land-cap .pdf-embed:not(.canvas-node-content){max-height:80vh!important}}";

/** The marked words: id, token, block. Block 1 is the PDF embed's line. */
const MARKS = [
	{ id: "w-early", token: "Earlyword", block: 0 },
	{ id: "w-later", token: "Laterword", block: 2 },
	{ id: "w-last", token: "Lastword", block: 3 },
] as const;
const PDF_LINE = "![[Paper.pdf]]";
const BLOCKS = [
	"Earlyword opens the note on the line above the PDF embed",
	PDF_LINE,
	"Laterword sits in the paragraph right after the PDF embed",
	"Lastword sits in the block after that one",
];
const TOKENS = MARKS.map(m => m.token);

const PAGE = `
import { Platform } from "obsidian";
import { attachEmbedInkOnceReady, initEmbedInkColumnWidth, initEmbedInkRefresh, teardownEmbedInk } from "../../src/inline/EmbedInk";
import { initEmbedInkPrintCanvas, initEmbedInkPrintPaper } from "../../src/inline/EmbedInkPrint";
import { aboveOf, lineKey, newAboveRun } from "../../src/inline/LineAnchor";
import { installObsidianDom } from "./obsidianDom";

installObsidianDom();
const proto = HTMLElement.prototype;
proto.setCssStyles ??= function (s) { for (const k of Object.keys(s)) this.style[k] = s[k]; };
window.createDiv ??= () => document.createElement("div");

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const r2 = v => Math.round(v * 100) / 100;
const PATH = "Landscape note.md";
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

/** A block: one paragraph, its first word in a green span when the block is marked. */
function textBlock(root, text, id) {
	const d = root.appendChild(document.createElement("div"));
	const p = d.appendChild(document.createElement("p"));
	const words = text.split(" ");
	if (!id) { p.textContent = text; return d; }
	const w = p.appendChild(document.createElement("span"));
	w.className = "mark-word";
	w.id = id;
	w.textContent = words[0];
	p.append(" " + words.slice(1).join(" "));
	return d;
}
/** The embed alone on its line: the p holds span.internal-embed.pdf-embed, empty (the viewer not built yet). */
function pdfBlock(root) {
	const d = root.appendChild(document.createElement("div"));
	const p = d.appendChild(document.createElement("p"));
	const embed = p.appendChild(document.createElement("span"));
	embed.className = "internal-embed pdf-embed is-loaded";
	embed.setAttribute("src", "Paper.pdf");
	embed.setAttribute("alt", "Paper.pdf");
	return d;
}
/**
 * A cross (magenta, 32 x 14) on each marked word, attached to its block's line: x from the first paragraph's left, y and
 * the line's top from that paragraph's top, as this page lays the note out.
 */
function crosses(root, sections, o) {
	const p0 = root.querySelector("p").getBoundingClientRect();
	const strokes = [], at = {};
	for (const m of o.marks) {
		const n = 1 + 2 * m.block;
		const s = sections[m.block].getBoundingClientRect(), w = sections[m.block].querySelector("#" + m.id).getBoundingClientRect();
		const anchor = { line: n, top: r2(s.top - p0.top), key: lineKey(o.source[n - 1]), width: o.column, fontPx: 16,
			above: aboveOf(newAboveRun(), n, j => lineKey(o.source[j - 1])) };
		const x = r2(w.left + w.width / 2 - p0.left), y = r2(w.top + w.height / 2 - p0.top);
		at[m.id] = { x, y };
		strokes.push(line("h-" + m.id, x - 16, y, x + 16, y, { anchor }), line("v-" + m.id, x, y - 7, x, y + 7, { anchor }));
	}
	return { strokes, at };
}

/** printToPdfMobile replayed with the plugin live, as ExportMobilePdf.test.ts's mobileExport does it, the note above. */
window.landExport = async (o) => {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "is-mobile " + (o.column < 500 ? "is-phone " : "is-tablet ") + "theme-dark" + (o.landCap ? " land-cap" : "");
	Platform.isMobileApp = true;
	Platform.isMobile = true;
	initEmbedInkColumnWidth(() => o.column);
	initEmbedInkPrintPaper(() => o.settings);
	initEmbedInkPrintCanvas(null);
	let live = [];
	const provide = () => live;
	initEmbedInkRefresh(provide);
	const div = document.body.appendChild(document.createElement("div"));
	div.className = "print theme-light";
	div.setAttribute("aria-hidden", "true");
	const root = div.appendChild(document.createElement("div"));
	root.className = "markdown-preview-view markdown-rendered";
	if (o.settings.includeName) { const h = root.appendChild(document.createElement("h1")); h.textContent = "Landscape note"; }
	const sections = o.blocks.map((t, i) => {
		if (t === o.pdfLine) return pdfBlock(root);
		const m = o.marks.find(k => k.block === i);
		return textBlock(root, t, m ? m.id : null);
	});
	await frame();
	const ink = crosses(root, sections, o);
	live = ink.strokes;
	const text = o.source.join("\\n");
	sections.forEach((el, i) => attachEmbedInkOnceReady(el, root, PATH, provide, undefined, false, {
		section: () => ({ text, lineStart: 2 * i, lineEnd: 2 * i }), cached: () => null }));
	// print() resolves; the zoom, then two frames in place of the app's 200 ms.
	await Promise.resolve();
	const scale = Math.min(2, Math.max(0.1, o.settings.downscalePercent / 100));
	div.style.zoom = scale.toString();
	await frame(); await frame();
	const geom = window.landGeom();
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
	const held = { html: out, zf, geom, at: ink.at, strokes: live.length,
		strips: div.querySelectorAll("svg.handwriting-embed-ink-strip").length,
		canvasShown: [...div.querySelectorAll("canvas.handwriting-embed-ink")].filter(c => getComputedStyle(c).display !== "none").length };
	div.remove();
	teardownEmbedInk();
	return held;
};
`;

/**
 * The read, in the app page when the string is taken and in the string loaded again: each marked word's box against the
 * one strip in its own block (zoomed px), its block's and its own top below the root's, and the PDF embed's span as laid
 * out (its height, its computed max-height). A string expression, so it runs with scripts off.
 */
interface WordRel { strips: number; x: number | null; y: number | null; h: number; block: number; top: number }
interface Geom { words: Record<string, WordRel | null>; span: { h: number; maxHeight: string; parent: string | null } | null; vh: number; print: boolean; rootW: number }
const LAND_GEOM = `(() => {
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
	return { words, span: span ? { h: r2(span.getBoundingClientRect().height), maxHeight: getComputedStyle(span).maxHeight, parent: span.parentElement ? span.parentElement.tagName : null } : null,
		vh: window.innerHeight, print: matchMedia("print").matches, rootW: r2(rr.width) };
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

/** The dialog's saved settings, as app.js writes them (@2680737). */
interface Settings { includeName: boolean; pageSize: string; landscape: boolean; margin: string; downscalePercent: number }
/** The default margin code "0": 0.4 in, the desktop table's (EmbedInkPrint.ts MARGIN_INCHES), as ExportMobilePdf.test.ts prints. */
const MARGIN = "0.4in";
const TABLET = { width: 800, height: 1280, column: 700 };
const PHONE = { width: 360, height: 780, column: 312 };
type Device = "phone" | "tablet";

interface Word { page: number; token: string | null; text: string | null; font: string | null; R: number; word: { x: number; y: number; w: number; h: number }; cross: { x: number; y: number } | null; dx: number | null; dy: number | null; ink: number }
interface Read { pages: number; words: Word[]; strays: Array<{ page: number; x0: number; y0: number; x1: number; y1: number; count: number }>; hl: number; spans: Array<{ page: number; h: number; x: number }>; inks: Array<{ page: number; cx: number; cy: number; count: number }> }
interface Held { html: string; zf: number; geom: Geom | null; at: Record<string, { x: number; y: number }>; strokes: number; strips: number; canvasShown: number }

let browser: Browser;
let bundle = "";
let appCss = "";
let stylesCss = "";
let reader: Page;
const pages = new Map<Device, Page>();
const pdfs = new Map<string, Bytes>();
let pdfSeq = 0;
const errors: string[] = [];

/** A device page with the app's head: the whole app.css of Obsidian 1.15.1, the plugin's styles.css, the instrument. */
async function pageFor(dev: Device): Promise<Page> {
	const have = pages.get(dev);
	if (have) return have;
	const vp = dev === "phone" ? PHONE : TABLET;
	const p = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
	p.on("pageerror", error => errors.push(`${dev}: ${error.message}`));
	await p.setContent("<!doctype html><html><head></head><body></body></html>");
	await p.addStyleTag({ content: appCss });
	await p.addStyleTag({ content: stylesCss });
	await p.addStyleTag({ content: INSTRUMENT_CSS });
	await p.addScriptTag({ content: `window.landGeom = () => ${LAND_GEOM};` });
	await p.addScriptTag({ content: bundle });
	pages.set(dev, p);
	return p;
}

beforeAll(async () => {
	if (!HAVE_ASAR) return;
	if (OUT) mkdirSync(OUT, { recursive: true });
	const asar = readFileSync(ASAR);
	appCss = utf8(asarFile(asar, "app.css"));
	stylesCss = readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8");
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "exportMobileLandscapePage.ts" },
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

const label = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 60);
const r2n = (v: number) => Math.round(v * 100) / 100;

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

/** The string loaded as the native side loads it (scripts off), at the page's size, read in print media. */
async function parseGeom(html: string, vp: { width: number; height: number }): Promise<Geom | null> {
	const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: vp });
	try {
		const p = await ctx.newPage();
		await p.setContent(html);
		await p.emulateMedia({ media: "print" });
		return (await p.evaluate(LAND_GEOM)) as Geom | null;
	} finally {
		await ctx.close();
	}
}

/** The native side's print, scripts off: the dialog's page size, orientation and margin, scale 1 (app.js @2682963-@2683128). */
async function printNative(html: string, s: Settings): Promise<Bytes> {
	const ctx = await browser.newContext({ javaScriptEnabled: false });
	try {
		const p = await ctx.newPage();
		await p.setContent(html);
		await p.emulateMedia({ media: "print" });
		return await p.pdf({ format: s.pageSize, landscape: s.landscape, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN }, printBackground: true, scale: 1 });
	} finally {
		await ctx.close();
	}
}

const noErrors = () => expect(errors).toEqual([]);

interface Case { read: { width: number; height: number }; settings: Settings; binds: boolean }
const SAVED: Settings = { includeName: true, pageSize: "Letter", landscape: false, margin: "0", downscalePercent: 100 };
const CASES: Array<[string, Case]> = [
	["LAND, a landscape page under 1000 px tall (read 1056 x 780, print Letter landscape)", { read: { width: 1056, height: 780 }, settings: { ...SAVED, landscape: true }, binds: true }],
	["PORT, the portrait control (read 794 x 1123, print A4 portrait)", { read: { width: 794, height: 1123 }, settings: { ...SAVED, pageSize: "A4" }, binds: false }],
];
const RUNS: Array<[string, Device, Case]> = CASES.flatMap(([name, c]) => (["phone", "tablet"] as const).map((dev): [string, Device, Case] => [`${name}, ${dev}`, dev, c]));

itA.each(RUNS)("%s: the host's ink after a PDF embed prints on its words", async (name, dev, c) => {
	const p = await pageFor(dev);
	const column = dev === "phone" ? PHONE.column : TABLET.column;
	const source: string[] = [];
	BLOCKS.forEach((b, i) => { if (i > 0) source.push(""); source.push(b); });
	const held = await p.evaluate((x) => (window as unknown as { landExport(o: unknown): Promise<Held> }).landExport(x),
		{ blocks: BLOCKS, source, marks: MARKS, pdfLine: PDF_LINE, column, settings: c.settings, landCap: c.binds });
	const zf = held.zf;
	const live = held.geom, parsed = await parseGeom(held.html, c.read);
	// Each word against its own block's strip, the parse less the page; its block's move against the root; css px.
	const moves = MARKS.map(m => {
		const a = live?.words[m.id], b = parsed?.words[m.id];
		const ok = !!a && !!b && a.x !== null && a.y !== null && b.x !== null && b.y !== null;
		return { token: m.token, dx: ok ? r2n((b!.x! - a!.x!) / zf) : null, dy: ok ? r2n((b!.y! - a!.y!) / zf) : null,
			block: a && b ? r2n((b.block - a.block) / zf) : null, word: a && b ? r2n((b.top - a.top) / zf) : null };
	});
	const spanDrop = live?.span && parsed?.span ? r2n((live.span.h - parsed.span.h) / zf) : null;
	const r = await readPdf(await printNative(held.html, c.settings), TOKENS, zf, name);
	const printed = TOKENS.map(t => { const w = r.words.find(x => x.token === t); return { token: t, page: w ? w.page + 1 : null, dx: w?.dx ?? null, dy: w?.dy ?? null, ink: w?.ink ?? 0 }; });
	console.log("EXPORT-MOBILE-LANDSCAPE ROWS", name, JSON.stringify({ dev, column, zf, read: c.read, print: { format: c.settings.pageSize, landscape: c.settings.landscape },
		moves, spanDrop, span: { page: live?.span, parsed: parsed?.span }, printedSpans: r.spans, pages: r.pages, printed, strays: r.strays,
		vh: parsed?.vh, printMedia: parsed?.print, rootW: [live?.rootW, parsed?.rootW], strips: held.strips, strokes: held.strokes, canvasShown: held.canvasShown,
		live: live?.words, parsedWords: parsed?.words, at: held.at }));
	expect({ strokes: held.strokes, live: MARKS.map(m => live?.words[m.id]?.strips ?? null), parsed: MARKS.map(m => parsed?.words[m.id]?.strips ?? null),
		printMedia: parsed?.print ?? null, vh: parsed?.vh ?? null, canvasShown: held.canvasShown },
		`premise: ${name}: three crosses, one strip in each marked word's block on the page and after the parse, the parse in print media at ${c.read.height} px tall, no canvas showing`)
		.toEqual({ strokes: 6, live: [1, 1, 1], parsed: [1, 1, 1], printMedia: true, vh: c.read.height, canvasShown: 0 });
	expect(spanDrop !== null && (c.binds ? spanDrop > 100 : Math.abs(spanDrop) <= 0.5),
		`premise: ${name}: the print cap ${c.binds ? "binds" : "does not bind"}: the PDF embed's span ${live?.span?.h} px on the page, ${parsed?.span?.h} px after the parse (max-height ${parsed?.span?.maxHeight}), drop ${spanDrop} css px`).toBe(true);
	const off = moves.filter(m => m.dx === null || m.dy === null || Math.abs(m.dx) > 0.5 || Math.abs(m.dy) > 0.5);
	expect.soft(off.map(m => `${m.token} against its block's strip, the parse less the page: dx ${m.dx}, dy ${m.dy} css px (its block moved ${m.block}, the word ${m.word})`),
		`${name}: each marked word on its own block's strip in the print layout, within 0.5 css px (span drop ${spanDrop})`).toEqual([]);
	const missed = printed.filter(w => w.ink !== 1 || w.dx === null || w.dy === null || Math.abs(w.dx) > 1 || Math.abs(w.dy) > 1);
	expect.soft({ missed: missed.map(w => `${w.token} page ${w.page}: cross less word ${w.dx}, ${w.dy} page px, ${w.ink} ink blobs in its window`), strays: r.strays },
		`${name}: Chromium's print, each cross within 1 page px of its word, no ink outside the words (blue span ${JSON.stringify(r.spans)})`).toEqual({ missed: [], strays: [] });
	noErrors();
}, T);
