/**
 * PAGE GUIDES SETTING, default on.
 *
 * The setting is the key `pageGuides`, read as `raw?.pageGuides !== false`, so a vault that never stored it keeps
 * its guides. Off puts the body class `handwriting-page-guides-off` on every window, and styles.css hides the guides'
 * box under it (the render half is test/render/PageGuidesSetting.test.ts). The class rides the paper class's roads:
 * load, a popout opening, a settings file synced in, the row's toggle; unload takes it off every window.
 *
 * WHAT RUNS FOR REAL: the plugin's onload, onunload, loadSettings, the settings tab's definitions and its
 * setControlValue, and onExternalSettingsChange. Harness from MainThreadProbeUnload.test.ts, with a real class list
 * on each body so a class that is set, left or never cleared shows. Cells:
 *   1. model: a missing key, true, or a value that is not a boolean reads on; false reads off.
 *   2. tab: the row sits after "Paper background" with its toggle and its description; off then on is saved, and the
 *      class follows on every window, a popout opened later and a synced file included.
 *   4. unload: no window keeps the class.
 */
import { describe, expect, it } from "vitest";
import { installFakeWindow } from "../../test/routerHarness";

installFakeWindow();

const OFF = "handwriting-page-guides-off";

/** A body class list that behaves like the real one, for the four calls the plugin makes. */
class ClassSet {
	readonly names = new Set<string>();
	add(...n: string[]): void { for (const x of n) this.names.add(x); }
	remove(...n: string[]): void { for (const x of n) this.names.delete(x); }
	contains(n: string): boolean { return this.names.has(n); }
	toggle(n: string, force?: boolean): boolean {
		const on = force ?? !this.names.has(n);
		if (on) this.names.add(n); else this.names.delete(n);
		return on;
	}
}

function fakeDocument(): Record<string, unknown> & { body: Record<string, unknown> & { classList: ClassSet } } {
	const sink = { add: () => {}, remove: () => {}, contains: () => false, toggle: () => false };
	return {
		body: { classList: new ClassSet(), querySelector: () => null, querySelectorAll: () => [], appendChild: () => {} },
		documentElement: { classList: sink },
		head: { appendChild: () => {} },
		createElement: () => ({ classList: sink, style: {}, appendChild: () => {}, setAttribute: () => {} }),
		addEventListener: () => {},
		removeEventListener: () => {},
		querySelector: () => null,
		querySelectorAll: () => [],
	};
}

const mainDoc = fakeDocument();
(globalThis as Record<string, unknown>).document = mainDoc;
(globalThis as Record<string, unknown>).MutationObserver = class {
	observe() {}
	disconnect() {}
	takeRecords() { return []; }
};
Object.assign(window, {
	setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
	clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
	document: mainDoc,
	matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
});

import HandwritingPlugin, { HandwritingSettingTab } from "../main";

const noop = () => {};
const emptyEventRef = {};

type Doc = ReturnType<typeof fakeDocument>;
type Plugin = Record<string, any> & { onload(): Promise<void>; onunload(): void; settings: Record<string, unknown> };
type Rig = {
	plugin: Plugin;
	/** The window-open handler the plugin registered. */
	openWindow(doc: Doc): void;
	/** A pane in an already-open popout, seen by iterateAllLeaves. */
	addLeafIn(doc: Doc): void;
	/** What data.json holds: the last object saveData was handed. */
	saved(): Record<string, unknown> | null;
	/** The file as another device would have synced it in. */
	setDisk(raw: unknown): void;
};

async function loadPlugin(raw: unknown): Promise<Rig> {
	mainDoc.body.classList.names.clear();
	let disk: unknown = raw;
	let saved: Record<string, unknown> | null = null;
	const handlers = new Map<string, (...a: unknown[]) => void>();
	const leafDocs: Doc[] = [];
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
			on: (name: string, fn: (...a: unknown[]) => void) => {
				handlers.set(name, fn);
				return emptyEventRef;
			},
			onLayoutReady: (fn: () => void) => fn(),
			getLeavesOfType: () => [],
			getActiveFile: () => null,
			getActiveViewOfType: () => null,
			activeLeaf: null,
			iterateAllLeaves: (cb: (leaf: unknown) => void) => {
				for (const d of leafDocs) cb({ view: { containerEl: { ownerDocument: d } } });
			},
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
		loadData: async () => (disk === undefined ? undefined : JSON.parse(JSON.stringify(disk))),
		saveData: async (data: Record<string, unknown>) => {
			saved = JSON.parse(JSON.stringify(data));
		},
	});
	await plugin.onload();
	return {
		plugin,
		// The popout's window: its document, and the listener pair the escape-key binding takes on it. A popout
		// opens holding a pane (an empty one closes), so iterateAllLeaves sees it from then on.
		openWindow: (doc) => {
			if (!leafDocs.includes(doc)) leafDocs.push(doc);
			handlers.get("window-open")?.({}, { document: doc, addEventListener: noop, removeEventListener: noop });
		},
		addLeafIn: (doc) => void leafDocs.push(doc),
		saved: () => saved,
		setDisk: (r) => {
			disk = r;
		},
	};
}

function tabFor(plugin: Plugin) {
	const tab = Object.create(HandwritingSettingTab.prototype) as {
		plugin: unknown;
		getSettingDefinitions(): Row[];
		getControlValue(key: string): unknown;
		setControlValue(key: string, value: unknown): void;
	};
	tab.plugin = plugin;
	return tab;
}

type Row = { name?: string; desc?: string; items?: Row[]; control?: { type: string; key: string } };
const DESC = "Faint lines where each page ends, on Infinite canvas notes. Not in exports. Default on.";

