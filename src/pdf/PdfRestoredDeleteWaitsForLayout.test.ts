/**
 * A PDF deletion saved at the last quit, restored at the next cold start, waits for the layout before its grace.
 *
 * Obsidian loads every plugin before it lists the vault, and sets the layout ready only after that. A deletion still
 * in its grace at quit is restored when this plugin loads. Its retirement reads the vault's PDF list. Timed from the
 * load, on a large vault or a phone it ran before the vault was listed: a PDF back at its name read as gone, a sync
 * rename's new name read as absent, and the ink file went to the plugin's trash. The PDF then opened blank, with no
 * word.
 *
 * Wanted: no restored deletion is retired, and no claim of it moved by its retirement, before the layout is ready; the
 * grace starts there. Until then the waiting deletion still keeps an older same-bytes copy from taking the ink, and a
 * file's own open or rename, on the listed vault, still moves the ink to it. A live delete of the same path replaces
 * the restored one and keeps its own grace from the delete. A plugin turned on with the layout already ready keeps
 * today's timing. Unloaded before the layout is ready, nothing is armed and the saved deletion is kept for the next
 * start.
 *
 * Through the real plugin: its constructor, its onload and its unload, over an in-memory vault whose file list stays
 * empty until the test lists it, and a workspace whose layout callbacks wait until the test makes it ready.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(_message: string) {}
		hide() {}
	},
}));

import { TFile } from "obsidian";
import { installFakeWindow } from "../../test/routerHarness";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { parsePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

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
	crypto: globalThis.crypto,
});

import HandwritingPlugin from "../main";

/** The PDF that was deleted. */
const NAME = "Form.pdf";
/** The name a sync rename gave it while Obsidian was closed. */
const RENAMED = "Form renamed.pdf";
/** The name a rename gives it once the vault is listed, before the layout is ready. */
const MOVED = "Form moved.pdf";
/** An older same-bytes copy, in the vault throughout. */
const COPY = "Form copy.pdf";
/** Where this device keeps the deletions in their grace across a restart. */
const PENDING_KEY = "handwriting-pdf-pending-deletes";
/** RECYCLE_GRACE_MS. */
const GRACE = 10_000;
/** How long the vault stays unlisted, and the layout not ready, at the cold start. */
const UNLISTED = 12_000;

const noop = () => {};
const emptyEventRef = {};

type Plugin = Record<string, any> & { onload(): Promise<void>; onunload(): void };

/** Every plugin a cell loaded: one a cell left loaded is unloaded after it, so its surfaces do not reach the next. */
const loaded: Plugin[] = [];

afterEach(() => {
	vi.useRealTimers();
	for (const plugin of loaded.splice(0)) if (!plugin.unloaded) plugin.onunload();
	vi.restoreAllMocks();
});

