/**
 * The legacy pressure lock lives on the device, not in data.json. Each device locks
 * from its own settings file at the first launch that reads one; sync carries nothing, so a fresh device or a file
 * without the key can never move another device's old ink. A fresh install or an empty file waits for the user's own
 * set, with no toast. A vault straight from 1.4.20 stays pending all session and locks at the next launch from the last
 * value set on this device. The pressure What's New line is in the 1.5.0 notes.
 *
 * Runs the real loadSettings, onExternalSettingsChange and settings-row path on a bare plugin, with an in-memory
 * device store standing in for Obsidian's loadLocalStorage / saveLocalStorage.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, Notice: class { constructor() {} } };
});

import HandwritingPlugin from "../main";
import { LEGACY_PRESSURE_KEY, setLegacyPressureStore } from "./LegacyPressureLock";
import { setLegacyInkPressure, setPressureSensitivity, unmarkedInkPressure } from "../ink/PenStyle";
import { decideWhatsNew } from "../update/WhatsNew";

type Plugin = {
	settings: Record<string, unknown>;
	legacyInkPressure: boolean | null | undefined;
	legacyPressureNoticeDue?: boolean;
	settingsReadFailed: boolean;
	saved: Record<string, unknown> | null;
	loadData(): Promise<unknown>;
	inkShapingKey(): string;
	onExternalSettingsChange(): Promise<void>;
	setPressureSwitch(on: boolean): void;
};

const proto = HandwritingPlugin.prototype as unknown as { loadSettings(this: unknown): Promise<void> };
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

/** data.json is there but empty: loadData answers undefined, as Obsidian's does for text that does not parse. */
const BLANK = Symbol("an empty settings file");
/** data.json is there and holds text that does not parse. */
const UNREADABLE = Symbol("a settings file that does not parse");

/** One launch of this build on the device, reading `raw` as data.json (null: no file; BLANK: an empty one; UNREADABLE). */
async function launched(raw: Record<string, unknown> | null | typeof BLANK | typeof UNREADABLE): Promise<Plugin> {
	ensureDocument();
	const blank = raw === BLANK;
	const unparsed = blank || raw === UNREADABLE;
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.loadData = (): Promise<unknown> => Promise.resolve(unparsed ? undefined : raw);
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
	plugin.app = { workspace: { onLayoutReady: () => {} }, vault: { adapter: { exists: () => Promise.resolve(false), list: () => Promise.resolve({ files: [], folders: [] }), read: () => Promise.resolve(blank ? "" : "{}") } } };
	plugin.applyPaperTo = (): void => {};
	plugin.applyPaper = (): void => {};
	plugin.applyBooxMode = (): void => {};
	plugin.applySlidesInk = (): void => {};
	plugin.refreshSettingSurfaces = (): void => {};
	plugin.saveSettingsNow = (): void => {};
	plugin.manifest = { version: "1.5.0", dir: "plugin-dir" };
	// An unparsed read is retried on window timers before the empty-file check; run them at once, for this launch only.
	const g = globalThis as unknown as { window?: unknown };
	const hadWindow = "window" in g;
	const priorWindow = g.window;
	if (unparsed) g.window = { setTimeout: (fn: () => void): number => (fn(), 0) };
	try {
		await proto.loadSettings.call(plugin);
		await settingsWritten(plugin);
	} finally {
		if (unparsed && hadWindow) g.window = priorWindow;
		else if (unparsed) delete g.window;
	}
	return plugin as unknown as Plugin;
}

afterEach(() => {
	device.clear();
	setPressureSensitivity(true);
	setLegacyInkPressure(null);
});

