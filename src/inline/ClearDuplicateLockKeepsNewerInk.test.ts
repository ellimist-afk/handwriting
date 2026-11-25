/**
 * A note and its copy carry the same page id, and only the copy is duplicate-locked (a repair that failed). Both are
 * open. The original stays writable, so ink drawn on it reaches the shared file, while the locked copy keeps the page it
 * loaded. When the original is deleted, the delete handler finds the copy as the other carrier and clears its lock.
 *
 * The clear must not save the copy's old page over the file: after it and a flush the file holds every stroke and
 * attached group it held at the clear (a save still queued under the id included), with only the copy's own
 * locked-time changes on top, and the open copy shows that page. A copy with nothing of its own writes nothing.
 *
 * Real InlineInkStore (the plugin's), real PageStore over FakeAdapter, the real delete handler on a plugin built without
 * its constructor. The delete runs as Obsidian runs it: the plugin's handler first, then the inline store's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import HandwritingPlugin from "../main";
import { inlineInk } from "./InkOverlay";
import { onInkChanged } from "./InkEvents";
import { targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";
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

const DOC = "One line.\nThe word benzene here.\n";

function group(id: string, strokeIds: string[], shown?: { dx: number; dy: number }): AttachmentRecord {
	const from = DOC.indexOf("benzene");
	return {
		v: 1, id, strokeIds, target: targetAt(DOC, from, from + 7, "range"), ref: { x: 0, y: 20 },
		layout: { width: 600, font: 16 }, probe: { id: strokeIds[0]!, x: 10, y: 20 }, ...(shown ? { shown } : {}),
	};
}

/**
 * Two notes on one id, the shared file holding p0 (and group g0 on it with `groups`). Saves are counted per page id as
 * the store is asked for them. `hold` keeps every file read waiting until `release`; `hold(true)` lets each read take
 * the file's bytes at once and answer them only at `release`, as a slow disk or a sync client does.
 */
