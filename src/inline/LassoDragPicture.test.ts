/**
 * A lasso drag moves the selected ink as a picture: no sample moves a stroke in the store or asks the committed layers to
 * repaint, and the lift moves the store once, by the offset the picture showed (whole backing px), which is within half a
 * backing px of the place the old per-sample moves left every point.
 *
 * Cells count calls and compare coordinates; they never time. Real `lassoDown`, `lassoMove`, `lassoUp`, `commitLiveDrag`,
 * `redrawSelectionUI`, `moveLive`, `rollbackSpaceMove`, `rollbackLiveGesture` and `SelectionModel` on an overlay built with
 * Object.create, as LassoDragBox.test.ts builds it. Substituted: the layer that draws (a proxy that draws nothing), the
 * repaint asks (recorded), and the extent build drop (nothing to drop).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { InsertSpaceRows } from "./InsertSpace";
import { SelectionModel } from "../objects/SelectionModel";
import { DamageLedger } from "../ink/DamageLedger";
import { StrokeIndex } from "../ink/StrokeIndex";
import { FrontierCache } from "./FrontierCache";
import type { InkStroke } from "../ink/Stroke";

const NOTE = "lasso-drag-picture.md";
const proto = InkOverlayPlugin.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const s = (x: number, y: number) => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });

function stroke(id: string, x: number, y: number): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x, y, pressure: 0.5, t: 0 },
			{ x: x + 30.25, y: y + 10.125, pressure: 0.5, t: 8 },
			{ x: x + 11.7, y: y + 3.3, pressure: 0.5, t: 16 },
		],
		bbox: { x, y, width: 30.25, height: 10.125 },
		createdAt: 1,
	} as InkStroke;
}

/**
 * The backing the fixture's committed layers report, the stand-in's ratio, so a drag's offset is not whole backing px. The lift
 * moves the store by the offset the picture showed: each axis's total to whole backing px at the lift's camera, in y the next
 * px down when the nearest would put the grab's box above the note's top (shownLassoOffset).
 */
const K = 1.8257;
const q = (v: number, k = K) => Math.round(v * k) / k;
const qy = (v: number, boxY: number, k = K) => {
	const y = Math.round(v * k);
	return (y / k < Math.min(0, -boxY) ? Math.ceil(v * k) : y) / k;
};

const SELECTED = ["a", "b", "c"];
const ALL = [
	stroke("a", 100.1, 160.3),
	stroke("b", 140.7, 190.9),
	stroke("c", 120.3, 220.2),
	...Array.from({ length: 17 }, (_, i) => stroke(`other${i}`, 400, 40 + i * 25)),
];

function overlay() {
	const o = Object.create(InkOverlayPlugin.prototype) as Record<string, any>;
	const noop = () => {};
	const asks: string[] = [];
	const tail = new Proxy({}, { get: () => noop });
	Object.assign(o, {
		filePath: () => NOTE,
		scale: 1,
		cssScale: 1,
		cssWidth: 800,
		cssHeight: 600,
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }), snapshot: { x: 0, y: 0, zoom: 1 }, zoom: 1 },
		committedBacking: K,
		dpr: K,
		selection: new SelectionModel(),
		damage: new DamageLedger(),
		strokeIndex: new StrokeIndex(),
		frontierCache: new FrontierCache(),
		indexDirty: true,
		dragIds: [],
		dragFrom: null,
		dragTotal: null,
		dragBox: null,
		dragHistoryIdentity: null,
		lassoActive: false,
		lassoPts: [],
		builder: null,
		tail,
		band: null,
		paintedStrokeCount: 0,
		spaceSnapshot: null,
		spacePreview: null,
		spacePlan: null,
		spaceTotalDy: 0,
		spaceRowsCache: new InsertSpaceRows(),
		repaintQueued: false,
		scheduleRepaint: (via = "other") => { asks.push(String(via)); },
		repaintPath: (_p: string, rects?: unknown[]) => { asks.push("path:" + (rects ? rects.length : "all")); },
		dropExtentBuild: noop,
		showLassoCursor: noop,
		dressTail: noop,
		dispatchInk: noop,
		retakeLineAnchors: noop,
		noteStrokes: (p: string) => inlineInk.strokes(p),
	});
	o.selection.selectExactly(SELECTED);
	return { o, asks };
}

