/**
 * A PDF IDENTIFICATION STILL RUNNING WHEN THE PLUGIN UNLOADS DOES NOTHING AFTER onunload RETURNS.
 *
 * resolvePdfId awaits the PDF head, the sidecar list and the sidecar load. If the plugin is disabled across one of those awaits,
 * the continuation must not register a path claim in the store or write, and the plugin must not leave a timer or listener
 * behind it. Claims are session memory, so nothing needs releasing at unload; the oracle is only "no new effect after return".
 *
 * Loads the real onload, starts the real resolvePdfId, holds it at the sidecar load, unloads, then lets it settle.
 * movePdfClaimOnRename, the path that moves a claim for a PDF no pane shows, is held and unloaded the same way below.
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

const noop = () => {};
const emptyEventRef = {};

type Plugin = Record<string, any> & { onload(): Promise<void>; onunload(): void };

async function loadPlugin() {
	const writes: string[] = [];
	const domEvents: string[] = [];
	const intervals: string[] = [];
	const note = Object.assign(new TFile(), { path: "open.md", extension: "md" });
	const app = {
		loadLocalStorage: () => null,
		saveLocalStorage: noop,
		vault: {
			adapter: {
				exists: async () => false,
				read: async () => "",
				write: async (path: string) => { writes.push(path); },
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
			readBinary: async () => new TextEncoder().encode("%PDF-1.4 " + "x".repeat(2000)).buffer,
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
		registerDomEvent: (_t: unknown, type: string) => { domEvents.push(type); },
		registerInterval: (id: unknown) => { intervals.push(String(id)); return id; },
		registerEditorExtension: noop,
		registerMarkdownPostProcessor: noop,
		registerObsidianProtocolHandler: noop,
		register: noop,
		loadData: async () => ({}),
		saveData: async () => {},
	});
	await plugin.onload();
	return { plugin, writes, domEvents, intervals };
}

const pdf = (path: string) => Object.assign(new TFile(), { path, extension: "pdf" });

/** Starts the real resolvePdfId and holds it at the sidecar load (the last await before the claim). */
async function startHeldResolve(plugin: Plugin, path: string) {
	const file = pdf(path);
	const root = { isConnected: true } as unknown as HTMLElement;
	const controller = { refresh: noop, refreshStrip: noop };
	const claims: string[] = [];
	const store = plugin.pdfStore;
	const claimPath = store.claimPath.bind(store);
	const renamePath = store.renamePath.bind(store);
	store.claimPath = (id: string, p: string) => { claims.push(`claim ${id} ${p}`); return claimPath(id, p); };
	store.renamePath = (id: string, a: string, b: string) => { claims.push(`rename ${id} ${a} ${b}`); return renamePath(id, a, b); };
	let release: () => void = noop;
	let reached: () => void = noop;
	const atLoad = new Promise<void>((r) => { reached = r; });
	const gate = new Promise<void>((r) => { release = r; });
	store.ensureLoaded = async () => { reached(); await gate; return true; };
	plugin.pdfFiles.set(root, path);
	const settled = plugin.resolvePdfId({ view: { file } }, root, controller) as Promise<void>;
	await atLoad;
	return { claims, release, settled };
}

describe("a PDF identification in flight at unload", () => {
	it("control: with no unload, the finished identification claims the path", async () => {
		const { plugin } = await loadPlugin();
		const { claims, release, settled } = await startHeldResolve(plugin, "Lecture.pdf");
		release();
		await settled;
		expect(claims.filter((c) => c.endsWith("Lecture.pdf")).length).toBeGreaterThan(0);
	});

	it("registers no claim after onunload returns", async () => {
		const { plugin } = await loadPlugin();
		const { claims, release, settled } = await startHeldResolve(plugin, "Lecture.pdf");
		plugin.onunload();
		const before = claims.length;
		release();
		await settled;
		expect(claims.slice(before)).toEqual([]);
	});

	it("writes nothing to the vault after onunload returns", async () => {
		const { plugin, writes } = await loadPlugin();
		const { release, settled } = await startHeldResolve(plugin, "Lecture.pdf");
		plugin.onunload();
		// Let the unload's own persistence finish first, so only what the late continuation adds is counted.
		await new Promise((r) => setTimeout(r, 20));
		const before = writes.length;
		release();
		await settled;
		await new Promise((r) => setTimeout(r, 20));
		expect(writes.slice(before)).toEqual([]);
	});

	it("leaves no timer or listener registered after onunload returns", async () => {
		const { plugin, domEvents, intervals } = await loadPlugin();
		const { release, settled } = await startHeldResolve(plugin, "Lecture.pdf");
		plugin.onunload();
		const timers: number[] = [];
		const cleared = new Set<number>();
		const realSet = window.setTimeout;
		const realClear = window.clearTimeout;
		(window as any).setTimeout = (fn: () => void, ms?: number) => { const id = realSet(fn, ms) as unknown as number; timers.push(id); return id; };
		(window as any).clearTimeout = (id: number) => { cleared.add(id); return realClear(id); };
		const domBefore = domEvents.length;
		const intBefore = intervals.length;
		try {
			release();
			await settled;
			await new Promise((r) => setTimeout(r, 20));
		} finally {
			(window as any).setTimeout = realSet;
			(window as any).clearTimeout = realClear;
		}
		expect(timers.filter((t) => !cleared.has(t))).toEqual([]);
		expect(domEvents.slice(domBefore)).toEqual([]);
		expect(intervals.slice(intBefore)).toEqual([]);
	});
});


