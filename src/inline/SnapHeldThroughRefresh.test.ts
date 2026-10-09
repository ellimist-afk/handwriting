/**
 * A HELD SHAPE SNAP SURVIVES A REFRESH THAT CHANGES NOTHING IT WOULD COMMIT.
 *
 * The pen draws a rough line and holds still; the clean shape shows. Before
 * the pen lifts, something unrelated refreshes every overlay: a theme or
 * snippet change (css-change repaints every overlay), or another device's
 * settings syncing in (the sync applies every ink size again, unchanged).
 * The preview is only ever armed at pen-down, so a refresh that clears it
 * leaves the lift to commit the freehand stroke the person was correcting.
 *
 * The overlay here is built through the real constructor so it sits in the
 * module's overlay set, the set both fan-outs walk. Inline ink is switched
 * off around the construction so nothing mounts.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	InkOverlayPlugin, inlineInk, setShapeSnap, setInlineInkEnabled,
	repaintAllInkOverlays, setInkSizeMult, getInkSizeMult,
} from "./InkOverlay";
import { SnapPreviewCanvas } from "./SnapPreview";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DEFAULT_PEN } from "../ink/PenStyle";
import type { InkOp } from "./InkHistory";
import type { InkStroke } from "../ink/Stroke";

const path = "snap-held-refresh-note.md";
let shown: InkStroke | null;
const built: Array<Record<string, unknown>> = [];

beforeEach(() => {
	vi.useFakeTimers(); setShapeSnap(true); shown = null;
	inlineInk.applyRemove(path, inlineInk.strokes(path).map(stroke => stroke.id));
	vi.spyOn(SnapPreviewCanvas.prototype, "show").mockImplementation((_parent, _cam, stroke) => { shown = stroke; return true; });
	vi.spyOn(SnapPreviewCanvas.prototype, "clear").mockImplementation(() => {});
});
afterEach(() => {
	for (const v of built.splice(0)) (v.destroy as () => void)();
	setInlineInkEnabled(true);
	vi.restoreAllMocks(); vi.useRealTimers(); setShapeSnap(true);
});

function rig() {
	const winStub = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (id: number) => clearTimeout(id) };
	const view = { hasFocus: true, dom: { ownerDocument: { defaultView: winStub } } };
	setInlineInkEnabled(false);
	const v = new InkOverlayPlugin(view as never) as any;
	built.push(v);
	// Own property: destroy() runs unmount, and this overlay never mounted.
	v.unmount = () => {};
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
		view,
		filePath:()=>path,updateHandwritingPageClass(){},repaintPath(){},updateExtent(){},recordCommitDiagnostics(){},
		scheduleRepaint(){},hidePenCursor(){},hideEraserCursor(){},schedulePresentProbe(){},drawPredictedTail(){},
		syncCamera(){},recordPenDownState(){},ensurePenTools(){},startFrameTicker(){},probeSample(){},
		backingNow:()=>1,dispatchInk:(op:InkOp)=>ops.push(op),
	});
	v.penDown({x:20,y:30,pressure:0.5,timestamp:0},{pointerType:"pen",pointerId:7,buttons:1,button:0});
	const raw = (x:number,y:number,pressure=0.5,t=performance.now()) => v.penRaw([{x,y,pressure,timestamp:t}],{timeStamp:t});
	for (let i = 1; i < 16; i++) raw(20 + i * 8, 30 + i % 2, 0.5, i * 8);
	const up = () => v.penUp({type:"pointerup",pointerType:"pen",pointerId:7,buttons:0,pressure:0});
	return { v, ops, up };
}

function holdUntilShown(): void {
	vi.advanceTimersByTime(350);
	expect(shown, "the clean shape never showed, so this cell proves nothing").not.toBeNull();
}

it("control: with no refresh, the held snap commits the clean shape", () => {
	const r = rig();
	holdUntilShown();
	r.up();
	expect(r.ops.map(op => op.type), "the held snap was not committed").toEqual(["add", "replace"]);
});

it("a repaint of every overlay (theme or snippet change) while the snap is held keeps the snap", () => {
	const r = rig();
	holdUntilShown();
	repaintAllInkOverlays();
	r.up();
	expect(r.ops.map(op => op.type), "the repaint threw the held snap away; the freehand stroke committed").toEqual(["add", "replace"]);
});

it("ink sizes applied again unchanged (a settings sync) while the snap is held keep the snap", () => {
	const r = rig();
	holdUntilShown();
	setInkSizeMult("pen", getInkSizeMult("pen"));
	setInkSizeMult("highlighter", getInkSizeMult("highlighter"));
	r.up();
	expect(r.ops.map(op => op.type), "an unchanged size threw the held snap away; the freehand stroke committed").toEqual(["add", "replace"]);
});

it("a pen size that does change while the snap is held drops the snap: the shape shown was drawn at the old size", () => {
	const r = rig();
	holdUntilShown();
	const before = getInkSizeMult("pen");
	try {
		setInkSizeMult("pen", before * 2);
		expect(getInkSizeMult("pen"), "premise: the size changed").not.toBe(before);
		r.up();
	} finally {
		setInkSizeMult("pen", before);
	}
	expect(r.ops.map(op => op.type), "a held snap shown at the old size was committed").toEqual(["add"]);
});
