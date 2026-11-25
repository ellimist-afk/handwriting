/**
 * The ink folder's listing fails. Obsidian's desktop adapter reads the folder, then stats each entry in turn with no
 * catch, so one entry gone between the two (a sync tool's temporary file) rejects the whole listing, with Node's
 * ENOENT for that entry. A folder that is not there rejects too, at the read. Before the fix every PDF reader of the
 * listing took a failed one for an empty folder: an open chose a fresh id that was another copy's live ink file, a
 * changed PDF's carry was cleared as owed for nothing, a deletion ended with its ink still claiming the gone name, and
 * a rename with no pane left its claim on the old name.
 *
 * Wanted: a listing that fails once costs nothing. One that keeps failing never opens a PDF on another file's ink,
 * and is never worse than before for a PDF that has no copy of the same bytes: it opens on its own ink, or blank and
 * able to take a stroke, with no notice. The shipped "could not identify" notice shows only where the open cannot
 * rule out another copy's ink. The deletion waits, the carry stays owed, and the rename's claim moves once the
 * listing works. An absent folder is still an empty one, also when its error carries no code.
 *
 * The look at one ink file fails. Obsidian's `exists` answers false for any failure, and its `stat` rejects for any
 * failure but a file that is not there. Before the fix the read of an ink file's claim took either for "no file": a
 * leave owed at a quit was forgotten at the launch, its found ink left claiming the copy, and a deletion's last look
 * before acting on an ink counted it writable and sent it to the trash. Wanted: a failed look is not "no file". The
 * leave stays owed and runs once the look works; the deletion leaves that ink alone. A file that is gone from every ink
 * folder is still no file, also on a host whose stat rejects for a file that is not there. Left alone, the ink still claims only the deleted PDF, so a deletion that ended there left
 * it for a copy of the same bytes to open on. Wanted: the deletion waits and is tried again, as after a read that
 * failed, and ends once the look works; a copy added meanwhile opens blank, also after a relaunch. A file that is there
 * and cannot be read, or one a newer version wrote, is left alone, and its deletion ends, as before.
 *
 * Harness: the one in PdfCarryRenamedOntoDeleted.test.ts, through the plugin and the real stores on an in-memory vault.
 * The adapter's list() fails as the host's does: a folder with no file in it rejects ENOENT at the read, and a listing
 * of the live ink folder can be made to reject with the ENOENT of an entry that went away. A relaunch is a new plugin
 * session over the same vault.
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
import { parsePage, READ_SCHEMA_VERSION, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

/** The notice every caller of an identification shows when it fails (PdfClaims, the shipped text). */
const NOT_IDENTIFIED = "Handwriting: could not identify this PDF - ink is disabled for it. Reopening the file retries.";
const CARRIED_NOTICE = "Handwriting: this PDF changed on disk. Your ink was carried over to its new version.";
const INK = ".handwriting";
/** Where the owed leaves are saved across a quit (PdfClaims, the device-local key). */
const OWED_KEY = "handwriting-pdf-owed-leaves";
/**
 * The designed refusal of an open that cannot rule out another copy's ink because the ink folder would not list: the
 * error the listing raised, carried out of the open. Any other throw (a TypeError from a broken step) is not it.
 */
const LISTING_FAILED = /^could not list the ink folder /;

