import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lastSnapMiss, snapKindOf, snapStroke } from "./ShapeSnap";
import { InkPoint, InkStroke, computeBBox } from "./Stroke";

declare const process: { env: Record<string, string | undefined> };

/**
 * One-stroke arrows a hand might draw, at three sizes and four angles, held the way the pen holds (the overlay confirms
 * the dwell, so every point is the figure). The rows a hand draws often snap at the two larger sizes, with either hand and
 * at every angle; the shapes and letters that must stay as drawn stay so at every size. For each stroke that stays as
 * drawn the table names the check that turned it down. ARROW_MEASURE_OUT=<file> writes the table there.
 */

/** A seeded hand: the same wobble every run. */
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

/** The pen along a path of corners, a sample every 5 world units, each off by up to `amp`; it ends on the last corner. */
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

function strokeOf(points: InkPoint[]): InkStroke {
	return { id: "raw", tool: "pen", color: "#4b7bec", width: 2.2, points, bbox: computeBBox(points, 4.4), createdAt: 1 } as InkStroke;
}

/** What the pen's held stroke becomes: a kind, or "none" and the first check that turned it down. */
function outcome(points: InkPoint[]): { kind: string; why: string } {
	const s = snapStroke(strokeOf(points), true);
	if (s) return { kind: snapKindOf(s) ?? "?", why: "" };
	return { kind: "none", why: lastSnapMiss() ?? "(no reason)" };
}

/** Points in a frame of size `len` from (300, 300), turned by `deg` degrees. */
function frame(len: number, deg: number) {
	const r = (deg * Math.PI) / 180;
	const c = Math.cos(r);
	const s = Math.sin(r);
	return (x: number, y: number): Q => ({ x: 300 + (x * c - y * s) * len, y: 300 + (x * s + y * c) * len });
}

/** A barb end `barb` of the shaft back from the tip (1, 0), `deg` degrees off the shaft, on side `side`. */
function barbEnd(at: (x: number, y: number) => Q, barb: number, deg: number, side: 1 | -1): Q {
	const r = (deg * Math.PI) / 180;
	return at(1 - barb * Math.cos(r), side * barb * Math.sin(r));
}

type Row = { name: string; path: (at: (x: number, y: number) => Q) => Q[] };

/** Arrows drawn in one stroke, shaft from (0, 0) to the tip (1, 0) unless the row says otherwise. */
const ARROWS: Row[] = [
	{ name: "control: head 0.25 at 30 deg", path: (at) => [at(0, 0), at(1, 0), barbEnd(at, 0.25, 30, 1), at(1, 0), barbEnd(at, 0.25, 30, -1)] },
	{ name: "wide head: 0.25 at 65 deg", path: (at) => [at(0, 0), at(1, 0), barbEnd(at, 0.25, 65, 1), at(1, 0), barbEnd(at, 0.25, 65, -1)] },
	{ name: "narrow head: 0.25 at 15 deg", path: (at) => [at(0, 0), at(1, 0), barbEnd(at, 0.25, 15, 1), at(1, 0), barbEnd(at, 0.25, 15, -1)] },
	{ name: "small head: 0.1 at 30 deg", path: (at) => [at(0, 0), at(1, 0), barbEnd(at, 0.1, 30, 1), at(1, 0), barbEnd(at, 0.1, 30, -1)] },
	{
		name: "sloppy tip return: back to 0.08 short, 0.04 aside",
		path: (at) => [at(0, 0), at(1, 0), barbEnd(at, 0.25, 30, 1), at(0.92, -0.04), barbEnd(at, 0.25, 30, -1)],
	},
	{
		name: "curved shaft: bowed 0.08",
		path: (at) => {
			const pts: Q[] = [];
			for (let i = 0; i <= 10; i++) pts.push(at(i / 10, 0.32 * (i / 10) * (1 - i / 10)));
			return [...pts, barbEnd(at, 0.25, 30, 1), at(1, 0), barbEnd(at, 0.25, 30, -1)];
		},
	},
	{ name: "one short barb: 0.25 and 0.1", path: (at) => [at(0, 0), at(1, 0), barbEnd(at, 0.25, 30, 1), at(1, 0), barbEnd(at, 0.1, 30, -1)] },
	{ name: "head drawn first", path: (at) => [barbEnd(at, 0.25, 30, 1), at(1, 0), barbEnd(at, 0.25, 30, -1), at(1, 0), at(0, 0)] },
	{ name: "open head: no return to the tip", path: (at) => [at(0, 0), at(1, 0), barbEnd(at, 0.25, 30, 1), barbEnd(at, 0.25, 30, -1)] },
	{
		name: "closed triangle head",
		path: (at) => [at(0, 0), at(1, 0), barbEnd(at, 0.25, 30, 1), barbEnd(at, 0.25, 30, -1), at(1, 0)],
	},
];

