/**
 * A zoom bar tap during a live pinch or ctrl+wheel run is refused. The three
 * bar entry points (zoom by a factor, reset to 100 percent, fit) read the
 * gesture as busy and do nothing; the gesture is not ended by the tap, so its
 * own settle still runs. With no gesture, the bar commits as before.
 *
 * Node only: the overlay is a prototype rig, with the view, the frame clock
 * and the commit sink stubbed. The real WheelZoomRun drives the wheel case.
 */
import { describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";
import { WheelZoomRun } from "./WheelZoom";

function rig() {
	const o = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	o.canvasMode = true;
	o.pinchScaleNow = 1;
	o.zoomFloor = 0.1;
	o.builder = null;
	o.pinchRefScale = null;
	o.pinchPreview = false;
	o.pinchGive = null;
	o.wheelZoomRun = new WheelZoomRun();
	// The gesture terms are the subject here, so busy reads false: any refusal comes from them.
	o.getNoteViewportState = () => ({ zoom: o.pinchScaleNow, busy: false, fitAvailable: true });
	o.zoomAroundCenter = vi.fn(() => true);
	return o as Record<string, any>;
}

describe("zoom bar during a live gesture", () => {
	it("a tap during a live ctrl+wheel run is refused, and the run still ends on its own quiet", () => {
		const o = rig();
		const run = o.wheelZoomRun as WheelZoomRun;
		run.feed({ deltaY: -50, deltaMode: 0, x: 100, y: 100, t: 0 });
		run.feed({ deltaY: -50, deltaMode: 0, x: 100, y: 100, t: 16 });
		run.feed({ deltaY: -50, deltaMode: 0, x: 100, y: 100, t: 32 });
		expect(run.isLive).toBe(true);
		expect(o.zoomNoteBy(1.25)).toBe(false);
		expect(o.resetNoteZoom()).toBe(false);
		expect(o.fitHandwriting()).toBe("busy");
		expect(o.zoomAroundCenter).not.toHaveBeenCalled();
		expect(o.pinchScaleNow).toBe(1);
		expect(run.isLive).toBe(true);
		expect(run.endIfQuiet(200)).not.toBeNull();
	});

	it("a tap during a live pinch is refused by every bar entry point", () => {
		const o = rig();
		o.pinchRefScale = 1;
		expect(o.zoomNoteBy(1.25)).toBe(false);
		expect(o.resetNoteZoom()).toBe(false);
		expect(o.fitHandwriting()).toBe("busy");
		expect(o.zoomAroundCenter).not.toHaveBeenCalled();
	});

	it("a tap during the pinch's give-back is refused", () => {
		const o = rig();
		o.pinchGive = {};
		expect(o.zoomNoteBy(1.25)).toBe(false);
		expect(o.zoomAroundCenter).not.toHaveBeenCalled();
	});

	it("with no gesture, a tap commits as before", () => {
		const o = rig();
		expect(o.zoomNoteBy(1.25)).toBe(true);
		expect(o.zoomAroundCenter).toHaveBeenCalledWith(1.25, false);
		expect(o.resetNoteZoom()).toBe(true);
		expect(o.zoomAroundCenter).toHaveBeenLastCalledWith(1, true);
	});
});
