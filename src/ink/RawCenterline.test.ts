import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CameraState } from "../camera/coordinates";
import { centerlineSmoothed, flattenStrokeShaped, setInkShaping } from "./InkShape";
import { PenStyle } from "./PenStyle";
import { flattenStroke } from "./Ribbon";
import { computeBBox, InkPoint, InkStroke } from "./Stroke";
import { drawStroke, resetRibbonCacheStats, ribbonCacheStats } from "./StrokeRenderer";

/**
 * "Ink smoothing off" has to mean the centerline too.
 *
 * The setting only ever switched the WIDTH law (InkShape). Smoothing.ts's
 * midpoint-quadratic ran on every committed stroke with no switch, so a Boox
 * user who turned smoothing, prediction and pressure all off still
 * photographed rounded corners (r/Onyx_Boox, batendalyn, 2026-09-02). Two
 * things are asserted here and they pull in opposite directions on purpose:
 * with the setting OFF the committed centerline is the samples themselves,
 * and with it ON the geometry is byte-for-byte what it was before the change.
 *
 * The ON fixtures below were produced by running the pre-change flattens on
 * the corner stroke, so they are a record of the old behaviour rather than a
 * restatement of the new code. If a future edit to Smoothing.ts or to the
 * flatness rule moves them, that is the point: it would move every committed
 * stroke in every vault, and it should have to be decided rather than
 * noticed.
 */

const STYLE: PenStyle = { color: "#000000", baseWidth: 3, minWidthFactor: 0.35, gamma: 0.75 };
const CAM: CameraState = { x: 0, y: 0, zoom: 1 };

/** A right-angle corner: the shape the report was about. */
const CORNER: InkPoint[] = [
	{ x: 0, y: 0, pressure: 0.4, t: 0 },
	{ x: 10, y: 0, pressure: 0.6, t: 10 },
	{ x: 10, y: 10, pressure: 0.5, t: 20 },
];

/**
 * Quads the smoothed corner draws at zoom 1 (six ribbon points). One fewer
 * than the pinned fixture, which is flattened at zoom 2 where the bend earns
 * an extra subdivision - the flatness rule doing its job, not a discrepancy.
 */
const SMOOTH_QUADS = 5;

const round = (n: number): number => Number(n.toFixed(6));
const triples = (pts: ReadonlyArray<{ x: number; y: number; hw: number }>): number[][] =>
	pts.map((p) => [round(p.x), round(p.y), round(p.hw)]);

/** Pinned from the pre-change code at pxPerWorld 2. */
const SMOOTH_FIXTURE: number[][] = [
	[0, 0, 1.104738],
	[5, 0, 1.104738],
	[7.1875, 0.3125, 1.147697],
	[8.75, 1.25, 1.147697],
	[9.6875, 2.8125, 1.147697],
	[10, 5, 1.147697],
	[10, 10, 1.104738],
];

/** The same stroke through the shaped path, also pre-change. */
const SHAPED_FIXTURE: number[][] = [
	[0, 0, 0.121848],
	[5, 0, 1.023476],
	[7.1875, 0.3125, 1.021835],
	[8.75, 1.25, 1.020193],
	[9.6875, 2.8125, 1.018551],
	[10, 5, 1.016909],
	[10, 10, 0.120272],
];

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

function strokeOf(over: Partial<InkStroke> = {}): InkStroke {
	return {
		id: "s1",
		tool: "pen",
		color: "#000000",
		width: 3,
		points: CORNER,
		bbox: computeBBox(CORNER, 3),
		createdAt: 0,
		...over,
	} as InkStroke;
}

describe("the smoothed centerline is unchanged", () => {
	afterEach(() => setInkShaping(true));

	it("flattens the corner stroke exactly as it did before the raw path existed", () => {
		expect(triples(flattenStroke(CORNER, STYLE, 2))).toEqual(SMOOTH_FIXTURE);
	});

	it("still defaults to smoothed when no caller says otherwise", () => {
		expect(triples(flattenStroke(CORNER, STYLE, 2, true))).toEqual(SMOOTH_FIXTURE);
	});

	it("leaves the shaped path alone", () => {
		expect(triples(flattenStrokeShaped(CORNER, STYLE, 2))).toEqual(SHAPED_FIXTURE);
	});

	it("never passes through the corner sample itself while smoothing", () => {
		// The defect, stated as geometry: (10, 0) is a control point, so the
		// drawn line rounds past it and the corner the user wrote is gone.
		const xs = flattenStroke(CORNER, STYLE, 2);
		expect(xs.some((p) => p.x === 10 && p.y === 0)).toBe(false);
	});
});

