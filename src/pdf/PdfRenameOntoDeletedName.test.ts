/**
 * A same-bytes copy renamed onto the name of a PDF deleted moments before. With ink of its own, moved from its old
 * name, it keeps that ink, and the deleted ink goes where a plain delete puts it, strokes whole. With none, the
 * deleted ink is of its bytes and claims the name: it is the copy's, as at a recreation at the name. Through the
 * plugin and the real stores, with an in-memory vault (the same harness as PdfIdentityRouting.test.ts), plus the
 * plugin's own rename handler.
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
import { InkFolderListingFailed } from "../persistence/InkFolder";
import { PdfInkStore } from "./PdfInkStore";
import { parsePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

/** The PDF that is deleted, and the name the copy is renamed onto. */
const NAME = "Form.pdf";
/** The copy's name before the rename. It exists, with the same bytes, when NAME is deleted. */
const COPY = "Form copy.pdf";

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
	// The rename handler starts the claim moves in the background: the no-pane one, and with a pane holding the claim
	// the move of the file's other inks (FOLLOWUPS 550). The moves themselves run unchanged; they are only kept here,
	// so a rename can be waited for.
	const moves: Promise<void>[] = [];
	const moveClaim = HandwritingPlugin.prototype.movePdfClaimOnRename;
	plugin.movePdfClaimOnRename = (file: TFile, oldPath: string) => {
		const move = moveClaim.call(plugin, file, oldPath);
		moves.push(move);
		return move;
	};
	const moveBeside = HandwritingPlugin.prototype.movePdfClaimsBesidePane;
	plugin.movePdfClaimsBesidePane = (...a: Parameters<typeof moveBeside>) => {
		const move = moveBeside.apply(plugin, a);
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

/** A later session opens `path` and finds `id` with exactly this ink. */
async function expectOpens(v: ReturnType<typeof vault>, path: string, id: string, ink: string[]) {
	const s = session(v);
	const opened = await s.open(path);
	expect(opened.id, `${path} opened another ink file`).toBe(id);
	expect(s.pdfStore.strokes(opened.id).map((x) => x.id)).toEqual(ink);
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

/** NAME is deleted with COPY in the vault: the deletion counts COPY as existing and NAME as gone. */
async function deleteName(s: ReturnType<typeof session>) {
	await s.deleteFile(NAME);
	const existing = s.pdfStore.pendingClaims().get(NAME);
	expect(existing, "precondition: the delete of the name is waiting out its grace").toBeDefined();
	expect(existing?.has(COPY), "precondition: the copy existed at the delete").toBe(true);
	expect(existing?.has(NAME), "precondition: the deleted name is not among the paths that existed at the delete").toBe(false);
}

/** The deleted ink is where a plain delete puts it: no ink file left for it, and in the trash whole. */
function expectDeletedInkTrashed(v: ReturnType<typeof vault>, deleted: string) {
	expect(v.sidecar(deleted), "the deleted PDF's ink file still claims the name after the grace").toBeUndefined();
	expect(v.trashInk(), "the trash holds the deleted PDF's ink, strokes whole, and nothing else").toEqual([["ink-0"]]);
}

/** The ink of the copy's bytes stayed with the copy on the name: it claims the name, and nothing is in the trash. */
function expectInkKeptOnName(v: ReturnType<typeof vault>, kept: string) {
	expect(v.sidecar(kept)?.pdfPaths, "the ink of the copy's bytes does not claim the name after the grace").toEqual([NAME]);
	expect(v.trashInk(), "ink went to the trash").toEqual([]);
}

describe("a same-bytes copy renamed onto a just-deleted PDF's name, inside the grace", () => {
	it("no pane, the copy has no ink: after the grace the ink of its bytes on the name is outside the trash and the copy opens with it", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(COPY, NAME);
		await settleGrace(s);
		vi.useRealTimers();
		expectInkKeptOnName(v, deleted);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
	});

	it("no pane, the copy has its own ink: after the grace the deleted ink is in the trash and the copy opens with its own", async () => {
		const v = vault();
		const { s, ids: [deleted, own] } = await inked(v, [NAME, COPY]);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(COPY, NAME);
		await s.store.flush();
		expect(v.sidecar(own)?.pdfPaths, "precondition: the rename moved the copy's own claim to the name").toEqual([NAME]);
		await settleGrace(s);
		vi.useRealTimers();
		expectDeletedInkTrashed(v, deleted);
		expect(v.sidecar(own)?.pdfPaths).toEqual([NAME]);
		await expectOpens(v, NAME, own, ["ink-1"]);
	});

	it("opened inside the grace, the copy has no ink: the open shows the ink of its bytes on the name, and that ink stays outside the trash", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(COPY, NAME);
		const opened = await s.open(NAME);
		expect(opened.id, "the copy opened inside the grace with another ink file than the one of its bytes on the name").toBe(deleted);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id), "the copy opened inside the grace without that ink").toEqual(["ink-0"]);
		s.close(opened.root);
		await settleGrace(s);
		vi.useRealTimers();
		expectInkKeptOnName(v, deleted);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
	});

	it("opened inside the grace, the copy has its own ink: the open shows the copy's own ink, and the deleted ink still goes to the trash", async () => {
		const v = vault();
		const { s, ids: [deleted, own] } = await inked(v, [NAME, COPY]);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(COPY, NAME);
		const opened = await s.open(NAME);
		expect(opened.id, "the copy opened inside the grace was handed the deleted PDF's ink file").not.toBe(deleted);
		expect(opened.id, "the copy opened inside the grace with another ink file than its own").toBe(own);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id)).toEqual(["ink-1"]);
		s.close(opened.root);
		await settleGrace(s);
		vi.useRealTimers();
		expectDeletedInkTrashed(v, deleted);
		await expectOpens(v, NAME, own, ["ink-1"]);
	});

	it("a pane open on the copy through the rename, the copy has its own ink: after the grace the deleted ink is in the trash and the name opens with the copy's ink", async () => {
		const v = vault();
		const { s, ids: [deleted, own] } = await inked(v, [NAME, COPY]);
		const pane = await s.open(COPY);
		expect(pane.id, "precondition: the pane on the copy shows the copy's own ink file").toBe(own);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(COPY, NAME);
		expect(s.plugin.pdfFiles.get(pane.root), "precondition: the pane followed the rename").toBe(NAME);
		await settleGrace(s);
		s.close(pane.root);
		vi.useRealTimers();
		expectDeletedInkTrashed(v, deleted);
		expect(v.sidecar(own)?.pdfPaths).toEqual([NAME]);
		await expectOpens(v, NAME, own, ["ink-1"]);
	});

	it("a pane open on the copy through the rename, the copy has no ink: after the grace the deleted ink is in the trash and the name opens blank", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		const pane = await s.open(COPY);
		expect(pane.id, "precondition: the pane on the copy is not the deleted PDF's ink file").not.toBe(deleted);
		expect(s.pdfStore.strokes(pane.id).map((x) => x.id), "precondition: the pane on the copy is blank").toEqual([]);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(COPY, NAME);
		expect(s.plugin.pdfFiles.get(pane.root), "precondition: the pane followed the rename").toBe(NAME);
		await settleGrace(s);
		s.close(pane.root);
		vi.useRealTimers();
		expectDeletedInkTrashed(v, deleted);
		await expectBlank(v, NAME);
	});

	it("a quit inside the grace after the rename, the copy has no ink: the next session keeps the ink of its bytes on the name, and the copy opens with it", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s: first, ids: [deleted] } = await inked(v, [NAME], { pendingStore: true });
		vi.useFakeTimers();
		await deleteName(first);
		await first.renameFile(COPY, NAME);
		// Quit inside the grace: the deletion is saved.
		first.pdfStore.cancelPendingDeletes();
		expect(v.local.size, "precondition: the deletion was saved").toBe(1);
		const next = session(v, { pendingStore: true });
		expect(next.pdfStore.pendingClaims().has(NAME), "precondition: the deletion resumed").toBe(true);
		await settleGrace(next);
		vi.useRealTimers();
		expectInkKeptOnName(v, deleted);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
	});

	it("a quit inside the grace after the rename, the copy has its own ink: the next session sends the deleted ink to the trash, and the copy opens with its own", async () => {
		const v = vault();
		const { s: first, ids: [deleted, own] } = await inked(v, [NAME, COPY], { pendingStore: true });
		vi.useFakeTimers();
		await deleteName(first);
		await first.renameFile(COPY, NAME);
		await first.store.flush();
		first.pdfStore.cancelPendingDeletes();
		expect(v.local.size, "precondition: the deletion was saved").toBe(1);
		const next = session(v, { pendingStore: true });
		expect(next.pdfStore.pendingClaims().has(NAME), "precondition: the deletion resumed").toBe(true);
		await settleGrace(next);
		vi.useRealTimers();
		expectDeletedInkTrashed(v, deleted);
		expect(v.sidecar(own)?.pdfPaths).toEqual([NAME]);
		await expectOpens(v, NAME, own, ["ink-1"]);
	});

	it("the same, the deletion saved by an earlier build (no record of the ink the copy came with): the next session still sends the deleted ink to the trash, and the copy opens with its own", async () => {
		const v = vault();
		const { s: first, ids: [deleted, own] } = await inked(v, [NAME, COPY], { pendingStore: true });
		vi.useFakeTimers();
		await deleteName(first);
		await first.renameFile(COPY, NAME);
		await first.store.flush();
		first.pdfStore.cancelPendingDeletes();
		expect(v.local.size, "precondition: the deletion was saved").toBe(1);
		// An earlier build saved the same list without the key `moved`.
		const [key, text] = [...v.local][0]!;
		const list = JSON.parse(text as string) as Record<string, unknown>[];
		expect(list.filter((e) => Array.isArray(e.moved)), "precondition: this build saved the ink the copy came with").toHaveLength(1);
		for (const e of list) delete e.moved;
		v.local.set(key, JSON.stringify(list));
		const next = session(v, { pendingStore: true });
		expect(next.pdfStore.pendingClaims().has(NAME), "precondition: the deletion resumed").toBe(true);
		await settleGrace(next);
		vi.useRealTimers();
		expectDeletedInkTrashed(v, deleted);
		expect(v.sidecar(own)?.pdfPaths).toEqual([NAME]);
		await expectOpens(v, NAME, own, ["ink-1"]);
	});

	it("a quit inside the grace after the copy with no ink was opened on the name: the next session keeps the ink of its bytes on the name, and the copy opens with it", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s: first, ids: [deleted] } = await inked(v, [NAME], { pendingStore: true });
		vi.useFakeTimers();
		await deleteName(first);
		await first.renameFile(COPY, NAME);
		const opened = await first.open(NAME);
		expect(opened.id, "precondition: the copy opened with the ink of its bytes on the name").toBe(deleted);
		first.close(opened.root);
		await first.store.flush();
		first.pdfStore.cancelPendingDeletes();
		const list = JSON.parse(v.local.get(PENDING_KEY) as string) as Record<string, unknown>[];
		expect(list, "precondition: one deletion saved").toHaveLength(1);
		expect(list[0]!.arrived, "precondition: the ink it opened with was saved as arrived on the name").toEqual([deleted]);
		const next = session(v, { pendingStore: true });
		expect(next.pdfStore.pendingClaims().has(NAME), "precondition: the deletion resumed").toBe(true);
		await settleGrace(next);
		vi.useRealTimers();
		expectInkKeptOnName(v, deleted);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
	});

	it("a quit inside the grace before the rename, the copy has no ink: the rename in the next session's grace reaches the same end", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s: first, ids: [deleted] } = await inked(v, [NAME], { pendingStore: true });
		vi.useFakeTimers();
		await deleteName(first);
		first.pdfStore.cancelPendingDeletes();
		expect(v.local.size, "precondition: the deletion was saved").toBe(1);
		const next = session(v, { pendingStore: true });
		expect(next.pdfStore.pendingClaims().get(NAME)?.has(COPY), "precondition: the deletion resumed, the copy counted as existing").toBe(true);
		await next.renameFile(COPY, NAME);
		await settleGrace(next);
		vi.useRealTimers();
		expectInkKeptOnName(v, deleted);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
	});

	it("CONTROL: the name comes back by a create inside the grace (a sync delete then create): the ink keeps the name, nothing goes to the trash", async () => {
		const v = vault();
		const { s, ids: [deleted, own] } = await inked(v, [NAME, COPY]);
		vi.useFakeTimers();
		await deleteName(s);
		await vi.advanceTimersByTimeAsync(2_000);
		await s.createFile(NAME);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.trashInk(), "a sync delete then create sent ink to the trash").toEqual([]);
		expect(v.sidecar(deleted)?.pdfPaths).toEqual([NAME]);
		expect(v.sidecar(own)?.pdfPaths).toEqual([COPY]);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
		await expectOpens(v, COPY, own, ["ink-1"]);
	});

	it("CONTROL: a file that did not exist at the delete, renamed onto the name inside the grace: the ink keeps the name", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		vi.useFakeTimers();
		await deleteName(s);
		await vi.advanceTimersByTimeAsync(1_000);
		await s.createFile("Form (1).pdf");
		expect(s.pdfStore.pendingClaims().get(NAME)?.has("Form (1).pdf"), "precondition: the arriving file did not exist at the delete").toBe(false);
		await s.renameFile("Form (1).pdf", NAME);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.trashInk(), "ink went to the trash for a file that arrived after the delete").toEqual([]);
		expect(v.sidecar(deleted)?.pdfPaths).toEqual([NAME]);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
		await expectBlank(v, COPY);
	});

	it("CONTROL: the deleted file's own new name lands ahead of its delete: the ink follows it, and the copy stays blank", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		vi.useFakeTimers();
		await s.createFile("Form moved.pdf");
		await vi.advanceTimersByTimeAsync(1_000);
		await deleteName(s);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.trashInk(), "the moved file's ink went to the trash").toEqual([]);
		expect(v.sidecar(deleted)?.pdfPaths).toEqual(["Form moved.pdf"]);
		await expectOpens(v, "Form moved.pdf", deleted, ["ink-0"]);
		await expectBlank(v, COPY);
	});

	it("CONTROL: the copy renamed onto the name after the grace: the deleted ink is already in the trash and the copy opens blank", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		vi.useFakeTimers();
		await deleteName(s);
		await settleGrace(s);
		await s.renameFile(COPY, NAME);
		await s.store.flush();
		vi.useRealTimers();
		expectDeletedInkTrashed(v, deleted);
		await expectBlank(v, NAME);
	});
});

