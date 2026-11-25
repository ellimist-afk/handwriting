/**
 * A note and its copy carry the same page id, and only the copy is duplicate-locked (a repair that failed). The
 * copy's presentation is open and drawn on while locked, so its deck holds the Slides ink it loaded plus that stroke.
 * The original's presentation then saves newer Slides ink under the shared id, through the same store and writer, as a
 * second deck of this session does. When the original is deleted, the delete handler clears the copy's lock and tells
 * the open deck. The deck must not save the page it loaded over that newer ink: the Slides file afterwards holds
 * every stroke it held at the clear, with the copy's own stroke on top, and the open deck shows them.
 *
 * Real pieces and synthetic pieces are those of SlidesHeldInk.test.ts, whose harness this file copies (trimmed): the
 * delete handler, the inline duplicate lock, the production Slides host built by startSlidesInk, SlidesDeck input and
 * persistence, and PageStore are real; FakeAdapter, note metadata from an in-memory text map, and a reduced
 * presentation DOM are synthetic. Not device acceptance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import HandwritingPlugin from "../main";
import { getEraserRadiusPx, inlineInk, setEraserRadiusPx, setEraserWholeStrokes } from "../inline/InkOverlay";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { parseMarkdownPage } from "../model/MarkdownPage";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { SlidesDeck, pageOfSlide, reloadSlidesExternal, scanForSlides, sectionHashes, setSlidesInk, slidesReloadCandidate, slidesSidecarId } from "./SlidesInkSurface";
import { splitStrokeByCircle } from "../ink/Eraser";
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

// ---- a minimal presentation DOM (copied from SlidesHeldInk.test.ts) ----

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

// ---- a vault with two notes and the real plugin methods (trimmed from SlidesHeldInk.test.ts) ----

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
		manifest: { version: "slides-clear-lock-test" },
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

describe("a duplicate lock cleared on a copy with its presentation open never saves the deck's old page over newer Slides ink", () => {
	it("the original's Slides stroke saved after the copy's deck loaded is still in the file after the original is deleted", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const seeded = v.slidesPage(SHARED, [stroke("orig-saved", 100, 100, pageOfSlide(0))]);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(seeded));
		// The copy alone is locked, as a repair that failed leaves it; the original stays writable.
		inlineInk.markDuplicateLocked(COPY, ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
		expect(inlineInk.isDuplicateLocked(ORIG), "precondition: the original is writable").toBe(false);

		const { deck, show } = await v.present(COPY);
		expect(deckModel(deck).map((s) => s.id), "precondition: the copy's deck loaded the shared Slides ink").toEqual(["orig-saved"]);
		show.draw(300, 300);
		const held = deckModel(deck).find((s) => s.id !== "orig-saved");
		expect(held, "precondition: the stroke drawn on the copy's deck").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(onDisk(v.adapter, sid), "precondition: nothing written while locked").toEqual(["orig-saved"]);

		// The original's presentation saves newer Slides ink through the same store and writer.
		expect(v.plugin.slidesWriter, "precondition: the Slides writer").toBeTruthy();
		await v.store.saveNow(sid, v.slidesPage(SHARED, [stroke("orig-saved", 100, 100, pageOfSlide(0)), stroke("orig-later", 200, 200, pageOfSlide(0))]), v.plugin.slidesWriter!);
		expect(onDisk(v.adapter, sid), "precondition: the original's later stroke reached the file").toEqual(["orig-saved", "orig-later"]);

		// The original is deleted through the plugin's delete handler: the copy survives and owns the id. The handler
		// runs while the cache still holds the original's frontmatter, then the cache drops it.
		v.unlisted.add(ORIG);
		await v.plugin.onFileDeleted(Object.assign(new TFile(), { path: ORIG, extension: "md", basename: "Deck" }));
		v.texts.delete(ORIG);
		inlineInk.handleDelete(ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the lock cleared").toBe(false);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();

		expect(onDisk(v.adapter, sid)?.sort(), "the copy's deck saved its old page over the original's later stroke").toEqual(["orig-later", "orig-saved", held!.id].sort());
		expect(deckModel(deck).map((s) => s.id).sort(), "the open deck does not show the file's page").toEqual(["orig-later", "orig-saved", held!.id].sort());
		expect(onDisk(v.adapter, sid), "the stroke drawn on the copy is no longer on top").toEqual(["orig-saved", "orig-later", held!.id]);
		expect(deckModel(deck).map((s) => s.id), "the open deck no longer draws the copy's stroke on top").toEqual(["orig-saved", "orig-later", held!.id]);
	});

	it("a Slides stroke the original erased and saved while the copy was locked does not come back", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [stroke("orig-saved", 100, 100, pageOfSlide(0)), stroke("orig-gone", 150, 150, pageOfSlide(0))])));
		inlineInk.markDuplicateLocked(COPY, ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);

		const { deck, show } = await v.present(COPY);
		expect(deckModel(deck).map((s) => s.id), "precondition: the copy's deck loaded the shared Slides ink").toEqual(["orig-saved", "orig-gone"]);
		show.draw(300, 300);
		const held = deckModel(deck).find((s) => !s.id.startsWith("orig-"));
		expect(held, "precondition: the stroke drawn on the copy's deck").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(onDisk(v.adapter, sid), "precondition: nothing written while locked").toEqual(["orig-saved", "orig-gone"]);

		// The original's presentation erases one stroke and saves.
		await v.store.saveNow(sid, v.slidesPage(SHARED, [stroke("orig-saved", 100, 100, pageOfSlide(0))]), v.plugin.slidesWriter!);
		expect(onDisk(v.adapter, sid), "precondition: the original's erase reached the file").toEqual(["orig-saved"]);

		v.unlisted.add(ORIG);
		await v.plugin.onFileDeleted(Object.assign(new TFile(), { path: ORIG, extension: "md", basename: "Deck" }));
		v.texts.delete(ORIG);
		inlineInk.handleDelete(ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the lock cleared").toBe(false);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();

		expect(onDisk(v.adapter, sid), "the original's erase was undone, or the copy's stroke lost").toEqual(["orig-saved", held!.id]);
		expect(deckModel(deck).map((s) => s.id), "the open deck still shows the erased stroke").toEqual(["orig-saved", held!.id]);
	});
});

type Vault = ReturnType<typeof vault>;

/**
 * The copy alone is locked, its presentation is opened and drawn on once, and the deck holds that stroke in memory:
 * nothing reaches the Slides ink file while locked, and the lock alone leaves undo, redo and the clears on.
 */
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

describe("a duplicate lock cleared on a copy with no Slides ink file saves the deck's ink at the clear", () => {
	it("no Slides ink file was ever made: the stroke drawn on the copy while locked is saved once at the clear, and undo, redo and the clears work again", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		expect(v.adapter.files.has(sidecarPath(sid)), "precondition: no Slides ink file").toBe(false);
		const { deck, held } = await drawnWhileLocked(v, sid, []);
		const saves = slidesSaves(v, sid);

		await deleteOriginal(v);

		expect.soft(saves(), "the clear did not save the stroke drawn on the copy once").toEqual([[held.id]]);
		expect.soft(deck.status().mutable, "undo, redo and the clears stay off on the copy's deck after the clear").toBe(true);
		expect(onDisk(v.adapter, sid), "the stroke drawn on the copy is not in a Slides ink file after the clear").toEqual([held.id]);
	});

	it("the Slides ink file the copy's deck read is gone by the clear: the deck's ink is saved once at the clear, and undo, redo and the clears work again", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [stroke("orig-saved", 100, 100, pageOfSlide(0))])));
		const { deck, held } = await drawnWhileLocked(v, sid, ["orig-saved"]);
		// A sync client takes the file away while the copy is locked.
		v.adapter.files.delete(sidecarPath(sid));
		v.adapter.mtimes.delete(sidecarPath(sid));
		expect(v.adapter.files.has(sidecarPath(sid)), "precondition: the Slides ink file is gone").toBe(false);
		const saves = slidesSaves(v, sid);

		await deleteOriginal(v);

		expect.soft(saves(), "the clear did not save the deck's ink once").toEqual([["orig-saved", held.id]]);
		expect.soft(deck.status().mutable, "undo, redo and the clears stay off on the copy's deck after the clear").toBe(true);
		expect(onDisk(v.adapter, sid), "the deck's ink is not in a Slides ink file after the clear").toEqual(["orig-saved", held.id]);
	});
});

