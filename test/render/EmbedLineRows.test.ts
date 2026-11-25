/**
 * READING VIEW ROWS AROUND AN EMBED: LINES UNDER AN EMBED MOVE ONTO THEIR LINE, EVERY LINE WITH A ROW TODAY STAYS.
 *
 * A paragraph's rows are read from each source line's first character (src/inline/EmbedInkMeasure.ts lineStarts); an
 * embed's span is skipped, so a line that holds only an embed has no start, and a paragraph that opens with one has no
 * first row to count the others from. Ink on such lines takes the even share of the paragraph's height
 * (src/inline/EmbedInkLines.ts lineTopIn). A plain picture (an img with no embed span around it: an external or raw
 * picture, a linked picture, an img of an svg file) holds no text either, so its line has no start in the same way.
 *
 * Three kinds of cell, one paragraph group each, one stroke per run:
 *  - move: the stroke's line has no row today. Asserted within 0.5 px of want: the line's own row top plus the stroke's
 *    offset. An embed's row top is the least top of its span and its laid-out children (a block's span top, an inline
 *    picture's top); a text row under the embed lines is the paragraph's content bottom less one line height per text
 *    row from it down (text only, no wrap).
 *  - hold: the stroke's line has a row today, or is a math or svg line, or a blank line by the paragraph. Asserted
 *    within 0.01 px of the base pin, the painted y read at the unfixed base.
 *  - log: a plain picture that takes its height after the paint, or never loads. Logged only: the painted y at the
 *    paint and after the picture loads, against the picture's top after.
 * Every cell also asserts the strokes handed to the view are the same after the paint as before (nothing is written).
 *
 * The painted y is the alpha-weighted centre of the layer's painted pixels, page px; the offset is the stroke's centre
 * below its anchor line's top, as written in the editor. Fixture as EmbedLineReadingView.test.ts: Reading view's shape,
 * one section per paragraph, each post-processed with its own section info; a hard break is a br and a line feed.
 *
 * Run: npm run test:render -- EmbedLineRows --reporter=default --silent=false.
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
.markdown-embed-content { padding: 8px 24px; }
`;

const PAGE = `
import { attachEmbedInkOnceReady, initEmbedInkRefresh, teardownEmbedInk } from "../../src/inline/EmbedInk";
import { aboveOf, lineKey, newAboveRun } from "../../src/inline/LineAnchor";
import { installObsidianDom } from "./obsidianDom";

installObsidianDom();

const PICTURE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='100'/%3E";
const BROKEN = "data:image/png;base64,iVBORw0KGgo=";
const EDITOR_LINE = 24;
const editorTop = line => (line - 1) * EDITOR_LINE;
const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const r2 = v => v === null || v === undefined ? null : Math.round(v * 100) / 100;

/** A line's source text as the note holds it. */
function sourceOf(l) {
	if (typeof l === "string") return l;
	if (l.e === "pdf") return "![[Paper.pdf]]";
	if (l.e === "pic") return l.h ? "![[Photo.png|" + l.h + "]]" : "![[Photo.png]]";
	if (l.e === "pics") return l.hs.map(h => "![[Photo.png|" + h + "]]").join("");
	if (l.e === "note") return "![[Other note]]";
	if (l.e === "mid") return l.pre + "![[Photo.png]]" + l.post;
	if (l.e === "math") return "$x^2 + y^2$";
	if (l.e === "svg") return '<svg width="40" height="40"></svg>';
	if (l.e === "img") return l.h ? "![|" + l.h * 2 + "x" + l.h + "](https://example.com/p.png)" : "![](https://example.com/p.png)";
	if (l.e === "imgs") return l.hs.map(h => "![|" + h * 2 + "x" + h + "](https://example.com/p.png)").join("");
	if (l.e === "imgmid") return l.pre + "![](https://example.com/p.png)" + l.post;
	if (l.e === "link") return "[![](https://example.com/p.png)](https://example.com)";
	if (l.e === "svgfile") return "![](https://example.com/d.svg)";
	if (l.e === "late") return "![](https://example.com/late.png)";
	if (l.e === "broken") return "![](https://example.com/missing.png)";
	return "?";
}

/** A plain picture: an img with no embed span around it, sized by its attributes. */
function plainImg(h = 100) {
	const img = document.createElement("img");
	img.setAttribute("src", PICTURE);
	img.setAttribute("width", String(h * 2));
	img.setAttribute("height", String(h));
	return img;
}

