import { describe, expect, it } from "vitest";
import { DWELL_MS, snapKindOf, snapStroke, type SnappedKind } from "./ShapeSnap";
import { InkPoint, InkStroke, computeBBox } from "./Stroke";

/**
 * A FIVE-POINT STAR DRAWN AS A PENTAGRAM AND STOPPED SHORT NEVER SNAPS TO A RECTANGLE.
 *
 * A pentagram drawn from one of its points, with the pen held a little before it gets back there, used to snap to a
 * four-corner box. The gap's own stretch is left out of the corner count, and the point the pen started on sits in it,
 * so four of the five points were left; three of the pentagram's five lines run along that four-corner outline, so it
 * passed the fit. A stopped-short star now snaps to a star or stays as drawn. Rectangles, closed or stopped short, snap
 * as before, and so does one whose closing line crosses its first where the two ends meet. Rectangles and triangles
 * from 60 to 400 wide with a looped corner snap as they did before the crossing check.
 *
 * The last cells pin three limits of the arrow and the star that nothing else holds: barbs past 70 degrees, a bowed
 * shaft, and a star outline stopped short with a point in its gap all stay as drawn.
 *
 * Strokes are built as in ShapeSnapStar.test.ts: a seeded hand's wobble along the path, one sample every 5 units, then a
 * held end.
 */

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

/** As drawn() with a wobble of 1 and then the path's last point, so the stroke ends where the path ends. */
function drawnToEnd(path: readonly Q[], seed: number): InkPoint[] {
	const jit = hand(seed);
	const out: InkPoint[] = [];
	let t = 0;
	for (let c = 0; c < path.length - 1; c++) {
		const a = path[c]!;
		const b = path[c + 1]!;
		const n = Math.max(4, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 5));
		for (let i = 0; i < n; i++) {
			const f = i / n;
			out.push({ x: a.x + (b.x - a.x) * f + jit(1), y: a.y + (b.y - a.y) * f + jit(1), pressure: 0.4, t: t++ * 10 });
		}
	}
	const end = path[path.length - 1]!;
	out.push({ x: end.x + jit(1), y: end.y + jit(1), pressure: 0.4, t: t++ * 10 });
	return out;
}

function withDwell(points: InkPoint[]): InkPoint[] {
	const last = points[points.length - 1]!;
	const out = [...points];
	for (let i = 1; i <= 6; i++) out.push({ x: last.x, y: last.y, pressure: 0.4, t: last.t + i * (DWELL_MS / 5) });
	return out;
}

function snapsTo(points: InkPoint[]): SnappedKind | null {
	const stroke = { id: "raw", tool: "pen", color: "#4b7bec", width: 2.2, points: withDwell(points), bbox: computeBBox(points, 4.4), createdAt: 1 } as InkStroke;
	const s = snapStroke(stroke);
	return s ? (snapKindOf(s) ?? null) : null;
}

const at = (r: number, a: number): Q => ({ x: 300 + r * Math.cos(a), y: 300 + r * Math.sin(a) });

/** Five lines from point to point, starting and ending on the first point. */
function pentagram(r: number, turn: number): Q[] {
	return [0, 2, 4, 1, 3, 0].map((i) => at(r, turn + (i * 2 * Math.PI) / 5));
}

/** A w by h rectangle about (300, 300), turned by `turn`, from one corner round to it again. */
function rectangle(w: number, h: number, turn: number): Q[] {
	const cos = Math.cos(turn), sin = Math.sin(turn);
	return [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([sx, sy]) => {
		const x = (sx! * w) / 2, y = (sy! * h) / 2;
		return { x: 300 + x * cos - y * sin, y: 300 + x * sin + y * cos };
	});
}

/** A shaft of `len` from (300, 300) along x, a barb of `barb` times it each side at `deg` off the shaft, leaning back. */
function arrow(len: number, barb: number, deg: number, bow = 0): Q[] {
	const l = len * barb;
	const r = (deg * Math.PI) / 180;
	const tip = { x: 300 + len, y: 300 };
	const shaft = Array.from({ length: 17 }, (_, i) => ({ x: 300 + (len * i) / 16, y: 300 + bow * Math.sin((Math.PI * i) / 16) }));
	return [...shaft, { x: tip.x - l * Math.cos(r), y: 300 + l * Math.sin(r) }, tip, { x: tip.x - l * Math.cos(r), y: 300 - l * Math.sin(r) }];
}

