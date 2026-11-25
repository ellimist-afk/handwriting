/**
 * A NOTE DELETED INSIDE ANOTHER NOTE'S ID-EDIT GRACE.
 *
 * The id's owner edits its id value beside a copy locked on the old id. Inside the owner's grace, or in the same sync
 * batch heard before the owner's change, another note is deleted. The delete does not change where the edit ends: after
 * the grace every note's ink is where the same edit leaves it with no delete. The owner's files have moved to its new id
 * and it shows its ink there; the copy owns the old id, is unlocked by the count the edit runs, is told once, and shows
 * and saves the shared stroke and its own under the old id. This holds for a delete whose id is not proven (a note with
 * no id line, or a copy deleted after the cache dropped it) and for a copy deleted with its id known; for a copy left on
 * the old id that was never opened (so not locked here); and for an owner whose id line is emptied on the way to the
 * new value, or emptied and left empty.
 *
 * Pins: an id-less delete with no edit waiting lifts a lone lock as before; the edit with no delete ends as before,
 * beside an opened copy or an unopened one, typed straight or through an empty line; an id line left empty ends as before.
 *
 * Real InlineInkStore (the plugin's), real PageStore over FakeAdapter, the real delete and identity handlers on a plugin
 * built without its constructor, as in DeleteWithCacheGone.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkStroke } from "./Stroke";

const N = "Original.md";
const C = "Original 1.md";
const D = "Original 2.md";
/** A note with no id line: a plain note, never drawn on. */
const P = "Plain.md";
const X = "shared-id";
const Y = "edited-id";
const FILE = `.handwriting/${X}.json`;
const RESOLVED = "Handwriting: duplicate resolved. Ink on this note saves again.";

type Order = "cache-empty" | "app-start";

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

/**
 * `paths` carry the shared id, whose file holds p0; `plain` are listed with no id line. The vault lists a note until it is
 * deleted; the cache answers for a note until its own delete listener runs, with the id line the note carries now.
 */
function rig(paths: string[], plain: string[] = []) {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const shared = emptyPage(X);
	shared.surface = "inline";
	shared.strokes = [stroke("p0", 5)];
	fake.files.set(FILE, serializePage(shared));
	const all = [...paths, ...plain];
	const files = new Map<string, TFile>();
	for (const path of all) files.set(path, Object.assign(new TFile(), { path, extension: "md", basename: path.slice(0, -3) }));
	const listed = new Set(all);
	const cached = new Set(all);
	const idOf = new Map<string, string>(paths.map((p) => [p, X]));
	const cache = (path: string) => (cached.has(path) ? { frontmatter: { "handwriting-page-id": idOf.get(path) }, sections: [{ type: "yaml" }] } : null);
	const notices: string[] = [];
	const saves: string[] = [];
	const plugin: any = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		pageIdWatchReady: false,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		pendingRecycle: new Map(),
		declaimTimers: new Map(),
		declaimedPaths: new Set(),
		settings: { pageOwners: {}, cameras: {} },
		settingsDirty: false,
		settingsTimer: null,
		flushSettings: async () => undefined,
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
		loadSidecar: async (pageId) => store.load(pageId),
		scheduleSidecar: (pageId, page) => {
			saves.push(pageId);
			store.schedule(pageId, page);
		},
		scheduleSidecarNow: (pageId, page) => {
			saves.push(pageId);
			return store.saveNow(pageId, page);
		},
		notify: (m) => void notices.push(m),
	};
	inlineInk.attachHost(host);
	const onDisk = (): string[] | null => {
		const t = fake.files.get(FILE);
		return t === undefined ? null : ids(parsePage(t, X).data.strokes);
	};
	/** `path` is deleted: the plugin's handler, then the inline store's; the cache's entry goes before or after. */
	const del = async (path: string, order: Order = "cache-empty"): Promise<void> => {
		listed.delete(path);
		if (order === "cache-empty") cached.delete(path);
		const handled = plugin.onFileDeleted(files.get(path));
		if (order === "app-start") cached.delete(path);
		inlineInk.handleDelete(path);
		await handled;
	};
	const drain = async (): Promise<void> => {
		for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(2000);
		await store.flush();
		for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(2000);
	};
	/** The note's id line now names `id` (an edit the cache has indexed). */
	const setId = (path: string, id: string): void => void idOf.set(path, id);
	/** The note's id line is gone (an edit the cache has indexed). */
	const clearId = (path: string): void => void idOf.delete(path);
	const told = (): number => notices.filter((n) => n === RESOLVED).length;
	return { plugin, fake, store, notices, saves, onDisk, del, setId, clearId, told, drain };
}

