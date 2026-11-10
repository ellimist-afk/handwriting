import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InkOverlayPlugin, inlineInk, setShapeSnap } from "./InkOverlay";
import { SnapPreviewCanvas } from "./SnapPreview";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DEFAULT_PEN } from "../ink/PenStyle";
import { getInkColorHex, setInkColorHex } from "../ink/InkColor";
import { invertInkOp, type InkOp } from "./InkHistory";
import type { InkStroke } from "../ink/Stroke";

const path = "snap-preview-note.md";
const realShow = SnapPreviewCanvas.prototype.show;
let shown: InkStroke | null;
/** A busy main thread: while on, no timer or frame callback runs; they wait in `held`, in order, for the thread to free. */
const busy = { on: false, held: [] as (() => void)[] };
const later = (fn: () => void, ms: number) => setTimeout(() => { if (busy.on) busy.held.push(fn); else fn(); }, ms);
beforeEach(() => {
 vi.useFakeTimers(); setShapeSnap(true); shown = null; busy.on = false; busy.held = [];
 inlineInk.applyRemove(path, inlineInk.strokes(path).map(stroke => stroke.id));
 vi.spyOn(SnapPreviewCanvas.prototype, "show").mockImplementation((_parent, _cam, stroke) => { shown = stroke; return true; });
 vi.spyOn(SnapPreviewCanvas.prototype, "clear").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); setShapeSnap(true); });
function rig(frames = false) {
 const v = Object.create(InkOverlayPlugin.prototype) as any;
 const ops: InkOp[] = [];
 const ctx = { beginPath(){}, moveTo(){}, lineTo(){}, closePath(){}, arc(){}, fill(){}, stroke(){}, save(){}, restore(){} };
 const wet = { clear(){}, clearStroke(){}, countPainted: () => 0, appendPoint(){}, beginStroke(){}, contactHalfWidth:()=>1, head: () => null };
 Object.assign(v, { mode:"ink", strokePenGesture:true, strokeRawMax:0, mouseStroke:false, strokeGain:1,
  builder:null, frameTicking:false, scrollsDuringStroke:0, scale:1, cssWidth:800, cssHeight:600,
  container:{}, wet, penStyle:{...DEFAULT_PEN}, highlighterStyle:{...DEFAULT_PEN}, activeStyle:{...DEFAULT_PEN}, rawLastMoveT:0, rawLastMoveX:0, rawLastMoveY:0,
  strokeIndex:new StrokeIndex(), indexDirty:true, repaintQueued:false, activeWet:wet, highlightWet:wet,
  highlightWetCanvas:{setCssStyles(){}}, tail:{clear(){},clearAll(){},drawHead(){},configureInlineBacking(){},placeInline(){},restoreFullSurface(){},prepareLive(){}}, committedCtx:ctx,highlightCtx:ctx,
  damage:{addRect(){},addAll(){}},eraserEl:null,frame:{end(){},cancel(){},begin(){}},
 viewportPan:{x:0,y:0}, previewInkOffset:0,
 boundReadout:{floorX:0,floorY:0,bx:0,width:0,rawX:0,cx:0,rawY:0,cy:0,dragFrame:false,neverZoomed:false,steady:false,next:0,fromScale:0,fromScaleValid:false,restCeilX:0,startX:0,startY:0,lastX:0,lastY:0,bounded:false,settling:false},
  selection:{clear(){},prune(){},isEmpty:true}, selectionDeleteKeys:{reset(){}},
  erased:[],erasePieces:new Set(),eraseFrom:[],eraseWhole:false, predReal:[],predLastTail:[],
  camera:{snapshot:{x:0,y:0,zoom:1},screenToWorld:(x:number,y:number)=>({x,y})},
  view:{hasFocus:true,dom:{ownerDocument:{defaultView:{setTimeout:(fn:()=>void,ms:number)=>later(fn,ms),clearTimeout:(id:number)=>clearTimeout(id),
   ...(frames ? { requestAnimationFrame:(fn:(t:number)=>void)=>later(()=>fn(Date.now()),16), cancelAnimationFrame:(id:number)=>clearTimeout(id) } : {})}}}},
  filePath:()=>path,updateHandwritingPageClass(){},repaintPath(){},updateExtent(){},recordCommitDiagnostics(){},
  scheduleRepaint(){},hidePenCursor(){},hideEraserCursor(){},schedulePresentProbe(){},drawPredictedTail(){},
  syncCamera(){},recordPenDownState(){},ensurePenTools(){},startFrameTicker(){},probeSample(){},
  backingNow:()=>1,dispatchInk:(op:InkOp)=>ops.push(op)
 });
 v.penDown({x:20,y:30,pressure:0.5,timestamp:0},{pointerType:"pen",pointerId:7,buttons:1,button:0});
 const builder = v.builder as StrokeBuilder;
 const raw = (x:number,y:number,pressure=0.5,t=performance.now()) => v.penRaw([{x,y,pressure,timestamp:t}],{timeStamp:t});
 for(let i=1;i<16;i++) raw(20+i*8,30+i%2,0.5,i*8);
 const up=(type="pointerup", pointerId=7)=>v.penUp({type,pointerType:"pen",pointerId,buttons:0,pressure:0});
 return {v,builder,ops,raw,up};
}
it("shows the fitted pen shape before lift, without finalizing or storing; lift commits exactly that geometry and two-step undo", () => {
 const r=rig(); const finish=vi.spyOn(r.builder,"finishReleaseFiltered");
 const before=inlineInk.strokes(path).length;
 vi.advanceTimersByTime(349); expect(shown).toBeNull();
 vi.advanceTimersByTime(1); expect(shown).not.toBeNull();
 expect(finish).not.toHaveBeenCalled(); expect(inlineInk.strokes(path)).toHaveLength(before); expect(r.ops).toEqual([]);
 const candidate=structuredClone(shown!); r.up();
 expect(r.ops.map(op=>op.type)).toEqual(["add","replace"]);
 const saved=inlineInk.strokes(path).at(-1)!;
 expect(saved.points).toEqual(candidate.points); expect(saved.width).toBe(candidate.width); expect(saved.pressureProfile).toBe(candidate.pressureProfile);
 r.v.applyInkOp(invertInkOp(r.ops[1]!)); expect(inlineInk.strokes(path).at(-1)!.points).toHaveLength(16);
 r.v.applyInkOp(invertInkOp(r.ops[0]!)); expect(inlineInk.strokes(path)).toHaveLength(before);
});
it.each(["pointercancel","lostpointercapture",undefined])("%s also commits the shown shape: every gesture end takes it", type=> {
 const r=rig(); vi.advanceTimersByTime(350); expect(shown).not.toBeNull(); const candidate=structuredClone(shown!);
 if(type===undefined) r.v.penUp(); else r.up(type);
 expect(r.ops.map(op=>op.type)).toEqual(["add","replace"]); expect(inlineInk.strokes(path).at(-1)!.points).toEqual(candidate.points);
});
it("a delayed timer cannot fit a shape at lift",()=>{const r=rig();r.up();vi.advanceTimersByTime(500);expect(shown).toBeNull();expect(r.ops.map(op=>op.type)).toEqual(["add"]);});
it("a pressure dip after the shape shows is not ink: the stroke stays whole and the lift commits the shape",()=>{
 const r=rig();vi.advanceTimersByTime(350);expect(shown).not.toBeNull();
 r.raw(147,31,0.01,400);r.raw(155,31,0.01,415);r.raw(159,31,0.5,425);
 r.up();expect(r.ops.map(op=>op.type)).toEqual(["add","replace"]);expect((r.ops[0] as any).strokes).toHaveLength(1);
});

