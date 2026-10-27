import { afterEach, describe, expect, it } from "vitest";
import { WetInkRenderer } from "./WetInkRenderer";
import { flattenStrokeShaped, setInkShaping } from "./InkShape";
import type { CameraState } from "../camera/coordinates";
import { DEFAULT_PEN, HIGHLIGHTER_PEN, widthForPressure } from "./PenStyle";
import type { InkPoint } from "./Stroke";

/**
 * A 2d context that answers every call with a no-op and remembers clearRect.
 * The renderer's drawing is exercised for real; only the pixels are fake.
 */
type Rect = [number, number, number, number];

function fakeCanvas(): { canvas: HTMLCanvasElement; clears: Rect[] } {
	const clears: Rect[] = [];
	const ctx = new Proxy(
		{},
		{
			get(_t, prop) {
				if (prop === "clearRect") return (...a: Rect) => void clears.push(a);
				if (prop === "getContextAttributes") return () => ({ desynchronized: false });
				if (prop === "setTransform") return () => undefined;
				return () => undefined;
			},
			set() {
				return true;
			},
		}
	);
	const canvas = { getContext: () => ctx } as unknown as HTMLCanvasElement;
	return { canvas, clears };
}

const cam: CameraState = { x: 100, y: 200, zoom: 2 };
const style = DEFAULT_PEN;

/**
 * Records paths in the renderer's logical CSS/layout coordinates. This checks
 * per-draw geometry and lifecycle, not backing pixels or compositor damage.
 * Canvas clipping never shrinks the recorded path: a small clip must not hide
 * an oversized path submission. The independent renderer tests cover backing
 * transforms; this recorder retains the transform for device-alignment reads.
 * The independent browser fixture owns those acceptance measurements.
 */
function pathCanvas() {
	interface Box { x0: number; y0: number; x1: number; y1: number }
	const paints: Box[] = [];
	const clears: Rect[] = [];
	const calls: Array<readonly unknown[]> = [];
	let path: Box | undefined;
	let throwOnPaint = false;
	let transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
	let clip: Box | undefined;
	const states: Array<{ transform: typeof transform; clip: Box | undefined }> = [];
	const include = (x: number, y: number) => {
		path = path
			? { x0: Math.min(path.x0, x), y0: Math.min(path.y0, y), x1: Math.max(path.x1, x), y1: Math.max(path.y1, y) }
			: { x0: x, y0: y, x1: x, y1: y };
	};
	const paint = (padding: number) => {
		if (throwOnPaint) throw new Error("paint refused");
		if (path) paints.push({ x0: path.x0 - padding, y0: path.y0 - padding, x1: path.x1 + padding, y1: path.y1 + padding });
	};
	const ctx = {
		get canvas() { return canvas; },
		fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "butt", lineJoin: "miter",
		beginPath() { calls.push(["beginPath"]); path = undefined; },
		moveTo(x: number, y: number) { calls.push(["moveTo", x, y]); include(x, y); },
		lineTo(x: number, y: number) { calls.push(["lineTo", x, y]); include(x, y); },
		rect(x: number, y: number, width: number, height: number) {
			calls.push(["rect", x, y, width, height]); include(x, y); include(x + width, y + height);
		},
		clip() {
			calls.push(["clip"]);
			if (path) clip = clip
				? { x0: Math.max(clip.x0, path.x0), y0: Math.max(clip.y0, path.y0), x1: Math.min(clip.x1, path.x1), y1: Math.min(clip.y1, path.y1) }
				: { ...path };
		},
		quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
			calls.push(["quadraticCurveTo", cx, cy, x, y]); include(cx, cy); include(x, y);
		},
		arc(x: number, y: number, r: number, a0: number, a1: number, anticlockwise?: boolean) {
			calls.push(["arc", x, y, r, a0, a1, anticlockwise]);
			const tau = Math.PI * 2;
			const mod = (a: number) => ((a % tau) + tau) % tau;
			const delta = anticlockwise ? a0 - a1 : a1 - a0;
			const sweep = Math.abs(delta) >= tau ? tau : mod(delta);
			include(x + r * Math.cos(a0), y + r * Math.sin(a0));
			include(x + r * Math.cos(a1), y + r * Math.sin(a1));
			for (const angle of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
				if (mod(anticlockwise ? a0 - angle : angle - a0) <= sweep + 1e-12) {
					include(x + r * Math.cos(angle), y + r * Math.sin(angle));
				}
			}
		},
		closePath() { calls.push(["closePath"]); },
		fill() { calls.push(["fill"]); paint(0); },
		stroke() { calls.push(["stroke"]); paint(this.lineWidth / 2); },
		clearRect(...rect: Rect) { calls.push(["clearRect", ...rect]); clears.push(rect); },
		setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
			calls.push(["setTransform", a, b, c, d, e, f]); transform = { a, b, c, d, e, f };
		},
		getTransform() { return { ...transform }; },
		save() { calls.push(["save"]); states.push({ transform: { ...transform }, clip: clip && { ...clip } }); },
		restore() {
			calls.push(["restore"]);
			const state = states.pop();
			if (state) { transform = state.transform; clip = state.clip; }
		},
		drawImage(_image: unknown, x: number, y: number) { calls.push(["drawImage", x, y]); },
		getContextAttributes() { return { desynchronized: false }; },
	};
	const canvas = { width: 120000, height: 120000, getContext: () => ctx } as unknown as HTMLCanvasElement;
	const wet = new WetInkRenderer(canvas, false);
	wet.beforeWrite = () => { calls.push(["beforeWrite"]); };
	return { wet, ctx, paints, clears, calls, get clip() { return clip; }, refusePaint() { throwOnPaint = true; } };
}

