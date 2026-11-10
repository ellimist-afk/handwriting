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
		const n = Math.max(4, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 5));
		for (let i = 0; i < n; i++) {
			const f = i / n;
			out.push({ x: a.x + (b.x - a.x) * f + jit(amp), y: a.y + (b.y - a.y) * f + jit(amp), pressure: 0.4, t: t++ * 10 });
		}
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

const at = (r: number, a: number): Q => ({ x: 300 + r * Math.cos(a), y: 300 + r * Math.sin(a) });
/** A star's outline of `points` points round (300, 300), its inner corners at `inner` of its radius, closed. */
function starOutline(r: number, turn: number, inner = 0.382, points = 5): Q[] {
	return Array.from({ length: 2 * points + 1 }, (_, i) => at(i % 2 ? r * inner : r, turn + (i * Math.PI) / points));
}
/** A pentagram: point to every second point, five lines, closed. */
function pentagram(r: number, turn: number): Q[] {
	return [0, 2, 4, 1, 3, 0].map((i) => at(r, turn + (i * 2 * Math.PI) / 5));
}
function regular(n: number, r: number, turn: number): Q[] {
	return Array.from({ length: n + 1 }, (_, i) => at(r, turn + (i * 2 * Math.PI) / n));
}

describe("a held five-point star snaps to a clean one", () => {
	for (const r of [30, 80, 200]) {
		for (const turn of [0, 0.5]) {
			it(`its outline, radius ${r}, turned ${turn} rad`, () => {
				const s = snapStroke(strokeOf(withDwell(drawn(starOutline(r, turn), 1, r + turn * 10))));
				expect(s).not.toBe(null);
				expect(snapKindOf(s!)).toBe("star");
				// Ten corners, in and out: the points on the drawn radius, the inner corners at 0.38 of it.
				const ring = s!.points.slice(0, -2);
				const cx = ring.reduce((a, p) => a + p.x, 0) / ring.length;
				const cy = ring.reduce((a, p) => a + p.y, 0) / ring.length;
				const radii = ring.map((p) => Math.hypot(p.x - cx, p.y - cy));
				expect(Math.abs(Math.max(...radii) - r)).toBeLessThan(r * 0.06 + 1);
				expect(Math.min(...radii) / Math.max(...radii)).toBeCloseTo(0.382, 1);
			});

			it(`a pentagram, radius ${r}, turned ${turn} rad`, () => {
				expect(snapsTo(drawn(pentagram(r, turn), 1, r + turn * 10 + 1))).toBe("star");
			});
		}
	}

	it("a fat star and a thin star are stars", () => {
		expect(snapsTo(drawn(starOutline(80, 0.2, 0.5), 1, 3))).toBe("star");
		expect(snapsTo(drawn(starOutline(80, 0.2, 0.3), 1, 4))).toBe("star");
	});
});

describe("what snapped before snaps the same, next to stars", () => {
	it("a pentagon is still a pentagon, a hexagon a hexagon", () => {
		expect(snapsTo(drawn(regular(5, 80, 0.2), 1, 5))).toBe("pentagon");
		expect(snapsTo(drawn(regular(6, 80, 0.2), 1, 6))).toBe("hexagon");
	});

	it("a triangle and a square snap as before", () => {
		expect(snapsTo(drawn(regular(3, 80, 0.2), 1, 7))).toBe("triangle");
		expect(snapsTo(drawn(regular(4, 80, Math.PI / 4), 1, 8))).toBe("rectangle");
	});

	it("a four-point and a six-point star stay as drawn", () => {
		expect(snapsTo(drawn(starOutline(80, 0.2, 0.4, 4), 1, 9))).toBe(null);
		expect(snapsTo(drawn(starOutline(80, 0.2, 0.5, 6), 1, 10))).toBe(null);
	});

	it("a five-petal flower stays as drawn", () => {
		const pts: InkPoint[] = [];
		for (let i = 0; i <= 120; i++) {
			const a = (i / 120) * 2 * Math.PI;
			const rr = 80 * (0.7 + 0.3 * Math.cos(5 * a));
			pts.push({ x: 300 + Math.cos(a) * rr, y: 300 + Math.sin(a) * rr, pressure: 0.4, t: i * 10 });
		}
		expect(snapsTo(pts)).toBe(null);
	});

	it("a star with one point well short stays as drawn", () => {
		const outline = starOutline(80, 0.2);
		outline[4] = at(80 * 0.6, 0.2 + (4 * Math.PI) / 5);
		expect(snapsTo(drawn(outline, 1, 12))).toBe(null);
	});

	it("a circle is still a circle", () => {
		const pts: InkPoint[] = [];
		const jit = hand(11);
		for (let i = 0; i <= 72; i++) {
			const a = (i / 72) * 2 * Math.PI;
			const rr = 80 * (1 + 0.05 * Math.sin(2 * a + 1) + jit(0.02));
			pts.push({ x: 300 + Math.cos(a) * rr, y: 300 + Math.sin(a) * rr, pressure: 0.4, t: i * 12 });
		}
		expect(snapsTo(pts)).toBe("circle");
	});

	it("a scribble stays as drawn", () => {
		const pts: InkPoint[] = [];
		for (let i = 0; i <= 80; i++) {
			pts.push({ x: i * 3 + Math.sin(i * 1.7) * 30, y: Math.cos(i * 2.3) * 40 + Math.sin(i * 0.9) * 25, pressure: 0.4, t: i * 10 });
		}
		expect(snapsTo(pts)).toBe(null);
	});
});
