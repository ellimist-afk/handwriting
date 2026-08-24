import { describe, expect, it } from "vitest";
import { InkPoint } from "./Stroke";
import { IncrementalSmoother, midpoint, smoothSegments } from "./Smoothing";
import { InputPrecision, computeCanvasSize } from "../diag/Raster";

function p(x: number, y: number, pressure = 0.5): InkPoint {
	return { x, y, pressure, t: 0 };
}

describe("midpoint", () => {
	it("is the average of two points", () => {
		expect(midpoint({ x: 0, y: 0 }, { x: 10, y: 4 })).toEqual({ x: 5, y: 2 });
	});
});

describe("smoothSegments", () => {
	it("needs two points to draw anything", () => {
		expect(smoothSegments([])).toEqual([]);
		expect(smoothSegments([p(0, 0)])).toEqual([]);
	});

	it("bends around each real sample and ends at the last one", () => {
		const pts = [p(0, 0), p(10, 0), p(10, 10)];
		const segs = smoothSegments(pts);
		// Two joins plus the closing tail.
		expect(segs).toHaveLength(3);
		expect(segs[0]!.from).toEqual({ x: 0, y: 0 });
		expect(segs[0]!.to).toEqual({ x: 5, y: 0 });
		expect(segs[1]!.ctrl).toEqual({ x: 10, y: 0 }); // the corner sample
		expect(segs[1]!.to).toEqual({ x: 10, y: 5 });
		// The stroke finishes exactly where the pen did.
		expect(segs[2]!.to).toEqual({ x: 10, y: 10 });
	});

	it("averages pressure across each segment's two samples", () => {
		const segs = smoothSegments([p(0, 0, 0.2), p(10, 0, 0.6)]);
		expect(segs[0]!.pressure).toBeCloseTo(0.4);
	});

	it("keeps a straight line straight", () => {
		const segs = smoothSegments([p(0, 0), p(10, 0), p(20, 0), p(30, 0)]);
		for (const s of segs) expect(s.to.y).toBe(0);
	});
});

describe("IncrementalSmoother", () => {
	it("emits nothing until it has two samples", () => {
		const s = new IncrementalSmoother();
		s.reset();
		expect(s.push(p(0, 0))).toBeUndefined();
		expect(s.push(p(10, 0))).toBeDefined();
	});

	it("produces exactly the same curve as the batch version", () => {
		// This is what stops ink from visibly changing shape when a stroke
		// commits: the wet layer and the committed layer must agree.
		const pts = [p(0, 0, 0.3), p(10, 2, 0.4), p(14, 9, 0.5), p(20, 20, 0.6)];
		const batch = smoothSegments(pts);

		const s = new IncrementalSmoother();
		s.reset(pts[0]);
		const live = [];
		for (let i = 1; i < pts.length; i++) {
			const seg = s.push(pts[i]!);
			if (seg) live.push(seg);
		}
		const tail = s.finish();
		if (tail) live.push(tail);

		expect(live).toEqual(batch);
	});

	it("reset clears the previous stroke's tail", () => {
		const s = new IncrementalSmoother();
		s.reset(p(0, 0));
		s.push(p(10, 0));
		s.reset(p(100, 100));
		expect(s.push(p(110, 100))!.from).toEqual({ x: 100, y: 100 });
	});

	it("finish is undefined before anything was drawn", () => {
		const s = new IncrementalSmoother();
		s.reset(p(0, 0));
		expect(s.finish()).toBeUndefined();
	});
});