describe("a duplicate lock cleared on a copy whose Slides ink file cannot be read saves nothing and keeps the hold", () => {
	const seed = (v: Vault, sid: string): void =>
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [stroke("orig-saved", 100, 100, pageOfSlide(0))])));

	it("a damaged Slides ink file: nothing is saved at the clear, the file keeps its bytes, and the actions stay held", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const { deck, held } = await drawnWhileLocked(v, sid, ["orig-saved"]);
		v.adapter.externalWrite(sidecarPath(sid), "{\"pageId\": \"shared-deck-id.slides\", \"strokes\": [");
		const bytes = v.adapter.files.get(sidecarPath(sid))!;
		expect(parsePage(bytes, sid).damaged, "precondition: the Slides ink file no longer parses").toBe(true);
		const saves = slidesSaves(v, sid);

		await deleteOriginal(v);

		expect(saves(), "the clear saved over a Slides ink file it could not read").toEqual([]);
		expect(v.adapter.files.get(sidecarPath(sid)), "the damaged Slides ink file was changed").toBe(bytes);
		expect(deck.status().mutable, "the actions came back after a damaged read").toBe(false);
		expect(deckModel(deck).map((s) => s.id), "the deck dropped ink it holds").toEqual(["orig-saved", held.id]);
	});

	it("reading the Slides ink file throws (a sync client mid-write): nothing is saved at the clear and the actions stay held", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const { deck, held } = await drawnWhileLocked(v, sid, ["orig-saved"]);
		const bytes = v.adapter.files.get(sidecarPath(sid))!;
		const read = v.adapter.read.bind(v.adapter);
		vi.spyOn(v.adapter, "read").mockImplementation(async (p: string) => {
			if (p === sidecarPath(sid)) throw new Error("EBUSY injected");
			return read(p);
		});
		await expect(v.adapter.read(sidecarPath(sid)), "precondition: the read throws").rejects.toThrow("EBUSY injected");
		const saves = slidesSaves(v, sid);

		await deleteOriginal(v);

		expect(saves(), "the clear saved over a Slides ink file it could not read").toEqual([]);
		expect(v.adapter.files.get(sidecarPath(sid)), "the Slides ink file was changed").toBe(bytes);
		expect(deck.status().mutable, "the actions came back after a read that threw").toBe(false);
		expect(deckModel(deck).map((s) => s.id), "the deck dropped ink it holds").toEqual(["orig-saved", held.id]);
	});

	it("the store's read of the Slides ink file rejects: nothing is saved at the clear and the actions stay held", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const { deck, held } = await drawnWhileLocked(v, sid, ["orig-saved"]);
		const bytes = v.adapter.files.get(sidecarPath(sid))!;
		const load = v.store.load.bind(v.store);
		vi.spyOn(v.store, "load").mockImplementation(async (id, options) => {
			if (id === sid) throw new Error("load rejected (injected)");
			return load(id, options);
		});
		await expect(v.store.load(sid), "precondition: the store's read rejects").rejects.toThrow("load rejected (injected)");
		const saves = slidesSaves(v, sid);

		await deleteOriginal(v);

		expect(saves(), "the clear saved after a read that rejected").toEqual([]);
		expect(v.adapter.files.get(sidecarPath(sid)), "the Slides ink file was changed").toBe(bytes);
		expect(deck.status().mutable, "the actions came back after a read that rejected").toBe(false);
		expect(deckModel(deck).map((s) => s.id), "the deck dropped ink it holds").toEqual(["orig-saved", held.id]);
	});
});

/** A straight file stroke from (x0, y0) to (x1, y1) on slide 0, in slide units, `n` samples. */
function line(id: string, x0: number, y0: number, x1: number, y1: number, n = 17): InkStroke {
	const points: InkPoint[] = Array.from({ length: n }, (_, i) => ({
		x: x0 + ((x1 - x0) * i) / (n - 1), y: y0 + ((y1 - y0) * i) / (n - 1), pressure: 0.5, t: i * 8,
	}));
	return { id, tool: "pen", color: "#1e2a3b", width: 2.2, points, bbox: computeBBox(points, 4.4), createdAt: createdAt++, page: pageOfSlide(0) };
}

/**
 * The pen's eraser end swept 9 px along x through one slide point and lifted, through the deck's own pointer path. A
 * contact that stays inside the 6 px tap slop is a tap and erases nothing.
 */
function eraseAt(show: { doc: FakeDoc }, x: number, y: number): void {
	const reveal = (show.doc.container!.querySelector as unknown as (sel: string) => FakeEl)(".reveal");
	// The presentation's slides box sits at (20, 25) and draws the 960-wide deck 480 wide: half a slide unit per px.
	const cx = 20 + x / 2, cy = 25 + y / 2;
	const ev = (type: string, dx: number, buttons: number) => ({
		type, pointerId: 9, pointerType: "pen", isPrimary: true, buttons, button: type === "pointerup" ? 5 : -1,
		clientX: cx + dx, clientY: cy, pressure: buttons ? 0.5 : 0, timeStamp: (clock += 16),
		preventDefault: () => undefined, stopPropagation: () => undefined,
	});
	reveal.dispatch(ev("pointerdown", -4, 32));
	for (const dx of [-1, 2, 5]) reveal.dispatch(ev("pointermove", dx, 32));
	reveal.dispatch(ev("pointerup", 5, 0));
}

describe("a stroke cut on a locked copy keeps its place among the file's strokes when the lock clears", () => {
	let radius = 0;
	beforeEach(() => {
		radius = getEraserRadiusPx();
		setEraserRadiusPx(10);
		setEraserWholeStrokes(false);
	});
	afterEach(() => {
		setEraserRadiusPx(radius);
		setEraserWholeStrokes(true);
	});

	/**
	 * The file holds A, then B drawn across A. The copy alone is locked; its deck cuts the middle out of A (B is clear
	 * of the eraser) and draws one stroke of its own. Nothing reaches the file while locked.
	 */
	async function cutWhileLocked(v: Vault, sid: string) {
		// The sweep at x 200 takes A from about 170 to 230; B at x 150 is 20 units clear of it.
		const a = line("file-a", 40, 200, 260, 200);
		const b = line("file-b", 150, 120, 150, 280);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [a, b])));
		inlineInk.markDuplicateLocked(COPY, ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
		const { deck, show } = await v.present(COPY);
		expect(deckModel(deck).map((s) => s.id), "precondition: the copy's deck loaded A then B").toEqual(["file-a", "file-b"]);
		eraseAt(show, 200, 200);
		await vi.advanceTimersByTimeAsync(50);
		const pieces = deckModel(deck).map((s) => s.id).filter((id) => !id.startsWith("file-"));
		expect(pieces.length, "precondition: the eraser cut A in two").toBe(2);
		expect(deckModel(deck).map((s) => s.id), "precondition: A's pieces sit where A sat, before B").toEqual([...pieces, "file-b"]);
		show.draw(300, 300);
		const drawn = deckModel(deck).map((s) => s.id).find((id) => !id.startsWith("file-") && !pieces.includes(id));
		expect(drawn, "precondition: the stroke drawn on the copy's deck").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(onDisk(v.adapter, sid), "precondition: nothing written while locked").toEqual(["file-a", "file-b"]);
		return { deck, show, a, b, pieces, drawn: drawn! };
	}

	it("A's pieces stay under B, and the original's newer stroke and the copy's own stroke go on top, in the file and on screen", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, a, b, pieces, drawn } = await cutWhileLocked(v, sid);
		await v.store.saveNow(sid, v.slidesPage(SHARED, [a, b, line("orig-later", 400, 100, 500, 150)]), v.plugin.slidesWriter!);

		await deleteOriginal(v);

		const want = [...pieces, "file-b", "orig-later", drawn];
		expect(onDisk(v.adapter, sid), "A's pieces were saved over B, which was drawn across A").toEqual(want);
		expect(deckModel(deck).map((s) => s.id), "the open deck draws A's pieces over B").toEqual(want);
	});

	it("a piece of A cut again still follows A", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, show, a, b, pieces, drawn } = await cutWhileLocked(v, sid);
		// A sweep at x 90 takes the left piece from about 60 to 120, clear of B at 150.
		eraseAt(show, 90, 200);
		await vi.advanceTimersByTimeAsync(50);
		const now = deckModel(deck).map((s) => s.id);
		expect(now.includes(pieces[0]!), "precondition: the left piece was cut again").toBe(false);
		const fromA = now.filter((id) => !id.startsWith("file-") && id !== drawn);
		expect(fromA.length, "precondition: A is now in three pieces").toBe(3);
		await v.store.saveNow(sid, v.slidesPage(SHARED, [a, b, line("orig-later", 400, 100, 500, 150)]), v.plugin.slidesWriter!);

		await deleteOriginal(v);

		const want = [...fromA, "file-b", "orig-later", drawn];
		expect(onDisk(v.adapter, sid), "a piece cut a second time was saved over B").toEqual(want);
		expect(deckModel(deck).map((s) => s.id), "the open deck draws a twice-cut piece over B").toEqual(want);
	});

	it("A gone from the file (the original erased it): its pieces keep today's place, after the file's strokes", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, b, pieces, drawn } = await cutWhileLocked(v, sid);
		await v.store.saveNow(sid, v.slidesPage(SHARED, [b, line("orig-later", 400, 100, 500, 150)]), v.plugin.slidesWriter!);

		await deleteOriginal(v);

		const want = ["file-b", "orig-later", ...pieces, drawn];
		expect(onDisk(v.adapter, sid), "pieces of a stroke the file no longer holds moved").toEqual(want);
		expect(deckModel(deck).map((s) => s.id), "the open deck moved pieces of a stroke the file no longer holds").toEqual(want);
	});

	it("a whole stroke erased on the copy stays erased, and a cut undone before the clear leaves the file's order", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, show, a, b, drawn } = await cutWhileLocked(v, sid);
		expect(deck.run("undo"), "precondition: the copy's own stroke undone").toBe(true);
		expect(deck.run("undo"), "precondition: the cut undone").toBe(true);
		expect(deckModel(deck).map((s) => s.id), "precondition: A is whole again, before B").toEqual(["file-a", "file-b"]);
		setEraserWholeStrokes(true);
		eraseAt(show, 150, 260);
		await vi.advanceTimersByTimeAsync(50);
		expect(deckModel(deck).map((s) => s.id), "precondition: B erased whole on the copy").toEqual(["file-a"]);
		await v.store.saveNow(sid, v.slidesPage(SHARED, [a, b, line("orig-later", 400, 100, 500, 150)]), v.plugin.slidesWriter!);

		await deleteOriginal(v);

		expect(onDisk(v.adapter, sid), "the erase on the copy was undone, or the file's order changed").toEqual(["file-a", "orig-later"]);
		expect(deckModel(deck).map((s) => s.id), "the open deck shows an erased stroke, or a changed order").toEqual(["file-a", "orig-later"]);
		expect(deckModel(deck).map((s) => s.id).includes(drawn), "the undone stroke came back").toBe(false);
	});
});

