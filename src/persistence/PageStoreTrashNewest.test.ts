/**
 * A restored note whose newest trashed ink cannot be read the first time. Deleting a note moves its ink file into the
 * ink folder's trash, one generation per delete, and a note that comes back (from Obsidian's .trash, or undeleted by a
 * sync client) loads with no live ink file, so the load puts the newest generation in the trash back as the live file.
 * Before the fix a newest generation whose read threw, or whose bytes came back cut short, was passed over on that
 * one look: the next older generation was moved back instead and became the note's ink, and the newer strokes stayed
 * in the trash, where no later load looks again because the live file is there.
 *
 * Wanted: the newest generation is read once more when its first read throws or its bytes do not read whole, at once,
 * with no wait. Read whole the second time, it comes back. A read that fails both times ends as before: the next
 * older generation comes back, and the newest stays in the trash, byte for byte. A new note is never locked. A newest
 * that is gone because another device restored the note, its live file landing, is never written over by an older
 * generation: the live paths are looked at once more before one is moved back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageData, emptyPage } from "../model/PageData";

function pageOf(id: string, ...labels: string[]): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = labels.map((label) => ({
		id: label,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 0 },
		createdAt: 0,
	}));
	return p;
}

/**
 * The in-memory vault, with a trash listing as the host gives it, and reads that can be made to fail the way a file
 * held open by another program fails (Node's EBUSY), or to come back cut short the way a file a sync client is still
 * writing does. Every read is counted per path.
 */
function disk() {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	const inFolder = (folder: string) =>
		[...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/"));
	adapter.list = async (folder: string) => {
		const files = inFolder(folder);
		if (files.length === 0 && !adapter.dirs.has(folder)) {
			throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${folder}'`), { code: "ENOENT" });
		}
		return { files, folders: [] };
	};
	const exists = adapter.exists.bind(adapter);
	adapter.exists = async (p: string) => (await exists(p)) || inFolder(p).length > 0;
	const reads = new Map<string, number>();
	const throwing = new Map<string, number>();
	const cut = new Map<string, number>();
	const moves = new Map<string, string>();
	const read = adapter.read.bind(adapter);
	adapter.read = async (p: string) => {
		reads.set(p, (reads.get(p) ?? 0) + 1);
		const to = moves.get(p);
		if (to !== undefined) {
			moves.delete(p);
			adapter.files.set(to, adapter.files.get(p)!);
			adapter.mtimes.set(to, 7_000_000);
			adapter.files.delete(p);
			adapter.mtimes.delete(p);
			throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
		}
		const t = throwing.get(p) ?? 0;
		if (t > 0) {
			throwing.set(p, t - 1);
			throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${p}'`), { code: "EBUSY" });
		}
		const text = await read(p);
		const c = cut.get(p) ?? 0;
		if (c > 0) {
			cut.set(p, c - 1);
			return text.slice(0, Math.floor(text.length / 2));
		}
		return text;
	};
	return {
		adapter,
		/** The next `n` reads of `path` throw (Infinity: every one). */
		readThrows(path: string, n: number) {
			throwing.set(path, n);
		},
		/** The next `n` reads of `path` return its first half only. */
		readCut(path: string, n: number) {
			cut.set(path, n);
		},
		/**
		 * The next read of `path` finds it gone: its bytes have just been moved to `to`, the way sync lands another
		 * device's restore (the generation out of the trash, the live file written), and the read throws ENOENT.
		 */
		readFindsMovedTo(path: string, to: string) {
			moves.set(path, to);
		},
		reads(path: string) {
			return reads.get(path) ?? 0;
		},
	};
}

type Disk = ReturnType<typeof disk>;

let clock = 6_000_000;
beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	clock = 6_000_000;
});

function store(d: Disk) {
	return new PageStore({ vault: { adapter: d.adapter } } as never, ".handwriting", () => clock);
}

/** A generation in `folder`'s trash, as a delete leaves it: `<pageId>-<stamp>.json`, or `-external` when set aside. */
function trash(d: Disk, folder: string, pageId: string, stamp: number, text: string, external = false): string {
	const path = `${folder}/trash/${pageId}-${stamp}${external ? "-external" : ""}.json`;
	d.adapter.files.set(path, text);
	d.adapter.mtimes.set(path, stamp);
	return path;
}

const json = (id: string, ...labels: string[]) => JSON.stringify(pageOf(id, ...labels));
const ids = (page: { data: PageData } | null | undefined) => page?.data.strokes.map((x) => x.id);

/** Every live ink file of `pageId`, trash excluded, in both well-known folders. */
function live(d: Disk, pageId: string): string[] {
	return [...d.adapter.files.keys()].filter((p) => p.endsWith(`/${pageId}.json`) && !p.includes("/trash/")).sort();
}

