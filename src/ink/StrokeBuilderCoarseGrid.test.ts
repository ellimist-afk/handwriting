import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InkOverlayPlugin } from "../inline/InkOverlay";
import { resetTipModeForTest } from "../inline/TipMode";
import type { PenSample } from "../input/PointerRouter";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { SelectionModel } from "../objects/SelectionModel";
import { DEFAULT_PEN } from "./PenStyle";
import { IncrementalSmoother, smoothSegments } from "./Smoothing";
import type { InkPoint, InkStroke } from "./Stroke";
import { computeBBox } from "./Stroke";
import { COARSE_GRID_RUN, CoarseGrid, coarseGridFor, StrokeBuilder } from "./StrokeBuilder";

/**
 * A pen that reports whole device pixels, on a screen at 100 percent scale:
 * a smooth handwriting-like curve sampled every 4 ms and rounded to the pixel
 * grid. Deterministic. `fine` keeps the unrounded positions, which is what a
 * pen with sub-pixel reports gives.
 */
interface Sample { x: number; y: number; pressure: number; t: number }
function curve(v: number, a: number, b: number, ms: number, worldPerPx = 1, fine = false): Sample[] {
	const w = (2 * Math.PI) / 220;
	const out: Sample[] = [];
	for (let t = 0; t <= ms; t += 4) {
		const x = v * t + a * Math.sin(w * t) + 0.3;
		const y = b * Math.sin(1.5 * w * t + 0.7) + 0.6;
		out.push({
			x: (fine ? x : Math.round(x)) * worldPerPx,
			y: (fine ? y : Math.round(y)) * worldPerPx,
			pressure: 0.4 + 0.2 * Math.sin(t / 90),
			t: 1000 + t,
		});
	}
	return out;
}
const COARSE = [curve(0.12, 9, 10, 600), curve(0.2, 8, 10, 600), curve(0.1, 12, 12, 800)];
/** The same curve on a note whose font scale makes one CSS px 28/26 world units. */
const COARSE_SCALED = curve(0.12, 9, 10, 600, 28 / 26);

/**
 * Writes `samples` as one stroke, lifting as the note's pen path does: flushRaw()
 * just before finishReleaseFiltered(), builder only. Returns what add() handed
 * the wet layer, what the flush stored, and what was committed.
 */
function write(samples: Sample[], grid?: ReturnType<typeof coarseGridFor>) {
	const builder = new StrokeBuilder("pen", "#2f6de0", 5);
	builder.start(samples[0]!.t, grid);
	const wet: InkPoint[] = [];
	for (const s of samples) {
		const point = builder.add(s.x, s.y, s.pressure, s.t);
		if (point) wet.push({ ...point });
	}
	const flushed = builder.flushRaw();
	const strokes = builder.finishReleaseFiltered();
	return { wet, flushed, strokes, points: strokes.flatMap((stroke) => stroke.points) };
}

/** One pixel across, then one down: the stroke ends on a step, so its last stored point is a mean. */
const STAIRCASE: Sample[] = Array.from({ length: 40 }, (_, i) => ({
	x: 10 + Math.ceil(i / 2),
	y: 20 + Math.floor(i / 2),
	pressure: 0.4 + i / 100,
	t: 1000 + 4 * i,
}));

/**
 * A bare overlay that reaches the builder's start() in penDown, in the shape
 * InlineTapFloor.test.ts uses: Object.create gives the real pen path with no
 * field initialisers, and only what penDown reads is assigned. The editor view
 * has no dom, so the device pixel ratio reads 1.
 */
