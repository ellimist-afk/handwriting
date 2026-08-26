import { beforeEach, describe, expect, it } from "vitest";
import {
	initPressureGain,
	observeStrokeMax,
	resetPressureGainForTest,
	strokeGain,
} from "./PressureGain";

describe("PressureGain", () => {
	beforeEach(() => resetPressureGainForTest());

	it("gain is 1 before anything is learned", () => {
		expect(strokeGain()).toBe(1);
	});

	it("an iPad-range max (0.24) earns the boost that reaches the reference", () => {
		observeStrokeMax(0.24);
		expect(strokeGain()).toBeCloseTo(0.55 / 0.24, 5);
		// and the boosted ceiling lands on the reference itself
		expect(0.24 * strokeGain()).toBeCloseTo(0.55, 5);
	});

	it("a full-range device (Surface 0.61) gets exactly 1: desktop unchanged", () => {
		observeStrokeMax(0.61);
		expect(strokeGain()).toBe(1);
	});

	it("gain is capped at 3 for a device only ever touched gently", () => {
		observeStrokeMax(0.1);
		expect(strokeGain()).toBe(3);
	});

	it("the max only ratchets up", () => {
		observeStrokeMax(0.24);
		observeStrokeMax(0.1);
		expect(strokeGain()).toBeCloseTo(0.55 / 0.24, 5);
	});

	it("a high spike drives the gain DOWN toward 1, never up", () => {
		observeStrokeMax(0.24);
		observeStrokeMax(0.9);
		expect(strokeGain()).toBe(1);
	});

	it("rejects zero, negatives, NaN, and out-of-range values", () => {
		observeStrokeMax(0);
		observeStrokeMax(-1);
		observeStrokeMax(Number.NaN);
		observeStrokeMax(1.5);
		expect(strokeGain()).toBe(1);
	});

	it("init without localStorage (node) leaves the default and does not throw", () => {
		expect(() => initPressureGain()).not.toThrow();
		expect(strokeGain()).toBe(1);
	});

	it("test seam can preload a max", () => {
		resetPressureGainForTest(0.275);
		expect(strokeGain()).toBeCloseTo(2, 5);
	});
});
