/**
 * AN ID MOVE LEFT PART DONE AT QUIT, AND THE NEXT LAUNCH.
 *
 * A note's page id is edited from P to N while a save of its Slides ink under P cannot land. Every timer round of the move stops
 * at the Slides step, so the note's record stays on P; after the last round no timer is left, and only a text edit would ask
 * again. The note keeps saving its inline ink under P. Obsidian quits with no text edit. On disk: N.json (the inline ink as the
 * last round moved it), P.json (the whole page, with ink drawn after the last round) and P.slides.json (the deck, never moved).
 *
 * The next launch indexes the note by the id its text carries, N, loads N.json and reads N's Slides file. Nothing reads, moves or
 * lists P.json or P.slides.json: the ink drawn after the last round and the whole deck are kept on disk and hidden.
 *
 * The cell: after a fresh plugin's launch the note shows the stroke drawn after the last round, the deck's file holds the deck's
 * saved stroke, and no plain P.json or P.slides.json is left that nothing names. A second cell is the same with the note opened
 * before the launch's census runs, so its ink is already loaded from N.json when the census looks. The control is the same
 * session with the Slides save released after the first round, so the move completes before the quit: the same three checks
 * pass. That shows the checks can be met on this harness and read the move, not the rig.
 *
 * Real pieces: the census (buildPageIdIndex), the identity check, followEditedId and its timer rounds (PageIdentity), inline ink,
 * PageStore. Synthetic: FakeAdapter, note metadata from an in-memory text map, the Slides save, queued on the store under P
 * directly with its writes failing (not from an open presentation), and the deck's launch read, taken as the store load of the
 * Slides id the note's id names (the read a deck makes when it opens). The quit is this instance's unload of declaim timers, as
 * onunload does, then a second instance over a copy of the same files. Its settings are the real settingsFrom over the last data
 * the first instance's own persistOwners write handed to saveData, nothing else. At the launch a deck is open on the note before
 * the census: a stand-in registered as the live deck (setSlidesLiveDeck) that records what the id code tells it, not a real
 * presentation. Not device acceptance.
 *
 * A third cell opens the note and a real deck (mounted through the relaunched plugin's startSlidesInk on a fake presentation
 * DOM) before the census, draws one stroke on each and leaves both saves queued, then runs the census and the timers. Each
 * stroke, the late one, the deck's saved one and the two new ones, must be on screen and in the new id's live file after the
 * flush, or in a listed copy beside that file whose notice names it; no save may still be queued, and no old-id file may be left. The landed-save conflict notice is wired as onload wires it.
 *
 * A fourth cell has a deck's closing save (saveNow under the old Slides id, as its teardown flush makes it) asked for right after
 * the launch's move took the old Slides file, by a remove or a rename of it. Its stroke must reach the new id's live Slides file
 * within the same session (a copy beside it is not enough: nothing would ever bring it live), and no old-id file may be left: the
 * move finishes, or tries again before the next launch.
 *
 * The launch's move is followed for a later save under the old id only while no note names that id. Two owner cells: another
 * note (a sync conflict copy) carries the old id and saves under it, and the moved note's id is set back to the old one and it
 * saves. Each save must stay under the old id, the moved note's live file must stay as it was, and no round of the move may
 * run. Two more pin the late rounds: a round whose file does not parse keeps the move's last stamp, so the next late save still
 * becomes the live file; and a late save that fails and goes back to the queue starts no round until it lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { parseMarkdownPage } from "../model/MarkdownPage";
import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { pageOfSlide, sectionHashes, slidesSidecarId } from "../slides/SlidesInkSurface";
import { setSlidesLiveDeck } from "../slides/SlidesPersistence";
import { SlidesDeck, setSlidesInk, slidesReloadCandidate } from "../slides/SlidesInkSurface";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";
import { setPenToolsMode, resetPenToolsForTest } from "../inline/PenToolsMode";
import { type InkPoint, type InkStroke, computeBBox } from "../ink/Stroke";
import { emptyPage, type PageData, parsePage, serializePage } from "../model/PageData";

/** Every notice shown (blockNotice, or a Notice built directly), in order. */
const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", async (original) => ({
	...(await original<typeof import("obsidian")>()),
	Notice: class {
		constructor(message: unknown) {
			notices.push(String(message));
		}
	},
}));
vi.mock("../view/Notices", async (original) => ({
	...(await original<typeof import("../view/Notices")>()),
	blockNotice: (message: string) => void notices.push(message),
}));

const NOTE = "Deck.md";
/** Another note, such as a sync conflict copy, that carries the old id after the launch's move. */
const COPY = "Deck (conflicted copy).md";
const OLD = "own-deck-id";
const NEW = "edited-deck-id";
const DECK_SOURCE = "slide 0\n\n---\n\nslide 1\n\n---\n\nslide 2";
const sidecarPath = (id: string): string => `.handwriting/${id}.json`;
const noteText = (id: string): string => `---\nhandwriting-page-id: ${id}\n---\n${DECK_SOURCE}\n`;

/** The note the workspace reports as active (getActiveFile), for a deck mounted through startSlidesInk. */
let activeNote: string | null = null;

let createdAt = 1_757_700_000_000;
function stroke(id: string, x0: number, y0: number, page: number): InkStroke {
	const points: InkPoint[] = Array.from({ length: 12 }, (_, i) => ({ x: x0 + i * 1.5, y: y0 + i, pressure: 0.5, t: i * 8 }));
	return { id, tool: "pen", color: "#1e2a3b", width: 2.2, points, bbox: computeBBox(points, 4.4), createdAt: createdAt++, page };
}
function inlineStroke(id: string, x0 = 10, y0 = 10): InkStroke {
	const { page: _page, ...s } = stroke(id, x0, y0, 0);
	return s as InkStroke;
}

