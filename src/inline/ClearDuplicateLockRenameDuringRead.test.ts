/**
 * A note and its copy carry the same page id, and only the copy is duplicate-locked. Both are open. The copy changes ink
 * while locked; the original is deleted, and the delete's clear reads the shared file again before it lifts the lock and
 * saves the copy's own changes. The copy is renamed while that read is waiting.
 *
 * After the read the lock is lifted and the record is live under the copy's new path, so the copy's own changes must be
 * saved there: a save is queued with the ink drawn while locked, and the file holds it after a flush. Nothing is drawn
 * after the rename, because a stroke drawn during the read saves everything by its own path and would hide a lost save.
 * A record the read no longer finds (renamed, then deleted) writes nothing; a new note at the old path is left alone; a
 * copy locked again during the read writes nothing.
 *
 * Real InlineInkStore (the plugin's), real PageStore over FakeAdapter, the real delete handler on a plugin built without
 * its constructor. The delete runs as Obsidian runs it: the plugin's handler first, then the inline store's. The rename
 * runs as the plugin's vault rename handler runs it for a Markdown note: the inline store's handleRename.
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
const R = "Renamed copy.md";
const R2 = "Renamed again.md";
const X = "shared-id";
const FILE = `.handwriting/${X}.json`;
const PATHS = [N, C, R, R2];

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
 * the store is asked for them. `hold` keeps every file read waiting until `release`.
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
	let open = (): void => undefined;
	const files = new Map<string, TFile>();
	const file = (path: string): TFile => Object.assign(new TFile(), { path, extension: "md", basename: path.slice(0, -3) });
	for (const path of [N, C]) files.set(path, file(path));
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
	const hold = (): void => {
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
	/** A Markdown note renamed: the vault lists it under the new path, and the inline store moves its record. */
	const rename = (from: string, to: string): void => {
		const f = files.get(from)!;
		files.delete(from);
		listed.delete(from);
		f.path = to;
		f.basename = to.slice(0, -3);
		files.set(to, f);
		listed.add(to);
		inlineInk.handleRename(from, to);
	};
	/** A Markdown note deleted that is not the original: the vault drops it, and the inline store drops its record. */
	const deleteNote = (path: string): void => {
		files.delete(path);
		listed.delete(path);
		inlineInk.handleDelete(path);
	};
	const drain = async (): Promise<void> => {
		for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(2000);
		await store.flush();
		for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(2000);
	};
	return { plugin, store, fake, notices, saves, reads, onDisk, groupsOnDisk, hold, release, deleteOriginal, rename, deleteNote, drain };
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
}

/**
 * The copy drew c1 while locked and the original drew s1, which reached the file; then file reads are held and the
 * original is deleted, so the clear's read of the shared file is waiting. Returns the save count at that point.
 */
