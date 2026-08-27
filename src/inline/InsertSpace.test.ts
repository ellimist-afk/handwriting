import { describe, expect, it } from "vitest";
import {
	blankLinesAbove,
	boundsOf,
	lineSteps,
	rowsOf,
	snapLine,
	strokeIdsBelow,
	sweptRect,
} from "./InsertSpace";
import { InkPoint, InkStroke, computeBBox } from "../ink/Stroke";

function pt(x: number, y: number): InkPoint {
	return { x, y, pressure: 0.5, t: 0 };
}

function stroke(id: string, points: InkPoint[]): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000",
		width: 2,
		points,
		bbox: computeBBox(points, 0),
		createdAt: 0,
	};
}

/** A letter body sitting on a writing line, no ascender. */
function letter(id: string, x: number, lineY: number): InkStroke {
	return stroke(id, [pt(x, lineY - 8), pt(x + 2, lineY), pt(x + 6, lineY - 4)]);
}

describe("rowsOf", () => {
	it("groups a line of writing into one row", () => {
		const row = [letter("a", 0, 100), letter("b", 10, 100), letter("c", 20, 100)];
		const rows = rowsOf(row);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.ids.sort()).toEqual(["a", "b", "c"]);
	});

	it("keeps a dotted i whole: the dot joins its stem's row", () => {
		// The reported bug. The dot sits well above the stem's centre, so
		// any per-stroke rule can put the two on opposite sides of a line.
		const stem = stroke("i-stem", [pt(30, 88), pt(30, 100)]);
		const dot = stroke("i-dot", [pt(30, 81), pt(31, 82)]);
		const neighbour = letter("n", 0, 100);
		const rows = rowsOf([stem, dot, neighbour]);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.ids).toContain("i-dot");
		expect(rows[0]!.ids).toContain("i-stem");
	});

	it("separates two rows written tight against each other", () => {
		const rows = rowsOf([letter("up", 0, 100), letter("down", 0, 130)]);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.ids).toEqual(["up"]);
		expect(rows[1]!.ids).toEqual(["down"]);
	});
});

describe("snapLine", () => {
	const rows = rowsOf([letter("up", 0, 100), letter("down", 0, 200)]);

	it("leaves a line drawn in the gap alone", () => {
		expect(snapLine(rows, 150)).toBe(150);
	});

	it("pushes a line drawn through a row out to its nearer edge", () => {
		// Row "down" spans 192..200; a line at 199 is nearest its bottom.
		expect(snapLine(rows, 199)).toBe(200);
		// ...and one at 193 is nearest its top.
		expect(snapLine(rows, 193)).toBe(192);
	});
});

describe("strokeIdsBelow (insert-space membership)", () => {
	it("takes the row below and leaves the row above", () => {
		const strokes = [letter("above", 0, 100), letter("below", 0, 200)];
		expect(strokeIdsBelow(strokes, 150)).toEqual(["below"]);
	});

	it("never splits a letter, wherever the line lands inside a row", () => {
		const stem = stroke("i-stem", [pt(30, 88), pt(30, 100)]);
		const dot = stroke("i-dot", [pt(30, 81), pt(31, 82)]);
		const neighbour = letter("n", 0, 100);
		const below = letter("next", 0, 200);
		const page = [stem, dot, neighbour, below];
		// A line drawn between the dot and the stem would once have taken
		// the stem and left the dot behind. Now they cannot be separated:
		// whichever way the row goes, the two travel together.
		const moved = new Set(strokeIdsBelow(page, 85));
		expect(moved.has("i-dot")).toBe(moved.has("i-stem"));
		expect(moved.has("next")).toBe(true);
	});

	it("keeps a word whole when the line crosses its lower half", () => {
		const word = [letter("P", 0, 100), letter("r", 10, 100), letter("i", 20, 100)];
		const below = letter("next", 0, 200);
		// Through the word: the line snaps out of it, so the word is all on
		// one side. Which side is the snap's business; never being torn in
		// half is the contract.
		const moved = new Set(strokeIdsBelow([...word, below], 98));
		expect(moved.has("P")).toBe(moved.has("r"));
		expect(moved.has("r")).toBe(moved.has("i"));
		expect(moved.has("next")).toBe(true);
	});

	it("empty page yields an empty list", () => {
		expect(strokeIdsBelow([], 50)).toEqual([]);
	});

	it("returns ids in store order", () => {
		const strokes = [letter("b", 0, 200), letter("a", 10, 200), letter("skip", 0, 50)];
		expect(strokeIdsBelow(strokes, 150)).toEqual(["b", "a"]);
	});
});

describe("boundsOf", () => {
	it("unions only the named strokes", () => {
		const strokes = [letter("a", 0, 100), letter("b", 0, 200), letter("ignored", 0, 900)];
		const b = boundsOf(strokes, ["a", "b"]);
		expect(b).not.toBeNull();
		expect(b!.y).toBe(92);
		expect(b!.y + b!.height).toBe(200);
	});

	it("is null when nothing is named, so the caller can fall back", () => {
		expect(boundsOf([letter("a", 0, 10)], [])).toBeNull();
		expect(boundsOf([], ["ghost"])).toBeNull();
	});
});

describe("sweptRect", () => {
	const box = { x: 0, y: 100, width: 50, height: 20 };

	it("covers old and new positions when dragging down", () => {
		const r = sweptRect(box, 30);
		expect(r.y).toBe(100);
		expect(r.y + r.height).toBe(150);
	});

	it("covers old and new positions when dragging up", () => {
		const r = sweptRect(box, -30);
		expect(r.y).toBe(70);
		expect(r.y + r.height).toBe(120);
	});

	it("degenerates to the box itself at zero travel", () => {
		expect(sweptRect(box, 0)).toEqual(box);
	});
});

describe("lineSteps", () => {
	it("rounds a drag to the nearest whole line", () => {
		expect(lineSteps(44, 20)).toBe(2);
		expect(lineSteps(29, 20)).toBe(1);
		expect(lineSteps(31, 20)).toBe(2);
	});

	it("is zero for a drag shorter than half a line, so text is left alone", () => {
		expect(lineSteps(9, 20)).toBe(0);
	});

	it("goes negative when the drag closes a gap", () => {
		expect(lineSteps(-42, 20)).toBe(-2);
	});

	it("refuses to divide by a line height it does not have", () => {
		expect(lineSteps(40, 0)).toBe(0);
	});
});

/** The document reader the real caller passes: 1-based line numbers. */
function reader(lines: readonly string[]): (n: number) => string {
	return (n) => lines[n - 1] ?? "";
}

describe("blankLinesAbove", () => {
	const doc = ["alpha", "", "", "beta"];

	it("counts the blank run directly above the line", () => {
		expect(blankLinesAbove(reader(doc), 4, 5)).toBe(2);
	});

	it("never returns more than asked for", () => {
		expect(blankLinesAbove(reader(doc), 4, 1)).toBe(1);
	});

	it("stops at the first line with writing on it", () => {
		expect(blankLinesAbove(reader(doc), 2, 5)).toBe(0);
	});

	it("treats whitespace-only lines as blank", () => {
		expect(blankLinesAbove(reader(["alpha", "   ", "beta"]), 3, 5)).toBe(1);
	});

	it("stops at the top of the document", () => {
		expect(blankLinesAbove(reader(["", "", "beta"]), 3, 9)).toBe(2);
	});
});
