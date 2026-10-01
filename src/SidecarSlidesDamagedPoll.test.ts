/**
 * Cell 13: the Slides side of the damaged-page poll.
 *
 * PageStore now watches a page whose last load was damaged, so its
 * `externallyChanged` now answers "changed" when the bytes change. The Slides
 * leg of the live-reload poll (main.ts) then calls the deck's reloadExternal.
 * The ruling: the Slides host holds and writes nothing. If it does not hold,
 * that is a finding to report, not a Slides change.
 *
 * A real SlidesDeck over a real PageStore over an in-memory adapter. The poll's
 * Slides leg is three lines and is replayed here as main.ts writes it:
 * externallyChanged, the candidate re-check, then reloadSlidesExternal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageStore } from "./persistence/PageStore";
import { FakeAdapter } from "./persistence/FakeAdapter";
import { SlidesDeck, type SlidesInkHost, slidesSidecarId } from "./slides/SlidesInkSurface";
import { FakeDoc, FakeEl } from "./testUtils/fakeDom";
import { emptyPage, serializePage } from "./model/PageData";
import type { InkStroke } from "./ink/Stroke";

const PAGE_ID = "note-1";
const SIDECAR = slidesSidecarId(PAGE_ID);
const LIVE = `.handwriting/${SIDECAR}.json`;
const SOURCE = "slide 0\n\n---\n\nslide 1";

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#123456",
		width: 2,
		page: 1,
		points: [
			{ x: 10, y: 10, pressure: 0.5, t: 0 },
			{ x: 40, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: 10, y: 10, width: 30, height: 10 },
		createdAt: 0,
	} as InkStroke;
}

async function drain(): Promise<void> {
	for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
}

type Rig = {
	fake: FakeAdapter;
	store: PageStore;
	deck: SlidesDeck;
	hostWrites: () => number;
	notices: string[];
};

async function mount(bytes: string): Promise<Rig> {
	const fake = new FakeAdapter();
	fake.dirs.add(".handwriting");
	fake.externalWrite(LIVE, bytes);
	const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
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
	for (let i = 0; i < 2; i++) {
		const s = new FakeEl("section", doc);
		s.textContent = `slide ${i}`;
		if (i === 0) s.classes.add("present");
		slides.children.push(s);
	}
	(container as unknown as { querySelector: (sel: string) => FakeEl | null }).querySelector = (sel) =>
		sel === ".reveal" ? reveal : null;
	(reveal as unknown as { querySelector: (sel: string) => FakeEl | null }).querySelector = (sel) =>
		sel === ".slides" ? slides : null;
	(container as unknown as { isConnected: boolean }).isConnected = true;
	doc.container = container;
	let writes = 0;
	const notices: string[] = [];
	const host: SlidesInkHost = {
		activeFilePath: () => "Deck.md",
		readSource: async () => SOURCE,
		readPageId: () => PAGE_ID,
		claimId: async (_path, proposed) => ({ pageId: proposed }),
		newPageId: () => PAGE_ID,
		loadSidecar: (id) => store.load(id),
		scheduleSidecar: () => {
			writes++;
		},
		saveSidecarNow: async () => {
			writes++;
		},
		nib: () => ({ tool: "pen", color: "#123456", width: 2 }),
		eraserRadiusPx: () => 12,
		eraseWholeStrokes: () => true,
		notify: (message) => void notices.push(message),
		buildId: "sidecar-slides-damaged-poll-test",
	};
	const deck = new SlidesDeck(
		container as unknown as HTMLElement,
		reveal as unknown as HTMLElement,
		slides as unknown as HTMLElement,
		host
	);
	await drain();
	return { fake, store, deck, hostWrites: () => writes, notices };
}

/**
 * The Slides leg of the live-reload poll, in main.ts's order: the candidate
 * first, and only a candidate is asked whether its file changed.
 */
async function slidesPollTick(rig: Rig): Promise<{ candidate: string | null; reloaded: boolean }> {
	const candidate = rig.deck.reloadCandidateSidecarId();
	if (!candidate || !(await rig.store.externallyChanged(candidate))) return { candidate, reloaded: false };
	if (rig.deck.reloadCandidateSidecarId() !== candidate || rig.store.hasQueuedWrite(candidate)) {
		return { candidate, reloaded: false };
	}
	const reloaded = await rig.deck.reloadExternal(candidate);
	await drain();
	return { candidate, reloaded };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("cell 13: a damaged Slides page on the poll", () => {
	// A damaged Slides load sets the deck's futureLocked (SlidesInkSurface.ts,
	// adoptSidecar's damaged branch), and reloadCandidateSidecarId returns null
	// for a future-locked deck, so the poll never asks about it. The store's
	// new "changed" answer is therefore never reached from the Slides leg.
	const BAD = '{"schemaVersion":1,"pageId":"' + SIDECAR + '","strokes":[';

	it.each([
		["new bad bytes", BAD + "{"],
		["a clean copy", (() => {
			const page = emptyPage(SIDECAR);
			page.strokes = [stroke("s1")];
			return serializePage(page);
		})()],
	])("%s: the store reports changed, the deck is no candidate, nothing is written", async (_name, next) => {
		const rig = await mount(BAD);
		const before = rig.fake.writes().length;
		expect(rig.deck.reloadCandidateSidecarId()).toBeNull();
		rig.fake.externalWrite(LIVE, next);
		await vi.advanceTimersByTimeAsync(6000);
		for (let i = 0; i < 12; i++) {
			const tick = await slidesPollTick(rig);
			expect(tick).toEqual({ candidate: null, reloaded: false });
			await vi.advanceTimersByTimeAsync(1000);
		}
		// The store-side effect, visible: the damaged page is watched.
		expect(await rig.store.externallyChanged(SIDECAR)).toBe(true);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(rig.hostWrites()).toBe(0);
		expect(rig.fake.writes().length).toBe(before);
		expect(rig.fake.files.get(LIVE)).toBe(next);
	});
});
