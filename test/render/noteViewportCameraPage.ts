import { setPenGestureGuardEnabled } from "../../src/inline/InlinePenRouter";
import { EditorState, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { history, undoDepth, undo, redo, isolateHistory } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, overlayForActiveEditor, captureInlineReloadAdmission, inlineReloadBindings, inkExternallyReloaded, setScrollExpansionEnabled, setInlineEraserMode, setInlineLassoMode, setInlineSpaceMode } from "../../src/inline/InkOverlay";
import { notifyInkChanged } from "../../src/inline/InkEvents";
import { PageStore } from "../../src/persistence/PageStore";
import { FakeAdapter, gate } from "../../src/persistence/FakeAdapter";
import { surfaceExtents } from "../../src/inline/SurfaceExtent";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField, setBrowserEditorInfo } from "./iphoneObsidianStub";

import { serializePage, parsePage, emptyPage, type PageData } from "../../src/model/PageData";
installObsidianDom();
const ids = new Map<string,string>(), pages = new Map<string,string>();
let writes = 0;
const heldLoads=new Map<string,()=>void>();
const blockedIds=new Set<string>();
const save = (id:string,page:PageData) => { writes++; pages.set(id,serializePage(page)); };
inlineInk.attachHost({readPageId:p=>ids.get(p)??null,claimId:async(p,id)=>{writes++;ids.set(p,id);return{pageId:id};},loadSidecar:async id=>{if(blockedIds.has(id))await new Promise<void>(r=>heldLoads.set(id,r));return pages.has(id)?parsePage(pages.get(id)!,id):null;},scheduleSidecar:save,scheduleSidecarNow:async(id,p)=>save(id,p),notify:()=>{}});
const settle = async () => { for(let i=0;i<8;i++) await new Promise<void>(r=>requestAnimationFrame(()=>r())); };
// A lift under the canvas eases its measured travel for up to 500 ms. `rest` is `settle` plus waiting that ease out, for a
// cell whose reading is the page AT REST; `settle` stays as it was for cells that read the lift itself.
const rest = async () => { await settle(); for(let f=0;f<90&&[...rigs.values()].some(r=>r.overlay?.overscrollBounceReadout?.().active);f++) await new Promise<void>(r=>requestAnimationFrame(()=>r())); };
async function run(zoom:number,candidate:boolean,axis: "x" | "y" = "y",font=1,cancel=false) {
	const path = `viewport-${zoom}-${axis}-${font}-${cancel}.md`;
	// This rig drives the zoom bar buttons, gated busy with the canvas off - canvas on so
	// the bar stays live; the fling below then runs under canvas's own shorter tau (InlinePenRouter.ts CANVAS_FLING_TAU_MS).
	setScrollExpansionEnabled(true);
 surfaceExtents.grow(path,{x:250000,y:250000});
	// Stable has no scroll-demand expansion switch; seeded fixture extent only.
	const host = document.body.appendChild(document.createElement("div"));
	host.className = "markdown-source-view camera-proof";
	const doc = "alpha beta gamma delta ".repeat(30)+"\nsecond line";
	const view = new EditorView({parent:host,state:EditorState.create({doc,extensions:[history(),EditorView.lineWrapping,editorInfoField.init(()=>({app:{commands:{executeCommandById:()=>false}},file:{path},editor:{}})),inkOverlayExtension(),EditorView.theme({"&":{width:"640px",height:"480px"},".cm-content":{fontFamily:"monospace",fontSize:"16px",lineHeight:"24px"}})]})});
	await settle();
	const overlay=overlayForPath(path)!;
	if(!overlay) throw new Error("mounted overlay missing");
	// Divides by the COMMANDED scale (the zoom this call is known to be at,
	// times font), not CodeMirror's separately measured-back view.scaleX/
	// scaleY - a real x/y glyph-position check, not one that cancels its own
	// producer's rounding against the assert's. `before` is called while the
	// camera is still at its start-of-test zoom (1, no button click yet); the
	// caller passes that in explicitly rather than this function assuming it.
	const positions=(scale:number)=>Array.from({length:Math.min(doc.length,100)},(_,i)=>{const c=view.coordsAtPos(i)!;const origin=view.contentDOM.getBoundingClientRect();return [Math.round((c.left-origin.left)/scale*100)/100,Math.round((c.top-origin.top)/scale*100)/100];});
	// The line BOX (`.cm-line`): where the line sits, measured back through
	// CodeMirror's own view.scaleY (a coarser, less precision-sensitive read
	// than the glyph positions above - see F4/read-linebox.txt). `top`/`height`
	// both recorded so a re-wrap (height change) is visible beside a shift.
	const lineBoxes=()=>{const origin=view.contentDOM.getBoundingClientRect();return Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")).map(l=>{const r=l.getBoundingClientRect();return {top:(r.top-origin.top)/view.scaleY,height:r.height/view.scaleY};});};
	if(font!==1){view.contentDOM.style.fontSize=`${16*font}px`;view.requestMeasure();await settle();}
 const layoutBefore=positions(font);const lineBoxBefore=lineBoxes();
	const before={doc:view.state.doc.toString(),writes,history:undoDepth(view.state)};
	for(let tries=0;tries<5&&(overlay as any).getNoteViewportState().zoom>zoom;tries++){host.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click();await settle();}
 for(let tries=0;tries<5&&(overlay as any).getNoteViewportState().zoom<zoom;tries++){host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();await settle();}
 view.requestMeasure(); await settle();
 if((overlay as any).getNoteViewportState().zoom!==zoom)throw Error(JSON.stringify({state:(overlay as any).getNoteViewportState(),loaded:inlineInk.isLoaded(path),mode:(overlay as any).mode,builder:(overlay as any).builder,valid:(overlay as any).scaleGeometryValid,button:host.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')?.disabled}));
	const layoutAfter=positions(zoom*font);const lineBoxAfter=lineBoxes();
	const after={doc:view.state.doc.toString(),writes,history:undoDepth(view.state)};
	const scroller=view.scrollDOM;
	const hit=(x:number,y:number)=>{const target=document.elementFromPoint(x,y);return{tag:target?.tagName,inside:!!target&&scroller.contains(target)};};
	const corners=([[24,104],[600,104],[24,440],[600,440]] as const).map(([x,y])=>({x,y,...hit(x!,y!)}));
	setPenInk(true);
	for (const {x,y} of corners) {
		for(const [type,dx,buttons] of [["pointerdown",0,1],["pointermove",12,1],["pointerup",12,0]] as const){
			const target=document.elementFromPoint(x+dx,y);
			target?.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:"pen",pointerId:71,isPrimary:true,clientX:x+dx,clientY:y,buttons,pressure:buttons?.5:0}));
		}
		await settle();
	}
	const strokes=JSON.parse(JSON.stringify(inlineInk.strokes(path)));
	const contentRect=view.contentDOM.getBoundingClientRect();
	const textTop=view.contentDOM.querySelector(".cm-line")!.getBoundingClientRect().top;
	const errors=strokes.map((s:any,i:number)=>({x:s.points[0].x-(corners[i]!.x-contentRect.left)/(zoom*font),y:s.points[0].y-(corners[i]!.y-textTop)/(zoom*font)}));
	const measured={paddingTop:Number.parseFloat(getComputedStyle(view.contentDOM).paddingTop),fontZoom:(overlay as any).fontZoom,scaleX:view.scaleX,overlayScale:(overlay as any).cssScale,rect:scroller.getBoundingClientRect().toJSON(),contentWidth:view.contentDOM.offsetWidth,backings:[...host.querySelectorAll("canvas")].map(c=>({w:c.width,h:c.height}))};
	// Real routed touch after pen contact: observe whether this is assist/parole.
	const touchTrace:any[]=[];
	const router=(overlay as any).router;
	const snapTouch=(phase:string)=>touchTrace.push({phase,offset:axis==="x"?scroller.scrollLeft:scroller.scrollTop,assist:router.assistEngaged,parole:router.paroleId,fling:router.flingRaf!==0,velocity:axis==="x"?router.flingVx:router.flingVy,content:axis==="x"?view.contentDOM.getBoundingClientRect().left:view.contentDOM.getBoundingClientRect().top});
 snapTouch("before");
 for(const [type,n] of [["pointerdown",380],["pointermove",340],["pointermove",300],["pointermove",260],["pointerup",260]] as const){
  const x=axis==="x"?n:300,y=axis==="y"?n:300;
  const target=document.elementFromPoint(x,y)!;
  target.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:"touch",pointerId:81,isPrimary:true,clientX:x,clientY:y,buttons:type==="pointerup"?0:1,width:8,height:8}));
  snapTouch(type);
  if(type!=="pointerup")await new Promise(r=>setTimeout(r,25));
 }
 let flingUpdates=0,lastTick=router.flingLastT;
 let cancelled:null|object=null,cancelOffset=0;
 for(let frame=0;frame<240;frame++){
  await new Promise<void>(r=>requestAnimationFrame(()=>r()));
  if(router.flingLastT!==lastTick){flingUpdates++;lastTick=router.flingLastT;}
  if(cancel && flingUpdates>=3 && !cancelled){
   const accepted=(overlay as any).commitCameraScale?.(zoom/2)??false;
   cancelled={accepted,fling:router.flingRaf!==0,assist:router.assistEngaged,parole:router.paroleId};
   cancelOffset=axis==="x"?scroller.scrollLeft:scroller.scrollTop;
  }
  if(router.flingRaf===0)break;
 }
 const terminalOffset=axis==="x"?scroller.scrollLeft:scroller.scrollTop;
 await settle();snapTouch("terminal");
 // Pen owns its frame through a resize and a refused camera change.
 const scaleBefore=(overlay as any).cssScale;
 const transformBefore=view.dom.style.transform;
 const px=50,py=100;
 const pen=(type:string,x:number)=>document.elementFromPoint(x,py)?.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:"pen",pointerId:91,isPrimary:true,clientX:x,clientY:py,buttons:type==="pointerup"?0:1,pressure:.5}));
 pen("pointerdown",px);
 const rejected=!((overlay as any).commitCameraScale?.(scaleBefore*1.1)??true);
 host.style.height="481px";view.requestMeasure();await new Promise<void>(r=>requestAnimationFrame(()=>r()));
 const scaleAfter=(overlay as any).cssScale,transformAfter=view.dom.style.transform;
 pen("pointermove",px+12);pen("pointerup",px+12);await settle();
 const last=inlineInk.strokes(path).at(-1)!;
