/**
 * The cost of a selection's box follows the selection, never the note.
 *
 * Drawing a lasso loop with nothing selected asks for the box of an empty
 * selection on every pen sample. That pass used to read every stroke of the
 * note to find none of them. These cells count reads of the stroke list: a
 * list that throws when it is read stands in for a note of 20,000 strokes.
 */
import { describe, expect, it } from "vitest";

import { SelectionModel } from "./SelectionModel";
import { computeBBox, type InkStroke } from "../ink/Stroke";

function stroke(id: string, x: number): InkStroke {
	const points = [
		{ x, y: 20, pressure: 0.5, t: 0 },
		{ x: x + 10, y: 30, pressure: 0.6, t: 4 },
	];
	return { id, tool: "pen", color: "#000000", width: 2, createdAt: 7, points, bbox: computeBBox(points, 4), page: 1 };
}

/** A stroke list that records every read of it, by index or by iteration. */
function countedList(strokes: InkStroke[]): { list: readonly InkStroke[]; reads: () => number } {
	let reads = 0;
	const list = new Proxy(strokes, {
		get(target, prop, receiver) {
			if (prop === "length" || prop === Symbol.iterator || typeof prop === "string") reads++;
			return Reflect.get(target, prop, receiver);
		},
	});
	return { list, reads: () => reads };
}

describe("SelectionModel.bounds reads strokes only for a selection that holds strokes", () => {
	it("nothing selected: the box is null and the stroke list is not read", () => {
		const model = new SelectionModel();
		const many = countedList(Array.from({ length: 50 }, (_, i) => stroke(`s${i}`, i * 15)));

		const box = model.bounds(many.list, () => null);

		expect(box).toBeNull();
		expect(many.reads(), "an empty selection read the note's strokes").toBe(0);
	});

	it("only a text box selected: the box comes from the text box and no stroke is read", () => {
		const model = new SelectionModel();
		const rect = { x: 20, y: 20, width: 40, height: 30 };
		model.selectByLasso(
			[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
			[],
			[{ id: "t1", x: 20, y: 20, width: 40, z: 0 }],
			() => rect
		);
		expect(model.boxIds).toEqual(["t1"]);
		const many = countedList([stroke("s0", 0)]);

		const box = model.bounds(many.list, () => rect);

		expect(box).toEqual(rect);
		expect(many.reads(), "a selection with no strokes read the note's strokes").toBe(0);
	});

	it("a stroke is selected: its box is returned (the early return does not hide a real box)", () => {
		const model = new SelectionModel();
		const s = stroke("s1", 40);
		model.selectExactly(["s1"]);

		const box = model.bounds([stroke("s0", 0), s], () => null);

		expect(box).toEqual(s.bbox);
	});
});
