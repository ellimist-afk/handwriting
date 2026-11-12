/**
 * Two panes on one note share the store's strokes, and each keeps its own list of the anchored ones, trusted while the
 * store list, its length and the ink revision are as they were (LineAnchor.ts anchoredIn). A stroke given an anchor while
 * it stays in the store moves none of those, so a pane that gives one (the quiet pass, anchorMeasured; a lasso drop or an
 * attach step, retake) marks every other pane's list on the note to be built again, as it marks its own. The other pane's
 * next read then holds the stroke and names its first and last lines' strokes as a build does, and its next edit moves the
 * stroke's anchor.
 *
 * Two bare surfaces over one store list and one layout, called as the overlay calls them; no DOM, no groups.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { translateStroke } from "../objects/Selection";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LH = 40;

function layoutOf(doc: Text): LineLayout {
	return { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * LH, pxPerWorld: 1 };
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** A stroke whose bbox top sits on line `n`. */
const onLine = (id: string, n: number, x = 10) => strokeAt(id, x, (n - 1) * LH + 5);

const lines = (n: number) => Text.of(Array.from({ length: n }, (_, i) => `line ${i + 1} words`));

type Rec = { src: readonly InkStroke[]; len: number; ink: number; list: InkStroke[]; at: number[]; top: InkStroke | null; bottom: InkStroke | null; stale: boolean };
type Inner = { anchored: Rec | null; anchoredIn(src: readonly InkStroke[]): InkStroke[] };
const inner = (x: LineAnchors) => x as unknown as Inner;

/** The list as the cells compare it: its strokes in order, their places, the first and last line's strokes, stale. */
const shape = (r: Rec | null) => r && { ids: r.list.map((s) => s.id), at: r.at.slice(), top: r.top?.id ?? null, bottom: r.bottom?.id ?? null, stale: r.stale };

/** What a build from the store's list returns now: the list marked stale and read. Changes the surface's list. */
function rebuilt(x: LineAnchors, src: readonly InkStroke[]) {
	const i = inner(x);
	if (i.anchored) i.anchored.stale = true;
	i.anchoredIn(src);
	return shape(i.anchored);
}

const anchorLine = (s: InkStroke | undefined) => s?.lineAnchor?.line ?? null;

/**
 * Panes A (the writer) and B on a 20-line note. The strokes go on the store list in the order given and A anchors each as
 * it is committed, but for the ids in `old` (ink from the file, not yet anchored). Both panes have read every line and
 * built their lists.
 */
function twoPanes(path: string, strokes: InkStroke[], old: string[]) {
	const before = lines(20);
	const st = { layout: layoutOf(before), focus: "a" };
	const a = new LineAnchors(() => st.layout, () => st.focus === "a"), b = new LineAnchors(() => st.layout, () => st.focus === "b");
	const src: InkStroke[] = [];
	const open = (x: LineAnchors) => { x.setSignature(SIG); x.tracks(path, src); x.drawn(1, 20); x.drawn(1, 20, true, true); };
	open(a);
	for (const s of strokes) {
		src.push(s);
		if (!old.includes(s.id)) a.anchorNew(path, s);
	}
	open(b);
	a.layoutChanged(path, src, "measure");
	b.layoutChanged(path, src, "measure");
	return { before, st, a, b, src, premise: { a: shape(inner(a).anchored), b: shape(inner(b).anchored) } };
}

/** A's list right after B's call, then A's next read, then a build of A's list from the store's list. */
function aAfter(p: ReturnType<typeof twoPanes>) {
	const stale = inner(p.a).anchored?.stale ?? null;
	inner(p.a).anchoredIn(p.src);
	const next = shape(inner(p.a).anchored);
	return { stale, next, build: rebuilt(p.a, p.src) };
}

