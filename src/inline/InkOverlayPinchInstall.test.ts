/**
 * The pinch core lives in InkOverlayPinch.ts and is installed on
 * InkOverlayPlugin.prototype when InkOverlay.ts loads. Two things a type check
 * cannot see are held here, as the install tests of the other split files hold
 * them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the pinch file
 * imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the pinch file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when a
 * pinch, a wheel zoom, a repaint, a pen-down or a resize reached it on a
 * device.
 */
import { describe, expect, it } from "vitest";

import { installPinch } from "./InkOverlayPinch";
import { InkOverlayPlugin } from "./InkOverlay";

const MOVED = [
	"pinch",
	"flushPinch",
	"applyPinchScale",
	"columnLocalAt",
	"contentTopLocalAt",
	"rasterPanTarget",
	"bakeCanCarry",
	"rasterPanNeedsBake",
	"restorePinchLayers",
	"markCommittedPaint",
	"unpanX",
	"documentTopUnpanned",
	"captureRasterColumn",
	"applyPreviewInkOffset",
	"writeInkLayerTransform",
	"onContentResize",
	"endPreviewPaper",
	"panSizer",
	"clearPreviewInkOffset",
	"pageContentWidth",
] as const;

describe("pinch core methods on the overlay prototype", () => {
	it("load with the pinch file imported first, and a moved method runs on a bare overlay", () => {
		expect(typeof installPinch).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		// A painted x that was never read stays unread, before any pan is asked for.
		expect(overlay.unpanX(null)).toBeNull();
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
