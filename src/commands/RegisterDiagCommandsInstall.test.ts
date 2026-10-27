/**
 * The diagnostics commands live in commands/RegisterDiagCommands.ts and are installed on
 * HandwritingPlugin.prototype when main.ts loads. registerCommands calls them once, at the end. Three things a
 * type check cannot see are held here.
 *
 * LOAD ORDER. main.ts imports the install function; RegisterDiagCommands.ts imports only types from main, so
 * there is no cycle. This file imports the diagnostics file first, and one cell loads main first in a fresh
 * module graph, so a value import added back from main fails here, in either order, at load and not on a device.
 *
 * THE INSTALL. registerDiagCommands must be an own property of the prototype with the descriptor a class method
 * has, and main.ts must install it once, after the install of registerCommands. Left out of the install it still
 * type-checks, because the module augmentation declares it, and onload would only fail when it reached the call.
 *
 * THE PHASE. Run on a bare plugin, it registers the three commands that are always there, and the rest only
 * behind devDiagnostics. The whole list, in order, is pinned in RegisterCommandsCensus.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

import mainSource from "../main.ts?raw";
import { installRegisterDiagCommands } from "./RegisterDiagCommands";
import { HandwritingPlugin } from "../main";

type Deps = Parameters<HandwritingPlugin["registerDiagCommands"]>[0];

/** The plugin surface the diagnostics registrations read while they register, on a plugin built without its constructor. */
type BarePlugin = {
	addCommand(command: { id: string }): unknown;
	settings: { devDiagnostics: boolean };
	registerDiagCommands(deps: Deps): void;
};

function expectInstalled(proto: object): void {
	const d = Object.getOwnPropertyDescriptor(proto, "registerDiagCommands");
	expect(d, "registerDiagCommands is not on the prototype").toBeDefined();
	expect(typeof d!.value).toBe("function");
	expect({ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable }).toEqual({
		writable: true,
		enumerable: false,
		configurable: true,
	});
}

function registeredIds(devDiagnostics: boolean): string[] {
	const plugin = Object.create(HandwritingPlugin.prototype) as BarePlugin;
	const ids: string[] = [];
	plugin.addCommand = (command) => {
		ids.push(command.id);
		return command;
	};
	plugin.settings = { devDiagnostics };
	plugin.registerDiagCommands({
		TRACE_UPLOAD_URL: "",
		loadedBuild: (version) => ({ version, sourceCommit: "", sourceTree: "", dirtyStatus: "", verified: false }),
		platformOs: () => "",
	});
	return ids;
}

describe("diagnostics command registrations on the plugin prototype", () => {
	it("load with the diagnostics file imported first, and the registrations run on a bare plugin", () => {
		expect(typeof installRegisterDiagCommands).toBe("function");
		expect(registeredIds(false)).toEqual(["copy-inline-pen-trace", "copy-inline-pen-trace-json", "toggle-diagnostics"]);
		const all = registeredIds(true);
		expect(all).toHaveLength(20);
		expect(all[0]).toBe("copy-inline-pen-trace");
		expect(all[all.length - 1]).toBe("open-pen-diagnostics");
	});

	it("registerDiagCommands is a prototype method with a class method's descriptor", () => {
		expectInstalled(HandwritingPlugin.prototype);
	});

	it("main.ts installs it once, after registerCommands", () => {
		const text = mainSource.replace(/\r\n/g, "\n");
		const call = "installRegisterDiagCommands(HandwritingPlugin.prototype);";
		expect(text.split(call)).toHaveLength(2);
		expect(text.indexOf(call)).toBeGreaterThan(text.indexOf("installRegisterCommands(HandwritingPlugin.prototype);"));
	});

	it("load with main imported first in a fresh module graph, and the install is the same", async () => {
		vi.resetModules();
		const main = await import("../main");
		const moved = await import("./RegisterDiagCommands");
		expect(typeof moved.installRegisterDiagCommands).toBe("function");
		expect(main.HandwritingPlugin).not.toBe(HandwritingPlugin);
		expectInstalled(main.HandwritingPlugin.prototype);
	});
});
