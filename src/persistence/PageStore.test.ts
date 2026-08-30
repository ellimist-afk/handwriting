/**
 * Failure-injection suite for the sidecar store (v0.13.6 permanence pass).
 *
 * The properties under test are the release-blocking invariants:
 *   - disk state only moves FORWARD (an older in-flight save can never
 *     overwrite a newer one),
 *   - a failed write is never treated as durable (state stays queued,
 *     bounded event-driven retries, then a user-visible error),
 *   - unreadable payloads come back DAMAGED, never as an innocent empty
 *     page that would then be written back,
 *   - an externally-changed sidecar is preserved, not clobbered,
 *   - deleting a note recycles its ink beside it instead of destroying it.
 *
 * Boundary stated honestly: none of this can prove OS-level crash
 * durability. The tmp-write → rename dance plus the .tmp recovery path in
 * load() is the strongest guarantee available above the adapter, and what
 * the adapter itself guarantees is Obsidian/OS territory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore } from "./PageStore";
import { PageData, emptyPage, parsePage } from "../model/PageData";

// ---- fake filesystem --------------------------------------------------------

class FakeAdapter {
	files = new Map<string, string>();
	mtimes = new Map<string, number>();
	dirs = new Set<string>();
	clock = 1000;
	failWriteTimes = 0;
	writeDelay: Promise<void> | null = null;
	log: string[] = [];

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.dirs.has(path);
	}
	async read(path: string): Promise<string> {
		const f = this.files.get(path);
		if (f === undefined) throw new Error(`ENOENT ${path}`);
		return f;
	}
	async write(path: string, data: string): Promise<void> {
		if (this.writeDelay) await this.writeDelay;
		if (this.failWriteTimes > 0) {
			this.failWriteTimes--;
			throw new Error("EIO injected");
		}
		this.files.set(path, data);
		this.mtimes.set(path, ++this.clock);
		this.log.push(`write ${path}`);
	}
	async rename(from: string, to: string): Promise<void> {
		const f = this.files.get(from);
		if (f === undefined) throw new Error(`ENOENT ${from}`);
		this.files.delete(from);
		this.files.set(to, f);
		this.mtimes.set(to, this.mtimes.get(from) ?? ++this.clock);
		this.mtimes.delete(from);
		this.log.push(`rename ${from} -> ${to}`);
	}
	async remove(path: string): Promise<void> {
		this.files.delete(path);
		this.mtimes.delete(path);
	}
	async mkdir(path: string): Promise<void> {
		this.dirs.add(path);
	}
	async stat(path: string): Promise<{ mtime: number } | null> {
		return this.files.has(path) ? { mtime: this.mtimes.get(path)! } : null;
	}
	/** Simulate an external process/sync replacing a file. */
	externalWrite(path: string, data: string): void {
		this.files.set(path, data);
		this.mtimes.set(path, ++this.clock);
	}
	/**
	 * The nasty variant: replace the content WITHOUT the mtime moving —
	 * coarse filesystem stamps, or a sync tool that preserves mtimes.
	 */
	externalWriteSameMtime(path: string, data: string): void {
		this.files.set(path, data);
	}
}

function pageWith(id: string, label: string): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = [
		{
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
		},
	];
	return p;
}

let fake: FakeAdapter;
let store: PageStore;
/** Trash stamp source; tests move it to force collisions (RC4). */
let trashClock = 5_000_000;

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	trashClock = 5_000_000;
	store = new PageStore({ vault: { adapter: fake } }, ".handwriting", () => trashClock);
});

/**
 * Every trash generation for a page, oldest name first (RC4). Before RC4 the
 * trash was one fixed slot per id and tests could name it directly; now the
 * NAME is deliberately unpredictable and the invariant is about generations
 * surviving, so the tests ask which ones exist.
 */
function trashGenerations(pageId: string): string[] {
	return [...fake.files.keys()]
		.filter((p) => p.startsWith(`.handwriting/trash/${pageId}-`) && p.endsWith(".json"))
		.sort();
}

/** The contents of every trash generation for a page. */
function trashContents(pageId: string): string[] {
	return trashGenerations(pageId).map((p) => fake.files.get(p) ?? "");
}

afterEach(() => {
	vi.useRealTimers();
});

async function settle(): Promise<void> {
	// Run debounce/retry timers and drain the promise chain.
	for (let i = 0; i < 8; i++) {
		await vi.advanceTimersByTimeAsync(2000);
	}
}

