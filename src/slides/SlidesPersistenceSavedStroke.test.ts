/**
 * A Slides stroke this deck drew and saved, then missing from the file a later read finds. Road A:
 * the copy's deck saved c before its duplicate lock; the owner, which never read c, saved its own page; the lock lifts
 * and the deck reads the file. Road B: a deck never locked saved c; another device's page without c syncs in and the
 * poll reads it.
 *
 * The harness is SlidesClearLockKeepsNewerInk.test.ts's, copied (trimmed): the delete handler, the inline duplicate
 * lock, the production Slides host built by startSlidesInk, SlidesDeck input and persistence, and PageStore are real;
 * FakeAdapter, note metadata from an in-memory text map, and a reduced presentation DOM are synthetic. The owner's and
 * the other device's pages are written straight to the store or the adapter. Not device acceptance.
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
import { slidesLockLifted, slidesNoteIdChanged, slidesNoteLeft } from "./SlidesPersistence";
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

type Vault = ReturnType<typeof vault>;

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

/** The other note's eraser cuts `s` at (cx, cy), slide units, as its own deck would: real pieces, ids `<prefix>-1`, ... */
function ownerCut(s: InkStroke, cx: number, cy: number, r: number, prefix: string): InkStroke[] {
	let n = 0;
	const pieces = splitStrokeByCircle(s, cx, cy, r, () => `${prefix}-${++n}`);
	expect(pieces.length, `precondition: the other note's eraser cut ${s.id} in two`).toBe(2);
	return pieces;
}

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

/** The presentation is closed; teardown and anything it waits on settle, and the store writes. */
async function closeDeck(v: Vault, deck: SlidesDeck): Promise<void> {
	deck.dispose();
	await Promise.all(deck.inFlightWork());
	for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
	await v.store.flush();
	await drainMicrotasks();
}

// ---- a Slides stroke this deck drew and saved, missing from the file a later read finds ----

/** F runs along y 200 from x 40 to 260; X crosses it at x 150 (as in SlidesClearLockKeepsNewerInk.test.ts). */
const fileF = () => line("file-f", 40, 200, 260, 200);
const fileX = () => line("file-x", 150, 120, 150, 280);

/** The ids of the recovery copies kept beside the Slides ink file, outgoing and incoming. */
function recoveryCopies(adapter: FakeAdapter, sid: string): { outgoing: string[]; incoming: string[] } {
	const kept = [...adapter.files.keys()].filter((p) => p.startsWith(`.handwriting/${sid}.conflict-`));
	return {
		outgoing: kept.filter((p) => p.endsWith("-outgoing.json")),
		incoming: kept.filter((p) => p.endsWith("-incoming.json")),
	};
}

function idsIn(adapter: FakeAdapter, path: string): string[] {
	const parsed = parsePage(adapter.files.get(path)!, "recovery");
	expect(parsed.damaged, `${path} did not parse`).toBeFalsy();
	return parsed.data.strokes.map((s) => s.id);
}

/**
 * The file holds F and X; the copy's deck opens on it unlocked, draws c, and that save lands. Then the copy alone is
 * locked. Returns the deck and c.
 */
async function savedThenLocked(v: Vault, sid: string) {
	const f = fileF(), x = fileX();
	v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [f, x])));
	const { deck, show } = await v.present(COPY);
	expect(deckModel(deck).map((s) => s.id), "precondition: the copy's deck loaded the file").toEqual(["file-f", "file-x"]);
	show.draw(300, 300);
	const c = deckModel(deck).find((s) => !s.id.startsWith("file-"));
	expect(c, "precondition: c drawn on the copy's deck").toBeDefined();
	for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
	await v.store.flush();
	await drainMicrotasks();
	expect(onDisk(v.adapter, sid), "precondition: c reached the file").toEqual(["file-f", "file-x", c!.id]);
	inlineInk.markDuplicateLocked(COPY, ORIG);
	expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
	return { deck, show, f, x, c: c! };
}

/** The owner, which never read c, saves its own page. */
async function ownerSaves(v: Vault, sid: string, strokes: InkStroke[]): Promise<void> {
	await v.store.saveNow(sid, v.slidesPage(SHARED, strokes), v.plugin.slidesWriter!);
	expect(onDisk(v.adapter, sid), "precondition: the owner's page is the file").toEqual(strokes.map((s) => s.id));
}

/** `s` moved by (dx, dy), every point by the same offset: what a move of it would save. */
function shifted(s: InkStroke, dx: number, dy: number): InkStroke {
	const points = s.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
	return { ...s, points, bbox: computeBBox(points, s.width * 2) };
}

