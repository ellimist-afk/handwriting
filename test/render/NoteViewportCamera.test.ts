import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { fitScale } from "./noteViewportCameraModel";
import { chromium, type Browser } from "playwright";
import css from "../../styles.css?raw";
declare const process: { env: Record<string, string | undefined> };
let browser:Browser, script:string;
const baseline=false;
const evidence:unknown[]=[];
beforeAll(async()=>{
 const b=await build({entryPoints:[fileURLToPath(new URL("./noteViewportCameraPage.ts",import.meta.url))],bundle:true,write:false,format:"iife",platform:"browser",alias:{obsidian:fileURLToPath(new URL("./iphoneObsidianStub.ts",import.meta.url))}});
 script=b.outputFiles[0]!.text;browser=await chromium.launch({headless:true});
});
afterAll(async()=>{await browser?.close();if(process.env.HW_VIEWPORT_EVIDENCE)writeFileSync(process.env.HW_VIEWPORT_EVIDENCE,JSON.stringify({baseline,evidence},null,2));});
const cases=[
 [.25,"x",1,false],[.25,"y",1,false],[.5,"x",1,false],[.5,"y",1,false],
 [1,"y",1,false],[2,"x",1,false],[2,"y",1,false],[2,"x",1,false],[2,"y",1,false],
 [2,"x",1.5,false],[2,"y",1.5,false],[2,"x",1,true],[2,"y",1,true],
] as const;
it.each(cases)("camera %s axis%s font%s cancel%s",async(zoom,axis,font,cancel)=>{
 const page=await browser.newPage({viewport:{width:700,height:540}});
 try{
  const pageErrors:string[]=[];page.on("pageerror",e=>pageErrors.push(e.message));
  await page.setContent("<!doctype html><body></body>");
  await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});
  await page.addScriptTag({content:script});
  const r=await page.evaluate(args=>(window as any).noteViewportRun(...args),[zoom,true,axis,font,cancel]);
  evidence.push(r);expect(pageErrors).toEqual([]);
  for(let i=0;i<r.layoutBefore.length;i++)for(let a=0;a<2;a++)expect(Math.abs(r.layoutAfter[i][a]-r.layoutBefore[i][a])).toBeLessThan(.03);
  expect(r.before).toEqual(r.after);expect(r.corners.every((c:any)=>c.inside)).toBe(true);expect(r.strokes).toHaveLength(4);
  expect(r.measured.paddingTop).toBe(4);expect(r.measured.overlayScale).toBeCloseTo(zoom,5);expect(r.measured.fontZoom).toBeCloseTo(font,5);
  for(const e of r.errors){expect(Math.abs(e.x)).toBeLessThan(1);expect(Math.abs(e.y)).toBeLessThan(1);}
  for(const c of r.measured.backings)expect(c.w*c.h).toBeLessThan(8_000_000);
  expect(r.touchTrace.some((s:any)=>s.parole===81)).toBe(true);expect(r.touchTrace.some((s:any)=>s.assist)).toBe(true);
  const down=r.touchTrace[0],lifted=r.touchTrace.find((s:any)=>s.phase==="pointerup"),end=r.touchTrace.at(-1);
  expect(lifted.fling).toBe(true);
  expect(Math.abs(down.content-lifted.content-120)).toBeLessThan(1.5*zoom+.1);
  expect(Math.abs(lifted.offset-down.offset-120/zoom)).toBeLessThan(1.6);
  expect(end.fling).toBe(false);expect(r.flingUpdates).toBeGreaterThan(0);
  if(cancel){expect(r.cancelled).toEqual({accepted:true,fling:false,assist:false,parole:null});expect(end.offset).toBe(r.cancelOffset);}
  else{
   const ideal=-(lifted.velocity-end.velocity)*325;
   expect(ideal).toBeGreaterThan(20);expect(Math.abs(down.content-end.content-120-ideal)).toBeLessThan((r.flingUpdates+3)*.5*zoom+1);
   expect(end.offset).toBe(r.terminalOffset);
  }
  expect(r.lock.rejected).toBe(true);expect(r.lock.scaleAfter).toBe(r.lock.scaleBefore);expect(r.lock.transformAfter).toBe(r.lock.transformBefore);
  expect(r.lock.after.x-r.lock.before.x).toBeCloseTo(12/(r.lock.scaleBefore*font),4);
  expect(r.invalidRejected).toEqual([true,true,true,true]);expect(r.hidden.valid).toBe(false);expect(r.hidden.rejected).toBe(true);
  expect(r.hidden.scale).toBe(r.invalidBefore.scale);expect(r.recovered).toEqual({valid:true,...r.invalidBefore});
 }finally{await page.close();}
});

