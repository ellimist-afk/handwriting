/**
 * Ink attached to text, followed: the follow's cells. Nothing is mounted:
 * the editor is a fake that answers line block tops from the height map and reference points from the layout, and counts
 * the layout reads. Each cell names the defect that must turn it red.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { AttachFollow, GROUP_READS_PER_MEASURE, applyAttachOp, settledRecord, type FollowMeasure } from "./AttachFollow";
import { attachGroup, targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";

const DOC = "Intro line here.\nThe word benzene sits in this line.\nLast line of the note.\n";
/** Editor px per line, and editor px per world unit: a line is 20 world units. */
const LH = 40, PX = 2;
const lineOf = (doc: string, pos: number) => doc.slice(0, pos).split("\n").length - 1;
const blockTopIn = (doc: string) => (pos: number) => lineOf(doc, pos) * LH;
const record = (doc = DOC, word = "benzene", id = "att-1", strokeIds = ["s1", "s2"], ref = { x: 36, y: 20 }): AttachmentRecord => {
	const from = doc.indexOf(word);
	return { v: 1, id, strokeIds, target: targetAt(doc, from, from + word.length, "range"), ref, layout: { width: 672, font: 19 }, probe: { id: strokeIds[0]!, x: 40, y: 24 } };
};
const insert = (doc: string, pos: number, text: string) => ChangeSet.of([{ from: pos, insert: text }], doc.length);
const apply = (doc: string, cs: ChangeSet) => cs.apply(Text.of(doc.split("\n"))).toString();

/** A measure over `doc`: every position in view unless told, reference points from `refAt`, layout reads counted. */
function measureOver(doc: string, refAt: (pos: number) => { x: number; y: number } | null, inView: (pos: number) => boolean = () => true) {
	const view: FollowMeasure & { reads: number[] } = {
		reads: [],
		inView,
		refAt(pos) {
			this.reads.push(pos);
			return refAt(pos);
		},
		blockTop: blockTopIn(doc),
	};
	return view;
}
/** The reference point a layout of `doc` gives: the target's line top, at `x`. */
const lineRef = (doc: string, x = 36) => (pos: number) => ({ x, y: blockTopIn(doc)(pos) / PX });

describe("AttachFollow: pending, membership, reads", () => {
	it("a group with no read yet is pending: its members are not painted, never shown at their stored points", () => {
		// Defect: a pending group answers 0, and a reopen at another width paints the ink at its old place for a frame.
		const f = new AttachFollow();
		f.setList([record()]);
		expect(f.offsetOf("s1")).toBeNull();
		expect(f.offsetOf("s2")).toBeNull();
	});

	it("membership wins: a member answers its group, a stroke in no group answers undefined, an opaque record has no members", () => {
		// Defect: a member falls through to its own line anchor (undefined), so the group splits at a width change.
		const f = new AttachFollow();
		const opaque: AttachmentData = { opaque: true, id: "att-9", raw: { v: 2, id: "att-9", strokeIds: ["s7"] } };
		f.setList([record(), opaque]);
		expect(f.groupOf("s1")).toBe("att-1");
		expect(f.offsetOf("s3")).toBeUndefined();
		expect(f.groupOf("s7")).toBeUndefined();
		expect(f.offsetOf("s7")).toBeUndefined();
	});

	it("a read in the record's own layout shows the group at its stored points, float noise included", () => {
		// Defect: a read 0.004 off the stored point (the file holds two places) shifts every member and copies them all.
		const f = new AttachFollow();
		f.setList([record()]);
		const m = f.measure(measureOver(DOC, () => ({ x: 36.004, y: 19.996 })));
		expect(m).toEqual({ changed: true, more: false });
		expect(f.offsetOf("s1")).toEqual({ dx: 0, dy: 0 });
	});

	it("a target outside the view is not read through the layout", () => {
		// Defect: the measure reads every group's line, off-screen included, and pays a layout read per group.
		const f = new AttachFollow();
		f.setList([record()]);
		const view = measureOver(DOC, lineRef(DOC), () => false);
		expect(f.measure(view)).toEqual({ changed: false, more: false });
		expect(view.reads).toHaveLength(0);
		expect(f.offsetOf("s1")).toBeNull();
	});

	it(`one measure reads at most ${GROUP_READS_PER_MEASURE} groups and asks for another while groups are left`, () => {
		// Defect: no cap, twenty layout reads in one measure; or the cap drops the rest and they stay pending.
		const words = Array.from({ length: 20 }, (_, i) => `word${String(i).padStart(2, "0")}`);
		const doc = words.join("\n") + "\n";
		const f = new AttachFollow();
		f.setList(words.map((w, i) => record(doc, w, `att-${i}`, [`s${i}`], { x: 0, y: blockTopIn(doc)(doc.indexOf(w)) / PX })));
		const view = measureOver(doc, lineRef(doc, 0));
		expect(f.measure(view).more).toBe(true);
		expect(view.reads).toHaveLength(GROUP_READS_PER_MEASURE);
		f.measure(view);
		expect(f.measure(view).more).toBe(false);
		expect(view.reads).toHaveLength(20);
		expect(new Set(view.reads).size).toBe(20);
		for (let i = 0; i < 20; i++) expect(f.offsetOf(`s${i}`)).toEqual({ dx: 0, dy: 0 });
		// Every group is of this epoch now: a further measure reads nothing.
		f.measure(view);
		expect(view.reads).toHaveLength(20);
	});
});

