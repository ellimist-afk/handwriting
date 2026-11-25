// A PDF with ink changes on disk while one of its panes is still being identified: by the pane's own opening (a tab
// restored at launch while a sync lands the PDF's new version, a slow head read, a fresh open's carry still reading the
// old version's ink file), or by an earlier change check that could not start a new identification because the view
// had no file at that instant.
//
// The opening cells: the change check meets a pane whose opening has not ended. The check takes no ink for it (the pane
// has no id yet, or an id whose ink is still loading, or a fresh id with no ink), identifies the pane again with the
// old-version carry off, and the newer token ends the opening before the opening's own carry runs. The tab shows the
// new version blank and nothing is said; a stroke drawn then gives the new version an ink file of its own, and the old
// ink stays hidden. The opening-carry stroke cells draw that stroke before the check, while the open's carry waits: the
// new id has ink, and the old ink must still be carried beside it.
//
// The no-file cells: a second change check while the first check's identification runs, at an instant the view has no
// file. The second check takes over the first check's record, starts no identification (resolvePdfId returns before it
// takes a token), and drops the record at once. The tab ends blank with nothing said, and on desktop on the middle
// version's id.
//
// The lone no-file cells: one change check, and the view has no file at that instant. The check takes the pane's ink and
// drops its id, and the identification it starts returns before it takes a token. The tab ends blank with nothing said,
// and nothing identifies it again when its file is back at the same path: the plugin's sync sees the path it already has.
//
// The past-the-wait cell: the old ink file's load still runs when the check's carry asks for it, and goes on past the
// carry's one wait (PdfInkStore.settle, 2,000 ms). The carry returns with nothing, and nothing is said.
//
// Want: the tab ends on the PDF's newest version showing the ink, with the carried notice said once for each carry made
// (on desktop's no-file cell two: into the middle version, then into the newest), and A's next open shows the ink. The
// old ink file is never written. A view left with no file keeps its ink, and the asking stops by itself: no wait is
// left running. Past the wait, nothing is carried and the kept notice is said once. Pins (green before the fix, and
// after): a pane switched to another PDF gets nothing, a check over unchanged bytes during an opening carries nothing,
// two panes with one still opening carry once, a PDF no ink file claims opens with nothing said.
//
// The rig is PdfChangedTwiceKeepsInk.test.ts's, unchanged, with four helpers: an opening started and not driven to its
// end, a pane closed the way syncPdfControllers sweeps one, a hold on one ink file's load (PageStore.load, the read
// PdfInkStore's record waits on), and a wait for a condition on the fake clock.
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
const KEPT_NOTICE = "Handwriting: this PDF changed on disk. Ink drawn before the change is kept in its old ink file; new ink goes to a new one.";
/** The carry's one wait on loads in flight: PdfInkStore.settle's cap, ms on the fake clock. */
const SETTLE_CAP_MS = 2_000;

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
/** How long after a step the next one lands: inside the changed PDF's head read on both platforms. */
const STEP_MS = 10;

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

const identified = (s: Session, path: string) => s.events.filter((e) => e === `identified ${path}`).length;

/** The want on a tab that stayed on A: A's ink on its newest version (`want`, in any order), the carried notice once for
 * each carry made, and the same ink at A's next open. */
async function expectCarried(s: Session, root: HTMLElement, oldId: string, oldFile: string | null, notices = [CARRIED_NOTICE],
	want = ["a-ink"]) {
	const now = s.plugin.pdfIds.get(root) as string | undefined;
	expect(now, "precondition: the tab is on an id").toBeDefined();
	expect(now, "precondition: the tab is on a new id").not.toBe(oldId);
	expect(s.saved(oldId), "the old ink file is never written").toBe(oldFile);
	expect.soft(ids(s.pdfStore.strokes(now!)).sort(), "the tab shows A's ink on the new version").toEqual(want);
	expect.soft(shown, "said once for each carry made, the carry's own notice").toEqual(notices);
	const again = await s.open("A.pdf");
	expect.soft(again.id, "the tab is on A's newest version, the one a new tab opens").toBe(now);
	expect.soft(ids(s.pdfStore.strokes(again.id)).sort(), "A's next open shows its ink").toEqual(want);
}

