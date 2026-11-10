import { describe, expect, it } from "vitest";
import { DWELL_MS, snapKindOf, snapStroke, type SnappedKind } from "./ShapeSnap";
import { InkPoint, InkStroke, computeBBox } from "./Stroke";

/** A seeded hand: the same wobble every run, so the cells never flake. */
function hand(seed: number): (amp: number) => number {
	let s = seed | 0;
	return (amp) => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1) * amp;
	};
}

interface Q {
	x: number;
	y: number;
}

/** The pen along a path of corners, a sample every 5 world units, each sample off by up to `amp`. */
function drawn(path: readonly Q[], amp: number, seed: number): InkPoint[] {
	const jit = hand(seed);
	const out: InkPoint[] = [];
	let t = 0;
	for (let c = 0; c < path.length - 1; c++) {
		const a = path[c]!;
		const b = path[c + 1]!;
		const n = Math.max(6, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 5));
		for (let i = 0; i < n; i++) {
			const f = i / n;
			out.push({ x: a.x + (b.x - a.x) * f + jit(amp), y: a.y + (b.y - a.y) * f + jit(amp), pressure: 0.4, t: t++ * 10 });
		}
	}
	return out;
}

/** The corners of a regular figure of n sides round (200, 200), closed back to the first. */
function regular(n: number, r: number, turn: number): Q[] {
	return Array.from({ length: n + 1 }, (_, i) => {
		const a = turn + (2 * Math.PI * i) / n;
		return { x: 200 + r * Math.cos(a), y: 200 + r * Math.sin(a) };
	});
}

/** A hand circle: a slow egg-shaped wobble of `wobble` of the radius and a jitter of `jitter` of it at every sample. */
function handCircle(r: number, wobble: number, jitter: number, seed: number): InkPoint[] {
	const jit = hand(seed);
	const out: InkPoint[] = [];
	for (let i = 0; i <= 72; i++) {
		const a = (i / 72) * 2 * Math.PI;
		const rr = r * (1 + wobble * (0.6 * Math.sin(2 * a + 1) + 0.4 * Math.sin(3 * a)) + jit(jitter));
		out.push({ x: 200 + Math.cos(a) * rr, y: 200 + Math.sin(a) * rr, pressure: 0.4, t: i * 12 });
	}
	return out;
}

/** Append a stationary hold at the final point, so the snap is requested. */
function withDwell(points: InkPoint[]): InkPoint[] {
	const last = points[points.length - 1]!;
	const out = [...points];
	for (let i = 1; i <= 6; i++) out.push({ x: last.x, y: last.y, pressure: 0.4, t: last.t + i * (DWELL_MS / 5) });
	return out;
}

function strokeOf(points: InkPoint[]): InkStroke {
	return { id: "raw", tool: "pen", color: "#4b7bec", width: 2.2, points, bbox: computeBBox(points, 4.4), createdAt: 1 } as InkStroke;
}

/** What a held stroke snaps to: its kind, or null when it stays as drawn. */
function snapsTo(points: InkPoint[]): SnappedKind | null {
	const s = snapStroke(strokeOf(withDwell(points)));
	return s ? (snapKindOf(s) ?? null) : null;
}

/** Furthest over nearest distance of the outline from its centre: 1 / cos(180 deg / n) for a regular figure of n sides. */
function spread(points: readonly InkPoint[]): number {
	const ring = points.slice(0, -2);
	const cx = ring.reduce((a, p) => a + p.x, 0) / ring.length;
	const cy = ring.reduce((a, p) => a + p.y, 0) / ring.length;
	const radii = ring.map((p) => Math.hypot(p.x - cx, p.y - cy));
	return Math.max(...radii) / Math.min(...radii);
}

const FIGURES: Array<[SnappedKind, number]> = [
	["pentagon", 5],
	["hexagon", 6],
	["octagon", 8],
];

describe("regular figures of five, six and eight sides snap", () => {
	for (const [kind, n] of FIGURES) {
		for (const r of [25, 60, 150]) {
			for (const turn of [0, 0.4]) {
				it(`a held hand ${kind}, radius ${r}, turned ${turn} rad, becomes a regular ${kind}`, () => {
					const s = snapStroke(strokeOf(withDwell(drawn(regular(n, r, turn), 1, n * 1000 + r + turn * 10))));
					expect(s).not.toBe(null);
					expect(snapKindOf(s!)).toBe(kind);
					expect(spread(s!.points)).toBeCloseTo(1 / Math.cos(Math.PI / n), 1);
					// The size it was drawn at: the corners stay on the drawn radius (the box also holds the pen's width each side).
					const b = s!.bbox;
					expect(b.width).toBeGreaterThan(r * 1.5);
					expect(b.width).toBeLessThan(r * 2 + 12);
				});
			}
		}
	}

	it("a hexagon started halfway along a side still becomes a hexagon", () => {
		const c = regular(6, 60, 0);
		const mid = { x: (c[0]!.x + c[1]!.x) / 2, y: (c[0]!.y + c[1]!.y) / 2 };
		expect(snapsTo(drawn([mid, ...c.slice(1, 6), c[0]!, mid], 1, 61))).toBe("hexagon");
	});
});

describe("what snapped before snaps the same", () => {
	for (const r of [25, 60, 150]) {
		it(`a wobbly hand circle, radius ${r}, is still a circle`, () => {
			expect(snapsTo(handCircle(r, 0.08, 0.02, r))).toBe("circle");
			expect(snapsTo(handCircle(r, 0, 0.04, r + 1))).toBe("circle");
		});
	}

	it("a triangle is still a triangle", () => {
		expect(snapsTo(drawn(regular(3, 60, 0.3), 1, 3))).toBe("triangle");
	});

	it("a square is still a rectangle", () => {
		expect(snapsTo(drawn(regular(4, 60, Math.PI / 4), 1, 4))).toBe("rectangle");
	});

	it("a line is still a line", () => {
		expect(snapsTo(drawn([{ x: 0, y: 0 }, { x: 200, y: 30 }], 1, 2))).toBe("line");
	});

	it("an open figure, four sides of a pentagon, stays as drawn", () => {
		expect(snapsTo(drawn(regular(5, 60, 0).slice(0, 5), 1, 5))).toBe(null);
	});

	it("a seven-sided figure stays as drawn", () => {
		expect(snapsTo(drawn(regular(7, 60, 0), 1, 7))).toBe(null);
	});

	it("a house (a roof on a square) stays as drawn", () => {
		const house = [{ x: 0, y: 60 }, { x: 0, y: 160 }, { x: 100, y: 160 }, { x: 100, y: 60 }, { x: 50, y: 0 }, { x: 0, y: 60 }];
		expect(snapsTo(drawn(house, 1, 9))).toBe(null);
	});

	it("a scribble stays as drawn", () => {
		const pts: InkPoint[] = [];
		for (let i = 0; i <= 80; i++) {
			pts.push({ x: i * 3 + Math.sin(i * 1.7) * 30, y: Math.cos(i * 2.3) * 40 + Math.sin(i * 0.9) * 25, pressure: 0.4, t: i * 10 });
		}
		expect(snapsTo(pts)).toBe(null);
	});
});