describe("live head (zero-lag invariant)", () => {
	it("is undefined before any sample", () => {
		const s = new IncrementalSmoother();
		s.reset();
		expect(s.head()).toBeUndefined();
	});

	it("runs from the last settled midpoint to the newest sample", () => {
		const s = new IncrementalSmoother();
		s.reset(p(0, 0));
		s.push(p(10, 0));
		const h = s.head()!;
		expect(h.from).toEqual({ x: 5, y: 0 }); // midpoint of the last pair
		expect(h.to).toEqual({ x: 10, y: 0 }); // the pen
	});

	it("ALWAYS reaches the newest sample — this is the whole point", () => {
		// If this ever fails, the visible tip is lagging the nib.
		const s = new IncrementalSmoother();
		const pts = [p(0, 0), p(4, 1), p(9, 5), p(12, 14), p(30, 22), p(31, 40)];
		s.reset(pts[0]);
		for (let i = 1; i < pts.length; i++) {
			s.push(pts[i]!);
			const h = s.head()!;
			expect(h.to).toEqual({ x: pts[i]!.x, y: pts[i]!.y });
		}
	});

	it("the head is never longer than half the last sample interval", () => {
		const s = new IncrementalSmoother();
		const a = p(0, 0);
		const b = p(100, 0);
		s.reset(a);
		s.push(b);
		const h = s.head()!;
		const headLen = Math.hypot(h.to.x - h.from.x, h.to.y - h.from.y);
		expect(headLen).toBeCloseTo(50); // half of the 100-unit interval
	});

	it("before the first curve exists, the head degenerates to a point", () => {
		const s = new IncrementalSmoother();
		s.reset(p(3, 4));
		const h = s.head()!;
		expect(h.from).toEqual({ x: 3, y: 4 });
		expect(h.to).toEqual({ x: 3, y: 4 });
	});

	it("settled curve plus head covers the stroke with no gap", () => {
		// The head starts exactly where the last settled segment ended.
		const s = new IncrementalSmoother();
		const pts = [p(0, 0), p(10, 2), p(18, 9)];
		s.reset(pts[0]);
		let lastSeg;
		for (let i = 1; i < pts.length; i++) lastSeg = s.push(pts[i]!);
		expect(s.head()!.from).toEqual(lastSeg!.to);
	});
});

describe("computeCanvasSize (raster 1:1)", () => {
	it("keeps backing store and CSS box exactly dpr apart", () => {
		// A fractional leaf width is the normal case in Obsidian, and the
		// naive version (round the backing, keep the CSS box fractional)
		// leaves the compositor resampling the canvas every frame.
		for (const [css, dpr] of [
			[1523.5, 2],
			[1013.33, 1.5],
			[800, 1],
			[377.7, 1.25],
		] as Array<[number, number]>) {
			const s = computeCanvasSize(css, css, dpr);
			expect(s.backingW).toBe(Math.round(css * dpr));
			expect(s.cssW * dpr).toBeCloseTo(s.backingW, 9);
		}
	});

	it("never produces a zero-sized backing store", () => {
		const s = computeCanvasSize(0, 0, 2);
		expect(s.backingW).toBeGreaterThan(0);
		expect(s.backingH).toBeGreaterThan(0);
	});

	it("stays within half a css pixel of the requested size", () => {
		const s = computeCanvasSize(1000.4, 500.9, 2);
		expect(Math.abs(s.cssW - 1000.4)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(s.cssH - 500.9)).toBeLessThanOrEqual(0.5);
	});
});

describe("InputPrecision", () => {
	it("detects a digitizer quantized to whole pixels", () => {
		const p = new InputPrecision();
		for (let i = 0; i < 10; i++) p.add(i * 2, 0);
		expect(p.integerPercent).toBe(100);
		expect(p.medianStepPx).toBeCloseTo(2);
	});

	it("detects sub-pixel input", () => {
		const p = new InputPrecision();
		for (let i = 0; i < 10; i++) p.add(i * 0.5 + 0.25, 0.75);
		expect(p.integerPercent).toBe(0);
		expect(p.medianStepPx).toBeCloseTo(0.5);
	});

	it("reports nothing before any samples", () => {
		const p = new InputPrecision();
		expect(p.integerPercent).toBe(0);
		expect(p.medianStepPx).toBe(0);
	});
});
