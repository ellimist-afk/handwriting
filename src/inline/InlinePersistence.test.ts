/**
 * Persistence gate (2026-08-22): the inline store wired to a REAL PageStore
 * over the fake adapter, with fake timers, so every assertion is about what
 * reaches disk.
 *
 *   H1  a mutation made while the initial sidecar load is pending is applied
 *       after the persisted state is adopted; no save ever contains only the
 *       in-memory mutation while omitting strokes already on disk;
 *   H3  first-stroke identity claims are tracked, the first write after a
 *       claim is immediate, and settle() waits for claims and their writes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { InkStroke } from "../ink/Stroke";
import { PageData, emptyPage, parsePage } from "../model/PageData";
import { FakeAdapter, gate } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import { InlineInkHost, InlineInkStore } from "./InlineInkStore";

const NOTE = "n.md";
const PID = "pid";
const FINAL = ".handwriting/pid.json";

function stroke(id: string, x = 10): InkStroke {
	return {
		id,
		color: "#000",
		width: 2,
		tool: "pen",
		points: [
			{ x, y: 10, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: x - 2, y: 8, width: 16, height: 16 },
		createdAt: 1,
	} as InkStroke;
}

function serialize(id: string, strokeIds: string[]): string {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = strokeIds.map((s) => stroke(s));
	return JSON.stringify({
		schemaVersion: 1,
		pageId: p.pageId,
		surface: p.surface,
		textBoxes: [],
		images: [],
		strokes: p.strokes,
	});
}

function idsOnDisk(fake: FakeAdapter): string[] | null {
	const text = fake.files.get(FINAL);
	if (text === undefined) return null;
	return parsePage(text, PID).data.strokes.map((s) => s.id);
}

interface Rig {
	ink: InlineInkStore;
	store: PageStore;
	fake: FakeAdapter;
	claims: number;
	notices: string[];
	releaseLoad: () => void;
	releaseClaim: () => void;
}

function rig(opts: {
	idInCache: string | null;
	holdLoad?: boolean;
	holdClaim?: boolean;
	claimFails?: () => boolean;
}): Rig {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } });
	const loadGate = gate();
	const claimGate = gate();
	const r: Rig = {
		ink: new InlineInkStore(),
		store,
		fake,
		claims: 0,
		notices: [],
		releaseLoad: loadGate.release,
		releaseClaim: claimGate.release,
	};
	const host: InlineInkHost = {
		readPageId: () => opts.idInCache,
		claimId: async () => {
			r.claims++;
			if (opts.holdClaim) await claimGate.promise;
			if (opts.claimFails?.()) throw new Error("EACCES frontmatter");
			// The stamped id is the known one, so every assertion can look at
			// one sidecar path. (Returning an id other than the proposed one
			// also exercises the "file already carried an id" adopt path.)
			return { pageId: PID };
		},
		loadSidecar: async (id) => {
			if (opts.holdLoad) await loadGate.promise;
			return store.load(id);
		},
		scheduleSidecar: (id, page) => store.schedule(id, page),
		scheduleSidecarNow: (id, page) => store.saveNow(id, page),
		notify: (m) => r.notices.push(m),
	};
	r.ink.attachHost(host);
	return r;
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
});

afterEach(() => {
	vi.useRealTimers();
});

/** Past every save timer: the 700 ms quiet period, the 5 s maximum, retries. */
async function pastEveryTimer(): Promise<void> {
	for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2000);
}

