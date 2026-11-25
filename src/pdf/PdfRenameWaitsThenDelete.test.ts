/**
 * A PDF renamed while no pane shows it, while the ink folder will not list, so its claim move waits; then the PDF is
 * deleted. Before the fix the deletion took only ink whose claims named its new name, and the move's next try read the
 * gone file and was dropped. The ink kept claiming the old name, a name with no file, and a later copy of the same bytes
 * opened on it instead of blank. Wanted: the deleted PDF's ink goes to the trash, as for a PDF deleted with no rename,
 * whether the deletion's retirement runs while the move still waits or after the move was dropped; and a copy of the same
 * bytes opens blank, in the session and after a relaunch. The same for a pane opened on the renamed PDF before the delete,
 * which claimed the new name beside the old.
 *
 * Beside it, the old name's own road: a file made at the old name and deleted while the move waits took the renamed PDF's
 * ink with it. Wanted: the renamed PDF keeps its ink. The controls keep what is right today: another document's ink on
 * the old name, a move with no delete, a copy made in the grace or put back at the old name, a rename onto a name whose
 * deletion waits, and a sync's delete and create at the same path.
 *
 * Harness: the one in PdfInkFolderListingFails.test.ts, copied as it stands (through the plugin and the real stores on an
 * in-memory vault; a relaunch is a new plugin session over the same vault).
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
import { parsePage, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

/** The notice every caller of an identification shows when it fails (PdfClaims, the shipped text). */
const NOT_IDENTIFIED = "Handwriting: could not identify this PDF - ink is disabled for it. Reopening the file retries.";
const INK = ".handwriting";
// Execute the production host registration, including its load options, rather than reconstructing that adapter here.
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

/** The bytes of one document. Another `tag` is another document (another content family). */
function doc(tag: string): Uint8Array {
	return new TextEncoder().encode(`%PDF-1.4\n% ${tag}\n1 0 obj << /Type /Catalog >> endobj\n` + "x".repeat(5000) + "\n%%EOF\n");
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	shown.length = 0;
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

type Vault = ReturnType<typeof vault>;

/**
 * How the host rejects a listing. Desktop: Node's error, with its code. Mobile: the code only when the message says
 * "does not exist", so another message carries none.
 */
type Host = "desktop" | "mobile";

/** One vault: the ink folders, the PDF list with each file's bytes, local storage, and how many live listings fail. */
function vault(host: Host = "desktop") {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	const failing = { left: 0, calls: 0 };
	/** Every listing of a folder that is not there, in order: each one rejected. */
	const absent: string[] = [];
	const inFolder = (folder: string) =>
		[...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/"));
	/** The next listing of the live ink folder, once started, waits here until released (holdListing). */
	let listGate: Gate | undefined;
	adapter.list = async (folder: string) => {
		if (folder === INK && listGate) {
			const gate = listGate;
			listGate = undefined;
			gate.reached();
			await gate.released;
		}
		const files = inFolder(folder);
		// The host reads the folder first: one that is not there rejects at the read.
		if (files.length === 0 && !adapter.dirs.has(folder)) {
			absent.push(folder);
			if (host === "mobile") throw new Error(`could not open folder ${folder}`);
			throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${folder}'`), { code: "ENOENT" });
		}
		if (folder === INK) {
			failing.calls++;
			if (failing.left > 0) {
				failing.left--;
				// Then it stats each entry; one gone since the read rejects the whole listing, with that entry's ENOENT.
				if (host === "mobile") throw new Error(`could not stat ${folder}/pdf-sync.json.tmp`);
				throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${folder}/pdf-sync.json.tmp'`), { code: "ENOENT" });
			}
		}
		return { files, folders: [] };
	};
	// A folder is there while it holds a file, as on disk.
	const exists = adapter.exists.bind(adapter);
	adapter.exists = async (p: string) => (await exists(p)) || inFolder(p).length > 0;
	const files = new Map<string, Uint8Array>();
	const local = new Map<string, unknown>();
	function sidecar(id: string) {
		const bytes = adapter.files.get(`${INK}/${id}.json`);
		return bytes === undefined ? undefined : parsePage(bytes, id).data;
	}
	/** The strokes of every ink file in the trash, one list per file, sorted. */
	function trashInk(): string[][] {
		return [...adapter.files.entries()]
			.filter(([p]) => p.includes("/trash/"))
			.map(([p, bytes]) => parsePage(bytes, p).data.strokes.map((s) => s.id))
			.sort();
	}
	/** The next `n` listings of the live ink folder fail (Infinity: until `listingWorks`). */
	function listingFails(n: number) {
		failing.left = n;
	}
	function listingWorks() {
		failing.left = 0;
	}
	/** The next listing of the live ink folder waits, once it has started, until `release`; it reads the folder then. */
	function holdListing() {
		const { gate, hold } = gated();
		listGate = gate;
		return hold;
	}
	/** Every live ink file's claims, by id, as saved: what an open must leave as it found it when it fails. */
	function claims(): Record<string, string[]> {
		const out: Record<string, string[]> = {};
		for (const [p, bytes] of adapter.files) {
			const n = p.slice(INK.length + 1);
			if (!p.startsWith(INK + "/") || n.includes("/") || !n.endsWith(".json")) continue;
			out[n] = [...(parsePage(bytes, n).data.pdfPaths ?? [])].sort();
		}
		return out;
	}
	/** A PDF deleted while closed, its ink moved to the trash as a retirement moves it. */
	function trashed(path: string, id: string) {
		files.delete(path);
		adapter.files.set(`${INK}/trash/${id}-5000000.json`, adapter.files.get(`${INK}/${id}.json`)!);
		adapter.files.delete(`${INK}/${id}.json`);
	}
	/** An ink file's saved text, as on disk (undefined: no file). */
	function inkText(id: string) {
		return adapter.files.get(`${INK}/${id}.json`);
	}
	return { adapter, files, local, sidecar, trashInk, listingFails, listingWorks, holdListing, failing, absent, claims, trashed, inkText };
}

/** A step held at its start: `reached` is called when it starts, and it goes on once `released` settles. */
type Gate = { reached: () => void; released: Promise<void> };

/** A gate, and its handle for the cell: `started` settles when the step reaches it, `release` lets it go on. */
function gated() {
	let reached!: () => void;
	let release!: () => void;
	const started = new Promise<void>((r) => (reached = r));
	const released = new Promise<void>((r) => (release = r));
	return { gate: { reached, released } as Gate, hold: { started, release } };
}

function pdfFile(path: string) {
	return Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		name: path.split("/").pop(),
		basename: path.replace(/\.[^.]+$/, ""),
	});
}

