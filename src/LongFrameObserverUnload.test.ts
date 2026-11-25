/**
 * The long-frame observer a pen stroke starts must be stopped when the plugin unloads.
 *
 * Every stroke's metrics read long animation frames through one shared PerformanceObserver, started at the first
 * pen-down (StrokeMetrics `begin`). Nothing stopped it, so a user who turns the plugin off, reloads or updates it kept
 * the old copy's observer, its callback and the module it closes over alive until Obsidian restarts, one more per
 * off and on. onunload now stops it.
 *
 * WHAT RUNS FOR REAL: the plugin's onload and onunload, and the shared StrokeMetrics every surface uses. Harness from
 * MainThreadProbeUnload.test.ts. PerformanceObserver is a stand-in that offers "long-animation-frame" and counts the
 * observers connected for that type.
 */
import { describe, expect, it } from "vitest";
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

/** Observers connected for long animation frames, and every one ever made for that type. */
let connected = 0;
let made = 0;
(globalThis as Record<string, unknown>).PerformanceObserver = class {
	static supportedEntryTypes = ["long-animation-frame"];
	private on = false;
	observe(opts: { type?: string }): void {
		if (opts.type !== "long-animation-frame" || this.on) return;
		this.on = true;
		connected++;
		made++;
	}
	disconnect(): void {
		if (!this.on) return;
		this.on = false;
		connected--;
	}
	takeRecords(): PerformanceEntryList {
		return [];
	}
};

import { metrics } from "./inline/InkOverlay";
import { StrokeMetrics } from "./ink/StrokeMetrics";
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

describe("the long-frame observer at unload", () => {
	it("is disconnected by onunload after a pen stroke started it", async () => {
		const plugin = await loadPlugin();
		metrics.begin("pen", 0); // pen-down
		expect(connected, "premise: the first stroke connected the long-frame observer").toBe(1);
		plugin.onunload();
		expect(connected, "the long-frame observer is still connected after onunload").toBe(0);
	});

	// The one observer is shared: a PDF page's own metrics use the same source, so the same unload stops it.
	it("is the one observer every surface's metrics share", async () => {
		const plugin = await loadPlugin();
		const before = made;
		metrics.begin("pen", 0);
		new StrokeMetrics().begin("pen", 0);
		expect(made - before, "a second surface made its own observer").toBeLessThanOrEqual(1);
		expect(connected, "premise: one observer connected").toBe(1);
		plugin.onunload();
		expect(connected, "the long-frame observer is still connected after onunload").toBe(0);
	});
});
