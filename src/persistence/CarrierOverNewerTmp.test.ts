import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageData, emptyPage, serializePage } from "../model/PageData";

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

let fake: FakeAdapter;

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	fake.files.set(LIVE, serializePage(pageWith("a0")));
	fake.mtimes.set(LIVE, ++fake.clock);
});

describe("an interrupted save newer than a leftover flush carrier is not discarded at load", () => {
	it("carrier holds P1, the interrupted .tmp holds P2 (newer), no live file: load returns P2", async () => {
		const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
		await store.load("p1");

		// Window hidden: the carrier for P1 lands; P1's chained normal write fails
		// once (EPERM/EBUSY on the rename into place - a sync client or AV lock).
		store.schedule("p1", pageWith("a0", "a1"));
		// Only the .tmp-to-live rename fails (re-staged for L1, ORDER-L1.md step 3):
		// the save sequence also renames the live file aside (R5), and the
		// injected failure must hit the same rename before and after that change.
		fake.failRenameWhen = (from) => from.endsWith(".tmp");
		fake.failRenameTimes = 1;
		store.flushDispatch();
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.files.has(`${LIVE}.flush`), "precondition: carrier on disk").toBe(true);

		// The user draws a2. Its save writes the .tmp, and the process dies
		// before the rename into place lands.
		fake.renameGate = new Promise<void>(() => {});
		store.schedule("p1", pageWith("a0", "a1", "a2"));
		await vi.advanceTimersByTimeAsync(800);
		expect(fake.files.has(`${LIVE}.tmp`), "precondition: P2's .tmp on disk").toBe(true);
		expect(fake.files.has(LIVE), "precondition: no live file").toBe(false);

		// Restart.
		fake.renameGate = null;
		const fresh = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 6_000_000);
		const loaded = await fresh.load("p1");
		expect(loaded?.data.strokes.map((s) => s.id), "a2 lost: the older carrier won over the newer .tmp").toEqual([
			"a0",
			"a1",
			"a2",
		]);
	});
});