/** Lets the settings write the toggle schedules land in saveData: the save chain is promises only, no timer. */
async function flushSaves(): Promise<void> {
	for (let i = 0; i < 400; i++) await Promise.resolve();
}

describe("cell 1: the stored key reads on unless it is false", () => {
	it.each([
		["missing", {}, true],
		["no settings file", undefined, true],
		["true", { pageGuides: true }, true],
		["a string", { pageGuides: "off" }, true],
		["a number", { pageGuides: 0 }, true],
		["null", { pageGuides: null }, true],
		["false", { pageGuides: false }, false],
	] as const)("%s reads %s", async (_label, raw, on) => {
		const { plugin } = await loadPlugin(raw);
		expect(plugin.settings.pageGuides, `pageGuides after loading ${JSON.stringify(raw)}`).toBe(on);
		expect(mainDoc.body.classList.contains(OFF), "the off class on the main window after load").toBe(!on);
		plugin.onunload();
	});
});

describe("cell 2: the row, its save, and the class on every window", () => {
	it("sits right after Paper background in the same group, a toggle on pageGuides, with the ruled description", async () => {
		const { plugin } = await loadPlugin({});
		const groups = (tabFor(plugin).getSettingDefinitions() as Row[]);
		const flatGroups = (rows: Row[]): Row[][] =>
			rows.flatMap((r) => (r.items ? [r.items.filter((i) => !i.items), ...flatGroups(r.items)] : []));
		const home = flatGroups(groups).find((g) => g.some((r) => r.name === "Paper background"));
		expect(home, "a group holds Paper background").toBeDefined();
		const at = home!.findIndex((r) => r.name === "Paper background");
		const row = home![at + 1];
		expect(row?.name, "the row after Paper background").toBe("Page guides");
		expect(row?.control).toEqual({ type: "toggle", key: "pageGuides" });
		expect(row?.desc).toBe(DESC);
		expect(tabFor(plugin).getControlValue("pageGuides"), "the toggle reads the default").toBe(true);
		plugin.onunload();
	});

	it("off then on: each is saved, and the class follows on the main window, an open popout and one opened later", async () => {
		const rig = await loadPlugin({});
		const { plugin } = rig;
		const open = fakeDocument();
		rig.addLeafIn(open);
		const tab = tabFor(plugin);
		expect(mainDoc.body.classList.contains(OFF), "premise: on at load, no class").toBe(false);

		tab.setControlValue("pageGuides", false);
		await flushSaves();
		expect(plugin.settings.pageGuides).toBe(false);
		expect(rig.saved()?.pageGuides, "off is saved").toBe(false);
		expect(mainDoc.body.classList.contains(OFF), "off: main window").toBe(true);
		expect(open.body.classList.contains(OFF), "off: the open popout").toBe(true);
		const later = fakeDocument();
		rig.openWindow(later);
		expect(later.body.classList.contains(OFF), "off: a popout opened after the flip").toBe(true);

		tab.setControlValue("pageGuides", true);
		await flushSaves();
		expect(plugin.settings.pageGuides).toBe(true);
		expect(rig.saved()?.pageGuides, "on is saved").toBe(true);
		for (const [name, d] of [["main", mainDoc], ["open popout", open], ["later popout", later]] as const) {
			expect(d.body.classList.contains(OFF), `on: ${name}`).toBe(false);
		}
		plugin.onunload();
	});

	it("a settings file synced in with the guides off stamps every window, and back on clears them", async () => {
		const rig = await loadPlugin({});
		const open = fakeDocument();
		rig.addLeafIn(open);
		rig.setDisk({ pageGuides: false });
		await rig.plugin.onExternalSettingsChange();
		expect(rig.plugin.settings.pageGuides, "the synced value is taken").toBe(false);
		expect(mainDoc.body.classList.contains(OFF), "synced off: main window").toBe(true);
		expect(open.body.classList.contains(OFF), "synced off: open popout").toBe(true);
		rig.setDisk({ pageGuides: true });
		await rig.plugin.onExternalSettingsChange();
		expect(mainDoc.body.classList.contains(OFF), "synced on: main window").toBe(false);
		expect(open.body.classList.contains(OFF), "synced on: open popout").toBe(false);
		rig.plugin.onunload();
	});

	it("paper changes keep the guides choice", async () => {
		const rig = await loadPlugin({ pageGuides: false, paperStyle: "lines" });
		expect(mainDoc.body.classList.contains("handwriting-paper-lines"), "premise: lined paper").toBe(true);
		tabFor(rig.plugin).setControlValue("paperStyle", "none");
		expect(mainDoc.body.classList.contains("handwriting-paper-lines"), "premise: paper none").toBe(false);
		expect(mainDoc.body.classList.contains(OFF), "guides still off after a paper change").toBe(true);
		rig.plugin.onunload();
	});
});

describe("cell 4: unload leaves no window with the class", () => {
	it("guides off at unload: the main window and every popout lose the class", async () => {
		const rig = await loadPlugin({ pageGuides: false });
		const open = fakeDocument();
		rig.addLeafIn(open);
		rig.openWindow(open);
		expect(mainDoc.body.classList.contains(OFF), "premise: main window has the class").toBe(true);
		expect(open.body.classList.contains(OFF), "premise: popout has the class").toBe(true);
		rig.plugin.onunload();
		expect(mainDoc.body.classList.contains(OFF), "main window after unload").toBe(false);
		expect(open.body.classList.contains(OFF), "popout after unload").toBe(false);
	});
});
