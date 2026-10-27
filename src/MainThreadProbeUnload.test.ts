/**
 * A recording left on when the plugin unloads must not leave the main-thread probe running.
 *
 * The probe (ScrollProbe's gap timer and long-task observer) starts and stops with the recording. "Bug report:
 * record" is a command for every user, and nothing turns the recording off at unload, so a user who records and then
 * disables, updates or reloads the plugin would keep a 10 ms timer chain and an observer running in the unloaded
 * module until Obsidian restarts. onunload stops the probe's timer and observer, not the recording switch.
 *
 * WHAT RUNS FOR REAL: the plugin's onload and onunload, DiagSwitch and ScrollProbe. Harness from
 * NoteCameraLifecycle.test.ts. The window's 10 ms timer runs are counted; PerformanceObserver is a stand-in that
 * offers "longtask". The timer case waits 150 ms of wall clock and expects zero runs, a count load can only raise on
 * a defect, never on the fixed code.
 */
import { afterEach, describe, expect, it } from "vitest";
import { installFakeWindow } from "../test/routerHarness";

installFakeWindow();

const classSink = { add: () => {}, remove: () => {}, contains: () => false, toggle: () => false };
(globalThis as Record<string, unknown>).document = {
	body: { classList: classSink, querySelector: () => null, querySelectorAll: () => [], appendChild: () => {} },
	documentElement: { classList: classSink },
	head: { appendChild: () => {} },
	createElement: () => ({ classList: classSink, style: {}, appendChild: () => {}, setAttribute: () => {} }),
	addEventListener: () => {},
	removeEventListener: () => {},
	querySelector: () => null,
	querySelectorAll: () => [],
};
(globalThis as Record<string, unknown>).MutationObserver = class {
	observe() {}
	disconnect() {}
	takeRecords() {
		return [];
	}
};
Object.assign(window, {
	setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
	clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
	document: (globalThis as Record<string, unknown>).document,
	matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
});

let observing = 0;
(globalThis as Record<string, unknown>).PerformanceObserver = class {
	static supportedEntryTypes = ["longtask"];
	observe(): void {
		observing++;
	}
	disconnect(): void {
		observing--;
	}
};

import { diagnosticsEnabled, diagnosticsEpoch, setDiagnosticsChangedListener, setDiagnosticsEnabled } from "./diag/DiagSwitch";
import HandwritingPlugin from "./main";

const noop = () => {};
const emptyEventRef = {};

type Plugin = Record<string, any> & { onload(): Promise<void>; onunload(): void };

async function loadPlugin(): Promise<Plugin> {
	const app = {
		loadLocalStorage: () => null,
		saveLocalStorage: noop,
		vault: {
			adapter: {
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				mkdir: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => null,
				remove: async () => {},
				rename: async () => {},
			},
			on: () => emptyEventRef,
			getFileByPath: () => null,
			getMarkdownFiles: () => [],
			getFiles: () => [],
			getAbstractFileByPath: () => null,
			cachedRead: async () => "",
			read: async () => "",
			configDir: ".obsidian",
		},
		workspace: {
			on: () => emptyEventRef,
			onLayoutReady: (fn: () => void) => fn(),
			getLeavesOfType: () => [],
			getActiveFile: () => null,
			getActiveViewOfType: () => null,
			activeLeaf: null,
			iterateAllLeaves: noop,
			trigger: noop,
		},
		metadataCache: { on: () => emptyEventRef, getFileCache: () => null, getCache: () => null },
		keymap: { pushScope: noop, popScope: noop },
		scope: {},
		fileManager: { processFrontMatter: async () => {} },
	};
	const plugin = new (HandwritingPlugin as unknown as new (a: unknown, m: unknown) => Plugin)(app, {});
	Object.assign(plugin, {
		app,
		manifest: { id: "handwriting", version: "0.0.0-test", dir: ".obsidian/plugins/handwriting" },
		addCommand: (command: unknown) => command,
		registerView: noop,
		addSettingTab: noop,
		addRibbonIcon: () => ({ addClass: noop }),
		addStatusBarItem: () =>
			new Proxy({}, { get: (_t, k) => (k === "style" || k === "classList" || k === "dataset" ? new Proxy({}, { get: () => noop }) : noop) }),
		registerEvent: (ref: unknown) => ref,
		registerDomEvent: noop,
		registerInterval: (id: unknown) => id,
		registerEditorExtension: noop,
		registerMarkdownPostProcessor: noop,
		registerObsidianProtocolHandler: noop,
		register: noop,
		loadData: async () => ({}),
		saveData: async () => {},
	});
	await plugin.onload();
	return plugin;
}

/** Counts the runs of every 10 ms timer the window schedules from now on, until restored. */
function countTenMsRuns() {
	const host = window as unknown as { setTimeout: (fn: () => void, ms?: number) => unknown };
	const set = host.setTimeout;
	let scheduled = 0;
	let runs = 0;
	host.setTimeout = (fn: () => void, ms?: number) => {
		if (ms !== 10) return set.call(window, fn, ms);
		scheduled++;
		return set.call(window, () => {
			runs++;
			fn();
		}, ms);
	};
	return {
		scheduled: () => scheduled,
		runs: () => runs,
		restore: () => {
			host.setTimeout = set;
		},
	};
}

afterEach(() => {
	setDiagnosticsChangedListener(null);
	setDiagnosticsEnabled(false);
});

describe("a recording left on at unload", () => {
	it("leaves no gap timer running after onunload", async () => {
		const plugin = await loadPlugin();
		const timers = countTenMsRuns();
		try {
			setDiagnosticsEnabled(true); // Bug report: record
			expect(timers.scheduled(), "the gap timer did not start with the recording").toBe(1);
			plugin.onunload();
			const before = timers.runs();
			await new Promise((r) => setTimeout(r, 150));
			expect(timers.runs() - before, "10 ms gap timer runs in the 150 ms after onunload").toBe(0);
		} finally {
			timers.restore();
		}
	});

	it("leaves no long-task observer connected after onunload", async () => {
		const plugin = await loadPlugin();
		observing = 0;
		setDiagnosticsEnabled(true);
		expect(observing, "the long-task observer did not start with the recording").toBe(1);
		plugin.onunload();
		expect(observing, "the long-task observer is still connected after onunload").toBe(0);
	});

	// A guard, green before and after the fix: onunload stops the instrument, not the switch, so the changed listener
	// (the badge and the toolbars being torn down) is not told and the recording and its epoch stay as they were.
	it("stops the probe without flipping the recording switch", async () => {
		const plugin = await loadPlugin();
		setDiagnosticsEnabled(true);
		const epoch = diagnosticsEpoch();
		let told = 0;
		setDiagnosticsChangedListener(() => told++);
		plugin.onunload();
		expect(told, "onunload told the changed listener").toBe(0);
		expect(diagnosticsEnabled()).toBe(true);
		expect(diagnosticsEpoch()).toBe(epoch);
	});
});
