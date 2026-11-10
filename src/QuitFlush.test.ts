/**
 * Ink drawn just before Obsidian is closed is saved before the window goes.
 *
 * Closing the desktop app runs Obsidian's quit hook: it triggers the workspace
 * "quit" event with a task list, and when any task was added it holds the window
 * on "Saving..." until every task settles, then closes it. Nothing here answered
 * that event, so a stroke still parked behind a note's first id claim, or a page
 * write still inside its quiet period, could be gone on reopen with no notice.
 *
 * Obsidian's task list waits on Promise.all with no timeout: a task that never
 * settles holds the window open for good, and a task that rejects stops the close.
 * So the quit task is capped at three seconds and never rejects.
 *
 * Driven through the real wiring: onloadFlushAndForeground registers its handlers
 * on a fake workspace, and the test triggers "quit" with a double of Obsidian's
 * task list (add runs the callback at once, promise is Promise.all). The page
 * store is real, over a FakeAdapter. Substituted: the three settles, the stores'
 * parked-ink answers and the settings flush.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./slides/SlidesInkSurface", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	settleSlidesInk: vi.fn(async () => true),
	slidesParkedInk: vi.fn(() => false),
}));

import HandwritingPlugin from "./main";
import { PageStore } from "./persistence/PageStore";
import { FakeAdapter } from "./persistence/FakeAdapter";
import { emptyPage } from "./model/PageData";
import { computeBBox, type InkStroke } from "./ink/Stroke";
import { inlineInk } from "./inline/InkOverlayRegistry";

const QUEUED = "quit-queued-page";
const PARKED = "quit-parked-page";
const CAP_MS = 3000;

const sidecarPath = (id: string): string => `.handwriting/${id}.json`;

function stroke(id: string): InkStroke {
	const points = [{ x: 10, y: 20, pressure: 0.5, t: 0 }, { x: 20, y: 30, pressure: 0.6, t: 4 }];
	return { id, tool: "pen", color: "#000000", width: 2, createdAt: 7, points, bbox: computeBBox(points, 4), page: 1 };
}

function pageWith(id: string, strokeId: string) {
	const page = emptyPage(id);
	page.strokes = [stroke(strokeId)];
	return page;
}

/** Obsidian's Tasks: add calls the callback at once and keeps its promise; promise waits on all of them, no timeout. */
class TasksDouble {
	readonly list: Promise<unknown>[] = [];
	add(callback: () => Promise<unknown>): void {
		this.list.push(callback());
	}
	promise(): Promise<unknown[]> {
		return Promise.all(this.list);
	}
}

type Handler = (...args: unknown[]) => unknown;

function device() {
	const adapter = new FakeAdapter();
	const store = new PageStore({ vault: { adapter } } as never);
	const handlers = new Map<string, Handler[]>();
	const workspace = {
		on(name: string, callback: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), callback]);
			return { name, callback };
		},
		onLayoutReady() {},
	};
	const flushSettings = vi.fn(async () => {});
	const plugin = Object.create(HandwritingPlugin.prototype) as HandwritingPlugin;
	Object.assign(plugin, {
		app: { workspace },
		store,
		pdfStore: { settle: async () => true, parkedInk: () => false },
		flushSettings,
		registerEvent: () => {},
		registerDomEvent: () => {},
		register: () => {},
	});
	plugin.onloadFlushAndForeground();
	const quit = (): TasksDouble => {
		const tasks = new TasksDouble();
		for (const h of handlers.get("quit") ?? []) h(tasks);
		return tasks;
	};
	return { adapter, store, plugin, handlers, flushSettings, quit };
}

