/**
 * A sidecar read that THROWS is not damage (2026-09-27).
 *
 * User report: on Obsidian start a healthy note showed "Handwriting cannot read
 * the saved ink for this note" and stopped saving it. PageStore.load's outer
 * catch reported every throw - a failed adapter.read included - as a damaged
 * payload, and InlineInkStore armed the save lock and the notice on that flag.
 * Nothing then lifted the lock without a reopen: the live-reload poll never
 * watched a page it had not read cleanly (no known mtime), and adoptExternal
 * refused a damaged record outright. Ink drawn after the notice was lost on
 * quit even once the file was healthy again.
 *
 * The rule:
 *  (a) a thrown read is transient: no notice, no write, presence "unknown",
 *      retried on the next poll or reload. Silence is bounded: the first stroke
 *      on the note, or 60 s of reads that keep throwing, gives one plain notice.
 *  (b) a damaged lock keeps polling the file; a clean read heals the note and
 *      saves the ink drawn while it was locked.
 *  A payload that was read and does not parse (A), decodes lossy (B), or a bad
 *  .tmp with no live file (D) is still damage, with the existing notice.
 *
 * The real InlineInkStore over the real PageStore over an in-memory adapter,
 * driven by the production live-reload poll extracted from main.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
	Notice: class {},
}));

import { installLiveReloadPoll } from "./testUtils/LiveReloadTestHarness";
import { PageStore, type PreparedExternalAdoption } from "./persistence/PageStore";
import { FakeAdapter } from "./persistence/FakeAdapter";
import { InlineInkStore } from "./inline/InlineInkStore";
import { PageData, emptyPage, parsePage, serializePage } from "./model/PageData";
import { InkStroke } from "./ink/Stroke";

const PATH = "note.md";
const PAGE_ID = "p1";
const LIVE = ".handwriting/p1.json";
const TMP = ".handwriting/p1.json.tmp";

const DAMAGE_TEXT = "Handwriting cannot read the saved ink for this note";
const TRANSIENT_TEXT =
	"Handwriting: this note's ink file could not be read yet. New ink on it is not saved until it loads.";
const HEALED_TEXT = "is readable again";

/** A FakeAdapter whose reads of chosen paths throw, as a sync client or cloud placeholder can make them. */
class FlakyAdapter extends FakeAdapter {
	/** Reads of LIVE that will throw; Infinity keeps throwing. */
	failLiveReads = 0;
	liveReads = 0;
	/** Served in place of the file's bytes for this many LIVE reads (after the throws). */
	servedInstead: string[] = [];

	async read(path: string): Promise<string> {
		if (path === LIVE) {
			this.liveReads++;
			if (this.failLiveReads > 0) {
				this.failLiveReads--;
				throw new Error("EIO injected read (sync in progress)");
			}
			const next = this.servedInstead.shift();
			if (next !== undefined) return next;
		}
		return super.read(path);
	}
}

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 0 },
		createdAt: 0,
	} as InkStroke;
}

function pageWith(...ids: string[]): PageData {
	const p = emptyPage(PAGE_ID);
	p.surface = "inline";
	p.strokes = ids.map(stroke);
	return p;
}

/** Path B: the JSON parses, one point does not decode (a NaN written by JSON.stringify as null). */
const LOSSY = JSON.stringify({
	schemaVersion: 1,
	pageId: PAGE_ID,
	surface: "inline",
	textBoxes: [],
	images: [],
	strokes: [
		{ id: "s1", tool: "pen", color: "#000000", width: 2, createdAt: 0, pts: [null, 0, 0.5, 0, 10, 0, 0.5, 8] },
	],
});
const TRUNCATED = serializePage(pageWith("s1")).slice(0, 40);

let fake: FlakyAdapter;
let store: PageStore;
let inlineInk: InlineInkStore;
let shown: string[];
let fireTick!: () => void;
let pending: Promise<void> = Promise.resolve();
let pollErrors: unknown[][];