describe("AttachFollow: a document change", () => {
	const settled = () => {
		const f = new AttachFollow();
		f.setList([record()]);
		f.measure(measureOver(DOC, lineRef(DOC)));
		return f;
	};

	it("three lines typed above move the group down by three lines at once, with no measure, and that is a real edit", () => {
		// Defect: typing above moves no attached ink (the per-stroke rule), or moves it only at the next measure.
		const f = settled();
		const cs = insert(DOC, 0, "a\nb\nc\n"), doc = apply(DOC, cs);
		const before = f.attachments, gen = f.generation;
		const mapped = f.docChanged(cs, blockTopIn(doc), PX);
		expect(mapped).not.toBe(before);
		expect((mapped[0] as AttachmentRecord).target.from).toBe(DOC.indexOf("benzene") + 6);
		expect(f.offsetOf("s1")).toEqual({ dx: 0, dy: (3 * LH) / PX });
		expect(f.generation).toBeGreaterThan(gen);
		expect(f.takeEdited()).toBe(true);
		expect(f.takeEdited()).toBe(false);
	});

	it("typing below the target moves nothing, changes no list and is no edit", () => {
		// Defect: any keystroke bumps the generation (every member re-copied) or counts as an edit (a write per keystroke).
		const f = settled();
		const cs = insert(DOC, DOC.length, "more\n"), doc = apply(DOC, cs);
		const before = f.attachments, gen = f.generation;
		expect(f.docChanged(cs, blockTopIn(doc), PX)).toBe(before);
		expect(f.offsetOf("s1")).toEqual({ dx: 0, dy: 0 });
		expect(f.generation).toBe(gen);
		expect(f.takeEdited()).toBe(false);
	});

	it("a target whose text is deleted holds where it is shown and is never read again", () => {
		// Defect: the collapsed target is read at the deletion point and the ink jumps there.
		const f = settled();
		const cs0 = insert(DOC, 0, "x\n"), doc0 = apply(DOC, cs0);
		f.docChanged(cs0, blockTopIn(doc0), PX);
		const shown = f.offsetOf("s1");
		const r = f.attachments[0] as AttachmentRecord;
		const del = ChangeSet.of([{ from: r.target.from, to: r.target.to }], doc0.length), doc1 = apply(doc0, del);
		f.docChanged(del, blockTopIn(doc1), PX);
		f.layoutChanged();
		const view = measureOver(doc1, () => ({ x: 500, y: 500 }));
		f.measure(view);
		expect(view.reads).toHaveLength(0);
		expect(f.offsetOf("s1")).toEqual(shown);
	});
});

describe("AttachFollow: layout, status, attach", () => {
	it("a width change holds the last correction until the next measure reads the wrapped row", () => {
		// Defect: a width change drops the group to pending (it blinks out) or to its stored points (a jump and back).
		const f = new AttachFollow();
		f.setList([record()]);
		f.measure(measureOver(DOC, lineRef(DOC)));
		f.layoutChanged();
		expect(f.offsetOf("s1")).toEqual({ dx: 0, dy: 0 });
		const m = f.measure(measureOver(DOC, () => ({ x: 66, y: 50 })));
		expect(m.changed).toBe(true);
		expect(f.offsetOf("s2")).toEqual({ dx: 30, dy: 30 });
	});

	it("a group whose target needs reattachment shows its stored points and is never read", () => {
		// Defect: an unresolved group read from a file stays pending forever (its ink vanishes), or is read at a wrong line.
		const f = new AttachFollow();
		f.setList([record()], new Map([["att-1", "needs-reattachment"]]));
		const view = measureOver(DOC, lineRef(DOC, 400));
		f.measure(view);
		expect(view.reads).toHaveLength(0);
		expect(f.offsetOf("s1")).toEqual({ dx: 0, dy: 0 });
	});

	it("attach shows the group where it is, with no pending frame", () => {
		// Defect: a new group is pending until the next measure, so the ink blinks out at the tap.
		const f = new AttachFollow();
		const r = record();
		f.setList(attachGroup([], r).list);
		f.attached(r, blockTopIn(DOC)(r.target.from));
		expect(f.offsetOf("s1")).toEqual({ dx: 0, dy: 0 });
	});
});

