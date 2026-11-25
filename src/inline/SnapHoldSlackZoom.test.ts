/**
 * The pen's hold reads the same on screen at every zoom.
 *
 * A held shape shows when the pen stays within 4 screen px of where it stopped for 350 ms, and once it shows, the drag
 * that resizes it starts at the first sample more than 4 screen px from there. The samples reach the preview in note px
 * (the router maps each client distance through visualToNote at the note's cssScale), so the slack has to go through the
 * same mapping: a bare 4 in note px is 16 screen px at 400 percent, where a slow straight stroke reads as held and turns
 * into a line under the pen, and 1 screen px at 25 percent, where no real hold is still enough.
 *
 * The rig is the overlay's own pen path (penDown, penRaw, penUp) with the note's scale set the way the overlay holds it:
 * cssScale k, scale k times the font zoom, the camera's zoom the font zoom. Every sample is a screen distance mapped
 * through visualToNote(d, k), as the router hands it on.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InkOverlayPlugin, inlineInk, setShapeSnap } from "./InkOverlay";
import { SnapPreview, SnapPreviewCanvas } from "./SnapPreview";
import { visualToNote } from "./ZoomScale";
import { StrokeIndex } from "../ink/StrokeIndex";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { snapStroke } from "../ink/ShapeSnap";
import { DEFAULT_PEN } from "../ink/PenStyle";
import type { InkOp } from "./InkHistory";
import type { InkStroke } from "../ink/Stroke";

const path = "snap-hold-slack-zoom-note.md";
const FRAME_MS = 16;
const realPath2D = (globalThis as { Path2D?: unknown }).Path2D;

function fakeEl(): any {
	const ctx = new Proxy({}, { get: (t: any, k) => (k in t ? t[k] : (t[k] = () => {})) });
	let w = 0, h = 0;
	return {
		style: {}, className: "", children: [] as any[], parentElement: null,
		get width() { return w; }, set width(v: number) { w = v; },
		get height() { return h; }, set height(v: number) { h = v; },
		setAttribute() {}, remove() {}, getContext: () => ctx,
		createEl: () => fakeEl(),
		appendChild(this: any, child: any) { this.children.push(child); child.parentElement = this; },
	};
}

beforeEach(() => {
	vi.useFakeTimers(); setShapeSnap(true);
	inlineInk.applyRemove(path, inlineInk.strokes(path).map(stroke => stroke.id));
	(globalThis as { Path2D?: unknown }).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} arc() {} bezierCurveTo() {} quadraticCurveTo() {} };
});
afterEach(() => {
	vi.restoreAllMocks(); vi.useRealTimers(); setShapeSnap(true);
	(globalThis as { Path2D?: unknown }).Path2D = realPath2D;
});

/** The overlay at note scale k and font zoom f, as the zoom commit leaves it: cssScale k, scale k * f, camera zoom f. */
function rig(k: number, f = 1) {
	const v = Object.create(InkOverlayPlugin.prototype) as any;
	const ops: InkOp[] = [];
	const ctx = { beginPath(){}, moveTo(){}, lineTo(){}, closePath(){}, arc(){}, fill(){}, stroke(){}, save(){}, restore(){} };
	const wet = { clear(){}, clearStroke(){}, countPainted: () => 0, appendPoint(){}, beginStroke(){}, contactHalfWidth:()=>1, head: () => null };
	const container = fakeEl();
	Object.defineProperty(container, "offsetWidth", { get: () => 800 });
	Object.defineProperty(container, "offsetHeight", { get: () => 600 });
	Object.assign(v, { mode:"ink", strokePenGesture:true, strokeRawMax:0, mouseStroke:false, strokeGain:1,
		builder:null, frameTicking:false, scrollsDuringStroke:0, scale:k * f, fontZoom:f, cssWidth:800, cssHeight:600, dpr:2, cssScale:k, pinchScaleNow:k,
		container, inkLayer: fakeEl(), wet, penStyle:{...DEFAULT_PEN}, highlighterStyle:{...DEFAULT_PEN}, activeStyle:{...DEFAULT_PEN}, rawLastMoveT:0, rawLastMoveX:0, rawLastMoveY:0,
		strokeIndex:new StrokeIndex(), indexDirty:true, repaintQueued:false, activeWet:wet, highlightWet:wet,
		highlightWetCanvas:{setCssStyles(){}}, tail:{clear(){},clearAll(){},drawHead(){},configureInlineBacking(){},placeInline(){},restoreFullSurface(){},prepareLive(){}}, committedCtx:ctx,highlightCtx:ctx,
		damage:{addRect(){},addAll(){}},eraserEl:null,frame:{end(){},cancel(){},begin(){}},
		viewportPan:{x:0,y:0}, previewInkOffset:0,
		boundReadout:{floorX:0,floorY:0,bx:0,width:0,rawX:0,cx:0,rawY:0,cy:0,dragFrame:false,neverZoomed:false,steady:false,next:0,fromScale:0,fromScaleValid:false,restCeilX:0,startX:0,startY:0,lastX:0,lastY:0,bounded:false,settling:false},
		selection:{clear(){},prune(){},isEmpty:true}, selectionDeleteKeys:{reset(){}},
		erased:[],erasePieces:new Set(),eraseFrom:[],eraseWhole:false, predReal:[],predLastTail:[],
		camera:{snapshot:{x:0,y:0,zoom:f},screenToWorld:(x:number,y:number)=>({x:x/f,y:y/f})},
		view:{hasFocus:true,dom:{ownerDocument:{defaultView:{setTimeout:(fn:()=>void,ms:number)=>setTimeout(fn,ms),clearTimeout:(id:number)=>clearTimeout(id),
			requestAnimationFrame:(fn:(t:number)=>void)=>setTimeout(()=>fn(Date.now()),FRAME_MS),cancelAnimationFrame:(id:number)=>clearTimeout(id)}}}},
		filePath:()=>path,updateHandwritingPageClass(){},repaintPath(){},updateExtent(){},recordCommitDiagnostics(){},
		scheduleRepaint(){},hidePenCursor(){},hideEraserCursor(){},showSnapCursor(){},schedulePresentProbe(){},drawPredictedTail(){},
		syncCamera(){},recordPenDownState(){},ensurePenTools(){},startFrameTicker(){},probeSample(){},
		dispatchInk:(op:InkOp)=>ops.push(op)
	});
	let t = 0;
	/** A client point, in screen px from the overlay's corner, as the router hands it on. */
	const sample = (sx: number, sy: number) => ({ x: visualToNote(sx, k), y: visualToNote(sy, k), pressure: 0.5, timestamp: t });
	const down = (sx: number, sy: number) => v.penDown(sample(sx, sy), { pointerType:"pen", pointerId:7, buttons:1, button:0 });
	const at = (sx: number, sy: number) => v.penRaw([sample(sx, sy)], { timeStamp: t });
	const wait = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };
	const up = () => v.penUp({ type:"pointerup", pointerType:"pen", pointerId:7, buttons:0, pressure:0 });
	// The rig holds the scale the way the overlay does, and the samples are mapped, not raw screen px.
	expect(v.cssScale, "premise: the note's scale").toBe(k);
	expect(v.scale, "premise: scale is cssScale times the font zoom").toBe(k * f);
	expect(v.camera.snapshot.zoom, "premise: the camera carries the font zoom").toBe(f);
	expect(sample(8, 0).x, "premise: a sample is its screen distance over the note's scale").toBeCloseTo(8 / k, 9);
	return { v, ops, down, at, wait, up };
}

