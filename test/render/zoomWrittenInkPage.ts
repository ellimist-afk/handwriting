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
 setScrollExpansionEnabled(true);setPenInk(true);await settle();return snapshot();
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
 await settle();return {...before,...snapshot()};
}
async function raster(){
 const overlay=overlayForPath(path)! as any;
 if(!overlay.commitCameraScale(1,{left:0,top:0}))throw Error("reset refused");await settle();
 const canvas=overlay.committedCanvas as HTMLCanvasElement,rect=canvas.getBoundingClientRect();
 const pixels=canvas.getContext("2d")!.getImageData(0,0,canvas.width,canvas.height).data;
 let minX=Infinity,minY=Infinity,count=0;
 for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){const i=(y*canvas.width+x)*4;if(pixels[i+3]!>10&&pixels[i+2]!>pixels[i]!+40&&pixels[i+2]!>pixels[i+1]!+10){count++;minX=Math.min(minX,rect.left+x*rect.width/canvas.width);minY=Math.min(minY,rect.top+y*rect.height/canvas.height);}}
 const line=view.contentDOM.querySelector(".cm-line")!.getBoundingClientRect();
 return {count,minX,minY,expectedX:line.left+400,expectedY:line.top+200,...snapshot()};
}
(window as any).zoomDrift={setup,write,raster};
