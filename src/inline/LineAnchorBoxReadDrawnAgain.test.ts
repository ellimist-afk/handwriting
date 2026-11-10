/**
 * A line drawn again whose box reads where it did answers its box at once, even when the height map moved under it while
 * it was not drawn. Line 20 carries ink and its box sits 3 px off the height map. The scroll leaves it (a read that finds
 * only line 5 drawn), and while it is not drawn the box still answers, because the map has not moved. A zoom x2 then
 * re-estimates the lines from 10 down by 20 px: the map moved under the box, so the map answers and the ink sits off its
 * text, which is right while the line is not drawn and so not read again. The scroll comes back and the line's box reads
 * where it did: the box must answer again in that read's own update, so the ink lands on its text, and the read must say
 * a shown correction changed so the overlay repaints.
 *
 * Two more reads the same rule makes. A line still drawn across the zoom keeps its box; the first read after the zoom that
 * finds it no longer drawn must say a shown correction changed, since the map moved under its box and now answers. And a
 * line drawn again after the zoom has its map read with its box: left again with the map unmoved since, the box still
 * answers and nothing moves.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const PATH = "box-read-drawn-again.md";
const PX_PER_WORLD = 0.11151960784313726;
const W = 25.5;
const GAP_PX = 3; // line 20's box below its height-map top, px at the first zoom
const EST_PX = 20; // how far the zoom's estimate moves the map for lines 10 and below, px at the second zoom

const doc = Text.of(Array.from({ length: 30 }, (_, i) => `line ${i + 1} words`));
const layoutAt = (zoom: number, est: number): LineLayout => ({
	lines: doc.lines,
	lineText: (n) => doc.line(n).text,
	lineTop: (n) => (n - 1) * W * PX_PER_WORLD * zoom + (n >= 10 ? est : 0),
	pxPerWorld: PX_PER_WORLD * zoom,
	bodyFrom: 1,
});
const before = layoutAt(1, 0);
const after = layoutAt(2, EST_PX);

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

const round = (x: number): number => Math.round(x * 1000) / 1000;
// On its text = the box answers: the ink sits GAP_PX below the map's line top, in world units.
const ON = round(GAP_PX / before.pxPerWorld);
// The map answers after the zoom: the ink moves with the map's line top, in world units.
const MAP = round(after.lineTop(20) / after.pxPerWorld - before.lineTop(20) / before.pxPerWorld);

/** Line 20 inked, anchored and its box read GAP_PX below the first layout's map; the box answers. */
function inkedLine20(get: () => LineLayout): { a: LineAnchors; s: InkStroke; box20: number } {
	const a = new LineAnchors(get);
	a.setSignature({ width: 892, fontPx: 19, charWidth: 10 });
	a.drawn(1, doc.lines);
	const s = strokeAt("line20", 10, 19 * W + 2);
	a.anchorNew(PATH, s);
	a.tracks(PATH, [s]);
	expect(s.lineAnchor?.line, "premise: the stroke anchors on line 20").toBe(20);
	const box20 = (before.lineTop(20) + GAP_PX) / before.pxPerWorld;
	a.boxesRead(PATH, [s], new Map([[20, box20]]), 1);
	expect(round(a.dyOf(s)), "premise: at the first box read the box answers and the ink moves onto its text").toBe(ON);
	return { a, s, box20 };
}

describe("a line drawn again reads its box at once after the height map moved under it", () => {
	it("line 20 left undrawn, zoom x2 moves the map under its box, then drawn again: its ink lands on its text in that read", () => {
		let layout = before;
		const a = new LineAnchors(() => layout);
		a.setSignature({ width: 892, fontPx: 19, charWidth: 10 });
		a.drawn(1, doc.lines);
		const s = strokeAt("line20", 10, 19 * W + 2);
		a.anchorNew(PATH, s);
		a.tracks(PATH, [s]);
		expect(s.lineAnchor?.line, "premise: the stroke anchors on line 20").toBe(20);
		// The box of line 20 in world units: GAP_PX below the first layout's map, where the browser painted it.
		const box20 = (before.lineTop(20) + GAP_PX) / before.pxPerWorld;
		a.boxesRead(PATH, [s], new Map([[20, box20]]), 1);
		expect(round(a.dyOf(s)), "premise: at the first box read the box answers and the ink moves onto its text").toBe(ON);

		// The scroll leaves line 20: a read finds only line 5 drawn. The map has not moved, so the box still answers.
		expect(a.boxesRead(PATH, [s], new Map([[5, before.lineTop(5) / before.pxPerWorld]]), 1), "premise: leaving the line moves nothing").toBe(false);
		expect(round(a.dyOf(s)), "premise: undrawn, map unmoved, the box answers").toBe(ON);

		// Zoom x2 with the lines from 10 down re-estimated: the map moved under the box while the line is not drawn.
		layout = after;
		a.layoutChanged(PATH, [s], "transaction");
		const offText = round(a.dyOf(s));
		expect(offText, "premise: undrawn, the map moved under the box, the map answers").not.toBe(ON);

		// The scroll comes back: line 20 is drawn again and its box reads where it did.
		const moved = a.boxesRead(PATH, [s], new Map([[20, box20]]), 1);
		const arrived = round(a.dyOf(s));
		expect({ moved, arrived }, `drawn again, the box answers in this read (was ${offText}, on its text is ${ON})`).toEqual({ moved: true, arrived: ON });
		a.detached();
	});

	it("line 20 still drawn across zoom x2, then a read finds it gone: that read says the map moved under its box", () => {
		let layout = before;
		const { a, s } = inkedLine20(() => layout);

		// Zoom x2 while line 20 is still drawn: the map moved under the box, and a drawn line's box answers.
		layout = after;
		a.layoutChanged(PATH, [s], "transaction");
		expect(round(a.dyOf(s)), "premise: drawn, the box answers across the zoom").toBe(ON);

		// The scroll leaves line 20: the read finds only line 5 drawn. The map moved since its box was read, so the map
		// answers now, and this read must say a shown correction changed.
		const moved = a.boxesRead(PATH, [s], new Map([[5, after.lineTop(5) / after.pxPerWorld]]), 1);
		const dy = round(a.dyOf(s));
		expect({ moved, dy }, `left after the zoom, the map answers (box ${ON}, map ${MAP})`).toEqual({ moved: true, dy: MAP });
		a.detached();
	});

	it("line 20 drawn again after zoom x2, then left again with the map unmoved: its ink stays on its text", () => {
		let layout = before;
		const { a, s, box20 } = inkedLine20(() => layout);
		expect(a.boxesRead(PATH, [s], new Map([[5, before.lineTop(5) / before.pxPerWorld]]), 1), "premise: leaving the line moves nothing").toBe(false);

		layout = after;
		a.layoutChanged(PATH, [s], "transaction");
		expect(round(a.dyOf(s)), "premise: undrawn, the map moved under the box, the map answers").toBe(MAP);
		const back = a.boxesRead(PATH, [s], new Map([[20, box20]]), 1);
		expect({ back, dy: round(a.dyOf(s)) }, "premise: drawn again, the box answers").toEqual({ back: true, dy: ON });

		// The scroll leaves line 20 again. The map has not moved since the read that drew it again, so the box still answers.
		const moved = a.boxesRead(PATH, [s], new Map([[5, after.lineTop(5) / after.pxPerWorld]]), 1);
		const dy = round(a.dyOf(s));
		expect({ moved, dy }, `left again, map unmoved since the last read: the box answers (box ${ON}, map ${MAP})`).toEqual({ moved: false, dy: ON });
		a.detached();
	});
});
