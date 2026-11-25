/**
 * A presentation's note renamed, moved or deleted while the presentation is open. Every question the deck asks by its note's path (the duplicate lock, the first stroke's claim, the
 * id route) is asked for the note where it is now; a note that was duplicate-locked when it left its path with no
 * rename (deleted, deleted and made again by a sync, renamed away from Markdown) keeps its presentation held, and only
 * the id route's word for the deck's own note lifts that.
 *
 * Real pieces: the plugin's vault event handlers (onloadVaultEvents: rename and delete), the delete handler's
 * duplicate repair (onFileDeleted), the page id claim (claimNotePageId), the inline duplicate lock and its records,
 * the production Slides host built by startSlidesInk, SlidesDeck input and persistence, and PageStore. Synthetic:
 * FakeAdapter, the vault listing and note metadata from an in-memory text map, the vault events fired by the cell
 * (Obsidian's own order: the file has moved, then "rename"; "delete" while the metadata cache still holds the note),
 * and a reduced presentation DOM. Harness copied from SlidesClearLockKeepsNewerInk.test.ts. Not device acceptance.
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
import { SlidesDeck, pageOfSlide, sectionHashes, setSlidesInk, slidesReloadCandidate, slidesSidecarId } from "./SlidesInkSurface";
import { slidesNoteIdChanged } from "./SlidesPersistence";
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
const MOVED = "Moved/Deck 1.md";
const NOTE = "Talk.md";
const MOVED_NOTE = "Moved/Talk.md";
const SHARED = "shared-deck-id";
const DECK_SOURCE = "slide 0\n\n---\n\nslide 1\n\n---\n\nslide 2";
const sidecarPath = (id: string): string => `.handwriting/${id}.json`;
const DUPLICATE_WORDS = "carry the same handwriting-page-id";
const NOT_SAVED_WORDS = "could not be saved";


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

// ---- a vault whose notes are renamed, deleted and made again, through the plugin's own vault handlers ----

type Plugin = {
	startSlidesInk(): void;
	onloadVaultEvents(): void;
};

type Handler = (...args: unknown[]) => unknown;

const extOf = (p: string): string => p.slice(p.lastIndexOf(".") + 1);
const noteText = (id: string | null): string => (id ? `---\nhandwriting-page-id: ${id}\n---\n${DECK_SOURCE}\n` : `${DECK_SOURCE}\n`);
const tfile = (p: string): TFile =>
	Object.assign(new TFile(), { path: p, extension: extOf(p), basename: p.slice(p.lastIndexOf("/") + 1, p.lastIndexOf(".")) });

function vault(ids: Record<string, string | null>) {
	const adapter = new FakeAdapter();
	adapter.dirs.add(".handwriting");
	const store = new PageStore({ vault: { adapter } } as never);
	const texts = new Map<string, string>(Object.entries(ids).map(([p, id]) => [p, noteText(id)]));
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
	const file = (p: string) => (texts.has(p) && !unlisted.has(p) ? tfile(p) : null);
	const listed = () => [...texts.keys()].filter((p) => !unlisted.has(p)).map((p) => file(p)!);
	let activeFile: string | null = null;
	// A read of a note's text the cell holds open: the deck's first read of its note waits on it.
	let readGate: Promise<void> | null = null;
	noticeLog.length = 0;
	const handlers = new Map<string, Handler[]>();
	const plugin = Object.create(HandwritingPlugin.prototype) as Plugin;
	Object.assign(plugin, {
		store,
		pdfStore: { settle: async () => true, parkedInk: () => false },
		pdfFiles: new Map<unknown, string>(),
		pdfIds: new Map<unknown, string>(),
		pendingRecycle: new Map<string, unknown>(),
		settings: { paperStyle: "lined", cameras: {}, pageOwners: {} },
		settingsDirty: false, settingsTimer: null, settingsWriting: null, settingsWriteAgain: false,
		saveData: async () => {}, flushSettings: async () => {}, persistOwners: () => {},
		manifest: { version: "slides-path-keys-test" },
		pageIdWatchReady: true,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		declaimTimers: new Map<string, number>(),
		declaimedPaths: new Set<string>(),
		resolvingDuplicates: new Set<unknown>(),
		registerEvent: () => undefined,
		register: () => undefined,
		app: {
			vault: {
				adapter,
				getFileByPath: (p: string) => file(p),
				getAbstractFileByPath: (p: string) => file(p),
				getMarkdownFiles: () => listed().filter((f) => f.extension === "md"),
				getFiles: () => listed(),
				cachedRead: async () => {
					if (readGate) await readGate;
					return DECK_SOURCE;
				},
				process: async (f: { path: string }, fn: (data: string) => string) => {
					await Promise.resolve();
					const before = texts.get(f.path);
					if (before === undefined) throw new Error(`no file at ${f.path}`);
					const after = fn(before);
					texts.set(f.path, after);
					return after;
				},
				on: (name: string, fn: Handler) => {
					const list = handlers.get(name) ?? [];
					list.push(fn);
					handlers.set(name, list);
					return { name };
				},
			},
			metadataCache: {
				getCache: (p: string) => cache(p),
				getFileCache: (f: { path: string }) => cache(f.path),
			},
			workspace: { getActiveFile: () => (activeFile ? file(activeFile) : null), iterateAllLeaves: () => {} },
		},
	});
	plugin.onloadVaultEvents();
	const fire = (name: string, ...args: unknown[]): void => {
		for (const fn of handlers.get(name) ?? []) fn(...args);
	};
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
	return {
		adapter, store, texts, idOf,
		/** A Slides ink file for `id` holding one saved stroke per name, on slide 0. Returns its bytes. */
		seed(id: string, strokeIds: string[]): string {
			const sid = slidesSidecarId(id);
			const bytes = serializePage({
				...emptyPage(sid), surface: "slides", coordSpace: "slide-logical", deck: { width: 960, height: 700 },
				slides: sectionHashes(DECK_SOURCE).map((hash, index) => ({ index, hash })),
				strokes: strokeIds.map((s, i) => stroke(s, 100 + i * 40, 100, pageOfSlide(0))),
			} as PageData);
			adapter.externalWrite(sidecarPath(sid), bytes);
			return bytes;
		},
		/** Hold every read of a note's text until the returned function runs. */
		holdReads(): () => void {
			let release = (): void => undefined;
			readGate = new Promise<void>((r) => (release = r));
			return () => {
				readGate = null;
				release();
			};
		},
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
		/** The vault renames or moves a note: the file is at its new path, then the rename event fires. */
		async rename(from: string, to: string): Promise<void> {
			texts.set(to, texts.get(from)!);
			texts.delete(from);
			if (activeFile === from) activeFile = to;
			fire("rename", tfile(to), from);
			await drainMicrotasks();
		},
		/** The vault deletes a note: the delete event fires while the cache still holds it, then the cache drops it. */
		async remove(p: string): Promise<void> {
			unlisted.add(p);
			fire("delete", tfile(p));
			await drainMicrotasks();
			texts.delete(p);
			unlisted.delete(p);
		},
		/** A note made at `p` (a sync's create, or a new note), carrying `id` or no id. */
		make(p: string, id: string | null): void {
			texts.set(p, noteText(id));
		},
		/** Let saves run, close the presentation, and let the close's write and the store's queue finish. */
		async close(): Promise<void> {
			for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(2_000);
			setSlidesInk(false);
			await drainMicrotasks();
			for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(2_000);
			await store.flush();
			await drainMicrotasks();
		},
	};
}

