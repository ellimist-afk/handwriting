// A lasso drag or an insert-space drag cannot leave ink above the top of the note.
//
// A selection dragged up past the top of the note keeps following the pen: the lasso move has no limit at the
// note's top edge, so the ink can be left above y = 0, where the page has no scroll room. It cannot be seen or
// lassoed again and Fit refuses it; only undo brings it back. The insert-space drag has the same gap below the
// last line of text (the "ink gap"), where the release keeps the whole drag (spaceTextChange returns dy: applied
// for a plan with text: false).
//
// Both cells drive the real lassoDown/lassoMove/lassoUp and spaceMove/spaceUp on an overlay built with
// Object.create, so only the fields those methods read are present. Expected: red until the moves stop at the
// top edge.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Text } from "@codemirror/state";
import { InkOverlayPlugin, inlineInk } from "../inline/InkOverlay";
import { SelectionModel } from "../objects/SelectionModel";
import { DamageLedger } from "../ink/DamageLedger";
import { StrokeIndex } from "../ink/StrokeIndex";
import { FrontierCache } from "../inline/FrontierCache";
import type { BBox, InkStroke } from "../ink/Stroke";

const NOTE = "a2-drag-top.md";
const stroke: InkStroke = {
	id: "s1",
	tool: "pen",
	color: "#000000",
	width: 2,
	points: [
		{ x: 100, y: 40, pressure: 0.5, t: 0 },
		{ x: 160, y: 60, pressure: 0.5, t: 8 },
	],
	bbox: { x: 100, y: 40, width: 60, height: 20 },
	createdAt: 1,
} as InkStroke;

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

const s = (x: number, y: number) => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
const proto = InkOverlayPlugin.prototype as unknown as Record<string, (...a: unknown[]) => void>;

function overlay(extra: Record<string, unknown> = {}): Record<string, unknown> {
	const o = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	Object.assign(o, {
		filePath: () => NOTE,
		scale: 1,
		cssScale: 1,
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }), snapshot: { x: 0, y: 0, zoom: 1 } },
		committedBacking: K,
		selection: new SelectionModel(),
		damage: new DamageLedger(),
		strokeIndex: new StrokeIndex(),
		frontierCache: new FrontierCache(),
		indexDirty: true,
		dragIds: [],
		scheduleRepaint() {},
		repaintPath() {},
		redrawSelectionUI() {},
		showLassoCursor() {},
		dispatchInk() {},
		...extra,
	});
	return o;
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	inlineInk.applyAdd(NOTE, [structuredClone(stroke)]);
});
afterEach(() => {
	inlineInk.handleDelete(NOTE);
	vi.unstubAllGlobals();
});

it("a selection dragged up off the pane stops at the note's top edge", () => {
	const o = overlay();
	(o.selection as SelectionModel).selectExactly(["s1"]);

	proto.lassoDown!.call(o, s(130, 50)); // inside the selection: grab
	proto.lassoMove!.call(o, [s(130, -400)]); // pen dragged up off the pane
	proto.lassoMove!.call(o, [s(130, -2000)]);
	proto.lassoUp!.call(o);

	const after = inlineInk.strokes(NOTE).find((st) => st.id === "s1")!;
	expect(after.bbox.y, "ink left above the top of the note").toBeGreaterThanOrEqual(0);
});

it("an insert-space drag in the ink gap below the text stops at the note's top edge", () => {
	const doc = Text.of(["one line of text"]);
	const dispatched: unknown[] = [];
	const o = overlay({
		view: { state: { doc }, dispatch: (tr: unknown) => dispatched.push(tr) },
		stampInkIdentity: (op: unknown) => op,
		clearSpaceFeedback() {},
	});
	// The state spaceDown leaves for a seam in the ink gap at y = 30 (below all text): plan.text === false, the
	// stroke below the seam is the moving set.
	Object.assign(o, {
		spacePlan: { y: 30, from: doc.length, lineHeight: 24, text: false, doc },
		spaceLineY: 30,
		spaceFromY: 30,
		spaceTotalDy: 0,
		spaceIds: ["s1"],
		spaceBounds: { ...stroke.bbox },
		spaceHistoryIdentity: null,
	});

	proto.spaceMove!.call(o, [s(130, -400)]);
	proto.spaceMove!.call(o, [s(130, -2000)]);
	proto.spaceUp!.call(o);

	const after = inlineInk.strokes(NOTE).find((st) => st.id === "s1")!;
	expect(after.bbox.y, "ink left above the top of the note").toBeGreaterThanOrEqual(0);
});

