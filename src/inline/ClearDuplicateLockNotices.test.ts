/**
 * A note and its copy carry the same page id, and only the copy is duplicate-locked. Both are open on the shared page.
 * The original is deleted, and the delete's clear reads the shared file again before the copy saves. Every notice the
 * user hears from the clear on is true when it shows, in this order:
 * - "duplicate resolved ... saves again" once, only after the read has landed and the note can save;
 * - a damaged file: its own notice alone;
 * - a read that throws while the copy holds ink not yet saved: "could not be read yet" at once, and "readable again"
 *   when a later read heals it; with nothing unsaved, nothing at the throw or at the heal;
 * - locked again during the read: the lock notice again, no "saves again"; cleared again before the read lands: one
 *   "saves again", after the read; locked again after that: the lock notice again, and the lock stands; that read
 *   throwing with ink drawn while locked: "could not be read yet", and no "saves again";
 * - the copy deleted during the read: nothing.
 * A clear on a copy never read speaks and saves at once, as before. With the clear's read in flight, settle waits for it,
 * and a dispatch after settle writes the copy's ink (the hide, quit and unload paths).
 *
 * Real InlineInkStore (the plugin's), real PageStore over FakeAdapter, the real delete handler on a plugin built without
 * its constructor. The delete runs as Obsidian runs it: the plugin's handler first, then the inline store's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import HandwritingPlugin from "../main";
import { inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkStroke } from "../ink/Stroke";

const N = "Original.md";
const C = "Original 1.md";
const X = "shared-id";
const FILE = `.handwriting/${X}.json`;

function stroke(id: string, x = 10): InkStroke {
	return {
		id,
		color: "#000",
		width: 2,
		tool: "pen",
		points: [
			{ x, y: 10, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: x - 2, y: 8, width: 16, height: 16 },
		createdAt: 1,
	} as InkStroke;
}

const ids = (list: readonly { id: string }[]): string[] => list.map((s) => s.id);

/** Lets every read the current rig holds go on (afterEach). */
let releaseHeld = (): void => undefined;

/** A notice by what it tells the user. */
function kind(m: string): string {
	if (m.includes("carry the same handwriting-page-id")) return "locked";
	if (m.includes("duplicate resolved")) return "saves again";
	if (m.includes("could not be read yet")) return "not read yet";
	if (m.includes("cannot read the saved ink")) return "damaged";
	if (m.includes("readable again")) return "readable again";
	return m;
}

/**
 * Two notes on one id, the shared file holding p0. Saves and file reads are counted as the store is asked for them.
 * `hold` keeps every file read waiting until `release`; `throwNext` makes the next read of the shared file throw in the
 * adapter, as a busy disk or a sync client mid-write does, so the store answers that the file is not readable yet.
 */
