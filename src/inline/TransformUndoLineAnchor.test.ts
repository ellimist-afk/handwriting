/**
 * TF-10: the undo of a lasso resize or rotate after a line was typed above its ink, with two panes on one note.
 *
 * The lift (liftTransform) rewrites the store in place and re-takes each stroke's line anchor; its history step keeps the
 * before and after shapes, line anchor included. A line break typed above in the other pane moves the live anchor one line
 * down with the words (LineAnchors.docChanged) and moves no ink. The undo (applyInkOp, case "transform") rewrites the stroke
 * from the step's before copy and re-takes the anchor. Here the store, both panes' LineAnchors and the calls are the ones
 * production makes, in its order; the overlays around them are left out.
 *
 * The cell compares the undone stroke with a twin: the same stroke at the same place, anchored the same way, never
 * transformed. Whatever a line break above does to anchored ink, the undo must leave the stroke where its twin shows.
 * The control runs the same sequence with a lasso move and its undo (case "move"). A third cell resizes about the bbox
 * bottom, so the stroke's top moves by more than the anchor's y slack: the lift must give the anchor the shape's y, or the
 * anchor stops matching its stroke and the resized ink loses its line's correction at the lift.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { InlineInkStore } from "./InlineInkStore";
import { invertInkOp, type InkOp } from "./InkHistory";
import { transformEdits } from "./LassoTransform";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const PATH = "transform-undo.md";

function layoutOf(doc: Text, heights: number[]): LineLayout {
	const tops = [0];
	for (const h of heights) tops.push(tops.at(-1)! + h);
	return { lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => tops[n - 1]!, pxPerWorld: 1 };
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

const lines = (n: number) => Text.of(Array.from({ length: n }, (_, i) => `line ${i + 1} words`));

type Turn = { scale: number; angle: number; at: "top" | "bottom" };

function run(kind: "transform" | "move", turn: Turn = { scale: 1.5, angle: 0.3, at: "top" }) {
	const cur = { doc: lines(30), heights: Array.from({ length: 30 }, () => 40) };
	let layout = layoutOf(cur.doc, cur.heights);
	let focus = 0;
	const [a, b] = [0, 1].map((i) => {
		const p = new LineAnchors(() => layout, () => focus === i);
		p.setSignature(SIG);
		return p;
	}) as [LineAnchors, LineAnchors];
	const store = new InlineInkStore();
	const src = store.record(PATH).strokes;
	// Two strokes on line 6 (top 200), the same shape at the same place, both drawn and anchored in pane A.
	const s = strokeAt("s", 10, 205), twin = strokeAt("twin", 10, 205);
	src.push(s, twin);
	for (const k of [s, twin]) a.anchorNew(PATH, k);
	for (const p of [a, b]) {
		p.tracks(PATH, src);
		p.drawn(1, cur.doc.lines);
	}
	const measure = (): void => {
		layout = layoutOf(cur.doc, cur.heights);
		for (const p of [a, b]) {
			p.drawn(1, cur.doc.lines, true, true);
			p.layoutChanged(PATH, src, "measure");
		}
	};
	// Line 1 measured 6 shorter than guessed: anchored ink shows 6 up, with its line, so an anchor that stops being honoured
	// shows the stroke somewhere else.
	cur.heights = cur.heights.map((x, i) => (i === 0 ? 34 : x));
	measure();
	const shown = (k: InkStroke) => k.bbox.y + a.dyOf(k);
	const start = { s: shown(s), twin: shown(twin), dy: a.dyOf(s), top: s.bbox.y };

	// The lift in pane A, as liftTransform or the drop: the store changed in place, the anchors re-taken, one history step.
	let op: InkOp;
	if (kind === "transform") {
		const pivotY = turn.at === "top" ? s.bbox.y : s.bbox.y + s.bbox.height;
		const t = { pivot: { x: s.bbox.x, y: pivotY }, scale: turn.scale, angle: turn.angle };
		const edits = transformEdits(src, ["s"], t, (k) => a.dyOf(k), () => 0);
		store.rewriteStrokes(PATH, edits.strokeIds.map((id, i) => ({ id, shape: edits.after[i]! })));
		a.retake(PATH, [s], undefined, src);
		op = { type: "transform", path: PATH, strokeIds: edits.strokeIds, before: edits.before, after: edits.after } as InkOp;
	} else {
		const from = [{ ...s.points[0]! }];
		store.moveStrokes(PATH, ["s"], 30, 50);
		a.retake(PATH, [s], undefined, src);
		op = { type: "move", path: PATH, strokeIds: ["s"], dx: 30, dy: 50, from } as InkOp;
	}
	measure();
	const lifted = { top: s.bbox.y, dy: a.dyOf(s), twinDy: a.dyOf(twin) };

	// A line break typed above in pane B, the writer: heard by B first, then by A; then the measure.
	focus = 1;
	const prev = cur.doc, changes = ChangeSet.of({ from: prev.line(1).to, insert: "\n" }, prev.length), next = changes.apply(prev);
	cur.doc = next;
	cur.heights = [34, 40, ...cur.heights.slice(1)];
	layout = layoutOf(next, cur.heights);
	for (const p of [b, a]) {
		p.docChanged(PATH, src, prev, changes, next);
		p.drawn(p.changedLines.from, p.changedLines.to, false);
	}
	measure();
	const typed = { twin: shown(twin) };

	// The undo in pane A, as applyInkOp: this direction's shapes (or offsets) applied, the anchors re-taken; then a measure.
	focus = 0;
	const inv = invertInkOp(op);
	if (inv.type === "transform") store.rewriteStrokes(PATH, inv.strokeIds.map((id, i) => ({ id, shape: inv.after[i]! })));
	else if (inv.type === "move") store.moveStrokes(PATH, inv.strokeIds, inv.dx, inv.dy);
	a.retake(PATH, [s], undefined, src);
	measure();
	const undone = { s: shown(s), twin: shown(twin), points: s.points.map((p) => ({ x: p.x, y: p.y })), twinPoints: twin.points.map((p) => ({ x: p.x, y: p.y })) };
	const anchors = { s: s.lineAnchor, twin: twin.lineAnchor };
	for (const p of [a, b]) p.detached();
	return { start, lifted, typed, undone, anchors };
}

describe("an undo of a lasso step after a line typed above, two panes", () => {
	it("control: a move's undo leaves the stroke where its untouched twin shows", () => {
		const r = run("move");
		expect(r.start.s, "premise: the twins start at one place").toBe(r.start.twin);
		expect(r.start.dy, "premise: the line correction shows").toBe(-6);
		expect(r.undone.points, "premise: the undo put the points back").toEqual(r.undone.twinPoints);
		expect(r.undone.s, "the undone move shows off its twin").toBe(r.undone.twin);
	});

	it("a resize-and-rotate's undo leaves the stroke where its untouched twin shows", () => {
		const r = run("transform");
		expect(r.start.s, "premise: the twins start at one place").toBe(r.start.twin);
		expect(r.undone.points, "premise: the undo put the points back").toEqual(r.undone.twinPoints);
		expect(r.undone.s, `the undone transform shows off its twin (twin after typing ${r.typed.twin}; anchors ${JSON.stringify(r.anchors)})`).toBe(r.undone.twin);
	});

	it("a resize that moves the stroke's top past the anchor's slack keeps its line's correction at the lift, and its undo shows where its twin does", () => {
		const r = run("transform", { scale: 2, angle: 0, at: "bottom" });
		expect(r.start.s, "premise: the twins start at one place").toBe(r.start.twin);
		expect(Math.abs(r.lifted.top - r.start.top), "premise: the resize moved the top past the slack").toBeGreaterThan(0.5);
		expect(r.lifted.dy, `the lifted resize lost its line's correction (twin's ${r.lifted.twinDy})`).toBe(r.lifted.twinDy);
		expect(r.undone.points, "premise: the undo put the points back").toEqual(r.undone.twinPoints);
		expect(r.undone.s, `the undone resize shows off its twin (twin after typing ${r.typed.twin}; anchors ${JSON.stringify(r.anchors)})`).toBe(r.undone.twin);
	});
});
