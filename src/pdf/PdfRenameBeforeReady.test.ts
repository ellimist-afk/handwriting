/**
 * A PDF renamed or moved on another device and synced in while Obsidian starts: its create is heard before the layout
 * is ready, where every file in the vault is reported as created. These cells run that order through the plugin's own
 * vault handlers, its real page and PDF ink stores, and this device's record of the PDF paths it saw, kept in the
 * device's local store from one session to the next as the app keeps it.
 *
 * A create before ready at a path the record never held is the new file: a same-bytes PDF deleted inside the grace
 * hands it its ink. Every other answer is "it existed", today's result: the ink goes to the trash. That holds for a
 * path the record holds, live or ended, whatever its stat now; for no record, an unreadable one, or one too large to
 * keep; and for one path in two Unicode forms.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(_message: string) {}
	},
}));

import HandwritingPlugin from "../main";
import { TFile, Notice } from "obsidian";
import pluginSettingsSource from "../settings/PluginSettings.ts?raw";
import pluginOnloadSource from "../PluginOnload.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { RECYCLE_GRACE_MS } from "../ink/RecycleOnDelete";
import { parsePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const OLD = "Old.pdf";
const NEW = "New.pdf";
const TEMPLATE = "Template.pdf";
/** One name in its two Unicode forms: composed, and decomposed as macOS hands it over. */
const COMPOSED = `Caf${String.fromCharCode(0xe9)}.pdf`;
const DECOMPOSED = COMPOSED.normalize("NFD");
expect(DECOMPOSED).not.toBe(COMPOSED);
/** The device's local store keys for the record and for its events since the last whole write. */
const SEEN_KEY = "handwriting-pdf-seen-paths";
const SEEN_EVENTS_KEY = "handwriting-pdf-seen-paths-events";

// The production host registration, as PdfIdentityRouting.test.ts runs it.
const source = pluginSettingsSource.replace(/\r\n/g, "\n");
const hostStart = "\t\tthis.pdfStore.attachHost({";
expect(source.split(hostStart)).toHaveLength(2);
const hostAt = source.indexOf(hostStart);
const hostEnd = source.indexOf("\n\t\t});", hostAt);
expect(hostEnd).toBeGreaterThan(hostAt);
const installPdfHost = new Function("Notice", "blockNotice", source.slice(hostAt, hostEnd + "\n\t\t});".length));

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

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** One vault (disk, PDF list and stats) and this device's local store, shared by every session. */
function vault() {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	const inFolder = (folder: string) =>
		[...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/"));
	adapter.list = async (folder: string) => {
		const files = inFolder(folder);
		// The host reads the folder first: one that is not there rejects at the read.
		if (files.length === 0 && !adapter.dirs.has(folder)) {
			throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${folder}'`), { code: "ENOENT" });
		}
		return { files, folders: [] };
	};
	// A folder is there while it holds a file, as on disk.
	const exists = adapter.exists.bind(adapter);
	adapter.exists = async (p: string) => (await exists(p)) || inFolder(p).length > 0;
	// Every PDF here holds the same bytes.
	const pdfBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + "x".repeat(5000) + "\n%%EOF\n");
	return {
		adapter,
		pdfBytes,
		files: new Set<string>(),
		/** A stat other than the default, per path. */
		stats: new Map<string, { size: number; mtime: number }>(),
		/** This device's local store, which outlives a session. */
		local: new Map<string, unknown>(),
		/** The local store refuses to load the record. */
		seenLoadThrows: false,
		sidecar(id: string) {
			const bytes = adapter.files.get(`.handwriting/${id}.json`);
			return bytes === undefined ? undefined : parsePage(bytes, id).data;
		},
		inTrash(id: string) {
			return [...adapter.files.keys()].some((p) => p.includes("/trash/") && p.includes(id));
		},
	};
}
type Vault = ReturnType<typeof vault>;

const statOf = (v: Vault, path: string) => ({ ctime: 0, ...(v.stats.get(path) ?? { size: v.pdfBytes.byteLength, mtime: 1 }) });

