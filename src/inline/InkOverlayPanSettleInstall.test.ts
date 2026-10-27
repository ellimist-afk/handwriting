/**
 * The pan, overscroll and settle methods live in InkOverlayPanSettle.ts and
 * are installed on InkOverlayPlugin.prototype when InkOverlay.ts loads. Two
 * things a type check cannot see are held here, as the install tests of the
 * other split files hold them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the pan file
 * imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the pan file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when
 * that pan, bounce or settle path ran on a device. Eighteen test and fixture
 * files set a property over a moved name, one of them on the prototype
 * itself, which needs it writable.
 */
import { describe, expect, it } from "vitest";

import { installPanSettle } from "./InkOverlayPanSettle";
import { InkOverlayPlugin } from "./InkOverlay";

const MOVED = [
	"panFloor",
	"writeViewportPan",
	"observeAboveContent",
	"anchorPanTo",
	"settleBlank",
	"panAxisWindow",
	"paintedColumnMargin",
	"appliedColumnMargin",
	"restColumnAgainstCurrentGrant",
	"columnMarginDebtScrollLeft",
	"columnRestPan",
	"ownLinesPageBoxScrollLeft",
	"columnFitsPane",
	"columnRestCentred",
	"holdOverscrollGive",
	"releaseOverscrollGive",
	"startOverscrollBounce",
	"overscrollBounceReadout",
	"notePanBound",
	"dragGateReadout",
	"panFitReadout",
	"reanchorPan",
	"ownScrollRange",
	"consumeViewportScroll",
	"ownsPanSettle",
	"clearViewportPan",
	"columnMarginLocal",
	"restoreViewportLayout",
	"prepareViewportLayout",
	"scheduleViewportStyleRefresh",
	"refreshViewportColumn",
	"measureNaturalColumn",
	"measureColumnAuto",
	"setViewportScroll",
	"setScrollResidual",
	"hostTransform",
	"scrollbarUnscaleAt",
	"scrollbarLocalAt",
	"placeCanvasLayers",
	"applyViewportBox",
] as const;

describe("pan, overscroll and settle methods on the overlay prototype", () => {
	it("load with the pan file imported first, and a moved method runs on a bare overlay", () => {
		expect(typeof installPanSettle).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		overlay.panBoundHits = 0;
		overlay.panBoundMaxPx = 0;
		overlay.notePanBound(true, 10, 7);
		overlay.notePanBound(true, 4, 5);
		overlay.notePanBound(false, 10, 0);
		expect(overlay.panBoundHits).toBe(2);
		expect(overlay.panBoundMaxPx).toBe(3);
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
