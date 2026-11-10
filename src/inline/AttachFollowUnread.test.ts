/**
 * An export of an attached group this pane has not read yet, after lines typed above it: the group is drawn at the
 * correction its record kept, moved by the text changes above it since this pane last measured. The editor still never
 * paints a pending group. Each cell names the defect that must turn it red.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { AttachFollow, keptShownStrokes, type FollowMeasure } from "./AttachFollow";
import { targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const DOC = "Intro line here.\nSecond line.\nThird line.\nThe word benzene sits in this line.\nLast line of the note.\n";
/** Editor px per line, and editor px per world unit: a line is 20 world units. */
const LH = 40, PX = 2, LINE = LH / PX;
const lineOf = (doc: string, pos: number) => doc.slice(0, pos).split("\n").length - 1;
const blockTopIn = (doc: string) => (pos: number) => lineOf(doc, pos) * LH;
const record = (doc = DOC, word = "benzene", id = "att-1", strokeIds = ["s1", "s2"], shown?: { dx: number; dy: number }): AttachmentRecord => {
	const from = doc.indexOf(word);
	const r: AttachmentRecord = { v: 1, id, strokeIds, target: targetAt(doc, from, from + word.length, "range"), ref: { x: 36, y: 60 }, layout: { width: 672, font: 19 }, probe: { id: strokeIds[0]!, x: 40, y: 64 } };
	return shown ? { ...r, shown } : r;
};
const insert = (doc: string, pos: number, text: string) => ChangeSet.of([{ from: pos, insert: text }], doc.length);
const apply = (doc: string, cs: ChangeSet) => cs.apply(Text.of(doc.split("\n"))).toString();

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}
const S1 = strokeAt("s1", 40, 64), S2 = strokeAt("s2", 60, 66), FREE = strokeAt("free", 10, 10);

/** A measure over `doc`: nothing in view unless told; reference points at the target's line top. */
function measureOver(doc: string, inView: (pos: number) => boolean = () => false): FollowMeasure {
	return { inView, refAt: (pos) => ({ x: 36, y: blockTopIn(doc)(pos) / PX }), blockTop: blockTopIn(doc) };
}
const rec = (list: readonly AttachmentData[], id = "att-1") => list.find((a) => a.id === id) as AttachmentRecord;
const y0 = (s: InkStroke) => s.points[0]!.y;
const x0 = (s: InkStroke) => s.points[0]!.x;

/** A pane that opened the note and measured with the group out of view: the group is pending (unread). */
function opened(shown = { dx: 0, dy: 40 }, list?: AttachmentData[]) {
	const f = new AttachFollow();
	f.setList(list ?? [record(DOC, "benzene", "att-1", ["s1", "s2"], shown)]);
	f.measure(measureOver(DOC));
	return f;
}

