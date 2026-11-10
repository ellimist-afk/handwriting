import { EditorState, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled } from "../../src/inline/InkOverlay";
import { setPenInk } from "../../src/inline/PenInk";
import { emptyPage, parsePage, serializePage, type PageData } from "../../src/model/PageData";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
// GitHub issue 48: a note of slide-sized image embeds, one per line, scrolled past several slides, one stroke on a slide,
// then a zoom to 200 percent (the zoom bar's plus, or a pinch). The report: the text jumps by several slides and the ink
// stays put. The slide stands in for Obsidian's internal-embed image: a replace widget of 700 x 525 px with no height
// estimate, so CodeMirror's height map takes one text line for every slide it has not drawn.
installObsidianDom();
const path = "issue-48.md", id = "issue-48-page";
let saved = "";
let view: EditorView;
export const frames = async (n: number) => { for(let i=0;i<n;i++) await new Promise<void>(r=>requestAnimationFrame(()=>r())); };
const save = (_id: string, data: PageData) => { saved = serializePage(data); };
inlineInk.attachHost({ readPageId:()=>id, claimId:async()=>({pageId:id}), loadSidecar:async()=>parsePage(saved,id), scheduleSidecar:save, scheduleSidecarNow:async(i,p)=>save(i,p), notify:()=>{} });
class Slide extends WidgetType {
 constructor(readonly n: number) { super(); }
 eq(other: Slide) { return other.n === this.n; }
 toDOM() {
  const el = document.createElement("span");
  el.className = "issue48-slide"; el.dataset.slide = String(this.n);
  el.style.cssText = "display:inline-block;vertical-align:top;width:700px;height:525px;background:#c8d0e0";
  return el;
 }
}
const LINES = 40;
const doc = Array.from({length:LINES},(_,i)=>i%2===0?`![[slide-${i/2}.png]]`:`text after slide ${(i-1)/2}`).join("\n");
const slides = StateField.define<DecorationSet>({
 create(state) {
  const out: Range<Decoration>[] = [];
  for(let n=1;n<=state.doc.lines;n++){const line=state.doc.line(n);if(line.text.startsWith("![[slide-"))out.push(Decoration.replace({widget:new Slide((n-1)/2)}).range(line.from,line.to));}
  return Decoration.set(out);
 },
 update(value, tr) { return value.map(tr.changes); },
 provide: f => EditorView.decorations.from(f),
});
async function setup(obsidian = false) {
 const data=emptyPage(id); data.surface="inline"; saved=serializePage(data);
 const host=document.body.appendChild(document.createElement("div"));host.className="markdown-source-view mod-cm6 issue48-host";
 view=new EditorView({parent:host,state:EditorState.create({doc,extensions:[history(),slides,editorInfoField.init(()=>({app:{commands:{executeCommandById:()=>false}},file:{path},editor:{}})),inkOverlayExtension(),EditorView.theme({".cm-content":{fontFamily:"monospace",fontSize:"16px",lineHeight:"24px"}})]})});
 // Obsidian's own wrappers round the content (.cm-sizer > .cm-contentContainer > .cm-content): the pinch's settle hold
 // needs the sizer (InkOverlayPinch panSizer), so the bare rig is not the page the reporter pinched on.
 if(obsidian){
  const sizer=document.createElement("div"),container=document.createElement("div");
  sizer.className="cm-sizer";container.className="cm-contentContainer";
  view.scrollDOM.insertBefore(sizer,view.contentDOM);sizer.appendChild(container);container.appendChild(view.contentDOM);
 }
 setScrollExpansionEnabled(true);setPenInk(true);await frames(8);
}
export function point(type:string,x:number,y:number,pointerType="pen",pointerId=741){
 const target=document.elementFromPoint(x,y);
 if(!target||!view.scrollDOM.contains(target))throw Error(`input outside scroller: ${x},${y}`);
 target.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType,pointerId,isPrimary:pointerId===741||pointerId===501,clientX:x,clientY:y,buttons:type==="pointerup"||type==="pointercancel"?0:1,pressure:.6,width:8,height:8}));
}
/** Screen px per note px, from the DOM alone (the editor's drawn width over its layout width), never the overlay's belief. */
const domScale = () => view.dom.getBoundingClientRect().width/parseFloat(getComputedStyle(view.dom).width);
/** The committed layer's ink, as a client rect. One stroke exists, so every opaque pixel is it. */
function ink(){
 const canvas=(overlayForPath(path) as any).committedCanvas as HTMLCanvasElement,rect=canvas.getBoundingClientRect();
 if(!canvas.width||!canvas.height)return {count:0,left:NaN,top:NaN,right:NaN,bottom:NaN};
 const data=canvas.getContext("2d")!.getImageData(0,0,canvas.width,canvas.height).data,sx=rect.width/canvas.width,sy=rect.height/canvas.height;
 let count=0,minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
 for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(data[(y*canvas.width+x)*4+3]!>10){count++;if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;}
 return {count,left:rect.left+minX*sx,top:rect.top+minY*sy,right:rect.left+(maxX+1)*sx,bottom:rect.top+(maxY+1)*sy};
}
/** The slide drawn under a client point, by hit list (the ink canvases sit above it), or null. */
function slideAt(x:number,y:number):number|null{
 for(const el of document.elementsFromPoint(x,y)){const s=(el as HTMLElement).closest?.(".issue48-slide") as HTMLElement|null;if(s)return Number(s.dataset.slide);}
 return null;
}
let slideId=-1;
function read(){
 const i=ink(),scale=domScale(),el=view.contentDOM.querySelector(`[data-slide="${slideId}"]`) as HTMLElement|null,s=el?.getBoundingClientRect();
 const cx=(i.left+i.right)/2,cy=(i.top+i.bottom)/2;
 return {scale,overlayScale:(overlayForPath(path) as any).pinchScaleNow as number,scrollTop:view.scrollDOM.scrollTop,ink:i,
  slide:s?{left:s.left,top:s.top,width:s.width,height:s.height}:null,
  under:Number.isFinite(cx)&&Number.isFinite(cy)?slideAt(cx,cy):null,
  // The ink's offset from its slide in note px: the same number at any zoom when the ink stays on the slide.
  offset:s?{x:(i.left-s.left)/scale,y:(i.top-s.top)/scale}:null,
  drawn:[...view.contentDOM.querySelectorAll(".issue48-slide")].map(e=>Number((e as HTMLElement).dataset.slide)),
  // Every drawn slide's client top and bottom, and the viewport's, so a red names where the text went.
  slides:[...view.contentDOM.querySelectorAll(".issue48-slide")].map(e=>{const r=e.getBoundingClientRect();return {n:Number((e as HTMLElement).dataset.slide),top:r.top,bottom:r.bottom};}),
  viewport:(({top,bottom,left,right})=>({top,bottom,left,right}))(view.scrollDOM.getBoundingClientRect())};
}
/** Scroll past several slides, write one stroke at the viewport's middle on the slide drawn there, settle. Both zooms hold
 * the viewport's middle, so the stroke stays in view at 200 percent. */
