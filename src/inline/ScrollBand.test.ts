import { describe, expect, it } from "vitest";
import {
	BAND_MARGIN_MAX,
	BAND_MARGIN_MIN,
	Band,
	BandViewport,
	bandCovers,
	bandFor,
	bandMargin,
	bandMarginMax,
	bandMarginMin,
	bandNeedsMove,
} from "./ScrollBand";
import { MAX_BACKING_AREA, backingScale } from "./ZoomScale";

function viewport(over: Partial<BandViewport> = {}): BandViewport {
	return {
		scrollLeft: 0,
		scrollTop: 0,
		clientWidth: 800,
		clientHeight: 900,
		scrollWidth: 800,
		scrollHeight: 20000,
		...over,
	};
}

describe("bandMargin", () => {
	it("scales with the viewport, between a floor and a ceiling", () => {
		expect(bandMargin(900)).toBe(225);
		expect(bandMargin(200)).toBe(BAND_MARGIN_MIN);
		expect(bandMargin(4000)).toBe(BAND_MARGIN_MAX);
	});

	/**
	 * THE CEILING IS IN THE READER'S PX, and below 1.0 those are not the
	 * scroller's px. The counter-sized host makes a 900-px pane report a 9000-px
	 * client height at 10%, so the quarter-of-the-viewport fraction asks for
	 * 2250 - and the old ceiling cut it to 320, which is 32 px of headroom for a
	 * fling that covers 113 of them per frame.
	 */
	it("lifts the ceiling by the zoom so the margin stays the same share of the screen", () => {
		// The same pane, at 1.0 and at 0.1. The fraction is what survives.
		expect(bandMargin(900)).toBe(225);
		expect(bandMargin(9000, 0.1)).toBe(2250);
		// Same headroom in visual px, which is the whole claim.
		expect(bandMargin(9000, 0.1) * 0.1).toBe(bandMargin(900));
		// The lifted ceiling still bites: a tall pane at 10% asks for 5000 and
		// gets the ceiling, 320 visual px.
		expect(bandMargin(20000, 0.1)).toBe(BAND_MARGIN_MAX / 0.1);
	});

	/**
	 * THE GUARD, stated as a test rather than as a comment. Nothing at 1.0 moves,
	 * and neither does a caller that reports no scale at all - which is every
	 * caller outside the inline overlay, the PDF surface included. Above 1.0 the
	 * floor and the ceiling are in the reader's px too (the cells below).
	 */
	it("changes nothing at 1.0 or without a scale", () => {
		for (const h of [200, 900, 4000]) {
			expect(bandMargin(h, 1)).toBe(bandMargin(h));
		}
		expect(bandMargin(200)).toBe(BAND_MARGIN_MIN);
		expect(bandMargin(900)).toBe(225);
		expect(bandMargin(4000)).toBe(BAND_MARGIN_MAX);
		// A nonsense scale cannot shrink the margin either: the band is the
		// thing ink is drawn on, and starving it is worse than ignoring a bad
		// number.
		expect(bandMargin(900, 0)).toBe(bandMargin(900));
		expect(bandMargin(900, -1)).toBe(bandMargin(900));
	});

	/**
	 * The band the margin feeds, and the hysteresis that decides when it moves,
	 * must BOTH see the scale - a band sized for 10% whose slack was still
	 * computed at the old ceiling would be re-pinned just as often, and moving
	 * it is what costs a whole-world rasterisation.
	 */
	it("a zoomed-out band survives a flick that would have re-pinned it", () => {
		// A 900x800 pane at 10%: the host is counter-sized, so the scroller
		// reports ten times the px.
		const v = viewport({ clientWidth: 8000, clientHeight: 9000, scrollWidth: 60000, scrollHeight: 200000, scrollLeft: 20000, scrollTop: 20000, scale: 0.1 });
		const band = bandFor(v);
		// 900 layout px is 90 visual px - a third of one fling frame.
		const flick = { ...v, scrollLeft: v.scrollLeft + 900, scrollTop: v.scrollTop + 900 };
		expect(bandNeedsMove(band, flick)).toBe(false);
		expect(bandCovers(band, flick)).toBe(true);
		// The premise: at the old ceiling this same flick moved the band. Read
		// from a band built with no scale reported, which is the old geometry.
		const oldBand = bandFor({ ...v, scale: undefined });
		expect(bandNeedsMove(oldBand, { ...flick, scale: undefined })).toBe(true);
	});
});