describe("export of an unread attached group after lines typed above it", () => {
	it("three lines typed above an unread group: the export draws it three lines lower than its kept correction", () => {
		// Defect: the export takes the record's kept correction from before the reopen and misses the lines typed since.
		const f = opened();
		const cs = insert(DOC, 0, "a\nb\nc\n");
		const mapped = f.docChanged(cs, blockTopIn(apply(DOC, cs)), PX);
		expect(y0(f.exported(S1))).toBeCloseTo(y0(S1) + 40 + 3 * LINE, 9);
		expect(x0(f.exported(S1)), "dx untouched").toBeCloseTo(x0(S1), 9);
		expect(rec(mapped).shown, "the record holds the absolute correction").toEqual({ dx: 0, dy: 40 + 3 * LINE });
		const noPane = keptShownStrokes([S1, S2, FREE], mapped);
		expect(y0(noPane[1]!), "the export with no pane reads the same record").toBeCloseTo(y0(S2) + 40 + 3 * LINE, 9);
		expect(f.takeEdited(), "the stamp is a real edit: the page is written").toBe(true);
	});

	it("the editor still never paints the pending group: no correction, members left out", () => {
		// Defect: the unread move leaks into groupOffset, and a pending group is painted at a guessed place.
		const f = opened();
		const cs = insert(DOC, 0, "a\nb\nc\n");
		f.docChanged(cs, blockTopIn(apply(DOC, cs)), PX);
		expect(f.groupOffset("att-1")).toBeNull();
		expect(f.offsetOf("s1")).toBeNull();
		expect(f.shown(S1)).toBeNull();
	});

	it("a read group moves once: by its read, not again by an unread move", () => {
		// Defect: the unread move runs for read groups too, and their record keeps a correction moved twice.
		const f = opened();
		f.measure(measureOver(DOC, () => true));
		expect(f.groupOffset("att-1")).toEqual({ dx: 0, dy: 0 });
		const cs = insert(DOC, 0, "a\nb\nc\n");
		const mapped = f.docChanged(cs, blockTopIn(apply(DOC, cs)), PX);
		expect(f.groupOffset("att-1")).toEqual({ dx: 0, dy: 3 * LINE });
		expect(y0(f.exported(S1))).toBeCloseTo(y0(S1) + 3 * LINE, 9);
		expect(rec(mapped).shown).toEqual({ dx: 0, dy: 3 * LINE });
	});

	it("held, collapsed and free ink are unchanged by a change above", () => {
		// Defect: the unread move reaches a group whose target needs reattachment or was deleted, or free ink.
		const held = record(DOC, "benzene", "att-1", ["s1"], { dx: 0, dy: 40 });
		const from = DOC.indexOf("Last"), gone: AttachmentRecord = { ...record(DOC, "Last", "att-2", ["s2"], { dx: 0, dy: 40 }), target: { ...targetAt(DOC, from, from + 4, "range"), to: from } };
		const f = new AttachFollow();
		f.setList([held, gone], new Map([["att-1", "needs-reattachment" as const]]));
		f.measure(measureOver(DOC));
		const cs = insert(DOC, 0, "a\nb\nc\n");
		f.docChanged(cs, blockTopIn(apply(DOC, cs)), PX);
		expect(y0(f.exported(S1)), "held").toBeCloseTo(y0(S1) + 40, 9);
		expect(y0(f.exported(S2)), "collapsed").toBeCloseTo(y0(S2) + 40, 9);
		expect(f.exported(FREE), "free ink is the store's own stroke").toBe(FREE);
	});

	it("the first read after a stamp lands at the measured place, and the next change moves it once", () => {
		// Defect: the unread entry outlives the read, so the read group is moved by both its read and the entry.
		const f = opened();
		const cs = insert(DOC, 0, "a\nb\nc\n"), doc1 = apply(DOC, cs);
		f.docChanged(cs, blockTopIn(doc1), PX);
		f.measure(measureOver(doc1, () => true));
		const read = f.groupOffset("att-1")!;
		expect(read).toEqual({ dx: 0, dy: 3 * LINE });
		expect(y0(f.exported(S1))).toBeCloseTo(y0(S1) + read.dy, 9);
		const cs2 = insert(doc1, 0, "d\n");
		const mapped = f.docChanged(cs2, blockTopIn(apply(doc1, cs2)), PX);
		expect(f.groupOffset("att-1")).toEqual({ dx: 0, dy: 4 * LINE });
		expect(rec(mapped).shown).toEqual({ dx: 0, dy: 4 * LINE });
	});

	it("two panes, one change, one move: the pane that reads the writer's list takes its correction, never adds to it", () => {
		// Defect: the reading pane adds its own delta to the stamped record, or keeps its own stale entry over it.
		const a = opened(), b = opened();
		const cs = insert(DOC, 0, "a\nb\nc\n"), doc1 = apply(DOC, cs);
		const l1 = a.docChanged(cs, blockTopIn(doc1), PX);
		b.setList(l1);
		expect(y0(b.exported(S1))).toBeCloseTo(y0(S1) + 40 + 3 * LINE, 9);
		// The reading pane becomes the writer for the next change: it reseeds at its own next measure first.
		b.measure(measureOver(doc1));
		const cs2 = insert(doc1, 0, "d\ne\nf\n"), doc2 = apply(doc1, cs2);
		const l2 = b.docChanged(cs2, blockTopIn(doc2), PX);
		expect(rec(l2).shown).toEqual({ dx: 0, dy: 40 + 6 * LINE });
		a.setList(l2);
		expect(y0(a.exported(S1))).toBeCloseTo(y0(S1) + 40 + 6 * LINE, 9);
		expect(y0(b.exported(S1))).toBeCloseTo(y0(S1) + 40 + 6 * LINE, 9);
	});
});