const lock={rejected,scaleBefore,scaleAfter,transformBefore,transformAfter,before:last.points[0],after:last.points.at(-1)};
 const invalidBefore={scale:(overlay as any).cssScale,transform:view.dom.style.transform};
 const invalidRejected=[0,NaN,Infinity,1e-30].map(s=>!((overlay as any).commitCameraScale?.(s)??true));
 host.style.display="none";view.requestMeasure();await settle();
 const hidden={valid:(overlay as any).scaleGeometryValid,scale:(overlay as any).cssScale,rejected:!((overlay as any).commitCameraScale?.(1)??true)};
 host.style.display="";view.requestMeasure();await settle();
 const recovered={valid:(overlay as any).scaleGeometryValid,scale:(overlay as any).cssScale,transform:view.dom.style.transform};
	// The pin: the harness ENGINE's own CSS-zoom support, and separately the
	// OVERLAY's cached gate (InkOverlay.ts hostZoomSupported(), same private
	// method scrollExpansionPage.ts:98 reads) - two different things, read
	// separately so a disagreement between them is visible rather than assumed
	// (same pair, same names as ScrollExpansion.test.ts:52-53).
	const engineZoom=CSS.supports("zoom","0.5");
	const hostZoom=(overlay as any).hostZoomSupported() as boolean;
 view.destroy();host.remove();
	return {zoom,candidate,layoutBefore,layoutAfter,lineBoxBefore,lineBoxAfter,engineZoom,hostZoom,before,after,corners,strokes,errors,measured,touchTrace,flingUpdates,terminalOffset,cancelled,cancelOffset,lock,axis,font,cancel,invalidBefore,invalidRejected,hidden,recovered};
}
(window as any).noteViewportRun=run;

async function mountControl() {
 const path="controls.md";
 const host=document.body.appendChild(document.createElement("div"));
 host.className="markdown-source-view camera-proof";
 const view=new EditorView({parent:host,state:EditorState.create({doc:"alpha beta gamma\nsecond line",extensions:[history(),EditorView.lineWrapping,editorInfoField.init(()=>({app:{commands:{executeCommandById:()=>false}},file:{path},editor:{}})),inkOverlayExtension(),EditorView.theme({"&":{width:"640px",height:"480px"}})]})});
 await settle();
 (window as any).controlView=view;
}
(window as any).mountControl=mountControl;

