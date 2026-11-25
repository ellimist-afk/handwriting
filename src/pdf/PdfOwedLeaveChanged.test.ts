/**
 * A PDF's bytes replaced on disk (a sync bringing a new version, a re-export, another app saving over it) while a leave
 * of its path is owed: a pane shows the ink found for the path, and the blank drawn on before that pane moved (the kept
 * ink) keeps the path. The new version's ink holds what the path keeps: the kept ink's strokes, and those drawn on the
 * found ink since the leave was owed. The found ink's older strokes go to the trash with it, whole, as when no change
 * comes. Also with both panes open, a second change inside the first check, the kept ink unreadable at the check, the
 * found ink read only after the leave was owed, and its move into the trash failing.
 *
 * Through the plugin and the real stores, with an in-memory vault: the harness of PdfOwedLeave.test.ts, copied (its
 * helpers are not exported, and that file is not edited here), with per-path PDF bytes and the vault's modify event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every notice shown, in order. */
const shown = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: string) {
			shown.push(message);
		}
	},
}));

/**
 * The change check's proof that the new bytes are the old version plus our own Flatten (isOwnFlattenOf): the real
 * proof, its promise handed back untouched, unless a cell sets `proof.hold`, which gets the real answer and gives the
 * check its own.
 */
const proof = vi.hoisted(() => ({ hold: undefined as ((answer: Promise<boolean>) => Promise<boolean>) | undefined }));
vi.mock("./PdfFlattenedCopy", async (importOriginal) => {
	const real = await importOriginal<typeof import("./PdfFlattenedCopy")>();
	return {
		...real,
		isOwnFlattenOf: (...a: Parameters<typeof real.isOwnFlattenOf>) => {
			const answer = real.isOwnFlattenOf(...a);
			return proof.hold === undefined ? answer : proof.hold(answer);
		},
	};
});

import HandwritingPlugin from "../main";
import { TFile, Notice } from "obsidian";
import pluginSettingsSource from "../settings/PluginSettings.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { parsePage, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";