/** An open refused as designed: that error, no id for the pane. */
function refusedAsDesigned(there: { id: string | undefined; failed: boolean; error: unknown }) {
	expect(there.failed, "precondition: the open was refused").toBe(true);
	expect(there.error, "the open was refused by something other than an error").toBeInstanceOf(Error);
	expect((there.error as Error).message, "the open was refused by another error than the failed listing's").toMatch(LISTING_FAILED);
	expect(there.id, "a refused open gave the pane an ink id").toBeUndefined();
}

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
	adapter.list = async (folder: string) => {
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
	return { adapter, files, local, sidecar, trashInk, listingFails, listingWorks, failing, absent, claims, trashed };
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
	const app = {
		vault: {
			adapter: v.adapter,
			// Each with its size, as the vault keeps it for every file.
			getFiles: () => [...v.files.entries()].map(([path, bytes]) => ({ path, extension: "pdf", stat: { size: bytes.length } })),
			readBinary: async (file: { path: string }) => {
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
	/** The vault moves the file and its bytes, then every rename handler the plugin registered runs, and any claim move it started. */
	async function renameFile(from: string, to: string) {
		const bytes = v.files.get(from);
		expect(bytes, `precondition: ${from} exists before the rename`).toBeDefined();
		v.files.delete(from);
		v.files.set(to, bytes!);
		for (const handler of vaultOn.get("rename") ?? []) await handler(pdfFile(to), from);
		await Promise.all(moves.splice(0));
		await store.flush();
	}
	/** Open `path`, read the ink it shows, close it. */
	async function inkAt(path: string): Promise<{ id: string | undefined; strokes: string[]; failed: boolean; error: unknown }> {
		const o = await open(path);
		const strokes = o.id === undefined ? [] : pdfStore.strokes(o.id).map((x) => x.id);
		close(o.root);
		return { id: o.id, strokes, failed: o.failed, error: o.error };
	}
	return { app, store, pdfStore, plugin, open, close, draw, deleteFile, createFile, renameFile, inkAt };
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

/** A.pdf and B.pdf, the same bytes (two copies of one template), each inked in one session: B's ink is the second instance. */
async function twoInkedCopies(v: Vault) {
	v.files.set("A.pdf", doc("template"));
	v.files.set("B.pdf", doc("template"));
	const first = session(v);
	const a = await inkOn(first, "A.pdf", "on-a");
	const b = await inkOn(first, "B.pdf", "on-b", 40);
	expect(b, "precondition: the two copies share one ink id").not.toBe(a);
	return { a, b };
}

/** Run every grace out and let each retirement finish. */
async function settleGrace(s: Session) {
	await vi.advanceTimersByTimeAsync(10_001);
	await s.store.flush();
}

describe("the ink folder's listing fails at an open", () => {
	it("once: the copy opens on its own ink, with no notice, and the other copy's ink file does not take its name", async () => {
		const v = vault();
		const { a, b } = await twoInkedCopies(v);
		const s = session(v);
		v.listingFails(1);
		shown.length = 0;
		const there = await s.inkAt("B.pdf");
		expect(v.failing.left, "precondition: the listing failed at the open").toBe(0);
		expect(there.failed, "a listing that failed once made the open fail").toBe(false);
		expect(shown, "a listing that failed once showed a notice").toEqual([]);
		expect(there.id, "the copy opened on another ink than its own").toBe(b);
		expect(there.strokes, "the copy opened without its own stroke, or with the other copy's").toEqual(["on-b"]);
		expect(v.sidecar(a)?.pdfPaths ?? [], "the other copy's ink file took the copy's name").not.toContain("B.pdf");
		expect((await session(v).inkAt("A.pdf")).strokes, "the other copy lost its ink").toEqual(["on-a"]);
	});

	// The copy's ink is the family's second and claims it: looked up by name, it rules the other copy's ink out.
	it("again and again: the copy whose ink is the family's second opens on it, found by name, with no notice, never on the other copy's ink, and keeps it once the listing works", async () => {
		const v = vault();
		const { a, b } = await twoInkedCopies(v);
		const s = session(v);
		v.listingFails(Infinity);
		shown.length = 0;
		const calls = v.failing.calls;
		const there = await s.inkAt("B.pdf");
		expect(v.failing.calls, "precondition: the open listed the ink folder").toBeGreaterThan(calls);
		expect(there.strokes, "the copy opened wearing the other copy's stroke").not.toContain("on-a");
		expect(there.failed, "a listing that keeps failing made the open of a copy whose ink claims it fail").toBe(false);
		expect(shown, "a listing that keeps failing showed a notice for a copy whose ink claims it").toEqual([]);
		expect(there.id, "the copy opened on another ink than its own").toBe(b);
		expect(there.strokes, "the copy opened without its own stroke").toEqual(["on-b"]);
		expect(v.sidecar(a)?.pdfPaths ?? [], "the other copy's ink file took the copy's name").not.toContain("B.pdf");
		v.listingWorks();
		const again = await s.inkAt("B.pdf");
		expect(again.id, "opened again with the listing working, the copy opened on another ink than its own").toBe(b);
		expect(again.strokes, "opened again with the listing working, the copy opened without its own stroke").toEqual(["on-b"]);
		expect(v.sidecar(a)?.pdfPaths ?? [], "the other copy's ink file took the copy's name").not.toContain("B.pdf");
	});

	// The copy's ink past a gap in the family is found by the listing alone: a lookup by name stops at the gap. Listed
	// once more, it is found, as when the listing works.
	it("once, the copy's ink past a gap in the family (its second gone to the trash): it opens on its own ink, with no notice", async () => {
		const v = vault();
		v.files.set("A.pdf", doc("template"));
		v.files.set("X.pdf", doc("template"));
		v.files.set("B.pdf", doc("template"));
		const first = session(v);
		const a = await inkOn(first, "A.pdf", "on-a");
		const x = await inkOn(first, "X.pdf", "on-x", 25);
		const b = await inkOn(first, "B.pdf", "on-b", 40);
		expect([x, b], "precondition: the copies took the second and third ids").toEqual([`${a}-2`, `${a}-3`]);
		v.trashed("X.pdf", x);
		const s = session(v);
		v.listingFails(1);
		shown.length = 0;
		const there = await s.inkAt("B.pdf");
		expect(v.failing.left, "precondition: the listing failed at the open").toBe(0);
		expect(there.failed, "a listing that failed once made the open of a copy past a gap fail").toBe(false);
		expect(shown, "a listing that failed once showed a notice for a copy past a gap").toEqual([]);
		expect(there.id, "past the gap, the copy opened on another ink than its own").toBe(b);
		expect(there.strokes, "past the gap, the copy opened without its own stroke, or with another's").toEqual(["on-b"]);
		expect(v.sidecar(a)?.pdfPaths ?? [], "the family's first took the copy's name").not.toContain("B.pdf");
		expect(v.sidecar(x), "the trashed ink came back out of the trash").toBeUndefined();
	});
});

describe.each(["desktop", "mobile"] as const)("the ink folder's listing keeps failing, on the %s host", (host) => {
	it("a PDF whose own ink is the family's first: it still opens on that ink, with no notice", async () => {
		const v = vault(host);
		const { a } = await twoInkedCopies(v);
		const s = session(v);
		v.listingFails(Infinity);
		shown.length = 0;
		const there = await s.inkAt("A.pdf");
		expect(v.failing.calls, "precondition: the open listed the ink folder").toBeGreaterThan(0);
		expect(there.failed, "a listing that keeps failing made the open of the family's first fail").toBe(false);
		expect(shown, "a listing that keeps failing showed a notice for the family's first").toEqual([]);
		expect(there.id, "the family's first opened on another ink than its own").toBe(a);
		expect(there.strokes, "the family's first opened without its own stroke, or with the other copy's").toEqual(["on-a"]);
		v.listingWorks();
		expect((await s.inkAt("A.pdf")).id, "opened again with the listing working, it opened on another ink than its own").toBe(a);
	});

	it("a family with a gap (its second ink gone to the trash, its third claiming this PDF): it opens on the third, or says it could not identify the PDF, never on a fresh second", async () => {
		const v = vault(host);
		v.files.set("A.pdf", doc("template"));
		v.files.set("X.pdf", doc("template"));
		v.files.set("B.pdf", doc("template"));
		const first = session(v);
		const a = await inkOn(first, "A.pdf", "on-a");
		const x = await inkOn(first, "X.pdf", "on-x", 25);
		const b = await inkOn(first, "B.pdf", "on-b", 40);
		expect([x, b], "precondition: the copies took the second and third ids").toEqual([`${a}-2`, `${a}-3`]);
		// X.pdf was deleted and its ink went to the trash: the second id is free, the third still claims B.
		v.trashed("X.pdf", x);
		v.listingFails(Infinity);
		shown.length = 0;
		const s = session(v);
		const before = v.claims();
		const there = await s.inkAt("B.pdf");
		expect(v.failing.calls, "precondition: the open listed the ink folder").toBeGreaterThan(0);
		if (there.failed) {
			expect(shown, "the open failed without the shipped notice").toContain(NOT_IDENTIFIED);
			refusedAsDesigned(there);
			expect(v.claims(), "a refused open changed an ink file's claims").toEqual(before);
		} else {
			expect(there.id, "past the gap, the copy opened on another ink than its own").toBe(b);
			expect(there.strokes, "past the gap, the copy opened without its own stroke").toEqual(["on-b"]);
		}
		expect(v.sidecar(x)?.pdfPaths ?? [], "a fresh second ink file took the copy's name").not.toContain("B.pdf");
		expect(v.sidecar(a)?.pdfPaths ?? [], "the family's first took the copy's name").not.toContain("B.pdf");
		v.listingWorks();
		const again = await session(v).inkAt("B.pdf");
		expect(again.id, "once the listing works, the copy opened on another ink than its own").toBe(b);
		expect(again.strokes, "once the listing works, the copy opened without its own stroke").toEqual(["on-b"]);
	});

	it("an inked PDF with no copy of the same bytes opens on its own ink, with no notice, also after the next launch", async () => {
		const v = vault(host);
		v.files.set("Lone.pdf", doc("lone"));
		const own = await inkOn(session(v), "Lone.pdf", "on-lone");
		v.listingFails(Infinity);
		shown.length = 0;
		const calls = v.failing.calls;
		const there = await session(v).inkAt("Lone.pdf");
		expect(v.failing.calls, "precondition: the open listed the ink folder").toBeGreaterThan(calls);
		expect(there.failed, "a listing that keeps failing made the open fail").toBe(false);
		expect(shown, "a listing that keeps failing showed a notice for a PDF with no copy").toEqual([]);
		expect(there.id, "the PDF opened on another ink than its own").toBe(own);
		expect(there.strokes, "the PDF opened without its own stroke").toEqual(["on-lone"]);
		const again = await session(v).inkAt("Lone.pdf");
		expect(shown, "after the next launch, a listing that keeps failing showed a notice").toEqual([]);
		expect(again.strokes, "after the next launch, the PDF opened without its own stroke").toEqual(["on-lone"]);
	});

	// The limit, as in 1.5.1: opened blank on the family's name while the listing fails, a stroke drawn then makes a
	// second ink file claiming X, and once the listing works whichever of the two is listed first is shown
	// (PdfIdentity.chooseInstance). Not pinned here; the open itself is.
	it("a lone PDF whose ink is the family's second, the family's own file in the trash: it opens on that ink or blank, never on the trashed ink, with no notice, and keeps its ink once the listing works", async () => {
		const v = vault(host);
		v.files.set("A.pdf", doc("template"));
		v.files.set("X.pdf", doc("template"));
		const first = session(v);
		const a = await inkOn(first, "A.pdf", "on-a");
		const x = await inkOn(first, "X.pdf", "on-x", 25);
		expect(x, "precondition: X took the family's second id").toBe(`${a}-2`);
		// A.pdf was deleted and its ink went to the trash: X is the family's only PDF, its ink past a gap at the family name.
		v.trashed("A.pdf", a);
		v.listingFails(Infinity);
		shown.length = 0;
		const calls = v.failing.calls;
		const there = await session(v).inkAt("X.pdf");
		expect(v.failing.calls, "precondition: the open listed the ink folder").toBeGreaterThan(calls);
		expect(there.failed, "a listing that keeps failing made the open of a PDF with no copy fail").toBe(false);
		expect(shown, "a listing that keeps failing showed a notice for a PDF with no copy").toEqual([]);
		expect(there.strokes, "the PDF opened wearing the trashed ink of the deleted copy").not.toContain("on-a");
		if (there.id === x) expect(there.strokes, "on its own ink, the PDF opened without its own stroke").toEqual(["on-x"]);
		else expect(there.strokes, "opened blank, the PDF showed strokes").toEqual([]);
		expect(v.sidecar(a), "the trashed ink came back out of the trash").toBeUndefined();
		v.listingWorks();
		const again = await session(v).inkAt("X.pdf");
		expect(again.id, "once the listing works, the PDF opened on another ink than its own").toBe(x);
		expect(again.strokes, "once the listing works, the PDF opened without its own stroke").toEqual(["on-x"]);
	});

	it("a PDF with no ink yet, the ink folder holding another document's ink: it opens blank, takes a stroke, and keeps it once the listing works", async () => {
		const v = vault(host);
		v.files.set("Other.pdf", doc("other"));
		v.files.set("Fresh.pdf", doc("fresh"));
		await inkOn(session(v), "Other.pdf", "on-other");
		v.listingFails(Infinity);
		shown.length = 0;
		const s = session(v);
		const calls = v.failing.calls;
		const o = await s.open("Fresh.pdf");
		expect(v.failing.calls, "precondition: the open listed the ink folder").toBeGreaterThan(calls);
		expect(o.failed, "a listing that keeps failing made the open fail").toBe(false);
		expect(shown, "a listing that keeps failing showed a notice for a PDF with no ink and no copy").toEqual([]);
		expect(o.id, "the PDF opened with no ink id to take a stroke").toBeDefined();
		expect(s.pdfStore.strokes(o.id!), "the PDF opened wearing another document's ink").toEqual([]);
		s.draw(o.id!, stroke(10, "on-fresh"));
		await s.store.flush();
		s.close(o.root);
		v.listingWorks();
		const later = session(v);
		expect((await later.inkAt("Fresh.pdf")).strokes, "once the listing works, the PDF lost its stroke").toEqual(["on-fresh"]);
		expect((await later.inkAt("Other.pdf")).strokes, "the other document lost its ink").toEqual(["on-other"]);
	});

	// Ink found by name that no file in the vault claims, or that claims no path, is the ink of a file renamed or moved
	// while Obsidian was closed, or written before claims were kept. With no other PDF of the same bytes in the vault, no
	// other file could be its. Another document of the same size sits beside it: only its bytes tell it from a copy.
	it.each([
		["renamed while Obsidian was closed, its ink still claiming the old name", "renamed"],
		["whose ink file claims no path, as one written before claims were kept", "claimless"],
	] as const)("a PDF with no copy of the same bytes, %s, opened in the next session: it opens on its own ink, with no notice, and keeps it once the listing works", async (_label, how) => {
		const v = vault(host);
		v.files.set("Paper.pdf", doc("paper"));
		v.files.set("Other.pdf", doc("pap3r"));
		expect(v.files.get("Other.pdf")!.length, "precondition: the other document has the same size").toBe(v.files.get("Paper.pdf")!.length);
		const own = await inkOn(session(v), "Paper.pdf", "ink-0");
		let path = "Paper.pdf";
		if (how === "renamed") {
			path = "Paper final.pdf";
			v.files.set(path, v.files.get("Paper.pdf")!);
			v.files.delete("Paper.pdf");
			expect(v.sidecar(own)?.pdfPaths ?? [], "precondition: the ink still claims the old name").toEqual(["Paper.pdf"]);
		} else {
			const file = `${INK}/${own}.json`;
			const page = parsePage(v.adapter.files.get(file)!, own).data;
			v.adapter.files.set(file, serializePage({ ...page, pdfPaths: [] }));
			expect(v.sidecar(own)?.pdfPaths ?? [], "precondition: the ink file claims no path").toEqual([]);
		}
		v.listingFails(Infinity);
		shown.length = 0;
		const calls = v.failing.calls;
		const there = await session(v).inkAt(path);
		expect(v.failing.calls, "precondition: the open listed the ink folder").toBeGreaterThan(calls);
		expect(there.failed, "a listing that keeps failing made the open of a PDF with no copy fail").toBe(false);
		expect(shown, "a listing that keeps failing showed a notice for a PDF with no copy").toEqual([]);
		expect(there.id, "the PDF opened on another ink than its own").toBe(own);
		expect(there.strokes, "the PDF opened without its own stroke").toEqual(["ink-0"]);
		v.listingWorks();
		const again = await session(v).inkAt(path);
		expect(again.id, "once the listing works, the PDF opened on another ink than its own").toBe(own);
		expect(again.strokes, "once the listing works, the PDF opened without its own stroke").toEqual(["ink-0"]);
	});

	// The guard on that: a copy of the same bytes in the vault, the family's ink claiming only a name no file has. By name
	// alone that is what a renamed file's ink looks like to every copy, so another copy never takes it.
	it("two copies of the same bytes, one renamed while Obsidian was closed, its ink still claiming the old name: the other copy, opened in the next session, opens blank or says it could not identify the PDF, never on the renamed copy's ink, and no ink file takes its name", async () => {
		const v = vault(host);
		v.files.set("X.pdf", doc("template"));
		v.files.set("Y.pdf", doc("template"));
		const x = await inkOn(session(v), "X.pdf", "on-x");
		v.files.set("X2.pdf", v.files.get("X.pdf")!);
		v.files.delete("X.pdf");
		expect(v.sidecar(x)?.pdfPaths ?? [], "precondition: the renamed copy's ink still claims the old name").toEqual(["X.pdf"]);
		v.listingFails(Infinity);
		shown.length = 0;
		const before = v.claims();
		const calls = v.failing.calls;
		const there = await session(v).inkAt("Y.pdf");
		expect(v.failing.calls, "precondition: the open listed the ink folder").toBeGreaterThan(calls);
		expect(there.id, "the other copy opened on the renamed copy's ink").not.toBe(x);
		expect(there.strokes, "the other copy opened wearing strokes, the renamed copy's or any").toEqual([]);
		if (there.failed) {
			expect(shown, "the open failed without the shipped notice").toContain(NOT_IDENTIFIED);
			refusedAsDesigned(there);
		}
		expect(v.claims(), "an ink file took the other copy's name, or another claim changed").toEqual(before);
		v.listingWorks();
		const renamed = await session(v).inkAt("X2.pdf");
		expect(renamed.id, "once the listing works, the renamed copy opened on another ink than its own").toBe(x);
		expect(renamed.strokes, "once the listing works, the renamed copy lost its ink").toEqual(["on-x"]);
	});

	// The same, the renamed copy unreadable at its new name: a PDF of the same size that cannot be read is not ruled out
	// as a copy, so the other copy never adopts the ink found by name.
	it("two copies of the same bytes, one renamed while Obsidian was closed and unreadable at its new name: the other copy opens blank or says it could not identify the PDF, never on the renamed copy's ink, and no claim changes", async () => {
		const v = vault(host);
		v.files.set("X.pdf", doc("template"));
		v.files.set("Y.pdf", doc("template"));
		const x = await inkOn(session(v), "X.pdf", "on-x");
		v.files.set("X2.pdf", v.files.get("X.pdf")!);
		v.files.delete("X.pdf");
		expect(v.sidecar(x)?.pdfPaths ?? [], "precondition: the renamed copy's ink still claims the old name").toEqual(["X.pdf"]);
		const s = session(v);
		const read = s.app.vault.readBinary.bind(s.app.vault);
		let blocked = 0;
		s.app.vault.readBinary = async (file: { path: string }) => {
			if (file.path === "X2.pdf") {
				blocked++;
				throw new Error("EBUSY injected");
			}
			return read(file);
		};
		v.listingFails(Infinity);
		shown.length = 0;
		const before = v.claims();
		const there = await s.inkAt("Y.pdf");
		expect(blocked, "precondition: the open tried to read the renamed copy").toBeGreaterThan(0);
		expect(there.id, "the other copy opened on the renamed copy's ink").not.toBe(x);
		expect(there.strokes, "the other copy opened wearing strokes, the renamed copy's or any").toEqual([]);
		if (there.failed) {
			expect(shown, "the open failed without the shipped notice").toContain(NOT_IDENTIFIED);
			refusedAsDesigned(there);
		}
		expect(v.claims(), "an ink file took the other copy's name, or another claim changed").toEqual(before);
	});
});

describe("the ink folder's listing fails behind an open, a deletion or a rename", () => {
	it("a deletion whose grace ends while the listing fails: it keeps waiting, saved, and once the listing works its ink goes to the trash and a copy of the same bytes opens blank", async () => {
		const v = vault();
		v.files.set("Notes.pdf", doc("notes"));
		const inked = await inkOn(session(v), "Notes.pdf", "ink-0");
		// The next launch: the PDF is deleted while no pane shows it, and the listing fails when its grace ends.
		const s = session(v);
		vi.useFakeTimers();
		await s.deleteFile("Notes.pdf");
		v.listingFails(Infinity);
		await settleGrace(s);
		expect(v.failing.calls, "precondition: the grace's end listed the ink folder").toBeGreaterThan(0);
		expect(s.pdfStore.pendingClaims().size, "the deletion ended while the listing failed").toBe(1);
		expect(v.local.get("handwriting-pdf-pending-deletes") ?? null, "the waiting deletion is not saved").not.toBeNull();
		expect(v.sidecar(inked)?.strokes.map((x) => x.id), "the deleted PDF's ink file was lost while the listing failed").toEqual(["ink-0"]);
		v.listingWorks();
		await settleGrace(s);
		await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
		await s.store.flush();
		expect(v.sidecar(inked), "once the listing worked, the deleted PDF's ink file is still outside the trash").toBeUndefined();
		expect(v.trashInk(), "the trash holds the deleted PDF's ink, strokes whole, and nothing else").toEqual([["ink-0"]]);
		vi.useRealTimers();
		await s.createFile("Notes again.pdf", doc("notes"));
		const later = await session(v).inkAt("Notes again.pdf");
		// The ink id is the bytes' own: with the deleted PDF's ink in the trash, the copy takes the family's name again, blank.
		expect(later.strokes, "a copy of the same bytes opened wearing the deleted PDF's ink").toEqual([]);
		expect(v.sidecar(inked)?.strokes ?? [], "the copy's open brought the deleted PDF's ink back out of the trash").toEqual([]);
		expect(v.trashInk(), "the copy's open changed the trashed ink").toEqual([["ink-0"]]);
	});

	it("a PDF changed on disk while closed, opened with its carry's listing failing: the carry stays owed, and once the listing works it opens with its ink carried over", async () => {
		const v = vault();
		v.files.set("Report.pdf", doc("version 1"));
		await inkOn(session(v), "Report.pdf", "ink-0");
		// While closed, another program saves a new version over it.
		v.files.set("Report.pdf", doc("version 2"));
		const s = session(v);
		// The open's own listing works; every later one fails (the carry's).
		const before = v.failing.calls;
		const realList = v.adapter.list.bind(v.adapter);
		v.adapter.list = async (folder: string) => {
			if (folder === INK && v.failing.calls === before + 1) v.listingFails(Infinity);
			return realList(folder);
		};
		shown.length = 0;
		const first = await s.inkAt("Report.pdf");
		expect(v.failing.calls, "precondition: the carry listed the ink folder after the open did").toBeGreaterThan(before + 1);
		// The open's own listing worked, so the open stands; only the carry waits.
		expect(first.failed, "the carry's failed listing made the open fail").toBe(false);
		expect(first.strokes, "with the carry's listing failing, the new version opened wearing ink").toEqual([]);
		expect(shown, "with the carry's listing failing, it said the ink was carried over").not.toContain(CARRIED_NOTICE);
		v.adapter.list = realList;
		v.listingWorks();
		shown.length = 0;
		const again = await s.inkAt("Report.pdf");
		expect(again.strokes, "once the listing worked, it opened without its older version's ink").toEqual(["ink-0"]);
		expect(shown, "once the listing worked, it did not say the ink was carried over").toContain(CARRIED_NOTICE);
		const later = await session(v).inkAt("Report.pdf");
		expect(later.strokes, "after the next launch it opened without its older version's ink").toEqual(["ink-0"]);
	});

	it("a PDF renamed in Obsidian while no pane shows it, the listing failing: once the listing works its claim moves, and a copy of the same bytes at the old name opens blank", async () => {
		const v = vault();
		v.files.set("Paper.pdf", doc("paper"));
		const inked = await inkOn(session(v), "Paper.pdf", "ink-0");
		const s = session(v);
		vi.useFakeTimers();
		v.listingFails(Infinity);
		const calls = v.failing.calls;
		await s.renameFile("Paper.pdf", "Paper final.pdf");
		expect(v.failing.calls, "precondition: the rename's claim move listed the ink folder").toBeGreaterThan(calls);
		v.listingWorks();
		await vi.advanceTimersByTimeAsync(60_000);
		// The retried move reads the PDF's bytes and hashes them off the timer queue: waited for, not taken as done.
		await vi.waitFor(async () => {
			await s.store.flush();
			expect(v.sidecar(inked)?.pdfPaths ?? [], "once the listing worked, the ink file does not claim the new name").toContain("Paper final.pdf");
		});
		vi.useRealTimers();
		expect(v.sidecar(inked)?.pdfPaths ?? [], "once the listing worked, the ink file still claims the old name").not.toContain("Paper.pdf");
		await s.createFile("Paper.pdf", doc("paper"));
		const copy = await s.inkAt("Paper.pdf");
		expect(copy.id, "a copy of the same bytes at the old name opened on the renamed PDF's ink file").not.toBe(inked);
		expect(copy.strokes, "a copy of the same bytes at the old name opened wearing the renamed PDF's ink").toEqual([]);
		expect((await s.inkAt("Paper final.pdf")).strokes, "the renamed PDF lost its ink").toEqual(["ink-0"]);
	});

	// The two copies' twin: the renamed copy's ink is the family's second, so a claim move that took ink found by name
	// for the whole family would find only the first, which claims the other copy, and move nothing.
	it.each([
		["the family's first beside it", false],
		["the family's own file in the trash", true],
	] as const)("a copy of the same bytes renamed while no pane shows it, the listing failing, %s: once the listing works its own ink claims the new name", async (_label, firstTrashed) => {
		const v = vault();
		const { a, b } = await twoInkedCopies(v);
		if (firstTrashed) v.trashed("A.pdf", a);
		const s = session(v);
		vi.useFakeTimers();
		v.listingFails(Infinity);
		const calls = v.failing.calls;
		await s.renameFile("B.pdf", "B final.pdf");
		expect(v.failing.calls, "precondition: the rename's claim move listed the ink folder").toBeGreaterThan(calls);
		v.listingWorks();
		await vi.advanceTimersByTimeAsync(60_000);
		// The retried move reads the PDF's bytes and hashes them off the timer queue: waited for, not taken as done.
		await vi.waitFor(async () => {
			await s.store.flush();
			expect(v.sidecar(b)?.pdfPaths ?? [], "once the listing worked, the copy's ink file does not claim the new name").toContain("B final.pdf");
		});
		vi.useRealTimers();
		expect(v.sidecar(b)?.pdfPaths ?? [], "once the listing worked, the copy's ink file still claims the old name").not.toContain("B.pdf");
		if (!firstTrashed) expect(v.sidecar(a)?.pdfPaths ?? [], "the other copy's ink file took a claim of the renamed copy").toEqual(["A.pdf"]);
		else expect(v.sidecar(a), "the trashed ink came back out of the trash").toBeUndefined();
		const renamed = await session(v).inkAt("B final.pdf");
		expect(renamed.id, "the renamed copy opened on another ink than its own").toBe(b);
		expect(renamed.strokes, "the renamed copy lost its ink").toEqual(["on-b"]);
	});
});

describe("the ink folder's listing still fails while a rename waits, a leave is owed, or a deletion waits", () => {
	// A rename with no pane waits for the listing to move its claim, so the ink still claims the old name. The file the
	// rename moved is the one that name was: the ink found by name that claims it is that file's own, and no other's.
	it.each([
		["with no copy of the same bytes", false],
		["beside a copy of the same bytes", true],
	] as const)("a PDF renamed in Obsidian while no pane shows it, %s, opened at its new name while the listing still fails: it opens on its own ink, with no notice, and once the listing works its claim moves", async (_label, withCopy) => {
		const v = vault();
		let own: string;
		let from: string;
		let to: string;
		let mine: string;
		let copy: { id: string; path: string; stroke: string } | undefined;
		if (withCopy) {
			const { a, b } = await twoInkedCopies(v);
			[own, from, to, mine] = [a, "A.pdf", "A final.pdf", "on-a"];
			copy = { id: b, path: "B.pdf", stroke: "on-b" };
		} else {
			v.files.set("Paper.pdf", doc("paper"));
			own = await inkOn(session(v), "Paper.pdf", "ink-0");
			[from, to, mine] = ["Paper.pdf", "Paper final.pdf", "ink-0"];
		}
		const s = session(v);
		vi.useFakeTimers();
		v.listingFails(Infinity);
		const calls = v.failing.calls;
		await s.renameFile(from, to);
		expect(v.failing.calls, "precondition: the rename's claim move listed the ink folder").toBeGreaterThan(calls);
		expect(v.sidecar(own)?.pdfPaths ?? [], "precondition: the claim move waits, the ink still claims the old name").toEqual([from]);
		shown.length = 0;
		const there = await s.inkAt(to);
		expect(there.failed, "a listing that keeps failing made the open of the renamed PDF fail").toBe(false);
		expect(shown, "a listing that keeps failing showed a notice for the renamed PDF").toEqual([]);
		expect(there.id, "the renamed PDF opened on another ink than its own").toBe(own);
		expect(there.strokes, "the renamed PDF opened without its own stroke").toEqual([mine]);
		if (copy) expect(v.sidecar(copy.id)?.pdfPaths ?? [], "the copy's ink file took the renamed PDF's name").toEqual([copy.path]);
		v.listingWorks();
		await vi.advanceTimersByTimeAsync(60_000);
		// The retried move reads the PDF's bytes and hashes them off the timer queue: waited for, not taken as done.
		await vi.waitFor(async () => {
			await s.store.flush();
			expect(v.sidecar(own)?.pdfPaths ?? [], "once the listing worked, the ink file still claims the old name").not.toContain(from);
		});
		vi.useRealTimers();
		expect(v.sidecar(own)?.pdfPaths ?? [], "once the listing worked, the ink file does not claim the new name alone").toEqual([to]);
		const later = session(v);
		expect((await later.inkAt(to)).strokes, "after the next launch the renamed PDF lost its ink").toEqual([mine]);
		if (copy) {
			const other = await later.inkAt(copy.path);
			expect(other.id, "after the next launch the copy opened on another ink than its own").toBe(copy.id);
			expect(other.strokes, "after the next launch the copy lost its ink").toEqual([copy.stroke]);
		}
	});

	// The family's first is stale ink of the same bytes: a copy's deleted while Obsidian was closed, claiming a name no
	// file has, or ink claiming no path. Found by name, it would be adopted before the renamed PDF's own ink, the second.
	// No other PDF of those bytes is in the vault, so the open never says it could not identify the PDF.
	it.each([
		["the family's first the ink of a copy deleted while Obsidian was closed", "deleted"],
		["the family's first ink claiming no path", "claimless"],
	] as const)("a lone PDF renamed in Obsidian while no pane shows it, %s, opened at its new name while the listing still fails: it opens on its own ink, with no notice", async (_label, how) => {
		const v = vault();
		v.files.set("Old.pdf", doc("template"));
		v.files.set("Paper.pdf", doc("template"));
		const first = session(v);
		const old = await inkOn(first, "Old.pdf", "on-old");
		const own = await inkOn(first, "Paper.pdf", "on-p", 40);
		expect(own, "precondition: the PDF's own ink is the family's second").toBe(`${old}-2`);
		v.files.delete("Old.pdf");
		if (how === "claimless") {
			const f = `${INK}/${old}.json`;
			const page = parsePage(v.adapter.files.get(f)!, old).data;
			v.adapter.files.set(f, serializePage({ ...page, pdfPaths: [] }));
			expect(v.sidecar(old)?.pdfPaths ?? [], "precondition: the family's first claims no path").toEqual([]);
		} else {
			expect(v.sidecar(old)?.pdfPaths ?? [], "precondition: the family's first claims the deleted copy").toEqual(["Old.pdf"]);
		}
		const s = session(v);
		vi.useFakeTimers();
		v.listingFails(Infinity);
		await s.renameFile("Paper.pdf", "Paper final.pdf");
		expect(v.sidecar(own)?.pdfPaths ?? [], "precondition: the claim move waits, the ink still claims the old name").toEqual(["Paper.pdf"]);
		expect([...v.files.keys()], "precondition: no other PDF in the vault").toEqual(["Paper final.pdf"]);
		shown.length = 0;
		const calls = v.failing.calls;
		const there = await s.inkAt("Paper final.pdf");
		expect(v.failing.calls, "precondition: the open listed the ink folder").toBeGreaterThan(calls);
		expect(there.failed, "a listing that keeps failing made the open of a lone renamed PDF fail").toBe(false);
		expect(shown, "a listing that keeps failing showed a notice for a lone renamed PDF").toEqual([]);
		expect(there.id, "the renamed PDF opened on another ink than its own").toBe(own);
		expect(there.strokes, "the renamed PDF opened without its own stroke").toEqual(["on-p"]);
	});

	// Renamed onto the very name of a copy of the same bytes deleted while Obsidian was closed, whose ink still claims that
	// name: by its claims alone, that ink is the one for the new name. Opened while the listing still fails, the PDF opens on
	// its own ink or blank, with no notice, never on the deleted copy's ink. Both orders of the two inks in the family.
	it.each([
		["its own ink the family's first, the deleted copy's the second", "own-first"],
		["the deleted copy's ink the family's first, its own the second", "stale-first"],
	] as const)("a lone PDF renamed in Obsidian while no pane shows it onto the name of a copy deleted while Obsidian was closed, %s, opened while the listing still fails: never on the deleted copy's ink", async (_label, order) => {
		const v = vault();
		v.files.set("A.pdf", doc("template"));
		v.files.set("X.pdf", doc("template"));
		const first = session(v);
		let own: string;
		let stale: string;
		if (order === "own-first") {
			own = await inkOn(first, "A.pdf", "on-a");
			stale = await inkOn(first, "X.pdf", "on-x", 40);
		} else {
			stale = await inkOn(first, "X.pdf", "on-x");
			own = await inkOn(first, "A.pdf", "on-a", 40);
		}
		expect(own, "precondition: two inks").not.toBe(stale);
		expect(v.sidecar(stale)?.pdfPaths ?? [], "precondition: the copy's ink claims X.pdf").toEqual(["X.pdf"]);
		v.files.delete("X.pdf");
		const s = session(v);
		vi.useFakeTimers();
		v.listingFails(Infinity);
		await s.renameFile("A.pdf", "X.pdf");
		expect(v.sidecar(own)?.pdfPaths ?? [], "precondition: the claim move waits, the ink still claims the old name").toEqual(["A.pdf"]);
		expect([...v.files.keys()], "precondition: no other PDF in the vault").toEqual(["X.pdf"]);
		shown.length = 0;
		const there = await s.inkAt("X.pdf");
		expect(there.strokes, "the renamed PDF opened on the deleted copy's ink").not.toContain("on-x");
		expect(there.failed, "a listing that keeps failing made the open of a lone renamed PDF fail").toBe(false);
		expect(shown, "a listing that keeps failing showed a notice for a lone renamed PDF").toEqual([]);
		if (there.strokes.length > 0) expect(there.id, "the renamed PDF opened on another ink than its own").toBe(own);
	});

	// The guard on that: the renamed copy's ink claims a name no file has, which by name alone is what an ink whose file
	// was renamed looks like to every other copy too.
	it("two copies of the same bytes, one renamed while no pane shows it, the listing failing: the other copy, opened while it still fails, opens on its own ink or says it could not identify the PDF, never on the renamed copy's ink", async () => {
		const v = vault();
		const { a, b } = await twoInkedCopies(v);
		const s = session(v);
		vi.useFakeTimers();
		v.listingFails(Infinity);
		await s.renameFile("A.pdf", "A2.pdf");
		expect(v.sidecar(a)?.pdfPaths ?? [], "precondition: the claim move waits, the renamed copy's ink still claims the old name").toEqual(["A.pdf"]);
		shown.length = 0;
		const before = v.claims();
		const there = await s.inkAt("B.pdf");
		expect(there.id, "the other copy opened on the renamed copy's ink").not.toBe(a);
		expect(there.strokes, "the other copy opened wearing the renamed copy's stroke").not.toContain("on-a");
		if (there.failed) {
			expect(shown, "the open failed without the shipped notice").toContain(NOT_IDENTIFIED);
			refusedAsDesigned(there);
			expect(v.claims(), "a refused open changed an ink file's claims").toEqual(before);
		} else {
			expect(there.id, "the other copy opened on another ink than its own").toBe(b);
			expect(there.strokes, "the other copy opened without its own stroke").toEqual(["on-b"]);
		}
		expect(v.sidecar(a)?.pdfPaths ?? [], "the renamed copy's ink file took the other copy's name").not.toContain("B.pdf");
		v.listingWorks();
		await vi.advanceTimersByTimeAsync(60_000);
		await vi.waitFor(async () => {
			await s.store.flush();
			expect(v.sidecar(a)?.pdfPaths ?? [], "once the listing worked, the renamed copy's ink does not claim its new name").toContain("A2.pdf");
		});
		vi.useRealTimers();
		const later = session(v);
		const other = await later.inkAt("B.pdf");
		expect(other.id, "after the next launch the other copy opened on another ink than its own").toBe(b);
		expect(other.strokes, "after the next launch the other copy lost its ink").toEqual(["on-b"]);
		expect((await later.inkAt("A2.pdf")).strokes, "after the next launch the renamed copy lost its ink").toEqual(["on-a"]);
	});

	// The same with no ink of the other copy's own: found by name, the renamed copy's ink is all the family has, and it
	// claims a name no file has. The name it claims was the renamed file, not this one: this copy never takes it.
	it("two copies of the same bytes, only one inked, that one renamed while no pane shows it, the listing failing: the other copy, opened while it still fails, opens blank or says it could not identify the PDF, never on the renamed copy's ink", async () => {
		const v = vault();
		v.files.set("A.pdf", doc("template"));
		v.files.set("B.pdf", doc("template"));
		const a = await inkOn(session(v), "A.pdf", "on-a");
		const s = session(v);
		vi.useFakeTimers();
		v.listingFails(Infinity);
		await s.renameFile("A.pdf", "A2.pdf");
		expect(v.sidecar(a)?.pdfPaths ?? [], "precondition: the claim move waits, the renamed copy's ink still claims the old name").toEqual(["A.pdf"]);
		shown.length = 0;
		const before = v.claims();
		const calls = v.failing.calls;
		const there = await s.inkAt("B.pdf");
		expect(v.failing.calls, "precondition: the open listed the ink folder").toBeGreaterThan(calls);
		expect(there.id, "the other copy opened on the renamed copy's ink").not.toBe(a);
		expect(there.strokes, "the other copy opened wearing strokes, the renamed copy's or any").toEqual([]);
		if (there.failed) {
			expect(shown, "the open failed without the shipped notice").toContain(NOT_IDENTIFIED);
			refusedAsDesigned(there);
		}
		expect(v.claims(), "an ink file took the other copy's name, or another claim changed").toEqual(before);
		v.listingWorks();
		await vi.advanceTimersByTimeAsync(60_000);
		await vi.waitFor(async () => {
			await s.store.flush();
			expect(v.sidecar(a)?.pdfPaths ?? [], "once the listing worked, the renamed copy's ink does not claim its new name").toContain("A2.pdf");
		});
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths ?? [], "once the listing worked, the renamed copy's ink claims the other copy's name").not.toContain("B.pdf");
		const later = session(v);
		expect((await later.inkAt("A2.pdf")).strokes, "after the next launch the renamed copy lost its ink").toEqual(["on-a"]);
		expect((await later.inkAt("B.pdf")).strokes, "after the next launch the other copy opened wearing the renamed copy's ink").toEqual([]);
	});

	// Past a gap in the family (its second gone to the trash), the kept ink is found by the leave alone: a lookup by name
	// stops at the gap.
	it.each([
		["the kept ink the family's second", false],
		["the kept ink past a gap in the family", true],
	] as const)("a leave owed at a quit, its run at the launch unable to move the found ink to the trash, %s, the copy opened while the listing fails: on the kept ink with its stroke, or the notice, never on the found ink's older stroke", async (_label, gap) => {
		const v = vault();
		v.files.set("P.pdf", doc("owed"));
		v.files.set("Q.pdf", doc("owed"));
		if (gap) v.files.set("X.pdf", doc("owed"));
		const first = session(v);
		const found = await inkOn(first, "P.pdf", "old");
		const x = gap ? await inkOn(first, "X.pdf", "gone", 25) : undefined;
		const kept = await inkOn(first, "Q.pdf", "new", 40);
		expect(kept, "precondition: the kept ink is the family's second, or its third past a gap").toBe(gap ? `${found}-3` : `${found}-2`);
		if (x !== undefined) {
			expect(x, "precondition: the deleted copy's ink is the family's second").toBe(`${found}-2`);
			// X.pdf deleted while closed, its ink moved to the trash: the family's second is free, a gap before the kept ink.
			v.trashed("X.pdf", x);
		}
		// What a quit leaves with the leave owed: both ink files claim the copy, the leave saved under its key as
		// saveOwedLeaves writes it, the found ink's strokes at the owe as `had`.
		v.files.delete("Q.pdf");
		const keptFile = `${INK}/${kept}.json`;
		const keptPage = parsePage(v.adapter.files.get(keptFile)!, kept).data;
		v.adapter.files.set(keptFile, serializePage({ ...keptPage, pdfPaths: ["P.pdf"] }));
		v.local.set(OWED_KEY, JSON.stringify([{ id: found, path: "P.pdf", from: kept, had: ["old"], keptPaths: ["P.pdf"], foundPaths: ["P.pdf"] }]));
		expect(v.claims(), "precondition: both ink files claim the copy").toEqual({ [`${found}.json`]: ["P.pdf"], [`${kept}.json`]: ["P.pdf"] });
		// The found ink's file cannot be moved (locked by another program): the launch's run leaves the leave owed.
		const rename = v.adapter.rename.bind(v.adapter);
		let tries = 0;
		v.adapter.rename = async (src: string, dest: string) => {
			if (src === `${INK}/${found}.json`) {
				tries++;
				throw new Error("EBUSY injected");
			}
			return rename(src, dest);
		};
		const s = session(v);
		await vi.waitFor(() => expect(tries, "precondition: the launch's run tried to move the found ink to the trash").toBeGreaterThan(0));
		await s.pdfStore.settle();
		await s.store.flush();
		const owed = JSON.parse((v.local.get(OWED_KEY) as string | undefined) ?? "[]") as { id: string; path: string; from: string }[];
		expect(owed.map((o) => [o.id, o.path, o.from]), "precondition: the leave is still owed after the launch's run").toEqual([[found, "P.pdf", kept]]);
		expect(v.sidecar(found)?.pdfPaths ?? [], "precondition: the found ink still claims the copy").toEqual(["P.pdf"]);
		v.listingFails(Infinity);
		shown.length = 0;
		const calls = v.failing.calls;
		const there = await s.inkAt("P.pdf");
		expect(v.failing.calls, "precondition: the open listed the ink folder").toBeGreaterThan(calls);
		expect(there.strokes, "the copy opened on the found ink's older stroke, the kept ink's hidden").not.toContain("old");
		if (there.failed) {
			expect(shown, "the open failed without the shipped notice").toContain(NOT_IDENTIFIED);
			refusedAsDesigned(there);
		} else {
			expect(there.id, "the copy opened on another ink than the kept one").toBe(kept);
			expect(there.strokes, "the copy opened without the kept ink's stroke").toEqual(["new"]);
		}
	});

	// The same leave, the copy then renamed with no pane while the listing fails: the leave follows the name, and both inks
	// still claim the old one, as the claim move waits. Each is the ink of the rename's old name; the kept one is still
	// taken ahead of the found one.
	it.each([
		["the kept ink the family's second", false],
		["the kept ink past a gap in the family", true],
	] as const)("a leave owed at a quit, its run at the launch unable to move the found ink to the trash, %s, the copy then renamed in Obsidian while no pane shows it and the listing fails: opened at its new name while the listing still fails, on the kept ink with its stroke, or the notice, never on the found ink's older stroke", async (_label, gap) => {
		const v = vault();
		v.files.set("P.pdf", doc("owed"));
		v.files.set("Q.pdf", doc("owed"));
		if (gap) v.files.set("X.pdf", doc("owed"));
		const first = session(v);
		const found = await inkOn(first, "P.pdf", "old");
		const x = gap ? await inkOn(first, "X.pdf", "gone", 25) : undefined;
		const kept = await inkOn(first, "Q.pdf", "new", 40);
		expect(kept, "precondition: the kept ink is the family's second, or its third past a gap").toBe(gap ? `${found}-3` : `${found}-2`);
		if (x !== undefined) {
			expect(x, "precondition: the deleted copy's ink is the family's second").toBe(`${found}-2`);
			v.trashed("X.pdf", x);
		}
		v.files.delete("Q.pdf");
		const keptFile = `${INK}/${kept}.json`;
		const keptPage = parsePage(v.adapter.files.get(keptFile)!, kept).data;
		v.adapter.files.set(keptFile, serializePage({ ...keptPage, pdfPaths: ["P.pdf"] }));
		v.local.set(OWED_KEY, JSON.stringify([{ id: found, path: "P.pdf", from: kept, had: ["old"], keptPaths: ["P.pdf"], foundPaths: ["P.pdf"] }]));
		const rename = v.adapter.rename.bind(v.adapter);
		let tries = 0;
		v.adapter.rename = async (src: string, dest: string) => {
			if (src === `${INK}/${found}.json`) {
				tries++;
				throw new Error("EBUSY injected");
			}
			return rename(src, dest);
		};
		const s = session(v);
		await vi.waitFor(() => expect(tries, "precondition: the launch's run tried to move the found ink to the trash").toBeGreaterThan(0));
		await s.pdfStore.settle();
		await s.store.flush();
		const owedAt = () =>
			(JSON.parse((v.local.get(OWED_KEY) as string | undefined) ?? "[]") as { id: string; path: string; from: string }[]).map((o) => [o.id, o.path, o.from]);
		expect(owedAt(), "precondition: the leave is still owed after the launch's run").toEqual([[found, "P.pdf", kept]]);
		vi.useFakeTimers();
		v.listingFails(Infinity);
		await s.renameFile("P.pdf", "P2.pdf");
		expect(owedAt(), "precondition: the leave follows the rename").toEqual([[found, "P2.pdf", kept]]);
		expect(v.sidecar(found)?.pdfPaths ?? [], "precondition: the claim move waits, the found ink still claims P").toEqual(["P.pdf"]);
		expect(v.sidecar(kept)?.pdfPaths ?? [], "precondition: the claim move waits, the kept ink still claims P").toEqual(["P.pdf"]);
		shown.length = 0;
		const calls = v.failing.calls;
		const there = await s.inkAt("P2.pdf");
		expect(v.failing.calls, "precondition: the open listed the ink folder").toBeGreaterThan(calls);
		expect(there.strokes, "the renamed copy opened on the found ink's older stroke, the kept ink's hidden").not.toContain("old");
		if (there.failed) {
			expect(shown, "the open failed without the shipped notice").toContain(NOT_IDENTIFIED);
			refusedAsDesigned(there);
		} else {
			expect(there.id, "the renamed copy opened on another ink than the kept one").toBe(kept);
			expect(there.strokes, "the renamed copy opened without the kept ink's stroke").toEqual(["new"]);
		}
	});

	// The leave run at the launch: the found ink in the trash, the leave owed no more in this session. The kept ink, past
	// a gap in the family, is found by that leave alone.
	it("a leave owed at a quit and run at the launch, the found ink gone to the trash, the kept ink past a gap in the family: the copy opened while the listing fails opens on the kept ink with its stroke, with no notice", async () => {
		const v = vault();
		v.files.set("P.pdf", doc("owed"));
		v.files.set("Q.pdf", doc("owed"));
		v.files.set("X.pdf", doc("owed"));
		const first = session(v);
		const found = await inkOn(first, "P.pdf", "old");
		const x = await inkOn(first, "X.pdf", "gone", 25);
		const kept = await inkOn(first, "Q.pdf", "new", 40);
		expect([x, kept], "precondition: the deleted copy's ink is the second, the kept ink the third").toEqual([`${found}-2`, `${found}-3`]);
		v.trashed("X.pdf", x);
		v.files.delete("Q.pdf");
		const keptFile = `${INK}/${kept}.json`;
		const keptPage = parsePage(v.adapter.files.get(keptFile)!, kept).data;
		v.adapter.files.set(keptFile, serializePage({ ...keptPage, pdfPaths: ["P.pdf"] }));
		v.local.set(OWED_KEY, JSON.stringify([{ id: found, path: "P.pdf", from: kept, had: ["old"], keptPaths: ["P.pdf"], foundPaths: ["P.pdf"] }]));
		const s = session(v);
		await vi.waitFor(() => expect(v.sidecar(found), "precondition: the launch's run moved the found ink to the trash").toBeUndefined());
		await s.pdfStore.settle();
		await s.store.flush();
		const owed = JSON.parse((v.local.get(OWED_KEY) as string | undefined) ?? "[]") as { id: string }[];
		expect(owed.filter((o) => o.id === found), "precondition: the leave is owed no more").toEqual([]);
		expect(v.sidecar(kept)?.pdfPaths ?? [], "precondition: the kept ink claims the copy").toEqual(["P.pdf"]);
		v.listingFails(Infinity);
		shown.length = 0;
		const calls = v.failing.calls;
		const there = await s.inkAt("P.pdf");
		expect(v.failing.calls, "precondition: the open listed the ink folder").toBeGreaterThan(calls);
		expect(there.failed, "a listing that keeps failing made the open of the copy fail").toBe(false);
		expect(shown, "a listing that keeps failing showed a notice for the copy").toEqual([]);
		expect(there.id, "the copy opened on another ink than the kept one").toBe(kept);
		expect(there.strokes, "the copy opened without the kept ink's stroke").toEqual(["new"]);
	});

	// What is new for a waiting deletion is fixed at the grace's end, as for one deferred: a PDF made after that is
	// another file, as it is when the listing works and the deletion ends at its grace.
	it("a deletion whose grace ends while the listing fails, a copy of the same bytes made long after: once the listing works the deleted ink goes to the trash whole, and the copy opens blank", async () => {
		const v = vault();
		v.files.set("Doc.pdf", doc("doc"));
		const inked = await inkOn(session(v), "Doc.pdf", "ink-0");
		const s = session(v);
		vi.useFakeTimers();
		await s.deleteFile("Doc.pdf");
		v.listingFails(Infinity);
		await settleGrace(s);
		expect(v.failing.calls, "precondition: the grace's end listed the ink folder").toBeGreaterThan(0);
		expect(s.pdfStore.pendingClaims().size, "precondition: the deletion waits for the listing").toBe(1);
		// Long after the grace: past three of the wait's tries (10 s, 20 s, 40 s).
		await vi.advanceTimersByTimeAsync(80_000);
		expect(s.pdfStore.pendingClaims().size, "precondition: the deletion still waits").toBe(1);
		await s.createFile("Doc copy.pdf", doc("doc"));
		v.listingWorks();
		await vi.advanceTimersByTimeAsync(6 * 60_000);
		await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size, "once the listing worked, the deletion still waits").toBe(0));
		await s.store.flush();
		vi.useRealTimers();
		expect(v.sidecar(inked)?.pdfPaths ?? [], "the deleted PDF's ink file took the copy made long after its grace").not.toContain("Doc copy.pdf");
		expect(v.trashInk(), "the trash does not hold the deleted PDF's ink, strokes whole, and nothing else").toEqual([["ink-0"]]);
		const copy = await session(v).inkAt("Doc copy.pdf");
		expect(copy.strokes, "a copy made long after the grace opened wearing the deleted PDF's ink").toEqual([]);
	});
});

describe.each(["desktop", "mobile"] as const)("the ink folder that is not there, on the %s host", (host) => {
	it("an absent other folder is no failure: a lone PDF opens on its ink, with no notice, and its next stroke is kept", async () => {
		const v = vault(host);
		v.files.set("Solo.pdf", doc("solo"));
		const inked = await inkOn(session(v), "Solo.pdf", "ink-0");
		shown.length = 0;
		const s = session(v);
		const there = await s.inkAt("Solo.pdf");
		expect(shown, "an absent folder showed a notice").toEqual([]);
		expect(there.failed, "an absent folder made the open fail").toBe(false);
		expect(there.id, "an absent folder gave the PDF another ink id").toBe(inked);
		expect(there.strokes).toEqual(["ink-0"]);
		await inkOn(s, "Solo.pdf", "ink-1", 40);
		expect((await session(v).inkAt("Solo.pdf")).strokes, "the next stroke was not kept").toEqual(["ink-0", "ink-1"]);
	});

	it("an absent ink folder is an empty one: a PDF in a vault with no ink yet opens blank, with no notice, and its first stroke is kept", async () => {
		const v = vault(host);
		v.files.set("New.pdf", doc("new"));
		shown.length = 0;
		const s = session(v);
		const there = await s.inkAt("New.pdf");
		expect(shown, "an absent folder showed a notice").toEqual([]);
		expect(there.failed, "an absent folder made the open fail").toBe(false);
		expect(there.strokes).toEqual([]);
		await inkOn(s, "New.pdf", "first");
		expect((await session(v).inkAt("New.pdf")).strokes, "the first stroke was not kept").toEqual(["first"]);
	});

	// A PDF whose ink is not the family's first is where an absent folder read as a failed listing shows: the open then
	// cannot rule out another copy's ink and refuses, as in the cell where the listing keeps failing.
	it("an absent other folder beside two copies of the same bytes: the copy whose ink is the family's second opens on it, with no notice", async () => {
		const v = vault(host);
		const { a, b } = await twoInkedCopies(v);
		shown.length = 0;
		v.absent.length = 0;
		const there = await session(v).inkAt("B.pdf");
		expect(v.absent, "precondition: the open listed the other folder, which is not there").toContain("handwriting");
		expect(v.failing.left, "precondition: the live folder's listing worked").toBe(0);
		expect(there.failed, "an absent folder made the open fail").toBe(false);
		expect(shown, "an absent folder showed a notice").toEqual([]);
		expect(there.id, "an absent folder gave the copy another ink than its own").toBe(b);
		expect(there.strokes, "an absent folder made the copy open without its own stroke").toEqual(["on-b"]);
		expect(v.sidecar(a)?.pdfPaths ?? [], "the other copy's ink file took the copy's name").not.toContain("B.pdf");
	});
});

/**
 * The host's look at one file fails as Obsidian's adapter fails it: `exists` answers false, as it does for any failure,
 * and `stat` rejects, as it does for any failure but a file not there. "stat": `exists` fails until the first `stat`,
 * which throws, ends the bout (the stat throws once). "exists": only `exists` fails, until `works()`; `stat` answers as
 * the file is. With `keep`, the stat road's throw does not end the bout: every look fails until `works()`. Counts what
 * the bout did.
 */
function lookFails(v: Vault, file: string, road: "stat" | "exists", keep = false) {
	const a = v.adapter;
	const exists = a.exists.bind(a);
	const stat = a.stat.bind(a);
	const seen = { failing: true, existsFalse: 0, statThrows: 0 };
	a.exists = async (p: string) => {
		if (seen.failing && p === file) {
			seen.existsFalse++;
			return false;
		}
		return exists(p);
	};
	a.stat = async (p: string) => {
		if (seen.failing && road === "stat" && p === file) {
			if (!keep) seen.failing = false;
			seen.statThrows++;
			throw Object.assign(new Error(`EBUSY: resource busy or locked, stat '${file}'`), { code: "EBUSY" });
		}
		return stat(p);
	};
	return {
		seen,
		works() {
			seen.failing = false;
		},
	};
}

/**
 * The host's `stat` rejects for a file that is not there, instead of answering null: desktop with Node's ENOENT, mobile
 * with no code, its message saying the file does not exist. Every other look answers as before. Lists each path it
 * rejected for.
 */
function statRejectsMissing(v: Vault, host: Host): string[] {
	const a = v.adapter;
	const stat = a.stat.bind(a);
	const rejected: string[] = [];
	a.stat = async (p: string) => {
		const st = await stat(p);
		if (st) return st;
		rejected.push(p);
		if (host === "mobile") throw new Error(`${p} does not exist`);
		throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: "ENOENT" });
	};
	return rejected;
}

