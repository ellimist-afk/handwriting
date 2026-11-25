/**
 * A tied open's hold follows a vault rename. Two byte-same inked PDFs are deleted in one grace, two new copies of the
 * same bytes arrive, and the first one opened ties: it opens blank and its path is held for both deletions, so the
 * other copy cannot take a deleted ink by elimination. The hold must follow that copy when the vault renames it, in
 * every waiting deletion and past a restart. Through the plugin and the real stores, with an in-memory vault (the
 * harness of PdfRenameOntoDeletedName.test.ts, copied), plus the plugin's own rename handler.
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
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { parsePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";


// Execute the production host registration, including its load options, rather
// than reconstructing that adapter in this fixture.
const source = pluginSettingsSource.replace(/\r\n/g, "\n");
const hostStart = "\t\tthis.pdfStore.attachHost({";
expect(source.split(hostStart)).toHaveLength(2);
const hostAt = source.indexOf(hostStart);
const hostEnd = source.indexOf("\n\t\t});", hostAt);
expect(hostEnd).toBeGreaterThan(hostAt);
const installPdfHost = new Function("Notice", source.slice(hostAt, hostEnd + "\n\t\t});".length));

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

/** One vault (disk + file list) shared by any number of plugin sessions. */
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
	// Every PDF here holds the same bytes: "Make a copy" of one file.
	const pdfBytes = new TextEncoder().encode(
		"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + "x".repeat(5000) + "\n%%EOF\n"
	);
	const files = new Set<string>();
	/** This device's local storage, which outlives a plugin session. */
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
	return { adapter, pdfBytes, files, local, sidecar, trashInk };
}

function pdfFile(path: string) {
	return Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		name: path.split("/").pop(),
		basename: path.replace(/\.[^.]+$/, ""),
	});
}

/**
 * A plugin session (fresh memory) over the shared vault. Its vault events are
 * the plugin's own registrations; `layoutReady` is the workspace's flag.
 * `pendingStore` restores and saves deletions in their grace the way the
 * plugin does at load.
 */
function session(v: ReturnType<typeof vault>, opts: { layoutReady?: boolean; pendingStore?: boolean } = {}) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	const pdfStore = new PdfInkStore();
	const vaultOn = new Map<string, ((...a: unknown[]) => unknown)[]>();
	const app = {
		vault: {
			adapter: v.adapter,
			getFiles: () => [...v.files].map((path) => ({ path, extension: "pdf" })),
			readBinary: async (_file: { path: string }) => v.pdfBytes.slice().buffer,
			getFileByPath: (p: string) => (v.files.has(p) ? { path: p, extension: "pdf" } : null),
			on: (name: string, handler: (...a: unknown[]) => unknown) => {
				vaultOn.set(name, [...(vaultOn.get(name) ?? []), handler]);
				return {};
			},
		},
		workspace: { layoutReady: opts.layoutReady ?? true },
		loadLocalStorage: (key: string) => v.local.get(key) ?? null,
		saveLocalStorage: (key: string, value: unknown) => {
			if (value === null) v.local.delete(key);
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
	// The rename handler starts the no-pane claim move in the background. The move itself runs unchanged; it is
	// only kept here, so a rename can be waited for.
	const moves: Promise<void>[] = [];
	const moveClaim = HandwritingPlugin.prototype.movePdfClaimOnRename;
	plugin.movePdfClaimOnRename = (file: TFile, oldPath: string) => {
		const move = moveClaim.call(plugin, file, oldPath);
		moves.push(move);
		return move;
	};
	installPdfHost.call(plugin, Notice);
	plugin.onloadVaultEvents();
	if (opts.pendingStore) plugin.attachPdfPendingDeletes();
	async function open(path: string) {
		expect(v.files.has(path), `precondition: ${path} exists in the vault`).toBe(true);
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, idle: true };
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId({ view: { file: { path } } }, root, controller);
		return { root, id: plugin.pdfIds.get(root) as string };
	}
	function close(root: HTMLElement) {
		(root as unknown as { isConnected: boolean }).isConnected = false;
		plugin.pdfInk.delete(root);
		plugin.pdfIds.delete(root);
		plugin.pdfFiles.delete(root);
	}
	function draw(id: string, s: InkStroke) {
		pdfStore.replaceAll(id, [...pdfStore.strokes(id), s]);
	}
	/** The vault removes the file, then the plugin's real delete handler runs. */
	async function deleteFile(path: string) {
		v.files.delete(path);
		await plugin.onFileDeleted(pdfFile(path));
	}
	/** The vault adds the file, then every create handler the plugin registered runs. */
	async function createFile(path: string) {
		v.files.add(path);
		for (const handler of vaultOn.get("create") ?? []) await handler(pdfFile(path));
	}
	/** The vault moves the file, then every rename handler the plugin registered runs, and any claim move it started. */
	async function renameFile(from: string, to: string) {
		expect(v.files.has(from), `precondition: ${from} exists before the rename`).toBe(true);
		expect(vaultOn.get("rename")?.length, "precondition: the plugin listens for renames").toBeGreaterThan(0);
		v.files.delete(from);
		v.files.add(to);
		for (const handler of vaultOn.get("rename") ?? []) await handler(pdfFile(to), from);
		await Promise.all(moves.splice(0));
	}
	return { store, pdfStore, plugin, open, close, draw, deleteFile, createFile, renameFile };
}

