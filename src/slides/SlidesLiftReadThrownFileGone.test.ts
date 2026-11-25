/**
 * K675-1 (FOLLOWUPS 87a): a note and its copy carry the same page id, and only the copy is duplicate-locked. The copy's
 * presentation is open and drawn on while locked. The original is deleted, which lifts the copy's lock, and the lift's
 * read of the Slides ink file throws (a sync client mid-write). The sync client then removes the file, and one live
 * reload poll runs. Nothing is left to read, so the deck should do what the no-file rule does for a held first read:
 * lift the hold, give undo, redo and the clears back, and save the ink it holds once.
 *
 * Control: the same steps with the lift's read not throwing.
 *
 * The harness is SlidesClearLockKeepsNewerInk.test.ts's, copied and trimmed: the delete handler, the inline duplicate
 * lock, the production Slides host built by startSlidesInk, SlidesDeck input and persistence, and PageStore are real;
 * FakeAdapter, note metadata from an in-memory text map, and a reduced presentation DOM are synthetic. The poll is the
 * Slides leg of the live reload tick (PluginOnloadReload.ts:514-527), step for step. Not device acceptance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { parseMarkdownPage } from "../model/MarkdownPage";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { SlidesDeck, pageOfSlide, reloadSlidesExternal, sectionHashes, setSlidesInk, slidesReloadCandidate, slidesSidecarId } from "./SlidesInkSurface";
import { setPenToolsMode, resetPenToolsForTest } from "../inline/PenToolsMode";
import { type InkPoint, type InkStroke, computeBBox } from "../ink/Stroke";
import { emptyPage, parsePage, serializePage, type PageData } from "../model/PageData";

// Every notice the production Slides host gives (it calls blockNotice).
const noticeLog = vi.hoisted(() => [] as string[]);
vi.mock("../view/Notices", async (original) => ({
	...(await original<typeof import("../view/Notices")>()),
	blockNotice: (m: string) => void noticeLog.push(m),
}));

const ORIG = "Deck.md";
const COPY = "Deck 1.md";
const SHARED = "shared-deck-id";
const DECK_SOURCE = "slide 0\n\n---\n\nslide 1\n\n---\n\nslide 2";
const sidecarPath = (id: string): string => `.handwriting/${id}.json`;

let createdAt = 1_757_700_000_000;
function stroke(id: string, x0: number, y0: number, page: number): InkStroke {
	const points: InkPoint[] = Array.from({ length: 12 }, (_, i) => ({ x: x0 + i * 1.5, y: y0 + i, pressure: 0.5, t: i * 8 }));
	return { id, tool: "pen", color: "#1e2a3b", width: 2.2, points, bbox: computeBBox(points, 4.4), createdAt: createdAt++, page };
}

function onDisk(adapter: FakeAdapter, id: string): string[] | null {
	const text = adapter.files.get(sidecarPath(id));
	if (text === undefined) return null;
	const parsed = parsePage(text, id);
	expect(parsed.damaged, `sidecar ${id} did not parse`).toBeFalsy();
	return parsed.data.strokes.map((s) => s.id);
}

async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 400; i++) await Promise.resolve();
}

// ---- a minimal presentation DOM (copied from SlidesClearLockKeepsNewerInk.test.ts) ----

interface Rect { left: number; top: number; width: number; height: number }

class FakeEl {
	readonly style: Record<string, string> = { position: "", touchAction: "" };
	readonly children: FakeEl[] = [];
	className = "";
	id = "";
	textContent = "";
	rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
	clientWidth = 0;
	clientHeight = 0;
	isConnected = true;
	isContentEditable = false;
	parentElement: FakeEl | null = null;
	readonly classes = new Set<string>();
	readonly listeners: Array<{ type: string; fn: (ev: unknown) => void }> = [];
	readonly attributes = new Map<string, string>();
	readonly classList = {
		add: (c: string) => void this.classes.add(c),
		remove: (c: string) => void this.classes.delete(c),
		contains: (c: string) => this.classes.has(c),
		toggle: (c: string, on?: boolean) => {
			const want = on ?? !this.classes.has(c);
			if (want) this.classes.add(c);
			else this.classes.delete(c);
			return want;
		},
	};
	tabIndex = -1;
	width = 0;
	height = 0;
	constructor(readonly tagName: string, readonly ownerDocument: FakeDoc) {}
	createEl(tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}): FakeEl {
		const child = this.ownerDocument.createElement(tag);
		if (options.text) child.textContent = options.text;
		if (options.cls) for (const cls of options.cls.split(" ")) child.classes.add(cls);
		for (const [name, value] of Object.entries(options.attr ?? {})) child.setAttribute(name, value);
		this.appendChild(child);
		return child;
	}
	createDiv(options: { text?: string; cls?: string; attr?: Record<string, string> } = {}): FakeEl {
		return this.createEl("div", options);
	}
	setText(text: string): void { this.textContent = text; }
	hasAttribute(name: string): boolean { return this.attributes.has(name); }
	getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	removeAttribute(name: string): void { this.attributes.delete(name); }
	setCssStyles(styles: Record<string, string>): void { Object.assign(this.style, styles); }
	addEventListener(type: string, fn: (ev: unknown) => void): void { this.listeners.push({ type, fn }); }
	removeEventListener(type: string, fn: (ev: unknown) => void): void {
		const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn);
		if (i >= 0) this.listeners.splice(i, 1);
	}
	getBoundingClientRect(): Rect { return this.rect; }
	appendChild(child: FakeEl): void {
		if (child.parentElement) child.remove();
		this.children.push(child);
		child.parentElement = this;
	}
	remove(): void {
		const p = this.parentElement;
		if (p) {
			const i = p.children.indexOf(this);
			if (i >= 0) p.children.splice(i, 1);
		}
		this.parentElement = null;
	}
	contains(other: unknown): boolean { return other === this; }
	querySelector(): FakeEl | null { return null; }
	focus(): void { if (this.attributes.has("tabindex")) this.ownerDocument.activeElement = this; }
	blur(): void { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
	setPointerCapture(): void {}
	releasePointerCapture(): void {}
	getContext(): CanvasRenderingContext2D {
		return new Proxy({}, {
			get: (_t, prop) => (prop === "getContextAttributes" ? () => ({ desynchronized: false }) : () => undefined),
			set: () => true,
		}) as unknown as CanvasRenderingContext2D;
	}
	dispatch(ev: Record<string, unknown>): void {
		for (const l of this.listeners.slice()) if (l.type === ev.type) l.fn(ev);
	}
}

class FakeWin {
	devicePixelRatio = 1;
	navigator = undefined;
	setTimeout(): number { return 0; }
	clearTimeout(): void {}
	requestAnimationFrame(): number { return 0; }
	cancelAnimationFrame(): void {}
	getComputedStyle(): { position: string; backgroundColor: unknown } { return { position: "static", backgroundColor: undefined }; }
	matchMedia(query: string): MediaQueryList {
		return { media: query, matches: true, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as MediaQueryList;
	}
	addEventListener(): void {}
	removeEventListener(): void {}
	readonly MutationObserver = class { observe(): void {} disconnect(): void {} };
}

class FakeDoc {
	activeElement: unknown = null;
	head = undefined;
	defaultView = new FakeWin();
	container: FakeEl | null = null;
	readonly body = {
		classList: { add: () => undefined, remove: () => undefined, contains: () => false },
		querySelector: (sel: string) => (sel === ":scope > .slides-container" ? this.container : null),
	};
	createElement(tag: string): FakeEl { return new FakeEl(tag, this); }
}

let clock = 0;
function presentation(sections = 3, doc = new FakeDoc()) {
	const container = new FakeEl("div", doc);
	const reveal = new FakeEl("div", doc);
	const slides = new FakeEl("div", doc);
	reveal.rect = { left: 0, top: 0, width: 1000, height: 800 };
	reveal.clientWidth = 1000;
	reveal.clientHeight = 800;
	slides.rect = { left: 20, top: 25, width: 480, height: 350 };
	slides.clientWidth = 960;
	slides.clientHeight = 700;
	for (let i = 0; i < sections; i++) {
		const s = new FakeEl("section", doc);
		s.textContent = `slide ${i}`;
		if (i === 0) s.classes.add("present");
		slides.children.push(s);
	}
	container.querySelector = ((sel: string) => (sel === ".reveal" ? reveal : null)) as never;
	reveal.querySelector = ((sel: string) => (sel === ".slides" ? slides : null)) as never;
	doc.container = container;
	const ev = (type: string, x: number, y: number, pressure: number, buttons = 1) => ({
		type, pointerId: 7, pointerType: "pen", isPrimary: true, buttons, button: 0,
		clientX: x, clientY: y, pressure, timeStamp: (clock += 16),
		preventDefault: () => undefined, stopPropagation: () => undefined,
	});
	return {
		doc,
		draw(x0: number, y0: number) {
			const pts = Array.from({ length: 12 }, (_, i) => [x0 - i * 4, y0 - i * 3 + (i % 2) * 2, 0.2 + i * 0.05] as const);
			reveal.dispatch(ev("pointerdown", pts[0]![0], pts[0]![1], pts[0]![2]));
			for (const [x, y, p] of pts.slice(1)) reveal.dispatch(ev("pointermove", x, y, p));
			const last = pts[pts.length - 1]!;
			reveal.dispatch(ev("pointerup", last[0], last[1], 0, 0));
		},
	};
}

function deckModel(deck: SlidesDeck): InkStroke[] {
	return [...(deck as unknown as { strokes: Map<number, InkStroke[]> }).strokes.values()].flat();
}

/** The deck's write hold: true while a read it could not finish holds its writes. */
function writesHeld(deck: SlidesDeck): boolean {
	return (deck as unknown as { reloadDamaged: boolean }).reloadDamaged;
}

