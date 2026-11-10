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
