/**
 * The disc-winding regression the ipad found (2026-08-26). fillRibbon used
 * to guess one winding for the whole stroke from quad 0's signed area. A
 * stationary pen repeats coordinates, quad 0 collapses to zero area, its
 * sign is numeric noise, and a wrong guess makes every cap and joint disc
 * subtract: at one-sample-per-frame density a tight loop carries a joint
 * disc at nearly every point, so the whole stroke was eaten, differently
 * from frame to frame. These tests pin the fix: every emitted quad winds
 * negative by construction and every disc is traced anticlockwise, so
 * nothing in the path can subtract, whatever the centerline looks like.
 */

import { describe, expect, it } from "vitest";
import { CameraState } from "../camera/coordinates";
import { RibbonPt } from "./Ribbon";
import { fillRibbon, signedArea } from "./RibbonRenderer";

const CAM: CameraState = { x: 0, y: 0, zoom: 1 };

// ---- recording context ------------------------------------------------------

type Quad = Array<[number, number]>;

function recordingCtx() {
	const quads: Quad[] = [];
	const arcs: boolean[] = [];
	let current: Quad | null = null;
	let fills = 0;
	const ctx = {
		fillStyle: "",
		beginPath() {},
		moveTo(x: number, y: number) {
			current = [[x, y]];
		},
		lineTo(x: number, y: number) {
			current?.push([x, y]);
		},
		closePath() {
			if (current && current.length === 4) quads.push(current);
			current = null;
		},
		arc(
			_x: number,
			_y: number,
			_r: number,
			_a0: number,
			_a1: number,
			anticlockwise?: boolean
		) {
			arcs.push(anticlockwise === true);
		},
		fill() {
			fills++;
		},
	};
	return {
		ctx: ctx as unknown as CanvasRenderingContext2D,
		quads,
		arcs,
		get fills() {
			return fills;
		},
	};
}

// ---- centerlines ------------------------------------------------------------

/** A gentle, well-behaved stroke: no repeated points, shallow turns. */
function straightish(): RibbonPt[] {
	const pts: RibbonPt[] = [];
	for (let i = 0; i < 8; i++) pts.push({ x: 10 + i * 6, y: 20 + i, hw: 2 });
	return pts;
}

/**
 * The regression shape: the pen lands and sits (repeated coordinates, so
 * quad 0 is degenerate), then draws a loop tight enough that the half-width
 * exceeds the radius of curvature, at the ipad's one-sample-per-frame
 * spacing.
 */
function stationaryThenLoop(): RibbonPt[] {
	const pts: RibbonPt[] = [
		{ x: 100, y: 100, hw: 4 },
		{ x: 100, y: 100, hw: 4 },
		{ x: 100, y: 100, hw: 4 },
	];
	const r = 3; // radius below hw: the inner offset must cross itself
	for (let k = 0; k <= 12; k++) {
		const a = (k / 12) * Math.PI * 2;
		pts.push({ x: 100 + r * Math.cos(a), y: 100 + r * Math.sin(a), hw: 4 });
	}
	return pts;
}

// ---- the pin ----------------------------------------------------------------

const EPS = 1e-9;

describe("fillRibbon winding is enforced, never guessed", () => {
	it("well-behaved stroke: all quads negative, all discs anticlockwise", () => {
		const rec = recordingCtx();
		fillRibbon(rec.ctx, CAM, straightish(), "#000");
		expect(rec.quads.length).toBeGreaterThan(0);
		for (const q of rec.quads) {
			expect(signedArea(q)).toBeLessThanOrEqual(EPS);
		}
		expect(rec.arcs.length).toBeGreaterThanOrEqual(2); // two caps at least
		expect(rec.arcs.every((a) => a)).toBe(true);
		expect(rec.fills).toBe(1);
	});

	it("stationary start into a tight loop: nothing in the path can subtract", () => {
		const rec = recordingCtx();
		fillRibbon(rec.ctx, CAM, stationaryThenLoop(), "#000");
		// The old failure needed only one wrongly-signed piece. No emitted
		// quad may wind positive, degenerate or not, and every disc must
		// trace anticlockwise to match.
		for (const q of rec.quads) {
			expect(signedArea(q)).toBeLessThanOrEqual(EPS);
		}
		// A loop this tight turns hard at every point: joint discs expected
		// beyond the two caps.
		expect(rec.arcs.length).toBeGreaterThan(2);
		expect(rec.arcs.every((a) => a)).toBe(true);
	});

	it("a dot still renders as one disc", () => {
		const rec = recordingCtx();
		fillRibbon(rec.ctx, CAM, [{ x: 5, y: 5, hw: 2 }], "#000");
		expect(rec.arcs.length).toBe(1);
		expect(rec.fills).toBe(1);
	});
});