function liveDeck(): SlidesDeck {
	let found: SlidesDeck | null = null;
	const spy = vi.spyOn(SlidesDeck.prototype, "reloadCandidateSidecarId").mockImplementation(function (this: SlidesDeck) {
		found = this;
		return null;
	});
	slidesReloadCandidate();
	spy.mockRestore();
	if (!found) throw new Error("no live deck mounted: startSlidesInk found no presentation");
	return found;
}

// ---- a vault with two notes and the real plugin methods (copied from SlidesClearLockKeepsNewerInk.test.ts) ----

type Plugin = {
	startSlidesInk(): void;
	onFileDeleted(file: TFile): Promise<void>;
	slidesWriter: string | null;
};

function vault(ids: Record<string, string>) {
	const adapter = new FakeAdapter();
	adapter.dirs.add(".handwriting");
	const store = new PageStore({ vault: { adapter } } as never);
	const texts = new Map<string, string>(Object.entries(ids).map(([p, id]) => [p, `---\nhandwriting-page-id: ${id}\n---\n${DECK_SOURCE}\n`]));
	const idOf = (p: string): string | undefined => {
		const t = texts.get(p);
		return t === undefined ? undefined : (parseMarkdownPage(t).pageId ?? undefined);
	};
	const cache = (p: string) => {
		if (!texts.has(p)) return null;
		const id = idOf(p);
		return { frontmatter: id ? { "handwriting-page-id": id } : {}, sections: [{ type: "yaml" }, { type: "paragraph" }] };
	};
	// Obsidian's delete event fires while the metadata cache still holds the deleted note's frontmatter; the vault
	// listing no longer has the file. A path in `unlisted` is that note: gone from the vault, still in the cache.
	const unlisted = new Set<string>();
	const file = (p: string) => (texts.has(p) && !unlisted.has(p) ? { path: p, extension: "md", basename: p.slice(0, -3) } : null);
	let activeFile: string | null = null;
	noticeLog.length = 0;
	const plugin = Object.create(HandwritingPlugin.prototype) as Plugin;
	Object.assign(plugin, {
		store,
		pdfStore: { settle: async () => true, parkedInk: () => false },
		settings: { paperStyle: "lined", cameras: {}, pageOwners: {} },
		settingsDirty: false, settingsTimer: null, settingsWriting: null, settingsWriteAgain: false,
		saveData: async () => {}, flushSettings: async () => {}, persistOwners: () => {},
		manifest: { version: "slides-lift-file-gone-test" },
		pageIdWatchReady: true,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		declaimTimers: new Map<string, number>(),
		declaimedPaths: new Set<string>(),
		resolvingDuplicates: new Set<unknown>(),
		app: {
			vault: {
				adapter,
				getFileByPath: (p: string) => file(p),
				getAbstractFileByPath: (p: string) => file(p),
				getMarkdownFiles: () => [...texts.keys()].filter((p) => !unlisted.has(p)).map((p) => file(p)!),
				getFiles: () => [...texts.keys()].filter((p) => !unlisted.has(p)).map((p) => file(p)!),
				cachedRead: async () => DECK_SOURCE,
			},
			metadataCache: {
				getCache: (p: string) => cache(p),
				getFileCache: (f: { path: string }) => cache(f.path),
			},
			workspace: { getActiveFile: () => (activeFile ? file(activeFile) : null), iterateAllLeaves: () => {} },
		},
	});
	const inlineHost = {
		readPageId: (p: string) => idOf(p) ?? null,
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: (id: string) => store.load(id),
		scheduleSidecar: (id: string, page: never) => store.schedule(id, page),
		scheduleSidecarNow: (id: string, page: never) => store.saveNow(id, page),
		notify: () => undefined,
	} as unknown as InlineInkHost;
	inlineInk.attachHost(inlineHost);
	vi.spyOn(console, "info").mockImplementation(() => undefined);
	/** A Slides page for `id` holding `strokes`, in the shape a deck writes. */
	const slidesPage = (id: string, strokes: InkStroke[]): PageData => {
		const sid = slidesSidecarId(id);
		return {
			...emptyPage(sid), surface: "slides", coordSpace: "slide-logical", deck: { width: 960, height: 700 },
			slides: sectionHashes(DECK_SOURCE).map((hash, index) => ({ index, hash })),
			strokes,
		} as PageData;
	};
	return {
		adapter, store, texts, unlisted, plugin, slidesPage,
		/** Present `note` through the production host and return the live deck. */
		async present(note: string) {
			const show = presentation(3);
			vi.stubGlobal("document", show.doc);
			activeFile = note;
			plugin.startSlidesInk();
			const deck = liveDeck();
			await drainMicrotasks();
			return { deck, show };
		},
	};
}

