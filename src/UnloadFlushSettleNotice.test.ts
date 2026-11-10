/**
 * A settle that gives up at unload is told to the user.
 *
 * `finishPersistence` waits on three settles before the final flush: the inline
 * ink store, the slides ink, and the PDF store. Each one returns `false` when its
 * 2000 ms deadline wins, with a read or claim still open; here the inline store,
 * the slides ink and the PDF store also report ink parked behind it. The old code dropped that `false` and
 * warned only about a write already in the queue, so a stroke parked on a slow
 * read at quit was lost with no notice at all. A settle that gives up with no ink
 * parked is UnloadNoticeParkedInk.test.ts.
 *
 * Real `finishPersistence` on the plugin prototype. Substituted: the three
 * settles (each resolves the value a case sets), the stores' parked-ink answers
 * (ink is parked), the settings flush, and `Notice`,
 * which records. The store is real, over a `FakeAdapter`.
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
vi.mock("./slides/SlidesInkSurface", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	settleSlidesInk: vi.fn(async () => true),
	slidesParkedInk: vi.fn(() => true),
}));

import HandwritingPlugin from "./main";
import { PageStore } from "./persistence/PageStore";
import { FakeAdapter } from "./persistence/FakeAdapter";
import { emptyPage } from "./model/PageData";
import { computeBBox, type InkStroke } from "./ink/Stroke";
import { settleSlidesInk, slidesParkedInk } from "./slides/SlidesInkSurface";
import { inlineInk } from "./inline/InkOverlayRegistry";

const ID = "unload-settle-page";

function stroke(id: string): InkStroke {
	const points = [{ x: 10, y: 20, pressure: 0.5, t: 0 }, { x: 20, y: 30, pressure: 0.6, t: 4 }];
	return { id, tool: "pen", color: "#000000", width: 2, createdAt: 7, points, bbox: computeBBox(points, 4), page: 1 };
}

/** `queued`: a page whose write is queued and failing, so the store alone would warn. */
function device(opts: { pdfSettle: boolean; queued: boolean }) {
	const adapter = new FakeAdapter();
	const store = new PageStore({ vault: { adapter } } as never);
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown> & { finishPersistence(): Promise<void> };
	Object.assign(plugin, {
		store,
		pdfStore: { settle: async () => opts.pdfSettle, parkedInk: () => true },
		flushSettings: async () => {},
	});
	if (opts.queued) {
		adapter.failWriteTimes = 1000;
		const page = emptyPage(ID);
		page.strokes = [stroke("newest")];
		store.schedule(ID, page);
	}
	return { adapter, store, plugin };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	vi.spyOn(console, "error").mockImplementation(() => {});
	signals.notices.length = 0;
	vi.mocked(settleSlidesInk).mockResolvedValue(true);
	vi.mocked(slidesParkedInk).mockReturnValue(true);
	vi.spyOn(inlineInk, "settle").mockResolvedValue(true);
	vi.spyOn(inlineInk, "parkedInk").mockReturnValue(true);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("finishPersistence when a settle gives up at unload", () => {
	it.each([
		["the inline ink store", () => vi.mocked(inlineInk.settle).mockResolvedValue(false), { pdfSettle: true }],
		["the slides ink", () => vi.mocked(settleSlidesInk).mockResolvedValue(false), { pdfSettle: true }],
		["the PDF store", () => {}, { pdfSettle: false }],
	])("%s gives up with nothing queued: the user is told the newest ink may not be saved", async (_name, arrange, opts) => {
		arrange();
		const d = device({ pdfSettle: opts.pdfSettle, queued: false });

		await d.plugin.finishPersistence();

		expect(signals.notices.length, "a settle that gave up is unsaved ink, and nobody was told").toBe(1);
	});

	it("a settle gives up and a write is also queued: the user is told once", async () => {
		vi.mocked(inlineInk.settle).mockResolvedValue(false);
		const d = device({ pdfSettle: true, queued: true });

		await d.plugin.finishPersistence();

		expect(signals.notices.length).toBe(1);
	});

	it("control: every settle finishes and nothing is queued: nothing is said", async () => {
		const d = device({ pdfSettle: true, queued: false });

		await d.plugin.finishPersistence();

		expect(signals.notices).toEqual([]);
	});

	it("a queued write alone still tells the user", async () => {
		const d = device({ pdfSettle: true, queued: true });

		await d.plugin.finishPersistence();

		expect(d.store.hasQueuedWrite(ID), "the failed write must still be queued, or this cell proves nothing").toBe(true);
		expect(signals.notices.length).toBe(1);
	});
});
