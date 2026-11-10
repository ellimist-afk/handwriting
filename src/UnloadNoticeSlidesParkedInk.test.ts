/**
 * The unload notice speaks for a presentation's ink only when that ink is waiting.
 *
 * `finishPersistence` tells the user "the newest ink may not have been saved" when a settle gives up at its deadline.
 * The slides settle gives up whenever the live deck's sidecar read or page id claim is still open, also when nothing
 * was drawn behind it, so a presentation whose ink file was slow to read at quit raised the notice with no ink at risk.
 * The inline and PDF cases are UnloadNoticeParkedInk.test.ts.
 *
 * Real `finishPersistence`, the real slides controller and deck (mounted through `setSlidesInk`, as at plugin load),
 * over a host whose sidecar read, or claim, never finishes. Substituted: the inline and PDF settles (both finish, no
 * ink parked), the settings flush, and `Notice`, which records. The page store is real, over a `FakeAdapter`, with
 * nothing queued.
 *
 *   - the deck's ink file is still being read at quit and nothing was drawn: no notice;
 *   - control: a stroke drawn behind that read: the notice, once;
 *   - control: the same, with the presentation closed before quit (its drain still waits on the read): the notice, once;
 *   - control: a first stroke on a never-inked note, its page id claim still open at quit: the notice, once.
 *
 * Then `slidesParkedInk()` itself, over the same real deck: false with nothing in flight and for a read with no ink
 * behind it; true for a closed deck's drain, an open claim, a read with a stroke drawn behind it, and a re-read of a
 * deck whose ink is not yet written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signals = vi.hoisted(() => ({ notices: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: string) {
			signals.notices.push(message);
		}
	},
}));

import HandwritingPlugin from "./main";
import { PageStore } from "./persistence/PageStore";
import { FakeAdapter } from "./persistence/FakeAdapter";
import { FakeDoc, FakeEl } from "./testUtils/fakeDom";
import { inlineInk } from "./inline/InkOverlayRegistry";
import {
	activeSlidesActions, reloadSlidesExternal, scanForSlides, setSlidesInk, settleSlidesInk, slidesParkedInk, slidesReloadCandidate,
	type SlidesInkHost,
} from "./slides/SlidesInkSurface";
import { drains } from "./slides/SlidesController";

/** Every read or claim the host started; each finishes only when the case is over. */
const hung: Array<() => void> = [];
function never<T>(value: T): Promise<T> {
	return new Promise<T>((resolve) => hung.push(() => resolve(value)));
}

/**
 * A presentation on screen, its ink on, and a host whose sidecar read (or, for a never-inked note, claim) hangs.
 * `firstReadLands`: the first read finds no ink file and lands; every later read hangs.
 */
function device(opts: { neverInked?: boolean; firstReadLands?: boolean } = {}) {
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
	const section = new FakeEl("section", doc);
	section.textContent = "slide 0";
	section.classes.add("present");
	slides.children.push(section);
	container.querySelector = (sel: string) => (sel === ".reveal" ? reveal : null);
	reveal.querySelector = (sel: string) => (sel === ".slides" ? slides : null);
	doc.container = container;
	vi.stubGlobal("document", doc);
	let reads = 0;
	const host: SlidesInkHost = {
		activeFilePath: () => "Deck.md",
		readSource: async () => "slide 0",
		readPageId: () => (opts.neverInked ? null : "note-1"),
		claimId: (_path, proposed) => never({ pageId: proposed }),
		newPageId: () => "note-1",
		loadSidecar: () => (opts.neverInked || (opts.firstReadLands && reads++ === 0) ? Promise.resolve(null) : never(null)),
		scheduleSidecar: () => undefined,
		saveSidecarNow: async () => undefined,
		nib: () => ({ tool: "pen", color: "#123456", width: 2 }),
		eraserRadiusPx: () => 12,
		eraseWholeStrokes: () => true,
		notify: () => undefined,
		buildId: "unload-notice-slides",
	};
	setSlidesInk(true, host);
	const store = new PageStore({ vault: { adapter: new FakeAdapter() } } as never);
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown> & { finishPersistence(): Promise<void> };
	Object.assign(plugin, {
		store,
		pdfStore: { settle: async () => true, parkedInk: () => false },
		flushSettings: async () => {},
	});
	let time = 0;
	const draw = (): void => {
		for (const [type, x, y, buttons] of [
			["pointerdown", 200, 200, 1], ["pointermove", 260, 260, 1], ["pointermove", 300, 300, 1], ["pointerup", 300, 300, 0],
		] as const) {
			reveal.dispatch({ type, pointerId: 1, pointerType: "pen", isPrimary: true, buttons, button: 0, clientX: x, clientY: y,
				pressure: 0.5, timeStamp: (time += 20), preventDefault: () => {}, stopPropagation: () => {} });
		}
		doc.flushFrames();
	};
	/** The presentation ends: its container leaves the document and the next scan lets the deck go. */
	const close = (): void => {
		container.isConnected = false;
		doc.container = null;
		scanForSlides();
	};
	return { doc, plugin, draw, close };
}