type Vault = ReturnType<typeof vault>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
	setPenToolsMode("hide");
});
afterEach(async () => {
	setSlidesInk(false);
	await drainMicrotasks();
	for (const p of [ORIG, COPY]) inlineInk.handleDelete(p);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	resetPenToolsForTest();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

// ---- the steps (helpers as in SlidesClearLockKeepsNewerInk.test.ts) ----

/** The copy alone is locked, its presentation is opened and drawn on once; nothing reaches the file while locked. */
async function drawnWhileLocked(v: Vault, sid: string, loaded: string[]) {
	inlineInk.markDuplicateLocked(COPY, ORIG);
	expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
	const before = v.adapter.files.get(sidecarPath(sid));
	const { deck, show } = await v.present(COPY);
	expect(deckModel(deck).map((s) => s.id), "precondition: the copy's deck loaded what the Slides ink file held").toEqual(loaded);
	show.draw(300, 300);
	const held = deckModel(deck).find((s) => !loaded.includes(s.id));
	expect(held, "precondition: the stroke drawn on the copy's deck").toBeDefined();
	for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
	expect(v.adapter.files.get(sidecarPath(sid)), "precondition: nothing written while locked").toBe(before);
	expect(deck.status().mutable, "precondition: undo, redo and the clears work on the locked copy's deck").toBe(true);
	return { deck, show, held: held! };
}

/** From here on, the stroke ids of every page the open deck hands the store for its Slides ink file, in order. */
function slidesSaves(v: Vault, sid: string): () => string[][] {
	const asked: string[][] = [];
	const note = (id: string, page: PageData): void => {
		if (id === sid) asked.push(page.strokes.map((s) => s.id));
	};
	const schedule = v.store.schedule.bind(v.store);
	const saveNow = v.store.saveNow.bind(v.store);
	vi.spyOn(v.store, "schedule").mockImplementation((id, page, ...rest) => {
		note(id, page);
		return schedule(id, page, ...rest);
	});
	vi.spyOn(v.store, "saveNow").mockImplementation((id, page, ...rest) => {
		note(id, page);
		return saveNow(id, page, ...rest);
	});
	return () => asked;
}

/**
 * Reads of the Slides ink file from here on: each throws while `on` is true (a sync client mid-write), else passes.
 * `count` is every read of that file, `thrown` the ones that threw.
 */
function sidecarReads(v: Vault, sid: string, on: boolean): { on: boolean; count: number; thrown: number } {
	const state = { on, count: 0, thrown: 0 };
	const read = v.adapter.read.bind(v.adapter);
	vi.spyOn(v.adapter, "read").mockImplementation(async (p: string) => {
		if (p !== sidecarPath(sid)) return read(p);
		state.count++;
		if (state.on) {
			state.thrown++;
			throw new Error("EBUSY injected");
		}
		return read(p);
	});
	return state;
}

/** The original is deleted through the plugin's delete handler, which clears the copy's lock; then the deck settles. */
async function deleteOriginal(v: Vault): Promise<void> {
	v.unlisted.add(ORIG);
	await v.plugin.onFileDeleted(Object.assign(new TFile(), { path: ORIG, extension: "md", basename: "Deck" }));
	v.texts.delete(ORIG);
	inlineInk.handleDelete(ORIG);
	expect(inlineInk.isDuplicateLocked(COPY), "precondition: the lock cleared").toBe(false);
	for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
	await v.store.flush();
	await drainMicrotasks();
}

/** One live reload tick's Slides leg, as PluginOnloadReload.ts:514-527 runs it; then the store writes. */
async function pollTick(v: Vault): Promise<{ asked: string | null; changed: boolean; reloaded: boolean }> {
	let changed = false;
	let reloaded = false;
	const asked = slidesReloadCandidate();
	if (asked && (await v.store.externallyChanged(asked))) {
		changed = true;
		if (slidesReloadCandidate() === asked && !v.store.hasQueuedWrite(asked)) reloaded = await reloadSlidesExternal(asked);
	}
	for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
	await v.store.flush();
	await drainMicrotasks();
	return { asked, changed, reloaded };
}

/**
 * The copy's deck draws one stroke while locked; the original is deleted and the lock lifts, the lift's read throwing
 * or not (`liftThrows`); the sync client then removes the Slides ink file, and one poll runs.
 */
async function liftThenFileGone(liftThrows: boolean) {
	const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
	const sid = slidesSidecarId(SHARED);
	v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [stroke("orig-saved", 100, 100, pageOfSlide(0))])));
	const { deck, held } = await drawnWhileLocked(v, sid, ["orig-saved"]);
	const saves = slidesSaves(v, sid);
	const reads = sidecarReads(v, sid, liftThrows);

	await deleteOriginal(v);
	expect(reads.count, "precondition: the lift read the Slides ink file").toBeGreaterThan(0);
	expect(reads.thrown > 0, "precondition: the lift's read threw, or did not, as staged").toBe(liftThrows);
	if (liftThrows) {
		expect(writesHeld(deck), "precondition: the lift's thrown read holds the deck's writes").toBe(true);
		expect(deck.status().mutable, "precondition: the held deck's undo, redo and clears are off").toBe(false);
		expect(saves(), "precondition: nothing saved at the lift's thrown read").toEqual([]);
	}

	// The sync client finishes by removing the file: nothing is left to read.
	reads.on = false;
	await v.adapter.remove(sidecarPath(sid));
	expect(v.adapter.files.has(sidecarPath(sid)), "precondition: the Slides ink file is gone").toBe(false);

	const poll = await pollTick(v);
	expect(poll.asked, "precondition: the deck takes the poll").toBe(sid);
	return { v, sid, deck, held, saves, poll };
}

