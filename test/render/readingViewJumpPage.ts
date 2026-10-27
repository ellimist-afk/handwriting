/**
 * The page for ReadingViewJump.test.ts: a real note's text and a real sidecar's ink, shown as the editor shows them and
 * as Reading view shows them, and how far each stroke moves between the two.
 *
 * Input: the note's text and the sidecar's JSON, copied from a vault (nothing is written back). The ink is parsed by
 * the plugin's own parser; the Reading view is the ReadingViewInk rig's shape (view > sizer > pusher, header, one div
 * per section, each post-processed with its own section info), with the text laid out as a paragraph whose single
 * newlines are hard breaks. Every figure comes from the plugin's own code (`embedInkDy`, `lineTopIn`, `rowTopIn`,
 * `measureSpans`) reading that DOM.
 *
 * - `jumpLoad(sidecar)`: parse once; counts.
 * - `jumpView(o)`: build the Reading view with one probe stroke and measure it: the zoom, the header delta (how far
 *   below the ink's origin the text starts), each line's rendered top against the line box it should have, and every
 *   stroke's correction and the guard that held it back.
 * - `jumpPaint(o)`: the shown ink painted for one stroke, with and without its anchor, so the painted move is read from
 *   pixels and set against the correction the code computed.
 * - `jumpShot(o)`: the whole note painted, for a screenshot: the Reading view, or a model of the editor.
 * - `stableRun(o)`: a small note of a nested list, a quote, a table and blank lines, a stroke anchored on each line, and the
 *   correction every stroke is shown with while each section in turn is detached from the sizer and attached again.
 * Stored coordinates are world units; the layer draws them at `zoom` px each.
 */
import { attachEmbedInkOnceReady, initEmbedInkColumnWidth, initEmbedInkFontRef, initEmbedInkRefresh, inkZoomOf, placeStrokes, teardownEmbedInk } from "../../src/inline/EmbedInk";
import { embedInkDy, lineTopIn, rowTopIn, shownStrokes, splitLines } from "../../src/inline/EmbedInkLines";
import { measureSpans } from "../../src/inline/EmbedInkMeasure";
import { aboveOf, lineKey, newAboveRun, shiftedStroke } from "../../src/inline/LineAnchor";
import type { InkStroke } from "../../src/ink/Stroke";
import { parsePage } from "../../src/model/PageData";
import { installObsidianDom } from "./obsidianDom";

installObsidianDom();

const PATH = "Untitled 1.md";
/** A stroke's correction smaller than this is no correction (EmbedInkLines.ts SAME_DY). */
const SAME_DY = 1e-3;
const Y_SLACK = 0.5;

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const r2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const w = window as unknown as Record<string, unknown>;

let STROKES: InkStroke[] = [];
let FONT_REF = 17;
let BODY_Y = 0;

export interface ViewOpts {
	/** The note's text as the renderer's section info and the metadata cache give it. */
	text: string;
	/** Reading view's text size, px, and its line height as a multiple. */
	font: number;
	lh: number;
	/** Keep the source's leading tabs in the rendered paragraph's text (the layout reads the same either way). */
	tabsInDom: boolean;
	/** Strokes to attach: ids, or null for every stroke (a probe stroke alone is enough to measure). */
	ids: string[] | null;
	/** The probe stroke the view is mounted with when `ids` is empty. */
	probe?: string;
	/** Mount the strokes without their anchors (they keep their page positions). */
	free?: boolean;
}

function reset(): void {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "theme-light";
}

/** The paragraph's html as the renderer writes it: leading white space of a continued line eaten, a break and a line feed after each line. */
function paragraphHtml(lines: string[], from: number, to: number, tabsInDom: boolean): string {
	const out: string[] = [];
	for (let i = from; i <= to; i++) out.push(tabsInDom ? lines[i]! : lines[i]!.replace(/^[ \t]+/, ""));
	return `<p>${out.join("<br>\n")}</p>`;
}

