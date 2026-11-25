// A PDF that changed while no tab showed it is opened, and left and opened again while its opening still carries the old
// version's ink across.
//
// The open chooses a fresh ink id for the new bytes, claims the path for it, and then carries the old ink file's strokes
// into it, waiting on that file's load. The tab leaves (Back, a switch to another file, or a close) before the load lands,
// and the opening's carry stops at its next check. The tab comes back before the leave forgot the fresh id: the open
// finds the fresh id claiming the path and uses it, as an id nobody owes a carry, so it carries nothing and says nothing.
// The page shows blank, and a stroke drawn before the leave, or after the return, makes the fresh id the newest ink file
// that claims the path, so the old ink never shows again. The same holds for a second tab opened on the PDF during the
// first tab's opening, when the first tab then leaves; and a load of the old ink file past the carry's one capped wait
// (PdfInkStore.settle, 2,000 ms) ends the second caller "kept" while the first open, which started that load, waits all
// of it and carries.
//
// Want: the tab that comes back, or the second tab, shows the old ink once the old ink file's load lands, with one notice
// in all, the carried one; a stroke drawn before the leave or after the return stays beside it, on screen and on disk.
// Still carrying, the path refuses the destructive tools as on a first open. Pins (green before the fix, and after): a
// byte-same copy opened meanwhile gets its own id and nothing; a leave with no return and no stroke writes no ink file;
// an unchanged PDF opened and opened again lists nothing more; two tabs that both stay say one notice and the second runs
// no carry pass of its own; a locked old ink file says the kept notice once, inside the cap; a PDF no ink file claims,
// left and opened again mid-pass, lists no more than before.
//
// The rig is PdfChangedWhileOpening.test.ts's, unchanged (its lines 35-321), with the kept-notice file's lock helper and
// four more: a count of the carry's ink-folder listings, a hold on the next load matching a test, a hold on the carry's
// listing, and the tab leaving and coming back.
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

/** The ink ids in `id`'s ink file on disk, sorted; null when there is no file. */
function onDisk(s: Session, id: string): string[] | null {
	const raw = s.saved(id);
	return raw === null ? null : ids(parsePage(raw, id).data.strokes).sort();
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

/** How long the old ink file's load is held after the leave: inside the carry's one capped wait, and past it. */
const UNDER_CAP_MS = 1_500;
const PAST_CAP_MS = 3_000;

/** Count the carry's listings of every PDF ink file (carryFromOldContent's listIds("pdf-")) from now on. */
function countCarryListings(s: Session): () => number {
	let n = 0;
	const list = s.store.listIds.bind(s.store);
	s.store.listIds = ((prefix: string) => {
		if (prefix === "pdf-") n++;
		return list(prefix);
	}) as typeof s.store.listIds;
	return () => n;
}

/** Hold the next carry listing until released. */
function holdCarryListing(s: Session) {
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => (release = r));
	let reached = false;
	const list = s.store.listIds.bind(s.store);
	s.store.listIds = (async (prefix: string) => {
		if (prefix === "pdf-" && !reached) {
			reached = true;
			await gate;
		}
		return list(prefix);
	}) as typeof s.store.listIds;
	return { reached: () => reached, release: () => release() };
}

/** Hold the next ink file load whose id matches until released; `reached` is that id once it is waiting. */
function holdLoadWhere(s: Session, match: (id: string) => boolean) {
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => (release = r));
	let reached: string | null = null;
	const load = s.store.load.bind(s.store);
	s.store.load = (async (pageId: string, options?: { restore?: boolean }) => {
		if (reached === null && match(pageId)) {
			reached = pageId;
			await gate;
		}
		return load(pageId, options);
	}) as typeof s.store.load;
	return { reached: () => reached, release: () => release() };
}

/** The tab closes at once: the sweep's steps (PdfClaims.ts:359-367), with no time run after it. */
function closeNow(s: Session, tab: { root: HTMLElement; leaf: Leaf }, id: string) {
	(tab.leaf.view as { containerEl?: HTMLElement }).containerEl = undefined;
	s.plugin.pdfInk.delete(tab.root);
	s.plugin.pdfIds.delete(tab.root);
	s.plugin.pdfFiles.delete(tab.root);
	s.plugin.releasePdfId(id);
}

/** The tab goes to B and straight back to A, as Back then Forward. */
async function leaveAndComeBack(s: Session, tab: { leaf: Leaf }) {
	s.switchTo(tab, "B.pdf");
	await vi.advanceTimersByTimeAsync(STEP_MS);
	s.switchTo(tab, "A.pdf");
	await vi.advanceTimersByTimeAsync(STEP_MS);
}