/** A measure over `doc` with every block top `shift` editor px lower: the heights a measure finds, nothing in view. */
function measureShifted(doc: string, shift: number): FollowMeasure {
	return { inView: () => false, refAt: (pos) => ({ x: 36, y: (blockTopIn(doc)(pos) + shift) / PX }), blockTop: (pos) => blockTopIn(doc)(pos) + shift };
}
/** A short edit on the second line: the line count holds and the change keeps the line's old height (CodeMirror's replace). */
const keystroke = (doc: string) => insert(doc, doc.indexOf("Second") + 6, " and more words");

describe("an unread group keeps the move the measure after a change finds", () => {
	it("a keystroke whose wrapped row the next layout finds: the export draws the group one row lower", () => {
		// Defect (blind B1): the new layout epoch reseeds the entry from the record and the block's top now, so the row the
		// keystroke added, found only by the measure after it, is never counted.
		const f = opened();
		const cs = keystroke(DOC), doc1 = apply(DOC, cs);
		f.docChanged(cs, blockTopIn(doc1), PX);
		f.layoutChanged();
		f.measure(measureShifted(doc1, LH));
		expect(y0(f.exported(S1))).toBeCloseTo(y0(S1) + 40 + LINE, 9);
		expect(x0(f.exported(S1)), "dx untouched").toBeCloseTo(x0(S1), 9);
	});

	it("CodeMirror's order, a read in the change's layout and one in the next: the row is counted once", () => {
		// The measure loop reads the follow before it sends the heightChanged update, then reads again in the new layout.
		// Defect: the first read keeps its old base (same epoch) and the reseed drops the row; or both reads count it.
		const f = opened();
		const cs = keystroke(DOC), doc1 = apply(DOC, cs);
		f.docChanged(cs, blockTopIn(doc1), PX);
		f.measure(measureShifted(doc1, LH));
		f.layoutChanged();
		f.measure(measureShifted(doc1, LH));
		expect(y0(f.exported(S1))).toBeCloseTo(y0(S1) + 40 + LINE, 9);
		expect(f.groupOffset("att-1"), "still unread: not painted").toBeNull();
	});

	it("Enter that splits a line at an estimate: the measure's correction is kept, not thrown away", () => {
		// The change moves the group by the estimate (one line); the measure finds the real move (two lines).
		// Defect: the reseed at the new epoch keeps only the estimate's move.
		const f = opened();
		const cs = insert(DOC, DOC.indexOf("\nSecond"), "\n"), doc1 = apply(DOC, cs);
		f.docChanged(cs, blockTopIn(doc1), PX);
		expect(y0(f.exported(S1)), "the estimate's move").toBeCloseTo(y0(S1) + 40 + LINE, 9);
		f.layoutChanged();
		f.measure(measureShifted(doc1, LH));
		expect(y0(f.exported(S1))).toBeCloseTo(y0(S1) + 40 + 2 * LINE, 9);
	});

	it("the next edit writes the measured move on the page", () => {
		// Defect: a move only the measure found stays in this pane, and the page (export with no pane) keeps the old one.
		const f = opened();
		const cs = keystroke(DOC), doc1 = apply(DOC, cs);
		f.docChanged(cs, blockTopIn(doc1), PX);
		f.layoutChanged();
		f.measure(measureShifted(doc1, LH));
		const cs2 = insert(doc1, 0, "z"), doc2 = apply(doc1, cs2);
		const mapped = f.docChanged(cs2, (pos) => blockTopIn(doc2)(pos) + LH, PX);
		expect(rec(mapped).shown).toEqual({ dx: 0, dy: 40 + LINE });
		expect(y0(keptShownStrokes([S1], mapped)[0]!)).toBeCloseTo(y0(S1) + 40 + LINE, 9);
	});

	it("a layout change with no edit (lines above measured on a scroll) moves no unread group", () => {
		// Defect: every new layout epoch carries the block's top change, so an estimate corrected far above moves the ink.
		const f = opened();
		f.layoutChanged();
		f.measure(measureShifted(DOC, 5 * LH));
		expect(y0(f.exported(S1))).toBeCloseTo(y0(S1) + 40, 9);
		f.layoutChanged();
		f.measure(measureShifted(DOC, 2 * LH));
		expect(y0(f.exported(S1))).toBeCloseTo(y0(S1) + 40, 9);
	});

	it("only the measures right after a change carry: a later scroll's heights move nothing", () => {
		// Defect: the change's window never closes, and a scroll long after it is counted as the change's move.
		const f = opened();
		const cs = keystroke(DOC), doc1 = apply(DOC, cs);
		f.docChanged(cs, blockTopIn(doc1), PX);
		f.measure(measureOver(doc1));
		f.layoutChanged();
		f.measure(measureOver(doc1));
		f.layoutChanged();
		f.measure(measureShifted(doc1, 3 * LH));
		expect(y0(f.exported(S1))).toBeCloseTo(y0(S1) + 40, 9);
	});

	it("another pane's new stamp on the same target: this pane's entry starts from it", () => {
		// Defect: the entry kept over a layout epoch outlives a peer's stamp and the export keeps the old correction.
		const f = opened();
		f.setList([record(DOC, "benzene", "att-1", ["s1", "s2"], { dx: 0, dy: 60 })]);
		expect(y0(f.exported(S1)), "before the next measure").toBeCloseTo(y0(S1) + 60, 9);
		f.measure(measureOver(DOC));
		expect(y0(f.exported(S1))).toBeCloseTo(y0(S1) + 60, 9);
	});

	it("a peer's stamp, then a scroll, then an edit that moves nothing: the group stays at the stamp", () => {
		// Defect: the measure keeps an entry older than the peer's stamp, with its old base; the edit then takes the stamp
		// and adds the scroll's height change since that old base as a move.
		const f = opened();
		f.setList([record(DOC, "benzene", "att-1", ["s1", "s2"], { dx: 0, dy: 60 })]);
		f.layoutChanged();
		f.measure(measureShifted(DOC, 5 * LH));
		const cs = keystroke(DOC), doc1 = apply(DOC, cs);
		const mapped = f.docChanged(cs, (pos) => blockTopIn(doc1)(pos) + 5 * LH, PX);
		expect(y0(f.exported(S1))).toBeCloseTo(y0(S1) + 60, 9);
		expect(rec(mapped).shown).toEqual({ dx: 0, dy: 60 });
	});
});