describe("bandFor", () => {
	it("puts a margin above and below the viewport", () => {
		const b = bandFor(viewport({ scrollTop: 5000 }));
		expect(b.top).toBe(5000 - 225);
		expect(b.height).toBe(900 + 450);
	});

	it("never extends past the end of the content", () => {
		// An absolutely positioned child extends scrollable overflow. A band
		// hanging below the document would add scroll range, which would move
		// the band, which would add more range - a scroll that never ends.
		const v = viewport({ scrollTop: 19100, scrollHeight: 20000 });
		const b = bandFor(v);
		expect(b.top + b.height).toBeLessThanOrEqual(v.scrollHeight);
		expect(bandCovers(b, v)).toBe(true);
	});

	it("covers the last row when the scroller sits past its rounded end", () => {
		// scrollHeight is an integer; scrollTop is not. Clamping to the rounded
		// reported number leaves a hairline of ink undrawn at the end of a note.
		const v = viewport({ scrollTop: 19100.6, scrollHeight: 20000, clientHeight: 900 });
		expect(bandCovers(bandFor(v), v)).toBe(true);
	});

	it("covers the last column when scrolled fully right", () => {
		const v = viewport({ scrollWidth: 3000, scrollLeft: 2200.4, clientWidth: 800 });
		expect(bandCovers(bandFor(v), v)).toBe(true);
	});

	it("never hangs below the content, however stale the viewport looks", () => {
		// A pinch changes the client size before the scroll offset is
		// reconciled with it, so this pair can read far past the end of the
		// document. A band built on it would hang below the content and ADD
		// scroll range - phantom room the next flick falls into.
		const v = viewport({ scrollTop: 19500, clientHeight: 2400, scrollHeight: 20000 });
		const b = bandFor(v);
		expect(b.top + b.height).toBeLessThanOrEqual(v.scrollHeight + 1);
	});

	it("does the same sideways", () => {
		const v = viewport({ scrollLeft: 2900, clientWidth: 2000, scrollWidth: 3000 });
		const b = bandFor(v);
		expect(b.left + b.width).toBeLessThanOrEqual(v.scrollWidth + 1);
	});

	it("hangs above the origin rather than shrinking, on a short note", () => {
		// Block-start overflow is not scrollable, so a negative top costs
		// nothing - and keeping the HEIGHT constant is what stops five backing
		// stores from being reallocated on every keystroke.
		const v = viewport({ clientHeight: 900, scrollHeight: 900 });
		const b = bandFor(v);
		expect(b.height).toBe(900 + 450);
		expect(b.top).toBe(900 - 1350);
		expect(bandCovers(b, v)).toBe(true);
	});

	it("keeps its height when the document grows or shrinks", () => {
		const tall = bandFor(viewport({ scrollTop: 300, scrollHeight: 90000 }));
		const short = bandFor(viewport({ scrollTop: 300, scrollHeight: 4000 }));
		expect(tall.height).toBe(short.height);
	});

	it("spends horizontal margin only when there is sideways scroll", () => {
		expect(bandFor(viewport()).width).toBe(800);
		const wide = bandFor(viewport({ scrollWidth: 3000, scrollLeft: 500 }));
		expect(wide.width).toBe(800 + 450);
		expect(wide.left).toBe(500 - 225);
	});

	it("reports an empty band for a zero-size editor", () => {
		// A background tab keeps its editor at zero size; this is what lets
		// the canvases be released instead of held on an invisible surface.
		expect(bandFor(viewport({ clientWidth: 0, clientHeight: 0 }))).toEqual({
			left: 0,
			top: 0,
			width: 0,
			height: 0,
		});
	});
});

