/**
 * The pdf surface's band, sync and paint methods live in PdfInkBand.ts and are
 * installed on PdfInkController.prototype when PdfInkController.ts loads. Two
 * things a type check cannot see are held here, as the install tests of the
 * other split files hold them for theirs.
 *
 * LOAD ORDER. PdfInkController.ts imports the install function and the overlay
 * class name. The band file imports only types back, so there is no cycle at
 * run time, but this file still imports the band file first, so a change that
 * adds a value import back into the controller fails here, at load, in the
 * order that breaks.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has, and none may be declared in the class
 * body as well. A name left out of the install still type-checks, because the
 * interface declares it, and would only fail when that sync, paint or wet
 * pair path ran on a device.
 */
import { describe, expect, it } from "vitest";

import { installPdfBand, OVERLAY_CLASS } from "./PdfInkBand";
import { PdfInkController } from "./PdfInkController";
import controllerRaw from "./PdfInkController.ts?raw";

const MOVED = [
	"sync",
	"pageWidthPt",
	"isRotated",
	"frameBox",
	"owns",
	"ensureOverlay",
	"pageElement",
	"wetOn",
	"backingFor",
	"bandBoxFor",
	"surfaceBacking",
	"wetGestureLive",
	"syncBand",
	"attachPair",
	"placeBanded",
	"bandTransform",
	"detachPairFrom",
	"dropPair",
	"restoreSelectionOutline",
	"paint",
	"drawCommitted",
] as const;

describe("band, sync and paint methods on the pdf controller prototype", () => {
	it("load with the band file imported first, and a moved method runs on a bare controller", () => {
		expect(typeof installPdfBand).toBe("function");
		expect(OVERLAY_CLASS).toBe("handwriting-pdf-ink");
		const controller = Object.create(PdfInkController.prototype) as PdfInkController;
		// A rotated page is refused ink; the answer reads one field a constructor would have set.
		controller.rotated = new Set([1]);
		expect(controller.isRotated(1)).toBe(true);
		expect(controller.isRotated(2)).toBe(false);
		// With no wet pair built, no page has one.
		controller.pair = null;
		expect(controller.wetOn(1)).toBeNull();
	});

	it("every moved name is a prototype method with a class method's descriptor, and none is left in the class body", () => {
		const text = controllerRaw.replace(/\r\n/g, "\n");
		for (const name of MOVED) {
			const d = Object.getOwnPropertyDescriptor(PdfInkController.prototype, name);
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