describe("the lift: a stroke the copy drew and saved before its lock, missing from the owner's later page, is kept at the lift's read", () => {
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

	it("the owner saves its own page with a newer stroke: c is kept once, on top, on the deck and in the file", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, f, x, c } = await savedThenLocked(v, sid);
		await ownerSaves(v, sid, [f, x, line("orig-later", 400, 100, 500, 150)]);

		await deleteOriginal(v);

		const want = ["file-f", "file-x", "orig-later", c.id];
		expect(deckModel(deck).map((s) => s.id), "the lift's read took c, a stroke the copy saved, off the deck").toEqual(want);
		expect(onDisk(v.adapter, sid), "the lift's save left c, a stroke the copy saved, out of the file").toEqual(want);
	});

	it("after the lift's read lands, another device erases c whole and a poll reads it: the erase lands", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, f, x, c } = await savedThenLocked(v, sid);
		const later = line("orig-later", 400, 100, 500, 150);
		await ownerSaves(v, sid, [f, x, later]);
		await deleteOriginal(v);
		expect(onDisk(v.adapter, sid), "precondition: the lift kept c").toEqual(["file-f", "file-x", "orig-later", c.id]);

		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [f, x, later])));
		const polled = slidesReloadCandidate();
		expect(polled, "precondition: the deck takes the poll").toBe(sid);
		await reloadSlidesExternal(polled!);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();

		const want = ["file-f", "file-x", "orig-later"];
		expect(deckModel(deck).map((s) => s.id), "a read after the lift's kept c against another device's whole erase, on the deck").toEqual(want);
		expect(onDisk(v.adapter, sid), "a read after the lift's kept c against another device's whole erase, in the file").toEqual(want);
	});

	it("the locked copy leaves its path and comes back there unlocked; the id route's word ends the held leave: the lift's read keeps c once", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, f, x, c } = await savedThenLocked(v, sid);
		const later = line("orig-later", 400, 100, 500, 150);
		await ownerSaves(v, sid, [f, x, later]);
		// A sync's delete half on the locked copy: the deck holds as locked. Its create half: the copy back at the same
		// path with the same id, its inline record gone, so no lock stands on it and the lift sends no lock word.
		slidesNoteLeft(COPY);
		inlineInk.handleDelete(COPY);
		for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		expect(onDisk(v.adapter, sid), "precondition: the held deck wrote nothing").toEqual(["file-f", "file-x", "orig-later"]);

		await deleteOriginal(v);

		const want = ["file-f", "file-x", "orig-later", c.id];
		expect(deckModel(deck).map((s) => s.id), "the read after the held leave ended took c, a stroke the copy saved, off the deck").toEqual(want);
		expect(onDisk(v.adapter, sid), "the save after the held leave ended left c out of the file").toEqual(want);
	});

	it("the owner erased X whole and never read c: X's erase lands, c is kept", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, f, c } = await savedThenLocked(v, sid);
		await ownerSaves(v, sid, [f, line("orig-later", 400, 100, 500, 150)]);

		await deleteOriginal(v);

		const want = ["file-f", "orig-later", c.id];
		expect(deckModel(deck).map((s) => s.id), "X came back, or c was taken off the deck").toEqual(want);
		expect(onDisk(v.adapter, sid), "X came back, or c was left out of the file").toEqual(want);
	});

	it("the lift's read throws and a later poll reads the file: c is kept and saved then", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, f, x, c } = await savedThenLocked(v, sid);
		await ownerSaves(v, sid, [f, x, line("orig-later", 400, 100, 500, 150)]);
		const reads = throwingReads(v, sid);

		await deleteOriginal(v);
		expect(reads.count, "precondition: the lift's read was made and threw").toBeGreaterThan(0);
		reads.on = false;
		const polled = slidesReloadCandidate();
		expect(polled, "precondition: the held deck takes the poll").toBe(sid);
		await reloadSlidesExternal(polled!);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();

		const want = ["file-f", "file-x", "orig-later", c.id];
		expect(deckModel(deck).map((s) => s.id), "the poll that stood in for the lift's read took c off the deck").toEqual(want);
		expect(onDisk(v.adapter, sid), "the poll that stood in for the lift's read left c out of the file").toEqual(want);
	});

	it("the lift's read throws and the deck is closed before a poll: the close's read lands, and c is kept and saved", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, f, x, c } = await savedThenLocked(v, sid);
		await ownerSaves(v, sid, [f, x, line("orig-later", 400, 100, 500, 150)]);
		const reads = throwingReads(v, sid);

		await deleteOriginal(v);
		expect(reads.count, "precondition: the lift's read was made and threw").toBeGreaterThan(0);
		reads.on = false;
		await closeDeck(v, deck);

		expect(onDisk(v.adapter, sid), "the close left c, a stroke the copy saved, out of the file").toEqual(["file-f", "file-x", "orig-later", c.id]);
	});

	it("guard: the owner's page holds a stroke of a piece of c's shape but of another time: not a piece of c, so c is kept", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, f, x, c } = await savedThenLocked(v, sid);
		const [half] = splitStrokeByCircle(c, c.points[c.points.length - 1]!.x, c.points[c.points.length - 1]!.y, 4, () => "orig-twin");
		expect(half, "precondition: a piece of c's shape").toBeDefined();
		const twin = { ...half!, createdAt: c.createdAt + 1 };
		await ownerSaves(v, sid, [f, x, twin]);

		await deleteOriginal(v);

		const want = ["file-f", "file-x", "orig-twin", c.id];
		expect(deckModel(deck).map((s) => s.id), "a same-shaped stroke of another time counted as a piece of c").toEqual(want);
		expect(onDisk(v.adapter, sid), "a same-shaped stroke of another time counted as a piece of c, in the file").toEqual(want);
	});

	it("pin: the owner cut c while locked: the owner's pieces stand once, and c is not drawn beside them", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, f, x, c } = await savedThenLocked(v, sid);
		const mid = c.points[Math.floor(c.points.length / 2)]!;
		const own = ownerCut(c, mid.x, mid.y, 4, "own-c");
		await ownerSaves(v, sid, [f, x, ...own]);

		await deleteOriginal(v);

		const want = ["file-f", "file-x", ...own.map((s) => s.id)];
		expect(deckModel(deck).map((s) => s.id), "c drawn beside the owner's pieces of it").toEqual(want);
		expect(onDisk(v.adapter, sid), "c saved beside the owner's pieces of it").toEqual(want);
	});

	it("pin: the owner cut c and moved one piece: a moved piece is still a piece, and c is not drawn beside them", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, f, x, c } = await savedThenLocked(v, sid);
		const mid = c.points[Math.floor(c.points.length / 2)]!;
		const own = ownerCut(c, mid.x, mid.y, 4, "own-c");
		const moved = [shifted(own[0]!, 37, -21), own[1]!];
		await ownerSaves(v, sid, [f, x, ...moved]);

		await deleteOriginal(v);

		const want = ["file-f", "file-x", ...moved.map((s) => s.id)];
		expect(deckModel(deck).map((s) => s.id), "c drawn beside the owner's moved piece of it").toEqual(want);
		expect(onDisk(v.adapter, sid), "c saved beside the owner's moved piece of it").toEqual(want);
	});

	/**
	 * The file holds F and X; the copy's deck opens on it unlocked, its eraser cuts F in two, and that save lands. Then
	 * the copy alone is locked, and the owner, which never read the cut, saves its own page with F whole. Returns the
	 * deck and the copy's pieces of F, in the deck's order.
	 */
	async function cutThenLocked(v: Vault, sid: string) {
		const f = fileF(), x = fileX();
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [f, x])));
		const { deck, show } = await v.present(COPY);
		eraseAt(show, 200, 200);
		await vi.advanceTimersByTimeAsync(50);
		const pieces = deckModel(deck).filter((s) => !s.id.startsWith("file-"));
		expect(pieces.length, "precondition: the copy's eraser cut F in two").toBe(2);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		expect(onDisk(v.adapter, sid), "precondition: the copy's cut reached the file").toEqual([...pieces.map((s) => s.id), "file-x"]);
		inlineInk.markDuplicateLocked(COPY, ORIG);
		await ownerSaves(v, sid, [f, x, line("orig-later", 400, 100, 500, 150)]);
		return { deck, pieces: pieces.map((s) => s.id) };
	}

	it("the copy cut F and saved before its lock; the owner's page holds F whole: the copy's pieces stay where F sat, once, and F does not come back", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, pieces } = await cutThenLocked(v, sid);

		await deleteOriginal(v);

		const want = [...pieces, "file-x", "orig-later"];
		expect(deckModel(deck).map((s) => s.id), "the copy's saved pieces of F were taken off the deck, or F came back").toEqual(want);
		expect(onDisk(v.adapter, sid), "the copy's saved pieces of F were left out of the file, or F came back").toEqual(want);
	});

	it("the copy cut F and saved before its lock; the owner's older page is read again before the lift's save lands: the pieces still once, F still out", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, pieces } = await cutThenLocked(v, sid);
		const older = ["file-f", "file-x", "orig-later"];
		// What the file held at each of the deck's reads.
		const seen: Array<string[] | null> = [];
		const adopt = deck.adoptSidecar.bind(deck);
		vi.spyOn(deck, "adoptSidecar").mockImplementation((...args: Parameters<SlidesDeck["adoptSidecar"]>) => {
			seen.push(onDisk(v.adapter, sid));
			return adopt(...args);
		});

		// The lift, and its read, with no time passing: the save it schedules has not landed.
		v.unlisted.add(ORIG);
		await v.plugin.onFileDeleted(Object.assign(new TFile(), { path: ORIG, extension: "md", basename: "Deck" }));
		v.texts.delete(ORIG);
		inlineInk.handleDelete(ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the lock cleared").toBe(false);
		await drainMicrotasks();
		// The id route says the same word again: the deck reads the file again.
		slidesNoteIdChanged(COPY);
		await drainMicrotasks();
		expect(seen.length, "precondition: the deck read the file twice after the lift").toBeGreaterThanOrEqual(2);
		expect(seen, "precondition: each read found the owner's older page, not the lift's save").toEqual(seen.map(() => older));
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();

		const want = [...pieces, "file-x", "orig-later"];
		expect(deckModel(deck).map((s) => s.id), "a second read of the older page took the copy's pieces off the deck, drew them twice, or brought F back").toEqual(want);
		expect(onDisk(v.adapter, sid), "a second read of the older page left the copy's pieces out of the file, saved them twice, or brought F back").toEqual(want);
	});

	it("a poll's read throws, then the lock comes and the owner saves its page; the poll's retry lands under the lock: at the lift c is kept once, and no recovery copy is written", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const f = fileF(), x = fileX();
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [f, x])));
		const { deck, show } = await v.present(COPY);
		show.draw(300, 300);
		const c = deckModel(deck).find((s) => !s.id.startsWith("file-"));
		expect(c, "precondition: c drawn on the copy's deck").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		expect(onDisk(v.adapter, sid), "precondition: c reached the file").toEqual(["file-f", "file-x", c!.id]);
		const reads = throwingReads(v, sid);
		const polled = slidesReloadCandidate();
		expect(polled, "precondition: the deck takes the poll").toBe(sid);
		await reloadSlidesExternal(polled!);
		expect(reads.count, "precondition: the poll's read was made and threw").toBeGreaterThan(0);
		reads.on = false;
		inlineInk.markDuplicateLocked(COPY, ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
		await ownerSaves(v, sid, [f, x, line("orig-later", 400, 100, 500, 150)]);

		const retry = slidesReloadCandidate();
		expect(retry, "precondition: the held, locked deck takes the retry poll").toBe(sid);
		await reloadSlidesExternal(retry!);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		expect(recoveryCopies(v.adapter, sid), "recovery copies written while the deck was locked").toEqual({ outgoing: [], incoming: [] });

		await deleteOriginal(v);

		const want = ["file-f", "file-x", "orig-later", c!.id];
		expect(deckModel(deck).map((s) => s.id), "the retry under the lock took c, a stroke the copy saved, off the deck").toEqual(want);
		expect(onDisk(v.adapter, sid), "the retry under the lock left c, a stroke the copy saved, out of the file").toEqual(want);
		expect(recoveryCopies(v.adapter, sid), "the lift wrote recovery copies").toEqual({ outgoing: [], incoming: [] });
	});

	// A known limit, kept as an expected failure: a piece of two points has no inner point to fix the move's offset, so
	// the lift's read cannot tell it is a piece of c, and c is kept beside it. Goes red the day that is told apart.
	it.fails("known limit: the owner cut c down to one piece of two points and moved it: c is drawn beside it", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, f, x, c } = await savedThenLocked(v, sid);
		// The eraser at c's last point, wide enough to take every sample but the first: one piece, its first sample and
		// a point on the ring.
		const end = c.points[c.points.length - 1]!;
		let piece: InkStroke | undefined;
		for (let r = 1; r < 400 && !piece; r += 0.5) {
			const cut = splitStrokeByCircle(c, end.x, end.y, r, () => "own-c-1");
			if (cut.length === 1 && cut[0]!.points.length === 2) piece = cut[0];
		}
		expect(piece, "precondition: a cut that leaves one piece of two points").toBeDefined();
		const moved = shifted(piece!, 37, -21);
		await ownerSaves(v, sid, [f, x, moved]);

		await deleteOriginal(v);

		const want = ["file-f", "file-x", moved.id];
		expect(deckModel(deck).map((s) => s.id), "c drawn beside the owner's moved two-point piece of it").toEqual(want);
		expect(onDisk(v.adapter, sid), "c saved beside the owner's moved two-point piece of it").toEqual(want);
	});

	it("pin: the owner cut c, erased one piece and moved the other: the moved piece alone is still a piece, and c is not drawn beside it", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, f, x, c } = await savedThenLocked(v, sid);
		const mid = c.points[Math.floor(c.points.length / 2)]!;
		const own = ownerCut(c, mid.x, mid.y, 4, "own-c");
		const kept = own.find((s) => s.points.length > 2);
		expect(kept, "precondition: a piece of more than two points").toBeDefined();
		const moved = shifted(kept!, 37, -21);
		await ownerSaves(v, sid, [f, x, moved]);

		await deleteOriginal(v);

		const want = ["file-f", "file-x", moved.id];
		expect(deckModel(deck).map((s) => s.id), "c drawn beside the owner's moved piece of it").toEqual(want);
		expect(onDisk(v.adapter, sid), "c saved beside the owner's moved piece of it").toEqual(want);
	});

	describe("the copy's own cut or erase of a stroke it drew and saved, then the lift", () => {
		/** The store's writes land. */
		async function settle(v: Vault): Promise<void> {
			for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
			await v.store.flush();
			await drainMicrotasks();
		}

		/** The file holds F and X; the copy's deck opens on it unlocked, draws c, and that save lands. */
		async function drawnUnlocked(v: Vault, sid: string) {
			const f = fileF(), x = fileX();
			v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [f, x])));
			const { deck, show } = await v.present(COPY);
			show.draw(300, 300);
			const c = deckModel(deck).find((s) => !s.id.startsWith("file-"));
			expect(c, "precondition: c drawn on the copy's deck").toBeDefined();
			await settle(v);
			expect(onDisk(v.adapter, sid), "precondition: c reached the file").toEqual(["file-f", "file-x", c!.id]);
			return { deck, show, f, x, c: c! };
		}

		/**
		 * The copy's own eraser at c's middle, through the deck's pointer path: c cut in two, or taken whole when `whole`.
		 * Returns the ids of the pieces on the deck, in the deck's order.
		 */
		async function copyErases(show: { doc: FakeDoc }, deck: SlidesDeck, c: InkStroke, whole: boolean): Promise<string[]> {
			setEraserWholeStrokes(whole);
			const mid = c.points[Math.floor(c.points.length / 2)]!;
			eraseAt(show, mid.x, mid.y);
			await vi.advanceTimersByTimeAsync(50);
			const ids = deckModel(deck).map((s) => s.id);
			expect(ids.includes(c.id), "precondition: c left the copy's deck").toBe(false);
			const pieces = ids.filter((id) => !id.startsWith("file-"));
			expect(pieces.length, whole ? "precondition: the copy's eraser took c whole" : "precondition: the copy's eraser cut c in two").toBe(whole ? 0 : 2);
			return pieces;
		}

		it("the copy cut c and saved before its lock; the owner's page holds c whole: the copy's pieces stay once where c sat, and c does not come back", async () => {
			const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
			const sid = slidesSidecarId(SHARED);
			const { deck, show, f, x, c } = await drawnUnlocked(v, sid);
			const pieces = await copyErases(show, deck, c, false);
			await settle(v);
			expect(onDisk(v.adapter, sid), "precondition: the copy's cut reached the file").toEqual(["file-f", "file-x", ...pieces]);
			inlineInk.markDuplicateLocked(COPY, ORIG);
			await ownerSaves(v, sid, [f, x, c]);

			await deleteOriginal(v);

			const want = ["file-f", "file-x", ...pieces];
			expect(deckModel(deck).map((s) => s.id), "c came back on the deck beside the copy's own pieces of it, or the pieces left").toEqual(want);
			expect(onDisk(v.adapter, sid), "c came back in the file beside the copy's own pieces of it, or the pieces left").toEqual(want);
		});

		it("the copy erased c whole and saved before its lock; the owner's page holds c: c does not come back", async () => {
			const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
			const sid = slidesSidecarId(SHARED);
			const { deck, show, f, x, c } = await drawnUnlocked(v, sid);
			await copyErases(show, deck, c, true);
			await settle(v);
			expect(onDisk(v.adapter, sid), "precondition: the copy's erase reached the file").toEqual(["file-f", "file-x"]);
			inlineInk.markDuplicateLocked(COPY, ORIG);
			await ownerSaves(v, sid, [f, x, c]);

			await deleteOriginal(v);

			const want = ["file-f", "file-x"];
			expect(deckModel(deck).map((s) => s.id), "the copy's own erase of c was undone on the deck").toEqual(want);
			expect(onDisk(v.adapter, sid), "the copy's own erase of c was undone in the file").toEqual(want);
		});

		it("the copy cut c while locked; the owner's page holds c whole and a newer stroke: at the lift the copy's pieces stay once where c sat, and c does not come back", async () => {
			const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
			const sid = slidesSidecarId(SHARED);
			const { deck, show, f, x, c } = await drawnUnlocked(v, sid);
			inlineInk.markDuplicateLocked(COPY, ORIG);
			expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
			const pieces = await copyErases(show, deck, c, false);
			await settle(v);
			expect(onDisk(v.adapter, sid), "precondition: the locked copy wrote nothing").toEqual(["file-f", "file-x", c.id]);
			await ownerSaves(v, sid, [f, x, c, line("orig-later", 400, 100, 500, 150)]);

			await deleteOriginal(v);

			const want = ["file-f", "file-x", ...pieces, "orig-later"];
			expect(deckModel(deck).map((s) => s.id), "c came back on the deck beside the pieces the locked copy cut, or the pieces left or moved").toEqual(want);
			expect(onDisk(v.adapter, sid), "c came back in the file beside the pieces the locked copy cut, or the pieces left or moved").toEqual(want);
		});

		it("the copy cut c and saved before its lock; the owner's page with c whole is read again before the lift's save lands: the pieces still once, c still out", async () => {
			const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
			const sid = slidesSidecarId(SHARED);
			const { deck, show, f, x, c } = await drawnUnlocked(v, sid);
			const pieces = await copyErases(show, deck, c, false);
			await settle(v);
			expect(onDisk(v.adapter, sid), "precondition: the copy's cut reached the file").toEqual(["file-f", "file-x", ...pieces]);
			inlineInk.markDuplicateLocked(COPY, ORIG);
			await ownerSaves(v, sid, [f, x, c]);
			const older = ["file-f", "file-x", c.id];
			// What the file held at each of the deck's reads.
			const seen: Array<string[] | null> = [];
			const adopt = deck.adoptSidecar.bind(deck);
			vi.spyOn(deck, "adoptSidecar").mockImplementation((...args: Parameters<SlidesDeck["adoptSidecar"]>) => {
				seen.push(onDisk(v.adapter, sid));
				return adopt(...args);
			});

			// The lift, and its read, with no time passing: the save it schedules has not landed.
			v.unlisted.add(ORIG);
			await v.plugin.onFileDeleted(Object.assign(new TFile(), { path: ORIG, extension: "md", basename: "Deck" }));
			v.texts.delete(ORIG);
			inlineInk.handleDelete(ORIG);
			expect(inlineInk.isDuplicateLocked(COPY), "precondition: the lock cleared").toBe(false);
			await drainMicrotasks();
			// The id route says the same word again: the deck reads the file again.
			slidesNoteIdChanged(COPY);
			await drainMicrotasks();
			expect(seen.length, "precondition: the deck read the file twice after the lift").toBeGreaterThanOrEqual(2);
			expect(seen, "precondition: each read found the owner's older page, not the lift's save").toEqual(seen.map(() => older));
			await settle(v);

			const want = ["file-f", "file-x", ...pieces];
			expect(deckModel(deck).map((s) => s.id), "a read of the owner's older page brought c back beside the copy's pieces, or the pieces left").toEqual(want);
			expect(onDisk(v.adapter, sid), "a read of the owner's older page brought c back into the file beside the copy's pieces, or the pieces left").toEqual(want);
		});

		it("guard: the copy saved c and another device's whole erase of c landed at a poll; the owner's page holds c at the lift: a read took c off the deck, not the copy's eraser, so c comes back", async () => {
			const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
			const sid = slidesSidecarId(SHARED);
			const { deck, f, x, c } = await drawnUnlocked(v, sid);
			v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [f, x])));
			const polled = slidesReloadCandidate();
			expect(polled, "precondition: the deck takes the poll").toBe(sid);
			await reloadSlidesExternal(polled!);
			await settle(v);
			expect(deckModel(deck).map((s) => s.id), "precondition: the other device's erase of c landed on the deck").toEqual(["file-f", "file-x"]);
			expect(onDisk(v.adapter, sid), "precondition: the other device's erase of c is the file").toEqual(["file-f", "file-x"]);
			inlineInk.markDuplicateLocked(COPY, ORIG);
			await ownerSaves(v, sid, [f, x, c]);

			await deleteOriginal(v);

			const want = ["file-f", "file-x", c.id];
			expect(deckModel(deck).map((s) => s.id), "c, taken off the deck by a read and back in the file, was left off the deck").toEqual(want);
			expect(onDisk(v.adapter, sid), "c, taken off the deck by a read and back in the file, was deleted from the file").toEqual(want);
		});

		it("the copy erased c whole while locked; the owner's page holds c and a newer stroke: at the lift c does not come back", async () => {
			const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
			const sid = slidesSidecarId(SHARED);
			const { deck, show, f, x, c } = await drawnUnlocked(v, sid);
			inlineInk.markDuplicateLocked(COPY, ORIG);
			expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
			await copyErases(show, deck, c, true);
			await settle(v);
			expect(onDisk(v.adapter, sid), "precondition: the locked copy wrote nothing").toEqual(["file-f", "file-x", c.id]);
			await ownerSaves(v, sid, [f, x, c, line("orig-later", 400, 100, 500, 150)]);

			await deleteOriginal(v);

			const want = ["file-f", "file-x", "orig-later"];
			expect(deckModel(deck).map((s) => s.id), "the locked copy's erase of c was undone on the deck").toEqual(want);
			expect(onDisk(v.adapter, sid), "the locked copy's erase of c was undone in the file").toEqual(want);
		});

		it("guard: the copy saved c; while locked a poll's retry read the owner's cut of c and c left the deck; the owner's page holds c whole again at the lift: c comes back once, and no piece", async () => {
			const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
			const sid = slidesSidecarId(SHARED);
			const { deck, f, x, c } = await drawnUnlocked(v, sid);
			const reads = throwingReads(v, sid);
			const polled = slidesReloadCandidate();
			expect(polled, "precondition: the deck takes the poll").toBe(sid);
			await reloadSlidesExternal(polled!);
			expect(reads.count, "precondition: the poll's read was made and threw").toBeGreaterThan(0);
			reads.on = false;
			inlineInk.markDuplicateLocked(COPY, ORIG);
			expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
			const mid = c.points[Math.floor(c.points.length / 2)]!;
			const own = ownerCut(c, mid.x, mid.y, 4, "own-c");
			await ownerSaves(v, sid, [f, x, ...own]);
			const retry = slidesReloadCandidate();
			expect(retry, "precondition: the held, locked deck takes the retry poll").toBe(sid);
			await reloadSlidesExternal(retry!);
			await settle(v);
			expect(deckModel(deck).map((s) => s.id), "precondition: the retry under the lock read the owner's cut: c left the deck, the owner's pieces shown").toEqual(["file-f", "file-x", ...own.map((s) => s.id)]);
			await ownerSaves(v, sid, [f, x, c]);

			await deleteOriginal(v);

			const want = ["file-f", "file-x", c.id];
			expect(deckModel(deck).map((s) => s.id), "c, taken off the deck by a read and back whole in the file, was left off the deck, or a piece stayed").toEqual(want);
			expect(onDisk(v.adapter, sid), "c, taken off the deck by a read and back whole in the file, was deleted from the file, or a piece stayed").toEqual(want);
		});

		it("the copy cut c, undid the cut, and saved before its lock; the owner's page holds the cut's pieces and not c: c stays once, and no piece comes in", async () => {
			const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
			const sid = slidesSidecarId(SHARED);
			const { deck, show, f, x, c } = await drawnUnlocked(v, sid);
			const pieces = await copyErases(show, deck, c, false);
			const cut = deckModel(deck).filter((s) => pieces.includes(s.id));
			await settle(v);
			expect(onDisk(v.adapter, sid), "precondition: the copy's cut reached the file").toEqual(["file-f", "file-x", ...pieces]);
			expect(deck.run("undo"), "precondition: the copy undid its cut").toBe(true);
			await settle(v);
			expect(deckModel(deck).map((s) => s.id), "precondition: the undo put c back and took the pieces").toEqual(["file-f", "file-x", c.id]);
			expect(onDisk(v.adapter, sid), "precondition: the undo reached the file").toEqual(["file-f", "file-x", c.id]);
			inlineInk.markDuplicateLocked(COPY, ORIG);
			await ownerSaves(v, sid, [f, x, ...cut]);

			await deleteOriginal(v);

			const want = ["file-f", "file-x", c.id];
			expect(deckModel(deck).map((s) => s.id), "the pieces of the copy's undone cut came back on the deck beside c, or c left").toEqual(want);
			expect(onDisk(v.adapter, sid), "the pieces of the copy's undone cut came back in the file beside c, or c left").toEqual(want);
		});

		it("the copy cut c, undid the cut, redid it, and saved before its lock; the owner's page holds c whole: the pieces stay once where c sat, and c does not come back", async () => {
			const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
			const sid = slidesSidecarId(SHARED);
			const { deck, show, f, x, c } = await drawnUnlocked(v, sid);
			const pieces = await copyErases(show, deck, c, false);
			await settle(v);
			expect(deck.run("undo"), "precondition: the copy undid its cut").toBe(true);
			await settle(v);
			expect(onDisk(v.adapter, sid), "precondition: the undo reached the file").toEqual(["file-f", "file-x", c.id]);
			expect(deck.run("redo"), "precondition: the copy redid its cut").toBe(true);
			await settle(v);
			expect(deckModel(deck).map((s) => s.id), "precondition: the redo took c and put the pieces back").toEqual(["file-f", "file-x", ...pieces]);
			expect(onDisk(v.adapter, sid), "precondition: the redo reached the file").toEqual(["file-f", "file-x", ...pieces]);
			inlineInk.markDuplicateLocked(COPY, ORIG);
			await ownerSaves(v, sid, [f, x, c]);

			await deleteOriginal(v);

			const want = ["file-f", "file-x", ...pieces];
			expect(deckModel(deck).map((s) => s.id), "c came back on the deck beside the pieces of the copy's redone cut, or the pieces left").toEqual(want);
			expect(onDisk(v.adapter, sid), "c came back in the file beside the pieces of the copy's redone cut, or the pieces left").toEqual(want);
		});

		for (const [action, name] of [["clear-current", "clear slide"], ["clear-all", "clear all"]] as const) {
			it(`the copy's ${name} took c and the file's ink and saved before its lock; the owner's page holds them and a newer stroke: none of them comes back`, async () => {
				const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
				const sid = slidesSidecarId(SHARED);
				const { deck, f, x, c } = await drawnUnlocked(v, sid);
				expect(deck.run(action), `precondition: the copy's ${name} ran`).toBe(true);
				await settle(v);
				expect(deckModel(deck).map((s) => s.id), `precondition: the ${name} took c and the file's ink off the deck`).toEqual([]);
				expect(onDisk(v.adapter, sid), `precondition: the ${name} reached the file`).toEqual([]);
				inlineInk.markDuplicateLocked(COPY, ORIG);
				await ownerSaves(v, sid, [f, x, c, line("orig-later", 400, 100, 500, 150)]);

				await deleteOriginal(v);

				const want = ["orig-later"];
				expect(deckModel(deck).map((s) => s.id), `ink the copy's ${name} took came back on the deck, or the owner's newer stroke left`).toEqual(want);
				expect(onDisk(v.adapter, sid), `ink the copy's ${name} took came back in the file, or the owner's newer stroke left`).toEqual(want);
			});
		}

		it("the copy cut c and saved before its lock; after the lift's save lands a page with c whole syncs in again and a poll reads it: c stays off the deck, and the copy's next save leaves it out of the file", async () => {
			const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
			const sid = slidesSidecarId(SHARED);
			const { deck, show, f, x, c } = await drawnUnlocked(v, sid);
			const pieces = await copyErases(show, deck, c, false);
			await settle(v);
			expect(onDisk(v.adapter, sid), "precondition: the copy's cut reached the file").toEqual(["file-f", "file-x", ...pieces]);
			inlineInk.markDuplicateLocked(COPY, ORIG);
			await ownerSaves(v, sid, [f, x, c]);
			await deleteOriginal(v);

			// A writer that never saw the cut puts its page back, after the lift's save landed.
			v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [f, x, c])));
			const polled = slidesReloadCandidate();
			expect(polled, "precondition: the deck takes the poll").toBe(sid);
			await reloadSlidesExternal(polled!);
			await settle(v);
			const ids = deckModel(deck).map((s) => s.id);
			expect(ids.slice(0, 2), "precondition: the poll's read landed on the deck").toEqual(["file-f", "file-x"]);
			expect(ids.includes(c.id), "a later read of a page with c whole put c back on the deck after the copy's own cut").toBe(false);
			const shown = new Set(ids);
			show.draw(420, 150);
			const d = deckModel(deck).find((s) => !shown.has(s.id));
			expect(d, "precondition: d drawn on the copy's deck").toBeDefined();
			await settle(v);
			const disk = onDisk(v.adapter, sid) ?? [];
			expect(disk.includes(d!.id), "precondition: the copy's next save, with d, reached the file").toBe(true);
			expect(disk.includes(c.id), "the copy's next save wrote c back after its own cut").toBe(false);
		});

		it("the copy cut c and saved; another device's page with the pieces and a stroke y is read by a poll before the lock; the owner's page holds c whole and y at the lift: c does not come back", async () => {
			const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
			const sid = slidesSidecarId(SHARED);
			const { deck, show, f, x, c } = await drawnUnlocked(v, sid);
			const pieces = await copyErases(show, deck, c, false);
			const cut = deckModel(deck).filter((s) => pieces.includes(s.id));
			await settle(v);
			expect(onDisk(v.adapter, sid), "precondition: the copy's cut reached the file").toEqual(["file-f", "file-x", ...pieces]);
			const y = line("other-y", 100, 400, 200, 450);
			v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [f, x, ...cut, y])));
			const polled = slidesReloadCandidate();
			expect(polled, "precondition: the deck takes the poll").toBe(sid);
			await reloadSlidesExternal(polled!);
			await settle(v);
			expect(deckModel(deck).map((s) => s.id), "precondition: the unlocked poll's read landed").toEqual(["file-f", "file-x", ...pieces, "other-y"]);
			inlineInk.markDuplicateLocked(COPY, ORIG);
			await ownerSaves(v, sid, [f, x, c, y]);

			await deleteOriginal(v);

			const want = ["file-f", "file-x", ...pieces, "other-y"];
			expect(deckModel(deck).map((s) => s.id), "c came back on the deck after a read between the copy's cut and its lock").toEqual(want);
			expect(onDisk(v.adapter, sid), "c came back in the file after a read between the copy's cut and its lock").toEqual(want);
		});

		it("the copy saved c; a poll's read threw; locked, the copy cut c; the owner's page with c whole is read by the retry under the lock: c stays out there and at the lift", async () => {
			const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
			const sid = slidesSidecarId(SHARED);
			const { deck, show, f, x, c } = await drawnUnlocked(v, sid);
			const reads = throwingReads(v, sid);
			const polled = slidesReloadCandidate();
			expect(polled, "precondition: the deck takes the poll").toBe(sid);
			await reloadSlidesExternal(polled!);
			expect(reads.count, "precondition: the poll's read was made and threw").toBeGreaterThan(0);
			reads.on = false;
			inlineInk.markDuplicateLocked(COPY, ORIG);
			expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
			const pieces = await copyErases(show, deck, c, false);
			await ownerSaves(v, sid, [f, x, c]);
			const retry = slidesReloadCandidate();
			expect(retry, "precondition: the held, locked deck takes the retry poll").toBe(sid);
			await reloadSlidesExternal(retry!);
			await settle(v);
			const want = ["file-f", "file-x", ...pieces];
			// Under the lock the deck keeps its own ink first and the file's after it (no lift order yet): compared as a set.
			expect(deckModel(deck).map((s) => s.id).sort(), "the retry under the lock put c back beside the copy's pieces").toEqual([...want].sort());

			await deleteOriginal(v);

			expect(deckModel(deck).map((s) => s.id), "c is on the deck beside the copy's pieces after the lift").toEqual(want);
			expect(onDisk(v.adapter, sid), "c is in the file beside the copy's pieces after the lift").toEqual(want);
		});
	});
});

