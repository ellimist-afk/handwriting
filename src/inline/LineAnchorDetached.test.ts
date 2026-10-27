/**
 * A surface unmounted and mounted again: while it is unmounted it hears none of the editor's updates, so the text and the
 * line heights may change unheard. Nothing it read before may answer after the remount: older ink is anchored only on
 * heights measured after it, and an anchor on a line whose text changed in between is not honoured.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const PATH = "note.md";

function layoutOf(doc: Text, heights: number[]): LineLayout {
	const tops = [0];
	for (const h of heights) tops.push(tops.at(-1)! + h);
	return { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => tops[n - 1]!, pxPerWorld: 1 };
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

const words = (n: number, first = 1) => Array.from({ length: n }, (_, i) => `line ${i + first} words`);

describe("ink line anchors: a record kept across an unmount", () => {
	for (const unmount of [false, true]) {
		it(unmount ? "unmounted, a line added at the top, remounted scrolled down" : "control: no unmount", () => {
			const doc0 = Text.of(words(8));
			// Lines 2 and 3 wrapped when the kept stroke was written on line 6 (top 280).
			const state = { layout: layoutOf(doc0, [40, 80, 80, 40, 40, 40, 40, 40]) };
			const anchors = new LineAnchors(() => state.layout);
			anchors.setSignature(SIG);
			const old = strokeAt("old", 10, 121), kept = strokeAt("kept", 10, 281), src = [old, kept];
			anchors.tracks(PATH, src);
			anchors.anchorNew(PATH, kept);
			expect(kept.lineAnchor?.line, "the kept stroke is written on line 6").toBe(6);
			// Line 3 unwraps: line 6 moves up 40 and the kept stroke with it.
			state.layout = layoutOf(doc0, [40, 80, 40, 40, 40, 40, 40, 40]);
			anchors.layoutChanged(PATH, src, "measure");
			expect(anchors.dyOf(kept), "the kept stroke moved with its line").toBe(-40);
			if (unmount) {
				// Every line measured, then the surface unmounts before the old-ink pass ran.
				anchors.drawn(1, 8);
				anchors.drawn(1, 8, true, true);
				anchors.detached();
				// Typed while unmounted, never heard: one 40 px line above line 1, so line 6 now holds line 5's words. Line 2's
				// wrap is gone too (now 40).
				const doc1 = Text.of(["new top line", ...words(8)]);
				state.layout = layoutOf(doc1, [40, 40, 40, 40, 40, 40, 40, 40, 40]);
				// Remounted scrolled down: the first measure draws and reads lines 7 to 9 only.
				anchors.drawn(7, 9);
				anchors.drawn(7, 9, true, true);
			} else {
				anchors.drawn(1, 8);
				anchors.drawn(1, 8, true, true);
			}
			const took = anchors.anchorMeasured(PATH, src);
			const truthLine = (() => { for (let n = state.layout.lines; n >= 1; n--) if (state.layout.lineTop(n) <= old.bbox.y) return n; return 1; })();
			if (took > 0) {
				expect(old.lineAnchor!.line, "anchored on the line under it now").toBe(truthLine);
				expect(anchors.dyOf(old), "old ink does not move when it is anchored").toBe(0);
			}
			if (unmount) expect(anchors.dyOf(kept), "remounted, before any layout update: the correction read before the unmount does not answer").toBe(0);
			// The remount's measure brings a layout update: every correction is read again.
			anchors.layoutChanged(PATH, src, "measure");
			if (unmount) expect(anchors.dyOf(kept), "an anchor on a line whose text changed while unmounted is not honoured").toBe(0);
			else expect(anchors.dyOf(kept), "the kept stroke's line kept its words: its anchor is honoured").toBe(-40);
		});
	}
});