describe("AttachFollow: redo of an attach", () => {
	it("a redo shows the group at once at its record's place, and a measure after, layout unchanged, changes nothing", () => {
		// Defect: a redo leaves the group pending until the next measure (a blink); or the seed is never read again.
		const f = new AttachFollow();
		const r = record();
		f.setList([r]);
		f.seeded(r, blockTopIn(DOC)(r.target.from));
		expect(f.offsetOf("s1")).toEqual({ dx: 0, dy: 0 });
		const view = measureOver(DOC, () => ({ ...r.ref }));
		expect(f.measure(view).changed).toBe(false);
		expect(view.reads).toHaveLength(1);
	});
});

describe("AttachFollow: a history step with no read of this layout", () => {
	type Seed = (record: AttachmentRecord, blockTop: number, carry?: { dx: number; dy: number }) => unknown;
	const seed = (f: AttachFollow): Seed => (f.seeded as unknown as Seed).bind(f);

	it("is seeded at the correction the step carries and left to be read: nothing moves at the step", () => {
		// Defect: the group is seeded at no correction, so the step paints the stored points; or it is never read again.
		const f = new AttachFollow();
		const r = record();
		f.setList([r]);
		expect(seed(f)(r, blockTopIn(DOC)(r.target.from), { dx: 6, dy: 12 }), "the caller asks the next measure").toBe(true);
		expect(f.offsetOf("s1")).toEqual({ dx: 6, dy: 12 });
		const same = measureOver(DOC, () => ({ x: r.ref.x + 6, y: r.ref.y + 12 }));
		expect(f.measure(same).changed, "the read confirms the carried correction").toBe(false);
		expect(same.reads).toHaveLength(1);
		expect(f.offsetOf("s1")).toEqual({ dx: 6, dy: 12 });
	});

	it("a layout that changed since the record's point was read moves the group once, at that read", () => {
		// Defect: the seed is marked read, so the group keeps the carried correction after its words moved.
		const f = new AttachFollow();
		const r = record();
		f.setList([r]);
		seed(f)(r, blockTopIn(DOC)(r.target.from), { dx: 6, dy: 12 });
		const moved = measureOver(DOC, () => ({ x: r.ref.x + 6, y: r.ref.y + 52 }));
		expect(f.measure(moved).changed).toBe(true);
		expect(f.offsetOf("s1")).toEqual({ dx: 6, dy: 52 });
	});

	it("with a read of this layout the group takes it, and the caller asks nothing", () => {
		// Defect: every history step asks a measure, or the carried value overrides a read of this layout.
		const f = new AttachFollow();
		const r = record();
		f.setList([r]);
		f.measure(measureOver(DOC, () => ({ x: r.ref.x + 6, y: r.ref.y + 12 })));
		expect(seed(f)(r, blockTopIn(DOC)(r.target.from), { dx: 99, dy: 99 })).toBe(false);
		expect(f.offsetOf("s1")).toEqual({ dx: 6, dy: 12 });
	});
});

describe("AttachFollow: settle and history", () => {
	it("a settle moves points and point together: no shown place changes at the write, on the writer pane or another of another width", () => {
		// Defect: the settle moves the points and keeps the stored point (the writer pane doubles its move), or moves the
		// point and not the points; either way a pane's shown place changes at the write.
		const r = record();
		const points = [{ x: 40, y: 24 }, { x: 52, y: 30 }];
		const writer = new AttachFollow(), other = new AttachFollow();
		writer.setList([r]);
		other.setList([r]);
		writer.measure(measureOver(DOC, () => ({ x: 36, y: 80 })));
		other.measure(measureOver(DOC, () => ({ x: 12, y: 110 })));
		const shown = (f: AttachFollow, pts: { x: number; y: number }[]) => {
			const o = f.offsetOf("s1")!;
			return pts.map((p) => ({ x: p.x + o.dx, y: p.y + o.dy }));
		};
		const before = { writer: shown(writer, points), other: shown(other, points) };
		const o = writer.offsetOf("s1")!;
		const next = settledRecord(r, o, { width: 500, font: 19 });
		const moved = points.map((p) => ({ x: p.x + o.dx, y: p.y + o.dy }));
		writer.setList([next]);
		other.setList([next]);
		expect(shown(writer, moved)).toEqual(before.writer);
		expect(shown(other, moved)).toEqual(before.other);
		expect(writer.offsetOf("s1")).toEqual({ dx: 0, dy: 0 });
		expect(next.probe).toEqual({ id: "s1", x: r.probe.x + o.dx, y: r.probe.y + o.dy });
		expect(next.layout).toEqual({ width: 500, font: 19 });
	});

	it("a settle with nothing to move returns the record as it was", () => {
		// Defect: every page write rewrites every record (a sidecar diff with no edit).
		const r = record();
		expect(settledRecord(r, { dx: 0, dy: 0 }, { ...r.layout })).toBe(r);
	});

	it("an attach step applies only when the record is at its before; a spent step changes nothing", () => {
		// Defect: a step applied over a record another pane already changed overwrites that change.
		const r = record(), moved = { ...r, ref: { x: 36, y: 60 } };
		const attach = attachGroup([], r).step!;
		expect(applyAttachOp([], attach)).toEqual([r]);
		expect(applyAttachOp([r], attach)).toBeNull();
		const change = attachGroup([r], moved).step!;
		expect(applyAttachOp([{ ...r, ref: { ...r.ref } }], change)).toEqual([moved]);
		expect(applyAttachOp([{ ...r, ref: { x: 1, y: 1 } }], change)).toBeNull();
		// With a text change in the same step the target is left out of the test and the record keeps its own.
		const mapped = { ...r.target, from: r.target.from + 3, to: r.target.to + 3 };
		expect(applyAttachOp([{ ...r, target: mapped }], change, true)).toEqual([{ ...moved, target: mapped }]);
		expect(applyAttachOp([{ ...r, target: mapped, ref: { x: 1, y: 1 } }], change, true)).toBeNull();
		const opaque: AttachmentData = { opaque: true, id: "att-1", raw: { v: 2 } };
		expect(applyAttachOp([opaque], attach)).toBeNull();
	});
});

