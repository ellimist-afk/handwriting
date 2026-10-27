/**
 * A stroke erased, a line break typed inside its own line, and the erase undone, the change re-taken at once (the eager
 * path) rather than logged.
 *
 * The eager path re-takes the anchors of the list's strokes on the changed lines from where they are shown. The erased
 * stroke is not in the list, so its anchor still names its line as it was before the break: back in the list, it no longer
 * matches that line's text and shows at its page position, 30 px off where it was. The control keeps it in the list.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const PATH = "undo-on-changed-line.md";

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
 * The erased stroke sits on the changed line, and the change takes the eager path. Ink on line 5 and line 15; line 1 measured 30 px taller, so both show 30 lower; line 5 is erased (or kept); a line
 * break is typed INSIDE line 5, so line 5's own text changes; then undo. Returns the correction line 5's stroke shows.
 */
function run(erased: boolean): { dy: number; eager: number } {
	const heights = Array.from({ length: 20 }, () => 40);
	const before = lines(20);
	const state = { layout: layoutOf(before, heights) };
	const anchors = new LineAnchors(() => state.layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, 20);
	anchors.drawn(1, 20, true, true);
	const s = strokeAt("s", 10, 4 * 40 + 5), t = strokeAt("t", 10, 14 * 40 + 5);
	anchors.anchorNew(PATH, s);
	anchors.anchorNew(PATH, t);
	const both = [s, t];
	anchors.tracks(PATH, both);
	const taller = heights.map((h, i) => (i === 0 ? h + 30 : h));
	state.layout = layoutOf(before, taller);
	anchors.layoutChanged(PATH, both, "measure");
	if (anchors.dyOf(s) !== 30) throw new Error(`premise: shown 30 lower before the erase, got ${anchors.dyOf(s)}`);
	const list = erased ? [t] : both;
	anchors.strokesFor(PATH, list);
	const l5 = before.line(5);
	const changes = ChangeSet.of({ from: l5.from + 4, insert: String.fromCharCode(10) }, before.length);
	const after = changes.apply(before);
	state.layout = layoutOf(after, [...taller, 40]);
	anchors.docChanged(PATH, list, before, changes, after);
	const eager = anchors.changePaths.eager;
	anchors.drawn(anchors.changedLines.from, anchors.changedLines.to, false);
	anchors.drawn(anchors.changedLines.from, anchors.changedLines.to, false, true);
	anchors.layoutChanged(PATH, list, "measure");
	anchors.fold();
	anchors.strokesFor(PATH, both);
	anchors.layoutChanged(PATH, both);
	return { dy: anchors.dyOf(s), eager };
}

describe("a stroke erased on the line a line break is typed into, then brought back by undo", () => {
	it("control: kept in the list, it shows where it was", () => {
		const r = run(false);
		expect(r.eager, "premise: eager path").toBe(1);
		expect(r.dy).toBe(30);
	});
	it("erased on the changed line and brought back by undo, it shows where it was", () => {
		const r = run(true);
		expect(r.eager, "premise: eager path").toBe(1);
		expect(r.dy, "correction after the undo").toBe(30);
	});
});