function penDownGrid(pointerType: string, zoom: number): CoarseGrid | undefined {
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const wet = {
		shape: true,
		beginStroke: () => undefined,
		appendPoint: () => undefined,
		head: () => null,
		liveHalfWidth: () => 1,
		contactHalfWidth: () => 1,
		liveWidthPx: () => 1,
	};
	view.mode = "ink";
	view.scale = 1;
	view.penCursorEl = null;
	view.router = null;
	view.mobileTools = null;
	view.penStyle = { ...DEFAULT_PEN };
	view.highlighterStyle = { ...DEFAULT_PEN };
	view.wet = wet;
	view.highlightWet = wet;
	view.predReal = [];
	view.predLastTail = [];
	// focusClaimedPenEditor's whole contract: already focused. No dom, so dpr reads 1.
	view.view = { hasFocus: true, focus: () => undefined };
	view.frame = { locked: false, begin: () => undefined, end: () => undefined, cancel: () => undefined };
	view.camera = { zoom, snapshot: { x: 0, y: 0, zoom }, screenToWorld: (x: number, y: number) => ({ x, y }) };
	view.selection = new SelectionModel();
	view.tail = {
		configureInlineBacking: () => undefined,
		placeInline: () => undefined,
		restoreFullSurface: () => undefined,
		prepareLive: () => undefined,
		clear: () => undefined,
		drawHead: () => undefined,
		draw: () => undefined,
	};
	for (const name of ["syncCamera", "captureProbeGeometry", "recordPenDownState", "redrawSelectionUI", "ensurePenTools", "startFrameTicker", "probeSample", "schedulePresentProbe", "drawPredictedTail"]) {
		view[name] = () => undefined;
	}
	const sample: PenSample = { x: 100, y: 100, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
	const ev = { buttons: 1, button: 0, clientX: 100, clientY: 100, timeStamp: 0, pointerType } as unknown as PointerEvent;
	(InkOverlayPlugin.prototype as unknown as { penDown(this: unknown, s: PenSample, e: PointerEvent): void }).penDown.call(view, sample, ev);
	const builder = view.builder as unknown as { grid: CoarseGrid | undefined } | null;
	expect(builder, `${pointerType}: penDown made a builder`).toBeTruthy();
	return builder!.grid;
}

/** Heading flips: consecutive turns over 20 degrees each, opposite in sign (a zigzag). */
function flips(points: readonly { x: number; y: number }[]): number {
	const headings: number[] = [];
	for (let i = 1; i < points.length; i++) {
		const dx = points[i]!.x - points[i - 1]!.x;
		const dy = points[i]!.y - points[i - 1]!.y;
		if (dx * dx + dy * dy > 1e-12) headings.push(Math.atan2(dy, dx));
	}
	const turns: number[] = [];
	for (let i = 1; i < headings.length; i++) {
		let a = headings[i]! - headings[i - 1]!;
		while (a > Math.PI) a -= 2 * Math.PI;
		while (a < -Math.PI) a += 2 * Math.PI;
		turns.push((a * 180) / Math.PI);
	}
	let n = 0;
	for (let i = 1; i < turns.length; i++) {
		if (Math.abs(turns[i]!) > 20 && Math.abs(turns[i - 1]!) > 20 && Math.sign(turns[i]!) !== Math.sign(turns[i - 1]!)) n++;
	}
	return n;
}

describe("coarse-grid smoothing at intake", () => {
	it("smooths a whole-pixel staircase: at most 2 heading flips per stroke", () => {
		for (const samples of COARSE) {
			expect(flips(write(samples).points)).toBeGreaterThan(10);
			const smoothed = write(samples, coarseGridFor("cells-staircase", "pen", 1, 1)).points;
			expect(flips(smoothed)).toBeLessThanOrEqual(2);
		}
	});

	it("reads the grid in device px: a font-scaled note smooths the same way", () => {
		expect(flips(write(COARSE_SCALED).points)).toBeGreaterThan(10);
		const smoothed = write(COARSE_SCALED, coarseGridFor("cells-scaled", "pen", 1, 26 / 28)).points;
		expect(flips(smoothed)).toBeLessThanOrEqual(2);
	});

	it("draws wet exactly what it commits, so nothing moves at the lift (zero snap)", () => {
		for (const [key, samples, scale] of [
			["cells-wet-a", COARSE[0]!, 1],
			["cells-wet-b", COARSE[2]!, 1],
			["cells-wet-scaled", COARSE_SCALED, 26 / 28],
			["cells-wet-fine", curve(0.12, 9, 10, 600, 1, true), 1],
		] as const) {
			const { wet, flushed, strokes, points } = write(samples, coarseGridFor(key, "pen", 1, scale));
			expect(strokes).toHaveLength(1);
			// The commit is the wet points plus, on a proven grid, the lift point
			// the flush stored: drawn underneath before the wet layer clears, so
			// the stroke gains the last half step and nothing drawn moves.
			expect(points).toEqual(flushed ? [...wet, flushed] : wet);
			if (flushed) {
				const last = samples[samples.length - 1]!;
				expect([flushed.x, flushed.y], key).toEqual([last.x, last.y]);
			}
			// The wet layer's settled segments are the committed segments.
			const smoother = new IncrementalSmoother();
			smoother.reset(wet[0]);
			const settled = wet.slice(1).map((point) => smoother.push(point));
			expect(settled).toEqual(smoothSegments(points).slice(0, settled.length));
		}
	});

	it("keeps pressure and timestamps, and stores the first sample as given", () => {
		const samples = COARSE[0]!;
		const raw = write(samples).points;
		const { points } = write(samples, coarseGridFor("cells-keep", "pen", 1, 1));
		expect(points[0]).toEqual(raw[0]);
		const byT = new Map(samples.map((s) => [s.t - samples[0]!.t, s.pressure]));
		for (const point of points) expect(point.pressure).toBe(byT.get(point.t));
		expect(points.some((point, i) => point.x !== raw[i]?.x || point.y !== raw[i]?.y)).toBe(true);
	});

	it("leaves a tap as it was", () => {
		const builder = new StrokeBuilder("pen", "#2f6de0", 5);
		builder.start(0, coarseGridFor("cells-tap", "pen", 1, 1));
		builder.add(12, 7, 0.5, 0);
		const [stroke] = builder.finishReleaseFiltered();
		expect(stroke!.points[0]).toMatchObject({ x: 12, y: 7 });
		expect(stroke!.widthMode).toBe("uniform");
	});

	it("stores a fine pen's stroke byte-equal once its own deltas have released the grid", () => {
		const grid = coarseGridFor("cells-fine", "pen", 1, 1)!;
		const first = curve(0.12, 9, 10, 600, 1, true);
		const firstOut = write(first, grid).points;
		// Only the deltas before the release are averaged: from the sample that
		// completes COARSE_GRID_RUN off-grid deltas on, the stroke is as given.
		expect(firstOut.slice(COARSE_GRID_RUN + 1)).toEqual(write(first).points.slice(COARSE_GRID_RUN + 1));
		expect(grid.engaged).toBe(false);
		const second = curve(0.2, 8, 10, 600, 1, true);
		expect(write(second, grid).points).toEqual(write(second).points);
	});

	it("never runs on a screen whose device pixel is finer than 0.75 CSS px", () => {
		expect(coarseGridFor("cells-gate", "pen", 1.5, 1.5)).toBeUndefined();
		expect(coarseGridFor("cells-gate", "pen", 2, 2)).toBeUndefined();
		expect(coarseGridFor("cells-gate", "pen", 1.25, 1.25)).toBeDefined();
		expect(write(COARSE[0]!, coarseGridFor("cells-gate-2", "pen", 2, 2)).points).toEqual(write(COARSE[0]!).points);
	});

	it("holds through one stray off-grid delta and releases after six in a row", () => {
		const grid = coarseGridFor("cells-run", "pen", 1, 1)!;
		const builder = new StrokeBuilder("pen", "#2f6de0", 5);
		builder.start(0, grid);
		let x = 0;
		const step = (dx: number) => builder.add((x += dx), 0, 0.5, x);
		for (let i = 0; i < 4; i++) step(1);
		step(1.5);
		for (let i = 0; i < 4; i++) step(1);
		expect(grid.engaged).toBe(true);
		for (let i = 0; i < COARSE_GRID_RUN - 1; i++) step(1.37);
		expect(grid.engaged).toBe(true);
		step(1.37);
		expect(grid.engaged).toBe(false);
		for (let i = 0; i < COARSE_GRID_RUN - 1; i++) step(2);
		expect(grid.engaged).toBe(false);
		step(0);
		expect(grid.engaged).toBe(false);
		step(1);
		expect(grid.engaged).toBe(true);
	});

	it("keeps one verdict per surface and pointer type", () => {
		const pen = coarseGridFor("cells-keys", "pen", 1, 1)!;
		pen.engaged = false;
		expect(coarseGridFor("cells-keys", "pen", 1, 1)!.engaged).toBe(false);
		expect(coarseGridFor("cells-keys", "touch", 1, 1)!.engaged).toBe(true);
		expect(coarseGridFor("cells-keys-other", "pen", 1, 1)!.engaged).toBe(true);
	});

	it("keeps every point within half its own step of the pen: half a pixel on a one-pixel step", () => {
		// The live head is drawn to the newest point add() returns, so this is
		// the lag at the nib: each point is the mean of its raw sample and the
		// one before, half that sample's own step behind the pen (half a sample
		// interval of travel), never more. On a one-pixel step that is half a
		// device pixel; at two pixels per sample it is one.
		const straight = (step: number): Sample[] =>
			Array.from({ length: 40 }, (_, i) => ({ x: 10 + step * i, y: 20 + step * i, pressure: 0.5, t: 1000 + 4 * i }));
		const staircase: Sample[] = Array.from({ length: 40 }, (_, i) => ({
			x: 10 + Math.ceil(i / 2),
			y: 20 + Math.floor(i / 2),
			pressure: 0.5,
			t: 1000 + 4 * i,
		}));
		for (const [key, samples, scale, onePixel] of [
			["cells-lag-staircase-1", staircase, 1, true],
			["cells-lag-straight-1", straight(1), 1, true],
			["cells-lag-straight-2", straight(2), 1, false],
			["cells-lag-a", COARSE[0]!, 1, false],
			["cells-lag-b", COARSE[1]!, 1, false],
			["cells-lag-c", COARSE[2]!, 1, false],
			["cells-lag-scaled", COARSE_SCALED, 26 / 28, false],
		] as const) {
			const builder = new StrokeBuilder("pen", "#2f6de0", 5);
			builder.start(samples[0]!.t, coarseGridFor(key, "pen", 1, scale));
			let offset = 0;
			samples.forEach((s, i) => {
				const point = builder.add(s.x, s.y, s.pressure, s.t);
				if (!point) return;
				if (i === 0) {
					expect([point.x, point.y], key).toEqual([s.x, s.y]);
					return;
				}
				const before = samples[i - 1]!;
				const dx = Math.abs(point.x - s.x);
				const dy = Math.abs(point.y - s.y);
				if (onePixel) {
					expect(Math.max(dx, dy), `${key}: half a pixel at ${i}`).toBeLessThanOrEqual(0.5 + 1e-9);
				}
				expect(dx, `${key} x at ${i}`).toBeLessThanOrEqual(Math.abs(s.x - before.x) / 2 + 1e-9);
				expect(dy, `${key} y at ${i}`).toBeLessThanOrEqual(Math.abs(s.y - before.y) / 2 + 1e-9);
				offset = Math.max(offset, dx, dy);
			});
			expect(offset, `${key}: the filter ran`).toBeGreaterThan(0);
		}
	});
	it("ends the stored stroke where the pen lifted: the flush stores the last raw sample as given", () => {
		const { wet, flushed, points } = write(STAIRCASE, coarseGridFor("cells-flush-staircase", "pen", 1, 1));
		const last = STAIRCASE[STAIRCASE.length - 1]!;
		// The wet ribbon ends at the mean, half the last step short.
		const wetEnd = wet[wet.length - 1]!;
		expect(Math.max(Math.abs(wetEnd.x - last.x), Math.abs(wetEnd.y - last.y))).toBe(0.5);
		expect(flushed).toBeDefined();
		expect(points).toHaveLength(wet.length + 1);
		expect(points[points.length - 1]).toEqual({ x: last.x, y: last.y, pressure: last.pressure, t: last.t - STAIRCASE[0]!.t });
	});

	it("flushes nothing without a grid, before a sample, or after a sample stored as given", () => {
		const builder = new StrokeBuilder("pen", "#2f6de0", 5);
		builder.start(0);
		builder.add(1, 1, 0.5, 0);
		builder.add(2, 1, 0.5, 4);
		expect(builder.flushRaw()).toBeUndefined();
		builder.start(0, coarseGridFor("cells-flush-none", "pen", 1, 1));
		expect(builder.flushRaw()).toBeUndefined();
		builder.add(1, 1, 0.5, 0);
		expect(builder.flushRaw()).toBeUndefined();
		builder.add(2, 1, 0.5, 4, 12, -7);
		expect(builder.flushRaw()).toMatchObject({ x: 2, y: 1, pressure: 0.5, t: 4, tiltX: 12, tiltY: -7 });
		expect(builder.flushRaw()).toBeUndefined();
		// The guard is the flag, not the dedupe: with no dedupe distance, a
		// stroke whose last sample was stored as given still flushes nothing.
		const undeduped = new StrokeBuilder("pen", "#2f6de0", 5, 0);
		const released = coarseGridFor("cells-flush-released", "pen", 1, 1)!;
		undeduped.start(0, released);
		undeduped.add(1, 1, 0.5, 0);
		undeduped.add(2, 1, 0.5, 4);
		released.engaged = false;
		undeduped.add(3, 1, 0.5, 8);
		expect(undeduped.flushRaw()).toBeUndefined();
	});

	it("engages after exactly six on-grid deltas and releases after exactly six off-grid ones", () => {
		const grid = coarseGridFor("cells-run-count", "pen", 1, 1)!;
		let off = 0;
		while (grid.engaged && off < 50) {
			grid.observe(1.37, 0);
			off++;
		}
		expect(off).toBe(6);
		let on = 0;
		while (!grid.engaged && on < 50) {
			grid.observe(1, 0);
			on++;
		}
		expect(on).toBe(6);
	});

	describe("the note pen path's grid lookup at pen-down", () => {
		beforeEach(() => resetTipModeForTest());
		afterEach(() => resetTipModeForTest());

		it("never gives a mouse stroke the grid; a pen stroke gets one", () => {
			expect(penDownGrid("mouse", 1)).toBeUndefined();
			expect(penDownGrid("pen", 1)).toBeInstanceOf(CoarseGrid);
		});

		it("reads the camera zoom into the grid's scale: zoom 2 at dpr 1 is 2 device px per world unit", () => {
			expect(penDownGrid("pen", 2)!.devicePxPerWorld).toBe(2);
			expect(penDownGrid("pen", 1)!.devicePxPerWorld).toBe(1);
		});
	});

	it("never touches saved ink: a whole-pixel page is byte-identical through load and save", () => {
		const page = emptyPage("coarse-old-ink");
		page.strokes = COARSE.map((samples, i): InkStroke => {
			const points = samples.map((s) => ({ x: s.x, y: s.y, pressure: Math.round(s.pressure * 1000) / 1000, t: s.t - samples[0]!.t }));
			return { id: `old-${i}`, tool: "pen", color: "#2f6de0", width: 5, pressureProfile: "exp7", points, bbox: computeBBox(points, 10), createdAt: 1 + i };
		});
		const saved = serializePage(page);
		const loaded = parsePage(saved, "coarse-old-ink").data;
		expect(serializePage(loaded)).toBe(saved);
		expect(loaded.strokes.map((stroke) => flips(stroke.points)).every((n) => n > 10)).toBe(true);
	});
});
