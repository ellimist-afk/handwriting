/**
 * The ink operations live in InkOverlayOps.ts and are installed on
 * InkOverlayPlugin.prototype when InkOverlay.ts loads. Three things a type
 * check cannot see are held here, as the install tests of the other split
 * files hold them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the ink ops file
 * imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the ink ops file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has, and none may be declared in the class
 * body as well. A name left out of the install still type-checks, because the
 * interface declares it; an undo, a redo or a repaint request would then throw
 * instead of reaching the note.
 *
 * THE GETTER THAT STAYS. hasSelection is read as a boolean (the Escape guard
 * reads `overlay.hasSelection`). The install defines data properties, so it
 * cannot carry a getter: hasSelection stays in the class, an accessor on the
 * prototype. Were it installed as a method, it would read as a function,
 * truthy every time, and no type check would see it.
 */
import { describe, expect, it } from "vitest";

import { installInkOps } from "./InkOverlayOps";
import { InkOverlayPlugin } from "./InkOverlay";
import type { InkOp } from "./InkHistory";
import overlayRaw from "./InkOverlay.ts?raw";

const MOVED = [
	"stampInkIdentity",
	"dispatchInk",
	"opPath",
	"applyInkOp",
	"repaintPath",
	"currentIndexes",
	"moveLive",
	"scheduleRepaint",
] as const;

describe("ink operations on the overlay prototype", () => {
	it("load with the ink ops file imported first, and an op with no record identity and no page id lands at its own path", () => {
		expect(typeof installInkOps).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		// No session token and no page id: an older op keeps the path it was recorded on, and no field is read.
		const op: InkOp = { type: "add", path: "ops-plain.md", strokes: [] };
		expect(overlay.opPath(op)).toBe("ops-plain.md");
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

	it("hasSelection is still an accessor on the prototype, not a method", () => {
		const d = Object.getOwnPropertyDescriptor(InkOverlayPlugin.prototype, "hasSelection");
		expect(d, "hasSelection is not on the prototype").toBeDefined();
		expect(typeof d!.get, "hasSelection has no getter").toBe("function");
		expect(d!.value, "hasSelection is a data property").toBeUndefined();
	});
});