describe("signedArea", () => {
	it("distinguishes the two windings and the degenerate quad", () => {
		const ccw: Quad = [
			[0, 0],
			[10, 0],
			[10, 10],
			[0, 10],
		];
		const cw = [...ccw].reverse();
		expect(signedArea(ccw)).toBeGreaterThan(0);
		expect(signedArea(cw)).toBeLessThan(0);
		expect(
			signedArea([
				[5, 5],
				[5, 5],
				[5, 5],
				[5, 5],
			])
		).toBe(0);
	});
});


/**
 * The raw centerline's own offsetter, added 2026-09-02.
 *
 * `ribbonSides` offsets along the normal to the central-difference tangent
 * p[i-1] -> p[i+1], which equals the angle bisector only when the two
 * adjacent segments are the same length. Subdivision makes that true on the
 * smoothed path and pen speed makes it false on the samples themselves, so
 * the shared normal skewed toward the longer segment and was wrong for both
 * of its segments at once: one side pinched, the other bulged, and the
 * outline serrated along the whole stroke. An antialiased serrated edge
 * covers its boundary pixels only partly, which is the author's raw ink on a
 * PDF reading "thinner, soft edged, lighter grey" rather than merely
 * faceted (2026-09-02).
 */

/** Records the arcs' geometry too, which the winding pin above does not need. */
function argRecordingCtx() {
	const quads: Quad[] = [];
	const arcs: Array<{ x: number; y: number; r: number; anticlockwise: boolean }> = [];
	let current: Quad | null = null;
	const ctx = {
		fillStyle: "",
		beginPath() {},
		moveTo(x: number, y: number) {
			current = [[x, y]];
		},
		lineTo(x: number, y: number) {
			current?.push([x, y]);
		},
		closePath() {
			if (current && current.length === 4) quads.push(current);
			current = null;
		},
		arc(x: number, y: number, r: number, _a0: number, _a1: number, anticlockwise?: boolean) {
			arcs.push({ x, y, r, anticlockwise: anticlockwise === true });
		},
		fill() {},
	};
	return { ctx: ctx as unknown as CanvasRenderingContext2D, quads, arcs };
}

/** The polygon an `arc(..., anticlockwise)` actually traces. */
function polygoniseArc(
	a: { x: number; y: number; r: number; anticlockwise: boolean },
	steps = 64
): Quad {
	const out: Quad = [];
	for (let k = 0; k < steps; k++) {
		const t = ((k / steps) * Math.PI * 2) * (a.anticlockwise ? -1 : 1);
		out.push([a.x + a.r * Math.cos(t), a.y + a.r * Math.sin(t)]);
	}
	return out;
}

/** Uneven spacing and a real turn: the shape a shared normal gets wrong. */
function unevenCorner(): RibbonPt[] {
	return [
		{ x: 0, y: 0, hw: 2 },
		{ x: 12, y: 0, hw: 2 },
		{ x: 13, y: 6, hw: 2 },
		{ x: 13, y: 20, hw: 2 },
	];
}

