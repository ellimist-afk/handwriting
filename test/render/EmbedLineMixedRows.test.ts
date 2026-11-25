/**
 * READING VIEW ROWS FOR A LINE THAT HOLDS A PICTURE AND TEXT, AND FOR A LINE THAT HOLDS ONLY A PLAIN PICTURE. LOG ONLY.
 *
 * A paragraph's rows are read from each source line's first character (src/inline/EmbedInkMeasure.ts lineStarts):
 * row k is the paragraph's content top plus the k-th line's first character's top less the first line's. An embed's
 * span is skipped there. A line that holds a picture embed and then a caption has a start, the caption's first
 * character; beside a picture taller than the text that character sits low in its row, near the baseline. A line that
 * holds only a plain picture (an img the renderer writes for an external picture or a raw img, with no embed span) has
 * no start. These cells say, in px, where such lines' ink is painted and where their lines are. They assert nothing
 * about the rows: each logs the want, the painted y, the difference, the even share and the first-character estimate.
 *
 * Cells, one paragraph each, one stroke per run:
 *  - a picture embed then a caption on the first line, then two text lines; ink on line two, and ink on line three.
 *    Want: the text line's row top, the paragraph's content bottom less the text rows from that line down (the text
 *    rows hold no picture and do not wrap, one line height each).
 *  - a text line, then a picture embed then a caption; ink on that second line. Want: the picture's top, the tallest
 *    box on the row, so the row's top.
 *  - a text line, then a line of only a plain picture; ink on the picture's line. Want: the picture's top.
 *  - a line of only a plain picture, then a text line; ink on the text line. Want: the content bottom less one line
 *    height.
 *  One control, three text lines joined by hard breaks, ink on line two, measured the same way as the first cell's
 *  line two. The control alone is asserted, within 0.5 px, so the instrument is shown to read a middle row.
 *
 * The painted y is the alpha-weighted centre of the layer's painted pixels, page px. The offset is the stroke's centre
 * below its anchor line's top. The pictures are data-URI svgs of 200 x 100 with their width and height set. The view's
 * rules are EmbedLineReadingView.test.ts's.
 *
 * Run: npm run test:render -- EmbedLineMixedRows --reporter=default --silent=false.
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
`;

const PAGE = `
import { attachEmbedInkOnceReady, initEmbedInkRefresh, teardownEmbedInk } from "../../src/inline/EmbedInk";
import { aboveOf, lineKey, newAboveRun } from "../../src/inline/LineAnchor";
import { installObsidianDom } from "./obsidianDom";

installObsidianDom();

const PICTURE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='100'/%3E";
const EMBED = "![[Photo.png]]";
const PLAIN = '<img src="plain.png">';

// The note, 1-based as the editor numbers it; a blank line between paragraphs.
const NOTE = [
	EMBED + " caption beside it", "second line under the picture", "third line under the picture", "",
	"text line above the picture", EMBED + " caption beside it", "",
	"text line above a plain picture", PLAIN, "",
	PLAIN, "text line below a plain picture", "",
	"control first line", "control second line", "control third line",
];
const TEXT = NOTE.join("\\n");
// 0-based first and last line of each paragraph.
const PARAS = [[0, 2], [4, 5], [7, 8], [10, 11], [13, 15]];
const EDITOR_LINE = 24;
const editorTop = line => (line - 1) * EDITOR_LINE;

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const r2 = v => v === null ? null : Math.round(v * 100) / 100;

/** One horizontal stroke whose centre is off px under 1-based line's top in the editor, anchored to that line. */
function strokeFor(line, off) {
	const y = editorTop(line) + off, pad = 4;
	const points = Array.from({ length: 12 }, (_, j) => ({ x: 60 + j * 8, y, pressure: 0.5, t: j * 9 }));
	const bbox = { x: 60 - pad, y: y - pad, width: 88 + 2 * pad, height: 2 * pad };
	return { id: "cell-" + line, tool: "pen", color: "#ff00ff", width: 3, createdAt: 0, points, bbox,
		lineAnchor: { line, top: editorTop(line), y: bbox.y, key: lineKey(NOTE[line - 1]), width: 668, fontPx: 16,
			above: aboveOf(newAboveRun(), line, k => lineKey(NOTE[k - 1])) } };
}

function pictureImg() {
	const img = document.createElement("img");
	img.setAttribute("src", PICTURE);
	img.setAttribute("width", "200");
	img.setAttribute("height", "100");
	return img;
}

/** A picture embed's span as Obsidian makes it. */
function embedSpan() {
	const span = document.createElement("span");
	span.className = "internal-embed media-embed image-embed is-loaded";
	span.setAttribute("src", "Photo.png");
	span.setAttribute("alt", "Photo.png");
	span.appendChild(pictureImg());
	return span;
}

/**
 * One source line's nodes, and its first character that is not white space outside an embed (null for none), and its
 * picture (null for none).
 */
function lineOf(src) {
	if (src === PLAIN) {
		const img = pictureImg();
		return { nodes: [img], start: null, img };
	}
	if (src.startsWith(EMBED)) {
		const span = embedSpan();
		const rest = src.slice(EMBED.length);
		const caption = document.createTextNode(rest);
		return { nodes: [span, caption], start: [caption, rest.search(/\\S/)], img: span.querySelector("img") };
	}
	const t = document.createTextNode(src);
	return { nodes: [t], start: [t, 0], img: null };
}

/** A paragraph's p: its source lines, a br and a line feed between each, as the renderer writes a hard break. */
function paraOf(first, last) {
	const p = document.createElement("p");
	const lines = [];
	for (let l = first; l <= last; l++) {
		if (l > first) p.append(document.createElement("br"), "\\n");
		const o = lineOf(NOTE[l]);
		p.append(...o.nodes);
		lines.push(o);
	}
	return { p, lines };
}