const bboxOf = () => inlineInk.strokes(NOTE).find((st) => st.id === "s1")!.bbox;

it("the wall: the ink stops at the top, and follows again from where it stopped, grab point under the pen", () => {
	const o = overlay();
	(o.selection as SelectionModel).selectExactly(["s1"]);
	proto.lassoDown!.call(o, s(130, 50)); // grab 10 below the selection's top (40)
	// A drag sample moves no store (the selected ink rides the tail as a picture, the lift moves the store once): the wall
	// holds the drag's own box, which the picture and the lift follow.
	const box = () => (proto.selectionBounds!.call(o) as unknown as BBox).y;
	proto.lassoMove!.call(o, [s(130, -400)]);
	expect(box(), "stopped at the top").toBe(0);
	proto.lassoMove!.call(o, [s(130, -300)]); // the pen comes back down, still above where the ink stopped
	expect(box(), "no jump while the pen is above the stop point").toBe(0);
	proto.lassoMove!.call(o, [s(130, 30)]); // the stop point was pen y 10; now 20 below it
	expect(box(), "the grab point is under the pen again").toBe(20);
	expect([o.dragTotal, bboxOf().y], "the drag's distance; the store unmoved until the lift").toEqual([{ dx: 0, dy: -20 }, 40]);
	proto.lassoUp!.call(o);
	expect(bboxOf().y, "the store after the lift is the wall-held box, at the offset the picture showed").toBeCloseTo(40 + qy(-20, 40), 9);
});

it("the wall for insert space: the ink stops at the top, and follows again from where it stopped, grab point under the pen", () => {
	const doc = Text.of(["one line of text"]);
	const o = overlay({ view: { state: { doc }, dispatch: () => {} }, stampInkIdentity: (op: unknown) => op, clearSpaceFeedback() {} });
	Object.assign(o, {
		spacePlan: { y: 30, from: doc.length, lineHeight: 24, text: false, doc },
		spaceLineY: 30, spaceFromY: 50, spaceTotalDy: 0, spaceIds: ["s1"], spaceBounds: { ...stroke.bbox }, spaceHistoryIdentity: null,
	});
	// A drag sample moves no store (the moving ink rides the tail as a picture, the release moves the store once): the wall
	// holds the drag's own box, which the picture and the release follow.
	const box = () => (o.spaceBounds as { y: number }).y;
	proto.spaceMove!.call(o, [s(130, -400)]); // ink top 40, grab 50: stops at 0 when the pen passes 10
	expect(box(), "stopped at the top").toBe(0);
	proto.spaceMove!.call(o, [s(130, -300)]); // the pen comes back down, still above where the ink stopped
	expect(box(), "no jump while the pen is above the stop point").toBe(0);
	proto.spaceMove!.call(o, [s(130, 30)]); // the stop point was pen y 10; now 20 below it
	expect(box(), "the grab point is under the pen again").toBe(20);
	expect([o.spaceTotalDy, bboxOf().y], "the drag's distance; the store unmoved until the release").toEqual([-20, 40]);
});

it("the wall leaves sideways movement alone", () => {
	const o = overlay();
	(o.selection as SelectionModel).selectExactly(["s1"]);
	proto.lassoDown!.call(o, s(130, 50));
	proto.lassoMove!.call(o, [s(300, -400)]);
	proto.lassoUp!.call(o);
	expect(bboxOf().x, "the whole sideways distance, as the picture showed it").toBeCloseTo(100 + q(170), 9);
	expect(bboxOf().y, "at the top, as the picture showed it").toBeCloseTo(40 + qy(-40, 40), 9);
	expect(bboxOf().y, "ink left above the top of the note").toBeGreaterThanOrEqual(0);
});