function boot(files: Record<string, string>): void {
	fake = new FlakyAdapter();
	for (const [path, text] of Object.entries(files)) fake.externalWrite(path, text);
	store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
	inlineInk = new InlineInkStore();
	inlineInk.attachHost({
		readPageId: (path: string) => (path === PATH ? PAGE_ID : null),
		claimId: async (_path: string, proposedId: string) => ({ pageId: proposedId }),
		loadSidecar: (pageId: string) => store.load(pageId),
		scheduleSidecar: (pageId: string, page: PageData) => store.schedule(pageId, page),
		scheduleSidecarNow: (pageId: string, page: PageData) => store.saveNow(pageId, page),
		prepareExternalAdoption: (pageId: string, outgoing: PageData) =>
			store.prepareExternalAdoption(pageId, outgoing),
		acceptExternalAdoption: (prepared: PreparedExternalAdoption) => store.acceptExternalAdoption(prepared),
		sidecarChanged: (pageId: string) => store.externallyChanged(pageId),
		notify: (message: string) => {
			shown.push(message);
		},
	} as never);
	const host = {
		store,
		pdfInk: new Map(),
		pdfIds: new Map(),
		pollStats: { ticks: 0, hidden: 0, spaced: 0, checks: 0 },
		registerInterval(handle: number) {
			return handle;
		},
	};
	installLiveReloadPoll.call(
		host,
		{
			setInterval(fn: () => void) {
				fireTick = fn;
				return 1;
			},
		},
		{ hidden: false },
		(promise: Promise<void>) => {
			pending = promise.catch((e: unknown) => {
				pollErrors.push([e]);
			});
		},
		() => [PATH],
		inlineInk,
		() => {},
		() => {},
		() => null,
		async () => false,
		{ error: (...args: unknown[]) => pollErrors.push(args) },
		() => () => true
	);
}

/** One poll tick per simulated second, `seconds` times. */
async function pollFor(seconds: number): Promise<void> {
	for (let i = 0; i < seconds; i++) {
		await vi.advanceTimersByTimeAsync(1000);
		fireTick();
		await pending;
		await vi.advanceTimersByTimeAsync(0);
	}
}

function ids(): string[] {
	return inlineInk.strokes(PATH).map((s) => s.id);
}

function onDisk(): string[] {
	const text = fake.files.get(LIVE);
	return text === undefined ? [] : parsePage(text, PAGE_ID).data.strokes.map((s) => s.id);
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	vi.spyOn(console, "error").mockImplementation(() => {});
	shown = [];
	pollErrors = [];
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("a thrown read at start is transient, not damage", () => {
	it("cell 1: a read that throws once at start gives no notice, no write, presence unknown", async () => {
		boot({ [LIVE]: serializePage(pageWith("s1")) });
		const bytes = fake.files.get(LIVE);
		fake.failLiveReads = 1;
		await inlineInk.ensureLoaded(PATH);
		expect(shown).toEqual([]);
		expect(inlineInk.inkPresence(PATH)).toBe("unknown");
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fake.writes()).toEqual([]);
		expect(fake.files.get(LIVE)).toBe(bytes);
	});

	it("cell 2: reads that keep throwing never write, whatever the user draws", async () => {
		boot({ [LIVE]: serializePage(pageWith("s1")) });
		const bytes = fake.files.get(LIVE);
		fake.failLiveReads = Infinity;
		await inlineInk.ensureLoaded(PATH);
		inlineInk.commit(PATH, stroke("s9"));
		await pollFor(20);
		inlineInk.commit(PATH, stroke("late"));
		await pollFor(20);
		expect(fake.writes()).toEqual([]);
		expect(fake.files.get(LIVE)).toBe(bytes);
	});

	it("cell 3: once the file reads, the poll loads it with no reopen and says nothing", async () => {
		boot({ [LIVE]: serializePage(pageWith("s1")) });
		fake.failLiveReads = 1;
		await inlineInk.ensureLoaded(PATH);
		expect(ids()).toEqual([]);
		await pollFor(10);
		expect(ids()).toEqual(["s1"]);
		expect(inlineInk.isDamagedLocked(PATH)).toBe(false);
		expect(shown).toEqual([]);
		expect(pollErrors).toEqual([]);
	});

	it("cell 7: a throw, then a payload that does not parse: the damage notice comes at the second read, not the first", async () => {
		boot({ [LIVE]: serializePage(pageWith("s1")) });
		fake.failLiveReads = 1;
		await inlineInk.ensureLoaded(PATH);
		expect(shown).toEqual([]);
		fake.externalWrite(LIVE, TRUNCATED);
		await pollFor(10);
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain(DAMAGE_TEXT);
		expect(inlineInk.isDamagedLocked(PATH)).toBe(true);
	});
});