describe("save ordering — disk state only moves forward", () => {
	it("rapid sequential strokes collapse to one write of the NEWEST state", async () => {
		store.schedule("p1", pageWith("p1", "s1"));
		store.schedule("p1", pageWith("p1", "s2"));
		store.schedule("p1", pageWith("p1", "s3"));
		await settle();
		const writes = fake.log.filter((l) => l.startsWith("write .handwriting/p1.json.tmp"));
		expect(writes.length).toBe(1);
		expect(fake.files.get(".handwriting/p1.json")).toContain("s3");
	});

	it("a deliberately DELAYED older save cannot overwrite a newer one", async () => {
		// State A begins saving, held mid-write by a slow adapter…
		let releaseA!: () => void;
		fake.writeDelay = new Promise<void>((r) => (releaseA = r));
		store.schedule("p1", pageWith("p1", "A"));
		await vi.advanceTimersByTimeAsync(800); // debounce fires; A's write is now stalled
		// …state B is created and scheduled while A is still in flight…
		store.schedule("p1", pageWith("p1", "B"));
		await vi.advanceTimersByTimeAsync(800);
		// …A finally completes, then B runs (chained AFTER A, never before).
		fake.writeDelay = null;
		releaseA();
		await settle();
		expect(fake.files.get(".handwriting/p1.json")).toContain('"B"');
		// And the order on disk was A then B — B is the survivor.
		const tmpWrites = fake.log.filter((l) => l.includes("p1.json.tmp") && l.startsWith("write"));
		expect(tmpWrites.length).toBe(2);
	});
});

describe("failed writes are not durable", () => {
	it("a rejected write keeps the state queued and retries to success", async () => {
		fake.failWriteTimes = 1;
		store.schedule("p1", pageWith("p1", "S"));
		await vi.advanceTimersByTimeAsync(800); // debounce → first write fails
		expect(fake.files.has(".handwriting/p1.json")).toBe(false);
		await settle(); // bounded retry timer fires → succeeds
		expect(fake.files.get(".handwriting/p1.json")).toContain('"S"');
	});

	it("persistent failure surfaces ONE user-facing error and keeps data pending", async () => {
		const errors: string[] = [];
		store.onWriteError = (id, problem) => errors.push(`${id}:${problem}`);
		fake.failWriteTimes = 99;
		store.schedule("p1", pageWith("p1", "S"));
		await settle();
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("EIO");
		// The state is still queued: a later flush with a healed disk saves it.
		fake.failWriteTimes = 0;
		await store.flush();
		expect(fake.files.get(".handwriting/p1.json")).toContain('"S"');
	});

	it("a serialization failure is a failed write, not silent success", async () => {
		const errors: string[] = [];
		store.onWriteError = (id) => errors.push(id);
		const poison = pageWith("p1", "S");
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		poison.unknownTop = circular; // JSON.stringify throws
		store.schedule("p1", poison);
		await settle();
		expect(fake.files.has(".handwriting/p1.json")).toBe(false);
		expect(errors.length).toBe(1);
	});
});

describe("unreadable payloads fail CLOSED", () => {
	it("malformed JSON loads as damaged, never as an innocent empty page", async () => {
		fake.externalWrite(".handwriting/p1.json", "{ not json ///");
		const result = await store.load("p1");
		expect(result?.damaged).toBe(true);
		expect(result?.recovered).toBe(true);
	});

	it("an I/O failure during load is damage, not emptiness", async () => {
		fake.externalWrite(".handwriting/p1.json", "irrelevant");
		fake.read = async () => {
			throw new Error("EACCES");
		};
		const result = await store.load("p1");
		expect(result?.damaged).toBe(true);
	});

	it("recovery from an interrupted write (.tmp) is NOT damage", async () => {
		fake.externalWrite(".handwriting/p1.json.tmp", JSON.stringify(JSON.parse(serialize("p1", "T"))));
		const result = await store.load("p1");
		expect(result?.recovered).toBe(true);
		expect(result?.damaged).toBeFalsy();
		expect(result?.data.strokes[0]?.id).toBe("T");
	});
});

function serialize(id: string, label: string): string {
	return JSON.stringify({
		schemaVersion: 1,
		pageId: id,
		surface: "inline",
		textBoxes: [],
		images: [],
		strokes: pageWith(id, label).strokes,
	});
}

