/**
 * K657-1: a PDF renamed while a pane holds its claim and a leave is owed off it. The leave's inks move their claims
 * late (moveClaimsOnce, after their record is read). A PDF made at the old name in that wait, inked and deleted: the
 * move landing does not end that later deletion. Its ink goes to the trash at its grace, and a copy of its bytes opens
 * blank; the leave's inks claim the new name, not the old, and the leave runs there. Cells: a (the made PDF of other
 * bytes), f (of the renamed copy's bytes), e (two renames in one read, the made PDF at the name between), c (a deletion
 * already waiting at the old name at the rename: as at base).
 *
 * Then the copy renamed where the leave is not held (another device), only one of its inks' claims moved there: the next
 * launch's leave run moves the other ink's claim late (movedLeave). A later PDF made at the old name, drawn on, on a
 * device the other ink's file has not reached yet, its delete heard here before the run: written red, before its cure.
 * The copy's own delete heard here before the run: pinned as it is. Either deletion's grace run out before the layout,
 * so before the run (Y2-2): the other ink follows its partner's name, and the leave runs there; its guards after.
 *
 * A defect candidate, pinned as it is: there, a PDF of other bytes made at the old name, opened where the other ink's
 * file is, opens with that ink's strokes, though the copy still lives at its new name.
 *
 * Through the plugin and the real stores, with an in-memory vault: the harness of PdfOwedLeave.test.ts, copied (its
 * helpers are not exported, and that file is not edited here), with one change: a path can hold other bytes (bytesAt).
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

/** Another document's bytes: another content family. */
const otherBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog /Other true >> endobj\n" + "y".repeat(6000) + "\n%%EOF\n");

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
	// Every PDF here holds the same bytes ("Make a copy" of one file), unless bytesAt names others for its path.
	const pdfBytes = new TextEncoder().encode(
		"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + "x".repeat(5000) + "\n%%EOF\n"
	);
	const bytesAt = new Map<string, Uint8Array>();
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
	/** The vault saves new bytes over the file (a new version, in place), then every modify handler the plugin registered runs. */
	async function changeFile(path: string, bytes: Uint8Array) {
		expect(v.files.has(path), `precondition: ${path} exists before the change`).toBe(true);
		v.bytesAt.set(path, bytes);
		for (const handler of vaultOn.get("modify") ?? []) await handler(pdfFile(path));
	}
	/** The vault moves the file (and its bytes), then every rename handler the plugin registered runs, and any claim move it started. */
	async function renameFile(from: string, to: string) {
		expect(v.files.has(from), `precondition: ${from} exists before the rename`).toBe(true);
		expect(vaultOn.get("rename")?.length, "precondition: the plugin listens for renames").toBeGreaterThan(0);
		v.files.delete(from);
		v.files.add(to);
		const bytes = v.bytesAt.get(from);
		v.bytesAt.delete(from);
		if (bytes) v.bytesAt.set(to, bytes);
		else v.bytesAt.delete(to);
		for (const leaf of leaves) if (leaf.view.file.path === from) leaf.view.file = { path: to };
		for (const handler of vaultOn.get("rename") ?? []) await handler(pdfFile(to), from);
		await Promise.all(moves.splice(0));
	}
	return { store, pdfStore, plugin, open, close, draw, deleteFile, createFile, changeFile, renameFile, checked };
}

type Session = ReturnType<typeof session>;
type Vault = ReturnType<typeof vault>;