async function clearWaitingOnRead(r: ReturnType<typeof rig>, draw = true): Promise<number> {
	await lockedCopyOpen(r);
	const before = r.saves.length;
	if (draw) inlineInk.commit(C, stroke("c1", 70));
	inlineInk.commit(N, stroke("s1", 40));
	await r.drain();
	expect(r.onDisk(), "precondition: the original's stroke reached the file, the copy's did not").toEqual(["p0", "s1"]);
	expect(r.saves.length - before, "precondition: only the original's save was queued").toBe(1);
	r.hold();
	const reads = r.reads.length;
	await r.deleteOriginal();
	await vi.advanceTimersByTimeAsync(10);
	expect(r.reads.length - reads, "precondition: the clear's read is waiting").toBe(1);
	return r.saves.length;
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	for (const p of PATHS) inlineInk.handleDelete(p);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("a copy renamed while its lock clear reads the file still saves the ink it changed while locked", () => {
	it("a stroke the copy drew while locked is saved when the copy is renamed during the read", async () => {
		const r = rig();
		const saves = await clearWaitingOnRead(r);
		r.rename(C, R);

		r.release();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(R), "precondition: the read lifted the copy's lock").toBe(false);

		expect(r.saves.length - saves, "no save was queued for the renamed copy's stroke drawn while locked").toBe(1);
		expect(r.onDisk(), "the renamed copy's stroke drawn while locked is not in the file").toEqual(["p0", "s1", "c1"]);
		expect(ids(inlineInk.strokes(R)), "the renamed copy does not show the merged page").toEqual(["p0", "s1", "c1"]);
	});

	it("a group the copy moved while locked is saved when the copy is renamed during the read", async () => {
		const r = rig({ groups: true });
		await lockedCopyOpen(r);
		inlineInk.commit(N, stroke("s1", 40));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's stroke reached the file").toEqual(["p0", "s1"]);
		const before = r.saves.length;
		inlineInk.setAttachments(C, inlineInk.attachments(C).map((g) => (g.id === "g0" ? group("g0", ["p0"], { dx: 0, dy: 20 }) : g)), true);
		await r.drain();
		expect(r.saves.length - before, "precondition: the lock refused the copy's save").toBe(0);
		r.hold();
		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		r.rename(C, R);
		const saves = r.saves.length;

		r.release();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(R), "precondition: the read lifted the copy's lock").toBe(false);

		expect(r.saves.length - saves, "no save was queued for the renamed copy's group moved while locked").toBe(1);
		expect((r.groupsOnDisk().find((g) => g.id === "g0") as AttachmentRecord | undefined)?.shown, "the renamed copy's group move is not in the file").toEqual({ dx: 0, dy: 20 });
		expect(r.onDisk(), "a stroke was lost").toEqual(["p0", "s1"]);
	});

	it("a copy renamed twice during the read saves under its last path", async () => {
		const r = rig();
		const saves = await clearWaitingOnRead(r);
		r.rename(C, R);
		r.rename(R, R2);

		r.release();
		await r.drain();

		expect(r.saves.length - saves, "no save was queued for the copy renamed twice").toBe(1);
		expect(r.onDisk(), "the copy's stroke drawn while locked is not in the file").toEqual(["p0", "s1", "c1"]);
		expect(ids(inlineInk.strokes(R2)), "the copy under its last path does not show the merged page").toEqual(["p0", "s1", "c1"]);
	});

	it("a copy renamed away and back during the read saves as with no rename", async () => {
		const r = rig();
		const saves = await clearWaitingOnRead(r);
		r.rename(C, R);
		r.rename(R, C);

		r.release();
		await r.drain();

		expect(r.saves.length - saves, "the copy renamed back was not saved once").toBe(1);
		expect(r.onDisk(), "the copy's stroke drawn while locked is not in the file").toEqual(["p0", "s1", "c1"]);
		expect(ids(inlineInk.strokes(C)), "the copy does not show the merged page").toEqual(["p0", "s1", "c1"]);
	});

	it("a copy renamed and then deleted during the read writes nothing", async () => {
		const r = rig();
		const saves = await clearWaitingOnRead(r);
		r.rename(C, R);
		r.deleteNote(R);

		r.release();
		await r.drain();

		expect(r.saves.length - saves, "a deleted copy was written").toBe(0);
		expect(r.onDisk(), "the file's page changed").toEqual(["p0", "s1"]);
	});

	it("a new note at the copy's old path during the read is left alone, and the renamed copy is saved", async () => {
		const r = rig();
		const saves = await clearWaitingOnRead(r);
		r.rename(C, R);
		// A new, empty note takes the old path: the store holds a fresh record for it.
		(inlineInk as unknown as { record(path: string): unknown }).record(C);
		expect(inlineInk.strokes(C), "precondition: the note at the old path holds no ink").toEqual([]);

		r.release();
		await r.drain();

		expect(r.saves.length - saves, "the renamed copy was not saved once").toBe(1);
		expect(r.onDisk(), "the renamed copy's stroke drawn while locked is not in the file").toEqual(["p0", "s1", "c1"]);
		expect(inlineInk.strokes(C), "the new note at the old path took ink").toEqual([]);
		expect(inlineInk.isDuplicateLocked(C), "the new note at the old path took a lock").toBe(false);
	});

	it("the renamed copy's panes and embeds hear the merged page under its new path", async () => {
		const r = rig();
		await clearWaitingOnRead(r);
		r.rename(C, R);
		const heard: string[] = [];
		const stop = onInkChanged((path) => heard.push(path));
		try {
			r.release();
			await r.drain();
		} finally {
			stop();
		}
		expect(heard, "the renamed copy was not repainted under its new path").toContain(R);
		expect(heard, "a repaint went to the old path, where the copy no longer is").not.toContain(C);
	});

	it("a copy renamed and locked again during the read writes nothing and stays locked", async () => {
		const r = rig();
		const saves = await clearWaitingOnRead(r);
		r.rename(C, R);
		inlineInk.markDuplicateLocked(R, "Original 2.md");
		expect(inlineInk.isDuplicateLocked(R), "precondition: the copy is locked again").toBe(true);

		r.release();
		await r.drain();

		expect(r.saves.length - saves, "a copy locked again was written").toBe(0);
		expect(r.onDisk(), "the file's page changed").toEqual(["p0", "s1"]);
		expect(inlineInk.isDuplicateLocked(R), "the copy locked again was left unlocked").toBe(true);
	});

	it("a copy locked again and cleared again during the read, then renamed, is saved under its new path once the read is over, and told once", async () => {
		const r = rig();
		const saves = await clearWaitingOnRead(r);
		inlineInk.markDuplicateLocked(C, "Original 2.md");
		inlineInk.clearDuplicateLock(C);
		r.rename(C, R);

		r.release();
		await r.drain();

		expect(inlineInk.isDuplicateLocked(R), "the renamed copy is still locked").toBe(false);
		expect(inlineInk.duplicateLockedOn(X), "the page is still locked").toBe(false);
		expect(r.saves.length - saves, "no save was queued for the renamed copy's stroke drawn while locked").toBe(1);
		expect(r.onDisk(), "the renamed copy's stroke drawn while locked is not in the file").toEqual(["p0", "s1", "c1"]);
		expect(r.notices.filter((n) => n.includes("duplicate resolved")), "\"saves again\" not told once").toHaveLength(1);
	});

	it("a copy with nothing of its own, renamed during the read, writes nothing", async () => {
		const r = rig();
		const saves = await clearWaitingOnRead(r, false);
		r.rename(C, R);

		r.release();
		await r.drain();

		expect(r.saves.length - saves, "a copy with nothing of its own was written").toBe(0);
		expect(r.onDisk(), "the file's page changed").toEqual(["p0", "s1"]);
		expect(ids(inlineInk.strokes(R)), "the renamed copy does not show the file's page").toEqual(["p0", "s1"]);
	});

	it("a stroke drawn on the renamed copy during the read saves its ink drawn while locked too", async () => {
		const r = rig();
		await clearWaitingOnRead(r);
		r.rename(C, R);
		inlineInk.commit(R, stroke("c2", 100));

		r.release();
		await r.drain();

		expect(r.onDisk(), "the renamed copy's strokes are not all in the file").toEqual(["p0", "s1", "c1", "c2"]);
	});
});