describe("WetInkRenderer bounded draw entry points", () => {
	afterEach(() => setInkShaping(true));
	const camera: CameraState = { x: 1000, y: -2000, zoom: 1 };
	const point = (x: number, y = 0, t = 0): InkPoint => ({ x: camera.x + x, y: camera.y + y, pressure: 0.8, t });
	const bounded = (paints: ReturnType<typeof pathCanvas>["paints"]) => {
		expect(paints.length, "the public wet operation must actually paint").toBeGreaterThan(0);
		for (const box of paints) {
			expect(box.x1 - box.x0, "each emitted draw, including nib width, fits the layout limit").toBeLessThanOrEqual(16000);
			expect(box.y1 - box.y0, "both axes are bounded").toBeLessThanOrEqual(16000);
		}
	};
	const coversX = (paints: ReturnType<typeof pathCanvas>["paints"], from: number, to: number) => {
		let covered = from;
		for (const box of [...paints].sort((a, b) => a.x0 - b.x0)) {
			if (box.x1 < from || box.x0 > to) continue;
			expect(box.x0, "splitting must not leave a gap along this straight stroke").toBeLessThanOrEqual(covered + 1e-6);
			covered = Math.max(covered, box.x1);
		}
		expect(covered, "the actual final sample remains covered").toBeGreaterThanOrEqual(to);
	};

	it("does not hide oversized submitted geometry behind a small Canvas clip", () => {
		const rec = pathCanvas();
		rec.ctx.save();
		rec.ctx.beginPath();
		rec.ctx.rect(0, 0, 10, 10);
		rec.ctx.clip();
		rec.ctx.beginPath();
		rec.ctx.moveTo(0, 5);
		rec.ctx.lineTo(20000, 5);
		rec.ctx.stroke();
		expect(rec.paints[0]!.x1 - rec.paints[0]!.x0).toBeGreaterThan(16000);
		expect(rec.clip).toEqual({ x0: 0, y0: 0, x1: 10, y1: 10 });
		rec.ctx.restore();
		expect(rec.clip).toBeUndefined();
	});

	it.each([false, true])("records full-disc extrema with anticlockwise=%s", anticlockwise => {
		const { ctx, paints } = pathCanvas();
		for (const end of [Math.PI * 2, -Math.PI * 2]) {
			ctx.beginPath();
			ctx.arc(3, 5, 10, 0, end, anticlockwise);
			ctx.fill();
		}
		expect(paints).toEqual([
			{ x0: -7, y0: -5, x1: 13, y1: 15 },
			{ x0: -7, y0: -5, x1: 13, y1: 15 },
		]);
	});

	it("records only the swept arc, including crossed cardinal extrema", () => {
		const { ctx, paints } = pathCanvas();
		ctx.beginPath();
		ctx.arc(0, 0, 10, -Math.PI / 4, Math.PI / 4);
		ctx.fill();
		expect(paints[0]!.x0).toBeCloseTo(Math.sqrt(50));
		expect(paints[0]!.x1).toBe(10);
		expect(paints[0]!.y0).toBeCloseTo(-Math.sqrt(50));
		expect(paints[0]!.y1).toBeCloseTo(Math.sqrt(50));
		ctx.beginPath();
		ctx.arc(0, 0, 10, Math.PI / 4, -Math.PI / 4, true);
		ctx.fill();
		expect(paints[1]).toEqual(paints[0]);
	});

	it("bounds a single sparse raw segment without losing its far endpoint", () => {
		const { wet, paints } = pathCanvas();
		wet.beginStroke(point(0), style);
		wet.appendPoint(camera, style, point(54000, 0, 10));
		bounded(paints);
		coversX(paints, 0, 54000);
	});

	it("bounds the raw ribbon branch when smoothing is disabled", () => {
		setInkShaping(false);
		const { wet, paints } = pathCanvas();
		wet.smooth = true;
		wet.beginStroke(point(0), style);
		wet.appendPoint(camera, style, point(54000, 0, 10));
		bounded(paints);
		coversX(paints, 0, 54000);
		expect(wet.head()).toBeUndefined();
	});

	it("bounds a settled smoothed strip without resetting its live head", () => {
		const { wet, paints } = pathCanvas();
		wet.smooth = true;
		wet.beginStroke(point(0), style);
		wet.appendPoint(camera, style, point(40000, 0, 10));
		paints.length = 0;
		wet.appendPoint(camera, style, point(80000, 0, 20));
		bounded(paints);
		coversX(paints, 20000, 60000);
		expect(wet.head()).toEqual({ from: { x: 61000, y: -2000 }, to: { x: 81000, y: -2000 }, pressure: 0.8 });
	});

	it("bounds the pen-up closing strip and keeps its final nib width", () => {
		const { wet, paints } = pathCanvas();
		wet.smooth = true;
		wet.shape = true;
		wet.beginStroke(point(0), style);
		wet.appendPoint(camera, style, point(60000, 0, 10));
		const width = wet.liveHalfWidth(style, 0.8);
		paints.length = 0;
		wet.finishStroke(camera, style);
		bounded(paints);
		coversX(paints, 30000, 60000);
		expect(wet.liveHalfWidth(style, 0.8)).toBe(width);
	});

	it("bounds both axes of a long diagonal highlighter strip", () => {
		const { wet, paints } = pathCanvas();
		wet.smooth = true;
		wet.beginStroke(point(0), HIGHLIGHTER_PEN, true);
		wet.appendPoint(camera, HIGHLIGHTER_PEN, point(50000, 60000, 10));
		wet.finishStroke(camera, HIGHLIGHTER_PEN);
		bounded(paints);
		expect(Math.max(...paints.map(p => p.x1))).toBeGreaterThanOrEqual(50000);
		expect(Math.max(...paints.map(p => p.y1))).toBeGreaterThanOrEqual(60000);
	});

	it("applies the limit after the camera projection, including width", () => {
		const { wet, paints } = pathCanvas();
		wet.beginStroke(point(0), style);
		wet.appendPoint({ ...camera, zoom: 2 }, style, point(9000, 0, 10));
		bounded(paints);
		coversX(paints, 0, 18000);
	});

	it("keeps a below-limit raw draw's exact path and calls beforeWrite first", () => {
		const { wet, paints, calls } = pathCanvas();
		wet.beginStroke(point(10, 20), style);
		wet.appendPoint(camera, style, point(30, 40, 10));
		expect(calls).toEqual([["beforeWrite"], ["beginPath"], ["moveTo", 10, 20], ["lineTo", 30, 40], ["stroke"]]);
		expect(paints).toHaveLength(1);
	});

	it("carries the entire dirty union and clears it once after a long stroke", () => {
		const { wet, clears, calls } = pathCanvas();
		wet.noteBackingCleared();
		wet.beginStroke(point(100, 100), style);
		wet.appendPoint(camera, style, point(54100, 100, 10));
		wet.carry(20, 30);
		wet.clearStroke(120000, 120000);
		expect(clears).toHaveLength(1);
		const [x, y, width, height] = clears[0]!;
		expect(x).toBeLessThan(120);
		expect(x + width).toBeGreaterThan(54120);
		expect(y).toBeLessThan(130);
		expect(y + height).toBeGreaterThan(130);
		expect(calls[calls.length - 2]).toEqual(["beforeWrite"]);
		expect(wet.provenBlank).toBe(true);
	});

	it("never declares blank after an interrupted paint followed by a partial stroke clear", () => {
		const { wet, refusePaint } = pathCanvas();
		wet.noteBackingCleared();
		wet.beginStroke(point(100, 100), style);
		wet.appendPoint(camera, style, point(200, 100, 10));
		refusePaint();
		expect(() => wet.appendPoint(camera, style, point(54200, 100, 20))).toThrow("paint refused");
		wet.clearStroke(120000, 120000);
		expect(wet.provenBlank).toBe(false);
	});
});