describe("external revisions are preserved, not clobbered", () => {
	it("a sidecar changed since load is kept as a conflict file; ours proceeds", async () => {
		fake.externalWrite(".handwriting/p1.json", serialize("p1", "mine-v1"));
		await store.load("p1"); // records the known mtime
		// Sync/another device replaces the file…
		fake.externalWrite(".handwriting/p1.json", serialize("p1", "THEIRS"));
		const conflicts: string[] = [];
		store.onConflict = (_id, keptAs) => conflicts.push(keptAs);
		store.schedule("p1", pageWith("p1", "mine-v2"));
		await settle();
		// Both states survive: theirs under a conflict name, ours in place.
		expect(conflicts.length).toBe(1);
		expect(fake.files.get(conflicts[0]!)).toContain("THEIRS");
		expect(fake.files.get(".handwriting/p1.json")).toContain("mine-v2");
	});

	it("an external write racing the LOAD itself still trips the guard (stat-before-read)", async () => {
		// The nasty ordering: we stat the file, an external writer replaces it,
		// then our read returns THEIR content. Recording the mtime before the
		// read means the next write sees a mismatch and preserves their state —
		// a false conflict. The reverse order records their mtime against our
		// session and silently clobbers them.
		fake.externalWrite(".handwriting/p1.json", serialize("p1", "v1"));
		const realRead = fake.read.bind(fake);
		let raced = false;
		fake.read = async (path: string) => {
			if (!raced && path === ".handwriting/p1.json") {
				raced = true;
				fake.externalWrite(".handwriting/p1.json", serialize("p1", "RACER"));
			}
			return realRead(path);
		};
		await store.load("p1");
		const conflicts: string[] = [];
		store.onConflict = (_id, keptAs) => conflicts.push(keptAs);
		store.schedule("p1", pageWith("p1", "mine"));
		await settle();
		expect(conflicts.length).toBe(1);
		expect(fake.files.get(conflicts[0]!)).toContain("RACER");
		expect(fake.files.get(".handwriting/p1.json")).toContain("mine");
	});

	it("a SAME-MTIME external edit is still detected (content-aware guard)", async () => {
		store.schedule("p1", pageWith("p1", "mine-v1"));
		await settle();
		// Sync replaces the file but the observable mtime does not move.
		fake.externalWriteSameMtime(".handwriting/p1.json", serialize("p1", "SNEAKY-THEIRS"));
		const conflicts: string[] = [];
		store.onConflict = (_id, keptAs) => conflicts.push(keptAs);
		store.schedule("p1", pageWith("p1", "mine-v2"));
		await settle();
		expect(conflicts.length).toBe(1);
		expect(fake.files.get(conflicts[0]!)).toContain("SNEAKY-THEIRS");
		expect(fake.files.get(".handwriting/p1.json")).toContain("mine-v2");
	});

	it("same mtime AND equal length still cannot slip past the guard", async () => {
		store.schedule("p1", pageWith("p1", "AAAA"));
		await settle();
		const ours = fake.files.get(".handwriting/p1.json")!;
		const theirs = ours.replace('"AAAA"', '"BBBB"'); // byte-for-byte same size
		expect(theirs.length).toBe(ours.length);
		fake.externalWriteSameMtime(".handwriting/p1.json", theirs);
		const conflicts: string[] = [];
		store.onConflict = (_id, keptAs) => conflicts.push(keptAs);
		store.schedule("p1", pageWith("p1", "CCCC"));
		await settle();
		expect(conflicts.length).toBe(1);
		expect(fake.files.get(conflicts[0]!)).toContain("BBBB");
	});

	it("two conflicts wanting the same name both survive (no overwrite)", async () => {
		store.schedule("p1", pageWith("p1", "v1"));
		await settle();
		const m = fake.mtimes.get(".handwriting/p1.json")!;
		fake.externalWriteSameMtime(".handwriting/p1.json", serialize("p1", "FIRST-THEIRS"));
		store.schedule("p1", pageWith("p1", "v2"));
		await settle();
		// A second external edit lands carrying the SAME mtime the first
		// conflict was named after — the name is taken, and renaming over it
		// would destroy the first preserved revision.
		fake.files.set(".handwriting/p1.json", serialize("p1", "SECOND-THEIRS"));
		fake.mtimes.set(".handwriting/p1.json", m);
		store.schedule("p1", pageWith("p1", "v3"));
		await settle();
		expect(fake.files.get(`.handwriting/p1.conflict-${m}.json`)).toContain("FIRST-THEIRS");
		expect(fake.files.get(`.handwriting/p1.conflict-${m}-2.json`)).toContain("SECOND-THEIRS");
		expect(fake.files.get(".handwriting/p1.json")).toContain("v3");
	});

	it("our own consecutive writes are NOT treated as conflicts", async () => {
		const conflicts: string[] = [];
		store.onConflict = () => conflicts.push("x");
		store.schedule("p1", pageWith("p1", "one"));
		await settle();
		store.schedule("p1", pageWith("p1", "two"));
		await settle();
		expect(conflicts.length).toBe(0);
		expect(fake.files.get(".handwriting/p1.json")).toContain("two");
	});

	// ---- RC4: no success claim ahead of the write ---------------------------
	//
	// The aside-rename that preserves an external revision necessarily runs
	// BEFORE our replacement is written. Until RC4 the conflict callback fired
	// at that moment, and the notice it drove said "this session's ink was
	// saved normally" — a claim about a write that had not been attempted and
	// could still fail. These tests pin the ordering.

	it("a FAILED save produces no conflict (success) callback at all", async () => {
		store.schedule("p1", pageWith("p1", "mine-v1"));
		await settle();
		fake.externalWrite(".handwriting/p1.json", serialize("p1", "THEIRS"));
		const conflicts: string[] = [];
		const errors: { id: string; preservedAs?: string }[] = [];
		store.onConflict = (_id, keptAs) => conflicts.push(keptAs);
		store.onWriteError = (id, _problem, preservedAs) => errors.push({ id, preservedAs });
		// Every write attempt fails, for good.
		fake.failWriteTimes = 99;
		store.schedule("p1", pageWith("p1", "mine-v2"));
		await settle();
		// No success notice was emitted, at any point.
		expect(conflicts).toEqual([]);
		// The failure WAS reported, and it names where the other version went —
		// the live path is empty now, so this is the only pointer to it.
		expect(errors.length).toBe(1);
		expect(errors[0]!.preservedAs).toBeDefined();
		expect(fake.files.get(errors[0]!.preservedAs!)).toContain("THEIRS");
		expect(fake.files.has(".handwriting/p1.json")).toBe(false);
	});

	it("the conflict callback fires only AFTER the final rename lands", async () => {
		store.schedule("p1", pageWith("p1", "mine-v1"));
		await settle();
		fake.externalWrite(".handwriting/p1.json", serialize("p1", "THEIRS"));
		const order: string[] = [];
		store.onConflict = (_id, keptAs) => {
			// At the instant the user is told, both files must be on disk:
			// the preserved revision AND this session's completed save.
			order.push(
				`notified live=${fake.files.get(".handwriting/p1.json")?.includes("mine-v2")} kept=${fake.files.get(keptAs)?.includes("THEIRS")}`
			);
		};
		const origRename = fake.rename.bind(fake);
		fake.rename = async (from: string, to: string) => {
			await origRename(from, to);
			order.push(`rename ${from} -> ${to}`);
		};
		store.schedule("p1", pageWith("p1", "mine-v2"));
		await settle();
		expect(order).toEqual([
			expect.stringContaining("rename .handwriting/p1.json -> .handwriting/p1.conflict-"),
			"rename .handwriting/p1.json.tmp -> .handwriting/p1.json",
			"notified live=true kept=true",
		]);
	});

	it("a retry that finally succeeds still reports the preserved revision", async () => {
		store.schedule("p1", pageWith("p1", "mine-v1"));
		await settle();
		fake.externalWrite(".handwriting/p1.json", serialize("p1", "THEIRS"));
		const conflicts: string[] = [];
		store.onConflict = (_id, keptAs) => conflicts.push(keptAs);
		fake.failWriteTimes = 1; // fail once, then the bounded retry succeeds
		store.schedule("p1", pageWith("p1", "mine-v2"));
		await settle();
		// Exactly one notice, delivered by the attempt that actually landed.
		expect(conflicts.length).toBe(1);
		expect(fake.files.get(conflicts[0]!)).toContain("THEIRS");
		expect(fake.files.get(".handwriting/p1.json")).toContain("mine-v2");
	});
});