type Rig = ReturnType<typeof rig>;

/** A stroke drawn on a locked note: shown, not saved. */
async function drawLocked(r: Rig, path: string, id: string): Promise<void> {
	const before = r.saves.length;
	inlineInk.commit(path, stroke(id, 70));
	await r.drain();
	expect(r.saves.length - before, "precondition: the lock refused the save").toBe(0);
	expect(r.onDisk(), "precondition: the stroke is not in the file").toEqual(["p0"]);
}

/** The stroke ids in the new id's ink file, or none. */
const editedFileIds = (r: Rig): string[] => {
	const t = r.fake.files.get(`.handwriting/${Y}.json`);
	return t === undefined ? [] : ids(parsePage(t, Y).data.strokes);
};

/** N owns the id; `copies` are locked as its copies, their ink loaded; `ownerLoaded`: N's too. A stroke c1 drawn on C, refused. */
async function ownerAndLockedCopies(r: Rig, ownerLoaded: boolean, copies: string[] = [C]): Promise<void> {
	r.plugin.pageIds.claimOwnership(X, N);
	for (const p of copies) inlineInk.markDuplicateLocked(p, N);
	if (ownerLoaded) await inlineInk.ensureLoaded(N);
	for (const p of copies) await inlineInk.ensureLoaded(p);
	expect(r.plugin.pageIds.owner(X), "precondition: N owns the id").toBe(N);
	expect(r.plugin.ambiguousIds.has(X), "precondition: the id is not listed").toBe(false);
	for (const p of copies) expect(inlineInk.isDuplicateLocked(p), `precondition: ${p} is locked`).toBe(true);
	expect(inlineInk.isDuplicateLocked(N), "precondition: N is not locked").toBe(false);
	await drawLocked(r, C, "c1");
}

/**
 * Watches the owner's file move (each old-id file set under the new id): at the start and the end of each step, a copy
 * in `locked` unlocked or the id not the owner's is noted. Returns the notes, and how many steps ran.
 */
function watchMove(r: Rig, locked: string[] = [C]): () => { steps: number; seen: string[] } {
	const seen: string[] = [];
	let steps = 0;
	const look = (when: string): void => {
		for (const p of locked) if (!inlineInk.isDuplicateLocked(p)) seen.push(`${p} unlocked ${when}`);
		const owner = r.plugin.pageIds.owner(X);
		if (owner !== N) seen.push(`the id was ${owner ?? "nobody"}'s ${when}`);
	};
	const real = r.store.keepAsideUnder.bind(r.store);
	vi.spyOn(r.store, "keepAsideUnder").mockImplementation(async (from, to, own, named) => {
		steps++;
		look(`as ${from} began to move`);
		const out = await real(from, to, own, named);
		look(`as ${from} finished moving`);
		return out;
	});
	return () => ({ steps, seen });
}

/**
 * Where the owner's id edit leaves every note when no note is deleted (pinned below). Every want is soft, so each line
 * of the end is read even when an earlier one is red.
 */