type Rig = ReturnType<typeof rig>;

/** A straight stroke along y = 100 from x0 to x1 (screen px), one sample every 8 ms, each step more than 4 screen px. */
function line(r: Rig, x0: number, x1: number, step: number) {
	r.down(x0, 100);
	for (let x = x0 + step; x <= x1; x += step) { r.wait(8); r.at(x, 100); }
}

/** The pen rests at x (screen px), its samples moving between x and x + d along the line every 50 ms, for ms. */
function rest(r: Rig, x: number, d: number, ms: number) {
	for (let i = 1; i * 50 <= ms; i++) { r.wait(50); r.at(i % 2 ? x + d : x, 100); }
}

/** One pen contact at scale k: 20 samples 250 ms apart, each 10 screen px further along a straight line, then the lift. */
function slowStroke(k: number) {
	const r = rig(k);
	const show = vi.spyOn(SnapPreviewCanvas.prototype, "show");
	r.down(40, 100);
	const held: number[] = [];
	for (let i = 1; i <= 20; i++) {
		r.wait(250);
		r.at(40 + i * 10, 100);
		if (r.v.snapPreview?.holding) held.push(i);
	}
	const shown = show.mock.calls.length;
	r.up();
	const saved = inlineInk.strokes(path).at(-1)!;
	return { held, shown, ops: r.ops.map(op => op.type), saved };
}

it("zoomed in to 400 percent, a slow straight stroke stays freehand: a 10 screen px step every 250 ms is no pause", () => {
	const s = slowStroke(4);
	expect(s.held, "samples after which a shape was holding").toEqual([]);
	expect(s.shown, "shapes shown during the stroke").toBe(0);
	expect(s.ops, "the lift commits the freehand and replaces nothing").toEqual(["add"]);
	const first = s.saved.points[0]!, last = s.saved.points.at(-1)!;
	expect([first.x, first.y], "the committed stroke starts at the first sample").toEqual([visualToNote(40, 4), visualToNote(100, 4)]);
	expect([last.x, last.y], "the committed stroke ends at the last sample").toEqual([visualToNote(240, 4), visualToNote(100, 4)]);
});