describe("the change's window closes at the first measure after it", () => {
	it("a keystroke that keeps every height, then a scroll: the scroll's heights move no unread group", () => {
		// Defect: the measure in the change's layout finds no move and leaves the window open, so the
		// next layout change (a scroll, any time later) carries the estimate fixes above the group as the edit's move.
		const f = opened();
		const cs = keystroke(DOC), doc1 = apply(DOC, cs);
		f.docChanged(cs, blockTopIn(doc1), PX);
		f.measure(measureOver(doc1));
		f.layoutChanged();
		f.measure(measureShifted(doc1, 3 * LH));
		expect(y0(f.exported(S1))).toBeCloseTo(y0(S1) + 40, 9);
	});

	it("two layout changes after a keystroke with no measure between, then a scroll: the scroll's heights move nothing", () => {
		// Defect: the window has no epoch bound, so a change whose first measure comes two layouts later (measures held)
		// carries that layout's estimate fixes above the group as the edit's move.
		const f = opened();
		const cs = keystroke(DOC), doc1 = apply(DOC, cs);
		f.docChanged(cs, blockTopIn(doc1), PX);
		f.layoutChanged();
		f.layoutChanged();
		f.measure(measureShifted(doc1, 3 * LH));
		expect(y0(f.exported(S1))).toBeCloseTo(y0(S1) + 40, 9);
	});

	it("a measure capped before it reaches an unread group: the next measure still carries the change's move", () => {
		// Defect: the window closes at the first measure even when the read cap stopped it before the unread group, so the
		// group never gets the row the keystroke added.
		const list = [
			record(DOC, "Intro", "att-a", ["a1"]),
			record(DOC, "Third", "att-b", ["b1"]),
			record(DOC, "benzene", "att-1", ["s1", "s2"], { dx: 0, dy: 40 }),
		];
		const f = opened(undefined, list);
		const cs = keystroke(DOC), doc1 = apply(DOC, cs), cut = doc1.indexOf("benzene");
		const view: FollowMeasure = { ...measureShifted(doc1, LH), inView: (pos) => pos < cut };
		f.docChanged(cs, blockTopIn(doc1), PX);
		expect(f.measure(view, 1).more, "the cap stops the first measure").toBe(true);
		f.measure(view, 1);
		expect(y0(f.exported(S1))).toBeCloseTo(y0(S1) + 40 + LINE, 9);
	});
});

