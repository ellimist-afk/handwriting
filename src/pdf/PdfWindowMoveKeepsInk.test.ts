/**
 * A PDF tab dragged to another window, or back, keeps its ink working there.
 *
 * Obsidian moves the same leaf, so the same pane element goes into the other window's document, and then calls back on
 * the node that changed window (`onWindowMigrated`, built on its node-inserted animation). The PDF view's own call closes
 * and reloads the viewer into the same `.pdf-viewer-container`, so the page divs are rebuilt and the scroller is not.
 * Until this fix the ink controller kept the window it was built in: every repaint frame and timer, the pixel ratio, the
 * clipboard, the text selection and the pen router's window listeners stayed on the first window. A pop-out closes with
 * its last tab and its frames never run again; a hidden main window runs none either. So after a drag the saved ink did
 * not come back on the reloaded pages, an undo or a lasso drag did not show, the reticle did not hide, Ctrl+C took
 * lassoed ink over selected text, a window blur did not end a live stroke and a palm was not stopped at the window.
 *
 * THE RIG. The real plugin's syncPdfControllers builds, mounts and identifies a real PdfInkController over the real
 * PageStore and PdfInkStore, and the pane's first frame binds a real InlinePenRouter to the fake scroller, whose
 * pointer listeners the cells fire. Two windows from test/popoutWindow.ts, each with its own frames, timers, pixel
 * ratio, selection, clipboard and listeners. A move swaps the document every element of the pane reports, then runs
 * the host's call for each watch on the pane's root whose window changed (as ToolbarWindowMove.test.ts does for the
 * note toolbar), then the viewer's reload: a new page div in the same scroller, and the probe cache dropped, which is
 * what the root's observer does on the reload's records. The observer itself is not run here: whether it keeps
 * firing after its node changes document is not traced. A window that closes runs no frame or timer again; a hidden
 * window is one whose frames and timers the cell never runs.
 *
 * What a pane shows is read off its page-1 canvas: attached to the page div showing now, drawn on since its last
 * clear, and painted for how many strokes (-1: drawn for an older list than the store holds now).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
	byRoot: new Map<unknown, unknown>(),
	reads: [] as Array<{ root: unknown; win: unknown }>,
	notices: [] as string[],
}));
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: string) {
			probe.notices.push(message);
		}
	},
}));
vi.mock("./PdfViewerProbe", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	probeViewer: (root: unknown, win: unknown) => {
		probe.reads.push({ root, win });
		return probe.byRoot.get(root) ?? null;
	},
	viewerCanvasOf: () => null,
	wholePageCanvasOf: () => null,
}));
vi.mock("../inline/MobileTools", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	MobileTools: class {
		setCorner() {}
		refresh() {}
		setInking() {}
		closeInkSliders() {}
		stale() {
			return false;
		}
		destroy() {}
	},
}));

import HandwritingPlugin from "../main";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";
import { setMouseInk } from "../inline/MouseInk";
import { resetPenInkForTest } from "../inline/PenInk";
import { markPenHardwareSeen, resetPenToolsForTest } from "../inline/PenToolsMode";
import { clearInkClipboard } from "../inline/InkClipboard";
import { makePopoutWindow, type PopoutWindow } from "../../test/popoutWindow";
import { penEvent } from "../../test/routerHarness";
import type { InkStroke } from "../ink/Stroke";

const A = "Lecture A.pdf";

/** A saved stroke on page 1, inside the box (x, y) to (x + 40, y + 40). */
function saved(id: string, x: number, y: number): InkStroke {
	return {
		id,
		page: 1,
		tool: "pen",
		color: "#111111",
		width: 2,
		createdAt: 0,
		points: [
			{ x, y, pressure: 0.5, t: 0 },
			{ x: x + 40, y: y + 40, pressure: 0.5, t: 8 },
		],
		bbox: { x, y, width: 40, height: 40 },
	};
}

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

/** Canvas calls that put pixels down. A full clear takes them off. */
const DRAWS = new Set(["fill", "stroke", "fillRect", "strokeRect", "drawImage", "putImageData", "fillText"]);

type FakeCanvas = Record<string, unknown> & { parentElement: unknown; drawn: number; width: number; height: number };

