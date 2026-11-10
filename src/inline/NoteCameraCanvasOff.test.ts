/**
 * A REMEMBERED ZOOM IS NOT RESTORED ON A NOTE WHOSE INFINITE CANVAS IS OFF.
 *
 * Canvas off is stock Obsidian: no pinch zoom, no zoom bar (Alan, 2026-09-20). A note zoomed with the canvas on keeps its
 * camera when it closes; with the canvas then turned off, the reopened note used to come back zoomed, with no control
 * there to undo it. The canvas-off reset runs only for a note that is mounted when the canvas goes off, so the restore
 * itself must not bring the zoom back. A camera saved at 100 percent still gives its scroll back, canvas off or on; a
 * zoomed one gives nothing on a canvas-off note, since its scroll was taken at another zoom.
 *
 * Runs a real overlay, mounted all the way (mountRig.test.util.ts), with the commit's layout sinks stubbed as in
 * NoteCameraAtRest.test.ts; the restore and the commit are the real ones, run by hand since this rig's view has no
 * measure loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountOverlay, type MountedOverlay } from "./mountRig.test.util";
import { noteCameras, setNoteCameraStore } from "./NoteCamera";
import { resetTipModeForTest } from "./TipMode";

const KEY = "handwriting:note-cameras";

function storeWith(path: string, camera: { zoom: number; left: number; top: number }) {
	const values = new Map<string, unknown>([[KEY, { v: 1, cameras: { [path]: { ...camera, at: 1 } } }]]);
	return { load: (key: string) => values.get(key) ?? null, save: vi.fn((key: string, value: unknown) => void values.set(key, value)) };
}

/** Stub the commit's layout sinks, so the real commitCameraScale runs through to its success return; the layout is watched. */
function commitReady(m: MountedOverlay): { prepare: ReturnType<typeof vi.fn> } {
	const o = m.o;
	const scroller = m.scrollDOM as unknown as { scrollLeft: number; scrollTop: number; scrollWidth: number; scrollHeight: number };
	scroller.scrollWidth = 64000;
	scroller.scrollHeight = 48000;
	o.pinchScaleNow = 1;
	o.cssScale = 1;
	o.scale = 1;
	const prepare = vi.fn(() => true);
	o.prepareViewportLayout = prepare;
	o.restoreViewportLayout = vi.fn();
	(o.view as Record<string, unknown>).requestMeasure = vi.fn();
	o.viewportLayout = { width: 800, height: 600, baseTransform: "none", externalScale: 1, columnLocal: null };
	for (const name of ["restorePinchLayers", "retirePanSettle", "releaseMeasures", "clearViewportPan", "refreshPenCursor", "updateExtent", "reanchorPan", "scheduleRepaint", "handleResize", "applyViewportBox"]) o[name] = vi.fn();
	o.setViewportScroll = (left: number, top: number) => {
		scroller.scrollLeft = left;
		scroller.scrollTop = top;
	};
	o.syncBand = () => "none";
	o.firstSettleConsumer = () => false;
	return { prepare };
}

/** Mount `path` with `camera` kept for it and the canvas on or off, then run the armed restore. */
function reopen(path: string, camera: { zoom: number; left: number; top: number }, canvas: boolean) {
	const m = mountOverlay(path);
	setNoteCameraStore(storeWith(path, camera));
	const { prepare } = commitReady(m);
	const o = m.o as Record<string, unknown> & { restoreNoteCamera(path: string): void };
	o.canvasMode = canvas;
	o.noteCameraRestore = path;
	o.restoreNoteCamera(path);
	return { m, o, prepare };
}

beforeEach(() => {
	resetTipModeForTest();
	noteCameras.clear();
});
afterEach(() => {
	noteCameras.clear();
	resetTipModeForTest();
});

describe("a remembered camera on a canvas-off note", () => {
	it("a zoomed camera opens at 100 percent and the top, with no viewport layout, and the restore is not left armed", () => {
		const { m, o, prepare } = reopen("off-zoomed.md", { zoom: 2, left: 0, top: 600 }, false);
		try {
			expect(o.pinchScaleNow, "a canvas-off note opened at the remembered zoom").toBe(1);
			expect([m.scrollDOM.scrollLeft, m.scrollDOM.scrollTop], "a scroll taken at another zoom was given back").toEqual([0, 0]);
			expect(prepare, "a canvas-off note was given a viewport layout").not.toHaveBeenCalled();
			expect(o.noteCameraRestore, "the restore stayed armed for a later retry").toBeNull();
		} finally {
			m.destroy();
		}
	});

	it("control: a camera kept at 100 percent still gives its scroll back", () => {
		const { m, o } = reopen("off-plain.md", { zoom: 1, left: 0, top: 600 }, false);
		try {
			expect([o.pinchScaleNow, m.scrollDOM.scrollTop]).toEqual([1, 600]);
			expect(o.noteCameraRestore).toBeNull();
		} finally {
			m.destroy();
		}
	});

	it("control: with the canvas on, the zoomed camera comes back as it was kept", () => {
		const { m, o } = reopen("on-zoomed.md", { zoom: 2, left: 0, top: 600 }, true);
		try {
			expect([o.pinchScaleNow, m.scrollDOM.scrollLeft, m.scrollDOM.scrollTop]).toEqual([2, 0, 600]);
		} finally {
			m.destroy();
		}
	});
});
