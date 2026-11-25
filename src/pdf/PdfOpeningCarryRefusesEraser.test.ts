// Eraser, lasso and insert space on a PDF whose opening is still carrying an older version's ink into its new ink id.
//
// A PDF that changed while no tab showed it is opened. The open chooses a fresh id for the new bytes, sets it on the pane
// and loads it (empty, so ready), and only then carries the old version's ink across (carryFromOldContent), which reads
// the old ink file and may wait on its load. The pen draws at once. An erase held down while the carry lands took the
// carried strokes into its own undo step, so undoing the erase deleted the old ink and saved that.
//
// Want: while an opening on the path that chose a fresh id has not ended, a pen contact that is not ink and not the pan
// tool (the eraser, a lasso, insert space) is refused on every pane on the path with the not-ready line the pen already
// says, once. Pen ink still draws. The refusal ends when the opening ends, on every way out: once it has, the eraser
// erases and its undo takes back only what it erased. Pins (green before the fix, and after): an opening that throws
// leaves no refusal; a second tab opening an unchanged PDF refuses nothing in the first, in either order the plugin
// first saw the two tabs; a tab whose identification threw refuses nothing in a later tab on the same path; the pan
// tool goes on; a pane with no PDF path is never refused.
//
// The rig is PdfChangedWhileOpening.test.ts's, copied unchanged (its lines 35-321, less the constants these tests do not
// use). Panes are opened the way the plugin opens one, as PdfChangedOnDiskHeldUndo.test.ts does:
// syncPdfControllers builds the real controller (mount stubbed) and identifies the pane. The viewer probe is the only
// other stub, as in PdfInkController.test.ts, so the controller's own penDown, penRaw and penUp find a page.
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

// ---- the pen on a real controller ------------------------------------------------------------------------------------

import { PdfInkController } from "./PdfInkController";
import type { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";

/** The pen's sync can build observers; node has none, and none needs to be real here. */
class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => probe.current, viewerCanvasOf: () => null, wholePageCanvasOf: () => null }));

/** The words the pen already says for a PDF whose ink is not ready (PdfInkPenPath.ts). */
const NOT_READY = "Handwriting: this PDF's ink is not ready - try again in a moment";
/** css px per point. */
const SCALE = 2;

beforeEach(() => {
	resetTipModeForTest();
	vi.spyOn(PdfInkController.prototype, "mount").mockImplementation(() => {});
	const scroller = { scrollLeft: 0, scrollTop: 0, classList: { add() {}, remove() {} }, querySelector: () => null };
	probe.current = {
		scroller, scaleFactor: SCALE, scaleSource: "test",
		pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true }],
	};
});

type PenPane = { root: HTMLElement; leaf: Leaf; controller: PdfInkController; done: Promise<void> };

/** A tab opens `path` the way the plugin opens one: its sync builds the real controller and starts the identification. */
function openPen(s: Session, path = "A.pdf"): PenPane {
	s.plugin.pdfCalibration = false;
	s.plugin.settings ??= { inkPdfColorMode: "auto" };
	const win = { devicePixelRatio: 1, setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {} };
	const root = { isConnected: true, ownerDocument: { defaultView: win } } as unknown as HTMLElement;
	const leaf: Leaf = { view: { file: { path }, containerEl: root } };
	(s.plugin.app.workspace.getLeavesOfType("pdf") as Leaf[]).push(leaf);
	const before = s.resolutions.length;
	s.plugin.syncPdfControllers();
	expect(s.resolutions.length, "premise: the sync identified the new pane").toBe(before + 1);
	const controller = s.plugin.pdfInk.get(root) as PdfInkController;
	expect(controller, "premise: a real controller").toBeInstanceOf(PdfInkController);
	return { root, leaf, controller, done: s.resolutions[s.resolutions.length - 1]! };
}

