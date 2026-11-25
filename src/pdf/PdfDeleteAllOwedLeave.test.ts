/**
 * "Delete all ink on this PDF" while ink found for the PDF's path still owes its leave of that path. Two panes
 * restored on one PDF before the vault's list is full: the one drawn on keeps its blank
 * (the kept ink), the other moves onto the found ink, and the found ink leaves the path only once no pane shows it.
 *
 * Today the command takes the first pane's ink only. From the found ink's pane (the kept ink's pane closed), it counts
 * and clears the found ink, and when that pane closes the leave runs and the PDF opens on the kept ink, with every stroke
 * drawn in the other pane: ink the user just deleted is back. From the kept ink's pane, with the leave still owed after a
 * failed run, it clears the kept ink only, and the next run carries the found ink's later strokes back.
 *
 * Want: after a confirmed Delete all, the next open shows no stroke drawn before it, whichever pane ran it, whatever leave
 * is owed off the path (bound 1). Each ink cleared has its own checked copy first; one fails, nothing is cleared (bound
 * 2). The dialog counts what will go (bound 3). Flatten from the found ink's pane stands (bound 4). Nothing owed: Delete
 * all is unchanged (bound 5).
 *
 * Through the plugin and the real stores, with an in-memory vault: PdfOwedLeave.test.ts's harness, copied (its helpers
 * are not exported, and that file is not edited here), with the command registered by registerExportSelectionCommands
 * and run with the PDF active. Only the dialog is a stand-in: it records its count and its confirm, which a cell calls
 * when the user would press Delete. The delete is the plugin's own deleteAllPdfInk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every notice shown, in order. */
const shown = vi.hoisted(() => [] as string[]);
/** Every delete dialog opened, in order: its count, and its Delete button. */
const dialogs = vi.hoisted(() => [] as { count: number; confirm: () => void }[]);
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: string) {
			shown.push(message);
		}
	},
}));
vi.mock("../ink/DeleteAllInk", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ConfirmDeleteInkModal: class {
		constructor(_app: unknown, count: number, _kind: string, confirm: () => void) {
			dialogs.push({ count, confirm });
		}
		open(): void {}
	},
}));

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
	/** The open PDF panes, as the workspace lists them. */
	const leaves: { view: { file: { path: string }; containerEl: HTMLElement } }[] = [];
	/** The file the workspace calls active: the one a palette command acts on. */
	const active = { path: null as string | null };
	/** The commands the plugin registered, by id. */
	const commands = new Map<string, { id: string; checkCallback: (checking: boolean) => boolean }>();
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
		workspace: {
			layoutReady: opts.layoutReady ?? true,
			getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []),
			getActiveFile: () => (active.path === null ? null : pdfFile(active.path)),
		},
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
		addCommand: (command: { id: string; checkCallback: (checking: boolean) => boolean }) => {
			commands.set(command.id, command);
			return command;
		},
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
	// The host's notice for an ink file that cannot be read yet goes through blockNotice; a plain Notice stands in.
	installPdfHost.call(plugin, Notice, (m: string) => new Notice(m));
	// Every delete a confirm starts, kept so a cell can wait for it; the delete itself runs unchanged, with every argument.
	const deletes: Promise<void>[] = [];
	const deleteAll = HandwritingPlugin.prototype.deleteAllPdfInk as unknown as (...a: unknown[]) => Promise<void>;
	plugin.deleteAllPdfInk = (...a: unknown[]) => {
		const run = deleteAll.apply(plugin, a);
		deletes.push(run);
		return run;
	};
	plugin.registerExportSelectionCommands();
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
	return { store, pdfStore, plugin, open, close, draw, deleteFile, createFile, renameFile, checked, active, commands, deletes };
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

/** The device-local key the owed leaves are saved under. */
const OWED_KEY = "handwriting-pdf-owed-leaves";
/** The shipped words the delete says. */
const CHANGED = "Handwriting: the ink changed while its backup was being made. nothing was deleted. run Delete all ink again if you still want to remove it.";
const UNVERIFIED = "Handwriting: this PDF's ink cannot be deleted right now. try again in a moment.";
const IDENTIFYING = "Handwriting: still identifying this PDF - try again in a moment";
const REMOVED = /^Handwriting: removed \d+ strokes?\./;

const ids = (strokes: readonly InkStroke[]) => strokes.map((x) => x.id).sort();

/** The leaves saved as owed on this device: which ink, off which path, for which kept ink. */
function savedLeaves(v: ReturnType<typeof vault>) {
	const saved = JSON.parse((v.local.get(OWED_KEY) as string | undefined) ?? "[]") as { id: string; path: string; from: string }[];
	return saved.map(({ id, path, from }) => ({ id, path, from }));
}

/**
 * "Delete all ink on this PDF" run from the palette with `path` active, until its dialog opens or it answers without
 * one. `press` presses Delete; `settled` waits for the delete that started and what it started, and returns what was
 * said since the press; `confirm` is both.
 */
async function deleteAllOn(s: ReturnType<typeof session>, path: string) {
	s.active.path = path;
	const opened = dialogs.length;
	const said = shown.length;
	expect(s.commands.get("delete-all-pdf-ink")?.checkCallback(false), "precondition: the command ran").toBe(true);
	await turnsWhile(() => dialogs.length === opened && shown.length === said);
	const dialog = dialogs[opened];
	let pressedAt = shown.length;
	const press = () => {
		expect(dialog, "precondition: the delete dialog opened").toBeDefined();
		pressedAt = shown.length;
		dialog!.confirm();
	};
	const settled = async () => {
		while (s.deletes.length > 0) await Promise.all(s.deletes.splice(0));
		await movesSettled(s);
		return shown.slice(pressedAt);
	};
	return {
		count: dialog?.count,
		words: shown.slice(said),
		press,
		settled,
		async confirm() {
			press();
			return settled();
		},
	};
}

/** owedLeave, then the kept ink's pane closed and let go: the second pane, on the found ink, is the copy's only pane. */
async function keptClosed() {
	const o = await owedLeave({ settle: true });
	o.next.close(o.early.root);
	o.next.plugin.releasePdfId(o.early.id);
	await movesSettled(o.next);
	expect(o.next.pdfStore.generation(o.early.id), "precondition: the kept ink's record was let go with its pane").toBeNull();
	expect(o.v.sidecar(o.early.id)?.strokes.map((x) => x.id), "precondition: the kept ink's file holds its stroke").toEqual(["own"]);
	expect(savedLeaves(o.v), "precondition: the leave is owed and saved").toEqual([{ id: o.x1, path: OTHER, from: o.early.id }]);
	return o;
}

/** The found ink's file and the kept ink's, and the found ink on screen, as they were before the delete. */
function nothingCleared(v: ReturnType<typeof vault>, next: ReturnType<typeof session>, x1: string, kept: string) {
	expect(ids(next.pdfStore.strokes(x1)), "the found ink was cleared on screen").toEqual(["ink-0"]);
	expect(v.sidecar(x1)?.strokes.map((x) => x.id), "the found ink's file was cleared").toEqual(["ink-0"]);
	expect(v.sidecar(kept)?.strokes.map((x) => x.id), "the kept ink's file was cleared").toEqual(["own"]);
}