describe("preserve — the delete-all-ink safety net", () => {
	it("flushes the NEWEST pending state and copies it to trash; live file stays", async () => {
		store.schedule("p1", pageWith("p1", "old"));
		await settle();
		store.schedule("p1", pageWith("p1", "newest")); // still pending
		const kept = await store.preserve("p1");
		expect(kept).toBe(trashGenerations("p1")[0]);
		expect(trashContents("p1")).toEqual([expect.stringContaining("newest")]);
		expect(fake.files.get(".handwriting/p1.json")).toContain("newest"); // untouched, current
	});

	it("returns null for a page that has never been saved", async () => {
		expect(await store.preserve("ghost")).toBeNull();
		expect(trashGenerations("ghost")).toEqual([]);
	});

	it("THROWS when the copy cannot be made — the wipe must then be refused", async () => {
		store.schedule("p1", pageWith("p1", "precious"));
		await settle();
		fake.read = async () => {
			throw new Error("EIO on read");
		};
		await expect(store.preserve("p1")).rejects.toThrow("EIO");
		expect(trashGenerations("p1")).toEqual([]);
		// The write chain survives the failed copy: later saves still land.
		fake.read = FakeAdapter.prototype.read.bind(fake);
		store.schedule("p1", pageWith("p1", "after"));
		await settle();
		expect(fake.files.get(".handwriting/p1.json")).toContain("after");
	});

	it("REFUSES when the newest state cannot be flushed — no stale copy sold as fresh", async () => {
		store.schedule("p1", pageWith("p1", "old"));
		await settle();
		fake.failWriteTimes = 99;
		store.schedule("p1", pageWith("p1", "newest")); // will fail to flush
		await expect(store.preserve("p1")).rejects.toThrow("could not be written");
		// The trash slot was NOT filled with the stale 'old' state under the
		// banner of holding 'newest' — and 'newest' is still pending, so a
		// healed disk saves it.
		expect(trashGenerations("p1")).toEqual([]);
		fake.failWriteTimes = 0;
		await store.flush();
		expect(fake.files.get(".handwriting/p1.json")).toContain("newest");
	});

	it("preserving our own current state never registers as a conflict", async () => {
		const conflicts: string[] = [];
		store.onConflict = () => conflicts.push("x");
		store.schedule("p1", pageWith("p1", "one"));
		await settle();
		await store.preserve("p1");
		store.schedule("p1", pageWith("p1", "two"));
		await settle();
		expect(conflicts.length).toBe(0);
		expect(fake.files.get(".handwriting/p1.json")).toContain("two");
	});
});

