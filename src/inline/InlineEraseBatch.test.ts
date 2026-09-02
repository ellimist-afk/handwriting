/**
 * One persist per erase gesture (audit item 5, 2026-09-01).
 *
 * A partial erase takes each covered stroke out and puts its survivors back
 * at the same index, once per pointer sample. Removal was already on the
 * live path (`takeLive`), but the reinsertion went through `applyAdd`, which
 * persists - so every sample scheduled a write of the whole page, at input
 * rate, during the one gesture already doing splitting and repainting. The
 * eraser's pen-up calls `save()` and has said "one persist per gesture,
 * never on the erase hot path" in a comment the whole time; `applyAddLive`
 * is what makes that true.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { InkStroke } from "../ink/Stroke";
import { PageData, ParseResult, emptyPage } from "../model/PageData";
import { InlineInkHost, InlineInkStore } from "./InlineInkStore";

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 0 },
		createdAt: 0,
	};
}

function pageWith(id: string, ...strokeIds: string[]): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = strokeIds.map(stroke);
	return p;
}

class FakeHost implements InlineInkHost {
	sidecars = new Map<string, ParseResult>();
	scheduled: string[] = [];
	readPageId(path: string): string | null {
		return path === "note.md" ? "p1" : null;
	}
	async claimId(_path: string, proposedId: string): Promise<{ pageId: string }> {
		return { pageId: proposedId };
	}
	async loadSidecar(pageId: string): Promise<ParseResult | null> {
		return this.sidecars.get(pageId) ?? null;
	}
	scheduleSidecar(pageId: string): void {
		this.scheduled.push(pageId);
	}
	notify(): void {}
}

describe("applyAddLive", () => {
	let store: InlineInkStore;
	let host: FakeHost;

	beforeEach(async () => {
		store = new InlineInkStore();
		host = new FakeHost();
		store.attachHost(host);
		host.sidecars.set("p1", { data: pageWith("p1", "a", "b"), recovered: false });
		await store.ensureLoaded("note.md");
		host.scheduled = [];
	});

	it("schedules nothing, however many samples the eraser takes", () => {
		// A single slow drag across one stroke is easily this many samples.
		for (let i = 0; i < 40; i++) {
			const taken = store.takeLive("note.md", ["a"]);
			store.applyAddLive("note.md", [stroke(`piece-${i}`)], [taken[0]!.index]);
			store.takeLive("note.md", [`piece-${i}`]);
			store.applyAddLive("note.md", [stroke("a")], [0]);
		}
		expect(host.scheduled).toEqual([]);
	});

	it("still puts the pieces back where they were", () => {
		const [taken] = store.takeLive("note.md", ["a"]);
		expect(taken!.index).toBe(0);
		store.applyAddLive("note.md", [stroke("a1"), stroke("a2")], [0, 1]);
		expect(store.strokes("note.md").map((s) => s.id)).toEqual(["a1", "a2", "b"]);
	});

	it("is idempotent by id, like applyAdd", () => {
		store.applyAddLive("note.md", [stroke("b")], [0]);
		expect(store.strokes("note.md").map((s) => s.id)).toEqual(["a", "b"]);
	});

	it("the gesture's own save is what reaches disk", () => {
		store.takeLive("note.md", ["a"]);
		store.applyAddLive("note.md", [stroke("a1")], [0]);
		expect(host.scheduled).toEqual([]);
		store.save("note.md");
		expect(host.scheduled).toEqual(["p1"]);
	});

	it("applyAdd still persists - history and paste depend on it", () => {
		// An undone erase that only changed the screen would resurrect on
		// reload, so the do/undo primitives must keep writing.
		store.applyAdd("note.md", [stroke("c")]);
		expect(host.scheduled).toEqual(["p1"]);
	});
});