type Vault = ReturnType<typeof vault>;

const PATHS = [ORIG, COPY, MOVED, NOTE, MOVED_NOTE, "Deck 1.mdenc", "Elsewhere/Deck 1.md", "Other.md", "Moved/Other.md"];

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
	setPenToolsMode("hide");
});
afterEach(async () => {
	setSlidesInk(false);
	await drainMicrotasks();
	for (const p of PATHS) inlineInk.handleDelete(p);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	resetPenToolsForTest();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

/** Both notes carry the shared id and both are duplicate-locked, as the census leaves an unresolved pair. */
function lockPair(a: string, b: string): void {
	inlineInk.markDuplicateLocked(a, b);
	inlineInk.markDuplicateLocked(b, a);
}

/** From here on, the stroke ids of every page handed to the store for Slides ink file `sid`, in order. */
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

/** Draw one stroke and return its id: the stroke the deck holds that it did not hold before. */
function drawOne(deck: SlidesDeck, show: ReturnType<typeof presentation>, x = 300): string {
	const before = new Set(deckModel(deck).map((s) => s.id));
	show.draw(x, 300);
	const drawn = deckModel(deck).filter((s) => !before.has(s.id));
	expect(drawn.length, "precondition: the stroke reached the deck").toBe(1);
	return drawn[0]!.id;
}

const deckPath = (deck: SlidesDeck): string | null => (deck as unknown as { path: string | null }).path;
const deckLoaded = (deck: SlidesDeck): boolean => (deck as unknown as { loaded: boolean }).loaded;
const saidDuplicate = (): string[] => noticeLog.filter((m) => m.includes(DUPLICATE_WORDS));
const saidNotSaved = (): string[] => noticeLog.filter((m) => m.includes(NOT_SAVED_WORDS));

describe("a locked copy renamed or moved while its presentation is open stays locked", () => {
	it("a stroke drawn after the rename is not saved, and the close writes nothing to the shared Slides ink file", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const before = v.seed(SHARED, ["orig-saved"]);
		lockPair(ORIG, COPY);
		const { deck, show } = await v.present(COPY);
		expect(deckModel(deck).map((s) => s.id), "precondition: the copy's deck loaded the shared Slides ink").toEqual(["orig-saved"]);
		const saves = slidesSaves(v, sid);
		await v.rename(COPY, MOVED);
		expect(inlineInk.isDuplicateLocked(MOVED), "precondition: the lock moved with the note's record").toBe(true);
		drawOne(deck, show);
		await v.close();
		expect(saves(), "the renamed locked copy's stroke was handed to a save of the shared Slides ink file").toEqual([]);
		expect(v.adapter.files.get(sidecarPath(sid)), "the shared Slides ink file was written").toBe(before);
		expect(saidDuplicate().length, "the deck did not give the lock's notice once").toBe(1);
	});

	it("the lock lifted on the renamed copy saves the ink held while locked, once, through the lift", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		v.seed(SHARED, ["orig-saved"]);
		// The copy alone is locked, as a repair that failed leaves it.
		inlineInk.markDuplicateLocked(COPY, ORIG);
		const { deck, show } = await v.present(COPY);
		const saves = slidesSaves(v, sid);
		await v.rename(COPY, MOVED);
		const held = drawOne(deck, show);
		for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(saves(), "a stroke on the renamed locked copy was saved before the lock lifted").toEqual([]);
		// The original is deleted: the delete handler clears the renamed copy's lock and tells the deck by its path.
		await v.remove(ORIG);
		expect(inlineInk.isDuplicateLocked(MOVED), "precondition: the lock lifted").toBe(false);
		for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		expect(saves(), "the lift did not save the held ink once").toEqual([["orig-saved", held]]);
		expect(onDisk(v.adapter, sid), "the Slides ink file does not hold the held stroke").toEqual(["orig-saved", held]);
	});

	it("a closed deck still draining its load writes nothing after the copy is renamed (B1)", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const before = v.seed(SHARED, ["orig-saved"]);
		lockPair(ORIG, COPY);
		let release = (): void => undefined;
		const gate = new Promise<void>((r) => (release = r));
		const load = v.store.load.bind(v.store);
		vi.spyOn(v.store, "load").mockImplementation(async (id, ...rest) => {
			if (id === sid) await gate;
			return load(id, ...rest);
		});
		const { deck, show } = await v.present(COPY);
		expect(deckLoaded(deck), "precondition: the deck's load is still in flight").toBe(false);
		drawOne(deck, show);
		const saves = slidesSaves(v, sid);
		setSlidesInk(false);
		await drainMicrotasks();
		await v.rename(COPY, MOVED);
		release();
		for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		expect(saves(), "the draining deck handed its page to a save of the shared Slides ink file").toEqual([]);
		expect(v.adapter.files.get(sidecarPath(sid)), "the shared Slides ink file was written").toBe(before);
	});
});