describe("bandNeedsMove", () => {
	it("leaves the band alone for small scrolls", () => {
		const v = viewport({ scrollTop: 5000 });
		const band = bandFor(v);
		expect(bandNeedsMove(band, { ...v, scrollTop: 5060 })).toBe(false);
	});

	it("moves once the viewport eats into the slack", () => {
		const v = viewport({ scrollTop: 5000 });
		const band = bandFor(v);
		expect(bandNeedsMove(band, { ...v, scrollTop: 5200 })).toBe(true);
	});

	it("stops asking at the end of the document", () => {
		// The clamp makes the wanted position equal the current one, so no
		// amount of consumed slack asks for a move that changes nothing.
		// Without this the last screen of every note repaints forever.
		const v = viewport({ scrollTop: 19100, scrollHeight: 20000 });
		expect(bandNeedsMove(bandFor(v), v)).toBe(false);
	});

	it("stops asking at the top of the document", () => {
		const v = viewport({ scrollTop: 0 });
		expect(bandNeedsMove(bandFor(v), v)).toBe(false);
	});

	it("ignores the sub-pixel wobble at the end of a document", () => {
		// scrollTop is fractional and scrollHeight is a rounded integer, so
		// the wanted position jitters in its last decimals down here. Acting
		// on that repositions the band - and re-rasterizes every visible
		// stroke - on every single scroll event at the bottom of every note.
		const v = viewport({ scrollTop: 19100, scrollHeight: 20000 });
		const band = bandFor(v);
		for (const drift of [0.1, 0.4, 0.6, 0.9, -0.3, -0.8]) {
			expect(bandNeedsMove(band, { ...v, scrollTop: 19100 + drift })).toBe(false);
		}
	});

	it("always takes a size change", () => {
		const v = viewport();
		const band = bandFor(v);
		expect(bandNeedsMove(band, { ...v, clientHeight: 600 })).toBe(true);
		expect(bandNeedsMove(band, { ...v, clientWidth: 0, clientHeight: 0 })).toBe(true);
	});

	it("has nothing to say once the editor is already empty", () => {
		const dead = viewport({ clientWidth: 0, clientHeight: 0 });
		expect(bandNeedsMove(bandFor(dead), dead)).toBe(false);
	});
});

describe("the invariant: a checked scroll position is always covered", () => {
	// This is the property the whole design rests on. Coverage may lapse
	// BETWEEN scroll events - that is what the margin is for, and it shows as
	// ink not yet drawn at an edge rather than ink in the wrong place - but at
	// every position the overlay actually looks at, the band must contain the
	// viewport. A slack too large for the margin would break this, and nothing
	// else in the codebase would notice until ink went missing on hardware.
	function sweep(steps: number[], v0: BandViewport): void {
		let band: Band | null = null;
		let scrollTop = 0;
		for (const step of steps) {
			scrollTop = Math.max(0, Math.min(v0.scrollHeight - v0.clientHeight, scrollTop + step));
			const v = { ...v0, scrollTop };
			if (bandNeedsMove(band, v)) band = bandFor(v);
			expect(band).not.toBeNull();
			if (band && !bandCovers(band, v)) {
				throw new Error(`uncovered at scrollTop=${scrollTop}: band=${JSON.stringify(band)}`);
			}
		}
	}

	it("holds through a slow read-speed scroll", () => {
		sweep(Array.from({ length: 400 }, () => 8), viewport());
	});

	it("holds through a hard fling (113px per frame, hardware-measured)", () => {
		sweep(Array.from({ length: 300 }, () => 113), viewport());
	});

	it("holds through direction reversals", () => {
		const steps: number[] = [];
		for (let i = 0; i < 200; i++) steps.push(i % 2 === 0 ? 240 : -180);
		sweep(steps, viewport());
	});

	it("holds when a single jump crosses the whole band", () => {
		sweep([9000, -9000, 4321, -1, 15000], viewport());
	});

	it("holds against the ends of a short document", () => {
		sweep([200, 200, 200, -600, 50], viewport({ scrollHeight: 1200 }));
	});

	it("holds while scrolling sideways too", () => {
		const v0 = viewport({ scrollWidth: 4000 });
		let band: Band | null = null;
		for (let scrollLeft = 0; scrollLeft <= 3200; scrollLeft += 97) {
			const v = { ...v0, scrollLeft: Math.min(scrollLeft, v0.scrollWidth - v0.clientWidth) };
			if (bandNeedsMove(band, v)) band = bandFor(v);
			if (band && !bandCovers(band, v)) {
				throw new Error(`uncovered at scrollLeft=${v.scrollLeft}`);
			}
		}
	});
});

