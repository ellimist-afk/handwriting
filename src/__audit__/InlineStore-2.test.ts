/**
 * Audit probe InlineStore-2: clearDuplicateLock re-enables saving but never
 * schedules the ink drawn while the note was duplicate-locked.
 *
 * Real InlineInkStore. The host models PageStore as a queue (scheduleSidecar)
 * that flush() writes to a fake disk, which is what finishPersistence does at
 * unload: inlineInk.settle() then store.flush(). A fresh store on the same
 * disk is the restart.
 *
 * Asserts the CORRECT behaviour: after the lock clears (the notice says
 * "saves again") and the app quits, the lock-era stroke is on disk.
 */

import { describe, expect, it } from "vitest";
import type { InkStroke } from "../ink/Stroke";

(globalThis as { window?: unknown }).window = globalThis;
import { InlineInkStore } from "../inline/InlineInkStore";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { emptyPage, type PageData } from "../model/PageData";

function stroke(id: string): InkStroke {
	return {
		id,
		color: "#000",
		width: 2,
		tool: "pen",
		points: [
			{ x: 10, y: 10, pressure: 0.5, t: 0 },
			{ x: 20, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: 8, y: 8, width: 16, height: 16 },
		createdAt: 1,
	} as InkStroke;
}

function inlinePage(pageId: string, strokeIds: string[]): PageData {
	const p = emptyPage(pageId);
	p.surface = "inline";
	for (const id of strokeIds) p.strokes.push(stroke(id));
	return p;
}

/** Fake vault + PageStore: scheduled pages queue; flush writes them to disk. */
function makeWorld(disk: Record<string, PageData>) {
	const queued = new Map<string, PageData>();
	const notices: string[] = [];
	const host: InlineInkHost = {
		readPageId: () => "shared",
		claimId: async (_path, proposed) => ({ pageId: proposed }),
		loadSidecar: async (pageId) => {
			const data = disk[pageId];
			return data ? { data: structuredClone(data), recovered: false } : null;
		},
		scheduleSidecar: (pageId, page) => {
			queued.set(pageId, structuredClone(page));
		},
		notify: (m) => notices.push(m),
	};
	const flush = () => {
		for (const [id, page] of queued) disk[id] = page;
		queued.clear();
	};
	return { host, queued, notices, flush };
}

async function ticks(): Promise<void> {
	await new Promise((r) => setTimeout(r, 0));
	await new Promise((r) => setTimeout(r, 0));
}

describe("InlineStore-2: ink drawn during a duplicate lock survives the unlock and a restart", () => {
	it("clearDuplicateLock leads to the lock-era stroke being saved", async () => {
		const disk: Record<string, PageData> = { shared: inlinePage("shared", ["orig"]) };
		const w = makeWorld(disk);
		const store = new InlineInkStore();
		store.attachHost(w.host);

		// Startup census: ambiguous duplicate, both carriers locked.
		store.markDuplicateLocked("a.md", "copy.md");
		await store.ensureLoaded("a.md");
		expect(store.strokes("a.md").map((s) => s.id)).toEqual(["orig"]);

		// User draws on A while locked: stroke renders, nothing queued.
		store.commit("a.md", stroke("drawn-while-locked"));
		await ticks();
		// Precondition: the lock is real and blocked the save.
		expect(store.isDuplicateLocked("a.md")).toBe(true);
		expect(store.strokes("a.md").map((s) => s.id)).toContain("drawn-while-locked");
		expect(w.queued.size).toBe(0);

		// User deletes the copy (or its id line): main.ts calls clearDuplicateLock(A).
		store.clearDuplicateLock("a.md");
		expect(store.isDuplicateLocked("a.md")).toBe(false);
		expect(w.notices.some((n) => n.includes("saves again"))).toBe(true);

		// Quit without drawing again: finishPersistence = settle, then flush.
		const drained = await store.settle();
		expect(drained).toBe(true);
		w.flush();

		// CORRECT: the lock-era stroke is on disk.
		expect(
			disk.shared!.strokes.map((s) => s.id),
			"lock-era stroke not written after clearDuplicateLock + unload flush"
		).toContain("drawn-while-locked");

		// Restart: a fresh store reads the same disk.
		const w2 = makeWorld(disk);
		const store2 = new InlineInkStore();
		store2.attachHost(w2.host);
		await store2.ensureLoaded("a.md");
		expect(store2.strokes("a.md").map((s) => s.id)).toContain("drawn-while-locked");
	});

	it("control: any later change after the unlock does write the lock-era stroke", async () => {
		const disk: Record<string, PageData> = { shared: inlinePage("shared", ["orig"]) };
		const w = makeWorld(disk);
		const store = new InlineInkStore();
		store.attachHost(w.host);
		store.markDuplicateLocked("a.md", "copy.md");
		await store.ensureLoaded("a.md");
		store.commit("a.md", stroke("drawn-while-locked"));
		await ticks();
		store.clearDuplicateLock("a.md");
		store.commit("a.md", stroke("after-unlock"));
		await store.settle();
		w.flush();
		expect(disk.shared!.strokes.map((s) => s.id)).toEqual(["orig", "drawn-while-locked", "after-unlock"]);
	});
});
