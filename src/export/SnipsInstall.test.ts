/**
 * The snip and flatten methods live in export/Snips.ts and are installed on
 * HandwritingPlugin.prototype when main.ts loads. Two things a type check
 * cannot see are held here.
 *
 * LOAD ORDER. main.ts imports the install function; Snips.ts imports only
 * types from main, so there is no cycle. This file imports the snips file
 * first, and one cell loads main first in a fresh module graph, so a value
 * import added back from main fails here, in either order, at load and not on
 * a device.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the module augmentation declares it, and would only
 * fail when that snip or export ran.
 */
import { describe, expect, it, vi } from "vitest";

import { installSnips } from "./Snips";
import { HandwritingPlugin } from "../main";

const MOVED = ["firstFreePath", "snipBacklink", "snipNote", "snipPdf", "flattenPdf"] as const;

/** The app surface snipBacklink reads, on a plugin built without its constructor. */
type BarePlugin = {
	app: { fileManager: { generateMarkdownLink(file: { path: string }, sourcePath: string, subpath?: string, alias?: string): string } };
	snipBacklink(file: { path: string }, subpath?: string, alias?: string): string;
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

describe("snip and flatten methods on the plugin prototype", () => {
	it("load with the snips file imported first, and a moved method runs on a bare plugin", () => {
		expect(typeof installSnips).toBe("function");
		const plugin = Object.create(HandwritingPlugin.prototype) as BarePlugin;
		const asked: unknown[][] = [];
		plugin.app = {
			fileManager: {
				generateMarkdownLink: (file, sourcePath, subpath, alias) => {
					asked.push([file.path, sourcePath, subpath, alias]);
					return `[[${file.path}${subpath ?? ""}|${alias ?? ""}]]`;
				},
			},
		};
		expect(plugin.snipBacklink({ path: "Papers/intro.pdf" }, "#page=5", "intro p.5")).toBe("[[Papers/intro.pdf#page=5|intro p.5]]");
		expect(asked).toEqual([["Papers/intro.pdf", "", "#page=5", "intro p.5"]]);
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		expectInstalled(HandwritingPlugin.prototype);
	});

	it("load with main imported first in a fresh module graph, and the install is the same", async () => {
		vi.resetModules();
		const main = await import("../main");
		const moved = await import("./Snips");
		expect(typeof moved.installSnips).toBe("function");
		expect(main.HandwritingPlugin).not.toBe(HandwritingPlugin);
		expectInstalled(main.HandwritingPlugin.prototype);
	});
});
