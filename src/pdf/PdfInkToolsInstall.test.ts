/**
 * The pdf surface's pen tools strip and pane lifecycle live in PdfInkTools.ts
 * and are installed on PdfInkController.prototype when PdfInkController.ts
 * loads. Two things a type check cannot see are held here, as the install
 * tests of the other split files hold them for theirs.
 *
 * LOAD ORDER. PdfInkController.ts imports the install function. The tools
 * file imports only types back, so there is no cycle at run time, but this
 * file still imports the tools file first, so a change that adds a value
 * import back into the controller fails here, at load, in the order that
 * breaks.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when
 * that strip or lifecycle path ran on a device.
 */
import { describe, expect, it } from "vitest";

import { installPdfTools } from "./PdfInkTools";
import { PdfInkController } from "./PdfInkController";

const MOVED = [
	"ensureTools",
	"ensureToolsInner",
	"buildTools",
	"stripExec",
	"refreshStrip",
	"mount",
	"unmount",
	"forgetHistory",
] as const;

describe("tools and lifecycle methods on the pdf controller prototype", () => {
	it("load with the tools file imported first, and a moved method runs on a bare controller", () => {
		expect(typeof installPdfTools).toBe("function");
		const controller = Object.create(PdfInkController.prototype) as PdfInkController;
		// Not mounted and no strip yet: the inner build has nothing to do and
		// returns before it reaches a field a constructor would have set.
		controller.mounted = false;
		controller.tools = null;
		expect(() => controller.ensureToolsInner()).not.toThrow();
		expect(controller.tools).toBeNull();
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