/** A plugin session (fresh memory) over the vault, with the plugin's own vault events, the layout ready. */
function session(v: Vault) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	const pdfStore = new PdfInkStore();
	const vaultOn = new Map<string, ((...a: unknown[]) => unknown)[]>();
	/** Per path, the next read of that PDF's bytes waits, once started, until released (holdRead). */
	const readGates = new Map<string, Gate>();
	/** Paths whose PDF bytes cannot be read this session: every read throws (readFails). */
	const unreadable = new Set<string>();
	/** Every read of a PDF's bytes this session, by path, in order. */
	const reads: string[] = [];
	const app = {
		vault: {
			adapter: v.adapter,
			// Each with its size, as the vault keeps it for every file.
			getFiles: () => [...v.files.entries()].map(([path, bytes]) => ({ path, extension: "pdf", stat: { size: bytes.length } })),
			readBinary: async (file: { path: string }) => {
				reads.push(file.path);
				const gate = readGates.get(file.path);
				if (gate) {
					readGates.delete(file.path);
					gate.reached();
					await gate.released;
				}
				if (unreadable.has(file.path)) throw new Error(`could not read ${file.path}`);
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
		workspace: { layoutReady: true, onLayoutReady: (f: () => void) => f() },
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
	// The rename handler starts the no-pane claim move in the background; kept here so a rename can be waited for.
	const moves: Promise<void>[] = [];
	const moveClaim = HandwritingPlugin.prototype.movePdfClaimOnRename;
	plugin.movePdfClaimOnRename = (file: TFile, oldPath: string) => {
		const move = moveClaim.call(plugin, file, oldPath);
		moves.push(move);
		return move;
	};
	// The host's notice for an ink file that cannot be read yet goes through blockNotice; a plain Notice stands in.
	installPdfHost.call(plugin, Notice, (m: string) => new Notice(m));
	plugin.onloadVaultEvents();
	// The deletions still in their grace are saved where the next launch finds them, as at onload.
	plugin.attachPdfPendingDeletes();
	/**
	 * Open `path` in a new pane. An identification that fails is caught as each of its callers in the plugin catches
	 * it, with the shipped notice (PdfClaims: the pane switch, the leaf change, a change on disk).
	 */
	async function open(path: string) {
		expect(v.files.has(path), `precondition: ${path} exists in the vault`).toBe(true);
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, idle: true };
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		let failed = false;
		let error: unknown;
		await plugin.resolvePdfId({ view: { file: { path } } }, root, controller).catch((e: unknown) => {
			failed = true;
			error = e;
			new Notice(NOT_IDENTIFIED);
		});
		await store.flush();
		return { root, id: plugin.pdfIds.get(root) as string | undefined, failed, error };
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
	/** The PDF list loses the file, then the plugin's real delete handler runs. */
	async function deleteFile(path: string) {
		v.files.delete(path);
		await plugin.onFileDeleted(pdfFile(path));
	}
	/** The PDF list gains the file with these bytes, then every create handler the plugin registered runs. */
	async function createFile(path: string, bytes: Uint8Array) {
		v.files.set(path, bytes);
		for (const handler of vaultOn.get("create") ?? []) await handler(pdfFile(path));
	}
	/** The file's bytes change in place (another app saved it, or sync brought a new version), then every modify handler runs. */
	async function changeFile(path: string, bytes: Uint8Array) {
		expect(v.files.has(path), `precondition: ${path} exists before the change`).toBe(true);
		v.files.set(path, bytes);
		for (const handler of vaultOn.get("modify") ?? []) await handler(pdfFile(path));
	}
	/** The vault moves the file and its bytes, then every rename handler the plugin registered runs, and any claim move it started. */
	async function renameFile(from: string, to: string) {
		await renameStarting(from, to);
		await Promise.all(moves.splice(0));
		await store.flush();
	}
	/** The same, the claim move it starts left running (taken back by `movesSettled`). */
	async function renameStarting(from: string, to: string) {
		const bytes = v.files.get(from);
		expect(bytes, `precondition: ${from} exists before the rename`).toBeDefined();
		v.files.delete(from);
		v.files.set(to, bytes!);
		for (const handler of vaultOn.get("rename") ?? []) await handler(pdfFile(to), from);
	}
	/** Every claim move a rename started, settled, failed or not. */
	async function movesSettled() {
		await Promise.allSettled(moves.splice(0));
		await store.flush();
	}
	/** The next read of the PDF at `path` waits, once started, until `release`; it reads the file as it is then. */
	function holdRead(path: string) {
		const { gate, hold } = gated();
		readGates.set(path, gate);
		return hold;
	}
	/** Every later read of the PDF at `path` throws, as a file that cannot be read. */
	function readFails(path: string) {
		unreadable.add(path);
	}
	/** Open `path`, read the ink it shows, close it. */
	async function inkAt(path: string): Promise<{ id: string | undefined; strokes: string[]; failed: boolean; error: unknown }> {
		const o = await open(path);
		const strokes = o.id === undefined ? [] : pdfStore.strokes(o.id).map((x) => x.id);
		close(o.root);
		return { id: o.id, strokes, failed: o.failed, error: o.error };
	}
	return { app, store, pdfStore, plugin, open, close, draw, deleteFile, createFile, changeFile, renameFile, renameStarting, movesSettled, holdRead, readFails, reads, inkAt };
}

type Session = ReturnType<typeof session>;

/** Open `path` in `s`, draw one stroke, save, close. Returns the ink id. */
async function inkOn(s: Session, path: string, strokeId: string, x = 10): Promise<string> {
	const o = await s.open(path);
	expect(o.id, `precondition: ${path} opened on an ink id`).toBeDefined();
	s.draw(o.id!, stroke(x, strokeId));
	await s.store.flush();
	s.close(o.root);
	return o.id!;
}



async function retirementRuns(s: Session, ms = 10_001) {
	const runs = vi.spyOn(PdfInkStore.prototype as never as { retireDeletedPath(...a: unknown[]): Promise<void> }, "retireDeletedPath");
	runs.mockClear();
	await vi.advanceTimersByTimeAsync(ms);
	await vi.waitFor(() => expect(runs, "precondition: a retirement ran").toHaveBeenCalled());
	await Promise.allSettled(runs.mock.results.map((r) => r.value as Promise<void>));
	await s.store.flush();
}

/** The ink id's live file and every stroke list in the trash. */
function inkEnd(v: Vault, inked: string) {
	return { live: v.adapter.files.has(`${INK}/${inked}.json`), trash: v.trashInk() };
}

/** How many claim moves have been dropped on an error so far, as the plugin logs each one (runDetached). */
function movesDropped() {
	const errors = vi.spyOn(console, "error");
	return () =>
		errors.mock.calls.filter(([m]) => typeof m === "string" && /^\[handwriting\] move (a PDF ink claim on rename|the ink claim of )/.test(m)).length;
}

/**
 * In a new session with the listing failing, the inked PDF at Notes.pdf renamed to Old.pdf with no pane. The move's first
 * try fails on the listing and waits 10 s for its next.
 */
async function renameWaits(v: Vault, inked: string) {
	const s = session(v);
	const dropped = movesDropped();
	vi.useFakeTimers();
	v.listingFails(Infinity);
	const calls = v.failing.calls;
	await s.renameFile("Notes.pdf", "Old.pdf");
	expect(v.failing.calls, "precondition: the rename's claim move listed the ink folder").toBeGreaterThan(calls);
	expect(dropped(), "precondition: the rename's claim move was not dropped").toBe(0);
	expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: the move waits, the ink still claims the old name").toEqual(["Notes.pdf"]);
	return { s, dropped };
}

/** Notes.pdf inked in one session, then renamed as renameWaits does. */
async function renamedWhileUnlisted(v: Vault) {
	v.files.set("Notes.pdf", doc("notes"));
	const inked = await inkOn(session(v), "Notes.pdf", "ink-0");
	return { inked, ...(await renameWaits(v, inked)) };
}

/** The move's try at 10 s: it reads the head, fails on the listing again, and waits 20 s more (due at 30 s). */
async function retryFailsOnListing(v: Vault, s: Session, inked: string, dropped: () => number) {
	const calls = v.failing.calls;
	await vi.advanceTimersByTimeAsync(10_001);
	// The try runs off the timer queue and hashes the head with the real digest: it can still be running here.
	await vi.waitFor(() => expect(v.failing.calls, "precondition: the move's try at 10 s listed the ink folder").toBeGreaterThan(calls));
	// From its listing on, its failure and the timer for its next try are promise callbacks: the advance lets them all run first.
	await vi.advanceTimersByTimeAsync(0);
	await s.store.flush();
	expect(dropped(), "precondition: the move's try at 10 s was not dropped").toBe(0);
	expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: the move still waits").toEqual(["Notes.pdf"]);
}

/** Every timer due in the next minute run, the store flushed, and the real clock back. */
async function minuteLater(s: Session) {
	await vi.advanceTimersByTimeAsync(60_000);
	await s.store.flush();
	vi.useRealTimers();
}

/** What `path` opens on, here and after a relaunch. */
async function opensOn(v: Vault, s: Session, path: string) {
	const here = await s.inkAt(path);
	const next = await session(v).inkAt(path);
	return { here: { failed: here.failed, strokes: here.strokes }, relaunch: { failed: next.failed, strokes: next.strokes } };
}

/**
 * After the deletion: the ink is in the trash, strokes whole, with no live file left, and a copy of the same bytes opens
 * blank, here and after a relaunch. Every part is read before the one assert, so a red run shows each.
 */
async function deletedInkGone(v: Vault, s: Session, inked: string, when: string) {
	const end = inkEnd(v, inked);
	await s.createFile("Copy.pdf", doc("notes"));
	const copy = await opensOn(v, s, "Copy.pdf");
	expect(
		{ ...end, copy },
		`${when}: the deleted PDF's ink is not in the trash whole with no live file left, or a copy of the same bytes did not open blank, here or after a relaunch`
	).toEqual({ live: false, trash: [["ink-0"]], copy: { here: { failed: false, strokes: [] }, relaunch: { failed: false, strokes: [] } } });
}

describe("a PDF renamed while its claim move waits on the ink folder's listing, then deleted", () => {
	it("the move dropped before the retirement runs: the ink goes to the trash, and a copy of the same bytes opens blank, also after a relaunch", async () => {
		const v = vault();
		const { inked, s, dropped } = await renamedWhileUnlisted(v);
		// The delete at 5 s: its grace ends at 15 s, after the move's next try at 10 s.
		await vi.advanceTimersByTimeAsync(5_000);
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		await vi.advanceTimersByTimeAsync(5_001);
		await vi.waitFor(() => expect(dropped(), "precondition: the move's try at 10 s read the gone file and was dropped").toBe(1));
		expect(s.pdfStore.pendingClaims().has("Old.pdf"), "precondition: the deletion still waits in its grace").toBe(true);
		await retirementRuns(s, 5_000);
		expect(s.pdfStore.pendingClaims().has("Old.pdf"), "precondition: the deletion ended").toBe(false);
		await minuteLater(s);
		await deletedInkGone(v, s, inked, "move dropped first");
	});

	it("the retirement runs while the move still waits: the ink goes to the trash, and a copy of the same bytes opens blank, also after a relaunch", async () => {
		const v = vault();
		const { inked, s, dropped } = await renamedWhileUnlisted(v);
		await retryFailsOnListing(v, s, inked, dropped);
		const readsAt = s.reads.length;
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		// The grace ends at about 20 s; the move's next try is due at 30 s.
		await retirementRuns(s);
		expect(s.pdfStore.pendingClaims().has("Old.pdf"), "precondition: the deletion ended").toBe(false);
		expect(s.reads.slice(readsAt), "precondition: the move's next try had not run when the retirement ended").not.toContain("Old.pdf");
		expect(dropped(), "precondition: the move was not dropped before the retirement ended").toBe(0);
		expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: the move had not landed when the retirement ended").not.toContain("Old.pdf");
		await minuteLater(s);
		await deletedInkGone(v, s, inked, "retirement first");
	});

	it("CONTROL: the move's try past its head read when the delete lands, the listing working by then: the move lands, the ink goes to the trash once, and a copy of the same bytes opens blank, also after a relaunch", async () => {
		const v = vault();
		const { inked, s, dropped } = await renamedWhileUnlisted(v);
		const listing = v.holdListing();
		await vi.advanceTimersByTimeAsync(10_001);
		await listing.started;
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		listing.release();
		await vi.waitFor(async () => {
			await s.store.flush();
			expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: the move landed on the new name").toEqual(["Old.pdf"]);
		});
		expect(dropped(), "precondition: the move was not dropped").toBe(0);
		await retirementRuns(s);
		expect(s.pdfStore.pendingClaims().has("Old.pdf"), "precondition: the deletion ended").toBe(false);
		await minuteLater(s);
		await deletedInkGone(v, s, inked, "move landed first");
	});

	// A named limit: the deletion acts only on ink of the family the move read, and here no read had ended.
	it("LIMIT, as before: the delete lands while the move's first read of the PDF's head is still running: no content is known, so the ink stays on the old name, out of the trash, and a copy of the same bytes opens on it, also after a relaunch", async () => {
		const v = vault();
		v.files.set("Notes.pdf", doc("notes"));
		const inked = await inkOn(session(v), "Notes.pdf", "ink-0");
		const s = session(v);
		const dropped = movesDropped();
		vi.useFakeTimers();
		const head = s.holdRead("Old.pdf");
		await s.renameStarting("Notes.pdf", "Old.pdf");
		await head.started;
		await s.deleteFile("Old.pdf");
		head.release();
		await s.movesSettled();
		expect(dropped(), "precondition: the move read the gone file and was dropped").toBe(1);
		await retirementRuns(s);
		expect(s.pdfStore.pendingClaims().has("Old.pdf"), "precondition: the deletion ended").toBe(false);
		await minuteLater(s);
		const end = inkEnd(v, inked);
		const claimed = v.sidecar(inked)?.pdfPaths ?? [];
		await s.createFile("Copy.pdf", doc("notes"));
		const copy = await opensOn(v, s, "Copy.pdf");
		expect({ ...end, claimed, copy }, "delete inside the head read: the end is not the one before the fix").toEqual({
			live: true,
			trash: [],
			claimed: ["Notes.pdf"],
			copy: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
		});
	});

	// The same limit, one step on: a deletion that names no old name (the copy was never renamed) moves only its own
	// path's claim to the file that takes the ink in its grace. The old name the ink kept above stays claimed, as before.
	it("LIMIT, as before: the copy that took the ink left on the old name is deleted, and a same-bytes file made in that grace takes the ink, which still claims the old name beside it", async () => {
		const v = vault();
		v.files.set("Notes.pdf", doc("notes"));
		const inked = await inkOn(session(v), "Notes.pdf", "ink-0");
		const s = session(v);
		const dropped = movesDropped();
		vi.useFakeTimers();
		const head = s.holdRead("Old.pdf");
		await s.renameStarting("Notes.pdf", "Old.pdf");
		await head.started;
		await s.deleteFile("Old.pdf");
		head.release();
		await s.movesSettled();
		expect(dropped(), "precondition: the move read the gone file and was dropped").toBe(1);
		await retirementRuns(s);
		await minuteLater(s);
		await s.createFile("Copy.pdf", doc("notes"));
		const copy = await s.inkAt("Copy.pdf");
		await s.store.flush();
		expect(
			{ strokes: copy.strokes, claimed: [...(v.sidecar(inked)?.pdfPaths ?? [])].sort() },
			"precondition: the copy took the ink, which claims both names"
		).toEqual({ strokes: ["ink-0"], claimed: ["Copy.pdf", "Notes.pdf"] });
		await s.deleteFile("Copy.pdf");
		await s.createFile("New.pdf", doc("notes"));
		const inGrace = await s.inkAt("New.pdf");
		const waitsAfterOpen = s.pdfStore.pendingClaims().has("Copy.pdf");
		await s.store.flush();
		const claimed = [...(v.sidecar(inked)?.pdfPaths ?? [])].sort();
		expect(
			{ inGrace: { failed: inGrace.failed, strokes: inGrace.strokes }, waitsAfterOpen, claimed },
			"the file made in the copy's grace did not take the ink, or the copy's deletion still waits, or the ink's claim on the old name changed"
		).toEqual({ inGrace: { failed: false, strokes: ["ink-0"] }, waitsAfterOpen: false, claimed: ["New.pdf", "Notes.pdf"] });
	});
});

describe("a PDF renamed while its claim move waits, opened and closed, then deleted", () => {
	for (const listed of [false, true]) {
		it(`opened ${listed ? "once the listing works" : "while the listing still fails"}: the ink goes to the trash, and a copy of the same bytes opens blank, also after a relaunch`, async () => {
			const v = vault();
			const { inked, s } = await renamedWhileUnlisted(v);
			if (listed) v.listingWorks();
			const there = await s.inkAt("Old.pdf");
			expect({ failed: there.failed, strokes: there.strokes }, "precondition: the renamed PDF opened on its ink").toEqual({ failed: false, strokes: ["ink-0"] });
			await s.store.flush();
			expect([...(v.sidecar(inked)?.pdfPaths ?? [])].sort(), "precondition: the open claimed the new name beside the old").toEqual(["Notes.pdf", "Old.pdf"]);
			await s.deleteFile("Old.pdf");
			v.listingWorks();
			await retirementRuns(s);
			expect(s.pdfStore.pendingClaims().has("Old.pdf"), "precondition: the deletion ended").toBe(false);
			await minuteLater(s);
			await deletedInkGone(v, s, inked, "opened before the delete");
		});
	}
});

describe("a file made at a renamed PDF's old name, then deleted, while the rename's claim move waits", () => {
	it("its grace ends before the move lands: the renamed PDF opens on its ink, which is neither trashed nor written", async () => {
		const v = vault();
		const { inked, s, dropped } = await renamedWhileUnlisted(v);
		await retryFailsOnListing(v, s, inked, dropped);
		v.listingWorks();
		await s.createFile("Notes.pdf", doc("other"));
		await s.deleteFile("Notes.pdf");
		const text = v.inkText(inked);
		// The grace ends at about 20 s; the move's next try is due at 30 s.
		await retirementRuns(s);
		expect(s.pdfStore.pendingClaims().has("Notes.pdf"), "precondition: the deletion ended").toBe(false);
		expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: the move had not landed when the retirement ended").not.toContain("Old.pdf");
		const atRetirement = { ...inkEnd(v, inked), written: v.inkText(inked) !== text };
		await minuteLater(s);
		const renamed = await opensOn(v, s, "Old.pdf");
		expect(
			{ atRetirement, renamed },
			"the deletion at the old name trashed or wrote the renamed PDF's ink, or the renamed PDF did not open on it, here or after a relaunch"
		).toEqual({
			atRetirement: { live: true, trash: [], written: false },
			renamed: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
		});
	});

	it("CONTROL: ink of the file made at the old name goes to the trash, as before", async () => {
		const v = vault();
		const { inked, s, dropped } = await renamedWhileUnlisted(v);
		await retryFailsOnListing(v, s, inked, dropped);
		v.listingWorks();
		await s.createFile("Notes.pdf", doc("other"));
		const made = await inkOn(s, "Notes.pdf", "other-0");
		expect(made, "precondition: the file made at the old name has its own ink").not.toBe(inked);
		await s.deleteFile("Notes.pdf");
		await retirementRuns(s);
		expect(s.pdfStore.pendingClaims().has("Notes.pdf"), "precondition: the deletion ended").toBe(false);
		await minuteLater(s);
		// Its open took the waiting ink on the old name as an older version's and carried that ink's strokes into its own
		// (the changed-on-disk road, as today), so the made ink is found in the trash by its own stroke.
		expect(
			{ live: v.adapter.files.has(`${INK}/${made}.json`), inTrash: v.trashInk().some((t) => t.includes("other-0")) },
			"the ink of the file made at the old name and deleted is not in the trash"
		).toEqual({ live: false, inTrash: true });
	});

	it("CONTROL: with no claim move waiting, a deletion takes every ink on its name to the trash, a same-bytes file standing elsewhere", async () => {
		const v = vault();
		v.files.set("Notes.pdf", doc("before"));
		const before = await inkOn(session(v), "Notes.pdf", "before-0");
		// The file at the name changed while Obsidian was closed; the earlier ink still claims the name.
		v.files.set("Notes.pdf", doc("notes"));
		const inked = await inkOn(session(v), "Notes.pdf", "ink-0");
		v.files.set("Copy.pdf", doc("notes"));
		expect([before, inked].map((id) => v.sidecar(id)?.pdfPaths ?? []), "precondition: two inks claim the name").toEqual([["Notes.pdf"], ["Notes.pdf"]]);
		// The new version's open carried the earlier ink's strokes into its own (the changed-on-disk road, as today): each
		// ink is wanted in the trash as it was before the deletion.
		const had = [before, inked].map((id) => (v.sidecar(id)?.strokes ?? []).map((x) => x.id)).sort();
		expect(had.flat(), "precondition: each ink holds its own stroke").toEqual(expect.arrayContaining(["before-0", "ink-0"]));
		const s = session(v);
		vi.useFakeTimers();
		await s.deleteFile("Notes.pdf");
		await retirementRuns(s);
		expect(s.pdfStore.pendingClaims().has("Notes.pdf"), "precondition: the deletion ended").toBe(false);
		await minuteLater(s);
		const end = { before: inkEnd(v, before).live, inked: inkEnd(v, inked).live, trash: v.trashInk() };
		const copy = await opensOn(v, s, "Copy.pdf");
		expect({ ...end, copy }, "an ink on the deleted name is outside the trash, or the same-bytes file opened on it").toEqual({
			before: false,
			inked: false,
			trash: had,
			copy: { here: { failed: false, strokes: [] }, relaunch: { failed: false, strokes: [] } },
		});
	});
});

describe("CONTROL: a PDF renamed while its claim move waits, the rest as before", () => {
	it("another document's ink that claims the old name stays live and is not written", async () => {
		const v = vault();
		v.files.set("Notes.pdf", doc("before"));
		const other = await inkOn(session(v), "Notes.pdf", "other-0");
		// The file at the name changed while Obsidian was closed; the earlier ink still claims the name.
		v.files.set("Notes.pdf", doc("notes"));
		const inked = await inkOn(session(v), "Notes.pdf", "ink-0");
		expect(other, "precondition: two inks").not.toBe(inked);
		const { s } = await renameWaits(v, inked);
		const text = v.inkText(other);
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		await retirementRuns(s);
		await minuteLater(s);
		expect(
			{ live: v.adapter.files.has(`${INK}/${other}.json`), written: v.inkText(other) !== text, claims: v.sidecar(other)?.pdfPaths ?? [] },
			"the other document's ink on the old name was trashed, written, or lost its claim"
		).toEqual({ live: true, written: false, claims: ["Notes.pdf"] });
	});

	it("a waiting move with no delete lands once the listing works: the ink claims the new name alone, and the PDF opens on it", async () => {
		const v = vault();
		const { inked, s } = await renamedWhileUnlisted(v);
		v.listingWorks();
		await vi.advanceTimersByTimeAsync(60_000);
		await vi.waitFor(async () => {
			await s.store.flush();
			expect(v.sidecar(inked)?.pdfPaths ?? [], "the move did not land").toContain("Old.pdf");
		});
		vi.useRealTimers();
		const claims = v.sidecar(inked)?.pdfPaths ?? [];
		const renamed = await opensOn(v, s, "Old.pdf");
		expect({ claims, renamed, trash: v.trashInk() }, "the move did not land as before").toEqual({
			claims: ["Old.pdf"],
			renamed: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
			trash: [],
		});
	});

	it("a same-bytes file made in the deletion's grace takes the ink, here and after a relaunch", async () => {
		const v = vault();
		const { inked, s } = await renamedWhileUnlisted(v);
		await s.deleteFile("Old.pdf");
		await s.createFile("Copy.pdf", doc("notes"));
		v.listingWorks();
		await retirementRuns(s);
		await minuteLater(s);
		const copy = await opensOn(v, s, "Copy.pdf");
		expect({ copy, trash: v.trashInk() }, "the same-bytes file made in the grace did not take the ink").toEqual({
			copy: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
			trash: [],
		});
		expect(v.sidecar(inked)?.pdfPaths ?? [], "the ink does not claim the file made in the grace").toContain("Copy.pdf");
	});

	it("renamed onto a name whose deletion waits: that deletion's ink goes to the trash, and the renamed PDF keeps its own", async () => {
		const v = vault();
		v.files.set("Old.pdf", doc("x"));
		const x = await inkOn(session(v), "Old.pdf", "x-0");
		v.files.set("Notes.pdf", doc("notes"));
		const inked = await inkOn(session(v), "Notes.pdf", "ink-0");
		const s = session(v);
		const dropped = movesDropped();
		vi.useFakeTimers();
		await s.deleteFile("Old.pdf");
		await vi.advanceTimersByTimeAsync(1_000);
		v.listingFails(Infinity);
		await s.renameFile("Notes.pdf", "Old.pdf");
		expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: the move waits").toEqual(["Notes.pdf"]);
		v.listingWorks();
		// The grace ends at 10 s; the move's next try is due at 11 s.
		await retirementRuns(s, 9_001);
		expect(s.pdfStore.pendingClaims().has("Old.pdf"), "precondition: the deletion ended").toBe(false);
		expect(dropped(), "precondition: the move was not dropped").toBe(0);
		const atRetirement = { x: inkEnd(v, x).live, inked: inkEnd(v, inked).live, trash: v.trashInk() };
		await vi.advanceTimersByTimeAsync(60_000);
		await vi.waitFor(async () => {
			await s.store.flush();
			expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: the move landed").toEqual(["Old.pdf"]);
		});
		vi.useRealTimers();
		const renamed = await opensOn(v, s, "Old.pdf");
		expect({ atRetirement, renamed }, "the renamed PDF lost its ink to the deletion it was renamed onto, or that deletion's ink stayed").toEqual({
			atRetirement: { x: false, inked: true, trash: [["x-0"]] },
			renamed: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
		});
	});

	it("a same-bytes file put back at the old name and opened keeps the ink after the renamed PDF is deleted", async () => {
		const v = vault();
		const { inked, s } = await renamedWhileUnlisted(v);
		await s.createFile("Notes.pdf", doc("notes"));
		const back = await s.inkAt("Notes.pdf");
		expect({ id: back.id, strokes: back.strokes }, "precondition: the file put back opened on the ink").toEqual({ id: inked, strokes: ["ink-0"] });
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		await retirementRuns(s);
		await minuteLater(s);
		const end = inkEnd(v, inked);
		const put = await opensOn(v, s, "Notes.pdf");
		expect({ ...end, put }, "the file put back at the old name lost the ink").toEqual({
			live: true,
			trash: [],
			put: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
		});
	});

	// The file put back is a grace old at the delete, so it counts as standing there and not as a new name the ink could
	// follow: only the check that no file stands at the old name keeps the deletion off the ink's claim on it.
	it("a same-bytes file put back at the old name and opened, a grace old when the renamed PDF is deleted, keeps the ink", async () => {
		const v = vault();
		const { inked, s, dropped } = await renamedWhileUnlisted(v);
		await s.createFile("Notes.pdf", doc("notes"));
		const back = await s.inkAt("Notes.pdf");
		expect({ id: back.id, strokes: back.strokes }, "precondition: the file put back opened on the ink").toEqual({ id: inked, strokes: ["ink-0"] });
		await retryFailsOnListing(v, s, inked, dropped);
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		// The grace ends at about 20 s; the move's next try is due at 30 s.
		await retirementRuns(s);
		expect(s.pdfStore.pendingClaims().has("Old.pdf"), "precondition: the deletion ended").toBe(false);
		await minuteLater(s);
		const end = inkEnd(v, inked);
		const put = await opensOn(v, s, "Notes.pdf");
		expect({ ...end, put }, "the file put back at the old name a grace before the delete lost the ink").toEqual({
			live: true,
			trash: [],
			put: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
		});
	});

	it("a copy that took the ink before the rename keeps it after the renamed PDF is deleted", async () => {
		const v = vault();
		v.files.set("Notes.pdf", doc("notes"));
		const inked = await inkOn(session(v), "Notes.pdf", "ink-0");
		// Another launch, Notes.pdf not here yet and a copy of its bytes is: the copy takes the ink.
		const notes = v.files.get("Notes.pdf")!;
		v.files.delete("Notes.pdf");
		v.files.set("Copy.pdf", doc("notes"));
		expect((await session(v).inkAt("Copy.pdf")).strokes, "precondition: the copy took the ink").toEqual(["ink-0"]);
		v.files.set("Notes.pdf", notes);
		expect([...(v.sidecar(inked)?.pdfPaths ?? [])].sort(), "precondition: the ink claims both names").toEqual(["Copy.pdf", "Notes.pdf"]);
		const s = session(v);
		vi.useFakeTimers();
		v.listingFails(Infinity);
		await s.renameFile("Notes.pdf", "Old.pdf");
		expect([...(v.sidecar(inked)?.pdfPaths ?? [])].sort(), "precondition: the move waits").toEqual(["Copy.pdf", "Notes.pdf"]);
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		await retirementRuns(s);
		await minuteLater(s);
		const end = inkEnd(v, inked);
		const copy = await opensOn(v, s, "Copy.pdf");
		expect({ ...end, copy }, "the copy lost the ink").toEqual({
			live: true,
			trash: [],
			copy: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
		});
	});

	it("deleted, then made again at the same path in the grace (a sync's delete and create): the move lands and the ink follows", async () => {
		const v = vault();
		const { inked, s } = await renamedWhileUnlisted(v);
		await s.deleteFile("Old.pdf");
		await vi.advanceTimersByTimeAsync(1_000);
		await s.createFile("Old.pdf", doc("notes"));
		v.listingWorks();
		await vi.advanceTimersByTimeAsync(60_000);
		await vi.waitFor(async () => {
			await s.store.flush();
			expect(v.sidecar(inked)?.pdfPaths ?? [], "the move did not land").toContain("Old.pdf");
		});
		vi.useRealTimers();
		const claims = v.sidecar(inked)?.pdfPaths ?? [];
		const back = await opensOn(v, s, "Old.pdf");
		expect({ claims, back, trash: v.trashInk() }, "the ink did not follow the file made again at the path").toEqual({
			claims: ["Old.pdf"],
			back: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
			trash: [],
		});
	});
});

/** The notices that said ink was carried over to a new version, so far. */
const carriedSaid = () => shown.filter((m) => m.includes("carried over"));

describe("another document saved at a renamed PDF's old name and opened, while the rename's claim move waits", () => {
	it("it opens blank with no carried notice, the renamed PDF's ink file is not written, and once the move lands the renamed PDF opens on its ink, also after a relaunch", async () => {
		const v = vault();
		const { inked, s } = await renamedWhileUnlisted(v);
		v.listingWorks();
		const text = v.inkText(inked);
		// Before the move's next try at 10 s.
		await s.createFile("Notes.pdf", doc("other"));
		const there = await s.inkAt("Notes.pdf");
		const said = carriedSaid();
		const written = v.inkText(inked) !== text;
		await vi.advanceTimersByTimeAsync(60_000);
		// The move's try at 10 s runs off the timer queue and hashes the head with the real digest: it can still be
		// running here. Waited for, not asserted: a move that never lands shows in the one assert below.
		await vi
			.waitFor(async () => {
				await s.store.flush();
				expect(v.sidecar(inked)?.pdfPaths ?? []).toContain("Old.pdf");
			})
			.catch(() => undefined);
		vi.useRealTimers();
		const claims = v.sidecar(inked)?.pdfPaths ?? [];
		const renamed = await opensOn(v, s, "Old.pdf");
		expect(
			{ there: { failed: there.failed, strokes: there.strokes }, said, written, claims, renamed },
			"the document at the old name got the renamed PDF's ink, or that ink was written, or the move did not land, or the renamed PDF did not open on it"
		).toEqual({
			there: { failed: false, strokes: [] },
			said: [],
			written: false,
			claims: ["Old.pdf"],
			renamed: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
		});
	});

	// A named limit: only ink of the family the move read is kept out of the carry, and here no read had ended.
	it("LIMIT, as before: opened while the move's first read of the renamed PDF's head is still running: no content is known, so the renamed PDF's ink is carried in, and the move still lands", async () => {
		const v = vault();
		v.files.set("Notes.pdf", doc("notes"));
		await inkOn(session(v), "Notes.pdf", "ink-0");
		const s = session(v);
		const head = s.holdRead("Old.pdf");
		await s.renameStarting("Notes.pdf", "Old.pdf");
		await head.started;
		await s.createFile("Notes.pdf", doc("other"));
		const there = await s.inkAt("Notes.pdf");
		const said = carriedSaid().length;
		head.release();
		await s.movesSettled();
		const renamed = await opensOn(v, s, "Old.pdf");
		expect({ there: { failed: there.failed, strokes: there.strokes }, said, renamed }, "the end is not the one before the fix").toEqual({
			there: { failed: false, strokes: ["ink-0"] },
			said: 1,
			renamed: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
		});
	});

	it("CONTROL: with no claim move waiting, a PDF changed in place opens on its old ink, carried, with the notice, a same-bytes copy of the old version standing elsewhere", async () => {
		const v = vault();
		v.files.set("Notes.pdf", doc("before"));
		await inkOn(session(v), "Notes.pdf", "before-0");
		v.files.set("Copy.pdf", doc("before"));
		// Changed while Obsidian was closed.
		v.files.set("Notes.pdf", doc("notes"));
		const s = session(v);
		const there = await s.inkAt("Notes.pdf");
		expect({ there: { failed: there.failed, strokes: there.strokes }, said: carriedSaid().length }, "the changed PDF did not get its old ink").toEqual({
			there: { failed: false, strokes: ["before-0"] },
			said: 1,
		});
	});
});

/**
 * The move's try at 10 s, run with the listing working, waited for until the ink claims the new name alone. Waited for,
 * not asserted: a try that moves nothing, or moves it beside another name, shows in the cell's one assert. Then every
 * timer due in the next minute, and the real clock back.
 */
async function moveTried(v: Vault, s: Session, inked: string) {
	const calls = v.failing.calls;
	await vi.advanceTimersByTimeAsync(10_001);
	// The try runs off the timer queue and hashes the head with the real digest: it can still be running here.
	await vi.waitFor(() => expect(v.failing.calls, "precondition: the move's try at 10 s listed the ink folder").toBeGreaterThan(calls));
	await vi
		.waitFor(async () => {
			await s.store.flush();
			expect([...(v.sidecar(inked)?.pdfPaths ?? [])].sort()).toEqual(["Old.pdf"]);
		})
		.catch(() => undefined);
	await minuteLater(s);
}

/** The renamed PDF's bytes after the change: a new version of the same document. */
const newVersion = () => doc("notes, a new version");

describe("a PDF renamed while its claim move waits, then changed in place before the move lands", () => {
	it("the move's try runs before the open: the new version opens with the old ink carried, with the notice, also after a relaunch, and the ink claims the new name", async () => {
		const v = vault();
		const { inked, s } = await renamedWhileUnlisted(v);
		await s.changeFile("Old.pdf", newVersion());
		v.listingWorks();
		await moveTried(v, s, inked);
		const claims = v.sidecar(inked)?.pdfPaths ?? [];
		const changed = await opensOn(v, s, "Old.pdf");
		const said = carriedSaid().length;
		expect({ changed, said, claims }, "the new version did not open with the old ink carried, here or after a relaunch, or the ink did not move to the new name").toEqual({
			changed: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
			said: 1,
			claims: ["Old.pdf"],
		});
	});

	it("opened before the move's try: the new version opens with the old ink carried, with the notice, and once the move lands the ink claims the new name and the new version opens on the ink after a relaunch", async () => {
		const v = vault();
		const { inked, s } = await renamedWhileUnlisted(v);
		await s.changeFile("Old.pdf", newVersion());
		v.listingWorks();
		// Before the move's next try at 10 s.
		const there = await s.inkAt("Old.pdf");
		const said = carriedSaid().length;
		await moveTried(v, s, inked);
		const claims = v.sidecar(inked)?.pdfPaths ?? [];
		const next = await session(v).inkAt("Old.pdf");
		expect(
			{ there: { failed: there.failed, strokes: there.strokes }, said, claims, relaunch: { failed: next.failed, strokes: next.strokes } },
			"the new version opened before the move's try did not get the old ink carried, or the ink did not move to the new name, or a relaunch opened without it"
		).toEqual({
			there: { failed: false, strokes: ["ink-0"] },
			said: 1,
			claims: ["Old.pdf"],
			relaunch: { failed: false, strokes: ["ink-0"] },
		});
	});
});

describe("a copy of a renamed PDF's bytes opened while the rename's claim move waits, the listing working", () => {
	it("the copy opens blank, and once the move lands the ink claims the renamed PDF alone, which opens on it, also after a relaunch", async () => {
		const v = vault();
		const { inked, s } = await renamedWhileUnlisted(v);
		v.listingWorks();
		await s.createFile("Copy.pdf", doc("notes"));
		// Before the move's next try at 10 s.
		const there = await s.inkAt("Copy.pdf");
		await moveTried(v, s, inked);
		const claims = [...(v.sidecar(inked)?.pdfPaths ?? [])].sort();
		const renamed = await opensOn(v, s, "Old.pdf");
		const copy = await opensOn(v, s, "Copy.pdf");
		expect(
			{ there: { failed: there.failed, strokes: there.strokes }, claims, renamed, copy },
			"the copy took the renamed PDF's ink, or the ink claims more than the renamed PDF, or one of the two opened on the wrong ink"
		).toEqual({
			there: { failed: false, strokes: [] },
			claims: ["Old.pdf"],
			renamed: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
			copy: { here: { failed: false, strokes: [] }, relaunch: { failed: false, strokes: [] } },
		});
	});

	it("CONTROL: the renamed PDF's own open, listed, before the move's try, opens on its ink, and once the move lands the ink claims it alone", async () => {
		const v = vault();
		const { inked, s } = await renamedWhileUnlisted(v);
		v.listingWorks();
		const there = await s.inkAt("Old.pdf");
		await moveTried(v, s, inked);
		const claims = [...(v.sidecar(inked)?.pdfPaths ?? [])].sort();
		const renamed = await opensOn(v, s, "Old.pdf");
		expect({ there: { failed: there.failed, strokes: there.strokes }, claims, renamed }, "the renamed PDF's own open did not get its ink").toEqual({
			there: { failed: false, strokes: ["ink-0"] },
			claims: ["Old.pdf"],
			renamed: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
		});
	});

	it("CONTROL: with no claim move waiting, a copy of the bytes adopts ink whose every claimed name is gone, as before", async () => {
		const v = vault();
		v.files.set("Notes.pdf", doc("notes"));
		const inked = await inkOn(session(v), "Notes.pdf", "ink-0");
		// Gone while Obsidian was closed; a copy of its bytes is here.
		v.files.delete("Notes.pdf");
		v.files.set("Copy.pdf", doc("notes"));
		const copy = await opensOn(v, session(v), "Copy.pdf");
		const claims = [...(v.sidecar(inked)?.pdfPaths ?? [])].sort();
		expect({ copy, claims }, "the copy did not adopt the ink whose names are all gone").toEqual({
			copy: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
			claims: ["Copy.pdf", "Notes.pdf"],
		});
	});
});

describe("an older version's ink and a renamed PDF's waiting ink both claim a name, and a new version of the older document is saved there", () => {
	it("it opens with its own older version's ink carried, with the notice, not the renamed PDF's", async () => {
		const v = vault();
		v.files.set("Notes.pdf", doc("before"));
		const other = await inkOn(session(v), "Notes.pdf", "other-0");
		// Changed while Obsidian was closed: another document at the name; the earlier ink still claims it.
		v.files.set("Notes.pdf", doc("notes"));
		const inked = await inkOn(session(v), "Notes.pdf", "ink-0");
		expect(other, "precondition: two inks").not.toBe(inked);
		const { s } = await renameWaits(v, inked);
		v.listingWorks();
		shown.length = 0;
		// Before the move's next try at 10 s: a new version of the older document saved at the name.
		await s.createFile("Notes.pdf", doc("before, a new version"));
		const there = await s.inkAt("Notes.pdf");
		const otherHas = (v.sidecar(other)?.strokes ?? []).map((x) => x.id).sort();
		expect(
			{ strokes: [...there.strokes].sort(), said: carriedSaid().length, otherHas },
			"the new version did not get its own older version's ink, or got the renamed PDF's"
		).toEqual({
			strokes: ["other-0"],
			said: 1,
			otherHas: ["other-0"],
		});
	});
});

describe("a file made at a renamed PDF's old name, inked and deleted, the rename's claim move landing inside that deletion's grace", () => {
	it("the made file's own ink goes to the trash and a copy of its bytes opens blank; the renamed PDF keeps its ink", async () => {
		const v = vault();
		const { inked, s, dropped } = await renamedWhileUnlisted(v);
		await retryFailsOnListing(v, s, inked, dropped);
		// About 10 s now; the move's next try is due at about 30 s.
		v.listingWorks();
		await s.createFile("Notes.pdf", doc("other"));
		const made = await inkOn(s, "Notes.pdf", "other-0");
		expect(made, "precondition: the file made at the old name has its own ink").not.toBe(inked);
		// The delete at about 25 s: its grace ends at about 35 s, after the move's try at about 30 s.
		await vi.advanceTimersByTimeAsync(15_000);
		expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: the move still waits at the delete").toEqual(["Notes.pdf"]);
		await s.deleteFile("Notes.pdf");
		expect(s.pdfStore.pendingClaims().has("Notes.pdf"), "precondition: the deletion waits in its grace").toBe(true);
		await vi.advanceTimersByTimeAsync(6_000);
		await vi.waitFor(async () => {
			await s.store.flush();
			expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: the move landed inside the grace").toEqual(["Old.pdf"]);
		});
		const pendingAfterMove = s.pdfStore.pendingClaims().has("Notes.pdf");
		await minuteLater(s);
		const end = {
			madeLive: v.adapter.files.has(`${INK}/${made}.json`),
			madeClaims: v.sidecar(made)?.pdfPaths ?? [],
			madeInTrash: v.trashInk().some((t) => t.includes("other-0")),
		};
		await s.createFile("Copy.pdf", doc("other"));
		const copy = await opensOn(v, s, "Copy.pdf");
		const renamed = await opensOn(v, s, "Old.pdf");
		expect(
			{ pendingAfterMove, ...end, copy, renamed },
			"the move ended the old name's deletion, or the made file's ink stayed live, or a copy of its bytes opened on it, or the renamed PDF lost its ink"
		).toEqual({
			pendingAfterMove: true,
			madeLive: false,
			madeClaims: [],
			madeInTrash: true,
			copy: { here: { failed: false, strokes: [] }, relaunch: { failed: false, strokes: [] } },
			renamed: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
		});
	});
});

describe("another document standing at a renamed PDF's old name when the renamed PDF is deleted, the claim move waiting", () => {
	it("the renamed PDF's ink goes to the trash, and the document at the old name opens blank with no carried notice after a relaunch", async () => {
		const v = vault();
		const { inked, s, dropped } = await renamedWhileUnlisted(v);
		await retryFailsOnListing(v, s, inked, dropped);
		// Another document saved at the old name, not opened in this session.
		await s.createFile("Notes.pdf", doc("other"));
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		// The grace ends at about 20 s; the move's next try is due at 30 s.
		await retirementRuns(s);
		expect(s.pdfStore.pendingClaims().has("Old.pdf"), "precondition: the deletion ended").toBe(false);
		await minuteLater(s);
		const end = inkEnd(v, inked);
		const claimed = v.sidecar(inked)?.pdfPaths ?? [];
		shown.length = 0;
		const other = await session(v).inkAt("Notes.pdf");
		expect(
			{ ...end, claimed, other: { failed: other.failed, strokes: other.strokes }, said: carriedSaid().length },
			"the deleted PDF's ink stayed live on the old name, or the document there got it after a relaunch"
		).toEqual({
			live: false,
			trash: [["ink-0"]],
			claimed: [],
			other: { failed: false, strokes: [] },
			said: 0,
		});
	});

	it("the document at the old name, opened inside the renamed PDF's deletion grace, opens blank with no carried notice; the ink goes to the trash; it opens blank after a relaunch", async () => {
		const v = vault();
		const { inked, s, dropped } = await renamedWhileUnlisted(v);
		await retryFailsOnListing(v, s, inked, dropped);
		await s.createFile("Notes.pdf", doc("other"));
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		shown.length = 0;
		const inGrace = await s.inkAt("Notes.pdf");
		const saidInGrace = carriedSaid().length;
		expect(s.pdfStore.pendingClaims().has("Old.pdf"), "precondition: the open was inside the deletion's grace").toBe(true);
		// The retirement reads the head of the document at the old name with the real digest: it can still be running when
		// the minute's timers have run. Waited for here, as in the cell above.
		await retirementRuns(s);
		expect(s.pdfStore.pendingClaims().has("Old.pdf"), "precondition: the deletion ended").toBe(false);
		await minuteLater(s);
		const end = inkEnd(v, inked);
		shown.length = 0;
		const after = await session(v).inkAt("Notes.pdf");
		const saidAfter = carriedSaid().length;
		expect(
			{ inGrace: { failed: inGrace.failed, strokes: inGrace.strokes }, saidInGrace, ...end, after: { failed: after.failed, strokes: after.strokes }, saidAfter },
			"the document at the old name got the deleted PDF's ink in the grace or after a relaunch, or the ink did not go to the trash"
		).toEqual({
			inGrace: { failed: false, strokes: [] },
			saidInGrace: 0,
			live: false,
			trash: [["ink-0"]],
			after: { failed: false, strokes: [] },
			saidAfter: 0,
		});
	});

	it("CONTROL: the document at the old name cannot be read: the retirement takes nothing and the deletion waits", async () => {
		const v = vault();
		const { inked, s, dropped } = await renamedWhileUnlisted(v);
		await retryFailsOnListing(v, s, inked, dropped);
		await s.createFile("Notes.pdf", doc("other"));
		s.readFails("Notes.pdf");
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		await retirementRuns(s);
		await minuteLater(s);
		const waits = s.pdfStore.pendingClaims().has("Old.pdf");
		const end = inkEnd(v, inked);
		const claimed = v.sidecar(inked)?.pdfPaths ?? [];
		expect({ waits, ...end, claimed }, "the retirement acted on the renamed PDF's ink with the file at its old name unread, or the deletion did not wait").toEqual({
			waits: true,
			live: true,
			trash: [],
			claimed: ["Notes.pdf"],
		});
	});

	it("CONTROL: the document at the old name stood there at the delete and cannot be read: the retirement takes nothing and the deletion waits", async () => {
		const v = vault();
		const { inked, s, dropped } = await renamedWhileUnlisted(v);
		await retryFailsOnListing(v, s, inked, dropped);
		// Notes.pdf stands in the vault at the delete, no create event in this session: not a new file for the deletion,
		// so no later read of it can hold the deletion; only the read at the old name can.
		v.files.set("Notes.pdf", doc("other"));
		s.readFails("Notes.pdf");
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		await retirementRuns(s);
		await minuteLater(s);
		const waits = s.pdfStore.pendingClaims().has("Old.pdf");
		const end = inkEnd(v, inked);
		const claimed = v.sidecar(inked)?.pdfPaths ?? [];
		expect({ waits, ...end, claimed }, "the retirement acted on the renamed PDF's ink with the file standing at its old name unread, or the deletion did not wait").toEqual({
			waits: true,
			live: true,
			trash: [],
			claimed: ["Notes.pdf"],
		});
	});
});

describe("a same-bytes copy that stood before a renamed PDF's delete, opened in the deletion's grace, the claim move waiting", () => {
	it("the copy opens blank in the grace, the ink goes to the trash, and the copy opens blank after, also after a relaunch", async () => {
		const v = vault();
		const { inked, s } = await renamedWhileUnlisted(v);
		// Copy.pdf stands in the vault before the delete; no create event in this session.
		v.files.set("Copy.pdf", doc("notes"));
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		const inGrace = await s.inkAt("Copy.pdf");
		await retirementRuns(s);
		await minuteLater(s);
		const end = inkEnd(v, inked);
		const after = await opensOn(v, s, "Copy.pdf");
		expect({ inGrace: { failed: inGrace.failed, strokes: inGrace.strokes }, ...end, after }, "the copy that stood before the delete took the deleted PDF's ink").toEqual({
			inGrace: { failed: false, strokes: [] },
			live: false,
			trash: [["ink-0"]],
			after: { here: { failed: false, strokes: [] }, relaunch: { failed: false, strokes: [] } },
		});
	});

	it("CONTROL: no rename: the copy opens blank in the grace, the ink goes to the trash, and the copy opens blank after, also after a relaunch", async () => {
		const v = vault();
		v.files.set("Notes.pdf", doc("notes"));
		const inked = await inkOn(session(v), "Notes.pdf", "ink-0");
		v.files.set("Copy.pdf", doc("notes"));
		const s = session(v);
		vi.useFakeTimers();
		await s.deleteFile("Notes.pdf");
		const inGrace = await s.inkAt("Copy.pdf");
		await retirementRuns(s);
		await minuteLater(s);
		const end = inkEnd(v, inked);
		const after = await opensOn(v, s, "Copy.pdf");
		expect({ inGrace: { failed: inGrace.failed, strokes: inGrace.strokes }, ...end, after }, "with no rename, the copy that stood before the delete took the deleted PDF's ink").toEqual({
			inGrace: { failed: false, strokes: [] },
			live: false,
			trash: [["ink-0"]],
			after: { here: { failed: false, strokes: [] }, relaunch: { failed: false, strokes: [] } },
		});
	});

	it("CONTROL: a same-bytes file made in the deletion's grace and opened in the grace takes the ink, here and after a relaunch", async () => {
		const v = vault();
		const { inked, s } = await renamedWhileUnlisted(v);
		await s.deleteFile("Old.pdf");
		await s.createFile("Copy.pdf", doc("notes"));
		v.listingWorks();
		const inGrace = await s.inkAt("Copy.pdf");
		await retirementRuns(s);
		await minuteLater(s);
		const copy = await opensOn(v, s, "Copy.pdf");
		expect(
			{ inGrace: { failed: inGrace.failed, strokes: inGrace.strokes }, copy, trash: v.trashInk() },
			"the same-bytes file made in the grace and opened in it did not take the ink"
		).toEqual({
			inGrace: { failed: false, strokes: ["ink-0"] },
			copy: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
			trash: [],
		});
		expect(v.sidecar(inked)?.pdfPaths ?? [], "the ink does not claim the file made in the grace").toContain("Copy.pdf");
	});

	// The file put back stands at the old name at the delete: the ink's claim on that name is its own, never a name the
	// deletion takes, so no file made in the grace may take the ink from it.
	it("CONTROL: a same-bytes file put back at the old name stands there at the delete: another same-bytes file made in the grace and opened in it opens blank, in the grace and after, and the file put back keeps the ink", async () => {
		const v = vault();
		const { inked, s } = await renamedWhileUnlisted(v);
		await s.createFile("Notes.pdf", doc("notes"));
		await s.deleteFile("Old.pdf");
		await s.createFile("Copy.pdf", doc("notes"));
		v.listingWorks();
		const inGrace = await s.inkAt("Copy.pdf");
		await minuteLater(s);
		const end = inkEnd(v, inked);
		const copy = await opensOn(v, s, "Copy.pdf");
		const put = await opensOn(v, s, "Notes.pdf");
		expect(
			{ inGrace: { failed: inGrace.failed, strokes: inGrace.strokes }, ...end, copy, put },
			"the file made in the grace took the ink of the file put back at the old name, or that file lost it"
		).toEqual({
			inGrace: { failed: false, strokes: [] },
			live: true,
			trash: [],
			copy: { here: { failed: false, strokes: [] }, relaunch: { failed: false, strokes: [] } },
			put: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
		});
	});

	// As above, but the file at the old name was there before this session saw any create event for it, so it is not
	// new for the deletion: only the open's check that no file stands at the old name keeps that name from waiting.
	it("CONTROL: a same-bytes file that stood at the old name with no create event, at the delete: another same-bytes file made in the grace and opened in it opens blank, in the grace and after, and the file at the old name keeps the ink", async () => {
		const v = vault();
		const { inked, s } = await renamedWhileUnlisted(v);
		// Notes.pdf stands in the vault before the delete; no create event in this session.
		v.files.set("Notes.pdf", doc("notes"));
		await s.deleteFile("Old.pdf");
		await s.createFile("Copy.pdf", doc("notes"));
		v.listingWorks();
		const inGrace = await s.inkAt("Copy.pdf");
		await minuteLater(s);
		const end = inkEnd(v, inked);
		const copy = await opensOn(v, s, "Copy.pdf");
		const stood = await opensOn(v, s, "Notes.pdf");
		expect(
			{ inGrace: { failed: inGrace.failed, strokes: inGrace.strokes }, ...end, copy, stood },
			"the file made in the grace took the ink of the file that stood at the old name, or that file lost it"
		).toEqual({
			inGrace: { failed: false, strokes: [] },
			live: true,
			trash: [],
			copy: { here: { failed: false, strokes: [] }, relaunch: { failed: false, strokes: [] } },
			stood: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
		});
	});
});

for (const listed of [false, true]) {
	describe(`a renamed PDF opened ${listed ? "once the listing works" : "while the listing still fails"} before its delete, so its ink claims both names, then a same-bytes file made in the deletion's grace and opened in it`, () => {
		it("the file made in the grace takes the ink, in the grace and after, also after a relaunch, and nothing goes to the trash", async () => {
			const v = vault();
			const { inked, s } = await renamedWhileUnlisted(v);
			if (listed) v.listingWorks();
			const there = await s.inkAt("Old.pdf");
			expect({ failed: there.failed, strokes: there.strokes }, "precondition: the renamed PDF opened on its ink").toEqual({ failed: false, strokes: ["ink-0"] });
			await s.store.flush();
			expect([...(v.sidecar(inked)?.pdfPaths ?? [])].sort(), "precondition: the open claimed the new name beside the old").toEqual(["Notes.pdf", "Old.pdf"]);
			await s.deleteFile("Old.pdf");
			await s.createFile("Copy.pdf", doc("notes"));
			v.listingWorks();
			const inGrace = await s.inkAt("Copy.pdf");
			const waitsAfterOpen = s.pdfStore.pendingClaims().has("Old.pdf");
			await minuteLater(s);
			const end = inkEnd(v, inked);
			const copy = await opensOn(v, s, "Copy.pdf");
			expect(
				{ inGrace: { failed: inGrace.failed, strokes: inGrace.strokes }, waitsAfterOpen, ...end, copy },
				"the same-bytes file made in the grace did not take the ink, in the grace or after, or the open left the deletion waiting, or the ink went to the trash"
			).toEqual({
				inGrace: { failed: false, strokes: ["ink-0"] },
				waitsAfterOpen: false,
				live: true,
				trash: [],
				copy: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
			});
		});

		// The file made in the grace takes the ink as the deleted file's next name: the deletion's old name goes with it.
		it("the ink then claims the file made in the grace alone: another document saved later at the old name opens blank with no carried notice, here and after a relaunch, and the file made in the grace keeps the ink", async () => {
			const v = vault();
			const { inked, s } = await renamedWhileUnlisted(v);
			if (listed) v.listingWorks();
			const there = await s.inkAt("Old.pdf");
			expect({ failed: there.failed, strokes: there.strokes }, "precondition: the renamed PDF opened on its ink").toEqual({ failed: false, strokes: ["ink-0"] });
			await s.store.flush();
			expect([...(v.sidecar(inked)?.pdfPaths ?? [])].sort(), "precondition: the open claimed the new name beside the old").toEqual(["Notes.pdf", "Old.pdf"]);
			await s.deleteFile("Old.pdf");
			await s.createFile("Copy.pdf", doc("notes"));
			v.listingWorks();
			const inGrace = await s.inkAt("Copy.pdf");
			expect({ failed: inGrace.failed, strokes: inGrace.strokes }, "precondition: the file made in the grace took the ink").toEqual({ failed: false, strokes: ["ink-0"] });
			await minuteLater(s);
			await s.store.flush();
			const claimed = [...(v.sidecar(inked)?.pdfPaths ?? [])].sort();
			await s.createFile("Notes.pdf", doc("other"));
			shown.length = 0;
			const here = await s.inkAt("Notes.pdf");
			const saidHere = carriedSaid().length;
			shown.length = 0;
			const after = await session(v).inkAt("Notes.pdf");
			const saidAfter = carriedSaid().length;
			const end = inkEnd(v, inked);
			const copy = await session(v).inkAt("Copy.pdf");
			expect(
				{
					claimed,
					here: { failed: here.failed, strokes: here.strokes },
					saidHere,
					after: { failed: after.failed, strokes: after.strokes },
					saidAfter,
					...end,
					copy: { failed: copy.failed, strokes: copy.strokes },
				},
				"the ink kept the old name, or the document later saved there got the ink carried, here or after a relaunch, or the file made in the grace lost the ink"
			).toEqual({
				claimed: ["Copy.pdf"],
				here: { failed: false, strokes: [] },
				saidHere: 0,
				after: { failed: false, strokes: [] },
				saidAfter: 0,
				live: true,
				trash: [],
				copy: { failed: false, strokes: ["ink-0"] },
			});
		});

		// As the cell before, but the document at the old name is saved and first opened after a relaunch: no open in the
		// first session carries the ink into its claim, so this open is the one that would carry it.
		it("another document saved at the old name after a relaunch and first opened there opens blank with no carried notice, and the file made in the grace keeps the ink", async () => {
			const v = vault();
			const { inked, s } = await renamedWhileUnlisted(v);
			if (listed) v.listingWorks();
			const there = await s.inkAt("Old.pdf");
			expect({ failed: there.failed, strokes: there.strokes }, "precondition: the renamed PDF opened on its ink").toEqual({ failed: false, strokes: ["ink-0"] });
			await s.store.flush();
			expect([...(v.sidecar(inked)?.pdfPaths ?? [])].sort(), "precondition: the open claimed the new name beside the old").toEqual(["Notes.pdf", "Old.pdf"]);
			await s.deleteFile("Old.pdf");
			await s.createFile("Copy.pdf", doc("notes"));
			v.listingWorks();
			const inGrace = await s.inkAt("Copy.pdf");
			expect({ failed: inGrace.failed, strokes: inGrace.strokes }, "precondition: the file made in the grace took the ink").toEqual({ failed: false, strokes: ["ink-0"] });
			await minuteLater(s);
			await s.store.flush();
			const claimed = [...(v.sidecar(inked)?.pdfPaths ?? [])].sort();
			const relaunched = session(v);
			await relaunched.createFile("Notes.pdf", doc("other"));
			shown.length = 0;
			const later = await relaunched.inkAt("Notes.pdf");
			const saidLater = carriedSaid().length;
			const end = inkEnd(v, inked);
			const copy = await relaunched.inkAt("Copy.pdf");
			expect(
				{ claimed, later: { failed: later.failed, strokes: later.strokes }, saidLater, ...end, copy: { failed: copy.failed, strokes: copy.strokes } },
				"the ink kept the old name, or the document saved there after a relaunch got the ink carried, or the file made in the grace lost the ink"
			).toEqual({
				claimed: ["Copy.pdf"],
				later: { failed: false, strokes: [] },
				saidLater: 0,
				live: true,
				trash: [],
				copy: { failed: false, strokes: ["ink-0"] },
			});
		});

		// The order turned round: another document is saved at the old name before the file made in the grace is opened.
		// The deletion takes the old name off the ink when another document stands there, so the open does too: the file
		// made in the grace is still the deleted file's next name, and the old name goes with the ink.
		it("another document saved at the old name before the file made in the grace is opened: the file made in the grace takes the ink and claims its own name alone, here and after a relaunch, nothing goes to the trash, and the document at the old name opens blank with no carried notice, here and after a relaunch", async () => {
			const v = vault();
			const { inked, s } = await renamedWhileUnlisted(v);
			if (listed) v.listingWorks();
			const there = await s.inkAt("Old.pdf");
			expect({ failed: there.failed, strokes: there.strokes }, "precondition: the renamed PDF opened on its ink").toEqual({ failed: false, strokes: ["ink-0"] });
			await s.store.flush();
			expect([...(v.sidecar(inked)?.pdfPaths ?? [])].sort(), "precondition: the open claimed the new name beside the old").toEqual(["Notes.pdf", "Old.pdf"]);
			await s.deleteFile("Old.pdf");
			await s.createFile("Notes.pdf", doc("other"));
			await s.createFile("Copy.pdf", doc("notes"));
			v.listingWorks();
			const inGrace = await s.inkAt("Copy.pdf");
			await minuteLater(s);
			await s.store.flush();
			shown.length = 0;
			const here = await s.inkAt("Notes.pdf");
			const saidHere = carriedSaid().length;
			shown.length = 0;
			const after = await session(v).inkAt("Notes.pdf");
			const saidAfter = carriedSaid().length;
			const copy = await opensOn(v, s, "Copy.pdf");
			const end = inkEnd(v, inked);
			const claimed = [...(v.sidecar(inked)?.pdfPaths ?? [])].sort();
			expect(
				{
					inGrace: { failed: inGrace.failed, strokes: inGrace.strokes },
					here: { failed: here.failed, strokes: here.strokes },
					saidHere,
					after: { failed: after.failed, strokes: after.strokes },
					saidAfter,
					copy,
					...end,
					claimed,
				},
				"the file made in the grace did not take the ink, here or after a relaunch, or the ink kept the old name or went to the trash, or the document at the old name got the ink carried"
			).toEqual({
				inGrace: { failed: false, strokes: ["ink-0"] },
				here: { failed: false, strokes: [] },
				saidHere: 0,
				after: { failed: false, strokes: [] },
				saidAfter: 0,
				copy: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
				live: true,
				trash: [],
				claimed: ["Copy.pdf"],
			});
		});

		// The open tells another document at the old name by reading it, as the deletion does. Unread, it could be the same
		// bytes put back, which keep the name: the open adopts nothing, as the deletion acts on nothing and waits.
		it("CONTROL: another document saved at the old name cannot be read: the file made in the grace and opened in it opens blank, the deletion waits, and the ink keeps both names", async () => {
			const v = vault();
			const { inked, s } = await renamedWhileUnlisted(v);
			if (listed) v.listingWorks();
			const there = await s.inkAt("Old.pdf");
			expect({ failed: there.failed, strokes: there.strokes }, "precondition: the renamed PDF opened on its ink").toEqual({ failed: false, strokes: ["ink-0"] });
			await s.store.flush();
			expect([...(v.sidecar(inked)?.pdfPaths ?? [])].sort(), "precondition: the open claimed the new name beside the old").toEqual(["Notes.pdf", "Old.pdf"]);
			await s.deleteFile("Old.pdf");
			await s.createFile("Notes.pdf", doc("other"));
			s.readFails("Notes.pdf");
			await s.createFile("Copy.pdf", doc("notes"));
			v.listingWorks();
			const inGrace = await s.inkAt("Copy.pdf");
			await minuteLater(s);
			await s.store.flush();
			const waits = s.pdfStore.pendingClaims().has("Old.pdf");
			const end = inkEnd(v, inked);
			const claimed = [...(v.sidecar(inked)?.pdfPaths ?? [])].sort();
			const copy = await s.inkAt("Copy.pdf");
			expect(
				{ inGrace: { failed: inGrace.failed, strokes: inGrace.strokes }, waits, ...end, claimed, copy: { failed: copy.failed, strokes: copy.strokes } },
				"with the file at the old name unread, the file made in the grace took the ink, or the deletion did not wait, or the ink lost a name"
			).toEqual({
				inGrace: { failed: false, strokes: [] },
				waits: true,
				live: true,
				trash: [],
				claimed: ["Notes.pdf", "Old.pdf"],
				copy: { failed: false, strokes: [] },
			});
		});

		// Only a file the open read can free the old name. One that comes to the name later, while the open loads the ink
		// it chose, is not read: the name stays claimed, as for the same bytes put back there.
		it("the same bytes put back at the old name while the open of the file made in the grace loads the ink: the ink keeps the old name beside the file made in the grace", async () => {
			const v = vault();
			const { inked, s } = await renamedWhileUnlisted(v);
			if (listed) v.listingWorks();
			const there = await s.inkAt("Old.pdf");
			expect({ failed: there.failed, strokes: there.strokes }, "precondition: the renamed PDF opened on its ink").toEqual({ failed: false, strokes: ["ink-0"] });
			await s.store.flush();
			expect([...(v.sidecar(inked)?.pdfPaths ?? [])].sort(), "precondition: the open claimed the new name beside the old").toEqual(["Notes.pdf", "Old.pdf"]);
			await s.deleteFile("Old.pdf");
			await s.createFile("Copy.pdf", doc("notes"));
			v.listingWorks();
			// The open's load of the ink it chose: the same bytes are put back at the old name first.
			let putBack = false;
			const load = s.pdfStore.ensureLoaded.bind(s.pdfStore);
			vi.spyOn(s.pdfStore, "ensureLoaded").mockImplementation(async (id: string) => {
				if (id === inked && !putBack) {
					putBack = true;
					await s.createFile("Notes.pdf", doc("notes"));
				}
				return load(id);
			});
			const inGrace = await s.inkAt("Copy.pdf");
			const waitsAfterOpen = s.pdfStore.pendingClaims().has("Old.pdf");
			await s.store.flush();
			const claimed = [...(v.sidecar(inked)?.pdfPaths ?? [])].sort();
			expect(
				{ putBack, inGrace: { failed: inGrace.failed, strokes: inGrace.strokes }, waitsAfterOpen, claimed },
				"the file made in the grace did not take the ink, or the open's claim took the old name the same bytes came back to while it loaded the ink"
			).toEqual({
				putBack: true,
				inGrace: { failed: false, strokes: ["ink-0"] },
				waitsAfterOpen: false,
				claimed: ["Copy.pdf", "Notes.pdf"],
			});
		});
	});
}

describe("a same-bytes file made at a deleted PDF's name inside its grace, then renamed off it while the ink folder will not list", () => {
	it("its claim move, landing late inside the grace, ends that deletion as a rename does; the file keeps the ink, also after a relaunch", async () => {
		const v = vault();
		v.files.set("Notes.pdf", doc("notes"));
		const inked = await inkOn(session(v), "Notes.pdf", "ink-0");
		const s = session(v);
		const dropped = movesDropped();
		vi.useFakeTimers();
		await s.deleteFile("Notes.pdf");
		await s.createFile("Notes.pdf", doc("notes"));
		v.listingFails(Infinity);
		await vi.advanceTimersByTimeAsync(5_000);
		await s.renameFile("Notes.pdf", "Old.pdf");
		expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: the move waits").toEqual(["Notes.pdf"]);
		expect(s.pdfStore.pendingClaims().has("Notes.pdf"), "precondition: the deletion waits at the old name at the rename").toBe(true);
		// The grace ends at 10 s with the folder still not listing: the retirement waits and is tried again at 20 s.
		await vi.advanceTimersByTimeAsync(5_001);
		await s.store.flush();
		expect(s.pdfStore.pendingClaims().has("Notes.pdf"), "precondition: the retirement at the grace's end waited").toBe(true);
		// The move's next try is due at 15 s, before the retirement's.
		await vi.advanceTimersByTimeAsync(2_000);
		v.listingWorks();
		await vi.advanceTimersByTimeAsync(3_500);
		await vi.waitFor(async () => {
			await s.store.flush();
			expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: the move landed").toEqual(["Old.pdf"]);
		});
		expect(dropped(), "precondition: the move was not dropped").toBe(0);
		const waitsAfterMove = s.pdfStore.pendingClaims().has("Notes.pdf");
		await minuteLater(s);
		const end = inkEnd(v, inked);
		const renamed = await opensOn(v, s, "Old.pdf");
		expect({ waitsAfterMove, ...end, renamed }, "the late move left the deletion that waited at the old name at the rename, or the renamed file lost the ink").toEqual({
			waitsAfterMove: false,
			live: true,
			trash: [],
			renamed: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
		});
	});
});

/**
 * Notes.pdf inked and renamed to Old.pdf while the listing fails, its move waiting; the same bytes saved again at
 * Notes.pdf; `before` run there; then that file renamed to Copy.pdf with no pane, its own move off Notes.pdf waiting.
 * Both moves try again at 10 s, fail on the listing, and wait 20 s more (due at 30 s).
 */
async function copyRenamedOff(v: Vault, before?: (s: Session, inked: string) => Promise<void>) {
	const { inked, s, dropped } = await renamedWhileUnlisted(v);
	await s.createFile("Notes.pdf", doc("notes"));
	if (before) await before(s, inked);
	await s.renameFile("Notes.pdf", "Copy.pdf");
	expect(dropped(), "precondition: neither claim move was dropped").toBe(0);
	expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: both moves wait, the ink still claims the old name").toEqual(["Notes.pdf"]);
	const calls = v.failing.calls;
	await vi.advanceTimersByTimeAsync(10_001);
	await vi.waitFor(() => expect(v.failing.calls, "precondition: both moves' tries at 10 s listed the ink folder").toBeGreaterThanOrEqual(calls + 2));
	await vi.advanceTimersByTimeAsync(0);
	await s.store.flush();
	expect(dropped(), "precondition: neither move's try at 10 s was dropped").toBe(0);
	expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: both moves still wait").toEqual(["Notes.pdf"]);
	return { inked, s, dropped };
}

/** `ms` on, the listing working: a waiting move's next try lists the ink folder, and lands or finds no ink to move. */
async function moveTriedAgain(v: Vault, s: Session, ms: number) {
	const calls = v.failing.calls;
	await vi.advanceTimersByTimeAsync(ms);
	await vi.waitFor(() => expect(v.failing.calls, "precondition: a waiting move tried again").toBeGreaterThan(calls));
	await vi.advanceTimersByTimeAsync(0);
	await s.store.flush();
}

/** The retirements due by `ms` on, all of them, ended (each runs in turn after the one before). */
async function retirementsEnd(s: Session, ms = 10_001) {
	await retirementRuns(s, ms);
	await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size, "precondition: every deletion ended").toBe(0));
	await vi.advanceTimersByTimeAsync(0);
	await s.store.flush();
}

