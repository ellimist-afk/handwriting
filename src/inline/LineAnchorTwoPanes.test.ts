/**
 * Two panes on one note: one LineAnchors per pane (InkOverlay keeps one per surface), both reading the SAME stroke objects
 * (inlineInk.strokes is one store). Every pane hears each document change, as Obsidian's linked views of one file do. One
 * pane writes the change to the shared anchors, so each anchor moves once, keeps its words and is written on its line.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, lineKey, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { emptyPage, serializePage } from "../model/PageData";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const PATH = "two-panes.md";

function layoutOf(doc: Text, heights: number[]): LineLayout {
	const tops = [0];
	for (const h of heights) tops.push(tops.at(-1)! + h);
	return { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => tops[n - 1]!, pxPerWorld: 1 };
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

const lines = (n: number) => Text.of(Array.from({ length: n }, (_, i) => `line ${i + 1} words`));

/** Panes on one note; `typing` names the pane each line break is typed in (focus there), -1 for no pane with focus. */
function run(panes: number, typing: number[]) {
	const cur = { doc: lines(30), heights: Array.from({ length: 30 }, () => 40) };
	let layout = layoutOf(cur.doc, cur.heights);
	let focus = -1;
	const surfaces = Array.from({ length: panes }, (_, i) => {
		const a = new LineAnchors(() => layout, () => focus === i);
		a.setSignature(SIG);
		return a;
	});
	// One store list, shared by every pane. A stroke on line 6 (top 200), anchored at commit by the pane it was drawn in.
	const s = strokeAt("s", 10, 205);
	const src = [s];
	surfaces[0]!.anchorNew(PATH, s);
	for (const a of surfaces) {
		a.tracks(PATH, src);
		a.drawn(1, cur.doc.lines);
	}
	const measure = (h: number[]): void => {
		cur.heights = h;
		layout = layoutOf(cur.doc, h);
		for (const a of surfaces) {
			// As the overlay orders a measure loop's update: the lines drawn recorded and marked, then the window judged.
			a.drawn(1, cur.doc.lines, true, true);
			a.layoutChanged(PATH, src, "measure");
		}
	};
	// Line 1 measured 6 shorter: the stroke shows 6 up, with its line.
	measure(cur.heights.map((x, i) => (i === 0 ? 34 : x)));
	const before = surfaces.map((a) => a.dyOf(s));
	const written: Array<{ line: number; key: number } | undefined> = [];
	for (const pane of typing) {
		focus = pane;
		// A line break at the end of line 1, heard by the typing pane first and then by every other; then the measure, as guessed.
		const prev = cur.doc, changes = ChangeSet.of({ from: prev.line(1).to, insert: "\n" }, prev.length), next = changes.apply(prev);
		cur.doc = next;
		cur.heights = [34, 40, ...cur.heights.slice(1)];
		layout = layoutOf(next, cur.heights);
		const order = pane < 0 ? surfaces : [surfaces[pane]!, ...surfaces.filter((_, i) => i !== pane)];
		for (const a of order) {
			a.docChanged(PATH, src, prev, changes, next);
			a.drawn(a.changedLines.from, a.changedLines.to, false);
		}
		measure(cur.heights);
		// The page is written (every holder folds), then a re-measure makes each pane read the correction again.
		const page = emptyPage("two-panes");
		page.strokes = src;
		const file = JSON.parse(serializePage(page)) as { strokes: Array<{ lineAnchor?: { line: number; key: number } }> };
		written.push(file.strokes[0]!.lineAnchor);
		measure(cur.heights.map((x) => x));
	}
	const after = surfaces.map((a) => a.dyOf(s));
	for (const a of surfaces) a.detached();
	return { before, after, written };
}

