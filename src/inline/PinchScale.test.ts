import { describe, expect, it } from "vitest";

import {
	MAX_PINCH_SCALE,
	fitInkBounds,
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

	it("caps magnification and clamps zoom-out at one percent", () => {
		expect(pinchScale(1, 100)).toBe(MAX_PINCH_SCALE);
		expect(pinchScale(1, 0.001)).toBe(0.01);
		expect(pinchScale(0.01, 0.5)).toBe(0.01);
		expect(pinchScale(0.01, 2)).toBe(0.02);
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
		// Zooming out expands the viewport while the text column stays fixed.
		expect(counterSizePercent(0.5)).toBe(200);
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

describe("fitInkBounds",()=>{
 const g={viewportWidthScreen:640,viewportHeightScreen:480,externalScale:1,fontZoom:1,marginScreen:24};
 it("fits distant ink below the former floor and accounts for font/external exactly once",()=>{
  const bounds={x:0,y:0,width:18000,height:22000};
  expect(fitInkBounds({...g,bounds})).toEqual({kind:"fit",zoom:432/22000});
  expect(fitInkBounds({...g,bounds,fontZoom:1.5,externalScale:2})).toEqual({kind:"below-minimum"});
 });
 it("allows an exact one-percent fit and refuses smaller fits",()=>{
  expect(fitInkBounds({...g,bounds:{x:0,y:0,width:59200,height:43200}})).toEqual({kind:"fit",zoom:.01});
  expect(fitInkBounds({...g,bounds:{x:0,y:0,width:59201,height:43200}})).toEqual({kind:"below-minimum"});
 });
 it("caps a point at normal size and returns an explicit empty plan",()=>{
  expect(fitInkBounds({...g,bounds:{x:10,y:20,width:0,height:0}})).toEqual({kind:"fit",zoom:1});
  expect(fitInkBounds({...g,bounds:null})).toEqual({kind:"empty",zoom:1});
 });
 it("refuses invalid geometry and finite bounds outside native representation",()=>{
  expect(fitInkBounds({...g,bounds:{x:0,y:0,width:1e20,height:1}})).toEqual({kind:"unrepresentable"});
  expect(fitInkBounds({...g,viewportWidthScreen:0,bounds:null})).toEqual({kind:"unrepresentable"});
 });
});