// Persisted fixture data is loaded through the real store/host boundary.
class InlineWidget extends WidgetType { toDOM(){const el=document.createElement("span");el.textContent="[widget]";return el;} }
const rigs=new Map<string,{host:HTMLElement;view:EditorView;overlay:any;path:string;extensions:Extension[];overlayExtension:Extension}>();
async function setup(id:string,kind="far",font=1,external=1,initialDoc?:string,sharedPath?:string) {
 const path=sharedPath??`fit-${id}.md`,pageId=ids.get(path)??`fit-page-${id}`;
 if(kind==="loading")blockedIds.add(pageId);
 setScrollExpansionEnabled(true);
 if(!ids.has(path)) {
  const data=emptyPage(pageId);data.surface="inline";
  const points=kind==="empty"?[]:kind==="edge"?[[6,120]]:kind==="point"?[[80,120]]:kind==="huge"?[[200,200],[9_000_000,9_000_000]]:kind==="below-minimum"?[[200,200],[100000,100000]]:kind==="former-far"?[[200,200],[18000,22000]]:kind==="fit-six"?[[200,200],[6736,6736]]:kind==="paper-scaled"?[[200,200],[900,1100]]:[[200,200],[1800,2200]];
  const long=kind!=="point"&&kind!=="edge";const width=long?32:2,dx=long?800:10,dy=long?600:8;
  data.strokes=points.map(([x,y],i)=>({id:`seed-${i}`,tool:"pen" as const,color:"#000000",width,createdAt:1,points:[{x:x!,y:y!,pressure:.5,t:0},{x:x!+dx,y:y!+dy,pressure:.5,t:10}],bbox:{x:x!-width,y:y!-width,width:dx+2*width,height:dy+2*width}}));
  if(kind==="thick-dot"||kind==="negative")data.strokes=[{id:"seed-0",tool:"pen",color:"#000000",width:kind==="thick-dot"?1000:2,createdAt:1,points:[{x:kind==="thick-dot"?3000:-100,y:3000,pressure:.5,t:0}],bbox:{x:0,y:0,width:0,height:0}}]; // Parse recomputes the stored bbox.
  // Geometry below reproduces the mounted-review receipt exactly (bboxes
  // 92,92 / 92,-60 / -508,99992 / 99992,-508, all 36x36), so the fixtures
  // match the exact configuration that was verified rather than an invented one.
  // A single reachable stroke: x/y 96..124, pen width 2 -> bbox {x:92,y:92,width:36,height:36}.
  if(kind==="reachable-body-only")data.strokes=[
   {id:"body",tool:"pen" as const,color:"#000000",width:2,createdAt:1,points:[{x:96,y:96,pressure:.5,t:0},{x:124,y:124,pressure:.5,t:10}],bbox:{x:0,y:0,width:0,height:0}},
  ];
  // Disjoint: the same reachable body plus TWO outliers, one left-and-below
  // the origin (x<0, y huge positive) and one right-and-above (x huge
  // positive, y<0). This is the pair the old combined-bbox clamp got wrong:
  // each outlier is wholly unreachable on its OWN axis, but its OTHER axis
  // sits well inside the reachable range, so a union taken before clipping
  // fabricates a huge box neither outlier's reachable extent supports.
  if(kind==="disjoint")data.strokes=[
   {id:"outlierLeftBelow",tool:"pen" as const,color:"#000000",width:2,createdAt:1,points:[{x:-504,y:99996,pressure:.5,t:0},{x:-476,y:100024,pressure:.5,t:10}],bbox:{x:0,y:0,width:0,height:0}},
   {id:"outlierRightAbove",tool:"pen" as const,color:"#000000",width:2,createdAt:1,points:[{x:99996,y:-504,pressure:.5,t:0},{x:100024,y:-476,pressure:.5,t:10}],bbox:{x:0,y:0,width:0,height:0}},
   {id:"body",tool:"pen" as const,color:"#000000",width:2,createdAt:1,points:[{x:96,y:96,pressure:.5,t:0},{x:124,y:124,pressure:.5,t:10}],bbox:{x:0,y:0,width:0,height:0}},
  ];
  // Ink above the first line (wholly unreachable) plus a separate reachable
  // body below it - the shape of Alan's real note. The unreachable stroke
  // must still let the reachable one produce "fit".
  if(kind==="negative-y-with-body")data.strokes=[
   {id:"aboveLine",tool:"pen" as const,color:"#000000",width:2,createdAt:1,points:[{x:96,y:-56,pressure:.5,t:0},{x:124,y:-28,pressure:.5,t:10}],bbox:{x:0,y:0,width:0,height:0}},
   {id:"body",tool:"pen" as const,color:"#000000",width:2,createdAt:1,points:[{x:96,y:96,pressure:.5,t:0},{x:124,y:124,pressure:.5,t:10}],bbox:{x:0,y:0,width:0,height:0}},
  ];
  // Exactly the "disjoint-unreachable" case: the same two outliers with NO
  // reachable body - distinct from "empty" (no strokes at all), which must
  // still reset to 100% rather than refuse.
  if(kind==="wholly-unreachable-multi")data.strokes=[
   {id:"outlierLeftBelow",tool:"pen" as const,color:"#000000",width:2,createdAt:1,points:[{x:-504,y:99996,pressure:.5,t:0},{x:-476,y:100024,pressure:.5,t:10}],bbox:{x:0,y:0,width:0,height:0}},
   {id:"outlierRightAbove",tool:"pen" as const,color:"#000000",width:2,createdAt:1,points:[{x:99996,y:-504,pressure:.5,t:0},{x:100024,y:-476,pressure:.5,t:10}],bbox:{x:0,y:0,width:0,height:0}},
  ];
  if(kind==="negative-width-padding"||kind==="partial-negative-y"){
   const x=kind==="negative-width-padding"?0:100,y=kind==="partial-negative-y"?-4:100;
   data.strokes=[{id:"edge-body",tool:"pen",color:"#000000",width:2,createdAt:1,points:[{x,y,pressure:.5,t:0},{x:x+20,y:y+28,pressure:.5,t:10}],bbox:{x:0,y:0,width:0,height:0}}];
  }
  ids.set(path,pageId);pages.set(pageId,serializePage(data));
 }
 const host=document.body.appendChild(document.createElement("div"));host.className="markdown-source-view camera-proof";host.dataset.rig=id;
 if(kind==="zero-padding")host.classList.add("zero-padding-control");
 if(kind==="theme") {document.body.classList.add("handwriting-paper-grid");document.body.style.setProperty("--background-modifier-border","#aaaaaa");const style=document.createElement("style");style.textContent=`[data-rig="${id}"] .cm-content {max-width:500px;margin:0 auto;padding:20px 24px;} [data-rig="${id}"] .cm-line {padding:0 12px;}`;host.appendChild(style);}
 if(external!==1){host.style.transform=`scale(${external})`;host.style.transformOrigin="0 0";}
 const doc=initialDoc??("alpha beta gamma delta ".repeat(30)+"\n# Heading\n- list item\nsecond line");
 const overlayExtension=inkOverlayExtension();
 const extensions=[history(),EditorView.lineWrapping,EditorView.decorations.of(Decoration.set(doc.includes("# Heading")?[Decoration.widget({widget:new InlineWidget()}).range(doc.indexOf("# Heading"))]:[])),editorInfoField.init(()=>({app:{commands:{executeCommandById:()=>false}},file:{path},editor:{}})),overlayExtension,EditorView.theme({"&":{width:"640px",height:"480px"},".cm-content":{fontFamily:"monospace",fontSize:`${16*font}px`,lineHeight:"24px"}})];
 const view=new EditorView({parent:host,state:EditorState.create({doc,extensions})});
 await settle();
 const info=view.state.field(editorInfoField)!;
 const overlay=overlayForActiveEditor(info.editor as never,info.file as never)!;rigs.set(id,{host,view,overlay,path,extensions,overlayExtension});
 return snap(id);
}
function snap(id:string) {
 const {host,view,overlay,path}=rigs.get(id)!;
 const cr=view.contentDOM.getBoundingClientRect(),sr=view.scrollDOM.getBoundingClientRect(),scale=overlay.cssScale,font=overlay.fontZoom;
 const paperStyle=getComputedStyle(view.scrollDOM);
 // The pin, same pair/names as `run()`'s the harness engine's own
 // CSS-zoom support, and the overlay's separately cached gate.
 const engineZoom=CSS.supports("zoom","0.5"),hostZoom=(overlay as any).hostZoomSupported() as boolean;
 return {engineZoom,hostZoom,paddingTop:Number.parseFloat(getComputedStyle(view.contentDOM).paddingTop),paper:{image:paperStyle.backgroundImage,attachment:paperStyle.backgroundAttachment},state:overlay.getNoteViewportState(),doc:view.state.doc.toString(),writes,history:undoDepth(view.state),strokes:JSON.parse(JSON.stringify(inlineInk.strokes(path))),extent:surfaceExtents.get(path),scroll:{left:view.scrollDOM.scrollLeft,top:view.scrollDOM.scrollTop,width:view.scrollDOM.scrollWidth,height:view.scrollDOM.scrollHeight},viewport:{x:sr.x,y:sr.y,width:sr.width,height:sr.height},ink:inlineInk.strokes(path).map(s=>({id:s.id,x:cr.left+s.bbox.x*scale*font,y:view.documentTop+s.bbox.y*scale*font,right:cr.left+(s.bbox.x+s.bbox.width)*scale*font,bottom:view.documentTop+(s.bbox.y+s.bbox.height)*scale*font})),layout:Array.from({length:Math.min(100,view.state.doc.length+1)},(_,i)=>{const c=view.coordsAtPos(i)!;return[(c.left-cr.left)/scale,(c.top-cr.top)/scale];}),buttons:[...host.querySelectorAll(".handwriting-note-viewport-controls button")].map(b=>b.getBoundingClientRect().toJSON()),backings:[...host.querySelectorAll("canvas")].map(c=>c.width*c.height),selection:view.state.selection.main.toJSON(),selected:overlay.selection.strokeIds,handles:host.querySelectorAll(".handwriting-selection-handle").length};
}
async function fit(id:string) {const r=rigs.get(id)!.overlay.fitHandwriting();await settle();return {result:r,...snap(id)};}
/**
 * Pixels the user can actually SEE after Fit: the committed ink canvas
 * cropped to the scroller's on-screen viewport. Same shape as
 * `visibleCommitted` in blankNotePastePage.ts - canvases stack
 * highlight/highlightWet/committed/wet/tail, so index 2 is committed ink,
 * and an oversized backing store (the surface grows right/bottom) must not
 * count pixels that are painted but scrolled out of view.
 */
function visiblePainted(id:string):number {
 const {host,view}=rigs.get(id)!;
 const canvas=host.querySelectorAll<HTMLCanvasElement>(".handwriting-ink-layer canvas")[2];
 if(!canvas) throw new Error("committed canvas missing");
 const ctx=canvas.getContext("2d");
 if(!ctx) throw new Error("committed context missing");
 const canvasRect=canvas.getBoundingClientRect(),viewportRect=view.scrollDOM.getBoundingClientRect();
 const left=Math.max(canvasRect.left,viewportRect.left),top=Math.max(canvasRect.top,viewportRect.top);
 const right=Math.min(canvasRect.right,viewportRect.right),bottom=Math.min(canvasRect.bottom,viewportRect.bottom);
 if(right<=left||bottom<=top||canvasRect.width<=0||canvasRect.height<=0) return 0;
 const sx=Math.max(0,Math.floor((left-canvasRect.left)/canvasRect.width*canvas.width));
 const sy=Math.max(0,Math.floor((top-canvasRect.top)/canvasRect.height*canvas.height));
 const ex=Math.min(canvas.width,Math.ceil((right-canvasRect.left)/canvasRect.width*canvas.width));
 const ey=Math.min(canvas.height,Math.ceil((bottom-canvasRect.top)/canvasRect.height*canvas.height));
 const pixels=ctx.getImageData(sx,sy,Math.max(1,ex-sx),Math.max(1,ey-sy)).data;
 let count=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]!==0)count++;
 return count;
}
/**
 * Painted pixels PER STROKE, so "the ink is visible" cannot pass on one
 * stroke while the rest vanish.
 *
 * `visiblePainted` above counts every non-transparent pixel in the viewport
 * and answers one bit: something painted. At a Fit scale below ten percent
 * that is exactly the reading the low-zoom invisible-ink history produced -
 * one surviving stroke carries the count while thinner ones disappear under
 * the committed width floor. So each stroke is sampled inside its OWN
 * on-screen box (the same client-space box `snap` reports), padded by 2 CSS
 * px for the floor's own half pixel.
 *
 * ALPHA > 20, not > 0, and that is the whole point: a stroke thinned to a
 * whisper still leaves antialiased pixels with a few units of alpha, and
 * counting those would keep the defect green. 20 is the bar the lag
 * harness's `endpointPixels` already uses for "this ink is really there".
 */
