/**
 * A member that a moved group carried (LineAnchor.ts retakeMembers: its line no measure has read, or a rebase window
 * open) keeps its anchor in the anchored list. The editor never shows a member by its own anchor (dyOf answers its group's
 * dy), so a layout read does not read that anchor and asks no repaint for it, whichever caller reads (the window's measure,
 * a measure-loop or transaction layout update, a line box read, the view moving with the window open, the old-ink pass):
 * the member's memo takes the correction it is shown at, so the corrected set stays whole for the epoch and a member freed
 * in it shows where it was shown. Free ink read in the same pass keeps its rule: a shown correction that changes still
 * answers true and moves `generation`.
 *
 * Bare surfaces over one store list and one layout, called as updateLineAnchors, followDocChanged, the measure loop and
 * the old-ink pass call them; no DOM. The setup is LineAnchorMemberCarry.test.ts's.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LH = 40;
const ID = "carry-group";
/** How much taller than its guess the editor measures the typed line. */
const DELTA = 7;
const MEMBERS = ["m1", "m2"];

/** Every line LH tall, plus `extra` px on every line from `from` down. */
const topOf = (from: number, extra: number) => (n: number) => (n - 1) * LH + (n >= from ? extra : 0);

const layoutOf = (doc: Text, top = topOf(1, 0)): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: top, pxPerWorld: 1 });

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

type Pane = { doc: Text; st: { layout: LineLayout }; a: LineAnchors; src: InkStroke[]; list: readonly AttachmentData[] };

/**
 * The surface's own state the cells read: the epoch, each stroke's correction memo, the corrected set, the epoch the set
 * is whole for, and the read of one stroke's anchor (honoured: every read of an anchor goes through it).
 */
type Inner = {
	epoch: number; wholeAt: number; dys: Map<InkStroke, { epoch: number; dy: number }>; corrected: Set<InkStroke>;
	honoured: (s: InkStroke, ...rest: unknown[]) => number | null;
};
const inner = (a: LineAnchors) => a as unknown as Inner;

/** Runs `act`, counting the reads of the anchors of the strokes `ids` names. */
function countingReads<T>(p: Pane, ids: string[], act: () => T): { out: T; reads: number } {
	const i = inner(p.a), real = i.honoured, watched = new Set(ids.map((id) => byId(p, id)));
	let reads = 0;
	i.honoured = function (this: unknown, s: InkStroke, ...rest: unknown[]) {
		if (watched.has(s)) reads++;
		return real.call(this, s, ...rest);
	};
	try {
		return { out: act(), reads };
	} finally {
		delete (i as Partial<Inner>).honoured;
	}
}

/**
 * One pane on an `n`-line note, every line drawn and measured. The strokes are anchored as committed; a group on line
 * `groupLine`'s paragraph lists `members`.
 */
function onePane(path: string, n: number, strokes: InkStroke[], members: string[], groupLine: number): Pane {
	const doc = lines(n);
	const st = { layout: layoutOf(doc) };
	const a = new LineAnchors(() => st.layout, () => true);
	const src: InkStroke[] = [];
	a.setSignature(SIG);
	a.tracks(path, src);
	a.drawn(1, n);
	a.drawn(1, n, true, true);
	for (const s of strokes) {
		src.push(s);
		a.anchorNew(path, s);
	}
	a.layoutChanged(path, src, "measure");
	const line = doc.line(groupLine), m0 = strokes.find((s) => s.id === members[0])!;
	const rec: AttachmentRecord = {
		v: 1, id: ID, strokeIds: members, target: targetAt(doc.toString(), line.from, line.to, "paragraph"),
		ref: { x: 0, y: (groupLine - 1) * LH }, layout: { width: SIG.width, font: SIG.fontPx }, probe: { id: m0.id, x: m0.points[0]!.x, y: m0.points[0]!.y },
	};
	a.follow.setList([rec]);
	a.follow.measure(view(doc));
	return { doc, st, a, src, list: [rec] };
}

/**
 * An Enter at the end of line `at`, as the editor takes it: the anchors' change (the rebase window opens), the changed
 * lines drawn, then followDocChanged's retakeMembers with the follow's snapshot.
 */