describe("a lift whose read threw, then the Slides ink file removed: one poll lifts the hold and saves the deck once", () => {
	it("the lift's read throws, the file goes, one poll: the hold lifted, undo and the clears back, one save holding the deck's strokes", async () => {
		const { v, sid, deck, held, saves, poll } = await liftThenFileGone(true);
		const seen = `poll asked ${poll.asked}, changed ${poll.changed}, reloaded ${poll.reloaded}`;

		expect.soft(writesHeld(deck), `the deck's writes are still held after the file went (${seen})`).toBe(false);
		expect.soft(deck.status().mutable, `undo, redo and the clears are still off after the file went (${seen})`).toBe(true);
		expect.soft(saves(), `not one save holding the deck's strokes (${seen})`).toEqual([["orig-saved", held.id]]);
		expect.soft(onDisk(v.adapter, sid), `the deck's strokes are in no file (${seen})`).toEqual(["orig-saved", held.id]);
	});

	it("control: the lift's read lands, the file goes, one poll: no hold, undo and the clears on, one save (the lift's) holding the deck's strokes", async () => {
		const { deck, held, saves, poll } = await liftThenFileGone(false);
		const seen = `poll asked ${poll.asked}, changed ${poll.changed}, reloaded ${poll.reloaded}`;

		expect.soft(writesHeld(deck), `the deck's writes are held (${seen})`).toBe(false);
		expect.soft(deck.status().mutable, `undo, redo and the clears are off (${seen})`).toBe(true);
		expect.soft(saves(), `not one save holding the deck's strokes (${seen})`).toEqual([["orig-saved", held.id]]);
	});
});

