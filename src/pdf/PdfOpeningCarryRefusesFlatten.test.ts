// Flatten and Delete all on a PDF whose opening is still carrying an older version's ink into its new ink id.
//
// A PDF that changed while no tab showed it is opened. The open chooses a fresh id for the new bytes, sets it on the pane
// and loads it (empty, so ready), and only then carries the old version's ink across (carryFromOldContent), which reads
// the old ink file and may wait once on its load, up to 2 s. In that wait Flatten saw a ready id with no ink and said "no
// ink on this PDF to flatten"; with a stroke drawn on the blank page first, it wrote a copy holding that stroke alone.
// Delete all said "no ink on this PDF", or asked to delete the one stroke. A moment later the old ink appeared.
//
// Want: while an opening on the path has not ended its carry, both refuse in the words they already say for a PDF still
// being identified, and neither writes nor opens its dialog. The refusal ends when the opening ends, on every way out:
// once it has, both act on the carried ink. Pins (green before the fix, and after): an opening that throws leaves no
// refusal behind; an open of an unchanged PDF whose own ink file is still loading keeps the not-ready words it says now.
//
// The rig is PdfChangedWhileOpening.test.ts's, unchanged (copied by tools/gen-cells.sh, lines 35-321 less the constants
// these cells do not use). The two commands are the real ones, registered by registerExportSelectionCommands on the
// rig's plugin with the PDF active; the flatten and the delete themselves are recorded, not run, and the confirm
// dialog records the count it was opened with, as RegisterExportCommandsNotReady.test.ts does.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import HandwritingPlugin from "../main";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { parsePage } from "../model/PageData";
import { sha256 } from "./Sha256";
import type { InkStroke } from "../ink/Stroke";

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

const CARRIED_NOTICE = "Handwriting: this PDF changed on disk. Your ink was carried over to its new version.";

/** One queued vault op, ms on the fake clock. */
const OP_MS = 5;
/** One head digest, off the queue, ms on the fake clock. */
const DIGEST_MS = 1;
/** Mobile: the whole read of the big changed PDF, one queued op. */
const WHOLE_A_MS = 80;
/** Desktop: the changed PDF's ranged head read, outside the queue. */
const SLOW_HEAD_MS = 300;
/** Desktop: any other ranged head read. */
const FAST_HEAD_MS = 1;

