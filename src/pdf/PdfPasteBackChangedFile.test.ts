// A paste back onto a PDF whose bytes changed between the copy and the paste.
//
// Copy ink on A.pdf; A's bytes change, so its next opening chooses a fresh ink id; paste back. The clipboard knew its
// source by the old id alone, so the first paste was stepped by 0 and landed on the originals: after the carry, on top
// of them; in the opening's wait, the carry then added the originals under it. Ink twice, and saved.
//
// Want: the first paste back is stepped 16 off its original, by the command or by Ctrl+V, before or after the carry.
// Pastes across a change keep stepping, into the source and into any other PDF that changed between two pastes: none
// lands on an earlier paste of the same copy. Pins: a first paste into another PDF lands where the ink was copied from,
// and the next steps 16; pastes into an unchanged PDF step as before; a rename between copy and paste is still the same
// file; note pastes step as before, with no file on either side; the clipboard module imports no vault and no file.
//
// Not covered: a PDF changed AND renamed between copy and paste.
//
// The rig is PdfOpeningCarryRefusesEraser.test.ts's, its lines 20-301 and 303-365 copied unchanged (itself
// PdfChangedWhileOpening.test.ts's): panes opened the way the plugin opens one, syncPdfControllers building the real
// controller, the real carry, the old record's load held by a queue.
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

// ---- the paste ---------------------------------------------------------------------------------------------------

import { clearInkClipboard, clipboardSize, copyInk, inkClipboardMarker, pasteInk } from "../inline/InkClipboard";
import clipboardSource from "../inline/InkClipboard.ts?raw";

beforeEach(() => clearInkClipboard());
afterEach(() => clearInkClipboard());

/** Where every stroke here starts: stroke()'s first point. */
const ORIGIN = 10;
const PASTED = "Handwriting: pasted 1 stroke";

/** Each stroke's step off the original, from its first point, sorted; a stroke moved off the diagonal says so. */
function stepsOf(strokes: readonly InkStroke[]): (number | string)[] {
	return strokes
		.map((x) => {
			const dx = x.points[0]!.x - ORIGIN;
			const dy = x.points[0]!.y - ORIGIN;
			return dx === dy ? dx : `${dx},${dy}`;
		})
		.sort((a, b) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))));
}
const steps = (s: Session, id: string) => stepsOf(s.pdfStore.strokes(id));
const savedSteps = (s: Session, id: string) => {
	const raw = s.saved(id);
	return raw === null ? null : stepsOf(parsePage(raw, id).data.strokes);
};

type Ready = PenPane & { id: string };

/** A pen tab on `path`, its opening run to its end (a carry included). */
async function openReady(s: Session, path = "A.pdf"): Promise<Ready> {
	const p = openPen(s, path);
	await settleAll(s);
	const id = s.plugin.pdfIds.get(p.root) as string | undefined;
	expect(id !== undefined && s.pdfStore.inkReady(id), `precondition: the tab on ${path} is ready`).toBe(true);
	return { ...p, id: id! };
}

/** The tab closes, every write first; its record is forgotten, so the next opening reads its ink file from disk. */
async function closeReady(s: Session, p: Ready) {
	await settleAll(s);
	await s.close({ root: p.root, leaf: p.leaf, id: p.id });
	expect(s.pdfStore.generation(p.id), "precondition: the closed tab's ink record was forgotten").toBeNull();
	expect(s.saved(p.id), "precondition: the closed tab's ink file is on disk").not.toBeNull();
}

/** `path`'s bytes changed while no tab showed it: a head byte, so its next opening chooses a new id. */
function changeBytes(s: Session, path: string, n: number) {
	const changed = s.pdfs.get(path)!.slice();
	changed[100] = 110 + n;
	s.pdfs.set(path, changed);
}

/** A open in a pen tab with stroke "a-ink" saved. */
async function inkedAOpen(s: Session): Promise<Ready> {
	const a = await openReady(s);
	s.pdfStore.commit(a.id, stroke("a-ink"));
	await drive(s.store.flush());
	return a;
}

