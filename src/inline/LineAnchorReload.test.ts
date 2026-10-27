/**
 * A note reloaded from its file: its anchors come back with the line tops the file holds. A line top that was not exact to
 * the places the file keeps must still read a correction of 0 on the lines measured as they were, so the surface shows the
 * store's own list, not copies. The anchor's parts this build does not know are written back as found, and a font size
 * computed with more places than the file keeps still matches.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { emptyPage, parsePage, serializePage } from "../model/PageData";

const PATH = "reload.md";

function layoutOf(doc: Text, heights: number[]): LineLayout {
	const tops = [0];
	for (const h of heights) tops.push(tops.at(-1)! + h);
	return { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => tops[n - 1]!, pxPerWorld: 1 };
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

const doc = Text.of(Array.from({ length: 30 }, (_, i) => `line ${i + 1} words`));
// Line heights with more places than a file keeps: every line top past the first is fractional.
const heights = Array.from({ length: 30 }, () => 40.123456);

function surface(fontPx: number): LineAnchors {
	const layout = layoutOf(doc, heights);
	const a = new LineAnchors(() => layout);
	a.setSignature({ width: 892, fontPx, charWidth: 14 });
	return a;
}

function reload(strokes: InkStroke[], edit?: (file: { strokes: Array<{ lineAnchor?: Record<string, unknown> }> }) => void): InkStroke[] {
	const page = emptyPage("reload");
	page.strokes = strokes;
	const file = JSON.parse(serializePage(page)) as { strokes: Array<{ lineAnchor?: Record<string, unknown> }> };
	edit?.(file);
	return parsePage(JSON.stringify(file), "reload").data.strokes;
}

describe("ink remembers its line after a reload", () => {
	it("an anchor on a fractional line top reads 0 after a reload, and the surface shows the store's own list", () => {
		const before = surface(26);
		const src = [5, 9, 17].map((n, i) => strokeAt(`s${i}`, 10, heights[0]! * (n - 1) + 3));
		for (const s of src) before.anchorNew(PATH, s);
		before.tracks(PATH, src);
		for (const s of src) expect(before.dyOf(s)).toBe(0);
		before.detached();
		const back = reload(src);
		for (const s of back) expect(s.lineAnchor, `${s.id} keeps its anchor`).toBeDefined();
		const after = surface(26);
		after.tracks(PATH, back);
		after.drawn(1, doc.lines);
		for (const s of back) expect(after.dyOf(s), `${s.id} reads no correction`).toBe(0);
		expect(after.strokesFor(PATH, back), "the store's own list").toBe(back);
		after.detached();
	});

	it("a font size with more places than the file keeps still matches the anchor read back", () => {
		const before = surface(26.6666667);
		const s = strokeAt("s", 10, heights[0]! * 4 + 3);
		before.anchorNew(PATH, s);
		before.detached();
		const [back] = reload([s]);
		const after = surface(26.6666667);
		after.tracks(PATH, [back!]);
		// One line taller above it: the correction is read, so the anchor is honoured under the computed size.
		expect(after.dyOf(back!)).toBe(0);
		after.detached();
		const taller = [heights[0]! + 7, ...heights.slice(1)];
		const moved = new LineAnchors(() => layoutOf(doc, taller));
		moved.setSignature({ width: 892, fontPx: 26.6666667, charWidth: 14 });
		moved.tracks(PATH, [back!]);
		expect(moved.dyOf(back!)).toBeCloseTo(7, 3);
		moved.detached();
	});

	it("parts of an anchor this build does not know are written back as found", () => {
		const s = strokeAt("s", 10, 83);
		s.lineAnchor = { line: 3, top: 80, y: s.bbox.y, key: 1234, width: 892, fontPx: 26 };
		const [back] = reload([s], (file) => {
			file.strokes[0]!.lineAnchor!.later = { kind: "block", id: "abc" };
		});
		const page = emptyPage("reload");
		page.strokes = [back!];
		const file = JSON.parse(serializePage(page)) as { strokes: Array<{ lineAnchor?: Record<string, unknown> }> };
		expect(file.strokes[0]!.lineAnchor).toMatchObject({ line: 3, top: 80, key: 1234, later: { kind: "block", id: "abc" } });
	});
});