/** The ink ids in `id`'s ink file on disk, sorted; null when there is no file. */
function onDisk(s: Session, id: string): string[] | null {
	const raw = s.saved(id);
	return raw === null ? null : ids(parsePage(raw, id).data.strokes).sort();
}

// The opening cells: the change check meets a pane whose opening has not ended, in each of three states.

it("opening-load desktop, one pane: A opens with its ink file's load held, and A changes; the tab shows A's ink on the new version, said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile } = await inkedAThenClosed(s);
	const hold = s.holdLoad(oldId);
	const opening = s.startOpen("A.pdf");
	await until(() => hold.reached());
	expect(hold.reached(), "precondition: the opening is loading A's ink file").toBe(true);
	expect(s.plugin.pdfIds.get(opening.root), "precondition: the opening set A's id before the load").toBe(oldId);
	expect(s.pdfStore.hasInk(oldId), "precondition: no ink in the record yet, its load is held").toBe(false);
	expect(identified(s, "A.pdf"), "precondition: only the first tab's identification ended").toBe(1);
	shown.length = 0;
	version(s, 1);
	s.plugin.onPdfModified("A.pdf");
	hold.release();
	await settleAll(s);
	await expectCarried(s, opening.root, oldId, oldFile);
});

it("opening-head desktop, one pane: A opens with its head read slow, and A changes during that read; the tab shows A's ink on the new version, said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile } = await inkedAThenClosed(s);
	s.slowHeadFor("A.pdf");
	const opening = s.startOpen("A.pdf");
	await vi.advanceTimersByTimeAsync(STEP_MS);
	expect(s.plugin.pdfIds.get(opening.root), "precondition: the opening has no id yet, its head read runs").toBeUndefined();
	expect(identified(s, "A.pdf"), "precondition: only the first tab's identification ended").toBe(1);
	shown.length = 0;
	version(s, 1);
	s.plugin.onPdfModified("A.pdf");
	await settleAll(s);
	await expectCarried(s, opening.root, oldId, oldFile);
});

it("opening-head mobile, one pane: A opens with its whole read queued, and A changes during that read; the tab shows A's ink on the new version, said once", async () => {
	const s = session("mobile");
	const { oldId, oldFile } = await inkedAThenClosed(s);
	const opening = s.startOpen("A.pdf");
	await vi.advanceTimersByTimeAsync(STEP_MS);
	expect(s.plugin.pdfIds.get(opening.root), "precondition: the opening has no id yet, its whole read runs").toBeUndefined();
	expect(identified(s, "A.pdf"), "precondition: only the first tab's identification ended").toBe(1);
	shown.length = 0;
	version(s, 1);
	s.plugin.onPdfModified("A.pdf");
	await settleAll(s);
	await expectCarried(s, opening.root, oldId, oldFile);
});

it("opening-carry desktop, one pane: A changed while no tab showed it; a tab opens it, and the change's check lands while the open's carry loads the old ink file; the tab shows A's ink on the new version, said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile } = await inkedAThenClosed(s);
	version(s, 1);
	const hold = s.holdLoad(oldId);
	const opening = s.startOpen("A.pdf");
	await until(() => hold.reached());
	expect(hold.reached(), "precondition: the open's carry is loading A's old ink file").toBe(true);
	const fresh = s.plugin.pdfIds.get(opening.root) as string | undefined;
	expect(fresh, "precondition: the opening chose a new id for the new bytes").toBeDefined();
	expect(fresh, "precondition: the opening chose a new id for the new bytes").not.toBe(oldId);
	expect(s.pdfStore.hasInk(fresh!), "precondition: no ink carried yet").toBe(false);
	expect(identified(s, "A.pdf"), "precondition: only the first tab's identification ended").toBe(1);
	shown.length = 0;
	s.plugin.onPdfModified("A.pdf");
	hold.release();
	await settleAll(s);
	await expectCarried(s, opening.root, oldId, oldFile);
});