const after = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const desktopApp = Platform.isDesktopApp;
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
	shown.length = 0;
	vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async (_algorithm, data) => {
		const out = sha256(new Uint8Array(data as ArrayBuffer));
		await after(DIGEST_MS);
		return out.slice().buffer;
	});
});
afterEach(() => {
	Platform.isDesktopApp = desktopApp;
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function stroke(id: string): InkStroke {
	return {
		id, page: 1, tool: "pen", color: "#111111", width: 2, createdAt: 0,
		points: [{ x: 10, y: 10, pressure: 0.5, t: 0 }, { x: 20, y: 20, pressure: 0.5, t: 8 }],
		bbox: { x: 10, y: 10, width: 10, height: 10 },
	};
}
const ids = (strokes: readonly InkStroke[]) => strokes.map((s) => s.id);

/** Run the fake clock far past every op and digest the work can start, then hand back its result. */
async function drive<T>(work: Promise<T>, ms = 10_000): Promise<T> {
	work.catch(() => {});
	await vi.advanceTimersByTimeAsync(ms);
	return work;
}

/** Step the fake clock 1 ms at a time until `done` holds, at most `ms`. */
async function until(done: () => boolean, ms = 2_000): Promise<void> {
	for (let n = 0; n < ms && !done(); n++) await vi.advanceTimersByTimeAsync(1);
}

/** Every op waits for the one before it to settle, then takes its time: CapacitorAdapter's `this.promise.then(t, t)`. */
function oneQueue(opMs: (label: string) => number) {
	let tail: Promise<unknown> = Promise.resolve();
	function run<T>(label: string, op: () => Promise<T>): Promise<T> {
		const step = async () => {
			await after(opMs(label));
			return op();
		};
		const next = tail.then(step, step);
		tail = next.then(() => undefined, () => undefined);
		return next;
	}
	return { run };
}

function pdf(fill: string, length: number) {
	return new TextEncoder().encode("%PDF-1.4\n" + fill.repeat(length) + "\n%%EOF\n");
}

type Leaf = { view: { file: { path: string } | undefined; containerEl: HTMLElement } };
type Pane = { root: HTMLElement; leaf: Leaf; id: string };
type Opening = { root: HTMLElement; leaf: Leaf; done: Promise<void> };

function session(platform: "desktop" | "mobile") {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
		getFullPath?: (path: string) => string;
	};
	adapter.list = async (folder) => ({
		files: [...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")),
		folders: [],
	});
	// A is the inked PDF that changes (more than 64 KiB, so its head is a part of it); B is a small un-inked PDF.
	const pdfs = new Map([["A.pdf", pdf("a", 70000)], ["B.pdf", pdf("b", 3000)]]);
	const queue = oneQueue((label) => (label === "readBinary A.pdf" ? WHOLE_A_MS : OP_MS));
	for (const name of ["exists", "read", "write", "rename", "remove", "mkdir", "stat", "list"] as const) {
		const own = (adapter[name] as (...args: unknown[]) => Promise<unknown>).bind(adapter);
		(adapter as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => queue.run(`${name} ${String(args[0])}`, () => own(...args));
	}
	const readBinary = (file: { path: string }) => queue.run(`readBinary ${file.path}`, async () => pdfs.get(file.path)!.slice().buffer);
	/** What happened, in order: head reads ended, ink files loaded, identifications ended, switches. */
	const events: string[] = [];
	let slowHead: string | null = null;
	Platform.isDesktopApp = platform === "desktop";
	if (platform === "desktop") {
		// The ranged read's node fs, as openRangedFile reaches it through the renderer's require.
		adapter.getFullPath = (path) => `/vault/${path}`;
		vi.stubGlobal("require", (mod: string) => {
			if (mod !== "fs") throw new Error(`no ${mod} here`);
			return {
				promises: {
					open: async (full: string) => {
						const path = full.slice("/vault/".length);
						// An open handle reads the file it opened, also after a rename.
						const file = pdfs.get(path)!;
						return {
							read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
								await after(path === slowHead ? SLOW_HEAD_MS : FAST_HEAD_MS);
								events.push(`head read ${path}`);
								const bytes = file.subarray(position, position + length);
								buffer.set(bytes, offset);
								return { bytesRead: bytes.length };
							},
							stat: async () => ({ size: file.length }),
							close: async () => {},
						};
					},
				},
			};
		});
	}
	const store = new PageStore({ vault: { adapter } } as never);
	const pdfStore = new PdfInkStore();
	pdfStore.attachHost({
		load: (id, options) => store.load(id, options),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => {},
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing, "pdf"),
		acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
	});
	const ensureLoaded = pdfStore.ensureLoaded.bind(pdfStore);
	pdfStore.ensureLoaded = async (id: string) => {
		events.push(`load ${id}`);
		const loaded = await ensureLoaded(id);
		events.push(`loaded ${id}`);
		return loaded;
	};
	const leaves: Leaf[] = [];
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, {
		app: {
			workspace: { getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []) },
			vault: { adapter, readBinary, getFileByPath: (p: string) => (pdfs.has(p) ? { path: p, extension: "pdf" } : null) },
		},
		store, pdfStore, pdfInk: new Map(), pdfIds: new Map(), pdfFiles: new Map(),
	});
	// Every identification, the one the in-place switch starts included, so a cell can wait for each to end.
	const resolutions: Promise<void>[] = [];
	const resolve = plugin.resolvePdfId as (...args: unknown[]) => Promise<void>;
	plugin.resolvePdfId = function (this: unknown, ...args: unknown[]) {
		const path = (args[0] as Leaf).view.file?.path;
		const done = resolve.apply(this, args);
		resolutions.push(done);
		done.then(() => events.push(`identified ${path}`), () => {});
		return done;
	};
	// Every change check, the one a held pane's settle starts included, with the panes it was asked for.
	const passes: { panes: ReadonlySet<HTMLElement> | null | undefined; done: Promise<void> }[] = [];
	const check = plugin.onPdfModified as (...args: unknown[]) => Promise<void>;
	plugin.onPdfModified = function (this: unknown, ...args: unknown[]) {
		const done = check.apply(this, args);
		passes.push({ panes: args[1] as ReadonlySet<HTMLElement> | null | undefined, done });
		return done;
	};
	/** A tab opens the file: the plugin's sync mounts a controller and starts the pane's identification (an opening). */
	function startOpen(path: string): Opening {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, forgetHistory() {}, idle: true };
		const leaf: Leaf = { view: { file: { path }, containerEl: root } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		return { root, leaf, done: plugin.resolvePdfId(leaf, root, controller) };
	}
	async function open(path: string): Promise<Pane> {
		const { root, leaf, done } = startOpen(path);
		await drive(done);
		const id = plugin.pdfIds.get(root) as string;
		expect(id, "production resolution must bind a PDF identity").toMatch(/^pdf-[0-9a-f]+(?:-\d+)?$/);
		return { root, leaf, id };
	}
	/** The tab closes: syncPdfControllers' sweep of a pane whose view is gone (PdfClaims.ts:329-337). */
	async function close(pane: Pane) {
		leaves.splice(leaves.indexOf(pane.leaf), 1);
		plugin.pdfInk.delete(pane.root);
		plugin.pdfIds.delete(pane.root);
		plugin.pdfFiles.delete(pane.root);
		plugin.releasePdfId(pane.id);
		await drive(Promise.resolve());
	}
	/** The user opens another file in the same tab: the leaf's file changes, and the plugin's own sync sees it. */
	function switchTo(pane: { leaf: Leaf }, path: string) {
		events.push(`switch to ${path}`);
		pane.leaf.view.file = { path };
		plugin.syncPdfControllers();
	}
	/** The view's file is back at its path: the leaf's file is set again, and the plugin's sync runs, as at the next layout
	 * change or leaf activation (PluginOnload.ts:398-400). */
	function fileBack(pane: { leaf: Leaf }, path: string) {
		events.push(`file back ${path}`);
		pane.leaf.view.file = { path };
		plugin.syncPdfControllers();
	}
	/** Hold the next load of `id`'s ink file until released: the record waits with its load in flight. */
	function holdLoad(id: string) {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		let reached = false;
		const load = store.load.bind(store);
		store.load = (async (pageId: string, options?: { restore?: boolean }) => {
			if (pageId === id && !reached) {
				reached = true;
				await gate;
			}
			return load(pageId, options);
		}) as typeof store.load;
		return { reached: () => reached, release: () => release() };
	}
	return {
		adapter, pdfs, events, store, pdfStore, plugin, startOpen, open, close, switchTo, fileBack, holdLoad, resolutions, passes,
		slowHeadFor: (path: string | null) => (slowHead = path),
		saved: (id: string) => adapter.files.get(store.path(id)) ?? null,
	};
}
type Session = ReturnType<typeof session>;

