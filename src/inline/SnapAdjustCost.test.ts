/**
 * What adjusting a snapped shape costs (resizing or turning it with the pen still down), and the bar it is held to.
 *
 * Every pen event after the shape shows goes to SnapPreview.move. A 240 Hz pen sends four events per 60 Hz frame, and a
 * screen shows one picture per frame, so the shape is shown at most once per animation frame, from the newest sample:
 * at most one read of the backing per shown frame (two layout reads, offsetWidth and offsetHeight) and none while the
 * camera and the pane are unchanged, a canvas resize only when the figure outgrows the canvas (else a clearRect), and no
 * more than 176 drawing calls per shown frame (one figure drawn, plus a clearRect). A lift between frames shows the newest sample before it commits, so the
 * shape committed is the newest sample and the last one shown.
 *
 * Counted over a run of adjust events, one sample each, 4.17 ms apart, frames every 16 ms: layout reads, preview shows,
 * canvas width and height writes, Path2D builds and drawing calls on the preview's context. Printed as one JSON line
 * (and appended to HW_SPEED_OUT when set; vitest hides console output on a pass).
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendFileSync } from "node:fs";
import { InkOverlayPlugin, inlineInk, setShapeSnap } from "./InkOverlay";
import { SnapPreviewCanvas } from "./SnapPreview";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DEFAULT_PEN } from "../ink/PenStyle";
import type { InkOp } from "./InkHistory";
import type { InkStroke } from "../ink/Stroke";

declare module "node:fs" { export function appendFileSync(path: string, data: string): void; }
declare const process: { env: Record<string, string | undefined> };
const OUT = process.env.HW_SPEED_OUT ?? "";

const path = "snap-adjust-cost-note.md";
const EVENTS = 40;
const EVENT_MS = 1000 / 240;
const FRAME_MS = 16;
/** One figure drawn as before (175 calls on this line) plus the clearRect a canvas that fits takes. */
const CTX_CALLS_PER_FRAME = 176;

const counts = { layout: 0, widthWrites: 0, ctxCalls: 0, path2d: 0, frames: 0 };
const realPath2D = (globalThis as { Path2D?: unknown }).Path2D;

function fakeEl(): any {
	const ctx = new Proxy({}, { get: (t: any, k) => (k in t ? t[k] : (t[k] = () => { counts.ctxCalls++; })) });
	let w = 0, h = 0;
	return {
		style: {}, className: "", children: [] as any[], parentElement: null,
		get width() { return w; }, set width(v: number) { counts.widthWrites++; w = v; },
		get height() { return h; }, set height(v: number) { counts.widthWrites++; h = v; },
		setAttribute() {}, remove() {}, getContext: () => ctx,
		createEl: () => fakeEl(),
		appendChild(this: any, child: any) { this.children.push(child); child.parentElement = this; },
	};
}

beforeEach(() => {
	vi.useFakeTimers(); setShapeSnap(true);
	inlineInk.applyRemove(path, inlineInk.strokes(path).map(stroke => stroke.id));
	(globalThis as { Path2D?: unknown }).Path2D = class { constructor() { counts.path2d++; } addPath() {} moveTo() {} lineTo() {} closePath() {} arc() {} bezierCurveTo() {} quadraticCurveTo() {} };
});
afterEach(() => {
	vi.restoreAllMocks(); vi.useRealTimers(); setShapeSnap(true);
	(globalThis as { Path2D?: unknown }).Path2D = realPath2D;
});