function onDisk(adapter: FakeAdapter, id: string): string[] | null {
	const text = adapter.files.get(sidecarPath(id));
	if (text === undefined) return null;
	const parsed = parsePage(text, id);
	expect(parsed.damaged, `sidecar ${id} did not parse`).toBeFalsy();
	return parsed.data.strokes.map((s) => s.id).sort();
}

async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 400; i++) await Promise.resolve();
}

type Plugin = {
	buildPageIdIndex(): void;
	startSlidesInk(): void;
	checkPageIdentity(path: string): void;
	settingsFrom(raw: unknown): Record<string, unknown>;
	declaimTimers: Map<string, number>;
	settings: Record<string, unknown>;
	pageIds: PageIdIndex;
};

/** A minimal presentation DOM (src/UnloadFlushColdReopen.test.ts's recipe): a 960x700 deck drawn at half scale, inset 20/25 px. */
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
		type, pointerId: 7, pointerType: "pen", isPrimary: true, buttons, button: 0, clientX: x, clientY: y, pressure,
		timeStamp: (clock += 16), preventDefault: () => undefined, stopPropagation: () => undefined,
	});
	return {
		doc,
		/** One whole pen stroke, screen px, with a pressure per sample. */
		draw(points: Array<[number, number, number]>): void {
			const [first, ...rest] = points;
			reveal.dispatch(ev("pointerdown", first![0], first![1], first![2]));
			for (const [x, y, pr] of rest) reveal.dispatch(ev("pointermove", x, y, pr));
			const last = points[points.length - 1]!;
			reveal.dispatch(ev("pointerup", last[0], last[1], 0, 0));
		},
	};
}
function slideWord(x0: number, y0: number): Array<[number, number, number]> {
	return Array.from({ length: 12 }, (_, i) => [x0 - i * 4, y0 - i * 3 + (i % 2) * 2, Math.round((0.137 + i * 0.061) * 1000) / 1000]);
}
/** The module's live deck, named by a spy on what slidesReloadCandidate asks it. */
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
/** Stroke ids in the deck's committed per-slide lists (what the painter shows). */
function deckShown(deck: SlidesDeck): string[] {
	const map = (deck as unknown as { strokes: Map<number, InkStroke[]> }).strokes;
	return [...map.values()].flat().map((s) => s.id).sort();
}
/** Every listed copy beside `id`'s live file (`<id>.conflict-<mtime>.json`), with the stroke ids it holds. */
function copiesBeside(adapter: FakeAdapter, id: string): { path: string; ids: string[] }[] {
	return [...adapter.files.keys()]
		.filter((p) => p.startsWith(`.handwriting/${id}.conflict-`) && p.endsWith(".json"))
		.map((p) => ({ path: p, ids: (parsePage(adapter.files.get(p)!, id).data.strokes ?? []).map((s) => s.id) }));
}

/**
 * A plugin instance over `adapter` and `store`, reading note text from `texts`, as onload leaves one for these routes. Its
 * settings are the real settingsFrom over `raw`, as loadSettings reads data.json. persistOwners is the real one; its flush hands
 * the settings to saveData, which keeps the last data it was given.
 */
function instance(adapter: FakeAdapter, store: PageStore, texts: Map<string, string>, raw: unknown) {
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
	const saved: { data: unknown } = { data: null };
	const plugin = Object.create(HandwritingPlugin.prototype) as Plugin;
	const saveData = async (data: unknown) => { saved.data = JSON.parse(JSON.stringify(data)); };
	Object.assign(plugin, {
		store,
		pdfStore: { settle: async () => true, parkedInk: () => false },
		settings: plugin.settingsFrom(raw),
		settingsDirty: false, settingsTimer: null, settingsWriting: null, settingsWriteAgain: false, settingsReadFailed: false,
		saveData,
		flushSettings: async () => {
			(plugin as unknown as { settingsTimer: unknown }).settingsTimer = null;
			await saveData(plugin.settings);
		},
		manifest: { version: "id-move-leftover-launch-test" },
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
					const after = fn(texts.get(f.path)!);
					texts.set(f.path, after);
					return after;
				},
			},
			metadataCache: {
				getCache: (p: string) => cache(p),
				getFileCache: (f: { path: string }) => cache(f.path),
			},
			workspace: { getActiveFile: () => (activeNote === null ? null : file(activeNote)), iterateAllLeaves: () => {} },
		},
	});
	inlineInk.attachHost({
		readPageId: (p: string) => idOf(p) ?? null,
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: (id: string) => store.load(id),
		scheduleSidecar: (id: string, page: never) => store.schedule(id, page),
		scheduleSidecarNow: (id: string, page: never) => store.saveNow(id, page),
		notify: () => undefined,
	} as unknown as InlineInkHost);
	return { plugin, saved };
}

/**
 * One note under OLD with inline ink {s1} and a deck holding d1, open in inline ink. A Slides save under OLD is queued and its
 * writes fail until `release`; the id is edited to NEW, and the first round of the move runs and stops at the Slides step.
 */
