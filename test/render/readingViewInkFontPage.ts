/**
 * The page for ReadingViewInkFont.test.ts: Alan's three-paragraph note and its three strokes, drawn in the editor at
 * 12 px text against the note's reference font of 26 px, rendered in Reading view (or an embed) at a given text size.
 *
 * Stored coordinates are world units, one px at the reference font. The editor draws them at its font over the
 * reference (12 / 26 when Alan drew), and its line anchors hold tops in world units. Each case paints one stroke
 * twice: first with the text at the reference size, where world units are px; then at the case's size. The first
 * paint gives the stroke's painted box in the frame of its anchor line and of the column; the second must show the
 * same box scaled by the case's font over the reference, about the same line top and the same column left.
 */
import * as embedInk from "../../src/inline/EmbedInk";
import { attachEmbedInkOnceReady, initEmbedInkRefresh, teardownEmbedInk } from "../../src/inline/EmbedInk";
import type { InkStroke } from "../../src/ink/Stroke";
import { parsePage } from "../../src/model/PageData";
import { installObsidianDom } from "./obsidianDom";

installObsidianDom();

/** The note's sections as the preview renderer gives them, 0-based: the frontmatter, then three one-line paragraphs. */
const SECTIONS = [
	{ type: "yaml", lineStart: 0, lineEnd: 5 },
	{ type: "paragraph", lineStart: 6, lineEnd: 6 },
	{ type: "paragraph", lineStart: 9, lineEnd: 9 },
	{ type: "paragraph", lineStart: 12, lineEnd: 12 },
];

export interface FontCase {
	/** The stroke's index in the sidecar: 0 the circle, 1 and 2 the underline's two strokes. */
	stroke: number;
	/** The rendered text's size, px. */
	font: number;
	/** The note's reference font, px, as the store holds it; null for a note with none. */
	ref: number | null;
	view: "reading" | "embed";
}

/** What the test hands the page: the note's text and its ink file, as read from the fixtures. */
export interface FontNote {
	text: string;
	sidecar: string;
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function reset(): void {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "theme-light";
}

/** The painted box of the canvas layer's pixels, page px, and a hash of its bytes; null when nothing is painted. */
function painted(root: HTMLElement): { top: number; bottom: number; left: number; right: number; hash: string } | null {
	const layer = root.querySelector<HTMLCanvasElement>(":scope > canvas.handwriting-embed-ink");
	if (!layer) return null;
	const lr = layer.getBoundingClientRect();
	const d = layer.getContext("2d")!.getImageData(0, 0, layer.width, layer.height).data;
	let y0 = 1e9, y1 = -1, x0 = 1e9, x1 = -1;
	// FNV-1a over the bytes, with the backing and css sizes and the layer's place: equal only for the same picture in the same spot.
	let h = 0x811c9dc5;
	for (let i = 0; i < d.length; i++) {
		h ^= d[i]!;
		h = Math.imul(h, 0x01000193);
	}
	for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) if (d[(y * layer.width + x) * 4 + 3]! > 0) {
		if (y < y0) y0 = y;
		if (y > y1) y1 = y;
		if (x < x0) x0 = x;
		if (x > x1) x1 = x;
	}
	if (y1 < 0) return null;
	const sx = lr.width / layer.width, sy = lr.height / layer.height;
	return {
		top: lr.top + y0 * sy,
		bottom: lr.top + (y1 + 1) * sy,
		left: lr.left + x0 * sx,
		right: lr.left + (x1 + 1) * sx,
		hash: `${(h >>> 0).toString(16)} ${layer.width}x${layer.height} ${lr.width}x${lr.height}@${lr.left},${lr.top}`,
	};
}

/**
 * The note rendered at `font` px and one stroke painted on it. Reading view: view > sizer > pusher, header, one div per
 * section, each post-processed with its own section info. Embed: the same view and sizer inside an embed's content box.
 * Returns the painted box, the top of the stroke's anchor line as this view lays it out (page px) and the column's left.
 */
