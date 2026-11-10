/**
 * The math of the lasso's resize and rotate on the note surface, before any
 * hook reaches it.
 *
 * Four corner handles scale uniformly about the opposite corner of the ink
 * box (not the opposite handle, which sits out at the box's pad); one knob
 * turns the ink about the box centre; Shift on a mouse snaps the turn to 15
 * degrees. A step that would put the box past the top or left wall is refused
 * and the last accepted step stays. The lift rewrites each stroke from the
 * same numbers the preview drew with: points about the pivot, the width by
 * the scale, the bbox from the new points, and the line anchor's y moved with
 * the bbox so the drop's retake finds it matching. Points are rewritten in the
 * place the note shows them (the page position plus the line's correction)
 * and the correction is taken back off after, so the ink lands where the
 * preview showed it. The in-place store method keeps every stroke object and
 * id, marks the ids local and bumps the note's generation.
 */
import { describe, expect, it } from "vitest";
import { shapedHalfWidths } from "../ink/InkShape";
import { EXP7_PEN } from "../ink/PenStyle";
import { computeBBox, InkStroke } from "../ink/Stroke";
import { strokeRev } from "../ink/StrokeRev";
import { InlineInkStore } from "./InlineInkStore";
import {
	beginTransform,
	drawTransformHandles,
	framePoints,
	HANDLE_DRAW_PX,
	handleInput,
	HANDLE_POINTER_PX,
	HANDLE_TOUCH_PX,
	handlePoints,
	handlesShown,
	hitTransformHandle,
	MIN_TRANSFORM_SCALE,
	pictureMatrix,
	previewMatrix,
	ROTATE_SNAP,
	shapeOf,
	stepTransform,
	transformedBox,
	transformedShape,
	transformEdits,
	transformPoint,
} from "./LassoTransform";

function stroke(id: string, pts: Array<[number, number]>, width = 2, extra: Partial<InkStroke> = {}): InkStroke {
	const points = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i * 8 }));
	return { id, tool: "pen", color: "#fff", width, points, bbox: computeBBox(points, width * 2), createdAt: 1, ...extra };
}

const BOX = { x: 100, y: 200, width: 80, height: 40 };

describe("handles", () => {
	it("show only for a selection of strokes alone", () => {
		expect(handlesShown({ strokes: 3, boxes: 0, images: 0 })).toBe(true);
		expect(handlesShown({ strokes: 3, boxes: 1, images: 0 })).toBe(false);
		expect(handlesShown({ strokes: 3, boxes: 0, images: 1 })).toBe(false);
		expect(handlesShown({ strokes: 0, boxes: 0, images: 0 })).toBe(false);
	});

	it("sit on the drawn box's corners, and the knob above its top centre, in screen px at any zoom", () => {
		for (const zoom of [0.5, 1, 2]) {
			const h = handlePoints(BOX, zoom);
			const pad = 6 / zoom;
			expect(h.nw).toEqual({ x: BOX.x - pad, y: BOX.y - pad });
			expect(h.se).toEqual({ x: BOX.x + BOX.width + pad, y: BOX.y + BOX.height + pad });
			expect(h.rotate.x).toBeCloseTo(BOX.x + BOX.width / 2, 9);
			expect(h.rotate.y).toBeLessThan(h.nw.y);
		}
	});

	it("take a finger 44 css px square and a pen or mouse 12 px", () => {
		expect(HANDLE_TOUCH_PX).toBe(44);
		expect(HANDLE_POINTER_PX).toBe(12);
		const zoom = 2;
		const se = handlePoints(BOX, zoom).se;
		const finger = (HANDLE_TOUCH_PX / 2 - 1) / zoom;
		const pen = (HANDLE_POINTER_PX / 2 - 1) / zoom;
		expect(hitTransformHandle(BOX, zoom, { x: se.x + finger, y: se.y + finger }, "touch")).toBe("se");
		expect(hitTransformHandle(BOX, zoom, { x: se.x + finger, y: se.y + finger }, "pen")).toBeNull();
		expect(hitTransformHandle(BOX, zoom, { x: se.x + pen, y: se.y - pen }, "mouse")).toBe("se");
		const knob = handlePoints(BOX, zoom).rotate;
		expect(hitTransformHandle(BOX, zoom, knob, "pen")).toBe("rotate");
		expect(hitTransformHandle(BOX, zoom, { x: BOX.x + 40, y: BOX.y + 20 }, "pen")).toBeNull();
	});

	it("on a small box a finger gets the nearest handle whose square holds it, not the first in the list", () => {
		// Defect: the squares overlap on a small box and the first in list order wins, so a finger on the se corner grabs
		// nw and the box grows the wrong way.
		const small = { x: 0, y: 0, width: 8, height: 8 };
		expect(handlePoints(small, 1).se).toEqual({ x: 14, y: 14 });
		expect(hitTransformHandle(small, 1, { x: 14, y: 14 }, "touch")).toBe("se");
		expect(hitTransformHandle(small, 1, { x: -6, y: 14 }, "touch")).toBe("sw");
		expect(hitTransformHandle(small, 1, { x: 14, y: -6 }, "touch")).toBe("ne");
		expect(hitTransformHandle(small, 1, { x: -6, y: -6 }, "touch")).toBe("nw");
	});
});

