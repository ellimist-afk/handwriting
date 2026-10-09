/**
 * A save that fails at plugin unload is told to the user.
 *
 * `finishPersistence` flushes the page store when the plugin unloads (reload,
 * disable, update). A write that fails is not thrown out of `flush`: the store
 * puts the newest ink back in its queue and carries on, so the unload sees a
 * flush that resolved and logs nothing at all. At unload the retry timer never
 * runs, so that ink is not on disk, and nobody has been told.
 *
 * Real `finishPersistence` on the plugin prototype, real `PageStore` over a
 * `FakeAdapter` whose writes fail. Substituted: the settings flush and the PDF
 * store's settle (neither is in question), and `Notice`, which records.
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
import { emptyPage } from "./model/PageData";
import { computeBBox, type InkStroke } from "./ink/Stroke";

const ID = "unload-failure-page";

function stroke(id: string): InkStroke {
	const points = [{ x: 10, y: 20, pressure: 0.5, t: 0 }, { x: 20, y: 30, pressure: 0.6, t: 4 }];
	return { id, tool: "pen", color: "#000000", width: 2, createdAt: 7, points, bbox: computeBBox(points, 4), page: 1 };
}

function device() {
	const adapter = new FakeAdapter();
	const store = new PageStore({ vault: { adapter } } as never);
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown> & { finishPersistence(): Promise<void> };
	Object.assign(plugin, {
		store,
		pdfStore: { settle: async () => {} },
		flushSettings: async () => {},
	});
	const page = emptyPage(ID);
	page.strokes = [stroke("newest")];
	store.schedule(ID, page);
	return { adapter, store, plugin };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	vi.spyOn(console, "error").mockImplementation(() => {});
	signals.notices.length = 0;
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("finishPersistence when the ink cannot be written", () => {
	it("the unload flush cannot write: the user is told the newest ink may not be saved", async () => {
		const d = device();
		d.adapter.failWriteTimes = 1000;

		await d.plugin.finishPersistence();

		expect(d.store.hasQueuedWrite(ID), "the failed write must still be queued, or this cell proves nothing").toBe(true);
		expect([...d.adapter.files.keys()].some((p) => p.includes(ID)), "the ink reached the disk, so this cell proves nothing").toBe(false);
		expect(signals.notices.length, "the newest ink was not written and nobody was told").toBeGreaterThan(0);
	});

	it("the unload flush writes: nothing is said", async () => {
		const d = device();

		await d.plugin.finishPersistence();

		expect(d.store.hasQueuedWrite(ID)).toBe(false);
		expect([...d.adapter.files.keys()].some((p) => p.includes(ID))).toBe(true);
		expect(signals.notices).toEqual([]);
	});
});