/** The rows that snap to an arrow at the two larger sizes, with either hand and at every angle. */
const MUST_SNAP = [
	"control: head 0.25 at 30 deg",
	"wide head: 0.25 at 65 deg",
	"narrow head: 0.25 at 15 deg",
	"small head: 0.1 at 30 deg",
	"sloppy tip return: back to 0.08 short, 0.04 aside",
	"one short barb: 0.25 and 0.1",
	"head drawn first",
];
const SNAP_SIZES = [150, 400];
/**
 * Must-snap cells that a check other than the loosened ones turns down (row, hand, size, angle, the check). They stay as
 * drawn, so a change that moves them shows here.
 */
const NEEDS_OTHER_CHECK: Array<[string, string, number, number, string]> = [
	["small head: 0.1 at 30 deg", "loose", 150, 45, "an end has 0 barb(s) one side, 1 the other"],
	["small head: 0.1 at 30 deg", "loose", 150, 90, "barb at 139 deg, over 70"],
	["small head: 0.1 at 30 deg", "loose", 150, 200, "an end has 0 barb(s) one side, 1 the other"],
	["small head: 0.1 at 30 deg", "loose", 400, 0, "shaft not straight, 0.050 of it off its line, over 0.05"],
	["sloppy tip return: back to 0.08 short, 0.04 aside", "loose", 150, 200, "an end has 1 barb(s) one side, 2 the other"],
	["one short barb: 0.25 and 0.1", "loose", 150, 90, "an end has 0 barb(s) one side, 1 the other"],
];
/** Keep cells that already snapped to another shape before arrows loosened (row, hand, size, angle, kind). */
const SNAPPED_BEFORE: Array<[string, string, number, number, string]> = [["M", "loose", 60, 200, "rectangle"]];

/** An underline whose end flicks back up and to the left, `f` of its length. */
function flick(f: number): Row["path"] {
	const d = f / Math.SQRT2;
	return (at) => [at(0, 0), at(1, 0), at(1 - d, -d)];
}

