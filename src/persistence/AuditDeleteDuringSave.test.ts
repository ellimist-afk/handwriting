/**
 * Deleting a note while its save is in flight.
 *
 * remove() drops the page's known mtime and stamp at once, but a save that has
 * already left the queue is still on its way to the external-revision guard.
 * When it gets there, nothing is known, so this session's own last file reads
 * as another device's: it is moved to a conflict copy and announced, for a note
 * the user just deleted. Nothing is lost; the copy and the notice are false.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore } from "./PageStore";
import { FakeAdapter, gate } from "./FakeAdapter";
import { PageData, emptyPage } from "../model/PageData";

const DEBOUNCE_MS = 700;

function pageWithInk(id: string, ...strokeIds: string[]): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = strokeIds.map((sid) => ({
		id: sid,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
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
let store: PageStore;

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
});

describe("deleting a note while its save is in flight", () => {
	it("leaves no conflict copy and announces no conflict", async () => {
		const conflicts: string[] = [];
		store.onConflict = (_id, keptAs) => conflicts.push(keptAs);

		// The page's own file lands first, so this session knows its bytes.
		store.schedule("p1", pageWithInk("p1", "a"));
		await vi.runAllTimersAsync();
		expect([...fake.files.keys()].some((k) => k.includes("p1") && !k.endsWith(".tmp"))).toBe(true);

		// One more stroke; its save leaves the queue and stalls in the write.
		store.schedule("p1", pageWithInk("p1", "a", "b"));
		const g = gate();
		fake.writeGate = g.promise;
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
		expect(fake.writeAttempts).toBeGreaterThan(1);

		// The note is deleted while that save is in flight.
		const removing = store.remove("p1");
		fake.writeGate = null;
		g.release();
		await vi.runAllTimersAsync();
		await removing;
		await vi.runAllTimersAsync();

		const conflictFiles = [...fake.files.keys()].filter((k) => k.includes(".conflict-"));
		expect(conflictFiles, JSON.stringify([...fake.files.keys()])).toEqual([]);
		expect(conflicts).toEqual([]);
	});
});
