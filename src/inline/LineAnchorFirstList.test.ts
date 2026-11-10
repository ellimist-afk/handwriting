/**
 * A note's first anchored list (the list before it empty, or every stroke new) is read at the pass that marks it, so
 * the next shown-list build reads none of it again: on a large note that build runs inside a pen release. A layout
 * change after that pass still moves the ink by the new layout. Each cell names the defect that must turn it red.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { bumpInkRevision } from "../ink/StrokeRev";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const PATH = "line-anchor-first-list.md";
const LINES = 40;
const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

type Inside = { unsure: Set<InkStroke>; wholeAt: number; epoch: number };

/** Strokes anchored by one surface, then opened on a fresh one whose list was empty first, as a note's ink loads. */
function setup() {
	const state = { shift: 0 };
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40 + state.shift, pxPerWorld: 1 });
	const author = new LineAnchors(layout);
	author.setSignature(SIG);
	author.drawn(1, LINES);
	author.drawn(1, LINES, true, true);
	const list = Array.from({ length: 12 }, (_, i) => strokeAt(`s${i}`, 10 + i * 30, 85 + (i % 6) * 40));
	for (const s of list) author.anchorNew(PATH, s);
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	anchors.strokesFor(PATH, []);
	return { anchors, list, state, inside: anchors as unknown as Inside };
}

describe("a note's first anchored list is read at the pass that marks it", () => {
	it("the next build reads none of it: nothing is left unsure, and the build visits the corrected strokes only", () => {
		// Defect: the pass marks every stroke unsure and the next build (a pen release) reads them all.
		const { anchors, list, state, inside } = setup();
		state.shift = 40;
		bumpInkRevision();
		expect(anchors.tracks(PATH, list), "premise: the note has anchored ink").toBe(true);
		expect([inside.unsure.size, inside.wholeAt === inside.epoch], "after the pass: nothing unsure, the set whole").toEqual([0, true]);
		const n = anchors.strokesForCounts, visited = n.visited, fullReads = n.fullReads;
		const shown = anchors.strokesFor(PATH, list);
		expect([n.visited - visited - list.length, n.fullReads - fullReads], "the build visits the corrected strokes only, no full read").toEqual([0, 0]);
		expect(shown[0]!.bbox.y, "shown under the layout the pass read").toBeCloseTo(list[0]!.bbox.y + 40, 9);
	});

	it("a layout change after the pass moves the ink by the new layout", () => {
		// Defect: the pass's early read is kept past a layout change, so the ink shows where the old layout put it.
		const { anchors, list, state } = setup();
		state.shift = 40;
		bumpInkRevision();
		anchors.tracks(PATH, list);
		state.shift = 80;
		anchors.layoutChanged(PATH, list, "measure");
		const shown = anchors.strokesFor(PATH, list);
		for (let i = 0; i < list.length; i++) expect(shown[i]!.bbox.y, `stroke ${i} under layout 2`).toBeCloseTo(list[i]!.bbox.y + 80, 9);
	});
});