/** The cached sections of a note whose body is one paragraph under a frontmatter. */
function sectionsOf(lines: string[]): Array<{ type: string; lineStart: number; lineEnd: number }> {
	let fm = -1;
	if (lines[0] === "---") for (let i = 1; i < lines.length; i++) if (lines[i] === "---") { fm = i; break; }
	const out: Array<{ type: string; lineStart: number; lineEnd: number }> = [];
	if (fm >= 0) out.push({ type: "yaml", lineStart: 0, lineEnd: fm });
	out.push({ type: "paragraph", lineStart: fm + 1, lineEnd: lines.length - 1 });
	return out;
}

const VIEW_CSS = (font: number, lh: number) => `
body { margin: 0; font-family: sans-serif; }
.markdown-preview-view { font-size: ${font}px; line-height: ${lh}; padding: 32px; position: relative; overflow-y: auto; box-sizing: border-box; width: 100%; }
.markdown-rendered > :first-child { margin-top: 0; }
.markdown-rendered p { margin-block-start: 1rem; margin-block-end: 1rem; }
.markdown-preview-sizer { max-width: 700px; margin: 0 auto; }
.inline-title { font-size: 2em; line-height: 1.2; font-weight: 700; margin-bottom: 0.5em; }
.metadata-container { padding: 8px 0; }
.metadata-property { height: 30px; }
.mod-frontmatter { display: none; }
`;

async function readingViewOf(o: ViewOpts) {
	reset();
	for (const s of Array.from(document.querySelectorAll("style[data-jump]"))) s.remove();
	const style = document.createElement("style");
	style.setAttribute("data-jump", "1");
	style.textContent = VIEW_CSS(o.font, o.lh);
	document.head.appendChild(style);
	const lines = splitLines(o.text);
	const secs = sectionsOf(lines);
	const root = document.body.createDiv({ cls: "markdown-preview-view markdown-rendered" });
	const sizer = root.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
	sizer.createDiv({ cls: "markdown-preview-pusher" });
	const header = sizer.createDiv({ cls: "mod-header" });
	header.createDiv({ cls: "inline-title", text: "Untitled 1" });
	const props = header.createDiv({ cls: "metadata-container" });
	props.createDiv({ cls: "metadata-property", text: "handwriting-page-id" });
	const els: Array<{ el: HTMLElement; lineStart: number; lineEnd: number; type: string }> = [];
	for (const s of secs) {
		if (s.type === "yaml") {
			const fm = sizer.createDiv({ cls: "mod-frontmatter mod-ui" });
			fm.createEl("pre", { cls: "frontmatter", text: lines.slice(s.lineStart + 1, s.lineEnd).join("\n") });
			els.push({ el: fm, ...s });
		} else {
			const el = sizer.createDiv({ cls: "el-p" });
			el.innerHTML = paragraphHtml(lines, s.lineStart, s.lineEnd, o.tabsInDom);
			els.push({ el, ...s });
		}
	}
	await frame();
	const ids = o.ids ?? (STROKES.map((s) => s.id));
	const pick = ids.length > 0 ? ids : o.probe ? [o.probe] : [STROKES[0]!.id];
	const byId = new Map(STROKES.map((s) => [s.id, s] as const));
	let strokes = pick.map((id) => byId.get(id)!);
	if (o.free) strokes = strokes.map((s) => { const c = { ...s }; delete c.lineAnchor; return c; });
	initEmbedInkRefresh(() => strokes);
	initEmbedInkFontRef(() => FONT_REF);
	for (const s of els) {
		attachEmbedInkOnceReady(s.el, sizer, PATH, () => strokes, undefined, false, {
			section: () => ({ text: o.text, lineStart: s.lineStart, lineEnd: s.lineEnd }),
			cached: () => null,
		});
	}
	await frame();
	await frame();
	return { root, sizer, header, els, strokes, lines };
}

