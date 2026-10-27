/**
 * The keyboard handlers and the mouse Snap chip live in InkOverlayKeys.ts and
 * are installed on InkOverlayPlugin.prototype when InkOverlay.ts loads. Two
 * things a type check cannot see are held here, as the install tests of the
 * other split files hold them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the keys file
 * imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the keys file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when a
 * key press, a paste or a snapped mouse stroke reached it on a device.
 */
import { describe, expect, it } from "vitest";

import { installKeys } from "./InkOverlayKeys";
import { InkOverlayPlugin } from "./InkOverlay";

const MOVED = ["handleKeyDown", "handlePaste", "handleKeyUp", "offerSnapChip", "takeSnapOffer"] as const;

describe("keyboard and Snap chip methods on the overlay prototype", () => {
	it("load with the keys file imported first, and a moved method runs on a bare overlay", () => {
		expect(typeof installKeys).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		// A paste with no text on the clipboard is somebody else's: passed through.
		expect(overlay.handlePaste({ clipboardData: null } as unknown as ClipboardEvent)).toBe(false);
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
