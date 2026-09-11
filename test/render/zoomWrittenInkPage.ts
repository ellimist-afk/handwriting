import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled } from "../../src/inline/InkOverlay";
import { setPenInk } from "../../src/inline/PenInk";
import { emptyPage, parsePage, serializePage, type PageData } from "../../src/model/PageData";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
installObsidianDom();
const path = "drift.md", id = "drift-page";
let saved = "", loads = 0;
let view: EditorView;
const settle = async () => { for(let i=0;i<8;i++) await new Promise<void>(r=>requestAnimationFrame(()=>r())); };
const save = (_id: string, data: PageData) => { saved = serializePage(data); };
inlineInk.attachHost({ readPageId:()=>id, claimId:async()=>({pageId:id}), loadSidecar:async()=>{loads++;return parsePage(saved,id);}, scheduleSidecar:save, scheduleSidecarNow:async(i,p)=>save(i,p), notify:()=>{} });
async function setup(bytes?: string) {
 const data=emptyPage(id); data.surface="inline";
 data.strokes=[{id:"old",tool:"pen",color:"#000000",width:2,createdAt:1,points:[{x:300,y:300,pressure:.5,t:0},{x:320,y:310,pressure:.5,t:10}],bbox:{x:298,y:298,width:24,height:14}}];
 saved=bytes??serializePage(data);
 const host=document.body.appendChild(document.createElement("div"));host.className="markdown-source-view drift-host";
 view=new EditorView({parent:host,state:EditorState.create({doc:Array.from({length:80},(_,i)=>`line ${i} anchor text`).join("\n"),extensions:[history(),editorInfoField.init(()=>({app:{commands:{executeCommandById:()=>false}},file:{path},editor:{}})),inkOverlayExtension(),EditorView.theme({".cm-content":{fontFamily:"monospace",fontSize:"16px",lineHeight:"24px"}})]})});
 setScrollExpansionEnabled(true);setPenInk(true);await settle();return {...snapshot(),pixels:pixels()};
}
function snapshot(){return {saved,loads,strokes:JSON.parse(JSON.stringify(inlineInk.strokes(path))),scaleY:view.scaleY};}
function point(type:string,x:number,y:number,pointerType="pen",pointerId=741){
 const target=document.elementFromPoint(x,y);
 if(!target||!view.scrollDOM.contains(target))throw Error(`input outside scroller: ${x},${y}`);
 target.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType,pointerId,isPrimary:true,clientX:x,clientY:y,buttons:type==="pointerup"||type==="pointercancel"?0:1,pressure:.6,width:8,height:8}));
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
 const actual=view.dom.getBoundingClientRect().width/view.dom.offsetWidth;
 const x=line.left+400*actual,y=line.top+200*actual;
 const before={scale:actual,cached:view.scaleY,expected:{x:400,y:200},scroll:{left:view.scrollDOM.scrollLeft,top:view.scrollDOM.scrollTop}};
 point("pointerdown",x,y);point("pointermove",x+8,y+4);point("pointerup",x+12,y+6);
 await settle();return {...before,...snapshot(),pixels:pixels()};
}
function pixels(displace = 0){
 const overlay=overlayForPath(path)! as any;
 const canvas=overlay.committedCanvas as HTMLCanvasElement,rect=canvas.getBoundingClientRect();
 const ctx=canvas.getContext("2d")!;
 if(displace){const original=ctx.getImageData(0,0,canvas.width,canvas.height);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.putImageData(original,0,Math.round(displace*canvas.height/rect.height));}
 const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
 const line=view.contentDOM.querySelector(".cm-line")!.getBoundingClientRect();
 const scale=view.dom.getBoundingClientRect().width/view.dom.offsetWidth;
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
function reference(){
 // Same stroke shape/style/pressure as captured, placed at the independently
 // specified physical anchor. This removes cap and antialiasing bias.
 const page=parsePage(saved,id).data;
 const stroke=page.strokes.at(-1)!;
 const dx=400-stroke.points[0]!.x,dy=200-stroke.points[0]!.y;
 for(const point of stroke.points){point.x+=dx;point.y+=dy;}
 return serializePage(page);
}
function dense(count: number) {
 const page=emptyPage(id);page.surface="inline";
 for(let s=0;s<count;s++) {
  const x=30+(s%10)*70,y=30+Math.floor(s/10)*15;
  page.strokes.push({id:`dense-${s}`,tool:"pen",color:"#000000",width:2,createdAt:s,
   points:Array.from({length:80},(_,i)=>({x:x+i*.6,y:y+Math.sin(i/5)*5,pressure:.5,t:i*4})),
   bbox:{x:x-4,y:y-9,width:56,height:18}});
 }
 return serializePage(page);
}
async function continuousPinch(target: number, cancel: boolean) {
 const overlay=overlayForPath(path)! as any;
 view.scrollDOM.scrollLeft=160;view.scrollDOM.scrollTop=160;await settle();
 const before=snapshot(),column=view.contentDOM.offsetWidth;
 let live=true,backingWrites=0,liveClears=0,liveTransactions=0,finalTransactions=0;
 const liveAnchors:{x:number;y:number;column:number}[]=[];
 let anchor:{x:number;y:number;worldX:number;worldY:number}|null=null;
 const commit=overlay.commitCameraScale,pinch=overlay.pinch;
 overlay.commitCameraScale=function(...args:any[]){if(live)liveTransactions++;else finalTransactions++;return commit.apply(this,args);};
 overlay.pinch=function(phase:string,ratio:number,centroid:{x:number;y:number}) {
  if(phase==="start") {const r=view.contentDOM.getBoundingClientRect();anchor={...centroid,worldX:centroid.x-r.left,worldY:centroid.y-r.top};}
  return pinch.call(this,phase,ratio,centroid);
 };
 const canvasProto=HTMLCanvasElement.prototype;
 const descriptors=["width","height"].map(key=>[key,Object.getOwnPropertyDescriptor(canvasProto,key)!] as const);
 for(const [key,d] of descriptors)Object.defineProperty(canvasProto,key,{...d,set:function(value:number){if(live)backingWrites++;d.set!.call(this,value);}});
 const clear=CanvasRenderingContext2D.prototype.clearRect;
 CanvasRenderingContext2D.prototype.clearRect=function(...args:Parameters<typeof clear>){if(live&&(this===overlay.committedCtx||this===overlay.highlightCtx))liveClears++;return clear.apply(this,args);};
 try {
  point("pointerdown",300,220,"touch",501);point("pointerdown",500,220,"touch",502);
  for(let i=1;i<=60;i++) {
   await new Promise<void>(r=>requestAnimationFrame(()=>r()));
   if(anchor) {const a=anchor as {x:number;y:number;worldX:number;worldY:number},r=view.contentDOM.getBoundingClientRect();liveAnchors.push({x:r.left+a.worldX*overlay.pinchScaleNow-a.x,y:r.top+a.worldY*overlay.pinchScaleNow-a.y,column:view.contentDOM.offsetWidth});}
   const half=100*(1+(target-1)*i/60);
   point("pointermove",400-half,220,"touch",501);point("pointermove",400+half,220,"touch",502);
  }
  await new Promise<void>(r=>requestAnimationFrame(()=>r()));
  const liveScale=overlay.pinchScaleNow;
  live=false;
  point(cancel?"pointercancel":"pointerup",400-100*target,220,"touch",501);
  point("pointerup",400+100*target,220,"touch",502);
  await settle();
  const rect=view.contentDOM.getBoundingClientRect(),a=anchor!;
  return {backingWrites,liveClears,liveTransactions,finalTransactions,liveScale,liveAnchors,
   finalScale:overlay.pinchScaleNow,columnBefore:column,columnAfter:view.contentDOM.offsetWidth,
   anchorError:{x:rect.left+a.worldX*target-a.x,y:rect.top+a.worldY*target-a.y},
   before,after:snapshot(),pixels:pixels(),preview:overlay.pinchPreview};
 } finally {
  overlay.commitCameraScale=commit;overlay.pinch=pinch;
  for(const [key,d] of descriptors)Object.defineProperty(canvasProto,key,d);
  CanvasRenderingContext2D.prototype.clearRect=clear;
 }
}
(window as any).zoomDrift={setup,write,raster,reference,pixels,dense,continuousPinch};