/** Two generations in the configured folder's trash: the older holds one stroke, the newest that stroke and another. */
function twoGenerations(d: Disk) {
	const older = trash(d, ".handwriting", "p1", 5_000_000, json("p1", "s1"));
	const newestText = json("p1", "s1", "s2");
	const newest = trash(d, ".handwriting", "p1", 5_001_000, newestText);
	return { older, newest, newestText };
}

describe("a restored note whose newest trashed ink fails its first read", () => {
	it("the read throws once: the newest ink comes back, and a stroke right after it lands on top, in one live file", async () => {
		const d = disk();
		const { older, newest } = twoGenerations(d);
		d.readThrows(newest, 1);
		const s = store(d);
		const back = await s.load("p1");
		expect(back?.damaged ?? false, "the note came back locked").toBe(false);
		expect(ids(back), "the older generation came back over the newest").toEqual(["s1", "s2"]);
		expect(live(d, "p1")).toEqual([".handwriting/p1.json"]);
		expect(d.adapter.files.has(newest), "the newest generation is still in the trash").toBe(false);
		expect(d.adapter.files.has(older), "the older generation left the trash").toBe(true);
		await s.saveNow("p1", pageOf("p1", "s1", "s2", "s3"));
		expect(live(d, "p1"), "the stroke after the open began a second live ink file").toEqual([".handwriting/p1.json"]);
		expect(ids(await store(d).load("p1")), "after a stroke and a relaunch, an earlier stroke is gone").toEqual(["s1", "s2", "s3"]);
	});

	it("the newest is the configured folder's and the older the other folder's: the newest comes back into its own folder", async () => {
		const d = disk();
		const older = trash(d, "handwriting", "p1", 5_000_000, json("p1", "s1"));
		const newest = trash(d, ".handwriting", "p1", 5_001_000, json("p1", "s1", "s2"));
		d.readThrows(newest, 1);
		const back = await store(d).load("p1");
		expect(ids(back), "the older generation came back over the newest").toEqual(["s1", "s2"]);
		expect(live(d, "p1"), "the page moved to the older generation's folder").toEqual([".handwriting/p1.json"]);
		expect(d.adapter.files.has(older), "the older generation left the other folder's trash").toBe(true);
	});

	it("no plain generation, two set-aside copies from another device: the newest copy's read throws once, and it comes back", async () => {
		const d = disk();
		const older = trash(d, ".handwriting", "p1", 5_000_000, json("p1", "s1"), true);
		const newest = trash(d, ".handwriting", "p1", 5_001_000, json("p1", "s1", "s2"), true);
		d.readThrows(newest, 1);
		const back = await store(d).load("p1");
		expect(back?.damaged ?? false).toBe(false);
		expect(ids(back), "the older copy came back over the newest").toEqual(["s1", "s2"]);
		expect(live(d, "p1")).toEqual([".handwriting/p1.json"]);
		expect(d.adapter.files.has(older), "the older copy left the trash").toBe(true);
	});

	it("the bytes come back cut short once, whole on the second read: the newest ink comes back", async () => {
		const d = disk();
		const { older, newest } = twoGenerations(d);
		d.readCut(newest, 1);
		const back = await store(d).load("p1");
		expect(back?.damaged ?? false, "the note came back locked").toBe(false);
		expect(ids(back), "the older generation came back over the newest").toEqual(["s1", "s2"]);
		expect(d.adapter.files.has(older), "the older generation left the trash").toBe(true);
	});

	it("the newest is read twice at most and each older generation once, then the older one comes back", async () => {
		const d = disk();
		const { older, newest } = twoGenerations(d);
		// Ten failures: a retry that never stops reads it whole on the eleventh try, so the count tells it apart
		// without waiting on a test timeout.
		d.readThrows(newest, 10);
		const back = await store(d).load("p1");
		expect(d.reads(newest), "reads of the newest generation").toBe(2);
		expect(d.reads(older), "reads of the older generation").toBe(1);
		expect(ids(back)).toEqual(["s1"]);
	});
});

