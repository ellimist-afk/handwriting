/**
 * A delete of a page says whether the page's live file left. The move of the live file into the trash can fail (a
 * sync tool or a virus scanner holding the file, a storage error on a phone); the store logs that and does not throw,
 * and the file stays live. A caller that takes a resolved delete as "the file is gone" then acts on a file that is
 * still there: a deleted PDF's ink adopted by the next copy of its bytes, or a leave forgotten with the found ink still
 * claiming the copy. So the delete answers: true when no live file is left where the page lived, false when one is
 * (or the page's newest state is queued again to be written there).
 *
 * In-memory adapter with a folder listing, fake timers, the real PageStore.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageData, emptyPage, serializePage } from "../model/PageData";

const LIVE = ".handwriting/X.json";
const TRASH = ".handwriting/trash/";
/** The page's file in the other well-known ink folder, where a delete also looks (as a load does). */
const OTHER_LIVE = "handwriting/X.json";

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

/** The vault, with a folder listing; a rename or a write can be made to fail a number of times. */
class VaultAdapter extends FakeAdapter {
	failRename: ((from: string, to: string) => boolean) | null = null;
	failRenameLeft = 0;
	failWrite: ((path: string) => boolean) | null = null;
	failWriteLeft = 0;

	override async rename(from: string, to: string): Promise<void> {
		if (this.failRenameLeft > 0 && this.failRename?.(from, to)) {
			this.failRenameLeft--;
			throw new Error(`injected failure: rename ${from} -> ${to}`);
		}
		return super.rename(from, to);
	}

	override async write(path: string, data: string): Promise<void> {
		if (this.failWriteLeft > 0 && this.failWrite?.(path)) {
			this.failWriteLeft--;
			throw new Error(`injected failure: write ${path}`);
		}
		return super.write(path, data);
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

let fake: VaultAdapter;

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new VaultAdapter();
	fake.dirs.add(".handwriting");
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** The live file X.json holds s1 and this store has read it. */
async function readPage(): Promise<PageStore> {
	fake.externalWrite(LIVE, serializePage(pageOf("s1")));
	const store = freshStore(fake);
	await store.load("X");
	return store;
}

const intoTrash = (from: string, to: string) => from === LIVE && to.startsWith(TRASH);

describe("a delete says whether the page's live file left", () => {
	it("nothing queued, the move of the live file into the trash failing once: it answers that the file is still there", async () => {
		const store = await readPage();
		fake.failRename = intoTrash;
		fake.failRenameLeft = 1;
		const left = await store.remove("X");
		expect(fake.failRenameLeft, "precondition: the move failed").toBe(0);
		expect(fake.files.has(LIVE), "precondition: the live file is still there").toBe(true);
		expect(left, "the delete said the live file left while it is still there").toBe(false);
	});

	it("a save queued, the queued page put in the trash, the move of the live file failing once: it answers that the file is still there", async () => {
		const store = await readPage();
		store.schedule("X", pageOf("s1", "s2"));
		fake.failRename = intoTrash;
		fake.failRenameLeft = 1;
		const left = await store.remove("X");
		expect(fake.failRenameLeft, "precondition: the move failed").toBe(0);
		expect(fake.files.has(LIVE), "precondition: the live file is still there").toBe(true);
		expect(store.hasQueuedWrite("X"), "precondition: nothing is queued again (the queued page is in the trash)").toBe(false);
		expect(left, "the delete said the live file left while it is still there").toBe(false);
	});

	it("a save queued with no live file yet, the queued page failing to reach the trash: it answers that the page is not gone (queued again)", async () => {
		const store = freshStore(fake);
		store.schedule("X", pageOf("s1"));
		fake.failWrite = (path) => path.startsWith(TRASH);
		fake.failWriteLeft = 1;
		const left = await store.remove("X");
		expect(fake.failWriteLeft, "precondition: the write into the trash failed").toBe(0);
		expect(store.hasQueuedWrite("X"), "precondition: the page is queued again").toBe(true);
		expect(left, "the delete said the page left while it is queued to be written again").toBe(false);
	});

	it("a second delete making the first one's waiting move, that move failing again: it answers that the file is still there", async () => {
		const store = await readPage();
		store.schedule("X", pageOf("s1", "s2"));
		fake.failRename = intoTrash;
		fake.failRenameLeft = 2;
		await store.remove("X");
		expect(fake.failRenameLeft, "precondition: the first move failed").toBe(1);
		const left = await store.remove("X");
		expect(fake.failRenameLeft, "precondition: the second delete's move failed too").toBe(0);
		expect(fake.files.has(LIVE), "precondition: the live file is still there").toBe(true);
		expect(left, "the delete said the live file left while it is still there").toBe(false);
	});

	it("the live file only in the other well-known ink folder, its move into the trash failing once: it answers that the file is still there", async () => {
		fake.dirs.add("handwriting");
		fake.externalWrite(OTHER_LIVE, serializePage(pageOf("s1")));
		const store = freshStore(fake);
		fake.failRename = (from, to) => from === OTHER_LIVE && to.includes("/trash/");
		fake.failRenameLeft = 1;
		const left = await store.remove("X");
		expect(fake.failRenameLeft, "precondition: the move failed").toBe(0);
		expect(fake.files.has(OTHER_LIVE), "precondition: the live file is still there").toBe(true);
		expect(fake.files.has(LIVE), "precondition: no file in the configured folder").toBe(false);
		expect(left, "the delete said the live file left while it is still there").toBe(false);
	});

	it("control: the live file only in the other well-known ink folder, the move lands: it answers that the file left", async () => {
		fake.dirs.add("handwriting");
		fake.externalWrite(OTHER_LIVE, serializePage(pageOf("s1")));
		const store = freshStore(fake);
		const left = await store.remove("X");
		expect(fake.files.has(OTHER_LIVE), "precondition: the live file left").toBe(false);
		expect(left, "the delete said the live file is still there after it left").toBe(true);
	});

	it("control: the move lands: it answers that the file left", async () => {
		const store = await readPage();
		const left = await store.remove("X");
		expect(fake.files.has(LIVE), "precondition: the live file left").toBe(false);
		expect(left, "the delete said the live file is still there after it left").toBe(true);
	});

	it("control: a save queued, the move lands: it answers that the file left", async () => {
		const store = await readPage();
		store.schedule("X", pageOf("s1", "s2"));
		const left = await store.remove("X");
		expect(fake.files.has(LIVE), "precondition: the live file left").toBe(false);
		expect(left, "the delete said the live file is still there after it left").toBe(true);
	});

	it("control: no live file anywhere: it answers that nothing is left", async () => {
		const store = freshStore(fake);
		const left = await store.remove("X");
		expect(left, "the delete of a page with no file said a file is still there").toBe(true);
	});

	it("control: a second delete making the first one's waiting move, that move landing: it answers that the file left", async () => {
		const store = await readPage();
		store.schedule("X", pageOf("s1", "s2"));
		fake.failRename = intoTrash;
		fake.failRenameLeft = 1;
		await store.remove("X");
		expect(fake.failRenameLeft, "precondition: the first move failed").toBe(0);
		const left = await store.remove("X");
		expect(fake.files.has(LIVE), "precondition: the live file left").toBe(false);
		expect(left, "the delete said the live file is still there after it left").toBe(true);
	});
});