// ---- RC4: the trash keeps generations ---------------------------------------
//
// Before RC4 `.handwriting/trash/` held one slot per page id, so the SECOND
// destruction of a page silently destroyed the first one's recovery copy.
// Every destruction now lands on a name that provably did not exist.

describe("trash generations — a recovery copy is never overwritten", () => {
	it("repeated delete-all keeps every generation", async () => {
		store.schedule("p1", pageWith("p1", "first-ink"));
		await settle();
		const g1 = await store.preserve("p1");

		trashClock = 6_000_000; // a later day
		store.schedule("p1", pageWith("p1", "second-ink"));
		await settle();
		const g2 = await store.preserve("p1");

		expect(g1).not.toBe(g2);
		expect(fake.files.get(g1!)).toContain("first-ink");
		expect(fake.files.get(g2!)).toContain("second-ink");
		expect(trashGenerations("p1").length).toBe(2);
	});

	it("identical timestamps get a counter instead of colliding", async () => {
		// Two destructions inside the same millisecond: the stamp is equal, so
		// only the counter separates them.
		store.schedule("p1", pageWith("p1", "alpha"));
		await settle();
		const g1 = await store.preserve("p1");
		store.schedule("p1", pageWith("p1", "beta"));
		await settle();
		const g2 = await store.preserve("p1"); // same trashClock

		expect(g1).toBe(".handwriting/trash/p1-5000000.json");
		expect(g2).toBe(".handwriting/trash/p1-5000000-2.json");
		expect(fake.files.get(g1!)).toContain("alpha");
		expect(fake.files.get(g2!)).toContain("beta");
	});

	it("a pre-existing file on the candidate name is never overwritten", async () => {
		// Something already occupies the natural name — a restored backup, a
		// sync copy, a leftover from an older build's single-slot scheme.
		fake.files.set(".handwriting/trash/p1-5000000.json", "PRE-EXISTING, DO NOT TOUCH");
		fake.files.set(".handwriting/trash/p1-5000000-2.json", "ALSO PRE-EXISTING");
		store.schedule("p1", pageWith("p1", "new-ink"));
		await settle();
		const kept = await store.preserve("p1");

		expect(kept).toBe(".handwriting/trash/p1-5000000-3.json");
		expect(fake.files.get(".handwriting/trash/p1-5000000.json")).toBe("PRE-EXISTING, DO NOT TOUCH");
		expect(fake.files.get(".handwriting/trash/p1-5000000-2.json")).toBe("ALSO PRE-EXISTING");
		expect(fake.files.get(kept!)).toContain("new-ink");
	});

	it("delete-all then note-delete keeps BOTH copies", async () => {
		// The old single-slot bug in its most damaging form: the delete-all
		// copy is the only surviving record of the wiped ink, and the note
		// deletion used to rename the live file straight over it.
		store.schedule("p1", pageWith("p1", "wiped-ink"));
		await settle();
		const wipeCopy = await store.preserve("p1");
		trashClock = 5_000_100;
		store.schedule("p1", pageWith("p1", "ink-drawn-after-the-wipe"));
		await settle();
		await store.remove("p1"); // the note deletion

		expect(fake.files.get(wipeCopy!)).toContain("wiped-ink");
		expect(trashContents("p1")).toEqual(
			expect.arrayContaining([
				expect.stringContaining("wiped-ink"),
				expect.stringContaining("ink-drawn-after-the-wipe"),
			])
		);
		expect(trashGenerations("p1").length).toBe(2);
	});

	it("note-delete twice on a recycled id keeps both generations", async () => {
		store.schedule("p1", pageWith("p1", "life-one"));
		await settle();
		await store.remove("p1");
		store.schedule("p1", pageWith("p1", "life-two"));
		await settle();
		await store.remove("p1"); // same trashClock — counter separates them

		// Both lives survive. Filename ORDER is not a guarantee (the counter
		// suffix sorts before the bare stamp), so the assertion is on the set.
		expect(trashGenerations("p1").length).toBe(2);
		expect(trashContents("p1")).toEqual(
			expect.arrayContaining([
				expect.stringContaining("life-one"),
				expect.stringContaining("life-two"),
			])
		);
	});

	it("unknown fields survive a trash generation verbatim", async () => {
		const p = pageWith("p1", "ink");
		p.unknownTop = { futureFeature: { keep: "me" } };
		store.schedule("p1", p);
		await settle();
		const kept = await store.preserve("p1");
		expect(fake.files.get(kept!)).toContain("futureFeature");
		// Byte-identical to the live file: preserve copies, never re-serializes.
		expect(fake.files.get(kept!)).toBe(fake.files.get(".handwriting/p1.json"));
	});

	it("the empty-page guard still refuses to make a useless generation", async () => {
		store.schedule("p1", pageWith("p1", "precious"));
		await settle();
		await store.preserve("p1");
		const empty = emptyPage("p1");
		empty.surface = "inline";
		store.schedule("p1", empty); // the wipe
		await settle();
		trashClock = 5_000_200;
		await store.remove("p1"); // deleting a now-empty page

		// One generation, and it is the one holding real ink.
		expect(trashContents("p1")).toEqual([expect.stringContaining("precious")]);
		expect(fake.files.has(".handwriting/p1.json")).toBe(false);
	});

	it("preservation failure still aborts before anything is destroyed", async () => {
		store.schedule("p1", pageWith("p1", "precious"));
		await settle();
		fake.write = async () => {
			throw new Error("EIO on the trash copy");
		};
		await expect(store.preserve("p1")).rejects.toThrow("EIO");
		expect(trashGenerations("p1")).toEqual([]);
		// The live file is untouched — the caller aborts the wipe.
		expect(fake.files.get(".handwriting/p1.json")).toContain("precious");
	});
});

