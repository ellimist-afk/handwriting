/**
 * A pop-out window's own hide ends the strokes in that window, and closing it leaves nothing listening there.
 *
 * The plugin listened for a hide on the main window only, so a pop-out minimized or covered mid-stroke left its stroke
 * open with nothing written, and a deck presenting there kept its gesture. Each window that opens now gets the same
 * hide the main window has, scoped to it: its note and PDF strokes and its deck's gesture end, committed, before the
 * writes are dispatched; the main window's strokes are left drawing. The window's close takes the listener off again.
 *
 * WHAT RUNS FOR REAL: the plugin's onload and its window-open and window-close handlers (the onload harness of
 * PageGuidesSetting.test.ts, with registerDomEvent adding for real), the pen routers, the Slides controller and its
 * deck. The pop-outs are counted fakes: test/popoutWindow.ts for notes, the freeze tests' FakeDoc for a deck.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeEl, installFakeWindow, penEvent, recorder } from "../test/routerHarness";
import { makePopoutWindow, type PopoutWindow } from "../test/popoutWindow";

installFakeWindow();

/** A body class list that behaves like the real one, for the calls the plugin makes. */
class ClassSet {
	readonly names = new Set<string>();
	add(...n: string[]): void {
		for (const x of n) this.names.add(x);
	}
	remove(...n: string[]): void {
		for (const x of n) this.names.delete(x);
	}
	contains(n: string): boolean {
		return this.names.has(n);
	}
	toggle(n: string, force?: boolean): boolean {
		const on = force ?? !this.names.has(n);
		if (on) this.names.add(n);
		else this.names.delete(n);
		return on;
	}
}

function fakeDocument(): Record<string, unknown> & { body: Record<string, unknown> & { classList: ClassSet } } {
	const sink = { add: () => {}, remove: () => {}, contains: () => false, toggle: () => false };
	return {
		body: { classList: new ClassSet(), querySelector: () => null, querySelectorAll: () => [], appendChild: () => {} },
		documentElement: { classList: sink },
		head: { appendChild: () => {} },
		createElement: () => ({ classList: sink, style: {}, appendChild: () => {}, setAttribute: () => {} }),
		addEventListener: () => {},
		removeEventListener: () => {},
		querySelector: () => null,
		querySelectorAll: () => [],
	};
}

const mainDoc = fakeDocument();
(globalThis as Record<string, unknown>).document = mainDoc;
(globalThis as Record<string, unknown>).MutationObserver = class {
	observe() {}
	disconnect() {}
	takeRecords() {
		return [];
	}
};
Object.assign(window, {
	setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
	clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
	document: mainDoc,
	matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
});

import HandwritingPlugin from "./main";
import { InlinePenRouter } from "./inline/InlinePenRouter";
import { SlidesDeck, activeSlidesActions, setSlidesInk, type SlidesInkHost } from "./slides/SlidesInkSurface";
import { FakeDoc, FakeEl } from "./testUtils/fakeDom";

const noop = () => {};
const emptyEventRef = {};

type Plugin = Record<string, any> & { onload(): Promise<void>; onunload(): void };
interface Rig {
	plugin: Plugin;
	/** The workspace's window-open, as Obsidian triggers it for a pop-out. */
	openWindow(win: unknown): void;
	/** The workspace's window-close. */
	closeWindow(win: unknown): void;
	unload(): void;
}

const rigs: Rig[] = [];
afterEach(() => {
	for (const r of rigs.splice(0)) r.unload();
});

