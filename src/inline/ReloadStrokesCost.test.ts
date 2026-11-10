/**
 * What a sync reload costs the redraws that run while it lasts.
 *
 * While a note reloads from disk, the store's strokes() answers with a filtered copy of its list on every call, so each
 * caller gets a new array. The attach chrome's free list is kept by the identity of the array it was built from, so during a
 * reload every redraw builds it again. Counted over a run of redraw-shaped reads (strokes() then freeFor), with and without
 * a reload: new arrays handed out, strokes the filter visited, and freeFor's calls against the calls it answered from the
 * kept list. Printed as one JSON line. With HW_RELOAD_BOUND=1 the reload arm must hold like the steady arm.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { appendFileSync } from "node:fs";
import { Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";
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

declare module "node:fs" { export function appendFileSync(path: string, data: string): void; }
declare const process: { env: Record<string, string | undefined> };
const OUT = process.env.HW_SPEED_OUT ?? "";
const BOUND = process.env.HW_RELOAD_BOUND === "1";
const REDRAWS = 20;

type Rec = { reloading: boolean; localStrokeIds: Set<string>; strokes: InkStroke[] };
const recOf = (): Rec => (store as unknown as { byPath: Map<string, Rec> }).byPath.get(PATH)!;

function readRun(anchors: LineAnchors) {
	const fc = (anchors as unknown as { freeCounts: { calls: number; held: number } }).freeCounts;
	const calls0 = fc.calls, held0 = fc.held, seen = new Set<readonly InkStroke[]>();
	let visited = 0;
	for (let i = 0; i < REDRAWS; i++) {
		const list = store.strokes(PATH);
		if (recOf().reloading) visited += recOf().strokes.length;
		seen.add(list);
		anchors.freeFor(PATH, list);
	}
	return { redraws: REDRAWS, newArrays: seen.size, filterVisits: visited, freeCalls: fc.calls - calls0, freeHeld: fc.held - held0 };
}

describe("strokes() during a sync reload", () => {
	it("redraw-shaped reads: new arrays, filter visits and free-list holds, steady against reloading", () => {
		const anchors = anchorsOver();
		const steady = readRun(anchors);
		const rec = recOf();
		rec.reloading = true;
		for (const s of rec.strokes) rec.localStrokeIds.add(s.id);
		const reloading = readRun(anchors);
		rec.reloading = false;
		// eslint-disable-next-line no-console
		console.log(`RELOAD-STROKES ${JSON.stringify({ strokes: rec.strokes.length, steady, reloading })}`);
		if (OUT) appendFileSync(OUT, `RELOAD-STROKES ${JSON.stringify({ strokes: rec.strokes.length, steady, reloading })}
`);
		expect(steady.freeCalls, "premise: the free list was asked once per redraw").toBe(REDRAWS);
		expect(steady.freeHeld, "premise: steady, every redraw holds the kept list").toBe(REDRAWS);
		expect(reloading.freeCalls, "premise: the reload arm asked as often").toBe(REDRAWS);
		if (BOUND) expect(reloading.freeHeld, "free-list holds during a reload").toBe(REDRAWS);
	});
});
