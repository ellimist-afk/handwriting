/**
 * One note in two editing panes, a group whose members hold line anchors, an Enter above the group typed in the pane that
 * writes. The writer moves the group and its retakeMembers deletes the members' anchors while the strokes stay in the store
 * (LineAnchor.ts retakeMembers). Each pane keeps a cached list of the anchored strokes. After the delete, the other pane's
 * next layout update with no document change must not throw, and its list must hold no stroke without an anchor. The
 * mirror: the pane that deleted is not the writer of the next change, and the writer takes that change on the eager path
 * over its own list. Two bare surfaces over one store list and one layout, called as updateLineAnchors and
 * followDocChanged call them; no DOM.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LH = 40;
const ID = "att-members-two-panes";

function layoutOf(doc: Text): LineLayout {
	return { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * LH, pxPerWorld: 1 };
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

const lines = (n: number) => Text.of(Array.from({ length: n }, (_, i) => `line ${i + 1} words`));

/** What the follow's measure reads of an editor whose every line is LH tall and drawn. */
const view = (doc: Text) => ({
	inView: () => true,
	refAt: (pos: number) => ({ x: 0, y: (doc.lineAt(pos).number - 1) * LH }),
	blockTop: (pos: number) => (doc.lineAt(pos).number - 1) * LH,
});

const listOf = (x: LineAnchors): InkStroke[] => ((x as unknown as { anchored: { list: InkStroke[] } | null }).anchored?.list ?? []);
const noAnchor = (x: LineAnchors) => listOf(x).filter((s) => !s.lineAnchor).map((s) => s.id);

/**
 * Two panes on one note, A and B; `first` has focus, opens the note first and commits the strokes there: a group on line
 * 10's paragraph with one member drawn over line 8 and two over line 10, and one free stroke on line 15. Each stroke goes
 * on the store list as it is committed, so the list grows and that pane's cached list is built again at its next read, as
 * in the product. Each pane's heights are drawn after it first names the note (naming the note forgets the heights), so a
 * typed Enter on drawn lines goes on the writer's log. The other pane opens the note with the anchors saved. Both panes
 * have read every anchor.
 */
function twoPanes(path: string, first: "a" | "b") {
	const before = lines(20);
	const st = { layout: layoutOf(before), focus: first as string };
	const a = new LineAnchors(() => st.layout, () => st.focus === "a"), b = new LineAnchors(() => st.layout, () => st.focus === "b");
	const w = first === "a" ? a : b, r = first === "a" ? b : a;
	const members = [strokeAt("m1", 10, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5), strokeAt("m3", 70, 9 * LH + 5)];
	const strokes = [...members, strokeAt("f", 10, 14 * LH + 5)];
	const src: InkStroke[] = [];
	const open = (x: LineAnchors) => {
		x.setSignature(SIG);
		x.tracks(path, src);
		x.drawn(1, 20);
		x.drawn(1, 20, true, true);
	};
	open(w);
	for (const s of strokes) {
		src.push(s);
		w.anchorNew(path, s);
	}
	open(r);
	w.layoutChanged(path, src, "measure");
	r.layoutChanged(path, src, "measure");
	const line10 = before.line(10);
	const rec: AttachmentRecord = {
		v: 1, id: ID, strokeIds: members.map((s) => s.id), target: targetAt(before.toString(), line10.from, line10.to, "paragraph"),
		ref: { x: 0, y: 9 * LH }, layout: { width: SIG.width, font: SIG.fontPx }, probe: { id: "m1", x: members[0]!.points[0]!.x, y: members[0]!.points[0]!.y },
	};
	a.follow.setList([rec]);
	b.follow.setList([rec]);
	a.follow.measure(view(before));
	b.follow.measure(view(before));
	const premise = {
		writer: [a.writesAttachments, b.writesAttachments],
		anchored: src.filter((s) => s.lineAnchor).length,
		lists: [listOf(a).length, listOf(b).length],
		groupDy: w.follow.groupOffset(ID)?.dy ?? null,
	};
	return { before, st, a, b, w, r, src, premise };
}

/**
 * An Enter at the end of line `enterAt` typed in the writer `w`: updateLineAnchors' docChanged, then followDocChanged: the
 * group moved, the list shared, followMoved's retakeMembers with the snapshot. Answers what the writer's log and change
 * path show after its docChanged, and what retakeMembers deleted.
 */
function enter(path: string, p: ReturnType<typeof twoPanes>, enterAt: number) {
	const { before, st, w, src } = p;
	const changes = ChangeSet.of({ from: before.line(enterAt).to, insert: "\n" }, before.length);
	const after = changes.apply(before);
	st.layout = layoutOf(after);
	const lazy0 = w.changePaths.lazy, eager0 = w.changePaths.eager;
	w.docChanged(path, src, before, changes, after);
	const logged = { pendingShifts: w.pendingShifts, lazy: w.changePaths.lazy - lazy0, eager: w.changePaths.eager - eager0, why: w.changePaths.why };
	const snap = w.follow.snapshot();
	const mapped = w.follow.docChanged(changes, view(after).blockTop, 1);
	const edit = w.follow.takeEdited();
	w.shareAttachments(mapped);
	const cleared = edit ? w.retakeMembers(path, src, snap) : 0;
	const lost = src.filter((s) => !s.lineAnchor).map((s) => s.id);
	return { changes, after, seen: { logged, edit, cleared, lost, groupDyAfter: w.follow.groupOffset(ID)?.dy ?? null, windowOpen: w.windowOpen } };
}