/** A canvas whose context takes every call and counts the ones that draw since the last clear. */
function fakeCanvas(parent: unknown): FakeCanvas {
	const c = {
		width: 300,
		height: 150,
		parentElement: parent,
		drawn: 0,
		style: {},
		setAttribute: () => {},
		remove() {
			c.parentElement = null;
		},
		getContext: () => ctx,
		setCssStyles: () => {},
		setCssProps: () => {},
		toggleClass: () => {},
		classList: { add: () => {}, remove: () => {}, contains: () => false },
		addEventListener: () => {},
	} as FakeCanvas;
	const ctx = new Proxy({} as Record<string, unknown>, {
		get: (t, p) => {
			if (p in t) return t[p as string];
			if (p === "clearRect") return () => void (c.drawn = 0);
			if (DRAWS.has(p as string)) return () => void c.drawn++;
			return () => undefined;
		},
		set: (t, p, v) => {
			t[p as string] = v;
			return true;
		},
	});
	return c;
}

type Listener = (ev: unknown) => void;
type Entry = { fn: Listener; capture: boolean };
const captureOf = (o?: boolean | { capture?: boolean }) => (typeof o === "boolean" ? o : !!o?.capture);

/** Listeners on one fake element, added and taken off by the browser's rule (function and capture). */
function listenerBag() {
	const map = new Map<string, Entry[]>();
	return {
		add(type: string, fn: Listener, o?: boolean | { capture?: boolean }) {
			const list = map.get(type) ?? [];
			const capture = captureOf(o);
			if (!list.some((e) => e.fn === fn && e.capture === capture)) list.push({ fn, capture });
			map.set(type, list);
		},
		remove(type: string, fn: Listener, o?: boolean | { capture?: boolean }) {
			const list = map.get(type);
			const capture = captureOf(o);
			const i = list ? list.findIndex((e) => e.fn === fn && e.capture === capture) : -1;
			if (list && i >= 0) list.splice(i, 1);
		},
		fire(type: string, ev: unknown) {
			for (const e of [...(map.get(type) ?? [])]) e.fn(ev);
		},
	};
}

/** One window of the app, with what the controller reads off a window beyond the popout fake. */
interface AppWindow {
	w: PopoutWindow;
	win: Window;
	clipboard: ReturnType<typeof vi.fn>;
	/** What this window's getSelection answers. */
	selection: unknown;
}

function appWindow(devicePixelRatio = 1): AppWindow {
	const w = makePopoutWindow({ devicePixelRatio });
	const clipboard = vi.fn(async (_text: string) => {});
	const out: AppWindow = { w, win: w.window, clipboard, selection: null };
	Object.assign(w.window as unknown as Record<string, unknown>, {
		navigator: { userAgent: "test", platform: "", maxTouchPoints: 0, clipboard: { writeText: clipboard } },
		getSelection: () => out.selection,
		getComputedStyle: () => ({ position: "relative", getPropertyValue: () => "" }),
	});
	return out;
}

/** Run every frame this window has been asked for, and the ones those frames ask for. */
function frames(a: AppWindow): void {
	for (let i = 0; i < 10 && a.w.pendingFrames() > 0; i++) a.w.frame();
}

/** Calls the host makes on a node that changed window, as Obsidian 1.15.0 does. */
interface Watch {
	last: unknown;
	listener: (win: Window) => unknown;
	live: boolean;
}

const mounted: Array<{ unmount(): void; mounted: boolean }> = [];

