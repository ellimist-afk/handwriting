/**
 * Slides ink drawn while a note shares its page id with another is held in
 * memory. These cells pin four ways that held ink, or ink drawn around a fix
 * of the shared id, can go to the wrong place or wait too long:
 *
 * - the note is given a fresh id while its presentation is open;
 * - the startup check gives a copy a fresh id while its presentation is open;
 * - the id line is deleted, as the notice says, from the note whose
 *   presentation is open;
 * - the shared id is resolved while the presentation stays open.
 *
 * Each case has a control beside it that shows the same path working when
 * the order of events is the safe one. Real pieces and synthetic pieces are
 * the same as SlidesDuplicateLock.test.ts, whose harness this file copies:
 * the census and duplicate repair (PageIdentity), the inline duplicate lock,
 * the production Slides host built by startSlidesInk, SlidesDeck input and
 * persistence, and PageStore are real; FakeAdapter, note metadata from an
 * in-memory text map, and a reduced presentation DOM are synthetic. Not
 * device acceptance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { parseMarkdownPage } from "../model/MarkdownPage";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter, gate } from "../persistence/FakeAdapter";
import { SlidesDeck, pageOfSlide, sectionHashes, setSlidesInk, slidesReloadCandidate, slidesSidecarId } from "./SlidesInkSurface";
import { setPenToolsMode, resetPenToolsForTest } from "../inline/PenToolsMode";
import { setEraserWholeStrokes } from "../inline/InkOverlayToolState";
import { type InkPoint, type InkStroke, computeBBox } from "../ink/Stroke";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { forkHostFor, listForks, refreshForks, resetForks } from "../persistence/ForkResolution";

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

// ---- a minimal presentation DOM (trimmed from SlidesRejectedRead.test.ts) ----

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
function presentation(sections = 3) {
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
		/** The pen's eraser end (buttons 32) scrubbed down through (x, y0) to (x, y1), screen px. */
		erase(x: number, y0: number, y1: number) {
			const pts = Array.from({ length: 12 }, (_, i) => [x, y0 + ((y1 - y0) * i) / 11] as const);
			reveal.dispatch(ev("pointerdown", pts[0]![0], pts[0]![1], 0.5, 33));
			for (const [px, py] of pts.slice(1)) reveal.dispatch(ev("pointermove", px, py, 0.5, 33));
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

// ---- a vault with two notes and the real plugin methods ----

type Plugin = {
	startSlidesInk(): void;
	finishPersistence(): Promise<void>;
	buildPageIdIndex(): void;
	checkPageIdentity(path: string): void;
	recheckCollision(id: string): void;
	resolveDuplicate(copyPath: string, id: string, ownerPath: string): Promise<void>;
	onFileDeleted(file: TFile): Promise<void>;
	pageIds: PageIdIndex;
	ambiguousIds: Map<string, string[]>;
	settings: { pageOwners: Record<string, string> };
};

/**
 * `cacheLags`: the metadata cache answers with a note's text from before a
 * `vault.process` write until a later timer tick, as Obsidian's cache is
 * rebuilt after the modify event. Without it the cache is always current.
 */
function vault(ids: Record<string, string>, opts: { cacheLags?: boolean } = {}) {
	const adapter = new FakeAdapter();
	adapter.dirs.add(".handwriting");
	const store = new PageStore({ vault: { adapter } } as never);
	const texts = new Map<string, string>(Object.entries(ids).map(([p, id]) => [p, `---\nhandwriting-page-id: ${id}\n---\n${DECK_SOURCE}\n`]));
	const idIn = (t: string | undefined): string | undefined =>
		t === undefined ? undefined : (parseMarkdownPage(t).pageId ?? undefined);
	const idOf = (p: string): string | undefined => idIn(texts.get(p));
	// Text the cache still serves for a note written through `process`, until its refresh tick.
	const behind = new Map<string, string>();
	const cache = (p: string) => {
		if (!texts.has(p)) return null;
		const id = behind.has(p) ? idIn(behind.get(p)) : idOf(p);
		return { frontmatter: id ? { "handwriting-page-id": id } : {}, sections: [{ type: "yaml" }, { type: "paragraph" }] };
	};
	// Obsidian's delete event fires while the metadata cache still holds the deleted note's frontmatter; the vault
	// listing no longer has the file. A path in `unlisted` is that note: gone from the vault, still in the cache.
	const unlisted = new Set<string>();
	const file = (p: string) => (texts.has(p) && !unlisted.has(p) ? { path: p, extension: "md", basename: p.slice(0, -3) } : null);
	let activeFile: string | null = null;
	noticeLog.length = 0;
	const notices = noticeLog;
	const inlineNotices: string[] = [];
	const plugin = Object.create(HandwritingPlugin.prototype) as Plugin;
	Object.assign(plugin, {
		store,
		pdfStore: { settle: async () => true, parkedInk: () => false },
		settings: { paperStyle: "lined", cameras: {}, pageOwners: {} },
		settingsDirty: false, settingsTimer: null, settingsWriting: null, settingsWriteAgain: false,
		saveData: async () => {}, flushSettings: async () => {}, persistOwners: () => {},
		manifest: { version: "slides-held-ink-test" },
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
				cachedRead: async () => DECK_SOURCE,
				process: async (f: { path: string }, fn: (data: string) => string) => {
					await Promise.resolve();
					const before = texts.get(f.path)!;
					const after = fn(before);
					if (opts.cacheLags && !behind.has(f.path)) {
						behind.set(f.path, before);
						setTimeout(() => behind.delete(f.path), 1);
					}
					texts.set(f.path, after);
					return after;
				},
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
		notify: (m: string) => void inlineNotices.push(m),
	} as unknown as InlineInkHost;
	inlineInk.attachHost(inlineHost);
	vi.spyOn(console, "info").mockImplementation(() => undefined);
	return {
		adapter, store, texts, unlisted, plugin, notices, inlineNotices, idOf,
		/** Seed a slides ink file for `id` with one saved stroke on slide 0, plus any `more`. */
		seedSlides(id: string, strokeId: string, more: InkStroke[] = []): string {
			const sid = slidesSidecarId(id);
			const bytes = serializePage({
				...emptyPage(sid), surface: "slides", coordSpace: "slide-logical", deck: { width: 960, height: 700 },
				slides: sectionHashes(DECK_SOURCE).map((hash, index) => ({ index, hash })),
				strokes: [stroke(strokeId, 100, 100, pageOfSlide(0)), ...more],
			});
			adapter.externalWrite(sidecarPath(sid), bytes);
			return bytes;
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
		async closeAndFlush(): Promise<void> {
			for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
			setSlidesInk(false);
			const done = plugin.finishPersistence();
			for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
			await done;
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
	for (const p of [ORIG, COPY, "Other.md"]) inlineInk.handleDelete(p);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	resetPenToolsForTest();
	setEraserWholeStrokes(true);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

/** The copy also carries inline ink, so the repair clones its slides ink file too. */
function giveInlineInk(v: ReturnType<typeof vault>, id: string): void {
	const inline = emptyPage(id);
	inline.surface = "inline";
	const { page: _page, ...inlineStroke } = stroke("inline-saved", 10, 10, 0);
	inline.strokes = [inlineStroke as InkStroke];
	v.adapter.externalWrite(sidecarPath(id), serializePage(inline));
}

/** The note's id line is deleted by hand, and the identity check has settled. */
async function deleteIdLine(v: ReturnType<typeof vault>, path: string): Promise<void> {
	v.texts.set(path, `${DECK_SOURCE}\n`);
	v.plugin.checkPageIdentity(path);
	for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(2_000);
	await drainMicrotasks();
}

/**
 * Both notes have been open, so inline ink holds a record with the shared id
 * for each. Without one, deleting the id line has no record to drop, and the
 * copy's lock stays on.
 */
async function openBothInline(): Promise<void> {
	await inlineInk.ensureLoaded(ORIG);
	await inlineInk.ensureLoaded(COPY);
	await drainMicrotasks();
	expect(inlineInk.pageIdOf(COPY), "precondition: the copy's inline record holds the shared id").toBe(SHARED);
	expect(inlineInk.pageIdOf(ORIG), "precondition: the original's inline record holds the shared id").toBe(SHARED);
}

describe("a note given a fresh id while its presentation is open", () => {
	it("a stroke drawn after the fresh id does not write the original's slides ink", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED }, { cacheLags: true });
		const before = v.seedSlides(SHARED, "orig-saved");
		giveInlineInk(v, SHARED);
		// The original is known; the copy appeared during the session.
		v.plugin.pageIds.register(ORIG, SHARED);
		const { deck, show } = await v.present(COPY);
		expect(deckModel(deck).map((s) => s.id)).toEqual(["orig-saved"]);

		await v.plugin.resolveDuplicate(COPY, SHARED, ORIG);
		await drainMicrotasks();
		const fresh = v.idOf(COPY)!;
		expect(fresh, "precondition: the copy has a fresh id").toBeTruthy();
		expect(fresh).not.toBe(SHARED);
		expect(onDisk(v.adapter, slidesSidecarId(fresh)), "precondition: the slides ink was cloned").toEqual(["orig-saved"]);

		show.draw(300, 300);
		const local = deckModel(deck).find((s) => s.id !== "orig-saved")!;
		await v.closeAndFlush();
		expect(v.adapter.files.get(sidecarPath(slidesSidecarId(SHARED))), "the copy's stroke reached the original's slides ink file").toBe(before);
		expect(onDisk(v.adapter, slidesSidecarId(fresh)), "the copy's stroke was not saved under its new id").toEqual(["orig-saved", local.id]);
	});

	it("control: a presentation opened after the fresh id saves under the new id", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const before = v.seedSlides(SHARED, "orig-saved");
		giveInlineInk(v, SHARED);
		v.plugin.pageIds.register(ORIG, SHARED);
		await v.plugin.resolveDuplicate(COPY, SHARED, ORIG);
		await drainMicrotasks();
		const fresh = v.idOf(COPY)!;
		expect(fresh, "precondition: the copy has a fresh id").toBeTruthy();
		expect(fresh).not.toBe(SHARED);

		const { deck, show } = await v.present(COPY);
		show.draw(300, 300);
		const local = deckModel(deck).find((s) => s.id !== "orig-saved")!;
		expect(local).toBeDefined();
		await v.closeAndFlush();
		expect(v.adapter.files.get(sidecarPath(slidesSidecarId(SHARED))), "the copy's stroke reached the original's slides ink file").toBe(before);
		expect(onDisk(v.adapter, slidesSidecarId(fresh))).toEqual(["orig-saved", local.id]);
	});
});

describe("a presentation open on a copy before the startup check", () => {
	it("a stroke drawn after the startup check gives the copy a fresh id does not write the original's slides ink", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED }, { cacheLags: true });
		const before = v.seedSlides(SHARED, "orig-saved");
		// The original is remembered as the owner from an earlier session.
		v.plugin.settings.pageOwners = { [SHARED]: ORIG };
		const { deck, show } = await v.present(COPY);
		expect(deckModel(deck).map((s) => s.id)).toEqual(["orig-saved"]);

		v.plugin.buildPageIdIndex();
		for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(2_000);
		await drainMicrotasks();
		const fresh = v.idOf(COPY)!;
		expect(fresh, "precondition: the startup check gave the copy a fresh id").toBeTruthy();
		expect(fresh).not.toBe(SHARED);
		expect(v.idOf(ORIG), "precondition: the original keeps the id").toBe(SHARED);

		show.draw(300, 300);
		const local = deckModel(deck).find((s) => s.id !== "orig-saved")!;
		expect(local, "precondition: the stroke is on the deck").toBeDefined();
		await v.closeAndFlush();
		expect(v.adapter.files.get(sidecarPath(slidesSidecarId(SHARED))), "the copy's stroke reached the original's slides ink file").toBe(before);
		expect(onDisk(v.adapter, slidesSidecarId(fresh)), "the copy's stroke was not saved under its new id").toEqual(["orig-saved", local.id]);
	});
});

