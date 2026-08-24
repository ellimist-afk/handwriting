import { describe, expect, it } from "vitest";
import { bboxVisibleInViewport, classifyScroll } from "./ScrollProbe";
import { backstopMayEnd, summarizeAcquisitions } from "./InlinePenRouter";

describe("bboxVisibleInViewport", () => {
	const cam = { x: 0, y: 1000 };

	it("sees a stroke inside the viewport", () => {
		expect(bboxVisibleInViewport({ x: 10, y: 1010, width: 50, height: 20 }, cam, 800, 600)).toBe(
			true
		);
	});

	it("sees a stroke straddling an edge", () => {
		expect(
			bboxVisibleInViewport({ x: -20, y: 990, width: 50, height: 20 }, cam, 800, 600)
		).toBe(true);
	});

	it("misses a stroke fully above the viewport", () => {
		expect(bboxVisibleInViewport({ x: 10, y: 0, width: 50, height: 20 }, cam, 800, 600)).toBe(
			false
		);
	});

	it("misses a stroke fully right of the viewport", () => {
		expect(
			bboxVisibleInViewport({ x: 900, y: 1010, width: 50, height: 20 }, cam, 800, 600)
		).toBe(false);
	});
});

describe("classifyScroll", () => {
	it("attributes a scroll to fresh wheel input", () => {
		expect(classifyScroll(5, 5000)).toBe("wheel");
	});

	it("attributes a scroll to fresh touch input", () => {
		expect(classifyScroll(5000, 5)).toBe("touch");
	});

	it("prefers the fresher input when both are fresh", () => {
		expect(classifyScroll(5, 50)).toBe("wheel");
		expect(classifyScroll(50, 5)).toBe("touch");
	});

	it("labels fling tails by whichever input came last", () => {
		expect(classifyScroll(900, 5000)).toBe("wheel-tail");
		expect(classifyScroll(5000, 900)).toBe("touch-tail");
	});

	it("labels a scroll with no input ever as programmatic", () => {
		expect(classifyScroll(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe("program");
	});
});

describe("backstopMayEnd — the window backstop must not race the normal handler", () => {
	it("stands down when the scroller is on the composed path", () => {
		// This same dispatch WILL reach the scroller's capture listener, which
		// terminates the stroke properly (with preventDefault + trace).
		expect(backstopMayEnd({ pointerType: "pen", scrollerInPath: true })).toBe(false);
	});

	it("ends the stroke for a pen-up that bypasses the scroller", () => {
		expect(backstopMayEnd({ pointerType: "pen", scrollerInPath: false })).toBe(true);
	});

	it("ignores non-pen pointers entirely", () => {
		expect(backstopMayEnd({ pointerType: "touch", scrollerInPath: false })).toBe(false);
		expect(backstopMayEnd({ pointerType: undefined, scrollerInPath: false })).toBe(false);
	});
});

describe("summarizeAcquisitions", () => {
	it("counts a healthy capture as delivered == claimed and nothing else", () => {
		const s = summarizeAcquisitions([
			{ type: "window-pointerdown", note: "PAGE RECEIVED IT" },
			{ type: "pointerdown", note: "pen CLAIMED (tip) guard=prearmed" },
			{ type: "pointerup", note: "TERMINATES STROKE" },
		]);
		expect(s).toEqual({ delivered: 1, claimed: 1, ignored: 0, cancelled: 0, pressedHover: 0 });
	});

	it("counts ignored downs, cancels and pressed-but-undelivered hovers", () => {
		const s = summarizeAcquisitions([
			{ type: "window-pointerdown", note: "" },
			{ type: "pointerdown", note: "pen IGNORED: stroke 7 still active" },
			{ type: "pointercancel", note: "TERMINATES STROKE" },
			{ type: "pen-hover", note: "NO CONTACT CLAIMED; buttons=1  <-- PRESSED BUT NO pointerdown" },
			{ type: "pen-hover", note: "NO CONTACT CLAIMED; buttons=0" },
		]);
		expect(s).toEqual({ delivered: 1, claimed: 0, ignored: 1, cancelled: 1, pressedHover: 1 });
	});

	it("does not confuse window-pointercancel with a router pointercancel", () => {
		const s = summarizeAcquisitions([{ type: "window-pointercancel", note: "PAGE RECEIVED IT" }]);
		expect(s.cancelled).toBe(0);
	});
});
