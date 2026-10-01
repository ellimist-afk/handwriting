import { afterEach, expect, it, vi } from "vitest";
import { emptyPage, serializePage, type PageData } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import { applyForkDecision, listForks, recordFork, resetForks, type ForkRecord } from "../persistence/ForkResolution";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); resetForks(); });

function page(id: string, strokeId: string): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = [{ id: strokeId, tool: "pen", color: "#000000", width: 2,
		points: [{ x: 0, y: 0, pressure: 0.5, t: 0 }, { x: 10, y: 0, pressure: 0.5, t: 8 }],
		bbox: { x: 0, y: 0, width: 10, height: 0 }, createdAt: 0 }];
	return p;
}

it("B1-003 does not report a durable keep-mine write when PageStore caught a failed attempt", async () => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
	resetForks();
	const id = "504fdb34-aed8-42a0-8df8-66f7db7a02de";
	const live = `.handwriting/${id}.json`;
	const outgoing = `.handwriting/${id}.conflict-outgoing.json`;
	const incoming = `.handwriting/${id}.conflict-incoming.json`;
	const adapter = new FakeAdapter();
	adapter.externalWrite(live, serializePage(page(id, "theirs")));
	adapter.externalWrite(outgoing, serializePage(page(id, "mine")));
	adapter.externalWrite(incoming, serializePage(page(id, "theirs")));
	const store = new PageStore({ vault: { adapter } }, ".handwriting");
	expect((await store.load(id))?.data.strokes.map((s) => s.id)).toEqual(["theirs"]);
	const rec: ForkRecord = { pageId: id, path: "two-devices.md", outgoingPath: outgoing, incomingPath: incoming, at: 1 };
	recordFork(rec);
	adapter.failWriteTimes = 1;
	const outcome = await applyForkDecision({
		read: async (path) => adapter.files.get(path) ?? null,
		stat: async (path) => adapter.stat(path),
		saveNow: (pageId, data) => store.saveNow(pageId, data),
	}, rec, "keep-mine");

	// A future retry may land mine, but at this instant the real store has only
	// completed the failed attempt; both recovery artifacts still exist.
	expect(adapter.writeAttempts).toBeGreaterThan(0);
	expect(store.hasQueuedWrite(id)).toBe(true);
	expect(adapter.files.get(live)).toContain("theirs");
	expect(adapter.files.has(outgoing) && adapter.files.has(incoming)).toBe(true);
	expect(outcome).not.toMatchObject({ kind: "applied", wrote: true, stillListed: false });
	expect(listForks().some((f) => f.pageId === id)).toBe(true);
});
