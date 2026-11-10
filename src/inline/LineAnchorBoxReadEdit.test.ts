/**
 * A keystroke drops the line box tops at and below the edited line (LineAnchors.edited), and the next measure reads those boxes
 * again (LineAnchors.boxesRead). A line whose dropped top reads back where the epoch already puts it has not moved: nothing is
 * read again, so typing above anchored ink costs no walk over it. A line whose box reads somewhere else moves its own ink, and
 * ink below a keystroke that wraps a line stays where it is drawn, then follows its own line's box.
 *
 * The layout is a stand-in for CodeMirror's height map at half an editor px per world unit, so a mix-up of world units and
 * editor px shows. The document and its changes are CodeMirror's own Text and ChangeSet.
 */
import { describe, expect, it, vi } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const PATH = "typed.md";
const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const PX = 0.5;
const LINE_PX = 20;
const LINES = 30;

/** A layout over `doc` whose line n is `heights[n - 1]` editor px tall. */
function layoutOf(doc: Text, heights: number[]): LineLayout {
	const tops = [0];
	for (const h of heights) tops.push(tops.at(-1)! + h);
	return { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => tops[n - 1]!, pxPerWorld: PX };
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** Each line's box top in world units as the measure reads it: the layout's top plus `gapPx(n)` editor px. */
function boxTopsOf(layout: LineLayout, from: number, to: number, gapPx: (n: number) => number = () => 0): Map<number, number> {
	const out = new Map<number, number>();
	for (let n = from; n <= to; n++) out.set(n, (layout.lineTop(n) + gapPx(n)) / PX);
	return out;
}

/**
 * A thirty-line note with three strokes anchored on each of lines 10 to 30, every line drawn and measured, and every anchored
 * line's box read once where the height map has it.
 */
function surface() {
	const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));
	const heights = Array.from({ length: LINES }, () => LINE_PX);
	const state = { layout: layoutOf(doc, heights) };
	const a = new LineAnchors(() => state.layout);
	a.setSignature(SIG);
	const src: InkStroke[] = [];
	for (let n = 10; n <= LINES; n++) for (let k = 0; k < 3; k++) src.push(strokeAt(`l${n}-${k}`, 10 + k * 30, ((n - 1) * LINE_PX) / PX + 3));
	for (const s of src) a.anchorNew(PATH, s);
	a.tracks(PATH, src);
	a.drawn(1, LINES);
	a.drawn(1, LINES, true, true);
	for (const s of src) expect(s.lineAnchor?.line, `premise: ${s.id} anchors on its line`).toBe(Number(s.id.slice(1, s.id.indexOf("-"))));
	expect(a.boxesRead(PATH, src, boxTopsOf(state.layout, 10, LINES), LINES - 9 + 2), "premise: the first box read moves nothing").toBe(false);
	for (const s of src) expect(a.dyOf(s), `premise: ${s.id} reads no correction`).toBe(0);
	return { doc, heights, state, a, src };
}

/**
 * One character typed inside line 5, as the overlay takes it: the change at the update (the changed line drawn, its height the
 * editor's estimate) and the measure loop's update after it, which reads the changed line under `measured` heights.
 */
function typeOnLine5(s: ReturnType<typeof surface>, measured: number[]): Text {
	const { doc, heights, state, a, src } = s;
	const changes = ChangeSet.of({ from: doc.line(5).from + 3, insert: "x" }, doc.length);
	const after = changes.apply(doc);
	state.layout = layoutOf(after, heights);
	a.docChanged(PATH, src, doc, changes, after);
	a.drawn(a.changedLines.from, a.changedLines.to, false);
	state.layout = layoutOf(after, measured);
	a.drawn(a.changedLines.from, a.changedLines.to, false, true);
	if (measured.some((h, i) => h !== heights[i])) a.layoutChanged(PATH, src, "measure");
	else if (a.windowOpen) a.windowViewed(PATH, src);
	return after;
}


