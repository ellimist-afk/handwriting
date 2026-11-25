/**
 * The re-take of a moved group's members (LineAnchor.ts retakeMembers) at an Enter reads no anchor of a member it carried
 * before whose line no measure reads now (past the measured lines, or a rebase window open): the re-take could only carry
 * it again, the same anchor, so it is not read. A carried member the measured lines now reach is still read, and taken
 * again from where it is shown when its anchor no longer says that. A carried anchor reaches a read-only view and the
 * next save as an anchor read at every Enter would, also when its line's box read is due or its line is above the body.
 *
 * Bare surfaces over one store list and one layout, called as updateLineAnchors, followDocChanged and the measure loop's
 * followMoved call them; no DOM. The setup is LineAnchorCarriedRead.test.ts's. One cell runs the overlay's own
 * lineAnchorsDrawn on a bare overlay, its pass timer recorded, not run.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { bodyFromOf, LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, settleLineAnchors, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";
import { embedInkDy, type LineSpans } from "./EmbedInkLines";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LH = 40;
/** How much taller than its guess the editor measures the typed line. */
const DELTA = 7;

/** Every line LH tall, plus `extra` px on every line from `from` down. */
const topOf = (from: number, extra: number) => (n: number) => (n - 1) * LH + (n >= from ? extra : 0);

/** The editor's layout (editorLineLayout) over `doc`: its first body line under a frontmatter, 1 for a note without one. */
const layoutOf = (doc: Text, top = topOf(1, 0)): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: top, pxPerWorld: 1, bodyFrom: bodyFromOf(doc) });

const view = (doc: Text, top = topOf(1, 0)) => ({
	inView: () => true,
	refAt: (pos: number) => ({ x: 0, y: top(doc.lineAt(pos).number) }),
	blockTop: (pos: number) => top(doc.lineAt(pos).number),
});

