/**
 * Group attach: a lasso over two or more attached groups, loose ink in it or not, and the Attach button attaches them
 * as one group on the text under the whole selection box (today's Attach rule). Nothing shown moves; the editor
 * history grows by one step, one undo puts every group back and every stored point where it was, one redo merges
 * again. A second tap detaches the merged group. Every selected group that follows its text shows the mark on it.
 * A bare overlay with the real selection model, a fake view: no DOM, no layout read.
 */
import { describe, expect, it, vi } from "vitest";
import { EditorState, Text, type TransactionSpec } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { SelectionModel } from "../objects/SelectionModel";
import { attachmentMembership, attachmentSelection, targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";
import { invertInkOp, type InkOp } from "./InkHistory";
import * as decoration from "./AttachDecoration";
import { ATTACH_STRINGS, attachTargetField, chipState, selectionChips, setAttachTarget, syncWithoutChrome, toggleAttach } from "./AttachDecoration";

const notices: string[] = [];
vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();
	return { ...actual, Notice: class { constructor(message: string) { notices.push(message); } } };
});

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LINES = 60;
const LH = 40;
const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();
/** Each group is read 6 right and 12 down of its record (a lag adds to the 12); the members' own anchors read 80 down. */
const READ = { x: 6, y: 12 };
const OWN_SHIFT = 80;
const FREE_LINE = 50;

const topOf = (line: number) => (line - 1) * LH;
const lineOf = (pos: number) => doc.lineAt(pos).number;

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/**
 * Group n (from 1): two strokes on line 4n - 1, attached to that line's words. `lag` is text typed above the group after
 * it was attached: its record's reference point sits that much higher, so the group shows that much further down.
 */
function group(n: number, lag = 0): { record: AttachmentRecord; strokes: InkStroke[] } {
	const line = 4 * n - 1, top = topOf(line), l = doc.line(line), id = `g${n}`;
	const strokes = [strokeAt(`${id}a`, 10, top + 5), strokeAt(`${id}b`, 40, top + 10)];
	const record: AttachmentRecord = {
		v: 1, id, strokeIds: strokes.map((s) => s.id), target: targetAt(DOC, l.from, l.to, "range"), ref: { x: 0, y: top - lag },
		layout: { width: 892, font: 26 }, probe: { id: strokes[0]!.id, x: 10, y: top + 9 },
	};
	return { record, strokes };
}

interface RigOptions {
	held?: readonly string[];
	/** Text typed above a group after it was attached, by group id. */
	lag?: Readonly<Record<string, number>>;
	/** The store's list holds the groups last first. */
	reversed?: boolean;
	/** The measure is kept for the cell to run, not run at the request. */
	holdMeasure?: boolean;
}

const measureOf = (extra: number) => ({
	inView: () => true,
	refAt: (pos: number) => ({ x: READ.x, y: topOf(lineOf(pos)) + READ.y + extra }),
	blockTop: (pos: number) => topOf(lineOf(pos)) + extra,
});

