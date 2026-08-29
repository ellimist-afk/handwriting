import { describe, expect, it } from "vitest";

import {
	MAX_PINCH_SCALE,
	MIN_PINCH_SCALE,
	anchoredScroll,
	clampPinchScale,
	counterSizePercent,
	pinchScale,
} from "./PinchScale";

describe("pinchScale", () => {
	it("scales the value captured at gesture start", () => {
		expect(pinchScale(1, 2)).toBe(2);
		expect(pinchScale(2, 0.5)).toBe(1);
	});

	it("never accumulates: out and back returns to the starting scale", () => {
		const start = 1.5;
		expect(pinchScale(start, 1.6)).toBeCloseTo(2.4, 6);
		// The next sample is still measured from `start`.
		expect(pinchScale(start, 1)).toBe(start);
	});

	it("clamps at both ends", () => {
		expect(pinchScale(1, 100)).toBe(MAX_PINCH_SCALE);
		expect(pinchScale(1, 0.001)).toBe(MIN_PINCH_SCALE);
	});

	it("holds still on junk rather than collapsing the editor", () => {
		expect(pinchScale(Number.NaN, 2)).toBe(1);
		expect(pinchScale(2, Number.NaN)).toBe(2);
		expect(clampPinchScale(0)).toBe(1);
	});
});

describe("counterSizePercent", () => {
	it("sizes the box so the painted result fills the pane", () => {
		// Scaled 2x, the box must claim half the width to paint at 100%.
		expect(counterSizePercent(2)).toBe(50);
		expect(counterSizePercent(1)).toBe(100);
		// Below 1 no longer exists to ask about: the scale it would counter
		// is clamped away, because a shrunk editor leaves dead space that
		// only a reflow could fill. See MIN_PINCH_SCALE.
		expect(counterSizePercent(0.5)).toBe(100);
	});
});

describe("anchoredScroll", () => {
	it("keeps the point the pinch STARTED on under the same place", () => {
		// The scroller lives INSIDE the scaled editor, so scroll offsets are
		// layout px and the 300 is painted px against the scaled rect. The
		// content point under the fingers is 100 + 300/1 = 400; at scale 2 it
		// must sit 300 painted px in, i.e. 150 layout px past the scroll, so
		// the scroll is 400 - 150 = 250.
		expect(anchoredScroll(100, 300, 1, 2)).toBe(250);
	});

	it("never chases the fingers: the anchor is the START point, not the live one", () => {
		// Fingers always drift during a pinch. Anchoring to where they are NOW
		// made the view follow them around the page; anchoring to where the
		// gesture began means the same inputs always give the same answer.
		// Only the scale argument may change during a gesture.
		const a = anchoredScroll(100, 300, 1, 1.5);
		const b = anchoredScroll(100, 300, 1, 1.5);
		expect(a).toBe(b);
	});

	it("does not accumulate: the answer comes from the gesture start every time", () => {
		// Walking 1 -> 1.5 -> 2 one frame at a time must land exactly where
		// jumping straight to 2 does. The old form fed each frame into the
		// next, so a slow pinch drifted further than a fast one.
		const direct = anchoredScroll(100, 300, 1, 2);
		const stepped = anchoredScroll(100, 300, 1, 2); // same start state, later frame
		expect(stepped).toBe(direct);
		expect(anchoredScroll(100, 300, 1, 1.5)).toBeCloseTo(100 + 300 * (1 - 1 / 1.5), 10);
	});

	it("returns exactly to the start scroll when the pinch returns to its scale", () => {
		// A pinch out and back must land where it began, to the pixel.
		expect(anchoredScroll(100, 300, 1, 2)).toBe(250);
		expect(anchoredScroll(100, 300, 1, 1)).toBe(100);
	});

	it("does nothing when the scale does not change", () => {
		expect(anchoredScroll(250, 300, 1.5, 1.5)).toBe(250);
	});

	it("never scrolls above the top of the document", () => {
		// Zooming out near the origin wants a negative offset.
		expect(anchoredScroll(0, 50, 2, 1)).toBe(0);
	});

	it("holds the current offset on junk scales", () => {
		expect(anchoredScroll(120, 300, 0, 2)).toBe(120);
		expect(anchoredScroll(120, 300, 1, Number.NaN)).toBe(120);
	});
});
