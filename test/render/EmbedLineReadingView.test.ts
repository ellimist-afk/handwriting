/**
 * INK ON A PARAGRAPH'S EMBED LINE, AND ON TEXT UNDER AN EMBED, IN READING VIEW.
 *
 * Reading view renders source lines with no blank line between them as one paragraph: the line breaks as br, an embed's
 * span between them (as Obsidian 1.15.1 writes it; ExportMobilePdf.test.ts embSide). A stroke anchored to one of the
 * paragraph's later lines is drawn at that line's top in the view plus its offset under the line, when the view can tell
 * the line's row (src/inline/EmbedInkLines.ts rowTopIn), else at the line's even share of the paragraph's height.
 * The rows are read from each source line's first character (src/inline/EmbedInkMeasure.ts lineStarts), and an embed's
 * span is skipped there, so a line that holds only an embed starts no row, and a paragraph whose first line is an embed
 * has no first row to count the others from.
 *
 * Four cells, one paragraph each, each painted alone:
 *  - text, then an embed on its own line; the stroke anchored to the embed's line. Want: the embed's row top plus the
 *    stroke's offset (the span's top for a PDF, a block; the picture's top for a picture, inline and taller than the
 *    text, so its row's top).
 *  - an embed on the paragraph's first line, then a text line; the stroke anchored to the text line. Want: the text
 *    line's row top plus the offset (the paragraph's content bottom less one line height: the text is its last row and
 *    does not wrap).
 *  Each with a PDF embed and with a picture embed. One control cell, a text paragraph of two lines joined by a hard
 *  break with the stroke on the second, measures the same way and is on its line at the base.
 * The offset is the stroke's centre below its anchor line's top; the painted y is the alpha-weighted centre of the
 * layer's painted pixels, page px. Each cell asserts the painted y within 0.5 px of the want and logs the want, the
 * painted y, the difference, and the even-share estimate.
 *
 * The PDF embed's height is a model: its page container is given 320 px (the viewer's own height is not modelled).
 * The picture is a data-URI svg of 200 x 100 with its width and height set. The rules a view applies are
 * ReadingViewInk.test.ts's, plus `.internal-embed:not(.image-embed) { display: block }` as ExportEmbedInkClip.test.ts
 * carries it from app.css 1.13.7.
 *
 * Run: npm run test:render -- EmbedLineReadingView.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

const VIEW_CSS = `
body { margin: 0; font-family: sans-serif; }
.markdown-preview-view { font-size: 16px; line-height: 1.5; padding: 32px; position: relative; overflow-y: auto; box-sizing: border-box; width: 100%; }
.markdown-rendered > :first-child { margin-top: 0; }
.markdown-rendered p { margin-block-start: 1rem; margin-block-end: 1rem; }
.markdown-preview-sizer { max-width: 700px; margin: 0 auto; }
.inline-title { font-size: 2em; line-height: 1.2; font-weight: 700; margin-bottom: 0.5em; }
.internal-embed:not(.image-embed) { display: block; }
.pdf-toolbar { height: 40px; }
.pdf-content-container { height: 320px; }
`;

const PAGE = `
import { attachEmbedInkOnceReady, initEmbedInkRefresh, teardownEmbedInk } from "../../src/inline/EmbedInk";
import { aboveOf, lineKey, newAboveRun } from "../../src/inline/LineAnchor";
import { installObsidianDom } from "./obsidianDom";

installObsidianDom();

// The note, 1-based as the editor numbers it: five paragraphs of two lines, a blank line between each.
const NOTE = [
	"Paper above notes", "![[Paper.pdf]]", "",
	"Photo above notes", "![[Photo.png]]", "",
	"![[Paper.pdf]]", "Paper below notes", "",
	"![[Photo.png]]", "Photo below notes", "",
	"Control first line", "control second line after a break",
];
const TEXT = NOTE.join("\\n");
// 0-based first line of each paragraph; each holds two source lines.
const PARAS = [0, 3, 6, 9, 12];
const EDITOR_LINE = 24;
const editorTop = line => (line - 1) * EDITOR_LINE;

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const r2 = v => Math.round(v * 100) / 100;

/** One horizontal stroke whose centre is off px under 1-based line's top in the editor, anchored to that line. */
function strokeFor(line, off) {
	const y = editorTop(line) + off, pad = 4;
	const points = Array.from({ length: 12 }, (_, j) => ({ x: 60 + j * 8, y, pressure: 0.5, t: j * 9 }));
	const bbox = { x: 60 - pad, y: y - pad, width: 88 + 2 * pad, height: 2 * pad };
	return { id: "cell-" + line, tool: "pen", color: "#ff00ff", width: 3, createdAt: 0, points, bbox,
		lineAnchor: { line, top: editorTop(line), y: bbox.y, key: lineKey(NOTE[line - 1]), width: 668, fontPx: 16,
			above: aboveOf(newAboveRun(), line, k => lineKey(NOTE[k - 1])) } };
}

