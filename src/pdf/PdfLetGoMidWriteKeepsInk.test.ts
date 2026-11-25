/**
 * Ink let go while a write of it waits on an await: the write must not come from a fresh, empty record.
 *
 * A record is let go (forgotten from memory) once no pane shows it and what it held is on disk. Two writes look at the
 * ink, await, and then write it through the store without looking again. Let go inside that await, the store makes a
 * fresh record with no strokes and no claims, and the write saves that record over the ink's file.
 *
 * 1. A leave owed off a copy, with a stroke drawn on the found ink since: when that ink is let go, its run checks that
 *    the kept ink is read, then carries the stroke into it and writes it. The kept ink let go in between (its pane
 *    closed in the same pass) leaves its file holding only the carried stroke and claiming nothing.
 * 2. A deleted PDF's grace ends: its claim is taken off each ink that claims it, after one read of that ink's file. An
 *    ink that keeps another claim, let go during that read (its pane closed), has its file written with no strokes.
 *
 * 3. The same leave, the kept ink's pane open: the found ink let go as its run's check that it is read answers. Its
 *    claims then read as none, and the leave was dropped while its file still claims the copy.
 * 4. The same leave, a stroke drawn on the found ink since: a clear of the kept ink and of that stroke (as a Delete all
 *    from the kept ink's pane makes) landing as the run's check that the kept ink is read answers. The run carried the
 *    stroke it had read before that check, and the cleared stroke came back on the copy.
 * 5. Delete all from the found ink's pane, the kept ink's pane closed: the delete reads the kept ink in, and lets it go
 *    at its end once its file is written. A stroke drawn on the found ink after the delete, and its pane closed, start
 *    the found ink's run. The delete's let-go landing as that run's check that the kept ink is read answers, the kept
 *    ink's file was written from a fresh record: the carried stroke only, claiming nothing.
 *
 * Each let-go is placed at the await, with no timing: in 1, 3, 4 and 5 it lands as the check answers, before the run
 * goes on; in 2 the read's answer is held until the record is gone. Each has a control without it, which passes.
 * The five let-go cells were red before their cure and pass since; a red in one is a regression, not an expected failure.
 *
 * Three more hold parts of those cures that the cells above pass without:
 * 6. A carry into ink held in memory but never read in (its claim remembered before its file is read) is refused. Made
 *    fresh by the carry, its save wrote the carried stroke alone over the file.
 * 7. In 2, the PDF that keeps the claim opened again before the let-go ink is read back in: the record is held again but
 *    not read. The deletion waits for the read and is tried again; going on, it left the deleted PDF's claim on the file.
 * 8. In 3, the found ink's first run, with no pane on it and no leave owed yet: let go as that check answers, the leave
 *    is owed there. Not owed, it was forgotten while the found ink's file still claims the copy.
 *
 * Through the plugin and the real stores, with an in-memory vault: the harness of PdfOwedLeave.test.ts, copied (its
 * helpers are not exported, and that file is not edited here), with the Delete all command of
 * PdfDeleteAllOwedLeave.test.ts: registered by registerExportSelectionCommands and run with the PDF active, its dialog a
 * stand-in that records its Delete button. The delete is the plugin's own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every notice shown, in order. */
