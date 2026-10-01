/**
 * ONE CEILING, FOUR SITES (MAXZOOM-6). Folded in from an independent,
 * uncoordinated draft (`maxzoom-6-cells-1420`, 12707122) written against the
 * two InkOverlay.ts sites known at the time; this version adds the third
 * InkOverlay.ts site and the MobileTools.ts button-disable site that this
 * branch's own fix touched.
 *
 * The note's maximum zoom is written in four places, and only one of them is
 * the named constant's definition:
 *
 *   src/inline/PinchScale.ts   MAX_PINCH_SCALE, the clamp every pinch goes through
 *   src/inline/InkOverlay.ts   applyPinchScale's preview-branch `next > MAX_PINCH_SCALE` guard
 *   src/inline/InkOverlay.ts   zoomNoteBy's `Math.min(MAX_PINCH_SCALE, ...)` clamp, the +/- buttons and commands
 *   src/inline/InkOverlay.ts   commitCameraScale's `next>MAX_PINCH_SCALE` refusal, the last gate before a commit
 *   src/inline/MobileTools.ts  the "+" button's `zoom>=MAX_PINCH_SCALE` disable check
 *
 * `ZoomFloorLock.test.ts` and `MobileTools.test.ts` already pin the BEHAVIOUR
 * at each of these sites (a commit/preview/button reaching the real ceiling,
 * the plus button disabling at the right point). This file pins the SOURCE
 * instead: it reads the identifier each site references out of the file text
 * and requires it to be `MAX_PINCH_SCALE`, not a numeral. A literal that
 * happens to equal today's ceiling would still pass every behavioural test
 * and drift silently the next time the constant moves - which is exactly the
 * gap review caught on 772960c7 (two bare `4`s survived a change to the
 * constant because nothing read the source to check). Node only: no render,
 * no browser.
 */

import { describe, expect, it } from "vitest";
import overlaySource from "./InkOverlay.ts?raw";
import stripSource from "./MobileTools.ts?raw";
import { MAX_PINCH_SCALE, MIN_PINCH_SCALE } from "./PinchScale";

const overlay = overlaySource.replace(/\r\n/g, "\n");
const strip = stripSource.replace(/\r\n/g, "\n");

/** applyPinchScale's preview branch: the live-pinch guard, no commit. */
function previewCeiling(): string {
	// A later change widened the preview ceiling by the cap give (`MAX_PINCH_SCALE * PINCH_GIVE`); the pin reads the constant either way.
	const m = overlay.match(/this\.scaleGeometryValid === false \|\| next > (\w+)(?: \* PINCH_GIVE)? \|\|/);
	expect(m, "applyPinchScale's preview guard was not found in InkOverlay.ts; update this pin with it").not.toBeNull();
	return m![1]!;
}

/** The one line of `zoomNoteBy` that bounds a button or command zoom. */
function zoomNoteByCeiling(): string {
	const m = overlay.match(/const next=Math\.max\(Math\.min\(this\.zoomFloor,this\.pinchScaleNow\),Math\.min\((\w+),this\.pinchScaleNow\*factor\)\);/);
	expect(m, "zoomNoteBy's clamp line was not found in InkOverlay.ts; update this pin with it").not.toBeNull();
	return m![1]!;
}

