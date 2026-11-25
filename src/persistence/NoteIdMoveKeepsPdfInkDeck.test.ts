/**
 * AN OPEN PRESENTATION ON A NOTE THAT NAMES A PDF'S ID, ITS ID LINE EDITED OFF IT.
 *
 * A note whose page-id line names a PDF's ink id (a copied property, a template, a hand edit) and draws in its
 * presentation saves that deck page under the PDF id's Slides name; no PDF ever has a Slides file. When the note's id
 * line changes to another id with the presentation open, the deck page follows the note, as it does off any other id
 * (SlidesHeldInk.test.ts, "a note's edited id is followed by its Slides ink"): with no Slides file under the new id the
 * page becomes that id's file and the deck keeps its strokes on screen; with one, the page is set beside it as a copy
 * fix ink de-sync lists and the deck drops the old strokes. Nothing is left under the PDF's id, and the PDF's own ink
 * file stays as it was.
 *
 * Real pieces and synthetic pieces are SlidesHeldInk.test.ts's, whose harness this file copies, trimmed: the census and
 * the id follow (PageIdentity), inline ink, the production Slides host built by startSlidesInk, SlidesDeck input and
 * persistence, and PageStore are real; FakeAdapter, note metadata from an in-memory text map, and a reduced presentation
 * DOM are synthetic. Not device acceptance.
 *
 * Assertions state the CORRECT behaviour: green = no bug, red = bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { parseMarkdownPage } from "../model/MarkdownPage";
import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { SlidesDeck, pageOfSlide, sectionHashes, setSlidesInk, slidesReloadCandidate, slidesSidecarId } from "../slides/SlidesInkSurface";
import { setPenToolsMode, resetPenToolsForTest } from "../inline/PenToolsMode";
import { setEraserWholeStrokes } from "../inline/InkOverlayToolState";
import { type InkPoint, type InkStroke, computeBBox } from "../ink/Stroke";
import { emptyPage, type PageData, parsePage, serializePage } from "../model/PageData";
import { forkHostFor, listForks, refreshForks, resetForks } from "./ForkResolution";

vi.mock("../view/Notices", async (original) => ({
	...(await original<typeof import("../view/Notices")>()),
	blockNotice: () => undefined,
}));

const NOTE = "Deck.md";
/** A PDF's ink id, which the note's id line names. */
const P = "pdf-3fa9c0de";
const EDITED = "edited-deck-id";
const PDF_PATH = "Doc.pdf";
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

// ---- a minimal presentation DOM (SlidesHeldInk.test.ts's) ----

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

// ---- a vault with one note and the real plugin methods ----