function spansOf(doc: Text, top = topOf(1, 0)): LineSpans {
	const text = Array.from({ length: doc.lines }, (_, i) => doc.line(i + 1).text);
	const blocks = text.map((_, i) => ({ lineStart: i, lineEnd: i, box: () => ({ top: top(i + 1), height: LH }), lineHeight: () => LH }));
	return { lines: text, blocks, skip: [] };
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

const lines = (n: number) => Text.of(Array.from({ length: n }, (_, i) => `line ${i + 1} words`));

/** A group: its id, the line its paragraph target is on, and its members' ids. */
type Group = { id: string; line: number; members: string[] };
type Pane = { doc: Text; st: { layout: LineLayout }; a: LineAnchors; src: InkStroke[]; list: readonly AttachmentData[]; groups: Group[] };

/** The read of one stroke's anchor: every read of an anchor goes through it. */
type Inner = { honoured: (s: InkStroke, ...rest: unknown[]) => number | null };
const inner = (a: LineAnchors) => a as unknown as Inner;
const byId = (p: Pane, id: string) => p.src.find((s) => s.id === id)!;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Runs `act`, counting the reads of the anchors of the strokes `ids` names. */
function countingReads<T>(p: Pane, ids: readonly string[], act: () => T): { out: T; reads: number } {
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

/** The groups' records, each on its line's paragraph, its probe its first member. */
function records(doc: Text, strokes: InkStroke[], groups: Group[]): AttachmentRecord[] {
	return groups.map((g) => {
		const line = doc.line(g.line), m0 = strokes.find((s) => s.id === g.members[0])!;
		return {
			v: 1, id: g.id, strokeIds: g.members, target: targetAt(doc.toString(), line.from, line.to, "paragraph"),
			ref: { x: 0, y: (g.line - 1) * LH }, layout: { width: SIG.width, font: SIG.fontPx }, probe: { id: m0.id, x: m0.points[0]!.x, y: m0.points[0]!.y },
		};
	});
}

/**
 * One pane on an `n`-line note, every line drawn and measured. Each stroke is anchored as committed; then the groups'
 * records are listed and read where the text puts them. `onScreen`: whether a measure can read the pane's lines. `opt.doc`:
 * the note's text in place of `lines(n)`; `opt.boxes`: line box tops (world units, by line) a measure read before the strokes
 * were committed.
 */
function onePane(path: string, n: number, strokes: InkStroke[], groups: Group[], onScreen: () => boolean = () => true, opt: { doc?: Text; boxes?: ReadonlyMap<number, number> } = {}): Pane {
	const doc = opt.doc ?? lines(n);
	const st = { layout: layoutOf(doc) };
	const a = new LineAnchors(() => st.layout, () => true, onScreen);
	const src: InkStroke[] = [];
	a.setSignature(SIG);
	a.tracks(path, src);
	a.drawn(1, n);
	a.drawn(1, n, true, true);
	if (opt.boxes) a.boxesRead(path, src, opt.boxes, opt.boxes.size);
	for (const s of strokes) {
		src.push(s);
		a.anchorNew(path, s);
	}
	a.layoutChanged(path, src, "measure");
	const list = records(doc, strokes, groups);
	a.follow.setList(list);
	measureAll(a, view(doc));
	return { doc, st, a, src, list, groups };
}

/** The follow's measure, run again while it leaves groups in the view to read (its read cap), as the measure loop asks again. */
function measureAll(a: LineAnchors, v: ReturnType<typeof view>): void {
	for (let i = 0; i < 100 && a.follow.measure(v).more; i++);
}

/** `groups` groups of `per` members, group k on line 4 + 2k, each member drawn on its group's line; a `lines`-line note. */
function manyGroups(path: string, groups: number, per: number, n: number): Pane {
	const gs: Group[] = [], strokes: InkStroke[] = [];
	for (let k = 0; k < groups; k++) {
		const line = 4 + 2 * k, members: string[] = [];
		for (let j = 0; j < per; j++) {
			const id = `g${k}m${j}`;
			members.push(id);
			strokes.push(strokeAt(id, 10 + 16 * j, (line - 1) * LH + 5));
		}
		gs.push({ id: `g${k}`, line, members });
	}
	return onePane(path, n, strokes, gs);
}

const memberIds = (p: Pane) => p.groups.flatMap((g) => g.members);

type Typed = {
	/** Every member's anchor read once just before the re-take, as a re-take that reads every member would. */
	readFirst?: boolean;
	/** What is typed: an Enter at the end of the line by default; `atStart` puts it at the line's start. */
	insert?: string;
	atStart?: boolean;
	/** The lines the change drew go on record through this, in place of the surface's own drawn. */
	drawn?: () => void;
};

/**
 * `insert` typed on line `at` (an Enter at its end by default), as the editor takes it: the anchors' change (the rebase
 * window opens), the changed lines drawn, then followDocChanged's retakeMembers with the follow's snapshot, its reads of
 * the members' anchors counted.
 */
function enter(path: string, p: Pane, at: number, opt: Typed = {}) {
	const { doc, st, a, src } = p;
	const insert = opt.insert ?? "\n";
	const pos = opt.atStart ? doc.line(at).from : doc.line(at).to;
	const changes = ChangeSet.of({ from: pos, insert }, doc.length);
	const after = changes.apply(doc);
	p.doc = after;
	st.layout = layoutOf(after);
	const lazy0 = a.changePaths.lazy;
	a.docChanged(path, src, doc, changes, after);
	const logged = a.changePaths.lazy - lazy0;
	if (opt.drawn) opt.drawn();
	else a.drawn(at, at + (insert.includes("\n") ? 1 : 0), false);
	const snap = a.follow.snapshot();
	const mapped = a.follow.docChanged(changes, view(after).blockTop, 1);
	const edit = a.follow.takeEdited();
	a.shareAttachments(mapped);
	p.list = mapped;
	const windowOpen = a.windowOpen;
	if (opt.readFirst) {
		const i = inner(a);
		for (const id of memberIds(p)) {
			const s = byId(p, id);
			if (s.lineAnchor) i.honoured.call(a, s, s.lineAnchor, st.layout);
		}
	}
	const { out: carried, reads } = countingReads(p, memberIds(p), () => (edit ? a.retakeMembers(path, src, snap) : 0));
	const dys = p.groups.map((g) => a.follow.groupOffset(g.id)?.dy ?? null);
	return { edit, logged, windowOpen, carried, reads, dys };
}

/**
 * The measure loop after the Enter on line `at`: its measure read the changed lines as guessed (marked as the measure loop
 * marks them), the layout update, then followMoved's retakeMembers on the follow's measure, its member reads counted.
 */
function measureAfter(path: string, p: Pane, at: number) {
	const { a, src } = p;
	a.drawn(at, at + 1, false, true);
	a.layoutChanged(path, src, "measure");
	const snap = a.follow.snapshot();
	a.follow.layoutChanged();
	measureAll(a, view(p.doc));
	const { out: carried, reads } = countingReads(p, memberIds(p), () => a.retakeMembers(path, src, snap));
	return { windowOpen: a.windowOpen, carried, reads };
}

/** Each member's anchor as a save writes it: the fields a page holds. */
const saved = (p: Pane, ids: readonly string[]) => ids.map((id) => {
	const a = byId(p, id).lineAnchor;
	return a ? { id, line: a.line, top: r6(a.top), y: r6(a.y), key: a.key, above: a.above ?? null, width: a.width, fontPx: a.fontPx } : { id, absent: true };
});

/** Why a member draws where it does in a read-only view: no anchor, a guard failing, or the dy it draws at. */
const readOnly = (p: Pane, ids: readonly string[], top = topOf(1, 0)) => {
	const spans = spansOf(p.doc, top);
	return ids.map((id) => {
		const s = byId(p, id);
		if (!s.lineAnchor) return { id, why: "absent" };
		const dy = embedInkDy(s, spans, 1, SIG);
		return { id, why: dy === 0 ? "a guard fails" : "drawn", dy: r6(dy) };
	});
};

/**
 * The count cell: five Enters at the end of the top line above 20 groups of 50 members, the measure loop between. `twice`:
 * the store list holds one member's id twice (a copy with no anchor at its end), so the re-take walks the whole list, not
 * the moved groups' ids.
 */
function countRun(path: string, twice: boolean) {
	const p = manyGroups(path, 20, 50, 50);
	const ids = memberIds(p);
	if (twice) p.src.push({ ...strokeAt("g0m0", 10, 3 * LH + 5) });
	const enters: ReturnType<typeof enter>[] = [], measures: ReturnType<typeof measureAfter>[] = [];
	for (let k = 1; k <= 5; k++) {
		enters.push(enter(path, p, 1));
		measures.push(measureAfter(path, p, 1));
	}
	const held = p.src.filter((s) => s.id === "g0m0").length;
	const info = JSON.stringify({ members: ids.length, held, enters: enters.map(({ dys, ...e }) => ({ ...e, dys: [...new Set(dys)] })), measures });
	expect([ids.length, held], `premise: 1,000 members, the list holding g0m0 ${twice ? "twice" : "once"} ${info}`).toEqual([1000, twice ? 2 : 1]);
	expect(enters.map((e) => [e.edit, e.windowOpen, e.dys.every((d) => d === e.dys[0]) ? e.dys[0] : e.dys]), `premise: each Enter moved every group one more line with the window open ${info}`).toEqual([1, 2, 3, 4, 5].map((k) => [true, true, k * LH]));
	expect([enters[0]!.carried, measures.map((m) => [m.windowOpen, m.reads])], `premise: the first Enter carried every member; each measure after an Enter closed the window and read no member's anchor ${info}`).toEqual([1000, [1, 2, 3, 4, 5].map(() => [false, 0])]);
	expect(enters.map((e) => e.reads), `the re-take's reads of the members' anchors, Enter by Enter ${info}`).toEqual([1000, 0, 0, 0, 0]);
}

/** Two panes on one note, A with focus and B, over one store list and one layout; A commits the strokes, B opens after. */
function twoPanes(path: string, n: number, strokes: InkStroke[], groups: Group[]) {
	const doc = lines(n);
	const st = { layout: layoutOf(doc), focus: "a" };
	const a = new LineAnchors(() => st.layout, () => st.focus === "a"), b = new LineAnchors(() => st.layout, () => st.focus === "b");
	const src: InkStroke[] = [];
	const open = (x: LineAnchors) => {
		x.setSignature(SIG);
		x.tracks(path, src);
		x.drawn(1, n);
		x.drawn(1, n, true, true);
	};
	open(a);
	for (const s of strokes) {
		src.push(s);
		a.anchorNew(path, s);
	}
	open(b);
	a.layoutChanged(path, src, "measure");
	b.layoutChanged(path, src, "measure");
	const list = records(doc, strokes, groups);
	a.follow.setList(list);
	b.follow.setList(list);
	measureAll(a, view(doc));
	measureAll(b, view(doc));
	const pa: Pane = { doc, st, a, src, list, groups };
	return { pa, st, b };
}

/**
 * A run on two panes: A types two Enters on line 5, B hearing each; then B, given the focus, types a word at the start of
 * line 2, A hearing it; then settleLineAnchors, as a save runs it. `readFirst`: A reads every member at each Enter.
 */
function twoPaneRun(path: string, readFirst: boolean) {
	const ids = ["m1", "m2", "m3"];
	const { pa, st, b } = twoPanes(path, 20, [strokeAt("m1", 10, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5), strokeAt("m3", 70, 9 * LH + 5)], [{ id: "two-group", line: 10, members: ids }]);
	const was = saved(pa, ids);
	const enters: unknown[] = [];
	for (let k = 0; k < 2; k++) {
		const before = pa.doc;
		const e = enter(path, pa, 5, { readFirst });
		const changes = ChangeSet.of({ from: before.line(5).to, insert: "\n" }, before.length);
		b.docChanged(path, pa.src, before, changes, pa.doc);
		enters.push(e);
	}
	st.focus = "b";
	const before = pa.doc, changes = ChangeSet.of({ from: before.line(2).from, insert: "more " }, before.length), after = changes.apply(before);
	pa.doc = after;
	st.layout = layoutOf(after);
	const aLog = pa.a.pendingShifts;
	b.docChanged(path, pa.src, before, changes, after);
	const folded = { aLog, aLogAfter: pa.a.pendingShifts, bLog: b.pendingShifts };
	pa.a.docChanged(path, pa.src, before, changes, after);
	settleLineAnchors();
	return { ids, was, enters, folded, now: saved(pa, ids), v: readOnly(pa, ids) };
}

/** A bare overlay running its own lineAnchorsDrawn over pane `p`: each arm of the old-ink pass recorded, its timer not run. */
function passRig(path: string, p: Pane) {
	let arms = 0;
	const rig = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(rig, {
		lineAnchorState: p.a,
		view: { get viewport() { return { from: 0, to: p.doc.length }; } },
		lineAnchorPassWaits: false,
		lineAnchorPassTimer: 0,
		lineDrawnAt: 0,
		armLineAnchorPass(this: InkOverlayPlugin) {
			this.lineAnchorPassWaits = false;
			this.lineAnchorPassTimer = 1;
			arms++;
		},
	});
	return {
		get arms() { return arms; },
		get armed() { return rig.lineAnchorPassTimer > 0; },
		/** The update that drew lines: a document change's changed lines, or the measure loop's whole viewport. */
		drawn: (measure: boolean, only?: { from: number; to: number }) => rig.lineAnchorsDrawn(path, p.doc, p.src, measure, only ? { ...only } : undefined),
		/** followMoved's arm, on the re-take's answer. */
		moved: (answer: number) => { if (answer > 0 && !(rig.lineAnchorPassTimer > 0)) rig.armLineAnchorPass(path, 0); },
		/** The pass timer fires: the pass runs anchorMeasured, as armLineAnchorPass's callback runs it once the editor is quiet. */
		fire: () => {
			rig.lineAnchorPassTimer = 0;
			return p.a.anchorMeasured(path, p.src);
		},
	};
}

describe("the re-take at an Enter reads no member it carried before whose line no measure reads", () => {
	it("count: five Enters at the end of the top line above 20 groups of 50 members, the measure loop between: the first Enter reads and carries all 1,000; each later Enter reads no member's anchor", () => {
		countRun("retake-carried-count.md", false);
	});

	it("count, the list holding an id twice (the re-take walks the whole list): the first Enter reads and carries all 1,000; each later Enter reads no member's anchor", () => {
		countRun("retake-carried-count-twice.md", true);
	});

	it("reach: a carried member the measured lines now reach, its anchor no longer what its group shows, is read and taken again from where it is shown; a carried member whose anchor says where it is shown keeps it", () => {
		const path = "retake-carried-reach.md";
		// m1 on line 3, above the Enter on line 5, so its line does not move with its group; m2 on the group's line 10.
		const ids = ["m1", "m2"];
		const p = onePane(path, 20, [strokeAt("m1", 10, 2 * LH + 5), strokeAt("m2", 40, 9 * LH + 5)], [{ id: "reach-group", line: 10, members: ids }]);
		const was = saved(p, ids);
		const e = enter(path, p, 5);
		const carried = ids.map((id) => byId(p, id).lineAnchor);
		// The editor measures the typed line DELTA taller than its guess: every line from 7 down sits DELTA lower; the measure
		// closes the window and the follow reads the group DELTA lower too.
		const real = topOf(7, DELTA);
		p.st.layout = layoutOf(p.doc, real);
		p.a.drawn(5, 6, false, true);
		p.a.layoutChanged(path, p.src, "measure");
		const windowOpen = p.a.windowOpen, measured = p.a.measuredThrough;
		const snap = p.a.follow.snapshot();
		p.a.follow.layoutChanged();
		measureAll(p.a, view(p.doc, real));
		const gdy = p.a.follow.groupOffset("reach-group")?.dy ?? null;
		const r = countingReads(p, ["m1"], () => p.a.retakeMembers(path, p.src, snap));
		const r2 = { kept: ids.map((id, i) => byId(p, id).lineAnchor === carried[i]) };
		p.a.fold();
		const now = saved(p, ids), view2 = readOnly(p, ids, real);
		const info = JSON.stringify({ was, e, windowOpen, measured, gdy, carriedNow: r.out, m1Reads: r.reads, ...r2, now, view2 });
		expect([e.edit, e.windowOpen, e.carried, e.dys], `premise: the Enter moved the group LH with the window open and carried both members ${info}`).toEqual([true, true, 2, [LH]]);
		expect([windowOpen, measured >= 11, gdy], `premise: the measure closed the window, the measured lines reach both members, the group moved LH + DELTA ${info}`).toEqual([false, true, LH + DELTA]);
		expect([r.reads, r2.kept], `m1's anchor is read and replaced; m2 keeps its carried anchor ${info}`).toEqual([1, [false, true]]);
		expect(now.map((x) => ("line" in x ? { id: x.id, line: x.line, top: x.top } : x)), `each member's anchor at the save: m1 on line 4 under where it is shown, its top that line's less its group's dy; m2 one line down, its top as taken ${info}`).toEqual([
			{ id: "m1", line: 4, top: 3 * LH - (LH + DELTA) },
			{ id: "m2", line: 11, top: 9 * LH },
		]);
		expect(view2, `where a read-only view draws each member: at its group's dy ${info}`).toEqual(ids.map((id) => ({ id, why: "drawn", dy: LH + DELTA })));
	});

	it("read-only view and save: after five Enters, each carried member's anchor at the save is the one a re-take that read every member at every Enter leaves, and a read-only view draws it at its group's dy", () => {
		const path = "retake-carried-save.md";
		const p = manyGroups(path, 3, 4, 20), q = manyGroups(path + ".twin", 3, 4, 20);
		const ids = memberIds(p);
		const was = saved(p, ids);
		const runs: unknown[] = [];
		for (let k = 1; k <= 5; k++) {
			runs.push({ p: enter(path, p, 1), q: enter(path + ".twin", q, 1, { readFirst: true }) });
			measureAfter(path, p, 1);
			measureAfter(path + ".twin", q, 1);
		}
		p.a.fold();
		q.a.fold();
		const now = saved(p, ids), twin = saved(q, ids), v = readOnly(p, ids);
		const info = JSON.stringify({ runs, was, now, twin, v });
		expect(was.every((x) => "line" in x), `premise: every member anchored before the Enters ${info}`).toBe(true);
		expect(now, `each member's anchor at the save, against the pane that read every member at every Enter ${info}`).toEqual(twin);
		expect(now.map((x) => ("line" in x ? { id: x.id, line: x.line, top: x.top } : x)), `each member's anchor at the save: five lines down, its top as taken ${info}`).toEqual(was.map((x) => ("line" in x ? { id: x.id, line: x.line! + 5, top: x.top } : x)));
		expect(v, `where a read-only view draws each member ${info}`).toEqual(ids.map((id) => ({ id, why: "drawn", dy: 5 * LH })));
	});

	it("save, a word typed on the carried members' own line, then two Enters above with no measure between: each member's anchor at the save is the one a re-take that read every member at every Enter leaves", () => {
		const path = "retake-carried-own-line.md";
		const ids = ["m1", "m2"];
		const make = (at: string) => onePane(at, 20, [strokeAt("m1", 10, 9 * LH + 5), strokeAt("m2", 40, 9 * LH + 5)], [{ id: "own-group", line: 10, members: ids }]);
		const p = make(path), q = make(path + ".twin");
		// The twin reads every member at each Enter, as a re-take that reads every member does; the word moves no group, so no
		// re-take runs at it and neither pane reads a member there.
		const run = (x: Pane, at: string, readFirst: boolean) => [
			enter(at, x, 5, { readFirst }),
			enter(at, x, 11, { insert: "more ", atStart: true }),
			enter(at, x, 5, { readFirst }),
			enter(at, x, 5, { readFirst }),
		];
		const was = saved(p, ids);
		const rp = run(p, path, false), rq = run(q, path + ".twin", true);
		p.a.fold();
		q.a.fold();
		const now = saved(p, ids), twin = saved(q, ids);
		const info = JSON.stringify({ was, rp: rp.map(({ dys, ...e }) => ({ ...e, dys })), rq: rq.map(({ dys, ...e }) => ({ ...e, dys })), now, twin, v: readOnly(p, ids) });
		expect(rp.map((e) => [e.windowOpen, e.dys[0]]), `premise: each change with the window open; the word on the group's own line moved it nowhere ${info}`).toEqual([[true, LH], [true, LH], [true, 2 * LH], [true, 3 * LH]]);
		expect([rp[0]!.carried, rp[1]!.logged], `premise: the first Enter carried both members; the word went on the log ${info}`).toEqual([2, 1]);
		expect(now, `each member's anchor at the save, against the pane that read every member at every Enter ${info}`).toEqual(twin);
	});

	it("the old-ink pass: after an Enter that reads no carried member (its re-take answers 0), the lines the measure draws arm the pass, and the pass takes each member from a measure", () => {
		const path = "retake-carried-pass.md";
		const ids = ["m1", "m2"], screen = { on: true };
		const p = onePane(path, 20, [strokeAt("m1", 10, 9 * LH + 5), strokeAt("m2", 40, 9 * LH + 5)], [{ id: "pass-group", line: 10, members: ids }], () => screen.on);
		const rig = passRig(path, p);
		// The Enter carries both members, and followMoved arms the pass on that answer.
		const e1 = enter(path, p, 5, { drawn: () => rig.drawn(false, p.a.changedLines) });
		rig.moved(e1.carried);
		const armed1 = rig.armed;
		// The pass runs while no measure can read the pane's lines: the window stays open, nothing is taken, no timer is left.
		screen.on = false;
		const took1 = rig.fire();
		screen.on = true;
		const open1 = p.a.windowOpen;
		const carried = ids.map((id) => byId(p, id).lineAnchor);
		// A second Enter: its re-take answers how many it carried, and only that answer arms the pass in followMoved.
		const arms0 = rig.arms;
		const e2 = enter(path, p, 5, { drawn: () => rig.drawn(false, p.a.changedLines) });
		rig.moved(e2.carried);
		const carried2 = ids.map((id) => byId(p, id).lineAnchor);
		// The measure loop: its update draws the whole viewport and marks the lines; the follow's measure; followMoved.
		rig.drawn(true);
		p.a.layoutChanged(path, p.src, "measure");
		const snap = p.a.follow.snapshot();
		p.a.follow.layoutChanged();
		measureAll(p.a, view(p.doc));
		rig.moved(p.a.retakeMembers(path, p.src, snap));
		const open2 = p.a.windowOpen, armed2 = rig.armed, arms2 = rig.arms - arms0;
		const took2 = armed2 ? rig.fire() : null;
		const replaced = ids.map((id, i) => byId(p, id).lineAnchor !== carried2[i]);
		const info = JSON.stringify({ e1, armed1, took1, open1, carried, e2, carried2, open2, armed2, arms2, took2, replaced, now: saved(p, ids) });
		expect([e1.windowOpen, e1.carried, armed1, took1, open1], `premise: the Enter carried both with the window open and armed the pass; the pass ran with the window open and took none ${info}`).toEqual([true, 2, true, 0, true]);
		expect([e2.windowOpen, open2], `premise: the second Enter opened the window, the measure closed it ${info}`).toEqual([true, false]);
		expect([armed2, took2, replaced], `the pass is armed after the measure and takes each member from it ${info}`).toEqual([true, 2, [true, true]]);
	});

	it("two panes: A types two Enters (the second reads no carried member), then B types and a save settles: each member's anchor is the one a re-take that read every member at every Enter leaves", () => {
		const r = twoPaneRun("retake-carried-two-panes.md", false), t = twoPaneRun("retake-carried-two-panes-twin.md", true);
		const info = JSON.stringify({ r, t });
		expect([r.folded.aLog > 0, r.folded.aLogAfter, r.folded.bLog], `premise: A's log held entries; B's change folded it first and went on B's own ${info}`).toEqual([true, 0, 1]);
		expect(r.now, `each member's anchor at the save, against the run that read every member at every Enter ${info}`).toEqual(t.now);
		expect(r.v, `where a read-only view draws each member ${info}`).toEqual(t.v);
	});

	it("save, a carried member's line box read due: its line's box read after the Enter that carried it, then two Enters above with the box read again between: each member's anchor at the save is the one a re-take that read every member at every Enter leaves", () => {
		const path = "retake-carried-box-due.md";
		// m1 on line 3, above the Enters on line 5, so its line keeps its box through them; m2 on the group's line 10. A box read
		// on line 1 before the strokes are committed: each is anchored under the height map on a line with no box read, so its
		// line's box read is due.
		const ids = ["m1", "m2"], box = 2 * LH + 3;
		const make = (at: string) => onePane(at, 20, [strokeAt("m1", 10, 2 * LH + 5), strokeAt("m2", 40, 9 * LH + 5)], [{ id: "box-group", line: 10, members: ids }], () => true, { boxes: new Map([[1, 0]]) });
		const p = make(path), q = make(path + ".twin");
		// Line 3's box reads 3 px under the height map's top, twice, an Enter between: a read of m1 after the first holds its
		// anchor under the map; the second agrees with the first and settles the line; a read after that takes the anchor under
		// the box. No measure runs between the changes.
		const boxRead = (x: Pane, at: string) => x.a.boxesRead(at, x.src, new Map([[3, box]]), 1);
		const run = (x: Pane, at: string, readFirst: boolean) => {
			const enters = [enter(at, x, 5, { readFirst })];
			const boxes = [boxRead(x, at)];
			enters.push(enter(at, x, 5, { readFirst }));
			boxes.push(boxRead(x, at));
			enters.push(enter(at, x, 5, { readFirst }));
			return { enters, boxes };
		};
		const was = saved(p, ids);
		const rp = run(p, path, false), rq = run(q, path + ".twin", true);
		p.a.fold();
		q.a.fold();
		const now = saved(p, ids), twin = saved(q, ids);
		const info = JSON.stringify({ was, rp, rq, now, twin, v: readOnly(p, ids) });
		expect(rp.enters.map((e) => [e.windowOpen, e.dys[0]]), `premise: each Enter moved the group one more line with the window open ${info}`).toEqual([[true, LH], [true, 2 * LH], [true, 3 * LH]]);
		expect(rp.enters[0]!.carried, `premise: the first Enter carried both members ${info}`).toBe(2);
		expect([was[0]!, twin[0]!].map((x) => ("line" in x ? { line: x.line, top: x.top } : x)), `premise: m1 taken on line 3 under the map; at the save the twin's m1 is under line 3's box, 3 px lower ${info}`).toEqual([{ line: 3, top: 2 * LH }, { line: 3, top: box }]);
		expect(now, `each member's anchor at the save, against the pane that read every member at every Enter ${info}`).toEqual(twin);
	});

	it("save, a carried member above the body: a frontmatter closed above its line after the Enter that carried it: each member's anchor at the save is the one a re-take that read every member at every Enter leaves", () => {
		const path = "retake-carried-above-body.md";
		// Line 1 is a fence with no fence to close it, so the body starts at line 1. m1 on line 2, m2 on the group's line 10.
		const ids = ["m1", "m2"];
		const doc = Text.of(Array.from({ length: 20 }, (_, i) => (i === 0 ? "---" : `line ${i + 1} words`)));
		const make = (at: string) => onePane(at, 20, [strokeAt("m1", 10, LH + 5), strokeAt("m2", 40, 9 * LH + 5)], [{ id: "body-group", line: 10, members: ids }], () => true, { doc });
		const p = make(path), q = make(path + ".twin");
		// An Enter on line 5 carries both; a fence typed as a new line 3 closes the frontmatter: the body starts at line 4, m1's
		// line 2 is above it, and every line from 3 down moves one line on, the group with them. No measure runs between.
		const run = (x: Pane, at: string, readFirst: boolean) => [
			{ ...enter(at, x, 5, { readFirst }), from: bodyFromOf(x.doc) },
			{ ...enter(at, x, 3, { insert: "---\n", atStart: true, readFirst }), from: bodyFromOf(x.doc) },
		];
		const was = saved(p, ids);
		const rp = run(p, path, false), rq = run(q, path + ".twin", true);
		p.a.fold();
		q.a.fold();
		const now = saved(p, ids), twin = saved(q, ids);
		const info = JSON.stringify({ was, rp, rq, now, twin, v: readOnly(p, ids) });
		expect(rp.map((e) => [e.windowOpen, e.dys[0], e.from]), `premise: each change moved the group one more line with the window open; the fence closed the frontmatter over lines 1 to 3 ${info}`).toEqual([[true, LH, 1], [true, 2 * LH, 4]]);
		expect(rp[0]!.carried, `premise: the first Enter carried both members ${info}`).toBe(2);
		expect([was[0]!, twin[0]!].map((x) => ("line" in x ? x.line : x)), `premise: m1 taken on line 2; at the save the twin's m1 is on the first body line ${info}`).toEqual([2, 4]);
		expect(now, `each member's anchor at the save, against the pane that read every member at every Enter ${info}`).toEqual(twin);
	});
});
