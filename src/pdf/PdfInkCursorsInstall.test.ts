/**
 * The pdf surface's cursor methods live in PdfInkCursors.ts and are installed
 * on PdfInkController.prototype when PdfInkController.ts loads. Two things a
 * type check cannot see are held here, as the install tests of the other split
 * files hold them for theirs.
 *
 * LOAD ORDER. PdfInkController.ts imports the install function, and the cursor
 * file imports a value back, so the two modules form a cycle. Every other test
 * imports PdfInkController.ts first. This file imports the cursor file first,
 * so a cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when
 * that cursor path ran on a device.
 */
import { describe, expect, it, vi } from "vitest";

import { installPdfCursors } from "./PdfInkCursors";
import { PdfInkController } from "./PdfInkController";

const MOVED = [
	"showCursor",
	"hideCursor",
	"showEraserCursor",
	"hideEraserCursor",
	"showLassoCursor",
	"hideLassoCursor",
	"beginPanDragCursor",
	"endPanDragCursor",
	"showSpaceCursor",
	"hideSpaceCursor",
] as const;

describe("cursor methods on the pdf controller prototype", () => {
	it("load with the cursor file imported first, and a moved method runs on a bare controller", () => {
		expect(typeof installPdfCursors).toBe("function");
		const controller = Object.create(PdfInkController.prototype) as PdfInkController;
		const setCssStyles = vi.fn();
		const remove = vi.fn();
		controller.cursorTimer = null;
		controller.cursorEl = { setCssStyles, parentElement: null } as unknown as HTMLElement;
		controller.cursorScroller = null;
		controller.boundScroller = { classList: { remove } } as unknown as HTMLElement;
		controller.cursorTraceHidden = false;
		controller.hideCursor();
		expect(setCssStyles).toHaveBeenCalledWith({ display: "none" });
		expect(remove).toHaveBeenCalledWith("handwriting-pdf-hover");
		expect(remove).toHaveBeenCalledWith("handwriting-pdf-pan-drag");
		expect(controller.cursorTraceHidden).toBe(true);
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		for (const name of MOVED) {
			const d = Object.getOwnPropertyDescriptor(PdfInkController.prototype, name);
			expect(d, `${name} is not on the prototype`).toBeDefined();
			expect(typeof d!.value, name).toBe("function");
			expect(
				{ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable },
				name
			).toEqual({ writable: true, enumerable: false, configurable: true });
		}
	});
});