describe("a poll: a deck never locked, c saved, another device's page without c syncs in and the poll reads it", () => {
	/** The file holds F and X; the deck opens unlocked, draws c, and that save lands. */
	async function savedUnlocked(v: Vault, sid: string) {
		const f = fileF(), x = fileX();
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [f, x])));
		const { deck, show } = await v.present(COPY);
		show.draw(300, 300);
		const c = deckModel(deck).find((s) => !s.id.startsWith("file-"));
		expect(c, "precondition: c drawn").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		expect(onDisk(v.adapter, sid), "precondition: c reached the file").toEqual(["file-f", "file-x", c!.id]);
		return { deck, show, f, x, c: c! };
	}

	/** Another device's sync client replaces the file whole; the poll reads it. */
	async function syncedIn(v: Vault, sid: string, strokes: InkStroke[]): Promise<void> {
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, strokes)));
		const polled = slidesReloadCandidate();
		expect(polled, "precondition: the deck takes the poll").toBe(sid);
		await reloadSlidesExternal(polled!);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
	}

	// Expected to fail: a poll's read does not keep recovery copies yet (1.5.1's read). Goes red the day it does.
	it.fails("c is kept in a recovery copy beside the incoming page's copy before the file is taken", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, f, x, c } = await savedUnlocked(v, sid);

		await syncedIn(v, sid, [f, x, line("orig-later", 400, 100, 500, 150)]);

		const copies = recoveryCopies(v.adapter, sid);
		expect(copies.outgoing.length, "no recovery copy of the deck's page was kept").toBe(1);
		expect(copies.incoming.length, "no recovery copy of the incoming page was kept").toBe(1);
		expect(idsIn(v.adapter, copies.outgoing[0]!), "the deck's recovery copy does not hold c").toContain(c.id);
		expect(idsIn(v.adapter, copies.incoming[0]!), "the incoming recovery copy is not the incoming page").toEqual(["file-f", "file-x", "orig-later"]);
		expect(deckModel(deck).map((s) => s.id), "the incoming file was not taken").toEqual(["file-f", "file-x", "orig-later"]);
		expect(onDisk(v.adapter, sid), "the live file is not the incoming page").toEqual(["file-f", "file-x", "orig-later"]);
	});

	it("pin: another device erased X whole: the erase lands on the deck and in the file", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, f, c } = await savedUnlocked(v, sid);

		await syncedIn(v, sid, [f, c]);

		expect(deckModel(deck).map((s) => s.id), "another device's whole erase did not land on the deck").toEqual(["file-f", c.id]);
		expect(onDisk(v.adapter, sid), "another device's whole erase was undone in the file").toEqual(["file-f", c.id]);
	});

	it("pin: the incoming page holds all the deck holds and more: it is taken, and no recovery copy is written", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, f, x, c } = await savedUnlocked(v, sid);

		await syncedIn(v, sid, [f, x, c, line("orig-later", 400, 100, 500, 150)]);

		expect(deckModel(deck).map((s) => s.id), "the incoming superset was not taken").toEqual(["file-f", "file-x", c.id, "orig-later"]);
		expect(recoveryCopies(v.adapter, sid), "a superset wrote recovery copies").toEqual({ outgoing: [], incoming: [] });
	});

	// Expected to fail: a poll's read does not keep recovery copies yet (1.5.1's read). Goes red the day it does.
	it.fails("a poll's read throws, d is drawn while writes are held, and the retry lands another device's page without c: the deck's recovery copy holds c and not d, and d is saved after", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, show, f, x, c } = await savedUnlocked(v, sid);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [f, x, line("orig-later", 400, 100, 500, 150)])));
		const reads = throwingReads(v, sid);
		const polled = slidesReloadCandidate();
		expect(polled, "precondition: the deck takes the poll").toBe(sid);
		await reloadSlidesExternal(polled!);
		expect(reads.count, "precondition: the poll's read was made and threw").toBeGreaterThan(0);
		show.draw(420, 340);
		const d = deckModel(deck).find((s) => !s.id.startsWith("file-") && s.id !== c.id);
		expect(d, "precondition: d drawn while writes are held").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		expect(onDisk(v.adapter, sid), "precondition: d was held, the file is the other device's page").toEqual(["file-f", "file-x", "orig-later"]);
		reads.on = false;

		const retry = slidesReloadCandidate();
		expect(retry, "precondition: the held deck takes the retry poll").toBe(sid);
		await reloadSlidesExternal(retry!);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();

		const copies = recoveryCopies(v.adapter, sid);
		expect(copies.outgoing.length, "no recovery copy of the deck's page was kept").toBe(1);
		expect(copies.incoming.length, "no recovery copy of the incoming page was kept").toBe(1);
		expect(idsIn(v.adapter, copies.outgoing[0]!), "the deck's recovery copy does not hold c").toContain(c.id);
		expect(idsIn(v.adapter, copies.outgoing[0]!), "ink never saved, d, went into the deck's recovery copy").not.toContain(d!.id);
		expect(idsIn(v.adapter, copies.incoming[0]!), "the incoming recovery copy is not the incoming page").toEqual(["file-f", "file-x", "orig-later"]);
		// The deck's own order for ink held over a read is not this cell's: the ids, once each.
		const want = ["file-f", "file-x", "orig-later", d!.id].sort();
		expect(deckModel(deck).map((s) => s.id).sort(), "d left the deck, or the incoming page was not taken").toEqual(want);
		expect(onDisk(v.adapter, sid)?.slice().sort(), "d was not saved after the incoming page was taken").toEqual(want);
	});

	// Expected to fail: a poll's read does not keep recovery copies yet (1.5.1's read). Goes red the day it does.
	it.fails("the copy's lock arrives while the poll keeps c in a recovery copy: the read takes nothing, and at the lift c is kept once, on the deck and in the file", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, f, x, c } = await savedUnlocked(v, sid);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [f, x, line("orig-later", 400, 100, 500, 150)])));
		// The recovery copies wait until the lock has arrived.
		let held = false;
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const write = v.adapter.write.bind(v.adapter);
		vi.spyOn(v.adapter, "write").mockImplementation(async (p: string, d: string) => {
			if (p.startsWith(`.handwriting/${sid}.conflict-`)) {
				held = true;
				await gate;
			}
			await write(p, d);
		});
		const polled = slidesReloadCandidate();
		expect(polled, "precondition: the deck takes the poll").toBe(sid);
		const polling = reloadSlidesExternal(polled!);
		await drainMicrotasks();
		inlineInk.markDuplicateLocked(COPY, ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
		release();
		await polling;
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();

		expect(deckModel(deck).map((s) => s.id), "the read under the lock that arrived took the incoming page, and c left the deck").toEqual(["file-f", "file-x", c.id]);
		expect(onDisk(v.adapter, sid), "the locked deck wrote the live file").toEqual(["file-f", "file-x", "orig-later"]);

		await deleteOriginal(v);

		const want = ["file-f", "file-x", "orig-later", c.id];
		expect(deckModel(deck).map((s) => s.id), "the lift's read did not keep c once on the deck").toEqual(want);
		expect(onDisk(v.adapter, sid), "the lift's save did not keep c once in the file").toEqual(want);
		expect(held, "the recovery copies were never written, so the lock did not arrive during them").toBe(true);
	});
});

