/**
 * The per-note Infinite Canvas override starts before the editor extension.
 *
 * `registerEditorExtension(inkOverlayExtension())` mounts an overlay in every
 * note already open when the plugin is enabled, and each overlay subscribes to
 * `onCanvasOverrideChanged` as it mounts. Before `canvasOverride.start` that
 * subscription is a no-op, so an overlay mounted at enable never heard a
 * per-note change until its note was reopened.
 *
 * The case loads the real `onload`. The stubbed `registerEditorExtension`
 * subscribes the way a mounting overlay does; a second listener subscribed
 * after the load is the control that shows the change is really delivered.
 */
import { afterEach, describe, expect, it } from "vitest";
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
import { NOTE_CANVAS_KEY, onCanvasOverrideChanged, setCanvasNoteOverrideForTest } from "./inline/CanvasNoteOverride";

const noop = () => {};
const emptyEventRef = {};

async function loadPlugin(onExtension: () => void) {
	const note = Object.assign(new TFile(), { path: "open.md", extension: "md" });
	const changedHandlers: ((...args: unknown[]) => unknown)[] = [];
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
			getAbstractFileByPath: (path: string) => (path === note.path ? note : null),
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
		metadataCache: {
			on: (name: string, handler: (...args: unknown[]) => unknown) => {
				if (name === "changed") changedHandlers.push(handler);
				return emptyEventRef;
			},
			getFileCache: () => null,
			getCache: () => null,
		},
		keymap: { pushScope: noop, popScope: noop },
		scope: {},
		fileManager: { processFrontMatter: async () => {} },
	};
	const plugin = new (HandwritingPlugin as unknown as new (
		app: unknown,
		manifest: unknown
	) => Record<string, unknown> & { onload(): Promise<void> })(app, {});
	Object.assign(plugin, {
		app,
		manifest: { id: "handwriting", version: "0.0.0-test", dir: ".obsidian/plugins/handwriting" },
		addCommand: (command: unknown) => command,
		registerView: noop,
		addSettingTab: noop,
		addRibbonIcon: () => ({ addClass: noop }),
		registerEvent: noop,
		registerDomEvent: noop,
		registerInterval: noop,
		registerEditorExtension: onExtension,
		registerMarkdownPostProcessor: noop,
		registerObsidianProtocolHandler: noop,
		register: noop,
		loadData: async () => ({}),
		saveData: async () => {},
	});
	await plugin.onload();
	const changeNote = async (fm: Record<string, unknown>) => {
		for (const handler of changedHandlers) await handler(note, "", { frontmatter: fm });
	};
	return { note, changeNote };
}

afterEach(() => setCanvasNoteOverrideForTest(null));

describe("the per-note canvas override starts before the editor extension", () => {
	it("an overlay mounted by registerEditorExtension hears a per-note change", async () => {
		const mounted: string[] = [];
		let subscribedAtMount = 0;
		const { note, changeNote } = await loadPlugin(() => {
			subscribedAtMount++;
			onCanvasOverrideChanged(path => mounted.push(path));
		});
		const control: string[] = [];
		onCanvasOverrideChanged(path => control.push(path));

		await changeNote({ [NOTE_CANVAS_KEY]: true });

		// The harness holds: the extension was registered once and the change
		// reached a listener subscribed after the load.
		expect(subscribedAtMount).toBe(1);
		expect(control).toEqual([note.path]);
		// The defect: the listener subscribed while the extension registered.
		expect(mounted).toEqual([note.path]);
	});
});