/** A changed while closed; a tab opens it, chooses a new id, claims the path, and its carry waits on the old ink file's
 * held load. */
async function openingCarryWaits(s: Session) {
	const { oldId, oldFile } = await inkedAThenClosed(s);
	version(s, 1);
	const hold = s.holdLoad(oldId);
	const opening = s.startOpen("A.pdf");
	await until(() => hold.reached());
	expect(hold.reached(), "precondition: the open's carry is loading A's old ink file").toBe(true);
	const fresh = s.plugin.pdfIds.get(opening.root) as string | undefined;
	expect(fresh, "precondition: the opening chose a new id for the new bytes").toBeDefined();
	expect(fresh, "precondition: the opening chose a new id for the new bytes").not.toBe(oldId);
	shown.length = 0;
	return { oldId, oldFile, hold, opening, fresh: fresh! };
}

/** The want on the tab: on the opening's new id, A's ink shown and saved (`want`, sorted), the carried notice once. */
function expectOldInkShown(s: Session, root: HTMLElement, fresh: string, oldId: string, oldFile: string | null, want = ["a-ink"]) {
	expect(s.plugin.pdfIds.get(root), "precondition: the tab is on the opening's new id").toBe(fresh);
	expect(s.saved(oldId), "the old ink file is never written").toBe(oldFile);
	expect.soft(ids(s.pdfStore.strokes(fresh)).sort(), "the tab shows A's ink").toEqual(want);
	expect.soft(onDisk(s, fresh), "the new id's ink file holds A's ink").toEqual(want);
	expect.soft(shown, "one notice in all, the carried one").toEqual([CARRIED_NOTICE]);
}

// One tab leaves and comes back while the opening's carry waits.

it("back and forward desktop: a tab opens A, changed while closed, and goes back and forward while its carry waits on the old ink file; once that file loads, the tab shows A's ink, said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile, hold, opening, fresh } = await openingCarryWaits(s);
	await leaveAndComeBack(s, opening);
	await vi.advanceTimersByTimeAsync(UNDER_CAP_MS);
	hold.release();
	await settleAll(s);
	expectOldInkShown(s, opening.root, fresh, oldId, oldFile);
});

it("back and forward past the wait desktop: as back and forward, with the old ink file loading on past the carry's one wait; once it loads, the tab shows A's ink, said once, no kept notice", async () => {
	const s = session("desktop");
	const { oldId, oldFile, hold, opening, fresh } = await openingCarryWaits(s);
	await leaveAndComeBack(s, opening);
	await vi.advanceTimersByTimeAsync(PAST_CAP_MS);
	hold.release();
	await settleAll(s);
	expectOldInkShown(s, opening.root, fresh, oldId, oldFile);
});

it("close and reopen desktop: the tab closes while its carry waits, and a new tab opens A before the close forgot the new id; once the old ink file loads, the new tab shows A's ink, said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile, hold, opening, fresh } = await openingCarryWaits(s);
	closeNow(s, opening, fresh);
	await vi.advanceTimersByTimeAsync(STEP_MS);
	const again = s.startOpen("A.pdf");
	await vi.advanceTimersByTimeAsync(UNDER_CAP_MS);
	hold.release();
	await settleAll(s);
	expectOldInkShown(s, again.root, fresh, oldId, oldFile);
});

it("stroke then back and forward desktop: a stroke drawn on the blank page while the carry waits, then back and forward; the tab shows A's ink and the stroke, on disk too, said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile, hold, opening, fresh } = await openingCarryWaits(s);
	s.pdfStore.commit(fresh, stroke("s-ink"));
	await drive(s.store.flush());
	expect(onDisk(s, fresh), "precondition: the stroke is saved in the opening's new id").toEqual(["s-ink"]);
	await leaveAndComeBack(s, opening);
	await vi.advanceTimersByTimeAsync(UNDER_CAP_MS);
	hold.release();
	await settleAll(s);
	expectOldInkShown(s, opening.root, fresh, oldId, oldFile, ["a-ink", "s-ink"]);
});