describe("the notice's hand fix, deleting the id line", () => {
	it("deleting the id line from the note whose presentation is open does not send its held stroke to the other note's slides ink", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const before = v.seedSlides(SHARED, "orig-saved");
		v.plugin.buildPageIdIndex();
		await openBothInline();
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
		const { deck, show } = await v.present(COPY);
		show.draw(300, 300);
		const held = deckModel(deck).find((s) => s.id !== "orig-saved")!;
		expect(held, "precondition: the stroke is held in memory").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(v.adapter.files.get(sidecarPath(slidesSidecarId(SHARED))), "precondition: nothing written while locked").toBe(before);

		await deleteIdLine(v, COPY);
		// The line is gone; the held stroke may already have claimed a fresh one.
		expect(v.idOf(COPY), "precondition: the copy no longer carries the shared id").not.toBe(SHARED);
		expect(v.plugin.ambiguousIds.has(SHARED), "precondition: the original now owns the id alone").toBe(false);

		await v.closeAndFlush();
		expect(v.adapter.files.get(sidecarPath(slidesSidecarId(SHARED))), "the copy's held stroke reached the original's slides ink file").toBe(before);
		const fresh = v.idOf(COPY);
		expect(fresh, "the copy's held stroke was not given a fresh id").toBeTruthy();
		expect(fresh).not.toBe(SHARED);
		expect(onDisk(v.adapter, slidesSidecarId(fresh!)), "only the deck's own stroke reaches the fresh id").toEqual([held.id]);
	});

	it("control: deleting the id line from the other note lets the open presentation save its held stroke under the id", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const before = v.seedSlides(SHARED, "orig-saved");
		v.plugin.buildPageIdIndex();
		await openBothInline();
		const { deck, show } = await v.present(COPY);
		show.draw(300, 300);
		const held = deckModel(deck).find((s) => s.id !== "orig-saved")!;
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(v.adapter.files.get(sidecarPath(slidesSidecarId(SHARED))), "precondition: nothing written while locked").toBe(before);

		await deleteIdLine(v, ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the lock cleared").toBe(false);

		await v.closeAndFlush();
		expect(onDisk(v.adapter, slidesSidecarId(SHARED)), "held stroke was lost").toEqual(["orig-saved", held.id]);
	});
});