describe("WetInkRenderer.clearStroke", () => {
	it("clears the whole canvas when nothing was drawn", () => {
		const { canvas, clears } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		wet.clearStroke(800, 600);
		expect(clears).toEqual([[0, 0, 800, 600]]);
	});

	it("clears only the box the stroke painted, in screen px, padded by its width", () => {
		const { canvas, clears } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		// world (110,210) -> screen (20,20); world (160,240) -> screen (120,80)
		wet.beginStroke({ x: 110, y: 210, pressure: 0.5, t: 0 }, style);
		wet.appendPoint(cam, style, { x: 160, y: 240, pressure: 0.5, t: 1 });
		wet.clearStroke(800, 600);
		expect(clears).toHaveLength(1);
		const [x, y, w, h] = clears[0]!;
		// contains the segment
		expect(x).toBeLessThanOrEqual(20);
		expect(y).toBeLessThanOrEqual(20);
		expect(x + w).toBeGreaterThanOrEqual(120);
		expect(y + h).toBeGreaterThanOrEqual(80);
		// and is nowhere near the whole canvas
		expect(w).toBeLessThan(200);
		expect(h).toBeLessThan(150);
		// padding is bounded by the stroke width at this zoom, plus a couple px
		expect(20 - x).toBeLessThanOrEqual(style.baseWidth * cam.zoom + 3);
	});

	it("clamps the box to the canvas", () => {
		const { canvas, clears } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		// screen (-10,-10) -> (10,10): box starts off-canvas
		wet.beginStroke({ x: 95, y: 195, pressure: 0.5, t: 0 }, style);
		wet.appendPoint(cam, style, { x: 105, y: 205, pressure: 0.5, t: 1 });
		wet.clearStroke(800, 600);
		const [x, y] = clears[0]!;
		expect(x).toBe(0);
		expect(y).toBe(0);
	});

	it("falls back to a full clear when the box is poisoned, never to no clear", () => {
		const { canvas, clears } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		wet.beginStroke({ x: 110, y: 210, pressure: NaN, t: 0 }, style);
		wet.appendPoint(cam, style, { x: 160, y: 240, pressure: NaN, t: 1 });
		wet.clearStroke(800, 600);
		expect(clears).toEqual([[0, 0, 800, 600]]);
	});

	it("forgets the box after clearing, so the next stroke starts fresh", () => {
		const { canvas, clears } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		wet.beginStroke({ x: 110, y: 210, pressure: 0.5, t: 0 }, style);
		wet.appendPoint(cam, style, { x: 160, y: 240, pressure: 0.5, t: 1 });
		wet.clearStroke(800, 600);
		wet.clearStroke(800, 600);
		expect(clears[1]).toEqual([0, 0, 800, 600]);
	});
});

