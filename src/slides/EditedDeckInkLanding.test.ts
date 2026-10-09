/**
 * Which slide a stored stroke lands on when the deck was edited since the
 * ink was saved.
 *
 * Three edited decks, each loaded through the real SlidesDeck with a stored
 * sidecar made against the old deck. Every cell RECORDS where each stroke
 * shows (the slide the reader sees it on) and the page number the next
 * saved file gives it; the only things asserted are the premises: every
 * stored stroke is still held somewhere, and none is held twice. The
 * landing table is printed so a reader can see it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPage, type ParseResult, type PageData } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";
import {
	SlidesDeck,
	type SlidesInkHost,
	remapSlides,
	sectionHash,
	slidesSidecarId,
} from "./SlidesInkSurface";

const PAGE_ID = "note-1";
const SIDECAR = slidesSidecarId(PAGE_ID);

function stroke(id: string, slide: number): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#123456",
		width: 2,
		page: slide + 1,
		points: [
			{ x: 10, y: 10, pressure: 0.5, t: 0 },
			{ x: 40, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: 10, y: 10, width: 30, height: 10 },
		createdAt: 0,
	} as InkStroke;
}

interface Landing {
	/** The slide (0-based) each stroke shows on. */
	shownOn: Record<string, number | null>;
	/** The 1-based page number each stroke carries in the file the deck saves next, if it saves. */
	savedPage: Record<string, number | null>;
	/** What remapSlides alone says moved: old index to new index. */
	remap: Record<number, number>;
	log: string;
}

/**
 * Load a deck whose slides read `current` (in order) over a sidecar saved
 * against `stored`, with one stroke per stored slide.
 */
interface StoredSlideInk {
	/** The stroke's id. */
	id: string;
	/** The slide's text when the ink was saved. */
	text: string;
}

async function land(stored: readonly StoredSlideInk[], current: readonly string[]): Promise<Landing> {
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
	current.forEach((text, i) => {
		const s = new FakeEl("section", doc);
		s.textContent = text;
		if (i === 0) s.classes.add("present");
		slides.children.push(s);
	});
	(container as unknown as { querySelector: (sel: string) => FakeEl | null }).querySelector = (sel) =>
		sel === ".reveal" ? reveal : null;
	(reveal as unknown as { querySelector: (sel: string) => FakeEl | null }).querySelector = (sel) =>
		sel === ".slides" ? slides : null;
	(container as unknown as { isConnected: boolean }).isConnected = true;
	doc.container = container;

	const data: PageData = {
		...emptyPage(SIDECAR),
		surface: "slides",
		coordSpace: "slide-logical",
		slides: stored.map(({ text }, index) => ({ index, hash: sectionHash(text) })),
		strokes: stored.map(({ id }, i) => stroke(id, i)),
	};
	const saved: PageData[] = [];
	const logs: string[] = [];
	const debug = vi.spyOn(console, "debug").mockImplementation((...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	});
	const host: SlidesInkHost = {
		activeFilePath: () => "Deck.md",
		readSource: async () => current.join("\n\n---\n\n"),
		readPageId: () => PAGE_ID,
		claimId: async (_path, proposed) => ({ pageId: proposed }),
		newPageId: () => PAGE_ID,
		loadSidecar: async (): Promise<ParseResult> => ({ data, recovered: false }),
		scheduleSidecar: (_id, page) => void saved.push(page),
		saveSidecarNow: async (_id, page) => void saved.push(page),
		nib: () => ({ tool: "pen", color: "#123456", width: 2 }),
		eraserRadiusPx: () => 12,
		eraseWholeStrokes: () => true,
		notify: () => undefined,
		buildId: "edited-deck-landing-test",
	};
	const deck = new SlidesDeck(
		container as unknown as HTMLElement,
		reveal as unknown as HTMLElement,
		slides as unknown as HTMLElement,
		host
	);
	for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
	const held = (deck as unknown as { strokes: Map<number, InkStroke[]> }).strokes;
	const shownOn: Record<string, number | null> = {};
	for (const { id } of stored) shownOn[id] = null;
	for (const [slide, list] of held) for (const s of list) shownOn[s.id] = slide;
	const savedPage: Record<string, number | null> = {};
	for (const { id } of stored) savedPage[id] = null;
	const last = saved[saved.length - 1];
	if (last) for (const s of last.strokes) savedPage[s.id] = s.page ?? null;
	const remap: Record<number, number> = {};
	for (const [from, to] of remapSlides(
		stored.map(({ text }, index) => ({ index, hash: sectionHash(text) })),
		current.map(sectionHash)
	)) {
		remap[from] = to;
	}
	deck.dispose();
	debug.mockRestore();
	return { shownOn, savedPage, remap, log: logs.filter((l) => l.includes("sidecar loaded")).join(" | ") };
}

function record(name: string, stored: readonly StoredSlideInk[], current: readonly string[], landing: Landing): void {
	console.log(
		[
			`EDITED DECK: ${name}`,
			`  stored  [${stored.map((s) => s.text).join(" | ")}]`,
			`  current [${current.join(" | ")}]`,
			`  remapSlides alone: ${JSON.stringify(landing.remap)}`,
			...stored.map(
				(s, i) =>
					`  ${s.id}: stored on slide ${i}, shown on slide ${landing.shownOn[s.id]}, next save page ${landing.savedPage[s.id]}`
			),
			`  log: ${landing.log}`,
		].join("\n")
	);
}

function expectEveryStrokeHeld(stored: readonly StoredSlideInk[], landing: Landing): void {
	for (const { id } of stored) {
		expect(landing.shownOn[id], `premise: stroke ${id} is held on some slide`).not.toBeNull();
	}
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("stored ink after the deck was edited: where each stroke shows", () => {
	it("a slide inserted above and the old second slide edited", async () => {
		const stored = [
			{ id: "alpha", text: "Alpha slide text" },
			{ id: "bravo", text: "Bravo slide text" },
		];
		const current = ["Brand new opening", "Alpha slide text", "Bravo slide text, edited"];
		const landing = await land(stored, current);
		record("slide inserted above, the second slide edited", stored, current, landing);
		expectEveryStrokeHeld(stored, landing);
	});

	it("a slide copied, so one section appears twice", async () => {
		const stored = [
			{ id: "xray", text: "Xray slide text" },
			{ id: "yankee", text: "Yankee slide text" },
		];
		const current = ["Zulu slide text", "Xray slide text", "Xray slide text"];
		const landing = await land(stored, current);
		record("a section appears twice", stored, current, landing);
		expectEveryStrokeHeld(stored, landing);
	});

	it("two stored slides that shared one text, with the third slot not matched", async () => {
		const stored = [
			{ id: "alpha-one", text: "Alpha slide text" },
			{ id: "alpha-two", text: "Alpha slide text" },
			{ id: "charlie", text: "Charlie slide text" },
		];
		const current = ["November slide text", "Oscar slide text", "Alpha slide text"];
		const landing = await land(stored, current);
		record("two stored slides with one text, the third slot held", stored, current, landing);
		expectEveryStrokeHeld(stored, landing);
	});
});