/** A file stroke through `corners` on slide 0, `n` samples a side, the corners once each. */
function polyline(id: string, corners: ReadonlyArray<readonly [number, number]>, n = 8): InkStroke {
	const points: InkPoint[] = [];
	for (let c = 0; c < corners.length - 1; c++) {
		const [x0, y0] = corners[c]!;
		const [x1, y1] = corners[c + 1]!;
		for (let i = c === 0 ? 0 : 1; i <= n; i++) points.push({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n, pressure: 0.5, t: points.length * 8 });
	}
	return { id, tool: "pen", color: "#1e2a3b", width: 2.2, points, bbox: computeBBox(points, 4.4), createdAt: createdAt++, page: pageOfSlide(0) };
}

/** The other note's eraser cuts `s` at (cx, cy), slide units, as its own deck would: real pieces, ids `<prefix>-1`, ... */
function ownerCut(s: InkStroke, cx: number, cy: number, r: number, prefix: string): InkStroke[] {
	let n = 0;
	const pieces = splitStrokeByCircle(s, cx, cy, r, () => `${prefix}-${++n}`);
	expect(pieces.length, `precondition: the other note's eraser cut ${s.id} in two`).toBe(2);
	return pieces;
}

describe("one line cut by both notes while the copy was locked is drawn once after the lock clears: the copy's version wins", () => {
	let radius = 0;
	beforeEach(() => {
		radius = getEraserRadiusPx();
		setEraserRadiusPx(10);
		setEraserWholeStrokes(false);
	});
	afterEach(() => {
		setEraserRadiusPx(radius);
		setEraserWholeStrokes(true);
	});

	// F runs along y 200 from x 40 to 260; X crosses it at x 150. The copy's sweep at x 200 takes F from about 170 to 230.
	const fileF = () => line("file-f", 40, 200, 260, 200);
	const fileX = () => line("file-x", 150, 120, 150, 280);

	/** The file holds `file`; the copy alone is locked and its deck is open on it. */
	async function lockedDeck(v: Vault, sid: string, file: InkStroke[]) {
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, file)));
		inlineInk.markDuplicateLocked(COPY, ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
		const { deck, show } = await v.present(COPY);
		expect(deckModel(deck).map((s) => s.id), "precondition: the copy's deck loaded the file").toEqual(file.map((s) => s.id));
		return { deck, show };
	}

	/** The copy's eraser cuts F at x 200 on the locked deck; nothing reaches the file. */
	async function copyCutsF(v: Vault, sid: string, show: { doc: FakeDoc }, deck: SlidesDeck): Promise<string[]> {
		const before = v.adapter.files.get(sidecarPath(sid));
		eraseAt(show, 200, 200);
		await vi.advanceTimersByTimeAsync(50);
		const pieces = deckModel(deck).map((s) => s.id).filter((id) => !id.startsWith("file-"));
		expect(pieces.length, "precondition: the copy's eraser cut F in two").toBe(2);
		expect(deckModel(deck).map((s) => s.id), "precondition: the copy's pieces sit where F sat, before X").toEqual([...pieces, "file-x"]);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(v.adapter.files.get(sidecarPath(sid)), "precondition: nothing written while locked").toBe(before);
		return pieces;
	}

	it("both cut F: the copy's pieces only, where the owner's first piece sat, under X; the owner's short first piece does not send the copy's longer one to the top", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const f = fileF(), x = fileX();
		const { deck, show } = await lockedDeck(v, sid, [f, x]);
		const pieces = await copyCutsF(v, sid, show, deck);
		// The owner cut F near its start, so its first piece is shorter than the copy's first piece.
		const own = ownerCut(f, 60, 200, 8, "own-f");
		await v.store.saveNow(sid, v.slidesPage(SHARED, [...own, x]), v.plugin.slidesWriter!);

		await deleteOriginal(v);

		const want = [...pieces, "file-x"];
		expect.soft(onDisk(v.adapter, sid)?.filter((id) => id.startsWith("own-")), "the owner's pieces of F stayed beside the copy's: F's line is drawn twice").toEqual([]);
		expect(onDisk(v.adapter, sid), "the file does not hold F's line once, the copy's version, under X").toEqual(want);
		expect(deckModel(deck).map((s) => s.id), "the open deck does not draw F's line once, the copy's version, under X").toEqual(want);
	});

	it("the owner cut its own piece of F again: none of its pieces stay", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const f = fileF(), x = fileX();
		const { deck, show } = await lockedDeck(v, sid, [f, x]);
		const pieces = await copyCutsF(v, sid, show, deck);
		const [f1, f2] = ownerCut(f, 60, 200, 8, "own-f");
		const again = ownerCut(f2!, 110, 200, 6, "own-f2");
		await v.store.saveNow(sid, v.slidesPage(SHARED, [f1!, ...again, x]), v.plugin.slidesWriter!);

		await deleteOriginal(v);

		const want = [...pieces, "file-x"];
		expect(onDisk(v.adapter, sid), "a piece the owner cut twice stayed beside the copy's version").toEqual(want);
		expect(deckModel(deck).map((s) => s.id), "the open deck draws a piece the owner cut twice beside the copy's version").toEqual(want);
	});

	it("the copy erased F whole, the owner cut it: the owner's pieces do not bring back ink the copy erased", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const f = fileF(), x = fileX();
		const { deck, show } = await lockedDeck(v, sid, [f, x]);
		setEraserWholeStrokes(true);
		eraseAt(show, 200, 200);
		await vi.advanceTimersByTimeAsync(50);
		expect(deckModel(deck).map((s) => s.id), "precondition: F erased whole on the copy").toEqual(["file-x"]);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.saveNow(sid, v.slidesPage(SHARED, [...ownerCut(f, 60, 200, 8, "own-f"), x]), v.plugin.slidesWriter!);

		await deleteOriginal(v);

		expect(onDisk(v.adapter, sid), "ink the copy erased came back through the owner's pieces").toEqual(["file-x"]);
		expect(deckModel(deck).map((s) => s.id), "the open deck shows ink the copy erased").toEqual(["file-x"]);
	});

	it("the owner's cut reaches the locked deck by sync and the live poll runs: the deck never draws F's line twice, before or after the clear", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const f = fileF(), x = fileX();
		const { deck, show } = await lockedDeck(v, sid, [f, x]);
		const pieces = await copyCutsF(v, sid, show, deck);
		// Another device's sync client writes the owner's page.
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [...ownerCut(f, 60, 200, 8, "own-f"), x])));
		// One tick of the live poll (PluginOnloadReload): the candidate, then the reload.
		const polled = slidesReloadCandidate();
		if (polled !== null) await reloadSlidesExternal(polled);
		await drainMicrotasks();
		const want = [...pieces, "file-x"];
		expect(deckModel(deck).map((s) => s.id), "the poll put the owner's pieces of F on the locked deck beside the copy's").toEqual(want);

		await deleteOriginal(v);

		expect(onDisk(v.adapter, sid), "after the clear the file does not hold F's line once, the copy's version").toEqual(want);
		expect(deckModel(deck).map((s) => s.id), "after the clear the open deck does not draw F's line once, the copy's version").toEqual(want);
	});

	it("pin: the owner cut F and the copy left F alone: the owner's pieces stay, the copy's own stroke on top", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const f = fileF(), x = fileX();
		const { deck, show } = await lockedDeck(v, sid, [f, x]);
		show.draw(300, 300);
		const drawn = deckModel(deck).map((s) => s.id).find((id) => !id.startsWith("file-"));
		expect(drawn, "precondition: the stroke drawn on the copy's deck").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		const own = ownerCut(f, 60, 200, 8, "own-f");
		await v.store.saveNow(sid, v.slidesPage(SHARED, [...own, x]), v.plugin.slidesWriter!);

		await deleteOriginal(v);

		const want = [...own.map((s) => s.id), "file-x", drawn!];
		expect(onDisk(v.adapter, sid), "the owner's cut of a stroke the copy left alone was lost").toEqual(want);
		expect(deckModel(deck).map((s) => s.id), "the open deck lost the owner's cut of a stroke the copy left alone").toEqual(want);
	});

	it("pin: a stroke the owner drew along F, on F's own samples, stays", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const f = fileF(), x = fileX();
		const { deck, show } = await lockedDeck(v, sid, [f, x]);
		const pieces = await copyCutsF(v, sid, show, deck);
		// Drawn later than F, in F's pen, over F's own samples: only its time tells it from a piece of F.
		const along = f.points.slice(4, 10).map((p) => ({ ...p }));
		const y: InkStroke = { ...f, id: "own-y", points: along, bbox: computeBBox(along, 4.4), createdAt: createdAt++ };
		await v.store.saveNow(sid, v.slidesPage(SHARED, [...ownerCut(f, 60, 200, 8, "own-f"), x, y]), v.plugin.slidesWriter!);

		await deleteOriginal(v);

		const want = [...pieces, "file-x", "own-y"];
		expect(onDisk(v.adapter, sid), "a stroke the owner drew along F was dropped as a piece of F").toEqual(want);
		expect(deckModel(deck).map((s) => s.id), "the open deck dropped a stroke the owner drew along F").toEqual(want);
	});

	it("pin: the owner's pieces of a sibling the copy left alone stay, though they share F's time and sit in F's box", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		// One stroke S, cut earlier into E1 and E2 on its last side: siblings with one time and pen. E1 runs down x 40,
		// along y 200 and back up the diagonal; E2 carries on up the diagonal, inside E1's box.
		const s = polyline("file-s", [[40, 120], [40, 200], [240, 200], [140, 160]]);
		const [e1, e2] = ownerCut(s, 200, 184, 8, "file-e").map((p, i) => ({ ...p, id: `file-e${i + 1}` }));
		const { deck, show } = await lockedDeck(v, sid, [e1!, e2!]);
		// The copy cuts E1 at x 100, clear of E2.
		eraseAt(show, 100, 200);
		await vi.advanceTimersByTimeAsync(50);
		const pieces = deckModel(deck).map((p) => p.id).filter((id) => !id.startsWith("file-"));
		expect(pieces.length, "precondition: the copy's eraser cut E1 in two").toBe(2);
		expect(deckModel(deck).map((p) => p.id), "precondition: E2 left alone on the copy").toEqual([...pieces, "file-e2"]);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		// The owner cuts E1 and E2.
		const ownE1 = ownerCut(e1!, 40, 160, 8, "own-e1");
		const ownE2 = ownerCut(e2!, 166, 170.4, 6, "own-e2");
		const b = e1!.bbox;
		const inBox = ownE2.every((p) => p.points.every((q) => q.x >= b.x && q.x <= b.x + b.width && q.y >= b.y && q.y <= b.y + b.height));
		expect(inBox, "precondition: the owner's pieces of E2 sit inside E1's box").toBe(true);
		await v.store.saveNow(sid, v.slidesPage(SHARED, [...ownE1, ...ownE2]), v.plugin.slidesWriter!);

		await deleteOriginal(v);

		const want = [...pieces, ...ownE2.map((p) => p.id)];
		expect(onDisk(v.adapter, sid), "the owner's pieces of E2 were dropped as E1's, or E1's line is twice").toEqual(want);
		expect(deckModel(deck).map((p) => p.id), "the open deck dropped the owner's pieces of E2, or draws E1's line twice").toEqual(want);
	});

	it("the lift's read fails and a later poll reads the file: the copy's pieces once, no owner's piece beside them", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const f = fileF(), x = fileX();
		const { deck, show } = await lockedDeck(v, sid, [f, x]);
		const pieces = await copyCutsF(v, sid, show, deck);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [...ownerCut(f, 60, 200, 8, "own-f"), x])));
		// The store's read at the lift rejects once (a sync client mid-write); later reads succeed.
		const load = v.store.load.bind(v.store);
		let failed = 0;
		vi.spyOn(v.store, "load").mockImplementation(async (id, options) => {
			if (id === sid && failed++ === 0) throw new Error("load rejected once (injected)");
			return load(id, options);
		});

		await deleteOriginal(v);
		expect(failed, "precondition: the lift's read was made and rejected").toBeGreaterThan(0);
		const polled = slidesReloadCandidate();
		expect(polled, "precondition: the unlocked deck takes the poll").toBe(sid);
		await reloadSlidesExternal(polled!);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();

		const want = [...pieces, "file-x"];
		expect(deckModel(deck).map((s) => s.id), "after the poll the open deck draws the owner's pieces of F beside the copy's").toEqual(want);
		expect(onDisk(v.adapter, sid), "after the poll the file holds the owner's pieces of F beside the copy's").toEqual(want);
	});

	it("a clean locked deck, the file changed by sync, a stroke at the lift: the saved page holds the file's new ink, no conflict copy", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const f = fileF(), x = fileX();
		const { deck, show } = await lockedDeck(v, sid, [f, x]);
		// Another device's sync client writes the owner's newer stroke while the copy is locked and clean.
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [f, x, line("orig-later", 400, 100, 500, 150)])));

		v.unlisted.add(ORIG);
		await v.plugin.onFileDeleted(Object.assign(new TFile(), { path: ORIG, extension: "md", basename: "Deck" }));
		v.texts.delete(ORIG);
		inlineInk.handleDelete(ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the lock cleared").toBe(false);
		// The copy draws at once, before any poll.
		show.draw(300, 300);
		const drawn = deckModel(deck).map((s) => s.id).find((id) => !id.startsWith("file-") && id !== "orig-later");
		expect(drawn, "precondition: the stroke drawn on the copy's deck at the lift").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();

		const conflicts = [...v.adapter.files.keys()].filter((p) => p.includes(".conflict-"));
		expect.soft(conflicts, "the stroke was saved on the page the deck loaded, and the file's newer ink set aside").toEqual([]);
		expect(onDisk(v.adapter, sid), "the saved page lost the file's newer ink, or the stroke drawn at the lift").toEqual(["file-f", "file-x", "orig-later", drawn]);
		expect(deckModel(deck).map((s) => s.id), "the open deck does not show the file's newer ink").toEqual(["file-f", "file-x", "orig-later", drawn]);
	});

	it("a locked deck holds the page it loaded: the other note's stroke synced meanwhile shows when the lock lifts, not before", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const f = fileF(), x = fileX();
		const { deck, show } = await lockedDeck(v, sid, [f, x]);
		show.draw(300, 300);
		const drawn = deckModel(deck).map((s) => s.id).find((id) => !id.startsWith("file-"));
		expect(drawn, "precondition: the stroke drawn on the copy's deck").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [f, x, line("orig-later", 400, 100, 500, 150)])));
		const polled = slidesReloadCandidate();
		if (polled !== null) await reloadSlidesExternal(polled);
		await drainMicrotasks();
		expect(deckModel(deck).map((s) => s.id), "the locked deck took the file's newer ink before the lock lifted").toEqual(["file-f", "file-x", drawn]);

		await deleteOriginal(v);

		expect(onDisk(v.adapter, sid), "the file after the lift lost the other note's stroke or the copy's").toEqual(["file-f", "file-x", "orig-later", drawn]);
		expect(deckModel(deck).map((s) => s.id), "the open deck after the lift").toEqual(["file-f", "file-x", "orig-later", drawn]);
	});

	it("guard: a locked deck whose first read threw still loads at the next poll", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [fileF(), fileX()])));
		inlineInk.markDuplicateLocked(COPY, ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
		const read = v.adapter.read.bind(v.adapter);
		let throwing = true;
		vi.spyOn(v.adapter, "read").mockImplementation(async (p: string) => {
			if (throwing && p === sidecarPath(sid)) throw new Error("EBUSY injected");
			return read(p);
		});
		const { deck } = await v.present(COPY);
		expect(deckModel(deck).map((s) => s.id), "precondition: the first read threw, so the deck holds nothing yet").toEqual([]);
		throwing = false;

		const polled = slidesReloadCandidate();
		if (polled !== null) await reloadSlidesExternal(polled);
		await drainMicrotasks();

		expect(polled, "the poll refuses a locked deck still waiting on a read that failed").toBe(sid);
		expect(deckModel(deck).map((s) => s.id), "the locked deck whose first read threw stays blank").toEqual(["file-f", "file-x"]);
	});

	it("a piece the copy cut and saved before its lock, cut again by the owner while locked: the owner's pieces stand, and the copy's piece is not drawn beside them", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const f = fileF(), x = fileX();
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [f, x])));
		const { deck, show } = await v.present(COPY);
		expect(deckModel(deck).map((s) => s.id), "precondition: the copy's deck loaded the file").toEqual(["file-f", "file-x"]);
		eraseAt(show, 200, 200);
		await vi.advanceTimersByTimeAsync(50);
		const pieces = deckModel(deck).filter((s) => !s.id.startsWith("file-"));
		expect(pieces.length, "precondition: the copy's eraser cut F in two").toBe(2);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(onDisk(v.adapter, sid), "precondition: the copy's cut reached the file").toEqual([...pieces.map((s) => s.id), "file-x"]);
		inlineInk.markDuplicateLocked(COPY, ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
		// The owner cuts the copy's long left piece (x 40 to about 170) again at x 100.
		const left = pieces.reduce((a, b) => (a.bbox.x <= b.bbox.x ? a : b));
		const right = pieces.find((s) => s !== left)!;
		const own = ownerCut(left, 100, 200, 8, "own-l");
		const order = pieces[0] === left ? [...own, right, x] : [right, ...own, x];
		await v.store.saveNow(sid, v.slidesPage(SHARED, order), v.plugin.slidesWriter!);
		expect(onDisk(v.adapter, sid), "precondition: the owner's cut reached the file").toEqual(order.map((s) => s.id));

		await deleteOriginal(v);

		const want = order.map((s) => s.id);
		expect(onDisk(v.adapter, sid), "the file holds the copy's saved piece beside the owner's pieces of it").toEqual(want);
		expect(deckModel(deck).map((s) => s.id), "the open deck draws the copy's saved piece beside the owner's pieces of it").toEqual(want);
	});
});