describe("a box read after a keystroke reads ink again only for a line that moved", () => {
	it("typing one character above sixty-three anchored strokes, no line top changed: the box read enters no layout change and reads no anchor", () => {
		const s = surface();
		typeOnLine5(s, s.heights);
		const { a, src, state } = s;
		const layoutChanged = vi.spyOn(a, "layoutChanged");
		const read = vi.spyOn(a as unknown as { read: (...args: unknown[]) => number }, "read");
		const moved = a.boxesRead(PATH, src, boxTopsOf(state.layout, 10, LINES), LINES - 9 + 2);
		expect(moved, "no shown correction changed").toBe(false);
		expect(layoutChanged, "no layout change entered").not.toHaveBeenCalled();
		expect(read, "no anchor read again").not.toHaveBeenCalled();
		for (const t of src) expect(a.dyOf(t), `${t.id} reads no correction`).toBe(0);
		a.detached();
	});

	it("after the same keystroke, a box that reads 3 px off its line moves that line's ink by 3 px and no other ink", () => {
		const s = surface();
		typeOnLine5(s, s.heights);
		const { a, src, state } = s;
		const moved = a.boxesRead(PATH, src, boxTopsOf(state.layout, 10, LINES, (n) => (n === 20 ? 3 : 0)), LINES - 9 + 2);
		expect(moved, "line 20's correction moved").toBe(true);
		for (const t of src) {
			const want = t.lineAnchor!.line === 20 ? 3 / PX : 0;
			expect(a.dyOf(t), `${t.id}`).toBeCloseTo(want, 6);
		}
		a.detached();
	});

	it("a keystroke that wraps line 5 to two rows: no ink moves at the measure or the box read, and ink below then follows its own line's box", () => {
		const s = surface();
		const wrapped = s.heights.map((h, i) => (i === 4 ? h * 2 : h));
		typeOnLine5(s, wrapped);
		const { a, src, state } = s;
		for (const t of src) expect(a.dyOf(t), `${t.id}: typing moves no ink`).toBe(0);
		expect(a.boxesRead(PATH, src, boxTopsOf(state.layout, 10, LINES), LINES - 9 + 2), "the boxes read where the wrap put the lines").toBe(false);
		for (const t of src) expect(a.dyOf(t), `${t.id} after the box read`).toBe(0);
		// The anchors took the wrap: a later 3 px move of line 20's box, against its line top after the wrap, moves only its ink.
		expect(a.boxesRead(PATH, src, boxTopsOf(state.layout, 10, LINES, (n) => (n === 20 ? 3 : 0)), LINES - 9 + 2)).toBe(true);
		for (const t of src) expect(a.dyOf(t), `${t.id}`).toBeCloseTo(t.lineAnchor!.line === 20 ? 3 / PX : 0, 6);
		a.detached();
	});
	/**
	 * Ink shown against boxes that sat 3 px off the height map (a zoom CodeMirror's scale lags), then a keystroke above in the
	 * overlay's order: the change, the window measure's write (closeWindow), the box read. The keystroke dropped boxes that
	 * answered, so the read takes every line it reads: boxes back on the height map put the ink back on its lines, boxes
	 * still 3 px off keep it there.
	 */
	function shownOffTheMap(): ReturnType<typeof surface> {
		const s = surface();
		expect(s.a.boxesRead(PATH, s.src, boxTopsOf(s.state.layout, 10, LINES, () => 3), LINES - 9 + 2), "premise: boxes 3 px down move the ink").toBe(true);
		for (const t of s.src) expect(s.a.dyOf(t), `premise: ${t.id} shows 3 px down`).toBeCloseTo(3 / PX, 6);
		const { doc, heights, state, a, src } = s;
		const changes = ChangeSet.of({ from: doc.line(5).from + 3, insert: "x" }, doc.length);
		const after = changes.apply(doc);
		state.layout = layoutOf(after, heights);
		a.docChanged(PATH, src, doc, changes, after);
		a.drawn(a.changedLines.from, a.changedLines.to, false);
		a.closeWindow(PATH, src);
		return s;
	}

	it("ink shown against boxes 3 px off the height map, a keystroke above, then the boxes read on the height map: every stroke back on its line", () => {
		const s = shownOffTheMap();
		const { a, src, state } = s;
		expect(a.boxesRead(PATH, src, boxTopsOf(state.layout, 10, LINES), LINES - 9 + 2), "the shown corrections changed").toBe(true);
		for (const t of src) expect(a.dyOf(t), `${t.id} back on its line`).toBeCloseTo(0, 6);
		a.detached();
	});

	it("ink shown against boxes 3 px off the height map, a keystroke above, then the boxes read 3 px off again: every stroke stays 3 px down", () => {
		const s = shownOffTheMap();
		const { a, src, state } = s;
		a.boxesRead(PATH, src, boxTopsOf(state.layout, 10, LINES, () => 3), LINES - 9 + 2);
		for (const t of src) expect(a.dyOf(t), `${t.id} stays with its box`).toBeCloseTo(3 / PX, 6);
		// Read once, the boxes are back on record: the same boxes read again enter no layout change.
		const layoutChanged = vi.spyOn(a, "layoutChanged");
		expect(a.boxesRead(PATH, src, boxTopsOf(state.layout, 10, LINES, () => 3), LINES - 9 + 2), "the same boxes again move nothing").toBe(false);
		expect(layoutChanged, "no layout change entered on the same boxes").not.toHaveBeenCalled();
		a.detached();
	});
	it("a line grows above while the ink is off screen, a keystroke above, then the boxes read on the new map: every stroke on its line", () => {
		const s = surface();
		const { doc, heights, state, a, src } = s;
		// Line 2 grows 10 px (an embed loads) while lines 10 to 30 are off screen: lines 1 to 9 are measured, and the layout
		// change reads every correction again, the off-screen lines against the boxes last read, which now sit off the map.
		const grown = heights.map((h, i) => (i === 1 ? h + 10 : h));
		state.layout = layoutOf(doc, grown);
		a.drawn(1, 9);
		a.drawn(1, 9, true, true);
		a.layoutChanged(PATH, src, "measure");
		const changes = ChangeSet.of({ from: doc.line(5).from + 3, insert: "x" }, doc.length);
		const after = changes.apply(doc);
		state.layout = layoutOf(after, grown);
		a.docChanged(PATH, src, doc, changes, after);
		a.drawn(a.changedLines.from, a.changedLines.to, false);
		a.closeWindow(PATH, src);
		a.boxesRead(PATH, src, boxTopsOf(state.layout, 10, LINES), LINES - 9 + 2);
		for (const t of src) expect(a.dyOf(t), `${t.id} on its line, 10 px down`).toBeCloseTo(10 / PX, 6);
		a.detached();
	});
});