function pictureSpan(h = 100) {
	const span = document.createElement("span");
	span.className = "internal-embed media-embed image-embed is-loaded";
	span.setAttribute("src", "Photo.png");
	const img = span.appendChild(document.createElement("img"));
	img.setAttribute("src", PICTURE);
	img.setAttribute("width", String(h * 2));
	img.setAttribute("height", String(h));
	return span;
}

/** One line's nodes and its embed spans, built with the DOM (an HTML parse would close the p at a div). */
function lineOf(l) {
	if (typeof l === "string") return { nodes: [document.createTextNode(l)], embeds: [] };
	if (l.e === "pdf") {
		const span = document.createElement("span");
		span.className = "internal-embed pdf-embed is-loaded";
		span.setAttribute("src", "Paper.pdf");
		span.appendChild(document.createElement("div")).className = "pdf-toolbar";
		span.appendChild(document.createElement("div")).className = "pdf-content-container";
		return { nodes: [span], embeds: [span] };
	}
	if (l.e === "pic") {
		const span = pictureSpan(l.h);
		return { nodes: [span], embeds: [span] };
	}
	if (l.e === "pics") {
		const spans = l.hs.map(h => pictureSpan(h));
		return { nodes: spans, embeds: spans };
	}
	if (l.e === "note") {
		// An embedded note whose own render holds a paragraph of two lines joined by a hard break.
		const span = document.createElement("span");
		span.className = "internal-embed markdown-embed inline-embed is-loaded";
		span.setAttribute("src", "Other note");
		const view = span.appendChild(document.createElement("div"));
		view.className = "markdown-embed-content";
		const inner = view.appendChild(document.createElement("div"));
		inner.className = "markdown-preview-view markdown-rendered";
		const p = inner.appendChild(document.createElement("p"));
		p.append("Inner first line", document.createElement("br"), "\\n", "inner second line");
		return { nodes: [span], embeds: [span] };
	}
	if (l.e === "mid") {
		const span = pictureSpan();
		return { nodes: [document.createTextNode(l.pre), span, document.createTextNode(l.post)], embeds: [span] };
	}
	if (l.e === "math") {
		const span = document.createElement("span");
		span.className = "math math-inline is-loaded";
		const mjx = span.appendChild(document.createElement("mjx-container"));
		mjx.className = "MathJax";
		mjx.textContent = "x2 + y2";
		return { nodes: [span], embeds: [] };
	}
	if (l.e === "svg") {
		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		svg.setAttribute("width", "40");
		svg.setAttribute("height", "40");
		svg.appendChild(document.createElementNS(ns, "rect")).setAttribute("width", "40");
		return { nodes: [svg], embeds: [] };
	}
	if (l.e === "img") {
		const img = plainImg(l.h);
		return { nodes: [img], embeds: [img] };
	}
	if (l.e === "imgs") {
		const imgs = l.hs.map(h => plainImg(h));
		return { nodes: imgs, embeds: imgs };
	}
	if (l.e === "imgmid") {
		const img = plainImg();
		return { nodes: [document.createTextNode(l.pre), img, document.createTextNode(l.post)], embeds: [img] };
	}
	if (l.e === "link") {
		// A linked picture as the renderer writes it: an external link holding the img.
		const a = document.createElement("a");
		a.className = "external-link";
		a.setAttribute("href", "https://example.com");
		const img = a.appendChild(plainImg());
		return { nodes: [a], embeds: [img] };
	}
	if (l.e === "svgfile") {
		// An img of an svg file, with no size of its own: the file gives it 200 x 100.
		const img = document.createElement("img");
		img.setAttribute("src", PICTURE);
		return { nodes: [img], embeds: [img], wait: img.decode().catch(() => {}) };
	}
	if (l.e === "late") {
		// No size and no source at the paint: the source is set after it.
		const img = document.createElement("img");
		return { nodes: [img], embeds: [img], late: img };
	}
	if (l.e === "broken") {
		// A source that never loads: no size of its own.
		const img = document.createElement("img");
		img.setAttribute("src", BROKEN);
		return { nodes: [img], embeds: [img], wait: img.decode().catch(() => {}) };
	}
	return { nodes: [], embeds: [] };
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

/** The least top of the embeds' spans and their laid-out children, client px. */
function embedTop(spans) {
	let top = Infinity;
	for (const el of spans.flatMap(span => [span, ...span.children])) {
		const r = el.getBoundingClientRect();
		if (r.width > 0 || r.height > 0) top = Math.min(top, r.top);
	}
	return Number.isFinite(top) ? top : null;
}

/**
 * c: { paras: [{ lines, trail }], line (1-based), off, scale, nested }. Builds the note's paragraphs, a blank line between
 * each, paints one stroke anchored to line, and reads where it is painted and the geometry its want is taken from.
 */
window.embedRows = async (c) => {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "theme-light";
	const note = [], spans = [];
	for (const para of c.paras) {
		if (note.length) note.push("");
		spans.push([note.length, note.length + para.lines.length - 1]);
		for (const l of para.lines) note.push(sourceOf(l));
	}
	const text = note.join("\\n");
	const root = document.body.createDiv({ cls: "markdown-preview-view markdown-rendered" });
	if (c.scale) {
		root.style.transform = "scale(" + c.scale + ")";
		root.style.transformOrigin = "0 0";
	}
	const hostSizer = root.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
	hostSizer.createDiv({ cls: "markdown-preview-pusher" });
	hostSizer.createDiv({ cls: "mod-header" }).createDiv({ cls: "inline-title", text: "Embed rows" });
	// nested: the paragraphs are an embedded note's own, in the embed's view on a host line (its content box, view and
	// sizer, as Reading view draws an embedded note on screen); the ink is that note's, its layer in the content box.
	let sizer = hostSizer, view = root;
	if (c.nested) {
		hostSizer.createDiv({ cls: "el-p" }).appendChild(document.createElement("p")).append("Host line above the embedded note");
		const span = hostSizer.createDiv({ cls: "el-p" }).appendChild(document.createElement("p")).appendChild(document.createElement("span"));
		span.className = "internal-embed markdown-embed inline-embed is-loaded";
		span.setAttribute("src", "Embed rows inner");
		view = span.createDiv({ cls: "markdown-embed-content" });
		sizer = view.createDiv({ cls: "markdown-preview-view markdown-rendered" }).createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
		sizer.createDiv({ cls: "markdown-preview-pusher" });
	}
	const sections = c.paras.map((para, i) => {
		const el = sizer.createDiv({ cls: "el-p" });
		const p = el.appendChild(document.createElement("p"));
		const lines = para.lines.map((l, k) => {
			if (k > 0) p.append(document.createElement("br"), "\\n");
			const o = lineOf(l);
			p.append(...o.nodes);
			return o;
		});
		if (para.trail) p.append("\\n");
		return { el, p, lines, lineStart: spans[i][0], lineEnd: spans[i][1] };
	});
	await Promise.all(sections.flatMap(s => s.lines.map(o => o.wait)));
	await frame();
	const line = c.line, off = c.off, y = editorTop(line) + off, pad = 4;
	const points = Array.from({ length: 12 }, (_, j) => ({ x: 60 + j * 8, y, pressure: 0.5, t: j * 9 }));
	const stroke = { id: "cell-" + line, tool: "pen", color: "#ff00ff", width: 3, createdAt: 0, points,
		bbox: { x: 60 - pad, y: y - pad, width: 88 + 2 * pad, height: 2 * pad },
		lineAnchor: { line, top: editorTop(line), y: y - pad, key: lineKey(note[line - 1]), width: 668, fontPx: 16,
			above: aboveOf(newAboveRun(), line, k => lineKey(note[k - 1])) } };
	const strokes = [stroke];
	const before = JSON.stringify(strokes);
	initEmbedInkRefresh(() => strokes);
	for (const s of sections) {
		attachEmbedInkOnceReady(s.el, sizer, "embed-rows.md", () => strokes, undefined, false, {
			section: () => ({ text, lineStart: s.lineStart, lineEnd: s.lineEnd }),
			cached: () => null,
		});
	}
	await frame();
	await frame();
	const got = paintedY(view);
	if (got === null) return { error: "nothing painted" };
	const out = { got: r2(got), off: off * (c.scale || 1) };
	const late = sections.flatMap(x => x.lines.map(o => o.late)).find(Boolean);
	if (late) {
		// The picture takes its height now: the painted y after the size watch places the ink again (its resize
		// callback runs in a frame, the place in the microtask after it).
		late.setAttribute("src", PICTURE);
		await late.decode().catch(() => {});
		for (let i = 0; i < 4; i++) await frame();
		out.gotAtPaint = out.got;
		out.got = r2(paintedY(view));
	}
	out.unchanged = JSON.stringify(strokes) === before;
	const s = c.scale || 1;
	const sec = sections.find(x => x.lineStart <= line - 1 && line - 1 <= x.lineEnd);
	if (sec) {
		const pr = sec.p.getBoundingClientRect(), box = sec.el.getBoundingClientRect();
		const lh = parseFloat(getComputedStyle(sec.p).lineHeight) * s;
		const k = line - 1 - sec.lineStart, n = sec.lineEnd - sec.lineStart + 1;
		const e = sec.lines[k].embeds;
		Object.assign(out, {
			k, n, lineHeight: r2(lh), blockTop: r2(box.top), blockHeight: r2(box.height), contentBottom: r2(pr.bottom),
			bottomRow: r2(pr.bottom - (n - k) * lh), underRow: r2(pr.top + k * lh), embedRow: e.length ? r2(embedTop(e)) : null,
			estimate: r2(box.top + (k * box.height) / n + off * s),
		});
	}
	return out;
};
`;

type Line = string
	| { e: "pdf" | "pic" | "note" | "math" | "svg" | "img" | "link" | "svgfile" | "late" | "broken"; h?: number }
	| { e: "pics" | "imgs"; hs: readonly number[] }
	| { e: "mid" | "imgmid"; pre: string; post: string };
interface Para { lines: Line[]; trail?: boolean }
/**
 * One cell: its paragraphs, the 1-based anchor line, the stroke's offset, and what it is held to: the embeds' least top
 * (embed); the content bottom less a line height per row from it down (bottom); the content top plus a line height per
 * row above it, where every line above holds text only and the line's embed is shorter than the line (under); or the
 * base pin (hold); or nothing, logged only (log).
 */
interface Cell { paras: Para[]; line: number; off: number; scale?: number; nested?: boolean; want: "embed" | "bottom" | "under" | "hold" | "log" }

const PDF = { e: "pdf" } as const, PIC = { e: "pic" } as const, NOTE = { e: "note" } as const;
const SMALL = { e: "pic", h: 16 } as const, PAIR = { e: "pics", hs: [50, 100] } as const;
const ORDERS = (trail: boolean, w: string): Array<[string, Cell]> => [
	[`text then a picture embed${w}, ink on the embed's line`, { paras: [{ lines: [`Text over the picture${w}`, PIC], trail }], line: 2, off: 12, want: "embed" }],
	[`a picture embed then text${w}, ink on the text line`, { paras: [{ lines: [PIC, `Text under the picture${w}`], trail }], line: 2, off: 12, want: "bottom" }],
	[`two picture embeds then text${w}, ink on the second embed's line`, { paras: [{ lines: [PIC, PIC, `Text under two pictures${w}`], trail }], line: 2, off: 12, want: "embed" }],
	[`two picture embeds then text${w}, ink on the text line`, { paras: [{ lines: [PIC, PIC, `Text under two pictures${w}`], trail }], line: 3, off: 12, want: "bottom" }],
];
const IMG = { e: "img" } as const, IMG_SMALL = { e: "img", h: 16 } as const, IMG_PAIR = { e: "imgs", hs: [50, 100] } as const;
const IMG_TINY = { e: "img", h: 8 } as const;
const LINK = { e: "link" } as const;
const PLAIN_ORDERS = (trail: boolean, w: string): Array<[string, Cell]> => [
	[`text then a plain picture${w}, ink on the picture's line`, { paras: [{ lines: [`Text over the plain picture${w}`, IMG], trail }], line: 2, off: 12, want: "embed" }],
	[`a plain picture then text${w}, ink on the text line`, { paras: [{ lines: [IMG, `Text under the plain picture${w}`], trail }], line: 2, off: 12, want: "bottom" }],
	[`two plain pictures then text${w}, ink on the second picture's line`, { paras: [{ lines: [IMG, IMG, `Text under two plain pictures${w}`], trail }], line: 2, off: 12, want: "embed" }],
	[`two plain pictures then text${w}, ink on the text line`, { paras: [{ lines: [IMG, IMG, `Text under two plain pictures${w}`], trail }], line: 3, off: 12, want: "bottom" }],
];