/** The painted centre of the canvas layer's pixels, page px, or null when nothing is painted. */
function canvasCentre(root: HTMLElement): { x: number; y: number } | null {
	const layer = root.querySelector<HTMLCanvasElement>(":scope > canvas.handwriting-embed-ink");
	if (!layer) return null;
	const lr = layer.getBoundingClientRect();
	const d = layer.getContext("2d")!.getImageData(0, 0, layer.width, layer.height).data;
	let y0 = 1e9, y1 = -1, x0 = 1e9, x1 = -1;
	for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) if (d[(y * layer.width + x) * 4 + 3]! > 0) {
		if (y < y0) y0 = y;
		if (y > y1) y1 = y;
		if (x < x0) x0 = x;
		if (x > x1) x1 = x;
	}
	if (y1 < 0) return null;
	return { x: lr.left + ((x0 + x1 + 1) / 2) * (lr.width / layer.width), y: lr.top + ((y0 + y1 + 1) / 2) * (lr.height / layer.height) };
}

/** Why a stroke is shown at its page position, or "moved": embedInkDy's guards in its order. */
function reasonFor(s: InkStroke, lines: readonly string[], aboveAt: (i: number) => number, top: (i: number) => number | null, zoom: number) {
	const a = s.lineAnchor;
	if (!a) return { why: "no anchor", dy: 0 };
	if (!Number.isInteger(a.line) || a.line < 1 || a.line > lines.length) return { why: "line outside the text", dy: 0 };
	if (Math.abs(a.y - s.bbox.y) > Y_SLACK) return { why: "stroke moved off its anchor", dy: 0 };
	const i = a.line - 1;
	if (lineKey(lines[i]!) !== a.key) return { why: "line text differs from the anchor's key", dy: 0 };
	if (a.above !== undefined && a.above !== aboveAt(i)) return { why: "text above differs", dy: 0 };
	const t = top(i);
	if (t === null) return { why: "no top for the line", dy: 0 };
	const dy = t / zoom - a.top;
	if (!Number.isFinite(dy) || Math.abs(dy) < SAME_DY) return { why: "correction under 0.001", dy: 0 };
	return { why: "moved", dy };
}

w.jumpLoad = (sidecar: string) => {
	const parsed = parsePage(sidecar, "75d1627a-c4d7-4a11-947d-bc26b7f83c20");
	STROKES = parsed.data.strokes as InkStroke[];
	FONT_REF = parsed.data.fontRefPx ?? 17;
	const body = (parsed.data.textBoxes ?? []).find((t) => t.id === "handwriting-body");
	BODY_Y = body ? body.y : 0;
	return {
		strokes: STROKES.length,
		anchored: STROKES.filter((s) => s.lineAnchor).length,
		fontRef: FONT_REF,
		bodyY: BODY_Y,
		noteCanvas: (parsed.data as unknown as { noteCanvas?: boolean }).noteCanvas ?? null,
		damaged: parsed.damaged ?? false,
		firstAnchored: STROKES.find((s) => s.lineAnchor)!.id,
	};
};