/** `commitCameraScale`'s refusal, the last gate a pinch passes before it is committed. */
function commitCameraScaleCeiling(): string {
	const m = overlay.match(/\|\|next>(\w+)\|\|!validCameraScale\(next,/);
	expect(m, "commitCameraScale's `next>N` refusal was not found in InkOverlay.ts; update this pin with it").not.toBeNull();
	return m![1]!;
}

/** The zoom-bar "+" button's disable check. */
function plusButtonCeiling(): string {
	const m = strip.match(/i\s*===\s*2\s*&&\s*state\.zoom\s*>=\s*(\w+)/);
	expect(m, "the plus button's disable check was not found in MobileTools.ts; update this pin with it").not.toBeNull();
	return m![1]!;
}

describe("the note's zoom ceiling is one constant, referenced everywhere", () => {
	it("applyPinchScale's preview guard reads MAX_PINCH_SCALE", () => {
		expect(previewCeiling(), "the preview branch still refuses at a literal; MAX_PINCH_SCALE moved without it").toBe("MAX_PINCH_SCALE");
	});

	it("zoomNoteBy bounds at MAX_PINCH_SCALE", () => {
		expect(zoomNoteByCeiling(), "zoomNoteBy still caps at its own literal; MAX_PINCH_SCALE moved without it").toBe("MAX_PINCH_SCALE");
	});

	it("commitCameraScale refuses above MAX_PINCH_SCALE", () => {
		expect(commitCameraScaleCeiling(), "commitCameraScale still refuses at its own literal; MAX_PINCH_SCALE moved without it").toBe("MAX_PINCH_SCALE");
	});

	it("the plus button disables at MAX_PINCH_SCALE", () => {
		expect(plusButtonCeiling(), "the plus button still disables at its own literal; MAX_PINCH_SCALE moved without it").toBe("MAX_PINCH_SCALE");
	});

	it("the ceiling is 600%, and the floor is still below it", () => {
		expect(MAX_PINCH_SCALE).toBe(6);
		expect(MIN_PINCH_SCALE).toBeGreaterThan(0);
		expect(MAX_PINCH_SCALE).toBeGreaterThan(MIN_PINCH_SCALE);
	});
});

/**
 * MAXZOOM-6 (Fleet 3 c2): does raising the ceiling put a wide, magnified note
 * out of MAX_VIEWPORT_LAYOUT's reach?
 *
 * MAX_VIEWPORT_LAYOUT (PinchScale.ts, 8,000,000) bounds the viewport's own
 * LAYOUT-px box - `handleResize`'s `width/this.pinchScaleNow<=MAX_VIEWPORT_LAYOUT`
 * (InkOverlay.ts ~3179), the preview/settle guards' `layout.width/next<=...`
 * (~5418, ~5572), and `commitCameraScale`'s own bound on `target.left/top`
 * (~7455) - never the note's ink-content width directly. Every one of these
 * divides a screen/pane dimension BY the scale before comparing it to the
 * constant, so a HIGHER scale can only shrink the tested quantity: whatever
 * passed at 400% passes at 600% by construction, and nothing that failed at
 * 400% can newly pass either. The cell below is that argument made concrete
 * with the actual arithmetic at both ceilings on a wide (3000 note-px) note,
 * rather than left as an assertion about the source.
 *
 * WHAT THIS DOES NOT COVER: whether the note's own SCROLL RANGE - the native
 * scrollWidth/scrollHeight a 3000-note-px-wide document's column-anchored
 * pinch actually lands on at 6x, and whether the x-anchor keeps the column
 * centred there the way tonight's RLL fix does at every OTHER scale - is
 * correct. That is `test/render/ScrollColumnAnchorPinch.test.ts` /
 * `scrollColumnAnchorPage.ts` territory: it needs the real column-measurement
 * and paint path the render harness drives, which no node-only cell can
 * stand in for honestly. Surveyed, not added tonight - see the handback notes
 * for the exact ramp/pauseAt extension this needs once render-suite time is
 * clear (the render suite launches a real browser; something else is already
 * using it tonight per the original brief, and `chrome-headless-shell` is
 * confirmed running as of this pin).
 */
describe("MAX_VIEWPORT_LAYOUT only gets MORE permissive as the ceiling rises", () => {
	it("a pane already representable at 400% stays representable at 600%, and the reverse never happens", () => {
		const MAX_VIEWPORT_LAYOUT = 8_000_000;
		// A wide note: 3000 note-px, plus headroom a real pane's own box could
		// plausibly reach (well past anything a screen's own clientWidth is),
		// checked at both ceilings.
		for (const paneWidthLayoutPx of [3000, 100_000, 7_999_999, 8_000_000 * 4, 8_000_000 * 6]) {
			const passesAt4 = paneWidthLayoutPx / 4 <= MAX_VIEWPORT_LAYOUT;
			const passesAt6 = paneWidthLayoutPx / MAX_PINCH_SCALE <= MAX_VIEWPORT_LAYOUT;
			// Dividing by a LARGER scale only shrinks the tested quantity.
			if (passesAt4) expect(passesAt6, `${paneWidthLayoutPx} passed at 400% but not 600%`).toBe(true);
			if (!passesAt6) expect(passesAt4, `${paneWidthLayoutPx} failed at 600% but passed at 400%`).toBe(false);
		}
		// The exact boundary case moves out, not in: exactly 8,000,000 * 4 layout
		// px was the largest pane 400% could represent; at 600% it is smaller
		// relative to the same cap, i.e. still representable with room to spare.
		expect((8_000_000 * 4) / 4).toBe(MAX_VIEWPORT_LAYOUT);
		expect((8_000_000 * 4) / MAX_PINCH_SCALE).toBeLessThan(MAX_VIEWPORT_LAYOUT);
	});
});