it("production note viewport controls are reachable", async () => {
 const page=await browser.newPage({viewport:{width:700,height:540}});
 try {
  await page.setContent("<!doctype html><body></body>");
  await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});
  await page.addScriptTag({content:script});
  await page.evaluate(()=>(window as any).mountControl());
  expect(await page.getByRole("button",{name:"Fit handwriting",exact:true}).count()).toBe(1);
 } finally { await page.close(); }
});

it("real Fit frames saved separated ink within the zoom range, ignores empty growth, and reopens unchanged",async()=>{
 const page=await browser.newPage({viewport:{width:700,height:540}});
 try {
  await page.setContent("<!doctype html><body></body>");await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await page.addScriptTag({content:script});
  const before=await page.evaluate(()=>(window as any).viewportFixture.setup("far"));
  expect(before.state.busy,JSON.stringify(before)).toBe(false);
  await page.getByRole("button",{name:"Fit handwriting",exact:true}).click();await page.evaluate(()=>(window as any).viewportFixture.settle());
  const fitted=await page.evaluate(()=>(window as any).viewportFixture.snap("far"));evidence.push({before,fitted});
  if(process.env.HW_VIEWPORT_SCREENSHOT)await page.screenshot({path:process.env.HW_VIEWPORT_SCREENSHOT});
  expect(fitted.state.zoom).toBeLessThan(.3);expect(fitted.strokes).toHaveLength(2);
  const union={width:Math.max(...before.strokes.map((s:any)=>s.bbox.x+s.bbox.width))-Math.min(...before.strokes.map((s:any)=>s.bbox.x)),height:Math.max(...before.strokes.map((s:any)=>s.bbox.y+s.bbox.height))-Math.min(...before.strokes.map((s:any)=>s.bbox.y))};expect(fitted.state.zoom).toBeCloseTo(fitScale(union),10);
  for(const b of fitted.ink){expect(b.x).toBeGreaterThanOrEqual(-.5);expect(b.y).toBeGreaterThanOrEqual(-.5);expect(b.right).toBeLessThanOrEqual(640.5);expect(b.bottom).toBeLessThanOrEqual(480.5);}
  expect(fitted.strokes).toEqual(before.strokes);expect(fitted.doc).toBe(before.doc);expect(fitted.writes).toBe(before.writes);expect(fitted.history).toBe(before.history);
  expect(Math.max(...fitted.backings)).toBeLessThan(8_000_000);
  const grown=await page.evaluate(()=>(window as any).viewportFixture.growEmpty("far"));
  const again=await page.evaluate(()=>(window as any).viewportFixture.fit("far"));
  expect(again.state.zoom).toBe(fitted.state.zoom);for(let i=0;i<again.ink.length;i++)for(const axis of ["x","y","right","bottom"])expect(Math.abs(again.ink[i][axis]-fitted.ink[i][axis])).toBeLessThan(.1);
  for(let i=0;i<3;i++){await page.getByRole("button",{name:"Reset note zoom to 100%",exact:true}).click();await page.evaluate(()=>(window as any).viewportFixture.settle());await page.getByRole("button",{name:"Fit handwriting",exact:true}).click();await page.evaluate(()=>(window as any).viewportFixture.settle());}
  const repeated=await page.evaluate(()=>(window as any).viewportFixture.snap("far"));expect(repeated.extent).toEqual(grown.extent);
  const reopened=await page.evaluate(()=>(window as any).viewportFixture.reopen("far"));expect(reopened.state.zoom).toBe(1);expect(reopened.strokes).toEqual(before.strokes);expect(reopened.writes).toBe(before.writes);
  const refit=await page.evaluate(()=>(window as any).viewportFixture.fit("far"));expect(refit.state.zoom).toBe(fitted.state.zoom);
  const corners=await page.evaluate(()=>(window as any).viewportFixture.corners("far"));expect(corners.added).toBe(4);for(const error of corners.errors)for(const axis of error)expect(Math.abs(axis)).toBeLessThan(1);
 }finally{await page.close();}
});

