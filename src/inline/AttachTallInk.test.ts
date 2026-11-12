/**
 * Attach with a selection taller than its line. The pick reads the box's centre first (the paragraph under the middle, and
 * a quarter line under a text line for an underline). Where that finds no text line, the box takes the text line its
 * top-to-bottom span overlaps that is nearest its centre; a tie takes the upper one. A blank line and a widget block are
 * not text lines. A box that overlaps no text line attaches nothing, as before.
 *
 * Bare overlay, fake layout, no DOM. The layout's heights are the editor's (box y times scaleY times fontZoom), and a
 * height past either end of the note lands on the nearest block, as CodeMirror's height map answers it. The target is
 * read by running the measure attachSelected asks for; with no container it is the paragraph of the block taken.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { BlockType } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors } from "./LineAnchor";
import { SelectionModel } from "../objects/SelectionModel";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";

type Block = { from: number; to: number; top: number; bottom: number; type: BlockType };
type Box = { x: number; y: number; width: number; height: number };

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** Each line its own text block, `lh` high, in order. */
function textBlocks(doc: Text, lh: number, first = 1, top = 0): Block[] {
	const out: Block[] = [];
	for (let n = first; n <= doc.lines; n++) {
		const l = doc.line(n);
		out.push({ from: l.from, to: l.to, top: top + (n - first) * lh, bottom: top + (n - first + 1) * lh, type: BlockType.Text });
	}
	return out;
}

/**
 * A note laid out as `blocks`; the selection box is in note px. Returns what attachSelected answered and, when it asked
 * for a measure, the target that measure reads.
 */
function attach(path: string, doc: Text, blocks: Block[], box: Box, o: { scaleY?: number; fontZoom?: number; lineHeight: number }) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [] };
	rec.strokes = [strokeAt("s1", 10, 36)];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	// As CodeMirror's height map answers (measured on the render rig): a block with no height at the note's top is the
	// answer for a height above the note and for height 0 itself; a height past the end lands on the last block.
	const lineBlockAtHeight = (h: number) =>
		blocks.find((b) => h >= b.top && (h < b.bottom || b.top === b.bottom)) ?? (h < blocks[0]!.top ? blocks[0]! : blocks[blocks.length - 1]!);
	const lineBlockAt = (pos: number) => blocks.find((b) => pos >= b.from && pos <= b.to) ?? blocks[blocks.length - 1]!;
	const measures: { read: () => unknown }[] = [];
	const view = { scaleY: o.scaleY ?? 1, defaultLineHeight: o.lineHeight, state: { doc }, lineBlockAtHeight, lineBlockAt, requestMeasure: (m: { read: () => unknown }) => measures.push(m) };
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	const anchors = new LineAnchors(() => null, () => false);
	anchors.sig = { width: 600, fontPx: 16, charWidth: 8 };
	const selection = new SelectionModel();
	selection.selectExactly(["s1"]);
	Object.assign(overlay, {
		view, fontZoom: o.fontZoom ?? 1, lineAnchorState: anchors, selection, filePath: () => path, selectionBounds: () => box,
		followRefAt: () => ({ x: 0, y: 0 }),
	});
	anchors.tracks(path, inlineInk.strokes(path));
	const answered = overlay.attachSelected();
	const m = measures[0]?.read() as { target: { kind: string; from: number; to: number; text: string } } | null | undefined;
	return { answered, target: m ? { kind: m.target.kind, from: m.target.from, to: m.target.to, text: m.target.text } : null };
}

/** The drift-test note as Orion lays it out at zoom 2.32, editor 10 px against a 12 px reference (render cell, measured). */
const ORION_NOTE = Text.of(["---", "handwriting-page-id: a0af7bc7-bddb-4c6c-86b2-1737d50ad6dd", "---", "", "This is the test"]);
const ORION_LH = 34.8;
const ORION = { scaleY: 2.32, fontZoom: 10 / 12, lineHeight: ORION_LH };
/** The front matter is hidden: one replaced block with no height, lines 1 to 3; line 4 (blank) and line 5 follow. */
const ORION_BLOCKS: Block[] = [
	{ from: 0, to: ORION_NOTE.line(3).to, top: 0, bottom: 0, type: BlockType.WidgetRange },
	...textBlocks(ORION_NOTE, ORION_LH, 4),
];