function rig(opts: { groups?: boolean } = {}) {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const shared = emptyPage(X);
	shared.surface = "inline";
	shared.strokes = [stroke("p0", 5)];
	if (opts.groups) shared.attachments = [group("g0", ["p0"])];
	fake.files.set(FILE, serializePage(shared));
	let gate: Promise<void> | null = null;
	let readFirst = false;
	let open = (): void => undefined;
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
			if (gate && readFirst) {
				const wait = gate;
				const page = await store.load(pageId);
				await wait;
				return page;
			}
			if (gate) await gate;
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
	const groupsOnDisk = (): readonly AttachmentData[] => {
		const t = fake.files.get(FILE);
		return t === undefined ? [] : parsePage(t, X).data.attachments ?? [];
	};
	const hold = (takeBytesFirst = false): void => {
		readFirst = takeBytesFirst;
		gate = new Promise<void>((r) => (open = r));
	};
	const release = (): void => {
		gate = null;
		open();
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
	return { plugin, store, fake, notices, saves, reads, onDisk, groupsOnDisk, hold, release, deleteOriginal, drain };
}

/** The copy locked alone, as a failed repair leaves it; both notes open on the shared page. */
async function lockedCopyOpen(r: ReturnType<typeof rig>): Promise<void> {
	inlineInk.markDuplicateLocked(C, N);
	await inlineInk.ensureLoaded(C);
	await inlineInk.ensureLoaded(N);
	expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
	expect(inlineInk.isDuplicateLocked(N), "precondition: the original is writable").toBe(false);
	expect(ids(inlineInk.strokes(C)), "precondition: the copy loaded the shared page").toEqual(["p0"]);
	expect(ids(inlineInk.strokes(N)), "precondition: the original loaded the shared page").toEqual(["p0"]);
	expect(r.notices.some((n) => n.includes(`"${N}" carry the same handwriting-page-id`)), "precondition: the lock notice").toBe(true);
}

/** A real edit of group g0 (the group moved): it gains a shown offset. */
const moveG0 = (list: readonly AttachmentData[]): AttachmentData[] =>
	list.map((g) => (g.id === "g0" ? group("g0", ["p0"], { dx: 0, dy: 20 }) : g));

/** The list only mapped through typing: seven characters typed above g0's target move its offsets, and nothing else. */
const typeAboveG0 = (list: readonly AttachmentData[]): AttachmentData[] =>
	list.map((g) => {
		if (g.id !== "g0") return g;
		const rec = g as AttachmentRecord;
		return { ...rec, target: { ...rec.target, from: rec.target.from + 7, to: rec.target.to + 7 } };
	});

const groupOnDisk = (r: ReturnType<typeof rig>, id: string): AttachmentRecord | undefined =>
	r.groupsOnDisk().find((g) => g.id === id) as AttachmentRecord | undefined;

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	inlineInk.handleDelete(N);
	inlineInk.handleDelete(C);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("a duplicate lock cleared on a copy never saves the copy's old page over newer ink", () => {
	it("the original's stroke drawn after the copy loaded is still in the file after the original is deleted", async () => {
		const r = rig();
		await lockedCopyOpen(r);
		inlineInk.commit(N, stroke("s1", 40));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's stroke reached the file").toEqual(["p0", "s1"]);

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect(r.onDisk(), "the copy's old page was saved over the original's later stroke").toEqual(["p0", "s1"]);
		expect(ids(inlineInk.strokes(C)), "the open copy does not show the file's page").toEqual(["p0", "s1"]);
	});

	it("a stroke the copy drew while locked is saved on top of the original's later stroke", async () => {
		const r = rig();
		await lockedCopyOpen(r);
		const before = r.saves.length;
		inlineInk.commit(C, stroke("c1", 70));
		await r.drain();
		expect(r.saves.length - before, "precondition: the lock refused the copy's save").toBe(0);
		inlineInk.commit(N, stroke("s1", 40));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's stroke reached the file, the copy's did not").toEqual(["p0", "s1"]);

		await r.deleteOriginal();
		await r.drain();

		expect(r.onDisk(), "the clear lost the original's stroke or the copy's").toEqual(["p0", "s1", "c1"]);
		expect(ids(inlineInk.strokes(C)), "the open copy does not show the merged page").toEqual(["p0", "s1", "c1"]);
	});

	it("with nothing drawn on either note, the file keeps its page", async () => {
		const r = rig();
		await lockedCopyOpen(r);

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect(r.onDisk(), "the file's page changed").toEqual(["p0"]);
		expect(ids(inlineInk.strokes(C)), "the open copy's page changed").toEqual(["p0"]);
	});

	it("a copy with nothing of its own writes nothing at the clear", async () => {
		const r = rig();
		await lockedCopyOpen(r);
		inlineInk.commit(N, stroke("s1", 40));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's stroke reached the file").toEqual(["p0", "s1"]);
		const before = r.saves.length;

		await r.deleteOriginal();
		await r.drain();

		expect(r.saves.length - before, "the clear scheduled a save for a copy with nothing of its own").toBe(0);
		expect(r.onDisk(), "the file's page changed").toEqual(["p0", "s1"]);
	});

	it("the original's save still queued at the clear stays under the copy's own stroke", async () => {
		const r = rig();
		await lockedCopyOpen(r);
		inlineInk.commit(C, stroke("c1", 70));
		inlineInk.commit(N, stroke("s1", 40));
		expect(r.store.hasQueuedWrite(X), "precondition: the original's save is queued").toBe(true);
		expect(r.onDisk(), "precondition: the original's save has not landed").toEqual(["p0"]);

		await r.deleteOriginal();
		await r.drain();

		expect(r.onDisk(), "the copy's save replaced the original's queued one").toEqual(["p0", "s1", "c1"]);
		expect(ids(inlineInk.strokes(C)), "the open copy does not show the merged page").toEqual(["p0", "s1", "c1"]);
	});

	it("an erase the copy made while locked is saved, and the original's later stroke stays", async () => {
		const r = rig();
		await lockedCopyOpen(r);
		const removed = inlineInk.applyRemove(C, ["p0"]);
		expect(removed.map((x) => x.stroke.id), "precondition: the copy erased p0").toEqual(["p0"]);
		expect(ids(inlineInk.strokes(C)), "precondition: the copy holds no stroke").toEqual([]);
		inlineInk.commit(N, stroke("s1", 40));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's stroke reached the file, the copy's erase did not").toEqual(["p0", "s1"]);

		await r.deleteOriginal();
		await r.drain();

		expect(r.onDisk(), "the clear lost the original's stroke or the copy's erase").toEqual(["s1"]);
		expect(ids(inlineInk.strokes(C)), "the open copy does not show the merged page").toEqual(["s1"]);
	});

	it("a file that cannot be read at the clear is not written, and the copy keeps its ink in memory", async () => {
		const r = rig();
		await lockedCopyOpen(r);
		inlineInk.commit(C, stroke("c1", 70));
		await r.drain();
		const unreadable = "{ not an ink file";
		r.fake.files.set(FILE, unreadable);
		const before = r.saves.length;

		await r.deleteOriginal();
		await r.drain();

		expect(r.saves.length - before, "the clear scheduled a save over a file it could not read").toBe(0);
		expect(r.fake.files.get(FILE), "the unreadable file was written").toBe(unreadable);
		expect(ids(inlineInk.strokes(C)), "the copy's ink left memory").toEqual(["p0", "c1"]);
	});

	it("a locked copy never opened writes nothing at the clear", async () => {
		const r = rig();
		inlineInk.markDuplicateLocked(C, N);
		await inlineInk.ensureLoaded(N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		expect(inlineInk.isLoaded(C), "precondition: the copy was never read").toBe(false);
		inlineInk.commit(N, stroke("s1", 40));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's stroke reached the file").toEqual(["p0", "s1"]);
		const before = r.saves.length;

		await r.deleteOriginal();
		await r.drain();

		expect(r.saves.length - before, "the clear scheduled a save for a copy never read").toBe(0);
		expect(r.onDisk(), "the file's page changed").toEqual(["p0", "s1"]);
	});

	it("an attached group the original added stays in the file beside the copy's own edit of another group", async () => {
		const r = rig({ groups: true });
		await lockedCopyOpen(r);
		expect(ids(inlineInk.attachments(C)), "precondition: the copy loaded the file's group").toEqual(["g0"]);
		inlineInk.commit(N, stroke("s1", 40));
		inlineInk.setAttachments(N, [...inlineInk.attachments(N), group("g1", ["s1"])], true);
		await r.drain();
		expect(ids(r.groupsOnDisk()), "precondition: the original's group reached the file").toEqual(["g0", "g1"]);
		const before = r.saves.length;
		inlineInk.commit(C, stroke("c1", 70));
		inlineInk.setAttachments(C, inlineInk.attachments(C).map((g) => (g.id === "g0" ? group("g0", ["p0"], { dx: 0, dy: 20 }) : g)), true);
		await r.drain();
		expect(r.saves.length - before, "precondition: the lock refused the copy's saves").toBe(0);

		await r.deleteOriginal();
		await r.drain();

		expect(ids(r.groupsOnDisk()), "the clear lost the original's group or the copy's").toEqual(["g0", "g1"]);
		expect((r.groupsOnDisk().find((g) => g.id === "g0") as AttachmentRecord | undefined)?.shown, "the copy's edit of its group was not saved").toEqual({ dx: 0, dy: 20 });
		expect(r.onDisk(), "the clear lost a stroke").toEqual(["p0", "s1", "c1"]);
		expect(ids(inlineInk.attachments(C)), "the open copy does not hold the merged groups").toEqual(["g0", "g1"]);
	});

	it("the open copy's panes and embeds hear the merged page", async () => {
		const r = rig();
		await lockedCopyOpen(r);
		inlineInk.commit(N, stroke("s1", 40));
		await r.drain();
		const heard: string[] = [];
		const stop = onInkChanged((path) => heard.push(path));
		try {
			await r.deleteOriginal();
			await r.drain();
		} finally {
			stop();
		}
		expect(heard, "the copy was not repainted with the file's page").toContain(C);
	});

	it("a copy locked again while its file is read writes nothing", async () => {
		const r = rig();
		await lockedCopyOpen(r);
		inlineInk.commit(C, stroke("c1", 70));
		inlineInk.commit(N, stroke("s1", 40));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's stroke reached the file").toEqual(["p0", "s1"]);
		r.hold();
		const before = r.saves.length;

		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		inlineInk.markDuplicateLocked(C, "Original 2.md");
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked again").toBe(true);
		r.release();
		await r.drain();

		expect(r.saves.length - before, "a copy locked again was written").toBe(0);
		expect(r.onDisk(), "the file's page changed").toEqual(["p0", "s1"]);
		expect(inlineInk.isDuplicateLocked(C), "the copy locked again was left unlocked").toBe(true);
	});

	it("while the clear reads the file again the page still answers as locked, so no fork choice can write it first", async () => {
		const r = rig();
		await lockedCopyOpen(r);
		inlineInk.commit(C, stroke("c1", 70));
		inlineInk.commit(N, stroke("s1", 40));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's stroke reached the file").toEqual(["p0", "s1"]);
		r.hold();
		const reads = r.reads.length;

		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		expect(r.reads.length - reads, "precondition: the clear's read is waiting").toBe(1);
		expect(inlineInk.duplicateLockedOn(X), "the page answered unlocked while the clear read the file").toBe(true);
		expect(inlineInk.isDuplicateLocked(C), "the note did not answer that it saves again").toBe(false);
		r.release();
		await r.drain();

		expect(r.reads.length - reads, "the clear did not read the file once").toBe(1);
		expect(inlineInk.duplicateLockedOn(X), "the lock stayed after the read").toBe(false);
		expect(r.onDisk(), "the copy's save after the read").toEqual(["p0", "s1", "c1"]);
	});

	it("locked again during the clear's read, then cleared again before that read lands: the page still answers locked until the read is over", async () => {
		const r = rig();
		await lockedCopyOpen(r);
		inlineInk.commit(C, stroke("c1", 70));
		inlineInk.commit(N, stroke("s1", 40));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's stroke reached the file").toEqual(["p0", "s1"]);
		r.hold();
		const reads = r.reads.length;

		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		expect(r.reads.length - reads, "precondition: the clear's read is waiting").toBe(1);
		inlineInk.markDuplicateLocked(C, "Original 2.md");
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked again").toBe(true);
		inlineInk.clearDuplicateLock(C);
		await vi.advanceTimersByTimeAsync(10);
		expect(r.reads.length - reads, "precondition: the first read is still waiting").toBe(1);
		expect(inlineInk.duplicateLockedOn(X), "the page answered unlocked while the first clear's read was still waiting").toBe(true);
		r.release();
		await r.drain();

		expect(r.onDisk(), "the copy's save after the read").toEqual(["p0", "s1", "c1"]);
		expect(inlineInk.isDuplicateLocked(C), "the lock stood after both clears").toBe(false);
	});

	it("locked again during the clear's read, the note it names saving to the file meanwhile, then cleared again: the file keeps that save and the copy's stroke", async () => {
		const r = rig();
		await lockedCopyOpen(r);
		inlineInk.commit(C, stroke("c1", 70));
		inlineInk.commit(N, stroke("s1", 40));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's stroke reached the file").toEqual(["p0", "s1"]);
		// The clear's read takes the file's bytes now and answers them late.
		r.hold(true);
		const reads = r.reads.length;

		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		expect(r.reads.length - reads, "precondition: the clear's read is waiting").toBe(1);
		inlineInk.markDuplicateLocked(C, "Original 2.md");
		// The other note the lock names saves its page to the shared file, as any carrier's save goes, while the read waits.
		const page = parsePage(r.fake.files.get(FILE)!, X).data;
		r.store.schedule(X, { ...page, strokes: [...page.strokes, stroke("o2", 90)] });
		await r.drain();
		expect(r.onDisk(), "precondition: the other note's save landed while the read waited").toEqual(["p0", "s1", "o2"]);
		const from = r.notices.length;
		inlineInk.clearDuplicateLock(C);
		r.release();
		await r.drain();

		expect(r.onDisk(), "the copy's save wrote over the other note's save").toEqual(["p0", "s1", "o2", "c1"]);
		expect(ids(inlineInk.strokes(C)), "the copy does not show the other note's save").toEqual(["p0", "s1", "o2", "c1"]);
		expect(r.reads.length - reads, "the file was not read again after the second clear").toBe(2);
		expect(r.notices.slice(from).filter((n) => n.includes("duplicate resolved")), "\"saves again\" not told once").toHaveLength(1);
		expect(inlineInk.duplicateLockedOn(X), "the lock stayed after the reads").toBe(false);
	});

	it("locked again during the clear's read, then cleared twice: the file read once more after the read, one \"saves again\", one save", async () => {
		const r = rig();
		await lockedCopyOpen(r);
		inlineInk.commit(C, stroke("c1", 70));
		inlineInk.commit(N, stroke("s1", 40));
		await r.drain();
		r.hold();
		const reads = r.reads.length;
		const before = r.saves.length;

		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		inlineInk.markDuplicateLocked(C, "Original 2.md");
		inlineInk.clearDuplicateLock(C);
		inlineInk.clearDuplicateLock(C);
		expect(inlineInk.isDuplicateLocked(C), "the note did not answer that it saves again").toBe(false);
		r.release();
		await r.drain();

		expect(r.reads.length - reads, "the file was not read exactly once more").toBe(2);
		expect(r.notices.filter((n) => n.includes("duplicate resolved")), "\"saves again\" not told once").toHaveLength(1);
		expect(r.saves.length - before, "the copy was not saved once").toBe(1);
		expect(r.onDisk(), "the copy's save after the reads").toEqual(["p0", "s1", "c1"]);
		expect(inlineInk.duplicateLockedOn(X), "the lock stayed after the reads").toBe(false);
	});

	it("the delete's clear tells the user once and reads the file once", async () => {
		const r = rig();
		await lockedCopyOpen(r);
		inlineInk.commit(C, stroke("c1", 70));
		await r.drain();
		r.hold();
		const reads = r.reads.length;

		await r.deleteOriginal();
		inlineInk.clearDuplicateLock(C);
		await vi.advanceTimersByTimeAsync(10);
		r.release();
		await r.drain();

		expect(r.notices.filter((n) => n.includes("duplicate resolved")), "the clear spoke more than once").toHaveLength(1);
		expect(r.reads.length - reads, "the clear did not read the file exactly once").toBe(1);
		expect(r.onDisk(), "the copy's own stroke was not saved").toEqual(["p0", "c1"]);
	});

	it("clearing a note that holds no lock reads nothing and writes nothing", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(C);
		inlineInk.commit(C, stroke("c1", 70));
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the note holds no lock").toBe(false);
		expect(r.onDisk(), "precondition: the note's stroke reached the file").toEqual(["p0", "c1"]);
		const reads = r.reads.length;
		const saves = r.saves.length;

		inlineInk.clearDuplicateLock(C);
		await r.drain();

		expect(r.reads.length - reads, "a clear with no lock read the file").toBe(0);
		expect(r.saves.length - saves, "a clear with no lock scheduled a save").toBe(0);
		expect(r.notices.some((n) => n.includes("duplicate resolved")), "a clear with no lock spoke").toBe(false);
	});

	it("a group the copy moved while locked, with no stroke drawn or erased, is saved at the clear over the original's later ink", async () => {
		const r = rig({ groups: true });
		await lockedCopyOpen(r);
		expect(ids(inlineInk.attachments(C)), "precondition: the copy loaded the file's group").toEqual(["g0"]);
		inlineInk.commit(N, stroke("s1", 40));
		inlineInk.setAttachments(N, [...inlineInk.attachments(N), group("g1", ["s1"])], true);
		await r.drain();
		expect(r.onDisk(), "precondition: the original's stroke reached the file").toEqual(["p0", "s1"]);
		expect(ids(r.groupsOnDisk()), "precondition: the original's group reached the file").toEqual(["g0", "g1"]);
		const theirs = groupOnDisk(r, "g1");
		const before = r.saves.length;
		inlineInk.setAttachments(C, moveG0(inlineInk.attachments(C)), true);
		await r.drain();
		expect(r.saves.length - before, "precondition: the lock refused the copy's save").toBe(0);
		expect(groupOnDisk(r, "g0")?.shown, "precondition: the copy's move has not reached the file").toBeUndefined();
		expect(ids(inlineInk.strokes(C)), "precondition: the copy drew and erased nothing").toEqual(["p0"]);

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect(groupOnDisk(r, "g0")?.shown, "the group the copy moved while locked was not saved at the clear").toEqual({ dx: 0, dy: 20 });
		expect(groupOnDisk(r, "g1"), "the clear changed or lost the original's group").toEqual(theirs);
		expect(ids(r.groupsOnDisk()), "the clear lost a group or added one").toEqual(["g0", "g1"]);
		expect(r.onDisk(), "the clear lost a stroke").toEqual(["p0", "s1"]);
		expect(ids(inlineInk.attachments(C)), "the open copy does not hold the merged groups").toEqual(["g0", "g1"]);
	});

	it("a group the copy moved while locked is kept through a lock taken again during the read, and saved at the next clear", async () => {
		const r = rig({ groups: true });
		await lockedCopyOpen(r);
		inlineInk.commit(N, stroke("s1", 40));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's stroke reached the file").toEqual(["p0", "s1"]);
		inlineInk.setAttachments(C, moveG0(inlineInk.attachments(C)), true);
		r.hold();
		const before = r.saves.length;

		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		inlineInk.markDuplicateLocked(C, "Original 2.md");
		r.release();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy stayed locked").toBe(true);
		expect(r.saves.length - before, "precondition: the copy locked again was not written").toBe(0);
		expect(groupOnDisk(r, "g0")?.shown, "precondition: the copy's move has not reached the file").toBeUndefined();

		inlineInk.clearDuplicateLock(C);
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the second clear lifted the lock").toBe(false);

		expect(groupOnDisk(r, "g0")?.shown, "the group moved under the first lock was not saved at the next clear").toEqual({ dx: 0, dy: 20 });
		expect(r.onDisk(), "the clear lost a stroke").toEqual(["p0", "s1"]);
	});

	it("a group list the copy only mapped through typing while locked writes nothing at the clear", async () => {
		const r = rig({ groups: true });
		await lockedCopyOpen(r);
		inlineInk.commit(N, stroke("s1", 40));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's stroke reached the file").toEqual(["p0", "s1"]);
		const fileGroups = r.groupsOnDisk();
		expect(ids(fileGroups), "precondition: the file holds a group").toEqual(["g0"]);
		const loaded = inlineInk.attachments(C);
		const typed = typeAboveG0(loaded);
		inlineInk.setAttachments(C, typed, false);
		expect(inlineInk.attachments(C), "precondition: the copy holds the mapped list").toBe(typed);
		expect(JSON.stringify(typed), "precondition: the mapped list differs from the page the copy loaded").not.toBe(JSON.stringify(loaded));
		const before = r.saves.length;

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect(r.saves.length - before, "the clear scheduled a save for a list only mapped while locked").toBe(0);
		expect(r.groupsOnDisk(), "the file's groups changed").toEqual(fileGroups);
		expect(r.onDisk(), "the file's page changed").toEqual(["p0", "s1"]);
	});

	it("a group the copy detached while locked is gone from the file after the clear, and the original's later group and stroke stay", async () => {
		const r = rig({ groups: true });
		await lockedCopyOpen(r);
		inlineInk.commit(N, stroke("s1", 40));
		inlineInk.setAttachments(N, [...inlineInk.attachments(N), group("g1", ["s1"])], true);
		await r.drain();
		expect(ids(r.groupsOnDisk()), "precondition: the original's group reached the file").toEqual(["g0", "g1"]);
		const theirs = groupOnDisk(r, "g1");
		const before = r.saves.length;
		inlineInk.setAttachments(C, inlineInk.attachments(C).filter((g) => g.id !== "g0"), true);
		await r.drain();
		expect(ids(inlineInk.attachments(C)), "precondition: the copy detached g0").toEqual([]);
		expect(r.saves.length - before, "precondition: the lock refused the copy's save").toBe(0);
		expect(ids(inlineInk.strokes(C)), "precondition: the copy drew and erased nothing").toEqual(["p0"]);

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect(ids(r.groupsOnDisk()), "the group the copy detached while locked is still in the file, or the original's is gone").toEqual(["g1"]);
		expect(groupOnDisk(r, "g1"), "the clear changed the original's group").toEqual(theirs);
		expect(r.onDisk(), "the clear lost a stroke").toEqual(["p0", "s1"]);
		expect(ids(inlineInk.attachments(C)), "the open copy does not hold the merged groups").toEqual(["g1"]);
	});

	it("a group the copy attached while locked is saved at the clear after the original's later stroke", async () => {
		const r = rig();
		await lockedCopyOpen(r);
		inlineInk.commit(N, stroke("s1", 40));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's stroke reached the file").toEqual(["p0", "s1"]);
		expect(r.groupsOnDisk(), "precondition: the file holds no group").toEqual([]);
		const before = r.saves.length;
		inlineInk.setAttachments(C, [...inlineInk.attachments(C), group("g2", ["p0"])], true);
		await r.drain();
		expect(r.saves.length - before, "precondition: the lock refused the copy's save").toBe(0);
		expect(ids(inlineInk.strokes(C)), "precondition: the copy drew and erased nothing").toEqual(["p0"]);

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect(ids(r.groupsOnDisk()), "the group the copy attached while locked was not saved at the clear").toEqual(["g2"]);
		expect(r.onDisk(), "the clear lost a stroke").toEqual(["p0", "s1"]);
		expect(ids(inlineInk.attachments(C)), "the open copy does not hold its group").toEqual(["g2"]);
	});

	it("a group edit the copy saved before its lock, then a list only mapped while locked, writes nothing at the clear", async () => {
		const r = rig({ groups: true });
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		inlineInk.setAttachments(C, moveG0(inlineInk.attachments(C)), true);
		await r.drain();
		expect(groupOnDisk(r, "g0")?.shown, "precondition: the copy's move reached the file before its lock").toEqual({ dx: 0, dy: 20 });
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		const fileGroups = r.groupsOnDisk();
		const typed = typeAboveG0(inlineInk.attachments(C));
		inlineInk.setAttachments(C, typed, false);
		expect(inlineInk.attachments(C), "precondition: the copy holds the mapped list").toBe(typed);
		const before = r.saves.length;

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect(r.saves.length - before, "the clear wrote a list only mapped while locked, because of an edit saved before the lock").toBe(0);
		expect(r.groupsOnDisk(), "the file's groups changed").toEqual(fileGroups);
		expect(r.onDisk(), "the file's page changed").toEqual(["p0"]);
	});
});
