import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, inlineReloadCandidates, captureInlineReloadAdmission, inkExternallyReloaded } from "../../src/inline/InkOverlay";
import { notifyInkChanged } from "../../src/inline/InkEvents";
import { PageStore } from "../../src/persistence/PageStore";
import { FakeAdapter } from "../../src/persistence/FakeAdapter";
import { setPenInk } from "../../src/inline/PenInk";
import { emptyPage, parsePage, serializePage, type PageData } from "../../src/model/PageData";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import type { InkStroke } from "../../src/ink/Stroke";
import { surfaceExtents, ScrollExpansionDemand } from "../../src/inline/SurfaceExtent";
import { WetInkRenderer } from "../../src/ink/WetInkRenderer";
import { TailRenderer } from "../../src/ink/TailRenderer";
import { DEFAULT_PEN } from "../../src/ink/PenStyle";
installObsidianDom();
const path = "drift.md", id = "drift-page";
let saved = "", loads = 0;
let view: EditorView;
let exactReferenceStroke: InkStroke | undefined;
const settle = async () => { for(let i=0;i<8;i++) await new Promise<void>(r=>requestAnimationFrame(()=>r())); };
const save = (_id: string, data: PageData) => { saved = serializePage(data); };
inlineInk.attachHost({ readPageId:()=>id, claimId:async()=>({pageId:id}), loadSidecar:async()=>{loads++;const result=parsePage(saved,id);if(exactReferenceStroke)result.data.strokes[result.data.strokes.length-1]=exactReferenceStroke;return result;}, scheduleSidecar:save, scheduleSidecarNow:async(i,p)=>save(i,p), notify:()=>{} });
async function setup(bytes?: string, obsidianWrappers = false, referenceStroke?: InkStroke) {
 exactReferenceStroke=referenceStroke;
 const data=emptyPage(id); data.surface="inline";
 data.strokes=[{id:"old",tool:"pen",color:"#000000",width:2,createdAt:1,points:[{x:300,y:300,pressure:.5,t:0},{x:320,y:310,pressure:.5,t:10}],bbox:{x:298,y:298,width:24,height:14}}];
 saved=bytes??serializePage(data);
 const host=document.body.appendChild(document.createElement("div"));host.className="markdown-source-view mod-cm6 drift-host";
 view=new EditorView({parent:host,state:EditorState.create({doc:Array.from({length:80},(_,i)=>`line ${i} anchor text`).join("\n"),extensions:[history(),editorInfoField.init(()=>({app:{commands:{executeCommandById:()=>false}},file:{path},editor:{}})),inkOverlayExtension(),EditorView.theme({".cm-content":{fontFamily:"monospace",fontSize:"16px",lineHeight:"24px"}})]})});
 if(obsidianWrappers){
  const sizer=document.createElement("div"),container=document.createElement("div");
  sizer.className="cm-sizer";container.className="cm-contentContainer";
  view.scrollDOM.insertBefore(sizer,view.contentDOM);sizer.appendChild(container);container.appendChild(view.contentDOM);
 }
 setScrollExpansionEnabled(true);setPenInk(true);await settle();return {...snapshot(),pixels:pixels()};
}
function snapshot(){return {saved,loads,strokes:JSON.parse(JSON.stringify(inlineInk.strokes(path))),scaleY:view.scaleY};}
function point(type:string,x:number,y:number,pointerType="pen",pointerId=741,timestamp?:number){
 const target=document.elementFromPoint(x,y);
 if(!target||!view.scrollDOM.contains(target))throw Error(`input outside scroller: ${x},${y}`);
 const event=new PointerEvent(type,{bubbles:true,cancelable:true,pointerType,pointerId,isPrimary:true,clientX:x,clientY:y,buttons:type==="pointerup"||type==="pointercancel"?0:1,pressure:.6,width:8,height:8});
 if(timestamp!==undefined)Object.defineProperty(event,"timeStamp",{value:timestamp});
 target.dispatchEvent(event);
}
async function write(scale:number,measured:boolean,pinch:boolean,cancel:boolean){
 const overlay=overlayForPath(path)! as any;
 view.scrollDOM.scrollLeft=16;view.scrollDOM.scrollTop=24;await settle();
 if(pinch){
  point("pointerdown",300,220,"touch",501);point("pointerdown",400,220,"touch",502);
  point("pointermove",350-50*scale,220,"touch",501);point("pointermove",350+50*scale,220,"touch",502);
  point(cancel?"pointercancel":"pointerup",350-50*scale,220,"touch",501);point("pointerup",350+50*scale,220,"touch",502);
 }else if(!overlay.commitCameraScale(scale,{left:16,top:24}))throw Error("zoom refused");
 if(measured)await settle();
 // Independent physical origin: the first text line's DOM top/left, never camera helpers.
 const line=view.contentDOM.querySelector(".cm-line")!.getBoundingClientRect();
 // Keep fractional counter-sized layout width; offsetWidth rounds and biases the physical oracle.
 const actual=view.dom.getBoundingClientRect().width/parseFloat(getComputedStyle(view.dom).width);
 const x=line.left+400*actual,y=line.top+200*actual;
 const before={scale:actual,cached:view.scaleY,expected:{x:400,y:200},scroll:{left:view.scrollDOM.scrollLeft,top:view.scrollDOM.scrollTop}};
 // Fixed sample intervals keep velocity shaping independent of runner load.
 // At 5ms the warm and serialized ribbons straddle an antialiasing cutoff.
 const t=performance.now();
 point("pointerdown",x,y,"pen",741,t);point("pointermove",x+8,y+4,"pen",741,t+5);point("pointerup",x+12,y+6,"pen",741,t+10);
 await settle();return {...before,...snapshot(),pixels:pixels()};
}
function pixels(displace = 0){
 const overlay=overlayForPath(path)! as any;
 const canvas=overlay.committedCanvas as HTMLCanvasElement,rect=canvas.getBoundingClientRect();
 const ctx=canvas.getContext("2d")!;
 if(displace){const original=ctx.getImageData(0,0,canvas.width,canvas.height);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.putImageData(original,0,Math.round(displace*canvas.height/rect.height));}
 const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
 const line=view.contentDOM.querySelector(".cm-line")!.getBoundingClientRect();
 const scale=view.dom.getBoundingClientRect().width/parseFloat(getComputedStyle(view.dom).width);
 const bounds=()=>({minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity,count:0});
 const blue=bounds(),black=bounds();
 for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
  const i=(y*canvas.width+x)*4;if(data[i+3]!<=10)continue;
  const b=data[i+2]!>data[i]!+40&&data[i+2]!>data[i+1]!+10?blue:data[i]!<30&&data[i+1]!<30&&data[i+2]!<30?black:null;
  if(!b)continue;const px=(rect.left+x*rect.width/canvas.width-line.left)/scale,py=(rect.top+y*rect.height/canvas.height-line.top)/scale;
  b.count++;b.minX=Math.min(b.minX,px);b.minY=Math.min(b.minY,py);b.maxX=Math.max(b.maxX,px);b.maxY=Math.max(b.maxY,py);
 }
 return {blue,black};
}
async function raster(){
 const overlay=overlayForPath(path)! as any;
 if(!overlay.commitCameraScale(1,{left:0,top:0}))throw Error("reset refused");await settle();
 return {...pixels(),...snapshot()};
}
function reference(exact = false){
 // Match the subject's precision: warm geometry retains full precision, while
 // cold geometry has passed through the sidecar's coordinate/pressure rounding.
 // Both are placed at the independently specified physical anchor.
 const page=parsePage(saved,id).data;
 if(exact)page.strokes[page.strokes.length-1]=structuredClone(inlineInk.strokes(path).at(-1)!);
 const stroke=page.strokes.at(-1)!;
 const dx=400-stroke.points[0]!.x,dy=200-stroke.points[0]!.y;
 for(const point of stroke.points){point.x+=dx;point.y+=dy;}
 stroke.bbox.x+=dx;stroke.bbox.y+=dy;
 return exact?stroke:serializePage(page);
}
function dense(count: number, mixed: boolean | 'overlap' = false) {
 const page=emptyPage(id);page.surface="inline";
 for(let s=0;s<count;s++) {
  const x=30+(s%10)*70,y=30+Math.floor(s/10)*15;
  const highlight=mixed&&s%3===0;
  page.strokes.push({id:`dense-${s}`,tool:highlight?"highlighter":"pen",color:highlight?"#ffff00":"#000000",width:highlight?8:2,createdAt:s,
   points:Array.from({length:80},(_,i)=>({x:x+i*.6,y:y+Math.sin(i/5)*5,pressure:.5,t:i*4})),
   bbox:{x:x-(highlight?16:4),y:y-(highlight?21:9),width:highlight?80:56,height:highlight?42:18}});
 }
 if(mixed==='overlap')for(const [i,stroke] of page.strokes.filter(s=>s.tool==='highlighter').entries()){
  page.strokes.push({...stroke,id:stroke.id+'-pen',tool:'pen',color:'#000000',width:i%2?.5:2,points:stroke.points.map(p=>({...p,y:p.y+1}))});
 }
 if(mixed==='overlap'){
  page.strokes.push({id:'wide-wash',tool:'highlighter',color:'#ffff00',width:40,createdAt:999,points:[{x:150,y:300,pressure:.5,t:0},{x:550,y:300,pressure:.5,t:100}],bbox:{x:110,y:260,width:480,height:80}});
  page.strokes.push({id:'wash-crossing',tool:'pen',color:'#000000',width:20,createdAt:1000,points:[{x:350,y:220,pressure:.7,t:0},{x:350,y:380,pressure:.7,t:100}],bbox:{x:310,y:180,width:80,height:240}});
  // Isolated straight arms make thin-ink continuity independently observable;
  // their yellow underlay cannot supply the black contrast being checked.
  for(const [width,y] of [[.5,420],[2,450]])for(const tool of ['highlighter','pen'] as const){
   page.strokes.push({id:`thin-arm-${width}-${tool}`,tool,color:tool==='pen'?'#000000':'#ffff00',width:tool==='pen'?width!:16,createdAt:1001,points:[{x:350,y:y!,pressure:.5,t:0},{x:460,y:y!,pressure:.5,t:50},{x:570,y:y!,pressure:.5,t:100}],bbox:{x:330,y:y!-20,width:260,height:40}});
  }
 }
 return serializePage(page);
}
function occupiedPixels(canvas:HTMLCanvasElement){const data=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;let count=0;for(let i=3;i<data.length;i+=4)if(data[i])count++;return count;}
function rasterHash(canvas:HTMLCanvasElement){const data=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data,words=new Uint32Array(data.buffer);let hash=2166136261;for(const word of words)hash=Math.imul(hash^word,16777619);return hash>>>0;}
function blankLifecycle(){
 const canvas=()=>{const c=document.createElement('canvas');c.width=320;c.height=180;return c;};
 const wc=canvas(),tc=canvas(),wet=new WetInkRenderer(wc,false),tail=new TailRenderer(tc),cam={x:0,y:0,zoom:1},rows:any[]=[];
 const sample=(name:string)=>rows.push({name,wet:{blank:wet.provenBlank,pixels:occupiedPixels(wc)},tail:{blank:tail.provenBlank,pixels:occupiedPixels(tc)}});
 wet.noteBackingCleared();tail.noteBackingCleared();sample('empty');
 const write=(x:number)=>{wet.beginStroke({x,y:40,pressure:.7,t:0});wet.appendPoint(cam,DEFAULT_PEN,{x:x+40,y:50,pressure:.7,t:20});};
 write(20);tail.drawHead(cam,DEFAULT_PEN,{x:20,y:80},{x:70,y:85},.7);sample('occupied');
 wet.clearStroke(320,180);tail.clear();sample('cleared');
 write(20);tail.drawSelectionBox(cam,{x:120,y:30,width:70,height:40},'#ff0000');sample('occupied-again');
 // A second begin does not clear the first stroke; a tracked tip does not
 // account for selection UI that is already in the same canvas.
 write(200);tail.drawHead(cam,DEFAULT_PEN,{x:20,y:100},{x:60,y:105},.7);wet.clearStroke(320,180);tail.clear();sample('partial-keeps-prior');
 wet.clear(320,180);tail.clearAll(320,180);sample('full-clear');
 write(30);tail.drawHead(cam,DEFAULT_PEN,{x:30,y:100},{x:90,y:105},.7);sample('restored');
 return rows;
}
async function layerVisual(action:string,zoom=.4){
 const overlay=overlayForPath(path)! as any;
 if(action==='setup'){overlay.commitCameraScale(zoom,{left:0,top:0});await settle();}
 if(action==='preview')overlay.hideBlankPinchLayers();
 if(action==='thin-gap-plant'){
  // Remove a middle segment only from the borrowed preview, keeping its wash.
  const target=overlay.wetCanvas as HTMLCanvasElement,ctx=target.getContext('2d')!,cam=overlay.lastPaintCam,dpr=target.width/overlay.cssWidth;
  const x=(430-cam.x)*cam.zoom*dpr,y=(417-cam.y)*cam.zoom*dpr,w=60*cam.zoom*dpr,h=6*cam.zoom*dpr;
  ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(x,y,w,h);ctx.globalAlpha=Number(getComputedStyle(overlay.highlightCanvas).opacity);ctx.drawImage(overlay.highlightCanvas,x,y,w,h,x,y,w,h);ctx.restore();
 }
 if(action.startsWith('shift-plant')){
  // Move the whole borrowed preview right by 'shift-plant:<backing px>' (default 1): the same ink, off by that much.
  const target=overlay.wetCanvas as HTMLCanvasElement,ctx=target.getContext('2d')!;
  ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.globalCompositeOperation='copy';ctx.drawImage(target,Number(action.split(':')[1]??1),0);ctx.restore();
 }
 if(action==='scaled-preview'){overlay.pinch('start',1,{x:30,y:10});overlay.pinch('move',zoom===.1?4:.25,{x:30,y:10});for(let i=0;i<3;i++)await new Promise<void>(r=>requestAnimationFrame(()=>r()));overlay.pinchScrollAt=performance.now()+60000;}
 if(action==='restore')overlay.restorePinchLayers();
 if(action==='tail')overlay.tail.drawSelectionBox(overlay.camera.snapshot,{x:overlay.camera.x+120,y:overlay.camera.y+120,width:80,height:60},'#ff0000');
 if(action==='tail-clear')overlay.tail.clearAll(overlay.cssWidth,overlay.cssHeight);
 if(action==='tail-full')overlay.tail.restoreFullSurface();
 if(action==='wet'){const first={x:overlay.camera.x+100,y:overlay.camera.y+100,pressure:.8,t:0};overlay.wet.beginStroke(first);overlay.wet.appendPoint(overlay.camera.snapshot,DEFAULT_PEN,{...first,x:first.x+80,y:first.y+30,t:20});overlay.wet.appendPoint(overlay.camera.snapshot,DEFAULT_PEN,{...first,x:first.x+160,y:first.y+50,t:40});overlay.wet.finishStroke(overlay.camera.snapshot,DEFAULT_PEN);}
 if(action==='wet-clear')overlay.wet.clear(overlay.cssWidth,overlay.cssHeight);
 if(action==='repaint'){overlay.damage.addAll();overlay.repaint();}
 if(action==='resize')overlay.handleResize();
 if(action==='pen'){point('pointerdown',350,220,'pen',951);point('pointermove',390,240,'pen',951);point('pointerup',410,250,'pen',951);await settle();}
  const canvases=[overlay.highlightCanvas,overlay.highlightWetCanvas,overlay.committedCanvas,overlay.wetCanvas,overlay.tailCanvas] as HTMLCanvasElement[];
 if(action==='background'){overlay.visualSavedVisibility=canvases.map(c=>c.style.visibility);for(const c of canvases)c.style.visibility='hidden';}
 // A FOREIGN placement on one input: the composite must refuse it (the
 // pixels would land elsewhere than the target's), leaving all five visible.
 if(action==='foreign-transform'){const c=overlay.committedCanvas as HTMLCanvasElement;overlay.foreignSaved={transform:c.style.transform,origin:c.style.transformOrigin};c.style.transform='scale(10.5)';c.style.transformOrigin='0 0';}
 // NOT '50% 50%': that is the property's own initial value, so it plants
 // nothing wherever the path leaves the origin unset - which is what the
 // canvases get whenever their box carries no transform. A plant must differ
 // from the value in effect on EVERY path, or the arm passes by luck on one
 // of them and guards nothing.
 if(action==='foreign-origin'){const c=overlay.committedCanvas as HTMLCanvasElement;overlay.foreignSaved={transform:c.style.transform,origin:c.style.transformOrigin};c.style.transformOrigin='13px 17px';}
 if(action==='foreign-translate'||action==='foreign-rotate'||action==='foreign-scale'){const c=overlay.committedCanvas as HTMLCanvasElement,prop=action.slice(8) as 'translate'|'rotate'|'scale';overlay.foreignSaved={transform:c.style.transform,origin:c.style.transformOrigin,prop,value:(c.style as any)[prop]};(c.style as any)[prop]=prop==='translate'?'7px 0':prop==='rotate'?'1deg':'1.05';}
 if(action==='foreign-restore'){const c=overlay.committedCanvas as HTMLCanvasElement;c.style.transform=overlay.foreignSaved.transform;c.style.transformOrigin=overlay.foreignSaved.origin;if(overlay.foreignSaved.prop)(c.style as any)[overlay.foreignSaved.prop]=overlay.foreignSaved.value;delete overlay.foreignSaved;}
 if(action==='background-restore'){canvases.forEach((c,i)=>c.style.visibility=overlay.visualSavedVisibility[i]);delete overlay.visualSavedVisibility;}
 const rect=overlay.committedCanvas.getBoundingClientRect(),sx=rect.width/overlay.cssWidth,sy=rect.height/overlay.cssHeight,cam=overlay.lastPaintCam;
 const thinArms=[{width:.5,y:420},{width:2,y:450}].map(arm=>({width:arm.width,x0:rect.left+(380-cam.x)*cam.zoom*sx,x1:rect.left+(540-cam.x)*cam.zoom*sx,y:rect.top+(arm.y-cam.y)*cam.zoom*sy}));
 return {thinArms,composite:overlay.pinchComposite,visible:canvases.map(c=>getComputedStyle(c).visibility),tailBacking:{w:overlay.tailCanvas.width,h:overlay.tailCanvas.height,bandW:overlay.wetCanvas.width,bandH:overlay.wetCanvas.height},pixels:canvases.map(occupiedPixels),originalHashes:action==='setup'||action==='restore'?[rasterHash(overlay.highlightCanvas),rasterHash(overlay.committedCanvas)]:null,blank:[overlay.highlightBlank,overlay.highlightWet.provenBlank,overlay.committedBlank,overlay.wet.provenBlank,overlay.tail.provenBlank],strokes:JSON.stringify(inlineInk.strokes(path))};
}
async function continuousPinch(target: number, cancel: boolean, measure = false, costPlant = false, diagnostic?: { startScale: number; hover: boolean; moving: boolean }) {
 const overlay=overlayForPath(path)! as any;
 if(diagnostic){if(!overlay.commitCameraScale(diagnostic.startScale,{left:160,top:160}))throw Error('diagnostic scale refused');await settle();}
 const from=overlay.pinchScaleNow;
 // At small scales use a corner gesture so the requested scroll stays
 // nonnegative. The maximum horizontal range can still clamp independently.
 const cx=diagnostic?400:target<.5?60:400,cy=diagnostic?220:target<.5?40:220,startHalf=diagnostic?45:target<.5?40:100;
 view.scrollDOM.scrollLeft=160;view.scrollDOM.scrollTop=160;await settle();
 const before=snapshot(),column=view.contentDOM.offsetWidth;
 // Whether the scroll above released the wet canvas (the pinch's composite then sizes it once at its start).
 const wetReleasedBefore=(overlay as any).wetDeferred===true;
 let live=true,backingWrites=0,wetBackingWrites=0,liveClears=0,liveTransactions=0,finalTransactions=0;
 const dimensions=()=>({scale:overlay.pinchScaleNow,grant:{...surfaceExtents.get(path)},band:{...overlay.band},canvases:[...view.dom.querySelectorAll('canvas')].map(c=>({width:c.width,height:c.height,cssWidth:c.style.width,cssHeight:c.style.height,transform:c.style.transform,visibility:c.style.visibility,rect:c.getBoundingClientRect().toJSON()})),native:{width:view.scrollDOM.clientWidth,height:view.scrollDOM.clientHeight,scrollWidth:view.scrollDOM.scrollWidth,scrollHeight:view.scrollDOM.scrollHeight}});
 const initialDimensions=measure?dimensions():null;
 const timing={firstMotionAt:0,firstPreviewAt:0,lastMoveAt:0,frameGaps:[] as number[],pointerMs:[] as number[],oracleMs:[] as number[],previews:[] as {scale:number;queueMs:number;workMs:number}[],methods:{} as Record<string,{calls:number;ms:number;maxMs:number;rectReads:number;rectMs:number}>,reserveCalls:0,cursorPaints:0,exitRestoreMs:[] as number[]};
 const measuredMethods=new Map<string,(...args:any[])=>any>();
 let activeMethod='',lastFrameAt=0;
 const rectMethod=Element.prototype.getBoundingClientRect;
 if(measure){
  for(const name of ['applyPinchScale','applyViewportBox','applyPreviewInkOffset','anchorPanTo','columnLocalAt','contentTopLocalAt','handleResize','repaint','updateExtent','refreshPenCursor','paintPenCursor','refreshPinchConstraint','reducePinchConstraint','preparePinchComposite','restorePinchLayers']){
   if(typeof overlay[name]!=='function')continue;
   const original=overlay[name];measuredMethods.set(name,original);
   timing.methods[name]={calls:0,ms:0,maxMs:0,rectReads:0,rectMs:0};
   overlay[name]=function(...args:any[]){
    if(!live){const copy=name==='restorePinchLayers'&&this.pinchComposite,start=performance.now();try{return original.apply(this,args);}finally{if(copy)timing.exitRestoreMs.push(performance.now()-start);}}
    const previous=activeMethod;activeMethod=name;const start=performance.now(),entry=timing.methods[name]!;
    if(name==='applyPinchScale'&&!timing.firstPreviewAt)timing.firstPreviewAt=start;
    try{
     // Deliberate timing-sensor control, enabled only by the test runner.
     if(costPlant&&name==='applyPreviewInkOffset')while(performance.now()-start<8){}
     return original.apply(this,args);
    }finally{
     const ms=performance.now()-start;entry.calls++;entry.ms+=ms;entry.maxMs=Math.max(entry.maxMs,ms);
     if(name==='paintPenCursor')timing.cursorPaints++;
     if(name==='applyPinchScale')timing.previews.push({scale:args[0],queueMs:start-timing.lastMoveAt,workMs:ms});
     activeMethod=previous;
    }
   };
  }
  Element.prototype.getBoundingClientRect=function(){const start=performance.now();try{return rectMethod.call(this);}finally{const entry=timing.methods[activeMethod];if(live&&entry){entry.rectReads++;entry.rectMs+=performance.now()-start;}}};
 }
 const reserve=ScrollExpansionDemand.prototype.reserve;
 if(measure)ScrollExpansionDemand.prototype.reserve=function(...args:Parameters<typeof reserve>){if(live)timing.reserveCalls++;return reserve.apply(this,args);};
 const liveAnchors:{x:number;y:number;column:number;viewportWidth:number;viewportHeight:number;boundaryX:number;boundaryY:number;naturalBoundaryX:number}[]=[];
 const pane=view.dom.parentElement!.getBoundingClientRect();
 let anchor:{x:number;y:number;worldX:number;worldY:number}|null=null;
 let originX=0, originY=0, hostTop=0, hostLeft=0, naturalOriginX=0;
 const naturalBoundaryX=(scale:number)=>Math.min(0,hostLeft+(naturalOriginX+anchor!.worldX)*scale-anchor!.x);
 const boundaryY=(scale:number)=>Math.min(0,hostTop+(originY+anchor!.worldY)*scale-anchor!.y);
 const boundaryX=(scale:number)=>{
  const a=anchor!,wanted=a.worldX-(a.x-originX)/scale,max=Math.max(0,view.scrollDOM.scrollWidth-view.scrollDOM.clientWidth);
  return (wanted-Math.max(0,Math.min(wanted,max)))*scale;
 };
 const commit=overlay.commitCameraScale,pinch=overlay.pinch;
 overlay.commitCameraScale=function(...args:any[]){if(live)liveTransactions++;else finalTransactions++;return commit.apply(this,args);};
 overlay.pinch=function(phase:string,ratio:number,centroid:{x:number;y:number}) {
  if(phase==="start") {const r=view.contentDOM.getBoundingClientRect();anchor={...centroid,worldX:(centroid.x-r.left)/from,worldY:(centroid.y-r.top)/from};originX=r.left+view.scrollDOM.scrollLeft;hostLeft=view.dom.getBoundingClientRect().left;naturalOriginX=r.left-hostLeft+view.scrollDOM.scrollLeft*overlay.cssScale;hostTop=view.dom.getBoundingClientRect().top;originY=r.top-hostTop+view.scrollDOM.scrollTop*overlay.cssScale;}
  if(measure&&phase==="move")timing.lastMoveAt=performance.now();
  return pinch.call(this,phase,ratio,centroid);
 };
 const canvasProto=HTMLCanvasElement.prototype;
 const descriptors=["width","height"].map(key=>[key,Object.getOwnPropertyDescriptor(canvasProto,key)!] as const);
 for(const [key,d] of descriptors)Object.defineProperty(canvasProto,key,{...d,set:function(value:number){if(live){backingWrites++;if(this===overlay.wetCanvas)wetBackingWrites++;}d.set!.call(this,value);}});
 const clear=CanvasRenderingContext2D.prototype.clearRect;
 CanvasRenderingContext2D.prototype.clearRect=function(...args:Parameters<typeof clear>){if(live&&(this===overlay.committedCtx||this===overlay.highlightCtx))liveClears++;return clear.apply(this,args);};
 try {
  if(measure)performance.mark("handwriting-preview-start");
  point("pointerdown",cx-startHalf,cy,"touch",501);point("pointerdown",cx+startHalf,cy,"touch",502);
  for(let i=1;i<=60;i++) {
   await new Promise<void>(r=>requestAnimationFrame(()=>r()));
   const frameAt=performance.now();if(measure&&lastFrameAt)timing.frameGaps.push(frameAt-lastFrameAt);lastFrameAt=frameAt;const oracleAt=performance.now();
   if(anchor) {const a=anchor as {x:number;y:number;worldX:number;worldY:number},r=view.contentDOM.getBoundingClientRect(),viewport=view.scrollDOM.getBoundingClientRect();liveAnchors.push({x:r.left+a.worldX*overlay.pinchScaleNow-a.x,y:r.top+a.worldY*overlay.pinchScaleNow-a.y,column:view.contentDOM.offsetWidth,viewportWidth:viewport.width,viewportHeight:viewport.height,boundaryX:boundaryX(overlay.pinchScaleNow),boundaryY:boundaryY(overlay.pinchScaleNow),naturalBoundaryX:naturalBoundaryX(overlay.pinchScaleNow)});}
   if(measure)timing.oracleMs.push(performance.now()-oracleAt);
   const half=startHalf*(1+(target-1)*i/60),inputAt=performance.now();
   const dx=diagnostic?.moving?-120*i/60:0,dy=diagnostic?.moving?-60*i/60:0;
   if(measure&&!timing.firstMotionAt)timing.firstMotionAt=inputAt;
   point("pointermove",cx+dx-half,cy+dy,"touch",501);point("pointermove",cx+dx+half,cy+dy,"touch",502);
   if(diagnostic?.hover)view.scrollDOM.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'pen',pointerId:851,clientX:450,clientY:260,buttons:0,pressure:0}));
   if(measure)timing.pointerMs.push(performance.now()-inputAt);
  }
  await new Promise<void>(r=>requestAnimationFrame(()=>r()));
  const liveScale=overlay.pinchScaleNow,liveDimensions=measure?dimensions():null;
  live=false;if(measure)performance.mark("handwriting-preview-end");
  const endX=cx+(diagnostic?.moving?-120:0),endY=cy+(diagnostic?.moving?-60:0);
  point(cancel?"pointercancel":"pointerup",endX-startHalf*target,endY,"touch",501);
  point("pointerup",endX+startHalf*target,endY,"touch",502);
  await settle();
  const rect=view.contentDOM.getBoundingClientRect(),a=anchor!;
  const viewport=view.scrollDOM.getBoundingClientRect();
  return {timing:measure?timing:null,initialDimensions,liveDimensions,finalDimensions:measure?dimensions():null,backingWrites,wetBackingWrites,wetReleasedBefore,liveClears,liveTransactions,finalTransactions,liveScale,liveAnchors,
   pane:{width:pane.width,height:pane.height},viewport:{width:viewport.width,height:viewport.height},
   finalScale:overlay.pinchScaleNow,columnBefore:column,columnAfter:view.contentDOM.offsetWidth,
   anchorError:{x:rect.left+a.worldX*target-a.x,y:rect.top+a.worldY*target-a.y,boundaryX:boundaryX(target),boundaryY:boundaryY(target),naturalBoundaryX:naturalBoundaryX(target)},
   before,after:snapshot(),pixels:diagnostic?null:pixels(),preview:overlay.pinchPreview};
 } finally {
  overlay.commitCameraScale=commit;overlay.pinch=pinch;
  for(const [key,d] of descriptors)Object.defineProperty(canvasProto,key,d);
  CanvasRenderingContext2D.prototype.clearRect=clear;
  if(measure)ScrollExpansionDemand.prototype.reserve=reserve;
  if(measure){Element.prototype.getBoundingClientRect=rectMethod;for(const [name,original] of measuredMethods)overlay[name]=original;}
 }
}
async function pendingPinchPen(measured:boolean,cancel:boolean){
 const overlay=overlayForPath(path)! as any;
 view.dispatch({changes:{from:0,to:view.state.doc.length,insert:Array.from({length:600},(_,i)=>`line ${i} anchor`).join("\n")}});
 await settle();view.scrollDOM.scrollTop=5000;await settle();
 const coverage=()=>{
  const c=overlay.committedCanvas.getBoundingClientRect(),v=view.scrollDOM.getBoundingClientRect();
  let bluePixels=0;
  for(const canvas of view.dom.querySelectorAll("canvas")){
   // A layer with no backing yet (the highlight pair before any highlighter use) holds no pixels, and getImageData refuses a 0 width.
   if(canvas.width===0||canvas.height===0)continue;
   const data=canvas.getContext("2d")!.getImageData(0,0,canvas.width,canvas.height).data;
   for(let i=0;i<data.length;i+=4)if(data[i+3]!>10&&data[i+2]!>data[i]!+40&&data[i+2]!>data[i+1]!+10)bluePixels++;
  }
  return {top:c.top-v.top,bottom:c.bottom-v.bottom,bluePixels,locked:overlay.frame.locked,band:{...overlay.band}};
 };
 point("pointerdown",300,240,"touch",501);point("pointerdown",500,240,"touch",502);
 point("pointermove",367.8,240,"touch",501);point("pointermove",432.2,240,"touch",502);
 point(cancel?"pointercancel":"pointerup",367.8,240,"touch",501);point("pointerup",432.2,240,"touch",502);
 if(measured)await settle();
 const before=coverage();
 // CONTACT WHERE THE INK SURFACE IS. The focal anchor holds the pinch with a
 // translate on the scroller's children, and a zoom-out from scrollLeft 0 is
 // exactly the case the scroll cannot express: measured here, the settle keeps
 // 294.18px of it as pan and the committed canvas starts at client x=191 with
 // the pane still starting at 0. A fixed 150 lands in the empty strip the pan
 // opened to the left of the note - outside every canvas, so nothing paints and
 // the arm measures the strip rather than the held ink. Offset from the canvas
 // itself, clamped into the pane, so the contact follows the note at any pan.
 const surface=overlay.committedCanvas.getBoundingClientRect(),pane=view.scrollDOM.getBoundingClientRect();
 const hx=Math.max(surface.left,pane.left)+60,hy=Math.max(surface.top,pane.top)+20;
 point("pointerdown",hx,hy);point("pointermove",hx+10,hy+5);
 await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
 const held=coverage();point("pointerup",hx+20,hy+10);await settle();
 return {before,held,after:coverage(),stroke:snapshot().strokes.at(-1)};
}
function focusSeed(){
 const page=emptyPage(id);page.surface="inline";
 page.strokes=[{id:"focus-seed",tool:"pen",color:"#000000",width:20,createdAt:1,points:[{x:300,y:300,pressure:1,t:0},{x:375,y:325,pressure:1,t:10},{x:450,y:350,pressure:1,t:20}],bbox:{x:280,y:280,width:190,height:90}}];
 return serializePage(page);
}
async function focusReturn(changed:boolean,zoom:number){
 const overlay=overlayForPath(path)! as any,host=view.dom.parentElement!;
 const box=(e:HTMLElement)=>{const r=e.getBoundingClientRect();return {width:r.width,height:r.height};};
 const read=()=>({valid:overlay.scaleGeometryValid,scale:overlay.pinchScaleNow,viewport:box(view.scrollDOM),pane:box(host),viewportClass:view.dom.classList.contains("handwriting-note-viewport"),width:overlay.committedCanvas.width,height:overlay.committedCanvas.height,black:overlay.committedCanvas.width&&overlay.committedCanvas.height?pixels().black.count:0,hit:view.scrollDOM.contains(document.elementFromPoint(700,350)),column:view.contentDOM.offsetWidth,cachedColumn:overlay.viewportLayout?.column,styleDirty:!!overlay.viewportStyleDirty});
 overlay.commitCameraScale(zoom);await settle();
 const before=read(),bytes=snapshot().saved;
 window.dispatchEvent(new Event("blur"));host.style.display="none";view.requestMeasure();await settle();
 const hidden=read(),returns:ReturnType<typeof read>[]=[];
 const resize=overlay.handleResize;let scheduled=false,contact:null|ReturnType<typeof read>=null,error:string|null=null;
 overlay.handleResize=function(...args:any[]){
  const wasHidden=this.scaleGeometryValid===false;
  const result=resize.apply(this,args);
  if(host.clientWidth>0&&host.clientHeight>0){
   returns.push(read());
   // Deliver contact between recovery callbacks, through actual hit testing.
   // Waiting eight frames would mask the failed first recovery transaction.
   if(wasHidden&&!scheduled){scheduled=true;queueMicrotask(()=>{
    contact=read();
    try{
     point("pointerdown",660,350,"touch",501);point("pointerdown",700,350,"touch",502);
     point("pointermove",650,350,"touch",501);point("pointermove",710,350,"touch",502);
     point("pointerup",650,350,"touch",501);point("pointerup",710,350,"touch",502);
    }catch(e){error=String(e)}
   });}
  }
  return result;
 };
 try{
  if(changed){host.style.width="740px";host.style.height="420px";host.style.flex="none";}
  host.style.display="";window.dispatchEvent(new Event("focus"));view.requestMeasure();await settle();
  return {before,hidden,returns,scheduled,contact,error,after:read(),bytesBefore:bytes,bytesAfter:snapshot().saved};
 }finally{overlay.handleResize=resize;}
}
async function editorFocus(zoom:number,locked:boolean,focus:boolean){
 const overlay=overlayForPath(path)! as any;
 const read=()=>({viewportClass:view.dom.classList.contains("handwriting-note-viewport"),height:view.scrollDOM.getBoundingClientRect().height,paneHeight:view.dom.parentElement!.clientHeight,hit:view.scrollDOM.contains(document.elementFromPoint(100,300)),locked:overlay.frame.locked,scale:overlay.pinchScaleNow});
 overlay.commitCameraScale(zoom);await settle();
 const old=JSON.stringify(inlineInk.strokes(path)),before=read();
 if(locked)point("pointerdown",100,300);
 if(focus)view.focus();await settle();const focused=read();
 view.contentDOM.blur();await settle();const blurred=read();
 if(focus)view.focus();await settle();const refocused=read();
 let error:string|null=null;
 try{
  if(!locked)point("pointerdown",100,300);
  point("pointermove",110,310);point("pointerup",110,310);
 }catch(e){
  error=String(e);
  // Cleanup through the original captured surface; not a hit-target pass.
  view.scrollDOM.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,pointerType:"pen",pointerId:741,clientX:110,clientY:310,buttons:0}));
 }
 await settle();
 const strokes=inlineInk.strokes(path),after=read();
 return {before,focused,blurred,refocused,after,error,oldUnchanged:JSON.stringify(strokes.slice(0,JSON.parse(old).length))===old,added:strokes.length-JSON.parse(old).length};
}
function desktopPlatform(){Object.assign(Platform,{isMobile:false,isDesktop:true,isIosApp:false,isDesktopApp:true,isMobileApp:false,isPhone:false,isWin:true});}
async function viewportOwnership(){
 const overlay=overlayForPath(path)! as any,has=()=>view.dom.classList.contains("handwriting-note-viewport");
 view.focus();await settle();const before=has();
 overlay.commitCameraScale(.1);view.contentDOM.blur();await settle();const active=has();
 overlay.restoreViewportLayout();view.focus();await settle();const restored=has();
 view.setState(EditorState.create({doc:"detached"}));await settle();const detached=has();
 return {before,active,restored,detached};
}
// Reuse the mounted editor and committed-pixel oracle for first JSON arrival.
// The installer is the existing node-side LiveReloadTestHarness function,
// supplied by the render test, not a second copy of the production poll.
async function lateSidecar(installPoll: Function) {
 const adapter=new FakeAdapter(),store=new PageStore({vault:{adapter}} as never,"handwriting");
 inlineInk.attachHost({readPageId:()=>id,claimId:async()=>({pageId:id}),loadSidecar:async i=>{loads++;return store.load(i);},
  scheduleSidecar:(i,p)=>store.schedule(i,p),scheduleSidecarNow:(i,p)=>store.saveNow(i,p),
  prepareExternalAdoption:(i,p)=>store.prepareExternalAdoption(i,p),acceptExternalAdoption:p=>store.acceptExternalAdoption(p),notify:()=>{}});
 const before=await setup();
 let callback!:()=>void,pending=Promise.resolve();
 const errors:unknown[]=[];
 installPoll.call({store,pdfStore:{},pdfInk:new Map(),pdfIds:new Map(),pollStats:{ticks:0,hidden:0,spaced:0,checks:0},registerInterval(){}},
  {setInterval(fn:()=>void){callback=fn;return 1;}},document,(p:Promise<void>)=>{pending=p;},inlineReloadCandidates,inlineInk,
  inkExternallyReloaded,notifyInkChanged,()=>null,async()=>false,{error:(...args:unknown[])=>errors.push(args.map(String))},captureInlineReloadAdmission);
 const eligible=inlineReloadCandidates().includes(path);
 callback();await pending;
 adapter.externalWrite(`handwriting/${id}.json`,saved);
 callback();await pending;await settle();
 return {before,eligible,after:{...snapshot(),pixels:pixels()},errors,live:adapter.files.get(`handwriting/${id}.json`)};
}
(window as any).zoomDrift={setup,write,raster,reference,pixels,dense,continuousPinch,pendingPinchPen,focusSeed,focusReturn,editorFocus,desktopPlatform,viewportOwnership,lateSidecar,blankLifecycle,layerVisual};
