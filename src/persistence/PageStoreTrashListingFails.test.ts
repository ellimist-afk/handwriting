/**
 * A restored note's trash folder cannot be listed. Deleting a note moves its ink file into the ink folder's trash, and a
 * note that comes back (from Obsidian's .trash, or undeleted by a sync client) loads with no live ink file, so the load
 * looks in every ink folder's trash for the newest generation and moves it back. Obsidian's desktop adapter reads the
 * folder, then stats each entry with no catch, so one entry gone between the two rejects the whole listing, with
 * Node's ENOENT for that entry. Before the fix a listing that threw was skipped like a trash that is not there: the
 * note opened blank, and its next stroke began a second ink file under the same id, with the earlier ink left in the
 * trash for good. With an older generation in the other folder's trash, that older one came back instead.
 *
 * Wanted: one failed trash listing is tried again and the note's newest ink comes back. A trash that keeps failing
 * opens the note blank, as before, and a new note is never locked. A trash folder that is not there is still an empty
 * one.
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
 * How the host rejects a listing. Desktop: Node's error, with its code. Mobile: the code only when the message says
 * "does not exist", so another message carries none.
 */
type Host = "desktop" | "mobile";

/** The in-memory vault, with a listing that fails as the host's does. */
function disk(host: Host = "desktop") {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	const failing = { trash: new Map<string, number>(), calls: new Map<string, number>() };
	const inFolder = (folder: string) =>
		[...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/"));
	adapter.list = async (folder: string) => {
		const files = inFolder(folder);
		// The host reads the folder first: one that is not there rejects at the read.
		if (files.length === 0 && !adapter.dirs.has(folder)) {
			if (host === "mobile") throw new Error(`could not open folder ${folder}`);
			throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${folder}'`), { code: "ENOENT" });
		}
		failing.calls.set(folder, (failing.calls.get(folder) ?? 0) + 1);
		const left = failing.trash.get(folder) ?? 0;
		if (left > 0) {
			failing.trash.set(folder, left - 1);
			// Then it stats each entry; one gone since the read rejects the whole listing, with that entry's ENOENT.
			if (host === "mobile") throw new Error(`could not stat ${folder}/p0-1.json.tmp`);
			throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${folder}/p0-1.json.tmp'`), { code: "ENOENT" });
		}
		return { files, folders: [] };
	};
	// A folder is there while it holds a file, as on disk.
	const exists = adapter.exists.bind(adapter);
	adapter.exists = async (p: string) => (await exists(p)) || inFolder(p).length > 0;
	/** The next `n` listings of `folder` fail (Infinity: every one). */
	function listingFails(folder: string, n: number) {
		failing.trash.set(folder, n);
	}
	function listed(folder: string) {
		return failing.calls.get(folder) ?? 0;
	}
	return { adapter, listingFails, listed };
}

type Disk = ReturnType<typeof disk>;

let clock = 5_000_000;
beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	clock = 5_000_000;
});

function store(d: Disk) {
	return new PageStore({ vault: { adapter: d.adapter } } as never, ".handwriting", () => clock);
}

/** Every generation of `pageId` in `folder`'s trash. */
function trashed(d: Disk, folder: string, pageId: string): string[] {
	return [...d.adapter.files.keys()].filter((p) => p.startsWith(`${folder}/trash/${pageId}-`) && p.endsWith(".json")).sort();
}

/** The note is inked with these strokes in `folder`, saved, then deleted: its ink file goes to that folder's trash. */
async function inkedThenDeleted(d: Disk, folder: string, pageId: string, ...labels: string[]) {
	d.adapter.files.set(`${folder}/${pageId}.json`, JSON.stringify(pageOf(pageId, ...labels)));
	d.adapter.mtimes.set(`${folder}/${pageId}.json`, 42);
	const s = store(d);
	await s.load(pageId);
	await s.remove(pageId);
	expect(d.adapter.files.has(`${folder}/${pageId}.json`), "precondition: the delete moved the live ink file away").toBe(false);
}

const ids = (page: { data: PageData } | null | undefined) => page?.data.strokes.map((x) => x.id);

/** Every live ink file of `pageId`, trash excluded, in both well-known folders. */
function live(d: Disk, pageId: string): string[] {
	return [...d.adapter.files.keys()].filter((p) => p.endsWith(`/${pageId}.json`) && !p.includes("/trash/")).sort();
}