describe("the gesture", () => {
	it("scales uniformly about the opposite corner of the ink box, not the opposite handle", () => {
		const h = handlePoints(BOX, 1);
		const g = beginTransform(BOX, "se", h.se, 1);
		const o = { x: BOX.x, y: BOX.y };
		expect(g.pivot).toEqual(o);
		const d = { x: h.se.x - o.x, y: h.se.y - o.y };
		const t = stepTransform(g, { x: o.x + d.x * 1.5, y: o.y + d.y * 1.5 }, { shift: false, input: "pen" });
		expect(t.scale).toBeCloseTo(1.5, 12);
		expect(t.angle).toBe(0);
		// A pull off the diagonal scales by its projection on it: one factor, no stretch.
		const off = stepTransform(g, { x: o.x + d.x * 2, y: o.y + d.y }, { shift: false, input: "pen" });
		const proj = (d.x * d.x * 2 + d.y * d.y) / (d.x * d.x + d.y * d.y);
		expect(off.scale).toBeCloseTo(proj, 12);
	});

	// The user watches the far ink corner while pulling: it stays put. Pivoting on the opposite handle, 6 css px out at the
	// box's pad, crept that corner by 6 * (scale - 1) px: 2.3 px at 1.39, 12 px at 3.
	for (const handle of ["nw", "ne", "se", "sw"] as const) {
		it(`keeps the far ink-box corner where it was within 0.1 px on a ${handle} pull, at 1.39 and at 3`, () => {
			const s = stroke("a", [[1000, 1000], [1040, 1015], [1080, 1040]], 3);
			const box = s.bbox;
			const far = (b: typeof box) => ({
				x: handle === "nw" || handle === "sw" ? b.x + b.width : b.x,
				y: handle === "nw" || handle === "ne" ? b.y + b.height : b.y,
			});
			for (const k of [1.39, 3]) {
				const h = handlePoints(box, 1);
				const g = beginTransform(box, handle, h[handle], 1);
				const at = { x: g.pivot.x + (h[handle].x - g.pivot.x) * k, y: g.pivot.y + (h[handle].y - g.pivot.y) * k };
				const t = stepTransform(g, at, { shift: false, input: "pen" });
				expect(t.scale, "premise: the pull scales by k").toBeCloseTo(k, 9);
				const after = transformedShape(s, t, 0).bbox;
				const was = far(box), now = far(after);
				expect(Math.abs(now.x - was.x), `far corner x at ${k}`).toBeLessThanOrEqual(0.1);
				expect(Math.abs(now.y - was.y), `far corner y at ${k}`).toBeLessThanOrEqual(0.1);
			}
		});
	}

	it("never scales below the floor or through the pivot", () => {
		const h = handlePoints(BOX, 1);
		const g = beginTransform(BOX, "se", h.se, 1);
		const t = stepTransform(g, { x: h.nw.x - 50, y: h.nw.y - 50 }, { shift: false, input: "pen" });
		expect(t.scale).toBe(MIN_TRANSFORM_SCALE);
	});

	it("turns about the box centre, and snaps to 15 degrees only for Shift on a mouse", () => {
		const h = handlePoints(BOX, 1);
		const c = { x: BOX.x + BOX.width / 2, y: BOX.y + BOX.height / 2 };
		const g = beginTransform(BOX, "rotate", h.rotate, 1);
		expect(g.pivot).toEqual(c);
		const r = Math.hypot(h.rotate.x - c.x, h.rotate.y - c.y);
		const a0 = Math.atan2(h.rotate.y - c.y, h.rotate.x - c.x);
		const at = (deg: number) => ({ x: c.x + r * Math.cos(a0 + (deg * Math.PI) / 180), y: c.y + r * Math.sin(a0 + (deg * Math.PI) / 180) });
		expect(stepTransform(g, at(22), { shift: false, input: "mouse" }).angle).toBeCloseTo((22 * Math.PI) / 180, 12);
		expect(stepTransform(g, at(22), { shift: true, input: "mouse" }).angle).toBeCloseTo((15 * Math.PI) / 180, 12);
		expect(stepTransform(g, at(22), { shift: true, input: "pen" }).angle).toBeCloseTo((22 * Math.PI) / 180, 12);
		expect(ROTATE_SNAP).toBeCloseTo(Math.PI / 12, 15);
		expect(stepTransform(g, at(22), { shift: false, input: "pen" }).scale).toBe(1);
	});

	it("slides a step past the top or the left wall onto the wall, at the pen's own scale and angle", () => {
		const near = { x: 10, y: 6, width: 40, height: 20 };
		const h = handlePoints(near, 1);
		const g = beginTransform(near, "se", h.se, 1);
		const d = { x: h.se.x - g.pivot.x, y: h.se.y - g.pivot.y };
		// Scaling about the nw corner never moves it: allowed however far.
		const ok = stepTransform(g, { x: g.pivot.x + d.x * 3, y: g.pivot.y + d.y * 3 }, { shift: false, input: "pen" });
		expect(ok.scale).toBeCloseTo(3, 12);
		// Scaling about the se corner pushes nw up and left.
		const g2 = beginTransform(near, "nw", h.nw, 1);
		const d2 = { x: g2.pivot.x - h.nw.x, y: g2.pivot.y - h.nw.y };
		const small = stepTransform(g2, { x: g2.pivot.x - d2.x * 1.1, y: g2.pivot.y - d2.y * 1.1 }, { shift: false, input: "pen" });
		expect(small.scale).toBeCloseTo(1.1, 12);
		expect(transformedBox(near, small).y).toBeGreaterThanOrEqual(0);
		// Pulled past both walls: accepted at the pen's own scale, the box slid onto the top and the left wall exactly.
		const past = stepTransform(g2, { x: g2.pivot.x - d2.x * 4, y: g2.pivot.y - d2.y * 4 }, { shift: false, input: "pen" });
		expect(past.scale).toBeCloseTo(4, 12);
		expect(transformedBox(near, past).x).toBeCloseTo(0, 9);
		expect(transformedBox(near, past).y).toBeCloseTo(0, 9);
		expect(g2.accepted).toEqual(past);
		// A turn of a box hard by the left wall that would cross it: accepted at the pen's angle, slid onto the left wall.
		const left = { x: 2, y: 300, width: 10, height: 200 };
		const g3 = beginTransform(left, "rotate", handlePoints(left, 1).rotate, 1);
		const c = { x: 7, y: 400 };
		const turned = stepTransform(g3, { x: c.x + 100, y: c.y }, { shift: false, input: "pen" });
		expect(turned.angle).toBeCloseTo(Math.PI / 2, 12);
		expect(transformedBox(left, turned).x).toBeCloseTo(0, 9);
	});

	for (const wall of ["left", "top"] as const) {
		it(`slides a box that starts past the ${wall} wall back to where it started on a scale-up or a turn, and lets it shrink inside`, () => {
			// 8 world units past the wall at the grab.
			const out = wall === "left" ? { x: -8, y: 100, width: 40, height: 40 } : { x: 100, y: -8, width: 40, height: 40 };
			const past = (b: { x: number; y: number }) => (wall === "left" ? b.x : b.y);
			const h = handlePoints(out, 1);
			const pen = { shift: false, input: "pen" as const };
			const g = beginTransform(out, "nw", h.nw, 1);
			const d = { x: h.nw.x - g.pivot.x, y: h.nw.y - g.pivot.y };
			const at = (k: number) => ({ x: g.pivot.x + d.x * k, y: g.pivot.y + d.y * k });
			// A scale-up about the se corner would push the box further past: accepted at the pen's scale, slid back onto the
			// wall where the grab's box stood (8 past), never further out.
			const up = stepTransform(g, at(1.5), pen);
			expect(up.scale).toBeCloseTo(1.5, 12);
			expect(past(transformedBox(out, up))).toBeCloseTo(past(out), 9);
			// A small shrink moves the near edge inward but leaves it past the wall: no further out than the start, accepted.
			const inward = stepTransform(g, at(0.9), pen);
			expect(inward.scale).toBeCloseTo(0.9, 12);
			expect(past(transformedBox(out, inward))).toBeLessThan(0);
			expect(past(transformedBox(out, inward))).toBeGreaterThan(past(out));
			// A bigger one brings it back inside the wall: accepted.
			const shrink = stepTransform(g, at(0.5), pen);
			expect(shrink.scale).toBeCloseTo(0.5, 12);
			expect(past(transformedBox(out, shrink))).toBeGreaterThanOrEqual(0);
			// A scale-up from there that would end further past the wall than the start: accepted, slid back onto that wall.
			const again = stepTransform(g, at(1.5), pen);
			expect(again.scale).toBeCloseTo(1.5, 12);
			expect(past(transformedBox(out, again))).toBeCloseTo(past(out), 9);
			// Any turn lifts a corner further past the wall: accepted at the pen's angle, slid back onto that wall.
			const r = beginTransform(out, "rotate", h.rotate, 1);
			const c = r.pivot;
			const len = Math.hypot(h.rotate.x - c.x, h.rotate.y - c.y);
			const a0 = Math.atan2(h.rotate.y - c.y, h.rotate.x - c.x);
			for (const deg of [5, -5]) {
				const a = a0 + (deg * Math.PI) / 180;
				const turn = stepTransform(r, { x: c.x + len * Math.cos(a), y: c.y + len * Math.sin(a) }, pen);
				expect(turn.angle).toBeCloseTo((deg * Math.PI) / 180, 12);
				expect(past(transformedBox(out, turn))).toBeCloseTo(past(out), 9);
			}
		});
	}
});

