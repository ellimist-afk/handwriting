/**
 * New ink drawn on a line with no box read yet, once this surface has read boxes off the height map, keeps its drawn place
 * when an editor update comes between the draw and its line's first box read. Box reads follow a document change or a
 * layout update, each a new layout, so that first read is in a later layout than the one the stroke was drawn in, and it
 * may be a frame the text has not settled in. Until two reads of the line agree, the stroke is read against the height map,
 * where it was drawn; once they agree it is taken again under the box, with no shown move, and then follows its box.
 * The updates are run in the order the overlay runs them (InkOverlayLineAnchors.ts: a document change goes to docChanged,
 * a geometry update with no document change to layoutChanged; the line box measure reads after either).
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const PATH = "box-settle.md";
const PX_PER_WORLD = 0.11151960784313726;
const PITCH = 25.5 * PX_PER_WORLD;
const LINES = 30;

function layoutOf(doc: Text): LineLayout {
	return { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * PITCH, pxPerWorld: PX_PER_WORLD };
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** Box tops for `lines`, each `gapPx` screen px below its height-map top, in world units. */
function boxTops(layout: LineLayout, lines: number[], gapPx: number): Map<number, number> {
	return new Map(lines.map((n) => [n, (layout.lineTop(n) + gapPx) / PX_PER_WORLD]));
}

