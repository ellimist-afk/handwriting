/**
 * New ink whose anchor top moves at its line's first box read reaches the file. A stroke drawn on a line with no box read,
 * once this surface has read boxes, is taken again under the box at that line's first read (LineAnchorNewInkBox.test.ts);
 * the move is in memory, so the page must be written again or a reopen reads the commit-time top and shows the stroke off
 * its text. Through the overlay's real line box read (requestLineBoxes, its measure's write) and the real store, with the
 * store's persist replaced by a recorder of each stroke's anchor as written.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke, type LineAnchor } from "../ink/Stroke";

const PX_PER_WORLD = 0.11151960784313726;
const PITCH = 25.5 * PX_PER_WORLD;
const SIG = { width: 892, fontPx: 19, charWidth: 10 };

const doc = Text.of(Array.from({ length: 30 }, (_, i) => `line ${i + 1} words`));
const layout: LineLayout = { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * PITCH, pxPerWorld: PX_PER_WORLD };

function strokeAt(id: string, line: number): InkStroke {
	const x = 10, y = (line - 1) * 25.5 + 2;
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** Box tops for `lines`, each `gapPx` screen px below its height-map top, in world units. */
function boxTops(lines: number[], gapPx: number): Map<number, number> {
	return new Map(lines.map((n) => [n, (layout.lineTop(n) + gapPx) / PX_PER_WORLD]));
}

type Written = Array<{ id: string; anchor: LineAnchor | undefined }>;

function rig(path: string) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [] };
	rec.strokes = [];
	const writes: Written[] = [];
	Object.defineProperty(inlineInk, "persist", {
		value: (_p: string, r: { strokes: readonly InkStroke[] }) => {
			writes.push(r.strokes.map((s) => ({ id: s.id, anchor: s.lineAnchor ? { ...s.lineAnchor } : undefined })));
		},
		configurable: true,
	});
	const anchors = new LineAnchors(() => layout);
	anchors.setSignature(SIG);
	let next: { path: string; tops: Map<number, number>; reads: number; wait: boolean } | null = null;
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		lineAnchorState: anchors,
		filePath: () => path,
		lineAnchorsMoved: () => {},
		view: { requestMeasure: (req: { write: (m: unknown) => void }) => req.write(next) },
	});
	/** One line box read of `lines`, `gapPx` off the map, through the overlay's measure request. */
	const readBoxes = (lines: number[], gapPx: number) => {
		next = { path, tops: boxTops(lines, gapPx), reads: lines.length, wait: false };
		overlay.requestLineBoxes();
	};
	/** A pen commit on `line`: the anchor is taken, the stroke goes in the store, the page is written. */
	const draw = (id: string, line: number) => {
		const s = strokeAt(id, line);
		anchors.anchorNew(path, s);
		rec.strokes = [...rec.strokes, s];
		anchors.tracks(path, rec.strokes);
		inlineInk.save(path);
		return s;
	};
	anchors.drawn(1, doc.lines);
	return { anchors, rec, writes, readBoxes, draw };
}

/** The note opened again from `written`: a fresh surface over strokes carrying the anchors as written, its boxes read. */
function reopen(path: string, written: Written, lines: number[], gapPx: number) {
	const src = written.map(({ id, anchor }) => {
		const line = anchor?.line ?? 1;
		return { ...strokeAt(id, line), lineAnchor: anchor ? { ...anchor } : undefined };
	});
	const a = new LineAnchors(() => layout);
	a.setSignature(SIG);
	a.tracks(path, src);
	a.drawn(1, doc.lines);
	a.boxesRead(path, src, boxTops(lines, gapPx), lines.length);
	return { a, src };
}

describe("an anchor top moved at its line's first box read is written to the page", () => {
	it("a stroke drawn on line 9 after line 3 was read 3 px off the map sits on its text after a reopen", () => {
		// Defect: the first box read of line 9 moves the new stroke's anchor top in memory and asks for no write, so the page
		// keeps the commit-time top and a reopen shows the stroke 3 px off its text until the next ink write.
		const path = "box-write-moved.md";
		const { anchors, writes, readBoxes, draw } = rig(path);
		const s3 = draw("s3", 3);
		readBoxes([3], 3);
		expect(anchors.dyOf(s3) * PX_PER_WORLD, "premise: line 3's ink follows its box").toBeCloseTo(3, 6);
		const s9 = draw("s9", 9);
		const atCommit = s9.lineAnchor!.top;
		const before = writes.length;
		readBoxes([3, 9], 3);
		expect(anchors.dyOf(s9) * PX_PER_WORLD, "premise: the new stroke stays where it was drawn").toBeCloseTo(0, 6);
		expect((s9.lineAnchor!.top - atCommit) * PX_PER_WORLD, "premise: the box read moved its anchor top 3 px").toBeCloseTo(3, 6);
		expect(writes.length, "the box read that moved the top asked for a page write").toBeGreaterThan(before);
		const last = writes[writes.length - 1]!;
		expect(last.find((w) => w.id === "s9")?.anchor?.top, "the page holds the moved top").toBe(s9.lineAnchor!.top);
		const { a, src } = reopen(path, last, [3, 9], 3);
		expect(a.dyOf(src.find((s) => s.id === "s9")!) * PX_PER_WORLD, "after the reopen the stroke sits on its text").toBeCloseTo(0, 6);
		a.detached();
		anchors.detached();
	});

	it("control: a box read that moves no anchor top asks for no write", () => {
		// Defect: the write is asked on every box read, not only when one moved a top.
		const path = "box-write-control.md";
		const { anchors, writes, readBoxes, draw } = rig(path);
		const low = draw("low", 20);
		const top = low.lineAnchor!.top;
		const before = writes.length;
		readBoxes([20], -3);
		expect(anchors.dyOf(low) * PX_PER_WORLD, "premise: the stroke follows its box").toBeCloseTo(-3, 6);
		expect(low.lineAnchor!.top, "premise: its anchor top did not move").toBe(top);
		readBoxes([20], -3);
		expect(writes.length, "no write asked").toBe(before);
		anchors.detached();
	});
});