/** The owed leaves saved for the next launch, each as [found ink, path, kept ink]. */
function owedAt(v: Vault): string[][] {
	const saved = JSON.parse((v.local.get(OWED_KEY) as string | undefined) ?? "[]") as { id: string; path: string; from: string }[];
	return saved.map((o) => [o.id, o.path, o.from]);
}

/**
 * P.pdf and Q.pdf, the same bytes, each inked; Q.pdf then deleted and its ink, the kept ink, claiming P.pdf, with the
 * leave of P.pdf's own ink, the found ink, owed off P.pdf at the quit: the next launch runs it.
 */
async function leaveOwedAtQuit(v: Vault) {
	v.files.set("P.pdf", doc("owed"));
	v.files.set("Q.pdf", doc("owed"));
	const first = session(v);
	const found = await inkOn(first, "P.pdf", "old");
	const kept = await inkOn(first, "Q.pdf", "new", 40);
	expect(kept, "precondition: the kept ink is the family's second").toBe(`${found}-2`);
	v.files.delete("Q.pdf");
	const keptFile = `${INK}/${kept}.json`;
	const keptPage = parsePage(v.adapter.files.get(keptFile)!, kept).data;
	v.adapter.files.set(keptFile, serializePage({ ...keptPage, pdfPaths: ["P.pdf"] }));
	v.local.set(OWED_KEY, JSON.stringify([{ id: found, path: "P.pdf", from: kept, had: ["old"], keptPaths: ["P.pdf"], foundPaths: ["P.pdf"] }]));
	return { found, kept };
}