/** A pane on `path`: its own anchors and follow, measured, and an overlay over them. */
function pane(path: string, opts: RigOptions) {
	const state = { shift: 0, box: null as null | { x: number; y: number; width: number; height: number }, refNull: false };
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => topOf(n) + state.shift, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	for (const s of inlineInk.strokes(path)) anchors.anchorNew(path, s);
	anchors.strokesFor(path, inlineInk.strokes(path));
	const sent: TransactionSpec[] = [];
	const measures: { read: () => unknown; write: (m: unknown) => void }[] = [];
	const selection = new SelectionModel();
	const view = {
		scaleY: 1,
		defaultLineHeight: LH,
		state: { doc },
		viewport: { from: 0, to: doc.length },
		dom: { isConnected: true },
		lineBlockAt: (pos: number) => { const n = lineOf(pos), l = doc.line(n); return { from: l.from, to: l.to, top: topOf(n), bottom: topOf(n) + LH }; },
		lineBlockAtHeight: (h: number) => {
			const n = Math.min(LINES, Math.max(1, Math.floor(h / LH) + 1)), l = doc.line(n);
			return { from: l.from, to: l.to, top: topOf(n), bottom: topOf(n) + LH };
		},
		requestMeasure: (m: { read: () => unknown; write: (v: unknown) => void }) => (opts.holdMeasure ? measures.push(m) : m.write(m.read())),
		dispatch: (spec: TransactionSpec) => sent.push(spec),
	};
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	const shownStrokes = () => {
		anchors.follow.setList(inlineInk.attachments(path));
		return anchors.strokesFor(path, inlineInk.strokes(path));
	};
	Object.assign(overlay, {
		lineAnchorState: anchors,
		view,
		fontZoom: 1,
		followRefAt: (pos: number) => (state.refNull ? null : { x: READ.x, y: topOf(lineOf(pos)) + READ.y }),
		selectionBounds: () => {
			if (state.box) return state.box;
			const ids = new Set(selection.strokeIds), boxes = shownStrokes().filter((s) => ids.has(s.id)).map((s) => s.bbox);
			if (boxes.length === 0) return null;
			const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
			return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
		},
		filePath: () => path,
		strokesHere: () => anchors.strokesFor(path, inlineInk.strokes(path)),
		endLiveGestureForHistory: () => {},
		scheduleRepaint: () => {},
		repaintPath: () => {},
		redrawSelectionUI: () => {},
		refreshStrip: () => {},
		lineAnchorsMoved: () => {},
		currentIndexes: () => [],
		frontierCache: { invalidate: () => {} },
		spaceSnapshot: null,
		selection,
	});
	state.shift = OWN_SHIFT;
	anchors.layoutChanged(path, inlineInk.strokes(path), "measure");
	anchors.follow.setList(inlineInk.attachments(path));
	anchors.follow.measure(measureOf(0));
	const held = opts.held ?? [];
	if (held.length > 0) anchors.follow.setList(inlineInk.attachments(path), new Map(held.map((id) => [id, "needs-reattachment" as const])));
	const shown = () => shownStrokes().map((s) => ({ id: s.id, x: s.points[0]!.x, y: s.points[0]!.y }));
	return { overlay, anchors, sent, measures, selection, view, state, shown };
}

/** `n` groups stored and read, a loose stroke on line 50. */
function rig(path: string, n: number, opts: RigOptions = {}) {
	const groups = Array.from({ length: n }, (_, i) => group(i + 1, opts.lag?.[`g${i + 1}`] ?? 0));
	const records = groups.map((g) => g.record);
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: opts.reversed ? [...records].reverse() : records };
	rec.strokes = [...groups.flatMap((g) => g.strokes), strokeAt("free", 10, topOf(FREE_LINE) + 5)];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const a = pane(path, opts);
	const select = (ids: readonly string[]) => a.selection.selectExactly(ids);
	const all = groups.flatMap((g) => g.record.strokeIds);
	const stored = () => inlineInk.strokes(path).map((s) => ({ id: s.id, points: s.points.map((p) => [p.x, p.y]) }));
	return { ...a, select, path, records, all, stored };
}
type Rig = ReturnType<typeof rig>;

const ops = (spec: TransactionSpec): InkOp[] => [spec.effects ?? []].flat().map((e) => (e as { value: InkOp }).value).filter((v) => v && typeof v === "object" && "type" in v);
const inkSteps = (sent: readonly TransactionSpec[]) => sent.filter((s) => ops(s).length > 0);
const close = (got: { id: string; x: number; y: number }[], want: { id: string; x: number; y: number }[], what = "") => {
	expect(got.map((s) => s.id), what).toEqual(want.map((s) => s.id));
	got.forEach((s, i) => {
		expect(s.x, `${what} ${s.id}`).toBeCloseTo(want[i]!.x, 9);
		expect(s.y, `${what} ${s.id}`).toBeCloseTo(want[i]!.y, 9);
	});
};
const byId = (list: readonly AttachmentData[]) => [...list].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
/** One queued task: the measure's write queues the attach the same way (queueMicrotask), so it has run by then. */
const flush = () => new Promise<void>((res) => queueMicrotask(res));

/** The Attach button's tap, its measure and the step made just after it. */
async function tap(r: Rig): Promise<"attached" | "detached" | null> {
	const did = toggleAttach(r.overlay, inlineInk.attachments(r.path));
	await flush();
	return did;
}

/**
 * One history step replayed as the editor does it (InkOverlayReload): a step of several ops is read whole against the
 * store first, and when one op is spent none applies. True when it applied.
 */
function replay(r: Rig, step: readonly InkOp[]): boolean {
	if (step.length > 1 && !step.every((op) => r.overlay.inkOpStands(op, false))) return false;
	for (const op of step) r.overlay.applyInkOp(op, false);
	return true;
}

type Stored = { id: string; points: number[][] }[];

/**
 * The strokes of the lasso `ids` that one undo stores where they were shown, so nothing shown moves: a loose stroke in
 * the lasso, as one group plus loose ink does today, and every member of a lassoed group needing reattachment, as today's
 * Detach and undo of one does. Read before the tap.
 */
