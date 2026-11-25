/**
 * AN ID MOVE WHILE THE OLD ID HAS A FILE IN BOTH WELL-KNOWN FOLDERS.
 *
 * keepAsideUnder moves the ink of a note whose page id changed from the old
 * id's file to the new id's. When the old id has a file in both `.handwriting`
 * and `handwriting`, the store picks one of them (chooseBetweenFolders) and
 * the move takes that one. These cells record what happens today to the
 * other one, and to its strokes: on disk, in the page the note now opens, and
 * in what the fix ink de-sync command lists, right after the move and after a
 * reload by a new store over the same files. They state what the code does,
 * not what it should do.
 *
 * "In view" here means: a stroke of the page the store loads for the new id,
 * or a stroke of a file the fork scan lists in any ink folder, under any id.
 * Every cell logs the vault listing after the move and after the reload.
 *
 * Real pieces: PageStore (load, save, id move) and the fork scan the command
 * runs over every ink folder, through the host the plugin builds. Synthetic:
 * FakeAdapter, with a list() and the rename onto an existing file refused as
 * the desktop adapter refuses it. Not device acceptance, not real sync.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { type ForkRecord, forkHostFor, scanForForks } from "./ForkResolution";
import { type PageData, READ_SCHEMA_VERSION, emptyPage, parsePage, serializePage } from "../model/PageData";
import type { KeptAside } from "./PageStoreSchedule";

const g = globalThis as { window?: unknown };
g.window ??= globalThis;

const OLD = "own-page-id";
const NEW = "edited-page-id";
const DOT = ".handwriting";
const PLAIN = "handwriting";
const at = (folder: string, id: string): string => `${folder}/${id}.json`;

function pageOf(id: string, ...strokeIds: string[]): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = strokeIds.map((sid, i) => ({
		id: sid,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: i * 20, y: 0, pressure: 0.5, t: 0 },
			{ x: i * 20 + 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: i * 20, y: 0, width: 10, height: 0 },
		createdAt: i,
	})) as PageData["strokes"];
	return p;
}

/** A store configured for `.handwriting`, both well-known folders present, `files` on disk. */
function setup(files: Record<string, string>): { store: PageStore; fake: FakeAdapter } {
	const fake = new FakeAdapter();
	fake.dirs.add(DOT);
	fake.dirs.add(PLAIN);
	fake.refuseRenameOntoFile = true;
	// The fork scan lists each folder; the plain fake has no list().
	(fake as unknown as { list: (folder: string) => Promise<{ files: string[]; folders: string[] }> }).list = async (folder) => ({
		files: [...fake.files.keys()].filter((k) => k.startsWith(`${folder}/`) && !k.slice(folder.length + 1).includes("/")),
		folders: [],
	});
	for (const [path, text] of Object.entries(files)) fake.externalWrite(path, text);
	return { store: storeOver(fake), fake };
}

const storeOver = (fake: FakeAdapter): PageStore => new PageStore({ vault: { adapter: fake } } as never, DOT, () => 5000);

/** The old id's files that are live now, in either well-known folder. */
const liveOld = (fake: FakeAdapter): string[] => [DOT, PLAIN].map((f) => at(f, OLD)).filter((p) => fake.files.has(p));

/** The kept copies beside the new page in the dot folder whose bytes are exactly `text`. */
const keptBeside = (fake: FakeAdapter, text: string): string[] =>
	[...fake.files.keys()].filter((p) => p.startsWith(`${DOT}/${NEW}.conflict-`) && fake.files.get(p) === text).sort();

/** Stroke ids in a file's bytes, sorted; [] when the bytes are not a page. */
function strokesIn(text: string | undefined): string[] {
	if (text === undefined) return [];
	try {
		const raw = JSON.parse(text) as { strokes?: { id: string }[] };
		return (raw.strokes ?? []).map((s) => s.id).sort();
	} catch {
		return [];
	}
}

/** Every file in the vault with the id it declares and its strokes, sorted by path; logged with `label`. */
function listing(fake: FakeAdapter, label: string): string[] {
	const rows = [...fake.files.keys()].sort().map((p) => {
		const text = fake.files.get(p);
		let declared = "-";
		try {
			declared = String((JSON.parse(text ?? "") as { pageId?: unknown }).pageId ?? "-");
		} catch {
			declared = "(not json)";
		}
		return `${p} | pageId ${declared} | strokes ${strokesIn(text).join(",") || "-"}`;
	});
	console.log(`[listing] ${label}\n  ${rows.join("\n  ")}`);
	return rows;
}

/** What the fix ink de-sync command lists, scanned over every ink folder as the command scans it. */
async function listed(fake: FakeAdapter, store: PageStore): Promise<ForkRecord[]> {
	const host = forkHostFor({ adapter: fake as never, store });
	const out: ForkRecord[] = [];
	for (const folder of store.inkFolders()) out.push(...(await scanForForks(host, folder)));
	return out;
}

/** The new id's page as the store loads it, the strokes of every listed file, and the loser's strokes in neither. */
async function view(fake: FakeAdapter, store: PageStore, loserStrokes: string[]): Promise<{
	shown: string[];
	listedIds: string[];
	listedStrokes: string[];
	outOfView: string[];
}> {
	const loaded = await store.load(NEW);
	const shown = (loaded?.data.strokes ?? []).map((s) => s.id).sort();
	const records = await listed(fake, store);
	const listedStrokes = [
		...new Set(records.flatMap((r) => [...strokesIn(fake.files.get(r.incomingPath)), ...strokesIn(fake.files.get(r.outgoingPath))])),
	].sort();
	const outOfView = loserStrokes.filter((s) => !shown.includes(s) && !listedStrokes.includes(s)).sort();
	return { shown, listedIds: records.map((r) => r.pageId).sort(), listedStrokes, outOfView };
}

