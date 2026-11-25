// The kept notice at an open, for an old ink file this plugin cannot read, said once per app session.
//
// A PDF's ink file was written by a newer plugin (another device on a later version), so this plugin reads it as a newer
// schema and locks its record: never ready, never written. Then the PDF's bytes changed while no tab showed it. An open
// chooses a fresh id for the new bytes, finds the old file still claiming the path, and its carry cannot read it, so it
// says the kept notice ("Handwriting: this PDF changed on disk. Ink drawn before the change is kept in its old ink file;
// new ink goes to a new one."). Nothing remembered that: the fresh id writes no file until its first stroke, the close
// forgets it, and the locked record stays locked. So every later open, and a tab switched back, said it again, though the
// PDF had not changed since.
//
// Want: at an open, the kept notice shows at most once per app session for one PDF path and one old ink file. Pins (green
// before the fix, and after): one open says it once; a second PDF in the same state still says its own. A change on disk
// seen by an open pane says its own notice by its own road (onPdfModified), which these cells do not drive. Once per app
// start remains: a new session says it again.
//
// The rig is PdfChangedWhileOpening.test.ts's, unchanged (copied by tools/gen-cells.sh, lines 35-321 less the constants
// and the helper these cells do not use). The newer schema is made by rewriting the ink file's own "schemaVersion" from
// 1 to 3 on disk.
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

const KEPT_NOTICE = "Handwriting: this PDF changed on disk. Ink drawn before the change is kept in its old ink file; new ink goes to a new one.";

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

/** Rewrite `id`'s ink file as a newer schema wrote it: this plugin cannot read it, so its record is locked. */
async function lockAsNewer(s: Session, id: string, file: string | null): Promise<string> {
	expect(file, "precondition: the ink file is on disk").not.toBeNull();
	const locked = file!.replace(/"schemaVersion":1\b/, '"schemaVersion":3');
	expect(locked, "precondition: the ink file now declares a newer schema").not.toBe(file);
	await drive(s.adapter.write(s.store.path(id), locked));
	expect(s.saved(id), "precondition: the newer-schema bytes are on disk").toBe(locked);
	return locked;
}

/** A with one stroke saved and its tab closed, A's ink file then locked as newer, then A changed while no tab showed it. */
async function aLockedThenChanged(s: Session) {
	const { oldId, oldFile } = await inkedAThenClosed(s);
	const locked = await lockAsNewer(s, oldId, oldFile);
	version(s, 1);
	return { oldId, locked };
}

/** As aLockedThenChanged, for B. */
async function bLockedThenChanged(s: Session) {
	const pane = await s.open("B.pdf");
	s.pdfStore.commit(pane.id, stroke("b-ink"));
	await drive(s.store.flush());
	const file = s.saved(pane.id);
	await s.close(pane);
	expect(s.pdfStore.generation(pane.id), "precondition: B's ink record was forgotten at the close").toBeNull();
	const locked = await lockAsNewer(s, pane.id, file);
	const changed = s.pdfs.get("B.pdf")!.slice();
	changed[100] = 111;
	s.pdfs.set("B.pdf", changed);
	return { oldId: pane.id, locked };
}

/** Open A, close it, open it again, in one session: the second open is on the same new version, nothing carried. */
async function openCloseOpen(s: Session) {
	const { oldId, locked } = await aLockedThenChanged(s);
	shown.length = 0;
	const first = await s.open("A.pdf");
	expect(first.id, "precondition: the open chose a new id for the new bytes").not.toBe(oldId);
	expect(shown, "precondition: the first open says the kept notice").toEqual([KEPT_NOTICE]);
	await s.close(first);
	const second = await s.open("A.pdf");
	expect(second.id, "precondition: the second open is on A's new version again").toBe(first.id);
	expect(ids(s.pdfStore.strokes(second.id)), "nothing carried").toEqual([]);
	expect(s.saved(oldId), "the old ink file is never written").toBe(locked);
}

it("open, close, open again desktop: A's old ink file is newer-format and A changed while closed; the kept notice once in the session, not at every open", async () => {
	const s = session("desktop");
	await openCloseOpen(s);
	expect(shown, "the second open said the kept notice again").toEqual([KEPT_NOTICE]);
});

it("open, close, open again mobile: A's old ink file is newer-format and A changed while closed; the kept notice once in the session, not at every open", async () => {
	const s = session("mobile");
	await openCloseOpen(s);
	expect(shown, "the second open said the kept notice again").toEqual([KEPT_NOTICE]);
});

it("a tab switched to B and back to A: A's old ink file is newer-format and A changed while closed; the kept notice once, not again at the switch back", async () => {
	const s = session("desktop");
	await aLockedThenChanged(s);
	shown.length = 0;
	const pane = await s.open("A.pdf");
	expect(shown, "precondition: the open says the kept notice").toEqual([KEPT_NOTICE]);
	s.switchTo(pane, "B.pdf");
	await settleAll(s);
	s.switchTo(pane, "A.pdf");
	await settleAll(s);
	expect(s.plugin.pdfIds.get(pane.root), "precondition: the tab is back on A's new version").toBe(pane.id);
	expect(shown, "the switch back said the kept notice again").toEqual([KEPT_NOTICE]);
});

it("pin: one open of A in that state says the kept notice once, carries nothing and writes nothing", async () => {
	const s = session("desktop");
	const { oldId, locked } = await aLockedThenChanged(s);
	shown.length = 0;
	const pane = await s.open("A.pdf");
	await settleAll(s);
	expect(shown, "one open, the kept notice once").toEqual([KEPT_NOTICE]);
	expect(ids(s.pdfStore.strokes(pane.id))).toEqual([]);
	expect(s.saved(oldId)).toBe(locked);
});

it("pin: a second PDF in the same state still says its own kept notice after A's", async () => {
	const s = session("desktop");
	await aLockedThenChanged(s);
	await bLockedThenChanged(s);
	shown.length = 0;
	await s.open("A.pdf");
	expect(shown, "precondition: A's open says the kept notice").toEqual([KEPT_NOTICE]);
	await s.open("B.pdf");
	expect(shown, "B's open said nothing after A's").toEqual([KEPT_NOTICE, KEPT_NOTICE]);
});