async function loadPlugin(): Promise<Rig> {
	const handlers = new Map<string, (...a: unknown[]) => void>();
	const unloaders: Array<() => void> = [];
	const intervals: Array<ReturnType<typeof setInterval>> = [];
	const app = {
		loadLocalStorage: () => null,
		saveLocalStorage: noop,
		vault: {
			adapter: {
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				mkdir: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => null,
				remove: async () => {},
				rename: async () => {},
			},
			on: () => emptyEventRef,
			getFileByPath: () => null,
			getMarkdownFiles: () => [],
			getFiles: () => [],
			getAbstractFileByPath: () => null,
			cachedRead: async () => "",
			read: async () => "",
			configDir: ".obsidian",
		},
		workspace: {
			on: (name: string, fn: (...a: unknown[]) => void) => {
				handlers.set(name, fn);
				return emptyEventRef;
			},
			offref: noop,
			onLayoutReady: (fn: () => void) => fn(),
			getLeavesOfType: () => [],
			getActiveFile: () => null,
			getActiveViewOfType: () => null,
			activeLeaf: null,
			iterateAllLeaves: () => {},
			trigger: noop,
		},
		metadataCache: { on: () => emptyEventRef, getFileCache: () => null, getCache: () => null },
		keymap: { pushScope: noop, popScope: noop },
		scope: {},
		fileManager: { processFrontMatter: async () => {} },
	};
	const plugin = new (HandwritingPlugin as unknown as new (a: unknown, m: unknown) => Plugin)(app, {});
	type Target = { addEventListener?: (...a: unknown[]) => void; removeEventListener?: (...a: unknown[]) => void };
	Object.assign(plugin, {
		app,
		manifest: { id: "handwriting", version: "0.0.0-test", dir: ".obsidian/plugins/handwriting" },
		addCommand: (command: unknown) => command,
		registerView: noop,
		addSettingTab: noop,
		addRibbonIcon: () => ({ addClass: noop }),
		addStatusBarItem: () =>
			new Proxy({}, { get: (_t, k) => (k === "style" || k === "classList" || k === "dataset" ? new Proxy({}, { get: () => noop }) : noop) }),
		registerEvent: (ref: unknown) => ref,
		// As Obsidian's: added now, taken off at unload.
		registerDomEvent: (el: Target | null | undefined, type: string, fn: unknown, opts?: unknown) => {
			el?.addEventListener?.(type, fn, opts);
			unloaders.push(() => el?.removeEventListener?.(type, fn, opts));
		},
		registerInterval: (id: ReturnType<typeof setInterval>) => {
			intervals.push(id);
			return id;
		},
		registerEditorExtension: noop,
		registerMarkdownPostProcessor: noop,
		registerObsidianProtocolHandler: noop,
		register: (fn: () => void) => void unloaders.push(fn),
		loadData: async () => undefined,
		saveData: async () => {},
	});
	await plugin.onload();
	const rig: Rig = {
		plugin,
		openWindow: (win) => handlers.get("window-open")?.({}, win),
		closeWindow: (win) => handlers.get("window-close")?.({}, win),
		unload: () => {
			plugin.onunload();
			for (const fn of unloaders.splice(0)) fn();
			for (const id of intervals.splice(0)) clearInterval(id);
		},
	};
	rigs.push(rig);
	return rig;
}

// ---- notes in two windows ------------------------------------------------------------------------------------------

/** A counted pop-out with the body the plugin stamps its paper class on. */
function popout(): PopoutWindow {
	const B = makePopoutWindow();
	Object.assign(B.document.body, { classList: new ClassSet(), querySelector: () => null, querySelectorAll: () => [] });
	Object.assign(B.document, { querySelector: () => null, querySelectorAll: () => [] });
	return B;
}

type Scroller = ReturnType<typeof fakeEl> & { ownerDocument?: unknown };
interface Note {
	el: Scroller;
	router: InlinePenRouter;
	rec: ReturnType<typeof recorder>;
}

const built: InlinePenRouter[] = [];
afterEach(() => {
	for (const r of built.splice(0)) r.dispose();
});

/** A note's router; with no document it reads as the main window. */
function noteIn(doc?: unknown): Note {
	const el = (doc === undefined ? fakeEl() : Object.assign(fakeEl(), { ownerDocument: doc })) as Scroller;
	const rec = recorder();
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, rec.cb);
	built.push(router);
	return { el, router, rec };
}