describe("the raw path offsets per segment", () => {
	it("a disc winds the same way as a normalised quad, so it can only add", () => {
		// The permanent invariant behind every disc in this file: the sign
		// `arc` integrates to must match the sign every quad is normalised
		// to. Asserted on the traced polygon rather than on the reasoning.
		const rec = argRecordingCtx();
		fillRibbon(rec.ctx, CAM, unevenCorner(), "#000", true);
		expect(rec.quads.length).toBeGreaterThan(0);
		expect(rec.arcs.length).toBeGreaterThan(0);
		const quadSign = Math.sign(signedArea(rec.quads[0]!));
		expect(quadSign).toBe(-1);
		for (const a of rec.arcs) {
			expect(Math.sign(signedArea(polygoniseArc(a)))).toBe(quadSign);
		}
	});

	it("each quad's sides are perpendicular to its OWN segment", () => {
		const pts = unevenCorner();
		const rec = argRecordingCtx();
		fillRibbon(rec.ctx, CAM, pts, "#000", true);
		expect(rec.quads).toHaveLength(pts.length - 1);
		for (let i = 0; i < rec.quads.length; i++) {
			const q = rec.quads[i]!;
			const dx = pts[i + 1]!.x - pts[i]!.x;
			const dy = pts[i + 1]!.y - pts[i]!.y;
			const len = Math.hypot(dx, dy);
			// The quad is [a+n, b+n, b-n, a-n] in some rotation after the
			// winding normalisation, so test the offset at whichever corner
			// sits over point a: both corners over a must be ±hw along the
			// perpendicular, which is exactly "no component along d".
			const offsets = q
				.map(([x, y]) => [x - pts[i]!.x, y - pts[i]!.y] as const)
				.filter(([ox, oy]) => Math.hypot(ox, oy) <= pts[i]!.hw + 1e-9);
			expect(offsets).toHaveLength(2);
			for (const [ox, oy] of offsets) {
				expect((ox * dx + oy * dy) / len).toBeCloseTo(0, 9);
				expect(Math.hypot(ox, oy)).toBeCloseTo(pts[i]!.hw, 9);
			}
		}
	});

	it("puts a disc at every join, at any zoom", () => {
		// One arc per point: two caps and a disc at each interior vertex. The
		// join disc is load-bearing on this path rather than a redundant cap -
		// a per-segment quad ends square to its own segment, so dropping the
		// disc leaves a wedge of depth hw on the outside of the join, not the
		// sub-percent shortfall a shared normal leaves. Measured over a
		// 300-sample handwriting stroke, skipping the sub-pixel joins took the
		// painted width from 99.8% of intended at worst to 49%.
		const pts: RibbonPt[] = [];
		for (let i = 0; i < 40; i++) pts.push({ x: i * 0.15, y: (i % 3) * 0.05, hw: 1 });
		for (const zoom of [0.05, 1, 4]) {
			const rec = argRecordingCtx();
			fillRibbon(rec.ctx, { x: 0, y: 0, zoom }, pts, "#000", true);
			expect(rec.arcs).toHaveLength(pts.length);
		}
	});

	it("leaves the smoothed path on the shared normal and the 12 degree threshold", () => {
		const pts = unevenCorner();
		const smoothed = argRecordingCtx();
		fillRibbon(smoothed.ctx, CAM, pts, "#000");
		const raw = argRecordingCtx();
		fillRibbon(raw.ctx, CAM, pts, "#000", true);
		// Same quad count, different corners: the shared normal is not the
		// segment's own wherever the neighbours differ in length.
		expect(smoothed.quads).toHaveLength(raw.quads.length);
		expect(smoothed.quads).not.toEqual(raw.quads);
		// And the smoothed path still discs only the hard turns.
		expect(smoothed.arcs.length).toBeLessThan(raw.arcs.length);
	});

	it("keeps every raw quad negatively wound, degenerate points included", () => {
		const rec = argRecordingCtx();
		fillRibbon(rec.ctx, CAM, stationaryThenLoop(), "#000", true);
		for (const q of rec.quads) expect(signedArea(q)).toBeLessThanOrEqual(EPS);
		for (const a of rec.arcs) expect(a.anticlockwise).toBe(true);
	});
});
