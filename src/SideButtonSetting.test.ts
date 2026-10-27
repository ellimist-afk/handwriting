/** Device setting integration. Executes only the actual local-store boot seam and row, not full plugin startup. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Platform } from "obsidian";
import HandwritingPlugin, { HandwritingSettingTab } from "./main";
import {
	AIR_SWITCH_KEY, airSwitchEnabled, penContactIntent, resetTipModeForTest, restoreSideButtonErases,
	setSideButtonStore, sideButtonErasesEnabled, SIDE_BUTTON_ERASES_KEY,
} from "./inline/TipMode";

const mainSource = readFileSync(fileURLToPath(new URL("./main.ts", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const pluginSettingsSource = readFileSync(fileURLToPath(new URL("./settings/PluginSettings.ts", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const onloadSource = readFileSync(fileURLToPath(new URL("./PluginOnload.ts", import.meta.url)), "utf8").replace(/\r\n/g, "\n");

function bootPolicy(android: boolean, local: Map<string, unknown>): void {
	// Preserve the actual registration/restore order and platform/store expressions.
	// Unrelated plugin startup needs an Obsidian host and is outside this unit seam.
	// The restore moved with loadSettings to settings/PluginSettings.ts. main.ts is read first, so the order
	// stays the store registration, then the restore. The registration moved with the device phase to
	// PluginOnload.ts, read after main.ts and before the settings.
	const BOOT = /setSideButtonStore\(\{[\s\S]*?\n\t\t\}\);|restoreSideButtonErases\(\);/g;
	const statements = [...(mainSource.match(BOOT) ?? []), ...(onloadSource.match(BOOT) ?? []), ...(pluginSettingsSource.match(BOOT) ?? [])];
	expect(statements, "one store registration and one restore in onload").toHaveLength(2);
	const run = new Function("setSideButtonStore", "restoreSideButtonErases", "Platform", statements.join("\n").replace(/ as unknown/g, ""));
	run.call({ app: {
		loadLocalStorage: (key: string) => local.get(key) ?? null,
		saveLocalStorage: (key: string, value: string) => local.set(key, value),
	} }, setSideButtonStore, restoreSideButtonErases, { isAndroidApp: android });
}

type Row = { name?: string; desc?: string; items?: Row[]; control?: unknown; render?: (setting: unknown) => void | Promise<void> };
function settingRow() {
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.manifest = { version: "1.4.23" };
	plugin.settings = { booxMode: false, extendCanvasWhileScrolling: false };
	plugin.app = { commands: { removeCommand: () => {} } };
	plugin.saveData = vi.fn();
	plugin.persistSettings = vi.fn();
	const tab = Object.create(HandwritingSettingTab.prototype) as { plugin: unknown; getSettingDefinitions(): Row[] };
	tab.plugin = plugin;
	const flatten = (rows: Row[]): Row[] => rows.flatMap(row => row.items ? flatten(row.items) : [row]);
	const rows = flatten(tab.getSettingDefinitions()).filter(row => row.name === "Pen side button");
	expect(rows).toHaveLength(1);
	return { row: rows[0]!, plugin };
}

/** The Android row: one on/off switch, no dropdown. */
async function paintToggle(row: Row) {
	let value: boolean | undefined;
	let tooltip = "";
	let change: ((next: boolean) => void) | undefined;
	let dropdowns = 0;
	const toggle = {
		setValue(next: boolean) { value = next; return this; },
		setTooltip(text: string) { tooltip = text; return this; },
		onChange(callback: (next: boolean) => void) { change = callback; return this; },
	};
	expect(row.render).toBeTypeOf("function");
	await row.render!({
		addToggle: (build: (control: typeof toggle) => void) => build(toggle),
		addDropdown: () => { dropdowns++; },
	});
	expect(change).toBeTypeOf("function");
	return { value, tooltip, dropdowns, change: (next: boolean) => change!(next) };
}

async function paintRow(row: Row) {
	const options: Record<string, string> = {};
	let value = "";
	let change: ((next: string) => void) | undefined;
	const dropdown = {
		addOption(key: string, label: string) { options[key] = label; return this; },
		setValue(next: string) { value = next; return this; },
		onChange(callback: (next: string) => void) { change = callback; return this; },
	};
	expect(row.render).toBeTypeOf("function");
	await row.render!({ addDropdown: (build: (control: typeof dropdown) => void) => build(dropdown) });
	expect(change).toBeTypeOf("function");
	return { options, value, change: (next: string) => change!(next) };
}

