/**
 * The gesture end and history methods live in InkOverlayGestureEnd.ts and are
 * installed on InkOverlayPlugin.prototype when InkOverlay.ts loads. Two things
 * a type check cannot see are held here, as the install tests of the other
 * split files hold them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the gesture end
 * file imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the gesture end file first, so
 * a cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has, and none may be declared in the class
 * body as well. A name left out of the install still type-checks, because the
 * interface declares it; a note switch or an unmount would then throw at the
 * gesture reset instead of putting a torn-down erase back.
 */
import { describe, expect, it } from "vitest";

import { installGestureEnd } from "./InkOverlayGestureEnd";
import { InkOverlayPlugin } from "./InkOverlay";
import overlayRaw from "./InkOverlay.ts?raw";

const MOVED = [
	"strokeAbandoned",
	"contactEndedWithoutLift",
	"endLiveGestureForHistory",
	"rollbackLiveGesture",
	"restoredByRollback",
	"cancelFingerInkForPinch",
	"resetGestureState",
	"clearAllInk",
] as const;

describe("gesture end and history methods on the overlay prototype", () => {
	it("load with the gesture end file imported first, and Delete all ink refuses a note the overlay is not showing", () => {
		expect(typeof installGestureEnd).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		// The overlay shows another note: the wipe is refused before it reaches the gesture or the store.
		overlay.filePath = () => "shown.md";
		expect(overlay.clearAllInk("other.md")).toBeNull();
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