/** A second PDF with the same bytes, deleted just after the first. */
const SECOND = "Form 2.pdf";
/** The deleted file's own new name, as a sync client lands it: a create after the delete. */
const MOVED = "Form moved.pdf";
/** Where this device keeps the deletions in their grace across a restart. */
const PENDING_KEY = "handwriting-pdf-pending-deletes";

/** NAME, then SECOND, deleted (both inked, same bytes), COPY in the vault throughout. */
async function deleteBoth(s: ReturnType<typeof session>) {
	await deleteName(s);
	await vi.advanceTimersByTimeAsync(500);
	await s.deleteFile(SECOND);
	const second = s.pdfStore.pendingClaims().get(SECOND);
	expect(second?.has(COPY), "precondition: the copy existed at the second delete").toBe(true);
	expect(second?.has(NAME), "precondition: the first name was gone at the second delete").toBe(false);
}

describe("a same-bytes copy renamed onto a just-deleted PDF's name: more doors and orders", () => {
	it("no pane, the copy has no ink, renamed onto the name and then on to another inside the grace: the deleted ink does not follow it", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(COPY, NAME);
		await s.renameFile(NAME, "Form final.pdf");
		await s.store.flush();
		expect(v.sidecar(deleted)?.pdfPaths, "a rename moved the deleted PDF's ink to the copy's last name").not.toEqual(["Form final.pdf"]);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(deleted)?.pdfPaths, "after the grace the deleted PDF's ink claims the copy's last name").not.toEqual(["Form final.pdf"]);
		await expectBlank(v, "Form final.pdf");
	});

	it("a pane on the copy (no ink), renamed onto the name and then on to another: the copy leaving the name does not end its deletion, and another copy is not handed the deleted ink", async () => {
		const v = vault();
		v.files.add(COPY);
		v.files.add("Other.pdf");
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		const pane = await s.open(COPY);
		expect(pane.id, "precondition: the pane on the copy is not the deleted PDF's ink file").not.toBe(deleted);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(COPY, NAME);
		await s.renameFile(NAME, "Form final.pdf");
		expect(s.plugin.pdfFiles.get(pane.root), "precondition: the pane followed both renames").toBe("Form final.pdf");
		expect(s.pdfStore.pendingClaims().has(NAME), "the copy leaving the name ended the name's deletion").toBe(true);
		await settleGrace(s);
		s.close(pane.root);
		vi.useRealTimers();
		expect(v.sidecar(deleted), "the deleted PDF's ink still claims the gone name after the grace").toBeUndefined();
		await expectBlank(v, "Other.pdf");
	});

	it("two deleted, the copy (no ink, no pane) renamed onto the first-deleted name: after both graces the ink of its bytes on the name stays with it, and only the second ink is in the trash", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [first, second] } = await inked(v, [NAME, SECOND]);
		vi.useFakeTimers();
		await deleteBoth(s);
		await s.renameFile(COPY, NAME);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(first)?.pdfPaths, "the first deleted PDF's ink, of the copy's bytes on the name, does not claim the name").toEqual([NAME]);
		expect(v.sidecar(second)?.pdfPaths, "the second deleted PDF's ink took the name the copy was renamed onto").toBeUndefined();
		expect(v.trashInk(), "the trash holds other than the second deleted PDF's ink, strokes whole").toEqual([["ink-1"]]);
		await expectOpens(v, NAME, first, ["ink-0"]);
	});

	it("two deleted, the copy renamed onto the first-deleted name and opened inside the grace: it shows the ink of its bytes on the name, not the second", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [first, second] } = await inked(v, [NAME, SECOND]);
		vi.useFakeTimers();
		await deleteBoth(s);
		await s.renameFile(COPY, NAME);
		const opened = await s.open(NAME);
		expect(opened.id, "the copy opened with another ink file than the one of its bytes on the name").toBe(first);
		expect(opened.id, "the copy was handed the second deleted PDF's ink file").not.toBe(second);
		s.pdfStore.cancelPendingDeletes();
	});

	it("the copy with its own ink renamed onto the name while the deleted file's own new name lands: the deleted ink follows its own new name, and the name opens with the copy's ink", async () => {
		const v = vault();
		const { s, ids: [deleted, own] } = await inked(v, [NAME, COPY]);
		vi.useFakeTimers();
		await deleteName(s);
		await vi.advanceTimersByTimeAsync(1_000);
		await s.createFile(MOVED);
		expect(s.pdfStore.pendingClaims().get(NAME)?.has(MOVED), "precondition: the deleted file's new name did not exist at the delete").toBe(false);
		await s.renameFile(COPY, NAME);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(deleted)?.pdfPaths, "the deleted PDF's ink did not follow its own new name").toEqual([MOVED]);
		expect(v.trashInk(), "ink went to the trash").toEqual([]);
		expect(v.sidecar(own)?.pdfPaths).toEqual([NAME]);
		await expectOpens(v, MOVED, deleted, ["ink-0"]);
		await expectOpens(v, NAME, own, ["ink-1"]);
	});

	it("two panes open the copy at the name together inside the grace: both show one ink file, the one of its bytes on the name", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(COPY, NAME);
		// The first pane's load is held, so the second pane chooses while the first is still loading.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let holding = false;
		const ensure = s.pdfStore.ensureLoaded.bind(s.pdfStore);
		s.pdfStore.ensureLoaded = (async (id: string) => {
			if (!holding) {
				holding = true;
				await gate;
			}
			return ensure(id);
		}) as typeof s.pdfStore.ensureLoaded;
		const first = s.open(NAME);
		await vi.waitFor(() => expect(holding, "precondition: the first pane is loading its ink file").toBe(true));
		// The second pane's identification can end only after the first pane's opening ends, so it is started, seen to
		// choose while the first still loads, and awaited after the release.
		const opening = s.open(NAME);
		await vi.waitFor(() => expect(s.plugin.pdfIds.size, "precondition: the second pane chose while the first is still loading").toBe(2));
		release();
		const [a, second] = await Promise.all([first, opening]);
		expect(a.id, "the first pane opened with another ink file than the one of its bytes on the name").toBe(deleted);
		expect(second.id, "the two panes on one file were given two ink files").toBe(a.id);
		s.pdfStore.cancelPendingDeletes();
	});

	it("CONTROL: a waiting-deletions list saved by the last release, held and paired set, reads back and saves back unchanged", async () => {
		const v = vault();
		v.files.add(COPY);
		const saved = JSON.stringify([{ path: NAME, existingPaths: [COPY], held: ["Form held.pdf"], paired: true }]);
		v.local.set(PENDING_KEY, saved);
		vi.useFakeTimers();
		const s = session(v, { pendingStore: true });
		expect(s.pdfStore.pendingClaims().get(NAME)?.has(COPY), "precondition: the deletion resumed").toBe(true);
		expect(v.local.get(PENDING_KEY), "the list was saved back changed").toBe(saved);
		s.pdfStore.cancelPendingDeletes();
		vi.useRealTimers();
	});

	it("CONTROL: a build that still lists the name when its delete fires, then a sync create inside the grace: the ink keeps the name", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		vi.useFakeTimers();
		await s.plugin.onFileDeleted(pdfFile(NAME));
		v.files.delete(NAME);
		expect(s.pdfStore.pendingClaims().has(NAME), "precondition: the delete is waiting out its grace").toBe(true);
		await vi.advanceTimersByTimeAsync(2_000);
		await s.createFile(NAME);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.trashInk(), "a sync delete then create sent ink to the trash").toEqual([]);
		expect(v.sidecar(deleted)?.pdfPaths).toEqual([NAME]);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
	});
});