// Execute the production host registration, including its load options, rather
// than reconstructing that adapter in this fixture.
const source = pluginSettingsSource.replace(/\r\n/g, "\n");
const hostStart = "\t\tthis.pdfStore.attachHost({";
expect(source.split(hostStart)).toHaveLength(2);
const hostAt = source.indexOf(hostStart);
const hostEnd = source.indexOf("\n\t\t});", hostAt);
expect(hostEnd).toBeGreaterThan(hostAt);
// The host's own notices (blockNotice) go where every notice goes here, so a cell can tell one was shown.
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
	shown.length = 0;
});
afterEach(() => {
	proof.hold = undefined;
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
	/** Bytes a path holds once they changed on disk; any other path holds `pdfBytes`. */
	const bytesAt = new Map<string, Uint8Array>();
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
	return { adapter, pdfBytes, bytesAt, files, local, sidecar, trashInk };
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
	/** The open PDF panes, as the workspace lists them. */
	const leaves: { view: { file: { path: string }; containerEl: HTMLElement } }[] = [];
	const app = {
		vault: {
			adapter: v.adapter,
			getFiles: () => [...v.files].map((path) => ({ path, extension: "pdf" })),
			readBinary: async (file: { path: string }) => (v.bytesAt.get(file.path) ?? v.pdfBytes).slice().buffer,
			getFileByPath: (p: string) => (v.files.has(p) ? { path: p, extension: "pdf" } : null),
			on: (name: string, handler: (...a: unknown[]) => unknown) => {
				vaultOn.set(name, [...(vaultOn.get(name) ?? []), handler]);
				return {};
			},
		},
		workspace: { layoutReady: opts.layoutReady ?? true, getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []) },
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
	// Every check that identifies a PDF's panes again; kept only, so a cell can wait for them.
	const checks: Promise<void>[] = [];
	const check = HandwritingPlugin.prototype.onPdfModified;
	plugin.onPdfModified = (path: string, panes?: ReadonlySet<HTMLElement> | null) => {
		const pass = check.call(plugin, path, panes);
		checks.push(pass);
		return pass;
	};
	// Ink found for a path that leaves it, its pane drawn on before it moved: kept too.
	const leave = (HandwritingPlugin.prototype as any).pairedInkLeaves as ((id: string, path: string, from: string) => Promise<void>) | undefined;
	if (leave) {
		plugin.pairedInkLeaves = (id: string, path: string, from: string) => {
			const left = leave.call(plugin, id, path, from);
			checks.push(left);
			return left;
		};
	}
	installPdfHost.call(plugin, Notice, (message: string) => void shown.push(message));
	plugin.onloadVaultEvents();
	if (opts.pendingStore) plugin.attachPdfPendingDeletes();
	async function open(path: string) {
		expect(v.files.has(path), `precondition: ${path} exists in the vault`).toBe(true);
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, forgetHistory() {}, unmount() {}, idle: true };
		const leaf = { view: { file: { path }, containerEl: root } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId(leaf, root, controller);
		return { root, id: plugin.pdfIds.get(root) as string };
	}
	/** Every check started so far that identifies panes again, finished. */
	async function checked() {
		while (checks.length > 0) await Promise.all(checks.splice(0));
	}
	function close(root: HTMLElement) {
		const at = leaves.findIndex((l) => l.view.containerEl === root);
		if (at >= 0) leaves.splice(at, 1);
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
	/** The vault sends "modify" for the file, as when its bytes changed on disk; every modify handler runs. */
	async function modifyFile(path: string) {
		expect(vaultOn.get("modify")?.length, "precondition: the plugin listens for changes").toBeGreaterThan(0);
		for (const handler of vaultOn.get("modify") ?? []) await handler(pdfFile(path));
	}
	/** The vault moves the file, then every rename handler the plugin registered runs, and any claim move it started. */
	async function renameFile(from: string, to: string) {
		expect(v.files.has(from), `precondition: ${from} exists before the rename`).toBe(true);
		expect(vaultOn.get("rename")?.length, "precondition: the plugin listens for renames").toBeGreaterThan(0);
		v.files.delete(from);
		v.files.add(to);
		for (const leaf of leaves) if (leaf.view.file.path === from) leaf.view.file = { path: to };
		for (const handler of vaultOn.get("rename") ?? []) await handler(pdfFile(to), from);
		await Promise.all(moves.splice(0));
	}
	return { store, pdfStore, plugin, open, close, draw, deleteFile, createFile, renameFile, modifyFile, checked };
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

/**
 * Fake-clock turns of `stepMs` while `waiting` holds, with a real pause of 1 ms after each turn it still holds. A count
 * of fake turns alone was no bound: work that resolves off the fake clock (the PDF's digest, crypto.subtle) lands in
 * real time, so on a loaded run forty turns ran out before an open reached its read. A 0 ms step never moves the fake
 * clock, so it waits up to `realTurns` turns; a longer step keeps the forty, so the fake clock moves as far as before.
 * The pause runs on `realSetTimeout`, the real timer taken when this file loads.
 */
async function turnsWhile(waiting: () => boolean, stepMs = 0, realTurns = 1000): Promise<void> {
	const most = stepMs === 0 ? realTurns : 40;
	for (let i = 0; i < most && waiting(); i++) {
		await vi.advanceTimersByTimeAsync(stepMs);
		if (waiting()) await new Promise<void>((done) => realSetTimeout(done, 1));
	}
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

/** Of the ink files named, those that claim `path` on disk: for preconditions only. */
function claimersAmong(v: ReturnType<typeof vault>, ids: readonly string[], path: string) {
	return ids.filter((id) => v.sidecar(id)?.pdfPaths?.includes(path));
}

/** Every live ink file that claims `path` on disk, named or not (a file that does not parse claims nothing here). */
function claimersOnDisk(v: ReturnType<typeof vault>, path: string) {
	return liveInkFiles(v).filter((id) => {
		try {
			return v.sidecar(id)?.pdfPaths?.includes(path) === true;
		} catch {
			return false;
		}
	});
}

function endInSession(s: ReturnType<typeof session>) {
	s.pdfStore.cancelPendingDeletes();
	vi.useRealTimers();
}

/** TIED's new name, given in Obsidian: it pairs nothing by name. */
const MOVED = "Inbox/A2.pdf";

/**
 * The tied copy renamed in Obsidian (the hold follows it), then a quit inside the grace; at the next launch the vault
 * does not list the renamed copy yet. Returns the next session, its layout not ready (call `start` for that), with
 * the renamed copy listed again by `list`.
 */
async function renamedThenRelaunchedUnlisted() {
	const { v, s: first, x1, x2 } = await tiedSetup({ pendingStore: true });
	await first.renameFile(TIED, MOVED);
	for (const d of [FIRST, SECOND]) {
		expect(first.pdfStore.heldPaths().get(d)?.has(MOVED), `precondition: the hold for ${d} followed the rename`).toBe(true);
	}
	first.pdfStore.cancelPendingDeletes();
	const saved = JSON.parse(v.local.get(PENDING_KEY) as string) as { path: string; held?: string[] }[];
	for (const d of [FIRST, SECOND]) {
		expect(saved.find((e) => e.path === d)?.held, `precondition: the hold for ${d} was saved under the new name`).toEqual([MOVED]);
	}
	// The vault is still filling its list when the plugin loads: the renamed copy is listed only by layout ready.
	v.files.delete(MOVED);
	let start: (() => void) | undefined;
	const next = nextSession(v, (s) => {
		start = s;
	});
	expect(start, "precondition: the grace waits for the layout").toBeDefined();
	function layoutReady() {
		v.files.add(MOVED);
		start!();
	}
	return { v, next, x1, x2, layoutReady };
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

/** Each check that identifies a pane again settles and ends, and what it starts. */
async function movesSettled(s: ReturnType<typeof session>) {
	await vi.advanceTimersByTimeAsync(3_001);
	await s.checked();
	await s.pdfStore.settle();
	await s.store.flush();
}

/** The copy's name after a rename while the leave is owed: it pairs nothing by name. */
const NEW = "Archive/A3.pdf";
/** The copy's name after a second rename, inside one read of the found ink. */
const NEWER = "Archive/A4.pdf";
/** The real timer, taken before any cell fakes the clock. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const ROADS_RENAMED = ["owed, kept pane open", "run going, kept pane open", "owed, kept pane closed", "owed, kept pane open, renamed twice in one read"] as const;
type RenamedRoad = (typeof ROADS_RENAMED)[number];

/**
 * The setup of the cell at PdfTiedHoldOpenedBeforeListFull.test.ts:639 up to its stroke on the first pane: the other
 * copy opened before the vault lists every file (pane 1, on a blank), then after the layout is ready in a second pane,
 * on the first deleted ink; a stroke on pane 1 before it moves. The second pane still shows the first deleted ink, so
 * its leave of the copy is owed. Still inside the grace; `settle` runs it out as the :639 cell does.
 */
async function owedLeave(opts: { settle: boolean; twin?: boolean }) {
	const { v, next, x1, x2, layoutReady } = await renamedThenRelaunchedUnlisted();
	// The fields of the deletions as saved at the earlier quit, before any leave was owed.
	const pendingFields = new Set((JSON.parse(v.local.get(PENDING_KEY) as string) as Record<string, unknown>[]).flatMap((e) => Object.keys(e)));
	const early = await next.open(OTHER);
	layoutReady();
	const second = await next.open(OTHER);
	expect(second.id, "precondition: the second pane opened on the first deleted ink").toBe(x1);
	// `twin`: one more pane on the copy, opened beside the second before the stroke, on the same ink.
	const twin = opts.twin ? await next.open(OTHER) : undefined;
	if (twin) expect(twin.id, "precondition: the twin pane opened on the first deleted ink").toBe(x1);
	expect(next.plugin.pdfIds.get(early.root), "precondition: the first pane is still on its blank").toBe(early.id);
	next.draw(early.id, stroke(60, "own"));
	await next.store.flush();
	await vi.advanceTimersByTimeAsync(1_001);
	await next.checked();
	if (opts.settle) {
		await settleGrace(next);
		await movesSettled(next);
	}
	const secondAt = next.plugin.pdfIds.get(second.root) as string;
	expect(secondAt, "precondition: the second pane still shows the first deleted ink").toBe(x1);
	expect(next.pdfStore.strokes(secondAt).map((x) => x.id), "precondition: the second pane shows the first deleted ink").toEqual(["ink-0"]);
	expect(next.pdfStore.strokes(early.id).map((x) => x.id), "precondition: the first pane shows its stroke").toEqual(["own"]);
	return { v, next, x1, x2, early, second, secondAt, twin, pendingFields };
}

/** The second pane closed as the workspace closes a pane: it leaves the plugin's panes, and its id is released. */
async function closeSecond(next: ReturnType<typeof session>, second: { root: HTMLElement }, secondAt: string) {
	next.close(second.root);
	next.plugin.releasePdfId(secondAt);
	await movesSettled(next);
	await movesSettled(next);
}

/** The ink folder listed in plain name order (as NTFS lists it), or in the reverse of that. */
type ListOrder = "name order" | "reverse name order";
function listInOrder(s: ReturnType<typeof session>, order: ListOrder) {
	const list = s.store.listIds.bind(s.store);
	s.store.listIds = (async (prefix: string) => {
		const ids = [...(await list(prefix))].sort((a, b) => (`${a}.json` < `${b}.json` ? -1 : `${a}.json` > `${b}.json` ? 1 : 0));
		return order === "name order" ? ids : ids.reverse();
	}) as typeof s.store.listIds;
	return s;
}

const ORDERS = ["name order", "reverse name order"] as const;

/** A quit: saves land, the plugin unloads, the deletions in their grace are saved as they stand. */
async function quit(s: ReturnType<typeof session>) {
	await s.store.flush();
	s.plugin.unloaded = true;
	s.pdfStore.cancelPendingDeletes();
}

/** The next launch over the vault, the ink folder listed in `order`, opening the copy; every grace and check run out. */
async function relaunchOpen(v: ReturnType<typeof vault>, order: ListOrder, path = OTHER) {
	const s = listInOrder(session(v, { pendingStore: true }), order);
	const opened = await s.open(path);
	await settleGrace(s);
	await movesSettled(s);
	await movesSettled(s);
	return { s, opened };
}

/** The ink a later session opens the path with, the ink folder listed in `order`. */
async function restartStrokes(v: ReturnType<typeof vault>, order: ListOrder, path = OTHER) {
	const later = listInOrder(session(v), order);
	const opened = await later.open(path);
	return { id: opened.id, strokes: later.pdfStore.strokes(opened.id).map((x) => x.id).sort() };
}

/** Every live ink file's id: in an ink folder, not in the trash. */
function liveInkFiles(v: ReturnType<typeof vault>): string[] {
	return [...v.adapter.files.keys()]
		.filter((p) => p.startsWith(".handwriting/") && p.endsWith(".json") && !p.includes("/trash/"))
		.map((p) => (p.split("/").pop() as string).slice(0, -".json".length))
		.filter((id) => id.startsWith("pdf-"))
		.sort();
}

/**
 * The move of `x1`'s live file into the trash failing once, as a sync tool or a virus scanner holding the file makes
 * it fail: the vault's rename throws, and the store logs that and resolves, the file still live. The leave's own
 * waits go on past it.
 */
function removeFailsOnce(next: ReturnType<typeof session>, x1: string, times = 1) {
	const adapter = (next.store as unknown as { app: { vault: { adapter: FakeAdapter } } }).app.vault.adapter;
	const rename = adapter.rename.bind(adapter);
	const state = { failed: false, left: times };
	adapter.rename = async (from: string, to: string) => {
		if (state.left > 0 && from === `.handwriting/${x1}.json` && to.includes("/trash/")) {
			state.failed = true;
			state.left--;
			throw new Error("the ink file could not be moved to the trash");
		}
		return rename(from, to);
	};
	vi.spyOn(console, "error").mockImplementation(() => {});
	return state;
}

/** Every check and wait run out three times over; a failure met there is the cell's own, and the waits go on. */
async function settledPastFailure(next: ReturnType<typeof session>, failure: RegExp = /could not be (moved to the trash|read)/) {
	for (let i = 0; i < 3; i++) {
		try {
			await movesSettled(next);
		} catch (e) {
			expect(String(e), "the waits met another error than the failed one").toMatch(failure);
		}
	}
}

/** The found ink, as it was at the let-go, is in the trash whole and no longer live. */
function foundInTrashWhole(v: ReturnType<typeof vault>, x1: string, strokes: readonly string[]) {
	expect(v.sidecar(x1), "the found ink's file is still live").toBeUndefined();
	expect(v.trashInk().map((t) => [...t].sort()), "the found ink is not in the trash whole").toContainEqual([...strokes].sort());
}

const OWED_KEY = "handwriting-pdf-owed-leaves";
const CARRIED_NOTICE = "Handwriting: this PDF changed on disk. Your ink was carried over to its new version.";

/** New bytes for `path`, another version of the same document: a new content family, so a new ink id. */
function changeBytes(v: ReturnType<typeof vault>, path: string, fill: string) {
	v.bytesAt.set(path, new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + fill.repeat(5000) + "\n%%EOF\n"));
}

/** The bytes of `path` change on disk and the vault says so; the check's settle runs out, and what it starts. */
async function changedOnDisk(next: ReturnType<typeof session>, v: ReturnType<typeof vault>, path: string, fill: string) {
	changeBytes(v, path, fill);
	await next.modifyFile(path);
	await movesSettled(next);
	await movesSettled(next);
}

/** The kept ink's pane closed as the workspace closes a pane, and its record let go. */
async function closeKept(next: ReturnType<typeof session>, early: { root: HTMLElement; id: string }) {
	next.close(early.root);
	next.plugin.releasePdfId(early.id);
	await movesSettled(next);
	expect(next.pdfStore.generation(early.id), "precondition: the kept ink's record was let go with its pane").toBeNull();
}

/** Every read of `id`'s ink file fails while `failing.on` holds, as a file held by another program fails. */
function readFails(v: ReturnType<typeof vault>, id: string) {
	const read = v.adapter.read.bind(v.adapter);
	const failing = { on: true, reads: 0 };
	v.adapter.read = (async (p: string) => {
		if (failing.on && p === `.handwriting/${id}.json`) {
			failing.reads++;
			throw new Error("the ink file could not be read");
		}
		return read(p);
	}) as typeof v.adapter.read;
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	return failing;
}

/**
 * An order a device can take, held at each step, with no sleep. The found ink's leave run, which the check's let-go of
 * the found ink starts, has its first read of the kept ink's file answer only once the check has ended. A let-go of the
 * kept ink by the check (its record saved, then forgotten) is held once its save is done, until the leave run has read
 * the kept ink in and found it ready. Then both answer, the leave run's read in first: the let-go forgets the kept ink
 * just after the leave run found it ready, and before the run carries into it. A check that takes no record of the kept
 * ink makes no such let-go, and the leave run goes on unheld once its first read answers. Each read and save is made
 * when asked, so it answers what the file held then; only when it answers moves. `run` says whether a let-go was held.
 */
function letGoInsideTheLeave(next: ReturnType<typeof session>, x1: string, kept: string) {
	const { plugin, store, pdfStore } = next;
	const step = () => {
		let open!: () => void;
		const until = new Promise<void>((done) => (open = done));
		return { asked: false, held: false, until, open };
	};
	const leaveRead = step();
	const letGo = step();
	const readIn = step();
	// The found ink's let-go starts its leave run, whose first read is asked before the let-go returns.
	let lettingGo = false;
	const release = plugin.releasePdfId as (id: string) => void;
	plugin.releasePdfId = (id: string) => {
		if (id !== x1) return release.call(plugin, id);
		lettingGo = true;
		try {
			return release.call(plugin, id);
		} finally {
			lettingGo = false;
		}
	};
	const readPdfPaths = store.readPdfPaths.bind(store);
	store.readPdfPaths = (async (id: string) => {
		const hold = lettingGo && id === kept && !leaveRead.asked;
		if (hold) leaveRead.asked = true;
		const paths = await readPdfPaths(id);
		if (hold) {
			leaveRead.held = true;
			await leaveRead.until;
		}
		return paths;
	}) as typeof store.readPdfPaths;
	// The let-go's save: the kept ink's record held, before anything is carried into it.
	const flushPage = store.flushPage.bind(store);
	store.flushPage = (async (id: string) => {
		const hold = id === kept && leaveRead.held && !letGo.asked && pdfStore.generation(kept) !== null && !idsOf(next, kept).includes("late");
		if (hold) letGo.asked = true;
		const ok = await flushPage(id);
		if (hold) {
			letGo.held = true;
			await letGo.until;
		}
		return ok;
	}) as typeof store.flushPage;
	// The leave run's read-in of the kept ink, the record ready when asked.
	const ensureLoaded = pdfStore.ensureLoaded.bind(pdfStore);
	pdfStore.ensureLoaded = async (id: string) => {
		const hold = id === kept && letGo.held && !readIn.asked && pdfStore.inkReady(kept);
		if (hold) readIn.asked = true;
		const changed = await ensureLoaded(id);
		if (hold) {
			readIn.held = true;
			await readIn.until;
		}
		return changed;
	};
	const checks = { started: 0, ended: 0 };
	const onPdfModified = plugin.onPdfModified as (path: string, panes?: ReadonlySet<HTMLElement> | null) => Promise<void>;
	plugin.onPdfModified = (path: string, panes?: ReadonlySet<HTMLElement> | null) => {
		const pass = onPdfModified.call(plugin, path, panes);
		checks.started++;
		pass.then(
			() => void checks.ended++,
			() => void checks.ended++
		);
		return pass;
	};
	return {
		async run(): Promise<boolean> {
			await vi.advanceTimersByTimeAsync(3_001);
			await turnsWhile(() => !(leaveRead.held && checks.started > 0 && checks.ended === checks.started && (pdfStore.generation(kept) === null || letGo.held)), 0);
			expect(leaveRead.held, "precondition: the leave run's first read of the kept ink's file is held").toBe(true);
			expect(checks.started > 0 && checks.ended === checks.started, "precondition: the check ended while that read was held").toBe(true);
			const letGoMade = letGo.held;
			leaveRead.open();
			if (letGoMade) {
				await turnsWhile(() => !readIn.held && plugin.pdfLeaving(x1) === true, 0);
				expect(readIn.held, "precondition: the leave run read the kept ink in while the check's let-go of it was held").toBe(true);
			}
			readIn.open();
			letGo.open();
			return letGoMade;
		},
	};
}

/** The leaves saved as owed for the found ink off the copy, from the kept ink. */
function savedOwed(v: ReturnType<typeof vault>, x1: string, from: string) {
	const saved = JSON.parse((v.local.get(OWED_KEY) as string | undefined) ?? "[]") as { id: string; path: string; from: string; had?: string[] }[];
	return saved.filter((e) => e.id === x1 && e.path === OTHER && e.from === from);
}

/** The ids of the strokes `id` holds in memory, sorted. */
function idsOf(s: ReturnType<typeof session>, id: string): string[] {
	return s.pdfStore.strokes(id).map((x) => x.id).sort();
}

describe("the PDF's bytes changed on disk while a leave of its path is owed", () => {
	it("the kept ink's pane closed, a stroke on the found ink since the owe: the new version's ink holds the kept ink's strokes and that stroke, the found ink in the trash whole; the same after the second pane closes and after a relaunch", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "late"));
		await next.store.flush();
		await closeKept(next, early);
		expect(v.local.has(OWED_KEY), "precondition: the leave is owed").toBe(true);
		shown.length = 0;
		await changedOnDisk(next, v, OTHER, "y");
		const now = next.plugin.pdfIds.get(second.root) as string;
		expect(now, "precondition: the second pane was identified again onto the new version's ink").toBeDefined();
		expect([x1, early.id], "the second pane is not on the new version's ink").not.toContain(now);
		expect(idsOf(next, now), "the new version's ink does not hold the kept ink's strokes and the stroke drawn since the owe").toEqual(["late", "own"]);
		expect(shown, "no notice that the ink was carried").toContain(CARRIED_NOTICE);
		await next.store.flush();
		expect(v.sidecar(now)?.strokes.map((x) => x.id).sort(), "the new version's ink file does not hold them").toEqual(["late", "own"]);
		foundInTrashWhole(v, x1, ["ink-0", "late"]);
		expect(v.local.has(OWED_KEY), "the leave is still owed").toBe(false);
		next.close(second.root);
		next.plugin.releasePdfId(now);
		await movesSettled(next);
		vi.useRealTimers();
		await next.store.flush();
		expect(v.sidecar(now)?.strokes.map((x) => x.id).sort(), "after the second pane closed, the new version's ink file changed").toEqual(["late", "own"]);
		const later = session(v);
		const opened = await later.open(OTHER);
		expect(opened.id, "after a relaunch the PDF does not open on the new version's ink").toBe(now);
		expect(idsOf(later, opened.id), "after a relaunch the PDF does not open with the kept ink's strokes and the late stroke").toEqual(["late", "own"]);
	});

	it("both panes open, a stroke on the found ink since the owe: both panes on the new version's ink, which holds the kept ink's strokes and that stroke once each, not the found ink's older strokes; the found ink in the trash whole", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "late"));
		await next.store.flush();
		await changedOnDisk(next, v, OTHER, "y");
		const a = next.plugin.pdfIds.get(early.root) as string;
		const b = next.plugin.pdfIds.get(second.root) as string;
		expect(a, "precondition: the first pane was identified again").toBeDefined();
		expect(b, "the two panes are not on one ink").toBe(a);
		expect([x1, early.id], "the panes are not on the new version's ink").not.toContain(a);
		const held = next.pdfStore.strokes(a).map((x) => x.id);
		expect(held.length, "a stroke is held twice").toBe(new Set(held).size);
		expect([...held].sort(), "the new version's ink does not hold the kept ink's strokes and the late stroke only").toEqual(["late", "own"]);
		vi.useRealTimers();
		await next.store.flush();
		expect(v.sidecar(a)?.strokes.map((x) => x.id).sort(), "the new version's ink file does not hold them once each").toEqual(["late", "own"]);
		await vi.waitFor(() => foundInTrashWhole(v, x1, ["ink-0", "late"]));
	});

	it("the kept ink's file unreadable at the check and from then on: no stroke goes to the trash, the leave stays owed; the new version shows the stroke drawn on the found ink since the owe", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "late"));
		await next.store.flush();
		await closeKept(next, early);
		const failing = readFails(v, early.id);
		const trashBefore = v.trashInk().length;
		await changedOnDisk(next, v, OTHER, "y");
		await movesSettled(next);
		vi.useRealTimers();
		await next.store.flush();
		expect(failing.reads, "precondition: the kept ink's file was read and failed").toBeGreaterThan(0);
		const now = next.plugin.pdfIds.get(second.root) as string;
		expect([x1, early.id], "the second pane is not on the new version's ink").not.toContain(now);
		expect(v.trashInk().length, "an ink file went to the trash while the kept ink could not be read").toBe(trashBefore);
		expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "the found ink's file changed or left").toEqual(["ink-0", "late"]);
		expect(v.local.has(OWED_KEY), "the leave is not owed any more").toBe(true);
		expect(idsOf(next, now), "the new version's ink does not hold the late stroke alone").toEqual(["late"]);
		expect(shown.filter((m) => m.includes("could not be read")), "a notice said an ink file could not be read, the pane on another").toEqual([]);
		failing.on = false;
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id), "the kept ink's file changed").toEqual(["own"]);
	});

	it("the kept ink's file unreadable at the check, readable at the next launch: the leave runs then; the late stroke is in the new version's ink, the kept ink's own stroke stays in its file, the found ink in the trash whole", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "late"));
		await next.store.flush();
		await closeKept(next, early);
		const failing = readFails(v, early.id);
		await changedOnDisk(next, v, OTHER, "y");
		const now = next.plugin.pdfIds.get(second.root) as string;
		expect(shown.filter((m) => m.includes("could not be read")), "a notice said an ink file could not be read, the pane on another").toEqual([]);
		await quit(next);
		vi.useRealTimers();
		failing.on = false;
		expect(v.local.has(OWED_KEY), "precondition: the leave is owed at the quit").toBe(true);
		vi.useFakeTimers();
		const launch = listInOrder(session(v, { pendingStore: true }), "name order");
		await settleGrace(launch);
		await movesSettled(launch);
		await movesSettled(launch);
		vi.useRealTimers();
		await launch.store.flush();
		await vi.waitFor(() => foundInTrashWhole(v, x1, ["ink-0", "late"]));
		expect(v.sidecar(now)?.strokes.map((x) => x.id).sort(), "the new version's ink file does not hold the late stroke").toEqual(["late"]);
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the kept ink's file lost a stroke").toEqual(["late", "own"]);
		expect(v.local.has(OWED_KEY), "the leave is still owed after it ran").toBe(false);
	});

	it("a second change while the first check's identification of the second pane is still out: the newest version's ink holds the kept ink's strokes and the late stroke, not the found ink's older strokes", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "late"));
		await next.store.flush();
		await closeKept(next, early);
		// The first check's read of the new bytes held: its identification of the second pane is out.
		const app = next.plugin.app as { vault: { readBinary: (f: { path: string }) => Promise<ArrayBuffer> } };
		const readBinary = app.vault.readBinary;
		let release!: () => void;
		const gate = new Promise<void>((done) => (release = done));
		const hold = { armed: true, held: false };
		app.vault.readBinary = async (f: { path: string }) => {
			if (hold.armed && f.path === OTHER) {
				hold.armed = false;
				hold.held = true;
				await gate;
			}
			return readBinary(f);
		};
		changeBytes(v, OTHER, "y");
		await next.modifyFile(OTHER);
		await turnsWhile(() => !hold.held, 100);
		expect(hold.held, "precondition: the first check's identification is held at its read").toBe(true);
		expect(next.plugin.pdfIds.get(second.root), "precondition: the second pane has no id while it is identified").toBeUndefined();
		// The second change's check meets the pane while the first check's identification is out, and takes over what that
		// check took for it; only then does the first read go on. Every check is waited for after the release: waited for
		// before it, the first check never ends.
		const tokens = next.plugin.pdfResolveTokens as WeakMap<HTMLElement, object>;
		const firstToken = tokens.get(second.root);
		changeBytes(v, OTHER, "z");
		await next.modifyFile(OTHER);
		await turnsWhile(() => tokens.get(second.root) === firstToken, 100);
		expect(tokens.get(second.root), "precondition: the second check started its own identification of the second pane").not.toBe(firstToken);
		release();
		await movesSettled(next);
		await movesSettled(next);
		vi.useRealTimers();
		await next.store.flush();
		const now = next.plugin.pdfIds.get(second.root) as string;
		expect([x1, early.id], "the second pane is not on the newest version's ink").not.toContain(now);
		expect(idsOf(next, now), "the newest version's ink does not hold the kept ink's strokes and the late stroke only").toEqual(["late", "own"]);
		await vi.waitFor(() => foundInTrashWhole(v, x1, ["ink-0", "late"]));
	});

	it("the leave owed while the found ink was not read, the change check meeting its pane once it is read and before what it held at the owe is known: the new version's ink holds the kept ink's strokes and the stroke drawn since the owe, not the found ink's older strokes", async () => {
		const { v, next, x1, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		layoutReady();
		// The setup of PdfOwedLeave.test.ts's cell on a leave owed while a pane's read of the found ink is out: the second
		// pane closes before its check and the copy opens again on the found ink, that read held.
		const first = await next.open(OTHER);
		expect(first.id, "precondition: the second pane opened on the found ink").toBe(x1);
		next.draw(early.id, stroke(60, "own"));
		await next.store.flush();
		next.close(first.root);
		next.plugin.releasePdfId(x1);
		await turnsWhile(() => next.pdfStore.generation(x1) !== null, 0);
		expect(next.pdfStore.generation(x1), "precondition: the found ink's record was let go with its pane").toBeNull();
		expect(v.local.has(OWED_KEY), "precondition: nothing owed before the check").toBe(false);
		expect(claimersOnDisk(v, OTHER).sort(), "precondition: both ink files claim the copy on disk").toEqual([early.id, x1].sort());
		listInOrder(next, "reverse name order");
		const load = next.store.load.bind(next.store);
		let release!: () => void;
		const gate = new Promise<void>((done) => (release = done));
		const held = { x1: false };
		next.store.load = (async (id: string, ...rest: unknown[]) => {
			if (id === x1 && !held.x1) {
				held.x1 = true;
				await gate;
			}
			return (load as (...a: unknown[]) => Promise<unknown>)(id, ...rest);
		}) as typeof next.store.load;
		// What the found ink held at the owe is taken once its read lands, after a wait on the store's reads (baseAtLoad).
		// That one wait held: the read lands, and what it held at the owe stays unknown until the wait goes on.
		const settle = next.pdfStore.settle.bind(next.pdfStore);
		let releaseHad!: () => void;
		const hadGate = new Promise<void>((done) => (releaseHad = done));
		const hadHold = { armed: true, held: false };
		next.pdfStore.settle = (async (maxWaitMs?: number) => {
			if (hadHold.armed && v.local.has(OWED_KEY) && !next.pdfStore.inkReady(x1)) {
				hadHold.armed = false;
				hadHold.held = true;
				await hadGate;
			}
			return settle(maxWaitMs);
		}) as typeof next.pdfStore.settle;
		const opening = next.open(OTHER);
		await turnsWhile(() => !held.x1, 0);
		expect(held.x1, "precondition: the reopened pane's read of the found ink is held").toBe(true);
		await turnsWhile(() => !v.local.has(OWED_KEY), 100);
		expect(v.local.has(OWED_KEY), "precondition: the leave is owed").toBe(true);
		expect(next.pdfStore.inkReady(x1), "precondition: the leave was owed with the found ink not read").toBe(false);
		expect(hadHold.held, "precondition: the wait for what the found ink held at the owe is held").toBe(true);
		release();
		const second = await opening;
		expect(second.id, "precondition: the reopened pane opened on the found ink").toBe(x1);
		await next.checked();
		await settleGrace(next);
		await movesSettled(next);
		const secondAt = next.plugin.pdfIds.get(second.root) as string;
		expect(secondAt, "precondition: the second pane still shows the found ink").toBe(x1);
		expect(next.pdfStore.inkReady(x1), "precondition: the found ink is read").toBe(true);
		expect(idsOf(next, x1), "precondition: the second pane shows the found ink").toEqual(["ink-0"]);
		expect(savedOwed(v, x1, early.id), "precondition: the leave is saved as owed once").toHaveLength(1);
		expect(savedOwed(v, x1, early.id)[0]?.had, "precondition: what the found ink held at the owe is known").toBeUndefined();
		next.draw(secondAt, stroke(61, "late"));
		await next.store.flush();
		await closeKept(next, early);
		changeBytes(v, OTHER, "y");
		await next.modifyFile(OTHER);
		await turnsWhile(() => next.plugin.pdfIds.get(second.root) === x1, 100);
		expect(next.plugin.pdfIds.get(second.root), "precondition: the change check met the second pane").not.toBe(x1);
		expect(savedOwed(v, x1, early.id)[0]?.had, "precondition: the check met the pane after what the found ink held at the owe was known").toBeUndefined();
		// What the found ink held at the owe stays unknown while the check has every other read it makes: a check that
		// does not wait for it carries now, and the new version's ink holds a stroke before it is known.
		const met = next.plugin.pdfIds.get(second.root) as string;
		await turnsWhile(() => idsOf(next, met).length === 0, 0, 60);
		expect(idsOf(next, met), "the check carried before what the found ink held at the owe was known").toEqual([]);
		releaseHad();
		await movesSettled(next);
		await movesSettled(next);
		vi.useRealTimers();
		await next.store.flush();
		const now = next.plugin.pdfIds.get(second.root) as string;
		expect([x1, early.id], "the second pane is not on the new version's ink").not.toContain(now);
		expect(idsOf(next, now), "the new version's ink does not hold the kept ink's strokes and the late stroke only").toEqual(["late", "own"]);
		await vi.waitFor(() => foundInTrashWhole(v, x1, ["ink-0", "late"]));
	});

	it("the kept ink's pane closed, a stroke on the found ink since the owe, the found ink's move into the trash failing once at its let-go after the check: the new version's ink holds the kept ink's strokes and that stroke once each, the found ink's file live and claiming the copy, its leave owed and saved; at the next launch the leave runs with no stroke twice", async () => {
		await failedMoveThenLaunch(false);
	});

	it("the same with the leave run's first read of the kept ink's file answered once the check ended, and any let-go of the kept ink by the check held after its save until the leave run found the kept ink read in: the kept ink's file keeps its own stroke, the late one and its claim through the check and the leave run, and the leave runs at the next launch", async () => {
		await failedMoveThenLaunch(true);
	});

	async function failedMoveThenLaunch(raced: boolean) {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "late"));
		await next.store.flush();
		await closeKept(next, early);
		const race = raced ? letGoInsideTheLeave(next, x1, early.id) : undefined;
		const fail = removeFailsOnce(next, x1);
		changeBytes(v, OTHER, "y");
		await next.modifyFile(OTHER);
		if (race) await race.run();
		await settledPastFailure(next);
		expect(fail.failed, "precondition: the found ink's move into the trash failed").toBe(true);
		const now = next.plugin.pdfIds.get(second.root) as string;
		expect([x1, early.id], "the second pane is not on the new version's ink").not.toContain(now);
		const held = next.pdfStore.strokes(now).map((x) => x.id);
		expect(held.length, "a stroke is held twice in the new version's ink").toBe(new Set(held).size);
		expect([...held].sort(), "the new version's ink does not hold the kept ink's strokes and the late stroke").toEqual(["late", "own"]);
		expect.soft(savedOwed(v, x1, early.id), "after the failed move, the leave is not saved as owed").toHaveLength(1);
		expect.soft(v.sidecar(x1)?.pdfPaths, "after the failed move, the found ink's file is not live claiming the copy").toEqual([OTHER]);
		expect.soft(next.plugin.pdfLeftForTrash(x1), "after the failed move, the found ink is taken as gone to the trash").toBe(false);
		// The leave run carried the late stroke into the kept ink and saved it there, beside its own, with its claim.
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "before the quit, the kept ink's file does not hold its own stroke and the late one").toEqual(["late", "own"]);
		expect(v.sidecar(early.id)?.pdfPaths, "before the quit, the kept ink's file does not claim the copy").toEqual([OTHER]);
		await quit(next);
		const { s, opened } = await relaunchOpen(v, "name order");
		vi.useRealTimers();
		expect(opened.id, "after the launch the copy does not open on the new version's ink").toBe(now);
		await vi.waitFor(() => foundInTrashWhole(v, x1, ["ink-0", "late"]));
		await s.store.flush();
		for (const [id, name] of [[now, "the new version's"], [early.id, "the kept"]] as const) {
			const ids = v.sidecar(id)?.strokes.map((x) => x.id) ?? [];
			expect(ids.length, `after the launch a stroke is twice in ${name} ink file`).toBe(new Set(ids).size);
		}
		expect(v.sidecar(now)?.strokes.map((x) => x.id).sort(), "after the launch the new version's ink file does not hold the kept ink's strokes and the late stroke").toEqual(["late", "own"]);
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "after the launch the kept ink's file does not hold its own stroke and the late one").toEqual(["late", "own"]);
		expect(savedOwed(v, x1, early.id), "after the launch the leave is still owed").toHaveLength(0);
	}

	it("the kept ink's pane closed, a stroke on the found ink since the owe, the leave run carrying that stroke into the kept ink and ending while the check reads the kept ink's file: the new version's ink holds the kept ink's strokes and that stroke, the found ink in the trash whole", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "late"));
		await next.store.flush();
		await closeKept(next, early);
		// The check's own read of the kept ink's file (not the leave run's) answers what the file held when it was asked,
		// once the leave run has carried the late stroke into the kept ink, saved it, and let it go.
		const read = v.adapter.read.bind(v.adapter);
		let release!: () => void;
		const gate = new Promise<void>((done) => (release = done));
		const check = { held: false, late: false };
		v.adapter.read = (async (p: string) => {
			const byCheck = (new Error().stack ?? "").includes("keptOnItsOwn");
			const text = await read(p);
			if (!check.held && byCheck && p === `.handwriting/${early.id}.json`) {
				check.held = true;
				check.late = text.includes('"late"');
				await gate;
			}
			return text;
		}) as typeof v.adapter.read;
		changeBytes(v, OTHER, "y");
		await next.modifyFile(OTHER);
		// The change settles first (the check starts once the file is still); a check that never reads the kept ink's file
		// on its own fails on the precondition below, not on the test's time limit.
		await vi.advanceTimersByTimeAsync(1_001);
		await turnsWhile(() => !check.held, 0, 200);
		expect(check.held, "precondition: the check's read of the kept ink's file is held").toBe(true);
		expect(check.late, "precondition: the check read the kept ink's file before the late stroke was saved into it").toBe(false);
		await turnsWhile(() => !(savedOwed(v, x1, early.id).length === 0 && next.pdfStore.generation(early.id) === null), 100);
		expect(savedOwed(v, x1, early.id), "precondition: the leave run ended while the check read the kept ink's file").toHaveLength(0);
		expect(next.pdfStore.generation(early.id), "precondition: the leave run let the kept ink go").toBeNull();
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "precondition: the leave run saved the late stroke into the kept ink").toEqual(["late", "own"]);
		release();
		await movesSettled(next);
		await movesSettled(next);
		vi.useRealTimers();
		await next.store.flush();
		const now = next.plugin.pdfIds.get(second.root) as string;
		expect([x1, early.id], "the second pane is not on the new version's ink").not.toContain(now);
		expect(idsOf(next, now), "the new version's ink does not hold the kept ink's strokes and the late stroke").toEqual(["late", "own"]);
		foundInTrashWhole(v, x1, ["ink-0", "late"]);
	});

	it("the kept ink's pane closed, its file written by a newer build, a stroke on the found ink since the owe: the check carries none of the kept ink's strokes; the new version's ink holds that stroke only, the kept ink's file stays as the newer build wrote it, the leave stays owed", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "late"));
		await next.store.flush();
		await closeKept(next, early);
		// The same strokes under a schema this build does not read. The store refuses to write such an ink, and a record
		// read from it is not ready, so a carry off it is refused as unsound.
		const p = `.handwriting/${early.id}.json`;
		const raw = JSON.parse(v.adapter.files.get(p) as string) as Record<string, unknown>;
		raw.schemaVersion = 99;
		const newer = JSON.stringify(raw);
		v.adapter.files.set(p, newer);
		expect(parsePage(newer, early.id).futureVersion, "precondition: the kept ink's file reads as a newer build's").toBe(99);
		await changedOnDisk(next, v, OTHER, "y");
		const now = next.plugin.pdfIds.get(second.root) as string;
		expect([x1, early.id], "precondition: the second pane is on the new version's ink").not.toContain(now);
		expect(idsOf(next, now), "the change check carried a newer build's ink into the new version's ink").toEqual(["late"]);
		vi.useRealTimers();
		await next.store.flush();
		expect(v.adapter.files.get(p), "the kept ink's file is not as the newer build wrote it").toBe(newer);
		expect(savedOwed(v, x1, early.id), "the leave is not owed still").toHaveLength(1);
	});

	it("the kept ink's pane closed with every save of the kept ink answering only once the check has ended, a stroke on the found ink since the owe: the check carries the kept ink's strokes from its record, still read in; the new version's ink holds them and that stroke once each, the found ink in the trash whole", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "late"));
		await next.store.flush();
		// A slow disk: each save of the kept ink is made when asked, and only its answer waits for the check's end. The
		// close's let-go forgets the record after its save answers, and so does the leave run's, so the record stays read
		// in through the check.
		const flushPage = next.store.flushPage.bind(next.store);
		let answer!: () => void;
		const checkEnded = new Promise<void>((done) => (answer = done));
		const saves = { held: 0 };
		next.store.flushPage = (async (id: string) => {
			const ok = await flushPage(id);
			if (id === early.id) {
				saves.held++;
				await checkEnded;
			}
			return ok;
		}) as typeof next.store.flushPage;
		const checks = { started: 0, ended: 0 };
		const onPdfModified = next.plugin.onPdfModified as (path: string, panes?: ReadonlySet<HTMLElement> | null) => Promise<void>;
		next.plugin.onPdfModified = (path: string, panes?: ReadonlySet<HTMLElement> | null) => {
			const pass = onPdfModified.call(next.plugin, path, panes);
			checks.started++;
			pass.then(
				() => void checks.ended++,
				() => void checks.ended++
			);
			return pass;
		};
		next.close(early.root);
		next.plugin.releasePdfId(early.id);
		await vi.advanceTimersByTimeAsync(3_001);
		await turnsWhile(() => saves.held === 0, 0, 200);
		expect(saves.held, "precondition: the save at the kept ink's let-go is held").toBe(1);
		expect(next.pdfStore.inkReady(early.id), "precondition: the kept ink's record is read in with its pane closed").toBe(true);
		changeBytes(v, OTHER, "y");
		await next.modifyFile(OTHER);
		await vi.advanceTimersByTimeAsync(3_001);
		await turnsWhile(() => !(checks.started > 0 && checks.ended === checks.started), 0, 1000);
		expect(checks.started > 0 && checks.ended === checks.started, "precondition: the check ended").toBe(true);
		expect(next.pdfStore.inkReady(early.id), "precondition: the kept ink's record was read in through the check").toBe(true);
		answer();
		await movesSettled(next);
		await movesSettled(next);
		vi.useRealTimers();
		await next.store.flush();
		const now = next.plugin.pdfIds.get(second.root) as string;
		expect([x1, early.id], "the second pane is not on the new version's ink").not.toContain(now);
		const held = next.pdfStore.strokes(now).map((x) => x.id);
		expect(held.length, "a stroke is held twice").toBe(new Set(held).size);
		expect([...held].sort(), "the new version's ink does not hold the kept ink's strokes and the late stroke").toEqual(["late", "own"]);
		expect(v.sidecar(now)?.strokes.map((x) => x.id).sort(), "the new version's ink file does not hold them").toEqual(["late", "own"]);
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the kept ink's file does not hold its own stroke and the late one").toEqual(["late", "own"]);
		foundInTrashWhole(v, x1, ["ink-0", "late"]);
		expect(savedOwed(v, x1, early.id), "the leave is still owed").toHaveLength(0);
	});

	it("C516-1 (pin): the kept ink's pane closed, the second pane mid-stroke at the change and closed inside the re-ask: the leave runs on the old version, and the next open of the new bytes carries the kept ink's stroke and the late stroke", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "late"));
		await next.store.flush();
		await closeKept(next, early);
		const controller = next.plugin.pdfInk.get(second.root) as { idle: boolean };
		controller.idle = false;
		changeBytes(v, OTHER, "y");
		await next.modifyFile(OTHER);
		await vi.advanceTimersByTimeAsync(1_001);
		await next.checked();
		expect(next.plugin.pdfIds.get(second.root), "precondition: the busy pane was left on the found ink").toBe(x1);
		await closeSecond(next, second, secondAt);
		vi.useRealTimers();
		await next.store.flush();
		await vi.waitFor(() => foundInTrashWhole(v, x1, ["ink-0", "late"]));
		const opened = await next.open(OTHER);
		expect([x1, early.id], "the new bytes did not open on a new ink").not.toContain(opened.id);
		expect(idsOf(next, opened.id), "the open of the new bytes did not carry the kept ink's stroke and the late stroke").toEqual(["late", "own"]);
	});
});