let clock = 1000;
function pen(n: Note, type: "pointerdown" | "pointermove" | "pointerup"): void {
	const h = n.el.handlers.get(type);
	if (!h) throw new Error(`the router registered no ${type} on the scroller`);
	const lift = type === "pointerup";
	h(penEvent(type, (clock += 16), { buttons: lift ? 0 : 1, pressure: lift ? 0 : 0.4 }));
}

function activePenId(n: Note): number | null {
	return (n.router as unknown as { activePenId: number | null }).activePenId;
}

/** Every hide listener on the pop-out: its document's visibilitychange, and the window's visibilitychange and pagehide. */
function hideListeners(B: PopoutWindow): number {
	return B.documentListeners("visibilitychange") + B.listeners("visibilitychange") + B.listeners("pagehide");
}

describe("a pop-out's own hide", () => {
	// One pen, so one live stroke at a time: a pen down in one pane ends a stroke still open in another.
	it("ends the stroke in the pop-out", async () => {
		const rig = await loadPlugin();
		const B = popout();
		rig.openWindow(B.window);
		noteIn();
		const inPopout = noteIn(B.document);
		pen(inPopout, "pointerdown");
		expect(activePenId(inPopout), "the pop-out's stroke is live").toBe(7);

		B.setHidden(true);

		expect(inPopout.rec.ups, "the pop-out hid and its stroke was not committed").toBe(1);
		expect(activePenId(inPopout), "the pop-out's stroke is still open after its hide").toBeNull();
	});

	it("leaves the main window's stroke drawing", async () => {
		const rig = await loadPlugin();
		const B = popout();
		rig.openWindow(B.window);
		const main = noteIn();
		noteIn(B.document);
		pen(main, "pointerdown");
		expect(activePenId(main), "the main window's stroke is live").toBe(7);

		B.setHidden(true);

		expect(main.rec.ups, "the pop-out's hide ended the main window's stroke").toBe(0);
		expect(activePenId(main), "the main window's stroke is no longer open").toBe(7);
		const moves = main.rec.moveCounts.length;
		pen(main, "pointermove");
		expect(main.rec.moveCounts.length, "the main window's next move did not ink").toBe(moves + 1);
		pen(main, "pointerup");
		expect(main.rec.ups, "the main window's stroke did not land at its lift").toBe(1);
	});

	it("commits the pop-out's stroke before it dispatches the writes, so the write holds it", async () => {
		const rig = await loadPlugin();
		const B = popout();
		rig.openWindow(B.window);
		const order: string[] = [];
		const store = rig.plugin.store as { flushDispatch(): void };
		const dispatch = store.flushDispatch.bind(store);
		store.flushDispatch = () => {
			order.push("dispatch");
			dispatch();
		};
		const inPopout = noteIn(B.document);
		const up = inPopout.rec.cb.onPenUp;
		inPopout.rec.cb.onPenUp = (ev) => {
			order.push("commit");
			up(ev);
		};
		pen(inPopout, "pointerdown");

		B.setHidden(true);

		expect(order, "the pop-out's hide neither committed its stroke nor dispatched").not.toEqual([]);
		expect(order[0], "the writes were dispatched before the pop-out's stroke was committed").toBe("commit");
		expect(order, "the pop-out's hide did not dispatch the writes").toContain("dispatch");
	});

	it("is listened for when the pop-out opens, and closing the pop-out takes every listener off it", async () => {
		const rig = await loadPlugin();
		const B = popout();
		rig.openWindow(B.window);
		expect(hideListeners(B), "the pop-out opened and nothing listens for its hide").toBeGreaterThan(0);

		rig.closeWindow(B.window);
		B.close();

		const live = [...new Set(B.calls.map((c) => `${c.target} ${c.type}`))]
			.map((key) => {
				const [target, type] = key.split(" ") as [string, string];
				return { key, n: target === "document" ? B.documentListeners(type) : B.listeners(type) };
			})
			.filter((x) => x.n > 0);
		expect(live, "listeners left on the closed pop-out").toEqual([]);
		expect(B.calls.filter((c) => c.afterClose && c.op === "add"), "added to the pop-out after it closed").toEqual([]);
	});
});