/** A new launch over the vault, waited for until every owed leave it ran at the launch has ended. */
async function launchRunningLeaves(v: Vault) {
	const leaves = vi.spyOn(HandwritingPlugin.prototype, "pairedInkLeaves");
	leaves.mockClear();
	const s = session(v);
	await vi.waitFor(() => expect(leaves, "precondition: the launch ran the owed leave").toHaveBeenCalled());
	await Promise.allSettled(leaves.mock.results.map((r) => r.value as Promise<void>));
	await s.pdfStore.settle();
	await s.store.flush();
	return s;
}

/**
 * Run the clock on by `ms` (a grace, or a wait before a retry) and wait for each retirement it started to end, whatever
 * it decided: the deletion ended, or it waits to be tried again.
 */
async function retirementRuns(s: Session, ms = 10_001) {
	const runs = vi.spyOn(PdfInkStore.prototype as never as { retireDeletedPath(...a: unknown[]): Promise<void> }, "retireDeletedPath");
	runs.mockClear();
	await vi.advanceTimersByTimeAsync(ms);
	await vi.waitFor(() => expect(runs, "precondition: a retirement ran").toHaveBeenCalled());
	await Promise.allSettled(runs.mock.results.map((r) => r.value as Promise<void>));
	await s.store.flush();
}

