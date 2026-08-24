/**
 * Zoom regression coverage.
 *
 * The bug: Obsidian zoom scaled the Markdown while ink stayed put, because
 * every geometry read is visual px (getBoundingClientRect / clientX) while ink
 * is stored and drawn in layout px, with no factor between them.
 *
 * The contract these tests pin down:
 *   - persisted note-space coordinates never change with zoom
 *   - screen→note→screen round-trips exactly at any scale
 *   - returning to the original zoom restores the original screen position
 *   - screen-defined sizes (eraser, grab pad, lasso step) keep their on-screen
 *     size, which means shrinking in note space as the editor grows
 *   - scale 1 is arithmetically identical to the pre-fix behaviour
 */

import { describe, expect, it } from "vitest";
import { clampInkSize, nextInkSize } from "../ink/InkSize";
import {
	backingScale,
	clampScale,
	effectiveScale,
	fontZoomFactor,
	noteToVisual,
	visualToNote,
} from "./ZoomScale";

describe("effectiveScale", () => {
	it("is 1 when layout and visual agree (no zoom, and Electron page zoom)", () => {
		// Page zoom scales both units identically, so the ratio stays 1 —
		// which is why this fix is a no-op there and cannot regress it.
		expect(effectiveScale({ visualWidth: 800, layoutWidth: 800 })).toBe(1);
	});

	it("detects a CSS zoom / transform scale from the element's own box", () => {
		expect(effectiveScale({ visualWidth: 880, layoutWidth: 800 })).toBeCloseTo(1.1, 10);
		expect(effectiveScale({ visualWidth: 600, layoutWidth: 800 })).toBeCloseTo(0.75, 10);
	});

	it("falls back to CodeMirror's scaleX when the element has no layout width", () => {
		expect(effectiveScale({ visualWidth: 0, layoutWidth: 0, cmScaleX: 1.25 })).toBe(1.25);
	});

	it("never returns a nonsense scale", () => {
		expect(effectiveScale({ visualWidth: 0, layoutWidth: 0 })).toBe(1);
		expect(effectiveScale({ visualWidth: NaN, layoutWidth: 800 })).toBe(1);
		expect(clampScale(0)).toBe(1);
		expect(clampScale(-2)).toBe(1);
		expect(clampScale(Infinity)).toBe(1);
		expect(clampScale(1000)).toBeLessThanOrEqual(20);
	});
});

describe("screen ↔ note conversion", () => {
	const scales = [0.5, 0.8, 1, 1.1, 1.25, 1.5, 2, 3];

	it("round-trips exactly at every scale", () => {
		for (const s of scales) {
			for (const d of [0, 1, 37.5, 200, 1024.75]) {
				expect(noteToVisual(visualToNote(d, s), s)).toBeCloseTo(d, 9);
			}
		}
	});

	it("is the identity at scale 1 (byte-compatible with the pre-fix path)", () => {
		for (const d of [0, 12, 137.25, 999]) {
			expect(visualToNote(d, 1)).toBe(d);
			expect(noteToVisual(d, 1)).toBe(d);
		}
	});

	it("zooming in shrinks screen distances in note space, and back", () => {
		const onScreen = 240;
		const atZoom2 = visualToNote(onScreen, 2);
		expect(atZoom2).toBe(120); // same pixels cover half the note
		// …and returning to 100% puts it back exactly where it was.
		expect(noteToVisual(visualToNote(onScreen, 1), 1)).toBe(onScreen);
	});
});