describe("held Slides ink when the shared id is resolved with the presentation open", () => {
	it("the held stroke is saved when the lock clears, without another stroke or a close", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const before = v.seedSlides(SHARED, "orig-saved");
		v.plugin.buildPageIdIndex();
		const { deck, show } = await v.present(COPY);
		show.draw(300, 300);
		const held = deckModel(deck).find((s) => s.id !== "orig-saved")!;
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(v.adapter.files.get(sidecarPath(slidesSidecarId(SHARED))), "precondition: nothing written while locked").toBe(before);

		// The original is deleted: the copy is the only carrier left and owns the id.
		v.texts.delete(ORIG);
		v.plugin.recheckCollision(SHARED);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the lock cleared").toBe(false);

		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		expect(onDisk(v.adapter, slidesSidecarId(SHARED)), "the held stroke waited for another stroke or a close").toEqual(["orig-saved", held.id]);
	});

	it("the held stroke is saved when the original is deleted, without another stroke or a close", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const before = v.seedSlides(SHARED, "orig-saved");
		v.plugin.buildPageIdIndex();
		const { deck, show } = await v.present(COPY);
		show.draw(300, 300);
		const held = deckModel(deck).find((s) => s.id !== "orig-saved")!;
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(v.adapter.files.get(sidecarPath(slidesSidecarId(SHARED))), "precondition: nothing written while locked").toBe(before);

		// The original is deleted through the plugin's delete handler: the copy survives and owns the id. The handler
		// runs while the cache still holds the original's frontmatter, then the cache drops it.
		v.unlisted.add(ORIG);
		await v.plugin.onFileDeleted(Object.assign(new TFile(), { path: ORIG, extension: "md", basename: "Deck" }));
		v.texts.delete(ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the lock cleared").toBe(false);

		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		expect(onDisk(v.adapter, slidesSidecarId(SHARED)), "the held stroke waited for another stroke or a close").toEqual(["orig-saved", held.id]);
	});

	it("a held erase, whole and partial, is saved when the lock clears, without another stroke or a close", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		// A long stored stroke across slide 0 at y 400, slide x 100..340, so a partial erase at its middle leaves two pieces.
		const points: InkPoint[] = Array.from({ length: 61 }, (_, i) => ({ x: 100 + i * 4, y: 400, pressure: 0.5, t: i * 8 }));
		const long: InkStroke = { id: "long-saved", tool: "pen", color: "#1e2a3b", width: 2.2, points, bbox: computeBBox(points, 4.4), createdAt: createdAt++, page: pageOfSlide(0) };
		const before = v.seedSlides(SHARED, "orig-saved", [long]);
		v.plugin.buildPageIdIndex();
		const { deck, show } = await v.present(COPY);
		expect(deckModel(deck).map((s) => s.id).sort(), "precondition: the copy's deck shows both stored strokes").toEqual(["long-saved", "orig-saved"]);

		// The slide sits at screen (20, 25), half size: slide (x, y) is screen (20 + x / 2, 25 + y / 2).
		setEraserWholeStrokes(true);
		show.erase(74, 70, 86); // through "orig-saved", slide (100..116, 100..111)
		setEraserWholeStrokes(false);
		show.erase(130, 215, 235); // across "long-saved" at slide x 220
		const left = deckModel(deck);
		expect(left.some((s) => s.id === "orig-saved"), "precondition: the whole erase took the stroke off the deck").toBe(false);
		expect(left.some((s) => s.id === "long-saved"), "precondition: the partial erase cut the long stroke").toBe(false);
		expect(left.length, "precondition: the partial erase left two pieces").toBe(2);
		const pieces = left.map((s) => s.id).sort();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(v.adapter.files.get(sidecarPath(slidesSidecarId(SHARED))), "precondition: nothing written while locked").toBe(before);

		// The original is deleted: the copy is the only carrier left and owns the id.
		v.texts.delete(ORIG);
		v.plugin.recheckCollision(SHARED);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the lock cleared").toBe(false);

		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		expect(onDisk(v.adapter, slidesSidecarId(SHARED))?.sort(), "the held erase waited for another stroke or a close").toEqual(pieces);
	});

	it("control: the held stroke lands in the id's slides ink at close", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		v.seedSlides(SHARED, "orig-saved");
		v.plugin.buildPageIdIndex();
		const { deck, show } = await v.present(COPY);
		show.draw(300, 300);
		const held = deckModel(deck).find((s) => s.id !== "orig-saved")!;
		v.texts.delete(ORIG);
		v.plugin.recheckCollision(SHARED);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the lock cleared").toBe(false);

		await v.closeAndFlush();
		expect(onDisk(v.adapter, slidesSidecarId(SHARED)), "held stroke was lost").toEqual(["orig-saved", held.id]);
	});
});

