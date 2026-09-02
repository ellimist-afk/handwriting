/**
 * The shaping laws, pinned as properties rather than pixel dumps: filtered
 * pressure, velocity thinning, endpoint taper. Everything here is derived
 * from stored samples at render time, so the same inputs must always shape
 * identically, and neutral parameters must reproduce the unshaped law
 * exactly.
 */

import { describe, expect, it } from "vitest";
import {
	IncrementalShaper,
	PEN_SHAPE,
	ShapeParams,
	applyEndTaper,
	flattenStrokeShaped,
	shapedHalfWidths,
} from "./InkShape";
import { flattenStroke } from "./Ribbon";
import { DEFAULT_PEN, widthForPressure } from "./PenStyle";
import { InkPoint } from "./Stroke";

/** Shaping disabled through its own parameters: must equal the unshaped law. */
const NEUTRAL: ShapeParams = {
	pressureAlpha: 1,
	velocityAlpha: 1,
	thinningK: 0,
	minVelocityFactor: 1,
	taperWidths: 0,
	taperMaxShare: 0,
	tipFloor: 1,
};

function line(n: number, spacing: number, dtMs: number, pressure = 0.5): InkPoint[] {
	const out: InkPoint[] = [];
	for (let i = 0; i < n; i++) {
		out.push({ x: i * spacing, y: 0, pressure, t: i * dtMs });
	}
	return out;
}

describe("shapedHalfWidths — pressure filtering and velocity thinning", () => {
	it("is deterministic: same samples, same widths", () => {
		const pts = line(30, 2, 5, 0.6);
		expect(shapedHalfWidths(pts, DEFAULT_PEN)).toEqual(shapedHalfWidths(pts, DEFAULT_PEN));
	});

	it("neutral parameters reproduce the unshaped width law exactly", () => {
		const pts = line(10, 2, 5, 0.7);
		const hws = shapedHalfWidths(pts, DEFAULT_PEN, NEUTRAL);
		for (const hw of hws) {
			expect(hw).toBeCloseTo(widthForPressure(DEFAULT_PEN, 0.7) / 2, 10);
		}
	});

	it("a fast stroke comes out thinner than a slow one", () => {
		const slow = shapedHalfWidths(line(30, 0.5, 5), DEFAULT_PEN);
		const fast = shapedHalfWidths(line(30, 10, 5), DEFAULT_PEN);
		expect(fast[29]!).toBeLessThan(slow[29]!);
	});

	it("thinning bottoms out at the velocity floor", () => {
		const absurd = shapedHalfWidths(line(30, 1000, 1), DEFAULT_PEN);
		const floor = (widthForPressure(DEFAULT_PEN, 0.5) / 2) * PEN_SHAPE.minVelocityFactor;
		expect(absurd[29]!).toBeGreaterThanOrEqual(floor * 0.99);
	});

	it("damps a single-sample pressure spike instead of printing it", () => {
		const pts = line(10, 2, 5, 0.5);
		pts[5]!.pressure = 1;
		const hws = shapedHalfWidths(pts, DEFAULT_PEN);
		const raw = widthForPressure(DEFAULT_PEN, 1) / 2;
		const base = hws[4]!;
		// The spike moves width, but by less than the raw law would.
		expect(hws[5]!).toBeGreaterThan(base);
		expect(hws[5]! - base).toBeLessThan(raw - base);
	});
});

