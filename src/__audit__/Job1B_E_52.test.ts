/**
 * Job1B_E_52: clearing a duplicate-id lock must save ink edits made while locked.
 * Real InlineInkStore; host models PageStore as a queue flushed to a fake disk.
 * Assertions state the CORRECT behaviour: red = bug.
 */
import { describe, expect, it } from "vitest";
import type { InkStroke } from "../ink/Stroke";

(globalThis as { window?: unknown }).window = globalThis;
import { InlineInkStore } from "../inline/InlineInkStore";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { emptyPage, type PageData } from "../model/PageData";

function stroke(id: string): InkStroke {
	return {
		id, color: "#000", width: 2, tool: "pen",
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

async function restartStrokes(disk: Record<string, PageData>): Promise<string[]> {
	const w = makeWorld(disk);
	const s = new InlineInkStore();
	s.attachHost(w.host);
	await s.ensureLoaded("a.md");
	return s.strokes("a.md").map((x) => x.id);
}

describe("Job1B_E_52: ink edits made under a duplicate lock are saved when it clears", () => {
	it("case 1 (report, control): a stroke drawn while locked is on disk after unlock + quit", async () => {
		const disk: Record<string, PageData> = { shared: inlinePage("shared", ["orig"]) };
		const w = makeWorld(disk);
		const store = new InlineInkStore();
		store.attachHost(w.host);
		store.markDuplicateLocked("a.md", "copy.md");
		await store.ensureLoaded("a.md");
		store.commit("a.md", stroke("drawn-while-locked"));
		expect(w.queued.size).toBe(0);
		store.clearDuplicateLock("a.md");
		expect(await store.settle()).toBe(true);
		w.flush();
		expect(await restartStrokes(disk)).toEqual(["orig", "drawn-while-locked"]);
	});

	it("case 2 (residual): erasing all ink while locked is on disk after unlock + quit", async () => {
		const disk: Record<string, PageData> = { shared: inlinePage("shared", ["orig"]) };
		const w = makeWorld(disk);
		const store = new InlineInkStore();
		store.attachHost(w.host);
		store.markDuplicateLocked("a.md", "copy.md");
		await store.ensureLoaded("a.md");
		const removed = store.applyRemove("a.md", ["orig"]);
		expect(removed.map((r) => r.stroke.id)).toEqual(["orig"]);
		expect(store.strokes("a.md")).toEqual([]);
		expect(w.queued.size).toBe(0);
		store.clearDuplicateLock("a.md");
		expect(w.notices.some((n) => n.includes("saves again"))).toBe(true);
		expect(await store.settle()).toBe(true);
		w.flush();
		expect(await restartStrokes(disk), "erased-while-locked ink comes back at restart").toEqual([]);
	});
});
