import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore } from "./PageStore";
import { FakeAdapter, gate } from "./FakeAdapter";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";

const LIVE = ".handwriting/p1.json";

function pageWith(...strokeIds: string[]): PageData {
	const p = emptyPage("p1");
	p.surface = "inline";
	p.strokes = strokeIds.map((sid) => ({
		id: sid,
		tool: "pen",
		color: "#4b7bec",
		width: 2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 0 },
		createdAt: 0,
	})) as PageData["strokes"];
	return p;
}

function idsOnDisk(fake: FakeAdapter): string[] {
	const t = fake.files.get(LIVE);
	return t === undefined ? [] : parsePage(t, "p1").data.strokes.map((s) => s.id);
}

let fake: FakeAdapter;
let store: PageStore;

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	fake.files.set(LIVE, serializePage(pageWith("a0")));
	fake.mtimes.set(LIVE, ++fake.clock);
	store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
});

describe("an older failed save, retried, never lands over a newer save that already landed", () => {
	it("debounced: A stalls then fails, B (newer) lands behind it; A's retry must not replace B", async () => {
		await store.load("p1");
		const g = gate();
		fake.writeGate = g.promise;

		// Save A leaves the queue and stalls at its .tmp write (slow disk / sync lock).
		store.schedule("p1", pageWith("a0", "a1"));
		await vi.advanceTimersByTimeAsync(701);
		expect(fake.writeAttempts, "precondition: A is in flight").toBe(1);

		// The user keeps drawing; B's debounce fires and B queues behind A.
		store.schedule("p1", pageWith("a0", "a1", "b1"));
		await vi.advanceTimersByTimeAsync(701);

		// A's write fails (transient EBUSY/EIO); B's goes through.
		fake.failWriteTimes = 1;
		fake.writeGate = null;
		g.release();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(idsOnDisk(fake), "precondition: B landed").toEqual(["a0", "a1", "b1"]);

		// Nothing new drawn. Let every retry timer run, then the view closes.
		await vi.advanceTimersByTimeAsync(10_000);
		await store.flush();

		expect(idsOnDisk(fake), "b1 was overwritten by A's stale retry").toEqual(["a0", "a1", "b1"]);
	});

	it("saveNow: B chained behind a failing A; A's retry must not replace B", async () => {
		await store.load("p1");
		const g = gate();
		fake.writeGate = g.promise;
		const a = store.saveNow("p1", pageWith("a0", "a1"));
		await vi.advanceTimersByTimeAsync(0);
		const b = store.saveNow("p1", pageWith("a0", "a1", "b1"));
		fake.failWriteTimes = 1;
		fake.writeGate = null;
		g.release();
		await a;
		await b;
		expect(idsOnDisk(fake), "precondition: B landed").toEqual(["a0", "a1", "b1"]);
		await vi.advanceTimersByTimeAsync(10_000);
		await store.flush();
		expect(idsOnDisk(fake), "b1 was overwritten by A's stale retry").toEqual(["a0", "a1", "b1"]);
	});

	it("A and B both fail back-to-back (same lock): B must stay queued, not be dropped for the older A", async () => {
		await store.load("p1");
		const g = gate();
		fake.writeGate = g.promise;
		store.schedule("p1", pageWith("a0", "a1"));
		await vi.advanceTimersByTimeAsync(701);
		store.schedule("p1", pageWith("a0", "a1", "b1"));
		await vi.advanceTimersByTimeAsync(701);

		// The lock fails A and then B, which runs right behind it.
		fake.failWriteTimes = 2;
		fake.writeGate = null;
		g.release();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);

		// The lock clears; retries run; the view closes.
		await vi.advanceTimersByTimeAsync(10_000);
		await store.flush();
		expect(idsOnDisk(fake), "b1 was dropped: the older failed A occupied the queue").toEqual(["a0", "a1", "b1"]);
	});
});