/** The found ink's own other PDF, which it claims as well (a second claim, as a sync can bring one). */
const ELSEWHERE = "Elsewhere/A.pdf";
/** The words a Delete all that clears nothing says: the delete's refusals, and the confirm's for an id not known. */
const REFUSALS: readonly string[] = [
	CHANGED,
	UNVERIFIED,
	IDENTIFYING,
	"Handwriting: this PDF's ink storage is not ready. nothing was deleted.",
	"Handwriting: this PDF's ink cannot be deleted.",
];

/** An open lists the ink file `first` before every other, whatever the folder's order (PdfOwedLeave.test.ts, copied). */
function listFirst(s: ReturnType<typeof session>, first: string) {
	const list = s.store.listIds.bind(s.store);
	s.store.listIds = (async (prefix: string) => {
		const listed = [...(await list(prefix))].sort();
		return [...listed.filter((i) => i === first), ...listed.filter((i) => i !== first)];
	}) as typeof s.store.listIds;
	return s;
}

/**
 * The rename-elsewhere road (PdfOwedLeave.test.ts:2556, copied): a stroke drawn on the found ink while its leave is owed, then a quit
 * with that pane open, so the leave is saved owed off the copy; then the copy renamed to NEW by a session that never owed
 * the leave, with no pane there, so both inks' claims move and the leave does not. `secondClaim`: the found ink's file
 * given a claim on ELSEWHERE after the owe first, so the launch run cannot tell the new name (leaveMovedTo, "unsure").
 */
async function renamedElsewhereOwed(opts: { secondClaim: boolean }) {
	const { v, next, x1, early, secondAt } = await owedLeave({ settle: true });
	next.draw(secondAt, stroke(61, "pane2"));
	await quit(next);
	expect(savedLeaves(v), "precondition: the leave is saved owed off the copy").toEqual([{ id: x1, path: OTHER, from: early.id }]);
	if (opts.secondClaim) {
		v.files.add(ELSEWHERE);
		const file = `.handwriting/${x1}.json`;
		const page = parsePage(v.adapter.files.get(file) as string, x1).data;
		v.adapter.files.set(file, serializePage({ ...page, pdfPaths: [...(page.pdfPaths ?? []), ELSEWHERE] }));
	}
	const other = session(v);
	await other.renameFile(OTHER, NEW);
	await movesSettled(other);
	await other.store.flush();
	await quit(other);
	expect(claimersOnDisk(v, NEW).sort(), "precondition: the rename moved both inks' claims").toEqual([early.id, x1].sort());
	expect(v.files.has(OTHER), "precondition: the old name is no file now").toBe(false);
	expect(v.sidecar(early.id)?.strokes.map((x) => x.id), "precondition: the kept ink's file holds its own stroke").toEqual(["own"]);
	expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "precondition: the found ink's file holds its stroke and the one drawn since the owe").toEqual(["ink-0", "pane2"]);
	expect(savedLeaves(v), "precondition: the leave is still saved owed off the old name").toEqual([{ id: x1, path: OTHER, from: early.id }]);
	return { v, x1, early };
}

/**
 * The next read of `id`'s ink file held until `let` is called; every read after it goes through. Set before a launch,
 * that is the leave run's read of the kept ink's claims (PdfClaims.ts pairedInkLeaves), made as the session starts and
 * before any pane opens, so the run waits there and has not moved the leave.
 */
function holdFirstRead(v: ReturnType<typeof vault>, id: string) {
	const read = v.adapter.read.bind(v.adapter);
	const file = `.handwriting/${id}.json`;
	const hold = { taken: false, let: () => {} };
	v.adapter.read = async (p: string) => {
		if (!hold.taken && p === file) {
			hold.taken = true;
			await new Promise<void>((done) => (hold.let = done));
		}
		return read(p);
	};
	return hold;
}

/** The launch of the session that owes the leave, its panes opening on ink `first` before any other. */
function launchOwing(v: ReturnType<typeof vault>, first: string) {
	return listFirst(session(v, { pendingStore: true }), first);
}

/**
 * The delete's end as these cells read it: true when it cleared (a removed notice). Else it cleared nothing: it said one
 * of the shipped words, and the pane's ink keeps every stroke it had.
 */
function clearedElseRefused(words: readonly string[], s: ReturnType<typeof session>, pane: { root: HTMLElement }, paneBefore: readonly string[]): boolean {
	if (words.some((w) => REMOVED.test(w))) return true;
	expect(words.length === 1 && REFUSALS.includes(words[0] as string), `the delete cleared nothing and did not say one of the shipped words: ${JSON.stringify(words)}`).toBe(true);
	expect(ids(s.pdfStore.strokes(s.plugin.pdfIds.get(pane.root) as string)), "the delete said nothing was deleted, and the pane's ink lost a stroke").toEqual(expect.arrayContaining([...paneBefore]));
	return false;
}

/** A quit; then, when the delete cleared, the next open of `path` (the new name), a launch in either list order, shows no stroke. */
async function nextOpensBlank(v: ReturnType<typeof vault>, s: ReturnType<typeof session>, cleared: boolean, path = NEW, name = "the new name") {
	await quit(s);
	if (!cleared) return;
	for (const order of ORDERS) {
		const { s: later, opened } = await relaunchOpen(v, order, path);
		const strokes = ids(later.pdfStore.strokes(later.plugin.pdfIds.get(opened.root) as string));
		await quit(later);
		expect(strokes, `the next launch, the ink folder in ${order}: ${name} opened with ink drawn before the delete`).toEqual([]);
	}
}

/**
 * The run of `found`'s leave off `path` held at its start until `let` is called; every other run goes through. That
 * run starts once the leave is saved owed off `path`: by the run that moved it there (movedLeave), or by a retirement that
 * moved it back there (moveLeavesBack). Held there, it has not carried the strokes drawn on the found ink since the owe.
 * A run that waits for it (movedLeave's) waits too, so a cell holding it waits for a delete, not for movesSettled.
 */
function holdRunAt(s: ReturnType<typeof session>, found: string, path: string) {
	const run = s.plugin.pairedInkLeaves as (id: string, path: string, from: string) => Promise<void>;
	const hold = { taken: false, let: () => {} };
	const gate = new Promise<void>((done) => (hold.let = done));
	s.plugin.pairedInkLeaves = (id: string, at: string, from: string) => {
		if (!hold.taken && id === found && at === path) {
			hold.taken = true;
			return gate.then(() => run.call(s.plugin, id, at, from));
		}
		return run.call(s.plugin, id, at, from);
	};
	return hold;
}