describe("AttachFollow: typed keys skip the groups below", () => {
	const DOC2 = "Typing goes here.\nThe word benzene sits here.\nAnd toluene in this one.\n";
	const lineEnd = (doc: string, pos: number) => { const i = doc.indexOf("\n", pos); return i < 0 ? doc.length : i; };
	/** Two groups below line 0, both read in this layout. */
	const setup = () => {
		const f = new AttachFollow();
		f.setList([record(DOC2, "benzene", "att-1", ["s1"], { x: 36, y: 20 }), record(DOC2, "toluene", "att-2", ["s2"], { x: 36, y: 40 })]);
		f.measure(measureOver(DOC2, lineRef(DOC2)));
		return f;
	};
	const key = (f: AttachFollow, doc: string, pos: number, text: string, sameLines: boolean, heightDelta = 0) => {
		const cs = insert(doc, pos, text), next = apply(doc, cs);
		const at = blockTopIn(next);
		f.docChanged(cs, at, PX, sameLines ? lineEnd(next, pos + text.length) : undefined);
		const view = measureOver(next, lineRef(next));
		// The changed line's height as measured now: a rewrap grows it, and every line below moves.
		view.changedBlockTop = (p) => at(p) + heightDelta;
		f.measure(view);
		return { next, reads: view.reads.length };
	};

	it("F1: 25 typed keys on a line above the groups: no group read, one changed block measured per key", () => {
		// Defect: a key moves every group target by one character and the next measure reads all of them through the layout.
		const f = setup(), before = { ...f.counts };
		let doc = DOC2, reads = 0;
		for (let i = 0; i < 25; i++) { const k = key(f, doc, 6, "x", true); doc = k.next; reads += k.reads; }
		expect([reads, f.counts.groupsMeasured - before.groupsMeasured, f.counts.blocksMeasured - before.blocksMeasured], "layout reads, groups measured, blocks measured").toEqual([0, 0, 25]);
		expect(f.offsetOf("s1"), "nothing moved").toEqual({ dx: 0, dy: 0 });
	});

	it("F2: an Enter above the groups reads them as before: the line count changed", () => {
		const f = setup();
		const k = key(f, DOC2, 6, "\n", false);
		expect(k.reads, "both groups read").toBe(2);
		expect(f.offsetOf("s1"), "moved down one line").toEqual({ dx: 0, dy: LH / PX });
	});

	it("F3: a typed key that rewraps its line reads the groups below", () => {
		// Defect: the skip trusts the line count alone, and ink stays where a grown line's text left.
		const f = setup();
		expect(key(f, DOC2, 6, "x", true, LH).reads, "both groups read").toBe(2);
	});

	it("F4: a typed key on a group's own line reads that group", () => {
		// Defect: a group on the changed line is skipped, and its x lags the word it marks.
		const f = setup();
		expect(key(f, DOC2, DOC2.indexOf("benzene") - 1, "x", true).reads, "the group on the changed line read, the one below not").toBe(1);
	});

	it("F5: a layout change after the key reads every group", () => {
		const f = setup();
		const cs = insert(DOC2, 6, "x"), next = apply(DOC2, cs);
		f.docChanged(cs, blockTopIn(next), PX, lineEnd(next, 7));
		f.layoutChanged();
		const view = measureOver(next, lineRef(next));
		f.measure(view);
		expect(view.reads.length, "both groups read").toBe(2);
	});
});
