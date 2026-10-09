/**
 * Deleting a note recycles the scratch files beside its sidecar instead of
 * deleting them (R1). A `.tmp` left by a save
 * that never replaced the live file, or a flush carrier whose save never
 * landed, can hold ink no other file has: from an earlier session, on a note
 * deleted without being opened in this one. The one carrier removed outright
 * is one this session wrote whose generation the queued page already holds.
 */
import { describe, expect, it } from "vitest";
import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";

(globalThis as { window?: unknown }).window = globalThis;

function pageOf(id: string, ...labels: string[]): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = labels.map((l) => ({
		id: l,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
	})) as PageData["strokes"];
	return p;
}

/** Stroke ids of every readable page in the trash. */
function trashedIds(fake: FakeAdapter): string[][] {
	return [...fake.files.entries()]
		.filter(([path]) => path.startsWith(".handwriting/trash/"))
		.map(([, text]) => parsePage(text, "X"))
		.filter((r) => !r.damaged)
		.map((r) => r.data.strokes.map((s) => s.id));
}

function freshStore(fake: FakeAdapter): PageStore {
	return new PageStore({ vault: { adapter: fake } }, ".handwriting", () => 5000);
}

describe("deleting a note recycles its scratch files instead of deleting them", () => {
	it("a .tmp left by an earlier session's interrupted save goes to the trash", async () => {
		const fake = new FakeAdapter();
		fake.dirs.add(".handwriting");
		fake.externalWrite(".handwriting/X.json", serializePage(pageOf("X", "base")));
		fake.externalWrite(".handwriting/X.json.tmp", serializePage(pageOf("X", "base", "stranded")));

		await freshStore(fake).remove("X");

		expect(fake.files.has(".handwriting/X.json.tmp")).toBe(false);
		expect(
			trashedIds(fake).some((ids) => ids.includes("stranded")),
			"the interrupted save's ink was deleted"
		).toBe(true);
	});

	it("a flush carrier from an earlier session goes to the trash as a readable page", async () => {
		const fake = new FakeAdapter();
		fake.dirs.add(".handwriting");
		fake.externalWrite(".handwriting/X.json", serializePage(pageOf("X", "base")));
		fake.externalWrite(
			".handwriting/X.json.flush",
			`{"flushBase":null,"page":${serializePage(pageOf("X", "base", "flushed"))}}`
		);

		await freshStore(fake).remove("X");

		expect(fake.files.has(".handwriting/X.json.flush")).toBe(false);
		expect(
			trashedIds(fake).some((ids) => ids.includes("flushed")),
			"the background flush's ink was deleted"
		).toBe(true);
	});

	it("control: a carrier this session wrote, held by the queued page, is removed and not recycled twice", async () => {
		const fake = new FakeAdapter();
		fake.dirs.add(".handwriting");
		fake.externalWrite(".handwriting/X.json", serializePage(pageOf("X", "base")));
		const store = freshStore(fake);
		await store.load("X");
		store.schedule("X", pageOf("X", "base", "queued"));
		store.flushDispatch();

		await store.remove("X");

		expect(fake.files.has(".handwriting/X.json.flush")).toBe(false);
		const trashed = trashedIds(fake).filter((ids) => ids.includes("queued"));
		expect(trashed, "the queued page is recycled exactly once").toHaveLength(1);
	});
});

