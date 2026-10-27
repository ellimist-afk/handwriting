/**
 * The settings methods live in settings/PluginSettings.ts and are installed on
 * HandwritingPlugin.prototype when main.ts loads. Two things a type check
 * cannot see are held here.
 *
 * LOAD ORDER. main.ts imports the install function; PluginSettings.ts imports
 * only types from main, so there is no cycle. This file imports the settings
 * file first anyway, so a value import added back from main fails here, at
 * load, and not on a device.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the module augmentation declares it, and would only
 * fail when that settings path ran.
 */
import { describe, expect, it } from "vitest";

import { installPluginSettings } from "./PluginSettings";
import { HandwritingPlugin } from "../main";

const MOVED = [
	"inkFolderMoving",
	"changeInkFolder",
	"loadSettings",
	"settingsFrom",
	"settingsFileIsBlank",
	"settingsSnapshot",
	"applyRuntimeSettings",
	"onExternalSettingsChange",
	"inkShapingKey",
	"takeMergedSettings",
	"refreshSettingSurfaces",
	"mergeSettings",
	"applyBooxMode",
	"saveSettingsNow",
	"persistSettings",
	"flushSettings",
] as const;

describe("settings methods on the plugin prototype", () => {
	it("load with the settings file imported first, and a moved method runs on a bare plugin", () => {
		expect(typeof installPluginSettings).toBe("function");
		const plugin = Object.create(HandwritingPlugin.prototype) as HandwritingPlugin;
		plugin.inkFolderMoveInFlight = false;
		plugin.store = { movingFolder: true } as unknown as HandwritingPlugin["store"];
		expect(plugin.inkFolderMoving()).toBe(true);
		plugin.store = { movingFolder: false } as unknown as HandwritingPlugin["store"];
		expect(plugin.inkFolderMoving()).toBe(false);
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		for (const name of MOVED) {
			const d = Object.getOwnPropertyDescriptor(HandwritingPlugin.prototype, name);
			expect(d, `${name} is not on the prototype`).toBeDefined();
			expect(typeof d!.value, name).toBe("function");
			expect(
				{ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable },
				name
			).toEqual({ writable: true, enumerable: false, configurable: true });
		}
	});
});