/** A vault file as the vault's events hand it over, with its stat. */
function pdfFile(v: Vault, path: string) {
	return Object.assign(new TFile(), {
		path,
		extension: "pdf",
		name: path.split("/").pop(),
		basename: path.replace(/\.[^.]+$/, ""),
		stat: statOf(v, path),
	});
}

type RetireSpy = { mock: { results: { value: unknown }[] } };

/**
 * A plugin session (fresh memory) over the shared vault, as onload builds it: the PDF ink store waits for the layout,
 * the deletions in their grace and this device's record are attached, then the plugin's own vault handlers, then the
 * listing of the vault's PDFs into the record at ready (the load's own layout callback, pinned below). `ready` false
 * holds the layout until `setReady`, which then runs every callback waiting for it in the order it was handed.
 */
function session(v: Vault, { ready = true }: { ready?: boolean } = {}) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	const waiting: (() => void)[] = [];
	const workspace = {
		layoutReady: ready,
		onLayoutReady(callback: () => void) {
			if (workspace.layoutReady) callback();
			else waiting.push(callback);
		},
	};
	const pdfStore = new PdfInkStore({ afterLayout: (start) => workspace.onLayoutReady(start) });
	const retirements = vi.spyOn(pdfStore as never as { retireDeletedPath(...a: unknown[]): Promise<void> }, "retireDeletedPath") as unknown as RetireSpy;
	const vaultOn = new Map<string, ((...a: unknown[]) => unknown)[]>();
	const app = {
		vault: {
			adapter: v.adapter,
			getFiles: () => [...v.files].map((path) => ({ path, extension: "pdf", stat: statOf(v, path) })),
			readBinary: async (_file: { path: string }) => v.pdfBytes.slice().buffer,
			getFileByPath: (p: string) => (v.files.has(p) ? { path: p, extension: "pdf", stat: statOf(v, p) } : null),
			on: (name: string, handler: (...a: unknown[]) => unknown) => {
				vaultOn.set(name, [...(vaultOn.get(name) ?? []), handler]);
				return {};
			},
		},
		workspace,
		loadLocalStorage: (key: string) => {
			if (key === SEEN_KEY && v.seenLoadThrows) throw new Error("load refused");
			return v.local.get(key) ?? null;
		},
		saveLocalStorage: (key: string, value: unknown) => {
			if (value === null || value === undefined) v.local.delete(key);
			else v.local.set(key, value);
		},
	};
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, {
		app,
		store,
		pdfStore,
		pdfInk: new Map(),
		pdfIds: new Map(),
		pdfFiles: new Map(),
		registerEvent: () => {},
		register: () => {},
	});
	installPdfHost.call(plugin, Notice, (m: string) => new Notice(m));
	plugin.attachPdfPendingDeletes();
	plugin.onloadVaultEvents();
	// As onloadFlushAndForeground: the vault's PDFs are listed into this device's record once the layout is ready.
	workspace.onLayoutReady(() => plugin.notePdfPathsListed());
	function setReady() {
		workspace.layoutReady = true;
		for (const callback of waiting.splice(0)) callback();
	}
	async function open(path: string) {
		expect(v.files.has(path), `precondition: ${path} exists in the vault`).toBe(true);
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, idle: true };
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId({ view: { file: { path } } }, root, controller);
		await store.flush();
		return { root, id: plugin.pdfIds.get(root) as string };
	}
	function close(root: HTMLElement) {
		(root as unknown as { isConnected: boolean }).isConnected = false;
		plugin.pdfInk.delete(root);
		plugin.pdfIds.delete(root);
		plugin.pdfFiles.delete(root);
	}
	/** The vault removes the file, then every delete handler the plugin registered runs. */
	async function deleteFile(path: string) {
		v.files.delete(path);
		for (const handler of vaultOn.get("delete") ?? []) await handler(pdfFile(v, path));
	}
	/** The vault adds the file, then every create handler the plugin registered runs. */
	async function createFile(path: string) {
		v.files.add(path);
		for (const handler of vaultOn.get("create") ?? []) await handler(pdfFile(v, path));
	}
	/** The vault moves the file, then every rename handler the plugin registered runs. */
	async function renameFile(from: string, to: string) {
		v.files.delete(from);
		v.files.add(to);
		for (const handler of vaultOn.get("rename") ?? []) await handler(pdfFile(v, to), from);
		await store.flush();
	}
	/** The clock runs `ms` on; every retirement it started is waited for to its end, and the store is flushed. */
	async function clock(ms: number) {
		const seen = retirements.mock.results.length;
		await vi.advanceTimersByTimeAsync(ms);
		for (let i = 0; i < 10; i++) {
			const n = retirements.mock.results.length;
			await Promise.allSettled(retirements.mock.results.slice(seen).map((r) => r.value as Promise<void>));
			await vi.advanceTimersByTimeAsync(0);
			await store.flush();
			if (retirements.mock.results.length === n) break;
		}
	}
	return { store, pdfStore, plugin, open, close, deleteFile, createFile, renameFile, setReady, clock };
}
type Session = ReturnType<typeof session>;