function storedWhereShown(r: Rig, ids: readonly string[]): Set<string> {
	const list = inlineInk.attachments(r.path) as AttachmentRecord[], inGroup = new Set(list.flatMap((a) => a.strokeIds));
	const held = list.filter((a) => a.strokeIds.some((s) => ids.includes(s)) && !r.anchors.follow.followsText(a.id));
	return new Set([...ids.filter((s) => !inGroup.has(s)), ...held.flatMap((a) => a.strokeIds)]);
}

/**
 * One undo's store: every stroke of `where` stored where it was shown before the tap (all its points by the one move
 * from its stored first point to its shown one), every other stroke, a group that follows its text included, exactly as
 * before the tap.
 */
function storedBack(r: Rig, points: Stored, before: { id: string; x: number; y: number }[], where: ReadonlySet<string>) {
	const what = "one undo puts every stored point back";
	const want = points.map((s) => {
		if (!where.has(s.id)) return s;
		const at = before.find((b) => b.id === s.id)!, dx = at.x - s.points[0]![0]!, dy = at.y - s.points[0]![1]!;
		return { id: s.id, points: s.points.map(([x, y]) => [x! + dx, y! + dy]) };
	});
	const got = r.stored();
	expect(got.map((s) => s.id), what).toEqual(want.map((s) => s.id));
	got.forEach((s, i) => {
		expect(s.points.length, `${what} ${s.id}`).toBe(want[i]!.points.length);
		s.points.forEach(([x, y], j) => {
			expect(x, `${what} ${s.id} x${j}`).toBeCloseTo(want[i]!.points[j]![0]!, 9);
			expect(y, `${what} ${s.id} y${j}`).toBeCloseTo(want[i]!.points[j]![1]!, 9);
		});
	});
}

/**
 * Typing above, as a layout read: the line moves LH down, a new layout is signalled and the follow measures (a measure
 * skips a group already read in this layout, AttachFollow.measure). Each of `ids`' shown move, x and y.
 */
function typedAbove(r: Rig, ids: readonly string[]): number[][] {
	const at = r.shown();
	r.anchors.follow.layoutChanged();
	r.anchors.follow.setList(inlineInk.attachments(r.path));
	r.anchors.follow.measure(measureOf(LH));
	const moved = r.shown();
	return ids.map((id) => {
		const p = at.find((s) => s.id === id)!, q = moved.find((s) => s.id === id)!;
		return [Math.round((q.x - p.x) * 1e6) / 1e6, Math.round((q.y - p.y) * 1e6) / 1e6];
	});
}

/** Tap on every group's ink, then the one step undone and redone: the merge, the groups back, the merge again. */
async function mergeUndoRedo(r: Rig, ids: readonly string[]) {
	r.select(ids);
	const before = r.shown(), points = r.stored(), list = byId(inlineInk.attachments(r.path)), where = storedWhereShown(r, ids);
	expect(await tap(r), "the tap attached").toBe("attached");
	const merged = inlineInk.attachments(r.path);
	expect(merged, "one record after the tap").toHaveLength(1);
	const want = [...new Set([...ids, ...r.records.filter((g) => g.strokeIds.some((s) => ids.includes(s))).flatMap((g) => g.strokeIds)])].sort();
	expect([...(merged[0] as AttachmentRecord).strokeIds].sort(), "its strokes are the union").toEqual(want);
	close(r.shown(), before, "no shown point moves at the tap");
	const steps = inkSteps(r.sent);
	expect(steps, "one history step").toHaveLength(1);
	const step = ops(steps[0]!);
	const opIds = step.map((o) => (o as { id?: string }).id);
	expect(new Set(opIds).size, "one op per group id in the step").toBe(opIds.length);
	expect(replay(r, step.map(invertInkOp)), "the undo applies").toBe(true);
	expect(byId(inlineInk.attachments(r.path)), "one undo puts every group back").toEqual(list);
	storedBack(r, points, before, where);
	close(r.shown(), before, "no shown point moves at the undo");
	expect(replay(r, step), "the redo applies").toBe(true);
	expect(inlineInk.attachments(r.path), "one redo merges again").toEqual(merged);
	close(r.shown(), before, "no shown point moves at the redo");
	return { before, merged: merged[0] as AttachmentRecord, step };
}

