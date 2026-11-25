/**
 * A note deleted while a save of its ink is still queued: the queued page goes to the trash as the newest generation,
 * then the live file is moved there too. When that move fails (a sync tool or a virus scanner holding the file, a
 * storage error on a phone), the restored note must still open the newest page, not the older live file. The move is
 * tried again only while the live file is the bytes the failed move found; a second delete in that wait makes the move
 * itself, as the try would, and never files the live file as the newest page.
 *
 * In-memory adapter with a folder listing, fake timers, the real PageStore.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { PageStore, WRITE_ATTEMPTS, WRITE_RETRY_MS } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";

const LIVE = ".handwriting/X.json";
const TRASH = ".handwriting/trash/";

function pageOf(...labels: string[]): PageData {
	const p = emptyPage("X");
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

/** The vault, with the folder listing a restore needs; a rename can be made to fail a number of times. */
class VaultAdapter extends FakeAdapter {
	failRename: ((from: string, to: string) => boolean) | null = null;
	failRenameLeft = 0;

	override async rename(from: string, to: string): Promise<void> {
		if (this.failRenameLeft > 0 && this.failRename?.(from, to)) {
			this.failRenameLeft--;
			throw new Error(`injected failure: rename ${from} -> ${to}`);
		}
		return super.rename(from, to);
	}

	/** A read of one path can be made to fail a number of times. */
	failRead: ((path: string) => boolean) | null = null;
	failReadLeft = 0;

	override async read(path: string): Promise<string> {
		if (this.failReadLeft > 0 && this.failRead?.(path)) {
			this.failReadLeft--;
			throw new Error(`injected failure: read ${path}`);
		}
		return super.read(path);
	}

	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = path.endsWith("/") ? path : `${path}/`;
		const files = [...this.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"));
		if (files.length === 0 && !this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
		return { files, folders: [] };
	}
}

function freshStore(fake: FakeAdapter): PageStore {
	return new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5000);
}

/** Everything the store has waiting runs: its timers, its retries, its queue. */
async function settle(store: PageStore): Promise<void> {
	for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(2000);
	await store.flush();
	for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2000);
}

/** What the note opens once it is restored, read by a store that never saw it (a restart, or another device). */
async function restored(fake: FakeAdapter): Promise<string[]> {
	const r = await freshStore(fake).load("X");
	return r?.data.strokes.map((s) => s.id) ?? [];
}

let fake: VaultAdapter;

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new VaultAdapter();
	fake.dirs.add(".handwriting");
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a delete with a save queued, whose move of the live file into the trash fails once", () => {
	it("the restored note opens the newest page: the strokes drawn just before the delete are there", async () => {
		fake.externalWrite(LIVE, serializePage(pageOf("s1")));
		const store = freshStore(fake);
		await store.load("X");
		store.schedule("X", pageOf("s1", "s2"));
		expect(store.hasQueuedWrite("X"), "precondition: the newest page is queued").toBe(true);
		fake.failRename = (from, to) => from === LIVE && to.startsWith(TRASH);
		fake.failRenameLeft = 1;

		await store.remove("X");
		await settle(store);

		expect(fake.failRenameLeft, "precondition: the move of the live file failed").toBe(0);
		expect(await restored(fake), "the restored note opens the older live file, not the newest page").toEqual(["s1", "s2"]);
	});

	it("the newest page is in the trash, whole, wherever the restore finds it", async () => {
		fake.externalWrite(LIVE, serializePage(pageOf("s1")));
		const store = freshStore(fake);
		await store.load("X");
		store.schedule("X", pageOf("s1", "s2"));
		fake.failRename = (from, to) => from === LIVE && to.startsWith(TRASH);
		fake.failRenameLeft = 1;

		await store.remove("X");
		await settle(store);

		const pages = [...fake.files]
			.filter(([p]) => p === LIVE || p.startsWith(TRASH))
			.map(([, text]) => parsePage(text, "X").data.strokes.map((s) => s.id).join(","));
		expect(pages, "the newest page was lost").toContain("s1,s2");
	});
});

/** Stroke ids of every plain trash generation of X, `<id>-<stamp>[-<n>].json`: the ones a restore can open. */
function plainGenerations(fake: FakeAdapter): string[][] {
	return [...fake.files]
		.filter(([p]) => p.startsWith(TRASH) && /\/X-\d+(-\d+)?\.json$/.test(p))
		.map(([, text]) => parsePage(text, "X").data.strokes.map((s) => s.id));
}