/** Lasso the stroke on page 1 and copy, as the copy command does. */
function copyOn(p: Ready, strokeId: string) {
	const lasso = p.controller as unknown as { selected: string[]; selectionPage: number };
	lasso.selected = [strokeId];
	lasso.selectionPage = 1;
	p.controller.copySelection();
	expect(clipboardSize(), "precondition: the copy took the stroke").toBe(1);
}

type Route = "command" | "ctrl+v";

/** Paste by the palette command (RegisterExportCommands.ts, paste-ink) on this tab, or by Ctrl+V on its root. */
function paste(s: Session, p: PenPane, route: Route) {
	shown.length = 0;
	if (route === "ctrl+v") {
		const marker = inkClipboardMarker();
		expect(marker, "precondition: the copy left its marker").not.toBeNull();
		const ev = { clipboardData: { getData: () => marker }, preventDefault() {}, stopPropagation() {}, target: null };
		p.controller.handlePaste(ev as unknown as ClipboardEvent);
	} else {
		const commands: Record<string, { checkCallback(checking: boolean): boolean }> = {};
		s.plugin.addCommand = (c: { id: string; checkCallback(checking: boolean): boolean }) => {
			commands[c.id] = c;
			return c;
		};
		s.plugin.registerExportSelectionCommands();
		s.plugin.app.workspace.getActiveFile = () => ({ path: s.plugin.pdfFiles.get(p.root), extension: "pdf" });
		s.plugin.app.workspace.getActiveViewOfType = () => ({ containerEl: p.root });
		expect(commands["paste-ink"]!.checkCallback(false), "precondition: the paste command ran").toBe(true);
	}
	expect(shown, "precondition: the paste said it pasted").toEqual([PASTED]);
}

/** A vault rename while the tab shows the PDF, as PluginOnload.ts wires it (as PdfChangedTwiceKeepsInk.test.ts does). */
function rename(s: Session, p: PenPane, from: string, to: string) {
	s.pdfs.set(to, s.pdfs.get(from)!);
	s.pdfs.delete(from);
	p.leaf.view.file!.path = to;
	s.pdfStore.notePdfRenamed(from, to);
	for (const [root, at] of s.plugin.pdfFiles as Map<HTMLElement, string>) {
		if (at !== from) continue;
		s.plugin.pdfFiles.set(root, to);
		const id = s.plugin.pdfIds.get(root) as string | undefined;
		if (id) s.pdfStore.renamePath(id, from, to);
	}
}

/** The opening of `path`'s new bytes, its carry held on the load of the old ink file `oldId`: on its new id, holding
 * nothing yet. */
async function openingInCarry(s: Session, path: string, oldId: string) {
	const hold = s.holdLoad(oldId);
	const p = openPen(s, path);
	await until(() => hold.reached());
	expect(hold.reached(), "precondition: the opening's carry is loading the old ink file").toBe(true);
	const fresh = s.plugin.pdfIds.get(p.root) as string | undefined;
	expect(fresh !== undefined && fresh !== oldId, "precondition: the opening chose a new id for the new bytes").toBe(true);
	expect(s.pdfStore.inkReady(fresh!), "precondition: the new id is ready").toBe(true);
	expect(s.pdfStore.hasInk(fresh!), "precondition: nothing carried yet").toBe(false);
	return { p, fresh: fresh!, hold };
}

// ---- red at the base: a paste back across a change ---------------------------------------------------------------