/** Counts each time the plugin writes the waiting-deletions list to this device's local storage. */
function countListSaves(s: ReturnType<typeof session>) {
	const app = s.plugin.app as { saveLocalStorage: (key: string, value: unknown) => void };
	const save = app.saveLocalStorage;
	const counter = { saves: 0 };
	app.saveLocalStorage = (key: string, value: unknown) => {
		if (key === PENDING_KEY) counter.saves++;
		save(key, value);
	};
	return counter;
}

describe("a same-bytes copy renamed onto any other name inside the grace", () => {
	it("no pane, the copy has no ink, renamed onto a new name: the deleted ink does not follow it, and goes to the trash", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(COPY, "Form renamed.pdf");
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(deleted)?.pdfPaths, "the deleted ink followed the copy to its new name").not.toEqual(["Form renamed.pdf"]);
		expectDeletedInkTrashed(v, deleted);
		await expectBlank(v, "Form renamed.pdf");
	});

	it("renamed onto a new name and opened inside the grace: the copy is not handed the deleted ink", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(COPY, "Form renamed.pdf");
		const opened = await s.open("Form renamed.pdf");
		expect(opened.id, "the copy opened at its new name was handed the deleted ink file").not.toBe(deleted);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id), "the copy opened at its new name wears ink").toEqual([]);
		s.pdfStore.cancelPendingDeletes();
	});

	it("CONTROL: a file new since the delete (the deleted file's own new name) renamed again inside the grace: the ink still follows it", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		vi.useFakeTimers();
		await deleteName(s);
		await vi.advanceTimersByTimeAsync(1_000);
		await s.createFile(MOVED);
		expect(s.pdfStore.pendingClaims().get(NAME)?.has(MOVED), "precondition: the new name did not exist at the delete").toBe(false);
		await s.renameFile(MOVED, "Form final.pdf");
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.trashInk(), "ink went to the trash").toEqual([]);
		expect(v.sidecar(deleted)?.pdfPaths, "the deleted PDF's ink did not follow its own new name's rename").toEqual(["Form final.pdf"]);
		await expectOpens(v, "Form final.pdf", deleted, ["ink-0"]);
		await expectBlank(v, COPY);
	});

	it("CONTROL: with no deletion waiting, a rename saves the waiting-deletions list no times", async () => {
		const v = vault();
		const { s, ids: [, own] } = await inked(v, [NAME, COPY], { pendingStore: true });
		const counter = countListSaves(s);
		expect(s.pdfStore.pendingClaims().size, "precondition: no deletion is waiting").toBe(0);
		await s.renameFile(COPY, "Form renamed.pdf");
		await s.store.flush();
		expect(v.sidecar(own)?.pdfPaths, "precondition: the rename moved the copy's own claim").toEqual(["Form renamed.pdf"]);
		expect(counter.saves, "a rename with no deletion waiting saved the list").toBe(0);
		vi.useFakeTimers();
		await s.deleteFile(NAME);
		expect(counter.saves, "precondition: the counter sees the list saved at a delete").toBeGreaterThan(0);
		s.pdfStore.cancelPendingDeletes();
		vi.useRealTimers();
	});

	it("CONTROL: with a deletion waiting, a rename whose old name is in no list saves the list no times", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s } = await inked(v, [NAME], { pendingStore: true });
		const counter = countListSaves(s);
		vi.useFakeTimers();
		await deleteName(s);
		expect(counter.saves, "precondition: the counter sees the list saved at a delete").toBeGreaterThan(0);
		await vi.advanceTimersByTimeAsync(1_000);
		await s.createFile("Form (1).pdf");
		expect(s.pdfStore.pendingClaims().get(NAME)?.has("Form (1).pdf"), "precondition: the arriving file is in no list").toBe(false);
		counter.saves = 0;
		await s.renameFile("Form (1).pdf", "Form (2).pdf");
		expect(counter.saves, "a rename of a file in no list saved the list").toBe(0);
		s.pdfStore.cancelPendingDeletes();
		vi.useRealTimers();
	});
});

