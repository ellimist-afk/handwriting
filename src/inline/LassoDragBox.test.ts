/**
 * The box of a live lasso drag is the box at pen-down moved by the distance
 * travelled, never a pass over the note's strokes.
 *
 * Every pen sample of a selection drag asked for the selection's box twice
 * (once before the move, once to draw it), and each ask is a pass over every
 * stroke of the note to find the few that are selected. The selection cannot
 * change mid-drag, so the box is read once at pen-down.
 *
 * Cells count calls and compare the drawn box with the truth; they never time.
 * Real `lassoDown`, `lassoMove`, `lassoUp`, `redrawSelectionUI`, `moveLive` and
 * `SelectionModel` on an overlay built with Object.create, as
 * A2-1-lasso-drag-above-top builds it. Substituted: the layer that draws
 * (a proxy that records the box it is asked to draw).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Text } from "@codemirror/state";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { InsertSpaceRows } from "./InsertSpace";
import { SelectionModel } from "../objects/SelectionModel";
import { DamageLedger } from "../ink/DamageLedger";
import { StrokeIndex } from "../ink/StrokeIndex";
import { FrontierCache } from "./FrontierCache";
import type { BBox, InkStroke } from "../ink/Stroke";

const NOTE = "lasso-drag-box.md";
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
			{ x: x + 30, y: y + 10, pressure: 0.5, t: 8 },
		],
		bbox: { x, y, width: 30, height: 10 },
		createdAt: 1,
	} as InkStroke;
}

/** Twenty strokes, of which three are selected. */
const SELECTED = ["a", "b", "c"];
const ALL = [
	stroke("a", 100, 60),
	stroke("b", 140, 90),
	stroke("c", 120, 120),
	...Array.from({ length: 17 }, (_, i) => stroke(`other${i}`, 400, 40 + i * 25)),
];

function truthBox(): BBox {
	const mine = inlineInk.strokes(NOTE).filter((st) => SELECTED.includes(st.id));
	const x0 = Math.min(...mine.map((st) => st.bbox.x));
	const y0 = Math.min(...mine.map((st) => st.bbox.y));
	const x1 = Math.max(...mine.map((st) => st.bbox.x + st.bbox.width));
	const y1 = Math.max(...mine.map((st) => st.bbox.y + st.bbox.height));
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function overlay() {
	const o = Object.create(InkOverlayPlugin.prototype) as Record<string, any>;
	const drawn: BBox[] = [];
	const noop = () => {};
	const tail = new Proxy({}, {
		get: (_t, name) => (name === "drawSelectionBox" ? (_cam: unknown, box: BBox) => drawn.push({ ...box }) : noop),
	});
	Object.assign(o, {
		filePath: () => NOTE,
		scale: 1,
		cssScale: 1,
		cssWidth: 800,
		cssHeight: 600,
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }), snapshot: { x: 0, y: 0, zoom: 1 }, zoom: 1 },
		selection: new SelectionModel(),
		damage: new DamageLedger(),
		strokeIndex: new StrokeIndex(),
		frontierCache: new FrontierCache(),
		indexDirty: true,
		dragIds: [],
		dragFrom: null,
		dragTotal: null,
		lassoActive: false,
		lassoPts: [],
		builder: null,
		tail,
		spacePreview: null,
		spacePlan: null,
		spaceRowsCache: new InsertSpaceRows(),
		scheduleRepaint: noop,
		repaintPath: noop,
		showLassoCursor: noop,
		dressTail: noop,
		dispatchInk: noop,
	});
	o.selection.selectExactly(SELECTED);
	return { o, drawn };
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	inlineInk.applyAdd(NOTE, ALL.map((st) => structuredClone(st)));
});
afterEach(() => {
	inlineInk.handleDelete(NOTE);
	vi.unstubAllGlobals();
});

describe("a live lasso drag", () => {
	it("ten samples: the selection's box is not computed from the strokes after pen-down", () => {
		const { o } = overlay();
		proto.lassoDown!.call(o, s(130, 100)); // inside the selection: grab
		const bounds = vi.spyOn(o.selection as SelectionModel, "bounds");

		for (let i = 1; i <= 10; i++) proto.lassoMove!.call(o, [s(130 + i * 5, 100 + i * 7)]);

		expect(inlineInk.strokes(NOTE)[0]!.bbox.x, "the drag moved nothing, so this cell proves nothing").toBeGreaterThan(100);
		expect(bounds, "the box was recomputed from the note's strokes during the drag").not.toHaveBeenCalled();
	});

	it("each sample: the box drawn equals the box computed from the strokes", () => {
		const { o, drawn } = overlay();
		proto.lassoDown!.call(o, s(130, 100));
		drawn.length = 0;

		for (let i = 1; i <= 10; i++) {
			proto.lassoMove!.call(o, [s(130 + i * 5, 100 + i * 7)]);
			expect(drawn.length, "nothing was drawn for the sample").toBe(i);
			expect(drawn[i - 1], `box after sample ${i}`).toEqual(truthBox());
		}
	});

	it("dragged up into the top wall: the box drawn is the box the strokes stopped at", () => {
		const { o, drawn } = overlay();
		proto.lassoDown!.call(o, s(130, 100));
		drawn.length = 0;

		proto.lassoMove!.call(o, [s(130, -400)]);
		expect(truthBox().y, "the wall did not hold, so this cell proves nothing").toBe(0);
		expect(drawn[0], "box at the wall").toEqual(truthBox());
		proto.lassoMove!.call(o, [s(130, -300)]);
		expect(drawn[1], "box while the pen is still above the stop point").toEqual(truthBox());
		proto.lassoMove!.call(o, [s(130, 150)]);
		expect(drawn[2], "box after the pen came back").toEqual(truthBox());
		expect(drawn.length).toBe(3);
	});

	it("a drag after the selection was dragged and released: the next drag starts from the new box", () => {
		const { o, drawn } = overlay();
		proto.lassoDown!.call(o, s(130, 100));
		proto.lassoMove!.call(o, [s(150, 130)]);
		proto.lassoUp!.call(o);
		proto.lassoDown!.call(o, s(150, 130));
		drawn.length = 0;

		proto.lassoMove!.call(o, [s(170, 160)]);

		expect(drawn[0], "the second drag drew the first drag's box").toEqual(truthBox());
	});
});