describe("a note with no page id renamed while its presentation is open is claimed where it is now", () => {
	async function claimedAt(v: Vault, path: string, held: string): Promise<void> {
		const id = v.idOf(path);
		expect(id, `the first stroke's claim did not land on ${path}`).toBeTruthy();
		expect(onDisk(v.adapter, slidesSidecarId(id!)), "the stroke is not in the renamed note's Slides ink file").toEqual([held]);
		expect(saidNotSaved(), "the deck said its ink could not be saved").toEqual([]);
	}

	it("nothing at the old name: the stroke is claimed on the renamed note and saved", async () => {
		const v = vault({ [NOTE]: null });
		const { deck, show } = await v.present(NOTE);
		await v.rename(NOTE, MOVED_NOTE);
		const held = drawOne(deck, show);
		await v.close();
		await claimedAt(v, MOVED_NOTE, held);
	});

	it("another note made at the old name: that note is not stamped, and the stroke is claimed on the renamed note", async () => {
		const v = vault({ [NOTE]: null });
		const { deck, show } = await v.present(NOTE);
		await v.rename(NOTE, MOVED_NOTE);
		v.make(NOTE, null);
		const held = drawOne(deck, show);
		await v.close();
		expect(v.idOf(NOTE), "the claim stamped the other note now at the old name").toBeUndefined();
		await claimedAt(v, MOVED_NOTE, held);
	});

	it("renamed during the open's own read of the note: the stroke drawn after is claimed on the renamed note (B2)", async () => {
		const v = vault({ [NOTE]: null });
		const release = v.holdReads();
		const { deck, show } = await v.present(NOTE);
		expect(deckLoaded(deck), "precondition: the open's read is still in flight").toBe(false);
		await v.rename(NOTE, MOVED_NOTE);
		release();
		await drainMicrotasks();
		expect(deckLoaded(deck), "precondition: the open's read landed").toBe(true);
		const held = drawOne(deck, show);
		await v.close();
		await claimedAt(v, MOVED_NOTE, held);
	});

	it("closed while the open's read is in flight, then renamed: the drain claims on the renamed note (B1, B2)", async () => {
		const v = vault({ [NOTE]: null });
		const release = v.holdReads();
		const { deck, show } = await v.present(NOTE);
		expect(deckLoaded(deck), "precondition: the open's read is still in flight").toBe(false);
		const held = drawOne(deck, show);
		setSlidesInk(false);
		await drainMicrotasks();
		await v.rename(NOTE, MOVED_NOTE);
		release();
		for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		await claimedAt(v, MOVED_NOTE, held);
	});
});