/** The name the copy goes on to after the deleted name. */
const LEFT = "Form final.pdf";
/** Another file with the same bytes and its own ink. It exists, under this name, when NAME is deleted. */
const OTHER = "Form other.pdf";

describe("a same-bytes copy renamed onto a just-deleted PDF's name and away again inside the grace", () => {
	it("the name then comes back by a create inside the grace (a sync delete then create): the ink keeps the name, nothing goes to the trash", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(COPY, NAME);
		await s.renameFile(NAME, LEFT);
		await s.createFile(NAME);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.trashInk(), "ink went to the trash").toEqual([]);
		expect(v.sidecar(deleted)?.pdfPaths, "the deleted PDF's ink does not claim the name").toEqual([NAME]);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
		await expectBlank(v, LEFT);
	});

	it("nothing comes back to the name: after the grace the deleted ink is in the trash whole, and the copy opens blank", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(COPY, NAME);
		await s.renameFile(NAME, LEFT);
		await settleGrace(s);
		vi.useRealTimers();
		expectDeletedInkTrashed(v, deleted);
		await expectBlank(v, LEFT);
	});

	it("a second file that existed at the delete is then renamed onto the name: the deleted ink is in the trash whole, and the name opens with the second file's ink", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted, other] } = await inked(v, [NAME, OTHER]);
		vi.useFakeTimers();
		await deleteName(s);
		expect(s.pdfStore.pendingClaims().get(NAME)?.has(OTHER), "precondition: the second file existed at the delete").toBe(true);
		await s.renameFile(COPY, NAME);
		await s.renameFile(NAME, LEFT);
		await s.renameFile(OTHER, NAME);
		await s.store.flush();
		expect(v.sidecar(other)?.pdfPaths, "precondition: the rename moved the second file's own claim to the name").toEqual([NAME]);
		await settleGrace(s);
		vi.useRealTimers();
		expectDeletedInkTrashed(v, deleted);
		expect(v.sidecar(other)?.pdfPaths).toEqual([NAME]);
		await expectOpens(v, NAME, other, ["ink-1"]);
		await expectBlank(v, LEFT);
	});

	it("a quit between the copy leaving the name and the name coming back: the next session keeps the ink on the name, nothing goes to the trash", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s: first, ids: [deleted] } = await inked(v, [NAME], { pendingStore: true });
		vi.useFakeTimers();
		await deleteName(first);
		await first.renameFile(COPY, NAME);
		await first.renameFile(NAME, LEFT);
		// Quit inside the grace: the deletion is saved.
		first.pdfStore.cancelPendingDeletes();
		expect(v.local.size, "precondition: the deletion was saved").toBe(1);
		const next = session(v, { pendingStore: true });
		expect(next.pdfStore.pendingClaims().has(NAME), "precondition: the deletion resumed").toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);
		await next.createFile(NAME);
		await settleGrace(next);
		vi.useRealTimers();
		expect(v.trashInk(), "ink went to the trash").toEqual([]);
		expect(v.sidecar(deleted)?.pdfPaths, "the deleted PDF's ink does not claim the name").toEqual([NAME]);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
		await expectBlank(v, LEFT);
	});

	it("the name comes back and is opened inside the grace: it opens with the deleted ink, and nothing goes to the trash", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(COPY, NAME);
		await s.renameFile(NAME, LEFT);
		await s.createFile(NAME);
		const opened = await s.open(NAME);
		expect(opened.id, "the name that came back opened another ink file than its own").toBe(deleted);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id)).toEqual(["ink-0"]);
		s.close(opened.root);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.trashInk(), "ink went to the trash").toEqual([]);
		expect(v.sidecar(deleted)?.pdfPaths).toEqual([NAME]);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
		await expectBlank(v, LEFT);
	});

	it("a pane on the copy (no ink) through both renames, then the name created inside the grace: the ink keeps the name, nothing goes to the trash", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		const pane = await s.open(COPY);
		expect(pane.id, "precondition: the pane on the copy is not the deleted PDF's ink file").not.toBe(deleted);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(COPY, NAME);
		await s.renameFile(NAME, LEFT);
		expect(s.plugin.pdfFiles.get(pane.root), "precondition: the pane followed both renames").toBe(LEFT);
		await s.createFile(NAME);
		await settleGrace(s);
		s.close(pane.root);
		vi.useRealTimers();
		expect(v.trashInk(), "ink went to the trash").toEqual([]);
		expect(v.sidecar(deleted)?.pdfPaths).toEqual([NAME]);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
		await expectBlank(v, LEFT);
	});

	it("the same, the move beside the pane off the name waiting on the ink folder's listing until after the grace: the deleted ink keeps the name, nothing goes to the trash", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		const pane = await s.open(COPY);
		expect(pane.id, "precondition: the pane on the copy is not the deleted PDF's ink file").not.toBe(deleted);
		vi.useFakeTimers();
		await deleteName(s);
		await vi.advanceTimersByTimeAsync(5_000);
		await s.renameFile(COPY, NAME);
		// The move beside the pane off the name finds the ink folder unlisted (two listings failed in a row, as
		// PageStore.listIds tells it) and tries again 10 s on, past the grace. Every other listing works.
		const listIds = s.store.listIds.bind(s.store);
		const listing = { armed: false, failed: 0, calls: 0 };
		s.store.listIds = async (prefix: string) => {
			listing.calls++;
			if (listing.armed) {
				listing.armed = false;
				listing.failed++;
				throw new InkFolderListingFailed(".handwriting", new Error("ENOENT: no such file or directory, stat '.handwriting/pdf-sync.json.tmp'"));
			}
			return listIds(prefix);
		};
		const beside = s.plugin.movePdfClaimsBesidePane;
		s.plugin.movePdfClaimsBesidePane = (...a: Parameters<typeof beside>) => {
			if (a[1] === NAME) listing.armed = true;
			return beside(...a);
		};
		await s.renameFile(NAME, LEFT);
		expect(s.plugin.pdfFiles.get(pane.root), "precondition: the pane followed both renames").toBe(LEFT);
		expect(listing.failed, "precondition: the move beside the pane off the name failed on the listing").toBe(1);
		await s.createFile(NAME);
		// The grace runs out with the move still waiting: the name came back, so the retirement keeps the ink there.
		await vi.advanceTimersByTimeAsync(5_001);
		await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
		await s.store.flush();
		expect(v.sidecar(deleted)?.pdfPaths, "precondition: the retirement kept the deleted PDF's ink on the name").toEqual([NAME]);
		// The move's try 10 s on, after the deletion it found at the rename has ended.
		const calls = listing.calls;
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.waitFor(() => expect(listing.calls, "precondition: the move's try 10 s on listed the ink folder").toBeGreaterThan(calls));
		// From its listing on, the try is promise callbacks: the advance lets them all run first.
		await vi.advanceTimersByTimeAsync(0);
		await s.store.flush();
		s.close(pane.root);
		vi.useRealTimers();
		expect(v.trashInk(), "ink went to the trash").toEqual([]);
		expect(v.sidecar(deleted)?.pdfPaths, "the late move took the deleted PDF's ink to the copy's new name").toEqual([NAME]);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
		await expectBlank(v, LEFT);
	});

	it("no pane, the copy renamed off the name and on again before the first claim move has run: the deleted ink does not follow it", async () => {
		const LAST = "Form last.pdf";
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(COPY, NAME);
		// The claim move the copy's leave starts waits until the copy has been renamed again. The vault keeps one
		// file object through both renames, so by then that move reads the copy's last name.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let leaving: { path: string } | undefined;
		let held: Promise<void> | undefined;
		const move = s.plugin.movePdfClaimOnRename;
		s.plugin.movePdfClaimOnRename = (file: TFile, oldPath: string) => {
			if (oldPath !== NAME || leaving) return move(file, oldPath);
			leaving = file;
			held = gate.then(() => move(file, oldPath));
			return held;
		};
		await s.renameFile(NAME, LEFT);
		expect(leaving?.path, "precondition: the leave started a claim move, held").toBe(LEFT);
		await s.renameFile(LEFT, LAST);
		leaving!.path = LAST;
		release();
		await held;
		await s.store.flush();
		expect(v.sidecar(deleted)?.pdfPaths, "the deleted PDF's ink followed the copy").toEqual([NAME]);
		expect(s.pdfStore.pendingClaims().has(NAME), "the copy's leave ended the name's deletion").toBe(true);
		await settleGrace(s);
		vi.useRealTimers();
		expectDeletedInkTrashed(v, deleted);
		await expectBlank(v, LAST);
	});
});

