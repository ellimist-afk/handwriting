/**
 * The editor's quiet pass (anchorMeasured) and attached ink: a member of a group shown away from its stored points whose
 * own anchor fails is anchored at the place its group shows it (line under its stored top plus the group's dy, that
 * line's top less the dy), so a read-only view draws it on its words; a member of a pending group is left for a later
 * pass; free ink is anchored at its stored top as before. The editor shows nothing new. Each cell names its defect.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, lineKey, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke, type LineAnchor } from "../ink/Stroke";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

const PATH = "members.md";
const ROW = 40;
const doc = Text.of(Array.from({ length: 12 }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();

function surface(): LineAnchors {
	const layout: LineLayout = { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * ROW, pxPerWorld: 1 };
	const a = new LineAnchors(() => layout);
	a.setSignature({ width: 892, fontPx: 26, charWidth: 14 });
	a.drawn(1, doc.lines);
	a.drawn(1, doc.lines, true, true);
	return a;
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** An anchor from a text no longer there (an edit above made on another device): its key fails on this text. */
function staleAnchor(s: InkStroke): LineAnchor {
	return { line: 3, top: 2 * ROW, y: s.bbox.y, key: lineKey("text that is gone"), width: 892, fontPx: 26 };
}

const word = "line 3 words";
const record = (strokeIds: string[]): AttachmentRecord => {
	const from = DOC.indexOf(word);
	return { v: 1, id: "g1", strokeIds, target: targetAt(DOC, from, from + word.length, "range"), ref: { x: 0, y: 2 * ROW }, layout: { width: 892, font: 26 }, probe: { id: strokeIds[0]!, x: 10, y: 2 * ROW + 6 } };
};

/** The group read `dy` lower than it was attached: its correction is {0, dy}. */
function readAt(a: LineAnchors, dy: number): void {
	a.follow.measure({ inView: () => true, refAt: () => ({ x: 0, y: 2 * ROW + dy }), blockTop: () => 2 * ROW + dy });
}

describe("the quiet pass anchors a member of a shown group at its shown place", () => {
	it("a member with a failing anchor, its group read at shown dy 40, is anchored at the shown line, top less the dy", () => {
		// Defect: the quiet pass anchors the member at its stored top (its attach place), so reading view and print draw
		// it where it was attached, not on its words.
		const a = surface();
		const m = strokeAt("m", 10, 2 * ROW + 1);
		m.lineAnchor = staleAnchor(m);
		a.follow.setList([record(["m"])]);
		readAt(a, ROW);
		expect(a.follow.offsetOf("m")).toEqual({ dx: 0, dy: ROW });
		a.tracks(PATH, [m]);
		a.drawn(1, doc.lines);
		a.drawn(1, doc.lines, true, true);
		const shownBefore = a.shownOf(m).bbox.y;
		expect(a.anchorMeasured(PATH, [m])).toBe(1);
		const an = m.lineAnchor!;
		expect(an.line, "the line under the shown top").toBe(4);
		expect(an.top, "that line's top less the shown dy").toBe(3 * ROW - ROW);
		expect(an.y, "the stored y").toBe(m.bbox.y);
		expect(an.key).toBe(lineKey(doc.line(4).text));
		expect(a.shownOf(m).bbox.y, "the editor shows the member where it did").toBe(shownBefore);
		expect(a.dyOf(m)).toBe(ROW);
	});

	it("control: a free stroke beside it anchors at its stored top", () => {
		// Defect: the member branch reaches ink in no group, which then rides a group's correction in reading view.
		const a = surface();
		const m = strokeAt("m", 10, 2 * ROW + 1), free = strokeAt("free", 200, 5 * ROW + 1);
		m.lineAnchor = staleAnchor(m);
		free.lineAnchor = staleAnchor(free);
		a.follow.setList([record(["m"])]);
		readAt(a, ROW);
		a.tracks(PATH, [m, free]);
		a.drawn(1, doc.lines);
		a.drawn(1, doc.lines, true, true);
		expect(a.anchorMeasured(PATH, [m, free])).toBe(2);
		expect(free.lineAnchor!.line).toBe(6);
		expect(free.lineAnchor!.top).toBe(5 * ROW);
		expect(free.lineAnchor!.y).toBe(free.bbox.y);
	});

	it("control: a member of a pending group is not anchored", () => {
		// Defect: a pending member is anchored at its stored top, the place its group is about to leave.
		const a = surface();
		const m = strokeAt("m", 10, 2 * ROW + 1);
		const old = staleAnchor(m);
		m.lineAnchor = old;
		a.follow.setList([record(["m"])]);
		expect(a.follow.offsetOf("m")).toBeNull();
		a.tracks(PATH, [m]);
		a.drawn(1, doc.lines);
		a.drawn(1, doc.lines, true, true);
		expect(a.anchorMeasured(PATH, [m])).toBe(0);
		expect(m.lineAnchor).toBe(old);
	});

	it("control: a member of a group read at its stored place anchors at its stored top", () => {
		// Defect: a group at dy 0 is pushed a line by the member branch's own rounding.
		const a = surface();
		const m = strokeAt("m", 10, 2 * ROW + 1);
		m.lineAnchor = staleAnchor(m);
		a.follow.setList([record(["m"])]);
		readAt(a, 0);
		a.tracks(PATH, [m]);
		a.drawn(1, doc.lines);
		a.drawn(1, doc.lines, true, true);
		expect(a.anchorMeasured(PATH, [m])).toBe(1);
		expect(m.lineAnchor!.line).toBe(3);
		expect(m.lineAnchor!.top).toBe(2 * ROW);
	});
});

