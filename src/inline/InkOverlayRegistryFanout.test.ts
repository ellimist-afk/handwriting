/**
 * What the note surface's registry does to every open overlay, held by behaviour.
 *
 * The registry fans each switch and sweep out over `instances`, the editors' overlays, and over the
 * extra strip surfaces. A one-line slip in a fan-out (a loop that stops mounting, a call that drops
 * its argument, a sweep that skips an overlay) left every other test green, because no test drove a
 * fan-out with an overlay in the set. These cells put plain stand-in overlays in `instances` (the
 * registry reads the overlay class as a type only, and the unit environment has no document) and
 * assert the calls each stand-in receives. The two pure helpers at the end (the committed floor and
 * the gutter pan mode) are asserted on their answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	addStripSurface,
	committedFloorFor,
	endLiveStrokesEverywhere,
	gutterPanMode,
	instances,
	isInlineInkEnabled,
	refreshAllStrips,
	setInlineInkEnabled,
	setScrollExpansionEnabled,
	type InkOverlayPlugin,
} from "./InkOverlay";
import { surfaceExtents } from "./SurfaceExtent";

/** A stand-in for one mounted overlay: every method the fan-outs under test call, as a spy. */
function standIn() {
	return {
		mount: vi.fn(),
		unmount: vi.fn(),
		refreshStrip: vi.fn(),
		endLiveStroke: vi.fn(),
		endWheelZoomRun: vi.fn(),
		applyCanvasMode: vi.fn(),
		scheduleRepaint: vi.fn(),
	};
}

const added: Array<ReturnType<typeof standIn>> = [];
function open(): ReturnType<typeof standIn> {
	const overlay = standIn();
	added.push(overlay);
	instances.add(overlay as unknown as InkOverlayPlugin);
	return overlay;
}

beforeEach(() => {
	expect(instances.size).toBe(0);
});

afterEach(() => {
	for (const overlay of added.splice(0)) instances.delete(overlay as unknown as InkOverlayPlugin);
	setInlineInkEnabled(true);
	setScrollExpansionEnabled(false);
});

describe("setInlineInkEnabled reaches every open overlay", () => {
	it("unmounts each overlay when switched off and mounts each when switched back on", () => {
		const a = open();
		const b = open();

		setInlineInkEnabled(false);
		expect(isInlineInkEnabled()).toBe(false);
		expect(a.unmount).toHaveBeenCalledTimes(1);
		expect(b.unmount).toHaveBeenCalledTimes(1);
		expect(a.mount).not.toHaveBeenCalled();
		expect(b.mount).not.toHaveBeenCalled();

		setInlineInkEnabled(true);
		expect(isInlineInkEnabled()).toBe(true);
		expect(a.mount).toHaveBeenCalledTimes(1);
		expect(b.mount).toHaveBeenCalledTimes(1);
		expect(a.unmount).toHaveBeenCalledTimes(1);
		expect(b.unmount).toHaveBeenCalledTimes(1);
	});
});

describe("setScrollExpansionEnabled off undoes what the mode granted", () => {
	it("owes the sideways shrink on every note holding sideways room, only when switched off", () => {
		const path = "fanout-owed-shrink.md";
		surfaceExtents.grow(path, { x: 120, y: 0 });
		expect(surfaceExtents.owesShrinkX(path)).toBe(false);

		setScrollExpansionEnabled(true);
		expect(surfaceExtents.owesShrinkX(path)).toBe(false);

		setScrollExpansionEnabled(false);
		expect(surfaceExtents.owesShrinkX(path)).toBe(true);
		surfaceExtents.settleShrinkX(path);
	});

	it("ends a wheel zoom run in flight on each open overlay, only when switched off", () => {
		const a = open();
		const b = open();

		setScrollExpansionEnabled(true);
		expect(a.endWheelZoomRun).not.toHaveBeenCalled();
		expect(b.endWheelZoomRun).not.toHaveBeenCalled();

		setScrollExpansionEnabled(false);
		expect(a.endWheelZoomRun).toHaveBeenCalledTimes(1);
		expect(b.endWheelZoomRun).toHaveBeenCalledTimes(1);
		// The run ends before the overlay re-reads its own canvas answer.
		expect(a.endWheelZoomRun.mock.invocationCallOrder[0]).toBeLessThan(a.applyCanvasMode.mock.invocationCallOrder.at(-1)!);
	});
});

describe("refreshAllStrips reaches every strip", () => {
	it("refreshes each open overlay's strip and each registered strip surface once", () => {
		const a = open();
		const b = open();
		const c = open();
		const surface = vi.fn();
		const undo = addStripSurface(surface);
		try {
			refreshAllStrips();
			expect(a.refreshStrip).toHaveBeenCalledTimes(1);
			expect(b.refreshStrip).toHaveBeenCalledTimes(1);
			expect(c.refreshStrip).toHaveBeenCalledTimes(1);
			expect(surface).toHaveBeenCalledTimes(1);
		} finally {
			undo();
		}
	});
});

describe("endLiveStrokesEverywhere passes preserveMouse on", () => {
	it("hands the flag to each open overlay and each strip surface's end callback", () => {
		const a = open();
		const b = open();
		const end = vi.fn();
		const undo = addStripSurface(() => undefined, undefined, undefined, undefined, end);
		try {
			endLiveStrokesEverywhere(true);
			expect(a.endLiveStroke).toHaveBeenCalledTimes(1);
			expect(a.endLiveStroke).toHaveBeenCalledWith(true);
			expect(b.endLiveStroke).toHaveBeenCalledWith(true);
			expect(end).toHaveBeenCalledWith(true);

			endLiveStrokesEverywhere();
			expect(a.endLiveStroke).toHaveBeenLastCalledWith(false);
			expect(b.endLiveStroke).toHaveBeenLastCalledWith(false);
			expect(end).toHaveBeenLastCalledWith(false);
		} finally {
			undo();
		}
	});
});

describe("committedFloorFor", () => {
	it("carries the backing multiplier and the device ratio it was given", () => {
		expect(committedFloorFor(1.5, 2)).toEqual({ backing: 1.5, dpr: 2 });
		expect(committedFloorFor(2, 1.8257)).toEqual({ backing: 2, dpr: 1.8257 });
	});

	it("answers undefined when there is no committed backing", () => {
		expect(committedFloorFor(null, 2)).toBeUndefined();
	});
});

describe("gutterPanMode", () => {
	it("rides when there is no sizer or the sizer does not hold the gutters", () => {
		const gutters = {} as HTMLElement;
		expect(gutterPanMode(null, gutters, undefined)).toEqual({ kind: "ride" });
		const outside = { contains: () => false } as unknown as HTMLElement;
		expect(gutterPanMode(outside, gutters, undefined)).toEqual({ kind: "ride" });
	});

	it("does not ride when the gutters sit inside the sizer", () => {
		const gutters = {} as HTMLElement;
		const inside = { contains: (el: unknown) => el === gutters } as unknown as HTMLElement;
		// No view and no computed style in the unit environment: the answer is the in-flow one.
		expect(gutterPanMode(inside, gutters, undefined)).toEqual({ kind: "none" });
	});
});