/** Session one: these PDFs in the vault and listed at ready; Old.pdf opened, inked, saved and closed. */
async function sessionOne(v: Vault, paths: readonly string[]) {
	for (const p of paths) v.files.add(p);
	const s = session(v);
	const o = await s.open(OLD);
	s.pdfStore.replaceAll(o.id, [stroke(10, "ink-0")]);
	await s.store.flush();
	s.close(o.root);
	expect(v.sidecar(o.id)?.pdfPaths, "precondition: the ink file claims the old name").toEqual([OLD]);
	return { s, old: o.id };
}

/** Run every grace out and let each retirement finish. */
async function settleGrace(s: Session) {
	await s.clock(RECYCLE_GRACE_MS + 1);
	await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
	await s.clock(60_000);
}

/**
 * Session two starts: every PDF in `flooded` is heard as created before the layout is ready. Then the layout is ready
 * (`readyAfterMs` later), and 1 s after that Old.pdf is deleted (or before ready, with `deleteBeforeReady`). Every
 * grace runs out.
 */
async function startingSession(
	v: Vault,
	flooded: readonly string[],
	opts: { readyAfterMs?: number; deleteBeforeReady?: boolean; check?: () => void } = {}
) {
	const s = session(v, { ready: false });
	vi.useFakeTimers();
	for (const p of flooded) {
		await s.createFile(p);
		opts.check?.();
	}
	if (opts.deleteBeforeReady) {
		await s.clock(1_000);
		await s.deleteFile(OLD);
		opts.check?.();
	}
	if (opts.readyAfterMs) await s.clock(opts.readyAfterMs);
	s.setReady();
	opts.check?.();
	await s.clock(1_000);
	if (!opts.deleteBeforeReady) {
		await s.deleteFile(OLD);
		opts.check?.();
	}
	await settleGrace(s);
	opts.check?.();
	vi.useRealTimers();
	return s;
}

/** A later session opens `path` and finds `id` with exactly this ink. */
async function expectOpens(v: Vault, path: string, id: string, ink: string[]) {
	const s = session(v);
	const opened = await s.open(path);
	expect(opened.id, `${path} opened another ink file`).toBe(id);
	expect(s.pdfStore.strokes(opened.id).map((k) => k.id)).toEqual(ink);
}

/** The ink followed its PDF to New.pdf. */
async function expectFollowed(v: Vault, old: string) {
	expect(v.inTrash(old), "the renamed PDF's ink went to the trash").toBe(false);
	expect(v.sidecar(old)?.pdfPaths).toEqual([NEW]);
	await expectOpens(v, NEW, old, ["ink-0"]);
}

/** Today's result: the ink went to the trash, and `path` opens blank. */
async function expectTrashed(v: Vault, old: string, path: string) {
	expect(v.sidecar(old), "the ink file still claims a path").toBeUndefined();
	expect(v.inTrash(old)).toBe(true);
	const s = session(v);
	const opened = await s.open(path);
	expect(s.pdfStore.strokes(opened.id).map((k) => k.id), `${path} opened wearing ink`).toEqual([]);
}

