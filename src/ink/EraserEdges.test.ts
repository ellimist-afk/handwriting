import { describe, expect, it } from "vitest";
import type { InkPoint, InkStroke } from "./Stroke";
import {
	bboxHitsCircle,
	pointSegmentDistSq,
	segmentCircleCrossings,
	splitStrokeByCircle,
	strokeHitsCircle,
} from "./Eraser";

function pt(x: number, y: number, extra: Partial<InkPoint> = {}): InkPoint {
	return { x, y, pressure: 0.5, t: 0, ...extra };
}

/** A stroke whose painted half-width is `width / 2`; the box is generous so only the exact test decides. */
function stroke(points: InkPoint[], width = 0): InkStroke {
	return {
		id: "s",
		tool: "pen",
		color: "#000",
		width,
		points,
		bbox: { x: -100, y: -100, width: 200, height: 200 },
		createdAt: 0,
	};
}

let n = 0;
const makeId = () => `piece-${++n}`;

describe("the eraser circle against a box", () => {
	const box = { x: 0, y: 0, width: 10, height: 10 };
	it("hits a box whose nearest edge is exactly the radius away, and misses one a hair further", () => {
		expect(bboxHitsCircle(box, 13, 5, 3)).toBe(true);
		expect(bboxHitsCircle(box, 13, 5, 2.999)).toBe(false);
		expect(bboxHitsCircle(box, 5, 13, 3)).toBe(true);
		expect(bboxHitsCircle(box, 5, 13, 2.999)).toBe(false);
	});
});

describe("the eraser circle against a stroke's ink, to the exact reach", () => {
	it("reaches a single-sample stroke exactly the radius plus the painted half-width away", () => {
		const dot = stroke([pt(0, 0)], 2);
		expect(strokeHitsCircle(dot, 3, 0, 2)).toBe(true);
		expect(strokeHitsCircle(dot, 3, 0, 1.99)).toBe(false);
	});

	it("reaches a segment exactly the radius plus the painted half-width away", () => {
		const line = stroke([pt(0, 0), pt(10, 0)], 2);
		expect(strokeHitsCircle(line, 5, 3, 2)).toBe(true);
		expect(strokeHitsCircle(line, 5, 3, 1.99)).toBe(false);
	});
});

describe("distance to a segment", () => {
	it("measures to the near end of a point beyond either end of the segment", () => {
		expect(pointSegmentDistSq(-3, 4, 0, 0, 10, 0)).toBe(25);
		expect(pointSegmentDistSq(13, 4, 0, 0, 10, 0)).toBe(25);
		expect(pointSegmentDistSq(5, 4, 0, 0, 10, 0)).toBe(16);
	});

	it("measures to the point when the segment has no length", () => {
		expect(pointSegmentDistSq(3, 4, 0, 0, 0, 0)).toBe(25);
	});
});

describe("where a segment crosses the circle", () => {
	const a = (x: number, y: number) => pt(x, y);

	it("reports no crossing for a segment that only grazes the circle", () => {
		expect(segmentCircleCrossings(a(-5, 3), a(5, 3), 0, 0, 3)).toEqual([]);
	});

	it("reports no crossing for a segment with no length", () => {
		expect(segmentCircleCrossings(a(1, 1), a(1, 1), 0, 0, 3)).toEqual([]);
	});

	it("does not count an end that sits exactly on the ring", () => {
		expect(segmentCircleCrossings(a(3, 0), a(-3, 0), 0, 0, 3)).toEqual([]);
		expect(segmentCircleCrossings(a(-3, 0), a(3, 0), 0, 0, 3)).toEqual([]);
	});

	it("reports both crossings, in order, for a segment straight through", () => {
		const c = segmentCircleCrossings(a(-6, 0), a(6, 0), 0, 0, 3);
		expect(c).toHaveLength(2);
		expect(c[0]).toBeCloseTo(0.25, 10);
		expect(c[1]).toBeCloseTo(0.75, 10);
	});
});

