/**
 * The note's list replaced by shallow copies of the same strokes while line breaks are on the shift log. A copy shares its
 * anchor object with the stroke it was copied from (a page answered from a queued write is copied so), so the two must not
 * both apply the log to it: a line break applied twice moves the anchor a line too far, and the stroke shows off its words.
 * The control keeps the same objects.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const PATH = "shared-anchor-copies.md";

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

/**
 * The list is replaced by shallow copies of the same strokes (`{ ...st }`, which shares the lineAnchor object), then a second
 * line break is logged and the log folded. Returns line 10's correction plus 1000 times its anchor line; each logged line
 * break must be applied once.
 */
function run(replace: boolean): number {
	const heights = Array.from({ length: 20 }, () => 40);
	const before = lines(20);
	const state = { layout: layoutOf(before, heights) };
	const anchors = new LineAnchors(() => state.layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, 20);
	anchors.drawn(1, 20, true, true);
	const s = strokeAt("s", 10, 9 * 40 + 5), t = strokeAt("t", 10, 14 * 40 + 5);
	anchors.anchorNew(PATH, s);
	anchors.anchorNew(PATH, t);
	const both = [s, t];
	anchors.tracks(PATH, both);
	const taller = heights.map((h, i) => (i === 0 ? h + 30 : h));
	state.layout = layoutOf(before, taller);
	anchors.layoutChanged(PATH, both, "measure");
	anchors.drawn(1, 20);
	anchors.drawn(1, 20, true, true);
	anchors.strokesFor(PATH, both);
	const changes = ChangeSet.of({ from: before.line(1).to, insert: String.fromCharCode(10) }, before.length);
	const after = changes.apply(before);
	state.layout = layoutOf(after, [...taller, 40]);
	anchors.docChanged(PATH, both, before, changes, after);
	anchors.drawn(anchors.changedLines.from, anchors.changedLines.to, false);
	anchors.drawn(anchors.changedLines.from, anchors.changedLines.to, false, true);
	anchors.layoutChanged(PATH, both, "measure");
	if (anchors.changePaths.eager !== 0 || anchors.pendingShifts === 0) throw new Error(`premise: on the log, got ${JSON.stringify(anchors.changePaths)}`);
	const list = replace ? both.map((x) => ({ ...x })) : both;
	anchors.strokesFor(PATH, list);
	// A second line break, logged after the replace: the copies share their anchors with the objects they replaced.
	const before2 = after;
	const changes2 = ChangeSet.of({ from: before2.line(1).to, insert: String.fromCharCode(10) }, before2.length);
	const after2 = changes2.apply(before2);
	state.layout = layoutOf(after2, [...taller, 40, 40]);
	anchors.docChanged(PATH, list, before2, changes2, after2);
	anchors.drawn(anchors.changedLines.from, anchors.changedLines.to, false);
	anchors.drawn(anchors.changedLines.from, anchors.changedLines.to, false, true);
	anchors.layoutChanged(PATH, list, "measure");
	anchors.fold();
	anchors.layoutChanged(PATH, list);
	return anchors.dyOf(list[0]!) + 1000 * (list[0]!.lineAnchor!.line);
}

describe("a list replaced by shallow copies of its strokes while a change is logged", () => {
	it("shallow copies apply the logged change once, as the control does", () => {
		const c = run(false), r = run(true);
		expect(c, "premise: the control applies both line breaks").toBe(12_030);
		expect(r).toBe(c);
	});
});