describe("a copy renamed onto a just-deleted PDF's name: the deleted file's own new name, and the copy straight back", () => {
	it("the deleted file's own new name lands and is opened inside the grace while the copy sits on the name: after the grace the new name opens with the deleted ink", async () => {
		const v = vault();
		const { s, ids: [deleted, own] } = await inked(v, [NAME, COPY]);
		vi.useFakeTimers();
		await deleteName(s);
		await vi.advanceTimersByTimeAsync(1_000);
		await s.createFile(MOVED);
		await s.renameFile(COPY, NAME);
		const pane = await s.open(MOVED);
		expect(pane.id, "the deleted file's own new name opened blank").toBe(deleted);
		await settleGrace(s);
		s.close(pane.root);
		vi.useRealTimers();
		expect(v.trashInk(), "ink went to the trash").toEqual([]);
		await expectOpens(v, MOVED, deleted, ["ink-0"]);
		await expectOpens(v, NAME, own, ["ink-1"]);
	});

	it("the copy renamed onto the name and straight back to its own name; the name created again inside the grace keeps the deleted ink", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s, ids: [deleted] } = await inked(v, [NAME]);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(COPY, NAME);
		await s.renameFile(NAME, COPY);
		await s.createFile(NAME);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.trashInk(), "ink went to the trash").toEqual([]);
		expect(v.sidecar(deleted)?.pdfPaths).toEqual([NAME]);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
		await expectBlank(v, COPY);
	});

	it("the same with a quit after the copy is back; the name created in the next session keeps the deleted ink", async () => {
		const v = vault();
		v.files.add(COPY);
		const { s: first, ids: [deleted] } = await inked(v, [NAME], { pendingStore: true });
		vi.useFakeTimers();
		await deleteName(first);
		await first.renameFile(COPY, NAME);
		await first.renameFile(NAME, COPY);
		first.pdfStore.cancelPendingDeletes();
		expect(v.local.size, "precondition: the deletion was saved").toBe(1);
		const next = session(v, { pendingStore: true });
		expect(next.pdfStore.pendingClaims().has(NAME), "precondition: the deletion resumed").toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);
		await next.createFile(NAME);
		await settleGrace(next);
		vi.useRealTimers();
		expect(v.trashInk(), "ink went to the trash").toEqual([]);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
	});
});