/** A star's outline, ten corners from a point round to it again, inner corners at the regular star's share. */
function starOutline(r: number, turn: number): Q[] {
	return Array.from({ length: 11 }, (_, i) => at(i % 2 ? r * 0.382 : r, turn + (i * Math.PI) / 5));
}

/** Cut a closed path short: keep the first `keep` share of its length, so the pen stops that far before its start. */
function cutShort(path: readonly Q[], keep: number): Q[] {
	let total = 0;
	for (let i = 1; i < path.length; i++) total += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
	const want = total * keep;
	const out: Q[] = [path[0]!];
	let sofar = 0;
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1]!;
		const b = path[i]!;
		const seg = Math.hypot(b.x - a.x, b.y - a.y);
		if (sofar + seg >= want) {
			const f = (want - sofar) / seg;
			out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
			return out;
		}
		out.push(b);
		sofar += seg;
	}
	return out;
}

describe("a pentagram drawn from a point and stopped short", () => {
	it.each([0.06, 0.1, 0.15])("stopped %s of its path short: a star or as drawn, never a rectangle", (gap) => {
		const kind = snapsTo(drawn(cutShort(pentagram(80, 0.4), 1 - gap), 1, Math.round(gap * 1000)));
		expect(kind, `a pentagram stopped ${gap} short snapped to ${kind}`).not.toBe("rectangle");
		expect([null, "star"], `a pentagram stopped ${gap} short snapped to ${kind}`).toContain(kind);
	});

	it.each([1, 2, 3])("larger and turned, stopped 0.08 short, hand %s: a star or as drawn, never a rectangle", (seed) => {
		const kind = snapsTo(drawn(cutShort(pentagram(120, 1.1), 0.92), 1, seed));
		expect(kind, `a pentagram stopped 0.08 short snapped to ${kind}`).not.toBe("rectangle");
		expect([null, "star"], `a pentagram stopped 0.08 short snapped to ${kind}`).toContain(kind);
	});
});

describe("control: rectangles still snap to rectangles", () => {
	const sizes: Array<[number, number]> = [[60, 40], [160, 100], [400, 240], [120, 120]];
	const turns = [0, 0.05, 0.4, Math.PI / 4];
	it.each(sizes)("a closed %s by %s rectangle at every turn", (w, h) => {
		for (const turn of turns) expect(snapsTo(drawn(rectangle(w, h, turn), 1, 7)), `turn ${turn}`).toBe("rectangle");
	});

	it.each([0.04, 0.08])("a 160 by 100 rectangle stopped %s of its path short", (gap) => {
		expect(snapsTo(drawn(cutShort(rectangle(160, 100, 0), 1 - gap), 1, 9))).toBe("rectangle");
	});
});

describe("control: closing a shape and crossing a shape", () => {
	it("a rectangle whose closing line runs past its start and crosses the first line still snaps to a rectangle", () => {
		// Begins 6 left of the top-left corner, ends 8 above it: the last line crosses the first where the two ends meet.
		const path = [{ x: 214, y: 250 }, { x: 380, y: 250 }, { x: 380, y: 350 }, { x: 220, y: 350 }, { x: 220, y: 242 }];
		expect(snapsTo(drawn(path, 1, 11))).toBe("rectangle");
	});

	it("a figure 8 stays as drawn", () => {
		const path = Array.from({ length: 65 }, (_, i) => {
			const t = (i * 2 * Math.PI) / 64;
			return { x: 300 + 120 * Math.sin(t), y: 300 + 60 * Math.sin(t) * Math.cos(t) };
		});
		expect(snapsTo(drawn(path, 1, 13))).toBeNull();
	});
});