describe("pin: a cut the deck has already saved is never a reason to drop the file's ink", () => {
	let radius = 0;
	beforeEach(() => {
		radius = getEraserRadiusPx();
		setEraserRadiusPx(10);
		setEraserWholeStrokes(false);
	});
	afterEach(() => {
		setEraserRadiusPx(radius);
		setEraserWholeStrokes(true);
	});

	it("an unlocked deck cuts F and the save lands; another device cuts one of those pieces again: the poll takes its pieces", async () => {
		const v = vault({ [ORIG]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const x = line("file-x", 150, 120, 150, 280);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [line("file-f", 40, 200, 260, 200), x])));
		const { deck, show } = await v.present(ORIG);
		expect(deckModel(deck).map((s) => s.id), "precondition: the deck loaded F and X").toEqual(["file-f", "file-x"]);
		eraseAt(show, 200, 200);
		await vi.advanceTimersByTimeAsync(50);
		const pieces = deckModel(deck).filter((s) => !s.id.startsWith("file-"));
		expect(pieces.length, "precondition: the eraser cut F in two").toBe(2);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		expect(onDisk(v.adapter, sid), "precondition: the cut was saved").toEqual([...pieces.map((s) => s.id), "file-x"]);
		// Another device cuts the left piece again; its sync client writes the file.
		const again = ownerCut(pieces[0]!, 90, 200, 6, "other");
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [...again, pieces[1]!, x])));

		const polled = slidesReloadCandidate();
		expect(polled, "precondition: the deck takes the poll").toBe(sid);
		await reloadSlidesExternal(polled!);
		await drainMicrotasks();

		expect(deckModel(deck).map((s) => s.id).sort(), "the poll dropped the other device's pieces of a saved piece").toEqual([...again.map((s) => s.id), pieces[1]!.id, "file-x"].sort());
	});
});

