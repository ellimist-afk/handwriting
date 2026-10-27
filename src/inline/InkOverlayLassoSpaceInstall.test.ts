/**
 * The lasso, selection and insert-space methods live in
 * InkOverlayLassoSpace.ts and are installed on InkOverlayPlugin.prototype when
 * InkOverlay.ts loads. Two things a type check cannot see are held here, as
 * InkOverlayCursorsInstall.test.ts holds them for the cursor file.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the lasso file
 * imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the lasso file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when
 * that lasso or insert-space path ran on a device.
 */
import { describe, expect, it } from "vitest";

import { installLassoSpace } from "./InkOverlayLassoSpace";
import { InkOverlayPlugin } from "./InkOverlay";

const MOVED = [
	"pruneSelectionOnInkChange",
	"strokesHere",
	"selectionBounds",
	"lassoDown",
	"lassoMove",
	"commitLiveDrag",
	"lassoUp",
	"spaceTextBoundary",
	"planSpace",
	"previewSpace",
	"queueSpaceFeedback",
	"clearSpaceFeedback",
	"spaceDown",
	"spaceMove",
	"spaceUp",
	"spaceTextChange",
	"dissolveSelection",
	"queueTailShrink",
	"shrinkTailNow",
	"spaceDrawItems",
	"buildSpaceDrawItems",
	"redrawSelectionUI",
	"rollbackSpaceMove",
	"committedStrokes",
	"beginSpaceSnapshot",
	"endSpaceSnapshot",
	"spaceAmber",
	"drawSpacePicture",
	"rasterSpacePicture",
	"rasterSpaceRows",
	"snipSelection",
	"copySelectedInk",
	"cutSelectedInk",
	"pasteInkHere",
	"deleteSelectedInk",
] as const;

describe("lasso and insert-space methods on the overlay prototype", () => {
	it("load with the lasso file imported first, and a moved method runs on a bare overlay", () => {
		expect(typeof installLassoSpace).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		overlay.spaceFeedbackRaf = null;
		overlay.spaceFeedbackKey = null;
		overlay.spaceHoverY = 120;
		overlay.spacePreview = null;
		overlay.clearSpaceFeedback();
		expect(overlay.spaceHoverY).toBeNull();
		expect(overlay.spacePreview).toBeNull();
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