it("opening-carry slow old ink desktop, one pane: as opening-carry, and A changes again while the old ink file still loads, the change's check asking for that file before its load ends; the tab shows A's ink on the newest version, said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile } = await inkedAThenClosed(s);
	version(s, 1);
	const hold = s.holdLoad(oldId);
	const opening = s.startOpen("A.pdf");
	await until(() => hold.reached());
	expect(hold.reached(), "precondition: the open's carry is loading A's old ink file").toBe(true);
	shown.length = 0;
	const asked = () => s.events.filter((e) => e === `load ${oldId}`).length;
	const before = asked();
	version(s, 2);
	s.plugin.onPdfModified("A.pdf");
	await until(() => asked() > before);
	expect(asked(), "precondition: the check's carry asked for the old ink file while its load still runs").toBeGreaterThan(before);
	hold.release();
	await settleAll(s);
	await expectCarried(s, opening.root, oldId, oldFile);
});

/** As opening-carry slow old ink, up to the change's check asking for the old ink file while its load still runs; the
 * load stays held, and the check's carry waits on it from this instant. */
async function checkAsksWhileOldInkLoads(s: Session) {
	const { oldId, oldFile } = await inkedAThenClosed(s);
	version(s, 1);
	const hold = s.holdLoad(oldId);
	const opening = s.startOpen("A.pdf");
	await until(() => hold.reached());
	expect(hold.reached(), "precondition: the open's carry is loading A's old ink file").toBe(true);
	shown.length = 0;
	const asked = () => s.events.filter((e) => e === `load ${oldId}`).length;
	const before = asked();
	version(s, 2);
	s.plugin.onPdfModified("A.pdf");
	await until(() => asked() > before);
	expect(asked(), "precondition: the check's carry asked for the old ink file while its load still runs").toBeGreaterThan(before);
	return { oldId, oldFile, hold, opening };
}

it("opening-carry slow old ink mobile, one pane: as opening-carry, and A changes again while the old ink file still loads, the change's check asking for that file before its load ends; the tab shows A's ink on the newest version, said once", async () => {
	const s = session("mobile");
	const { oldId, oldFile, hold, opening } = await checkAsksWhileOldInkLoads(s);
	hold.release();
	await settleAll(s);
	await expectCarried(s, opening.root, oldId, oldFile);
});

it("opening-carry old ink past the wait desktop, one pane: as opening-carry slow old ink, and the old ink file's load runs on past the check's one wait; nothing is carried, the old ink file is kept, the kept notice said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile, hold, opening } = await checkAsksWhileOldInkLoads(s);
	await vi.advanceTimersByTimeAsync(SETTLE_CAP_MS + 100);
	hold.release();
	await settleAll(s);
	const now = s.plugin.pdfIds.get(opening.root) as string | undefined;
	expect(now, "precondition: the tab is on an id").toBeDefined();
	expect(now, "precondition: the tab is on a new id").not.toBe(oldId);
	expect(s.saved(oldId), "the old ink file is never written").toBe(oldFile);
	expect.soft(ids(s.pdfStore.strokes(now!)), "ink carried past the wait").toEqual([]);
	expect.soft(shown, "said once, the kept notice").toEqual([KEPT_NOTICE]);
});

it("opening-carry old ink inside the wait desktop, one pane: as opening-carry slow old ink, and the old ink file's load ends just inside the check's one wait; the tab shows A's ink on the newest version, said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile, hold, opening } = await checkAsksWhileOldInkLoads(s);
	await vi.advanceTimersByTimeAsync(SETTLE_CAP_MS - 100);
	hold.release();
	await settleAll(s);
	await expectCarried(s, opening.root, oldId, oldFile);
});

// The opening-carry road with a stroke drawn on the blank page while the open's carry loads the old ink file: the pen
// needs only the id (PdfInkPenPath.ts:131), so the stroke lands in the opening's new id, which then has ink, and is the
// newest ink file that claims A's path.

