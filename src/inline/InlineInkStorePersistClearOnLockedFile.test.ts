/**
 * A note and its copy carry the same page id, and only the copy is duplicate-locked. The copy is open on a shared file
 * it already cannot save to: the file is damaged, is a canvas page from an older layout, or was written by a newer
 * version. A stroke is drawn on the copy while locked. Then the original is deleted, and the delete clears the copy's
 * duplicate lock. The copy still cannot save, so the user is not told "duplicate resolved ... saves again": the lock
 * lifts and the note says what a clear says after a read that left it unable to save (clearWhenRead,
 * InlineInkStorePersist.ts:471-474), which for these three files is nothing. Nothing is written and the stroke stays in
 * memory.
 *
 * Controls, as at base: a copy that can save, open on a readable inline file, hears "saves again" once and its stroke
 * is saved; a locked copy never read hears "saves again" at once.
 *
 * The same clear on a copy an earlier clear's read left unable to save: that read threw (the store holds the copy,
 * silently) and the copy was locked again while it was read, so a later clear takes the same arm. With ink drawn while
 * locked the note says "could not be read yet" once, after the lock lifts; with nothing unsaved it says nothing. An older
 * or newer page says its own words at the next stroke, not at the clear. A damaged file repaired heals as any damage
 * does: "readable again", and the stroke drawn while locked is saved then.
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
import { emptyPage, parsePage, serializePage, type PageData } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkStroke } from "../ink/Stroke";

const N = "Original.md";
const C = "Original 1.md";
const X = "shared-id";
const FILE = `.handwriting/${X}.json`;
/** Higher than anything this build writes, which is what arms the newer-format lock. */
const FUTURE_SCHEMA = 9_999;

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

/** A notice by what it tells the user. */
function kind(m: string): string {
	if (m.includes("carry the same handwriting-page-id")) return "locked";
	if (m.includes("duplicate resolved")) return "saves again";
	if (m.includes("could not be read yet")) return "not read yet";
	if (m.includes("cannot read the saved ink")) return "damaged";
	if (m.includes("from an older layout")) return "older layout";
	if (m.includes("written by a newer version")) return "newer version";
	if (m.includes("readable again")) return "readable again";
	return m;
}

/** Lets every read the current rig holds go on (afterEach). */
let releaseHeld = (): void => undefined;

/** What the shared file holds: a readable inline page, a damaged file, an older canvas page, or a newer format. */
type FileKind = "inline" | "damaged" | "legacy" | "future";

function fileBytes(file: FileKind): string {
	if (file === "damaged") return "{ not an ink file";
	const page = emptyPage(X);
	// "canvas" is not in today's surface union; an older build's JSON arrives past the type the same way.
	page.surface = (file === "legacy" ? "canvas" : "inline") as PageData["surface"];
	page.strokes = [stroke("p0", 5)];
	return serializePage(page, file === "future" ? FUTURE_SCHEMA : undefined);
}

/** The copy's record, read for preconditions only. */
type Locks = { damagedLocked: boolean; damageSilent: boolean; legacyLocked: boolean; futureLocked: boolean };
function locksOf(path: string): Locks | undefined {
	return (inlineInk as unknown as { byPath: Map<string, Locks> }).byPath.get(path);
}

/**
 * Two notes on one id, the shared file as `file` says. Saves are counted as the store is asked for them. `hold` keeps
 * every file read waiting until `release`; `throwNext` makes the next read of the shared file throw in the adapter, as a
 * busy disk or a sync client mid-write does, so the store answers that the file is not readable yet. Both as in
 * ClearDuplicateLockNotices.test.ts.
 */
function rig(file: FileKind) {
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
	let holding = false;
	const waiting: Array<() => void> = [];
	const store = new PageStore({ vault: { adapter: fake } } as never);
	fake.files.set(FILE, fileBytes(file));
	const files = new Map<string, TFile>();
	for (const path of [N, C]) files.set(path, Object.assign(new TFile(), { path, extension: "md", basename: path.slice(0, -3) }));
	// Obsidian's delete event fires while the metadata cache still holds the deleted note's frontmatter; the vault
	// listing no longer has the file.
	const listed = new Set([N, C]);
	const cache = (path: string) => (files.has(path) ? { frontmatter: { "handwriting-page-id": X }, sections: [{ type: "yaml" }] } : null);
	const notices: string[] = [];
	const saves: string[] = [];
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
	return { fake, notices, saves, onDisk, said, deleteOriginal, drain, hold, release, held, throwNext };
}

