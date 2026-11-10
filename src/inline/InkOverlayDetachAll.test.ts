/**
 * Detach on a lasso over two groups or more: the lasso's Detach is on, and one tap detaches every group the selection
 * touches, each whole. Every record goes, nothing shown moves, and the editor history grows by one step: one undo puts
 * every group back, one redo detaches them all again. Loose ink in the same lasso stays loose. A group needing
 * reattachment detaches like any other. A bare overlay, a fake view: no DOM, no layout read.
 */
import { describe, expect, it } from "vitest";
import { Text, type TransactionSpec } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { attachmentSelection, targetAt, type AttachmentRecord } from "./InkAttachments";
import { invertInkOp, type InkOp } from "./InkHistory";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LINES = 60;
const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();
/** Each group is read 6 right and 12 down of its record; the members' own anchors read 80 down. */
const READ = { x: 6, y: 12 };
const OWN_SHIFT = 80;
const FREE_LINE = 50;

const topOf = (line: number) => (line - 1) * 40;

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** Group n (from 1): two strokes on line 4n - 1, attached to that line's words. */
function group(n: number): { record: AttachmentRecord; strokes: InkStroke[] } {
	const line = 4 * n - 1, top = topOf(line), l = doc.line(line), id = `g${n}`;
	const strokes = [strokeAt(`${id}a`, 10, top + 5), strokeAt(`${id}b`, 40, top + 10)];
	const record: AttachmentRecord = {
		v: 1, id, strokeIds: strokes.map((s) => s.id), target: targetAt(DOC, l.from, l.to, "range"), ref: { x: 0, y: top },
		layout: { width: 892, font: 26 }, probe: { id: strokes[0]!.id, x: 10, y: top + 9 },
	};
	return { record, strokes };
}

function pane(path: string, state: { shift: number }) {
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => topOf(n) + state.shift, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	for (const s of inlineInk.strokes(path)) anchors.anchorNew(path, s);
	anchors.strokesFor(path, inlineInk.strokes(path));
	const sent: TransactionSpec[] = [];
	const selection = { size: 0, strokeIds: new Set<string>(), prune: () => {} };
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		lineAnchorState: anchors,
		view: {
			lineBlockAt: (pos: number) => { const top = topOf(doc.lineAt(pos).number); return { top, bottom: top + 40 }; },
			state: { doc },
			dispatch: (spec: TransactionSpec) => sent.push(spec),
		},
		filePath: () => path,
		endLiveGestureForHistory: () => {},
		scheduleRepaint: () => {},
		repaintPath: () => {},
		redrawSelectionUI: () => {},
		lineAnchorsMoved: () => {},
		currentIndexes: () => [],
		frontierCache: { invalidate: () => {} },
		selection,
	});
	return { overlay, anchors, sent, selection };
}

/** `n` groups stored and read, a loose stroke on line 50; `held` groups need reattachment (read before they were held). */
function rig(path: string, n: number, held: readonly string[] = []) {
	const groups = Array.from({ length: n }, (_, i) => group(i + 1));
	const records = groups.map((g) => g.record);
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: records };
	rec.strokes = [...groups.flatMap((g) => g.strokes), strokeAt("free", 10, topOf(FREE_LINE) + 5)];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const state = { shift: 0 };
	const a = pane(path, state);
	state.shift = OWN_SHIFT;
	a.anchors.layoutChanged(path, inlineInk.strokes(path), "measure");
	a.anchors.follow.setList(inlineInk.attachments(path));
	a.anchors.follow.measure({ inView: () => true, refAt: (pos) => ({ x: READ.x, y: topOf(doc.lineAt(pos).number) + READ.y }), blockTop: (pos) => topOf(doc.lineAt(pos).number) });
	if (held.length > 0) a.anchors.follow.setList(inlineInk.attachments(path), new Map(held.map((id) => [id, "needs-reattachment" as const])));
	const shown = () => {
		a.anchors.follow.setList(inlineInk.attachments(path));
		return a.anchors.strokesFor(path, inlineInk.strokes(path)).map((s) => ({ id: s.id, x: s.points[0]!.x, y: s.points[0]!.y }));
	};
	const select = (ids: readonly string[]) => void (a.selection.strokeIds = new Set(ids));
	const all = groups.flatMap((g) => g.record.strokeIds);
	return { a, shown, select, path, records, all };
}