describe("group attach: the Attach button on two groups or more", () => {
	it("two groups on two paragraphs: one record, the union; nothing moves; one step; undo and redo", async () => {
		// Defect: the tap detaches both groups (today's rule), or merges in two history steps, or one undo puts back one group.
		const r = rig("group-attach-two.md", 2);
		await mergeUndoRedo(r, r.all);
	});

	it("the merged group hooks to the text under the whole selection box, today's Attach rule", async () => {
		// Defect: the merge keeps the first group's text, or the text of the group with the most ink.
		const r = rig("group-attach-text.md", 2);
		r.select(r.all);
		expect(await tap(r)).toBe("attached");
		const a = inlineInk.attachments(r.path)[0] as AttachmentRecord;
		// The box runs from line 3 to line 7; its centre is on line 5.
		const l5 = doc.line(5);
		expect([a.target.from, a.target.to], "line 5's words").toEqual([l5.from, l5.to]);
	});

	for (const reversed of [false, true]) {
		it(`two groups shown by different corrections${reversed ? ", the store listing them last first" : ""}: nothing moves at the tap, the undo or the redo; then typing above moves every member by one amount`, async () => {
			// Defect: the undo stores the absorbed group's ink where its own correction showed it, so after the undo it
			// draws off by that correction again (the step built "detach the others, then attach"); or every member
			// settles by the first group's correction.
			const r = rig(`group-attach-lag${reversed ? "-rev" : ""}.md`, 2, { lag: { g2: 30 }, reversed });
			const { before, merged, step } = await mergeUndoRedo(r, r.all);
			// The step records each member where it was shown before the tap: its stored first point then (`from`) plus
			// its move is that shown point, the absorbed group's members as the first group's.
			type Settle = { strokeIds: string[]; from: { x: number; y: number }[]; dx: number[]; dy: number[] };
			const attach = step.find((o) => "settle" in o && "after" in o && o.after) as { settle: Settle } | undefined;
			expect(attach, "the step's attach op has its settle").toBeDefined();
			const st = attach!.settle;
			const recorded = st.strokeIds.map((id, i) => ({ id, x: st.from[i]!.x + st.dx[i]!, y: st.from[i]!.y + st.dy[i]! }));
			close(recorded, st.strokeIds.map((id) => before.find((b) => b.id === id)!), "the step records each member where it was shown");
			const deltas = typedAbove(r, merged.strokeIds);
			expect(new Set(deltas.map((d) => d.join(","))).size, "one amount for every member").toBe(1);
			expect(deltas[0], "the line's move").toEqual([0, LH]);
		});
	}

	it("control, no tap: a group shown by a lag; typing above moves every member by the line's move, the loose stroke not", () => {
		// Control for the two cells above, on today's path: the same read with no merge. Defect: the read moves nothing
		// (a measure in the layout already read), so the cells above could not tell a merge that broke the follow.
		const r = rig("group-attach-lag-control.md", 1, { lag: { g1: 30 } });
		expect(typedAbove(r, ["g1a", "g1b", "free"])).toEqual([[0, LH], [0, LH], [0, 0]]);
	});

	it("the undo's first op alone, the absorbed group back while the merged record stands: no shown point moves", async () => {
		// Pin: between the undo's two ops the absorbed group's strokes are in two records, its own and the merged one,
		// and every point still shows where it showed before the tap.
		const r = rig("group-attach-undo-first.md", 2, { lag: { g2: 30 } });
		r.select(r.all);
		const before = r.shown();
		expect(await tap(r), "the tap attached").toBe("attached");
		const merged = inlineInk.attachments(r.path)[0] as AttachmentRecord;
		const step = ops(inkSteps(r.sent)[0]!);
		expect(step, "the absorbed group to none, then the kept group's op").toHaveLength(2);
		const first = invertInkOp(step[0]!);
		expect(r.overlay.inkOpStands(first, false), "the undo's first op stands alone").toBe(true);
		r.overlay.applyInkOp(first, false);
		const list = inlineInk.attachments(r.path) as AttachmentRecord[];
		expect(byId(list).map((a) => a.id), "the absorbed group back beside the merged record").toEqual(byId(r.records).map((a) => a.id));
		expect(list.find((a) => a.id === merged.id)!.strokeIds, "the merged record as it was").toEqual(merged.strokeIds);
		const back = list.find((a) => a.id !== merged.id)!;
		expect(back.strokeIds.every((s) => merged.strokeIds.includes(s)), "its strokes in two records").toBe(true);
		close(r.shown(), before, "no shown point moves at the undo's first op");
	});

	it("two groups and loose ink: one group with the loose stroke in it", async () => {
		// Defect: loose ink in the lasso turns Attach off, or stays loose beside the merged group.
		const r = rig("group-attach-loose.md", 2);
		await mergeUndoRedo(r, ["g1a", "g2b", "free"]);
	});

	it("three groups, one needing reattachment: one group of all three", async () => {
		// Defect: the held group is skipped, so its record stays beside the merged one.
		const r = rig("group-attach-held.md", 3, { held: ["g2"] });
		expect(r.anchors.follow.followsText("g2"), "premise: g2 needs reattachment").toBe(false);
		await mergeUndoRedo(r, r.all);
	});

	it("control, today's path: one group and loose ink; one undo puts the group back, the loose stroke stored where shown", async () => {
		// Control for the loose-ink cell above: today's Attach of one group plus loose ink, the same store rule. Defect:
		// the old path stores the loose stroke elsewhere, so the merge cell's rule is not today's.
		const r = rig("group-attach-loose-one.md", 1);
		await mergeUndoRedo(r, ["g1a", "g1b", "free"]);
	});

	it("control, today's path: one group needing reattachment alone; the tap detaches it, one undo puts it back stored where shown", async () => {
		// Control for the held cell above: today's Detach and undo of one held group, the same store rule. Defect: the old
		// path puts the held group's points back as stored, so the merge cell's rule is not today's.
		const r = rig("group-attach-held-one.md", 3, { held: ["g2"] });
		expect(r.anchors.follow.followsText("g2"), "premise: g2 needs reattachment").toBe(false);
		const ids = ["g2a", "g2b"];
		r.select(ids);
		const before = r.shown(), points = r.stored(), list = byId(inlineInk.attachments(r.path)), where = storedWhereShown(r, ids);
		expect(await tap(r), "the tap detached").toBe("detached");
		close(r.shown(), before, "no shown point moves at the tap");
		const steps = inkSteps(r.sent);
		expect(steps, "one history step").toHaveLength(1);
		const step = ops(steps[0]!);
		expect(replay(r, step.map(invertInkOp)), "the undo applies").toBe(true);
		expect(byId(inlineInk.attachments(r.path)), "one undo puts every group back").toEqual(list);
		storedBack(r, points, before, where);
		close(r.shown(), before, "no shown point moves at the undo");
		expect(replay(r, step), "the redo applies").toBe(true);
		expect(byId(inlineInk.attachments(r.path)).map((a) => a.id), "the redo detaches it again").toEqual(["g1", "g3"]);
		close(r.shown(), before, "no shown point moves at the redo");
	});

	it("the second tap detaches the merged group; nothing moves", async () => {
		// Defect: the second tap attaches again, or detaches one group's part only.
		const r = rig("group-attach-twice.md", 2);
		r.select(r.all);
		const before = r.shown();
		expect(await tap(r), "first tap").toBe("attached");
		expect(await tap(r), "second tap").toBe("detached");
		expect(inlineInk.attachments(r.path), "all of it loose").toEqual([]);
		close(r.shown(), before);
	});

	it("no text under the selection box: the notice; the list, the points and the history as before", async () => {
		// Defect: the tap detaches the groups, or fails in silence.
		const r = rig("group-attach-no-text.md", 2);
		r.select(r.all);
		r.state.box = { x: 10, y: topOf(LINES) + 400, width: 40, height: 20 };
		const list = inlineInk.attachments(r.path).slice(), points = r.stored();
		notices.length = 0;
		expect(await tap(r)).toBeNull();
		expect(notices).toEqual([ATTACH_STRINGS.noText]);
		expect(inlineInk.attachments(r.path)).toEqual(list);
		expect(r.stored()).toEqual(points);
		expect(inkSteps(r.sent)).toEqual([]);
	});

	it("the merged record is a v1 record: its keys and no other", async () => {
		// Defect: the merge writes a key a 1.5.1 build does not read.
		const r = rig("group-attach-keys.md", 2);
		r.select(r.all);
		expect(await tap(r)).toBe("attached");
		const list = inlineInk.attachments(r.path);
		expect(list, "premise: one merged record").toHaveLength(1);
		expect(Object.keys(list[0]!).sort()).toEqual(["id", "layout", "probe", "ref", "strokeIds", "target", "v"]);
		expect((list[0] as AttachmentRecord).v).toBe(1);
	});

	it("a second pane on the note shows the merge, and nothing moves there", async () => {
		// Defect: the other pane draws the absorbed group's ink off by its old correction.
		const r = rig("group-attach-two-panes.md", 2, { lag: { g2: 30 } });
		const b = pane(r.path, {});
		const there = b.shown();
		r.select(r.all);
		expect(await tap(r)).toBe("attached");
		b.anchors.follow.setList(inlineInk.attachments(r.path));
		b.anchors.follow.measure(measureOf(0));
		close(b.shown(), there);
	});
});

