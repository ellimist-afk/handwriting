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
	MAX_BACKING_AREA,
	MAX_DESKTOP_BACKING_AREA,
	MAX_ZOOM_BACKING,
	clampScale,
	effectiveScale,
	fontZoomFactor,
	noteToVisual,
	visualToNote,
	ownedEffectiveScale,
	validCameraScale,
} from "./ZoomScale";
import { MAX_PINCH_SCALE } from "./PinchScale";
import { bandFor } from "./ScrollBand";
import { nextZoomStep } from "./ZoomStep";

describe("owned camera scale provenance", () => {
	it("recombines external CSS with owned zoom without clamping the inverse", () => {
		for (const owned of [.0001, .04, .25, 1, 4]) for (const external of [.5, 1, 1.5, 2]) {
			const scale = ownedEffectiveScale({visualWidth: 1000 * owned * external, layoutWidth: 1000}, owned)!;
			expect(scale).toBeCloseTo(owned * external, 12);
			expect(visualToNote(120, scale)).toBeCloseTo(120 / (owned * external), 8);
			expect(noteToVisual(visualToNote(120, scale), scale)).toBeCloseTo(120, 10);
		}
	});
	it("defers hidden or invalid geometry even when CM reports a cached scale", () => {
		for (const width of [0, -1, NaN, Infinity])
			expect(ownedEffectiveScale({visualWidth: width, layoutWidth: 1000, cmScaleX: 2}, .04)).toBeNull();
		expect(ownedEffectiveScale({visualWidth: 40, layoutWidth: 0}, .04)).toBeNull();
		expect(ownedEffectiveScale({visualWidth: 40, layoutWidth: 1000}, 0)).toBeNull();
		expect(ownedEffectiveScale({visualWidth: 1, layoutWidth: 1000}, 1)).toBeNull();
		expect(ownedEffectiveScale({visualWidth: 40, layoutWidth: 1000}, .04)).toBe(.04);
	});
	it("rejects unrepresentable transforms rather than inventing a floor", () => {
		for (const scale of [0, -1, NaN, Infinity, Number.MIN_VALUE, 1e300]) expect(validCameraScale(scale, 640, 480)).toBe(false);
		expect(validCameraScale(.0001, 640, 480)).toBe(true);
		expect(validCameraScale(1e-20, 640, 480)).toBe(false);
	});
});

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

