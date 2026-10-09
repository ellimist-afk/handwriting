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
	unionBounds,
} from "./Selection";

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

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const p = (x: number, y: number) => ({ x, y });

describe("pointInPolygon, in the places a hit test and a boundary can disagree", () => {
	// A triangle with a vertex that sits on the row of the point.
	const tri = [p(0, 0), p(100, 50), p(0, 100)];

	it("counts a point on the row of a vertex the same as a point just off it", () => {
		expect(pointInPolygon(10, 50, tri)).toBe(true);
		expect(pointInPolygon(10, 49.999, tri)).toBe(true);
		expect(pointInPolygon(10, 50.001, tri)).toBe(true);
		expect(pointInPolygon(150, 50, tri)).toBe(false);
	});

	it("is false outside on every side of a square", () => {
		expect(pointInPolygon(-1, 50, square)).toBe(false);
		expect(pointInPolygon(101, 50, square)).toBe(false);
		expect(pointInPolygon(50, -1, square)).toBe(false);
		expect(pointInPolygon(50, 101, square)).toBe(false);
	});

	it("is true in both winding directions", () => {
		expect(pointInPolygon(50, 50, [...square].reverse())).toBe(true);
		expect(pointInPolygon(50, 50, square)).toBe(true);
	});

	it("holds a point that a loop wound twice covers twice", () => {
		expect(pointInPolygon(50, 50, [...square, ...square])).toBe(true);
	});

	it("is false when the polygon is a back-and-forth line with no area", () => {
		const line = [p(0, 0), p(100, 100), p(0, 0)];
		expect(pointInPolygon(50, 50, line)).toBe(false);
		expect(pointInPolygon(30, 70, line)).toBe(false);
	});

	it("tells the two sides of a slanted edge apart", () => {
		const d = [p(0, 0), p(100, 0), p(0, 100)];
		expect(pointInPolygon(40, 40, d)).toBe(true);
		expect(pointInPolygon(60, 60, d)).toBe(false);
		expect(pointInPolygon(49, 49, d)).toBe(true);
		expect(pointInPolygon(51, 51, d)).toBe(false);
	});
});

