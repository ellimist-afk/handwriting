/**
 * Audit probe R5-Slides-c-1 (read-only audit of tag 1a05f62c).
 *
 * Claim: setSlidesInk(true) installs its only mount signal, a MutationObserver
 * (childList, no subtree), on presentationDoc().body, i.e. the document that was
 * active when slides ink was switched on (the main window at plugin load). The
 * core Slides plugin builds its deck with activeDocument.body.createDiv(
 * "slides-container") (Obsidian 1.13.7 app.js openFile), so a presentation
 * started from a popout lands on a body nobody watches; nothing else calls
 * scanForSlides for a body-level div, and the deck never mounts.
 *
 * Drives the REAL setSlidesInk / scanForSlides / SlidesDeck / activeSlidesActions.
 * The DOM fakes are copied from src/slides/SlidesInkSurface.test.ts (via the
 * R5-Slides-b-1 probe). The only new fake is a MutationObserver with browser
 * semantics: a childList mutation on a body is delivered (as a microtask) to
 * the observers registered on THAT body, and to no other.
 *
 * Asserts the CORRECT behaviour: a presentation that opens in a window gets a
 * live deck (activeSlidesActions(thatDoc) !== null) and a stroke drawn on it
 * commits. Controls prove the fakes mount a deck when the watched body mutates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	ScreenRect,
	SlidesInkHost,
	activeSlidesActions,
	setSlidesInk,
} from "./SlidesInkSurface";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { setInkThemeOverride } from "../ink/InkTheme";

type AnyEvent = Record<string, unknown> & { type: string };
const deckLogs: string[] = [];

beforeEach(() => {
	setDiagnosticsEnabled(false);
	deckLogs.length = 0;
	vi.spyOn(console, "debug").mockImplementation((...args: unknown[]) => {
		deckLogs.push(args.map(String).join(" "));
	});
});

afterEach(() => {
	setDiagnosticsEnabled(false);
	vi.restoreAllMocks();
	setInkThemeOverride(null);
});

class FakeEl {
	createEl(tag: string): FakeEl {
		const child = this.ownerDocument.createElement(tag);
		this.appendChild(child);
		return child;
	}
	createDiv(): FakeEl {
		return this.createEl("div");
	}
	readonly style: Record<string, string> = { position: "", touchAction: "" };
	readonly children: FakeEl[] = [];
	className = "";
	id = "";
	textContent = "";
	rect: ScreenRect = { left: 0, top: 0, width: 0, height: 0 };
	clientWidth = 0;
	clientHeight = 0;
	rectCalls = 0;
	backingWrites = 0;
	readonly classes = new Set<string>();
	readonly listeners: Array<{ type: string; fn: (ev: unknown) => void }> = [];
	readonly captured: number[] = [];
	readonly captureCalls: number[] = [];
	readonly classList = {
		add: (c: string) => void this.classes.add(c),
		remove: (c: string) => void this.classes.delete(c),
		contains: (c: string) => this.classes.has(c),
	};
	isContentEditable = false;
	readonly attributes = new Map<string, string>();
	private _tabIndex = -1;
	get tabIndex(): number {
		return this._tabIndex;
	}
	set tabIndex(v: number) {
		this._tabIndex = v;
		this.attributes.set("tabindex", String(v));
	}
	constructor(
		readonly tagName: string,
		readonly ownerDocument: FakeDoc
	) {}
	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}
	setCssStyles(styles: Record<string, string>): void {
		Object.assign(this.style, styles);
	}
	addEventListener(type: string, fn: (ev: unknown) => void): void {
		this.listeners.push({ type, fn });
	}
	removeEventListener(type: string, fn: (ev: unknown) => void): void {
		const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn);
		if (i >= 0) this.listeners.splice(i, 1);
	}
	getBoundingClientRect(): ScreenRect {
		this.rectCalls++;
		return this.rect;
	}
	appendChild(child: FakeEl): void {
		if (child.parentElement) child.remove();
		this.children.push(child);
		child.parentElement = this;
	}
	parentElement: FakeEl | null = null;
	remove(): void {
		const p = this.parentElement;
		if (p) {
			const i = p.children.indexOf(this);
			if (i >= 0) p.children.splice(i, 1);
		}
		this.parentElement = null;
	}
	contains(other: unknown): boolean {
		return other === this;
	}
	readonly focusCalls: unknown[] = [];
	focus(options?: unknown): void {
		this.focusCalls.push(options);
		if (this.attributes.has("tabindex")) this.ownerDocument.activeElement = this;
	}
	blur(): void {
		if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
	}
	setPointerCapture(id: number): void {
		this.captured.push(id);
		this.captureCalls.push(id);
	}
	releasePointerCapture(id: number): void {
		const i = this.captured.indexOf(id);
		if (i >= 0) this.captured.splice(i, 1);
	}
	dispatch(ev: AnyEvent): void {
		for (const l of this.listeners.slice()) if (l.type === ev.type) l.fn(ev);
	}
}

function fakeCtx(): CanvasRenderingContext2D {
	return new Proxy(
		{},
		{
			get(_t, prop) {
				if (prop === "getContextAttributes") return () => ({ desynchronized: false });
				return () => undefined;
			},
			set: () => true,
		}
	) as unknown as CanvasRenderingContext2D;
}

class FakeDoc {
	activeElement: unknown = null;
	defaultView!: FakeWin;
	head: { querySelector: (selectors: string) => unknown } | undefined;
	createElement(tag: string): FakeEl {
		const el = new FakeEl(tag, this);
		const canvas = el as unknown as {
			getContext: () => CanvasRenderingContext2D | null;
			width: number;
			height: number;
		};
		canvas.getContext = () => fakeCtx();
		let w = 0;
		let h = 0;
		Object.defineProperty(el, "width", {
			configurable: true,
			get: () => w,
			set: (v: number) => {
				w = v;
				el.backingWrites++;
			},
		});
		Object.defineProperty(el, "height", {
			configurable: true,
			get: () => h,
			set: (v: number) => {
				h = v;
				el.backingWrites++;
			},
		});
		canvas.width = 0;
		canvas.height = 0;
		el.backingWrites = 0;
		return el;
	}
}

class FakeWin {
	devicePixelRatio = 1;
	computedPosition = "static";
	navigator: { userAgent?: string; platform?: string; maxTouchPoints?: number } | undefined =
		undefined;
	computedBackground: unknown = undefined;
	readonly timers = new Map<number, { fn: () => void; delay: number }>();
	readonly frames = new Map<number, () => void>();
	private nextTimer = 1;
	private nextFrame = 1;
	setTimeout(fn: () => void, delay = 0): number {
		const id = this.nextTimer++;
		this.timers.set(id, { fn, delay });
		return id;
	}
	clearTimeout(id: number): void {
		this.timers.delete(id);
	}
	requestAnimationFrame(fn: () => void): number {
		const id = this.nextFrame++;
		this.frames.set(id, fn);
		return id;
	}
	cancelAnimationFrame(id: number): void {
		this.frames.delete(id);
	}
	getComputedStyle(): { position: string; backgroundColor: unknown } {
		return { position: this.computedPosition, backgroundColor: this.computedBackground };
	}
	readonly mediaQueries: Array<{ query: string; listeners: Array<() => void> }> = [];
	matchMedia(query: string): MediaQueryList {
		const entry = { query, listeners: [] as Array<() => void> };
		this.mediaQueries.push(entry);
		return {
			media: query,
			matches: true,
			addEventListener: (_type: string, fn: () => void) => void entry.listeners.push(fn),
			removeEventListener: (_type: string, fn: () => void) => {
				const i = entry.listeners.indexOf(fn);
				if (i >= 0) entry.listeners.splice(i, 1);
			},
		} as unknown as MediaQueryList;
	}
	addEventListener(): void {
		/* never fired */
	}
	removeEventListener(): void {
		/* ditto */
	}
	readonly MutationObserver = class {
		observe(): void {
			/* inert */
		}
		disconnect(): void {
			/* inert */
		}
	};
}