async function write(scrollTop=2900){
 view.scrollDOM.scrollTop=scrollTop;await frames(8);
 const v=view.scrollDOM.getBoundingClientRect(),mid=v.top+v.height/2;
 const cx=v.left+v.width/2,best=slideAt(cx,mid);
 if(best===null)throw Error("no slide at the viewport's middle");
 slideId=best;
 const x=cx-30,y=mid-15;
 point("pointerdown",x,y);for(let k=1;k<=6;k++)point("pointermove",x+k*10,y+k*5);point("pointerup",x+60,y+30);
 await frames(8);
 return {slideId,strokes:inlineInk.strokes(path).length,before:read()};
}
/** The zoom bar's plus: the same call the button makes. */
async function plus(){
 const ok=(overlayForPath(path) as any).zoomNoteBy(2);
 await frames(8);const settled=read();await frames(60);
 return {ok,settled,quiet:read()};
}
/** Two fingers about the viewport's middle, spread over 20 frames to twice their distance. */
async function pinch(){
 // The palm gate swallows a touch that lands within 250 ms of a pen lift (PalmGate RELEASE_TAIL_MS, both builds): the hand
 // leaves the pen first, as a person does.
 await new Promise<void>(r=>setTimeout(r,400));
 const v=view.scrollDOM.getBoundingClientRect(),cx=v.left+v.width/2,cy=v.top+v.height/2,half=100;
 point("pointerdown",cx-half,cy,"touch",501);point("pointerdown",cx+half,cy,"touch",502);
 for(let k=1;k<=20;k++){await frames(1);const h=half*(1+k/20);point("pointermove",cx-h,cy,"touch",501);point("pointermove",cx+h,cy,"touch",502);}
 point("pointerup",cx-2*half,cy,"touch",501);point("pointerup",cx+2*half,cy,"touch",502);
 await frames(8);const settled=read();await frames(60);
 return {ok:true,settled,quiet:read()};
}
/** Sensor control: move the committed layer's pixels down by dy css px with the stroke untouched; read again. */
function displace(dy:number){
 const canvas=(overlayForPath(path) as any).committedCanvas as HTMLCanvasElement,ctx=canvas.getContext("2d")!,rect=canvas.getBoundingClientRect();
 const original=ctx.getImageData(0,0,canvas.width,canvas.height);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.putImageData(original,0,Math.round(dy*canvas.height/rect.height));
 return read();
}
(window as any).issue48={setup,write,plus,pinch,read,displace};