function rig() {
	const fake = new FakeAdapter();
	let throwing = false;
	const read = fake.read.bind(fake);
	fake.read = async (path: string): Promise<string> => {
		if (throwing && path === FILE) {
			throwing = false;
			throw new Error("EBUSY: the ink file is being written");
		}
		return read(path);
	};
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const shared = emptyPage(X);
	shared.surface = "inline";
	shared.strokes = [stroke("p0", 5)];
	fake.files.set(FILE, serializePage(shared));
	let holding = false;
	const waiting: Array<() => void> = [];
	const files = new Map<string, TFile>();
	for (const path of [N, C]) files.set(path, Object.assign(new TFile(), { path, extension: "md", basename: path.slice(0, -3) }));
	// Obsidian's delete event fires while the metadata cache still holds the deleted note's frontmatter; the vault
	// listing no longer has the file.
	const listed = new Set([N, C]);
	const cache = (path: string) => (files.has(path) ? { frontmatter: { "handwriting-page-id": X }, sections: [{ type: "yaml" }] } : null);
	const notices: string[] = [];
	const saves: string[] = [];
	const reads: string[] = [];
	const plugin: any = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		pageIdWatchReady: false,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		settings: { pageOwners: {}, cameras: {} },
		store,
		app: {
			vault: {
				adapter: fake,
				getFileByPath: (p: string) => (listed.has(p) ? files.get(p)! : null),
				getAbstractFileByPath: (p: string) => (listed.has(p) ? files.get(p)! : null),
				getMarkdownFiles: () => [...listed].map((p) => files.get(p)!),
				getFiles: () => [...listed].map((p) => files.get(p)!),
			},
			metadataCache: {
				getCache: (p: string) => cache(p),
				getFileCache: (f: { path: string }) => cache(f.path),
			},
		},
	});
	const host: InlineInkHost = {
		readPageId: (path) => plugin.notePageId(path),
		claimId: (path, proposedId) => plugin.claimNotePageId(path, proposedId),
		loadSidecar: async (pageId) => {
			reads.push(pageId);
			if (holding) await new Promise<void>((go) => waiting.push(go));
			return store.load(pageId);
		},
		scheduleSidecar: (pageId, page) => {
			saves.push(pageId);
			store.schedule(pageId, page);
		},
		scheduleSidecarNow: (pageId, page) => {
			saves.push(pageId);
			return store.saveNow(pageId, page);
		},
		sidecarLanded: (page) => store.hasLanded(page),
		notify: (m) => void notices.push(m),
	};
	inlineInk.attachHost(host);
	const onDisk = (): string[] | null => {
		const t = fake.files.get(FILE);
		return t === undefined ? null : ids(parsePage(t, X).data.strokes);
	};
	/** The notices since `from`, each by what it tells. */
	const said = (from: number): string[] => notices.slice(from).map(kind);
	const hold = (): void => {
		holding = true;
	};
	const release = (): void => {
		holding = false;
		for (const go of waiting.splice(0)) go();
	};
	releaseHeld = release;
	const held = (): number => waiting.length;
	const throwNext = (): void => {
		throwing = true;
	};
	/** The original is deleted: the plugin's delete handler, then the inline store's, as Obsidian calls them. */
	const deleteOriginal = async (): Promise<void> => {
		listed.delete(N);
		const handled = plugin.onFileDeleted(files.get(N));
		inlineInk.handleDelete(N);
		await handled;
	};
	const drain = async (): Promise<void> => {
		for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(2000);
		await store.flush();
		for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(2000);
	};
	return { store, fake, notices, saves, reads, onDisk, said, hold, release, held, throwNext, deleteOriginal, drain };
}

/** The copy locked alone, as a failed repair leaves it; both notes open on the shared page. */
async function lockedCopyOpen(r: ReturnType<typeof rig>): Promise<void> {
	inlineInk.markDuplicateLocked(C, N);
	await inlineInk.ensureLoaded(C);
	await inlineInk.ensureLoaded(N);
	expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
	expect(inlineInk.isDuplicateLocked(N), "precondition: the original is writable").toBe(false);
	expect(ids(inlineInk.strokes(C)), "precondition: the copy loaded the shared page").toEqual(["p0"]);
	expect(r.said(0), "precondition: the lock notice, alone").toEqual(["locked"]);
}

