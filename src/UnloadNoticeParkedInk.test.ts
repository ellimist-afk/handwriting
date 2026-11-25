/**
 * The unload notice speaks only for ink that is waiting.
 *
 * `finishPersistence` tells the user "the newest ink may not have been saved" when a settle gives up at its deadline.
 * A settle gives up whenever any read is still in flight at the deadline, also when nothing was drawn behind that read,
 * so a slow sidecar read at quit raised the notice with no ink at risk. A false alarm teaches the user to ignore the
 * notice that matters.
 *
 * Real `finishPersistence`, the real inline ink store (the registry's) and a real PDF store, each over a host whose
 * sidecar read never finishes. Substituted: the slides settle (finishes), the settings flush, and `Notice`, which
 * records. The page store is real, over a `FakeAdapter`, with nothing queued.
 *
 *   - a read in flight past the deadline with no stroke behind it: no notice (inline, and PDF);
 *   - control: a stroke drawn behind that read: the notice, once (inline, and PDF).
 *
 * Ink drawn on a PDF while its ink file could not be read is owed: nothing was written. It stays owed until a write of
 * it lands, whatever lock the file is under by then. Unload reads each owed file once more: a sound read saves the ink
 * merged with the file before unload ends; anything else leaves it owed, and the same notice says so. The PDF store is
 * real over the real page store and a `FakeAdapter`, wired as the plugin wires it; damaged and newer-version files are
 * real bytes. A read that throws or never lands is injected at the store's load, because the page store turns a
 * failed adapter read into a damaged answer.
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
}));

import HandwritingPlugin from "./main";
import { PageStore } from "./persistence/PageStore";
import { FakeAdapter } from "./persistence/FakeAdapter";
import { computeBBox, type InkStroke } from "./ink/Stroke";
import { inlineInk } from "./inline/InkOverlayRegistry";
import { PdfInkStore } from "./pdf/PdfInkStore";
import { emptyPage, parsePage, serializePage } from "./model/PageData";

function stroke(id: string): InkStroke {
	const points = [{ x: 10, y: 20, pressure: 0.5, t: 0 }, { x: 20, y: 30, pressure: 0.6, t: 4 }];
	return { id, tool: "pen", color: "#000000", width: 2, createdAt: 7, points, bbox: computeBBox(points, 4), page: 1 };
}

/** Every read the hosts started; each finishes (with no file) only when the case is over. */
const hung: Array<() => void> = [];
function never<T>(): Promise<T | null> {
	return new Promise<T | null>((resolve) => hung.push(() => resolve(null)));
}

let n = 0;
function device() {
	n++;
	const notePath = `slow-${n}.md`, notePage = `slow-note-${n}`, pdfId = `slow-pdf-${n}`;
	const store = new PageStore({ vault: { adapter: new FakeAdapter() } } as never);
	inlineInk.attachHost({
		readPageId: (p: string) => (p === notePath ? notePage : null),
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: () => never(),
		scheduleSidecar: () => {},
		notify: () => {},
	});
	const pdfStore = new PdfInkStore();
	pdfStore.attachHost({ load: () => never(), schedule: () => {}, notice: () => {} });
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown> & { finishPersistence(): Promise<void> };
	Object.assign(plugin, { store, pdfStore, flushSettings: async () => {} });
	return { plugin, pdfStore, notePath, pdfId };
}