describe("transient silence is bounded", () => {
	it("cell 10: the first stroke on a transient note gives the plain notice once, and writes nothing", async () => {
		boot({ [LIVE]: serializePage(pageWith("s1")) });
		const bytes = fake.files.get(LIVE);
		fake.failLiveReads = Infinity;
		await inlineInk.ensureLoaded(PATH);
		expect(shown).toEqual([]);
		inlineInk.commit(PATH, stroke("s9"));
		await vi.advanceTimersByTimeAsync(0);
		expect(shown).toEqual([TRANSIENT_TEXT]);
		inlineInk.commit(PATH, stroke("late"));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(shown).toEqual([TRANSIENT_TEXT]);
		expect(fake.writes()).toEqual([]);
		expect(fake.files.get(LIVE)).toBe(bytes);
	});

	it("cell 10b: after that notice, a clean read heals, says so, and saves the saved ink plus the new ink", async () => {
		boot({ [LIVE]: serializePage(pageWith("s1")) });
		fake.failLiveReads = Infinity;
		await inlineInk.ensureLoaded(PATH);
		inlineInk.commit(PATH, stroke("s9"));
		await vi.advanceTimersByTimeAsync(0);
		fake.failLiveReads = 0;
		await pollFor(10);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(ids()).toEqual(["s1", "s9"]);
		expect(onDisk()).toEqual(["s1", "s9"]);
		expect(shown).toHaveLength(2);
		expect(shown[0]).toBe(TRANSIENT_TEXT);
		expect(shown[1]).toContain(HEALED_TEXT);
	});

	it("cell 11: reads that throw for 60 s of polling give the plain notice once, not before 60 s, not twice", async () => {
		boot({ [LIVE]: serializePage(pageWith("s1")) });
		fake.failLiveReads = Infinity;
		await inlineInk.ensureLoaded(PATH);
		await pollFor(50);
		expect(shown).toEqual([]);
		await pollFor(20);
		expect(shown).toEqual([TRANSIENT_TEXT]);
		await pollFor(60);
		expect(shown).toEqual([TRANSIENT_TEXT]);
		expect(fake.writes()).toEqual([]);
	});
});

describe("a damaged lock keeps polling and heals", () => {
	it("cell 4: real damage, ink drawn, file replaced by a clean copy, no reopen: healed and saved", async () => {
		boot({ [LIVE]: TRUNCATED });
		await inlineInk.ensureLoaded(PATH);
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain(DAMAGE_TEXT);
		inlineInk.commit(PATH, stroke("s9"));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fake.writes()).toEqual([]);
		fake.externalWrite(LIVE, serializePage(pageWith("s1")));
		await pollFor(10);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(inlineInk.isDamagedLocked(PATH)).toBe(false);
		expect(ids()).toEqual(["s1", "s9"]);
		expect(onDisk()).toEqual(["s1", "s9"]);
		expect(shown).toHaveLength(2);
		expect(shown[1]).toContain(HEALED_TEXT);
	});

	it("cell 5: the same bad bytes on every tick stay locked, one notice, at most one read per 5 s", async () => {
		boot({ [LIVE]: TRUNCATED });
		await inlineInk.ensureLoaded(PATH);
		const readsAfterLoad = fake.liveReads;
		await pollFor(30);
		expect(inlineInk.isDamagedLocked(PATH)).toBe(true);
		expect(shown).toHaveLength(1);
		expect(fake.liveReads - readsAfterLoad).toBeLessThanOrEqual(7);
		expect(fake.writes()).toEqual([]);
	});
});

describe("real damage is unchanged", () => {
	it.each([
		["A, truncated JSON", { [LIVE]: TRUNCATED }, LIVE],
		["A, 0-byte file", { [LIVE]: "" }, LIVE],
		["B, a point that does not decode", { [LIVE]: LOSSY }, LIVE],
		["D, a bad .tmp and no live file", { [TMP]: TRUNCATED }, TMP],
	])("cell 6: %s locks and gives the damage notice naming the file", async (_name, files, named) => {
		boot(files);
		await inlineInk.ensureLoaded(PATH);
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain(`${DAMAGE_TEXT} (${named}).`);
		expect(inlineInk.isDamagedLocked(PATH)).toBe(true);
		inlineInk.commit(PATH, stroke("s9"));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fake.writes()).toEqual([]);
	});
});

describe("the PDF and Slides side effect stays visible", () => {
	it("cell 8: a damaged page reports changed when its bytes change, and the store writes nothing", async () => {
		boot({ ".handwriting/pdf1.json": TRUNCATED });
		const loaded = await store.load("pdf1");
		expect(loaded?.damaged).toBe(true);
		expect(await store.externallyChanged("pdf1")).toBe(false);
		fake.externalWrite(".handwriting/pdf1.json", TRUNCATED + "x");
		await vi.advanceTimersByTimeAsync(6000);
		expect(await store.externallyChanged("pdf1")).toBe(true);
		expect(fake.writes()).toEqual([]);
	});
});
