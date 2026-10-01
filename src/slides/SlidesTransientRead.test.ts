/**
 * A Slides deck whose ink file read THROWS is not damaged.
 *
 * The inline note surface already treats a thrown sidecar read as "not read
 * yet": silent, write-locked, retried by the live-reload poll. A Slides deck
 * did not. PageStore.load hands back a damaged result with `transient` set when
 * the read throws, and the deck's first-load adoption read only `damaged`: it
 * showed "this presentation's ink file could not be read", locked the deck for
 * the rest of the presentation, and dropped out of the poll, so a file that
 * was healthy a second later never came back.
 *
 * The rule, for the deck:
 *  (a) a first read that throws is held silently: no notice, no write, the deck
 *      stays a poll candidate, and the next good read loads it as a first load;
 *  (b) a payload that was read and does not parse is still damage, with the
 *      existing notice and lock.
 *
 * A real SlidesDeck over a real PageStore over an in-memory adapter whose reads
 * of the live sidecar can be made to throw. The poll's Slides leg is replayed
 * as main.ts writes it: the candidate, externallyChanged, the candidate
 * re-check, then reloadExternal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { SlidesDeck, type SlidesInkHost, slidesSidecarId } from "./SlidesInkSurface";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";
import { emptyPage, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const PAGE_ID = "note-1";
const SIDECAR = slidesSidecarId(PAGE_ID);
const LIVE = `.handwriting/${SIDECAR}.json`;
const SOURCE = "slide 0\n\n---\n\nslide 1";
const DAMAGE_TEXT = "Handwriting: this presentation's ink file could not be read, so new ink is not being saved.";
const TRANSIENT_TEXT =
	"Handwriting: this presentation's ink file could not be read yet. New ink on it is not saved until it loads.";
const HEAL_TEXT =
	"Handwriting: this presentation's ink file is readable again. The saved ink is restored and saving is back on.";
const GONE_TEXT =
	"Handwriting: this presentation's ink file is gone. The presentation starts fresh, and saving is back on.";

/** A FakeAdapter whose reads of the live sidecar throw, as a sync client or cloud placeholder can make them. */
class FlakyAdapter extends FakeAdapter {
	/** Reads of LIVE that will throw. */
	failLiveReads = 0;
	liveReads = 0;

	async read(path: string): Promise<string> {
		if (path === LIVE) {
			this.liveReads++;
			if (this.failLiveReads > 0) {
				this.failLiveReads--;
				throw new Error("EIO injected read (sync in progress)");
			}
		}
		return super.read(path);
	}
}

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

/** A healthy sidecar holding one stroke on slide 0. */
function healthy(id: string): string {
	const page = emptyPage(SIDECAR);
	page.strokes = [stroke(id)];
	return serializePage(page);
}

async function drain(): Promise<void> {
	for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
}

type Rig = {
	fake: FlakyAdapter;
	store: PageStore;
	deck: SlidesDeck;
	hostWrites: () => number;
	notices: string[];
};

