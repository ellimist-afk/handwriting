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
 *
 * Ink drawn on a PDF while its ink file could not be read is owed until a write of
 * it lands, whatever lock the file is under by then. It is pending at quit on its
 * own: the quit task reads each owed file once more, and a sound read saves the ink
 * merged with the file before the task resolves. Those cases use a real PDF store
 * over the same page store, with real damaged and newer-version bytes; a read that
 * throws or never lands is injected at the store's load.
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
import { emptyPage, parsePage, serializePage } from "./model/PageData";
import { computeBBox, type InkStroke } from "./ink/Stroke";
import { inlineInk } from "./inline/InkOverlayRegistry";
import { PdfInkStore } from "./pdf/PdfInkStore";

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

const OWED_PDF = "quit-owed-pdf";
const DAMAGED_BYTES = "{ this is not an ink file";
const NEWER_SCHEMA = 99;

function pdfFile(id: string, version: number | undefined, ...strokeIds: string[]): string {
	const page = { ...emptyPage(id), surface: "pdf" as const, strokes: strokeIds.map((s) => stroke(s)) };
	return version === undefined ? serializePage(page) : serializePage(page, version);
}

/** Let queued promise callbacks run: twenty microtask turns, no timer. */
const drain = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

type Fault = "throw" | "hang";
/** Reads that never land; each finishes, with no file, when its case is over. */
const hung: Array<() => void> = [];

/** The device above with a real PDF store over its page store, wired as PluginSettings wires it. */
function pdfDevice() {
	const d = device();
	const pdfStore = new PdfInkStore();
	const reads: string[] = [];
	const faults = new Map<string, Fault[]>();
	pdfStore.attachHost({
		load: async (id, options) => {
			reads.push(id);
			const fault = faults.get(id)?.shift();
			if (fault === "throw") throw new Error(`the read of ${id} failed`);
			if (fault === "hang") {
				await new Promise<void>((resolve) => hung.push(resolve));
				return null;
			}
			return d.store.load(id, options);
		},
		schedule: (id, data) => d.store.schedule(id, data),
		notice: () => {},
	});
	Object.assign(d.plugin, { pdfStore });
	return {
		...d,
		pdfStore,
		reads,
		faults,
		put: (id: string, text: string): void => d.adapter.externalWrite(d.store.path(id), text),
		bytes: (id: string): string | undefined => d.adapter.files.get(d.store.path(id)),
		/** The stroke ids the file holds now; null with no file. */
		inFile: (id: string): string[] | null => {
			const text = d.adapter.files.get(d.store.path(id));
			return text === undefined ? null : parsePage(text, id).data.strokes.map((s) => s.id);
		},
	};
}
type PdfDevice = ReturnType<typeof pdfDevice>;

/** The first read finds the file damaged, then a stroke is drawn: owed, since nothing may be written. */
async function owe(d: PdfDevice, id: string): Promise<void> {
	d.put(id, DAMAGED_BYTES);
	await d.pdfStore.ensureLoaded(id);
	expect(d.pdfStore.inkReady(id), "precondition: the damaged read locked the PDF").toBe(false);
	d.pdfStore.commit(id, stroke(`drawn-${id}`));
	expect(d.pdfStore.lockedWithUnsavedInk(), "precondition: the stroke is owed").toContain(id);
}

/** Obsidian's quit, watched: the tasks, how the task list went, and what each file held the moment it resolved. */
function quitAndWatch(d: PdfDevice, ...ids: string[]) {
	const tasks = d.quit();
	const atEnd: Record<string, string[] | null> = {};
	const state = watch(
		tasks.promise().then(() => {
			for (const id of ids) atEnd[id] = d.inFile(id);
		})
	);
	return { tasks, state, atEnd };
}