function enter(path: string, p: Pane, at: number) {
	const { doc, st, a, src } = p;
	const pos = doc.line(at).to;
	const changes = ChangeSet.of({ from: pos, insert: "\n" }, doc.length);
	const after = changes.apply(doc);
	p.doc = after;
	st.layout = layoutOf(after);
	a.docChanged(path, src, doc, changes, after);
	a.drawn(at, at + 1, false);
	const snap = a.follow.snapshot();
	const mapped = a.follow.docChanged(changes, view(after).blockTop, 1);
	const edit = a.follow.takeEdited();
	a.shareAttachments(mapped);
	p.list = mapped;
	const carried = edit ? a.retakeMembers(path, src, snap) : 0;
	return { edit, carried, windowOpen: a.windowOpen, groupDy: a.follow.groupOffset(ID)?.dy ?? null };
}

/** The editor measures the typed line DELTA taller than its guess: every line below it sits DELTA lower. */
function measuredTaller(p: Pane, typedLine: number): void {
	p.st.layout = layoutOf(p.doc, topOf(typedLine + 1, DELTA));
}

const byId = (p: Pane, id: string) => p.src.find((s) => s.id === id)!;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Each stroke's memo: whether it was read in the surface's epoch, and the correction it holds. */
const memos = (p: Pane, ids: string[]) => {
	const i = inner(p.a);
	return ids.map((id) => {
		const m = i.dys.get(byId(p, id));
		return { current: m?.epoch === i.epoch, dy: m ? r6(m.dy) : null };
	});
};

/** What each stroke's own anchor reads against the layout now (its line's top less the anchor's top), read after the call. */
const anchorReads = (p: Pane, ids: string[]) => ids.map((id) => {
	const a = byId(p, id).lineAnchor;
	return a ? r6(p.st.layout.lineTop(a.line) / p.st.layout.pxPerWorld - a.top) : null;
});

/** A short note, every line measured: members m1 (line 8) and m2 (line 10) in a group on line 10, an Enter on line 5. */
function carriedPane(path: string, free?: InkStroke) {
	const strokes = [strokeAt("m1", 10, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5)];
	if (free) strokes.push(free);
	const p = onePane(path, 20, strokes, MEMBERS, 10);
	const wasLines = MEMBERS.map((id) => byId(p, id).lineAnchor!.line);
	const e = enter(path, p, 5);
	const kept = MEMBERS.map((id, i) => byId(p, id).lineAnchor?.line === wasLines[i]! + 1);
	return { p, e, kept, memo0: memos(p, MEMBERS) };
}

/**
 * The premise every cell shares: the Enter moved the group LH with the window open and carried both members, one line
 * down, each memo still holding the 0 it was shown at; after the call one read ran and each carried anchor reads off 0,
 * the change that asked the repaint.
 */
function carriedPremise(c: ReturnType<typeof carriedPane>, reads: number, epochs: number, info: string): void {
	expect([c.e.edit, c.e.windowOpen, c.e.groupDy, c.e.carried, c.kept, c.memo0.map((x) => x.dy)], `premise: the Enter moved the group LH with the window open and carried both members, one line down, each memo at 0 ${info}`).toEqual([true, true, LH, 2, [true, true], [0, 0]]);
	expect([epochs, reads > 0], `premise: the call ran ${reads} read(s) and each carried anchor reads off 0 ${info}`).toEqual([reads, true]);
}

/**
 * One caller's cell: the call, then what it answered, generation's move, how many times it read a member's anchor, what
 * each anchor reads, each member's memo and whether the corrected set holds it.
 */
function callOn(path: string, act: (p: Pane) => boolean | number, before: (p: Pane) => void = () => {}) {
	const c = carriedPane(path);
	const { p } = c;
	before(p);
	const g0 = p.a.generation, e0 = inner(p.a).epoch;
	const { out, reads: memberReads } = countingReads(p, MEMBERS, () => act(p));
	const m = memos(p, MEMBERS), reads = anchorReads(p, MEMBERS);
	const nonzero = reads.every((r) => r !== null && r !== 0);
	const i = inner(p.a);
	const inSet = MEMBERS.map((id) => i.corrected.has(byId(p, id)));
	const res = { out, gen: p.a.generation - g0, epochs: i.epoch - e0, windowOpen: p.a.windowOpen, memberReads, m, inSet, reads, whole: i.wholeAt === i.epoch, dyOf: MEMBERS.map((id) => p.a.dyOf(byId(p, id))) };
	const info = JSON.stringify({ e: c.e, memo0: c.memo0, ...res });
	return { c, p, res, nonzero, info };
}