describe("a newest generation that fails every read ends as before", () => {
	it("the read throws every time (held open past the second read): the older generation comes back, the newest stays in the trash byte for byte", async () => {
		const d = disk();
		const { newest, newestText } = twoGenerations(d);
		d.readThrows(newest, Infinity);
		const back = await store(d).load("p1");
		expect(back?.damaged ?? false).toBe(false);
		expect(ids(back)).toEqual(["s1"]);
		expect(live(d, "p1")).toEqual([".handwriting/p1.json"]);
		expect(d.adapter.files.get(newest)).toBe(newestText);
	});

	it("the bytes on disk are cut short (a sync that never finished): the older generation comes back, the cut file stays in the trash byte for byte", async () => {
		const d = disk();
		trash(d, ".handwriting", "p1", 5_000_000, json("p1", "s1"));
		const whole = json("p1", "s1", "s2");
		const cutText = whole.slice(0, Math.floor(whole.length / 2));
		const newest = trash(d, ".handwriting", "p1", 5_001_000, cutText);
		const back = await store(d).load("p1");
		expect(ids(back)).toEqual(["s1"]);
		expect(d.adapter.files.get(newest)).toBe(cutText);
	});

	it("the newest was written by a newer build (a stroke whose points this build cannot read): the older generation comes back, the newest stays in the trash byte for byte", async () => {
		const d = disk();
		trash(d, ".handwriting", "p1", 5_000_000, json("p1", "s1"));
		const page = pageOf("p1", "s1", "s2") as unknown as { strokes: Array<Record<string, unknown>> };
		const s2 = page.strokes[1]!;
		delete s2.points;
		s2.pointsV9 = "AAECAwQF";
		const newerText = JSON.stringify(page);
		const newest = trash(d, ".handwriting", "p1", 5_001_000, newerText);
		const back = await store(d).load("p1");
		expect(ids(back)).toEqual(["s1"]);
		expect(d.adapter.files.get(newest)).toBe(newerText);
	});
});

describe("the newest leaves the trash under the read: another device restored the note and its live file is landing", () => {
	const renames = (d: Disk) => d.adapter.log.filter((l) => l.startsWith("rename "));

	it.each([false, true])(
		"the older generation is never moved over it, and the landed ink is the page (host refuses a rename onto a file: %s)",
		async (refuse) => {
			const d = disk();
			d.adapter.refuseRenameOntoFile = refuse;
			const { older, newest, newestText } = twoGenerations(d);
			d.readFindsMovedTo(newest, ".handwriting/p1.json");
			const back = await store(d).load("p1");
			expect(back?.damaged ?? false).toBe(false);
			expect(ids(back), "the older generation came back over the landed newest").toEqual(["s1", "s2"]);
			expect(d.adapter.files.get(".handwriting/p1.json"), "the landed live file was written over").toBe(newestText);
			expect(d.adapter.files.has(older), "the older generation left the trash").toBe(true);
			expect(renames(d), "a generation was moved back").toEqual([]);
		},
	);

	it.each([false, true])(
		"no older plain generation, a set-aside copy: the copy is never moved over it either (host refuses a rename onto a file: %s)",
		async (refuse) => {
			const d = disk();
			d.adapter.refuseRenameOntoFile = refuse;
			const copy = trash(d, ".handwriting", "p1", 5_000_000, json("p1", "s1"), true);
			const newestText = json("p1", "s1", "s2");
			const newest = trash(d, ".handwriting", "p1", 5_001_000, newestText);
			d.readFindsMovedTo(newest, ".handwriting/p1.json");
			const back = await store(d).load("p1");
			expect(back?.damaged ?? false).toBe(false);
			expect(ids(back), "the set-aside copy came back over the landed newest").toEqual(["s1", "s2"]);
			expect(d.adapter.files.get(".handwriting/p1.json"), "the landed live file was written over").toBe(newestText);
			expect(d.adapter.files.has(copy), "the set-aside copy left the trash").toBe(true);
			expect(renames(d), "a generation was moved back").toEqual([]);
		},
	);
});

describe("a new note is never locked", () => {
	const fields = (s: PageStore) => s as unknown as { observedMissing: Set<string>; unreadable: Map<string, unknown> };

	it("no generation in any trash: the load answers no page, and the page is seen missing", async () => {
		const d = disk();
		const s = store(d);
		expect(await s.load("p1")).toBeNull();
		expect(fields(s).observedMissing.has("p1")).toBe(true);
		expect(fields(s).unreadable.has("p1")).toBe(false);
	});

	it("the only generation fails every read: no page, not locked, and the first stroke saves", async () => {
		const d = disk();
		const only = trash(d, ".handwriting", "p1", 5_000_000, json("p1", "s1"));
		d.readThrows(only, Infinity);
		const s = store(d);
		const back = await s.load("p1");
		expect(back, "the note came back as a page, damaged or held, instead of no page").toBeNull();
		expect(fields(s).unreadable.has("p1"), "the note is held as unreadable").toBe(false);
		await s.saveNow("p1", pageOf("p1", "first"));
		expect(live(d, "p1")).toEqual([".handwriting/p1.json"]);
		d.readThrows(only, 0);
		expect(ids(await store(d).load("p1"))).toEqual(["first"]);
	});
});
