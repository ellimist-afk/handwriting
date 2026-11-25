/**
 * DELETING A NOTE: WHAT ITS INK FILES BECOME.
 *
 * A delete that fails partway never brings the deleted note back as a live file: once the queued page is in the trash,
 * or was judged empty, a later failure puts nothing back to be saved.
 *
 * A note deleted without being opened, then restored, opens the same ink as a note opened and then deleted: a background
 * flush's carrier beside the page is judged as load judges it, against the live bytes the delete moved to the trash.
 *
 * In-memory adapter with a folder listing, fake timers, the real PageStore.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageStore, contentStamp } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";

const LIVE = ".handwriting/X.json";
const CARRIER = ".handwriting/X.json.flush";
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

/** The vault, with the folder listing a restore needs; one rename can be made to fail. */
class VaultAdapter extends FakeAdapter {
	failRename: ((from: string, to: string) => boolean) | null = null;

	override async rename(from: string, to: string): Promise<void> {
		if (this.failRename?.(from, to)) {
			this.failRename = null;
			throw new Error(`injected failure: rename ${from} -> ${to}`);
		}
		return super.rename(from, to);
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

/** Stroke ids of every plain trash generation of X, `<id>-<stamp>[-<n>].json`. */
function plainGenerations(fake: FakeAdapter): string[][] {
	return [...fake.files]
		.filter(([p]) => p.startsWith(TRASH) && /\/X-\d+(-\d+)?\.json$/.test(p))
		.map(([, text]) => parsePage(text, "X").data.strokes.map((s) => s.id));
}

let fake: VaultAdapter;

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new VaultAdapter();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a delete that fails after the queued page was let go of", () => {
	it.each([
		{ row: "a queued page with ink", queued: ["base", "mine"], trash: [["base", "mine"]] },
		{ row: "a queued page judged empty", queued: [] as string[], trash: [] as string[][] },
	])("$row: the failure puts nothing back to be saved, and the next save writes nothing where the page lived", async ({ queued, trash }) => {
		fake.dirs.add(".handwriting");
		const base = serializePage(pageOf("base"));
		fake.externalWrite(LIVE, base);
		const store = freshStore(fake);
		await store.load("X");
		fake.failWriteTimes = 1;
		await store.saveNow("X", pageOf(...queued));
		expect(store.hasQueuedWrite("X"), "precondition: the failed save left the page queued").toBe(true);

		// The delete fails at the move of the live file into the trash, after the queued page was written there or
		// judged empty. The live file it could not move stays where it was.
		fake.failRename = (from, to) => from === LIVE && to.endsWith("-external.json");
		await store.remove("X").catch(() => undefined);
		expect(fake.failRename, "precondition: the rename of the live file failed").toBeNull();
		const afterRemove = fake.log.length;
		await store.writePending("X");

		const live = fake.files.get(LIVE);
		const liveIds = live === undefined ? null : parsePage(live, "X").data.strokes.map((s) => s.id);
		expect(liveIds, "live file still [base]").toEqual(["base"]);
		expect(live, "the live file holds the bytes the delete could not move").toBe(base);
		expect(
			fake.log.slice(afterRemove).filter((l) => l.includes(LIVE)),
			"the next save writes nothing to the live file or its .tmp",
		).toEqual([]);
		expect(store.hasQueuedWrite("X"), "nothing queued for the deleted note").toBe(false);
		expect(plainGenerations(fake), "the queued page in the trash").toEqual(trash);
	});
});

/** A background flush's carrier: the page, the bytes it was built on, and the saves in flight when it was written. */
function carrierText(page: PageData, base: string | null, inFlight: Array<string | null>): string {
	return JSON.stringify({ flushBase: base, flushInFlight: inFlight, page: JSON.parse(serializePage(page)) as unknown });
}

/** A vault holding `live` (or no live file) and `carrier` beside it; the note is deleted, opened first or not; then a fresh store opens it. */
async function restoredAfterDelete(live: string | null, carrier: string, openFirst: boolean): Promise<string[]> {
	fake = new VaultAdapter();
	fake.dirs.add(".handwriting");
	if (live !== null) fake.externalWrite(LIVE, live);
	fake.externalWrite(CARRIER, carrier);
	const store = freshStore(fake);
	if (openFirst) await store.load("X");
	await store.remove("X");
	return (await freshStore(fake).load("X"))?.data.strokes.map((s) => s.id) ?? [];
}

describe("a note deleted without being opened, then restored", () => {
	const A = serializePage(pageOf("a"));
	it.each([
		{ row: "a carrier built on the live bytes", live: A, carrier: carrierText(pageOf("a", "b"), contentStamp(A), []), want: ["a", "b"] },
		{ row: "a carrier and no live file", live: null, carrier: carrierText(pageOf("a", "b"), null, []), want: ["a", "b"] },
		{
			row: "a carrier whose save in flight landed first",
			live: A,
			carrier: carrierText(pageOf("a", "b"), "older", [contentStamp(A)]),
			want: ["a", "b"],
		},
		{
			row: "a carrier built on other bytes",
			live: serializePage(pageOf("a", "c")),
			carrier: carrierText(pageOf("a", "b"), "older", []),
			want: ["a", "c"],
		},
	])("$row: opens the same ink as opening the note and then deleting it", async ({ live, carrier, want }) => {
		const openThenDelete = await restoredAfterDelete(live, carrier, true);
		expect(openThenDelete, "precondition: opening the note and then deleting it").toEqual(want);
		const deleteUnopened = await restoredAfterDelete(live, carrier, false);
		expect(deleteUnopened, "the same ink as opening the note and then deleting it").toEqual(openThenDelete);
	});
});
