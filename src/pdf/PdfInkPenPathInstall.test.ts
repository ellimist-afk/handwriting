/**
 * The pdf surface's pen path - pen down, the raw samples, the predicted tail,
 * the wet draw and the erase - lives in PdfInkPenPath.ts and is installed on
 * PdfInkController.prototype when PdfInkController.ts loads. Four things a
 * type check cannot see are held here, as the install tests of the other split
 * files hold them for theirs.
 *
 * LOAD ORDER. PdfInkController.ts imports the install function, and the pen
 * path file imports values back, so the two modules form a cycle. Every other
 * test imports PdfInkController.ts first. This file imports the pen path file
 * first, and one cell loads the controller first in a fresh module graph, so a
 * cycle that only works in one order fails here, at load, in either.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it; a pen-down, a pen sample or
 * an erase would then throw instead of drawing.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * pen path file declares each once, so a half-finished move cannot pass with
 * the old copy still shadowing the new one.
 *
 * ONE DOOR. The pen path file names nothing of the controller file beyond the
 * list below.
 */
import { describe, expect, it, vi } from "vitest";

import { installPdfInkPenPath } from "./PdfInkPenPath";
import { PdfInkController } from "./PdfInkController";
import controllerRaw from "./PdfInkController.ts?raw";
import fileRaw from "./PdfInkPenPath.ts?raw";
import type { PageBox } from "./PageMap";
import type { PenSample } from "../input/PointerRouter";
import type { InkStroke } from "../ink/Stroke";

const MOVED = [
	"toContent",
	"penDown",
	"penRaw",
	"drawPredictedTail",
	"scaleFor",
	"cameraFor",
	"drawContact",
	"drawHead",
	"drawWet",
	"opList",
	"eraseAt",
	"recordErase",
] as const;

/** Every name the pen path file takes from the controller file, and nothing else. */
const FROM_CONTROLLER = [
	"PdfInkController",
	"ReticleOutcome",
	"WetPair",
	"freshPdfTraceState",
	"isTypingTarget",
	"pdfPenWidth",
	"pointerScale",
];

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

function expectInstalled(proto: object): void {
	for (const name of MOVED) {
		const d = Object.getOwnPropertyDescriptor(proto, name);
		expect(d, `${name} is not on the prototype`).toBeDefined();
		expect(typeof d!.value, name).toBe("function");
		expect(
			{ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable },
			name
		).toEqual({ writable: true, enumerable: false, configurable: true });
	}
}

const box: PageBox = { pageNumber: 2, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800 };

describe("pen path methods on the pdf controller prototype", () => {
	it("load with the pen path file imported first, and moved methods run on a bare controller", () => {
		expect(typeof installPdfInkPenPath).toBe("function");

		// A page whose size in points is unknown has no camera, and the viewer's own scale stands in.
		const unmeasured = bareController({ pageSize: new Map() });
		expect(unmeasured.cameraFor(box)).toBeNull();
		expect(unmeasured.scaleFor(box, 7)).toBe(7);

		// A measured page is drawn at css px per point.
		const measured = bareController({ pageSize: new Map([[2, { wPt: 300, hPt: 400 }]]) });
		expect(measured.cameraFor(box)).toEqual({ x: 0, y: 0, zoom: 2 });
		expect(measured.scaleFor(box, 7)).toBe(2);

		// The operation list is the document's strokes, not the page's.
		const strokes: readonly InkStroke[] = [];
		const asked = vi.fn(() => strokes);
		expect(bareController({ allStrokes: asked }).opList()).toBe(strokes);
		expect(asked).toHaveBeenCalledTimes(1);

		// A scroller-relative sample becomes a content point by the scroll offset alone.
		const scroller = { scrollLeft: 5, scrollTop: 30 } as HTMLElement;
		expect(bareController().toContent({ x: 10, y: 20 } as PenSample, scroller)).toEqual({ x: 15, y: 50 });
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		expectInstalled(PdfInkController.prototype);
	});

	it("load with the controller imported first in a fresh module graph, and the install is the same", async () => {
		vi.resetModules();
		const controller = await import("./PdfInkController");
		const moved = await import("./PdfInkPenPath");
		expect(typeof moved.installPdfInkPenPath).toBe("function");
		expect(controller.PdfInkController).not.toBe(PdfInkController);
		expectInstalled(controller.PdfInkController.prototype);
	});

	it("each moved name is declared once in the pen path file and not in the class", () => {
		const classStart = controllerSrc.indexOf("export class PdfInkController {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = controllerSrc.slice(classStart, controllerSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = fileSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: PdfInkController\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in PdfInkPenPath.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the controller installs once, after the class closing brace", () => {
		const call = "installPdfInkPenPath(PdfInkController.prototype);";
		expect(controllerSrc.split(call).length - 1).toBe(1);
		const classStart = controllerSrc.indexOf("export class PdfInkController {");
		const classEnd = controllerSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(controllerSrc.indexOf(call)).toBeGreaterThan(classEnd);
	});

	it("the pen path file takes exactly the listed names from the controller file", () => {
		const imports = [...fileSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/PdfInkController";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_CONTROLLER].sort());
	});
});