/**
 * The copy's first clear reads the file, that read throws, and the copy is locked again while it is read: the read
 * holds the copy unread, silently, and leaves the duplicate lock standing with no clear under way. A later clear then
 * takes the arm a locked file takes. `from` is where the first clear's notices start.
 */
async function relockedDuringThrownRead(r: ReturnType<typeof rig>, from: number): Promise<void> {
	r.hold();
	r.throwNext();
	await r.deleteOriginal();
	await vi.advanceTimersByTimeAsync(10);
	expect(r.held(), "precondition: the first clear's read is waiting").toBe(1);
	inlineInk.markDuplicateLocked(C, "Original 2.md");
	r.release();
	await r.drain();
	const l = locksOf(C);
	expect(l !== undefined && l.damagedLocked && l.damageSilent, "precondition: the read threw and holds the copy, silently").toBe(true);
	expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked again").toBe(true);
	expect(r.said(from), "precondition: the notices from the first clear on").toEqual(["locked"]);
}

/**
 * Both notes open on the shared file, then the copy locked alone, as a failed repair leaves it; a stroke drawn on the
 * copy while locked, which the lock kept from the file.
 */
async function lockedCopyDrew(r: ReturnType<typeof rig>): Promise<void> {
	await inlineInk.ensureLoaded(N);
	await inlineInk.ensureLoaded(C);
	inlineInk.markDuplicateLocked(C, N);
	expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
	const before = r.saves.length;
	const bytes = r.fake.files.get(FILE);
	inlineInk.commit(C, stroke("c1", 70));
	await r.drain();
	expect(r.saves.length - before, "precondition: the lock refused the copy's save").toBe(0);
	expect(r.fake.files.get(FILE), "precondition: the copy's stroke is not in the file").toBe(bytes);
	expect(ids(inlineInk.strokes(C)), "precondition: the copy's stroke is in memory").toContain("c1");
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

describe("a duplicate lock cleared on a copy whose file it already cannot save to: no \"saves again\", nothing written", () => {
	const cases: Array<{ file: FileKind; name: string; locked: (l: Locks) => boolean }> = [
		{ file: "damaged", name: "a damaged file", locked: (l) => l.damagedLocked && !l.damageSilent },
		{ file: "legacy", name: "a canvas page from an older layout", locked: (l) => l.legacyLocked },
		{ file: "future", name: "a page written by a newer version", locked: (l) => l.futureLocked },
	];
	for (const { file, name, locked } of cases) {
		it(`${name}: the lock lifts, nothing is said, nothing is written, and the stroke stays in memory`, async () => {
			const r = rig(file);
			await lockedCopyDrew(r);
			const l = locksOf(C);
			expect(l !== undefined && locked(l), `precondition: the copy is locked by ${name}`).toBe(true);
			const from = r.notices.length;
			const before = r.saves.length;
			const bytes = r.fake.files.get(FILE);

			await r.deleteOriginal();
			await r.drain();

			expect(r.said(from), "the notices from the clear on").toEqual([]);
			expect(r.saves.length - before, "the clear scheduled a save over a file the copy cannot save to").toBe(0);
			expect(r.fake.files.get(FILE), "the shared file was written").toBe(bytes);
			expect(inlineInk.isDuplicateLocked(C), "the duplicate lock did not lift").toBe(false);
			expect(ids(inlineInk.strokes(C)), "the copy's stroke left memory").toContain("c1");
		});
	}

	it("control: a copy that can save, open on a readable inline file, hears \"saves again\" once and its stroke is saved", async () => {
		const r = rig("inline");
		await lockedCopyDrew(r);
		const from = r.notices.length;

		await r.deleteOriginal();
		await r.drain();

		expect(r.said(from), "the notices from the clear on").toEqual(["saves again"]);
		expect(inlineInk.isDuplicateLocked(C), "the duplicate lock did not lift").toBe(false);
		expect(r.onDisk(), "the copy's stroke was not saved").toEqual(["p0", "c1"]);
	});

	it("control: a locked copy never read hears \"saves again\" at once", async () => {
		const r = rig("inline");
		inlineInk.markDuplicateLocked(C, N);
		await inlineInk.ensureLoaded(N);
		expect(inlineInk.isLoaded(C), "precondition: the copy was never read").toBe(false);
		const from = r.notices.length;

		await r.deleteOriginal();

		expect(r.said(from), "the notices at the clear").toEqual(["saves again"]);
		expect(inlineInk.isDuplicateLocked(C), "the duplicate lock did not lift").toBe(false);
	});

	it("a read that threw holds the copy, ink drawn while locked: a later clear says \"could not be read yet\" once, and nothing is written", async () => {
		const r = rig("inline");
		await lockedCopyDrew(r);
		const before = r.saves.length;
		await relockedDuringThrownRead(r, r.notices.length);
		const from = r.notices.length;

		inlineInk.clearDuplicateLock(C);
		await r.drain();

		expect(r.said(from), "the notices from the later clear on").toEqual(["not read yet"]);
		expect(r.saves.length - before, "a save was scheduled over a file that could not be read").toBe(0);
		expect(r.onDisk(), "the file changed").toEqual(["p0"]);
		expect(inlineInk.isDuplicateLocked(C), "the duplicate lock did not lift").toBe(false);
		expect(ids(inlineInk.strokes(C)), "the copy's ink left memory").toEqual(["p0", "c1"]);
	});

	it("a read that threw holds the copy, nothing unsaved: a later clear says nothing, and nothing is written", async () => {
		const r = rig("inline");
		await inlineInk.ensureLoaded(C);
		await inlineInk.ensureLoaded(N);
		inlineInk.commit(C, stroke("c0", 70));
		await r.drain();
		expect(r.onDisk(), "precondition: the copy's stroke reached the file before its lock").toEqual(["p0", "c0"]);
		inlineInk.markDuplicateLocked(C, N);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
		const before = r.saves.length;
		await relockedDuringThrownRead(r, r.notices.length);
		const from = r.notices.length;

		inlineInk.clearDuplicateLock(C);
		await r.drain();

		expect(r.said(from), "the notices from the later clear on, with nothing unsaved").toEqual([]);
		expect(r.saves.length - before, "a save was scheduled over a file that could not be read").toBe(0);
		expect(r.onDisk(), "the file changed").toEqual(["p0", "c0"]);
		expect(inlineInk.isDuplicateLocked(C), "the duplicate lock did not lift").toBe(false);
	});

	const ownWords: Array<{ file: FileKind; name: string; words: string }> = [
		{ file: "legacy", name: "a canvas page from an older layout", words: "older layout" },
		{ file: "future", name: "a page written by a newer version", words: "newer version" },
	];
	for (const { file, name, words } of ownWords) {
		it(`${name}: the note says its own words once, at the next stroke after the clear, and not at the clear`, async () => {
			const r = rig(file);
			await lockedCopyDrew(r);
			const from = r.notices.length;
			const before = r.saves.length;
			const bytes = r.fake.files.get(FILE);
			await r.deleteOriginal();
			await r.drain();
			const at = r.notices.length;

			inlineInk.commit(C, stroke("c2", 90));
			await r.drain();

			expect(r.said(at), "the notices at the stroke after the clear").toEqual([words]);
			expect(r.said(from), "the notices from the clear on").toEqual([words]);
			expect(r.saves.length - before, "a save was scheduled for a page this build cannot write").toBe(0);
			expect(r.fake.files.get(FILE), "the shared file was written").toBe(bytes);
		});
	}

	it("a damaged file, the clear, then the file repaired and the copy reopened: \"readable again\" alone, and the stroke drawn while locked is saved", async () => {
		const r = rig("damaged");
		await lockedCopyDrew(r);
		const from = r.notices.length;
		await r.deleteOriginal();
		await r.drain();

		r.fake.files.set(FILE, fileBytes("inline"));
		await inlineInk.ensureLoaded(C);
		await r.drain();

		expect(inlineInk.isDamagedLocked(C), "precondition: the reopen's read healed").toBe(false);
		expect(r.said(from), "the notices from the clear on").toEqual(["readable again"]);
		expect(r.onDisk(), "the copy's stroke was not saved at the heal").toEqual(["p0", "c1"]);
		expect(inlineInk.isDuplicateLocked(C), "the duplicate lock did not lift").toBe(false);
	});
});
