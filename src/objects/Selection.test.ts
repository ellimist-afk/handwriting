import { describe, expect, it } from "vitest";
import { InkStroke } from "../ink/Stroke";
import {
	bboxOverlaps,
	pointInBBox,
	pointInPolygon,
	polygonBounds,
	rectInLasso,
	segmentsIntersect,
	strokeInLasso,
	translateStroke,
	unionBounds,
} from "./Selection";

/** A closed square lasso from (0,0) to (100,100). */
const square = [
	{ x: 0, y: 0 },
	{ x: 100, y: 0 },
	{ x: 100, y: 100 },
	{ x: 0, y: 100 },
];
const squareBounds = polygonBounds(square);

function stroke(pts: Array<[number, number]>): InkStroke {
	const points = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i }));
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	return {
		id: "s",
		tool: "pen",
		color: "#000",
		width: 2,
		points,
		bbox: {
			x: Math.min(...xs),
			y: Math.min(...ys),
			width: Math.max(...xs) - Math.min(...xs),
			height: Math.max(...ys) - Math.min(...ys),
		},
		createdAt: 0,
	};
}

describe("pointInPolygon", () => {
	it("is true inside and false outside", () => {
		expect(pointInPolygon(50, 50, square)).toBe(true);
		expect(pointInPolygon(150, 50, square)).toBe(false);
		expect(pointInPolygon(50, -10, square)).toBe(false);
	});

	it("handles a concave polygon", () => {
		// A C-shape opening to the right.
		const c = [
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 20 },
			{ x: 20, y: 20 },
			{ x: 20, y: 80 },
			{ x: 100, y: 80 },
			{ x: 100, y: 100 },
			{ x: 0, y: 100 },
		];
		expect(pointInPolygon(10, 50, c)).toBe(true); // in the spine
		expect(pointInPolygon(60, 50, c)).toBe(false); // in the mouth
	});
});

describe("segmentsIntersect", () => {
	it("detects a crossing", () => {
		expect(
			segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })
		).toBe(true);
	});

	it("rejects parallel and disjoint segments", () => {
		expect(
			segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 })
		).toBe(false);
	});
});

describe("strokeInLasso", () => {
	it("selects a stroke fully inside", () => {
		expect(strokeInLasso(stroke([[10, 10], [50, 50]]), square, squareBounds)).toBe(true);
	});

	it("ignores a stroke fully outside", () => {
		expect(strokeInLasso(stroke([[200, 200], [300, 300]]), square, squareBounds)).toBe(false);
	});

	it("ignores a stroke the lasso merely crosses (samples outside)", () => {
		// The old any-touch rule took this whole stroke for two grazed
		// points; majority-inside leaves it be.
		expect(strokeInLasso(stroke([[-50, 50], [150, 50]]), square, squareBounds)).toBe(false);
	});

	it("ignores a stroke only clipped at its edge", () => {
		// One sample of four inside: grazed while circling something else.
		expect(
			strokeInLasso(
				stroke([[90, 50], [150, 50], [210, 50], [270, 50]]),
				square,
				squareBounds
			)
		).toBe(false);
	});

	it("selects a stroke mostly inside", () => {
		// Three of four samples in the loop: that is what was circled.
		expect(
			strokeInLasso(
				stroke([[20, 50], [50, 50], [80, 50], [150, 50]]),
				square,
				squareBounds
			)
		).toBe(true);
	});

	it("ignores a stroke whose bbox overlaps but whose ink does not", () => {
		// Runs along y=150, well below the lasso; bbox test alone would be
		// ambiguous for a diagonal, so this pins the exact test.
		expect(strokeInLasso(stroke([[0, 150], [100, 150]]), square, squareBounds)).toBe(false);
	});

	it("needs at least a triangle", () => {
		expect(strokeInLasso(stroke([[10, 10], [20, 20]]), [{ x: 0, y: 0 }], { x: 0, y: 0, width: 0, height: 0 })).toBe(false);
	});
});

describe("rectInLasso", () => {
	it("selects a text box fully inside", () => {
		expect(rectInLasso({ x: 10, y: 10, width: 20, height: 20 }, square, squareBounds)).toBe(true);
	});

	it("selects a partially overlapping box", () => {
		expect(rectInLasso({ x: 90, y: 40, width: 60, height: 20 }, square, squareBounds)).toBe(true);
	});

	it("ignores a box that misses entirely", () => {
		expect(rectInLasso({ x: 500, y: 500, width: 20, height: 20 }, square, squareBounds)).toBe(false);
	});

	it("selects a box that swallows the whole lasso", () => {
		// No corner inside the polygon, but the lasso is inside the box.
		expect(
			rectInLasso({ x: -100, y: -100, width: 400, height: 400 }, square, squareBounds)
		).toBe(true);
	});
});

describe("bounds helpers", () => {
	it("unions boxes", () => {
		const u = unionBounds([
			{ x: 0, y: 0, width: 10, height: 10 },
			{ x: 50, y: 20, width: 10, height: 5 },
		])!;
		expect(u).toEqual({ x: 0, y: 0, width: 60, height: 25 });
	});

	it("returns null for nothing", () => {
		expect(unionBounds([])).toBeNull();
	});

	it("tests point containment and overlap", () => {
		const b = { x: 0, y: 0, width: 10, height: 10 };
		expect(pointInBBox(5, 5, b)).toBe(true);
		expect(pointInBBox(15, 5, b)).toBe(false);
		expect(bboxOverlaps(b, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
		expect(bboxOverlaps(b, { x: 50, y: 5, width: 10, height: 10 })).toBe(false);
	});
});

describe("translateStroke", () => {
	it("moves points and bbox together", () => {
		const s = stroke([[0, 0], [10, 10]]);
		translateStroke(s, 5, -3);
		expect(s.points[0]).toMatchObject({ x: 5, y: -3 });
		expect(s.points[1]).toMatchObject({ x: 15, y: 7 });
		expect(s.bbox.x).toBe(5);
		expect(s.bbox.y).toBe(-3);
	});

	it("is exactly reversible, which is what undo relies on", () => {
		const s = stroke([[1, 2], [3, 4]]);
		translateStroke(s, 12.5, -7.25);
		translateStroke(s, -12.5, 7.25);
		expect(s.points[0]).toMatchObject({ x: 1, y: 2 });
		expect(s.bbox.x).toBe(1);
	});
});
