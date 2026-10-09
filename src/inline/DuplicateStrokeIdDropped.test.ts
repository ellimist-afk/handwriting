/**
 * A sidecar holding two strokes with the same id (hand edit, an external
 * merge tool, a sync client's union merge) decodes to two strokes with no
 * loss reported, so the note is not locked. The second stroke loads under a
 * name of its own, so the inline store keeps both, and the next save writes
 * both back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineInkStore, InlineInkHost } from "./InlineInkStore";
import { PageData, ParseResult, parsePage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";

beforeEach(() => vi.stubGlobal("window", globalThis));
afterEach(() => vi.unstubAllGlobals());

const SIDECAR = JSON.stringify({
	schemaVersion: 1,
	pageId: "p1",
	surface: "inline",
	textBoxes: [],
	images: [],
	strokes: [
		{ id: "s1", tool: "pen", color: "#000000", width: 2, createdAt: 1, pts: [0, 0, 0.5, 0, 10, 0, 0.5, 8] },
		{ id: "s1", tool: "pen", color: "#000000", width: 2, createdAt: 2, pts: [0, 50, 0.5, 0, 10, 50, 0.5, 8] },
	],
});

class Host implements InlineInkHost {
	saved: PageData[] = [];
	readPageId(path: string): string | null {
		return path === "note.md" ? "p1" : null;
	}
	async claimId(_path: string, proposedId: string) {
		return { pageId: proposedId };
	}
	async loadSidecar(): Promise<ParseResult | null> {
		return parsePage(SIDECAR, "p1");
	}
	scheduleSidecar(_pageId: string, page: PageData): void {
		this.saved.push(page);
	}
	notify(): void {}
}

const newStroke: InkStroke = {
	id: "s2",
	tool: "pen",
	color: "#000000",
	width: 2,
	points: [
		{ x: 0, y: 100, pressure: 0.5, t: 0 },
		{ x: 10, y: 100, pressure: 0.5, t: 8 },
	],
	bbox: { x: 0, y: 100, width: 10, height: 0 },
	createdAt: 3,
} as InkStroke;

describe("a sidecar with a duplicated stroke id", () => {
	it("decodes both strokes and reports no damage", () => {
		const r = parsePage(SIDECAR, "p1");
		expect(r.damaged).toBeFalsy();
		expect(r.data.strokes).toHaveLength(2);
	});

	it("keeps both strokes through load and the next save", async () => {
		const host = new Host();
		const store = new InlineInkStore();
		store.attachHost(host);
		await store.ensureLoaded("note.md");
		expect(store.strokes("note.md")).toHaveLength(2);

		store.commit("note.md", newStroke);
		store.save("note.md");
		await Promise.resolve();
		const written = host.saved[host.saved.length - 1]!;
		const ys = written.strokes.map((s) => s.points[0]!.y).sort((a, b) => a - b);
		expect(ys).toEqual([0, 50, 100]);
	});
});