// ---- FOLLOWUPS 87 and checks K2, K4-K7 ----

// The production words, copied (SlidesPersistence.ts TRANSIENT_NOTICE and TRANSIENT_GONE).
const COULD_NOT_READ_YET = "Handwriting: this presentation's ink file could not be read yet. New ink on it is not saved until it loads.";
const FILE_GONE = "Handwriting: this presentation's ink file is gone. The presentation starts fresh, and saving is back on.";

/** The deck's dirty flag: true while it holds ink a save has not been handed. */
function dirtyOf(deck: SlidesDeck): boolean {
	return (deck as unknown as { dirty: boolean }).dirty;
}

/** The ids the deck holds that were not in `known`, in model order. */
function drawnIds(deck: SlidesDeck, known: string[]): string[] {
	return deckModel(deck).map((s) => s.id).filter((id) => !known.includes(id));
}

/**
 * K1's steps up to the lift's thrown read: the copy alone locked, its presentation opened, one stroke drawn while
 * locked or none (`draw`), the original deleted, the lift's read throwing. Notices are counted from the lift.
 */
async function liftReadThrown(draw: boolean) {
	const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
	const sid = slidesSidecarId(SHARED);
	v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [stroke("orig-saved", 100, 100, pageOfSlide(0))])));
	inlineInk.markDuplicateLocked(COPY, ORIG);
	expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
	const before = v.adapter.files.get(sidecarPath(sid));
	const { deck, show } = await v.present(COPY);
	expect(deckModel(deck).map((s) => s.id), "precondition: the copy's deck loaded what the Slides ink file held").toEqual(["orig-saved"]);
	if (draw) show.draw(300, 300);
	const held = drawnIds(deck, ["orig-saved"]);
	expect(held, "precondition: one stroke drawn while locked, or none, as staged").toHaveLength(draw ? 1 : 0);
	for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
	expect(v.adapter.files.get(sidecarPath(sid)), "precondition: nothing written while locked").toBe(before);
	const mark = noticeLog.length;
	const saves = slidesSaves(v, sid);
	const reads = sidecarReads(v, sid, true);
	await deleteOriginal(v);
	expect(reads.thrown, "precondition: the lift's read threw").toBeGreaterThan(0);
	expect(writesHeld(deck), "precondition: the lift's thrown read holds the deck's writes").toBe(true);
	expect(deck.status().mutable, "precondition: the held deck's undo, redo and clears are off").toBe(false);
	expect(saves(), "precondition: nothing saved at the lift's thrown read").toEqual([]);
	return { v, sid, deck, show, held, saves, reads, notices: () => noticeLog.slice(mark) };
}

