/**
 * The palm classifier and its decision table. The DOM wiring is three
 * addEventListener calls and is not what goes wrong; what goes wrong is the
 * judgment, so the judgment is what gets pinned.
 */

import { describe, expect, it } from "vitest";
import { PALM_RADIUS_SWALLOW_PX, isPalmTouch, palmRadiusTrustworthy, palmVerdict } from "./PalmShield";

const finger = (id: number, r = 5) => ({ identifier: id, radiusX: r, radiusY: r });
const palm = (id: number, r = 24) => ({ identifier: id, radiusX: r, radiusY: r });

describe("what counts as a palm", () => {
	it("a slab of contact is a palm, a fingertip is not", () => {
		expect(isPalmTouch(palm(1))).toBe(true);
		expect(isPalmTouch(finger(1))).toBe(false);
	});

	it("one long axis is enough - the heel lands as an ellipse", () => {
		expect(isPalmTouch({ identifier: 1, radiusX: 4, radiusY: PALM_RADIUS_SWALLOW_PX })).toBe(true);
	});

	it("hardware that reports no radius makes the shield inert, not jumpy", () => {
		expect(isPalmTouch({ identifier: 1 })).toBe(false);
		expect(isPalmTouch({ identifier: 1, radiusX: 0, radiusY: 0 })).toBe(false);
	});
});

describe("the verdict on an event", () => {
	it("a palm landing is vetoed and remembered", () => {
		const v = palmVerdict([palm(7)], new Set());
		expect(v.veto).toBe(true);
		expect(v.begin).toEqual([7]);
	});

	it("a palm plus a finger is a hand: the whole event is vetoed", () => {
		// Letting the finger half through hands the browser a one-finger
		// gesture the person never made.
		const v = palmVerdict([palm(1), finger(2)], new Set());
		expect(v.veto).toBe(true);
		expect(v.begin).toEqual([1]);
	});

	it("two honest fingertips pass untouched, however close they landed", () => {
		const v = palmVerdict([finger(1), finger(2)], new Set());
		expect(v.veto).toBe(false);
		expect(v.begin).toEqual([]);
	});

	it("a swallowed contact stays swallowed while it moves", () => {
		const v = palmVerdict([finger(3, 5)], new Set([3]));
		expect(v.veto).toBe(true);
		expect(v.begin).toEqual([]);
	});
});

describe("where the shield is allowed to run", () => {
	it("stays off apple touch platforms, whose radii are honest and huge", () => {
		expect(palmRadiusTrustworthy({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0)" })).toBe(false);
		expect(
			palmRadiusTrustworthy({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 })
		).toBe(false);
	});

	it("stays off android, whose radii are honest too", () => {
		expect(palmRadiusTrustworthy({ userAgent: "Mozilla/5.0 (Linux; Android 13; Boox)" })).toBe(false);
	});

	it("a palm that flattens mid-contact is swallowed at the move", () => {
		// Landed gently under the threshold, then pressed flat: the verdict
		// on the move must begin the swallow, not just honour old ones.
		const grew = { identifier: 9, radiusX: 24, radiusY: 24 };
		const v = palmVerdict([grew], new Set());
		expect(v.veto).toBe(true);
		expect(v.begin).toEqual([9]);
	});

	it("runs on windows, where it was calibrated", () => {
		expect(
			palmRadiusTrustworthy({ userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32", maxTouchPoints: 10 })
		).toBe(true);
	});
});