describe("what survives a cut, at the places the arithmetic can slip", () => {
	it("cuts a stroke leaving the circle at the ring, with the sample fields blended along the way", () => {
		const s = stroke(
			[pt(0, 0, { pressure: 0.2, t: 0, tiltX: 10, tiltY: 20 }), pt(10, 0, { pressure: 0.6, t: 100, tiltX: 30, tiltY: 60 })],
			0
		);
		const out = splitStrokeByCircle(s, 0, 0, 5, makeId);
		expect(out).toHaveLength(1);
		const [onRing, end] = out[0]!.points;
		expect(onRing!.x).toBeCloseTo(5, 6);
		expect(onRing!.pressure).toBeCloseTo(0.4, 6);
		expect(onRing!.t).toBe(50);
		expect(onRing!.tiltX).toBeCloseTo(20, 6);
		expect(onRing!.tiltY).toBeCloseTo(40, 6);
		expect(end).toMatchObject({ x: 10, tiltX: 30, tiltY: 60 });
	});

	it("leaves tilt off a point born on the ring when only one end of its segment had tilt", () => {
		const onlyStart = splitStrokeByCircle(stroke([pt(0, 0, { tiltX: 10, tiltY: 20 }), pt(10, 0)]), 0, 0, 5, makeId);
		expect("tiltX" in onlyStart[0]!.points[0]!).toBe(false);
		expect("tiltY" in onlyStart[0]!.points[0]!).toBe(false);
		const onlyEnd = splitStrokeByCircle(stroke([pt(0, 0), pt(10, 0, { tiltX: 10, tiltY: 20 })]), 0, 0, 5, makeId);
		expect("tiltX" in onlyEnd[0]!.points[0]!).toBe(false);
		expect("tiltY" in onlyEnd[0]!.points[0]!).toBe(false);
		const xOnly = splitStrokeByCircle(stroke([pt(0, 0, { tiltX: 10 }), pt(10, 0, { tiltX: 30 })]), 0, 0, 5, makeId);
		expect(xOnly[0]!.points[0]!.tiltX).toBeCloseTo(20, 6);
		expect("tiltY" in xOnly[0]!.points[0]!).toBe(false);
		const yOnly = splitStrokeByCircle(stroke([pt(0, 0, { tiltY: 10 }), pt(10, 0, { tiltY: 30 })]), 0, 0, 5, makeId);
		expect(yOnly[0]!.points[0]!.tiltY).toBeCloseTo(20, 6);
		expect("tiltX" in yOnly[0]!.points[0]!).toBe(false);
	});

	it("keeps the end that sits exactly on the ring as the survivor, and invents no crossing for it", () => {
		const out = splitStrokeByCircle(stroke([pt(0, 0), pt(3, 0)]), 0, 0, 3, makeId);
		expect(out).toHaveLength(1);
		for (const p of out[0]!.points) {
			expect(Number.isFinite(p.x)).toBe(true);
			expect(Number.isFinite(p.y)).toBe(true);
			expect(Number.isFinite(p.pressure)).toBe(true);
		}
		expect(out[0]!.points[0]).toMatchObject({ x: 3, y: 0 });
	});

	it("a lone survivor on the ring, found by a stroke entering the circle, is given a second sample a hundredth to the right and a millisecond later", () => {
		const out = splitStrokeByCircle(stroke([pt(3, 0, { t: 40 }), pt(0, 0, { t: 80 })]), 0, 0, 3, makeId);
		expect(out).toHaveLength(1);
		const [first, second] = out[0]!.points;
		expect(out[0]!.points).toHaveLength(2);
		expect(first).toMatchObject({ x: 3, y: 0, t: 40 });
		expect(Number.isFinite(second!.x)).toBe(true);
		expect(second!.x).toBeCloseTo(3.01, 10);
		expect(second!.t).toBe(41);
	});

	it("leaves nothing of a stroke that has no samples, and does not throw for it", () => {
		expect(splitStrokeByCircle(stroke([]), 0, 0, 5, makeId)).toEqual([]);
	});

	it("takes the whole stroke when it lies inside, and returns an untouched stroke as itself", () => {
		const inside = stroke([pt(0, 0), pt(1, 0), pt(2, 0)]);
		expect(splitStrokeByCircle(inside, 0, 0, 5, makeId)).toEqual([]);
		const clear = stroke([pt(20, 0), pt(30, 0)]);
		expect(splitStrokeByCircle(clear, 0, 0, 5, makeId)).toEqual([clear]);
	});
});
