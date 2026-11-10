/**
 * A note and its copy that share one page id, with no remembered owner, are
 * read-only for inline ink. Slides on either note must be read-only too, or a
 * stroke drawn on the copy lands in the original's slides ink file.
 *
 * Real pieces: the startup census and duplicate repair (PageIdentity), the
 * inline duplicate lock (inlineInk), the production Slides host built by
 * startSlidesInk, SlidesDeck input and persistence, and PageStore. Synthetic:
 * FakeAdapter, note metadata derived from an in-memory text map, and a reduced
 * presentation DOM (trimmed from SlidesRejectedRead.test.ts). Not device
 * acceptance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin from "./main";
import { inlineInk } from "./inline/InkOverlay";
import type { InlineInkHost } from "./inline/InlineInkStore";
import { PageIdIndex } from "./model/PageIdIndex";
import { parseMarkdownPage } from "./model/MarkdownPage";
import { PageStore } from "./persistence/PageStore";
import { FakeAdapter } from "./persistence/FakeAdapter";
import { SlidesDeck, pageOfSlide, sectionHashes, setSlidesInk, slidesReloadCandidate, slidesSidecarId } from "./slides/SlidesInkSurface";
import { setPenToolsMode, resetPenToolsForTest } from "./inline/PenToolsMode";
import { type InkPoint, type InkStroke, computeBBox } from "./ink/Stroke";
import { emptyPage, parsePage, serializePage } from "./model/PageData";

// Every notice the production Slides host gives (it calls blockNotice).
const noticeLog = vi.hoisted(() => [] as string[]);
vi.mock("./view/Notices", async (original) => ({
	...(await original<typeof import("./view/Notices")>()),
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
	pageIds: PageIdIndex;
	ambiguousIds: Map<string, string[]>;
	settings: { pageOwners: Record<string, string> };
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
	const file = (p: string) => (texts.has(p) ? { path: p, extension: "md", basename: p.slice(0, -3) } : null);
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
		manifest: { version: "slides-duplicate-lock-test" },
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
				getMarkdownFiles: () => [...texts.keys()].map((p) => file(p)!),
				cachedRead: async () => DECK_SOURCE,
				process: async (f: { path: string }, fn: (data: string) => string) => {
					await Promise.resolve();
					const before = texts.get(f.path)!;
					const after = fn(before);
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
		adapter, store, texts, plugin, notices, inlineNotices, idOf,
		/** Seed a slides ink file for `id` with one saved stroke on slide 0. */
		seedSlides(id: string, strokeId: string): string {
			const sid = slidesSidecarId(id);
			const bytes = serializePage({
				...emptyPage(sid), surface: "slides", coordSpace: "slide-logical", deck: { width: 960, height: 700 },
				slides: sectionHashes(DECK_SOURCE).map((hash, index) => ({ index, hash })),
				strokes: [stroke(strokeId, 100, 100, pageOfSlide(0))],
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
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Slides on a note whose copy shares its page id", () => {
	it("a stroke drawn in Slides on the copy does not write the shared slides ink file", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const before = v.seedSlides(SHARED, "orig-saved");
		v.plugin.buildPageIdIndex();
		expect(v.plugin.ambiguousIds.get(SHARED), "precondition: census found no owner").toEqual([ORIG, COPY]);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: inline ink on the copy is locked").toBe(true);
		const inlineNotice = v.inlineNotices.find((m) => m.includes(`"${ORIG}"`));
		expect(inlineNotice, "precondition: inline told the reader once").toBeDefined();

		const { deck, show } = await v.present(COPY);
		expect(deckModel(deck).map((s) => s.id), "rendering unchanged: the saved ink is shown").toEqual(["orig-saved"]);
		show.draw(300, 300);
		show.draw(340, 340);
		expect(deckModel(deck), "the strokes are kept in memory").toHaveLength(3);
		await v.closeAndFlush();

		expect(v.adapter.files.get(sidecarPath(slidesSidecarId(SHARED))), "the copy's stroke reached the original's slides ink file").toBe(before);
		expect(v.notices.filter((m) => m.includes("same handwriting-page-id")), "Slides gives the inline notice text, once").toEqual([inlineNotice]);
	});

	it("control: a note with its own page id still saves from Slides", async () => {
		const v = vault({ [ORIG]: SHARED, ["Other.md"]: "other-id" });
		v.seedSlides(SHARED, "orig-saved");
		v.plugin.buildPageIdIndex();
		expect(inlineInk.isDuplicateLocked(ORIG)).toBe(false);
		const { deck, show } = await v.present(ORIG);
		show.draw(300, 300);
		const local = deckModel(deck).find((s) => s.id !== "orig-saved")!;
		expect(local).toBeDefined();
		await v.closeAndFlush();
		expect(onDisk(v.adapter, slidesSidecarId(SHARED))).toEqual(["orig-saved", local.id]);
		expect(v.notices.filter((m) => m.includes("same handwriting-page-id"))).toEqual([]);
	});

	it("strokes drawn while locked are saved once the lock clears", async () => {
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

		await v.closeAndFlush();
		expect(onDisk(v.adapter, slidesSidecarId(SHARED)), "held stroke was lost").toEqual(["orig-saved", held.id]);
	});

	it("the next stroke after the lock clears saves the held one with it", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const before = v.seedSlides(SHARED, "orig-saved");
		v.plugin.buildPageIdIndex();
		const { deck, show } = await v.present(COPY);
		show.draw(300, 300);
		const held = deckModel(deck).find((s) => s.id !== "orig-saved")!;
		v.texts.delete(ORIG);
		v.plugin.recheckCollision(SHARED);
		expect(v.adapter.files.get(sidecarPath(slidesSidecarId(SHARED))), "precondition: nothing written while locked").toBe(before);

		show.draw(340, 340);
		const next = deckModel(deck).find((s) => s.id !== "orig-saved" && s.id !== held.id)!;
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		expect(onDisk(v.adapter, slidesSidecarId(SHARED)), "the held stroke did not ride the next save").toEqual(["orig-saved", held.id, next.id]);
	});
});
