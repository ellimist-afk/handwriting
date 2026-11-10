/**
 * Regression guard: a group member in the unsure set, as the shown-list build reads it. A member never enters the
 * corrected set by its own anchor; it is shown as its group's copy. Green at the base it was written against; it names
 * the defect that must turn it red.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { bumpInkRevision } from "../ink/StrokeRev";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const PATH = "line-anchor-unsure-members.md";
const LINES = 40;
const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

const word = "line 3 words";
const record = (): AttachmentRecord => {
	const from = DOC.indexOf(word);
	return { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(DOC, from, from + word.length, "range"), ref: { x: 0, y: 80 }, layout: { width: 892, font: 26 }, probe: { id: "s1", x: 10, y: 89 } };
};

type Inside = { unsure: Set<InkStroke>; corrected: Set<InkStroke>; dys: Map<InkStroke, unknown>; wholeAt: number; epoch: number };

/** Two members of a read group and one free stroke, every list read once, so the next build takes the unsure path. */
function setup() {
	const state = { shift: 0 };
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40 + state.shift, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	const list = [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90), strokeAt("free", 10, 205)];
	for (const s of list) anchors.anchorNew(PATH, s);
	anchors.strokesFor(PATH, list);
	anchors.follow.setList([record()]);
	anchors.follow.measure({ inView: () => true, refAt: () => ({ x: 6, y: 92 }), blockTop: () => 80 });
	anchors.strokesFor(PATH, list);
	return { anchors, list, state, inside: anchors as unknown as Inside };
}

describe("a member in the unsure set, as the shown-list build reads it", () => {
	it("a member with a stale own anchor stays out of the corrected set, its memo untouched, shown as its group's copy", () => {
		// Defect: the build reads a member by its own anchor, so it enters the corrected set and is patched apart from its group.
		const { anchors, list, state, inside } = setup();
		const s1 = list[0]!;
		state.shift = 80;
		inside.unsure.add(s1);
		const memo = inside.dys.get(s1);
		expect(inside.wholeAt, "premise: the build takes the unsure path").toBe(inside.epoch);
		bumpInkRevision();
		const shown = anchors.strokesFor(PATH, list);
		expect(inside.unsure.size, "the unsure set is read").toBe(0);
		expect(inside.corrected.has(s1), "the member is not in the corrected set").toBe(false);
		expect(inside.dys.get(s1), "the member's memo is untouched").toBe(memo);
		expect(shown[0], "the member is shown as its group's copy").toBe(anchors.follow.shown(s1));
		expect(shown[0]!.bbox.x).toBeCloseTo(s1.bbox.x + 6, 9);
		expect(shown[0]!.bbox.y).toBeCloseTo(s1.bbox.y + 12, 9);
	});
});
