import { describe, expect, it, vi } from "vitest";
import { installFakeWindow } from "../../test/routerHarness";

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
	setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
	clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
	document: (globalThis as Record<string, unknown>).document,
	matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	crypto: globalThis.crypto,
});

const painted: Array<() => readonly { id: string }[]> = [];
let editorHolds: string | null = null;
vi.mock("../inline/InkOverlay", async (importOriginal) => {
	const orig = await importOriginal<Record<string, unknown>>();
	return {
		...orig,
		overlayForPath: (p: string) => (editorHolds === p ? ({} as unknown) : (orig.overlayForPath as (q: string) => unknown)(p)),
	};
});
const notices: unknown[][] = [];
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(...args: unknown[]) {
			notices.push(args);
		}
	},
}));
vi.mock("../inline/EmbedInk", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	attachEmbedInkOnceReady: (_el: unknown, _c: unknown, _p: string, strokes: () => readonly { id: string }[]) => {
		painted.push(strokes);
		return () => {};
	},
}));

import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { emptyPage, type PageData } from "../model/PageData";
import { onInkChanged } from "../inline/InkEvents";

function pageOf(ID: string, ...labels: string[]): string {
	const p: PageData = emptyPage(ID);
	p.surface = "inline";
	p.strokes = labels.map((label) => ({
		id: label, tool: "pen", color: "#4b7bec", width: 2.2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 0 },
		createdAt: 0,
	}));
	return JSON.stringify(p);
}

const noop = () => {};
const ref = {};

