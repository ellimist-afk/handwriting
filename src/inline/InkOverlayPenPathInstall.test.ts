/**
 * The pen path - pen down, the raw samples, pen up and the end of the
 * gesture, the snap preview, the predicted tail, the present probe, the
 * camera anchor and the visible band area - lives in InkOverlayPenPath.ts and
 * is installed on InkOverlayPlugin.prototype when InkOverlay.ts loads. Two
 * things a type check cannot see are held here, as the install tests of the
 * other split files hold them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the pen path
 * file imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the pen path file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has, and none may be declared in the class
 * body as well. A name left out of the install still type-checks, because the
 * interface declares it; a pen-down, a pen sample or a pen-up would then throw
 * instead of drawing the stroke.
 */
import { describe, expect, it } from "vitest";

import { installPenPath } from "./InkOverlayPenPath";
import { InkOverlayPlugin } from "./InkOverlay";
import overlayRaw from "./InkOverlay.ts?raw";

const MOVED = [
	"penDown",
	"beginSnapPreview",
	"clearSnapPreview",
	"penRaw",
	"planPredictedTail",
	"schedulePresentProbe",
	"freshFrame",
	"anchorCameraY",
	"recordPenDownState",
	"gainedPressure",
	"penUp",
	"endPenGesture",
	"visibleBandArea",
] as const;

describe("pen path methods on the overlay prototype", () => {
	it("load with the pen path file imported first, and a bare overlay reads no frame and gains the pressure", () => {
		expect(typeof installPenPath).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		// No container on a bare overlay: there is no frame to read.
		expect(overlay.freshFrame()).toBeNull();
		// The raw sample raises the stroke's raw max, and the gain scales it.
		overlay.strokeRawMax = 0;
		overlay.strokeGain = 2;
		expect(overlay.gainedPressure(0.4)).toBe(0.8);
		expect(overlay.strokeRawMax).toBe(0.4);
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