describe("a corner drawn with a small loop is no crossing", () => {
	const loops = [4, 8, 12].flatMap((r) => [34, 35, 36].map((seed) => [r, seed] as const));

	it.each(loops)("a 200 by 120 rectangle, its top-right corner looped %s, hand %s, snaps to a rectangle", (r, seed) => {
		// Past the corner, up, back left, down across the top line, then on down the right side.
		const path = [
			{ x: 200, y: 200 }, { x: 400 + r, y: 200 }, { x: 400 + r, y: 200 - r }, { x: 400 - r / 2, y: 200 - r },
			{ x: 400 - r / 2, y: 200 + r }, { x: 400, y: 200 + 2 * r }, { x: 400, y: 320 }, { x: 200, y: 320 }, { x: 200, y: 200 },
		];
		expect(snapsTo(drawnToEnd(path, seed))).toBe("rectangle");
	});

	it.each(loops)("a 200 by 140 triangle, its apex looped %s, hand %s, snaps to a triangle", (r, seed) => {
		const path = [
			{ x: 200, y: 340 }, { x: 300, y: 200 - r }, { x: 300 + r, y: 200 - 2 * r }, { x: 300 - r, y: 200 - 2 * r },
			{ x: 300 + r / 2, y: 200 + r }, { x: 400, y: 340 }, { x: 200, y: 340 },
		];
		expect(snapsTo(drawnToEnd(path, seed))).toBe("triangle");
	});

	// The same loops on rectangles and triangles from small to large. A loop is a larger share of a small shape's outline,
	// so it crosses further apart along the ring there. Every size and loop that snapped all three hands to its kind on
	// 1.5.0 before the crossing check is here; the nine left out did not (the loop is too much of the shape): the 60 by 40
	// rectangle looped 16 and 20, the 100 by 60 looped 20, the 60 by 42 triangle looped 8 to 20, the 100 by 70 looped 16
	// and 20.
	const loopsBySize = [0, 3, 4, 6, 8, 12, 16, 20];
	const leftOut = new Set(["rectangle 60 40 16", "rectangle 60 40 20", "rectangle 100 60 20", "triangle 60 42 8", "triangle 60 42 12",
		"triangle 60 42 16", "triangle 60 42 20", "triangle 100 70 16", "triangle 100 70 20"]);
	const bySize = ([["rectangle", 60, 40], ["rectangle", 100, 60], ["rectangle", 200, 120], ["rectangle", 400, 240], ["triangle", 60, 42],
		["triangle", 100, 70], ["triangle", 200, 140], ["triangle", 400, 280]] as const)
		.flatMap(([kind, w, h]) => loopsBySize.map((r) => [kind, w, h, r] as const))
		.filter(([kind, w, h, r]) => !leftOut.has(`${kind} ${w} ${h} ${r}`));

	it.each(bySize)("a %s %s by %s, a corner looped %s, snaps to its kind with every hand", (kind, w, h, r) => {
		let path: Q[];
		if (kind === "rectangle") {
			path = r === 0
				? [{ x: 200, y: 200 }, { x: 200 + w, y: 200 }, { x: 200 + w, y: 200 + h }, { x: 200, y: 200 + h }, { x: 200, y: 200 }]
				: [
					{ x: 200, y: 200 }, { x: 200 + w + r, y: 200 }, { x: 200 + w + r, y: 200 - r }, { x: 200 + w - r / 2, y: 200 - r },
					{ x: 200 + w - r / 2, y: 200 + r }, { x: 200 + w, y: 200 + 2 * r }, { x: 200 + w, y: 200 + h }, { x: 200, y: 200 + h },
					{ x: 200, y: 200 },
				];
		} else {
			const ax = 200 + w / 2, ay = 340 - h;
			path = r === 0
				? [{ x: 200, y: 340 }, { x: ax, y: ay }, { x: 200 + w, y: 340 }, { x: 200, y: 340 }]
				: [
					{ x: 200, y: 340 }, { x: ax, y: ay - r }, { x: ax + r, y: ay - 2 * r }, { x: ax - r, y: ay - 2 * r }, { x: ax + r / 2, y: ay + r },
					{ x: 200 + w, y: 340 }, { x: 200, y: 340 },
				];
		}
		const got = [34, 35, 36].map((seed) => snapsTo(drawnToEnd(path, seed)));
		expect(got.join(","), "hands 34, 35, 36").toBe(`${kind},${kind},${kind}`);
	});
});

