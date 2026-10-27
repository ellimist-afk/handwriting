/**
 * What the line anchors keep of strokes that leave the note's list, so an undo can bring them back where they were, and
 * what that costs at a list change.
 *
 * A committed stroke only adds to the list: nothing is compared by id and nothing is kept. An erase keeps exactly the
 * strokes it took out; the same list read again as new objects of the same ids (a reload) keeps nothing more; an undo
 * that puts them back keeps nothing. Counts, not timings, so the cells hold under any load.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const PATH = "gone-strokes-kept.md";
const LINES = 200;

function layoutOf(doc: Text): LineLayout {
	return { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 };
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

function setup(n: number) {
	const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));
	const anchors = new LineAnchors(() => layoutOf(doc));
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	const list: InkStroke[] = [];
	for (let i = 0; i < n; i++) {
		const s = strokeAt(`s${i}`, 10 + (i % 7) * 30, (i % LINES) * 40 + 5);
		anchors.anchorNew(PATH, s);
		list.push(s);
	}
	anchors.strokesFor(PATH, [...list]);
	return { anchors, list };
}

describe("strokes kept after they leave the note's list", () => {
	it("a committed stroke compares nothing by id and keeps nothing", () => {
		const { anchors, list } = setup(1000);
		for (let i = 0; i < 10; i++) {
			const s = strokeAt(`new${i}`, 20, i * 40 + 5);
			anchors.anchorNew(PATH, s);
			list.push(s);
			anchors.strokesFor(PATH, [...list]);
		}
		expect(anchors.goneScanned).toBe(0);
		expect(anchors.goneCount).toBe(0);
	});

	it("an erase keeps what it took out, a reload keeps no more, and the undo keeps nothing", () => {
		const { anchors, list } = setup(1000);
		const erased = list.slice(400, 403);
		const after = [...list.slice(0, 400), ...list.slice(403)];
		anchors.strokesFor(PATH, after);
		expect(anchors.goneCount).toBe(3);
		expect(anchors.goneScanned, "only the strokes between the parts the erase left alone").toBe(3);
		const copies = after.map((s) => ({ ...s }));
		anchors.strokesFor(PATH, copies);
		expect(anchors.goneCount, "a reload of the same ids").toBe(3);
		anchors.strokesFor(PATH, [...copies.slice(0, 400), ...erased, ...copies.slice(400)]);
		expect(anchors.goneCount, "the undo brought them back").toBe(0);
	});
});
