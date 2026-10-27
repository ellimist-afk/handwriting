/**
 * The delete-all-ink methods live in ink/DeleteAllInk.ts and are installed on
 * HandwritingPlugin.prototype when main.ts loads. Two things a type check
 * cannot see are held here.
 *
 * LOAD ORDER. main.ts imports the install function; DeleteAllInk.ts imports
 * only types from main, so there is no cycle. This file imports the delete-all
 * file first, and one cell loads main first in a fresh module graph, so a
 * value import added back from main fails here, in either order, at load and
 * not on a device.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the module augmentation declares it, and would only
 * fail when that delete-all path ran.
 */
import { describe, expect, it, vi } from "vitest";

import { installDeleteAllInk } from "./DeleteAllInk";
import { HandwritingPlugin } from "../main";

const MOVED = [
	"deleteAllPdfInk",
	"deleteAllInkOrSaySo",
	"captureDeleteAllTarget",
	"sameDeleteAllTarget",
	"qualifiedDeleteAllPresence",
	"deleteAllInkNow",
	"confirmDeleteAllInk",
	"confirmedDeleteAllInk",
	"deleteAllInk",
	"noteNameFor",
	"notePathFor",
] as const;

/** The fields noteNameFor and notePathFor read, on a plugin built without its constructor. */
type BarePlugin = {
	pageIds: { owner(noteId: string): string | null };
	app: { vault: { getMarkdownFiles(): unknown[] } };
	pdfIds: Map<string, string>;
	pdfFiles: Map<string, string>;
	pdfPathById?: Map<string, string>;
	noteNameFor(pageId: string): string;
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

describe("delete-all-ink methods on the plugin prototype", () => {
	it("load with the delete-all file imported first, and a moved method runs on a bare plugin", () => {
		expect(typeof installDeleteAllInk).toBe("function");
		const plugin = Object.create(HandwritingPlugin.prototype) as BarePlugin;
		plugin.pageIds = { owner: () => "Notes/Known.md" };
		expect(plugin.noteNameFor("0123456789abcdef")).toBe("Notes/Known.md");
		plugin.pageIds = { owner: () => null };
		plugin.app = { vault: { getMarkdownFiles: () => [] } };
		plugin.pdfIds = new Map();
		plugin.pdfFiles = new Map();
		expect(plugin.noteNameFor("0123456789abcdef")).toBe("an unnamed page (01234567…)");
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		expectInstalled(HandwritingPlugin.prototype);
	});

	it("load with main imported first in a fresh module graph, and the install is the same", async () => {
		vi.resetModules();
		const main = await import("../main");
		const moved = await import("./DeleteAllInk");
		expect(typeof moved.installDeleteAllInk).toBe("function");
		expect(main.HandwritingPlugin).not.toBe(HandwritingPlugin);
		expectInstalled(main.HandwritingPlugin.prototype);
	});
});
