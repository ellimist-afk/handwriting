/**
 * The cursor methods live in InkOverlayCursors.ts and are installed on
 * InkOverlayPlugin.prototype when InkOverlay.ts loads. Two things a type
 * check cannot see are held here.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the cursor file
 * imports three values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the cursor file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when
 * that cursor path ran on a device.
 */
import { describe, expect, it, vi } from "vitest";

import { installCursors } from "./InkOverlayCursors";
import { InkOverlayPlugin } from "./InkOverlay";

const MOVED = [
	"showPenCursor",
	"refreshPenCursor",
	"paintPenCursor",
	"hidePenCursor",
	"concealPenCursor",
	"armHoverWatchdog",
	"clearHoverWatchdog",
	"showEraserCursor",
	"hideEraserCursor",
	"showLassoCursor",
	"hideLassoCursor",
	"beginPanDragCursor",
	"restoreReticleAfterPan",
	"showSpaceCursor",
	"hideSpaceCursor",
] as const;

describe("cursor methods on the overlay prototype", () => {
	it("load with the cursor file imported first, and a moved method runs on a bare overlay", () => {
		expect(typeof installCursors).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		const setCssStyles = vi.fn();
		overlay.penCursorEl = { setCssStyles } as unknown as HTMLElement;
		overlay.penCursorShown = true;
		overlay.concealPenCursor();
		expect(overlay.penCursorShown).toBe(false);
		expect(setCssStyles).toHaveBeenCalledWith({ opacity: "0" });
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