async function sessionWithIdEdited() {
	const adapter = new FakeAdapter();
	adapter.dirs.add(".handwriting");
	const store = new PageStore({ vault: { adapter } } as never);
	const texts = new Map<string, string>([[NOTE, noteText(OLD)]]);
	const { plugin, saved } = instance(adapter, store, texts, { paperStyle: "lined", cameras: {}, pageOwners: {} });
	vi.spyOn(console, "info").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);

	const inline = emptyPage(OLD);
	inline.surface = "inline";
	inline.strokes = [inlineStroke("s1")];
	adapter.externalWrite(sidecarPath(OLD), serializePage(inline));
	const slides: PageData = {
		...emptyPage(slidesSidecarId(OLD)), surface: "slides", coordSpace: "slide-logical", deck: { width: 960, height: 700 },
		slides: sectionHashes(DECK_SOURCE).map((hash, index) => ({ index, hash })),
		strokes: [stroke("d1", 100, 100, pageOfSlide(0))],
	};
	adapter.externalWrite(sidecarPath(slidesSidecarId(OLD)), serializePage(slides));

	plugin.buildPageIdIndex();
	await inlineInk.ensureLoaded(NOTE);
	await drainMicrotasks();
	expect(inlineInk.pageIdOf(NOTE), "premise: the note is open under its own id").toBe(OLD);
	expect(inlineInk.strokes(NOTE).map((s) => s.id), "premise: the note shows s1").toEqual(["s1"]);

	let blocked = true;
	const write = adapter.write.bind(adapter);
	vi.spyOn(adapter, "write").mockImplementation(async (p: string, d: string) => {
		if (blocked && p.startsWith(sidecarPath(slidesSidecarId(OLD)))) throw new Error("slides save held");
		await write(p, d);
	});
	store.schedule(slidesSidecarId(OLD), { ...slides, strokes: [...slides.strokes] });
	texts.set(NOTE, noteText(NEW));
	plugin.checkPageIdentity(NOTE);
	await vi.advanceTimersByTimeAsync(5_000);
	await drainMicrotasks();
	expect(inlineInk.pageIdOf(NOTE), "premise: the move is part done, the note still writes under the old id").toBe(OLD);
	expect(onDisk(adapter, NEW), "premise: the first round made the old inline file the new id's live file").toEqual(["s1"]);
	expect(store.hasQueuedWrite(slidesSidecarId(OLD)), "premise: the Slides save under the old id is still queued").toBe(true);

	return {
		adapter, store, plugin, saved, texts,
		release: () => void (blocked = false),
		/** Only timers run from here, with no text edit: every round the move has left. */
		async timersRun(): Promise<void> {
			for (let i = 0; i < 12; i++) {
				await vi.advanceTimersByTimeAsync(5_000);
				await drainMicrotasks();
			}
		},
		/** A stroke drawn now, and the inline save that follows it. */
		async drawAndSave(id: string): Promise<void> {
			inlineInk.commit(NOTE, inlineStroke(id, 60, 60));
			for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(2_000);
			await drainMicrotasks();
		},
		/**
		 * Quit and launch again: this instance lets its declaim timers go as onunload does, then a fresh plugin over a copy of the
		 * same files runs the census and opens the note (or, `openFirst`, opens the note and then runs the census), and its timers
		 * run a while. A deck is open on the note from before the census. Returns the new adapter and store, the settings the new
		 * plugin read at launch, before its census, the settings it holds after, the last data it handed to saveData, and what the
		 * open deck was told.
		 */
		async quitAndLaunch(openFirst = false, beforeCensus?: (at: { plugin: Plugin; adapter: FakeAdapter; store: PageStore; texts: Map<string, string> }) => Promise<void>): Promise<{
			adapter: FakeAdapter; store: PageStore; launched: Record<string, unknown>; after: Record<string, unknown>; savedAfter: unknown;
			deckTold: { path: string; known?: string; keepHeld?: boolean }[];
		}> {
			for (const timer of plugin.declaimTimers.values()) window.clearTimeout(timer);
			plugin.declaimTimers.clear();
			const next = new FakeAdapter();
			for (const [path, bytes] of adapter.files) next.files.set(path, bytes);
			for (const [path, mtime] of adapter.mtimes) next.mtimes.set(path, mtime);
			for (const dir of adapter.dirs) next.dirs.add(dir);
			const nextStore = new PageStore({ vault: { adapter: next } } as never);
			inlineInk.handleDelete(NOTE);
			const nextTexts = new Map(texts);
			const again = instance(next, nextStore, nextTexts, saved.data === null ? null : JSON.parse(JSON.stringify(saved.data)));
			const relaunched = again.plugin;
			const launched = JSON.parse(JSON.stringify(relaunched.settings)) as Record<string, unknown>;
			const deckTold: { path: string; known?: string; keepHeld?: boolean }[] = [];
			// A real deck mounted inside beforeCensus is the live deck; otherwise the stand-in.
			if (!beforeCensus) {
				setSlidesLiveDeck(() => ({
					noteIdChanged: (path: string, _wasLocked: boolean, known?: string, keepHeld?: boolean) => void deckTold.push({ path, known, keepHeld }),
				}) as never);
			}
			if (beforeCensus) {
				await beforeCensus({ plugin: relaunched, adapter: next, store: nextStore, texts: nextTexts });
				relaunched.buildPageIdIndex();
			} else if (openFirst) {
				await inlineInk.ensureLoaded(NOTE);
				await drainMicrotasks();
				expect(inlineInk.strokes(NOTE).map((s) => s.id), "premise: the note opened before the census, from the new id's file").toEqual(["s1"]);
				relaunched.buildPageIdIndex();
			} else {
				relaunched.buildPageIdIndex();
				await inlineInk.ensureLoaded(NOTE);
			}
			await drainMicrotasks();
			for (let i = 0; i < 6; i++) {
				await vi.advanceTimersByTimeAsync(5_000);
				await drainMicrotasks();
			}
			await nextStore.flush();
			await drainMicrotasks();
			return { adapter: next, store: nextStore, launched, after: relaunched.settings, savedAfter: again.saved.data, deckTold };
		},
	};
}