// The presentation notices, word for word (SlidesPersistence.ts, SlidesBind.ts).
const COULD_NOT_READ_YET = "Handwriting: this presentation's ink file could not be read yet. New ink on it is not saved until it loads.";
const READABLE_AGAIN = "Handwriting: this presentation's ink file is readable again. The saved ink is restored and saving is back on.";
const NOT_SAVED = "Handwriting: this presentation's ink could not be saved.";

/** From here on the Slides ink file's reads throw (a sync client mid-write) while `on` is true; `count` is how many threw. */
function throwingReads(v: Vault, sid: string): { on: boolean; count: number } {
	const state = { on: true, count: 0 };
	const read = v.adapter.read.bind(v.adapter);
	vi.spyOn(v.adapter, "read").mockImplementation(async (p: string) => {
		if (state.on && p === sidecarPath(sid)) {
			state.count++;
			throw new Error("EBUSY injected");
		}
		return read(p);
	});
	return state;
}

/** Every slides log line from here on. */
function slidesLog(): string[] {
	const lines: string[] = [];
	vi.spyOn(console, "debug").mockImplementation((m: unknown) => void lines.push(String(m)));
	return lines;
}

/** The presentation is closed; teardown and anything it waits on settle, and the store writes. */
async function closeDeck(v: Vault, deck: SlidesDeck): Promise<void> {
	deck.dispose();
	await Promise.all(deck.inFlightWork());
	for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
	await v.store.flush();
	await drainMicrotasks();
}

