/**
 * Red-first. Issue #27: a vault
 * with pressure sensitivity saved OFF gets every old firm stroke redrawn under
 * the ON law, up to 3.22x wider, because loadSettings hardcodes
 * `pressureSensitivity: true` (main.ts :5215) instead of reading the stored
 * value back, as 1.4.19 did.
 *
 * Two assertions in one cell, per the ruling: the width law itself (already
 * correct - shapedHalfWidths just reads whatever setPressureSensitivity last
 * set), then the load wiring (currently wrong). Either failing fails the cell.
 */

import { describe, expect, it } from "vitest";
import HandwritingPlugin from "./main";
import { EXP7_PEN, setPressureSensitivity } from "./ink/PenStyle";
import { shapedHalfWidths } from "./ink/InkShape";
import type { InkPoint } from "./ink/Stroke";

// Harness as SettingsSimplified.test.ts: `Object.create` on the real plugin,
// loadSettings run for real, nothing restated there - this file owns its own
// copy so the two lanes (the red cell and the fix) touch no
// common file.
function ensureDocument(): void {
	const g = globalThis as unknown as { document?: unknown };
	g.document ??= {
		body: { classList: { add: () => {}, toggle: () => {}, contains: () => false } },
	};
}

type Plugin = { settings: Record<string, unknown> };

function fakePlugin(raw: unknown): Plugin {
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.loadData = (): Promise<unknown> => Promise.resolve(raw);
	plugin.saveData = (): Promise<void> => Promise.resolve();
	plugin.settingsTimer = null;
	plugin.settingsDirty = false;
	plugin.settingsWriting = null;
	plugin.settingsWriteAgain = false;
	plugin.store = { useInkFolder: () => {}, load: () => null, schedule: () => {} };
	plugin.pdfStore = { attachHost: () => {} };
	plugin.app = { workspace: { onLayoutReady: () => {} } };
	plugin.applyPaperTo = (): void => {};
	plugin.applyBooxMode = (): void => {};
	plugin.manifest = { version: "1.4.20" };
	return plugin as unknown as Plugin;
}

function sample(pressure: number): InkPoint[] {
	// One point: shapedHalfWidths reads pressure straight off it for index 0,
	// no velocity thinning (d=0) and no pressure-filter lag (i=0 skips the
	// filter update), so the half-width is widthForPressure(style, pressure)/2
	// exactly - no need to hand-simulate the filter to pin this.
	return [{ x: 0, y: 0, t: 0, pressure }];
}

describe("pressure-off survives a save/load round trip", () => {
	it("an exp7 stroke's firm samples redraw wider under ON than the OFF law that saved them, and a stored OFF must survive load", () => {
		// ---- the width law: samples above 0.7, OFF vs ON --------------------
		const firmSamples = [0.75, 1.0];
		const expectedOff = 2.188058154088379 / 2; // baseWidth(2.2) * pressureOffWidthFactor
		const expectedOn = [
			5.168545490797855 / 2, // p 0.75: 2.2 * (0.18 + 3.02 * 0.75^1.15)
			7.04 / 2, // p 1.0: 2.2 * (0.18 + 3.02 * 1^1.15) = 2.2 * 3.2
		];

		try {
			setPressureSensitivity(false);
			for (const p of firmSamples) {
				expect(shapedHalfWidths(sample(p), EXP7_PEN)[0], `off at p ${p}`).toBeCloseTo(
					expectedOff,
					12
				);
			}

			setPressureSensitivity(true);
			firmSamples.forEach((p, i) => {
				expect(shapedHalfWidths(sample(p), EXP7_PEN)[0], `on at p ${p}`).toBeCloseTo(
					expectedOn[i]!,
					12
				);
			});

			// A stroke saved with pressure off, redrawn with it forced on, comes
			// out wider at every one of these firm samples - the visible defect.
			firmSamples.forEach((p, i) => {
				expect(expectedOn[i]!).toBeGreaterThan(expectedOff);
			});
		} finally {
			setPressureSensitivity(true);
		}

		// ---- the load wiring: a stored false must survive loadSettings ------
		const proto = HandwritingPlugin.prototype as unknown as {
			loadSettings(this: unknown): Promise<void>;
		};
		ensureDocument();
		const plugin = fakePlugin({ pressureSensitivity: false });
		return proto.loadSettings.call(plugin).then(() => {
			// Red at 063795c8: main.ts :5215 hardcodes `pressureSensitivity: true`,
			// so this reads true regardless of what was stored.
			expect(plugin.settings.pressureSensitivity).toBe(false);
		});
	});
});
