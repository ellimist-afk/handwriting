import { beforeEach, describe, expect, it } from "vitest";
import {
	initPressureGain,
	observeStrokeMax,
	resetPressureCalibration,
	resetPressureGainForTest,
	setPressureStore,
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

	it("init with no host store leaves the default and does not throw", () => {
		setPressureStore(null);
		expect(() => initPressureGain()).not.toThrow();
		expect(strokeGain()).toBe(1);
	});

	it("a learned max round trips through the host store", () => {
		// The swap off the localStorage global (scorecard, 2026-08-27) is
		// only correct if what one session writes, the next session reads.
		const kv = new Map<string, string>();
		setPressureStore({
			load: (k) => kv.get(k) ?? null,
			save: (k, v) => void kv.set(k, v),
		});
		resetPressureGainForTest(0);
		observeStrokeMax(0.275);
		expect(kv.size).toBe(1);

		// A fresh session: nothing in memory, everything from the store.
		resetPressureGainForTest(0);
		initPressureGain();
		expect(strokeGain()).toBeCloseTo(2, 5);
		setPressureStore(null);
	});

	it("resetting calibration clears what was stored", () => {
		const kv = new Map<string, string>();
		setPressureStore({
			load: (k) => kv.get(k) ?? null,
			save: (k, v) => void kv.set(k, v),
		});
		resetPressureGainForTest(0);
		observeStrokeMax(0.275);
		resetPressureCalibration();
		initPressureGain();
		expect(strokeGain()).toBe(1);
		setPressureStore(null);
	});

	it("a store that throws costs the calibration, not the stroke", () => {
		setPressureStore({
			load: () => {
				throw new Error("denied");
			},
			save: () => {
				throw new Error("denied");
			},
		});
		resetPressureGainForTest(0);
		expect(() => initPressureGain()).not.toThrow();
		expect(() => observeStrokeMax(0.275)).not.toThrow();
		expect(() => resetPressureCalibration()).not.toThrow();
		setPressureStore(null);
	});

	it("test seam can preload a max", () => {
		resetPressureGainForTest(0.275);
		expect(strokeGain()).toBeCloseTo(2, 5);
	});

	it("cold-start assumption applies while nothing is learned", () => {
		resetPressureGainForTest(0, 0.24);
		expect(strokeGain()).toBeCloseTo(0.55 / 0.24, 5);
	});

	it("a learned max beats the assumption, even a smaller one", () => {
		resetPressureGainForTest(0, 0.24);
		observeStrokeMax(0.15);
		expect(strokeGain()).toBe(3); // 0.55/0.15 capped
		observeStrokeMax(0.3);
		expect(strokeGain()).toBeCloseTo(0.55 / 0.3, 5);
	});

	it("recalibrate forgets the learned max and keeps the assumption", () => {
		resetPressureGainForTest(0, 0.24);
		observeStrokeMax(0.9); // freak spike pins gain at 1
		expect(strokeGain()).toBe(1);
		resetPressureCalibration();
		expect(strokeGain()).toBeCloseTo(0.55 / 0.24, 5);
	});

	it("recalibrate without an assumption returns to status quo", () => {
		resetPressureGainForTest();
		observeStrokeMax(0.4);
		resetPressureCalibration();
		expect(strokeGain()).toBe(1);
	});
});
