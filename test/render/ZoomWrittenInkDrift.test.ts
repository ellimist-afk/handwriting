import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("../../",import.meta.url));
let browser:Browser, bundle:string;
beforeAll(async()=>{browser=await chromium.launch({headless:true});bundle=(await build({entryPoints:[root+"test/render/zoomWrittenInkPage.ts"],bundle:true,write:false,format:"iife",platform:"browser",alias:{obsidian:root+"test/render/iphoneObsidianStub.ts"}})).outputFiles[0]!.text;});
afterAll(async()=>{await browser?.close();});
async function open(padding:number,bytes?:string){
 const page=await browser.newPage({viewport:{width:900,height:700}});
 await page.setContent("<body></body>");await page.addStyleTag({content:readFileSync(root+"styles.css","utf8")});
 await page.addStyleTag({content:`html,body{margin:0;width:100%;height:100%;overflow:hidden}body{display:flex}.drift-host{position:relative;display:flex;flex:1;min-width:0;min-height:0;height:480px;overflow:hidden}.drift-host .cm-editor{display:flex;flex:1;min-width:0;min-height:0;height:480px}.drift-host .cm-scroller{flex:1;min-height:0;overflow:auto}.drift-host .cm-content{padding:${padding}px 0!important}.drift-host .cm-line{padding:0}`});
 await page.addScriptTag({content:bundle});const initial=await page.evaluate(bytes=>(window as any).zoomDrift.setup(bytes),bytes);return {page,initial};
}
describe("zoomed pen capture uses the physical text anchor",()=>{
 for(const [padding,scale,measured,pinch,cancel] of [[8,1.75,false,false,false],[8,1.375,false,true,false],[8,1.75,false,true,true],[8,1.75,true,true,false],[0,1.75,false,true,false]] as const){
 it(`padding=${padding} scale=${scale} measured=${measured} pinch=${pinch} cancel=${cancel}`,async()=>{
  const {page,initial}=await open(padding);
  try{
   const result=await page.evaluate(args=>(window as any).zoomDrift.write(...args),[scale,measured,pinch,cancel]);
   const first=result.strokes.at(-1).points[0];
   expect(result.scale).toBeCloseTo(scale,3);
   expect(result.scroll.left).toBeGreaterThan(0);expect(result.scroll.top).toBeGreaterThan(0);
   expect(first.x).toBeCloseTo(400,1);expect.soft(first.y).toBeCloseTo(200,1);
   expect(result.strokes[0]).toEqual(initial.strokes[0]);
   const raster=await page.evaluate(()=>(window as any).zoomDrift.raster());
   expect(raster.count).toBeGreaterThan(0);expect(Math.abs(raster.minX-raster.expectedX)).toBeLessThan(3);expect.soft(Math.abs(raster.minY-raster.expectedY)).toBeLessThan(3);
   // A new browser context loads only captured serialized bytes, with a fresh store singleton.
   const cold=await open(padding,raster.saved);
   try{expect(cold.initial.loads).toBe(1);expect(cold.initial.strokes[0]).toEqual(initial.strokes[0]);expect.soft(cold.initial.strokes.at(-1).points[0].y).toBeCloseTo(200,1);
    const reopened=await cold.page.evaluate(()=>(window as any).zoomDrift.raster());expect(reopened.count).toBeGreaterThan(0);expect.soft(Math.abs(reopened.minY-reopened.expectedY)).toBeLessThan(3);
   }finally{await cold.page.close();}
  }finally{await page.close();}
 });}
});