describe("the lock is this device's, never data.json's", () => {
	for (const on of [true, false]) {
		it(`switch ${on ? "on" : "off"}: a launch that reads a file locks from it, on the device, and data.json carries no lock`, async () => {
			const p = await launched({ lastSeenVersion: "1.4.24", pressureSensitivity: on, pressureChoice: on });
			expect(p.legacyInkPressure).toBe(on);
			expect(device.get(LEGACY_PRESSURE_KEY)).toBe(String(on));
			expect(unmarkedInkPressure(), "the runtime is told").toBe(on);
			expect(p.settings).not.toHaveProperty("legacyInkPressure");
			if (p.saved) expect(p.saved).not.toHaveProperty("legacyInkPressure");
		});
	}

	it("a fresh install, with no settings file, takes no lock and waits for the user's own set, with no toast", async () => {
		const p = await launched(null);
		expect(p.legacyInkPressure ?? null).toBe(null);
		expect(p.legacyPressureNoticeDue ?? false, "no toast").toBe(false);
		const next = await launched({ pressureSensitivity: false, pressureChoice: false });
		expect(next.legacyInkPressure ?? null, "a file read later locks nothing until a set").toBe(null);
		expect(unmarkedInkPressure(), "old ink follows the switch").toBe(false);
	});

	it("an external settings change never touches the lock, with the key in the file or without it", async () => {
		const p = await launched({ lastSeenVersion: "1.4.24", pressureSensitivity: false, pressureChoice: false });
		expect(p.legacyInkPressure, "premise: locked off").toBe(false);
		const key = p.inkShapingKey();
		p.loadData = (): Promise<unknown> => Promise.resolve({ lastSeenVersion: "1.4.24", pressureSensitivity: true, pressureChoice: true, legacyInkPressure: true });
		await p.onExternalSettingsChange();
		expect(p.legacyInkPressure, "a fresh device's file with a lock in it").toBe(false);
		p.loadData = (): Promise<unknown> => Promise.resolve({ lastSeenVersion: "1.4.24", pressureSensitivity: true, pressureChoice: true });
		await p.onExternalSettingsChange();
		expect(p.legacyInkPressure, "a file with no key").toBe(false);
		expect(device.get(LEGACY_PRESSURE_KEY)).toBe("false");
		expect(unmarkedInkPressure()).toBe(false);
		expect(p.inkShapingKey(), "nothing redraws").toBe(key);
	});

	it("a later launch keeps the lock, whatever the switch says since", async () => {
		await launched({ pressureSensitivity: true, pressureChoice: true });
		const p = await launched({ pressureSensitivity: false, pressureChoice: false });
		expect(p.legacyInkPressure).toBe(true);
	});

	it("a launch whose data.json carries a lock (another build's or device's) ignores it", async () => {
		await launched({ pressureSensitivity: false, pressureChoice: false });
		const p = await launched({ pressureSensitivity: true, pressureChoice: true, legacyInkPressure: true });
		expect(p.legacyInkPressure).toBe(false);
		expect(unmarkedInkPressure()).toBe(false);
	});

	it("an empty settings file takes no lock and waits for the user's own set, with no toast", async () => {
		const p = await launched(BLANK);
		expect(p.settingsReadFailed, "premise: the empty file read, not failed").toBe(false);
		expect(p.settings.pressureSensitivity, "premise: the empty file loaded as defaults").toBe(true);
		expect(p.legacyInkPressure ?? null).toBe(null);
		expect(p.legacyPressureNoticeDue ?? false, "no toast").toBe(false);
		const next = await launched({ pressureSensitivity: false, pressureChoice: false });
		expect(next.legacyInkPressure ?? null, "a real file read later locks nothing until a set").toBe(null);
		expect(unmarkedInkPressure(), "old ink follows the switch").toBe(false);
	});

	for (const [name, first] of [
		["no settings file", null],
		["an empty settings file", BLANK],
	] as const) {
		it(`${name}: the next launch reads the file this one saved and takes no lock; the switch still redraws old ink, and the set locks at the launch after`, async () => {
			const p = await launched(first);
			expect(p.legacyInkPressure ?? null, "premise: no lock at the first launch").toBe(null);
			// The file the first launch saves (saveData(this.settings)): this device's defaults, nobody's choice.
			const next = await launched({ ...p.settings });
			expect(next.settings.pressureChoice, "premise: the saved file says on, the default").toBe(true);
			expect(next.legacyInkPressure ?? null, "no lock from this device's own defaults").toBe(null);
			expect(next.legacyPressureNoticeDue ?? false, "no toast").toBe(false);
			const key = next.inkShapingKey();
			next.setPressureSwitch(false);
			expect(unmarkedInkPressure(), "old ink follows the switch").toBe(false);
			expect(next.inkShapingKey(), "so old ink redraws").not.toBe(key);
			const third = await launched({ ...next.settings });
			expect(third.legacyInkPressure, "the user's set locks at the next launch").toBe(false);
			const fourth = await launched({ ...third.settings, pressureSensitivity: true, pressureChoice: true });
			expect(fourth.legacyInkPressure, "and stays locked, whatever the switch says since").toBe(false);
		});
	}

	it("an unreadable settings file changes nothing: no lock, and the next launch that reads it locks from its choice", async () => {
		const p = await launched(UNREADABLE);
		expect(p.settingsReadFailed, "premise: the read failed").toBe(true);
		expect(p.legacyInkPressure ?? null).toBe(null);
		expect(device.has(LEGACY_PRESSURE_KEY)).toBe(false);
		const next = await launched({ pressureSensitivity: false, pressureChoice: false });
		expect(next.legacyInkPressure).toBe(false);
	});

	it("a device that already holds a lock keeps it through a fresh install or an empty file", async () => {
		await launched({ pressureSensitivity: false, pressureChoice: false });
		expect((await launched(null)).legacyInkPressure, "no file").toBe(false);
		expect((await launched(BLANK)).legacyInkPressure, "empty file").toBe(false);
		expect(device.get(LEGACY_PRESSURE_KEY)).toBe("false");
	});

	it("a wiped device store relocks from the switch at that launch", async () => {
		await launched({ pressureSensitivity: true, pressureChoice: true });
		device.clear();
		const p = await launched({ pressureSensitivity: false, pressureChoice: false });
		expect(p.legacyInkPressure).toBe(false);
		expect(device.get(LEGACY_PRESSURE_KEY)).toBe("false");
	});
});

