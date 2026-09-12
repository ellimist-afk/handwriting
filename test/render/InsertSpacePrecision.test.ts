/** Contact, visible divider and committed membership must describe one split.
 * Reuses the mounted viewport fixture; routes real PointerEvents through the
 * production editor/store/router rather than calling spaceDown directly.
 */
import {beforeAll,afterAll,it,expect} from "vitest";
import {build} from "esbuild";
import {fileURLToPath} from "node:url";
import {readFileSync} from "node:fs";
import {chromium,type Browser} from "playwright";
let browser:Browser,script:string;
const root=fileURLToPath(new URL("../../",import.meta.url));
beforeAll(async()=>{
 script=(await build({entryPoints:[root+"test/render/noteViewportCameraPage.ts"],bundle:true,write:false,format:"iife",platform:"browser",alias:{obsidian:root+"test/render/iphoneObsidianStub.ts"}})).outputFiles[0]!.text;
 browser=await chromium.launch({headless:true});
});
afterAll(async()=>{await browser?.close();});
async function mounted(){
 const page=await browser.newPage({viewport:{width:1400,height:1100}});
 await page.setContent("<!doctype html><body></body>");
 await page.addStyleTag({content:readFileSync(root+"styles.css","utf8")+readFileSync(root+"test/render/noteViewportCamera.css","utf8")});
 await page.addScriptTag({content:script});return page;
}
it.each([[1,1,0,false],[.1,1,0,false],[4,1,40,false],[1,1.5,24,false],[1,1,0,true],[.1,1,0,true],[4,1,40,true]] as const)(
 "one split at zoom %s, font %s, scroll %s, wrapped %s",async(zoom,font,scroll,wrapped)=>{
 const page=await mounted();
 try{
  const r=await page.evaluate(args=>(window as any).insertSpaceProbe(...args),[zoom,font,scroll,wrapped]);
  expect(r.down.mode).toBe("space");expect(r.down.cut).not.toBeNull();
  expect(r.before.zoom).toBe(zoom);expect(r.down.ids.length).toBeGreaterThan(0);
  const divider=r.origin+r.down.cut*r.scale;
  expect.soft(r.hover).toBeCloseTo(divider,1);
  expect.soft(r.down.reticle).toBeCloseTo(divider,1);
  expect(r.live.reticle).toBeCloseTo(r.origin+r.live.cut*r.scale,1);
  expect(r.after.scroll).toEqual(r.before.scroll);
  // Text whose first rendered line is above the displayed cut must not jump
  // below it at release. This catches the wrapped-paragraph disagreement.
  for(const line of r.before.text.filter((l:any)=>l.bottom<divider-.1)){
   const after=r.after.text.find((l:any)=>l.text.length>0&&line.text.startsWith(l.text));
   expect.soft(after?.top).toBeCloseTo(line.top,1);
  }
  let split=0;while(r.before.doc[split]===r.after.doc[split]&&split<r.before.doc.length)split++;
  const added=r.after.doc.length-r.before.doc.length;
  expect(added).toBeGreaterThan(0);
  expect(r.after.doc.slice(split,split+added)).toMatch(/^\n+$/);
  expect(r.after.doc.slice(0,split)+r.after.doc.slice(split+added)).toBe(r.before.doc);
  if(wrapped){expect(split).toBeGreaterThan(0);expect(split).toBeLessThan(r.before.doc.indexOf("\n"));}
  // A break inside a paragraph replaces its automatic wrap. It must not
  // make the text travel one line less than the ink.
  expect(r.after.rects[split+added].top-r.before.rects[split].top).toBeCloseTo(48*r.scale,1);
  for(let i=0;i<r.before.strokes.length;i++){
   const before=r.before.strokes[i],after=r.after.strokes[i];
   expect(after.id).toBe(before.id);expect(after.points.length).toBe(before.points.length);
   expect(after.points[0].x).toBe(before.points[0].x);
   expect(after.points[0].y-before.points[0].y).toBeCloseTo(r.down.ids.includes(before.id)?48:0,4);
  }
  expect(r.after.history).toBe(r.before.history+1);
  expect(r.undone.doc).toBe(r.before.doc);expect(r.undone.strokes).toEqual(r.before.strokes);
  expect(r.redone.doc).toBe(r.after.doc);expect(r.redone.strokes).toEqual(r.after.strokes);
 }finally{await page.close();}
});

it.each([{dy:3},{dy:-48},{dy:48,edit:true}])("rolls back ink when the text cannot make the same edit: %j",async options=>{
 const page=await mounted();try{
  const r=await page.evaluate(options=>(window as any).insertSpaceProbe(1,1,0,true,options),options);
  expect(r.down.mode).toBe("space");expect(r.live.dy).toBe(options.dy);
  expect(r.after.strokes).toEqual(r.before.strokes);
  expect(r.after.doc).toBe(r.before.doc+("edit" in options?" external":""));
  expect(r.after.history-r.before.history).toBe("edit" in options?1:0);
 }finally{await page.close();}
});

it.each([{textOnly:true},{markup:true},{end:"pointercancel"}])("preserves text, history and existing contact-end semantics: %j",async options=>{
 const page=await mounted();try{
  const r=await page.evaluate(options=>(window as any).insertSpaceProbe(1,1,0,true,options),options);
  expect(r.down.cut).not.toBeNull();expect(r.after.doc).not.toBe(r.before.doc);
  if("textOnly" in options)expect(r.after.strokes).toEqual([]);
  if("markup" in options)expect(r.after.doc).toBe("\n\n"+r.before.doc);
  expect(r.after.history).toBe(r.before.history+1);
  expect(r.undone.doc).toBe(r.before.doc);expect(r.undone.strokes).toEqual(r.before.strokes);
  expect(r.redone.doc).toBe(r.after.doc);expect(r.redone.strokes).toEqual(r.after.strokes);
 }finally{await page.close();}
});

it.each([[1,""],[.1,""],[4,""],[1,"short typed line"]] as const)("keeps an ink-only split precise at zoom %s with text %j",async(zoom,shortText)=>{
 const page=await mounted();try{
  const r=await page.evaluate(([zoom,shortText])=>(window as any).insertSpaceProbe(zoom,1,zoom===4?40:0,false,{shortText,dy:13}),[zoom,shortText]);
  expect(r.down.cut).toBe(110);expect(r.down.ids).toEqual(["row-1"]);
  expect(r.hover).toBeCloseTo(r.origin+110*r.scale,1);
  expect(r.after.doc).toBe(shortText);expect(r.after.strokes[0]).toEqual(r.before.strokes[0]);
  expect(r.after.strokes[1].points[0].y-r.before.strokes[1].points[0].y).toBeCloseTo(13,6);
  expect(r.undone.doc).toBe(shortText);expect(r.undone.strokes).toEqual(r.before.strokes);
  expect(r.redone.strokes).toEqual(r.after.strokes);
 }finally{await page.close();}
});
