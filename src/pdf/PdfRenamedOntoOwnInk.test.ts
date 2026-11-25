/**
 * A PDF renamed onto the name of a PDF deleted moments before keeps an ink file of its own bytes that claims the
 * name, whatever order the ink file, the delete and the rename reach this device in: that ink is the renamed file's.
 * It opens with it, and the deleted PDF's ink, of other bytes, goes to the trash as before. Through the plugin and
 * the real stores, with an in-memory vault (the harness of PdfCarryRenamedOntoDeleted.test.ts), plus the plugin's
 * own rename handler. An ink file "landing" is another device's write synced into the ink folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What the plugin told the user through Obsidian's Notice. The stub's Notice is an empty class, so it is replaced here.
const shown = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class Notice {
		constructor(message: string) {
			shown.push(message);
		}
	}
	return { ...actual, Notice };
});

import HandwritingPlugin from "../main";
import { TFile, Notice } from "obsidian";
import pluginSettingsSource from "../settings/PluginSettings.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { parsePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

/** The PDF that is deleted, and the name the other file is renamed onto. */
const NAME = "Homework.pdf";
/** The other file's name before the rename. It exists, with other bytes, when NAME is deleted. */
const OTHER = "Homework v2.pdf";

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

/** The bytes of one document. Another `tag` is another document (another content family). */
function doc(tag: string): Uint8Array {
	return new TextEncoder().encode(`%PDF-1.4\n% ${tag}\n1 0 obj << /Type /Catalog >> endobj\n` + "x".repeat(5000) + "\n%%EOF\n");
}

const OLD = doc("homework");
const NEW = doc("homework v2");
const THIRD_BYTES = doc("homework v3");
/** Another file of NEW's bytes, inked here and deleted in the same grace. */
const NOTES = "Notes.pdf";
/** A new copy of NEW's bytes, its name nearer the renamed-onto name than NOTES. */
const COPY_OF_NAME = "Homework copy.pdf";
/** A file of THIRD_BYTES, and the name the first file is renamed off to. */
const THIRD = "Homework v3.pdf";
const OFF = "Homework kept.pdf";

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	shown.length = 0;
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** One device's vault (disk + file list with each file's bytes) shared by any number of plugin sessions. */
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
	/** The vault's PDFs, path to bytes. */
	const files = new Map<string, Uint8Array>();
	/** PDFs whose bytes cannot be read just now. */
	const failRead = new Set<string>();
	/** PDFs whose next read only fails. */
	const failReadOnce = new Set<string>();
	/** This device's local storage, which outlives a plugin session. */
	const local = new Map<string, unknown>();
	function sidecar(id: string) {
		const bytes = adapter.files.get(`.handwriting/${id}.json`);
		return bytes === undefined ? undefined : parsePage(bytes, id).data;
	}
	/** The strokes of every ink file in the trash, one list per file, sorted. */
	function trashInk(): string[][] {
		return [...adapter.files.entries()]
			.filter(([p]) => p.includes("/trash/"))
			.map(([p, bytes]) => parsePage(bytes, p).data.strokes.map((s) => s.id))
			.sort();
	}
	/** The ink files outside the trash. */
	function inkFiles(): string[] {
		return [...adapter.files.keys()].filter((p) => p.startsWith(".handwriting/") && !p.includes("/trash/")).sort();
	}
	return { adapter, files, failRead, failReadOnce, local, sidecar, trashInk, inkFiles };
}

type Vault = ReturnType<typeof vault>;

function pdfFile(path: string) {
	return Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		name: path.split("/").pop(),
		basename: path.replace(/\.[^.]+$/, ""),
	});
}

/**
 * A plugin session (fresh memory) over the vault, with the plugin's own vault events, the layout ready.
 * `pendingStore` restores and saves deletions in their grace the way the plugin does at load.
 */