const CELLS: Array<[string, Cell]> = [
	// Lines under an embed that opens its paragraph.
	["a PDF embed then two text lines, ink on line two", { paras: [{ lines: [PDF, "Paper line two", "Paper line three"] }], line: 2, off: 12, want: "bottom" }],
	["a PDF embed then two text lines, ink on line three", { paras: [{ lines: [PDF, "Paper line two", "Paper line three"] }], line: 3, off: 12, want: "bottom" }],
	["a picture embed then two text lines, ink on line two", { paras: [{ lines: [PIC, "Photo line two", "Photo line three"] }], line: 2, off: 12, want: "bottom" }],
	["a picture embed then two text lines, ink on line three", { paras: [{ lines: [PIC, "Photo line two", "Photo line three"] }], line: 3, off: 12, want: "bottom" }],
	// Text, an embed, text, text: the embed's line moves, the text rows stay.
	["text, a picture embed, text, text: ink on line one", { paras: [{ lines: ["Middle one", PIC, "Middle three", "Middle four"] }], line: 1, off: 12, want: "hold" }],
	["text, a picture embed, text, text: ink on the embed's line", { paras: [{ lines: ["Middle one", PIC, "Middle three", "Middle four"] }], line: 2, off: 12, want: "embed" }],
	["text, a picture embed, text, text: ink on line three", { paras: [{ lines: ["Middle one", PIC, "Middle three", "Middle four"] }], line: 3, off: 12, want: "hold" }],
	["text, a picture embed, text, text: ink on line four", { paras: [{ lines: ["Middle one", PIC, "Middle three", "Middle four"] }], line: 4, off: 12, want: "hold" }],
	// An embed beside text on its line: the line has a start today.
	["a picture embed beside text on line two, ink on line two", { paras: [{ lines: ["Beside one", { e: "mid", pre: "see ", post: " here" }, "Beside three"] }], line: 2, off: 12, want: "hold" }],
	["a picture embed beside text on line two, ink on line three", { paras: [{ lines: ["Beside one", { e: "mid", pre: "see ", post: " here" }, "Beside three"] }], line: 3, off: 12, want: "hold" }],
	// An embedded note with a hard break in its own render: its lines are not the paragraph's.
	["an embedded note on line two, ink on the note's line", { paras: [{ lines: ["Note one", NOTE, "Note three"] }], line: 2, off: 12, want: "embed" }],
	["an embedded note on line two, ink on line three", { paras: [{ lines: ["Note one", NOTE, "Note three"] }], line: 3, off: 12, want: "hold" }],
	// Break and feed orders, without and with a line feed ending the paragraph's text.
	...ORDERS(false, ""), ...ORDERS(true, ", a line feed at the end"),
	// Blank lines by a paragraph that opens with a picture embed.
	["a blank line above a paragraph that opens with a picture embed", { paras: [{ lines: ["Blank above"] }, { lines: [PIC, "Blank two"] }, { lines: ["Blank below"] }], line: 2, off: 12, want: "hold" }],
	["a blank line below a paragraph that opens with a picture embed", { paras: [{ lines: ["Blank above"] }, { lines: [PIC, "Blank two"] }, { lines: ["Blank below"] }], line: 5, off: 12, want: "hold" }],
	// Under a transform: rows are layout px.
	["scaled 0.8: text, a picture embed, text: ink on the embed's line", { paras: [{ lines: ["Scaled one", PIC, "Scaled three"] }], line: 2, off: 12, scale: 0.8, want: "embed" }],
	["scaled 0.8: text, a picture embed, text: ink on line three", { paras: [{ lines: ["Scaled one", PIC, "Scaled three"] }], line: 3, off: 12, scale: 0.8, want: "hold" }],
	["scaled 0.8: a picture embed then text: ink on the text line", { paras: [{ lines: [PIC, "Scaled under"] }], line: 2, off: 12, scale: 0.8, want: "bottom" }],
	// An embed shorter than the line: the line's own top. Two embeds on one line: the taller one's top.
	["a small picture embed alone on line two between text lines, ink on line two", { paras: [{ lines: ["Small one", SMALL, "Small three"] }], line: 2, off: 12, want: "under" }],
	["a small picture embed alone on line two between text lines, ink on line three", { paras: [{ lines: ["Small one", SMALL, "Small three"] }], line: 3, off: 12, want: "hold" }],
	["text then a small picture embed, ink on the embed's line", { paras: [{ lines: ["Small over", SMALL] }], line: 2, off: 12, want: "under" }],
	["two picture embeds on one line, the first shorter, ink on that line", { paras: [{ lines: ["Pair one", PAIR, "Pair three"] }], line: 2, off: 12, want: "embed" }],
	["two picture embeds on one line, the first shorter, ink on line three", { paras: [{ lines: ["Pair one", PAIR, "Pair three"] }], line: 3, off: 12, want: "hold" }],
	// A picture embed beside text under a first line of only an embed: as at base; the line of text under it moves.
	["a picture embed first, then a picture embed beside text, then text: ink on the mixed line", { paras: [{ lines: [PIC, { e: "mid", pre: "see ", post: " here" }, "Mixed three"] }], line: 2, off: 12, want: "hold" }],
	["a picture embed first, then a picture embed beside text, then text: ink on line three", { paras: [{ lines: [PIC, { e: "mid", pre: "see ", post: " here" }, "Mixed three"] }], line: 3, off: 12, want: "bottom" }],
	// A plain picture alone on its line: on its row, as an embed's line.
	["text then only a plain picture, ink on the picture's line", { paras: [{ lines: ["Plain over", IMG] }], line: 2, off: 12, want: "embed" }],
	["only a plain picture first, then text, ink on the text line", { paras: [{ lines: [IMG, "Plain under"] }], line: 2, off: 12, want: "bottom" }],
	["a plain picture then two text lines, ink on line two", { paras: [{ lines: [IMG, "Plain two", "Plain three"] }], line: 2, off: 12, want: "bottom" }],
	["a plain picture then two text lines, ink on line three", { paras: [{ lines: [IMG, "Plain two", "Plain three"] }], line: 3, off: 12, want: "bottom" }],
	["scaled 0.8: text, a plain picture, text: ink on the picture's line", { paras: [{ lines: ["Scaled plain one", IMG, "Scaled plain three"] }], line: 2, off: 12, scale: 0.8, want: "embed" }],
	["scaled 0.8: text, a plain picture, text: ink on line three", { paras: [{ lines: ["Scaled plain one", IMG, "Scaled plain three"] }], line: 3, off: 12, scale: 0.8, want: "hold" }],
	...PLAIN_ORDERS(false, ""), ...PLAIN_ORDERS(true, ", a line feed at the end"),
	["a linked picture between text lines, ink on the picture's line", { paras: [{ lines: ["Linked one", LINK, "Linked three"] }], line: 2, off: 12, want: "embed" }],
	["a linked picture between text lines, ink on line three", { paras: [{ lines: ["Linked one", LINK, "Linked three"] }], line: 3, off: 12, want: "hold" }],
	["a linked picture first, then text, ink on the text line", { paras: [{ lines: [LINK, "Linked under"] }], line: 2, off: 12, want: "bottom" }],
	["two plain pictures on one line, the first shorter, ink on that line", { paras: [{ lines: ["Plain pair one", IMG_PAIR, "Plain pair three"] }], line: 2, off: 12, want: "embed" }],
	["two plain pictures on one line, the first shorter, ink on line three", { paras: [{ lines: ["Plain pair one", IMG_PAIR, "Plain pair three"] }], line: 3, off: 12, want: "hold" }],
	["a small plain picture alone on line two between text lines, ink on line two", { paras: [{ lines: ["Plain small one", IMG_SMALL, "Plain small three"] }], line: 2, off: 12, want: "under" }],
	["a small plain picture alone on line two between text lines, ink on line three", { paras: [{ lines: ["Plain small one", IMG_SMALL, "Plain small three"] }], line: 3, off: 12, want: "hold" }],
	// A picture shorter than the line alone on the paragraph's last line: no hard break closes it, its line's own top.
	["text then a small plain picture last, ink on the picture's line", { paras: [{ lines: ["Small last over", IMG_SMALL] }], line: 2, off: 12, want: "under" }],
	["text then a small plain picture last, a line feed at the end, ink on the picture's line", { paras: [{ lines: ["Small last feed over", IMG_SMALL], trail: true }], line: 2, off: 12, want: "under" }],
	["text then a tiny plain picture last, ink on the picture's line", { paras: [{ lines: ["Tiny last over", IMG_TINY] }], line: 2, off: 12, want: "under" }],
	["two text lines then a small plain picture last, ink on the picture's line", { paras: [{ lines: ["Small last one", "Small last two", IMG_SMALL] }], line: 3, off: 12, want: "under" }],
	["a picture of an svg file between text lines, ink on the picture's line", { paras: [{ lines: ["Svg file one", { e: "svgfile" }, "Svg file three"] }], line: 2, off: 12, want: "embed" }],
	["a picture of an svg file between text lines, ink on line three", { paras: [{ lines: ["Svg file one", { e: "svgfile" }, "Svg file three"] }], line: 3, off: 12, want: "hold" }],
	// A plain picture beside text on its line: as at base.
	["a plain picture and a caption first, then two text lines, ink on line two", { paras: [{ lines: [{ e: "imgmid", pre: "", post: " a caption" }, "Caption two", "Caption three"] }], line: 2, off: 12, want: "hold" }],
	["a plain picture and a caption first, then two text lines, ink on line three", { paras: [{ lines: [{ e: "imgmid", pre: "", post: " a caption" }, "Caption two", "Caption three"] }], line: 3, off: 12, want: "hold" }],
	["a plain picture beside text on line two, ink on line two", { paras: [{ lines: ["Plain beside one", { e: "imgmid", pre: "see ", post: " here" }, "Plain beside three"] }], line: 2, off: 12, want: "hold" }],
	["a plain picture beside text on line two, ink on line three", { paras: [{ lines: ["Plain beside one", { e: "imgmid", pre: "see ", post: " here" }, "Plain beside three"] }], line: 3, off: 12, want: "hold" }],
	["a plain picture first, then a plain picture beside text, then text: ink on the mixed line", { paras: [{ lines: [IMG, { e: "imgmid", pre: "see ", post: " here" }, "Plain mixed three"] }], line: 2, off: 12, want: "hold" }],
	["a plain picture first, then a plain picture beside text, then text: ink on line three", { paras: [{ lines: [IMG, { e: "imgmid", pre: "see ", post: " here" }, "Plain mixed three"] }], line: 3, off: 12, want: "bottom" }],
	// A plain picture that takes its height after the paint, and one that never loads: logged.
	["a plain picture that loads after the paint, ink on its line", { paras: [{ lines: ["Late one", { e: "late" }, "Late three"] }], line: 2, off: 12, want: "log" }],
	["a plain picture that loads after the paint, ink on line three", { paras: [{ lines: ["Late one", { e: "late" }, "Late three"] }], line: 3, off: 12, want: "log" }],
	["a plain picture that never loads, ink on its line", { paras: [{ lines: ["Broken one", { e: "broken" }, "Broken three"] }], line: 2, off: 12, want: "log" }],
	// The same shapes in an embedded note's own paragraph, the note's own ink.
	["in an embedded note: a PDF embed then two text lines, ink on line two", { paras: [{ lines: [PDF, "Inner paper two", "Inner paper three"] }], line: 2, off: 12, nested: true, want: "bottom" }],
	["in an embedded note: a PDF embed then two text lines, ink on line three", { paras: [{ lines: [PDF, "Inner paper two", "Inner paper three"] }], line: 3, off: 12, nested: true, want: "bottom" }],
	["in an embedded note: a picture embed then two text lines, ink on line two", { paras: [{ lines: [PIC, "Inner photo two", "Inner photo three"] }], line: 2, off: 12, nested: true, want: "bottom" }],
	["in an embedded note: a picture embed then two text lines, ink on line three", { paras: [{ lines: [PIC, "Inner photo two", "Inner photo three"] }], line: 3, off: 12, nested: true, want: "bottom" }],
	["in an embedded note: text, a PDF embed, text: ink on the embed's line", { paras: [{ lines: ["Inner pdf one", PDF, "Inner pdf three"] }], line: 2, off: 12, nested: true, want: "embed" }],
	["in an embedded note: text, a picture embed, text: ink on the embed's line", { paras: [{ lines: ["Inner pic one", PIC, "Inner pic three"] }], line: 2, off: 12, nested: true, want: "embed" }],
	["in an embedded note: text, a picture embed, text: ink on line three", { paras: [{ lines: ["Inner pic one", PIC, "Inner pic three"] }], line: 3, off: 12, nested: true, want: "hold" }],
	["in an embedded note: a plain picture then two text lines, ink on line two", { paras: [{ lines: [IMG, "Inner plain two", "Inner plain three"] }], line: 2, off: 12, nested: true, want: "bottom" }],
	["in an embedded note: text, a plain picture, text: ink on the picture's line", { paras: [{ lines: ["Inner plain one", IMG, "Inner plain three"] }], line: 2, off: 12, nested: true, want: "embed" }],
	["in an embedded note: control, three text lines, ink on line two", { paras: [{ lines: ["Inner control one", "Inner control two", "Inner control three"] }], line: 2, off: 12, nested: true, want: "hold" }],
	// Math and svg lines: as at base.
	["a math-only line two, ink on line two", { paras: [{ lines: ["Math one", { e: "math" }, "Math three"] }], line: 2, off: 12, want: "hold" }],
	["a math-only line two, ink on line three", { paras: [{ lines: ["Math one", { e: "math" }, "Math three"] }], line: 3, off: 12, want: "hold" }],
	["a math-only first line, ink on line two", { paras: [{ lines: [{ e: "math" }, "Math under"] }], line: 2, off: 12, want: "hold" }],
	["an svg-only line two, ink on line two", { paras: [{ lines: ["Svg one", { e: "svg" }, "Svg three"] }], line: 2, off: 12, want: "hold" }],
	["an svg-only first line, ink on line two", { paras: [{ lines: [{ e: "svg" }, "Svg under"] }], line: 2, off: 12, want: "hold" }],
	// Text only.
	["control: three text lines, ink on line two", { paras: [{ lines: ["Control one", "Control two", "Control three"] }], line: 2, off: 12, want: "hold" }],
	["control: three text lines, ink on line three", { paras: [{ lines: ["Control one", "Control two", "Control three"] }], line: 3, off: 12, want: "hold" }],
];

