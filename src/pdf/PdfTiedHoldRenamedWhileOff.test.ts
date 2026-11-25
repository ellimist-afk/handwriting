/**
 * A tied copy renamed while the plugin is off (Obsidian closed, or the plugin turned off) inside a delete's grace. Two
 * byte-same inked PDFs are deleted in one grace, two new copies of the same bytes arrive, and the first one opened ties:
 * it opens blank and its path is held for both deletions. Then a quit inside the grace, and the copy is moved while no
 * plugin hears it, to a name that pairs it with the first deleted path. The hold was saved under the old name. At the
 * next session the deleted ink must not land on the moved copy, and the copy's own ink must show on it. Through the
 * plugin and the real stores, with an in-memory vault (the harness of PdfTiedHoldFollowsRename.test.ts, copied); the
 * move is made in the vault only, as no plugin session is there to hear it.
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
function session(
	v: ReturnType<typeof vault>,
	opts: { layoutReady?: boolean; pendingStore?: boolean; afterLayout?: (start: () => void) => void } = {}
) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	// afterLayout as the plugin hands it (main.ts): given, the restored deletions' grace starts only when the cell runs it.
	const pdfStore = new PdfInkStore(opts.afterLayout ? { afterLayout: opts.afterLayout } : {});
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

/** TIED's new name, moved while the plugin is off: a folder named like FIRST's, so it pairs X1 by name. */
const PAIRS = "Sub/Notes/A.pdf";

/**
 * Quit inside the grace: the saved list keeps the hold under TIED (and any other held copy), then the vault moves TIED
 * to `to` with no plugin there to hear it.
 */
function quitThenMoveWhileOff(
	v: ReturnType<typeof vault>,
	first: ReturnType<typeof session>,
	to: string = PAIRS,
	held: readonly string[] = [TIED]
) {
	first.pdfStore.cancelPendingDeletes();
	const list = JSON.parse(v.local.get(PENDING_KEY) as string) as { path: string; held?: string[] }[];
	for (const d of [FIRST, SECOND]) {
		expect(list.find((e) => e.path === d)?.held?.slice().sort(), `precondition: the hold for ${d} was saved under the old name`).toEqual([...held].sort());
	}
	v.files.delete(TIED);
	v.files.add(to);
}

/** The next session, both deletions restored in their grace. */
function nextSession(v: ReturnType<typeof vault>, afterLayout?: (start: () => void) => void) {
	const next = session(v, { pendingStore: true, ...(afterLayout ? { afterLayout } : {}) });
	const waiting = next.pdfStore.pendingClaims();
	expect(waiting.has(FIRST) && waiting.has(SECOND), "precondition: both deletions resumed").toBe(true);
	return next;
}

/** Every stroke id kept: in the deleted inks' own files, or in the trash. */
function keptStrokes(v: ReturnType<typeof vault>, ids: readonly string[]): string[] {
	const live = ids.flatMap((id) => v.sidecar(id)?.strokes.map((s) => s.id) ?? []);
	return [...new Set([...live, ...v.trashInk().flat()])].sort();
}

/** The tied copy drawn on before the quit and moved while off; the next session opens the other copy first. */
async function drawnOnThenOtherOpened() {
	const { v, s: first, x1, x2, tied } = await tiedSetup({ pendingStore: true });
	first.draw(tied.id, stroke(50, "own"));
	await first.store.flush();
	quitThenMoveWhileOff(v, first);
	const next = nextSession(v);
	const other = await next.open(OTHER);
	return { v, next, other, x1, x2, tied };
}