/**
 * The setup of owedLeave up to its stroke on the first pane, the pairing's check still waiting to settle and asking for
 * that pane only. Then the PDF's bytes change on disk inside that settle and the vault says so: the change merges into
 * the pairing's check, which now asks for every pane. `busy`: the first pane is mid-stroke from here. Every check that
 * identifies panes again is recorded with what it asked for.
 */
async function pairingChanged(opts: { busy?: boolean } = {}) {
	const { v, next, x1, layoutReady } = await renamedThenRelaunchedUnlisted();
	const early = await next.open(OTHER);
	layoutReady();
	const second = await next.open(OTHER);
	expect(second.id, "precondition: the second pane opened on the first deleted ink").toBe(x1);
	expect(next.plugin.pdfIds.get(early.root), "precondition: the first pane is still on its blank").toBe(early.id);
	next.draw(early.id, stroke(60, "own"));
	await next.store.flush();
	const timers = next.plugin.pdfModifyTimers as Map<string, { panes: Set<HTMLElement> | null }>;
	expect([...(timers.get(OTHER)?.panes ?? [])], "precondition: the pairing's check waits to settle, for the first pane only").toEqual([early.root]);
	const asked: { path: string; panes: HTMLElement[] | null }[] = [];
	const check = next.plugin.onPdfModified as (path: string, panes?: ReadonlySet<HTMLElement> | null) => Promise<void>;
	next.plugin.onPdfModified = (path: string, panes?: ReadonlySet<HTMLElement> | null) => {
		asked.push({ path, panes: panes ? [...panes] : null });
		return check.call(next.plugin, path, panes);
	};
	changeBytes(v, OTHER, "y");
	await next.modifyFile(OTHER);
	expect(timers.get(OTHER)?.panes, "precondition: the change merged into the pairing's check, which asks for every pane").toBeNull();
	const controller = next.plugin.pdfInk.get(early.root) as { idle: boolean };
	if (opts.busy) controller.idle = false;
	return { v, next, x1, early, second, timers, asked, controller };
}

