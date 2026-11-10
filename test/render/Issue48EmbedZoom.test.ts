import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// GitHub issue 48 (Handwriting 1.4.23): on a note of slide-sized image embeds, a zoom to 200 percent moves the text by
// several slides while the ink stays put. Each arm writes one stroke on a slide below several others, zooms, and reads
// back, at the settle and after 60 quiet frames: the slide under the ink's centre (the same slide), and the ink's offset
// from that slide in note px (within 1 px of the offset before the zoom). HW_ISSUE48_OUT=<file> writes every readback.
declare const process: { env: Record<string, string | undefined> };
const root=fileURLToPath(new URL("../../",import.meta.url));
let browser:Browser, bundle:string;
const rows:Record<string,unknown>={};
beforeAll(async()=>{browser=await chromium.launch({headless:true});bundle=(await build({entryPoints:[root+"test/render/issue48EmbedZoomPage.ts"],bundle:true,write:false,format:"iife",platform:"browser",alias:{obsidian:root+"test/render/iphoneObsidianStub.ts"}})).outputFiles[0]!.text;});
afterAll(async()=>{await browser?.close();if(process.env.HW_ISSUE48_OUT)writeFileSync(process.env.HW_ISSUE48_OUT,JSON.stringify(rows,null,1));});
async function open(obsidian=false):Promise<Page>{
 const page=await browser.newPage({viewport:{width:1000,height:700}});
 await page.setContent("<body></body>");await page.addStyleTag({content:readFileSync(root+"styles.css","utf8")});
 await page.addStyleTag({content:`html,body{margin:0;width:100%;height:100%;overflow:hidden}body{display:flex}.issue48-host{position:relative;display:flex;flex:1;min-width:0;min-height:0;height:600px;overflow:hidden}.issue48-host .cm-editor{display:flex;flex:1;min-width:0;min-height:0;height:600px}.issue48-host .cm-scroller{flex:1;min-height:0;overflow:auto}.issue48-host .cm-content{padding:8px 0!important}.issue48-host .cm-line{padding:0}`});
 await page.addScriptTag({content:bundle});
 await page.evaluate(o=>(window as any).issue48.setup(o),obsidian);
 return page;
}
type Read={scale:number;overlayScale:number;ink:{count:number};under:number|null;offset:{x:number;y:number}|null;drawn:number[]};
function premise(w:{slideId:number;strokes:number;before:Read}){
 expect(w.strokes,"premise: one stroke written").toBe(1);
 expect(w.slideId,"premise: the stroke sits below several slides").toBeGreaterThanOrEqual(4);
 expect(w.before.ink.count,"premise: the stroke is painted").toBeGreaterThan(0);
 expect(w.before.under,"premise: the stroke lies on its slide before the zoom").toBe(w.slideId);
 expect(w.before.scale).toBeCloseTo(1,3);
}
function held(label:string,slideId:number,before:Read,after:Read){
 // The pinch spreads the fingers to twice their distance and lands at 1.95 on both builds; 1.9 is its floor.
 expect.soft(after.scale,`${label}: drawn scale`).toBeGreaterThanOrEqual(1.9);expect.soft(after.scale,`${label}: drawn scale`).toBeLessThanOrEqual(2.001);
 expect.soft(after.ink.count,`${label}: ink painted`).toBeGreaterThan(0);
 expect.soft(after.under,`${label}: slide under the ink (drawn ${after.drawn.join(",")})`).toBe(slideId);
 expect.soft(after.offset,`${label}: its slide is drawn`).not.toBeNull();
 if(after.offset&&before.offset){
  expect.soft(Math.abs(after.offset.x-before.offset.x),`${label}: x offset from the slide, note px`).toBeLessThanOrEqual(1);
  expect.soft(Math.abs(after.offset.y-before.offset.y),`${label}: y offset from the slide, note px`).toBeLessThanOrEqual(1);
 }
}
describe("issue 48: ink stays on its slide image across a zoom to 200 percent",()=>{
 // Obsidian wraps the content in .cm-sizer; the zoom settle hold needs it (InkOverlayPinch panSizer, InkOverlayZoomApi centreSettleHold).
 // A rig without it takes the old unheld commit, which is not the page the reporter zoomed on: its rows stay in Issue48Trace.
 for(const [arm,obsidian] of [["plus",true],["pinch",true]] as const)it(obsidian?`${arm} obsidian wrappers`:arm,async()=>{
  const page=await open(obsidian);
  try{
   const w=await page.evaluate(()=>(window as any).issue48.write());
   const z=await page.evaluate(a=>(window as any).issue48[a](),arm);
   rows[obsidian?`${arm}-obsidian`:arm]={write:w,zoom:z};
   premise(w);
   expect(z.ok,"premise: the zoom was taken").toBe(true);
   if(arm==="plus")expect(z.quiet.overlayScale,"premise: the note is at 200 percent").toBeCloseTo(2,3);
   else expect(z.quiet.overlayScale,"premise: the pinch reached at least 190 percent").toBeGreaterThanOrEqual(1.9);
   held(`${arm} settle`,w.slideId,w.before,z.settled);
   held(`${arm} quiet`,w.slideId,w.before,z.quiet);
  }finally{await page.close();}
 });
 // SENSOR: the readback sees a 2 px move of the painted ink against its slide, and the zoom arms' 1 px bound would red on it.
 it("sensor: a 2 px move of the painted ink reads as 2 px",async()=>{
  const page=await open();
  try{
   const w=await page.evaluate(()=>(window as any).issue48.write());
   const moved=await page.evaluate(()=>(window as any).issue48.displace(2));
   rows.sensor={write:w,moved};
   premise(w);
   expect(moved.offset.y-w.before.offset!.y).toBeCloseTo(2,0);
   expect(Math.abs(moved.offset.x-w.before.offset!.x)).toBeLessThanOrEqual(.5);
  }finally{await page.close();}
 });
});