beforeEach(() => {
	resetTipModeForTest();
	resetPenInkForTest();
	resetPenToolsForTest();
	markPenHardwareSeen();
	setMouseInk(false);
	clearInkClipboard();
	probe.byRoot = new Map();
	probe.reads = [];
	probe.notices = [];
	// The plugin's own window, which the pane's window is told apart from. Its listeners go nowhere. The two getters
	// node checks its receiver on are read here, off the real global.
	const own = (value: unknown): PropertyDescriptor => ({ value, writable: true, configurable: true, enumerable: true });
	const main = Object.create(globalThis, {
		crypto: own(globalThis.crypto),
		performance: own(globalThis.performance),
		addEventListener: own(() => {}),
		removeEventListener: own(() => {}),
		document: own({ querySelectorAll: () => [] }),
	}) as Record<string, unknown>;
	vi.stubGlobal("window", main);
	vi.stubGlobal("Element", class {});
	vi.stubGlobal("HTMLElement", class {});
	vi.stubGlobal("ResizeObserver", NoopObserver);
	vi.stubGlobal("MutationObserver", NoopObserver);
});
afterEach(() => {
	for (const controller of mounted.splice(0)) if (controller.mounted) controller.unmount();
	resetTipModeForTest();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** The controller's fields and methods these cells read or call. */
type Ctl = {
	win: Window;
	router: unknown;
	mounted: boolean;
	idle: boolean;
	selected: string[];
	selectionPage: number;
	trailingSync: number | null;
	overlays: Map<number, { canvas: FakeCanvas; paintedCount: number }>;
	cursorEl: { setCssStyles(s: Record<string, unknown>): void } | null;
	refresh(): void;
	sync(): void;
	scheduleThrottled(): void;
	historyStep(redo: boolean): boolean;
	invalidateProbe(): void;
	unmount(): void;
};

function harness() {
	const adapter = new FakeAdapter();
	const store = new PageStore({ vault: { adapter } } as never);
	const pdfStore = new PdfInkStore();
	pdfStore.attachHost({
		load: (id) => store.load(id),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => {},
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing, "pdf"),
		acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
	});
	const bytes = () => new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + "a".repeat(4000) + "\n%%EOF\n");
	type Leaf = { view: { containerEl: HTMLElement; file: { path: string } } };
	const leaves: Leaf[] = [];
	const app = {
		vault: {
			adapter,
			readBinary: async () => bytes().slice().buffer,
			getFileByPath: (p: string) => (p === A ? { path: p } : null),
		},
		workspace: {
			getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []),
			onLayoutReady: () => {},
			iterateAllLeaves: () => {},
		},
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, {
		app,
		store,
		pdfStore,
		settings: { inkPdfColorMode: "auto" },
		pdfInk: new Map(),
		pdfIds: new Map(),
		pdfFiles: new Map(),
		register: () => {},
	});

	let ts = 1000;

	/** A PDF pane opened in window `at`: built by the pass over open views, identified, and bound on its first frame. */
	async function open(at: AppWindow, path = A) {
		const loc = { at };
		const doc = () => loc.at.w.document;
		const textNode = {};
		const watches: Watch[] = [];
		let pageEl = makePage();
		function makePage(): Record<string, unknown> {
			const el: Record<string, unknown> = {
				clientWidth: 600,
				clientHeight: 800,
				isConnected: true,
				getAttribute: (n: string) => (n === "data-page-number" ? "1" : null),
				querySelector: () => null,
				querySelectorAll: () => [],
				createEl: () => fakeCanvas(el),
				appendChild: (c: { parentElement: unknown }) => void (c.parentElement = el),
				insertBefore: (c: { parentElement: unknown }) => void (c.parentElement = el),
				setCssStyles: () => {},
			};
			Object.defineProperty(el, "ownerDocument", { get: doc });
			return el;
		}
		const cursorStyle: Record<string, unknown> = { display: "none" };
		const scrollerOn = listenerBag();
		const classes = new Set<string>();
		const scroller: Record<string, unknown> = {
			scrollLeft: 0,
			scrollTop: 0,
			clientWidth: 800,
			clientHeight: 600,
			scrollWidth: 800,
			scrollHeight: 800,
			isConnected: true,
			style: { touchAction: "" },
			setCssStyles(s: { touchAction?: string }) {
				if (s.touchAction !== undefined) (scroller.style as { touchAction: string }).touchAction = s.touchAction;
			},
			classList: {
				add: (c: string) => void classes.add(c),
				remove: (c: string) => void classes.delete(c),
				contains: (c: string) => classes.has(c),
				toggle: (c: string, on?: boolean) => {
					const want = on ?? !classes.has(c);
					if (want) classes.add(c);
					else classes.delete(c);
					return want;
				},
			},
			addEventListener: scrollerOn.add,
			removeEventListener: scrollerOn.remove,
			querySelector: (sel: string) => (/div\.page\[data-page-number="1"\]/.test(sel) ? pageEl : null),
			querySelectorAll: () => [pageEl],
			contains: (n: unknown) => n === scroller || n === pageEl || n === textNode,
			getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 }),
			setPointerCapture() {},
			releasePointerCapture() {},
			hasPointerCapture: () => true,
			hasAttribute: () => true,
			getAttribute: () => null,
			focus() {},
			// The reticle and its clipping parent, as the cursor cells elsewhere build them.
			createDiv: (o?: { cls?: string }) => {
				const cursor = {
					setAttribute: () => {},
					remove: () => {},
					classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
					setCssStyles: (s: Record<string, unknown>) => void Object.assign(cursorStyle, s),
					parentElement: null as unknown,
				};
				if (o?.cls !== "handwriting-pdf-cursor-viewport") return cursor;
				const viewport = {
					parentElement: scroller,
					classList: { contains: (c: string) => c === "handwriting-pdf-cursor-viewport" },
					setCssStyles() {},
					createDiv: () => cursor,
					remove() {},
				};
				cursor.parentElement = viewport;
				return viewport;
			},
		};
		Object.defineProperty(scroller, "ownerDocument", { get: doc });
		const rootOn = listenerBag();
		const root = {
			isConnected: true,
			addEventListener: rootOn.add,
			removeEventListener: rootOn.remove,
			classList: { add: () => {}, remove: () => {}, contains: () => false },
			querySelector: () => null,
			contains: (n: unknown) => n === root || (scroller.contains as (n: unknown) => boolean)(n),
			/** The host's watch on a node that changes window: remembers the window, hands back the call that ends it. */
			onWindowMigrated(listener: (win: Window) => unknown): () => void {
				const watch: Watch = { last: loc.at.win, listener, live: true };
				watches.push(watch);
				return () => {
					watch.live = false;
				};
			},
		};
		Object.defineProperty(root, "ownerDocument", { get: doc });
		const probed = () => ({
			scroller,
			scaleFactor: 1,
			scaleSource: "test",
			pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true }],
		});
		probe.byRoot.set(root, probed());
		const leaf = { view: { containerEl: root as unknown as HTMLElement, file: { path } } };
		leaves.push(leaf);
		plugin.syncPdfControllers();
		const controller = plugin.pdfInk.get(root) as Ctl;
		mounted.push(controller);
		await vi.waitFor(() => expect(plugin.pdfIds.get(root), "premise: the pane was identified").toBeDefined());
		const id = plugin.pdfIds.get(root) as string;
		await vi.waitFor(() => expect(pdfStore.inkReady(id), "premise: the ink is loaded").toBe(true));
		frames(at);
		expect(controller.router, "premise: the pane's first frame bound the pen").not.toBeNull();

		const fire = (ev: { type: string }) => scrollerOn.fire(ev.type, ev);
		const pane = {
			root,
			scroller,
			leaf,
			controller,
			id,
			loc,
			watches,
			textNode,
			page: () => pageEl,
			cursorShown: () => cursorStyle.display === "block",
			/** How many strokes page 1 shows now: 0 for none, -1 for a picture older than the store. */
			shown(): number {
				const a = controller.overlays.get(1);
				if (!a || a.canvas.parentElement !== pageEl || a.canvas.drawn === 0) return 0;
				return a.paintedCount;
			},
			canvasWidth: () => controller.overlays.get(1)?.canvas.width ?? 0,
			/** Ctrl or Cmd with a letter, pressed with focus in the pane; `code` is the physical key, for a layout of another script. */
			key(letter: string, code = `Key${letter.toUpperCase()}`): { prevented: boolean } {
				const ev = {
					key: letter,
					code,
					ctrlKey: true,
					metaKey: false,
					altKey: false,
					shiftKey: false,
					target: scroller,
					defaultPrevented: false,
					preventDefault() {
						ev.defaultPrevented = true;
					},
					stopPropagation() {},
				};
				rootOn.fire("keydown", ev);
				return { prevented: ev.defaultPrevented };
			},
			/** A pen contact at (x, y) moved 20 px right; lifted unless told not to. */
			stroke(x: number, y: number, lift = true): void {
				fire(penEvent("pointerdown", ts++, { x, y }) as unknown as { type: string });
				fire(penEvent("pointermove", ts++, { x: x + 10, y }) as unknown as { type: string });
				fire(penEvent("pointermove", ts++, { x: x + 20, y }) as unknown as { type: string });
				if (lift) this.lift(x + 20, y);
			},
			lift(x: number, y: number): void {
				fire(penEvent("pointerup", ts++, { x, y, pressure: 0, buttons: 0 }) as unknown as { type: string });
			},
			hover(x: number, y: number): void {
				fire(penEvent("pointermove", ts++, { x, y, pressure: 0, buttons: 0 }) as unknown as { type: string });
			},
			/**
			 * The tab dragged to window `to`. Every element of the pane reports that window's document; the host calls
			 * each watch on the root whose window changed; the viewer reloads into the same scroller, so page 1 is a new
			 * div and the probe cache is dropped as the root's observer drops it on the reload's records. `call` false: the
			 * host does not call (a pane moved while hidden, or a host without the call).
			 */
			moveTo(to: AppWindow, call = true): void {
				loc.at = to;
				for (const watch of call ? watches : []) {
					if (!watch.live || watch.last === to.win) continue;
					watch.last = to.win;
					watch.listener(to.win);
				}
				pageEl = makePage();
				controller.invalidateProbe();
			},
			/** A call the host already had on its way, delivered to every listener it was ever given. */
			lateCall(to: AppWindow, only: Watch[] = watches): void {
				for (const watch of only) watch.listener(to.win);
			},
			/** A palm-sized touch landing on the page, dispatched at window `a` as the browser does for capture. */
			palm(a: AppWindow, identifier: number): boolean {
				let eaten = false;
				const touch = { identifier, clientX: 300, clientY: 300, radiusX: 60, radiusY: 60 };
				const base = { target: pageEl, cancelable: true, preventDefault: () => void (eaten = true), stopPropagation: () => {} };
				a.w.dispatch("touchstart", { ...base, changedTouches: [touch], touches: [touch] });
				a.w.dispatch("touchend", { ...base, changedTouches: [touch], touches: [] });
				return eaten;
			},
		};
		return pane;
	}

	/** What the ink file on disk holds now, read by a second store: saved, not only on screen. */
	async function onDisk(id: string): Promise<string[]> {
		await store.flush();
		const reader = new PdfInkStore();
		reader.attachHost({ load: (pageId) => store.load(pageId), schedule: () => {}, notice: () => {} });
		await reader.ensureLoaded(id);
		return reader.strokes(id).map((s) => s.id);
	}
	/** The leaf closed: the next pass over open views unmounts its controller. */
	function close(pane: { leaf: unknown }): void {
		leaves.splice(leaves.indexOf(pane.leaf as Leaf), 1);
		plugin.syncPdfControllers();
	}
	function reopen(pane: { leaf: unknown }): void {
		leaves.push(pane.leaf as Leaf);
		plugin.syncPdfControllers();
	}
	return { store, pdfStore, plugin, open, onDisk, close, reopen };
}