/**
 * The note's id value is edited, here or by the other device through sync,
 * and the identity check follows it after the grace. The note's inline ink
 * already moves to the new id (EditedIdFollowed.test.ts); its Slides ink must
 * move the same way, or the presentation opens without the ink drawn here.
 */
describe("a note's edited id is followed by its Slides ink", () => {
	const OWN = "own-deck-id";
	const EDITED = "edited-deck-id";

	/** FakeAdapter has no folder listing; the fork scan needs one. */
	function listing(fake: FakeAdapter): FakeAdapter {
		return Object.assign(Object.create(fake) as FakeAdapter, {
			async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
				const prefix = dir.endsWith("/") ? dir : dir + "/";
				return { files: [...fake.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")), folders: [] };
			},
		});
	}

	/** The note's id value is changed to `id`, and the identity check and its grace have run. */
	async function editId(v: ReturnType<typeof vault>, path: string, id: string): Promise<void> {
		v.texts.set(path, `---\nhandwriting-page-id: ${id}\n---\n${DECK_SOURCE}\n`);
		v.plugin.checkPageIdentity(path);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await drainMicrotasks();
	}

	/** One note under OWN with inline ink and Slides ink, open in inline ink here. */
	async function ownNote() {
		const v = vault({ [ORIG]: OWN });
		v.seedSlides(OWN, "drawn-here");
		giveInlineInk(v, OWN);
		v.plugin.buildPageIdIndex();
		await inlineInk.ensureLoaded(ORIG);
		await drainMicrotasks();
		expect(inlineInk.pageIdOf(ORIG), "precondition: the note is open under its own id").toBe(OWN);
		return v;
	}

	afterEach(() => resetForks());

	it("with the presentation closed, the Slides ink drawn here is under the new id", async () => {
		const v = await ownNote();
		await editId(v, ORIG, EDITED);
		await v.store.flush();
		expect(inlineInk.pageIdOf(ORIG), "precondition: the note followed its new id").toBe(EDITED);
		expect(onDisk(v.adapter, slidesSidecarId(EDITED)), "the Slides ink stayed under the old id").toEqual(["drawn-here"]);
		expect(v.adapter.files.has(sidecarPath(slidesSidecarId(OWN))), "the old Slides file stayed where nothing names it").toBe(false);
	});

	it("when the new id already has Slides ink, the ink drawn here is listed beside it by fix ink de-sync", async () => {
		const v = await ownNote();
		v.seedSlides(EDITED, "drawn-there");
		await editId(v, ORIG, EDITED);
		await v.store.flush();
		expect(inlineInk.pageIdOf(ORIG), "precondition: the note followed its new id").toBe(EDITED);
		expect(onDisk(v.adapter, slidesSidecarId(EDITED)), "the other device's Slides ink was written over").toEqual(["drawn-there"]);
		const host = forkHostFor({ adapter: listing(v.adapter), store: v.store } as never);
		resetForks();
		await refreshForks(host, ".handwriting");
		const rec = listForks().find((f) => f.pageId === slidesSidecarId(EDITED));
		expect(rec, "the Slides ink drawn here sits in a file nothing lists").toBeDefined();
		expect(parsePage(v.adapter.files.get(rec!.incomingPath)!, slidesSidecarId(EDITED)).data.strokes.map((s) => s.id)).toEqual(["drawn-here"]);
	});

	it("with the presentation open, a stroke drawn after the change is saved under the new id", async () => {
		const v = await ownNote();
		const { deck, show } = await v.present(ORIG);
		expect(deckModel(deck).map((s) => s.id), "precondition: the deck shows the saved Slides ink").toEqual(["drawn-here"]);
		await editId(v, ORIG, EDITED);
		expect(inlineInk.pageIdOf(ORIG), "precondition: the note followed its new id").toBe(EDITED);
		show.draw(300, 300);
		const local = deckModel(deck).find((s) => s.id !== "drawn-here")!;
		expect(local, "precondition: the stroke is on the deck").toBeDefined();
		await v.closeAndFlush();
		expect(onDisk(v.adapter, slidesSidecarId(EDITED)) ?? [], "the stroke drawn after the change went to a file the note does not name").toEqual(["drawn-here", local.id]);
		expect(v.adapter.files.has(sidecarPath(slidesSidecarId(OWN))), "the deck kept writing the old id's Slides file").toBe(false);
	});

	it("control: a duplicate-locked copy that edits its id leaves the shared Slides file as it was", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const before = v.seedSlides(SHARED, "orig-saved");
		v.plugin.buildPageIdIndex();
		await openBothInline();
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
		await editId(v, COPY, EDITED);
		await v.store.flush();
		expect(inlineInk.pageIdOf(COPY), "precondition: the copy followed its new id").toBe(EDITED);
		expect(v.adapter.files.get(sidecarPath(slidesSidecarId(SHARED))), "the original's Slides ink was moved or rewritten").toBe(before);
		expect(v.adapter.files.has(sidecarPath(slidesSidecarId(EDITED))), "the original's Slides ink was copied to the copy's new id").toBe(false);
	});

	it("with the presentation open on a duplicate-locked copy, an edited id takes only the ink drawn here, under the new id", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const before = v.seedSlides(SHARED, "orig-saved");
		v.plugin.buildPageIdIndex();
		await openBothInline();
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
		const { deck, show } = await v.present(COPY);
		expect(deckModel(deck).map((s) => s.id), "precondition: the deck shows the shared Slides ink").toEqual(["orig-saved"]);
		show.draw(300, 300);
		const first = deckModel(deck).find((s) => s.id !== "orig-saved");
		expect(first, "precondition: the stroke is on the deck").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(v.adapter.files.get(sidecarPath(slidesSidecarId(SHARED))), "precondition: nothing written while locked").toBe(before);

		await editId(v, COPY, EDITED);
		expect(inlineInk.pageIdOf(COPY), "precondition: the copy followed its new id").toBe(EDITED);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the lock went with the old id").toBe(false);
		show.draw(200, 200);
		const second = deckModel(deck).find((s) => s.id !== "orig-saved" && s.id !== first!.id);
		expect(second, "precondition: the second stroke is on the deck").toBeDefined();
		await v.closeAndFlush();
		expect(v.adapter.files.get(sidecarPath(slidesSidecarId(SHARED))), "the copy's deck wrote into the original's Slides ink").toBe(before);
		expect(onDisk(v.adapter, slidesSidecarId(EDITED))?.sort() ?? [], "the copy's Slides ink under the new id is not the ink drawn here").toEqual([first!.id, second!.id].sort());
	});

	// ---- bug 63: the open deck keeps the old id's strokes; bug 66 part 1: a part-done move waits for a text edit ----

	/** Every stroke id under `id`: its live file, then each copy fix ink de-sync lists beside it. */
	async function underIdOrListed(v: ReturnType<typeof vault>, id: string): Promise<string[]> {
		await v.store.flush();
		const host = forkHostFor({ adapter: listing(v.adapter), store: v.store } as never);
		resetForks();
		await refreshForks(host, ".handwriting");
		const listed = listForks()
			.filter((f) => f.pageId === id)
			.flatMap((f) => parsePage(v.adapter.files.get(f.incomingPath)!, id).data.strokes.map((s) => s.id));
		return [...(onDisk(v.adapter, id) ?? []), ...listed];
	}

	/** Writes to `path` wait until `release`; `waiting` says one is held. */
	function holdWritesTo(fake: FakeAdapter, path: string) {
		const g = gate();
		let waiting = 0;
		const write = fake.write.bind(fake);
		vi.spyOn(fake, "write").mockImplementation(async (p: string, d: string) => {
			if (p === path || p.startsWith(`${path.slice(0, -".json".length)}+from-`)) {
				waiting++;
				await g.promise;
			}
			return write(p, d);
		});
		return { release: g.release, waiting: () => waiting };
	}

	function inlineStroke(id: string): InkStroke {
		const { page: _page, ...s } = stroke(id, 40, 40, 0);
		return s as InkStroke;
	}

	it("63a: when the new id already has Slides ink, the open deck drops the old id's strokes and its next save keeps them out of the new id's file", async () => {
		const v = await ownNote();
		v.seedSlides(EDITED, "drawn-there");
		const { deck, show } = await v.present(ORIG);
		expect(deckModel(deck).map((s) => s.id), "precondition: the deck shows the saved Slides ink").toEqual(["drawn-here"]);
		await editId(v, ORIG, EDITED);
		expect(inlineInk.pageIdOf(ORIG), "precondition: the note followed its new id").toBe(EDITED);
		show.draw(300, 300);
		const local = deckModel(deck).find((s) => s.id !== "drawn-here" && s.id !== "drawn-there");
		expect(local, "precondition: the stroke is on the deck").toBeDefined();
		await v.closeAndFlush();
		expect(onDisk(v.adapter, slidesSidecarId(EDITED))?.sort() ?? [], "the set-aside ink went live in the new id's Slides file").toEqual(["drawn-there", local!.id].sort());
		const listed = (await underIdOrListed(v, slidesSidecarId(EDITED))).filter((s) => s === "drawn-here");
		expect(listed, "the old id's Slides ink is not in the copy listed beside the new id, once").toEqual(["drawn-here"]);
	});

	it("63b: when the old id passes to another note before the edit settles, the open deck does not copy that note's Slides ink to the new id", async () => {
		const v = await ownNote();
		const theirs = v.adapter.files.get(sidecarPath(slidesSidecarId(OWN)));
		v.seedSlides(EDITED, "drawn-there");
		const { deck, show } = await v.present(ORIG);
		expect(deckModel(deck).map((s) => s.id), "precondition: the deck shows the old id's Slides ink").toEqual(["drawn-here"]);
		v.texts.set(ORIG, `---\nhandwriting-page-id: ${EDITED}\n---\n${DECK_SOURCE}\n`);
		v.plugin.checkPageIdentity(ORIG);
		// Before the edit settles, the old id passes to another note.
		v.plugin.pageIds.transfer(OWN, "Other.md");
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await drainMicrotasks();
		expect(inlineInk.pageIdOf(ORIG), "precondition: the note followed its new id").toBe(EDITED);
		show.draw(300, 300);
		const local = deckModel(deck).find((s) => s.id !== "drawn-here" && s.id !== "drawn-there");
		expect(local, "precondition: the stroke is on the deck").toBeDefined();
		await v.closeAndFlush();
		expect(v.adapter.files.get(sidecarPath(slidesSidecarId(OWN))), "the other note's Slides file was moved or rewritten").toBe(theirs);
		expect(onDisk(v.adapter, slidesSidecarId(EDITED))?.sort() ?? [], "the other note's Slides ink was copied to this note's new id").toEqual(["drawn-there", local!.id].sort());
	});

	it("keep: with the presentation open and no Slides file under the new id, a stroke drawn before the change can still be undone after it", async () => {
		const v = await ownNote();
		const { deck, show } = await v.present(ORIG);
		show.draw(300, 300);
		const before = deckModel(deck).find((s) => s.id !== "drawn-here");
		expect(before, "precondition: the stroke is on the deck").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(onDisk(v.adapter, slidesSidecarId(OWN))?.sort(), "precondition: the stroke is saved under the old id").toEqual(["drawn-here", before!.id].sort());
		await editId(v, ORIG, EDITED);
		expect(inlineInk.pageIdOf(ORIG), "precondition: the note followed its new id").toBe(EDITED);
		expect(deckModel(deck).map((s) => s.id).sort(), "the deck's own Slides ink left the screen").toEqual(["drawn-here", before!.id].sort());
		expect(deck.status().undoLabel, "the deck forgot what undo takes back").not.toBeNull();
		expect(deck.run("undo"), "undo did nothing after the change").toBe(true);
		expect(deckModel(deck).map((s) => s.id), "undo did not take back the stroke drawn before the change").toEqual(["drawn-here"]);
		await v.closeAndFlush();
		expect(onDisk(v.adapter, slidesSidecarId(EDITED)) ?? [], "the undo was not saved under the new id").toEqual(["drawn-here"]);
	});

	it("66-inline: a note stroke queued while the inline file moves is under the new id or listed beside it, with no further text edit", async () => {
		const v = await ownNote();
		const hold = holdWritesTo(v.adapter, sidecarPath(EDITED));
		v.texts.set(ORIG, `---\nhandwriting-page-id: ${EDITED}\n---\n${DECK_SOURCE}\n`);
		v.plugin.checkPageIdentity(ORIG);
		await vi.advanceTimersByTimeAsync(5_000);
		await drainMicrotasks();
		expect(hold.waiting(), "precondition: the inline file's move is under way").toBe(1);
		inlineInk.commit(ORIG, inlineStroke("drawn-in-the-move"));
		await vi.advanceTimersByTimeAsync(2_000);
		hold.release();
		// No text edit from here on: only timers run.
		for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2_000);
		await drainMicrotasks();
		expect(await underIdOrListed(v, EDITED), "the stroke drawn during the move sits where nothing names or lists it").toContain("drawn-in-the-move");
		expect(inlineInk.pageIdOf(ORIG), "the note stayed on the old id after a part-done move").toBe(EDITED);
	});

	it("66-slides: a deck stroke queued while the Slides file moves is under the new id or listed beside it, with no further text edit", async () => {
		const v = await ownNote();
		const { deck, show } = await v.present(ORIG);
		expect(deckModel(deck).map((s) => s.id), "precondition: the deck shows the saved Slides ink").toEqual(["drawn-here"]);
		const hold = holdWritesTo(v.adapter, sidecarPath(slidesSidecarId(EDITED)));
		v.texts.set(ORIG, `---\nhandwriting-page-id: ${EDITED}\n---\n${DECK_SOURCE}\n`);
		v.plugin.checkPageIdentity(ORIG);
		await vi.advanceTimersByTimeAsync(5_000);
		await drainMicrotasks();
		expect(hold.waiting(), "precondition: the Slides file's move is under way").toBe(1);
		show.draw(300, 300);
		const local = deckModel(deck).find((s) => s.id !== "drawn-here");
		expect(local, "precondition: the stroke is on the deck").toBeDefined();
		await vi.advanceTimersByTimeAsync(2_000);
		hold.release();
		// No text edit from here on: only timers run.
		for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2_000);
		await drainMicrotasks();
		expect(deckModel(deck).map((s) => s.id), "the stroke drawn during the move left the open deck").toContain(local!.id);
		expect(onDisk(v.adapter, slidesSidecarId(EDITED)) ?? [], "the new id's live Slides file lacks the stroke drawn during the move").toContain(local!.id);
		const followed = inlineInk.pageIdOf(ORIG);
		await v.closeAndFlush();
		expect(await underIdOrListed(v, slidesSidecarId(EDITED)), "the deck stroke drawn during the move sits where nothing names or lists it").toContain(local!.id);
		expect(followed, "the note stayed on the old id after a part-done move").toBe(EDITED);
	});

	it("63c: a deck stroke saved before the edit stays out of the new id's live Slides file when the old file is set aside", async () => {
		const v = await ownNote();
		v.seedSlides(EDITED, "drawn-there");
		const { deck, show } = await v.present(ORIG);
		show.draw(300, 300);
		const before = deckModel(deck).find((s) => s.id !== "drawn-here");
		expect(before, "precondition: the stroke is on the deck").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(onDisk(v.adapter, slidesSidecarId(OWN))?.sort(), "precondition: the stroke is saved under the old id").toEqual(["drawn-here", before!.id].sort());
		await editId(v, ORIG, EDITED);
		expect(inlineInk.pageIdOf(ORIG), "precondition: the note followed its new id").toBe(EDITED);
		await v.closeAndFlush();
		expect(onDisk(v.adapter, slidesSidecarId(EDITED)) ?? [], "the stroke saved under the old id went live in the new id's Slides file").not.toContain(before!.id);
		expect(await underIdOrListed(v, slidesSidecarId(EDITED)), "the stroke saved under the old id is not in the copy listed beside the new id").toContain(before!.id);
	});

	it("66-cap: a queue that will not write is retried a few times, not every grace for the session, and the next identity check still follows", async () => {
		const v = await ownNote();
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		inlineInk.commit(ORIG, inlineStroke("queued-under-old"));
		v.adapter.failWriteTimes = 1_000_000;
		v.texts.set(ORIG, `---\nhandwriting-page-id: ${EDITED}\n---\n${DECK_SOURCE}\n`);
		v.plugin.checkPageIdentity(ORIG);
		for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(2_000);
		await drainMicrotasks();
		const rounds = errors.mock.calls.filter((c) => String(c[0]).includes("could not move the old id's ink")).length;
		expect(inlineInk.pageIdOf(ORIG), "precondition: the queue held the note on the old id").toBe(OWN);
		expect(rounds, "the part-done move was not retried on a timer").toBeGreaterThan(1);
		expect(rounds, "the part-done move is retried every grace, without end").toBeLessThanOrEqual(4);
		v.adapter.failWriteTimes = 0;
		v.plugin.checkPageIdentity(ORIG);
		for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2_000);
		await drainMicrotasks();
		expect(inlineInk.pageIdOf(ORIG), "the next identity check did not follow the new id").toBe(EDITED);
		expect(await underIdOrListed(v, EDITED), "the queued stroke sits where nothing names or lists it").toContain("queued-under-old");
	});

	it("owner-moved: when the old id passes to another note during the move, that note's Slides file stays where it is", async () => {
		const v = await ownNote();
		const theirs = v.adapter.files.get(sidecarPath(slidesSidecarId(OWN)));
		const hold = holdWritesTo(v.adapter, sidecarPath(EDITED));
		v.texts.set(ORIG, `---\nhandwriting-page-id: ${EDITED}\n---\n${DECK_SOURCE}\n`);
		v.plugin.checkPageIdentity(ORIG);
		await vi.advanceTimersByTimeAsync(5_000);
		await drainMicrotasks();
		expect(hold.waiting(), "precondition: the inline file's move is under way").toBe(1);
		// While the inline file moves, the old id passes to another note.
		v.plugin.pageIds.transfer(OWN, "Other.md");
		hold.release();
		for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2_000);
		await drainMicrotasks();
		await v.store.flush();
		expect(v.adapter.files.get(sidecarPath(slidesSidecarId(OWN))), "the other note's Slides file was moved to this note's new id").toBe(theirs);
		expect(v.adapter.files.has(sidecarPath(slidesSidecarId(EDITED))), "the other note's Slides ink was copied to this note's new id").toBe(false);
		expect(inlineInk.pageIdOf(ORIG), "the note did not follow its new id").toBe(EDITED);
	});

	// ---- a note stroke lifted while the Slides file moves ----

	it("a note stroke lifted while the Slides file moves is under the new id or listed beside it, with no further text edit", async () => {
		const v = await ownNote();
		const hold = holdWritesTo(v.adapter, sidecarPath(slidesSidecarId(EDITED)));
		v.texts.set(ORIG, `---\nhandwriting-page-id: ${EDITED}\n---\n${DECK_SOURCE}\n`);
		v.plugin.checkPageIdentity(ORIG);
		await vi.advanceTimersByTimeAsync(5_000);
		await drainMicrotasks();
		expect(hold.waiting(), "precondition: the Slides file's move is under way").toBe(1);
		inlineInk.commit(ORIG, inlineStroke("drawn-in-slides-move"));
		await vi.advanceTimersByTimeAsync(2_000);
		hold.release();
		// No text edit from here on: only timers run.
		for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2_000);
		await drainMicrotasks();
		expect(await underIdOrListed(v, EDITED), "the note stroke lifted during the Slides move sits where nothing names or lists it").toContain("drawn-in-slides-move");
		expect(inlineInk.pageIdOf(ORIG), "the note stayed on the old id after a part-done move").toBe(EDITED);
	});

	it("a note stroke lifted 300 ms before the Slides file's move ends, still queued, is under the new id or listed beside it, with no further text edit", async () => {
		const v = await ownNote();
		const hold = holdWritesTo(v.adapter, sidecarPath(slidesSidecarId(EDITED)));
		v.texts.set(ORIG, `---\nhandwriting-page-id: ${EDITED}\n---\n${DECK_SOURCE}\n`);
		v.plugin.checkPageIdentity(ORIG);
		await vi.advanceTimersByTimeAsync(5_000);
		await drainMicrotasks();
		expect(hold.waiting(), "precondition: the Slides file's move is under way").toBe(1);
		inlineInk.commit(ORIG, inlineStroke("drawn-in-slides-move"));
		await vi.advanceTimersByTimeAsync(300);
		hold.release();
		// No text edit from here on: only timers run.
		for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2_000);
		await drainMicrotasks();
		expect(await underIdOrListed(v, EDITED), "the note stroke lifted during the Slides move sits where nothing names or lists it").toContain("drawn-in-slides-move");
		expect(inlineInk.pageIdOf(ORIG), "the note stayed on the old id after a part-done move").toBe(EDITED);
	});

	// ---- an erase while the open deck reads the new id's Slides file ----

	/**
	 * The note open in a presentation whose Slides file holds "drawn-here" on slide 0 and a long stroke across it at
	 * slide y 400, with the id edited and the deck's read of the new id's Slides file held until `release`.
	 */
	async function followReadHeld() {
		const v = await ownNote();
		const points: InkPoint[] = Array.from({ length: 61 }, (_, i) => ({ x: 100 + i * 4, y: 400, pressure: 0.5, t: i * 8 }));
		const long: InkStroke = { id: "long-saved", tool: "pen", color: "#1e2a3b", width: 2.2, points, bbox: computeBBox(points, 4.4), createdAt: createdAt++, page: pageOfSlide(0) };
		v.seedSlides(OWN, "drawn-here", [long]);
		const { deck, show } = await v.present(ORIG);
		expect(deckModel(deck).map((s) => s.id).sort(), "precondition: the deck shows both saved strokes").toEqual(["drawn-here", "long-saved"]);
		const g = gate();
		let waiting = 0;
		const host = deck.host;
		const load = host.loadSidecar.bind(host);
		vi.spyOn(host, "loadSidecar").mockImplementation(async (sid: string) => {
			if (sid === slidesSidecarId(EDITED)) {
				waiting++;
				await g.promise;
			}
			return load(sid);
		});
		v.texts.set(ORIG, `---\nhandwriting-page-id: ${EDITED}\n---\n${DECK_SOURCE}\n`);
		v.plugin.checkPageIdentity(ORIG);
		await vi.advanceTimersByTimeAsync(5_000);
		await drainMicrotasks();
		expect(waiting, "precondition: the deck's read of the new id's Slides file is under way").toBe(1);
		expect(onDisk(v.adapter, slidesSidecarId(EDITED))?.sort(), "precondition: the old Slides file became the new id's live file").toEqual(["drawn-here", "long-saved"]);
		return {
			v, deck, show,
			async release(): Promise<void> {
				g.release();
				for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(2_000);
				await drainMicrotasks();
			},
		};
	}

	function snapshotIds(deck: SlidesDeck): string[] {
		return (deck.snapshot()?.strokes ?? []).map((s) => s.id).sort();
	}

	it("a stroke erased while the deck reads the new id's Slides file stays erased, on screen and saved", async () => {
		const { v, deck, show, release } = await followReadHeld();
		setEraserWholeStrokes(true);
		show.erase(74, 70, 86); // through "drawn-here", slide (100..116, 100..111)
		expect(deckModel(deck).map((s) => s.id), "precondition: the whole erase took the stroke off the deck").toEqual(["long-saved"]);
		await release();
		expect(deckModel(deck).map((s) => s.id), "the erased stroke came back on screen when the read landed").toEqual(["long-saved"]);
		expect(snapshotIds(deck), "the deck's snapshot holds the erased stroke").toEqual(["long-saved"]);
		await v.closeAndFlush();
		expect(onDisk(v.adapter, slidesSidecarId(EDITED)) ?? [], "the erased stroke was saved under the new id").toEqual(["long-saved"]);
	});

	it("a stroke cut while the deck reads the new id's Slides file keeps only its pieces, on screen and saved", async () => {
		const { v, deck, show, release } = await followReadHeld();
		setEraserWholeStrokes(false);
		show.erase(130, 215, 235); // across "long-saved" at slide x 220
		const left = deckModel(deck).map((s) => s.id);
		expect(left, "precondition: the partial erase cut the long stroke").not.toContain("long-saved");
		const pieces = left.filter((id) => id !== "drawn-here").sort();
		expect(pieces.length, "precondition: the partial erase left two pieces").toBe(2);
		const want = ["drawn-here", ...pieces].sort();
		await release();
		expect(deckModel(deck).map((s) => s.id).sort(), "the cut stroke came back whole beside its pieces when the read landed").toEqual(want);
		expect(snapshotIds(deck), "the deck's snapshot holds the cut stroke whole").toEqual(want);
		await v.closeAndFlush();
		expect(onDisk(v.adapter, slidesSidecarId(EDITED))?.sort() ?? [], "the cut stroke was saved whole under the new id").toEqual(want);
	});
});