it("production controls preserve wrapping, caret, selection, eraser and pane ownership",async()=>{
 const page=await browser.newPage({viewport:{width:1400,height:1100}});
 try {
  await page.setContent("<!doctype html><body></body>");await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await page.addScriptTag({content:script});
  const before=await page.evaluate(()=>(window as any).viewportFixture.setup("point","point"));
  const pointFit=await page.evaluate(()=>(window as any).viewportFixture.fit("point"));expect(pointFit.result).toBe("fit");expect(pointFit.state.zoom).toBe(1);
  await page.evaluate(()=>(window as any).viewportFixture.setup("other","empty"));
  await page.locator('[data-rig="point"]').getByRole("button",{name:"Zoom out",exact:true}).click();await page.evaluate(()=>(window as any).viewportFixture.settle());
  const half=await page.evaluate(()=>(window as any).viewportFixture.snap("point"));const other=await page.evaluate(()=>(window as any).viewportFixture.snap("other"));
  expect(half.state.zoom).toBe(.5);expect(other.state.zoom).toBe(1);expect(half.layout).toEqual(before.layout);expect(half.buttons.map((b:any)=>b.height)).toEqual(before.buttons.map((b:any)=>b.height));
  await page.evaluate(()=>(window as any).viewportFixture.keyboard());
  const caret=await page.evaluate(()=>(window as any).viewportFixture.caret("point",8));await page.mouse.click(caret.left,caret.top+3);
  const selectedText=await page.evaluate(()=>(window as any).viewportFixture.snap("point"));expect(selectedText.selection.anchor).toBe(8);
  const lasso=await page.evaluate(()=>(window as any).viewportFixture.gesture("point","lasso"));expect(lasso.selected).toContain("seed-0");
  const erased=await page.evaluate(()=>(window as any).viewportFixture.gesture("point","erase"));expect(erased.strokes).toHaveLength(0);
  const resized=await page.evaluate(()=>(window as any).viewportFixture.resize("point"));expect(resized.viewport.width).toBeCloseTo(580,0);expect(resized.viewport.height).toBeCloseTo(430,0);
  const empty=await page.evaluate(()=>(window as any).viewportFixture.fit("point"));expect(empty.result).toBe("empty");expect(empty.state.zoom).toBe(1);expect(empty.scroll.left).toBe(0);expect(empty.scroll.top).toBe(0);
 }finally{await page.close();}
});

it("Fit refuses unrepresentable ink and stale camera work cannot touch a replacement",async()=>{
 const page=await browser.newPage({viewport:{width:700,height:540}});
 try {
  await page.setContent("<!doctype html><body></body>");await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await page.addScriptTag({content:script});
  const before=await page.evaluate(()=>(window as any).viewportFixture.setup("huge","huge"));const refused=await page.evaluate(()=>(window as any).viewportFixture.fit("huge"));expect(refused.result).toBe("unrepresentable");expect(refused.state.zoom).toBe(before.state.zoom);expect(refused.strokes).toEqual(before.strokes);
  const switched=await page.evaluate(()=>(window as any).viewportFixture.stale("huge"));expect(switched.doc).toBe("replacement untouched");expect(switched.scroll).toEqual([0,0]);expect(switched.transform).toBe("");expect(switched.flashes).toBe(0);
 }finally{await page.close();}
});

it("loading and active ink refuse navigation; Fit composes font and external scale once",async()=>{
 const page=await browser.newPage({viewport:{width:1400,height:1100}});
 try {
  await page.setContent("<!doctype html><body></body>");await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await page.addScriptTag({content:script});
  const loading=await page.evaluate(()=>(window as any).viewportFixture.setup("load","loading"));expect(loading.state.busy).toBe(true);
  const refused=await page.evaluate(()=>(window as any).viewportFixture.fit("load"));expect(refused.result).toBe("busy");expect(refused.state.zoom).toBe(1);expect(refused.writes).toBe(loading.writes);
  const loaded=await page.evaluate(()=>(window as any).viewportFixture.release("load"));expect(loaded.state.busy).toBe(false);
  expect(await page.evaluate(()=>(window as any).viewportFixture.busy("load"))).toBe("busy");
  await page.evaluate(()=>(window as any).viewportFixture.setup("scaled","far",1,.8));await page.evaluate(()=>(window as any).viewportFixture.font("scaled"));
  const fitted=await page.evaluate(()=>(window as any).viewportFixture.fit("scaled"));expect(fitted.result).toBe("fit");expect(fitted.state.zoom).toBeLessThan(.3);
  for(const b of fitted.ink){expect(b.x).toBeGreaterThanOrEqual(fitted.viewport.x-.5);expect(b.y).toBeGreaterThanOrEqual(fitted.viewport.y-.5);expect(b.right).toBeLessThanOrEqual(fitted.viewport.x+fitted.viewport.width+.5);expect(b.bottom).toBeLessThanOrEqual(fitted.viewport.y+fitted.viewport.height+.5);}
 }finally{await page.close();}
});