/** The three checks after the launch: the late stroke on screen, the deck's saved stroke in the deck's file, no unnamed old file. */
async function expectWholeAfterLaunch(adapter: FakeAdapter, store: PageStore, late: string): Promise<void> {
	const shown = inlineInk.strokes(NOTE).map((s) => s.id).sort();
	const deck = await store.load(slidesSidecarId(inlineInk.pageIdOf(NOTE) ?? NEW));
	const deckIds = (deck?.data.strokes ?? []).map((s) => s.id);
	const left = [sidecarPath(OLD), sidecarPath(slidesSidecarId(OLD))].filter((p) => adapter.files.has(p));
	expect(shown, `the stroke drawn after the move gave up is not on screen after the launch (deck ${JSON.stringify(deckIds)}, left ${JSON.stringify(left)})`).toContain(late);
	expect(deckIds, `the deck opens without its saved stroke (shown ${JSON.stringify(shown)}, left ${JSON.stringify(left)})`).toContain("d1");
	expect(left, "a file stayed under the old id that nothing names").toEqual([]);
}

/**
 * The launch closed the move: the deck open on the note was pointed at the new id, with the deck's strokes kept, and the part-done
 * entry is gone from the settings and from the data the launch handed to saveData, so a later launch does not run the move again.
 */