/** As opening-carry: A changed while closed, a tab opens it, and its carry waits on the old ink file's load; then a
 * stroke is drawn and lifted on the blank page, into the opening's new id, and saved. */
async function strokeWhileCarryLoads(s: Session) {
	const { oldId, oldFile } = await inkedAThenClosed(s);
	version(s, 1);
	const hold = s.holdLoad(oldId);
	const opening = s.startOpen("A.pdf");
	await until(() => hold.reached());
	expect(hold.reached(), "precondition: the open's carry is loading A's old ink file").toBe(true);
	const fresh = s.plugin.pdfIds.get(opening.root) as string | undefined;
	expect(fresh, "precondition: the opening chose a new id for the new bytes").toBeDefined();
	expect(fresh, "precondition: the opening chose a new id for the new bytes").not.toBe(oldId);
	s.pdfStore.commit(fresh!, stroke("s-ink"));
	await drive(s.store.flush());
	expect(onDisk(s, fresh!), "precondition: the stroke is saved in the opening's new id").toEqual(["s-ink"]);
	expect(hold.reached() && identified(s, "A.pdf") === 1, "precondition: the open's carry still waits").toBe(true);
	return { oldId, oldFile, hold, opening, fresh: fresh! };
}

it("opening-carry stroke desktop, one pane: as opening-carry, with a stroke drawn on the blank page while the carry loads; the tab shows A's ink and the stroke on the new version, on disk too, said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile, hold, opening, fresh } = await strokeWhileCarryLoads(s);
	shown.length = 0;
	s.plugin.onPdfModified("A.pdf");
	hold.release();
	await settleAll(s);
	expect(s.plugin.pdfIds.get(opening.root), "precondition: same bytes, the tab stays on the opening's new id").toBe(fresh);
	expect.soft(onDisk(s, fresh), "the new version's ink file holds A's ink and the stroke").toEqual(["a-ink", "s-ink"]);
	await expectCarried(s, opening.root, oldId, oldFile, [CARRIED_NOTICE], ["a-ink", "s-ink"]);
});

it("opening-carry stroke then changed desktop, one pane: as opening-carry stroke, and A changes again before the check; the tab shows A's ink and the stroke on the newest version, on disk too, said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile, hold, opening, fresh } = await strokeWhileCarryLoads(s);
	shown.length = 0;
	version(s, 2);
	s.plugin.onPdfModified("A.pdf");
	hold.release();
	await settleAll(s);
	const now = s.plugin.pdfIds.get(opening.root) as string | undefined;
	expect(now, "precondition: the tab is on the newest version's id").toBeDefined();
	expect(now, "precondition: the tab is on the newest version's id").not.toBe(fresh);
	expect.soft(onDisk(s, now!), "the newest version's ink file holds A's ink and the stroke").toEqual(["a-ink", "s-ink"]);
	await expectCarried(s, opening.root, oldId, oldFile, [CARRIED_NOTICE], ["a-ink", "s-ink"]);
});

/** As opening-carry stroke, then A changes and a first check runs; it waits until that check chose the new version's
 * id and loaded its record, and goes on to its carry, with the old ink file's load still held. */
async function strokeThenCheckWaits(s: Session) {
	const was = await strokeWhileCarryLoads(s);
	shown.length = 0;
	version(s, 2);
	s.plugin.onPdfModified("A.pdf");
	const tabId = () => s.plugin.pdfIds.get(was.opening.root) as string | undefined;
	await until(() => tabId() !== undefined && tabId() !== was.fresh && s.events.includes(`loaded ${tabId()}`));
	expect(tabId(), "precondition: the first check chose the changed version's id").toBeDefined();
	expect(tabId(), "precondition: the first check chose the changed version's id").not.toBe(was.fresh);
	expect(s.events, "precondition: the first check loaded the changed version's record").toContain(`loaded ${tabId()}`);
	expect(identified(s, "A.pdf"), "precondition: the open and the first check still run").toBe(1);
	return { ...was, middle: tabId()! };
}