const at = (x: number, y: number): PenSample => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
const penEv = (buttons: number) => ({ pointerType: "pen", buttons, button: -1 }) as unknown as PointerEvent;
type PenApi = { penDown(s: PenSample, ev?: PointerEvent): void; penRaw(s: PenSample[], ev?: PointerEvent): void; penUp(ev?: PointerEvent): void };

/** One pen contact through the controller's own callbacks: down at the first point, moved through the rest, lifted. */
function contact(c: PdfInkController, buttons: number, points: readonly (readonly [number, number])[]) {
	const pen = c as unknown as PenApi;
	pen.penDown(at(points[0]![0], points[0]![1]), penEv(buttons));
	for (const [x, y] of points.slice(1)) pen.penRaw([at(x, y)], penEv(buttons));
	pen.penUp(penEv(buttons));
}
const TIP = 1;
const SIDE = 2;
const ERASER = 32;
/** Stroke A, around page point (100,100) to (115,115); the carried stroke sits at (10,10), away from it. */
const STROKE_A = [[200, 200], [210, 210], [220, 220], [230, 230]] as const;
const ACROSS_A = [[195, 215], [205, 215], [215, 215], [225, 215], [235, 215]] as const;
const AROUND_A = [[180, 180], [250, 180], [250, 250], [180, 250], [180, 180]] as const;
const SPACE_ABOVE_A = [[100, 190], [100, 200], [100, 220], [100, 240]] as const;
const undo = (c: PdfInkController) => (c as unknown as { historyStep(redo: boolean): boolean }).historyStep(false);

/** A inked and closed, A changed while no tab showed it, and a pen tab opening it whose carry waits on the old ink file's
 * load: the tab is on its new id, ready and holding nothing yet. */
async function penOpeningInCarry(s: Session) {
	const { oldId, oldFile } = await inkedAThenClosed(s);
	version(s, 1);
	const hold = s.holdLoad(oldId);
	const pane = openPen(s);
	await until(() => hold.reached());
	expect(hold.reached(), "precondition: the open's carry is loading A's old ink file").toBe(true);
	const fresh = s.plugin.pdfIds.get(pane.root) as string | undefined;
	expect(fresh, "precondition: the opening chose a new id for the new bytes").toBeDefined();
	expect(fresh, "precondition: the opening chose a new id for the new bytes").not.toBe(oldId);
	expect(s.pdfStore.inkReady(fresh!), "precondition: the new id is ready").toBe(true);
	expect(s.pdfStore.hasInk(fresh!), "precondition: nothing carried yet").toBe(false);
	shown.length = 0;
	return { oldId, oldFile, hold, pane, fresh: fresh! };
}

/** Release the held load and run the opening to its end: the carry lands, said once. */
async function carryLands(s: Session, w: Awaited<ReturnType<typeof penOpeningInCarry>>) {
	shown.length = 0;
	w.hold.release();
	await settleAll(s);
	expect(s.plugin.pdfIds.get(w.pane.root), "precondition: the tab stayed on the new id").toBe(w.fresh);
	expect(shown, "precondition: the opening carried A's ink, said once").toEqual([CARRIED_NOTICE]);
	expect(ids(s.pdfStore.strokes(w.fresh)), "precondition: the carried stroke is in the new id").toContain("a-ink");
	shown.length = 0;
}

/** Pen ink in the opening: stroke A drawn on the new id, nothing said. */
function drawA(s: Session, w: Awaited<ReturnType<typeof penOpeningInCarry>>) {
	contact(w.pane.controller, TIP, STROKE_A);
	const drawn = s.pdfStore.strokes(w.fresh);
	expect(drawn.length, "pen ink draws in the opening").toBe(1);
	expect(shown, "pen ink in the opening says nothing").toEqual([]);
	return drawn;
}

const onDisk = (s: Session, id: string) => {
	const raw = s.saved(id);
	return raw === null ? null : ids(parsePage(raw, id).data.strokes).sort();
};