/** The painted y at the unfixed base, page px, per hold cell (filled from the base run's log). */
const PINS: Record<string, number> = {
	"text, a picture embed, text, text: ink on line one": 98,
	"text, a picture embed, text, text: ink on line three": 229,
	"text, a picture embed, text, text: ink on line four": 253,
	"a picture embed beside text on line two, ink on line two": 205,
	"a picture embed beside text on line two, ink on line three": 229,
	"an embedded note on line two, ink on line three": 290,
	"a blank line above a paragraph that opens with a picture embed": 114,
	"a blank line below a paragraph that opens with a picture embed": 261,
	"scaled 0.8: text, a picture embed, text: ink on line three": 183.2,
	"a small picture embed alone on line two between text lines, ink on line three": 146,
	"two picture embeds on one line, the first shorter, ink on line three": 229,
	"a picture embed first, then a picture embed beside text, then text: ink on the mixed line": 177.27,
	"scaled 0.8: text, a plain picture, text: ink on line three": 183.2,
	"a linked picture between text lines, ink on line three": 229,
	"two plain pictures on one line, the first shorter, ink on line three": 229,
	"a small plain picture alone on line two between text lines, ink on line three": 146,
	"a picture of an svg file between text lines, ink on line three": 229,
	"a plain picture and a caption first, then two text lines, ink on line two": 122,
	"a plain picture and a caption first, then two text lines, ink on line three": 146,
	"a plain picture beside text on line two, ink on line two": 205,
	"a plain picture beside text on line two, ink on line three": 229,
	"a plain picture first, then a plain picture beside text, then text: ink on the mixed line": 177.27,
	"in an embedded note: text, a picture embed, text: ink on line three": 325.39,
	"in an embedded note: control, three text lines, ink on line two": 218.39,
	"a math-only line two, ink on line two": 122,
	"a math-only line two, ink on line three": 146,
	"a math-only first line, ink on line two": 122,
	"an svg-only line two, ink on line two": 129.73,
	"an svg-only first line, ink on line two": 133.5,
	"control: three text lines, ink on line two": 122,
	"control: three text lines, ink on line three": 146,
};

