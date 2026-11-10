/**
 * A note's page id is edited while a save of its Slides ink under the old id
 * will not land. The first round of the move makes the old inline file the new
 * id's live file and stops at the Slides file; until the retry a grace later,
 * the note keeps saving its whole page under the old id. These cells pin what
 * the retry does with that newer old-id file:
 *
 * - a stroke drawn between the rounds is on screen and in the new id's live
 *   file after the retry, with no copy set aside;
 * - a stroke erased between the rounds stays erased, on screen and on disk;
 * - control: when the new id's file changed between the rounds (another
 *   device, a sync tool), the old-id file is still set beside it as a listed
 *   copy and the new id's file is left as it was;
 * - another device's revision of the new id's file that has the same length
 *   and modified time as the file the first round wrote is kept, in the live
 *   file or a listed copy (a sync tool sets the other device's write time);
 * - another device's revision that lands between the first round's write and
 *   the stamp it takes of that write is kept by the next round.
 *
 * Real pieces: the identity check, followEditedId and its timer retries
 * (PageIdentity), inline ink, PageStore. Synthetic: FakeAdapter, note metadata
 * from an in-memory text map, and the Slides save, which is queued on the store
 * under the old Slides id directly instead of from an open presentation, with
 * its writes failing until released. Not device acceptance.
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
import { setPenToolsMode, resetPenToolsForTest } from "../inline/PenToolsMode";
import { type InkPoint, type InkStroke, computeBBox } from "../ink/Stroke";
import { emptyPage, type PageData, parsePage, serializePage } from "../model/PageData";

vi.mock("../view/Notices", async (original) => ({
	...(await original<typeof import("../view/Notices")>()),
	blockNotice: () => undefined,
}));

const NOTE = "Deck.md";
const OLD = "own-deck-id";
const NEW = "edited-deck-id";
const DECK_SOURCE = "slide 0\n\n---\n\nslide 1\n\n---\n\nslide 2";
const sidecarPath = (id: string): string => `.handwriting/${id}.json`;
const noteText = (id: string): string => `---\nhandwriting-page-id: ${id}\n---\n${DECK_SOURCE}\n`;

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

/** Every copy set beside `id`'s live file, as stroke ids. */
function conflictCopies(adapter: FakeAdapter, id: string): string[][] {
	return [...adapter.files.keys()]
		.filter((p) => p.startsWith(`.handwriting/${id}.conflict-`))
		.map((p) => parsePage(adapter.files.get(p)!, id).data.strokes.map((s) => s.id).sort());
}

async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 400; i++) await Promise.resolve();
}

type Plugin = {
	buildPageIdIndex(): void;
	checkPageIdentity(path: string): void;
};