describe("an id move while the old id has a file in both well-known folders", () => {
	it("identical copies: the move takes the configured folder's copy and the plain folder's copy stays a live old-id file that nothing lists, holding no stroke out of view", async () => {
		const text = serializePage(pageOf(OLD, "s1"));
		const { store, fake } = setup({ [at(DOT, OLD)]: text, [at(PLAIN, OLD)]: text });

		const kept = await store.keepAsideUnder(OLD, NEW);
		listing(fake, "identical copies, after the move");

		expect(kept.kind, "assert 1: the move moved").toBe("moved");
		expect([fake.files.has(at(DOT, OLD)), fake.files.get(at(PLAIN, OLD))], "assert 2: the configured folder's copy moved, the plain one stays as it was").toEqual([false, text]);
		const now = await view(fake, store, ["s1"]);
		expect(now, "assert 3: after the move").toEqual({ shown: ["s1"], listedIds: [], listedStrokes: [], outOfView: [] });

		listing(fake, "identical copies, after the reload");
		const later = await view(fake, storeOver(fake), ["s1"]);
		expect([later, fake.files.get(at(PLAIN, OLD))], "assert 4: after a reload, the same and the old-id file still live").toEqual([now, text]);
	});

	it("one copy holds every stroke of the other: the move takes the fuller copy and the other stays a live old-id file that nothing lists, holding no stroke out of view", async () => {
		const fewer = serializePage(pageOf(OLD, "s1"));
		const fuller = serializePage(pageOf(OLD, "s1", "s2"));
		const { store, fake } = setup({ [at(DOT, OLD)]: fewer, [at(PLAIN, OLD)]: fuller });

		const kept = await store.keepAsideUnder(OLD, NEW);
		listing(fake, "fuller copy in the plain folder, after the move");

		expect(kept.kind, "assert 1: the move moved").toBe("moved");
		expect([fake.files.has(at(PLAIN, OLD)), fake.files.get(at(DOT, OLD))], "assert 2: the fuller copy moved, the other stays as it was").toEqual([false, fewer]);
		const now = await view(fake, store, ["s1"]);
		expect(now, "assert 3: after the move").toEqual({ shown: ["s1", "s2"], listedIds: [], listedStrokes: [], outOfView: [] });

		await store.saveNow(NEW, pageOf(NEW, "s1", "s2", "s3"));
		listing(fake, "fuller copy in the plain folder, after a save under the new id");
		expect(fake.files.get(at(DOT, OLD)), "assert 4: a save under the new id leaves the old-id file as it was").toBe(fewer);

		listing(fake, "fuller copy in the plain folder, after the reload");
		const later = await view(fake, storeOver(fake), ["s1"]);
		expect([later, fake.files.get(at(DOT, OLD))], "assert 5: after a reload").toEqual([
			{ shown: ["s1", "s2", "s3"], listedIds: [], listedStrokes: [], outOfView: [] },
			fewer,
		]);
	});

	it("neither copy holds the other: the move takes the plain folder's copy and the dot folder's own stroke stays only in a live old-id file that nothing lists, out of view after the move and after a reload", async () => {
		const mine = serializePage(pageOf(OLD, "s1", "mine"));
		const theirs = serializePage(pageOf(OLD, "s1", "theirs"));
		const { store, fake } = setup({ [at(DOT, OLD)]: mine, [at(PLAIN, OLD)]: theirs });

		const kept = await store.keepAsideUnder(OLD, NEW);
		listing(fake, "a fork across the folders, after the move");

		expect(kept.kind, "assert 1: the move moved").toBe("moved");
		expect([fake.files.has(at(PLAIN, OLD)), fake.files.get(at(DOT, OLD))], "assert 2: the plain folder's copy moved, the dot folder's stays as it was").toEqual([false, mine]);
		const now = await view(fake, store, ["mine", "s1"]);
		expect(now, "assert 3: after the move").toEqual({ shown: ["s1", "theirs"], listedIds: [], listedStrokes: [], outOfView: ["mine"] });

		await store.saveNow(NEW, pageOf(NEW, "s1", "theirs", "s3"));
		listing(fake, "a fork across the folders, after a save under the new id");
		expect(fake.files.get(at(DOT, OLD)), "assert 4: a save under the new id leaves the old-id file as it was").toBe(mine);

		listing(fake, "a fork across the folders, after the reload");
		const later = await view(fake, storeOver(fake), ["mine", "s1"]);
		expect([later, fake.files.get(at(DOT, OLD))], "assert 5: after a reload").toEqual([
			{ shown: ["s1", "s3", "theirs"], listedIds: [], listedStrokes: [], outOfView: ["mine"] },
			mine,
		]);
	});

	it("neither copy holds the other and the note opened under the old id first: the pair the open kept is listed under the old id, and the dot folder's copy stays a live old-id file", async () => {
		const mine = serializePage(pageOf(OLD, "s1", "mine"));
		const theirs = serializePage(pageOf(OLD, "s1", "theirs"));
		const { store, fake } = setup({ [at(DOT, OLD)]: mine, [at(PLAIN, OLD)]: theirs });
		const opened = await store.load(OLD);
		expect((opened?.data.strokes ?? []).map((s) => s.id).sort(), "premise: the open serves the plain folder's copy").toEqual(["s1", "theirs"]);
		listing(fake, "a fork across the folders, opened under the old id, before the move");

		const kept = await store.keepAsideUnder(OLD, NEW);
		listing(fake, "a fork across the folders, opened under the old id, after the move");

		expect(kept.kind, "assert 1: the move moved").toBe("moved");
		expect(fake.files.get(at(DOT, OLD)), "assert 2: the dot folder's copy stays as it was").toBe(mine);
		const now = await view(fake, store, ["mine", "s1"]);
		expect(now, "assert 3: after the move").toEqual({ shown: ["s1", "theirs"], listedIds: [OLD], listedStrokes: ["mine", "s1", "theirs"], outOfView: [] });

		listing(fake, "a fork across the folders, opened under the old id, after the reload");
		const later = await view(fake, storeOver(fake), ["mine", "s1"]);
		expect([later, fake.files.get(at(DOT, OLD))], "assert 4: after a reload").toEqual([now, mine]);
	});

	it("one copy holds every stroke of the other and a save under the old id landed before the move: the other is kept as a copy listed under the old id against an old-id live file the move took", async () => {
		const fewer = serializePage(pageOf(OLD, "s1"));
		const fuller = serializePage(pageOf(OLD, "s1", "s2"));
		const { store, fake } = setup({ [at(DOT, OLD)]: fewer, [at(PLAIN, OLD)]: fuller });
		await store.load(OLD);
		await store.saveNow(OLD, pageOf(OLD, "s1", "s2", "s3"));
		listing(fake, "fuller copy in the plain folder, a save under the old id, before the move");
		expect(fake.files.has(at(DOT, OLD)), "premise: the save moved the other copy out of the dot folder").toBe(false);

		const kept = await store.keepAsideUnder(OLD, NEW);
		listing(fake, "fuller copy in the plain folder, a save under the old id, after the move");

		expect(kept.kind, "assert 1: the move moved").toBe("moved");
		const now = await view(fake, store, ["s1"]);
		expect(now, "assert 2: after the move").toEqual({ shown: ["s1", "s2", "s3"], listedIds: [OLD], listedStrokes: ["s1"], outOfView: [] });
		const sides = (await listed(fake, store)).map((r) => [r.incomingPath.replace(/conflict-\d+/, "conflict-<mtime>"), r.outgoingPath, fake.files.has(r.outgoingPath)]);
		expect(sides, "assert 3: the copy is listed against the old id's live file, which the move took").toEqual([
			[`${PLAIN}/${OLD}.conflict-<mtime>.json`, at(PLAIN, OLD), false],
		]);

		listing(fake, "fuller copy in the plain folder, a save under the old id, after the reload");
		const later = await view(fake, storeOver(fake), ["s1"]);
		expect(later, "assert 4: after a reload").toEqual(now);
	});
});

/**
 * A SECOND ROUND OF THE SAME MOVE, GIVEN THE FIRST ROUND'S STAMP.
 *
 * A move that stops part done (a save queued under the old id while it ran) is
 * tried again with the stamp of what the first round wrote as the new id's live
 * file: moveIdFiles passes state.wrote as `own`. When the old id had a file in
 * both well-known folders, the first round took one and left the other under
 * the old id, so the second round finds that other one; a file that lands
 * under the old id between the rounds is found the same way. The second round
 * takes the file it finds as the page, and removes the first round's file only
 * when every stroke id in it is in the text taking its place; else that file
 * stays as a kept copy beside the new page, listed under the new id. These
 * cells assert that every stroke on disk before the first round is in some
 * file after the second: red means a round removed the only bytes of a stroke.
 * Each cell logs the listing, every stroke id on disk and every path the store
 * removed, before and after each round, and a [facts] line with the answers.
 */
function onDisk(fake: FakeAdapter): string[] {
	return [...new Set([...fake.files.values()].flatMap((t) => strokesIn(t)))].sort();
}