// ---- browser-semantics MutationObserver -------------------------------------

type ObsRec = { target: unknown; opts: MutationObserverInit; cb: () => void; live: boolean };
const observations: ObsRec[] = [];

class FakeMutationObserver {
	private readonly recs: ObsRec[] = [];
	constructor(private readonly cb: () => void) {}
	observe(target: unknown, opts: MutationObserverInit): void {
		const rec: ObsRec = { target, opts, cb: this.cb, live: true };
		this.recs.push(rec);
		observations.push(rec);
	}
	disconnect(): void {
		for (const r of this.recs) r.live = false;
		this.recs.length = 0;
	}
}

/** Live observers registered on `target` with childList. */
function watchersOf(target: unknown): ObsRec[] {
	return observations.filter((r) => r.live && r.target === target && r.opts.childList);
}

/** A direct-child append to `target`: queue each watcher's callback as a microtask, as a browser does. */
function childListMutation(target: unknown): void {
	for (const r of watchersOf(target)) queueMicrotask(() => r.cb());
}

/** A window's document with a body whose `:scope > .slides-container` query can be answered. */
interface Win {
	doc: FakeDoc;
	body: { querySelector: (sel: string) => FakeEl | null };
	/** Obsidian: activeDocument.body.createDiv("slides-container") (plus .reveal > .slides). */
	openPresentation: () => { container: FakeEl; reveal: FakeEl; slides: FakeEl };
	/** Any other direct-child append on this body (e.g. gm()'s reveal.js script on first use). */
	otherBodyChild: () => void;
}