async function mount(bytes: string, failFirstReads: number): Promise<Rig> {
	const fake = new FlakyAdapter();
	fake.dirs.add(".handwriting");
	fake.externalWrite(LIVE, bytes);
	fake.failLiveReads = failFirstReads;
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
		buildId: "slides-transient-read-test",
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

/** The Slides leg of the live-reload poll, in main.ts's order. */
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

/** Stroke ids the deck holds on slide 0. */
function onSlide0(rig: Rig): string[] {
	const map = (rig.deck as unknown as { strokes: Map<number, InkStroke[]> }).strokes;
	return (map.get(0) ?? []).map((s) => s.id);
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

describe("a Slides deck whose first ink read throws", () => {
	it("says nothing, writes nothing, stays on the poll, and shows the stored ink once a read succeeds", async () => {
		const rig = await mount(healthy("s1"), 1);
		expect(rig.fake.liveReads, "premise: the first read reached the file and threw").toBe(1);
		expect(rig.notices).toEqual([]);
		expect(onSlide0(rig)).toEqual([]);
		expect(rig.deck.reloadCandidateSidecarId()).toBe(SIDECAR);
		await vi.advanceTimersByTimeAsync(6000);
		const tick = await slidesPollTick(rig);
		expect(tick).toEqual({ candidate: SIDECAR, reloaded: true });
		expect(onSlide0(rig)).toEqual(["s1"]);
		expect(rig.notices).toEqual([]);
		expect(rig.hostWrites()).toBe(0);
	});

	it("keeps retrying silently while the read keeps throwing, then loads", async () => {
		// Every read throws until the file is released. The poll's own change
		// check reads the file too, so reads are counted, not scheduled.
		const rig = await mount(healthy("s1"), Infinity);
		for (let i = 0; i < 3; i++) {
			await vi.advanceTimersByTimeAsync(6000);
			const tick = await slidesPollTick(rig);
			expect(tick.candidate, `poll ${i + 1}: the deck is still a candidate`).toBe(SIDECAR);
			expect(onSlide0(rig)).toEqual([]);
		}
		expect(rig.fake.liveReads, "premise: the deck re-read the file on every poll").toBeGreaterThanOrEqual(7);
		expect(rig.notices).toEqual([]);
		rig.fake.failLiveReads = 0;
		await vi.advanceTimersByTimeAsync(6000);
		expect(await slidesPollTick(rig)).toEqual({ candidate: SIDECAR, reloaded: true });
		expect(onSlide0(rig)).toEqual(["s1"]);
		expect(rig.notices).toEqual([]);
		expect(rig.hostWrites()).toBe(0);
	});
});

describe("the silence of a held deck is bounded", () => {
	it("after 60 s of reads that keep throwing it says so once, and says so again when the ink loads", async () => {
		const rig = await mount(healthy("s1"), Infinity);
		for (let i = 0; i < 9; i++) {
			await vi.advanceTimersByTimeAsync(6000);
			await slidesPollTick(rig);
		}
		expect(rig.notices, "54 s: still inside the bound").toEqual([]);
		for (let i = 0; i < 4; i++) {
			await vi.advanceTimersByTimeAsync(6000);
			expect((await slidesPollTick(rig)).candidate, "the deck stays on the poll").toBe(SIDECAR);
		}
		expect(rig.notices, "78 s: one plain notice, not one per poll").toEqual([TRANSIENT_TEXT]);
		rig.fake.failLiveReads = 0;
		await vi.advanceTimersByTimeAsync(6000);
		expect(await slidesPollTick(rig)).toEqual({ candidate: SIDECAR, reloaded: true });
		expect(onSlide0(rig)).toEqual(["s1"]);
		expect(rig.notices).toEqual([TRANSIENT_TEXT, HEAL_TEXT]);
		expect(rig.hostWrites()).toBe(0);
	});
});

describe("a held deck whose ink file is removed", () => {
	it("the poll sees it gone, the deck starts fresh, says so once and saves the ink drawn while held", async () => {
		const rig = await mount(healthy("s1"), Infinity);
		(rig.deck as unknown as { strokes: Map<number, InkStroke[]> }).strokes.set(0, [stroke("held")]);
		(rig.deck as unknown as { persist(): void }).persist();
		expect(rig.notices, "premise: the held stroke was told").toEqual([TRANSIENT_TEXT]);
		expect(rig.hostWrites(), "premise: nothing saved while held").toBe(0);
		await rig.fake.remove(LIVE);
		await vi.advanceTimersByTimeAsync(6000);
		const tick = await slidesPollTick(rig);
		expect(tick.candidate, "the poll still asks about the held deck").toBe(SIDECAR);
		expect(rig.notices).toEqual([TRANSIENT_TEXT, GONE_TEXT]);
		expect(rig.hostWrites(), "the held ink is saved to a fresh file").toBe(1);
		expect(onSlide0(rig)).toEqual(["held"]);
	});
});

describe("a Slides deck whose ink file is damaged", () => {
	it("still says so once, locks, leaves the poll and writes nothing", async () => {
		const bad = '{"schemaVersion":1,"pageId":"' + SIDECAR + '","strokes":[';
		const rig = await mount(bad, 0);
		expect(rig.notices).toEqual([DAMAGE_TEXT]);
		expect(rig.deck.reloadCandidateSidecarId()).toBeNull();
		rig.fake.externalWrite(LIVE, healthy("s1"));
		await vi.advanceTimersByTimeAsync(6000);
		expect(await slidesPollTick(rig)).toEqual({ candidate: null, reloaded: false });
		expect(rig.notices).toEqual([DAMAGE_TEXT]);
		expect(rig.hostWrites()).toBe(0);
	});
});