/** A fault on the looks at one file: how many looks it failed so far, and its end. */
type Fault = { count(): number; works(): void };

/** The stat of `file` throws (lookFails, "stat"): once, or with `keep` at every look until `works()`. */
function statThrows(v: Vault, file: string, keep = false): Fault {
	const look = lookFails(v, file, "stat", keep);
	return { count: () => look.seen.statThrows + look.seen.existsFalse, works: () => look.works() };
}

/** Only `exists` fails for `file` (lookFails, "exists"), until `works()`; `stat` answers as the file is. */
function unseen(v: Vault, file: string): Fault {
	const look = lookFails(v, file, "exists");
	return { count: () => look.seen.existsFalse, works: () => look.works() };
}

/** The reads of `file` reject, as the host's read of a busy file does: the next `times` of them, or each until `works()`. */
function readFails(v: Vault, file: string, times = Infinity): Fault {
	const a = v.adapter;
	const read = a.read.bind(a);
	let left = times;
	let thrown = 0;
	a.read = async (p: string) => {
		if (left > 0 && p === file) {
			left--;
			thrown++;
			throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${file}'`), { code: "EBUSY" });
		}
		return read(p);
	};
	return {
		count: () => thrown,
		works() {
			left = 0;
		},
	};
}

/** Every fault at once. */
function anyOf(...faults: Fault[]): Fault {
	return { count: () => faults.reduce((n, f) => n + f.count(), 0), works: () => faults.forEach((f) => f.works()) };
}