describe("note 1: a locked note that leaves its path with no rename keeps its presentation held", () => {
	it("the locked copy deleted, then made again at another path with the same id line: no write in the gap or after (B3 a)", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const before = v.seed(SHARED, ["orig-saved"]);
		lockPair(ORIG, COPY);
		const { deck, show } = await v.present(COPY);
		const saves = slidesSaves(v, sid);
		drawOne(deck, show, 300);
		for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(saves(), "precondition: nothing saved while locked").toEqual([]);
		await v.remove(COPY);
		drawOne(deck, show, 400);
		for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(saves(), "a stroke drawn after the locked copy was deleted was handed to a save").toEqual([]);
		// The sync's create half: the copy back at another path, still carrying the shared id, locked again by the census.
		v.make("Elsewhere/Deck 1.md", SHARED);
		lockPair("Elsewhere/Deck 1.md", ORIG);
		drawOne(deck, show, 500);
		await v.close();
		expect(saves(), "a stroke drawn after the copy came back elsewhere was handed to a save").toEqual([]);
		expect(v.adapter.files.get(sidecarPath(sid)), "the shared Slides ink file was written").toBe(before);
	});

	it("the locked copy renamed away from Markdown: no write (B4)", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const before = v.seed(SHARED, ["orig-saved"]);
		lockPair(ORIG, COPY);
		const { deck, show } = await v.present(COPY);
		const saves = slidesSaves(v, sid);
		await v.rename(COPY, "Deck 1.mdenc");
		drawOne(deck, show);
		await v.close();
		expect(saves(), "a stroke on the copy renamed away from Markdown was handed to a save").toEqual([]);
		expect(v.adapter.files.get(sidecarPath(sid)), "the shared Slides ink file was written").toBe(before);
	});

	it("the original deleted while its own locked deck presents: no write to the id's Slides ink file (the mirror)", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const before = v.seed(SHARED, ["orig-saved"]);
		lockPair(ORIG, COPY);
		const { deck, show } = await v.present(ORIG);
		const saves = slidesSaves(v, sid);
		drawOne(deck, show, 300);
		await v.remove(ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the delete cleared the copy's lock").toBe(false);
		drawOne(deck, show, 400);
		await v.close();
		expect(saves(), "the deleted original's deck handed its page to a save of the copy's Slides ink file").toEqual([]);
		expect(v.adapter.files.get(sidecarPath(sid)), "the copy's Slides ink file was written").toBe(before);
	});
});