/**
 * WHAT THE LIFTED CEILING COSTS BELOW THE TEN-PERCENT FLOOR.
 *
 * Written when 0.1 was a floor every request had to clear, so the render
 * harness could not settle at 0.019. Since 2026-09-13 Fit commits below it
 * (Alan: Fit breaks the 10% clamp) and LagAtLowZoom's bandCost arm measures
 * 0.019 through Fit's commit; this arithmetic stands as the unit-level twin.
 * Computing the cost rather than leaving it unknown still holds: a
 * ceiling divided by the scale is only defensible if the band's cost does NOT
 * follow 1/scale, and the shipped functions can be asked directly.
 *
 * PURE, and therefore not evidence about a live host. It is evidence about the
 * arithmetic every live host runs, which is the thing the ceiling changed.
 */
describe("band cost below the zoom floor", () => {
	/** The pane the render arms use, in the px the reader sees. */
	const PANE_W = 1397.5;
	const PANE_H = 800;
	const DPR = 2;

	/** The counter-sized scroller a given scale produces from that pane. */
	function at(scale: number): { margin: number; band: Band; backingPx: number } {
		const v = viewport({
			clientWidth: PANE_W / scale,
			clientHeight: PANE_H / scale,
			// Sideways scrollable, so the horizontal margin is actually spent.
			scrollWidth: 60000 / scale,
			scrollHeight: 200000 / scale,
			scale,
		});
		const band = bandFor(v);
		const b = backingScale(DPR, scale, band.width, band.height);
		return { margin: bandMargin(v.clientHeight, scale), band, backingPx: Math.round(band.width * b) * Math.round(band.height * b) };
	}

	it("costs the same at 0.019 as at 1.0, and stays inside the per-canvas cap", () => {
		const fit = at(0.019176);
		const one = at(1);
		// The margin is the same headroom for the reader at both scales...
		expect(fit.margin * 0.019176).toBeCloseTo(one.margin, 0);
		// ...so the band is the same size on screen...
		expect(fit.band.width * 0.019176).toBeCloseTo(one.band.width, 0);
		expect(fit.band.height * 0.019176).toBeCloseTo(one.band.height, 0);
		// ...and the canvases are the same allocation, because `backingScale`
		// multiplies by the very scale the band divided by.
		expect(fit.backingPx / one.backingPx).toBeCloseTo(1, 1);
		// THE CEILING THAT ACTUALLY EXISTS is per canvas, and neither scale is
		// near it. If a pane ever crosses it, it crosses at 1.0 first.
		expect(fit.backingPx).toBeLessThan(MAX_BACKING_AREA);
		expect(one.backingPx).toBeLessThan(MAX_BACKING_AREA);
	});

	it("the ceiling, not the fraction, is what a tall pane meets - at every scale alike", () => {
		// A pane over 1280 visual px tall asks for more than 320 visual px and
		// gets the ceiling. That was true before this change and is still true:
		// what changed is that the ceiling is now 320 of the READER's px rather
		// than 320 of the scroller's.
		expect(bandMargin(2000, 1)).toBe(BAND_MARGIN_MAX);
		expect(bandMargin(2000 / 0.019176, 0.019176)).toBeCloseTo(BAND_MARGIN_MAX / 0.019176, 0);
	});
});