describe("the raw centerline", () => {
	it("is the input samples, in order, unmoved", () => {
		const raw = flattenStroke(CORNER, STYLE, 2, false);
		expect(raw.map((p) => [p.x, p.y])).toEqual([
			[0, 0],
			[10, 0],
			[10, 10],
		]);
	});

	it("keeps one ribbon point per sample at any zoom", () => {
		// No subdivision and no smoothing means the point count cannot move
		// with the camera, which is what makes the commit equal the wet line.
		expect(flattenStroke(CORNER, STYLE, 0.25, false)).toHaveLength(3);
		expect(flattenStroke(CORNER, STYLE, 64, false)).toHaveLength(3);
	});

	it("widths each sample by its own pressure", () => {
		const raw = flattenStroke(CORNER, STYLE, 2, false);
		// Rising then falling pressure, so the half-widths do the same.
		expect(raw[1]!.hw).toBeGreaterThan(raw[0]!.hw);
		expect(raw[2]!.hw).toBeLessThan(raw[1]!.hw);
	});

	it("still draws a lone sample as a dot", () => {
		const one = flattenStroke([CORNER[0]!], STYLE, 2, false);
		expect(one).toHaveLength(1);
	});
});

describe("who gets the raw centerline", () => {
	afterEach(() => setInkShaping(true));

	it("follows the setting for pen ink", () => {
		setInkShaping(false);
		expect(centerlineSmoothed(false)).toBe(false);
		setInkShaping(true);
		expect(centerlineSmoothed(false)).toBe(true);
	});

	it("exempts the highlighter in both settings", () => {
		setInkShaping(false);
		expect(centerlineSmoothed(true)).toBe(true);
		setInkShaping(true);
		expect(centerlineSmoothed(true)).toBe(true);
	});
});

describe("drawStroke routes to the raw flatten", () => {
	beforeEach(() => {
		resetRibbonCacheStats();
		setInkShaping(true);
	});
	afterEach(() => setInkShaping(true));

	/**
	 * What drawStroke actually laid down, read off the context it drew on.
	 *
	 * fillRibbon emits one closed quad per ribbon SEGMENT (moveTo plus three
	 * lineTo plus closePath), so the corners it moved to are the offset sides
	 * of the centerline it was handed, and there is one quad fewer than there
	 * are ribbon points. Measuring the draw rather than re-deriving it is the
	 * point: a test that recomputed the expected flatten would agree with a
	 * drawStroke that routed to the wrong one.
	 */
	function drawnQuads(s: InkStroke): number {
		let quads = 0;
		const ctx = fakeCtx();
		(ctx as unknown as { closePath: () => void }).closePath = () => {
			quads++;
		};
		const before = ribbonCacheStats().flattens;
		drawStroke(ctx, CAM, s, undefined, true, false);
		// cacheRibbon false, so this draw flattened rather than replaying.
		expect(ribbonCacheStats().flattens).toBe(before + 1);
		return quads;
	}

	it("draws a pen stroke raw with the setting off and smooth with it on", () => {
		const s = strokeOf();
		setInkShaping(false);
		// Three samples, so two quads: the polyline itself and nothing added.
		expect(drawnQuads(s)).toBe(CORNER.length - 1);
		setInkShaping(true);
		expect(drawnQuads(s)).toBe(SMOOTH_QUADS);
	});

	it("gives a mouse stroke the raw centerline only when the setting is off", () => {
		// Mouse ink is never SHAPED, so shaping alone cannot describe it: with
		// the setting on it is unshaped and smoothed, with it off, unshaped
		// and raw. That is why the cache key had to carry the centerline too.
		const s = strokeOf({ device: "mouse" } as Partial<InkStroke>);
		setInkShaping(true);
		expect(drawnQuads(s)).toBe(SMOOTH_QUADS);
		setInkShaping(false);
		expect(drawnQuads(s)).toBe(CORNER.length - 1);
	});

	it("re-flattens a mouse stroke when the setting is toggled under the cache", () => {
		const s = strokeOf({ device: "mouse" } as Partial<InkStroke>);
		setInkShaping(true);
		drawStroke(fakeCtx(), CAM, s, undefined, true);
		const after = ribbonCacheStats().flattens;
		setInkShaping(false);
		drawStroke(fakeCtx(), CAM, s, undefined, true);
		expect(ribbonCacheStats().flattens).toBe(after + 1);
		expect(ribbonCacheStats().hits).toBe(0);
	});

	it("keeps the highlighter smoothed with the setting off", () => {
		const s = strokeOf({ tool: "highlighter" });
		setInkShaping(false);
		expect(drawnQuads(s)).toBe(SMOOTH_QUADS);
	});
});