describe("the lift", () => {
	// A pivot off the whole px, as a corner pulled at any zoom gives: a lift that rounds it lands somewhere else.
	const T = { pivot: { x: 100.37, y: 200.61 }, scale: 1.5, angle: Math.PI / 6 };

	it("moves each point by the preview's own matrix (pivot, scale, angle), within 0.1 px", () => {
		const m = previewMatrix(T);
		const s = stroke("a", [[120, 210], [150, 230], [170, 205]]);
		const out = transformedShape(s, T, 0);
		s.points.forEach((p, i) => {
			const want = { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
			expect(Math.abs(out.points[i]!.x - want.x)).toBeLessThan(0.1);
			expect(Math.abs(out.points[i]!.y - want.y)).toBeLessThan(0.1);
			const direct = transformPoint(p, T);
			expect(out.points[i]!.x).toBe(direct.x);
			expect(out.points[i]!.y).toBe(direct.y);
		});
		// The matrix itself: pivot fixed, a unit step turned and scaled.
		const pv = transformPoint(T.pivot, T);
		expect(pv.x).toBeCloseTo(T.pivot.x, 12);
		expect(pv.y).toBeCloseTo(T.pivot.y, 12);
		const one = transformPoint({ x: T.pivot.x + 1, y: T.pivot.y }, T);
		expect(one.x - T.pivot.x).toBeCloseTo(1.5 * Math.cos(Math.PI / 6), 12);
		expect(one.y - T.pivot.y).toBeCloseTo(1.5 * Math.sin(Math.PI / 6), 12);
	});

	it("scales the width with the ink and leaves it for a turn alone, highlighter too", () => {
		const pen = stroke("a", [[120, 210], [150, 230]], 2);
		const hl = stroke("b", [[120, 210], [150, 230]], 16, { tool: "highlighter" });
		expect(transformedShape(pen, { ...T, angle: 0 }, 0).width).toBe(3);
		expect(transformedShape(hl, { ...T, angle: 0 }, 0).width).toBe(24);
		expect(transformedShape(pen, { ...T, scale: 1 }, 0).width).toBe(2);
		expect(transformedShape(hl, { ...T, scale: 1 }, 0).width).toBe(16);
	});

	it("a resized pen stroke shapes as a scaled copy of itself: the speed thinning sees the speed it was drawn at", () => {
		// A pen stroke at 1.5 units per ms, width 2.2, pulled to three times its size. The points scale; were the times kept,
		// the shaped law would see three times the speed and land the stroke thinner than the preview's scaled picture.
		const points = Array.from({ length: 30 }, (_, i) => ({ x: 120 + i * 12, y: 210, pressure: 0.5, t: i * 8 }));
		const s: InkStroke = { id: "a", tool: "pen", color: "#fff", width: 2.2, points, bbox: computeBBox(points, 4.4), createdAt: 1 };
		const before = shapedHalfWidths(s.points, { ...EXP7_PEN, baseWidth: s.width });
		// Down to half too: the times are whole ms and the gaps 8 ms, so half of each is still a whole ms over the 1 ms floor.
		for (const scale of [3, 0.5]) {
			const out = transformedShape(s, { pivot: { x: 120, y: 210 }, scale, angle: 0 }, 0);
			const after = shapedHalfWidths(out.points, { ...EXP7_PEN, baseWidth: out.width });
			for (let i = 10; i < 20; i++) expect(Math.abs(after[i]! - scale * before[i]!), `scale ${scale}, sample ${i}`).toBeLessThan(0.02);
		}
	});

	it("takes the bbox from the new points and the new width, as every built stroke does", () => {
		const s = stroke("a", [[120, 210], [150, 230], [170, 205]], 2);
		const out = transformedShape(s, T, 0);
		expect(out.bbox).toEqual(computeBBox(out.points, out.width * 2));
	});

	it("rewrites in the shown place and lands where the preview showed it, under a line correction", () => {
		const dy = 37;
		const anchor = { line: 4, top: 80, y: 0, key: 1, width: 700, fontPx: 16 };
		const s = stroke("a", [[120, 210], [150, 230], [170, 205]], 2);
		s.lineAnchor = { ...anchor, y: s.bbox.y };
		const out = transformedShape(s, T, dy);
		s.points.forEach((p, i) => {
			const shown = transformPoint({ x: p.x, y: p.y + dy }, T);
			expect(out.points[i]!.x + 0).toBeCloseTo(shown.x, 9);
			expect(out.points[i]!.y + dy).toBeCloseTo(shown.y, 9);
		});
		// The anchor still names the stroke: its y moved with the bbox, its line and top kept for the retake to judge.
		expect(out.lineAnchor).toEqual({ ...anchor, y: out.bbox.y });
		// An anchor that had stopped matching its stroke stops matching the transformed stroke by the same amount.
		const broken = stroke("b", [[120, 210], [150, 230], [170, 205]], 2);
		broken.lineAnchor = { ...anchor, y: broken.bbox.y + 3.25 };
		const outB = transformedShape(broken, T, dy);
		expect(outB.lineAnchor!.y - outB.bbox.y).toBeCloseTo(3.25, 9);
	});

	it("keeps each point's pressure and tilt, scales its time with the ink, and copies rather than aliases", () => {
		const s = stroke("a", [[120, 210], [150, 230]]);
		s.points[0]!.tiltX = 12;
		s.points[1]!.pressure = 0.9;
		const out = transformedShape(s, T, 0);
		expect(out.points.map((p) => [p.pressure, p.t, p.tiltX])).toEqual([[0.5, 0, 12], [0.9, 12, undefined]]);
		expect(transformedShape(s, { ...T, scale: 1 }, 0).points.map((p) => p.t), "a turn alone keeps the times").toEqual([0, 8]);
		expect(out.points[0]).not.toBe(s.points[0]);
		expect(s.points[0]!.x).toBe(120);
	});

	it("a shape copy is deep: later edits of the stroke leave it alone", () => {
		const s = stroke("a", [[120, 210], [150, 230]]);
		s.lineAnchor = { line: 1, top: 0, y: s.bbox.y, key: 0, width: 700, fontPx: 16 };
		const before = shapeOf(s);
		const json = JSON.stringify(before);
		s.points[0]!.x = 999;
		s.bbox.x = 999;
		s.lineAnchor.y = 999;
		expect(JSON.stringify(before)).toBe(json);
	});
});

describe("the store's in-place rewrite", () => {
	function storeWith(strokes: InkStroke[]) {
		const store = new InlineInkStore();
		const rec = store.record("n.md");
		rec.strokes.push(...strokes);
		return { store, rec };
	}

	it("rewrites only the listed strokes, keeps every object and id, marks them local and bumps the generation", () => {
		const a = stroke("a", [[120, 210], [150, 230]]);
		const b = stroke("b", [[300, 300], [320, 330]]);
		const { store, rec } = storeWith([a, b]);
		const bJson = JSON.stringify(b);
		const gen = store.generation("n.md");
		const revA = strokeRev(a);
		const T = { pivot: { x: 100, y: 200 }, scale: 2, angle: 0.3 };
		const after = transformedShape(a, T, 0);
		store.rewriteStrokes("n.md", [{ id: "a", shape: after }, { id: "gone", shape: after }]);
		expect(rec.strokes[0]).toBe(a);
		expect(a.id).toBe("a");
		expect(JSON.stringify({ points: a.points, width: a.width, bbox: a.bbox })).toBe(
			JSON.stringify({ points: after.points, width: after.width, bbox: after.bbox })
		);
		expect(a.points).not.toBe(after.points);
		expect(a.bbox).not.toBe(after.bbox);
		expect(JSON.stringify(b)).toBe(bJson);
		expect(rec.localStrokeIds.has("a")).toBe(true);
		expect(rec.localStrokeIds.has("b")).toBe(false);
		expect(store.generation("n.md")).toBe(gen + 1);
		expect(strokeRev(a)).not.toBe(revA);
	});

	it("puts a stroke back byte-equal from its before copy (undo), and forward from its after copy (redo)", () => {
		const a = stroke("a", [[120.123456789, 210.987654321], [150, 230], [171.5, 204.25]]);
		a.lineAnchor = { line: 2, top: 40, y: a.bbox.y, key: 9, width: 700, fontPx: 16, above: 3 };
		const { store } = storeWith([a]);
		const start = JSON.stringify(a);
		const before = shapeOf(a);
		const T = { pivot: { x: 101.3, y: 199.7 }, scale: 1.37, angle: 0.7 };
		const after = transformedShape(a, T, 12.5);
		store.rewriteStrokes("n.md", [{ id: "a", shape: after }]);
		const lifted = JSON.stringify(a);
		expect(a.lineAnchor).not.toBe(after.lineAnchor);
		store.rewriteStrokes("n.md", [{ id: "a", shape: before }]);
		expect(JSON.stringify(a)).toBe(start);
		store.rewriteStrokes("n.md", [{ id: "a", shape: after }]);
		expect(JSON.stringify(a)).toBe(lifted);
	});

	it("a stroke with no anchor before comes back with none, though the drop's retake gave it one after", () => {
		const a = stroke("a", [[120, 210], [150, 230]]);
		const { store } = storeWith([a]);
		const start = JSON.stringify(a);
		const before = shapeOf(a);
		store.rewriteStrokes("n.md", [{ id: "a", shape: transformedShape(a, { pivot: { x: 0, y: 0 }, scale: 2, angle: 0 }, 0) }]);
		a.lineAnchor = { line: 3, top: 60, y: a.bbox.y, key: 5, width: 700, fontPx: 16 };
		store.rewriteStrokes("n.md", [{ id: "a", shape: before }]);
		expect("lineAnchor" in a).toBe(false);
		expect(JSON.stringify(a)).toBe(start);
	});
});

describe("the preview's picture", () => {
	const T = { pivot: { x: 103.37, y: 211.61 }, scale: 1.3, angle: -0.4 };

	it("draws each picture pixel where the lift puts the world point under it, at any camera", () => {
		for (const cam of [{ x: 0, y: 0, zoom: 1 }, { x: 37.5, y: 140.25, zoom: 2.5 }, { x: -3, y: 9, zoom: 0.4 }]) {
			for (const backing of [1, 2]) {
				const k = cam.zoom * backing;
				const m = pictureMatrix(T, cam, k);
				for (const p of [{ x: 120, y: 210 }, { x: 150.5, y: 230.25 }, T.pivot]) {
					const q = { x: (p.x - cam.x) * k, y: (p.y - cam.y) * k };
					const drawn = { x: m[0] * q.x + m[2] * q.y + m[4], y: m[1] * q.x + m[3] * q.y + m[5] };
					const lifted = transformPoint(p, T);
					expect(Math.abs(drawn.x / k + cam.x - lifted.x)).toBeLessThan(1e-9);
					expect(Math.abs(drawn.y / k + cam.y - lifted.y)).toBeLessThan(1e-9);
				}
			}
		}
	});
});

describe("the handles drawn", () => {
	function recorder() {
		const rects: number[][] = [];
		const arcs: number[][] = [];
		const lines: number[][] = [];
		const ctx = {
			fillStyle: "" as string, strokeStyle: "" as string, lineWidth: 0, dash: [9] as number[], depth: 0,
			save() { this.depth++; }, restore() { this.depth--; }, beginPath() {}, fill() {}, stroke() {},
			moveTo(x: number, y: number) { lines.push([x, y]); }, lineTo(x: number, y: number) { lines.push([x, y]); },
			arc(x: number, y: number, r: number) { arcs.push([x, y, r]); },
			rect(x: number, y: number, w: number, h: number) { rects.push([x, y, w, h]); },
			setLineDash(d: number[]) { this.dash = d; },
		};
		return { ctx, rects, arcs, lines };
	}

	it("puts each corner square and the knob on its handle's centre in css px, solid, and leaves the context as found", () => {
		const cam = { x: 40, y: 150, zoom: 2 };
		const { ctx, rects, arcs, lines } = recorder();
		drawTransformHandles(ctx, BOX, cam, "#7f9cf5");
		const h = handlePoints(BOX, cam.zoom);
		const screen = (p: { x: number; y: number }) => [(p.x - cam.x) * cam.zoom, (p.y - cam.y) * cam.zoom];
		expect(rects).toEqual((["nw", "ne", "se", "sw"] as const).map((id) => {
			const [x, y] = screen(h[id]);
			return [x! - HANDLE_DRAW_PX / 2, y! - HANDLE_DRAW_PX / 2, HANDLE_DRAW_PX, HANDLE_DRAW_PX];
		}));
		expect(arcs).toEqual([[...screen(h.rotate), HANDLE_DRAW_PX / 2]]);
		expect(lines).toEqual([[screen(h.rotate)[0], screen(h.nw)[1]], screen(h.rotate)]);
		expect(ctx.dash).toEqual([]);
		expect(ctx.fillStyle).toBe("#7f9cf5");
		expect(ctx.depth).toBe(0);
		expect(HANDLE_DRAW_PX).toBeLessThan(12);
	});

	it("at a canvas zoom of 0.5 the squares are 8 screen px across and the knob 24 screen px over the box, on the box's corners", () => {
		// Defect: drawn in tail px at the camera's zoom alone, the canvas zoom shrinks them on screen: 4 px squares at 0.5.
		// The tail frame is css-scaled by the canvas zoom, so 8 screen px is 16 tail px here.
		const cam = { x: 40, y: 150, zoom: 1 }, cssScale = 0.5;
		const { ctx, rects, arcs } = recorder();
		(drawTransformHandles as (...a: unknown[]) => void)(ctx, BOX, cam, "#7f9cf5", cssScale);
		const h = handlePoints(BOX, cam.zoom);
		const screen = (p: { x: number; y: number }) => [(p.x - cam.x) * cam.zoom, (p.y - cam.y) * cam.zoom];
		const side = HANDLE_DRAW_PX / cssScale;
		expect(rects, "corner squares, tail px").toEqual((["nw", "ne", "se", "sw"] as const).map((id) => {
			const [x, y] = screen(h[id]);
			return [x! - side / 2, y! - side / 2, side, side];
		}));
		expect(arcs[0]![2], "knob radius, tail px").toBe(side / 2);
		expect(screen(h.nw)[1]! - arcs[0]![1]!, "knob over the box's top, tail px").toBeCloseTo(24 / cssScale, 9);
	});
});

describe("the lift's edits", () => {
	it("name the listed strokes still there, in the store's order, each with its shape before and under the step", () => {
		const a = stroke("a", [[120, 210], [150, 230]]);
		const b = stroke("b", [[300, 300], [320, 330]]);
		const c = stroke("c", [[10, 10], [20, 20]]);
		const T = { pivot: { x: 100.5, y: 200.5 }, scale: 1.25, angle: 0.2 };
		const dy = new Map([["a", 4], ["c", 0], ["b", -7]]);
		const e = transformEdits([a, b, c], ["c", "a", "gone"], T, (s) => dy.get(s.id)!);
		expect(e.strokeIds).toEqual(["a", "c"]);
		expect(e.before).toEqual([shapeOf(a), shapeOf(c)]);
		expect(e.after).toEqual([transformedShape(a, T, 4), transformedShape(c, T, 0)]);
		expect(e.before[0]!.points).not.toBe(a.points);
	});
});

describe("the input", () => {
	it("is a finger for touch, a mouse for a mouse, and a pen for anything else", () => {
		expect(handleInput("touch")).toBe("touch");
		expect(handleInput("mouse")).toBe("mouse");
		expect(handleInput("pen")).toBe("pen");
		expect(handleInput("")).toBe("pen");
	});
});

describe("the Attach button", () => {
	// Imported apart so the cells above still load at a base without the button.
	const T = () => import("./LassoTransform") as Promise<Record<string, unknown>>;

	it("centred under the drawn box's bottom, 12 css px clear, 28 across, at any zoom", async () => {
		// Defect: the button sits on the box, off its centre, or in world units, so a zoom moves it into the ink.
		const t = await T();
		const point = t["attachButtonPoint"] as (b: typeof BOX, z: number) => { x: number; y: number };
		expect(t["ATTACH_BUTTON_DRAW_PX"]).toBe(28);
		expect(t["ATTACH_BUTTON_GAP_PX"]).toBe(12);
		for (const zoom of [0.5, 1, 2]) {
			const p = point(BOX, zoom);
			expect(p.x).toBeCloseTo(BOX.x + BOX.width / 2, 9);
			// The drawn box's bottom is 6 css px below the ink; the button's top 12 below that; its centre 14 more.
			const boxBottomPx = (BOX.y + BOX.height) * zoom + 6;
			expect(p.y * zoom - 14 - boxBottomPx, `zoom ${zoom}`).toBeCloseTo(12, 9);
		}
	});

	it("takes a finger 44 css px square and a pen or a mouse 28, and nothing outside it", async () => {
		// Defect: a pen gets the finger's square, so a tap just under the box's corner opens the menu.
		const t = await T();
		const point = t["attachButtonPoint"] as (b: typeof BOX, z: number) => { x: number; y: number };
		const hit = t["hitAttachButton"] as (b: typeof BOX, z: number, at: { x: number; y: number }, input: string) => boolean;
		const zoom = 2, c = point(BOX, zoom);
		for (const [input, half] of [["touch", 22], ["pen", 14], ["mouse", 14]] as const) {
			expect(hit(BOX, zoom, { x: c.x + (half - 0.5) / zoom, y: c.y - (half - 0.5) / zoom }, input), `${input} inside`).toBe(true);
			expect(hit(BOX, zoom, { x: c.x + (half + 0.5) / zoom, y: c.y }, input), `${input} right`).toBe(false);
			expect(hit(BOX, zoom, { x: c.x, y: c.y - (half + 0.5) / zoom }, input), `${input} above`).toBe(false);
		}
	});

	it("the selection colour when attached, the muted text colour when loose, the mark in the page background", async () => {
		// Defect: the fill is always on, so a loose selection reads as attached.
		const t = await T();
		const draw = t["drawAttachButton"] as (ctx: unknown, b: typeof BOX, cam: { x: number; y: number; zoom: number }, attached: boolean, c: { attached: string; loose: string; background: string }) => void;
		const colours = { attached: "#7f9cf5", loose: "#999999", background: "#1e1e1e" };
		const run = (attached: boolean) => {
			const fills: string[] = [], strokes: string[] = [], arcs: number[][] = [];
			const ctx = {
				fillStyle: "", strokeStyle: "", lineWidth: 0, dash: [9] as number[], depth: 0,
				save() { this.depth++; }, restore() { this.depth--; }, beginPath() {}, moveTo() {}, lineTo() {}, rect() {},
				fill() { fills.push(this.fillStyle); }, stroke() { strokes.push(this.strokeStyle); },
				arc(x: number, y: number, r: number) { arcs.push([x, y, r]); },
				setLineDash(d: number[]) { this.dash = d; },
			};
			draw(ctx, BOX, { x: 40, y: 150, zoom: 2 }, attached, colours);
			expect(ctx.depth).toBe(0);
			expect(ctx.dash).toEqual([]);
			return { fills, strokes, arcs };
		};
		const on = run(true), off = run(false);
		expect(on.fills).toEqual([colours.attached]);
		expect(off.fills).toEqual([colours.loose]);
		expect(on.strokes).toEqual([colours.attached, colours.background, colours.background]);
		expect(off.strokes).toEqual([colours.loose, colours.background, colours.background]);
		// The circle at the button's centre, in the box's css px frame, 28 across less its line.
		const c = (t["attachButtonPoint"] as (b: typeof BOX, z: number) => { x: number; y: number })(BOX, 2);
		expect(on.arcs[0]![0]).toBeCloseTo((c.x - 40) * 2, 9);
		expect(on.arcs[0]![1]).toBeCloseTo((c.y - 150) * 2, 9);
		expect(on.arcs[0]![2]).toBe(13);
	});

	it("shows only when the selection can attach or detach, holds strokes, and no loop, drag, resize or turn is under way", async () => {
		// Defect: the button shows with nothing to offer, over a loop being drawn, or rides a drag where a tap would drop.
		const t = await T();
		const shown = t["attachButtonShown"] as (s: object) => boolean;
		const base = { attach: true, detach: false, kinds: { strokes: 2, boxes: 0, images: 0 }, lassoActive: false, moving: false };
		expect(shown(base)).toBe(true);
		expect(shown({ ...base, attach: false, detach: true })).toBe(true);
		expect(shown({ ...base, attach: false }), "no chips").toBe(false);
		expect(shown({ ...base, lassoActive: true }), "lasso").toBe(false);
		expect(shown({ ...base, moving: true }), "drag, resize or turn").toBe(false);
		expect(shown({ ...base, kinds: { strokes: 0, boxes: 1, images: 1 } }), "boxes and images only").toBe(false);
	});
});

describe("the frame turns with the ink", () => {
	// Alan, 10-28: "is that really how the rotate knob works?" "it doesnt even move". The frame shown during a turn was the
	// axis-aligned box of the turned ink, so the knob sat still while the ink turned under the pen.
	const near = (a: { x: number; y: number }, b: { x: number; y: number }, eps = 1e-6) => Math.hypot(a.x - b.x, a.y - b.y) <= eps;

	it("at an eighth turn the knob is the grab's knob turned with the ink, not the turned box's top centre", () => {
		const t = { pivot: { x: 140, y: 220 }, scale: 1, angle: Math.PI / 4 };
		const f = framePoints(BOX, t, 2);
		const want = transformPoint(handlePoints(BOX, 2).rotate, t);
		expect(near(f.handles.rotate, want), `knob ${JSON.stringify(f.handles.rotate)} vs ${JSON.stringify(want)}`).toBe(true);
		const flat = handlePoints(transformedBox(BOX, t), 2).rotate;
		expect(Math.hypot(f.handles.rotate.x - flat.x, f.handles.rotate.y - flat.y), "the knob is the axis-aligned box's").toBeGreaterThan(5);
		for (const id of ["nw", "ne", "se", "sw"] as const) {
			expect(near(f.handles[id], transformPoint(handlePoints(BOX, 2)[id], t)), id).toBe(true);
		}
	});

	it("at a quarter turn the stem and the four squares are drawn at the turned points", () => {
		const t = { pivot: { x: 140, y: 220 }, scale: 1, angle: Math.PI / 2 };
		const cam = { x: 40, y: 150, zoom: 2 };
		const rects: number[][] = [], arcs: number[][] = [], lines: number[][] = [];
		const ctx = {
			fillStyle: "" as string, strokeStyle: "" as string, lineWidth: 0,
			save() {}, restore() {}, beginPath() {}, fill() {}, stroke() {}, setLineDash() {},
			moveTo(x: number, y: number) { lines.push([x, y]); }, lineTo(x: number, y: number) { lines.push([x, y]); },
			arc(x: number, y: number, r: number) { arcs.push([x, y, r]); },
			rect(x: number, y: number, w: number, h: number) { rects.push([x, y, w, h]); },
		};
		(drawTransformHandles as (...a: unknown[]) => void)(ctx, BOX, cam, "#7f9cf5", 1, t);
		const h = handlePoints(BOX, cam.zoom);
		const screen = (p: { x: number; y: number }) => [(p.x - cam.x) * cam.zoom, (p.y - cam.y) * cam.zoom] as const;
		const turned = (p: { x: number; y: number }) => screen(transformPoint(p, t));
		const close = (got: number[] | undefined, want: readonly number[], label: string) => {
			expect(got, label).toBeDefined();
			want.forEach((v, i) => expect(got![i], `${label}[${i}]`).toBeCloseTo(v, 6));
		};
		(["nw", "ne", "se", "sw"] as const).forEach((id, i) => {
			const [x, y] = turned(h[id]);
			close(rects[i], [x - HANDLE_DRAW_PX / 2, y - HANDLE_DRAW_PX / 2], `square ${id}`);
		});
		close(arcs[0], turned(h.rotate), "knob");
		close(lines[0], turned({ x: h.rotate.x, y: h.nw.y }), "stem foot, the frame's top centre");
		close(lines[1], turned(h.rotate), "stem top, the knob");
	});

	it("a resize with no turn draws the frame as today: the scaled box, padded, axis-aligned", () => {
		const t = { pivot: { x: 100, y: 200 }, scale: 2, angle: 0 };
		for (const [zoom, cssScale] of [[1, 1], [2, 1], [1, 0.5]] as const) {
			const f = framePoints(BOX, t, zoom, cssScale);
			const today = handlePoints(transformedBox(BOX, t), zoom, cssScale);
			for (const id of ["nw", "ne", "se", "sw", "rotate"] as const) {
				expect(near(f.handles[id], today[id], 1e-9), `${id} at zoom ${zoom}, canvas ${cssScale}`).toBe(true);
			}
			[today.nw, today.ne, today.se, today.sw].forEach((p, i) => expect(near(f.corners[i]!, p, 1e-9), `corner ${i}`).toBe(true));
		}
	});
});