w.jumpView = async (o: ViewOpts) => {
	const { root, sizer, header, els, lines } = await readingViewOf({ ...o, ids: [] });
	const zoom = inkZoomOf(root, PATH);
	const spans = measureSpans(root);
	if (!spans) return { error: "no spans" };
	const para = els.find((e) => e.type === "paragraph")!;
	const block = spans.blocks.find((b) => b.lineStart === para.lineStart)!;
	const box = block.box()!;
	const p = para.el.querySelector("p")!;
	const ps = getComputedStyle(p);
	const lhPx = parseFloat(ps.lineHeight);
	const rect = (e: Element) => e.getBoundingClientRect();
	const sizerRect = rect(sizer);
	// The layer's origin (the ink's y 0) in page px: the paragraph section's top less its top in the layer's frame.
	const originClient = rect(para.el).top - box.top;
	const rows = block.rows?.() ?? null;
	const content = rect(p).top + p.clientTop + (parseFloat(ps.paddingTop) || 0);
	const rowReport: Array<Record<string, unknown>> = [];
	for (let i = para.lineStart; i <= para.lineEnd; i++) {
		const rowTop = rowTopIn(spans.lines, block, i);
		const lineTop = lineTopIn(spans, i);
		// A line box that does not wrap: the paragraph's content top plus the lines above it, each one line high.
		const truth = content - originClient + (i - para.lineStart) * lhPx;
		rowReport.push({ line: i + 1, rowTopIn: r2(rowTop), lineTopIn: r2(lineTop), truth: r2(truth), diff: r2(lineTop === null ? null : lineTop - truth) });
	}
	const aboveRun = newAboveRun();
	const aboveAt = (i: number) => aboveOf(aboveRun, i + 1, (k) => lineKey(lines[k - 1]!));
	const top = (i: number) => lineTopIn(spans, i);
	const reasons: Record<string, number> = {};
	const perLine = new Map<number, { n: number; moved: number; dys: number[] }>();
	const csv: string[] = ["id,line,anchoredTop,y,why,dyWorld,dyPx,jumpPxBodyAt0,jumpPxBodyAtBox"];
	const trueTop = lineTopIn(spans, para.lineStart)!;
	for (const s of STROKES) {
		const r = reasonFor(s, lines, aboveAt, top, zoom);
		reasons[r.why] = (reasons[r.why] ?? 0) + 1;
		const a = s.lineAnchor;
		// How far the ink sits from the text after the switch, px: where it is drawn, less where the text starts, set
		// against the same in the editor (text at the body box's top, the ink's own world coordinates).
		const view = (s.bbox.y + r.dy) * zoom - trueTop;
		const jump0 = view - s.bbox.y * zoom;
		const jumpBox = view - (s.bbox.y - BODY_Y) * zoom;
		if (a) {
			const e = perLine.get(a.line) ?? { n: 0, moved: 0, dys: [] };
			e.n++;
			if (r.why === "moved") { e.moved++; e.dys.push(r.dy); }
			perLine.set(a.line, e);
		}
		csv.push([s.id, a ? a.line : "", a ? a.top : "", r2(s.bbox.y), `"${r.why}"`, r2(r.dy), r2(r.dy * zoom), r2(jump0), r2(jumpBox)].join(","));
	}
	const lineStats = [...perLine.entries()].sort((x, y) => x[0] - y[0]).map(([line, e]) => ({
		line, n: e.n, moved: e.moved,
		dyWorldMin: r2(e.dys.length ? Math.min(...e.dys) : null), dyWorldMax: r2(e.dys.length ? Math.max(...e.dys) : null),
		dyPxMin: r2(e.dys.length ? Math.min(...e.dys) * zoom : null), dyPxMax: r2(e.dys.length ? Math.max(...e.dys) * zoom : null),
	}));
	return {
		zoom: r2(zoom), font: o.font, lh: o.lh, lhPx: r2(lhPx),
		header: { sizerTop: r2(sizerRect.top), headerBottom: r2(rect(header).bottom), originClient: r2(originClient), originBelowHeader: r2(originClient - rect(header).bottom) },
		headerDeltaPx: r2(trueTop), headerDeltaWorld: r2(trueTop / zoom),
		paragraph: { sectionTop: r2(rect(para.el).top - originClient), pTop: r2(rect(p).top - originClient), contentTop: r2(content - originClient), height: r2(rect(p).height), lines: Math.round(rect(p).height / lhPx) },
		rowsKind: rows ? rows.kind : null, rowsCount: rows ? rows.count : null,
		rowReport, reasons, lineStats, csv: csv.join("\n"),
	};
};

w.jumpPaint = async (o: ViewOpts) => {
	const a = await readingViewOf({ ...o, free: false });
	const shown = canvasCentre(a.root);
	const zoom = inkZoomOf(a.root, PATH);
	const b = await readingViewOf({ ...o, free: true });
	const at = canvasCentre(b.root);
	if (!shown || !at) return { error: "nothing painted" };
	return { zoom: r2(zoom), shownY: r2(shown.y), pageY: r2(at.y), movedPx: r2(shown.y - at.y) };
};