describe("clone — independent ink for a duplicated note", () => {
	it("clones content under the new id; unknown fields survive; source untouched", async () => {
		const withUnknown = JSON.parse(serialize("p1", "orig")) as Record<string, unknown>;
		withUnknown.futureField = "must-survive";
		fake.externalWrite(".handwriting/p1.json", JSON.stringify(withUnknown));
		const before = fake.files.get(".handwriting/p1.json");
		expect(await store.clone("p1", "p2")).toBe("cloned");
		const cloneText = fake.files.get(".handwriting/p2.json")!;
		expect(cloneText).toContain('"orig"');
		expect(cloneText).toContain("must-survive");
		expect(cloneText).toContain('"pageId":"p2"');
		expect(cloneText).not.toContain('"pageId":"p1"');
		expect(fake.files.get(".handwriting/p1.json")).toBe(before); // byte-identical
	});

	it("a missing source is 'none' — the copy simply starts blank", async () => {
		expect(await store.clone("ghost", "p2")).toBe("none");
		expect(fake.files.has(".handwriting/p2.json")).toBe(false);
	});

	it("an unreadable source is never fabricated into a clone", async () => {
		fake.externalWrite(".handwriting/p1.json", "{ not json ///");
		expect(await store.clone("p1", "p2")).toBe("unreadable");
		expect(fake.files.has(".handwriting/p2.json")).toBe(false);
		expect(fake.files.get(".handwriting/p1.json")).toBe("{ not json ///"); // untouched
	});

	it("never overwrites an existing destination", async () => {
		fake.externalWrite(".handwriting/p1.json", serialize("p1", "src"));
		fake.externalWrite(".handwriting/p2.json", serialize("p2", "already-there"));
		expect(await store.clone("p1", "p2")).toBe("exists");
		expect(fake.files.get(".handwriting/p2.json")).toContain("already-there");
	});

	it("the clone's first save is not a false conflict (mtime+hash recorded)", async () => {
		fake.externalWrite(".handwriting/p1.json", serialize("p1", "orig"));
		await store.clone("p1", "p2");
		const conflicts: string[] = [];
		store.onConflict = () => conflicts.push("x");
		store.schedule("p2", pageWith("p2", "copy-edit"));
		await settle();
		expect(conflicts.length).toBe(0);
		expect(fake.files.get(".handwriting/p2.json")).toContain("copy-edit");
	});
});