describe("polygonBounds takes the extreme of every vertex, not the first or last", () => {
	it("finds the minimum and maximum wherever they sit in the list", () => {
		const poly = [p(5, 7), p(-3, 20), p(40, -9), p(12, 33)];
		expect(polygonBounds(poly)).toEqual({ x: -3, y: -9, width: 43, height: 42 });
	});

	it("keeps the extreme when a later vertex ties it", () => {
		const poly = [p(0, 0), p(0, 10), p(10, 0), p(10, 10)];
		expect(polygonBounds(poly)).toEqual({ x: 0, y: 0, width: 10, height: 10 });
	});

	it("reads an empty polygon as an empty box", () => {
		expect(polygonBounds([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
	});
});

describe("bboxOverlaps on each of its four sides", () => {
	const a = box(0, 0, 10, 10);
	it("overlaps when the boxes touch edge to edge", () => {
		expect(bboxOverlaps(a, box(10, 0, 10, 10))).toBe(true);
		expect(bboxOverlaps(a, box(-10, 0, 10, 10))).toBe(true);
		expect(bboxOverlaps(a, box(0, 10, 10, 10))).toBe(true);
		expect(bboxOverlaps(a, box(0, -10, 10, 10))).toBe(true);
	});
	it("does not overlap when a box is clear on any one side", () => {
		expect(bboxOverlaps(a, box(10.5, 0, 10, 10))).toBe(false);
		expect(bboxOverlaps(a, box(-10.5, 0, 10, 10))).toBe(false);
		expect(bboxOverlaps(a, box(0, 10.5, 10, 10))).toBe(false);
		expect(bboxOverlaps(a, box(0, -10.5, 10, 10))).toBe(false);
	});
	it("is symmetric, which checks each side from both boxes", () => {
		expect(bboxOverlaps(box(10.5, 0, 10, 10), a)).toBe(false);
		expect(bboxOverlaps(box(0, 10.5, 10, 10), a)).toBe(false);
		expect(bboxOverlaps(box(-10.5, 0, 10, 10), a)).toBe(false);
		expect(bboxOverlaps(box(0, -10.5, 10, 10), a)).toBe(false);
		expect(bboxOverlaps(box(10, 0, 10, 10), a)).toBe(true);
		expect(bboxOverlaps(box(0, 10, 10, 10), a)).toBe(true);
	});
	it("overlaps when one box lies inside the other", () => {
		expect(bboxOverlaps(a, box(2, 2, 3, 3))).toBe(true);
		expect(bboxOverlaps(box(2, 2, 3, 3), a)).toBe(true);
	});
});

describe("segmentsIntersect", () => {
	it("crosses in an X", () => {
		expect(segmentsIntersect(p(0, 0), p(10, 10), p(0, 10), p(10, 0))).toBe(true);
	});
	it("misses when one segment ends before the other begins, though their lines cross", () => {
		expect(segmentsIntersect(p(0, 0), p(4, 4), p(0, 10), p(10, 0))).toBe(false);
		expect(segmentsIntersect(p(0, 10), p(10, 0), p(0, 0), p(4, 4))).toBe(false);
		expect(segmentsIntersect(p(6, 6), p(10, 10), p(0, 10), p(10, 0))).toBe(false);
	});
	it("touches at an end that lies on the other segment (a T)", () => {
		expect(segmentsIntersect(p(0, 5), p(10, 5), p(5, 5), p(5, 10))).toBe(true);
		expect(segmentsIntersect(p(5, 5), p(5, 10), p(0, 5), p(10, 5))).toBe(true);
		expect(segmentsIntersect(p(0, 5), p(10, 5), p(5, 0), p(5, 5))).toBe(true);
		expect(segmentsIntersect(p(5, 0), p(5, 5), p(0, 5), p(10, 5))).toBe(true);
	});
	it("touches at a shared end", () => {
		expect(segmentsIntersect(p(0, 0), p(5, 5), p(5, 5), p(10, 0))).toBe(true);
	});
	it("counts collinear segments that overlap or touch, and not ones with a gap", () => {
		expect(segmentsIntersect(p(0, 0), p(10, 0), p(5, 0), p(15, 0))).toBe(true);
		expect(segmentsIntersect(p(0, 0), p(10, 0), p(10, 0), p(15, 0))).toBe(true);
		expect(segmentsIntersect(p(0, 0), p(10, 0), p(10.5, 0), p(15, 0))).toBe(false);
		expect(segmentsIntersect(p(0, 0), p(10, 0), p(-5, 0), p(-0.5, 0))).toBe(false);
		expect(segmentsIntersect(p(0, 0), p(0, 10), p(0, 10.5), p(0, 15))).toBe(false);
		expect(segmentsIntersect(p(0, 0), p(0, 10), p(0, -5), p(0, -0.5))).toBe(false);
	});
	it("does not count parallel segments that are apart", () => {
		expect(segmentsIntersect(p(0, 0), p(10, 0), p(0, 1), p(10, 1))).toBe(false);
	});
	it("does not count a line that passes by the end of a segment", () => {
		expect(segmentsIntersect(p(0, 0), p(10, 0), p(5, 1), p(5, 10))).toBe(false);
		expect(segmentsIntersect(p(5, 1), p(5, 10), p(0, 0), p(10, 0))).toBe(false);
	});
});

describe("strokeInLasso weighs ink by length against a half", () => {
	it("selects a stroke with just over half its length inside, and leaves one with just under", () => {
		// A 100-long horizontal run from x = -49 to 51 has 51 inside; from -51 to 49 has 49.
		expect(strokeInLasso(stroke([[-49, 50], [51, 50]]), square, squareBounds)).toBe(true);
		expect(strokeInLasso(stroke([[-51, 50], [49, 50]]), square, squareBounds)).toBe(false);
	});

	it("leaves a stroke with exactly half its length inside", () => {
		expect(strokeInLasso(stroke([[-50, 50], [50, 50]]), square, squareBounds)).toBe(false);
	});

	it("finds the inside part of a segment that leaves and re-enters", () => {
		const notch = [p(0, 0), p(100, 0), p(100, 100), p(60, 100), p(60, 40), p(40, 40), p(40, 100), p(0, 100)];
		const nb = polygonBounds(notch);
		// A run along y = 70 from x = 0 to 100 loses the 20 inside the notch.
		expect(strokeInLasso(stroke([[0, 70], [100, 70]]), notch, nb)).toBe(true);
		// From 30 to 70: 10 + 10 on the walls, 20 across the notch: exactly half.
		expect(strokeInLasso(stroke([[30, 70], [70, 70]]), notch, nb)).toBe(false);
		expect(strokeInLasso(stroke([[28, 70], [72, 70]]), notch, nb)).toBe(true);
	});

	it("skips a segment wholly to one side of the lasso's box", () => {
		const left = stroke([[10, 50], [90, 50], [-150, 50], [-300, 50], [-300, 500]]);
		expect(strokeInLasso(left, square, squareBounds)).toBe(false);
		const mostlyIn = stroke([[10, 10], [90, 10], [90, 90], [10, 90], [10, -50]]);
		expect(strokeInLasso(mostlyIn, square, squareBounds)).toBe(true);
		const right = stroke([[10, 50], [90, 50], [300, 50], [500, 50], [500, 500]]);
		expect(strokeInLasso(right, square, squareBounds)).toBe(false);
		const below = stroke([[10, 50], [90, 50], [90, 300], [10, 400], [10, 900]]);
		expect(strokeInLasso(below, square, squareBounds)).toBe(false);
	});

	it("selects a dot inside and leaves a dot outside", () => {
		expect(strokeInLasso(stroke([[50, 50]]), square, squareBounds)).toBe(true);
		expect(strokeInLasso(stroke([[50, 50], [50, 50]]), square, squareBounds)).toBe(true);
		expect(strokeInLasso(stroke([[150, 50], [150, 50]]), square, squareBounds)).toBe(false);
	});

	it("leaves a stroke with no samples", () => {
		const s = stroke([[10, 10]]);
		s.points = [];
		expect(strokeInLasso(s, square, squareBounds)).toBe(false);
	});

	it("leaves a stroke whose box misses the lasso's box, however its samples sit", () => {
		expect(strokeInLasso(stroke([[200, 10], [300, 10]]), square, squareBounds)).toBe(false);
		expect(strokeInLasso(stroke([[50, -300], [50, -200]]), square, squareBounds)).toBe(false);
	});

	it("needs a lasso of three points: two are not enough", () => {
		const two = [p(0, 0), p(100, 100)];
		expect(strokeInLasso(stroke([[40, 40], [60, 60]]), two, polygonBounds(two))).toBe(false);
		expect(strokeInLasso(stroke([[40, 40], [60, 60]]), [], squareBounds)).toBe(false);
	});

	it("counts the ink of a diagonal segment cut by a slanted lasso edge", () => {
		const d = [p(0, 0), p(100, 0), p(0, 100)];
		const db = polygonBounds(d);
		// The diagonal leaves the lasso where x + y = 100, at (50, 50).
		expect(strokeInLasso(stroke([[10, 10], [90, 90]]), d, db)).toBe(false);
		expect(strokeInLasso(stroke([[10, 10], [95, 95]]), d, db)).toBe(false);
		expect(strokeInLasso(stroke([[10, 10], [45, 45]]), d, db)).toBe(true);
		expect(strokeInLasso(stroke([[10, 10], [55, 55]]), d, db)).toBe(true);
	});
});

describe("rectInLasso", () => {
	it("is true for a box with a corner inside the lasso, whichever corner", () => {
		expect(rectInLasso(box(90, 90, 50, 50), square, squareBounds)).toBe(true);
		expect(rectInLasso(box(-40, 90, 50, 50), square, squareBounds)).toBe(true);
		expect(rectInLasso(box(90, -40, 50, 50), square, squareBounds)).toBe(true);
		expect(rectInLasso(box(-40, -40, 50, 50), square, squareBounds)).toBe(true);
	});

	it("is true for a lasso drawn wholly inside a box, to the limit of each side", () => {
		const inner = [p(40, 40), p(60, 40), p(50, 60)];
		const ib = polygonBounds(inner);
		expect(rectInLasso(box(0, 0, 100, 100), inner, ib)).toBe(true);
		expect(rectInLasso(box(39.5, 0, 100, 100), inner, ib)).toBe(true);
		expect(rectInLasso(box(0, 0, 60.5, 100), inner, ib)).toBe(true);
		expect(rectInLasso(box(0, 39.5, 100, 100), inner, ib)).toBe(true);
		expect(rectInLasso(box(0, 0, 100, 60.5), inner, ib)).toBe(true);
	});

	it("is true when only an edge of the lasso crosses an edge of the box", () => {
		const band = [p(-50, 40), p(150, 40), p(150, 60), p(-50, 60)];
		expect(rectInLasso(box(40, 0, 20, 100), band, polygonBounds(band))).toBe(true);
		const tall = [p(40, -50), p(60, -50), p(60, 150), p(40, 150)];
		expect(rectInLasso(box(0, 40, 100, 20), tall, polygonBounds(tall))).toBe(true);
	});

	it("is false for a box that the lasso's box overlaps but the lasso does not touch", () => {
		const d = [p(0, 0), p(100, 0), p(0, 100)];
		expect(rectInLasso(box(70, 70, 20, 20), d, polygonBounds(d))).toBe(false);
	});

	it("is false when a lasso vertex lines up with the box on one axis only", () => {
		// The vertex (100, 0) has an x inside the box's x range and a y outside its y range, and the other way round for a
		// vertex of a lasso placed beside the box: neither is inside the box.
		const d = [p(0, 0), p(100, 0), p(0, 100)];
		expect(rectInLasso(box(70, 40, 40, 20), d, polygonBounds(d))).toBe(false);
		expect(rectInLasso(box(40, 70, 20, 40), d, polygonBounds(d))).toBe(false);
		const e = [p(0, 0), p(0, 100), p(100, 0)];
		expect(rectInLasso(box(40, 70, 20, 40), e, polygonBounds(e))).toBe(false);
	});

	it("is false for a lasso of fewer than three points", () => {
		expect(rectInLasso(box(0, 0, 100, 100), [p(10, 10), p(20, 20)], box(10, 10, 10, 10))).toBe(false);
	});

	it("is false when the box and the lasso's box do not meet", () => {
		expect(rectInLasso(box(300, 300, 10, 10), square, squareBounds)).toBe(false);
	});
});

describe("unionBounds and pointInBBox", () => {
	it("takes the extremes from boxes anywhere in the list", () => {
		expect(unionBounds([box(10, 10, 5, 5), box(-20, 30, 5, 5), box(40, -8, 10, 10), box(0, 0, 100, 3)])).toEqual({
			x: -20,
			y: -8,
			width: 120,
			height: 43,
		});
	});

	it("takes the far edge from a box's right and bottom, not its origin", () => {
		expect(unionBounds([box(0, 0, 100, 100), box(10, 10, 5, 5)])).toEqual({ x: 0, y: 0, width: 100, height: 100 });
		expect(unionBounds([box(10, 10, 5, 5), box(0, 0, 100, 100)])).toEqual({ x: 0, y: 0, width: 100, height: 100 });
	});

	it("contains a point on each edge of the box and none a hair outside", () => {
		const b = box(10, 20, 30, 40);
		expect(pointInBBox(10, 30, b)).toBe(true);
		expect(pointInBBox(40, 30, b)).toBe(true);
		expect(pointInBBox(20, 20, b)).toBe(true);
		expect(pointInBBox(20, 60, b)).toBe(true);
		expect(pointInBBox(9.9, 30, b)).toBe(false);
		expect(pointInBBox(40.1, 30, b)).toBe(false);
		expect(pointInBBox(20, 19.9, b)).toBe(false);
		expect(pointInBBox(20, 60.1, b)).toBe(false);
	});
});