/** The merged check settles and runs: the second pane is on the new version's ink, which is returned. */
async function mergedCheckRan(s: Awaited<ReturnType<typeof pairingChanged>>, path: string) {
	await vi.advanceTimersByTimeAsync(1_001);
	await s.next.checked();
	expect(s.asked[0], "precondition: one check ran for the change and the pairing, asking for every pane").toEqual({ path, panes: null });
	const now = s.next.plugin.pdfIds.get(s.second.root) as string | undefined;
	expect([s.x1, s.early.id, undefined], "precondition: the second pane was identified again onto the new version's ink").not.toContain(now);
	return now as string;
}

/** The busy first pane, left on its blank by the merged check, ends its stroke there. */
async function strokeEnds(s: Awaited<ReturnType<typeof pairingChanged>>) {
	expect(s.next.plugin.pdfIds.get(s.early.root), "precondition: the busy pane was left on its blank").toBe(s.early.id);
	s.next.draw(s.early.id, stroke(62, "mid"));
	await s.next.store.flush();
	s.controller.idle = true;
}

/** The PDF renamed in Obsidian, its new bytes going with it. */
async function renamedTo(s: Awaited<ReturnType<typeof pairingChanged>>, to: string) {
	s.v.bytesAt.set(to, s.v.bytesAt.get(OTHER) as Uint8Array);
	await s.next.renameFile(OTHER, to);
	expect(s.timers.has(OTHER), "precondition: no check waits at the old name").toBe(false);
}