it("at 100 percent the same slow stroke stays freehand, before the fix and after", () => {
	const s = slowStroke(1);
	expect(s.held, "samples after which a shape was holding").toEqual([]);
	expect(s.shown, "shapes shown during the stroke").toBe(0);
	expect(s.ops, "the lift commits the freehand and replaces nothing").toEqual(["add"]);
});

it("zoomed out to 25 percent, a real rest shows the shape: samples within 1.2 screen px for 600 ms are a pause", () => {
	const r = rig(0.25);
	const show = vi.spyOn(SnapPreviewCanvas.prototype, "show");
	line(r, 40, 160, 5);
	expect(show, "premise: nothing shows while the pen draws the line").not.toHaveBeenCalled();
	rest(r, 160, 1.2, 600);
	expect(show, "a rest within 1.2 screen px shows the shape").toHaveBeenCalled();
	expect(r.v.snapPreview?.holding, "the pen holds the shown shape").toBe(true);
});

it("at 400 percent a real hold still shows the shape: samples within 3 screen px for 400 ms", () => {
	const r = rig(4);
	const show = vi.spyOn(SnapPreviewCanvas.prototype, "show");
	line(r, 40, 280, 8);
	expect(show, "premise: nothing shows while the pen draws the line").not.toHaveBeenCalled();
	rest(r, 280, 3, 400);
	expect(show, "a hold within 3 screen px shows the shape").toHaveBeenCalled();
	expect(r.v.snapPreview?.holding, "the pen holds the shown shape").toBe(true);
});

it("at 400 percent the drag of a shown shape starts 6 screen px from the hold: the next move resizes it", () => {
	const r = rig(4);
	const show = vi.spyOn(SnapPreviewCanvas.prototype, "show");
	// 200 screen px is 50 note px: the hold at the far end is 25 world px from the line's centre, past the no-resize reach.
	line(r, 40, 240, 8);
	rest(r, 240, 0, 400);
	expect(r.v.snapPreview?.holding, "premise: the shape shows").toBe(true);
	const fitted = show.mock.calls.at(-1)![2] as InkStroke;
	show.mockClear();
	r.wait(8); r.at(246, 100); r.wait(FRAME_MS);
	r.wait(8); r.at(266, 100); r.wait(FRAME_MS);
	expect(show, "the move after the drag's start shows the figure again").toHaveBeenCalled();
	const resized = show.mock.calls.at(-1)![2] as InkStroke;
	expect(resized.bbox.width, "the shown figure is resized").toBeGreaterThan(fitted.bbox.width + 1);
});

it("with the note's font zoomed 2 at 400 percent, the slack reads the note's scale, not the scale the font zoom rides on", () => {
	const r = rig(4, 2);
	const show = vi.spyOn(SnapPreviewCanvas.prototype, "show");
	line(r, 40, 440, 8);
	expect(show, "premise: nothing shows while the pen draws the line").not.toHaveBeenCalled();
	// 3 screen px is 0.75 note px at 400 percent: inside 4 screen px; outside it if the slack read scale 8.
	rest(r, 440, 3, 400);
	expect(show, "a hold within 3 screen px shows the shape").toHaveBeenCalled();
	expect(r.v.snapPreview?.holding, "the pen holds the shown shape").toBe(true);
});

/** The preview alone, its host reporting scale k: the old unit rig's 16-point line, the dwell from x = 120. */
function unit(k: number) {
	const builder = new StrokeBuilder("pen", "#112233", 2);
	builder.start(0);
	for (let i = 0; i < 16; i++) builder.add(i * 8, i % 2, 0.5, i * 8);
	const show = vi.fn(() => true);
	// A host object, not a literal at the call: the scale field is optional and new.
	const host = { clock: { setTimeout: (fn: TimerHandler, ms?: number) => setTimeout(fn as () => void, ms) as unknown as number, clearTimeout: (id: number) => clearTimeout(id) },
		valid: () => true, snapshot: () => builder.snapshotReleaseFiltered(), show, hide: () => {}, scale: () => k };
	const p = new SnapPreview(host, snapStroke);
	p.start(120, 1);
	return { p, show };
}

it.each([["0", 0], ["NaN", Number.NaN]])("a note scale of %s reads as 1, as the router maps it: steps are no pause, a rest is", (_name, k) => {
	const r = unit(k);
	for (let i = 1; i <= 8; i++) { vi.advanceTimersByTime(250); r.p.move(120 + i * 10, 1); }
	expect(r.show, "10 px steps 250 ms apart show nothing").not.toHaveBeenCalled();
	for (let i = 1; i <= 8; i++) { vi.advanceTimersByTime(50); r.p.move(i % 2 ? 203 : 200, 1); }
	expect(r.show, "a rest within 3 px for 400 ms shows the shape").toHaveBeenCalledTimes(1);
	expect(r.p.holding, "the shape is held").toBe(true);
});
