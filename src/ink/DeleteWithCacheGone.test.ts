/**
 * A NOTE DELETED WHILE ANOTHER NOTE IS DUPLICATE-LOCKED ON ITS ID. Obsidian loads plugins before its cache hooks the
 * vault, so at app start the plugin hears a delete first and the cache still names the deleted note's id. A plugin
 * turned on or updated while Obsidian runs hears it second: the cache answers nothing for the deleted path.
 *
 * Whichever ran first, a note that is then the ONLY note carrying an id it was duplicate-locked on is unlocked in that
 * session: its strokes drawn while locked reach the ink file, and the lift is told once. Two or more notes still
 * carrying the id all stay locked, none gets the id, and it stays known as ambiguous. Nothing is recycled on a guess:
 * a deleted note whose id is not proven keeps its ink file.
 *
 * Real InlineInkStore (the plugin's), real PageStore over FakeAdapter, the real delete handler on a plugin built without
 * its constructor. The delete runs as Obsidian runs it: with the cache's entry gone before the plugin's handler, or
 * (app start) after it; then the inline store's handler.
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
const X = "shared-id";
const Y = "edited-id";
const FILE = `.handwriting/${X}.json`;
const RESOLVED = "Handwriting: duplicate resolved. Ink on this note saves again.";

type Order = "cache-empty" | "app-start";
const ORDERS: Order[] = ["cache-empty", "app-start"];

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
 * Notes on one id, the shared file holding p0. The vault lists a note until it is deleted; the cache answers for a
 * note until its own delete listener runs, with the id line the note carries now.
 */
function rig(paths: string[]) {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const shared = emptyPage(X);
	shared.surface = "inline";
	shared.strokes = [stroke("p0", 5)];
	fake.files.set(FILE, serializePage(shared));
	const files = new Map<string, TFile>();
	for (const path of paths) files.set(path, Object.assign(new TFile(), { path, extension: "md", basename: path.slice(0, -3) }));
	const listed = new Set(paths);
	const cached = new Set(paths);
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
	/** A sync's create half: the note is back at `path`, with its id line, as a new file. */
	const create = (path: string): void => {
		files.set(path, Object.assign(new TFile(), { path, extension: "md", basename: path.slice(0, -3) }));
		listed.add(path);
		cached.add(path);
		idOf.set(path, X);
	};
	/** The note's id line now names `id` (an edit the cache has indexed). */
	const setId = (path: string, id: string): void => void idOf.set(path, id);
	/** The note's id line is gone (an edit the cache has indexed). */
	const clearId = (path: string): void => void idOf.delete(path);
	const told = (): number => notices.filter((n) => n === RESOLVED).length;
	return { plugin, fake, store, notices, saves, onDisk, del, create, setId, clearId, told, drain };
}

/**
 * The start-up census found these notes on one id with no remembered owner: every one locked, none owns it. `open` are
 * the notes whose ink is loaded; the others keep the record the census made.
 */
async function ambiguous(r: ReturnType<typeof rig>, paths: string[], open: string[] = paths): Promise<void> {
	r.plugin.ambiguousIds.set(X, [...paths]);
	for (const p of paths) inlineInk.markDuplicateLocked(p, paths.find((q) => q !== p)!);
	for (const p of open) await inlineInk.ensureLoaded(p);
	for (const p of paths) expect(inlineInk.isDuplicateLocked(p), `precondition: ${p} is locked`).toBe(true);
	expect(r.plugin.pageIds.owner(X), "precondition: no note owns the id").toBeUndefined();
}

