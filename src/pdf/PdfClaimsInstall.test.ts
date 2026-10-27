/**
 * The PDF claim methods live in pdf/PdfClaims.ts and are installed on
 * HandwritingPlugin.prototype when main.ts loads. Two things a type check
 * cannot see are held here.
 *
 * LOAD ORDER. main.ts imports the install function; PdfClaims.ts imports only
 * types from main, so there is no cycle. This file imports the claims file
 * first, and one cell loads main first in a fresh module graph, so a value
 * import added back from main fails here, in either order, at load and not on
 * a device.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the module augmentation declares it, and would only
 * fail when that PDF path ran.
 */
import { describe, expect, it, vi } from "vitest";

import { installPdfClaims } from "./PdfClaims";
import { HandwritingPlugin } from "../main";

const MOVED = [
	"syncPdfControllers",
	"releasePdfId",
	"schedulePdfModified",
	"onPdfModified",
	"resolvePdfId",
	"pdfHeadSource",
	"movePdfClaimOnRename",
	"pdfIdForPath",
	"pdfInkSnapshot",
	"pdfControllerWithSelection",
	"pdfDeleteContext",
	"attachPdfPendingDeletes",
] as const;

/** The fields pdfIdForPath reads, on a plugin built without its constructor. */
type BarePlugin = {
	pdfFiles: Map<object, string>;
	pdfIds: Map<object, string>;
	pdfIdForPath(path: string): string | null;
};

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

describe("PDF claim methods on the plugin prototype", () => {
	it("load with the claims file imported first, and a moved method runs on a bare plugin", () => {
		expect(typeof installPdfClaims).toBe("function");
		const plugin = Object.create(HandwritingPlugin.prototype) as BarePlugin;
		const pane = {};
		const hashing = {};
		plugin.pdfFiles = new Map([
			[pane, "Docs/Paper.pdf"],
			[hashing, "Docs/Other.pdf"],
		]);
		plugin.pdfIds = new Map([[pane, "pdf-0123456789abcdef"]]);
		expect(plugin.pdfIdForPath("Docs/Paper.pdf")).toBe("pdf-0123456789abcdef");
		expect(plugin.pdfIdForPath("Docs/Other.pdf")).toBeNull();
		expect(plugin.pdfIdForPath("Docs/Closed.pdf")).toBeNull();
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		expectInstalled(HandwritingPlugin.prototype);
	});

	it("load with main imported first in a fresh module graph, and the install is the same", async () => {
		vi.resetModules();
		const main = await import("../main");
		const moved = await import("./PdfClaims");
		expect(typeof moved.installPdfClaims).toBe("function");
		expect(main.HandwritingPlugin).not.toBe(HandwritingPlugin);
		expectInstalled(main.HandwritingPlugin.prototype);
	});
});