describe("a PDF renamed on another device and synced in while Obsidian starts keeps its ink", () => {
	it("a create before ready at a path this device never saw is the new file: the ink follows it", async () => {
		const v = vault();
		const { old } = await sessionOne(v, [OLD]);
		await startingSession(v, [OLD, NEW]);
		await expectFollowed(v, old);
	});

	it("the same with the delete heard before ready too", async () => {
		const v = vault();
		const { old } = await sessionOne(v, [OLD]);
		await startingSession(v, [OLD, NEW], { deleteBeforeReady: true });
		await expectFollowed(v, old);
	});

	it("the layout ready more than a grace after the create: the ink still follows, the grace counting from ready", async () => {
		const v = vault();
		const { old } = await sessionOne(v, [OLD]);
		await startingSession(v, [OLD, NEW], { readyAfterMs: RECYCLE_GRACE_MS + 1_000 });
		await expectFollowed(v, old);
	});

	it("the same order after ready: the ink follows, as it does today", async () => {
		const v = vault();
		const { old } = await sessionOne(v, [OLD]);
		const s = session(v);
		vi.useFakeTimers();
		await s.createFile(NEW);
		await s.clock(1_000);
		await s.deleteFile(OLD);
		await settleGrace(s);
		vi.useRealTimers();
		await expectFollowed(v, old);
	});
});

describe("every other answer is that the file existed: the ink goes to the trash, as today", () => {
	it("an old same-bytes template this device saw takes nothing", async () => {
		const v = vault();
		const { old } = await sessionOne(v, [TEMPLATE, OLD]);
		await startingSession(v, [TEMPLATE, OLD]);
		await expectTrashed(v, old, TEMPLATE);
	});

	it("no record: no session before kept one", async () => {
		const v = vault();
		const { old } = await sessionOne(v, [OLD]);
		v.local.delete(SEEN_KEY);
		v.local.delete(SEEN_EVENTS_KEY);
		await startingSession(v, [OLD, NEW]);
		await expectTrashed(v, old, NEW);
	});

	it.each([
		["not JSON", "{not json"],
		["not the record's shape", JSON.stringify({ tick: "one", spans: [] })],
		["an entry not of the shape", JSON.stringify({ tick: 1, spans: [[OLD, 1, null, 100]] })],
		["a store that refuses the load", null],
	] as const)("an unreadable record (%s)", async (_case, held) => {
		const v = vault();
		const { old } = await sessionOne(v, [OLD]);
		if (held === null) v.seenLoadThrows = true;
		else v.local.set(SEEN_KEY, held);
		await startingSession(v, [OLD, NEW]);
		await expectTrashed(v, old, NEW);
	});

	it("an unreadable events key beside a good record is no record", async () => {
		const v = vault();
		const { old } = await sessionOne(v, [OLD]);
		expect(v.local.has(SEEN_KEY), "precondition: a record is kept").toBe(true);
		v.local.set(SEEN_EVENTS_KEY, "{not json");
		await startingSession(v, [OLD, NEW]);
		await expectTrashed(v, old, NEW);
	});

	it("a record that went past the size kept: the stored one was cleared, so the next session has none", async () => {
		const v = vault();
		const long = Array.from({ length: 30 }, (_, i) => `${"a".repeat(10_000)}-${i}.pdf`);
		const { old } = await sessionOne(v, [OLD, ...long]);
		expect(v.local.has(SEEN_KEY), "precondition: the record too large to keep is cleared").toBe(false);
		await startingSession(v, [OLD, NEW]);
		await expectTrashed(v, old, NEW);
	});

	it("a path heard created after ready is recorded in that event's task: the app stopping before any timer runs still keeps it", async () => {
		const v = vault();
		const { s, old } = await sessionOne(v, [OLD]);
		vi.useFakeTimers();
		await s.createFile(NEW);
		// The app stops here: no timer of this session ever runs.
		vi.clearAllTimers();
		vi.useRealTimers();
		await startingSession(v, [OLD, NEW]);
		await expectTrashed(v, old, NEW);
	});

	it("a path heard created after the listing while the layout flag reads false (a workspace load mid-session) is recorded: it existed", async () => {
		const v = vault();
		const { s, old } = await sessionOne(v, [OLD]);
		vi.useFakeTimers();
		s.plugin.app.workspace.layoutReady = false;
		await s.createFile(NEW);
		s.plugin.app.workspace.layoutReady = true;
		// The app stops here: no timer of this session ever runs.
		vi.clearAllTimers();
		vi.useRealTimers();
		await startingSession(v, [OLD, NEW]);
		await expectTrashed(v, old, NEW);
	});

	it("a path whose file left while this device watched, back in the vault: it existed", async () => {
		const v = vault();
		const { s, old } = await sessionOne(v, [OLD, NEW]);
		vi.useFakeTimers();
		await s.deleteFile(NEW);
		await settleGrace(s);
		vi.useRealTimers();
		v.files.add(NEW);
		await startingSession(v, [OLD, NEW]);
		await expectTrashed(v, old, NEW);
	});

	it("a path renamed away while this device watched, a file back at it: it existed", async () => {
		const v = vault();
		const { s, old } = await sessionOne(v, [OLD, NEW]);
		await s.renameFile(NEW, "Moved.pdf");
		v.files.add(NEW);
		await startingSession(v, [OLD, "Moved.pdf", NEW]);
		await expectTrashed(v, old, NEW);
	});

	it("a path this device saw, now holding another file (another size and modified time): it existed", async () => {
		const v = vault();
		v.stats.set(NEW, { size: 999, mtime: 5 });
		const { old } = await sessionOne(v, [OLD, NEW]);
		v.stats.delete(NEW);
		await startingSession(v, [OLD, NEW]);
		await expectTrashed(v, old, NEW);
	});
});