it("the eraser in a changed PDF's opening is refused with the not-ready line and stroke A stays whole; once the opening ends it erases A, and its undo brings A back and leaves the carried stroke", async () => {
	const s = session("desktop");
	const w = await penOpeningInCarry(s);
	const drawn = drawA(s, w);
	contact(w.pane.controller, ERASER, ACROSS_A);
	expect(shown, "the eraser in the opening").toEqual([NOT_READY]);
	expect(s.pdfStore.strokes(w.fresh), "the eraser in the opening left stroke A whole").toEqual(drawn);
	await carryLands(s, w);
	contact(w.pane.controller, ERASER, ACROSS_A);
	expect(shown, "the eraser once the opening ended").toEqual([]);
	const a = drawn[0]!.id;
	expect(ids(s.pdfStore.strokes(w.fresh)), "premise: the eraser took stroke A once the opening ended").not.toContain(a);
	expect(undo(w.pane.controller), "the undo of the erase").toBe(true);
	await settleAll(s);
	expect(ids(s.pdfStore.strokes(w.fresh)).sort(), "on screen after the undo: A back, the carried stroke kept").toEqual([a, "a-ink"].sort());
	expect(onDisk(s, w.fresh), "in the new ink file after the undo: A back, the carried stroke kept").toEqual([a, "a-ink"].sort());
});

it("a lasso with the side button in a changed PDF's opening is refused with the not-ready line; once the opening ends it selects", async () => {
	const s = session("desktop");
	const w = await penOpeningInCarry(s);
	drawA(s, w);
	contact(w.pane.controller, SIDE, AROUND_A);
	expect(shown, "the side-button lasso in the opening").toEqual([NOT_READY]);
	expect(w.pane.controller.hasSelection, "the lasso in the opening selected").toBe(false);
	await carryLands(s, w);
	contact(w.pane.controller, SIDE, AROUND_A);
	expect(shown, "the side-button lasso once the opening ended").toEqual([]);
	expect(w.pane.controller.hasSelection, "once the opening ended, the lasso selects").toBe(true);
});

it("the lasso tool in a changed PDF's opening is refused with the not-ready line; once the opening ends it selects", async () => {
	const s = session("desktop");
	const w = await penOpeningInCarry(s);
	drawA(s, w);
	setTipMode("lasso");
	contact(w.pane.controller, TIP, AROUND_A);
	expect(shown, "the lasso tool in the opening").toEqual([NOT_READY]);
	expect(w.pane.controller.hasSelection, "the lasso in the opening selected").toBe(false);
	await carryLands(s, w);
	contact(w.pane.controller, TIP, AROUND_A);
	expect(shown, "the lasso tool once the opening ended").toEqual([]);
	expect(w.pane.controller.hasSelection, "once the opening ended, the lasso selects").toBe(true);
});

it("insert space in a changed PDF's opening is refused with the not-ready line and moves nothing; once the opening ends it moves stroke A", async () => {
	const s = session("desktop");
	const w = await penOpeningInCarry(s);
	const drawn = drawA(s, w);
	setTipMode("space");
	contact(w.pane.controller, TIP, SPACE_ABOVE_A);
	expect(shown, "insert space in the opening").toEqual([NOT_READY]);
	expect(s.pdfStore.strokes(w.fresh), "insert space in the opening moved stroke A").toEqual(drawn);
	await carryLands(s, w);
	contact(w.pane.controller, TIP, SPACE_ABOVE_A);
	expect(shown, "insert space once the opening ended").toEqual([]);
	const a = s.pdfStore.strokes(w.fresh).find((x) => x.id === drawn[0]!.id);
	expect(a?.points, "once the opening ended, insert space moves stroke A").not.toEqual(drawn[0]!.points);
});

