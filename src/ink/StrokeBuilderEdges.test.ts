import { describe, expect, it } from "vitest";
import { StrokeBuilder } from "./StrokeBuilder";

/** A builder fed (x, y, pressure, t) samples, started at time 0. */
function build(samples: Array<[number, number, number, number]>, minDist = 0.15, device?: "mouse"): StrokeBuilder {
	const b = new StrokeBuilder("pen", "#000000", 2, minDist, device);
	b.start(0);
	for (const [x, y, p, t] of samples) b.add(x, y, p, t);
	return b;
}

describe("the dedupe gate", () => {
	it("accepts a sample exactly the minimum distance from the last, and drops one a hair closer", () => {
		const b = new StrokeBuilder("pen", "#000000", 2, 1);
		b.start(0);
		expect(b.add(0, 0, 0.5, 0)).toBeDefined();
		expect(b.add(0.999, 0, 0.5, 4), "a hair inside the gate").toBeUndefined();
		expect(b.add(1, 0, 0.5, 8), "exactly the gate").toBeDefined();
		expect(b.pointCount).toBe(2);
	});

	it("keeps the arrival pressure on the retained point when it drops a sample", () => {
		const b = new StrokeBuilder("pen", "#000000", 2, 1);
		b.start(0);
		b.add(0, 0, 0.2, 0);
		b.add(0.1, 0, 0.9, 4);
		expect(b.lastPoint?.pressure).toBe(0.2);
	});
});

describe("tilt rides with the sample that carried it", () => {
	it("keeps tilt on the point when the pen reports it, and leaves the fields off when it does not", () => {
		const b = new StrokeBuilder("pen", "#000000", 2);
		b.start(0);
		const withTilt = b.add(0, 0, 0.5, 0, 12, -7);
		const without = b.add(5, 0, 0.5, 8);
		const xOnly = b.add(10, 0, 0.5, 16, 3);
		const yOnly = b.add(15, 0, 0.5, 24, undefined, 4);
		expect(withTilt).toMatchObject({ tiltX: 12, tiltY: -7 });
		expect(without && "tiltX" in without).toBe(false);
		expect(without && "tiltY" in without).toBe(false);
		expect(xOnly).toMatchObject({ tiltX: 3 });
		expect(xOnly && "tiltY" in xOnly).toBe(false);
		expect(yOnly).toMatchObject({ tiltY: 4 });
		expect(yOnly && "tiltX" in yOnly).toBe(false);
	});

	it("a zero tilt is a reading, not an absent one", () => {
		const b = new StrokeBuilder("pen", "#000000", 2);
		b.start(0);
		const p = b.add(0, 0, 0.5, 0, 0, 0);
		expect(p).toMatchObject({ tiltX: 0, tiltY: 0 });
	});
});

describe("a finished stroke's shape", () => {
	it("a single tap becomes a two-sample dot, the second a hundredth to the right and a millisecond later", () => {
		const stroke = build([[10, 20, 0.5, 5]]).finish();
		expect(stroke?.points).toHaveLength(2);
		expect(stroke!.points[1]!.x).toBeCloseTo(10.01, 10);
		expect(stroke!.points[1]!.y).toBe(20);
		expect(stroke!.points[1]!.t).toBe(stroke!.points[0]!.t + 1);
	});

	it("marks a mouse stroke as a mouse stroke, and leaves the mark off any other", () => {
		const mouse = build([[0, 0, 0.5, 0], [10, 0, 0.5, 10]], 0.15, "mouse").finish();
		const other = build([[0, 0, 0.5, 0], [10, 0, 0.5, 10]]).finish();
		expect(mouse?.device).toBe("mouse");
		expect(other && "device" in other).toBe(false);
	});

	it("is undefined for a builder that took nothing, on both finishing paths", () => {
		const b = new StrokeBuilder("pen", "#000000", 2);
		b.start(0);
		expect(b.finish()).toBeUndefined();
		expect(b.finishReleaseFiltered()).toEqual([]);
	});
});

describe("the release filter at the edges of its bands", () => {
	// A confident run, then a light tail that travels: the shape that is cut at the lift.
	const tail = (confident: number, light: number): Array<[number, number, number, number]> => [
		[0, 0, confident, 0],
		[10, 0, confident, 10],
		[20, 0, light, 20],
		[30, 0, light, 30],
	];

	it("reads a pressure of exactly 0.08 as confident contact", () => {
		const kept = build(tail(0.08, 0.02)).finishReleaseFiltered();
		expect(kept).toHaveLength(1);
		expect(kept[0]!.points).toHaveLength(2);
		const notYet = build(tail(0.079, 0.02)).finishReleaseFiltered();
		expect(notYet[0]!.points, "never confident, so nothing is release").toHaveLength(4);
	});

	it("reads a pressure of exactly 0.025 as light, and one a hair above as ink", () => {
		expect(build(tail(0.5, 0.025)).finishReleaseFiltered()[0]!.points).toHaveLength(2);
		expect(build(tail(0.5, 0.0251)).finishReleaseFiltered()[0]!.points).toHaveLength(4);
	});

	it("keeps a dip whose very next sample is confident again, whole", () => {
		const s = build([
			[0, 0, 0.5, 0],
			[10, 0, 0.01, 10],
			[20, 0, 0.5, 20],
		]).finishReleaseFiltered();
		expect(s).toHaveLength(1);
		expect(s[0]!.points).toHaveLength(3);
	});

	it("reads the light run after a recovery on its own terms: a tail after a dip is still cut", () => {
		const s = build([
			[0, 0, 0.5, 0],
			[10, 0, 0.01, 10],
			[20, 0, 0.5, 20],
			[30, 0, 0.01, 30],
			[40, 0, 0.01, 40],
		]).finishReleaseFiltered();
		expect(s).toHaveLength(1);
		expect(s[0]!.points).toHaveLength(3);
	});

	it("counts a recovery at exactly 0.08 as the pen coming back", () => {
		const s = build([
			[0, 0, 0.5, 0],
			[10, 0, 0.01, 10],
			[20, 0, 0.08, 20],
			[30, 0, 0.5, 30],
		]).finishReleaseFiltered();
		expect(s[0]!.points).toHaveLength(4);
	});
});