for (const route of ["command", "ctrl+v"] as const) {
	it(`after the carry, ${route}: copy on A, A's bytes change, the carry lands, paste back: stepped 16 off the original, not on it`, async () => {
		const s = session("desktop");
		const a = await inkedAOpen(s);
		copyOn(a, "a-ink");
		await closeReady(s, a);
		version(s, 1);
		const back = await openReady(s);
		expect(back.id, "precondition: A's new bytes opened on a new id").not.toBe(a.id);
		expect(ids(s.pdfStore.strokes(back.id)), "precondition: the carry brought the original").toEqual(["a-ink"]);
		paste(s, back, route);
		expect(steps(s, back.id), "the first paste back after the carry, on screen").toEqual([0, 16]);
		await settleAll(s);
		expect(savedSteps(s, back.id), "the first paste back after the carry, saved").toEqual([0, 16]);
	});

	it(`in the wait, ${route}: copy on A, A's bytes change, paste back in the opening's wait, then the carry lands: stepped 16, the original once under it`, async () => {
		const s = session("desktop");
		const a = await inkedAOpen(s);
		copyOn(a, "a-ink");
		await closeReady(s, a);
		version(s, 1);
		const w = await openingInCarry(s, "A.pdf", a.id);
		paste(s, w.p, route);
		w.hold.release();
		await settleAll(s);
		expect(ids(s.pdfStore.strokes(w.fresh)), "precondition: the carry brought the original").toContain("a-ink");
		expect(steps(s, w.fresh), "the paste in the wait, after the carry landed, on screen").toEqual([0, 16]);
		expect(savedSteps(s, w.fresh), "the paste in the wait, after the carry landed, saved").toEqual([0, 16]);
	});
}

it("pastes keep stepping across the change: paste into A, A's bytes change, the carry lands, paste twice more: +32 and +48, none on an earlier paste", async () => {
	const s = session("desktop");
	const a = await inkedAOpen(s);
	copyOn(a, "a-ink");
	paste(s, a, "command");
	expect(steps(s, a.id), "precondition: the first paste back, before the change").toEqual([0, 16]);
	await closeReady(s, a);
	version(s, 1);
	const back = await openReady(s);
	expect(steps(s, back.id), "precondition: the carry brought the original and the first paste").toEqual([0, 16]);
	paste(s, back, "command");
	expect(steps(s, back.id), "the second paste, across the change").toEqual([0, 16, 32]);
	paste(s, back, "command");
	expect(steps(s, back.id), "the third paste").toEqual([0, 16, 32, 48]);
	await settleAll(s);
	expect(savedSteps(s, back.id), "saved").toEqual([0, 16, 32, 48]);
});

it("pastes keep stepping in the wait: copy on A, A's bytes change, two pastes in the opening's wait, then the carry lands: +16 and +32", async () => {
	const s = session("desktop");
	const a = await inkedAOpen(s);
	copyOn(a, "a-ink");
	await closeReady(s, a);
	version(s, 1);
	const w = await openingInCarry(s, "A.pdf", a.id);
	paste(s, w.p, "ctrl+v");
	paste(s, w.p, "ctrl+v");
	w.hold.release();
	await settleAll(s);
	expect(ids(s.pdfStore.strokes(w.fresh)), "precondition: the carry brought the original").toContain("a-ink");
	expect(steps(s, w.fresh), "two pastes in the wait, after the carry landed").toEqual([0, 16, 32]);
	expect(savedSteps(s, w.fresh), "saved").toEqual([0, 16, 32]);
});

it("another PDF that changes between pastes keeps stepping: copy on A, paste into B (+0), B's bytes change, the carry lands, paste into B: +16, not on the first paste", async () => {
	const s = session("desktop");
	const a = await inkedAOpen(s);
	copyOn(a, "a-ink");
	const b = await openReady(s, "B.pdf");
	paste(s, b, "command");
	expect(steps(s, b.id), "precondition: the first paste into B lands where the ink was copied from").toEqual([0]);
	await closeReady(s, b);
	changeBytes(s, "B.pdf", 1);
	const back = await openReady(s, "B.pdf");
	expect(back.id, "precondition: B's new bytes opened on a new id").not.toBe(b.id);
	expect(steps(s, back.id), "precondition: the carry brought the first paste").toEqual([0]);
	paste(s, back, "command");
	expect(steps(s, back.id), "the second paste into B, across B's change").toEqual([0, 16]);
	await settleAll(s);
	expect(savedSteps(s, back.id), "saved").toEqual([0, 16]);
});

