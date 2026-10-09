/**
 * A note whose ink file read is rejected is held, not overwritten.
 *
 * A read that THROWS inside PageStore is already answered as "not read yet"
 * and the note is locked quietly. The host's own load can also reject (any
 * error that is not that answer). The store swallowed that rejection when it
 * tracked the load, left the note with no base page and no lock, and the next
 * stroke saved the session's strokes alone over a file that may hold all the
 * earlier ink.
 *
 * The rule: a rejected load takes the same quiet lock as a read that threw.
 * Nothing is written, and when the file reads again the saved ink comes back
 * ahead of what was drawn meanwhile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { emptyPage, type PageData, type ParseResult } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

let serial = 0;
const paths = new Set<string>();
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
});
afterEach(() => {
	for (const p of paths) inlineInk.handleDelete(p);
	paths.clear();
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.unstubAllGlobals();
});

function stroke(id: string, x = 0): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		createdAt: 0,
		points: [
			{ x, y: 0, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 10, pressure: 0.5, t: 8 },
		],
		bbox: { x, y: 0, width: 10, height: 10 },
	};
}

function inlinePage(id: string, strokes: InkStroke[]): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = strokes;
	return p;
}

/** A note whose host load rejects until `heal` is called. */
function rig() {
	const path = `rejected-load-${++serial}.md`;
	paths.add(path);
	const pageId = `rejected-load-id-${serial}`;
	let healed = false;
	const written: PageData[] = [];
	inlineInk.attachHost({
		readPageId: (p) => (p === path ? pageId : null),
		claimId: async () => ({ pageId }),
		loadSidecar: async (): Promise<ParseResult> => {
			if (!healed) throw new Error("injected load failure");
			return { data: inlinePage(pageId, [stroke("saved-1", 0), stroke("saved-2", 20)]), recovered: false };
		},
		scheduleSidecar: (_id, page) => void written.push(page),
		notify() {},
	});
	return {
		path,
		written,
		heal: () => void (healed = true),
		async open(): Promise<void> {
			await inlineInk.ensureLoaded(path).catch(() => false);
		},
		async drawAndSave(id: string, x: number): Promise<void> {
			inlineInk.commit(path, stroke(id, x));
			inlineInk.save(path);
			for (let i = 0; i < 20; i++) await Promise.resolve();
		},
	};
}

describe("a note whose ink file load is rejected", () => {
	it("writes nothing when a stroke is drawn on it", async () => {
		const r = rig();
		await r.open();
		await r.drawAndSave("mine", 100);
		expect(r.written.map((page) => page.strokes.map((s) => s.id))).toEqual([]);
	});

	it("brings the saved ink back ahead of the new stroke once the file reads", async () => {
		const r = rig();
		await r.open();
		await r.drawAndSave("mine", 100);
		r.heal();
		await inlineInk.ensureLoaded(r.path);
		expect(inlineInk.strokes(r.path).map((s) => s.id)).toEqual(["saved-1", "saved-2", "mine"]);
		expect(r.written.at(-1)?.strokes.map((s) => s.id)).toEqual(["saved-1", "saved-2", "mine"]);
	});

	it("control: a load that works merges the saved ink under the next stroke", async () => {
		const r = rig();
		r.heal();
		await r.open();
		await r.drawAndSave("mine", 100);
		expect(r.written.at(-1)?.strokes.map((s) => s.id)).toEqual(["saved-1", "saved-2", "mine"]);
	});
});