describe("closing Obsidian with ink owed on a PDF whose ink file could not be read", () => {
	afterEach(async () => {
		for (const finish of hung.splice(0)) finish();
		await vi.advanceTimersByTimeAsync(100);
	});

	it("Q1 the file reads sound at quit: one task, and the merged page is in the file when it resolves, inside the cap", async () => {
		const d = pdfDevice();
		await owe(d, OWED_PDF);
		d.put(OWED_PDF, pdfFile(OWED_PDF, undefined, "old"));

		const q = quitAndWatch(d, OWED_PDF);
		expect(q.tasks.list.length, "owed ink on a PDF added no quit task").toBe(1);
		await vi.advanceTimersByTimeAsync(CAP_MS - 1);

		expect(q.state.resolved, "the quit task must finish on the read and the write, not on the cap").toBe(true);
		expect(q.atEnd[OWED_PDF], "the owed ink was not in the file, merged with the file's stroke, when the task resolved")
			.toEqual(["old", `drawn-${OWED_PDF}`]);
	});

	it("Q2 the file is still damaged at quit: one task, nothing written, and the task resolves", async () => {
		const d = pdfDevice();
		await owe(d, OWED_PDF);
		const before = d.bytes(OWED_PDF);

		const q = quitAndWatch(d, OWED_PDF);
		expect(q.tasks.list.length, "owed ink on a PDF added no quit task").toBe(1);
		await vi.advanceTimersByTimeAsync(CAP_MS - 1);

		expect(q.state.resolved, "the quit task did not finish").toBe(true);
		expect(q.state.rejected, "a rejected quit task stops Obsidian's close").toBe(false);
		expect(d.bytes(OWED_PDF), "the damaged file was written over").toBe(before);
	});

	it("Q3 the read at quit never lands: one task, resolved by the cap, never rejected, nothing written", async () => {
		const d = pdfDevice();
		await owe(d, OWED_PDF);
		d.faults.set(OWED_PDF, ["hang"]);
		const before = d.bytes(OWED_PDF);

		const q = quitAndWatch(d, OWED_PDF);
		expect(q.tasks.list.length, "owed ink on a PDF added no quit task").toBe(1);
		await vi.advanceTimersByTimeAsync(CAP_MS);

		expect(q.state.resolved, "a read that never lands held the window on Saving past the cap").toBe(true);
		expect(q.state.rejected, "a rejected quit task stops Obsidian's close").toBe(false);
		expect(d.bytes(OWED_PDF), "the damaged file was written over").toBe(before);
	});

	for (const withStrokes of [true, false]) {
		it(`Q4${withStrokes ? "s" : "z"} a later read finds a newer version's file ${withStrokes ? "with strokes" : "with none"}: still one task`, async () => {
			const d = pdfDevice();
			await owe(d, OWED_PDF);
			d.put(OWED_PDF, withStrokes ? pdfFile(OWED_PDF, NEWER_SCHEMA, "old") : pdfFile(OWED_PDF, NEWER_SCHEMA));
			await d.pdfStore.reloadExternal(OWED_PDF);
			await drain();
			expect(d.pdfStore.inkReady(OWED_PDF), "precondition: the newer version's file keeps the PDF locked").toBe(false);
			const before = d.bytes(OWED_PDF);

			const q = quitAndWatch(d, OWED_PDF);
			expect(q.tasks.list.length, "ink owed under the newer-version lock added no quit task").toBe(1);
			await vi.advanceTimersByTimeAsync(CAP_MS);

			expect(q.state.resolved, "the quit task did not finish").toBe(true);
			expect(d.bytes(OWED_PDF), "a newer version's file was written").toBe(before);
		});
	}

	it("Q5 control: a newer version's file from the first read, then a stroke: no task", async () => {
		const d = pdfDevice();
		d.put(OWED_PDF, pdfFile(OWED_PDF, NEWER_SCHEMA, "old"));
		await d.pdfStore.ensureLoaded(OWED_PDF);
		expect(d.pdfStore.inkReady(OWED_PDF), "precondition: the newer version's file locks the PDF").toBe(false);
		d.pdfStore.commit(OWED_PDF, stroke("drawn"));

		const tasks = d.quit();

		expect(tasks.list.length, "ink never owed under the unreadable lock held the window on Saving").toBe(0);
	});

	it("Q6 two owed PDFs, the first read throws: the second is in its file when the task resolves", async () => {
		const d = pdfDevice();
		const first = "quit-owed-first", second = "quit-owed-second";
		await owe(d, first);
		await owe(d, second);
		expect(d.pdfStore.lockedWithUnsavedInk(), "precondition: the throwing read is the first one made").toEqual([first, second]);
		d.faults.set(first, ["throw"]);
		d.put(second, pdfFile(second, undefined, "old"));

		const q = quitAndWatch(d, first, second);
		expect(q.tasks.list.length, "owed ink on a PDF added no quit task").toBe(1);
		await vi.advanceTimersByTimeAsync(CAP_MS - 1);

		expect(q.state.resolved, "the quit task did not finish").toBe(true);
		expect(q.atEnd[second], "a read that threw on one PDF stopped another PDF's save").toEqual(["old", `drawn-${second}`]);
	});
});