describe.each(["desktop", "mobile"] as const)("a restored note whose trash listing fails once, on the %s host", (host) => {
	it("the load still brings its newest ink back, and a stroke right after it lands on top, in one live file", async () => {
		const d = disk(host);
		await inkedThenDeleted(d, ".handwriting", "p1", "older");
		clock += 1000;
		await inkedThenDeleted(d, ".handwriting", "p1", "newer");
		expect(trashed(d, ".handwriting", "p1"), "precondition: two generations in the trash").toHaveLength(2);
		d.listingFails(".handwriting/trash", 1);
		const s = store(d);
		const before = d.listed(".handwriting/trash");
		const back = await s.load("p1");
		expect(d.listed(".handwriting/trash"), "precondition: the load listed the trash").toBeGreaterThan(before);
		expect(back, "the note came back blank while its ink sat in the trash").not.toBeNull();
		expect(back?.damaged ?? false, "the note came back locked").toBe(false);
		expect(ids(back), "the note came back without its newest ink").toEqual(["newer"]);
		await s.saveNow("p1", pageOf("p1", "newer", "next"));
		expect(live(d, "p1"), "the stroke after the open began a second live ink file").toEqual([".handwriting/p1.json"]);
		expect(ids(await store(d).load("p1")), "after a stroke and a relaunch, an earlier stroke is gone").toEqual(["newer", "next"]);
		expect(trashed(d, ".handwriting", "p1"), "the older generation left the trash").toHaveLength(1);
	});

	it("with an older generation in the other folder's trash: the newest still comes back, not the older one", async () => {
		const d = disk(host);
		await inkedThenDeleted(d, "handwriting", "p1", "older");
		clock += 1000;
		await inkedThenDeleted(d, ".handwriting", "p1", "newer");
		d.listingFails(".handwriting/trash", 1);
		const back = await store(d).load("p1");
		expect(ids(back), "the older generation came back over the newest").toEqual(["newer"]);
		expect(trashed(d, "handwriting", "p1"), "the older generation left the other folder's trash").toHaveLength(1);
	});
});

describe.each(["desktop", "mobile"] as const)("a trash that keeps failing to list, on the %s host", (host) => {
	it("a restored note opens blank, as before, takes a stroke, and its trashed ink stays in the trash", async () => {
		const d = disk(host);
		await inkedThenDeleted(d, ".handwriting", "p1", "gone");
		d.listingFails(".handwriting/trash", Infinity);
		const s = store(d);
		const back = await s.load("p1");
		expect(d.listed(".handwriting/trash"), "precondition: the load listed the trash").toBeGreaterThan(0);
		expect(back, "a trash that keeps failing locked the note or served something other than blank").toBeNull();
		await s.saveNow("p1", pageOf("p1", "fresh"));
		expect(ids(await store(d).load("p1")), "the stroke on the blank note was not kept").toEqual(["fresh"]);
		expect(trashed(d, ".handwriting", "p1"), "the trashed ink left the trash").toHaveLength(1);
	});

	it("a new note is never locked: it opens blank and its stroke is kept", async () => {
		const d = disk(host);
		await inkedThenDeleted(d, ".handwriting", "p1", "gone");
		d.listingFails(".handwriting/trash", Infinity);
		const s = store(d);
		const fresh = await s.load("new");
		expect(d.listed(".handwriting/trash"), "precondition: the load listed the trash").toBeGreaterThan(0);
		expect(fresh, "a trash that keeps failing locked a new note").toBeNull();
		await s.saveNow("new", pageOf("new", "first"));
		expect(ids(await store(d).load("new")), "the new note's stroke was not kept").toEqual(["first"]);
	});
});

describe.each(["desktop", "mobile"] as const)("a trash folder that is not there, on the %s host", (host) => {
	it("is an empty one: a new note opens blank and its stroke is kept", async () => {
		const d = disk(host);
		const s = store(d);
		expect(await s.load("new"), "an absent trash locked a new note").toBeNull();
		await s.saveNow("new", pageOf("new", "first"));
		expect(ids(await store(d).load("new")), "the new note's stroke was not kept").toEqual(["first"]);
	});
});