function expectMoveClosedAtLaunch(next: Awaited<ReturnType<Awaited<ReturnType<typeof sessionWithIdEdited>>["quitAndLaunch"]>>): void {
	expect(next.deckTold, "the deck open on the note was not pointed at the new id after the launch's move").toContainEqual({ path: NOTE, known: NEW, keepHeld: true });
	const held = (next.after.partDoneFollows ?? {}) as Record<string, unknown>;
	expect(held[NOTE], `the part-done entry is still held after the launch's move (${JSON.stringify(held)})`).toBeUndefined();
	expect(next.savedAfter, "the launch handed no data to saveData after its move").not.toBeNull();
	const saved = ((next.savedAfter as Record<string, unknown>).partDoneFollows ?? {}) as Record<string, unknown>;
	expect(saved[NOTE], `the data saved after the launch still carries the part-done entry (${JSON.stringify(saved)})`).toBeUndefined();
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
	delete (globalThis as { document?: unknown }).document;
	activeNote = null;
	notices.length = 0;
	inlineInk.handleDelete(NOTE);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	setSlidesLiveDeck(() => null);
	resetPenToolsForTest();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("an id move left part done at quit, then the next launch", () => {
	/** Every round stopped at the held Slides save, then a late stroke s2 and a quit with no text edit. */
	async function partDoneAtQuit() {
		const v = await sessionWithIdEdited();
		await v.timersRun();
		expect(v.plugin.declaimTimers.size, "premise: the move has no timer round left").toBe(0);
		expect(inlineInk.pageIdOf(NOTE), "premise: the move never finished, the note still writes under the old id").toBe(OLD);
		expect(v.store.hasQueuedWrite(slidesSidecarId(OLD)), "premise: the Slides save under the old id is still held").toBe(true);
		const before = onDisk(v.adapter, NEW);
		await v.drawAndSave("s2");
		expect(onDisk(v.adapter, OLD), "premise: the note saved its whole page, with the late stroke, under the old id").toEqual(["s1", "s2"]);
		expect(onDisk(v.adapter, NEW), "premise: the new id's file is as the last round left it, without the late stroke").toEqual(before);
		expect(before, "premise: the new id's file lacks the late stroke").not.toContain("s2");
		expect(onDisk(v.adapter, slidesSidecarId(OLD)), "premise: the deck's file is still under the old id").toEqual(["d1"]);
		expect(v.saved.data, "premise: the first instance's settings reached saveData").not.toBeNull();
		return v;
	}

	/** What the launch read from saveData's data: the follow left part done, under the note's path. */
	function expectFollowCarried(launched: Record<string, unknown>): void {
		const kept = (launched.partDoneFollows ?? {}) as Record<string, { held?: string; id?: string }>;
		expect(kept[NOTE], `the launch's settings, read from saveData's data, carry no part-done follow (${JSON.stringify(kept)})`).toMatchObject({ held: OLD, id: NEW });
	}

	it("every round stopped at a held Slides save, a stroke drawn after the last one, quit with no text edit: the launch shows the stroke and the deck, and leaves no unnamed old file", async () => {
		const v = await partDoneAtQuit();
		const next = await v.quitAndLaunch();
		expect(inlineInk.pageIdOf(NOTE), "premise: the launch opened the note under the id its text carries").toBe(NEW);
		await expectWholeAfterLaunch(next.adapter, next.store, "s2");
		expectFollowCarried(next.launched);
		expectMoveClosedAtLaunch(next);
	});

	it("the same, with the note opened before the launch's census: the launch shows the stroke and the deck, and leaves no unnamed old file", async () => {
		const v = await partDoneAtQuit();
		const next = await v.quitAndLaunch(true);
		expect(inlineInk.pageIdOf(NOTE), "premise: the launch opened the note under the id its text carries").toBe(NEW);
		await expectWholeAfterLaunch(next.adapter, next.store, "s2");
		expectFollowCarried(next.launched);
		expectMoveClosedAtLaunch(next);
	});

	it("the note and a real deck open before the launch's census, one stroke drawn on each with both saves still queued: every stroke is on screen and in the new id's file, or in a listed copy with its notice, and no old-id file is left", async () => {
		const v = await partDoneAtQuit();
		let deck: SlidesDeck | null = null;
		let drawnOnDeck: string[] = [];
		let deckStore: PageStore | null = null;
		const next = await v.quitAndLaunch(false, async ({ plugin, store }) => {
			deckStore = store;
			// As onload wires it (PluginOnload.ts): a copy kept on a landed save is announced, naming where it went.
			store.onConflict = (pageId, keptAs) => void notices.push(`conflict ${pageId} kept as ${keptAs}`);
			const show = presentation();
			(globalThis as { document?: unknown }).document = show.doc;
			activeNote = NOTE;
			plugin.startSlidesInk();
			deck = liveDeck();
			await inlineInk.ensureLoaded(NOTE);
			await drainMicrotasks();
			expect(inlineInk.pageIdOf(NOTE), "premise: the note opened before the census under the id its text carries").toBe(NEW);
			expect(inlineInk.strokes(NOTE).map((s) => s.id), "premise: the note opened before the census, from the new id's file").toEqual(["s1"]);
			expect(deckShown(deck), "premise: the deck opened on the new id, before the move, with nothing on it").toEqual([]);
			inlineInk.commit(NOTE, inlineStroke("s3", 80, 80));
			const before = deckShown(deck);
			show.draw(slideWord(300, 300));
			drawnOnDeck = deckShown(deck).filter((id) => !before.includes(id));
			expect(drawnOnDeck, "premise: the pen stroke on the presentation was committed by the deck").toHaveLength(1);
			await drainMicrotasks();
			expect(store.hasQueuedWrite(NEW), "premise: the note's save of s3 is still queued under the new id at the census").toBe(true);
			expect(store.hasQueuedWrite(slidesSidecarId(NEW)), "premise: the deck's save of its new stroke is still queued under the new id's Slides id at the census").toBe(true);
		});
		expect(deck, "premise: a real deck was mounted").not.toBeNull();
		expect(deckStore).toBe(next.store);
		const shown = inlineInk.strokes(NOTE).map((s) => s.id).sort();
		const onDeck = deckShown(deck!);
		const noteCopies = copiesBeside(next.adapter, NEW);
		const deckCopies = copiesBeside(next.adapter, slidesSidecarId(NEW));
		const named = (path: string): boolean => notices.some((n) => n.includes(path) || n.includes(path.slice(path.lastIndexOf("/") + 1)));
		const state = JSON.stringify({ shown, onDeck, noteCopies, deckCopies, notices, files: [...next.adapter.files.keys()].sort() });
		// On screen counts only with the same stroke in the new id's live file after the flush: the screen is not the disk.
		const noteLive = onDisk(next.adapter, NEW) ?? [];
		const deckLive = onDisk(next.adapter, slidesSidecarId(NEW)) ?? [];
		const disk = JSON.stringify({ noteLive, deckLive });
		const kept = (id: string, screen: string[], live: string[], copies: { path: string; ids: string[] }[]): boolean =>
			(screen.includes(id) && live.includes(id)) || copies.some((c) => c.ids.includes(id) && named(c.path));
		for (const id of ["s2", "s3"]) expect(kept(id, shown, noteLive, noteCopies), `note stroke ${id} is neither on screen and in the new id's file, nor in a listed copy with its notice: ${disk} ${state}`).toBe(true);
		for (const id of ["d1", ...drawnOnDeck]) expect(kept(id, onDeck, deckLive, deckCopies), `deck stroke ${id} is neither on screen and in the new id's Slides file, nor in a listed copy with its notice: ${disk} ${state}`).toBe(true);
		expect(next.store.hasQueuedWrite(NEW) || next.store.hasQueuedWrite(slidesSidecarId(NEW)), `a save is still queued under the new ids after the flush: ${state}`).toBe(false);
		const left = [sidecarPath(OLD), sidecarPath(slidesSidecarId(OLD))].filter((p) => next.adapter.files.has(p));
		expect(left, `a file stayed under the old id that nothing names: ${state}`).toEqual([]);
	});

	it("a deck's closing save under the old id lands while the launch moves the Slides file: its stroke reaches the new id's live Slides file in this session, and no old-id file is left", async () => {
		const v = await partDoneAtQuit();
		const deckOld = sidecarPath(slidesSidecarId(OLD));
		let flushed: Promise<void> | null = null;
		const next = await v.quitAndLaunch(false, async ({ adapter, store }) => {
			setSlidesLiveDeck(() => ({ noteIdChanged: () => undefined }) as never);
			// The deck closing as the launch's move takes its file: its teardown flush saves at once under the id it was opened
			// with, the old one (saveSidecarNow), right after the move has taken the old Slides file and before the move asks
			// what was saved under the old ids meanwhile. The move takes the file by a remove or by a rename to a copy name: the first
			// of the two with the old Slides path as its source fires it.
			const closeOn = (from: string, bytes: string | undefined) => {
				if (flushed !== null || from !== deckOld || bytes === undefined) return;
				const page = parsePage(bytes, slidesSidecarId(OLD)).data;
				flushed = store.saveNow(slidesSidecarId(OLD), { ...page, strokes: [...page.strokes, stroke("deck-closing", 400, 400, pageOfSlide(0))] });
			};
			const remove = adapter.remove.bind(adapter);
			vi.spyOn(adapter, "remove").mockImplementation(async (p: string) => {
				const bytes = adapter.files.get(p);
				await remove(p);
				closeOn(p, bytes);
			});
			const rename = adapter.rename.bind(adapter);
			vi.spyOn(adapter, "rename").mockImplementation(async (from: string, to: string) => {
				const bytes = adapter.files.get(from);
				await rename(from, to);
				closeOn(from, bytes);
			});
		});
		expect(flushed, "premise: the deck's closing save was asked for as the launch's move removed or renamed the old Slides file").not.toBeNull();
		await flushed;
		for (let i = 0; i < 12; i++) {
			await vi.advanceTimersByTimeAsync(5_000);
			await drainMicrotasks();
		}
		await next.store.flush();
		await drainMicrotasks();
		const deckLive = onDisk(next.adapter, slidesSidecarId(NEW)) ?? [];
		const deckCopies = copiesBeside(next.adapter, slidesSidecarId(NEW));
		const left = [sidecarPath(OLD), deckOld].filter((p) => next.adapter.files.has(p));
		const state = JSON.stringify({ deckLive, deckCopies, left, partDone: next.after.partDoneFollows ?? null, files: [...next.adapter.files.keys()].sort() });
		expect(deckLive, `the deck's closing stroke is not in the new id's live Slides file after a minute of this session: ${state}`).toContain("deck-closing");
		expect(left, `a file stayed under the old id that nothing names until a later launch: ${state}`).toEqual([]);
	});

	/**
	 * The join cell's launch, the deck's closing save fired as the move takes the old Slides file, then a minute of the session.
	 * `late` counts the rounds a landed save under the old Slides id started (keepAsideUnder called from writePending, not from
	 * the move itself).
	 */
	async function launchWithDeckClosing() {
		const v = await partDoneAtQuit();
		const deckOld = sidecarPath(slidesSidecarId(OLD));
		let flushed: Promise<void> | null = null;
		const late: string[] = [];
		const lateInline: string[] = [];
		const hooks: { beforeLate: (() => void) | null } = { beforeLate: null };
		let launchedAs: { plugin: Plugin; texts: Map<string, string> } | null = null;
		const next = await v.quitAndLaunch(false, async ({ plugin, adapter, store, texts }) => {
			launchedAs = { plugin, texts };
			setSlidesLiveDeck(() => ({ noteIdChanged: () => undefined }) as never);
			const keep = store.keepAsideUnder.bind(store);
			vi.spyOn(store, "keepAsideUnder").mockImplementation(async (oldId: string, newId: string, own?: string, remember?: Parameters<PageStore["keepAsideUnder"]>[3]) => {
				const stack = new Error().stack ?? "";
				if (oldId === OLD && /writePending/.test(stack) && !/moveIdFiles/.test(stack)) lateInline.push(newId);
				if (oldId === slidesSidecarId(OLD) && /writePending/.test(stack) && !/moveIdFiles/.test(stack)) {
					late.push(newId);
					const before = hooks.beforeLate;
					hooks.beforeLate = null;
					before?.();
				}
				return keep(oldId, newId, own, remember);
			});
			const closeOn = (from: string, bytes: string | undefined) => {
				if (flushed !== null || from !== deckOld || bytes === undefined) return;
				const page = parsePage(bytes, slidesSidecarId(OLD)).data;
				flushed = store.saveNow(slidesSidecarId(OLD), { ...page, strokes: [...page.strokes, stroke("deck-closing", 400, 400, pageOfSlide(0))] });
			};
			const remove = adapter.remove.bind(adapter);
			vi.spyOn(adapter, "remove").mockImplementation(async (p: string) => {
				const bytes = adapter.files.get(p);
				await remove(p);
				closeOn(p, bytes);
			});
			const rename = adapter.rename.bind(adapter);
			vi.spyOn(adapter, "rename").mockImplementation(async (from: string, to: string) => {
				const bytes = adapter.files.get(from);
				await rename(from, to);
				closeOn(from, bytes);
			});
		});
		expect(flushed, "premise: the deck's closing save was asked for as the launch's move removed or renamed the old Slides file").not.toBeNull();
		await flushed;
		await settle(next.store);
		expect(launchedAs, "premise: the launch ran through beforeCensus").not.toBeNull();
		const { plugin, texts } = launchedAs!;
		return { next, deckOld, late, lateInline, hooks, plugin, texts };
	}

	async function settle(store: PageStore): Promise<void> {
		for (let i = 0; i < 12; i++) {
			await vi.advanceTimersByTimeAsync(5_000);
			await drainMicrotasks();
		}
		await store.flush();
		await drainMicrotasks();
	}

	/** The deck's whole page as the new id's live Slides file holds it now, plus `extra`, saved under the old Slides id. */
	async function lateDeckSave(next: { adapter: FakeAdapter; store: PageStore }, base: string, extra: string): Promise<void> {
		const page = parsePage(base, slidesSidecarId(OLD)).data;
		await next.store.saveNow(slidesSidecarId(OLD), { ...page, strokes: [...page.strokes, stroke(extra, 420, 420, pageOfSlide(0))] });
	}

	it("bound: two saves land under the old Slides id after the launch's move, one at a time: exactly two more rounds run, and each stroke reaches the new id's live Slides file", async () => {
		const { next, deckOld, late } = await launchWithDeckClosing();
		const liveNew = sidecarPath(slidesSidecarId(NEW));
		expect(onDisk(next.adapter, slidesSidecarId(NEW)), "premise: the first late save reached the new id's live Slides file").toContain("deck-closing");
		expect(late, "premise: the first late save ran exactly one more round").toHaveLength(1);
		await lateDeckSave(next, next.adapter.files.get(liveNew)!, "deck-late-2");
		await settle(next.store);
		const deckLive = onDisk(next.adapter, slidesSidecarId(NEW)) ?? [];
		const left = [sidecarPath(OLD), deckOld].filter((p) => next.adapter.files.has(p));
		const state = JSON.stringify({ deckLive, late, left, files: [...next.adapter.files.keys()].sort() });
		expect(late, `two late saves under the old Slides id did not run exactly two more rounds: ${state}`).toHaveLength(2);
		expect(late.every((to) => to === slidesSidecarId(NEW)), `a late round moved to another id: ${state}`).toBe(true);
		expect(deckLive, `the second late stroke is not in the new id's live Slides file: ${state}`).toContain("deck-late-2");
		expect(deckLive, `the first late stroke left the new id's live Slides file: ${state}`).toContain("deck-closing");
		expect(left, `a file stayed under the old id that nothing names: ${state}`).toEqual([]);
	});

	it("bound: a save queued under the old Slides id when a late round starts is written by that round itself and moved with it: one round for the pair, not a second one inside it", async () => {
		const { next, deckOld, late, hooks } = await launchWithDeckClosing();
		const liveNew = sidecarPath(slidesSidecarId(NEW));
		expect(late, "premise: the first late save ran exactly one more round").toHaveLength(1);
		const base = next.adapter.files.get(liveNew)!;
		const page = parsePage(base, slidesSidecarId(OLD)).data;
		let queued = false;
		hooks.beforeLate = () => {
			next.store.schedule(slidesSidecarId(OLD), { ...page, strokes: [...page.strokes, stroke("deck-late-2", 420, 420, pageOfSlide(0)), stroke("deck-late-3", 460, 460, pageOfSlide(0))] });
			queued = next.store.hasQueuedWrite(slidesSidecarId(OLD));
		};
		await lateDeckSave(next, base, "deck-late-2");
		await settle(next.store);
		const deckLive = onDisk(next.adapter, slidesSidecarId(NEW)) ?? [];
		const left = [sidecarPath(OLD), deckOld].filter((p) => next.adapter.files.has(p));
		const state = JSON.stringify({ deckLive, late, left, queued, files: [...next.adapter.files.keys()].sort() });
		expect(queued, `premise: the second save was queued under the old Slides id as the late round started: ${state}`).toBe(true);
		expect(late, `the round's own write of the queued save started another round: ${state}`).toHaveLength(2);
		expect(deckLive, `the queued stroke is not in the new id's live Slides file: ${state}`).toContain("deck-late-3");
		expect(next.store.hasQueuedWrite(slidesSidecarId(OLD)), `a save is still queued under the old Slides id: ${state}`).toBe(false);
		expect(left, `a file stayed under the old id that nothing names: ${state}`).toEqual([]);
	});

	it("guard: the new id's live Slides file changed after the last round, then a save lands under the old Slides id: the live file is kept and the late file is a listed copy beside it", async () => {
		const { next, deckOld, late } = await launchWithDeckClosing();
		const liveNew = sidecarPath(slidesSidecarId(NEW));
		const before = next.adapter.files.get(liveNew)!;
		expect(onDisk(next.adapter, slidesSidecarId(NEW)), "premise: the first late save reached the new id's live Slides file").toContain("deck-closing");
		const page = parsePage(before, slidesSidecarId(NEW)).data;
		await next.store.saveNow(slidesSidecarId(NEW), { ...page, strokes: [...page.strokes, stroke("deck-new-live", 440, 440, pageOfSlide(0))] });
		await drainMicrotasks();
		expect(next.adapter.files.get(liveNew), "premise: the new id's live Slides file changed after the last round").not.toBe(before);
		await lateDeckSave(next, before, "deck-late-2");
		await settle(next.store);
		const deckLive = onDisk(next.adapter, slidesSidecarId(NEW)) ?? [];
		const deckCopies = copiesBeside(next.adapter, slidesSidecarId(NEW));
		const left = [sidecarPath(OLD), deckOld].filter((p) => next.adapter.files.has(p));
		const state = JSON.stringify({ deckLive, deckCopies, late, left, files: [...next.adapter.files.keys()].sort() });
		expect(late, `the late save ran no round, or more than one: ${state}`).toHaveLength(2);
		expect(deckLive, `the new id's live Slides file lost the stroke saved there after the last round: ${state}`).toContain("deck-new-live");
		expect(deckLive, `the late file was written over the changed live file: ${state}`).not.toContain("deck-late-2");
		expect(deckCopies.some((c) => c.ids.includes("deck-late-2")), `the late stroke is in no listed copy beside the new id's Slides file: ${state}`).toBe(true);
		expect(left, `a file stayed under the old id that nothing names: ${state}`).toEqual([]);
	});

	it("owner: another note carries the old id after the launch's move and saves under it: the moved note's live file stays byte-equal, and the save stays under the old id", async () => {
		const { next, plugin, texts, lateInline } = await launchWithDeckClosing();
		const liveNew = sidecarPath(NEW);
		const before = next.adapter.files.get(liveNew);
		expect(before, "premise: the launch's move made the new id's live file").toBeDefined();
		expect(onDisk(next.adapter, OLD), "premise: no file is left under the old id after the launch").toBeNull();
		texts.set(COPY, noteText(OLD));
		plugin.checkPageIdentity(COPY);
		expect(plugin.pageIds.owner(OLD), "premise: the other note owns the old id").toBe(COPY);
		const page = emptyPage(OLD);
		page.surface = "inline";
		page.strokes = [inlineStroke("copy-1", 200, 200)];
		await next.store.saveNow(OLD, page);
		await settle(next.store);
		const state = JSON.stringify({ lateInline, old: onDisk(next.adapter, OLD), live: onDisk(next.adapter, NEW), copies: copiesBeside(next.adapter, NEW), files: [...next.adapter.files.keys()].sort() });
		expect(next.adapter.files.get(liveNew), `the other note's save replaced the moved note's live file: ${state}`).toBe(before);
		expect(onDisk(next.adapter, OLD), `the other note's save is not under the old id it carries: ${state}`).toEqual(["copy-1"]);
		expect(lateInline, `a save of the note that owns the old id ran a round of the launch's move: ${state}`).toEqual([]);
	});

	it("owner: the moved note's id is set back to the old one after the launch's move, then it saves: the save stays under the old id, and a reload shows it", async () => {
		const { next, plugin, texts, lateInline } = await launchWithDeckClosing();
		await inlineInk.ensureLoaded(NOTE);
		await drainMicrotasks();
		expect(inlineInk.pageIdOf(NOTE), "premise: the note opened under the new id").toBe(NEW);
		texts.set(NOTE, noteText(OLD));
		plugin.checkPageIdentity(NOTE);
		await settle(next.store);
		expect(inlineInk.pageIdOf(NOTE), "premise: the note followed its id back to the old one").toBe(OLD);
		expect(plugin.pageIds.owner(OLD), "premise: the note owns the old id again").toBe(NOTE);
		inlineInk.commit(NOTE, inlineStroke("back-1", 80, 80));
		await settle(next.store);
		const old = onDisk(next.adapter, OLD) ?? [];
		inlineInk.handleDelete(NOTE);
		await inlineInk.ensureLoaded(NOTE);
		await drainMicrotasks();
		const shown = inlineInk.strokes(NOTE).map((s) => s.id);
		const state = JSON.stringify({ lateInline, old, shown, live: onDisk(next.adapter, NEW), copies: copiesBeside(next.adapter, NEW), files: [...next.adapter.files.keys()].sort() });
		expect(old, `the save of the note back on the old id is not under the old id: ${state}`).toContain("back-1");
		expect(shown, `the reload of the note back on the old id does not show its save: ${state}`).toContain("back-1");
		expect(lateInline, `a save of the note back on the old id ran a round of the launch's move: ${state}`).toEqual([]);
	});

	it("stamp kept: a late round whose file does not parse sets it beside the new id's live Slides file as it is, and the move keeps the last round's stamp: the next late save still becomes the live file", async () => {
		const { next, deckOld, late } = await launchWithDeckClosing();
		const liveNew = sidecarPath(slidesSidecarId(NEW));
		const before = next.adapter.files.get(liveNew)!;
		expect(late, "premise: the first late save ran exactly one more round").toHaveLength(1);
		expect(onDisk(next.adapter, slidesSidecarId(NEW)), "premise: the first late save reached the new id's live Slides file").toContain("deck-closing");
		// The round reads the old file's bytes only after it moved them to a copy name beside the new id: those bytes are
		// spoiled there once, as a sync writing a broken revision would leave them.
		const copyPrefix = `.handwriting/${slidesSidecarId(NEW)}.conflict-`;
		let spoiled: string | null = null;
		const read = next.adapter.read.bind(next.adapter);
		vi.spyOn(next.adapter, "read").mockImplementation(async (p: string) => {
			if (spoiled === null && p.startsWith(copyPrefix)) {
				spoiled = p;
				next.adapter.files.set(p, "{ not json");
			}
			return read(p);
		});
		await lateDeckSave(next, before, "deck-late-2");
		await settle(next.store);
		expect(spoiled, "premise: the second late round read its file under a copy name and found bytes that do not parse").not.toBeNull();
		expect(next.adapter.files.get(spoiled!), "premise: the bytes that do not parse were set beside the live file as they are").toBe("{ not json");
		expect(next.adapter.files.get(liveNew), "premise: that round left the live Slides file as the first late round wrote it").toBe(before);
		await lateDeckSave(next, before, "deck-late-3");
		await settle(next.store);
		const deckLive = onDisk(next.adapter, slidesSidecarId(NEW)) ?? [];
		const left = [sidecarPath(OLD), deckOld].filter((p) => next.adapter.files.has(p));
		const state = JSON.stringify({ deckLive, late, left, spoiled, files: [...next.adapter.files.keys()].sort() });
		expect(late, `three late saves did not run exactly three more rounds: ${state}`).toHaveLength(3);
		expect(deckLive, `the third late save is not in the new id's live Slides file: the move lost the stamp of the round that wrote it: ${state}`).toContain("deck-late-3");
		expect(left, `a file stayed under the old id that nothing names: ${state}`).toEqual([]);
	});

	it("queue skip: a late save under the old Slides id fails and goes back to the queue: no round starts while it waits, then exactly one when it lands, and its stroke reaches the new id's live Slides file", async () => {
		const { next, deckOld, late } = await launchWithDeckClosing();
		const liveNew = sidecarPath(slidesSidecarId(NEW));
		const before = next.adapter.files.get(liveNew)!;
		expect(late, "premise: the first late save ran exactly one more round").toHaveLength(1);
		let blocked = true;
		let failed = false;
		const write = next.adapter.write.bind(next.adapter);
		vi.spyOn(next.adapter, "write").mockImplementation(async (p: string, d: string) => {
			if (blocked && p.startsWith(deckOld)) {
				failed = true;
				throw new Error("save under the old Slides id held");
			}
			await write(p, d);
		});
		await lateDeckSave(next, before, "deck-late-2");
		await drainMicrotasks();
		expect(failed, "premise: the late save's write failed").toBe(true);
		expect(next.store.hasQueuedWrite(slidesSidecarId(OLD)), "premise: the failed late save went back to the queue").toBe(true);
		const whileQueued = [...late];
		blocked = false;
		await settle(next.store);
		const deckLive = onDisk(next.adapter, slidesSidecarId(NEW)) ?? [];
		const left = [sidecarPath(OLD), deckOld].filter((p) => next.adapter.files.has(p));
		const state = JSON.stringify({ deckLive, late, whileQueued, left, files: [...next.adapter.files.keys()].sort() });
		expect(whileQueued, `a round started while the failed save waited in the queue: ${state}`).toHaveLength(1);
		expect(late, `the save that landed later did not run exactly one more round: ${state}`).toHaveLength(2);
		expect(deckLive, `the late stroke is not in the new id's live Slides file: ${state}`).toContain("deck-late-2");
		expect(next.store.hasQueuedWrite(slidesSidecarId(OLD)), `a save is still queued under the old Slides id: ${state}`).toBe(false);
		expect(left, `a file stayed under the old id that nothing names: ${state}`).toEqual([]);
	});

	it("control: the Slides save lands after the first round, so the move finishes before the quit: the same checks pass", async () => {
		const v = await sessionWithIdEdited();
		v.release();
		await v.timersRun();
		await v.store.flush();
		await drainMicrotasks();
		expect(inlineInk.pageIdOf(NOTE), "premise: the note followed its new id before the quit").toBe(NEW);
		await v.drawAndSave("s2");
		expect(onDisk(v.adapter, NEW), "premise: the late stroke was saved under the new id").toEqual(["s1", "s2"]);
		const next = await v.quitAndLaunch();
		expect(inlineInk.pageIdOf(NOTE), "premise: the launch opened the note under the id its text carries").toBe(NEW);
		await expectWholeAfterLaunch(next.adapter, next.store, "s2");
	});
});