describe("a pane that gives a stroke an anchor has every other pane's anchored list on the note built again", () => {
	it("B's quiet pass anchors ink from the file: A's list is marked, and A's next read holds the stroke as a build does", () => {
		const path = "peer-marks-quiet-pass.md";
		const p = twoPanes(path, [onLine("f", 5), onLine("o", 2), onLine("g", 12)], ["o"]);
		const info0 = JSON.stringify(p.premise);
		const was = { ids: ["f", "g"], at: [0, 2], top: "f", bottom: "g", stale: false };
		expect(p.premise, `premise: both lists built and current, without o ${info0}`).toEqual({ a: was, b: was });
		const took = p.b.anchorMeasured(path, p.src);
		const r = aAfter(p);
		const info = JSON.stringify({ took, o: anchorLine(p.src[1]), ...r });
		expect([took, anchorLine(p.src[1])], `premise: B's pass anchored o on line 2 ${info}`).toEqual([1, 2]);
		expect(r.build, `premise: a build holds o, on the first line ${info}`).toEqual({ ids: ["f", "o", "g"], at: [0, 1, 2], top: "o", bottom: "g", stale: false });
		expect(r.stale, `A's list after B's pass ${info}`).toBe(true);
		expect(r.next, `A's next read ${info}`).toEqual(r.build);
	});

	it("B's attach step anchors a stroke with no anchor at the correction given: A's list is marked, and A's next read holds the stroke as a build does", () => {
		const path = "peer-marks-attach-step.md";
		const p = twoPanes(path, [onLine("f", 5), onLine("o", 2), onLine("g", 12)], ["o"]);
		const info0 = JSON.stringify(p.premise);
		const was = { ids: ["f", "g"], at: [0, 2], top: "f", bottom: "g", stale: false };
		expect(p.premise, `premise: both lists built and current, without o ${info0}`).toEqual({ a: was, b: was });
		p.b.retake(path, [p.src[1]!], [0], p.src);
		const r = aAfter(p);
		const info = JSON.stringify({ o: anchorLine(p.src[1]), ...r });
		expect(anchorLine(p.src[1]), `premise: B's step anchored o on line 2 ${info}`).toBe(2);
		expect(r.build, `premise: a build holds o, on the first line ${info}`).toEqual({ ids: ["f", "o", "g"], at: [0, 1, 2], top: "o", bottom: "g", stale: false });
		expect(r.stale, `A's list after B's step ${info}`).toBe(true);
		expect(r.next, `A's next read ${info}`).toEqual(r.build);
	});

	it("B's lasso drop takes the stroke on A's first anchored line below its last: A's list is marked, and A's next read names the first and last lines' strokes as a build does", () => {
		const path = "peer-marks-lasso-drop.md";
		const p = twoPanes(path, [onLine("t", 2), onLine("f", 5), onLine("g", 12)], []);
		const info0 = JSON.stringify(p.premise);
		const was = { ids: ["t", "f", "g"], at: [0, 1, 2], top: "t", bottom: "g", stale: false };
		expect(p.premise, `premise: both lists built and current, t on the first line ${info0}`).toEqual({ a: was, b: was });
		const t = p.src[0]!;
		// A drag 13 lines down in B: shown on line 15, below g.
		translateStroke(t, 0, 13 * LH);
		p.b.retake(path, [t], undefined, p.src);
		const r = aAfter(p);
		const info = JSON.stringify({ t: anchorLine(t), ...r });
		expect(anchorLine(t), `premise: the drop anchored t again on line 15 ${info}`).toBe(15);
		expect(r.build, `premise: a build names f first and t last ${info}`).toEqual({ ids: ["t", "f", "g"], at: [0, 1, 2], top: "f", bottom: "t", stale: false });
		expect(r.stale, `A's list after B's drop ${info}`).toBe(true);
		expect(r.next, `A's next read ${info}`).toEqual(r.build);
	});

	it("B's quiet pass anchors ink below the line A then types an Enter on: after A's fold the stroke's anchor names the next line, as on a pane whose list was built again", () => {
		const out: Record<string, unknown> = {};
		for (const arm of ["kept", "built"] as const) {
			const path = `peer-marks-enter-${arm}.md`;
			const p = twoPanes(path, [onLine("f", 2), onLine("o", 8), onLine("h", 14)], ["o"]);
			const took = p.b.anchorMeasured(path, p.src), at = anchorLine(p.src[1]);
			if (arm === "built") rebuilt(p.a, p.src);
			// An Enter at the end of line 3, typed in A; B takes no change and reads nothing.
			const changes = ChangeSet.of({ from: p.before.line(3).to, insert: "\n" }, p.before.length);
			const after = changes.apply(p.before);
			p.st.layout = layoutOf(after);
			let thrown = "";
			try {
				p.a.docChanged(path, p.src, p.before, changes, after);
				p.a.fold();
			} catch (err) {
				thrown = (err as Error).message;
			}
			out[arm] = { took, at, thrown, anchors: Object.fromEntries(p.src.map((s) => [s.id, s.lineAnchor ? { ...s.lineAnchor } : null])) };
		}
		const info = JSON.stringify(out);
		const kept = out.kept as { took: number; at: number; thrown: string; anchors: Record<string, { line: number } | null> };
		const built = out.built as typeof kept;
		expect([kept.took, kept.at, built.took, built.at, kept.thrown, built.thrown], `premise: B's pass anchored o on line 8 in both, nothing threw ${info}`).toEqual([1, 8, 1, 8, "", ""]);
		expect([built.anchors.f?.line, built.anchors.o?.line, built.anchors.h?.line], `premise: on the pane built again the Enter moved o and h a line ${info}`).toEqual([2, 9, 15]);
		expect(kept.anchors.o?.line, `o's line after A's fold ${info}`).toBe(9);
		expect(kept.anchors, `every anchor as on the pane built again ${info}`).toEqual(built.anchors);
	});

	it("A's attach step anchors ink while B is listed under a newer store list: B's list is marked, and after B types an Enter above and folds, the stroke's anchor names the next line, as on a pane whose list was built again", () => {
		// The overlay's call, with the store list it hands in. Cast as `inner` is, so a build whose retake takes no store list
		// runs the same call and drops it.
		type Retake = { retake(path: string, strokes: readonly InkStroke[], dys: readonly number[] | undefined, src: readonly InkStroke[]): void };
		const heldOf = (x: LineAnchors) => (x as unknown as { heldSrc: readonly InkStroke[] | null }).heldSrc;
		const out: Record<string, unknown> = {};
		for (const arm of ["kept", "built"] as const) {
			const path = `peer-marks-newer-list-${arm}.md`;
			const p = twoPanes(path, [onLine("f", 2), onLine("o", 8), onLine("h", 14)], ["o"]);
			// The store gives the note a new array of the same strokes, as a persist swap does. B reads it; A reads nothing.
			const next = p.src.slice();
			p.b.tracks(path, next);
			const premise = {
				start: p.premise,
				b: shape(inner(p.b).anchored),
				bUnder: [inner(p.b).anchored?.src === next, heldOf(p.b) === next],
				aUnder: [inner(p.a).anchored?.src === p.src, heldOf(p.a) === p.src],
			};
			// A's attach step on o at correction 0, handed the store list as it is now.
			(p.a as unknown as Retake).retake(path, [p.src[1]!], [0], next);
			const at = anchorLine(p.src[1]), stale = inner(p.b).anchored?.stale ?? null;
			if (arm === "built") rebuilt(p.b, next);
			// An Enter at the end of line 3, typed in B, the writer; A takes no change and reads nothing.
			p.st.focus = "b";
			const changes = ChangeSet.of({ from: p.before.line(3).to, insert: "\n" }, p.before.length);
			const after = changes.apply(p.before);
			p.st.layout = layoutOf(after);
			let thrown = "";
			try {
				p.b.docChanged(path, next, p.before, changes, after);
				p.b.fold();
			} catch (err) {
				thrown = (err as Error).message;
			}
			out[arm] = { premise, at, stale, thrown, anchors: Object.fromEntries(p.src.map((s) => [s.id, s.lineAnchor ? { ...s.lineAnchor } : null])) };
		}
		const info = JSON.stringify(out);
		type Arm = { premise: unknown; at: number; stale: boolean | null; thrown: string; anchors: Record<string, { line: number } | null> };
		const kept = out.kept as Arm, built = out.built as Arm;
		const list = { ids: ["f", "h"], at: [0, 2], top: "f", bottom: "h", stale: false };
		const was = { start: { a: list, b: list }, b: list, bUnder: [true, true], aUnder: [true, true] };
		expect([kept.premise, built.premise], `premise: B's list built and current under the new array, without o; A under the old one ${info}`).toEqual([was, was]);
		expect([kept.at, built.at, kept.thrown, built.thrown], `premise: A's step anchored o on line 8 in both, nothing threw ${info}`).toEqual([8, 8, "", ""]);
		expect([built.anchors.f?.line, built.anchors.o?.line, built.anchors.h?.line], `premise: on the pane built again the Enter moved o and h a line ${info}`).toEqual([2, 9, 15]);
		expect.soft(kept.stale, `B's list after A's step ${info}`).toBe(true);
		expect.soft({ line: kept.anchors.o?.line, anchor: kept.anchors.o }, `o's anchor after B's fold ${info}`).toEqual({ line: 9, anchor: built.anchors.o });
	});

	it("A's lasso drop takes the stroke on the first anchored line below the last while B is listed under a newer store list: B's list is marked", () => {
		// The cell above's setup and call with no corrections handed in. A drop re-takes each stroke from its own anchor (a
		// stroke without one is skipped), so here the stroke has one, as in the drop cell further up.
		type Retake = { retake(path: string, strokes: readonly InkStroke[], dys: readonly number[] | undefined, src: readonly InkStroke[]): void };
		const heldOf = (x: LineAnchors) => (x as unknown as { heldSrc: readonly InkStroke[] | null }).heldSrc;
		const path = "peer-marks-newer-list-drop.md";
		const p = twoPanes(path, [onLine("t", 2), onLine("f", 5), onLine("g", 12)], []);
		// The store gives the note a new array of the same strokes, as a persist swap does. B reads it; A reads nothing.
		const next = p.src.slice();
		p.b.tracks(path, next);
		const premise = {
			start: p.premise,
			b: shape(inner(p.b).anchored),
			bUnder: [inner(p.b).anchored?.src === next, heldOf(p.b) === next],
			aUnder: [inner(p.a).anchored?.src === p.src, heldOf(p.a) === p.src],
		};
		const info0 = JSON.stringify(premise);
		const list = { ids: ["t", "f", "g"], at: [0, 1, 2], top: "t", bottom: "g", stale: false };
		expect(premise, `premise: B's list built and current under the new array, t on the first line; A under the old one ${info0}`).toEqual({ start: { a: list, b: list }, b: list, bUnder: [true, true], aUnder: [true, true] });
		const t = p.src[0]!;
		// A drag 13 lines down in A: shown on line 15, below g.
		translateStroke(t, 0, 13 * LH);
		(p.a as unknown as Retake).retake(path, [t], undefined, next);
		const stale = inner(p.b).anchored?.stale ?? null;
		inner(p.b).anchoredIn(next);
		const r = { stale, next: shape(inner(p.b).anchored), build: rebuilt(p.b, next) };
		const info = JSON.stringify({ t: anchorLine(t), ...r });
		expect(anchorLine(t), `premise: the drop anchored t again on line 15 ${info}`).toBe(15);
		expect(r.build, `premise: a build names f first and t last ${info}`).toEqual({ ids: ["t", "f", "g"], at: [0, 1, 2], top: "f", bottom: "t", stale: false });
		expect(r.stale, `B's list after A's drop ${info}`).toBe(true);
		expect(r.next, `B's next read, as a build; it holds without the mark too, because the drag moves the ink revision ${info}`).toEqual(r.build);
	});

	it("A's attach step takes a stroke at a new correction while B, listed under a newer store list, holds the correction it read for it: B then reads A's correction, as a pane listed with A does", () => {
		// The bare surfaces have no groups, so the stroke is free in both panes and each reads it from its own anchor and memo.
		type Retake = { retake(path: string, strokes: readonly InkStroke[], dys: readonly number[] | undefined, src: readonly InkStroke[]): void };
		const heldOf = (x: LineAnchors) => (x as unknown as { heldSrc: readonly InkStroke[] | null }).heldSrc;
		const D = 12;
		const out: Record<string, unknown> = {};
		for (const arm of ["with", "newer"] as const) {
			const path = `peer-marks-saved-dy-${arm}.md`;
			const p = twoPanes(path, [onLine("f", 2), onLine("o", 8), onLine("h", 14)], []);
			const o = p.src[1]!;
			// "newer": the store gives the note a new array of the same strokes, as a persist swap does; B reads it, A reads
			// nothing. "with": B stays listed with A.
			const handed = arm === "newer" ? p.src.slice() : p.src;
			if (arm === "newer") p.b.tracks(path, handed);
			const under = { a: heldOf(p.a) === p.src, b: heldOf(p.b) === handed };
			// B reads o's correction, as its paint does, before A's step.
			const saved = p.b.dyOf(o);
			// A's attach step on o at correction D, handed the store list as it is now. Then B's next read, before any layout update.
			(p.a as unknown as Retake).retake(path, [o], [D], handed);
			out[arm] = { under, saved, line: anchorLine(o), a: p.a.dyOf(o), b: p.b.dyOf(o) };
		}
		const info = JSON.stringify(out);
		type Arm = { under: { a: boolean; b: boolean }; saved: number; line: number | null; a: number; b: number };
		const withA = out.with as Arm, newer = out.newer as Arm;
		expect([withA.under, newer.under, withA.saved, newer.saved], `premise: A under the old array in both, B under the array handed in, and B read o at 0 before the step ${info}`).toEqual([{ a: true, b: true }, { a: true, b: true }, 0, 0]);
		expect([withA.line, newer.line, withA.a, newer.a], `premise: A's step kept o on line 8 and A reads the correction given ${info}`).toEqual([8, 8, D, D]);
		expect(withA.b, `premise: B listed with A reads A's correction ${info}`).toBe(D);
		expect(newer.b, `B's correction for o after A's step, listed under the newer array ${info}`).toBe(D);
	});
});