/**
 * A member's anchor, taken at its group's shown place, is re-taken on a document change: on the eager path
 * (the changed lines' heights not on record) and on the logged path (the change on the member's own line). Both re-takes
 * read the member at its group's dy, as the editor shows it, so the anchor still says where the member is shown and a
 * read-only view draws it there.
 */
describe("a document change re-takes a member's anchor at its group's dy", () => {
	/** A member anchored at its group's shown dy ROW, over a layout the change can replace. */
	function anchoredMember() {
		const state = { layout: { lines: doc.lines, lineText: (n: number) => doc.line(n).text, lineTop: (n: number) => (n - 1) * ROW, pxPerWorld: 1 } as LineLayout };
		const a = new LineAnchors(() => state.layout);
		a.setSignature({ width: 892, fontPx: 26, charWidth: 14 });
		a.drawn(1, doc.lines);
		a.drawn(1, doc.lines, true, true);
		const m = strokeAt("m", 10, 2 * ROW + 1);
		m.lineAnchor = staleAnchor(m);
		a.follow.setList([record(["m"])]);
		readAt(a, ROW);
		a.tracks(PATH, [m]);
		a.drawn(1, doc.lines);
		a.drawn(1, doc.lines, true, true);
		expect(a.anchorMeasured(PATH, [m]), "precondition: the member is anchored").toBe(1);
		expect(m.lineAnchor!.line, "precondition: at the line under its shown top").toBe(4);
		return { state, a, m };
	}

	/** The correction the member's anchor says, as a read-only view reads it over the editor's layout. */
	const anchorDy = (layout: LineLayout, m: InkStroke): number => layout.lineTop(m.lineAnchor!.line) / layout.pxPerWorld - m.lineAnchor!.top;

	it("an Enter above, with the changed line's height not on record, keeps the member's anchor at its group's dy", () => {
		// Defect: the eager re-take reads a member at no correction (it has no dy memo), so its anchor is re-taken at its
		// stored place and reading view draws it there, moved sideways only.
		const { state, a, m } = anchoredMember();
		// Only lines 6 to 12 drawn whole since: line 1's height is not on record, so the change takes the eager path.
		a.drawn(6, doc.lines);
		const eager = a.changePaths.eager;
		const changes = ChangeSet.of({ from: 0, insert: "\n" }, doc.length);
		const after = changes.apply(doc);
		state.layout = { lines: after.lines, lineText: (n) => after.line(n).text, lineTop: (n) => (n - 1) * ROW, pxPerWorld: 1 };
		a.docChanged(PATH, [m], doc, changes, after);
		expect(a.changePaths.eager, "precondition: the change took the eager path").toBe(eager + 1);
		expect(a.dyOf(m), "precondition: the editor shows the member at its group's dy").toBe(ROW);
		expect(anchorDy(state.layout, m), "the re-taken anchor lost its group's dy").toBe(ROW);
	});

	it("a change on the member's own line keeps its anchor at its group's dy", () => {
		// Defect: the logged re-take on the changed lines reads a member at no correction, as the eager one does.
		const { state, a, m } = anchoredMember();
		const lazy = a.changePaths.lazy;
		const changes = ChangeSet.of({ from: doc.line(4).from + 4, insert: "xyz" }, doc.length);
		const after = changes.apply(doc);
		state.layout = { lines: after.lines, lineText: (n) => after.line(n).text, lineTop: (n) => (n - 1) * ROW, pxPerWorld: 1 };
		a.docChanged(PATH, [m], doc, changes, after);
		expect(a.changePaths.lazy, "precondition: the change took the logged path").toBe(lazy + 1);
		a.fold();
		expect(m.lineAnchor!.key, "precondition: the anchor was re-taken on its changed line").toBe(lineKey(after.line(4).text));
		expect(a.dyOf(m), "precondition: the editor shows the member at its group's dy").toBe(ROW);
		expect(anchorDy(state.layout, m), "the re-taken anchor lost its group's dy").toBe(ROW);
	});
});