/** The whole note and every stroke painted, for a screenshot. `editor`: a model of the editor instead (see the test). */
w.jumpShot = async (o: ViewOpts & { editor?: boolean; bodyY?: number; tops?: Record<number, number> }) => {
	if (!o.editor) {
		const v = await readingViewOf({ ...o, ids: null });
		return { zoom: r2(inkZoomOf(v.root, PATH)), strokes: v.strokes.length };
	}
	reset();
	for (const s of Array.from(document.querySelectorAll("style[data-jump]"))) s.remove();
	const style = document.createElement("style");
	style.setAttribute("data-jump", "1");
	style.textContent = VIEW_CSS(o.font, o.lh) + ".jump-editor { position: relative; padding: 0;  font-size: " + o.font + "px; width: 700px; margin: 0 auto; } .jump-line { position: absolute; left: 0; white-space: pre; }";
	document.head.appendChild(style);
	const lines = splitLines(o.text);
	const zoom = o.font / FONT_REF;
	const print = document.body.createDiv({ cls: "print" });
	const root = print.createDiv({ cls: "jump-editor markdown-preview-view markdown-rendered" });
	// The ink layer is placed from the first block; a block one px high at the top stands for the editor's first line.
	root.createDiv().style.height = "1px";
	const bodyY = o.bodyY ?? 0;
	// The editor: the frontmatter hidden, every line at the top its anchors recorded, the body box at its place.
	const first = lines[0] === "---" ? lines.indexOf("---", 1) + 1 : 0;
	for (let i = first; i < lines.length; i++) {
		const el = root.createDiv({ cls: "jump-line", text: lines[i]!.replace(/\t/, "    ") });
		el.style.top = `${((o.tops?.[i + 1] ?? 0) + bodyY) * zoom}px`;
	}
	root.style.height = "1200px";
	// Anchored ink whose line is still the line it was written on follows that line to where the editor has it now (the
	// body box's top plus the line's top); every other stroke stays at its world position.
	const strokes = STROKES.map((s) => {
		const a = s.lineAnchor;
		if (!a || a.line < 1 || a.line > lines.length || lineKey(lines[a.line - 1]!) !== a.key || Math.abs(a.y - s.bbox.y) > Y_SLACK) return s;
		const now = o.tops?.[a.line];
		return now === undefined ? s : shiftedStroke(s, now + bodyY - a.top);
	});
	initEmbedInkRefresh(() => strokes);
	initEmbedInkFontRef(() => FONT_REF);
	initEmbedInkColumnWidth(() => 700);
	attachEmbedInkOnceReady(root, root, PATH, () => strokes, undefined, false, { section: () => null, cached: () => null });
	await frame();
	await frame();
	return { zoom: r2(zoom), strokes: strokes.length };
};

/**
 * The strokes as the view shows them under a signature: `sig` an open editor's (width, font, character width), or null
 * for none open. Each anchored stroke's shown move, grouped by its anchor's width, set against the move it takes with no
 * signature guard (`embedInkDy` with none given), so the group the signature keeps can be checked unchanged.
 */
