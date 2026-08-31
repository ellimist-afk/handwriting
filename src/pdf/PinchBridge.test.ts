/**
 * The bridge's arithmetic. The DOM wiring reuses the shield's shape; what
 * must not drift is the mapping from fingers to the events the viewer sees.
 */

import { describe, expect, it } from "vitest";
import { PINCH_WHEEL_GAIN, anchorScroll, centroidOf, spreadOf, wheelDeltaFor } from "./PinchBridge";

const p = (id: number, x: number, y: number) => ({ identifier: id, clientX: x, clientY: y });

describe("the pinch bridge's numbers", () => {
	it("measures spread and centroid where the fingers are", () => {
		expect(spreadOf(p(1, 0, 0), p(2, 30, 40))).toBe(50);
		expect(centroidOf(p(1, 0, 0), p(2, 30, 40))).toEqual({ x: 15, y: 20 });
	});

	it("spreading fingers scrolls the wheel toward zoom-in", () => {
		// Wheel-zoom convention: negative deltaY zooms in.
		expect(wheelDeltaFor(1.1)).toBeLessThan(0);
		expect(wheelDeltaFor(0.9)).toBeGreaterThan(0);
		expect(wheelDeltaFor(1)).toBe(0);
	});

	it("is symmetric: in and back out cancels", () => {
		expect(wheelDeltaFor(1.25) + wheelDeltaFor(1 / 1.25)).toBeCloseTo(0, 10);
	});

	it("degenerate ratios push nothing rather than infinity", () => {
		expect(wheelDeltaFor(0)).toBe(0);
		expect(wheelDeltaFor(Number.NaN)).toBe(0);
		expect(wheelDeltaFor(-2)).toBe(0);
	});

	it("doubling the spread lands in a few notches' territory", () => {
		expect(Math.abs(wheelDeltaFor(2))).toBeCloseTo(Math.LN2 * PINCH_WHEEL_GAIN, 6);
	});
});

describe("the anchor correction", () => {
	it("holds the point under the fingers still through a zoom", () => {
		// Content point at scroll 100 + anchor 50 = 150; doubled it sits at
		// 300, and the scroll that puts it back under the anchor is 250.
		expect(anchorScroll(100, 50, 2)).toBe(250);
	});

	it("is idempotent when the viewer anchored the zoom itself", () => {
		const corrected = anchorScroll(100, 50, 2);
		// Recomputing from the same pre-zoom baseline gives the same answer,
		// however many times it is assigned.
		expect(anchorScroll(100, 50, 2)).toBe(corrected);
	});

	it("zooming out pulls the scroll back toward the anchor", () => {
		expect(anchorScroll(250, 50, 0.5)).toBe(100);
	});
});