it("opening-carry stroke changed twice desktop, one pane: as opening-carry stroke, and A changes twice before the old ink file loads, each change checked; the tab shows A's ink and the stroke on the newest version, on disk too, said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile, hold, opening, fresh, middle } = await strokeThenCheckWaits(s);
	version(s, 3);
	s.plugin.onPdfModified("A.pdf");
	hold.release();
	await settleAll(s);
	const now = s.plugin.pdfIds.get(opening.root) as string | undefined;
	expect(now, "precondition: the tab is on the newest version's id").toBeDefined();
	expect([fresh, middle], "precondition: the tab is on the newest version's id").not.toContain(now);
	expect.soft(onDisk(s, now!), "the newest version's ink file holds A's ink and the stroke").toEqual(["a-ink", "s-ink"]);
	await expectCarried(s, opening.root, oldId, oldFile, [CARRIED_NOTICE], ["a-ink", "s-ink"]);
});

it("opening-carry stroke changed then same bytes desktop, one pane: as opening-carry stroke, and A changes once before the old ink file loads, checked twice; the tab shows A's ink and the stroke on the changed version, on disk too, said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile, hold, opening, middle } = await strokeThenCheckWaits(s);
	s.plugin.onPdfModified("A.pdf");
	hold.release();
	await settleAll(s);
	expect(s.plugin.pdfIds.get(opening.root), "precondition: same bytes, the tab stays on the changed version's id").toBe(middle);
	expect.soft(onDisk(s, middle), "the changed version's ink file holds A's ink and the stroke").toEqual(["a-ink", "s-ink"]);
	await expectCarried(s, opening.root, oldId, oldFile, [CARRIED_NOTICE], ["a-ink", "s-ink"]);
});

it("opening-then-again desktop, one pane: A changes during the opening's head read, and again during the check's own identification; the tab shows A's ink on the newest version, said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile } = await inkedAThenClosed(s);
	s.slowHeadFor("A.pdf");
	const opening = s.startOpen("A.pdf");
	await vi.advanceTimersByTimeAsync(STEP_MS);
	shown.length = 0;
	version(s, 1);
	s.plugin.onPdfModified("A.pdf");
	await vi.advanceTimersByTimeAsync(STEP_MS);
	expect(s.plugin.pdfIds.get(opening.root), "precondition: the first check's identification has no id yet").toBeUndefined();
	expect(identified(s, "A.pdf"), "precondition: only the first tab's identification ended").toBe(1);
	version(s, 2);
	s.plugin.onPdfModified("A.pdf");
	await settleAll(s);
	await expectCarried(s, opening.root, oldId, oldFile);
});

// The no-file cells: the second check finds the view with no file, so it starts no identification of the pane.

it("no-file desktop, one pane: A changes, and changes again during the first check's slow head read at an instant the view has no file; the tab shows A's ink on the newest version, said once for each of the two carries", async () => {
	const s = session("desktop");
	const { pane, oldId, oldFile } = await inkedA(s);
	s.slowHeadFor("A.pdf");
	shown.length = 0;
	version(s, 1);
	s.plugin.onPdfModified("A.pdf");
	await vi.advanceTimersByTimeAsync(STEP_MS);
	expect(identified(s, "A.pdf"), "precondition: the first check's identification still runs").toBe(1);
	version(s, 2);
	const file = pane.leaf.view.file;
	pane.leaf.view.file = undefined;
	s.plugin.onPdfModified("A.pdf");
	pane.leaf.view.file = file;
	await settleAll(s);
	// The first check's open handle reads the middle version's head, so the ink is carried there and then to the newest.
	await expectCarried(s, pane.root, oldId, oldFile, [CARRIED_NOTICE, CARRIED_NOTICE]);
});

