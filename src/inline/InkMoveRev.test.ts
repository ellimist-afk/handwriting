/**
 * A move has to announce itself.
 *
 * `moveStrokes` translates the points of the objects the store already holds
 * rather than replacing them, so anything that remembers geometry against a
 * stroke's identity - StrokeRenderer's ribbon cache - would keep drawing the
 * ink at the position it was dragged FROM. The revision registry is the
 * announcement; these pin that it fires for the strokes that moved and for
 * nobody else, on both funnels into `translateStroke`: the inline store's
 * `moveStrokes` (lasso drag, insert-space drag, and the undo/redo of either)
 * and `ObjectOps.moveObjects` (the page view).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InkStroke } from "../ink/Stroke";
import { strokeRev } from "../ink/StrokeRev";
import { PageData, ParseResult, emptyPage } from "../model/PageData";
import { moveObjects } from "../objects/ObjectOps";
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
	} as InkStroke;
}

function pageWith(id: string, ...strokeIds: string[]): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = strokeIds.map(stroke);
	return p;
}

class FakeHost implements InlineInkHost {
	sidecars = new Map<string, ParseResult>();
	readPageId(path: string): string | null {
		return path === "note.md" ? "p1" : null;
	}
	async claimId(_path: string, proposedId: string): Promise<{ pageId: string }> {
		return { pageId: proposedId };
	}
	async loadSidecar(pageId: string): Promise<ParseResult | null> {
		return this.sidecars.get(pageId) ?? null;
	}
	scheduleSidecar(): void {}
	notify(): void {}
}

describe("InlineInkStore.moveStrokes bumps the revision", () => {
	let store: InlineInkStore;
	let host: FakeHost;

	beforeEach(async () => {
		store = new InlineInkStore();
		host = new FakeHost();
		store.attachHost(host);
		host.sidecars.set("p1", {
			data: pageWith("p1", "a", "b", "c"),
			recovered: false,
			damaged: false,
		} as ParseResult);
		await store.ensureLoaded("note.md");
	});

	it("bumps exactly the moved strokes and no others", () => {
		const [a, b, c] = store.strokes("note.md") as InkStroke[];
		const before = [strokeRev(a!), strokeRev(b!), strokeRev(c!)];
		store.moveStrokes("note.md", ["a", "c"], 12, -4);
		expect(strokeRev(a!)).toBe(before[0]! + 1);
		expect(strokeRev(c!)).toBe(before[2]! + 1);
		expect(strokeRev(b!)).toBe(before[1]!);
	});

	it("bumps again when the move is undone, because that moves too", () => {
		const [a] = store.strokes("note.md") as InkStroke[];
		store.moveStrokes("note.md", ["a"], 12, -4);
		const afterDrag = strokeRev(a!);
		store.moveStrokes("note.md", ["a"], -12, 4);
		expect(strokeRev(a!)).toBe(afterDrag + 1);
		expect(a!.points[0]).toMatchObject({ x: 0, y: 0 });
	});

	it("does not bump when the move is a no-op", () => {
		const [a] = store.strokes("note.md") as InkStroke[];
		const before = strokeRev(a!);
		store.moveStrokes("note.md", ["a"], 0, 0);
		expect(strokeRev(a!)).toBe(before);
	});

	it("skips ids the record no longer holds", () => {
		const [a, b, c] = store.strokes("note.md") as InkStroke[];
		const before = [strokeRev(a!), strokeRev(b!), strokeRev(c!)];
		store.moveStrokes("note.md", ["ghost"], 5, 5);
		expect([strokeRev(a!), strokeRev(b!), strokeRev(c!)]).toEqual(before);
	});
});

describe("ObjectOps.moveObjects bumps the revision", () => {
	it("bumps exactly the moved strokes", () => {
		const page = emptyPage("p1");
		page.strokes.push(stroke("s1"), stroke("s2"));
		const [s1, s2] = page.strokes;
		const before = [strokeRev(s1!), strokeRev(s2!)];
		moveObjects(page, { strokeIds: ["s1"], boxIds: [], imageIds: [] }, 5, -5);
		expect(strokeRev(s1!)).toBe(before[0]! + 1);
		expect(strokeRev(s2!)).toBe(before[1]!);
	});
});