it("centered padded text stays registered through zoom",async()=>{
 const page=await browser.newPage({viewport:{width:700,height:540}});
 try {
  await page.setContent("<!doctype html><body></body>");await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await page.addScriptTag({content:script});
  const before=await page.evaluate(()=>(window as any).viewportFixture.setup("theme","theme"));
  await page.getByRole("button",{name:"Zoom out",exact:true}).click();await page.evaluate(()=>(window as any).viewportFixture.settle());
  const half=await page.evaluate(()=>(window as any).viewportFixture.snap("theme"));expect(half.layout).toEqual(before.layout);expect(half.paper.attachment).toBe(before.paper.attachment);expect(half.paper.image).toContain("repeating-linear-gradient");expect(half.paper.attachment).toContain("local");
  const disposed=await page.evaluate(()=>(window as any).viewportFixture.dispose("theme"));expect(disposed.classes).not.toContain("handwriting-note-viewport");expect(disposed.parent).not.toContain("handwriting-note-viewport-pane");expect(disposed.style??"").not.toContain("--handwriting-note-column");
 }finally{await page.close();}
});

it("user scroll grows both axes, while teardown restores original inline styles",async()=>{
 const page=await browser.newPage({viewport:{width:700,height:540}});
 try {
  await page.setContent("<!doctype html><body></body>");await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await page.addScriptTag({content:script});
  await page.evaluate(()=>(window as any).viewportFixture.setup("scroll","empty"));
  const original=await page.evaluate(()=>(window as any).viewportFixture.original("scroll"));
  await page.getByRole("button",{name:"Zoom out",exact:true}).click();await page.evaluate(()=>(window as any).viewportFixture.settle());
  const moved=await page.evaluate(()=>(window as any).viewportFixture.scroll("scroll"));expect(moved.after.extent.x).toBeGreaterThan(moved.before.extent.x);expect(moved.after.extent.y).toBeGreaterThan(moved.before.extent.y);
  const disposed=await page.evaluate(()=>(window as any).viewportFixture.dispose("scroll"));
  // The existing overlay owns position:relative and removes it on teardown.
  expect(disposed.style).toBe(original.replace("position: relative; ",""));
 }finally{await page.close();}
});

it("theme changes update the normal column at fixed pane size and near-edge ink remains fit",async()=>{
 const page=await browser.newPage({viewport:{width:1400,height:1100}});
 try {
  await page.setContent("<!doctype html><body></body>");await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await page.addScriptTag({content:script});
  await page.evaluate(async()=>{await (window as any).viewportFixture.setup("zoomed","theme");await (window as any).viewportFixture.setup("control","theme");});
  await page.locator('[data-rig="zoomed"]').getByRole("button",{name:"Zoom out",exact:true}).click();await page.evaluate(()=>(window as any).viewportFixture.settle());
  await page.addStyleTag({content:'body [data-rig] .cm-content {max-width:400px;margin:0 auto;padding:20px 24px;}'});await page.evaluate(()=>(window as any).viewportFixture.settle());
  const widths=await page.evaluate(()=>[...document.querySelectorAll('[data-rig] .cm-content')].map(e=>(e as HTMLElement).offsetWidth));expect(widths).toEqual([400,400]);
  await page.locator('[data-rig="zoomed"]').getByRole("button",{name:"Reset note zoom to 100%",exact:true}).click();await page.evaluate(()=>(window as any).viewportFixture.settle());
  expect(await page.evaluate(()=>[...document.querySelectorAll('[data-rig] .cm-content')].map(e=>(e as HTMLElement).offsetWidth))).toEqual([400,400]);
  const edge=await page.evaluate(()=>(window as any).viewportFixture.setup("edge","edge"));const fit=await page.evaluate(()=>(window as any).viewportFixture.fit("edge"));expect(fit.result).toBe("fit");expect(fit.strokes).toEqual(edge.strokes);expect(fit.state.zoom).toBe(1);
 }finally{await page.close();}
});