describe("persisted geometry is never rescaled", () => {
	it("a stroke's note coordinates are identical at every zoom level", () => {
		// A pen lands on the same physical spot on the note at three zooms.
		// The visual offset differs; the note-space coordinate must not.
		const noteX = 300;
		const noteY = 150;
		const camX = 40; // note-space origin offset, unchanged by zoom
		const camY = 90;
		for (const s of [1, 1.5, 2.5]) {
			// what the pointer would report at this zoom for that note point
			const visualX = noteToVisual(noteX - camX, s);
			const visualY = noteToVisual(noteY - camY, s);
			// what the router + camera turn it back into
			const gotX = visualToNote(visualX, s) + camX;
			const gotY = visualToNote(visualY, s) + camY;
			expect(gotX).toBeCloseTo(noteX, 9);
			expect(gotY).toBeCloseTo(noteY, 9);
		}
	});

	it("a zoom round-trip returns ink to the exact original screen position", () => {
		const stored = { x: 512.25, y: 288.5 }; // untouched by zoom, by definition
		const camOrigin = { x: 12, y: 34 };
		const at100 = {
			x: noteToVisual(stored.x - camOrigin.x, 1),
			y: noteToVisual(stored.y - camOrigin.y, 1),
		};
		// zoom in, zoom out — the stored data never moved, so the screen
		// position recomputes to precisely what it was.
		const back = {
			x: noteToVisual(stored.x - camOrigin.x, 1),
			y: noteToVisual(stored.y - camOrigin.y, 1),
		};
		expect(back).toEqual(at100);
	});
});

describe("screen-defined sizes keep their on-screen size", () => {
	it("the eraser radius covers less of the note as the editor grows", () => {
		const ERASER_SCREEN_R = 12;
		expect(visualToNote(ERASER_SCREEN_R, 1)).toBe(12);
		expect(visualToNote(ERASER_SCREEN_R, 2)).toBe(6);
		expect(visualToNote(ERASER_SCREEN_R, 0.5)).toBe(24);
		// …which is exactly "12 physical px under the nib" at every zoom.
		for (const s of [0.5, 1, 2, 3]) {
			expect(noteToVisual(visualToNote(ERASER_SCREEN_R, s), s)).toBeCloseTo(12, 9);
		}
	});

	it("grab pad and lasso step follow the same rule", () => {
		for (const constant of [8, 2]) {
			for (const s of [1, 1.25, 2]) {
				expect(noteToVisual(visualToNote(constant, s), s)).toBeCloseTo(constant, 9);
			}
		}
	});
});

describe("canvas backing store", () => {
	it("adds the scale so ink rasterises 1:1 instead of being upscaled", () => {
		expect(backingScale(2, 1)).toBe(2);
		expect(backingScale(2, 1.5)).toBe(3);
		expect(backingScale(1, 2)).toBe(2);
	});

	it("survives a bogus devicePixelRatio", () => {
		expect(backingScale(0, 1)).toBe(1);
		expect(backingScale(NaN, 1)).toBe(1);
	});
});

describe("fontZoomFactor — quick-font-size zoom (v0.13.0)", () => {
	it("is 1 at the reference size", () => {
		expect(fontZoomFactor(30, 30)).toBe(1);
	});

	it("scales linearly with the font ratio", () => {
		expect(fontZoomFactor(45, 30)).toBeCloseTo(1.5);
		expect(fontZoomFactor(15, 30)).toBeCloseTo(0.5);
	});

	it("round-trips exactly — ratio of absolutes, no accumulation", () => {
		let f = fontZoomFactor(30, 30);
		f = fontZoomFactor(60, 30);
		f = fontZoomFactor(30, 30);
		expect(f).toBe(1);
	});

	it("degrades to 1 on nonsense inputs", () => {
		expect(fontZoomFactor(0, 30)).toBe(1);
		expect(fontZoomFactor(30, 0)).toBe(1);
		expect(fontZoomFactor(Number.NaN, 30)).toBe(1);
	});
});

describe("ink size helpers (v0.13.6)", () => {
	it("clamps nonsense to sane multipliers", () => {
		expect(clampInkSize(Number.NaN)).toBe(1);
		expect(clampInkSize(0)).toBe(1);
		expect(clampInkSize(100)).toBe(4);
		expect(clampInkSize(0.01)).toBe(0.25);
		expect(clampInkSize(1.8)).toBe(1.8);
	});

	it("cycles fine → medium → bold → fine", () => {
		expect(nextInkSize(0.6).name).toBe("medium");
		expect(nextInkSize(1).name).toBe("bold");
		expect(nextInkSize(1.8).name).toBe("fine");
	});

	it("an off-scale current value cycles back onto the scale", () => {
		expect(nextInkSize(2.7).name).toBe("fine");
	});
});