function session(v: Vault, opts: { pendingStore?: boolean } = {}) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	const pdfStore = new PdfInkStore();
	const vaultOn = new Map<string, ((...a: unknown[]) => unknown)[]>();
	const app = {
		vault: {
			adapter: v.adapter,
			getFiles: () => [...v.files.keys()].map((path) => ({ path, extension: "pdf" })),
			readBinary: async (file: { path: string }) => {
				if (v.failRead.has(file.path)) throw new Error(`cannot read ${file.path} just now`);
				if (v.failReadOnce.delete(file.path)) throw new Error(`cannot read ${file.path} this once`);
				const bytes = v.files.get(file.path);
				if (!bytes) throw new Error(`no file at ${file.path}`);
				return bytes.slice().buffer;
			},
			getFileByPath: (p: string) => (v.files.has(p) ? { path: p, extension: "pdf" } : null),
			on: (name: string, handler: (...a: unknown[]) => unknown) => {
				vaultOn.set(name, [...(vaultOn.get(name) ?? []), handler]);
				return {};
			},
		},
		workspace: { layoutReady: true },
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
	/** The vault adds the file with these bytes, then every create handler the plugin registered runs. */
	async function createFile(path: string, bytes: Uint8Array) {
		v.files.set(path, bytes);
		for (const handler of vaultOn.get("create") ?? []) await handler(pdfFile(path));
	}
	/** The vault moves the file and its bytes, then every rename handler the plugin registered runs, and any claim move it started. */
	async function renameFile(from: string, to: string) {
		const bytes = v.files.get(from);
		expect(bytes, `precondition: ${from} exists before the rename`).toBeDefined();
		expect(v.files.has(to), `precondition: nothing is at ${to} before the rename`).toBe(false);
		v.files.delete(from);
		v.files.set(to, bytes!);
		for (const handler of vaultOn.get("rename") ?? []) await handler(pdfFile(to), from);
		await Promise.all(moves.splice(0));
	}
	return { store, pdfStore, plugin, open, close, draw, deleteFile, createFile, renameFile };
}

type Session = ReturnType<typeof session>;

/** Open `path` in `s`, draw one stroke, save, close. Returns the ink id. */
async function inkOn(s: Session, path: string, strokeId: string, x = 10): Promise<string> {
	const o = await s.open(path);
	s.draw(o.id, stroke(x, strokeId));
	await s.store.flush();
	s.close(o.root);
	return o.id;
}

/** An ink file drawn on another device on a PDF of these bytes at `path`: its id and its file's text. */
async function inkFromElsewhere(
	bytes: Uint8Array,
	path: string,
	strokeId: string,
	/** Another copy opened there first, so this ink file is not the first id of its bytes this device would choose. */
	second = false
): Promise<{ id: string; text: string }> {
	const w = vault();
	w.files.set(path, bytes);
	const ws = session(w);
	if (second) {
		w.files.set("Spare.pdf", bytes);
		await ws.open("Spare.pdf");
	}
	const id = await inkOn(ws, path, strokeId);
	const text = w.adapter.files.get(`.handwriting/${id}.json`);
	expect(text, "precondition: the other device wrote the ink file").toBeDefined();
	return { id, text: text! };
}

/** Another device's revision of ink file `id`, claiming `paths`, syncs into this device's ink folder. */
function land(v: Vault, id: string, text: string, paths: string[]) {
	const data = JSON.parse(text) as { pdfPaths?: string[] };
	data.pdfPaths = paths;
	v.adapter.externalWrite(`.handwriting/${id}.json`, JSON.stringify(data));
	expect(v.sidecar(id)?.pdfPaths, "precondition: the landed ink file claims these paths").toEqual(paths);
}