const pts = () => inlineInk.strokes(NOTE).filter((st) => SELECTED.includes(st.id)).map((st) => st.points.map((p) => [p.x, p.y]));
const staying = () => inlineInk.strokes(NOTE).filter((st) => !SELECTED.includes(st.id)).map((st) => st.points.map((p) => [p.x, p.y]));

/** Seeded steps (mulberry32). */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	inlineInk.applyAdd(NOTE, ALL.map((st) => structuredClone(st)));
});
afterEach(() => {
	inlineInk.handleDelete(NOTE);
	vi.unstubAllGlobals();
});

describe("a lasso drag's samples", () => {
	it("thirty samples in both axes: no stroke moves in the store, no committed repaint is asked, no other pane is repainted", () => {
		const { o, asks } = overlay();
		proto.lassoDown!.call(o, s(130, 200)); // inside the selection: grab
		expect(o.dragTotal, "the pen-down did not grab the selection, so this cell proves nothing").not.toBeNull();
		const before = pts();
		const move = vi.spyOn(inlineInk, "moveStrokes");
		asks.length = 0;

		for (let i = 1; i <= 30; i++) proto.lassoMove!.call(o, [s(130 + i * 3.3, 200 + i * 4.1)]);

		expect(o.dragTotal.dx * o.dragTotal.dy, "the drag went nowhere, so this cell proves nothing").toBeGreaterThan(0);
		expect([move.mock.calls.length, pts()], "the samples moved strokes in the store").toEqual([0, before]);
		expect(asks, "the samples asked for committed or other-pane repaints").toEqual([]);
	});
});

describe("a lasso drag's lift", () => {
	for (let seed = 1; seed <= 60; seed++) {
		it(`seed ${seed}: every moved point ends where the picture showed it, within half a backing px of the old per-sample place; staying ink untouched`, () => {
			const { o } = overlay();
			const r = rng(seed);
			const start = pts(), still = staying();
			let x = 130 + r() * 10, y = 200 + r() * 10;
			proto.lassoDown!.call(o, s(x, y));
			expect(o.dragTotal, "no grab, so this cell proves nothing").not.toBeNull();
			// The old drag added each sample's step to every point as it came, the top wall clamping the step: the same here, in
			// order, on a copy.
			const old = start.map((st) => st.map((p) => [...p]));
			let fromX = x, fromY = y;
			const box0 = (o.dragBox as { box: { y: number } }).box.y;
			let totalX = 0, totalY = 0;
			const n = 5 + Math.floor(r() * 36);
			for (let i = 0; i < n; i++) {
				x += (r() - 0.5) * 30;
				y += (r() - 0.45) * 30;
				proto.lassoMove!.call(o, [s(x, y)]);
				const dx = x - fromX;
				const dy = Math.max(y - fromY, Math.min(0, -(box0 + totalY)));
				totalX += dx;
				totalY += dy;
				for (const st of old) for (const p of st) { p[0]! += dx; p[1]! += dy; }
				fromX = x;
				fromY += dy;
			}
			proto.lassoUp!.call(o);
			// The picture's offset at the lift's camera (zoom 1, backing K): where the ink was seen when the pen came up.
			const sx = q(totalX), sy = qy(totalY, box0);
			const end = pts();
			let worst = 0, far = 0;
			end.forEach((st, i) => st.forEach((p, j) => {
				worst = Math.max(worst, Math.abs(p[0]! - (start[i]![j]![0]! + sx)), Math.abs(p[1]! - (start[i]![j]![1]! + sy)));
				far = Math.max(far, Math.abs(p[0]! - old[i]![j]![0]!), Math.abs(p[1]! - old[i]![j]![1]!));
			}));
			expect(worst, `the lift left a point ${worst} world units from where the picture showed it`).toBeLessThanOrEqual(1e-9);
			expect(far, `the lift left a point ${far} world units from the pen's total, over half a backing px`).toBeLessThanOrEqual(0.5 / K + 1e-9);
			expect(end, "nothing moved, so this cell proves nothing").not.toEqual(start);
			expect(staying(), "a stroke outside the selection moved").toEqual(still);
		});
	}
});