describe("discardPending — orphaned queue entries", () => {
	it("drops a queued save so it never lands", async () => {
		store.schedule("p1", pageWith("p1", "orphan"));
		store.discardPending("p1");
		await settle();
		expect(fake.files.has(".handwriting/p1.json")).toBe(false);
	});
});

describe("externallyChanged — the live-reload poll primitive", () => {
	it("false for a page this store never read or wrote", async () => {
		fake.files.set(".handwriting/p1.json", JSON.stringify(pageWith("p1", "S")));
		fake.mtimes.set(".handwriting/p1.json", 5000);
		expect(await store.externallyChanged("p1")).toBe(false);
	});

	it("false while nothing on disk moved", async () => {
		store.schedule("p1", pageWith("p1", "S"));
		await store.flush();
		expect(await store.externallyChanged("p1")).toBe(false);
	});

	it("true when an external writer replaced the content", async () => {
		store.schedule("p1", pageWith("p1", "S"));
		await store.flush();
		fake.files.set(".handwriting/p1.json", JSON.stringify(pageWith("p1", "REMOTE")));
		fake.mtimes.set(".handwriting/p1.json", 999999);
		expect(await store.externallyChanged("p1")).toBe(true);
	});

	it("false for mtime churn with identical content, and remembers the new stamp", async () => {
		store.schedule("p1", pageWith("p1", "S"));
		await store.flush();
		const text = fake.files.get(".handwriting/p1.json")!;
		fake.files.set(".handwriting/p1.json", text);
		fake.mtimes.set(".handwriting/p1.json", 999999);
		expect(await store.externallyChanged("p1")).toBe(false);
		// second poll never re-reads: the stamp was remembered
		expect(await store.externallyChanged("p1")).toBe(false);
	});

	it("false while a write for the page is queued", async () => {
		store.schedule("p1", pageWith("p1", "S"));
		await store.flush();
		fake.files.set(".handwriting/p1.json", JSON.stringify(pageWith("p1", "REMOTE")));
		fake.mtimes.set(".handwriting/p1.json", 999999);
		store.schedule("p1", pageWith("p1", "LOCAL")); // pending again
		expect(await store.externallyChanged("p1")).toBe(false);
	});

	it("load refreshes the stamps, so a poll after reload goes quiet", async () => {
		store.schedule("p1", pageWith("p1", "S"));
		await store.flush();
		fake.files.set(".handwriting/p1.json", JSON.stringify(pageWith("p1", "REMOTE")));
		fake.mtimes.set(".handwriting/p1.json", 999999);
		expect(await store.externallyChanged("p1")).toBe(true);
		await store.load("p1");
		expect(await store.externallyChanged("p1")).toBe(false);
	});

	// A read that keeps failing pauses live reload for that page. False is
	// the safe answer - it declines to reload, so local ink is never
	// discarded - but on a one-second poll, silence means another device's
	// ink stops arriving forever with nothing said. Once per page, not once
	// per second.
	it("a failing read answers false and says so exactly once", async () => {
		store.schedule("p1", pageWith("p1", "S"));
		await store.flush();
		fake.files.set(".handwriting/p1.json", JSON.stringify(pageWith("p1", "REMOTE")));
		fake.mtimes.set(".handwriting/p1.json", 999999);

		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const realRead = fake.read.bind(fake);
		fake.read = async () => {
			throw new Error("EIO");
		};
		try {
			expect(await store.externallyChanged("p1")).toBe(false);
			expect(await store.externallyChanged("p1")).toBe(false);
			expect(await store.externallyChanged("p1")).toBe(false);
			expect(errors).toHaveBeenCalledTimes(1);
			expect(String(errors.mock.calls[0]?.[0])).toContain("live reload is paused");
		} finally {
			fake.read = realRead;
			errors.mockRestore();
		}
	});

	// The latch has to clear on ANY completed check, not only one that found a
	// change. Clearing only on "changed" left a page that failed, recovered,
	// and then simply never changed again holding the latch forever - so a
	// genuinely new failure would say nothing, which is the silence the latch
	// exists to break.
	it("a quiet recovery still clears the latch", async () => {
		store.schedule("p1", pageWith("p1", "S"));
		await store.flush();

		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const realRead = fake.read.bind(fake);
		try {
			// Fail once, with a change on disk so the read is reached.
			fake.files.set(".handwriting/p1.json", JSON.stringify(pageWith("p1", "REMOTE")));
			fake.mtimes.set(".handwriting/p1.json", 999999);
			fake.read = async () => {
				throw new Error("EIO");
			};
			expect(await store.externallyChanged("p1")).toBe(false);
			expect(errors).toHaveBeenCalledTimes(1);

			// Recovers, but the page is QUIET: mtime back to what we know, so
			// the check completes and reports "no change" without a read.
			fake.read = realRead;
			fake.mtimes.set(".handwriting/p1.json", store["knownMtime"].get("p1") as number);
			expect(await store.externallyChanged("p1")).toBe(false);

			// A new failure after that quiet success is news again.
			fake.mtimes.set(".handwriting/p1.json", 1000001);
			fake.read = async () => {
				throw new Error("EIO");
			};
			expect(await store.externallyChanged("p1")).toBe(false);
			expect(errors).toHaveBeenCalledTimes(2);
		} finally {
			fake.read = realRead;
			errors.mockRestore();
		}
	});

	it("reports again after the page recovers and then fails anew", async () => {
		store.schedule("p1", pageWith("p1", "S"));
		await store.flush();
		fake.files.set(".handwriting/p1.json", JSON.stringify(pageWith("p1", "REMOTE")));
		fake.mtimes.set(".handwriting/p1.json", 999999);

		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const realRead = fake.read.bind(fake);
		try {
			fake.read = async () => {
				throw new Error("EIO");
			};
			expect(await store.externallyChanged("p1")).toBe(false);
			expect(errors).toHaveBeenCalledTimes(1);

			// Recovering clears the latch: a real change is seen again.
			fake.read = realRead;
			expect(await store.externallyChanged("p1")).toBe(true);

			// Failing later is news again, so it reports again.
			fake.read = async () => {
				throw new Error("EIO");
			};
			fake.mtimes.set(".handwriting/p1.json", 1000000);
			expect(await store.externallyChanged("p1")).toBe(false);
			expect(errors).toHaveBeenCalledTimes(2);
		} finally {
			fake.read = realRead;
			errors.mockRestore();
		}
	});
});