describe("a tied copy moved while the plugin is off, to a name that pairs it: the hold saved under the old name", () => {
	it("open first: the next session opens the moved copy blank, not with the first deleted ink", async () => {
		const { v, s: first, x1, x2 } = await tiedSetup({ pendingStore: true });
		quitThenMoveWhileOff(v, first);
		const next = nextSession(v);
		const moved = await next.open(PAIRS);
		expect(moved.id, "the moved copy was handed the first deleted ink by name").not.toBe(x1);
		expect(moved.id, "the moved copy was handed the second deleted ink").not.toBe(x2);
		expect(next.pdfStore.strokes(moved.id).map((x) => x.id), "the moved copy opened wearing ink").toEqual([]);
		endInSession(next);
	});

	it("retirement first: after the grace no deleted ink claims the moved copy, no ink is lost, and the moved copy opens blank", async () => {
		const { v, s: first, x1, x2 } = await tiedSetup({ pendingStore: true });
		quitThenMoveWhileOff(v, first);
		const next = nextSession(v);
		await settleGrace(next);
		vi.useRealTimers();
		expect(claimersOnDisk(v, [x1, x2], PAIRS), "a deleted ink was moved onto the moved copy").toEqual([]);
		expect(keptStrokes(v, [x1, x2]), "a deleted ink was lost, neither kept nor in the trash").toEqual(["ink-0", "ink-1"]);
		await expectBlank(v, PAIRS);
	});

	it("the tied copy drawn on before the quit: the next session opens the moved copy with its own ink, not the first deleted ink", async () => {
		const { v, s: first, x1, tied } = await tiedSetup({ pendingStore: true });
		first.draw(tied.id, stroke(50, "own"));
		await first.store.flush();
		expect(v.sidecar(tied.id)?.pdfPaths, "precondition: the tied copy's own ink claims its old name on disk").toEqual([TIED]);
		quitThenMoveWhileOff(v, first);
		const next = nextSession(v);
		const moved = await next.open(PAIRS);
		expect(moved.id, "the moved copy was handed the first deleted ink by name").not.toBe(x1);
		expect(next.pdfStore.strokes(moved.id).map((x) => x.id), "the moved copy did not open with its own ink").toEqual(["own"]);
		endInSession(next);
	});

	it("the tied copy drawn on before the quit, retirement first: no deleted ink claims the moved copy, both deleted inks are in the trash whole, and the copy's own ink file keeps its stroke", async () => {
		const { v, s: first, x1, x2, tied } = await tiedSetup({ pendingStore: true });
		first.draw(tied.id, stroke(50, "own"));
		await first.store.flush();
		quitThenMoveWhileOff(v, first);
		const next = nextSession(v);
		await settleGrace(next);
		vi.useRealTimers();
		expect(claimersOnDisk(v, [x1, x2], PAIRS), "a deleted ink was moved onto the moved copy").toEqual([]);
		expect(v.trashInk().map((ink) => ink.join(",")).sort(), "the trash holds both deleted inks, strokes whole").toEqual(["ink-0", "ink-1"]);
		expect(v.sidecar(tied.id)?.strokes.map((x) => x.id), "the copy's own ink file lost its stroke").toEqual(["own"]);
	});

	it("the other copy opened first: it opens blank, with neither deleted ink, and after the grace no deleted ink claims it", async () => {
		const { v, s: first, x1, x2 } = await tiedSetup({ pendingStore: true });
		quitThenMoveWhileOff(v, first);
		const next = nextSession(v);
		const other = await next.open(OTHER);
		expect(other.id, "the other copy was handed the first deleted ink").not.toBe(x1);
		expect(other.id, "the other copy was handed the second deleted ink").not.toBe(x2);
		expect(next.pdfStore.strokes(other.id).map((x) => x.id), "the other copy opened wearing ink").toEqual([]);
		next.close(other.root);
		await settleGrace(next);
		vi.useRealTimers();
		expect(claimersOnDisk(v, [x1, x2], OTHER), "a deleted ink was moved onto the other copy").toEqual([]);
		expect(claimersOnDisk(v, [x1, x2], PAIRS), "a deleted ink was moved onto the moved copy").toEqual([]);
	});

	it("retirement first, the other copy: after the grace no deleted ink claims either copy, and the other copy opens blank", async () => {
		const { v, s: first, x1, x2 } = await tiedSetup({ pendingStore: true });
		quitThenMoveWhileOff(v, first);
		const next = nextSession(v);
		await settleGrace(next);
		vi.useRealTimers();
		expect(claimersOnDisk(v, [x1, x2], OTHER), "a deleted ink was moved onto the other copy").toEqual([]);
		await expectBlank(v, OTHER);
	});

	it("the tied copy drawn on before the quit, the other copy opened first: it is handed neither deleted ink, and after the grace no deleted ink claims either copy", async () => {
		const { v, next, other, x1, x2 } = await drawnOnThenOtherOpened();
		expect([x1, x2], "the other copy was handed a deleted ink").not.toContain(other.id);
		next.close(other.root);
		await settleGrace(next);
		vi.useRealTimers();
		expect(claimersOnDisk(v, [x1, x2], OTHER), "a deleted ink was moved onto the other copy").toEqual([]);
		expect(claimersOnDisk(v, [x1, x2], PAIRS), "a deleted ink was moved onto the moved copy").toEqual([]);
	});

	// K453-1 (the claim's old name), not this fix's: the copy's own ink file claims only the gone Inbox/A.pdf, so the
	// first copy of these bytes opened takes it. Pinned as a known failure; it fails today and after this fix. The road
	// and the checks that must hold on it are the cell above; this cell holds the limit's own lines only.
	it.fails("the tied copy drawn on before the quit, the other copy opened first: it opens blank, not with the moved copy's own ink", async () => {
		const { next, other, tied } = await drawnOnThenOtherOpened();
		try {
			expect(other.id, "the other copy adopted the moved copy's own ink").not.toBe(tied.id);
			expect(next.pdfStore.strokes(other.id).map((x) => x.id), "the other copy opened wearing ink").toEqual([]);
		} finally {
			endInSession(next);
		}
	});

	it("both copies tied and held, the first moved while off to a name that pairs it: the next session opens it blank", async () => {
		const { v, s: first, x1, x2 } = await tiedSetup({ pendingStore: true });
		const other = await first.open(OTHER);
		expect(first.pdfStore.strokes(other.id).map((x) => x.id), "precondition: the other copy ties and opens blank too").toEqual([]);
		for (const d of [FIRST, SECOND]) {
			expect(first.pdfStore.heldPaths().get(d)?.has(OTHER), `precondition: the other copy is held for ${d}`).toBe(true);
		}
		quitThenMoveWhileOff(v, first, PAIRS, [TIED, OTHER]);
		const next = nextSession(v);
		const moved = await next.open(PAIRS);
		expect(moved.id, "the moved copy was handed the first deleted ink by name").not.toBe(x1);
		expect(moved.id, "the moved copy was handed the second deleted ink").not.toBe(x2);
		expect(next.pdfStore.strokes(moved.id).map((x) => x.id), "the moved copy opened wearing ink").toEqual([]);
		endInSession(next);
	});

	it("the moved copy opened before the layout is ready: it opens blank, not with the first deleted ink", async () => {
		const { v, s: first, x1, x2 } = await tiedSetup({ pendingStore: true });
		quitThenMoveWhileOff(v, first);
		let start: (() => void) | undefined;
		const next = nextSession(v, (s) => {
			start = s;
		});
		expect(start, "precondition: the grace waits for the layout").toBeDefined();
		const moved = await next.open(PAIRS);
		expect(moved.id, "the moved copy was handed the first deleted ink by name").not.toBe(x1);
		expect(moved.id, "the moved copy was handed the second deleted ink").not.toBe(x2);
		expect(next.pdfStore.strokes(moved.id).map((x) => x.id), "the moved copy opened wearing ink").toEqual([]);
		start!();
		endInSession(next);
	});

	it("moved while off to a name that pairs nothing, and a copy that pairs arrives after the restart inside the grace: it opens blank", async () => {
		const { v, s: first, x1, x2 } = await tiedSetup({ pendingStore: true });
		quitThenMoveWhileOff(v, first, "Inbox/A2.pdf");
		const next = nextSession(v);
		expect(v.files.has(PAIRS), "precondition: the copy that pairs is not in the vault at the restart").toBe(false);
		await vi.advanceTimersByTimeAsync(2_000);
		await next.createFile(PAIRS);
		const late = await next.open(PAIRS);
		expect(late.id, "the late copy was handed the first deleted ink by name").not.toBe(x1);
		expect(late.id, "the late copy was handed the second deleted ink").not.toBe(x2);
		expect(next.pdfStore.strokes(late.id).map((x) => x.id), "the late copy opened wearing ink").toEqual([]);
		endInSession(next);
	});
});

