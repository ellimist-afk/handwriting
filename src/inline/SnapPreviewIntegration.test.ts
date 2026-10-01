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
let shown: InkStroke | null;
beforeEach(() => {
 vi.useFakeTimers(); setShapeSnap(true); shown = null;
 inlineInk.applyRemove(path, inlineInk.strokes(path).map(stroke => stroke.id));
 vi.spyOn(SnapPreviewCanvas.prototype, "show").mockImplementation((_parent, _cam, stroke) => { shown = stroke; return true; });
 vi.spyOn(SnapPreviewCanvas.prototype, "clear").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); setShapeSnap(true); });
function rig() {
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
  view:{hasFocus:true,dom:{ownerDocument:{defaultView:{setTimeout:(fn:()=>void,ms:number)=>setTimeout(fn,ms),clearTimeout:(id:number)=>clearTimeout(id)}}}},
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
it.each(["pointercancel","lostpointercapture",undefined])("%s ends freehand without accepting the ghost", type=> {
 const r=rig(); vi.advanceTimersByTime(350); expect(shown).not.toBeNull();
 if(type===undefined) r.v.penUp(); else r.up(type);
 expect(r.ops.map(op=>op.type)).toEqual(["add"]);
});
it("a delayed timer cannot fit a shape at lift",()=>{const r=rig();r.up();vi.advanceTimersByTime(500);expect(shown).toBeNull();expect(r.ops.map(op=>op.type)).toEqual(["add"]);});
it("authoritative final release filtering can split the snapshot, preserving both freehand pieces",()=>{
 const r=rig();vi.advanceTimersByTime(350);expect(shown).not.toBeNull();
 r.builder.add(147,31,0.01,400);r.builder.add(155,31,0.01,415);r.builder.add(159,31,0.5,425);
 r.up();expect(r.ops.map(op=>op.type)).toEqual(["add"]);expect((r.ops[0] as any).strokes).toHaveLength(2);
});

it.each(["pointermove","pointerrawupdate"])("unequivocal silent lift via %s accepts the shown candidate",type=>{
 const r=rig();vi.advanceTimersByTime(350);r.up(type);expect(r.ops.map(op=>op.type)).toEqual(["add","replace"]);
});
it("a different contact cannot accept the candidate",()=>{
 const r=rig();vi.advanceTimersByTime(350);r.up("pointerup",8);expect(r.ops.map(op=>op.type)).toEqual(["add"]);
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
