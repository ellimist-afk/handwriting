/**
 * A PDF pane moved to another window with no call from the host: the repaint step's three ways to the new window.
 *
 * The host calls back on a node that changed window only while it is showing, so a pane moved while hidden, or a stroke
 * lifted before the call, reaches the new window through the repaint step instead: the next repaint asked notices the
 * pane's root is in another window and follows it there. Three branches of that step are pinned here, each by the
 * moment it decides:
 *
 * - A stroke open at the move. The repaint it asks does not end it there and then: it waits for the new window's frame,
 *   and that frame ends it, saved once, and moves the pane.
 * - A repaint queued on the old window before the move, that window still running. When its frame comes, it hands the
 *   pane to the new window instead of painting from the old one, so the ink is drawn at the new window's pixel ratio
 *   and the viewer is read through the new window.
 * - The same queued repaint, with the pane followed before its frame came. That late frame paints nothing and does not
 *   clear the new window's queued repaint, so there is one paint, from the new window.
 *
 * THE RIG is PdfWindowMoveKeepsInk.test.ts's, copied unchanged from its imports to its `watchAsks` helper: the real
 * plugin builds, mounts and identifies a real PdfInkController over the real PageStore and PdfInkStore, the pane's
 * first frame binds a real InlinePenRouter to the fake scroller, and two windows from test/popoutWindow.ts each run
 * their own frames and timers. `moveTo(to, false)` is the move with no host call: every element of the pane reports
 * the new window's document, and the viewer reloads into the same scroller.
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

describe("a PDF pane moved with no call from the host: the repaint step takes it to the new window", () => {
	it("a stroke open at the move: the repaint asked mid-stroke leaves it drawing, and the new window's frame ends it, saved once, and draws there", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const pane = await h.open(M);
		withSaved(h, pane, M, saved("ink1", 300, 300));

		pane.stroke(100, 100, false);
		expect(pane.controller.idle, "premise: a stroke is being drawn").toBe(false);
		pane.moveTo(P, false);
		// What asks next: the viewer's reload seen by the root's observer, as the observer asks.
		pane.controller.scheduleThrottled();
		expect.soft(pane.controller.idle, "the repaint asked mid-stroke ended the stroke there and then").toBe(false);
		expect.soft(h.pdfStore.strokes(pane.id), "the stroke was saved before the new window's frame").toHaveLength(1);
		expect.soft(pane.controller.win, "the pane went to the new window before its frame").toBe(M.win);
		expect(P.w.pendingFrames(), "premise: the repaint waits on the new window's frame").toBe(1);

		frames(P);
		expect.soft(pane.controller.idle, "the new window's frame ended the stroke").toBe(true);
		expect.soft(h.pdfStore.strokes(pane.id), "the stroke is saved, once").toHaveLength(2);
		expect.soft(pane.controller.win, "the pane follows the new window").toBe(P.win);
		expect.soft(pane.shown(), "the stroke is on screen with the saved ink").toBe(2);
	});

	it("a repaint queued on the old window before the move, that window still running: its frame hands the pane to the new window, and the ink is drawn at that window's pixel ratio through that window", async () => {
		const h = harness();
		const M = appWindow(1);
		const P = appWindow(2);
		const pane = await h.open(M);
		withSaved(h, pane, M, saved("ink1", 300, 300));
		const before = pane.canvasWidth();

		// An ink change asks a repaint of the window the pane is in.
		pane.controller.refresh();
		expect(M.w.pendingFrames(), "premise: the repaint waits on the old window's frame").toBe(1);
		pane.moveTo(P, false);
		const mark = probe.reads.length;

		// The old window still runs: the frame queued there comes.
		frames(M);
		expect.soft(pane.controller.win, "the old window's frame left the pane on the old window").toBe(P.win);
		frames(P);
		expect(pane.shown(), "premise: the saved ink is on the reloaded page").toBe(1);
		expect.soft(pane.canvasWidth(), "the page's canvas holds more pixels on the 2x screen").toBeGreaterThan(before);
		const reads = probe.reads.slice(mark).filter((r) => r.root === pane.root);
		expect(reads.length, "premise: the viewer was read after the move").toBeGreaterThan(0);
		expect.soft(reads.every((r) => r.win === P.win), "every viewer read after the move goes through the new window").toBe(true);
	});

	it("a repaint queued on the old window before the move, the pane followed before that frame came: the old window's late frame paints nothing, and the new window paints once", async () => {
		const h = harness();
		const M = appWindow();
		const P = appWindow();
		const pane = await h.open(M);
		withSaved(h, pane, M, saved("ink1", 300, 300));

		// An ink change asks a repaint of the window the pane is in.
		pane.controller.refresh();
		expect(M.w.pendingFrames(), "premise: the repaint waits on the old window's frame").toBe(1);
		pane.moveTo(P, false);
		// The viewer's reload seen by the root's observer: no gesture open, so the pane follows there and then.
		pane.controller.scheduleThrottled();
		expect(pane.controller.win, "premise: the pane follows the new window").toBe(P.win);
		expect(P.w.pendingFrames(), "premise: the follow asked the new window for its repaint").toBe(1);
		const syncs = vi.spyOn(pane.controller, "sync");

		// The old window still runs: the frame queued there before the move comes late.
		frames(M);
		expect.soft(syncs, "the old window's late frame painted").not.toHaveBeenCalled();
		// An ink change between the two frames rides the repaint the new window already has queued.
		pane.controller.refresh();
		expect.soft(P.w.pendingFrames(), "a second repaint was queued on the new window").toBe(1);
		frames(P);
		expect.soft(syncs, "one paint, from the new window's frame").toHaveBeenCalledTimes(1);
		expect.soft(pane.shown(), "the saved ink is on the reloaded page").toBe(1);
	});
});