it.each(["pointermove","pointerrawupdate"])("unequivocal silent lift via %s accepts the shown candidate",type=>{
 const r=rig();vi.advanceTimersByTime(350);r.up(type);expect(r.ops.map(op=>op.type)).toEqual(["add","replace"]);
});
it("an end reported by another contact also commits the shown shape",()=>{
 const r=rig();vi.advanceTimersByTime(350);r.up("pointerup",8);expect(r.ops.map(op=>op.type)).toEqual(["add","replace"]);
});
it("disable invalidates a ready candidate and a pending deadline",()=>{
 const r=rig();setShapeSnap(false);vi.advanceTimersByTime(350);expect(shown).toBeNull();r.up();expect(r.ops.map(op=>op.type)).toEqual(["add"]);
 setShapeSnap(true);const next=rig();vi.advanceTimersByTime(350);setShapeSnap(false);next.up();expect(next.ops.map(op=>op.type)).toEqual(["add"]);
});
it("note switch/reset clears the pending timer and ready geometry",()=>{
 const r=rig();r.v.resetGestureState();vi.advanceTimersByTime(500);expect(shown).toBeNull();expect(r.ops).toEqual([]);
 const next=rig();vi.advanceTimersByTime(350);next.v.resetGestureState();expect(next.v.snapPreview).toBeNull();expect(next.ops).toEqual([]);
});
it("mouse and finger contacts never start a pen ghost",()=>{
 const r=rig();r.v.clearSnapPreview();r.v.strokePenGesture=false;
 for(const pointerType of ["mouse","touch"]){r.v.beginSnapPreview({x:140,y:31},{pointerType,pointerId:9});vi.advanceTimersByTime(350);expect(shown).toBeNull();}
});
it("a changed note cannot receive the old candidate",()=>{
 const r=rig();r.v.filePath=()=>"different-note.md";vi.advanceTimersByTime(350);expect(shown).toBeNull();r.up();expect(r.ops.map(op=>op.type)).toEqual(["add"]);
});

it("a selected color change clears the preview before it can be accepted",()=>{
 const r=rig();vi.advanceTimersByTime(350);const color=getInkColorHex("pen");
 setInkColorHex("pen","#abcdef");r.v.refreshStrip();r.up();
 expect(r.ops.map(op=>op.type)).toEqual(["add"]);setInkColorHex("pen",color);
});

it("the preview canvas is parented to the ink layer, so it rides the layer's translate with the wet ink", () => {
 const r = rig();
 const layer = {};
 r.v.inkLayer = layer;
 vi.advanceTimersByTime(350);
 expect(shown).not.toBeNull();
 const parents = vi.mocked(SnapPreviewCanvas.prototype.show).mock.calls.map(call => call[0]);
 expect(parents.at(-1)).toBe(layer);
});