/**
 * The wet layer must make the SAME two decisions the committed renderer makes
 * (StrokeRenderer.drawStroke): shaped width only for a non-flat tool on a
 * shaping device with the switch on, and a smoothed centerline only when
 * `centerlineSmoothed` says so. Both were inferred from `shape`, which is a
 * device-and-layer fact, so a mouse stroke read as "flat" and a shared wet
 * pair could not tell its two tools apart at all.
 *
 * `head()` is the seam: it is the raw stub between the settled curve and the
 * nib, and it exists only on a smoothed centerline.
 */
describe("WetInkRenderer takes the tool's flatness from the stroke", () => {
	afterEach(() => setInkShaping(true));

	const drive = (opts: { shape: boolean; flat: boolean }) => {
		const { canvas } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		wet.smooth = true;
		wet.shape = opts.shape;
		wet.beginStroke({ x: 110, y: 210, pressure: 0.5, t: 0 }, style, opts.flat);
		wet.appendPoint(cam, style, { x: 120, y: 210, pressure: 0.5, t: 8 });
		wet.appendPoint(cam, style, { x: 130, y: 215, pressure: 0.5, t: 16 });
		return wet;
	};

	it("draws a pen stroke raw when smoothing is off", () => {
		setInkShaping(false);
		expect(drive({ shape: true, flat: false }).head()).toBeUndefined();
	});

	it("keeps the highlighter smoothed on a layer dressed for the pen", () => {
		// The PDF's case: one wet pair, `shape` permanently true, both tools.
		setInkShaping(false);
		expect(drive({ shape: true, flat: true }).head()).toBeDefined();
	});

	it("draws a mouse stroke raw when smoothing is off", () => {
		// `shape` false is the MOUSE, which is unshaped and not flat. Inferred
		// flatness made it smoothed here and raw at pen-up.
		setInkShaping(false);
		expect(drive({ shape: false, flat: false }).head()).toBeUndefined();
	});

	it("smooths every tool when the setting is on", () => {
		for (const shape of [true, false]) {
			for (const flat of [true, false]) {
				expect(drive({ shape, flat }).head()).toBeDefined();
			}
		}
	});

	it("shapes the width only for a non-flat tool on a shaping device", () => {
		// liveWidthPx reports the shaper's half-width doubled when shaping is
		// on for the stroke, and the raw pressure width when it is not. Drive
		// one sample to exercise velocity thinning as well as the start taper.
		const raw = widthForPressure(style, 0.5);
		const at = (shape: boolean, flat: boolean) => {
			const { canvas } = fakeCanvas();
			const wet = new WetInkRenderer(canvas, false);
			wet.smooth = true;
			wet.shape = shape;
			wet.beginStroke({ x: 0, y: 0, pressure: 0.5, t: 0 }, style, flat);
			wet.appendPoint(cam, style, { x: 20, y: 0, pressure: 0.5, t: 5 });
			return wet.liveWidthPx({ x: 0, y: 0, zoom: 1 }, style, 0.5);
		};
		expect(at(true, false)).toBeLessThan(raw);
		expect(at(true, true)).toBeCloseTo(raw, 10);
		expect(at(false, false)).toBeCloseTo(raw, 10);
	});
});