describe("round trips and deletion", () => {
	it("save → load returns the same strokes, undamaged", async () => {
		store.schedule("p1", pageWith("p1", "R"));
		await settle();
		const result = await store.load("p1");
		expect(result?.damaged).toBeFalsy();
		expect(result?.data.strokes[0]?.id).toBe("R");
	});

	it("an old-format payload without optional fields still parses with safe defaults", () => {
		const old = JSON.stringify({
			schemaVersion: 1,
			pageId: "p1",
			surface: "inline",
			strokes: [
				{
					id: "legacy",
					tool: "pen",
					color: "#4b7bec",
					width: 2.2,
					points: [{ x: 1, y: 2 }],
				},
			],
		});
		const r = parsePage(old, "p1");
		expect(r.damaged).toBeFalsy();
		expect(r.data.strokes[0]?.points[0]?.pressure).toBe(0.5); // default
	});

	it("deleting a note RECYCLES the ink instead of destroying it", async () => {
		store.schedule("p1", pageWith("p1", "keepme"));
		await settle();
		await store.remove("p1");
		expect(fake.files.has(".handwriting/p1.json")).toBe(false);
		expect(trashContents("p1")).toEqual([expect.stringContaining("keepme")]);
	});

	it("a save already in flight cannot resurrect the sidecar after remove", async () => {
		// The race: remove() runs while a write for the same page is mid
		// tmp/rename dance. Unchained, the write would re-create the live
		// sidecar right after the recycle moved it — a live ink file for a
		// deleted note. Chained on the write queue, the write completes FIRST
		// and the recycle then moves the finished file.
		let release!: () => void;
		fake.writeDelay = new Promise<void>((r) => (release = r));
		store.schedule("p1", pageWith("p1", "S"));
		await vi.advanceTimersByTimeAsync(800); // debounce fired; write stalled
		const removal = store.remove("p1");
		fake.writeDelay = null;
		release();
		await removal;
		await settle();
		expect(fake.files.has(".handwriting/p1.json")).toBe(false);
		expect(fake.files.has(".handwriting/p1.json.tmp")).toBe(false);
		expect(trashContents("p1")).toEqual([expect.stringContaining('"S"')]);
	});

	it("deleting an EMPTY page never clobbers a trash copy holding real ink", async () => {
		// The chain: "delete all ink" put today's ink in the trash slot, the
		// live sidecar is now an empty page — then the user deletes the note.
		// Recycling the empty page over the trash copy would destroy the only
		// remaining copy of the ink, for zero benefit.
		store.schedule("p1", pageWith("p1", "precious"));
		await settle();
		await store.preserve("p1"); // the delete-all safety copy
		const empty = emptyPage("p1");
		empty.surface = "inline";
		store.schedule("p1", empty); // the wipe
		await settle();
		await store.remove("p1"); // the note deletion
		expect(fake.files.has(".handwriting/p1.json")).toBe(false);
		expect(trashContents("p1")).toEqual([expect.stringContaining("precious")]);
	});
});