function strokesPainted(id:string):{id:string;painted:number;sampled:boolean}[] {
 const {host,view,overlay,path}=rigs.get(id)!;
 const canvas=host.querySelectorAll<HTMLCanvasElement>(".handwriting-ink-layer canvas")[2];
 if(!canvas) throw new Error("committed canvas missing");
 const ctx=canvas.getContext("2d");
 if(!ctx) throw new Error("committed context missing");
 const canvasRect=canvas.getBoundingClientRect(),viewportRect=view.scrollDOM.getBoundingClientRect();
 const cr=view.contentDOM.getBoundingClientRect(),scale=overlay.cssScale,font=overlay.fontZoom;
 if(canvasRect.width<=0||canvasRect.height<=0) return inlineInk.strokes(path).map(s=>({id:s.id,painted:0,sampled:false}));
 const kx=canvas.width/canvasRect.width,ky=canvas.height/canvasRect.height;
 return inlineInk.strokes(path).map(stroke=>{
  const b=stroke.bbox;
  const box={left:cr.left+b.x*scale*font-2,top:view.documentTop+b.y*scale*font-2,
   right:cr.left+(b.x+b.width)*scale*font+2,bottom:view.documentTop+(b.y+b.height)*scale*font+2};
  const left=Math.max(box.left,canvasRect.left,viewportRect.left),top=Math.max(box.top,canvasRect.top,viewportRect.top);
  const right=Math.min(box.right,canvasRect.right,viewportRect.right),bottom=Math.min(box.bottom,canvasRect.bottom,viewportRect.bottom);
  if(right<=left||bottom<=top) return {id:stroke.id,painted:0,sampled:false};
  const px=ctx.getImageData(Math.max(0,Math.floor((left-canvasRect.left)*kx)),Math.max(0,Math.floor((top-canvasRect.top)*ky)),
   Math.max(1,Math.ceil((right-left)*kx)),Math.max(1,Math.ceil((bottom-top)*ky))).data;
  let painted=0;for(let i=3;i<px.length;i+=4)if(px[i]!>20)painted++;
  return {id:stroke.id,painted,sampled:true};
 });
}
async function fitVisible(id:string) {const r=rigs.get(id)!.overlay.fitHandwriting();await settle();return {result:r,visiblePainted:visiblePainted(id),strokesPainted:strokesPainted(id),...snap(id)};}
async function growEmpty(id:string){surfaceExtents.grow(rigs.get(id)!.path,{x:500000,y:600000});rigs.get(id)!.overlay.updateExtent(true);await settle();return snap(id);}
async function reopen(id:string) {const r=rigs.get(id)!;r.view.destroy();r.host.remove();await setup(id);return snap(id);}
// The same view switching to another note (as a leaf does), not a fresh mount:
// the overlay sees the path change in its update and releases the viewport.
async function switchPath(id:string,path:string) {const r=rigs.get(id)!;const info=r.view.state.field(editorInfoField,false) as any;r.view.dispatch({effects:setBrowserEditorInfo.of({...info,file:{path}})});await settle();return snap(id);}
// A plugin reload on an open editor: the overlay's extension leaves the view's
// configuration (its instance is destroyed) and joins it again as a new
// instance on the same editor DOM. Every other extension is the same object.
// `fontPxWhileAway` sets the text size between the two, as a font change made
// while the plugin is disabled would.
// A text-size change as the app makes one: Obsidian's line height is 1.5 times
// the font, so the lines reflow with it. This rig's theme pins a 24 px line
// height, under which a note with no text would not reflow at all and nothing
// would observe the change.
function setTextPx(view:EditorView,px:number){view.contentDOM.style.fontSize=`${px}px`;view.contentDOM.style.lineHeight=`${px*1.5}px`;}
async function reloadOverlay(id:string,fontPxWhileAway?:number) {const r=rigs.get(id)!;const before=r.overlay;r.view.dispatch({effects:StateEffect.reconfigure.of(r.extensions.filter(e=>e!==r.overlayExtension))});await settle();if(fontPxWhileAway!==undefined){setTextPx(r.view,fontPxWhileAway);r.view.requestMeasure();await settle();}r.view.dispatch({effects:StateEffect.reconfigure.of(r.extensions)});await settle();const info=r.view.state.field(editorInfoField)!;r.overlay=overlayForActiveEditor(info.editor as never,info.file as never)!;return {newInstance:!!r.overlay&&r.overlay!==before,...snap(id)};}
function penEvent(type:string,x:number,y:number,pointerId=120){document.elementFromPoint(x,y)?.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:"pen",pointerId,isPrimary:true,clientX:x,clientY:y,buttons:type==="pointerup"?0:1,pressure:.5}));}
async function gesture(id:string,kind:string) {
 const r=rigs.get(id)!;const s=snap(id),b=s.ink[0]!;
 setPenInk(true);setInlineEraserMode(kind==="erase");setInlineLassoMode(kind==="lasso");
 const x=(b.x+b.right)/2,y=(b.y+b.bottom)/2;
 if(kind==="lasso") {
  const points=[[b.x-10,b.y-10],[b.right+10,b.y-10],[b.right+10,b.bottom+10],[b.x-10,b.bottom+10],[b.x-10,b.y-10]];
  for(let i=0;i<points.length;i++)penEvent(i===0?"pointerdown":"pointermove",points[i]![0]!,points[i]![1]!);
  penEvent("pointerup",points[0]![0]!,points[0]![1]!);
 } else {penEvent("pointerdown",x,y);penEvent("pointermove",x+1,y+1);penEvent("pointerup",x+1,y+1);}
 await settle();return snap(id);
}
async function stale(id:string) {
 const r=rigs.get(id)!;
 r.overlay.zoomNoteBy(.5);
 const next=`replacement-${id}.md`;
 r.view.dispatch({effects:StateEffect.reconfigure.of([history(),inkOverlayExtension()])});
 r.view.dispatch({changes:{from:0,to:r.view.state.doc.length,insert:"replacement untouched"},effects:StateEffect.reconfigure.of([history(),editorInfoField.init(()=>({app:{commands:{executeCommandById:()=>false}},file:{path:next},editor:{}})),inkOverlayExtension()])});
 await settle();return {doc:r.view.state.doc.toString(),scroll:[r.view.scrollDOM.scrollLeft,r.view.scrollDOM.scrollTop],transform:r.view.dom.style.transform,flashes:r.host.querySelectorAll(".handwriting-ink-flash").length};
}
// The note's surface grown to a given extent, as ink or scrolling far out would grow it.
const TRANSLATE=/translate\(\s*(-?[\d.e+-]+)px\s*,\s*(-?[\d.e+-]+)px\s*\)/;
function previewPaperState(id:string){
 const r=rigs.get(id)!,host=r.view.dom,sc=r.view.scrollDOM;
 const all=document.querySelectorAll(".handwriting-paper-preview").length;
 const readout=typeof r.overlay.previewPaperReadout==="function"?r.overlay.previewPaperReadout():null;
 const el=host.querySelector(":scope > .handwriting-paper-preview") as HTMLElement|null;
 const previewing=sc.classList.contains("handwriting-paper-previewing");
 if(!el)return {present:false,all,previewing,readout};
 const cs=getComputedStyle(el),m=TRANSLATE.exec(el.style.transform);
 const tx=m?Number(m[1]):0,ty=m?Number(m[2]):0;
 const marginY=sc.offsetTop+sc.clientTop-Number.parseFloat(cs.top),marginX=sc.offsetLeft+sc.clientLeft-Number.parseFloat(cs.left);
 const pitch=readout?.pitch??Number.NaN,fold=(v:number)=>((v%pitch)+pitch)%pitch;
 const er=el.getBoundingClientRect(),rr=sc.getBoundingClientRect(),k=Number.parseFloat(getComputedStyle(host).zoom)||1;
 return {present:true,all,previewing,readout,tx,ty,marginX,marginY,pitch,panX:fold(tx-marginX+sc.scrollLeft),panY:fold(ty-marginY+sc.scrollTop),
  image:cs.backgroundImage,size:cs.backgroundSize,position:cs.backgroundPosition,color:cs.backgroundColor,
  rect:{left:er.left,top:er.top,width:er.width,height:er.height},scroller:{left:rr.left+sc.clientLeft*k,top:rr.top+sc.clientTop*k,width:sc.clientWidth*k,height:sc.clientHeight*k},
  box:{top:Number.parseFloat(cs.top),left:Number.parseFloat(cs.left),width:Number.parseFloat(cs.width),height:Number.parseFloat(cs.height)}};
}
function paperOriginNow(id:string){
 const r=rigs.get(id)!,host=r.view.dom,sc=r.view.scrollDOM,hs=getComputedStyle(host);
 const num=(v:string,d:number)=>{const n=Number.parseFloat(v);return Number.isFinite(n)?n:d;};
 const painted=(r.overlay as any).cssScale as number;
 const k=Number.isFinite(painted)&&painted>0?painted:num(hs.zoom,1),pitch=num(hs.getPropertyValue("--handwriting-paper-pitch"),28);
 const phase=num(hs.getPropertyValue("--handwriting-paper-phase"),0),phaseX=num(hs.getPropertyValue("--handwriting-paper-phase-x"),0);
 const el=host.querySelector(":scope > .handwriting-paper-preview") as HTMLElement|null;
 if(el){const er=el.getBoundingClientRect();return {source:"element" as const,x:er.left+phaseX*k,y:er.top+phase*k,k,pitch,phase,phaseX};}
 const ss=getComputedStyle(sc),rr=sc.getBoundingClientRect();
 const panX=num(ss.getPropertyValue("--handwriting-paper-pan-x"),0),panY=num(ss.getPropertyValue("--handwriting-paper-pan-y"),0);
 return {source:"scroller" as const,x:rr.left+(sc.clientLeft+phaseX+panX-sc.scrollLeft)*k,y:rr.top+(sc.clientTop+phase+panY-sc.scrollTop)*k,k,pitch,phase,phaseX,panX,panY};
}
async function growTo(id:string,x:number,y:number){surfaceExtents.grow(rigs.get(id)!.path,{x,y});rigs.get(id)!.overlay.updateExtent(true);await settle();return snap(id);}
(window as any).viewportFixture={setup,snap,fit,fitVisible,growEmpty,growTo,reopen,switchPath,reloadOverlay,gesture,stale,settle,rest,
 preview:(id:string)=>!!(rigs.get(id)!.overlay as any).pinchPreview,
 panValues:(id:string)=>{const sc=rigs.get(id)!.view.scrollDOM;return {x:sc.style.getPropertyValue("--handwriting-paper-pan-x"),y:sc.style.getPropertyValue("--handwriting-paper-pan-y"),pitch:Number.parseFloat(rigs.get(id)!.view.dom.style.getPropertyValue("--handwriting-paper-pitch"))};},
 // The preview paper as the page shows it: its translate, its margin (from its resolved box, not from its rounding),
 // and the pan that places it, folded the way the scroller's pan properties would carry that pan.
 previewPaper:(id:string)=>previewPaperState(id),
 // The rig's overlay itself, for a cell that must drive one of its paths directly (a thrown settle, a standing pan).
 overlay:(id:string)=>rigs.get(id)!.overlay,
 // Where the paper's lattice origin is on screen this frame (client px), from whichever element draws the paper.
 paperOrigin:(id:string)=>paperOriginNow(id),
 hiddenFit:async(id:string)=>{const r=rigs.get(id)!;r.host.style.display="none";r.view.requestMeasure();await settle();const valid=r.overlay.scaleGeometryValid,result=r.overlay.fitHandwriting();return {valid,result,writes,strokes:JSON.parse(JSON.stringify(inlineInk.strokes(r.path)))};},
 caret:(id:string,pos:number)=>rigs.get(id)!.view.coordsAtPos(pos),
 keyboard:()=>setPenInk(false),
 hold:(id:string,on:boolean)=>{setPenInk(true);setInlineEraserMode(false);setInlineLassoMode(false);penEvent(on?"pointerdown":"pointerup",100,180,991);return snap(id).state.busy;},
 resize:async(id:string)=>{rigs.get(id)!.host.style.width="580px";rigs.get(id)!.host.style.height="430px";rigs.get(id)!.view.requestMeasure();await settle();return snap(id);},
 busy:(id:string)=>{const r=rigs.get(id)!;setPenInk(true);setInlineEraserMode(false);setInlineLassoMode(false);penEvent("pointerdown",100,180);const result=r.overlay.fitHandwriting();penEvent("pointerup",100,180);return result;},
 release:async(id:string)=>{const pageId=`fit-page-${id}`;blockedIds.delete(pageId);heldLoads.get(pageId)?.();await settle();return snap(id);},
 font:async(id:string)=>{const r=rigs.get(id)!;r.view.contentDOM.style.fontSize="24px";r.view.requestMeasure();await settle();return snap(id);},
 fontPx:async(id:string,px:number)=>{const r=rigs.get(id)!;setTextPx(r.view,px);r.view.requestMeasure();await settle();return snap(id);},
 corners:async(id:string)=>{const r=rigs.get(id)!;const before=inlineInk.strokes(r.path).length;setPenInk(true);setInlineEraserMode(false);setInlineLassoMode(false);for(const [x,y] of [[24,104],[610,104],[24,450],[610,450]]){penEvent("pointerdown",x!,y!);penEvent("pointermove",x!+4,y!);penEvent("pointerup",x!+4,y!);await settle();}const now=snap(id);const cr=r.view.contentDOM.getBoundingClientRect();const errors=inlineInk.strokes(r.path).slice(before).map((s,i)=>{const target=[[24,104],[610,104],[24,450],[610,450]][i]!;return [s.points[0]!.x-(target[0]!-cr.left)/r.overlay.scale,s.points[0]!.y-(target[1]!-r.view.documentTop)/r.overlay.scale];});return {added:inlineInk.strokes(r.path).length-before,errors,...now};},
 scroll:async(id:string)=>{const r=rigs.get(id)!;const before=snap(id);r.view.scrollDOM.scrollLeft=r.view.scrollDOM.scrollWidth-r.view.scrollDOM.clientWidth-1;r.view.scrollDOM.scrollTop=r.view.scrollDOM.scrollHeight-r.view.scrollDOM.clientHeight-1;await settle();return {before,after:snap(id)};},
 original:async(id:string)=>{const r=rigs.get(id)!;r.view.dom.style.setProperty("width","640px","important");r.view.dom.style.setProperty("transform","scale(0.8)");r.view.requestMeasure();await settle();return r.view.dom.getAttribute("style");},
 dispose:(id:string)=>{const r=rigs.get(id)!;r.view.destroy();return {style:r.view.dom.getAttribute("style"),classes:r.view.dom.className,parent:r.host.className};},
};