/** Watches a promise: which way it went, and whether it has yet. */
function watch(p: Promise<unknown>) {
	const state = { resolved: false, rejected: false, reason: undefined as unknown };
	p.then(
		() => {
			state.resolved = true;
		},
		(reason) => {
			state.rejected = true;
			state.reason = reason;
		}
	);
	return state;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	vi.stubGlobal("document", {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(inlineInk, "settle").mockResolvedValue(true);
	vi.spyOn(inlineInk, "parkedInk").mockReturnValue(false);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("closing Obsidian right after drawing", () => {
	it("(a) a parked stroke and a queued page: a quit task is added, and both are on disk once the quiet period has run", async () => {
		const d = device();
		d.store.schedule(QUEUED, pageWith(QUEUED, "queued"));
		// The stroke on a note with no id yet: parked until the claim lands, which the settle waits for.
		vi.mocked(inlineInk.parkedInk).mockReturnValue(true);
		vi.mocked(inlineInk.settle).mockImplementation(async () => {
			await Promise.resolve();
			d.store.schedule(PARKED, pageWith(PARKED, "parked"));
			return true;
		});

		expect(d.handlers.get("quit")?.length ?? 0, "nothing answers Obsidian's quit event").toBe(1);
		const tasks = d.quit();
		expect(tasks.list.length, "ink was pending at quit and no task held the window").toBe(1);
		const state = watch(tasks.promise());
		await vi.advanceTimersByTimeAsync(CAP_MS - 1);

		expect(state.resolved, "the quit task must finish on the writes, not on the cap").toBe(true);
		expect(d.adapter.files.has(sidecarPath(QUEUED)), "the queued page was not written before the window closed").toBe(true);
		expect(d.adapter.files.has(sidecarPath(PARKED)), "the parked stroke was not written before the window closed").toBe(true);
		expect(d.flushSettings).toHaveBeenCalled();
	});

	it("(b) nothing pending: no task, so the window closes at once", async () => {
		const d = device();

		expect(d.handlers.get("quit")?.length ?? 0, "nothing answers Obsidian's quit event").toBe(1);
		const tasks = d.quit();

		expect(tasks.list.length, "a quit with no ink pending must not hold the window on Saving").toBe(0);
	});

	it("(c) a write that never lands: the quit task resolves at the three second cap", async () => {
		const d = device();
		d.adapter.writeGate = new Promise<void>(() => {});
		d.store.schedule(QUEUED, pageWith(QUEUED, "queued"));

		expect(d.handlers.get("quit")?.length ?? 0, "nothing answers Obsidian's quit event").toBe(1);
		const tasks = d.quit();
		expect(tasks.list.length).toBe(1);
		const state = watch(tasks.promise());
		await vi.advanceTimersByTimeAsync(CAP_MS - 1);
		expect(state.resolved, "the task ended before the cap with the write still open").toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		expect(state.resolved, "a write that never lands held the window on Saving past the cap").toBe(true);
		expect(state.rejected).toBe(false);
	});

	it("(d) the store flush throws: the quit task still resolves, so the window still closes", async () => {
		const d = device();
		d.store.schedule(QUEUED, pageWith(QUEUED, "queued"));
		vi.spyOn(d.store, "flush").mockRejectedValue(new Error("flush failed at quit"));

		expect(d.handlers.get("quit")?.length ?? 0, "nothing answers Obsidian's quit event").toBe(1);
		const tasks = d.quit();
		expect(tasks.list.length).toBe(1);
		const state = watch(tasks.promise());
		await vi.advanceTimersByTimeAsync(0);

		expect(state.rejected, "a rejected quit task stops Obsidian's close").toBe(false);
		expect(state.resolved, "the quit task did not finish after the flush threw").toBe(true);
		expect(d.flushSettings, "settings are still flushed after the store flush throws").toHaveBeenCalled();
	});

	it("(e) the parked stroke is on disk at the moment the quit task resolves, not later on its quiet timer", async () => {
		const d = device();
		vi.mocked(inlineInk.parkedInk).mockReturnValue(true);
		vi.mocked(inlineInk.settle).mockImplementation(async () => {
			await Promise.resolve();
			d.store.schedule(PARKED, pageWith(PARKED, "parked"));
			return true;
		});
		const tasks = d.quit();
		expect(tasks.list.length).toBe(1);
		let onDiskAtResolve: boolean | undefined;
		void tasks.promise().then(() => {
			onDiskAtResolve = d.adapter.files.has(sidecarPath(PARKED));
		});
		await vi.advanceTimersByTimeAsync(CAP_MS - 1);
		expect(onDiskAtResolve, "the quit task resolved before the parked stroke was written").toBe(true);
	});

	it("(f) only a parked stroke, no queued page: a quit task is still added", () => {
		const d = device();
		vi.mocked(inlineInk.parkedInk).mockReturnValue(true);
		const tasks = d.quit();
		expect(tasks.list.length, "a parked stroke alone added no quit task").toBe(1);
	});

	it("(g) a note id claim that never lands: the window still closes at the three second cap, not before", async () => {
		const d = device();
		vi.mocked(inlineInk.parkedInk).mockReturnValue(true);
		vi.mocked(inlineInk.settle).mockImplementation(() => new Promise<boolean>(() => {}));
		const tasks = d.quit();
		expect(tasks.list.length).toBe(1);
		const state = watch(tasks.promise());
		await vi.advanceTimersByTimeAsync(CAP_MS - 1);
		expect(state.resolved, "ended before the cap with the claim still open").toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(state.resolved, "a hung claim held the window on Saving past the cap").toBe(true);
		expect(state.rejected).toBe(false);
	});
});