describe("H1 — load-before-write race", () => {
	it("decisive: stroke B committed while A's sidecar read is open is saved WITH A, never instead of A", async () => {
		// 1. Initial disk state: stroke A.
		const t = rig({ idInCache: PID, holdLoad: true });
		t.fake.externalWrite(FINAL, serialize(PID, ["A"]));
		const before = t.fake.files.get(FINAL);
		// 2. The asynchronous operation held open: the sidecar read.
		const loading = t.ink.ensureLoaded(NOTE);
		// 3. The mutation while it is held: commit B.
		t.ink.commit(NOTE, stroke("B"));
		// 4. Past every save timer. Resulting disk state: untouched.
		await pastEveryTimer();
		expect(t.fake.writes()).toHaveLength(0);
		expect(t.fake.files.get(FINAL)).toBe(before);
		// 5. No snapshot containing only B was written (and none at all).
		expect(idsOnDisk(t.fake)).toEqual(["A"]);
		// 6. Resolve the load.
		t.releaseLoad();
		await loading;
		await pastEveryTimer();
		// 7. Memory and disk hold A and B exactly once each.
		expect(t.ink.strokes(NOTE).map((s) => s.id)).toEqual(["A", "B"]);
		expect(idsOnDisk(t.fake)).toEqual(["A", "B"]);
		expect(t.fake.writes()).toHaveLength(1);
	});

	it("an erase during the load is applied after the persisted state is adopted", async () => {
		const t = rig({ idInCache: PID, holdLoad: true });
		t.fake.externalWrite(FINAL, serialize(PID, ["A"]));
		const loading = t.ink.ensureLoaded(NOTE);
		t.ink.commit(NOTE, stroke("B"));
		t.ink.applyRemove(NOTE, ["B"]); // erased again before the read returns
		await pastEveryTimer();
		expect(t.fake.writes()).toHaveLength(0);
		t.releaseLoad();
		await loading;
		await pastEveryTimer();
		expect(t.ink.strokes(NOTE).map((s) => s.id)).toEqual(["A"]);
		expect(idsOnDisk(t.fake)).toEqual(["A"]);
	});

	it("a move during the load lands on the merged record", async () => {
		const t = rig({ idInCache: PID, holdLoad: true });
		t.fake.externalWrite(FINAL, serialize(PID, ["A"]));
		const loading = t.ink.ensureLoaded(NOTE);
		t.ink.commit(NOTE, stroke("B", 10));
		t.ink.moveStrokes(NOTE, ["B"], 5, 0);
		t.ink.save(NOTE);
		await pastEveryTimer();
		expect(t.fake.writes()).toHaveLength(0);
		t.releaseLoad();
		await loading;
		await pastEveryTimer();
		expect(idsOnDisk(t.fake)).toEqual(["A", "B"]);
		const onDisk = parsePage(t.fake.files.get(FINAL)!, PID).data.strokes;
		expect(onDisk[1]?.points[0]?.x).toBe(15);
	});

	it("a stroke committed after the load completes is saved directly", async () => {
		const t = rig({ idInCache: PID });
		t.fake.externalWrite(FINAL, serialize(PID, ["A"]));
		await t.ink.ensureLoaded(NOTE);
		t.ink.commit(NOTE, stroke("B"));
		await pastEveryTimer();
		expect(idsOnDisk(t.fake)).toEqual(["A", "B"]);
	});

	it("release-separated segments enter one snapshot and one scheduled write", async () => {
		const t = rig({ idInCache: PID });
		t.fake.externalWrite(FINAL, serialize(PID, ["A"]));
		await t.ink.ensureLoaded(NOTE);
		t.ink.commitGesture(NOTE, [stroke("left"), stroke("right")]);
		await pastEveryTimer();

		expect(idsOnDisk(t.fake)).toEqual(["A", "left", "right"]);
		expect(t.fake.writes()).toHaveLength(1);
	});

	it("the damaged-file re-read is held to the same rule; a damaged file is never written", async () => {
		const t = rig({ idInCache: PID });
		t.fake.externalWrite(FINAL, "{ garbage ///");
		await t.ink.ensureLoaded(NOTE);
		expect(t.ink.isDamagedLocked(NOTE)).toBe(true);
		t.ink.commit(NOTE, stroke("X"));
		await pastEveryTimer();
		expect(t.fake.files.get(FINAL)).toBe("{ garbage ///"); // fail closed, unchanged
		// The file is repaired outside; the re-read on reopen is gated by the
		// adapter this time, and a stroke races it.
		t.fake.externalWrite(FINAL, serialize(PID, ["A"]));
		const g = gate();
		t.fake.readGate = g.promise;
		const reread = t.ink.ensureLoaded(NOTE);
		t.ink.commit(NOTE, stroke("Y"));
		await pastEveryTimer(); // the read is still open: nothing may be written
		expect(t.fake.writes()).toHaveLength(0);
		expect(t.fake.files.get(FINAL)).toBe(serialize(PID, ["A"]));
		g.release();
		t.fake.readGate = null;
		await reread;
		await pastEveryTimer();
		expect(t.ink.strokes(NOTE).map((s) => s.id)).toEqual(["A", "X", "Y"]);
		expect(idsOnDisk(t.fake)).toEqual(["A", "X", "Y"]);
	});
});

