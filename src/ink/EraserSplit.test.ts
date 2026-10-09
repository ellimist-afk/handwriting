import { describe, expect, it } from "vitest";

import { splitStrokeByCircle } from "./Eraser";
import { InkStroke } from "./Stroke";

let n = 0;
const makeId = () => `piece-${++n}`;

function line(xs: number[]): InkStroke {
	const points = xs.map((x, i) => ({ x, y: 0, pressure: 0.5, t: 1000 + i }));
	return {
		id: "original",
		tool: "pen",
		color: "#4b7bec",
		width: 2,
		points,
		bbox: { x: 0, y: 0, width: 0, height: 0 },
		createdAt: 1000,
	};
}

describe("partial erase", () => {
	it("returns the very same stroke when the circle misses", () => {
		const s = line([0, 10, 20]);
		const out = splitStrokeByCircle(s, 500, 500, 5, makeId);
		// Identity, not just equality: an eraser pass over untouched ink must
		// not rewrite anything.
		expect(out).toHaveLength(1);
		expect(out[0]).toBe(s);
	});

	it("takes everything when the circle covers the stroke", () => {
		expect(splitStrokeByCircle(line([0, 5, 10]), 5, 0, 50, makeId)).toEqual([]);
	});

	it("splits a line erased through the middle into two", () => {
		const out = splitStrokeByCircle(line([0, 10, 20, 30, 40]), 20, 0, 5, makeId);
		expect(out).toHaveLength(2);
		// The ends of the gap sit on the ring at 14 and 26 (the 5 radius plus the
		// line's half-width of 1), not at the samples either side of it.
		expect(out[0]!.points.map((p) => p.x)).toEqual([0, 10, 14]);
		expect(out[1]!.points.map((p) => p.x)).toEqual([26, 30, 40]);
	});

	it("trims an end without splitting", () => {
		const out = splitStrokeByCircle(line([0, 10, 20, 30]), 30, 0, 5, makeId);
		expect(out).toHaveLength(1);
		expect(out[0]!.points.map((p) => p.x)).toEqual([0, 10, 20, 24]);
	});

	it("gives every surviving piece its own id and keeps the nib", () => {
		const s = line([0, 10, 20, 30, 40]);
		const out = splitStrokeByCircle(s, 20, 0, 5, makeId);
		expect(out[0]!.id).not.toBe(s.id);
		expect(out[1]!.id).not.toBe(out[0]!.id);
		expect(out[0]!.tool).toBe(s.tool);
		expect(out[0]!.color).toBe(s.color);
		expect(out[0]!.width).toBe(s.width);
	});

	it("recomputes the box so the survivor does not claim erased ground", () => {
		const out = splitStrokeByCircle(line([0, 10, 20, 30]), 30, 0, 5, makeId);
		expect(out[0]!.bbox.x + out[0]!.bbox.width).toBeLessThan(30);
	});

	it("keeps a lone surviving point as a dot", () => {
		const out = splitStrokeByCircle(line([0, 20, 40]), 20, 0, 5, makeId);
		// 0 and 40 survive as separate single points; both stay drawable.
		expect(out).toHaveLength(2);
		expect(out[0]!.points.length).toBeGreaterThanOrEqual(2);
		expect(out[1]!.points.length).toBeGreaterThanOrEqual(2);
	});
});

describe("cutting where the stroke crosses the ring", () => {
	it("erases a fast stroke whose samples straddle the circle", () => {
		// THE BUG: two samples 40 apart, a 5-radius ring at x=20 between them.
		// Neither sample is inside, so dropping whole samples took nothing and
		// the eraser passed straight through a quick line.
		const out = splitStrokeByCircle(line([0, 40]), 20, 0, 5, makeId);
		expect(out).toHaveLength(2);
		// The ring is the 5 radius plus the line's half-width of 1.
		expect(out[0]!.points.at(-1)!.x).toBeCloseTo(14, 6);
		expect(out[1]!.points[0]!.x).toBeCloseTo(26, 6);
	});

	it("cuts at the ring, not at the nearest stored sample", () => {
		const out = splitStrokeByCircle(line([0, 10, 20, 30]), 30, 0, 8, makeId);
		expect(out).toHaveLength(1);
		// The survivor ends exactly on the ring at x=21 (8 plus the half-width 1 from x=30), not back at x=20.
		expect(out[0]!.points.at(-1)!.x).toBeCloseTo(21, 6);
	});

	it("starts a survivor on the ring when the stroke leaves the circle", () => {
		const out = splitStrokeByCircle(line([0, 10, 20, 30]), 0, 0, 8, makeId);
		expect(out).toHaveLength(1);
		expect(out[0]!.points[0]!.x).toBeCloseTo(9, 6);
	});

	it("blends pressure into the point born on the ring", () => {
		const s = line([0, 40]);
		s.points[0]!.pressure = 0;
		s.points[1]!.pressure = 1;
		const out = splitStrokeByCircle(s, 20, 0, 5, makeId);
		// The cut at x=14 is 35% along a 0 to 1 ramp.
		expect(out[0]!.points.at(-1)!.pressure).toBeCloseTo(0.35, 6);
	});

	it("still leaves a stroke alone when the ring misses it entirely", () => {
		const s = line([0, 10, 20]);
		expect(splitStrokeByCircle(s, 200, 200, 5, makeId)[0]).toBe(s);
	});

	it("copies no point when the circle only touches the stroke: a held eraser costs nothing per sample", () => {
		// The last point sits exactly on the ring (centre at x=40 + radius 5 + half-width 1), so the circle touches the
		// stroke and cuts nothing. Spreading a point reads every field, so a counted pressure shows any copy.
		const s = line([0, 10, 20, 30, 40]);
		let reads = 0;
		for (const p of s.points) {
			const pressure = p.pressure;
			Object.defineProperty(p, "pressure", { enumerable: true, get: () => (reads++, pressure) });
		}
		const out = splitStrokeByCircle(s, 46, 0, 5, makeId);
		expect(out).toHaveLength(1);
		expect(out[0], "the touch returns the stroke itself").toBe(s);
		expect(reads, "no point was copied").toBe(0);
	});
});