/**
 * Mounted sync admission proof. This reuses the real editors, hit-tested pen /
 * lasso driver, shared InlineInkStore and PageStore preservation. FakeAdapter
 * is the only filesystem/transport seam. The store route is invoked directly;
 * CompatibilitySyncWorkflow.test.ts separately runs the registered poll.
 */
(window as any).mountedSyncAdmission=async(kind:"pen"|"selection"|"transient-pane",phase:"before"|"during")=>{
 await setup("sync-a","point");
 const path=rigs.get("sync-a")!.path,pageId=ids.get(path)!,live=`.handwriting/${pageId}.json`;
 const adapter=new FakeAdapter();adapter.externalWrite(live,pages.get(pageId)!);
 const store=new PageStore({vault:{adapter}});
 await store.load(pageId);
 let accepts=0,preparations=0,notifications=0;
 const notices:string[]=[];
 inlineInk.attachHost({
  readPageId:p=>ids.get(p)??null,claimId:async(_p,id)=>({pageId:id}),
  loadSidecar:id=>store.load(id),scheduleSidecar:(id,data)=>store.schedule(id,data),
  scheduleSidecarNow:(id,data)=>store.saveNow(id,data),notify:message=>notices.push(message),
  prepareExternalAdoption:(id,data)=>{preparations++;return store.prepareExternalAdoption(id,data);},
  acceptExternalAdoption:prepared=>{accepts++;store.acceptExternalAdoption(prepared);},
 });
 await setup("sync-b","point",1,1,undefined,path);
 const a=rigs.get("sync-a")!,b=rigs.get("sync-b")!;
 if(a.overlay===b.overlay)throw Error("same-note fixture did not resolve distinct mounted overlays");
 const incoming=parsePage(adapter.files.get(live)!,pageId)!.data;
 incoming.strokes=structuredClone(incoming.strokes);
 incoming.strokes[0]!.id="incoming";
 for(const point of incoming.strokes[0]!.points){point.x+=140;point.y+=60;}
 adapter.externalWrite(live,serializePage(incoming));
 const painted=(id:string)=>{
  const {host}=rigs.get(id)!,canvas=host.querySelectorAll<HTMLCanvasElement>(".handwriting-ink-layer canvas")[2]!;
  const bytes=canvas.getContext("2d")!.getImageData(0,0,canvas.width,canvas.height).data;
  let hash=2166136261;for(let i=3;i<bytes.length;i+=4)hash=Math.imul(hash^bytes[i]!,16777619);
  return {alphaHash:hash>>>0,visible:visiblePainted(id)};
 };
 const pane=(id:string)=>{const s=snap(id);return {strokes:s.strokes,selected:s.selected,history:s.history,doc:s.doc,paint:painted(id)};};
 const state=async()=>({a:pane("sync-a"),b:pane("sync-b"),accepts,preparations,notifications,notices:[...notices],
  changed:await store.externallyChanged(pageId),queued:store.hasQueuedWrite(pageId),
  quiet:inlineReloadBindings().filter(x=>x.path===path).map(x=>x.quiet)});
 const adopt=async()=>{
  const admission=captureInlineReloadAdmission(path);
  const result=await inlineInk.adoptExternal(path,()=>!!admission&&admission()&&inlineInk.pageIdOf(path)===pageId&&!store.hasQueuedWrite(pageId));
  if(result.outcome==="adopted"&&result.changed){notifications++;inkExternallyReloaded(path);notifyInkChanged(path);}
  await settle();return result;
 };
 const rect=b.view.scrollDOM.getBoundingClientRect(),start={x:rect.left+320,y:rect.top+200};
 const route=(type:string,dx=0,dy=0)=>{
  const x=start.x+dx,y=start.y+dy,target=document.elementFromPoint(x,y);
  if(!target||!b.view.scrollDOM.contains(target))throw Error("sync pen was not hit-tested into busy sibling");
  penEvent(type,x,y,977);
 };
 let joined:any=null;
 const begin=async()=>{
  if(kind==="transient-pane"){
   await setup("sync-transient","point",1,1,undefined,path);joined=await state();
   const transient=rigs.get("sync-transient")!;transient.view.destroy();transient.host.remove();await settle();
  }else if(kind==="selection")await gesture("sync-b","lasso");
  else {setPenInk(true);setInlineEraserMode(false);setInlineLassoMode(false);route("pointerdown");route("pointermove",20,5);await settle();}
 };
 const before=await state();
 let busy:any,result:any;
 if(phase==="during"){
  const held=gate(),entered=gate(),write=adapter.write.bind(adapter);
  adapter.writeGate=held.promise;
  adapter.write=async(p,data)=>{entered.release();return write(p,data);};
  const pending=adopt();
  await Promise.race([entered.promise,pending.then(r=>{throw Error(`adoption ended before preservation gate: ${JSON.stringify(r)}`);})]);
  await begin();busy=await state();
  held.release();adapter.writeGate=null;result=await pending;
 }else {await begin();busy=await state();result=await adopt();}
 const refused=await state();
 let completed:any=null,undone:any=null,redone:any=null;
 if(kind==="selection"){
  // A real lasso already lifted in begin(); only the user's Escape dismisses it.
  b.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));
  await settle();
 }else if(kind==="pen"){
  // Continue the SAME live stroke after the held await; no second pointerdown.
  route("pointermove",50,15);route("pointerup",50,15);await settle();
  completed=await state();
  undo(b.view);await settle();undone=await state();
  redo(b.view);await settle();redone=await state();
  await store.flush();
  // A later delivered revision is the visibility target after local writes drain.
  // Selection cases above need no local edit or second delivery to converge.
  adapter.externalWrite(live,serializePage(incoming));
 }
 const released=await state(),retry=await adopt(),after=await state();
 const recovery=[...adapter.files.entries()].filter(([p])=>p.includes(".conflict-")).map(([p,data])=>({path:p,ids:parsePage(data,pageId)?.data.strokes.map(s=>s.id)}));
 const pointScale=b.overlay.scale;
 return {kind,phase,before,joined,busy,result,refused,completed,undone,redone,released,retry,after,recovery,pointScale};
};

