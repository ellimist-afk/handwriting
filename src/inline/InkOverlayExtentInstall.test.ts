/**
 * The extent raster and zoom stand-in methods live in InkOverlayExtent.ts and
 * are installed on InkOverlayPlugin.prototype when InkOverlay.ts loads. Two
 * things a type check cannot see are held here, as the install tests of the
 * other split files hold them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the extent file
 * imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the extent file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has, and none may be declared in the class
 * body as well. A name left out of the install still type-checks, because the
 * interface declares it; a repaint, a zoom start or a pen-up would then throw
 * instead of reaching the committed layer.
 */
import { describe, expect, it } from "vitest";

import { installExtent } from "./InkOverlayExtent";
import { InkOverlayPlugin } from "./InkOverlay";
import overlayRaw from "./InkOverlay.ts?raw";

const MOVED = [
	"extentBuildAllowed",
	"armExtentBuild",
	"scheduleExtentPiece",
	"extentPieceAllowed",
	"extentBuildHolds",
	"runExtentPiece",
	"dropExtentBuild",
	"usableExtent",
	"extentToStandIn",
	"takeStandIn",
	"usableStandIn",
	"dropStandIn",
	"retryStandInLater",
	"repaintOverStandIn",
	"copyFromStandIn",
	"standInMarkNow",
	"standInMarkHolds",
	"extentHoldsStore",
	"drawIntoExtent",
	"copyFromExtent",
] as const;

describe("extent raster and stand-in methods on the overlay prototype", () => {
	it("load with the extent file imported first, and the build gate reads its five fields on a bare overlay", () => {
		expect(typeof installExtent).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		// Below 100 percent, on no pan, stroke or bounce frame: the raster may be built.
		Object.assign(overlay, { cssScale: 0.5, repaintScrollOnly: false, frame: { locked: false }, builder: null, bounceState: null });
		expect(overlay.extentBuildAllowed()).toBe(true);
		// At 100 percent it may not.
		overlay.cssScale = 1;
		expect(overlay.extentBuildAllowed()).toBe(false);
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