function editEnds(r: Rig, ownerLoaded: boolean, moves: () => { steps: number; seen: string[] }): void {
	expect.soft(inlineInk.isDuplicateLocked(C), "the copy left alone on the old id is still locked").toBe(false);
	expect.soft(r.plugin.pageIds.owner(X), "the copy left alone on the old id does not own it").toBe(C);
	expect.soft(r.told(), "the lift is not told once").toBe(1);
	expect.soft(ids(inlineInk.strokes(C)).sort(), "the copy does not show the shared stroke and its own").toEqual(["c1", "p0"]);
	expect.soft(r.onDisk()?.sort(), "the old id's file does not hold the copy's page").toEqual(["c1", "p0"]);
	expect.soft(r.plugin.pageIds.owner(Y), "the owner does not own its new id").toBe(N);
	expect.soft(inlineInk.isDuplicateLocked(N), "the owner is locked").toBe(false);
	if (!ownerLoaded) {
		// The owner's ink was not loaded: its files do not move, as with no delete.
		expect.soft(editedFileIds(r), "a file landed under the owner's new id though its ink was not loaded").toEqual([]);
		return;
	}
	expect.soft(moves().steps, "the owner's files did not move to its new id").toBeGreaterThan(0);
	expect.soft(moves().seen, "the copy was unlocked or given the id while the owner's files moved").toEqual([]);
	expect.soft(editedFileIds(r), "the owner's ink is not under its new id, or a stroke of the copy went with it").toEqual(["p0"]);
	expect.soft(ids(inlineInk.strokes(N)), "the owner does not show its ink: it opens blank").toEqual(["p0"]);
	expect.soft(inlineInk.pageIdOf(N), "the owner's record is not on its new id").toBe(Y);
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	for (const p of [N, C, D, P]) inlineInk.handleDelete(p);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

type Heard = "inside the grace" | "before the owner's change is heard";
const HEARD: Heard[] = ["inside the grace", "before the owner's change is heard"];

/** N's id value edited to Y; `remove` (a delete) heard inside N's grace, or in the same batch before N's change; the grace runs out. */
async function editWith(r: Rig, heard: Heard, remove: () => Promise<void>): Promise<void> {
	r.setId(N, Y);
	if (heard === "inside the grace") {
		r.plugin.checkPageIdentity(N);
		await vi.advanceTimersByTimeAsync(1000);
		await remove();
	} else {
		await remove();
		r.plugin.checkPageIdentity(N);
	}
	await r.drain();
	await r.drain();
}

/** PIN: the edit with no delete. The wants every delete cell below holds the edit to. */
describe.each([true, false])("pin: the owner edits its id value beside one locked copy, no note deleted, its ink loaded: %s", (loaded) => {
	it("the owner's ink is under its new id; the copy owns the old id, is unlocked, told once, and its page is saved", async () => {
		const r = rig([N, C], [P]);
		await ownerAndLockedCopies(r, loaded);
		const moves = watchMove(r);

		r.setId(N, Y);
		r.plugin.checkPageIdentity(N);
		await r.drain();
		await r.drain();

		editEnds(r, loaded, moves);
	});
});

/** A note with no id line deleted while the owner's id edit settles (the id-less road). */
describe.each(HEARD)("a plain note deleted %s", (heard) => {
	it.each([true, false])("the owner's ink loaded: %s. The edit ends as with no delete", async (loaded) => {
		const r = rig([N, C], [P]);
		await ownerAndLockedCopies(r, loaded);
		const moves = watchMove(r);

		await editWith(r, heard, () => r.del(P));

		editEnds(r, loaded, moves);
	});
});

/**
 * A second locked copy deleted while the owner's id edit settles: with the cache gone (the id-less road) or at app start
 * (its id known). The copy left is then the only note on the old id; the count the edit runs lifts it.
 */
describe.each(HEARD)("a second locked copy deleted %s", (heard) => {
	describe.each(["cache-empty", "app-start"] as Order[])("%s", (order) => {
		it.each([true, false])("the owner's ink loaded: %s. The edit ends as with that copy never there", async (loaded) => {
			const r = rig([N, C, D]);
			await ownerAndLockedCopies(r, loaded, [C, D]);
			const moves = watchMove(r);

			await editWith(r, heard, () => r.del(D, order));

			editEnds(r, loaded, moves);
		});
	});
});

/** PIN: a delete with no edit waiting lifts a lone lock, as before: id-less (the first two), and with its id known (the last). */
describe("pin: a delete with no edit waiting", () => {
	it("the locked owner left alone, the copy deleted after the cache dropped it: the owner is unlocked, told once, its stroke saved", async () => {
		const r = rig([N, C], [P]);
		r.plugin.pageIds.claimOwnership(X, C);
		inlineInk.markDuplicateLocked(C, N);
		await inlineInk.ensureLoaded(C);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the owner is locked").toBe(true);
		await drawLocked(r, C, "c1");

		await r.del(N, "cache-empty");
		await r.drain();

		expect.soft(inlineInk.isDuplicateLocked(C), "the owner left alone on the id is still locked").toBe(false);
		expect.soft(r.plugin.pageIds.owner(X), "the note left alone does not own the id").toBe(C);
		expect.soft(r.onDisk(), "the stroke drawn while locked is not in the ink file").toEqual(["p0", "c1"]);
		expect.soft(r.told(), "the lift is not told once").toBe(1);
	});

	it("the owner deleted with two locked copies left, one copy deleted after the cache dropped it: the other is unlocked, told once, its stroke saved", async () => {
		const r = rig([N, C, D], [P]);
		await ownerAndLockedCopies(r, true, [C, D]);

		await r.del(N, "app-start");
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: two copies left on the id, C was unlocked").toBe(true);
		expect(r.plugin.pageIds.owner(X), "precondition: a copy was given the id").toBeUndefined();

		await r.del(D, "cache-empty");
		await r.drain();

		expect.soft(inlineInk.isDuplicateLocked(C), "the copy left alone on the id is still locked").toBe(false);
		expect.soft(r.plugin.pageIds.owner(X), "the copy left alone does not own the id").toBe(C);
		expect.soft(r.onDisk(), "the stroke drawn while locked is not in the ink file").toEqual(["p0", "c1"]);
		expect.soft(r.told(), "the lift is not told once").toBe(1);
	});

	it.each(["cache-empty", "app-start"] as Order[])("the owner deleted (%s), its one locked copy left: the copy is unlocked, owns the id, told once, its stroke saved", async (order) => {
		const r = rig([N, C], [P]);
		await ownerAndLockedCopies(r, true);

		await r.del(N, order);
		await r.drain();

		expect.soft(inlineInk.isDuplicateLocked(C), "the copy left alone on the id is still locked").toBe(false);
		expect.soft(r.plugin.pageIds.owner(X), "the copy left alone does not own the id").toBe(C);
		expect.soft(r.onDisk(), "the stroke drawn while locked is not in the ink file").toEqual(["p0", "c1"]);
		expect.soft(r.told(), "the lift is not told once").toBe(1);
	});
});

/**
 * The copy left unopened. The copy C left on the old id has no inline record in this
 * session (never opened; its duplicate repair still between awaits), so it is not locked. A second copy D, locked, is
 * deleted with its id known (app start: the cache still names it). The edit ends as with D never there: the owner's
 * files move to its new id and it shows its ink there; C owns the old id, and opened, it shows what the old id's file
 * holds then.
 */
async function ownerAndUnopenedCopy(r: Rig, ownerLoaded: boolean, withD: boolean): Promise<void> {
	r.plugin.pageIds.claimOwnership(X, N);
	if (withD) inlineInk.markDuplicateLocked(D, N);
	if (ownerLoaded) await inlineInk.ensureLoaded(N);
	if (withD) await inlineInk.ensureLoaded(D);
	expect(r.plugin.pageIds.owner(X), "precondition: N owns the id").toBe(N);
	expect(inlineInk.pageIdOf(C), "precondition: C has a record").toBeNull();
	expect(inlineInk.isDuplicateLocked(C), "precondition: C is locked").toBe(false);
	if (withD) expect(inlineInk.isDuplicateLocked(D), "precondition: D is not locked").toBe(true);
}

/** Where the owner's id edit leaves every note beside an unopened copy, with no note deleted (pinned below). */
async function unopenedEnds(r: Rig, ownerLoaded: boolean, moves: () => { steps: number; seen: string[] }): Promise<void> {
	expect.soft(r.plugin.pageIds.owner(X), "the copy left alone on the old id does not own it").toBe(C);
	expect.soft(r.plugin.pageIds.owner(Y), "the owner does not own its new id").toBe(N);
	expect.soft(r.plugin.ambiguousIds.has(X), "the old id is listed").toBe(false);
	if (ownerLoaded) {
		expect.soft(moves().steps, "the owner's files did not move to its new id").toBeGreaterThan(0);
		expect.soft(moves().seen, "the id was given away while the owner's files moved").toEqual([]);
		expect.soft(editedFileIds(r), "the owner's ink is not under its new id").toEqual(["p0"]);
		expect.soft(ids(inlineInk.strokes(N)), "the owner does not show its ink: it opens blank").toEqual(["p0"]);
		expect.soft(inlineInk.pageIdOf(N), "the owner's record is not on its new id").toBe(Y);
		expect.soft(r.onDisk(), "the owner's ink is left in the old id's file, which is the copy's now").toBeNull();
	} else {
		expect.soft(editedFileIds(r), "a file landed under the owner's new id though its ink was not loaded").toEqual([]);
		expect.soft(r.onDisk(), "the old id's file changed").toEqual(["p0"]);
	}
	// The copy opened now reads the old id, which is its own.
	await inlineInk.ensureLoaded(C);
	expect.soft(ids(inlineInk.strokes(C)), "the copy opened shows other ink than the old id's file holds with no delete").toEqual(ownerLoaded ? [] : ["p0"]);
}

describe.each([true, false])("pin: the owner edits its id value beside an unopened copy, no note deleted, its ink loaded: %s", (loaded) => {
	it("the owner's ink is under its new id when loaded; the copy owns the old id", async () => {
		const r = rig([N, C]);
		await ownerAndUnopenedCopy(r, loaded, false);
		const moves = watchMove(r, []);

		r.setId(N, Y);
		r.plugin.checkPageIdentity(N);
		await r.drain();
		await r.drain();

		await unopenedEnds(r, loaded, moves);
	});
});

describe.each(HEARD)("a locked second copy deleted with its id known %s, the copy left unopened", (heard) => {
	it.each([true, false])("the owner's ink loaded: %s. The edit ends as with that copy never there", async (loaded) => {
		const r = rig([N, C, D]);
		await ownerAndUnopenedCopy(r, loaded, true);
		const moves = watchMove(r, []);

		await editWith(r, heard, () => r.del(D, "app-start"));

		await unopenedEnds(r, loaded, moves);
	});
});

/**
 * The owner's id line emptied. The owner's id line is emptied on the way to a new
 * value (backspace, then type), which arms the same grace. A plain note deleted while the line is empty does not change
 * where the edit ends: typed on to Y, the edit's end (e1); left empty, the end of an id line deleted, the copy owning the
 * old id and unlocked once the grace ends (e2).
 */
/** N's id line emptied; `remove` heard 1 s later; then, unless `stay`, Y typed 1 s after that; the grace runs out. */
async function emptyThen(r: Rig, stay: boolean, remove?: () => Promise<void>): Promise<void> {
	r.clearId(N);
	r.plugin.checkPageIdentity(N);
	await vi.advanceTimersByTimeAsync(1000);
	if (remove) await remove();
	await vi.advanceTimersByTimeAsync(1000);
	if (!stay) {
		r.setId(N, Y);
		r.plugin.checkPageIdentity(N);
	}
	await r.drain();
	await r.drain();
}

/** Where the owner's emptied id line, left empty, leaves the copy with no note deleted (pinned below). */
function lineGoneEnds(r: Rig): void {
	expect.soft(inlineInk.isDuplicateLocked(C), "the copy left alone on the old id is still locked").toBe(false);
	expect.soft(r.plugin.pageIds.owner(X), "the copy left alone on the old id does not own it").toBe(C);
	expect.soft(r.told(), "the lift is not told once").toBe(1);
	expect.soft(ids(inlineInk.strokes(C)).sort(), "the copy does not show the shared stroke and its own").toEqual(["c1", "p0"]);
	expect.soft(r.onDisk()?.sort(), "the old id's file does not hold the copy's page").toEqual(["c1", "p0"]);
	expect.soft(r.plugin.pageIds.idsOf(N), "the owner still owns an id").toEqual([]);
}

describe.each([true, false])("the owner's id line emptied, its ink loaded: %s", (loaded) => {
	it("pin: then Y typed, no note deleted: the edit's end", async () => {
		const r = rig([N, C], [P]);
		await ownerAndLockedCopies(r, loaded);
		const moves = watchMove(r);

		await emptyThen(r, false);

		editEnds(r, loaded, moves);
	});

	it("a plain note deleted while it is empty, then Y typed: the edit's end, as with no delete", async () => {
		const r = rig([N, C], [P]);
		await ownerAndLockedCopies(r, loaded);
		const moves = watchMove(r);

		await emptyThen(r, false, () => r.del(P));

		editEnds(r, loaded, moves);
	});

	it("pin: left empty, no note deleted: the copy owns the old id and is unlocked once the grace ends", async () => {
		const r = rig([N, C], [P]);
		await ownerAndLockedCopies(r, loaded);

		await emptyThen(r, true);

		lineGoneEnds(r);
	});

	it("a plain note deleted while it is empty, left empty: the copy owns the old id and is unlocked once the grace ends", async () => {
		const r = rig([N, C], [P]);
		await ownerAndLockedCopies(r, loaded);

		await emptyThen(r, true, () => r.del(P));

		lineGoneEnds(r);
	});
});