/** Every path the store removes from here on, with the strokes it held then, pushed onto `into`. */
function watchRemoves(fake: FakeAdapter, into: string[]): void {
	const remove = fake.remove.bind(fake);
	fake.remove = async (path: string): Promise<void> => {
		into.push(`${path} | strokes ${strokesIn(fake.files.get(path)).join(",") || "-"}`);
		return remove(path);
	};
}

function snap(fake: FakeAdapter, label: string): string[] {
	listing(fake, label);
	const strokes = onDisk(fake);
	console.log(`[on disk] ${label}: ${strokes.join(",") || "-"}`);
	return strokes;
}

const stampOf = (k: KeptAside): string | undefined => (k.kind === "moved" ? k.stamp : undefined);
const brief = (k: KeptAside): Record<string, unknown> => (k.kind === "moved" ? { kind: k.kind, to: k.to, stamp: k.stamp !== undefined } : { kind: k.kind });
const holding = (fake: FakeAdapter, strokeId: string): string[] => [...fake.files.keys()].filter((p) => strokesIn(fake.files.get(p)).includes(strokeId)).sort();
const exactly = (fake: FakeAdapter, text: string): string[] => [...fake.files.keys()].filter((p) => fake.files.get(p) === text).sort();

/** The strokes of the page the note opens under the new id, loaded by a new store over the same files. */
async function opensNew(fake: FakeAdapter): Promise<string[]> {
	const loaded = await storeOver(fake).load(NEW);
	return (loaded?.data.strokes ?? []).map((s) => s.id).sort();
}

/**
 * `page`'s text with one more stroke, `id`, whose point list is not empty and holds no point this build reads. A read
 * keeps every other stroke and marks the file damaged, for that alone: not ink under a key this build does not know,
 * not a newer build.
 */
function withUnreadableStroke(page: PageData, id: string): string {
	const raw = JSON.parse(serializePage(page)) as { strokes: unknown[] };
	raw.strokes.push({ id, tool: "pen", color: "#4b7bec", width: 2.2, points: [{ x: "?", y: "?" }] });
	return JSON.stringify(raw);
}

/** How the store's read marks `text`: damaged, only ink under a key it does not know, a newer build, the strokes it returns. */
function readMarks(text: string | undefined): unknown[] {
	const read = parsePage(text ?? "", NEW);
	return [read.damaged, read.onlyUnknownPointKeys, read.futureVersion, read.data.strokes.map((s) => s.id).sort()];
}