/** The stroke ids of every trash file of X whose name ends in `-<tag>.json`. */
function tagged(tag: string): string[][] {
	return [...fake.files]
		.filter(([p]) => p.startsWith(TRASH) && p.endsWith(`-${tag}.json`))
		.map(([, text]) => parsePage(text, "X").data.strokes.map((s) => s.id));
}

/** The live file X.json holds s1 and is read; the page with s1 and s2 is queued; the move of the live file fails `times`. */
async function deletedWithMoveFailing(times: number): Promise<{ store: PageStore; base: string }> {
	const base = serializePage(pageOf("s1"));
	fake.externalWrite(LIVE, base);
	const store = freshStore(fake);
	await store.load("X");
	store.schedule("X", pageOf("s1", "s2"));
	fake.failRename = (from, to) => from === LIVE && to.startsWith(TRASH);
	fake.failRenameLeft = times;
	await store.remove("X");
	expect(fake.failRenameLeft, "precondition: the move of the live file failed").toBe(times - 1);
	return { store, base };
}

describe("a delete whose move of the live file failed tries it again, and moves only what is still the delete's", () => {
	it("a .tmp an earlier save left beside the live file goes to the trash once the move lands; the restore opens the newest page", async () => {
		fake.externalWrite(`${LIVE}.tmp`, serializePage(pageOf("t1")));
		const { store } = await deletedWithMoveFailing(1);

		await settle(store);

		expect(fake.files.has(`${LIVE}.tmp`), "the .tmp stayed where the page lived").toBe(false);
		expect(await restored(fake), "the restored note opens the .tmp or the older live file, not the newest page").toEqual(["s1", "s2"]);
		expect(tagged("tmp"), "the .tmp's page was lost").toEqual([["t1"]]);
	});

	it("another device's revision, synced in before the delete, is kept in the trash under its own tag; the restore opens the queued page", async () => {
		fake.externalWrite(LIVE, serializePage(pageOf("s1")));
		const store = freshStore(fake);
		await store.load("X");
		store.schedule("X", pageOf("s1", "s2"));
		fake.externalWrite(LIVE, serializePage(pageOf("s1", "r1")));
		fake.failRename = (from, to) => from === LIVE && to.startsWith(TRASH);
		fake.failRenameLeft = 1;
		await store.remove("X");
		expect(fake.failRenameLeft, "precondition: the move of the live file failed").toBe(0);

		await settle(store);

		expect(fake.files.has(LIVE), "the other device's revision is still live for the deleted note").toBe(false);
		expect(tagged("external"), "the other device's revision was lost, or kept as a page the restore opens").toEqual([["s1", "r1"]]);
		expect(await restored(fake), "the restored note does not open the queued page").toEqual(["s1", "s2"]);
	});

	it("the note opened again before the next try: its live file stays where it is, and nothing is moved after", async () => {
		const { store, base } = await deletedWithMoveFailing(1);

		const opened = await store.load("X");
		await settle(store);

		expect(opened?.data.strokes.map((s) => s.id), "precondition: the note opened the live file").toEqual(["s1"]);
		expect(fake.files.get(LIVE), "the live file of a note opened again was moved").toBe(base);
		expect(tagged("external"), "a later try moved the live file of a note opened again").toEqual([]);
	});

	it("a save under the id after the delete, before the next try (the note back and drawn on): it lands live, and nothing is moved after", async () => {
		const { store } = await deletedWithMoveFailing(1);

		store.schedule("X", pageOf("s1", "s2", "s3"));
		await settle(store);

		const live = fake.files.get(LIVE);
		expect(live === undefined ? null : parsePage(live, "X").data.strokes.map((s) => s.id), "the save did not land live").toEqual(["s1", "s2", "s3"]);
		expect(tagged("external"), "a later try moved the live file a save wrote").toEqual([]);
	});

	it("every try fails: nothing is said, the live file stays as it was, and the newest page stays in the trash", async () => {
		const { store, base } = await deletedWithMoveFailing(99);
		const told: string[] = [];
		store.onWriteError = (_id, problem) => {
			told.push(problem);
		};

		await settle(store);

		expect(99 - fake.failRenameLeft, "the move was tried more often than a write is").toBeLessThanOrEqual(WRITE_ATTEMPTS);
		expect(told, "the user was told").toEqual([]);
		expect(fake.files.get(LIVE), "the live file changed").toBe(base);
		expect(plainGenerations(fake), "the newest page left the trash").toEqual([["s1", "s2"]]);
		expect(store.hasQueuedWrite("X"), "something was queued for the deleted note").toBe(false);
	});

	it("the move fails on every try but the last a write gets: that last try lands, and the restore opens the newest page", async () => {
		const { store } = await deletedWithMoveFailing(WRITE_ATTEMPTS - 1);

		await settle(store);

		expect(fake.failRenameLeft, "precondition: every try but the last failed").toBe(0);
		expect(fake.files.has(LIVE), "the last try a write gets did not run, or did not move the live file").toBe(false);
		expect(await restored(fake), "the restored note opens the older live file, not the newest page").toEqual(["s1", "s2"]);
	});

	it("a try still waiting when the plugin unloads never runs: the live file stays", async () => {
		const { store, base } = await deletedWithMoveFailing(1);
		const plugin = Object.assign(Object.create(HandwritingPlugin.prototype) as object, { store }) as HandwritingPlugin;

		try {
			plugin.onunload();
		} catch {
			// A bare plugin lacks what later steps of the unload read; the store's step comes before them.
		}
		await settle(store);

		expect(fake.files.get(LIVE), "a try ran after the unload and moved the live file").toBe(base);
	});
});

