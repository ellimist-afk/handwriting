/**
 * The free list kept across a store change that keeps the list: the store bumps a list revision wherever it changes its
 * list in place (an add, a remove, a replace) and never on a move, so the kept path reads no stroke of the list while the
 * revision stands, and a replace in place is still seen. Each cell names the defect that must turn it red.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { bumpInkRevision, inkListRevision } from "../ink/StrokeRev";
import { targetAt, type AttachmentRecord } from "./InkAttachments";
import { emptyPage, type PageData, type ParseResult } from "../model/PageData";
import { InlineInkStore, type InlineInkHost } from "./InlineInkStore";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const PATH = "note.md";
const LINES = 40;
const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

function pageWith(id: string, strokes: InkStroke[]): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = strokes;
	return p;
}

class FakeHost implements InlineInkHost {
	sidecars = new Map<string, ParseResult>();
	readPageId(path: string): string | null {
		return path === PATH ? "p1" : null;
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

const word = "line 3 words";
const record = (): AttachmentRecord => {
	const from = DOC.indexOf(word);
	return { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(DOC, from, from + word.length, "range"), ref: { x: 0, y: 80 }, layout: { width: 892, font: 26 }, probe: { id: "s1", x: 10, y: 89 } };
};

let store: InlineInkStore;

beforeEach(async () => {
	store = new InlineInkStore();
	const host = new FakeHost();
	store.attachHost(host);
	host.sidecars.set("p1", { data: pageWith("p1", [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90), strokeAt("free", 10, 205), strokeAt("free2", 60, 245)]), recovered: false, damaged: false } as ParseResult);
	await store.ensureLoaded(PATH);
});

/** Line anchors over the store's list, with s1 and s2 in a read group, and the free list answered once. */
function anchorsOver() {
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	anchors.follow.setList([record()]);
	anchors.follow.measure({ inView: () => true, refAt: () => ({ x: 6, y: 92 }), blockTop: () => 80 });
	anchors.freeFor(PATH, store.strokes(PATH));
	return anchors;
}

describe("the store's list revision", () => {
	it("rises on a commit, an insertion and a take, and stands on a move", () => {
		// Defect: a list change in place leaves the revision standing, so a kept free list answers strokes the list no longer holds.
		const at = () => inkListRevision();
		let r = at();
		store.commit(PATH, strokeAt("new", 100, 300));
		expect(at(), "a commit").toBeGreaterThan(r);
		r = at();
		store.applyAdd(PATH, [strokeAt("added", 120, 320)]);
		expect(at(), "an insertion").toBeGreaterThan(r);
		r = at();
		store.take(PATH, ["added"]);
		expect(at(), "a take").toBeGreaterThan(r);
		r = at();
		store.moveStrokes(PATH, ["free"], 5, 5);
		expect(at(), "a move keeps the list").toBe(r);
	});
});

describe("the free list kept across a move", () => {
	it("a move in place keeps the free list and reads no stroke of the list", () => {
		// Defect: the kept path walks the whole list by identity on every store move (28358 strokes on the heavy note).
		const anchors = anchorsOver(), fc = anchors.freeCounts;
		const first = anchors.freeFor(PATH, store.strokes(PATH));
		store.moveStrokes(PATH, ["s1", "s2"], 0, 40);
		bumpInkRevision();
		const kept = fc.kept, reads = fc.baseReads;
		const again = anchors.freeFor(PATH, store.strokes(PATH));
		expect([fc.kept - kept, fc.baseReads - reads], "kept, with no stroke of the list read").toEqual([1, 0]);
		expect(again.free).toBe(first.free);
	});

	it("a commit that replaces a free stroke in place is seen: the new object is answered free", () => {
		// Defect: the kept path trusts a standing answer after the store replaced a stroke at its index.
		const anchors = anchorsOver();
		anchors.freeFor(PATH, store.strokes(PATH));
		const replacement = strokeAt("free", 12, 207);
		store.commit(PATH, replacement);
		const out = anchors.freeFor(PATH, store.strokes(PATH));
		expect(out.free.includes(replacement), "the replacement is free").toBe(true);
		expect(out.free.filter((s) => s.id === "free").length, "the old object is gone").toBe(1);
	});
});