const RENAMED_IN_SETTLE = ["renamed inside the merged check's settle", "renamed inside the settle of the check asked again, the first pane mid-stroke at the merged check"] as const;

describe("the PDF's bytes changed on disk inside the settle of the pairing's own check, the first pane drawn on its blank", () => {
	it("the first pane idle at the check: it is identified again too, and ends on the new version's ink with its stroke; the found ink in the trash whole; after a relaunch the PDF opens there", async () => {
		const s = await pairingChanged();
		const { v, next, x1, early, second } = s;
		const now = await mergedCheckRan(s, OTHER);
		await settleGrace(next);
		await movesSettled(next);
		await movesSettled(next);
		expect(next.plugin.pdfIds.get(second.root), "precondition: the second pane stayed on the new version's ink").toBe(now);
		expect(next.plugin.pdfIds.get(early.root), "the first pane is not on the new version's ink").toBe(now);
		expect(idsOf(next, now), "the new version's ink does not hold the first pane's stroke only").toEqual(["own"]);
		vi.useRealTimers();
		await next.store.flush();
		expect(v.sidecar(now)?.strokes.map((x) => x.id), "the new version's ink file does not hold it").toEqual(["own"]);
		await vi.waitFor(() => foundInTrashWhole(v, x1, ["ink-0"]));
		const later = session(v);
		const opened = await later.open(OTHER);
		expect(opened.id, "after a relaunch the PDF does not open on the new version's ink").toBe(now);
		expect(idsOf(later, opened.id), "after a relaunch the PDF does not open with the first pane's stroke").toEqual(["own"]);
	});

	it("the first pane mid-stroke at the check: once the stroke ends, the check asked again identifies it, and it ends on the new version's ink with both its strokes; the found ink in the trash whole", async () => {
		const s = await pairingChanged({ busy: true });
		const { v, next, x1, early, second, asked } = s;
		const now = await mergedCheckRan(s, OTHER);
		await strokeEnds(s);
		await settleGrace(next);
		await movesSettled(next);
		await movesSettled(next);
		expect(asked.slice(1), "precondition: the check asked again for the busy pane").toContainEqual({ path: OTHER, panes: [early.root] });
		expect(next.plugin.pdfIds.get(second.root), "precondition: the second pane stayed on the new version's ink").toBe(now);
		expect(next.plugin.pdfIds.get(early.root), "the first pane is not on the new version's ink").toBe(now);
		expect(idsOf(next, now), "the new version's ink does not hold the first pane's strokes only").toEqual(["mid", "own"]);
		vi.useRealTimers();
		await next.store.flush();
		await vi.waitFor(() => foundInTrashWhole(v, x1, ["ink-0"]));
	});

	it("the first pane mid-stroke at the check: the second pane, identified there while the busy pane waits, takes the kept ink's stroke and not the found ink's older stroke, as the busy pane's move was owed first", async () => {
		const s = await pairingChanged({ busy: true });
		const { v, next, x1, early } = s;
		const now = await mergedCheckRan(s, OTHER);
		expect(next.plugin.pdfIds.get(early.root), "precondition: the busy pane was left on its blank").toBe(early.id);
		expect(idsOf(next, now), "the second pane carried the found ink's older stroke at the merged check").toEqual(["own"]);
		vi.useRealTimers();
		await next.store.flush();
		await vi.waitFor(() => foundInTrashWhole(v, x1, ["ink-0"]));
	});

	it("the first pane idle at the check, the second pane met first: it takes the kept ink's stroke and not the found ink's older stroke; the first pane ends on the new version's ink with its stroke only, the found ink in the trash whole", async () => {
		const s = await pairingChanged();
		const { v, next, x1, early, second } = s;
		const ws = next.plugin.app.workspace as unknown as { getLeavesOfType(t: string): { view: { containerEl?: HTMLElement } }[] };
		const listed = ws.getLeavesOfType.bind(ws);
		ws.getLeavesOfType = (t: string) => [...listed(t)].reverse();
		const order = ws.getLeavesOfType("pdf").map((l) => l.view.containerEl);
		expect(order.indexOf(second.root) >= 0 && order.indexOf(second.root) < order.indexOf(early.root), "precondition: the workspace lists the second pane before the first").toBe(true);
		const now = await mergedCheckRan(s, OTHER);
		await settleGrace(next);
		await movesSettled(next);
		await movesSettled(next);
		expect(next.plugin.pdfIds.get(second.root), "precondition: the second pane stayed on the new version's ink").toBe(now);
		expect(next.plugin.pdfIds.get(early.root), "the first pane is not on the new version's ink").toBe(now);
		expect(idsOf(next, now), "the new version's ink does not hold the first pane's stroke only").toEqual(["own"]);
		vi.useRealTimers();
		await next.store.flush();
		expect(v.sidecar(now)?.strokes.map((x) => x.id), "the new version's ink file does not hold it").toEqual(["own"]);
		await vi.waitFor(() => foundInTrashWhole(v, x1, ["ink-0"]));
	});

	it.each(RENAMED_IN_SETTLE)("%s: the first pane ends on the new version's ink with its strokes under the new name", async (road) => {
		const busy = road !== RENAMED_IN_SETTLE[0];
		const s = await pairingChanged({ busy });
		const { v, next, x1, early, second, timers } = s;
		if (!busy) {
			await renamedTo(s, NEW);
			expect(timers.get(NEW)?.panes, "precondition: the merged check moved to the new name, asking for every pane").toBeNull();
		}
		const now = await mergedCheckRan(s, busy ? OTHER : NEW);
		if (busy) {
			await strokeEnds(s);
			expect([...(timers.get(OTHER)?.panes ?? [])], "precondition: the check asked again waits to settle, for the busy pane").toEqual([early.root]);
			await renamedTo(s, NEW);
			expect([...(timers.get(NEW)?.panes ?? [])], "precondition: the check asked again moved to the new name").toEqual([early.root]);
		}
		await settleGrace(next);
		await movesSettled(next);
		await movesSettled(next);
		expect(next.plugin.pdfFiles.get(early.root), "precondition: the first pane shows the new name").toBe(NEW);
		expect(next.plugin.pdfIds.get(second.root), "precondition: the second pane stayed on the new version's ink").toBe(now);
		expect(next.plugin.pdfIds.get(early.root), "the first pane is not on the new version's ink").toBe(now);
		vi.useRealTimers();
		await next.store.flush();
		if (busy) {
			expect(idsOf(next, now), "the new version's ink does not hold the first pane's strokes only").toEqual(["mid", "own"]);
			expect(v.sidecar(x1)?.pdfPaths ?? [], "the found ink claims the new name").not.toContain(NEW);
			await vi.waitFor(() => foundInTrashWhole(v, x1, ["ink-0"]));
			return;
		}
		expect(idsOf(next, now), "the new version's ink does not hold the first pane's stroke only").toEqual(["own"]);
		await vi.waitFor(() => foundInTrashWhole(v, x1, ["ink-0"]));
	});
});

