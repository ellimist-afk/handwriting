import { describe, expect, it } from "vitest";
import { DEFAULT_PEN } from "./PenStyle";
import { InkPoint } from "./Stroke";
import { smoothSegments } from "./Smoothing";
import {
	flattenSegment,
	flattenStroke,
	jointIndices,
	ribbonSides,
	segmentDeviationPx,
	subdivisionsFor,
} from "./Ribbon";

function p(x: number, y: number, pressure = 0.5): InkPoint {
	return { x, y, pressure, t: 0 };
}

const style = { ...DEFAULT_PEN };

describe("flattening density follows zoom", () => {
	const seg = smoothSegments([p(0, 0), p(20, 0), p(40, 10)])[1]!;

	it("subdivides more as the camera zooms in", () => {
		const atOne = subdivisionsFor(seg, 1);
		const atSix = subdivisionsFor(seg, 6);
		expect(atSix).toBeGreaterThan(atOne);
	});

	it("is capped so a huge zoom cannot explode the point count", () => {
		expect(subdivisionsFor(seg, 10000)).toBeLessThanOrEqual(24);
	});

	it("always emits at least one point", () => {
		const degenerate = smoothSegments([p(5, 5), p(5, 5)])[0]!;
		expect(flattenSegment(degenerate, style, 1).length).toBeGreaterThanOrEqual(1);
	});

	it("subdivides a curve until it is flat to within a fraction of a pixel", () => {
		// Deviation falls as n², so this is the property that decides whether
		// a magnified curve still reads as polygonal.
		const pxPerWorld = 8;
		for (const seg of smoothSegments([p(0, 0), p(30, 0), p(60, 30)])) {
			const n = subdivisionsFor(seg, pxPerWorld);
			const residual = segmentDeviationPx(seg, pxPerWorld) / (n * n);
			expect(residual).toBeLessThanOrEqual(0.25 + 1e-9);
		}
	});

	it("does not waste points on a straight run, however long or magnified", () => {
		// A fast horizontal swipe is one long straight segment; subdividing it
		// 90 times would cost redraw time and change nothing on screen.
		const straight = smoothSegments([p(0, 0), p(500, 0), p(1000, 0)]);
		for (const seg of straight) {
			expect(subdivisionsFor(seg, 20)).toBe(1);
		}
	});
});

describe("flattenStroke", () => {
	it("starts at the stroke's first point", () => {
		const pts = flattenStroke([p(3, 4), p(10, 4), p(20, 9)], style, 1);
		expect(pts[0]!.x).toBeCloseTo(3);
		expect(pts[0]!.y).toBeCloseTo(4);
	});

	it("ends at the stroke's last point", () => {
		const pts = flattenStroke([p(0, 0), p(10, 0), p(20, 0)], style, 1);
		const last = pts[pts.length - 1]!;
		expect(last.x).toBeCloseTo(20);
		expect(last.y).toBeCloseTo(0);
	});

	it("carries pressure through as half-width", () => {
		const light = flattenStroke([p(0, 0, 0.1), p(10, 0, 0.1)], style, 1);
		const heavy = flattenStroke([p(0, 0, 1), p(10, 0, 1)], style, 1);
		expect(heavy[1]!.hw).toBeGreaterThan(light[1]!.hw);
	});

	it("handles a single-point dot", () => {
		const pts = flattenStroke([p(7, 7)], style, 1);
		expect(pts).toHaveLength(1);
		expect(pts[0]!.hw).toBeGreaterThan(0);
	});

	it("handles an empty stroke", () => {
		expect(flattenStroke([], style, 1)).toEqual([]);
	});
});

describe("ribbonSides", () => {
	it("offsets perpendicular to the path by the local half-width", () => {
		const pts = [
			{ x: 0, y: 0, hw: 2 },
			{ x: 10, y: 0, hw: 2 },
			{ x: 20, y: 0, hw: 2 },
		];
		const { left, right } = ribbonSides(pts);
		// Horizontal path -> sides are directly above and below.
		expect(left[1]!.x).toBeCloseTo(10);
		expect(Math.abs(left[1]!.y - 0)).toBeCloseTo(2);
		expect(Math.abs(right[1]!.y - 0)).toBeCloseTo(2);
		expect(left[1]!.y).toBeCloseTo(-right[1]!.y);
	});

	it("keeps both sides exactly hw from the centre, even as width changes", () => {
		const pts = [
			{ x: 0, y: 0, hw: 1 },
			{ x: 10, y: 0, hw: 3 },
			{ x: 20, y: 0, hw: 6 },
		];
		const { left, right } = ribbonSides(pts);
		for (let i = 0; i < pts.length; i++) {
			const c = pts[i]!;
			expect(Math.hypot(left[i]!.x - c.x, left[i]!.y - c.y)).toBeCloseTo(c.hw);
			expect(Math.hypot(right[i]!.x - c.x, right[i]!.y - c.y)).toBeCloseTo(c.hw);
		}
	});

	it("survives duplicate points without producing NaN", () => {
		const { left, right } = ribbonSides([
			{ x: 5, y: 5, hw: 2 },
			{ x: 5, y: 5, hw: 2 },
		]);
		for (const q of [...left, ...right]) {
			expect(Number.isFinite(q.x)).toBe(true);
			expect(Number.isFinite(q.y)).toBe(true);
		}
	});
});

describe("jointIndices", () => {
	it("finds nothing on a straight run", () => {
		expect(
			jointIndices([
				{ x: 0, y: 0, hw: 1 },
				{ x: 10, y: 0, hw: 1 },
				{ x: 20, y: 0, hw: 1 },
			])
		).toEqual([]);
	});

	it("finds the corner of a right-angle turn", () => {
		expect(
			jointIndices([
				{ x: 0, y: 0, hw: 1 },
				{ x: 10, y: 0, hw: 1 },
				{ x: 10, y: 10, hw: 1 },
			])
		).toEqual([1]);
	});

	it("ignores gentle curvature, so smooth strokes stay cheap", () => {
		const pts = [];
		for (let i = 0; i <= 20; i++) {
			pts.push({ x: i, y: Math.sin(i / 20) * 0.5, hw: 1 });
		}
		expect(jointIndices(pts)).toEqual([]);
	});
});
