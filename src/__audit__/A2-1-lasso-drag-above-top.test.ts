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
import type { InkStroke } from "../ink/Stroke";

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

const s = (x: number, y: number) => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
const proto = InkOverlayPlugin.prototype as unknown as Record<string, (...a: unknown[]) => void>;

function overlay(extra: Record<string, unknown> = {}): Record<string, unknown> {
	const o = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	Object.assign(o, {
		filePath: () => NOTE,
		scale: 1,
		cssScale: 1,
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }) },
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
	proto.lassoMove!.call(o, [s(130, -400)]);
	expect(bboxOf().y, "stopped at the top").toBe(0);
	proto.lassoMove!.call(o, [s(130, -300)]); // the pen comes back down, still above where the ink stopped
	expect(bboxOf().y, "no jump while the pen is above the stop point").toBe(0);
	proto.lassoMove!.call(o, [s(130, 30)]); // the stop point was pen y 10; now 20 below it
	expect(bboxOf().y, "the grab point is under the pen again").toBe(20);
	proto.lassoUp!.call(o);
	expect(bboxOf().y).toBe(20);
});

it("the wall for insert space: the ink stops at the top, and follows again from where it stopped, grab point under the pen", () => {
	const doc = Text.of(["one line of text"]);
	const o = overlay({ view: { state: { doc }, dispatch: () => {} }, stampInkIdentity: (op: unknown) => op, clearSpaceFeedback() {} });
	Object.assign(o, {
		spacePlan: { y: 30, from: doc.length, lineHeight: 24, text: false, doc },
		spaceLineY: 30, spaceFromY: 50, spaceTotalDy: 0, spaceIds: ["s1"], spaceBounds: { ...stroke.bbox }, spaceHistoryIdentity: null,
	});
	proto.spaceMove!.call(o, [s(130, -400)]); // ink top 40, grab 50: stops at 0 when the pen passes 10
	expect(bboxOf().y, "stopped at the top").toBe(0);
	proto.spaceMove!.call(o, [s(130, -300)]); // the pen comes back down, still above where the ink stopped
	expect(bboxOf().y, "no jump while the pen is above the stop point").toBe(0);
	proto.spaceMove!.call(o, [s(130, 30)]); // the stop point was pen y 10; now 20 below it
	expect(bboxOf().y, "the grab point is under the pen again").toBe(20);
});

it("the wall leaves sideways movement alone", () => {
	const o = overlay();
	(o.selection as SelectionModel).selectExactly(["s1"]);
	proto.lassoDown!.call(o, s(130, 50));
	proto.lassoMove!.call(o, [s(300, -400)]);
	proto.lassoUp!.call(o);
	expect(bboxOf().x, "the whole sideways distance").toBe(100 + 170);
	expect(bboxOf().y).toBe(0);
});

it("ink already above the top can be dragged down, not further up", () => {
	inlineInk.handleDelete(NOTE);
	inlineInk.applyAdd(NOTE, [{ ...structuredClone(stroke), bbox: { x: 100, y: -100, width: 60, height: 20 },
		points: [{ x: 100, y: -100, pressure: 0.5, t: 0 }, { x: 160, y: -80, pressure: 0.5, t: 8 }] } as InkStroke]);
	const o = overlay();
	(o.selection as SelectionModel).selectExactly(["s1"]);
	proto.lassoDown!.call(o, s(130, -90));
	proto.lassoMove!.call(o, [s(130, -500)]);
	expect(bboxOf().y, "not further up").toBe(-100);
	proto.lassoMove!.call(o, [s(130, -60)]);
	expect(bboxOf().y, "down by the pen's distance below the grab point").toBe(-70);
	proto.lassoUp!.call(o);
});

it("the wall at 200 percent: the top in note units, not screen pixels", () => {
	const o = overlay({ scale: 2, cssScale: 2, camera: { screenToWorld: (x: number, y: number) => ({ x: x / 2, y: y / 2 }) } });
	(o.selection as SelectionModel).selectExactly(["s1"]);
	proto.lassoDown!.call(o, s(260, 100)); // note (130, 50)
	proto.lassoMove!.call(o, [s(260, -4000)]);
	proto.lassoUp!.call(o);
	expect(bboxOf().y).toBe(0);
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