/**
 * The copy and the original both gone: the ink is in the trash once, no live ink file claims the old name, and a
 * same-bytes file saved later at the old name opens blank, here and after a relaunch.
 */
async function bothGone(v: Vault, s: Session, inked: string, when: string) {
	const end = inkEnd(v, inked);
	const onOldName = Object.entries(v.claims())
		.filter(([, paths]) => paths.includes("Notes.pdf"))
		.map(([name]) => name);
	await s.createFile("Notes.pdf", doc("notes"));
	const back = await opensOn(v, s, "Notes.pdf");
	expect(
		{ ...end, onOldName, back },
		`${when}: the ink is not in the trash once with no live file, or ink still claims the old name, or a same-bytes file saved there later did not open blank, here or after a relaunch`
	).toEqual({ live: false, trash: [["ink-0"]], onOldName: [], back: { here: { failed: false, strokes: [] }, relaunch: { failed: false, strokes: [] } } });
}

// A same-bytes file renamed off the old name, its own
// claim move waiting, stands under its new name. The ink on the old name is that file's: the original's deletion does
// not take it.
describe("a same-bytes file saved at a renamed PDF's old name and renamed off it while both claim moves wait, then the renamed PDF deleted", () => {
	// B1, the order first found: the copy renamed off before the delete, the retirement before the copy's move tries again.
	it("the ink stays out of the trash, and once the copy's move lands it claims the copy alone, which opens on it, also after a relaunch", async () => {
		const v = vault();
		const { inked, s } = await copyRenamedOff(v);
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		// The grace ends at about 20 s; both moves' next tries are due at 30 s.
		await retirementRuns(s);
		expect(s.pdfStore.pendingClaims().has("Old.pdf"), "precondition: the deletion ended").toBe(false);
		expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: the copy's move had not landed when the retirement ended").not.toContain("Copy.pdf");
		const atRetirement = inkEnd(v, inked);
		await moveTriedAgain(v, s, 10_000);
		await minuteLater(s);
		const claims = v.sidecar(inked)?.pdfPaths ?? [];
		const copy = await opensOn(v, s, "Copy.pdf");
		expect(
			{ atRetirement, claims, copy },
			"the deletion took the copy's ink to the trash, or its move did not carry the ink to the copy alone, or the copy did not open on it, here or after a relaunch"
		).toEqual({
			atRetirement: { live: true, trash: [] },
			claims: ["Copy.pdf"],
			copy: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
		});
	});

	// B1-own: the copy opened at the old name opens on the renamed PDF's ink (G5), so a stroke drawn
	// there is on that ink: there is no second ink of these bytes to tell apart.
	it("the copy opened and drawn on at the old name before its rename: the ink with both strokes stays out of the trash and goes to the copy alone, also after a relaunch", async () => {
		const v = vault();
		const { inked, s } = await copyRenamedOff(v, async (on, renamedInk) => {
			const id = await inkOn(on, "Notes.pdf", "copy-0", 30);
			expect(id, "precondition: the copy at the old name opened on the renamed PDF's ink").toBe(renamedInk);
		});
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		await retirementRuns(s);
		expect(s.pdfStore.pendingClaims().has("Old.pdf"), "precondition: the deletion ended").toBe(false);
		expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: the copy's move had not landed when the retirement ended").not.toContain("Copy.pdf");
		const atRetirement = inkEnd(v, inked);
		await moveTriedAgain(v, s, 10_000);
		await minuteLater(s);
		const live = { strokes: (v.sidecar(inked)?.strokes ?? []).map((x) => x.id).sort(), claims: v.sidecar(inked)?.pdfPaths ?? [] };
		const files = Object.keys(v.claims());
		const copy = await opensOn(v, s, "Copy.pdf");
		const sorted = (o: { failed: boolean; strokes: string[] }) => ({ failed: o.failed, strokes: [...o.strokes].sort() });
		expect(
			{ atRetirement, live, files, copy: { here: sorted(copy.here), relaunch: sorted(copy.relaunch) } },
			"the deletion took the copy's strokes to the trash, or the ink did not go to the copy alone with both strokes, or a second ink file was made, or the copy did not open on both, here or after a relaunch"
		).toEqual({
			atRetirement: { live: true, trash: [] },
			live: { strokes: ["copy-0", "ink-0"], claims: ["Copy.pdf"] },
			files: [`${inked}.json`],
			copy: { here: { failed: false, strokes: ["copy-0", "ink-0"] }, relaunch: { failed: false, strokes: ["copy-0", "ink-0"] } },
		});
	});

	// B3a: the copy deleted too before its move lands, both deleted before either retirement; Old.pdf's
	// retirement runs first, as it was armed first.
	it("the copy deleted too, after the renamed PDF and before either retirement: the ink goes to the trash once, nothing claims the old name, and a same-bytes file saved there later opens blank", async () => {
		const v = vault();
		const { inked, s } = await copyRenamedOff(v);
		await s.deleteFile("Old.pdf");
		await s.deleteFile("Copy.pdf");
		v.listingWorks();
		const runs = vi.spyOn(PdfInkStore.prototype as never as { retireDeletedPath(path: string, ...a: unknown[]): Promise<void> }, "retireDeletedPath");
		await retirementsEnd(s);
		expect(runs.mock.calls.map(([p]) => p), "precondition: the renamed PDF's retirement ran first").toEqual(["Old.pdf", "Copy.pdf"]);
		await minuteLater(s);
		await bothGone(v, s, inked, "copy deleted second, renamed PDF's retirement first");
	});

	// B3b: the other order of the two retirements. The copy is deleted first, so its grace
	// ends first and its retirement runs first: retirements run in turn, each armed at its own delete.
	it("the copy deleted before the renamed PDF, before either retirement: the ink goes to the trash once, nothing claims the old name, and a same-bytes file saved there later opens blank", async () => {
		const v = vault();
		const { inked, s } = await copyRenamedOff(v);
		await s.deleteFile("Copy.pdf");
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		const runs = vi.spyOn(PdfInkStore.prototype as never as { retireDeletedPath(path: string, ...a: unknown[]): Promise<void> }, "retireDeletedPath");
		await retirementsEnd(s);
		expect(runs.mock.calls.map(([p]) => p), "precondition: the copy's retirement ran first").toEqual(["Copy.pdf", "Old.pdf"]);
		await minuteLater(s);
		await bothGone(v, s, inked, "copy deleted first, its retirement first");
	});

	// B3c: the copy deleted after the renamed PDF's retirement ran, before the copy's move lands. Now that retirement
	// keeps the ink on the old name for the copy; before this fix it already took it.
	it("the copy deleted after the renamed PDF's retirement ran and before its move lands: the ink goes to the trash once, nothing claims the old name, and a same-bytes file saved there later opens blank", async () => {
		const v = vault();
		const { inked, s } = await copyRenamedOff(v);
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		await retirementRuns(s);
		expect(s.pdfStore.pendingClaims().has("Old.pdf"), "precondition: the renamed PDF's deletion ended").toBe(false);
		expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: the copy's move had not landed").not.toContain("Copy.pdf");
		// About 20 s: the copy's move is due at 30 s, its grace ends at about 30 s.
		await s.deleteFile("Copy.pdf");
		await retirementsEnd(s);
		await minuteLater(s);
		await bothGone(v, s, inked, "copy deleted after the first retirement");
	});

	// Guard for the fix's `except`: the deleted file's own move off the old name still names the deleted path. Another
	// document renamed onto that path in the grace stands there; it is not the deleted file.
	it("CONTROL: another document renamed onto the deleted PDF's name in its grace, the copy never made: the ink goes to the trash, and that document opens blank, also after a relaunch", async () => {
		const v = vault();
		v.files.set("Other.pdf", doc("other"));
		const { inked, s, dropped } = await renamedWhileUnlisted(v);
		await retryFailsOnListing(v, s, inked, dropped);
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		await s.renameFile("Other.pdf", "Old.pdf");
		// The grace ends at about 20 s; the renamed PDF's move is due at 30 s.
		await retirementRuns(s);
		expect(s.pdfStore.pendingClaims().has("Old.pdf"), "precondition: the deletion ended").toBe(false);
		const atRetirement = inkEnd(v, inked);
		await minuteLater(s);
		const end = inkEnd(v, inked);
		const onto = await opensOn(v, s, "Old.pdf");
		expect(
			{ atRetirement, end, onto },
			"the deleted PDF's ink stayed out of the trash for the document renamed onto its name, or that document opened on it, here or after a relaunch"
		).toEqual({
			atRetirement: { live: false, trash: [["ink-0"]] },
			end: { live: false, trash: [["ink-0"]] },
			onto: { here: { failed: false, strokes: [] }, relaunch: { failed: false, strokes: [] } },
		});
	});
});