describe("a duplicate lock cleared on a copy whose Slides ink file throws at that read: the reader is told, and a close reads once more", () => {
	const seed = (v: Vault, sid: string): void =>
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [stroke("orig-saved", 100, 100, pageOfSlide(0))])));

	it("ink drawn while locked: \"could not be read yet\" once, at the lift's read; \"readable again\" when a later poll reads the file, and the ink is saved then", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const { held } = await drawnWhileLocked(v, sid, ["orig-saved"]);
		const reads = throwingReads(v, sid);
		const mark = noticeLog.length;

		await deleteOriginal(v);

		expect(reads.count, "precondition: the lift's read was made and threw").toBeGreaterThan(0);
		expect(onDisk(v.adapter, sid), "precondition: nothing saved over the file the lift could not read").toEqual(["orig-saved"]);
		expect(noticeLog.slice(mark), "the lift's read threw on ink drawn while locked and the reader was not told").toEqual([COULD_NOT_READ_YET]);
		// A poll whose read throws again says nothing more.
		const again = slidesReloadCandidate();
		expect(again, "precondition: the held deck takes the poll").toBe(sid);
		await reloadSlidesExternal(again!);
		await drainMicrotasks();
		expect(noticeLog.slice(mark), "a second failed read told the reader again").toEqual([COULD_NOT_READ_YET]);
		reads.on = false;
		const healed = slidesReloadCandidate();
		expect(healed, "precondition: the held deck takes the poll").toBe(sid);
		await reloadSlidesExternal(healed!);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();

		expect(noticeLog.slice(mark), "the read landed and the reader was not told saving is back").toEqual([COULD_NOT_READ_YET, READABLE_AGAIN]);
		expect(onDisk(v.adapter, sid), "the ink drawn while locked was not saved once a read landed").toEqual(["orig-saved", held.id]);
	});

	it("closed before a poll, the close's read lands: the ink drawn while locked is merged and saved", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const { deck, held } = await drawnWhileLocked(v, sid, ["orig-saved"]);
		const reads = throwingReads(v, sid);
		const mark = noticeLog.length;
		await deleteOriginal(v);
		expect(reads.count, "precondition: the lift's read was made and threw").toBeGreaterThan(0);
		expect(onDisk(v.adapter, sid), "precondition: nothing saved at the lift").toEqual(["orig-saved"]);
		// The sync client finishes and the original's newer stroke is in the file; the reader closes the presentation.
		reads.on = false;
		await v.store.saveNow(sid, v.slidesPage(SHARED, [stroke("orig-saved", 100, 100, pageOfSlide(0)), stroke("orig-later", 200, 200, pageOfSlide(0))]), v.plugin.slidesWriter!);
		expect(onDisk(v.adapter, sid), "precondition: the original's later stroke reached the file").toEqual(["orig-saved", "orig-later"]);

		await closeDeck(v, deck);

		expect(onDisk(v.adapter, sid), "the deck closed while held and the ink drawn while locked was dropped, or saved over the file's newer ink").toEqual(["orig-saved", "orig-later", held.id]);
		expect(noticeLog.slice(mark), "the notices at the lift and the close").toEqual([COULD_NOT_READ_YET, READABLE_AGAIN]);
	});

	it("closed before a poll, the close's read throws too: \"could not be saved\" at the close, the file untouched, and the log does not say flushed", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const { deck } = await drawnWhileLocked(v, sid, ["orig-saved"]);
		const reads = throwingReads(v, sid);
		const bytes = v.adapter.files.get(sidecarPath(sid))!;
		const mark = noticeLog.length;
		await deleteOriginal(v);
		const atLift = reads.count;
		expect(atLift, "precondition: the lift's read was made and threw").toBeGreaterThan(0);
		const lines = slidesLog();

		await closeDeck(v, deck);

		expect(v.adapter.files.get(sidecarPath(sid)), "the close wrote over a file it could not read").toBe(bytes);
		expect(reads.count, "the close did not read the file once more").toBeGreaterThan(atLift);
		expect(noticeLog.slice(mark), "the deck closed while held, its read failed, and the reader was not told the ink is lost").toEqual([COULD_NOT_READ_YET, NOT_SAVED]);
		expect(lines.filter((l) => l.includes("flushed")), "the teardown log says flushed though nothing was written").toEqual([]);
	});

	it("a deck closed while still locked writes nothing, and its log does not say flushed", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const { deck } = await drawnWhileLocked(v, sid, ["orig-saved"]);
		const bytes = v.adapter.files.get(sidecarPath(sid))!;
		const lines = slidesLog();

		await closeDeck(v, deck);

		expect(v.adapter.files.get(sidecarPath(sid)), "a deck closed while locked wrote the shared file").toBe(bytes);
		expect(lines.filter((l) => l.includes("flushed")), "the teardown log says flushed though nothing was written").toEqual([]);
	});

	it("pin: a clean locked deck whose lift read throws says nothing, at the lift or the close, and writes nothing", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		inlineInk.markDuplicateLocked(COPY, ORIG);
		const { deck } = await v.present(COPY);
		expect(deckModel(deck).map((s) => s.id), "precondition: the copy's deck loaded the file").toEqual(["orig-saved"]);
		const reads = throwingReads(v, sid);
		const bytes = v.adapter.files.get(sidecarPath(sid))!;
		const mark = noticeLog.length;

		await deleteOriginal(v);
		expect(reads.count, "precondition: the lift's read was made and threw").toBeGreaterThan(0);
		await closeDeck(v, deck);

		expect(noticeLog.slice(mark), "a clean deck's failed read was told").toEqual([]);
		expect(v.adapter.files.get(sidecarPath(sid)), "a clean deck wrote the file it could not read").toBe(bytes);
	});

	it("pin: an unlocked deck with its ink saved, a poll whose read throws: silent", async () => {
		const v = vault({ [ORIG]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const { deck, show } = await v.present(ORIG);
		show.draw(300, 300);
		const drawn = deckModel(deck).map((s) => s.id).find((id) => id !== "orig-saved");
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		expect(onDisk(v.adapter, sid), "precondition: the stroke was saved").toEqual(["orig-saved", drawn]);
		const reads = throwingReads(v, sid);
		v.adapter.externalWrite(sidecarPath(sid), v.adapter.files.get(sidecarPath(sid))!);
		const mark = noticeLog.length;

		const polled = slidesReloadCandidate();
		expect(polled, "precondition: the deck takes the poll").toBe(sid);
		await reloadSlidesExternal(polled!);
		await drainMicrotasks();

		expect(reads.count, "precondition: the poll's read threw").toBeGreaterThan(0);
		expect(noticeLog.slice(mark), "a thrown poll read with nothing unsaved was told").toEqual([]);
	});
});

/**
 * The Slides ink file's reads from here on: held open ("hold", each released by `waiting`; "hold-one" holds the next
 * read and passes the ones after it), thrown ("throw"), or passed through ("pass"). `count` is how many were asked for.
 */
function heldReads(v: Vault, sid: string) {
	const state = { mode: "hold" as "hold" | "hold-one" | "throw" | "pass", count: 0, waiting: [] as Array<(fail: boolean) => void> };
	const read = v.adapter.read.bind(v.adapter);
	vi.spyOn(v.adapter, "read").mockImplementation(async (p: string) => {
		if (p !== sidecarPath(sid)) return read(p);
		state.count++;
		if (state.mode === "throw") throw new Error("EBUSY injected");
		if (state.mode === "pass") return read(p);
		if (state.mode === "hold-one") state.mode = "pass";
		return new Promise<string>((resolve, reject) => {
			state.waiting.push((fail) => (fail ? reject(new Error("EBUSY injected")) : resolve(read(p))));
		});
	});
	return state;
}

/** The original is deleted and the copy's lock clears, with no wait on the store: the lift's read may still be open. */
async function clearOnly(v: Vault): Promise<void> {
	v.unlisted.add(ORIG);
	await v.plugin.onFileDeleted(Object.assign(new TFile(), { path: ORIG, extension: "md", basename: "Deck" }));
	v.texts.delete(ORIG);
	inlineInk.handleDelete(ORIG);
	expect(inlineInk.isDuplicateLocked(COPY), "precondition: the lock cleared").toBe(false);
	await drainMicrotasks();
}

