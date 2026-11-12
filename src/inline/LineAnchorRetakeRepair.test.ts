/**
 * When retakeMembers deletes a moved group's member anchors, or anchors them again, the surface's own list of anchored
 * strokes is made again from itself in the same call (LineAnchor.ts retakeMembers): the strokes without an anchor leave
 * it with their places, and the strokes on its first and last anchored lines are found again. The list is then what a
 * build from the store's list returns, and the next strokesFor reads it as it is, with no build. A list that is not
 * current when the call runs is built again at its next read, as before.
 *
 * One bare surface over one store list and one layout, called as updateLineAnchors and followDocChanged or the measure
 * loop's followMoved call it; no DOM.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LH = 40;
const ID = "retake-repair-group";

/** Every line LH tall, plus `extra` px on every line from `from` down (a line above wrapped to a second row). */
const topOf = (from: number, extra: number) => (n: number) => (n - 1) * LH + (n >= from ? extra : 0);

function layoutOf(doc: Text, top = topOf(1, 0)): LineLayout {
	return { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: top, pxPerWorld: 1 };
}

/** What the follow's measure reads of an editor whose lines sit at `top` and are drawn. */
const view = (doc: Text, top = topOf(1, 0)) => ({
	inView: () => true,
	refAt: (pos: number) => ({ x: 0, y: top(doc.lineAt(pos).number) }),
	blockTop: (pos: number) => top(doc.lineAt(pos).number),
});

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

const lines = (n: number) => Text.of(Array.from({ length: n }, (_, i) => `line ${i + 1} words`));

type Rec = { src: readonly InkStroke[]; len: number; ink: number; list: InkStroke[]; at: number[]; top: InkStroke | null; bottom: InkStroke | null; stale: boolean };
type Inner = { anchored: Rec | null; anchoredIn(src: readonly InkStroke[]): InkStroke[] };
const inner = (x: LineAnchors) => x as unknown as Inner;

/** The record as the cells compare it: its strokes in order, their places, the first and last line's strokes, stale. */
const shape = (r: Rec | null) => r && { ids: r.list.map((s) => s.id), at: r.at.slice(), top: r.top?.id ?? null, bottom: r.bottom?.id ?? null, stale: r.stale };

/** What a build from the store's list returns now: the record marked stale and read. Changes the surface's record. */
function rebuilt(x: LineAnchors, src: readonly InkStroke[]) {
	const i = inner(x);
	if (i.anchored) i.anchored.stale = true;
	i.anchoredIn(src);
	return shape(i.anchored);
}

const anchorLine = (s: InkStroke | undefined) => s?.lineAnchor?.line ?? null;

/**
 * One pane on a 20-line note. The strokes go on the store list in the order given and are anchored as they are
 * committed, but for the ids in `old`, which go on the list with no anchor (ink from the file, not yet anchored). A group
 * on line 10's paragraph lists the ids in `members`. The pane has read every anchor and the group.
 */
function onePane(path: string, strokes: InkStroke[], members: string[], old: string[] = []) {
	const before = lines(20);
	const st = { layout: layoutOf(before) };
	const a = new LineAnchors(() => st.layout, () => true);
	const src: InkStroke[] = [];
	a.setSignature(SIG);
	a.tracks(path, src);
	a.drawn(1, 20);
	a.drawn(1, 20, true, true);
	for (const s of strokes) {
		src.push(s);
		if (!old.includes(s.id)) a.anchorNew(path, s);
	}
	a.layoutChanged(path, src, "measure");
	const line10 = before.line(10), m0 = strokes.find((s) => s.id === members[0])!;
	const rec: AttachmentRecord = {
		v: 1, id: ID, strokeIds: members, target: targetAt(before.toString(), line10.from, line10.to, "paragraph"),
		ref: { x: 0, y: 9 * LH }, layout: { width: SIG.width, font: SIG.fontPx }, probe: { id: m0.id, x: m0.points[0]!.x, y: m0.points[0]!.y },
	};
	a.follow.setList([rec]);
	a.follow.measure(view(before));
	const premise = {
		writes: a.writesAttachments,
		anchored: src.filter((s) => s.lineAnchor).map((s) => s.id),
		list: shape(inner(a).anchored)?.ids ?? null,
		groupDy: a.follow.groupOffset(ID)?.dy ?? null,
	};
	return { before, st, a, src, premise };
}