describe("attach with a selection taller than its line", () => {
	it("tall ink through the words of the note's last line, its centre under that line: attaches to that line", () => {
		// The box measured on the rig: y -26.57, height 177.33, so its centre's height is 120.06, 50.46 under line 5.
		const r = attach("tall-orion.md", ORION_NOTE, ORION_BLOCKS, { x: 85.8, y: -26.57, width: 34, height: 177.33 }, ORION);
		expect(r.answered, "tall ink on a text line attaches").toBe(true);
		expect(r.target, "to the note's line").toEqual({ kind: "paragraph", from: 67, to: 83, text: "This is the test" });
	});

	it("tall ink over two text lines takes the one nearest its centre, not the first it overlaps", () => {
		const doc = Text.of(["Title words", "", "This is the test"]);
		// Lines at 0..30, 30..60, 60..90. The box runs 6..261: it overlaps "Title words" by 24 and line 3 whole; its centre
		// 133.5 is 43.5 under line 3 and 103.5 under line 1.
		const r = attach("tall-two-lines.md", doc, textBlocks(doc, 30), { x: 10, y: 6, width: 30, height: 255 }, { lineHeight: 30 });
		expect(r.answered, "tall ink attaches").toBe(true);
		expect(r.target?.text, "to the line nearest the box's centre").toBe("This is the test");
	});

	it("a centre on a blank line between two overlapped text lines takes the nearer one", () => {
		const doc = Text.of(["Alpha", "", "Beta"]);
		// The box runs 20..80: its centre 50 sits on the blank line, 20 under Alpha (past the quarter line, 7.5) and 10 over Beta.
		const r = attach("blank-between-nearer.md", doc, textBlocks(doc, 30), { x: 10, y: 20, width: 30, height: 60 }, { lineHeight: 30 });
		expect(r.answered, "the box attaches").toBe(true);
		expect(r.target?.text, "to the nearer line, Beta").toBe("Beta");
	});

	it("a centre on a blank line as far from both overlapped text lines takes the upper one", () => {
		const doc = Text.of(["Alpha", "", "Beta"]);
		// The box runs 15..75: its centre 45 is 15 under Alpha and 15 over Beta.
		const r = attach("blank-between-tie.md", doc, textBlocks(doc, 30), { x: 10, y: 15, width: 30, height: 60 }, { lineHeight: 30 });
		expect(r.answered, "the box attaches").toBe(true);
		expect(r.target?.text, "a tie takes the upper line, Alpha").toBe("Alpha");
	});

	it("a centre above the note's first line, the box overlapping it: attaches to the first line", () => {
		const doc = Text.of(["First line", "Second line"]);
		// The box runs -60..20: its centre -20 is above the note; it overlaps line 1 by 20.
		const r = attach("above-first.md", doc, textBlocks(doc, 30), { x: 10, y: -60, width: 30, height: 80 }, { lineHeight: 30 });
		expect(r.answered, "the box attaches").toBe(true);
		expect(r.target?.text, "to line 1").toBe("First line");
	});

	it("a box that overlaps only a widget block attaches nothing", () => {
		const doc = Text.of(["Alpha", "![[embed]]"]);
		// Alpha at 0..30, then a block embed's widget at 30..90. The box runs 40..140: its centre 90 is past the note.
		const blocks: Block[] = [
			{ from: 0, to: 5, top: 0, bottom: 30, type: BlockType.Text },
			{ from: 6, to: 16, top: 30, bottom: 90, type: BlockType.WidgetRange },
		];
		const r = attach("widget-only.md", doc, blocks, { x: 10, y: 40, width: 30, height: 100 }, { lineHeight: 30 });
		expect(r.answered, "a widget is not a text line: nothing attaches").toBe(false);
	});

	it("Orion's two saved strokes, 235 px under the note's last line, attach nothing", () => {
		// The two strokes as saved: y 136.05, height 43.18. Their centre's height is 304.77, 235.2 under line 5; the box's top
		// is 193.4 under it.
		const r = attach("saved-strokes-below.md", ORION_NOTE, ORION_BLOCKS, { x: 80.84, y: 136.05, width: 62.27, height: 43.18 }, ORION);
		expect(r.answered, "ink under all the text attaches nothing").toBe(false);
	});

	it("control: a box whose centre is on a text line still takes that line", () => {
		const doc = Text.of(["Alpha", "Beta", "Gamma"]);
		// The box runs 25..70: it overlaps all three lines; its centre 47.5 is on Beta.
		const r = attach("centre-on-line.md", doc, textBlocks(doc, 30), { x: 10, y: 25, width: 30, height: 45 }, { lineHeight: 30 });
		expect(r.target?.text, "the centre's line").toBe("Beta");
	});

	it("control: a box a quarter line under a text line's bottom still takes that line (an underline)", () => {
		const doc = Text.of(["Alpha", "", "Beta"]);
		// The box runs 31..41: its centre 36 is 6 under Alpha, inside the quarter line (7.5).
		const r = attach("underline.md", doc, textBlocks(doc, 30), { x: 10, y: 31, width: 30, height: 10 }, { lineHeight: 30 });
		expect(r.target?.text, "the line above").toBe("Alpha");
	});
});