describe("applyEndTaper — tips, not blunt caps", () => {
	function ribbon(n: number, spacing: number, hw: number) {
		const out = [];
		for (let i = 0; i < n; i++) out.push({ x: i * spacing, y: 0, hw });
		return out;
	}

	it("pulls both ends down toward the tip floor and leaves the middle alone", () => {
		const pts = ribbon(101, 1, 2); // 100 units long, taper zone ~5.3
		applyEndTaper(pts, DEFAULT_PEN, PEN_SHAPE);
		expect(pts[0]!.hw).toBeCloseTo(2 * PEN_SHAPE.tipFloor, 6);
		expect(pts[100]!.hw).toBeLessThan(0.5);
		expect(pts[50]!.hw).toBeCloseTo(2, 6);
	});

	it("widens monotonically away from each tip", () => {
		const pts = ribbon(101, 1, 2);
		applyEndTaper(pts, DEFAULT_PEN, PEN_SHAPE);
		for (let i = 1; i < 8; i++) expect(pts[i]!.hw).toBeGreaterThanOrEqual(pts[i - 1]!.hw);
		for (let i = 93; i < 100; i++) expect(pts[i + 1]!.hw).toBeLessThanOrEqual(pts[i]!.hw);
	});

	it("a short stroke tapers over its capped share, never to nothing", () => {
		const pts = ribbon(11, 0.5, 2); // 5 units long
		applyEndTaper(pts, DEFAULT_PEN, PEN_SHAPE);
		for (const p of pts) expect(p.hw).toBeGreaterThan(0);
		expect(pts[5]!.hw).toBeGreaterThan(pts[0]!.hw);
	});

	it("leaves a tap alone: a ribbon of two ends is not a line", () => {
		// The taper zone is a share of the stroke, so on a tap it is a share
		// of almost nothing - and a stroke that short flattens to just its two
		// endpoints. Both are ends, both got multiplied to the tip floor, and
		// the dot came out at 12% of the nib on canvas, SVG and PDF alike.
		const pts = [
			{ x: 0, y: 0, hw: 1.1 },
			{ x: 0.8, y: 0, hw: 1.1 },
		];
		applyEndTaper(pts, DEFAULT_PEN, PEN_SHAPE);
		expect(pts[0]!.hw).toBe(1.1);
		expect(pts[1]!.hw).toBe(1.1);
	});

	it("leaves a tap alone whatever the ribbon resolution", () => {
		// Three points made a lens - two sharp tips around a full-width middle
		// - over less than a nib's width of travel. Also not a dot.
		const pts = [
			{ x: 0, y: 0, hw: 1.1 },
			{ x: 0.4, y: 0, hw: 1.1 },
			{ x: 0.8, y: 0, hw: 1.1 },
		];
		applyEndTaper(pts, DEFAULT_PEN, PEN_SHAPE);
		expect(pts.map((p) => p.hw)).toEqual([1.1, 1.1, 1.1]);
	});

	it("still tapers as soon as the stroke is longer than the nib is wide", () => {
		// The boundary is one nib width (2.2 for the default pen), and just
		// past it the taper is back - a short flick is a line, not a dot.
		const pts = [
			{ x: 0, y: 0, hw: 1.1 },
			{ x: 1.5, y: 0, hw: 1.1 },
			{ x: 3, y: 0, hw: 1.1 },
		];
		applyEndTaper(pts, DEFAULT_PEN, PEN_SHAPE);
		expect(pts[0]!.hw).toBeLessThan(1.1);
		expect(pts[2]!.hw).toBeLessThan(1.1);
	});

	it("leaves a dot (single point) untouched", () => {
		const pts = [{ x: 0, y: 0, hw: 2 }];
		applyEndTaper(pts, DEFAULT_PEN, PEN_SHAPE);
		expect(pts[0]!.hw).toBe(2);
	});
});

describe("flattenStrokeShaped — the committed geometry", () => {
	it("neutral parameters reproduce flattenStroke's geometry", () => {
		const pts = line(20, 3, 5, 0.5);
		const unshaped = flattenStroke(pts, DEFAULT_PEN, 1);
		const shaped = flattenStrokeShaped(pts, DEFAULT_PEN, 1, NEUTRAL);
		expect(shaped.length).toBe(unshaped.length);
		for (let i = 0; i < unshaped.length; i++) {
			expect(shaped[i]!.x).toBeCloseTo(unshaped[i]!.x, 10);
			expect(shaped[i]!.y).toBeCloseTo(unshaped[i]!.y, 10);
			expect(shaped[i]!.hw).toBeCloseTo(unshaped[i]!.hw, 10);
		}
	});

	it("with pen shaping, the ends are thinner than the middle", () => {
		const pts = line(40, 3, 5, 0.5);
		const shaped = flattenStrokeShaped(pts, DEFAULT_PEN, 1);
		const mid = shaped[Math.floor(shaped.length / 2)]!.hw;
		expect(shaped[0]!.hw).toBeLessThan(mid);
		expect(shaped[shaped.length - 1]!.hw).toBeLessThan(mid);
	});
});

describe("IncrementalShaper — the wet layer speaks the same law", () => {
	it("matches shapedHalfWidths sample for sample, apart from the taper", () => {
		const pts = line(25, 2, 5, 0.6);
		const whole = shapedHalfWidths(pts, DEFAULT_PEN);
		const inc = new IncrementalShaper({ ...PEN_SHAPE, tipFloor: 1, taperWidths: 0 });
		inc.reset(pts[0], DEFAULT_PEN);
		// Sample 0 is consumed by reset; push the rest.
		const got = [whole[0]!];
		for (let i = 1; i < pts.length; i++) got.push(inc.push(DEFAULT_PEN, pts[i]!));
		for (let i = 1; i < pts.length; i++) {
			expect(got[i]!).toBeCloseTo(whole[i]!, 10);
		}
	});

	it("start taper ramps the first samples up from the tip", () => {
		const pts = line(25, 0.5, 5, 0.6);
		const inc = new IncrementalShaper();
		inc.reset(pts[0], DEFAULT_PEN);
		const hws: number[] = [];
		for (let i = 1; i < pts.length; i++) hws.push(inc.push(DEFAULT_PEN, pts[i]!));
		expect(hws[0]!).toBeLessThan(hws[hws.length - 1]!);
	});
});