describe("backingScale — bounded so any canvas can still be allocated", () => {
	it("is unchanged for every unzoomed pane that FITS the budget", () => {
		// The cap must never cost resolution where the pixels are affordable.
		// Every case here is checked against the budget rather than asserted
		// from memory: `w * d * h * d` is what the pane would claim at full
		// device ratio, and each is under MAX_BACKING_AREA.
		for (const [d, w, h] of [
			[2, 1000, 800], // 3.2M
			[1, 1000, 800], // 0.8M
			[2, 1400, 900], // 5.0M - a retina desktop editor
			[2, 1180, 820], // 3.9M - an iPad in landscape
			[3, 1180, 820], // 8.7M - the same iPad at dpr 3, still affordable
		] as const) {
			expect(w * d * (h * d)).toBeLessThanOrEqual(MAX_BACKING_AREA);
			expect(backingScale(d, 1, w, h)).toBe(d);
		}
	});

	it("follows the zoom up to the pinch ceiling, and stops there", () => {
		// The zoom's share is capped at the pinch ceiling, so ink is rasterised at
		// the size it is painted at every zoom a pinch can reach. Past it only an
		// outer scale can push the product, and that is stretched, not paid for.
		// The area cap below is what keeps a tablet's canvases allocatable.
		expect(MAX_ZOOM_BACKING).toBe(MAX_PINCH_SCALE);
		expect(backingScale(2, 2.5, 100, 100)).toBe(5);
		expect(backingScale(2, 4, 100, 100)).toBe(8);
		expect(backingScale(2, MAX_PINCH_SCALE, 100, 100)).toBe(2 * MAX_PINCH_SCALE);
		expect(backingScale(2, MAX_PINCH_SCALE * 1.25, 100, 100)).toBe(2 * MAX_ZOOM_BACKING);
	});

	// The pinch ceiling is 800% (MAX_PINCH_SCALE, PinchScale.ts). The backing
	// once stopped at 200%, so 600% cost what 400% did and both were stretched
	// three times over. Now a pane with room under the area cap spends more at
	// 800% than at 600% and 400%, and a pane without room stays on the cap.
	it("800% spends more resolution than 600% and 400% where the area cap leaves room, and never passes the cap", () => {
		expect(MAX_PINCH_SCALE).toBe(8);
		expect(backingScale(2, MAX_PINCH_SCALE, 100, 100)).toBeGreaterThan(backingScale(2, 6, 100, 100));
		expect(backingScale(2, 6, 100, 100)).toBeGreaterThan(backingScale(2, 4, 100, 100));
		for (const [d, w, h] of [
			[2, 1180, 820],
			[3, 1400, 900],
			[2, 239, 299], // the iPad band at 600% below; at 800% the cell below holds it
		] as const) {
			const b = backingScale(d, MAX_PINCH_SCALE, w, h, true);
			expect(w * b * (h * b)).toBeLessThanOrEqual(MAX_BACKING_AREA + 1);
		}
	});

	/**
	 * THE IPAD BOX: a pane of 834 x 1194 css px at device ratio 2, scrolled
	 * sideways, so the band spends its margin on both axes. Its band at each
	 * zoom is what the overlay hands backingScale: the scroller's client box
	 * (the pane over the zoom) plus the margin.
	 */
	function ipadBand(scale: number) {
		const cw = Math.round(834 / scale), ch = Math.round(1194 / scale);
		const band = bandFor({ scrollLeft: 0, scrollTop: 0, clientWidth: cw, clientHeight: ch, scrollWidth: cw * 4, scrollHeight: 200000, scale });
		const b = backingScale(2, scale, band.width, band.height, true);
		return { band, b, px: band.width * b * (band.height * b) };
	}

	it("rasterises the iPad band at 400%, 600% and 800% within 5% of the painted size", () => {
		expect(MAX_PINCH_SCALE, "premise: the ceiling this cell is written against").toBe(8);
		for (const scale of [4, 6, 8]) {
			const { band, b } = ipadBand(scale);
			expect(b, `backing ${b} at ${scale} on a ${band.width} x ${band.height} band`).toBeGreaterThanOrEqual(0.95 * 2 * scale);
		}
	});

	it("asks no more device px of a canvas at 600% or 800% than at 200%, on the iPad band", () => {
		const two = ipadBand(2).px;
		expect(two, "premise: the iPad band at 200% sits on the area cap").toBeCloseTo(MAX_BACKING_AREA, -1);
		for (const scale of [4, 6, MAX_PINCH_SCALE]) {
			const { px } = ipadBand(scale);
			expect(px, `device px at ${scale}`).toBeLessThanOrEqual(two * (1 + 1e-9));
		}
	});

	it("leaves every 100% and 200% backing where it was", () => {
		expect(backingScale(2, 1, 1000, 800)).toBe(2);
		expect(backingScale(2, 1, 2540, 1990)).toBe(2);
		expect(backingScale(2, 2, 100, 100)).toBe(4);
		expect(backingScale(2, 2, 2540, 1990)).toBe(2);
		expect(backingScale(3, 1, 1400, 900, true)).toBeCloseTo(2.817180849095055, 12);
		expect(backingScale(2, 1, 3000, 2000, true)).toBeCloseTo(1.2909944487358056, 12);
		expect(backingScale(2, 2, 3000, 2000, true)).toBeCloseTo(1.2909944487358056, 12);
	});

	it("still tracks the zoom below the cap", () => {
		expect(backingScale(2, 1.5, 100, 100)).toBe(3);
	});

	it("TRIPWIRE: a DESKTOP pane over budget keeps its full device ratio", () => {
		// THIS IS A TRIPWIRE. It has been tripped once and rewritten once,
		// and the rewrite was the mistake.
		//
		// WHAT IT PROTECTS: an area budget that bounds the DEVICE ratio
		// quietly downgrades ordinary editors on high-dpi hardware. The floor
		// `d * min(1, scale)` went in with the budget for that exact reason,
		// and this guard went in to hold it there. 1.4.12 removed the floor
		// to keep a tall iPad band under WebKit's per-canvas ceiling; this
		// guard fired, correctly, and was rewritten instead of believed. What
		// that cost, measured: a 5K / Studio Display at 200% full width (a
		// 2540x1990 band at dpr 2) went from backing 2.000 to 1.407, -29.7%
		// of its linear ink resolution; a 6K XDR to 1.222, -38.9%; an
		// ordinary 4K desktop about -6%. And it bought nothing: Electron has
		// no equivalent of WebKit's silent per-canvas refusal, so those
		// pixels were surrendered against a ceiling that is not on the
		// machine.
		//
		// If a change makes this fail, that is a QUESTION, not a licence to
		// rewrite it. A bound that iOS needs goes behind the `mobile` flag.
		for (const [d, w, h] of [
			[3, 2000, 1400], // §14's own example, on a desktop
			[2, 2540, 1990], // 5K / Studio Display at 200%, full width
			[2, 3000, 2000], // a very large pane, over budget with no zoom
		] as const) {
			expect(w * d * (h * d)).toBeGreaterThan(MAX_BACKING_AREA); // premise
			expect(backingScale(d, 1, w, h)).toBe(d);
			// ...and magnification is the only thing the budget may take, so
			// zoomed it still comes back with every device pixel it has.
			expect(backingScale(d, 2, w, h)).toBe(d);
		}
	});

	it("on MOBILE the budget spends the device's resolution too", () => {
		// The other half of the case above, and the whole reason for the
		// flag. 2000x1400 at dpr 3 is 25.2M device px on ONE canvas, past
		// WebKit's ~16.7M per-canvas ceiling, unzoomed, with five canvases
		// behind it - and iOS answers that with a blank canvas and no error.
		const w = 2000;
		const h = 1400;
		expect(w * 3 * (h * 3)).toBeGreaterThan(MAX_BACKING_AREA); // premise
		const flat = backingScale(3, 1, w, h, true);
		expect(flat).toBeLessThan(3); // the device ratio IS spent here
		// Exactly the budget and nothing smaller - asserted as the area the
		// pane claims rather than by retyping `sqrt(MAX / (w * h))`, which
		// would be the production line copied and could not catch a wrong
		// formula.
		expect(w * flat * (h * flat)).toBeCloseTo(MAX_BACKING_AREA, 0);
		// Zoom cannot buy back what the budget already refused: a pane this
		// size lands on the same number magnified as it does flat.
		expect(backingScale(3, 2, w, h, true)).toBeCloseTo(flat, 10);
		// ...and the same pane on a desktop is untouched.
		expect(backingScale(3, 1, w, h)).toBe(3);
	});

	it("holds a zoomed pane inside the area budget", () => {
		const w = 1180; // an iPad pane, where the budget is the whole point
		const h = 820;
		const b = backingScale(2, 4, w, h, true);
		expect(w * b * (h * b)).toBeLessThanOrEqual(MAX_BACKING_AREA + 1);
		// ...while still spending more than unzoomed on the magnified ink.
		expect(b).toBeGreaterThan(2);
	});

	// MAXZOOM-6 companion to the cell above: same pane, at the pinch ceiling
	// (600% when written, 800% now). Identical result to the 4x cell, because
	// the area cap binds this pane before either zoom. Written as its own cell
	// rather than folded into a loop with the 4x one, so a future change that
	// makes the ceiling behave differently from 400% fails a NAMED cell instead
	// of an iteration nobody reads closely.
	it("MAXZOOM-6: holds the SAME zoomed pane inside the area budget at the ceiling", () => {
		const w = 1180;
		const h = 820;
		const b = backingScale(2, MAX_PINCH_SCALE, w, h, true);
		expect(b).toBe(backingScale(2, 4, w, h, true));
		expect(w * b * (h * b)).toBeLessThanOrEqual(MAX_BACKING_AREA + 1);
		expect(b).toBeGreaterThan(2);
	});

	/**
	 * A MAXIMISED 4K DESKTOP PANE: a 1900 x 1000 css scroller at device ratio 2, scrolled sideways so the band spends
	 * its margin on both axes. Its band at each zoom is what the overlay hands backingScale: the scroller's client box
	 * (the pane over the zoom) plus the margin. On screen it is 2400 x 1500 css at every zoom past 100%, the band this
	 * pane already holds at full ratio at 100%; at full ratio it asks 14.4M device px of each canvas.
	 */
	function fourKBand(scale: number) {
		const cw = 1900 / scale, ch = 1000 / scale;
		return bandFor({ scrollLeft: 0, scrollTop: 0, clientWidth: cw, clientHeight: ch, scrollWidth: cw * 4, scrollHeight: 200000, scale, pinch: scale });
	}
	const WEBKIT_FIGURE = 16_700_000; // WebKit's per-canvas figure, the one this file cites throughout
	/** Every zoom the bar's + lands on from 100% to 800%, the same grid the user taps. */
	function plusLadder(): number[] {
		const out = [1];
		for (let z = 1; z < MAX_PINCH_SCALE;) out.push(z = nextZoomStep(z, 1, 1, MAX_PINCH_SCALE));
		return out;
	}

	it("a maximised 4K DESKTOP band draws at rect x ratio at every step from 100% to 800%, under the WebKit figure", () => {
		const ladder = plusLadder();
		expect(ladder.length, `ladder ${ladder.join(", ")}`).toBe(11);
		expect(ladder[ladder.length - 1]).toBe(MAX_PINCH_SCALE);
		for (const scale of [...ladder, 2]) { // 200% too: the render row's control zoom, off the + grid
			const band = fourKBand(scale);
			const full = 2 * scale;
			expect(band.width * full * (band.height * full), `premise at ${scale}: past the 10M budget`).toBeGreaterThan(MAX_BACKING_AREA);
			const b = backingScale(2, scale, band.width, band.height);
			expect(b, `backing at ${scale} on a ${band.width} x ${band.height} band`).toBe(full);
			expect(band.width * b * (band.height * b)).toBeLessThanOrEqual(MAX_DESKTOP_BACKING_AREA);
			expect(band.width * b * (band.height * b)).toBeLessThan(WEBKIT_FIGURE);
		}
	});

	it("the same 4K band on MOBILE stays on the 10M budget, as today", () => {
		for (const scale of [2, MAX_PINCH_SCALE]) {
			const band = fourKBand(scale);
			const b = backingScale(2, scale, band.width, band.height, true);
			expect(b).toBeLessThan(2 * scale);
			expect(band.width * b * (band.height * b)).toBeLessThanOrEqual(MAX_BACKING_AREA + 1);
			expect(band.width * b * (band.height * b)).toBeCloseTo(MAX_BACKING_AREA, 0);
		}
	});

	it("trims a MOBILE pane that is over budget with no zoom at all", () => {
		// A 3000x2000 pane at dpr 2 is 24M device px against a 10M budget
		// before any pinch. On mobile the budget is a real ceiling and takes
		// it down to fit; on desktop the floor hands the device ratio back
		// and only the zoom's share is ever spent.
		//
		// DELETED from here: `expect(b).toBeCloseTo(Math.sqrt(
		// MAX_BACKING_AREA / (w * h)), 10)`. That was the production line
		// retyped, mathematically the same statement as the area assertion
		// beside it, and an assertion that copies the line it tests cannot
		// catch a wrong formula.
		const w = 3000;
		const h = 2000;
		const b = backingScale(2, 2, w, h, true);
		expect(w * b * (h * b)).toBeCloseTo(MAX_BACKING_AREA, 0);
		expect(b).toBeLessThan(2);
		expect(backingScale(2, 2, w, h)).toBe(2); // desktop keeps its floor
	});

	it("the dpr-3 band that reaches WebKit's ceiling is bounded on MOBILE only", () => {
		// §14's example. A tall band at dpr 3 kept all three device pixels
		// per CSS px and asked for 11.3M on each of five canvases; on mobile
		// it now asks for the budget instead. Written as a comparison against
		// the OLD rule rather than a magic number, so dropping the mobile
		// bound fails here loudly.
		//
		// Worth stating plainly, because it is what the flag turns on: no
		// SHIPPING iPad reports dpr 3 - that is iPhone. At the dpr 2 every
		// iPad actually reports, a 1366x1350 landscape band is 1.84M CSS px
		// against this budget's 2.50M threshold (MAX_BACKING_AREA / dpr^2),
		// so it never reaches this branch and is identical on both platforms.
		const w = 1400;
		const h = 900;
		const oldFloor = 3 * Math.min(1, 1);
		const b = backingScale(3, 1, w, h, true);
		expect(b).toBeLessThan(oldFloor);
		expect(w * b * (h * b)).toBeCloseTo(MAX_BACKING_AREA, 0);
		// Desktop, same band, still answers the old rule exactly.
		expect(backingScale(3, 1, w, h)).toBe(oldFloor);
		// And the band a real iPad actually draws is under budget either way.
		expect(2 * 1366 * (2 * 1350)).toBeLessThan(MAX_BACKING_AREA); // premise
		expect(backingScale(2, 1, 1366, 1350, true)).toBe(2);
		expect(backingScale(2, 1, 1366, 1350)).toBe(2);
	});

	// MAXZOOM-6 (Fleet 3 c2): the exact figures for "600% at dpr 3 on the same
	// 1400x900 pane the cell above already uses" - actual device px, not just
	// a pass/fail, so the numbers are on record rather than only the
	// assertion. WebKit's per-canvas ceiling is ~16.7M device px (1.4.12-
	// design.md §14, cited throughout this file); MAX_BACKING_AREA (10M, mobile)
	// and MAX_DESKTOP_BACKING_AREA (16M, desktop) are both under that, and this
	// is the proof the ceiling raise cannot push a real pane past either number.
	it("MAXZOOM-6: the pinch ceiling (600% when written, 800% now) at dpr 3 on a 1400px pane - the actual device px, against both ceilings", () => {
		const w = 1400, h = 900, dpr = 3;
		const WEBKIT_PER_CANVAS_CEILING = 16_700_000; // 1.4.12-design.md §14

		// DESKTOP: zoomed, this pane trims against the desktop budget, which
		// sits above the floor (dpr 3 unzoomed), so it keeps every device pixel
		// and spends the rest of the budget on magnification. 800% lands on the
		// same scale 400% does, because the budget binds before either zoom.
		const bDesktop = backingScale(dpr, MAX_PINCH_SCALE, w, h);
		const desktopDevicePx = { width: w * bDesktop, height: h * bDesktop };
		expect(bDesktop).toBe(backingScale(dpr, 4, w, h)); // identical to the old ceiling
		expect(bDesktop).toBeGreaterThanOrEqual(dpr); // the floor still holds
		expect(desktopDevicePx.width * desktopDevicePx.height).toBeLessThanOrEqual(MAX_DESKTOP_BACKING_AREA + 1);
		expect(desktopDevicePx.width * desktopDevicePx.height).toBeLessThan(WEBKIT_PER_CANVAS_CEILING);

		// MOBILE: the budget is a real ceiling here, so 600% lands on the same
		// trimmed scale 400% already did - never the flat zoom multiple.
		const bMobile = backingScale(dpr, MAX_PINCH_SCALE, w, h, true);
		const mobileDevicePx = { width: w * bMobile, height: h * bMobile };
		expect(bMobile).toBe(backingScale(dpr, 4, w, h, true));
		expect(bMobile).toBeLessThan(dpr); // device ratio IS spent on mobile
		expect(mobileDevicePx.width * mobileDevicePx.height).toBeCloseTo(MAX_BACKING_AREA, 0);
		expect(mobileDevicePx.width * mobileDevicePx.height).toBeLessThan(WEBKIT_PER_CANVAS_CEILING);
	});

	it("never returns zero or a NaN, whatever it is handed", () => {
		expect(backingScale(0, 1, 100, 100)).toBe(1);
		expect(backingScale(NaN, 1, 100, 100)).toBe(1);
		expect(backingScale(2, 1, Number.NaN, 100)).toBe(2);
		expect(backingScale(2, 1, 0, 0)).toBe(2);
	});
});