describe("a second round of the same id move, given the first round's stamp, while the old id had a file in both well-known folders", () => {
	it("a. fuller copy in the plain folder, fewer in the dot folder, no load: every stroke on disk before round 1 is in some file after round 2", async () => {
		const fewer = serializePage(pageOf(OLD, "s1"));
		const fuller = serializePage(pageOf(OLD, "s1", "s2"));
		const { store, fake } = setup({ [at(DOT, OLD)]: fewer, [at(PLAIN, OLD)]: fuller });
		const removed: string[] = [];
		watchRemoves(fake, removed);
		const before = snap(fake, "a, before round 1");

		const r1 = await store.keepAsideUnder(OLD, NEW);
		const mid = snap(fake, "a, after round 1");
		const removed1 = removed.length;
		expect(r1.kind, "premise 1: round 1 moved").toBe("moved");
		expect(stampOf(r1), "premise 2: round 1 gives a stamp").toBeTypeOf("string");
		expect(mid, "premise 3: s2 on disk after round 1").toContain("s2");
		expect(fake.files.get(at(DOT, OLD)), "premise 4: the dot folder's copy is still under the old id").toBe(fewer);

		const r2 = await store.keepAsideUnder(OLD, NEW, stampOf(r1));
		const after = snap(fake, "a, after round 2");
		const facts = {
			round1: brief(r1),
			round2: brief(r2),
			removedInRound1: removed.slice(0, removed1),
			removedInRound2: removed.slice(removed1),
			s2InFiles: holding(fake, "s2"),
			lost: before.filter((s) => !after.includes(s)),
			opensAfterReload: await opensNew(fake),
		};
		snap(fake, "a, after the reload");
		console.log(`[facts] a ${JSON.stringify(facts)}`);
		expect(facts.lost, "contract: every stroke on disk before round 1 is in some file after round 2").toEqual([]);
	});

	it("b. neither copy holds the other, no load: every stroke on disk before round 1 is in some file after round 2", async () => {
		const mine = serializePage(pageOf(OLD, "s1", "mine"));
		const theirs = serializePage(pageOf(OLD, "s1", "theirs"));
		const { store, fake } = setup({ [at(DOT, OLD)]: mine, [at(PLAIN, OLD)]: theirs });
		const removed: string[] = [];
		watchRemoves(fake, removed);
		const before = snap(fake, "b, before round 1");

		const r1 = await store.keepAsideUnder(OLD, NEW);
		const mid = snap(fake, "b, after round 1");
		const removed1 = removed.length;
		expect(r1.kind, "premise 1: round 1 moved").toBe("moved");
		expect(stampOf(r1), "premise 2: round 1 gives a stamp").toBeTypeOf("string");
		expect(mid, "premise 3: theirs on disk after round 1").toContain("theirs");
		expect(fake.files.get(at(DOT, OLD)), "premise 4: the dot folder's copy is still under the old id").toBe(mine);

		const r2 = await store.keepAsideUnder(OLD, NEW, stampOf(r1));
		const after = snap(fake, "b, after round 2");
		const facts = {
			round1: brief(r1),
			round2: brief(r2),
			removedInRound1: removed.slice(0, removed1),
			removedInRound2: removed.slice(removed1),
			theirsInFiles: holding(fake, "theirs"),
			mineInFiles: holding(fake, "mine"),
			lost: before.filter((s) => !after.includes(s)),
			opensAfterReload: await opensNew(fake),
		};
		snap(fake, "b, after the reload");
		console.log(`[facts] b ${JSON.stringify(facts)}`);
		expect(facts.lost, "contract: every stroke on disk before round 1 is in some file after round 2").toEqual([]);
	});

	it("c. neither copy holds the other, the note opened under the old id first: every stroke on disk before round 1 is in some file after round 2", async () => {
		const mine = serializePage(pageOf(OLD, "s1", "mine"));
		const theirs = serializePage(pageOf(OLD, "s1", "theirs"));
		const { store, fake } = setup({ [at(DOT, OLD)]: mine, [at(PLAIN, OLD)]: theirs });
		const removed: string[] = [];
		watchRemoves(fake, removed);
		const opened = await store.load(OLD);
		const before = snap(fake, "c, opened under the old id, before round 1");
		expect((opened?.data.strokes ?? []).map((s) => s.id).sort(), "premise 0: the open serves the plain folder's copy").toEqual(["s1", "theirs"]);
		const removed0 = removed.length;

		const r1 = await store.keepAsideUnder(OLD, NEW);
		const mid = snap(fake, "c, after round 1");
		const removed1 = removed.length;
		expect(r1.kind, "premise 1: round 1 moved").toBe("moved");
		expect(stampOf(r1), "premise 2: round 1 gives a stamp").toBeTypeOf("string");
		expect(mid, "premise 3: theirs on disk after round 1").toContain("theirs");
		expect(fake.files.get(at(DOT, OLD)), "premise 4: the dot folder's copy is still under the old id").toBe(mine);

		const r2 = await store.keepAsideUnder(OLD, NEW, stampOf(r1));
		const after = snap(fake, "c, after round 2");
		const records = await listed(fake, store);
		const facts = {
			round1: brief(r1),
			round2: brief(r2),
			removedAtOpen: removed.slice(0, removed0),
			removedInRound1: removed.slice(removed0, removed1),
			removedInRound2: removed.slice(removed1),
			theirsInFiles: holding(fake, "theirs"),
			mineInFiles: holding(fake, "mine"),
			listedAfterRound2: records.map((r) => `${r.pageId} | ${r.incomingPath} | ${r.outgoingPath}`).sort(),
			lost: before.filter((s) => !after.includes(s)),
			opensAfterReload: await opensNew(fake),
		};
		snap(fake, "c, after the reload");
		console.log(`[facts] c ${JSON.stringify(facts)}`);
		expect(facts.lost, "contract: every stroke on disk before round 1 is in some file after round 2").toEqual([]);
	});

	it("d. fuller copy in the plain folder, fewer in the dot folder, opened under the old id, a save under the old id between the rounds: every stroke on disk is in some file after round 2", async () => {
		const fewer = serializePage(pageOf(OLD, "s1"));
		const fuller = serializePage(pageOf(OLD, "s1", "s2"));
		const { store, fake } = setup({ [at(DOT, OLD)]: fewer, [at(PLAIN, OLD)]: fuller });
		const removed: string[] = [];
		watchRemoves(fake, removed);
		await store.load(OLD);
		const before = snap(fake, "d, opened under the old id, before round 1");
		const removed0 = removed.length;

		const r1 = await store.keepAsideUnder(OLD, NEW);
		const mid = snap(fake, "d, after round 1");
		const removed1 = removed.length;
		expect(r1.kind, "premise 1: round 1 moved").toBe("moved");
		expect(stampOf(r1), "premise 2: round 1 gives a stamp").toBeTypeOf("string");
		expect(mid, "premise 3: s2 on disk after round 1").toContain("s2");

		await store.saveNow(OLD, pageOf(OLD, "s1", "s2", "s3"));
		const saved = snap(fake, "d, after the save under the old id");
		const removedS = removed.length;
		const saveIn = holding(fake, "s3");
		const loserExactAfterSave = exactly(fake, fewer);

		const r2 = await store.keepAsideUnder(OLD, NEW, stampOf(r1));
		const after = snap(fake, "d, after round 2");
		const ever = [...new Set([...before, ...saved])];
		const facts = {
			round1: brief(r1),
			round2: brief(r2),
			removedAtOpen: removed.slice(0, removed0),
			removedInRound1: removed.slice(removed0, removed1),
			removedAtSave: removed.slice(removed1, removedS),
			removedInRound2: removed.slice(removedS),
			saveLandedIn: saveIn,
			loserExactAfterSave,
			loserExactAfterRound2: exactly(fake, fewer),
			s3InFiles: holding(fake, "s3"),
			s2InFiles: holding(fake, "s2"),
			lost: ever.filter((s) => !after.includes(s)).sort(),
			opensAfterReload: await opensNew(fake),
		};
		snap(fake, "d, after the reload");
		console.log(`[facts] d ${JSON.stringify(facts)}`);
		expect(facts.lost, "contract: every stroke on disk before round 2 is in some file after round 2").toEqual([]);
	});

	it("a2. fuller copy in the plain folder, fewer in the dot folder, opened under the old id, no save: every stroke on disk before round 1 is in some file after round 2", async () => {
		const fewer = serializePage(pageOf(OLD, "s1"));
		const fuller = serializePage(pageOf(OLD, "s1", "s2"));
		const { store, fake } = setup({ [at(DOT, OLD)]: fewer, [at(PLAIN, OLD)]: fuller });
		const removed: string[] = [];
		watchRemoves(fake, removed);
		const opened = await store.load(OLD);
		const before = snap(fake, "a2, opened under the old id, before round 1");
		expect((opened?.data.strokes ?? []).map((s) => s.id).sort(), "premise 0: the open serves the fuller copy").toEqual(["s1", "s2"]);
		const removed0 = removed.length;

		const r1 = await store.keepAsideUnder(OLD, NEW);
		const mid = snap(fake, "a2, after round 1");
		const removed1 = removed.length;
		expect(r1.kind, "premise 1: round 1 moved").toBe("moved");
		expect(stampOf(r1), "premise 2: round 1 gives a stamp").toBeTypeOf("string");
		expect(mid, "premise 3: s2 on disk after round 1").toContain("s2");
		const dotAfterRound1 = fake.files.get(at(DOT, OLD)) === fewer;

		const r2 = await store.keepAsideUnder(OLD, NEW, stampOf(r1));
		const after = snap(fake, "a2, after round 2");
		const facts = {
			round1: brief(r1),
			round2: brief(r2),
			dotCopyStillUnderOldIdAfterRound1: dotAfterRound1,
			removedAtOpen: removed.slice(0, removed0),
			removedInRound1: removed.slice(removed0, removed1),
			removedInRound2: removed.slice(removed1),
			s2InFiles: holding(fake, "s2"),
			loserExactAfterRound2: exactly(fake, fewer),
			lost: before.filter((s) => !after.includes(s)),
			opensAfterReload: await opensNew(fake),
		};
		snap(fake, "a2, after the reload");
		console.log(`[facts] a2 ${JSON.stringify(facts)}`);
		expect(facts.lost, "contract: every stroke on disk before round 1 is in some file after round 2").toEqual([]);
	});

	it("e. one folder only, another device's late old-id file between the rounds, no load, no save: every stroke on disk is in some file after round 2, the late file takes the page and round 1's file stays a kept copy listed under the new id", async () => {
		const first = serializePage(pageOf(OLD, "s1", "s2"));
		const late = serializePage(pageOf(OLD, "s1", "other"));
		const { store, fake } = setup({ [at(PLAIN, OLD)]: first });
		const removed: string[] = [];
		watchRemoves(fake, removed);
		const before = snap(fake, "e, before round 1");
		expect(fake.files.has(at(DOT, OLD)), "premise 0: no old-id file in the dot folder").toBe(false);

		const r1 = await store.keepAsideUnder(OLD, NEW);
		const mid = snap(fake, "e, after round 1");
		const removed1 = removed.length;
		expect(r1.kind, "premise 1: round 1 moved").toBe("moved");
		expect(stampOf(r1), "premise 2: round 1 gives a stamp").toBeTypeOf("string");
		expect(mid, "premise 3: s2 on disk after round 1").toContain("s2");
		expect(fake.files.has(at(PLAIN, OLD)), "premise 4: round 1 left no old-id file").toBe(false);

		fake.externalWrite(at(PLAIN, OLD), late);
		const landed = snap(fake, "e, after the late old-id file landed");

		const r2 = await store.keepAsideUnder(OLD, NEW, stampOf(r1));
		const after = snap(fake, "e, after round 2");
		const ever = [...new Set([...before, ...landed])];
		const facts = {
			round1: brief(r1),
			round2: brief(r2),
			removedInRound1: removed.slice(0, removed1),
			removedInRound2: removed.slice(removed1),
			s2InFiles: holding(fake, "s2"),
			otherInFiles: holding(fake, "other"),
			lost: ever.filter((s) => !after.includes(s)).sort(),
			opensAfterReload: await opensNew(fake),
		};
		snap(fake, "e, after the reload");
		console.log(`[facts] e ${JSON.stringify(facts)}`);
		expect(facts.lost, "contract: every stroke on disk before round 2 is in some file after round 2").toEqual([]);
		expect(facts.opensAfterReload, "the page: the late old-id file takes the page").toEqual(["other", "s1"]);
		const s2Listed = (await listed(fake, store)).filter((r) => strokesIn(fake.files.get(r.incomingPath)).includes("s2")).map((r) => r.pageId);
		expect([facts.s2InFiles.every((p) => p.startsWith(`${DOT}/${NEW}.conflict-`)), s2Listed], "the kept copy: s2 sits only in a copy beside the new page, listed under the new id").toEqual([true, [NEW]]);
	});

	it("f. one folder only, the old file from a newer build (a newer schema and ink under a key this build does not read), a late old-id file between the rounds: round 2 keeps round 1's file as a copy beside the new page, bytes unchanged", async () => {
		const newer = JSON.stringify({
			...(JSON.parse(serializePage(pageOf(OLD, "s1"))) as Record<string, unknown>),
			schemaVersion: READ_SCHEMA_VERSION + 1,
			laterInk: [{ id: "s9", points: [[0, 0, 0.5]] }],
		});
		const late = serializePage(pageOf(OLD, "s1"));
		const { store, fake } = setup({ [at(PLAIN, OLD)]: newer });
		const removed: string[] = [];
		watchRemoves(fake, removed);
		snap(fake, "f, before round 1");

		const r1 = await store.keepAsideUnder(OLD, NEW);
		snap(fake, "f, after round 1");
		const removed1 = removed.length;
		expect(r1.kind, "premise 1: round 1 moved").toBe("moved");
		expect(stampOf(r1), "premise 2: round 1 gives a stamp").toBeTypeOf("string");
		const round1File = fake.files.get(at(DOT, NEW));
		expect(round1File?.includes('"laterInk"'), "premise 3: round 1's file is the newer build's text, under the new id").toBe(true);

		fake.externalWrite(at(PLAIN, OLD), late);
		snap(fake, "f, after the late old-id file landed");

		const r2 = await store.keepAsideUnder(OLD, NEW, stampOf(r1));
		snap(fake, "f, after round 2");
		const facts = {
			round1: brief(r1),
			round2: brief(r2),
			removedInRound1: removed.slice(0, removed1),
			removedInRound2: removed.slice(removed1),
			round1FileExactAfterRound2: exactly(fake, round1File ?? ""),
			opensAfterReload: await opensNew(fake),
		};
		console.log(`[facts] f ${JSON.stringify(facts)}`);
		expect(keptBeside(fake, round1File ?? ""), "contract: round 1's file is one copy beside the new page, bytes unchanged").toHaveLength(1);
	});

	it("h. one folder only, round 1's file lossy (one stroke whose points this build cannot read), a late old-id file between the rounds holding every stroke a read of round 1's file returns: round 2 keeps round 1's file as a copy beside the new page, bytes unchanged, listed under the new id", async () => {
		const lossy = withUnreadableStroke(pageOf(OLD, "s1"), "s9");
		const late = serializePage(pageOf(OLD, "s1"));
		expect(readMarks(lossy), "premise 0: a read of the old file returns s1 and marks it damaged, nothing else").toEqual([true, undefined, undefined, ["s1"]]);
		const { store, fake } = setup({ [at(PLAIN, OLD)]: lossy });
		const removed: string[] = [];
		watchRemoves(fake, removed);
		const before = snap(fake, "h, before round 1");

		const r1 = await store.keepAsideUnder(OLD, NEW);
		snap(fake, "h, after round 1");
		const removed1 = removed.length;
		expect(r1.kind, "premise 1: round 1 moved").toBe("moved");
		expect(stampOf(r1), "premise 2: round 1 gives a stamp").toBeTypeOf("string");
		const round1File = fake.files.get(at(DOT, NEW));
		expect([strokesIn(round1File), readMarks(round1File)], "premise 3: round 1's file is the lossy text under the new id, read the same way").toEqual([
			["s1", "s9"],
			[true, undefined, undefined, ["s1"]],
		]);

		fake.externalWrite(at(PLAIN, OLD), late);
		const landed = snap(fake, "h, after the late old-id file landed");

		const r2 = await store.keepAsideUnder(OLD, NEW, stampOf(r1));
		const after = snap(fake, "h, after round 2");
		const copies = keptBeside(fake, round1File ?? "");
		const listedAs = (await listed(fake, store)).filter((r) => copies.includes(r.incomingPath)).map((r) => r.pageId);
		const facts = {
			round1: brief(r1),
			round2: brief(r2),
			removedInRound1: removed.slice(0, removed1),
			removedInRound2: removed.slice(removed1),
			round1FileExactAfterRound2: exactly(fake, round1File ?? ""),
			s9InFiles: holding(fake, "s9"),
			lost: [...new Set([...before, ...landed])].filter((s) => !after.includes(s)).sort(),
			opensAfterReload: await opensNew(fake),
		};
		snap(fake, "h, after the reload");
		console.log(`[facts] h ${JSON.stringify(facts)}`);
		expect([copies.length, listedAs], "contract: round 1's file is one copy beside the new page, bytes unchanged, listed under the new id").toEqual([1, [NEW]]);
	});

	it("h2. one folder only, a late old-id file between the rounds lossy (one stroke whose points this build cannot read) whose read returns every stroke of round 1's file: round 2 keeps round 1's file as a copy beside the new page, bytes unchanged, listed under the new id", async () => {
		const first = serializePage(pageOf(OLD, "s1"));
		const lossy = withUnreadableStroke(pageOf(OLD, "s1"), "s9");
		expect(readMarks(lossy), "premise 0: a read of the late file returns s1 and marks it damaged, nothing else").toEqual([true, undefined, undefined, ["s1"]]);
		const { store, fake } = setup({ [at(PLAIN, OLD)]: first });
		const removed: string[] = [];
		watchRemoves(fake, removed);
		const before = snap(fake, "h2, before round 1");

		const r1 = await store.keepAsideUnder(OLD, NEW);
		snap(fake, "h2, after round 1");
		const removed1 = removed.length;
		expect(r1.kind, "premise 1: round 1 moved").toBe("moved");
		expect(stampOf(r1), "premise 2: round 1 gives a stamp").toBeTypeOf("string");
		const round1File = fake.files.get(at(DOT, NEW));
		expect(readMarks(round1File), "premise 3: round 1's file reads whole, s1, under the new id").toEqual([undefined, undefined, undefined, ["s1"]]);

		fake.externalWrite(at(PLAIN, OLD), lossy);
		const landed = snap(fake, "h2, after the late old-id file landed");

		const r2 = await store.keepAsideUnder(OLD, NEW, stampOf(r1));
		const after = snap(fake, "h2, after round 2");
		const copies = keptBeside(fake, round1File ?? "");
		const listedAs = (await listed(fake, store)).filter((r) => copies.includes(r.incomingPath)).map((r) => r.pageId);
		const newPage = fake.files.get(at(DOT, NEW));
		const facts = {
			round1: brief(r1),
			round2: brief(r2),
			removedInRound1: removed.slice(0, removed1),
			removedInRound2: removed.slice(removed1),
			round1FileExactAfterRound2: exactly(fake, round1File ?? ""),
			newPage: strokesIn(newPage),
			newPageRead: readMarks(newPage),
			s9InFiles: holding(fake, "s9"),
			lost: [...new Set([...before, ...landed])].filter((s) => !after.includes(s)).sort(),
			opensAfterReload: await opensNew(fake),
		};
		snap(fake, "h2, after the reload");
		console.log(`[facts] h2 ${JSON.stringify(facts)}`);
		expect([copies.length, listedAs], "contract: round 1's file is one copy beside the new page, bytes unchanged, listed under the new id").toEqual([1, [NEW]]);
	});

	it("an erase under the old id between the rounds stays erased: after round 2 and a reload the note opens without the erased stroke", async () => {
		const first = serializePage(pageOf(OLD, "s1", "s2"));
		const { store, fake } = setup({ [at(PLAIN, OLD)]: first });
		const removed: string[] = [];
		watchRemoves(fake, removed);
		await store.load(OLD);
		snap(fake, "erase, opened under the old id, before round 1");

		const r1 = await store.keepAsideUnder(OLD, NEW);
		snap(fake, "erase, after round 1");
		const removed1 = removed.length;
		expect(r1.kind, "premise 1: round 1 moved").toBe("moved");
		expect(stampOf(r1), "premise 2: round 1 gives a stamp").toBeTypeOf("string");

		await store.saveNow(OLD, pageOf(OLD, "s1"));
		snap(fake, "erase, after a save under the old id without s2");
		const removedS = removed.length;
		const erasedUnderOld = liveOld(fake).map((p) => `${p} | strokes ${strokesIn(fake.files.get(p)).join(",")}`);
		expect(erasedUnderOld, "premise 3: the save without s2 landed as the old id's live file").toEqual([`${at(DOT, OLD)} | strokes s1`]);

		const r2 = await store.keepAsideUnder(OLD, NEW, stampOf(r1));
		snap(fake, "erase, after round 2");
		const records = await listed(fake, store);
		const facts = {
			round1: brief(r1),
			round2: brief(r2),
			removedInRound1: removed.slice(0, removed1),
			removedAtSave: removed.slice(removed1, removedS),
			removedInRound2: removed.slice(removedS),
			s2InFiles: holding(fake, "s2"),
			listedAfterRound2: records.map((r) => `${r.pageId} | ${r.incomingPath}`).sort(),
			newPage: strokesIn(fake.files.get(at(DOT, NEW))),
			opensAfterReload: await opensNew(fake),
		};
		snap(fake, "erase, after the reload");
		console.log(`[facts] erase ${JSON.stringify(facts)}`);
		expect([facts.newPage, facts.opensAfterReload], "contract: the new page and a reload hold s1 only").toEqual([["s1"], ["s1"]]);
	});
});