it("with no ink layer the preview canvas stays on the container", () => {
 const r = rig();
 r.v.inkLayer = undefined;
 vi.advanceTimersByTime(350);
 expect(shown).not.toBeNull();
 const parents = vi.mocked(SnapPreviewCanvas.prototype.show).mock.calls.map(call => call[0]);
 expect(parents.at(-1)).toBe(r.v.container);
});

it.each([40, 0])("the preview box lands on the committed shape's box at layer offset %s px", offset => {
 const r = rig();
 const ctx = new Proxy({}, { get: (t: any, k) => (k in t ? t[k] : (t[k] = () => undefined)) });
 const fakeEl = (): any => ({
  style: {}, width: 0, height: 0, className: "", children: [] as any[], parentElement: null,
  setAttribute() {}, remove() {}, getContext: () => ctx,
  createEl: () => fakeEl(),
  appendChild(this: any, child: any) { this.children.push(child); child.parentElement = this; },
 });
 const layer = fakeEl();
 const container = fakeEl();
 r.v.container = container;
 r.v.inkLayer = layer;
 r.v.previewInkOffset = offset;
 layer.style.transform = `translate(${offset}px, 0px)`;
 vi.mocked(SnapPreviewCanvas.prototype.show).mockImplementation(function (this: SnapPreviewCanvas, parent, cam, stroke, w, h, b) {
  shown = stroke;
  return realShow.call(this, parent as any, cam, stroke, w, h, b);
 });
 vi.advanceTimersByTime(350);
 expect(shown).not.toBeNull();
 const box = shown!.bbox;
 const translate = Number(/translate\(\s*(-?[\d.]+)px/.exec(layer.style.transform)![1]);
 const canvas = [...layer.children, ...container.children].find(child => child.className === "handwriting-snap-preview");
 const visLeft = parseFloat(canvas.style.left) + (canvas.parentElement === layer ? translate : 0);
 const visRight = visLeft + parseFloat(canvas.style.width);
 expect(Math.abs(visLeft - (Math.floor(box.x - 2) + translate))).toBeLessThan(0.1);
 expect(Math.abs(visRight - (Math.ceil(box.x + box.width + 2) + translate))).toBeLessThan(0.1);
});

// A main-thread stall mid-stroke. The pen draws on, samples every 4 ms and 10 px apart, and none is read for 400 ms. When the
// thread frees, the dwell timer that came due during the stall runs first, and the samples queued behind it after. The pen
// never stopped, so no shape may hold the stroke: the queued samples are ink and the lift commits the freehand.
function stall(r: ReturnType<typeof rig>, step: number) {
 vi.advanceTimersByTime(120);
 let x = 140;
 for (let k = 1; k <= 15; k++) { vi.advanceTimersByTime(4); x += 10; r.raw(x, 30, 0.5, performance.now()); }
 const from = performance.now();
 busy.on = true; vi.advanceTimersByTime(400); busy.on = false;
 expect(busy.held.length).toBeGreaterThan(0);
 for (const fn of busy.held.splice(0)) fn();
 const queued = Array.from({ length: 100 }, (_, j) => ({ x: x + step * (j + 1), y: 30, pressure: 0.5, timestamp: from + 4 * (j + 1), tiltX: 0, tiltY: 0 }));
 return { queued, x: queued.at(-1)!.x };
}
it.each([
 ["one event per sample", false], ["one batch", false], ["one event per sample, with frames", true], ["one batch, with frames", true],
] as const)("a pen moving through a stall gets no shape: the queued samples are ink (%s)", (form, frames) => {
 const r = rig(frames);
 let { queued, x } = stall(r, 10);
 if (form.startsWith("one batch")) r.v.penRaw(queued, { timeStamp: queued.at(-1)!.timestamp });
 else for (const s of queued) r.raw(s.x, s.y, s.pressure, s.timestamp);
 for (let k = 1; k <= 5; k++) { vi.advanceTimersByTime(4); x += 10; r.raw(x, 30, 0.5, performance.now()); }
 expect(shown).toBeNull();
 r.up();
 expect(r.ops.map(op => op.type)).toEqual(["add"]);
 const saved = inlineInk.strokes(path).at(-1)!;
 expect(saved.points.length).toBeGreaterThan(100);
 expect(Math.max(...saved.points.map(p => p.x))).toBeGreaterThan(x - 20);
});
it.each([false, true])("a pen held still through a stall still gets its shape, a frame or a turn later (frames: %s)", frames => {
 const r = rig(frames);
 const { queued } = stall(r, 0);
 for (const s of queued) r.raw(s.x, s.y, s.pressure, s.timestamp);
 vi.advanceTimersByTime(16);
 expect(shown).not.toBeNull();
 const candidate = structuredClone(shown!);
 r.up();
 expect(r.ops.map(op => op.type)).toEqual(["add", "replace"]);
 expect(inlineInk.strokes(path).at(-1)!.points).toEqual(candidate.points);
});