/** The sync client finishes by removing the Slides ink file; reads pass from here on. */
async function fileGone(v: Vault, sid: string, reads: { on: boolean }): Promise<void> {
	reads.on = false;
	await v.adapter.remove(sidecarPath(sid));
	expect(v.adapter.files.has(sidecarPath(sid)), "precondition: the Slides ink file is gone").toBe(false);
}

/**
 * Reads of the Slides ink file from here on: while `on`, the first `pass` reads go through and every later one throws
 * (a sync client mid-write). The poll's own change check reads the file before the reload reads it.
 */
function sidecarReadsAfter(v: Vault, sid: string): { on: boolean; pass: number; count: number; thrown: number } {
	const state = { on: false, pass: 0, count: 0, thrown: 0 };
	const read = v.adapter.read.bind(v.adapter);
	vi.spyOn(v.adapter, "read").mockImplementation(async (p: string) => {
		if (p !== sidecarPath(sid)) return read(p);
		state.count++;
		if (state.on) {
			if (state.pass > 0) state.pass--;
			else {
				state.thrown++;
				throw new Error("EBUSY injected");
			}
		}
		return read(p);
	});
	return state;
}

describe("a deck held by a thrown live reload, then its Slides ink file removed: one poll lifts the hold", () => {
	it("K2: never locked, a poll's read throws, a stroke drawn while held, the file goes, a poll 10 s later: the hold lifted, undo and the clears back, one save, no word; a later stroke saves again", async () => {
		const v = vault({ [ORIG]: SHARED });
		const sid = slidesSidecarId(SHARED);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [stroke("orig-saved", 100, 100, pageOfSlide(0))])));
		const { deck, show } = await v.present(ORIG);
		expect(deckModel(deck).map((s) => s.id), "precondition: the deck loaded what the Slides ink file held").toEqual(["orig-saved"]);
		expect(deck.status().mutable, "precondition: the loaded deck's undo, redo and clears work").toBe(true);
		const mark = noticeLog.length;
		const notices = () => noticeLog.slice(mark);
		const saves = slidesSaves(v, sid);
		const reads = sidecarReadsAfter(v, sid);

		// Another device writes the file; the poll's change check reads it, and the reload's read throws.
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [
			stroke("orig-saved", 100, 100, pageOfSlide(0)), stroke("other-device", 200, 120, pageOfSlide(0)),
		])));
		reads.on = true;
		reads.pass = 1;
		const first = await pollTick(v);
		expect(first, "precondition: the first poll saw the change and reloaded").toMatchObject({ asked: sid, changed: true });
		expect(reads.thrown, "precondition: the reload's read threw").toBeGreaterThan(0);
		expect(writesHeld(deck), "precondition: the thrown reload holds the deck's writes").toBe(true);
		expect(deck.status().mutable, "precondition: the held deck's undo, redo and clears are off").toBe(false);
		expect(notices(), "precondition: a thrown reload says nothing").toEqual([]);

		show.draw(300, 300);
		const [held] = drawnIds(deck, ["orig-saved"]);
		expect(held, "precondition: the stroke drawn while held").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(saves(), "precondition: nothing saved while held").toEqual([]);
		expect(notices(), "precondition: a stroke on a deck held by a thrown reload is not told").toEqual([]);

		await fileGone(v, sid, reads);
		const poll = await pollTick(v);
		const seen = `poll asked ${poll.asked}, changed ${poll.changed}, reloaded ${poll.reloaded}`;
		expect(poll, "precondition: the deck takes the poll and the change check answers changed").toMatchObject({ asked: sid, changed: true });

		expect.soft(writesHeld(deck), `the deck's writes are still held after the file went (${seen})`).toBe(false);
		expect.soft(deck.status().mutable, `undo, redo and the clears are still off after the file went (${seen})`).toBe(true);
		expect.soft(saves(), `not one save holding the deck's strokes (${seen})`).toEqual([["orig-saved", held]]);
		expect.soft(onDisk(v.adapter, sid), `the deck's strokes are in no file (${seen})`).toEqual(["orig-saved", held]);
		expect.soft(notices(), `a reader never told of the hold heard a word (${seen})`).toEqual([]);

		show.draw(500, 300);
		const later = drawnIds(deck, ["orig-saved", held!])[0];
		expect(later, "precondition: the stroke drawn after the heal").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		expect.soft(saves(), `a stroke after the heal did not save once more (${seen})`).toEqual([["orig-saved", held], ["orig-saved", held, later]]);
		expect.soft(onDisk(v.adapter, sid), `the stroke after the heal is in no file (${seen})`).toEqual(["orig-saved", held, later]);
		expect.soft(notices(), `a stroke after the heal was told something (${seen})`).toEqual([]);
	});
});