it("stroke then close, reopen from disk desktop: a stroke drawn while the carry waits, the tab closes, the close forgets the new id, and A opens again from its ink file while the old ink file still loads; the tab shows A's ink and the stroke, said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile, hold, opening, fresh } = await openingCarryWaits(s);
	s.pdfStore.commit(fresh, stroke("s-ink"));
	await drive(s.store.flush());
	closeNow(s, opening, fresh);
	await vi.advanceTimersByTimeAsync(SETTLE_CAP_MS + 100);
	expect(s.pdfStore.generation(fresh), "precondition: the close forgot the new id's record").toBeNull();
	expect(onDisk(s, fresh), "precondition: the stroke is on disk in the new id").toEqual(["s-ink"]);
	const again = s.startOpen("A.pdf");
	await until(() => s.plugin.pdfIds.get(again.root) !== undefined);
	expect(s.plugin.pdfIds.get(again.root), "precondition: the new tab uses the new id, from disk").toBe(fresh);
	await vi.advanceTimersByTimeAsync(STEP_MS);
	hold.release();
	await settleAll(s);
	expectOldInkShown(s, again.root, fresh, oldId, oldFile, ["a-ink", "s-ink"]);
});

it("back and forward then stroke desktop: back and forward while the carry waits, then a stroke drawn before the old ink file loads; the tab shows A's ink and the stroke, on disk too, said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile, hold, opening, fresh } = await openingCarryWaits(s);
	await leaveAndComeBack(s, opening);
	await until(() => s.plugin.pdfIds.get(opening.root) === fresh);
	expect(s.plugin.pdfIds.get(opening.root), "precondition: the tab is back on the new id").toBe(fresh);
	s.pdfStore.commit(fresh, stroke("s-ink"));
	await vi.advanceTimersByTimeAsync(STEP_MS);
	hold.release();
	await settleAll(s);
	expectOldInkShown(s, opening.root, fresh, oldId, oldFile, ["a-ink", "s-ink"]);
});

it("back and forward twice desktop: back and forward while the carry waits, the old ink lands, then back and forward again; A's ink once, said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile, hold, opening, fresh } = await openingCarryWaits(s);
	await leaveAndComeBack(s, opening);
	await vi.advanceTimersByTimeAsync(UNDER_CAP_MS);
	hold.release();
	await settleAll(s);
	await leaveAndComeBack(s, opening);
	await settleAll(s);
	expectOldInkShown(s, opening.root, fresh, oldId, oldFile);
});

it("tools refused while carrying, back and forward desktop: after the tab comes back and while the carry waits, the path gives no id to the destructive tools; once the carry ends, it gives the new id", async () => {
	const s = session("desktop");
	const { hold, opening, fresh } = await openingCarryWaits(s);
	await leaveAndComeBack(s, opening);
	await until(() => s.plugin.pdfIds.get(opening.root) === fresh);
	expect(s.plugin.pdfIds.get(opening.root), "precondition: the tab is back on the new id").toBe(fresh);
	expect.soft(s.plugin.pdfIdForPath("A.pdf"), "the path gave its id to the tools while the old ink is still to come").toBeNull();
	hold.release();
	await settleAll(s);
	expect.soft(s.plugin.pdfIdForPath("A.pdf"), "the carry ended, the tools get the id").toBe(fresh);
});

it("control, reopen after the forget desktop: the tab closes while the carry waits, the close forgets the new id, and A opens again; a fresh id, A's ink carried, said once", async () => {
	const s = session("desktop");
	const { oldId, oldFile, hold, opening, fresh } = await openingCarryWaits(s);
	closeNow(s, opening, fresh);
	await vi.advanceTimersByTimeAsync(SETTLE_CAP_MS + 100);
	expect(s.pdfStore.generation(fresh), "precondition: the close forgot the new id's record").toBeNull();
	const again = s.startOpen("A.pdf");
	await vi.advanceTimersByTimeAsync(STEP_MS * 5);
	hold.release();
	await settleAll(s);
	const now = s.plugin.pdfIds.get(again.root) as string;
	expect(now, "precondition: the new tab is on a new id").not.toBe(oldId);
	expect(s.saved(oldId), "the old ink file is never written").toBe(oldFile);
	expect.soft(ids(s.pdfStore.strokes(now)), "the new tab shows A's ink").toEqual(["a-ink"]);
	expect.soft(shown, "said once, the carried notice").toEqual([CARRIED_NOTICE]);
});

// A second tab opened on A during the first tab's opening.

