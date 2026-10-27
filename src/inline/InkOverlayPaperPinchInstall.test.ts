/**
 * The paper and pinch preview methods live in InkOverlayPaperPinch.ts and are
 * installed on InkOverlayPlugin.prototype when InkOverlay.ts loads. Two things
 * a type check cannot see are held here, as InkOverlayCursorsInstall.test.ts
 * and InkOverlayLassoSpaceInstall.test.ts hold them for the other split files.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the paper file
 * imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the paper file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when
 * that paper or pinch path ran on a device. Fourteen test files assign an own
 * property over a moved name on a bare overlay, which needs it writable.
 */
import { describe, expect, it, vi } from "vitest";

import { installPaperPinch } from "./InkOverlayPaperPinch";
import { InkOverlayPlugin } from "./InkOverlay";

const MOVED = [
	"refreshPinchConstraint",
	"reducePinchConstraint",
	"hideBlankPinchLayers",
	"preparePinchComposite",
	"armPinchLayerRestore",
	"writePaperPan",
	"beginPreviewPaper",
	"writeGridBoxPan",
	"traceSettlePaper",
	"traceSettlePaperFrames",
	"watchPaperKind",
	"syncGridPaperBox",
	"removeGridPaperBox",
	"stopPaperKindWatch",
	"clearScrollerPan",
	"gridBoxPaperStyle",
	"measurePreviewPaperBox",
	"movePreviewPaper",
	"rebasePreviewPaper",
	"previewPaperReadout",
	"startPinchGive",
	"pinchGiveStep",
	"pausePinchGive",
	"resumePinchGive",
	"pinchGiveFrame",
	"finishPinchGive",
	"updatePaperSpacing",
	"writePaperVars",
	"clearOwnPaperVars",
] as const;

describe("paper and pinch preview methods on the overlay prototype", () => {
	it("load with the paper file imported first, and a moved method runs on a bare overlay", () => {
		expect(typeof installPaperPinch).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		const disconnect = vi.fn();
		overlay.paperKindWatch = [{ disconnect } as unknown as MutationObserver];
		overlay.paperKindFrame = null;
		overlay.stopPaperKindWatch();
		expect(disconnect).toHaveBeenCalledTimes(1);
		expect(overlay.paperKindWatch).toEqual([]);
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
