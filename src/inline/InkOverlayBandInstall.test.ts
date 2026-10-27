/**
 * The scroll band and surface extent methods live in InkOverlayBand.ts and are
 * installed on InkOverlayPlugin.prototype when InkOverlay.ts loads. Two things
 * a type check cannot see are held here, as the install tests of the other
 * split files hold them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the band file
 * imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the band file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has, and none may be declared in the class
 * body as well. A name left out of the install still type-checks, because the
 * interface declares it; a repaint, a pen-up or a zoom settle would then throw
 * instead of placing the band or granting the scroll extent.
 */
import { describe, expect, it } from "vitest";

import { installBand } from "./InkOverlayBand";
import { InkOverlayPlugin } from "./InkOverlay";
import overlayRaw from "./InkOverlay.ts?raw";

const MOVED = [
	"syncBand",
	"carryBakedPan",
	"slideCommittedPixels",
	"carryBandUnderLock",
	"updateExtent",
	"shrinkSideways",
	"shrinkWhenScrollIsQuiet",
	"bandPlacement",
	"releaseBandMargin",
	"measureBandFreeHeight",
	"holdLeftReserve",
	"dropLeftReserve",
	"ensureScrollableAxis",
	"restoreScrollableAxis",
	"measureReach",
] as const;

describe("scroll band and surface extent methods on the overlay prototype", () => {
	it("load with the band file imported first, and the band placement splits whole px from the fraction on a bare overlay", () => {
		expect(typeof installBand).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		// Whole px in left and top, the fraction in the translate; no field is read.
		expect(overlay.bandPlacement(3.25, 4.5)).toEqual({ left: "3px", top: "4px", transform: "translate(0.25px, 0.5px)" });
	});

	it("every moved name is a prototype method with a class method's descriptor, and none is left in the class body", () => {
		const text = overlayRaw.replace(/\r\n/g, "\n");
		for (const name of MOVED) {
			const d = Object.getOwnPropertyDescriptor(InkOverlayPlugin.prototype, name);
			expect(d, `${name} is not on the prototype`).toBeDefined();
			expect(typeof d!.value, name).toBe("function");
			expect(
				{ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable },
				name
			).toEqual({ writable: true, enumerable: false, configurable: true });
			expect(new RegExp(`^\\t(private )?${name}\\(`, "m").test(text), `${name} is still declared in the class body`).toBe(false);
		}
	});
});