it("a second tab on the same PDF, its identification waiting on the first tab's opening, refuses the eraser too while that opening carries; once that ends, it erases", async () => {
	const s = session("desktop");
	const w = await penOpeningInCarry(s);
	const second = openPen(s);
	let ended = false;
	void second.done.then(() => void (ended = true), () => {});
	// The second tab takes the id the first tab's opening still owes the old ink to, and waits on that opening.
	await until(() => ended, 1_000);
	expect(ended, "precondition: the second tab's identification waits on the first tab's opening").toBe(false);
	expect(w.hold.reached() && !s.pdfStore.hasInk(w.fresh), "precondition: the first tab's carry still waits").toBe(true);
	const id = s.plugin.pdfIds.get(second.root) as string | undefined;
	expect(id !== undefined && s.pdfStore.inkReady(id), "precondition: the second tab has a ready id").toBe(true);
	shown.length = 0;
	// Stroke A in the second tab, so its eraser has ink under it (an empty page says its own line).
	const count = s.pdfStore.strokes(id!).length;
	contact(second.controller, TIP, STROKE_A);
	const drawn = s.pdfStore.strokes(id!).slice();
	expect(drawn.length, "precondition: the second tab draws stroke A").toBe(count + 1);
	const a = drawn[drawn.length - 1]!.id;
	shown.length = 0;
	contact(second.controller, ERASER, ACROSS_A);
	expect(shown, "the eraser in the second tab while the first tab's opening carries").toEqual([NOT_READY]);
	expect(ids(s.pdfStore.strokes(id!)), "the eraser in the second tab in the opening left stroke A whole").toContain(a);
	await carryLands(s, w);
	// The second tab's wait wakes once the first tab's opening ends, finds nothing owed, and ends with no carry.
	await second.done;
	expect(ended, "precondition: the second tab's identification ended after the first tab's opening").toBe(true);
	contact(second.controller, ERASER, ACROSS_A);
	expect(shown, "the eraser in the second tab once the opening ended").toEqual([]);
	expect(ids(s.pdfStore.strokes(id!)), "once the opening ended, the second tab's eraser takes stroke A").not.toContain(a);
});

it("two eraser contacts in a changed PDF's opening say the not-ready line once", async () => {
	const s = session("desktop");
	const w = await penOpeningInCarry(s);
	const drawn = drawA(s, w);
	contact(w.pane.controller, ERASER, ACROSS_A);
	contact(w.pane.controller, ERASER, ACROSS_A);
	expect(shown, "two eraser contacts in the opening").toEqual([NOT_READY]);
	expect(s.pdfStore.strokes(w.fresh), "two eraser contacts in the opening left stroke A whole").toEqual(drawn);
});

it("pin: an opening that throws in its carry leaves no refusal; the eraser says nothing", async () => {
	const s = session("desktop");
	const { oldId } = await inkedAThenClosed(s);
	version(s, 1);
	const read = s.store.readPdfClaim.bind(s.store);
	s.store.readPdfClaim = (async (id: string) => {
		if (id === oldId) throw new Error("the old ink file's claim could not be read");
		return read(id);
	}) as typeof s.store.readPdfClaim;
	const pane = openPen(s);
	let failed = false;
	await drive(pane.done.catch(() => void (failed = true)));
	expect(failed, "precondition: the opening threw").toBe(true);
	const now = s.plugin.pdfIds.get(pane.root) as string | undefined;
	expect(now !== undefined && now !== oldId && s.pdfStore.inkReady(now), "precondition: the tab is on the new id, ready").toBe(true);
	shown.length = 0;
	contact(pane.controller, TIP, STROKE_A);
	const drawn = s.pdfStore.strokes(now!).slice();
	expect(drawn.length, "precondition: the tab draws stroke A after the failed opening").toBe(1);
	shown.length = 0;
	contact(pane.controller, ERASER, ACROSS_A);
	expect(shown, "a failed opening left its refusal behind").toEqual([]);
	expect(ids(s.pdfStore.strokes(now!)), "after a failed opening, the eraser takes stroke A").not.toContain(drawn[0]!.id);
});

