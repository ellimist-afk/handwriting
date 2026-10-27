/**
 * A RE-AIM KEEPS THE START'S REFUSAL. The settle re-aims its running ease on each measure attempt
 * (startOverscrollBounce with reaim). With Infinite Canvas on, a start refuses a leftward or upward ease
 * that has no room past the pane's far edge (travelledEaseRoom); a re-aim of the same settle must refuse it
 * the same way, or the page eases into room the start would not give it.
 */
import { describe, expect, it } from "vitest";
import { InkOverlayPlugin } from "./InkOverlay";

function settleWithRunningEase(canvasMode: boolean) {
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	const hold = {};
	overlay.canvasMode = canvasMode;
	overlay.cssScale = 1;
	overlay.viewportPan = { x: 0, y: 0 };
	Object.defineProperty(overlay, "winRef", { value: { performance: { now: () => 1000 } } });
	// No room past the far edge on either axis: the scroll is at its end.
	overlay.view = { scrollDOM: { scrollLeft: 0, scrollTop: 0, clientWidth: 500, clientHeight: 500, scrollWidth: 500, scrollHeight: 500 } };
	// The settle's first ease is running, rightward and downward, which the start allows.
	overlay.bounceOffset = { x: 30, y: 20 };
	overlay.bouncedHold = hold;
	overlay.bounceState = { hold, fromX: 30, fromY: 20, startedAt: 0, raf: 0 };
	return { overlay, hold };
}

describe("a re-aim of the settle's ease", () => {
	it("refuses a travelled leftward or upward ease with no room, as the start does, with Infinite Canvas on", () => {
		const { overlay, hold } = settleWithRunningEase(true);
		// Premise: a fresh start with the same distances is refused.
		const fresh = settleWithRunningEase(true).overlay;
		fresh.bouncedHold = null;
		expect(fresh.startOverscrollBounce({}, -50, -40, true), "premise: the start refuses this ease").toBe(false);
		overlay.startOverscrollBounce(hold, -50, -40, true, true);
		expect(overlay.bounceOffset, "the re-aim eased where the start refused").toEqual({ x: 0, y: 0 });
		expect(overlay.bounceState.fromX).toBe(0);
		expect(overlay.bounceState.fromY).toBe(0);
	});

	it("control: with Infinite Canvas off the same re-aim eases the whole distance", () => {
		const { overlay, hold } = settleWithRunningEase(false);
		expect(overlay.startOverscrollBounce(hold, -50, -40, true, true)).toBe(true);
		expect(overlay.bounceOffset).toEqual({ x: -50, y: -40 });
	});

	it("control: with Infinite Canvas on a rightward and downward re-aim eases the whole distance", () => {
		const { overlay, hold } = settleWithRunningEase(true);
		expect(overlay.startOverscrollBounce(hold, 50, 40, true, true)).toBe(true);
		expect(overlay.bounceOffset).toEqual({ x: 50, y: 40 });
	});
});
