import { describe, expect, it } from "vitest";

import { splitStrokeByCircle } from "./Eraser";
import { InkStroke, computeBBox } from "./Stroke";

let n = 0;
const makeId = () => `piece-${++n}`;

function stroke(pts: Array<[number, number]>): InkStroke {
	const points = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: 1000 + i * 10 }));
	return {
		id: "original",
		tool: "pen",
		color: "#000000",
		width: 2,
		points,
		bbox: computeBBox(points, 4),
		createdAt: 1000,
	};
}

function length(s: InkStroke): number {
	let L = 0;
	for (let i = 1; i < s.points.length; i++) {
		L += Math.hypot(s.points[i]!.x - s.points[i - 1]!.x, s.points[i]!.y - s.points[i - 1]!.y);
	}
	return L;
}

const total = (ss: InkStroke[]) => ss.reduce((a, s) => a + length(s), 0);

describe("erasing twice at the same spot", () => {
	it("keeps both halves of a line (exact ring endpoints)", () => {
		const once = splitStrokeByCircle(stroke([[0, 0], [100, 0]]), 50, 0, 10, makeId);
		// The ring is the radius 10 plus the stroke's half-width 1.
		expect(once.map((p) => p.points.map((q) => q.x))).toEqual([[0, 39], [61, 100]]);
		const twice = once.flatMap((p) => splitStrokeByCircle(p, 50, 0, 10, makeId));
		expect(total(twice)).toBeCloseTo(78, 6);
	});

	it("keeps the survivors of a diagonal stroke (ring point from lerp)", () => {
		let lost = 0;
		for (let k = 0; k < 200; k++) {
			const ax = 3.7 * k + 0.13;
			const ay = 1.9 * k + 0.71;
			const bx = ax + 97.3 + (k % 7);
			const by = ay + 41.1 - (k % 11) * 3.3;
			const cx = (ax + bx) / 2 + 0.37;
			const cy = (ay + by) / 2 - 0.29;
			const once = splitStrokeByCircle(stroke([[ax, ay], [bx, by]]), cx, cy, 8, makeId);
			const twice = once.flatMap((p) => splitStrokeByCircle(p, cx, cy, 8, makeId));
			if (total(once) - total(twice) > 1e-6) lost++;
		}
		expect(lost).toBe(0);
	});
});