/**
 * The same shape on the other path that moves a PDF's claim: a PDF renamed while no pane shows it. movePdfClaimOnRename
 * awaits the head, the hash, the sidecar list, each sidecar's claims and the sidecar load before it moves the claim and
 * releases the record. Unloaded across one of those, it must move no claim and release nothing after onunload returns.
 */
async function startHeldMove(plugin: Plugin, oldPath: string, newPath: string) {
	const id = "held-instance";
	const claims: string[] = [];
	const released: string[] = [];
	const store = plugin.pdfStore;
	// The session already holds a claim on the old name, which is how the move finds the instance to move.
	store.claimedInstances = () => [{ id, paths: [oldPath] }];
	store.renamePath = (i: string, a: string, b: string) => { claims.push(`rename ${i} ${a} ${b}`); };
	const releasePdfId = plugin.releasePdfId.bind(plugin);
	plugin.releasePdfId = (i: string) => { released.push(i); return releasePdfId(i); };
	plugin.pdfHeadSource = () => ({ whole: async () => new Uint8Array(64) });
	let release: () => void = noop;
	let reached: () => void = noop;
	const atLoad = new Promise<void>((r) => { reached = r; });
	const gate = new Promise<void>((r) => { release = r; });
	store.ensureLoaded = async () => { reached(); await gate; return true; };
	const settled = plugin.movePdfClaimOnRename(pdf(newPath), oldPath) as Promise<void>;
	await atLoad;
	return { claims, released, release, settled };
}

describe("a PDF claim move in flight at unload", () => {
	it("control: with no unload, the finished move renames the claim and releases the record", async () => {
		const { plugin } = await loadPlugin();
		const { claims, released, release, settled } = await startHeldMove(plugin, "Old.pdf", "New.pdf");
		release();
		await settled;
		expect(claims).toEqual(["rename held-instance Old.pdf New.pdf"]);
		expect(released).toEqual(["held-instance"]);
	});

	it("moves no claim and releases nothing after onunload returns", async () => {
		const { plugin } = await loadPlugin();
		const { claims, released, release, settled } = await startHeldMove(plugin, "Old.pdf", "New.pdf");
		plugin.onunload();
		const before = { claims: claims.length, released: released.length };
		release();
		await settled;
		expect(claims.slice(before.claims), "MOVE AFTER UNLOAD: a claim moved after onunload returned").toEqual([]);
		expect(released.slice(before.released), "RELEASE AFTER UNLOAD: a record released after onunload returned").toEqual([]);
	});

	it("control: with two instances claiming the old name and no unload, the move loads both", async () => {
		const { loads, release, settled } = await startHeldTwoMove((await loadPlugin()).plugin);
		release();
		await settled;
		expect(loads).toEqual(["held-a", "held-b"]);
	});

	it("with two instances claiming the old name, starts no second sidecar load after onunload returns", async () => {
		const { plugin } = await loadPlugin();
		const { loads, release, settled } = await startHeldTwoMove(plugin);
		expect(loads, "premise: the move is held at the first instance's sidecar load").toEqual(["held-a"]);
		plugin.onunload();
		release();
		await settled;
		expect(loads.slice(1), "LOAD AFTER UNLOAD: a sidecar load started after onunload returned").toEqual([]);
	});
});

/** Two instances claim the old name; the move is held at the first one's sidecar load. */
async function startHeldTwoMove(plugin: Plugin) {
	const held = [{ id: "held-a", paths: ["Old.pdf"] }, { id: "held-b", paths: ["Old.pdf"] }];
	const store = plugin.pdfStore;
	// By id, the one instance asked for; the family scan matches no test id, so it gets both.
	store.claimedInstances = (match: (i: string) => boolean) => {
		const found = held.filter((h) => match(h.id));
		return found.length > 0 ? found : held;
	};
	store.renamePath = noop;
	plugin.pdfHeadSource = () => ({ whole: async () => new Uint8Array(64) });
	const loads: string[] = [];
	let release: () => void = noop;
	let reached: () => void = noop;
	const atLoad = new Promise<void>((r) => { reached = r; });
	const gate = new Promise<void>((r) => { release = r; });
	store.ensureLoaded = async (id: string) => { loads.push(id); reached(); await gate; return true; };
	const settled = plugin.movePdfClaimOnRename(pdf("New.pdf"), "Old.pdf") as Promise<void>;
	await atLoad;
	return { loads, release, settled };
}