describe("a held copy still in the vault after a restart: the hold counts as before", () => {
	it("CONTROL: the tied copy renamed in session to another file name, a quit, and the vault not yet listing it when the plugin loads: the other copy takes the first deleted ink by name", async () => {
		const { v, s: first, x1 } = await tiedSetup({ pendingStore: true });
		await first.renameFile(TIED, "Inbox/A2.pdf");
		first.pdfStore.cancelPendingDeletes();
		// The vault is still filling its list when the plugin loads: the renamed copy is listed only by layout ready.
		v.files.delete("Inbox/A2.pdf");
		let start: (() => void) | undefined;
		const next = nextSession(v, (s) => {
			start = s;
		});
		v.files.add("Inbox/A2.pdf");
		start!();
		const other = await next.open(OTHER);
		expect(other.id, "the other copy did not pair the first deleted ink by name").toBe(x1);
		expect(next.pdfStore.strokes(other.id).map((x) => x.id)).toEqual(["ink-0"]);
		endInSession(next);
	});
});

/** A third inked PDF of the same bytes, deleted after the restart: no tied open holds anything for it. */
const THIRD = "Old/A.pdf";
/** A copy that arrives after the third deletion: its name scores the same against FIRST and THIRD. */
const LATE = "Spare/A.pdf";