describe("group attach: a merge lands whole or not at all", () => {
	it("the text changed between the tap and the measure: every record, point and the history as before", async () => {
		// Defect: the other groups are detached at the tap; the step that would hold them never comes, so they are lost
		// with no undo.
		const r = rig("group-attach-doc-moved.md", 2, { holdMeasure: true });
		r.select(r.all);
		const list = inlineInk.attachments(r.path).slice(), points = r.stored();
		toggleAttach(r.overlay, inlineInk.attachments(r.path));
		r.view.state = { doc: doc.replace(0, 0, Text.of(["x"])) };
		for (const m of r.measures) m.write(m.read());
		await flush();
		expect(inlineInk.attachments(r.path)).toEqual(list);
		expect(r.stored()).toEqual(points);
		expect(inkSteps(r.sent)).toEqual([]);
	});

	it("the text's place cannot be read at the measure: every record, point and the history as before", async () => {
		// Defect: as above, the read coming back empty.
		const r = rig("group-attach-no-ref.md", 2, { holdMeasure: true });
		r.select(r.all);
		const list = inlineInk.attachments(r.path).slice(), points = r.stored();
		toggleAttach(r.overlay, inlineInk.attachments(r.path));
		r.state.refNull = true;
		for (const m of r.measures) m.write(m.read());
		await flush();
		expect(inlineInk.attachments(r.path)).toEqual(list);
		expect(r.stored()).toEqual(points);
		expect(inkSteps(r.sent)).toEqual([]);
	});
});