/**
 * A SECOND ROUND AND WHAT ELSE THE FIRST ROUND'S FILE HOLDS.
 *
 * One folder only. Round 1 makes the old file the new id's live file; another
 * device's late old-id file lands between the rounds and holds every stroke of
 * round 1's file, so strokes alone never keep that file. Each cell gives round
 * 1's file one more thing the late file lacks: an attach group, an attach
 * record this build cannot read, a text box, an image, a top-level key this
 * build does not know (a paper choice this build cannot read is one), or such a
 * key on one stroke, text box, image or attach record. Two more cells take the
 * Slides road: round 1 moves the old id's Slides file, and the deck's later save
 * under the old Slides id runs round 2 with that round's stamp (the store's own
 * follow-up of a save under a moved id); round 1's file holds a text box or an
 * image the save lacks. The contract: round 1's file stays one copy beside the new page,
 * bytes unchanged, listed under the new id, so that thing is in some file
 * after round 2. Two controls: a late file that holds all of it, and a round 1
 * file whose only extra is the note's font size, column width, canvas or
 * paper choice, each lets round 2 remove round 1's file. Each cell logs the
 * listing before and after each round, every path removed, and a [facts] line.
 */
type RawPage = Record<string, unknown> & {
	strokes: Array<Record<string, unknown>>;
	textBoxes: Array<Record<string, unknown>>;
	images: Array<Record<string, unknown>>;
	attachments?: Array<Record<string, unknown>>;
};

