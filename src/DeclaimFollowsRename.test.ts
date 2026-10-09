/**
 * A note's page id is removed by hand, then the note is renamed
 * inside the 5 s declaim grace. The grace timer is keyed by the OLD path; at
 * fire time getFileByPath(old) is null and it returns without declaiming.
 * Nothing re-arms it (a rename sends no metadata "changed"), so the note's
 * session record and the ownership ledger keep the removed id for the rest of
 * the session. Real onload; its own vault/metadata handlers are fired.
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
	return Object.assign(new TFile(), { path, name, extension: "md", basename: name.replace(/\.md$/, "") });
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

it("a removed page id is still given up when the note is renamed inside the declaim grace", async () => {
	const declaimed = vi.spyOn(inlineInk, "handleDeclaimed");
	const r = await load();
	const ledger = r.plugin.pageIds as { owner(id: string): string | undefined };
	expect(ledger.owner(ID), "the census never registered the note, so this cell proves nothing").toBe("a.md");

	// The user deletes the handwriting-page-id line.
	r.fm.set("a.md", {});
	await r.fireMeta("changed", r.files.get("a.md"), "", { frontmatter: {}, sections: [] });
	// ...and renames the note two seconds later.
	await vi.advanceTimersByTimeAsync(2_000);
	const moved = tfile("b.md");
	r.files.delete("a.md");
	r.files.set("b.md", moved);
	r.fm.set("b.md", {});
	await r.fireVault("rename", moved, "a.md");
	await vi.advanceTimersByTimeAsync(10_000);

	expect(declaimed.mock.calls.map((c) => c[0]), "the note's session record kept the removed id").toContain("b.md");
	expect(ledger.owner(ID), "the ledger still says b.md owns an id it no longer carries").toBeUndefined();
});

it("control: without the rename the same edit is declaimed after the grace", async () => {
	const declaimed = vi.spyOn(inlineInk, "handleDeclaimed");
	const r = await load();
	const ledger = r.plugin.pageIds as { owner(id: string): string | undefined };
	r.fm.set("a.md", {});
	await r.fireMeta("changed", r.files.get("a.md"), "", { frontmatter: {}, sections: [] });
	await vi.advanceTimersByTimeAsync(10_000);
	expect(declaimed.mock.calls.map((c) => c[0])).toContain("a.md");
	expect(ledger.owner(ID)).toBeUndefined();
});