describe("group attach: the chips, the palette and the button", () => {
	it("two groups: Attach and Detach both on, loose ink in the lasso or not; the table and the follow's map agree", () => {
		// Defect: two groups keep Attach off, or the two answers drift apart.
		const { records } = rig("group-attach-chips.md", 2);
		const map = attachmentMembership(records);
		for (const ids of [["g1a", "g1b", "g2a", "g2b"], ["g1a", "g2a", "free"]]) {
			expect(attachmentSelection(records, ids), ids.join(" ")).toMatchObject({ attach: true, detach: true, groupIds: ["g1", "g2"] });
			expect(chipState(map, ids), ids.join(" ")).toMatchObject({ attach: true, detach: true, groupIds: ["g1", "g2"] });
		}
	});

	it("the palette lists Attach for two groups, and its Detach still detaches each in one step", () => {
		// Defect: the palette's Attach stays hidden, or its Detach left with the button's.
		const r = rig("group-attach-palette.md", 2);
		r.select(r.all);
		const chips = selectionChips(r.overlay, inlineInk.attachments(r.path));
		expect(chips.attach, "Attach listed").toBe(true);
		expect(chips.detach, "Detach listed").toBe(true);
		expect(r.overlay.detachSelected()).toBe(true);
		expect(inlineInk.attachments(r.path)).toEqual([]);
		expect(inkSteps(r.sent)).toHaveLength(1);
	});

	it("the button wears the loose fill for two groups or more, the attached fill for one whole group", () => {
		// Defect: two groups show the attached fill, so the button reads as Detach.
		const { records } = rig("group-attach-fill.md", 2);
		const map = attachmentMembership(records);
		expect(decoration.attachButtonAttached(chipState(map, ["g1a", "g1b"])), "one whole group").toBe(true);
		expect(decoration.attachButtonAttached(chipState(map, ["g1a", "free"])), "a group and loose ink").toBe(false);
		expect(decoration.attachButtonAttached(chipState(map, ["g1a", "g2a"])), "two groups").toBe(false);
		expect(decoration.attachButtonAttached(chipState(map, ["g1a", "g2a", "free"])), "two groups and loose ink").toBe(false);
	});
});