type Harness = ReturnType<typeof harness>;
type Pane = Awaited<ReturnType<Harness["open"]>>;

/** A saved stroke on the pane's PDF, painted where the pane is now. */
function withSaved(h: Harness, pane: Pane, at: AppWindow, ...strokes: InkStroke[]): void {
	h.pdfStore.replaceAll(pane.id, strokes);
	pane.controller.refresh();
	frames(at);
	expect(pane.shown(), "premise: the saved ink shows on page 1").toBe(strokes.length);
}

/** Every frame and timer a window is asked for from now on. */
function watchAsks(a: AppWindow) {
	return {
		frames: vi.spyOn(a.win, "requestAnimationFrame"),
		timers: vi.spyOn(a.win, "setTimeout"),
		cancels: vi.spyOn(a.win, "cancelAnimationFrame"),
	};
}

describe("a PDF pane moved to another window keeps its ink working there", () => {
	it("main to pop-out, the main window's frames stopped: the saved ink is back on the reloaded page, a new stroke stays, and its undo shows, all from the pop-out", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const pane = await h.open(M);
		withSaved(h, pane, M, saved("a1", 300, 300));

		pane.moveTo(P);
		const onM = watchAsks(M);
		frames(P);
		expect.soft(pane.shown(), "the saved ink is back on the reloaded page at the pop-out's frame").toBe(1);

		pane.stroke(100, 100);
		expect.soft(pane.shown(), "the stroke lifted after the move is on screen with the saved ink").toBe(2);
		expect(await h.onDisk(pane.id), "the stroke is saved").toHaveLength(2);
		frames(P);

		expect(pane.controller.historyStep(false), "premise: the undo ran").toBe(true);
		frames(P);
		expect.soft(pane.shown(), "the undone stroke is off the screen at the pop-out's frame").toBe(1);
		expect.soft(onM.frames, "no frame asked of the main window after the move").not.toHaveBeenCalled();
		expect.soft(onM.timers, "no timer asked of the main window after the move").not.toHaveBeenCalled();
	});

	it("pop-out to main with a repaint queued in the pop-out: the pop-out closes, and the saved ink, a new stroke and its undo all show from the main window", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const pane = await h.open(P);
		withSaved(h, pane, P, saved("a1", 300, 300));
		pane.controller.refresh();
		expect(P.w.pendingFrames(), "premise: a repaint is queued on the pop-out's frame").toBe(1);

		pane.moveTo(M);
		P.w.close();
		frames(M);
		expect.soft(pane.shown(), "the saved ink is back on the reloaded page at the main window's frame").toBe(1);

		pane.stroke(100, 100);
		expect.soft(pane.shown(), "the stroke lifted after the move is on screen with the saved ink").toBe(2);
		frames(M);
		expect(pane.controller.historyStep(false), "premise: the undo ran").toBe(true);
		frames(M);
		expect.soft(pane.shown(), "the undone stroke is off the screen at the main window's frame").toBe(1);
	});

	it("pop-out to main with a throttled repaint armed on the pop-out's timer: after the pop-out closes, the next throttled repaint runs from the main window", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const pane = await h.open(P);
		withSaved(h, pane, P, saved("a1", 300, 300));
		// Inside the floor after a sync, so the throttle arms its trailing repaint on the pane's window.
		pane.controller.sync();
		pane.controller.scheduleThrottled();
		expect(pane.controller.trailingSync, "premise: a trailing repaint is armed").not.toBeNull();
		expect(P.w.pendingTimers(), "premise: on the pop-out's timer").toBe(1);

		pane.moveTo(M);
		P.w.close();
		frames(M);
		const syncs = vi.spyOn(pane.controller, "sync");
		pane.controller.scheduleThrottled();
		M.w.advance(200);
		frames(M);
		expect(syncs.mock.calls.length, "the throttled repaint after the move ran from the main window").toBeGreaterThan(0);
	});

	it("a window closed after a move: the pane moved into it closes with it and its live stroke is saved once; the pane moved out of it is kept and still draws", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const esc = h.plugin.installEscapeWindows() as { open(w: Window): void; close(w: Window): void };
		esc.open(M.win);
		esc.open(P.win);

		const into = await h.open(M);
		into.moveTo(P);
		frames(P);
		into.stroke(100, 100, false);
		expect(into.controller.idle, "premise: a stroke is being drawn").toBe(false);
		P.w.close();
		esc.close(P.win);
		expect(h.plugin.pdfInk.has(into.root), "the pane in the closed window is unmounted").toBe(false);
		expect(h.plugin.pdfIds.has(into.root), "its id is let go").toBe(false);
		expect(await h.onDisk(into.id), "the live stroke is saved, once").toHaveLength(1);

		const Q = appWindow();
		esc.open(Q.win);
		const out = await h.open(Q);
		out.moveTo(M);
		Q.w.close();
		esc.close(Q.win);
		expect(h.plugin.pdfInk.get(out.root), "the pane moved out of the closed window is kept").toBe(out.controller);
		out.stroke(200, 200);
		expect(out.shown(), "it still draws: the stroke is on screen").toBe(2);
		expect(await h.onDisk(out.id), "and saved beside the first").toHaveLength(2);
	});

	it("after a move, Ctrl+C with text selected in the new window inside the pane copies the text, not the lassoed ink", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const pane = await h.open(M);
		withSaved(h, pane, M, saved("a1", 300, 300));
		pane.controller.selected = ["a1"];
		pane.controller.selectionPage = 1;

		pane.moveTo(P);
		frames(P);
		P.selection = { isCollapsed: false, anchorNode: pane.textNode };
		const press = pane.key("c");
		expect.soft(press.prevented, "the key is left to the text selection").toBe(false);
		expect.soft(P.clipboard, "no ink marker written in the new window").not.toHaveBeenCalled();
		expect.soft(M.clipboard, "no ink marker written in the old window").not.toHaveBeenCalled();
		expect.soft(probe.notices.filter((n) => /copied/i.test(n)), "no ink said copied").toEqual([]);
	});

	it("after a move, Ctrl+C on a Russian layout with text selected in the new window inside the pane copies the text, not the lassoed ink", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const pane = await h.open(M);
		withSaved(h, pane, M, saved("a1", 300, 300));
		pane.controller.selected = ["a1"];
		pane.controller.selectionPage = 1;

		pane.moveTo(P);
		frames(P);
		P.selection = { isCollapsed: false, anchorNode: pane.textNode };
		// The layout types its own letter (Cyrillic es); the physical key is C.
		const press = pane.key(String.fromCharCode(0x441), "KeyC");
		expect.soft(press.prevented, "the key is left to the text selection").toBe(false);
		expect.soft(P.clipboard, "no ink marker written in the new window").not.toHaveBeenCalled();
		expect.soft(M.clipboard, "no ink marker written in the old window").not.toHaveBeenCalled();
		expect.soft(probe.notices.filter((n) => /copied/i.test(n)), "no ink said copied").toEqual([]);
	});

	it("after a move, a lasso drag moves the selection on the new window's frames", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const pane = await h.open(M);
		withSaved(h, pane, M, saved("a1", 300, 300));
		pane.controller.selected = ["a1"];
		pane.controller.selectionPage = 1;

		pane.moveTo(P);
		frames(P);
		setTipMode("lasso");
		pane.stroke(320, 320, false);
		frames(P);
		const during = h.pdfStore.strokes(pane.id)[0]!.bbox.x;
		pane.lift(340, 320);
		expect(h.pdfStore.strokes(pane.id)[0]!.bbox.x, "premise: the contact was a drag of the selection, landed at the lift").toBeGreaterThan(300);
		expect(during, "the selection moved under the pen during the drag").toBeGreaterThan(300);
	});

	it("a lasso drag live when the pane moves from the pop-out to main: its moves land, its frame is taken back from the pop-out only, and the next drag moves on the main window's frames", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const pane = await h.open(P);
		withSaved(h, pane, P, saved("a1", 300, 300));
		pane.controller.selected = ["a1"];
		pane.controller.selectionPage = 1;
		setTipMode("lasso");
		pane.stroke(320, 320, false);
		expect(P.w.pendingFrames(), "premise: the drag's paint waits on the pop-out's frame").toBeGreaterThan(0);

		const onP = watchAsks(P);
		const onM = watchAsks(M);
		pane.moveTo(M);
		P.w.close();
		pane.lift(340, 320);
		frames(M);
		const landed = h.pdfStore.strokes(pane.id)[0]!.bbox.x;
		expect(landed, "the first drag's moves landed").toBeGreaterThan(300);
		expect(onP.cancels, "the drag's waiting frame is taken back on the pop-out that was asked for it").toHaveBeenCalled();
		expect(onM.cancels, "the pop-out's frame id is never cancelled on the main window").not.toHaveBeenCalled();

		pane.stroke(landed + 20, 320, false);
		frames(M);
		const during = h.pdfStore.strokes(pane.id)[0]!.bbox.x;
		pane.lift(landed + 40, 320);
		expect(during, "the next drag moves the selection on the main window's frames").toBeGreaterThan(landed);
	});

	it("after a move to a sharper screen, the ink is drawn at that screen's pixel ratio, and the viewer is read through the new window", async () => {
		const h = harness();
		const M = appWindow(1);
		const P = appWindow(2);
		const pane = await h.open(M);
		withSaved(h, pane, M, saved("a1", 300, 300));
		const before = pane.canvasWidth();

		pane.moveTo(P);
		const mark = probe.reads.length;
		frames(P);
		pane.stroke(100, 100);
		expect(pane.shown(), "premise: the stroke is on screen").toBe(2);
		expect.soft(pane.canvasWidth(), "the page's canvas holds more pixels on the 2x screen").toBeGreaterThan(before);
		const reads = probe.reads.slice(mark).filter((r) => r.root === pane.root);
		expect(reads.length, "premise: the viewer was read after the move").toBeGreaterThan(0);
		expect.soft(reads.every((r) => r.win === P.win), "every viewer read after the move goes through the new window").toBe(true);
	});

	it("after a move, copying lassoed ink puts its paste marker on the new window's clipboard only", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const pane = await h.open(M);
		withSaved(h, pane, M, saved("a1", 300, 300));
		pane.controller.selected = ["a1"];
		pane.controller.selectionPage = 1;

		pane.moveTo(P);
		frames(P);
		const press = pane.key("c");
		expect(press.prevented, "premise: the key copied the lassoed ink").toBe(true);
		expect.soft(P.clipboard, "the marker is written through the new window's clipboard").toHaveBeenCalledTimes(1);
		expect.soft(M.clipboard, "the old window's clipboard is not written").not.toHaveBeenCalled();
	});

	it("after a move, the pen's reticle hides on the new window's timer, and one armed on the old window before the move still hides", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const pane = await h.open(M);
		withSaved(h, pane, M, saved("a1", 300, 300));

		pane.hover(150, 150);
		expect(pane.cursorShown(), "premise: a pen hover shows the reticle").toBe(true);
		pane.moveTo(P);
		frames(P);
		P.w.advance(1000);
		expect.soft(pane.cursorShown(), "the hide armed before the move runs from the new window").toBe(false);

		pane.hover(160, 160);
		expect(pane.cursorShown(), "premise: a pen hover after the move shows the reticle").toBe(true);
		P.w.advance(1000);
		expect.soft(pane.cursorShown(), "the reticle hides on the new window's timer").toBe(false);
	});

	it("a pane that never moves: its frames and timers stay on its own window, and a stroke and its undo show as before", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const pane = await h.open(M);
		withSaved(h, pane, M, saved("a1", 300, 300));
		const onP = watchAsks(P);

		pane.stroke(100, 100);
		expect(pane.shown(), "the stroke is on screen").toBe(2);
		frames(M);
		expect(pane.controller.historyStep(false), "premise: the undo ran").toBe(true);
		frames(M);
		expect(pane.shown(), "the undone stroke is off the screen").toBe(1);
		pane.hover(150, 150);
		M.w.advance(1000);
		expect(pane.cursorShown(), "the reticle hides on its own window's timer").toBe(false);
		expect(pane.controller.win, "the pane's window is the one it was built in").toBe(M.win);
		expect(onP.frames, "no frame asked of the other window").not.toHaveBeenCalled();
		expect(onP.timers, "no timer asked of the other window").not.toHaveBeenCalled();
		expect(M.w.pendingFrames(), "no repaint left waiting").toBe(0);
	});

	it("two panes on one PDF, one moved to a pop-out: one record, a stroke drawn once in each pane, saved once", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const first = await h.open(M);
		const second = await h.open(M);
		expect(second.id, "premise: both panes show the same PDF").toBe(first.id);
		second.moveTo(P);
		frames(M);
		frames(P);

		first.stroke(100, 100);
		frames(M);
		frames(P);
		expect(h.pdfStore.strokes(first.id), "one record holds the stroke once").toHaveLength(1);
		expect(first.shown(), "the pane it was drawn in shows it once").toBe(1);
		expect(second.shown(), "the moved pane shows it once").toBe(1);
		expect(await h.onDisk(first.id), "saved once").toHaveLength(1);
	});

	it("a host call that arrives after the pane closed, or for a root that now has another controller, does nothing", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const pane = await h.open(M);
		const old = pane.controller;
		h.close(pane);
		expect(old.mounted, "premise: the pane closed").toBe(false);
		const onP = watchAsks(P);
		const onM = watchAsks(M);
		pane.loc.at = P;
		expect(() => pane.lateCall(P), "a late call after the close does not throw").not.toThrow();
		expect(old.win, "the closed controller's window is left as it was").toBe(M.win);
		expect(old.router, "no pen bound on a closed controller").toBeNull();
		expect(onP.frames, "no frame asked of the new window").not.toHaveBeenCalled();
		expect(onM.frames, "no frame asked of the old window").not.toHaveBeenCalled();

		pane.loc.at = M;
		const before = [...pane.watches];
		h.reopen(pane);
		const now = h.plugin.pdfInk.get(pane.root) as Ctl;
		expect(now, "premise: the same root has a new controller").not.toBe(old);
		mounted.push(now);
		pane.lateCall(P, before);
		expect(old.win, "the old controller is not moved").toBe(M.win);
		expect(old.router, "and binds no pen").toBeNull();
		expect(now.win, "the new controller is not moved by a call meant for the old one").toBe(M.win);
	});

	it("after a move, a window blur in the new window ends a live stroke and saves it, and the next pen-down starts a new stroke", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const pane = await h.open(M);
		pane.moveTo(P);
		frames(P);

		pane.stroke(100, 100, false);
		expect(pane.controller.idle, "premise: a stroke is being drawn").toBe(false);
		P.w.dispatch("blur");
		expect(pane.controller.idle, "the blur ended the stroke").toBe(true);
		expect(h.pdfStore.strokes(pane.id), "and committed it").toHaveLength(1);

		pane.stroke(200, 200);
		expect(h.pdfStore.strokes(pane.id), "the next pen-down drew a new stroke").toHaveLength(2);
		expect(await h.onDisk(pane.id), "both saved").toHaveLength(2);
	});

	it("after a move, a palm-sized touch on the page is stopped at the new window's capture", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const pane = await h.open(M);
		expect(pane.palm(M, 1), "premise: before the move the palm is stopped at the window's capture").toBe(true);

		pane.moveTo(P);
		frames(P);
		expect(pane.palm(P, 2), "the palm is stopped at the new window's capture").toBe(true);
	});

	it("a pane moved with no call from the host: the next repaint asked brings the saved ink back from the new window, a stroke and its undo show there, and a blur there ends a live stroke", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const pane = await h.open(M);
		withSaved(h, pane, M, saved("a1", 300, 300));

		pane.moveTo(P, false);
		const onM = watchAsks(M);
		// What asks next: the viewer's reload seen by the root's observer, as the observer asks.
		pane.controller.scheduleThrottled();
		frames(P);
		expect.soft(pane.shown(), "the saved ink is back on the reloaded page at the new window's frame").toBe(1);

		pane.stroke(100, 100);
		expect.soft(pane.shown(), "the stroke is on screen with the saved ink").toBe(2);
		frames(P);
		expect(pane.controller.historyStep(false), "premise: the undo ran").toBe(true);
		frames(P);
		expect.soft(pane.shown(), "the undone stroke is off the screen at the new window's frame").toBe(1);

		pane.stroke(200, 200, false);
		P.w.dispatch("blur");
		expect.soft(pane.controller.idle, "a blur in the new window ends the live stroke").toBe(true);
		expect.soft(onM.frames, "no frame asked of the old window after the move").not.toHaveBeenCalled();
		expect.soft(onM.timers, "no timer asked of the old window after the move").not.toHaveBeenCalled();
	});
});