/**
 * The live head is drawn on a layer above this one and has to be the same
 * width as the ribbon it continues. `liveHalfWidth` is how it asks, and the
 * unit is the one thing that can go wrong: `liveWidthPx` is a FULL width in
 * css px, so a head derived from it needs `/ cam.zoom / 2`, and dropping
 * either half of that ships a head at two or four times the ribbon.
 */
describe("WetInkRenderer.liveHalfWidth", () => {
	afterEach(() => setInkShaping(true));

	const at = (opts: { shape: boolean; flat: boolean; pressure?: number }) => {
		const { canvas } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		wet.smooth = true;
		wet.shape = opts.shape;
		const p = opts.pressure ?? 0.5;
		wet.beginStroke({ x: 110, y: 210, pressure: p, t: 0 }, style, opts.flat);
		wet.appendPoint(cam, style, { x: 120, y: 210, pressure: p, t: 8 });
		wet.appendPoint(cam, style, { x: 130, y: 215, pressure: p, t: 16 });
		return wet;
	};

	it("is exactly half of liveWidthPx's world width, on both branches", () => {
		for (const shape of [true, false]) {
			const wet = at({ shape, flat: false });
			const half = wet.liveHalfWidth(style, 0.5);
			const px = wet.liveWidthPx(cam, style, 0.5);
			// Precondition: zoom is not 1 and the two numbers are not the
			// same, so a call that forgot either conversion fails here
			// rather than passing by coincidence.
			expect(cam.zoom).toBe(2);
			expect(half).not.toBeCloseTo(px, 6);
			expect(half).toBeCloseTo(px / cam.zoom / 2, 10);
		}
	});

	it("reads the shaper only on the shaped branch, never a stale one", () => {
		// `shape` and `smooth` are different switches: a MOUSE stroke and a
		// HIGHLIGHTER both run unshaped with the centerline still smoothed,
		// so head() fires and this is asked for a width - while the shaper
		// was never reset for that stroke and still holds the last shaped
		// one's. It must come from pressure there.
		const { canvas } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		wet.smooth = true;

		wet.shape = true;
		wet.beginStroke({ x: 110, y: 210, pressure: 1, t: 0 }, style, false);
		for (let i = 1; i <= 6; i++) {
			wet.appendPoint(cam, style, { x: 110 + i * 6, y: 210, pressure: 1, t: i * 8 });
		}
		const shaped = wet.liveHalfWidth(style, 1);
		const rawAt = widthForPressure(style, 0.2) / 2;
		// Precondition: the shaper holds a value the pressure branch cannot
		// produce, so "stale shaper" and "correct answer" are distinguishable.
		expect(shaped).toBeGreaterThan(rawAt * 1.5);

		wet.shape = false;
		wet.beginStroke({ x: 300, y: 300, pressure: 0.2, t: 100 }, style, false);
		expect(wet.head()).toBeDefined();
		expect(wet.liveHalfWidth(style, 0.2)).toBeCloseTo(rawAt, 10);
	});
});