/** Every field of an ink file but the ones each file holds for itself. */
const PER_FILE = ["schemaVersion", "pageId", "surface", "coordSpace", "pdfPaths", "strokes"];
const rest = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !PER_FILE.includes(k)));
type FileStroke = { id: string } & Record<string, unknown>;
type InkFile = { strokes: FileStroke[] } & Record<string, unknown>;
const fileOf = (v: ReturnType<typeof vault>, id: string) => JSON.parse(v.adapter.files.get(`.handwriting/${id}.json`)!) as InkFile;
const strokeIn = (file: InkFile, id: string) => file.strokes.find((x) => x.id === id);

/** What a later build writes in the found ink's file beside the stroke drawn since the owe. */
type FoundExtra = "top" | "pageless" | "hadEntry" | "attachments";

/**
 * The found ink's file as a later build on another device wrote it, synced in while the leave is owed, and read again
 * (as the change watch reads a file another device wrote): one more stroke drawn on it since the owe ("later"), with a
 * stroke key this build does not know and a tool it reads as its own pen, and the `extras` named: a top key, a stroke no
 * page places, a key on the stroke it held at the owe, an attachments record.
 */
async function laterOnFound(next: ReturnType<typeof session>, v: ReturnType<typeof vault>, x1: string, kept: string, extras: readonly FoundExtra[] = []): Promise<InkFile> {
	expect(savedOwed(v, x1, kept).map((e) => e.had), "precondition: the leave saved what the found ink held at the owe").toEqual([["ink-0"]]);
	const path = `.handwriting/${x1}.json`;
	const json = JSON.parse(v.adapter.files.get(path)!);
	const first = json.strokes[0];
	expect(json.strokes.map((x: { id: string }) => x.id), "precondition: the found ink's file holds the stroke it held at the owe only").toEqual(["ink-0"]);
	const clean = JSON.parse(JSON.stringify(first));
	json.strokes.push({ ...clean, id: "later", color: "#222222", tool: "future-tool", zz: 1 });
	if (extras.includes("top")) json.zzFound = { from: "found" };
	if (extras.includes("pageless")) {
		const p = { ...clean, id: "pageless-found", color: "#333333", zzP: 2 };
		delete p.page;
		json.strokes.push(p);
	}
	if (extras.includes("hadEntry")) first.zzHad = 3;
	if (extras.includes("attachments")) json.attachments = [{ v: 99, id: "att-found", future: [1, 2] }];
	v.adapter.externalWrite(path, JSON.stringify(json));
	await next.pdfStore.reloadExternal(x1);
	expect(idsOf(next, x1), "precondition: the found ink read the synced file").toEqual(["ink-0", "later"]);
	expect(next.pdfStore.carrySource(x1)?.unknownByObject["later"], "precondition: the found ink's read holds the stroke's unknown entry").toEqual({ tool: "future-tool", zz: 1 });
	const memory = next.pdfStore.strokes(x1).find((x) => x.id === "later");
	expect((memory as unknown as Record<string, unknown> | undefined)?.zz, "precondition: the stroke in memory lacks the unknown key").toBeUndefined();
	expect(memory?.tool, "precondition: the stroke in memory holds this build's pen for the tool").toBe("pen");
	return fileOf(v, x1);
}