/** A later session opens `path` and finds it blank. */
async function expectBlank(v: ReturnType<typeof vault>, path: string) {
	const s = session(v);
	const opened = await s.open(path);
	expect(s.pdfStore.strokes(opened.id).map((x) => x.id), `${path} opened wearing ink`).toEqual([]);
}

/** One session with one inked PDF per path, each closed again. */
async function inked<const P extends readonly string[]>(
	v: ReturnType<typeof vault>,
	paths: P,
	opts: { layoutReady?: boolean; pendingStore?: boolean } = {}
) {
	for (const p of paths) v.files.add(p);
	const s = session(v, opts);
	const ids: string[] = [];
	for (const [i, p] of paths.entries()) {
		const o = await s.open(p);
		s.draw(o.id, stroke(10 + 10 * i, `ink-${i}`));
		await s.store.flush();
		s.close(o.root);
		ids.push(o.id);
	}
	expect(new Set(ids).size, "precondition: each path has its own ink file").toBe(paths.length);
	for (const [i, id] of ids.entries()) {
		expect(v.sidecar(id)?.pdfPaths, `precondition: ink file ${i} claims its own path only`).toEqual([paths[i]]);
	}
	return { s, ids: ids as { [K in keyof P]: string } };
}

/** Run every grace out and let each retirement finish. */
async function settleGrace(s: ReturnType<typeof session>) {
	await vi.advanceTimersByTimeAsync(10_001);
	await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
	await s.store.flush();
}

/** The first deleted PDF (ink-0) and the second (ink-1, another file name, so it scores lower against both copies). */
const FIRST = "Notes/A.pdf";
const SECOND = "Work/C.pdf";
/** The two copies that arrive inside the grace. TIED is opened first and ties. */
const TIED = "Inbox/A.pdf";
const OTHER = "Archive/A.pdf";
/** TIED's new name in the same-name move. */
const MOVED = "Projects/A.pdf";
const PENDING_KEY = "handwriting-pdf-pending-deletes";

/** Both deleted in one grace (FIRST then SECOND), then the two copies arrive. */
async function deleteBothThenCopies(s: ReturnType<typeof session>) {
	await s.deleteFile(FIRST);
	await vi.advanceTimersByTimeAsync(500);
	await s.deleteFile(SECOND);
	const waiting = s.pdfStore.pendingClaims();
	expect(waiting.has(FIRST) && waiting.has(SECOND), "precondition: both deletions wait out their grace").toBe(true);
	await s.createFile(TIED);
	await s.createFile(OTHER);
}

/** TIED opens blank and is held for every waiting deletion; its pane stays open. */
async function openTied(s: ReturnType<typeof session>, deleted: readonly string[]) {
	const tied = await s.open(TIED);
	expect(s.pdfStore.strokes(tied.id).map((x) => x.id), "precondition: the tied copy opens blank").toEqual([]);
	for (const d of deleted) {
		expect(s.pdfStore.heldPaths().get(d)?.has(TIED), `precondition: the tied copy is held for ${d}`).toBe(true);
	}
	return tied;
}

/** Inks X1 (FIRST) and X2 (SECOND) deleted, both copies in, TIED opened and held, pane open. */
async function tiedSetup(opts: { pendingStore?: boolean } = {}) {
	const v = vault();
	const { s, ids: [x1, x2] } = await inked(v, [FIRST, SECOND], opts);
	vi.useFakeTimers();
	await deleteBothThenCopies(s);
	const tied = await openTied(s, [FIRST, SECOND]);
	return { v, s, x1, x2, tied };
}

/** The ink files that claim `path` on disk. */
function claimersOnDisk(v: ReturnType<typeof vault>, ids: readonly string[], path: string) {
	return ids.filter((id) => v.sidecar(id)?.pdfPaths?.includes(path));
}

function endInSession(s: ReturnType<typeof session>) {
	s.pdfStore.cancelPendingDeletes();
	vi.useRealTimers();
}