const liveIds = (): string[] | null => {
	const live = fake.files.get(LIVE);
	return live === undefined ? null : parsePage(live, "X").data.strokes.map((s) => s.id);
};

describe("a try again moves the live file only while it is the bytes the failed move found", () => {
	it("another device's revision lands after the delete, before the next try: it stays live, as one landing after a move that worked does", async () => {
		const { store } = await deletedWithMoveFailing(1);

		fake.externalWrite(LIVE, serializePage(pageOf("s1", "r2")));
		await settle(store);

		expect(liveIds(), "the revision that landed after the delete was moved by the next try").toEqual(["s1", "r2"]);
		expect(tagged("external"), "the next try moved a revision that landed after the delete").toEqual([]);
	});

	it("control: the same revision landing after a move that worked stays live", async () => {
		fake.externalWrite(LIVE, serializePage(pageOf("s1")));
		const store = freshStore(fake);
		await store.load("X");
		store.schedule("X", pageOf("s1", "s2"));
		await store.remove("X");
		await settle(store);

		fake.externalWrite(LIVE, serializePage(pageOf("s1", "r2")));
		await settle(store);

		expect(liveIds(), "control: a revision after a landed move did not stay live").toEqual(["s1", "r2"]);
	});

	it("the read just after the failed move fails: the next try moves what is there, as the delete would, so a revision synced in before the delete is kept under its own tag", async () => {
		fake.externalWrite(LIVE, serializePage(pageOf("s1")));
		const store = freshStore(fake);
		await store.load("X");
		store.schedule("X", pageOf("s1", "s2"));
		fake.externalWrite(LIVE, serializePage(pageOf("s1", "r1")));
		fake.failRename = (from, to) => from === LIVE && to.startsWith(TRASH);
		fake.failRenameLeft = 1;
		fake.failRead = (path) => path === LIVE;
		fake.failReadLeft = 1;
		await store.remove("X");
		expect(fake.failRenameLeft, "precondition: the move of the live file failed").toBe(0);

		await settle(store);

		expect(fake.files.has(LIVE), "the revision synced in before the delete is still live for the deleted note").toBe(false);
		expect(tagged("external"), "the revision was lost, or filed as a page the restore opens").toEqual([["s1", "r1"]]);
		expect(await restored(fake), "the restored note does not open the queued page").toEqual(["s1", "s2"]);
		expect(fake.failReadLeft, "precondition: the read of the live file just after the failed move failed").toBe(0);
	});

	it("a try that cannot read the live file moves nothing and counts as a try; a later one that reads the same bytes makes the move", async () => {
		const { store, base } = await deletedWithMoveFailing(1);
		fake.failRead = (path) => path === LIVE;
		fake.failReadLeft = 1;

		// The next try only: the one after it waits another WRITE_RETRY_MS.
		await vi.advanceTimersByTimeAsync(WRITE_RETRY_MS);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(100);
		expect(fake.files.get(LIVE), "a try moved bytes it could not read").toBe(base);
		expect(fake.failReadLeft, "precondition: the next try read the live file, and the read failed").toBe(0);

		await settle(store);

		expect(fake.files.has(LIVE), "a try that could not read the live file ended the tries: the live file stayed").toBe(false);
		expect(await restored(fake), "the restored note opens the older live file, not the newest page").toEqual(["s1", "s2"]);
	});
});