it("pin: a second tab opening an unchanged PDF (no new id) refuses nothing in the first tab", async () => {
	const s = session("desktop");
	const { oldId } = await inkedAThenClosed(s);
	const first = openPen(s);
	await drive(first.done);
	const id = s.plugin.pdfIds.get(first.root) as string;
	expect(id, "precondition: the unchanged PDF opened on its own ink id").toBe(oldId);
	expect(s.pdfStore.inkReady(id), "precondition: the first tab is ready").toBe(true);
	s.slowHeadFor("A.pdf");
	const second = openPen(s);
	let ended = false;
	void second.done.then(() => void (ended = true), () => {});
	await vi.advanceTimersByTimeAsync(20);
	expect(ended, "precondition: the second tab's opening is still reading A's head").toBe(false);
	shown.length = 0;
	contact(first.controller, ERASER, ACROSS_A);
	expect(shown, "the eraser in the first tab while a second tab opens the unchanged PDF").toEqual([]);
	await settleAll(s);
});

it("pin: a tab first seen on another PDF, switched onto the unchanged PDF a later tab shows, refuses nothing in that later tab while it reads the head", async () => {
	const s = session("desktop");
	const { oldId } = await inkedAThenClosed(s);
	const earlier = openPen(s, "B.pdf");
	await drive(earlier.done);
	const later = openPen(s);
	await drive(later.done);
	const id = s.plugin.pdfIds.get(later.root) as string;
	expect(id, "precondition: the unchanged PDF opened on its own ink id").toBe(oldId);
	expect(s.pdfStore.inkReady(id), "precondition: the later tab is ready").toBe(true);
	const order = [...(s.plugin.pdfFiles as Map<HTMLElement, string>).keys()];
	expect(order.indexOf(earlier.root), "precondition: the earlier tab comes first among the PDF panes").toBeLessThan(order.indexOf(later.root));
	s.slowHeadFor("A.pdf");
	const before = s.resolutions.length;
	s.switchTo(earlier, "A.pdf");
	expect(s.resolutions.length, "premise: the switch started the earlier tab's identification").toBe(before + 1);
	let ended = false;
	void s.resolutions[before]!.then(() => void (ended = true), () => {});
	await vi.advanceTimersByTimeAsync(20);
	expect(ended, "precondition: the switched tab's opening is still reading A's head").toBe(false);
	expect(s.plugin.pdfIds.has(earlier.root), "precondition: the switched tab has no id yet").toBe(false);
	shown.length = 0;
	contact(later.controller, ERASER, ACROSS_A);
	expect(shown, "the eraser in the later tab while an earlier tab switches onto the unchanged PDF").toEqual([]);
	await settleAll(s);
});

it("pin: the pan tool in a changed PDF's opening is not refused", async () => {
	const s = session("desktop");
	const w = await penOpeningInCarry(s);
	setTipMode("pan");
	contact(w.pane.controller, TIP, SPACE_ABOVE_A);
	expect(shown, "the pan tool in the opening").toEqual([]);
});

it("pin: a pane with no PDF path is never refused", async () => {
	const s = session("desktop");
	const pane = openPen(s);
	await drive(pane.done);
	const id = s.plugin.pdfIds.get(pane.root) as string;
	expect(s.pdfStore.inkReady(id), "precondition: the tab is ready").toBe(true);
	shown.length = 0;
	contact(pane.controller, TIP, STROKE_A);
	const drawn = s.pdfStore.strokes(id).slice();
	expect(drawn.length, "precondition: the tab draws stroke A").toBe(1);
	s.plugin.pdfFiles.delete(pane.root);
	shown.length = 0;
	contact(pane.controller, ERASER, ACROSS_A);
	expect(shown, "the eraser on a pane with no PDF path").toEqual([]);
	expect(ids(s.pdfStore.strokes(id)), "on a pane with no PDF path, the eraser takes stroke A").not.toContain(drawn[0]!.id);
});

/** An earlier tab on A.pdf whose identification threw (no id, its path kept: "could not identify this PDF"), then a
 * later tab on A.pdf identified, ready, with stroke A drawn. */
