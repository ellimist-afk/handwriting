/**
 * THE CANVAS PAGE IS OUT, EXECUTED.
 *
 * "Canvas page" throughout means the old whiteboard pane, removed -
 * never Infinite Canvas, the per-note setting on ordinary notes, which is a
 * different thing and is untouched.
 *
 * Part 1 deleted the view, its commands and its frontmatter routing. Two
 * claims survive that deletion and are worth running rather than reading:
 *
 * 1. THE PALETTE AND THE VIEW REGISTRY ARE CLEAN. A real `onload()` runs here
 *    against a stub host, and what it hands to `addCommand` and
 *    `registerView` is collected. The six retired ids and the
 *    `handwriting-page` view type must be absent - and the collection must be
 *    non-empty, or "absent" would be free.
 *
 * 2. THE TWO CARRIED KEYS STILL ROUND-TRIP. `settings.savedViews` and
 *    `settings.cameras` belonged to the canvas page and are deliberately NOT
 *    deleted: a vault that used the canvas page still has them in data.json,
 *    and a build that dropped them would erase another build's settings on
 *    the first save (loadSettings' own note). So a load-then-save pair must
 *    return both exactly as they arrived.
 *
 * WHAT RUNS FOR REAL: `HandwritingPlugin.prototype.onload`, `loadSettings`
 * and `persistSettings` on an `Object.create` instance. The host is stubbed -
 * Obsidian's App, vault, workspace and metadata cache are not constructible
 * here - and every stub is a sink that records or answers empty, never a
 * decision. The assertions are over what production code handed the host.
 */

import { describe, expect, it, vi } from "vitest";
import { installFakeWindow } from "../test/routerHarness";
import { PageStore } from "./persistence/PageStore";

installFakeWindow();

/**
 * The host DOM `onload` touches, as sinks.
 *
 * `loadSettings` puts the paper class on `document.body` and the live-reload
 * poll arms an interval. Neither decides anything these cases read; a missing
 * one just stops the load.
 */
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

import HandwritingPlugin from "./main";

/** The ids the canvas page owned, from the deleted commands at e020d475. */
const RETIRED_COMMAND_IDS = [
	"new-page",
	"open-as-canvas",
	"open-as-markdown",
	"canvas-saved-views",
	"export-canvas-svg",
	"export-canvas-pdf",
];

const RETIRED_VIEW_TYPE = "handwriting-page";

interface Registered {
	commandIds: string[];
	viewTypes: string[];
}

/**
 * A plugin instance with Obsidian's side stubbed, loaded for real.
 *
 * Every member below is either a RECORDER (addCommand, registerView) or an
 * empty answer (a vault with no files, a workspace with no leaves). None of
 * them decides anything the assertions read.
 */
const noop = () => {};
const emptyEventRef = {};

/** An empty vault: no files, no leaves, nothing cached. */
function stubApp() {
	return {
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
		metadataCache: {
			on: () => emptyEventRef,
			getFileCache: () => null,
			getCache: () => null,
		},
		keymap: { pushScope: noop, popScope: noop },
		scope: {},
		fileManager: { processFrontMatter: async () => {} },
	};
}

async function loadPlugin(data: unknown = {}): Promise<Registered> {
	const commandIds: string[] = [];
	const viewTypes: string[] = [];
	const app = stubApp();

	// CONSTRUCTED, not `Object.create`d: every class FIELD - the PDF store,
	// the page-id index, the timer maps - is an initializer that only a real
	// construction runs, and `onload` reads them. Obsidian's `Plugin` base is
	// the empty stub (test/obsidian-stub.ts), so the constructor is the field
	// initializers and nothing else.
	const plugin = new (HandwritingPlugin as unknown as new (
		app: unknown,
		manifest: unknown
	) => Record<string, unknown> & { onload(): Promise<void> })(app, {});
	Object.assign(plugin, {
		app,
		manifest: { id: "handwriting", version: "0.0.0-test", dir: ".obsidian/plugins/handwriting" },
		addCommand: (command: { id: string }) => {
			commandIds.push(command.id);
			return command;
		},
		registerView: (type: string) => {
			viewTypes.push(type);
		},
		addSettingTab: noop,
		addRibbonIcon: () => ({ addClass: noop }),
		registerEvent: noop,
		registerDomEvent: noop,
		registerInterval: noop,
		registerEditorExtension: noop,
		registerMarkdownPostProcessor: noop,
		registerObsidianProtocolHandler: noop,
		register: noop,
		loadData: async () => data,
		saveData: async () => {},
	});

	await plugin.onload();
	return { commandIds, viewTypes };
}

