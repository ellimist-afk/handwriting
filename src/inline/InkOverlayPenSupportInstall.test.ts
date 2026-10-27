/**
 * The pen probe, the pan readers, the bounce cancel and settle retire, the
 * frame ticker, the empty-page notice, the pan drag and the strip and tail
 * dressing live in InkOverlayPenSupport.ts and are installed on
 * InkOverlayPlugin.prototype when InkOverlay.ts loads. Two things a type check
 * cannot see are held here, as the install tests of the other split files hold
 * them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the pen support
 * file imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the pen support file first, so
 * a cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has, and none may be declared in the class
 * body as well. A name left out of the install still type-checks, because the
 * interface declares it; a camera sync, a pen sample or a pen-down would then
 * throw instead of reading the pan or dressing the tail.
 */
import { describe, expect, it } from "vitest";

import { installPenSupport } from "./InkOverlayPenSupport";
import { InkOverlayPlugin } from "./InkOverlay";
import overlayRaw from "./InkOverlay.ts?raw";

const MOVED = [
	"probeSample",
	"panX",
	"panY",
	"restPanX",
	"restPanY",
	"inkPanX",
	"inkPanY",
	"inkInputPanX",
	"inkInputPanY",
	"cancelOverscrollBounce",
	"resumeStrandedPan",
	"firstSettleConsumer",
	"retirePanSettle",
	"startFrameTicker",
	"stopFrameTicker",
	"sayIfPageEmpty",
	"panMove",
	"applyToolbarCorner",
	"refreshStrip",
	"dressTail",
] as const;

describe("pen probe, pan, settle, frame ticker and strip methods on the overlay prototype", () => {
	it("load with the pen support file imported first, and the tail is dressed on a bare overlay", () => {
		expect(typeof installPenSupport).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		overlay.tailWashed = false;
		// No tail canvas on a bare overlay: the wash is recorded and nothing throws.
		expect(() => overlay.dressTail(true)).not.toThrow();
		expect(overlay.tailWashed).toBe(true);
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