async function secondTabDuringCarry(holdMs: number) {
	const s = session("desktop");
	const { oldId, oldFile, hold, opening, fresh } = await openingCarryWaits(s);
	const second = s.startOpen("A.pdf");
	await until(() => s.plugin.pdfIds.get(second.root) === fresh);
	expect(s.plugin.pdfIds.get(second.root), "precondition: the second tab is on the opening's new id").toBe(fresh);
	closeNow(s, opening, fresh);
	await vi.advanceTimersByTimeAsync(holdMs);
	hold.release();
	await settleAll(s);
	expectOldInkShown(s, second.root, fresh, oldId, oldFile);
}

it("second tab, first leaves desktop: a second tab opens A while the first tab's carry waits, and the first tab closes; once the old ink file loads, the second tab shows A's ink, said once", async () => {
	await secondTabDuringCarry(UNDER_CAP_MS);
});

it("second tab, first leaves, past the wait desktop: as second tab, first leaves, with the old ink file loading on past the carry's one wait; the second tab shows A's ink, said once, no kept notice", async () => {
	await secondTabDuringCarry(PAST_CAP_MS);
});

async function twoTabsStay(holdMs: number) {
	const s = session("desktop");
	const { oldId, oldFile, hold, opening, fresh } = await openingCarryWaits(s);
	const listings = countCarryListings(s);
	const second = s.startOpen("A.pdf");
	await until(() => s.plugin.pdfIds.get(second.root) === fresh);
	expect(s.plugin.pdfIds.get(second.root), "precondition: the second tab is on the opening's new id").toBe(fresh);
	await vi.advanceTimersByTimeAsync(holdMs);
	hold.release();
	await settleAll(s);
	expectOldInkShown(s, opening.root, fresh, oldId, oldFile);
	expect(s.plugin.pdfIds.get(second.root), "both tabs on one id").toBe(fresh);
	expect(listings(), "the second tab ran a carry pass of its own").toBe(0);
}

it("pin: two tabs stay desktop: a second tab opens A while the first tab's carry waits, both stay; A's ink once, said once, and the second tab runs no carry pass", async () => {
	await twoTabsStay(UNDER_CAP_MS);
});

it("pin: two tabs stay past the wait desktop: as two tabs stay, with the old ink file loading on past the carry's one wait; one notice, the carried one", async () => {
	await twoTabsStay(PAST_CAP_MS);
});

async function secondTabWhileNewIdLoads(holdMs: number, firstLeaves: boolean) {
	const s = session("desktop");
	const { oldId, oldFile } = await inkedAThenClosed(s);
	version(s, 1);
	const newLoad = holdLoadWhere(s, (id) => id !== oldId);
	const opening = s.startOpen("A.pdf");
	await until(() => newLoad.reached() !== null);
	const fresh = newLoad.reached();
	expect(fresh, "precondition: the opening is loading its new id's record").not.toBeNull();
	expect(s.plugin.pdfIds.get(opening.root), "precondition: the opening set its new id before that load").toBe(fresh);
	shown.length = 0;
	const second = s.startOpen("A.pdf");
	await until(() => s.plugin.pdfIds.get(second.root) === fresh);
	expect(s.plugin.pdfIds.get(second.root), "precondition: the second tab took the opening's reserved id").toBe(fresh);
	if (firstLeaves) closeNow(s, opening, fresh!);
	await vi.advanceTimersByTimeAsync(holdMs);
	newLoad.release();
	await settleAll(s);
	expectOldInkShown(s, second.root, fresh!, oldId, oldFile);
}

it("second tab while the new id loads, first leaves desktop: a second tab opens A while the first tab still loads its new id's record, and the first tab closes; the second tab shows A's ink, said once", async () => {
	await secondTabWhileNewIdLoads(UNDER_CAP_MS, true);
});

it("second tab while the new id loads, first leaves, past the wait desktop: as above, the new id's record held past the carry's one wait; the second tab shows A's ink, said once", async () => {
	await secondTabWhileNewIdLoads(PAST_CAP_MS, true);
});

it("pin: second tab while the new id loads, both stay, past the wait desktop: one notice, the carried one, A's ink once", async () => {
	await secondTabWhileNewIdLoads(PAST_CAP_MS, false);
});

// Pins: green before the fix, and after.