describe("a closing line that runs on past the start", () => {
	const sizes: Array<[number, number]> = [[60, 40], [200, 120], [400, 240]];

	// Each of the next two holds one of the crossing check's two allowances alone: with the other taken out it still
	// snaps, with its own taken out it stays as drawn.
	it.each(sizes)("a %s by %s rectangle whose closing line runs back over its top edge and down across it snaps to a rectangle", (w, h) => {
		// Round from the top-left corner, up past it by 0.03 of the outline, back along above the top edge for 0.3 of it,
		// then down across the top edge by 0.03. The crossing sits where the pen's two ends meet.
		const P = 2 * (w + h);
		const path = [
			{ x: 200, y: 200 }, { x: 200 + w, y: 200 }, { x: 200 + w, y: 200 + h }, { x: 200, y: 200 + h }, { x: 200, y: 200 - 0.03 * P },
			{ x: 200 + 0.3 * P, y: 200 - 0.03 * P }, { x: 200 + 0.3 * P, y: 200 + 0.03 * P },
		];
		const got = [34, 35, 36].map((seed) => snapsTo(drawnToEnd(path, seed)));
		expect(got.join(","), "hands 34, 35, 36").toBe("rectangle,rectangle,rectangle");
	});

	it.each(sizes)("a %s by %s rectangle stopped short and closed by a slash up across its top edge snaps to a rectangle", (w, h) => {
		// Round from the top-left corner, stopped 0.12 of the outline below it on the left side, then a line at 60 degrees up
		// and to the right across the top edge, on past it by 0.1 of the outline. The two lines that cross lie either side
		// of the start, close together going round one way and far apart going round the other.
		const P = 2 * (w + h);
		const ey = 0.12 * P, r = Math.PI / 3, t = ey / Math.sin(r) + 0.1 * P;
		const path = [
			{ x: 200, y: 200 }, { x: 200 + w, y: 200 }, { x: 200 + w, y: 200 + h }, { x: 200, y: 200 + h }, { x: 200, y: 200 + ey },
			{ x: 200 + t * Math.cos(r), y: 200 + ey - t * Math.sin(r) },
		];
		const got = [34, 35, 36].map((seed) => snapsTo(drawnToEnd(path, seed)));
		expect(got.join(","), "hands 34, 35, 36").toBe("rectangle,rectangle,rectangle");
	});
});

describe("the arrow's and the star's limits", () => {
	it("a head whose barbs stand out 75 degrees from the shaft is no arrow", () => {
		expect(snapsTo(drawn(arrow(150, 0.25, 30), 1, 100)), "precondition: the same arrow at 30 degrees snaps").toBe("arrow");
		for (const [barb, seed] of [[0.25, 100], [0.5, 125]] as const) {
			expect(snapsTo(drawn(arrow(150, barb, 75), 1, seed)), `barbs ${barb} of the shaft at 75 degrees`).not.toBe("arrow");
		}
	});

	it("an arrow whose shaft bows out past the line's slack stays as drawn", () => {
		expect(snapsTo(drawn(arrow(150, 0.5, 60), 0.5, 17)), "precondition: the straight arrow snaps").toBe("arrow");
		expect(snapsTo(drawn(arrow(150, 0.5, 60, 8.7), 0.5, 17)), "a bowed shaft snapped to an arrow").not.toBe("arrow");
	});

	it("a star outline drawn from a point and stopped 0.10 short, the point in the gap, stays as drawn", () => {
		expect(snapsTo(drawn(starOutline(80, 0.4), 1, 5)), "precondition: the whole outline snaps to a star").toBe("star");
		expect(snapsTo(drawn(cutShort(starOutline(80, 0.4), 0.9), 1, 100))).toBeNull();
	});
});
