/**
 * The pdf surface's selection and clipboard methods live in PdfInkSelection.ts
 * and are installed on PdfInkController.prototype when PdfInkController.ts
 * loads. Two things a type check cannot see are held here, as the install
 * tests of the other split files hold them for theirs.
 *
 * LOAD ORDER. PdfInkController.ts imports the install function. The selection
 * file imports only types back, so there is no cycle at run time, but this
 * file still imports the selection file first, so a change that adds a value
 * import back into the controller fails here, at load, in the order that
 * breaks.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when
 * that selection path ran on a device.
 */
import { describe, expect, it } from "vitest";

import { installPdfSelection } from "./PdfInkSelection";
import { PdfInkController } from "./PdfInkController";

const MOVED = [
	"selectionGrabbed",
	"lassoDown",
	"queueEditFrame",
	"flushEditFrame",
	"lassoMove",
	"snipSelection",
	"selectionBounds",
	"clearSelection",
	"dissolveSelection",
	"drawLasso",
	"deleteSelection",
	"lassoUp",
	"copyToClipboard",
	"copySelection",
	"deleteSelectionCommand",
	"cutSelectionCommand",
	"notifyUnidentified",
	"cutSelection",
	"pasteFromClipboard",
] as const;

describe("selection methods on the pdf controller prototype", () => {
	it("load with the selection file imported first, and a moved method runs on a bare controller", () => {
		expect(typeof installPdfSelection).toBe("function");
		const controller = Object.create(PdfInkController.prototype) as PdfInkController;
		const bbox = { x: 1, y: 2, width: 3, height: 4 };
		(controller as unknown as { strokes: (page: number) => unknown[] }).strokes = () => [{ id: "a", bbox }, { id: "b", bbox: { x: 90, y: 90, width: 1, height: 1 } }];
		controller.selectionPage = 2;
		controller.selected = ["a"];
		expect(controller.selectionBounds(2)).toEqual(bbox);
		expect(controller.selectionBounds(1)).toBeNull();
		expect(controller.hasSelection).toBe(true);
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
