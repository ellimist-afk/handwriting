/**
 * Updating changes no ink. A vault whose data.json and notes were saved by 1.4.24 (no stroke carries its own pressure
 * setting) launches this build once with the switch on and once with it off. Every old stroke's ribbon, export ribbon,
 * SVG path and PDF ops are what 1.4.24 drew under that switch, after the first launch, after the switch is flipped
 * since, and after a second launch reads the data.json the first one saved.
 *
 * Runs the real loadSettings on a bare plugin with an in-memory device store for the lock, then hands the runtime the
 * two pressure values as applyRuntimeSettings does (PressureLegacyLock.test.ts pins those two lines). The strokes are the 1.4.22 fixture: 1.4.24 wrote the same
 * stroke shape and drew it under the switch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, Notice: class { constructor() {} } };
});

import HandwritingPlugin from "./main";
import frozen from "../test/fixtures/pressure-mark-1.4.22.json";
import { parsePage } from "./model/PageData";
import { ribbonOf } from "./ink/StrokeOutline";
import { strokePathData } from "./ink/SvgExport";
import { strokePdfOps } from "./ink/InkPdf";
import { setLegacyInkPressure, setPressureSensitivity } from "./ink/PenStyle";
import { setLegacyPressureStore } from "./settings/LegacyPressureLock";
import type { InkStroke } from "./ink/Stroke";

const proto = HandwritingPlugin.prototype as unknown as { loadSettings(this: unknown): Promise<void> };
type Plugin = { settings: { pressureSensitivity: boolean }; legacyInkPressure?: boolean | null; saved: Record<string, unknown> | null };

const device = new Map<string, string>();
setLegacyPressureStore({ load: (k) => device.get(k) ?? null, save: (k, v) => void device.set(k, v) });

/** Wait for the plugin's own settings write chain (persistSettings keeps it in settingsWriting) to finish, not a timer. */
async function settingsWritten(plugin: Record<string, unknown>): Promise<void> {
	while (plugin.settingsWriting) await (plugin.settingsWriting as Promise<void>);
}

function ensureDocument(): void {
	const g = globalThis as unknown as { document?: unknown };
	g.document ??= { body: { classList: { add: () => {}, toggle: () => {}, contains: () => false } } };
}

async function launched(raw: Record<string, unknown>): Promise<Plugin> {
	ensureDocument();
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.loadData = (): Promise<unknown> => Promise.resolve(raw);
	plugin.saved = null;
	plugin.saveData = (data: Record<string, unknown>): Promise<void> => {
		plugin.saved = { ...data };
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
	plugin.manifest = { version: "1.5.0" };
	plugin.freshInstall = false;
	await proto.loadSettings.call(plugin);
	await settingsWritten(plugin);
	const p = plugin as unknown as Plugin;
	setPressureSensitivity(p.settings.pressureSensitivity);
	setLegacyInkPressure(p.legacyInkPressure ?? null);
	return p;
}

function oldInk(): InkStroke[] {
	const parsed = parsePage(JSON.stringify({ schemaVersion: 1, pageId: "upgrade-1424", strokes: frozen.stored }), "upgrade-1424");
	expect(parsed.data.strokes.every((s) => s.pressureSensitivity === undefined), "premise: no old stroke carries a mark").toBe(true);
	return parsed.data.strokes;
}

/** What 1.4.24 drew for each old stroke under this switch value: the frozen cases. */
function as1424(on: boolean): unknown[] {
	return frozen.cases.filter((c) => c.pressureOn === on).map((c) => [c.id, c.ribbon, c.svg, c.pdf]);
}

/** What this build draws for the same strokes now, in the same order. */
function drawnNow(on: boolean): unknown[] {
	const byId = new Map(oldInk().map((s) => [s.id, s]));
	return frozen.cases.filter((c) => c.pressureOn === on).map((c) => {
		const s = byId.get(c.id)!;
		return [c.id, ribbonOf(s), strokePathData(s), strokePdfOps(s)];
	});
}

afterEach(() => {
	device.clear();
	setPressureSensitivity(true);
	setLegacyInkPressure(null);
});

describe("an update from 1.4.24 changes no old stroke", () => {
	for (const on of [true, false]) {
		it(`switch ${on ? "on" : "off"}: first launch, a flip after it, and a second launch all draw the old ink as 1.4.24 did`, async () => {
			const raw = { lastSeenVersion: "1.4.24", pressureSensitivity: on, pressureChoice: on };
			expect(as1424(on).length, "premise: the fixture has cases under this switch").toBeGreaterThan(0);
			const first = await launched(raw);
			expect(first.legacyInkPressure, "locked from the switch").toBe(on);
			expect(first.saved?.legacyInkPressure, "and not in data.json").toBeUndefined();
			expect(drawnNow(on), "after the first launch").toEqual(as1424(on));
			setPressureSensitivity(!on);
			expect(drawnNow(on), "after the switch is flipped").toEqual(as1424(on));
			const second = await launched({ ...raw, ...(first.saved ?? {}), pressureSensitivity: !on, pressureChoice: !on });
			expect(second.legacyInkPressure, "the second launch keeps the lock").toBe(on);
			expect(drawnNow(on), "after the second launch").toEqual(as1424(on));
		});
	}
});
