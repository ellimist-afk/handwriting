/**
 * Detach of attached ink: the members' stored points settle by the group's correction,
 * x and y, the record goes, and each member's own line anchor is taken again where it is shown, so nothing moves on the
 * writer pane or on a second pane of the same width. One ink effect, the attach step to none with its settle: one undo
 * shows the group where it was with its record, one redo detaches again; a step whose members moved since is spent.
 * The lasso's Detach acts on a selection inside one group only. A bare overlay, a fake view: no DOM, no layout read.
 */
import { describe, expect, it } from "vitest";
import { Text, type TransactionSpec } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentRecord } from "./InkAttachments";
import { inkEffect, invertInkOp, type InkOp } from "./InkHistory";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LINES = 40;
const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();
const word = "line 3 words";
/** The group is read 6 right and 12 down of its record (mixed, trap 1); the members' own anchors read 80 down. */
const READ = { x: 6, y: 92 };
const OWN_SHIFT = 80;

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

function record(): AttachmentRecord {
	const from = DOC.indexOf(word);
	return { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(DOC, from, from + word.length, "range"), ref: { x: 0, y: 80 }, layout: { width: 892, font: 26 }, probe: { id: "s1", x: 10, y: 89 } };
}

function pane(path: string, state: { shift: number }, take: boolean) {
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40 + state.shift, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	if (take) for (const s of inlineInk.strokes(path)) anchors.anchorNew(path, s);
	anchors.strokesFor(path, inlineInk.strokes(path));
	const sent: TransactionSpec[] = [];
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		lineAnchorState: anchors,
		view: { lineBlockAt: () => ({ top: 80, bottom: 120 }), state: { doc }, dispatch: (spec: TransactionSpec) => sent.push(spec) },
		filePath: () => path,
		endLiveGestureForHistory: () => {},
		scheduleRepaint: () => {},
		repaintPath: () => {},
		redrawSelectionUI: () => {},
		lineAnchorsMoved: () => {},
		currentIndexes: () => [],
		frontierCache: { invalidate: () => {} },
		selection: { size: 0, strokeIds: new Set<string>(), prune: () => {} },
	});
	return { overlay, anchors, sent };
}

function rig(path: string) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [record()] };
	rec.strokes = [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90), strokeAt("free", 10, 205)];
	const writes: number[] = [];
	Object.defineProperty(inlineInk, "persist", { value: () => writes.push(1), configurable: true });
	const state = { shift: 0 };
	const a = pane(path, state, true), b = pane(path, state, false);
	state.shift = OWN_SHIFT;
	for (const p of [a, b]) {
		p.anchors.layoutChanged(path, inlineInk.strokes(path), "measure");
		p.anchors.follow.setList(inlineInk.attachments(path));
		p.anchors.follow.measure({ inView: () => true, refAt: () => READ, blockTop: () => 80 });
	}
	const shown = (p: { anchors: LineAnchors }) => {
		p.anchors.follow.setList(inlineInk.attachments(path));
		return p.anchors.strokesFor(path, inlineInk.strokes(path)).map((s) => ({ id: s.id, x: s.points[0]!.x, y: s.points[0]!.y }));
	};
	return { a, b, writes, shown, path, state };
}

const ops = (spec: TransactionSpec): InkOp[] => [spec.effects ?? []].flat().map((e) => (e as { value: InkOp }).value);
const close = (got: { id: string; x: number; y: number }[], want: { id: string; x: number; y: number }[]) => {
	expect(got.map((s) => s.id)).toEqual(want.map((s) => s.id));
	got.forEach((s, i) => {
		expect(s.x, s.id).toBeCloseTo(want[i]!.x, 9);
		expect(s.y, s.id).toBeCloseTo(want[i]!.y, 9);
	});
};