/** The kept ink's file with its own top key and a key on its own stroke, as a later build wrote them, read again. */
async function keptOwnExtras(next: ReturnType<typeof session>, v: ReturnType<typeof vault>, kept: string): Promise<InkFile> {
	const path = `.handwriting/${kept}.json`;
	const json = JSON.parse(v.adapter.files.get(path)!);
	expect(json.strokes.map((x: { id: string }) => x.id), "precondition: the kept ink's file holds its own stroke only").toEqual(["own"]);
	json.zzKept = { from: "kept" };
	json.strokes[0].zzOwn = 4;
	v.adapter.externalWrite(path, JSON.stringify(json));
	await next.pdfStore.reloadExternal(kept);
	expect(next.pdfStore.carrySource(kept)?.unknownTop["zzKept"], "precondition: the kept ink read its file again").toEqual({ from: "kept" });
	return fileOf(v, kept);
}

/** An ink file's text with the ids in `names` put as their names, longest id first, and the sha256 of the text. */
async function bytesNamed(text: string, names: Record<string, string>) {
	let named = text;
	for (const id of Object.keys(names).sort((a, b) => b.length - a.length)) named = named.split(id).join(names[id]);
	const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");
	return { named, digest };
}

/** The two roads where the new version's ink is not the kept ink: both inks' strokes are carried into it. */
const CHANGED_ROADS = ["the kept ink's pane closed", "both panes open"] as const;
type ChangedRoad = (typeof CHANGED_ROADS)[number];

