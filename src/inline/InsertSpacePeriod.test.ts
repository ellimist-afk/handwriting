import { describe, expect, it } from "vitest";
import { InsertSpaceRows, strokeIdsBelow, rowsOf as pdfRowsOf } from "./InsertSpace";
import { computeBBox, type InkPoint, type InkStroke } from "../ink/Stroke";

/**
 * A tapped full stop is stored as two points
 * at one y, so its height is 0 and the row-joining rule (gap at most 3 times the smaller height)
 * never reaches the word beside it. It becomes its own row, and Insert space moves it away from
 * the word when the divider crosses the lower half of the word.
 *
 * The cells assert the CORRECT behaviour, so they go red only if the finding is real.
 */

const pt = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5, t: 0 });
const stroke = (id: string, points: InkPoint[]): InkStroke => ({
	id,
	tool: "pen",
	color: "#000",
	width: 2,
	points,
	bbox: computeBBox(points, 2),
	createdAt: 0,
});
/** A letter body on a writing line at y = 100: it spans y 92 to 100 and 6 units across. */
const letter = (id: string, x: number): InkStroke => stroke(id, [pt(x, 92), pt(x + 2, 100), pt(x + 6, 96)]);
/** What a tap is stored as: the point and a twin 0.01 to the right. */
const tap = (id: string, x: number, y: number): InkStroke => stroke(id, [pt(x, y), pt(x + 0.01, y)]);

describe("insert space keeps a tapped full stop with its word", () => {
	// "end." : three letters and a full stop 4 units after the last letter, inside the word's band.
	const word = [letter("e", 0), letter("n", 10), letter("d", 20)];
	const strokes = [...word, tap("dot", 30, 99)];

	it("puts the full stop in the same row as the word", () => {
		const rows = new InsertSpaceRows().get(strokes);
		const row = rows.find((r) => r.ids.includes("dot"))!;
		expect([...row.ids].sort()).toEqual(["d", "dot", "e", "n"]);
	});

	it("a divider through the lower half of the word moves neither the word nor its full stop", () => {
		// The word spans y 92 to 100, midpoint 96: a divider at 98 leaves the word where it is.
		const moved = strokeIdsBelow(strokes, 98, new InsertSpaceRows().get(strokes));
		expect(moved, "the full stop must not drop away from the word").toEqual([]);
	});

	it("control: the PDF grouping keeps the full stop with its word", () => {
		expect(strokeIdsBelow(strokes, 98, pdfRowsOf(strokes))).toEqual([]);
	});

	it("control: the word alone is not moved by the same divider", () => {
		expect(strokeIdsBelow(word, 98, new InsertSpaceRows().get(word))).toEqual([]);
	});

	it("control: a full stop far from any word still stands alone", () => {
		const far = [...word, tap("far", 400, 99)];
		const rows = new InsertSpaceRows().get(far);
		const withFar = rows.find((r) => r.ids.includes("far"))!;
		expect(withFar.ids, "a distant mark must not be pulled into the word's row").toEqual(["far"]);
	});
});

/** A tall drawing: one stroke 100 units high, 6 across, starting at x. */
const drawing = (id: string, x: number): InkStroke => stroke(id, [pt(x, 50), pt(x + 3, 150), pt(x + 6, 100)]);
const rowOf = (rows: readonly { readonly ids: readonly string[] }[], id: string): string[] => [...rows.find((r) => r.ids.includes(id))!.ids].sort();

describe("insert space: a mark joins one neighbour only", () => {
	const word = [letter("e", 0), letter("n", 10), letter("d", 20)];

	it("a full stop between its word and a tall drawing joins the word, not the drawing", () => {
		// The drawing starts at x 128: 102 units from the word, beyond the drawing's own height (100) from
		// the letters, but 97.99 from the full stop, so the full stop has two candidates and the word is nearer.
		const strokes = [...word, tap("dot", 30, 99), drawing("tall", 128)];
		const rows = new InsertSpaceRows().get(strokes);
		expect(rowOf(rows, "dot")).toEqual(["d", "dot", "e", "n"]);
		expect(rowOf(rows, "tall"), "the drawing must stay alone").toEqual(["tall"]);
	});

	it("a full stop between its word and a nearer tall drawing: the word keeps its full stop and the drawing stays alone", () => {
		// The drawing starts at x 60: 34 units from the word, beyond the letters' own reach (3 x 8 = 24).
		const strokes = [...word, tap("dot", 30, 99), drawing("tall", 60)];
		const rows = new InsertSpaceRows().get(strokes);
		expect(rowOf(rows, "dot")).toEqual(["d", "dot", "e", "n"]);
		expect(rowOf(rows, "tall"), "the drawing must stay alone").toEqual(["tall"]);
	});

	it("a lone mark beside one tall stroke joins it", () => {
		// "I." : one stroke 12 units high and a tapped full stop 3.5 units after it.
		const strokes = [stroke("I", [pt(0, 88), pt(0.5, 100)]), tap("dot", 4, 99.5)];
		const rows = new InsertSpaceRows().get(strokes);
		expect(rowOf(rows, "dot")).toEqual(["I", "dot"]);
		expect(strokeIdsBelow(strokes, 98, rows), "the full stop must not drop away from the I").toEqual([]);
	});

	it("named limit, pinned: a comma whose tail drops below its word stays its own row and moves alone", () => {
		// The comma spans y 99 to 100.5, past the word's bottom at 100, and sits 5.8 units after it:
		// beyond its own reach (3 x 1.5) and not inside the word's span, so no join of either kind.
		const strokes = [...word, stroke("comma", [pt(32, 99), pt(31.8, 100.5)])];
		const rows = new InsertSpaceRows().get(strokes);
		expect(rowOf(rows, "comma")).toEqual(["comma"]);
		expect(strokeIdsBelow(strokes, 98, rows)).toEqual(["comma"]);
	});
});

describe("insert space: named limits of the mark rule, pinned", () => {
	it("named limit: a one-letter word with no ordinary neighbour, beside a tall drawing, joins it", () => {
		// "a" is 8 high and 6 wide; the drawing is 100 high and 34 units away, beyond the letter's own reach
		// (3 x 8 = 24) but inside the drawing's height: the letter has the lone mark's geometry.
		const strokes = [letter("a", 0), drawing("tall", 40)];
		const rows = new InsertSpaceRows().get(strokes);
		expect(rowOf(rows, "a")).toEqual(["a", "tall"]);
	});

	it("named limit: dots of an ellipsis that join each other are not marks and stay apart from the word, as today", () => {
		// Three dots 1 unit high, 2.5 apart (inside 3 x 1), 4 units after the word: they join each other the
		// ordinary way, so none of them is a mark, and none reaches the word on its own height.
		const dot = (id: string, x: number): InkStroke => stroke(id, [pt(x, 98.5), pt(x + 0.5, 99.5)]);
		const word = [letter("e", 0), letter("n", 10), letter("d", 20)];
		const strokes = [...word, dot("e1", 30), dot("e2", 33), dot("e3", 36)];
		const rows = new InsertSpaceRows().get(strokes);
		expect(rowOf(rows, "e1")).toEqual(["e1", "e2", "e3"]);
		expect(strokeIdsBelow(strokes, 98, rows)).toEqual(["e1", "e2", "e3"]);
	});
});