describe("attach across a gap: the nearest text line up to two lines from the box", () => {
	const para = (doc: Text, n: number) => ({ kind: "paragraph", from: doc.line(n).from, to: doc.line(n).to, text: doc.line(n).text });

	it("a: Alan's case, a box starting a few px under the note's last line and running ten lines down, attaches to it", () => {
		// Line 5 ends at height 69.6, note px 36.0. The box runs 39..219 note px, heights 75.4..423.4: a gap of 5.8 under
		// the line, no overlap; its centre is 179.8 under the line.
		const r = attach("gap-orion.md", ORION_NOTE, ORION_BLOCKS, { x: 85.8, y: 39, width: 34, height: 180 }, ORION);
		expect(r.answered, "a box a few px under the text attaches").toBe(true);
		expect(r.target, "to the note's line, as a paragraph").toEqual({ kind: "paragraph", from: 67, to: 83, text: "This is the test" });
	});

	it("b: one blank line between the box and the text above, a gap under two lines: attaches to that line", () => {
		const doc = Text.of(["Alpha", "", "", "", "", "Omega"]);
		// Alpha 0..30, blank lines 30..150, Omega 150..180. The box runs 65..85: 35 under Alpha, 65 over Omega (past the reach, 60).
		const r = attach("gap-blank-above.md", doc, textBlocks(doc, 30), { x: 10, y: 65, width: 30, height: 20 }, { lineHeight: 30 });
		expect(r.answered, "the box attaches across the blank line").toBe(true);
		expect(r.target, "to Alpha, as a paragraph").toEqual(para(doc, 1));
	});

	it("c: a box in a blank gap between two paragraphs, nearer the lower: takes the lower", () => {
		const doc = Text.of(["Alpha", "", "", "", "Beta"]);
		// Alpha 0..30, blank lines 30..120, Beta 120..150. The box runs 75..100: 45 under Alpha, 20 over Beta.
		const r = attach("gap-between-nearer.md", doc, textBlocks(doc, 30), { x: 10, y: 75, width: 30, height: 25 }, { lineHeight: 30 });
		expect(r.answered, "the box attaches").toBe(true);
		expect(r.target, "to the nearer line, Beta, as a paragraph").toEqual(para(doc, 5));
	});

	it("c: a box in a blank gap as far from both paragraphs: takes the upper", () => {
		const doc = Text.of(["Alpha", "", "", "", "Beta"]);
		// The box runs 60..90: 30 under Alpha, 30 over Beta.
		const r = attach("gap-between-tie.md", doc, textBlocks(doc, 30), { x: 10, y: 60, width: 30, height: 30 }, { lineHeight: 30 });
		expect(r.answered, "the box attaches").toBe(true);
		expect(r.target, "a tie takes the upper line, Alpha, as a paragraph").toEqual(para(doc, 1));
	});

	it("d: a gap of two lines exactly attaches", () => {
		const doc = Text.of(["Alpha", "", "", "", ""]);
		// Alpha 0..30. The box runs 90..110: 60 under Alpha, the reach.
		const r = attach("gap-two-lines.md", doc, textBlocks(doc, 30), { x: 10, y: 90, width: 30, height: 20 }, { lineHeight: 30 });
		expect(r.answered, "two lines away attaches").toBe(true);
		expect(r.target, "to Alpha").toEqual(para(doc, 1));
	});

	it("d: a gap of two lines and 2 px attaches nothing", () => {
		const doc = Text.of(["Alpha", "", "", "", ""]);
		// The box runs 92..112: 62 under Alpha, 2 past the reach.
		const r = attach("gap-past-reach.md", doc, textBlocks(doc, 30), { x: 10, y: 92, width: 30, height: 20 }, { lineHeight: 30 });
		expect(r.answered, "past two lines: nothing attaches").toBe(false);
	});

	it("e: a widget block between the box and the only text line in reach attaches nothing", () => {
		const doc = Text.of(["Alpha", "![[pic]]", ""]);
		// Alpha 0..30, a block embed's widget 30..60, a blank line 60..90. The box runs 65..85: 35 under Alpha, the picture between.
		const blocks: Block[] = [
			{ from: 0, to: 5, top: 0, bottom: 30, type: BlockType.Text },
			{ from: 6, to: 14, top: 30, bottom: 60, type: BlockType.WidgetRange },
			{ from: 15, to: 15, top: 60, bottom: 90, type: BlockType.Text },
		];
		const r = attach("gap-widget-between.md", doc, blocks, { x: 10, y: 65, width: 30, height: 20 }, { lineHeight: 30 });
		expect(r.answered, "a picture in the way: nothing attaches").toBe(false);
	});

	it("e-down: a widget block between the box and the only text line in reach below attaches nothing", () => {
		const doc = Text.of(["", "![[note]]", "Omega"]);
		// A blank line 0..30, a note embed's widget 30..60, Omega 60..90. The box runs 5..25: 35 over Omega, the embed between.
		const blocks: Block[] = [
			{ from: 0, to: 0, top: 0, bottom: 30, type: BlockType.Text },
			{ from: 1, to: 10, top: 30, bottom: 60, type: BlockType.WidgetRange },
			{ from: 11, to: 16, top: 60, bottom: 90, type: BlockType.Text },
		];
		const r = attach("gap-widget-below.md", doc, blocks, { x: 10, y: 5, width: 30, height: 20 }, { lineHeight: 30 });
		expect(r.answered, "a note embed in the way below: nothing attaches").toBe(false);
	});

	it("f: a box above the note's first line, a gap under two lines: attaches to the first line", () => {
		const doc = Text.of(["First line", "Second line"]);
		// The box runs -50..-20: 20 over line 1, no overlap.
		const r = attach("gap-above-first.md", doc, textBlocks(doc, 30), { x: 10, y: -50, width: 30, height: 30 }, { lineHeight: 30 });
		expect(r.answered, "the box attaches downward").toBe(true);
		expect(r.target, "to line 1, as a paragraph").toEqual(para(doc, 1));
	});

	it("h: hidden front matter (a widget with no height) between the box and the first text line does not stop the reach", () => {
		// The Orion note: front matter hidden at height 0, the blank line 4 at 0..34.8, line 5 at 34.8..69.6. The box runs
		// -20..-5 note px, heights -38.67..-9.67: above the note, 44.47 over line 5, the front matter and line 4 between.
		const r = attach("gap-front-matter.md", ORION_NOTE, ORION_BLOCKS, { x: 85.8, y: -20, width: 34, height: 15 }, ORION);
		expect(r.answered, "the box attaches across hidden front matter").toBe(true);
		expect(r.target, "to the note's line, as a paragraph").toEqual({ kind: "paragraph", from: 67, to: 83, text: "This is the test" });
	});
});