describe("the lift and the committed layers' painted count", () => {
	it("a whole repaint during the drag counted the strokes without the selected ink: the lift gives back the grab's count", () => {
		const { o } = overlay();
		o.paintedStrokeCount = inlineInk.strokes(NOTE).length;
		proto.lassoDown!.call(o, s(130, 200));
		expect(o.spaceSnapshot?.kind, "no lasso picture at the grab, so this cell proves nothing").toBe("lasso");
		// What the grab's whole repaint does: the committed layers paint the note without the selected ink and count that.
		o.paintedStrokeCount = inlineInk.strokes(NOTE).length - SELECTED.length;
		o.indexDirty = false;
		for (let i = 1; i <= 6; i++) proto.lassoMove!.call(o, [s(130 + i * 5, 200 + i * 7)]);
		proto.lassoUp!.call(o);
		// The band and bake carries compare the count with the store: the lift's box repaint puts the ink back.
		expect([o.paintedStrokeCount, o.indexDirty], "after the lift the painted count is not the store's, or the index is not rebuilt")
			.toEqual([inlineInk.strokes(NOTE).length, true]);
	});
});

describe("the picture's blue overlay", () => {
	it("an insert space picture draws each moving stroke's blue preview; a lasso picture draws none", () => {
		const blue: Record<string, string[]> = {};
		for (const kind of ["space", "lasso"] as const) {
			const { o } = overlay();
			const drawn: string[] = (blue[kind] = []);
			o.tail = new Proxy({}, {
				get: (_t, name) => name === "drawSpaceStroke" ? (_cam: unknown, st: InkStroke) => drawn.push(st.id)
					: name === "spaceStrokeOnScreen" ? () => true : () => {},
			});
			const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
			// One point each: drawStroke paints nothing for it, so the cell reads only which strokes get the blue preview.
			const moving = SELECTED.map((id) => ({ ...stroke(id, 10, 10), points: [{ x: 10, y: 10, pressure: 0.5, t: 0 }] }));
			const snap = { kind, canvas: { width: 64, height: 64, getContext: () => ctx }, moving, top: 0, lo: 0, done: 0, bottom: 64, col: 0, backing: K, at: { x: 0, y: 0, zoom: 1 } };
			proto.rasterSpaceRows!.call(o, snap, 64);
			expect(snap.done, `premise: the ${kind} picture's rows were rastered`).toBe(64);
		}
		expect(blue, "the blue preview strokes drawn into each picture").toEqual({ space: SELECTED, lasso: [] });
	});
});

describe("an abandoned lasso drag", () => {
	it("a note switch mid-drag: the selected ink is where it was at pen-down, moved neither forward nor back", () => {
		const { o } = overlay();
		const start = pts();
		proto.lassoDown!.call(o, s(130, 200));
		o.dragHistoryIdentity = inlineInk.captureHistoryIdentity(NOTE);
		for (let i = 1; i <= 6; i++) proto.lassoMove!.call(o, [s(130 + i * 5, 200 + i * 7)]);
		expect(o.dragTotal.dy, "the drag went nowhere, so this cell proves nothing").toBeGreaterThan(0);

		// resetGestureState's order.
		proto.rollbackSpaceMove!.call(o);
		proto.rollbackLiveGesture!.call(o);

		const end = pts();
		let worst = 0;
		end.forEach((st, i) => st.forEach((p, j) => { worst = Math.max(worst, Math.abs(p[0]! - start[i]![j]![0]!), Math.abs(p[1]! - start[i]![j]![1]!)); }));
		expect(worst, "the abandoned drag left the ink away from its pen-down place").toBeLessThanOrEqual(1e-9);
	});
});