async function besideAFailedTab(s: Session) {
	const list = s.store.listIds.bind(s.store);
	let fail = true;
	s.store.listIds = (async (prefix: string) => {
		if (fail) {
			fail = false;
			throw new Error("the ink folder could not be listed");
		}
		return list(prefix);
	}) as typeof s.store.listIds;
	const failed = openPen(s);
	let threw = false;
	await drive(failed.done.catch(() => void (threw = true)));
	expect(threw, "precondition: the earlier tab's identification threw").toBe(true);
	expect(s.plugin.pdfIds.has(failed.root), "precondition: the earlier tab has no id").toBe(false);
	expect(s.plugin.pdfFiles.get(failed.root), "precondition: the earlier tab is still on A.pdf").toBe("A.pdf");
	const pane = openPen(s);
	await drive(pane.done);
	const id = s.plugin.pdfIds.get(pane.root) as string | undefined;
	expect(id !== undefined && s.pdfStore.inkReady(id), "precondition: the later tab has a ready id").toBe(true);
	contact(pane.controller, TIP, STROKE_A);
	const drawn = s.pdfStore.strokes(id!);
	expect(drawn.length, "precondition: the later tab draws stroke A").toBe(1);
	shown.length = 0;
	// Copied out, so a store that changes its arrays in place cannot move what the cells compare against.
	return { pane, id: id!, a: drawn[0]!.id, points: drawn[0]!.points.map((p) => ({ ...p })) };
}

it("pin: beside an earlier tab on the same PDF whose identification threw, the eraser says nothing and erases stroke A", async () => {
	const s = session("desktop");
	const t = await besideAFailedTab(s);
	contact(t.pane.controller, ERASER, ACROSS_A);
	expect(shown, "the eraser beside a tab whose identification threw").toEqual([]);
	expect(ids(s.pdfStore.strokes(t.id)), "beside a tab whose identification threw, the eraser takes stroke A").not.toContain(t.a);
});

it("pin: beside an earlier tab on the same PDF whose identification threw, a lasso with the side button says nothing and selects", async () => {
	const s = session("desktop");
	const t = await besideAFailedTab(s);
	contact(t.pane.controller, SIDE, AROUND_A);
	expect(shown, "the side-button lasso beside a tab whose identification threw").toEqual([]);
	expect(t.pane.controller.hasSelection, "beside a tab whose identification threw, the lasso selects").toBe(true);
});

it("pin: beside an earlier tab on the same PDF whose identification threw, insert space says nothing and moves stroke A", async () => {
	const s = session("desktop");
	const t = await besideAFailedTab(s);
	setTipMode("space");
	contact(t.pane.controller, TIP, SPACE_ABOVE_A);
	expect(shown, "insert space beside a tab whose identification threw").toEqual([]);
	const a = s.pdfStore.strokes(t.id).find((x) => x.id === t.a);
	expect(a, "premise: stroke A is still on the page after insert space").toBeDefined();
	expect(a!.points, "beside a tab whose identification threw, insert space moves stroke A").not.toEqual(t.points);
});

