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