/** Give A's bytes version `n`: a head byte, so each version is its own ink id, and no two versions here are equal. */
function version(s: Session, n: number) {
	const changed = s.pdfs.get("A.pdf")!.slice();
	changed[100] = 110 + n;
	s.pdfs.set("A.pdf", changed);
}

/** A open in one pane with one stroke saved; its id and its ink file's bytes. */
async function inkedA(s: Session) {
	const pane = await s.open("A.pdf");
	s.pdfStore.commit(pane.id, stroke("a-ink"));
	await drive(s.store.flush());
	return { pane, oldId: pane.id, oldFile: s.saved(pane.id) };
}

/** As inkedA, then the tab closed and its record forgotten: the next open reads A's ink file from disk, as at launch. */
async function inkedAThenClosed(s: Session) {
	const { pane, oldId, oldFile } = await inkedA(s);
	await s.close(pane);
	expect(s.pdfStore.generation(oldId), "precondition: A's ink record was forgotten at the close").toBeNull();
	expect(oldFile, "precondition: A's ink file is on disk").not.toBeNull();
	return { oldId, oldFile };
}

/** Every check, the held ones' retries included, and every identification, to their ends; then every write. */
async function settleAll(s: Session) {
	for (let n = 0; n < 3; n++) await drive(Promise.all([...s.passes.map((p) => p.done), ...s.resolutions]));
	await drive(s.store.flush());
}

// The confirm dialog Delete all opens, recorded: the count it would ask about.
const dialogs = vi.hoisted(() => [] as number[]);
vi.mock("../ink/DeleteAllInk", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		ConfirmDeleteInkModal: class {
			constructor(_app: unknown, count: number) {
				dialogs.push(count);
			}
			open(): void {}
		},
	};
});

/** The shipped words each command says. */
const IDENTIFYING = "Handwriting: still identifying this PDF - try again in a moment";
const FLATTEN_NO_INK = "Handwriting: no ink on this PDF to flatten";
const DELETE_NO_INK = "Handwriting: no ink on this PDF";
const FLATTEN_NOT_READY = "Handwriting: this PDF's ink is not ready - try again in a moment";
const DELETE_NOT_READY = "Handwriting: this PDF's ink storage is not ready. nothing was deleted.";