/** `page`'s text as the store writes it, changed by `edit` on the parsed object, and written again. */
function edited(page: PageData, edit: (raw: RawPage) => void): string {
	const raw = JSON.parse(serializePage(page)) as RawPage;
	edit(raw);
	return JSON.stringify(raw);
}

/** A page as an older canvas note holds one: no surface, so text boxes and images are its own. */
function canvasPageOf(id: string, ...strokeIds: string[]): PageData {
	const p = pageOf(id, ...strokeIds);
	delete p.surface;
	return p;
}

const box = (id: string): Record<string, unknown> => ({ id, x: 40, y: 80, width: 320, z: 1 });
const image = (id: string): Record<string, unknown> => ({ id, x: 100, y: 200, width: 320, height: 240, z: 2 });
const group = (id: string, strokeId: string): Record<string, unknown> => ({
	v: 1,
	id,
	strokeIds: [strokeId],
	target: { kind: "range", from: 0, to: 4, text: "word", before: "", after: " more" },
	ref: { x: 0, y: 0 },
	layout: { width: 600, font: 16 },
	probe: { id: strokeId, x: 20, y: 0 },
});
/** An attach record of a later version: this build reads it as one it cannot read and writes it back as found. */
const laterRecord = (id: string, marker: string): Record<string, unknown> => ({ v: 2, id, anchor: { marker } });

/** The paths whose bytes hold `needle`, sorted. */
const holdingText = (fake: FakeAdapter, needle: string): string[] => [...fake.files.keys()].filter((p) => (fake.files.get(p) ?? "").includes(needle)).sort();

/**
 * Round 1 over `first` alone, `late` landed under the old id, then round 2 with round 1's stamp. Premises: both files
 * read whole, the late file's read holds every stroke of round 1's file's read, and `needle` (null: none) is in round
 * 1's file and not in the late file.
 */
async function secondRound(label: string, first: string, late: string, needle: string | null): Promise<{
	round1File: string;
	copies: string[];
	listedAs: string[];
	needleIn: string[];
	opens: string[];
}> {
	const { store, fake } = setup({ [at(PLAIN, OLD)]: first });
	const removed: string[] = [];
	watchRemoves(fake, removed);
	snap(fake, `${label}, before round 1`);

	const r1 = await store.keepAsideUnder(OLD, NEW);
	snap(fake, `${label}, after round 1`);
	const removed1 = removed.length;
	expect(r1.kind, "premise 1: round 1 moved").toBe("moved");
	expect(stampOf(r1), "premise 2: round 1 gives a stamp").toBeTypeOf("string");
	const round1File = fake.files.get(at(DOT, NEW)) ?? "";
	const wasRead = readMarks(round1File);
	const lateRead = readMarks(late);
	expect([wasRead.slice(0, 3), lateRead.slice(0, 3)], "premise 3: round 1's file and the late file both read whole").toEqual([
		[undefined, undefined, undefined],
		[undefined, undefined, undefined],
	]);
	const lateStrokes = lateRead[3] as string[];
	expect((wasRead[3] as string[]).filter((s) => !lateStrokes.includes(s)), "premise 4: the late file's read holds every stroke of round 1's file").toEqual([]);
	if (needle !== null) expect([round1File.includes(needle), late.includes(needle)], "premise 5: round 1's file holds the thing, the late file does not").toEqual([true, false]);

	fake.externalWrite(at(PLAIN, OLD), late);
	snap(fake, `${label}, after the late old-id file landed`);

	const r2 = await store.keepAsideUnder(OLD, NEW, stampOf(r1));
	snap(fake, `${label}, after round 2`);
	const copies = keptBeside(fake, round1File);
	const listedAs = (await listed(fake, store)).filter((r) => copies.includes(r.incomingPath)).map((r) => r.pageId);
	const needleIn = needle === null ? [] : holdingText(fake, needle);
	const opens = await opensNew(fake);
	const facts = {
		round1: brief(r1),
		round2: brief(r2),
		removedInRound1: removed.slice(0, removed1),
		removedInRound2: removed.slice(removed1),
		round1FileExactAfterRound2: exactly(fake, round1File),
		needleIn,
		opensAfterReload: opens,
	};
	snap(fake, `${label}, after the reload`);
	console.log(`[facts] ${label} ${JSON.stringify(facts)}`);
	return { round1File, copies, listedAs, needleIn, opens };
}