// The refusal is held to the opening's own path: a changed B.pdf carrying its old ink leaves a tab on A.pdf alone.
it("pin: while a changed B.pdf's opening carries its old ink, the eraser in a tab on A.pdf says nothing and erases stroke A", async () => {
	const s = session("desktop");
	// B inked and closed, then B changed while no tab showed it (a head byte, so its new bytes get a new id).
	const inkedB = await s.open("B.pdf");
	s.pdfStore.commit(inkedB.id, stroke("b-ink"));
	await drive(s.store.flush());
	const oldB = inkedB.id;
	await s.close(inkedB);
	expect(s.pdfStore.generation(oldB), "precondition: B's ink record was forgotten at the close").toBeNull();
	const changed = s.pdfs.get("B.pdf")!.slice();
	changed[100] = 111;
	s.pdfs.set("B.pdf", changed);
	// A tab on A.pdf, identified, ready, with stroke A drawn.
	const onA = openPen(s);
	await drive(onA.done);
	const aId = s.plugin.pdfIds.get(onA.root) as string;
	expect(s.pdfStore.inkReady(aId), "precondition: the tab on A is ready").toBe(true);
	contact(onA.controller, TIP, STROKE_A);
	const drawn = s.pdfStore.strokes(aId).slice();
	expect(drawn.length, "precondition: the tab on A draws stroke A").toBe(1);
	// A tab opening B, its carry held on the load of B's old ink file.
	const hold = s.holdLoad(oldB);
	const onB = openPen(s, "B.pdf");
	await until(() => hold.reached());
	expect(hold.reached(), "precondition: B's opening is loading B's old ink file").toBe(true);
	const freshB = s.plugin.pdfIds.get(onB.root) as string | undefined;
	expect(freshB !== undefined && freshB !== oldB, "precondition: B's opening chose a new id for the new bytes").toBe(true);
	expect(s.pdfStore.hasInk(freshB!), "precondition: nothing carried into B yet").toBe(false);
	shown.length = 0;
	contact(onB.controller, ERASER, ACROSS_A);
	expect(shown, "premise: the eraser in B's own tab is refused while B's opening carries").toEqual([NOT_READY]);
	shown.length = 0;
	contact(onA.controller, ERASER, ACROSS_A);
	expect(shown, "the eraser in the tab on A while B's opening carries").toEqual([]);
	expect(ids(s.pdfStore.strokes(aId)), "while B's opening carries, the eraser in the tab on A takes stroke A").not.toContain(drawn[0]!.id);
	hold.release();
	await settleAll(s);
	expect(ids(s.pdfStore.strokes(freshB!)), "premise: B's opening carried B's old ink").toContain("b-ink");
});

it("a tab on A whose identification ended refuses the eraser while a second tab's opening of the changed A carries; once that opening ends, it erases", async () => {
	const s = session("desktop");
	const { oldId } = await inkedAThenClosed(s);
	const first = openPen(s);
	await drive(first.done);
	const id1 = s.plugin.pdfIds.get(first.root) as string | undefined;
	expect(id1, "precondition: the first tab took A's ink file").toBe(oldId);
	expect(s.pdfStore.inkReady(id1!), "precondition: the first tab is ready").toBe(true);
	contact(first.controller, TIP, STROKE_A);
	const drawn = s.pdfStore.strokes(id1!).slice();
	expect(drawn.length, "precondition: the first tab draws stroke A").toBe(2);
	const a = drawn[drawn.length - 1]!.id;
	version(s, 1);
	// The second tab's opening held at the load of the new id it chose: a fixed point inside that opening.
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => (release = r));
	let held: string | undefined;
	const ensure = s.pdfStore.ensureLoaded.bind(s.pdfStore);
	s.pdfStore.ensureLoaded = (async (id: string) => {
		if (held === undefined && id !== id1) {
			held = id;
			await gate;
		}
		return ensure(id);
	}) as typeof s.pdfStore.ensureLoaded;
	const second = openPen(s);
	await until(() => held !== undefined, 1_000);
	expect(held, "precondition: the second tab's opening is loading a new id").toBeDefined();
	expect(s.plugin.pdfIds.get(second.root), "precondition: the second tab's opening chose that new id for the new bytes").toBe(held);
	expect(s.plugin.pdfIds.get(first.root), "precondition: the first tab stays on A's ink file").toBe(id1);
	shown.length = 0;
	contact(first.controller, ERASER, ACROSS_A);
	expect(shown, "the eraser in the first tab while the second tab's opening carries").toEqual([NOT_READY]);
	expect(ids(s.pdfStore.strokes(id1!)), "the eraser in the first tab in that opening left stroke A whole").toContain(a);
	release();
	await settleAll(s);
	expect(s.plugin.pdfIds.get(first.root), "precondition: the first tab is still on A's ink file").toBe(id1);
	shown.length = 0;
	contact(first.controller, ERASER, ACROSS_A);
	expect(shown, "the eraser in the first tab once the second tab's opening ended").toEqual([]);
	expect(ids(s.pdfStore.strokes(id1!)), "once that opening ended, the first tab's eraser takes stroke A").not.toContain(a);
});