function rig() {
	const v = Object.create(InkOverlayPlugin.prototype) as any;
	const ops: InkOp[] = [];
	const ctx = { beginPath(){}, moveTo(){}, lineTo(){}, closePath(){}, arc(){}, fill(){}, stroke(){}, save(){}, restore(){} };
	const wet = { clear(){}, clearStroke(){}, countPainted: () => 0, appendPoint(){}, beginStroke(){}, contactHalfWidth:()=>1, head: () => null };
	const container = fakeEl();
	Object.defineProperty(container, "offsetWidth", { get: () => { counts.layout++; return 800; } });
	Object.defineProperty(container, "offsetHeight", { get: () => { counts.layout++; return 600; } });
	Object.assign(v, { mode:"ink", strokePenGesture:true, strokeRawMax:0, mouseStroke:false, strokeGain:1,
		builder:null, frameTicking:false, scrollsDuringStroke:0, scale:1, cssWidth:800, cssHeight:600, dpr:2, cssScale:1, pinchScaleNow:1,
		container, inkLayer: fakeEl(), wet, penStyle:{...DEFAULT_PEN}, highlighterStyle:{...DEFAULT_PEN}, activeStyle:{...DEFAULT_PEN}, rawLastMoveT:0, rawLastMoveX:0, rawLastMoveY:0,
		strokeIndex:new StrokeIndex(), indexDirty:true, repaintQueued:false, activeWet:wet, highlightWet:wet,
		highlightWetCanvas:{setCssStyles(){}}, tail:{clear(){},clearAll(){},drawHead(){},configureInlineBacking(){},placeInline(){},restoreFullSurface(){},prepareLive(){}}, committedCtx:ctx,highlightCtx:ctx,
		damage:{addRect(){},addAll(){}},eraserEl:null,frame:{end(){},cancel(){},begin(){}},
		viewportPan:{x:0,y:0}, previewInkOffset:0,
		boundReadout:{floorX:0,floorY:0,bx:0,width:0,rawX:0,cx:0,rawY:0,cy:0,dragFrame:false,neverZoomed:false,steady:false,next:0,fromScale:0,fromScaleValid:false,restCeilX:0,startX:0,startY:0,lastX:0,lastY:0,bounded:false,settling:false},
		selection:{clear(){},prune(){},isEmpty:true}, selectionDeleteKeys:{reset(){}},
		erased:[],erasePieces:new Set(),eraseFrom:[],eraseWhole:false, predReal:[],predLastTail:[],
		camera:{snapshot:{x:0,y:0,zoom:1},screenToWorld:(x:number,y:number)=>({x,y})},
		view:{hasFocus:true,dom:{ownerDocument:{defaultView:{setTimeout:(fn:()=>void,ms:number)=>setTimeout(fn,ms),clearTimeout:(id:number)=>clearTimeout(id),
			requestAnimationFrame:(fn:(t:number)=>void)=>setTimeout(()=>{ counts.frames++; fn(Date.now()); },FRAME_MS),cancelAnimationFrame:(id:number)=>clearTimeout(id)}}}},
		filePath:()=>path,updateHandwritingPageClass(){},repaintPath(){},updateExtent(){},recordCommitDiagnostics(){},
		scheduleRepaint(){},hidePenCursor(){},hideEraserCursor(){},showSnapCursor(){},schedulePresentProbe(){},drawPredictedTail(){},
		syncCamera(){},recordPenDownState(){},ensurePenTools(){},startFrameTicker(){},probeSample(){},
		dispatchInk:(op:InkOp)=>ops.push(op)
	});
	v.penDown({x:20,y:30,pressure:0.5,timestamp:0},{pointerType:"pen",pointerId:7,buttons:1,button:0});
	const raw = (x:number,y:number,t:number) => v.penRaw([{x,y,pressure:0.5,timestamp:t}],{timeStamp:t});
	const up = () => v.penUp({ type:"pointerup", pointerType:"pen", pointerId:7, buttons:0, pressure:0 });
	for (let i = 1; i < 16; i++) raw(20 + i * 8, 30 + i % 2, i * 8);
	return { v, raw, up, ops };
}

/** Hold until the shape shows, then clear the counters: what follows is the adjust alone. */
function held(r: ReturnType<typeof rig>) {
	const show = vi.spyOn(SnapPreviewCanvas.prototype, "show");
	vi.advanceTimersByTime(350);
	expect(show, "premise: the shape showed").toHaveBeenCalled();
	expect(r.v.snapPreview?.holding, "premise: the pen holds the shown shape").toBe(true);
	show.mockClear();
	for (const k of Object.keys(counts) as Array<keyof typeof counts>) counts[k] = 0;
	return show;
}

/** One pen event per 240 Hz tick, the clock moved on after each so the frames fall where a 60 Hz screen puts them. */
function drive(r: ReturnType<typeof rig>, at: (i: number) => [number, number], each?: (i: number) => void) {
	for (let i = 1; i <= EVENTS; i++) {
		each?.(i);
		const [x, y] = at(i);
		r.raw(x, y, 400 + i * EVENT_MS);
		vi.advanceTimersByTime(EVENT_MS);
	}
	vi.advanceTimersByTime(FRAME_MS);
}