it("pin: a byte-same copy opened meanwhile desktop: the tab leaves A while the carry waits, Q.pdf with A's new bytes opens, the tab comes back; Q gets its own id, no ink, no ink file", async () => {
	const s = session("desktop");
	const { hold, opening, fresh } = await openingCarryWaits(s);
	s.pdfs.set("Q.pdf", s.pdfs.get("A.pdf")!.slice());
	s.switchTo(opening, "B.pdf");
	await vi.advanceTimersByTimeAsync(STEP_MS);
	const q = s.startOpen("Q.pdf");
	await until(() => s.plugin.pdfIds.get(q.root) !== undefined);
	s.switchTo(opening, "A.pdf");
	await vi.advanceTimersByTimeAsync(UNDER_CAP_MS);
	hold.release();
	await settleAll(s);
	const qId = s.plugin.pdfIds.get(q.root) as string | undefined;
	expect(qId, "precondition: Q has an id").toBeDefined();
	expect(qId, "Q was given A's new id").not.toBe(fresh);
	expect(ids(s.pdfStore.strokes(qId!)), "Q shows ink").toEqual([]);
	expect(s.saved(qId!), "Q has an ink file").toBeNull();
});

it("pin: a leave with no stroke and no return desktop: the tab closes while the carry waits; the new id gets no ink file, nothing is said", async () => {
	const s = session("desktop");
	const { oldId, oldFile, hold, opening, fresh } = await openingCarryWaits(s);
	closeNow(s, opening, fresh);
	await vi.advanceTimersByTimeAsync(UNDER_CAP_MS);
	hold.release();
	await settleAll(s);
	expect(s.saved(fresh), "the new id got an ink file").toBeNull();
	expect(shown, "a notice for a tab that left").toEqual([]);
	expect(s.saved(oldId), "the old ink file is never written").toBe(oldFile);
});

it("pin: an unchanged inked PDF opened, closed and opened again desktop: no carry listing", async () => {
	const s = session("desktop");
	await inkedAThenClosed(s);
	const listings = countCarryListings(s);
	const first = await s.open("A.pdf");
	await s.close(first);
	await s.open("A.pdf");
	await settleAll(s);
	expect(listings(), "an unchanged PDF listed the ink folders").toBe(0);
	expect(shown, "nothing changed, nothing is said").toEqual([]);
});

it("pin: a locked old ink file desktop: A's old ink file is newer-format and A changed while closed; one open says the kept notice once, inside the carry's one wait", async () => {
	const s = session("desktop");
	const { oldId, oldFile } = await inkedAThenClosed(s);
	const locked = await lockAsNewer(s, oldId, oldFile);
	version(s, 1);
	shown.length = 0;
	const before = identified(s, "A.pdf");
	const opening = s.startOpen("A.pdf");
	await until(() => identified(s, "A.pdf") > before, SETTLE_CAP_MS - 1);
	expect(identified(s, "A.pdf"), "the open ended inside the carry's one wait").toBeGreaterThan(before);
	expect(shown, "said once, the kept notice").toEqual([KEPT_NOTICE]);
	const now = s.plugin.pdfIds.get(opening.root) as string;
	expect(ids(s.pdfStore.strokes(now)), "nothing carried").toEqual([]);
	expect(s.saved(oldId), "the old ink file is never written").toBe(locked);
});

it("pin: a PDF no ink file claims, left and opened again mid-pass desktop: B opens for the first time, the tab goes to A and back during B's carry listing; B's carry lists once in all, nothing is said", async () => {
	const s = session("desktop");
	const { oldId } = await inkedAThenClosed(s);
	const listings = countCarryListings(s);
	const listing = holdCarryListing(s);
	const aLoad = s.holdLoad(oldId);
	const other = s.startOpen("A.pdf");
	await until(() => aLoad.reached());
	expect(aLoad.reached(), "precondition: another tab loads A's ink file, held").toBe(true);
	const tab = s.startOpen("B.pdf");
	await until(() => listing.reached());
	expect(listing.reached(), "precondition: B's open is in its carry listing").toBe(true);
	const bId = s.plugin.pdfIds.get(tab.root) as string | undefined;
	expect(bId, "precondition: B's open chose its id").toBeDefined();
	s.switchTo(tab, "A.pdf");
	await vi.advanceTimersByTimeAsync(STEP_MS);
	s.switchTo(tab, "B.pdf");
	await until(() => s.plugin.pdfIds.get(tab.root) === bId);
	expect(s.plugin.pdfIds.get(tab.root), "precondition: the tab is back on B's id before the leave forgot it").toBe(bId);
	listing.release();
	await vi.advanceTimersByTimeAsync(STEP_MS * 10);
	aLoad.release();
	await settleAll(s);
	expect(listings(), "the return listed the ink folders again").toBe(1);
	expect(shown, "a notice for a PDF no ink file claims").toEqual([]);
	expect(s.plugin.pdfIds.get(other.root), "precondition: the other tab is on A's own id").toBe(oldId);
});