type Command = { id: string; checkCallback: (checking: boolean) => boolean };

/** Flatten and Delete all as registerExportSelectionCommands registers them, A.pdf the active file; each flatten records
 * the ink ids it would draw, each delete the id it would empty. */
function commandsOn(s: Session) {
	const commands = new Map<string, Command>();
	const flattened: string[][] = [];
	const deleted: string[] = [];
	dialogs.length = 0;
	s.plugin.addCommand = (command: Command) => {
		commands.set(command.id, command);
		return command;
	};
	s.plugin.app.workspace.getActiveFile = () => ({ path: "A.pdf", extension: "pdf", basename: "A", name: "A.pdf" });
	s.plugin.flattenPdf = async (_file: unknown, of: string) => void flattened.push(ids(s.pdfStore.strokes(of)).sort());
	s.plugin.deleteAllPdfInk = async (of: string) => void deleted.push(of);
	s.plugin.registerExportSelectionCommands();
	const run = (name: string) => expect(commands.get(name)!.checkCallback(false), `premise: ${name} ran`).toBe(true);
	return { flatten: () => run("flatten-pdf-ink"), deleteAll: () => run("delete-all-pdf-ink"), flattened, deleted };
}

/** A inked and closed, A changed while no tab showed it, and a tab opening it whose carry waits on the old ink file's
 * load: the tab is on its new id, which is ready and holds nothing yet. */
async function openingInCarry(s: Session) {
	const { oldId, oldFile } = await inkedAThenClosed(s);
	version(s, 1);
	const hold = s.holdLoad(oldId);
	const opening = s.startOpen("A.pdf");
	await until(() => hold.reached());
	expect(hold.reached(), "precondition: the open's carry is loading A's old ink file").toBe(true);
	const fresh = s.plugin.pdfIds.get(opening.root) as string | undefined;
	expect(fresh, "precondition: the opening chose a new id for the new bytes").toBeDefined();
	expect(fresh, "precondition: the opening chose a new id for the new bytes").not.toBe(oldId);
	expect(s.pdfStore.inkReady(fresh!), "precondition: the new id is ready").toBe(true);
	expect(s.pdfStore.hasInk(fresh!), "precondition: nothing carried yet").toBe(false);
	shown.length = 0;
	return { oldId, oldFile, hold, opening, fresh: fresh! };
}

/** Release the held load and run the opening to its end: the carry lands, said once. The words said in the wait were
 * checked by the cell; only what the opening's end says is counted here. */
async function openingEnds(s: Session, w: Awaited<ReturnType<typeof openingInCarry>>) {
	shown.length = 0;
	w.hold.release();
	await settleAll(s);
	expect(s.plugin.pdfIds.get(w.opening.root), "precondition: the tab stayed on the new id").toBe(w.fresh);
	expect(s.saved(w.oldId), "the old ink file is never written").toBe(w.oldFile);
	expect(shown, "precondition: the opening carried A's ink, said once").toEqual([CARRIED_NOTICE]);
	shown.length = 0;
}

it("Flatten in an opening's carry wait desktop: says still identifying and makes no copy; once the opening ends, it takes A's carried ink", async () => {
	const s = session("desktop");
	const c = commandsOn(s);
	const w = await openingInCarry(s);
	c.flatten();
	expect(shown, "Flatten in the wait said the wrong words").toEqual([IDENTIFYING]);
	expect(c.flattened, "Flatten in the wait made a copy").toEqual([]);
	await openingEnds(s, w);
	c.flatten();
	expect(shown, "the refusal outlived the opening").toEqual([]);
	expect(c.flattened, "once the opening ended, Flatten takes A's carried ink").toEqual([["a-ink"]]);
});

it("Flatten in an opening's carry wait mobile: says still identifying and makes no copy; once the opening ends, it takes A's carried ink", async () => {
	const s = session("mobile");
	const c = commandsOn(s);
	const w = await openingInCarry(s);
	c.flatten();
	expect(shown, "Flatten in the wait said the wrong words").toEqual([IDENTIFYING]);
	expect(c.flattened, "Flatten in the wait made a copy").toEqual([]);
	await openingEnds(s, w);
	c.flatten();
	expect(shown, "the refusal outlived the opening").toEqual([]);
	expect(c.flattened, "once the opening ended, Flatten takes A's carried ink").toEqual([["a-ink"]]);
});