describe("ink remembers its line with two panes on one note", () => {
	it("one pane: a line break above the ink moves its anchor one line and no ink", () => {
		const r = run(1, [-1]);
		expect(r.before).toEqual([-6]);
		expect(r.written[0]?.line, "written on the line holding its words").toBe(7);
		expect(r.written[0]?.key).toBe(lineKey("line 6 words"));
		expect(r.after, "typing moved no ink").toEqual([-6]);
	});

	it("two panes, neither focused: the shared anchor moves once and the ink stays in both", () => {
		const r = run(2, [-1]);
		expect(r.before).toEqual([-6, -6]);
		expect(r.written[0]?.line, "written on the line holding its words").toBe(7);
		expect(r.written[0]?.key).toBe(lineKey("line 6 words"));
		expect(r.after, "typing moved no ink in either pane").toEqual([-6, -6]);
	});

	it("two panes, typing in each in turn: every line break moves the shared anchor once and the ink stays in both", () => {
		const r = run(2, [0, 1, 1, 0]);
		expect(r.before).toEqual([-6, -6]);
		expect(r.written.map((w) => w?.line), "written on the line holding its words after each break").toEqual([7, 8, 9, 10]);
		for (const w of r.written) expect(w?.key).toBe(lineKey("line 6 words"));
		expect(r.after, "typing moved no ink in either pane").toEqual([-6, -6]);
	});

	it("three panes, typing in the second: the shared anchor moves once", () => {
		const r = run(3, [1, 2]);
		expect(r.written.map((w) => w?.line)).toEqual([7, 8]);
		expect(r.after).toEqual([-6, -6, -6]);
	});

	it("two panes: a line break typed in one, then focus in the other before the page is written: the other reads the anchor through the typing", () => {
		const cur = { doc: lines(30), heights: [34, ...Array.from({ length: 29 }, () => 40)] };
		let layout = layoutOf(cur.doc, Array.from({ length: 30 }, () => 40));
		let focus = 0;
		const [a, b] = [0, 1].map((i) => {
			const p = new LineAnchors(() => layout, () => focus === i);
			p.setSignature(SIG);
			return p;
		}) as [LineAnchors, LineAnchors];
		const s = strokeAt("s", 10, 205), src = [s];
		a.anchorNew(PATH, s);
		for (const p of [a, b]) {
			p.tracks(PATH, src);
			p.drawn(1, cur.doc.lines);
		}
		// Line 1 measured 6 shorter: the stroke shows 6 up, with its line, in both panes.
		layout = layoutOf(cur.doc, cur.heights);
		for (const p of [a, b]) {
			p.layoutChanged(PATH, src);
			p.drawn(1, cur.doc.lines);
		}
		expect([a.dyOf(s), b.dyOf(s)]).toEqual([-6, -6]);
		// A line break at the end of line 1, typed in the first pane; the second hears it after.
		const prev = cur.doc, changes = ChangeSet.of({ from: prev.line(1).to, insert: "\n" }, prev.length), next = changes.apply(prev);
		cur.doc = next;
		cur.heights = [34, 40, ...cur.heights.slice(1)];
		layout = layoutOf(next, cur.heights);
		for (const p of [a, b]) {
			p.docChanged(PATH, src, prev, changes, next);
			p.drawn(p.changedLines.from, p.changedLines.to, false);
		}
		// Focus moves to the second pane with no document change, then a layout update there reads every correction again.
		focus = 1;
		b.layoutChanged(PATH, src);
		expect(b.dyOf(s), "the ink stays on its words in the pane focus moved to").toBe(-6);
		a.layoutChanged(PATH, src);
		expect(a.dyOf(s), "and in the pane it was typed in").toBe(-6);
		const page = emptyPage("two-panes");
		page.strokes = src;
		const file = JSON.parse(serializePage(page)) as { strokes: Array<{ lineAnchor?: { line: number; key: number } }> };
		expect(file.strokes[0]!.lineAnchor?.line, "written on the line holding its words").toBe(7);
		expect(file.strokes[0]!.lineAnchor?.key).toBe(lineKey("line 6 words"));
		a.detached();
		b.detached();
	});
});