/**
 * `arm` put on ink `id`'s `file` for the deletion in `s`, once: "scan" now, so the retirement's scan of the ink folder
 * meets it; "read" as the retirement reads the ink in; "look" once it has, so its last look meets it.
 */
function faultAt(s: Session, v: Vault, id: string, file: string, when: "scan" | "read" | "look", arm: (v: Vault, file: string) => Fault): Fault {
	let fault = when === "scan" ? arm(v, file) : undefined;
	if (when !== "scan") {
		const load = s.store.load.bind(s.store);
		s.store.load = (async (...args: Parameters<typeof load>) => {
			if (when === "read" && args[0] === id && fault === undefined) fault = arm(v, file);
			const out = await load(...args);
			if (when === "look" && args[0] === id && fault === undefined) fault = arm(v, file);
			return out;
		}) as typeof s.store.load;
	}
	return { count: () => fault?.count() ?? 0, works: () => fault?.works() };
}

/** Bytes cut short, as a sync client caught writing the file in place leaves them. */
function unparseable(raw: string): string {
	return raw.slice(0, 40);
}

/** A stroke this build cannot decode, as a newer build on another device writes one; the claim itself is readable. */
function lossy(raw: string): string {
	const page = JSON.parse(raw) as { strokes: Record<string, unknown>[] };
	page.strokes.push({ ...page.strokes[0], id: null });
	return JSON.stringify(page);
}