w.jumpGuard = async (o: ViewOpts & { sig: { width: number; fontPx: number; charWidth: number } | null }) => {
	const { root } = await readingViewOf({ ...o, ids: [] });
	const zoom = inkZoomOf(root, PATH);
	const spans = measureSpans(root);
	if (!spans) return { error: "no spans" };
	const shown = shownStrokes(STROKES, spans, zoom, o.sig);
	const groups: Record<string, { n: number; moved: number; frontmatter: number; frontmatterMoved: number; sameAsUnguarded: number; differ: number }> = {};
	let newest: InkStroke | null = null;
	STROKES.forEach((s, k) => {
		const a = s.lineAnchor;
		if (!a) return;
		if (!newest || s.createdAt >= newest.createdAt) newest = s;
		const g = (groups[String(a.width)] ??= { n: 0, moved: 0, frontmatter: 0, frontmatterMoved: 0, sameAsUnguarded: 0, differ: 0 });
		const dy = shown[k]!.bbox.y - s.bbox.y;
		g.n++;
		if (Math.abs(dy) > 1e-9) g.moved++;
		if (a.line <= 3) {
			g.frontmatter++;
			if (Math.abs(dy) > 1e-9) g.frontmatterMoved++;
			return;
		}
		if (Math.abs(dy - embedInkDy(s, spans, zoom)) <= 1e-9) g.sameAsUnguarded++;
		else g.differ++;
	});
	const nw = newest as InkStroke | null;
	return { zoom: r2(zoom), groups, newest: nw ? { width: nw.lineAnchor!.width, fontPx: nw.lineAnchor!.fontPx, createdAt: nw.createdAt } : null };
};

/** The stability note, one entry per editor line (1-based in the anchors): a nested list, a quote, a table, blank lines between. */
const STABLE_NOTE = [
	"---", "handwriting-page-id: stable", "---",
	"- parent one", "\t- child a", "\t\t- grandchild", "- parent two", "",
	"> quote first", "> quote second", "",
	"| h1 | h2 |", "| -- | -- |", "| a1 | a2 |", "| b1 | b2 |", "",
	"paragraph one", "", "",
	"paragraph two",
];
/** Its sections as the renderer lays them (0-based lines): the html of each and the class its element wears. */
const STABLE_SECTIONS = [
	{ name: "nested list", cls: "el-ul", lineStart: 3, lineEnd: 6, html: "<ul><li>parent one<ul><li>child a<ul><li>grandchild</li></ul></li></ul></li><li>parent two</li></ul>" },
	{ name: "quote", cls: "el-blockquote", lineStart: 8, lineEnd: 9, html: "<blockquote><p>quote first<br>\nquote second</p></blockquote>" },
	{ name: "table", cls: "el-table", lineStart: 11, lineEnd: 14, html: "<table><thead><tr><th>h1</th><th>h2</th></tr></thead><tbody><tr><td>a1</td><td>a2</td></tr><tr><td>b1</td><td>b2</td></tr></tbody></table>" },
	{ name: "first paragraph", cls: "el-p", lineStart: 16, lineEnd: 16, html: "<p>paragraph one</p>" },
	{ name: "last paragraph", cls: "el-p", lineStart: 19, lineEnd: 19, html: "<p>paragraph two</p>" },
];

/** One stroke on each line below the frontmatter, anchored to it, drawn 5 world units under a line top the editor is taken to have put at 7.113 a line. */
function stableStrokes(): InkStroke[] {
	const out: InkStroke[] = [];
	for (let line = 4; line <= STABLE_NOTE.length; line++) {
		const top = 0.37 + (line - 4) * 7.113, y = top + 5;
		const points = Array.from({ length: 8 }, (_, j) => ({ x: 20 + j * 6, y, pressure: 0.5, t: j * 9 }));
		const bbox = { x: 18, y: y - 2, width: 48, height: 4 };
		const s = { id: `stable-${line}`, tool: "pen", color: "#ff00ff", width: 2, createdAt: 0, points, bbox } as InkStroke;
		s.lineAnchor = { line, top, y: bbox.y, key: lineKey(STABLE_NOTE[line - 1]!), width: 668, fontPx: 12, above: aboveOf(newAboveRun(), line, (k) => lineKey(STABLE_NOTE[k - 1]!)) };
		out.push(s);
	}
	return out;
}

/** Every stroke's correction in the view as the plugin places it now, world units (the zoom is 1 here). */
function stableDys(root: HTMLElement, strokes: InkStroke[]): number[] {
	const placed = placeStrokes(root, strokes, undefined, inkZoomOf(root, PATH), PATH).strokes;
	return strokes.map((s, k) => placed[k]!.bbox.y - s.bbox.y);
}