/** NAME (OLD bytes) inked "ink-0" and closed, OTHER (NEW bytes, no ink here) in the vault. */
async function inkedNameAndOther(v: Vault, opts: { pendingStore?: boolean } = {}) {
	v.files.set(NAME, OLD);
	v.files.set(OTHER, NEW);
	const s = session(v, opts);
	const deleted = await inkOn(s, NAME, "ink-0");
	expect(v.sidecar(deleted)?.pdfPaths, "precondition: the deleted PDF's ink file claims its name").toEqual([NAME]);
	return { s, deleted };
}

/** NAME is deleted with OTHER in the vault: the deletion counts OTHER as existing and NAME as gone. */
async function deleteName(s: Session, other = OTHER) {
	await s.deleteFile(NAME);
	const existing = s.pdfStore.pendingClaims().get(NAME);
	expect(existing, "precondition: the delete of the name is waiting out its grace").toBeDefined();
	expect(existing?.has(other), "precondition: the other file existed at the delete").toBe(true);
	expect(existing?.has(NAME), "precondition: the deleted name is not among the paths that existed at the delete").toBe(false);
}

/** Run every grace out and let each retirement finish. */
async function settleGrace(s: Session) {
	await vi.advanceTimersByTimeAsync(10_001);
	await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
	await s.store.flush();
}

/** The renamed file's own ink is outside the trash, claiming the name, and the trash holds the deleted ink only. */
function expectOwnKeptDeletedTrashed(v: Vault, own: string, deleted: string) {
	expect(v.sidecar(own)?.pdfPaths, "the renamed file's own ink file is gone from the ink folder").toEqual([NAME]);
	expect(v.sidecar(deleted), "the deleted PDF's ink file still claims the name after the grace").toBeUndefined();
	expect(v.trashInk(), "the trash holds the deleted PDF's ink, strokes whole, and nothing else").toEqual([["ink-0"]]);
}

/** A later session opens `path` and finds `id` with exactly this ink. */
async function expectOpensLater(v: Vault, path: string, id: string, ink: string[]) {
	const later = session(v);
	const opened = await later.open(path);
	expect(opened.id, `${path} opened later with another ink file`).toBe(id);
	expect(later.pdfStore.strokes(opened.id).map((x) => x.id), `${path} opened later with other ink`).toEqual(ink);
}