/** The copy locked and open, with a stroke drawn on it while locked that the lock kept from the file. */
async function lockedCopyDrew(r: ReturnType<typeof rig>): Promise<void> {
	await lockedCopyOpen(r);
	const before = r.saves.length;
	inlineInk.commit(C, stroke("c1", 70));
	await r.drain();
	expect(r.saves.length - before, "precondition: the lock refused the copy's save").toBe(0);
	expect(r.onDisk(), "precondition: the copy's stroke is not in the file").toEqual(["p0"]);
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(async () => {
	// A cell that fails while a read is held leaves it waiting in the shared store, and a later settle would wait on it.
	releaseHeld();
	await vi.advanceTimersByTimeAsync(4000);
	vi.useRealTimers();
	inlineInk.handleDelete(N);
	inlineInk.handleDelete(C);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("a duplicate lock cleared on an open copy tells the user only what is true, when it is true", () => {
	it("a read that lands: \"saves again\" once, only after the read, and the copy's stroke is saved", async () => {
		const r = rig();
		await lockedCopyDrew(r);
		const from = r.notices.length;
		r.hold();

		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		expect(r.held(), "precondition: the clear's read is waiting").toBe(1);
		expect(r.said(from), "a notice showed before the clear's read landed").toEqual([]);
		r.release();
		await r.drain();

		expect(r.said(from), "the notices from the clear on").toEqual(["saves again"]);
		expect(inlineInk.isDuplicateLocked(C), "the copy is still locked").toBe(false);
		expect(r.onDisk(), "the copy's stroke was not saved").toEqual(["p0", "c1"]);
	});

	it("the file is damaged at the clear: the damage notice alone, and nothing written", async () => {
		const r = rig();
		await lockedCopyDrew(r);
		const unreadable = "{ not an ink file";
		r.fake.files.set(FILE, unreadable);
		const from = r.notices.length;
		const before = r.saves.length;

		await r.deleteOriginal();
		await r.drain();

		expect(r.said(from), "the notices from the clear on").toEqual(["damaged"]);
		expect(r.saves.length - before, "the clear scheduled a save over a file it could not read").toBe(0);
		expect(r.fake.files.get(FILE), "the damaged file was written").toBe(unreadable);
		expect(ids(inlineInk.strokes(C)), "the copy's ink left memory").toEqual(["p0", "c1"]);
	});

	it("the read throws with ink drawn while locked: \"could not be read yet\" at once, and nothing written", async () => {
		const r = rig();
		await lockedCopyDrew(r);
		const from = r.notices.length;
		const before = r.saves.length;
		r.throwNext();

		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		expect(inlineInk.isDamagedLocked(C), "precondition: the clear's read threw and holds the copy").toBe(true);
		expect(r.said(from), "the notices at the clear's read").toEqual(["not read yet"]);
		await r.drain();

		expect(r.said(from), "the notices from the clear on").toEqual(["not read yet"]);
		expect(r.saves.length - before, "the clear scheduled a save over a file it could not read").toBe(0);
		expect(r.onDisk(), "the file changed").toEqual(["p0"]);
		expect(ids(inlineInk.strokes(C)), "the copy's ink left memory").toEqual(["p0", "c1"]);
	});

	it("the read throws with ink drawn while locked, then a reopen's read heals it: \"could not be read yet\", then \"readable again\", and the ink is saved", async () => {
		const r = rig();
		await lockedCopyDrew(r);
		const from = r.notices.length;
		r.throwNext();
		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDamagedLocked(C), "precondition: the clear's read threw and holds the copy").toBe(true);

		await inlineInk.ensureLoaded(C);
		await r.drain();

		expect(inlineInk.isDamagedLocked(C), "precondition: the read healed").toBe(false);
		expect(r.said(from), "the notices from the clear on").toEqual(["not read yet", "readable again"]);
		expect(r.onDisk(), "the copy's ink was not saved at the heal").toEqual(["p0", "c1"]);
	});

	it("a copy that saved its ink before the lock and drew nothing while locked: a read that throws says nothing, and so does its heal", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		inlineInk.commit(C, stroke("c0", 70));
		await r.drain();
		expect(r.onDisk(), "precondition: the copy's stroke reached the file before its lock").toEqual(["p0", "c0"]);
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		const from = r.notices.length;
		r.throwNext();

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDamagedLocked(C), "precondition: the clear's read threw and holds the copy").toBe(true);
		expect(r.said(from), "the notices at the clear's read, with nothing unsaved").toEqual([]);

		await inlineInk.ensureLoaded(C);
		await r.drain();

		expect(inlineInk.isDamagedLocked(C), "precondition: the read healed").toBe(false);
		expect(r.said(from), "the notices from the clear on, with nothing unsaved").toEqual([]);
		expect(r.onDisk(), "the file lost a stroke").toEqual(["p0", "c0"]);
	});

	it("locked again while the clear reads the file: the lock notice again, and no \"saves again\"", async () => {
		const r = rig();
		await lockedCopyDrew(r);
		const from = r.notices.length;
		const before = r.saves.length;
		r.hold();

		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		inlineInk.markDuplicateLocked(C, "Original 2.md");
		r.release();
		await r.drain();

		expect(r.said(from), "the notices from the clear on").toEqual(["locked"]);
		expect(inlineInk.isDuplicateLocked(C), "the copy locked again was left unlocked").toBe(true);
		expect(r.saves.length - before, "a copy locked again was written").toBe(0);
	});

	it("locked again and cleared again while the clear reads the file: one \"saves again\", only after the read, and the copy's stroke is saved", async () => {
		const r = rig();
		await lockedCopyDrew(r);
		const from = r.notices.length;
		r.hold();

		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		inlineInk.markDuplicateLocked(C, "Original 2.md");
		inlineInk.clearDuplicateLock(C);
		await vi.advanceTimersByTimeAsync(10);
		expect(r.said(from), "a notice other than the lock showed before the clear's read landed").toEqual(["locked"]);
		r.release();
		await r.drain();

		expect(r.said(from), "the notices from the clear on").toEqual(["locked", "saves again"]);
		expect(inlineInk.isDuplicateLocked(C), "the copy is still locked").toBe(false);
		expect(inlineInk.duplicateLockedOn(X), "the page is still locked").toBe(false);
		expect(r.onDisk(), "the copy's stroke was not saved").toEqual(["p0", "c1"]);
	});

	it("locked again, cleared again, and locked again while the clear reads the file: the lock stands, no \"saves again\", nothing written, one read", async () => {
		const r = rig();
		await lockedCopyDrew(r);
		const from = r.notices.length;
		const before = r.saves.length;
		const reads = r.reads.length;
		r.hold();

		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		inlineInk.markDuplicateLocked(C, "Original 2.md");
		inlineInk.clearDuplicateLock(C);
		inlineInk.markDuplicateLocked(C, "Original 2.md");
		r.release();
		await r.drain();

		expect(r.said(from), "the notices from the clear on").toEqual(["locked", "locked"]);
		expect(inlineInk.isDuplicateLocked(C), "the copy locked again was left unlocked").toBe(true);
		expect(inlineInk.duplicateLockedOn(X), "the page locked again answers unlocked").toBe(true);
		expect(r.saves.length - before, "a copy locked again was written").toBe(0);
		expect(r.reads.length - reads, "the file was not read exactly once").toBe(1);
	});

	it("locked again and cleared again while the clear reads the file, and that read throws with ink drawn while locked: \"could not be read yet\", no \"saves again\", nothing written", async () => {
		const r = rig();
		await lockedCopyDrew(r);
		const from = r.notices.length;
		const before = r.saves.length;
		r.hold();
		r.throwNext();

		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		inlineInk.markDuplicateLocked(C, "Original 2.md");
		inlineInk.clearDuplicateLock(C);
		r.release();
		await vi.advanceTimersByTimeAsync(10);
		expect(inlineInk.isDamagedLocked(C), "precondition: the clear's read threw and holds the copy").toBe(true);
		await r.drain();

		expect(r.said(from), "the notices from the clear on").toEqual(["locked", "not read yet"]);
		expect(r.saves.length - before, "a save was scheduled over a file that could not be read").toBe(0);
		expect(r.onDisk(), "the file changed").toEqual(["p0"]);
		expect(ids(inlineInk.strokes(C)), "the copy's ink left memory").toEqual(["p0", "c1"]);
	});

	it("the copy deleted while the clear reads the file: nothing said, nothing written", async () => {
		const r = rig();
		await lockedCopyDrew(r);
		const from = r.notices.length;
		const before = r.saves.length;
		r.hold();

		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		inlineInk.handleDelete(C);
		r.release();
		await r.drain();

		expect(r.said(from), "the notices from the clear on").toEqual([]);
		expect(r.saves.length - before, "a deleted copy was written").toBe(0);
	});

	it("a clear on a locked copy never read speaks at once, as before", async () => {
		const r = rig();
		inlineInk.markDuplicateLocked(C, N);
		await inlineInk.ensureLoaded(N);
		expect(inlineInk.isLoaded(C), "precondition: the copy was never read").toBe(false);
		const from = r.notices.length;
		expect(r.said(0), "precondition: the lock notice").toEqual(["locked"]);

		await r.deleteOriginal();

		expect(r.said(from), "the notices at the clear").toEqual(["saves again"]);
		expect(inlineInk.isDuplicateLocked(C), "the copy is still locked").toBe(false);
	});

	it("with the clear's read in flight settle does not return; when the read lands the page is queued, and a dispatch after settle writes it", async () => {
		const r = rig();
		await lockedCopyDrew(r);
		r.hold();
		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		expect(r.held(), "precondition: the clear's read is waiting").toBe(1);

		let settled: boolean | null = null;
		const settling = inlineInk.settle().then((done) => {
			settled = done;
		});
		await vi.advanceTimersByTimeAsync(500);
		expect(settled, "settle returned while the clear's read was in flight").toBeNull();
		r.release();
		// Short of settle's own two-second limit, so a settle that gives up answers false here rather than true.
		for (let i = 0; i < 100 && settled === null; i++) await vi.advanceTimersByTimeAsync(10);
		expect(settled, "settle did not return once the clear's read landed").not.toBeNull();
		await settling;

		expect(settled, "settle gave up before the clear's read landed").toBe(true);
		expect(r.store.hasQueuedWrite(X), "the copy's page was not queued when the read landed").toBe(true);
		r.store.flushDispatch();
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1);
		expect(r.onDisk(), "the dispatch after settle did not write the copy's stroke").toEqual(["p0", "c1"]);
	});
});