/** A stroke drawn on a locked note: shown, not saved. */
async function drawLocked(r: ReturnType<typeof rig>, path: string, id: string): Promise<void> {
	const before = r.saves.length;
	inlineInk.commit(path, stroke(id, 70));
	await r.drain();
	expect(r.saves.length - before, "precondition: the lock refused the save").toBe(0);
	expect(r.onDisk(), "precondition: the stroke is not in the file").toEqual(["p0"]);
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	for (const p of [N, C, D]) inlineInk.handleDelete(p);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe.each(ORDERS)("a note deleted while another is duplicate-locked on its id, %s", (order) => {
	it("an ambiguous pair with no owner: the note left alone on the id is unlocked and its locked-time stroke is saved", async () => {
		const r = rig([N, C]);
		await ambiguous(r, [N, C]);
		await drawLocked(r, C, "c1");

		await r.del(N, order);
		await r.drain();

		expect(inlineInk.isDuplicateLocked(C), "the note left alone on the id is still locked").toBe(false);
		expect(r.onDisk(), "the stroke drawn while locked is not in the ink file").toEqual(["p0", "c1"]);
		expect(r.told(), "the lift is told once").toBe(1);
		expect(r.plugin.ambiguousIds.has(X), "the pair is no longer ambiguous").toBe(false);
		expect(r.plugin.pageIds.owner(X), "the note left owns the id").toBe(C);
		// Past the recycle grace: the id lives on in the note left, so its ink file stays.
		await vi.advanceTimersByTimeAsync(15_000);
		await r.drain();
		expect(r.onDisk(), "the ink file was recycled").toEqual(["p0", "c1"]);
	});

	it("three notes on the id with no owner: one deleted leaves both others locked; a second deleted unlocks the last", async () => {
		const r = rig([N, C, D]);
		await ambiguous(r, [N, C, D]);
		await drawLocked(r, D, "d1");

		await r.del(N, order);
		await r.drain();

		expect(inlineInk.isDuplicateLocked(C), "a note still sharing its id was unlocked").toBe(true);
		expect(inlineInk.isDuplicateLocked(D), "a note still sharing its id was unlocked").toBe(true);
		expect(r.plugin.pageIds.owner(X), "a note still sharing its id was given the id").toBeUndefined();
		expect(r.plugin.ambiguousIds.has(X), "the id is no longer known as ambiguous").toBe(true);
		expect(r.told(), "a lift was told").toBe(0);
		expect(r.onDisk(), "a locked note's stroke was saved").toEqual(["p0"]);

		await r.del(C, order);
		await r.drain();

		expect(inlineInk.isDuplicateLocked(D), "the note left alone on the id is still locked").toBe(false);
		expect(r.onDisk(), "the stroke drawn while locked is not in the ink file").toEqual(["p0", "d1"]);
		expect(r.told(), "the lift is told once").toBe(1);
		expect(r.plugin.pageIds.owner(X), "the note left owns the id").toBe(D);
		await vi.advanceTimersByTimeAsync(15_000);
		await r.drain();
		expect(r.onDisk(), "the ink file was recycled").toEqual(["p0", "d1"]);
	});

	it("a deleted note alone on its id, its owner: the ink file is recycled after the grace, as before", async () => {
		const r = rig([N]);
		r.plugin.pageIds.claimOwnership(X, N);
		await inlineInk.ensureLoaded(N);

		await r.del(N, order);
		await vi.advanceTimersByTimeAsync(3000);
		expect(r.onDisk(), "precondition: inside the grace the file stays").not.toBeNull();
		await vi.advanceTimersByTimeAsync(15_000);
		await r.drain();
		expect(r.onDisk(), "the deleted owner's ink file was not recycled").toBeNull();
	});

	it("a deleted note alone on its id, then created again inside the grace: nothing is recycled", async () => {
		const r = rig([N]);
		r.plugin.pageIds.claimOwnership(X, N);
		await inlineInk.ensureLoaded(N);

		await r.del(N, order);
		await vi.advanceTimersByTimeAsync(3000);
		r.create(N);
		await vi.advanceTimersByTimeAsync(15_000);
		await r.drain();
		expect(r.onDisk(), "the ink file of a note that came back was recycled").toEqual(["p0"]);
	});
});

describe("a note deleted after the metadata cache dropped it", () => {
	it("an ambiguous pair, the note left never opened: it is unlocked, told once, and nothing is written", async () => {
		const r = rig([N, C]);
		await ambiguous(r, [N, C], [N]);
		const before = r.saves.length;

		await r.del(N);
		await r.drain();

		expect(inlineInk.isDuplicateLocked(C), "the note left alone on the id is still locked").toBe(false);
		expect(r.told(), "the lift is told once").toBe(1);
		expect(r.saves.length - before, "a never-opened note's ink was written").toBe(0);
		expect(r.onDisk(), "the ink file changed").toEqual(["p0"]);
	});

	it("the note left is the registered owner and locked, the copy is deleted: it is unlocked and its stroke is saved", async () => {
		const r = rig([N, C]);
		r.plugin.pageIds.claimOwnership(X, C);
		inlineInk.markDuplicateLocked(C, N);
		await inlineInk.ensureLoaded(C);
		expect(inlineInk.isDuplicateLocked(C), "precondition: the owner is locked").toBe(true);
		await drawLocked(r, C, "c1");
		const persist = vi.spyOn(r.plugin, "persistOwners");

		await r.del(N);
		await r.drain();

		expect(inlineInk.isDuplicateLocked(C), "the owner left alone on the id is still locked").toBe(false);
		expect(r.onDisk(), "the stroke drawn while locked is not in the ink file").toEqual(["p0", "c1"]);
		expect(r.told(), "the lift is told once").toBe(1);
		// Before the census the ledger holds only this session's claims; saving it then drops every remembered one.
		expect(persist, "the ledger was saved before the census").not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(15_000);
		await r.drain();
		expect(r.onDisk(), "the ink file was recycled").toEqual(["p0", "c1"]);
	});

	it("an ambiguous pair whose first metadata change made the note left its owner: the copy deleted unlocks it", async () => {
		const r = rig([N, C]);
		await ambiguous(r, [N, C]);
		// What the first metadata change of the note does: the ledger had no owner, so the note registers.
		expect(r.plugin.pageIds.register(C, X).kind, "precondition: the note left registered as owner").toBe("registered");
		expect(r.plugin.ambiguousIds.has(X), "precondition: the id is still ambiguous").toBe(true);
		await drawLocked(r, C, "c1");

		await r.del(N);
		await r.drain();

		expect(inlineInk.isDuplicateLocked(C), "the owner left alone on the id is still locked").toBe(false);
		expect(r.onDisk(), "the stroke drawn while locked is not in the ink file").toEqual(["p0", "c1"]);
		expect(r.told(), "the lift is told once").toBe(1);
		expect(r.plugin.pageIds.owner(X)).toBe(C);
	});

	it("the note left had its id line edited since the lock: no claim on the old id, and the old ink file is untouched", async () => {
		const r = rig([N, C]);
		await ambiguous(r, [N, C]);
		await drawLocked(r, C, "c1");
		r.setId(C, Y);

		await r.del(N);
		await r.drain();

		expect(r.plugin.pageIds.owner(X), "the old id was claimed").toBeUndefined();
		expect(r.onDisk(), "a stroke went into the old id's ink file").toEqual(["p0"]);
		expect(r.told(), "a lift was told").toBe(0);
		// No note left carries the old id: an entry kept for it would stop a later note from following that id.
		expect(r.plugin.ambiguousIds.has(X), "the id no note carries is still held as ambiguous").toBe(false);
	});

	it("a folder delete takes both notes of a pair: the locked note's stroke is not written", async () => {
		const r = rig([N, C]);
		await ambiguous(r, [N, C]);
		await drawLocked(r, C, "c1");

		const first = r.del(N);
		const second = r.del(C);
		await Promise.all([first, second]);
		for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(2000);
		// Read before the grace runs out: past it, both notes are gone and the ink file is recycled as any deleted note's.
		expect(r.onDisk(), "a deleted note's stroke was written").toEqual(["p0"]);
	});

	it("a folder delete takes both notes of a pair: past the grace the ink file is recycled", async () => {
		const r = rig([N, C]);
		await ambiguous(r, [N, C]);
		await drawLocked(r, C, "c1");

		const first = r.del(N);
		const second = r.del(C);
		await Promise.all([first, second]);
		await vi.advanceTimersByTimeAsync(15_000);
		await r.drain();

		expect(r.onDisk(), "the ink file of two deleted notes stayed").toBeNull();
	});

	it("an ambiguous pair, the copy deleted and created again inside the grace: no stroke is lost, nothing recycled", async () => {
		const r = rig([N, C]);
		await ambiguous(r, [N, C]);
		await drawLocked(r, C, "c1");

		await r.del(N);
		await vi.advanceTimersByTimeAsync(3000);
		r.create(N);
		await vi.advanceTimersByTimeAsync(15_000);
		await r.drain();

		expect(r.onDisk(), "a stroke was lost or the ink file recycled").toEqual(["p0", "c1"]);
	});
});

describe("a recycle past the grace", () => {
	/** The deleted owner N, with a remembered owner entry and a camera in the settings. */
	async function owned(r: ReturnType<typeof rig>): Promise<void> {
		r.plugin.pageIds.claimOwnership(X, N);
		r.plugin.settings.pageOwners[X] = N;
		r.plugin.settings.cameras[X] = { x: 0, y: 0, zoom: 1 };
		await inlineInk.ensureLoaded(N);
	}
	const trashed = (r: ReturnType<typeof rig>): boolean => [...r.fake.files.keys()].some((k) => k.includes("trash") && k.includes(X));

	it("the note comes back while the ink file is being moved: its owner entry and its camera are kept", async () => {
		const r = rig([N]);
		await owned(r);
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		const remove = r.store.remove.bind(r.store);
		vi.spyOn(r.store, "remove").mockImplementation(async (id: string) => {
			await held;
			return remove(id);
		});

		await r.del(N);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(r.store.remove, "precondition: the recycle is moving the ink file").toHaveBeenCalledTimes(1);
		// A slow sync puts the note back now; its first metadata change registers it and saves the ledger.
		r.create(N);
		expect(r.plugin.pageIds.register(N, X).kind, "precondition: the note came back registered").toBe("registered");
		r.plugin.persistOwners();
		release();
		await r.drain();

		expect(r.plugin.settings.pageOwners[X], "the owner entry of a note that came back was deleted").toBe(N);
		expect(r.plugin.settings.cameras[X], "the camera of a note that came back was deleted").toBeDefined();
	});

	it("a note that stayed deleted: its owner entry and its camera go, and its ink is in the trash", async () => {
		const r = rig([N]);
		await owned(r);

		await r.del(N);
		await vi.advanceTimersByTimeAsync(15_000);
		await r.drain();

		expect(r.onDisk(), "the ink file stayed").toBeNull();
		expect(trashed(r), "the ink is not in the trash").toBe(true);
		expect(r.plugin.settings.pageOwners[X], "the owner entry stayed").toBeUndefined();
		expect(r.plugin.settings.cameras[X], "the camera stayed").toBeUndefined();
	});
});

/**
 * A third note on the id that the start-up census did not list. A note made after the census with the id line (a copy of
 * one of the pair) registers as the id's owner on its first metadata change (the id has no owner yet) and is not locked.
 * While two or more notes still carry the id, the lock stands, in both listener orders. Every line is soft so that what an
 * unlock costs is read even when the lock line is already red.
 */
describe.each(ORDERS)("a third note on the id, made after the census, %s", (order) => {
	it("one of the pair deleted leaves the other locked beside the later note", async () => {
		const r = rig([N, C, D]);
		await ambiguous(r, [N, C]);
		expect(r.plugin.pageIds.register(D, X).kind, "precondition: the later note registered as owner").toBe("registered");
		await inlineInk.ensureLoaded(D);
		expect(inlineInk.isDuplicateLocked(D), "precondition: the later note is not locked").toBe(false);
		await drawLocked(r, C, "c1");

		await r.del(N, order);
		await r.drain();

		expect.soft(inlineInk.isDuplicateLocked(C), "a note still sharing its id with a live note was unlocked").toBe(true);
		expect.soft(r.plugin.pageIds.owner(X), "the id was given to a note while another still carries it").not.toBe(C);

		// What an unlock costs: the later note draws and saves; ink an unlocked note shows must be in the file.
		inlineInk.commit(D, stroke("d1", 120));
		await r.drain();
		const file = r.onDisk() ?? [];
		for (const p of [C, D]) {
			if (inlineInk.isDuplicateLocked(p)) continue;
			const missing = ids(inlineInk.strokes(p)).filter((id) => !file.includes(id));
			expect.soft(missing, `ink ${p} shows unlocked is not in the shared file`).toEqual([]);
		}
	});
});

/**
 * The lock notice's own remedies on a census pair: the id line deleted from one note (past the grace), or its id value
 * edited. The notes left on the id are counted in the vault, not on the census's list: a note copied after the census
 * carries the id too. One left owns it and its lock lifts; two or more, every lock stands and none is given the id; none,
 * the entry goes. Every want is soft so that what an unlock costs is read even when the lock line is already red.
 */
type Door = "id line deleted" | "id edited";
const DOORS: Door[] = ["id line deleted", "id edited"];

/** `path`'s id line goes or is edited to `edited`, as the cache indexes it; its metadata change is heard; the grace runs out. */
async function openDoor(r: ReturnType<typeof rig>, path: string, door: Door, edited = Y): Promise<void> {
	if (door === "id line deleted") r.clearId(path);
	else r.setId(path, edited);
	r.plugin.checkPageIdentity(path);
	await r.drain();
}

describe.each(DOORS)("a census pair's note leaves the id (%s)", (door) => {
	it("a third note copied after the census still carries it: the other note stays locked and is not given the id", async () => {
		const r = rig([N, C, D]);
		await ambiguous(r, [N, C]);
		expect(r.plugin.pageIds.register(D, X).kind, "precondition: the later note registered as owner").toBe("registered");
		await inlineInk.ensureLoaded(D);
		expect(inlineInk.isDuplicateLocked(D), "precondition: the later note is not locked").toBe(false);
		await drawLocked(r, N, "n1");

		await openDoor(r, C, door);

		expect.soft(inlineInk.isDuplicateLocked(N), "a note still sharing its id with a live note was unlocked").toBe(true);
		expect.soft(r.plugin.pageIds.owner(X), "the id was given to a note while another still carries it").not.toBe(N);
		expect.soft(r.plugin.ambiguousIds.has(X), "the id is no longer known as ambiguous").toBe(true);

		// What an unlock costs: the later note draws and saves; ink an unlocked note shows must be in the file.
		inlineInk.commit(D, stroke("d1", 120));
		await r.drain();
		const file = r.onDisk() ?? [];
		for (const p of [N, D]) {
			if (inlineInk.isDuplicateLocked(p)) continue;
			const missing = ids(inlineInk.strokes(p)).filter((id) => !file.includes(id));
			expect.soft(missing, `ink ${p} shows unlocked is not in the shared file`).toEqual([]);
		}
	});

	it("no third note: the other note is the only one left, owns the id and is unlocked", async () => {
		const r = rig([N, C]);
		await ambiguous(r, [N, C]);
		await drawLocked(r, N, "n1");

		await openDoor(r, C, door);

		expect(inlineInk.isDuplicateLocked(N), "the note left alone on the id is still locked").toBe(false);
		expect(r.plugin.pageIds.owner(X)).toBe(N);
		expect(r.plugin.ambiguousIds.has(X), "the id is still known as ambiguous").toBe(false);
		expect(r.onDisk(), "the stroke drawn while locked is not in the ink file").toContain("n1");
	});

	it("both of the pair leave the id: the later note keeps it and the entry goes", async () => {
		const r = rig([N, C, D]);
		await ambiguous(r, [N, C]);
		expect(r.plugin.pageIds.register(D, X).kind, "precondition: the later note registered as owner").toBe("registered");
		await inlineInk.ensureLoaded(D);

		await openDoor(r, C, door);
		// Another value than the first note's: two notes edited to one id would be a new pair.
		await openDoor(r, N, door, "edited-id-2");

		expect(r.plugin.pageIds.owner(X), "the later note lost the id").toBe(D);
		expect(inlineInk.isDuplicateLocked(D)).toBe(false);
		expect(r.plugin.ambiguousIds.has(X), "the id no note but one carries is still held as ambiguous").toBe(false);
	});
});

/**
 * The id's owner deleted while two copies of it are locked (each copy's clone failed): the ledger frees the id and two
 * notes still carry it, so every lock stands and none is given the id. The lock notice's first remedy on one copy (its id
 * line deleted, past the grace) or its id value edited then leaves the other copy the only note on the id: it owns the id,
 * is unlocked, is told once, and the stroke drawn on it while locked is in the ink file. In both listener orders of the
 * delete. No other note is deleted on the way: any delete of a note with no id lifts a lock left alone on its own.
 */
describe.each(ORDERS)("the owner deleted with two locked copies left, %s", (order) => {
	it.each(DOORS)("one copy leaves the id (%s): the other is the only note on it, owns it, is unlocked, told once, its stroke saved", async (door) => {
		const r = rig([N, C, D]);
		// Past the census: the id-line doors run only then.
		r.plugin.pageIdWatchReady = true;
		r.plugin.pageIds.claimOwnership(X, N);
		inlineInk.markDuplicateLocked(C, N);
		inlineInk.markDuplicateLocked(D, N);
		for (const p of [N, C, D]) await inlineInk.ensureLoaded(p);
		for (const p of [C, D]) expect(inlineInk.isDuplicateLocked(p), `precondition: ${p} is locked`).toBe(true);
		expect(r.plugin.pageIds.owner(X), "precondition: the original owns the id").toBe(N);
		expect(r.plugin.ambiguousIds.has(X), "precondition: an owned id is not listed").toBe(false);
		await drawLocked(r, C, "c1");

		await r.del(N, order);
		await r.drain();

		expect(inlineInk.isDuplicateLocked(C), "a note still sharing its id was unlocked").toBe(true);
		expect(inlineInk.isDuplicateLocked(D), "a note still sharing its id was unlocked").toBe(true);
		expect(r.plugin.pageIds.owner(X), "a note still sharing its id was given the id").toBeUndefined();
		expect(r.told(), "a lift was told").toBe(0);
		expect(r.onDisk(), "a locked note's stroke was saved").toEqual(["p0"]);

		await openDoor(r, D, door);

		expect(inlineInk.isDuplicateLocked(C), "the note left alone on the id is still locked").toBe(false);
		expect(r.plugin.pageIds.owner(X), "the note left alone on the id does not own it").toBe(C);
		expect(r.onDisk(), "the stroke drawn while locked is not in the ink file").toEqual(["p0", "c1"]);
		expect(r.told(), "the lift is not told once").toBe(1);
		expect(r.plugin.ambiguousIds.has(X), "the id is still known as ambiguous").toBe(false);
	});
});

/** Every stroke id in a live ink file (trash left out). */
const inkFileIds = (r: ReturnType<typeof rig>): string[] => {
	const out: string[] = [];
	for (const [k, t] of r.fake.files) {
		if (!k.startsWith(".handwriting/") || !k.endsWith(".json") || k.includes("trash")) continue;
		out.push(...ids(parsePage(t, k.slice(13, -5)).data.strokes));
	}
	return out;
};

/** The stroke ids in the new id's ink file, or none. */
const editedFileIds = (r: ReturnType<typeof rig>): string[] => {
	const t = r.fake.files.get(`.handwriting/${Y}.json`);
	return t === undefined ? [] : ids(parsePage(t, Y).data.strokes);
};

/** N owns the id; C is locked as its copy, its ink loaded; `ownerLoaded`: N's too. `draw`: a stroke c1 drawn on C, refused. */
async function ownerAndLockedCopy(r: ReturnType<typeof rig>, ownerLoaded: boolean, draw = true): Promise<void> {
	r.plugin.pageIds.claimOwnership(X, N);
	inlineInk.markDuplicateLocked(C, N);
	if (ownerLoaded) await inlineInk.ensureLoaded(N);
	await inlineInk.ensureLoaded(C);
	expect(r.plugin.pageIds.owner(X), "precondition: N owns the id").toBe(N);
	expect(r.plugin.ambiguousIds.has(X), "precondition: the id is not listed").toBe(false);
	expect(inlineInk.isDuplicateLocked(C), "precondition: C is locked").toBe(true);
	expect(inlineInk.isDuplicateLocked(N), "precondition: N is not locked").toBe(false);
	if (draw) await drawLocked(r, C, "c1");
}

/**
 * Watches the owner's file move (each old-id file set under the new id): at the start and the end of each step, a copy
 * unlocked or the id not the owner's is noted. Returns the notes, and how many steps ran.
 */
function watchMove(r: ReturnType<typeof rig>, copies: string[]): () => { steps: number; seen: string[] } {
	const seen: string[] = [];
	let steps = 0;
	const look = (when: string): void => {
		for (const p of copies) if (!inlineInk.isDuplicateLocked(p)) seen.push(`${p} unlocked ${when}`);
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

/** The owner's files moved, and no copy was unlocked or given the id while they moved. */
function movedFirst(moves: () => { steps: number; seen: string[] }): void {
	expect.soft(moves().steps, "the owner's files did not move").toBeGreaterThan(0);
	expect.soft(moves().seen, "a copy was unlocked or given the id while the owner's files moved").toEqual([]);
}

/**
 * The id's owner leaves it by editing its id value, with one locked copy left on it. The notes left on the old id are
 * counted in the vault, whether the owner's ink is loaded or not: the one left owns the id, is unlocked, and the stroke
 * drawn on it while locked reaches a live ink file. Deleting the owner's id line instead gives the same answer.
 */
describe("the owner leaves the id beside one locked copy", () => {
	it("the owner's id value edited, its ink loaded: the copy left alone on the id is unlocked, owns it, and its stroke is saved", async () => {
		const r = rig([N, C]);
		await ownerAndLockedCopy(r, true);
		const moves = watchMove(r, [C]);

		r.setId(N, Y);
		r.plugin.checkPageIdentity(N);
		await r.drain();
		await r.drain();

		movedFirst(moves);
		expect.soft(inlineInk.isDuplicateLocked(C), "the copy left alone on the id is still locked").toBe(false);
		expect.soft(r.plugin.pageIds.owner(X), "the copy left alone does not own the id").toBe(C);
		expect.soft(inkFileIds(r), "the stroke drawn on the copy while locked is in no ink file").toContain("c1");
		expect.soft(ids(inlineInk.strokes(C)).sort(), "the copy does not show the shared stroke and its own").toEqual(["c1", "p0"]);
		expect.soft(r.onDisk()?.sort(), "the old id's file does not hold the copy's page").toEqual(["c1", "p0"]);
	});

	it("the owner's id value edited, its ink not loaded: the copy left alone on the id is unlocked, owns it, and its stroke is saved", async () => {
		const r = rig([N, C]);
		await ownerAndLockedCopy(r, false);

		r.setId(N, Y);
		r.plugin.checkPageIdentity(N);
		await r.drain();
		await r.drain();

		expect.soft(inlineInk.isDuplicateLocked(C), "the copy left alone on the id is still locked").toBe(false);
		expect.soft(r.plugin.pageIds.owner(X), "the copy left alone does not own the id").toBe(C);
		expect.soft(inkFileIds(r), "the stroke drawn on the copy while locked is in no ink file").toContain("c1");
		expect.soft(ids(inlineInk.strokes(C)).sort(), "the copy does not show the shared stroke and its own").toEqual(["c1", "p0"]);
		expect.soft(r.onDisk()?.sort(), "the old id's file does not hold the copy's page").toEqual(["c1", "p0"]);
	});

	it("the owner's id line deleted: the copy left alone on the id is unlocked, owns it, and its stroke is saved", async () => {
		const r = rig([N, C]);
		await ownerAndLockedCopy(r, true);

		r.clearId(N);
		r.plugin.checkPageIdentity(N);
		await r.drain();
		await r.drain();

		expect.soft(inlineInk.isDuplicateLocked(C), "the copy left alone on the id is still locked").toBe(false);
		expect.soft(r.plugin.pageIds.owner(X), "the copy left alone does not own the id").toBe(C);
		expect.soft(inkFileIds(r), "the stroke drawn on the copy while locked is in no ink file").toContain("c1");
	});
});

/**
 * The owner leaves the id by editing its id value beside one locked copy that drew nothing while locked. The owner's files
 * move to its new id first, so the copy's read of the old id after the lift finds no file. What the copy shows is then
 * saved under the old id, once: reopened, it shows the same page. Only this session's own move of the old id's file does
 * that, for the lift that move led to (a clear that waits behind that lift's read included). A read that finds no file at
 * any other lift writes nothing, as before (a missing file may be a sync's, mid-replace), a read that threw writes nothing,
 * and a copy that shows no stroke writes nothing.
 */
describe("the owner leaves the id beside one locked copy that drew nothing", () => {
	const savesOf = (r: ReturnType<typeof rig>, id: string): number => r.saves.filter((s) => s === id).length;
	const leaves = async (r: ReturnType<typeof rig>): Promise<void> => {
		r.setId(N, Y);
		r.plugin.checkPageIdentity(N);
		await r.drain();
		await r.drain();
	};

	it("the owner's id value edited, its ink loaded: the shared stroke the copy shows is saved under the old id, once", async () => {
		const r = rig([N, C]);
		await ownerAndLockedCopy(r, true, false);
		const moves = watchMove(r, [C]);

		await leaves(r);

		movedFirst(moves);
		expect.soft(editedFileIds(r), "the owner's ink did not go with it to its new id").toEqual(["p0"]);
		expect.soft(inlineInk.isDuplicateLocked(C), "the copy left alone on the id is still locked").toBe(false);
		expect.soft(r.plugin.pageIds.owner(X), "the copy left alone does not own the id").toBe(C);
		expect.soft(r.told(), "the lift is not told once").toBe(1);
		expect.soft(ids(inlineInk.strokes(C)), "the copy does not show the shared stroke").toEqual(["p0"]);
		expect.soft(r.onDisk(), "the stroke the copy shows is in no file under its id: reopened, the copy is blank").toEqual(["p0"]);
		expect.soft(savesOf(r, X), "the copy's page is not saved under its id once").toBe(1);
		// Once: nothing more is written under the id until the copy changes its ink.
		await r.drain();
		expect.soft(savesOf(r, X), "the copy saved again with nothing changed").toBe(1);
	});

	it("the owner's id value edited, the first round left part done: the move ends a grace later and the copy's page is saved under the old id, once", async () => {
		const r = rig([N, C]);
		await ownerAndLockedCopy(r, true, false);
		// The first round moves the inline file, then finds the Slides file held: it tries again a grace later, when the old
		// id has no inline file left to move.
		const real = r.store.keepAsideUnder.bind(r.store);
		const rounds: string[] = [];
		vi.spyOn(r.store, "keepAsideUnder").mockImplementation(async (from, to, own, named) => {
			const first = !rounds.some((f) => f !== X);
			rounds.push(from);
			if (from !== X && first) return { kind: "held" };
			return real(from, to, own, named);
		});

		await leaves(r);

		expect.soft(rounds.length, "precondition: the move did not run a second round").toBeGreaterThan(2);
		expect.soft(editedFileIds(r), "the owner's ink did not go with it to its new id").toEqual(["p0"]);
		expect.soft(inlineInk.isDuplicateLocked(C), "the copy left alone on the id is still locked").toBe(false);
		expect.soft(r.plugin.pageIds.owner(X), "the copy left alone does not own the id").toBe(C);
		expect.soft(ids(inlineInk.strokes(C)), "the copy does not show the shared stroke").toEqual(["p0"]);
		expect.soft(r.onDisk(), "the stroke the copy shows is in no file under its id: reopened, the copy is blank").toEqual(["p0"]);
		expect.soft(savesOf(r, X), "the copy's page is not saved under its id once").toBe(1);
	});

	it("the old id's file gone before the owner's id value is edited: the move takes nothing, and nothing is written under the old id", async () => {
		const r = rig([N, C]);
		await ownerAndLockedCopy(r, true, false);
		// A sync replacing the file, mid-replace: the copy still shows what it loaded.
		r.fake.files.delete(FILE);

		await leaves(r);

		expect.soft(inlineInk.isDuplicateLocked(C), "the copy left alone on the id is still locked").toBe(false);
		expect.soft(r.plugin.pageIds.owner(X), "the copy left alone does not own the id").toBe(C);
		expect.soft(r.onDisk(), "a file under the old id was written, though this session's move took none away").toBeNull();
		expect.soft(savesOf(r, X), "the copy saved under the old id").toBe(0);
	});

	it("the owner's id line deleted, the old id's file gone meanwhile: nothing moves, and nothing is written under the old id", async () => {
		const r = rig([N, C]);
		await ownerAndLockedCopy(r, true, false);
		r.fake.files.delete(FILE);

		r.clearId(N);
		r.plugin.checkPageIdentity(N);
		await r.drain();
		await r.drain();

		expect.soft(inlineInk.isDuplicateLocked(C), "the copy left alone on the id is still locked").toBe(false);
		expect.soft(r.plugin.pageIds.owner(X), "the copy left alone does not own the id").toBe(C);
		expect.soft(r.onDisk(), "a file under the old id was written, though no move took it away").toBeNull();
		expect.soft(savesOf(r, X), "the copy saved under the old id").toBe(0);
	});

	it("the owner's id value edited, the copy's read of the old id throws: nothing is written under it and no lift is told", async () => {
		const r = rig([N, C]);
		await ownerAndLockedCopy(r, true, false);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const real = r.store.load.bind(r.store);
		vi.spyOn(r.store, "load").mockImplementation(async (id, options) => {
			if (id === X) throw new Error("read failed");
			return real(id, options);
		});

		await leaves(r);

		expect.soft(editedFileIds(r), "precondition: the owner's ink went with it to its new id").toEqual(["p0"]);
		expect.soft(r.onDisk(), "a file under the old id was written after a read that threw").toBeNull();
		expect.soft(savesOf(r, X), "the copy saved under the old id after a read that threw").toBe(0);
		expect.soft(r.told(), "a lift was told after a read that threw").toBe(0);
	});

	it("the owner's id value edited, the new id already holding a file: the old id's file is set beside it, and the copy's page is saved under the old id, once", async () => {
		const r = rig([N, C]);
		const there = emptyPage(Y);
		there.surface = "inline";
		there.strokes = [stroke("y0", 40)];
		r.fake.files.set(`.handwriting/${Y}.json`, serializePage(there));
		await ownerAndLockedCopy(r, true, false);

		await leaves(r);

		expect.soft(editedFileIds(r), "precondition: the new id's own file was not kept").toEqual(["y0"]);
		expect.soft(inkFileIds(r), "the owner's ink is in no ink file").toContain("p0");
		expect.soft(inlineInk.isDuplicateLocked(C), "the copy left alone on the id is still locked").toBe(false);
		expect.soft(ids(inlineInk.strokes(C)), "the copy does not show the shared stroke").toEqual(["p0"]);
		expect.soft(r.onDisk(), "the stroke the copy shows is in no file under its id: reopened, the copy is blank").toEqual(["p0"]);
		expect.soft(savesOf(r, X), "the copy's page is not saved under its id once").toBe(1);
	});

	it("the owner's id value edited, the shared page holding no stroke: the copy shows nothing and nothing is written under the old id", async () => {
		const r = rig([N, C]);
		const bare = emptyPage(X);
		bare.surface = "inline";
		r.fake.files.set(FILE, serializePage(bare));
		await ownerAndLockedCopy(r, true, false);

		await leaves(r);

		expect.soft(inlineInk.isDuplicateLocked(C), "the copy left alone on the id is still locked").toBe(false);
		expect.soft(ids(inlineInk.strokes(C)), "precondition: the copy shows a stroke").toEqual([]);
		expect.soft(r.onDisk(), "a file under the old id was written for a copy that shows nothing").toBeNull();
		expect.soft(savesOf(r, X), "the copy saved under the old id with nothing to show").toBe(0);
	});

	it("after the copy's page is saved under the old id, it is locked again, the file removed outside, and the lock cleared: nothing is written", async () => {
		const r = rig([N, C]);
		await ownerAndLockedCopy(r, true, false);
		await leaves(r);
		expect.soft(r.onDisk(), "the stroke the copy shows is in no file under its id: reopened, the copy is blank").toEqual(["p0"]);
		expect.soft(savesOf(r, X), "the copy's page is not saved under its id once").toBe(1);

		// A third note heard on the id locks the copy again; the file goes by another hand (a sync mid-replace); the third
		// note leaves the id and the lock clears. No move of this session took the file this time.
		inlineInk.markDuplicateLocked(C, D);
		r.fake.files.delete(FILE);
		inlineInk.clearDuplicateLock(C);
		await r.drain();

		expect.soft(inlineInk.isDuplicateLocked(C), "the copy is still locked").toBe(false);
		expect.soft(r.onDisk(), "a file under the old id was written at a later lift no move of this session made").toBeNull();
		expect.soft(savesOf(r, X), "the copy saved under the old id at a later lift").toBe(1);
	});

	it("the owner's id value edited, the copy locked again and cleared again while its read of the old id is under way: its page is saved under the old id once that clear reads", async () => {
		const r = rig([N, C]);
		await ownerAndLockedCopy(r, true, false);
		const real = r.store.load.bind(r.store);
		let release: () => void = () => undefined;
		let reads = 0;
		vi.spyOn(r.store, "load").mockImplementation(async (id, options) => {
			if (id === X && reads++ === 0) await new Promise<void>((go) => (release = go));
			return real(id, options);
		});

		await leaves(r);
		expect(reads, "precondition: the copy's read of the old id did not start").toBe(1);
		// A third note heard on the id locks the copy again, then leaves it: this clear waits for the read under way.
		inlineInk.markDuplicateLocked(C, D);
		inlineInk.clearDuplicateLock(C);
		release();
		await r.drain();

		expect.soft(reads, "precondition: the waiting clear did not read the old id again").toBe(2);
		expect.soft(inlineInk.isDuplicateLocked(C), "the copy left alone on the id is still locked").toBe(false);
		expect.soft(ids(inlineInk.strokes(C)), "the copy does not show the shared stroke").toEqual(["p0"]);
		expect.soft(r.onDisk(), "the stroke the copy shows is in no file under its id: reopened, the copy is blank").toEqual(["p0"]);
		expect.soft(savesOf(r, X), "the copy's page is not saved under its id once").toBe(1);
	});
});

/**
 * The owner edits its id value while two copies of it are locked: two notes are left on the old id, so both locks stand,
 * no note is given the id, and the id is listed. The lock notice's first remedy on one copy (its id line deleted, past the
 * grace) then leaves the other the only note on the id: it owns it, is unlocked, is told once, and its stroke is saved.
 * No note is deleted on the way.
 */
describe.each([true, false])("the owner edits its id value with two locked copies left, its ink loaded: %s", (loaded) => {
	it("both stay locked and the id is listed; one copy's id line deleted: the other owns the id, is unlocked, told once, its stroke saved", async () => {
		const r = rig([N, C, D]);
		// Past the census: an id is listed only then.
		r.plugin.pageIdWatchReady = true;
		r.plugin.pageIds.claimOwnership(X, N);
		inlineInk.markDuplicateLocked(C, N);
		inlineInk.markDuplicateLocked(D, N);
		if (loaded) await inlineInk.ensureLoaded(N);
		for (const p of [C, D]) await inlineInk.ensureLoaded(p);
		for (const p of [C, D]) expect(inlineInk.isDuplicateLocked(p), `precondition: ${p} is locked`).toBe(true);
		expect(r.plugin.pageIds.owner(X), "precondition: the original owns the id").toBe(N);
		expect(r.plugin.ambiguousIds.has(X), "precondition: an owned id is not listed").toBe(false);
		await drawLocked(r, C, "c1");
		const moves = watchMove(r, [C, D]);

		r.setId(N, Y);
		r.plugin.checkPageIdentity(N);
		await r.drain();
		await r.drain();

		if (loaded) movedFirst(moves);
		expect.soft(inlineInk.isDuplicateLocked(C), "a note still sharing its id was unlocked").toBe(true);
		expect.soft(inlineInk.isDuplicateLocked(D), "a note still sharing its id was unlocked").toBe(true);
		expect.soft(r.plugin.pageIds.owner(X), "a note still owns the id two notes are left on").toBeUndefined();
		expect.soft(r.plugin.ambiguousIds.get(X), "the id two locked notes are left on is not listed").toEqual([C, D]);
		expect.soft(r.told(), "a lift was told").toBe(0);
		expect.soft(inkFileIds(r), "a locked note's stroke was saved").not.toContain("c1");

		await openDoor(r, D, "id line deleted");
		await r.drain();

		expect.soft(inlineInk.isDuplicateLocked(C), "the note left alone on the id is still locked").toBe(false);
		expect.soft(r.plugin.pageIds.owner(X), "the note left alone on the id does not own it").toBe(C);
		expect.soft(inkFileIds(r), "the stroke drawn while locked is in no ink file").toContain("c1");
		expect.soft(r.told(), "the lift is not told once").toBe(1);
		expect.soft(r.plugin.ambiguousIds.has(X), "the id is still known as ambiguous").toBe(false);
	});
});

/**
 * The copy's change is heard while the owner's id edit is still settling: inside the grace (the copy's body edited), or
 * before the owner's own change is heard. The copy is unlocked only after the owner's files have moved to its new id, so
 * none of the copy's strokes goes with the owner: the owner keeps its ink under the new id, and the copy owns the old id
 * with its stroke saved.
 */
describe.each([true, false])("the copy's change heard before the owner's edit settles, the owner's ink loaded: %s", (loaded) => {
	/** Inside the owner's grace, saves given time to land: nothing has passed to the copy yet. */
	const settling = async (r: ReturnType<typeof rig>): Promise<void> => {
		await vi.advanceTimersByTimeAsync(2500);
		await r.store.flush();
		expect.soft(inlineInk.isDuplicateLocked(C), "the copy was unlocked before the owner's edit settled").toBe(true);
		expect.soft(r.plugin.pageIds.owner(X), "the id passed from the owner before its edit settled").toBe(N);
		expect.soft(r.onDisk(), "the copy's stroke reached the shared file before the owner's edit settled").toEqual(["p0"]);
	};
	const wants = (r: ReturnType<typeof rig>, moves: () => { steps: number; seen: string[] }): void => {
		expect.soft(inlineInk.isDuplicateLocked(C), "the copy left alone on the id is still locked").toBe(false);
		expect.soft(r.plugin.pageIds.owner(X), "the copy left alone does not own the id").toBe(C);
		expect.soft(inkFileIds(r), "the stroke drawn on the copy while locked is in no ink file").toContain("c1");
		expect.soft(r.told(), "the lift is not told once").toBe(1);
		expect.soft(ids(inlineInk.strokes(C)).sort(), "the copy does not show the shared stroke and its own").toEqual(["c1", "p0"]);
		expect.soft(r.onDisk()?.sort(), "the old id's file does not hold the copy's page").toEqual(["c1", "p0"]);
		if (!loaded) return;
		movedFirst(moves);
		expect.soft(editedFileIds(r), "the owner's ink did not go with it to its new id").toContain("p0");
		expect.soft(editedFileIds(r), "a stroke of the copy went with the owner").not.toContain("c1");
		expect.soft(ids(inlineInk.strokes(N)), "the owner does not show its ink").toContain("p0");
	};

	it("the copy's body edited inside the grace: the copy is unlocked after the owner's files moved", async () => {
		const r = rig([N, C]);
		await ownerAndLockedCopy(r, loaded);
		const moves = watchMove(r, [C]);

		r.setId(N, Y);
		r.plugin.checkPageIdentity(N);
		await vi.advanceTimersByTimeAsync(1000);
		// The copy's body edited: its metadata changes, its id line still names the old id.
		r.plugin.checkPageIdentity(C);
		await settling(r);
		await r.drain();
		await r.drain();

		wants(r, moves);
	});

	it("the copy's change heard first, then the owner's: the copy is unlocked after the owner's files moved", async () => {
		const r = rig([N, C]);
		await ownerAndLockedCopy(r, loaded);
		const moves = watchMove(r, [C]);

		r.setId(N, Y);
		r.plugin.checkPageIdentity(C);
		r.plugin.checkPageIdentity(N);
		await settling(r);
		await r.drain();
		await r.drain();

		wants(r, moves);
	});
});

/**
 * The owner is itself locked (it registered on the id while locked, and the id is not listed) and edits its id value
 * beside one locked copy. It is still the id's owner: the copy left alone on the old id is counted, owns it, is unlocked,
 * told once, and its stroke is saved.
 */
describe.each([true, false])("a locked owner edits its id value beside one locked copy, its ink loaded: %s", (loaded) => {
	it("the copy left alone on the id is unlocked, owns it, and its stroke is saved", async () => {
		const r = rig([N, C]);
		r.plugin.pageIds.claimOwnership(X, N);
		inlineInk.markDuplicateLocked(N, C);
		inlineInk.markDuplicateLocked(C, N);
		if (loaded) await inlineInk.ensureLoaded(N);
		await inlineInk.ensureLoaded(C);
		expect(r.plugin.pageIds.owner(X), "precondition: N owns the id").toBe(N);
		expect(r.plugin.ambiguousIds.has(X), "precondition: the id is not listed").toBe(false);
		for (const p of [N, C]) expect(inlineInk.isDuplicateLocked(p), `precondition: ${p} is locked`).toBe(true);
		await drawLocked(r, C, "c1");

		r.setId(N, Y);
		r.plugin.checkPageIdentity(N);
		await r.drain();
		await r.drain();

		expect.soft(inlineInk.isDuplicateLocked(C), "the copy left alone on the id is still locked").toBe(false);
		expect.soft(r.plugin.pageIds.owner(X), "the copy left alone does not own the id").toBe(C);
		expect.soft(inkFileIds(r), "the stroke drawn on the copy while locked is in no ink file").toContain("c1");
		expect.soft(r.told(), "the lift is not told once").toBe(1);
	});
});

/**
 * The copy that drew nothing is saved under the old id only when this session's own move of the owner's files took the
 * id's inline file away and the copy's read then found none. Any other lift whose read finds no file writes nothing, and
 * a read that finds a file takes it: a move whose inline step found no file (only the Slides file moved); a file that
 * landed under the old id from outside before the copy's read; a later lift, not made by a move, whose read is under way
 * when the copy is locked and cleared again, with the file removed outside.
 */
describe("the copy that drew nothing, left on the old id: written only after a move here took the file", () => {
	const savesOf = (r: ReturnType<typeof rig>, id: string): number => r.saves.filter((s) => s === id).length;
	const leaves = async (r: ReturnType<typeof rig>): Promise<void> => {
		r.setId(N, Y);
		r.plugin.checkPageIdentity(N);
		await r.drain();
		await r.drain();
	};
	const DECK = `.handwriting/${X}.slides.json`;

	it("the old id's ink file gone before the edit, its Slides file there: the Slides file moves, nothing is written under the old id", async () => {
		const r = rig([N, C]);
		const deck = emptyPage(`${X}.slides`);
		deck.strokes = [stroke("d0", 30)];
		r.fake.files.set(DECK, serializePage(deck));
		await ownerAndLockedCopy(r, true, false);
		r.fake.files.delete(FILE);
		const real = r.store.keepAsideUnder.bind(r.store);
		const kinds: string[] = [];
		vi.spyOn(r.store, "keepAsideUnder").mockImplementation(async (from, to, own, named) => {
			const out = await real(from, to, own, named);
			kinds.push(`${from}:${out.kind}`);
			return out;
		});

		await leaves(r);

		expect(kinds, "precondition: the ink file's step found nothing and the Slides file's step moved").toEqual([`${X}:absent`, `${X}.slides:moved`]);
		expect.soft(inlineInk.isDuplicateLocked(C), "the copy is still locked").toBe(false);
		expect.soft(r.onDisk(), "a file under the old id was written though the move took no ink file").toBeNull();
		expect.soft(savesOf(r, X), "the copy saved under the old id").toBe(0);
	});

	it("a file under the old id landed from outside before the copy's read: the copy shows it and writes nothing", async () => {
		const r = rig([N, C]);
		await ownerAndLockedCopy(r, true, false);
		const landed = emptyPage(X);
		landed.surface = "inline";
		landed.strokes = [stroke("p0", 5), stroke("z9", 90)];
		const real = r.store.load.bind(r.store);
		let put = 0;
		vi.spyOn(r.store, "load").mockImplementation(async (id, options) => {
			if (id === X && put === 0 && !r.fake.files.has(FILE)) {
				put++;
				r.fake.files.set(FILE, serializePage(landed));
			}
			return real(id, options);
		});

		await leaves(r);

		expect(put, "precondition: the file did not land before the copy's read").toBe(1);
		expect.soft(editedFileIds(r), "precondition: the owner's ink went with it").toEqual(["p0"]);
		expect.soft(inlineInk.isDuplicateLocked(C), "the copy is still locked").toBe(false);
		expect.soft(ids(inlineInk.strokes(C)), "the copy does not show the landed file").toEqual(["p0", "z9"]);
		expect.soft(r.onDisk(), "the landed file changed").toEqual(["p0", "z9"]);
		expect.soft(savesOf(r, X), "the copy wrote under the old id though its read found a file").toBe(0);
	});

	it("after the copy's page is saved, a later lift reading, the copy locked and cleared again, the file removed outside: nothing more is written", async () => {
		const r = rig([N, C]);
		await ownerAndLockedCopy(r, true, false);
		await leaves(r);
		expect(savesOf(r, X), "precondition: the copy's page was not saved once").toBe(1);
		const real = r.store.load.bind(r.store);
		let release: () => void = () => undefined;
		let reads = 0;
		vi.spyOn(r.store, "load").mockImplementation(async (id, options) => {
			if (id === X && reads++ === 0) await new Promise<void>((go) => (release = go));
			return real(id, options);
		});
		inlineInk.markDuplicateLocked(C, D);
		r.fake.files.delete(FILE);
		inlineInk.clearDuplicateLock(C);
		await r.drain();
		expect(reads, "precondition: the later lift's read did not start").toBe(1);
		inlineInk.markDuplicateLocked(C, D);
		inlineInk.clearDuplicateLock(C);
		release();
		await r.drain();

		expect.soft(reads, "precondition: the waiting lift did not read again").toBe(2);
		expect.soft(inlineInk.isDuplicateLocked(C), "the copy is still locked").toBe(false);
		expect.soft(r.onDisk(), "a file under the old id was written at a later lift no move of this session made").toBeNull();
		expect.soft(savesOf(r, X), "the copy saved again under the old id").toBe(1);
	});
});
