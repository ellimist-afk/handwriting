/**
 * Undo is judged by one property: after undo, the strokes are exactly what
 * they were - same contents, same ORDER. Order is the half that gets missed,
 * because a list that looks right can still have brought a stroke back on top
 * of what was covering it.
 */

import { describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { InkOp } from "../inline/InkHistory";
import { HISTORY_LIMIT, PdfInkHistory, applyOp } from "./PdfInkHistory";

const ID = "pdf-doc";

function stroke(id: string, x = 0): InkStroke {
	const points = [
		{ x, y: 0, pressure: 0.5, t: 0 },
		{ x: x + 10, y: 10, pressure: 0.5, t: 8 },
	];
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2,
		points,
		bbox: computeBBox(points, 4),
		createdAt: 0,
		page: 1,
	};
}

const ids = (list: readonly InkStroke[]) => list.map((s) => s.id);

describe("applyOp", () => {
	const base = [stroke("a"), stroke("b"), stroke("c")];

	it("appends an add with no indices", () => {
		const op: InkOp = { type: "add", path: ID, strokes: [stroke("d")] };
		expect(ids(applyOp(base, op))).toEqual(["a", "b", "c", "d"]);
	});

	it("restores z-order from indices", () => {
		// The half that gets missed. Bringing an erased stroke back at the end
		// puts it on top of whatever was drawn over it.
		const op: InkOp = { type: "add", path: ID, strokes: [stroke("x")], indices: [1] };
		expect(ids(applyOp(base, op))).toEqual(["a", "x", "b", "c"]);
	});

	it("puts several strokes back at their own places", () => {
		const op: InkOp = {
			type: "add",
			path: ID,
			strokes: [stroke("x"), stroke("y")],
			indices: [0, 2],
		};
		expect(ids(applyOp(base, op))).toEqual(["x", "a", "y", "b", "c"]);
	});

	it("removes by id, not by position", () => {
		const op: InkOp = { type: "remove", path: ID, strokes: [stroke("b")], indices: [1] };
		expect(ids(applyOp(base, op))).toEqual(["a", "c"]);
	});

	it("moves only the named strokes, points and bbox together", () => {
		const op: InkOp = { type: "move", path: ID, strokeIds: ["b"], dx: 5, dy: -3 };
		const out = applyOp(base, op);
		expect(out[1]!.points[0]!.x).toBe(base[1]!.points[0]!.x + 5);
		expect(out[1]!.bbox.y).toBe(base[1]!.bbox.y - 3);
		// A bbox left behind breaks culling and eraser hit-testing silently.
		expect(out[0]!.points[0]!.x).toBe(base[0]!.points[0]!.x);
	});

	it("swaps a partial erase in one step", () => {
		const op: InkOp = {
			type: "replace",
			path: ID,
			removed: [stroke("b")],
			removedAt: [1],
			inserted: [stroke("b1"), stroke("b2")],
			insertedAt: [1, 2],
		};
		expect(ids(applyOp(base, op))).toEqual(["a", "b1", "b2", "c"]);
	});

	it("never mutates what it was given", () => {
		const op: InkOp = { type: "add", path: ID, strokes: [stroke("d")] };
		applyOp(base, op);
		expect(ids(base)).toEqual(["a", "b", "c"]);
	});
});

describe("the ring", () => {
	function roundTrip(before: InkStroke[], op: InkOp): InkStroke[] {
		const h = new PdfInkHistory();
		const after = applyOp(before, op);
		h.record(op);
		return applyOp(after, h.undo()!);
	}

	it("returns the list exactly, for every kind of operation", () => {
		// The property the whole feature rests on, checked against each op
		// rather than against the one that was easiest to write.
		const base = [stroke("a"), stroke("b"), stroke("c")];
		const cases: InkOp[] = [
			{ type: "add", path: ID, strokes: [stroke("d")] },
			{ type: "remove", path: ID, strokes: [base[1]!], indices: [1] },
			{ type: "move", path: ID, strokeIds: ["b"], dx: 7, dy: 2 },
			{
				type: "replace",
				path: ID,
				removed: [base[1]!],
				removedAt: [1],
				inserted: [stroke("b1")],
				insertedAt: [1],
			},
		];
		for (const op of cases) {
			expect(roundTrip(base, op)).toEqual(base);
		}
	});

	it("redo puts back exactly what undo took away", () => {
		const base = [stroke("a")];
		const h = new PdfInkHistory();
		const op: InkOp = { type: "add", path: ID, strokes: [stroke("b")] };
		const added = applyOp(base, op);
		h.record(op);
		const undone = applyOp(added, h.undo()!);
		expect(ids(undone)).toEqual(["a"]);
		expect(ids(applyOp(undone, h.redo()!))).toEqual(["a", "b"]);
	});

	it("drops the redo branch once you do something else", () => {
		// Otherwise Ctrl+Y pastes in work from a timeline the user abandoned,
		// on top of what they did instead.
		const h = new PdfInkHistory();
		h.record({ type: "add", path: ID, strokes: [stroke("a")] });
		h.undo();
		expect(h.depth.undone).toBe(1);
		h.record({ type: "add", path: ID, strokes: [stroke("b")] });
		expect(h.depth.undone).toBe(0);
		expect(h.redo()).toBeNull();
	});

	it("has nothing to say when empty", () => {
		const h = new PdfInkHistory();
		expect(h.undo()).toBeNull();
		expect(h.redo()).toBeNull();
	});

	it("stays bounded over a long session", () => {
		const h = new PdfInkHistory();
		for (let i = 0; i < HISTORY_LIMIT + 40; i++) {
			h.record({ type: "add", path: ID, strokes: [stroke(`s${i}`)] });
		}
		expect(h.depth.done).toBe(HISTORY_LIMIT);
	});

	it("carries the document on every op", () => {
		// An undo pressed after the pane switched files must act on the pdf the
		// ink belongs to, never on whatever is on screen. Putting strokes back
		// into the wrong document is corruption, not a surprise.
		const h = new PdfInkHistory();
		h.record({ type: "add", path: "pdf-one", strokes: [stroke("a")] });
		expect(h.undo()!.path).toBe("pdf-one");
	});
});