describe("a capped run of reads after a change: a layout change before it ends is not the change's move", () => {
	const near = (doc: string) => { const cut = doc.indexOf("benzene"); return (pos: number) => pos < cut; };
	const shiftedNear = (doc: string, shift: number): FollowMeasure => ({ ...measureShifted(doc, shift), inView: near(doc) });
	const list3 = (first: boolean): AttachmentData[] => {
		const low = record(DOC, "benzene", "att-1", ["s1", "s2"], { dx: 0, dy: 40 });
		const a = record(DOC, "Intro", "att-a", ["a1"]), b = record(DOC, "Third", "att-b", ["b1"]);
		return first ? [low, a, b] : [a, b, low];
	};

	it("the unread group first in the list, a capped measure, then a scroll before the next: the scroll moves nothing", () => {
		// Defect: a capped measure leaves the change's window open for every unread group, also one it already carried, so
		// the scroll's height fixes in the next layout are counted as the edit's move.
		const f = opened(undefined, list3(true));
		const cs = keystroke(DOC), doc1 = apply(DOC, cs);
		f.docChanged(cs, blockTopIn(doc1), PX);
		expect(f.measure({ ...measureOver(doc1), inView: near(doc1) }, 1).more, "capped").toBe(true);
		f.layoutChanged();
		f.measure(shiftedNear(doc1, 3 * LH), 1);
		expect(y0(f.exported(S1))).toBeCloseTo(y0(S1) + 40, 9);
	});

	it("reads that stay capped over many measures (no reference point, pinch held), then a scroll: the scroll moves nothing", () => {
		// Defect: the window stays open while the run never ends, and a group the reads never reach takes the scroll's move.
		const f = opened(undefined, list3(false));
		const cs = keystroke(DOC), doc1 = apply(DOC, cs);
		f.docChanged(cs, blockTopIn(doc1), PX);
		const held: FollowMeasure = { ...measureOver(doc1), inView: near(doc1), refAt: () => null };
		for (let i = 0; i < 6; i++) expect(f.measure(held, 1).more, `capped ${i}`).toBe(true);
		f.layoutChanged();
		f.measure(shiftedNear(doc1, 3 * LH));
		expect(y0(f.exported(S1))).toBeCloseTo(y0(S1) + 40, 9);
	});

	it("a second keystroke during a capped run: the measure after it carries the row once, and closes", () => {
		// Defect: the second change's move is lost, or counted twice, or a later scroll is carried after the run ends.
		const f = opened(undefined, list3(false));
		const cs = keystroke(DOC), doc1 = apply(DOC, cs);
		f.docChanged(cs, blockTopIn(doc1), PX);
		expect(f.measure({ ...measureOver(doc1), inView: near(doc1) }, 1).more, "capped").toBe(true);
		const cs2 = insert(doc1, doc1.indexOf("more words") + 10, " x"), doc2 = apply(doc1, cs2);
		f.docChanged(cs2, blockTopIn(doc2), PX);
		expect(f.measure(shiftedNear(doc2, LH)).more, "finished").toBe(false);
		expect(y0(f.exported(S1))).toBeCloseTo(y0(S1) + 40 + LINE, 9);
		f.layoutChanged();
		f.measure(shiftedNear(doc2, 4 * LH));
		expect(y0(f.exported(S1)), "closed after the finish").toBeCloseTo(y0(S1) + 40 + LINE, 9);
	});
});