/**
 * The pen-down dot is the only head draw that is not gated on `head()`, and
 * for a TAP it is the entire visible mark: the wet layer has painted nothing
 * yet and the shaper has just reset to the tip floor, 12% of nominal. Handed
 * the bare live width it draws a sliver. Alan's ruling, 2026-09-02: it takes
 * the shaped width like everything else, with a floor at the nib's own base
 * width, so a tap looks like the nib rather than like the start of a stroke.
 */
describe("WetInkRenderer.contactHalfWidth", () => {
	afterEach(() => setInkShaping(true));

	const atPenDown = (opts: { shape: boolean; flat: boolean; pressure: number }) => {
		const { canvas } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		wet.smooth = true;
		wet.shape = opts.shape;
		wet.beginStroke({ x: 0, y: 0, pressure: opts.pressure, t: 0 }, style, opts.flat);
		return wet;
	};

	it("holds the tap at the nib when the shaped width is at the tip floor", () => {
		const wet = atPenDown({ shape: true, flat: false, pressure: 0.5 });
		// A line begins at the historical tip floor; a tap stays visible at
		// one nominal nib.
		expect(wet.liveHalfWidth(style, 0.5)).toBeLessThan(style.baseWidth / 2 / 4);
		expect(wet.contactHalfWidth(style, 0.5)).toBeCloseTo(style.baseWidth / 2, 10);
	});

	it("floors the raw branch too - Boox and mouse still draw this dot", () => {
		// Smoothing off takes the five gated head sites dark; this one keeps
		// drawing, so the floor has to hold on the pressure branch as well.
		setInkShaping(false);
		const wet = atPenDown({ shape: true, flat: false, pressure: 0.2 });
		const raw = widthForPressure(style, 0.2) / 2;
		expect(wet.liveHalfWidth(style, 0.2)).toBeCloseTo(raw, 10);
		expect(raw).toBeLessThan(style.baseWidth / 2);
		expect(wet.contactHalfWidth(style, 0.2)).toBeCloseTo(style.baseWidth / 2, 10);
	});

	it("is the nib of the tool in hand, not of the pen", () => {
		// The floor is `style.baseWidth`, so a highlighter tap is a
		// highlighter-sized dot. It is also a FULL width: the floor on a
		// half-width is baseWidth/2, and flooring at baseWidth itself would
		// draw every tap at twice the nib.
		const wet = atPenDown({ shape: true, flat: true, pressure: 0.5 });
		expect(HIGHLIGHTER_PEN.baseWidth).toBeGreaterThan(style.baseWidth);
		expect(wet.contactHalfWidth(HIGHLIGHTER_PEN, 0.5)).toBeCloseTo(
			HIGHLIGHTER_PEN.baseWidth / 2,
			10
		);
	});

	it("never falls below the nib whatever the pressure sample says", () => {
		// The pressure curve tops out at baseWidth. Contact dots stay at one
		// nominal nib even when a line starts at the geometric tip floor.
		for (const pressure of [0, 0.25, 0.5, 0.75, 1]) {
			const wet = atPenDown({ shape: true, flat: false, pressure });
			expect(wet.contactHalfWidth(style, pressure)).toBeCloseTo(style.baseWidth / 2, 10);
		}
	});

	it("keeps the nib-sized contact while the wet stroke starts at the committed high-pressure width", () => {
		const points = Array.from({ length: 40 }, (_, i) => ({
			x: i * 3,
			y: 0,
			pressure: 1,
			t: i * 5,
		}));
		const committed = flattenStrokeShaped(points, style, 1);
		const wet = atPenDown({ shape: true, flat: false, pressure: 1 });

		expect(wet.contactHalfWidth(style, 1), "the accepted tap remains one nib").toBeCloseTo(
			style.baseWidth / 2,
			10
		);
		expect(wet.liveHalfWidth(style, 1), "the wet line does not fatten at handoff").toBeCloseTo(
			committed[0]!.hw,
			10
		);
	});
});