describe("a tied copy moved inside the grace keeps its hold", () => {
	it("two deleted, the tied copy moved to another folder under the same name: the other copy opens blank, not with the first deleted ink", async () => {
		const { s, x1, x2 } = await tiedSetup();
		await s.renameFile(TIED, MOVED);
		const other = await s.open(OTHER);
		expect(other.id, "the other copy was handed the first deleted ink by elimination").not.toBe(x1);
		expect(other.id, "the other copy was handed the second deleted ink").not.toBe(x2);
		expect(s.pdfStore.strokes(other.id).map((x) => x.id), "the other copy opened wearing ink").toEqual([]);
		endInSession(s);
	});

	it("two deleted, the tied copy moved under the same name, no open of the other copy: after the grace both deleted inks are in the trash whole and the other copy opens blank", async () => {
		const { v, s, x1, x2 } = await tiedSetup();
		await s.renameFile(TIED, MOVED);
		await settleGrace(s);
		vi.useRealTimers();
		expect(claimersOnDisk(v, [x1, x2], OTHER), "a deleted ink was moved onto the other copy").toEqual([]);
		expect(v.trashInk().map((ink) => ink.join(",")).sort(), "the trash holds both deleted inks, strokes whole").toEqual(["ink-0", "ink-1"]);
		await expectBlank(v, OTHER);
	});

	it("CONTROL: two deleted, the tied copy renamed to another file name: the other copy takes the first deleted ink by name", async () => {
		const { s, x1 } = await tiedSetup();
		await s.renameFile(TIED, "Inbox/A2.pdf");
		const other = await s.open(OTHER);
		expect(other.id, "the other copy did not pair the first deleted ink by name").toBe(x1);
		expect(s.pdfStore.strokes(other.id).map((x) => x.id)).toEqual(["ink-0"]);
		endInSession(s);
	});

	it("one deleted whose deletion was paired before, the tied copy moved under the same name: the other copy opens blank", async () => {
		const v = vault();
		const { s: first, ids: [x1] } = await inked(v, [FIRST], { pendingStore: true });
		vi.useFakeTimers();
		await first.deleteFile(FIRST);
		first.pdfStore.cancelPendingDeletes();
		const list = JSON.parse(v.local.get(PENDING_KEY) as string) as { path: string; paired?: boolean }[];
		expect(list.map((e) => e.path), "precondition: the deletion was saved").toEqual([FIRST]);
		v.local.set(PENDING_KEY, JSON.stringify(list.map((e) => ({ ...e, paired: true }))));
		const s = session(v, { pendingStore: true });
		expect(s.pdfStore.pendingClaims().has(FIRST), "precondition: the paired deletion resumed").toBe(true);
		await s.createFile(TIED);
		await s.createFile(OTHER);
		await openTied(s, [FIRST]);
		await s.renameFile(TIED, MOVED);
		const other = await s.open(OTHER);
		expect(other.id, "the other copy was handed the deleted ink by elimination").not.toBe(x1);
		expect(s.pdfStore.strokes(other.id).map((x) => x.id), "the other copy opened wearing ink").toEqual([]);
		endInSession(s);
	});

	it("two deleted, the tied copy drawn on and moved under the same name, then a quit inside the grace: the next session opens the other copy blank", async () => {
		const { v, s: first, x1, x2, tied } = await tiedSetup({ pendingStore: true });
		// The stroke makes the tied copy's own ink claim its path on disk, so the claim outlives the quit.
		first.draw(tied.id, stroke(50, "own"));
		await first.store.flush();
		await first.renameFile(TIED, MOVED);
		await first.store.flush();
		expect(v.sidecar(tied.id)?.pdfPaths, "precondition: the tied copy's ink claims its new name on disk").toEqual([MOVED]);
		first.pdfStore.cancelPendingDeletes();
		const next = session(v, { pendingStore: true });
		const waiting = next.pdfStore.pendingClaims();
		expect(waiting.has(FIRST) && waiting.has(SECOND), "precondition: both deletions resumed").toBe(true);
		const other = await next.open(OTHER);
		expect(other.id, "after the quit the other copy was handed the first deleted ink by elimination").not.toBe(x1);
		expect(other.id, "after the quit the other copy was handed the second deleted ink").not.toBe(x2);
		expect(next.pdfStore.strokes(other.id).map((x) => x.id), "the other copy opened wearing ink").toEqual([]);
		endInSession(next);
	});
});

describe("a tied copy moved inside the grace to a name that pairs it: the name rule, the held copy counted", () => {
	it("two deleted, the tied copy moved into a folder named like the first deleted path: the other copy opens with the second deleted ink, and the moved copy is claimed by no deleted ink", async () => {
		const { v, s, x1, x2 } = await tiedSetup();
		await s.renameFile(TIED, "Sub/Notes/A.pdf");
		const other = await s.open(OTHER);
		expect(other.id, "the other copy did not take the second deleted ink").toBe(x2);
		expect(s.pdfStore.strokes(other.id).map((x) => x.id)).toEqual(["ink-1"]);
		s.close(other.root);
		await settleGrace(s);
		vi.useRealTimers();
		expect(claimersOnDisk(v, [x1, x2], "Sub/Notes/A.pdf"), "a deleted ink was moved onto the held copy").toEqual([]);
	});

	it("two deleted, the tied copy moved onto the first deleted path itself: the other copy opens with the second deleted ink", async () => {
		const { s, x2 } = await tiedSetup();
		await s.renameFile(TIED, FIRST);
		const other = await s.open(OTHER);
		expect(other.id, "the other copy did not take the second deleted ink").toBe(x2);
		expect(s.pdfStore.strokes(other.id).map((x) => x.id)).toEqual(["ink-1"]);
		endInSession(s);
	});
});
