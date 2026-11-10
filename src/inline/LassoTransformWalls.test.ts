/**
 * THE TOP AND LEFT WALLS UNDER A LASSO TURN, RESIZE AND DRAG.
 *
 * The walls are the note's top (y = 0) and the column's left border (x = 0); a box already past one at the grab is judged
 * against where it started (no further out). Judged on the ink's own box.
 *
 * Defects (TF-5): ink at the column's left edge or on the first line will not turn, then jumps about 15 degrees, because a
 * turn that carries a corner past the wall is refused whole and the last accepted step stays; the float comparison refuses
 * legal steps (a scale-down about the box's top corner puts that corner at -1.6800000000000002 for -1.68); a lasso drag has
 * no left wall and pushes the ink where no scroll room reaches it.
 *
 * Cells: real beginTransform, stepTransform and transformedBox; for the drag, real lassoDown, lassoMove, lassoUp,
 * selectionBounds, moveLive and SelectionModel on an overlay built with Object.create, as LassoDragBox.test.ts builds it.
 * Substituted: the layer that draws (a proxy that records the box it is asked to draw).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { InsertSpaceRows } from "./InsertSpace";
import { SelectionModel } from "../objects/SelectionModel";
import { DamageLedger } from "../ink/DamageLedger";
import { StrokeIndex } from "../ink/StrokeIndex";
import { FrontierCache } from "./FrontierCache";
import type { BBox, InkStroke } from "../ink/Stroke";
import { beginTransform, handlePoints, stepTransform, transformedBox, transformedShape } from "./LassoTransform";

const PEN = { shift: false, input: "pen" as const };
const rad = (deg: number) => (deg * Math.PI) / 180;

describe("a knob turn of ink at a wall", () => {
	// A wide box 2 past the left wall, and the same box turned on its side 2 past the top wall.
	for (const box of [{ x: -2, y: 100, width: 300, height: 40 }, { x: 100, y: -2, width: 40, height: 300 }]) {
		const wall = box.x < 0 ? "left" : "top";
		it(`at the ${wall} wall: each accepted angle follows the pen within its step, and the box stays no further out`, () => {
			const knob = handlePoints(box, 1).rotate;
			const g = beginTransform(box, "rotate", knob, 1);
			const dx = knob.x - g.pivot.x, dy = knob.y - g.pivot.y;
			let pen = 0, last = 0;
			const seen: string[] = [];
			for (const deg of [1, 5, 10, 14, 16]) {
				const a = rad(deg);
				const step = stepTransform(g, { x: g.pivot.x + dx * Math.cos(a) - dy * Math.sin(a), y: g.pivot.y + dx * Math.sin(a) + dy * Math.cos(a) }, PEN);
				const out = transformedBox(box, step);
				const ok = Math.abs(step.angle - last) <= a - pen + 1e-9 && out.x >= Math.min(0, box.x) - 1e-6 && out.y >= Math.min(0, box.y) - 1e-6;
				seen.push(`pen ${deg}: accepted ${((step.angle * 180) / Math.PI).toFixed(3)}, box ${out.x.toFixed(3)},${out.y.toFixed(3)}${ok ? "" : " BAD"}`);
				pen = a;
				last = step.angle;
			}
			expect(seen.filter((v) => v.endsWith("BAD")), `the turn jumped or crossed the wall: ${seen.join("; ")}`).toEqual([]);
			expect(last, "the turn never reached the pen").toBeCloseTo(rad(16), 9);
		});
	}
});

describe("the lift of a slid turn", () => {
	it("transformedShape under a turn slid onto the left wall lands each stroke's box no further out than the wall", () => {
		// Two strokes down the wide box's left and right edges, so ink reaches every corner: their union is the box 2 past the left
		// wall, as the selection's box is the union of the strokes' boxes.
		const mk = (id: string, x0: number, y0: number, x1: number, y1: number): InkStroke => {
			const points = [{ x: x0, y: y0, pressure: 0.5, t: 0 }, { x: x1, y: y1, pressure: 0.5, t: 8 }];
			return { id, tool: "pen", color: "#000000", width: 2, points, bbox: { x: Math.min(x0, x1) - 4, y: Math.min(y0, y1) - 4, width: Math.abs(x1 - x0) + 8, height: Math.abs(y1 - y0) + 8 }, createdAt: 1 } as InkStroke;
		};
		const strokes = [mk("p", 2, 104, 2, 136), mk("q", 294, 104, 294, 136)];
		const box = { x: -2, y: 100, width: 300, height: 40 };
		const knob = handlePoints(box, 1).rotate;
		const g = beginTransform(box, "rotate", knob, 1);
		const a = rad(10), dx = knob.x - g.pivot.x, dy = knob.y - g.pivot.y;
		const step = stepTransform(g, { x: g.pivot.x + dx * Math.cos(a) - dy * Math.sin(a), y: g.pivot.y + dx * Math.sin(a) + dy * Math.cos(a) }, PEN);
		expect([step.angle, (step.shift?.x ?? 0) > 0], "premise: the turn was accepted and slid right").toEqual([expect.closeTo(a, 9), true]);
		const lefts = strokes.map((st) => transformedShape(st, step, 0).bbox.x);
		expect(Math.min(...lefts), `a lifted stroke landed past the left wall: ${lefts.join(", ")}`).toBeGreaterThanOrEqual(box.x - 1e-6);
	});
});

describe("a corner resize of ink on the first line", () => {
	for (const y of [-1.68, -3.4]) {
		it(`a box ${-y} past the top, scaled down about its top corner: every step is accepted`, () => {
			const box = { x: 10, y, width: 100, height: 40 };
			const refused: number[] = [];
			for (let i = 10; i <= 99; i++) {
				const s = i / 100;
				const g = beginTransform(box, "se", { x: 110, y: y + 40 }, 1);
				// Accepted as the pen's own step: the scale it asks, and no slide of a corner the step leaves in place.
				const step = stepTransform(g, { x: 10 + 100 * s, y: y + 40 * s }, PEN);
				if (Math.abs(step.scale - s) > 1e-9 || step.shift) refused.push(s);
			}
			expect(refused, "legal scale-downs refused by the float comparison").toEqual([]);
		});
	}
	it("the spec step: pivot y -1.68, scale 0.35 passes", () => {
		const box = { x: 10, y: -1.68, width: 100, height: 40 };
		const g = beginTransform(box, "se", { x: 110, y: 38.32 }, 1);
		expect(transformedBox(box, { pivot: g.pivot, scale: 0.35, angle: 0 }).y, "premise: the corner lands a float step past the start").toBeLessThan(-1.68);
		const step = stepTransform(g, { x: 45, y: -1.68 + 14 }, PEN);
		expect([step.scale, step.shift ?? null], "the step was refused or slid").toEqual([expect.closeTo(0.35, 12), null]);
	});
});

const NOTE = "lasso-transform-walls.md";
const proto = InkOverlayPlugin.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const sample = (x: number, y: number) => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });

function stroke(id: string, x: number, y: number): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2,
		points: [{ x, y, pressure: 0.5, t: 0 }, { x: x + 30, y: y + 10, pressure: 0.5, t: 8 }],
		bbox: { x, y, width: 30, height: 10 }, createdAt: 1,
	} as InkStroke;
}

const SELECTED = ["a", "b", "c"];
const ALL = [stroke("a", 100, 60), stroke("b", 140, 90), stroke("c", 120, 120), stroke("other", 400, 40)];

function truthBox(): BBox {
	const mine = inlineInk.strokes(NOTE).filter((st) => SELECTED.includes(st.id));
	const x0 = Math.min(...mine.map((st) => st.bbox.x)), y0 = Math.min(...mine.map((st) => st.bbox.y));
	const x1 = Math.max(...mine.map((st) => st.bbox.x + st.bbox.width)), y1 = Math.max(...mine.map((st) => st.bbox.y + st.bbox.height));
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function overlay() {
	const o = Object.create(InkOverlayPlugin.prototype) as Record<string, any>;
	Object.defineProperty(o, "winRef", { value: { requestAnimationFrame: (cb: () => void) => { cb(); return null; }, cancelAnimationFrame: () => {} } });
	o.container = {};
	const drawn: BBox[] = [];
	const noop = () => {};
	const tail = new Proxy({}, { get: (_t, name) => (name === "drawSelectionBox" ? (_cam: unknown, box: BBox) => drawn.push({ ...box }) : noop) });
	Object.assign(o, {
		filePath: () => NOTE, view: { dom: null }, scale: 1, cssScale: 1, cssWidth: 800, cssHeight: 600,
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }), snapshot: { x: 0, y: 0, zoom: 1 }, zoom: 1 },
		committedBacking: 1.8257, selection: new SelectionModel(), damage: new DamageLedger(), strokeIndex: new StrokeIndex(),
		frontierCache: new FrontierCache(), indexDirty: true, dragIds: [], dragFrom: null, dragTotal: null, lassoActive: false,
		lassoPts: [], builder: null, tail, spacePreview: null, spacePlan: null, spaceRowsCache: new InsertSpaceRows(),
		scheduleRepaint: noop, repaintPath: noop, showLassoCursor: noop, dressTail: noop, dispatchInk: noop,
	});
	o.selection.selectExactly(SELECTED);
	return { o, drawn };
}

describe("a lasso drag toward the left", () => {
	beforeEach(() => {
		vi.stubGlobal("window", globalThis);
		inlineInk.applyAdd(NOTE, ALL.map((st) => structuredClone(st)));
	});
	afterEach(() => {
		inlineInk.handleDelete(NOTE);
		vi.unstubAllGlobals();
	});

	it("dragged 300 left of a box at x 100: the shown and the stored box stay at or right of the column's left border", () => {
		const { o, drawn } = overlay();
		proto.lassoDown!.call(o, sample(130, 100));
		const down = truthBox();
		expect(down.x, "premise: the box starts right of the wall").toBe(100);
		proto.lassoMove!.call(o, [sample(-170, 100)]);
		const shown = proto.selectionBounds!.call(o) as BBox;
		expect([shown.x >= 0, drawn.at(-1)!.x >= 0], `the drag's box crossed the left wall: shown ${shown.x}, drawn ${drawn.at(-1)!.x}`).toEqual([true, true]);
		proto.lassoUp!.call(o);
		expect(truthBox().x, "the lift stored the ink past the left wall").toBeGreaterThanOrEqual(-1e-9);
	});

	// The wall stops the drag; the pen comes back right by 10 but is still left of where the ink stopped: the grab point followed
	// the ink, not the pen, so the ink does not move until the pen is back there (the top wall's rule).
	for (const route of ["picture", "store"] as const) {
		it(`on the ${route} path: after the wall stops the drag, a pen coming back right but still left of the stop moves nothing`, () => {
			const { o } = overlay();
			if (route === "store") o.beginLassoSnapshot = () => false;
			proto.lassoDown!.call(o, sample(130, 100));
			expect([o.dragTotal !== null, o.spaceSnapshot?.kind ?? null], "premise: the grab took the route named").toEqual([true, route === "picture" ? "lasso" : null]);
			proto.lassoMove!.call(o, [sample(-170, 100)]);
			const stop = proto.selectionBounds!.call(o) as BBox;
			expect(stop.x, "premise: the wall stopped the drag's box at x 0").toBeCloseTo(0, 9);
			proto.lassoMove!.call(o, [sample(-160, 100)]);
			expect((proto.selectionBounds!.call(o) as BBox).x, "the pen's return moved the ink before it came back to the stop").toBeCloseTo(stop.x, 9);
		});
	}
});
