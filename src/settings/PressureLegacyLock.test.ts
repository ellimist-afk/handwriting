/**
 * The legacy pressure lock's wiring: what strokes saved without their own pressure setting draw under on this device.
 * It is taken in loadSettings, after the baseline and before the runtime is told, from the device store
 * (LegacyPressureLock.ts; PressureLockOnDevice.test.ts runs it end to end). Once it is taken, a toggle of the switch
 * sets new strokes only and redraws nothing; until then unmarked ink follows the switch and a toggle redraws.
 */
import { describe, expect, it } from "vitest";
import HandwritingPlugin from "../main";
import tabSource from "./HandwritingSettingTab.ts?raw";
import settingsSource from "./PluginSettings.ts?raw";
import diagSource from "../commands/RegisterDiagCommands.ts?raw";

type Settings = Record<string, unknown>;
type Bare = {
	settings: Settings;
	legacyInkPressure?: boolean | null;
	settingsFrom(r: unknown): Settings;
	inkShapingKey(): string;
};

function launched(raw: unknown, lock: boolean | null): Bare {
	const plugin = Object.create(HandwritingPlugin.prototype) as Bare;
	plugin.settings = plugin.settingsFrom(raw);
	plugin.legacyInkPressure = lock;
	return plugin;
}

const lf = (s: string): string => s.replace(/\r\n/g, "\n");

describe("loadSettings takes the lock from the device store", () => {
	it("after the baseline is taken and before the runtime is told", () => {
		const src = lf(settingsSource);
		const load = src.slice(src.indexOf("async function loadSettings"), src.indexOf("function settingsFrom"));
		const baseline = load.indexOf("this.settingsBaseline = this.settingsSnapshot(this.settings);");
		const lock = load.indexOf("this.legacyInkPressure = takeLegacyPressureLock(");
		const runtime = load.indexOf("this.applyRuntimeSettings();");
		expect(baseline, "premise: baseline line found").toBeGreaterThan(0);
		expect(runtime, "premise: runtime line found").toBeGreaterThan(baseline);
		expect(lock).toBeGreaterThan(baseline);
		expect(lock).toBeLessThan(runtime);
	});

	it("settingsFrom does not read a lock out of data.json", () => {
		expect(launched({ pressureSensitivity: true, legacyInkPressure: false }, null).settings.pressureSensitivity).toBe(true);
		const src = lf(settingsSource);
		const from = src.slice(src.indexOf("function settingsFrom"), src.indexOf("function settingsFileIsBlank"));
		expect(from, "premise: settingsFrom found").toContain("pressureChoice: pressureChoiceFrom(raw),");
		expect(from).not.toContain("legacyInkPressure");
	});

	it("the runtime is told the lock with the switch", () => {
		const src = lf(settingsSource);
		const apply = src.slice(src.indexOf("function applyRuntimeSettings"));
		const head = apply.slice(0, apply.indexOf("\n\t}\n"));
		expect(head).toContain("setPressureSensitivity(this.settings.pressureSensitivity);");
		expect(head).toContain("setLegacyInkPressure(this.legacyInkPressure ?? null);");
	});
});

describe("the redraw key", () => {
	it("once locked, ignores the switch and follows the lock", () => {
		const p = launched({ pressureSensitivity: true }, true);
		const before = p.inkShapingKey();
		p.settings.pressureSensitivity = false;
		expect(p.inkShapingKey(), "a flip of the switch").toBe(before);
		p.legacyInkPressure = false;
		expect(p.inkShapingKey(), "a change of the lock").not.toBe(before);
	});

	it("with no lock yet, follows the switch, which unmarked ink then draws under", () => {
		const p = launched({ pressureSensitivity: true }, null);
		const before = p.inkShapingKey();
		p.settings.pressureSensitivity = false;
		expect(p.inkShapingKey()).not.toBe(before);
	});
});

describe("the settings row", () => {
	it("hands the switch to the plugin and repaints no ink itself", () => {
		const source = lf(tabSource);
		const at = source.indexOf('case "pressureSensitivity":');
		expect(at, "premise: the row's case found").toBeGreaterThan(0);
		const block = source.slice(at, source.indexOf("break;", at));
		expect(block).toContain("this.plugin.setPressureSwitch(on);");
		expect(block).not.toContain("repaintAllInkOverlays");
		expect(block).not.toContain("embedInkRepaintAll");
	});

	it("says it sets new strokes only", () => {
		const source = lf(tabSource);
		const at = source.indexOf('name: "Pressure sensitivity"');
		expect(at, "premise: the row found").toBeGreaterThan(0);
		const desc = source.slice(at, source.indexOf("\n", source.indexOf("desc:", at)));
		expect(desc).toMatch(/new strokes/i);
		expect(desc).toMatch(/keeps its look/i);
	});
});

describe("the diagnostics report", () => {
	it("carries the lock beside the switch", () => {
		const src = lf(diagSource);
		const at = src.indexOf("pressureSensitivity: this.settings.pressureSensitivity,");
		expect(at, "premise: the switch line found").toBeGreaterThan(0);
		expect(src.slice(at, at + 200)).toContain("legacyInkPressure: this.legacyInkPressure ?? null,");
	});
});
