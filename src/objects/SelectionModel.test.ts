import { describe, expect, it } from "vitest";
import { BBox, InkStroke, computeBBox } from "../ink/Stroke";
import { TextBoxData } from "../model/PageData";
import { SelectionModel } from "./SelectionModel";

function stroke(id: string, pts: Array<[number, number]>): InkStroke {
	const points = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i }));
	return {
		id,
		tool: "pen",
		color: "#000",
		width: 2,
		points,
		bbox: computeBBox(points, 4),
		createdAt: 0,
	};
}

const square = [
	{ x: 0, y: 0 },
	{ x: 100, y: 0 },
	{ x: 100, y: 100 },
	{ x: 0, y: 100 },
];

const boxes: TextBoxData[] = [
	{ id: "b-in", x: 20, y: 20, width: 40, z: 0 },
	{ id: "b-out", x: 500, y: 500, width: 40, z: 1 },
];

const rects: Record<string, BBox> = {
	"b-in": { x: 20, y: 20, width: 40, height: 30 },
	"b-out": { x: 500, y: 500, width: 40, height: 30 },
};
const rectOf = (id: string): BBox | null => rects[id] ?? null;

describe("SelectionModel", () => {
	it("starts empty", () => {
		const sel = new SelectionModel();
		expect(sel.isEmpty).toBe(true);
		expect(sel.size).toBe(0);
	});

	it("selects mixed ink and containers from one lasso", () => {
		const sel = new SelectionModel();
		const strokes = [stroke("s-in", [[10, 10], [50, 50]]), stroke("s-out", [[900, 900], [910, 910]])];
		sel.selectByLasso(square, strokes, boxes, rectOf);
		expect(sel.strokeIds).toEqual(["s-in"]);
		expect(sel.boxIds).toEqual(["b-in"]);
		expect(sel.size).toBe(2);
	});

	it("replaces the previous selection rather than adding to it", () => {
		const sel = new SelectionModel();
		const strokes = [stroke("s-in", [[10, 10], [50, 50]])];
		sel.selectByLasso(square, strokes, boxes, rectOf);
		sel.selectByLasso(
			[
				{ x: 800, y: 800 },
				{ x: 900, y: 800 },
				{ x: 900, y: 900 },
			],
			strokes,
			boxes,
			rectOf
		);
		expect(sel.isEmpty).toBe(true);
	});

	it("treats a degenerate lasso as selecting nothing", () => {
		const sel = new SelectionModel();
		const strokes = [stroke("s", [[10, 10], [50, 50]])];
		sel.selectByLasso([{ x: 10, y: 10 }, { x: 20, y: 20 }], strokes, boxes, rectOf);
		expect(sel.isEmpty).toBe(true);
	});

	it("ignores containers that have no laid-out rectangle yet", () => {
		const sel = new SelectionModel();
		sel.selectByLasso(square, [], boxes, () => null);
		expect(sel.boxIds).toEqual([]);
	});

	it("unions bounds across ink and containers", () => {
		const sel = new SelectionModel();
		const strokes = [stroke("s-in", [[10, 10], [50, 50]])];
		sel.selectByLasso(square, strokes, boxes, rectOf);
		const b = sel.bounds(strokes, rectOf)!;
		expect(b.x).toBeLessThanOrEqual(6); // stroke bbox is padded by width*2
		expect(b.x + b.width).toBeGreaterThanOrEqual(60);
	});

	it("has no bounds when nothing is selected", () => {
		expect(new SelectionModel().bounds([], rectOf)).toBeNull();
	});

	it("prunes ids that no longer exist", () => {
		// After an external edit deletes a container, or undo removes a stroke,
		// the selection must not keep drawing an outline around nothing.
		const sel = new SelectionModel();
		const strokes = [stroke("s-in", [[10, 10], [50, 50]])];
		sel.selectByLasso(square, strokes, boxes, rectOf);
		expect(sel.size).toBe(2);

		sel.prune(new Set<string>(), new Set(["b-in"]));
		expect(sel.strokeIds).toEqual([]);
		expect(sel.boxIds).toEqual(["b-in"]);

		sel.prune(new Set<string>(), new Set<string>());
		expect(sel.isEmpty).toBe(true);
	});

	it("reports whether clearing changed anything", () => {
		const sel = new SelectionModel();
		expect(sel.clear()).toBe(false);
		sel.selectByLasso(square, [stroke("s", [[10, 10], [20, 20]])], [], rectOf);
		expect(sel.clear()).toBe(true);
		expect(sel.isEmpty).toBe(true);
	});
});

describe("selectExactly", () => {
	it("replaces the whole selection with the given strokes", () => {
		const m = new SelectionModel();
		m.selectExactly(["a", "b"]);
		expect(m.strokeIds.sort()).toEqual(["a", "b"]);
		expect(m.boxIds).toEqual([]);
		m.selectExactly(["c"]);
		expect(m.strokeIds).toEqual(["c"]);
	});
});