/** The same ink as a newer Handwriting on another device writes it: a schema this build reads only to show. */
function newer(raw: string): string {
	return JSON.stringify({ ...(JSON.parse(raw) as Record<string, unknown>), schemaVersion: READ_SCHEMA_VERSION + 1 });
}

/** Notes.pdf inked in one session, then a new session: the ink's id, its file, and the file's bytes. */
async function inkedNotes(v: Vault) {
	v.files.set("Notes.pdf", doc("notes"));
	const inked = await inkOn(session(v), "Notes.pdf", "ink-0");
	const file = `${INK}/${inked}.json`;
	return { inked, file, bytes: v.adapter.files.get(file), s: session(v) };
}

/**
 * `path` opens blank in `s`: no stroke, no failure, and, while the deleted PDF's ink file `file` is live, not on its ink
 * id. Once that file is in the trash the id is free: a blank of the same bytes takes it, as a first open does. With
 * `orRefused`, an open that says it could not identify the PDF also passes; it still gives the pane no id.
 */
async function opensBlank(s: Session, v: Vault, file: string, path: string, inked: string, when: string, opts: { orRefused?: boolean } = {}) {
	const live = v.adapter.files.has(file);
	const there = await s.inkAt(path);
	expect(there.strokes, `${when} the copy opened on the deleted PDF's ink`).toEqual([]);
	if (live) expect(there.id, `${when} the copy opened on the deleted PDF's ink id`).not.toBe(inked);
	if (opts.orRefused && there.failed) expect(there.id, `${when} a refused open gave the pane an ink id`).toBeUndefined();
	else expect(there.failed, `${when} the copy's open failed`).toBe(false);
}

/** Notes.pdf's deletion in `s` still waits, and its ink's file is as it was, outside the trash. */
function deletionWaits(s: Session, v: Vault, file: string, bytes: string | undefined, when: string) {
	expect(s.pdfStore.pendingClaims().has("Notes.pdf"), `${when}, the deletion ended with its ink left live`).toBe(true);
	expect(v.adapter.files.get(file), `${when}, the ink's file changed or went`).toBe(bytes);
	expect(v.trashInk(), `${when}, the ink went to the trash`).toEqual([]);
}

/** Notes.pdf's deletion in `s` ended: its ink in the trash, strokes whole, and nothing else; no live file left. */
function deletionEnded(s: Session, v: Vault, file: string, when: string) {
	expect(s.pdfStore.pendingClaims().has("Notes.pdf"), `${when}, the deletion still waits`).toBe(false);
	expect(v.trashInk(), `${when}, the trash does not hold the deleted PDF's ink, strokes whole, and nothing else`).toEqual([["ink-0"]]);
	expect(v.adapter.files.has(file), `${when}, the deleted PDF's ink file is still live`).toBe(false);
}

