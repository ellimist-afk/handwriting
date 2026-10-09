/**
 * A note renamed to another extension (an encryption plugin turns
 * note.md into note.mdenc; the code already knows this case, see
 * stemTwinExists). Both md rename handlers return on the NEW file's extension,
 * so the path-keyed inline record and the ownership ledger stay on "a.md".
 * A new, unrelated note created at a.md is then served the encrypted note's
 * page id: its first stroke is written into the other note's ink file.
 * Real onload; its own vault handlers are fired.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
	takeRecords() { return []; }
};
Object.assign(window, {
	setInterval: () => 0,
	clearInterval: () => {},
	document: (globalThis as Record<string, unknown>).document,
	matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
});

import HandwritingPlugin from "./main";
import { inlineInk } from "./inline/InkOverlay";

const ID = "a1b2c3d4-0000-4000-8000-0000000000aa";
const noop = () => {};

function tfile(path: string): TFile {
	const name = path.split("/").pop()!;
	const dot = name.lastIndexOf(".");
	return Object.assign(new TFile(), { path, name, extension: name.slice(dot + 1), basename: name.slice(0, dot) });
}

async function load() {
	const files = new Map<string, TFile>([["a.md", tfile("a.md")]]);
	const fm = new Map<string, Record<string, unknown>>([["a.md", { "handwriting-page-id": ID }]]);
	const vaultOn = new Map<string, ((...a: unknown[]) => unknown)[]>();
	const metaOn = new Map<string, ((...a: unknown[]) => unknown)[]>();
	const cache = (p: string) => (files.has(p) ? { frontmatter: fm.get(p), sections: [] } : null);
	const app = {
		loadLocalStorage: () => null,
		saveLocalStorage: noop,
		vault: {
			adapter: {
				exists: async () => false, read: async () => "", write: async () => {}, mkdir: async () => {},
				list: async () => ({ files: [], folders: [] }), stat: async () => null, remove: async () => {}, rename: async () => {},
			},
			on: (n: string, h: (...a: unknown[]) => unknown) => { vaultOn.set(n, [...(vaultOn.get(n) ?? []), h]); return {}; },
			getFileByPath: (p: string) => files.get(p) ?? null,
			getMarkdownFiles: () => [...files.values()],
			getFiles: () => [...files.values()],
			getAbstractFileByPath: (p: string) => files.get(p) ?? null,
			cachedRead: async () => "",
			read: async () => "",
			configDir: ".obsidian",
		},
		workspace: {
			layoutReady: true,
			on: () => ({}),
			onLayoutReady: (fn: () => void) => fn(),
			getLeavesOfType: () => [],
			getActiveFile: () => null,
			getActiveViewOfType: () => null,
			activeLeaf: null,
			iterateAllLeaves: noop,
			trigger: noop,
		},
		metadataCache: {
			on: (n: string, h: (...a: unknown[]) => unknown) => { metaOn.set(n, [...(metaOn.get(n) ?? []), h]); return {}; },
			getFileCache: (f: TFile) => cache(f.path),
			getCache: (p: string) => cache(p),
		},
		keymap: { pushScope: noop, popScope: noop },
		scope: {},
		fileManager: { processFrontMatter: async () => {} },
	};
	const plugin = new (HandwritingPlugin as unknown as new (a: unknown, m: unknown) => Record<string, unknown> & { onload(): Promise<void> })(app, {});
	Object.assign(plugin, {
		app,
		manifest: { id: "handwriting", version: "0.0.0-test", dir: ".obsidian/plugins/handwriting" },
		addCommand: (c: unknown) => c, registerView: noop, addSettingTab: noop, addRibbonIcon: () => ({ addClass: noop }),
		registerEvent: noop, registerDomEvent: noop, registerInterval: noop, registerEditorExtension: noop,
		registerMarkdownPostProcessor: noop, registerObsidianProtocolHandler: noop, register: noop,
		addStatusBarItem: () => ({ addClass: noop, setText: noop, toggleClass: noop }),
		loadData: async () => ({}), saveData: async () => {},
	});
	await plugin.onload();
	const fire = async (m: Map<string, ((...a: unknown[]) => unknown)[]>, n: string, ...args: unknown[]) => {
		for (const h of m.get(n) ?? []) await h(...args);
	};
	return { plugin, files, fm, fireVault: (n: string, ...a: unknown[]) => fire(vaultOn, n, ...a), fireMeta: (n: string, ...a: unknown[]) => fire(metaOn, n, ...a) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("a note renamed away from .md takes its ink identity with it", async () => {
	const r = await load();
	const ledger = r.plugin.pageIds as { owner(id: string): string | undefined };
	await inlineInk.ensureLoaded("a.md");
	expect(inlineInk.pageIdOf("a.md"), "the note was never loaded under its id, so this cell proves nothing").toBe(ID);

	// The encryption plugin renames the note.
	const enc = tfile("a.mdenc");
	r.files.delete("a.md");
	r.files.set("a.mdenc", enc);
	r.fm.delete("a.md");
	await r.fireVault("rename", enc, "a.md");
	// Later, a new and unrelated note is made at the old name.
	r.files.set("a.md", tfile("a.md"));
	r.fm.set("a.md", {});

	expect(inlineInk.pageIdOf("a.md"), "the new a.md is served the encrypted note's page id").toBeNull();
	expect(ledger.owner(ID), "the ledger names a path that no longer holds the id").not.toBe("a.md");
});
