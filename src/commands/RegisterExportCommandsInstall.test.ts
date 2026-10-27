/**
 * The export, PDF and selection commands live in commands/RegisterExportCommands.ts and are installed on
 * HandwritingPlugin.prototype when main.ts loads. registerCommands calls them once, in the middle of its
 * registrations, where they were. Three things a type check cannot see are held here.
 *
 * LOAD ORDER. main.ts imports the install function; RegisterExportCommands.ts imports only types from main, so
 * there is no cycle. This file imports the export file first, and one cell loads main first in a fresh module
 * graph, so a value import added back from main fails here, in either order, at load and not on a device.
 *
 * THE INSTALL. registerExportSelectionCommands must be an own property of the prototype with the descriptor a
 * class method has, and main.ts must install it once, after the install of registerCommands. Left out of the
 * install it still type-checks, because the module augmentation declares it, and onload would only fail when it
 * reached the call.
 *
 * THE PHASE. Run on a bare plugin, it registers its eleven commands, none of them behind a setting. The place of
 * the call in the whole list is pinned in RegisterCommandsCensus.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

import mainSource from "../main.ts?raw";
import { installRegisterExportCommands } from "./RegisterExportCommands";
import { HandwritingPlugin } from "../main";

/** The plugin surface the export registrations read while they register, on a plugin built without its constructor. */
type BarePlugin = {
	addCommand(command: { id: string }): unknown;
	registerExportSelectionCommands(): void;
};

function expectInstalled(proto: object): void {
	const d = Object.getOwnPropertyDescriptor(proto, "registerExportSelectionCommands");
	expect(d, "registerExportSelectionCommands is not on the prototype").toBeDefined();
	expect(typeof d!.value).toBe("function");
	expect({ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable }).toEqual({
		writable: true,
		enumerable: false,
		configurable: true,
	});
}

describe("export and selection command registrations on the plugin prototype", () => {
	it("load with the export file imported first, and the registrations run on a bare plugin", () => {
		expect(typeof installRegisterExportCommands).toBe("function");
		const plugin = Object.create(HandwritingPlugin.prototype) as BarePlugin;
		const ids: string[] = [];
		plugin.addCommand = (command) => {
			ids.push(command.id);
			return command;
		};
		plugin.registerExportSelectionCommands();
		expect(ids).toEqual([
			"export-ink-svg",
			"export-ink-pdf",
			"flatten-pdf-ink",
			"snip-pdf-selection",
			"delete-all-pdf-ink",
			"delete-selected-ink",
			"copy-selected-ink",
			"cut-selected-ink",
			"paste-ink",
			"delete-all-ink",
			"check-split-ink",
		]);
	});

	it("registerExportSelectionCommands is a prototype method with a class method's descriptor", () => {
		expectInstalled(HandwritingPlugin.prototype);
	});

	it("main.ts installs it once, after registerCommands", () => {
		const text = mainSource.replace(/\r\n/g, "\n");
		const call = "installRegisterExportCommands(HandwritingPlugin.prototype);";
		expect(text.split(call)).toHaveLength(2);
		expect(text.indexOf(call)).toBeGreaterThan(text.indexOf("installRegisterCommands(HandwritingPlugin.prototype);"));
	});

	it("load with main imported first in a fresh module graph, and the install is the same", async () => {
		vi.resetModules();
		const main = await import("../main");
		const moved = await import("./RegisterExportCommands");
		expect(typeof moved.installRegisterExportCommands).toBe("function");
		expect(main.HandwritingPlugin).not.toBe(HandwritingPlugin);
		expectInstalled(main.HandwritingPlugin.prototype);
	});
});