describe("a claim whose hold is gone keeps its place in the pairing: no other claim takes a copy by elimination", () => {
	it("a third ink deleted after the restart and a copy whose name ties it with the first: the copy opens blank, not with the third deleted ink", async () => {
		const v = vault();
		const { s: first, ids: [x1, x2, x3] } = await inked(v, [FIRST, SECOND, THIRD], { pendingStore: true });
		vi.useFakeTimers();
		await deleteBothThenCopies(first);
		await openTied(first, [FIRST, SECOND]);
		quitThenMoveWhileOff(v, first, "Inbox/A2.pdf");
		const next = nextSession(v);
		await vi.advanceTimersByTimeAsync(1_000);
		await next.deleteFile(THIRD);
		expect(next.pdfStore.pendingClaims().has(THIRD), "precondition: the third deletion waits out its grace").toBe(true);
		expect(next.pdfStore.heldPaths().get(THIRD)?.size ?? 0, "precondition: nothing is held for the third deletion").toBe(0);
		await vi.advanceTimersByTimeAsync(1_000);
		await next.createFile(LATE);
		const late = await next.open(LATE);
		expect(late.id, "the late copy was handed the third deleted ink by elimination").not.toBe(x3);
		expect(late.id, "the late copy was handed the first deleted ink").not.toBe(x1);
		expect(late.id, "the late copy was handed the second deleted ink").not.toBe(x2);
		expect(next.pdfStore.strokes(late.id).map((x) => x.id), "the late copy opened wearing ink").toEqual([]);
		endInSession(next);
	});
});

describe("in session: the tied copy deleted inside the grace and not back", () => {
	it("the other copy opens blank, not with the first deleted ink by elimination", async () => {
		const { s, x1, x2, tied } = await tiedSetup();
		s.close(tied.root);
		await s.deleteFile(TIED);
		const other = await s.open(OTHER);
		expect(other.id, "the other copy was handed the first deleted ink by elimination").not.toBe(x1);
		expect(other.id, "the other copy was handed the second deleted ink").not.toBe(x2);
		expect(s.pdfStore.strokes(other.id).map((x) => x.id), "the other copy opened wearing ink").toEqual([]);
		endInSession(s);
	});
});