describe("a vault straight from 1.4.20 stays pending all session, and the next launch locks from the last value set here", () => {
	const RAW_1420 = { lastSeenVersion: "1.4.20", pressureSensitivity: true };
	const relaunched = (on: boolean): Promise<Plugin> => launched({ ...RAW_1420, pressureSensitivity: on, pressureChoice: on });

	it("no lock at the first launch, nor at the next; a flip keeps it pending, old ink follows it, and the next launch locks", async () => {
		const first = await launched(RAW_1420);
		expect(first.legacyInkPressure ?? null, "first launch").toBe(null);
		const second = await launched(RAW_1420);
		expect(second.legacyInkPressure ?? null, "second launch, no set: still pending").toBe(null);
		const before = second.inkShapingKey();
		second.setPressureSwitch(false);
		expect(second.legacyInkPressure ?? null, "the flip takes no lock this session").toBe(null);
		expect(unmarkedInkPressure(), "old ink follows the switch").toBe(false);
		expect(second.inkShapingKey(), "so the old ink redraws").not.toBe(before);
		const third = await relaunched(false);
		expect(third.legacyInkPressure, "the next launch locks from the last value set").toBe(false);
		const fourth = await relaunched(true);
		expect(fourth.legacyInkPressure, "and stays locked, whatever the switch says since").toBe(false);
	});

	it("off then on in one session, relaunch: locked on", async () => {
		const p = await launched(RAW_1420);
		p.setPressureSwitch(false);
		p.setPressureSwitch(true);
		expect(p.legacyInkPressure ?? null, "still pending this session").toBe(null);
		expect(unmarkedInkPressure(), "old ink back under the on look").toBe(true);
		const next = await relaunched(true);
		expect(next.legacyInkPressure).toBe(true);
	});

	it("off, relaunch: locked off", async () => {
		const p = await launched(RAW_1420);
		p.setPressureSwitch(false);
		expect(p.legacyInkPressure ?? null, "still pending this session").toBe(null);
		const next = await relaunched(false);
		expect(next.legacyInkPressure).toBe(false);
	});

	it("the lock comes from the last value set on this device, not from the file the next launch reads", async () => {
		const p = await launched(RAW_1420);
		p.setPressureSwitch(false);
		const next = await relaunched(true);
		expect(next.legacyInkPressure, "a synced file saying on does not move it").toBe(false);
	});
});

describe("the settings row's switch", () => {
	it("once locked, a flip redraws nothing and moves no lock", async () => {
		const p = await launched({ pressureSensitivity: true, pressureChoice: true });
		const key = p.inkShapingKey();
		p.setPressureSwitch(false);
		expect(p.settings.pressureSensitivity).toBe(false);
		expect(p.settings.pressureChoice).toBe(false);
		expect(p.legacyInkPressure).toBe(true);
		expect(p.inkShapingKey()).toBe(key);
	});

	it("with no lock yet (no file read), a flip redraws, since unmarked ink follows the switch, and takes no lock", async () => {
		const p = await launched(null);
		const key = p.inkShapingKey();
		p.setPressureSwitch(false);
		expect(p.legacyInkPressure ?? null).toBe(null);
		expect(p.inkShapingKey()).not.toBe(key);
	});
});

describe("the 1.5.0 What's New", () => {
	it("an update from 1.4.24 shows the pressure line", () => {
		const d = decideWhatsNew("1.5.0", "1.4.24", false);
		expect(d.show).toBe(true);
		const notes = d.show ? d.notes : [];
		expect(notes.some((n) => /pressure/i.test(n) && /new ink/i.test(n))).toBe(true);
	});
});