function makeWin(): Win {
	const doc = new FakeDoc();
	doc.defaultView = new FakeWin();
	let current: FakeEl | null = null;
	const body = {
		querySelector: (sel: string) => (sel === ":scope > .slides-container" ? current : null),
	};
	(doc as unknown as { body: unknown }).body = body;
	return {
		doc,
		body,
		openPresentation: () => {
			const els = makeDeckElements(doc);
			current = els.container;
			childListMutation(body);
			return els;
		},
		otherBodyChild: () => childListMutation(body),
	};
}

/** Copied from SlidesInkSurface.test.ts's pop-out describe: the trio findDeck walks. */
function makeDeckElements(doc: FakeDoc): { container: FakeEl; reveal: FakeEl; slides: FakeEl } {
	const container = new FakeEl("div", doc);
	const reveal = new FakeEl("div", doc);
	const slides = new FakeEl("div", doc);
	reveal.rect = { left: 0, top: 0, width: 1000, height: 800 };
	reveal.clientWidth = 1000;
	reveal.clientHeight = 800;
	slides.rect = { left: 20, top: 25, width: 480, height: 350 };
	slides.clientWidth = 960;
	slides.clientHeight = 700;
	const section = new FakeEl("section", doc);
	section.textContent = "slide 0";
	section.classes.add("present");
	slides.children.push(section);
	(container as unknown as { querySelector: (sel: string) => FakeEl | null }).querySelector = (sel) =>
		sel === ".reveal" ? reveal : null;
	(reveal as unknown as { querySelector: (sel: string) => FakeEl | null }).querySelector = (sel) =>
		sel === ".slides" ? slides : null;
	(container as unknown as { isConnected: boolean }).isConnected = true;
	return { container, reveal, slides };
}

function makeHost(documents?: () => Document[], onDocumentChange?: (cb: () => void) => () => void): SlidesInkHost {
	return {
		...(documents ? { documents } : {}),
		...(onDocumentChange ? { onDocumentChange } : {}),
		activeFilePath: () => "Deck.md",
		readSource: async () => "slide 0",
		readPageId: () => "note-1",
		claimId: async (_path, proposedId) => ({ pageId: proposedId }),
		newPageId: () => "note-1",
		loadSidecar: async () => null,
		scheduleSidecar: () => undefined,
		saveSidecarNow: async () => undefined,
		nib: () => ({ tool: "pen", color: "#123456", width: 2 }),
		eraserRadiusPx: () => 12,
		eraseWholeStrokes: () => true,
		notify: () => undefined,
		buildId: "test-build",
	};
}

let evClock = 0;
function ev(type: string, over: Partial<AnyEvent> = {}): AnyEvent {
	return {
		type,
		pointerId: 1,
		pointerType: "pen",
		isPrimary: true,
		buttons: 1,
		button: 0,
		clientX: 200,
		clientY: 200,
		pressure: 0.5,
		timeStamp: (evClock += 20),
		preventDefault: () => undefined,
		stopPropagation: () => undefined,
		...over,
	};
}

