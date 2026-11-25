/**
 * A moved group's members whose lines no measure has read (past the measured lines, or a rebase window open) keep a line
 * anchor (LineAnchor.ts retakeMembers): the anchor is carried, its line and lines-above hash moved with the text by the
 * shift log, its top as it was taken, since a line typed above moves the member's line and its group by the same height.
 * A read-only view (Reading view, an embed, Export to PDF) and the next save draw and write the member by it. The old-ink
 * pass of whichever pane measures that far takes the member again from a measure. Free ink keeps its own rule.
 *
 * Bare surfaces over one store list and one layout, called as updateLineAnchors, followDocChanged and the measure loop's
 * followMoved call them; no DOM.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";
import { embedInkDy, type LineSpans } from "./EmbedInkLines";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LH = 40;
const ID = "carry-group";

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

/** A read-only view of `doc`: one block per line at `top`, as Reading view lays the note out. */
function spansOf(doc: Text, top = topOf(1, 0)): LineSpans {
	const text = Array.from({ length: doc.lines }, (_, i) => doc.line(i + 1).text);
	const blocks = text.map((_, i) => ({ lineStart: i, lineEnd: i, box: () => ({ top: top(i + 1), height: LH }), lineHeight: () => LH }));
	return { lines: text, blocks, skip: [] };
}

type Pane = { doc: Text; st: { layout: LineLayout }; a: LineAnchors; src: InkStroke[]; list: readonly AttachmentData[] };

/**
 * One pane on an `n`-line note, its lines measured from the top through `measuredTo` (and `drawnAlso` drawn, not
 * measured). The strokes are anchored as committed; a group on line `groupLine`'s paragraph lists `members`.
 */
