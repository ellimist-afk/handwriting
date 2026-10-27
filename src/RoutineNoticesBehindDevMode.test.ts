/**
 * Routine success toasts go behind the developer switch; everything that
 * carries a failure, a no-op explanation, an undo or a recovery path does
 * not (alan, 2026-09-09: "just hide it behind dev mode").
 *
 * These drive the REAL methods off `HandwritingPlugin.prototype` rather than
 * a transcription of them, so a gate that is deleted or inverted in main.ts
 * reds these cases. The `Notice` recorder is the seam the surrounding suite
 * already uses (`ActiveInkSurfaceOwnership.test.ts`).
 *
 * THE CONTROL THAT MAKES THE SUPPRESSION CASES MEAN ANYTHING: every "hidden"
 * assertion is paired with the same call under `setRoutineNoticesVisible(true)`
 * producing the exact string. Without that pair, a method that simply threw
 * before reaching its notice would report a clean pass.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => ({ said: [] as string[] }));

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			constructor(message: string) {
				notices.said.push(message);
			}
			hide(): void {}
			setMessage(): void {}
		},
	};
});

import HandwritingPlugin from "./main";
import { routineNoticesVisible, setRoutineNoticesVisible } from "./diag/RoutineNotices";

/** A plugin whose persistence is inert: these cases are about the toast. */
function pluginStub(): Record<string, unknown> {
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.settings = {
		inkColors: {} as Record<string, string>,
		inkSizes: {} as Record<string, number>,
		eraserRadiusPx: 12,
	};
	plugin.persistSettings = (): Promise<void> => Promise.resolve();
	return plugin;
}

describe("routine toasts are hidden unless the developer switch was on at load", () => {
	beforeEach(() => {
		notices.said = [];
		setRoutineNoticesVisible(false);
	});

	it("defaults to hidden, so an ordinary user gets no routine toast", () => {
		expect(routineNoticesVisible()).toBe(false);
	});

	it("says the colour only with the switch on", async () => {
		const plugin = pluginStub();
		const setInkColor = plugin.setInkColor as (t: string, h: string, n: string) => Promise<void>;

		await setInkColor.call(plugin, "pen", "#112233", "blue");
		expect(notices.said).toEqual([]);

		setRoutineNoticesVisible(true);
		await setInkColor.call(plugin, "pen", "#112233", "blue");
		expect(notices.said).toEqual(["Handwriting: pen blue"]);
	});

	it("says the ink size only with the switch on", async () => {
		const plugin = pluginStub();
		// (mult, name) - the tool is module state, not an argument.
		const setInkSize = plugin.setInkSize as (m: number, n: string) => Promise<void>;

		await setInkSize.call(plugin, 1, "medium");
		expect(notices.said).toEqual([]);

		setRoutineNoticesVisible(true);
		await setInkSize.call(plugin, 1, "medium");
		expect(notices.said).toEqual(["Handwriting: pen size medium"]);
	});

	it("says the eraser size only with the switch on", async () => {
		const plugin = pluginStub();
		const setEraserSize = plugin.setEraserSize as (r: number, n: string) => Promise<void>;

		await setEraserSize.call(plugin, 12, "medium");
		expect(notices.said).toEqual([]);

		setRoutineNoticesVisible(true);
		await setEraserSize.call(plugin, 12, "medium");
		expect(notices.said).toEqual(["Handwriting: eraser medium"]);
	});
});

describe("the switch is a load-time snapshot, because its settings row promises a reload", () => {
	it("does not read the live setting - only the pushed value moves it", () => {
		setRoutineNoticesVisible(false);
		expect(routineNoticesVisible()).toBe(false);
		setRoutineNoticesVisible(true);
		expect(routineNoticesVisible()).toBe(true);
	});
});

describe("main.ts wiring, so the gate cannot be quietly unwired", () => {
	/**
	 * These read main.ts as text ON PURPOSE and only for facts no executed
	 * case above can reach: that the pen toggle's STATE CHANGE was left
	 * outside the gate, and that the switch is primed from `devDiagnostics`
	 * at load. Gating `penOnOff(...)` itself would stop the pen toggling at
	 * all with the switch off - silent, and not visible in a toast test.
	 */
	// The command registrations live in commands/RegisterCommands.ts, read here with main.ts.
	const MAIN = [
		import.meta.glob("./main.ts", { query: "?raw", import: "default", eager: true })["./main.ts"] as string,
		import.meta.glob("./commands/RegisterCommands.ts", { query: "?raw", import: "default", eager: true })[
			"./commands/RegisterCommands.ts"
		] as string,
	].join("\n");
	// The settings load moved out of main.ts, and the priming call with it.
	const SETTINGS = import.meta.glob("./settings/PluginSettings.ts", { query: "?raw", import: "default", eager: true })[
		"./settings/PluginSettings.ts"
	] as string;

	it("was actually read", () => {
		expect(MAIN.length).toBeGreaterThan(1000);
	});

	it("primes the switch from devDiagnostics at load", () => {
		expect(SETTINGS).toContain("setRoutineNoticesVisible(this.settings.devDiagnostics)");
	});

	it("never gates the pen toggle's own state change", () => {
		// The toggle must run unconditionally; only the notice is conditional.
		expect(MAIN).toContain("const on = penOnOff(penInkCommandHost);");
		expect(MAIN).toContain("const on = togglePenInput(penInkCommandHost);");
		expect(MAIN).not.toContain("if (routineNoticesVisible()) showPenToggleNotice(penToggleNoticeText(penOnOff(");
		expect(MAIN).not.toContain(
			"if (routineNoticesVisible()) showPenToggleNotice(penToggleNoticeText(togglePenInput("
		);
	});

	it("does not gate the session diagnostics switch instead of the setting", () => {
		// `diagnosticsEnabled()` is session-scoped and command-flipped; it is
		// NOT what Alan meant by dev mode, and it never primes from settings.
		expect(MAIN).not.toContain("if (diagnosticsEnabled()) new Notice(`Handwriting: ${tool}");
	});
});