/**
 * A writes the Enter; B hears the same change, then has a layout update with no document change.
 */
function run(path: string, enterAt: number) {
	const p = twoPanes(path, "a");
	const e = enter(path, p, enterAt);
	const thrown: string[] = [];
	const step = (name: string, f: () => unknown) => { try { f(); } catch (err) { thrown.push(`${name}: ${(err as Error).message}`); } };
	step("B docChanged", () => p.b.docChanged(path, p.src, p.before, e.changes, e.after));
	step("B layoutChanged", () => p.b.layoutChanged(path, p.src, "transaction"));
	return { premise: p.premise, ...e.seen, thrown, noAnchor: noAnchor(p.b) };
}

/**
 * The mirror. B has focus and writes the Enter: B's retakeMembers deletes the member anchors it cannot re-take, and A hears
 * the change as the pane that does not write. Then the focus moves to A, which writes one character on the line the Enter
 * made: a change whose line has no height on record, so A takes it on the eager path (retakeNow) over its own cached list.
 * Then B hears that change.
 */
function mirror(path: string, enterAt: number) {
	const p = twoPanes(path, "b");
	const { a, b, st, src, before } = p;
	const e = enter(path, p, enterAt);
	const thrown: string[] = [];
	const step = (name: string, f: () => unknown) => { try { f(); } catch (err) { thrown.push(`${name}: ${(err as Error).message}`); } };
	step("A docChanged 1", () => a.docChanged(path, src, before, e.changes, e.after));
	st.focus = "a";
	const writer2 = [a.writesAttachments, b.writesAttachments];
	const changes2 = ChangeSet.of({ from: e.after.line(enterAt + 1).from, insert: "x" }, e.after.length);
	const after2 = changes2.apply(e.after);
	st.layout = layoutOf(after2);
	const eager0 = a.changePaths.eager, lazy0 = a.changePaths.lazy;
	step("A docChanged 2", () => a.docChanged(path, src, e.after, changes2, after2));
	const path2 = { eager: a.changePaths.eager - eager0, lazy: a.changePaths.lazy - lazy0 };
	step("B docChanged 2", () => b.docChanged(path, src, e.after, changes2, after2));
	return { premise: p.premise, ...e.seen, writer2, path2, thrown, noAnchorA: noAnchor(a), noAnchorB: noAnchor(b) };
}

const heldOf = (x: LineAnchors) => x as unknown as { heldSrc: readonly InkStroke[] | null; peers: LineAnchors[] | null };

/**
 * Two store lists. Both panes build on the first; then the store list is a new array holding the same strokes, and B reads
 * on it, so B is listed under the new array and A, the writer, stays under the older one. A takes an Enter above the group
 * on the older array; its retakeMembers is handed the new array and deletes member anchors there. Then B's next layout
 * update on the new array.
 */
function olderArray(path: string, enterAt: number) {
	const p = twoPanes(path, "a");
	const { before, st, a, b, src } = p;
	const src1: InkStroke[] = src.slice();
	b.layoutChanged(path, src1, "measure");
	const held = {
		aUnderOlder: heldOf(a).heldSrc === src, aPeersHoldB: !!heldOf(a).peers?.includes(b),
		bUnderNew: heldOf(b).heldSrc === src1, bPeersHoldA: !!heldOf(b).peers?.includes(a), bList: listOf(b).length,
	};
	const changes = ChangeSet.of({ from: before.line(enterAt).to, insert: "\n" }, before.length);
	const after = changes.apply(before);
	st.layout = layoutOf(after);
	a.docChanged(path, src, before, changes, after);
	const snap = a.follow.snapshot();
	const mapped = a.follow.docChanged(changes, view(after).blockTop, 1);
	const edit = a.follow.takeEdited();
	a.shareAttachments(mapped);
	const cleared = edit ? a.retakeMembers(path, src1, snap) : 0;
	const thrown: string[] = [];
	try { b.layoutChanged(path, src1, "transaction"); } catch (err) { thrown.push(`B layoutChanged: ${(err as Error).message}`); }
	return { premise: p.premise, held, edit, cleared, thrown, noAnchor: noAnchor(b) };
}

const ON_LOG = { pendingShifts: 1, lazy: 1, eager: 0 };
const logged = (r: { logged: { pendingShifts: number; lazy: number; eager: number } }) => ({ pendingShifts: r.logged.pendingShifts, lazy: r.logged.lazy, eager: r.logged.eager });