it("another PDF that changes between pastes keeps stepping, in the wait: paste into B (+0), B's bytes change, paste into B in the opening's wait, then the carry lands: +16", async () => {
	const s = session("desktop");
	const a = await inkedAOpen(s);
	copyOn(a, "a-ink");
	const b = await openReady(s, "B.pdf");
	paste(s, b, "command");
	expect(steps(s, b.id), "precondition: the first paste into B lands where the ink was copied from").toEqual([0]);
	await closeReady(s, b);
	changeBytes(s, "B.pdf", 1);
	const w = await openingInCarry(s, "B.pdf", b.id);
	paste(s, w.p, "ctrl+v");
	w.hold.release();
	await settleAll(s);
	expect(s.pdfStore.strokes(w.fresh).length, "precondition: the carry brought the first paste").toBe(2);
	expect(steps(s, w.fresh), "the paste into B in the wait, after the carry landed").toEqual([0, 16]);
	expect(savedSteps(s, w.fresh), "saved").toEqual([0, 16]);
});

// ---- pins: green at the base and after ----------------------------------------------------------------------------

it("pin P1: copy on A, two pastes into another PDF B: the first where the ink was copied from, the second 16 off", async () => {
	const s = session("desktop");
	const a = await inkedAOpen(s);
	copyOn(a, "a-ink");
	const b = await openReady(s, "B.pdf");
	paste(s, b, "command");
	paste(s, b, "ctrl+v");
	expect(steps(s, b.id), "two pastes into another unchanged PDF").toEqual([0, 16]);
	expect(steps(s, a.id), "A untouched").toEqual([0]);
});

it("pin P2: copy on A, two pastes back into unchanged A: +16 and +32", async () => {
	const s = session("desktop");
	const a = await inkedAOpen(s);
	copyOn(a, "a-ink");
	paste(s, a, "command");
	paste(s, a, "ctrl+v");
	expect(steps(s, a.id), "two pastes back into the unchanged source").toEqual([0, 16, 32]);
});

it("pin P3: copy on A, A renamed to C while open, paste: still the same file, +16", async () => {
	const s = session("desktop");
	const a = await inkedAOpen(s);
	copyOn(a, "a-ink");
	rename(s, a, "A.pdf", "C.pdf");
	expect(s.plugin.pdfIds.get(a.root), "precondition: the rename kept the id").toBe(a.id);
	expect(s.plugin.pdfFiles.get(a.root), "precondition: the tab is on C.pdf").toBe("C.pdf");
	paste(s, a, "command");
	expect(steps(s, a.id), "the first paste after a rename").toEqual([0, 16]);
});

it("pin P3b: copy on A, paste, A renamed to C, paste: +16 and +32", async () => {
	const s = session("desktop");
	const a = await inkedAOpen(s);
	copyOn(a, "a-ink");
	paste(s, a, "command");
	rename(s, a, "A.pdf", "C.pdf");
	paste(s, a, "command");
	expect(steps(s, a.id), "a paste either side of a rename").toEqual([0, 16, 32]);
});

it("pin P4: note pastes, no file on either side: the source note steps every paste, another note its later ones", () => {
	const s = stroke("note-ink");
	delete s.page;
	expect(copyInk([s], "one.md"), "premise: the note copy").toBe(1);
	const at = (into: string) => stepsOf(pasteInk(into));
	expect(at("other.md"), "the first paste into another note").toEqual([0]);
	expect(at("other.md"), "the second paste into another note").toEqual([16]);
	expect(at("one.md"), "the first paste back into the source note").toEqual([16]);
	expect(at("one.md"), "the second paste back into the source note").toEqual([32]);
	expect(at("third.md"), "the first paste into a third note").toEqual([0]);
});

it("pin B5: the clipboard module imports the stroke, the ink file's codec and the selection only, no vault and no file", () => {
	const froms = [...clipboardSource.replace(/\r\n/g, "\n").matchAll(/^import\b[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
	expect(froms, "InkClipboard.ts's imports").toEqual(["../ink/Stroke", "../model/PageData", "../objects/Selection"]);
});