/** FakeAdapter with the folder listing a trash restore needs. */
class ListingAdapter extends FakeAdapter {
	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = path.endsWith("/") ? path : `${path}/`;
		const files = [...this.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"));
		if (files.length === 0 && !this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
		return { files, folders: [] };
	}
}

/**
 * The scratch and conflict generations above are recycled under a tag
 * (`-external`, `-tmp`, `-flush`, and Delete all's `-wipe`). An interrupted
 * save, a flush carrier and a wiped page are never the page's last live
 * state, so reopening a note whose ink is in the trash never brings one of
 * them back on its own: they stay in the trash for the user. A copy from
 * another device is the exception, below.
 */
describe("a tagged trash generation is never restored on its own", () => {
	const TAGS = ["tmp", "flush", "wipe"] as const;
	const ALL_TAGS = ["external", ...TAGS] as const;

	function trashOnly(): ListingAdapter {
		const fake = new ListingAdapter();
		fake.dirs.add(".handwriting");
		fake.dirs.add(".handwriting/trash");
		return fake;
	}
	const restoredIds = (loaded: Awaited<ReturnType<PageStore["load"]>>) =>
		loaded?.data.strokes.map((s) => s.id) ?? [];

	it.each(TAGS)("only a -%s generation in the trash: nothing is restored", async (tag) => {
		const fake = trashOnly();
		const kept = `.handwriting/trash/X-4000-${tag}.json`;
		fake.externalWrite(kept, serializePage(pageOf("X", tag)));

		const loaded = await freshStore(fake).load("X");

		expect(restoredIds(loaded), `the -${tag} generation was restored`).toEqual([]);
		expect(fake.files.has(".handwriting/X.json"), "a live file was made from it").toBe(false);
		expect(fake.files.has(kept), "it left the trash").toBe(true);
	});

	it.each(TAGS)("a counter-numbered -%s generation is not restored either", async (tag) => {
		const fake = trashOnly();
		fake.externalWrite(`.handwriting/trash/X-4000-2-${tag}.json`, serializePage(pageOf("X", tag)));

		const loaded = await freshStore(fake).load("X");

		expect(restoredIds(loaded), `the -${tag} generation was restored`).toEqual([]);
	});

	it.each(ALL_TAGS)("an older plain generation is restored over a newer -%s one", async (tag) => {
		const fake = trashOnly();
		fake.externalWrite(".handwriting/trash/X-3000.json", serializePage(pageOf("X", "recycled")));
		fake.externalWrite(`.handwriting/trash/X-4000-${tag}.json`, serializePage(pageOf("X", tag)));

		const loaded = await freshStore(fake).load("X");

		expect(restoredIds(loaded)).toEqual(["recycled"]);
		expect(loaded?.fromInkTrash).toBe(true);
		expect(fake.files.has(`.handwriting/trash/X-4000-${tag}.json`), "the tagged generation stays in the trash").toBe(true);
	});

	it.each(TAGS)("a damaged plain generation does not open the way to a -%s one", async (tag) => {
		const fake = trashOnly();
		fake.externalWrite(".handwriting/trash/X-4000.json", "{ not a page");
		fake.externalWrite(`.handwriting/trash/X-3000-${tag}.json`, serializePage(pageOf("X", tag)));

		const loaded = await freshStore(fake).load("X");

		expect(restoredIds(loaded), `the -${tag} generation was restored`).toEqual([]);
	});

	it("end to end: a note deleted beside an interrupted save, then reopened, does not take the save back", async () => {
		const fake = new ListingAdapter();
		fake.dirs.add(".handwriting");
		fake.externalWrite(".handwriting/X.json", serializePage(pageOf("X")));
		fake.externalWrite(".handwriting/X.json.tmp", serializePage(pageOf("X", "stranded")));

		await freshStore(fake).remove("X");
		expect(
			[...fake.files.keys()].some((p) => /^\.handwriting\/trash\/X-\d+(?:-\d+)?-tmp\.json$/.test(p)),
			"precondition: the interrupted save is in the trash under its tag"
		).toBe(true);

		const loaded = await freshStore(fake).load("X");

		expect(restoredIds(loaded), "the interrupted save was restored as the page").toEqual([]);
		expect(trashedIds(fake).some((ids) => ids.includes("stranded")), "the interrupted save left the trash").toBe(true);
	});
});

/**
 * A copy `remove` set aside because another device wrote it is that note's
 * last live ink when no plain generation can be restored. It comes back,
 * newest first, through the same checks; a plain one still wins when there
 * is one that restores.
 */
describe("a -external generation restores only when no plain one does", () => {
	function trashOnly(): ListingAdapter {
		const fake = new ListingAdapter();
		fake.dirs.add(".handwriting");
		fake.dirs.add(".handwriting/trash");
		return fake;
	}
	const restoredIds = (loaded: Awaited<ReturnType<PageStore["load"]>>) =>
		loaded?.data.strokes.map((s) => s.id) ?? [];

	it("only a -external generation in the trash: it is restored", async () => {
		const fake = trashOnly();
		const kept = ".handwriting/trash/X-4000-external.json";
		fake.externalWrite(kept, serializePage(pageOf("X", "external")));

		const loaded = await freshStore(fake).load("X");

		expect(restoredIds(loaded), "the -external generation was not restored").toEqual(["external"]);
		expect(loaded?.fromInkTrash).toBe(true);
		expect(fake.files.has(kept), "it is still in the trash").toBe(false);
	});

	it("a counter-numbered -external generation is restored too", async () => {
		const fake = trashOnly();
		fake.externalWrite(".handwriting/trash/X-4000-2-external.json", serializePage(pageOf("X", "external")));

		const loaded = await freshStore(fake).load("X");

		expect(restoredIds(loaded), "the -external generation was not restored").toEqual(["external"]);
	});

	it("a damaged plain generation opens the way to a -external one", async () => {
		const fake = trashOnly();
		fake.externalWrite(".handwriting/trash/X-4000.json", "{ not a page");
		fake.externalWrite(".handwriting/trash/X-3000-external.json", serializePage(pageOf("X", "external")));

		const loaded = await freshStore(fake).load("X");

		expect(restoredIds(loaded), "the -external generation was not restored").toEqual(["external"]);
	});
});
