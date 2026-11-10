/**
 * INSERT SPACE SPLITS A ROW THE LINE CROSSES.
 *
 * A drawing whose strokes overlap from top to bottom is one row. Insert space used to move a crossed row whole when the
 * line lay in its upper half and leave it whole otherwise, so a line drawn through a drawing moved nothing of it, or all
 * of it. Now a crossed row splits stroke by stroke: a stroke moves when its own middle is below the line, and a middle on
 * the line stays. A dot or a full stop the row builder attached to a letter goes with that letter. Rows the line does not
 * cross are unchanged. The hover cache (sameRowSides) reuses a preview only while no stroke's middle lies between the two
 * lines, so the preview is always the set the release moves.
 *
 * Every cell runs through both row builders: the note's (InsertSpaceRows) and the PDF's (rowsOf).
 */
import { describe, expect, it } from "vitest";
import { InsertSpaceRows, rowsOf, sameRowSides, strokeIdsBelow, type InkRow } from "./InsertSpace";
import { computeBBox, type InkPoint, type InkStroke } from "../ink/Stroke";
import { translateStroke } from "../objects/Selection";
import { shiftedStroke } from "./LineAnchor";

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
/** A stroke filling the box left..right by top..bottom, drawn as its outline. */
const box = (id: string, left: number, right: number, top: number, bottom: number): InkStroke =>
	stroke(id, [pt(left, top), pt(right, top), pt(right, bottom), pt(left, bottom), pt(left, top)]);

const BUILDERS: [string, (s: readonly InkStroke[]) => readonly InkRow[]][] = [
	["note rows", (s) => new InsertSpaceRows().get(s)],
	["PDF rows", (s) => rowsOf(s)],
];

/** The ids in crossed rows that do not move: the preview's staying list. */
function staying(rows: readonly InkRow[], y: number, moving: readonly string[]): string[] {
	const m = new Set(moving);
	return rows.filter((r) => r.top < y && r.bottom > y).flatMap((r) => r.ids).filter((id) => !m.has(id)).sort();
}

/**
 * A drawing like a labelled membrane figure: an outer row of writing, a stroke that chains it to a small box with two
 * ions inside, a tall box that crosses the line, and the inner row's strokes below the line, all one row.
 */
function drawing(): InkStroke[] {
	return [
		box("outer", 0, 90, 931, 990),
		box("chain", 40, 46, 960, 1035),
		box("small-box", 0, 60, 1027, 1053),
		box("ion-1", 10, 16, 1038, 1044),
		box("ion-2", 20, 26, 1044, 1050),
		box("tall-box", 30, 70, 1041, 1144),
		box("inner-1", 50, 80, 1058, 1144),
		box("inner-2", 60, 95, 1058, 1144),
	];
}

describe.each(BUILDERS)("a crossed row splits at the line (%s)", (_name, build) => {
	it("a drawing that is one row: the strokes whose middles lie below the line move, the rest stay", () => {
		const strokes = drawing();
		const rows = build(strokes);
		expect(rows.length, "premise: the whole drawing is one row").toBe(1);
		expect(strokeIdsBelow(strokes, 1055, rows)).toEqual(["tall-box", "inner-1", "inner-2"]);
	});

	it("a middle on the line stays, and a stroke whose middle is above stays although its bottom is below", () => {
		const strokes = [box("tie", 0, 10, 90, 110), box("high", 5, 15, 80, 105), box("low", 10, 20, 95, 130)];
		const rows = build(strokes);
		expect(rows.length, "premise: one row").toBe(1);
		expect(strokeIdsBelow(strokes, 100, rows)).toEqual(["low"]);
	});

	it("control: a row wholly below moves whole and a row wholly above stays whole", () => {
		const strokes = [box("up-a", 0, 10, 0, 20), box("up-b", 5, 15, 5, 25), box("down-a", 0, 10, 200, 220), box("down-b", 5, 15, 205, 225)];
		const rows = build(strokes);
		expect(strokeIdsBelow(strokes, 100, rows)).toEqual(["down-a", "down-b"]);
	});
});

