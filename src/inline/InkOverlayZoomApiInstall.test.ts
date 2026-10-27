/**
 * The viewport and zoom API lives in InkOverlayZoomApi.ts and is installed on
 * InkOverlayPlugin.prototype when InkOverlay.ts loads. Two things a type check
 * cannot see are held here, as the install tests of the other split files hold
 * them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the zoom file
 * imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the zoom file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when a
 * zoom button, a pinch commit, Fit, a pen lift or the canvas setting reached
 * it on a device.
 */
import { describe, expect, it } from "vitest";

import { installZoomApi } from "./InkOverlayZoomApi";
import { InkOverlayPlugin } from "./InkOverlay";

const MOVED = [
	"hostZoomSupported",
	"zoomFormAt",
	"noteScrollbarUnscaled",
	"capturePaperOrigin",
	"ownsNoteViewport",
	"noteViewportOwnLines",
	"getNoteViewportState",
	"applyCanvasMode",
	"endZoomGestureInFlight",
	"retryCanvasOffReset",
	"canvasModeOn",
	"zoomNoteBy",
	"resetNoteZoom",
	"zoomAroundCenter",
	"fitHandwriting",
	"commitCameraScale",
] as const;

describe("viewport and zoom methods on the overlay prototype", () => {
	it("load with the zoom file imported first, and a moved method runs on a bare overlay", () => {
		expect(typeof installZoomApi).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		// No canvas-off reset is pending on a bare overlay, so the retry a pen lift makes does nothing.
		expect(overlay.retryCanvasOffReset()).toBe(false);
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		for (const name of MOVED) {
			const d = Object.getOwnPropertyDescriptor(InkOverlayPlugin.prototype, name);
			expect(d, `${name} is not on the prototype`).toBeDefined();
			expect(typeof d!.value, name).toBe("function");
			expect(
				{ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable },
				name
			).toEqual({ writable: true, enumerable: false, configurable: true });
		}
	});
});
