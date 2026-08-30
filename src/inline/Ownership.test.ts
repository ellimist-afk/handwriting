/**
 * Native-event ownership decisions (M2 input fixes). The DOM wiring is thin;
 * these predicates ARE the policy: a claimed pen gesture decisively owns its
 * mouse-like fallout, and nothing else is ever suppressed.
 */

import { describe, expect, it } from "vitest";
import { contextMenuSuppressed, ownsNativeFallout, suppressNativeFallout } from "./InlinePenRouter";

describe("ownsNativeFallout", () => {
	it("owns during a claimed stroke", () => {
		expect(
			ownsNativeFallout({ activeStroke: true, now: 1000, ownershipTailUntil: 0 })
		).toBe(true);
	});

	it("owns through the post-stroke tail (trailing click/contextmenu land late)", () => {
		expect(
			ownsNativeFallout({ activeStroke: false, now: 1000, ownershipTailUntil: 1300 })
		).toBe(true);
	});

	it("owns nothing once the tail expires — mouse behavior is native again", () => {
		expect(
			ownsNativeFallout({ activeStroke: false, now: 1400, ownershipTailUntil: 1300 })
		).toBe(false);
	});
});

describe("contextMenuSuppressed", () => {
	const base = {
		activeStroke: false,
		now: 1000,
		ownershipTailUntil: 0,
		pointerType: undefined as string | undefined,
		penNear: false,
	};

	it("suppresses mid-stroke (pen long-press must not open a menu)", () => {
		expect(contextMenuSuppressed({ ...base, activeStroke: true })).toBe(true);
	});

	it("suppresses in the tail — the side-button menu fires AFTER pointerup", () => {
		// This is the exact stacking bug: activePenId was already null when the
		// contextmenu event arrived, so the old during-stroke check let it by.
		expect(contextMenuSuppressed({ ...base, ownershipTailUntil: 1300 })).toBe(true);
	});

	it("suppresses pen-sourced menus even with no claimed contact", () => {
		expect(contextMenuSuppressed({ ...base, pointerType: "pen" })).toBe(true);
	});

	it("suppresses while the pen hovers — side-button press without contact", () => {
		expect(contextMenuSuppressed({ ...base, penNear: true })).toBe(true);
	});

	it("normal mouse right-click away from the pen passes through", () => {
		expect(contextMenuSuppressed({ ...base, pointerType: "mouse" })).toBe(false);
		expect(contextMenuSuppressed({ ...base })).toBe(false);
	});

	it("mouse right-click after the tail expires passes through", () => {
		expect(
			contextMenuSuppressed({
				...base,
				now: 2000,
				ownershipTailUntil: 1300,
				pointerType: "mouse",
			})
		).toBe(false);
	});
});

describe("suppressNativeFallout — touch-origin exemption in the tail (v0.13.2)", () => {
	it("suppresses everything during an active stroke — a finger there is a palm", () => {
		expect(
			suppressNativeFallout({
				activeStroke: true,
				now: 1000,
				ownershipTailUntil: 0,
				fromTouch: true,
			})
		).toBe(true);
	});

	it("in the tail: pen/mouse fallout suppressed, finger tap passes", () => {
		const base = { activeStroke: false, now: 1000, ownershipTailUntil: 1300 };
		expect(suppressNativeFallout({ ...base, fromTouch: false })).toBe(true);
		expect(suppressNativeFallout({ ...base, fromTouch: true })).toBe(false);
	});

	it("after the tail nothing is suppressed", () => {
		expect(
			suppressNativeFallout({
				activeStroke: false,
				now: 1400,
				ownershipTailUntil: 1300,
				fromTouch: false,
			})
		).toBe(false);
	});
});
