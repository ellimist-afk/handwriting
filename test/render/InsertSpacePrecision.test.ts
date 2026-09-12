/** Continuous aim, a separately visible eligible seam, and exact whole-group
 * preview replace the old reticle=divider contract (HE recommendation).
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
  expect.soft(r.hover).toBeCloseTo(r.contact.y,1);
  expect.soft(r.down.reticle).toBeCloseTo(r.contact.y,1);
  expect(r.live.reticle).toBeCloseTo(r.contact.y+48*r.scale,1);
  expect(r.hoverFeedback.guides).toEqual([r.down.cut]);
  expect(r.down.guides).toEqual([r.down.cut]);
  expect(r.ended.rendered).toEqual([]);expect(r.ended.guides).toEqual([]);
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
  if(!("edit" in options))expect(r.live.labels.find((l:any)=>l.text.startsWith("Release:"))?.y).toBe(r.down.cut);
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
  expect(r.down.cut).toBeCloseTo(104,6);expect(r.down.ids).toEqual(["row-1"]);
  expect(r.hover).toBeCloseTo(r.origin+104*r.scale,1);
  expect(r.hoverFeedback.guides[0]).toBeCloseTo(104,6);
  expect(r.hoverFeedback.rendered.filter((s:any)=>s.moving).map((s:any)=>s.id)).toEqual(["row-1"]);
  expect(r.hoverFeedback.rendered.find((s:any)=>s.id==="row-0")?.moving).toBe(false);
  expect(r.hoverFeedback.rendered.every((s:any)=>s.alpha)).toBe(true);
  expect(r.after.doc).toBe(shortText);expect(r.after.strokes[0]).toEqual(r.before.strokes[0]);
  expect(r.after.strokes[1].points[0].y-r.before.strokes[1].points[0].y).toBeCloseTo(13,6);
  expect(r.undone.doc).toBe(shortText);expect(r.undone.strokes).toEqual(r.before.strokes);
  expect(r.redone.strokes).toEqual(r.after.strokes);
 }finally{await page.close();}
});

it.each([139,140,141])("keeps a tall transitive group explicit at contact %s",async contactY=>{
 const page=await mounted();try{
  const r=await page.evaluate(contactY=>(window as any).insertSpaceProbe(1,1,0,false,{shortText:"",tall:true,contactY,sweep:[138,139,140,141,142],moves:[70,-30,5],dy:13}),contactY);
  const expected=contactY<140?["tall","distant","below"]:["below"];
  expect(r.down.ids).toEqual(expected);expect(r.down.cut).toBeCloseTo(contactY,6);
  for(const sample of r.sweep){
   expect(sample.reticle).toBeCloseTo(r.origin+sample.y*r.scale,1);
   expect(sample.guides).toEqual([sample.y]);
   expect(sample.rendered.filter((s:any)=>s.moving).map((s:any)=>s.id)).toEqual(sample.y<140?["tall","distant","below"]:["below"]);
   expect(sample.rendered.every((s:any)=>s.alpha)).toBe(true);
  }
  expect(r.down.rendered.filter((s:any)=>s.moving).map((s:any)=>s.id)).toEqual(expected);
  for(const move of [...r.moves,{dy:13,ids:r.down.ids,strokes:r.after.strokes}]){
   expect(move.ids).toEqual(expected);
   expect(move.strokes.map((s:any)=>s.id)).toEqual(r.before.strokes.map((s:any)=>s.id));
   for(let i=0;i<r.before.strokes.length;i++){
    const before=r.before.strokes[i],after=move.strokes[i],dy=expected.includes(before.id)?move.dy:0;
    expect(after.points).toEqual(before.points.map((p:any)=>({...p,y:p.y+dy})));
    expect(after.color).toBe(before.color);
   }
  }
  expect(r.after.doc).toBe("");expect(r.undone.strokes).toEqual(r.before.strokes);expect(r.redone.strokes).toEqual(r.after.strokes);
 }finally{await page.close();}
});

it("keeps text seams independent of large ink groups and predicts rounded release",async()=>{
 const page=await mounted();try{
  const r=await page.evaluate(()=>(window as any).insertSpaceProbe(1,1,0,false,{tall:true,sweep:[103,104,105],moves:[80,-5,37],dy:37}));
  expect(r.down.cut).toBeCloseTo(96,6);
  for(const hover of r.sweep){expect(hover.guides).toEqual([96]);expect(hover.reticle).toBeCloseTo(r.origin+hover.y,1);}
  const landing=r.live.labels.find((l:any)=>l.text.startsWith("Release:"));
  expect(landing?.text).toBe("Release: 2 lines");expect(landing.y-r.down.cut).toBe(48);
  expect(r.live.dy).toBe(37);
  for(let i=0;i<r.before.strokes.length;i++)expect(r.after.strokes[i].points).toEqual(r.before.strokes[i].points.map((p:any)=>({...p,y:p.y+(r.down.ids.includes(r.before.strokes[i].id)?48:0)})));
  expect(r.undone.doc).toBe(r.before.doc);expect(r.undone.strokes).toEqual(r.before.strokes);expect(r.redone.strokes).toEqual(r.after.strokes);
 }finally{await page.close();}
});

it("keeps raw aim visible when no eligible target exists",async()=>{
 const page=await mounted();try{
  const r=await page.evaluate(()=>(window as any).insertSpaceProbe(1,1,0,false,{invalidTarget:true}));
  expect(r.hover).toBeCloseTo(r.contact.y,1);expect(r.down.reticle).toBeCloseTo(r.contact.y,1);
  expect(r.live.reticle).toBeCloseTo(r.contact.y+48,1);expect(r.hoverFeedback.guides).toEqual([]);
  expect(r.after.doc).toBe(r.before.doc);expect(r.after.strokes).toEqual(r.before.strokes);
 }finally{await page.close();}
});

it.each(["setext-dash","setext-equals","fence","frontmatter"])("keeps the surrounding Markdown block intact: %s",async context=>{
 const page=await mounted();try{
  const r=await page.evaluate(context=>(window as any).insertSpaceProbe(1,1,0,true,{context}),context);
  expect(r.hoverFeedback.labels.some((l:any)=>l.text.startsWith("Block boundary"))).toBe(true);
  if(context==="frontmatter"){
   const end=r.before.doc.lastIndexOf("\nlast");
   expect(r.after.doc.slice(0,end)).toBe(r.before.doc.slice(0,end));
  }else expect(r.after.doc).toBe("\n\n"+r.before.doc);
  expect(r.undone.doc).toBe(r.before.doc);expect(r.undone.strokes).toEqual(r.before.strokes);
 }finally{await page.close();}
});