/** Shapes and letters in one stroke that must stay as drawn. Frame height 1, y down. */
const KEEP: Row[] = [
	{ name: "check mark", path: (at) => [at(0, 0.6), at(0.3, 1), at(1, 0)] },
	{ name: "V", path: (at) => [at(0, 0), at(0.5, 1), at(1, 0)] },
	{ name: "zigzag", path: (at) => [at(0, 0), at(0.25, 0.3), at(0.5, 0), at(0.75, 0.3), at(1, 0)] },
	{ name: "4", path: (at) => [at(0.6, 0), at(0, 0.65), at(0.85, 0.65), at(0.6, 0.65), at(0.6, 1)] },
	{ name: "7", path: (at) => [at(0, 0), at(0.7, 0), at(0.25, 1)] },
	{ name: "k", path: (at) => [at(0, 0), at(0, 1), at(0, 0.6), at(0.55, 0.3), at(0.15, 0.6), at(0.6, 1)] },
	{ name: "v", path: (at) => [at(0, 0), at(0.4, 1), at(0.8, 0)] },
	{ name: "y", path: (at) => [at(0, 0), at(0.35, 0.55), at(0.7, 0), at(0.2, 1.3)] },
	{ name: "underline with a flick", path: (at) => [at(0, 0), at(1, 0), at(0.94, -0.06)] },
	{ name: "N", path: (at) => [at(0, 1), at(0, 0), at(0.7, 1), at(0.7, 0)] },
	{ name: "z", path: (at) => [at(0, 0), at(0.7, 0), at(0, 0.7), at(0.7, 0.7)] },
	{ name: "w", path: (at) => [at(0, 0), at(0.2, 1), at(0.4, 0.3), at(0.6, 1), at(0.8, 0)] },
	{ name: "M", path: (at) => [at(0, 1), at(0, 0), at(0.4, 0.6), at(0.8, 0), at(0.8, 1)] },
	{ name: "underline with a flick 0.1", path: flick(0.1) },
	{ name: "underline with a flick 0.15", path: flick(0.15) },
];

const SIZES = [60, 150, 400];
const ANGLES = [0, 45, 90, 200];
const HANDS: Array<[string, number]> = [
	["steady", 1],
	["loose", 3],
];

function measure(rows: Row[], seed0: number) {
	const out: Array<{ row: string; hand: string; size: number; angle: number; kind: string; why: string }> = [];
	let seed = seed0;
	for (const row of rows)
		for (const [hname, amp] of HANDS)
			for (const size of SIZES)
				for (const angle of ANGLES) out.push({ row: row.name, hand: hname, size, angle, ...outcome(drawn(row.path(frame(size, angle)), amp, seed++)) });
	return out;
}

describe("one-stroke arrows a hand draws snap; letters and marks stay as drawn", () => {
	const arrows = measure(ARROWS, 1000);
	const keep = measure(KEEP, 5000);

	it("every row has an outcome, and every miss names its check", () => {
		for (const r of [...arrows, ...keep]) if (r.kind === "none") expect(r.why, `${r.row} ${r.hand} ${r.size} ${r.angle}`).not.toBe("(no reason)");
	});

	for (const row of MUST_SNAP)
		it(`${row}: snaps to an arrow at shafts ${SNAP_SIZES.join(" and ")}, either hand, every angle`, () => {
			const cells = arrows.filter((r) => r.row === row && SNAP_SIZES.includes(r.size));
			expect(cells.length).toBe(SNAP_SIZES.length * ANGLES.length * HANDS.length);
			for (const r of cells) {
				const other = NEEDS_OTHER_CHECK.find(([row, hand, size, angle]) => row === r.row && hand === r.hand && size === r.size && angle === r.angle);
				const want = other ? `none arrow: ${other[4]}` : "arrow";
				expect(`${r.kind} ${r.why}`.trim(), `${r.hand} ${r.size} ${r.angle}`).toBe(want);
			}
		});

	for (const row of KEEP)
		it(`${row.name}: stays as drawn at every size, either hand, every angle`, () => {
			for (const r of keep.filter((k) => k.row === row.name)) {
				const before = SNAPPED_BEFORE.find(([name, hand, size, angle]) => name === r.row && hand === r.hand && size === r.size && angle === r.angle);
				expect(r.kind, `${r.hand} ${r.size} ${r.angle}`).toBe(before ? before[4] : "none");
			}
		});

	it("writes the table when asked", () => {
		const file = process.env.ARROW_MEASURE_OUT;
		if (!file) return;
		const lines = ["set\trow\thand\tsize\tangle\tkind\twhy"];
		for (const [set, rows] of [
			["arrow", arrows],
			["keep", keep],
		] as const)
			for (const r of rows) lines.push([set, r.row, r.hand, r.size, r.angle, r.kind, r.why].join("\t"));
		writeFileSync(file, lines.join("\n") + "\n");
	});
});