// The other order. The original is deleted while the copy still stands at the old name; the copy is
// renamed off it inside the grace with the listing failing, and the retirement runs before the copy's move tries again.
describe("a renamed PDF deleted while a same-bytes file stands at its old name, that file renamed off it inside the grace while both claim moves wait", () => {
	it("the ink stays out of the trash, and once the copy's move lands it claims the copy alone, which opens on it, also after a relaunch", async () => {
		const v = vault();
		const { inked, s, dropped } = await renamedWhileUnlisted(v);
		await s.createFile("Notes.pdf", doc("notes"));
		// The renamed PDF's move tries at 10 s and fails: the copy is a grace old at the delete, so it stood at the old
		// name then and is no new name for the ink.
		await retryFailsOnListing(v, s, inked, dropped);
		await s.deleteFile("Old.pdf");
		await vi.advanceTimersByTimeAsync(2_000);
		await s.renameFile("Notes.pdf", "Copy.pdf");
		expect(dropped(), "precondition: neither claim move was dropped").toBe(0);
		expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: both moves wait, the ink still claims the old name").toEqual(["Notes.pdf"]);
		v.listingWorks();
		// The grace ends at about 20 s; the copy's move is due at about 22 s.
		await retirementRuns(s, 8_001);
		expect(s.pdfStore.pendingClaims().has("Old.pdf"), "precondition: the retirement ran to its end, it did not wait").toBe(false);
		expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: the copy's move had not landed when the retirement ended").not.toContain("Copy.pdf");
		const atRetirement = inkEnd(v, inked);
		await moveTriedAgain(v, s, 2_000);
		await minuteLater(s);
		const claims = v.sidecar(inked)?.pdfPaths ?? [];
		const copy = await opensOn(v, s, "Copy.pdf");
		expect(
			{ atRetirement, claims, copy },
			"the deletion took the copy's ink to the trash, or its move did not carry the ink to the copy alone, or the copy did not open on it, here or after a relaunch"
		).toEqual({
			atRetirement: { live: true, trash: [] },
			claims: ["Copy.pdf"],
			copy: { here: { failed: false, strokes: ["ink-0"] }, relaunch: { failed: false, strokes: ["ink-0"] } },
		});
	});
});