function drawOn(reveal: FakeEl): void {
	reveal.dispatch(ev("pointerdown"));
	reveal.dispatch(ev("pointermove", { clientX: 260, clientY: 260 }));
	reveal.dispatch(ev("pointermove", { clientX: 300, clientY: 300 }));
	reveal.dispatch(ev("pointerup"));
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
function setActive(doc: FakeDoc): void {
	(globalThis as { activeDocument?: unknown }).activeDocument = doc;
}
function setMainDocument(doc: FakeDoc): void {
	(globalThis as { document?: unknown }).document = doc;
}

describe("R5-Slides-c-1: a presentation opened in a popout window gets ink", () => {
	beforeEach(() => {
		observations.length = 0;
		(globalThis as { MutationObserver?: unknown }).MutationObserver = FakeMutationObserver;
	});
	afterEach(() => {
		setSlidesInk(false);
		delete (globalThis as { activeDocument?: unknown }).activeDocument;
		delete (globalThis as { document?: unknown }).document;
		delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
	});

	it("CONTROL: main window presentation mounts through the body observer (fakes are sound)", async () => {
		const main = makeWin();
		setMainDocument(main.doc);
		setActive(main.doc); // plugin load: the main window is the active document
		setSlidesInk(true, makeHost());
		expect(watchersOf(main.body)).toHaveLength(1);
		expect(activeSlidesActions(main.doc as unknown as Document)).toBeNull();

		const deck = main.openPresentation();
		await tick();
		const actions = activeSlidesActions(main.doc as unknown as Document);
		expect(actions).not.toBeNull();
		drawOn(deck.reveal);
		expect(actions!.status().totalCount).toBe(1);
	});

	it("main body mutation does not hide a new popout deck", async () => {
		const main = makeWin();
		const popout = makeWin();
		setMainDocument(main.doc);
		setActive(main.doc);
		setSlidesInk(true, makeHost(() => [main.doc, popout.doc] as unknown as Document[]));
		setActive(popout.doc); // user works in the popout
		main.otherBodyChild(); // gm(): document.body.appendChild(reveal.js script) in the main window
		const deck = popout.openPresentation();
		await tick();
		const actions = activeSlidesActions(popout.doc as unknown as Document);
		expect(actions).not.toBeNull();
		drawOn(deck.reveal);
		expect(actions!.status().totalCount).toBe(1);
	});

	it("popout presentation (not the session's first) mounts a live, drawable deck", async () => {
		const main = makeWin();
		const popout = makeWin();
		setMainDocument(main.doc);
		setActive(main.doc); // plugin load: main.ts:3612 -> startSlidesInk -> setSlidesInk(true)
		setSlidesInk(true, makeHost(() => [main.doc, popout.doc] as unknown as Document[]));

		// Both workspace documents have a direct-child mount watcher.
		expect(watchersOf(main.body)).toHaveLength(1);
		expect(watchersOf(popout.body)).toHaveLength(1);

		// User focuses the popout and runs "Start presentation" there:
		// activeDocument.body.createDiv("slides-container") lands on the popout body.
		setActive(popout.doc);
		const deck = popout.openPresentation();
		await tick();

		// Correct behaviour: the deck is live in the popout and a pen stroke commits.
		const actions = activeSlidesActions(popout.doc as unknown as Document);
		expect(actions, "no SlidesDeck mounted for the popout presentation").not.toBeNull();
		drawOn(deck.reveal);
		expect(actions!.status().totalCount).toBe(1);
	});

	it("variant: slides ink toggled on from a popout, then a presentation in the main window mounts", async () => {
		const main = makeWin();
		const popout = makeWin();
		setMainDocument(main.doc);
		setActive(main.doc);
		setSlidesInk(true, makeHost(() => [main.doc, popout.doc] as unknown as Document[])); // on at load
		// "Toggle slides ink" twice from the popout's command palette (main.ts:2526-2531).
		setActive(popout.doc);
		setSlidesInk(false);
		setSlidesInk(true, makeHost(() => [main.doc, popout.doc] as unknown as Document[]));
		expect(watchersOf(popout.body)).toHaveLength(1);
		expect(watchersOf(main.body)).toHaveLength(1);

		// User goes back to the main window and presents there.
		setActive(main.doc);
		const deck = main.openPresentation();
		await tick();

		const actions = activeSlidesActions(main.doc as unknown as Document);
		expect(actions, "no SlidesDeck mounted for the main-window presentation").not.toBeNull();
		drawOn(deck.reveal);
		expect(actions!.status().totalCount).toBe(1);
	});

	it("adds and drops a popout watcher as workspace windows change", async () => {
		const main = makeWin(), popout = makeWin();
		const docs = [main.doc as unknown as Document];
		let changed: () => void = () => {};
		setMainDocument(main.doc);
		setActive(main.doc);
		setSlidesInk(true, makeHost(() => docs, cb => { changed = cb; return () => { changed = () => {}; }; }));
		expect(watchersOf(main.body)).toHaveLength(1);
		expect(watchersOf(popout.body)).toHaveLength(0);
		docs.push(popout.doc as unknown as Document);
		changed();
		expect(watchersOf(popout.body)).toHaveLength(1);
		setActive(popout.doc);
		popout.openPresentation();
		await tick();
		expect(activeSlidesActions(popout.doc as unknown as Document)).not.toBeNull();
		docs.pop();
		changed();
		expect(watchersOf(popout.body)).toHaveLength(0);
		expect(activeSlidesActions(popout.doc as unknown as Document)).toBeNull();
		setSlidesInk(false);
		expect(watchersOf(main.body)).toHaveLength(0);
	});

	it("keeps a main-window deck live while a watched popout has focus", async () => {
		const main = makeWin(), popout = makeWin();
		setMainDocument(main.doc);
		setActive(main.doc);
		setSlidesInk(true, makeHost(() => [main.doc, popout.doc] as unknown as Document[]));
		const shown = main.openPresentation();
		await tick();
		const actions = activeSlidesActions(main.doc as unknown as Document);
		expect(actions).not.toBeNull();
		setActive(popout.doc);
		popout.otherBodyChild();
		await tick();
		expect(activeSlidesActions(main.doc as unknown as Document)).toBe(actions);
		drawOn(shown.reveal);
		expect(actions!.status().totalCount).toBe(1);
	});
});