// C1: the converged-pinch-settle path closes the reload gate.
// 7c95786e's InkOverlay.ts carries `settled()` in the `hold.ready` branch of the settle
// measure's write, and that call is in NEITHER parent of the merge. mountedSyncCameraSettlement
// above drives the Zoom out BUTTON, which never builds a pan-anchor hold, so it does not reach
// that branch; nothing else did either.
//
// THE OUTCOME IS READ, NOT JUST THE GATE. finish() also calls settled(), so a run that bailed
// out would close the gate too and a gate-only assertion would pass on the wrong path. The hold
// is captured before the settle and its `outcome` read after: "converged" is set only at
// InkOverlay.ts:7201, on the path the plant deletes.
(window as any).mountedSyncPinchSettlement=async()=>{
 await setup("pinch-settling","point");const r=rigs.get("pinch-settling")!;const o=r.overlay as any;
 // OBSIDIAN'S `.cm-sizer > .cm-contentContainer` IS INSERTED FIRST, the way
 // scrollColumnAnchorPage.ts:255-266 does it. `panSizer()` (InkOverlay.ts:6396) looks for
 // `.cm-sizer`, vanilla CodeMirror 6 has none, and with no sizer the settle builds NO pan-anchor
 // hold at all - measured here: outcome "no hold built", diag.sizer false. A pinch on a rig
 // without it is not the gesture production runs. `.cm-content` is MOVED, not cloned, so
 // CodeMirror keeps measuring the element it holds a reference to.
 if(!r.view.dom.querySelector(".cm-sizer")){
  const content=r.view.contentDOM,sizer=document.createElement("div"),container=document.createElement("div");
  sizer.className="cm-sizer";container.className="cm-contentContainer";
  content.parentElement!.insertBefore(sizer,content);sizer.appendChild(container);container.appendChild(content);
  void r.view.scrollDOM.clientWidth;await settle();
 }
 const before=!!captureInlineReloadAdmission(r.path);
 // THE HOLD IS CAUGHT AT ASSIGNMENT, NOT BY SAMPLING. Build, commit, measure and retirement can all
 // run inside one flush, so a per-frame read of `panAnchorHold` sees null before and null after and
 // reports "no hold built" for a settle that did build one (measured: previewSeen true, sizer true,
 // scale 1 -> 0.5, and still no hold visible). An accessor over the instance's own property records
 // the first non-null assignment and otherwise behaves exactly like the field it replaces.
 let hold:any=null;
 {const own=o.panAnchorHold;let cur=own;
  Object.defineProperty(o,"panAnchorHold",{configurable:true,
   get(){return cur;},set(v:any){cur=v;if(v&&!hold)hold=v;}});}
 // THE GATE IS TRAPPED THE SAME WAY AND FOR THE SAME REASON. `reloadCameraSettlement` is opened at
 // InkOverlay.ts:8203 and closed by settled() at :8293 inside the same flush, so no per-frame read
 // ever catches it open. What the cell needs is that it WAS opened and IS closed, not the instant.
 let gateOpened=false;
 {let cur=o.reloadCameraSettlement;
  Object.defineProperty(o,"reloadCameraSettlement",{configurable:true,
   get(){return cur;},set(v:any){cur=v;if(v!==null)gateOpened=true;}});}
 const focal={x:320,y:240};
 // FRAMES BETWEEN THE PHASES. `pinch("move")` schedules the preview on a rAF; calling "end" in the
 // same tick settles before any preview frame painted, and the settle then takes a path that builds
 // no pan-anchor hold (measured: previewSeen false, outcome "no hold built", even with the sizer in
 // place). A real two-finger pinch spans frames, so this one does too.
 o.pinch("start",1,focal);
 await new Promise<void>(res=>requestAnimationFrame(()=>res()));
 o.pinch("move",.7,focal);
 await new Promise<void>(res=>requestAnimationFrame(()=>res()));
 o.pinch("move",.5,focal);
 await new Promise<void>(res=>requestAnimationFrame(()=>res()));
 const previewSeen=!!o.pinchPreview;
 const during=!!captureInlineReloadAdmission(r.path);
 o.pinch("end",.5,focal);
 // THE HOLD AND THE GATE ARE SAMPLED ACROSS THE SETTLE, NOT AT ONE INSTANT. `pinch("end")` only
 // schedules the settle; the hold is built inside the commit a frame or more later, and it is
 // retired again once its measure consumes it. Reading `panAnchorHold` immediately after the
 // gesture sees null and reading it after the settle sees null too - the first version of this
 // cell did the former and reported "no hold built", which is a measurement artifact, not a
 // finding. The object is captured the first frame it exists and read afterwards; it survives
 // its own retirement because the retirement drops the reference, not the object.
 for(let i=0;i<64;i++){
  await new Promise<void>(res=>requestAnimationFrame(()=>res()));
  if(hold&&hold.outcome!=="pending")break;
 }
 await settle();
 return {before,during,gateOpened,after:!!captureInlineReloadAdmission(r.path),
  gate:o.reloadCameraSettlement,outcome:hold?hold.outcome:"no hold built",zoom:snap("pinch-settling").state.zoom,
  diag:{sizer:!!(o.view?.dom?.querySelector?.(".cm-sizer")),scaleNow:o.scale,pinchScaleNow:o.pinchScaleNow,
   previewSeen,generation:o.viewportGeneration,firstConsumer:typeof o.firstSettleConsumer==="function"?o.firstSettleConsumer():"n/a"}};
};