it("ink already above the top can be dragged down, not further up", () => {
	inlineInk.handleDelete(NOTE);
	inlineInk.applyAdd(NOTE, [{ ...structuredClone(stroke), bbox: { x: 100, y: -100, width: 60, height: 20 },
		points: [{ x: 100, y: -100, pressure: 0.5, t: 0 }, { x: 160, y: -80, pressure: 0.5, t: 8 }] } as InkStroke]);
	const o = overlay();
	(o.selection as SelectionModel).selectExactly(["s1"]);
	proto.lassoDown!.call(o, s(130, -90));
	const box = () => (proto.selectionBounds!.call(o) as unknown as BBox).y;
	proto.lassoMove!.call(o, [s(130, -500)]);
	expect(box(), "not further up").toBe(-100);
	proto.lassoMove!.call(o, [s(130, -60)]);
	expect(box(), "down by the pen's distance below the grab point").toBe(-70);
	expect([o.dragTotal, bboxOf().y], "the drag's distance; the store unmoved until the lift").toEqual([{ dx: 0, dy: 30 }, -100]);
	proto.lassoUp!.call(o);
	expect(bboxOf().y, "the store after the lift is the drag's box, at the offset the picture showed").toBeCloseTo(-100 + qy(30, -100), 9);
});

it("the wall at 200 percent: the top in note units, not screen pixels", () => {
	const o = overlay({ scale: 2, cssScale: 2, camera: { screenToWorld: (x: number, y: number) => ({ x: x / 2, y: y / 2 }), snapshot: { x: 0, y: 0, zoom: 2 } } });
	(o.selection as SelectionModel).selectExactly(["s1"]);
	proto.lassoDown!.call(o, s(260, 100)); // note (130, 50)
	proto.lassoMove!.call(o, [s(260, -4000)]);
	proto.lassoUp!.call(o);
	expect(bboxOf().y, "at the top, as the picture showed it at zoom 2").toBeCloseTo(40 + qy(-40, 40, 2 * K), 9);
	expect(bboxOf().y, "ink left above the top of the note").toBeGreaterThanOrEqual(0);
});

it("a drag at 200 percent off the wall: the lift lands at the offset the picture showed at zoom 2", () => {
	// 39.7 note units is 144.96 backing px at 2K, so 145, and 72.48 at K, so 72: twice that is 144. A lift that rounds at the
	// backing alone, without the camera's zoom, lands one backing px off the picture.
	expect([Math.round(39.7 * 2 * K), 2 * Math.round(39.7 * K)], "premise: the total rounds apart at 2K and at K").toEqual([145, 144]);
	const o = overlay({ scale: 2, cssScale: 2, camera: { screenToWorld: (x: number, y: number) => ({ x: x / 2, y: y / 2 }), snapshot: { x: 0, y: 0, zoom: 2 } } });
	(o.selection as SelectionModel).selectExactly(["s1"]);
	proto.lassoDown!.call(o, s(260, 100)); // note (130, 50)
	proto.lassoMove!.call(o, [s(260 + 79.4, 100 + 79.4)]); // 39.7 note units right and down, clear of the top
	expect(bboxOf().y, "the store unmoved until the lift").toBe(40);
	proto.lassoUp!.call(o);
	expect(bboxOf().x, "sideways, at the offset the picture showed at zoom 2").toBeCloseTo(100 + q(39.7, 2 * K), 9);
	expect(bboxOf().y, "down, at the offset the picture showed at zoom 2").toBeCloseTo(40 + q(39.7, 2 * K), 9);
});

it("insert space over blank lines: the text closes up by the distance the ink moved at the wall", () => {
	// Four blank lines, then text; the seam is at the text, the ink below it starts 40 below the note top.
	const doc = Text.of(["", "", "", "", "text"]);
	const changes: unknown[] = [];
	const o = overlay({
		view: { state: { doc }, dispatch: (tr: { changes?: unknown }) => changes.push(tr.changes), defaultLineHeight: 20 },
		contentStyle: { lineHeight: "20px" },
		stampInkIdentity: (op: unknown) => op,
		clearSpaceFeedback() {},
	});
	Object.assign(o, {
		spacePlan: { y: 30, from: doc.line(5).from, lineHeight: 20, text: true, doc },
		spaceLineY: 30, spaceFromY: 50, spaceTotalDy: 0, spaceIds: ["s1"],
		spaceBounds: { ...stroke.bbox }, spaceHistoryIdentity: null,
	});
	proto.spaceMove!.call(o, [s(130, -150)]); // 200 up; the ink has 40 of room
	proto.spaceUp!.call(o);
	expect(bboxOf().y, "the ink stopped at the top").toBe(0);
	expect(changes, "two blank lines (40) taken back, matching the ink").toEqual([{ from: doc.line(3).from, to: doc.line(5).from, insert: "" }]);
});