async function quit(plugin: { finishPersistence(): Promise<void> }): Promise<void> {
	const done = plugin.finishPersistence();
	// Past both 2000 ms deadlines, inline and PDF, which run one after the other.
	await vi.advanceTimersByTimeAsync(6000);
	await done;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	vi.spyOn(console, "error").mockImplementation(() => {});
	signals.notices.length = 0;
});
afterEach(async () => {
	// Let every read finish, so nothing a case left waiting is seen by the next one.
	for (const finish of hung.splice(0)) finish();
	await vi.advanceTimersByTimeAsync(100);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("the unload notice when a sidecar read is still in flight at quit", () => {
	it("a note's read is still in flight and nothing was drawn behind it: no notice", async () => {
		const d = device();
		void inlineInk.ensureLoaded(d.notePath);
		expect(inlineInk.record(d.notePath).loadInFlight, "premise: the note's read is in flight").not.toBeNull();

		await quit(d.plugin);

		expect(signals.notices, "no ink was waiting, so nothing may be said").toEqual([]);
	});

	it("a PDF's read is still in flight and nothing was drawn behind it: no notice", async () => {
		const d = device();
		void d.pdfStore.ensureLoaded(d.pdfId);
		expect((d.pdfStore as unknown as { byId: Map<string, { loadInFlight: unknown }> }).byId.get(d.pdfId)?.loadInFlight,
			"premise: the PDF's read is in flight").toBeTruthy();

		await quit(d.plugin);

		expect(signals.notices, "no ink was waiting, so nothing may be said").toEqual([]);
	});

	it("control: a stroke drawn on a note behind its read: the user is told, once", async () => {
		const d = device();
		void inlineInk.ensureLoaded(d.notePath);
		inlineInk.commit(d.notePath, stroke("behind-the-read"));

		await quit(d.plugin);

		expect(signals.notices.length, "a stroke waiting on a read that never landed is unsaved").toBe(1);
	});

	it("control: a stroke drawn on a PDF behind its read: the user is told, once", async () => {
		const d = device();
		void d.pdfStore.ensureLoaded(d.pdfId);
		d.pdfStore.commit(d.pdfId, stroke("behind-the-read"));

		await quit(d.plugin);

		expect(signals.notices.length, "a stroke waiting on a read that never landed is unsaved").toBe(1);
	});
});

const MAY_NOT_BE_SAVED =
	"Handwriting: the newest ink may not have been saved. Open the note and check it before you close Obsidian.";
const UNREADABLE = "Handwriting: this PDF's ink file could not be read yet. New ink on it is not saved until it loads.";
const NEWER = "Handwriting: this PDF's ink was written by a newer version of Handwriting. ink drawn on it is not saved.";
const DAMAGED_BYTES = "{ this is not an ink file";
const NEWER_SCHEMA = 99;
const PDF = "owed-pdf";

function pdfFile(id: string, version: number | undefined, ...strokeIds: string[]): string {
	const page = { ...emptyPage(id), surface: "pdf" as const, strokes: strokeIds.map((s) => stroke(s)) };
	return version === undefined ? serializePage(page) : serializePage(page, version);
}

/** Let queued promise callbacks run: twenty microtask turns, no timer. */
const drain = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

type Fault = "throw" | "hang" | "hold";

/**
 * A desktop with a real PDF store over the real page store, wired as PluginSettings wires it. `faults` takes the next
 * read of an id: it throws, never lands, or waits for `release`. Every other read is the page store's, of the bytes in
 * the fake vault.
 */
function pdfDevice() {
	const adapter = new FakeAdapter();
	const store = new PageStore({ vault: { adapter } } as never);
	const pdfStore = new PdfInkStore();
	const reads: string[] = [];
	const storeNotices: string[] = [];
	const faults = new Map<string, Fault[]>();
	const held: Array<() => void> = [];
	pdfStore.attachHost({
		load: async (id, options) => {
			reads.push(id);
			const fault = faults.get(id)?.shift();
			if (fault === "throw") throw new Error(`the read of ${id} failed`);
			if (fault === "hang") {
				await new Promise<void>((resolve) => hung.push(resolve));
				return null;
			}
			if (fault === "hold") await new Promise<void>((resolve) => held.push(resolve));
			return store.load(id, options);
		},
		schedule: (id, data) => store.schedule(id, data),
		notice: (message) => void storeNotices.push(message),
	});
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown> & { finishPersistence(): Promise<void> };
	Object.assign(plugin, { store, pdfStore, flushSettings: async () => {} });
	return {
		adapter,
		store,
		pdfStore,
		plugin,
		reads,
		storeNotices,
		faults,
		release: (): void => {
			for (const go of held.splice(0)) go();
		},
		put: (id: string, text: string): void => adapter.externalWrite(store.path(id), text),
		bytes: (id: string): string | undefined => adapter.files.get(store.path(id)),
		/** The stroke ids the file holds now; null with no file. */
		inFile: (id: string): string[] | null => {
			const text = adapter.files.get(store.path(id));
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

/** The real finishPersistence, run past every deadline. What each file held at the moment it resolved. */
async function unload(d: PdfDevice, ...ids: string[]): Promise<Record<string, string[] | null>> {
	const atEnd: Record<string, string[] | null> = {};
	const done = d.plugin.finishPersistence().then(() => {
		for (const id of ids) atEnd[id] = d.inFile(id);
	});
	await vi.advanceTimersByTimeAsync(6000);
	await done;
	return atEnd;
}

const mayNotCount = (): number => signals.notices.filter((n) => n === MAY_NOT_BE_SAVED).length;

describe("unload with ink owed on a PDF whose ink file could not be read", () => {
	it("U1 the file reads sound at unload: the merged page is in the file when unload ends, and nothing is said", async () => {
		const d = pdfDevice();
		await owe(d, PDF);
		d.put(PDF, pdfFile(PDF, undefined, "old"));
		const readsBefore = d.reads.length;

		const atEnd = await unload(d, PDF);

		expect(atEnd[PDF], "the owed ink was not in the file, merged with the file's stroke, when unload ended")
			.toEqual(["old", `drawn-${PDF}`]);
		expect(signals.notices, "the owed ink was saved, so nothing may be said").toEqual([]);
		expect(d.reads.length - readsBefore, "unload reads an owed file exactly once more").toBe(1);
	});

	it("U2 the file is still damaged at unload: the notice, once, and the damaged file is not written", async () => {
		const d = pdfDevice();
		await owe(d, PDF);
		const before = d.bytes(PDF);
		const readsBefore = d.reads.length;

		await unload(d, PDF);

		expect(signals.notices, "owed ink went at unload without a word").toEqual([MAY_NOT_BE_SAVED]);
		expect(d.bytes(PDF), "the damaged file was written over").toBe(before);
		expect(d.reads.length - readsBefore, "unload reads an owed file exactly once more").toBe(1);
		expect(d.storeNotices, "a second damaged read said the unreadable notice again").toEqual([UNREADABLE]);
	});

	it("U3 the read at unload never lands: the notice, once, after the PDF settle gives up", async () => {
		const d = pdfDevice();
		await owe(d, PDF);
		d.faults.set(PDF, ["hang"]);
		const before = d.bytes(PDF);

		await unload(d, PDF);

		expect(signals.notices, "owed ink behind a read that never landed went without a word").toEqual([MAY_NOT_BE_SAVED]);
		expect(d.bytes(PDF), "the damaged file was written over").toBe(before);
	});

	it("U4 two owed PDFs, the first read throws: the second is still saved, and the notice shows for the first", async () => {
		const d = pdfDevice();
		const first = "owed-first", second = "owed-second";
		await owe(d, first);
		await owe(d, second);
		expect(d.pdfStore.lockedWithUnsavedInk(), "precondition: the throwing read is the first one made").toEqual([first, second]);
		d.faults.set(first, ["throw"]);
		d.put(second, pdfFile(second, undefined, "old"));

		const atEnd = await unload(d, first, second);

		expect(atEnd[second], "a read that threw on one PDF stopped another PDF's save").toEqual(["old", `drawn-${second}`]);
		expect(signals.notices, "the first PDF's ink is still owed and nothing said so").toEqual([MAY_NOT_BE_SAVED]);
	});

	it("U5s control: the poll's read is already out at unload and lands sound: saved by the end, no new read, nothing said", async () => {
		const d = pdfDevice();
		await owe(d, PDF);
		d.put(PDF, pdfFile(PDF, undefined, "old"));
		d.faults.set(PDF, ["hold"]);
		const poll = d.pdfStore.reloadExternal(PDF);
		const readsBefore = d.reads.length;

		let atEnd: string[] | null | undefined;
		const done = d.plugin.finishPersistence().then(() => {
			atEnd = d.inFile(PDF);
		});
		d.release();
		await vi.advanceTimersByTimeAsync(6000);
		await done;
		await poll;

		expect(atEnd, "the read already out landed sound and its save was not in the file when unload ended")
			.toEqual(["old", `drawn-${PDF}`]);
		expect(signals.notices, "the owed ink was saved, so nothing may be said").toEqual([]);
		expect(d.reads.length - readsBefore, "unload read the file again while a read of it was out").toBe(0);
	});

	it("U5d the poll's read is already out at unload and lands damaged: the notice, once", async () => {
		const d = pdfDevice();
		await owe(d, PDF);
		d.faults.set(PDF, ["hold"]);
		const poll = d.pdfStore.reloadExternal(PDF);
		const before = d.bytes(PDF);
		const readsBefore = d.reads.length;

		const done = d.plugin.finishPersistence();
		d.release();
		await vi.advanceTimersByTimeAsync(6000);
		await done;
		await poll;

		expect(signals.notices, "owed ink went at unload without a word").toEqual([MAY_NOT_BE_SAVED]);
		expect(d.bytes(PDF), "the damaged file was written over").toBe(before);
		expect(d.reads.length - readsBefore, "unload read the file again while a read of it was out").toBe(0);
	});

	it("U6a a later read finds a newer version's file with strokes: the ink is still owed at unload, and both lock notices showed", async () => {
		const d = pdfDevice();
		await owe(d, PDF);
		d.put(PDF, pdfFile(PDF, NEWER_SCHEMA, "old"));
		await d.pdfStore.reloadExternal(PDF);
		await drain();
		expect(d.pdfStore.inkReady(PDF), "precondition: the newer version's file keeps the PDF locked").toBe(false);
		const before = d.bytes(PDF);

		await unload(d, PDF);

		expect(signals.notices, "ink owed under the newer-version lock went at unload without a word").toEqual([MAY_NOT_BE_SAVED]);
		expect(d.bytes(PDF), "a newer version's file was written").toBe(before);
		expect(d.storeNotices, "each lock says its own notice, once").toEqual([UNREADABLE, NEWER]);
	});

	it("U6b unload's own read finds a newer version's file with strokes: the notice, nothing written, both lock notices", async () => {
		const d = pdfDevice();
		await owe(d, PDF);
		d.put(PDF, pdfFile(PDF, NEWER_SCHEMA, "old"));
		const before = d.bytes(PDF);
		const readsBefore = d.reads.length;

		await unload(d, PDF);

		expect(signals.notices, "ink owed under the newer-version lock went at unload without a word").toEqual([MAY_NOT_BE_SAVED]);
		expect(d.bytes(PDF), "a newer version's file was written").toBe(before);
		expect(d.reads.length - readsBefore, "unload reads an owed file exactly once more").toBe(1);
		expect(d.storeNotices, "each lock says its own notice, once").toEqual([UNREADABLE, NEWER]);
	});

	it("U7 a later read finds a newer version's file with no strokes: the ink is still owed at unload", async () => {
		const d = pdfDevice();
		await owe(d, PDF);
		d.put(PDF, pdfFile(PDF, NEWER_SCHEMA));
		await d.pdfStore.reloadExternal(PDF);
		await drain();
		expect(d.pdfStore.inkReady(PDF), "precondition: the newer version's file keeps the PDF locked").toBe(false);
		const before = d.bytes(PDF);

		await unload(d, PDF);

		expect(signals.notices, "ink owed under the newer-version lock went at unload without a word").toEqual([MAY_NOT_BE_SAVED]);
		expect(d.bytes(PDF), "a newer version's file was written").toBe(before);
	});

	it("U8q control: a sound read before unload, its write still queued: in the file when unload ends, nothing said", async () => {
		const d = pdfDevice();
		await owe(d, PDF);
		d.put(PDF, pdfFile(PDF, undefined, "old"));
		await d.pdfStore.reloadExternal(PDF);
		await drain();
		expect(d.store.hasQueuedWrite(PDF), "precondition: the save is queued, not landed").toBe(true);

		const atEnd = await unload(d, PDF);

		expect(atEnd[PDF], "the queued save was not in the file when unload ended").toEqual(["old", `drawn-${PDF}`]);
		expect(signals.notices, "the save landed, so nothing may be said").toEqual([]);
	});

	it("U8f control: a sound read before unload, its write fails at unload: the notice, once", async () => {
		const d = pdfDevice();
		await owe(d, PDF);
		d.put(PDF, pdfFile(PDF, undefined, "old"));
		await d.pdfStore.reloadExternal(PDF);
		await drain();
		expect(d.store.hasQueuedWrite(PDF), "precondition: the save is queued, not landed").toBe(true);
		d.adapter.failWriteTimes = 1000;

		await unload(d, PDF);

		expect(mayNotCount(), "a save that did not land went without a word").toBe(1);
	});

	it("U9 control: a newer version's file from the first read, then a stroke: no read more, no unload notice", async () => {
		const d = pdfDevice();
		d.put(PDF, pdfFile(PDF, NEWER_SCHEMA, "old"));
		await d.pdfStore.ensureLoaded(PDF);
		expect(d.pdfStore.inkReady(PDF), "precondition: the newer version's file locks the PDF").toBe(false);
		d.pdfStore.commit(PDF, stroke("drawn"));
		const before = d.bytes(PDF);
		const readsBefore = d.reads.length;

		await unload(d, PDF);

		expect(signals.notices, "ink never owed under the unreadable lock changed the unload notice").toEqual([]);
		expect(d.reads.length - readsBefore, "unload read a file that owed nothing").toBe(0);
		expect(d.bytes(PDF), "a newer version's file was written").toBe(before);
		expect(d.storeNotices, "the newer-version notice is said once").toEqual([NEWER]);
	});

	it("U10 a rename under the lock, nothing drawn, the file still damaged at unload: the notice (the shipped words)", async () => {
		const d = pdfDevice();
		d.put(PDF, DAMAGED_BYTES);
		await d.pdfStore.ensureLoaded(PDF);
		expect(d.pdfStore.inkReady(PDF), "precondition: the damaged read locked the PDF").toBe(false);
		d.pdfStore.renamePath(PDF, "Old name.pdf", "New name.pdf");
		expect(d.pdfStore.lockedWithUnsavedInk(), "precondition: the move is owed").toContain(PDF);
		expect(d.pdfStore.strokes(PDF), "precondition: nothing was drawn").toEqual([]);
		const before = d.bytes(PDF);

		await unload(d, PDF);

		expect(signals.notices, "an owed move went at unload without a word").toEqual([MAY_NOT_BE_SAVED]);
		expect(d.bytes(PDF), "the damaged file was written over").toBe(before);
	});

	it("U11 control: the file is damaged and nothing was changed: no read more, nothing said", async () => {
		const d = pdfDevice();
		d.put(PDF, DAMAGED_BYTES);
		await d.pdfStore.ensureLoaded(PDF);
		expect(d.pdfStore.inkReady(PDF), "precondition: the damaged read locked the PDF").toBe(false);
		const readsBefore = d.reads.length;

		await unload(d, PDF);

		expect(signals.notices, "nothing was owed, so nothing may be said").toEqual([]);
		expect(d.reads.length - readsBefore, "unload read a file that owed nothing").toBe(0);
	});
});