/** A chrome overlay for the mark: its follow answers from the list, its view keeps what it is sent. */
function markRig(list: readonly AttachmentData[], held: readonly string[] = []) {
	const sent: TransactionSpec[] = [];
	const follow = { setList: () => {}, memberMap: attachmentMembership(list), followsText: (id: string) => !held.includes(id), groupOffset: () => ({ dx: 0, dy: 0 }), generation: 0 };
	const selection = { strokeIds: [] as string[], revision: 0, isEmpty: true };
	const o = {
		filePath: () => "marks.md",
		lineAnchors: { follow, freeFor: () => ({ members: new Map() }) },
		selection,
		view: { dom: { isConnected: true }, dispatch: (s: TransactionSpec) => sent.push(s) },
		refreshStrip: () => {},
		scheduleRepaint: () => {},
		camera: { snapshot: { zoom: 1 } },
		cssScale: 1,
		damage: { addRect: () => {} },
	};
	let state = EditorState.create({ doc: DOC, extensions: [attachTargetField] });
	/** A redraw with these strokes selected; what it dispatched lands on the editor state. */
	const redraw = async (ids: readonly string[], now: readonly AttachmentData[] = list) => {
		follow.memberMap = attachmentMembership(now);
		selection.strokeIds = [...ids];
		selection.isEmpty = ids.length === 0;
		selection.revision++;
		const n = sent.length;
		syncWithoutChrome(o as never, now, [], 0);
		await flush();
		for (const spec of sent.slice(n)) state = state.update(spec).state;
		return sent.length - n;
	};
	const marks = () => {
		const out: [number, number][] = [];
		state.field(attachTargetField).between(0, state.doc.length, (from, to) => void out.push([from, to]));
		return out;
	};
	const edit = (spec: TransactionSpec) => void (state = state.update(spec).state);
	return { redraw, marks, edit, sent };
}

describe("group attach: every selected group's text is marked", () => {
	const g1 = group(1).record, g2 = group(2).record, g3 = group(3).record;
	const span = (r: AttachmentRecord): [number, number] => [r.target.from, r.target.to];

	it("two groups, the lower selected first: two marks at their texts, in order", async () => {
		// Defect: only the first group is marked, or the marks are handed over unsorted and the field throws.
		const m = markRig([g1, g2]);
		await m.redraw(["g2a", "g2b", "g1a", "g1b"]);
		expect(m.marks()).toEqual([span(g1), span(g2)]);
	});

	it("a group whose text sits inside another's: both marked", async () => {
		// Defect: a mark nested in another throws, or the inner one is dropped.
		const l = doc.line(3), inner: AttachmentRecord = { ...g3, id: "inner", target: targetAt(DOC, l.from + 7, l.to, "range") };
		const m = markRig([inner, g1]);
		await m.redraw(["g3a", "g3b", "g1a", "g1b"]);
		expect(m.marks()).toEqual([span(g1), [l.from + 7, l.to]]);
	});

	it("two groups on one text: one mark", async () => {
		// Defect: the shared text is marked twice.
		const twin: AttachmentRecord = { ...g2, target: g1.target };
		const m = markRig([g1, twin]);
		await m.redraw(["g1a", "g2a"]);
		expect(m.marks()).toEqual([span(g1)]);
	});

	it("a group needing reattachment shows none; nothing selected, none", async () => {
		// Defect: a held group's old text is marked, or the marks stay after the selection goes.
		const m = markRig([g1, g2], ["g2"]);
		await m.redraw(["g1a", "g2a"]);
		expect(m.marks()).toEqual([span(g1)]);
		await m.redraw([]);
		expect(m.marks()).toEqual([]);
	});

	it("after the merge, one mark; the marks map through an edit before them", async () => {
		// Defect: the old groups' marks stay after the merge, or an edit leaves a mark on the wrong words.
		const m = markRig([g1, g2]);
		await m.redraw(["g1a", "g2a"]);
		expect(m.marks()).toHaveLength(2);
		m.edit({ changes: { from: 0, insert: "ab" } });
		expect(m.marks(), "mapped").toEqual([[g1.target.from + 2, g1.target.to + 2], [g2.target.from + 2, g2.target.to + 2]]);
		const l5 = doc.line(5), merged: AttachmentRecord = { ...g1, strokeIds: [...g1.strokeIds, ...g2.strokeIds], target: targetAt(DOC, l5.from, l5.to, "range") };
		const m2 = markRig([merged]);
		await m2.redraw(["g1a", "g2a"]);
		expect(m2.marks()).toEqual([span(merged)]);
	});

	it("a redraw whose texts did not change dispatches nothing", async () => {
		// Defect: every redraw dispatches the marks again (an editor update per frame).
		const m = markRig([g1, g2]);
		expect(await m.redraw(["g1a", "g2a"]), "the first redraw sets them").toBe(1);
		expect(await m.redraw(["g1a", "g2a"]), "the same texts: nothing").toBe(0);
		expect(await m.redraw(["g2a", "g1a"]), "the same texts in another order: nothing").toBe(0);
		expect(m.marks()).toEqual([span(g1), span(g2)]);
	});

	it("the effect still takes one range or none", () => {
		// Defect: the one-group callers break when the effect takes a list.
		let s = EditorState.create({ doc: DOC, extensions: [attachTargetField] });
		s = s.update({ effects: setAttachTarget.of({ from: 5, to: 9 }) }).state;
		const got: [number, number][] = [];
		s.field(attachTargetField).between(0, s.doc.length, (f, t) => void got.push([f, t]));
		expect(got).toEqual([[5, 9]]);
	});

	it("the effect takes a list in any order, one span inside another: each marked once, in text order", () => {
		// Defect: the field builds its set unsorted and throws on a span that starts before the last one, so no mark shows.
		const l = doc.line(3), at = (r: AttachmentRecord) => ({ from: r.target.from, to: r.target.to });
		let s = EditorState.create({ doc: DOC, extensions: [attachTargetField] });
		s = s.update({ effects: setAttachTarget.of([at(g2), at(g1), { from: l.from + 7, to: l.to }]) }).state;
		// Read in text order: a span inside another sits in the set's next layer, which between() walks after the first.
		const got: [number, number][] = [];
		for (const c = s.field(attachTargetField).iter(); c.value; c.next()) got.push([c.from, c.to]);
		expect(got).toEqual([span(g1), [l.from + 7, l.to], span(g2)]);
	});
});