describe("the selection changes while the pen is still down", () => {
	it("Escape mid-drag: the next draw has no box, and the strokes stay where they were let go", () => {
		const { o, drawn } = overlay();
		proto.lassoDown!.call(o, s(130, 100));
		proto.lassoMove!.call(o, [s(150, 130)]);
		const letGo = truthBox();

		(o.selection as SelectionModel).clear(); // what Escape does
		drawn.length = 0;
		proto.redrawSelectionUI!.call(o);
		proto.lassoMove!.call(o, [s(300, 300)]);

		expect(drawn, "a box was drawn for a selection that no longer exists").toEqual([]);
		expect(truthBox(), "the strokes kept moving after the selection was cleared").toEqual(letGo);
	});

	it("the ink changes under the drag and the selected strokes are gone: no box is drawn", () => {
		const { o, drawn } = overlay();
		proto.lassoDown!.call(o, s(130, 100));
		proto.lassoMove!.call(o, [s(150, 130)]);

		const live = new Set(inlineInk.strokes(NOTE).map((st) => st.id).filter((id) => !SELECTED.includes(id)));
		(o.selection as SelectionModel).prune(live, new Set()); // what an ink change that removed them does
		drawn.length = 0;
		proto.redrawSelectionUI!.call(o);

		expect(drawn, "the frozen box outlived its selection").toEqual([]);
	});
});

describe("a fractional drag into the top wall", () => {
	it("steps that do not add up exactly: after the lift no stroke's box top is below 0", () => {
		const { o } = overlay();
		proto.lassoDown!.call(o, s(130, 100)); // grab 40 below the selection's top (60)

		// Twenty fractional steps up, then a few back and forth at the wall.
		let y = 100;
		for (let i = 0; i < 20; i++) {
			y -= 7.3 + i * 0.011;
			proto.lassoMove!.call(o, [s(130 + i * 0.37, y)]);
		}
		for (const back of [3.1, -9.7, 0.3, -11.9]) {
			y += back;
			proto.lassoMove!.call(o, [s(130, y)]);
		}
		proto.lassoUp!.call(o);

		const tops = inlineInk.strokes(NOTE).map((st) => st.bbox.y);
		expect(Math.min(...tops), "a stroke ended above the top of the note").toBeGreaterThanOrEqual(0);
		expect(truthBox().y, "the wall was never reached, so this cell proves nothing").toBeLessThan(8);
	});
});

describe("a hover preview over ink that changed", () => {
	const doc = Text.of(["one line of text"]);
	const plan = { y: 50, from: doc.length, lineHeight: 24, text: false };

	function hovering() {
		const made = overlay();
		(made.o.selection as SelectionModel).clear();
		made.o.view = { state: { doc } };
		made.o.spacePreview = proto.previewSpace!.call(made.o, plan);
		expect(made.o.spacePreview, "no preview was made, so this cell proves nothing").not.toBeNull();
		expect((made.o.spacePreview as { moving: string[] }).moving.length).toBeGreaterThan(0);
		return made;
	}

	it("a reload adds ink under it: the next draw drops the preview", () => {
		const { o } = hovering();

		inlineInk.applyAdd(NOTE, [stroke("arrived", 300, 200)]);
		proto.redrawSelectionUI!.call(o);

		expect(o.spacePreview, "the preview outlived the ink it described").toBeNull();
	});

	it("an erase removes ink under it: the next draw drops the preview", () => {
		const { o } = hovering();

		inlineInk.applyRemove(NOTE, ["other0"]);
		proto.redrawSelectionUI!.call(o);

		expect(o.spacePreview, "the preview outlived the ink it described").toBeNull();
	});

	it("the ink did not change: the preview stays", () => {
		const { o } = hovering();

		proto.redrawSelectionUI!.call(o);

		expect(o.spacePreview).not.toBeNull();
	});
});
