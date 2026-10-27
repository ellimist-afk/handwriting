/**
 * A stroke erased, a line break typed above where it was, and the erase undone, with the change put on the shift log rather
 * than re-taken at once: every line was drawn and measured after the line above grew, so the record says what the changed
 * line gained.
 *
 * A fold, explicit or from the changed list, applies the logged change only to the strokes of the last list read. The erased
 * stroke was not in it, so once the log empties its anchor never applies the line break: back in the list, it reads the line
 * that moved up into its place, and shows at its page position instead of where it was. The control keeps the stroke in
 * the list throughout.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const PATH = "undo-after-fold-logged.md";

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
 * The shared steps: ink on line 10 and line 15; line 1 measured 30 px taller, so both are shown 30 lower; then, with the
 * line 10 stroke in the list or erased from it, a line break typed at the end of line 1 and the log folded. Returns the
 * correction the line 10 stroke shows once it is in the list again.
 */
function run(erased: boolean, folded = true): number {
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

	// The line above is measured taller: both strokes follow their lines.
	const taller = heights.map((h, i) => (i === 0 ? h + 30 : h));
	state.layout = layoutOf(before, taller);
	anchors.layoutChanged(PATH, both, "measure");
	// Every line drawn and measured again at its new height, so the line break below goes on the log.
	anchors.drawn(1, 20);
	anchors.drawn(1, 20, true, true);
	if (anchors.dyOf(s) !== 30) throw new Error(`premise: shown 30 lower before the erase, got ${anchors.dyOf(s)}`);

	// The line 10 stroke is erased (or not), and a line break is typed at the end of line 1.
	const list = erased ? [t] : both;
	anchors.strokesFor(PATH, list);
	const changes = ChangeSet.of({ from: before.line(1).to, insert: "\n" }, before.length);
	const after = changes.apply(before);
	state.layout = layoutOf(after, [...taller, 40]);
	anchors.docChanged(PATH, list, before, changes, after);
	anchors.drawn(anchors.changedLines.from, anchors.changedLines.to, false);
	anchors.drawn(anchors.changedLines.from, anchors.changedLines.to, false, true);
	anchors.layoutChanged(PATH, list, "measure");
	if (anchors.changePaths.eager !== 0 || anchors.pendingShifts === 0) throw new Error(`premise: the line break is on the log, got ${JSON.stringify(anchors.changePaths)}`);
	// The log is folded: as on a full log, another note, or before a page is written.
	if (folded) anchors.fold();

	// Undo of the erase: the stroke is in the list again.
	anchors.strokesFor(PATH, both);
	anchors.layoutChanged(PATH, both);
	return anchors.dyOf(s);
}

describe("a stroke erased while a logged line break is typed above it, then brought back by undo after a fold", () => {
	it("control: kept in the list throughout, it shows where it was", () => {
		expect(run(false)).toBe(30);
	});

	it("erased and brought back with no explicit fold: the list change folds the log too, and it shows where it was", () => {
		expect(run(true, false)).toBe(30);
	});

	it("brought back by undo, it shows where it was before the erase", () => {
		expect(run(true), "correction after the undo").toBe(30);
	});
});
