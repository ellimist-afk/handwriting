/**
 * Ink found for a PDF path must leave that path when the blank opened on it was drawn on before its pane moved. While a
 * second pane shows the found ink, the leave is owed and runs when that pane lets it go. Strokes drawn on the found ink
 * since the leave was owed go into the kept ink (the blank drawn on), by the existing carry; then the found ink goes to
 * the trash whole. Never the other way. Cases A to M: a stroke in the second pane, a restart, a quit with the second
 * pane open (inside and after the grace, the ink folder listed in either order), a rename, a failed remove, the panes
 * closed in the other order, a carry that cannot land, a twin pane, a stroke still unsaved, the found ink's own strokes
 * changed (a pin); a third pane while owed; a probe of a pane waiting to move across a rename; the saved state across a
 * quit; and the reads an open and a close make with nothing owed.
 *
 * Every cell passes. The pins (C, L) and the cells marked as results passed when written; the rest were red before
 * their cure and pass since. A red in any of them is a regression, not an expected failure. Except the cells of a launch
 * whose layout is ready only later, marked so (the six before the vault lists the renamed copy, the four that list one
 * file only at the layout, the four that also let the found ink go before it, the two quit again before it), and the
 * one let-go while a workspace loads after a load past the layout, and the two of a later build's stroke fields carried off
 * the found ink at a launch: written red, before their cure.
 * Through the plugin and the real stores, with an in-memory vault: the harness of PdfTiedHoldOpenedBeforeListFull.test.ts,
 * copied (its helpers are not exported, and that file is not edited here).
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

import HandwritingPlugin from "../main";
import { TFile, Notice } from "obsidian";
import pluginSettingsSource from "../settings/PluginSettings.ts?raw";
import mainSource from "../main.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { READ_SCHEMA_VERSION, parsePage, serializePage } from "../model/PageData";
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
	// The host's notice for an ink file that cannot be read yet goes through blockNotice; a plain Notice stands in.
	installPdfHost.call(plugin, Notice, (m: string) => new Notice(m));
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
	return { store, pdfStore, plugin, open, close, draw, deleteFile, createFile, renameFile, checked };
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

describe("a leave owed while a second pane shows the ink found for the copy", () => {
	it("A: a stroke in the second pane while the leave is owed, then that pane closed: the stroke on the kept ink, the found ink in the trash whole, one claim on the copy", async () => {
		const { v, next, x1, x2, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		expect(v.sidecar(secondAt)?.strokes.map((x) => x.id), "precondition: the second pane's stroke is written").toEqual(["ink-0", "pane2"]);
		// The kept ink's file as it stands before the close: after it, only the carried stroke may differ.
		const keptBefore = v.sidecar(early.id);
		expect(keptBefore, "precondition: the kept ink's file is written").toBeDefined();
		await closeSecond(next, second, secondAt);
		vi.useRealTimers();
		expect(next.plugin.pdfIds.get(early.root), "the first pane left the kept ink").toBe(early.id);
		await vi.waitFor(() => expect(next.pdfStore.strokes(early.id).map((x) => x.id).sort(), "the kept ink does not hold the second pane's stroke").toEqual(["own", "pane2"]));
		await next.store.flush();
		const keptAfter = v.sidecar(early.id);
		expect(keptAfter?.strokes.map((x) => x.id).sort(), "the kept ink's file does not hold the second pane's stroke").toEqual(["own", "pane2"]);
		// The found ink's other page data stays its own: beside the carried stroke, the kept ink's file is as it was.
		expect({ ...keptAfter, strokes: keptAfter?.strokes.filter((x) => x.id !== "pane2") }, "the kept ink's file changed beyond the carried stroke").toEqual(keptBefore);
		expect(claimersOnDisk(v, OTHER), "not one ink file claims the copy on disk").toEqual([early.id]);
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		const again = await next.open(OTHER);
		expect(next.pdfStore.strokes(again.id).map((x) => x.id).sort(), "a new pane on the copy opens without both strokes").toEqual(["own", "pane2"]);
	});

	for (const order of ORDERS) {
		it(`B: A, then a restart, the ink folder in ${order}: the copy opens on the kept ink with both strokes`, async () => {
			const { v, next, early, second, secondAt } = await owedLeave({ settle: true });
			next.draw(secondAt, stroke(61, "pane2"));
			await next.store.flush();
			await closeSecond(next, second, secondAt);
			vi.useRealTimers();
			await next.store.flush();
			expect(await restartStrokes(v, order), "after a restart the copy does not open on the kept ink with both strokes").toEqual({ id: early.id, strokes: ["own", "pane2"] });
		});
	}

	it("C (pin): no stroke in the second pane, then that pane closed: the found ink to the trash whole, one claim, the kept ink unchanged", async () => {
		const { v, next, x1, x2, early, second, secondAt } = await owedLeave({ settle: true });
		await closeSecond(next, second, secondAt);
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "not one ink file claims the copy on disk").toEqual([early.id]));
		expect(next.pdfStore.strokes(early.id).map((x) => x.id), "the kept ink changed").toEqual(["own"]);
		foundInTrashWhole(v, x1, ["ink-0"]);
		expect(await restartStrokes(v, "name order"), "after a restart the copy does not open on the kept ink").toEqual({ id: early.id, strokes: ["own"] });
	});

	for (const [label, when, settle] of [["D", "after the grace", true], ["M", "inside the grace", false]] as const) {
		for (const order of ORDERS) {
			it(`${label}: a quit ${when} with the second pane open and no stroke in it, then a launch, the ink folder in ${order}: one claim, the copy on the kept ink, the found ink in the trash whole`, async () => {
				const { v, next, x1, x2, early } = await owedLeave({ settle });
				expect(next.pdfStore.pendingClaims().size > 0, `precondition: the quit comes ${when}`).toBe(!settle);
				await quit(next);
				const { s, opened } = await relaunchOpen(v, order);
				const at = s.plugin.pdfIds.get(opened.root) as string;
				vi.useRealTimers();
				expect(at, "after the launch the copy did not open on the kept ink").toBe(early.id);
				expect(s.pdfStore.strokes(at).map((x) => x.id), "after the launch the copy opens without the first pane's stroke").toEqual(["own"]);
				await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "after the launch, not one ink file claims the copy on disk").toEqual([early.id]));
				foundInTrashWhole(v, x1, ["ink-0"]);
				expect(await restartStrokes(v, order), "after a further restart the copy does not open on the kept ink").toEqual({ id: early.id, strokes: ["own"] });
			});
		}
	}

	for (const order of ORDERS) {
		it(`E: a stroke in the second pane, then a quit with it open, then a launch, the ink folder in ${order}: that stroke on the kept ink`, async () => {
			const { v, next, x1, x2, early, secondAt } = await owedLeave({ settle: true });
			next.draw(secondAt, stroke(61, "pane2"));
			await quit(next);
			const { s, opened } = await relaunchOpen(v, order);
			const at = s.plugin.pdfIds.get(opened.root) as string;
			vi.useRealTimers();
			expect(at, "after the launch the copy did not open on the kept ink").toBe(early.id);
			await vi.waitFor(() => expect(s.pdfStore.strokes(at).map((x) => x.id).sort(), "after the launch the kept ink does not hold the second pane's stroke").toEqual(["own", "pane2"]));
			await s.store.flush();
			expect(claimersOnDisk(v, OTHER), "after the launch, not one ink file claims the copy on disk").toEqual([early.id]);
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
			expect(await restartStrokes(v, order), "after a further restart the copy does not open on the kept ink with both strokes").toEqual({ id: early.id, strokes: ["own", "pane2"] });
		});
	}

	it("F: the copy renamed while the leave is owed, a stroke in the second pane, then that pane closed: as A, on the new name", async () => {
		const { v, next, x1, x2, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		await next.renameFile(OTHER, NEW);
		await movesSettled(next);
		expect(claimersOnDisk(v, NEW).sort(), "precondition: the rename moved both claims").toEqual([x1, early.id].sort());
		await closeSecond(next, second, secondAt);
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, NEW), "not one ink file claims the new name on disk").toEqual([early.id]));
		await next.store.flush();
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the kept ink's file does not hold the second pane's stroke").toEqual(["own", "pane2"]);
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		expect(await restartStrokes(v, "name order", NEW), "after a restart the new name does not open on the kept ink with both strokes").toEqual({ id: early.id, strokes: ["own", "pane2"] });
	});

	it("G, one owed leave only (no road to two found): its remove fails once when the second pane closes: nothing lost, and the found ink's record is released", async () => {
		const { v, next, x1, x2, early, second, secondAt } = await owedLeave({ settle: true });
		const remove = next.store.remove.bind(next.store);
		let failed = false;
		next.store.remove = (async (id: string, ...rest: unknown[]) => {
			if (id === x1 && !failed) {
				failed = true;
				throw new Error("the ink file could not be moved to the trash");
			}
			return (remove as (...a: unknown[]) => Promise<unknown>)(id, ...rest);
		}) as typeof next.store.remove;
		vi.spyOn(console, "error").mockImplementation(() => {});
		next.close(second.root);
		next.plugin.releasePdfId(secondAt);
		// The harness waits on the leave it keeps; the failure it meets there is this cell's own, and the waits go on.
		for (let i = 0; i < 3; i++) {
			try {
				await movesSettled(next);
			} catch (e) {
				expect(String(e), "the waits met another error than the failed remove").toContain("could not be moved to the trash");
			}
		}
		vi.useRealTimers();
		expect(failed, "precondition: the owed leave tried to remove the found ink").toBe(true);
		expect(next.pdfStore.strokes(early.id).map((x) => x.id), "the kept ink changed").toEqual(["own"]);
		expect(keptStrokes(v, [x1, x2]), "a deleted ink was lost, neither kept nor in the trash").toEqual(expect.arrayContaining(["ink-0", "ink-1"]));
		await vi.waitFor(() => expect(next.pdfStore.generation(x1), "after a failed remove, the found ink's record is never released").toBeNull());
	});

	it("H: a stroke in the second pane, the first pane closed, then the second: as A", async () => {
		const { v, next, x1, x2, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		next.close(early.root);
		next.plugin.releasePdfId(early.id);
		await movesSettled(next);
		await closeSecond(next, second, secondAt);
		vi.useRealTimers();
		await vi.waitFor(() => expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the kept ink's file does not hold the second pane's stroke").toEqual(["own", "pane2"]));
		expect(liveInkFiles(v).filter((id) => id !== early.id && id !== x2), "another live ink file is left beside the kept ink").toEqual([]);
		expect(claimersOnDisk(v, OTHER), "not one ink file claims the copy on disk").toEqual([early.id]);
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		expect(await restartStrokes(v, "name order"), "after a restart the copy does not open on the kept ink with both strokes").toEqual({ id: early.id, strokes: ["own", "pane2"] });
	});

	for (const order of ORDERS) {
		it(`I: H with the kept ink's file unreadable when the second pane closes: the found ink stays live with its stroke, nothing to the trash; the file whole again and a launch, the ink folder in ${order}: the leave runs`, async () => {
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
			v.adapter.files.set(keptPath, "{ not a page");
			const trashBefore = v.trashInk().length;
			vi.spyOn(console, "error").mockImplementation(() => {});
			vi.spyOn(console, "warn").mockImplementation(() => {});
			await closeSecond(next, second, secondAt);
			await next.store.flush();
			expect(v.sidecar(x1)?.strokes.map((x) => x.id), "the found ink left with the second pane's stroke while the carry could not land").toEqual(["ink-0", "pane2"]);
			expect(claimersOnDisk(v, OTHER), "the found ink gave up the copy while the carry could not land").toContain(x1);
			expect(v.trashInk().length, "an ink file went to the trash while the carry could not land").toBe(trashBefore);
			// The kept ink's file is whole again (a sync put it back): the leave is still owed, and runs at the next launch.
			v.adapter.files.set(keptPath, keptBytes as string);
			await quit(next);
			const { s } = await relaunchOpen(v, order);
			vi.useRealTimers();
			await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "after the launch, the leave was not owed any more: not one ink file claims the copy").toEqual([early.id]));
			await s.store.flush();
			expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "after the launch the kept ink's file does not hold the second pane's stroke").toEqual(["own", "pane2"]);
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		});
	}

	it("J, by a second pane on the found ink: a stroke in each, closed one after the other: each stroke on the kept ink once", async () => {
		const { v, next, x1, x2, early, second, secondAt, twin } = await owedLeave({ settle: true, twin: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		await closeSecond(next, second, secondAt);
		expect(v.sidecar(x1)?.pdfPaths, "precondition: with the twin pane on it, the found ink keeps the copy").toEqual([OTHER]);
		next.draw(x1, stroke(62, "twin"));
		await next.store.flush();
		await closeSecond(next, twin!, x1);
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "not one ink file claims the copy on disk").toEqual([early.id]));
		await next.store.flush();
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the kept ink does not hold each stroke once").toEqual(["own", "pane2", "twin"]);
		foundInTrashWhole(v, x1, ["ink-0", "pane2", "twin"]);
	});

	it("J with a change check of the copy after the second pane's stroke: every owe it makes counted (logged), and each stroke on the kept ink once", async () => {
		const { v, next, x1, early, second, twin } = await owedLeave({ settle: true, twin: true });
		const secondAt = next.plugin.pdfIds.get(second.root) as string;
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		// Every leave started from here on, whatever road starts it.
		const leave = next.plugin.pairedInkLeaves as (id: string, path: string, from: string) => Promise<void>;
		const leaves: string[] = [];
		// Each start logs what the second and twin panes show then, to tell a second owe from a let-go.
		const panesNow = () => `second=${next.plugin.pdfIds.get(second.root) ?? "none"} twin=${next.plugin.pdfIds.get(twin!.root) ?? "none"}`;
		next.plugin.pairedInkLeaves = (id: string, path: string, from: string) => (leaves.push(`${id} ${path} ${from} [${panesNow()}]`), leave.call(next.plugin, id, path, from));
		await next.plugin.onPdfModified(OTHER);
		await movesSettled(next);
		const atCheck = leaves.length;
		console.log(`J change check: leaves started before the let-go ${atCheck}: ${JSON.stringify(leaves)}; after the check ${panesNow()}`);
		// The rule: a pane already on the found ink keeps it until it closes, through a change check too.
		expect(next.plugin.pdfIds.get(second.root), "the change check moved the second pane off the found ink").toBe(x1);
		expect(next.plugin.pdfIds.get(twin!.root), "the change check moved the twin pane off the found ink").toBe(x1);
		const twinAt = next.plugin.pdfIds.get(twin!.root) as string;
		next.draw(twinAt, stroke(62, "twin"));
		await next.store.flush();
		await closeSecond(next, second, next.plugin.pdfIds.get(second.root) as string);
		await closeSecond(next, twin!, twinAt);
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "not one ink file claims the copy on disk").toEqual([early.id]));
		await next.store.flush();
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the kept ink does not hold each stroke once").toEqual(["own", "pane2", "twin"]);
		expect(v.sidecar(x1), "the found ink's file is still live").toBeUndefined();
	});

	it("K: the second pane's stroke still inside the save delay when that pane closes: carried", async () => {
		const { v, next, x1, x2, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await closeSecond(next, second, secondAt);
		vi.useRealTimers();
		await vi.waitFor(() => expect(next.pdfStore.strokes(early.id).map((x) => x.id).sort(), "the kept ink does not hold the unsaved stroke").toEqual(["own", "pane2"]));
		await next.store.flush();
		expect(claimersOnDisk(v, OTHER), "not one ink file claims the copy on disk").toEqual([early.id]);
		expect(await restartStrokes(v, "name order"), "after a restart the copy does not open on the kept ink with both strokes").toEqual({ id: early.id, strokes: ["own", "pane2"] });
	});

	for (const [what, change] of [
		["erased", () => [] as InkStroke[]],
		["moved", () => [{ ...stroke(110, "ink-0") }]],
	] as const) {
		it(`L (pin): the found ink's own stroke ${what} in the second pane, then that pane closed: not carried`, async () => {
			const { v, next, x1, x2, early, second, secondAt } = await owedLeave({ settle: true });
			next.pdfStore.replaceAll(secondAt, change());
			await next.store.flush();
			await closeSecond(next, second, secondAt);
			vi.useRealTimers();
			await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "not one ink file claims the copy on disk").toEqual([early.id]));
			expect(next.pdfStore.strokes(early.id).map((x) => x.id), "the found ink's own stroke reached the kept ink").toEqual(["own"]);
			// An ink file left with no stroke is removed without a trash copy (as at base, 85ee8461 run); one with a stroke goes to the trash whole.
			if (what === "erased") expect(v.sidecar(x1), "the found ink's file is still live").toBeUndefined();
			else foundInTrashWhole(v, x1, ["ink-0"]);
			expect(await restartStrokes(v, "name order"), "after a restart the copy does not open on the kept ink alone").toEqual({ id: early.id, strokes: ["own"] });
		});
	}

	for (const order of ORDERS) {
		it(`a third pane opened on the copy while the leave is owed, the ink folder in ${order}: it shows the kept ink`, async () => {
			const { next, early } = await owedLeave({ settle: true });
			listInOrder(next, order);
			const third = await next.open(OTHER);
			vi.useRealTimers();
			expect(third.id, "the third pane opened on the found ink").toBe(early.id);
			expect(next.pdfStore.strokes(third.id).map((x) => x.id), "the third pane does not show the kept ink").toEqual(["own"]);
		});
	}

	it("probe: the copy renamed while the first pane waits to move onto the found ink: the pane still moves, onto ink that claims the new name", async () => {
		const { v, next, x1, x2, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		const controller = next.plugin.pdfInk.get(early.root) as { idle: boolean };
		controller.idle = false;
		layoutReady();
		await settleGrace(next);
		await movesSettled(next);
		expect(next.plugin.pdfIds.get(early.root), "precondition: the busy pane waits on its blank").toBe(early.id);
		expect(claimersAmong(v, [x1, x2], OTHER), "precondition: the found ink claims the copy").toEqual([x1]);
		await next.renameFile(OTHER, NEW);
		controller.idle = true;
		await movesSettled(next);
		await movesSettled(next);
		await movesSettled(next);
		vi.useRealTimers();
		expect(next.plugin.pdfIds.get(early.root), "the pane never moved onto the found ink after the rename").toBe(x1);
		expect(claimersOnDisk(v, NEW), "not one ink file claims the new name on disk").toEqual([x1]);
	});

	it("rule 4: a quit with a leave owed saves the deletions as a build without owed leaves reads them, and every ink file keeps the fields it had", async () => {
		const fieldsOf = (v: ReturnType<typeof vault>) =>
			[...v.adapter.files.entries()]
				.filter(([p]) => p.startsWith(".handwriting/") && p.endsWith(".json") && !p.includes("/trash/"))
				.map(([p, bytes]) => `${p.split("/").pop()}:${Object.keys(JSON.parse(bytes)).sort().join(",")}`)
				.sort();
		const { v, next, pendingFields } = await owedLeave({ settle: false });
		await quit(next);
		const pending = JSON.parse(v.local.get(PENDING_KEY) as string) as Record<string, unknown>[];
		for (const e of pending) {
			const extra = Object.keys(e).filter((k) => !pendingFields.has(k));
			expect(extra, "a saved deletion carries a field an earlier build does not write").toEqual([]);
		}
		// An earlier build reads this list as deletions: each entry is one of the PDFs deleted, once. (FIRST's deletion
		// ends when its ink is found for the copy, so at this quit only SECOND waits: 85ee8461 run.)
		const paths = pending.map((e) => e.path as string);
		expect(paths.filter((p) => p !== FIRST && p !== SECOND), "the saved deletions hold an entry that is not a deletion").toEqual([]);
		expect(paths.length, "the saved deletions name one PDF twice").toBe(new Set(paths).size);
		// The same quit with no leave owed (the second pane closed first): the saved deletions are the same list.
		const control = await owedLeave({ settle: false });
		await closeSecond(control.next, control.second, control.secondAt);
		expect(control.next.pdfStore.pendingClaims().size > 0, "precondition: the control's quit comes inside the grace").toBe(true);
		await quit(control.next);
		expect(pending, "the saved deletions differ from the same quit with no leave owed").toEqual(JSON.parse(control.v.local.get(PENDING_KEY) as string));
		const base = vault();
		const { s } = await inked(base, [FIRST, SECOND]);
		await s.store.flush();
		const allowed = new Set(fieldsOf(base).map((f) => f.split(":")[1]).join(",").split(","));
		for (const f of fieldsOf(v)) {
			const extra = (f.split(":")[1] ?? "").split(",").filter((k) => !allowed.has(k));
			expect(extra, `ink file ${f.split(":")[0]} carries a field an earlier build does not write`).toEqual([]);
		}
		expect([...v.local.keys()].filter((k) => k !== PENDING_KEY).length, "more than one new device-local key").toBeLessThanOrEqual(1);
	});

	it("rule 4: a launch over a store with the deletions saved but no owed leave saved reads as nothing owed: no error, no notice, no ink lost", async () => {
		const { v, next, x1, x2, early } = await owedLeave({ settle: true });
		await quit(next);
		for (const k of [...v.local.keys()]) if (k !== PENDING_KEY) v.local.delete(k);
		const { s, opened } = await relaunchOpen(v, "name order");
		vi.useRealTimers();
		expect(opened.id === x1 || opened.id === early.id, "the copy opened on neither of its inks").toBe(true);
		expect([...new Set([...keptStrokes(v, [x1, x2]), ...(v.sidecar(early.id)?.strokes.map((x) => x.id) ?? [])])].sort(), "ink was lost").toEqual(expect.arrayContaining(["ink-0", "ink-1", "own"]));
		expect(shown, "a notice showed").toEqual([]);
		void s;
	});

	it("rule 6: an open and a close of a PDF with nothing owed: the file lists and reads it makes (measured at base, pinned)", async () => {
		const v = vault();
		await inked(v, [FIRST]);
		const s = session(v);
		const count = { list: 0, read: 0, local: 0, listIds: 0, readPdfPaths: 0 };
		const list = v.adapter.list.bind(v.adapter);
		const read = v.adapter.read.bind(v.adapter);
		v.adapter.list = async (f: string) => (count.list++, list(f));
		v.adapter.read = async (p: string) => (count.read++, read(p));
		const loadLocal = s.plugin.app.loadLocalStorage;
		s.plugin.app.loadLocalStorage = (k: string) => (count.local++, loadLocal(k));
		const listIds = s.store.listIds.bind(s.store);
		s.store.listIds = (async (p: string) => (count.listIds++, listIds(p))) as typeof s.store.listIds;
		const readPdfPaths = s.store.readPdfPaths.bind(s.store);
		s.store.readPdfPaths = (async (id: string) => (count.readPdfPaths++, readPdfPaths(id))) as typeof s.store.readPdfPaths;
		const o = await s.open(FIRST);
		await s.store.flush();
		const atOpen = { ...count };
		s.close(o.root);
		s.plugin.releasePdfId(o.id);
		await s.pdfStore.settle();
		await s.store.flush();
		const atClose = Object.fromEntries(Object.entries(count).map(([k, n]) => [k, n - atOpen[k as keyof typeof count]]));
		// The open's counts are written out, to be pinned from the run at base; a close lists and reads nothing.
		const out = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.HANDWRITING_COUNTS_OUT;
		if (out) (await import("node:fs")).writeFileSync(out, JSON.stringify({ open: atOpen, close: atClose }) + "\n");
		// Pinned from the run at 85ee8461 (rule6-counts-85ee8461.json), the code under test at base d7f069db.
		expect(atOpen, "an open with nothing owed lists, reads or loads more than at base").toEqual({ list: 2, read: 2, local: 0, listIds: 1, readPdfPaths: 1 });
		expect(atClose, "a close with nothing owed lists or reads").toEqual({ list: 0, read: 0, local: 0, listIds: 0, readPdfPaths: 0 });
		expect(shown, "a notice showed").toEqual([]);
	});

	for (const [label, drawn] of [["D", false], ["E", true]] as const) {
		for (const order of ORDERS) {
			it(`${label} with both panes restored at the launch, the ink folder in ${order}: both on the kept ink${drawn ? " with the second pane's stroke" : ""}, one claim`, async () => {
				const { v, next, x1, x2, early, secondAt } = await owedLeave({ settle: true });
				if (drawn) next.draw(secondAt, stroke(61, "pane2"));
				await quit(next);
				const s = listInOrder(session(v, { pendingStore: true }), order);
				const one = await s.open(OTHER);
				const two = await s.open(OTHER);
				await settleGrace(s);
				await movesSettled(s);
				await movesSettled(s);
				vi.useRealTimers();
				const want = drawn ? ["own", "pane2"] : ["own"];
				for (const [n, pane] of [["first", one], ["second", two]] as const) {
					expect(s.plugin.pdfIds.get(pane.root), `the ${n} restored pane is not on the kept ink`).toBe(early.id);
				}
				await vi.waitFor(() => expect(s.pdfStore.strokes(early.id).map((x) => x.id).sort(), "the restored panes do not show the kept ink").toEqual(want));
				await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "after the launch, not one ink file claims the copy on disk").toEqual([early.id]));
				foundInTrashWhole(v, x1, drawn ? ["ink-0", "pane2"] : ["ink-0"]);
			});
		}
	}

	for (const [order, end] of [["name order", "quit"], ["reverse name order", "quit"], ["name order", "crash"]] as const) {
		it(`the kept ink's save failing when the second pane closes (its claim readable, its pane open): the found ink stays live with the stroke and the copy, nothing to the trash; then a ${end === "quit" ? "quit (saves flushed)" : "crash (no save flushed)"}, the save working again and a launch, the ink folder in ${order}: one claim, the stroke on the kept ink, the found ink in the trash whole`, async () => {
			const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
			next.draw(secondAt, stroke(61, "pane2"));
			await next.store.flush();
			expect(next.plugin.pdfIds.get(early.root), "precondition: the kept ink's pane is open").toBe(early.id);
			expect(v.sidecar(early.id)?.pdfPaths, "precondition: the kept ink's claim reads").toEqual([OTHER]);
			const trashBefore = v.trashInk().length;
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
			expect(v.sidecar(x1)?.strokes.map((x) => x.id), "the found ink left while the kept ink's save had not landed").toEqual(["ink-0", "pane2"]);
			expect(claimersOnDisk(v, OTHER), "the found ink gave up the copy while the kept ink's save had not landed").toContain(x1);
			expect(v.trashInk().length, "an ink file went to the trash while the kept ink's save had not landed").toBe(trashBefore);
			if (end === "quit") {
				refusing = false;
				await quit(next);
			} else {
				// The app ends with no save flushed: what landed before is all the next launch has.
				next.plugin.unloaded = true;
				next.pdfStore.cancelPendingDeletes();
				// The dead session's save timers die with it: none may land on the shared clock during the next launch.
				vi.clearAllTimers();
				refusing = false;
				expect(v.sidecar(early.id)?.strokes.map((x) => x.id), "precondition: at the crash the kept ink's file holds only its own stroke").toEqual(["own"]);
			}
			const { s, opened } = await relaunchOpen(v, order);
			vi.useRealTimers();
			expect(opened.id, "after the launch the copy did not open on the kept ink").toBe(early.id);
			await vi.waitFor(() => expect(s.pdfStore.strokes(early.id).map((x) => x.id).sort(), "after the launch the kept ink does not hold the second pane's stroke").toEqual(["own", "pane2"]));
			await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "after the launch, not one ink file claims the copy on disk").toEqual([early.id]));
			await s.store.flush();
			expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "after the launch the kept ink's file does not hold the second pane's stroke").toEqual(["own", "pane2"]);
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		});
	}

	/** The kept ink's claims read from disk failing once, answered as the store answers a read that fails: null, not a throw. */
	function readFailsOnce(next: ReturnType<typeof session>, id: string) {
		const readPdfPaths = next.store.readPdfPaths.bind(next.store);
		const state = { failed: false };
		next.store.readPdfPaths = (async (at: string) => {
			if (at === id && !state.failed) {
				state.failed = true;
				return null;
			}
			return readPdfPaths(at);
		}) as typeof next.store.readPdfPaths;
		vi.spyOn(console, "error").mockImplementation(() => {});
		return state;
	}

	for (const fails of ["remove", "read"] as const) {
		for (const order of ORDERS) {
			it(`G, the ${fails === "remove" ? "found ink's remove" : "kept ink's claims read (its pane closed first)"} failing once at the last close, then a launch, the ink folder in ${order}: nothing lost, no ink file claiming nothing, the record released; the leave stays owed and runs: the found ink in the trash whole, one claim, a new copy of the bytes opens blank`, async () => {
				const { v, next, x1, x2, early, second, secondAt } = await owedLeave({ settle: true });
				if (fails === "read") {
					next.close(early.root);
					next.plugin.releasePdfId(early.id);
					await movesSettled(next);
				}
				const fail = fails === "remove" ? removeFailsOnce(next, x1) : readFailsOnce(next, early.id);
				next.close(second.root);
				next.plugin.releasePdfId(secondAt);
				await settledPastFailure(next);
				expect(fail.failed, `precondition: the owed leave's ${fails} failed`).toBe(true);
				expect([...keptStrokes(v, [x1, x2]), ...(v.sidecar(early.id)?.strokes.map((x) => x.id) ?? [])].sort(), "after the failure, ink was lost").toEqual(expect.arrayContaining(["ink-0", "ink-1", "own"]));
				expect(liveInkFiles(v).filter((id) => (v.sidecar(id)?.pdfPaths ?? []).length === 0), "after the failure, a live ink file claims nothing").toEqual([]);
				// Asserted last, so the launch's lines run at base too.
				const recordAfterFailure = next.pdfStore.generation(x1);
				await quit(next);
				const { s } = await relaunchOpen(v, order);
				vi.useRealTimers();
				await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "after the launch, not one ink file claims the copy on disk").toEqual([early.id]));
				foundInTrashWhole(v, x1, ["ink-0"]);
				expect(liveInkFiles(v).filter((id) => (v.sidecar(id)?.pdfPaths ?? []).length === 0), "a live ink file claims nothing, for the next copy to take").toEqual([]);
				await s.createFile("Desk/A.pdf");
				await s.store.flush();
				await expectBlank(v, "Desk/A.pdf");
				expect(recordAfterFailure, "after the failure, the found ink's record was never released").toBeNull();
			});
		}
	}

	for (const order of ORDERS) {
		it(`G, the found ink's move into the trash failing once at the last close, a stroke carried first, then a launch, the ink folder in ${order}: the leave stays owed and saved, the found ink's file live and claiming the copy is not taken as gone; at the launch the leave runs: the found ink in the trash whole, one claim, the copy on the kept ink with every stroke once`, async () => {
			const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
			next.draw(secondAt, stroke(61, "pane2"));
			await next.store.flush();
			const fail = removeFailsOnce(next, x1);
			next.close(second.root);
			next.plugin.releasePdfId(secondAt);
			await settledPastFailure(next);
			expect(fail.failed, "precondition: the found ink's move into the trash failed").toBe(true);
			const saved = JSON.parse((v.local.get("handwriting-pdf-owed-leaves") as string | undefined) ?? "[]") as { id: string; path: string; from: string }[];
			expect.soft(saved.filter((e) => e.id === x1 && e.path === OTHER && e.from === early.id), "after the failed move, the leave is not saved as owed").toHaveLength(1);
			expect.soft(v.sidecar(x1)?.pdfPaths, "precondition: the failed move left the found ink's file live, claiming the copy").toEqual([OTHER]);
			expect.soft(next.plugin.pdfLeftForTrash(x1), "after the failed move, the found ink is taken as gone to the trash").toBe(false);
			expect.soft(liveInkFiles(v).filter((id) => (v.sidecar(id)?.pdfPaths ?? []).length === 0), "after the failed move, a live ink file claims nothing").toEqual([]);
			await quit(next);
			const { s, opened } = await relaunchOpen(v, order);
			vi.useRealTimers();
			expect.soft(opened.id, "after the launch the copy did not open on the kept ink").toBe(early.id);
			await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "after the launch, not one ink file claims the copy on disk").toEqual([early.id]));
			await s.store.flush();
			expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "after the launch the kept ink's file does not hold every stroke once").toEqual(["own", "pane2"]);
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		});
	}

	/** The leave saved as owed for the found ink and the copy, from the kept ink. */
	function savedOwed(v: ReturnType<typeof vault>, x1: string, from: string) {
		const saved = JSON.parse((v.local.get("handwriting-pdf-owed-leaves") as string | undefined) ?? "[]") as { id: string; path: string; from: string }[];
		return saved.filter((e) => e.id === x1 && e.path === OTHER && e.from === from);
	}

	it("G, the found ink's move into the trash failing once, then one more run of the leave in the same session: the move lands, one claim on the copy, the leave ends; a same-bytes PDF at a third path opens blank", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		const fail = removeFailsOnce(next, x1);
		next.close(second.root);
		next.plugin.releasePdfId(secondAt);
		await settledPastFailure(next);
		expect(fail.failed, "precondition: the found ink's move into the trash failed").toBe(true);
		// The found ink let go once more in this session (no launch): its owed leave runs again, and the move now lands.
		next.plugin.releasePdfId(x1);
		await settledPastFailure(next);
		expect.soft(claimersOnDisk(v, OTHER), "after the second run, not one ink file claims the copy on disk").toEqual([early.id]);
		expect.soft(v.sidecar(x1), "after the second run, the found ink's file is still live").toBeUndefined();
		expect.soft(savedOwed(v, x1, early.id), "after the second run, the leave is still saved as owed").toHaveLength(0);
		await next.createFile("Desk/A.pdf");
		const third = await next.open("Desk/A.pdf");
		expect(next.pdfStore.strokes(third.id).map((x) => x.id), "a same-bytes PDF at a third path opened wearing ink").toEqual([]);
		vi.useRealTimers();
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
	});

	for (const order of ORDERS) {
		it(`G, a stroke on the found ink still queued at its move into the trash, every try of the live move failing, then a launch, the ink folder in ${order}: the queued page in the trash, the leave stays owed and saved; at the launch the leave runs: the found ink's file in the trash, one claim, every stroke once on the kept ink`, async () => {
			const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
			// Not flushed: the stroke is still queued on the found ink when its leave moves it into the trash.
			next.draw(secondAt, stroke(61, "pane2"));
			const fail = removeFailsOnce(next, x1, 4);
			next.close(second.root);
			next.plugin.releasePdfId(secondAt);
			await settledPastFailure(next);
			await settledPastFailure(next);
			expect(fail.left, "precondition: every try of the live move failed").toBe(0);
			expect(v.sidecar(x1)?.pdfPaths, "precondition: the found ink's file is live, claiming the copy").toEqual([OTHER]);
			expect(v.trashInk().map((t) => [...t].sort()), "precondition: the queued page went to the trash").toContainEqual(["ink-0", "pane2"]);
			expect.soft(savedOwed(v, x1, early.id), "after the failed move, the leave is not saved as owed").toHaveLength(1);
			expect.soft(next.plugin.pdfLeftForTrash(x1), "after the failed move, the found ink is taken as gone to the trash").toBe(false);
			await quit(next);
			const { s, opened } = await relaunchOpen(v, order);
			vi.useRealTimers();
			expect.soft(opened.id, "after the launch the copy did not open on the kept ink").toBe(early.id);
			await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "after the launch, not one ink file claims the copy on disk").toEqual([early.id]));
			await s.store.flush();
			expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "after the launch the kept ink's file does not hold every stroke once").toEqual(["own", "pane2"]);
			expect(v.sidecar(x1), "after the launch the found ink's file is still live").toBeUndefined();
		});
	}

	it("control: G, the found ink's move into the trash landing and another device's revision of its file syncing in at the live path just after: the leave ends as moved, and that revision stays live as it came", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		const live = `.handwriting/${x1}.json`;
		const remote = v.sidecar(x1)!;
		remote.strokes = [...remote.strokes, { ...remote.strokes[0]!, id: "remote" }];
		const remoteBytes = serializePage(remote);
		const rename = v.adapter.rename.bind(v.adapter);
		const state = { synced: false };
		v.adapter.rename = async (from: string, to: string) => {
			await rename(from, to);
			if (!state.synced && from === live && to.includes("/trash/")) {
				state.synced = true;
				v.adapter.externalWrite(live, remoteBytes);
			}
		};
		next.close(second.root);
		next.plugin.releasePdfId(secondAt);
		await movesSettled(next);
		await movesSettled(next);
		expect(state.synced, "precondition: the move landed and the revision synced in after it").toBe(true);
		expect(savedOwed(v, x1, early.id), "the leave is still saved as owed after its move landed").toHaveLength(0);
		expect(next.plugin.pdfLeftForTrash(x1), "the found ink is not taken as gone to the trash after its move landed").toBe(true);
		await next.store.flush();
		vi.useRealTimers();
		expect(v.adapter.files.get(live), "the other device's revision was moved or written by the leave").toBe(remoteBytes);
		expect(v.trashInk().map((t) => [...t].sort()), "the found ink is not in the trash whole").toContainEqual(["ink-0"]);
	});

	// The kept ink's file unreadable from the last close to the quit, as a file that cannot be read fails every read:
	// its claims read and its own read both fail, so the leave stays owed.
	it("G, the kept ink's file unreadable from the last close (its pane closed first) to the quit, then a launch: the leave stays owed and saved; at the launch the leave runs: the found ink in the trash whole, one claim", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.close(early.root);
		next.plugin.releasePdfId(early.id);
		await movesSettled(next);
		const read = v.adapter.read.bind(v.adapter);
		const state = { failed: false };
		v.adapter.read = async (path: string) => {
			if (path === `.handwriting/${early.id}.json`) {
				state.failed = true;
				throw new Error("the ink file could not be read");
			}
			return read(path);
		};
		vi.spyOn(console, "error").mockImplementation(() => {});
		next.close(second.root);
		next.plugin.releasePdfId(secondAt);
		await settledPastFailure(next);
		expect(state.failed, "precondition: the kept ink's file read failed").toBe(true);
		expect.soft(savedOwed(v, x1, early.id), "after the failed read, the leave is not saved as owed").toHaveLength(1);
		await quit(next);
		v.adapter.read = read;
		const { s } = await relaunchOpen(v, "name order");
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "after the launch, not one ink file claims the copy on disk").toEqual([early.id]));
		await s.store.flush();
		foundInTrashWhole(v, x1, ["ink-0"]);
	});

	it("G, the found ink's move into the trash failing once while a pane comes onto the found ink, a stroke drawn there and saved, then that pane closed: the found ink's file never claims nothing, the leave runs again in session and lands; after a launch one claim, every stroke once on the kept ink", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		// A pane comes onto the found ink at the copy while its move into the trash fails: the record is then shown.
		const pane = { root: { isConnected: true } as unknown as HTMLElement, added: false };
		const live = `.handwriting/${x1}.json`;
		const rename = v.adapter.rename.bind(v.adapter);
		v.adapter.rename = async (from: string, to: string) => {
			if (!pane.added && from === live && to.includes("/trash/")) {
				pane.added = true;
				next.plugin.pdfFiles.set(pane.root, OTHER);
				next.plugin.pdfInk.set(pane.root, { refresh() {}, refreshStrip() {}, forgetHistory() {}, unmount() {}, idle: true });
				next.plugin.pdfIds.set(pane.root, x1);
				throw new Error("the ink file could not be moved to the trash");
			}
			return rename(from, to);
		};
		vi.spyOn(console, "error").mockImplementation(() => {});
		// Every claim the found ink's file is written with, from here on.
		const written: (string[] | undefined)[] = [];
		const write = v.adapter.write.bind(v.adapter);
		v.adapter.write = async (path: string, data: string) => {
			await write(path, data);
			// A save writes its tmp file beside the live one, then renames it over: the tmp write is the claim written.
			if (path === live || path === `${live}.tmp`) written.push(parsePage(data, x1).data.pdfPaths);
		};
		next.close(second.root);
		next.plugin.releasePdfId(secondAt);
		await settledPastFailure(next);
		expect(pane.added, "precondition: the move failed with a pane come onto the found ink").toBe(true);
		next.draw(x1, stroke(62, "pane3"));
		await next.store.flush();
		expect.soft(v.sidecar(x1)?.pdfPaths, "a stroke drawn on the found ink after the failed move saved its file claiming nothing").toEqual([OTHER]);
		next.close(pane.root);
		next.plugin.releasePdfId(x1);
		await settledPastFailure(next);
		expect.soft(written.filter((p) => (p ?? []).length === 0), "the found ink's file was written claiming nothing").toEqual([]);
		expect.soft(claimersOnDisk(v, OTHER), "after the pane closed, not one ink file claims the copy on disk").toEqual([early.id]);
		await quit(next);
		const { s } = await relaunchOpen(v, "name order");
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "after the launch, not one ink file claims the copy on disk").toEqual([early.id]));
		await s.store.flush();
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "after the launch the kept ink's file does not hold every stroke once").toEqual(["own", "pane2", "pane3"]);
		expect(v.sidecar(x1), "after the launch the found ink's file is still live").toBeUndefined();
	});

	it("a carried stroke erased on the kept ink between two failed removes, across two quits: the stroke stays erased, one claim", async () => {
		const { v, next, early, second, secondAt, x1 } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		removeFailsOnce(next, x1);
		next.close(second.root);
		next.plugin.releasePdfId(secondAt);
		await settledPastFailure(next);
		expect(next.pdfStore.strokes(early.id).map((x) => x.id).sort(), "the carry did not land on the kept ink").toEqual(["own", "pane2"]);
		await quit(next);
		// The next launch: the leave runs again and its remove fails again; the carried stroke is erased in the kept pane.
		const mid = listInOrder(session(v, { pendingStore: true }), "name order");
		const midFail = removeFailsOnce(mid, x1);
		const kept = await mid.open(OTHER);
		await settleGrace(mid);
		await settledPastFailure(mid);
		expect(midFail.failed, "the leave was not owed at the launch: its remove did not run again").toBe(true);
		expect(kept.id, "after the launch the copy did not open on the kept ink").toBe(early.id);
		expect(mid.pdfStore.strokes(early.id).map((x) => x.id).sort(), "after the launch the kept ink does not hold the carried stroke").toEqual(["own", "pane2"]);
		mid.pdfStore.replaceAll(early.id, mid.pdfStore.strokes(early.id).filter((x) => x.id !== "pane2"));
		await mid.store.flush();
		await quit(mid);
		// A launch with the remove working: the leave runs once more.
		const { s } = await relaunchOpen(v, "name order");
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "after the last launch, not one ink file claims the copy on disk").toEqual([early.id]));
		await s.store.flush();
		expect(s.pdfStore.strokes(early.id).map((x) => x.id), "after the last launch the erased stroke came back").toEqual(["own"]);
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id), "after the last launch the erased stroke is back in the kept ink's file").toEqual(["own"]);
		expect(v.sidecar(x1), "after the last launch the found ink's file is still live").toBeUndefined();
	});

	it("F with a quit before the second pane closes: at the launch the leave runs on the new name", async () => {
		const { v, next, x1, x2, early, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		await next.renameFile(OTHER, NEW);
		await movesSettled(next);
		await quit(next);
		const { s, opened } = await relaunchOpen(v, "name order", NEW);
		vi.useRealTimers();
		expect(opened.id, "after the launch the new name did not open on the kept ink").toBe(early.id);
		await vi.waitFor(() => expect(s.pdfStore.strokes(early.id).map((x) => x.id).sort(), "after the launch the kept ink does not hold the second pane's stroke").toEqual(["own", "pane2"]));
		await vi.waitFor(() => expect(claimersOnDisk(v, NEW), "after the launch, not one ink file claims the new name on disk").toEqual([early.id]));
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
	});

	/** The device-local key the owed leaves are saved under. */
	const OWED_KEY = "handwriting-pdf-owed-leaves";

	it("the carry into the kept ink refused when the second pane closes (the kept ink read): nothing goes, the found ink stays live with its stroke and the copy; at the next launch the leave runs", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		const trashBefore = v.trashInk().length;
		// A fault put in: the store refuses the carry into the kept ink (as it does when that record cannot take it).
		const carry = next.pdfStore.carryInto.bind(next.pdfStore);
		const refused = { count: 0 };
		vi.spyOn(next.pdfStore, "carryInto").mockImplementation(((now: string, ...rest: unknown[]) => {
			if (now === early.id) {
				refused.count++;
				return false;
			}
			return (carry as (...a: unknown[]) => boolean)(now, ...rest);
		}) as typeof next.pdfStore.carryInto);
		await closeSecond(next, second, secondAt);
		await next.store.flush();
		expect(refused.count, "precondition: the carry into the kept ink was tried and refused").toBeGreaterThan(0);
		expect(v.sidecar(x1)?.strokes.map((x) => x.id), "the found ink left while the carry was refused").toEqual(["ink-0", "pane2"]);
		expect(claimersOnDisk(v, OTHER), "the found ink gave up the copy while the carry was refused").toContain(x1);
		expect(v.trashInk().length, "an ink file went to the trash while the carry was refused").toBe(trashBefore);
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id), "the kept ink's file changed while the carry was refused").toEqual(["own"]);
		vi.mocked(next.pdfStore.carryInto).mockRestore();
		await quit(next);
		const { s } = await relaunchOpen(v, "name order");
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "after the launch, the leave was not owed any more: not one ink file claims the copy").toEqual([early.id]));
		await s.store.flush();
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "after the launch the kept ink's file does not hold the second pane's stroke").toEqual(["own", "pane2"]);
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
	});

	it("the owed leave run to its end: the device-local key it was saved under is gone, not left as an empty list", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		const saved = v.local.get(OWED_KEY);
		expect(typeof saved, "precondition: the owed leave is saved under its key").toBe("string");
		expect((JSON.parse(saved as string) as unknown[]).length, "precondition: one leave is saved").toBe(1);
		await closeSecond(next, second, secondAt);
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "precondition: the leave ran: one ink file claims the copy").toEqual([early.id]));
		expect(v.local.has(OWED_KEY), "the owed leaves' key is still saved with nothing owed").toBe(false);
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
	});

	it("the kept ink's file gone from disk (its pane closed) when the second pane closes: the leave is forgotten, its key gone, the found ink keeps the copy, nothing to the trash", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.close(early.root);
		next.plugin.releasePdfId(early.id);
		await movesSettled(next);
		expect(next.pdfStore.generation(early.id), "precondition: the kept ink's record was let go with its pane").toBeNull();
		const keptPath = `.handwriting/${early.id}.json`;
		expect(v.adapter.files.has(keptPath), "precondition: the kept ink's file is written").toBe(true);
		// Gone as a sync from another device takes it: no file, so nothing keeps the copy but the found ink.
		v.adapter.files.delete(keptPath);
		const trashBefore = v.trashInk().length;
		await closeSecond(next, second, secondAt);
		await next.store.flush();
		expect(claimersOnDisk(v, OTHER), "the found ink gave up the copy with no kept ink left to keep it").toEqual([x1]);
		expect(v.sidecar(x1)?.strokes.map((x) => x.id), "the found ink's strokes changed").toEqual(["ink-0"]);
		expect(v.trashInk().length, "an ink file went to the trash with no kept ink left").toBe(trashBefore);
		expect(v.local.has(OWED_KEY), "a leave with no kept ink left is still owed").toBe(false);
	});

	it("the leave owed while a pane's read of the found ink is still out (the second pane closed and the copy opened again before the check), a stroke in that pane once it loaded, then that pane closed: the stroke on the kept ink, the found ink in the trash whole", async () => {
		const { v, next, x1, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		layoutReady();
		// The open meets the first pane only once the found ink is read (moveBlankPanes after its load), so the found ink
		// is read when that pane's check is set. Before the check runs, the second pane closes and its record is let go;
		// the copy opens again on the found ink, that read held, so the check owes the leave with the found ink not read.
		const first = await next.open(OTHER);
		expect(first.id, "precondition: the second pane opened on the found ink").toBe(x1);
		expect(next.plugin.pdfIds.get(early.root), "precondition: the first pane is still on its blank").toBe(early.id);
		next.draw(early.id, stroke(60, "own"));
		await next.store.flush();
		next.close(first.root);
		next.plugin.releasePdfId(x1);
		await turnsWhile(() => next.pdfStore.generation(x1) !== null, 0);
		expect(next.pdfStore.generation(x1), "precondition: the found ink's record was let go with its pane").toBeNull();
		expect(v.local.has(OWED_KEY), "precondition: nothing owed before the check").toBe(false);
		// Both ink files claim the copy on disk now. The reopen takes the first one listed that claims it
		// (PdfIdentity.ts:580-581): the found ink only when it is listed before the kept ink, as here; listed after it,
		// the reopen takes the kept ink and nothing is owed while the found ink is unread.
		expect(claimersOnDisk(v, OTHER).sort(), "precondition: both ink files claim the copy on disk").toEqual([early.id, x1].sort());
		listInOrder(next, "reverse name order");
		// The found ink's read held: the reopened pane has its id, its ink not read yet.
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
		const opening = next.open(OTHER);
		await turnsWhile(() => !held.x1, 0);
		expect(held.x1, "precondition: the reopened pane's read of the found ink is held").toBe(true);
		expect([...next.plugin.pdfIds.values()], "precondition: the reopened pane has the found ink's id").toContain(x1);
		await turnsWhile(() => !v.local.has(OWED_KEY), 100);
		expect(v.local.has(OWED_KEY), "precondition: the leave is owed").toBe(true);
		expect(next.pdfStore.inkReady(x1), "precondition: the leave was owed with the found ink not read").toBe(false);
		release();
		const second = await opening;
		expect(second.id, "precondition: the reopened pane opened on the found ink").toBe(x1);
		await next.checked();
		await settleGrace(next);
		await movesSettled(next);
		const secondAt = next.plugin.pdfIds.get(second.root) as string;
		expect(secondAt, "precondition: the second pane still shows the found ink").toBe(x1);
		expect(next.pdfStore.strokes(x1).map((x) => x.id), "precondition: the second pane shows the found ink").toEqual(["ink-0"]);
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		await closeSecond(next, second, secondAt);
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "after the close, not one ink file claims the copy on disk").toEqual([early.id]));
		await next.store.flush();
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the kept ink's file does not hold the stroke drawn after the leave was owed").toEqual(["own", "pane2"]);
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
	});

	it("a pane on the found ink that comes and goes while its leave runs: the leave runs again at the end of that run, in this session", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		// A pane comes onto the found ink while the run writes the kept ink (the run's own checks look for one there), and
		// closes after that leave returned and before the run ends: its let-go comes while the run is going.
		const pane = { root: { isConnected: true } as unknown as HTMLElement, added: false, closed: false };
		const flushPage = next.store.flushPage.bind(next.store);
		next.store.flushPage = (async (id: string, ...rest: unknown[]) => {
			if (id === early.id && !pane.added) {
				pane.added = true;
				next.plugin.pdfFiles.set(pane.root, OTHER);
				next.plugin.pdfInk.set(pane.root, { refresh() {}, refreshStrip() {}, forgetHistory() {}, unmount() {}, idle: true });
				next.plugin.pdfIds.set(pane.root, x1);
			}
			return (flushPage as (...a: unknown[]) => Promise<boolean>)(id, ...rest);
		}) as typeof next.store.flushPage;
		const leave = next.plugin.pairedInkLeaves as (id: string, path: string, from: string) => Promise<void>;
		next.plugin.pairedInkLeaves = async (id: string, path: string, from: string) => {
			await leave.call(next.plugin, id, path, from);
			if (pane.added && !pane.closed) {
				pane.closed = true;
				(pane.root as unknown as { isConnected: boolean }).isConnected = false;
				next.plugin.pdfInk.delete(pane.root);
				next.plugin.pdfIds.delete(pane.root);
				next.plugin.pdfFiles.delete(pane.root);
				next.plugin.releasePdfId(x1);
			}
		};
		await closeSecond(next, second, secondAt);
		await movesSettled(next);
		expect(pane.added && pane.closed, "precondition: the pane came onto the found ink and closed while its leave ran").toBe(true);
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "after that pane closed, the leave waited: two ink files claim the copy").toEqual([early.id]));
		await next.store.flush();
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the kept ink's file does not hold the second pane's stroke").toEqual(["own", "pane2"]);
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
	});

	/**
	 * The held-load road above, with the owe's own read of the found ink's file (the first read of that file once the
	 * leave is owed, while the pane's read is held) held as well (`late`), or failing (`fails`). The pane's read is then
	 * let go and the reopened pane shows the found ink. `releaseRead` lets the held read land.
	 */
	async function owedWithOwnReadOut(mode: "late" | "fails") {
		const { v, next, x1, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		layoutReady();
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
		let releaseLoad!: () => void;
		const loadGate = new Promise<void>((done) => (releaseLoad = done));
		const held = { load: false, read: false, loadLet: false };
		next.store.load = (async (id: string, ...rest: unknown[]) => {
			if (id === x1 && !held.load) {
				held.load = true;
				await loadGate;
			}
			return (load as (...a: unknown[]) => Promise<unknown>)(id, ...rest);
		}) as typeof next.store.load;
		const read = v.adapter.read.bind(v.adapter);
		let releaseRead!: () => void;
		const readGate = new Promise<void>((done) => (releaseRead = done));
		v.adapter.read = (async (p: string) => {
			// The pane's read is held before it reads, so the first read of this file once the leave is owed is the owe's.
			if (held.load && !held.loadLet && !held.read && v.local.has(OWED_KEY) && p.includes(x1)) {
				held.read = true;
				if (mode === "fails") throw new Error("the found ink's file could not be read");
				await readGate;
			}
			return read(p);
		}) as typeof v.adapter.read;
		const opening = next.open(OTHER);
		await turnsWhile(() => !held.load, 0);
		expect(held.load, "precondition: the reopened pane's read of the found ink is held").toBe(true);
		await turnsWhile(() => !v.local.has(OWED_KEY), 100);
		await turnsWhile(() => !held.read, 0);
		expect(v.local.has(OWED_KEY), "precondition: the leave is owed").toBe(true);
		expect(next.pdfStore.inkReady(x1), "precondition: the leave was owed with the found ink not read").toBe(false);
		expect(held.read, `precondition: the owe's own read of the found ink's file is ${mode === "late" ? "held" : "made, and fails"}`).toBe(true);
		held.loadLet = true;
		releaseLoad();
		const second = await opening;
		expect(second.id, "precondition: the reopened pane opened on the found ink").toBe(x1);
		await next.checked();
		await settleGrace(next);
		await movesSettled(next);
		const secondAt = next.plugin.pdfIds.get(second.root) as string;
		expect(secondAt, "precondition: the second pane still shows the found ink").toBe(x1);
		expect(next.pdfStore.strokes(x1).map((x) => x.id), "precondition: the second pane shows the found ink").toEqual(["ink-0"]);
		return { v, next, x1, early, second, secondAt, releaseRead };
	}

	it("the leave owed while the found ink is not read, its own read of that file landing only after a stroke in the reopened pane was saved, then that pane closed: the stroke on the kept ink, the found ink in the trash whole", async () => {
		const { v, next, x1, early, second, secondAt, releaseRead } = await owedWithOwnReadOut("late");
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "precondition: the found ink's file holds the stroke when the owe's read lands").toEqual(["ink-0", "pane2"]);
		releaseRead();
		for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
		await closeSecond(next, second, secondAt);
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "after the close, not one ink file claims the copy on disk").toEqual([early.id]));
		await next.store.flush();
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the stroke saved before the owe's read landed is not on the kept ink").toEqual(["own", "pane2"]);
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
	});

	it("the leave owed while the found ink is not read, its own read of that file failing, a stroke in the reopened pane, then that pane closed: the stroke on the kept ink, the found ink in the trash whole", async () => {
		const { v, next, x1, early, second, secondAt } = await owedWithOwnReadOut("fails");
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		await closeSecond(next, second, secondAt);
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "after the close, not one ink file claims the copy on disk").toEqual([early.id]));
		await next.store.flush();
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "with the owe's read failed, the stroke drawn after the owe is not on the kept ink").toEqual(["own", "pane2"]);
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
	});

	it("the leave owed while the found ink is not read, its own read of that file failing, a stroke in the reopened pane, the file then changed outside and read again (a sync), then that pane closed: both later strokes on the kept ink, the found ink in the trash whole", async () => {
		const { v, next, x1, early, second, secondAt } = await owedWithOwnReadOut("fails");
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		// Another device adds a stroke to the found ink's file; the poll's read of a changed file reads it again.
		const file = `.handwriting/${x1}.json`;
		const synced = parsePage(v.adapter.files.get(file) as string, x1).data;
		v.adapter.files.set(file, serializePage({ ...synced, strokes: [...synced.strokes, stroke(62, "dev")] }));
		expect(await next.pdfStore.reloadExternal(x1), "precondition: the found ink read again with the outside stroke").toBe(true);
		expect(next.pdfStore.strokes(x1).map((x) => x.id).sort(), "precondition: the found ink holds the outside stroke").toEqual(["dev", "ink-0", "pane2"]);
		await closeSecond(next, second, secondAt);
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "after the close, not one ink file claims the copy on disk").toEqual([early.id]));
		await next.store.flush();
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "a stroke on the found ink after the owe, read again from its file, is not on the kept ink").toEqual(["dev", "own", "pane2"]);
		foundInTrashWhole(v, x1, ["dev", "ink-0", "pane2"]);
	});

	it("the leave owed while the found ink is not read, its own read of that file still out when the reopened pane closes (the ink read by that pane by then): the leave runs at the close without waiting on that read, the stroke on the kept ink", async () => {
		const { v, next, x1, early, second, secondAt, releaseRead } = await owedWithOwnReadOut("late");
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		// Closed as closeSecond closes it, without its waits: they wait on every leave run (session `checked`), and a run
		// that waited on the read held here would never end. The plugin's own close does not wait on the run
		// (releasePdfId starts it detached).
		next.close(second.root);
		next.plugin.releasePdfId(secondAt);
		for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(500);
		const claimers = claimersOnDisk(v, OTHER);
		const kept = v.sidecar(early.id)?.strokes.map((x) => x.id).sort() ?? null;
		releaseRead();
		for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
		expect(claimers, "the leave waited on the owe's own read of the found ink's file, its ink read: two ink files claim the copy").toEqual([early.id]);
		expect(kept, "the kept ink's file does not hold the stroke drawn after the leave was owed").toEqual(["own", "pane2"]);
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
	});

	/** Where the open's listing puts the found ink: before the kept ink, or after it. */
	const FOUND_AT = ["the found ink listed first", "the kept ink listed first"] as const;
	/** When the open reads the found ink's claims against its leave run: before the run writes that ink, or after the run's end. */
	const READ_AT = ["its claims read before the run writes it", "its claims read after the run's end"] as const;

	/**
	 * An open of the copy that overlaps the end of the found ink's leave run. The open lists the ink files while the leave
	 * is owed, the found ink where `at` puts it. The run's first write of the found ink (remove, or flushPage when it keeps
	 * another claim) is held. `read`: the open reads the found ink's claims once the run is at that write, before it lands,
	 * or only once the run has ended. Either way the open chooses only after the run forgot the leave and ended (its read of
	 * the found ink is held until then). Real timers: the waits are vi.waitFor's. Returns the open (an open that threw, as
	 * the plugin's catcher meets it, opened on no ink) and what it read from the found ink's file.
	 */
	async function openOverlappingRunEnd(
		v: ReturnType<typeof vault>,
		s: ReturnType<typeof session>,
		x1: string,
		letGo: () => void,
		at: (typeof FOUND_AT)[number],
		read: (typeof READ_AT)[number],
		path: string = OTHER
	) {
		// The open lists its family's ink files (a scan of every ink file lists "pdf-"): from then on the reads are its own.
		const held = { listed: false, found: undefined as string[] | null | undefined, read: false, write: false };
		const list = s.store.listIds.bind(s.store);
		s.store.listIds = (async (prefix: string) => {
			const ids = [...(await list(prefix))].sort();
			if (prefix !== "pdf-") held.listed = true;
			const found = ids.filter((i) => i === x1);
			const others = ids.filter((i) => i !== x1);
			return at === "the found ink listed first" ? [...found, ...others] : [...others, ...found];
		}) as typeof s.store.listIds;
		let releaseRead!: () => void;
		const readGate = new Promise<void>((done) => (releaseRead = done));
		let atWrite!: () => void;
		const writeReached = new Promise<void>((done) => (atWrite = done));
		const readPaths = s.store.readPdfPaths.bind(s.store);
		s.store.readPdfPaths = (async (id: string) => {
			if (!held.listed || id !== x1 || held.read) return readPaths(id);
			held.read = true;
			if (read === "its claims read after the run's end") {
				await readGate;
				return (held.found = await readPaths(id));
			}
			await writeReached;
			const paths = await readPaths(id);
			held.found = paths;
			await readGate;
			return paths;
		}) as typeof s.store.readPdfPaths;
		let releaseWrite!: () => void;
		const writeGate = new Promise<void>((done) => (releaseWrite = done));
		for (const name of ["remove", "flushPage"] as const) {
			const write = (s.store[name] as (id: string) => Promise<unknown>).bind(s.store);
			(s.store as unknown as Record<string, (id: string) => Promise<unknown>>)[name] = async (id: string) => {
				if (id === x1 && !held.write) {
					held.write = true;
					atWrite();
					await writeGate;
				}
				return write(id);
			};
		}
		letGo();
		const opening = s.open(path).then(
			(o) => o,
			(e: unknown) => ({ root: null, id: `no ink (the open threw: ${String(e)})` })
		);
		await vi.waitFor(() => expect(held.read && held.write, "precondition: the open is at its read of the found ink's claims, the run's write of that ink held").toBe(true), { timeout: 5_000 });
		expect(v.local.has(OWED_KEY), "precondition: the leave is still owed when the open is at the found ink's claims").toBe(true);
		if (read === "its claims read before the run writes it") {
			await vi.waitFor(() => expect(held.found, "precondition: the open read the found ink's claim on the copy before its run wrote it").toContain(path), { timeout: 5_000 });
		}
		releaseWrite();
		await vi.waitFor(() => {
			expect(v.local.has(OWED_KEY), "precondition: the leave ran: nothing owed").toBe(false);
			expect(s.plugin.pdfLeaving(x1), "precondition: the found ink's leave run ended while the open was out").toBe(false);
		}, { timeout: 5_000 });
		releaseRead();
		return { opened: await opening, found: held.found };
	}

	/** The found ink's own other PDF, which it claims as well (a second claim, as a sync can bring one): the leave keeps it. */
	const ELSEWHERE = "Elsewhere/A.pdf";
	/** The found ink's file given the claim on ELSEWHERE, the copy's claim kept; returns the claims it should keep. */
	function foundClaimsElsewhere(v: ReturnType<typeof vault>, x1: string): string[] {
		v.files.add(ELSEWHERE);
		const file = `.handwriting/${x1}.json`;
		const page = parsePage(v.adapter.files.get(file) as string, x1).data;
		expect(page.pdfPaths, "precondition: the found ink's file claims the copy").toContain(OTHER);
		const paths = [...(page.pdfPaths ?? []), ELSEWHERE];
		v.adapter.files.set(file, serializePage({ ...page, pdfPaths: paths }));
		return paths.filter((p) => p !== OTHER);
	}

	/** The run's end at a launch, as `openOverlappingRunEnd` sets it; `claimsLeft`: the found ink keeps another claim. */
	async function launchOverlapping(at: (typeof FOUND_AT)[number], read: (typeof READ_AT)[number], claimsLeft = false) {
		const { v, next, x1, early } = await owedLeave({ settle: true });
		await quit(next);
		const keeps = claimsLeft ? foundClaimsElsewhere(v, x1) : undefined;
		vi.useRealTimers();
		const s = session(v, { pendingStore: true });
		const { opened, found } = await openOverlappingRunEnd(v, s, x1, () => {}, at, read);
		return { v, s, x1, early, opened, found, keeps };
	}

	/** The copy on the kept ink with its own stroke, and the only ink file on disk that claims it. */
	async function onKeptInk(v: ReturnType<typeof vault>, s: ReturnType<typeof session>, early: { id: string }, opened: { id: string }, read: (typeof READ_AT)[number], path: string = OTHER) {
		expect(
			opened.id,
			read === "its claims read before the run writes it"
				? "the copy opened on the deleted PDF's ink after its leave ran, its own ink hidden"
				: "the copy, listed with the found ink before the run moved that ink to the trash and read after the run's end, did not open on the kept ink"
		).toBe(early.id);
		await s.checked();
		await s.store.flush();
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id), "the copy opens without its own stroke").toEqual(["own"]);
		expect(claimersOnDisk(v, path), "after the open, not one ink file claims the copy on disk").toEqual([early.id]);
	}

	for (const at of FOUND_AT) {
		for (const read of READ_AT) {
			it(`an open of the copy at a launch, overlapping the end of the leave run the launch started (${at}, ${read}, the choice after the run's end): the copy on the kept ink, one claim, the found ink in the trash whole`, async () => {
				const { v, s, x1, early, opened, found } = await launchOverlapping(at, read);
				if (read === "its claims read after the run's end") expect(found, "precondition: the open read the found ink's file once the run had moved it to the trash").toBeNull();
				await onKeptInk(v, s, early, opened, read);
				foundInTrashWhole(v, x1, ["ink-0"]);
			});

			it(`the copy opened again at once after the second pane closed, overlapping the end of that leave run (${at}, ${read}, the choice after the run's end): the copy on the kept ink, one claim, the found ink in the trash whole`, async () => {
				const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
				vi.useRealTimers();
				const letGo = () => {
					next.close(second.root);
					next.plugin.releasePdfId(secondAt);
				};
				const { opened, found } = await openOverlappingRunEnd(v, next, x1, letGo, at, read);
				if (read === "its claims read after the run's end") expect(found, "precondition: the open read the found ink's file once the run had moved it to the trash").toBeNull();
				await onKeptInk(v, next, early, opened, read);
				foundInTrashWhole(v, x1, ["ink-0"]);
			});
		}

		it(`an open of the copy at a launch, overlapping the end of the leave run of found ink that keeps another claim (${at}, its claims read before the run writes it, the choice after the run's end): the copy on the kept ink, one claim, the found ink live with its other claim`, async () => {
			const { v, s, x1, early, opened, keeps } = await launchOverlapping(at, "its claims read before the run writes it", true);
			await onKeptInk(v, s, early, opened, "its claims read before the run writes it");
			expect(v.sidecar(x1)?.pdfPaths, "the found ink's file does not keep its other claim alone").toEqual(keeps);
			expect(v.sidecar(x1)?.strokes.map((x) => x.id), "the found ink's strokes changed").toEqual(["ink-0"]);
		});
	}

	/**
	 * The copy renamed inside the found ink's leave run. A stroke in the second pane while the leave is owed, the first
	 * pane closed, then the second (H): no pane shows the copy, so the rename's claim move runs for both inks
	 * (movePdfClaimOnRename), and is held here. `hold`: the run's first read of the found ink, before it owes (its
	 * claims still on the old name when it goes on), or its first read of the kept ink, for the carry after the owe.
	 * The rename is made while that read is held; the read is let go and the run goes on; then the claim move lands.
	 * The ink folder listed in `order`. Counts the most leaves ever saved owed, and the kept ink's strokes on disk when
	 * the found ink's file is moved to the trash.
	 */
	async function renamedInsideRun(hold: "found" | "kept", order: ListOrder) {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		next.close(early.root);
		next.plugin.releasePdfId(early.id);
		await movesSettled(next);
		listInOrder(next, order);
		const savedPaths = () => (JSON.parse((v.local.get(OWED_KEY) as string | undefined) ?? "[]") as { path: string }[]).map((e) => e.path);
		expect(savedPaths(), "precondition: one leave is saved owed, off the copy").toEqual([OTHER]);
		const seen = { entries: 1, keptAtRemove: undefined as string[] | undefined };
		const save = next.plugin.app.saveLocalStorage as (key: string, value: unknown) => void;
		next.plugin.app.saveLocalStorage = (key: string, value: unknown) => {
			if (key === OWED_KEY && typeof value === "string") seen.entries = Math.max(seen.entries, (JSON.parse(value) as unknown[]).length);
			save(key, value);
		};
		const remove = next.store.remove.bind(next.store);
		next.store.remove = (async (id: string, ...rest: unknown[]) => {
			if (id === x1 && seen.keptAtRemove === undefined) seen.keptAtRemove = (v.sidecar(early.id)?.strokes.map((x) => x.id) ?? []).sort();
			return (remove as (...a: unknown[]) => Promise<unknown>)(id, ...rest);
		}) as typeof next.store.remove;
		const target = hold === "found" ? x1 : early.id;
		const ensure = next.pdfStore.ensureLoaded.bind(next.pdfStore);
		let releaseLoad!: () => void;
		const loadGate = new Promise<void>((done) => (releaseLoad = done));
		const held = { load: false };
		next.pdfStore.ensureLoaded = (async (id: string) => {
			if (id === target && !held.load) {
				held.load = true;
				await loadGate;
			}
			return ensure(id);
		}) as typeof next.pdfStore.ensureLoaded;
		const moveClaim = next.plugin.movePdfClaimOnRename as (file: TFile, oldPath: string) => Promise<void>;
		let releaseMove!: () => void;
		const moveGate = new Promise<void>((done) => (releaseMove = done));
		const moves: Promise<void>[] = [];
		next.plugin.movePdfClaimOnRename = (file: TFile, oldPath: string) => {
			const move = (async () => {
				await moveGate;
				await moveClaim.call(next.plugin, file, oldPath);
			})();
			moves.push(move);
			return move;
		};
		next.close(second.root);
		next.plugin.releasePdfId(secondAt);
		await turnsWhile(() => !held.load, 0);
		expect(held.load, `precondition: the run's read of the ${hold} ink is held`).toBe(true);
		expect(next.plugin.pdfLeaving(x1), "precondition: the found ink's leave run is going").toBe(true);
		const renaming = next.renameFile(OTHER, NEW);
		await turnsWhile(() => !savedPaths().includes(NEW), 0);
		expect(savedPaths(), "precondition: the owed leave followed the rename at once").toEqual([NEW]);
		expect(moves.length, "precondition: the rename started the claim move for inks no pane shows").toBe(1);
		releaseLoad();
		await movesSettled(next);
		releaseMove();
		await renaming;
		await Promise.all(moves);
		await movesSettled(next);
		await movesSettled(next);
		vi.useRealTimers();
		return { v, next, x1, early, seen };
	}

	for (const order of ORDERS) {
		it(`the copy renamed while the found ink's leave run reads that ink, before it owes, the ink folder in ${order}: the leave owed once, the stroke on the kept ink before the found ink goes, the new name claimed by the kept ink only, the found ink in the trash whole, nothing owed`, async () => {
			const { v, next, x1, early, seen } = await renamedInsideRun("found", order);
			await vi.waitFor(() => expect(claimersOnDisk(v, NEW), "not one ink file claims the new name on disk").toEqual([early.id]));
			await next.store.flush();
			expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the stroke drawn on the found ink since the owe is not on the kept ink").toEqual(["own", "pane2"]);
			expect(seen.entries, "the leave was owed twice: once under each name").toBe(1);
			expect(seen.keptAtRemove, "the found ink went to the trash before the stroke drawn on it since the owe was in the kept ink's file").toEqual(["own", "pane2"]);
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
			expect(v.local.has(OWED_KEY), "a leave is still owed after the runs").toBe(false);
		});
	}

	it("pin: the copy renamed while the found ink's leave run reads the kept ink, after it owes: the stroke on the kept ink before the found ink goes, the new name claimed by the kept ink only, the found ink in the trash whole", async () => {
		const { v, next, x1, early, seen } = await renamedInsideRun("kept", "name order");
		await vi.waitFor(() => expect(claimersOnDisk(v, NEW), "not one ink file claims the new name on disk").toEqual([early.id]));
		await next.store.flush();
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the stroke drawn on the found ink since the owe is not on the kept ink").toEqual(["own", "pane2"]);
		expect(seen.keptAtRemove, "the found ink went to the trash before the stroke drawn on it since the owe was in the kept ink's file").toEqual(["own", "pane2"]);
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
	});

	/**
	 * The copy renamed while a pane holds its claim and a leave is owed: no claim move runs for the inks no pane shows
	 * (PluginOnload's rename handler moves only the panes' own ids). A stroke in the second pane while the leave is owed.
	 * `road`:
	 * - "owed, kept pane open": the leave's run, at the second pane's close, cannot write the kept ink (its flush fails
	 *   once), so it ends owed; the copy is renamed with the first pane still open; no run going.
	 * - "run going, kept pane open": owed as the first road, the found ink's record then forgotten (no pane shows it); the
	 *   found ink let go again, as a launch lets each owed ink go, and that run's read of the found ink's file held; the
	 *   copy is renamed with the first pane still open, then the read let go.
	 * - "owed, kept pane closed": the first pane closed and released, the copy renamed with the second pane still open,
	 *   then the second pane closed.
	 * - "owed, kept pane open, renamed twice in one read": owed as the first road, the found ink's record forgotten; the
	 *   copy renamed with the first pane still open, the claim move's read of the found ink's file held, the copy renamed
	 *   again, then the read let go.
	 * Every check and wait run out; the leave then has run, in this session, at the copy's last name (returned as `to`).
	 */
	async function renamedWhilePaneHolds(road: RenamedRoad) {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		const savedPaths = () => (JSON.parse((v.local.get(OWED_KEY) as string | undefined) ?? "[]") as { path: string }[]).map((e) => e.path);
		// The found ink's own read of its file (the store's load) held once, from now on; `fileReads` counts the reads of
		// that file landed (a claim move reads its claims from it).
		const holdFoundRead = () => {
			const load = next.store.load.bind(next.store);
			const gate = { held: false, fileReads: 0, release: (): void => {} };
			const loadGate = new Promise<void>((done) => (gate.release = done));
			next.store.load = (async (id: string, ...rest: unknown[]) => {
				if (id === x1 && !gate.held) {
					gate.held = true;
					await loadGate;
				}
				return (load as (...a: unknown[]) => Promise<unknown>)(id, ...rest);
			}) as typeof next.store.load;
			const read = v.adapter.read.bind(v.adapter);
			v.adapter.read = (async (p: string) => {
				const text = await read(p);
				if (p.includes(x1)) gate.fileReads++;
				return text;
			}) as typeof v.adapter.read;
			return gate;
		};
		// Fake-clock turns while `waiting` holds, a real 1 ms pause after each: the open's digest lands in real time, so a
		// count of fake turns alone ran out on a loaded run. Up to `most` turns; the caller checks what it needs after.
		const turnsWhileHeld = async (waiting: () => boolean, most = 1000) => {
			for (let i = 0; i < most && waiting(); i++) {
				await vi.advanceTimersByTimeAsync(0);
				if (waiting()) await new Promise<void>((done) => realSetTimeout(done, 1));
			}
		};
		let to: string = NEW;
		if (road !== "owed, kept pane closed") {
			const flushPage = next.store.flushPage.bind(next.store);
			const failed = { kept: false };
			next.store.flushPage = (async (id: string, ...rest: unknown[]) => {
				if (id === early.id && !failed.kept) {
					failed.kept = true;
					return false;
				}
				return (flushPage as (...a: unknown[]) => Promise<boolean>)(id, ...rest);
			}) as typeof next.store.flushPage;
			await closeSecond(next, second, secondAt);
			expect(failed.kept, "precondition: the leave's run tried to write the kept ink, and that write failed").toBe(true);
			expect(next.plugin.pdfLeaving(x1), "precondition: no leave run is going").toBe(false);
			expect(savedPaths(), "precondition: the leave is still owed, off the copy").toEqual([OTHER]);
			expect(claimersAmong(v, [x1], OTHER), "precondition: the found ink still claims the copy").toEqual([x1]);
			if (road === "owed, kept pane open") {
				await next.renameFile(OTHER, NEW);
			} else {
				expect(next.pdfStore.generation(x1), "precondition: the found ink's record is forgotten").toBeNull();
				const read = holdFoundRead();
				if (road === "run going, kept pane open") {
					next.plugin.releasePdfId(x1);
					await turnsWhileHeld(() => !read.held);
					expect(read.held, "precondition: the run's read of the found ink's file is held").toBe(true);
					expect(next.plugin.pdfLeaving(x1), "precondition: the found ink's leave run is going").toBe(true);
					const before = read.fileReads;
					await next.renameFile(OTHER, NEW);
					expect(savedPaths(), "precondition: the owed leave followed the rename at once").toEqual([NEW]);
					await turnsWhileHeld(() => read.fileReads === before);
					expect(read.fileReads, "precondition: the claim move read the found ink's claims from its file").toBeGreaterThan(before);
				} else {
					await next.renameFile(OTHER, NEW);
					await turnsWhileHeld(() => !read.held);
					expect(read.held, "precondition: the claim move's read of the found ink's file is held").toBe(true);
					expect(next.plugin.pdfLeaving(x1), "precondition: no leave run is going").toBe(false);
					const before = read.fileReads;
					await next.renameFile(NEW, NEWER);
					to = NEWER;
					expect(savedPaths(), "precondition: the owed leave followed both renames at once").toEqual([NEWER]);
					// A second move that reads the found ink's claims at once reads them here; one that waits its turn behind the
					// first reads nothing yet, and this runs out its few turns.
					await turnsWhileHeld(() => read.fileReads === before, 100);
				}
				read.release();
			}
		} else {
			next.close(early.root);
			next.plugin.releasePdfId(early.id);
			await movesSettled(next);
			expect(savedPaths(), "precondition: the leave is owed, off the copy").toEqual([OTHER]);
			await next.renameFile(OTHER, NEW);
			expect(savedPaths(), "precondition: the owed leave followed the rename at once").toEqual([NEW]);
			await movesSettled(next);
			await closeSecond(next, second, secondAt);
		}
		for (let i = 0; i < 3; i++) await movesSettled(next);
		vi.useRealTimers();
		return { v, next, x1, early, to };
	}

	for (const road of ROADS_RENAMED) {
		it(`bound 8: the copy renamed while a pane holds its claim, the leave ${road}: the leave runs on the new name, the stroke on the kept ink, the new name claimed by the kept ink only, the old name by none, the found ink in the trash whole, nothing owed`, async () => {
			const { v, next, x1, early, to } = await renamedWhilePaneHolds(road);
			await vi.waitFor(() => expect(claimersOnDisk(v, to), "not one ink file claims the new name on disk").toEqual([early.id]));
			expect(claimersOnDisk(v, OTHER), "an ink file still claims the old name on disk").toEqual([]);
			if (to !== NEW) expect(claimersOnDisk(v, NEW), "an ink file still claims the name between the renames on disk").toEqual([]);
			await next.store.flush();
			expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the stroke drawn on the found ink since the owe is not on the kept ink").toEqual(["own", "pane2"]);
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
			expect(v.local.has(OWED_KEY), "a leave is still owed after the rename").toBe(false);
			expect(await restartStrokes(v, "name order", to), "after a restart the new name does not open on the kept ink with both strokes").toEqual({ id: early.id, strokes: ["own", "pane2"] });
		});
	}

	/**
	 * The "run going" road above with no pane on the copy (K534-1): the leave owed as that road leaves it, then the first
	 * pane closed and released, so no pane holds the copy's claim. The found ink let go again, as a launch lets each owed
	 * ink go, and that run's read of the found ink's file held; the copy renamed then, so the rename's claim move for inks
	 * no pane shows (movePdfClaimOnRename) runs while that read is out: the found ink's claims are not read yet, its read
	 * answers at once, and the move passes it over. Then the read let go. Before the cure the run found the new name
	 * unclaimed by the found ink and forgot the leave: the stroke drawn on it since the owe stayed off the kept ink, and it
	 * stayed live claiming a name no file has.
	 */
	it("bound 8: the copy renamed with no pane on it while the found ink's leave run reads that ink's file: the leave runs on the new name, the stroke on the kept ink, the new name claimed by the kept ink only, the old name by none, the found ink in the trash whole, nothing owed", async () => {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		const savedPaths = () => (JSON.parse((v.local.get(OWED_KEY) as string | undefined) ?? "[]") as { path: string }[]).map((e) => e.path);
		const flushPage = next.store.flushPage.bind(next.store);
		const failed = { kept: false };
		next.store.flushPage = (async (id: string, ...rest: unknown[]) => {
			if (id === early.id && !failed.kept) {
				failed.kept = true;
				return false;
			}
			return (flushPage as (...a: unknown[]) => Promise<boolean>)(id, ...rest);
		}) as typeof next.store.flushPage;
		await closeSecond(next, second, secondAt);
		expect(failed.kept, "precondition: the leave's run tried to write the kept ink, and that write failed").toBe(true);
		expect(next.plugin.pdfLeaving(x1), "precondition: no leave run is going").toBe(false);
		expect(savedPaths(), "precondition: the leave is still owed, off the copy").toEqual([OTHER]);
		expect(claimersAmong(v, [x1], OTHER), "precondition: the found ink still claims the copy").toEqual([x1]);
		expect(next.pdfStore.generation(x1), "precondition: the found ink's record is forgotten").toBeNull();
		next.close(early.root);
		next.plugin.releasePdfId(early.id);
		await movesSettled(next);
		expect(next.pdfStore.generation(early.id), "precondition: the kept ink's record was let go with its pane").toBeNull();
		expect(savedPaths(), "precondition: the leave is still owed, off the copy, with the first pane closed").toEqual([OTHER]);
		expect(next.plugin.pdfPaneHoldsClaim(OTHER), "precondition: no pane holds the copy's claim").toBe(false);
		// The found ink's own read of its file (the store's load) held once; `fileReads` counts the reads of that file landed
		// (a claim move reads its claims from it).
		const load = next.store.load.bind(next.store);
		const gate = { held: false, fileReads: 0, release: (): void => {} };
		const loadGate = new Promise<void>((done) => (gate.release = done));
		next.store.load = (async (id: string, ...rest: unknown[]) => {
			if (id === x1 && !gate.held) {
				gate.held = true;
				await loadGate;
			}
			return (load as (...a: unknown[]) => Promise<unknown>)(id, ...rest);
		}) as typeof next.store.load;
		const read = v.adapter.read.bind(v.adapter);
		v.adapter.read = (async (p: string) => {
			const text = await read(p);
			if (p.includes(x1)) gate.fileReads++;
			return text;
		}) as typeof v.adapter.read;
		const moveClaim = next.plugin.movePdfClaimOnRename as (file: TFile, oldPath: string) => Promise<void>;
		const moves = { started: 0 };
		next.plugin.movePdfClaimOnRename = (file: TFile, oldPath: string) => {
			moves.started++;
			return moveClaim.call(next.plugin, file, oldPath);
		};
		// Fake-clock turns while `waiting` holds, a real 1 ms pause after each, up to `most` turns (as the road above).
		const turnsWhileHeld = async (waiting: () => boolean, most = 1000) => {
			for (let i = 0; i < most && waiting(); i++) {
				await vi.advanceTimersByTimeAsync(0);
				if (waiting()) await new Promise<void>((done) => realSetTimeout(done, 1));
			}
		};
		next.plugin.releasePdfId(x1);
		await turnsWhileHeld(() => !gate.held);
		expect(gate.held, "precondition: the run's read of the found ink's file is held").toBe(true);
		expect(next.plugin.pdfLeaving(x1), "precondition: the found ink's leave run is going").toBe(true);
		const before = gate.fileReads;
		await next.renameFile(OTHER, NEW);
		expect(savedPaths(), "precondition: the owed leave followed the rename at once").toEqual([NEW]);
		await turnsWhileHeld(() => gate.fileReads === before);
		expect(moves.started, "precondition: the rename started the claim move for inks no pane shows").toBe(1);
		expect(gate.fileReads, "precondition: the claim move read the found ink's claims from its file while its read was held").toBeGreaterThan(before);
		gate.release();
		for (let i = 0; i < 3; i++) await movesSettled(next);
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, NEW), "not one ink file claims the new name on disk").toEqual([early.id]));
		expect(claimersOnDisk(v, OTHER), "an ink file still claims the old name on disk").toEqual([]);
		await next.store.flush();
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the stroke drawn on the found ink since the owe is not on the kept ink").toEqual(["own", "pane2"]);
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		expect(v.local.has(OWED_KEY), "a leave is still owed after the rename").toBe(false);
		expect(await restartStrokes(v, "name order", NEW), "after a restart the new name does not open on the kept ink with both strokes").toEqual({ id: early.id, strokes: ["own", "pane2"] });
	});

	/**
	 * Bound 8: the copy renamed while a leave is owed and the kept ink's file cannot be read (a sync tool writing it), its
	 * pane closed and its record let go: the claim move reads no claims for the kept ink. A stroke in the second pane
	 * while the leave is owed; the first pane closed and released. `road`:
	 * - "no pane on the copy": the kept ink's file unreadable, then the second pane closed (I's road: the leave stays
	 *   owed, no pane open); the copy renamed with the file still unreadable; the file whole again, a quit and a launch
	 *   opening the new name, the ink folder in `order`; that pane kept open, or closed (`launchPane`); or kept open with
	 *   the launch's leave run held at its read of the kept ink's file until the open chose ("open before the run").
	 * - "a pane on the found ink": the kept ink's file unreadable, the copy renamed with the second pane open; the file
	 *   whole again, then the second pane closed, in this session.
	 */
	async function renamedKeptUnreadable(
		road: "no pane on the copy" | "a pane on the found ink",
		order: ListOrder,
		launchPane: "open" | "open before the run" | "closed" | null
	) {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		next.close(early.root);
		next.plugin.releasePdfId(early.id);
		await movesSettled(next);
		expect(next.pdfStore.generation(early.id), "precondition: the kept ink's record was let go with its pane").toBeNull();
		const savedPaths = () => (JSON.parse((v.local.get(OWED_KEY) as string | undefined) ?? "[]") as { path: string }[]).map((e) => e.path);
		const keptPath = `.handwriting/${early.id}.json`;
		const keptBytes = v.adapter.files.get(keptPath);
		expect(keptBytes, "precondition: the kept ink's file is written").toBeDefined();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		// Each read of the kept ink's claims that answered none while its file could not be read.
		const unreadable = { reads: 0 };
		const readPdfPaths = next.store.readPdfPaths.bind(next.store);
		next.store.readPdfPaths = (async (id: string) => {
			const paths = await readPdfPaths(id);
			if (id === early.id && paths === null && v.adapter.files.get(keptPath) !== keptBytes) unreadable.reads++;
			return paths;
		}) as typeof next.store.readPdfPaths;
		v.adapter.files.set(keptPath, "{ not a page");
		if (road === "no pane on the copy") {
			await closeSecond(next, second, secondAt);
			expect(savedPaths(), "precondition: the leave is still owed, off the copy").toEqual([OTHER]);
			expect(claimersOnDisk(v, OTHER), "precondition: the found ink still claims the copy").toContain(x1);
			expect(next.plugin.pdfPaneHoldsClaim(OTHER), "precondition: no pane holds the copy's claim").toBe(false);
			const before = unreadable.reads;
			await next.renameFile(OTHER, NEW);
			await movesSettled(next);
			expect(unreadable.reads, "precondition: the rename read the kept ink's claims while its file could not be read").toBeGreaterThan(before);
			expect(savedPaths(), "precondition: the owed leave followed the rename").toEqual([NEW]);
			v.adapter.files.set(keptPath, keptBytes as string);
			await quit(next);
			if (launchPane === "open before the run") {
				// The launch's leave run reads the kept ink's file first (the leaves are restored before any open); that
				// read is held until the open of the new name has chosen.
				const adapter = v.adapter as unknown as { read: (p: string) => Promise<string> };
				const read = adapter.read.bind(adapter);
				let letRead!: () => void;
				const gate = new Promise<void>((done) => (letRead = done));
				const held = { read: false };
				adapter.read = async (p: string) => {
					if (p === keptPath && !held.read) {
						held.read = true;
						await gate;
					}
					return read(p);
				};
				const s = listInOrder(session(v, { pendingStore: true }), order);
				const opening = s.open(NEW);
				await turnsWhile(() => !(held.read && s.plugin.pdfIds.size > 0), 0);
				expect(held.read, "precondition: the launch's read of the kept ink's file is held").toBe(true);
				expect(s.plugin.pdfIds.size, "precondition: the open chose before that read landed").toBe(1);
				letRead();
				const opened = await opening;
				adapter.read = read;
				await settleGrace(s);
				for (let i = 0; i < 3; i++) await movesSettled(s);
				vi.useRealTimers();
				return { v, s, x1, early, opened };
			}
			const { s, opened } = await relaunchOpen(v, order, NEW);
			if (launchPane === "closed") {
				s.close(opened.root);
				s.plugin.releasePdfId(opened.id);
			}
			for (let i = 0; i < 3; i++) await movesSettled(s);
			vi.useRealTimers();
			return { v, s, x1, early, opened };
		}
		await next.renameFile(OTHER, NEW);
		expect(next.plugin.pdfPaneHoldsClaim(NEW), "precondition: the second pane holds the new name's claim").toBe(true);
		await movesSettled(next);
		expect(unreadable.reads, "precondition: the rename read the kept ink's claims while its file could not be read").toBeGreaterThan(0);
		expect(savedPaths(), "precondition: the owed leave followed the rename").toEqual([NEW]);
		v.adapter.files.set(keptPath, keptBytes as string);
		await closeSecond(next, second, secondAt);
		for (let i = 0; i < 3; i++) await movesSettled(next);
		vi.useRealTimers();
		return { v, s: next, x1, early, opened: undefined };
	}

	for (const [road, order, launchPane] of [
		["no pane on the copy", "name order", "open"],
		["no pane on the copy", "reverse name order", "open"],
		["no pane on the copy", "name order", "closed"],
		["no pane on the copy", "reverse name order", "closed"],
		["no pane on the copy", "name order", "open before the run"],
		["no pane on the copy", "reverse name order", "open before the run"],
		["a pane on the found ink", "name order", null],
	] as const) {
		const pane = { open: "kept open", "open before the run": "kept open, chosen before the leave run read the kept ink", closed: "then closed" };
		const at = launchPane === null ? "" : `, the ink folder in ${order} at the launch, the pane opened there ${pane[launchPane]}`;
		const shown = launchPane === "open" || launchPane === "open before the run";
		it(`bound 8: the copy renamed while a leave is owed and the kept ink's file cannot be read, ${road}${at}: ${shown ? "that pane on the kept ink with both panes' strokes, " : ""}the leave runs on the new name, the stroke on the kept ink, the new name claimed by the kept ink only, the old name by none, the found ink in the trash whole, nothing owed`, async () => {
			const { v, s, x1, early, opened } = await renamedKeptUnreadable(road, order, launchPane);
			if (shown) {
				expect(s.plugin.pdfIds.get(opened!.root), "the pane opened at the launch is not on the kept ink").toBe(early.id);
				expect(s.pdfStore.strokes(early.id).map((x) => x.id).sort(), "the pane opened at the launch does not show both panes' strokes").toEqual(["own", "pane2"]);
			}
			await vi.waitFor(() => expect(claimersOnDisk(v, NEW), "not one ink file claims the new name on disk").toEqual([early.id]));
			expect(claimersOnDisk(v, OTHER), "an ink file still claims the old name on disk").toEqual([]);
			await s.store.flush();
			expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the stroke drawn on the found ink since the owe is not on the kept ink").toEqual(["own", "pane2"]);
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
			expect(v.local.has(OWED_KEY), "a leave is still owed after the rename").toBe(false);
			expect(await restartStrokes(v, "name order", NEW), "after a restart the new name does not open on the kept ink with both strokes").toEqual({ id: early.id, strokes: ["own", "pane2"] });
		});
	}

	/**
	 * Bound 8: the copy renamed while a leave is owed and the found ink's file cannot be read (a sync tool writing it), its
	 * record let go: the claim move reads no claims for the found ink and passes it over, and it still claims the old name.
	 * A stroke in the second pane while the leave is owed; the second pane closed, the leave's run failing once at its
	 * write of the kept ink (the leave stays owed, the found ink's record let go). `road`:
	 * - "kept pane open": the found ink's file unreadable, the copy renamed with the first pane open; the claim move lets
	 *   the found ink go with its file still unreadable, and its leave stays owed; the file whole again, the found ink let
	 *   go again, in this session.
	 * - "no pane on the copy": the first pane closed and released; the found ink's file unreadable, the copy renamed; the
	 *   file whole again, a quit, a launch opening the new name, that pane then closed.
	 */
	async function renamedFoundUnreadable(road: "kept pane open" | "no pane on the copy") {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		const savedPaths = () => (JSON.parse((v.local.get(OWED_KEY) as string | undefined) ?? "[]") as { path: string }[]).map((e) => e.path);
		const flushPage = next.store.flushPage.bind(next.store);
		const failed = { kept: false };
		next.store.flushPage = (async (id: string, ...rest: unknown[]) => {
			if (id === early.id && !failed.kept) {
				failed.kept = true;
				return false;
			}
			return (flushPage as (...a: unknown[]) => Promise<boolean>)(id, ...rest);
		}) as typeof next.store.flushPage;
		await closeSecond(next, second, secondAt);
		expect(failed.kept, "precondition: the leave's run tried to write the kept ink, and that write failed").toBe(true);
		expect(next.plugin.pdfLeaving(x1), "precondition: no leave run is going").toBe(false);
		expect(savedPaths(), "precondition: the leave is still owed, off the copy").toEqual([OTHER]);
		expect(claimersAmong(v, [x1], OTHER), "precondition: the found ink still claims the copy").toEqual([x1]);
		expect(next.pdfStore.generation(x1), "precondition: the found ink's record is forgotten").toBeNull();
		const foundPath = `.handwriting/${x1}.json`;
		const foundBytes = v.adapter.files.get(foundPath);
		expect(foundBytes, "precondition: the found ink's file is written").toBeDefined();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		// Each read of the found ink's claims that answered none while its file could not be read, and each run of its leave.
		const unreadable = { reads: 0, runs: 0 };
		const readPdfPaths = next.store.readPdfPaths.bind(next.store);
		next.store.readPdfPaths = (async (id: string) => {
			const paths = await readPdfPaths(id);
			if (id === x1 && paths === null && v.adapter.files.get(foundPath) !== foundBytes) unreadable.reads++;
			return paths;
		}) as typeof next.store.readPdfPaths;
		const leave = next.plugin.pairedInkLeaves as (id: string, path: string, from: string) => Promise<void>;
		next.plugin.pairedInkLeaves = (id: string, path: string, from: string) => {
			if (id === x1) unreadable.runs++;
			return leave.call(next.plugin, id, path, from);
		};
		if (road === "kept pane open") {
			v.adapter.files.set(foundPath, "{ not a page");
			expect(next.plugin.pdfPaneHoldsClaim(OTHER), "precondition: the first pane holds the copy's claim").toBe(true);
			const before = { ...unreadable };
			await next.renameFile(OTHER, NEW);
			expect(savedPaths(), "precondition: the owed leave followed the rename at once").toEqual([NEW]);
			for (let i = 0; i < 3; i++) await movesSettled(next);
			expect(unreadable.reads, "precondition: the claim move read the found ink's claims while its file could not be read").toBeGreaterThan(before.reads);
			expect(unreadable.runs, "precondition: the found ink was let go, and its leave ran, while its file could not be read").toBeGreaterThan(before.runs);
			// Still unreadable when the run reads it: the leave stays owed, and the found ink's file is left as it is.
			expect(savedPaths(), "a leave run that could not read the found ink forgot the leave").toEqual([NEW]);
			expect(v.adapter.files.get(foundPath), "a leave run that could not read the found ink moved or wrote its file").toBe("{ not a page");
			v.adapter.files.set(foundPath, foundBytes as string);
			next.plugin.releasePdfId(x1);
			for (let i = 0; i < 3; i++) await movesSettled(next);
			vi.useRealTimers();
			return { v, s: next, x1, early };
		}
		next.close(early.root);
		next.plugin.releasePdfId(early.id);
		await movesSettled(next);
		expect(next.pdfStore.generation(early.id), "precondition: the kept ink's record was let go with its pane").toBeNull();
		v.adapter.files.set(foundPath, "{ not a page");
		expect(next.plugin.pdfPaneHoldsClaim(OTHER), "precondition: no pane holds the copy's claim").toBe(false);
		const before = { ...unreadable };
		await next.renameFile(OTHER, NEW);
		await movesSettled(next);
		expect(unreadable.reads, "precondition: the rename read the found ink's claims while its file could not be read").toBeGreaterThan(before.reads);
		expect(savedPaths(), "precondition: the owed leave followed the rename").toEqual([NEW]);
		v.adapter.files.set(foundPath, foundBytes as string);
		await quit(next);
		const { s, opened } = await relaunchOpen(v, "name order", NEW);
		s.close(opened.root);
		s.plugin.releasePdfId(opened.id);
		for (let i = 0; i < 3; i++) await movesSettled(s);
		vi.useRealTimers();
		return { v, s, x1, early };
	}

	for (const road of ["kept pane open", "no pane on the copy"] as const) {
		it(`bound 8: the copy renamed while a leave is owed and the found ink's file cannot be read, ${road}: the leave runs on the new name, the stroke on the kept ink, the new name claimed by the kept ink only, the old name by none, the found ink in the trash whole, nothing owed`, async () => {
			const { v, s, x1, early } = await renamedFoundUnreadable(road);
			await vi.waitFor(() => expect(claimersOnDisk(v, NEW), "not one ink file claims the new name on disk").toEqual([early.id]));
			expect(claimersOnDisk(v, OTHER), "an ink file still claims the old name on disk").toEqual([]);
			await s.store.flush();
			expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the stroke drawn on the found ink since the owe is not on the kept ink").toEqual(["own", "pane2"]);
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
			expect(v.local.has(OWED_KEY), "a leave is still owed after the rename").toBe(false);
			expect(await restartStrokes(v, "name order", NEW), "after a restart the new name does not open on the kept ink with both strokes").toEqual({ id: early.id, strokes: ["own", "pane2"] });
		});
	}

	/**
	 * Bound 8: the copy renamed while a leave is owed and the kept ink's file cannot be read, with the second pane open on
	 * the found ink: the claim move passes the kept ink over, and it still claims the old name. The file whole again, then a
	 * file comes to the old name (the same bytes, put back) before the leave's run. `road`:
	 * - "a file at the old name": it stays there.
	 * - "a file at the old name deleted in its grace": it goes again (a sync tool's move), and its deletion waits.
	 * Then the second pane closed, in this session; returned: whether a deletion still waited at the old name once the
	 * leave's run ended.
	 */
	async function renamedKeptUnreadableOldNameTaken(road: "a file at the old name" | "a file at the old name deleted in its grace") {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		next.close(early.root);
		next.plugin.releasePdfId(early.id);
		await movesSettled(next);
		expect(next.pdfStore.generation(early.id), "precondition: the kept ink's record was let go with its pane").toBeNull();
		const savedPaths = () => (JSON.parse((v.local.get(OWED_KEY) as string | undefined) ?? "[]") as { path: string }[]).map((e) => e.path);
		const keptPath = `.handwriting/${early.id}.json`;
		const keptBytes = v.adapter.files.get(keptPath);
		expect(keptBytes, "precondition: the kept ink's file is written").toBeDefined();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		v.adapter.files.set(keptPath, "{ not a page");
		await next.renameFile(OTHER, NEW);
		expect(next.plugin.pdfPaneHoldsClaim(NEW), "precondition: the second pane holds the new name's claim").toBe(true);
		await movesSettled(next);
		expect(savedPaths(), "precondition: the owed leave followed the rename").toEqual([NEW]);
		v.adapter.files.set(keptPath, keptBytes as string);
		expect(claimersAmong(v, [early.id], OTHER), "precondition: the rename passed the kept ink over, and it still claims the old name").toEqual([early.id]);
		await next.createFile(OTHER);
		expect(claimersAmong(v, [early.id], OTHER), "precondition: the kept ink still claims the old name with a file there").toEqual([early.id]);
		if (road === "a file at the old name deleted in its grace") {
			await next.deleteFile(OTHER);
			expect(next.pdfStore.pendingClaims().has(OTHER), "precondition: the old name's deletion waits in its grace").toBe(true);
		}
		expect(savedPaths(), "precondition: the leave is still owed before its run").toEqual([NEW]);
		await closeSecond(next, second, secondAt);
		const waiting = next.pdfStore.pendingClaims().has(OTHER);
		for (let i = 0; i < 3; i++) await movesSettled(next);
		vi.useRealTimers();
		return { v, s: next, x1, early, waiting };
	}

	for (const road of ["a file at the old name", "a file at the old name deleted in its grace"] as const) {
		it(`bound 8: the copy renamed while a leave is owed and the kept ink's file cannot be read, ${road} before the leave's run: the leave runs on the new name, the stroke on the kept ink, the new name claimed by the kept ink only, the old name by none, the found ink in the trash whole, nothing owed${road === "a file at the old name" ? ", the file at the old name not on the kept ink" : ", the deletion there still waiting after the run"}`, async () => {
			const { v, s, x1, early, waiting } = await renamedKeptUnreadableOldNameTaken(road);
			if (road === "a file at the old name deleted in its grace") expect(waiting, "the leave's run ended the deletion waiting at the old name").toBe(true);
			await vi.waitFor(() => expect(claimersOnDisk(v, NEW), "not one ink file claims the new name on disk").toEqual([early.id]));
			expect(claimersOnDisk(v, OTHER), "an ink file still claims the old name on disk").toEqual([]);
			await s.store.flush();
			expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the stroke drawn on the found ink since the owe is not on the kept ink").toEqual(["own", "pane2"]);
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
			expect(v.local.has(OWED_KEY), "a leave is still owed after the rename").toBe(false);
			expect(await restartStrokes(v, "name order", NEW), "after a restart the new name does not open on the kept ink with both strokes").toEqual({ id: early.id, strokes: ["own", "pane2"] });
			if (road === "a file at the old name") expect((await restartStrokes(v, "name order", OTHER)).id, "the file at the old name opens on the kept ink").not.toBe(early.id);
		});
	}

	/**
	 * The roads back to the old name, the kept ink's file unreadable at the rename (bound 8): the copy renamed while
	 * a leave is owed, with the second pane open on the found ink; the claim move passes the kept ink over, and it still
	 * claims the old name. The file whole again, then the copy goes back to the old name before the leave's run. `road`:
	 * - "renamed back": the copy renamed from the new name to the old one.
	 * - "moved back as a delete and a create": a sync tool moves it back as a delete at the new name and a create at the
	 *   old one, not a rename; the new name's deletion waits in its grace.
	 * - "deleted for real": the copy deleted at the new name, and no file of its bytes comes anywhere since.
	 * Then the second pane closed, in this session: its let-go runs the leave. On the delete roads every read is made inside
	 * the new name's grace, before that deletion's retirement (returned: whether it still waited once the run ended), unless
	 * `past` runs that grace out first (pastGrace).
	 */
	async function renamedKeptUnreadableBack(road: "renamed back" | "moved back as a delete and a create" | "deleted for real", past?: Past) {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		next.close(early.root);
		next.plugin.releasePdfId(early.id);
		await movesSettled(next);
		expect(next.pdfStore.generation(early.id), "precondition: the kept ink's record was let go with its pane").toBeNull();
		const savedPaths = () => (JSON.parse((v.local.get(OWED_KEY) as string | undefined) ?? "[]") as { path: string }[]).map((e) => e.path);
		const keptPath = `.handwriting/${early.id}.json`;
		const keptBytes = v.adapter.files.get(keptPath);
		expect(keptBytes, "precondition: the kept ink's file is written").toBeDefined();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		v.adapter.files.set(keptPath, "{ not a page");
		await next.renameFile(OTHER, NEW);
		expect(next.plugin.pdfPaneHoldsClaim(NEW), "precondition: the second pane holds the new name's claim").toBe(true);
		await movesSettled(next);
		expect(savedPaths(), "precondition: the owed leave followed the rename").toEqual([NEW]);
		v.adapter.files.set(keptPath, keptBytes as string);
		expect(claimersAmong(v, [early.id], OTHER), "precondition: the rename passed the kept ink over, and it still claims the old name").toEqual([early.id]);
		expect(claimersAmong(v, [x1], NEW), "precondition: the found ink claims the new name").toEqual([x1]);
		if (road === "renamed back") {
			await next.renameFile(NEW, OTHER);
			expect(savedPaths(), "precondition: the owed leave followed the rename back").toEqual([OTHER]);
			await closeSecond(next, second, secondAt);
			for (let i = 0; i < 3; i++) await movesSettled(next);
			vi.useRealTimers();
			return { v, s: next, x1, early, savedPaths, waiting: false };
		}
		await next.deleteFile(NEW);
		if (road !== "deleted for real") await next.createFile(OTHER);
		expect(next.pdfStore.pendingClaims().has(NEW), "precondition: the new name's deletion waits in its grace").toBe(true);
		expect(savedPaths(), "precondition: the leave is still owed off the new name before its run").toEqual([NEW]);
		const runs = { n: 0 };
		const leave = next.plugin.pairedInkLeaves as (id: string, path: string, from: string) => Promise<void>;
		next.plugin.pairedInkLeaves = (id: string, path: string, from: string) => {
			if (id === x1) runs.n++;
			return leave.call(next.plugin, id, path, from);
		};
		await closeSecond(next, second, secondAt);
		expect(runs.n, "precondition: the second pane's let-go ran the found ink's leave").toBeGreaterThan(0);
		const waiting = next.pdfStore.pendingClaims().has(NEW);
		await next.store.flush();
		if (past) await pastGrace(next, early.id, past);
		vi.useRealTimers();
		return { v, s: next, x1, early, savedPaths, waiting };
	}

	/**
	 * Past the new name's grace, on a delete road: `refuseKept` refuses every write of the kept ink's page from here on
	 * (the store's own answer, false). `order` lists the ink folder in that order from here on (listInOrder), so the
	 * retirement reads the claims in it. Then the grace run out, the new name's retirement waited for in real time
	 * (turnsWhile: its read of the PDF at the old name lands off the fake clock), and each retirement and what it starts
	 * settled.
	 */
	type Past = { refuseKept?: boolean; order?: ListOrder };
	async function pastGrace(next: ReturnType<typeof session>, kept: string, past: Past) {
		if (past.order) listInOrder(next, past.order);
		if (past.refuseKept) {
			const flushPage = next.store.flushPage.bind(next.store);
			next.store.flushPage = (async (id: string, ...rest: unknown[]) =>
				id === kept ? false : (flushPage as (...a: unknown[]) => Promise<boolean>)(id, ...rest)) as typeof next.store.flushPage;
		}
		await vi.advanceTimersByTimeAsync(10_001);
		await turnsWhile(() => next.pdfStore.pendingClaims().has(NEW));
		for (let i = 0; i < 3; i++) await movesSettled(next);
		await next.store.flush();
		expect(next.pdfStore.pendingClaims().has(NEW), "precondition: the new name's deletion retired").toBe(false);
	}

	for (const road of ["renamed back", "moved back as a delete and a create"] as const) {
		const end =
			road === "renamed back"
				? "the run moves nothing: the leave runs on the old name, the stroke on the kept ink, the old name claimed by the kept ink only, the new name by none, the found ink in the trash whole, nothing owed"
				: "inside the new name's grace the run leaves the leave owed and saved, the kept ink claiming the old name only, the found ink live with its strokes and not in the trash; after a restart the old name opens on the kept ink";
		it(`bound 8, the copy back at the old name: the copy renamed while a leave is owed and the kept ink's file cannot be read, then ${road} before the leave's run: ${end}`, async () => {
			const { v, s, x1, early, savedPaths, waiting } = await renamedKeptUnreadableBack(road);
			if (road === "renamed back") {
				await vi.waitFor(() => expect(claimersOnDisk(v, OTHER), "not one ink file claims the old name on disk").toEqual([early.id]));
				expect(claimersOnDisk(v, NEW), "an ink file still claims the new name on disk").toEqual([]);
				await s.store.flush();
				expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the stroke drawn on the found ink since the owe is not on the kept ink").toEqual(["own", "pane2"]);
				foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
				expect(v.local.has(OWED_KEY), "a leave is still owed after the rename back").toBe(false);
				expect(await restartStrokes(v, "name order", OTHER), "after a restart the old name does not open on the kept ink with both strokes").toEqual({ id: early.id, strokes: ["own", "pane2"] });
				return;
			}
			expect(waiting, "precondition: the reads are made inside the new name's deletion grace").toBe(true);
			expect(savedPaths(), "the leave's run did not leave the leave owed and saved").toEqual([NEW]);
			expect(v.sidecar(early.id)?.pdfPaths, "the kept ink does not claim the old name only").toEqual([OTHER]);
			expect(claimersOnDisk(v, OTHER), "not one ink file claims the old name on disk").toEqual([early.id]);
			expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "the found ink's file is not live with its strokes").toEqual(["ink-0", "pane2"]);
			expect(v.trashInk().map((t) => [...t].sort()), "the found ink went to the trash").not.toContainEqual(["ink-0", "pane2"]);
			expect(await restartStrokes(v, "name order", OTHER), "after a restart the copy at the old name does not open on the kept ink").toEqual({ id: early.id, strokes: ["own"] });
		});
	}

	/**
	 * The roads back to the old name on the found ink, its file unreadable at the rename (bound 8): a stroke in the
	 * second pane while the leave is owed; the second pane closed, the leave's run failing once at its write of the kept
	 * ink (the leave stays owed, the found ink's record let go); the found ink's file unreadable, the copy renamed with the
	 * first pane open, so the claim move passes the found ink over and it still claims the old name. The file whole again,
	 * then before the leave's run, `road`:
	 * - "moved back as a delete and a create": a sync tool moves the copy back as a delete at the new name (its pane closes
	 *   with it) and a create at the old one; the new name's deletion waits in its grace.
	 * - "a file at the old name deleted in its grace": a file comes to the old name and goes again (a sync tool's move),
	 *   and its deletion waits.
	 * - "deleted for real": the copy deleted at the new name (its pane closes with it), and no file of its bytes comes
	 *   anywhere since.
	 * Then the found ink let go, in this session: the leave runs. Returned: whether the road's deletion still waited once
	 * that run ended, inside its grace, unless `past` runs the new name's grace out first (pastGrace).
	 */
	async function renamedFoundUnreadableBack(
		road: "moved back as a delete and a create" | "a file at the old name deleted in its grace" | "deleted for real",
		past?: Past
	) {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		const savedPaths = () => (JSON.parse((v.local.get(OWED_KEY) as string | undefined) ?? "[]") as { path: string }[]).map((e) => e.path);
		const flushPage = next.store.flushPage.bind(next.store);
		const failed = { kept: false };
		next.store.flushPage = (async (id: string, ...rest: unknown[]) => {
			if (id === early.id && !failed.kept) {
				failed.kept = true;
				return false;
			}
			return (flushPage as (...a: unknown[]) => Promise<boolean>)(id, ...rest);
		}) as typeof next.store.flushPage;
		await closeSecond(next, second, secondAt);
		expect(failed.kept, "precondition: the leave's run tried to write the kept ink, and that write failed").toBe(true);
		expect(next.plugin.pdfLeaving(x1), "precondition: no leave run is going").toBe(false);
		expect(savedPaths(), "precondition: the leave is still owed, off the copy").toEqual([OTHER]);
		expect(claimersAmong(v, [x1], OTHER), "precondition: the found ink still claims the copy").toEqual([x1]);
		expect(next.pdfStore.generation(x1), "precondition: the found ink's record is forgotten").toBeNull();
		const foundPath = `.handwriting/${x1}.json`;
		const foundBytes = v.adapter.files.get(foundPath);
		expect(foundBytes, "precondition: the found ink's file is written").toBeDefined();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const runs = { n: 0 };
		const leave = next.plugin.pairedInkLeaves as (id: string, path: string, from: string) => Promise<void>;
		next.plugin.pairedInkLeaves = (id: string, path: string, from: string) => {
			if (id === x1) runs.n++;
			return leave.call(next.plugin, id, path, from);
		};
		v.adapter.files.set(foundPath, "{ not a page");
		expect(next.plugin.pdfPaneHoldsClaim(OTHER), "precondition: the first pane holds the copy's claim").toBe(true);
		await next.renameFile(OTHER, NEW);
		expect(savedPaths(), "precondition: the owed leave followed the rename at once").toEqual([NEW]);
		for (let i = 0; i < 3; i++) await movesSettled(next);
		expect(savedPaths(), "precondition: a leave run that could not read the found ink kept the leave owed").toEqual([NEW]);
		v.adapter.files.set(foundPath, foundBytes as string);
		expect(claimersAmong(v, [x1], OTHER), "precondition: the rename passed the found ink over, and it still claims the old name").toEqual([x1]);
		expect(claimersAmong(v, [early.id], NEW), "precondition: the kept ink claims the new name").toEqual([early.id]);
		const at = road === "a file at the old name deleted in its grace" ? OTHER : NEW;
		if (road !== "a file at the old name deleted in its grace") {
			await next.deleteFile(NEW);
			next.close(early.root);
			next.plugin.releasePdfId(early.id);
			if (road === "moved back as a delete and a create") await next.createFile(OTHER);
		} else {
			await next.createFile(OTHER);
			await next.deleteFile(OTHER);
		}
		expect(next.pdfStore.pendingClaims().has(at), "precondition: the road's deletion waits in its grace").toBe(true);
		expect(savedPaths(), "precondition: the leave is still owed before its run").toEqual([NEW]);
		const before = runs.n;
		next.plugin.releasePdfId(x1);
		await movesSettled(next);
		expect(runs.n, "precondition: the found ink's let-go ran its leave").toBeGreaterThan(before);
		const waiting = next.pdfStore.pendingClaims().has(at);
		await next.store.flush();
		if (past) await pastGrace(next, early.id, past);
		vi.useRealTimers();
		return { v, s: next, x1, early, savedPaths, waiting, at };
	}

	for (const road of ["moved back as a delete and a create", "a file at the old name deleted in its grace"] as const) {
		const end =
			road === "moved back as a delete and a create"
				? "inside the new name's grace the run leaves the leave owed and saved, the found ink claiming the old name only, live with its strokes and not in the trash, the kept ink claiming the new name only"
				: "the leave runs on the new name, the deletion at the old name still waiting after the run, the stroke on the kept ink, the new name claimed by the kept ink only, the old name by none, the found ink in the trash whole, nothing owed";
		it(`bound 8, the old name taken on the found ink's road: the copy renamed while a leave is owed and the found ink's file cannot be read, then ${road} before the leave's run: ${end}`, async () => {
			const { v, s, x1, early, savedPaths, waiting } = await renamedFoundUnreadableBack(road);
			if (road === "moved back as a delete and a create") {
				expect(waiting, "precondition: the reads are made inside the new name's deletion grace").toBe(true);
				expect(savedPaths(), "the leave's run did not leave the leave owed and saved").toEqual([NEW]);
				expect(v.sidecar(x1)?.pdfPaths, "the found ink does not claim the old name only").toEqual([OTHER]);
				expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "the found ink's file is not live with its strokes").toEqual(["ink-0", "pane2"]);
				expect(v.trashInk().map((t) => [...t].sort()), "the found ink went to the trash").not.toContainEqual(["ink-0", "pane2"]);
				expect(v.sidecar(early.id)?.pdfPaths, "the kept ink does not claim the new name only").toEqual([NEW]);
				return;
			}
			expect(waiting, "the leave's run ended the deletion waiting at the old name").toBe(true);
			await vi.waitFor(() => expect(claimersOnDisk(v, NEW), "not one ink file claims the new name on disk").toEqual([early.id]));
			expect(claimersOnDisk(v, OTHER), "an ink file still claims the old name on disk").toEqual([]);
			await s.store.flush();
			expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the stroke drawn on the found ink since the owe is not on the kept ink").toEqual(["own", "pane2"]);
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
			expect(v.local.has(OWED_KEY), "a leave is still owed after the run").toBe(false);
			expect(await restartStrokes(v, "name order", NEW), "after a restart the new name does not open on the kept ink with both strokes").toEqual({ id: early.id, strokes: ["own", "pane2"] });
		});
	}

	/** A stroke in the second pane while the leave is owed, then a quit with that pane open: the leave owed and saved. */
	async function quitOwedWithStroke() {
		const { v, next, x1, early, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await quit(next);
		expect(savedLeaves(v).map((e) => e.path), "precondition: one leave is saved owed, off the copy").toEqual([OTHER]);
		return { v, x1, early };
	}

	/** The owed leaves as saved under the device-local key. */
	function savedLeaves(v: ReturnType<typeof vault>): Record<string, unknown>[] {
		return JSON.parse((v.local.get(OWED_KEY) as string | undefined) ?? "[]") as Record<string, unknown>[];
	}

	/** The saved leaves rewritten by `edit`, as a quit leaves them (another build's shape, or a claim it saved). */
	function editSaved(v: ReturnType<typeof vault>, edit: (e: Record<string, unknown>) => void) {
		const saved = savedLeaves(v);
		for (const e of saved) edit(e);
		v.local.set(OWED_KEY, JSON.stringify(saved));
	}

	/** An open lists the ink file `first` before every other, whatever the folder's order. */
	function listFirst(s: ReturnType<typeof session>, first: string) {
		const list = s.store.listIds.bind(s.store);
		s.store.listIds = (async (prefix: string) => {
			const ids = [...(await list(prefix))].sort();
			return [...ids.filter((i) => i === first), ...ids.filter((i) => i !== first)];
		}) as typeof s.store.listIds;
		return s;
	}

	/**
	 * The copy renamed by a session that never owed the leave (another device, or a build without owed leaves on this
	 * one: it never reads the key), then quit. `moves`: "both" with no pane on the copy, so its claim move takes both
	 * inks; "found" or "kept" with a pane on the copy showing that ink, so only that ink's claim moves.
	 */
	async function renamedElsewhere(v: ReturnType<typeof vault>, x1: string, early: { id: string }, moves: "both" | "found" | "kept") {
		const other = session(v);
		if (moves === "both") {
			await other.renameFile(OTHER, NEW);
		} else {
			const shows = moves === "found" ? x1 : early.id;
			listFirst(other, shows);
			const pane = await other.open(OTHER);
			expect(pane.id, `precondition: the other session's pane on the copy shows the ${moves} ink`).toBe(shows);
			await other.renameFile(OTHER, NEW);
			other.close(pane.root);
			other.plugin.releasePdfId(pane.id);
		}
		await movesSettled(other);
		await other.store.flush();
		await quit(other);
		const onNew = { both: [early.id, x1], found: [x1], kept: [early.id] }[moves];
		expect(claimersOnDisk(v, NEW).sort(), "precondition: the rename moved the claims named").toEqual([...onNew].sort());
		expect(v.files.has(OTHER), "precondition: the old name is no file now").toBe(false);
	}

	/** The next launch of the session that owes the leave, the ink folder in `order`; its leaves run out, no pane open. */
	async function relaunchRun(v: ReturnType<typeof vault>, order: ListOrder) {
		const s = listInOrder(session(v, { pendingStore: true }), order);
		await settleGrace(s);
		await movesSettled(s);
		await movesSettled(s);
		await s.store.flush();
		return s;
	}

	/** The copy opened at its new name: on the kept ink with both strokes, the only claim on it, nothing owed. */
	async function newNameOnKeptInk(v: ReturnType<typeof vault>, s: ReturnType<typeof session>, early: { id: string }) {
		const opened = await s.open(NEW);
		await s.checked();
		await s.store.flush();
		expect(opened.id, "the renamed copy did not open on the kept ink").toBe(early.id);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id).sort(), "the renamed copy opens without every stroke drawn on it").toEqual(["own", "pane2"]);
		expect(claimersOnDisk(v, NEW), "not one ink file claims the new name on disk").toEqual([early.id]);
	}

	for (const [label, moves] of [["(a) both claims moved", "both"], ["(b) only the found ink's claim moved", "found"], ["(c) only the kept ink's claim moved", "kept"]] as const) {
		for (const order of ORDERS) {
			it(`a leave owed at a quit, the copy renamed by a session that never owed it, ${label}, then a launch, the ink folder in ${order}: the copy on the kept ink with every stroke, one claim, the found ink in the trash whole, nothing owed`, async () => {
				const { v, x1, early } = await quitOwedWithStroke();
				await renamedElsewhere(v, x1, early, moves);
				const s = await relaunchRun(v, order);
				vi.useRealTimers();
				await newNameOnKeptInk(v, s, early);
				foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
				expect(v.local.has(OWED_KEY), "a leave is still owed after the launch").toBe(false);
			});
		}
	}

	/**
	 * The launch above, but as Obsidian hands the vault at load: the copy at its new name is not listed yet and the
	 * layout is not ready. The owed leave restored at load runs then; its runs and checks run out before the list is
	 * full. Then the layout is ready: the vault lists the copy, the workspace flag is set, and the grace start the store
	 * handed to `afterLayout` runs, if it handed one (this road restores no deletion, so it may hand none). Every grace
	 * and check run out after that, as `relaunchRun` does. `unlisted` is what the vault held when the layout came.
	 */
	async function relaunchRunUnlisted(v: ReturnType<typeof vault>, order: ListOrder) {
		expect(v.files.has(NEW), "precondition: the copy is a file at its new name").toBe(true);
		v.files.delete(NEW);
		let start: (() => void) | undefined;
		const s = listInOrder(
			session(v, {
				pendingStore: true,
				layoutReady: false,
				afterLayout: (st) => {
					start = st;
				},
			}),
			order
		);
		await movesSettled(s);
		await movesSettled(s);
		await s.store.flush();
		const unlisted = { owed: savedLeaves(v).map((e) => e.path), onNew: claimersOnDisk(v, NEW).sort(), started: start !== undefined };
		v.files.add(NEW);
		(s.plugin.app.workspace as { layoutReady: boolean }).layoutReady = true;
		start?.();
		await settleGrace(s);
		await movesSettled(s);
		await movesSettled(s);
		await s.store.flush();
		return { s, unlisted };
	}

	// Written red, before their cure: a launch that meets the vault before it lists the renamed copy.
	for (const [label, moves] of [["(a) both claims moved", "both"], ["(b) only the found ink's claim moved", "found"], ["(c) only the kept ink's claim moved", "kept"]] as const) {
		for (const order of ORDERS) {
			it(`a leave owed at a quit, the copy renamed by a session that never owed it, ${label}, then a launch before the vault lists the copy at its new name, the ink folder in ${order}: once the layout is ready, the copy on the kept ink with every stroke, one claim, the found ink in the trash whole, nothing owed`, async () => {
				const { v, x1, early } = await quitOwedWithStroke();
				await renamedElsewhere(v, x1, early, moves);
				const { s, unlisted } = await relaunchRunUnlisted(v, order);
				vi.useRealTimers();
				// What the run left while the copy was unlisted: logged for the read, not asserted.
				console.info(`unlisted launch, ${label}, ${order}: owed off ${JSON.stringify(unlisted.owed)}; claims on the new name ${JSON.stringify(unlisted.onNew.map((id) => (id === early.id ? "kept" : id === x1 ? "found" : id)))}; grace start handed: ${unlisted.started}`);
				expect.soft(claimersOnDisk(v, NEW), "1 before the open: not one ink file claims the new name on disk").toEqual([early.id]);
				expect.soft(v.local.has(OWED_KEY), "2 before the open: a leave is still owed once the layout is ready").toBe(false);
				const opened = await s.open(NEW);
				await s.checked();
				await s.store.flush();
				expect.soft(opened.id === early.id ? "kept" : opened.id === x1 ? "found" : opened.id, "3 the renamed copy did not open on the kept ink").toBe("kept");
				expect.soft(s.pdfStore.strokes(opened.id).map((x) => x.id).sort(), "4 the renamed copy opens without every stroke drawn on it").toEqual(["own", "pane2"]);
				expect.soft(claimersOnDisk(v, NEW), "5 after the open: not one ink file claims the new name on disk").toEqual([early.id]);
				expect.soft(v.sidecar(x1), "6 the found ink's file is still live").toBeUndefined();
				expect.soft(v.trashInk().map((t) => [...t].sort()), "7 the found ink is not in the trash whole").toContainEqual(["ink-0", "pane2"]);
				expect.soft(v.local.has(OWED_KEY), "8 after the open: a leave is still owed").toBe(false);
			});
		}
	}

	/**
	 * A launch, the ink folder in `order`, its layout not ready at first; the file at `late` is listed only once the
	 * layout is ready, as Obsidian hands the vault at load (relaunchRunUnlisted, for any one path). The launch's runs and
	 * checks run out before; then the vault lists `late`, the workspace flag is set and the start the store handed to
	 * `afterLayout` runs, if it handed one. Every grace and check run out after that, as `relaunchRun` does.
	 */
	async function relaunchListedLate(v: ReturnType<typeof vault>, order: ListOrder, late: string, early?: (s: ReturnType<typeof session>) => Promise<void>) {
		expect(v.files.has(late), `precondition: ${late} is a file`).toBe(true);
		v.files.delete(late);
		let start: (() => void) | undefined;
		const s = listInOrder(
			session(v, {
				pendingStore: true,
				layoutReady: false,
				afterLayout: (st) => {
					start = st;
				},
			}),
			order
		);
		if (early) await early(s);
		await movesSettled(s);
		await movesSettled(s);
		await s.store.flush();
		v.files.add(late);
		(s.plugin.app.workspace as { layoutReady: boolean }).layoutReady = true;
		start?.();
		await settleGrace(s);
		await movesSettled(s);
		await movesSettled(s);
		await s.store.flush();
		return s;
	}

	/**
	 * What a launch left, told by each ink's part (the kept ink, the found ink), not its id: the leaves still saved, each
	 * ink's file on disk, the trash, and then the ink and strokes an open of `path` shows.
	 */
	async function launchEnd(v: ReturnType<typeof vault>, s: ReturnType<typeof session>, x1: string, early: { id: string }, path: string) {
		const part = (id: string) => (id === early.id ? "kept" : id === x1 ? "found" : "another");
		const ink = (id: string) => {
			const data = v.sidecar(id);
			return data === undefined ? "not live" : { claims: [...(data.pdfPaths ?? [])].sort(), strokes: data.strokes.map((x) => x.id).sort() };
		};
		const end = {
			owed: savedLeaves(v).map((e) => ({ path: e.path, was: e.was ?? [] })),
			kept: ink(early.id),
			found: ink(x1),
			trash: v.trashInk().map((t) => [...t].sort().join(" ")).sort(),
		};
		const opened = await s.open(path);
		await s.checked();
		await s.store.flush();
		return { ...end, open: { ink: part(opened.id), strokes: s.pdfStore.strokes(opened.id).map((x) => x.id).sort() } };
	}

	/**
	 * The copy renamed while a leave is owed and the kept ink's file cannot be read (renamedKeptUnreadableBack), the second pane
	 * open on the found ink, then a quit: the leave saved owed off the new name, with the old name it was owed under
	 * before; the kept ink still claims the old name. Then, the app shut, a sync tool moves the copy back to the old name:
	 * a file there, none at the new name. Not sure which file is the copy, a launch keeps the leave owed.
	 */
	async function quitKeptBehindMovedBack() {
		const { v, next, x1, early, secondAt } = await owedLeave({ settle: true });
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		next.close(early.root);
		next.plugin.releasePdfId(early.id);
		await movesSettled(next);
		const keptPath = `.handwriting/${early.id}.json`;
		const keptBytes = v.adapter.files.get(keptPath);
		expect(keptBytes, "precondition: the kept ink's file is written").toBeDefined();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		v.adapter.files.set(keptPath, "{ not a page");
		await next.renameFile(OTHER, NEW);
		await movesSettled(next);
		v.adapter.files.set(keptPath, keptBytes as string);
		expect(claimersAmong(v, [early.id], OTHER), "precondition: the rename passed the kept ink over, and it still claims the old name").toEqual([early.id]);
		expect(claimersAmong(v, [x1], NEW), "precondition: the found ink claims the new name").toEqual([x1]);
		await quit(next);
		expect(savedLeaves(v).map((e) => [e.path, e.was]), "precondition: one leave saved owed off the new name, owed under the old name before").toEqual([[NEW, [OTHER]]]);
		v.files.delete(NEW);
		v.files.add(OTHER);
		return { v, x1, early };
	}

	/**
	 * A leave owed at a quit, the copy renamed by a session that never owed it with a pane there on the kept ink (only
	 * the kept ink's claim moved), then, the app shut, a file comes to the old name, the leave's own path. A launch is
	 * not sure where the leave belongs, and keeps it owed.
	 */
	async function quitKeptMovedFileAtPath() {
		const { v, x1, early } = await quitOwedWithStroke();
		await renamedElsewhere(v, x1, early, "kept");
		v.files.add(OTHER);
		expect(claimersOnDisk(v, OTHER), "precondition: the found ink alone claims the old name").toEqual([x1]);
		return { v, x1, early };
	}

	// Written red, before their cure: the same launch, one file listed only at the layout, ends otherwise.
	for (const [label, setup] of [
		["the copy renamed while the kept ink's file could not be read, then moved back to the old name with the app shut; the launch lists the old name only at the layout", quitKeptBehindMovedBack],
		["only the kept ink's claim moved by a rename elsewhere, then a file at the old name; the launch lists the leave's own path only at the layout", quitKeptMovedFileAtPath],
	] as const) {
		for (const order of ORDERS) {
			it(`a leave owed at a quit, ${label}, the ink folder in ${order}: it ends as the launch that lists every file from the start`, async () => {
				const listed = await (async () => {
					const { v, x1, early } = await setup();
					const s = await relaunchRun(v, order);
					vi.useRealTimers();
					return launchEnd(v, s, x1, early, OTHER);
				})();
				const late = await (async () => {
					const { v, x1, early } = await setup();
					const s = await relaunchListedLate(v, order, OTHER);
					vi.useRealTimers();
					return launchEnd(v, s, x1, early, OTHER);
				})();
				console.info(`listed late, ${label}, ${order}: ${JSON.stringify(late)}; listed from the start: ${JSON.stringify(listed)}`);
				expect.soft(late.owed, "1 the leaves saved owed differ").toEqual(listed.owed);
				expect.soft(late.kept, "2 the kept ink's file differs").toEqual(listed.kept);
				expect.soft(late.found, "3 the found ink's file differs").toEqual(listed.found);
				expect.soft(late.trash, "4 the trash differs").toEqual(listed.trash);
				expect.soft(late.open, "5 an open of the old name after shows other ink").toEqual(listed.open);
			});
		}
	}

	/** The found ink's file given a claim on ELSEWHERE as well (a sync can bring one), whatever it claims now; ELSEWHERE a file. */
	function foundAlsoClaimsElsewhere(v: ReturnType<typeof vault>, x1: string) {
		v.files.add(ELSEWHERE);
		const file = `.handwriting/${x1}.json`;
		const page = parsePage(v.adapter.files.get(file) as string, x1).data;
		v.adapter.files.set(file, serializePage({ ...page, pdfPaths: [...(page.pdfPaths ?? []), ELSEWHERE] }));
	}

	/** The found ink shown in a pane of its other PDF and let go again, as a pane restored at launch can be. */
	function letGoOnElsewhere(x1: string) {
		return async (s: ReturnType<typeof session>) => {
			const pane = await s.open(ELSEWHERE);
			expect(pane.id, "precondition: the found ink's other PDF opens on it").toBe(x1);
			s.close(pane.root);
			s.plugin.releasePdfId(pane.id);
		};
	}

	/** relaunchRun, with `early` run on the session first. */
	async function relaunchRunEarly(v: ReturnType<typeof vault>, order: ListOrder, early: (s: ReturnType<typeof session>) => Promise<void>) {
		const s = listInOrder(session(v, { pendingStore: true }), order);
		await early(s);
		await settleGrace(s);
		await movesSettled(s);
		await movesSettled(s);
		await s.store.flush();
		return s;
	}

	// Written red, before their cure: the roads above, with the found ink also claiming another PDF that a pane shows and
	// lets go before the layout is ready. That let-go runs the leave as the launch's restore does.
	for (const [label, setup] of [
		["the copy renamed while the kept ink's file could not be read, then moved back to the old name with the app shut", quitKeptBehindMovedBack],
		["only the kept ink's claim moved by a rename elsewhere, then a file at the old name", quitKeptMovedFileAtPath],
	] as const) {
		for (const order of ORDERS) {
			it(`a leave owed at a quit, ${label}, the found ink claiming another PDF as well; a launch lists the old name only at the layout, and before it a pane of that other PDF shows the found ink and closes, the ink folder in ${order}: it ends as the launch that lists every file from the start`, async () => {
				const listed = await (async () => {
					const { v, x1, early } = await setup();
					foundAlsoClaimsElsewhere(v, x1);
					const s = await relaunchRunEarly(v, order, letGoOnElsewhere(x1));
					vi.useRealTimers();
					return launchEnd(v, s, x1, early, OTHER);
				})();
				const late = await (async () => {
					const { v, x1, early } = await setup();
					foundAlsoClaimsElsewhere(v, x1);
					const s = await relaunchListedLate(v, order, OTHER, letGoOnElsewhere(x1));
					vi.useRealTimers();
					return launchEnd(v, s, x1, early, OTHER);
				})();
				console.info(`let go before the layout, ${label}, ${order}: ${JSON.stringify(late)}; listed from the start: ${JSON.stringify(listed)}`);
				expect.soft(late.owed, "1 the leaves saved owed differ").toEqual(listed.owed);
				expect.soft(late.kept, "2 the kept ink's file differs").toEqual(listed.kept);
				expect.soft(late.found, "3 the found ink's file differs").toEqual(listed.found);
				expect.soft(late.trash, "4 the trash differs").toEqual(listed.trash);
				expect.soft(late.open, "5 an open of the old name after shows other ink").toEqual(listed.open);
			});
		}
	}

	// A result: passed when written. Nothing on the load's road waits for the layout: the app lists the vault, and so
	// makes the layout ready, only once every plugin's load has ended.
	it("the launch's restore of owed leaves and deletions returns at once, the layout never ready: not a promise, and the load does not wait on it or on the layout", async () => {
		const { v } = await quitOwedWithStroke();
		const s = session(v, { layoutReady: false, afterLayout: () => {} });
		const back = s.plugin.attachPdfPendingDeletes() as unknown;
		expect.soft(back, "1 the restore handed back something the load could wait on").toBeUndefined();
		const load = mainSource.replace(/\r\n/g, "\n");
		const at = load.indexOf("\tasync onload(): Promise<void> {");
		const end = load.indexOf("\n\t}\n", at);
		expect(at, "precondition: the plugin's load is found").toBeGreaterThan(0);
		const body = load.slice(at, end);
		expect.soft(body.split("\n").filter((l) => l.includes("attachPdfPendingDeletes")), "2 the load does not call the restore once, unawaited").toEqual(["\t\tthis.attachPdfPendingDeletes();"]);
		expect.soft(/await[^;]*onLayoutReady|await[^;]*layoutReady/.test(body), "3 the load waits on the layout").toBe(false);
		await quit(s);
	});

	// A result: passed when written. The run at the layout goes through the let-go, as every run does: one run, and the
	// found ink's record let go at its end, when the run cannot end the leave.
	for (const order of ORDERS) {
		it(`a leave owed at a quit, both claims moved by a rename elsewhere, then a launch whose layout is ready before the vault lists the copy at its new name, the ink folder in ${order}: one run of the leave, the found ink's record let go, the leave still owed`, async () => {
			const { v, x1, early } = await quitOwedWithStroke();
			await renamedElsewhere(v, x1, early, "both");
			v.files.delete(NEW);
			const runs = vi.spyOn(HandwritingPlugin.prototype as unknown as { pairedInkLeaves: (id: string, path: string, from: string) => Promise<void> }, "pairedInkLeaves");
			let start: (() => void) | undefined;
			const s = listInOrder(
				session(v, {
					pendingStore: true,
					layoutReady: false,
					afterLayout: (st) => {
						start = st;
					},
				}),
				order
			);
			await movesSettled(s);
			(s.plugin.app.workspace as { layoutReady: boolean }).layoutReady = true;
			start?.();
			await settleGrace(s);
			await movesSettled(s);
			await movesSettled(s);
			await s.store.flush();
			vi.useRealTimers();
			expect.soft(runs.mock.calls.filter((c) => c[0] === x1).length, "1 not one run of the found ink's leave").toBe(1);
			expect.soft(s.pdfStore.inkReady(x1), "2 the found ink's record is still held with no pane").toBe(false);
			expect.soft(savedLeaves(v).map((e) => e.path), "3 the leave is not still owed off the old name").toEqual([OTHER]);
		});
	}

	/**
	 * The app's layout callbacks as Obsidian keeps them, under the afterLayout main.ts hands the store: main.ts gives the
	 * start to workspace.onLayoutReady and runs nothing once the plugin unloaded. A callback waits in the app's list until
	 * the first layout; from then on the list is gone for the session and each callback runs at once, whatever the
	 * workspace's flag says (a saved workspace's load clears the layout and sets the flag false again; the list stays
	 * gone). `handed` counts the starts the store handed.
	 */
	function appLayout() {
		let waiting: (() => void)[] | null = [];
		let plugin: { unloaded?: boolean } | undefined;
		let handed = 0;
		const onLayoutReady = (fn: () => void) => {
			if (waiting === null) fn();
			else waiting.push(fn);
		};
		return {
			afterLayout: (start: () => void) => {
				handed++;
				onLayoutReady(() => {
					if (plugin?.unloaded) return;
					start();
				});
			},
			bind(s: ReturnType<typeof session>) {
				plugin = s.plugin;
			},
			first() {
				const now = waiting ?? [];
				waiting = null;
				for (const fn of now) fn();
			},
			pastFirst: () => waiting === null,
			handed: () => handed,
		};
	}

	/**
	 * The plugin loaded once the app's first layout came (turned on, or reloaded by an update, mid-session) over one leave
	 * owed at a quit and no deletion in its grace: nothing at that load waits for the layout, so the store hands
	 * `afterLayout` no start and its wait stays open all session (waitsForLayout). The leave restored at the load runs at
	 * once; the kept ink's file unreadable then (a sync still writing it) leaves it owed, and the file is whole again
	 * after. A session cannot owe a leave of its own unless its launch restored deletions (a blank opened before the list
	 * is full), and that launch hands a start; so this is the road on which a leave is owed with the wait open. The found
	 * ink claims another PDF as well, and a pane of that PDF shows it, as a pop-out window can.
	 */
	async function loadedAfterLayoutStillOwed() {
		const { v, x1, early } = await quitOwedWithStroke();
		expect(JSON.parse((v.local.get(PENDING_KEY) as string | undefined) ?? "[]"), "precondition: no deletion saved in its grace").toEqual([]);
		foundAlsoClaimsElsewhere(v, x1);
		const keptPath = `.handwriting/${early.id}.json`;
		const keptBytes = v.adapter.files.get(keptPath);
		expect(keptBytes, "precondition: the kept ink's file is written").toBeDefined();
		v.adapter.files.set(keptPath, "{ not a page");
		vi.spyOn(console, "error").mockImplementation(() => {});
		type Leave = (this: unknown, id: string, path: string, from: string) => Promise<void>;
		const realLeave = (HandwritingPlugin.prototype as unknown as { pairedInkLeaves: Leave }).pairedInkLeaves;
		const runs = vi.spyOn(HandwritingPlugin.prototype as unknown as { pairedInkLeaves: Leave }, "pairedInkLeaves");
		const layout = appLayout();
		layout.first();
		const s = session(v, { pendingStore: true, layoutReady: true, afterLayout: layout.afterLayout });
		layout.bind(s);
		await settledPastFailure(s);
		await s.store.flush();
		expect(runs.mock.calls.filter((c) => c[0] === x1).length, "precondition: the leave ran at the load").toBe(1);
		expect(savedLeaves(v).map((e) => e.path), "precondition: the leave is still owed after the load").toEqual([OTHER]);
		v.adapter.files.set(keptPath, keptBytes as string);
		expect(layout.handed(), "precondition: the load handed the layout no start").toBe(0);
		const pane = await s.open(ELSEWHERE);
		await s.checked();
		expect(pane.id, "precondition: the other PDF's pane shows the found ink").toBe(x1);
		const runsOfFound = () => runs.mock.calls.filter((c) => c[0] === x1).length;
		return { v, s, x1, early, pane, runs, realLeave, layout, runsOfFound };
	}

	/**
	 * The pop-out window with `pane` closed, which lets its ink go (main.ts's window close): while a saved workspace
	 * loads (the app's layout cleared, its flag false) or with the layout ready. The store's wait is still open then.
	 */
	function popOutClosed(o: Awaited<ReturnType<typeof loadedAfterLayoutStillOwed>>, during: "workspace load" | "layout ready") {
		const workspace = o.s.plugin.app.workspace as { layoutReady: boolean };
		workspace.layoutReady = during === "layout ready";
		expect(o.s.pdfStore.waitsForLayout(), "precondition: the store's wait for the layout is open at the let-go").toBe(true);
		expect(o.layout.pastFirst(), "precondition: past the app's first layout, so its layout callback runs at once").toBe(true);
		o.s.close(o.pane.root);
		o.s.plugin.releasePdfId(o.pane.id);
	}

	/** Every check and wait run out; the workspace's load over (the flag true again); run out again. */
	async function loadOver(s: ReturnType<typeof session>) {
		await movesSettled(s);
		await movesSettled(s);
		await s.store.flush();
		(s.plugin.app.workspace as { layoutReady: boolean }).layoutReady = true;
		await movesSettled(s);
		await s.store.flush();
	}

	/** After the close: one run of the leave since `before`, the leave ended, the found ink on its other PDF only, its record let go. */
	function ranOnceAndEnded(o: Awaited<ReturnType<typeof loadedAfterLayoutStillOwed>>, before: number, label: string) {
		const after = { runs: o.runsOfFound() - before, owed: savedLeaves(o.v).map((e) => e.path), found: o.v.sidecar(o.x1)?.pdfPaths, held: o.s.pdfStore.inkReady(o.x1), handed: o.layout.handed() };
		console.info(`pop-out closed, ${label}: ${JSON.stringify(after)}`);
		expect.soft(after.runs, "1 the let-go did not run the leave once").toBe(1);
		expect.soft(after.owed, "2 the leave is still owed").toEqual([]);
		expect.soft(claimersOnDisk(o.v, OTHER), "3 not one ink file claims the copy on disk").toEqual([o.early.id]);
		expect.soft(after.found, "4 the found ink's file is not live with its other PDF's claim only").toEqual([ELSEWHERE]);
		expect.soft(after.held, "5 the found ink's record is still held with no pane").toBe(false);
	}

	const LOADED_PAST_LAYOUT = "the plugin loaded after the app's first layout over a leave owed at a quit, its run there failing once; a pop-out pane shows the found ink on its other PDF";

	// Written red, before its cure.
	it(`${LOADED_PAST_LAYOUT}, then a workspace load closes it (the layout flag false, the app's layout callback run at once): one run of the leave, which ends; the found ink keeps its other PDF only, its record let go`, async () => {
		const o = await loadedAfterLayoutStillOwed();
		const before = o.runsOfFound();
		popOutClosed(o, "workspace load");
		await loadOver(o.s);
		vi.useRealTimers();
		ranOnceAndEnded(o, before, "workspace load");
	});

	// A result: passed when written (there the first let-go is lost and the second runs the leave); kept to hold one run.
	it(`${LOADED_PAST_LAYOUT}, then a workspace load closes it and the found ink is let go again while the leave's run is held: one run while it is held; once it ends, one run in all, nothing owed, the record let go`, async () => {
		const o = await loadedAfterLayoutStillOwed();
		const before = o.runsOfFound();
		let release!: () => void;
		const held = new Promise<void>((done) => (release = done));
		o.runs.mockImplementation(async function (this: unknown, id: string, path: string, from: string) {
			if (id === o.x1) await held;
			return o.realLeave.call(this, id, path, from);
		});
		popOutClosed(o, "workspace load");
		await vi.advanceTimersByTimeAsync(1_001);
		o.s.plugin.releasePdfId(o.pane.id);
		await vi.advanceTimersByTimeAsync(1_001);
		const whileHeld = o.runsOfFound() - before;
		release();
		await loadOver(o.s);
		vi.useRealTimers();
		expect.soft(whileHeld, "0 not one run while the first is held").toBe(1);
		ranOnceAndEnded(o, before, "workspace load, let go again while held");
	});

	// A control, passed when written: the store's wait open all session, the layout ready at the let-go.
	it(`${LOADED_PAST_LAYOUT}, then it is closed with the layout ready: one run of the leave, which ends; the found ink keeps its other PDF only, its record let go`, async () => {
		const o = await loadedAfterLayoutStillOwed();
		const before = o.runsOfFound();
		popOutClosed(o, "layout ready");
		await loadOver(o.s);
		vi.useRealTimers();
		ranOnceAndEnded(o, before, "layout ready");
	});

	// A result: passed when written.
	for (const order of ORDERS) {
		it(`a leave owed at a quit with a stroke on the found ink since the owe, then a launch that opens the copy before the layout is ready, the ink folder in ${order}: the copy opens on the kept ink; once the layout is ready it holds both strokes, one claim, the found ink in the trash whole, nothing owed`, async () => {
			const { v, x1, early } = await quitOwedWithStroke();
			let start: (() => void) | undefined;
			const s = listInOrder(
				session(v, {
					pendingStore: true,
					layoutReady: false,
					afterLayout: (st) => {
						start = st;
					},
				}),
				order
			);
			const opened = await s.open(OTHER);
			const at = s.plugin.pdfIds.get(opened.root) as string;
			expect.soft(at === early.id ? "kept" : at === x1 ? "found" : at, "1 before the layout is ready: the copy did not open on the kept ink").toBe("kept");
			(s.plugin.app.workspace as { layoutReady: boolean }).layoutReady = true;
			start?.();
			await settleGrace(s);
			await movesSettled(s);
			await movesSettled(s);
			await s.store.flush();
			vi.useRealTimers();
			const now = s.plugin.pdfIds.get(opened.root) as string;
			expect.soft(now === early.id ? "kept" : now === x1 ? "found" : now, "2 once the layout is ready: the copy's pane is not on the kept ink").toBe("kept");
			await vi.waitFor(() => expect(s.pdfStore.strokes(now).map((x) => x.id).sort(), "3 once the layout is ready: the copy's pane does not show both strokes").toEqual(["own", "pane2"]));
			await s.store.flush();
			expect.soft(claimersOnDisk(v, OTHER), "4 not one ink file claims the copy on disk").toEqual([early.id]);
			expect.soft(v.sidecar(x1), "5 the found ink's file is still live").toBeUndefined();
			expect.soft(v.trashInk().map((t) => [...t].sort()), "6 the found ink is not in the trash whole").toContainEqual(["ink-0", "pane2"]);
			expect.soft(v.local.has(OWED_KEY), "7 a leave is still owed").toBe(false);
			expect.soft(await restartStrokes(v, order), "8 after a restart the copy does not open on the kept ink with both strokes").toEqual({ id: early.id, strokes: ["own", "pane2"] });
		});
	}

	// Written red, before their cure. `elsewhere`: the found ink claims another PDF as well, which opens on it before the
	// layout is ready and closes again.
	for (const elsewhere of [false, true]) {
		const road = elsewhere ? "the found ink opened in a pane of its other PDF and let go before then" : "no pane open";
		it(`a leave owed at a quit, then a launch quit again before the layout is ready, ${road}: the saved leaves byte-equal; the next launch runs the leave, the kept ink with both strokes, one claim on the copy, nothing owed`, async () => {
			const { v, x1, early } = await quitOwedWithStroke();
			const keeps = elsewhere ? foundClaimsElsewhere(v, x1) : undefined;
			if (elsewhere) editSaved(v, (e) => (e.foundPaths = [...((e.foundPaths as string[] | undefined) ?? []), ELSEWHERE]));
			const before = v.local.get(OWED_KEY);
			expect(typeof before, "precondition: the leave is saved").toBe("string");
			const s = session(v, { pendingStore: true, layoutReady: false, afterLayout: () => {} });
			if (elsewhere) {
				const pane = await s.open(ELSEWHERE);
				expect(pane.id, "precondition: the found ink's other PDF opens on it").toBe(x1);
				s.close(pane.root);
				s.plugin.releasePdfId(pane.id);
			}
			await movesSettled(s);
			await movesSettled(s);
			await quit(s);
			expect.soft(v.local.get(OWED_KEY), "1 the saved leaves changed before the layout was ready").toBe(before);
			const next = await relaunchRun(v, "name order");
			vi.useRealTimers();
			expect.soft(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "2 the kept ink does not hold both strokes").toEqual(["own", "pane2"]);
			expect.soft(claimersOnDisk(v, OTHER), "3 not one ink file claims the copy on disk").toEqual([early.id]);
			if (keeps) expect.soft(v.sidecar(x1)?.pdfPaths, "4 the found ink does not keep its other PDF's claim alone").toEqual(keeps);
			else expect.soft(v.trashInk().map((t) => [...t].sort()), "4 the found ink is not in the trash whole").toContainEqual(["ink-0", "pane2"]);
			expect.soft(v.local.has(OWED_KEY), "5 a leave is still owed after the next launch").toBe(false);
			await next.store.flush();
		});
	}

	// A result: passed when written.
	for (const order of ORDERS) {
		it(`a leave owed at a quit inside the grace with a stroke on the found ink since the owe, then a launch whose layout is ready later, the ink folder in ${order}: the restored deletions wait for the layout and run out after it; one claim, the copy on the kept ink with both strokes, the found ink in the trash whole, nothing owed or waiting`, async () => {
			const { v, next, x1, early, secondAt } = await owedLeave({ settle: false });
			next.draw(secondAt, stroke(61, "pane2"));
			await next.store.flush();
			expect(next.pdfStore.pendingClaims().size > 0, "precondition: the quit comes inside the grace").toBe(true);
			await quit(next);
			expect(savedLeaves(v).map((e) => e.path), "precondition: one leave is saved owed, off the copy").toEqual([OTHER]);
			let start: (() => void) | undefined;
			const s = listInOrder(
				session(v, {
					pendingStore: true,
					layoutReady: false,
					afterLayout: (st) => {
						start = st;
					},
				}),
				order
			);
			expect(start, "precondition: the restored deletions wait for the layout").toBeDefined();
			expect(s.pdfStore.pendingClaims().size > 0, "precondition: a deletion resumed in its grace").toBe(true);
			await movesSettled(s);
			await movesSettled(s);
			(s.plugin.app.workspace as { layoutReady: boolean }).layoutReady = true;
			start?.();
			await vi.advanceTimersByTimeAsync(10_001);
			await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size, "1 a restored deletion still waits once the layout is ready and its grace is past").toBe(0));
			await s.store.flush();
			await movesSettled(s);
			await movesSettled(s);
			await s.store.flush();
			vi.useRealTimers();
			expect.soft(v.local.has(PENDING_KEY), "2 a deletion is still saved as waiting").toBe(false);
			expect.soft(claimersOnDisk(v, OTHER), "3 not one ink file claims the copy on disk").toEqual([early.id]);
			expect.soft(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "4 the kept ink does not hold both strokes").toEqual(["own", "pane2"]);
			expect.soft(v.sidecar(x1), "5 the found ink's file is still live").toBeUndefined();
			expect.soft(v.trashInk().map((t) => [...t].sort()), "6 the found ink is not in the trash whole").toContainEqual(["ink-0", "pane2"]);
			expect.soft(v.local.has(OWED_KEY), "7 a leave is still owed").toBe(false);
			expect.soft(await restartStrokes(v, order), "8 after a restart the copy does not open on the kept ink with both strokes").toEqual({ id: early.id, strokes: ["own", "pane2"] });
		});
	}

	it("a leave owed at a quit, the found ink claiming the original as well then, the copy renamed by a session that never owed it with a pane there on the found ink, then a launch: the copy on the kept ink, one claim, the found ink live with the original's claim only, the original still on it", async () => {
		const { v, x1, early } = await quitOwedWithStroke();
		const keeps = foundClaimsElsewhere(v, x1);
		// As the owe saves it when the found ink claims the original then.
		editSaved(v, (e) => (e.foundPaths = [...((e.foundPaths as string[] | undefined) ?? []), ELSEWHERE]));
		await renamedElsewhere(v, x1, early, "found");
		expect(v.sidecar(x1)?.pdfPaths?.sort(), "precondition: the found ink claims the original and the new name").toEqual([...keeps, NEW].sort());
		const s = await relaunchRun(v, "name order");
		vi.useRealTimers();
		await newNameOnKeptInk(v, s, early);
		expect(v.sidecar(x1)?.pdfPaths, "the found ink does not keep the original's claim alone").toEqual(keeps);
		expect(v.local.has(OWED_KEY), "a leave is still owed after the launch").toBe(false);
		expect((await restartStrokes(v, "name order", ELSEWHERE)).id, "the original no longer opens on the found ink").toBe(x1);
	});

	it("rule 2: a leave owed at a quit, a second claim given to the found ink after the owe, the copy renamed by a session that never owed it with a pane there on the found ink, then a launch: not sure which name is the copy's, so nothing dropped, nothing to the trash, the leave still owed", async () => {
		const { v, x1, early } = await quitOwedWithStroke();
		const keeps = foundClaimsElsewhere(v, x1);
		await renamedElsewhere(v, x1, early, "found");
		const trashBefore = v.trashInk().length;
		await relaunchRun(v, "name order");
		vi.useRealTimers();
		expect(v.sidecar(x1)?.pdfPaths?.sort(), "a claim of the found ink was dropped or moved").toEqual([...keeps, NEW].sort());
		expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "the found ink's strokes changed").toEqual(["ink-0", "pane2"]);
		expect(v.sidecar(early.id)?.pdfPaths, "the kept ink's claim was moved").toEqual([OTHER]);
		expect(v.trashInk().length, "an ink file went to the trash").toBe(trashBefore);
		expect(savedLeaves(v).map((e) => e.path), "the leave is not still owed and saved").toEqual([OTHER]);
	});

	it("a leave owed at a quit, the found ink claiming the original as well then, the copy deleted by a session that never owed it and its claims retired, then a launch: the original's claim kept, nothing to the trash at the launch, the leave ended", async () => {
		const { v, x1, early } = await quitOwedWithStroke();
		foundClaimsElsewhere(v, x1);
		editSaved(v, (e) => (e.foundPaths = [...((e.foundPaths as string[] | undefined) ?? []), ELSEWHERE]));
		const other = session(v);
		await other.deleteFile(OTHER);
		await settleGrace(other);
		await movesSettled(other);
		await other.store.flush();
		await quit(other);
		expect(claimersOnDisk(v, OTHER), "precondition: the delete's grace retired the claims on the copy").toEqual([]);
		const trashBefore = v.trashInk().length;
		await relaunchRun(v, "name order");
		vi.useRealTimers();
		expect(v.sidecar(x1)?.pdfPaths, "the found ink lost the original's claim").toContain(ELSEWHERE);
		expect(v.trashInk().length, "the launch sent an ink file to the trash").toBe(trashBefore);
		expect(v.local.has(OWED_KEY), "the leave of a deleted copy is still owed").toBe(false);
		void early;
	});

	it("a leave saved by a build that kept no claims with it, the copy renamed by a session that never owed it, then a launch: not sure, so nothing dropped, nothing to the trash, the leave still owed", async () => {
		const { v, x1, early } = await quitOwedWithStroke();
		editSaved(v, (e) => {
			delete e.keptPaths;
			delete e.foundPaths;
		});
		await renamedElsewhere(v, x1, early, "both");
		const trashBefore = v.trashInk().length;
		await relaunchRun(v, "name order");
		vi.useRealTimers();
		expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "the found ink's file changed").toEqual(["ink-0", "pane2"]);
		expect(claimersOnDisk(v, NEW).sort(), "a claim on the new name was dropped").toEqual([early.id, x1].sort());
		expect(v.trashInk().length, "an ink file went to the trash").toBe(trashBefore);
		expect(savedLeaves(v).map((e) => e.path), "the leave is not still owed and saved").toEqual([OTHER]);
	});

	it("a leave saved by a build that kept no claims with it, the copy not renamed, then a launch: it runs as before", async () => {
		const { v, x1, early } = await quitOwedWithStroke();
		editSaved(v, (e) => {
			delete e.keptPaths;
			delete e.foundPaths;
		});
		const s = await relaunchRun(v, "name order");
		vi.useRealTimers();
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the kept ink's file does not hold the second pane's stroke").toEqual(["own", "pane2"]);
		expect(claimersOnDisk(v, OTHER), "not one ink file claims the copy on disk").toEqual([early.id]);
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		expect(v.local.has(OWED_KEY), "a leave is still owed after the launch").toBe(false);
		void s;
	});

	it("a leave saved with both inks' claims (this build's shape), the copy not renamed, then a launch: it runs as before, by a build that reads the claims or one that does not", async () => {
		const { v, x1, early } = await quitOwedWithStroke();
		editSaved(v, (e) => {
			e.keptPaths ??= [OTHER];
			e.foundPaths ??= [OTHER];
		});
		await relaunchRun(v, "name order");
		vi.useRealTimers();
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the kept ink's file does not hold the second pane's stroke").toEqual(["own", "pane2"]);
		expect(claimersOnDisk(v, OTHER), "not one ink file claims the copy on disk").toEqual([early.id]);
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		expect(v.local.has(OWED_KEY), "a leave is still owed after the launch").toBe(false);
	});

	for (const at of FOUND_AT) {
		it(`an open of the renamed copy at a launch, overlapping the end of a leave the launch runs on the new name after a rename made elsewhere (${at}, its claims read before the run writes it, the choice after the run's end): the copy on the kept ink, one claim, the found ink in the trash whole`, async () => {
			const { v, next, x1, early } = await owedLeave({ settle: true });
			await quit(next);
			await renamedElsewhere(v, x1, early, "both");
			vi.useRealTimers();
			const s = session(v, { pendingStore: true });
			const { opened } = await openOverlappingRunEnd(v, s, x1, () => {}, at, "its claims read before the run writes it", NEW);
			await onKeptInk(v, s, early, opened, "its claims read before the run writes it", NEW);
			foundInTrashWhole(v, x1, ["ink-0"]);
		});
	}

	it("rule 6 pin: an open and a close of a PDF with a leave owed for another PDF: the file lists and reads it makes as with nothing owed", async () => {
		const v = vault();
		await inked(v, [FIRST]);
		// A leave owed for another PDF whose kept ink's file does not parse: it stays owed, its run leaves it (rule 2).
		const kept = "pdf-00000000000000000000000000000000-k";
		v.adapter.files.set(`.handwriting/${kept}.json`, "{ not ink");
		v.local.set(OWED_KEY, JSON.stringify([{ id: "pdf-00000000000000000000000000000000-f", path: "Else/Z.pdf", from: kept, keptPaths: ["Else/Z.pdf"], foundPaths: ["Else/Z.pdf"] }]));
		const s = session(v, { pendingStore: true });
		await s.checked();
		await s.pdfStore.settle();
		expect(savedLeaves(v).length, "precondition: the other PDF's leave is still owed").toBe(1);
		const count = { list: 0, read: 0, local: 0, listIds: 0, readPdfPaths: 0 };
		const list = v.adapter.list.bind(v.adapter);
		const read = v.adapter.read.bind(v.adapter);
		v.adapter.list = async (f: string) => (count.list++, list(f));
		v.adapter.read = async (p: string) => (count.read++, read(p));
		const loadLocal = s.plugin.app.loadLocalStorage;
		s.plugin.app.loadLocalStorage = (k: string) => (count.local++, loadLocal(k));
		const listIds = s.store.listIds.bind(s.store);
		s.store.listIds = (async (p: string) => (count.listIds++, listIds(p))) as typeof s.store.listIds;
		const readPdfPaths = s.store.readPdfPaths.bind(s.store);
		s.store.readPdfPaths = (async (id: string) => (count.readPdfPaths++, readPdfPaths(id))) as typeof s.store.readPdfPaths;
		const o = await s.open(FIRST);
		await s.store.flush();
		const atOpen = { ...count };
		s.close(o.root);
		s.plugin.releasePdfId(o.id);
		await s.pdfStore.settle();
		await s.store.flush();
		const atClose = Object.fromEntries(Object.entries(count).map(([k, n]) => [k, n - atOpen[k as keyof typeof count]]));
		expect(atOpen, "an open with another PDF's leave owed lists, reads or loads more than with nothing owed").toEqual({ list: 2, read: 2, local: 0, listIds: 1, readPdfPaths: 1 });
		expect(atClose, "a close with another PDF's leave owed lists or reads").toEqual({ list: 0, read: 0, local: 0, listIds: 0, readPdfPaths: 0 });
		expect(shown, "a notice showed").toEqual([]);
	});

	it("pin: a leave owed at a quit, the copy renamed while closed by another program (no session hears it), then a launch: the leave runs on the old name, the found ink in the trash whole, and the new name opens on the kept ink", async () => {
		const { v, x1, early } = await quitOwedWithStroke();
		v.files.delete(OTHER);
		v.files.add(NEW);
		const s = await relaunchRun(v, "name order");
		vi.useRealTimers();
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		expect(v.local.has(OWED_KEY), "a leave is still owed after the launch").toBe(false);
		await newNameOnKeptInk(v, s, early);
	});

	it("pin: a leave owed at a quit, the found ink's file gone before the launch: the leave is forgotten, nothing to the trash, the kept ink unchanged", async () => {
		const { v, x1, early } = await quitOwedWithStroke();
		v.adapter.files.delete(`.handwriting/${x1}.json`);
		const trashBefore = v.trashInk().length;
		await relaunchRun(v, "name order");
		vi.useRealTimers();
		expect(v.local.has(OWED_KEY), "the leave of a found ink with no file is still owed").toBe(false);
		expect(v.trashInk().length, "an ink file went to the trash").toBe(trashBefore);
		expect(v.sidecar(early.id)?.pdfPaths, "the kept ink's claim changed").toEqual([OTHER]);
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id), "the kept ink's strokes changed").toEqual(["own"]);
	});

	/** The two roads the copy goes back to the old name by a delete and a create, past the new name's grace. */
	const BACK_PAST = {
		"the kept ink's file unreadable at the rename": (road: "moved back as a delete and a create" | "deleted for real", past: Past) =>
			renamedKeptUnreadableBack(road, past),
		"the found ink's file unreadable at the rename": (road: "moved back as a delete and a create" | "deleted for real", past: Past) =>
			renamedFoundUnreadableBack(road, past),
	} as const;
	/** Every stroke of the kept ink's file in the trash, one list per such file. */
	const keptInTrash = (v: ReturnType<typeof vault>) => v.trashInk().filter((t) => t.includes("own"));

	for (const [roadName, back] of Object.entries(BACK_PAST)) {
		for (const order of ORDERS) {
			it(`bound 8, the copy moved back as a delete and a create past the new name's grace, ${roadName}, then a restart at the old name, the ink folder in ${order}: the kept ink with every stroke of either pane, the found ink in the trash whole, one claim, nothing owed`, async () => {
				const { v, x1, early, savedPaths } = await back("moved back as a delete and a create", { order });
				expect(claimersOnDisk(v, OTHER), "not one ink file claims the old name on disk, the kept ink").toEqual([early.id]);
				expect(claimersOnDisk(v, NEW), "an ink file still claims the new name on disk").toEqual([]);
				expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the kept ink does not hold every stroke of either pane").toEqual(["own", "pane2"]);
				foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
				expect(keptInTrash(v), "the kept ink went to the trash").toEqual([]);
				expect(savedPaths(), "a leave is still owed and saved").toEqual([]);
				expect(v.local.has(OWED_KEY), "the owed leaves' key is still saved").toBe(false);
				expect(await restartStrokes(v, order, OTHER), "after a restart the old name does not open on the kept ink with every stroke").toEqual({ id: early.id, strokes: ["own", "pane2"] });
			});
		}

		it(`bound 8, the floor: the copy moved back as a delete and a create past the new name's grace, ${roadName}, every write of the kept ink refused from the leave's run on: neither ink in the trash, both live with their strokes, the leave still owed`, async () => {
			const { v, x1, early, savedPaths } = await back("moved back as a delete and a create", { refuseKept: true });
			expect(v.trashInk().map((t) => [...t].sort()), "the found ink went to the trash short of the end").not.toContainEqual(["ink-0", "pane2"]);
			expect(keptInTrash(v), "the kept ink went to the trash short of the end").toEqual([]);
			expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "the found ink's file is not live with its strokes").toEqual(["ink-0", "pane2"]);
			expect(v.sidecar(early.id)?.strokes.map((x) => x.id), "the kept ink's file is not live with its stroke").toContain("own");
			expect(savedPaths().length, "the leave is not still owed and saved").toBe(1);
		});

		it(`bound 8, the floor: the copy moved back as a delete and a create past the new name's grace, ${roadName}, every write of the kept ink refused from the leave's run on: the leave left owed off the old name, both inks' claims at the owe saved at the old name with it`, async () => {
			const { v } = await back("moved back as a delete and a create", { refuseKept: true });
			const saved = JSON.parse((v.local.get(OWED_KEY) as string | undefined) ?? "[]") as { path: string; keptPaths?: string[]; foundPaths?: string[] }[];
			expect(saved.map((e) => e.path), "precondition: the leave is left owed and saved off the old name").toEqual([OTHER]);
			expect(
				saved.map((e) => ({ keptPaths: e.keptPaths, foundPaths: e.foundPaths })),
				"the claims at the owe saved with the leave did not move back to the old name with it"
			).toEqual([{ keptPaths: [OTHER], foundPaths: [OTHER] }]);
		});

		it(`bound 8, the copy deleted for real past the new name's grace, ${roadName}, no file of its bytes come since: every stroke of the copy in the trash, no ink file claiming either name, nothing owed`, async () => {
			const { v, x1 } = await back("deleted for real", {});
			expect(claimersOnDisk(v, OTHER), "an ink file claims the old name, where no file is").toEqual([]);
			expect(claimersOnDisk(v, NEW), "an ink file still claims the deleted name").toEqual([]);
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
			expect(keptInTrash(v).map((t) => [...t].sort()), "the kept ink is not in the trash whole, once").toEqual([["own", "pane2"]]);
			expect(
				liveInkFiles(v).filter((id) => v.sidecar(id)?.strokes.some((x) => x.id === "own" || x.id === "pane2") === true),
				"a live ink file still holds a stroke of the deleted copy"
			).toEqual([]);
			expect(v.local.has(OWED_KEY), "a leave is still owed for the deleted copy").toBe(false);
		});
	}

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
	 * The found ink's file as a later build on another device wrote it, synced in: one more stroke drawn on it since the
	 * owe ("later"), with a stroke key this build does not know and a tool it reads as its own pen, and the `extras`
	 * named: a top key, a stroke no page places, a key on the stroke it held at the owe, an attachments record.
	 */
	function laterFoundFile(v: ReturnType<typeof vault>, x1: string, extras: readonly FoundExtra[] = []): InkFile {
		const path = `.handwriting/${x1}.json`;
		const json = JSON.parse(v.adapter.files.get(path)!);
		const first = json.strokes[0];
		expect(first.id, "precondition: the found ink's file holds the stroke it held at the owe first").toBe("ink-0");
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
		return fileOf(v, x1);
	}

	/** The kept ink's file with its own top key and a key on its own stroke, as a later build wrote them. */
	function keptOwnExtras(v: ReturnType<typeof vault>, kept: string): InkFile {
		const path = `.handwriting/${kept}.json`;
		const json = JSON.parse(v.adapter.files.get(path)!);
		expect(json.strokes.map((x: { id: string }) => x.id), "precondition: the kept ink's file holds its own stroke only").toEqual(["own"]);
		json.zzKept = { from: "kept" };
		json.strokes[0].zzOwn = 4;
		v.adapter.externalWrite(path, JSON.stringify(json));
		return fileOf(v, kept);
	}

	/** At each carry into `kept`: the strokes it adds, the found ink's read entry for "later", and that stroke in memory. */
	function carriesInto(kept: string, x1: string) {
		const seen: { added: string[]; entry: unknown; zz: unknown; tool: string | undefined }[] = [];
		const carryInto = PdfInkStore.prototype.carryInto;
		vi.spyOn(PdfInkStore.prototype, "carryInto").mockImplementation(function (this: PdfInkStore, id: string, added: readonly InkStroke[], from: Parameters<PdfInkStore["carryInto"]>[2]) {
			if (id === kept) {
				const memory = this.strokes(x1).find((x) => x.id === "later");
				seen.push({
					added: added.map((x) => x.id).sort(),
					entry: this.carrySource(x1)?.unknownByObject["later"],
					zz: (memory as unknown as Record<string, unknown> | undefined)?.zz,
					tool: memory?.tool,
				});
			}
			return carryInto.call(this, id, added, from);
		} as never);
		return seen;
	}

	/** An ink file's text with the ids in `names` put as their names, longest id first, and the sha256 of the text. */
	async function bytesNamed(text: string, names: Record<string, string>) {
		let named = text;
		for (const id of Object.keys(names).sort((a, b) => b.length - a.length)) named = named.split(id).join(names[id]);
		const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");
		return { named, digest };
	}

	// Written red, before their cure: the strokes drawn on the found ink since the owe are carried with the stroke fields a
	// later build wrote on them, and with nothing else of the found ink's file.
	it("a leave owed at a quit, the found ink's file then synced in from a later build with a stroke drawn since the owe that holds a stroke key and a tool this build does not know, then a launch: the kept ink's file holds that stroke as the found ink's file wrote it", async () => {
		const { v, x1, early } = await quitOwedWithStroke();
		expect(savedLeaves(v).map((e) => e.had), "precondition: the leave saved what the found ink held at the owe").toEqual([["ink-0"]]);
		const found = laterFoundFile(v, x1);
		const seen = carriesInto(early.id, x1);
		await relaunchRun(v, "name order");
		vi.useRealTimers();
		expect(seen.map((c) => c.added), "precondition: one carry into the kept ink, of the strokes drawn since the owe").toEqual([["later", "pane2"]]);
		expect(seen[0]?.entry, "precondition: at the carry, the found ink's read holds the stroke's unknown entry").toEqual({ tool: "future-tool", zz: 1 });
		expect(seen[0]?.zz, "precondition: at the carry, the stroke in memory lacks the unknown key").toBeUndefined();
		expect(seen[0]?.tool, "precondition: at the carry, the stroke in memory holds this build's pen for the tool").toBe("pen");
		foundInTrashWhole(v, x1, ["ink-0", "later", "pane2"]);
		const kept = fileOf(v, early.id);
		expect(kept.strokes.map((x) => x.id).sort(), "the kept ink's file does not hold its own stroke and the two drawn since the owe").toEqual(["later", "own", "pane2"]);
		expect(strokeIn(kept, "later"), "the kept ink's file lost the stroke's later fields").toEqual(strokeIn(found, "later"));
	});

	it("a leave owed at a quit, the found ink's file then synced in from a later build with that stroke and more beside it (a top key, a stroke no page places, a key on the stroke it held at the owe, an attachments record), the kept ink's file holding its own top key and stroke key, then a launch: the kept ink's file holds its own fields and stroke as before and the carried strokes with their keys, nothing else of the found ink's", async () => {
		const { v, x1, early } = await quitOwedWithStroke();
		const found = laterFoundFile(v, x1, ["top", "pageless", "hadEntry", "attachments"]);
		const before = keptOwnExtras(v, early.id);
		await relaunchRun(v, "name order");
		vi.useRealTimers();
		foundInTrashWhole(v, x1, ["ink-0", "later", "pageless-found", "pane2"]);
		const kept = fileOf(v, early.id);
		expect(rest(kept), "the kept ink's other fields are not as before the carry").toEqual(rest(before));
		expect(kept.strokes.map((x) => x.id).sort(), "the kept ink's file does not hold its own stroke and the two drawn since the owe, only").toEqual(["later", "own", "pane2"]);
		expect(strokeIn(kept, "own"), "the kept ink's own stroke is not as its file wrote it").toEqual(strokeIn(before, "own"));
		expect(strokeIn(kept, "pane2"), "the stroke drawn here since the owe is not as the found ink's file wrote it").toEqual(strokeIn(found, "pane2"));
		expect(strokeIn(kept, "later"), "the carried stroke lost its later fields").toEqual(strokeIn(found, "later"));
	});

	// A pin: the bytes are those this road wrote before the stroke fields went with the carry, logged by that run.
	it("a leave owed at a quit, nothing a later build wrote in either ink file, then a launch: the kept ink's file is the same bytes this road wrote before", async () => {
		const { v, x1, early } = await quitOwedWithStroke();
		await relaunchRun(v, "name order");
		vi.useRealTimers();
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		const { named, digest } = await bytesNamed(v.adapter.files.get(`.handwriting/${early.id}.json`)!, { [early.id]: "<kept>", [x1]: "<found>" });
		console.info(`the kept ink's file, nothing unknown, the leave run at a launch: sha256 ${digest} bytes ${named}`);
		expect(named, "the kept ink's file is not the bytes this road wrote before").toBe(KEPT_AFTER_THE_LEAVE);
	});
});