/** Press Delete on the dialog `run` opened and wait for the delete alone (not for movesSettled); what it said. */
async function pressAndWait(s: ReturnType<typeof session>, run: Awaited<ReturnType<typeof deleteAllOn>>) {
	const said = shown.length;
	run.press();
	while (s.deletes.length > 0) await Promise.all(s.deletes.splice(0));
	return shown.slice(said);
}

/** The counts the removed notices name, in order. */
const removedCounts = (words: readonly string[]) =>
	words.map((w) => /^Handwriting: removed (\d+) strokes?\./.exec(w)?.[1]).filter((n): n is string => n !== undefined);

/**
 * B14 (a)'s road up to the delete: the launch of the session that owes the leave, its run held at its read of the kept
 * ink's claims, the kept ink's pane open at the new name, the found ink not read.
 */
async function launchHeldKeptPane() {
	const { v, x1, early } = await renamedElsewhereOwed({ secondClaim: false });
	const hold = holdFirstRead(v, early.id);
	const s = launchOwing(v, early.id);
	await turnsWhile(() => !hold.taken);
	expect(hold.taken, "precondition: the launch run's read of the kept ink's claims is held").toBe(true);
	const pane = await s.open(NEW);
	expect(pane.id, "precondition: the pane at the new name shows the kept ink").toBe(early.id);
	expect(savedLeaves(v), "precondition: the launch run has not moved the leave").toEqual([{ id: x1, path: OTHER, from: early.id }]);
	expect(ids(s.pdfStore.strokes(pane.id)), "precondition: the kept ink's pane shows its stroke").toEqual(["own"]);
	return { v, x1, early, hold, s, pane };
}

/** B14 (b)'s road up to the delete: the pane at the new name on the found ink, the launch run met it and left the leave owed off the old name. */
async function launchFoundPane() {
	const { v, x1, early } = await renamedElsewhereOwed({ secondClaim: false });
	const hold = holdFirstRead(v, early.id);
	const s = launchOwing(v, x1);
	await turnsWhile(() => !hold.taken);
	expect(hold.taken, "precondition: the launch run's read of the kept ink's claims is held").toBe(true);
	const pane = await s.open(NEW);
	expect(pane.id, "precondition: the pane at the new name shows the found ink").toBe(x1);
	hold.let();
	await movesSettled(s);
	expect(s.plugin.pdfIds.get(pane.root), "precondition: the pane still shows the found ink").toBe(x1);
	expect(savedLeaves(v), "precondition: the launch run met the found ink's pane and left the leave owed off the old name").toEqual([{ id: x1, path: OTHER, from: early.id }]);
	return { v, x1, early, s, pane };
}

/**
 * N1's road (PdfOwedLeave.test.ts renamedKeptUnreadableBack, "moved back as a delete and a create", copied): a stroke
 * drawn on the found ink while its leave is owed, the kept ink's pane closed; the copy renamed in this session with the
 * kept ink's file unreadable, so the claim move passes the kept ink over and it still claims the old name; the file whole
 * again, then a sync tool moves the copy back as a delete at the new name and a create at the old one, and the second
 * pane closes. Its run cannot tell which file is the copy (wasName), so the leave stays owed off the new name inside
 * that name's grace, and the retirement moves it back to the old name (moveLeavesBack).
 */
async function movedBackOwed() {
	const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
	next.draw(secondAt, stroke(61, "pane2"));
	await next.store.flush();
	next.close(early.root);
	next.plugin.releasePdfId(early.id);
	await movesSettled(next);
	expect(next.pdfStore.generation(early.id), "precondition: the kept ink's record was let go with its pane").toBeNull();
	const keptPath = `.handwriting/${early.id}.json`;
	const keptBytes = v.adapter.files.get(keptPath);
	expect(keptBytes, "precondition: the kept ink's file is written").toBeDefined();
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	v.adapter.files.set(keptPath, "{ not a page");
	await next.renameFile(OTHER, NEW);
	await movesSettled(next);
	expect(savedLeaves(v), "precondition: the owed leave followed the rename").toEqual([{ id: x1, path: NEW, from: early.id }]);
	v.adapter.files.set(keptPath, keptBytes as string);
	expect(claimersAmong(v, [early.id], OTHER), "precondition: the rename passed the kept ink over, and it still claims the old name").toEqual([early.id]);
	expect(claimersAmong(v, [x1], NEW), "precondition: the found ink claims the new name").toEqual([x1]);
	await next.deleteFile(NEW);
	await next.createFile(OTHER);
	await closeSecond(next, second, secondAt);
	expect(next.pdfStore.pendingClaims().has(NEW), "precondition: the new name's deletion still waits in its grace").toBe(true);
	expect(savedLeaves(v), "precondition: inside the new name's grace the leave is still owed off it").toEqual([{ id: x1, path: NEW, from: early.id }]);
	expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "precondition: the found ink holds its stroke and the one drawn since the owe").toEqual(["ink-0", "pane2"]);
	return { v, next, x1, early };
}

/** Pin X's other PDF: the kept ink is given a claim on it as well (a second claim, as a sync can bring one). */
const BESIDE = "Shelf/A.pdf";
const NOT_READY = "Handwriting: this PDF's ink storage is not ready. nothing was deleted.";