async function quit(plugin: { finishPersistence(): Promise<void> }): Promise<void> {
	const done = plugin.finishPersistence();
	// Past the slides settle's 2000 ms deadline.
	await vi.advanceTimersByTimeAsync(3000);
	await done;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "debug").mockImplementation(() => {});
	signals.notices.length = 0;
	vi.spyOn(inlineInk, "settle").mockResolvedValue(true);
	vi.spyOn(inlineInk, "parkedInk").mockReturnValue(false);
});
afterEach(async () => {
	// Off tears the deck down; then every read and claim finishes, so no drain a case left is seen by the next one.
	setSlidesInk(false);
	for (let i = 0; i < 4; i++) {
		for (const finish of hung.splice(0)) finish();
		await vi.advanceTimersByTimeAsync(100);
	}
	expect(await settleSlidesInk(0), "a case left slides work in flight").toBe(true);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("the unload notice when a presentation's ink is still being read at quit", () => {
	it("the ink file is still being read and nothing was drawn: no notice", async () => {
		const d = device();
		await vi.advanceTimersByTimeAsync(0);
		expect(activeSlidesActions(d.doc as unknown as Document), "premise: a live deck").not.toBeNull();
		expect(hung.length, "premise: the deck's ink file read is in flight").toBe(1);

		await quit(d.plugin);

		expect(signals.notices, "no ink was waiting, so nothing may be said").toEqual([]);
	});

	it("control: a stroke drawn behind that read: the user is told, once", async () => {
		const d = device();
		await vi.advanceTimersByTimeAsync(0);
		d.draw();
		expect(activeSlidesActions(d.doc as unknown as Document)?.status().totalCount, "premise: the stroke is on the slide").toBe(1);

		await quit(d.plugin);

		expect(signals.notices.length, "a stroke waiting on a read that never landed is unsaved").toBe(1);
	});

	it("control: a stroke drawn behind that read, and the presentation closed before quit: the user is told, once", async () => {
		const d = device();
		await vi.advanceTimersByTimeAsync(0);
		d.draw();
		d.close();
		expect(activeSlidesActions(d.doc as unknown as Document), "premise: the deck is gone").toBeNull();

		await quit(d.plugin);

		expect(signals.notices.length, "the closed deck's stroke still waits on the read, unsaved").toBe(1);
	});

	it("control: a first stroke on a never-inked note, its page id claim still open: the user is told, once", async () => {
		const d = device({ neverInked: true });
		await vi.advanceTimersByTimeAsync(0);
		d.draw();
		expect(hung.length, "premise: the first stroke's page id claim is in flight").toBe(1);

		await quit(d.plugin);

		expect(signals.notices.length, "a stroke waiting on a claim that never landed is unsaved").toBe(1);
	});
});

describe("whether a presentation's ink is waiting to be saved", () => {
	it("a deck whose ink file has landed, with nothing drawn: nothing is waiting", async () => {
		expect(slidesParkedInk(), "no deck at all").toBe(false);
		device({ firstReadLands: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(hung.length, "premise: nothing is in flight").toBe(0);
		expect(slidesParkedInk()).toBe(false);
	});

	it("a closed deck's drain still open: ink is waiting", () => {
		const drain = never(undefined);
		drains.add(drain);
		try {
			expect(slidesParkedInk()).toBe(true);
		} finally {
			drains.delete(drain);
		}
	});

	it("a first stroke's page id claim still open: ink is waiting", async () => {
		const d = device({ neverInked: true });
		await vi.advanceTimersByTimeAsync(0);
		d.draw();
		expect(hung.length, "premise: the claim is in flight").toBe(1);
		expect(slidesParkedInk()).toBe(true);
	});

	it("the ink file still being read, nothing drawn: nothing is waiting", async () => {
		device();
		await vi.advanceTimersByTimeAsync(0);
		expect(hung.length, "premise: the read is in flight").toBe(1);
		expect(slidesParkedInk()).toBe(false);
	});

	it("the ink file still being read, a stroke drawn behind it: ink is waiting", async () => {
		const d = device();
		await vi.advanceTimersByTimeAsync(0);
		d.draw();
		expect(activeSlidesActions(d.doc as unknown as Document)?.status().totalCount, "premise: the stroke is on the slide").toBe(1);
		expect(slidesParkedInk()).toBe(true);
	});

	it("a re-read of the ink file started after a stroke that is not yet written: ink is waiting", async () => {
		const d = device({ firstReadLands: true });
		await vi.advanceTimersByTimeAsync(0);
		d.draw();
		const id = slidesReloadCandidate();
		expect(id, "premise: the deck is quiet and may be read again").not.toBeNull();
		void reloadSlidesExternal(id!);
		expect(hung.length, "premise: the re-read is in flight").toBe(1);
		expect(slidesParkedInk()).toBe(true);
	});
});
