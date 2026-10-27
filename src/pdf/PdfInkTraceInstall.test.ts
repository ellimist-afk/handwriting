/**
 * The pdf surface's pen-trace and metrics methods live in PdfInkTrace.ts and
 * are installed on PdfInkController.prototype when PdfInkController.ts loads.
 * Two things a type check cannot see are held here, as the install tests of
 * the other split files hold them for theirs.
 *
 * LOAD ORDER. PdfInkController.ts imports the install function. The trace file
 * imports only types back, so there is no cycle at run time, but this file
 * still imports the trace file first, so a change that adds a value import
 * back into the controller fails here, at load, in the order that breaks.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has, and none may be declared in the class
 * body as well. A name left out of the install still type-checks, because the
 * interface declares it, and would only fail when that trace or metrics path
 * ran on a device.
 */
import { describe, expect, it } from "vitest";

import { installPdfTrace } from "./PdfInkTrace";
import { PdfInkController } from "./PdfInkController";
import controllerRaw from "./PdfInkController.ts?raw";

const MOVED = [
	"recordDown",
	"recordDownUnsafe",
	"describe",
	"tracePenDown",
	"traceRawBatch",
	"describeReticleOutcome",
	"recordReticleOutcome",
	"startFrameTicker",
	"stopFrameTicker",
	"endMetrics",
	"tracePenUp",
] as const;

describe("trace and metrics methods on the pdf controller prototype", () => {
	it("load with the trace file imported first, and a moved method runs on a bare controller", () => {
		expect(typeof installPdfTrace).toBe("function");
		const controller = Object.create(PdfInkController.prototype) as PdfInkController;
		// Neither of these reads a field a constructor would have set.
		expect(controller.describeReticleOutcome(null)).toBe("reticle=not-attempted");
		expect(controller.describeReticleOutcome("off")).toBe("reticle=skipped reason=off");
		// The ticker flag is cleared by the moved method itself.
		controller.frameTicking = true;
		controller.stopFrameTicker();
		expect(controller.frameTicking).toBe(false);
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
