/**
 * Persistence gate (2026-08-22): the two PageStore items.
 *
 *   H6  a maximum dirty interval anchored to the first unsaved change, on top
 *       of the unchanged 700 ms quiet-period debounce;
 *   H4  a corrupt main file beside its own complete .tmp is recovered from
 *       the .tmp, the corrupt bytes kept under a collision-proof name, and
 *       every lesser case keeps the read-only lock.
 *
 * Fake timers and a gated adapter throughout. PageStore.test.ts (the
 * existing fault-injection suite) is untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import * as PageStoreModule from "./PageStore";
import { PageStore } from "./PageStore";
import { FakeAdapter, gate } from "./FakeAdapter";

// Read through the namespace so the failing-first run on the unpatched base
// reports "the bound is five seconds" as a failed test, not a module load error.
const MAX_DIRTY_MS = (PageStoreModule as unknown as { MAX_DIRTY_MS?: number }).MAX_DIRTY_MS;
import { PageData, emptyPage } from "../model/PageData";

const FINAL = ".handwriting/p1.json";
const TMP = ".handwriting/p1.json.tmp";

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

function serialize(id: string, label: string, schemaVersion = 1): string {
	return JSON.stringify({
		schemaVersion,
		pageId: id,
		surface: "inline",
		textBoxes: [],
		images: [],
		strokes: pageWith(id, label).strokes,
	});
}

function labelOf(text: string | undefined): string | undefined {
	return text === undefined ? undefined : /"id":"([^"]+)"/.exec(text)?.[1];
}

let fake: FakeAdapter;
let store: PageStore;

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	store = new PageStore({ vault: { adapter: fake } });
});

afterEach(() => {
	vi.useRealTimers();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2000);
}

describe("H6 — maximum dirty interval (MAX_DIRTY_MS on top of the quiet period)", () => {
	it("the bound is five seconds", () => {
		expect(MAX_DIRTY_MS).toBe(5000);
	});

	it("a single change still saves after the 700 ms quiet period", async () => {
		store.schedule("p1", pageWith("p1", "one"));
		await vi.advanceTimersByTimeAsync(699);
		expect(fake.writes()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(0);
		expect(labelOf(fake.files.get(FINAL))).toBe("one");
	});

	it("repeated changes reset the quiet timer but never the five-second maximum", async () => {
		// Initial disk state: nothing. Held open: nothing. The mutation is a
		// change every 500 ms, each inside the quiet period of the last.
		for (let i = 0; i < 9; i++) {
			store.schedule("p1", pageWith("p1", `s${i}`));
			await vi.advanceTimersByTimeAsync(500);
			expect(fake.writes()).toHaveLength(0); // quiet timer keeps resetting
		}
		store.schedule("p1", pageWith("p1", "s9")); // t = 4500 ms
		await vi.advanceTimersByTimeAsync(499); // t = 4999 ms
		expect(fake.writes()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1); // t = 5000 ms: the maximum fires
		await vi.advanceTimersByTimeAsync(0);
		// Resulting disk state: ONE write, holding the latest complete snapshot.
		expect(fake.writes()).toHaveLength(1);
		expect(labelOf(fake.files.get(FINAL))).toBe("s9");
	});

	it("continuous changes cannot defer the first write past five seconds (gated adapter)", async () => {
		const g = gate();
		fake.writeGate = g.promise;
		for (let i = 0; i < 12; i++) {
			store.schedule("p1", pageWith("p1", `c${i}`));
			await vi.advanceTimersByTimeAsync(500);
			if (i < 9) expect(fake.writeAttempts).toBe(0);
		}
		// The write was ATTEMPTED at t = 5000 ms even though the adapter is
		// still holding it, and no second write was started behind it.
		expect(fake.writeAttempts).toBe(1);
		g.release();
		fake.writeGate = null;
		await settle();
		expect(labelOf(fake.files.get(FINAL))).toBe("c11"); // the later changes followed
	});

	it("changes arriving during a write remain pending for the next write", async () => {
		const g = gate();
		fake.writeGate = g.promise;
		store.schedule("p1", pageWith("p1", "A"));
		await vi.advanceTimersByTimeAsync(700); // A's write starts and is held
		expect(fake.writeAttempts).toBe(1);
		store.schedule("p1", pageWith("p1", "B")); // arrives mid-write
		g.release();
		fake.writeGate = null;
		await settle();
		expect(fake.writes()).toHaveLength(2);
		expect(labelOf(fake.files.get(FINAL))).toBe("B");
	});

	it("writes for one sidecar stay serialized under the maximum", async () => {
		const g = gate();
		fake.writeGate = g.promise;
		store.schedule("p1", pageWith("p1", "A"));
		await vi.advanceTimersByTimeAsync(700); // A held
		store.schedule("p1", pageWith("p1", "B"));
		await vi.advanceTimersByTimeAsync(5500); // B's quiet AND maximum timers both fire meanwhile
		expect(fake.writeAttempts).toBe(1); // B waits behind A on the queue
		g.release();
		fake.writeGate = null;
		await settle();
		const order = fake.log.filter((l) => l.startsWith("rename") && l.endsWith(`-> ${FINAL}`));
		expect(order).toHaveLength(2);
		expect(labelOf(fake.files.get(FINAL))).toBe("B");
	});

	it("a failed maximum-wait write follows the existing bounded retry path", async () => {
		const errors: string[] = [];
		store.onWriteError = (id) => errors.push(id);
		fake.failWriteTimes = 1;
		for (let i = 0; i < 11; i++) {
			store.schedule("p1", pageWith("p1", `f${i}`));
			await vi.advanceTimersByTimeAsync(500);
		}
		// t = 5500 ms: the maximum fired at 5000 and the write was ATTEMPTED
		// and FAILED. Nothing on disk yet, the state is still pending, no
		// error surfaced (the quiet timer alone would not have tried before
		// t = 5700).
		expect(fake.writeAttempts).toBe(1);
		expect(fake.files.has(FINAL)).toBe(false);
		expect(errors).toHaveLength(0);
		await settle(); // the bounded 1.5 s retry lands
		expect(labelOf(fake.files.get(FINAL))).toBe("f10");
		expect(errors).toHaveLength(0);
	});

	it("no permanent timer remains once everything is written", async () => {
		for (let i = 0; i < 12; i++) {
			store.schedule("p1", pageWith("p1", `t${i}`));
			await vi.advanceTimersByTimeAsync(500);
		}
		await settle();
		expect(labelOf(fake.files.get(FINAL))).toBe("t11");
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("H4 — corrupt main file beside its own complete .tmp", () => {
	const GARBAGE = "{ garbage ///";

	it("promotes the valid .tmp, keeps the corrupt bytes under a collision-proof name, and notifies", async () => {
		// 1. Initial disk state: main file corrupt, .tmp a complete page for p1.
		fake.externalWrite(FINAL, GARBAGE);
		const damagedMtime = fake.mtimes.get(FINAL)!;
		fake.externalWrite(TMP, serialize("p1", "FROM-TMP"));
		const recovered: Array<{ id: string; keptAs: string }> = [];
		store.onRecovered = (id, keptAs) => recovered.push({ id, keptAs });
		// 2./3. The operation is the load itself; nothing else mutates.
		const r = await store.load("p1");
		// 4. Resulting disk state: the .tmp is now the main file, the corrupt
		//    bytes are kept beside it, nothing was deleted.
		expect(labelOf(fake.files.get(FINAL))).toBe("FROM-TMP");
		expect(fake.files.has(TMP)).toBe(false);
		const keptAs = `.handwriting/p1.damaged-${damagedMtime}.json`;
		expect(fake.files.get(keptAs)).toBe(GARBAGE);
		// 5. The assertion: the page is usable, not read-only, and the user
		//    was told what happened and where the damaged file is.
		expect(r?.damaged).toBeFalsy();
		expect(r?.recovered).toBe(true);
		expect(r?.data.strokes[0]?.id).toBe("FROM-TMP");
		expect(r?.damagedKeptAs).toBe(keptAs);
		expect(recovered).toEqual([{ id: "p1", keptAs }]);
	});

	it("the promoted state is this session's own: the next save is not a false conflict", async () => {
		fake.externalWrite(FINAL, GARBAGE);
		fake.externalWrite(TMP, serialize("p1", "FROM-TMP"));
		await store.load("p1");
		const conflicts: string[] = [];
		store.onConflict = (_id, keptAs) => conflicts.push(keptAs);
		store.schedule("p1", pageWith("p1", "NEXT"));
		await settle();
		expect(conflicts).toHaveLength(0);
		expect(labelOf(fake.files.get(FINAL))).toBe("NEXT");
	});

	it("a second damaged copy wanting the same name gets a counter, never an overwrite", async () => {
		fake.externalWrite(FINAL, GARBAGE);
		const m = fake.mtimes.get(FINAL)!;
		fake.externalWrite(`.handwriting/p1.damaged-${m}.json`, "EARLIER-DAMAGED-COPY");
		fake.externalWrite(TMP, serialize("p1", "FROM-TMP"));
		const r = await store.load("p1");
		expect(r?.damagedKeptAs).toBe(`.handwriting/p1.damaged-${m}-2.json`);
		expect(fake.files.get(`.handwriting/p1.damaged-${m}.json`)).toBe("EARLIER-DAMAGED-COPY");
		expect(fake.files.get(`.handwriting/p1.damaged-${m}-2.json`)).toBe(GARBAGE);
	});

	it("refuses when the .tmp is missing: read-only, nothing moved", async () => {
		fake.externalWrite(FINAL, GARBAGE);
		const r = await store.load("p1");
		expect(r?.damaged).toBe(true);
		expect(fake.files.get(FINAL)).toBe(GARBAGE);
		expect(fake.log).toHaveLength(0);
	});

	it("refuses when the .tmp is corrupt too: read-only, nothing moved", async () => {
		fake.externalWrite(FINAL, GARBAGE);
		fake.externalWrite(TMP, "{ also garbage");
		const r = await store.load("p1");
		expect(r?.damaged).toBe(true);
		expect(fake.files.get(FINAL)).toBe(GARBAGE);
		expect(fake.files.get(TMP)).toBe("{ also garbage");
		expect(fake.log).toHaveLength(0);
	});

	it("refuses when the .tmp belongs to a different page id (mismatched)", async () => {
		fake.externalWrite(FINAL, GARBAGE);
		fake.externalWrite(TMP, serialize("p9", "OTHER-PAGE"));
		const r = await store.load("p1");
		expect(r?.damaged).toBe(true);
		expect(fake.files.get(FINAL)).toBe(GARBAGE);
		expect(fake.log).toHaveLength(0);
	});

	it("refuses when the .tmp declares an unsupported future schema", async () => {
		fake.externalWrite(FINAL, GARBAGE);
		fake.externalWrite(TMP, serialize("p1", "FUTURE", 99));
		const r = await store.load("p1");
		expect(r?.damaged).toBe(true);
		expect(fake.files.get(FINAL)).toBe(GARBAGE);
		expect(fake.log).toHaveLength(0);
	});

	it("never guesses between two VALID files, whatever their timestamps say", async () => {
		fake.externalWrite(FINAL, serialize("p1", "LIVE"));
		fake.externalWrite(TMP, serialize("p1", "NEWER-TMP")); // newer mtime
		const r = await store.load("p1");
		expect(r?.recovered).toBeFalsy();
		expect(r?.data.strokes[0]?.id).toBe("LIVE");
		expect(fake.log).toHaveLength(0);
	});

	it("a promotion whose final rename fails leaves a state a fresh load still recovers from", async () => {
		fake.externalWrite(FINAL, GARBAGE);
		fake.externalWrite(TMP, serialize("p1", "FROM-TMP"));
		fake.failRenameTimes = 1;
		fake.failRenameWhen = (_from, to) => to === FINAL;
		const r = await store.load("p1");
		expect(r?.damaged).toBe(true); // this session stays read-only
		// Disk: corrupt bytes kept, main missing, .tmp intact — the bare
		// interrupted-write recovery path takes it from here.
		expect(fake.files.has(FINAL)).toBe(false);
		expect(fake.files.get(TMP)).toContain("FROM-TMP");
		const again = await new PageStore({ vault: { adapter: fake } }).load("p1");
		expect(again?.recovered).toBe(true);
		expect(again?.data.strokes[0]?.id).toBe("FROM-TMP");
	});

	// ---- the decision is re-proven on the queue, not carried onto it --------
	//
	// Recovery screens both files, then waits its turn behind pending writes.
	// A save, a sync or another device can land in that gap. These stage the
	// gap deterministically: a stalled write for an unrelated page occupies
	// the queue, the files are changed while recovery waits, and the queue is
	// released. Acting on the screening reading instead of re-reading is how a
	// main file that has become readable gets renamed away as "damaged".

	/** Hold the write queue open, so a queued recovery cannot run yet. */
	async function occupyQueue(): Promise<{ release: () => void }> {
		const g = gate();
		fake.writeGate = g.promise;
		store.schedule("p2", pageWith("p2", "UNRELATED"));
		await vi.advanceTimersByTimeAsync(800); // quiet period fires; write stalls
		expect(fake.writeAttempts).toBe(1);
		return {
			release: () => {
				g.release();
				fake.writeGate = null;
			},
		};
	}

	it("a valid main file that replaced the corrupt one while recovery waited is kept, and the .tmp is not promoted", async () => {
		fake.externalWrite(FINAL, GARBAGE);
		fake.externalWrite(TMP, serialize("p1", "FROM-TMP"));
		const recovered: string[] = [];
		store.onRecovered = (id) => recovered.push(id);
		const held = await occupyQueue();

		const loading = store.load("p1"); // screens both files, then queues
		await vi.advanceTimersByTimeAsync(0);

		// Another device finishes the repair while we wait our turn.
		fake.externalWrite(FINAL, serialize("p1", "REPAIRED"));

		held.release();
		await settle();
		const r = await loading;

		// The repaired file survives, and it is what the caller is told about.
		expect(labelOf(fake.files.get(FINAL))).toBe("REPAIRED");
		expect(r?.damaged).toBeFalsy();
		expect(r?.data.strokes[0]?.id).toBe("REPAIRED");
		// The interrupted save is left exactly where it was.
		expect(labelOf(fake.files.get(TMP))).toBe("FROM-TMP");
		// Nothing was moved aside, and the user was told no story about it.
		expect(fake.log.some((l) => l.includes("damaged-"))).toBe(false);
		expect(recovered).toEqual([]);
	});

	it("a .tmp that CHANGED while recovery waited is not promoted: both files untouched", async () => {
		fake.externalWrite(FINAL, GARBAGE);
		fake.externalWrite(TMP, serialize("p1", "SCREENED"));
		const recovered: string[] = [];
		store.onRecovered = (id) => recovered.push(id);
		const held = await occupyQueue();

		const loading = store.load("p1");
		await vi.advanceTimersByTimeAsync(0);

		// A newer interrupted save lands: still valid, but NOT what was judged.
		fake.externalWrite(TMP, serialize("p1", "MOVED-ON"));

		held.release();
		await settle();
		const r = await loading;

		expect(fake.files.get(FINAL)).toBe(GARBAGE);
		expect(labelOf(fake.files.get(TMP))).toBe("MOVED-ON");
		expect(r?.damaged).toBe(true); // read-only, as before
		expect(fake.log.some((l) => l.includes("damaged-"))).toBe(false);
		expect(recovered).toEqual([]);
	});

	it("a .tmp that became CORRUPT while recovery waited is not promoted: both files untouched", async () => {
		fake.externalWrite(FINAL, GARBAGE);
		fake.externalWrite(TMP, serialize("p1", "SCREENED"));
		const held = await occupyQueue();

		const loading = store.load("p1");
		await vi.advanceTimersByTimeAsync(0);

		// The interrupted save is itself truncated mid-flight.
		fake.externalWrite(TMP, '{ "schemaVersion": 1, "pageI');

		held.release();
		await settle();
		const r = await loading;

		expect(fake.files.get(FINAL)).toBe(GARBAGE);
		expect(fake.files.get(TMP)).toBe('{ "schemaVersion": 1, "pageI');
		expect(r?.damaged).toBe(true);
		expect(fake.log.some((l) => l.includes("damaged-"))).toBe(false);
	});

	it("unchanged corrupt main file plus unchanged valid .tmp still recovers after the wait", async () => {
		fake.externalWrite(FINAL, GARBAGE);
		const damagedMtime = fake.mtimes.get(FINAL)!;
		fake.externalWrite(TMP, serialize("p1", "FROM-TMP"));
		const recovered: Array<{ id: string; keptAs: string }> = [];
		store.onRecovered = (id, keptAs) => recovered.push({ id, keptAs });
		const held = await occupyQueue();

		const loading = store.load("p1");
		await vi.advanceTimersByTimeAsync(0);
		// Nothing changes in the gap.
		held.release();
		await settle();
		const r = await loading;

		// Re-proving the decision does not cost us the recovery.
		expect(r?.recovered).toBe(true);
		expect(r?.damaged).toBeFalsy();
		expect(r?.data.strokes[0]?.id).toBe("FROM-TMP");
		const keptAs = `.handwriting/p1.damaged-${damagedMtime}.json`;
		expect(fake.files.get(keptAs)).toBe(GARBAGE);
		expect(labelOf(fake.files.get(FINAL))).toBe("FROM-TMP");
		expect(fake.files.has(TMP)).toBe(false);
		expect(recovered).toEqual([{ id: "p1", keptAs }]);
	});
});