/**
 * On `road`, the PDF's bytes changed on disk while the leave is owed, every check run out; the new version's ink, which
 * the second pane shows, written, and the found ink's file gone to the trash.
 */
async function changedOnRoad(
	next: ReturnType<typeof session>,
	v: ReturnType<typeof vault>,
	road: ChangedRoad,
	o: { x1: string; early: { root: HTMLElement; id: string }; second: { root: HTMLElement } }
): Promise<string> {
	if (road === "the kept ink's pane closed") await closeKept(next, o.early);
	await changedOnDisk(next, v, OTHER, "y");
	const now = next.plugin.pdfIds.get(o.second.root) as string;
	expect(now, "precondition: the second pane was identified again").toBeDefined();
	expect([o.x1, o.early.id], "precondition: the second pane is on the new version's ink").not.toContain(now);
	if (road === "both panes open") expect(next.plugin.pdfIds.get(o.early.root), "precondition: the first pane is on the new version's ink too").toBe(now);
	vi.useRealTimers();
	await next.store.flush();
	await vi.waitFor(() => expect(v.sidecar(o.x1), "precondition: the found ink's file left for the trash").toBeUndefined());
	return now;
}

/** The new version's ink file on each road with nothing unknown, as these roads wrote it before, ids named. */
const NOW_FILE_BEFORE: Record<ChangedRoad, string> = {
	"the kept ink's pane closed":
		'{"schemaVersion":1,"pageId":"<now>","surface":"pdf","coordSpace":"page-css@1","pdfPaths":["Archive/A.pdf"],"textBoxes":[],"images":[],"strokes":[{"id":"own","tool":"pen","color":"#111111","width":2,"createdAt":0,"page":1,"pts":[60,10,0.5,0,70,20,0.5,8]},{"id":"late","tool":"pen","color":"#111111","width":2,"createdAt":0,"page":1,"pts":[61,10,0.5,0,71,20,0.5,8]}]}',
	"both panes open":
		'{"schemaVersion":1,"pageId":"<now>","surface":"pdf","coordSpace":"page-css@1","pdfPaths":["Archive/A.pdf"],"textBoxes":[],"images":[],"strokes":[{"id":"own","tool":"pen","color":"#111111","width":2,"createdAt":0,"page":1,"pts":[60,10,0.5,0,70,20,0.5,8]},{"id":"late","tool":"pen","color":"#111111","width":2,"createdAt":0,"page":1,"pts":[61,10,0.5,0,71,20,0.5,8]}]}',
};

describe("a later build's stroke fields on a stroke drawn on the found ink since the owe, the PDF's bytes changed on disk while the leave is owed", () => {
	for (const road of CHANGED_ROADS) {
		// Written red, before their cure: the strokes drawn on the found ink since the owe are carried with the stroke
		// fields a later build wrote on them, and with nothing else of the found ink's file.
		it(`the found ink's file synced in from a later build while the leave is owed, with a stroke drawn since the owe that holds a stroke key and a tool this build does not know, then the bytes changed, ${road}: the new version's ink file holds that stroke as the found ink's file wrote it`, async () => {
			const { v, next, x1, early, second } = await owedLeave({ settle: true });
			const found = await laterOnFound(next, v, x1, early.id);
			const now = await changedOnRoad(next, v, road, { x1, early, second });
			const written = fileOf(v, now);
			expect(written.strokes.map((x) => x.id).sort(), "the new version's ink file does not hold the kept ink's stroke and the stroke drawn since the owe, only").toEqual(["later", "own"]);
			expect(strokeIn(written, "later"), "the new version's ink file lost the stroke's later fields").toEqual(strokeIn(found, "later"));
		});

		it(`the found ink's file synced in from a later build with that stroke and more beside it (a top key, a stroke no page places, a key on the stroke it held at the owe, an attachments record), the kept ink's file holding its own top key and stroke key, then the bytes changed, ${road}: the new version's ink file holds the kept ink's fields and stroke as its file wrote them and the carried stroke with its keys, nothing else of the found ink's`, async () => {
			const { v, next, x1, early, second } = await owedLeave({ settle: true });
			const kept = await keptOwnExtras(next, v, early.id);
			const found = await laterOnFound(next, v, x1, early.id, ["top", "pageless", "hadEntry", "attachments"]);
			const now = await changedOnRoad(next, v, road, { x1, early, second });
			const written = fileOf(v, now);
			expect(rest(written), "the new version's ink file holds other fields than the kept ink's").toEqual(rest(kept));
			expect(written.strokes.map((x) => x.id).sort(), "the new version's ink file does not hold the kept ink's stroke and the stroke drawn since the owe, only").toEqual(["later", "own"]);
			expect(strokeIn(written, "own"), "the kept ink's stroke is not as its file wrote it").toEqual(strokeIn(kept, "own"));
			expect(strokeIn(written, "later"), "the carried stroke lost its later fields").toEqual(strokeIn(found, "later"));
		});

		// A pin: the bytes are those this road wrote before the stroke fields went with the carry, logged by that run.
		it(`a stroke drawn on the found ink since the owe, nothing a later build wrote in any ink file, then the bytes changed, ${road}: the new version's ink file is the same bytes this road wrote before`, async () => {
			const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
			next.draw(secondAt, stroke(61, "late"));
			await next.store.flush();
			const now = await changedOnRoad(next, v, road, { x1, early, second });
			const { named, digest } = await bytesNamed(v.adapter.files.get(`.handwriting/${now}.json`)!, { [now]: "<now>", [early.id]: "<kept>", [x1]: "<found>" });
			console.info(`the new version's ink file, nothing unknown, ${road}: sha256 ${digest} bytes ${named}`);
			expect(named, "the new version's ink file is not the bytes this road wrote before").toBe(NOW_FILE_BEFORE[road]);
		});
	}
});

// Held back in 1.5.2 (FOLLOWUPS 556): no carry road asks the proof, so the check never waits on it and these cells
// fail at their first precondition. Expected failures (it.fails) until that row brings the proof back.
describe("the plugin unloaded while the change check waits on its proof of an own Flatten, a leave of the PDF's path owed", () => {
	const ANSWERS = ["the proof answers no", "the proof answers yes, as for our own Flatten"] as const;
	it.fails.each(ANSWERS)("held back in 1.5.2: both panes open, a stroke on the found ink since the owe, a quit while the check waits on the proof, %s: nothing is carried into the new version's ink after the quit", async (answer) => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "late"));
		await next.store.flush();
		// Every carry asked of the store once the plugin unloaded: the ink it went into and the strokes.
		const carriedAfterQuit: { id: string; strokes: string[] }[] = [];
		const carryInto = next.pdfStore.carryInto.bind(next.pdfStore);
		next.pdfStore.carryInto = (id: string, added: readonly InkStroke[], from: Parameters<typeof carryInto>[2]) => {
			if (next.plugin.unloaded) carriedAfterQuit.push({ id, strokes: added.map((s) => s.id) });
			return carryInto(id, added, from);
		};
		let open!: () => void;
		const until = new Promise<void>((done) => (open = done));
		const said: boolean[] = [];
		proof.hold = async (real) => {
			const r = await real;
			said.push(r);
			await until;
			return answer === ANSWERS[0] ? r : true;
		};
		changeBytes(v, OTHER, "y");
		await next.modifyFile(OTHER);
		await vi.advanceTimersByTimeAsync(3_001);
		await turnsWhile(() => said.length === 0, 0);
		expect(said.length, "precondition: the check asked its proof").toBeGreaterThan(0);
		expect(said, "precondition: the new bytes are not our own Flatten").not.toContain(true);
		const now = next.plugin.pdfIds.get(early.root) as string;
		expect(now, "precondition: the first pane was identified again").toBeDefined();
		expect(next.plugin.pdfIds.get(second.root), "precondition: both panes are on the new version's ink").toBe(now);
		expect([x1, early.id], "precondition: the panes are on the new version's ink").not.toContain(now);
		expect(idsOf(next, now), "precondition: nothing was carried before the quit").toEqual([]);
		await quit(next);
		open();
		await movesSettled(next);
		expect(carriedAfterQuit.filter((c) => c.id === now), "ink was carried into the new version's ink after the quit").toEqual([]);
		expect(idsOf(next, now), "the new version's ink holds strokes carried after the quit").toEqual([]);
	});
});