describe("Delete all ink on a PDF while ink found for it owes its leave of the path", () => {
	it("B1, bound 1: the kept ink's pane closed, Delete all from the found ink's pane, then that pane closed: the copy opens with no stroke, in this session and after a relaunch in either list order", async () => {
		const { v, next, second, secondAt } = await keptClosed();
		const run = await deleteAllOn(next, OTHER);
		await run.confirm();
		await closeSecond(next, second, secondAt);
		vi.useRealTimers();
		await next.store.flush();
		const again = await next.open(OTHER);
		expect(ids(next.pdfStore.strokes(again.id)), "the copy reopened in this session with ink drawn before the delete").toEqual([]);
		for (const order of ORDERS) {
			expect((await restartStrokes(v, order)).strokes, `after a relaunch, the ink folder in ${order}, the copy opened with ink drawn before the delete`).toEqual([]);
		}
	});

	it("B3, bound 3: as B1, the dialog counts every stroke that will go: the found ink's, and the kept ink's read from its file", async () => {
		const { next } = await keptClosed();
		const run = await deleteAllOn(next, OTHER);
		expect(run.words, "the command answered without its dialog").toEqual([]);
		expect(run.count, "the dialog's count is not the found ink's stroke and the kept ink's").toBe(2);
		endInSession(next);
	});

	for (const order of ORDERS) {
		it(`B2, P510-1's twin: the leave left owed by a failed save of the kept ink, a stroke drawn on the found ink since the owe; the save working again, Delete all from the kept ink's pane, then a quit and a launch (the leave's next run), the ink folder in ${order}: the copy opens with no stroke`, async () => {
			const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
			next.draw(secondAt, stroke(61, "pane2"));
			await next.store.flush();
			const write = v.adapter.write.bind(v.adapter);
			let refusing = true;
			v.adapter.write = async (p: string, data: string) => {
				if (refusing && p.includes(early.id)) throw new Error("the disk refused the write");
				return write(p, data);
			};
			vi.spyOn(console, "error").mockImplementation(() => {});
			vi.spyOn(console, "warn").mockImplementation(() => {});
			next.close(second.root);
			next.plugin.releasePdfId(secondAt);
			await settledPastFailure(next, /refused the write/);
			expect(v.sidecar(x1)?.strokes.map((x) => x.id), "precondition: the found ink still holds the stroke drawn since the owe").toEqual(["ink-0", "pane2"]);
			expect(savedLeaves(v), "precondition: the leave is still owed").toEqual([{ id: x1, path: OTHER, from: early.id }]);
			expect(next.plugin.pdfIds.get(early.root), "precondition: the kept ink's pane is open").toBe(early.id);
			refusing = false;
			await next.store.flush();
			expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "precondition: the kept ink's save landed once the disk took it").toEqual(["own", "pane2"]);
			const run = await deleteAllOn(next, OTHER);
			await run.confirm();
			await movesSettled(next);
			await quit(next);
			const { s, opened } = await relaunchOpen(v, order);
			vi.useRealTimers();
			await s.store.flush();
			expect(ids(s.pdfStore.strokes(opened.id)), "after the leave's next run, ink drawn before the delete is back").toEqual([]);
			expect((await restartStrokes(v, order)).strokes, "after a further relaunch, ink drawn before the delete is back").toEqual([]);
		});
	}

	it("B4, bound 2: as B1, the kept ink's copy cannot be made: nothing is cleared, and no removed notice", async () => {
		const { v, next, x1, early } = await keptClosed();
		const preserve = next.store.preserve.bind(next.store);
		next.store.preserve = (async (id: string) => {
			if (id === early.id) throw new Error("Handwriting: the newest ink could not be written to disk");
			return preserve(id);
		}) as typeof next.store.preserve;
		vi.spyOn(console, "error").mockImplementation(() => {});
		const run = await deleteAllOn(next, OTHER);
		const words = await run.confirm();
		await next.store.flush();
		nothingCleared(v, next, x1, early.id);
		expect(words.filter((w) => REMOVED.test(w)), "a removed notice was shown").toEqual([]);
		endInSession(next);
	});

	it("B4, bound 2: as B1, the kept ink's copy made without its stroke: nothing is cleared, and the delete says its copy is not verified", async () => {
		const { v, next, x1, early } = await keptClosed();
		const preserve = next.store.preserve.bind(next.store);
		next.store.preserve = (async (id: string) => {
			const at = await preserve(id);
			if (id === early.id && at !== null) {
				const page = parsePage(v.adapter.files.get(at) as string, id).data;
				v.adapter.files.set(at, serializePage({ ...page, strokes: [] }));
			}
			return at;
		}) as typeof next.store.preserve;
		const run = await deleteAllOn(next, OTHER);
		const words = await run.confirm();
		await next.store.flush();
		nothingCleared(v, next, x1, early.id);
		expect(words, "the delete's words").toEqual([UNVERIFIED]);
		endInSession(next);
	});

	it("B5, bound 2: as B1, the kept ink's record let go while the found ink's copy is made: nothing is cleared, the delete says the ink changed, and no record of the kept ink is made again", async () => {
		const { v, next, x1, early } = await keptClosed();
		const preserve = next.store.preserve.bind(next.store);
		const letGo = { done: false };
		next.store.preserve = (async (id: string) => {
			const at = await preserve(id);
			if (id === x1 && !letGo.done && next.pdfStore.generation(early.id) !== null) {
				letGo.done = true;
				next.plugin.releasePdfId(early.id);
				await turnsWhile(() => next.pdfStore.generation(early.id) !== null);
			}
			return at;
		}) as typeof next.store.preserve;
		const run = await deleteAllOn(next, OTHER);
		const words = await run.confirm();
		await next.store.flush();
		expect(letGo.done, "precondition: the kept ink's record was held, and let go, during the found ink's copy").toBe(true);
		expect(words, "the delete's words").toEqual([CHANGED]);
		nothingCleared(v, next, x1, early.id);
		expect(next.pdfStore.generation(early.id), "a record of the kept ink was made again after it was let go").toBeNull();
		endInSession(next);
	});

	it("B6: as B1 up to the delete, the second pane still open: the kept ink's record is not held once the delete settles, and a revision of its file synced in after the delete shows when the copy reopens", async () => {
		const { v, next, early, second, secondAt } = await keptClosed();
		const run = await deleteAllOn(next, OTHER);
		await run.confirm();
		await movesSettled(next);
		await next.store.flush();
		expect(next.pdfStore.generation(early.id), "the kept ink's record is still held, with no pane on it").toBeNull();
		const keptPath = `.handwriting/${early.id}.json`;
		const page = parsePage(v.adapter.files.get(keptPath) as string, early.id).data;
		v.adapter.files.set(keptPath, serializePage({ ...page, strokes: [...page.strokes, stroke(80, "synced")] }));
		await closeSecond(next, second, secondAt);
		vi.useRealTimers();
		await next.store.flush();
		const again = await next.open(OTHER);
		expect(ids(next.pdfStore.strokes(again.id)), "the copy reopened without the revision synced in, or with ink drawn before the delete").toEqual(["synced"]);
	});

	it("B7: as B1, a stroke drawn in the second pane after the delete, then that pane closed: that stroke alone on the copy after two relaunches in either list order, one ink file claiming the copy (the kept ink), the found ink not live, each ink's copy in the trash", async () => {
		const { v, next, x1, early, second, secondAt } = await keptClosed();
		const run = await deleteAllOn(next, OTHER);
		await run.confirm();
		next.draw(secondAt, stroke(70, "late"));
		await next.store.flush();
		await closeSecond(next, second, secondAt);
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "not one ink file claims the copy on disk").toEqual([early.id]));
		await next.store.flush();
		for (const order of ORDERS) {
			for (const pass of [1, 2]) {
				expect(await restartStrokes(v, order), `relaunch ${pass}, the ink folder in ${order}: the copy did not open on the kept ink with the stroke drawn after the delete alone`).toEqual({ id: early.id, strokes: ["late"] });
			}
		}
		expect(v.sidecar(x1), "the found ink's file is still live").toBeUndefined();
		const trash = v.trashInk().map((t) => [...t].sort());
		expect(trash, "the found ink's copy is not in the trash").toContainEqual(["ink-0"]);
		expect(trash, "the kept ink's copy is not in the trash").toContainEqual(["own"]);
	});

	it("W1: as B1, the delete's words: one notice per ink file cleared, in today's words, each naming its own copy, which holds that ink", async () => {
		const { v, next } = await keptClosed();
		const run = await deleteAllOn(next, OTHER);
		const words = await run.confirm();
		expect(words, "not one notice per ink file cleared").toHaveLength(2);
		const copies = words.map((w) => /^Handwriting: removed 1 stroke\. A copy is kept in (.+)\.$/.exec(w)?.[1]);
		const held = copies.map((at) => (at === undefined ? undefined : parsePage(v.adapter.files.get(at) as string, "copy").data.strokes.map((x) => x.id)));
		expect(held.sort(), "the notices do not each name a copy holding that ink").toEqual([["ink-0"], ["own"]]);
		endInSession(next);
	});

	it("B8 (pin), bound 5: nothing owed, two panes on one PDF on one ink: the count, the clear and the notice as today", async () => {
		const v = vault();
		const path = "Desk/A.pdf";
		v.files.add(path);
		const s = session(v);
		vi.useFakeTimers();
		const a = await s.open(path);
		const b = await s.open(path);
		expect(b.id, "precondition: both panes on one ink").toBe(a.id);
		s.draw(a.id, stroke(10, "one"));
		s.draw(a.id, stroke(20, "two"));
		await s.store.flush();
		const run = await deleteAllOn(s, path);
		expect(run.count, "the dialog's count").toBe(2);
		const words = await run.confirm();
		await s.store.flush();
		expect(ids(s.pdfStore.strokes(a.id)), "the ink was not cleared").toEqual([]);
		expect(v.sidecar(a.id)?.strokes, "the ink file was not cleared").toEqual([]);
		expect(words, "the delete's words").toHaveLength(1);
		expect(words[0], "the delete's words").toMatch(/^Handwriting: removed 2 strokes\. A copy is kept in .+\.$/);
		expect(v.trashInk().map((t) => [...t].sort()), "the copy in the trash").toEqual([["one", "two"]]);
		endInSession(s);
	});

	it("B8 (pin): as B1 up to the delete, the second pane still open: the leave saved on this device is the same before and after the command and the delete, and stays owed until that pane closes", async () => {
		const { v, next, second, secondAt } = await keptClosed();
		const before = v.local.get(OWED_KEY);
		const run = await deleteAllOn(next, OTHER);
		expect(v.local.get(OWED_KEY), "the command changed the saved leave").toEqual(before);
		await run.confirm();
		await movesSettled(next);
		expect(v.local.get(OWED_KEY), "the delete changed the saved leave").toEqual(before);
		await closeSecond(next, second, secondAt);
		vi.useRealTimers();
		await vi.waitFor(() => expect(v.local.has(OWED_KEY), "the leave is still owed after the second pane closed").toBe(false));
	});

	it("B9 (pin), bound 4: as B1 up to the delete, Flatten from the found ink's pane flattens the found ink, as today", async () => {
		const { next, x1 } = await keptClosed();
		const flattened: string[] = [];
		next.plugin.flattenPdf = async (_file: unknown, id: string) => void flattened.push(id);
		next.active.path = OTHER;
		expect(next.commands.get("flatten-pdf-ink")?.checkCallback(false), "precondition: the command ran").toBe(true);
		await turnsWhile(() => flattened.length === 0);
		expect(flattened, "Flatten did not take the found ink").toEqual([x1]);
		endInSession(next);
	});

	it("B10: the copy renamed while the leave is owed and the kept ink's file cannot be read (its pane closed), the file whole again, Delete all from the found ink's pane at the new name, then that pane closed: the new name opens with no stroke, and a file put at the old name does not open on the kept ink", async () => {
		const { v, next, x1, early, second, secondAt } = await keptClosed();
		const keptPath = `.handwriting/${early.id}.json`;
		const keptBytes = v.adapter.files.get(keptPath);
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		v.adapter.files.set(keptPath, "{ not a page");
		await next.renameFile(OTHER, NEW);
		expect(next.plugin.pdfPaneHoldsClaim(NEW), "precondition: the second pane holds the new name's claim").toBe(true);
		await movesSettled(next);
		expect(savedLeaves(v), "precondition: the owed leave followed the rename").toEqual([{ id: x1, path: NEW, from: early.id }]);
		v.adapter.files.set(keptPath, keptBytes as string);
		expect(v.sidecar(early.id)?.pdfPaths, "precondition: the kept ink still claims the old name").toEqual([OTHER]);
		const run = await deleteAllOn(next, NEW);
		await run.confirm();
		await closeSecond(next, second, secondAt);
		for (let i = 0; i < 3; i++) await movesSettled(next);
		vi.useRealTimers();
		await next.store.flush();
		const again = await next.open(NEW);
		expect(ids(next.pdfStore.strokes(again.id)), "the new name reopened in this session with ink drawn before the delete").toEqual([]);
		expect((await restartStrokes(v, "name order", NEW)).strokes, "after a relaunch the new name opened with ink drawn before the delete").toEqual([]);
		v.files.add(OTHER);
		expect((await restartStrokes(v, "name order", OTHER)).strokes, "a file put at the old name opened on the kept ink").toEqual([]);
	});

	it("B11: as B1, the copy renamed while the found ink's copy is made: nothing is cleared, the delete says the ink changed, and no record of the kept ink is made again", async () => {
		const { v, next, x1, early } = await keptClosed();
		const preserve = next.store.preserve.bind(next.store);
		let letCopy!: () => void;
		const gate = new Promise<void>((done) => (letCopy = done));
		const held = { copy: false };
		next.store.preserve = (async (id: string) => {
			if (id === x1 && !held.copy) {
				held.copy = true;
				await gate;
			}
			return preserve(id);
		}) as typeof next.store.preserve;
		const run = await deleteAllOn(next, OTHER);
		run.press();
		await turnsWhile(() => !held.copy);
		expect(held.copy, "precondition: the found ink's copy is held").toBe(true);
		await next.renameFile(OTHER, NEW);
		await movesSettled(next);
		letCopy();
		const words = await run.settled();
		await next.store.flush();
		expect(words, "the delete's words").toEqual([CHANGED]);
		nothingCleared(v, next, x1, early.id);
		expect(next.pdfStore.generation(early.id), "a record of the kept ink was made again after it was let go").toBeNull();
		endInSession(next);
	});

	it("B12 (pin): as B1, then the found ink's move into the trash failing once at the second pane's close: no stroke at a reopen, the leave stays owed and saved, and at the next launch it removes the found ink and leaves one claim", async () => {
		const { v, next, x1, early, second, secondAt } = await keptClosed();
		const run = await deleteAllOn(next, OTHER);
		await run.confirm();
		const fail = removeFailsOnce(next, x1);
		next.close(second.root);
		next.plugin.releasePdfId(secondAt);
		await settledPastFailure(next);
		expect(fail.failed, "precondition: the leave's move of the found ink into the trash failed").toBe(true);
		expect(savedLeaves(v), "the leave is not owed and saved after the failed move").toEqual([{ id: x1, path: OTHER, from: early.id }]);
		const again = await next.open(OTHER);
		expect(ids(next.pdfStore.strokes(again.id)), "the copy reopened with ink drawn before the delete").toEqual([]);
		await quit(next);
		const { s, opened } = await relaunchOpen(v, "name order");
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "after the launch, not one ink file claims the copy").toEqual([early.id]));
		expect(ids(s.pdfStore.strokes(opened.id)), "after the launch the copy opened with ink drawn before the delete").toEqual([]);
	});

	it("Q1 (pin): both panes open, the kept ink's and the found ink's: the confirm says the PDF is still being identified, and nothing is cleared", async () => {
		const { v, next, x1, early } = await owedLeave({ settle: true });
		const trashBefore = v.trashInk().length;
		const run = await deleteAllOn(next, OTHER);
		const words = await run.confirm();
		await next.store.flush();
		expect(words, "the confirm's words").toEqual([IDENTIFYING]);
		expect(ids(next.pdfStore.strokes(x1)), "the found ink was cleared").toEqual(["ink-0"]);
		expect(ids(next.pdfStore.strokes(early.id)), "the kept ink was cleared").toEqual(["own"]);
		expect(v.trashInk().length, "a copy went to the trash").toBe(trashBefore);
		endInSession(next);
	});

	it("B13, bound 3: B2's road up to the delete, Delete all from the kept ink's pane: the dialog counts each stroke once, the found ink keeps the stroke it held at the owe, and one notice per ink with its own count", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		const write = v.adapter.write.bind(v.adapter);
		let refusing = true;
		v.adapter.write = async (p: string, data: string) => {
			if (refusing && p.includes(early.id)) throw new Error("the disk refused the write");
			return write(p, data);
		};
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		next.close(second.root);
		next.plugin.releasePdfId(secondAt);
		await settledPastFailure(next, /refused the write/);
		refusing = false;
		await next.store.flush();
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "precondition: the kept ink's save landed once the disk took it").toEqual(["own", "pane2"]);
		expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "precondition: the found ink still holds the stroke drawn since the owe").toEqual(["ink-0", "pane2"]);
		expect(savedLeaves(v), "precondition: the leave is still owed").toEqual([{ id: x1, path: OTHER, from: early.id }]);
		const run = await deleteAllOn(next, OTHER);
		expect(run.words, "the command answered without its dialog").toEqual([]);
		expect(run.count, "the dialog's count is not the two strokes that go").toBe(2);
		const words = await run.confirm();
		await next.store.flush();
		expect(v.sidecar(x1)?.strokes.map((x) => x.id), "the found ink's file does not keep the stroke it held at the owe alone").toEqual(["ink-0"]);
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id), "the kept ink's file was not cleared").toEqual([]);
		expect(words.filter((w) => REMOVED.test(w)).map((w) => /^Handwriting: removed (\d+) strokes?\./.exec(w)?.[1]), "not one removed notice per ink with its own count").toEqual(["2", "1"]);
		endInSession(next);
	});

	it("B14 (a), bound 1 on the rename-elsewhere road: a leave owed at a quit, the copy renamed by a session that never owed it, then a launch; before the launch run moves the leave, Delete all at the new name from the kept ink's pane, then that pane closed: the new name opens with no stroke drawn before the delete, or nothing is cleared and the delete says the shipped words", async () => {
		const { v, x1, early } = await renamedElsewhereOwed({ secondClaim: false });
		const hold = holdFirstRead(v, early.id);
		const s = launchOwing(v, early.id);
		await turnsWhile(() => !hold.taken);
		expect(hold.taken, "precondition: the launch run's read of the kept ink's claims is held").toBe(true);
		const pane = await s.open(NEW);
		expect(pane.id, "precondition: the pane at the new name shows the kept ink").toBe(early.id);
		expect(savedLeaves(v), "precondition: the launch run has not moved the leave").toEqual([{ id: x1, path: OTHER, from: early.id }]);
		const paneBefore = ids(s.pdfStore.strokes(pane.id));
		expect(paneBefore, "precondition: the kept ink's pane shows its stroke").toEqual(["own"]);
		const run = await deleteAllOn(s, NEW);
		const said = shown.length;
		run.press();
		while (s.deletes.length > 0) await Promise.all(s.deletes.splice(0));
		const words = shown.slice(said);
		const cleared = clearedElseRefused(words, s, pane, paneBefore);
		hold.let();
		await movesSettled(s);
		await closeSecond(s, pane, early.id);
		await nextOpensBlank(v, s, cleared);
	});

	it("B14 (b), bound 1 on the rename-elsewhere road: as (a), the pane at the new name on the found ink, which the launch run meets and so leaves the leave owed off the old name; Delete all from that pane, then that pane closed: the new name opens with no stroke drawn before the delete, or nothing is cleared and the delete says the shipped words", async () => {
		const { v, x1, early } = await renamedElsewhereOwed({ secondClaim: false });
		const hold = holdFirstRead(v, early.id);
		const s = launchOwing(v, x1);
		await turnsWhile(() => !hold.taken);
		expect(hold.taken, "precondition: the launch run's read of the kept ink's claims is held").toBe(true);
		const pane = await s.open(NEW);
		expect(pane.id, "precondition: the pane at the new name shows the found ink").toBe(x1);
		hold.let();
		await movesSettled(s);
		expect(s.plugin.pdfIds.get(pane.root), "precondition: the pane still shows the found ink").toBe(x1);
		expect(savedLeaves(v), "precondition: the launch run met the found ink's pane and left the leave owed off the old name").toEqual([{ id: x1, path: OTHER, from: early.id }]);
		const paneBefore = ids(s.pdfStore.strokes(x1));
		expect(paneBefore, "precondition: the found ink's pane shows its stroke and the one drawn since the owe").toEqual(["ink-0", "pane2"]);
		const run = await deleteAllOn(s, NEW);
		const words = await run.confirm();
		const cleared = clearedElseRefused(words, s, pane, paneBefore);
		await closeSecond(s, pane, x1);
		await nextOpensBlank(v, s, cleared);
	});

	it("B14 (c) and E (pins of base), bound 4 on the rename-elsewhere road: as (a), the found ink given a second claim after the owe, so the launch run cannot tell the new name and leaves the leave owed off the old name; Delete all at the new name from the kept ink's pane counts and clears the kept ink alone, as today, and the found ink keeps its ink, which its other PDF opens with; the next launch opens the new name blank in name order, and in reverse name order on the found ink with its strokes: the limit, whose cure is the open's order", async () => {
		const { v, x1, early } = await renamedElsewhereOwed({ secondClaim: true });
		const trashBefore = v.trashInk().length;
		const s = launchOwing(v, early.id);
		await settleGrace(s);
		await movesSettled(s);
		await movesSettled(s);
		expect(savedLeaves(v), "precondition: the launch run, unsure of the new name, left the leave owed off the old name").toEqual([{ id: x1, path: OTHER, from: early.id }]);
		expect(claimersOnDisk(v, NEW).sort(), "precondition: both inks still claim the new name").toEqual([early.id, x1].sort());
		expect(v.trashInk().length, "precondition: the launch run sent an ink file to the trash").toBe(trashBefore);
		const pane = await s.open(NEW);
		expect(pane.id, "precondition: the pane at the new name shows the kept ink").toBe(early.id);
		expect(ids(s.pdfStore.strokes(pane.id)), "precondition: the kept ink's pane shows its stroke").toEqual(["own"]);
		const run = await deleteAllOn(s, NEW);
		expect(run.words, "the command answered without its dialog").toEqual([]);
		expect(run.count, "the dialog's count is not the kept ink's stroke alone").toBe(1);
		const words = await run.confirm();
		expect(removedCounts(words), "not one removed notice, for the kept ink's stroke alone").toEqual(["1"]);
		expect(ids(s.pdfStore.strokes(early.id)), "the kept ink was not cleared").toEqual([]);
		expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "E: the found ink's file was cleared by a Delete all it is not reached from").toEqual(["ink-0", "pane2"]);
		await closeSecond(s, pane, early.id);
		await quit(s);
		const ends: string[][] = [];
		for (const order of ORDERS) {
			const { s: later, opened } = await relaunchOpen(v, order, NEW);
			ends.push(ids(later.pdfStore.strokes(later.plugin.pdfIds.get(opened.root) as string)));
			await quit(later);
		}
		expect(ends[0], "the next launch, the ink folder in name order: the new name opened with ink drawn before the delete").toEqual([]);
		expect(ends[1], "the limit moved: the next launch, the ink folder in reverse name order, no longer opens the new name on the found ink with its strokes (the open's order, a row after the release)").toEqual(["ink-0", "pane2"]);
		expect(await restartStrokes(v, "name order", ELSEWHERE), "E: the found ink's other PDF did not open on the found ink with its strokes").toEqual({ id: x1, strokes: ["ink-0", "pane2"] });
	});

	it("B14 (a, the waits), bound 1 on the rename-elsewhere road: as (a), the launch run let go while the kept ink's copy is made, so the leave reaches the new name during the delete's waits: the new name opens with no stroke drawn before the delete, or nothing is cleared and the delete says the shipped words", async () => {
		const { v, x1, early } = await renamedElsewhereOwed({ secondClaim: false });
		const hold = holdFirstRead(v, early.id);
		const s = launchOwing(v, early.id);
		await turnsWhile(() => !hold.taken);
		expect(hold.taken, "precondition: the launch run's read of the kept ink's claims is held").toBe(true);
		const pane = await s.open(NEW);
		expect(pane.id, "precondition: the pane at the new name shows the kept ink").toBe(early.id);
		expect(savedLeaves(v), "precondition: the launch run has not moved the leave").toEqual([{ id: x1, path: OTHER, from: early.id }]);
		const paneBefore = ids(s.pdfStore.strokes(pane.id));
		const preserve = s.store.preserve.bind(s.store);
		const waits = { let: false, reached: false };
		s.store.preserve = (async (id: string) => {
			const at = await preserve(id);
			if (id === early.id && !waits.let) {
				waits.let = true;
				hold.let();
				await turnsWhile(() => savedLeaves(v)[0]?.path === OTHER);
				waits.reached = savedLeaves(v)[0]?.path !== OTHER;
			}
			return at;
		}) as typeof s.store.preserve;
		const run = await deleteAllOn(s, NEW);
		const words = await run.confirm();
		expect(waits.reached, "precondition: the leave reached the new name during the kept ink's copy").toBe(true);
		const cleared = clearedElseRefused(words, s, pane, paneBefore);
		await closeSecond(s, pane, early.id);
		await nextOpensBlank(v, s, cleared);
	});

	it("W2, bound 1 on the rename-elsewhere road: as (a, the waits), the launch run let go during the kept ink's copy moves the leave to the new name and is held there before its carry until the delete ends: the new name opens with no stroke drawn before the delete, or nothing is cleared and the delete says the shipped words", async () => {
		const { v, x1, early, hold, s, pane } = await launchHeldKeptPane();
		const paneBefore = ids(s.pdfStore.strokes(pane.id));
		const carry = holdRunAt(s, x1, NEW);
		const preserve = s.store.preserve.bind(s.store);
		const waits = { let: false };
		s.store.preserve = (async (id: string) => {
			const at = await preserve(id);
			if (id === early.id && !waits.let) {
				waits.let = true;
				hold.let();
				await turnsWhile(() => !carry.taken);
			}
			return at;
		}) as typeof s.store.preserve;
		const run = await deleteAllOn(s, NEW);
		const words = await pressAndWait(s, run);
		expect(carry.taken, "precondition: during the kept ink's copy the launch run moved the leave to the new name and is held before its carry").toBe(true);
		expect(savedLeaves(v), "precondition: the leave is saved owed off the new name").toEqual([{ id: x1, path: NEW, from: early.id }]);
		const cleared = clearedElseRefused(words, s, pane, paneBefore);
		carry.let();
		await movesSettled(s);
		await closeSecond(s, pane, early.id);
		await nextOpensBlank(v, s, cleared);
	});

	it("N1-W, bound 1 on N1's road: the copy moved back to the old name by a delete and a create while the leave is owed off the new name, the kept ink's pane at the old name; Delete all there before the new name's retirement, the retirement landing during the kept ink's copy and moving the leave back, its run held before the carry until the delete ends: the old name opens with no stroke drawn before the delete, or nothing is cleared and the delete says the shipped words", async () => {
		const { v, next, x1, early } = await movedBackOwed();
		const pane = await next.open(OTHER);
		expect(pane.id, "precondition: the pane at the old name shows the kept ink").toBe(early.id);
		const paneBefore = ids(next.pdfStore.strokes(pane.id));
		expect(paneBefore, "precondition: the kept ink's pane shows its stroke").toEqual(["own"]);
		expect(savedLeaves(v), "precondition: the leave is still owed off the new name").toEqual([{ id: x1, path: NEW, from: early.id }]);
		const carry = holdRunAt(next, x1, OTHER);
		const preserve = next.store.preserve.bind(next.store);
		const waits = { let: false };
		next.store.preserve = (async (id: string) => {
			const at = await preserve(id);
			if (id === early.id && !waits.let) {
				waits.let = true;
				await vi.advanceTimersByTimeAsync(10_001);
				await turnsWhile(() => !carry.taken);
			}
			return at;
		}) as typeof next.store.preserve;
		const run = await deleteAllOn(next, OTHER);
		const words = await pressAndWait(next, run);
		expect(carry.taken, "precondition: during the kept ink's copy the new name's retirement moved the leave back to the old name, and its run is held before the carry").toBe(true);
		expect(savedLeaves(v), "precondition: the leave is saved owed off the old name").toEqual([{ id: x1, path: OTHER, from: early.id }]);
		const cleared = clearedElseRefused(words, next, pane, paneBefore);
		carry.let();
		await movesSettled(next);
		await closeSecond(next, pane, early.id);
		await nextOpensBlank(v, next, cleared, OTHER, "the old name");
	});

	for (const road of ["kept ink's pane", "found ink's pane"] as const) {
		it(`C (pin), bound 3 on the rename-elsewhere road: B14's road from the ${road}, Delete all at the new name: the dialog counts exactly the strokes the delete removes`, async () => {
			const at = road === "kept ink's pane" ? await launchHeldKeptPane() : await launchFoundPane();
			const run = await deleteAllOn(at.s, NEW);
			expect(run.words, "the command answered without its dialog").toEqual([]);
			const removed = removedCounts(await pressAndWait(at.s, run)).map(Number);
			expect(removed.length, "precondition: the delete cleared").toBeGreaterThan(0);
			expect(run.count, "the dialog did not count the strokes the delete removed").toBe(removed.reduce((a, b) => a + b, 0));
			if ("hold" in at) (at.hold as { let: () => void }).let();
			await movesSettled(at.s);
			endInSession(at.s);
		});
	}

	it("X (pin), bound 5: a leave owed at a quit off a live PDF, both inks still claiming it, the kept ink claiming another PDF as well; at the launch, before its run, Delete all at that other PDF from the kept ink's pane: the dialog counts the kept ink's stroke alone and the delete clears it alone, as today", async () => {
		const { v, next, x1, early, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await quit(next);
		expect(savedLeaves(v), "precondition: the leave is saved owed off the copy").toEqual([{ id: x1, path: OTHER, from: early.id }]);
		v.files.add(BESIDE);
		const keptFile = `.handwriting/${early.id}.json`;
		const page = parsePage(v.adapter.files.get(keptFile) as string, early.id).data;
		v.adapter.files.set(keptFile, serializePage({ ...page, pdfPaths: [...(page.pdfPaths ?? []), BESIDE] }));
		expect(claimersOnDisk(v, OTHER).sort(), "precondition: both inks claim the copy").toEqual([early.id, x1].sort());
		expect(claimersOnDisk(v, BESIDE), "precondition: the kept ink alone claims the other PDF").toEqual([early.id]);
		const hold = holdFirstRead(v, early.id);
		const s = launchOwing(v, early.id);
		await turnsWhile(() => !hold.taken);
		expect(hold.taken, "precondition: the launch run's read of the kept ink's claims is held").toBe(true);
		const pane = await s.open(BESIDE);
		expect(pane.id, "precondition: the pane at the other PDF shows the kept ink").toBe(early.id);
		const run = await deleteAllOn(s, BESIDE);
		expect(run.words, "the command answered without its dialog").toEqual([]);
		expect(run.count, "the dialog's count is not the kept ink's stroke alone").toBe(1);
		const words = await pressAndWait(s, run);
		expect(removedCounts(words), "not one removed notice, for the kept ink's stroke alone").toEqual(["1"]);
		expect(ids(s.pdfStore.strokes(early.id)), "the kept ink was not cleared").toEqual([]);
		expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "the found ink's file was cleared by another PDF's Delete all").toEqual(["ink-0", "pane2"]);
		hold.let();
		await movesSettled(s);
		endInSession(s);
	});

	it("B4 on the rename-elsewhere road, bound 2: B14 (a)'s road, the found ink's copy cannot be made: nothing is cleared, and no removed notice", async () => {
		const { v, x1, early, hold, s } = await launchHeldKeptPane();
		const preserve = s.store.preserve.bind(s.store);
		s.store.preserve = (async (id: string) => {
			if (id === x1) throw new Error("Handwriting: the newest ink could not be written to disk");
			return preserve(id);
		}) as typeof s.store.preserve;
		vi.spyOn(console, "error").mockImplementation(() => {});
		const run = await deleteAllOn(s, NEW);
		const words = await pressAndWait(s, run);
		expect(words.filter((w) => REMOVED.test(w)), "a removed notice was shown").toEqual([]);
		expect(ids(s.pdfStore.strokes(early.id)), "the kept ink was cleared").toEqual(["own"]);
		expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "the found ink's file was cleared").toEqual(["ink-0", "pane2"]);
		hold.let();
		await movesSettled(s);
		endInSession(s);
	});

	it("R (read-in), bound 3: B14 (a)'s road, the found ink's file damaged after the dialog opened: the delete does not read it in, clears nothing, and says the ink storage is not ready, alone", async () => {
		const { v, x1, early, hold, s } = await launchHeldKeptPane();
		const run = await deleteAllOn(s, NEW);
		expect(run.words, "the command answered without its dialog").toEqual([]);
		expect(s.pdfStore.generation(x1), "precondition: the found ink is still not read").toBeNull();
		const foundFile = `.handwriting/${x1}.json`;
		const foundBytes = v.adapter.files.get(foundFile);
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		v.adapter.files.set(foundFile, "{ not a page");
		const words = await pressAndWait(s, run);
		expect(words.filter((w) => REMOVED.test(w)), "a removed notice was shown").toEqual([]);
		// One notice: the store's line, that new ink on the PDF is not saved until it loads, is untrue of the pane's ink.
		expect(words, "the delete did not say the ink storage is not ready, and that alone").toEqual([NOT_READY]);
		expect(s.pdfStore.generation(x1), "a record of the found ink was left behind").toBeNull();
		expect(ids(s.pdfStore.strokes(early.id)), "the kept ink was cleared").toEqual(["own"]);
		v.adapter.files.set(foundFile, foundBytes as string);
		expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "precondition: the found ink's file is whole again").toEqual(["ink-0", "pane2"]);
		hold.let();
		await movesSettled(s);
		endInSession(s);
	});

	it("R (read-in) on the same-name road, bound 3: B1's road, the kept ink's file damaged after the dialog opened: the delete does not read it in, clears nothing, and says the ink storage is not ready, alone", async () => {
		const { v, next, x1, early } = await keptClosed();
		const run = await deleteAllOn(next, OTHER);
		expect(run.words, "the command answered without its dialog").toEqual([]);
		expect(run.count, "precondition: the dialog counts the found ink's stroke and the kept ink's").toBe(2);
		const keptFile = `.handwriting/${early.id}.json`;
		const keptBytes = v.adapter.files.get(keptFile);
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		v.adapter.files.set(keptFile, "{ not a page");
		const words = await pressAndWait(next, run);
		expect(words.filter((w) => REMOVED.test(w)), "a removed notice was shown").toEqual([]);
		// One notice: the store's line, that new ink on the PDF is not saved until it loads, is untrue of the pane's ink.
		expect(words, "the delete did not say the ink storage is not ready, and that alone").toEqual([NOT_READY]);
		expect(next.pdfStore.generation(early.id), "a record of the kept ink was left behind").toBeNull();
		expect(v.adapter.files.get(keptFile), "the kept ink's file was written").toBe("{ not a page");
		v.adapter.files.set(keptFile, keptBytes as string);
		nothingCleared(v, next, x1, early.id);
		endInSession(next);
	});
});
