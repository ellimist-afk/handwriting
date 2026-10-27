/**
 * Ink beside a folded heading stays on the heading when the fold opens (LineAnchor.ts, lineUnder).
 *
 * A fold hides the lines under a heading inside the heading's own block: CodeMirror's height map gives each hidden line the
 * heading's top. The halving that finds the line under a stroke kept the last line of such a run of equal tops, a hidden
 * line, so ink written beside the closed heading was anchored to the fold's last line and showed there once the fold opened.
 * The line under a height is now the first line of its run, the heading the reader sees.
 *
 * The layout is a stand-in for CodeMirror's: each line's top in editor px, as the overlay reads the height map.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, aboveOf, lineKey, lineUnder, newAboveRun, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const PATH = "note.md";

/** A layout over `doc` whose line n starts at `tops[n - 1]` editor px; `bottom` is the end of the last line. */
function layoutAt(doc: Text, tops: number[], bottom: number): LineLayout {
	return {
		lines: doc.lines,
		lineText: (n) => doc.line(n).text,
		lineTop: (n) => (n > doc.lines ? bottom : tops[n - 1]!),
		pxPerWorld: 1,
	};
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

describe("ink beside a folded heading", () => {
	it("find the first line of a run of equal tops, and the last line of a document with none", () => {
		// Line 2 is a heading whose fold hides lines 3 to 5; each 20 px line.
		const tops = [0, 20, 20, 20, 20, 40, 60];
		const top = (n: number) => tops[n - 1]!;
		expect(lineUnder(25, 7, top), "beside the closed heading: the heading, not the fold's last hidden line").toBe(2);
		expect(lineUnder(20, 7, top), "at the heading's top").toBe(2);
		expect(lineUnder(10, 7, top)).toBe(1);
		expect(lineUnder(45, 7, top)).toBe(6);
		expect(lineUnder(-5, 7, top), "above the first top").toBe(1);
		expect(lineUnder(500, 7, top), "below the last top").toBe(7);
		expect(lineUnder(5, 3, () => 0), "every line one top: the first").toBe(1);
	});

	it("keep ink written beside a closed heading on the heading when the fold opens", () => {
		const doc = Text.of(["intro", "# Heading", "hidden one", "hidden two", "hidden three", "after", "end"]);
		const state = { layout: layoutAt(doc, [0, 20, 20, 20, 20, 40, 60], 80) };
		const anchors = new LineAnchors(() => state.layout);
		anchors.setSignature(SIG);
		const s = strokeAt("s", 300, 20);
		anchors.anchorNew(PATH, s);
		expect(s.lineAnchor!.line, "anchored to the heading").toBe(2);
		expect(s.lineAnchor!.top).toBe(20);
		// The fold opens: the hidden lines take their own 20 px each and the lines below move down 60 px.
		state.layout = layoutAt(doc, [0, 20, 40, 60, 80, 100, 120], 140);
		anchors.layoutChanged(PATH, [s], "measure");
		expect(anchors.dyOf(s), "the heading did not move, so the ink does not").toBe(0);
		expect(anchors.strokesFor(PATH, [s])[0]!.bbox.y, "shown at its page position, beside the heading").toBe(s.bbox.y);
	});

	it("re-take an anchor on a fold's hidden line to the heading when a change above re-takes the lines below it", () => {
		// An anchor an earlier build took on the fold's last hidden line, and a stroke on the heading itself.
		const doc = Text.of(["intro", "# Heading", "hidden one", "hidden two", "hidden three", "after", "end"]);
		const tops = [0, 20, 20, 20, 20, 40, 60];
		const state = { layout: layoutAt(doc, tops, 80) };
		const anchors = new LineAnchors(() => state.layout);
		anchors.setSignature(SIG);
		const heading = strokeAt("h", 10, 20), old = strokeAt("o", 300, 20);
		anchors.anchorNew(PATH, heading);
		old.lineAnchor = {
			line: 5, top: 20, y: old.bbox.y, key: lineKey("hidden three"), width: SIG.width, fontPx: SIG.fontPx,
			above: aboveOf(newAboveRun(), 5, (k) => lineKey(doc.line(k).text)),
		};
		const src = [heading, old];
		anchors.layoutChanged(PATH, src, "measure");
		expect(anchors.dyOf(old), "the earlier build's anchor is honoured where it stands").toBe(0);
		// A line typed at the top, never drawn, laid out under the editor's guess of no height: every anchor below it is re-taken
		// at once from where its stroke is shown, which typing does not move. The heading is line 3 now, the fold lines 4 to 6.
		const changes = ChangeSet.of({ from: 0, insert: "new\n" }, doc.length), after = changes.apply(doc);
		state.layout = layoutAt(after, [0, 0, 20, 20, 20, 20, 40, 60], 80);
		anchors.docChanged(PATH, src, doc, changes, after);
		expect(anchors.changePaths.eager, "the change took the eager re-take").toBeGreaterThan(0);
		expect(heading.lineAnchor!.line, "the heading, one line down, where its stroke is shown").toBe(3);
		expect(old.lineAnchor!.line, "the hidden line's anchor moves to the heading the reader sees").toBe(3);
		expect(old.lineAnchor!.top).toBe(20);
		expect(anchors.dyOf(old), "and shows where it showed").toBe(0);
	});
});