function report(name: string, shows: number) {
	const per = (n: number) => Math.round(n / EVENTS * 100) / 100;
	const line = `${name} ${JSON.stringify({ events: EVENTS, shows, ...counts, perEvent: { layout: per(counts.layout), shows: per(shows),
		widthWrites: per(counts.widthWrites), ctxCalls: per(counts.ctxCalls), path2d: per(counts.path2d) } })}`;
	// eslint-disable-next-line no-console
	console.log(line);
	if (OUT) appendFileSync(OUT, `${line}\n`);
}

it("adjusting a snapped shape outward: at most one show per frame, no layout read while the camera holds, at most one canvas resize per show", () => {
	const r = rig();
	const show = held(r);
	// The pen pulls the line's end outward and down: the figure grows every event.
	drive(r, i => [140 + i * 3, 31 + i * 2]);
	const shows = show.mock.calls.length;
	report("SNAP-ADJUST", shows);
	expect(shows, "premise: the adjust events reached the preview").toBeGreaterThan(0);
	expect(shows, "preview shows, one per frame at most").toBeLessThanOrEqual(counts.frames);
	expect(counts.layout, "layout reads with the camera and the pane unchanged").toBe(0);
	expect(counts.widthWrites, "canvas width and height writes, one resize per show at most").toBeLessThanOrEqual(2 * shows);
	expect(counts.ctxCalls / shows, "drawing calls per shown frame").toBeLessThanOrEqual(CTX_CALLS_PER_FRAME);
});

it("adjusting a snapped shape inward: the figure fits the canvas it has, so the canvas is cleared, never resized", () => {
	const r = rig();
	const show = held(r);
	// Along the line toward its centre, so the turn stays inside the right-angle snap and only the size changes.
	drive(r, i => [140 - i * 0.75, 31]);
	report("SNAP-ADJUST-SHRINK", show.mock.calls.length);
	expect(show.mock.calls.length, "premise: the shrinking figure was shown").toBeGreaterThan(1);
	expect(counts.widthWrites, "canvas width and height writes while the figure shrinks").toBe(0);
});

it("a camera that moves every event: the backing is read again, at most once per shown frame", () => {
	const r = rig();
	const show = held(r);
	drive(r, i => [140 + i * 3, 31 + i * 2], i => { r.v.camera.snapshot = { x: i * 0.5, y: 0, zoom: 1 }; });
	const shows = show.mock.calls.length;
	report("SNAP-ADJUST-CAMERA", shows);
	expect(counts.layout, "premise: a moved camera reads the backing again").toBeGreaterThan(0);
	expect(counts.layout, "layout reads, one read of the backing per shown frame at most").toBeLessThanOrEqual(2 * shows);
});

it("a lift between frames shows the newest sample and commits it: the shape committed is the last shown", () => {
	const commitAfter = (frameFirst: boolean) => {
		inlineInk.applyRemove(path, inlineInk.strokes(path).map(stroke => stroke.id));
		const r = rig();
		const show = held(r);
		drive(r, i => [140 + i * 3, 31 + i * 2]);
		const framed = show.mock.calls.length;
		// Two more samples, the second the newest, and no frame between them and the lift.
		r.raw(300, 120, 900); r.raw(320, 130, 904);
		if (frameFirst) vi.advanceTimersByTime(FRAME_MS);
		const before = show.mock.calls.length;
		r.up();
		const saved = inlineInk.strokes(path).at(-1)!;
		const last = show.mock.calls.at(-1)![2] as InkStroke;
		const after = show.mock.calls.length;
		show.mockRestore();
		// Geometry and times: the pressure gain learns across strokes, so the second rig's pressures differ from the first's.
		const shape = (s: InkStroke) => s.points.map(p => ({ x: p.x, y: p.y, t: p.t }));
		return { framed, before, after, saved: shape(saved), last: shape(last), ops: r.ops.map(op => op.type) };
	};
	const between = commitAfter(false);
	const settled = commitAfter(true);
	expect(between.ops, "premise: the lift committed the shape").toEqual(["add", "replace"]);
	expect(between.before, "premise: the newest samples were not shown before the lift").toBe(between.framed);
	expect(between.after, "the lift shows the newest sample before it commits").toBe(between.before + 1);
	expect(between.saved, "committed = last shown").toEqual(between.last);
	expect(between.saved, "committed = the newest sample, the same shape a frame would have shown").toEqual(settled.saved);
});
