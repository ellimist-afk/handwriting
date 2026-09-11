import { setPenGestureGuardEnabled } from "../../src/inline/InlinePenRouter";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { history, undoDepth, undo, redo } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineEraserMode, setInlineLassoMode } from "../../src/inline/InkOverlay";
import { surfaceExtents } from "../../src/inline/SurfaceExtent";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";

import { serializePage, parsePage, emptyPage, type PageData } from "../../src/model/PageData";
installObsidianDom();
const ids = new Map<string,string>(), pages = new Map<string,string>();
let writes = 0;
const heldLoads=new Map<string,()=>void>();
const blockedIds=new Set<string>();
const save = (id:string,page:PageData) => { writes++; pages.set(id,serializePage(page)); };
inlineInk.attachHost({readPageId:p=>ids.get(p)??null,claimId:async(p,id)=>{writes++;ids.set(p,id);return{pageId:id};},loadSidecar:async id=>{if(blockedIds.has(id))await new Promise<void>(r=>heldLoads.set(id,r));return pages.has(id)?parsePage(pages.get(id)!,id):null;},scheduleSidecar:save,scheduleSidecarNow:async(id,p)=>save(id,p),notify:()=>{}});
const settle = async () => { for(let i=0;i<8;i++) await new Promise<void>(r=>requestAnimationFrame(()=>r())); };
async function run(zoom:number,candidate:boolean,axis: "x" | "y" = "y",font=1,cancel=false) {
	const path = `viewport-${zoom}-${axis}-${font}-${cancel}.md`;
 surfaceExtents.grow(path,{x:250000,y:250000});
	// Stable has no scroll-demand expansion switch; seeded fixture extent only.
	const host = document.body.appendChild(document.createElement("div"));
	host.className = "markdown-source-view camera-proof";
	const doc = "alpha beta gamma delta ".repeat(30)+"\nsecond line";
	const view = new EditorView({parent:host,state:EditorState.create({doc,extensions:[history(),EditorView.lineWrapping,editorInfoField.init(()=>({app:{commands:{executeCommandById:()=>false}},file:{path},editor:{}})),inkOverlayExtension(),EditorView.theme({"&":{width:"640px",height:"480px"},".cm-content":{fontFamily:"monospace",fontSize:"16px",lineHeight:"24px"}})]})});
	await settle();
	const overlay=overlayForPath(path)!;
	if(!overlay) throw new Error("mounted overlay missing");
	const positions=()=>Array.from({length:Math.min(doc.length,100)},(_,i)=>{const c=view.coordsAtPos(i)!;const origin=view.contentDOM.getBoundingClientRect();return [Math.round((c.left-origin.left)/view.scaleX*100)/100,Math.round((c.top-origin.top)/view.scaleY*100)/100];});
	if(font!==1){view.contentDOM.style.fontSize=`${16*font}px`;view.requestMeasure();await settle();}
 const layoutBefore=positions();
	const before={doc:view.state.doc.toString(),writes,history:undoDepth(view.state)};
	for(let tries=0;tries<5&&(overlay as any).getNoteViewportState().zoom>zoom;tries++){host.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click();await settle();}
 for(let tries=0;tries<5&&(overlay as any).getNoteViewportState().zoom<zoom;tries++){host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();await settle();}
 view.requestMeasure(); await settle();
 if((overlay as any).getNoteViewportState().zoom!==zoom)throw Error(JSON.stringify({state:(overlay as any).getNoteViewportState(),loaded:inlineInk.isLoaded(path),mode:(overlay as any).mode,builder:(overlay as any).builder,valid:(overlay as any).scaleGeometryValid,button:host.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')?.disabled}));
	const layoutAfter=positions();
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
 view.destroy();host.remove();
	return {zoom,candidate,layoutBefore,layoutAfter,before,after,corners,strokes,errors,measured,touchTrace,flingUpdates,terminalOffset,cancelled,cancelOffset,lock,axis,font,cancel,invalidBefore,invalidRejected,hidden,recovered};
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
const rigs=new Map<string,{host:HTMLElement;view:EditorView;overlay:any;path:string}>();
async function setup(id:string,kind="far",font=1,external=1) {
 const path=`fit-${id}.md`,pageId=`fit-page-${id}`;
 if(kind==="loading")blockedIds.add(pageId);
 setScrollExpansionEnabled(true);
 if(!ids.has(path)) {
  const data=emptyPage(pageId);data.surface="inline";
  const points=kind==="empty"?[]:kind==="edge"?[[6,120]]:kind==="point"?[[80,120]]:kind==="huge"?[[200,200],[9_000_000,9_000_000]]:[[200,200],[18000,22000]];
  const long=kind!=="point"&&kind!=="edge";const width=long?32:2,dx=long?800:10,dy=long?600:8;
  data.strokes=points.map(([x,y],i)=>({id:`seed-${i}`,tool:"pen" as const,color:"#000000",width,createdAt:1,points:[{x:x!,y:y!,pressure:.5,t:0},{x:x!+dx,y:y!+dy,pressure:.5,t:10}],bbox:{x:x!-width,y:y!-width,width:dx+2*width,height:dy+2*width}}));
  if(kind==="thick-dot"||kind==="negative")data.strokes=[{id:"seed-0",tool:"pen",color:"#000000",width:kind==="thick-dot"?1000:2,createdAt:1,points:[{x:kind==="thick-dot"?3000:-100,y:3000,pressure:.5,t:0}],bbox:{x:0,y:0,width:0,height:0}}]; // Parse recomputes the stored bbox.
  // Geometry below reproduces R2's mounted-review receipt exactly (bboxes
  // 92,92 / 92,-60 / -508,99992 / 99992,-508, all 36x36), so the fixtures
  // match the exact configuration R2 verified rather than an invented one.
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
  // Exactly R2's "disjoint-unreachable" case: the same two outliers with NO
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
 const doc="alpha beta gamma delta ".repeat(30)+"\n# Heading\n- list item\nsecond line";
 const view=new EditorView({parent:host,state:EditorState.create({doc,extensions:[history(),EditorView.lineWrapping,EditorView.decorations.of(Decoration.set([Decoration.widget({widget:new InlineWidget()}).range(doc.indexOf("# Heading"))])),editorInfoField.init(()=>({app:{commands:{executeCommandById:()=>false}},file:{path},editor:{}})),inkOverlayExtension(),EditorView.theme({"&":{width:"640px",height:"480px"},".cm-content":{fontFamily:"monospace",fontSize:`${16*font}px`,lineHeight:"24px"}})]})});
 await settle();
 const overlay=overlayForPath(path)!;rigs.set(id,{host,view,overlay,path});
 return snap(id);
}
function snap(id:string) {
 const {host,view,overlay,path}=rigs.get(id)!;
 const cr=view.contentDOM.getBoundingClientRect(),sr=view.scrollDOM.getBoundingClientRect(),scale=overlay.cssScale,font=overlay.fontZoom;
 const paperStyle=getComputedStyle(view.scrollDOM);
 return {paddingTop:Number.parseFloat(getComputedStyle(view.contentDOM).paddingTop),paper:{image:paperStyle.backgroundImage,attachment:paperStyle.backgroundAttachment},state:overlay.getNoteViewportState(),doc:view.state.doc.toString(),writes,history:undoDepth(view.state),strokes:JSON.parse(JSON.stringify(inlineInk.strokes(path))),extent:surfaceExtents.get(path),scroll:{left:view.scrollDOM.scrollLeft,top:view.scrollDOM.scrollTop,width:view.scrollDOM.scrollWidth,height:view.scrollDOM.scrollHeight},viewport:{x:sr.x,y:sr.y,width:sr.width,height:sr.height},ink:inlineInk.strokes(path).map(s=>({id:s.id,x:cr.left+s.bbox.x*scale*font,y:view.documentTop+s.bbox.y*scale*font,right:cr.left+(s.bbox.x+s.bbox.width)*scale*font,bottom:view.documentTop+(s.bbox.y+s.bbox.height)*scale*font})),layout:Array.from({length:100},(_,i)=>{const c=view.coordsAtPos(i)!;return[(c.left-cr.left)/scale,(c.top-cr.top)/scale];}),buttons:[...host.querySelectorAll(".handwriting-note-viewport-controls button")].map(b=>b.getBoundingClientRect().toJSON()),backings:[...host.querySelectorAll("canvas")].map(c=>c.width*c.height),selection:view.state.selection.main.toJSON(),selected:overlay.selection.strokeIds,handles:host.querySelectorAll(".handwriting-selection-handle").length};
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
async function fitVisible(id:string) {const r=rigs.get(id)!.overlay.fitHandwriting();await settle();return {result:r,visiblePainted:visiblePainted(id),...snap(id)};}
async function growEmpty(id:string){surfaceExtents.grow(rigs.get(id)!.path,{x:500000,y:600000});rigs.get(id)!.overlay.updateExtent(true);await settle();return snap(id);}
async function reopen(id:string) {const r=rigs.get(id)!;r.view.destroy();r.host.remove();await setup(id);return snap(id);}
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
(window as any).viewportFixture={setup,snap,fit,fitVisible,growEmpty,reopen,gesture,stale,settle,
 hiddenFit:async(id:string)=>{const r=rigs.get(id)!;r.host.style.display="none";r.view.requestMeasure();await settle();const valid=r.overlay.scaleGeometryValid,result=r.overlay.fitHandwriting();return {valid,result,writes,strokes:JSON.parse(JSON.stringify(inlineInk.strokes(r.path)))};},
 caret:(id:string,pos:number)=>rigs.get(id)!.view.coordsAtPos(pos),
 keyboard:()=>setPenInk(false),
 hold:(id:string,on:boolean)=>{setPenInk(true);setInlineEraserMode(false);setInlineLassoMode(false);penEvent(on?"pointerdown":"pointerup",100,180,991);return snap(id).state.busy;},
 resize:async(id:string)=>{rigs.get(id)!.host.style.width="580px";rigs.get(id)!.host.style.height="430px";rigs.get(id)!.view.requestMeasure();await settle();return snap(id);},
 busy:(id:string)=>{const r=rigs.get(id)!;setPenInk(true);setInlineEraserMode(false);setInlineLassoMode(false);penEvent("pointerdown",100,180);const result=r.overlay.fitHandwriting();penEvent("pointerup",100,180);return result;},
 release:async(id:string)=>{const pageId=`fit-page-${id}`;blockedIds.delete(pageId);heldLoads.get(pageId)?.();await settle();return snap(id);},
 font:async(id:string)=>{const r=rigs.get(id)!;r.view.contentDOM.style.fontSize="24px";r.view.requestMeasure();await settle();return snap(id);},
 corners:async(id:string)=>{const r=rigs.get(id)!;const before=inlineInk.strokes(r.path).length;setPenInk(true);setInlineEraserMode(false);setInlineLassoMode(false);for(const [x,y] of [[24,104],[610,104],[24,450],[610,450]]){penEvent("pointerdown",x!,y!);penEvent("pointermove",x!+4,y!);penEvent("pointerup",x!+4,y!);await settle();}const now=snap(id);const cr=r.view.contentDOM.getBoundingClientRect();const errors=inlineInk.strokes(r.path).slice(before).map((s,i)=>{const target=[[24,104],[610,104],[24,450],[610,450]][i]!;return [s.points[0]!.x-(target[0]!-cr.left)/r.overlay.scale,s.points[0]!.y-(target[1]!-r.view.documentTop)/r.overlay.scale];});return {added:inlineInk.strokes(r.path).length-before,errors,...now};},
 scroll:async(id:string)=>{const r=rigs.get(id)!;const before=snap(id);r.view.scrollDOM.scrollLeft=r.view.scrollDOM.scrollWidth-r.view.scrollDOM.clientWidth-1;r.view.scrollDOM.scrollTop=r.view.scrollDOM.scrollHeight-r.view.scrollDOM.clientHeight-1;await settle();return {before,after:snap(id)};},
 original:async(id:string)=>{const r=rigs.get(id)!;r.view.dom.style.setProperty("width","640px","important");r.view.dom.style.setProperty("transform","scale(0.8)");r.view.requestMeasure();await settle();return r.view.dom.getAttribute("style");},
 dispose:(id:string)=>{const r=rigs.get(id)!;r.view.destroy();return {style:r.view.dom.getAttribute("style"),classes:r.view.dom.className,parent:r.host.className};},
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
 zoom:async(id:string,factor:number)=>{const accepted=rigs.get(id)!.overlay.zoomNoteBy(factor);await settle();return {accepted,...snap(id)};},
 history:async(id:string,action:string)=>{const accepted=(action==="undo"?undo:redo)(rigs.get(id)!.view);await settle();return {accepted,...snap(id)};},
 eraseOutlier:async(id:string)=>{const r=rigs.get(id)!;const b=snap(id).ink.at(-1)!;setPenInk(true);setInlineLassoMode(false);setInlineEraserMode(true);const x=(b.x+b.right)/2,y=(b.y+b.bottom)/2;penEvent("pointerdown",x,y);penEvent("pointermove",x+1,y+1);penEvent("pointerup",x+1,y+1);await settle();return snap(id);},
 heldTool:async(id:string,kind:string)=>{const r=rigs.get(id)!;setPenInk(true);setInlineEraserMode(kind==="erase");setInlineLassoMode(kind==="lasso");penEvent("pointerdown",300,250,876);penEvent("pointermove",310,260,876);const before=snap(id),result=r.overlay.fitHandwriting();penEvent("pointerup",310,260,876);await settle();return {before,result,after:snap(id)};},
 tinyTouch:async(id:string)=>{const r=rigs.get(id)!;setPenInk(false);setInlineEraserMode(false);setInlineLassoMode(false);setPenGestureGuardEnabled(false);const scroller=r.view.scrollDOM;const before=snap(id);const event=(type:string,pid:number,x:number,y:number)=>scroller.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:"touch",pointerId:pid,isPrimary:pid===701,clientX:x,clientY:y,buttons:type==="pointerup"?0:1,width:8,height:8}));event("pointerdown",701,300,350);event("pointermove",701,300,290);event("pointerup",701,300,290);await settle();const panned=snap(id);const fling=r.overlay.router.flingRaf!==0;event("pointerdown",701,250,250);event("pointerdown",702,350,250);event("pointermove",702,450,250);await settle();const pinched=snap(id);event("pointerup",701,250,250);event("pointerup",702,450,250);await settle();return {before,panned,pinched,after:snap(id),fling};},
};