let browser: Browser;
let page: Page;
const errors: string[] = [];
beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "embedLineRowsPage.ts" },
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

it.each(CELLS)("reading view rows: %s", async (name, c) => {
	const r = await page.evaluate((k) => (window as any).embedRows(k), c);
	// A logged cell's want: the picture's top on its own line, the content bottom's row on the text line under it.
	const lineTop = c.want === "embed" ? r.embedRow : c.want === "bottom" ? r.bottomRow : c.want === "under" ? r.underRow
		: c.want === "log" ? r.embedRow ?? r.bottomRow : null;
	const want = lineTop === null || lineTop === undefined ? null : Math.round((lineTop + r.off) * 100) / 100;
	const pin = PINS[name] ?? null;
	const diff = want !== null ? Math.round((r.got - want) * 100) / 100 : pin !== null ? Math.round((r.got - pin) * 100) / 100 : null;
	console.log("EMBED-ROWS", c.want, name, JSON.stringify({ want, pin, diff, ...r }));
	expect(r.error, "a layer was painted").toBeUndefined();
	expect(r.unchanged, "the strokes are the same after the paint").toBe(true);
	if (c.want === "log") {
		// Logged only: no bar on where it is painted.
	} else if (c.want === "hold") {
		expect(pin, `a base pin for ${name} (got ${r.got})`).not.toBeNull();
		expect(Math.abs(r.got - pin!) <= 0.01, `painted ${r.got}, base ${pin}: ${diff}`).toBe(true);
	} else {
		expect(want, "a want").not.toBeNull();
		expect(Math.abs(r.got - want!) <= 0.5, `painted ${r.got} want ${want}: ${diff} (even share ${r.estimate})`).toBe(true);
	}
	expect(errors).toEqual([]);
});