describe("the word for the note left on the id, on a deck never locked: not a lift's read", () => {
	/**
	 * The deck opens on ORIG, never locked (only the copy is), draws c, and that save lands; another device's page
	 * without c syncs in; the locked copy is deleted before a poll, so the word for ORIG reaches the deck and it reads.
	 */
	async function wordAfterErase(v: Vault, sid: string) {
		const f = fileF(), x = fileX();
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [f, x])));
		inlineInk.markDuplicateLocked(COPY, ORIG);
		const { deck, show } = await v.present(ORIG);
		expect(inlineInk.isDuplicateLocked(ORIG), "precondition: the deck's own note is not locked").toBe(false);
		show.draw(300, 300);
		const c = deckModel(deck).find((s) => !s.id.startsWith("file-"));
		expect(c, "precondition: c drawn").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		expect(onDisk(v.adapter, sid), "precondition: c reached the file").toEqual(["file-f", "file-x", c!.id]);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, [f, x])));
		const word = vi.spyOn(deck, "noteIdChanged");

		v.unlisted.add(COPY);
		await v.plugin.onFileDeleted(Object.assign(new TFile(), { path: COPY, extension: "md", basename: "Deck 1" }));
		v.texts.delete(COPY);
		inlineInk.handleDelete(COPY);
		expect(word, "precondition: the word for the note left on the id reached the deck").toHaveBeenCalledWith(ORIG, false, undefined, true);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
		return { deck, c: c! };
	}

	it("pin: the deck saved c, another device erased c whole, and the locked copy is deleted before a poll: the read the word makes lets the erase land", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck } = await wordAfterErase(v, sid);

		expect(deckModel(deck).map((s) => s.id), "another device's whole erase of c was undone on the deck").toEqual(["file-f", "file-x"]);
		expect(onDisk(v.adapter, sid), "another device's whole erase of c was undone in the file").toEqual(["file-f", "file-x"]);
	});

	// Expected to fail: a poll's read does not keep recovery copies yet (1.5.1's read). Goes red the day it does.
	it.fails("the same read keeps c in a recovery copy beside the incoming page's copy before c leaves the deck", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const sid = slidesSidecarId(SHARED);
		const { deck, c } = await wordAfterErase(v, sid);

		const copies = recoveryCopies(v.adapter, sid);
		expect(copies.outgoing.length, "no recovery copy of the deck's page was kept").toBe(1);
		expect(copies.incoming.length, "no recovery copy of the incoming page was kept").toBe(1);
		expect(idsIn(v.adapter, copies.outgoing[0]!), "the deck's recovery copy does not hold c").toContain(c.id);
		expect(idsIn(v.adapter, copies.incoming[0]!), "the incoming recovery copy is not the incoming page").toEqual(["file-f", "file-x"]);
		expect(deckModel(deck).map((s) => s.id), "the incoming file was not taken").toEqual(["file-f", "file-x"]);
		expect(onDisk(v.adapter, sid), "the live file is not the incoming page").toEqual(["file-f", "file-x"]);
	});
});