/**
 * The copy deleted while its leave is owed, both inks of the leave claiming it, and the same bytes made again at a new
 * name (a sync tool's move as a delete and a create, or a real delete). Written red, before their cure, but the cells
 * marked as held at base (the rival's tie, the real delete, the third copy): those passed when written.
 */
describe("a leave owed with both its inks on the copy, the copy then deleted and its bytes made at a new name", () => {
	/** The new name: it scores the same against the copy's old name as against Inbox/A.pdf. */
	const Q = "Moved/A.pdf";
	const OWED = "handwriting-pdf-owed-leaves";

	/** The leaves saved as owed for the found ink from the kept ink: their paths. */
	function owedPaths(v: ReturnType<typeof vault>, x1: string, kept: string): string[] {
		const saved = JSON.parse((v.local.get(OWED) as string | undefined) ?? "[]") as { id: string; path: string; from: string }[];
		return saved.filter((e) => e.id === x1 && e.from === kept).map((e) => e.path);
	}

	/** The ink files in the trash now that were not before, each as its sorted stroke ids. */
	function trashSince(v: ReturnType<typeof vault>, before: readonly string[][]): string[][] {
		const left = before.map((t) => [...t].sort().join(","));
		const out: string[][] = [];
		for (const t of v.trashInk()) {
			const at = left.indexOf([...t].sort().join(","));
			if (at >= 0) left.splice(at, 1);
			else out.push([...t].sort());
		}
		return out;
	}

	/**
	 * The G cell's road (a stroke on the found ink, its move into the trash failing once at the let-go): the leave stays
	 * owed, both inks claim the copy, the kept ink holds both strokes. Then the kept ink's pane closed, as Obsidian closes
	 * the pane of a file it deletes.
	 */
	async function owedAfterFailedRemove(order: ListOrder) {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		listInOrder(next, order);
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		const fail = removeFailsOnce(next, x1);
		next.close(second.root);
		next.plugin.releasePdfId(secondAt);
		await settledPastFailure(next);
		expect(fail.failed, "precondition: the found ink's move into the trash failed").toBe(true);
		next.close(early.root);
		next.plugin.releasePdfId(early.id);
		await settledPastFailure(next);
		expect(owedPaths(v, x1, early.id), "precondition: the leave is owed off the copy").toEqual([OTHER]);
		expect(claimersOnDisk(v, OTHER).sort(), "precondition: both inks of the leave claim the copy").toEqual([x1, early.id].sort());
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "precondition: the kept ink holds both strokes").toEqual(["own", "pane2"]);
		return { v, next, x1, early, trash: v.trashInk() };
	}

	/**
	 * The I cell's road (the kept ink's file unreadable at the let-go, so the carry cannot land): the leave stays owed, the
	 * found ink holds "pane2" and the kept ink does not. The kept ink's file put back whole before anything else.
	 */
	async function owedAfterRefusedCarry(order: ListOrder) {
		const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
		listInOrder(next, order);
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		next.close(early.root);
		next.plugin.releasePdfId(early.id);
		await movesSettled(next);
		const keptPath = `.handwriting/${early.id}.json`;
		const keptBytes = v.adapter.files.get(keptPath);
		expect(keptBytes, "precondition: the kept ink's file is written").toBeDefined();
		v.adapter.files.set(keptPath, "{ not a page");
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await closeSecond(next, second, secondAt);
		await next.store.flush();
		v.adapter.files.set(keptPath, keptBytes as string);
		expect(v.sidecar(x1)?.strokes.map((x) => x.id), "precondition: the found ink holds the second pane's stroke").toEqual(["ink-0", "pane2"]);
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id), "precondition: the kept ink does not").toEqual(["own"]);
		expect(owedPaths(v, x1, early.id), "precondition: the leave is owed off the copy").toEqual([OTHER]);
		expect(claimersOnDisk(v, OTHER).sort(), "precondition: both inks of the leave claim the copy").toEqual([x1, early.id].sort());
		return { v, next, x1, early, trash: v.trashInk() };
	}

	/** The copy deleted, its bytes made at `at` (none: a real delete), every grace run out. */
	async function deletedThenMade(next: ReturnType<typeof session>, at: string | null, open?: (s: ReturnType<typeof session>) => Promise<void>) {
		await next.deleteFile(OTHER);
		expect(next.pdfStore.pendingClaims().has(OTHER), "precondition: the copy's deletion waits in its grace").toBe(true);
		if (at !== null) await next.createFile(at);
		if (open) await open(next);
		await settleGrace(next);
		await settledPastFailure(next);
	}

	/** The leave has run (the found ink in the trash whole) or is owed off `at`, the found ink live and claiming it. */
	function ranOrOwedAt(v: ReturnType<typeof vault>, x1: string, kept: string, at: string, found: readonly string[]) {
		if (v.sidecar(x1) === undefined) {
			foundInTrashWhole(v, x1, found);
			expect(owedPaths(v, x1, kept), "the found ink is in the trash and the leave is still owed").toEqual([]);
		} else {
			expect(v.sidecar(x1)?.pdfPaths, "the found ink is live and does not claim the new name only").toEqual([at]);
			expect(owedPaths(v, x1, kept), "the found ink is live and its leave is not owed off the new name").toEqual([at]);
		}
	}

	for (const order of ORDERS) {
		it(`the copy deleted while the leave is owed after a failed remove, the bytes made at a new name, the grace out, the ink folder in ${order}: the kept ink live on the new name with its strokes, no ink file in the trash but the found ink, nothing of the kept ink's in it`, async () => {
			const { v, next, x1, early, trash } = await owedAfterFailedRemove(order);
			await deletedThenMade(next, Q);
			vi.useRealTimers();
			expect(v.sidecar(early.id)?.pdfPaths, "the kept ink's file is not live claiming the new name").toEqual([Q]);
			expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the kept ink's file does not hold its strokes").toEqual(["own", "pane2"]);
			for (const t of trashSince(v, trash)) expect(t, "an ink file other than the found ink went to the trash").toEqual(["ink-0", "pane2"]);
			expect(v.trashInk().some((t) => t.includes("own")), "the kept ink's stroke is in the trash").toBe(false);
			ranOrOwedAt(v, x1, early.id, Q, ["ink-0", "pane2"]);
			expect(await restartStrokes(v, order, Q), "after a restart the new name does not open on the kept ink").toEqual({ id: early.id, strokes: ["own", "pane2"] });
		});

		it(`the copy deleted while the leave is owed after a refused carry, the bytes made at a new name, the grace out, then the found ink let go, the ink folder in ${order}: the second pane's stroke in the kept ink's live file, the found ink in the trash only after that`, async () => {
			const { v, next, x1, early, trash } = await owedAfterRefusedCarry(order);
			const atRemove: (string[] | undefined)[] = [];
			const remove = next.store.remove.bind(next.store);
			next.store.remove = (async (id: string, ...rest: unknown[]) => {
				if (id === x1) atRemove.push(v.sidecar(early.id)?.strokes.map((x) => x.id).sort());
				return (remove as (...a: unknown[]) => Promise<unknown>)(id, ...rest);
			}) as typeof next.store.remove;
			await deletedThenMade(next, Q);
			next.plugin.releasePdfId(x1);
			await settledPastFailure(next);
			vi.useRealTimers();
			expect(v.sidecar(early.id)?.pdfPaths, "the kept ink's file is not live claiming the new name").toEqual([Q]);
			expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the kept ink's live file does not hold the second pane's stroke").toEqual(["own", "pane2"]);
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
			expect(atRemove.length, "precondition: the found ink was removed").toBeGreaterThan(0);
			for (const held of atRemove) expect(held, "the found ink went to the trash before the kept ink's file held the second pane's stroke").toEqual(["own", "pane2"]);
			for (const t of trashSince(v, trash)) expect(t, "an ink file other than the found ink went to the trash").toEqual(["ink-0", "pane2"]);
		});

		it(`as the first with every move of the found ink into the trash failing from the delete on, the ink folder in ${order}: the kept ink live on the new name, the found ink live, the leave still owed`, async () => {
			const { v, next, x1, early } = await owedAfterFailedRemove(order);
			const fail = removeFailsOnce(next, x1, 1000);
			// Not deletedThenMade: a deletion that cannot end waits on, and its grace is run out here without waiting for it.
			await next.deleteFile(OTHER);
			await next.createFile(Q);
			await vi.advanceTimersByTimeAsync(10_001);
			// The retirement reads the new name's family off the fake clock (the PDF's digest): it is waited for in real time.
			await turnsWhile(() => next.pdfStore.pendingClaims().has(OTHER));
			await settledPastFailure(next);
			next.plugin.releasePdfId(x1);
			await settledPastFailure(next);
			vi.useRealTimers();
			expect(v.sidecar(early.id)?.pdfPaths, "the kept ink's file is not live claiming the new name").toEqual([Q]);
			expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the kept ink's file does not hold its strokes").toEqual(["own", "pane2"]);
			expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "the found ink's file is not live and whole").toEqual(["ink-0", "pane2"]);
			expect(v.sidecar(x1)?.pdfPaths, "the found ink is left claiming the deleted name, not the new one").toEqual([Q]);
			expect(owedPaths(v, x1, early.id), "the leave is not owed off the new name while the found ink cannot be removed").toEqual([Q]);
			expect(next.pdfStore.pendingClaims().has(OTHER), "the copy's deletion still waits, the found ink's failed remove deferring it").toBe(false);
			expect(fail.left, "precondition: nothing tried to remove the found ink after the delete").toBeLessThan(1000);
		});

		it(`as the first with the new name opened inside the grace, the ink folder in ${order}: the pane shows the kept ink, not a blank held for the copy; after the grace the new name opened again shows the kept ink`, async () => {
			const { v, next, early } = await owedAfterFailedRemove(order);
			let inGrace: { root: HTMLElement; id: string } | undefined;
			let held: boolean | undefined;
			await deletedThenMade(next, Q, async (s) => {
				inGrace = await s.open(Q);
				held = s.pdfStore.heldPaths().get(OTHER)?.has(Q) === true;
			});
			expect(inGrace?.id, "the new name opened inside the grace not on the kept ink").toBe(early.id);
			expect(next.pdfStore.strokes(inGrace!.id).map((x) => x.id).sort(), "the new name opened inside the grace without the kept ink's strokes").toEqual(["own", "pane2"]);
			expect(held, "the new name was held for the copy's deletion").toBe(false);
			next.close(inGrace!.root);
			next.plugin.releasePdfId(inGrace!.id);
			await settledPastFailure(next);
			const again = await next.open(Q);
			vi.useRealTimers();
			expect(again.id, "after the grace the new name opened again not on the kept ink").toBe(early.id);
			expect(v.sidecar(early.id)?.pdfPaths, "the kept ink's file is not live claiming the new name").toEqual([Q]);
		});

		it(`the new name opened inside the grace, then the found ink let go again before the grace ends, then the grace out, the ink folder in ${order}: the new name on the kept ink, the kept ink live`, async () => {
			const { v, next, x1, early } = await owedAfterFailedRemove(order);
			let inGrace: { root: HTMLElement; id: string } | undefined;
			await deletedThenMade(next, Q, async (s) => {
				inGrace = await s.open(Q);
				s.plugin.releasePdfId(x1);
				await settledPastFailure(s);
			});
			vi.useRealTimers();
			expect(next.plugin.pdfIds.get(inGrace!.root), "the pane on the new name is not on the kept ink").toBe(early.id);
			expect(v.sidecar(early.id)?.pdfPaths, "the kept ink's file is not live claiming the new name").toEqual([Q]);
			expect(v.trashInk().some((t) => t.includes("own")), "the kept ink's stroke is in the trash").toBe(false);
			expect(await restartStrokes(v, order, Q), "after a restart the new name does not open on the kept ink").toEqual({ id: early.id, strokes: ["own", "pane2"] });
		});

		it(`the copy deleted while the leave is owed after a refused carry, the bytes made at a new name, no open inside the grace, the ink folder in ${order}: after the grace the new name opens on the kept ink; after the leave's run, with the second pane's stroke`, async () => {
			const { v, next, x1, early } = await owedAfterRefusedCarry(order);
			await deletedThenMade(next, Q);
			const after = await next.open(Q);
			expect(after.id, "after the grace the new name opened not on the kept ink").toBe(early.id);
			expect(next.pdfStore.strokes(after.id).map((x) => x.id), "after the grace the new name opened without the kept ink's stroke").toContain("own");
			next.close(after.root);
			next.plugin.releasePdfId(after.id);
			next.plugin.releasePdfId(x1);
			await settledPastFailure(next);
			vi.useRealTimers();
			expect(await restartStrokes(v, order, Q), "after the leave's run the new name does not open on the kept ink with both strokes").toEqual({ id: early.id, strokes: ["own", "pane2"] });
		});

		it(`the copy deleted while the leave is owed after a refused carry, the bytes made at a new name, the grace out, then a launch, the ink folder in ${order}: the leave ran or is owed off the new name, never forgotten; after the launch it has run`, async () => {
			const { v, next, x1, early } = await owedAfterRefusedCarry(order);
			await deletedThenMade(next, Q);
			const live = v.sidecar(x1);
			if (live === undefined) {
				expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the found ink left before the kept ink held the second pane's stroke").toEqual(["own", "pane2"]);
			} else {
				expect(live.strokes.map((x) => x.id), "the found ink lost the second pane's stroke while owed").toEqual(["ink-0", "pane2"]);
				expect(owedPaths(v, x1, early.id), "the found ink holds the second pane's stroke and its leave is not owed off the new name").toEqual([Q]);
			}
			await quit(next);
			const { s } = await relaunchOpen(v, order, Q);
			vi.useRealTimers();
			await s.store.flush();
			expect(v.sidecar(early.id)?.pdfPaths, "after the launch the kept ink's file is not live claiming the new name").toEqual([Q]);
			expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "after the launch the kept ink's file does not hold the second pane's stroke").toEqual(["own", "pane2"]);
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
			expect(v.local.has(OWED), "after the launch a leave is still owed").toBe(false);
		});

		it(`held at base: as the first, then a third copy of the bytes made and opened before any launch, the ink folder in ${order}: it opens blank, on neither ink of the leave`, async () => {
			const { v, next, x1, early } = await owedAfterFailedRemove(order);
			await deletedThenMade(next, Q);
			await next.createFile("Other/A.pdf");
			// A fresh blank may be handed the id of an ink whose file left for the trash: only a live file is that ink.
			const live = { found: v.sidecar(x1) !== undefined, kept: v.sidecar(early.id) !== undefined };
			const third = await next.open("Other/A.pdf");
			vi.useRealTimers();
			expect(live.found && third.id === x1, "the third copy opened on the found ink's live file").toBe(false);
			expect(live.kept && third.id === early.id, "the third copy opened on the kept ink's live file").toBe(false);
			expect(next.pdfStore.strokes(third.id).map((x) => x.id), "the third copy opened wearing ink").toEqual([]);
		});

		it(`the new name opened inside the grace with every move of the found ink into the trash failing from the delete on, the grace out, then a third copy of the bytes made and opened, the ink folder in ${order}: the third copy opens blank, on neither ink of the leave; the found ink live on the new name, the leave owed there`, async () => {
			const { v, next, x1, early } = await owedAfterFailedRemove(order);
			// The found ink stays live, so where the open left its claim is read: the open adopts the kept ink, and the found
			// ink follows it there.
			const fail = removeFailsOnce(next, x1, 1000);
			// As the cells above with every move failing: the grace is run out here without waiting for the deletion.
			await next.deleteFile(OTHER);
			await next.createFile(Q);
			const inGrace = await next.open(Q);
			expect(inGrace.id, "precondition: the new name opened inside the grace on the kept ink").toBe(early.id);
			await vi.advanceTimersByTimeAsync(10_001);
			await turnsWhile(() => next.pdfStore.pendingClaims().has(OTHER));
			await settledPastFailure(next);
			await next.createFile("Other/A.pdf");
			// A fresh blank may be handed the id of an ink whose file left for the trash: only a live file is that ink.
			const live = { found: v.sidecar(x1) !== undefined, kept: v.sidecar(early.id) !== undefined };
			const third = await next.open("Other/A.pdf");
			vi.useRealTimers();
			expect(live.found && third.id === x1, "the third copy opened on the found ink's live file").toBe(false);
			expect(live.kept && third.id === early.id, "the third copy opened on the kept ink's live file").toBe(false);
			expect(next.pdfStore.strokes(third.id).map((x) => x.id), "the third copy opened wearing ink").toEqual([]);
			expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "the found ink's file is not live and whole").toEqual(["ink-0", "pane2"]);
			expect(v.sidecar(x1)?.pdfPaths, "the found ink is left claiming the deleted name, not the new one").toEqual([Q]);
			expect(owedPaths(v, x1, early.id), "the leave is not owed off the new name while the found ink cannot be removed").toEqual([Q]);
			expect(v.sidecar(early.id)?.pdfPaths, "the kept ink's file is not live claiming the new name").toEqual([Q]);
			expect(fail.left, "precondition: nothing tried to remove the found ink after the open").toBeLessThan(1000);
		});

		it(`the copy renamed while the leave is owed (both claims move, the F cell's road), then the found ink's move into the trash failing once at the let-go, then moved back as a delete of the new name and a create at the old one, the grace out, the ink folder in ${order}: as the first at the old name, the leave run or owed there`, async () => {
			const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
			listInOrder(next, order);
			next.draw(secondAt, stroke(61, "pane2"));
			await next.store.flush();
			await next.renameFile(OTHER, NEW);
			await movesSettled(next);
			expect(claimersOnDisk(v, NEW).sort(), "precondition: the rename moved both claims").toEqual([x1, early.id].sort());
			const fail = removeFailsOnce(next, x1);
			next.close(second.root);
			next.plugin.releasePdfId(secondAt);
			await settledPastFailure(next);
			expect(fail.failed, "precondition: the found ink's move into the trash failed").toBe(true);
			next.close(early.root);
			next.plugin.releasePdfId(early.id);
			await settledPastFailure(next);
			expect(claimersOnDisk(v, NEW).sort(), "precondition: both inks of the leave claim the new name").toEqual([x1, early.id].sort());
			expect(owedPaths(v, x1, early.id), "precondition: the leave followed the rename").toEqual([NEW]);
			const trash = v.trashInk();
			await next.deleteFile(NEW);
			await next.createFile(OTHER);
			await settleGrace(next);
			await settledPastFailure(next);
			vi.useRealTimers();
			expect(v.sidecar(early.id)?.pdfPaths, "the kept ink's file is not live claiming the old name").toEqual([OTHER]);
			for (const t of trashSince(v, trash)) expect(t, "an ink file other than the found ink went to the trash").toEqual(["ink-0", "pane2"]);
			ranOrOwedAt(v, x1, early.id, OTHER, ["ink-0", "pane2"]);
		});

		it(`held at base: a third copy with ink of its own, at a name that scores against the new name as the copy does, deleted inside the copy's grace, then the bytes made at the new name, the ink folder in ${order}: the kept ink and the found ink to the trash whole, the new name not on either`, async () => {
			const { v, next, x1, early, trash } = await owedAfterFailedRemove(order);
			const RIVAL = "Inbox/A.pdf";
			await next.createFile(RIVAL);
			const rival = await next.open(RIVAL);
			expect([x1, early.id], "precondition: the rival opened on its own ink").not.toContain(rival.id);
			next.draw(rival.id, stroke(62, "rival"));
			await next.store.flush();
			next.close(rival.root);
			next.plugin.releasePdfId(rival.id);
			await movesSettled(next);
			await next.deleteFile(OTHER);
			await next.deleteFile(RIVAL);
			await next.createFile(Q);
			await settleGrace(next);
			await settledPastFailure(next);
			vi.useRealTimers();
			expect(v.sidecar(early.id), "the kept ink's file is live, though a rival ties it on the new name").toBeUndefined();
			expect(trashSince(v, trash), "the kept ink and the found ink are not in the trash whole").toEqual(expect.arrayContaining([["own", "pane2"], ["ink-0", "pane2"]]));
			const opened = await restartStrokes(v, order, Q);
			expect([x1, early.id], "the new name opened on an ink of the leave").not.toContain(opened.id);
		});

		it(`the copy and a third copy with ink of its own deleted together while the leave is owed after a failed remove, every move of the found ink into the trash failing from the deletes on, the bytes made at two new names that each pair by name with one of them, the grace out, the ink folder in ${order}: the kept ink live on its new name with its strokes, the found ink live, the leave owed there`, async () => {
			const { v, next, x1, early, trash } = await owedAfterFailedRemove(order);
			// Two waiting claims of the family besides the found ink's, so the kept ink pairs by name: each new name shares
			// two trailing parts with one deleted name and one with the other.
			const RIVAL = "Inbox/A.pdf";
			const NEAR_OTHER = "Box/Archive/A.pdf";
			const NEAR_RIVAL = "Box/Inbox/A.pdf";
			await next.createFile(RIVAL);
			const rival = await next.open(RIVAL);
			expect([x1, early.id], "precondition: the rival opened on its own ink").not.toContain(rival.id);
			next.draw(rival.id, stroke(62, "rival"));
			await next.store.flush();
			next.close(rival.root);
			next.plugin.releasePdfId(rival.id);
			await movesSettled(next);
			// The found ink stays live, so where its leave is owed is read (a leave that runs at once ends the same wherever
			// it was owed).
			const fail = removeFailsOnce(next, x1, 1000);
			// As the cell above with every move failing: its grace is run out here without waiting for it.
			await next.deleteFile(OTHER);
			await next.deleteFile(RIVAL);
			await next.createFile(NEAR_OTHER);
			await next.createFile(NEAR_RIVAL);
			await vi.advanceTimersByTimeAsync(10_001);
			await turnsWhile(() => next.pdfStore.pendingClaims().has(OTHER) || next.pdfStore.pendingClaims().has(RIVAL));
			await settledPastFailure(next);
			next.plugin.releasePdfId(x1);
			await settledPastFailure(next);
			vi.useRealTimers();
			expect(v.sidecar(early.id)?.pdfPaths, "the kept ink's file is not live claiming its new name").toEqual([NEAR_OTHER]);
			expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the kept ink's file does not hold its strokes").toEqual(["own", "pane2"]);
			expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "the found ink's file is not live and whole").toEqual(["ink-0", "pane2"]);
			expect(v.sidecar(x1)?.pdfPaths, "the found ink does not claim the kept ink's new name only").toEqual([NEAR_OTHER]);
			expect(owedPaths(v, x1, early.id), "the leave is not owed off the kept ink's new name while the found ink cannot be removed").toEqual([NEAR_OTHER]);
			expect(trashSince(v, trash), "an ink file went to the trash").toEqual([]);
			expect(fail.left, "precondition: nothing tried to remove the found ink after the deletes").toBeLessThan(1000);
		});

		it(`held at base: the copy deleted while the leave is owed after a failed remove, the kept ink's file synced in as a newer version wrote it, the bytes made at a new name, the grace out, the ink folder in ${order}: the kept ink's file left as it was, the found ink not moved onto the new name alone`, async () => {
			const { v, next, x1, early, trash } = await owedAfterFailedRemove(order);
			// Its claim readable, the file only shown, never written: the kept ink's walk counts it and cannot move it. The
			// found ink's walk then counts both claims on the copy, as before the leave was owed.
			const keptPath = `.handwriting/${early.id}.json`;
			const page = JSON.parse(v.adapter.files.get(keptPath)!) as Record<string, unknown>;
			expect(page.pdfPaths, "precondition: the kept ink's file claims the copy").toEqual([OTHER]);
			const newer = JSON.stringify({ ...page, schemaVersion: READ_SCHEMA_VERSION + 1 });
			v.adapter.externalWrite(keptPath, newer);
			expect(parsePage(newer, early.id).futureVersion, "precondition: the kept ink's file is a newer version's").toBe(READ_SCHEMA_VERSION + 1);
			await deletedThenMade(next, Q);
			vi.useRealTimers();
			expect(v.adapter.files.get(keptPath), "the kept ink's file a newer version wrote was changed or removed").toBe(newer);
			expect(v.sidecar(x1)?.pdfPaths ?? [], "the found ink moved onto the new name alone, its kept ink left claiming the copy").not.toContain(Q);
			expect(v.trashInk().some((t) => t.includes("own")), "the kept ink's stroke is in the trash").toBe(false);
			for (const t of trashSince(v, trash)) expect(t, "an ink file other than the found ink went to the trash").toEqual(["ink-0", "pane2"]);
		});

		it(`held at base: the copy deleted for real while the leave is owed after a failed remove, no copy made, the ink folder in ${order}: both inks to the trash; after a launch nothing owed; a later copy opens blank`, async () => {
			const { v, next, x1, early } = await owedAfterFailedRemove(order);
			await deletedThenMade(next, null);
			expect(v.sidecar(early.id), "the kept ink's file is live after a real delete").toBeUndefined();
			expect(v.sidecar(x1), "the found ink's file is live after a real delete").toBeUndefined();
			await quit(next);
			const s = listInOrder(session(v, { pendingStore: true }), order);
			await settleGrace(s);
			await settledPastFailure(s);
			expect(v.local.has(OWED), "after the launch a leave is still owed").toBe(false);
			await s.createFile("Desk/A.pdf");
			// A fresh blank may be handed the id of an ink whose file left for the trash: only a live file is that ink.
			const live = [x1, early.id].filter((id) => v.sidecar(id) !== undefined);
			const later = await s.open("Desk/A.pdf");
			vi.useRealTimers();
			expect(live, "the later copy opened on a live ink file of the leave").not.toContain(later.id);
			expect(s.pdfStore.strokes(later.id).map((x) => x.id), "the later copy opened wearing ink").toEqual([]);
		});
	}
});

/** The kept ink's file after the leave's run at a launch with nothing unknown, as this road wrote it before, ids named. */
const KEPT_AFTER_THE_LEAVE =
	'{"schemaVersion":1,"pageId":"<kept>","surface":"pdf","coordSpace":"page-css@1","pdfPaths":["Archive/A.pdf"],"textBoxes":[],"images":[],"strokes":[{"id":"own","tool":"pen","color":"#111111","width":2,"createdAt":0,"page":1,"pts":[60,10,0.5,0,70,20,0.5,8]},{"id":"pane2","tool":"pen","color":"#111111","width":2,"createdAt":0,"page":1,"pts":[61,10,0.5,0,71,20,0.5,8]}]}';
