import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CameraState } from "../camera/coordinates";
import { setInkShaping } from "./InkShape";
import { setPressureSensitivity } from "./PenStyle";
import { computeBBox, InkPoint, InkStroke } from "./Stroke";
import { bumpStrokeRev } from "./StrokeRev";
import { drawStroke, resetRibbonCacheStats, ribbonCacheStats } from "./StrokeRenderer";

/**
 * The ribbon cache has exactly one job and exactly one way to be wrong.
 *
 * The job: a committed stroke redrawn unchanged must not be flattened twice.
 * The way to be wrong: committed strokes are mutated in place, so a cache
 * keyed on identity alone would draw the ink where it WAS after a lasso drag.
 * Both are measured here through `ribbonCacheStats().flattens` - a counter
 * incremented inside StrokeRenderer at the flatten itself, so it counts the
 * work rather than trusting a stub of a module export to have been reached.
 */

const CAM: CameraState = { x: 0, y: 0, zoom: 1 };

/** Enough of a 2d context for the ribbon fill path. */
function fakeCtx(): CanvasRenderingContext2D {
	return {
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 0,
		lineCap: "",
		lineJoin: "",
		beginPath() {},
		moveTo() {},
		lineTo() {},
		closePath() {},
		arc() {},
		fill() {},
		stroke() {},
		save() {},
		restore() {},
	} as unknown as CanvasRenderingContext2D;
}

function stroke(id = "s1"): InkStroke {
	const points: InkPoint[] = [
		{ x: 0, y: 0, pressure: 0.5, t: 0 },
		{ x: 10, y: 4, pressure: 0.6, t: 8 },
		{ x: 22, y: 3, pressure: 0.7, t: 16 },
		{ x: 30, y: 12, pressure: 0.5, t: 24 },
	];
	return { id, tool: "pen", color: "#111111", width: 2, points, bbox: computeBBox(points, 2), createdAt: 0 };
}

function draw(s: InkStroke, zoom = 1): void {
	drawStroke(fakeCtx(), zoom === 1 ? CAM : { x: 0, y: 0, zoom }, s, undefined, true);
}

describe("the committed ribbon cache", () => {
	beforeEach(() => {
		resetRibbonCacheStats();
		setInkShaping(true);
	});
	afterEach(() => {
		setInkShaping(true);
		setPressureSensitivity(true);
	});

	it("flattens once when the same stroke is drawn twice at one zoom", () => {
		const s = stroke();
		draw(s);
		draw(s);
		expect(ribbonCacheStats().flattens).toBe(1);
		expect(ribbonCacheStats().hits).toBe(1);
		expect(ribbonCacheStats().misses).toBe(1);
	});

	it("misses after the revision is bumped", () => {
		const s = stroke();
		draw(s);
		bumpStrokeRev(s);
		draw(s);
		expect(ribbonCacheStats().flattens).toBe(2);
		expect(ribbonCacheStats().hits).toBe(0);
	});

	it("misses when the zoom changes, and again on the way back", () => {
		const s = stroke();
		draw(s, 1);
		draw(s, 2);
		expect(ribbonCacheStats().flattens).toBe(2);
		// One entry per stroke: the old zoom is not kept alongside the new.
		draw(s, 1);
		expect(ribbonCacheStats().flattens).toBe(3);
		expect(ribbonCacheStats().hits).toBe(0);
	});

	it("compares zoom exactly, not rounded", () => {
		const s = stroke();
		draw(s, 1);
		draw(s, 1.0000001);
		expect(ribbonCacheStats().flattens).toBe(2);
	});

	it("misses after the shaping toggle flips", () => {
		const s = stroke();
		draw(s);
		setInkShaping(false);
		draw(s);
		expect(ribbonCacheStats().flattens).toBe(2);
		expect(ribbonCacheStats().hits).toBe(0);
		// And hits again once it has been drawn under the new setting.
		draw(s);
		expect(ribbonCacheStats().hits).toBe(1);
	});

	it("misses after pressure sensitivity flips", () => {
		// `widthForPressure` substitutes NO_PRESSURE at every sample when this
		// is off, so it is a second width law with its own setting and its own
		// command. It was absent from the key, and both writers repaint through
		// `repaintAllInkOverlays`, which found rev, zoom, shaping and smooth all
		// unchanged: the page kept the ribbon built under the OTHER law, and a
		// page with some strokes cached and some not showed both (§5l/AE5).
		const s = stroke();
		draw(s);
		setPressureSensitivity(false);
		draw(s);
		expect(ribbonCacheStats().flattens).toBe(2);
		expect(ribbonCacheStats().hits).toBe(0);
		draw(s);
		expect(ribbonCacheStats().hits).toBe(1);
		// And back again: the entry keyed on the old value must not be served.
		setPressureSensitivity(true);
		draw(s);
		expect(ribbonCacheStats().flattens).toBe(3);
	});

	it("misses when the stroke's tool changes", () => {
		// The tool decides `flat`, which decides both the shaping and the
		// centerline. No in-place tool mutation exists today; the key carries it
		// so that one could not silently serve a pen ribbon for a highlighter.
		const s = stroke();
		draw(s);
		s.tool = "highlighter";
		draw(s);
		expect(ribbonCacheStats().flattens).toBe(2);
	});

	it("keeps a stroke drawn with a style override out of the cache", () => {
		const s = stroke();
		drawStroke(fakeCtx(), CAM, s, { gamma: 1 }, true);
		drawStroke(fakeCtx(), CAM, s, { gamma: 1 }, true);
		expect(ribbonCacheStats().flattens).toBe(2);
		expect(ribbonCacheStats().hits).toBe(0);
		expect(ribbonCacheStats().misses).toBe(0);
	});

	it("keeps a wet stroke out of the cache when the caller opts out", () => {
		const s = stroke();
		drawStroke(fakeCtx(), CAM, s, undefined, true, false);
		drawStroke(fakeCtx(), CAM, s, undefined, true, false);
		expect(ribbonCacheStats().flattens).toBe(2);
		expect(ribbonCacheStats().misses).toBe(0);
		// The opt-out left no entry behind, so the first cached draw misses.
		draw(s);
		expect(ribbonCacheStats().misses).toBe(1);
	});

	it("does not flatten at all on the unsmoothed segment path", () => {
		const s = stroke();
		drawStroke(fakeCtx(), CAM, s, undefined, false);
		expect(ribbonCacheStats().flattens).toBe(0);
	});

	it("caches per stroke, not per module", () => {
		const a = stroke("a");
		const b = stroke("b");
		draw(a);
		draw(b);
		draw(a);
		draw(b);
		expect(ribbonCacheStats().flattens).toBe(2);
		expect(ribbonCacheStats().hits).toBe(2);
	});
});
