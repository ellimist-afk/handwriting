/**
 * The command registrations live in commands/RegisterCommands.ts and are
 * installed on HandwritingPlugin.prototype when main.ts loads. Two things a
 * type check cannot see are held here.
 *
 * LOAD ORDER. main.ts imports the install function; RegisterCommands.ts
 * imports only types from main, so there is no cycle. This file imports the
 * commands file first, and one cell loads main first in a fresh module graph,
 * so a value import added back from main fails here, in either order, at load
 * and not on a device.
 *
 * THE INSTALL. registerCommands must be an own property of the prototype with
 * the descriptor a class method has. Left out of the install it still
 * type-checks, because the module augmentation declares it, and onload would
 * only fail when it reached the call.
 */
import { describe, expect, it, vi } from "vitest";

import { installRegisterCommands } from "./RegisterCommands";
import { HandwritingPlugin } from "../main";

type Deps = Parameters<HandwritingPlugin["registerCommands"]>[0];

/** The plugin surface the registrations read while they register, on a plugin built without its constructor. */
type BarePlugin = {
	addCommand(command: { id: string }): unknown;
	settings: { colorSizeCommands: boolean; devDiagnostics: boolean };
	gatedCommandDefs: Map<string, unknown>;
	registerCommands(deps: Deps): void;
};

function expectInstalled(proto: object): void {
	const d = Object.getOwnPropertyDescriptor(proto, "registerCommands");
	expect(d, "registerCommands is not on the prototype").toBeDefined();
	expect(typeof d!.value).toBe("function");
	expect({ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable }).toEqual({
		writable: true,
		enumerable: false,
		configurable: true,
	});
}

describe("command registrations on the plugin prototype", () => {
	it("load with the commands file imported first, and the registrations run on a bare plugin", () => {
		expect(typeof installRegisterCommands).toBe("function");
		const plugin = Object.create(HandwritingPlugin.prototype) as BarePlugin;
		const ids: string[] = [];
		plugin.addCommand = (command) => {
			ids.push(command.id);
			return command;
		};
		plugin.settings = { colorSizeCommands: false, devDiagnostics: false };
		plugin.gatedCommandDefs = new Map();
		const quiet = (): void => {};
		plugin.registerCommands({
			TRACE_UPLOAD_URL: "",
			loadedBuild: (version) => ({ version, sourceCommit: "", sourceTree: "", dirtyStatus: "", verified: false }),
			penInkCommandHost: {} as Deps["penInkCommandHost"],
			penToggleNoticeText: (on) => String(on),
			platformOs: () => "",
			showPenToggleNotice: quiet,
			showEraserToggleNotice: quiet,
			showLassoToggleNotice: quiet,
			showSpaceToggleNotice: quiet,
			showPanToggleNotice: quiet,
			showMouseInkToggleNotice: quiet,
		});
		expect(ids[0]).toBe("inline-tool-pen");
		expect(ids).toContain("delete-all-ink");
		expect(ids).not.toContain("inline-tool-eraser");
		expect(plugin.gatedCommandDefs.has("inline-tool-eraser")).toBe(true);
		expect(ids).not.toContain("open-pen-diagnostics");
	});

	it("registerCommands is a prototype method with a class method's descriptor", () => {
		expectInstalled(HandwritingPlugin.prototype);
	});

	it("load with main imported first in a fresh module graph, and the install is the same", async () => {
		vi.resetModules();
		const main = await import("../main");
		const moved = await import("./RegisterCommands");
		expect(typeof moved.installRegisterCommands).toBe("function");
		expect(main.HandwritingPlugin).not.toBe(HandwritingPlugin);
		expectInstalled(main.HandwritingPlugin.prototype);
	});
});