// ---- a deck presenting in the pop-out ------------------------------------------------------------------------------

/** A pop-out document holding a presentation, the fake the freeze tests present on, with its own visibility. */
function deckPopout(): { doc: FakeDoc; win: Record<string, unknown>; hide(): void } {
	const doc = new FakeDoc();
	const container = new FakeEl("div", doc);
	const reveal = new FakeEl("div", doc);
	const slides = new FakeEl("div", doc);
	reveal.rect = { left: 0, top: 0, width: 1000, height: 800 };
	reveal.clientWidth = 1000;
	reveal.clientHeight = 800;
	slides.rect = { left: 20, top: 25, width: 480, height: 350 };
	slides.clientWidth = 960;
	slides.clientHeight = 700;
	for (let i = 0; i < 3; i++) {
		const s = new FakeEl("section", doc);
		s.textContent = `slide ${i}`;
		if (i === 0) s.classes.add("present");
		slides.children.push(s);
	}
	container.querySelector = ((sel: string) => (sel === ".reveal" ? reveal : null)) as never;
	reveal.querySelector = ((sel: string) => (sel === ".slides" ? slides : null)) as never;
	doc.container = container;
	let hidden = false;
	Object.defineProperty(doc, "hidden", { get: () => hidden });
	Object.defineProperty(doc, "visibilityState", { get: () => (hidden ? "hidden" : "visible") });
	const win = doc.defaultView as unknown as Record<string, unknown>;
	win.document = doc;
	const winListeners = (doc as unknown as { winListeners: { handlers(type: string): Array<(ev: unknown) => void> } })
		.winListeners;
	return {
		doc,
		win,
		hide: () => {
			hidden = true;
			doc.fire("visibilitychange");
			for (const fn of winListeners.handlers("visibilitychange")) fn({ type: "visibilitychange" });
		},
	};
}

function slidesHost(documents: unknown[]): SlidesInkHost {
	return {
		activeFilePath: () => "Deck.md",
		documents: () => documents as Document[],
		readSource: async () => "slide 0\n\n---\n\nslide 1\n\n---\n\nslide 2",
		readPageId: () => null,
		claimId: async (_path, proposed) => ({ pageId: proposed }),
		newPageId: () => "popout-hide-deck",
		loadSidecar: async () => null,
		scheduleSidecar: () => undefined,
		saveSidecarNow: async () => undefined,
		nib: () => ({ tool: "pen", color: "#123456", width: 2 }),
		eraserRadiusPx: () => 12,
		eraseWholeStrokes: () => true,
		notify: () => undefined,
		buildId: "popout-hide-test",
	};
}

describe("a pop-out's own hide, Slides", () => {
	afterEach(() => {
		setSlidesInk(false);
		vi.restoreAllMocks();
	});

	it("ends the gesture of the deck presenting in the pop-out, once", async () => {
		const rig = await loadPlugin();
		const B = deckPopout();
		setSlidesInk(false);
		setSlidesInk(true, slidesHost([mainDoc, B.doc]));
		expect(activeSlidesActions(B.doc as unknown as Document), "premise: a deck is live in the pop-out").not.toBeNull();
		const finish = vi.spyOn(SlidesDeck.prototype, "finishGesture");
		rig.openWindow(B.win);
		expect(finish, "premise: nothing ended the gesture before the hide").not.toHaveBeenCalled();

		B.hide();

		expect(finish, "the pop-out hid and its deck's gesture was not ended once").toHaveBeenCalledTimes(1);
	});
});
