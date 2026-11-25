/**
 * The measure's update after an Enter reads no correction again when its lines measured as guessed and the first and last
 * anchored lines still read the corrections their strokes show (LineAnchor.ts layoutChanged, the probes). A carried member
 * (retakeMembers: its line no measure has read, or a rebase window open) is shown by its group, never by its anchor, so it
 * is no probe: a note whose top anchored line is a carried member takes the same early return as one with no group, and
 * each carried member's memo takes its group's correction, as a read again writes it, so a member freed in the epoch shows
 * where it was shown. A member the list holds as carried that is shown by its own anchor by the update (freed from its
 * group, the list kept) sends the update back to reading every correction again.
 *
 * Bare surfaces over one store list and one layout, called as followDocChanged and the measure loop call them; no DOM.
 * The setup is LineAnchorCarriedRead.test.ts's.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LH = 40;
const ID = "probe-group";
const MEMBERS = ["m1", "m2"];

const topOf = (n: number) => (n - 1) * LH;
const layoutOf = (doc: Text): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: topOf, pxPerWorld: 1 });
const view = (doc: Text) => ({
	inView: () => true,
	refAt: (pos: number) => ({ x: 0, y: topOf(doc.lineAt(pos).number) }),
	blockTop: (pos: number) => topOf(doc.lineAt(pos).number),
});

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

const lines = (n: number) => Text.of(Array.from({ length: n }, (_, i) => `line ${i + 1} words`));

type Pane = { doc: Text; st: { layout: LineLayout }; a: LineAnchors; src: InkStroke[] };

/** The surface's own state the cells read, and the two reads they count. */
type Inner = {
	epoch: number; dys: Map<InkStroke, { epoch: number; dy: number }>;
	honoured: (s: InkStroke, ...rest: unknown[]) => number | null;
	readAgain: (...rest: unknown[]) => boolean;
	anchored: { list: InkStroke[]; top: InkStroke | null } | null;
};
const inner = (a: LineAnchors) => a as unknown as Inner;
const byId = (p: Pane, id: string) => p.src.find((s) => s.id === id)!;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * A 20-line note, every line drawn and measured: members m1 (line 8) and m2 (line 10) in a group on line 10, free ink f on
 * line 15; then an Enter at the end of line 5, as the editor takes it (the anchors' change opens the rebase window, the
 * changed lines drawn, followDocChanged's retakeMembers carries both members a line down).
 */
function enteredPane(path: string) {
	const doc = lines(20);
	const st = { layout: layoutOf(doc) };
	const a = new LineAnchors(() => st.layout, () => true);
	const src: InkStroke[] = [];
	a.setSignature(SIG);
	a.tracks(path, src);
	a.drawn(1, 20);
	a.drawn(1, 20, true, true);
	for (const s of [strokeAt("m1", 10, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5), strokeAt("f", 300, 14 * LH + 5)]) {
		src.push(s);
		a.anchorNew(path, s);
	}
	a.layoutChanged(path, src, "measure");
	const line = doc.line(10), m0 = src[0]!;
	const rec: AttachmentRecord = {
		v: 1, id: ID, strokeIds: MEMBERS, target: targetAt(doc.toString(), line.from, line.to, "paragraph"),
		ref: { x: 0, y: 9 * LH }, layout: { width: SIG.width, font: SIG.fontPx }, probe: { id: m0.id, x: m0.points[0]!.x, y: m0.points[0]!.y },
	};
	a.follow.setList([rec]);
	a.follow.measure(view(doc));
	const p: Pane = { doc, st, a, src };
	const wasLines = MEMBERS.map((id) => byId(p, id).lineAnchor!.line);
	const pos = doc.line(5).to;
	const changes = ChangeSet.of({ from: pos, insert: "\n" }, doc.length);
	const after = changes.apply(doc);
	p.doc = after;
	st.layout = layoutOf(after);
	a.docChanged(path, src, doc, changes, after);
	a.drawn(5, 6, false);
	const snap = a.follow.snapshot();
	const mapped = a.follow.docChanged(changes, view(after).blockTop, 1);
	const edit = a.follow.takeEdited();
	a.shareAttachments(mapped);
	const carried = edit ? a.retakeMembers(path, src, snap) : 0;
	const kept = MEMBERS.map((id, i) => byId(p, id).lineAnchor?.line === wasLines[i]! + 1);
	const e = { edit, carried, kept, windowOpen: a.windowOpen, groupDy: a.follow.groupOffset(ID)?.dy ?? null, fDy: a.dyOf(byId(p, "f")) };
	expect([e.edit, e.carried, e.kept, e.windowOpen, e.groupDy, e.fDy], `premise: the Enter moved the group LH with the window open and carried both members one line down; f shown at 0 ${JSON.stringify(e)}`).toEqual([true, 2, [true, true], true, LH, 0]);
	return { p, e };
}

/**
 * The measure loop's update after the Enter: its measure read the typed lines as guessed (marked as the measure loop marks
 * them), then layoutChanged "measure". Counts the reads again, the reads of a member's anchor and the epochs.
 */
function measureUpdate(path: string, p: Pane) {
	p.a.drawn(5, 6, false, true);
	const i = inner(p.a), realH = i.honoured, realR = i.readAgain, watched = new Set(MEMBERS.map((id) => byId(p, id)));
	let memberReads = 0, readsAgain = 0;
	i.honoured = function (this: unknown, s: InkStroke, ...rest: unknown[]) {
		if (watched.has(s)) memberReads++;
		return realH.call(this, s, ...rest);
	};
	i.readAgain = function (this: unknown, ...rest: unknown[]) {
		readsAgain++;
		return realR.call(this, ...rest);
	};
	const g0 = p.a.generation, e0 = i.epoch;
	let out: boolean;
	try {
		out = p.a.layoutChanged(path, p.src, "measure");
	} finally {
		delete (i as Partial<Inner>).honoured;
		delete (i as Partial<Inner>).readAgain;
	}
	const memos = MEMBERS.map((id) => {
		const m = i.dys.get(byId(p, id));
		return { current: m?.epoch === i.epoch, dy: m ? r6(m.dy) : null };
	});
	return { out, gen: p.a.generation - g0, epochs: i.epoch - e0, readsAgain, memberReads, windowOpen: p.a.windowOpen, memos, fDy: p.a.dyOf(byId(p, "f")) };
}

describe("a carried member is no probe for the measure's update", () => {
	it("an Enter above a group whose carried member is the top anchored line, its lines measured as guessed: the update reads no correction again, reads no member's anchor, answers false; each member's memo current at its group's dy", () => {
		const path = "probe-skip.md";
		const { p, e } = enteredPane(path);
		const top = inner(p.a).anchored?.top?.id ?? null;
		const r = measureUpdate(path, p);
		const info = JSON.stringify({ e, top, ...r });
		expect([r.windowOpen, r.out, r.gen, r.fDy], `premise: the update closed the window; nothing shown moved, f still at 0 ${info}`).toEqual([false, false, 0, 0]);
		expect([r.readsAgain, r.epochs, r.memberReads], `the update reads no correction again (no new epoch) and no member's anchor ${info}`).toEqual([0, 0, 0]);
		expect(r.memos, `each member's memo is current and holds its group's dy ${info}`).toEqual([{ current: true, dy: LH }, { current: true, dy: LH }]);
	});

	it("a member freed right after that update shows where it was shown, its group's dy, with no generation move", () => {
		const path = "probe-freed.md";
		const { p, e } = enteredPane(path);
		const r = measureUpdate(path, p);
		const g0 = p.a.generation, e0 = inner(p.a).epoch;
		// The group's record goes from the list with no step that settles its members: each one is free ink as it is stored.
		p.a.follow.setList([]);
		const freed = MEMBERS.map((id) => p.a.dyOf(byId(p, id)));
		const info = JSON.stringify({ e, ...r, freed, gen: p.a.generation - g0, epochs: inner(p.a).epoch - e0 });
		expect([r.windowOpen, r.out], `premise: the update closed the window and answered false ${info}`).toEqual([false, false]);
		expect([freed, p.a.generation - g0], `each freed member shows at its group's dy, where it was shown; no generation move ${info}`).toEqual([[LH, LH], 0]);
	});

	it("guard: members freed from their group before the update, the list kept: the update reads every correction again", () => {
		const path = "probe-freed-before.md";
		const { p, e } = enteredPane(path);
		const listBefore = inner(p.a).anchored?.list ?? null;
		p.a.follow.setList([]);
		const r = measureUpdate(path, p);
		const listAfter = inner(p.a).anchored?.list ?? null;
		const info = JSON.stringify({ e, ...r, sameList: listBefore === listAfter });
		expect([listBefore !== null, listBefore === listAfter, r.windowOpen], `premise: the update kept the anchored list and closed the window ${info}`).toEqual([true, true, false]);
		expect([r.readsAgain, r.epochs], `a member the list holds as carried, now free ink: every correction is read again ${info}`).toEqual([1, 1]);
	});
});