describe("H3 — first-stroke claim window", () => {
	it("settle() stays pending while the first claim is gated, and no sidecar is written before the id exists", async () => {
		const t = rig({ idInCache: null, holdClaim: true });
		await t.ink.ensureLoaded(NOTE);
		t.ink.commit(NOTE, stroke("s1"));
		let settled = false;
		const waiting = t.ink.settle().then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(t.claims).toBe(1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1500); // under settle's bound, past every save timer
		expect(t.fake.writeAttempts).toBe(0); // identity before sidecar
		expect(settled).toBe(false);
		t.releaseClaim();
		await waiting;
		expect(settled).toBe(true);
	});

	it("after the claim resolves, settle() waits until the sidecar rename completes", async () => {
		const t = rig({ idInCache: null, holdClaim: true });
		await t.ink.ensureLoaded(NOTE);
		t.ink.commit(NOTE, stroke("s1"));
		const renameGate = gate();
		t.fake.renameGate = renameGate.promise;
		let settled = false;
		const waiting = t.ink.settle().then(() => {
			settled = true;
		});
		t.releaseClaim();
		await vi.advanceTimersByTimeAsync(0);
		expect(t.fake.writeAttempts).toBe(1); // the .tmp was written at once
		expect(settled).toBe(false); // the rename has not landed
		renameGate.release();
		t.fake.renameGate = null;
		await waiting;
		expect(settled).toBe(true);
		expect(idsOnDisk(t.fake)).toEqual(["s1"]);
	});

	it("the first successful claim writes immediately, not after another 700 ms", async () => {
		const t = rig({ idInCache: null, holdClaim: true });
		await t.ink.ensureLoaded(NOTE);
		t.ink.commit(NOTE, stroke("s1"));
		t.ink.commit(NOTE, stroke("s2")); // rides the same first write
		t.releaseClaim();
		await vi.advanceTimersByTimeAsync(0); // microtasks only: no timer advanced
		expect(idsOnDisk(t.fake)).toEqual(["s1", "s2"]);
		expect(t.fake.writes()).toHaveLength(1);
	});

	it("a failed claim is visible, nothing is written, and the next stroke retries it", async () => {
		let fail = true;
		const t = rig({ idInCache: null, claimFails: () => fail });
		await t.ink.ensureLoaded(NOTE);
		t.ink.commit(NOTE, stroke("s1"));
		await t.ink.settle();
		expect(t.claims).toBe(1);
		expect(t.notices.some((m) => /page id/i.test(m))).toBe(true);
		expect(t.fake.writeAttempts).toBe(0);
		expect(t.ink.strokes(NOTE)).toHaveLength(1); // still in the session
		fail = false;
		t.ink.commit(NOTE, stroke("s2"));
		await t.ink.settle();
		expect(t.claims).toBe(2);
		expect(idsOnDisk(t.fake)).toEqual(["s1", "s2"]);
	});

	it("a failed first write stays pending, retries, and is reported if it keeps failing", async () => {
		const errors: string[] = [];
		const t = rig({ idInCache: null });
		t.store.onWriteError = (id) => errors.push(id);
		t.fake.failWriteTimes = 99;
		await t.ink.ensureLoaded(NOTE);
		t.ink.commit(NOTE, stroke("s1"));
		await t.ink.settle(); // resolves once the attempt has failed and re-queued
		expect(t.fake.files.has(FINAL)).toBe(false);
		await pastEveryTimer(); // bounded retries exhaust
		expect(errors).toHaveLength(1);
		t.fake.failWriteTimes = 0;
		await t.store.flush(); // still pending: a healed disk saves it
		expect(idsOnDisk(t.fake)).toEqual(["s1"]);
	});

	it("an untouched note performs no claim and no write", async () => {
		const t = rig({ idInCache: null });
		await t.ink.ensureLoaded(NOTE);
		await t.ink.settle();
		await pastEveryTimer();
		expect(t.claims).toBe(0);
		expect(t.fake.writeAttempts).toBe(0);
		expect(t.fake.files.size).toBe(0);
	});

	it("settle() gives up after its bound when a claim never resolves", async () => {
		const t = rig({ idInCache: null, holdClaim: true });
		await t.ink.ensureLoaded(NOTE);
		t.ink.commit(NOTE, stroke("s1"));
		let settled = false;
		const waiting = t.ink.settle(50).then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(10);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(60);
		await waiting;
		expect(settled).toBe(true);
		expect(t.fake.writeAttempts).toBe(0); // and still no write without an id
	});
});