describe.each(BUILDERS)("a label high over a tall drawing stays by its own middle (%s)", (_name, build) => {
	it("labels 110 above the line stay while the letters below it move", () => {
		// A drawing 200 high: a frame 100 to 300 and two letters low in it. Two small labels sit over the letters, 10
		// above the frame, so the row builder attaches them to the drawing's row; they are 130 above the letters' tops,
		// more than a letter's own height (40).
		const strokes = [
			box("frame", 0, 20, 100, 300),
			box("letter-1", 100, 120, 220, 260),
			box("letter-2", 125, 145, 220, 260),
			box("label-1", 100, 110, 80, 90),
			box("label-2", 125, 135, 80, 90),
		];
		const rows = build(strokes);
		expect(rows.length, "premise: the labels are in the drawing's row").toBe(1);
		expect(strokeIdsBelow(strokes, 200, rows)).toEqual(["letter-1", "letter-2"]);
	});
});

describe.each(BUILDERS)("a mark goes with its letter (%s)", (_name, build) => {
	it("an i's dot whose middle is above the line moves with its stem, whose middle is below", () => {
		// The row spans 78 to 100, so a line at 91 is in its lower half: the row used to stay whole.
		const strokes = [box("n", 0, 6, 88, 100), stroke("stem", [pt(12, 84), pt(12, 100)]), stroke("dot", [pt(12, 78), pt(13, 79)])];
		const rows = build(strokes);
		expect(rows.length, "premise: the dot is in the letters' row").toBe(1);
		expect(strokeIdsBelow(strokes, 91, rows)).toEqual(["n", "stem", "dot"]);
	});

	it("a tapped full stop whose middle is below the line stays with its word, whose middles are above", () => {
		const letter = (id: string, x: number) => stroke(id, [pt(x, 92), pt(x + 2, 100), pt(x + 6, 96)]);
		const strokes = [letter("e", 0), letter("n", 10), letter("d", 20), stroke("stop", [pt(30, 99), pt(30.01, 99)])];
		const rows = build(strokes);
		expect(rows.length, "premise: the full stop is in the word's row").toBe(1);
		expect(strokeIdsBelow(strokes, 98, rows)).toEqual([]);
	});
});

describe.each(BUILDERS)("the hover cache keeps a preview only while no middle changes side (%s)", (_name, build) => {
	const strokes = [box("tie", 0, 10, 90, 110), box("high", 5, 15, 80, 105), box("low", 10, 20, 95, 130)];

	it("a middle between the two lines: the sides differ", () => {
		expect(sameRowSides(build(strokes), 99, 104)).toBe(false);
	});

	it("no middle between the two lines: the sides are the same", () => {
		expect(sameRowSides(build(strokes), 101, 104)).toBe(true);
	});

	it("every pair of lines the cache calls the same moves the same strokes and keeps the same ones", () => {
		const page = drawing();
		const rows = build(page);
		for (let a = 925; a <= 1150; a += 0.5) {
			for (const b of [a + 0.5, a + 3, a + 11]) {
				if (!sameRowSides(rows, a, b)) continue;
				const atA = strokeIdsBelow(page, a, rows), atB = strokeIdsBelow(page, b, rows);
				expect(atB, `moving at ${a} and ${b}`).toEqual(atA);
				expect(staying(rows, b, atB), `staying at ${a} and ${b}`).toEqual(staying(rows, a, atA));
			}
		}
	});
});

describe.each(BUILDERS)("a mark of several strokes goes as one (%s)", (_name, build) => {
	it("a two-stroke label over a frame and a post either side of the line stays whole", () => {
		// A frame (middle 200, above the line at 215) and a post (middle 230, below it) make one drawing row. A label of
		// two strokes sits just over them, one stroke over each.
		const strokes = [
			box("frame", 0, 40, 100, 300),
			box("post", 60, 110, 130, 330),
			box("label-a", 34, 40, 80, 90),
			box("label-b", 60, 66, 80, 90),
		];
		const rows = build(strokes);
		expect(rows.length, "premise: the label is in the drawing's row").toBe(1);
		const moved = new Set(strokeIdsBelow(strokes, 215, rows));
		expect(moved.has("post") && !moved.has("frame"), "premise: the line splits the drawing").toBe(true);
		expect(moved.has("label-b"), "the label tore: one stroke moved, the other stayed").toBe(moved.has("label-a"));
	});
});

describe.each(BUILDERS)("a mark goes with the letter it sits over, not the first one in its row (%s)", (_name, build) => {
	it("an i's dot over the stem below the line moves, though the row's first letter stays", () => {
		// The first letter (middle 90) stays at a line at 92; the stem (middle 95) moves, and the dot sits over the stem.
		const strokes = [box("first", 0, 6, 84, 96), stroke("stem", [pt(12, 86), pt(12, 104)]), stroke("dot", [pt(12, 80), pt(13, 81)])];
		const rows = build(strokes);
		expect(rows.length, "premise: the dot is in the letters' row").toBe(1);
		expect(strokeIdsBelow(strokes, 92, rows)).toEqual(["stem", "dot"]);
	});
});