describe("a group whose members hold anchors, in two panes on one note", () => {
	for (const at of [9, 5]) {
		it(`an Enter at the end of line ${at}, above the group's words, in the writing pane: the other pane's next layout update does not throw, and its list holds no stroke without an anchor`, () => {
			const r = run(`attach-members-two-panes-${at}.md`, at);
			const info = JSON.stringify(r);
			expect(r.premise, `premise: A writes, every stroke anchored, both lists hold them, the group read ${info}`).toEqual({ writer: [true, false], anchored: 4, lists: [4, 4], groupDy: 0 });
			expect(logged(r), `premise: the Enter is on A's log ${info}`).toEqual(ON_LOG);
			expect([r.edit, r.cleared > 0], `premise: the Enter moved the group in A and A's retakeMembers deleted member anchors ${info}`).toEqual([true, true]);
			expect({ thrown: r.thrown, noAnchor: r.noAnchor }, `B after the delete ${info}`).toEqual({ thrown: [], noAnchor: [] });
		});
	}

	it("control: an Enter below the group moves it not, deletes no anchor, and B reads on", () => {
		const r = run("attach-members-two-panes-control.md", 15);
		const info = JSON.stringify(r);
		expect(r.premise, `premise ${info}`).toEqual({ writer: [true, false], anchored: 4, lists: [4, 4], groupDy: 0 });
		expect(logged(r), `premise: the Enter is on A's log ${info}`).toEqual(ON_LOG);
		expect([r.cleared, r.lost], `premise: no anchor deleted ${info}`).toEqual([0, []]);
		expect({ thrown: r.thrown, noAnchor: r.noAnchor }, `B ${info}`).toEqual({ thrown: [], noAnchor: [] });
	});

	it("the mirror: the pane that deleted the member anchors is not the writer of the next change, and the writer takes that change on the eager path: nothing throws, and no list holds a stroke without an anchor", () => {
		const r = mirror("attach-members-two-panes-mirror.md", 9);
		const info = JSON.stringify(r);
		expect(r.premise, `premise: B writes change 1, every stroke anchored, both lists hold them, the group read ${info}`).toEqual({ writer: [false, true], anchored: 4, lists: [4, 4], groupDy: 0 });
		expect(logged(r), `premise: change 1 is on B's log ${info}`).toEqual(ON_LOG);
		expect([r.edit, r.cleared > 0], `premise: the Enter moved the group in B and B's retakeMembers deleted member anchors ${info}`).toEqual([true, true]);
		expect([r.writer2, r.path2], `premise: A writes change 2 and takes it on the eager path ${info}`).toEqual([[true, false], { eager: 1, lazy: 0 }]);
		expect({ thrown: r.thrown, noAnchorA: r.noAnchorA, noAnchorB: r.noAnchorB }, `after the delete ${info}`).toEqual({ thrown: [], noAnchorA: [], noAnchorB: [] });
	});

	it("the mirror's control: an Enter below the group in B deletes no anchor, and A's eager change reads on", () => {
		const r = mirror("attach-members-two-panes-mirror-control.md", 15);
		const info = JSON.stringify(r);
		expect(r.premise, `premise ${info}`).toEqual({ writer: [false, true], anchored: 4, lists: [4, 4], groupDy: 0 });
		expect(logged(r), `premise: change 1 is on B's log ${info}`).toEqual(ON_LOG);
		expect([r.cleared, r.lost], `premise: no anchor deleted ${info}`).toEqual([0, []]);
		expect([r.writer2, r.path2], `premise: A writes change 2 on the eager path ${info}`).toEqual([[true, false], { eager: 1, lazy: 0 }]);
		expect({ thrown: r.thrown, noAnchorA: r.noAnchorA, noAnchorB: r.noAnchorB }, `after ${info}`).toEqual({ thrown: [], noAnchorA: [], noAnchorB: [] });
	});

	it("the deleting pane listed under an older store list, the other pane under the list retakeMembers is handed: the other pane's next layout update does not throw, and its list holds no stroke without an anchor", () => {
		const r = olderArray("attach-members-two-panes-older-array.md", 9);
		const info = JSON.stringify(r);
		expect(r.premise, `premise: A writes, every stroke anchored, both lists hold them, the group read ${info}`).toEqual({ writer: [true, false], anchored: 4, lists: [4, 4], groupDy: 0 });
		expect(r.held, `premise: A under the older list without B, B under the new list without A, B's list holds the strokes ${info}`).toEqual({ aUnderOlder: true, aPeersHoldB: false, bUnderNew: true, bPeersHoldA: false, bList: 4 });
		expect([r.edit, r.cleared > 0], `premise: the Enter moved the group in A and A's retakeMembers on the new list deleted member anchors ${info}`).toEqual([true, true]);
		expect({ thrown: r.thrown, noAnchor: r.noAnchor }, `B after the delete ${info}`).toEqual({ thrown: [], noAnchor: [] });
	});
});