/**
 * An Enter at the end of line `enterAt`, typed in the pane: updateLineAnchors' docChanged, then followDocChanged: the group
 * moved, the list shared, retakeMembers with the snapshot. The Enter goes on the pane's log and opens the rebase window, so
 * the members are not anchored again but lose their anchors.
 */
function enter(path: string, p: ReturnType<typeof onePane>, enterAt: number, top = topOf(1, 0)) {
	const { before, st, a, src } = p;
	const changes = ChangeSet.of({ from: before.line(enterAt).to, insert: "\n" }, before.length);
	const after = changes.apply(before);
	p.before = after;
	st.layout = layoutOf(after, top);
	a.docChanged(path, src, before, changes, after);
	const snap = a.follow.snapshot();
	const mapped = a.follow.docChanged(changes, view(after, top).blockTop, 1);
	const edit = a.follow.takeEdited();
	a.shareAttachments(mapped);
	const cleared = edit ? a.retakeMembers(path, src, snap) : 0;
	return { edit, cleared, windowOpen: a.windowOpen, lost: src.filter((s) => !s.lineAnchor).map((s) => s.id), groupDy: a.follow.groupOffset(ID)?.dy ?? null };
}

/**
 * A move with no text change and no window open: line 9 takes a second row, so every line from 10 down sits LH lower. The
 * group (on line 10's paragraph) moves LH; the member anchored on line 8 does not show that move and is anchored again,
 * the members anchored on line 10 do. As the measure loop runs it: the layout read first (unless `noRead`), then the
 * follow's measure, then followMoved's retakeMembers.
 */
function wrapAbove(path: string, p: ReturnType<typeof onePane>, noRead = false, top = topOf(10, LH), draw = (x: LineAnchors) => { x.drawn(1, 20); x.drawn(1, 20, true, true); }) {
	const { before, st, a, src } = p;
	st.layout = layoutOf(before, top);
	// The measure loop's update: the drawn lines' heights go on record, the follow hears a layout change.
	draw(a);
	a.follow.layoutChanged();
	if (!noRead) a.layoutChanged(path, src, "measure");
	const snap = a.follow.snapshot();
	a.follow.measure(view(before, top));
	const cleared = a.retakeMembers(path, src, snap);
	return { cleared, windowOpen: a.windowOpen, lost: src.filter((s) => !s.lineAnchor).map((s) => s.id), groupDy: a.follow.groupOffset(ID)?.dy ?? null };
}