/** One session with one inked PDF per path, each closed again. */
async function inked<const P extends readonly string[]>(v: Vault, paths: P, opts: { layoutReady?: boolean; pendingStore?: boolean } = {}) {
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
async function settleGrace(s: Session) {
	await vi.advanceTimersByTimeAsync(10_001);
	await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
	await s.store.flush();
}

/** The real timer, taken before any cell fakes the clock. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

/**
 * Fake-clock turns of 0 ms while `waiting` holds, a real pause of 1 ms after each turn it still holds: work that
 * resolves off the fake clock (the PDF's digest) lands in real time. Up to `most` turns; the caller checks what it
 * needs after.
 */
async function turnsWhile(waiting: () => boolean, most = 1000): Promise<void> {
	for (let i = 0; i < most && waiting(); i++) {
		await vi.advanceTimersByTimeAsync(0);
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
const OWED_KEY = "handwriting-pdf-owed-leaves";
/** TIED's new name, given in Obsidian: it pairs nothing by name. */
const MOVED = "Inbox/A2.pdf";
/** The copy's name after a rename while the leave is owed: it pairs nothing by name. */
const NEW = "Archive/A3.pdf";
/** The copy's name after a second rename, inside one read of the found ink. */
const NEWER = "Archive/A4.pdf";
/** A path a copy of the made PDF's bytes is saved at, after everything. */
const COPY = "Elsewhere/Copy.pdf";
/** Another document's path, deleted before the copy is renamed onto it (cell c). */
const ONTO = "Archive/B.pdf";

/** Both deleted in one grace (FIRST then SECOND), then the two copies arrive. */
async function deleteBothThenCopies(s: Session) {
	await s.deleteFile(FIRST);
	await vi.advanceTimersByTimeAsync(500);
	await s.deleteFile(SECOND);
	const waiting = s.pdfStore.pendingClaims();
	expect(waiting.has(FIRST) && waiting.has(SECOND), "precondition: both deletions wait out their grace").toBe(true);
	await s.createFile(TIED);
	await s.createFile(OTHER);
}

/** TIED opens blank and is held for every waiting deletion; its pane stays open. */
async function openTied(s: Session, deleted: readonly string[]) {
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
function claimersAmong(v: Vault, ids: readonly string[], path: string) {
	return ids.filter((id) => v.sidecar(id)?.pdfPaths?.includes(path));
}

/** Every live ink file's id: in an ink folder, not in the trash. */
function liveInkFiles(v: Vault): string[] {
	return [...v.adapter.files.keys()]
		.filter((p) => p.startsWith(".handwriting/") && p.endsWith(".json") && !p.includes("/trash/"))
		.map((p) => (p.split("/").pop() as string).slice(0, -".json".length))
		.filter((id) => id.startsWith("pdf-"))
		.sort();
}

/** Every live ink file that claims `path` on disk, named or not (a file that does not parse claims nothing here). */
function claimersOnDisk(v: Vault, path: string) {
	return liveInkFiles(v).filter((id) => {
		try {
			return v.sidecar(id)?.pdfPaths?.includes(path) === true;
		} catch {
			return false;
		}
	});
}

/** The next session, both deletions restored in their grace. */
function nextSession(v: Vault, afterLayout?: (start: () => void) => void) {
	const next = session(v, { pendingStore: true, ...(afterLayout ? { afterLayout } : {}) });
	const waiting = next.pdfStore.pendingClaims();
	expect(waiting.has(FIRST) && waiting.has(SECOND), "precondition: both deletions resumed").toBe(true);
	return next;
}

/**
 * The tied copy renamed in Obsidian (the hold follows it), then a quit inside the grace; at the next launch the vault
 * does not list the renamed copy yet. Returns the next session, its layout not ready (call `layoutReady` for that).
 */
async function renamedThenRelaunchedUnlisted() {
	const { v, s: first, x1, x2 } = await tiedSetup({ pendingStore: true });
	await first.renameFile(TIED, MOVED);
	first.pdfStore.cancelPendingDeletes();
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

/** Each check that identifies a pane again settles and ends, and what it starts. */
async function movesSettled(s: Session) {
	await vi.advanceTimersByTimeAsync(3_001);
	await s.checked();
	await s.pdfStore.settle();
	await s.store.flush();
}

/**
 * The setup of PdfOwedLeave.test.ts's owedLeave({ settle: true }): the other copy opened before the vault lists every
 * file (pane 1, on a blank), then after the layout is ready in a second pane, on the first deleted ink; a stroke on
 * pane 1 before it moves. The second pane still shows the first deleted ink, so its leave of the copy is owed. Every
 * grace run out.
 */
async function owedLeave() {
	const { v, next, x1, layoutReady } = await renamedThenRelaunchedUnlisted();
	const early = await next.open(OTHER);
	layoutReady();
	const second = await next.open(OTHER);
	expect(second.id, "precondition: the second pane opened on the first deleted ink").toBe(x1);
	expect(next.plugin.pdfIds.get(early.root), "precondition: the first pane is still on its blank").toBe(early.id);
	next.draw(early.id, stroke(60, "own"));
	await next.store.flush();
	await vi.advanceTimersByTimeAsync(1_001);
	await next.checked();
	await settleGrace(next);
	await movesSettled(next);
	const secondAt = next.plugin.pdfIds.get(second.root) as string;
	expect(secondAt, "precondition: the second pane still shows the first deleted ink").toBe(x1);
	expect(next.pdfStore.strokes(secondAt).map((x) => x.id), "precondition: the second pane shows the first deleted ink").toEqual(["ink-0"]);
	expect(next.pdfStore.strokes(early.id).map((x) => x.id), "precondition: the first pane shows its stroke").toEqual(["own"]);
	return { v, next, x1, early, second, secondAt };
}

/** The second pane closed as the workspace closes a pane: it leaves the plugin's panes, and its id is released. */
async function closeSecond(next: Session, second: { root: HTMLElement }, secondAt: string) {
	next.close(second.root);
	next.plugin.releasePdfId(secondAt);
	await movesSettled(next);
	await movesSettled(next);
}

/** The ink a later session opens the path with, the ink folder in plain name order. */
async function restartStrokes(v: Vault, path: string) {
	const later = session(v);
	const list = later.store.listIds.bind(later.store);
	later.store.listIds = (async (prefix: string) =>
		[...(await list(prefix))].sort((a, b) => (`${a}.json` < `${b}.json` ? -1 : `${a}.json` > `${b}.json` ? 1 : 0))) as typeof later.store.listIds;
	const opened = await later.open(path);
	return { id: opened.id, strokes: later.pdfStore.strokes(opened.id).map((x) => x.id).sort() };
}

/** The found ink, as it was at the let-go, is in the trash whole and no longer live. */
function foundInTrashWhole(v: Vault, x1: string, strokes: readonly string[]) {
	expect(v.sidecar(x1), "the found ink's file is still live").toBeUndefined();
	expect(v.trashInk().map((t) => [...t].sort()), "the found ink is not in the trash whole").toContainEqual([...strokes].sort());
}

/** Every claim move the store makes for `id`, as [from, to], in order (renamePath, which runs unchanged). */
function claimMovesOf(s: Session, id: string): [string, string][] {
	const seen: [string, string][] = [];
	const renamePath = s.pdfStore.renamePath.bind(s.pdfStore);
	s.pdfStore.renamePath = ((i: string, from: string, to: string, ...rest: unknown[]) => {
		if (i === id) seen.push([from, to]);
		return (renamePath as (...a: unknown[]) => void)(i, from, to, ...rest);
	}) as typeof s.pdfStore.renamePath;
	return seen;
}

/** The found ink's own read of its file (the store's load) held once, from now on, until `release`. */
function holdFoundRead(next: Session, x1: string) {
	const load = next.store.load.bind(next.store);
	/** `stack`: where the held read was asked, to tell which await of the claim move it holds. */
	const gate = { held: false, stack: "", release: (): void => {} };
	const loadGate = new Promise<void>((done) => (gate.release = done));
	next.store.load = (async (id: string, ...rest: unknown[]) => {
		if (id === x1 && !gate.held) {
			gate.held = true;
			gate.stack = new Error().stack ?? "";
			await loadGate;
		}
		return (load as (...a: unknown[]) => Promise<unknown>)(id, ...rest);
	}) as typeof next.store.load;
	return gate;
}

/**
 * The claim move's own read of the found ink's claims off disk (readPdfPaths, asked from moveClaimsOnce) held once,
 * from now on, until `release`. Any other read of that file (a retirement's, a load) goes on.
 */
function holdFoundPathsRead(next: Session, x1: string) {
	const readPdfPaths = next.store.readPdfPaths.bind(next.store);
	const gate = { held: false, release: (): void => {} };
	const readGate = new Promise<void>((done) => (gate.release = done));
	next.store.readPdfPaths = (async (id: string, ...rest: unknown[]) => {
		if (id === x1 && !gate.held && /\bmoveClaimsOnce\b/.test(new Error().stack ?? "")) {
			gate.held = true;
			await readGate;
		}
		return (readPdfPaths as (...a: unknown[]) => Promise<unknown>)(id, ...rest);
	}) as typeof next.store.readPdfPaths;
	return gate;
}

/**
 * The leave owed off the copy with the first pane (the kept ink) open on it and a stroke in the second pane since the
 * owe: the leave's run at the second pane's close cannot write the kept ink (its flush fails `fails` times), so it ends
 * owed, and the found ink's record is let go.
 */
async function owedWithKeptPaneOpen(fails = 1) {
	const { v, next, x1, early, second, secondAt } = await owedLeave();
	next.draw(secondAt, stroke(61, "pane2"));
	await next.store.flush();
	const flushPage = next.store.flushPage.bind(next.store);
	const failed = { left: fails };
	next.store.flushPage = (async (id: string, ...rest: unknown[]) => {
		if (id === early.id && failed.left > 0) {
			failed.left--;
			return false;
		}
		return (flushPage as (...a: unknown[]) => Promise<boolean>)(id, ...rest);
	}) as typeof next.store.flushPage;
	await closeSecond(next, second, secondAt);
	expect(failed.left, "precondition: the leave's run tried to write the kept ink, and that write failed").toBe(fails - 1);
	expect(next.plugin.pdfLeaving(x1), "precondition: no leave run is going").toBe(false);
	expect(savedPaths(v), "precondition: the leave is still owed, off the copy").toEqual([OTHER]);
	expect(claimersAmong(v, [x1], OTHER), "precondition: the found ink still claims the copy").toEqual([x1]);
	expect(next.pdfStore.generation(x1), "precondition: the found ink's record is forgotten").toBeNull();
	return { v, next, x1, early, failed };
}

/** The paths the owed leaves are saved off. */
function savedPaths(v: Vault): string[] {
	return (JSON.parse((v.local.get(OWED_KEY) as string | undefined) ?? "[]") as { path: string }[]).map((e) => e.path);
}

/** A PDF made at `path` (its bytes `bytes`, or the copies' when none), opened, drawn on, closed and let go, then deleted. */
async function madeInkedDeleted(v: Vault, next: Session, path: string, bytes: Uint8Array | undefined) {
	if (bytes) v.bytesAt.set(path, bytes);
	else v.bytesAt.delete(path);
	await next.createFile(path);
	const made = await next.open(path);
	next.draw(made.id, stroke(70, "made"));
	await next.store.flush();
	next.close(made.root);
	next.plugin.releasePdfId(made.id);
	await next.store.flush();
	await next.deleteFile(path);
	const token = next.pdfStore.deletionAt(path);
	expect(token, `precondition: the deletion of ${path} waits in its grace`).toBeDefined();
	return { made, token };
}

/** Every grace run out and every check and wait settled, three times over; then the clock real again. */
async function runOut(next: Session) {
	await settleGrace(next);
	for (let i = 0; i < 3; i++) await movesSettled(next);
	vi.useRealTimers();
}

/** The ink a later session opens a copy of `bytes` with, saved at a path never used before. */
async function copyOpens(v: Vault, bytes: Uint8Array) {
	v.bytesAt.set(COPY, bytes);
	v.files.add(COPY);
	const s = session(v);
	const o = await s.open(COPY);
	return s.pdfStore.strokes(o.id).map((x) => x.id);
}

/** Every pairing the store makes from now on (inkPairedOnto, the plugin's moveBlankPanes), as [path, id], in order. */
function pairingsOf(s: Session): [string, string][] {
	const seen: [string, string][] = [];
	const pair = s.plugin.moveBlankPanes.bind(s.plugin) as (...a: unknown[]) => unknown;
	s.plugin.moveBlankPanes = (path: string, id: string, ...rest: unknown[]) => {
		seen.push([path, id]);
		return pair(path, id, ...rest);
	};
	return seen;
}

/** The notice said when ink is carried over to a PDF's new version (PdfClaims carryInk). */
const CARRIED = "Handwriting: this PDF changed on disk. Your ink was carried over to its new version.";
/** A third document's bytes: a third content family. */
const thirdBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog /Third true >> endobj\n" + "z".repeat(7000) + "\n%%EOF\n");
/** A PDF of its own (the third bytes), inked and closed, that a new version is saved over (cell o). */
const SAVED_OVER = "Work/Q.pdf";

/** The ids of the strokes in a live ink file, sorted; [] for none or no file. */
function inkOf(v: Vault, id: string): string[] {
	return (v.sidecar(id)?.strokes ?? []).map((x) => x.id).sort();
}

describe("a PDF renamed while a pane holds its claim and a leave is owed off it, a PDF made at the old name, inked and deleted while the leave's claim move waits", () => {
	it("a: the made PDF of other bytes: the move landing leaves its deletion waiting, the same one; its ink goes to the trash at its grace and a copy of its bytes opens blank; the leave runs on the new name, the new name claimed by the kept ink only, the old name by none", async () => {
		const { v, next, x1, early } = await owedWithKeptPaneOpen();
		const moved = claimMovesOf(next, x1);
		const read = holdFoundRead(next, x1);
		await next.renameFile(OTHER, NEW);
		await turnsWhile(() => !read.held);
		expect(read.held, "precondition: the claim move's read of the found ink's file is held").toBe(true);
		expect(next.plugin.pdfPaneHoldsClaim(NEW), "precondition: a pane holds the new name's claim").toBe(true);
		expect(next.pdfStore.deletionAt(OTHER), "precondition: no deletion waits at the old name at the rename").toBeUndefined();
		expect(savedPaths(v), "precondition: the owed leave followed the rename at once").toEqual([NEW]);
		// R2 B2: the held read is the claim move's last await before its call (readied, after readPdfPaths), and the
		// made PDF is made, inked and deleted strictly inside it.
		const order = ["read held"];
		const heldInReadied = /\breadied\b/.test(read.stack);
		const { made, token } = await madeInkedDeleted(v, next, OTHER, otherBytes);
		order.push("made, inked, deleted");
		expect([x1, early.id], "precondition: the made PDF has its own ink").not.toContain(made.id);
		expect(v.sidecar(made.id)?.pdfPaths, "precondition: the made PDF's ink claims the old name").toEqual([OTHER]);
		expect(moved, "precondition: the found ink's claim move still waits").toEqual([]);
		read.release();
		order.push("released");
		await turnsWhile(() => moved.length === 0);
		order.push("moved");
		console.log(`K657-1 B2 a: order ${order.join(" > ")}; held in readied ${heldInReadied}`);
		expect({ order, heldInReadied }, "precondition: the made PDF was made, inked and deleted inside the held read, the claim move's last await").toEqual({
			order: ["read held", "made, inked, deleted", "released", "moved"],
			heldInReadied: true,
		});
		expect(moved, "precondition: the found ink's claim move landed").toEqual([[OTHER, NEW]]);
		const sameDeletion = next.pdfStore.deletionAt(OTHER) === token;
		await runOut(next);
		const end = {
			sameDeletion,
			madeLive: v.adapter.files.has(`.handwriting/${made.id}.json`),
			madeClaims: v.sidecar(made.id)?.pdfPaths ?? [],
			madeInTrash: v.trashInk().some((t) => t.includes("made")),
			newClaimers: claimersOnDisk(v, NEW),
			oldClaimers: claimersOnDisk(v, OTHER),
			kept: v.sidecar(early.id)?.strokes.map((x) => x.id).sort(),
			owed: v.local.has(OWED_KEY),
		};
		const copy = await copyOpens(v, otherBytes);
		const renamed = await restartStrokes(v, NEW);
		expect(
			{ ...end, copy, renamed },
			"the move ended the made PDF's deletion, or its ink stayed live, or a copy of its bytes opened on it, or the leave's inks did not end on the new name"
		).toEqual({
			sameDeletion: true,
			madeLive: false,
			madeClaims: [],
			madeInTrash: true,
			newClaimers: [early.id],
			oldClaimers: [],
			kept: ["own", "pane2"],
			owed: false,
			copy: [],
			renamed: { id: early.id, strokes: ["own", "pane2"] },
		});
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
	});

	it("f: the made PDF of the renamed copy's bytes: the move landing leaves its deletion waiting, the same one; the leave runs on the new name, the new name claimed by the kept ink only, the old name by none, no stroke lost", async () => {
		const { v, next, x1, early } = await owedWithKeptPaneOpen();
		const moved = claimMovesOf(next, x1);
		const read = holdFoundRead(next, x1);
		await next.renameFile(OTHER, NEW);
		await turnsWhile(() => !read.held);
		expect(read.held, "precondition: the claim move's read of the found ink's file is held").toBe(true);
		expect(next.pdfStore.deletionAt(OTHER), "precondition: no deletion waits at the old name at the rename").toBeUndefined();
		const { made, token } = await madeInkedDeleted(v, next, OTHER, undefined);
		expect(moved, "precondition: the found ink's claim move still waits").toEqual([]);
		read.release();
		await turnsWhile(() => !moved.some(([from]) => from === OTHER));
		expect(moved.filter(([from]) => from === OTHER), "precondition: the found ink's claim move landed").toEqual([[OTHER, NEW]]);
		const sameDeletion = next.pdfStore.deletionAt(OTHER) === token;
		// R2 B3: the made PDF's deletion, left to its grace, retires at the old name, a road the base never ran (it ended
		// that deletion). That retirement pairs nothing onto the new name and moves no claim there; the renamed copy's pane
		// keeps its id, the kept ink its claim, and no leave goes back to the old name.
		await movesSettled(next);
		const madeOn = made.id === x1 ? "found" : made.id === early.id ? "kept" : "own";
		const beforeGrace = { pane: next.plugin.pdfIds.get(early.root), keptClaims: v.sidecar(early.id)?.pdfPaths, saved: savedPaths(v) };
		console.log(`K657-1 B3 f: the made PDF of the renamed copy's bytes opened on the ${madeOn} ink (${made.id}); before its grace ${JSON.stringify(beforeGrace)}`);
		const paired = pairingsOf(next);
		const ontoNew: string[] = [];
		const renamePath = next.pdfStore.renamePath.bind(next.pdfStore) as (...a: unknown[]) => void;
		next.pdfStore.renamePath = ((i: string, from: string, to: string, ...rest: unknown[]) => {
			if (to === NEW) ontoNew.push(`${i}: ${from}`);
			return renamePath(i, from, to, ...rest);
		}) as typeof next.pdfStore.renamePath;
		await settleGrace(next);
		const grace = {
			pairedOntoNew: paired.filter(([p]) => p === NEW),
			movedOntoNew: ontoNew,
			pane: next.plugin.pdfIds.get(early.root),
			keptClaims: v.sidecar(early.id)?.pdfPaths,
			saved: savedPaths(v),
		};
		console.log(`K657-1 B3 f: at the grace ${JSON.stringify(grace)}`);
		expect(grace, "the made PDF's retirement at the old name paired ink onto the new name, moved a claim there, changed the renamed copy's pane or the kept ink's claim, or moved the leave").toEqual({
			pairedOntoNew: [],
			movedOntoNew: [],
			pane: early.id,
			keptClaims: [NEW],
			saved: beforeGrace.saved.filter((p) => p !== OTHER),
		});
		await runOut(next);
		const end = {
			sameDeletion,
			// Of the renamed copy's bytes, the made PDF opens on the found ink, which still claims the old name: the same document.
			madeOn,
			newClaimers: claimersOnDisk(v, NEW),
			oldClaimers: claimersOnDisk(v, OTHER),
			kept: v.sidecar(early.id)?.strokes.map((x) => x.id).sort(),
			owed: v.local.has(OWED_KEY),
		};
		expect(end, "the move ended the deletion of the PDF made at the old name, or the leave's inks did not end on the new name only, or a stroke was lost").toEqual({
			sameDeletion: true,
			madeOn: "found",
			newClaimers: [early.id],
			oldClaimers: [],
			kept: ["made", "own", "pane2"],
			owed: false,
		});
		foundInTrashWhole(v, x1, ["ink-0", "made", "pane2"]);
	});

	it("e (the token taken at the rename): two renames in one read of the found ink, the PDF made at the name between, inked and deleted: the second move leaves that deletion waiting, the same one; its ink goes to the trash at its grace; the leave runs on the last name", async () => {
		const { v, next, x1, early } = await owedWithKeptPaneOpen();
		const moved = claimMovesOf(next, x1);
		const read = holdFoundRead(next, x1);
		await next.renameFile(OTHER, NEW);
		await turnsWhile(() => !read.held);
		expect(read.held, "precondition: the first claim move's read of the found ink's file is held").toBe(true);
		await next.renameFile(NEW, NEWER);
		expect(savedPaths(v), "precondition: the owed leave followed both renames at once").toEqual([NEWER]);
		expect(next.pdfStore.deletionAt(NEW), "precondition: no deletion waits at the name between at the second rename").toBeUndefined();
		const { made, token } = await madeInkedDeleted(v, next, NEW, otherBytes);
		expect(moved, "precondition: the found ink's claim moves still wait").toEqual([]);
		read.release();
		await turnsWhile(() => moved.length < 2);
		expect(moved, "precondition: both claim moves of the found ink landed, in rename order").toEqual([
			[OTHER, NEW],
			[NEW, NEWER],
		]);
		const sameDeletion = next.pdfStore.deletionAt(NEW) === token;
		await runOut(next);
		const end = {
			sameDeletion,
			madeLive: v.adapter.files.has(`.handwriting/${made.id}.json`),
			madeInTrash: v.trashInk().some((t) => t.includes("made")),
			lastClaimers: claimersOnDisk(v, NEWER),
			betweenClaimers: claimersOnDisk(v, NEW),
			oldClaimers: claimersOnDisk(v, OTHER),
			kept: v.sidecar(early.id)?.strokes.map((x) => x.id).sort(),
			owed: v.local.has(OWED_KEY),
		};
		const copy = await copyOpens(v, otherBytes);
		expect(
			{ ...end, copy },
			"the second move ended the made PDF's deletion, or its ink stayed live, or a copy of its bytes opened on it, or the leave's inks did not end on the last name"
		).toEqual({
			sameDeletion: true,
			madeLive: false,
			madeInTrash: true,
			lastClaimers: [early.id],
			betweenClaimers: [],
			oldClaimers: [],
			kept: ["own", "pane2"],
			owed: false,
			copy: [],
		});
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
	});

	it("c: a deletion already waiting at the old name at the rename (the copy renamed onto a deleted PDF's name in its grace, then on): the late move ends it as at base, the found ink taken off the ids that came with the copy, the deletion waiting on; the deleted PDF's ink goes to the trash at its grace; the leave runs on the new name", async () => {
		const { v, next, x1, early } = await owedWithKeptPaneOpen(2);
		const moved = claimMovesOf(next, x1);
		// Another document at ONTO, inked and deleted: its deletion waits, the copy standing at its delete.
		const { made: gone, token } = await madeInkedDeleted(v, next, ONTO, otherBytes);
		// The copy renamed onto ONTO in that grace: it comes with the kept ink and, once its claim move lands, the found ink.
		await next.renameFile(OTHER, ONTO);
		await turnsWhile(() => moved.length === 0);
		expect(moved, "precondition: the found ink's first claim move landed").toEqual([[OTHER, ONTO]]);
		await movesSettled(next);
		expect(savedPaths(v), "precondition: the leave is still owed, off the deleted PDF's name").toEqual([ONTO]);
		expect(next.pdfStore.generation(x1), "precondition: the found ink's record is forgotten").toBeNull();
		expect([...(next.pdfStore.arrivedAt(ONTO) ?? [])].sort(), "precondition: both inks came with the copy").toEqual([early.id, x1].sort());
		const read = holdFoundRead(next, x1);
		await next.renameFile(ONTO, NEW);
		await turnsWhile(() => !read.held);
		expect(read.held, "precondition: the second claim move's read of the found ink's file is held").toBe(true);
		expect(next.pdfStore.deletionAt(ONTO), "precondition: the deletion still waits at the old name at the rename, the same one").toBe(token);
		read.release();
		await turnsWhile(() => moved.length < 2);
		expect(moved, "precondition: the found ink's second claim move landed").toEqual([
			[OTHER, ONTO],
			[ONTO, NEW],
		]);
		const atMove = { sameDeletion: next.pdfStore.deletionAt(ONTO) === token, arrived: [...(next.pdfStore.arrivedAt(ONTO) ?? [])] };
		await runOut(next);
		const end = {
			...atMove,
			goneLive: v.adapter.files.has(`.handwriting/${gone.id}.json`),
			goneInTrash: v.trashInk().some((t) => t.includes("made")),
			newClaimers: claimersOnDisk(v, NEW),
			oldClaimers: claimersOnDisk(v, ONTO),
			firstClaimers: claimersOnDisk(v, OTHER),
			kept: v.sidecar(early.id)?.strokes.map((x) => x.id).sort(),
			owed: v.local.has(OWED_KEY),
		};
		expect(end, "the late move did not end the deletion waiting at the old name at the rename as at base, or the leave's inks did not end on the new name").toEqual({
			sameDeletion: true,
			arrived: [],
			goneLive: false,
			goneInTrash: true,
			newClaimers: [early.id],
			oldClaimers: [],
			firstClaimers: [],
			kept: ["own", "pane2"],
			owed: false,
		});
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
	});
});

describe("the owed leave's claim move counts while it waits, as a no-pane move does", () => {
	it("h (B5): the found ink's read held past the grace, a PDF of other bytes made, inked and deleted at the old name inside the hold: its retirement drops no claim of the leave's inks, trashes none, pairs none, and its own ink retires; the move lands, the strokes drawn since the owe reach the kept ink, the new name claimed by the kept ink only", async () => {
		const { v, next, x1, early } = await owedWithKeptPaneOpen();
		const moved = claimMovesOf(next, x1);
		const keptMoved = claimMovesOf(next, early.id);
		// The move's read of the found ink's claims off disk is held, not its record's read: a retirement waits out a
		// record read already running (ensureLoaded), so a held record read holds the retirement too (run a0833bda).
		const read = holdFoundPathsRead(next, x1);
		await next.renameFile(OTHER, NEW);
		await turnsWhile(() => !read.held);
		expect(read.held, "precondition: the claim move's read of the found ink's claims is held").toBe(true);
		expect(next.pdfStore.deletionAt(OTHER), "precondition: no deletion waits at the old name at the rename").toBeUndefined();
		expect(keptMoved, "precondition: the kept ink's claim moved at the rename, its pane's own id").toEqual([[OTHER, NEW]]);
		const { made } = await madeInkedDeleted(v, next, OTHER, otherBytes);
		expect([x1, early.id], "precondition: the made PDF has its own ink").not.toContain(made.id);
		const paired = pairingsOf(next);
		// The made PDF's grace runs out inside the hold.
		await vi.advanceTimersByTimeAsync(10_001);
		await turnsWhile(() => next.pdfStore.pendingClaims().has(OTHER), 300);
		await next.store.flush();
		const leaveInk = ([, id]: [string, string]) => id === x1 || id === early.id;
		const inHold = {
			retired: !next.pdfStore.pendingClaims().has(OTHER),
			moved: [...moved],
			foundLive: v.sidecar(x1) !== undefined,
			foundClaims: v.sidecar(x1)?.pdfPaths ?? [],
			keptLive: v.sidecar(early.id) !== undefined,
			keptClaims: v.sidecar(early.id)?.pdfPaths ?? [],
			pairedLeaveInk: paired.filter(leaveInk),
			madeLive: v.adapter.files.has(`.handwriting/${made.id}.json`),
		};
		console.log(`K657-1 B5 h: in the hold, past the grace ${JSON.stringify(inHold)}`);
		read.release();
		// A found ink taken off the old name in the hold has no move to land: a short wait, then the cell's own check.
		await turnsWhile(() => moved.length === 0, 200);
		await runOut(next);
		const end = {
			inHold,
			moved: [...moved],
			keptMoved: [...keptMoved],
			pairedLeaveInk: paired.filter(leaveInk),
			madeLive: v.adapter.files.has(`.handwriting/${made.id}.json`),
			madeInTrash: v.trashInk().some((t) => t.includes("made")),
			newClaimers: claimersOnDisk(v, NEW),
			oldClaimers: claimersOnDisk(v, OTHER),
			kept: inkOf(v, early.id),
			owed: v.local.has(OWED_KEY),
		};
		console.log(`K657-1 B5 h: end ${JSON.stringify(end)}`);
		expect(
			end,
			"the made PDF's retirement at the old name took a claim of the leave's inks, trashed one or paired one, or its own ink did not retire, or the strokes drawn since the owe did not reach the kept ink on the new name"
		).toEqual({
			inHold: {
				retired: true,
				moved: [],
				foundLive: true,
				foundClaims: [OTHER],
				keptLive: true,
				keptClaims: [NEW],
				pairedLeaveInk: [],
				madeLive: false,
			},
			moved: [[OTHER, NEW]],
			keptMoved: [[OTHER, NEW]],
			pairedLeaveInk: [],
			madeLive: false,
			madeInTrash: true,
			newClaimers: [early.id],
			oldClaimers: [],
			kept: ["own", "pane2"],
			owed: false,
		});
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
	}, 30_000);

	it("m: inside the held read a PDF of other bytes saved at the old name and opened: it opens with no strokes, nothing carried, no notice; the move lands, the leave runs on the new name, and the PDF at the old name opens blank after a restart", async () => {
		const { v, next, x1, early } = await owedWithKeptPaneOpen();
		const moved = claimMovesOf(next, x1);
		const read = holdFoundRead(next, x1);
		await next.renameFile(OTHER, NEW);
		await turnsWhile(() => !read.held);
		expect(read.held, "precondition: the claim move's read of the found ink's file is held").toBe(true);
		expect(savedPaths(v), "precondition: the owed leave followed the rename at once").toEqual([NEW]);
		expect(claimersAmong(v, [x1], OTHER), "precondition: the found ink still claims the old name").toEqual([x1]);
		v.bytesAt.set(OTHER, otherBytes);
		await next.createFile(OTHER);
		const said = shown.length;
		const saved = await next.open(OTHER);
		await next.store.flush();
		const atOpen = {
			onLeaveInk: [x1, early.id].includes(saved.id),
			strokes: next.pdfStore.strokes(saved.id).map((x) => x.id).sort(),
			notices: shown.slice(said),
		};
		console.log(`K657-2 m: opened at the old name inside the hold ${JSON.stringify({ id: saved.id, ...atOpen })}`);
		expect(moved, "precondition: the found ink's claim move still waits").toEqual([]);
		read.release();
		await turnsWhile(() => moved.length === 0);
		expect(moved, "precondition: the found ink's claim move landed").toEqual([[OTHER, NEW]]);
		await runOut(next);
		const end = {
			atOpen,
			pane: next.pdfStore.strokes(next.plugin.pdfIds.get(saved.root) as string).map((x) => x.id).sort(),
			savedInk: inkOf(v, saved.id),
			notices: shown.slice(said),
			newClaimers: claimersOnDisk(v, NEW),
			leaveOnOld: claimersAmong(v, [x1, early.id], OTHER),
			kept: inkOf(v, early.id),
			owed: v.local.has(OWED_KEY),
		};
		const restarted = await restartStrokes(v, OTHER);
		console.log(`K657-2 m: end ${JSON.stringify({ ...end, restarted })}`);
		expect(
			{ ...end, restarted: restarted.strokes },
			"the PDF saved at the old name opened wearing the renamed copy's ink, or it was saved there, or a notice was said, or the leave's inks did not end on the new name"
		).toEqual({
			atOpen: { onLeaveInk: false, strokes: [], notices: [] },
			pane: [],
			savedInk: [],
			notices: [],
			newClaimers: [early.id],
			leaveOnOld: [],
			kept: ["own", "pane2"],
			owed: false,
			restarted: [],
		});
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
	});

	it("o1 (no owed leave): a new version of other bytes saved over a closed inked PDF opens with its ink carried, with the notice", async () => {
		const v = vault();
		v.bytesAt.set(SAVED_OVER, thirdBytes);
		const { s, ids: [q] } = await inked(v, [SAVED_OVER]);
		await s.changeFile(SAVED_OVER, otherBytes);
		const said = shown.length;
		const o = await s.open(SAVED_OVER);
		await s.store.flush();
		const got = { fresh: o.id !== q, strokes: s.pdfStore.strokes(o.id).map((x) => x.id), notices: shown.slice(said) };
		console.log(`K657-2 o1: ${JSON.stringify(got)}`);
		expect(got, "the new version did not open with the old version's ink carried, with the notice").toEqual({
			fresh: true,
			strokes: ["ink-0"],
			notices: [CARRIED],
		});
	});

	it("o2 (an owed move waiting at another name): inside the held read, a new version of other bytes saved over a closed inked PDF elsewhere opens with its ink carried, with the notice", async () => {
		const { v, next, x1 } = await owedWithKeptPaneOpen();
		// A PDF of its own (a third document), inked and closed before the rename.
		v.bytesAt.set(SAVED_OVER, thirdBytes);
		await next.createFile(SAVED_OVER);
		const q = await next.open(SAVED_OVER);
		next.draw(q.id, stroke(80, "q"));
		await next.store.flush();
		next.close(q.root);
		next.plugin.releasePdfId(q.id);
		await next.store.flush();
		expect(v.sidecar(q.id)?.pdfPaths, "precondition: the third document's ink claims its own path only").toEqual([SAVED_OVER]);
		const moved = claimMovesOf(next, x1);
		const read = holdFoundRead(next, x1);
		await next.renameFile(OTHER, NEW);
		await turnsWhile(() => !read.held);
		expect(read.held, "precondition: the claim move's read of the found ink's file is held").toBe(true);
		await next.changeFile(SAVED_OVER, otherBytes);
		const said = shown.length;
		const o = await next.open(SAVED_OVER);
		await next.store.flush();
		const got = { fresh: o.id !== q.id, strokes: next.pdfStore.strokes(o.id).map((x) => x.id), notices: shown.slice(said) };
		console.log(`K657-2 o2: ${JSON.stringify(got)}`);
		expect(moved, "precondition: the found ink's claim move still waits").toEqual([]);
		read.release();
		await turnsWhile(() => moved.length === 0);
		await runOut(next);
		expect(got, "the new version did not open with the old version's ink carried, with the notice, while an owed move waited at another name").toEqual({
			fresh: true,
			strokes: ["q"],
			notices: [CARRIED],
		});
	});
});

describe("the owed leave's claim move counts from its rename until it ends, and no longer", () => {
	it("k-end: after the claim move lands and the leave runs, a PDF of the renamed copy's bytes made, inked and deleted at the old name: its own ink goes to the trash at its grace; the leave's inks stay on the new name", async () => {
		const { v, next, x1, early } = await owedWithKeptPaneOpen();
		const moved = claimMovesOf(next, x1);
		await next.renameFile(OTHER, NEW);
		await turnsWhile(() => moved.length === 0);
		expect(moved, "precondition: the found ink's claim move landed").toEqual([[OTHER, NEW]]);
		// The let-go after the move runs the leave on the new name: the found ink goes to the trash, nothing stays owed.
		await settleGrace(next);
		for (let i = 0; i < 3; i++) await movesSettled(next);
		const ran = { owed: v.local.has(OWED_KEY), oldClaimers: claimersOnDisk(v, OTHER), newClaimers: claimersOnDisk(v, NEW) };
		expect(ran, "precondition: the move ended and the leave ran on the new name before a PDF is made at the old name").toEqual({
			owed: false,
			oldClaimers: [],
			newClaimers: [early.id],
		});
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		const { made } = await madeInkedDeleted(v, next, OTHER, undefined);
		const madeOn = made.id === x1 ? "found" : made.id === early.id ? "kept" : "own";
		expect(v.sidecar(made.id)?.pdfPaths, "precondition: the made PDF's ink claims the old name only").toEqual([OTHER]);
		await runOut(next);
		const end = {
			madeOn,
			madeLive: v.adapter.files.has(`.handwriting/${made.id}.json`),
			madeClaims: v.sidecar(made.id)?.pdfPaths ?? [],
			madeInTrash: v.trashInk().some((t) => t.includes("made")),
			newClaimers: claimersOnDisk(v, NEW),
			oldClaimers: claimersOnDisk(v, OTHER),
			kept: v.sidecar(early.id)?.strokes.map((x) => x.id).sort(),
			owed: v.local.has(OWED_KEY),
		};
		console.log(`K657-1 k-end: ${JSON.stringify(end)}`);
		expect(end, "after the move ended, the made PDF's own ink did not go to the trash at its grace, or the leave's inks left the new name").toEqual({
			// Of the renamed copy's bytes, the made PDF opens on the found ink's id, as in cell f. The found ink went to the
			// trash when the leave ran, so the ink on that id here is the made PDF's own strokes, claiming the old name only.
			madeOn: "found",
			madeLive: false,
			madeClaims: [],
			madeInTrash: true,
			newClaimers: [early.id],
			oldClaimers: [],
			kept: ["own", "pane2"],
			owed: false,
		});
	});
});

/** An open lists the ink file `first` before every other, whatever the folder's order. */
function listFirst(s: Session, first: string) {
	const list = s.store.listIds.bind(s.store);
	s.store.listIds = (async (prefix: string) => {
		const ids = [...(await list(prefix))].sort();
		return [...ids.filter((i) => i === first), ...ids.filter((i) => i !== first)];
	}) as typeof s.store.listIds;
}

/** A stroke in the second pane while the leave is owed, then a quit with that pane open: the leave owed and saved. */
async function quitOwedWithStroke() {
	const { v, next, x1, early, secondAt } = await owedLeave();
	next.draw(secondAt, stroke(61, "pane2"));
	await next.store.flush();
	next.plugin.unloaded = true;
	next.pdfStore.cancelPendingDeletes();
	expect(savedPaths(v), "precondition: one leave is saved owed, off the copy").toEqual([OTHER]);
	return { v, x1, early };
}

/**
 * The copy renamed on another device (a session that never owed the leave) with a pane there showing one of the
 * leave's inks, so only that ink's claim moves. That device runs an older build (put back from files). Returns the
 * other ink, which still claims the old name. `from`: the copy's name there (OTHER unless named); `alsoAtFrom`: other
 * inks known to claim that name still (a deleted PDF's).
 */
async function renamedElsewhere(v: Vault, x1: string, early: { id: string }, moves: "found" | "kept", from = OTHER, alsoAtFrom: readonly string[] = []) {
	const other = session(v);
	const shows = moves === "found" ? x1 : early.id;
	const lagging = moves === "found" ? early.id : x1;
	listFirst(other, shows);
	const pane = await other.open(from);
	expect(pane.id, `precondition: the other device's pane on the copy shows the ${moves} ink`).toBe(shows);
	// That device runs an older build: its rename moves the pane's ink's claim only and never writes the other ink's
	// file. This build moves that claim too (FOLLOWUPS 550), so once its moves land the file is put back as the older
	// build leaves it: the same bytes and the same modified time.
	const laggingFile = `.handwriting/${lagging}.json`;
	const before = { bytes: v.adapter.files.get(laggingFile), mtime: v.adapter.mtimes.get(laggingFile) };
	const besides: Promise<unknown>[] = [];
	const beside = other.plugin.movePdfClaimsBesidePane as ((...a: unknown[]) => Promise<unknown>) | undefined;
	if (beside) {
		other.plugin.movePdfClaimsBesidePane = (...a: unknown[]) => {
			const m = beside.apply(other.plugin, a);
			besides.push(m);
			return m;
		};
	}
	await other.renameFile(from, NEW);
	await Promise.all(besides);
	other.close(pane.root);
	other.plugin.releasePdfId(pane.id);
	await movesSettled(other);
	await other.store.flush();
	other.plugin.unloaded = true;
	if (before.bytes !== undefined) {
		v.adapter.files.set(laggingFile, before.bytes);
		if (before.mtime !== undefined) v.adapter.setMtime(laggingFile, before.mtime);
	}
	expect(claimersOnDisk(v, NEW), "precondition: the rename moved the shown ink's claim only").toEqual([shows]);
	expect(claimersOnDisk(v, from).sort(), "precondition: the other ink still claims the old name").toEqual([lagging, ...alsoAtFrom].sort());
	expect(v.files.has(from), "precondition: the old name is no file now").toBe(false);
	return lagging;
}

/** The ink files put in the trash since `before` (a v.trashInk() taken then), each one's strokes sorted, in order. */
function trashSince(v: Vault, before: readonly (readonly string[])[]): string[][] {
	const left = before.map((t) => [...t].sort().join("\n"));
	return v.trashInk()
		.map((t) => [...t].sort())
		.filter((t) => {
			const at = left.indexOf(t.join("\n"));
			if (at < 0) return true;
			left.splice(at, 1);
			return false;
		});
}

/** The next launch of the session that owes the leave, its layout not ready yet: the leave's run waits for it. */
function launchBeforeLayout(v: Vault) {
	let start: (() => void) | undefined;
	const s = session(v, {
		pendingStore: true,
		layoutReady: false,
		afterLayout: (st) => {
			start = st;
		},
	});
	function layoutReady() {
		(s.plugin.app.workspace as { layoutReady: boolean }).layoutReady = true;
		expect(start, "precondition: the leave's run waited for the layout").toBeDefined();
		start!();
	}
	return { s, layoutReady };
}

describe("the copy renamed where the leave is not held (another device), only one of its inks' claims moved there: the next launch's leave run moves the other ink's claim late", () => {
	for (const moves of ["found", "kept"] as const) {
		it(`a later PDF of other bytes made at the old name and drawn on, one step further off, where the other ink's file has not come yet (the ${moves} ink's claim moved), its delete heard at this launch before the run: the run's late move leaves that deletion waiting, the same one; its ink goes to the trash at its grace and a copy of its bytes opens blank; the other ink claims the new name and the leave runs there`, async () => {
			const { v, x1, early } = await quitOwedWithStroke();
			const lagging = await renamedElsewhere(v, x1, early, moves);
			// One step further off: a third device, which the other ink's file has not reached yet, makes a PDF of other
			// bytes at the old name and draws on it, so the made PDF has ink of its own. Where that file is there, the open
			// takes the other ink's strokes (the describe below). Then the file comes, and the made PDF's ink with it.
			const laggingFile = `.handwriting/${lagging}.json`;
			const laggingOnDisk = v.adapter.files.get(laggingFile);
			expect(laggingOnDisk, "precondition: the other ink's file is on disk").toBeDefined();
			v.adapter.files.delete(laggingFile);
			v.bytesAt.set(OTHER, otherBytes);
			const maker = session(v);
			await maker.createFile(OTHER);
			const made = await maker.open(OTHER);
			expect(maker.pdfStore.strokes(made.id), "precondition: the made PDF opens blank").toEqual([]);
			expect([x1, early.id], "precondition: the made PDF has its own ink").not.toContain(made.id);
			maker.draw(made.id, stroke(70, "made"));
			await maker.store.flush();
			maker.close(made.root);
			maker.plugin.releasePdfId(made.id);
			await maker.store.flush();
			maker.plugin.unloaded = true;
			expect(v.adapter.files.has(laggingFile), "precondition: the third device wrote no file for the other ink").toBe(false);
			v.adapter.files.set(laggingFile, laggingOnDisk as string);
			expect(v.sidecar(made.id)?.pdfPaths, "precondition: the made PDF's ink claims the old name").toEqual([OTHER]);
			const { s, layoutReady } = launchBeforeLayout(v);
			await s.deleteFile(OTHER);
			const token = s.pdfStore.deletionAt(OTHER);
			expect(token, "precondition: the made PDF's deletion waits in its grace").toBeDefined();
			expect({ owed: savedPaths(v), old: claimersOnDisk(v, OTHER).sort() }, "precondition: the leave has not run before the layout").toEqual({
				owed: [OTHER],
				old: [lagging, made.id].sort(),
			});
			const moved = claimMovesOf(s, lagging);
			layoutReady();
			await turnsWhile(() => moved.length === 0);
			expect(moved, "precondition: the leave's run moved the other ink's claim to the new name").toEqual([[OTHER, NEW]]);
			const sameDeletion = s.pdfStore.deletionAt(OTHER) === token;
			await runOut(s);
			const end = {
				sameDeletion,
				madeLive: v.adapter.files.has(`.handwriting/${made.id}.json`),
				madeClaims: v.sidecar(made.id)?.pdfPaths ?? [],
				madeInTrash: v.trashInk().some((t) => t.includes("made")),
				newClaimers: claimersOnDisk(v, NEW),
				oldClaimers: claimersOnDisk(v, OTHER),
				kept: inkOf(v, early.id),
				owed: v.local.has(OWED_KEY),
			};
			const copy = await copyOpens(v, otherBytes);
			const renamed = await restartStrokes(v, NEW);
			expect(
				{ ...end, copy, renamed },
				"the run's move ended the made PDF's deletion, or its ink stayed live, or a copy of its bytes opened on it, or the leave's inks did not end on the new name"
			).toEqual({
				sameDeletion: true,
				madeLive: false,
				madeClaims: [],
				madeInTrash: true,
				newClaimers: [early.id],
				oldClaimers: [],
				kept: ["own", "pane2"],
				owed: false,
				copy: [],
				renamed: { id: early.id, strokes: ["own", "pane2"] },
			});
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		}, 30_000);

		it(`the rename heard at this launch as the copy's delete at the old name and a create at the new name, before the run (the ${moves} ink's claim moved there): the run's late move leaves that deletion waiting, the same one; past its grace the deletion is gone, the trash holds only the found ink's file, whole, more than before the run, the kept ink claims the new name only, the old name is claimed by none, no stroke is lost, and nothing is said over the run and the grace`, async () => {
			const { v, x1, early } = await quitOwedWithStroke();
			const lagging = await renamedElsewhere(v, x1, early, moves);
			// This launch's vault still lists the copy at the old name; the sync tool's delete and create land before the layout.
			v.files.delete(NEW);
			v.files.add(OTHER);
			const { s, layoutReady } = launchBeforeLayout(v);
			await s.deleteFile(OTHER);
			const token = s.pdfStore.deletionAt(OTHER);
			expect(token, "precondition: the copy's own deletion waits in its grace").toBeDefined();
			await s.createFile(NEW);
			expect(savedPaths(v), "precondition: the leave has not run before the layout").toEqual([OTHER]);
			const moved = claimMovesOf(s, lagging);
			const said = shown.length;
			const trashBefore = v.trashInk();
			layoutReady();
			await turnsWhile(() => moved.length === 0);
			const now = s.pdfStore.deletionAt(OTHER);
			const run = { moved: [...moved], deletion: now === undefined ? "ended" : now === token ? "same" : "another" };
			await runOut(s);
			const name = (id: string) => (id === early.id ? "kept" : id === x1 ? "found" : id);
			const end = {
				...run,
				pastGrace: s.pdfStore.deletionAt(OTHER) === undefined ? "gone" : "waiting",
				newClaimers: claimersOnDisk(v, NEW).map(name),
				oldClaimers: claimersOnDisk(v, OTHER).map(name),
				kept: inkOf(v, early.id),
				foundLive: v.adapter.files.has(`.handwriting/${x1}.json`),
				owed: savedPaths(v),
				trashed: trashSince(v, trashBefore),
				said: shown.slice(said),
			};
			const renamed = await restartStrokes(v, NEW);
			console.log(`copy's own delete, the ${moves} ink's claim moved: ${JSON.stringify({ ...end, renamed: { id: name(renamed.id), strokes: renamed.strokes } })}`);
			expect({ ...end, renamed: { id: name(renamed.id), strokes: renamed.strokes } }, "the run's move ended the copy's own deletion, or past its grace more went to the trash, or the leave's inks did not end on the new name, or a stroke was lost, or a notice was said").toEqual({
				moved: [[OTHER, NEW]],
				deletion: "same",
				pastGrace: "gone",
				newClaimers: ["kept"],
				oldClaimers: [],
				kept: ["own", "pane2"],
				foundLive: false,
				owed: [],
				trashed: [["ink-0", "pane2"]],
				said: [],
				renamed: { id: "kept", strokes: ["own", "pane2"] },
			});
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		}, 30_000);
	}
});

/** The grace of the deletion waiting at `path` run out (its retirement ended) while the layout is not ready yet. */
async function graceOutBeforeLayout(s: Session, path: string) {
	await vi.advanceTimersByTimeAsync(10_001);
	await turnsWhile(() => s.pdfStore.deletionAt(path) !== undefined);
	expect(s.pdfStore.deletionAt(path), `precondition: the deletion at ${path} retired before the layout`).toBeUndefined();
}

describe("the copy renamed where the leave is not held, only one of its inks' claims moved there: a deletion at the old name heard at the next launch retires before the layout, so before the leave's run", () => {
	// Y2-2: the lagging ink is walked as the deleted file's own. With no name in the leave's `was`, nothing tied it to the
	// leave, and it went with the deletion. The other ink of the leave already left the old name: its name is the copy's,
	// and the lagging ink follows it there, as a kept ink's found ink follows it (followLeaves).
	for (const moves of ["found", "kept"] as const) {
		it(`a later PDF of other bytes made at the old name and drawn on where the other ink's file has not come yet (the ${moves} ink's claim moved), its delete heard and its grace run out before the layout: its ink goes to the trash, the other ink is not lost with it, the leave's inks end on the new name with every stroke`, async () => {
			const { v, x1, early } = await quitOwedWithStroke();
			const lagging = await renamedElsewhere(v, x1, early, moves);
			const laggingFile = `.handwriting/${lagging}.json`;
			const laggingOnDisk = v.adapter.files.get(laggingFile);
			expect(laggingOnDisk, "precondition: the other ink's file is on disk").toBeDefined();
			v.adapter.files.delete(laggingFile);
			v.bytesAt.set(OTHER, otherBytes);
			const maker = session(v);
			await maker.createFile(OTHER);
			const made = await maker.open(OTHER);
			expect(maker.pdfStore.strokes(made.id), "precondition: the made PDF opens blank").toEqual([]);
			maker.draw(made.id, stroke(70, "made"));
			await maker.store.flush();
			maker.close(made.root);
			maker.plugin.releasePdfId(made.id);
			await maker.store.flush();
			maker.plugin.unloaded = true;
			v.adapter.files.set(laggingFile, laggingOnDisk as string);
			expect(v.sidecar(made.id)?.pdfPaths, "precondition: the made PDF's ink claims the old name").toEqual([OTHER]);
			const { s, layoutReady } = launchBeforeLayout(v);
			const said = shown.length;
			await s.deleteFile(OTHER);
			expect(s.pdfStore.deletionAt(OTHER), "precondition: the made PDF's deletion waits in its grace").toBeDefined();
			await graceOutBeforeLayout(s, OTHER);
			expect(savedPaths(v), "precondition: the leave has not run before the layout").toEqual([OTHER]);
			const moved = claimMovesOf(s, lagging);
			layoutReady();
			await turnsWhile(() => moved.length === 0, 200);
			await runOut(s);
			const name = (id: string) => (id === early.id ? "kept" : id === x1 ? "found" : id === made.id ? "made" : id);
			const got = {
				madeLive: v.adapter.files.has(`.handwriting/${made.id}.json`),
				madeInTrash: v.trashInk().some((t) => t.includes("made")),
				newClaimers: claimersOnDisk(v, NEW).map(name),
				oldClaimers: claimersOnDisk(v, OTHER).map(name),
				kept: inkOf(v, early.id),
				owed: savedPaths(v),
				said: shown.slice(said),
			};
			const renamed = await restartStrokes(v, NEW);
			console.log(`grace out before the layout, made PDF, the ${moves} ink's claim moved: ${JSON.stringify({ ...got, moved, trash: v.trashInk(), renamed: { id: name(renamed.id), strokes: renamed.strokes } })}`);
			expect({ ...got, renamed: { id: name(renamed.id), strokes: renamed.strokes } }, "the made PDF's retirement before the run took the other ink with it, or the leave's inks did not end on the new name").toEqual({
				madeLive: false,
				madeInTrash: true,
				newClaimers: ["kept"],
				oldClaimers: [],
				kept: ["own", "pane2"],
				owed: [],
				said: [],
				renamed: { id: "kept", strokes: ["own", "pane2"] },
			});
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		}, 30_000);

		it(`the rename heard at this launch as the copy's delete at the old name and a create at the new name (the ${moves} ink's claim moved there), the deletion's grace run out before the layout: the leave's inks end on the new name with every stroke, the old name claimed by none, nothing said`, async () => {
			const { v, x1, early } = await quitOwedWithStroke();
			const lagging = await renamedElsewhere(v, x1, early, moves);
			v.files.delete(NEW);
			v.files.add(OTHER);
			const { s, layoutReady } = launchBeforeLayout(v);
			const said = shown.length;
			const trashBefore = v.trashInk();
			await s.deleteFile(OTHER);
			expect(s.pdfStore.deletionAt(OTHER), "precondition: the copy's own deletion waits in its grace").toBeDefined();
			await s.createFile(NEW);
			await graceOutBeforeLayout(s, OTHER);
			expect(savedPaths(v), "precondition: the leave has not run before the layout").toEqual([OTHER]);
			const moved = claimMovesOf(s, lagging);
			layoutReady();
			await turnsWhile(() => moved.length === 0, 200);
			await runOut(s);
			const name = (id: string) => (id === early.id ? "kept" : id === x1 ? "found" : id);
			const got = {
				newClaimers: claimersOnDisk(v, NEW).map(name),
				oldClaimers: claimersOnDisk(v, OTHER).map(name),
				kept: inkOf(v, early.id),
				foundLive: v.adapter.files.has(`.handwriting/${x1}.json`),
				owed: savedPaths(v),
				trashed: trashSince(v, trashBefore),
				said: shown.slice(said),
			};
			const renamed = await restartStrokes(v, NEW);
			console.log(`grace out before the layout, copy's own delete, the ${moves} ink's claim moved: ${JSON.stringify({ ...got, moved, renamed: { id: name(renamed.id), strokes: renamed.strokes } })}`);
			expect({ ...got, renamed: { id: name(renamed.id), strokes: renamed.strokes } }, "the copy's own deletion retiring before the run lost a stroke, or the leave's inks did not end on the new name").toEqual({
				newClaimers: ["kept"],
				oldClaimers: [],
				kept: ["own", "pane2"],
				foundLive: false,
				owed: [],
				trashed: [["ink-0", "pane2"]],
				said: [],
				renamed: { id: "kept", strokes: ["own", "pane2"] },
			});
		}, 30_000);
	}
});

/**
 * Y2-2's first cell up to the made PDF's delete heard at the next launch, its layout not ready: the leave saved owed, the
 * copy renamed on another device with only the `moves` ink's claim moved, a PDF of other bytes made at the old name and
 * drawn on where the other ink's file had not come, then that file come. `before` changes the vault before the launch.
 */
async function madeDeletedBeforeLayout(moves: "found" | "kept", before?: (v: Vault) => void) {
	const { v, x1, early } = await quitOwedWithStroke();
	const lagging = await renamedElsewhere(v, x1, early, moves);
	const laggingFile = `.handwriting/${lagging}.json`;
	const laggingOnDisk = v.adapter.files.get(laggingFile);
	expect(laggingOnDisk, "precondition: the other ink's file is on disk").toBeDefined();
	v.adapter.files.delete(laggingFile);
	v.bytesAt.set(OTHER, otherBytes);
	const maker = session(v);
	await maker.createFile(OTHER);
	const made = await maker.open(OTHER);
	expect(maker.pdfStore.strokes(made.id), "precondition: the made PDF opens blank").toEqual([]);
	maker.draw(made.id, stroke(70, "made"));
	await maker.store.flush();
	maker.close(made.root);
	maker.plugin.releasePdfId(made.id);
	await maker.store.flush();
	maker.plugin.unloaded = true;
	v.adapter.files.set(laggingFile, laggingOnDisk as string);
	before?.(v);
	const laggingStrokes = inkOf(v, lagging);
	const trashBefore = v.trashInk();
	const { s, layoutReady } = launchBeforeLayout(v);
	return { v, s, layoutReady, x1, early, lagging, made, at: { lagging, strokes: laggingStrokes, trashBefore } };
}

/**
 * Y2-2's second cell up to the launch, its layout not ready: the leave saved owed, the copy renamed on another device
 * with only the `moves` ink's claim moved, the rename to be heard at this launch as the copy's delete at the old name and
 * a create at the new name. `before` changes the vault before the launch.
 */
async function copyDeletedBeforeLayout(moves: "found" | "kept", before?: (v: Vault) => void) {
	const { v, x1, early } = await quitOwedWithStroke();
	const lagging = await renamedElsewhere(v, x1, early, moves);
	v.files.delete(NEW);
	v.files.add(OTHER);
	before?.(v);
	const laggingStrokes = inkOf(v, lagging);
	const trashBefore = v.trashInk();
	const { s, layoutReady } = launchBeforeLayout(v);
	return { v, s, layoutReady, x1, early, lagging, at: { lagging, strokes: laggingStrokes, trashBefore } };
}

/** Whether a later session opens `path` on the lagging ink, or with the lagging ink's strokes. */
async function opensLagging(v: Vault, path: string, at: { lagging: string; strokes: readonly string[] }) {
	const opened = await restartStrokes(v, path);
	return opened.id === at.lagging || (at.strokes.length > 0 && opened.strokes.join("\n") === [...at.strokes].sort().join("\n"));
}

/**
 * The lagging ink after a retirement, off disk: live or not, what it claims, and whether its file went to the trash
 * whole since the launch.
 */
function laggingEnd(v: Vault, at: { lagging: string; strokes: readonly string[]; trashBefore: readonly (readonly string[])[] }) {
	return {
		live: v.adapter.files.has(`.handwriting/${at.lagging}.json`),
		claims: v.sidecar(at.lagging)?.pdfPaths ?? [],
		inTrash: trashSince(v, at.trashBefore).some((t) => t.join("\n") === [...at.strokes].sort().join("\n")),
	};
}

/** The lagging ink's end before Y2-2's cure, and in each guard below: gone to the trash, whole, with the deletion. */
const ASIDE = { live: false, claims: [], inTrash: true };
/** A PDF of the third bytes, inked in the launch session (cell d). */
const HOLDER = "Work/H.pdf";

describe("the lagging ink's guards: the made PDF's deletion at the old name, heard at the next launch, retires before the layout", () => {
	for (const moves of ["found", "kept"] as const) {
		const cases: [string, (v: Vault) => void, boolean][] = [
			["a: no leave owed (the leave ran or was forgotten): the lagging ink goes to the trash with the deletion, as before", (v) => v.local.delete(OWED_KEY), false],
			["b: the partner's name stands no more (the copy gone from it): the lagging ink goes to the trash, as before", (v) => v.files.delete(NEW), false],
			[
				"c: a PDF of other bytes (the made PDF's) at the partner's name: the lagging ink goes to the trash, as before, and that PDF does not open with its strokes",
				(v) => v.bytesAt.set(NEW, otherBytes),
				true,
			],
		];
		for (const [title, before, opens] of cases) {
			it(`${title} (the ${moves} ink's claim moved)`, async () => {
				const { v, s, made, at } = await madeDeletedBeforeLayout(moves, before);
				await s.deleteFile(OTHER);
				expect(s.pdfStore.deletionAt(OTHER), "precondition: the made PDF's deletion waits in its grace").toBeDefined();
				await graceOutBeforeLayout(s, OTHER);
				expect({ lagging: laggingEnd(v, at), madeInTrash: v.trashInk().some((t) => t.includes("made")), madeLive: v.adapter.files.has(`.handwriting/${made.id}.json`) }, "the retirement did not end as before").toEqual({
					lagging: ASIDE,
					madeInTrash: true,
					madeLive: false,
				});
				if (!opens) return;
				await runOut(s);
				expect(await opensLagging(v, NEW, at), "the PDF of other bytes at the partner's name opened with the lagging ink").toBe(false);
			}, 30_000);
		}

		it(`d: a pane's ink comes to claim the partner's name during the retirement's read of the lagging ink: the lagging ink goes to the trash, as before (the ${moves} ink's claim moved)`, async () => {
			const { v, s, lagging, made, at } = await madeDeletedBeforeLayout(moves, (w) => {
				w.files.add(HOLDER);
				w.bytesAt.set(HOLDER, thirdBytes);
			});
			const pane = await s.open(HOLDER);
			s.draw(pane.id, stroke(80, "third"));
			await s.store.flush();
			expect([lagging, made.id].includes(pane.id), "precondition: the pane holds an ink of its own").toBe(false);
			await s.deleteFile(OTHER);
			expect(s.pdfStore.deletionAt(OTHER), "precondition: the made PDF's deletion waits in its grace").toBeDefined();
			const gate = holdFoundRead(s, lagging);
			await vi.advanceTimersByTimeAsync(10_001);
			await turnsWhile(() => !gate.held);
			expect(gate.stack, "precondition: the retirement's read of the lagging ink is held").toMatch(/retireDeletedPathLoading/);
			// The pane's ink claims the partner's name while that read is out, as an open there would.
			s.pdfStore.claimPath(pane.id, NEW);
			gate.release();
			await turnsWhile(() => s.pdfStore.deletionAt(OTHER) !== undefined);
			expect(s.pdfStore.deletionAt(OTHER), "precondition: the deletion retired before the layout").toBeUndefined();
			expect(laggingEnd(v, at), "the lagging ink moved onto a name a pane's ink holds").toEqual(ASIDE);
		}, 30_000);

		it(`e: the partner's name cannot be read at the retirement: the deletion waits and the lagging ink keeps its claim; read at the retry, the lagging ink follows to that name, and after the layout the leave's inks end there with every stroke, as in the first cell above (the ${moves} ink's claim moved)`, async () => {
			const { v, s, layoutReady, x1, early, made, at } = await madeDeletedBeforeLayout(moves);
			const said = shown.length;
			await s.deleteFile(OTHER);
			const token = s.pdfStore.deletionAt(OTHER);
			expect(token, "precondition: the made PDF's deletion waits in its grace").toBeDefined();
			const read = s.plugin.app.vault.readBinary as (f: { path: string }) => Promise<ArrayBuffer>;
			const fails = { on: true, met: 0 };
			s.plugin.app.vault.readBinary = async (f: { path: string }) => {
				if (fails.on && f.path === NEW) {
					fails.met++;
					throw new Error("EBUSY: the partner's name is locked");
				}
				return read(f);
			};
			await vi.advanceTimersByTimeAsync(10_001);
			// Until the read of the partner's name has failed or the deletion ended, then the rest of that retirement.
			await turnsWhile(() => fails.met === 0 && s.pdfStore.deletionAt(OTHER) !== undefined, 200);
			await turnsWhile(() => true, 30);
			await s.store.flush();
			const now = s.pdfStore.deletionAt(OTHER);
			const first = { deletion: now === undefined ? "ended" : now === token ? "waiting" : "another", lagging: laggingEnd(v, at) };
			fails.on = false;
			// The retry, the first wait after a defer (10 s).
			await vi.advanceTimersByTimeAsync(10_001);
			await turnsWhile(() => s.pdfStore.deletionAt(OTHER) !== undefined);
			await s.store.flush();
			const retry = { deletion: s.pdfStore.deletionAt(OTHER) === undefined ? "ended" : "waiting", lagging: laggingEnd(v, at) };
			layoutReady();
			await runOut(s);
			const name = (id: string) => (id === early.id ? "kept" : id === x1 ? "found" : id === made.id ? "made" : id);
			const end = {
				madeLive: v.adapter.files.has(`.handwriting/${made.id}.json`),
				madeInTrash: v.trashInk().some((t) => t.includes("made")),
				newClaimers: claimersOnDisk(v, NEW).map(name),
				oldClaimers: claimersOnDisk(v, OTHER).map(name),
				kept: inkOf(v, early.id),
				owed: savedPaths(v),
				said: shown.slice(said),
			};
			const renamed = await restartStrokes(v, NEW);
			console.log(`partner's name unread, the ${moves} ink's claim moved: ${JSON.stringify({ first, retry, end, met: fails.met })}`);
			expect({ first, retry, end: { ...end, renamed: { id: name(renamed.id), strokes: renamed.strokes } } }, "the lagging ink went to the trash on an unread name, or did not follow once read, or the leave's inks did not end on that name").toEqual({
				first: { deletion: "waiting", lagging: { live: true, claims: [OTHER], inTrash: false } },
				retry: { deletion: "ended", lagging: { live: true, claims: [NEW], inTrash: false } },
				end: {
					madeLive: false,
					madeInTrash: true,
					newClaimers: ["kept"],
					oldClaimers: [],
					kept: ["own", "pane2"],
					owed: [],
					said: [],
					renamed: { id: "kept", strokes: ["own", "pane2"] },
				},
			});
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		}, 30_000);

		it(`f: the rename heard as the copy's delete at the old name and a create at the new name, a PDF of other bytes at the new name now: the lagging ink goes to the trash, as before, and that PDF does not open with its strokes (the ${moves} ink's claim moved)`, async () => {
			const { v, s, at } = await copyDeletedBeforeLayout(moves, (w) => w.bytesAt.set(NEW, otherBytes));
			await s.deleteFile(OTHER);
			expect(s.pdfStore.deletionAt(OTHER), "precondition: the copy's own deletion waits in its grace").toBeDefined();
			await s.createFile(NEW);
			await graceOutBeforeLayout(s, OTHER);
			expect(laggingEnd(v, at), "the lagging ink moved onto another document at the partner's name").toEqual(ASIDE);
			await runOut(s);
			expect(await opensLagging(v, NEW, at), "the PDF of other bytes at the new name opened with the lagging ink").toBe(false);
		}, 30_000);

		it(`g: a pane on the partner's name shows the found ink when the layout comes, so the leave cannot run then: past the made PDF's grace its ink is in the trash and its deletion is gone, not waiting on the leave; the lagging ink claims the partner's name, a file, with every stroke (the ${moves} ink's claim moved)`, async () => {
			const { v, s, layoutReady, x1, made, at } = await madeDeletedBeforeLayout(moves);
			await s.deleteFile(OTHER);
			expect(s.pdfStore.deletionAt(OTHER), "precondition: the made PDF's deletion waits in its grace").toBeDefined();
			await vi.advanceTimersByTimeAsync(10_001);
			await turnsWhile(() => s.pdfStore.deletionAt(OTHER) !== undefined, 200);
			// The pane is open when the layout's run comes: it shows the found ink, so that run leaves the leave owed.
			listFirst(s, x1);
			const pane = await s.open(NEW);
			layoutReady();
			for (let i = 0; i < 3; i++) await movesSettled(s);
			// Past the first waits a deletion kept for the leave's run would take (10 s, 20 s, 40 s).
			await vi.advanceTimersByTimeAsync(70_001);
			await turnsWhile(() => s.pdfStore.deletionAt(OTHER) !== undefined, 200);
			await s.store.flush();
			const end = {
				deletion: s.pdfStore.deletionAt(OTHER) === undefined ? "gone" : "waiting",
				madeLive: v.adapter.files.has(`.handwriting/${made.id}.json`),
				madeInTrash: v.trashInk().some((t) => t.includes("made")),
				pane: s.plugin.pdfIds.get(pane.root) === x1 ? "found" : "another",
				lagging: { ...laggingEnd(v, at), strokes: inkOf(v, at.lagging), nameIsFile: v.files.has(NEW) },
				owed: savedPaths(v).length,
			};
			console.log(`a pane shows the found ink at the layout, the ${moves} ink's claim moved: ${JSON.stringify(end)}`);
			expect(end, "the made PDF's deletion waited on the leave, or its ink stayed live, or the lagging ink lost its claim or a stroke").toEqual({
				deletion: "gone",
				madeLive: false,
				madeInTrash: true,
				pane: "found",
				lagging: { live: true, claims: [NEW], inTrash: false, strokes: [...at.strokes], nameIsFile: true },
				owed: 1,
			});
		}, 30_000);

		for (const first of ["lagging", "made"] as const) {
			it(`h: the ink folder listing the ${first} ink first: the lagging ink follows to the partner's name, the made PDF's ink goes to the trash (the ${moves} ink's claim moved)`, async () => {
				const { v, s, lagging, made, at } = await madeDeletedBeforeLayout(moves);
				listFirst(s, first === "lagging" ? lagging : made.id);
				await s.deleteFile(OTHER);
				expect(s.pdfStore.deletionAt(OTHER), "precondition: the made PDF's deletion waits in its grace").toBeDefined();
				await graceOutBeforeLayout(s, OTHER);
				await s.store.flush();
				expect({ lagging: laggingEnd(v, at), madeInTrash: v.trashInk().some((t) => t.includes("made")), madeLive: v.adapter.files.has(`.handwriting/${made.id}.json`) }, "the listing order changed where the inks ended").toEqual({
					lagging: { live: true, claims: [NEW], inTrash: false },
					madeInTrash: true,
					madeLive: false,
				});
			}, 30_000);
		}

		it(`i: a third ink (a PDF of the third bytes, inked) claims the partner's name at the retirement: the lagging ink goes to the trash, as before (the ${moves} ink's claim moved)`, async () => {
			const { v, s, lagging, made, at } = await madeDeletedBeforeLayout(moves, (w) => {
				w.files.add(HOLDER);
				w.bytesAt.set(HOLDER, thirdBytes);
			});
			const pane = await s.open(HOLDER);
			s.draw(pane.id, stroke(80, "third"));
			await s.store.flush();
			s.pdfStore.claimPath(pane.id, NEW);
			await s.store.flush();
			expect([lagging, made.id].includes(pane.id), "precondition: the pane holds an ink of its own").toBe(false);
			expect(v.sidecar(pane.id)?.pdfPaths, "precondition: the third ink claims the partner's name").toContain(NEW);
			await s.deleteFile(OTHER);
			expect(s.pdfStore.deletionAt(OTHER), "precondition: the made PDF's deletion waits in its grace").toBeDefined();
			await graceOutBeforeLayout(s, OTHER);
			expect(laggingEnd(v, at), "the lagging ink moved onto a name a third ink claims").toEqual(ASIDE);
		}, 30_000);
	}
});

describe("the copy renamed onto a deleted PDF's name in its grace here, the leave owed off that name, then renamed where the leave is not held with only one of its inks' claims moved: that deletion restored at the next launch and waiting at the leave's run", () => {
	for (const moves of ["found", "kept"] as const) {
		it(`the ${moves} ink's claim moved: the run's late move takes the other ink to the new name; a PDF of other bytes made at that name inside the restored grace opens blank, nothing said; past the grace the deleted PDF's ink is in the trash, the leave's inks on the new name with every stroke, that name claimed by none`, async () => {
			const { v, next, x1, early } = await owedWithKeptPaneOpen(2);
			const firstMoves = claimMovesOf(next, x1);
			const { made: gone } = await madeInkedDeleted(v, next, ONTO, otherBytes);
			await next.renameFile(OTHER, ONTO);
			await turnsWhile(() => firstMoves.length === 0);
			expect(firstMoves, "precondition: the found ink's claim move landed").toEqual([[OTHER, ONTO]]);
			await movesSettled(next);
			expect(savedPaths(v), "precondition: the leave is owed off the deleted PDF's name").toEqual([ONTO]);
			expect([...(next.pdfStore.arrivedAt(ONTO) ?? [])].sort(), "precondition: both inks came with the copy").toEqual([early.id, x1].sort());
			// A quit inside that grace: the deletion and the leave are saved.
			next.plugin.unloaded = true;
			next.pdfStore.cancelPendingDeletes();
			const lagging = await renamedElsewhere(v, x1, early, moves, ONTO, [gone.id]);
			const { s, layoutReady } = launchBeforeLayout(v);
			expect(s.pdfStore.deletionAt(ONTO), "precondition: the deletion at the copy's old name is restored").toBeDefined();
			expect([...(s.pdfStore.arrivedAt(ONTO) ?? [])].sort(), "precondition: the restored deletion lists both inks as come with the copy").toEqual([early.id, x1].sort());
			const moved = claimMovesOf(s, lagging);
			const said = shown.length;
			layoutReady();
			await turnsWhile(() => moved.length === 0);
			expect(moved, "precondition: the leave's run moved the other ink's claim to the new name").toEqual([[ONTO, NEW]]);
			const atRun = { waiting: s.pdfStore.deletionAt(ONTO) !== undefined, arrived: [...(s.pdfStore.arrivedAt(ONTO) ?? [])].map((id) => (id === early.id ? "kept" : id === x1 ? "found" : id)).sort() };
			expect(atRun.waiting, "precondition: the restored deletion still waits at the run").toBe(true);
			v.bytesAt.set(ONTO, thirdBytes);
			await s.createFile(ONTO);
			const there = await s.open(ONTO);
			const opened = { strokes: s.pdfStore.strokes(there.id).map((x) => x.id), leaveInk: [x1, early.id].includes(there.id) };
			s.close(there.root);
			s.plugin.releasePdfId(there.id);
			await runOut(s);
			const name = (id: string) => (id === early.id ? "kept" : id === x1 ? "found" : id === gone.id ? "gone" : "other");
			const got = {
				opened,
				goneLive: v.adapter.files.has(`.handwriting/${gone.id}.json`),
				goneInTrash: v.trashInk().some((t) => t.includes("made")),
				newClaimers: claimersOnDisk(v, NEW).map(name),
				ontoClaimers: claimersOnDisk(v, ONTO).map(name).filter((n) => n !== "other"),
				kept: inkOf(v, early.id),
				owed: savedPaths(v),
				said: shown.slice(said),
			};
			console.log(`restored deletion at the run, the ${moves} ink's claim moved: ${JSON.stringify({ atRun, ...got, trash: v.trashInk() })}`);
			expect(got, "the run's late move with the copy's old name's deletion restored lost a stroke, or a PDF made there opened on a leave's ink, or the leave's inks did not end on the new name").toEqual({
				opened: { strokes: [], leaveInk: false },
				goneLive: false,
				goneInTrash: true,
				newClaimers: ["kept"],
				ontoClaimers: [],
				kept: ["own", "pane2"],
				owed: [],
				said: [],
			});
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		}, 30_000);
	}
});

describe("defect candidate: the copy renamed where the leave is not held, one of its inks still claiming the old name there: a PDF of other bytes made at the old name opens with that ink's strokes", () => {
	for (const moves of ["found", "kept"] as const) {
		it(`the ${moves} ink's claim moved, the other ink's not: a PDF of other bytes made at the old name and opened, in a later session on a device that has both inks' files: as it is`, async () => {
			const { v, x1, early } = await quitOwedWithStroke();
			const lagging = await renamedElsewhere(v, x1, early, moves);
			// The copy still lives, at the new name; the file now at the old name is another document.
			expect(v.files.has(NEW), "precondition: the renamed copy is a file at the new name").toBe(true);
			v.bytesAt.set(OTHER, otherBytes);
			const maker = session(v);
			await maker.createFile(OTHER);
			const said = shown.length;
			const made = await maker.open(OTHER);
			await maker.store.flush();
			const name = (id: string) => (id === early.id ? "kept" : id === x1 ? "found" : id === made.id ? "made" : id);
			const got = {
				opened: [x1, early.id].includes(made.id) ? name(made.id) : "its own",
				strokes: maker.pdfStore.strokes(made.id).map((x) => x.id).sort(),
				notices: shown.slice(said),
				oldClaimers: claimersOnDisk(v, OTHER).map(name).sort(),
				newClaimers: claimersOnDisk(v, NEW).map(name).sort(),
				lagging: inkOf(v, lagging),
			};
			console.log(`defect candidate, the ${moves} ink's claim moved: ${JSON.stringify(got)}`);
			expect(got, "a PDF of other bytes made at the name the renamed copy left no longer opens as it did").toEqual({
				opened: "its own",
				strokes: moves === "found" ? ["own"] : ["ink-0", "pane2"],
				notices: [CARRIED],
				oldClaimers: [moves === "found" ? "kept" : "found", "made"],
				newClaimers: [moves === "found" ? "found" : "kept"],
				lagging: moves === "found" ? ["own"] : ["ink-0", "pane2"],
			});
		}, 30_000);
	}
});