function onePane(path: string, n: number, measuredTo: number, strokes: InkStroke[], members: string[], groupLine: number, drawnAlso?: [number, number]): Pane {
	const doc = lines(n);
	const st = { layout: layoutOf(doc) };
	const a = new LineAnchors(() => st.layout, () => true);
	const src: InkStroke[] = [];
	a.setSignature(SIG);
	a.tracks(path, src);
	if (drawnAlso) a.drawn(drawnAlso[0], drawnAlso[1]);
	a.drawn(1, measuredTo);
	a.drawn(1, measuredTo, true, true);
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

/** `insert` typed at line `at` (its end, or its start with `atStart`), then followDocChanged's retakeMembers with the snapshot. */
function type(path: string, p: Pane, at: number, insert = "\n", top = topOf(1, 0), atStart = false) {
	const { doc, st, a, src } = p;
	const pos = atStart ? doc.line(at).from : doc.line(at).to;
	const changes = ChangeSet.of({ from: pos, insert }, doc.length);
	const after = changes.apply(doc);
	p.doc = after;
	st.layout = layoutOf(after, top);
	a.docChanged(path, src, doc, changes, after);
	const snap = a.follow.snapshot();
	const mapped = a.follow.docChanged(changes, view(after, top).blockTop, 1);
	const edit = a.follow.takeEdited();
	a.shareAttachments(mapped);
	p.list = mapped;
	const counted = edit ? a.retakeMembers(path, src, snap) : 0;
	return { edit, counted, windowOpen: a.windowOpen, groupDy: a.follow.groupOffset(ID)?.dy ?? null };
}

type AnchorRead = { id: string; line: number; top: number } | { id: string; absent: true };
const anchorsOf = (p: Pane, ids: string[]): AnchorRead[] => ids.map((id): AnchorRead => {
	const a = p.src.find((s) => s.id === id)!.lineAnchor;
	return a ? { id, line: a.line, top: a.top } : { id, absent: true };
});

/** Why a member draws where it does in a read-only view: no anchor, a guard failing, or the dy it draws at. */
const readOnly = (p: Pane, ids: string[], top = topOf(1, 0)) => {
	const spans = spansOf(p.doc, top);
	return ids.map((id) => {
		const s = p.src.find((x) => x.id === id)!;
		if (!s.lineAnchor) return { id, why: "absent" };
		const dy = embedInkDy(s, spans, 1, SIG);
		return { id, why: dy === 0 ? "a guard fails" : "drawn", dy };
	});
};

describe("a moved group's members keep a line anchor where no measure reads their lines", () => {
	it("a short note, a rebase window open: an Enter above the group: every member keeps an anchor, one line down, its top as before the Enter", () => {
		const path = "carry-window.md";
		const p = onePane(path, 20, 20, [strokeAt("m1", 10, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5), strokeAt("m3", 70, 9 * LH + 5)], ["m1", "m2", "m3"], 10);
		const ids = ["m1", "m2", "m3"], was = anchorsOf(p, ids);
		const e = type(path, p, 5);
		const now = anchorsOf(p, ids);
		const info = JSON.stringify({ e, was, now });
		expect([e.edit, e.windowOpen, e.groupDy], `premise: the Enter moved the group LH with the window open ${info}`).toEqual([true, true, LH]);
		expect(was.every((x) => "line" in x), `premise: every member anchored before the Enter ${info}`).toBe(true);
		expect(now, `each member's anchor after the Enter ${info}`).toEqual(was.map((x) => ("line" in x ? { id: x.id, line: x.line + 1, top: x.top } : x)));
	});

	it("after that Enter, each carried anchor passes every read-only guard and draws its member at its group's dy", () => {
		const path = "carry-guards.md";
		const p = onePane(path, 20, 20, [strokeAt("m1", 10, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5)], ["m1", "m2"], 10);
		const e = type(path, p, 5);
		const r = readOnly(p, ["m1", "m2"]);
		const info = JSON.stringify({ e, r, anchors: p.src.map((s) => s.lineAnchor ?? null) });
		expect(e.groupDy, `premise: the group moved LH ${info}`).toBe(LH);
		expect(r, `where a read-only view draws each member ${info}`).toEqual([{ id: "m1", why: "drawn", dy: LH }, { id: "m2", why: "drawn", dy: LH }]);
	});

	it("a long note measured only near its top: an Enter above, the typed line measured 7 px taller than its guess: at rest each member's top is its top before the Enter", () => {
		const path = "carry-guess.md";
		const DELTA = 7;
		const p = onePane(path, 40, 4, [strokeAt("m1", 10, 29 * LH + 5), strokeAt("m2", 40, 29 * LH + 9)], ["m1", "m2"], 30, [28, 32]);
		const ids = ["m1", "m2"], was = anchorsOf(p, ids), measured0 = p.a.measuredThrough;
		const e = type(path, p, 2);
		// The editor draws and measures the typed line: it is DELTA taller than the guess, so every line from 4 down sits DELTA lower.
		const real = topOf(4, DELTA);
		p.st.layout = layoutOf(p.doc, real);
		p.a.drawn(1, 5);
		p.a.drawn(1, 5, true, true);
		p.a.follow.layoutChanged();
		p.a.layoutChanged(path, p.src, "measure");
		const snap = p.a.follow.snapshot();
		p.a.follow.measure(view(p.doc, real));
		const counted2 = p.a.retakeMembers(path, p.src, snap);
		// At rest: the old-ink pass, then the log folded.
		const took = p.a.anchorMeasured(path, p.src);
		p.a.fold();
		const now = anchorsOf(p, ids);
		const info = JSON.stringify({ measured0, e, counted2, took, measured: p.a.measuredThrough, groupDy: p.a.follow.groupOffset(ID)?.dy ?? null, was, now });
		expect(measured0 < 30 && p.a.measuredThrough < 30, `premise: the measured lines stop above the group ${info}`).toBe(true);
		expect(e.edit, `premise: the Enter moved the group ${info}`).toBe(true);
		expect(now.map((x) => ("top" in x ? { id: x.id, line: x.line, top: Math.round(x.top * 1e6) / 1e6 } : x)), `each member's anchor at rest ${info}`).toEqual(was.map((x) => ("line" in x ? { id: x.id, line: x.line + 1, top: Math.round(x.top * 1e6) / 1e6 } : x)));
	});

	it("a long note: a word typed on the group's own line, its lines not measured: every member keeps an anchor", () => {
		const path = "carry-own-line.md";
		const p = onePane(path, 40, 4, [strokeAt("m1", 10, 29 * LH + 5), strokeAt("m2", 40, 29 * LH + 9)], ["m1", "m2"], 30, [28, 32]);
		const e = type(path, p, 30, "more ", topOf(1, 0), true);
		p.a.fold();
		const now = anchorsOf(p, ["m1", "m2"]);
		const info = JSON.stringify({ e, now });
		expect(now.map((x) => ("absent" in x ? `${x.id} absent` : `${x.id} kept`)), `the members after the typing ${info}`).toEqual(["m1 kept", "m2 kept"]);
	});

	it("two panes: the pane that typed carries the members; the other pane, whose measure reaches them, takes each from a measure", () => {
		const path = "carry-two-panes.md";
		const ids = ["m1", "m2", "m3"];
		const p = onePane(path, 20, 20, [strokeAt("m1", 10, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5), strokeAt("m3", 70, 9 * LH + 5)], ids, 10);
		const was = anchorsOf(p, ids);
		const e = type(path, p, 5);
		const carried = ids.map((id) => p.src.find((s) => s.id === id)!.lineAnchor ?? null);
		// The other pane opens on the note as it is now, every line drawn and measured, the group read where the text puts it.
		const b = new LineAnchors(() => p.st.layout, () => false);
		b.setSignature(SIG);
		b.tracks(path, p.src);
		b.drawn(1, p.doc.lines);
		b.drawn(1, p.doc.lines, true, true);
		b.layoutChanged(path, p.src, "measure");
		b.follow.setList(p.list);
		b.follow.measure(view(p.doc));
		const took = b.anchorMeasured(path, p.src);
		const now = anchorsOf(p, ids);
		const replaced = ids.map((id, i) => p.src.find((s) => s.id === id)!.lineAnchor !== carried[i]);
		const info = JSON.stringify({ e, was, carried, took, now, replaced, groupDyB: b.follow.groupOffset(ID)?.dy ?? null });
		expect([e.windowOpen, b.follow.groupOffset(ID)?.dy ?? null], `premise: A typed with the window open; B reads the group moved LH ${info}`).toEqual([true, LH]);
		expect([took, replaced], `B's old-ink pass takes every member from a measure ${info}`).toEqual([3, [true, true, true]]);
		expect(now, `each member's anchor, as B measured it ${info}`).toEqual(was.map((x) => ("line" in x ? { id: x.id, line: x.line + 1, top: x.top } : x)));
	});

	it("a long note: an Enter on a line no measure has read takes the eager road: each member keeps its anchor, one line down, its top as before, and Reading view draws it at its group's dy", () => {
		const path = "carry-eager-long.md";
		const ids = ["m1", "m2"];
		const p = onePane(path, 40, 4, [strokeAt("m1", 10, 29 * LH + 5), strokeAt("m2", 40, 29 * LH + 9)], ids, 30, [28, 32]);
		const was = anchorsOf(p, ids), eager0 = p.a.changePaths.eager;
		const e = type(path, p, 10);
		const eager = p.a.changePaths.eager - eager0, why = p.a.changePaths.why;
		const now = anchorsOf(p, ids), r = readOnly(p, ids);
		const info = JSON.stringify({ e, eager, why, was, now, r });
		expect([eager, e.edit, e.groupDy], `premise: the Enter took the eager road and moved the group LH ${info}`).toEqual([1, true, LH]);
		expect(now, `each member's anchor after the Enter ${info}`).toEqual(was.map((x) => ("line" in x ? { id: x.id, line: x.line + 1, top: x.top } : x)));
		expect(r, `where a read-only view draws each member ${info}`).toEqual(ids.map((id) => ({ id, why: "drawn", dy: LH })));
	});

	it("a short note, a rebase window open: a second Enter on the line the first one changed takes the eager road: each member keeps its anchor, two lines down, its top as before", () => {
		const path = "carry-eager-window.md";
		const ids = ["m1", "m2"];
		const p = onePane(path, 20, 20, [strokeAt("m1", 10, 7 * LH + 5), strokeAt("m2", 40, 9 * LH + 5)], ids, 10);
		const was = anchorsOf(p, ids);
		const e1 = type(path, p, 5);
		const eager0 = p.a.changePaths.eager;
		const e2 = type(path, p, 6, "\n", topOf(1, 0), true);
		const eager = p.a.changePaths.eager - eager0, why = p.a.changePaths.why;
		const now = anchorsOf(p, ids), r = readOnly(p, ids);
		const info = JSON.stringify({ e1, e2, eager, why, was, now, r });
		expect([eager, e1.windowOpen, e2.edit, e2.groupDy], `premise: the second Enter, the window open, took the eager road; the group moved 2 LH ${info}`).toEqual([1, true, true, 2 * LH]);
		expect(now, `each member's anchor after the second Enter ${info}`).toEqual(was.map((x) => ("line" in x ? { id: x.id, line: x.line + 2, top: x.top } : x)));
		expect(r, `where a read-only view draws each member ${info}`).toEqual(ids.map((id) => ({ id, why: "drawn", dy: 2 * LH })));
	});

	it("control: free ink below the Enter, past the measured lines, keeps its rule: one line down, its top moved by the typed height", () => {
		const path = "carry-free.md";
		const p = onePane(path, 40, 4, [strokeAt("m1", 10, 29 * LH + 5), strokeAt("f", 60, 34 * LH + 5)], ["m1"], 30, [28, 36]);
		const was = anchorsOf(p, ["f"]);
		const e = type(path, p, 2);
		p.a.fold();
		const now = anchorsOf(p, ["f"]);
		const info = JSON.stringify({ e, was, now });
		expect(now, `the free stroke's anchor after the Enter ${info}`).toEqual(was.map((x) => ("line" in x ? { id: x.id, line: x.line + 1, top: x.top + LH } : x)));
	});
});