async function paintAt(note: FontNote, c: FontCase, font: number) {
	reset();
	const lines = note.text.split("\n").map((l) => l.replace(/\r$/, ""));
	const host = c.view === "embed" ? document.body.createDiv({ cls: "markdown-embed-content" }) : document.body;
	const root = host.createDiv({ cls: "markdown-preview-view markdown-rendered" });
	root.style.fontSize = `${font}px`;
	const sizer = root.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
	sizer.createDiv({ cls: "markdown-preview-pusher" });
	if (c.view === "reading") {
		const header = sizer.createDiv({ cls: "mod-header" });
		header.createDiv({ cls: "inline-title", text: "Three paragraph note" });
		header.createDiv({ cls: "metadata-container" }).createDiv({ cls: "metadata-property", text: "keywords" });
	}
	const sections: Array<{ el: HTMLElement; lineStart: number; lineEnd: number }> = [];
	const fm = sizer.createDiv({ cls: "mod-frontmatter mod-ui" });
	fm.createEl("pre", { cls: "frontmatter", text: lines.slice(1, 5).join("\n") });
	sections.push({ el: fm, lineStart: 0, lineEnd: 5 });
	for (const s of SECTIONS.slice(1)) {
		const el = sizer.createDiv({ cls: "el-p" });
		el.createEl("p", { text: lines[s.lineStart]! });
		sections.push({ el, lineStart: s.lineStart, lineEnd: s.lineEnd });
	}
	await frame();
	const page = parsePage(note.sidecar, "e5cb5010-ec98-4512-9467-1d7a81144182").data;
	const strokes: InkStroke[] = [page.strokes[c.stroke]!];
	initEmbedInkRefresh(() => strokes);
	// The note's reference font, as the plugin wires it from the store. Optional, so this page also loads on a build
	// that has no such wiring: there the ink is drawn as it always was.
	embedInk.initEmbedInkFontRef?.(() => c.ref);
	const container = c.view === "embed" ? root : sizer;
	for (const s of sections) {
		attachEmbedInkOnceReady(s.el, container, "Three paragraph note.md", () => strokes, undefined, false, {
			section: () => ({ text: note.text, lineStart: s.lineStart, lineEnd: s.lineEnd }),
			cached: () => null,
		});
	}
	await frame();
	await frame();
	const layerRoot = c.view === "embed" ? host : root;
	const box = painted(layerRoot);
	// The anchor line's top: line 9 is the blank line above the second paragraph (one rendered line above its block),
	// line 13 the third paragraph's first line (its block's top).
	const a = strokes[0]!.lineAnchor!;
	const block = sections.find((s) => s.lineStart === (a.line === 9 ? 9 : 12))!.el;
	const lh = parseFloat(getComputedStyle(block.firstElementChild!).lineHeight);
	const lineTop = block.getBoundingClientRect().top - (a.line === 9 ? lh : 0);
	const placedTop = placedTopOf(layerRoot, block) - (a.line === 9 ? lh : 0);
	return { box, lineTop, placedTop, columnLeft: sizer.getBoundingClientRect().left, line: a.line };
}

/**
 * A block's top as the view places ink against it, page px: the same offset parent chain the view reads (EmbedInk.ts
 * topInRoot: each offsetTop, whole px, plus the top border of every offset parent between), from the layer root's
 * padding edge. Where the text's own top is fractional this is that top rounded, as the view has it.
 */
function placedTopOf(layerRoot: HTMLElement, el: HTMLElement): number {
	let top = 0;
	for (let node: HTMLElement = el; node !== layerRoot; ) {
		const parent = node.offsetParent as HTMLElement | null;
		if (!parent || (parent !== layerRoot && parent.contains(layerRoot))) throw new Error("the block has no top in the layer root");
		top += node.offsetTop;
		if (parent === layerRoot) break;
		top += parent.clientTop || 0;
		node = parent;
	}
	return layerRoot.getBoundingClientRect().top + layerRoot.clientTop + top;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * One case: the stroke painted with the text at the reference size (26 px), then at the case's size. Where its box is
 * painted at the case's size, and where it belongs: the first paint's box, its offsets from the line top that paint
 * placed it against and from the column's left, scaled by font over reference (1 for a note with no reference), about
 * the case's true line top. The first paint's offset is taken from its placed top, not the true one: the view places
 * ink on whole px block tops, and that rounding, scaled, would otherwise count against the case.
 */
(window as unknown as Record<string, unknown>).fontCase = async (note: FontNote, c: FontCase) => {
	const base = await paintAt(note, { ...c, ref: 26 }, 26);
	const at = await paintAt(note, c, c.font);
	if (!base.box || !at.box) return { error: "nothing painted" };
	const k = c.ref === null ? 1 : c.font / c.ref;
	const want = {
		top: at.lineTop + (base.box.top - base.placedTop) * k,
		bottom: at.lineTop + (base.box.bottom - base.placedTop) * k,
		left: at.columnLeft + (base.box.left - base.columnLeft) * k,
		right: at.columnLeft + (base.box.right - base.columnLeft) * k,
	};
	const got = at.box;
	return {
		line: at.line,
		k: r2(k),
		dpr: window.devicePixelRatio,
		got: { top: r2(got.top), bottom: r2(got.bottom), left: r2(got.left), right: r2(got.right) },
		want: { top: r2(want.top), bottom: r2(want.bottom), left: r2(want.left), right: r2(want.right) },
		centreY: r2((got.top + got.bottom) / 2 - (want.top + want.bottom) / 2),
		centreX: r2((got.left + got.right) / 2 - (want.left + want.right) / 2),
		height: r2(got.bottom - got.top - (want.bottom - want.top)),
		width: r2(got.right - got.left - (want.right - want.left)),
		hash: got.hash,
	};
};