describe("the file renamed onto a just-deleted name, its own ink synced in under that name after the rename", () => {
	it("opened inside the grace: it opens with its own ink, and only the deleted PDF's ink goes to the trash", async () => {
		const v = vault();
		const { s, deleted } = await inkedNameAndOther(v);
		const own = await inkFromElsewhere(NEW, NAME, "ink-2");
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(OTHER, NAME);
		land(v, own.id, own.text, [NAME]);
		const opened = await s.open(NAME);
		expect(opened.id, "the renamed file did not open with its own ink file").toBe(own.id);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id), "the renamed file opened without its own ink").toEqual(["ink-2"]);
		s.close(opened.root);
		await settleGrace(s);
		vi.useRealTimers();
		expectOwnKeptDeletedTrashed(v, own.id, deleted);
		await expectOpensLater(v, NAME, own.id, ["ink-2"]);
	});

	it("no pane: after the grace its own ink is outside the trash, and the name opens with it", async () => {
		const v = vault();
		const { s, deleted } = await inkedNameAndOther(v);
		const own = await inkFromElsewhere(NEW, NAME, "ink-2");
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(OTHER, NAME);
		land(v, own.id, own.text, [NAME]);
		await settleGrace(s);
		vi.useRealTimers();
		expectOwnKeptDeletedTrashed(v, own.id, deleted);
		await expectOpensLater(v, NAME, own.id, ["ink-2"]);
	});

	it("a quit inside the grace, its own ink landing before the next session: that session keeps it, and the name opens with it", async () => {
		const v = vault();
		const { s: first, deleted } = await inkedNameAndOther(v, { pendingStore: true });
		const own = await inkFromElsewhere(NEW, NAME, "ink-2");
		vi.useFakeTimers();
		await deleteName(first);
		await first.renameFile(OTHER, NAME);
		// Quit inside the grace: the deletion is saved.
		first.pdfStore.cancelPendingDeletes();
		expect(v.local.size, "precondition: the deletion was saved").toBe(1);
		land(v, own.id, own.text, [NAME]);
		const next = session(v, { pendingStore: true });
		expect(next.pdfStore.pendingClaims().has(NAME), "precondition: the deletion resumed").toBe(true);
		await settleGrace(next);
		vi.useRealTimers();
		expectOwnKeptDeletedTrashed(v, own.id, deleted);
		await expectOpensLater(v, NAME, own.id, ["ink-2"]);
	});

	it("a new file of the same bytes made inside the grace and opened first: it is not handed that ink, and the name opens with it", async () => {
		const v = vault();
		const { s, deleted } = await inkedNameAndOther(v);
		const own = await inkFromElsewhere(NEW, NAME, "ink-2");
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(OTHER, NAME);
		land(v, own.id, own.text, [NAME]);
		await s.createFile("Homework v2 copy.pdf", NEW);
		const copy = await s.open("Homework v2 copy.pdf");
		expect(copy.id, "the new copy was handed the renamed file's own ink file").not.toBe(own.id);
		expect(s.pdfStore.strokes(copy.id).map((x) => x.id), "the new copy opened wearing ink").toEqual([]);
		s.close(copy.root);
		const opened = await s.open(NAME);
		expect(opened.id, "the renamed file did not open with its own ink file").toBe(own.id);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id)).toEqual(["ink-2"]);
		s.close(opened.root);
		await settleGrace(s);
		vi.useRealTimers();
		expectOwnKeptDeletedTrashed(v, own.id, deleted);
	});

	it("its bytes not read when it was renamed on, then opened inside the grace: it opens with its own ink", async () => {
		const v = vault();
		const { s, deleted } = await inkedNameAndOther(v);
		const own = await inkFromElsewhere(NEW, NAME, "ink-2");
		vi.useFakeTimers();
		await deleteName(s);
		// The first read of its bytes after the rename (the background one) fails; the open's own read works.
		v.failReadOnce.add(NAME);
		await s.renameFile(OTHER, NAME);
		await vi.advanceTimersByTimeAsync(0);
		expect(v.failReadOnce.has(NAME), "precondition: a read after the rename failed").toBe(false);
		land(v, own.id, own.text, [NAME]);
		const opened = await s.open(NAME);
		expect(opened.id, "the renamed file did not open with its own ink file").toBe(own.id);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id), "the renamed file opened without its own ink").toEqual(["ink-2"]);
		s.close(opened.root);
		await settleGrace(s);
		vi.useRealTimers();
		expectOwnKeptDeletedTrashed(v, own.id, deleted);
	});

	it("another file of its bytes deleted in the same grace, a new copy of them opened: the copy is not handed its own ink", async () => {
		const v = vault();
		const { s, deleted } = await inkedNameAndOther(v);
		v.files.set(NOTES, NEW);
		const notes = await inkOn(s, NOTES, "ink-n");
		const own = await inkFromElsewhere(NEW, NAME, "ink-2", true);
		expect(own.id, "precondition: the renamed file's own ink file is another than the deleted copy's").not.toBe(notes);
		vi.useFakeTimers();
		await deleteName(s);
		await s.deleteFile(NOTES);
		await s.renameFile(OTHER, NAME);
		land(v, own.id, own.text, [NAME]);
		await s.createFile(COPY_OF_NAME, NEW);
		const copy = await s.open(COPY_OF_NAME);
		expect(copy.id, "the new copy was handed the renamed file's own ink file").not.toBe(own.id);
		s.close(copy.root);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(own.id)?.pdfPaths, "the renamed file's own ink file is gone from the ink folder").toEqual([NAME]);
		expect(v.sidecar(deleted), "the deleted PDF's ink file still claims the name after the grace").toBeUndefined();
		await expectOpensLater(v, NAME, own.id, ["ink-2"]);
	});

	it("the same, a quit inside the grace and the copy opened in the next session: the copy is not handed its own ink", async () => {
		const v = vault();
		const { s: first, deleted } = await inkedNameAndOther(v, { pendingStore: true });
		v.files.set(NOTES, NEW);
		const notes = await inkOn(first, NOTES, "ink-n");
		const own = await inkFromElsewhere(NEW, NAME, "ink-2", true);
		expect(own.id, "precondition: the renamed file's own ink file is another than the deleted copy's").not.toBe(notes);
		vi.useFakeTimers();
		await deleteName(first);
		await first.deleteFile(NOTES);
		await first.renameFile(OTHER, NAME);
		first.pdfStore.cancelPendingDeletes();
		land(v, own.id, own.text, [NAME]);
		const next = session(v, { pendingStore: true });
		expect(next.pdfStore.pendingClaims().has(NAME), "precondition: the deletion resumed").toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		await next.createFile(COPY_OF_NAME, NEW);
		const copy = await next.open(COPY_OF_NAME);
		expect(copy.id, "the new copy was handed the renamed file's own ink file").not.toBe(own.id);
		next.close(copy.root);
		await settleGrace(next);
		vi.useRealTimers();
		expect(v.sidecar(own.id)?.pdfPaths, "the renamed file's own ink file is gone from the ink folder").toEqual([NAME]);
		expect(v.sidecar(deleted), "the deleted PDF's ink file still claims the name after the grace").toBeUndefined();
		await expectOpensLater(v, NAME, own.id, ["ink-2"]);
	});

	it("another file of its bytes deleted in the same grace, a new copy of them opened: the copy opens with that deleted file's ink", async () => {
		const v = vault();
		const { s } = await inkedNameAndOther(v);
		v.files.set(NOTES, NEW);
		const notes = await inkOn(s, NOTES, "ink-n");
		const own = await inkFromElsewhere(NEW, NAME, "ink-2", true);
		expect(own.id, "precondition: the renamed file's own ink file is another than the deleted copy's").not.toBe(notes);
		vi.useFakeTimers();
		await deleteName(s);
		await s.deleteFile(NOTES);
		await s.renameFile(OTHER, NAME);
		land(v, own.id, own.text, [NAME]);
		await vi.advanceTimersByTimeAsync(0);
		await s.createFile(COPY_OF_NAME, NEW);
		const copy = await s.open(COPY_OF_NAME);
		expect(copy.id, "the new copy did not open with the deleted file's ink file").toBe(notes);
		expect(s.pdfStore.strokes(copy.id).map((x) => x.id), "the new copy did not open with the deleted file's ink").toEqual(["ink-n"]);
		s.close(copy.root);
		await settleGrace(s);
		vi.useRealTimers();
		await expectOpensLater(v, NAME, own.id, ["ink-2"]);
	});

	it("the same, a quit inside the grace and the copy opened in the next session: the copy opens with that deleted file's ink", async () => {
		const v = vault();
		const { s: first } = await inkedNameAndOther(v, { pendingStore: true });
		v.files.set(NOTES, NEW);
		const notes = await inkOn(first, NOTES, "ink-n");
		const own = await inkFromElsewhere(NEW, NAME, "ink-2", true);
		expect(own.id, "precondition: the renamed file's own ink file is another than the deleted copy's").not.toBe(notes);
		vi.useFakeTimers();
		await deleteName(first);
		await first.deleteFile(NOTES);
		await first.renameFile(OTHER, NAME);
		first.pdfStore.cancelPendingDeletes();
		land(v, own.id, own.text, [NAME]);
		const next = session(v, { pendingStore: true });
		expect(next.pdfStore.pendingClaims().has(NAME), "precondition: the deletion resumed").toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		await next.createFile(COPY_OF_NAME, NEW);
		const copy = await next.open(COPY_OF_NAME);
		expect(copy.id, "the new copy did not open with the deleted file's ink file").toBe(notes);
		expect(next.pdfStore.strokes(copy.id).map((x) => x.id), "the new copy did not open with the deleted file's ink").toEqual(["ink-n"]);
		next.close(copy.root);
		await settleGrace(next);
		vi.useRealTimers();
		await expectOpensLater(v, NAME, own.id, ["ink-2"]);
	});

	it("a file with its own ink renamed onto the name and off again, then a file without ink renamed on: that file's own ink stays", async () => {
		const v = vault();
		const { s, deleted } = await inkedNameAndOther(v);
		v.files.set(THIRD, THIRD_BYTES);
		const inked = await inkOn(s, OTHER, "ink-1");
		const own = await inkFromElsewhere(THIRD_BYTES, NAME, "ink-3");
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(OTHER, NAME);
		// The no-pane move hands its save to the page store; written once flushed.
		await s.store.flush();
		expect(v.sidecar(inked)?.pdfPaths, "precondition: the ink the first file came with moved with it").toEqual([NAME]);
		await s.renameFile(NAME, OFF);
		await s.store.flush();
		expect(v.sidecar(inked)?.pdfPaths, "precondition: the ink the first file came with left with it").toEqual([OFF]);
		await s.renameFile(THIRD, NAME);
		land(v, own.id, own.text, [NAME]);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(own.id)?.pdfPaths, "the second file's own ink file is gone from the ink folder").toEqual([NAME]);
		expect(v.sidecar(inked)?.pdfPaths, "the first file's ink did not stay with it").toEqual([OFF]);
		expect(v.sidecar(deleted), "the deleted PDF's ink file still claims the name after the grace").toBeUndefined();
		await expectOpensLater(v, NAME, own.id, ["ink-3"]);
	});

	it("the name opened blank and inked before its own ink lands: the first ink file shows, and neither goes to the trash", async () => {
		const v = vault();
		const { s, deleted } = await inkedNameAndOther(v);
		const own = await inkFromElsewhere(NEW, NAME, "ink-2", true);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(OTHER, NAME);
		const first = await s.open(NAME);
		expect(first.id, "precondition: the name opened on a new ink file").not.toBe(own.id);
		s.draw(first.id, stroke(40, "ink-z"));
		await s.store.flush();
		s.close(first.root);
		land(v, own.id, own.text, [NAME]);
		const again = await s.open(NAME);
		expect(again.id, "the name opened with another ink file than the one first drawn on").toBe(first.id);
		expect(s.pdfStore.strokes(again.id).map((x) => x.id)).toEqual(["ink-z"]);
		s.close(again.root);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(first.id)?.pdfPaths, "the ink first drawn on the name is gone from the ink folder").toEqual([NAME]);
		expect(v.sidecar(own.id)?.pdfPaths, "the renamed file's own ink file is gone from the ink folder").toEqual([NAME]);
		expect(v.sidecar(deleted), "the deleted PDF's ink file still claims the name after the grace").toBeUndefined();
		expect(v.trashInk(), "the trash holds the deleted PDF's ink, strokes whole, and nothing else").toEqual([["ink-0"]]);
	});

	it("the name's bytes cannot be read at the grace: its own ink is not trashed, and once read it stays", async () => {
		const v = vault();
		const { s, deleted } = await inkedNameAndOther(v);
		const own = await inkFromElsewhere(NEW, NAME, "ink-2");
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(OTHER, NAME);
		land(v, own.id, own.text, [NAME]);
		v.failRead.add(NAME);
		await vi.advanceTimersByTimeAsync(10_001);
		await s.store.flush();
		expect(v.sidecar(own.id)?.pdfPaths, "the renamed file's own ink went while its bytes could not be read").toEqual([NAME]);
		expect(v.trashInk().flat(), "the renamed file's own ink is in the trash").not.toContain("ink-2");
		v.failRead.delete(NAME);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
		await s.store.flush();
		vi.useRealTimers();
		expectOwnKeptDeletedTrashed(v, own.id, deleted);
	});

	it("an older version of the deleted PDF put back by rename: it opens with the ink drawn on that version, and the newer ink goes to the trash", async () => {
		const v = vault();
		const VERSION_1 = doc("homework first version");
		v.files.set(NAME, VERSION_1);
		const s = session(v);
		const older = await inkOn(s, NAME, "ink-old");
		// The PDF changes on disk while closed; its next open carries the ink to the new bytes, and more is drawn there.
		v.files.set(NAME, OLD);
		const newer = await s.open(NAME);
		expect(newer.id, "precondition: the changed PDF opened on a new ink file").not.toBe(older);
		s.draw(newer.id, stroke(60, "ink-new"));
		await s.store.flush();
		s.close(newer.root);
		expect(v.sidecar(older)?.pdfPaths, "precondition: the older ink file still claims the name").toEqual([NAME]);
		// The older version, kept under another name, goes back over the name.
		v.files.set(OTHER, VERSION_1);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(OTHER, NAME);
		const opened = await s.open(NAME);
		expect(opened.id, "the older version did not open with the ink drawn on it").toBe(older);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id)).toEqual(["ink-old"]);
		s.close(opened.root);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(older)?.pdfPaths, "the older version's ink file is gone from the ink folder").toEqual([NAME]);
		expect(v.sidecar(newer.id), "the newer ink file still claims the name after the grace").toBeUndefined();
		expect(v.trashInk().flat(), "the newer ink is not in the trash").toContain("ink-new");
		await expectOpensLater(v, NAME, older, ["ink-old"]);
	});
});

