/**
 * Ink remembers its line: the anchor arithmetic, the guards, the rebase window and the shown list (LineAnchor.ts), the anchor
 * through the writers that keep it (move, scale, erase pieces), and the field through the file (PageData.ts).
 *
 * The layout is a stand-in for CodeMirror's: a list of line heights in editor px, read the way the overlay reads CodeMirror's
 * height map. The document and its changes are CodeMirror's own Text and ChangeSet.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, MAX_LINE_CORRECTION, SHIFT_LOG_CAP, aboveOf, anchorHolds, changedSpanAbove, editorLineLayout, lineKey, mergeRanges, newAboveRun, takeAnchor, type LineLayout } from "./LineAnchor";
import { computeBBox, pieceAnchor, type InkStroke, type LineAnchor } from "../ink/Stroke";
import { bumpInkRevision } from "../ink/StrokeRev";
import { scaleStroke, translateStroke } from "../objects/Selection";
import { splitStrokeByCircle } from "../ink/Eraser";
import { emptyPage, parsePage, serializePage, serializePageSliced } from "../model/PageData";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const PATH = "note.md";

/** A layout over `doc` whose line n is `heights[n - 1]` editor px tall, at `px` editor px per world unit. */
function layoutOf(doc: Text, heights: number[], px = 1): LineLayout {
	const tops = [0];
	for (const h of heights) tops.push(tops.at(-1)! + h);
	return {
		lines: doc.lines,
		lineText: (n) => doc.line(n).text,
		lineTop: (n) => tops[n - 1]!,
		pxPerWorld: px,
	};
}