describe("the read after a lift whose read threw is a live re-read: erases on both sides hold, and the close's read saves the merge", () => {
	let radius = 0;
	beforeEach(() => {
		radius = getEraserRadiusPx();
		setEraserRadiusPx(10);
		setEraserWholeStrokes(true);
	});
	afterEach(() => {
		setEraserRadiusPx(radius);
		setEraserWholeStrokes(true);
	});

	/**
	 * The file holds E and K. The copy alone is locked; its deck erases E whole and draws one stroke. The original erases
	 * K and saves, so the file holds E alone. The lift's read throws.
	 */
	async function erasedBothSides(v: Vault, sid: string) {
		const e = line("file-e", 40, 100, 260, 100);
		const k = line("file-k", 40, 400, 260, 400);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [e, k])));
		inlineInk.markDuplicateLocked(COPY, ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
		const { deck, show } = await v.present(COPY);
		expect(deckModel(deck).map((s) => s.id), "precondition: the copy's deck loaded E and K").toEqual(["file-e", "file-k"]);
		eraseAt(show, 150, 100);
		await vi.advanceTimersByTimeAsync(50);
		expect(deckModel(deck).map((s) => s.id), "precondition: E erased on the copy").toEqual(["file-k"]);
		show.draw(300, 300);
		const held = deckModel(deck).map((s) => s.id).find((id) => !id.startsWith("file-"));
		expect(held, "precondition: the stroke drawn on the copy's deck").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.saveNow(sid, v.slidesPage(SHARED, [e]), v.plugin.slidesWriter!);
		expect(onDisk(v.adapter, sid), "precondition: the original's erase of K reached the file").toEqual(["file-e"]);
		const reads = throwingReads(v, sid);
		await deleteOriginal(v);
		expect(reads.count, "precondition: the lift's read was made and threw").toBeGreaterThan(0);
		expect(onDisk(v.adapter, sid), "precondition: nothing saved at the lift").toEqual(["file-e"]);
		reads.on = false;
		return { deck, held: held! };
	}

	it("pin: a later poll lands: no E, no K, the copy's stroke once, in the file and on the deck", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, held } = await erasedBothSides(v, sid);

		const polled = slidesReloadCandidate();
		expect(polled, "precondition: the held deck takes the poll").toBe(sid);
		await reloadSlidesExternal(polled!);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();

		expect(deckModel(deck).map((s) => s.id), "after the poll the deck shows E the copy erased, or K the original erased").toEqual([held]);
		expect(onDisk(v.adapter, sid), "after the poll the file holds E the copy erased, or K the original erased").toEqual([held]);
	});

	it("closed before a poll, the close's read lands: no E, no K, the copy's stroke once in the file", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, held } = await erasedBothSides(v, sid);

		await closeDeck(v, deck);

		expect(onDisk(v.adapter, sid), "the close's read brought back E the copy erased, kept K the original erased, or dropped the copy's stroke").toEqual([held]);
	});

	it("both cut F while the copy was locked, the lift's read throws, the close's read lands: the copy's pieces once, under X", async () => {
		setEraserWholeStrokes(false);
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const f = line("file-f", 40, 200, 260, 200);
		const x = line("file-x", 150, 120, 150, 280);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [f, x])));
		inlineInk.markDuplicateLocked(COPY, ORIG);
		const { deck, show } = await v.present(COPY);
		expect(deckModel(deck).map((s) => s.id), "precondition: the copy's deck loaded F and X").toEqual(["file-f", "file-x"]);
		eraseAt(show, 200, 200);
		await vi.advanceTimersByTimeAsync(50);
		const pieces = deckModel(deck).map((s) => s.id).filter((id) => !id.startsWith("file-"));
		expect(pieces.length, "precondition: the copy's eraser cut F in two").toBe(2);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [...ownerCut(f, 60, 200, 8, "own-f"), x])));
		const reads = throwingReads(v, sid);
		await deleteOriginal(v);
		expect(reads.count, "precondition: the lift's read was made and threw").toBeGreaterThan(0);
		reads.on = false;

		await closeDeck(v, deck);

		expect(onDisk(v.adapter, sid), "the close's save does not hold F's line once, the copy's version, under X").toEqual([...pieces, "file-x"]);
	});
});

describe("a close while the lift's read is still open, and a deck whose ink was all saved before the lock", () => {
	const seed = (v: Vault, sid: string): void =>
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [stroke("orig-saved", 100, 100, pageOfSlide(0))])));

	it("the lift's read is open at the close and throws, and the close's one more read throws: \"could not be read yet\", then \"could not be saved\"; the file untouched", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const { deck } = await drawnWhileLocked(v, sid, ["orig-saved"]);
		const bytes = v.adapter.files.get(sidecarPath(sid))!;
		const reads = heldReads(v, sid);
		const mark = noticeLog.length;
		await clearOnly(v);
		expect(reads.waiting.length, "precondition: the lift's read is open").toBe(1);
		const lines = slidesLog();

		deck.dispose();
		reads.mode = "throw";
		for (const release of reads.waiting.splice(0)) release(true);
		await Promise.all(deck.inFlightWork());
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();

		// The open read is the lift's; the close reads once more after it fails.
		expect(reads.count, "the close did not read once more after the lift's open read failed").toBe(2);
		expect(v.adapter.files.get(sidecarPath(sid)), "the close wrote over a file it could not read").toBe(bytes);
		expect(noticeLog.slice(mark), "a close while the lift's read was open lost the ink with no word").toEqual([COULD_NOT_READ_YET, NOT_SAVED]);
		expect(lines.filter((l) => l.includes("flushed") || l.includes("read-only")), "the teardown log names a write or a read-only deck").toEqual([]);
	});

	it("the lift's read is open at the close and throws, and the close's one more read lands: the merged page is saved", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const { deck, held } = await drawnWhileLocked(v, sid, ["orig-saved"]);
		await v.store.saveNow(sid, v.slidesPage(SHARED, [stroke("orig-saved", 100, 100, pageOfSlide(0)), stroke("orig-later", 200, 200, pageOfSlide(0))]), v.plugin.slidesWriter!);
		const reads = heldReads(v, sid);
		const mark = noticeLog.length;
		await clearOnly(v);
		expect(reads.waiting.length, "precondition: the lift's read is open").toBe(1);

		deck.dispose();
		reads.mode = "pass";
		for (const release of reads.waiting.splice(0)) release(true);
		await Promise.all(deck.inFlightWork());
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();

		expect(onDisk(v.adapter, sid), "the close's read landed and the merged page was not saved").toEqual(["orig-saved", "orig-later", held.id]);
		expect(noticeLog.slice(mark), "the notices at the lift and the close").toEqual([COULD_NOT_READ_YET, READABLE_AGAIN]);
	});

	it("pin: ink drawn and saved before the lock, nothing drawn while locked, the lift's and the close's reads throw: silent, and the file untouched", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const { deck, show } = await v.present(COPY);
		show.draw(300, 300);
		const drawn = deckModel(deck).map((s) => s.id).find((id) => id !== "orig-saved");
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		expect(onDisk(v.adapter, sid), "precondition: the stroke was saved before the lock").toEqual(["orig-saved", drawn]);
		inlineInk.markDuplicateLocked(COPY, ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
		const reads = throwingReads(v, sid);
		const bytes = v.adapter.files.get(sidecarPath(sid))!;
		const mark = noticeLog.length;

		await deleteOriginal(v);
		expect(reads.count, "precondition: the lift's read was made and threw").toBeGreaterThan(0);
		await closeDeck(v, deck);

		expect(noticeLog.slice(mark), "a deck whose ink is all in the file was told it could not be read or saved").toEqual([]);
		expect(v.adapter.files.get(sidecarPath(sid)), "the deck wrote the file it could not read").toBe(bytes);
	});

	it("closed and opened again at once: the new deck reads the file while the close's read is open; after it saves, the file still holds the ink drawn while locked", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const { deck, held } = await drawnWhileLocked(v, sid, ["orig-saved"]);
		const show = { doc: deck.ownerDocument as unknown as FakeDoc };
		const reads = heldReads(v, sid);
		reads.mode = "throw";
		await deleteOriginal(v);
		expect(reads.count, "precondition: the lift's read was made and threw").toBeGreaterThan(0);

		// The presentation is closed and opened again on the same note: the old container leaves, a new one comes, and
		// the controller's scan closes the old deck and builds the new one. The close's read is held open; the new
		// deck's own read passes.
		reads.mode = "hold-one";
		const beforeClose = reads.count;
		show.doc.container!.isConnected = false;
		const again = presentation(3, show.doc);
		scanForSlides();
		await drainMicrotasks();
		expect(reads.count - beforeClose, "the close did not read the file once more beside the new deck's read").toBeGreaterThanOrEqual(2);
		const deck2 = liveDeck();
		expect(deck2, "precondition: a new deck").not.toBe(deck);
		expect(deck.disposed, "precondition: the old deck is closed").toBe(true);
		expect(reads.waiting.length, "precondition: the close's read is open").toBe(1);
		expect(deckModel(deck2).map((s) => s.id), "precondition: the new deck read the file before the close's write").toEqual(["orig-saved"]);

		for (const release of reads.waiting.splice(0)) release(false);
		await Promise.all(deck.inFlightWork());
		await drainMicrotasks();
		again.draw(200, 200);
		const drawn2 = deckModel(deck2).map((s) => s.id).find((id) => id !== "orig-saved" && id !== held.id);
		expect(drawn2, "precondition: the stroke drawn on the new deck").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();

		expect(onDisk(v.adapter, sid)?.includes(held.id), "the new deck's save wrote over the ink the close's read saved").toBe(true);
		expect(onDisk(v.adapter, sid)?.includes(drawn2!), "the new deck's stroke was not saved").toBe(true);
	});
});