/** An embed's span as Obsidian makes it, its content built with the DOM (an HTML parse would close the p at a div). */
function embedSpan(kind) {
	const span = document.createElement("span");
	if (kind === "pdf") {
		span.className = "internal-embed pdf-embed is-loaded";
		span.setAttribute("src", "Paper.pdf");
		span.setAttribute("alt", "Paper.pdf");
		span.appendChild(document.createElement("div")).className = "pdf-toolbar";
		span.appendChild(document.createElement("div")).className = "pdf-content-container";
	} else {
		span.className = "internal-embed media-embed image-embed is-loaded";
		span.setAttribute("src", "Photo.png");
		span.setAttribute("alt", "Photo.png");
		const img = span.appendChild(document.createElement("img"));
		img.setAttribute("src", "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='100'/%3E");
		img.setAttribute("width", "200");
		img.setAttribute("height", "100");
	}
	return span;
}

/** A paragraph's p: its two source lines, a br and a line feed between them, as the renderer writes a hard break. */
function paraOf(first) {
	const p = document.createElement("p");
	const line = l => {
		const src = NOTE[l];
		if (src === "![[Paper.pdf]]") return embedSpan("pdf");
		if (src === "![[Photo.png]]") return embedSpan("picture");
		return document.createTextNode(src);
	};
	p.append(line(first), document.createElement("br"), "\\n", line(first + 1));
	return p;
}

/** The alpha-weighted vertical centre of every painted pixel in root's ink layers, page px; null with none painted. */
function paintedY(root) {
	let sum = 0, weight = 0;
	for (const layer of root.querySelectorAll(":scope > canvas.handwriting-embed-ink")) {
		const lr = layer.getBoundingClientRect(), sy = lr.height / layer.height;
		const d = layer.getContext("2d").getImageData(0, 0, layer.width, layer.height).data;
		for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) {
			const a = d[(y * layer.width + x) * 4 + 3];
			if (a > 0) { sum += a * (lr.top + (y + 0.5) * sy); weight += a; }
		}
	}
	return weight > 0 ? sum / weight : null;
}

/**
 * Reading view's shape (view > sizer > pusher, header, one div per section), each section post-processed with its own
 * section info, one stroke anchored to 1-based line, off px under it; then where it is painted and where it belongs.
 */