it("Flatten in an opening's carry wait with a stroke drawn on the blank page first: says still identifying and makes no copy of the stroke alone; once the opening ends, it takes A's ink and the stroke", async () => {
	const s = session("desktop");
	const c = commandsOn(s);
	const w = await openingInCarry(s);
	s.pdfStore.commit(w.fresh, stroke("drawn"));
	c.flatten();
	expect(shown, "Flatten in the wait said the wrong words").toEqual([IDENTIFYING]);
	expect(c.flattened, "Flatten in the wait made a copy of the stroke alone").toEqual([]);
	await openingEnds(s, w);
	c.flatten();
	expect(shown, "the refusal outlived the opening").toEqual([]);
	expect(c.flattened, "once the opening ended, Flatten takes A's ink and the stroke").toEqual([["a-ink", "drawn"]]);
});

it("Delete all in an opening's carry wait: says still identifying and opens no dialog; once the opening ends, it asks about A's carried ink", async () => {
	const s = session("desktop");
	const c = commandsOn(s);
	const w = await openingInCarry(s);
	c.deleteAll();
	expect(shown, "Delete all in the wait said the wrong words").toEqual([IDENTIFYING]);
	expect(dialogs, "Delete all in the wait opened its dialog").toEqual([]);
	await openingEnds(s, w);
	c.deleteAll();
	expect(shown, "the refusal outlived the opening").toEqual([]);
	expect(dialogs, "once the opening ended, Delete all asks about A's carried ink").toEqual([1]);
	expect(c.deleted, "nothing deleted without the dialog's yes").toEqual([]);
});

it("Delete all in an opening's carry wait with a stroke drawn on the blank page first: says still identifying and asks about nothing; once the opening ends, it asks about A's ink and the stroke", async () => {
	const s = session("desktop");
	const c = commandsOn(s);
	const w = await openingInCarry(s);
	s.pdfStore.commit(w.fresh, stroke("drawn"));
	c.deleteAll();
	expect(shown, "Delete all in the wait said the wrong words").toEqual([IDENTIFYING]);
	expect(dialogs, "Delete all in the wait asked about the stroke alone").toEqual([]);
	await openingEnds(s, w);
	c.deleteAll();
	expect(shown, "the refusal outlived the opening").toEqual([]);
	expect(dialogs, "once the opening ended, Delete all asks about A's ink and the stroke").toEqual([2]);
});

it("pin: an opening that throws in its carry leaves no refusal behind; Flatten and Delete all say what the tab holds", async () => {
	const s = session("desktop");
	const c = commandsOn(s);
	const { oldId } = await inkedAThenClosed(s);
	version(s, 1);
	const read = s.store.readPdfClaim.bind(s.store);
	s.store.readPdfClaim = (async (id: string) => {
		if (id === oldId) throw new Error("the old ink file's claim could not be read");
		return read(id);
	}) as typeof s.store.readPdfClaim;
	const opening = s.startOpen("A.pdf");
	let failed = false;
	await drive(opening.done.catch(() => void (failed = true)));
	expect(failed, "precondition: the opening threw").toBe(true);
	const now = s.plugin.pdfIds.get(opening.root) as string | undefined;
	expect(now, "precondition: the tab is on the new id the opening chose").toBeDefined();
	expect(now, "precondition: the tab is on the new id the opening chose").not.toBe(oldId);
	shown.length = 0;
	c.flatten();
	c.deleteAll();
	expect(shown, "a failed opening left its refusal behind").toEqual([FLATTEN_NO_INK, DELETE_NO_INK]);
	expect(c.flattened).toEqual([]);
	expect(dialogs).toEqual([]);
});

it("pin: an unchanged PDF whose own ink file is still loading at its open keeps the not-ready words", async () => {
	const s = session("desktop");
	const c = commandsOn(s);
	const { oldId } = await inkedAThenClosed(s);
	const hold = s.holdLoad(oldId);
	const opening = s.startOpen("A.pdf");
	await until(() => hold.reached());
	expect(hold.reached(), "precondition: the open is loading A's own ink file").toBe(true);
	expect(s.plugin.pdfIds.get(opening.root), "precondition: the open took A's own ink file").toBe(oldId);
	shown.length = 0;
	c.flatten();
	c.deleteAll();
	expect(shown, "an unchanged PDF's load lost its not-ready words").toEqual([FLATTEN_NOT_READY, DELETE_NOT_READY]);
	hold.release();
	await settleAll(s);
	shown.length = 0;
	c.flatten();
	expect(shown).toEqual([]);
	expect(c.flattened, "once loaded, Flatten takes A's ink").toEqual([["a-ink"]]);
});
