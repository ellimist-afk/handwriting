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

/** The pen along a path of corners, a sample every 5 world units, each sample off by up to `amp`; it ends on the last corner. */
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
	const last = path[path.length - 1]!;
	out.push({ x: last.x, y: last.y, pressure: 0.4, t: t * 10 });
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

function snapped(points: InkPoint[]): InkStroke | null {
	return snapStroke(strokeOf(withDwell(points)));
}

/** What a held stroke snaps to: its kind, or null when it stays as drawn. */
function snapsTo(points: InkPoint[]): SnappedKind | null {
	const s = snapped(points);
	return s ? (snapKindOf(s) ?? null) : null;
}

/**
 * The points of an arrow of shaft `len` from (300, 300), turned by `turn`: its tail, tip, the barb ends at the tip (b1,
 * b2) and at the tail (a1, a2), barbs `barb` of the shaft long at `deg` degrees off it.
 */
function arrow(len: number, turn: number, barb = 0.25, deg = 30) {
	const c = Math.cos(turn);
	const s = Math.sin(turn);
	const at = (x: number, y: number): Q => ({ x: 300 + x * c - y * s, y: 300 + x * s + y * c });
	const l = len * barb;
	const r = (deg * Math.PI) / 180;
	return {
		tail: at(0, 0),
		tip: at(len, 0),
		b1: at(len - l * Math.cos(r), l * Math.sin(r)),
		b2: at(len - l * Math.cos(r), -l * Math.sin(r)),
		a1: at(l * Math.cos(r), l * Math.sin(r)),
		a2: at(l * Math.cos(r), -l * Math.sin(r)),
		past: at(len + l, 0),
		at,
	};
}

const near = (p: Q, q: Q, tol: number): boolean => Math.hypot(p.x - q.x, p.y - q.y) <= tol;

describe("a held arrow snaps to a clean one", () => {
	for (const len of [60, 150, 400]) {
		for (const turn of [0, 2.5]) {
			it(`shaft then head, shaft ${len}, turned ${turn} rad`, () => {
				const a = arrow(len, turn);
				const s = snapped(drawn([a.tail, a.tip, a.b1, a.tip, a.b2], 1, len + turn * 10));
				expect(s).not.toBe(null);
				expect(snapKindOf(s!)).toBe("arrow");
				// The shaft runs tail to tip and the head's two barbs are the same length either side of it.
				const pts = s!.points;
				expect(near(pts[0]!, a.tail, 4)).toBe(true);
				const tipAt = pts.reduce((best, p) => (Math.hypot(p.x - a.tail.x, p.y - a.tail.y) > Math.hypot(best.x - a.tail.x, best.y - a.tail.y) ? p : best));
				expect(near(tipAt, a.tip, 4)).toBe(true);
				const side = (p: Q): number => ((a.tip.x - a.tail.x) * (p.y - a.tail.y) - (a.tip.y - a.tail.y) * (p.x - a.tail.x)) / len;
				const left = pts.reduce((m, p) => (side(p) < side(m) ? p : m));
				const right = pts.reduce((m, p) => (side(p) > side(m) ? p : m));
				const barbL = Math.hypot(left.x - tipAt.x, left.y - tipAt.y);
				const barbR = Math.hypot(right.x - tipAt.x, right.y - tipAt.y);
				expect(Math.abs(barbL - barbR)).toBeLessThan(0.5);
				expect(Math.abs(barbL - len * 0.25)).toBeLessThan(len * 0.06);
			});

			it(`head then shaft, shaft ${len}, turned ${turn} rad`, () => {
				const a = arrow(len, turn);
				expect(snapsTo(drawn([a.b1, a.tip, a.b2, a.tip, a.tail], 1, len + turn * 10 + 1))).toBe("arrow");
			});

			it(`a head at both ends, shaft ${len}, turned ${turn} rad`, () => {
				const a = arrow(len, turn);
				expect(snapsTo(drawn([a.a1, a.tail, a.a2, a.tail, a.tip, a.b1, a.tip, a.b2], 1, len + turn * 10 + 2))).toBe("double-arrow");
			});
		}
	}

	it("a head drawn as a closed triangle is an arrow", () => {
		const a = arrow(150, 0.7);
		expect(snapsTo(drawn([a.tail, a.tip, a.b1, a.b2, a.tip], 1, 5))).toBe("arrow");
	});

	it("a wide head at 45 degrees is an arrow", () => {
		const a = arrow(150, 0.7, 0.35, 45);
		expect(snapsTo(drawn([a.tail, a.tip, a.b1, a.tip, a.b2], 1, 6))).toBe("arrow");
	});
});

describe("what snapped before snaps the same, next to arrows", () => {
	for (const len of [60, 150, 400]) {
		it(`a line of ${len} is still a line`, () => {
			const a = arrow(len, 0.3);
			expect(snapsTo(drawn([a.tail, a.tip], 1, len))).toBe("line");
		});
	}

	it("a line with one barb (a hook) stays as drawn", () => {
		const a = arrow(150, 0.3);
		expect(snapsTo(drawn([a.tail, a.tip, a.b1], 1, 7))).toBe(null);
		expect(snapsTo(drawn([a.tail, a.tip, a.b1, a.tip], 1, 8))).toBe(null);
	});

	it("a tick, an L and a Z stay as drawn", () => {
		const a = arrow(150, 0.3);
		expect(snapsTo(drawn([a.at(0, 0), a.at(40, 40), a.at(150, -60)], 1, 9))).toBe(null);
		expect(snapsTo(drawn([a.at(0, 0), a.at(150, 0), a.at(150, 90)], 1, 10))).toBe(null);
		expect(snapsTo(drawn([a.at(0, 0), a.at(150, 0), a.at(0, 75), a.at(150, 75)], 1, 11))).toBe(null);
	});

	it("a line that runs on past where the barbs meet it stays as drawn", () => {
		const a = arrow(150, 0.3);
		expect(snapsTo(drawn([a.tail, a.tip, a.b1, a.tip, a.b2, a.tip, a.past], 1, 12))).toBe(null);
	});

	it("a wave and a scribble stay as drawn", () => {
		const wave: InkPoint[] = [];
		for (let i = 0; i <= 60; i++) wave.push({ x: i * 5, y: 100 + Math.sin(i / 4) * 20, pressure: 0.4, t: i * 10 });
		expect(snapsTo(wave)).toBe(null);
		const scribble: InkPoint[] = [];
		for (let i = 0; i <= 80; i++) {
			scribble.push({ x: i * 3 + Math.sin(i * 1.7) * 30, y: Math.cos(i * 2.3) * 40 + Math.sin(i * 0.9) * 25, pressure: 0.4, t: i * 10 });
		}
		expect(snapsTo(scribble)).toBe(null);
	});
});