/**
 * ABOVE 1.0 THE FLOOR AND THE CEILING ARE IN THE READER'S PX TOO. The scroller's client box shrinks by the zoom, so a
 * floor of 120 scroller px is 960 screen px at 800%: a band that big asks the canvases for far more area than the
 * same pane at 100%, and the area cap then takes it out of the ink's resolution. Divided by the scale, the margin is
 * the 100% margin on screen at every zoom, so the backing can follow the zoom and the ink stays sharp.
 *
 * Divided and then ROUNDED TO THE NEAREST whole px: a fractional margin makes a fractional band box, and the overlay
 * measures its scale from that box against a whole offsetWidth. Never a ceil or a floor: those flip at the very
 * scales the zoom steps land on (120 / 8 against 120 / 7.999999).
 */
describe("the band margin above 1.0", () => {
	/** Screen heights: the floor binds, the fraction binds, the ceiling binds. */
	const SHORT = 300, MID = 1192, TALL = 2000;
	const client = (screen: number, scale: number) => Math.round(screen / scale);

	it("is the 100% margin on screen at every zoom, within half a scroller px", () => {
		for (const screen of [SHORT, MID, TALL]) {
			const atOne = bandMargin(screen);
			for (const scale of [1, 2, 4, 6, 8]) {
				const m = bandMargin(client(screen, scale), scale);
				expect(Math.abs(m - atOne / scale), `screen ${screen} at ${scale}: margin ${m}, want ${atOne / scale}`).toBeLessThanOrEqual(0.5);
			}
		}
		// The floor and the ceiling themselves.
		expect(bandMargin(client(SHORT, 8), 8)).toBe(15);
		expect(bandMargin(client(TALL, 8), 8)).toBe(40);
	});

	it("does not move at or below 1.0", () => {
		expect(bandMargin(400, 0.5)).toBe(BAND_MARGIN_MIN);
		expect(bandMargin(1800, 0.5)).toBe(450);
		expect(bandMargin(4000, 0.5)).toBe(BAND_MARGIN_MAX / 0.5);
		for (const h of [200, 900, 4000]) expect(bandMargin(h, 1)).toBe(bandMargin(h));
	});

	it("keeps the band box on whole px at zooms that do not divide the floor or the ceiling", () => {
		for (const scale of [1.5625, 3, 5.96, 7]) for (const screen of [SHORT, TALL]) {
			const cw = client(834, scale), ch = client(screen, scale);
			const v = viewport({ clientWidth: cw, clientHeight: ch, scrollWidth: cw * 3, scrollHeight: 100000, scrollTop: 1000.37, scrollLeft: 10.5, scale });
			const band = bandFor(v), m = bandMargin(ch, scale);
			expect(Number.isInteger(m), `margin ${m} at ${scale}, screen ${screen}`).toBe(true);
			expect(Number.isInteger(band.width) && Number.isInteger(band.height), `band ${band.width} x ${band.height} at ${scale}, screen ${screen}`).toBe(true);
		}
	});

	it("gives the same margin at the zoom steps and a hair either side of them", () => {
		for (const scale of [2, 4, 6, 8]) for (const screen of [SHORT, TALL]) {
			const ch = client(screen, scale), m = bandMargin(ch, scale);
			expect(bandMargin(ch, scale * (1 + 1e-6)), `${scale} + 1e-6, screen ${screen}`).toBe(m);
			expect(bandMargin(ch, scale * (1 - 1e-6)), `${scale} - 1e-6, screen ${screen}`).toBe(m);
		}
	});

	/** Band moves while a 300 screen px fling plays in 30 scroll events, from a band just placed. */
	function flingMoves(screen: number, scale: number): number {
		const cw = client(834, scale), ch = client(screen, scale), top = 5000 / scale;
		let v = viewport({ clientWidth: cw, clientHeight: ch, scrollWidth: cw, scrollHeight: 400000 / scale, scrollTop: top, scale });
		let band = bandFor(v), moves = 0;
		for (let i = 1; i <= 30; i++) {
			v = { ...v, scrollTop: top + (300 / scale) * i / 30 };
			if (bandNeedsMove(band, v)) { band = bandFor(v); moves++; }
		}
		return moves;
	}

	it("moves the band no more often during a fling at 600% or 800% than at 100%", () => {
		for (const screen of [SHORT, MID, TALL]) {
			const one = flingMoves(screen, 1);
			expect(one, `premise: a 300 px fling moves the band at 100% (screen ${screen})`).toBeGreaterThan(0);
			for (const scale of [6, 8]) {
				const n = flingMoves(screen, scale);
				// eslint-disable-next-line no-console
				console.log(`BAND FLING screen ${screen} scale ${scale}: ${n} moves, ${one} at 100%`);
				expect(n, `screen ${screen} at ${scale}`).toBeLessThanOrEqual(one);
			}
		}
	});
});