(window as any).mountedSyncCameraSettlement=async()=>{
 await setup("settling","point");const r=rigs.get("settling")!;
 const before=!!captureInlineReloadAdmission(r.path);
 setPenInk(false);r.view.focus();r.view.dispatch({selection:{anchor:1,head:8}});await settle();
 const textSelection=!!captureInlineReloadAdmission(r.path),textRange=r.view.state.selection.main.toJSON();
 setPenInk(true);setInlineLassoMode(true);
 const chosenTool=!!captureInlineReloadAdmission(r.path);
 r.view.scrollDOM.dispatchEvent(new PointerEvent("pointermove",{bubbles:true,pointerType:"pen",pointerId:966,isPrimary:true,clientX:300,clientY:200,buttons:0,pressure:0}));
 const hover=!!captureInlineReloadAdmission(r.path);setInlineLassoMode(false);
 r.host.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click();
 const pending=!!captureInlineReloadAdmission(r.path);
 await settle();return {before,textSelection,textRange,chosenTool,hover,pending,after:!!captureInlineReloadAdmission(r.path),zoom:snap("settling").state.zoom};
};

async function momentum(zoom:number,axis:"x"|"y",mode:string) {
 await setup("momentum","far");const r=rigs.get("momentum")!;
 if(zoom!==1){r.host.querySelector<HTMLButtonElement>(zoom<1?'[aria-label="Zoom out"]':'[aria-label="Zoom in"]')!.click();await settle();}
 setScrollExpansionEnabled(mode==="on"||mode==="native");
 if(mode==="native")setPenGestureGuardEnabled(false);
 await settle();
 const scroller=r.view.scrollDOM,router=r.overlay.router;
 const offset=()=>axis==="x"?scroller.scrollLeft:scroller.scrollTop;
 const before=offset(),touchAction=getComputedStyle(scroller).touchAction;
 for(const [type,n] of [["pointerdown",380],["pointermove",340],["pointermove",300],["pointermove",260],["pointerup",260]] as const){
  const x=axis==="x"?n:300,y=axis==="y"?n:300;
  document.elementFromPoint(x,y)!.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:"touch",pointerId:301,isPrimary:true,clientX:x,clientY:y,buttons:type==="pointerup"?0:1,width:8,height:8}));
  if(type!=="pointerup")await new Promise(resolve=>setTimeout(resolve,25));
 }
 const lifted=offset(),started=router.flingRaf!==0;
 let stopped=lifted;
 for(let i=0;i<240;i++){
  await new Promise(resolve=>requestAnimationFrame(resolve));
  if(i===2&&mode==="toggle"){setScrollExpansionEnabled(true);stopped=offset();}
  if(i===2&&(mode==="pen"||mode==="pinch")){
   const kind=mode==="pen"?"pen":"touch";
   for(const pid of mode==="pinch"?[401,402]:[401])scroller.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,cancelable:true,pointerType:kind,pointerId:pid,isPrimary:pid===401,clientX:200+(pid-401)*100,clientY:200,buttons:1,pressure:.5}));
   for(const pid of mode==="pinch"?[401,402]:[401])scroller.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,cancelable:true,pointerType:kind,pointerId:pid,isPrimary:pid===401,clientX:200+(pid-401)*100,clientY:200,buttons:0}));
   stopped=offset();
  }
  if(router.flingRaf===0&&i>4)break;
 }
 const end=offset();await settle();return {zoom,axis,mode,before,lifted,started,stopped,end,settled:offset(),running:router.flingRaf!==0,touchAction};
}
(window as any).momentum=momentum;

(window as any).nativeMomentumSetup=async()=>{await setup("native","far");setPenGestureGuardEnabled(false);await settle();};
(window as any).nativeMomentumState=()=>{const r=rigs.get("native")!;return {left:r.view.scrollDOM.scrollLeft,top:r.view.scrollDOM.scrollTop,fling:r.overlay.router.flingRaf!==0,touchAction:getComputedStyle(r.view.scrollDOM).touchAction};};

// Audit entry points operate the mounted production controls/router/history.
(window as any).edgeAudit={
 commit:async(id:string,scale:number)=>{const accepted=rigs.get(id)!.overlay.commitCameraScale(scale);await settle();return {accepted,...snap(id)};},
 floorPinch:async(id:string)=>{
  const r=rigs.get(id)!;r.overlay.commitCameraScale(.2,{left:0,top:0});await settle();
  const send=(type:string,pointerId:number,x:number)=>{const target=document.elementFromPoint(x,250);if(!target||!r.view.scrollDOM.contains(target))throw Error("pinch outside editor");target.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:"touch",pointerId,isPrimary:pointerId===701,clientX:x,clientY:250,buttons:type==="pointerup"?0:1,width:8,height:8}));};
  send("pointerdown",701,250);send("pointerdown",702,350);send("pointermove",701,295);send("pointermove",702,305);await settle();
  const live=snap(id);send("pointerup",701,295);send("pointerup",702,305);await settle();return {live,after:snap(id)};
 },
 zoom:async(id:string,factor:number)=>{const accepted=rigs.get(id)!.overlay.zoomNoteBy(factor);await settle();return {accepted,...snap(id)};},
 // A real two-finger pinch from the CURRENT scale: spread `from` px closing or
 // opening to `to` px about (300,250). floorPinch above first commits 20%.
 pinchBy:async(id:string,from:number,to:number)=>{
  const r=rigs.get(id)!;
  const send=(type:string,pointerId:number,x:number)=>{const target=document.elementFromPoint(x,250);if(!target||!r.view.scrollDOM.contains(target))throw Error("pinch outside editor");target.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:"touch",pointerId,isPrimary:pointerId===701,clientX:x,clientY:250,buttons:type==="pointerup"?0:1,width:8,height:8}));};
  send("pointerdown",701,300-from/2);send("pointerdown",702,300+from/2);send("pointermove",701,300-to/2);send("pointermove",702,300+to/2);await settle();
  const live=snap(id);send("pointerup",701,300-to/2);send("pointerup",702,300+to/2);await settle();return {live,after:snap(id)};
 },
 history:async(id:string,action:string)=>{const accepted=(action==="undo"?undo:redo)(rigs.get(id)!.view);await settle();return {accepted,...snap(id)};},
 eraseOutlier:async(id:string)=>{const r=rigs.get(id)!;const b=snap(id).ink.at(-1)!;setPenInk(true);setInlineLassoMode(false);setInlineEraserMode(true);const x=(b.x+b.right)/2,y=(b.y+b.bottom)/2;penEvent("pointerdown",x,y);penEvent("pointermove",x+1,y+1);penEvent("pointerup",x+1,y+1);await settle();return snap(id);},
 heldTool:async(id:string,kind:string)=>{const r=rigs.get(id)!;setPenInk(true);setInlineEraserMode(kind==="erase");setInlineLassoMode(kind==="lasso");penEvent("pointerdown",300,250,876);penEvent("pointermove",310,260,876);const before=snap(id),result=r.overlay.fitHandwriting();penEvent("pointerup",310,260,876);await settle();return {before,result,after:snap(id)};},
 tinyTouch:async(id:string)=>{const r=rigs.get(id)!;setPenInk(false);setInlineEraserMode(false);setInlineLassoMode(false);setPenGestureGuardEnabled(false);const scroller=r.view.scrollDOM;const before=snap(id);const event=(type:string,pid:number,x:number,y:number)=>scroller.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:"touch",pointerId:pid,isPrimary:pid===701,clientX:x,clientY:y,buttons:type==="pointerup"?0:1,width:8,height:8}));event("pointerdown",701,300,350);event("pointermove",701,300,290);event("pointerup",701,300,290);await settle();const panned=snap(id);const fling=r.overlay.router.flingRaf!==0;event("pointerdown",701,250,250);event("pointerdown",702,350,250);event("pointermove",702,450,250);await settle();const pinched=snap(id);event("pointerup",701,250,250);event("pointerup",702,450,250);await settle();return {before,panned,pinched,after:snap(id),fling};},
};