/** One note under OLD with inline ink {s1} and Slides ink, open in inline ink here. */
async function ownNote() {
	const adapter = new FakeAdapter();
	adapter.dirs.add(".handwriting");
	const store = new PageStore({ vault: { adapter } } as never);
	const texts = new Map<string, string>([[NOTE, noteText(OLD)]]);
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
	const plugin = Object.create(HandwritingPlugin.prototype) as Plugin;
	Object.assign(plugin, {
		store,
		pdfStore: { settle: async () => true, parkedInk: () => false },
		settings: { paperStyle: "lined", cameras: {}, pageOwners: {} },
		settingsDirty: false, settingsTimer: null, settingsWriting: null, settingsWriteAgain: false,
		saveData: async () => {}, flushSettings: async () => {}, persistOwners: () => {},
		manifest: { version: "id-move-retry-test" },
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
			workspace: { getActiveFile: () => null, iterateAllLeaves: () => {} },
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
	vi.spyOn(console, "info").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);

	const inline = emptyPage(OLD);
	inline.surface = "inline";
	inline.strokes = [inlineStroke("s1")];
	adapter.externalWrite(sidecarPath(OLD), serializePage(inline));
	const slides: PageData = {
		...emptyPage(slidesSidecarId(OLD)), surface: "slides", coordSpace: "slide-logical", deck: { width: 960, height: 700 },
		slides: sectionHashes(DECK_SOURCE).map((hash, index) => ({ index, hash })),
		strokes: [stroke("deck-saved", 100, 100, pageOfSlide(0))],
	};
	adapter.externalWrite(sidecarPath(slidesSidecarId(OLD)), serializePage(slides));

	plugin.buildPageIdIndex();
	await inlineInk.ensureLoaded(NOTE);
	await drainMicrotasks();
	expect(inlineInk.pageIdOf(NOTE), "precondition: the note is open under its own id").toBe(OLD);
	expect(inlineInk.strokes(NOTE).map((s) => s.id), "precondition: the note shows s1").toEqual(["s1"]);

	return {
		adapter, store, plugin, texts,
		/**
		 * A Slides save under the old id is queued and its writes fail until `release`; then the id is edited to NEW and the
		 * first round of the move runs: the inline file becomes NEW's live file, the Slides file stays.
		 */
		async editIdWithSlidesSaveHeld(landsOnMoveWrite?: () => string[]): Promise<{ release: () => void }> {
			let blocked = true;
			let landed: string[] | null = null;
			const write = adapter.write.bind(adapter);
			vi.spyOn(adapter, "write").mockImplementation(async (p: string, d: string) => {
				if (blocked && p.startsWith(sidecarPath(slidesSidecarId(OLD)))) throw new Error("slides save held");
				await write(p, d);
				// A foreign write that lands just after the move puts its bytes at the new id's path, before anything else
				// runs. The move does that by a write of the new id's file or by a rename onto it: the first of the two fires it.
				if (landsOnMoveWrite && landed === null && p === sidecarPath(NEW)) landed = landsOnMoveWrite();
			});
			const rename = adapter.rename.bind(adapter);
			vi.spyOn(adapter, "rename").mockImplementation(async (from: string, to: string) => {
				await rename(from, to);
				if (landsOnMoveWrite && landed === null && to === sidecarPath(NEW)) landed = landsOnMoveWrite();
			});
			store.schedule(slidesSidecarId(OLD), { ...slides, strokes: [...slides.strokes, stroke("deck-queued", 200, 200, pageOfSlide(0))] });
			texts.set(NOTE, noteText(NEW));
			plugin.checkPageIdentity(NOTE);
			await vi.advanceTimersByTimeAsync(5_000);
			await drainMicrotasks();
			expect(inlineInk.pageIdOf(NOTE), "precondition: the move is part done, the note still writes under the old id").toBe(OLD);
			expect(landsOnMoveWrite === undefined || landed !== null, "precondition: the foreign write landed on the move's write").toBe(true);
			expect(onDisk(adapter, NEW), "precondition: the first round made the old inline file the new id's live file").toEqual(landed ?? ["s1"]);
			expect(adapter.files.has(sidecarPath(OLD)), "precondition: the first round removed the old inline file").toBe(false);
			expect(store.hasQueuedWrite(slidesSidecarId(OLD)), "precondition: the Slides save under the old id is still queued").toBe(true);
			return { release: () => void (blocked = false) };
		},
		/** The next inline save under the old id lands. */
		async inlineSaveLands(): Promise<void> {
			for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(2_000);
			await drainMicrotasks();
		},
		/** Only timers run from here: the retries, with no text edit. */
		async retriesRun(): Promise<void> {
			for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(2_000);
			await drainMicrotasks();
			await store.flush();
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
	await drainMicrotasks();
	inlineInk.handleDelete(NOTE);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	resetPenToolsForTest();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("an id move retried after a held Slides save", () => {
	it("a stroke drawn between the rounds stays on screen and in the new id's live file, with no copy set aside", async () => {
		const v = await ownNote();
		const held = await v.editIdWithSlidesSaveHeld();
		inlineInk.commit(NOTE, inlineStroke("s2", 60, 60));
		await v.inlineSaveLands();
		expect(onDisk(v.adapter, OLD), "precondition: the note saved its whole page under the old id").toEqual(["s1", "s2"]);
		held.release();
		await v.retriesRun();
		expect(inlineInk.pageIdOf(NOTE), "precondition: the note followed its new id").toBe(NEW);
		expect(inlineInk.strokes(NOTE).map((s) => s.id).sort(), "the stroke drawn between the rounds left the screen").toEqual(["s1", "s2"]);
		expect(onDisk(v.adapter, NEW), "the new id's live file lacks the stroke drawn between the rounds").toEqual(["s1", "s2"]);
		expect(conflictCopies(v.adapter, NEW), "the retry set this move's own file aside as a copy").toEqual([]);
		expect(v.adapter.files.has(sidecarPath(OLD)), "a file stayed under the old id, which nothing names").toBe(false);
	});

	it("a stroke erased between the rounds stays erased, on screen and in the new id's live file", async () => {
		const v = await ownNote();
		const held = await v.editIdWithSlidesSaveHeld();
		inlineInk.applyRemove(NOTE, ["s1"]);
		await v.inlineSaveLands();
		expect(onDisk(v.adapter, OLD), "precondition: the erase was saved under the old id").toEqual([]);
		held.release();
		await v.retriesRun();
		expect(inlineInk.pageIdOf(NOTE), "precondition: the note followed its new id").toBe(NEW);
		expect(inlineInk.strokes(NOTE).map((s) => s.id), "the erased stroke came back on screen").toEqual([]);
		expect(onDisk(v.adapter, NEW), "the erased stroke came back in the new id's live file").toEqual([]);
		expect(conflictCopies(v.adapter, NEW), "the retry set this move's own file aside as a copy").toEqual([]);
		expect(v.adapter.files.has(sidecarPath(OLD)), "a file stayed under the old id, which nothing names").toBe(false);
	});

	it("control: when the new id's file changed between the rounds, the old-id file is set beside it as a listed copy", async () => {
		const v = await ownNote();
		const held = await v.editIdWithSlidesSaveHeld();
		const theirs = emptyPage(NEW);
		theirs.surface = "inline";
		theirs.strokes = [inlineStroke("drawn-there", 300, 300)];
		const theirBytes = serializePage(theirs);
		v.adapter.externalWrite(sidecarPath(NEW), theirBytes);
		inlineInk.commit(NOTE, inlineStroke("s2", 60, 60));
		await v.inlineSaveLands();
		held.release();
		await v.retriesRun();
		expect(inlineInk.pageIdOf(NOTE), "precondition: the note followed its new id").toBe(NEW);
		expect(v.adapter.files.get(sidecarPath(NEW)), "the other side's change to the new id's file was written over").toBe(theirBytes);
		expect(conflictCopies(v.adapter, NEW), "the ink drawn here is not in one copy listed beside the new id").toEqual([["s1", "s2"]]);
		expect(v.adapter.files.has(sidecarPath(OLD)), "a file stayed under the old id, which nothing names").toBe(false);
	});

	it("a revision from another device with the same length and modified time as the move's own file is kept", async () => {
		const v = await ownNote();
		const held = await v.editIdWithSlidesSaveHeld();
		const path = sidecarPath(NEW);
		const mine = v.adapter.files.get(path)!, at = v.adapter.mtimes.get(path)!;
		// The other device's revision: its stroke is t1 where this one has s1, every other byte the same, so the length is
		// the same; its sync tool sets the modified time that device wrote it at, here the same ms as round 1's write.
		expect(mine.split('"s1"').length - 1, "premise: the stroke id appears once in the move's own file").toBe(1);
		const theirBytes = mine.replace('"s1"', '"t1"');
		v.adapter.externalWrite(path, theirBytes);
		v.adapter.setMtime(path, at);
		expect(await v.adapter.stat(path), "premise: the revision has the move's own file's modified time and size").toEqual({ mtime: at, size: mine.length });
		expect(onDisk(v.adapter, NEW), "premise: the revision holds the other device's stroke").toEqual(["t1"]);
		inlineInk.commit(NOTE, inlineStroke("s2", 60, 60));
		await v.inlineSaveLands();
		held.release();
		await v.retriesRun();
		expect(inlineInk.pageIdOf(NOTE), "precondition: the note followed its new id").toBe(NEW);
		const kept = [...(onDisk(v.adapter, NEW) ?? []), ...conflictCopies(v.adapter, NEW).flat()];
		expect(kept, "the other device's stroke was written over: it is in neither the live file nor a listed copy").toContain("t1");
		expect(kept, "the ink drawn here is in neither the live file nor a listed copy").toEqual(expect.arrayContaining(["s1", "s2"]));
	});

	it("a revision from another device that lands between the move's write and its stamp is kept by the next round", async () => {
		const v = await ownNote();
		const theirs = emptyPage(NEW);
		theirs.surface = "inline";
		theirs.strokes = [inlineStroke("drawn-there", 300, 300)];
		const held = await v.editIdWithSlidesSaveHeld(() => {
			v.adapter.externalWrite(sidecarPath(NEW), serializePage(theirs));
			return ["drawn-there"];
		});
		inlineInk.commit(NOTE, inlineStroke("s2", 60, 60));
		await v.inlineSaveLands();
		held.release();
		await v.retriesRun();
		expect(inlineInk.pageIdOf(NOTE), "precondition: the note followed its new id").toBe(NEW);
		const kept = [...(onDisk(v.adapter, NEW) ?? []), ...conflictCopies(v.adapter, NEW).flat()];
		expect(kept, "the other device's stroke was written over: it is in neither the live file nor a listed copy").toContain("drawn-there");
		expect(kept, "the ink drawn here is in neither the live file nor a listed copy").toEqual(expect.arrayContaining(["s1", "s2"]));
	});

	it("a deck's teardown save under the old Slides id that lands during the move is in the new id's Slides file or a listed copy", async () => {
		// Sweep S1 (1.5.1/audit/sweep/SWEEP-save-load-9bf37494.md): the deck is closed with dirty strokes while the move's
		// Slides step is on the old Slides id's chain. Its teardown flush is a saveNow, which store.scheduled does not count,
		// and it lands after the old Slides file has moved, before the move's last check.
		const v = await ownNote();
		const oldSlides = slidesSidecarId(OLD), newSlides = slidesSidecarId(NEW);
		const torn: PageData = {
			...emptyPage(oldSlides), surface: "slides", coordSpace: "slide-logical", deck: { width: 960, height: 700 },
			slides: sectionHashes(DECK_SOURCE).map((hash, index) => ({ index, hash })),
			strokes: [stroke("deck-saved", 100, 100, pageOfSlide(0)), stroke("torn", 400, 300, pageOfSlide(1))],
		};
		let released = false;
		let tornLanded: string[] | null = null;
		const keepAside = v.store.keepAsideUnder.bind(v.store);
		vi.spyOn(v.store, "keepAsideUnder").mockImplementation(async (from: string, to: string, own?: string) => {
			const kept = await keepAside(from, to, own);
			// The first round after the release that moves the old Slides file: the deck's teardown save lands just after.
			if (released && tornLanded === null && from === oldSlides && kept.kind === "moved") {
				await v.store.saveNow(oldSlides, torn);
				tornLanded = onDisk(v.adapter, oldSlides);
			}
			return kept;
		});
		const held = await v.editIdWithSlidesSaveHeld();
		released = true;
		held.release();
		await v.retriesRun();
		expect(tornLanded, "precondition: the teardown save landed under the old Slides id after its file moved").toEqual(["deck-saved", "torn"]);
		expect(inlineInk.pageIdOf(NOTE), "precondition: the note followed its new id").toBe(NEW);
		const kept = [...(onDisk(v.adapter, newSlides) ?? []), ...conflictCopies(v.adapter, newSlides).flat()];
		expect(kept, "the strokes saved as the deck closed are in neither the new id's Slides file nor a listed copy").toContain("torn");
	});
});
