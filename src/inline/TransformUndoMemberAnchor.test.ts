/**
 * The undo and redo of a lasso resize or rotate on attached ink whose members carried no line anchor when the step was
 * taken (a file an older build saved without member anchors, or a member whose anchor a typed line above took away), and
 * that were anchored since (the quiet pass, anchorMeasured). The step's before and after copies hold no anchor. The store's
 * in-place rewrite (rewriteStrokes) puts each copy's shape back; a member's anchor is what a read-only view (Reading view,
 * an embed, Export to PDF) draws it by, so the anchor the member holds now must stay, its y following the shape, as it
 * does for a copy that carries one. Free ink keeps its rule: a stroke with no anchor before comes back with none
 * (LassoTransform.test.ts "the store's in-place rewrite").
 *
 * One store and the calls applyInkOp makes for a transform step (case "transform"); no editor, no DOM.
 */
import { describe, expect, it } from "vitest";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { InlineInkStore } from "./InlineInkStore";
import { targetAt, type AttachmentRecord } from "./InkAttachments";
import { shapeOf, transformedShape, type StrokeShape } from "./LassoTransform";

const PATH = "transform-undo-member-anchor.md";
const DOC = "line one words\nline two words\nline three words\n";

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i * 8 }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

function group(id: string, strokeIds: string[]): AttachmentRecord {
	const from = DOC.indexOf("line two");
	return {
		v: 1, id, strokeIds, target: targetAt(DOC, from, from + 14, "paragraph"), ref: { x: 0, y: 40 },
		layout: { width: 892, font: 26 }, probe: { id: strokeIds[0]!, x: 10, y: 45 },
	};
}

/**
 * The anchor the quiet pass gives a member: on line 2, its top that line's top less the group's dy, y a quarter pixel under the
 * stroke's top (inside the anchor's y slack, so still a held anchor). The offset makes a kept y that never follows the shape
 * show in both cells: after a redo the shape's top is the one the anchor was taken at.
 */
const anchorFor = (s: InkStroke) => ({ line: 2, top: 40 - 12, y: s.bbox.y + 0.25, key: 77, width: 892, fontPx: 26, above: 5 });

/**
 * Two members of one group and one free stroke, none anchored. A lasso resize and rotate of all three is lifted
 * (rewriteStrokes with the after copies; the copies hold no anchor). Then each stroke is anchored, as the quiet pass does.
 * Then `steps`: "undo" puts the before copies back, "undo-redo" puts the after copies back after it.
 */
function run(steps: "undo" | "undo-redo") {
	const store = new InlineInkStore();
	const src = store.record(PATH).strokes;
	const m1 = strokeAt("m1", 10, 45), m2 = strokeAt("m2", 40, 47), f = strokeAt("f", 200, 45);
	src.push(m1, m2, f);
	store.setAttachments(PATH, [group("g", ["m1", "m2"])], false);
	const all = [m1, m2, f];
	const before: StrokeShape[] = all.map(shapeOf);
	const t = { pivot: { x: 10, y: 45 }, scale: 1.5, angle: 0.3 };
	const after: StrokeShape[] = all.map((s) => transformedShape(s, t, 0));
	const premise = { beforeAnchors: before.map((b) => !!b.lineAnchor), afterAnchors: after.map((a) => !!a.lineAnchor) };
	store.rewriteStrokes(PATH, all.map((s, i) => ({ id: s.id, shape: after[i]! })));
	for (const s of all) s.lineAnchor = anchorFor(s);
	const live = all.map((s) => ({ ...s.lineAnchor! }));
	store.rewriteStrokes(PATH, all.map((s, i) => ({ id: s.id, shape: before[i]! })));
	if (steps === "undo-redo") store.rewriteStrokes(PATH, all.map((s, i) => ({ id: s.id, shape: after[i]! })));
	const now = all.map((s) => (s.lineAnchor ? { ...s.lineAnchor } : null));
	const tops = all.map((s) => s.bbox.y);
	return { premise, live, now, tops };
}

describe("a lasso resize's undo and redo keep an attached member's line anchor", () => {
	for (const steps of ["undo", "undo-redo"] as const) {
		it(`${steps}: each member keeps the anchor it holds now, its y the shape's top; the free stroke comes back with none`, () => {
			const r = run(steps);
			const info = JSON.stringify(r);
			expect(r.premise, `premise: neither copy holds an anchor ${info}`).toEqual({ beforeAnchors: [false, false, false], afterAnchors: [false, false, false] });
			const why = r.now.slice(0, 2).map((a, i) => (a === null ? `m${i + 1} absent` : `m${i + 1} kept`));
			expect(why, `the members' anchors after the ${steps} ${info}`).toEqual(["m1 kept", "m2 kept"]);
			for (const i of [0, 1]) expect(r.now[i], `m${i + 1}: the live anchor, y the shape's top ${info}`).toEqual({ ...r.live[i]!, y: r.tops[i] });
			expect(r.now[2], `control: the free stroke comes back with no anchor, as before ${info}`).toBeNull();
		});
	}
});