describe("device-local Pen side button setting", () => {
	const wasAndroid = Platform.isAndroidApp;
	beforeEach(resetTipModeForTest);
	afterEach(() => {
		Platform.isAndroidApp = wasAndroid;
		resetTipModeForTest();
	});

	it.each([true, false])("platform default with no stored value, Android=%s", async android => {
		bootPolicy(android, new Map());
		expect(sideButtonErasesEnabled(), "Android default requires registered platform store").toBe(android);
		expect(penContactIntent(3, 0, "nib")).toBe(android ? "erase" : "lasso");
		const { row } = settingRow();
		const rendered = await paintRow(row);
		expect(rendered.value).toBe(android ? "erase" : "lasso");
		expect(rendered.options).toEqual({ lasso: "Lasso select", erase: "Hold to erase" });
		expect(row.desc).toContain("mouse right button");
	});

	it.each([true, false])("row flips next contact and survives reload without syncing, Android=%s", async android => {
		const local = new Map<string, unknown>();
		bootPolicy(android, local);
		const { row, plugin } = settingRow();
		const beforeSettings = structuredClone(plugin.settings);
		const rendered = await paintRow(row);
		for (const choice of ["erase", "lasso"] as const) {
			rendered.change(choice);
			expect(penContactIntent(3, 0, "nib"), "next contact follows row immediately").toBe(choice);
			expect(penContactIntent(1, 0, "lasso"), "toolbar lasso remains available").toBe("lasso");
			expect(local.get(SIDE_BUTTON_ERASES_KEY)).toBe(String(choice === "erase"));
			resetTipModeForTest();
			bootPolicy(android, local);
			expect(penContactIntent(3, 0, "nib"), "same-device reload keeps choice").toBe(choice);
		}
		expect(row.control, "device choice must bypass synced settings controls").toBeUndefined();
		expect(plugin.settings, "no synced key").toEqual(beforeSettings);
		expect(plugin.saveData, "no data.json write").not.toHaveBeenCalled();
		expect(plugin.persistSettings, "no synced settings save").not.toHaveBeenCalled();
		resetTipModeForTest();
		bootPolicy(true, new Map());
		expect(sideButtonErasesEnabled(), "another device keeps its own default").toBe(true);
	});

	it.each([true, false, "true", "false"])("accepts local store JSON/string value %s", stored => {
		bootPolicy(false, new Map([[SIDE_BUTTON_ERASES_KEY, stored]]));
		expect(sideButtonErasesEnabled()).toBe(stored === true || stored === "true");
	});

	it("Android: the row is one on/off switch, on by default, with the hover text", async () => {
		Platform.isAndroidApp = true;
		bootPolicy(true, new Map());
		expect(airSwitchEnabled(), "default on").toBe(true);
		const { row } = settingRow();
		expect(row.name).toBe("Pen side button");
		expect(row.desc).toBe(
			"Click while hovering over the screen switches pen and eraser. Android takes a pen touch made with the button held for text " +
			"selection, so the button only works while the pen hovers. Click it once in the air to switch pen and " +
			"eraser; click again to switch back. Needs a pen that hovers (S Pen, Wacom EMR). Remembered on this device.",
		);
		const rendered = await paintToggle(row);
		expect(rendered.value).toBe(true);
		expect(rendered.tooltip).toBe("Click while hovering over the screen switches pen and eraser");
		expect(rendered.dropdowns, "no lasso or hold-to-erase choice on Android").toBe(0);
	});

	it("Android: turning the switch off is kept on this device only and survives reload", async () => {
		Platform.isAndroidApp = true;
		const local = new Map<string, unknown>();
		bootPolicy(true, local);
		const { row, plugin } = settingRow();
		const beforeSettings = structuredClone(plugin.settings);
		const rendered = await paintToggle(row);
		rendered.change(false);
		expect(airSwitchEnabled()).toBe(false);
		expect(local.get(AIR_SWITCH_KEY)).toBe("false");
		resetTipModeForTest();
		bootPolicy(true, local);
		expect(airSwitchEnabled(), "same-device reload keeps off").toBe(false);
		expect((await paintToggle(settingRow().row)).value).toBe(false);
		rendered.change(true);
		expect(local.get(AIR_SWITCH_KEY)).toBe("true");
		expect(plugin.settings, "no synced key").toEqual(beforeSettings);
		expect(plugin.saveData, "no data.json write").not.toHaveBeenCalled();
		expect(plugin.persistSettings, "no synced settings save").not.toHaveBeenCalled();
		resetTipModeForTest();
		bootPolicy(true, new Map());
		expect(airSwitchEnabled(), "another device keeps its own default").toBe(true);
	});

	it.each([false, "false"])("Android: a stored off (%s) restores off", stored => {
		bootPolicy(true, new Map([[AIR_SWITCH_KEY, stored]]));
		expect(airSwitchEnabled()).toBe(false);
	});

	it("not Android: the row is the same dropdown, and no switch is drawn", async () => {
		Platform.isAndroidApp = false;
		bootPolicy(false, new Map());
		const { row } = settingRow();
		expect(row.desc).toContain("mouse right button");
		const rendered = await paintRow(row);
		expect(rendered.options).toEqual({ lasso: "Lasso select", erase: "Hold to erase" });
	});

	it("not Android: the row text is unchanged, word for word", () => {
		Platform.isAndroidApp = false;
		bootPolicy(false, new Map());
		const { row } = settingRow();
		expect(row.desc).toBe(
			"Choose what a held pen side button does on contact. The mouse right button follows this choice. " +
			"Remembered on this device; lasso stays on the toolbar.",
		);
	});
});