const shown = vi.hoisted(() => [] as string[]);
/** Every delete dialog opened, in order: its Delete button. */
const dialogs = vi.hoisted(() => [] as { confirm: () => void }[]);
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
		constructor(_app: unknown, _count: number, _kind: string, confirm: () => void) {
			dialogs.push({ confirm });
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


/** Each check that identifies a pane again settles and ends, and what it starts. */
async function movesSettled(s: ReturnType<typeof session>) {
	await vi.advanceTimersByTimeAsync(3_001);
	await s.checked();
	await s.pdfStore.settle();
	await s.store.flush();
}

/** The real timer, taken when this file loads, before any cell fakes the clock. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

/**
 * Fake-clock turns that do not move the clock while `waiting` holds, with a real pause of 1 ms after each turn it still
 * holds (PdfDeleteAllOwedLeave.test.ts's turnsWhile, its 0 ms step): work that resolves off the fake clock lands in real
 * time.
 */
async function turnsWhile(waiting: () => boolean, realTurns = 1000): Promise<void> {
	for (let i = 0; i < realTurns && waiting(); i++) {
		await vi.advanceTimersByTimeAsync(0);
		if (waiting()) await new Promise<void>((done) => realSetTimeout(done, 1));
	}
}

/** A quit: saves land, the plugin unloads, the deletions in their grace are saved as they stand. */
async function quit(s: ReturnType<typeof session>) {
	await s.store.flush();
	s.plugin.unloaded = true;
	s.pdfStore.cancelPendingDeletes();
}

/** The next launch over the vault, the leaves owed at the quit restored, opening the copy; every grace and check run out. */
async function relaunchOpen(v: ReturnType<typeof vault>) {
	const s = session(v, { pendingStore: true });
	const opened = await s.open(OTHER);
	await settleGrace(s);
	await movesSettled(s);
	await movesSettled(s);
	return { s, opened };
}

/**
 * "Delete all ink on this PDF" run from the palette with `path` active, until its dialog opens. `press` presses Delete;
 * `settled` waits for the delete that started.
 */
async function deleteAllOn(s: ReturnType<typeof session>, path: string) {
	s.active.path = path;
	const opened = dialogs.length;
	const said = shown.length;
	expect(s.commands.get("delete-all-pdf-ink")?.checkCallback(false), "precondition: the command ran").toBe(true);
	await turnsWhile(() => dialogs.length === opened && shown.length === said);
	const dialog = dialogs[opened];
	expect(dialog, `precondition: the delete dialog opened (said: ${shown.slice(said).join(" | ")})`).toBeDefined();
	return {
		press: () => dialog!.confirm(),
		async settled() {
			while (s.deletes.length > 0) await Promise.all(s.deletes.splice(0));
		},
	};
}

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

/** The found ink, as it was at the let-go, is in the trash whole and no longer live. */
function foundInTrashWhole(v: ReturnType<typeof vault>, x1: string, strokes: readonly string[]) {
	expect(v.sidecar(x1), "the found ink's file is still live").toBeUndefined();
	expect(v.trashInk().map((t) => [...t].sort()), "the found ink is not in the trash whole").toContainEqual([...strokes].sort());
}

/** The leave saved as owed for the found ink and the copy, from the kept ink. */
function savedOwed(v: ReturnType<typeof vault>, x1: string, from: string) {
	const saved = JSON.parse((v.local.get("handwriting-pdf-owed-leaves") as string | undefined) ?? "[]") as { id: string; path: string; from: string }[];
	return saved.filter((e) => e.id === x1 && e.path === OTHER && e.from === from);
}

/**
 * The kept ink let go the moment its run's check that it is read answers: that check asks the store to load it, then
 * whether it is ready; once it answered yes, the record is forgotten (as a closed pane's release forgets it) before the
 * run goes on. The forget waits only for the answer to be given, so it lands before the run reads it.
 */
function letGoAsReadyAnswers(next: ReturnType<typeof session>, kept: string) {
	const pdfStore = next.pdfStore;
	const state = { asked: false, fired: false, forgotten: false, events: [] as string[] };
	const ensureLoaded = pdfStore.ensureLoaded.bind(pdfStore);
	pdfStore.ensureLoaded = (id: string) => {
		if (id === kept) {
			state.asked = true;
			state.events.push("load asked");
		}
		return ensureLoaded(id);
	};
	const inkReady = pdfStore.inkReady.bind(pdfStore);
	pdfStore.inkReady = (id: string) => {
		const ready = inkReady(id);
		if (id === kept) state.events.push(`ready ${ready}`);
		if (id === kept && ready && state.asked && !state.fired) {
			state.fired = true;
			void Promise.resolve().then(() => {
				const generation = pdfStore.generation(kept);
				state.forgotten = generation !== null && pdfStore.forgetIfUnchanged(kept, generation);
				state.events.push(`let go ${state.forgotten}`);
			});
		}
		return ready;
	};
	const carryInto = pdfStore.carryInto.bind(pdfStore);
	pdfStore.carryInto = (id, added, from) => {
		if (id === kept) state.events.push(`carry into ${pdfStore.generation(kept) === null ? "no record" : "the record"}`);
		return carryInto(id, added, from);
	};
	return state;
}

/**
 * The owed leave of cell A of PdfOwedLeave.test.ts with a stroke drawn on the found ink since, then the kept ink's pane
 * and the second pane closed in one pass (a split holding both, closed): the kept pane leaves the plugin's panes first,
 * its record still held, and the second pane's let-go starts the found ink's run.
 */
async function bothPanesClosed(letGo: boolean) {
	const { v, next, x1, early, second, secondAt } = await owedLeave({ settle: true });
	next.draw(secondAt, stroke(61, "pane2"));
	await next.store.flush();
	expect(v.sidecar(secondAt)?.strokes.map((x) => x.id), "precondition: the second pane's stroke is written").toEqual(["ink-0", "pane2"]);
	expect(v.sidecar(early.id)?.strokes.map((x) => x.id), "precondition: the kept ink's file holds its own stroke").toEqual(["own"]);
	expect(v.sidecar(early.id)?.pdfPaths, "precondition: the kept ink's file claims the copy").toContain(OTHER);
	expect(savedOwed(v, x1, early.id), "precondition: the leave is saved as owed").toHaveLength(1);
	next.close(early.root);
	expect(next.pdfStore.inkReady(early.id), "precondition: the kept ink's record is still held and read").toBe(true);
	const state = letGo ? letGoAsReadyAnswers(next, early.id) : undefined;
	next.close(second.root);
	next.plugin.releasePdfId(secondAt);
	await movesSettled(next);
	await movesSettled(next);
	return { v, next, x1, early, state };
}

describe("ink let go while a write of it waits on an await", () => {
	it("a leave owed with a stroke drawn on the found ink since, the kept ink let go as its run's check that it is read answers (its pane closed with the second pane): the kept ink's file keeps its own stroke and its claim on the copy, and the second pane's stroke is kept once", async () => {
		const { v, x1, early, state } = await bothPanesClosed(true);
		expect(state?.forgotten, `precondition: the kept ink let go after its run's check (${state?.events.join(", ")})`).toBe(true);
		const kept = v.sidecar(early.id);
		expect(kept?.strokes.map((x) => x.id).sort(), "the kept ink's file lost its own stroke: the copy opens without the ink drawn on it").toEqual(expect.arrayContaining(["own"]));
		expect(kept?.pdfPaths ?? [], "the kept ink's file no longer claims the copy").toContain(OTHER);
		// The second pane's stroke: carried into the kept ink with the found ink in the trash whole, or still on the
		// found ink, live, with its leave still owed.
		if (kept?.strokes.some((x) => x.id === "pane2")) {
			foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		} else {
			expect(v.sidecar(x1)?.strokes.map((x) => x.id).sort(), "the second pane's stroke is in neither live file").toEqual(["ink-0", "pane2"]);
			expect(savedOwed(v, x1, early.id), "the leave is no longer owed, the second pane's stroke not on the kept ink").toHaveLength(1);
		}
	});

	it("control: the same, the kept ink not let go: the kept ink's file holds both strokes and claims the copy, the found ink in the trash whole, nothing owed", async () => {
		const { v, x1, early } = await bothPanesClosed(false);
		const kept = v.sidecar(early.id);
		expect(kept?.strokes.map((x) => x.id).sort(), "the kept ink's file does not hold both strokes").toEqual(["own", "pane2"]);
		expect(kept?.pdfPaths ?? [], "the kept ink's file no longer claims the copy").toContain(OTHER);
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		expect(savedOwed(v, x1, early.id), "the leave is still owed").toHaveLength(0);
	});

	/** The PDF deleted, and the other PDF of the same bytes whose claim its ink keeps. */
	const GONE = "Notes/Form.pdf";
	const KEEPS = "Work/Form.pdf";

	/**
	 * Ink K claims GONE and KEEPS, a pane open on it at KEEPS; GONE is deleted and its grace runs out. The answer of the
	 * read of K's file that the grace's end makes, just before it writes K, is held until `during` has run.
	 */
	async function graceEndsDuringRead(during: (s: ReturnType<typeof session>, pane: { root: HTMLElement; id: string }) => Promise<void>) {
		const v = vault();
		const { ids: [k] } = await inked(v, [GONE]);
		const file = `.handwriting/${k}.json`;
		const page = parsePage(v.adapter.files.get(file) as string, k).data;
		v.adapter.files.set(file, serializePage({ ...page, pdfPaths: [GONE, KEEPS] }));
		v.files.add(KEEPS);
		vi.useFakeTimers();
		const s = session(v);
		const pane = await s.open(KEEPS);
		expect(pane.id, "precondition: the other PDF opens on K").toBe(k);
		expect(s.pdfStore.strokes(k).map((x) => x.id), "precondition: the pane shows K's stroke").toEqual(["ink-0"]);
		const store = s.pdfStore as unknown as { claimOnDisk: (st: unknown, id: string) => Promise<unknown> };
		const claimOnDisk = store.claimOnDisk.bind(store);
		let reached = (): void => {};
		const atRead = new Promise<void>((r) => (reached = r));
		let release = (): void => {};
		const held = new Promise<void>((r) => (release = r));
		/** The reads of K's file the grace's end made, the held one first. */
		let reads = 0;
		store.claimOnDisk = async (st: unknown, id: string) => {
			const answer = await claimOnDisk(st, id);
			if (id === k) {
				reads++;
				reached();
				await held;
			}
			return answer;
		};
		await s.deleteFile(GONE);
		expect(s.pdfStore.pendingClaims().has(GONE), "precondition: the deletion waits out its grace").toBe(true);
		await vi.advanceTimersByTimeAsync(10_001);
		await atRead;
		await during(s, pane);
		release();
		// A deletion kept waiting is tried again after its wait, each wait twice the last: every such wait run out.
		for (let i = 0; i < 6 && s.pdfStore.pendingClaims().size > 0; i++) await vi.advanceTimersByTimeAsync(10_001 * 2 ** i);
		await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
		await s.store.flush();
		return { v, k, reads: () => reads };
	}

	it("a deleted PDF's grace ends while its ink keeps another PDF's claim, that ink let go during the read of its file (its pane closed): its file keeps its stroke and claims the other PDF only, the deletion tried again, and that PDF opens with the ink", async () => {
		const { v, k, reads } = await graceEndsDuringRead(async (s, pane) => {
			const pdfStore = s.pdfStore;
			const forgetIfUnchanged = pdfStore.forgetIfUnchanged.bind(pdfStore);
			let forgot = (_: boolean): void => {};
			const letGo = new Promise<boolean>((r) => (forgot = r));
			pdfStore.forgetIfUnchanged = (id: string, generation: number) => {
				const gone = forgetIfUnchanged(id, generation);
				if (id === pane.id) forgot(gone);
				return gone;
			};
			s.close(pane.root);
			s.plugin.releasePdfId(pane.id);
			expect(await letGo, "precondition: K's record let go as a closed pane's is").toBe(true);
			expect(pdfStore.generation(pane.id), "precondition: K's record is gone during the read").toBeNull();
		});
		expect(v.sidecar(k)?.strokes.map((x) => x.id), "K's file lost its strokes: the PDF it keeps opens with no ink").toEqual(["ink-0"]);
		expect(v.sidecar(k)?.pdfPaths, "K's file does not claim the other PDF only").toEqual([KEEPS]);
		expect(reads(), "the deletion was not tried again after the read the let-go landed in").toBeGreaterThanOrEqual(2);
		vi.useRealTimers();
		const later = session(v);
		const opened = await later.open(KEEPS);
		expect(later.pdfStore.strokes(opened.id).map((x) => x.id), "the other PDF opens without K's stroke").toEqual(["ink-0"]);
	});

	it("control: the same, K's pane left open: its file keeps its stroke and claims the other PDF only", async () => {
		const { v, k } = await graceEndsDuringRead(async () => {});
		expect(v.sidecar(k)?.strokes.map((x) => x.id), "K's file lost its strokes").toEqual(["ink-0"]);
		expect(v.sidecar(k)?.pdfPaths, "K's file does not claim the other PDF only").toEqual([KEEPS]);
	});

	/** The leave owed, the kept ink's pane left open, then the second pane closed: the found ink's run starts. */
	async function secondClosed(next: ReturnType<typeof session>, second: { root: HTMLElement }, secondAt: string) {
		next.close(second.root);
		next.plugin.releasePdfId(secondAt);
		await movesSettled(next);
		await movesSettled(next);
	}

	/** The leave owed, the kept ink's pane open; `letGo`: the found ink let go as its run's check that it is read answers. */
	async function foundLetGo(letGo: boolean) {
		const o = await owedLeave({ settle: true });
		expect(savedOwed(o.v, o.x1, o.early.id), "precondition: the leave is saved as owed").toHaveLength(1);
		const state = letGo ? letGoAsReadyAnswers(o.next, o.x1) : undefined;
		await secondClosed(o.next, o.second, o.secondAt);
		return { ...o, state };
	}

	it("the found ink let go as its run's check that it is read answers, the kept ink's pane open: the leave stays owed, each file keeps its strokes and its claim on the copy, and after a relaunch the copy opens with the kept ink", async () => {
		const { v, next, x1, early, state } = await foundLetGo(true);
		expect(state?.forgotten, `precondition: the found ink let go after its run's check (${state?.events.join(", ")})`).toBe(true);
		expect(savedOwed(v, x1, early.id), "the leave was dropped while the found ink's file still claims the copy").toHaveLength(1);
		expect(v.sidecar(x1)?.strokes.map((x) => x.id), "the found ink's file lost its stroke").toEqual(["ink-0"]);
		expect(v.sidecar(x1)?.pdfPaths ?? [], "the found ink's file no longer claims the copy").toContain(OTHER);
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id), "the kept ink's file lost its stroke").toEqual(["own"]);
		expect(v.sidecar(early.id)?.pdfPaths ?? [], "the kept ink's file no longer claims the copy").toContain(OTHER);
		await quit(next);
		const { s, opened } = await relaunchOpen(v);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id), "after a relaunch the copy opened without the ink drawn on it").toEqual(["own"]);
	});

	it("control: the same, the found ink not let go: the leave runs, the found ink in the trash whole, the kept ink's file holds its stroke and claims the copy, nothing owed", async () => {
		const { v, x1, early } = await foundLetGo(false);
		foundInTrashWhole(v, x1, ["ink-0"]);
		expect(savedOwed(v, x1, early.id), "the leave is still owed").toHaveLength(0);
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id), "the kept ink's file lost its stroke").toEqual(["own"]);
		expect(v.sidecar(early.id)?.pdfPaths ?? [], "the kept ink's file no longer claims the copy").toContain(OTHER);
	});

	/**
	 * The leave owed, the kept ink's pane open, a stroke drawn on the found ink since; then the second pane closed.
	 * `cleared`: as the run's check that the kept ink is read answers, the kept ink cleared and the found ink put back to
	 * the stroke it held at the owe, as a Delete all from the kept ink's pane clears them (it reaches the found ink,
	 * keeping what it held at the owe). The clear waits only for the answer to be given, so it lands before the run goes on.
	 */
	async function drawnThenCleared(cleared: boolean) {
		const o = await owedLeave({ settle: true });
		const { v, next, early, secondAt } = o;
		next.draw(secondAt, stroke(61, "pane2"));
		await next.store.flush();
		expect(v.sidecar(secondAt)?.strokes.map((x) => x.id), "precondition: the second pane's stroke is written").toEqual(["ink-0", "pane2"]);
		const state = { asked: false, fired: false };
		if (cleared) {
			const pdfStore = next.pdfStore;
			const ensureLoaded = pdfStore.ensureLoaded.bind(pdfStore);
			pdfStore.ensureLoaded = (id: string) => {
				if (id === early.id) state.asked = true;
				return ensureLoaded(id);
			};
			const inkReady = pdfStore.inkReady.bind(pdfStore);
			pdfStore.inkReady = (id: string) => {
				const ready = inkReady(id);
				if (id === early.id && ready && state.asked && !state.fired) {
					state.fired = true;
					void Promise.resolve().then(() => {
						pdfStore.replaceAll(early.id, []);
						pdfStore.replaceAll(secondAt, pdfStore.strokes(secondAt).filter((s) => s.id === "ink-0"));
					});
				}
				return ready;
			};
		}
		await secondClosed(next, o.second, secondAt);
		return { ...o, state };
	}

	it("a stroke drawn on the found ink since the leave was owed, cleared with the kept ink as the run's check that the kept ink is read answers (the kept ink's pane open): the cleared stroke is not carried back onto the copy", async () => {
		const { v, x1, early, state } = await drawnThenCleared(true);
		expect(state.fired, "precondition: the clear landed as the run's check answered").toBe(true);
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id) ?? [], "the stroke cleared while the run waited is back on the copy").not.toContain("pane2");
		expect(v.sidecar(x1)?.strokes.map((x) => x.id) ?? [], "the stroke cleared while the run waited is back on the found ink").not.toContain("pane2");
		expect(v.sidecar(early.id)?.pdfPaths ?? [], "the kept ink's file no longer claims the copy").toContain(OTHER);
	});

	it("control: the same, nothing cleared: the kept ink's file holds both strokes and claims the copy, the found ink in the trash whole, nothing owed", async () => {
		const { v, x1, early } = await drawnThenCleared(false);
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id).sort(), "the kept ink's file does not hold both strokes").toEqual(["own", "pane2"]);
		expect(v.sidecar(early.id)?.pdfPaths ?? [], "the kept ink's file no longer claims the copy").toContain(OTHER);
		foundInTrashWhole(v, x1, ["ink-0", "pane2"]);
		expect(savedOwed(v, x1, early.id), "the leave is still owed").toHaveLength(0);
	});

	/**
	 * The leave owed, the kept ink's pane closed and its record let go; Delete all from the second pane (the found ink),
	 * which reads the kept ink in, clears both, and at its end lets the kept ink go again once its file is written. Then a
	 * stroke drawn on the found ink, and the second pane closed: the found ink's run starts, and carries that stroke into
	 * the kept ink. `held`: the answer of the delete's end write is held until the run's check that the kept ink is read
	 * answers, so the delete's let-go lands before the run goes on. Not held: the delete ends first.
	 */
	async function deleteAllThenRun(held: boolean) {
		const o = await owedLeave({ settle: true });
		const { v, next, x1, early, second, secondAt } = o;
		const kept = early.id;
		next.close(early.root);
		next.plugin.releasePdfId(kept);
		await movesSettled(next);
		expect(next.pdfStore.generation(kept), "precondition: the kept ink's record was let go with its pane").toBeNull();
		expect(savedOwed(v, x1, kept), "precondition: the leave is saved as owed").toHaveLength(1);
		const store = next.store;
		const flushPage = store.flushPage.bind(store);
		const gate = { asked: false, given: false, flushed: undefined as boolean | undefined, answer: (_: boolean): void => {} };
		if (held) {
			store.flushPage = ((id: string) => {
				// The delete's end write of the kept ink, read in and cleared: written now, its answer held.
				if (id !== kept || gate.asked || next.pdfStore.generation(kept) === null || next.pdfStore.strokes(kept).length > 0) return flushPage(id);
				gate.asked = true;
				void flushPage(id).then((ok) => (gate.flushed = ok));
				return new Promise<boolean>((r) => (gate.answer = r));
			}) as typeof store.flushPage;
		}
		const run = await deleteAllOn(next, OTHER);
		run.press();
		if (held) await turnsWhile(() => gate.flushed === undefined);
		else await run.settled();
		if (held) expect(gate.asked, `precondition: the delete wrote the kept ink at its end (said: ${shown.join(" | ")})`).toBe(true);
		expect(next.pdfStore.strokes(secondAt).map((x) => x.id), "precondition: the delete cleared the found ink").toEqual([]);
		expect(v.sidecar(kept)?.strokes.map((x) => x.id), "precondition: the delete cleared the kept ink's file").toEqual([]);
		expect(v.sidecar(kept)?.pdfPaths ?? [], "precondition: the kept ink's file claims the copy after the delete").toContain(OTHER);
		next.draw(secondAt, stroke(62, "late"));
		const watch = { asked: false, letGo: undefined as boolean | undefined };
		if (held) {
			const pdfStore = next.pdfStore;
			const ensureLoaded = pdfStore.ensureLoaded.bind(pdfStore);
			pdfStore.ensureLoaded = (id: string) => {
				if (id === kept) watch.asked = true;
				return ensureLoaded(id);
			};
			const inkReady = pdfStore.inkReady.bind(pdfStore);
			pdfStore.inkReady = (id: string) => {
				const ready = inkReady(id);
				if (id === kept && ready && watch.asked && !gate.given) {
					gate.given = true;
					gate.answer(gate.flushed === true);
				}
				return ready;
			};
			const forgetIfUnchanged = pdfStore.forgetIfUnchanged.bind(pdfStore);
			pdfStore.forgetIfUnchanged = (id: string, generation: number) => {
				const gone = forgetIfUnchanged(id, generation);
				if (id === kept && gate.given && watch.letGo === undefined) watch.letGo = gone;
				return gone;
			};
		}
		await secondClosed(next, second, secondAt);
		// The run did not reach its check of the kept ink: the delete's answer given now, so it ends.
		if (!gate.given) {
			gate.given = true;
			gate.answer(gate.flushed === true);
		}
		await run.settled();
		await movesSettled(next);
		await next.store.flush();
		return { ...o, kept, watch };
	}

	it("Delete all from the found ink's pane, the kept ink let go at the delete's end as the found ink's run, started by a stroke and that pane's close, checks that the kept ink is read: the kept ink's file claims the copy, and the stroke drawn after the delete is carried into it or stays on the found ink, owed", async () => {
		const { v, x1, kept, watch } = await deleteAllThenRun(true);
		expect(watch.letGo, `precondition: the delete's end let the kept ink go as the run's check answered (asked: ${watch.asked})`).toBe(true);
		const file = v.sidecar(kept);
		expect(file?.pdfPaths ?? [], "the kept ink's file no longer claims the copy").toContain(OTHER);
		expect(file?.strokes.map((x) => x.id) ?? [], "ink drawn before the delete is back on the copy").not.toContain("own");
		if (file?.strokes.some((x) => x.id === "late")) {
			foundInTrashWhole(v, x1, ["late"]);
		} else {
			expect(v.sidecar(x1)?.strokes.map((x) => x.id), "the stroke drawn after the delete is in neither live file").toEqual(["late"]);
			expect(savedOwed(v, x1, kept), "the leave is no longer owed, the stroke drawn after the delete not on the kept ink").toHaveLength(1);
		}
	});

	it("control: the same, the delete ended before the run: the kept ink's file holds the stroke drawn after the delete and claims the copy, the found ink in the trash whole, nothing owed", async () => {
		const { v, x1, kept } = await deleteAllThenRun(false);
		expect(v.sidecar(kept)?.strokes.map((x) => x.id), "the kept ink's file does not hold the stroke drawn after the delete").toEqual(["late"]);
		expect(v.sidecar(kept)?.pdfPaths ?? [], "the kept ink's file no longer claims the copy").toContain(OTHER);
		foundInTrashWhole(v, x1, ["late"]);
		expect(savedOwed(v, x1, kept), "the leave is still owed").toHaveLength(0);
	});

	/**
	 * Ink K on disk claiming KEEPS, and a later session holding K in memory but not reading it: its claim on KEEPS is
	 * remembered before its file is read, as a claim on an ink not yet read is (claimPath). Then a stroke carried into K.
	 * `read`: K's file read in first.
	 */
	async function carryIntoHeld(read: boolean) {
		const v = vault();
		const { ids: [k] } = await inked(v, [KEEPS]);
		const s = session(v);
		s.pdfStore.claimPath(k, KEEPS);
		if (read) await s.pdfStore.ensureLoaded(k);
		expect(s.pdfStore.generation(k), "precondition: K is held in memory").not.toBeNull();
		expect(s.pdfStore.inkReady(k), `precondition: K's file is ${read ? "" : "not "}read in`).toBe(read);
		const carried = s.pdfStore.carryInto(k, [stroke(70, "carried")], null);
		await s.pdfStore.settle();
		await s.store.flush();
		return { v, k, carried };
	}

	it("a carry into ink held in memory but never read in (its claim remembered before its file is read): refused, writing nothing, and its file keeps its stroke and its claim", async () => {
		const { v, k, carried } = await carryIntoHeld(false);
		expect(v.sidecar(k)?.strokes.map((x) => x.id), "K's file lost its stroke: written with the carried stroke alone").toEqual(["ink-0"]);
		expect(v.sidecar(k)?.pdfPaths, "K's file lost its claim").toEqual([KEEPS]);
		expect(carried, "the carry into ink never read in was taken").toBe(false);
	});

	it("control: the same, K's file read in first: the carry lands beside its stroke, and its file keeps its claim", async () => {
		const { v, k, carried } = await carryIntoHeld(true);
		expect(carried, "the carry into ink read in was refused").toBe(true);
		expect(v.sidecar(k)?.strokes.map((x) => x.id), "K's file does not hold both strokes").toEqual(["ink-0", "carried"]);
		expect(v.sidecar(k)?.pdfPaths, "K's file lost its claim").toEqual([KEEPS]);
	});

	it("a deleted PDF's grace ends while its ink keeps another PDF's claim, that ink let go during the read of its file and the other PDF opened again before the ink is read back in: the deletion waits and is tried again, and its file keeps its stroke and claims the other PDF only", async () => {
		/** The open's read of K's file, held until the deletion's next look at K (its answer given right after). */
		const reopen = {
			asked: false,
			lookedAt: undefined as { held: boolean; ready: boolean } | undefined,
			give: (): void => {},
			opening: undefined as Promise<{ root: HTMLElement; id: string }> | undefined,
			at: undefined as ReturnType<typeof session> | undefined,
		};
		const { v, k, reads } = await graceEndsDuringRead(async (s, pane) => {
			reopen.at = s;
			const pdfStore = s.pdfStore;
			const forgetIfUnchanged = pdfStore.forgetIfUnchanged.bind(pdfStore);
			let forgot = (_: boolean): void => {};
			const letGo = new Promise<boolean>((r) => (forgot = r));
			pdfStore.forgetIfUnchanged = (id: string, generation: number) => {
				const gone = forgetIfUnchanged(id, generation);
				if (id === pane.id) forgot(gone);
				return gone;
			};
			s.close(pane.root);
			s.plugin.releasePdfId(pane.id);
			expect(await letGo, "precondition: K's record let go as a closed pane's is").toBe(true);
			// The other PDF opened again: the store's read of K's file for it is held.
			const host = (pdfStore as unknown as { host: { load: (id: string, options: unknown) => Promise<unknown> } }).host;
			const load = host.load;
			let asked = (): void => {};
			const reading = new Promise<void>((r) => (asked = r));
			const given = new Promise<void>((r) => (reopen.give = r));
			host.load = async (id: string, options: unknown) => {
				if (id !== pane.id || reopen.asked) return load(id, options);
				reopen.asked = true;
				asked();
				await given;
				return load(id, options);
			};
			reopen.opening = s.open(KEEPS);
			await reading;
			expect(pdfStore.generation(pane.id), "precondition: K is held again, for the open").not.toBeNull();
			expect(pdfStore.inkReady(pane.id), "precondition: K's file is not read back in yet").toBe(false);
			const inkReady = pdfStore.inkReady.bind(pdfStore);
			pdfStore.inkReady = (id: string) => {
				const ready = inkReady(id);
				if (id === pane.id && reopen.lookedAt === undefined) {
					reopen.lookedAt = { held: pdfStore.generation(id) !== null, ready };
					void Promise.resolve().then(() => reopen.give());
				}
				return ready;
			};
		});
		// A deletion that went on without looking at K again: the open's read given now.
		reopen.give();
		const opened = await reopen.opening!;
		const s = reopen.at!;
		await s.pdfStore.settle();
		await s.store.flush();
		expect(v.sidecar(k)?.pdfPaths, "K's file still claims the deleted PDF").toEqual([KEEPS]);
		expect(v.sidecar(k)?.strokes.map((x) => x.id), "K's file lost its stroke").toEqual(["ink-0"]);
		expect(reads(), "the deletion was not tried again after the read the open was waiting on").toBeGreaterThanOrEqual(2);
		expect(reopen.lookedAt, "the deletion's look at K after its read did not find K held and not read").toEqual({ held: true, ready: false });
		expect(opened.id, "the other PDF opened on another ink").toBe(k);
		expect(s.pdfStore.strokes(k).map((x) => x.id), "the other PDF opened without K's stroke").toEqual(["ink-0"]);
	});

	/**
	 * owedLeave's setup up to its stroke on the first pane, then the second pane closed before the check that meets the
	 * move: the found ink's first run starts with no pane on it and no leave owed yet. `letGo`: the found ink let go as
	 * that run's check that it is read answers.
	 */
	async function firstRun(letGo: boolean) {
		const { v, next, x1, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		layoutReady();
		const second = await next.open(OTHER);
		expect(second.id, "precondition: the second pane opened on the first deleted ink").toBe(x1);
		next.draw(early.id, stroke(60, "own"));
		await next.store.flush();
		next.close(second.root);
		next.plugin.releasePdfId(x1);
		await turnsWhile(() => next.pdfStore.generation(x1) !== null);
		expect(next.pdfStore.generation(x1), "precondition: the found ink's record let go with the second pane").toBeNull();
		expect(savedOwed(v, x1, early.id), "precondition: no leave owed before the run").toHaveLength(0);
		const state = letGo ? letGoAsReadyAnswers(next, x1) : undefined;
		await vi.advanceTimersByTimeAsync(1_001);
		await next.checked();
		await next.pdfStore.settle();
		await next.store.flush();
		return { v, next, x1, early, state };
	}

	it("the found ink's first run, no pane on it and no leave owed yet, the found ink let go as that run's check that it is read answers: the leave is owed, and each file keeps its stroke and its claim on the copy", async () => {
		const { v, x1, early, state } = await firstRun(true);
		expect(state?.forgotten, `precondition: the found ink let go after its run's check (${state?.events.join(", ")})`).toBe(true);
		expect(savedOwed(v, x1, early.id), "the leave was forgotten while the found ink's file still claims the copy").toHaveLength(1);
		expect(v.sidecar(x1)?.strokes.map((x) => x.id), "the found ink's file lost its stroke").toEqual(["ink-0"]);
		expect(v.sidecar(x1)?.pdfPaths ?? [], "the found ink's file no longer claims the copy").toContain(OTHER);
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id), "the kept ink's file lost its stroke").toEqual(["own"]);
		expect(v.sidecar(early.id)?.pdfPaths ?? [], "the kept ink's file no longer claims the copy").toContain(OTHER);
	});

	it("control: the same, the found ink not let go: the leave runs, the found ink's file no longer claims the copy, the kept ink's file holds its stroke and claims the copy, nothing owed", async () => {
		const { v, x1, early } = await firstRun(false);
		expect(savedOwed(v, x1, early.id), "the leave is still owed").toHaveLength(0);
		expect(v.sidecar(x1)?.pdfPaths ?? [], "the found ink's file still claims the copy").not.toContain(OTHER);
		expect(v.sidecar(early.id)?.strokes.map((x) => x.id), "the kept ink's file lost its stroke").toEqual(["own"]);
		expect(v.sidecar(early.id)?.pdfPaths ?? [], "the kept ink's file no longer claims the copy").toContain(OTHER);
	});
});
