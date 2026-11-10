/**
 * Snap drag: once the clean shape shows, the pen keeps it.
 *
 * Every move after the shape shows resizes and turns it about the centre of
 * its box: the distance from the centre now over the distance at the drag's
 * first move is the size, the angle about the centre the turn. The size stays
 * within 0.25 and 4; lines, rectangles and triangles settle on a right angle
 * within 4 degrees; circles never turn. Those moves are not ink: the stroke
 * under the shape stops where the shape showed, and nothing of it is drawn
 * after. Whatever ends the gesture commits exactly the shape as it shows, the
 * same points the preview drew; a zoom, a layout change, or a tool, colour or
 * size change clears it first, and the stroke stays freehand.
 *
 * Driven through the real SnapPreview with the real fitter (unit cells) and
 * through the overlay's real penDown, penRaw and penUp (overlay cells).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SnapPreview, SnapPreviewCanvas } from "./SnapPreview";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import * as ShapeSnap from "../ink/ShapeSnap";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { InkOverlayPlugin, inlineInk, instances, setShapeSnap, setInlineTool, getInlineTool, setInkSizeMult, getInkSizeMult } from "./InkOverlay";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DEFAULT_PEN } from "../ink/PenStyle";
import { getInkColorHex, setInkColorHex } from "../ink/InkColor";
import { invertInkOp, type InkOp } from "./InkHistory";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const DEG = Math.PI / 180;
type Pt = [number, number];

/** A note at zoom 2, scrolled to (10, 20): screen = (world - origin) * 2, so a drag that measured in screen px would be off by half. */
const toWorld = (x: number, y: number) => ({ x: x / 2 + 10, y: y / 2 + 20 });
const toScreen = (x: number, y: number) => ({ x: (x - 10) * 2, y: (y - 20) * 2 });

function along(corners: Pt[], step: number): Pt[] {
	const out: Pt[] = [];
	for (let i = 0; i + 1 < corners.length; i++) {
		const [ax, ay] = corners[i]!, [bx, by] = corners[i + 1]!;
		const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
		for (let k = 0; k < n; k++) out.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
	}
	out.push(corners[corners.length - 1]!);
	return out;
}
const oval = (rx: number, ry: number, n = 48): Pt[] =>
	Array.from({ length: n + 1 }, (_, i) => [60 + rx * Math.cos(2 * Math.PI * i / n), 40 + ry * Math.sin(2 * Math.PI * i / n)] as Pt);
/** Away from the top and left walls, so a drag that grows or turns a figure here is never slid back onto a wall. */
const offWalls = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [x + 400, y + 300] as Pt);
const SHAPES: Record<"rectangle" | "line" | "ellipse" | "circle", Pt[]> = {
	rectangle: offWalls(along([[0, 0], [120, 0], [120, 80], [0, 80], [0, 0]], 6)),
	line: offWalls(Array.from({ length: 21 }, (_, i) => [i * 8, i % 2 ? 0.5 : 0] as Pt)),
	ellipse: offWalls(oval(80, 30)),
	circle: offWalls(oval(50, 50)),
};

/** The figure scaled and turned about c, written out here so the cell does not borrow the code under test. */
function expected(base: InkStroke, c: { x: number; y: number }, scale: number, angle: number): Array<{ x: number; y: number }> {
	return base.points.map(p => ({
		x: c.x + scale * (Math.cos(angle) * (p.x - c.x) - Math.sin(angle) * (p.y - c.y)),
		y: c.y + scale * (Math.sin(angle) * (p.x - c.x) + Math.cos(angle) * (p.y - c.y)),
	}));
}
function within(got: InkStroke, want: Array<{ x: number; y: number }>, tol = 0.1): number {
	expect(got.points.length).toBe(want.length);
	let worst = 0;
	got.points.forEach((p, i) => { worst = Math.max(worst, Math.abs(p.x - want[i]!.x), Math.abs(p.y - want[i]!.y)); });
	expect(worst).toBeLessThanOrEqual(tol);
	return worst;
}