/** What the renderer does to a section it scrolls out: the element leaves the sizer and an unseen copy of it holds the text still, margins and all. */
function detachSection(el: HTMLElement): HTMLElement {
	const holder = el.cloneNode(true) as HTMLElement;
	holder.style.visibility = "hidden";
	el.replaceWith(holder);
	return holder;
}

w.stableRun = async (o: { font: number; lh: number }) => {
	reset();
	for (const s of Array.from(document.querySelectorAll("style[data-jump]"))) s.remove();
	const style = document.createElement("style");
	style.setAttribute("data-jump", "1");
	style.textContent = VIEW_CSS(o.font, o.lh);
	document.head.appendChild(style);
	const root = document.body.createDiv({ cls: "markdown-preview-view markdown-rendered" });
	const sizer = root.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
	sizer.createDiv({ cls: "markdown-preview-pusher" });
	const header = sizer.createDiv({ cls: "mod-header" });
	header.createDiv({ cls: "inline-title", text: "Stable" });
	const props = header.createDiv({ cls: "metadata-container" });
	props.createDiv({ cls: "metadata-property", text: "handwriting-page-id" });
	const fm = sizer.createDiv({ cls: "mod-frontmatter mod-ui" });
	fm.createEl("pre", { cls: "frontmatter", text: STABLE_NOTE[1]! });
	const text = STABLE_NOTE.join("\n");
	const secs = STABLE_SECTIONS.map((s) => {
		const el = sizer.createDiv({ cls: s.cls });
		el.innerHTML = s.html;
		// One section with a line height of its own, so a blank line above it is not placed by the view's line height.
		if (s.name === "last paragraph") el.style.lineHeight = "2";
		return { ...s, el };
	});
	await frame();
	const strokes = stableStrokes();
	initEmbedInkRefresh(() => strokes);
	initEmbedInkFontRef(() => o.font);
	for (const s of [{ el: fm, lineStart: 0, lineEnd: 2 }, ...secs]) {
		attachEmbedInkOnceReady(s.el, sizer, PATH, () => strokes, undefined, false, {
			section: () => ({ text, lineStart: s.lineStart, lineEnd: s.lineEnd }),
			cached: () => null,
		});
	}
	await frame();
	await frame();
	const zoom = inkZoomOf(root, PATH);
	const tops = () => secs.map((s) => (s.el.isConnected ? s.el.getBoundingClientRect().top : null));
	const baseTops = tops();
	// The first read measures every block the strokes need, so a section that leaves keeps the box it was laid out at.
	const base = stableDys(root, strokes);
	const again = stableDys(root, strokes);
	const rows = strokes.map((s, k) => ({ line: s.lineAnchor!.line, text: STABLE_NOTE[s.lineAnchor!.line - 1]!, section: secs.find((x) => s.lineAnchor!.line - 1 >= x.lineStart && s.lineAnchor!.line - 1 <= x.lineEnd)?.name ?? "blank", base: base[k]! }));
	const spans = measureSpans(root);
	const arms: Array<{ section: string; connectedWhileOut: boolean; othersMoved: number; blocksKept: number; detached: number[]; reattached: number[] }> = [];
	for (const s of secs) {
		const spacer = detachSection(s.el);
		await frame();
		const out = tops();
		const detached = stableDys(root, strokes);
		const kept = measureSpans(root)?.blocks.length ?? 0;
		spacer.replaceWith(s.el);
		await frame();
		const back = tops();
		const reattached = stableDys(root, strokes);
		arms.push({
			section: s.name, connectedWhileOut: out[secs.indexOf(s)] !== null,
			othersMoved: Math.max(...out.map((t, i) => (t === null ? 0 : Math.abs(t - baseTops[i]!))), ...back.map((t, i) => Math.abs(t! - baseTops[i]!))),
			blocksKept: kept, detached, reattached,
		});
	}
	return { zoom: r2(zoom), strokes: strokes.length, blocks: spans?.blocks.length ?? 0, repeatable: again.every((v, k) => v === base[k]), rows, arms };
};