/**
 * AN OUTER CSS SCALE IS NOT A ZOOM THE PERSON SET. The zoom the person sets and reads on the zoom bar is the pinch
 * (getNoteViewportState reads pinchScaleNow); `scale` is the pinch times the pane's own outer CSS scale, 1.25 on the
 * rig the band comments cite. At a pinch at or below 100% the margin is the base's whatever the outer scale. Above it
 * the division is by the pinch when the outer scale is above 1, because the base's 100% band already holds that outer
 * scale, so the margin at a pinch of 2 is half the 100% margin of the same pane. When the
 * outer scale is below 1 it is by the whole scale, as before, because the zoomed-out branch already divides by it.
 *
 * The base numbers, from before the margin was divided above 1: below a scale of 1 the ceiling is 320 / scale, and at or above it 320 and 120 stand.
 */
describe("the band margin under an outer CSS scale", () => {
	it("at outer 1.25 and a pinch at or below 100%, is the base margin", () => {
		for (const pinch of [1, 0.9, 0.8]) {
			const s = 1.25 * pinch;
			expect([bandMargin(320, s, pinch), bandMargin(1120, s, pinch), bandMargin(4000, s, pinch), bandMarginMax(s, pinch), bandMarginMin(s, pinch)], `pinch ${pinch}`)
				.toEqual([120, 280, 320, 320, 120]);
		}
		// Below a scale of 1 overall, the zoomed-out branch, unchanged by the division above 1.
		expect(bandMargin(4000, 1.25 * 0.5, 0.5)).toBe(512);
	});

	it("at outer 1.25 and a pinch of 2, divides by the pinch: half the 100% margin", () => {
		expect([bandMarginMax(2.5, 2), bandMarginMin(2.5, 2), bandMargin(4000, 2.5, 2), bandMargin(560, 2.5, 2)]).toEqual([160, 60, 160, 140]);
	});

	it("places and keeps the band by the pinch: bandFor and bandNeedsMove at outer 1.25, pinch 1", () => {
		const v = viewport({ clientHeight: 1120, scrollTop: 5000, scale: 1.25, pinch: 1 });
		const band = bandFor(v);
		expect([band.top, band.height], "a margin of 280 each way, the base's").toEqual([4720, 1680]);
		// 135 px of band left below the pane: inside the base's half-margin slack of 140, so the band moves.
		expect(bandNeedsMove(band, { ...v, scrollTop: 5145 })).toBe(true);
		expect(bandNeedsMove(band, { ...v, scrollTop: 5135 }), "control: 145 px left, outside the slack").toBe(false);
	});

	it("control: a caller that reports no pinch, or an outer scale at or below 1, gets the margin divided by the whole scale", () => {
		expect([bandMarginMax(2), bandMarginMax(8), bandMarginMin(8), bandMarginMax(0.5)]).toEqual([160, 40, 15, 640]);
		for (const [s, p] of [[2, 2], [8, 8], [1.6, 2], [0.88, 1.1], [0.5, 0.5]]) for (const h of [300, 1120, 4000])
			expect(bandMargin(h, s, p), `scale ${s} pinch ${p}, client ${h}`).toBe(bandMargin(h, s));
	});
});