/** The same layout, counting its reads: each line top and each line text asked for. */
function counted(layout: LineLayout) {
	const reads = { tops: 0, texts: 0 };
	const out: LineLayout = {
		lines: layout.lines,
		lineText: (n) => (reads.texts++, layout.lineText(n)),
		lineTop: (n) => (reads.tops++, layout.lineTop(n)),
		pxPerWorld: layout.pxPerWorld,
	};
	return { layout: out, reads };
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** A note surface over a mutable layout: the anchors, the store's list, and the layout it reads. */
function surface(doc: Text, heights: number[], px = 1) {
	const state = { layout: layoutOf(doc, heights, px) };
	const anchors = new LineAnchors(() => state.layout);
	anchors.setSignature(SIG);
	return { state, anchors };
}

const lines = (n: number) => Text.of(Array.from({ length: n }, (_, i) => `line ${i + 1} words`));
/** Line `n`'s lines-above hash in `doc`, hashed from nothing. */
const aboveIn = (doc: Text, n: number): number => aboveOf(newAboveRun(), n, (k) => lineKey(doc.line(k).text));

/**
 * Lines drawn and then measured, as the editor does it: an update with a transaction draws them (the heights on record are its
 * estimates), and the measure loop's update after it, the same lines shown, marks them. True when the measured prefix grew.
 */
const measuredDraw = (anchors: LineAnchors) => (from: number, to: number): boolean => {
	anchors.drawn(from, to);
	return anchors.drawn(from, to, true, true);
};

/**
 * The update a document change makes draws the changed lines, their heights the editor's estimates, as the overlay records
 * them; the measure loop's update after it has read them.
 */
const drewEdit = (anchors: LineAnchors): void => {
	anchors.drawn(anchors.changedLines.from, anchors.changedLines.to, false);
};

/**
 * The measure loop's update after a change: its measure read the lines the update before it drew, which the overlay marks
 * before the layout update is judged. Only the changed lines are read again here, so a surface that never reads every line
 * drawn stays on the eager path.
 */
const readEdit = (anchors: LineAnchors): void => {
	anchors.drawn(anchors.changedLines.from, anchors.changedLines.to, false, true);
};

describe("line anchors", () => {
	it("anchor the line under the stroke's bbox top, at that line's top, in world units", () => {
		const doc = lines(6);
		const a = takeAnchor(strokeAt("s", 10, 121), layoutOf(doc, [40, 40, 40, 40, 40, 40], 2), SIG)!;
		// The bbox top (123 world, 246 editor px) is past the six 40 px lines: the last line holds it.
		expect(a.line).toBe(6);
		const b = takeAnchor(strokeAt("t", 10, 61), layoutOf(doc, [40, 40, 40, 40, 40, 40], 1), SIG)!;
		expect(b).toEqual({ line: 2, top: 40, y: 63, key: lineKey("line 2 words"), width: 892, fontPx: 26, above: aboveIn(doc, 2) });
	});

	it("show a stroke moved with its line when the lines above are measured again, and nothing else moves it", () => {
		const doc = lines(6), { state, anchors } = surface(doc, [40, 40, 40, 40, 40, 40]);
		const s = strokeAt("s", 10, 125);
		anchors.anchorNew(PATH, s);
		const src = [s];
		expect(anchors.strokesFor(PATH, src), "nothing moved: the store's own list").toBe(src);
		state.layout = layoutOf(doc, [34, 30, 40, 40, 40, 40]);
		expect(anchors.layoutChanged(PATH, src)).toBe(true);
		expect(anchors.dyOf(s)).toBe(-16);
		const shown = anchors.strokesFor(PATH, src);
		expect(shown).not.toBe(src);
		expect(shown[0]!.bbox.y).toBe(s.bbox.y - 16);
		expect(shown[0]!.points.map((p) => p.y)).toEqual(s.points.map((p) => p.y - 16));
		expect(s.bbox.y, "the store's stroke keeps its page position").toBe(127);
		// The same layout again: no change, no repaint.
		expect(anchors.layoutChanged(PATH, src)).toBe(false);
	});

	it("show a stroke at its page position when its line's text, its own place, the signature or a correction past the bound says the anchor no longer holds", () => {
		const doc = lines(6), heights = [40, 40, 40, 40, 40, 40];
		const s = strokeAt("s", 10, 125), layout = layoutOf(doc, heights);
		const a = takeAnchor(s, layout, SIG)!;
		expect(anchorHolds(a, s, layout, SIG)).toBe(true);
		expect(anchorHolds({ ...a, key: a.key ^ 1 }, s, layout, SIG), "another line's text").toBe(false);
		expect(anchorHolds({ ...a, y: a.y + 1 }, s, layout, SIG), "moved by a build without the field").toBe(false);
		expect(anchorHolds({ ...a, width: 600 }, s, layout, SIG), "another width").toBe(false);
		expect(anchorHolds({ ...a, fontPx: 20 }, s, layout, SIG), "another font size").toBe(false);
		expect(anchorHolds({ ...a, line: 7 }, s, layout, SIG), "past the last line").toBe(false);
		expect(anchorHolds(a, s, layout, null), "no signature read yet").toBe(false);
		const { state, anchors } = surface(doc, heights);
		s.lineAnchor = { ...a, top: a.top + MAX_LINE_CORRECTION + 1 };
		anchors.layoutChanged(PATH, [s]);
		expect(anchors.dyOf(s), "a correction past the bound is not honoured").toBe(0);
		const t = strokeAt("t", 10, 125);
		t.lineAnchor = { ...a, top: a.top + MAX_LINE_CORRECTION };
		anchors.layoutChanged(PATH, [t]);
		expect(anchors.dyOf(t), "a correction at the bound is honoured").toBe(-MAX_LINE_CORRECTION);
	});

	it("honour an anchor taken at a width within one character width of the signature's, and none taken further off", () => {
		const doc = lines(6), heights = [40, 40, 40, 40, 40, 40];
		const s = strokeAt("s", 10, 125), layout = layoutOf(doc, heights);
		const a = takeAnchor(s, layout, SIG)!;
		const half = { ...SIG, width: SIG.width + SIG.charWidth / 2 }, two = { ...SIG, width: SIG.width + 2 * SIG.charWidth };
		expect(anchorHolds(a, s, layout, half), "half a character wider: the same wrap").toBe(true);
		expect(anchorHolds(a, s, layout, two), "two characters wider: another wrap").toBe(false);
		expect(anchorHolds(a, s, layout, { ...half, fontPx: 26.5 }), "the font size compares exact").toBe(false);
		// A surface whose first measure reads half a character wider (a reload, a scrollbar) shows the anchor's correction.
		s.lineAnchor = a;
		const state = { layout: layoutOf(doc, [20, 40, 40, 40, 40, 40]) };
		const wider = new LineAnchors(() => state.layout), further = new LineAnchors(() => state.layout);
		wider.setSignature(half);
		further.setSignature(two);
		wider.layoutChanged(PATH, [s]);
		further.layoutChanged(PATH, [s]);
		expect(wider.dyOf(s), "half a character wider: the stroke moves with its line").toBe(-20);
		expect(further.dyOf(s), "two characters wider: shown at its page position").toBe(0);
	});

	it("take a typed paragraph's own height into the anchor, and move the ink with every other height change in that measure", () => {
		const before = lines(6), { state, anchors } = surface(before, [40, 40, 40, 40, 40, 40]);
		const s = strokeAt("s", 10, 125);
		anchors.anchorNew(PATH, s);
		expect(s.lineAnchor!.line).toBe(4);
		// A paragraph and a blank line typed at the start of line 2, laid out under the old guess (40 px a line).
		const changes = ChangeSet.of({ from: before.line(2).from, insert: "a long typed paragraph\n\n" }, before.length);
		const after = changes.apply(before);
		state.layout = layoutOf(after, [40, 40, 40, 40, 40, 40, 40, 40]);
		anchors.docChanged(PATH, [s], before, changes, after);
		drewEdit(anchors);
		expect(anchors.dyOf(s), "typing moves no ink").toBe(0);
		expect(anchors.windowOpen).toBe(true);
		// The measure: the paragraph wraps to 70 px, the blank line is 30, and line 1 is re-measured from 40 to 34.
		state.layout = layoutOf(after, [34, 70, 30, 40, 40, 40, 40, 40]);
		readEdit(anchors);
		expect(anchors.layoutChanged(PATH, [s], "measure")).toBe(true);
		expect(anchors.windowOpen).toBe(false);
		expect(anchors.dyOf(s), "only the re-measure above the typing moves the ink").toBe(-6);
		// The words the ink was written on (old line 4, now line 6) sit the typed block's measured height lower than before.
		const wordsTop = state.layout.lineTop(6), inkTop = s.bbox.y + anchors.dyOf(s);
		expect(wordsTop - inkTop - (120 - s.bbox.y)).toBe(70 + 30);
	});

	it("leave ink above a change alone, and move no ink when a plain line above it is edited and keeps its height", () => {
		const before = lines(6), { state, anchors } = surface(before, [40, 40, 40, 40, 40, 40]);
		const above = strokeAt("above", 10, 45), below = strokeAt("below", 10, 165);
		anchors.anchorNew(PATH, above);
		anchors.anchorNew(PATH, below);
		const anchorAbove = { ...above.lineAnchor! };
		const changes = ChangeSet.of({ from: before.line(3).from + 4, insert: "xyz" }, before.length);
		const after = changes.apply(before);
		state.layout = layoutOf(after, [40, 40, 40, 40, 40, 40]);
		anchors.docChanged(PATH, [above, below], before, changes, after);
		drewEdit(anchors);
		expect(above.lineAnchor, "above the change: untouched").toEqual(anchorAbove);
		expect(below.lineAnchor!.line).toBe(5);
		readEdit(anchors);
		expect(anchors.layoutChanged(PATH, [above, below], "measure")).toBe(false);
		expect([anchors.dyOf(above), anchors.dyOf(below)]).toEqual([0, 0]);
	});

	it("re-take anchors at a document change from the height map alone, as CodeMirror allows inside its update", () => {
		// A view as CodeMirror's is inside an update: lineBlockAt answers from the height map, and a layout read throws. The
		// throw, uncaught there, is logged as a crashed plugin and the whole overlay is deactivated.
		let doc = lines(6);
		const view = {
			get state() {
				return { doc };
			},
			lineBlockAt: (pos: number) => {
				const n = doc.lineAt(pos).number;
				return { top: (n - 1) * 40, bottom: n * 40 };
			},
			lineBlockAtHeight: (): never => {
				throw new Error("Reading the editor layout isn't allowed during an update");
			},
		};
		const anchors = new LineAnchors(() => editorLineLayout(view, 1));
		anchors.setSignature(SIG);
		const s = strokeAt("s", 10, 125);
		anchors.anchorNew(PATH, s);
		expect(s.lineAnchor!.line).toBe(4);
		const before = doc, changes = ChangeSet.of({ from: before.line(2).from, insert: "typed\n" }, before.length);
		doc = changes.apply(before);
		expect(() => anchors.docChanged(PATH, [s], before, changes, doc)).not.toThrow();
		expect(anchors.dyOf(s), "typing moves no ink").toBe(0);
		expect(s.lineAnchor!.line, "re-taken from the stroke's page spot: the line there now").toBe(4);
		expect(s.lineAnchor!.key).toBe(lineKey("line 3 words"));
	});

	it("absorb an edited line's growth but not a later re-measure of the lines above", () => {
		const before = lines(6), { state, anchors } = surface(before, [40, 40, 40, 40, 40, 40]);
		const s = strokeAt("s", 10, 205);
		anchors.anchorNew(PATH, s);
		const changes = ChangeSet.of({ from: before.line(2).to, insert: " and more words that wrap" }, before.length);
		const after = changes.apply(before);
		state.layout = layoutOf(after, [40, 40, 40, 40, 40, 40]);
		anchors.docChanged(PATH, [s], before, changes, after);
		drewEdit(anchors);
		state.layout = layoutOf(after, [40, 80, 40, 40, 40, 40]);
		readEdit(anchors);
		anchors.layoutChanged(PATH, [s], "measure");
		expect(anchors.dyOf(s), "the wrapped line pushes the text, not the ink").toBe(0);
		state.layout = layoutOf(after, [20, 80, 40, 40, 40, 40]);
		anchors.layoutChanged(PATH, [s]);
		expect(anchors.dyOf(s), "after the window, the ink follows its line").toBe(-20);
	});

	it("measure the changed span above a line, with a range that holds the line ending one line before it", () => {
		const doc = lines(8), layout = layoutOf(doc, [10, 20, 30, 40, 50, 60, 70, 80]);
		expect(changedSpanAbove([{ from: 2, to: 3 }], 6, layout)).toBe(50);
		expect(changedSpanAbove([{ from: 2, to: 6 }], 5, layout)).toBe(20 + 30 + 40);
		expect(changedSpanAbove([{ from: 6, to: 7 }], 5, layout)).toBe(0);
		expect(changedSpanAbove([{ from: 1, to: 1 }, { from: 3, to: 3 }], 5, layout)).toBe(10 + 30);
		expect(mergeRanges([{ from: 5, to: 6 }, { from: 1, to: 2 }, { from: 3, to: 3 }])).toEqual([{ from: 1, to: 3 }, { from: 5, to: 6 }]);
	});

	it("keep the shown list the same object through a store change, and make a new one when a correction changes", () => {
		const doc = lines(6), { state, anchors } = surface(doc, [40, 40, 40, 40, 40, 40]);
		const s = strokeAt("s", 10, 125), t = strokeAt("t", 10, 30);
		anchors.anchorNew(PATH, s);
		const src = [s, t];
		state.layout = layoutOf(doc, [30, 40, 40, 40, 40, 40]);
		anchors.layoutChanged(PATH, src);
		const first = anchors.strokesFor(PATH, src);
		expect(first[1], "an unanchored stroke is the store's own").toBe(t);
		const u = strokeAt("u", 10, 200);
		src.push(u);
		bumpInkRevision();
		const second = anchors.strokesFor(PATH, src);
		expect(second).toBe(first);
		expect(second.map((x) => x.id)).toEqual(["s", "t", "u"]);
		expect(second[0], "the copy is made once per move").toBe(first[0]);
		state.layout = layoutOf(doc, [20, 40, 40, 40, 40, 40]);
		anchors.layoutChanged(PATH, src);
		expect(anchors.strokesFor(PATH, src)).not.toBe(first);
	});

	it("read each line's top once per update and each line's text once per document change, however many strokes sit on it", () => {
		const before = lines(60), heights = Array.from({ length: 60 }, () => 40);
		const state = { at: counted(layoutOf(before, heights)) };
		const anchors = new LineAnchors(() => state.at.layout);
		anchors.setSignature(SIG);
		// 500 strokes, ten on each of lines 11 to 60.
		const src: InkStroke[] = [];
		for (let i = 0; i < 500; i++) {
			const s = strokeAt(`s${i}`, 10 + (i % 10) * 20, 400 + Math.floor(i / 10) * 40 + 10);
			anchors.anchorNew(PATH, s);
			src.push(s);
		}
		expect(new Set(src.map((s) => s.lineAnchor!.line)).size).toBe(50);
		// The five lines at the top are measured shorter: every stroke moves up with its line.
		state.at = counted(layoutOf(before, heights.map((h, i) => (i < 5 ? 30 : h))));
		expect(anchors.layoutChanged(PATH, src)).toBe(true);
		expect(state.at.reads.texts, "a layout update reads no line's text").toBe(0);
		expect(state.at.reads.tops, "one top per anchored line").toBe(50);
		expect(src.every((s) => anchors.dyOf(s) === -50)).toBe(true);
		// A line typed at the start of line 2, laid out under the old guess.
		const changes = ChangeSet.of({ from: before.line(2).from, insert: "typed words\n" }, before.length);
		const after = changes.apply(before);
		state.at = counted(layoutOf(after, [30, 40, 30, 30, 30, 30, ...heights.slice(5)]));
		anchors.docChanged(PATH, src, before, changes, after);
		expect(state.at.reads.texts, "the keys below the change move with their lines: only line 11, whose key was never held, is hashed").toBe(1);
		expect(state.at.reads.tops, "each top read once, the halvings' included").toBeLessThanOrEqual(after.lines + 1);
		expect(src.every((s) => anchors.dyOf(s) === -50), "typing moves no ink").toBe(true);
	});

	it("re-take no anchor below a character typed inside a line, and take that line's growth into them at the measure", () => {
		const before = lines(60), heights = Array.from({ length: 60 }, () => 40);
		const state = { at: counted(layoutOf(before, heights)) };
		const anchors = new LineAnchors(() => state.at.layout);
		anchors.setSignature(SIG);
		// 500 strokes, ten on each of lines 11 to 60, and one on line 2 where the typing lands.
		const src: InkStroke[] = [];
		for (let i = 0; i < 500; i++) {
			const s = strokeAt(`s${i}`, 10 + (i % 10) * 20, 400 + Math.floor(i / 10) * 40 + 10);
			anchors.anchorNew(PATH, s);
			src.push(s);
		}
		const onLine = strokeAt("on-line", 300, 50);
		anchors.anchorNew(PATH, onLine);
		src.push(onLine);
		const held = src.map((s) => ({ ...s.lineAnchor! }));
		// A character typed inside line 2, laid out under the old guess in the same update.
		const changes = ChangeSet.of({ from: before.line(2).from + 3, insert: "x" }, before.length);
		const after = changes.apply(before);
		state.at = counted(layoutOf(after, heights));
		anchors.docChanged(PATH, src, before, changes, after);
		const unhashed = ({ above: _, ...rest }: LineAnchor) => rest;
		expect(src.slice(0, 500).map((s) => unhashed(s.lineAnchor!)), "below the typing: every anchor stands as it was").toEqual(held.slice(0, 500).map(unhashed));
		expect(onLine.lineAnchor, "the stroke on the typed line is re-taken against its new text").not.toEqual(held[500]);
		expect(onLine.lineAnchor!.key).toBe(lineKey(after.line(2).text));
		expect(state.at.reads.texts, "the typed line's text, hashed once").toBe(1);
		expect(state.at.reads.tops, "the first and last anchored lines below, the typed line and the one after it, and its halving").toBeLessThanOrEqual(12);
		expect(anchors.windowOpen).toBe(true);
		drewEdit(anchors);
		// The measure: the typed line wraps to 80 px. The text below moves down 40; the ink stays where it is.
		state.at = counted(layoutOf(after, heights.map((h, i) => (i === 1 ? 80 : h))));
		readEdit(anchors);
		anchors.layoutChanged(PATH, src, "measure");
		expect(src.every((s) => anchors.dyOf(s) === 0), "typing moves no ink").toBe(true);
		// After the window, the ink follows its line: line 1 measured 10 shorter moves all of it up.
		state.at = counted(layoutOf(after, heights.map((h, i) => (i === 0 ? 30 : i === 1 ? 80 : h))));
		expect(anchors.layoutChanged(PATH, src)).toBe(true);
		expect(src.every((s) => anchors.dyOf(s) === -10)).toBe(true);
	});

	it("re-take every anchor below a change made in the same update as a height change below it", () => {
		const before = lines(20), heights = Array.from({ length: 20 }, () => 40);
		const { state, anchors } = surface(before, heights);
		const near = strokeAt("near", 10, 205), far = strokeAt("far", 10, 605);
		anchors.anchorNew(PATH, near);
		anchors.anchorNew(PATH, far);
		// A character typed inside line 2, and in the same update line 4 grows by 30 (a widget below the typing).
		const changes = ChangeSet.of({ from: before.line(2).from + 3, insert: "x" }, before.length);
		const after = changes.apply(before);
		state.layout = layoutOf(after, heights.map((h, i) => (i === 3 ? 70 : h)));
		anchors.docChanged(PATH, [near, far], before, changes, after);
		expect([near.lineAnchor!.line, far.lineAnchor!.line], "the first line below moved: every anchor below is re-taken, onto the line now under it").toEqual([5, 15]);
		expect([anchors.dyOf(near), anchors.dyOf(far)], "and nothing moves on screen").toEqual([0, 0]);
	});

	it("keep every correction read through the measure after a character typed inside a line when nothing else moved, and read them all again when something did", () => {
		const before = lines(60), heights = Array.from({ length: 60 }, () => 40);
		const state = { at: counted(layoutOf(before, heights)) };
		const anchors = new LineAnchors(() => state.at.layout);
		anchors.setSignature(SIG);
		// 500 strokes, ten on each of lines 11 to 60.
		const src: InkStroke[] = [];
		for (let i = 0; i < 500; i++) {
			const s = strokeAt(`s${i}`, 10 + (i % 10) * 20, 400 + Math.floor(i / 10) * 40 + 10);
			anchors.anchorNew(PATH, s);
			src.push(s);
		}
		// Lines 1 to 5 measured 10 shorter: every stroke is shown 50 up.
		const measured = heights.map((h, i) => (i < 5 ? 30 : h));
		state.at = counted(layoutOf(before, measured));
		expect(anchors.layoutChanged(PATH, src)).toBe(true);
		// A character typed inside line 2, and the measure after it: the typed line keeps its height.
		const changes = ChangeSet.of({ from: before.line(2).from + 3, insert: "x" }, before.length);
		const after = changes.apply(before);
		state.at = counted(layoutOf(after, measured));
		anchors.docChanged(PATH, src, before, changes, after);
		drewEdit(anchors);
		state.at = counted(layoutOf(after, measured));
		readEdit(anchors);
		// The record's own reads of the lines drawn aside: the layout update's reads are counted.
		state.at.reads.tops = 0;
		expect(anchors.layoutChanged(PATH, src, "measure"), "nothing moved").toBe(false);
		expect(src.every((s) => anchors.dyOf(s) === -50)).toBe(true);
		expect(state.at.reads.tops, "the typed line's span and the first and last anchored lines, not a top per anchored line").toBeLessThanOrEqual(4);
		// The next keystroke's measure also finds line 1 10 shorter: the first anchored line shows it, and every correction is read.
		const changes2 = ChangeSet.of({ from: after.line(2).from + 4, insert: "y" }, after.length);
		const after2 = changes2.apply(after);
		state.at = counted(layoutOf(after2, measured));
		anchors.docChanged(PATH, src, after, changes2, after2);
		drewEdit(anchors);
		state.at = counted(layoutOf(after2, measured.map((h, i) => (i === 0 ? 20 : h))));
		readEdit(anchors);
		expect(anchors.layoutChanged(PATH, src, "measure")).toBe(true);
		expect(src.every((s) => anchors.dyOf(s) === -60)).toBe(true);
	});

	it("re-take the anchors below a line break in place, one line at a time, moving their keys with their lines, and keep every stroke where it is shown", () => {
		const before = lines(60), heights = Array.from({ length: 60 }, () => 40);
		const state = { at: counted(layoutOf(before, heights)) };
		const anchors = new LineAnchors(() => state.at.layout);
		anchors.setSignature(SIG);
		// 500 strokes, ten on each of lines 11 to 60.
		const src: InkStroke[] = [];
		for (let i = 0; i < 500; i++) {
			const s = strokeAt(`s${i}`, 10 + (i % 10) * 20, 400 + Math.floor(i / 10) * 40 + 10);
			anchors.anchorNew(PATH, s);
			src.push(s);
		}
		const objects = src.map((s) => s.lineAnchor), held = src.map((s) => ({ ...s.lineAnchor! }));
		// A line break typed at the end of line 1: every line below moves down one, the new line laid out under the guess.
		const changes = ChangeSet.of({ from: before.line(1).to, insert: "\n" }, before.length);
		const after = changes.apply(before);
		state.at = counted(layoutOf(after, [...heights, 40]));
		anchors.docChanged(PATH, src, before, changes, after);
		expect(src.every((s, i) => s.lineAnchor === objects[i]), "each anchor changed in place").toBe(true);
		// The stroke written on line L is shown where it was, over line L, which now holds line L - 1's text.
		expect(src.every((s, i) => s.lineAnchor!.line === held[i]!.line && s.lineAnchor!.key === lineKey(after.line(held[i]!.line).text))).toBe(true);
		expect(src.every((s) => anchors.dyOf(s) === 0), "a line break moves no ink").toBe(true);
		expect(state.at.reads.texts, "the keys below the break move with their lines: only line 11, whose key was never held, is hashed").toBe(1);
		// The re-taken anchors take their lines-above hash when the page is next written, from the text then.
		anchors.fold();
		expect(src.every((s) => s.lineAnchor!.above === aboveIn(after, s.lineAnchor!.line)), "each re-taken anchor names the text above its line now").toBe(true);
		drewEdit(anchors);
		// The measure: the new line is as tall as guessed. Nothing moved.
		state.at = counted(layoutOf(after, [...heights, 40]));
		readEdit(anchors);
		expect(anchors.layoutChanged(PATH, src, "measure")).toBe(false);
		// The line break deleted again: every anchor is back as it was taken, in the same object.
		const undo = ChangeSet.of({ from: after.line(1).to, to: after.line(2).from }, after.length);
		const back = undo.apply(after);
		state.at = counted(layoutOf(back, heights));
		anchors.docChanged(PATH, src, after, undo, back);
		expect(src.every((s, i) => s.lineAnchor === objects[i])).toBe(true);
		expect(src.map((s) => s.lineAnchor)).toEqual(held);
		expect(state.at.reads.texts, "every key moved back with its line").toBe(0);
	});

	it("give a stroke between two changes made before one measure its own span of the changed lines above it", () => {
		const before = lines(40), heights = Array.from({ length: 40 }, () => 40);
		const { state, anchors } = surface(before, heights);
		const mid = strokeAt("mid", 10, 805), low = strokeAt("low", 10, 1405);
		anchors.anchorNew(PATH, mid);
		anchors.anchorNew(PATH, low);
		expect([mid.lineAnchor!.line, low.lineAnchor!.line]).toEqual([21, 36]);
		const src = [mid, low];
		// A character typed inside line 30, and before the measure another inside line 2: one window over both.
		const c1 = ChangeSet.of({ from: before.line(30).from + 3, insert: "x" }, before.length);
		const a1 = c1.apply(before);
		state.layout = layoutOf(a1, heights);
		anchors.docChanged(PATH, src, before, c1, a1);
		drewEdit(anchors);
		const c2 = ChangeSet.of({ from: a1.line(2).from + 3, insert: "y" }, a1.length);
		const a2 = c2.apply(a1);
		state.layout = layoutOf(a2, heights);
		anchors.docChanged(PATH, src, a1, c2, a2);
		drewEdit(anchors);
		// The measure: line 2 wraps to 80 px and line 30 to 120. The text moves down; the ink stays where it is.
		state.layout = layoutOf(a2, heights.map((h, i) => (i === 1 ? 80 : i === 29 ? 120 : h)));
		readEdit(anchors);
		anchors.layoutChanged(PATH, src, "measure");
		expect([anchors.dyOf(mid), anchors.dyOf(low)], "typing moves no ink").toEqual([0, 0]);
		// After the window the ink follows its line again.
		state.layout = layoutOf(a2, heights.map((h, i) => (i === 0 ? 30 : i === 1 ? 80 : i === 29 ? 120 : h)));
		expect(anchors.layoutChanged(PATH, src)).toBe(true);
		expect([anchors.dyOf(mid), anchors.dyOf(low)]).toEqual([-10, -10]);
	});

	it("keep a range open while its changed line is unread, close a range read whole on its own, carry the open one through a later change, and close the window at the measure that reads the last line", () => {
		const heights = Array.from({ length: 20 }, () => 40), start = lines(20), { state, anchors } = surface(start, heights);
		anchors.drawn(1, 20);
		// A stroke on line 15 (top 560), below every change.
		const s = strokeAt("s", 10, 565), src = [s];
		anchors.anchorNew(PATH, s);
		expect(s.lineAnchor!.line).toBe(15);
		let doc = start;
		const typeOn = (n: number, guess: number[]): void => {
			const changes = ChangeSet.of({ from: doc.line(n).to, insert: " and more words that wrap" }, doc.length), after = changes.apply(doc);
			state.layout = layoutOf(after, guess);
			anchors.docChanged(PATH, src, doc, changes, after);
			doc = after;
		};
		// Words typed on line 3 in an update that moves the view to lines 10 to 20, as an undo scrolls to its cursor: line 3 is
		// left under the editor's guess.
		typeOn(3, heights);
		anchors.drawn(10, 20);
		// Words typed on line 12, which the view shows.
		typeOn(12, heights);
		drewEdit(anchors);
		// The measure reads line 12 two rows tall; line 3 is still unread. Its update marks what it read, then the window is judged.
		const twelve = heights.map((h, i) => (i === 11 ? 80 : h));
		state.layout = layoutOf(doc, twelve);
		anchors.drawn(10, 20, true, true);
		anchors.layoutChanged(PATH, src, "measure");
		expect(anchors.windowOpen, "line 3 unread: the window stays open").toBe(true);
		expect(anchors.dyOf(s), "line 12, read, goes on the log alone: the ink below reads the same correction while line 3 waits").toBe(0);
		// Words typed on line 18, away from both: their ranges carry on with their own guesses.
		typeOn(18, twelve);
		drewEdit(anchors);
		// The view back over line 3: the draw shows it under its guess, and the measure reads it two rows tall.
		anchors.drawn(1, 20);
		state.layout = layoutOf(doc, twelve.map((h, i) => (i === 2 ? 80 : h)));
		anchors.drawn(1, 20, true, true);
		anchors.layoutChanged(PATH, src, "measure");
		expect(anchors.windowOpen, "every changed line read: the window closes").toBe(false);
		expect(anchors.dyOf(s), "lines 3 and 12 pushed the text, not the ink: it is where it was before the typing").toBe(0);
	});

	it("close the lines of a range a measure read on their own, and carry the unread rest through a later change with its slice of the guess: each part's growth goes on the log when it is read", () => {
		const heights = Array.from({ length: 20 }, () => 40), start = lines(20), { state, anchors } = surface(start, heights);
		anchors.drawn(1, 20);
		// A stroke on line 15 (top 560), below every change.
		const s = strokeAt("s", 10, 565), src = [s];
		anchors.anchorNew(PATH, s);
		expect(s.lineAnchor!.line).toBe(15);
		let doc = start;
		const type = (n: number, insert: string, guess: number[]): void => {
			const changes = ChangeSet.of({ from: doc.line(n).to, insert }, doc.length), after = changes.apply(doc);
			state.layout = layoutOf(after, guess);
			anchors.docChanged(PATH, src, doc, changes, after);
			doc = after;
		};
		// Words and a line break typed at the end of line 9, in an update that moves the view to lines 10 to 21, as an undo
		// scrolls to its cursor: the change is lines 9 and 10, the view draws line 10 and leaves line 9 under the editor's guess.
		// The guess puts line 9, now longer, at a row and a half and line 10 at one row, so each part has its own slice of it.
		const guess = Array.from({ length: 21 }, (_, i) => (i === 8 ? 60 : 40));
		type(9, " and more words that wrap\nand a new line that wraps too", guess);
		const changed = anchors.pendingShifts;
		anchors.drawn(10, 21);
		// The measure reads line 10 two rows tall; line 9 is still unread, so it stays open while line 10 closes on its own.
		const ten = guess.map((h, i) => (i === 9 ? 80 : h));
		state.layout = layoutOf(doc, ten);
		anchors.drawn(10, 21, true, true);
		anchors.layoutChanged(PATH, src, "measure");
		expect(anchors.windowOpen, "line 9 unread: it stays open").toBe(true);
		expect(anchors.dyOf(s), "line 10, read, pushed the text and not the ink: the ink below reads the same correction while line 9 waits").toBe(0);
		expect(anchors.pendingShifts, "line 10 closes on its own, one measure on the log").toBe(changed + 1);
		// Words typed on line 18, away from it: the open line carries on with its slice of the guess it opened with.
		type(18, " and a few more", ten);
		drewEdit(anchors);
		const typed = anchors.pendingShifts;
		// The view back over line 9: the draw shows it under its guess, and the measure reads it two rows tall.
		anchors.drawn(1, 21);
		state.layout = layoutOf(doc, ten.map((h, i) => (i === 8 ? 80 : h)));
		anchors.drawn(1, 21, true, true);
		anchors.layoutChanged(PATH, src, "measure");
		expect(anchors.windowOpen, "every changed line read: the window closes").toBe(false);
		expect(anchors.pendingShifts, "line 9 closes with a second measure on the log").toBe(typed + 1);
		expect(anchors.dyOf(s), "lines 9 and 10 pushed the text, not the ink: it is where it was before the typing").toBe(0);
	});

	it("take a new anchor against the text as it is now after an edit made while the surface held no anchored ink", () => {
		let doc = lines(6);
		const state = { layout: layoutOf(doc, [40, 40, 40, 40, 40, 40]) };
		const anchors = new LineAnchors(() => state.layout);
		anchors.setSignature(SIG);
		anchors.anchorNew(PATH, strokeAt("first", 10, 125));
		// That stroke is erased, so the overlay has nothing to re-take when line 4 is rewritten.
		expect(anchors.tracks(PATH, [])).toBe(false);
		const changes = ChangeSet.of({ from: doc.line(4).from, to: doc.line(4).to, insert: "line four rewritten" }, doc.length);
		const before = doc;
		doc = changes.apply(doc);
		state.layout = layoutOf(doc, [40, 40, 40, 40, 40, 40]);
		anchors.skipped(before, changes, doc);
		const second = strokeAt("second", 10, 125);
		anchors.anchorNew(PATH, second);
		expect(second.lineAnchor!.key, "the key of the text there now").toBe(lineKey("line four rewritten"));
		state.layout = layoutOf(doc, [20, 40, 40, 40, 40, 40]);
		anchors.layoutChanged(PATH, [second]);
		expect(anchors.dyOf(second), "honoured: it moves with its line").toBe(-20);
	});

	it("re-take a dropped stroke's anchor where it is shown, so it rides the line it was dropped on", () => {
		const doc = lines(8), { state, anchors } = surface(doc, [40, 40, 40, 40, 40, 40, 40, 40]);
		const s = strokeAt("s", 10, 45);
		anchors.anchorNew(PATH, s);
		expect(s.lineAnchor!.line).toBe(2);
		state.layout = layoutOf(doc, [30, 40, 40, 40, 40, 40, 40, 40]);
		anchors.layoutChanged(PATH, [s]);
		expect(anchors.dyOf(s)).toBe(-10);
		// A lasso drag 160 down: shown at 197, on line 6 (top 190). The drag itself keeps the anchor's line.
		translateStroke(s, 0, 160);
		expect(s.lineAnchor!.line).toBe(2);
		anchors.retake(PATH, [s]);
		expect(s.lineAnchor!.line).toBe(6);
		expect(anchors.dyOf(s), "the drop moves nothing on screen").toBe(-10);
		// Line 4 is measured 30 taller: the dropped stroke, below it, moves with line 6, not with line 2 above it.
		state.layout = layoutOf(doc, [30, 40, 40, 70, 40, 40, 40, 40]);
		anchors.layoutChanged(PATH, [s]);
		expect(anchors.dyOf(s)).toBe(20);
	});

	it("keep each drawn line's measured height: the prefix is the run on record from line 1, an estimate refresh leaves it, an edit drops only the edited lines, and the lines below keep theirs", () => {
		let doc = lines(300);
		const heights = Array.from({ length: 300 }, () => 40);
		const { state, anchors } = surface(doc, heights), seen = measuredDraw(anchors);
		expect(anchors.unseeded, "nothing drawn yet").toBe(true);
		expect(seen(20, 40), "a note opened deep: the lines above were never drawn").toBe(false);
		expect(anchors.unseeded).toBe(false);
		expect(anchors.measuredThrough).toBe(0);
		expect(seen(70, 90)).toBe(false);
		expect(seen(200, 220), "a second run away from the first: both are kept").toBe(false);
		expect(seen(1, 25)).toBe(true);
		expect(anchors.measuredThrough, "lines 20 to 40, drawn before line 1, join the prefix when it reaches them").toBe(40);
		expect(seen(41, 69)).toBe(true);
		expect(anchors.measuredThrough, "lines 70 to 90 kept their heights until the prefix reached them").toBe(90);
		// The editor's estimate refresh: every line it has not drawn since goes back to an estimate (here 33.8 px). The record
		// keeps the heights it measured.
		state.layout = layoutOf(doc, heights.map((h, i) => (i < 10 ? h : 33.8)));
		expect(seen(1, 10), "a refresh: the lines drawn with it are read, nothing is dropped").toBe(false);
		expect(anchors.measuredThrough).toBe(90);
		// A character typed inside line 30: only line 30's height goes.
		let before = doc, changes = ChangeSet.of({ from: doc.line(30).from + 2, insert: "x" }, doc.length);
		doc = changes.apply(doc);
		state.layout = layoutOf(doc, heights);
		anchors.skipped(before, changes, doc);
		expect(anchors.measuredThrough, "an edit at line 30 leaves lines 1 to 29").toBe(29);
		expect(anchors.changedLines).toEqual({ from: 30, to: 30 });
		expect(seen(30, 30)).toBe(true);
		expect(anchors.measuredThrough, "lines 31 to 90 kept their heights through the edit").toBe(90);
		// A line break at the end of line 10: lines 10 and 11 are the changed ones, and lines 11 to 90 are now 12 to 91.
		before = doc;
		changes = ChangeSet.of({ from: doc.line(10).to, insert: "\n" }, doc.length);
		doc = changes.apply(doc);
		heights.push(40);
		state.layout = layoutOf(doc, heights);
		anchors.skipped(before, changes, doc);
		expect(anchors.measuredThrough).toBe(9);
		expect(anchors.changedLines).toEqual({ from: 10, to: 11 });
		expect(seen(10, 11)).toBe(true);
		expect(anchors.measuredThrough, "the heights below the break moved one line on with their lines").toBe(91);
		// Lines 5 and 6 joined: line 5 is the changed one, and lines 7 to 91 are now 6 to 90.
		before = doc;
		changes = ChangeSet.of({ from: doc.line(5).to, to: doc.line(6).from }, doc.length);
		doc = changes.apply(doc);
		heights.pop();
		state.layout = layoutOf(doc, heights);
		anchors.skipped(before, changes, doc);
		expect(anchors.changedLines).toEqual({ from: 5, to: 5 });
		expect(seen(5, 5)).toBe(true);
		expect(anchors.measuredThrough, "and moved back one line when two lines joined").toBe(90);
		anchors.setSignature({ width: 600, fontPx: 26, charWidth: 14 });
		expect(anchors.unseeded, "a new signature drops every height").toBe(true);
		expect(seen(5, 12), "and the record starts again from what is drawn, never from nothing").toBe(false);
		expect(anchors.measuredThrough).toBe(0);
	});

	it("keep the signature and every measured height through a content width move within one character width of the width it was set at, and drop both past it", () => {
		const doc = lines(100), { anchors } = surface(doc, Array.from({ length: 100 }, () => 40)), seen = measuredDraw(anchors);
		seen(1, 60);
		expect(anchors.measuredThrough).toBe(60);
		// The content box 9 px wider, as a measure during a scroll has read it, then back: nothing re-wraps.
		expect(anchors.setSignature({ ...SIG, width: SIG.width + 9 }), "9 px is under one 14 px character: not a new signature").toBe(false);
		expect(anchors.setSignature({ ...SIG, width: SIG.width }), "and back").toBe(false);
		expect(anchors.setSignature({ ...SIG, width: SIG.width - SIG.charWidth }), "exactly one character").toBe(false);
		expect(anchors.sig!.width, "the width stays the one set at the first measure").toBe(SIG.width);
		expect(anchors.measuredThrough, "and the record stands").toBe(60);
		expect(anchors.setSignature({ ...SIG, width: SIG.width + 9, charWidth: 15 }), "the editor's character width moved").toBe(false);
		expect(anchors.sig, "the width set at the first measure, the character width the editor's latest").toEqual({ ...SIG, charWidth: 15 });
		// Sticky: measured against the width it was set at, not the last one measured (9 px wider, then 18).
		expect(anchors.setSignature({ ...SIG, width: SIG.width + 9 })).toBe(false);
		expect(anchors.setSignature({ ...SIG, width: SIG.width + 18 }), "18 px from the set width: a new signature").toBe(true);
		expect(anchors.sig!.width).toBe(SIG.width + 18);
		expect(anchors.unseeded, "and the record goes").toBe(true);
		expect(anchors.measuredThrough).toBe(0);
		seen(1, 30);
		expect(anchors.setSignature({ ...SIG, width: SIG.width + 18, fontPx: 27 }), "any font size move is a new signature").toBe(true);
		expect(anchors.measuredThrough).toBe(0);
	});

	it("keep the signature through one character more at a fractional character width, the integer width moving by it rounded up", () => {
		const { anchors } = surface(lines(100), Array.from({ length: 100 }, () => 40));
		// As measured on a 16 px monospace font, 8.796875 px a character: "line 99" to "line 100" moved the width 386 to 395.
		const sig = { width: 386, fontPx: 16, charWidth: 8.796875 };
		anchors.setSignature(sig);
		measuredDraw(anchors)(1, 60);
		expect(anchors.setSignature({ ...sig, width: 395 }), "9 px: one character, rounded up").toBe(false);
		expect(anchors.measuredThrough, "the record stands").toBe(60);
		expect(anchors.setSignature({ ...sig, width: 396 }), "10 px: past one character").toBe(true);
		expect(anchors.measuredThrough, "the record goes").toBe(0);
	});

	it("anchor old ink once its line and every line above have a measured height, never under an estimate", () => {
		const doc = lines(8), { state, anchors } = surface(doc, [40, 40, 40, 40, 40, 40, 40, 40]), seen = measuredDraw(anchors);
		const near = strokeAt("near", 10, 45), far = strokeAt("far", 10, 245), elsewhere = strokeAt("elsewhere", 10, 85);
		// Anchored on another width: shown at its page position here, and re-taken here once its line is measured.
		elsewhere.lineAnchor = takeAnchor(elsewhere, state.layout, { width: 600, fontPx: 26, charWidth: 14 })!;
		const src = [near, far, elsewhere];
		anchors.tracks(PATH, src);
		// Lines 3 to 5 drawn first: they join the prefix once lines 1 and 2 are drawn; line 7 is never drawn.
		seen(3, 5);
		expect(anchors.anchorMeasured(PATH, src), "lines 1 and 2 were never measured").toBe(0);
		expect(near.lineAnchor).toBeUndefined();
		seen(1, 4);
		expect(anchors.anchorMeasured(PATH, src)).toBe(2);
		expect(near.lineAnchor!.line).toBe(2);
		expect(far.lineAnchor, "line 7 is past the prefix").toBeUndefined();
		expect(elsewhere.lineAnchor!.width, "re-taken under this surface's signature").toBe(SIG.width);
		expect([anchors.dyOf(near), anchors.dyOf(elsewhere)], "the editor's tops are the measured ones: nothing moves").toEqual([0, 0]);
		state.layout = layoutOf(doc, [20, 40, 40, 40, 40, 40, 40, 40]);
		anchors.layoutChanged(PATH, src);
		expect([anchors.dyOf(near), anchors.dyOf(far), anchors.dyOf(elsewhere)], "from then on they move with their lines").toEqual([-20, 0, -20]);
	});

	it("anchor old ink on the line whose measured top holds its bbox top while the editor holds estimates above it: on its words at once, then at its page position as the editor measures", () => {
		const doc = lines(8), heights = [40, 40, 40, 40, 40, 40, 40, 40], { state, anchors } = surface(doc, heights), seen = measuredDraw(anchors);
		// Bbox top 142: on line 4 by the measured tops (120 to 160), on line 5 by the estimates below (140 to 180).
		const old = strokeAt("old", 10, 140), src = [old];
		anchors.tracks(PATH, src);
		seen(1, 8);
		// The editor's estimate refresh put lines 1 and 2 back to 30 px estimates; the record keeps the 40 it measured.
		state.layout = layoutOf(doc, [30, 30, 40, 40, 40, 40, 40, 40]);
		anchors.layoutChanged(PATH, src);
		seen(4, 8);
		const gen = anchors.generation;
		expect(anchors.anchorMeasured(PATH, src)).toBe(1);
		expect([old.lineAnchor!.line, old.lineAnchor!.top], "the line its measured top holds, at that top").toEqual([4, 120]);
		expect(anchors.dyOf(old), "shown on line 4's words, where the estimates hold them: 20 above its page position, at once").toBe(-20);
		expect(anchors.generation, "a correction shows: the note repaints").not.toBe(gen);
		state.layout = layoutOf(doc, heights);
		anchors.layoutChanged(PATH, src);
		expect(anchors.dyOf(old), "the editor measured lines 1 and 2: the stroke is back at its page position").toBe(0);
	});

	it("carry the anchor through a move, a scale and an erase cut", () => {
		const doc = lines(6), layout = layoutOf(doc, [40, 40, 40, 40, 40, 40]);
		const s = strokeAt("s", 10, 125);
		s.lineAnchor = takeAnchor(s, layout, SIG)!;
		translateStroke(s, 7, 30);
		expect(anchorHolds(s.lineAnchor, s, layout, SIG), "a move keeps the anchor naming its stroke").toBe(true);
		expect(s.lineAnchor.line).toBe(4);
		const pieces = splitStrokeByCircle(s, s.points[1]!.x, s.points[1]!.y, 2, () => "p" + Math.random());
		expect(pieces.length).toBeGreaterThan(0);
		for (const p of pieces) {
			expect(p.lineAnchor!.line).toBe(4);
			expect(anchorHolds(p.lineAnchor!, p, layout, SIG), "a piece keeps its parent's line under its own y").toBe(true);
		}
		const off = { ...s, lineAnchor: { ...s.lineAnchor, y: s.lineAnchor.y + 3 } };
		expect(pieceAnchor(off, pieces[0]!)!.y - pieces[0]!.bbox.y, "a parent that no longer matched passes that on").toBeCloseTo(3);
		scaleStroke(s, 2);
		expect(s.lineAnchor.y).toBe(s.bbox.y);
		expect(s.lineAnchor.top).toBe(240);
	});
});

describe("line anchors in the ink file", () => {
	const page = () => {
		const p = emptyPage("anchors");
		const s = strokeAt("anchored", 10, 125);
		s.lineAnchor = { line: 4, top: 120.0004, y: s.bbox.y, key: 3735928559, width: 892, fontPx: 26 };
		p.strokes = [s, strokeAt("plain", 10, 30)];
		return p;
	};

	it("round-trip the anchor, its line top to a thousandth of a world unit, and write nothing for a stroke without one", () => {
		const raw = JSON.parse(serializePage(page())) as { strokes: Array<Record<string, unknown>> };
		expect(raw.strokes[0]!.lineAnchor).toEqual({ line: 4, top: 120, y: page().strokes[0]!.bbox.y, key: 3735928559, width: 892, fontPx: 26 });
		expect("lineAnchor" in raw.strokes[1]!).toBe(false);
		const back = parsePage(JSON.stringify(raw), "anchors").data;
		expect(back.strokes[0]!.lineAnchor).toEqual(raw.strokes[0]!.lineAnchor);
		expect(back.unknownByObject.anchored).toBeUndefined();
	});

	it("pass through a build without the field byte for byte, the field aside, and come back honoured", () => {
		const mine = serializePage(page()), field = (JSON.parse(mine) as { strokes: Array<Record<string, unknown>> }).strokes[0]!.lineAnchor;
		// A build without the field reads the stroke as this one does and keeps the field in the stroke's unknown-field map,
		// as it keeps any field it does not know (PageData.ts unknownByObject); the two serializers differ by that one line.
		const read = parsePage(mine, "anchors").data;
		const older = { ...read, strokes: read.strokes.map(({ lineAnchor: _line, ...s }) => s), unknownByObject: { ...read.unknownByObject, anchored: { lineAnchor: field } } };
		const theirs = serializePage(older);
		const without = (text: string) => JSON.stringify(JSON.parse(text), (k, v: unknown) => (k === "lineAnchor" ? undefined : v));
		expect(without(theirs), "every byte but the field's").toBe(without(mine));
		expect((JSON.parse(theirs) as { strokes: Array<Record<string, unknown>> }).strokes[0]!.lineAnchor).toEqual(field);
		expect(parsePage(theirs, "anchors").data.strokes[0]!.lineAnchor, "back in this build, honoured as written").toEqual(field);
		// A note with no anchored ink is written as it was before the field existed.
		const plain = emptyPage("plain");
		plain.strokes = [strokeAt("plain", 10, 30)];
		expect(serializePage(plain)).not.toContain("lineAnchor");
	});

	it("keep an anchor this build cannot honour as it was found, and honour none of it", () => {
		const raw = JSON.parse(serializePage(page())) as { strokes: Array<Record<string, unknown>> };
		const odd = { line: 0, top: "x", future: true };
		raw.strokes[0]!.lineAnchor = odd;
		const back = parsePage(JSON.stringify(raw), "anchors").data;
		expect(back.strokes[0]!.lineAnchor).toBeUndefined();
		expect(back.unknownByObject.anchored).toEqual({ lineAnchor: odd });
		const again = JSON.parse(serializePage(back)) as { strokes: Array<Record<string, unknown>> };
		expect(again.strokes[0]!.lineAnchor).toEqual(odd);
	});
});

describe("line anchors: the shift log", () => {
	/**
	 * Two surfaces over one note's text and line heights, each with its own copy of the same strokes. `lazy` reads the lines
	 * drawn as the overlay does (every line, read whole after each layout update; the changed lines after each document
	 * change), so its changes go on the shift log. `eager` never reads every line drawn, so every change it hears takes the
	 * eager path: the reference. Both read the changed lines a change draws, which the measure after it reads.
	 */
	function pair(doc: Text, heights: number[], ys: number[]) {
		const cur = { doc, heights, layout: layoutOf(doc, heights) };
		const make = () => {
			const anchors = new LineAnchors(() => cur.layout);
			anchors.setSignature(SIG);
			const src = ys.map((y, i) => strokeAt(`s${i}`, 10, y));
			for (const s of src) anchors.anchorNew(PATH, s);
			return { anchors, src };
		};
		const lazy = make(), eager = make();
		lazy.anchors.drawn(1, doc.lines);
		/** A layout update: the lines measured at `measured`. */
		const measure = (measured: number[]): void => {
			cur.heights = measured;
			cur.layout = layoutOf(cur.doc, measured);
			// As the overlay orders a measure loop's update: the lines drawn recorded and marked, then the window judged.
			lazy.anchors.drawn(1, cur.doc.lines, true, true);
			lazy.anchors.layoutChanged(PATH, lazy.src, "measure");
			readEdit(eager.anchors);
			eager.anchors.layoutChanged(PATH, eager.src, "measure");
		};
		/** A document change, laid out under the editor's guess `guess` (every line's height after it). */
		const edit = (spec: { from: number; to?: number; insert?: string }, guess: number[]): void => {
			const before = cur.doc, changes = ChangeSet.of(spec, before.length), after = changes.apply(before);
			cur.doc = after;
			cur.heights = guess;
			cur.layout = layoutOf(after, guess);
			lazy.anchors.docChanged(PATH, lazy.src, before, changes, after);
			drewEdit(lazy.anchors);
			eager.anchors.docChanged(PATH, eager.src, before, changes, after);
			drewEdit(eager.anchors);
		};
		return { cur, lazy, eager, measure, edit };
	}

	it("show every stroke where the eager re-take shows it, through three mixed keystrokes and their measures, walking no ink at the keystroke", () => {
		// 40 lines of 40 px; line 3 wraps to two rows (80 px).
		const heights = Array.from({ length: 40 }, (_, i) => (i === 2 ? 80 : 40));
		// Strokes on line 2 (above every change), line 3's two rows, and lines 10, 12, 20, 21 and 35.
		const ys = [45, 85, 125, 405, 485, 805, 845, 1405];
		const p = pair(lines(40), heights, ys);
		const shown = (side: { anchors: LineAnchors; src: InkStroke[] }) => side.src.map((s) => side.anchors.dyOf(s));
		const same = (when: string) => expect(shown(p.lazy), when).toEqual(shown(p.eager));
		// Line 1 measured 6 shorter: every stroke is shown 6 up.
		p.measure(heights.map((h, i) => (i === 0 ? 34 : h)));
		expect(shown(p.lazy)).toEqual(ys.map(() => -6));
		same("before the typing");
		// 1. A line break in the middle of line 3: its rows become lines 3 and 4, guessed at 40 each; line 4 measures 50.
		const far = { ...p.lazy.src[7]!.lineAnchor! }, farEager = { ...p.eager.src[7]!.lineAnchor! };
		let h = p.cur.heights;
		p.edit({ from: p.cur.doc.line(3).from + 4, insert: "\n" }, [...h.slice(0, 2), 40, 40, ...h.slice(3)]);
		expect(p.lazy.src[7]!.lineAnchor, "the lazy surface walked no ink: the far anchor waits on the log").toEqual(far);
		expect(p.lazy.anchors.pendingShifts).toBe(1);
		expect(p.eager.src[7]!.lineAnchor, "the eager surface re-took it").not.toEqual(farEager);
		h = p.cur.heights;
		p.measure(h.map((x, i) => (i === 3 ? 50 : x)));
		same("after the line break's measure");
		// 2. A character typed inside line 11 (line 10's words); the line wraps to 80 px at the measure.
		h = p.cur.heights;
		p.edit({ from: p.cur.doc.line(11).from + 2, insert: "x" }, h);
		p.measure(h.map((x, i) => (i === 10 ? 80 : x)));
		same("after the character's measure");
		// 3. Lines 21 and 22 (lines 20 and 21's words) joined, guessed at 40; the joined line wraps to 80 px at the measure.
		h = p.cur.heights;
		p.edit({ from: p.cur.doc.line(21).to, to: p.cur.doc.line(22).from }, [...h.slice(0, 20), 40, ...h.slice(22)]);
		h = p.cur.heights;
		p.measure(h.map((x, i) => (i === 20 ? 80 : x)));
		same("after the join's measure");
		expect(shown(p.lazy), "typing moves no ink").toEqual(ys.map(() => -6));
		expect(p.lazy.anchors.pendingShifts, "three changes and three measures on the log").toBe(6);
		// Line 1 measured 10 shorter again: every correction is read from the anchors, and each stroke moves with its line.
		h = p.cur.heights;
		p.measure(h.map((x, i) => (i === 0 ? 24 : x)));
		same("after a re-measure above every stroke");
		expect(shown(p.lazy)).toEqual(ys.map(() => -16));
		// The lazy anchor keeps its words: the far stroke rides the line holding line 35's words, wherever the typing put it.
		expect(p.lazy.src[7]!.lineAnchor!.key).toBe(lineKey("line 35 words"));
	});

	it("fold the log when it is full and before a page is written, so the file holds every anchor on its words' line now", async () => {
		// Strokes on lines 6, 11 and 21 of 30 lines of 40 px.
		const p = pair(lines(30), Array.from({ length: 30 }, () => 40), [205, 405, 805]);
		const { anchors, src } = p.lazy, held = src.map((s) => ({ ...s.lineAnchor! }));
		// A line break at the end of line 1, measured as guessed: one log entry, every line below one line and 40 px on.
		const enter = (): void => {
			p.edit({ from: p.cur.doc.line(1).to, insert: "\n" }, [40, ...p.cur.heights]);
			p.measure(p.cur.heights);
		};
		for (let i = 0; i < SHIFT_LOG_CAP; i++) enter();
		expect(anchors.pendingShifts).toBe(SHIFT_LOG_CAP);
		expect(src[1]!.lineAnchor, "no probe reads the middle stroke: its anchor waits on the log").toEqual(held[1]);
		// One more: the full log is folded first, every anchor resolved, and the new change waits alone.
		p.edit({ from: p.cur.doc.line(1).to, insert: "\n" }, [40, ...p.cur.heights]);
		expect(anchors.pendingShifts).toBe(1);
		expect(src[1]!.lineAnchor).toEqual({ ...held[1], line: 11 + SHIFT_LOG_CAP, top: 400 + 40 * SHIFT_LOG_CAP });
		p.measure(p.cur.heights);
		enter();
		enter();
		// The page is written: each anchor on the line holding its words now, at the top that keeps its stroke in place.
		const written = (text: string) => (JSON.parse(text) as { strokes: Array<{ lineAnchor: { line: number; top: number; key: number } }> }).strokes.map((s) => s.lineAnchor);
		const page = emptyPage("folded");
		page.strokes = src;
		let n = SHIFT_LOG_CAP + 3;
		expect(anchors.pendingShifts).toBeGreaterThan(0);
		const file = written(serializePage(page));
		expect(anchors.pendingShifts).toBe(0);
		expect(file.map((a) => [a.line, a.top])).toEqual(held.map((a) => [a.line + n, a.top + 40 * n]));
		expect(file.map((a) => a.key)).toEqual([6, 11, 21].map((l) => lineKey(`line ${l} words`)));
		expect(file.map((a) => (a as { above?: number }).above), "each names the text above its line now").toEqual(file.map((a) => aboveIn(p.cur.doc, a.line)));
		// The save's sliced writer settles them too.
		enter();
		n++;
		expect(anchors.pendingShifts).toBe(1);
		const sliced = written(await serializePageSliced(page, async () => undefined));
		expect(anchors.pendingShifts).toBe(0);
		expect(sliced.map((a) => [a.line, a.top])).toEqual(held.map((a) => [a.line + n, a.top + 40 * n]));
		// No stroke moved through any of it, and each still moves with its line: line 1 measured 10 shorter.
		expect(src.map((s) => anchors.dyOf(s))).toEqual([0, 0, 0]);
		p.measure(p.cur.heights.map((x, i) => (i === 0 ? 30 : x)));
		expect(src.map((s) => anchors.dyOf(s))).toEqual([-10, -10, -10]);
	});

	it("settleLineAnchors between a document change and the measure that closes it leaves the shown correction alone and the lines-above hash fresh once the window closes", () => {
		const before = lines(6), { state, anchors } = surface(before, [40, 40, 40, 40, 40, 40]);
		const s = strokeAt("s", 10, 125);
		anchors.anchorNew(PATH, s);
		expect(s.lineAnchor!.line).toBe(4);
		const changes = ChangeSet.of({ from: before.line(2).from, insert: "a typed line\n" }, before.length);
		const after = changes.apply(before);
		state.layout = layoutOf(after, [40, 40, 40, 40, 40, 40, 40]);
		anchors.docChanged(PATH, [s], before, changes, after);
		drewEdit(anchors);
		expect(anchors.windowOpen, "the window is still open: no measure has read the typed line yet").toBe(true);
		const dyBefore = anchors.dyOf(s);
		anchors.fold();
		expect(anchors.dyOf(s), "settleLineAnchors mid-window moves no ink").toBe(dyBefore);
		// The measure that closes the window: the typed line keeps its guessed height, nothing else moved.
		readEdit(anchors);
		anchors.layoutChanged(PATH, [s], "measure");
		expect(anchors.windowOpen, "the measure read the typed line: the window closes").toBe(false);
		expect(s.lineAnchor!.line, "the stroke rides the line now holding its words").toBe(4);
		expect(s.lineAnchor!.above, "a fresh hash of the text above its line now, not one the mid-window fold baked stale").toBe(aboveIn(after, 4));
	});

	it("read a stroke that joins the list carrying its own anchor while the log holds changes, unshifted", () => {
		// Strokes on lines 6 and 21 of 30 lines of 40 px.
		const p = pair(lines(30), Array.from({ length: 30 }, () => 40), [205, 805]);
		const { anchors } = p.lazy;
		// A line break at the end of line 1, measured as guessed: one entry on the log, every line below one line and 40 px on.
		const enter = (): void => {
			p.edit({ from: p.cur.doc.line(1).to, insert: "\n" }, [40, ...p.cur.heights]);
			p.measure(p.cur.heights);
		};
		enter();
		expect(anchors.pendingShifts).toBe(1);
		// A stroke another pane anchored after the change: on line 16 (line 15's words, top 600), shown 10 below its page
		// position. Its anchor already holds the change; the log's entry is older than it.
		const joined = strokeAt("other pane", 10, 595);
		const own = { line: 16, top: 590, y: joined.bbox.y, key: lineKey("line 15 words"), width: SIG.width, fontPx: SIG.fontPx, above: aboveIn(p.cur.doc, 16) };
		joined.lineAnchor = { ...own };
		p.lazy.src = [...p.lazy.src, joined];
		// The store's new list is first read by a repaint (noteStrokes), as when another pane commits and no editor update comes.
		const shown = anchors.strokesFor(PATH, p.lazy.src);
		expect(joined.lineAnchor, "the joined stroke's anchor is its own, not moved by the older line break").toEqual(own);
		expect(anchors.dyOf(joined)).toBe(10);
		expect(shown[2]!.bbox.y - joined.bbox.y).toBeCloseTo(10, 6);
		expect(anchors.pendingShifts, "the changed list folded the log").toBe(0);
		// From here it rides the log as every other stroke: a second line break moves it a line on and keeps its place.
		enter();
		expect(anchors.pendingShifts).toBe(1);
		anchors.fold();
		expect(joined.lineAnchor).toEqual({ ...own, line: 17, top: 630, above: aboveIn(p.cur.doc, 17) });
		// The file's own anchored stroke (a reload) first read by the old-ink pass, the log again holding a line break: line 25
		// (line 22's words, top 960), shown 10 below its page position. The pass leaves it as it is: its anchor holds.
		enter();
		const loaded = strokeAt("from the file", 10, 955);
		const kept = { line: 25, top: 950, y: loaded.bbox.y, key: lineKey("line 22 words"), width: SIG.width, fontPx: SIG.fontPx, above: aboveIn(p.cur.doc, 25) };
		loaded.lineAnchor = { ...kept };
		p.lazy.src = [...p.lazy.src, loaded];
		expect(anchors.anchorMeasured(PATH, p.lazy.src), "no stroke without a holding anchor").toBe(0);
		expect(loaded.lineAnchor, "the loaded stroke's anchor is its own, not moved by the older line break").toEqual(kept);
		expect(anchors.dyOf(loaded)).toBe(10);
		p.measure(p.cur.heights.map((x, i) => (i === 0 ? 30 : x)));
		expect(p.lazy.src.map((s) => anchors.dyOf(s)), "each moves with its line: line 1 measured 10 shorter").toEqual([-10, -10, 0, 0]);
	});
});

describe("line anchors: the correction bound is fixed, whatever the zoom", () => {
	it("honours a correction from two undrawn pictures above, over one screen at 100 percent", () => {
		const before = lines(6), { state, anchors } = surface(before, [40, 40, 40, 40, 40, 40]);
		const s = strokeAt("s", 10, 125);
		anchors.anchorNew(PATH, s);
		expect(s.lineAnchor!.line).toBe(4);
		expect(s.lineAnchor!.top).toBe(120);
		// Two undrawn pictures above, each guessed one line (40 px) and measured 600 px: 576 px over its guess, 1152 together.
		state.layout = layoutOf(before, [40, 616, 616, 40, 40, 40]);
		anchors.layoutChanged(PATH, [s]);
		expect(anchors.dyOf(s), "a legitimate single-measure correction, over one screen at 100 percent").toBe(1152);
	});

	it("honours a correction from four undrawn pictures above", () => {
		const before = lines(8), { state, anchors } = surface(before, [40, 40, 40, 40, 40, 40, 40, 40]);
		const s = strokeAt("s", 10, 205);
		anchors.anchorNew(PATH, s);
		expect(s.lineAnchor!.line).toBe(6);
		expect(s.lineAnchor!.top).toBe(200);
		// Four undrawn pictures above, each guessed one line (40 px) and measured 616: 576 px over its guess, 2304 together.
		state.layout = layoutOf(before, [40, 616, 616, 616, 616, 40, 40, 40]);
		anchors.layoutChanged(PATH, [s]);
		expect(anchors.dyOf(s), "four pictures' worth of correction").toBe(2304);
	});

	it("keeps an already-honoured correction across a zoom-only change", () => {
		const before = lines(6), { state, anchors } = surface(before, [40, 40, 40, 40, 40, 40]);
		const s = strokeAt("s", 10, 125);
		anchors.anchorNew(PATH, s);
		expect(s.lineAnchor!.line).toBe(4);
		// One picture above, guessed 40, measured 616: a 576 px correction, under one screen at 100 percent.
		state.layout = layoutOf(before, [40, 40, 616, 40, 40, 40]);
		anchors.layoutChanged(PATH, [s]);
		expect(anchors.dyOf(s), "honoured at 100 percent").toBe(576);
		// A pinch to 300 percent shrinks the screen to a third but changes neither the layout nor the bound: no document change.
		anchors.layoutChanged(PATH, [s]);
		expect(anchors.dyOf(s), "a correction already shown should not drop off the words on a zoom-only change").toBe(576);
	});

	it("still refuses a correction far past any run of pictures", () => {
		const before = lines(6), { state, anchors } = surface(before, [40, 40, 40, 40, 40, 40]);
		const s = strokeAt("s", 10, 125);
		anchors.anchorNew(PATH, s);
		expect(s.lineAnchor!.line).toBe(4);
		state.layout = layoutOf(before, [40, 1_000_040, 40, 40, 40, 40]);
		anchors.layoutChanged(PATH, [s]);
		expect(anchors.dyOf(s), "a top a million world units away is refused").toBe(0);
	});
});
