/**
 * The line anchors live in InkOverlayLineAnchors.ts and are installed on
 * InkOverlayPlugin.prototype when InkOverlay.ts loads. Two things a type check
 * cannot see are held here, as the install tests of the other split files hold
 * them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the line anchor
 * file imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the line anchor file first, so
 * a cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when an
 * editor update, a repaint, a note load, a lasso drop or a font change reached
 * it on a device.
 */
import { describe, expect, it } from "vitest";

import { installLineAnchors } from "./InkOverlayLineAnchors";
import { InkOverlayPlugin } from "./InkOverlay";

const MOVED = [
	"lineWindowMeasured",
	"readLineSignature",
	"lineSignatureMeasured",
	"requestLineSignature",
	"updateLineAnchors",
	"lineAnchorsDrawn",
	"lineAnchorInkLoaded",
	"armLineAnchorPass",
	"lineAnchorsMoved",
	"lineOnScreen",
	"lineLayout",
	"noteStrokes",
	"lineAnchorDy",
	"retakeLineAnchors",
] as const;

describe("line anchor methods on the overlay prototype", () => {
	it("load with the line anchor file imported first, and a moved method runs on a bare overlay", () => {
		expect(typeof installLineAnchors).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		// With no editor view there is no line geometry to read.
		expect(overlay.lineLayout()).toBeNull();
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
