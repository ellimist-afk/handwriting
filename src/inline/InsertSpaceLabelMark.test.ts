/**
 * A label written above a drawing is its own row, not a mark of the drawing: a divider between the two moves the drawing and
 * leaves the label. A floating group is a mark (a dot, a crossbar, an accent) only while it is under half the letter size the
 * editor hands in (its line height in note units). The ratio rule against the host stays, and decides alone when no letter
 * size is handed in: the dot of an i and a full stop still go with their letters (InsertSpace.test.ts and
 * InsertSpacePeriod.test.ts).
 *
 *   1. A title 50..140 x 40..80 over a figure 0..300 x 100..400, a line of body text further down, the editor's letter size
 *      24 handed in, the divider at 90: only the figure moves.
 *   2. The same title and figure alone on the page, the editor's letter size 24 handed in: only the figure moves.
 *   3. A dot of an i above its stem, alone on the page with the letter size handed in: the dot still goes with its stem.
 *   4. The plugin's preview hands the editor's line height in: on a page of the title and figure alone, a hover at 90 lists
 *      the figure as moving and the title as staying. The page has no attached groups, so the overlay's group lookup is
 *      stubbed to none; the rows cache, the list and the line height are the plugin's own.
 *   5. One rows cache over the title and figure alone, asked first with no letter size (the title is the figure's mark and
 *      moves with it), then with one handed in: the rows are read again and only the figure moves. A change of under a
 *      tenth keeps the rows as they are.
 */
import { describe, expect, it } from "vitest";
import { InsertSpaceRows, strokeIdsBelow } from "./InsertSpace";
import { InkOverlayPlugin } from "./InkOverlay";
import { computeBBox, type InkPoint, type InkStroke } from "../ink/Stroke";

const pt = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5, t: 0 });
const stroke = (id: string, points: InkPoint[]): InkStroke =>
	({ id, tool: "pen", color: "#000", width: 2, points, bbox: computeBBox(points, 0), createdAt: 0 });

// "Title" written in four strokes, together 50..140 across and 40..80 down.
const title = [0, 1, 2, 3].map(i => stroke(`title-${i}`, [pt(50 + i * 24, 40), pt(56 + i * 24, 80), pt(62 + i * 24 + 6, 60)]));
// A drawn box with a diagonal, 0..300 across and 100..400 down.
const figure = [
	stroke("fig-top", [pt(0, 100), pt(300, 100)]),
	stroke("fig-right", [pt(300, 100), pt(300, 400)]),
	stroke("fig-bottom", [pt(300, 400), pt(0, 400)]),
	stroke("fig-left", [pt(0, 400), pt(0, 100)]),
	stroke("fig-diag", [pt(0, 100), pt(300, 400)]),
];
// A line of body text far below the figure: letters 8 tall on the line at 600.
const body = [0, 1, 2, 3, 4].map(i => stroke(`body-${i}`, [pt(i * 10, 592), pt(i * 10 + 2, 600), pt(i * 10 + 6, 596)]));
const figureIds = figure.map(s => s.id);

describe("a label above a drawing is not a mark of it", () => {
	it("1: with body text on the page, a divider between title and figure moves the figure only", () => {
		const page = [...title, ...figure, ...body];
		const cache = new InsertSpaceRows();
		cache.letterPx = 24;
		const rows = cache.get(page);
		expect(rows.find(r => r.ids.includes("title-0"))!.ids.some(id => id.startsWith("fig")), "the title is a row of its own").toBe(false);
		expect(strokeIdsBelow(page, 90, rows).filter(id => !id.startsWith("body"))).toEqual(figureIds);
	});

	it("2: title and figure alone, the editor's letter size handed in: the figure moves, the title stays", () => {
		const page = [...title, ...figure];
		const cache = new InsertSpaceRows();
		cache.letterPx = 24;
		expect(strokeIdsBelow(page, 90, cache.get(page))).toEqual(figureIds);
	});

	it("3: a dot alone above its stem, the letter size handed in, still goes with the stem", () => {
		const page = [stroke("i-stem", [pt(30, 88), pt(30, 100)]), stroke("i-dot", [pt(30, 81), pt(31, 82)])];
		const cache = new InsertSpaceRows();
		cache.letterPx = 24;
		const row = cache.get(page).find(r => r.ids.includes("i-stem"))!;
		expect([...row.ids].sort()).toEqual(["i-dot", "i-stem"]);
		const moved = new Set(strokeIdsBelow(page, 85, cache.get(page)));
		expect(moved.has("i-dot")).toBe(moved.has("i-stem"));
	});

	it("4: the plugin's preview hands its line height in: title and figure alone, the figure moves", () => {
		const page = [...title, ...figure];
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		Object.assign(overlay, {
			view: { defaultLineHeight: 36, state: { doc: { length: 0 } } },
			scale: 1.5,
			spacePreview: null,
			strokesHere: () => page,
			spaceGroups: () => undefined,
		});
		const preview = overlay.previewSpace({ y: 90, from: 0, lineHeight: 24 });
		expect(overlay.spaceRowsCache.letterPx, "the editor's line height in note units").toBe(24);
		expect(preview.moving).toEqual(figureIds);
		expect([...preview.staying].filter(id => id.startsWith("title")), "no title stroke is split off a row").toEqual([]);
	});

	it("5: a letter size handed in after a read reads the rows again", () => {
		const page = [...title, ...figure];
		const cache = new InsertSpaceRows();
		const before = cache.get(page);
		expect(strokeIdsBelow(page, 90, before), "premise: with no letter size the title is the figure's mark").toEqual(
			expect.arrayContaining([...figureIds, "title-0"]));
		cache.letterPx = 24;
		const after = cache.get(page);
		expect(strokeIdsBelow(page, 90, after)).toEqual(figureIds);
		cache.letterPx = 25;
		expect(cache.get(page), "a change of under a tenth reads nothing again").toBe(after);
	});
});