/** Line 3 carries ink and was read 3 px off the map; then a stroke is drawn on line 9, whose box was never read. */
function rig() {
	const state = { doc: Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`)), layout: null as unknown as LineLayout };
	state.layout = layoutOf(state.doc);
	const a = new LineAnchors(() => state.layout);
	a.setSignature({ width: 892, fontPx: 19, charWidth: 10 });
	const s3 = strokeAt("s3", 10, 2 * 25.5 + 2);
	a.anchorNew(PATH, s3);
	a.tracks(PATH, [s3]);
	a.drawn(1, LINES);
	expect(s3.lineAnchor?.line, "premise: s3 anchors on line 3").toBe(3);
	expect(a.dyOf(s3), "premise: s3 reads no correction").toBe(0);
	a.boxesRead(PATH, [s3], boxTops(state.layout, [3], 3), 1);
	expect(a.dyOf(s3) * PX_PER_WORLD, "premise: line 3's ink follows its box").toBeCloseTo(3, 6);
	const s9 = strokeAt("s9", 10, 8 * 25.5 + 2);
	a.anchorNew(PATH, s9);
	const all = [s3, s9];
	a.tracks(PATH, all);
	expect(s9.lineAnchor?.line, "premise: s9 anchors on line 9").toBe(9);
	expect(a.dyOf(s9), "premise: s9 drawn at its shown place").toBe(0);
	return { state, a, all, s3, s9 };
}

/** s9's shown correction, editor px. */
function shown(r: ReturnType<typeof rig>): number {
	return r.a.dyOf(r.s9) * PX_PER_WORLD;
}

/** Line 9 read for the first time with the same 3 px gap line 3 shows: the new stroke, drawn where line 9 is painted, stays. */
function firstRead(r: ReturnType<typeof rig>): void {
	expect(shown(r), "premise: s9 still where drawn before its line's first box read").toBeCloseTo(0, 6);
	r.a.boxesRead(PATH, r.all, boxTops(r.state.layout, [3, 9], 3), 2);
	expect(r.a.dyOf(r.s3) * PX_PER_WORLD, "control: line 3 still follows its box").toBeCloseTo(3, 6);
	expect(shown(r), "s9 moved at its line's first box read (editor px)").toBeCloseTo(0, 6);
}

describe("new ink keeps its drawn place when an editor update comes before its line's first box read", () => {
	it("one character typed on line 20, below the new ink, before the read", () => {
		const r = rig();
		const before = r.state.doc;
		const changes = ChangeSet.of({ from: before.line(20).from + 3, insert: "x" }, before.length);
		const after = changes.apply(before);
		r.state.doc = after;
		r.state.layout = layoutOf(after);
		r.a.docChanged(PATH, r.all, before, changes, after);
		r.a.drawn(r.a.changedLines.from, r.a.changedLines.to, false);
		r.a.drawn(r.a.changedLines.from, r.a.changedLines.to, false, true);
		if (r.a.windowOpen) r.a.windowViewed(PATH, r.all);
		firstRead(r);
		// The next read agrees with the first: the stroke is taken under its box and still does not move.
		r.a.boxesRead(PATH, r.all, boxTops(r.state.layout, [3, 9], 3), 2);
		expect(shown(r), "s9 moved when its line's box read agreed").toBeCloseTo(0, 6);
		r.a.detached();
	});

	it("a geometry update that moves no line, before the read", () => {
		const r = rig();
		r.a.layoutChanged(PATH, r.all, "transaction");
		firstRead(r);
		r.a.detached();
	});

	it("a first read one line low, then two agreeing reads 3 px off the map: the stroke stays, then follows a 10 px box move", () => {
		// A first read in a later layout can catch a frame where everything above the line sits one line lower. Taken under
		// that read, the stroke would stay a line off; read under the map until the line's reads agree, it stays where drawn,
		// and once taken under the settled box it moves with the box.
		const r = rig();
		r.a.layoutChanged(PATH, r.all, "transaction");
		r.a.boxesRead(PATH, r.all, boxTops(r.state.layout, [9], PITCH), 1);
		expect(shown(r), "s9 moved at a first read one line low").toBeCloseTo(0, 6);
		r.a.boxesRead(PATH, r.all, boxTops(r.state.layout, [9], 3), 1);
		expect(shown(r), "s9 moved when its line read 3 px off the map").toBeCloseTo(0, 6);
		r.a.boxesRead(PATH, r.all, boxTops(r.state.layout, [9], 3), 1);
		expect(shown(r), "s9 moved when its line's reads agreed").toBeCloseTo(0, 6);
		r.a.boxesRead(PATH, r.all, boxTops(r.state.layout, [9], 13), 1);
		expect(shown(r), "s9 follows its box 10 px down").toBeCloseTo(10, 6);
		r.a.detached();
	});

	it("a held stroke erased while its line's reads agree, the line then read one line low, the stroke undone: it stays", () => {
		// The agreement is the line's as last read: a read that replaces the top undoes it, though no held stroke was read
		// when the line agreed. Kept, the undone stroke would be taken under the one-line-low read and stay a line off.
		const state = { doc: Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`)), layout: null as unknown as LineLayout };
		state.layout = layoutOf(state.doc);
		const a = new LineAnchors(() => state.layout);
		a.setSignature({ width: 892, fontPx: 19, charWidth: 10 });
		const s3 = strokeAt("s3", 10, 2 * 25.5 + 2), old9 = strokeAt("old9", 60, 8 * 25.5 + 2);
		for (const s of [s3, old9]) a.anchorNew(PATH, s);
		a.tracks(PATH, [s3, old9]);
		a.drawn(1, LINES);
		a.boxesRead(PATH, [s3, old9], boxTops(state.layout, [3], 3), 1);
		expect(a.dyOf(s3) * PX_PER_WORLD, "premise: line 3's ink follows its box").toBeCloseTo(3, 6);
		const s9 = strokeAt("s9", 10, 8 * 25.5 + 2);
		a.anchorNew(PATH, s9);
		const all = [s3, old9, s9];
		a.tracks(PATH, all);
		expect(s9.lineAnchor?.line, "premise: s9 anchors on line 9").toBe(9);
		expect(a.dyOf(s9), "premise: s9 drawn at its shown place").toBe(0);
		const s9Shown = () => a.dyOf(s9) * PX_PER_WORLD;
		a.layoutChanged(PATH, all, "transaction");
		a.boxesRead(PATH, all, boxTops(state.layout, [3, 9], 3), 2);
		expect(s9Shown(), "premise: s9 held at its line's first box read in a later layout").toBeCloseTo(0, 6);
		expect(a.dyOf(old9) * PX_PER_WORLD, "control: older ink on line 9 follows its box").toBeCloseTo(3, 6);
		// s9 erased: the list the box reads see no longer holds it, and line 9 (old9's) reads the same top again.
		const erased = [s3, old9];
		a.tracks(PATH, erased);
		a.boxesRead(PATH, erased, boxTops(state.layout, [3, 9], 3), 2);
		// A frame with everything a line lower replaces line 9's top.
		a.boxesRead(PATH, erased, boxTops(state.layout, [3, 9], 3 + PITCH), 2);
		// s9 undone, read in that frame, then the frame passes.
		const undone = [s3, old9, s9];
		a.tracks(PATH, undone);
		expect(s9Shown(), "s9 moved when undone in the one-line-low frame").toBeCloseTo(0, 6);
		a.boxesRead(PATH, undone, boxTops(state.layout, [3, 9], 3), 2);
		expect(a.dyOf(old9) * PX_PER_WORLD, "control: older ink on line 9 back on its box").toBeCloseTo(3, 6);
		expect(s9Shown(), "s9 moved when the one-line-low frame passed").toBeCloseTo(0, 6);
		a.detached();
	});
});