/**
 * The store's move of `id`'s live ink file into the trash (PageStoreRemove, after the remove has taken any queued
 * save), held at its start until released.
 */
function holdTrashMove(v: Vault, id: string) {
	const { gate, hold } = gated();
	const state = { reached: false };
	const rename = v.adapter.rename.bind(v.adapter);
	v.adapter.rename = async (from: string, to: string) => {
		if (!state.reached && from === `${INK}/${id}.json` && to.startsWith(`${INK}/trash/`)) {
			state.reached = true;
			gate.reached();
			await gate.released;
		}
		return rename(from, to);
	};
	return { release: hold.release, reached: () => state.reached };
}

/** The retirement's own call, spied so a cell can wait for it to end. */
function retirementCalls() {
	return vi.spyOn(PdfInkStore.prototype as never as { retireDeletedPath(...a: unknown[]): Promise<void> }, "retireDeletedPath");
}

/** Notes.pdf inked, renamed while the listing fails, and deleted with no open since: the ink claims the old name alone. */
async function deletedOnOldNameAlone(v: Vault) {
	const { inked, s } = await renamedWhileUnlisted(v);
	await s.deleteFile("Old.pdf");
	v.listingWorks();
	expect(v.sidecar(inked)?.pdfPaths ?? [], "precondition: the ink claims the old name alone").toEqual(["Notes.pdf"]);
	return { inked, s };
}

