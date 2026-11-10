/**
 * Insert space, a label above a drawing: three more pages, first written as review cells.
 *
 *   RV1. Two labelled drawings and one handwritten word: a title over each figure, the word far below, the editor's letter
 *        size 24 handed in. A divider between the first title and its figure moves the first figure and leaves the first
 *        title.
 *   RV2. A dot-heavy page: four words of letter height, two dots over each, a divider between the dots and the words. Every
 *        dot goes with its word: a dot never leaves its letter. No letter size is handed in, and a letter size taken from the
 *        page's own groups would be a dot's height here.
 *   RV3. The rows cache reads the page again when the letter size it is handed changes: read once with none, then with 24,
 *        the title over the figure alone leaves the figure's row.
 */
import { describe, expect, it } from "vitest";
import { InsertSpaceRows, strokeIdsBelow } from "./InsertSpace";
import { computeBBox, type InkPoint, type InkStroke } from "../ink/Stroke";

const pt = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5, t: 0 });
const stroke = (id: string, points: InkPoint[]): InkStroke =>
	({ id, tool: "pen", color: "#000", width: 2, points, bbox: computeBBox(points, 0), createdAt: 0 });

// InsertSpaceLabelMark's title (50..140 x 40..80) and figure (0..300 x 100..400), shifted down by dy, ids prefixed.
const title = (p: string, dy: number) => [0, 1, 2, 3].map(i => stroke(`${p}title-${i}`, [pt(50 + i * 24, 40 + dy), pt(56 + i * 24, 80 + dy), pt(62 + i * 24 + 6, 60 + dy)]));
const figure = (p: string, dy: number) => [
	stroke(`${p}fig-top`, [pt(0, 100 + dy), pt(300, 100 + dy)]),
	stroke(`${p}fig-right`, [pt(300, 100 + dy), pt(300, 400 + dy)]),
	stroke(`${p}fig-bottom`, [pt(300, 400 + dy), pt(0, 400 + dy)]),
	stroke(`${p}fig-left`, [pt(0, 400 + dy), pt(0, 100 + dy)]),
	stroke(`${p}fig-diag`, [pt(0, 100 + dy), pt(300, 400 + dy)]),
];
// One handwritten word of letter height 40, three strokes, 400..460 across.
const word = (p: string, x0: number, y0: number) => [0, 1, 2].map(i => stroke(`${p}word-${i}`, [pt(x0 + i * 20, y0), pt(x0 + i * 20 + 6, y0 + 40), pt(x0 + i * 20 + 14, y0 + 20)]));

describe("insert space, a label above a drawing: more pages", () => {
	it("RV1: two labelled drawings and a word: a divider under the first title moves the first figure, not the first title", () => {
		const page = [...title("a-", 0), ...figure("a-", 0), ...title("b-", 500), ...figure("b-", 500), ...word("w-", 400, 1100)];
		const cache = new InsertSpaceRows();
		cache.letterPx = 24;
		const rows = cache.get(page);
		const titleRow = rows.find(r => r.ids.includes("a-title-0"))!;
		expect(titleRow.ids.some(id => id.startsWith("a-fig")), "the first title is a row of its own").toBe(false);
		const moved = new Set(strokeIdsBelow(page, 90, rows));
		expect(page.filter(s => s.id.startsWith("a-title")).filter(s => moved.has(s.id)).map(s => s.id), "no first-title stroke moves").toEqual([]);
		expect(page.filter(s => s.id.startsWith("a-fig")).every(s => moved.has(s.id)), "the first figure moves").toBe(true);
	});

	it("RV2: a dot-heavy page: every dot goes with its word when the divider runs between them", () => {
		const page: InkStroke[] = [];
		for (let k = 0; k < 4; k++) {
			const x0 = 20 + k * 160;
			page.push(...[0, 1, 2, 3, 4].map(j => stroke(`w${k}-l${j}`, [pt(x0 + j * 10, 260), pt(x0 + j * 10 + 3, 300), pt(x0 + j * 10 + 7, 280)])));
			page.push(stroke(`w${k}-dotA`, [pt(x0 + 1, 250), pt(x0 + 2, 252)]), stroke(`w${k}-dotB`, [pt(x0 + 41, 250), pt(x0 + 42, 252)]));
		}
		const rows = new InsertSpaceRows().get(page);
		const moved = new Set(strokeIdsBelow(page, 255, rows));
		const split: string[] = [];
		for (let k = 0; k < 4; k++) for (const d of ["dotA", "dotB"]) if (moved.has(`w${k}-${d}`) !== moved.has(`w${k}-l0`)) split.push(`w${k}-${d}`);
		expect(split, "dots that left their word").toEqual([]);
	});

	it("RV3: the cache reads the page again when the letter size handed in changes", () => {
		const page = [...title("", 0), ...figure("", 0)];
		const cache = new InsertSpaceRows();
		cache.get(page);
		cache.letterPx = 24;
		expect(strokeIdsBelow(page, 90, cache.get(page))).toEqual(figure("", 0).map(s => s.id));
	});
});