describe("a carried member is shown by its group: a read of its anchor moves nothing on this surface", () => {
	it("the measure's write after the Enter (closeWindow, lineWindowMeasured's): answers false, no generation move, reads no member's anchor; each member's memo holds the dy it is shown at, the set whole", () => {
		const { c, res, nonzero, info } = callOn("carried-close.md", (p) => p.a.closeWindow("carried-close.md", p.src), (p) => measuredTaller(p, 6));
		carriedPremise(c, 1, res.epochs, info);
		expect([nonzero, res.reads.every((r) => r !== LH), res.windowOpen], `premise: each carried anchor reads off 0 and off its group's dy, the window closed ${info}`).toEqual([true, true, false]);
		expect([res.out, res.gen], `the measure's write: no shown correction moved ${info}`).toEqual([false, 0]);
		expect(res.memberReads, `the measure's write reads no carried member's anchor ${info}`).toBe(0);
		expect([res.m, res.inSet, res.whole], `each member's memo is current and holds its group's dy, the corrected set holds each; the set is whole for the epoch ${info}`).toEqual([[{ current: true, dy: LH }, { current: true, dy: LH }], [true, true], true]);
		expect(res.dyOf, `the editor shows each member at its group's dy ${info}`).toEqual([LH, LH]);
	});

	it("a member freed in the epoch of the measure's write shows where it was shown, its group's dy, with no generation move", () => {
		const path = "carried-freed.md";
		const { c, p, res, info } = callOn(path, (p) => p.a.closeWindow(path, p.src), (p) => measuredTaller(p, 6));
		const g0 = p.a.generation, e0 = inner(p.a).epoch;
		// The group's record goes from the list with no step that settles its members: each one is free ink as it is stored.
		p.a.follow.setList([]);
		const freed = MEMBERS.map((id) => p.a.dyOf(byId(p, id)));
		const more = JSON.stringify({ freed, gen: p.a.generation - g0, epochs: inner(p.a).epoch - e0, m: memos(p, MEMBERS) });
		carriedPremise(c, 1, res.epochs, info);
		expect([res.reads.every((r) => r !== null && r !== LH), res.out, inner(p.a).epoch - e0], `premise: each carried anchor reads off its group's dy, the write answered false, no epoch since ${info} ${more}`).toEqual([true, false, 0]);
		expect([freed, p.a.generation - g0], `each freed member shows at its group's dy, where it was shown; no generation move ${info} ${more}`).toEqual([[LH, LH], 0]);
	});

	it("a measure-loop layout update after the Enter, the window open (layoutChanged measure, updateLineAnchors'): answers false, no generation move, reads no member's anchor", () => {
		const { c, res, nonzero, info } = callOn("carried-measure.md", (p) => p.a.layoutChanged("carried-measure.md", p.src, "measure"));
		carriedPremise(c, 1, res.epochs, info);
		expect(nonzero, `premise: each carried anchor reads off 0 ${info}`).toBe(true);
		expect([res.out, res.gen], `the measure-loop update: no shown correction moved ${info}`).toEqual([false, 0]);
		expect(res.memberReads, `the measure-loop update reads no carried member's anchor ${info}`).toBe(0);
		expect(res.m, `each member's memo is current and holds its group's dy ${info}`).toEqual([{ current: true, dy: LH }, { current: true, dy: LH }]);
	});

	it("a transaction's layout update after the Enter (layoutChanged transaction, updateLineAnchors'): answers false, no generation move, reads no member's anchor", () => {
		const { c, res, nonzero, info } = callOn("carried-transaction.md", (p) => p.a.layoutChanged("carried-transaction.md", p.src, "transaction"));
		carriedPremise(c, 1, res.epochs, info);
		expect(nonzero, `premise: each carried anchor reads off 0 ${info}`).toBe(true);
		expect([res.out, res.gen], `the transaction's update: no shown correction moved ${info}`).toEqual([false, 0]);
		expect(res.memberReads, `the transaction's update reads no carried member's anchor ${info}`).toBe(0);
	});

	it("a line box read's layout update after the Enter (layoutChanged box, boxesRead's): answers false, no generation move, reads no member's anchor", () => {
		const { c, res, nonzero, info } = callOn("carried-box.md", (p) => p.a.layoutChanged("carried-box.md", p.src, "box"));
		carriedPremise(c, 1, res.epochs, info);
		expect(nonzero, `premise: each carried anchor reads off 0 ${info}`).toBe(true);
		expect([res.out, res.gen], `the box read's update: no shown correction moved ${info}`).toEqual([false, 0]);
		expect(res.memberReads, `the box read's update reads no carried member's anchor ${info}`).toBe(0);
	});

	it("the view moving in the measure loop, the window open, its typed lines read (windowViewed): answers false, no generation move, reads no member's anchor", () => {
		const { c, res, nonzero, info } = callOn("carried-viewed.md", (p) => p.a.windowViewed("carried-viewed.md", p.src), (p) => {
			measuredTaller(p, 6);
			// The measure read the lines the update before it drew: marked as the measure loop marks them.
			p.a.drawn(5, 6, false, true);
		});
		carriedPremise(c, 1, res.epochs, info);
		expect(nonzero, `premise: each carried anchor reads off 0 ${info}`).toBe(true);
		expect([res.out, res.gen], `the view's move: no shown correction moved ${info}`).toEqual([false, 0]);
		expect(res.memberReads, `the view's move reads no carried member's anchor ${info}`).toBe(0);
	});

	it("the old-ink pass after the Enter, the window still open (anchorMeasured closes it with its own read): no generation move", () => {
		const { c, res, nonzero, info } = callOn("carried-pass.md", (p) => p.a.anchorMeasured("carried-pass.md", p.src), (p) => measuredTaller(p, 6));
		carriedPremise(c, 1, res.epochs, info);
		expect(nonzero, `premise: each member's anchor reads off 0 after the pass ${info}`).toBe(true);
		expect(res.gen, `the old-ink pass: no shown correction moved ${info}`).toBe(0);
		expect(res.dyOf, `the editor shows each member at its group's dy ${info}`).toEqual([LH, LH]);
	});

	it("once the window is closed, the old-ink pass takes each carried member again from a measure: the editor shows no move, before or after", () => {
		const path = "carried-take.md";
		const c = carriedPane(path);
		const { p } = c;
		measuredTaller(p, 6);
		p.a.closeWindow(path, p.src);
		const carried = MEMBERS.map((id) => byId(p, id).lineAnchor);
		const before = MEMBERS.map((id) => p.a.dyOf(byId(p, id)));
		const g0 = p.a.generation;
		const took = p.a.anchorMeasured(path, p.src);
		const after = MEMBERS.map((id) => p.a.dyOf(byId(p, id)));
		const replaced = MEMBERS.map((id, i) => byId(p, id).lineAnchor !== carried[i]);
		const info = JSON.stringify({ e: c.e, took, replaced, gen: p.a.generation - g0, before, after, windowOpen: p.a.windowOpen });
		expect([c.e.edit, c.e.windowOpen, c.e.carried, c.kept], `premise: the Enter carried both members with the window open ${info}`).toEqual([true, true, 2, [true, true]]);
		expect([p.a.windowOpen, took, replaced], `premise: the window closed and the pass took both members from a measure ${info}`).toEqual([false, 2, [true, true]]);
		expect([before, after, p.a.generation - g0], `each member shown at its group's dy before and after, no generation move ${info}`).toEqual([[LH, LH], [LH, LH], 0]);
	});

	it("guard: free ink in the same read as the carried members, its shown correction changed by a layout update, still answers true and moves generation once", () => {
		const path = "carried-guard.md";
		// Free ink on line 15, below the Enter: the log keeps it where it is shown, so only a layout change moves its correction.
		const c = carriedPane(path, strokeAt("f", 300, 14 * LH + 5));
		const { p } = c;
		const f = byId(p, "f");
		const fMemo0 = memos(p, ["f"])[0]!;
		// A line above everything (a picture that loaded) becomes DELTA taller, with no document change.
		p.st.layout = layoutOf(p.doc, topOf(3, DELTA));
		const g0 = p.a.generation, e0 = inner(p.a).epoch;
		const out = p.a.layoutChanged(path, p.src, "transaction");
		const reads = anchorReads(p, [...MEMBERS, "f"]);
		const info = JSON.stringify({ e: c.e, memo0: c.memo0, fMemo0, out, gen: p.a.generation - g0, epochs: inner(p.a).epoch - e0, reads, dyOfF: p.a.dyOf(f), m: memos(p, [...MEMBERS, "f"]) });
		carriedPremise(c, 1, inner(p.a).epoch - e0, info);
		expect([fMemo0.dy, reads.every((r) => r !== null && r !== 0)], `premise: f was shown at 0; all three anchors now read off 0 ${info}`).toEqual([0, true]);
		expect([out, p.a.generation - g0, p.a.dyOf(f)], `free ink's shown correction moved: true, one generation move, f shown DELTA lower ${info}`).toEqual([true, 1, DELTA]);
	});
});