describe("a device that catches up on a PDF replaced by rename on another device", () => {
	/** This device's vault: NAME (OLD) inked "ink-0", OTHER (NEW) inked "ink-1", both closed. */
	async function bothInked(v: Vault) {
		v.files.set(NAME, OLD);
		v.files.set(OTHER, NEW);
		const s = session(v);
		const deleted = await inkOn(s, NAME, "ink-0");
		const own = await inkOn(s, OTHER, "ink-1", 30);
		const text = v.adapter.files.get(`.handwriting/${own}.json`)!;
		return { s, deleted, own, text };
	}

	it("the other device's ink file, now claiming the name, lands before the delete: after the grace it is outside the trash, and the name opens with it", async () => {
		const v = vault();
		const { deleted, own, text } = await bothInked(v);
		land(v, own, text, [NAME]);
		// This device was asleep: a fresh session hears the delete, then the rename.
		const s = session(v);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(OTHER, NAME);
		await settleGrace(s);
		vi.useRealTimers();
		expectOwnKeptDeletedTrashed(v, own, deleted);
		await expectOpensLater(v, NAME, own, ["ink-1"]);
	});

	it("the same, opened inside the grace: it opens with that ink", async () => {
		const v = vault();
		const { deleted, own, text } = await bothInked(v);
		land(v, own, text, [NAME]);
		const s = session(v);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(OTHER, NAME);
		const opened = await s.open(NAME);
		expect(opened.id, "the renamed file did not open with its own ink file").toBe(own);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id)).toEqual(["ink-1"]);
		s.close(opened.root);
		await settleGrace(s);
		vi.useRealTimers();
		expectOwnKeptDeletedTrashed(v, own, deleted);
	});

	it("a pane on the other file, the poll taking in its ink file's new claim before the rename: the pane keeps its ink, and it stays outside the trash", async () => {
		const v = vault();
		const { s, deleted, own, text } = await bothInked(v);
		const pane = await s.open(OTHER);
		expect(pane.id, "precondition: the pane shows the other file's own ink").toBe(own);
		vi.useFakeTimers();
		await deleteName(s);
		land(v, own, text, [NAME]);
		await s.pdfStore.reloadExternal(own);
		await s.renameFile(OTHER, NAME);
		await settleGrace(s);
		expect(s.pdfStore.strokes(own).map((x) => x.id), "the pane lost its ink").toEqual(["ink-1"]);
		s.close(pane.root);
		await s.store.flush();
		vi.useRealTimers();
		expectOwnKeptDeletedTrashed(v, own, deleted);
	});

	it("CONTROL: a pane on the other file, the rename heard before the poll takes in the new claim: the pane keeps its ink, the other device's revision is kept as a copy as before", async () => {
		const v = vault();
		const { s, deleted, own, text } = await bothInked(v);
		const pane = await s.open(OTHER);
		expect(pane.id, "precondition: the pane shows the other file's own ink").toBe(own);
		const before = v.inkFiles();
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(OTHER, NAME);
		land(v, own, text, [NAME]);
		await s.pdfStore.reloadExternal(own);
		await settleGrace(s);
		expect(s.pdfStore.strokes(own).map((x) => x.id), "the pane lost its ink").toEqual(["ink-1"]);
		s.close(pane.root);
		await s.store.flush();
		vi.useRealTimers();
		expectOwnKeptDeletedTrashed(v, own, deleted);
		// Today's answer, not this fix's: the other device's revision of the same ink file, landing after this device
		// wrote the moved claim, is a second writer, kept as a copy beside it (I286-1).
		const kept = v.inkFiles().filter((p) => !before.includes(p));
		expect(kept, "not one second-writer copy of the renamed file's ink file").toHaveLength(1);
		expect(kept[0]).toMatch(new RegExp(`^\\.handwriting/${own}\\.conflict-\\d+\\.json$`));
		expect(v.inkFiles().filter((p) => before.includes(p)), "an ink file other than the deleted one went").toEqual(
			before.filter((p) => p !== `.handwriting/${deleted}.json`)
		);
		expect(shown, "a notice was shown").toEqual([]);
	});

	it("CONTROL: the replace heard as a delete and a create at the name, the other file never here: its ink, landed first, stays and opens", async () => {
		const v = vault();
		v.files.set(NAME, OLD);
		const s = session(v);
		await inkOn(s, NAME, "ink-0");
		const own = await inkFromElsewhere(NEW, NAME, "ink-1");
		land(v, own.id, own.text, [NAME]);
		vi.useFakeTimers();
		await s.deleteFile(NAME);
		expect(s.pdfStore.pendingClaims().has(NAME), "precondition: the delete is waiting out its grace").toBe(true);
		await s.createFile(NAME, NEW);
		await vi.advanceTimersByTimeAsync(10_001);
		await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
		await s.store.flush();
		vi.useRealTimers();
		expect(v.sidecar(own.id)?.pdfPaths, "the replacing file's ink file is gone from the ink folder").toEqual([NAME]);
		expect(v.trashInk().flat(), "the replacing file's ink is in the trash").not.toContain("ink-1");
		await expectOpensLater(v, NAME, own.id, ["ink-1"]);
	});

	it("CONTROL: the device catches up while Obsidian is closed: the name opens with the replacing file's ink, and no deletion waits", async () => {
		const v = vault();
		const { own, text } = await bothInked(v);
		land(v, own, text, [NAME]);
		v.files.delete(NAME);
		v.files.set(NAME, v.files.get(OTHER)!);
		v.files.delete(OTHER);
		const s = session(v, { pendingStore: true });
		expect(s.pdfStore.pendingClaims().size, "precondition: no deletion waits at launch").toBe(0);
		const opened = await s.open(NAME);
		expect(opened.id, "the name opened with another ink file than the replacing file's").toBe(own);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id)).toEqual(["ink-1"]);
		expect(s.pdfStore.pendingClaims().size, "a deletion waits after the open").toBe(0);
	});
});