describe("a second delete of the page while the first one's move still waits makes that move, never filing the live file as the newest page", () => {
	it("the second delete before the next try: the restore opens the newest page, and the live file goes", async () => {
		const { store } = await deletedWithMoveFailing(1);

		await store.remove("X");
		await settle(store);

		expect(fake.files.has(LIVE), "the live file is still there for the deleted note").toBe(false);
		// Read before the restore, which takes the generation it opens out of the trash.
		expect(plainGenerations(fake), "the older live file was filed as a page the restore opens").toEqual([["s1", "s2"]]);
		expect(await restored(fake), "the restored note opens the older live file, not the newest page").toEqual(["s1", "s2"]);
	});

	it("a revision landed before the second delete: it is kept under its own tag, and the restore opens the newest page", async () => {
		const { store } = await deletedWithMoveFailing(1);
		fake.externalWrite(LIVE, serializePage(pageOf("s1", "r2")));

		await store.remove("X");
		await settle(store);

		expect(fake.files.has(LIVE), "the revision is still live for the deleted note").toBe(false);
		expect(tagged("external"), "the revision was lost, or filed as a page the restore opens").toEqual([["s1", "r2"]]);
		expect(await restored(fake), "the restored note does not open the newest page").toEqual(["s1", "s2"]);
	});

	it("the second delete's move fails too, then another device's revision lands before the next try: it stays live, as one landing after a move that worked does", async () => {
		const { store } = await deletedWithMoveFailing(2);

		await store.remove("X");
		expect(fake.failRenameLeft, "precondition: the second delete's move of the live file failed").toBe(0);
		fake.externalWrite(LIVE, serializePage(pageOf("s1", "r2")));
		await settle(store);

		expect(liveIds(), "the revision that landed after the second delete's failed move was moved by the next try").toEqual(["s1", "r2"]);
		expect(tagged("external"), "the next try moved a revision that landed after the second delete's failed move").toEqual([]);
	});

	it("control: the second delete with no failed move first: the restore opens the newest page", async () => {
		fake.externalWrite(LIVE, serializePage(pageOf("s1")));
		const store = freshStore(fake);
		await store.load("X");
		store.schedule("X", pageOf("s1", "s2"));
		await store.remove("X");
		await store.remove("X");
		await settle(store);

		expect(plainGenerations(fake), "control: the trash holds another page a restore opens").toEqual([["s1", "s2"]]);
		expect(await restored(fake), "control: the restored note does not open the newest page").toEqual(["s1", "s2"]);
	});

	it("two deletes asked for together, the first one's move failing: the second makes that move, and the restore opens the newest page", async () => {
		fake.externalWrite(LIVE, serializePage(pageOf("s1")));
		const store = freshStore(fake);
		await store.load("X");
		store.schedule("X", pageOf("s1", "s2"));
		fake.failRename = (from, to) => from === LIVE && to.startsWith(TRASH);
		fake.failRenameLeft = 1;

		await Promise.all([store.remove("X"), store.remove("X")]);
		await settle(store);

		expect(fake.failRenameLeft, "precondition: the move of the live file failed").toBe(0);
		expect(fake.files.has(LIVE), "the live file is still there for the deleted note").toBe(false);
		expect(plainGenerations(fake), "the older live file was filed as a page the restore opens").toEqual([["s1", "s2"]]);
		expect(await restored(fake), "the restored note opens the older live file, not the newest page").toEqual(["s1", "s2"]);
	});

	it("every try fails, a second delete among them: the move is tried no more often than a write is", async () => {
		const { store, base } = await deletedWithMoveFailing(99);

		await store.remove("X");
		await settle(store);

		expect(99 - fake.failRenameLeft, "the move was tried more often than a write is").toBeLessThanOrEqual(WRITE_ATTEMPTS);
		expect(fake.files.get(LIVE), "the live file changed").toBe(base);
		expect(plainGenerations(fake), "the newest page left the trash, or another page a restore opens joined it").toEqual([["s1", "s2"]]);
	});

	it("a .tmp an earlier save left beside the live file goes to the trash with the move the second delete makes", async () => {
		fake.externalWrite(`${LIVE}.tmp`, serializePage(pageOf("t1")));
		const { store } = await deletedWithMoveFailing(1);

		await store.remove("X");
		await settle(store);

		expect(fake.files.has(`${LIVE}.tmp`), "the .tmp stayed where the page lived").toBe(false);
		expect(tagged("tmp"), "the .tmp's page was lost, or filed as a page the restore opens").toEqual([["t1"]]);
		expect(plainGenerations(fake), "the older live file was filed as a page the restore opens").toEqual([["s1", "s2"]]);
		expect(await restored(fake), "the restored note opens the older live file or the .tmp, not the newest page").toEqual(["s1", "s2"]);
	});
});
