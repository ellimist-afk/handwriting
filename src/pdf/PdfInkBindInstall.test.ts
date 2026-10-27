/**
 * The pdf surface's binding and lifecycle methods - the empty-page notice key,
 * the Escape and text-selection checks, the focus release, binding to a
 * scroller, the end and abandon of a live stroke, the wet trail, the gesture
 * reset and the refresh - live in PdfInkBind.ts and are installed on
 * PdfInkController.prototype when PdfInkController.ts loads. Four things a type
 * check cannot see are held here, as the install tests of the other split files
 * hold them for theirs.
 *
 * LOAD ORDER. PdfInkController.ts imports the install function. The binding
 * file imports only a type back from the controller, so there is no cycle at
 * run time, but this file still imports the binding file first, so a value
 * import added back from the controller fails here, at load, in the order that
 * breaks.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when a
 * scroller was bound or a stroke was abandoned on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * binding file declares each once, so a half-finished move cannot pass with the
 * old copy still shadowing the new one.
 *
 * ONE DOOR. The binding file takes nothing but the controller type from the
 * controller file.
 */
import { describe, expect, it, vi } from "vitest";

import { installPdfInkBind } from "./PdfInkBind";
import { PdfInkController } from "./PdfInkController";
import controllerRaw from "./PdfInkController.ts?raw";
import fileRaw from "./PdfInkBind.ts?raw";

const MOVED = [
	"emptyPageNoticeKey",
	"sayIfPageEmpty",
	"peelEscapeSelection",
	"textSelectionLive",
	"releaseFocusBinding",
	"bindTo",
	"endLiveStroke",
	"strokeAbandoned",
	"clearWetTrail",
	"resetGestureState",
	"refresh",
] as const;

/** Every name the binding file takes from the controller file, and nothing else. */
const FROM_CONTROLLER = ["PdfInkController"];

const controllerSrc = controllerRaw.replace(/\r\n/g, "\n");
const fileSrc = fileRaw.replace(/\r\n/g, "\n");

/** A controller built without its constructor: the prototype and the fields a method reads. */
function bareController(fields: Record<string, unknown> = {}): PdfInkController {
	const controller = Object.create(PdfInkController.prototype) as PdfInkController;
	for (const [key, value] of Object.entries(fields)) {
		Object.defineProperty(controller, key, { value, writable: true, configurable: true });
	}
	return controller;
}

describe("binding and lifecycle methods on the pdf controller prototype", () => {
	it("load with the binding file imported first, and moved methods run on a bare controller", () => {
		expect(typeof installPdfInkBind).toBe("function");
		// An unidentified document has no key, so no page can claim the empty-page notice.
		expect(bareController({ documentId: () => null }).emptyPageNoticeKey(3)).toBeNull();
		expect(bareController({ documentId: () => "doc-1" }).emptyPageNoticeKey(3)).toBe("doc-1#3");

		// Text selected in another pane does not count; only a live selection inside this root does.
		const inside = {} as Node;
		const root = { contains: (node: Node | null) => node === inside } as unknown as HTMLElement;
		const winWith = (selection: unknown) => ({ getSelection: () => selection }) as unknown as Window;
		expect(bareController({ win: {} as Window, root }).textSelectionLive()).toBe(false);
		expect(bareController({ win: winWith(null), root }).textSelectionLive()).toBe(false);
		expect(bareController({ win: winWith({ isCollapsed: true, anchorNode: inside }), root }).textSelectionLive()).toBe(false);
		expect(bareController({ win: winWith({ isCollapsed: false, anchorNode: {} }), root }).textSelectionLive()).toBe(false);
		expect(bareController({ win: winWith({ isCollapsed: false, anchorNode: inside }), root }).textSelectionLive()).toBe(true);

		// Ending a live stroke asks the router to finish it, keeping a mouse stroke when told to, and does nothing unbound.
		const finishActiveStroke = vi.fn();
		const bound = bareController({ router: { finishActiveStroke } });
		bound.endLiveStroke(true);
		expect(finishActiveStroke).toHaveBeenLastCalledWith({ preserveMouse: true });
		bound.endLiveStroke();
		expect(finishActiveStroke).toHaveBeenLastCalledWith({ preserveMouse: false });
		expect(() => bareController({ router: null }).endLiveStroke(true)).not.toThrow();
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

	it("each moved name is declared once in the binding file and not in the class", () => {
		const classStart = controllerSrc.indexOf("export class PdfInkController {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = controllerSrc.slice(classStart, controllerSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = fileSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: PdfInkController\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in PdfInkBind.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the controller installs once, after the class closing brace", () => {
		const call = "installPdfInkBind(PdfInkController.prototype);";
		expect(controllerSrc.split(call).length - 1).toBe(1);
		const classStart = controllerSrc.indexOf("export class PdfInkController {");
		const classEnd = controllerSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(controllerSrc.indexOf(call)).toBeGreaterThan(classEnd);
	});

	it("the binding file takes exactly the listed names from the controller file", () => {
		const imports = [...fileSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/PdfInkController";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_CONTROLLER].sort());
		// A type-only import leaves nothing behind at run time, so no cycle can form.
		expect(/import\s+type\s+\{\s*PdfInkController\s*\}\s+from\s+"\.\/PdfInkController";/.test(fileSrc)).toBe(true);
	});
});