describe("retakeMembers keeps the surface's own anchored list as a build makes it", () => {
	it("members' anchors deleted: the list drops them with their places, its last line's stroke is found again, and it equals a build", () => {
		const path = "retake-repair-delete.md";
		// The free stroke sits on line 2, above the Enter; the members on lines 8 and 10, the last line's stroke a member.
		const p = onePane(path, [strokeAt("f", 10, 1 * LH + 5), strokeAt("m1", 10, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5), strokeAt("m3", 70, 9 * LH + 5)], ["m1", "m2", "m3"]);
		const info0 = JSON.stringify(p.premise);
		expect(p.premise, `premise: one pane writes, every stroke anchored and listed, the group read ${info0}`).toEqual({ writes: true, anchored: ["f", "m1", "m2", "m3"], list: ["f", "m1", "m2", "m3"], groupDy: 0 });
		expect(shape(inner(p.a).anchored), `premise: the list before ${info0}`).toEqual({ ids: ["f", "m1", "m2", "m3"], at: [0, 1, 2, 3], top: "f", bottom: "m2", stale: false });
		const e = enter(path, p, 5);
		const kept = shape(inner(p.a).anchored);
		const info = JSON.stringify({ e, kept });
		expect([e.edit, e.windowOpen, e.cleared, e.lost, e.groupDy], `premise: the Enter moved the group with the window open and every member anchor was deleted ${info}`).toEqual([true, true, 3, ["m1", "m2", "m3"], LH]);
		expect(kept, `the list after the call ${info}`).toEqual({ ids: ["f"], at: [0], top: "f", bottom: "f", stale: false });
		expect(rebuilt(p.a, p.src), `a build ${info}`).toEqual(kept);
	});

	it("a member anchored again on another line: the list keeps every stroke, its first line's stroke is found again, and it equals a build", () => {
		const path = "retake-repair-again.md";
		// g, free, on line 9 and first on the list; m1 on line 8 is the first line's stroke until it is anchored on line 9.
		const p = onePane(path, [strokeAt("g", 10, 8 * LH + 5), strokeAt("m1", 40, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5), strokeAt("m3", 70, 9 * LH + 5), strokeAt("f", 10, 14 * LH + 5)], ["m1", "m2", "m3"]);
		const info0 = JSON.stringify(p.premise);
		expect(p.premise, `premise ${info0}`).toEqual({ writes: true, anchored: ["g", "m1", "m2", "m3", "f"], list: ["g", "m1", "m2", "m3", "f"], groupDy: 0 });
		expect(shape(inner(p.a).anchored), `premise: the list before ${info0}`).toEqual({ ids: ["g", "m1", "m2", "m3", "f"], at: [0, 1, 2, 3, 4], top: "m1", bottom: "f", stale: false });
		const m1 = p.src[1]!, was = anchorLine(m1);
		const w = wrapAbove(path, p);
		const kept = shape(inner(p.a).anchored);
		const info = JSON.stringify({ w, was, now: anchorLine(m1), kept });
		expect([w.windowOpen, w.cleared, w.lost, w.groupDy, was, anchorLine(m1)], `premise: the group moved LH with no window open, no anchor deleted, m1 anchored again from line 8 to line 9 ${info}`).toEqual([false, 0, [], LH, 8, 9]);
		expect(kept, `the list after the call ${info}`).toEqual({ ids: ["g", "m1", "m2", "m3", "f"], at: [0, 1, 2, 3, 4], top: "g", bottom: "f", stale: false });
		expect(rebuilt(p.a, p.src), `a build ${info}`).toEqual(kept);
	});

	it("after the delete, the next strokesFor reads the members only and builds no list", () => {
		const path = "retake-repair-next-read.md";
		const p = onePane(path, [strokeAt("f", 10, 1 * LH + 5), strokeAt("m1", 10, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5), strokeAt("m3", 70, 9 * LH + 5)], ["m1", "m2", "m3"]);
		p.a.strokesFor(path, p.src);
		p.a.strokesFor(path, p.src);
		const e = enter(path, p, 5);
		const rec = inner(p.a).anchored, n = p.a.strokesForCounts, v0 = n.visited, f0 = n.fullReads, c0 = n.calls;
		p.a.strokesFor(path, p.src);
		const seen = { e, calls: n.calls - c0, visited: n.visited - v0, fullReads: n.fullReads - f0, sameRecord: inner(p.a).anchored === rec, list: shape(inner(p.a).anchored) };
		const info = JSON.stringify(seen);
		expect([e.edit, e.cleared, e.lost], `premise: the Enter deleted every member anchor ${info}`).toEqual([true, 3, ["m1", "m2", "m3"]]);
		expect(seen.calls, `premise: one strokesFor ${info}`).toBe(1);
		expect({ sameRecord: seen.sameRecord, visited: seen.visited, fullReads: seen.fullReads }, `the read after the call ${info}`).toEqual({ sameRecord: true, visited: 3, fullReads: 0 });
	});

	it("a list already stale when the call runs is built again at its next read, so ink anchored since it was built is in it", () => {
		const path = "retake-repair-stale.md";
		// o is ink from the file with no anchor: not on the list when it is built. The old-ink pass anchors it and marks the
		// list stale; the move runs before any read.
		const p = onePane(path, [strokeAt("g", 10, 8 * LH + 5), strokeAt("m1", 40, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5), strokeAt("m3", 70, 9 * LH + 5), strokeAt("o", 10, 2 * LH + 5)], ["m1", "m2", "m3"], ["o"]);
		const info0 = JSON.stringify(p.premise);
		expect(p.premise, `premise: o not anchored, not listed ${info0}`).toEqual({ writes: true, anchored: ["g", "m1", "m2", "m3"], list: ["g", "m1", "m2", "m3"], groupDy: 0 });
		const took = p.a.anchorMeasured(path, p.src);
		const staleAfterPass = inner(p.a).anchored?.stale ?? null;
		const w = wrapAbove(path, p, true);
		const info = JSON.stringify({ took, staleAfterPass, w, o: anchorLine(p.src[4]) });
		expect([took, staleAfterPass, anchorLine(p.src[4])], `premise: the old-ink pass anchored o on line 3 and marked the list stale ${info}`).toEqual([1, true, 3]);
		expect([w.windowOpen, w.cleared, w.groupDy, anchorLine(p.src[1])], `premise: the move anchored m1 again with no window open ${info}`).toEqual([false, 0, LH, 9]);
		const read = inner(p.a).anchoredIn(p.src).map((s) => s.id);
		expect(read, `the next read ${info}`).toEqual(["g", "m1", "m2", "m3", "o"]);
	});

	/** An Enter at the end of line 5 over the strokes given, the group on line 10's paragraph: the record after, and a build. */
	const afterDelete = (path: string, strokes: InkStroke[], members: string[]) => {
		const p = onePane(path, strokes, members);
		const e = enter(path, p, 5);
		const kept = shape(inner(p.a).anchored);
		return { premise: p.premise, e, kept, build: rebuilt(p.a, p.src) };
	};

	it("every anchored stroke a member and every anchor deleted: the list is empty, with no first or last line's stroke, and equals a build", () => {
		const r = afterDelete("retake-repair-all.md", [strokeAt("m1", 10, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5), strokeAt("m3", 70, 9 * LH + 5)], ["m1", "m2", "m3"]);
		const info = JSON.stringify(r);
		expect([r.premise.list, r.e.edit, r.e.windowOpen, r.e.lost], `premise: every stroke listed, the Enter deleted every anchor ${info}`).toEqual([["m1", "m2", "m3"], true, true, ["m1", "m2", "m3"]]);
		expect(r.kept, `the list after the call ${info}`).toEqual({ ids: [], at: [], top: null, bottom: null, stale: false });
		expect(r.build, `a build ${info}`).toEqual(r.kept);
	});

	it("the list's first and last strokes both deleted: the stroke between keeps its place and is the first and last line's stroke, as a build makes it", () => {
		const r = afterDelete("retake-repair-ends.md", [strokeAt("m1", 10, 7 * LH + 5), strokeAt("f", 10, 1 * LH + 5), strokeAt("m2", 40, 9 * LH + 5)], ["m1", "m2"]);
		const info = JSON.stringify(r);
		expect([r.premise.list, r.e.edit, r.e.windowOpen, r.e.lost], `premise ${info}`).toEqual([["m1", "f", "m2"], true, true, ["m1", "m2"]]);
		expect(r.kept, `the list after the call ${info}`).toEqual({ ids: ["f"], at: [1], top: "f", bottom: "f", stale: false });
		expect(r.build, `a build ${info}`).toEqual(r.kept);
	});

	it("two strokes on the first anchored line and two on the last: the first of each in the list's order is that line's stroke, as a build finds it", () => {
		const r = afterDelete("retake-repair-ties.md", [strokeAt("f1", 10, 1 * LH + 5), strokeAt("f2", 60, 1 * LH + 5), strokeAt("m1", 10, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5), strokeAt("g1", 10, 14 * LH + 5), strokeAt("g2", 60, 14 * LH + 5)], ["m1", "m2"]);
		const info = JSON.stringify(r);
		expect([r.e.edit, r.e.windowOpen, r.e.lost], `premise ${info}`).toEqual([true, true, ["m1", "m2"]]);
		expect(r.kept, `the list after the call ${info}`).toEqual({ ids: ["f1", "f2", "g1", "g2"], at: [0, 1, 4, 5], top: "f1", bottom: "g1", stale: false });
		expect(r.build, `a build ${info}`).toEqual(r.kept);
	});

	it("one call deletes one member's anchor and anchors another again, the measured lines ending inside the group: the list drops the one and keeps the other, as a build makes it", () => {
		const path = "retake-repair-mixed.md";
		const p = onePane(path, [strokeAt("f", 10, 1 * LH + 5), strokeAt("m1", 40, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5), strokeAt("m4", 70, 11 * LH + 5)], ["m1", "m2", "m4"]);
		// Lines 9 and 11 each take a second row; the lines from 11 down are drawn and read but not measured, so the measured
		// lines end at line 10, inside the group.
		const top = (n: number) => (n - 1) * LH + (n >= 10 ? LH : 0) + (n >= 12 ? LH : 0);
		const w = wrapAbove(path, p, false, top, (x) => { x.drawn(11, 20); x.drawn(1, 10); x.drawn(1, 10, true, true); });
		const kept = shape(inner(p.a).anchored);
		const info = JSON.stringify({ premise: p.premise, w, lines: p.src.map((s) => anchorLine(s)), kept });
		expect([w.windowOpen, w.cleared, w.lost, w.groupDy, anchorLine(p.src[1]), anchorLine(p.src[2])], `premise: no window open, m4 deleted, m1 anchored again on line 9, m2 kept on line 10 ${info}`).toEqual([false, 1, ["m4"], LH, 9, 10]);
		expect(kept, `the list after the call ${info}`).toEqual({ ids: ["f", "m1", "m2"], at: [0, 1, 2], top: "f", bottom: "m2", stale: false });
		expect(rebuilt(p.a, p.src), `a build ${info}`).toEqual(kept);
	});

	it("after the call, one more Enter above the group and a fold: every stroke's anchor is as on a pane whose list was built again, and nothing throws", () => {
		const out: Record<string, unknown> = {};
		for (const kind of ["delete", "again"] as const) {
			const make = (tag: string) => onePane(`retake-repair-after-${kind}-${tag}.md`, [strokeAt("f", 10, 1 * LH + 5), strokeAt("m1", 40, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5), strokeAt("m3", 70, 9 * LH + 5), strokeAt("h", 10, 14 * LH + 5)], ["m1", "m2", "m3"]);
			const kept = make("kept"), built = make("built"), thrown: string[] = [];
			const both = (name: string, f: (x: ReturnType<typeof onePane>, tag: string) => unknown) => {
				for (const [x, tag] of [[kept, "kept"], [built, "built"]] as const) {
					try { f(x, tag); } catch (err) { thrown.push(`${tag} ${name}: ${(err as Error).message}`); }
				}
			};
			both("move", (x, tag) => (kind === "delete" ? enter(`retake-repair-after-${kind}-${tag}.md`, x, 5) : wrapAbove(`retake-repair-after-${kind}-${tag}.md`, x)));
			const repaired = inner(kept.a).anchored?.stale === false;
			rebuilt(built.a, built.src);
			// After the wrap, line 9's second row is line 10's once the Enter at line 3 is in.
			both("enter above", (x, tag) => enter(`retake-repair-after-${kind}-${tag}.md`, x, 3, kind === "delete" ? topOf(1, 0) : topOf(11, LH)));
			both("fold", (x) => x.a.fold());
			const anchors = (x: ReturnType<typeof onePane>) => Object.fromEntries(x.src.map((s) => [s.id, s.lineAnchor ? { ...s.lineAnchor } : null]));
			out[kind] = { repaired, thrown, kept: anchors(kept), built: anchors(built) };
		}
		const info = JSON.stringify(out);
		for (const kind of ["delete", "again"]) {
			const r = out[kind] as { thrown: string[]; kept: unknown; built: unknown };
			expect(r.thrown, `${kind}: nothing throws ${info}`).toEqual([]);
			expect(r.kept, `${kind}: every anchor as on the pane built again ${info}`).toEqual(r.built);
		}
	});

	it("another pane anchored ink after this pane's list was built, then this pane's Enter deletes member anchors: this pane's next read holds that ink, as a build does", () => {
		const path = "retake-repair-other-pane.md";
		const before = lines(20);
		const st = { layout: layoutOf(before), focus: "a" };
		const a = new LineAnchors(() => st.layout, () => st.focus === "a"), b = new LineAnchors(() => st.layout, () => st.focus === "b");
		const strokes = [strokeAt("f", 10, 1 * LH + 5), strokeAt("m1", 10, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5), strokeAt("m3", 70, 9 * LH + 5), strokeAt("o", 10, 2 * LH + 5)];
		const src: InkStroke[] = [];
		const open = (x: LineAnchors) => { x.setSignature(SIG); x.tracks(path, src); x.drawn(1, 20); x.drawn(1, 20, true, true); };
		open(a);
		for (const s of strokes) {
			src.push(s);
			if (s.id !== "o") a.anchorNew(path, s);
		}
		open(b);
		a.layoutChanged(path, src, "measure");
		b.layoutChanged(path, src, "measure");
		const line10 = before.line(10), m1 = strokes[1]!;
		const rec: AttachmentRecord = {
			v: 1, id: ID, strokeIds: ["m1", "m2", "m3"], target: targetAt(before.toString(), line10.from, line10.to, "paragraph"),
			ref: { x: 0, y: 9 * LH }, layout: { width: SIG.width, font: SIG.fontPx }, probe: { id: "m1", x: m1.points[0]!.x, y: m1.points[0]!.y },
		};
		a.follow.setList([rec]);
		b.follow.setList([rec]);
		a.follow.measure(view(before));
		b.follow.measure(view(before));
		const took = b.anchorMeasured(path, src);
		const aBefore = { list: shape(inner(a).anchored)?.ids ?? null, stale: inner(a).anchored?.stale ?? null };
		const changes = ChangeSet.of({ from: before.line(5).to, insert: "\n" }, before.length);
		const after = changes.apply(before);
		st.layout = layoutOf(after);
		a.docChanged(path, src, before, changes, after);
		const aAtEnter = { list: shape(inner(a).anchored)?.ids ?? null, stale: inner(a).anchored?.stale ?? null };
		const snap = a.follow.snapshot();
		const mapped = a.follow.docChanged(changes, view(after).blockTop, 1);
		const edit = a.follow.takeEdited();
		a.shareAttachments(mapped);
		const cleared = edit ? a.retakeMembers(path, src, snap) : 0;
		const next = inner(a).anchoredIn(src).map((s) => s.id), build = rebuilt(a, src)?.ids ?? null;
		const info = JSON.stringify({ took, o: anchorLine(strokes[4]), writes: [a.writesAttachments, b.writesAttachments], aBefore, aAtEnter, edit, cleared, next, build });
		expect([took, anchorLine(strokes[4]), a.writesAttachments, edit, cleared], `premise: B's old-ink pass anchored o on line 3, A writes, A's Enter moved the group and deleted every member anchor ${info}`).toEqual([1, 3, true, true, 3]);
		expect(next, `A's next read ${info}`).toEqual(build);
	});
});