describe("attach: a group needing reattachment plus loose ink", () => {
	it("one held group plus loose ink: the tap attaches; no shown point moves at the tap, the undo or the redo", async () => {
		// Defect: the settle stores the held group less its last read, then the Attach places it with no correction, so
		// the group and the loose stroke show 6 left and 12 up at the tap, and the save writes them there.
		const r = rig("attach-held-plus-loose.md", 3, { held: ["g2"] });
		expect(r.anchors.follow.followsText("g2"), "premise: g2 needs reattachment").toBe(false);
		r.select(["g2a", "g2b", "free"]);
		const before = r.shown();
		expect(await tap(r), "the tap attached").toBe("attached");
		close(r.shown(), before, "no shown point moves at the tap");
		const steps = inkSteps(r.sent);
		expect(steps, "one history step").toHaveLength(1);
		const step = ops(steps[0]!);
		expect(replay(r, step.map(invertInkOp)), "the undo applies").toBe(true);
		close(r.shown(), before, "no shown point moves at the undo");
		expect(replay(r, step), "the redo applies").toBe(true);
		close(r.shown(), before, "no shown point moves at the redo");
	});
});

describe("attach: a group needing reattachment, its pin dropped on a line", () => {
	for (const [where, line] of [["its own line", 7], ["another line", 5]] as const) {
		it(`the held group's pin dropped on ${where}: it attaches there; no shown point moves at the drop, the undo or the redo`, async () => {
			// The pin drop is the other road into attachAt: it attaches one group alone, which the Attach tap cannot (one group
			// under the lasso makes the button a Detach). Defect: the drop settles the held group less its last read and places
			// it with no correction, so its ink shows away from where it was at the drop, and the save writes it there.
			const r = rig(`attach-held-pin-line-${line}.md`, 3, { held: ["g2"] });
			expect(r.anchors.follow.followsText("g2"), "premise: g2 needs reattachment").toBe(false);
			const before = r.shown(), list = byId(inlineInk.attachments(r.path));
			expect(r.overlay.dropAttachPin("g2", { x: 300, y: topOf(line) + LH / 2 }), "the drop is taken").toBe(true);
			await flush();
			const g2 = inlineInk.attachments(r.path).find((a) => a.id === "g2") as AttachmentRecord;
			expect(g2.target, "g2 hooks the line it was dropped on").toMatchObject({ kind: "paragraph", text: doc.line(line).text });
			close(r.shown(), before, "no shown point moves at the drop");
			const steps = inkSteps(r.sent);
			expect(steps, "one history step").toHaveLength(1);
			const step = ops(steps[0]!);
			expect(replay(r, step.map(invertInkOp)), "the undo applies").toBe(true);
			expect(byId(inlineInk.attachments(r.path)), "one undo puts g2 back as it was").toEqual(list);
			close(r.shown(), before, "no shown point moves at the undo");
			expect(replay(r, step), "the redo applies").toBe(true);
			close(r.shown(), before, "no shown point moves at the redo");
		});
	}
});