window.embedLine = async (c) => {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "theme-light";
	const root = document.body.createDiv({ cls: "markdown-preview-view markdown-rendered" });
	const sizer = root.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
	sizer.createDiv({ cls: "markdown-preview-pusher" });
	const header = sizer.createDiv({ cls: "mod-header" });
	header.createDiv({ cls: "inline-title", text: "Embed lines" });
	const sections = PARAS.map(first => {
		const el = sizer.createDiv({ cls: "el-p" });
		el.appendChild(paraOf(first));
		return { el, lineStart: first, lineEnd: first + 1 };
	});
	await frame();
	const strokes = [strokeFor(c.line, c.off)];
	initEmbedInkRefresh(() => strokes);
	for (const s of sections) {
		attachEmbedInkOnceReady(s.el, sizer, "embed-lines.md", () => strokes, undefined, false, {
			section: () => ({ text: TEXT, lineStart: s.lineStart, lineEnd: s.lineEnd }),
			cached: () => null,
		});
	}
	await frame();
	await frame();
	const got = paintedY(root);
	if (got === null) return { error: "nothing painted" };
	const sec = sections.find(s => s.lineStart <= c.line - 1 && c.line - 1 <= s.lineEnd);
	const p = sec.el.querySelector("p"), pr = p.getBoundingClientRect(), box = sec.el.getBoundingClientRect();
	const lh = parseFloat(getComputedStyle(p).lineHeight);
	const span = p.querySelector(".internal-embed");
	const spanTop = span ? span.getBoundingClientRect().top : null;
	const img = span ? span.querySelector("img") : null;
	// The embed's row top: the span's own for a block; for an inline picture taller than the text, the picture's top.
	const embedRowTop = span ? Math.min(spanTop, img ? img.getBoundingClientRect().top : Infinity) : null;
	// The last row's top: the p's content bottom (no padding, no border) less one line height.
	const lastRowTop = pr.bottom - lh;
	// The same row by its first character's box, centred in its line height: a second reading, logged only.
	const text = [...p.childNodes].filter(n => n.nodeType === 3 && n.data.trim()).pop();
	let charRowTop = null;
	if (text) {
		const range = document.createRange();
		range.setStart(text, 0);
		range.setEnd(text, 1);
		const cr = range.getBoundingClientRect();
		charRowTop = cr.top - (lh - cr.height) / 2;
	}
	const lineTop = c.want === "embed" ? embedRowTop : lastRowTop;
	const want = lineTop + c.off;
	const k = c.line - 1 - sec.lineStart, n = sec.lineEnd - sec.lineStart + 1;
	const estimate = box.top + (k * box.height) / n + c.off;
	return {
		want: r2(want), got: r2(got), diff: r2(got - want), estimate: r2(estimate), gotLessEstimate: r2(got - estimate),
		lineTop: r2(lineTop), blockTop: r2(box.top), blockHeight: r2(box.height), lineHeight: lh,
		spanTop: spanTop === null ? null : r2(spanTop), embedRowTop: embedRowTop === null ? null : r2(embedRowTop),
		lastRowTop: r2(lastRowTop), charRowTop: charRowTop === null ? null : r2(charRowTop),
	};
};
`;

/** One cell: its 1-based anchor line, the stroke's offset under it, and which row is the line's own. */
interface Cell { line: number; off: number; want: "embed" | "last" }

const CELLS: Array<[string, Cell]> = [
	["text then a PDF embed, ink on the embed's line", { line: 2, off: 12, want: "embed" }],
	["text then a picture embed, ink on the embed's line", { line: 5, off: 12, want: "embed" }],
	["a PDF embed first then text, ink on the text line", { line: 8, off: 12, want: "last" }],
	["a picture embed first then text, ink on the text line", { line: 11, off: 12, want: "last" }],
];
const CONTROL: [string, Cell] = ["control: text then text after a hard break, ink on the second line", { line: 14, off: 12, want: "last" }];

let browser: Browser;
let page: Page;
const errors: string[] = [];
beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "embedLineReadingViewPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) } });
	browser = await chromium.launch({ headless: true });
	page = await browser.newPage({ viewport: { width: 816, height: 1600 } });
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addStyleTag({ content: VIEW_CSS });
	await page.addStyleTag({ content: readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8") });
	await page.addScriptTag({ content: b.outputFiles[0]!.text });
});
afterAll(async () => { await browser?.close(); });

it.each([CONTROL, ...CELLS])("reading view: %s, painted within 0.5 px of its line's top plus its offset", async (name, c) => {
	const r = await page.evaluate((k) => (window as any).embedLine(k), c);
	console.log("EMBED-LINE-READING", name, JSON.stringify(r));
	expect(r.error, "a layer was painted").toBeUndefined();
	expect(Math.abs(r.diff) <= 0.5, `painted ${r.got} want ${r.want}: ${r.diff} (even share ${r.estimate})`).toBe(true);
	expect(errors).toEqual([]);
});