describe("the retired canvas page registers nothing", () => {
	it("the harness holds: a real load registers commands and views", async () => {
		// The anti-vacuity half, first and on its own. Every "is absent"
		// assertion below is satisfied for free by a load that did nothing.
		const { commandIds, viewTypes } = await loadPlugin();

		expect(commandIds.length).toBeGreaterThan(10);
		expect(viewTypes.length).toBeGreaterThan(0);
	});

	it("registers none of the six canvas page command ids", async () => {
		const { commandIds } = await loadPlugin();

		expect(commandIds.filter((id) => RETIRED_COMMAND_IDS.includes(id))).toEqual([]);
	});

	it("registers no handwriting-page view type", async () => {
		const { viewTypes } = await loadPlugin();

		expect(viewTypes).not.toContain(RETIRED_VIEW_TYPE);
	});
});

describe("the canvas page's settings keys are carried, not interpreted", () => {
	/** `loadSettings` and `persistSettings` are private; this file drives them. */
	function settingsRig(data: unknown) {
		const saved: unknown[] = [];
		const plugin = new (HandwritingPlugin as unknown as new (
			app: unknown,
			manifest: unknown
		) => Record<string, unknown> & {
			loadSettings(): Promise<void>;
			persistSettings(): Promise<void>;
			settings: { savedViews: unknown[]; cameras: Record<string, unknown> };
		})({}, {});
		const adapter = {
			exists: async () => false,
			read: async () => "",
			write: async () => {},
			mkdir: async () => {},
			list: async () => ({ files: [], folders: [] }),
			stat: async () => null,
			remove: async () => {},
			rename: async () => {},
		};
		Object.assign(plugin, {
			app: stubApp(),
			// `loadSettings` hands the chosen ink folder to the store, which
			// onload would have built. The real store over an empty adapter.
			store: new PageStore({ vault: { adapter } } as never),
			loadData: async () => data,
			saveData: vi.fn(async (written: unknown) => {
				saved.push(written);
			}),
		});
		return { plugin, saved };
	}

	it("a non-empty savedViews array and cameras map survive a load and a save", async () => {
		const savedViews = [
			{ id: "v1", name: "Top left", camera: { x: -120.5, y: 40, zoom: 0.75 } },
			{ id: "v2", name: "The long one", camera: { x: 98765.43, y: -2500.25, zoom: 3 } },
		];
		const cameras = {
			"page-a": { x: 0, y: 0, zoom: 1 },
			"page-b": { x: -61.5, y: 123456.78, zoom: 0.1 },
		};
		const { plugin, saved } = settingsRig({ savedViews, cameras });

		await plugin.loadSettings();
		await plugin.persistSettings();

		expect(plugin.settings.savedViews).toEqual(savedViews);
		expect(plugin.settings.cameras).toEqual(cameras);
		expect(saved).toHaveLength(1);
		const written = saved[0] as { savedViews: unknown; cameras: unknown };
		expect(written.savedViews).toEqual(savedViews);
		expect(written.cameras).toEqual(cameras);
	});

	it("a vault that never had them still loads, with both empty", async () => {
		// The control: the defaults are the empty shapes, so the round trip
		// above is carrying real data rather than reporting its own default.
		const { plugin, saved } = settingsRig({});

		await plugin.loadSettings();
		await plugin.persistSettings();

		expect(plugin.settings.savedViews).toEqual([]);
		expect(plugin.settings.cameras).toEqual({});
		const written = saved[0] as { savedViews: unknown; cameras: unknown };
		expect(written.savedViews).toEqual([]);
		expect(written.cameras).toEqual({});
	});
});