const ops = (spec: TransactionSpec): InkOp[] => [spec.effects ?? []].flat().map((e) => (e as { value: InkOp }).value);
const close = (got: { id: string; x: number; y: number }[], want: { id: string; x: number; y: number }[]) => {
	expect(got.map((s) => s.id)).toEqual(want.map((s) => s.id));
	got.forEach((s, i) => {
		expect(s.x, s.id).toBeCloseTo(want[i]!.x, 9);
		expect(s.y, s.id).toBeCloseTo(want[i]!.y, 9);
	});
};
const freePoints = (path: string) => inlineInk.strokes(path).find((s) => s.id === "free")!.points.map((p) => [p.x, p.y]);

/** One tap, then its one history step undone and redone as the editor's history does: each effect inverted, in order. */
function tapUndoRedo(r: ReturnType<typeof rig>) {
	const before = r.shown(), free = freePoints(r.path);
	expect(r.a.overlay.detachSelected(), "the tap detached").toBe(true);
	expect(inlineInk.attachments(r.path), "every record gone").toEqual([]);
	close(r.shown(), before);
	expect(r.a.sent, "one history step").toHaveLength(1);
	const step = ops(r.a.sent[0]!);
	expect(step.map((o) => [o.type, (o as { id?: string }).id, (o as { after?: unknown }).after]), "one detach per group, in that step").toEqual(r.records.map((x) => ["attach", x.id, null]));
	for (const op of step.map(invertInkOp)) r.a.overlay.applyInkOp(op, false);
	expect(inlineInk.attachments(r.path), "one undo puts every group back").toEqual(r.records);
	close(r.shown(), before);
	for (const op of step) r.a.overlay.applyInkOp(op, false);
	expect(inlineInk.attachments(r.path), "one redo detaches them all again").toEqual([]);
	close(r.shown(), before);
	expect(freePoints(r.path), "loose ink never moves").toEqual(free);
}

describe("Detach on a lasso over two groups or more", () => {
	it("is on for two groups, loose ink in the lasso or not; Attach stays off; one group plus loose ink as before", () => {
		// Defect: two groups turn Detach off, or one loose stroke in the lasso hides it.
		const { records } = rig("detach-all-chips.md", 2);
		expect(attachmentSelection(records, ["g1a", "g1b", "g2a", "g2b"])).toMatchObject({ attach: false, detach: true, groupIds: ["g1", "g2"] });
		expect(attachmentSelection(records, ["g1a", "g2a", "free"])).toMatchObject({ attach: false, detach: true, groupIds: ["g1", "g2"] });
		expect(attachmentSelection(records, ["g1a", "free"])).toMatchObject({ attach: true, detach: false, groupIds: ["g1"] });
	});

	it("two groups: one tap detaches both whole, nothing moves, one history step; one undo puts both back, one redo detaches both", () => {
		// Defect: the tap detaches the first group only, or sends one history step per group (one undo puts back one).
		const r = rig("detach-all-two.md", 2);
		r.select(r.all);
		tapUndoRedo(r);
	});

	it("three groups, one needing reattachment: the tap detaches all three the same way", () => {
		// Defect: the held group is skipped, so its record stays and its ink stays attached.
		const r = rig("detach-all-held.md", 3, ["g2"]);
		expect(r.a.anchors.follow.followsText("g2"), "premise: g2 needs reattachment").toBe(false);
		r.select(r.all);
		tapUndoRedo(r);
	});

	it("two groups and loose ink: both groups detach, the loose stroke stays loose and where it is", () => {
		// Defect: loose ink in the lasso turns Detach off, or the loose stroke is moved by a group's correction.
		const r = rig("detach-all-loose.md", 2);
		r.select(["g1a", "g2b", "free"]);
		tapUndoRedo(r);
	});

	it("ten groups: one tap, one history step of ten; its wall time and store saves reported", () => {
		const r = rig("detach-all-ten.md", 10);
		r.select(r.all);
		const save = inlineInk.save;
		let saves = 0;
		Object.defineProperty(inlineInk, "save", { configurable: true, value: (p: string) => (saves++, save.call(inlineInk, p)) });
		let ms = 0;
		try {
			const t0 = performance.now();
			expect(r.a.overlay.detachSelected()).toBe(true);
			ms = performance.now() - t0;
		} finally {
			delete (inlineInk as unknown as { save?: unknown }).save;
		}
		console.log(`[detach-all-ten] ${JSON.stringify({ groups: 10, ms: Math.round(ms * 100) / 100, saves })}`);
		expect(inlineInk.attachments(r.path)).toEqual([]);
		expect(r.a.sent).toHaveLength(1);
		expect(ops(r.a.sent[0]!)).toHaveLength(10);
	});
});
