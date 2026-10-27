/**
 * NO PRESSURE CURVE VARIANT (Alan: "no settings bloat, we
 * either take the curve or not"). The flatter pressure curve trial is not taken:
 * its setting, its switch and its width-law branches are gone, and exp7 ink has
 * one law. What the trial shipped alongside it stays: the lift hold, no geometric
 * tip taper on pressure ink, and the uniform style that carries no pressure
 * profile (the gate every one of those keys on).
 *
 * The finger control that found the uniform-profile leak lives here now, without
 * the curve: a uniform style built from EXP7_PEN must draw the same with the
 * pre-1.4.20 tip taper planted on or off, committed and wet, because a uniform
 * style has no pressure profile for that gate to read. The same samples as a pen
 * stroke DO change under the plant.
 */

import { describe, expect, it } from "vitest";
import HandwritingPlugin, { HandwritingSettingTab } from "./main";
import mainSource from "./main.ts?raw";
import tabSource from "./settings/HandwritingSettingTab.ts?raw";
import settingsModelSource from "./settings/SettingsModel.ts?raw";
import pluginSettingsSource from "./settings/PluginSettings.ts?raw";
import * as InkShapeModule from "./ink/InkShape";
import { flattenStrokeShaped, IncrementalShaper, PEN_SHAPE, type ShapeParams } from "./ink/InkShape";
import * as PenStyleModule from "./ink/PenStyle";
import { EXP7_PEN, type PenStyle } from "./ink/PenStyle";
import { strokeWidthPolicy } from "./ink/StrokeWidth";
import { CAPTURE_NIB, quickLiftStroke } from "../test/pressureFeel";

const proto = HandwritingPlugin.prototype as unknown as {
	loadSettings(this: unknown): Promise<void>;
	persistSettings(this: unknown): Promise<void>;
};

function ensureDocument(): void {
	const g = globalThis as unknown as { document?: unknown };
	g.document ??= {
		body: { classList: { add: () => {}, toggle: () => {}, contains: () => false } },
	};
}

function fakePlugin(raw: unknown): { settings: Record<string, unknown>; saved: Record<string, unknown> | null } {
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.loadData = (): Promise<unknown> => Promise.resolve(raw);
	plugin.saved = null;
	plugin.saveData = (data: Record<string, unknown>): Promise<void> => {
		plugin.saved = data;
		return Promise.resolve();
	};
	plugin.settingsTimer = null;
	plugin.settingsDirty = false;
	plugin.settingsWriting = null;
	plugin.settingsWriteAgain = false;
	plugin.store = { useInkFolder: () => {}, load: () => null, schedule: () => {} };
	plugin.pdfStore = { attachHost: () => {} };
	plugin.app = { workspace: { onLayoutReady: () => {} } };
	plugin.applyPaperTo = (): void => {};
	plugin.applyBooxMode = (): void => {};
	return plugin as unknown as { settings: Record<string, unknown>; saved: Record<string, unknown> | null };
}

describe("the flatter pressure curve trial is gone", () => {
	it("leaves no switch in the pen style module and no settling constant in the shaper", () => {
		const pen = Object.keys(PenStyleModule);
		for (const name of ["setFlatterPressureCurve", "flatterPressureCurveEnabled", "exp7MinWidthFactor", "FLATTER_EXP7_MIN_WIDTH_FACTOR"]) {
			expect(pen, name).not.toContain(name);
		}
		expect(Object.keys(InkShapeModule)).not.toContain("TRIAL_PRESSURE_TAU_MS");
	});

	it("leaves no setting row, no setting key and no trace field in main.ts", async () => {
		ensureDocument();
		const plugin = fakePlugin({});
		await proto.loadSettings.call(plugin);
		(plugin as unknown as Record<string, unknown>).manifest = { version: "1.5.0" };
		const tab = Object.create(HandwritingSettingTab.prototype);
		tab.plugin = plugin;
		type Row = { name?: string; items?: Row[] };
		const flatten = (rows: Row[]): Row[] => rows.flatMap((r) => (r.items ? flatten(r.items) : [r]));
		const names = flatten(tab.getSettingDefinitions() as Row[]).map((r) => r.name ?? "");
		expect(names.filter((n) => /pressure curve/i.test(n))).toEqual([]);
		expect(plugin.settings).not.toHaveProperty("flatterPressureCurve");
		expect(mainSource).not.toContain("flatterPressureCurve");
		expect(mainSource).not.toContain("FlatterPressureCurve");
		expect(settingsModelSource).not.toContain("flatterPressureCurve");
		expect(settingsModelSource).not.toContain("FlatterPressureCurve");
		expect(pluginSettingsSource).not.toContain("flatterPressureCurve");
		expect(pluginSettingsSource).not.toContain("FlatterPressureCurve");
		expect(tabSource).not.toContain("flatterPressureCurve");
		expect(tabSource).not.toContain("FlatterPressureCurve");
	});

	it("carries a vault's stored trial value through untouched and gives it no effect", async () => {
		ensureDocument();
		const plugin = fakePlugin({ flatterPressureCurve: true });
		await proto.loadSettings.call(plugin);
		await proto.persistSettings.call(plugin);
		expect(plugin.saved?.flatterPressureCurve, "an unknown key survives a load and a save").toBe(true);
		const style = strokeWidthPolicy({ ...EXP7_PEN, color: "#111111", baseWidth: CAPTURE_NIB }, undefined, "exp7").style;
		expect(style.minWidthFactor).toBe(EXP7_PEN.minWidthFactor);
	});
});

describe("a finger stroke's uniform style carries no pressure profile", () => {
	it("draws a uniform style built from EXP7_PEN the same with the pre-1.4.20 tip taper planted on or off, committed and wet", () => {
		const points = quickLiftStroke();
		const TIP_TAPER = { ...PEN_SHAPE, exp7TipTaper: true } as ShapeParams;
		const uniform = strokeWidthPolicy({ ...EXP7_PEN, color: "#111111", baseWidth: CAPTURE_NIB }, "uniform", "exp7").style;
		const pen = strokeWidthPolicy({ ...EXP7_PEN, color: "#111111", baseWidth: CAPTURE_NIB }, undefined, "exp7").style;
		const wet = (style: PenStyle, params: ShapeParams): number[] => {
			const shaper = new IncrementalShaper(params);
			shaper.reset(points[0], style);
			return [shaper.last(), ...points.slice(1).map((p) => shaper.push(style, p))];
		};
		expect(uniform.pressureProfile, "the uniform branch clears the profile").toBeUndefined();
		expect(flattenStrokeShaped(points, uniform, 2), "uniform committed, plant on vs off").toEqual(flattenStrokeShaped(points, uniform, 2, TIP_TAPER));
		expect(wet(uniform, PEN_SHAPE), "uniform wet, plant on vs off").toEqual(wet(uniform, TIP_TAPER));
		expect(flattenStrokeShaped(points, pen, 2), "the pen stroke is the live half: the plant must move it").not.toEqual(flattenStrokeShaped(points, pen, 2, TIP_TAPER));
	});
});
