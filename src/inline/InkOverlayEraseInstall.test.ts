/**
 * The eraser methods live in InkOverlayErase.ts and are installed on
 * InkOverlayPlugin.prototype when InkOverlay.ts loads. Two things a type
 * check cannot see are held here, as the install tests of the other split
 * files hold them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the eraser file
 * imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the eraser file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has, and none may be declared in the class
 * body as well. A name left out of the install still type-checks, because the
 * interface declares it; an erase stroke would then throw instead of reaching
 * the note.
 */
import { describe, expect, it, vi } from "vitest";

import { installErase } from "./InkOverlayErase";
import { InkOverlayPlugin } from "./InkOverlay";
import type { InkStroke } from "../ink/Stroke";
import overlayRaw from "./InkOverlay.ts?raw";

const MOVED = [
	"eraseCandidates",
	"eraseAt",
] as const;

describe("eraser methods on the overlay prototype", () => {
	it("load with the eraser file imported first, and a clean index answers the query without a rebuild", () => {
		expect(typeof installErase).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		const known = [{ id: "erase-known" }] as unknown as readonly InkStroke[];
		const query = vi.fn(() => known);
		const rebuild = vi.fn();
		overlay.indexDirty = false;
		overlay.strokeIndex = { query, rebuild } as unknown as InkOverlayPlugin["strokeIndex"];
		expect(overlay.eraseCandidates({ x: 10, y: 20 }, 5)).toBe(known);
		expect(query).toHaveBeenCalledTimes(1);
		expect(rebuild).not.toHaveBeenCalled();
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
