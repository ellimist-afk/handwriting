/**
 * New ink drawn on a line with no box read yet does not move at the next box read. Once this surface has read line boxes
 * that disagree with the height map, the text is painted off the map; a stroke drawn then is drawn at the painted line,
 * though its anchor was taken under the map, as no box of its line had been read. Its line's first box read takes it
 * again under the box, with no shown move. Ink anchored before any box read follows its box, as before.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const PATH = "box-new-ink.md";
const PX_PER_WORLD = 0.11151960784313726;
const PITCH = 25.5 * PX_PER_WORLD;

const doc = Text.of(Array.from({ length: 30 }, (_, i) => `line ${i + 1} words`));
const layout: LineLayout = { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * PITCH, pxPerWorld: PX_PER_WORLD };

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

function surface(lines: number[]): { a: LineAnchors; src: InkStroke[] } {
	const a = new LineAnchors(() => layout);
	a.setSignature({ width: 892, fontPx: 19, charWidth: 10 });
	const src = lines.map((n) => strokeAt(`s${n}`, 10, (n - 1) * 25.5 + 2));
	for (const s of src) a.anchorNew(PATH, s);
	a.tracks(PATH, src);
	a.drawn(1, doc.lines);
	for (const s of src) expect(s.lineAnchor?.line, `premise: ${s.id} anchors on its line`).toBe(Number(s.id.slice(1)));
	for (const s of src) expect(a.dyOf(s), `premise: ${s.id} reads no correction`).toBe(0);
	return { a, src };
}

function boxTops(lines: number[], gapPx: (n: number) => number): Map<number, number> {
	return new Map(lines.map((n) => [n, (layout.lineTop(n) + gapPx(n)) / PX_PER_WORLD]));
}

describe("new ink drawn on a line with no box read yet does not move at the next box read", () => {
	it("line 3 read 3 px off the map, a stroke drawn on line 9, both lines read with the same gap: the new stroke stays", () => {
		// Defect: the new stroke's anchor top is line 9's height-map top, and the first box read of line 9 moves it by the
		// 3 px the painted line was already off the map when it was drawn.
		const { a, src } = surface([3]);
		a.boxesRead(PATH, src, boxTops([3], () => 3), 1);
		expect(a.dyOf(src[0]!) * PX_PER_WORLD, "premise: line 3's ink follows its box").toBeCloseTo(3, 6);
		const s9 = strokeAt("s9", 10, 8 * 25.5 + 2);
		a.anchorNew(PATH, s9);
		const all = [...src, s9];
		a.tracks(PATH, all);
		expect(a.dyOf(s9), "premise: drawn at its shown place").toBe(0);
		a.boxesRead(PATH, all, boxTops([3, 9], () => 3), 2);
		expect(a.dyOf(s9) * PX_PER_WORLD).toBeCloseTo(0, 6);
		expect(a.dyOf(src[0]!) * PX_PER_WORLD, "control: line 3 still follows its box").toBeCloseTo(3, 6);
		a.detached();
	});

	it("control: with no box read before it, ink drawn on a line follows its box at the first read", () => {
		const { a, src } = surface([20]);
		expect(a.boxesRead(PATH, src, boxTops([20], () => -3), 1)).toBe(true);
		expect(a.dyOf(src[0]!) * PX_PER_WORLD).toBeCloseTo(-3, 6);
		a.detached();
	});
});