function shapeRig(kind: keyof typeof SHAPES) {
	const pts = SHAPES[kind];
	const builder = new StrokeBuilder("pen", "#112233", 2);
	builder.start(0);
	pts.forEach(([x, y], i) => builder.add(x, y, 0.5, i * 8));
	const shows: InkStroke[] = [];
	let paints = true;
	const hide = vi.fn();
	const p = new SnapPreview({
		clock: { setTimeout: (fn: TimerHandler, ms?: number) => setTimeout(fn as () => void, ms) as unknown as number, clearTimeout: (id: number) => clearTimeout(id) },
		valid: () => true,
		snapshot: () => builder.snapshotReleaseFiltered(),
		show: s => { if (!paints) return false; shows.push(s); return true; },
		hide,
		world: toWorld,
	});
	const [lx, ly] = pts[pts.length - 1]!;
	const start = toScreen(lx, ly);
	p.start(start.x, start.y);
	vi.advanceTimersByTime(350);
	// Proof of reach: the real fitter showed the figure the cell is about.
	expect(shows).toHaveLength(1);
	const base = shows[0]!;
	expect(ShapeSnap.snapKindOf(base)).toBe(kind);
	const c = { x: base.bbox.x + base.bbox.width / 2, y: base.bbox.y + base.bbox.height / 2 };
	/** The pen at world (c + r at angle a). */
	const at = (r: number, a = 0) => { const s = toScreen(c.x + r * Math.cos(a), c.y + r * Math.sin(a)); return p.move(s.x, s.y); };
	return { p, builder, shows, base, c, at, hide, start, stopPainting: () => { paints = false; } };
}

describe("the drag adjusts the shown shape", () => {
	it("scale: twice the reach at the drag's first move draws the figure twice the size about its box centre, measured in world units", () => {
		const r = shapeRig("rectangle");
		expect(r.at(20)).toBe(true);
		expect(r.shows).toHaveLength(1);
		r.at(40);
		const got = r.shows.at(-1)!;
		within(got, expected(r.base, r.c, 2, 0));
		expect(got.bbox).toEqual(computeBBox(got.points, got.width * 2));
		expect({ ...got, points: [], bbox: null }).toEqual({ ...r.base, points: [], bbox: null });
	});

	it("scale stays within 0.25 and 4", () => {
		const r = shapeRig("rectangle");
		r.at(20); r.at(200);
		within(r.shows.at(-1)!, expected(r.base, r.c, 4, 0));
		r.at(1);
		within(r.shows.at(-1)!, expected(r.base, r.c, 0.25, 0));
	});

	it("rotate: the angle about the centre turns the figure, free for an ellipse and past 4 degrees for a rectangle", () => {
		for (const kind of ["ellipse", "rectangle"] as const) {
			const r = shapeRig(kind);
			r.at(20); r.at(20, 30 * DEG);
			within(r.shows.at(-1)!, expected(r.base, r.c, 1, 30 * DEG));
		}
	});

	it("lines and rectangles settle on a right angle within 4 degrees; an ellipse does not", () => {
		const cases: Array<[keyof typeof SHAPES, number, number]> = [
			["rectangle", 88, 90], ["rectangle", 3, 0], ["line", 93, 90], ["line", -2, 0], ["line", 10, 10], ["ellipse", 3, 3], ["ellipse", 88, 88],
		];
		for (const [kind, turn, settled] of cases) {
			const r = shapeRig(kind);
			r.at(20); r.at(20, turn * DEG);
			within(r.shows.at(-1)!, expected(r.base, r.c, 1, settled * DEG));
		}
	});

	it("a circle never turns; it still resizes", () => {
		const r = shapeRig("circle");
		r.at(20); r.at(40, 30 * DEG);
		within(r.shows.at(-1)!, expected(r.base, r.c, 2, 0));
	});

	it("moves within 4 screen px of the hold change nothing: the drag starts past them", () => {
		const r = shapeRig("rectangle");
		expect(r.p.move(r.start.x + 3, r.start.y + 2)).toBe(true);
		expect(r.p.move(r.start.x - 2, r.start.y - 3)).toBe(true);
		expect(r.shows).toHaveLength(1);
		expect(r.p.take(r.builder.finishReleaseFiltered())).toBe(r.base);
	});

	it("a drag that starts within 8 world px of the centre turns the figure but keeps its size", () => {
		const r = shapeRig("ellipse");
		r.at(5); r.at(15, 30 * DEG);
		within(r.shows.at(-1)!, expected(r.base, r.c, 1, 30 * DEG));
	});
});

