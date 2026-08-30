/**
 * The silent-lift predicate IS the policy (same stance as Ownership.test.ts):
 * a raw sample that still claims a live stroke but reads as pure hover must
 * end the stroke instead of becoming ink.
 *
 * The defect this pins down: the Surface Slim Pen can lift without a
 * discrete pointerup reaching the app. All four end paths (pointerup,
 * pointercancel, lostpointercapture, the window backstop) wait for an event
 * that never comes, the pointerId stays claimed, and every hover raw update
 * afterward trails ink behind the pen. The Surface Pen (1776) always
 * delivers the event and never hits this path.
 */

import { describe, expect, it } from "vitest";
import { silentLift } from "./PointerRouter";

const TIP = 1;
const SIDE_BUTTON = 2;
const ERASER = 32;

describe("silentLift — hover sample while a stroke is still claimed", () => {
	it("fires on the hover signature: no pressure, no contact bits", () => {
		expect(silentLift({ pressure: 0, buttons: 0 })).toBe(true);
	});

	it("fires even with the side button held through the lift", () => {
		// Hover with side-button pressed reports buttons=2; the pen is still off
		// the glass. The side-button bit must not keep a dead stroke alive.
		expect(silentLift({ pressure: 0, buttons: SIDE_BUTTON })).toBe(true);
	});

	it("never fires while the tip is in contact", () => {
		expect(silentLift({ pressure: 0.4, buttons: TIP })).toBe(false);
		expect(silentLift({ pressure: 0.4, buttons: TIP | SIDE_BUTTON })).toBe(false);
	});

	it("never fires while the eraser is in contact", () => {
		expect(silentLift({ pressure: 0.2, buttons: ERASER })).toBe(false);
	});

	it("a mid-stroke pressure dip still carries the tip bit: no end", () => {
		expect(silentLift({ pressure: 0, buttons: TIP })).toBe(false);
		expect(silentLift({ pressure: 0, buttons: ERASER })).toBe(false);
	});

	it("a buttons glitch mid-contact still carries pressure: no end", () => {
		// This digitizer family has been seen reporting pressed-with-no-
		// pointerdown; assume the inverse glitch exists too. Requiring both
		// halves of the hover signature keeps a real stroke alive through it.
		expect(silentLift({ pressure: 0.3, buttons: 0 })).toBe(false);
	});
});