describe("detach of attached ink", () => {
	it("moves nothing on the writer pane: points settle by x and y, the record goes, own anchors read 0", () => {
		// Defect: the members keep their stored points (shown 6 left, 12 up), or keep their own anchor's 80 (shown 80 down).
		const { a, shown, path } = rig("detach-writer.md");
		const before = shown(a);
		expect(before[0]!.x, "the group is shown at its correction").toBeCloseTo(10 + READ.x, 9);
		expect(a.overlay.detachAttachment(path, "att-1")).toBe(true);
		expect(inlineInk.attachments(path)).toEqual([]);
		close(shown(a), before);
		const s1 = inlineInk.strokes(path)[0]!;
		expect(s1.points[0]!.x).toBeCloseTo(10 + READ.x, 9);
		expect(a.anchors.dyOf(s1)).toBe(0);
	});

	it("leaves two panes of one width pixel-equal", () => {
		// Defect: the pane that did not detach reads the members' old own anchors and shows them 80 down.
		const { a, b, shown, path } = rig("detach-two-panes.md");
		const before = shown(b);
		a.overlay.detachAttachment(path, "att-1");
		close(shown(b), before);
		close(shown(b), shown(a));
	});

	it("is one ink effect: the attach step to none, settling each member by the group's correction from its first point", () => {
		// Defect: two history entries (one undo shows the group detached at its own anchors), or a settle without `from`.
		const { a, path } = rig("detach-one-step.md");
		a.overlay.detachAttachment(path, "att-1");
		expect(a.sent).toHaveLength(1);
		const step = ops(a.sent[0]!);
		expect(step).toHaveLength(1);
		expect(step[0]).toMatchObject({ type: "attach", id: "att-1", after: null, before: record() });
		expect((step[0] as { settle?: unknown }).settle, "each member's move and first point before it").toEqual({
			strokeIds: ["s1", "s2"], dx: [READ.x, READ.x], dy: [READ.y - 80, READ.y - 80], from: [{ x: 10, y: 89 }, { x: 40, y: 94 }],
		});
		expect([a.sent[0]!.effects].flat().every((e) => (e as { is(t: unknown): boolean }).is(inkEffect))).toBe(true);
	});

	it("one undo shows the group where it was, with its record; one redo detaches again and nothing moves", () => {
		// Defect: the undone group is seeded at its record's place (6 left, 12 up) until the next measure; or the redo moves.
		const { a, shown, path } = rig("detach-undo.md");
		const attached = shown(a);
		a.overlay.detachAttachment(path, "att-1");
		const step = ops(a.sent[0]!);
		for (const op of step.map(invertInkOp)) a.overlay.applyInkOp(op, false);
		expect(inlineInk.attachments(path)).toEqual([record()]);
		close(shown(a), attached);
		const s1 = inlineInk.strokes(path)[0]!;
		expect(s1.points[0]!.x, "the points are back").toBeCloseTo(10, 9);
		for (const op of step) a.overlay.applyInkOp(op, false);
		expect(inlineInk.attachments(path)).toEqual([]);
		close(shown(a), attached);
	});

	it("an undo whose members another pane moved since the step: it applies, the record returns, each member where it is shown", () => {
		// Defect: the step is spent because the members no longer stand where it left them, so the group stays detached;
		// or it moves them by its recorded move a second time.
		const { a, shown, path } = rig("detach-stale-from.md");
		a.overlay.detachAttachment(path, "att-1");
		const step = ops(a.sent[0]!);
		inlineInk.moveStrokes(path, ["s1", "s2"], 5, 5);
		const before = shown(a);
		for (const op of step.map(invertInkOp)) a.overlay.applyInkOp(op, false);
		expect(inlineInk.attachments(path).map((r) => (r as { id: string }).id)).toEqual(["att-1"]);
		close(shown(a), before);
	});

	it("attach ink shown 80 below its points, lines grow above, detach, undo, undo: nothing moves at either undo", () => {
		// Defect: an undo re-takes the members' own anchors from a place other than where the group showed before
		// the step, so the last undo lands the ink 80 up.
		const { a, shown, path, state } = rig("detach-five-step.md");
		inlineInk.setAttachments(path, [], false);
		a.anchors.follow.setList([]);
		const free = shown(a);
		expect(free[0]!.y, "the members show at their own anchors' 80").toBeCloseTo(89 + OWN_SHIFT, 9);
		const target = record().target;
		a.overlay.attachAt(path, "att-2", ["s1", "s2"], target, { x: 0, y: 500 });
		close(shown(a), free);
		state.shift += 80;
		a.anchors.layoutChanged(path, inlineInk.strokes(path), "measure");
		a.anchors.follow.layoutChanged();
		a.anchors.follow.measure({ inView: () => true, refAt: () => ({ x: 0, y: 580 }), blockTop: () => 80 });
		const grown = shown(a);
		expect(grown[0]!.y, "the group follows the lines down").toBeCloseTo(free[0]!.y + 80, 9);
		a.overlay.detachAttachment(path, "att-2");
		close(shown(a), grown);
		const [attach, detach] = a.sent.map((s) => ops(s)[0]!);
		a.overlay.applyInkOp(invertInkOp(detach!), false);
		expect((inlineInk.attachments(path)[0] as AttachmentRecord).id).toBe("att-2");
		close(shown(a), grown);
		a.overlay.applyInkOp(invertInkOp(attach!), false);
		expect(inlineInk.attachments(path)).toEqual([]);
		close(shown(a), grown);
	});

	it("the undo of an Attach shown at no correction leaves the members where they are, not on their old anchors", () => {
		// Defect: the history's detach keeps each member's old own-anchor correction, so the ink drops 80 when Attach is undone.
		const { a, shown, path } = rig("detach-undo-attach.md");
		a.anchors.follow.attached(record(), 80);
		const attached = shown(a);
		expect(attached[0]!.y, "the group is shown at its stored points").toBeCloseTo(89, 9);
		a.overlay.applyInkOp({ type: "attach", path, id: "att-1", before: record(), after: null }, false);
		expect(inlineInk.attachments(path)).toEqual([]);
		close(shown(a), attached);
	});

	it("a Detach settles its members in one store pass, not one per member", () => {
		// Defect: one moveStrokes per member, each a scan of every stroke of the note: members x strokes.
		const { a, path } = rig("detach-one-pass.md");
		const own = inlineInk.moveStrokes;
		const calls: string[][] = [];
		Object.defineProperty(inlineInk, "moveStrokes", { configurable: true, value: (p: string, ids: readonly string[], dx: number, dy: number) => (calls.push([...ids]), own.call(inlineInk, p, ids, dx, dy)) });
		try {
			a.overlay.detachAttachment(path, "att-1");
		} finally {
			delete (inlineInk as unknown as { moveStrokes?: unknown }).moveStrokes;
		}
		expect(calls).toEqual([["s1", "s2"]]);
	});

	it("the lasso's Detach acts only when every selected stroke is in the one group", () => {
		// Defect: Detach runs on a selection holding free ink, or on no group, and drops a record the user did not pick.
		const { a, path } = rig("detach-lasso.md");
		const sel = (a.overlay as unknown as { selection: { strokeIds: Set<string> } }).selection;
		sel.strokeIds = new Set(["s1", "free"]);
		expect(a.overlay.detachSelected()).toBe(false);
		expect(inlineInk.attachments(path)).toHaveLength(1);
		sel.strokeIds = new Set(["s2"]);
		expect(a.overlay.detachSelected()).toBe(true);
		expect(inlineInk.attachments(path)).toEqual([]);
		expect(a.sent).toHaveLength(1);
	});
});