async function loadPlugin(NOTE: string, ID: string) {
	const adapter = new FakeAdapter() as FakeAdapter & { list(f: string): Promise<{ files: string[]; folders: string[] }> };
	adapter.list = async (folder: string) => ({
		files: [...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")),
		folders: [],
	});
	const noteFile = { path: NOTE, extension: "md", name: NOTE, basename: "Note", stat: { mtime: 1, ctime: 1, size: 1 } };
	const app = {
		loadLocalStorage: () => null,
		saveLocalStorage: noop,
		vault: {
			adapter,
			on: () => ref,
			getFileByPath: (p: string) => (p === NOTE ? noteFile : null),
			getMarkdownFiles: () => [noteFile],
			getFiles: () => [noteFile],
			getAbstractFileByPath: (p: string) => (p === NOTE ? noteFile : null),
			cachedRead: async () => `---\nhandwriting-page-id: ${ID}\n---\nbody\n`,
			configDir: ".obsidian",
		},
		workspace: {
			on: () => ref,
			onLayoutReady: (fn: () => void) => fn(),
			getLeavesOfType: () => [],
			getActiveFile: () => null,
			getActiveViewOfType: () => null,
			activeLeaf: null,
			iterateAllLeaves: noop,
			trigger: noop,
		},
		metadataCache: {
			on: () => ref,
			getFileCache: (f: { path: string }) => (f.path === NOTE ? { frontmatter: { "handwriting-page-id": ID } } : null),
			getCache: () => null,
		},
		keymap: { pushScope: noop, popScope: noop },
		scope: {},
		fileManager: { processFrontMatter: async () => {} },
	};
	const postProcessors: Array<(el: unknown, ctx: unknown) => void> = [];
	const plugin = new (HandwritingPlugin as unknown as new (a: unknown, m: unknown) => Record<string, unknown> & {
		onload(): Promise<void>;
		store: { inkFolder(): string };
	})(app, {});
	Object.assign(plugin, {
		app,
		manifest: { id: "handwriting", version: "0.0.0-test", dir: ".obsidian/plugins/handwriting" },
		addCommand: (c: unknown) => c,
		registerView: noop,
		addSettingTab: noop,
		addRibbonIcon: () => ({ addClass: noop }),
		registerEvent: noop,
		registerDomEvent: noop,
		registerInterval: noop,
		registerEditorExtension: noop,
		registerMarkdownPostProcessor: (fn: (el: unknown, ctx: unknown) => void) => postProcessors.push(fn),
		registerObsidianProtocolHandler: noop,
		register: noop,
		loadData: async () => ({}),
		saveData: async () => {},
	});
	await plugin.onload();
	const folder = plugin.store.inkFolder();
	return { adapter, plugin, postProcessors, sidecar: `${folder}/${ID}.json` };
}

function renderEmbed(NOTE: string, pp: (el: unknown, ctx: unknown) => void) {
	const el = { isConnected: false, parentElement: null, classList: classSink, closest: () => null };
	const ctx = {
		sourcePath: NOTE,
		containerEl: null,
		getSectionInfo: () => null,
		addChild: (child: { onload?: () => void }) => child.onload?.(),
	};
	pp(el, ctx);
}

describe("J1D-90: a cached note shown again serves the newer synced sidecar", () => {
	it("A (control): reopening in an editor adopts the newer copy", async () => {
		const NOTE = "A.md", ID = "pg-j1d90a";
		const { adapter, sidecar } = await loadPlugin(NOTE, ID);
		adapter.externalWrite(sidecar, pageOf(ID, "old"));
		await inlineInk.ensureLoaded(NOTE);
		expect(inlineInk.strokes(NOTE).map((s) => s.id)).toEqual(["old"]);
		adapter.externalWrite(sidecar, pageOf(ID, "old", "theirs-new"));
		await inlineInk.ensureLoaded(NOTE);
		expect(inlineInk.strokes(NOTE).map((s) => s.id)).toEqual(["old", "theirs-new"]);
	});

	it("B: an embed (or reading view) of the note, rendered after the sync, shows the newer ink", async () => {
		const NOTE = "B.md", ID = "pg-j1d90b";
		const { adapter, postProcessors, sidecar } = await loadPlugin(NOTE, ID);
		expect(postProcessors.length).toBeGreaterThan(0);
		adapter.externalWrite(sidecar, pageOf(ID, "old2"));
		painted.length = 0;
		for (const pp of postProcessors) renderEmbed(NOTE, pp);
		await vi.waitFor(() => expect(painted.length).toBeGreaterThan(0));
		await vi.waitFor(() => expect(painted[0]!().map((s) => s.id)).toEqual(["old2"]));
		adapter.externalWrite(sidecar, pageOf(ID, "old2", "theirs-new2"));
		painted.length = 0;
		for (const pp of postProcessors) renderEmbed(NOTE, pp);
		await vi.waitFor(() => expect(painted.length).toBeGreaterThan(0));
		await new Promise((r) => setTimeout(r, 200));
		expect(painted[0]!().map((s) => s.id), "embed painted the stale cached record").toEqual(["old2", "theirs-new2"]);
	});

	it("C: two embeds of the note rendered together adopt once, repaint once each, write nothing and show no notice", async () => {
		const NOTE = "C.md", ID = "pg-j1d90c";
		const { adapter, postProcessors, sidecar } = await loadPlugin(NOTE, ID);
		adapter.externalWrite(sidecar, pageOf(ID, "old3"));
		painted.length = 0;
		for (const pp of postProcessors) renderEmbed(NOTE, pp);
		await vi.waitFor(() => expect(painted.length).toBeGreaterThan(0));
		await vi.waitFor(() => expect(painted[0]!().map((s) => s.id)).toEqual(["old3"]));
		adapter.externalWrite(sidecar, pageOf(ID, "old3", "theirs-new3"));
		const filesBefore = [...adapter.files.keys()].sort();
		const writesBefore = adapter.writes().length;
		const changed: string[] = [];
		const off = onInkChanged((p) => changed.push(p));
		painted.length = 0;
		notices.length = 0;
		for (const pp of postProcessors) renderEmbed(NOTE, pp);
		for (const pp of postProcessors) renderEmbed(NOTE, pp);
		await vi.waitFor(() => expect(painted.length).toBeGreaterThanOrEqual(2));
		await new Promise((r) => setTimeout(r, 200));
		off();
		expect(painted.length, "two embeds, each attached once").toBe(2);
		for (const strokes of painted) expect(strokes().map((s) => s.id)).toEqual(["old3", "theirs-new3"]);
		expect(changed, "one adoption, one repaint notification").toEqual([NOTE]);
		expect(adapter.writes().length, "nothing written back").toBe(writesBefore);
		expect([...adapter.files.keys()].sort(), "no conflict copy").toEqual(filesBefore);
		expect(notices, "no notice").toEqual([]);
	});

	it("D: an embed rendered while an editor pane holds the note does not adopt from the embed path", async () => {
		const NOTE = "D.md", ID = "pg-j1d90d";
		const { adapter, postProcessors, sidecar } = await loadPlugin(NOTE, ID);
		adapter.externalWrite(sidecar, pageOf(ID, "old4"));
		painted.length = 0;
		for (const pp of postProcessors) renderEmbed(NOTE, pp);
		await vi.waitFor(() => expect(painted.length).toBeGreaterThan(0));
		await vi.waitFor(() => expect(painted[0]!().map((s) => s.id)).toEqual(["old4"]));
		adapter.externalWrite(sidecar, pageOf(ID, "old4", "theirs-new4"));
		const changed: string[] = [];
		const off = onInkChanged((p) => changed.push(p));
		editorHolds = NOTE;
		try {
			painted.length = 0;
			for (const pp of postProcessors) renderEmbed(NOTE, pp);
			await vi.waitFor(() => expect(painted.length).toBeGreaterThan(0));
			await new Promise((r) => setTimeout(r, 200));
			expect(painted[0]!().map((s) => s.id), "the editor pane's poll owns the adoption, not the embed").toEqual(["old4"]);
			expect(changed, "no repaint notification from the embed path").toEqual([]);
		} finally {
			editorHolds = null;
		}
		// Control: with no editor pane on the note the embed refreshes as before.
		painted.length = 0;
		for (const pp of postProcessors) renderEmbed(NOTE, pp);
		await vi.waitFor(() => expect(painted.length).toBeGreaterThan(0));
		await new Promise((r) => setTimeout(r, 200));
		off();
		expect(painted[0]!().map((s) => s.id)).toEqual(["old4", "theirs-new4"]);
		expect(changed).toEqual([NOTE]);
	});
});