it("no-file mobile, one pane: A changes, and changes again during the first check's queued whole read at an instant the view has no file; the tab shows A's ink on the newest version, said once", async () => {
	const s = session("mobile");
	const { pane, oldId, oldFile } = await inkedA(s);
	shown.length = 0;
	version(s, 1);
	s.plugin.onPdfModified("A.pdf");
	await vi.advanceTimersByTimeAsync(STEP_MS);
	expect(identified(s, "A.pdf"), "precondition: the first check's identification still runs").toBe(1);
	version(s, 2);
	const file = pane.leaf.view.file;
	pane.leaf.view.file = undefined;
	s.plugin.onPdfModified("A.pdf");
	pane.leaf.view.file = file;
	await settleAll(s);
	await expectCarried(s, pane.root, oldId, oldFile);
});

// The lone no-file cells: one change check, and the view has no file at that instant; then the file is back at once,
// never, or later. The never cell is green before the fix too: it is the hold's end, and reds only on a hold that never
// stops asking.

it("lone no-file desktop, one pane: A changes once, at an instant the view has no file; the tab shows A's ink on the new version, said once", async () => {
	const s = session("desktop");
	const { pane, oldId, oldFile } = await inkedA(s);
	shown.length = 0;
	version(s, 1);
	const file = pane.leaf.view.file;
	pane.leaf.view.file = undefined;
	s.plugin.onPdfModified("A.pdf");
	pane.leaf.view.file = file;
	await settleAll(s);
	expect(s.plugin.pdfIds.get(pane.root), "the tab, its file back, is left with no ink id: blank, and drawing on it does nothing").toBeDefined();
	await expectCarried(s, pane.root, oldId, oldFile);
});

it("no-file for good desktop, one pane: A changes once, at an instant the view has no file, and the view stays with no file; no wait is left asking, the old ink file is kept, and A's next open shows its ink, said once", async () => {
	const s = session("desktop");
	const { pane, oldId, oldFile } = await inkedA(s);
	shown.length = 0;
	version(s, 1);
	pane.leaf.view.file = undefined;
	s.plugin.onPdfModified("A.pdf");
	await settleAll(s);
	expect(s.plugin.pdfModifyTimers?.size ?? 0, "a wait is left asking again for a view with no file").toBe(0);
	expect(s.saved(oldId), "the old ink file is never written").toBe(oldFile);
	const again = await s.open("A.pdf");
	expect.soft(again.id, "A's newest bytes, a new ink id").not.toBe(oldId);
	expect.soft(ids(s.pdfStore.strokes(again.id)), "A's next open shows its ink").toEqual(["a-ink"]);
	expect.soft(shown, "said once, the carry's own notice").toEqual([CARRIED_NOTICE]);
	expect(s.saved(oldId), "the old ink file is never written").toBe(oldFile);
});

it("no-file back later desktop, one pane: A changes once, at an instant the view has no file, the view stays with no file past every wait, and its file is back at the same path later; the tab shows A's ink on the new version, said once", async () => {
	const s = session("desktop");
	const { pane, oldId, oldFile } = await inkedA(s);
	shown.length = 0;
	version(s, 1);
	pane.leaf.view.file = undefined;
	s.plugin.onPdfModified("A.pdf");
	await settleAll(s);
	expect(s.plugin.pdfModifyTimers?.size ?? 0, "precondition: no wait is left asking").toBe(0);
	expect(shown, "precondition: nothing said while the view has no file").toEqual([]);
	s.fileBack(pane, "A.pdf");
	await settleAll(s);
	expect(s.plugin.pdfIds.get(pane.root), "the tab, its file back, is left with no ink id: blank, and drawing on it does nothing").toBeDefined();
	await expectCarried(s, pane.root, oldId, oldFile);
});

// Pins: green before the fix and after.