const KEPT = "contract: round 1's file is one copy beside the new page, bytes unchanged, listed under the new id";

const OLD_SLIDES = `${OLD}.slides`;
const NEW_SLIDES = `${NEW}.slides`;

/** A Slides file's page: the slides surface, the deck's coordinates. */
function slidesPageOf(id: string, ...strokeIds: string[]): PageData {
	const p = pageOf(id, ...strokeIds);
	p.surface = "slides";
	p.coordSpace = "slide-logical";
	return p;
}

/**
 * Round 1 moves the old id's Slides file `first` (a move that follows a later save), then the deck saves `late` under
 * the old Slides id: the store runs round 2 of the same move with round 1's stamp. Premises: round 1 moved and gave a
 * stamp, both read whole, the save's read holds every stroke of round 1's file's read, `needle` (null: none) is in round
 * 1's file and not in the save's text, and round 2 ran (no file under the old Slides id after the save).
 */
async function slidesSecondRound(label: string, first: string, late: PageData, needle: string | null): Promise<{
	copies: string[];
	listedAs: string[];
	needleIn: string[];
	opens: string[];
}> {
	const { store, fake } = setup({ [at(DOT, OLD_SLIDES)]: first });
	const removed: string[] = [];
	watchRemoves(fake, removed);
	snap(fake, `${label}, before round 1`);

	const r1 = await store.keepAsideUnder(OLD_SLIDES, NEW_SLIDES, undefined, () => false);
	snap(fake, `${label}, after round 1`);
	const removed1 = removed.length;
	expect(r1.kind, "premise 1: round 1 moved").toBe("moved");
	expect(stampOf(r1), "premise 2: round 1 gives a stamp").toBeTypeOf("string");
	const round1File = fake.files.get(at(DOT, NEW_SLIDES)) ?? "";
	const lateText = serializePage(late);
	const wasRead = readMarks(round1File);
	const lateRead = readMarks(lateText);
	expect([wasRead.slice(0, 3), lateRead.slice(0, 3)], "premise 3: round 1's file and the save both read whole").toEqual([
		[undefined, undefined, undefined],
		[undefined, undefined, undefined],
	]);
	const lateStrokes = lateRead[3] as string[];
	expect((wasRead[3] as string[]).filter((s) => !lateStrokes.includes(s)), "premise 4: the save's read holds every stroke of round 1's file").toEqual([]);
	if (needle !== null) expect([round1File.includes(needle), lateText.includes(needle)], "premise 5: round 1's file holds the thing, the save does not").toEqual([true, false]);

	await store.saveNow(OLD_SLIDES, late);
	snap(fake, `${label}, after the save under the old Slides id`);
	expect(fake.files.has(at(DOT, OLD_SLIDES)), "premise 6: round 2 ran and took the save's file").toBe(false);
	const copies = [...fake.files.keys()].filter((p) => p.startsWith(`${DOT}/${NEW_SLIDES}.conflict-`) && fake.files.get(p) === round1File).sort();
	const listedAs = (await listed(fake, store)).filter((r) => copies.includes(r.incomingPath)).map((r) => r.pageId);
	const needleIn = needle === null ? [] : holdingText(fake, needle);
	const opens = ((await storeOver(fake).load(NEW_SLIDES))?.data.strokes ?? []).map((s) => s.id).sort();
	const facts = {
		round1: brief(r1),
		removedInRound1: removed.slice(0, removed1),
		removedInRound2: removed.slice(removed1),
		round1FileExactAfterRound2: exactly(fake, round1File),
		needleIn,
		opensAfterReload: opens,
	};
	snap(fake, `${label}, after the reload`);
	console.log(`[facts] ${label} ${JSON.stringify(facts)}`);
	return { copies, listedAs, needleIn, opens };
}