/** The client top of one character, as the measure reads it. */
function charTop(node, at) {
	const range = document.createRange();
	range.setStart(node, at);
	range.setEnd(node, at + 1);
	const rect = range.getClientRects().item(0);
	return rect ? rect.top : null;
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
window.mixedRow = async (c) => {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "theme-light";
	const root = document.body.createDiv({ cls: "markdown-preview-view markdown-rendered" });
	const sizer = root.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
	sizer.createDiv({ cls: "markdown-preview-pusher" });
	const header = sizer.createDiv({ cls: "mod-header" });
	header.createDiv({ cls: "inline-title", text: "Mixed rows" });
	const sections = PARAS.map(([first, last]) => {
		const el = sizer.createDiv({ cls: "el-p" });
		const para = paraOf(first, last);
		el.appendChild(para.p);
		return { el, para, lineStart: first, lineEnd: last };
	});
	await frame();
	const strokes = [strokeFor(c.line, c.off)];
	initEmbedInkRefresh(() => strokes);
	for (const s of sections) {
		attachEmbedInkOnceReady(s.el, sizer, "mixed-rows.md", () => strokes, undefined, false, {
			section: () => ({ text: TEXT, lineStart: s.lineStart, lineEnd: s.lineEnd }),
			cached: () => null,
		});
	}
	await frame();
	await frame();
	const got = paintedY(root);
	if (got === null) return { error: "nothing painted" };
	const sec = sections.find(s => s.lineStart <= c.line - 1 && c.line - 1 <= s.lineEnd);
	const p = sec.para.p, pr = p.getBoundingClientRect(), box = sec.el.getBoundingClientRect();
	const lh = parseFloat(getComputedStyle(p).lineHeight);
	const k = c.line - 1 - sec.lineStart, n = sec.lineEnd - sec.lineStart + 1;
	const line = sec.para.lines[k], line0 = sec.para.lines[0];
	// The text rows from this line to the paragraph's last, one line height each, up from the content bottom.
	const fromBottom = pr.bottom - (n - k) * lh;
	const pictureTop = line.img ? line.img.getBoundingClientRect().top : null;
	// Second readings, logged only: the rows above, all text, down from the content top; the line's first character's
	// box centred in its line height.
	const fromTop = pr.top + k * lh;
	let charRowTop = null;
	if (line.start) {
		const range = document.createRange();
		range.setStart(line.start[0], line.start[1]);
		range.setEnd(line.start[0], line.start[1] + 1);
		const cr = range.getBoundingClientRect();
		charRowTop = cr.top - (lh - cr.height) / 2;
	}
	// The first-character estimate: the content top plus this line's first character's top less the first line's.
	const ct = line.start ? charTop(line.start[0], line.start[1]) : null;
	const ct0 = line0.start ? charTop(line0.start[0], line0.start[1]) : null;
	const firstCharRow = ct !== null && ct0 !== null ? pr.top + (ct - ct0) : null;
	const lineTop = c.want === "picture" ? pictureTop : fromBottom;
	const want = lineTop + c.off;
	const estimate = box.top + (k * box.height) / n + c.off;
	return {
		want: r2(want), got: r2(got), diff: r2(got - want), estimate: r2(estimate), gotLessEstimate: r2(got - estimate),
		firstCharEstimate: r2(firstCharRow === null ? null : firstCharRow + c.off),
		gotLessFirstChar: r2(firstCharRow === null ? null : got - (firstCharRow + c.off)),
		lineTop: r2(lineTop), blockTop: r2(box.top), blockHeight: r2(box.height), lineHeight: lh,
		fromBottom: r2(fromBottom), fromTop: r2(fromTop), pictureTop: r2(pictureTop), charRowTop: r2(charRowTop),
		firstCharTop: r2(ct), firstLineCharTop: r2(ct0),
	};
};
`;

/** One cell: its 1-based anchor line, the stroke's offset under it, and which row is the line's own. */
interface Cell { line: number; off: number; want: "picture" | "bottom" }

const CELLS: Array<[string, Cell]> = [
	["a picture and caption first, then two text lines, ink on line two", { line: 2, off: 12, want: "bottom" }],
	["a picture and caption first, then two text lines, ink on line three", { line: 3, off: 12, want: "bottom" }],
	["a text line, then a picture and caption, ink on the picture's line", { line: 6, off: 12, want: "picture" }],
	["a text line, then only a plain picture, ink on the picture's line", { line: 9, off: 12, want: "picture" }],
	["only a plain picture first, then a text line, ink on the text line", { line: 12, off: 12, want: "bottom" }],
];
const CONTROL: [string, Cell] = ["control: three text lines after hard breaks, ink on line two", { line: 15, off: 12, want: "bottom" }];

let browser: Browser;
let page: Page;
const errors: string[] = [];
beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "embedLineMixedRowsPage.ts" },
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

it("reading view mixed rows, control: a middle text row is read within 0.5 px", async () => {
	const [name, c] = CONTROL;
	const r = await page.evaluate((k) => (window as any).mixedRow(k), c);
	console.log("EMBED-MIXED-ROW", name, JSON.stringify(r));
	expect(r.error, "a layer was painted").toBeUndefined();
	expect(Math.abs(r.diff) <= 0.5, `painted ${r.got} want ${r.want}: ${r.diff}`).toBe(true);
	expect(errors).toEqual([]);
});

it.each(CELLS)("reading view mixed rows, logged: %s", async (name, c) => {
	const r = await page.evaluate((k) => (window as any).mixedRow(k), c);
	console.log("EMBED-MIXED-ROW", name, JSON.stringify(r));
	expect(r.error, "a layer was painted").toBeUndefined();
	expect(errors).toEqual([]);
});
