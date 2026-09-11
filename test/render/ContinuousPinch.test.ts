/**
 * Actual frame-paced touch moves must reuse the raster while fingers move.
 * The 950 production path fails these assertions with hundreds of backing
 * assignments and committed clears. Final coordinates and ink remain guarded.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("../../",import.meta.url));
let browser:Browser,bundle:string;
beforeAll(async()=>{
 browser=await chromium.launch({headless:true});
 bundle=(await build({entryPoints:[root+"test/render/zoomWrittenInkPage.ts"],bundle:true,write:false,format:"iife",platform:"browser",alias:{obsidian:root+"test/render/iphoneObsidianStub.ts"}})).outputFiles[0]!.text;
});
afterAll(async()=>{await browser?.close();});
async function mount(page:Page,count:number,focus=false){
   await page.setContent("<body></body>");await page.addStyleTag({content:readFileSync(root+"styles.css","utf8")});
   await page.addStyleTag({content:`html,body{margin:0;width:100%;height:100%;overflow:hidden}body{display:flex}.drift-host{position:relative;display:flex;flex:1;min-width:0;min-height:0;height:480px;overflow:hidden}.drift-host .cm-editor{display:flex;flex:1;min-width:0;min-height:0;height:480px}.drift-host .cm-scroller{flex:1;min-height:0;overflow:auto}.drift-host .cm-content{padding:8px 0!important}.drift-host .cm-line{padding:0}`});
   // Installed Obsidian1.13.7 app.css: a column flex host and this three-class
   // editor rule outrank a two-class plugin flex:none rule, regardless of order.
   await page.addStyleTag({content:`.markdown-source-view.mod-cm6{height:100%;display:flex;flex-direction:column}.markdown-source-view.mod-cm6 .cm-editor{flex:1 1;min-height:0}.drift-host.markdown-source-view{height:480px}`});
   await page.addStyleTag({content:`.markdown-source-view.mod-cm6 .cm-sizer{display:flex;flex-direction:column;align-items:stretch;width:100%;min-height:100%}.markdown-source-view.mod-cm6 .cm-contentContainer{flex:1 1 auto;display:flex;align-items:stretch;overflow-x:visible}.markdown-source-view.mod-cm6 .cm-content{flex-basis:unset!important;width:0;min-height:unset}`});
   await page.addScriptTag({content:bundle});
   await page.evaluate(([count,focus])=>(window as any).zoomDrift.setup(focus?(window as any).zoomDrift.focusSeed():(window as any).zoomDrift.dense(count),true),[count,focus]);
}
for(const [count,target,cancel,dpr] of [[0,1.75,false,1],[250,1.75,true,2],[250,.75,false,1],[250,.75,true,2],[250,.322,false,1],[250,.322,true,2]] as const) {
 it(`reuses live raster: ${count} strokes, ${target} scale, cancel=${cancel}, DPR=${dpr}`,async()=>{
  const page=await browser.newPage({viewport:{width:900,height:700},deviceScaleFactor:dpr});
  try {
   await mount(page,count);
   const r=await page.evaluate(([target,cancel])=>(window as any).zoomDrift.continuousPinch(target,cancel),[target,cancel]);
   expect.soft(r.backingWrites).toBe(0);expect.soft(r.liveClears).toBe(0);expect.soft(r.liveTransactions).toBe(0);
   expect(r.finalTransactions).toBe(1);
   expect(r.liveScale).toBeCloseTo(target,4);expect(r.finalScale).toBeCloseTo(target,4);
   expect(r.columnAfter).toBe(r.columnBefore);
   expect(r.liveAnchors.length).toBeGreaterThan(30);
   // At 32.2% the viewport can exceed the existing horizontal extent. Preserve
   // the browser's finite-range clamp; it is distinct from viewport shrinkage.
   for(const a of r.liveAnchors){expect(Math.abs(a.x-(target<.5?a.boundaryX:0))).toBeLessThan(2);expect(Math.abs(a.y)).toBeLessThan(2);expect(a.column).toBe(r.columnBefore);}
   expect.soft(Math.max(...r.liveAnchors.map((a:any)=>Math.abs(a.viewportWidth-r.pane.width)))).toBeLessThan(.1);
   expect.soft(Math.max(...r.liveAnchors.map((a:any)=>Math.abs(a.viewportHeight-r.pane.height)))).toBeLessThan(.1);
   expect.soft(Math.abs(r.viewport.width-r.pane.width)).toBeLessThan(.1);
   expect.soft(Math.abs(r.viewport.height-r.pane.height)).toBeLessThan(.1);
   expect(Math.abs(r.anchorError.x-(target<.5?r.anchorError.boundaryX:0))).toBeLessThan(2);expect(Math.abs(r.anchorError.y)).toBeLessThan(2);
   expect(r.after.strokes).toEqual(r.before.strokes);expect(r.after.saved).toBe(r.before.saved);
   if(count)expect(r.pixels.black.count).toBeGreaterThan(0);
  }finally{await page.close();}
 });
}
for(const cancel of [false,true]){
 it(`covers immediate held ink after a pending pinch, cancel=${cancel}`,async()=>{
  const results=[];
  for(const measured of [false,true]){
   const page=await browser.newPage({viewport:{width:900,height:700}});
   try{
    await mount(page,0);
    const r=await page.evaluate(([measured,cancel])=>(window as any).zoomDrift.pendingPinchPen(measured,cancel),[measured,cancel]);
    expect(r.before.top).toBeLessThanOrEqual(0);expect(r.before.bottom).toBeGreaterThanOrEqual(0);
    expect(r.held.locked).toBe(true);expect(r.held.bluePixels).toBeGreaterThan(0);
    expect(r.held.band).toEqual(r.before.band);
    expect(r.held.top).toBeLessThanOrEqual(0);expect(r.held.bottom).toBeGreaterThanOrEqual(0);
    results.push(r);
   }finally{await page.close();}
  }
  expect(results[0].stroke.points[0].x).toBeCloseTo(results[1].stroke.points[0].x,5);
  expect(results[0].stroke.points[0].y).toBeCloseTo(results[1].stroke.points[0].y,5);
 });
}
for(const changed of [false,true])for(const zoom of [.322,.1]){
 it(`restores visible ink and contact targets after focus, resized=${changed}, zoom=${zoom}`,async()=>{
  const page=await browser.newPage({viewport:{width:900,height:700}});
  try{
   await mount(page,0,true);
   const r=await page.evaluate(([changed,zoom])=>(window as any).zoomDrift.focusReturn(changed,zoom),[changed,zoom]);
   expect(r.before.black).toBeGreaterThan(0);expect(r.hidden.valid).toBe(false);expect(r.hidden.width).toBe(0);
   expect(r.hidden.cachedColumn).toBe(r.before.cachedColumn);expect(r.hidden.styleDirty).toBe(true);
   expect(r.scheduled).toBe(true);expect(r.returns.length).toBeGreaterThan(0);
   for(const state of r.returns){
    expect.soft(state.valid).toBe(true);expect.soft(state.viewportClass).toBe(true);
    expect.soft(Math.abs(state.viewport.width-state.pane.width)).toBeLessThan(.1);
    expect.soft(Math.abs(state.viewport.height-state.pane.height)).toBeLessThan(.1);
    expect.soft(state.width).toBeGreaterThan(0);expect.soft(state.height).toBeGreaterThan(0);
   }
   expect(r.contact.hit).toBe(true);expect(r.contact.black).toBeGreaterThan(0);expect(r.error).toBeNull();
   expect(r.after.scale).toBeCloseTo(zoom*1.5,4);expect(r.bytesAfter).toBe(r.bytesBefore);expect(r.after.styleDirty).toBe(false);
  }finally{await page.close();}
 });
}