it("a theme change during a real pen gesture is applied once after release",async()=>{
 const page=await browser.newPage({viewport:{width:1400,height:1100}});
 try {
  await page.setContent("<!doctype html><body></body>");await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await page.addScriptTag({content:script});
  await page.evaluate(async()=>{await (window as any).viewportFixture.setup("held","theme");await (window as any).viewportFixture.setup("control","theme");});
  await page.locator('[data-rig="held"]').getByRole("button",{name:"Zoom out",exact:true}).click();await page.evaluate(()=>(window as any).viewportFixture.settle());
  expect(await page.evaluate(()=>(window as any).viewportFixture.hold("held",true))).toBe(true);
  await page.addStyleTag({content:'body [data-rig] .cm-content {max-width:400px;margin:0 auto;padding:20px 24px;}'});await page.evaluate(()=>(window as any).viewportFixture.settle());
  expect(await page.evaluate(()=>[...document.querySelectorAll('[data-rig] .cm-content')].map(e=>(e as HTMLElement).offsetWidth))).toEqual([500,400]);
  await page.evaluate(()=>(window as any).viewportFixture.hold("held",false));await page.evaluate(()=>(window as any).viewportFixture.settle());
  expect(await page.evaluate(()=>[...document.querySelectorAll('[data-rig] .cm-content')].map(e=>(e as HTMLElement).offsetWidth))).toEqual([400,400]);
 }finally{await page.close();}
});

it.each([.5,1,2])("infinite canvas momentum policy at%s",async zoom=>{
 for(const axis of ["x","y"] as const)for(const mode of ["on","off","toggle","native","pen","pinch"]){
  const page=await browser.newPage({viewport:{width:700,height:540}});
  try {
   await page.setContent("<!doctype html><body></body>");await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await page.addScriptTag({content:script});
   const r=await page.evaluate(args=>(window as any).momentum(...args),[zoom,axis,mode]);
   expect(r.lifted-r.before).toBeGreaterThan(80/zoom);expect(r.running).toBe(false);expect(r.settled).toBe(r.end);
   if(mode==="off"){expect(r.started).toBe(true);expect(r.end).toBeGreaterThan(r.lifted);}
   else if(mode==="toggle"||mode==="pen"||mode==="pinch"){expect(r.started).toBe(true);expect(r.end).toBe(r.stopped);}
   else {expect(r.started).toBe(false);expect(r.end).toBe(r.lifted);expect(r.touchAction).toBe("none");}
  } finally {await page.close();}
 }
});

it("Chromium touch input pans without native coast; wheel scrolling remains available",async()=>{
 const page=await browser.newPage({viewport:{width:700,height:540}});
 try {
  await page.setContent("<!doctype html><body></body>");await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await page.addScriptTag({content:script});
  await page.evaluate(()=>(window as any).nativeMomentumSetup());
  const cdp=await page.context().newCDPSession(page);
  for(const [type,n] of [["touchStart",380],["touchMove",340],["touchMove",300],["touchMove",260],["touchEnd",260]] as const){await cdp.send("Input.dispatchTouchEvent",{type,touchPoints:type==="touchEnd"?[]:[{x:300,y:n,id:1,radiusX:4,radiusY:4,force:.5}]});await page.waitForTimeout(25);}
  const lifted=await page.evaluate(()=>(window as any).nativeMomentumState());expect(lifted.top).toBeGreaterThan(80);expect(lifted.fling).toBe(false);expect(lifted.touchAction).toBe("none");
  await page.waitForTimeout(500);expect(await page.evaluate(()=>(window as any).nativeMomentumState())).toEqual(lifted);
  await page.mouse.move(300,200);await page.mouse.wheel(30,100);await page.waitForTimeout(150);const wheel=await page.evaluate(()=>(window as any).nativeMomentumState());expect(wheel.top).toBeGreaterThan(lifted.top);
  await cdp.detach();
 }finally{await page.close();}
});

it("uses the exact Infinite Canvas settings explanation",()=>{
 expect(readFileSync(fileURLToPath(new URL("../../src/main.ts",import.meta.url)),"utf8")).toContain('desc: "Scroll to the right or down infinitely. Momentum is turned off when this setting is toggled on."');
});


it.each([["far",4],["theme",20],["zero-padding",0]] as const)("camera fixture retains %s padding (%spx)",async(kind,padding)=>{
 const page=await browser.newPage({viewport:{width:1400,height:1100}});
 try{
  await page.setContent("<!doctype html><body></body>");await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await page.addScriptTag({content:script});
  const before=await page.evaluate(kind=>(window as any).viewportFixture.setup("padding",kind),kind);
  expect(before.paddingTop).toBe(padding);
  await page.getByRole("button",{name:"Zoom out",exact:true}).click();await page.evaluate(()=>(window as any).viewportFixture.settle());
  const after=await page.evaluate(()=>(window as any).viewportFixture.snap("padding"));
  expect(after.paddingTop).toBe(padding);expect(after.strokes).toEqual(before.strokes);
 }finally{await page.close();}
});