/**
 * The owner's note edits its id value; its files move to the new id and the copy left alone on the old id is unlocked.
 * The copy's open deck still shows the Slides ink it read while locked. Only where this session's own move took the old
 * id's Slides file away and the deck's lift read then finds no file does the deck save what it shows under the old id,
 * once. Any other lift whose read finds no file writes nothing new, and a read that finds a file takes it: a move that
 * found no Slides file (only the inline file moved); a Slides file that landed under the old id before the deck's read; a
 * later lift no move made. A deck that drew while locked saves what it shows and its own ink, as before.
 */
describe("the copy's deck left on an id its owner edited away: saved under the old id only after a move here took the Slides file", () => {
	const EDITED = "edited-deck-id";

	async function ownerEdits(v: Vault): Promise<void> {
		v.texts.set(ORIG, `---\nhandwriting-page-id: ${EDITED}\n---\n${DECK_SOURCE}\n`);
		(v.plugin as unknown as { checkPageIdentity(p: string): void }).checkPageIdentity(ORIG);
		for (let r = 0; r < 2; r++) {
			for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(2_000);
			await v.store.flush();
			await drainMicrotasks();
		}
	}

	/**
	 * The Slides file holds `strokes` (F and X). The owner's note is open and owns the id (its record holds it: only then
	 * do its files move); `inline`: an inline ink file under the id too. The copy is locked, and its deck opens on the
	 * Slides file.
	 */
	async function lockedCopyDeck(v: Vault, inline = false, strokes: InkStroke[] = [fileF(), fileX()]) {
		const sid = slidesSidecarId(SHARED);
		v.adapter.externalWrite(sidecarPath(sid), serializePage(v.slidesPage(SHARED, strokes)));
		if (inline) {
			const page = emptyPage(SHARED);
			page.surface = "inline";
			page.strokes = [stroke("note-n", 10, 10, 0)];
			v.adapter.externalWrite(sidecarPath(SHARED), serializePage(page));
		}
		(v.plugin as unknown as { pageIds: PageIdIndex }).pageIds.claimOwnership(SHARED, ORIG);
		await inlineInk.ensureLoaded(ORIG);
		expect(inlineInk.pageIdOf(ORIG), "precondition: the owner's record holds the id").toBe(SHARED);
		inlineInk.markDuplicateLocked(COPY, ORIG);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
		const { deck, show } = await v.present(COPY);
		expect(deckModel(deck).map((s) => s.id), "precondition: the copy's deck shows the shared file").toEqual(strokes.map((s) => s.id));
		return { deck, show, sid };
	}

	/** Each step of the move, `<old id>:<kind>`; `after` sees each one as it ends. */
	function moveSteps(v: Vault, after?: (from: string, kind: string) => void): string[] {
		const steps: string[] = [];
		const real = v.store.keepAsideUnder.bind(v.store);
		vi.spyOn(v.store, "keepAsideUnder").mockImplementation(async (from, to, own, named) => {
			const out = await real(from, to, own, named);
			steps.push(`${from}:${out.kind}`);
			after?.(from, out.kind);
			return out;
		});
		return steps;
	}

	/** How many saves were asked for under `sid` from here on, scheduled or written now. */
	function savesUnder(v: Vault, sid: string): () => number {
		const scheduled = vi.spyOn(v.store, "schedule");
		const now = vi.spyOn(v.store, "saveNow");
		return () => [...scheduled.mock.calls, ...now.mock.calls].filter((c) => c[0] === sid).length;
	}

	async function settle(v: Vault): Promise<void> {
		for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(2_000);
		await v.store.flush();
		await drainMicrotasks();
	}

	const ids = (deck: SlidesDeck): string[] => deckModel(deck).map((s) => s.id).sort();

	it("the deck drew nothing: what it shows is saved under the old id once, and reopened it shows it", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const { deck, sid } = await lockedCopyDeck(v);
		const steps = moveSteps(v);
		const saves = savesUnder(v, sid);

		await ownerEdits(v);

		expect(steps, "precondition: the move found no inline file and moved the Slides file").toEqual([`${SHARED}:absent`, `${sid}:moved`]);
		expect(onDisk(v.adapter, slidesSidecarId(EDITED)), "precondition: the owner's deck file went to its new id").toEqual(["file-f", "file-x"]);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy left alone is unlocked").toBe(false);
		expect(ids(deck), "precondition: the copy's deck still shows the shared strokes").toEqual(["file-f", "file-x"]);
		expect.soft(onDisk(v.adapter, sid), "the strokes the copy's deck shows are in no file under its id").toEqual(["file-f", "file-x"]);
		expect.soft(saves(), "the deck's page was not saved under its id once").toBe(1);
		expect.soft(v.adapter.files.has(sidecarPath(SHARED)), "an inline file was written under the old id for a Slides move").toBe(false);

		// Once: nothing more is written under the id until the deck changes, the close included.
		await settle(v);
		expect.soft(saves(), "the deck saved again with nothing changed").toBe(1);
		await closeDeck(v, deck);
		expect.soft(saves(), "the close saved again with nothing changed").toBe(1);
		// The presentation goes off screen: the next present mounts a new deck, which reads the file.
		setSlidesInk(false);
		await drainMicrotasks();
		const again = await v.present(COPY);
		expect(again.deck, "precondition: the reopen mounted a new deck").not.toBe(deck);
		expect.soft(ids(again.deck), "reopened, the copy's deck is blank").toEqual(["file-f", "file-x"]);
	});

	it("the move left part done just after it moved the Slides file: the round a grace later finds it gone, and the deck's page is saved under the old id once", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const { deck, sid } = await lockedCopyDeck(v);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		// A save under the old Slides id seen queued once, just after that file moved: the round stops and the timer tries
		// again a grace later, when the old id has no Slides file left to move.
		let queuedOnce = false;
		const steps = moveSteps(v, (from, kind) => {
			if (from === sid && kind === "moved") queuedOnce = true;
		});
		const queued = v.store.hasQueuedWrite.bind(v.store);
		vi.spyOn(v.store, "hasQueuedWrite").mockImplementation((id) => {
			if (queuedOnce && id === sid) {
				queuedOnce = false;
				return true;
			}
			return queued(id);
		});
		const saves = savesUnder(v, sid);

		await ownerEdits(v);

		expect(steps, "precondition: the first round moved the Slides file and stopped; the next found it gone").toEqual([`${SHARED}:absent`, `${sid}:moved`, `${SHARED}:absent`, `${sid}:absent`]);
		expect(onDisk(v.adapter, slidesSidecarId(EDITED)), "precondition: the owner's deck file went to its new id").toEqual(["file-f", "file-x"]);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy left alone is unlocked").toBe(false);
		expect(ids(deck), "precondition: the copy's deck still shows the shared strokes").toEqual(["file-f", "file-x"]);
		expect.soft(onDisk(v.adapter, sid), "the strokes the copy's deck shows are in no file under its id").toEqual(["file-f", "file-x"]);
		expect.soft(saves(), "the deck's page was not saved under its id once").toBe(1);
	});

	it("pin: the deck drew c while locked: what it shows and c are saved under the old id", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const { deck, show, sid } = await lockedCopyDeck(v);
		show.draw(300, 300);
		const c = deckModel(deck).find((s) => !s.id.startsWith("file-"));
		expect(c, "precondition: c drawn on the locked copy's deck").toBeDefined();
		await settle(v);
		expect(onDisk(v.adapter, sid), "precondition: the lock held c out of the file").toEqual(["file-f", "file-x"]);

		await ownerEdits(v);

		expect(onDisk(v.adapter, slidesSidecarId(EDITED)), "precondition: the owner's deck file went to its new id").toEqual(["file-f", "file-x"]);
		expect.soft(onDisk(v.adapter, sid), "the copy's deck page is not under its id").toEqual(["file-f", "file-x", c!.id]);
	});

	it("pin: the Slides file gone from the old id before the edit, the inline file there: the move takes no Slides file, and the deck writes nothing under the old id", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const { deck, sid } = await lockedCopyDeck(v, true);
		// A sync replacing the Slides file, mid-replace: the locked deck still shows what it read.
		await v.adapter.remove(sidecarPath(sid));
		const steps = moveSteps(v);
		const saves = savesUnder(v, sid);

		await ownerEdits(v);

		expect(steps, "precondition: the move took the inline file and found no Slides file").toEqual([`${SHARED}:moved`, `${sid}:absent`]);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy left alone is unlocked").toBe(false);
		expect(ids(deck), "precondition: the copy's deck still shows the strokes it read").toEqual(["file-f", "file-x"]);
		expect.soft(onDisk(v.adapter, sid), "a Slides file under the old id was written though the move took none").toBeNull();
		expect.soft(saves(), "the deck saved under the old id").toBe(0);
	});

	it("pin: a Slides file landed under the old id from outside before the deck's read: the deck shows it and writes nothing", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const { deck, sid } = await lockedCopyDeck(v);
		const steps = moveSteps(v);
		const landed = v.slidesPage(SHARED, [fileF(), fileX(), line("file-z", 60, 400, 260, 400)]);
		const real = v.store.load.bind(v.store);
		let put = 0;
		vi.spyOn(v.store, "load").mockImplementation(async (id, options) => {
			if (id === sid && put === 0 && !v.adapter.files.has(sidecarPath(sid))) {
				put++;
				v.adapter.externalWrite(sidecarPath(sid), serializePage(landed));
			}
			return real(id, options);
		});
		const saves = savesUnder(v, sid);

		await ownerEdits(v);

		expect(put, "precondition: the file did not land before the deck's read").toBe(1);
		expect(steps, "precondition: the move found no inline file and moved the Slides file").toEqual([`${SHARED}:absent`, `${sid}:moved`]);
		expect(onDisk(v.adapter, slidesSidecarId(EDITED)), "precondition: the owner's deck file went to its new id").toEqual(["file-f", "file-x"]);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy left alone is unlocked").toBe(false);
		expect.soft(ids(deck), "the deck does not show the landed file").toEqual(["file-f", "file-x", "file-z"]);
		expect.soft(onDisk(v.adapter, sid)?.sort(), "the landed file changed").toEqual(["file-f", "file-x", "file-z"]);
		expect.soft(saves(), "the deck wrote under the old id though its read found a file").toBe(0);
	});

	it("pin: the shared Slides file holds no stroke: the move takes it, the deck shows nothing, and nothing is written under the old id", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const { deck, sid } = await lockedCopyDeck(v, false, []);
		const steps = moveSteps(v);
		const saves = savesUnder(v, sid);

		await ownerEdits(v);

		expect(steps, "precondition: the move found no inline file and moved the Slides file").toEqual([`${SHARED}:absent`, `${sid}:moved`]);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy left alone is unlocked").toBe(false);
		expect(ids(deck), "precondition: the copy's deck shows nothing").toEqual([]);
		expect.soft(onDisk(v.adapter, sid), "a file under the old id was written for a deck that shows nothing").toBeNull();
		expect.soft(saves(), "the deck saved under the old id with nothing to show").toBe(0);
	});

	it("pin: after the deck's page is saved under the old id, a later lift no move made, the file removed outside: nothing more is written", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const { deck, sid } = await lockedCopyDeck(v);
		const saves = savesUnder(v, sid);
		await ownerEdits(v);
		expect(saves(), "precondition: the deck's page was not saved under the old id once").toBe(1);

		// Locked again by another hand; the file goes by another hand (a sync mid-replace); the lock clears as a clear
		// site clears it. No move of this session took the file this time.
		inlineInk.markDuplicateLocked(COPY, ORIG);
		await v.adapter.remove(sidecarPath(sid));
		inlineInk.clearDuplicateLock(COPY);
		slidesLockLifted(COPY);
		slidesNoteIdChanged(COPY);
		await settle(v);

		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is unlocked").toBe(false);
		expect.soft(onDisk(v.adapter, sid), "a file under the old id was written at a later lift no move made").toBeNull();
		expect.soft(saves(), "the deck saved again under the old id at a later lift").toBe(1);
		await closeDeck(v, deck);
		expect.soft(onDisk(v.adapter, sid), "the close wrote under the old id after a later lift no move made").toBeNull();
	});

	it("pin: the lock comes back while the deck's lift read is out, after the move took the Slides file: the page is held, and saved at the next lift", async () => {
		const v = vault({ [ORIG]: SHARED, [COPY]: SHARED });
		const { deck, sid } = await lockedCopyDeck(v);
		// The deck's lift read finds no file; as it lands the copy is locked again (another copy appears), so the
		// save that read asks for is held, not handed to the store.
		const real = v.store.load.bind(v.store);
		let relocked = 0;
		vi.spyOn(v.store, "load").mockImplementation(async (id, options) => {
			const out = await real(id, options);
			if (id === sid && relocked === 0 && !v.adapter.files.has(sidecarPath(sid)) && !inlineInk.isDuplicateLocked(COPY)) {
				relocked++;
				inlineInk.markDuplicateLocked(COPY, ORIG);
			}
			return out;
		});
		const saves = savesUnder(v, sid);

		await ownerEdits(v);

		expect(relocked, "precondition: the lock came back during the deck's read").toBe(1);
		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is locked again").toBe(true);
		expect(onDisk(v.adapter, sid), "precondition: nothing written while locked again").toBeNull();
		expect(saves(), "precondition: no save asked for while locked again").toBe(0);
		expect(ids(deck), "precondition: the deck still shows the strokes it read").toEqual(["file-f", "file-x"]);

		// The lock clears again, as a clear site clears it; no move this time.
		inlineInk.clearDuplicateLock(COPY);
		slidesLockLifted(COPY);
		slidesNoteIdChanged(COPY);
		await settle(v);

		expect(inlineInk.isDuplicateLocked(COPY), "precondition: the copy is unlocked").toBe(false);
		expect.soft(onDisk(v.adapter, sid), "the page held by the relock was not saved at the next lift").toEqual(["file-f", "file-x"]);
	});
});