type Plugin = {
	startSlidesInk(): void;
	finishPersistence(): Promise<void>;
	buildPageIdIndex(): void;
	checkPageIdentity(path: string): void;
	pageIds: PageIdIndex;
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
	const plugin = Object.create(HandwritingPlugin.prototype) as Plugin;
	Object.assign(plugin, {
		store,
		pdfStore: { settle: async () => true, parkedInk: () => false },
		settings: { paperStyle: "lined", cameras: {}, pageOwners: {} },
		settingsDirty: false, settingsTimer: null, settingsWriting: null, settingsWriteAgain: false,
		saveData: async () => {}, flushSettings: async () => {}, persistOwners: () => {},
		manifest: { version: "note-id-move-keeps-pdf-ink-deck-test" },
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
					const after = fn(texts.get(f.path)!);
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
		notify: () => undefined,
	} as unknown as InlineInkHost;
	inlineInk.attachHost(inlineHost);
	vi.spyOn(console, "info").mockImplementation(() => undefined);
	return {
		adapter, store, texts, plugin,
		/** Seed a Slides ink file for `id` with one saved stroke on slide 0. */
		seedSlides(id: string, strokeId: string): string {
			const sid = slidesSidecarId(id);
			const bytes = serializePage({
				...emptyPage(sid), surface: "slides", coordSpace: "slide-logical", deck: { width: 960, height: 700 },
				slides: sectionHashes(DECK_SOURCE).map((hash, index) => ({ index, hash })),
				strokes: [stroke(strokeId, 100, 100, pageOfSlide(0))],
			} as PageData);
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

type Vault = ReturnType<typeof vault>;

/** FakeAdapter has no folder listing; the fork scan needs one. */
function listing(fake: FakeAdapter): FakeAdapter {
	return Object.assign(Object.create(fake) as FakeAdapter, {
		async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
			const prefix = dir.endsWith("/") ? dir : dir + "/";
			return { files: [...fake.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")), folders: [] };
		},
	});
}

/** Every stroke id in the copies fix ink de-sync lists beside `id`'s live file. */
async function listedBeside(v: Vault, id: string): Promise<string[]> {
	await v.store.flush();
	const host = forkHostFor({ adapter: listing(v.adapter), store: v.store } as never);
	resetForks();
	await refreshForks(host, ".handwriting");
	return listForks()
		.filter((f) => f.pageId === id)
		.flatMap((f) => parsePage(v.adapter.files.get(f.incomingPath)!, id).data.strokes.map((s) => s.id));
}

/** The note's id value is changed to `id`, and the identity check and its grace have run. */
async function editId(v: Vault, path: string, id: string): Promise<void> {
	v.texts.set(path, `---\nhandwriting-page-id: ${id}\n---\n${DECK_SOURCE}\n`);
	v.plugin.checkPageIdentity(path);
	for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
	await drainMicrotasks();
}

/** One note whose line names the PDF's id: the PDF's ink page, and the note's own deck page under the id's Slides name. */
async function noteOnPdfId(): Promise<{ v: Vault; pdf: string }> {
	const v = vault({ [NOTE]: P });
	const pdf = serializePage({ ...emptyPage(P), surface: "pdf", coordSpace: "page-css@1", pdfPaths: [PDF_PATH], strokes: [stroke("p1", 30, 30, 1)] } as PageData);
	v.adapter.externalWrite(sidecarPath(P), pdf);
	v.seedSlides(P, "drawn-here");
	v.plugin.buildPageIdIndex();
	await inlineInk.ensureLoaded(NOTE);
	await drainMicrotasks();
	expect(inlineInk.pageIdOf(NOTE), "precondition: the note's record is on the PDF's id").toBe(P);
	return { v, pdf };
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
	inlineInk.handleDelete(NOTE);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	resetPenToolsForTest();
	setEraserWholeStrokes(true);
	resetForks();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("an open presentation on a note that names a PDF's id, its id line edited off it", () => {
	it("the new id has no Slides file: the deck keeps the note's strokes on screen, and they save under the new id", async () => {
		const { v, pdf } = await noteOnPdfId();
		const { deck, show } = await v.present(NOTE);
		expect(deckModel(deck).map((s) => s.id), "precondition: the deck shows the note's Slides ink saved under the PDF's id").toEqual(["drawn-here"]);
		await editId(v, NOTE, EDITED);
		expect(inlineInk.pageIdOf(NOTE), "precondition: the note followed its new id").toBe(EDITED);
		expect.soft(deckModel(deck).map((s) => s.id), "the deck's own Slides ink left the screen").toEqual(["drawn-here"]);
		show.draw(300, 300);
		const local = deckModel(deck).find((s) => s.id !== "drawn-here");
		expect(local, "precondition: the stroke is on the deck").toBeDefined();
		await v.closeAndFlush();
		expect.soft(onDisk(v.adapter, slidesSidecarId(EDITED))?.sort() ?? [], "the deck's ink is not in the new id's Slides file").toEqual(["drawn-here", local!.id].sort());
		expect.soft(v.adapter.files.has(sidecarPath(slidesSidecarId(P))), "a Slides file is left under the PDF's id").toBe(false);
		expect.soft(v.adapter.files.get(sidecarPath(P)), "the PDF's ink file changed").toBe(pdf);
	});

	it("keep: the new id has no Slides file, a stroke drawn before the change can still be undone after it", async () => {
		const { v, pdf } = await noteOnPdfId();
		const { deck, show } = await v.present(NOTE);
		show.draw(300, 300);
		const before = deckModel(deck).find((s) => s.id !== "drawn-here");
		expect(before, "precondition: the stroke is on the deck").toBeDefined();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
		expect(onDisk(v.adapter, slidesSidecarId(P))?.sort(), "precondition: the stroke is saved under the PDF id's Slides name").toEqual(["drawn-here", before!.id].sort());
		await editId(v, NOTE, EDITED);
		expect(inlineInk.pageIdOf(NOTE), "precondition: the note followed its new id").toBe(EDITED);
		expect.soft(deckModel(deck).map((s) => s.id).sort(), "the deck's own Slides ink left the screen").toEqual(["drawn-here", before!.id].sort());
		expect.soft(deck.status().undoLabel, "the deck forgot what undo takes back").not.toBeNull();
		expect.soft(deck.run("undo"), "undo did nothing after the change").toBe(true);
		expect.soft(deckModel(deck).map((s) => s.id), "undo did not take back the stroke drawn before the change").toEqual(["drawn-here"]);
		await v.closeAndFlush();
		expect.soft(onDisk(v.adapter, slidesSidecarId(EDITED)) ?? [], "the undo was not saved under the new id").toEqual(["drawn-here"]);
		expect.soft(v.adapter.files.has(sidecarPath(slidesSidecarId(P))), "a Slides file is left under the PDF's id").toBe(false);
		expect.soft(v.adapter.files.get(sidecarPath(P)), "the PDF's ink file changed").toBe(pdf);
	});

	it("the new id has Slides ink: the deck drops the note's old strokes, which are listed beside the new id's file once", async () => {
		const { v, pdf } = await noteOnPdfId();
		v.seedSlides(EDITED, "drawn-there");
		const { deck, show } = await v.present(NOTE);
		expect(deckModel(deck).map((s) => s.id), "precondition: the deck shows the note's Slides ink saved under the PDF's id").toEqual(["drawn-here"]);
		await editId(v, NOTE, EDITED);
		expect(inlineInk.pageIdOf(NOTE), "precondition: the note followed its new id").toBe(EDITED);
		show.draw(300, 300);
		const local = deckModel(deck).find((s) => s.id !== "drawn-here" && s.id !== "drawn-there");
		expect(local, "precondition: the stroke is on the deck").toBeDefined();
		await v.closeAndFlush();
		expect.soft(onDisk(v.adapter, slidesSidecarId(EDITED))?.sort() ?? [], "the set-aside ink went live in the new id's Slides file").toEqual(["drawn-there", local!.id].sort());
		const listed = (await listedBeside(v, slidesSidecarId(EDITED))).filter((s) => s === "drawn-here");
		expect.soft(listed, "the note's old Slides ink is not in the copy listed beside the new id, once").toEqual(["drawn-here"]);
		expect.soft(v.adapter.files.has(sidecarPath(slidesSidecarId(P))), "a Slides file is left under the PDF's id").toBe(false);
		expect.soft(v.adapter.files.get(sidecarPath(P)), "the PDF's ink file changed").toBe(pdf);
	});
});