function stroke(x: number, id: string): InkStroke {
	return {
		id,
		page: 1,
		tool: "pen",
		color: "#111111",
		width: 2,
		createdAt: 0,
		points: [
			{ x, y: 10, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x, y: 10, width: 10, height: 10 },
	};
}

/** One vault (disk, file list, this device's local storage) shared by every plugin session. */
function vault() {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	adapter.list = async (folder: string) => {
		const files = [...adapter.files.keys()].filter(
			(p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")
		);
		return { files, folders: [] };
	};
	// Every PDF here holds the same bytes.
	const pdfBytes = new TextEncoder().encode(
		"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + "x".repeat(5000) + "\n%%EOF\n"
	);
	/** The PDFs on disk. */
	const files = new Set<string>();
	/** Whether the app has listed the vault yet: until then it answers no file. */
	const state = { listed: true };
	const local = new Map<string, unknown>();
	function sidecar(id: string) {
		const bytes = adapter.files.get(`.handwriting/${id}.json`);
		return bytes === undefined ? undefined : parsePage(bytes, id).data;
	}
	/** The strokes of every ink file in the trash, one list per file. */
	function trashInk(): string[][] {
		return [...adapter.files.entries()]
			.filter(([p]) => p.includes("/trash/"))
			.map(([p, bytes]) => parsePage(bytes, p).data.strokes.map((s) => s.id));
	}
	function savedDeletions(): string[] {
		const raw = local.get(PENDING_KEY);
		return typeof raw === "string" ? (JSON.parse(raw) as { path: string }[]).map((e) => e.path) : [];
	}
	return { adapter, pdfBytes, files, state, local, sidecar, trashInk, savedDeletions };
}

function pdfFile(path: string) {
	return Object.assign(new TFile(), {
		path,
		extension: "pdf",
		name: path.split("/").pop(),
		basename: path.replace(/\.[^.]+$/, ""),
	});
}

/**
 * The real plugin, constructed and loaded over the shared vault. With `ready` false the layout is not ready: every
 * onLayoutReady callback waits for `ready()`, as Obsidian holds them until it has listed the vault and loaded the
 * layout.
 */
async function loadPlugin(v: ReturnType<typeof vault>, opts: { ready: boolean }) {
	const layoutQueue: (() => void)[] = [];
	const listed = () => (v.state.listed ? [...v.files] : []);
	/** The vault event handlers the plugin registered, by event name, so a cell can fire one as Obsidian would. */
	const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
	const workspace = {
		layoutReady: opts.ready,
		on: () => emptyEventRef,
		onLayoutReady: (fn: () => void) => {
			if (workspace.layoutReady) fn();
			else layoutQueue.push(fn);
		},
		getLeavesOfType: () => [],
		getActiveFile: () => null,
		getActiveViewOfType: () => null,
		activeLeaf: null,
		iterateAllLeaves: noop,
		trigger: noop,
	};
	const app = {
		loadLocalStorage: (key: string) => v.local.get(key) ?? null,
		saveLocalStorage: (key: string, value: unknown) => {
			if (value === null) v.local.delete(key);
			else v.local.set(key, value);
		},
		vault: {
			adapter: v.adapter,
			on: (name: string, fn: (...args: unknown[]) => void) => {
				handlers.set(name, [...(handlers.get(name) ?? []), fn]);
				return emptyEventRef;
			},
			getFiles: () => listed().map((path) => pdfFile(path)),
			getFileByPath: (p: string) => (listed().includes(p) ? pdfFile(p) : null),
			getMarkdownFiles: () => [],
			getAbstractFileByPath: (p: string) => (listed().includes(p) ? pdfFile(p) : null),
			cachedRead: async () => "",
			readBinary: async () => v.pdfBytes.slice().buffer,
			read: async () => "",
			configDir: ".obsidian",
		},
		workspace,
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
	loaded.push(plugin);
	await plugin.onload();
	/** The app has loaded the layout: the layout is ready, and every callback that waited for it runs. */
	function ready() {
		workspace.layoutReady = true;
		for (const fn of layoutQueue.splice(0)) fn();
	}
	async function open(path: string) {
		expect(listed().includes(path), `precondition: the vault lists ${path}`).toBe(true);
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, syncForTool() {}, idle: true };
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId({ view: { file: pdfFile(path) } }, root, controller);
		return { root, id: plugin.pdfIds.get(root) as string };
	}
	function close(root: HTMLElement) {
		(root as unknown as { isConnected: boolean }).isConnected = false;
		plugin.pdfInk.delete(root);
		plugin.pdfIds.delete(root);
		plugin.pdfFiles.delete(root);
	}
	/** The vault renamed `from` to `to`: the files move, then every rename handler hears it. */
	function rename(from: string, to: string) {
		v.files.delete(from);
		v.files.add(to);
		const handlersNow = handlers.get("rename") ?? [];
		expect(handlersNow.length, "precondition: the plugin registered a rename handler").toBeGreaterThan(0);
		for (const fn of handlersNow) fn(pdfFile(to), from);
	}
	return { plugin, ready, open, close, rename, waiting: () => layoutQueue.length };
}

/**
 * NAME inked in one session, then deleted, and Obsidian quit inside the grace: the deletion is saved for the next
 * start. Returns the ink file's id.
 */
async function deletedAtQuit(v: ReturnType<typeof vault>): Promise<string> {
	v.files.add(NAME);
	const s = await loadPlugin(v, { ready: true });
	const o = await s.open(NAME);
	s.plugin.pdfStore.replaceAll(o.id, [stroke(10, "ink-0")]);
	await s.plugin.store.flush();
	s.close(o.root);
	expect(v.sidecar(o.id)?.pdfPaths, "precondition: the ink file claims the name only").toEqual([NAME]);
	v.files.delete(NAME);
	await s.plugin.onFileDeleted(pdfFile(NAME));
	s.plugin.onunload();
	await s.plugin.store.flush();
	expect(v.savedDeletions(), "precondition: the deletion was saved for the next start").toEqual([NAME]);
	expect(v.sidecar(o.id)?.pdfPaths, "precondition: the ink file is still on disk at quit").toEqual([NAME]);
	return o.id;
}

/** A cold start: the plugin loads before the vault is listed, and the layout is not ready. */
async function coldStart(v: ReturnType<typeof vault>) {
	v.state.listed = false;
	vi.useFakeTimers();
	const s = await loadPlugin(v, { ready: false });
	expect(s.plugin.pdfStore.pendingClaims().has(NAME), "precondition: the saved deletion was restored at load").toBe(true);
	return s;
}

/** The app lists the vault and loads the layout. */
function listAndReady(v: ReturnType<typeof vault>, s: Awaited<ReturnType<typeof loadPlugin>>) {
	v.state.listed = true;
	s.ready();
}

/** Run every grace and retry out, and let each retirement and write finish. */
async function settle(s: Awaited<ReturnType<typeof loadPlugin>>) {
	await vi.advanceTimersByTimeAsync(GRACE + 1);
	await vi.waitFor(() => expect(s.plugin.pdfStore.pendingClaims().size).toBe(0));
	await s.plugin.store.flush();
}

describe("a PDF deletion saved at the last quit, restored at a cold start before the vault is listed", () => {
	it("the PDF is back at its name (restored from the trash while Obsidian was closed), the vault unlisted for 12 s: its ink file stays and it opens with its ink", async () => {
		const v = vault();
		const id = await deletedAtQuit(v);
		v.files.add(NAME);
		const s = await coldStart(v);
		await vi.advanceTimersByTimeAsync(UNLISTED);
		expect(v.trashInk(), "the ink went to the trash before the vault was listed").toEqual([]);
		expect(v.sidecar(id)?.pdfPaths, "the ink file left the name before the vault was listed").toEqual([NAME]);
		listAndReady(v, s);
		await settle(s);
		vi.useRealTimers();
		expect(v.trashInk(), "the ink of a PDF back at its name went to the trash").toEqual([]);
		expect(v.sidecar(id)?.pdfPaths, "the ink file no longer claims the name").toEqual([NAME]);
		const o = await s.open(NAME);
		expect(o.id, "the PDF opened another ink file").toBe(id);
		expect(s.plugin.pdfStore.strokes(o.id).map((x: InkStroke) => x.id), "the PDF opened without its ink").toEqual(["ink-0"]);
	});

	it("a sync renamed the PDF while Obsidian was closed (a delete, then a create under the new name), the vault unlisted for 12 s: the ink follows the new name and nothing goes to the trash", async () => {
		const v = vault();
		const id = await deletedAtQuit(v);
		v.files.add(RENAMED);
		const s = await coldStart(v);
		await vi.advanceTimersByTimeAsync(UNLISTED);
		expect(v.trashInk(), "the ink went to the trash before the vault was listed").toEqual([]);
		listAndReady(v, s);
		await settle(s);
		vi.useRealTimers();
		expect(v.trashInk(), "the ink of a renamed PDF went to the trash").toEqual([]);
		expect(v.sidecar(id)?.pdfPaths, "the ink file does not claim the new name").toEqual([RENAMED]);
		const o = await s.open(RENAMED);
		expect(o.id, "the renamed PDF opened another ink file").toBe(id);
		expect(s.plugin.pdfStore.strokes(o.id).map((x: InkStroke) => x.id), "the renamed PDF opened without its ink").toEqual(["ink-0"]);
	});

	it("the PDF is really gone and the layout is ready at 12 s: the ink file stays until 10 s after ready, then goes to the trash whole", async () => {
		const v = vault();
		const id = await deletedAtQuit(v);
		const s = await coldStart(v);
		await vi.advanceTimersByTimeAsync(UNLISTED);
		expect(v.sidecar(id)?.pdfPaths, "the ink file was retired before the layout was ready").toEqual([NAME]);
		listAndReady(v, s);
		await vi.advanceTimersByTimeAsync(GRACE - 100);
		await s.plugin.store.flush();
		expect(v.sidecar(id)?.pdfPaths, "the ink file was retired less than 10 s after the layout was ready").toEqual([NAME]);
		expect(v.trashInk(), "ink went to the trash less than 10 s after the layout was ready").toEqual([]);
		await settle(s);
		vi.useRealTimers();
		expect(v.sidecar(id), "the deleted PDF's ink file still claims the name 10 s after ready").toBeUndefined();
		expect(v.trashInk(), "the trash holds the deleted PDF's ink, strokes whole, and nothing else").toEqual([["ink-0"]]);
		expect(v.savedDeletions(), "the retired deletion is still saved for the next start").toEqual([]);
	});

	it("CONTROL: the plugin turned on with the layout already ready: a PDF really gone is retired 10 s after the load, as before", async () => {
		const v = vault();
		const id = await deletedAtQuit(v);
		vi.useFakeTimers();
		const s = await loadPlugin(v, { ready: true });
		expect(s.plugin.pdfStore.pendingClaims().has(NAME), "precondition: the saved deletion was restored at load").toBe(true);
		await vi.advanceTimersByTimeAsync(GRACE - 100);
		await s.plugin.store.flush();
		expect(v.sidecar(id)?.pdfPaths, "the ink file was retired less than 10 s after the load").toEqual([NAME]);
		await settle(s);
		vi.useRealTimers();
		expect(v.sidecar(id), "the deleted PDF's ink file still claims the name 10 s after the load").toBeUndefined();
		expect(v.trashInk(), "the trash holds the deleted PDF's ink, strokes whole, and nothing else").toEqual([["ink-0"]]);
	});

	it("the vault is listed 11 s in, the layout not ready yet, and an older same-bytes copy opens then: the deletion is still waiting and keeps the copy from taking the ink", async () => {
		const v = vault();
		v.files.add(COPY);
		const id = await deletedAtQuit(v);
		const s = await coldStart(v);
		await vi.advanceTimersByTimeAsync(UNLISTED - 1_000);
		v.state.listed = true;
		expect(s.plugin.pdfStore.pendingClaims().has(NAME), "the deletion stopped waiting before the layout was ready").toBe(true);
		expect(v.sidecar(id)?.pdfPaths, "the ink file was retired before the layout was ready").toEqual([NAME]);
		const o = await s.open(COPY);
		expect(o.id, "the older copy took the deleted PDF's ink file while its deletion waited").not.toBe(id);
		expect(s.plugin.pdfStore.strokes(o.id).map((x: InkStroke) => x.id), "the older copy opened wearing the deleted PDF's ink").toEqual([]);
		s.close(o.root);
		await s.plugin.store.flush();
		expect(v.sidecar(id)?.pdfPaths, "the older copy's open moved the deleted PDF's claim").toEqual([NAME]);
		s.ready();
		await settle(s);
		vi.useRealTimers();
		expect(v.sidecar(id), "the deleted PDF's ink file still claims the name 10 s after ready").toBeUndefined();
		expect(v.trashInk(), "the trash holds the deleted PDF's ink, strokes whole, and nothing else").toEqual([["ink-0"]]);
	});

	it("CONTROL: unloaded before the layout is ready: nothing is retired after, and the saved deletion is kept for the next start", async () => {
		const v = vault();
		const id = await deletedAtQuit(v);
		const s = await coldStart(v);
		await vi.advanceTimersByTimeAsync(5_000);
		s.plugin.onunload();
		listAndReady(v, s);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		await s.plugin.store.flush();
		vi.useRealTimers();
		expect(v.sidecar(id)?.pdfPaths, "the ink file was retired after the plugin unloaded").toEqual([NAME]);
		expect(v.trashInk(), "ink went to the trash after the plugin unloaded").toEqual([]);
		expect(v.savedDeletions(), "the saved deletion was dropped at unload").toEqual([NAME]);
	});

	it("a live delete of the same PDF 11 s in, the vault listed and the layout not ready: it replaces the restored deletion, and the ink goes to the trash once, 10 s after the live delete", async () => {
		const v = vault();
		const id = await deletedAtQuit(v);
		v.files.add(NAME);
		const s = await coldStart(v);
		await vi.advanceTimersByTimeAsync(UNLISTED - 1_000);
		v.state.listed = true;
		expect(v.trashInk(), "the ink went to the trash before the vault was listed").toEqual([]);
		v.files.delete(NAME);
		await s.plugin.onFileDeleted(pdfFile(NAME));
		await vi.advanceTimersByTimeAsync(1_000);
		s.ready();
		await vi.advanceTimersByTimeAsync(GRACE - 1_000 - 100);
		await s.plugin.store.flush();
		expect(v.sidecar(id)?.pdfPaths, "the ink file was retired less than 10 s after the live delete").toEqual([NAME]);
		expect(v.trashInk(), "ink went to the trash less than 10 s after the live delete").toEqual([]);
		await vi.advanceTimersByTimeAsync(200);
		await vi.waitFor(() => expect(s.plugin.pdfStore.pendingClaims().size).toBe(0));
		await s.plugin.store.flush();
		expect(v.sidecar(id), "the ink file still claims the name 10 s after the live delete").toBeUndefined();
		expect(v.trashInk(), "the trash holds the deleted PDF's ink once, strokes whole").toEqual([["ink-0"]]);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		await s.plugin.store.flush();
		vi.useRealTimers();
		expect(v.trashInk(), "a second retirement ran after the live one").toEqual([["ink-0"]]);
		expect(v.savedDeletions(), "the retired deletion is still saved for the next start").toEqual([]);
	});

	it("a sync renamed the PDF while Obsidian was closed, and the new name opens 11 s in, the vault listed and the layout not ready: the ink follows at the open and nothing goes to the trash", async () => {
		const v = vault();
		const id = await deletedAtQuit(v);
		v.files.add(RENAMED);
		const s = await coldStart(v);
		await vi.advanceTimersByTimeAsync(UNLISTED - 1_000);
		v.state.listed = true;
		expect(v.trashInk(), "the ink went to the trash before the vault was listed").toEqual([]);
		const o = await s.open(RENAMED);
		expect(o.id, "the renamed PDF opened another ink file").toBe(id);
		expect(s.plugin.pdfStore.strokes(o.id).map((x: InkStroke) => x.id), "the renamed PDF opened without its ink").toEqual(["ink-0"]);
		s.close(o.root);
		s.ready();
		await settle(s);
		vi.useRealTimers();
		expect(v.trashInk(), "the ink of a renamed PDF went to the trash").toEqual([]);
		expect(v.sidecar(id)?.pdfPaths, "the ink file does not claim the new name").toEqual([RENAMED]);
	});

	it("the PDF is back at its name and renamed 11 s in, the vault listed and the layout not ready: the ink follows the rename and nothing goes to the trash", async () => {
		const v = vault();
		const id = await deletedAtQuit(v);
		v.files.add(NAME);
		const s = await coldStart(v);
		await vi.advanceTimersByTimeAsync(UNLISTED - 1_000);
		v.state.listed = true;
		expect(v.trashInk(), "the ink went to the trash before the vault was listed").toEqual([]);
		s.rename(NAME, MOVED);
		await vi.advanceTimersByTimeAsync(0);
		await s.plugin.store.flush();
		s.ready();
		await settle(s);
		vi.useRealTimers();
		expect(v.trashInk(), "the ink of a renamed PDF went to the trash").toEqual([]);
		expect(v.sidecar(id)?.pdfPaths, "the ink file does not claim the new name").toEqual([MOVED]);
		const o = await s.open(MOVED);
		expect(o.id, "the renamed PDF opened another ink file").toBe(id);
		expect(s.plugin.pdfStore.strokes(o.id).map((x: InkStroke) => x.id), "the renamed PDF opened without its ink").toEqual(["ink-0"]);
	});
});