/** A same-bytes Fresh.pdf made now and opened, let run until it has claimed the ink. The open itself may still run. */
async function freshOpensDuringHold(s: Session, inked: string) {
	await s.createFile("Fresh.pdf", doc("notes"));
	const opening = s.open("Fresh.pdf");
	await vi.waitFor(() =>
		expect(
			s.pdfStore.claimedInstances((i) => i === inked)[0]?.paths ?? [],
			"precondition: the open took the ink while the retirement was held"
		).toContain("Fresh.pdf")
	);
	return { opening };
}

/**
 * After the held retirement: what the pane shows and whether its record is held; then a stroke, every timer, the live
 * file, and the new file after a relaunch. Every part is read before the one assert. `trashAtEnd`, when given, is the
 * trash read once the retirement ended: it must hold no ink.
 */
async function paneKeepsInk(
	v: Vault,
	s: Session,
	inked: string,
	o: { root: HTMLElement; id: string | undefined },
	when: string,
	trashAtEnd?: string[][]
) {
	const pane = { id: o.id, strokes: o.id === undefined ? [] : s.pdfStore.strokes(o.id).map((x) => x.id), held: s.pdfStore.inkReady(inked) };
	if (o.id !== undefined) s.draw(o.id, stroke(30, "ink-1"));
	await minuteLater(s);
	const live = { strokes: (v.sidecar(inked)?.strokes ?? []).map((x) => x.id).sort(), claims: [...(v.sidecar(inked)?.pdfPaths ?? [])].sort() };
	s.close(o.root);
	const next = await session(v).inkAt("Fresh.pdf");
	const trash = trashAtEnd === undefined ? {} : { trash: trashAtEnd };
	expect(
		{ pane, live, relaunch: { failed: next.failed, strokes: [...next.strokes].sort() }, ...trash },
		`${when}: the pane lost the ink it opened on, or its record was dropped, or the live file does not hold the old strokes with the new one and claim the new file alone, or the new file does not open on both after a relaunch${trashAtEnd === undefined ? "" : ", or the retirement moved the ink file into the trash"}`
	).toEqual({
		pane: { id: inked, strokes: ["ink-0"], held: true },
		live: { strokes: ["ink-0", "ink-1"], claims: ["Fresh.pdf"] },
		relaunch: { failed: false, strokes: ["ink-0", "ink-1"] },
		...(trashAtEnd === undefined ? {} : { trash: [] }),
	});
}