describe("a second round of the same id move: round 1's file is kept when it holds something the late file lacks, not only a stroke", () => {
	it("g1. an attach group only round 1's file holds: round 2 keeps round 1's file as a listed copy", async () => {
		const first = edited(pageOf(OLD, "s1", "s2"), (raw) => {
			raw.attachments = [group("grp1", "s2")];
		});
		const late = serializePage(pageOf(OLD, "s1", "s2"));
		const r = await secondRound("g1 group", first, late, '"grp1"');
		expect([r.copies.length, r.listedAs], KEPT).toEqual([1, [NEW]]);
	});

	it("g2. an attach record this build cannot read, only in round 1's file: round 2 keeps round 1's file as a listed copy", async () => {
		const first = edited(pageOf(OLD, "s1", "s2"), (raw) => {
			raw.attachments = [laterRecord("grp9", "only-round-1")];
		});
		const late = serializePage(pageOf(OLD, "s1", "s2"));
		const r = await secondRound("g2 later record", first, late, '"grp9"');
		expect([r.copies.length, r.listedAs], KEPT).toEqual([1, [NEW]]);
	});

	it("g3. an attach record this build cannot read, in both files under one id with other bytes: round 2 keeps round 1's file as a listed copy", async () => {
		const first = edited(pageOf(OLD, "s1", "s2"), (raw) => {
			raw.attachments = [laterRecord("grp9", "round-1-bytes")];
		});
		const late = edited(pageOf(OLD, "s1", "s2"), (raw) => {
			raw.attachments = [laterRecord("grp9", "late-bytes")];
		});
		const r = await secondRound("g3 later record, other bytes", first, late, "round-1-bytes");
		expect([r.copies.length, r.listedAs], KEPT).toEqual([1, [NEW]]);
	});

	it("g4. a text box only round 1's file holds: round 2 keeps round 1's file as a listed copy", async () => {
		const first = edited(canvasPageOf(OLD, "s1", "s2"), (raw) => {
			raw.textBoxes = [box("box-a"), box("box-r1")];
		});
		const late = edited(canvasPageOf(OLD, "s1", "s2"), (raw) => {
			raw.textBoxes = [box("box-a")];
		});
		const r = await secondRound("g4 text box", first, late, '"box-r1"');
		expect([r.copies.length, r.listedAs], KEPT).toEqual([1, [NEW]]);
	});

	it("g5. an image only round 1's file holds: round 2 keeps round 1's file as a listed copy", async () => {
		const first = edited(canvasPageOf(OLD, "s1", "s2"), (raw) => {
			raw.images = [image("img-a"), image("img-r1")];
		});
		const late = edited(canvasPageOf(OLD, "s1", "s2"), (raw) => {
			raw.images = [image("img-a")];
		});
		const r = await secondRound("g5 image", first, late, '"img-r1"');
		expect([r.copies.length, r.listedAs], KEPT).toEqual([1, [NEW]]);
	});

	it("g6. a top-level key this build does not know, only in round 1's file: round 2 keeps round 1's file as a listed copy", async () => {
		const first = edited(pageOf(OLD, "s1", "s2"), (raw) => {
			raw.laterTop = { kept: true };
		});
		const late = serializePage(pageOf(OLD, "s1", "s2"));
		const r = await secondRound("g6 unknown top key", first, late, '"laterTop"');
		expect([r.copies.length, r.listedAs], KEPT).toEqual([1, [NEW]]);
	});

	it("g7. a key this build does not know on one stroke, only in round 1's file: round 2 keeps round 1's file as a listed copy", async () => {
		const first = edited(pageOf(OLD, "s1", "s2"), (raw) => {
			raw.strokes[1]!.laterStroke = 7;
		});
		const late = serializePage(pageOf(OLD, "s1", "s2"));
		const r = await secondRound("g7 unknown stroke key", first, late, '"laterStroke"');
		expect([r.copies.length, r.listedAs], KEPT).toEqual([1, [NEW]]);
	});

	it("g8. a key this build does not know on one text box, only in round 1's file: round 2 keeps round 1's file as a listed copy", async () => {
		const first = edited(canvasPageOf(OLD, "s1", "s2"), (raw) => {
			raw.textBoxes = [{ ...box("box-a"), laterBox: "r1" }];
		});
		const late = edited(canvasPageOf(OLD, "s1", "s2"), (raw) => {
			raw.textBoxes = [box("box-a")];
		});
		const r = await secondRound("g8 unknown text box key", first, late, '"laterBox"');
		expect([r.copies.length, r.listedAs], KEPT).toEqual([1, [NEW]]);
	});

	it("g9. a key this build does not know on one image, only in round 1's file: round 2 keeps round 1's file as a listed copy", async () => {
		const first = edited(canvasPageOf(OLD, "s1", "s2"), (raw) => {
			raw.images = [{ ...image("img-a"), laterImage: "r1" }];
		});
		const late = edited(canvasPageOf(OLD, "s1", "s2"), (raw) => {
			raw.images = [image("img-a")];
		});
		const r = await secondRound("g9 unknown image key", first, late, '"laterImage"');
		expect([r.copies.length, r.listedAs], KEPT).toEqual([1, [NEW]]);
	});

	it("g10. a key this build does not know on one attach group, only in round 1's file: round 2 keeps round 1's file as a listed copy", async () => {
		const first = edited(pageOf(OLD, "s1", "s2"), (raw) => {
			raw.attachments = [{ ...group("grp1", "s2"), laterGroup: "r1" }];
		});
		const late = edited(pageOf(OLD, "s1", "s2"), (raw) => {
			raw.attachments = [group("grp1", "s2")];
		});
		const r = await secondRound("g10 unknown group key", first, late, '"laterGroup"');
		expect([r.copies.length, r.listedAs], KEPT).toEqual([1, [NEW]]);
	});

	it("g11. a paper choice this build cannot read, only in round 1's file: round 2 keeps round 1's file as a listed copy", async () => {
		const first = edited(pageOf(OLD, "s1", "s2"), (raw) => {
			raw.notePaper = "sepia";
		});
		const late = serializePage(pageOf(OLD, "s1", "s2"));
		const r = await secondRound("g11 unreadable paper choice", first, late, '"sepia"');
		expect([r.copies.length, r.listedAs], KEPT).toEqual([1, [NEW]]);
	});

	it("g12. Slides road: a text box only round 1's Slides file holds, the deck's later save under the old Slides id lacks it: round 1's file is kept as a listed copy", async () => {
		const first = edited(slidesPageOf(OLD_SLIDES, "s1", "s2"), (raw) => {
			raw.textBoxes = [box("box-a"), box("box-r1")];
		});
		const late = parsePage(edited(slidesPageOf(OLD_SLIDES, "s1", "s2"), (raw) => {
			raw.textBoxes = [box("box-a")];
		}), OLD_SLIDES).data;
		const r = await slidesSecondRound("g12 Slides text box", first, late, '"box-r1"');
		expect([r.copies.length, r.listedAs], `${KEPT} (the new Slides id)`).toEqual([1, [NEW_SLIDES]]);
	});

	it("g13. Slides road: an image only round 1's Slides file holds, the deck's later save under the old Slides id lacks it: round 1's file is kept as a listed copy", async () => {
		const first = edited(slidesPageOf(OLD_SLIDES, "s1", "s2"), (raw) => {
			raw.images = [image("img-a"), image("img-r1")];
		});
		const late = parsePage(edited(slidesPageOf(OLD_SLIDES, "s1", "s2"), (raw) => {
			raw.images = [image("img-a")];
		}), OLD_SLIDES).data;
		const r = await slidesSecondRound("g13 Slides image", first, late, '"img-r1"');
		expect([r.copies.length, r.listedAs], `${KEPT} (the new Slides id)`).toEqual([1, [NEW_SLIDES]]);
	});

	it("control: Slides road, the deck's later save holds round 1's text box and image and one stroke more: round 2 removes round 1's file", async () => {
		const all = (raw: RawPage): void => {
			raw.textBoxes = [box("box-r1")];
			raw.images = [image("img-r1")];
		};
		const first = edited(slidesPageOf(OLD_SLIDES, "s1", "s2"), all);
		const late = parsePage(edited(slidesPageOf(OLD_SLIDES, "s1", "s2", "s3"), all), OLD_SLIDES).data;
		const r = await slidesSecondRound("control, Slides save holds all", first, late, null);
		expect([r.copies.length, r.opens], "contract: round 1's file is removed and the save is the new Slides page").toEqual([0, ["s1", "s2", "s3"]]);
	});

	it("control: a late file holding everything round 1's file holds, and one stroke more, lets round 2 remove round 1's file", async () => {
		const all = (raw: RawPage): void => {
			raw.textBoxes = [{ ...box("box-a"), laterBox: "same" }];
			raw.images = [{ ...image("img-a"), laterImage: "same" }];
			raw.attachments = [{ ...group("grp1", "s2"), laterGroup: "same" }, laterRecord("grp9", "same-bytes")];
			raw.strokes[1]!.laterStroke = 7;
			raw.laterTop = { kept: true };
		};
		const first = edited(canvasPageOf(OLD, "s1", "s2"), all);
		const late = edited(canvasPageOf(OLD, "s1", "s2", "s3"), all);
		const r = await secondRound("control, late holds all", first, late, null);
		expect([r.copies.length, r.opens], "contract: round 1's file is removed and the late file is the page").toEqual([0, ["s1", "s2", "s3"]]);
	});

	it("control: round 1's file whose only extras are the note's font size, column width, canvas and paper choice lets round 2 remove it", async () => {
		const first = edited(pageOf(OLD, "s1", "s2"), (raw) => {
			raw.fontRefPx = 16;
			raw.columnRefPx = 700;
			raw.noteCanvas = true;
			raw.notePaper = "grid";
		});
		const late = serializePage(pageOf(OLD, "s1", "s2"));
		const r = await secondRound("control, note settings only", first, late, '"fontRefPx"');
		expect([r.copies.length, r.opens], "contract: round 1's file is removed and the late file is the page").toEqual([0, ["s1", "s2"]]);
	});
});
