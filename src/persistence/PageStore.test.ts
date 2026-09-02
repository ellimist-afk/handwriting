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
	/** Writes that ENTERED the adapter, counted before any stall. */
	writesStarted = 0;
	/**
	 * The PATH of every write that entered the adapter, recorded before any
	 * stall. `log` records a write only once it COMPLETES, so a stalled
	 * write - the freeze in miniature - never appears there; the background
	 * flush is exactly about what reaches the platform before it completes.
	 */
	writeStarts: string[] = [];
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
		this.writesStarted++;
		this.writeStarts.push(path);
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
	/**
	 * Obsidian's adapter throws for a folder that does not exist, and the
	 * trash-restore path depends on that being the signal for "nothing has
	 * ever been recycled here".
	 */
	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = path.endsWith("/") ? path : `${path}/`;
		const files: string[] = [];
		const folders = new Set<string>();
		let seen = this.dirs.has(path);
		for (const p of this.files.keys()) {
			if (!p.startsWith(prefix)) continue;
			seen = true;
			const rest = p.slice(prefix.length);
			if (rest.includes("/")) folders.add(prefix + rest.split("/")[0]);
			else files.push(p);
		}
		if (!seen) throw new Error(`ENOENT ${path}`);
		return { files, folders: [...folders] };
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

	it("a FAILED save produces no conflict callback, and moves nothing", async () => {
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
		// The failure WAS reported.
		expect(errors.length).toBe(1);
		// And THEIR revision is untouched, in the live path, where they left
		// it. This assertion is the opposite of what it was: the tmp is now
		// written before the aside-rename, so a save that cannot write never
		// gets as far as moving anything. It used to move their file aside
		// FIRST and then fail, which emptied the live path and left the only
		// copy of their ink under a .conflict- name nobody had been told
		// about - and if the process died there rather than merely erroring,
		// nothing announced it at all.
		expect(errors[0]!.preservedAs).toBeUndefined();
		expect(fake.files.get(".handwriting/p1.json")).toContain("THEIRS");
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

	it("deleting a note within the debounce recycles the SCHEDULED stroke, not the stale disk copy", async () => {
		// audit-fixes-design.md 5i I1: a stroke scheduled inside the 700ms
		// debounce is the only copy of itself until the timer fires. remove()
		// used to delete pending and clearTimers before ever looking at it,
		// so that stroke was discarded outright instead of recycled.
		store.schedule("p1", pageWith("p1", "keepme"));
		await settle(); // "keepme" is now the stale disk copy
		store.schedule("p1", pageWith("p1", "urgent")); // still inside the debounce
		await store.remove("p1"); // no timer advance: the debounce never fires
		expect(fake.files.has(".handwriting/p1.json")).toBe(false);
		expect(trashContents("p1")).toEqual([expect.stringContaining("urgent")]);
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

// ---- background flush (mobile freeze) --------------------------------------

describe("flushDispatch: the background/freeze path", () => {
	it("writes every pending page's .tmp synchronously, before any yield", async () => {
		// On iOS and Android the webview freezes on background with no
		// further JS. flush() awaits each write in turn, so under a freeze
		// only the first write ever starts - and until 2026-09-02 the
		// dispatcher was no better: writePending -> chain -> writeNow, whose
		// first statement was `await ensureFolder(...)`, so what reached the
		// platform before the freeze was a FOLDER CHECK per page and not one
		// byte of ink. See audit-fixes-design.md section 4 (B1).
		store.schedule("p1", pageWith("p1", "s1"));
		store.schedule("p2", pageWith("p2", "s2"));
		expect(fake.files.size).toBe(0); // both debounced, nothing on disk

		// A write that never resolves is the freeze in miniature: nothing
		// chained behind it ever runs, and `log` (written on completion)
		// stays empty. writeStarts records what ENTERED the adapter.
		fake.writeDelay = new Promise<void>(() => {});
		store.flushDispatch();
		// NO await. This is the whole assertion: the tmp write for every
		// dirty page has already been handed to the platform by the time
		// flushDispatch returns, because after it returns there may be no
		// more JS at all.
		expect(fake.writeStarts).toEqual([".handwriting/p1.json.tmp", ".handwriting/p2.json.tmp"]);
		expect(fake.log).toEqual([]); // nothing completed; the platform owns them now

		// And still both, after a drained tick - nothing re-dispatches or
		// duplicates behind the stall.
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.writesStarted).toBe(2);
	});

	it("leaves a recoverable .tmp for every dirty page when the freeze lands", async () => {
		// The failure matrix's first row: freeze immediately after the sweep.
		// The adapter completes the writes it already has (writeDelay null,
		// so the fake commits inside the synchronous call), and nothing else
		// runs. Next launch must find the ink.
		store.schedule("p1", pageWith("p1", "s1"));
		store.schedule("p2", pageWith("p2", "s2"));
		store.flushDispatch();
		// The freeze: not one await between the sweep and here.
		expect([...fake.files.keys()].sort()).toEqual([
			".handwriting/p1.json.tmp",
			".handwriting/p2.json.tmp",
		]);

		// Next launch, over the disk as the freeze left it: a fresh adapter
		// so the frozen session's chained writes cannot run into it.
		const disk = new FakeAdapter();
		for (const [path, text] of fake.files) disk.files.set(path, text);
		for (const [path, mtime] of fake.mtimes) disk.mtimes.set(path, mtime);
		for (const dir of fake.dirs) disk.dirs.add(dir);
		const next = new PageStore({ vault: { adapter: disk } }, ".handwriting", () => trashClock);
		const pages: Array<[string, string]> = [
			["p1", "s1"],
			["p2", "s2"],
		];
		for (const [id, label] of pages) {
			const r = await next.load(id);
			expect(r?.damaged).toBeFalsy();
			expect(r?.recovered).toBe(true);
			expect(r?.data.strokes[0]?.id).toBe(label);
			// Promoted, not left in the scratch file (2026-09-01).
			expect(disk.files.has(`.handwriting/${id}.json`)).toBe(true);
			expect(disk.files.has(`.handwriting/${id}.json.tmp`)).toBe(false);
		}
	});

	it("a snapshot scheduled AFTER the sweep is the one that lands", async () => {
		// The subtle row of the failure matrix. The sweep dispatches the tmp
		// for the state it saw; the normal write chained behind it reads
		// `pending` when it RUNS, so a newer snapshot scheduled in between is
		// the one written. Disk state only moves forward.
		store.schedule("p1", pageWith("p1", "old"));
		store.flushDispatch();
		store.schedule("p1", pageWith("p1", "new"));
		await settle();
		expect(fake.files.get(".handwriting/p1.json")).toContain('"new"');
		expect(fake.files.get(".handwriting/p1.json")).not.toContain('"old"');
		expect(fake.files.has(".handwriting/p1.json.tmp")).toBe(false);
	});

	it("without a freeze it ends exactly where a normal save would", async () => {
		// Desktop visibilitychange: the JS keeps running, so the chained
		// normal write renames each tmp into place and the end state is
		// indistinguishable from a debounced save.
		store.schedule("p1", pageWith("p1", "s1"));
		store.schedule("p2", pageWith("p2", "s2"));
		store.flushDispatch();
		await settle();
		expect(fake.files.get(".handwriting/p1.json")).toContain("s1");
		expect(fake.files.get(".handwriting/p2.json")).toContain("s2");
		expect([...fake.files.keys()].filter((p) => p.endsWith(".tmp"))).toEqual([]);
		expect(store.busy).toBe(false);
	});
});

describe("page ids are path components", () => {
	// The last line of the audit-item-2 defence. isSafePageId runs at both
	// frontmatter ingress points and inside parsePage, so an unsafe id
	// reaching the store means one of those was bypassed - and the store
	// must not be the thing that turns that bug into a write outside the
	// ink folder.
	it("refuses to build a path for an id that is not a name", () => {
		for (const id of ["../../x", "sub/dir", ".hidden", ""]) {
			expect(() => store.path(id)).toThrow(/refusing to build a sidecar path/);
		}
	});

	it("still builds paths for every real id", () => {
		expect(store.path("pdf-9f86d081-2")).toBe(".handwriting/pdf-9f86d081-2.json");
	});

	it("reports damage rather than throwing out of load()", async () => {
		// load() builds a read path before it touches the disk. The assert
		// belongs inside its try, or an unsafe id becomes an unhandled
		// rejection somewhere up the attach path instead of a damaged page.
		const r = await store.load("../../x");
		expect(r?.damaged).toBe(true);
	});

	it("does not write anything for an unsafe id", async () => {
		store.schedule("../../x", pageWith("../../x", "s1"));
		await vi.advanceTimersByTimeAsync(60_000);
		expect([...fake.files.keys()]).toEqual([]);
	});
});

describe("the ink folder fallback runs both ways", () => {
	// A vault synced in compatibility mode carries `handwriting/` and not
	// data.json. The second device therefore starts on `.handwriting`, and
	// before this the fallback only ran the other way: it read nothing and
	// then wrote a SECOND sidecar under the same page id. Forked ink is
	// worse than missing ink, because nothing announces it.
	it("reads ink from handwriting/ while configured for .handwriting", async () => {
		fake.files.set("handwriting/p1.json", JSON.stringify(pageWith("p1", "s1")));
		fake.mtimes.set("handwriting/p1.json", 42);
		const r = await store.load("p1");
		expect(r?.damaged).toBeFalsy();
		expect(r?.data.strokes.map((s) => s.id)).toEqual(["s1"]);
	});

	it("still reads ink from .handwriting/ while configured for handwriting/", async () => {
		store.useInkFolder("handwriting");
		fake.files.set(".handwriting/p1.json", JSON.stringify(pageWith("p1", "s1")));
		fake.mtimes.set(".handwriting/p1.json", 42);
		expect((await store.load("p1"))?.data.strokes.map((s) => s.id)).toEqual(["s1"]);
	});

	it("falls back to both well-known folders from a custom one", async () => {
		store.useInkFolder("assets/ink");
		fake.files.set("handwriting/p1.json", JSON.stringify(pageWith("p1", "s1")));
		fake.mtimes.set("handwriting/p1.json", 42);
		expect((await store.load("p1"))?.data.strokes.map((s) => s.id)).toEqual(["s1"]);
	});

	it("prefers the configured folder when the page is in both", async () => {
		fake.files.set(".handwriting/p1.json", JSON.stringify(pageWith("p1", "mine")));
		fake.mtimes.set(".handwriting/p1.json", 42);
		fake.files.set("handwriting/p1.json", JSON.stringify(pageWith("p1", "theirs")));
		fake.mtimes.set("handwriting/p1.json", 43);
		expect((await store.load("p1"))?.data.strokes.map((s) => s.id)).toEqual(["mine"]);
	});

	it("writes to the configured folder even when it read from the other one", async () => {
		// The fallback is a READ fallback. A write that followed the read
		// would migrate files by accident, one page at a time, with no
		// record of it.
		fake.files.set("handwriting/p1.json", JSON.stringify(pageWith("p1", "s1")));
		fake.mtimes.set("handwriting/p1.json", 42);
		await store.load("p1");
		await store.saveNow("p1", pageWith("p1", "s2"));
		expect(fake.files.has(".handwriting/p1.json")).toBe(true);
		expect(fake.files.get("handwriting/p1.json")).toContain("s1");
	});
});

describe("hasQueuedWrite (the reload race)", () => {
	// externallyChanged stats the file, and the stat is awaited. A stroke
	// finishing in that gap queues a write holding a PRE-reload snapshot. If
	// the caller reloads anyway, the reload refreshes the known mtime, the
	// write-path conflict guard then sees nothing wrong, and the stale
	// snapshot goes over the other device's ink with no conflict copy and
	// nothing said. The poll re-asks this, synchronously, right before it
	// adopts.
	it("is false for a quiet page", () => {
		expect(store.hasQueuedWrite("p1")).toBe(false);
	});

	it("is true from the moment a save is scheduled until it lands", async () => {
		store.schedule("p1", pageWith("p1", "s1"));
		expect(store.hasQueuedWrite("p1")).toBe(true);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(store.hasQueuedWrite("p1")).toBe(false);
	});

	it("answers the same question externallyChanged asks", async () => {
		// The one that matters: a queued write must make externallyChanged
		// decline, and hasQueuedWrite is how the caller sees that same fact
		// without paying for a stat.
		fake.files.set(".handwriting/p1.json", JSON.stringify(pageWith("p1", "s1")));
		fake.mtimes.set(".handwriting/p1.json", 42);
		await store.load("p1");
		fake.externalWrite(".handwriting/p1.json", JSON.stringify(pageWith("p1", "remote")));
		expect(await store.externallyChanged("p1")).toBe(true);

		store.schedule("p1", pageWith("p1", "mine"));
		expect(store.hasQueuedWrite("p1")).toBe(true);
		expect(await store.externallyChanged("p1")).toBe(false);
	});

	it("goes true again for a write that failed and is waiting to retry", async () => {
		// A failed write keeps its state queued for a bounded retry. That is
		// still a pre-reload snapshot waiting to land, so it still has to
		// block the reload.
		fake.failWriteTimes = 1;
		store.schedule("p1", pageWith("p1", "s1"));
		await vi.advanceTimersByTimeAsync(1000);
		expect(store.hasQueuedWrite("p1")).toBe(true);
	});
});

describe("a restored note gets its recycled ink back", () => {
	// Deleting a note recycles its sidecar into .handwriting/trash. Nothing
	// ever brought it back, so a note restored from Obsidian's .trash - or
	// undeleted by a sync client - reopened EMPTY, and the next stroke began
	// a second sidecar under the same id, diverging from the copy in the
	// trash folder. The ink was recoverable only by hand, by someone who
	// knew the folder existed.
	it("restores the trashed generation when the live sidecar is gone", async () => {
		fake.files.set(".handwriting/p1.json", JSON.stringify(pageWith("p1", "s1")));
		fake.mtimes.set(".handwriting/p1.json", 42);
		await store.load("p1");
		await store.remove("p1");
		expect(fake.files.has(".handwriting/p1.json")).toBe(false);
		expect(trashGenerations("p1").length).toBe(1);

		const back = await store.load("p1");
		expect(back?.data.strokes.map((s) => s.id)).toEqual(["s1"]);
		// Moved, not copied: the live file is back and the trash is empty.
		expect(fake.files.has(".handwriting/p1.json")).toBe(true);
		expect(trashGenerations("p1")).toEqual([]);
	});

	it("takes the NEWEST generation when a page was deleted more than once", async () => {
		for (const label of ["older", "newer"]) {
			fake.files.set(".handwriting/p1.json", JSON.stringify(pageWith("p1", label)));
			fake.mtimes.set(".handwriting/p1.json", 42);
			await store.load("p1");
			await store.remove("p1");
			trashClock += 1000;
		}
		expect(trashGenerations("p1").length).toBe(2);
		expect((await store.load("p1"))?.data.strokes.map((s) => s.id)).toEqual(["newer"]);
	});

	it("does not take another page's generations", async () => {
		// The pdf instance ids are `pdf-<hex>` and `pdf-<hex>-2`, so one
		// page's trash prefix matches the other's names. The pageId INSIDE
		// the file is what settles it.
		fake.files.set(".handwriting/pdf-ab.json", JSON.stringify(pageWith("pdf-ab", "mine")));
		fake.mtimes.set(".handwriting/pdf-ab.json", 42);
		await store.load("pdf-ab");
		await store.remove("pdf-ab");

		// "pdf-ab-" is a prefix of the trashed "pdf-ab-<stamp>.json", and it
		// is also the prefix a page called "pdf-ab" would scan for.
		expect(await store.load("pdf-ab-2")).toBeNull();
		expect(trashGenerations("pdf-ab").length).toBe(1);
	});

	it("leaves a damaged generation where it is", async () => {
		fake.files.set(".handwriting/p1.json", JSON.stringify(pageWith("p1", "s1")));
		fake.mtimes.set(".handwriting/p1.json", 42);
		await store.load("p1");
		await store.remove("p1");
		const [gen] = trashGenerations("p1");
		fake.files.set(gen!, "{ not json");

		// Not promoted: damaged bytes may still be recoverable by hand, and
		// restoring them would turn an absent page into a locked one.
		expect(await store.load("p1")).toBeNull();
		expect(fake.files.has(gen!)).toBe(true);
	});

	it("says nothing and restores nothing when the trash is empty", async () => {
		expect(await store.load("never-existed")).toBeNull();
	});
});

describe("no instant of a conflicted save has nothing on disk", () => {
	// The aside-rename moves the live file out of the way. Writing our
	// replacement AFTER it meant a kill in between left no live file and no
	// tmp: the page read as absent, and their revision sat under a
	// .conflict- name nobody had been told about, because the announcement
	// waits on the final rename. The tmp is written first now, so every
	// instant has a complete copy where load() already looks.
	it("leaves a recoverable tmp if the process dies after the aside-rename", async () => {
		fake.files.set(".handwriting/p1.json", JSON.stringify(pageWith("p1", "mine-v1")));
		fake.mtimes.set(".handwriting/p1.json", 42);
		await store.load("p1");
		fake.externalWrite(".handwriting/p1.json", serialize("p1", "THEIRS"));

		// Stall the sequence at the rename that follows the aside-rename:
		// the tmp is on disk, the live path has been vacated. This is the
		// exact instant the old order had nothing recoverable in it.
		// The aside-rename is allowed; the tmp→final rename never lands, on
		// this attempt or any retry. That is the process dying between the
		// two, which a single throw would not model - the retry would simply
		// finish the save.
		const realRename = fake.rename.bind(fake);
		fake.rename = async (from: string, to: string) => {
			if (to === ".handwriting/p1.json") throw new Error("killed mid-save");
			return realRename(from, to);
		};
		store.schedule("p1", pageWith("p1", "mine-v2"));
		await settle();

		// A tmp holding this session's ink survives...
		expect(fake.files.has(".handwriting/p1.json.tmp")).toBe(true);
		// ...and load() recovers from it rather than reporting a blank page.
		const back = await store.load("p1");
		expect(back?.data.strokes.map((s) => s.id)).toEqual(["mine-v2"]);
		expect(back?.recovered).toBe(true);
		// Their revision is still on disk under the conflict name.
		const kept = [...fake.files.keys()].find((f) => f.includes(".conflict-"));
		expect(kept).toBeDefined();
		expect(fake.files.get(kept!)).toContain("THEIRS");
	});
});

describe("every path finds the page, not just load()", () => {
	// load() falls back between the two well-known ink folders. preserve,
	// clone, remove and externallyChanged did not, so in a vault mid-migration
	// - or on a device that lost data.json - the page rendered fine and every
	// other operation on it quietly addressed a file that was not there.
	const OTHER = "handwriting/p1.json";

	beforeEach(() => {
		fake.files.set(OTHER, JSON.stringify(pageWith("p1", "s1")));
		fake.mtimes.set(OTHER, 42);
	});

	it("remove recycles the copy that exists, wherever it is", async () => {
		await store.remove("p1");
		expect(fake.files.has(OTHER)).toBe(false);
		expect(trashContents("p1")[0]).toContain("s1");
	});

	it("preserve copies the page that exists, not an absent one", async () => {
		const kept = await store.preserve("p1");
		expect(kept).not.toBeNull();
		expect(fake.files.get(kept!)).toContain("s1");
	});

	it("clone reads the page that exists and writes to the configured folder", async () => {
		expect(await store.clone("p1", "p2")).toBe("cloned");
		expect(fake.files.get(".handwriting/p2.json")).toContain("s1");
		// The source is untouched, wherever it was.
		expect(fake.files.has(OTHER)).toBe(true);
	});

	it("externallyChanged watches the file it would actually read", async () => {
		await store.load("p1");
		expect(await store.externallyChanged("p1")).toBe(false);
		fake.externalWrite(OTHER, serialize("p1", "THEIRS"));
		// Before, this watched .handwriting/p1.json - which does not exist -
		// so live reload silently stopped for exactly the vaults the read
		// fallback exists for.
		expect(await store.externallyChanged("p1")).toBe(true);
	});
});

describe("a bare .tmp recovery becomes a real sidecar", () => {
	// Recovering the content and leaving it in the .tmp meant the only copy
	// on disk was still the scratch file the next save writes to - so that
	// save opened by overwriting the very bytes it had recovered from, and a
	// failure mid-write took them with it.
	it("promotes the tmp into the live path", async () => {
		fake.files.set(".handwriting/p1.json.tmp", JSON.stringify(pageWith("p1", "interrupted")));
		fake.mtimes.set(".handwriting/p1.json.tmp", 42);

		const r = await store.load("p1");
		expect(r?.recovered).toBe(true);
		expect(r?.data.strokes.map((s) => s.id)).toEqual(["interrupted"]);
		expect(fake.files.has(".handwriting/p1.json")).toBe(true);
		expect(fake.files.has(".handwriting/p1.json.tmp")).toBe(false);
	});

	it("so the next save has something to fall back to", async () => {
		fake.files.set(".handwriting/p1.json.tmp", JSON.stringify(pageWith("p1", "interrupted")));
		fake.mtimes.set(".handwriting/p1.json.tmp", 42);
		await store.load("p1");

		// A save that never lands must not take the recovered page with it.
		fake.failWriteTimes = 99;
		store.schedule("p1", pageWith("p1", "next"));
		await settle();
		expect(fake.files.get(".handwriting/p1.json")).toContain("interrupted");
	});

	it("does not promote a tmp that will not parse", async () => {
		// Damage may still be recoverable by hand, and a corrupt file in the
		// live path is worse than one in a .tmp nobody reads.
		fake.files.set(".handwriting/p1.json.tmp", "{ not json");
		fake.mtimes.set(".handwriting/p1.json.tmp", 42);

		const r = await store.load("p1");
		expect(r?.damaged).toBe(true);
		expect(fake.files.has(".handwriting/p1.json")).toBe(false);
		expect(fake.files.has(".handwriting/p1.json.tmp")).toBe(true);
	});
});
