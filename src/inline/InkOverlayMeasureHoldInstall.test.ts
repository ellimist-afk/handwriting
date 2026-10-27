/**
 * The measure hold and deferred repaint methods live in
 * InkOverlayMeasureHold.ts and are installed on InkOverlayPlugin.prototype
 * when InkOverlay.ts loads. Two things a type check cannot see are held here,
 * as the install tests of the other split files hold them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the measure
 * hold file imports values back, so the two modules form a cycle. Every other
 * test imports InkOverlay.ts first. This file imports the measure hold file
 * first, so a cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when
 * a pinch, a resize or a deferred repaint reached it on a device.
 */
import { describe, expect, it } from "vitest";

import { installMeasureHold } from "./InkOverlayMeasureHold";
import { InkOverlayPlugin } from "./InkOverlay";

const MOVED = [
	"armDeferredRepaint",
	"clearDeferredRepaint",
	"holdMeasures",
	"resizeOutOfUpdate",
	"releaseMeasures",
	"rebasePinch",
	"deferPinchRaster",
] as const;

describe("measure hold methods on the overlay prototype", () => {
	it("load with the measure hold file imported first, and a moved method runs on a bare overlay", () => {
		expect(typeof installMeasureHold).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		overlay.repaintDeferredByPinch = true;
		overlay.clearDeferredRepaint();
		expect(overlay.repaintDeferredByPinch).toBe(false);
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