// The retirement works out which names stay on the ink, then awaits; an open of a same-bytes file made meanwhile adopts the ink and claims its own path. The
// retirement must see that claim, not drop the record from under the pane.
describe("a renamed PDF deleted while its claim move waits, its ink on the old name alone, and a same-bytes file opened while the retirement awaits", () => {
	// B6, the road first found: the open lands while the store moves the ink file into the trash.
	it("opened while the store moves the ink file into the trash: the pane keeps the ink, the record is held, and a stroke drawn after is saved with the old one on the new file alone, also after a relaunch", async () => {
		const v = vault();
		const { inked, s } = await deletedOnOldNameAlone(v);
		const trash = holdTrashMove(v, inked);
		const removes = vi.spyOn(s.store, "remove");
		const runs = retirementCalls();
		// The grace ends at 10 s.
		await vi.advanceTimersByTimeAsync(10_001);
		await vi.waitFor(() => expect(trash.reached(), "precondition: the retirement's remove reached the move into the trash").toBe(true));
		const { opening } = await freshOpensDuringHold(s, inked);
		trash.release();
		await Promise.allSettled(runs.mock.results.map((r) => r.value as Promise<void>));
		const o = await opening;
		expect(await (removes.mock.results[0]?.value as Promise<boolean> | undefined), "precondition: the store's remove answered that no live file is left").toBe(true);
		await paneKeepsInk(v, s, inked, o, "opened during the move into the trash");
	});

	// B7: the open lands in the retirement's read of whether the ink file is still the bytes this session read (an await
	// before the remove). That read is made only for an ink file that claims no
	// path while the record claims a name the deletion takes: here an ink file written before claims were kept, adopted
	// at the old name while every write of it fails, so the adopted claim never reaches it. The hold is a spy on that
	// read; the state is built by the plugin's own roads.
	it("opened while the retirement reads whether the ink file is its own bytes: the pane keeps the ink, the record is held, and a stroke drawn after is saved with the old one on the new file alone, also after a relaunch", async () => {
		const v = vault();
		v.files.set("Notes.pdf", doc("notes"));
		const inked = await inkOn(session(v), "Notes.pdf", "ink-0");
		const file = `${INK}/${inked}.json`;
		const legacy = parsePage(v.adapter.files.get(file)!, inked).data;
		delete legacy.pdfPaths;
		v.adapter.files.set(file, serializePage(legacy));
		const s = session(v);
		const dropped = movesDropped();
		vi.useFakeTimers();
		v.adapter.failWriteTimes = Number.MAX_SAFE_INTEGER;
		const adopted = await s.inkAt("Notes.pdf");
		expect({ id: adopted.id, strokes: adopted.strokes }, "precondition: Notes.pdf opened on the ink file that claims no path").toEqual({ id: inked, strokes: ["ink-0"] });
		v.listingFails(Infinity);
		await s.renameFile("Notes.pdf", "Old.pdf");
		expect(dropped(), "precondition: the rename's claim move was not dropped").toBe(0);
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		expect(
			{ file: v.sidecar(inked)?.pdfPaths ?? [], record: s.pdfStore.claimedInstances((i) => i === inked)[0]?.paths ?? [] },
			"precondition: the ink file claims no path, and the record claims the old name alone"
		).toEqual({ file: [], record: ["Notes.pdf"] });
		const own = gated();
		const read = { reached: false, answer: undefined as boolean | undefined };
		const proto = PdfInkStore.prototype as never as { isOwnRevision(...a: unknown[]): Promise<boolean> };
		const isOwnRevision = proto.isOwnRevision;
		vi.spyOn(proto, "isOwnRevision").mockImplementation(async function (this: unknown, ...a: unknown[]) {
			const answer = await isOwnRevision.apply(this, a);
			if (!read.reached) {
				read.reached = true;
				read.answer = answer;
				own.gate.reached();
				await own.gate.released;
			}
			return answer;
		});
		const runs = retirementCalls();
		// The grace ends at 10 s.
		await vi.advanceTimersByTimeAsync(10_001);
		await vi.waitFor(() => expect(read.reached, "precondition: the retirement reached its read of whether the ink file is its own bytes").toBe(true));
		expect(read.answer, "precondition: the retirement found the ink file still the bytes this session read").toBe(true);
		// Writes work again from here: the next save of the ink file can land.
		v.adapter.failWriteTimes = 0;
		const { opening } = await freshOpensDuringHold(s, inked);
		own.hold.release();
		await Promise.allSettled(runs.mock.results.map((r) => r.value as Promise<void>));
		const o = await opening;
		// The open's claim is seen when the read ends, before any move into the trash: the retirement writes the record
		// with the new name alone and moves nothing into the trash (unlike B6, whose open comes after that move began).
		await paneKeepsInk(v, s, inked, o, "opened during the read of the ink file's bytes", v.trashInk());
	});

	// B7, the record let go during that read: the pane that opened on the ink closes, drawn on, and its record is let go
	// as at any pane close (releasePdfId: written, then forgotten; the release waits on reads, not on the retirement).
	// Opened again, the file is read in fresh and drawn on. When the read ends the retirement must count the record held
	// then, not the one it held before the read: a write of that one would set the second open's stroke aside. The
	// state up to the held read is B7's, built the same way.
	it("opened, drawn on and closed while the retirement reads whether the ink file is its own bytes, then opened again and drawn on: every stroke is kept and the file claims the new name alone, also after a relaunch", async () => {
		const v = vault();
		v.files.set("Notes.pdf", doc("notes"));
		const inked = await inkOn(session(v), "Notes.pdf", "ink-0");
		const file = `${INK}/${inked}.json`;
		const legacy = parsePage(v.adapter.files.get(file)!, inked).data;
		delete legacy.pdfPaths;
		v.adapter.files.set(file, serializePage(legacy));
		const s = session(v);
		const dropped = movesDropped();
		vi.useFakeTimers();
		v.adapter.failWriteTimes = Number.MAX_SAFE_INTEGER;
		const adopted = await s.inkAt("Notes.pdf");
		expect({ id: adopted.id, strokes: adopted.strokes }, "precondition: Notes.pdf opened on the ink file that claims no path").toEqual({ id: inked, strokes: ["ink-0"] });
		v.listingFails(Infinity);
		await s.renameFile("Notes.pdf", "Old.pdf");
		expect(dropped(), "precondition: the rename's claim move was not dropped").toBe(0);
		await s.deleteFile("Old.pdf");
		v.listingWorks();
		expect(
			{ file: v.sidecar(inked)?.pdfPaths ?? [], record: s.pdfStore.claimedInstances((i) => i === inked)[0]?.paths ?? [] },
			"precondition: the ink file claims no path, and the record claims the old name alone"
		).toEqual({ file: [], record: ["Notes.pdf"] });
		const own = gated();
		const read = { reached: false, answer: undefined as boolean | undefined };
		const proto = PdfInkStore.prototype as never as { isOwnRevision(...a: unknown[]): Promise<boolean> };
		const isOwnRevision = proto.isOwnRevision;
		vi.spyOn(proto, "isOwnRevision").mockImplementation(async function (this: unknown, ...a: unknown[]) {
			const answer = await isOwnRevision.apply(this, a);
			if (!read.reached) {
				read.reached = true;
				read.answer = answer;
				own.gate.reached();
				await own.gate.released;
			}
			return answer;
		});
		const runs = retirementCalls();
		// The grace ends at 10 s.
		await vi.advanceTimersByTimeAsync(10_001);
		await vi.waitFor(() => expect(read.reached, "precondition: the retirement reached its read of whether the ink file is its own bytes").toBe(true));
		expect(read.answer, "precondition: the retirement found the ink file still the bytes this session read").toBe(true);
		v.adapter.failWriteTimes = 0;
		const { opening } = await freshOpensDuringHold(s, inked);
		const first = await opening;
		expect(first.id, "precondition: the first open showed the ink").toBe(inked);
		s.draw(inked, stroke(30, "ink-1"));
		s.close(first.root);
		s.plugin.releasePdfId(inked);
		await vi.waitFor(() => expect(s.pdfStore.generation(inked), "precondition: the closed pane's record was let go during the held read").toBeNull());
		const second = await s.open("Fresh.pdf");
		expect(
			{ id: second.id, strokes: second.id === undefined ? [] : s.pdfStore.strokes(second.id).map((x) => x.id) },
			"precondition: the second open read the ink in again, with the first open's stroke"
		).toEqual({ id: inked, strokes: ["ink-0", "ink-1"] });
		s.draw(inked, stroke(50, "ink-2"));
		own.hold.release();
		await Promise.allSettled(runs.mock.results.map((r) => r.value as Promise<void>));
		const pane = { strokes: s.pdfStore.strokes(inked).map((x) => x.id), held: s.pdfStore.inkReady(inked) };
		await minuteLater(s);
		const live = { strokes: (v.sidecar(inked)?.strokes ?? []).map((x) => x.id).sort(), claims: [...(v.sidecar(inked)?.pdfPaths ?? [])].sort() };
		const trash = v.trashInk();
		s.close(second.root);
		const next = await session(v).inkAt("Fresh.pdf");
		expect(
			{ pane, live, trash, relaunch: { failed: next.failed, strokes: [...next.strokes].sort() } },
			"closed and opened again during the read of the ink file's bytes: the pane lost a stroke or its record, or the live file does not hold every stroke and claim the new file alone, or the retirement moved the ink file into the trash, or the new file does not open on every stroke after a relaunch"
		).toEqual({
			pane: { strokes: ["ink-0", "ink-1", "ink-2"], held: true },
			live: { strokes: ["ink-0", "ink-1", "ink-2"], claims: ["Fresh.pdf"] },
			trash: [],
			relaunch: { failed: false, strokes: ["ink-0", "ink-1", "ink-2"] },
		});
	});

	// B9: the same held move with no open: the ink goes to the trash as today.
	it("CONTROL: no open while the store moves the ink file into the trash: the ink goes to the trash, and a copy of the same bytes opens blank, also after a relaunch", async () => {
		const v = vault();
		const { inked, s } = await deletedOnOldNameAlone(v);
		const trash = holdTrashMove(v, inked);
		const runs = retirementCalls();
		await vi.advanceTimersByTimeAsync(10_001);
		await vi.waitFor(() => expect(trash.reached(), "precondition: the retirement's remove reached the move into the trash").toBe(true));
		trash.release();
		await Promise.allSettled(runs.mock.results.map((r) => r.value as Promise<void>));
		expect(s.pdfStore.pendingClaims().has("Old.pdf"), "precondition: the deletion ended").toBe(false);
		await minuteLater(s);
		await deletedInkGone(v, s, inked, "no open during the move into the trash");
	});
});