describe("what a gesture end takes", () => {
	it("the very object the preview drew last (one point set for preview and commit)", () => {
		const r = shapeRig("rectangle");
		r.at(20); r.at(31, 12 * DEG);
		expect(r.p.take(r.builder.finishReleaseFiltered())).toBe(r.shows.at(-1));
	});

	it("a final stroke that is not the fitted body point for point leaves the freehand", () => {
		const r = shapeRig("rectangle");
		r.at(20); r.at(30);
		r.builder.add(60, 40, 0.9, 900);
		expect(r.p.take(r.builder.finishReleaseFiltered())).toBeNull();
	});

	it("a drag that carried the shape off the band shows nothing, and nothing is taken", () => {
		const r = shapeRig("rectangle");
		r.at(20); r.stopPainting(); r.at(30);
		expect(r.p.take(r.builder.finishReleaseFiltered())).toBeNull();
	});
});

describe("through the overlay", () => {
	const path = "snap-drag-note.md";
	let shown: InkStroke | null;
	let visible = false;
	let shows = 0;
	beforeEach(() => {
		setShapeSnap(true); shown = null; visible = false; shows = 0;
		inlineInk.applyRemove(path, inlineInk.strokes(path).map(stroke => stroke.id));
		vi.spyOn(SnapPreviewCanvas.prototype, "show").mockImplementation((_parent, _cam, stroke) => { shown = stroke; visible = true; shows++; return true; });
		vi.spyOn(SnapPreviewCanvas.prototype, "clear").mockImplementation(() => { visible = false; });
	});
	afterEach(() => setShapeSnap(true));

	function rig() {
		const v = Object.create(InkOverlayPlugin.prototype) as any;
		const ops: InkOp[] = [];
		const ctx = { beginPath(){}, moveTo(){}, lineTo(){}, closePath(){}, arc(){}, fill(){}, stroke(){}, save(){}, restore(){} };
		const wet = { clear(){}, clearStroke(){}, countPainted: () => 0, appendPoint: vi.fn(), beginStroke(){}, contactHalfWidth: () => 1, head: () => null };
		const tail = { clear: vi.fn(), clearAll(){}, drawHead: vi.fn(), configureInlineBacking(){}, placeInline(){}, restoreFullSurface(){}, prepareLive: vi.fn() };
		Object.assign(v, { mode: "ink", strokePenGesture: true, strokeRawMax: 0, mouseStroke: false, strokeGain: 1,
			builder: null, frameTicking: false, scrollsDuringStroke: 0, scale: 1, cssWidth: 800, cssHeight: 600,
			container: {}, wet, penStyle: { ...DEFAULT_PEN }, highlighterStyle: { ...DEFAULT_PEN }, activeStyle: { ...DEFAULT_PEN }, rawLastMoveT: 0, rawLastMoveX: 0, rawLastMoveY: 0,
			strokeIndex: new StrokeIndex(), indexDirty: true, repaintQueued: false, activeWet: wet, highlightWet: wet,
			highlightWetCanvas: { setCssStyles(){} }, tail, committedCtx: ctx, highlightCtx: ctx,
			damage: { addRect(){}, addAll(){} }, eraserEl: null, frame: { end(){}, cancel(){}, begin(){} },
			viewportPan: { x: 0, y: 0 }, previewInkOffset: 0,
			boundReadout: { floorX: 0, floorY: 0, bx: 0, width: 0, rawX: 0, cx: 0, rawY: 0, cy: 0, dragFrame: false, neverZoomed: false, steady: false, next: 0, fromScale: 0, fromScaleValid: false, restCeilX: 0, startX: 0, startY: 0, lastX: 0, lastY: 0, bounded: false, settling: false },
			selection: { clear(){}, prune(){}, isEmpty: true }, selectionDeleteKeys: { reset(){} },
			erased: [], erasePieces: new Set(), eraseFrom: [], eraseWhole: false, predReal: [], predLastTail: [],
			camera: { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) },
			view: { hasFocus: true, dom: { ownerDocument: { defaultView: { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (id: number) => clearTimeout(id) } } } },
			filePath: () => path, updateHandwritingPageClass(){}, repaintPath(){}, updateExtent(){}, recordCommitDiagnostics(){},
			scheduleRepaint(){}, hidePenCursor(){}, hideEraserCursor(){}, schedulePresentProbe(){}, drawPredictedTail(){},
			syncCamera(){}, recordPenDownState(){}, ensurePenTools(){}, startFrameTicker(){}, probeSample(){},
			backingNow: () => 1, dispatchInk: (op: InkOp) => ops.push(op),
		});
		v.penDown({ x: 20, y: 30, pressure: 0.5, timestamp: 0 }, { pointerType: "pen", pointerId: 7, buttons: 1, button: 0 });
		const builder = v.builder as StrokeBuilder;
		let t = 0;
		const raw = (x: number, y: number, pressure = 0.5) => { t += 8; v.penRaw([{ x, y, pressure, timestamp: t }], { timeStamp: t }); };
		for (let i = 1; i < 16; i++) raw(20 + i * 8, 30 + i % 2);
		/** "no event" ends the gesture with a bare penUp(), the way a cancelled gesture does. */
		const up = (type = "pointerup", pointerId = 7) =>
			type === "no event" ? v.penUp() : v.penUp({ type, pointerType: "pen", pointerId, buttons: 0, pressure: 0 });
		/** Hold until the shape shows, then drag it: the pen past the end of the line, out and up. */
		const holdAndDrag = () => {
			vi.advanceTimersByTime(350);
			expect(visible).toBe(true);
			const body = builder.snapshotReleaseFiltered()[0]!;
			const appends = wet.appendPoint.mock.calls.length, heads = tail.drawHead.mock.calls.length, lives = tail.prepareLive.mock.calls.length;
			raw(200, 30); raw(230, 10); raw(260, -10);
			return { body, appends, heads, lives };
		};
		return { v, builder, ops, raw, up, wet, tail, holdAndDrag };
	}

	it("the drag draws no ink: the stroke stops where the shape showed, and only the preview moves", () => {
		const r = rig();
		const before = r.holdAndDrag();
		expect(r.builder.snapshotReleaseFiltered()[0]!.points).toEqual(before.body.points);
		expect(r.wet.appendPoint.mock.calls.length).toBe(before.appends);
		expect(r.tail.drawHead.mock.calls.length).toBe(before.heads);
		expect(r.tail.prepareLive.mock.calls.length).toBe(before.lives);
		expect(shown!.points).not.toEqual(before.body.points);
	});

	it("the lift commits exactly the dragged shape as shown, and one undo gives back the freehand stroke", () => {
		const r = rig();
		const { body } = r.holdAndDrag();
		const last = structuredClone(shown!);
		r.up();
		expect(r.ops.map(op => op.type)).toEqual(["add", "replace"]);
		const saved = inlineInk.strokes(path).at(-1)!;
		expect(saved.points).toEqual(last.points);
		expect(saved.bbox).toEqual(last.bbox);
		r.v.applyInkOp(invertInkOp(r.ops[1]!));
		expect(inlineInk.strokes(path).at(-1)!.points).toEqual(body.points);
	});

	it.each([["pointercancel", 7], ["lostpointercapture", 7], ["no event", 7], ["pointerup", 8]] as const)("an end by %s (pointer %s) also commits the shape as shown", (type, pointerId) => {
		const r = rig();
		r.holdAndDrag();
		const last = structuredClone(shown!);
		r.up(type, pointerId);
		expect(r.ops.map(op => op.type)).toEqual(["add", "replace"]);
		expect(inlineInk.strokes(path).at(-1)!.points).toEqual(last.points);
	});

	it("a batch of samples moves the shape once, to the newest sample: one redraw per event", () => {
		const r = rig();
		r.holdAndDrag();
		const before = shows;
		r.v.penRaw([{ x: 270, y: -20, pressure: 0.5, timestamp: 900 }, { x: 280, y: -30, pressure: 0.5, timestamp: 904 },
			{ x: 290, y: -40, pressure: 0.5, timestamp: 908 }], { timeStamp: 908 });
		expect(shows).toBe(before + 1);
		const batched = structuredClone(shown!);
		r.v.penRaw([{ x: 290, y: -40, pressure: 0.5, timestamp: 916 }], { timeStamp: 916 });
		expect(shown!.points).toEqual(batched.points);
	});

	it("a colour, tool or size change mid-drag clears the shape first, and the stroke ends freehand", () => {
		const color = getInkColorHex("pen"), tool = getInlineTool(), size = getInkSizeMult("pen");
		const changes: Array<[string, () => void]> = [
			["colour", () => setInkColorHex("pen", "#abcdef")],
			["tool", () => setInlineTool("highlighter")],
			["size", () => setInkSizeMult("pen", size * 2)],
		];
		try {
			for (const [, change] of changes) {
				const r = rig();
				r.holdAndDrag();
				change();
				r.raw(270, -20);
				expect(visible).toBe(false);
				r.up();
				expect(r.ops.map(op => op.type)).toEqual(["add"]);
				setInkColorHex("pen", color); setInlineTool(tool); setInkSizeMult("pen", size);
			}
		} finally { setInkColorHex("pen", color); setInlineTool(tool); setInkSizeMult("pen", size); }
	});

	it("a zoom or layout change mid-drag (the layout path's clearSnapPreview) clears the shape first, and the stroke ends freehand", () => {
		const r = rig();
		r.holdAndDrag();
		r.v.clearSnapPreview();
		expect(visible).toBe(false);
		r.up();
		expect(r.ops.map(op => op.type)).toEqual(["add"]);
	});

	/** The pieces a real handleResize reaches before it returns on a zero-size pane: enough to run it whole in this rig. */
	function resizable(v: any): void {
		Object.assign(v, {
			deferPinchRaster: () => false, restorePinchLayers(){}, syncBand(){}, committedCanvas: { width: 0 },
			container: { getBoundingClientRect: () => ({ width: 0, height: 0 }) },
		});
	}
	/** Hold until the shape shows and drag it 40 px along the line, so a cleared hold has somewhere for a jump to start. */
	function holdAndDrag40(r: ReturnType<typeof rig>) {
		vi.advanceTimersByTime(350);
		expect(visible).toBe(true);
		const body = r.builder.snapshotReleaseFiltered()[0]!;
		r.raw(160, 31); r.raw(180, 31);
		return { body, points: r.builder.pointCount };
	}

	it("a colour change mid-hold seals the stroke: the next sample inks no jump, and the lift commits the stroke as it stood when the shape showed", () => {
		const color = getInkColorHex("pen");
		try {
			const r = rig();
			const { body, points } = holdAndDrag40(r);
			setInkColorHex("pen", "#abcdef");
			r.raw(400, 260);
			expect(visible).toBe(false);
			expect(r.builder.pointCount, "the sample after the clear joined the stroke: a straight line to the pen").toBe(points);
			r.raw(420, 280);
			expect(r.builder.pointCount, "a later sample of the same contact inked").toBe(points);
			r.up();
			expect(r.ops.map(op => op.type)).toEqual(["add"]);
			expect(inlineInk.strokes(path).at(-1)!.points).toEqual(body.points);
		} finally { setInkColorHex("pen", color); }
	});

	it("picking the tool already in use mid-hold is not a change: the shape stays and the lift commits it", () => {
		const r = rig();
		holdAndDrag40(r);
		// Mounted, as a real overlay is: the tool pick reaches it through the open-overlay list, not only through valid().
		instances.add(r.v);
		try {
			setInlineTool(getInlineTool());
			expect(r.v.snapPreview?.holding, "the same tool picked again dropped the shape").toBe(true);
			r.raw(200, 20);
			const last = structuredClone(shown!);
			r.up();
			expect(r.ops.map(op => op.type)).toEqual(["add", "replace"]);
			expect(inlineInk.strokes(path).at(-1)!.points).toEqual(last.points);
		} finally { instances.delete(r.v); }
	});

	it("a pane resize mid-hold (the real handleResize) seals the stroke: no jump, and the lift commits the stroke as it stood", () => {
		const r = rig();
		resizable(r.v);
		const { body, points } = holdAndDrag40(r);
		r.v.handleResize();
		expect(visible).toBe(false);
		r.raw(400, 260);
		expect(r.builder.pointCount, "the sample after the resize joined the stroke: a straight line to the pen").toBe(points);
		r.up();
		expect(r.ops.map(op => op.type)).toEqual(["add"]);
		expect(inlineInk.strokes(path).at(-1)!.points).toEqual(body.points);
	});

	it("a pane resize held back by the stroke replays after the lift takes the shape: the held shape commits, and the resize still runs", () => {
		const r = rig();
		resizable(r.v);
		holdAndDrag40(r);
		const last = structuredClone(shown!);
		r.v.resizeDeferred = true;
		r.v.scaleGeometryValid = true;
		r.up();
		expect(r.ops.map(op => op.type), "the replayed resize cleared the shape before the lift took it").toEqual(["add", "replace"]);
		expect(inlineInk.strokes(path).at(-1)!.points).toEqual(last.points);
		expect(r.v.resizeDeferred, "the held-back resize never replayed").toBe(false);
		expect(r.v.scaleGeometryValid, "the held-back resize never ran").toBe(false);
	});

	it("a new contact starts unsealed: the next stroke on the same note, after a sealed one, inks as usual", () => {
		const color = getInkColorHex("pen");
		try {
			const r = rig();
			holdAndDrag40(r);
			setInkColorHex("pen", "#abcdef");
			r.raw(400, 260);
			expect(r.v.snapSealed, "the first contact did not seal (control)").toBe(true);
			r.up();
			setInkColorHex("pen", color);
			// The same overlay, a second contact: the seal belongs to the first one alone.
			r.v.penDown({ x: 300, y: 200, pressure: 0.5, timestamp: 1000 }, { pointerType: "pen", pointerId: 8, buttons: 1, button: 0 });
			const next = r.v.builder as StrokeBuilder;
			expect(next, "the second contact started no stroke").not.toBe(r.builder);
			const before = next.pointCount;
			for (let i = 1; i <= 4; i++) r.v.penRaw([{ x: 300 + i * 10, y: 200, pressure: 0.5, timestamp: 1000 + i * 8 }], { timeStamp: 1000 + i * 8 });
			expect(next.pointCount, "the next stroke on the note inherited the seal and inked nothing").toBeGreaterThan(before);
			r.v.penUp({ type: "pointerup", pointerType: "pen", pointerId: 8, buttons: 0, pressure: 0 });
			expect(r.ops.map(op => op.type), "the second stroke did not land").toEqual(["add", "add"]);
		} finally { setInkColorHex("pen", color); }
	});
});
