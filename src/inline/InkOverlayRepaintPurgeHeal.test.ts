/**
 * The committed repaint's purge heal, held by behaviour.
 *
 * A scroll repaint that finds no work draws nothing. That is right while the pixels are there and wrong
 * if the platform has quietly taken the canvas's pixels: nothing would ask for them again until the band
 * moved. The repaint reads the sentinel pixel back after such a frame and, on a zero, asks for a whole
 * repaint. This file runs the real `repaint` on a stand-in overlay whose every other step is a no-op and
 * asserts that ask: made when the sentinel is gone, not made when it is still painted.
 */
import { describe, expect, it, vi } from "vitest";

import { InkOverlayPlugin } from "./InkOverlay";

/** A committed context whose one-pixel read answers with the given alpha. */
function ctxWithSentinelAlpha(alpha: number): CanvasRenderingContext2D {
	return {
		getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, alpha]) }),
	} as unknown as CanvasRenderingContext2D;
}

/** The overlay's repaint with a camera that has not moved, no damage, and a probe armed and due. */
function stillScrollFrame(alpha: number) {
	const proto = Object.create(InkOverlayPlugin.prototype) as object;
	// Own data properties, so a getter on the prototype (the window reference) is replaced rather than assigned through.
	const o = new Proxy(proto, {
		set(target, key, value) {
			Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
			return true;
		},
	}) as Record<string, unknown>;
	const cam = { x: 0, y: 0, zoom: 1 };
	const requests: string[] = [];
	o.deferPinchRaster = () => false;
	o.restorePinchLayers = () => undefined;
	o.container = {};
	o.pinchPreview = false;
	o.winRef = { devicePixelRatio: 1 };
	o.dpr = 1;
	o.bandCarriedThisFrame = false;
	o.syncBand = () => "none";
	o.rasterPanNeedsBake = () => false;
	o.syncCamera = () => undefined;
	o.filePath = () => "purge-heal.md";
	o.noteStrokes = () => [{}];
	o.camera = { snapshot: cam };
	o.cssScale = 1;
	o.lastPaintCam = cam;
	o.damage = { take: () => [] };
	o.committedBacking = 1;
	o.extentBuildAllowed = () => false;
	// The paint itself is not under test: it reports the probe armed and draws nothing.
	o.paintCommittedWork = () => true;
	o.repaintScrollOnly = true;
	o.frame = { locked: false };
	o.lastPurgeProbe = -1_000_000;
	o.committedCtx = ctxWithSentinelAlpha(alpha);
	o.selection = { isEmpty: true };
	o.lassoActive = false;
	o.spaceLineY = null;
	o.spacePreview = null;
	o.updateExtent = () => undefined;
	o.scheduleRepaint = (why: string) => requests.push(why);
	return { overlay: o as unknown as InkOverlayPlugin, requests };
}

describe("repaint heals a purged committed layer", () => {
	it("asks for a whole repaint when a still scroll frame finds the sentinel pixel gone", () => {
		const { overlay, requests } = stillScrollFrame(0);
		overlay.repaint();
		expect(requests).toEqual(["purge-heal"]);
	});

	it("asks for nothing when the sentinel pixel is still painted", () => {
		const { overlay, requests } = stillScrollFrame(255);
		overlay.repaint();
		expect(requests).toEqual([]);
	});

	it("does not read the pixel back for a note with no ink", () => {
		const { overlay, requests } = stillScrollFrame(0);
		(overlay as unknown as Record<string, unknown>).noteStrokes = () => [];
		const read = vi.fn(() => ({ data: new Uint8ClampedArray(4) }));
		(overlay as unknown as { committedCtx: unknown }).committedCtx = { getImageData: read };
		overlay.repaint();
		expect(read).not.toHaveBeenCalled();
		expect(requests).toEqual([]);
	});
});