describe("pins: what a rename or delete leaves as it is today", () => {
	it("a rename of another note changes nothing in the deck (B6)", async () => {
		const v = vault({ [NOTE]: "talk-id", "Other.md": "other-id" });
		v.seed("talk-id", ["talk-saved"]);
		const { deck, show } = await v.present(NOTE);
		await v.rename("Other.md", "Moved/Other.md");
		expect(deckPath(deck), "the deck left its note's path").toBe(NOTE);
		const held = drawOne(deck, show);
		await v.close();
		expect(onDisk(v.adapter, slidesSidecarId("talk-id"))).toEqual(["talk-saved", held]);
		expect(onDisk(v.adapter, slidesSidecarId("other-id")), "the other note's Slides ink file was made").toBeNull();
	});

	it("an unlocked note with an id, deleted while presenting: the deck saves under that id, and the note made again inside the grace keeps the ink", async () => {
		const v = vault({ [NOTE]: "talk-id" });
		const sid = slidesSidecarId("talk-id");
		v.seed("talk-id", ["talk-saved"]);
		const { deck, show } = await v.present(NOTE);
		await v.remove(NOTE);
		const held = drawOne(deck, show);
		await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		expect(onDisk(v.adapter, sid), "the deck stopped saving under the note's id after the delete").toEqual(["talk-saved", held]);
		v.make(MOVED_NOTE, "talk-id");
		await v.close();
		await vi.advanceTimersByTimeAsync(12_000);
		await drainMicrotasks();
		expect(onDisk(v.adapter, sid), "the note made again lost the ink").toEqual(["talk-saved", held]);
	});

	it("a note with no id, deleted and made again at the same path: the first stroke claims on it", async () => {
		const v = vault({ [NOTE]: null });
		const { deck, show } = await v.present(NOTE);
		await v.remove(NOTE);
		v.make(NOTE, null);
		const held = drawOne(deck, show);
		await v.close();
		const id = v.idOf(NOTE);
		expect(id, "the first stroke's claim refused the note made again").toBeTruthy();
		expect(onDisk(v.adapter, slidesSidecarId(id!))).toEqual([held]);
	});

	it("a locked copy deleted and made again at the same path, then resolved: the id route reaches the deck and saves the held ink under the new id", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const before = v.seed(SHARED, ["orig-saved"]);
		lockPair(ORIG, COPY);
		const { deck, show } = await v.present(COPY);
		const held = drawOne(deck, show);
		await v.remove(COPY);
		v.make(COPY, SHARED);
		lockPair(COPY, ORIG);
		// Resolved: the copy is given a fresh id; its lock lifts and the id route tells the deck by the copy's path.
		v.texts.set(COPY, noteText("fresh-id"));
		inlineInk.clearDuplicateLock(COPY);
		slidesNoteIdChanged(COPY, true, "fresh-id");
		for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		expect(onDisk(v.adapter, slidesSidecarId("fresh-id")), "the held ink did not reach the new id's Slides ink file").toEqual([held]);
		expect(v.adapter.files.get(sidecarPath(sid)), "the shared Slides ink file was written").toBe(before);
	});
});
