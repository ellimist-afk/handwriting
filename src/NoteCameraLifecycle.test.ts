/**
 * EACH NOTE'S REMEMBERED ZOOM AND SCROLL FOLLOWS THE PLUGIN'S OWN VAULT HANDLERS AND UNLOAD (GitHub issue 9).
 *
 * noteCameras is keyed by path. main.ts moves an entry when a note is renamed, drops it when a note is renamed away from
 * Markdown or deleted, and clears every entry in onunload. Each cell below reaches one of those four lines through the
 * real onload and the real handlers it registers, so removing any one of them turns exactly its cell red.
 *
 * Loads the real onload with the vault's rename and delete listeners captured, then fires them as Obsidian would.
 */
import { describe, expect, it } from "vitest";
import { TFile } from "obsidian";
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

import HandwritingPlugin from "./main";
import { noteCameras } from "./inline/NoteCamera";

const noop = () => {};
const emptyEventRef = {};

type Plugin = Record<string, any> & { onload(): Promise<void>; onunload(): void };
type Listener = (...args: unknown[]) => unknown;

async function loadPlugin() {
	const vaultListeners = new Map<string, Listener[]>();
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
			on: (name: string, fn: Listener) => {
				vaultListeners.set(name, [...(vaultListeners.get(name) ?? []), fn]);
				return emptyEventRef;
			},
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
	/** Every listener the plugin registered for this vault event, called as Obsidian would. */
	const fire = (name: string, ...args: unknown[]) => {
		const listeners = vaultListeners.get(name) ?? [];
		expect(listeners.length).toBeGreaterThan(0);
		for (const fn of listeners) fn(...args);
	};
	return { plugin, fire };
}

const file = (path: string) => Object.assign(new TFile(), { path, extension: path.slice(path.lastIndexOf(".") + 1) });
const camera = { zoom: 0.5, left: 0, top: 600 };

describe("a note's remembered camera through the plugin's lifecycle", () => {
	it("moves to the new path when the note is renamed", async () => {
		const { plugin, fire } = await loadPlugin();
		noteCameras.save("Old.md", camera);
		fire("rename", file("New.md"), "Old.md");
		expect(noteCameras.get("New.md")).toEqual(camera);
		expect(noteCameras.get("Old.md")).toBeNull();
		plugin.onunload();
	});

	it("is dropped when the note is renamed away from Markdown", async () => {
		const { plugin, fire } = await loadPlugin();
		noteCameras.save("Locked.md", camera);
		fire("rename", file("Locked.mdenc"), "Locked.md");
		expect(noteCameras.get("Locked.md")).toBeNull();
		expect(noteCameras.get("Locked.mdenc")).toBeNull();
		plugin.onunload();
	});

	it("is dropped when the note is deleted", async () => {
		const { plugin, fire } = await loadPlugin();
		noteCameras.save("Gone.md", camera);
		fire("delete", file("Gone.md"));
		expect(noteCameras.get("Gone.md")).toBeNull();
		plugin.onunload();
	});

	it("is cleared, for every note, when the plugin unloads", async () => {
		const { plugin } = await loadPlugin();
		noteCameras.save("One.md", camera);
		noteCameras.save("Two.md", { zoom: 2, left: 40, top: 0 });
		plugin.onunload();
		expect(noteCameras.get("One.md")).toBeNull();
		expect(noteCameras.get("Two.md")).toBeNull();
	});
});