const DAMAGE_TEXT = "Handwriting: this presentation's ink file could not be read, so new ink is not being saved.";
const NEWER_TEXT =
	"Handwriting: this presentation's ink was written by a newer Handwriting. It is shown here but new ink is not being saved.";
const DAMAGED_BYTES = "{\"pageId\": \"shared-deck-id.slides\", \"strokes\": [";
const isLockNotice = (m: string): boolean => m.includes("carry the same handwriting-page-id");

describe("a duplicate lock cleared on a copy whose Slides ink file is damaged or from a newer Handwriting at that read: the reader is told once, after the lock's own notice", () => {
	const seed = (v: Vault, sid: string): void =>
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [stroke("orig-saved", 100, 100, pageOfSlide(0))])));

	/** Ink drawn on the locked copy, the lock's notice given, then the file damaged before the lift. */
	async function damagedAtLift(v: Vault, sid: string) {
		const mark0 = noticeLog.length;
		const drawn = await drawnWhileLocked(v, sid, ["orig-saved"]);
		expect(noticeLog.slice(mark0).filter(isLockNotice), "precondition: the lock's notice was given while locked").toHaveLength(1);
		const good = v.adapter.files.get(sidecarPath(sid))!;
		v.adapter.externalWrite(sidecarPath(sid), DAMAGED_BYTES);
		const bytes = v.adapter.files.get(sidecarPath(sid))!;
		expect(parsePage(bytes, sid).damaged, "precondition: the Slides ink file no longer parses").toBe(true);
		return { ...drawn, good, bytes };
	}

	it("damaged at the lift, ink drawn while locked: the damaged words once; a poll on the still damaged file says nothing more; the mended file's read says \"readable again\" and saves the ink", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const { held, good, bytes } = await damagedAtLift(v, sid);
		const mark = noticeLog.length;

		await deleteOriginal(v);

		expect(v.adapter.files.get(sidecarPath(sid)), "the lift wrote over a damaged file").toBe(bytes);
		expect(noticeLog.slice(mark), "the lift's read found the file damaged with ink drawn while locked and the reader was not told").toEqual([DAMAGE_TEXT]);
		const again = slidesReloadCandidate();
		expect(again, "precondition: the held deck takes the poll").toBe(sid);
		await reloadSlidesExternal(again!);
		await drainMicrotasks();
		expect(noticeLog.slice(mark), "a poll on the still damaged file told the reader again").toEqual([DAMAGE_TEXT]);
		v.adapter.externalWrite(sidecarPath(sid), good);
		const healed = slidesReloadCandidate();
		expect(healed, "precondition: the held deck takes the poll").toBe(sid);
		await reloadSlidesExternal(healed!);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();

		expect(noticeLog.slice(mark), "the mended file was read and the reader was not told saving is back").toEqual([DAMAGE_TEXT, READABLE_AGAIN]);
		expect(onDisk(v.adapter, sid), "the ink drawn while locked was not saved once the mended file was read").toEqual(["orig-saved", held.id]);
	});

	it("damaged at the lift, closed before a poll, the close's read finds it damaged too: the damaged words, then \"could not be saved\"; the file untouched", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const { deck, bytes } = await damagedAtLift(v, sid);
		const reads = heldReads(v, sid);
		reads.mode = "pass";
		const mark = noticeLog.length;
		await deleteOriginal(v);
		const atLift = reads.count;
		expect(atLift, "precondition: the lift read the file").toBeGreaterThan(0);
		const lines = slidesLog();

		await closeDeck(v, deck);

		expect(v.adapter.files.get(sidecarPath(sid)), "the close wrote over a damaged file").toBe(bytes);
		expect(reads.count, "the close did not read the file once more").toBeGreaterThan(atLift);
		expect(noticeLog.slice(mark), "the deck closed while held on a damaged file and the reader was not told the ink is lost").toEqual([DAMAGE_TEXT, NOT_SAVED]);
		expect(lines.filter((l) => l.includes("flushed")), "the teardown log says flushed though nothing was written").toEqual([]);
	});

	it("damaged at the lift, mended before the close: the close's read lands, \"readable again\", and the ink drawn while locked is saved with the file's newer ink", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const { deck, held } = await damagedAtLift(v, sid);
		const mark = noticeLog.length;
		await deleteOriginal(v);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [stroke("orig-saved", 100, 100, pageOfSlide(0)), stroke("orig-later", 200, 200, pageOfSlide(0))])));

		await closeDeck(v, deck);

		expect(onDisk(v.adapter, sid), "the close dropped the ink drawn while locked, or saved over the file's newer ink").toEqual(["orig-saved", "orig-later", held.id]);
		expect(noticeLog.slice(mark), "the notices at the lift and the close").toEqual([DAMAGE_TEXT, READABLE_AGAIN]);
	});

	it("from a newer Handwriting at the lift, ink drawn while locked: the newer-format words once, nothing written, and the close neither reads again nor writes", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const mark0 = noticeLog.length;
		const { deck } = await drawnWhileLocked(v, sid, ["orig-saved"]);
		expect(noticeLog.slice(mark0).filter(isLockNotice), "precondition: the lock's notice was given while locked").toHaveLength(1);
		const newer = JSON.stringify({ ...JSON.parse(v.adapter.files.get(sidecarPath(sid))!), schemaVersion: 3 });
		expect(parsePage(newer, sid).futureVersion, "precondition: the file declares a newer format").toBe(3);
		v.adapter.externalWrite(sidecarPath(sid), newer);
		const reads = heldReads(v, sid);
		reads.mode = "pass";
		const mark = noticeLog.length;

		await deleteOriginal(v);

		const atLift = reads.count;
		expect(atLift, "precondition: the lift read the file").toBeGreaterThan(0);
		expect(v.adapter.files.get(sidecarPath(sid)), "the lift wrote over a newer-format file").toBe(newer);
		expect(noticeLog.slice(mark), "the lift's read found a newer-format file and the reader was not told").toEqual([NEWER_TEXT]);
		await closeDeck(v, deck);
		expect(v.adapter.files.get(sidecarPath(sid)), "the close wrote over a newer-format file").toBe(newer);
		expect(reads.count, "the close read a newer-format file again").toBe(atLift);
		expect(noticeLog.slice(mark), "the close told the reader more").toEqual([NEWER_TEXT]);
	});

	it("pin: the lock's notice is given once a presentation, however many strokes are drawn while locked", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const mark0 = noticeLog.length;
		const { show } = await drawnWhileLocked(v, sid, ["orig-saved"]);
		show.draw(400, 400);
		show.draw(500, 300);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await drainMicrotasks();

		expect(noticeLog.slice(mark0).filter(isLockNotice), "the lock's notice was given more than once").toHaveLength(1);
	});

	it("pin: a deck never locked whose poll finds the file damaged: the damaged words once; the mended file's read heals in silence", async () => {
		const v = vault({ [ORIG]: SHARED });
		const sid = slidesSidecarId(SHARED);
		seed(v, sid);
		const { deck, show } = await v.present(ORIG);
		show.draw(300, 300);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		const good = v.adapter.files.get(sidecarPath(sid))!;
		expect(onDisk(v.adapter, sid)?.length, "precondition: the stroke was saved").toBe(2);
		const mark = noticeLog.length;
		v.adapter.externalWrite(sidecarPath(sid), DAMAGED_BYTES);
		const polled = slidesReloadCandidate();
		expect(polled, "precondition: the deck takes the poll").toBe(sid);
		await reloadSlidesExternal(polled!);
		await drainMicrotasks();
		expect(noticeLog.slice(mark), "a never locked deck's damaged poll read").toEqual([DAMAGE_TEXT]);
		const again = slidesReloadCandidate();
		expect(again, "precondition: the held deck takes the poll").toBe(sid);
		await reloadSlidesExternal(again!);
		await drainMicrotasks();
		v.adapter.externalWrite(sidecarPath(sid), good);
		const healed = slidesReloadCandidate();
		expect(healed, "precondition: the deck takes the poll").toBe(sid);
		await reloadSlidesExternal(healed!);
		await drainMicrotasks();

		expect(noticeLog.slice(mark), "a never locked deck's damaged read was told again, or its heal was told").toEqual([DAMAGE_TEXT]);
		expect(deckModel(deck).length, "the deck lost ink at the heal").toBe(2);
	});
});
