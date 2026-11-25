/**
 * A note deleted without being opened, whose ink folder holds no live file X.json, only what an earlier session left:
 * a save cut off before its rename (X.json.tmp) and a background flush's carrier (X.json.flush). Opening the note
 * would promote the .tmp and judge the carrier against it. Deleting it and then restoring it must open the same ink.
 *
 * In-memory adapter with a folder listing, fake timers, the real PageStore.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageStore, contentStamp } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";

const LIVE = ".handwriting/X.json";
const TMP = `${LIVE}.tmp`;
const CARRIER = `${LIVE}.flush`;
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

/** A carrier as a background flush writes one: the page, the bytes it was built on, and the saves then in flight. */
function carrier(page: PageData, base: string | null, inFlight: Array<string | null> = []): string {
	return JSON.stringify({ flushBase: base, flushInFlight: inFlight, page: JSON.parse(serializePage(page)) });
}

/** The vault, with the folder listing a restore needs. */
class VaultAdapter extends FakeAdapter {
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

async function settle(store: PageStore): Promise<void> {
	for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(2000);
	await store.flush();
}

const ids = (page: PageData | undefined): string[] => page?.strokes.map((s) => s.id) ?? [];

/** What the note opens: read by a store that never saw it (a restart, or another device). */
async function opens(fake: FakeAdapter): Promise<string[]> {
	return ids((await freshStore(fake).load("X"))?.data);
}

/** A copy of the vault as it is, for what opening the note without the delete would show. */
function copyOf(from: VaultAdapter): VaultAdapter {
	const to = new VaultAdapter();
	for (const [p, t] of from.files) to.files.set(p, t);
	for (const d of from.dirs) to.dirs.add(d);
	return to;
}

/** The stroke ids of every trash file of X whose name ends in `-<tag>.json`, or of every plain one with no tag. */
function inTrash(tag?: string): string[][] {
	return [...fake.files]
		.filter(([p]) => p.startsWith(TRASH) && (tag ? p.endsWith(`-${tag}.json`) : /\/X-\d+(-\d+)?\.json$/.test(p)))
		.map(([, text]) => {
			const parsed = parsePage(text, "X");
			return parsed.damaged ? ["damaged"] : ids(parsed.data);
		});
}

/** Deleted on a store that never opened it, then everything waiting runs. */
async function deleteUnopened(): Promise<void> {
	const store = freshStore(fake);
	await store.remove("X");
	await settle(store);
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

describe("a note deleted unopened, with no live ink file, a cut-off save and an older carrier beside it", () => {
	it("the restored note opens what opening it would have: the cut-off save's strokes, not the older carrier's", async () => {
		fake.externalWrite(TMP, serializePage(pageOf("s1", "s2")));
		fake.externalWrite(CARRIER, carrier(pageOf("s1"), null));
		expect(await opens(copyOf(fake)), "precondition: opening the note shows the cut-off save").toEqual(["s1", "s2"]);

		await deleteUnopened();

		expect(await opens(fake), "the restored note opens the older carrier, not the cut-off save").toEqual(["s1", "s2"]);
		expect(inTrash("flush"), "the carrier's page was lost").toEqual([["s1"]]);
	});

	it("a carrier built on the cut-off save's bytes, with a stroke more: the restored note opens the carrier's page", async () => {
		const tmpText = serializePage(pageOf("s1"));
		fake.externalWrite(TMP, tmpText);
		fake.externalWrite(CARRIER, carrier(pageOf("s1", "s2"), contentStamp(tmpText)));
		expect(await opens(copyOf(fake)), "precondition: opening the note shows the carrier").toEqual(["s1", "s2"]);

		await deleteUnopened();

		expect(await opens(fake), "the restored note does not open the carrier built on the cut-off save").toEqual(["s1", "s2"]);
	});

	it("a damaged cut-off save: the restored note opens the carrier, and the damaged bytes are kept as they were", async () => {
		const bad = '{"pageId":"X","strokes":[{"id":';
		fake.externalWrite(TMP, bad);
		fake.externalWrite(CARRIER, carrier(pageOf("s1"), null));

		await deleteUnopened();

		expect(await opens(fake), "the restored note does not open the carrier").toEqual(["s1"]);
		const kept = [...fake.files].filter(([p]) => p.startsWith(TRASH) && p.endsWith("-tmp.json")).map(([, t]) => t);
		expect(kept, "the damaged cut-off save was lost or changed").toEqual([bad]);
	});

	it("a cut-off save of another page: the restored note opens the carrier, and the other page's bytes are kept as they were", async () => {
		const other = pageOf("y1", "y2");
		other.pageId = "Y";
		const otherText = serializePage(other);
		fake.externalWrite(TMP, otherText);
		fake.externalWrite(CARRIER, carrier(pageOf("s1"), null));
		expect(await opens(copyOf(fake)), "precondition: opening the note skips the other page's save and shows the carrier").toEqual(["s1"]);

		await deleteUnopened();

		expect(await opens(fake), "the restored note does not open the carrier").toEqual(["s1"]);
		const kept = [...fake.files].filter(([p]) => p.startsWith(TRASH) && p.endsWith("-tmp.json")).map(([, t]) => t);
		expect(kept, "the other page's cut-off save was filed as this note's page, or changed").toEqual([otherText]);
	});

	it("control: a live file beside a stale cut-off save: the restored note opens the live file, the .tmp kept aside", async () => {
		fake.externalWrite(LIVE, serializePage(pageOf("s1", "s2")));
		fake.externalWrite(TMP, serializePage(pageOf("s1")));

		await deleteUnopened();

		expect(await opens(fake), "the restored note opens the stale cut-off save over the live file").toEqual(["s1", "s2"]);
		expect(inTrash("tmp"), "the stale cut-off save was lost").toEqual([["s1"]]);
	});

	it("control: a save queued at the delete is the newest: the restored note opens it, the .tmp kept aside", async () => {
		fake.externalWrite(TMP, serializePage(pageOf("s1", "s2")));
		fake.externalWrite(CARRIER, carrier(pageOf("s1"), null));
		const store = freshStore(fake);
		store.schedule("X", pageOf("s1", "s2", "s3"));

		await store.remove("X");
		await settle(store);

		expect(await opens(fake), "the restored note does not open the queued page").toEqual(["s1", "s2", "s3"]);
		expect(inTrash("tmp"), "the cut-off save was lost, or filed as a page a restore opens").toEqual([["s1", "s2"]]);
	});

	it("control: the cut-off save in the other ink folder only: the restored note opens it, as opening the note would", async () => {
		fake.dirs.add("handwriting");
		fake.externalWrite("handwriting/X.json.tmp", serializePage(pageOf("s1", "s2")));
		fake.externalWrite(CARRIER, carrier(pageOf("s1"), null));
		expect(await opens(copyOf(fake)), "precondition: opening the note shows the cut-off save").toEqual(["s1", "s2"]);

		await deleteUnopened();

		expect(await opens(fake), "the restored note does not open the cut-off save").toEqual(["s1", "s2"]);
	});
});
