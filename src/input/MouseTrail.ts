/**
 * The un-gridding of mouse ink.
 *
 * A pen reports fractional coordinates; a mouse reports whole pixels. Draw
 * with one and the stroke carries a one-pixel staircase along its entire
 * length - not hand tremor but the sensor's grid, rendered faithfully by a
 * pipeline whose flattening tolerance is a quarter pixel, and magnified by
 * however far the page is zoomed (alan, on a pdf at 187%, 2026-08-30).
 *
 * This is a deliberate, narrow exception to the rule in Smoothing.ts that
 * canonical point data stays the real pen data. That rule exists so no filter
 * ever eats a real motion, and it stands for pens; a mouse's integer grid is
 * not motion, and keeping it faithfully means keeping noise. Only samples the
 * router already reclassified as mouse-acting-as-pen come through here.
 *
 * The filter is a four-sample moving average of position - pressure,
 * timestamps and tilt pass through untouched. Four, and even, on purpose:
 * the staircase of a shallow diagonal has period two, and an even window
 * cancels it outright where an odd one only thirds it (the test measures
 * both). The lag - a sample and a half, ~12ms at mouse rates - is invisible
 * behind a mouse, which has no physical nib to compare against. The
 * first sample is emitted unchanged: it is the stroke's anchor, and the
 * reader of an export should find the stroke starting where the click was.
 */

import { PenSample } from "./PointerRouter";

const WINDOW = 4;

export class MouseTrail {
	private xs: number[] = [];
	private ys: number[] = [];

	/** Forget the previous stroke. Called at every mouse pen-down. */
	reset(): void {
		this.xs.length = 0;
		this.ys.length = 0;
	}

	/** One sample in, its smoothed twin out. */
	push(s: PenSample): PenSample {
		this.xs.push(s.x);
		this.ys.push(s.y);
		if (this.xs.length > WINDOW) {
			this.xs.shift();
			this.ys.shift();
		}
		const n = this.xs.length;
		if (n === 1) return s;
		let x = 0;
		let y = 0;
		for (let i = 0; i < n; i++) {
			x += this.xs[i]!;
			y += this.ys[i]!;
		}
		return { ...s, x: x / n, y: y / n };
	}
}