describe("one path in two Unicode forms is one path", () => {
	it.each([
		["recorded composed, heard decomposed", COMPOSED, DECOMPOSED],
		["recorded decomposed, heard composed", DECOMPOSED, COMPOSED],
	] as const)("%s: it existed", async (_case, recorded, heard) => {
		const v = vault();
		const { old } = await sessionOne(v, [OLD, recorded]);
		v.files.delete(recorded);
		v.files.add(heard);
		await startingSession(v, [OLD, heard]);
		await expectTrashed(v, old, heard);
	});

	it("a saved record holding one path in both forms: either form existed", async () => {
		const v = vault();
		const { old } = await sessionOne(v, [OLD]);
		const span = (path: string) => [path, 1, null, v.pdfBytes.byteLength, 1];
		v.local.set(SEEN_KEY, JSON.stringify({ tick: 1, spans: [span(OLD), span(COMPOSED), span(DECOMPOSED)] }));
		v.local.delete(SEEN_EVENTS_KEY);
		v.files.add(DECOMPOSED);
		await startingSession(v, [OLD, DECOMPOSED]);
		await expectTrashed(v, old, DECOMPOSED);
	});
});

describe("the record is in no synced file", () => {
	it("through a start-up with a create before ready and a delete after, the vault gains only ink files; the record is in the device's store", async () => {
		const v = vault();
		await sessionOne(v, [OLD]);
		const vaultFilesAreInk = () => {
			for (const path of v.adapter.files.keys()) expect(path, "a file in the vault that is not ink").toMatch(/^\.handwriting\//);
			expect(v.local.has(SEEN_KEY), "the record is in the device's local store").toBe(true);
		};
		vaultFilesAreInk();
		await startingSession(v, [OLD, NEW], { check: vaultFilesAreInk });
	});
});

describe("the vault's PDFs are listed into the record where the load's layout-ready work runs", () => {
	it("the load's layout callback lists them once, after its unloaded check", () => {
		const src = pluginOnloadSource.replace(/\r\n/g, "\n");
		const start = src.indexOf("\tfunction onloadFlushAndForeground(this: HandwritingPlugin): void {");
		expect(start, "the flush and foreground phase").toBeGreaterThan(-1);
		const end = src.indexOf("\n\t}\n", start);
		const open = "\t\tthis.app.workspace.onLayoutReady(() => {\n\t\t\tif (this.unloaded) return;\n";
		const at = src.indexOf(open, start);
		expect(at > start && at < end, "the phase's layout callback, its unloaded check first").toBe(true);
		const body = src.slice(at + open.length, src.indexOf("\n\t\t});", at));
		expect(body.split("this.notePdfPathsListed();").length - 1, "the listing in that callback").toBe(1);
		expect(src.split("this.notePdfPathsListed()").length - 1, "the listing anywhere else in the load").toBe(1);
	});
});
