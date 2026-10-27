/**
 * The pdf surface's pen up and op emit - the pen-up commit, the wet dressing,
 * the op door and the undo ring, the live persist, the history step, the
 * viewer probe, the overlay drop and the throttled sync - live in
 * PdfInkCommit.ts and are installed on PdfInkController.prototype when
 * PdfInkController.ts loads. Four things a type check cannot see are held
 * here, as the install tests of the other split files hold them for theirs.
 *
 * LOAD ORDER. PdfInkController.ts imports the install function, and the commit
 * file imports values back, so the two modules form a cycle. Every other test
 * imports PdfInkController.ts first. This file imports the commit file first,
 * and one cell loads the controller first in a fresh module graph, so a cycle
 * that only works in one order fails here, at load, in either.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it; a pen-up or an undo would
 * then throw instead of committing the stroke.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * commit file declares each once, so a half-finished move cannot pass with the
 * old copy still shadowing the new one.
 *
 * ONE DOOR. The commit file names nothing of the controller file beyond the
 * list below.
 */
import { describe, expect, it, vi } from "vitest";

import { installPdfInkCommit } from "./PdfInkCommit";
import { PdfInkController, SYNC_MIN_GAP_MS } from "./PdfInkController";
import controllerRaw from "./PdfInkController.ts?raw";
import fileRaw from "./PdfInkCommit.ts?raw";
import type { InkOp } from "../inline/InkHistory";

const MOVED = [
	"penUp",
	"dressWet",
	"undressWet",
	"addFinalPoint",
	"emitOp",
	"recordOp",
	"apply",
	"persistLive",
	"refreshPage",
	"historyStep",
	"emit",
	"probe",
	"isOwnMutation",
	"invalidateProbe",
	"dropOverlays",
	"scheduleThrottled",
	"schedule",
] as const;

/** Every name the commit file takes from the controller file, and nothing else. */
const FROM_CONTROLLER = [
	"Attached",
	"INK_OVER_CLASS",
	"OWN_CLASSES",
	"OWN_TOOLBAR_SELECTOR",
	"OpMode",
	"PROBE_MAX_AGE_MS",
	"PdfInkController",
	"PenFrame",
	"SYNC_MIN_GAP_MS",
	"removedByHistory",
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

const op = { type: "add", path: "stroke-1" } as unknown as InkOp;

describe("pen up and op emit methods on the pdf controller prototype", () => {
	it("load with the commit file imported first, and moved methods run on a bare controller", () => {
		expect(typeof installPdfInkCommit).toBe("function");

		// The one door: refused while the sources are synthetic, open otherwise.
		const onOp = vi.fn();
		expect(bareController({ syntheticSources: () => true, onOp }).emitOp(op)).toBe(false);
		expect(onOp).not.toHaveBeenCalled();
		expect(bareController({ syntheticSources: () => false, onOp }).emitOp(op, "live")).toBe(true);
		expect(onOp).toHaveBeenCalledWith(op, "live");

		// The live persist writes once, and only when a live op ran and the document has an id.
		const persist = vi.fn();
		const dirty = bareController({ liveDirty: true, documentId: () => "doc-1", persist });
		dirty.persistLive();
		expect(dirty.liveDirty).toBe(false);
		expect(persist).toHaveBeenCalledTimes(1);
		expect(persist).toHaveBeenCalledWith("doc-1");
		dirty.persistLive();
		expect(persist).toHaveBeenCalledTimes(1);
		const unidentified = bareController({ liveDirty: true, documentId: () => null, persist });
		unidentified.persistLive();
		expect(unidentified.liveDirty).toBe(false);
		expect(persist).toHaveBeenCalledTimes(1);

		// A sync is asked for once: not before mount, and not while one is queued.
		const requestAnimationFrame = vi.fn();
		const win = { requestAnimationFrame } as unknown as Window;
		bareController({ win, mounted: false, syncQueued: false }).schedule();
		bareController({ win, mounted: true, syncQueued: true }).schedule();
		expect(requestAnimationFrame).not.toHaveBeenCalled();
		const sync = vi.fn();
		const ready = bareController({ win, mounted: true, syncQueued: false, sync });
		ready.schedule();
		ready.schedule();
		expect(ready.syncQueued).toBe(true);
		expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
		(requestAnimationFrame.mock.calls[0]![0] as () => void)();
		expect(ready.syncQueued).toBe(false);
		expect(sync).toHaveBeenCalledTimes(1);

		// Inside the floor between syncs the sync waits for one trailing call; at the floor it runs now.
		const schedule = vi.fn();
		const setTimeout = vi.fn(() => 7);
		const throttleWin = { setTimeout } as unknown as Window;
		const settled = bareController({ win: throttleWin, lastSyncAt: 0, trailingSync: null, schedule });
		settled.scheduleThrottled();
		expect(schedule).toHaveBeenCalledTimes(1);
		const busy = bareController({ win: throttleWin, lastSyncAt: Date.now(), trailingSync: null, schedule });
		busy.scheduleThrottled();
		expect(schedule).toHaveBeenCalledTimes(1);
		expect(setTimeout).toHaveBeenCalledTimes(1);
		expect(busy.trailingSync).toBe(7);
		expect((setTimeout.mock.calls[0] as unknown as [unknown, number])[1]).toBeLessThanOrEqual(SYNC_MIN_GAP_MS);
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		expectInstalled(PdfInkController.prototype);
	});

	it("load with the controller imported first in a fresh module graph, and the install is the same", async () => {
		vi.resetModules();
		const controller = await import("./PdfInkController");
		const moved = await import("./PdfInkCommit");
		expect(typeof moved.installPdfInkCommit).toBe("function");
		expect(controller.PdfInkController).not.toBe(PdfInkController);
		expectInstalled(controller.PdfInkController.prototype);
	});

	it("each moved name is declared once in the commit file and not in the class", () => {
		const classStart = controllerSrc.indexOf("export class PdfInkController {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = controllerSrc.slice(classStart, controllerSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = fileSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: PdfInkController\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in PdfInkCommit.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the controller installs once, after the class closing brace", () => {
		const call = "installPdfInkCommit(PdfInkController.prototype);";
		expect(controllerSrc.split(call).length - 1).toBe(1);
		const classStart = controllerSrc.indexOf("export class PdfInkController {");
		const classEnd = controllerSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(controllerSrc.indexOf(call)).toBeGreaterThan(classEnd);
	});

	it("the commit file takes exactly the listed names from the controller file", () => {
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