describe("the note's row cache, after an insert that moved whole rows", () => {
	it("keeps a full stop with its word when the next line splits that word's row", () => {
		const letter = (id: string, x: number, y: number) => stroke(id, [pt(x, y - 8), pt(x + 2, y), pt(x + 6, y - 4)]);
		// "end." on a line at y 200, below a word on a line at y 100.
		const strokes = [letter("a", 0, 100), letter("e", 0, 200), letter("n", 10, 200), letter("d", 20, 200), stroke("stop", [pt(30, 199), pt(30.01, 199)])];
		const cache = new InsertSpaceRows(), before = cache.get(strokes);
		const ids = strokeIdsBelow(strokes, 150, before);
		expect(ids, "premise: the first insert moves the whole lower row").toEqual(["e", "n", "d", "stop"]);
		for (const s of strokes) if (ids.includes(s.id)) translateStroke(s, 0, 24);
		expect(cache.shift(strokes, before, ids, [24]), "premise: the cache shifts its rows instead of rebuilding").toBe(true);
		// The word now spans 216 to 224, middle 220; the full stop sits at 223. A line at 222 leaves the word.
		expect(strokeIdsBelow(strokes, 222, cache.get(strokes)), "the full stop left its word").toEqual([]);
	});
});

describe("the note's row cache, after a shown copy moved with its store stroke unchanged", () => {
	it("a full stop freed by a group member that moved away joins the drawing and stays with it at every line", () => {
		// A drawing 40 tall, a full stop 35 to its right, and a stroke just past the stop that the stop first joins. The
		// shown copy of that stroke moves 300 down (its store stroke does not), so the cache re-places it instead of
		// reading every stroke again, and the stop now joins the drawing.
		const drawing = stroke("drawing", [pt(0, 0), pt(40, 40), pt(0, 40), pt(40, 0)]);
		const stop = stroke("stop", [pt(75, 20), pt(77, 22)]);
		const near = stroke("near", [pt(85, 15), pt(88, 25), pt(91, 15), pt(93, 25)]);
		const store = [drawing, stop, near];
		const shown = (dy: number) => store.map((s) => (s === near ? shiftedStroke(s, dy) : s));
		const cache = new InsertSpaceRows();
		cache.get(shown(0));
		const after = shown(300);
		const cached = cache.get(after), fresh = new InsertSpaceRows().get(after);
		expect(cache.counts.rebuilds, "premise: the cache re-placed the moved copy, no full rebuild").toBe(1);
		// The drawing's middle is 20, the stop's own 21: a line at 20.5 leaves the drawing, and the stop with it.
		expect(strokeIdsBelow(after, 20.5, fresh).filter((id) => id !== "near"), "premise: a fresh build keeps the stop with the drawing").toEqual([]);
		for (let y = -2; y <= 45; y += 0.5) {
			expect(strokeIdsBelow(after, y, cached), `the cached rows and a fresh build differ at the line ${y}`).toEqual(strokeIdsBelow(after, y, fresh));
		}
	});
});

describe("the hover cache on rows built by hand", () => {
	it("a crossed row with no stroke middles: never the same sides", () => {
		const row: InkRow = { top: 80, bottom: 130, ids: ["tie", "high", "low"] };
		expect(sameRowSides([row], 99, 101)).toBe(false);
	});

	it("control: rows the line does not cross compare as they always did", () => {
		const below: InkRow = { top: 200, bottom: 220, ids: ["x"] };
		const above: InkRow = { top: 0, bottom: 20, ids: ["y"] };
		expect(sameRowSides([below, above], 99, 101)).toBe(true);
		expect(sameRowSides([below], 190, 210)).toBe(false);
	});

	it("a crossed row with no stroke middles still splits by the strokes' own middles", () => {
		const strokes = [box("tie", 0, 10, 90, 110), box("high", 5, 15, 80, 105), box("low", 10, 20, 95, 130)];
		const row: InkRow = { top: 80, bottom: 130, ids: ["tie", "high", "low"] };
		expect(strokeIdsBelow(strokes, 100, [row])).toEqual(["low"]);
	});
});