// Reuse the real store, editor, camera and hit-tested router to compare the
// Insert Space contact/preview boundary with the eventual text/ink operation.
(window as any).insertSpaceProbe=async(zoom=1,font=1,scroll=0,wrapped=false,options:{dy?:number;end?:string;textOnly?:boolean;markup?:boolean;edit?:boolean;shortText?:string;context?:string;contactY?:number;tall?:boolean;sweep?:number[];moves?:number[];invalidTarget?:boolean;localColumns?:boolean;clickOnly?:boolean;verifySaved?:boolean}={})=>{
 const id="space-precision",path=`fit-${id}.md`,pageId=`fit-page-${id}`;
 const data=emptyPage(pageId);data.surface="inline";
 data.strokes=[90,210].map((y,i)=>({id:`row-${i}`,tool:"pen" as const,color:"#000000",width:2,createdAt:1,points:[{x:30,y,pressure:.5,t:0},{x:40,y:y+20,pressure:.5,t:10}],bbox:{x:28,y:y-2,width:14,height:24}}));
 if(options.tall)data.strokes=[{id:"tall",x:30,top:50,bottom:190},{id:"distant",x:330,top:170,bottom:230},{id:"below",x:80,top:280,bottom:300}].map(s=>({id:s.id,tool:"pen",color:"#000000",width:2,createdAt:1,points:[{x:s.x,y:s.top,pressure:.3,t:0},{x:s.x+10,y:s.bottom,pressure:.8,t:10}],bbox:{x:s.x-2,y:s.top-2,width:14,height:s.bottom-s.top+4}}));
 if(options.localColumns)data.strokes=[{id:"left-upper",x:0,w:200,top:60,bottom:95},{id:"right-upper",x:600,w:300,top:90,bottom:115},{id:"left-crossing",x:0,w:200,top:110,bottom:150},{id:"right-lower",x:600,w:300,top:140,bottom:170}].map(s=>({id:s.id,tool:"pen",color:"#000000",width:2,createdAt:1,points:[{x:s.x,y:s.top,pressure:.3,t:0},{x:s.x+s.w,y:s.bottom,pressure:.8,t:10}],bbox:{x:s.x-2,y:s.top-2,width:s.w+4,height:s.bottom-s.top+4}}));
 if(options.textOnly)data.strokes=[];
 ids.set(path,pageId);pages.set(pageId,serializePage(data));
 const paragraph="word ".repeat(240);
 const contextual=options.context==="setext-dash"?paragraph+"\n---\nlast":options.context==="setext-equals"?paragraph+"\n===\nlast":options.context==="fence"?"```\n"+paragraph+"\n```\nlast":options.context==="frontmatter"?"---\ntitle: "+paragraph+"\n---\nlast":undefined;
 const doc=contextual??options.shortText??(wrapped?(options.markup?`**${paragraph}**`:paragraph)+"\nlast":Array.from({length:80},(_,i)=>`text line ${i+1}`).join("\n"));
 await setup(id,"empty",1,1,doc);const r=rigs.get(id)!;
 if(options.localColumns){r.view.dom.style.width="1000px";r.view.dom.parentElement!.style.width="1000px";r.view.requestMeasure();await settle();}
 if(font!==1){r.view.contentDOM.style.fontSize=`${16*font}px`;r.view.requestMeasure();await settle();}
 r.overlay.commitCameraScale(zoom,{left:0,top:scroll});await settle();
 const origin=r.view.contentDOM.getBoundingClientRect().top+parseFloat(getComputedStyle(r.view.contentDOM).paddingTop)*r.overlay.cssScale;
 const scale=r.overlay.scale,contact={x:100,y:origin+(options.contactY??104)*scale};
 // Observe the actual transient renderer, not a copy of the planner's IDs.
 // Each recorded stroke must also produce pixels at its projected midpoint.
 let rendered:any[]=[],labels:any[]=[],guides:number[]=[];
 const tail=r.overlay.tail,clear=tail.clearAll.bind(tail),draw=tail.drawSpaceStroke?.bind(tail),label=tail.drawSpaceLabel?.bind(tail),divider=tail.drawSpaceDivider.bind(tail);
 tail.clearAll=(...args:any[])=>{rendered=[];labels=[];guides=[];return clear(...args);};
 if(draw)tail.drawSpaceStroke=(cam:any,s:any,color:string,...args:any[])=>{
  if(!draw(cam,s,color,...args))return false;
  const a=s.points[0],b=s.points.at(-1),ctx=tail.ctx;
  const px=((a.x+b.x)/2-cam.x)*cam.zoom,py=((a.y+b.y)/2-cam.y)*cam.zoom;
  const ratio=ctx.canvas.width/r.overlay.cssWidth;
  const data=ctx.getImageData(Math.floor(px*ratio)-1,Math.floor(py*ratio)-1,3,3).data;
  const alpha=Array.from(data).filter((_,i)=>i%4===3).some(v=>(v as number)>0);
  rendered.push({id:s.id,moving:color!=="#d98b00",alpha});return true;
 };
 if(label)tail.drawSpaceLabel=(cam:any,y:number,text:string,...args:any[])=>{labels.push({y,text});return label(cam,y,text,...args);};
 tail.drawSpaceDivider=(cam:any,y:number,...args:any[])=>{guides.push(y);return divider(cam,y,...args);};
 const feedback=()=>({rendered:structuredClone(rendered),labels:structuredClone(labels),guides:[...guides]});
 if(options.invalidTarget)r.overlay.planSpace=()=>null;
 const coords=()=>Array.from({length:r.view.state.doc.lines},(_,i)=>{const l=r.view.state.doc.line(i+1),c=r.view.coordsAtPos(l.from);return {text:l.text,top:c?.top,bottom:c?.bottom};});
 const capture=()=>({doc:r.view.state.doc.toString(),strokes:JSON.parse(JSON.stringify(inlineInk.strokes(path))),text:coords(),rects:Array.from({length:r.view.state.doc.length+1},(_,i)=>r.view.coordsAtPos(i,1)),zoom:r.overlay.getNoteViewportState().zoom,history:undoDepth(r.view.state),scroll:{left:r.view.scrollDOM.scrollLeft,top:r.view.scrollDOM.scrollTop}});
 const before=capture();
 const otherPath="space-switch-other.md",otherId="space-switch-other";
 let otherBefore:any=null,otherAfter:any=null;
 if(options.end==="switch"){
  const other=emptyPage(otherId);other.surface="inline";
  // Deliberately reuse stroke IDs: an inverse applied to the new note is
  // observable even when it looks superficially like the original moving set.
  other.strokes=structuredClone(data.strokes);
  for(const s of other.strokes){for(const p of s.points)p.y+=500;s.bbox.y+=500;}
  ids.set(otherPath,otherId);pages.set(otherId,serializePage(other));await inlineInk.ensureLoaded(otherPath);
  otherBefore=structuredClone(inlineInk.strokes(otherPath));
 }
 setPenInk(true);setInlineSpaceMode(true);
 const sweep=[];
 for(const y of options.sweep??[]){penEvent("pointermove",contact.x,origin+y*scale,921);await new Promise(requestAnimationFrame);sweep.push({y,reticle:r.overlay.penCursorEl?.getBoundingClientRect().top,...feedback()});}
 penEvent("pointermove",contact.x,contact.y,921);
 await new Promise(requestAnimationFrame);
 const hover=r.overlay.penCursorEl?.getBoundingClientRect().top;
 const hoverFeedback=feedback();
 penEvent("pointerdown",contact.x,contact.y,921);
 const down={cut:r.overlay.spaceLineY,ids:[...r.overlay.spaceIds],reticle:r.overlay.penCursorEl?.getBoundingClientRect().top,mode:r.overlay.mode,...feedback()};
 const dy=options.clickOnly?0:options.dy??48;
 const moves=[];
 for(const y of options.moves??[]){penEvent("pointermove",contact.x,contact.y+y*scale,921);await new Promise(requestAnimationFrame);moves.push({dy:y,ids:[...r.overlay.spaceIds],strokes:capture().strokes,reticle:r.overlay.penCursorEl?.getBoundingClientRect().top,...feedback()});}
 if(!options.clickOnly)penEvent("pointermove",contact.x,contact.y+dy*scale,921);
 await new Promise(requestAnimationFrame);
 const live={cut:r.overlay.spaceLineY,dy:r.overlay.spaceTotalDy,reticle:r.overlay.penCursorEl?.getBoundingClientRect().top,...feedback()};
 if(options.edit)r.view.dispatch({changes:{from:r.view.state.doc.length,insert:" external"},annotations:isolateHistory.of("full")});
 if(options.end==="blur")window.dispatchEvent(new Event("blur"));
 else if(options.end==="unmount")r.overlay.unmount();
 else if(options.end==="switch"){
  // A switch hands the view a different file object; the same object with a new path is a rename.
  const info=r.view.state.field(editorInfoField) as any,own=info.file;
  info.file={path:otherPath};r.view.dispatch({});await settle();
  otherAfter=structuredClone(inlineInk.strokes(otherPath));
  info.file=own;r.view.dispatch({});
 }else penEvent(options.end??"pointerup",contact.x,contact.y+dy*scale,921);
 await settle();
 const after=capture();
 const ended=feedback();
 let undone:ReturnType<typeof capture>|null=null,redone:ReturnType<typeof capture>|null=null;
 let undoResult:boolean|null=null,persisted:any=null;
 if(after.history>before.history||options.verifySaved){undoResult=undo(r.view);await settle();undone=capture();if(undoResult){redo(r.view);await settle();redone=capture();}}
 if(options.verifySaved){inlineInk.save(path);await settle();persisted=parsePage(pages.get(pageId)!,pageId)!.data.strokes;}
 return {zoom,font,scroll,wrapped,scale,origin,contact,hover,hoverFeedback,sweep,moves,down,live,ended,before,after,undone,redone,undoResult,persisted,otherBefore,otherAfter};
};