describe("K4-K7: the lift's thrown read, then the file removed", () => {
	it("K4: nothing drawn while locked, the file goes, one poll: the hold lifted, undo and the clears back, nothing saved, the file stays gone, no word", async () => {
		const { v, sid, deck, saves, reads, notices } = await liftReadThrown(false);
		expect(dirtyOf(deck), "precondition: the clean deck is not dirty (no stroke, no remap save)").toBe(false);
		await fileGone(v, sid, reads);
		const poll = await pollTick(v);
		const seen = `poll asked ${poll.asked}, changed ${poll.changed}, reloaded ${poll.reloaded}`;
		expect(poll.asked, "precondition: the deck takes the poll").toBe(sid);

		expect.soft(writesHeld(deck), `the deck's writes are still held after the file went (${seen})`).toBe(false);
		expect.soft(deck.status().mutable, `undo, redo and the clears are still off after the file went (${seen})`).toBe(true);
		expect.soft(saves(), `a clean deck handed the store a save (${seen})`).toEqual([]);
		expect.soft(onDisk(v.adapter, sid), `a clean deck wrote a file (${seen})`).toBeNull();
		expect.soft(notices(), `a clean deck's reader heard a word (${seen})`).toEqual([]);
	});

	it("K5: a stroke drawn while locked and one drawn after the lift's throw, the file goes, one poll: exactly one save holding all three", async () => {
		const { v, sid, deck, show, held, saves, reads } = await liftReadThrown(true);
		show.draw(500, 300);
		const later = drawnIds(deck, ["orig-saved", ...held])[0];
		expect(later, "precondition: the stroke drawn after the lift's throw").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(saves(), "precondition: nothing saved while held").toEqual([]);
		await fileGone(v, sid, reads);
		const poll = await pollTick(v);
		const seen = `poll asked ${poll.asked}, changed ${poll.changed}, reloaded ${poll.reloaded}`;
		expect(poll.asked, "precondition: the deck takes the poll").toBe(sid);

		expect.soft(saves(), `not exactly one save holding the deck's strokes (${seen})`).toEqual([["orig-saved", ...held, later]]);
		expect.soft(onDisk(v.adapter, sid), `the deck's strokes are in no file (${seen})`).toEqual(["orig-saved", ...held, later]);
	});

	it("K6: the file goes and the presentation closes before any poll: the close's read finds no file, the drain writes once, the lift's word only", async () => {
		const { v, sid, deck, held, saves, reads, notices } = await liftReadThrown(true);
		await fileGone(v, sid, reads);
		// A missing file is looked for, not read: count the store's loads of the Slides ink file at the close.
		let closeLoads = 0;
		const load = v.store.load.bind(v.store);
		vi.spyOn(v.store, "load").mockImplementation((id, ...rest) => {
			if (id === sid) closeLoads++;
			return load(id, ...rest);
		});
		await closeDeck(v, deck);
		expect(closeLoads, "precondition: the close read the file once more").toBe(1);

		expect.soft(saves(), "the close did not write the deck's strokes once").toEqual([["orig-saved", ...held]]);
		expect.soft(onDisk(v.adapter, sid), "the deck's strokes are in no file").toEqual(["orig-saved", ...held]);
		expect.soft(notices(), "the notices from the lift to the close").toEqual([COULD_NOT_READ_YET]);
	});

	it("K7: a reader told at the lift's throw hears once that the file is gone and saving is back, at the poll that heals", async () => {
		const { v, sid, reads, notices } = await liftReadThrown(true);
		expect(notices(), "precondition: the reader was told at the lift's throw").toEqual([COULD_NOT_READ_YET]);
		await fileGone(v, sid, reads);
		const poll = await pollTick(v);
		const seen = `poll asked ${poll.asked}, changed ${poll.changed}, reloaded ${poll.reloaded}`;
		expect(poll.asked, "precondition: the deck takes the poll").toBe(sid);
		expect.soft(notices(), `the told reader did not hear once that saving is back (${seen})`).toEqual([COULD_NOT_READ_YET, FILE_GONE]);
		await pollTick(v);
		expect.soft(notices(), "a later poll repeated a word").toEqual([COULD_NOT_READ_YET, FILE_GONE]);
	});
});

/** The presentation is closed; teardown and anything it waits on settle, and the store writes (SlidesClearLockKeepsNewerInk.test.ts). */
async function closeDeck(v: Vault, deck: SlidesDeck): Promise<void> {
	deck.dispose();
	await Promise.all(deck.inFlightWork());
	for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
	await v.store.flush();
	await drainMicrotasks();
}