it("opening pin switch desktop, one pane: A changes during the opening's head read, and the tab is switched to B during the check's identification; B gets nothing, nothing is said, and A's next open carries its ink", async () => {
	const s = session("desktop");
	const { oldId, oldFile } = await inkedAThenClosed(s);
	s.slowHeadFor("A.pdf");
	const opening = s.startOpen("A.pdf");
	await vi.advanceTimersByTimeAsync(STEP_MS);
	shown.length = 0;
	version(s, 1);
	s.plugin.onPdfModified("A.pdf");
	await vi.advanceTimersByTimeAsync(STEP_MS);
	expect(identified(s, "A.pdf"), "precondition: the check's identification still runs").toBe(1);
	s.switchTo(opening, "B.pdf");
	await settleAll(s);
	const b = s.plugin.pdfIds.get(opening.root) as string | undefined;
	expect(b, "precondition: the switched tab is on B's own id").toBeDefined();
	expect(b, "precondition: the switched tab is on B's own id").not.toBe(oldId);
	expect(ids(s.pdfStore.strokes(b!)), "B shows A's ink").toEqual([]);
	expect(s.saved(b!), "A's ink was saved to B's ink file").toBeNull();
	expect(shown, "a notice for a tab that left A").toEqual([]);
	expect(s.saved(oldId), "the old ink file is never written").toBe(oldFile);
	const again = await s.open("A.pdf");
	expect(again.id, "A's newest bytes, a new ink id").not.toBe(oldId);
	expect(ids(s.pdfStore.strokes(again.id)), "A's ink did not reach A's newest version at its next open").toEqual(["a-ink"]);
	expect(shown, "A's next open says it carried").toEqual([CARRIED_NOTICE]);
});

it("opening pin same bytes desktop, one pane: A opens with its ink file's load held, and a check runs over unchanged bytes; the tab shows A's ink in its own file, nothing is said", async () => {
	const s = session("desktop");
	const { oldId, oldFile } = await inkedAThenClosed(s);
	const hold = s.holdLoad(oldId);
	const opening = s.startOpen("A.pdf");
	await until(() => hold.reached());
	expect(hold.reached(), "precondition: the opening is loading A's ink file").toBe(true);
	shown.length = 0;
	s.plugin.onPdfModified("A.pdf");
	hold.release();
	await settleAll(s);
	expect(s.plugin.pdfIds.get(opening.root), "the tab stays on A's own ink file").toBe(oldId);
	expect(ids(s.pdfStore.strokes(oldId)), "the tab shows A's ink").toEqual(["a-ink"]);
	expect(shown, "nothing changed, nothing is said").toEqual([]);
	expect(s.saved(oldId), "A's ink file is not written").toBe(oldFile);
});

it("opening pin two panes desktop: A is open and idle in one tab, a second tab is still reading A's head, and A changes; both tabs show A's ink on the new version, said once", async () => {
	const s = session("desktop");
	const { pane, oldId, oldFile } = await inkedA(s);
	s.slowHeadFor("A.pdf");
	const opening = s.startOpen("A.pdf");
	await vi.advanceTimersByTimeAsync(STEP_MS);
	expect(s.plugin.pdfIds.get(opening.root), "precondition: the second tab has no id yet").toBeUndefined();
	shown.length = 0;
	version(s, 1);
	s.plugin.onPdfModified("A.pdf");
	await settleAll(s);
	const now = s.plugin.pdfIds.get(pane.root) as string | undefined;
	expect(now, "precondition: the first tab is on a new id").toBeDefined();
	expect(now, "precondition: the first tab is on a new id").not.toBe(oldId);
	expect(s.plugin.pdfIds.get(opening.root), "both tabs on one id").toBe(now);
	expect(ids(s.pdfStore.strokes(now!)), "both tabs show A's ink").toEqual(["a-ink"]);
	expect(shown, "said once").toEqual([CARRIED_NOTICE]);
	expect(s.saved(oldId), "the old ink file is never written").toBe(oldFile);
});

it("pin no claimant desktop: A has ink and is closed, and B, which no ink file claims, opens for the first time; B is blank, nothing is said", async () => {
	const s = session("desktop");
	const { oldId, oldFile } = await inkedAThenClosed(s);
	shown.length = 0;
	const b = await s.open("B.pdf");
	await settleAll(s);
	expect(b.id, "precondition: B is on its own id").not.toBe(oldId);
	expect(ids(s.pdfStore.strokes(b.id)), "B shows A's ink").toEqual([]);
	expect(shown, "a notice for a PDF no ink file claims").toEqual([]);
	expect(s.saved(oldId), "the old ink file is never written").toBe(oldFile);
});