describe("the look at an ink file fails while its claim is read", () => {
	it.each([
		["the stat of the kept ink's file throws once", "stat"],
		["the kept ink's file in the other ink folder and its exists failing", "exists"],
	] as const)("a leave owed at a quit and run at the launch, %s: the leave stays owed, both inks as they were, and the next launch runs it", async (_label, road) => {
		const v = vault();
		const { found, kept } = await leaveOwedAtQuit(v);
		let keptFile = `${INK}/${kept}.json`;
		if (road === "exists") {
			// The configured folder is .handwriting; the kept ink lives in the other one, found there by name.
			const other = `handwriting/${kept}.json`;
			await v.adapter.rename(keptFile, other);
			keptFile = other;
		}
		const keptBytes = v.adapter.files.get(keptFile);
		const look = lookFails(v, keptFile, road);
		await launchRunningLeaves(v);
		if (road === "stat") expect(look.seen.statThrows, "precondition: the stat of the kept ink's file threw").toBe(1);
		expect(look.seen.existsFalse, "precondition: an exists of the kept ink's file failed").toBeGreaterThan(0);
		expect(owedAt(v), "a failed look at the kept ink's file was read as no file, and the leave was forgotten").toEqual([[found, "P.pdf", kept]]);
		expect(v.sidecar(found)?.strokes.map((x) => x.id), "the found ink's file lost its stroke").toEqual(["old"]);
		expect(v.sidecar(found)?.pdfPaths ?? [], "the found ink's claim changed").toEqual(["P.pdf"]);
		expect(v.adapter.files.get(keptFile), "the kept ink's file changed").toBe(keptBytes);
		look.works();
		const later = await launchRunningLeaves(v);
		await vi.waitFor(() => expect(v.sidecar(found), "once the look worked, the next launch's leave left the found ink outside the trash").toBeUndefined());
		await later.store.flush();
		expect(owedAt(v), "once the leave ran, it is still owed").toEqual([]);
		expect(v.trashInk(), "the trash holds the found ink, strokes whole, and nothing else").toEqual([["old"]]);
		const there = await later.inkAt("P.pdf");
		expect(there.id, "once the leave ran, the copy opened on another ink than the kept one").toBe(kept);
		expect(there.strokes, "once the leave ran, the copy opened without the kept ink's stroke").toEqual(["new"]);
	});

	// The twin: a kept ink whose file is gone from every ink folder, every look working, is no file. Nothing keeps the
	// path, so the leave is forgotten, as before, and the found ink stays the copy's.
	it("a leave owed at a quit and run at the launch, the kept ink's file gone from every ink folder: the leave is forgotten, and the copy keeps the found ink", async () => {
		const v = vault();
		const { found, kept } = await leaveOwedAtQuit(v);
		v.adapter.files.delete(`${INK}/${kept}.json`);
		expect([...v.adapter.files.keys()].filter((p) => p.includes(kept)), "precondition: no file of the kept ink anywhere").toEqual([]);
		const s = await launchRunningLeaves(v);
		expect(owedAt(v), "a leave whose kept ink's file is gone everywhere stayed owed").toEqual([]);
		expect(v.sidecar(found)?.pdfPaths ?? [], "the found ink's claim changed").toEqual(["P.pdf"]);
		const there = await s.inkAt("P.pdf");
		expect(there.id, "the copy opened on another ink than the found one").toBe(found);
		expect(there.strokes, "the copy opened without the found ink's stroke").toEqual(["old"]);
	});

	// The same on a host whose stat rejects for a file that is not there: a not-found rejection is "not there", as the
	// load's own second look at a file takes it (ENOENT, or no code, the mobile host's shape).
	it.each(["desktop", "mobile"] as const)("a leave owed at a quit and run at the launch, the kept ink's file gone from every ink folder and the %s host's stat rejecting for a file not there: the leave is forgotten, and the copy keeps the found ink", async (host) => {
		const v = vault(host);
		const { found, kept } = await leaveOwedAtQuit(v);
		v.adapter.files.delete(`${INK}/${kept}.json`);
		expect([...v.adapter.files.keys()].filter((p) => p.includes(kept)), "precondition: no file of the kept ink anywhere").toEqual([]);
		const rejected = statRejectsMissing(v, host);
		const s = await launchRunningLeaves(v);
		expect(rejected.filter((p) => p.includes(kept)), "precondition: a stat of the kept ink's file rejected").not.toEqual([]);
		expect(owedAt(v), "a leave whose kept ink's file is gone everywhere stayed owed").toEqual([]);
		expect(v.sidecar(found)?.pdfPaths ?? [], "the found ink's claim changed").toEqual(["P.pdf"]);
		const there = await s.inkAt("P.pdf");
		expect(there.id, "the copy opened on another ink than the found one").toBe(found);
		expect(there.strokes, "the copy opened without the found ink's stroke").toEqual(["old"]);
	});

	// The deletion reads the ink in, then looks at its file a last time before acting on it. The look fails from the
	// moment the ink was read in. An ink read in this session keeps the home it was found at, so with only `exists`
	// failing the last look still reaches its file.
	it.each([
		["the stat of the ink's file throws once", "stat"],
		["the ink's file in the other ink folder and its exists failing", "exists"],
	] as const)("a deletion whose grace ends, its last look at the deleted PDF's ink failing, %s: the ink's file is left as it was, outside the trash", async (_label, road) => {
		const v = vault();
		v.files.set("Notes.pdf", doc("notes"));
		const inked = await inkOn(session(v), "Notes.pdf", "ink-0");
		let file = `${INK}/${inked}.json`;
		if (road === "exists") {
			const other = `handwriting/${inked}.json`;
			await v.adapter.rename(file, other);
			file = other;
		}
		const bytes = v.adapter.files.get(file);
		const s = session(v);
		vi.useFakeTimers();
		await s.deleteFile("Notes.pdf");
		let look: ReturnType<typeof lookFails> | undefined;
		const load = s.store.load.bind(s.store);
		s.store.load = (async (...args: Parameters<typeof load>) => {
			const out = await load(...args);
			if (args[0] === inked && look === undefined) look = lookFails(v, file, road);
			return out;
		}) as typeof s.store.load;
		// The retirement the grace's end started, ended or waiting to be tried again.
		await retirementRuns(s);
		vi.useRealTimers();
		expect(look, "precondition: the deletion read the ink in").toBeDefined();
		if (road === "stat") expect(look!.seen.statThrows, "precondition: the stat of the ink's file threw").toBe(1);
		expect(look!.seen.existsFalse, "precondition: an exists of the ink's file failed").toBeGreaterThan(0);
		expect(v.trashInk(), "the deletion moved the ink whose last look failed to the trash").toEqual([]);
		expect(v.adapter.files.get(file), "the deletion changed or removed the file of the ink whose last look failed").toBe(bytes);
	});

	// Left as it was, the ink still claims only the deleted PDF. A deletion that ended there left it for a copy of the
	// same bytes to open on. The deletion waits and is tried again instead, as after a read above it that failed, and an
	// open does not take a waiting deletion's ink. The control first: every look working.
	it("a deleted PDF's grace ends, every look working: its ink goes to the trash whole, and a copy of the same bytes added then opens blank, also after a relaunch", async () => {
		const v = vault();
		const { inked, file, s } = await inkedNotes(v);
		vi.useFakeTimers();
		await s.deleteFile("Notes.pdf");
		await retirementRuns(s);
		deletionEnded(s, v, file, "every look working");
		await s.createFile("Copy.pdf", doc("notes"));
		await opensBlank(s, v, file, "Copy.pdf", inked, "added after the deletion ended,");
		vi.useRealTimers();
		s.pdfStore.cancelPendingDeletes();
		await opensBlank(session(v), v, file, "Copy.pdf", inked, "after a relaunch,");
	});

	// Each way a look at the ink's file fails while the deletion counts it. Armed at the delete, a session that never
	// read the ink in meets it first at the scan of the ink folder; armed at the retirement's own read of the ink, at that
	// read; armed once it read the ink in, at the last look. Each fault is over before the copy is added.
	it.each([
		["the stat of its ink's file throwing once at the last look", "look", (v: Vault, file: string) => statThrows(v, file)],
		["its ink's file unseen by exists at the last look, the stat working", "look", (v: Vault, file: string) => unseen(v, file)],
		["the read of its ink's file throwing at the last look, the stat working", "look", (v: Vault, file: string) => readFails(v, file)],
		["the read of its ink's file throwing once at the retirement's read of it", "read", (v: Vault, file: string) => readFails(v, file, 1)],
		[
			"its ink's file unseen by exists and its read throwing from the delete on, with no record of it held",
			"scan",
			(v: Vault, file: string) => anyOf(unseen(v, file), readFails(v, file)),
		],
	] as const)("a deleted PDF's grace ends, %s: the deletion waits, the ink as it was; a copy of the same bytes added then opens blank, also after a relaunch, and the relaunch's retirement sends the ink to the trash whole", async (_label, when, arm) => {
		const v = vault();
		const { inked, file, bytes, s } = await inkedNotes(v);
		vi.useFakeTimers();
		await s.deleteFile("Notes.pdf");
		const fault = faultAt(s, v, inked, file, when, arm);
		await retirementRuns(s);
		expect(fault.count(), "precondition: the look at the ink's file failed").toBeGreaterThan(0);
		fault.works();
		await s.createFile("Copy.pdf", doc("notes"));
		// The user's harm first: at the base the deletion ended here and the copy opened on the deleted PDF's ink.
		await opensBlank(s, v, file, "Copy.pdf", inked, "added after the failed look,");
		deletionWaits(s, v, file, bytes, "after the failed look");
		// Quit, as at unload: the timers stop, and the waiting deletion stays saved for the next launch.
		s.pdfStore.cancelPendingDeletes();
		const r = session(v);
		expect(r.pdfStore.pendingClaims().has("Notes.pdf"), "the relaunch lost the waiting deletion").toBe(true);
		await opensBlank(r, v, file, "Copy.pdf", inked, "after a relaunch,");
		await retirementRuns(r);
		deletionEnded(r, v, file, "once the look worked");
		vi.useRealTimers();
		await opensBlank(r, v, file, "Copy.pdf", inked, "once the deletion ended,");
	});

	// A look that keeps failing keeps the deletion waiting, each try counted, across a relaunch too: a limit, as for the
	// leave. While it fails, an open of the copy may also say it could not identify the PDF; never on the deleted ink.
	it("a deleted PDF's grace ends, every look at its ink's file failing until it works: the deletion waits through each try, saved across a relaunch, the ink as it was; a copy of the same bytes added meanwhile never opens on its ink; once the look works the next try sends the ink to the trash whole", async () => {
		const v = vault();
		const { inked, file, bytes, s } = await inkedNotes(v);
		vi.useFakeTimers();
		await s.deleteFile("Notes.pdf");
		const fault = faultAt(s, v, inked, file, "look", (w, f) => statThrows(w, f, true));
		await retirementRuns(s);
		let failed = fault.count();
		expect(failed, "precondition: the look at the ink's file failed").toBeGreaterThan(0);
		deletionWaits(s, v, file, bytes, "at the grace's end, the look failing");
		// The first retry, a wait on.
		await retirementRuns(s, 10_001);
		expect(fault.count(), "precondition: the look failed at the retry too").toBeGreaterThan(failed);
		deletionWaits(s, v, file, bytes, "at the retry, the look failing");
		await s.createFile("Copy.pdf", doc("notes"));
		await opensBlank(s, v, file, "Copy.pdf", inked, "added while the look kept failing,", { orRefused: true });
		s.pdfStore.cancelPendingDeletes();
		const r = session(v);
		expect(r.pdfStore.pendingClaims().has("Notes.pdf"), "the relaunch lost the deletion waiting on the look").toBe(true);
		await opensBlank(r, v, file, "Copy.pdf", inked, "after a relaunch, the look still failing,", { orRefused: true });
		failed = fault.count();
		await retirementRuns(r);
		expect(fault.count(), "precondition: the look failed at the relaunch's try too").toBeGreaterThan(failed);
		deletionWaits(r, v, file, bytes, "after a relaunch, the look failing");
		fault.works();
		// The relaunch's first retry, a wait on.
		await retirementRuns(r, 10_001);
		deletionEnded(r, v, file, "once the look worked");
		vi.useRealTimers();
		await opensBlank(r, v, file, "Copy.pdf", inked, "once the deletion ended,");
	});

	// A file that is there and cannot be read is not a failed look: it is left alone and the deletion ends, as before.
	// Met at each step: the scan of the ink folder (a session holding no record of it), the retirement's read of the
	// ink, and the last look, once it was read in whole. Its mtime read as 0 does not make it a failed look.
	it.each([
		["does not parse, met at the scan", "scan", unparseable, false],
		["decodes with loss, met at the scan", "scan", lossy, false],
		["does not parse, met at the retirement's read", "read", unparseable, false],
		["decodes with loss, met at the retirement's read", "read", lossy, false],
		["does not parse, met at the last look", "look", unparseable, false],
		["decodes with loss, met at the last look", "look", lossy, false],
		["does not parse, its mtime read as 0, met at the last look", "look", unparseable, true],
	] as const)("a deleted PDF's grace ends, its ink's file one that %s: the file is left as it was, outside the trash, and the deletion ends", async (_label, when, spoil, mtime0) => {
		const v = vault();
		const { inked, file, s } = await inkedNotes(v);
		vi.useFakeTimers();
		await s.deleteFile("Notes.pdf");
		let spoilt: string | undefined;
		const fault = faultAt(s, v, inked, file, when, (w, f) => {
			// Another device's write, synced in.
			spoilt = spoil(w.adapter.files.get(f)!);
			w.adapter.externalWrite(f, spoilt);
			if (mtime0) w.adapter.setMtime(f, 0);
			return { count: () => 1, works: () => {} };
		});
		await retirementRuns(s);
		vi.useRealTimers();
		expect(fault.count(), "precondition: the file was spoilt").toBe(1);
		expect(parsePage(spoilt!, inked).damaged, "precondition: the file cannot be read whole").toBe(true);
		expect(v.adapter.files.get(file), "the file that cannot be read was changed or removed").toBe(spoilt);
		expect(v.trashInk(), "the file that cannot be read went to the trash").toEqual([]);
		expect(s.pdfStore.pendingClaims().has("Notes.pdf"), "the deletion of a PDF whose ink file is there and cannot be read still waits").toBe(false);
	});

	// A file a newer version wrote is not a failed look either. Read in, it is shown and not written; the deletion leaves
	// it alone and ends, as before.
	it("a deleted PDF's grace ends, its ink's file one a newer version wrote, met at the retirement's read: the file is left as it was, outside the trash, and the deletion ends", async () => {
		const v = vault();
		const { inked, file, s } = await inkedNotes(v);
		vi.useFakeTimers();
		await s.deleteFile("Notes.pdf");
		let written: string | undefined;
		const fault = faultAt(s, v, inked, file, "read", (w, f) => {
			// Another device's write, synced in.
			written = newer(w.adapter.files.get(f)!);
			w.adapter.externalWrite(f, written);
			return { count: () => 1, works: () => {} };
		});
		await retirementRuns(s);
		vi.useRealTimers();
		expect(fault.count(), "precondition: the newer version's file synced in").toBe(1);
		expect(parsePage(written!, inked).futureVersion, "precondition: the file is a newer version's").toBe(READ_SCHEMA_VERSION + 1);
		expect(v.adapter.files.get(file), "the newer version's file was changed or removed").toBe(written);
		expect(v.trashInk(), "the newer version's file went to the trash").toEqual([]);
		expect(s.pdfStore.pendingClaims().has("Notes.pdf"), "the deletion of a PDF whose ink file a newer version wrote still waits").toBe(false);
	});

	// An ink whose file is gone from every ink folder, its record still held, on a host whose stat rejects for a file
	// that is not there: the rejection is "not there", not a failed look, and the deletion ends with nothing to move.
	it.each(["desktop", "mobile"] as const)("a deleted PDF's grace ends, its ink's file gone from every ink folder, its record held, and the %s host's stat rejecting for a file not there: the deletion ends, nothing in the trash", async (host) => {
		const v = vault(host);
		v.files.set("Notes.pdf", doc("notes"));
		const s = session(v);
		const inked = await inkOn(s, "Notes.pdf", "ink-0");
		const file = `${INK}/${inked}.json`;
		// Another device removed it, synced in.
		v.adapter.files.delete(file);
		expect([...v.adapter.files.keys()].filter((p) => p.includes(inked)), "precondition: no file of the ink anywhere").toEqual([]);
		const rejected = statRejectsMissing(v, host);
		vi.useFakeTimers();
		await s.deleteFile("Notes.pdf");
		await retirementRuns(s);
		vi.useRealTimers();
		expect(rejected.filter((p) => p.includes(inked)), "precondition: a stat of the ink's file rejected").not.toEqual([]);
		expect(s.pdfStore.pendingClaims().has("Notes.pdf"), "the deletion of a PDF whose ink file is gone everywhere still waits").toBe(false);
		expect(v.trashInk(), "the trash holds something").toEqual([]);
		expect(v.adapter.files.has(file), "the ink's file came back").toBe(false);
	});
});
