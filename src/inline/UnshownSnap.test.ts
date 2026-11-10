/**
 * TF-9: a finger (or a passive stylus that reports touch) drawing ink takes no shape preview, so nothing it draws may snap at
 * the lift: zero snap, nothing lands that was not shown. A rectangle is drawn by touch, held past the dwell, and lifted. What
 * lands must be what was shown: the preview's shape if one showed, else the freehand the wet layer drew.
 *
 * The rig is SnapPreviewIntegration.test.ts's, with the window's clock in the test's hand, so the hold is read where penUp
 * reads it. The control runs the same rectangle with the pen, which shows the shape and commits exactly it.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InkOverlayPlugin, inlineInk, setShapeSnap } from "./InkOverlay";
import { SnapPreviewCanvas } from "./SnapPreview";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DEFAULT_PEN } from "../ink/PenStyle";
import { snapStroke, DWELL_MS } from "../ink/ShapeSnap";
import type { InkOp } from "./InkHistory";
import type { InkStroke } from "../ink/Stroke";

const path = "unshown-snap-note.md";
const clock = { now: 0 };
let shown: InkStroke | null;
beforeEach(() => {
 vi.useFakeTimers(); setShapeSnap(true); shown = null; clock.now = 0;
 inlineInk.applyRemove(path, inlineInk.strokes(path).map(stroke => stroke.id));
 vi.spyOn(SnapPreviewCanvas.prototype, "show").mockImplementation((_parent, _cam, stroke) => { shown = stroke; return true; });
 vi.spyOn(SnapPreviewCanvas.prototype, "clear").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); setShapeSnap(true); });

/** A 160 x 100 rectangle, corner to corner and back, 8 ms a sample, then held still past the dwell and lifted. */
function drawRectangle(pointerType: "touch" | "pen") {
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
  view:{hasFocus:true,dom:{ownerDocument:{defaultView:{performance:{now:()=>clock.now},setTimeout:(fn:()=>void,ms:number)=>setTimeout(fn,ms),clearTimeout:(id:number)=>clearTimeout(id)}}}},
  filePath:()=>path,updateHandwritingPageClass(){},repaintPath(){},updateExtent(){},recordCommitDiagnostics(){},
  scheduleRepaint(){},hidePenCursor(){},hideEraserCursor(){},schedulePresentProbe(){},drawPredictedTail(){},
  syncCamera(){},recordPenDownState(){},ensurePenTools(){},startFrameTicker(){},probeSample(){},
  backingNow:()=>1,dispatchInk:(op:InkOp)=>ops.push(op)
 });
 const corners: Array<[number, number]> = [[40, 40], [200, 40], [200, 140], [40, 140], [40, 40]];
 const pts: Array<[number, number]> = [];
 for (let c = 0; c < 4; c++) {
  const [ax, ay] = corners[c]!, [bx, by] = corners[c + 1]!;
  for (let i = 0; i < 10; i++) pts.push([ax + ((bx - ax) * i) / 10, ay + ((by - ay) * i) / 10]);
 }
 pts.push([40, 41]);
 const ev = { pointerType, pointerId: 7, buttons: 1, button: 0 };
 v.penDown({ x: pts[0]![0], y: pts[0]![1], pressure: 0.5, timestamp: 0 }, ev);
 pts.slice(1).forEach(([x, y], i) => {
  const t = (i + 1) * 8;
  clock.now = t;
  v.penRaw([{ x, y, pressure: 0.5, timestamp: t }], { timeStamp: t });
  vi.advanceTimersByTime(8);
 });
 const freehand = (v.builder as { snapshotReleaseFiltered(): InkStroke[] }).snapshotReleaseFiltered();
 // Held still past the dwell, then lifted.
 clock.now += DWELL_MS + 50;
 vi.advanceTimersByTime(DWELL_MS + 50);
 const wasShown = shown ? structuredClone(shown) : null;
 const offer = vi.spyOn(InkOverlayPlugin.prototype, "offerSnapChip").mockImplementation(() => {});
 v.penUp({ type: "pointerup", pointerType, pointerId: 7, buttons: 0, pressure: 0 });
 const landed = inlineInk.strokes(path);
 return { ops, freehand, wasShown, landed, offers: offer.mock.calls.length };
}

function expectLandedAsShown(r: ReturnType<typeof drawRectangle>, who: string): void {
 expect(r.landed, `${who}: one stroke lands`).toHaveLength(1);
 if (r.wasShown) expect(r.landed[0]!.points, `${who}: the shape that showed is the one that lands`).toEqual(r.wasShown.points);
 else {
  expect(r.ops.map((op) => op.type), `${who}: nothing showed, so nothing replaces the freehand`).toEqual(["add"]);
  // The lift flushes the last raw sample onto the freehand, so it lands with at least the points drawn; a snapped shape has a handful.
  expect(r.landed[0]!.points.length, `${who}: nothing showed, so the freehand lands`).toBeGreaterThanOrEqual(r.freehand[0]!.points.length);
 }
}

it("premise: the rectangle is one a held lift snaps", () => {
 const r = drawRectangle("pen");
 expect(r.freehand, "premise: one freehand stroke").toHaveLength(1);
 expect(snapStroke(r.freehand[0]!, true), "premise: the recognizer snaps it").not.toBeNull();
});

it("control: the pen shows the rectangle and lands exactly what showed", () => {
 const r = drawRectangle("pen");
 expect(r.wasShown, "premise: the pen's preview showed").not.toBeNull();
 expectLandedAsShown(r, "pen");
});

it("a finger's held rectangle lands what was shown: nothing snaps unshown", () => {
 const r = drawRectangle("touch");
 expectLandedAsShown(r, "touch");
 expect(r.offers, "touch: a held finger lift offers no snap chip").toBe(0);
});
