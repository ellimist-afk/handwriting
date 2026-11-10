/**
 * The eraser over attached ink. Membership is the family: a partly erased member's pieces
 * join its group and the erased original stays listed, so the undo and redo of the erase (the replace op: takeLive plus
 * applyAddLive) touch no record and nothing jumps. A piece erased again in the same session is dropped when its own
 * pieces join, so a long erase leaves the present members plus the session's originals. The ring cuts where the group
 * is shown, x and y. The record still equals its trimmed copy on disk. The real eraseAt on a bare overlay: no DOM.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { InkOverlayPlugin, inlineEraserRadiusPx } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { StrokeIndex } from "../ink/StrokeIndex";
import { emptyPage, parsePage, serializePage, type PageData } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { isOpaqueAttachment, targetAt, type AttachmentRecord } from "./InkAttachments";
import { outgoingDiverges } from "../persistence/PageStore";
import { mergePages } from "../persistence/PageMerge";
import { applyForkDecision, recordFork, resetForks, type ForkHost, type ForkRecord } from "../persistence/ForkResolution";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const doc = Text.of(Array.from({ length: 40 }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();
/** The groups are read 40 right and 12 down of their records (mixed, trap 1). */
const READ = { x: 40, y: 92 };

/** A horizontal line from x0 to x1 at y, a point every 2 world units. */
function line(id: string, x0: number, x1: number, y: number): InkStroke {
	const points = Array.from({ length: (x1 - x0) / 2 + 1 }, (_, i) => ({ x: x0 + i * 2, y, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 1), createdAt: 1 };
}

function record(id: string, strokeIds: string[], word: string): AttachmentRecord {
	const from = DOC.indexOf(word);
	return { v: 1, id, strokeIds, target: targetAt(DOC, from, from + word.length, "range"), ref: { x: 0, y: 80 }, layout: { width: 892, font: 26 }, probe: { id: strokeIds[0]!, x: 10, y: 100 } };
}

function rig(path: string, strokes: InkStroke[], groups: AttachmentRecord[], whole = false) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), surface: "inline", attachments: groups };
	rec.strokes = strokes;
	delete (rec as { attachments?: unknown }).attachments;
	const writes: number[] = [];
	Object.defineProperty(inlineInk, "persist", { value: () => writes.push(1), configurable: true });
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, doc.lines);
	anchors.follow.setList(inlineInk.attachments(path));
	anchors.follow.measure({ inView: () => true, refAt: () => READ, blockTop: () => 80 });
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin & Record<string, unknown>;
	const index = new StrokeIndex();
	Object.assign(overlay, {
		lineAnchorState: anchors, filePath: () => path, scale: 1, mode: "erase", eraseWhole: whole, erased: [], erasePieces: new Set<string>(),
		strokeIndex: index, indexDirty: true, currentIndexes: () => [index], damage: { addRect: () => {}, addAll: () => {} },
		scheduleRepaint: () => {}, repaintPath: () => {}, camera: { screenToWorld: (x: number, y: number) => ({ x, y }) },
	});
	const erase = (x: number, y: number) => (overlay as unknown as { eraseAt(s: unknown): void }).eraseAt({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
	const shown = () => {
		anchors.follow.setList(inlineInk.attachments(path));
		return new Map(anchors.strokesFor(path, inlineInk.strokes(path)).map((s) => [s.id, s] as const));
	};
	const members = (id: string) => (inlineInk.attachments(path).find((a) => a.id === id) as AttachmentRecord).strokeIds;
	const erased = () => overlay.erased as Array<{ stroke: InkStroke; index: number }>;
	/** The gesture's replace op as history applies it: undo takes the pieces and puts the originals back. */
	const undo = (pieces: string[]) => {
		inlineInk.takeLive(path, pieces);
		inlineInk.applyAddLive(path, erased().map((e) => e.stroke), erased().map((e) => e.index));
	};
	const redo = (pieces: InkStroke[], at: number[]) => {
		inlineInk.takeLive(path, erased().map((e) => e.stroke.id));
		inlineInk.applyAddLive(path, pieces, at);
	};
	return { erase, shown, members, erased, undo, redo, writes, anchors };
}

const ids = (path: string) => inlineInk.strokes(path).map((s) => s.id);

describe("the eraser over attached ink", () => {
	it("(a) partial erase of a member: its pieces are members; undo puts the original back in its group, redo the pieces, nothing jumps", () => {
		// Defect: the pieces are free ink, shown 40 left and 12 up of where the group shows them.
		const path = "erase-attached-a.md";
		const r = rig(path, [line("s1", 10, 90, 100), line("free", 10, 90, 300)], [record("att-1", ["s1"], "line 3 words")]);
		const before = r.shown().get("s1")!.points[0]!;
		r.erase(50 + READ.x, 100 + READ.y - 80);
		const pieces = inlineInk.strokes(path).filter((s) => s.id !== "s1" && s.id !== "free");
		expect(pieces.length, "the ring split s1 in two").toBe(2);
		expect(r.members("att-1").sort()).toEqual(["s1", ...pieces.map((p) => p.id)].sort());
		const shown = r.shown();
		for (const p of pieces) expect(shown.get(p.id)!.points[0]!.x, "piece shown with the group").toBeCloseTo(p.points[0]!.x + READ.x, 9);
		const at = pieces.map((p) => ids(path).indexOf(p.id));
		r.undo(pieces.map((p) => p.id));
		const back = r.shown().get("s1")!.points[0]!;
		expect([back.x, back.y]).toEqual([before.x, before.y]);
		r.redo(pieces, at);
		for (const p of pieces) expect(r.shown().get(p.id)!.points[0]!.y).toBeCloseTo(p.points[0]!.y + READ.y - 80, 9);
		expect(r.writes, "no write per sample").toEqual([]);
	});

	it("(b) two groups erased in one pass: each group's pieces join its own group only", () => {
		// Defect: the pieces of one group's member land in both groups, or in the other.
		const path = "erase-attached-b.md";
		const r = rig(path, [line("s1", 10, 90, 100), line("s2", 10, 90, 106)], [record("att-1", ["s1"], "line 3 words"), record("att-2", ["s2"], "line 5 words")]);
		r.erase(50 + READ.x, 103 + READ.y - 80);
		const of = (parent: string) => r.erased().find((e) => e.stroke.id === parent) ? inlineInk.strokes(path).filter((s) => Math.abs(s.points[0]!.y - (parent === "s1" ? 100 : 106)) < 1).map((s) => s.id) : [];
		expect(r.members("att-1").sort()).toEqual(["s1", ...of("s1")].sort());
		expect(r.members("att-2").sort()).toEqual(["s2", ...of("s2")].sort());
	});

	it("(c) a long erase over a group: the record holds the present members and the original, no intermediate piece", () => {
		// Defect: every piece made and erased again during the drag stays listed.
		const path = "erase-attached-c.md";
		const r = rig(path, [line("s1", 10, 130, 100)], [record("att-1", ["s1"], "line 3 words")]);
		for (const x of [40, 50, 60, 70, 80]) r.erase(x + READ.x, 100 + READ.y - 80);
		expect(r.members("att-1").sort()).toEqual(["s1", ...ids(path)].sort());
	});

	it("(d) whole erase, then undo: the member is back in its group and shown with it", () => {
		const path = "erase-attached-d.md";
		const r = rig(path, [line("s1", 10, 90, 100)], [record("att-1", ["s1"], "line 3 words")], true);
		const before = r.shown().get("s1")!.points[0]!;
		r.erase(50 + READ.x, 100 + READ.y - 80);
		expect(ids(path)).toEqual([]);
		expect(r.members("att-1")).toEqual(["s1"]);
		r.undo([]);
		const back = r.shown().get("s1")!.points[0]!;
		expect([back.x, back.y]).toEqual([before.x, before.y]);
	});

	it("(e) a group shown 40 right: the ring cuts at the place shown, not 40 to its right", () => {
		// Defect: the cut corrects y only, so the ring at shown x 90 cuts stored x 90 instead of 50.
		const path = "erase-attached-e.md";
		const r = rig(path, [line("s1", 10, 110, 100)], [record("att-1", ["s1"], "line 3 words")]);
		r.erase(50 + READ.x, 100 + READ.y - 80);
		const xs = inlineInk.strokes(path).flatMap((s) => s.points.map((p) => p.x));
		const R = inlineEraserRadiusPx;
		expect(xs.some((x) => Math.abs(x - 50) < R - 1), "no stored point left inside the ring").toBe(false);
		expect(xs.some((x) => Math.abs(x - 90) < R - 1), "ink 40 right of the ring stays").toBe(true);
	});

	it("(f) save and reload after a partial erase: no divergence, the merge and the fork read-back keep the session's record", async () => {
		// Defect: the session record with the erased original listed reads as a lost record against its trimmed copy.
		const path = "erase-attached-f.md";
		const r = rig(path, [line("s1", 10, 90, 100)], [record("att-1", ["s1"], "line 3 words")]);
		r.erase(50 + READ.x, 100 + READ.y - 80);
		const page: PageData = { ...emptyPage(`page-${path}`), surface: "inline", strokes: [...inlineInk.strokes(path)], attachments: [...inlineInk.attachments(path)] };
		expect(r.members("att-1"), "the session list holds the erased original at compare time").toContain("s1");
		expect(ids(path)).not.toContain("s1");
		const written = serializePage(page);
		const disk = parsePage(written, page.pageId).data;
		expect((disk.attachments![0] as AttachmentRecord).strokeIds, "the disk copy is trimmed").not.toContain("s1");
		expect(outgoingDiverges(page, disk)).toBe(false);
		const merged = mergePages(disk, page);
		expect(merged.attachments!.filter((a) => !isOpaqueAttachment(a)).map((a) => a.id)).toEqual(["att-1"]);
		// The fork read-back: the live file is the session's write; "Take the other" with that same revision writes nothing.
		resetForks();
		const pageId = page.pageId, rec: ForkRecord = { pageId, path, outgoingPath: ".handwriting/p.conflict-external-t-outgoing.json", incomingPath: ".handwriting/p.conflict-external-t-incoming.json", at: 5 };
		const files = new Map([[rec.outgoingPath, written], [rec.incomingPath, written], [`.handwriting/${pageId}.json`, written]]);
		const saved: PageData[] = [];
		const host: ForkHost = { read: async (p: string) => files.get(p) ?? null, stat: async (p: string) => (files.has(p) ? { mtime: 1000 } : null), saveNow: async (_id: string, d: PageData) => { saved.push(d); } };
		recordFork(rec);
		await expect(applyForkDecision(host, rec, "take-theirs")).resolves.toMatchObject({ kind: "applied", wrote: false });
		expect(saved).toEqual([]);
	});
});
