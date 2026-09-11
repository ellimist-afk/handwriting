/**
 * Actual frame-paced touch moves must reuse the raster while fingers move.
 * The 950 production path fails these assertions with hundreds of backing
 * assignments and committed clears. Final coordinates and ink remain guarded.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("../../",import.meta.url));
let browser:Browser,bundle:string;
beforeAll(async()=>{
 browser=await chromium.launch({headless:true});
 bundle=(await build({entryPoints:[root+"test/render/zoomWrittenInkPage.ts"],bundle:true,write:false,format:"iife",platform:"browser",alias:{obsidian:root+"test/render/iphoneObsidianStub.ts"}})).outputFiles[0]!.text;
});
afterAll(async()=>{await browser?.close();});
for(const [count,target,cancel,dpr] of [[0,1.75,false,1],[250,1.75,true,2],[250,.75,false,1],[250,.75,true,2]] as const) {
 it(`reuses live raster: ${count} strokes, ${target} scale, cancel=${cancel}, DPR=${dpr}`,async()=>{
  const page=await browser.newPage({viewport:{width:900,height:700},deviceScaleFactor:dpr});
  try {
   await page.setContent("<body></body>");await page.addStyleTag({content:readFileSync(root+"styles.css","utf8")});
   await page.addStyleTag({content:`html,body{margin:0;width:100%;height:100%;overflow:hidden}body{display:flex}.drift-host{position:relative;display:flex;flex:1;min-width:0;min-height:0;height:480px;overflow:hidden}.drift-host .cm-editor{display:flex;flex:1;min-width:0;min-height:0;height:480px}.drift-host .cm-scroller{flex:1;min-height:0;overflow:auto}.drift-host .cm-content{padding:8px 0!important}.drift-host .cm-line{padding:0}`});
   await page.addScriptTag({content:bundle});
   await page.evaluate(count=>(window as any).zoomDrift.setup((window as any).zoomDrift.dense(count)),count);
   const r=await page.evaluate(([target,cancel])=>(window as any).zoomDrift.continuousPinch(target,cancel),[target,cancel]);
   expect.soft(r.backingWrites).toBe(0);expect.soft(r.liveClears).toBe(0);expect.soft(r.liveTransactions).toBe(0);
   expect(r.finalTransactions).toBe(1);
   expect(r.liveScale).toBeCloseTo(target,4);expect(r.finalScale).toBeCloseTo(target,4);
   expect(r.columnAfter).toBe(r.columnBefore);
   expect(r.liveAnchors.length).toBeGreaterThan(30);
   for(const a of r.liveAnchors){expect(Math.abs(a.x)).toBeLessThan(2);expect(Math.abs(a.y)).toBeLessThan(2);expect(a.column).toBe(r.columnBefore);}
   expect(Math.abs(r.anchorError.x)).toBeLessThan(2);expect(Math.abs(r.anchorError.y)).toBeLessThan(2);
   expect(r.after.strokes).toEqual(r.before.strokes);expect(r.after.saved).toBe(r.before.saved);
   if(count)expect(r.pixels.black.count).toBeGreaterThan(0);
  }finally{await page.close();}
 });
}
