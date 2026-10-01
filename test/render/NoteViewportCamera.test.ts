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
/**
 * Replaces `toEqual` on two `snap().layout` arrays (family 1: the `snap()`
 * producer, zoom via one button click to k .5, `overlay.cssScale` divisor -
 * see the review note that production measures this back too,
 * though it does not bite at k .5 with an integer offset width). Measured
 * (gate-eb9e7239.log diff blocks, both cells): every differing entry is
 * exactly 0.015625 = 1/64 note px, x only, y always exactly equal - glyph-
 * advance re-snap when CSS `zoom` re-lays the text out, not a divisor error
 * (a divisor error would grow with x and reach y; this doesn't). `bound` is
 * 1/32, twice the measured max, the same margin-over-measured convention as
 * part 1's dx bound.
 */
function sameLayout(after:[number,number][],before:[number,number][],bound=1/32){
 expect(after.length,"layout length unchanged").toBe(before.length);
 for(let i=0;i<before.length;i++){
  expect(after[i]![1],`glyph ${i} y - wrapping and row assignment must not move`).toBe(before[i]![1]);
  expect(Math.abs(after[i]![0]-before[i]![0]),`glyph ${i} x`).toBeLessThanOrEqual(bound);
 }
}

it.each(["before","during"] as const)("mounted sync retains a lifted lasso selection %s preservation and converges after Escape without an edit",async phase=>{
 const page=await browser.newPage({viewport:{width:1400,height:1100}});
 try{
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.setContent("<!doctype html><body></body>");
  await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});
  await page.addScriptTag({content:script});
  const r=await page.evaluate(p=>(window as any).mountedSyncAdmission("selection",p),phase);evidence.push(r);
  expect(errors).toEqual([]);
  expect(r.before.quiet).toEqual([true,true]);
  expect(r.busy.b.selected).toEqual(["seed-0"]);
  expect(r.busy.quiet).toEqual([true,false]);
  expect(r.result.outcome,"retained selection must prevent premature shared-model adoption").toBe("held");
  expect(r.refused.b.selected,"adoption refusal must preserve the actual lifted lasso selection").toEqual(["seed-0"]);
  for(const id of ["a","b"]){
   expect(r.refused[id].strokes).toEqual(r.before[id].strokes);
   expect(r.refused[id].history).toBe(r.before[id].history);
   expect(r.refused[id].doc).toBe(r.before[id].doc);
  }
  expect(r.refused.accepts).toBe(0);expect(r.refused.notifications).toBe(0);expect(r.refused.notices).toEqual([]);
  expect(r.refused.preparations).toBe(phase==="during"?1:0);
  expect(r.refused.changed,"held incoming baseline stays discoverable").toBe(true);
  expect(r.released.b.selected).toEqual([]);expect(r.released.quiet).toEqual([true,true]);
  expect(r.retry.outcome).toBe("adopted");expect(r.after.accepts).toBe(1);expect(r.after.notifications).toBe(1);expect(r.after.changed).toBe(false);
  for(const id of ["a","b"]){
   expect(r.after[id].strokes.map((s:any)=>s.id)).toEqual(["incoming"]);
   expect(r.after[id].paint.visible,"both matching mounted canvases repaint incoming ink").toBeGreaterThan(0);
   expect(r.after[id].paint.alphaHash).not.toBe(r.before[id].paint.alphaHash);
   expect(r.after[id].history).toBe(r.before[id].history);
  }
  expect(r.recovery.some((copy:any)=>copy.ids.includes("seed-0"))).toBe(true);
  expect(r.recovery.some((copy:any)=>copy.ids.includes("incoming"))).toBe(true);
 }finally{await page.close();}
});

it.each(["before","during"] as const)("mounted sync preserves the same live pen gesture %s preservation and commits its continuation",async phase=>{
 const page=await browser.newPage({viewport:{width:1400,height:1100}});
 try{
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.setContent("<!doctype html><body></body>");
  await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});
  await page.addScriptTag({content:script});
  const r=await page.evaluate(p=>(window as any).mountedSyncAdmission("pen",p),phase);evidence.push(r);
  expect(errors).toEqual([]);expect(r.before.quiet).toEqual([true,true]);expect(r.busy.quiet).toEqual([true,false]);
  expect(r.result.outcome,"an uncommitted sibling gesture must prevent premature adoption").toBe("held");
  for(const id of ["a","b"]){expect(r.refused[id].strokes).toEqual(r.before[id].strokes);expect(r.refused[id].history).toBe(r.before[id].history);}
  expect(r.refused.accepts).toBe(0);expect(r.refused.notifications).toBe(0);expect(r.refused.notices).toEqual([]);
  expect(r.refused.preparations).toBe(phase==="during"?1:0);expect(r.refused.changed).toBe(true);
  expect(r.completed.b.strokes).toHaveLength(2);expect(r.completed.a.strokes).toEqual(r.completed.b.strokes);
  expect(r.completed.b.strokes[0]).toEqual(r.before.b.strokes[0]);
  const stroke=r.completed.b.strokes[1],first=stroke.points[0],last=stroke.points.at(-1);
  expect(last.x-first.x,"same stroke retains contact before await and continuation afterwards").toBeCloseTo(50/r.pointScale,2);
  expect(last.y-first.y).toBeCloseTo(15/r.pointScale,2);
  expect(r.completed.b.history).toBe(r.before.b.history+1);
  expect(r.undone.b.strokes).toEqual(r.before.b.strokes);expect(r.redone.b.strokes).toEqual(r.completed.b.strokes);
  expect(r.released.queued).toBe(false);expect(r.released.quiet).toEqual([true,true]);expect(r.retry.outcome).toBe("adopted");
  for(const id of ["a","b"]){expect(r.after[id].strokes.map((s:any)=>s.id)).toEqual(["incoming"]);expect(r.after[id].paint.visible).toBeGreaterThan(0);}
  expect(r.recovery.some((copy:any)=>copy.ids.includes(stroke.id)),"committed local revision remains recoverable independently of incoming visibility").toBe(true);
 }finally{await page.close();}
});

it("mounted sync rejects a transient same-note pane joining and retiring during preservation",async()=>{
 const page=await browser.newPage({viewport:{width:1400,height:1600}});
 try{
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.setContent("<!doctype html><body></body>");
  await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});
  await page.addScriptTag({content:script});
  const r=await page.evaluate(()=>(window as any).mountedSyncAdmission("transient-pane","during"));evidence.push(r);
  expect(errors).toEqual([]);expect(r.before.quiet).toEqual([true,true]);expect(r.joined.quiet).toEqual([true,true,true]);expect(r.busy.quiet).toEqual([true,true]);
  expect(r.result.outcome,"the original quiet cohort cannot bless an attempt spanning a transient attached pane").toBe("held");
  expect(r.refused.accepts).toBe(0);expect(r.refused.notifications).toBe(0);expect(r.refused.changed).toBe(true);
  for(const id of ["a","b"])expect(r.refused[id].strokes).toEqual(r.before[id].strokes);
  expect(r.retry.outcome).toBe("adopted");expect(r.after.accepts).toBe(1);expect(r.after.changed).toBe(false);
  for(const id of ["a","b"]){expect(r.after[id].strokes.map((s:any)=>s.id)).toEqual(["incoming"]);expect(r.after[id].paint.visible).toBeGreaterThan(0);}
 }finally{await page.close();}
});

it("mounted sync waits through the production camera control's owned settlement",async()=>{
 const page=await browser.newPage({viewport:{width:700,height:540}});
 try{
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.setContent("<!doctype html><body></body>");
  await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});
  await page.addScriptTag({content:script});
  const r=await page.evaluate(()=>(window as any).mountedSyncCameraSettlement());evidence.push(r);
  expect(errors).toEqual([]);expect(r).toEqual({before:true,textSelection:true,textRange:{anchor:1,head:8},chosenTool:true,hover:true,pending:false,after:true,zoom:.5});
 }finally{await page.close();}
});

it("a converged pinch settle closes the reload gate it opened",async()=>{
 const page=await browser.newPage({viewport:{width:700,height:540}});
 try{
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.setContent("<!doctype html><body></body>");
  await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});
  await page.addScriptTag({content:script});
  const r=await page.evaluate(()=>(window as any).mountedSyncPinchSettlement());evidence.push(r);
  expect(errors).toEqual([]);
  expect(r.outcome,"the pinch did not reach hold convergence, so this cell proves nothing about the settled() call").toBe("converged");
  expect(r.before,"a quiet pane admits a reload before the gesture").toBe(true);
  expect(r.during,"a live pinch preview holds the reload").toBe(false);
  expect(r.gateOpened,"the commit opens the camera settlement gate at all").toBe(true);
  expect(r.after,"InkOverlay.ts:8293 closes the gate on the converged path; without it the pane never admits a reload again").toBe(true);
  expect(r.gate,"the settlement generation is cleared, not merely superseded").toBeNull();
 }finally{await page.close();}
});

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
  // The pin: the harness engine supports css zoom, and the overlay's own
  // cached gate agrees with it. A run where either is false is a different
  // host form (no coverage here) and nothing below is claimed
  // for it.
  expect(r.engineZoom, "the harness engine supports css zoom").toBe(true);
  expect(r.hostZoom, "the overlay's host-form gate agrees with the engine").toBe(r.engineZoom);
  // A test-model rewrite never lowers coverage (2026-09-14).
  // Two invariants, kept together, neither a replacement for the other:
  //
  // (1) the LINE box. `.cm-line` count catches an added/removed logical line
  // but NOT a re-wrap (wrapping changes a line's height, not the count), so
  // height is asserted per line beside the count; each line's top is asserted
  // unmoved. Measured 0 layout-px line-box top movement at every k/font/
  // cancel arm tried (a line-box read on 1.4.20) - the 1/64 note-px bound below is tighter than
  // CodeMirror's own LayoutUnit grid at k .25 (1/64 SCREEN px = 1/16 note px
  // there) and holds on this fixture only because both measured tops (the
  // padding top, and padding + line 0's height) land exactly on that grid at
  // every k tried; it is not a general LayoutUnit-class claim.
  //
  // (2) per-GLYPH x/y drift, restored: the line box alone cannot see a
  // horizontal shift or a re-wrap that keeps the same row count within line 0
  // (e.g. words moving between rows 3 and 4 while the line stays 10 rows) -
  // nothing else in this cell checks text layout (`errors` is pen-to-screen
  // input mapping, `corners` is hit-testing, neither is glyph position).
  // `layoutBefore`/`layoutAfter` now divide by the COMMANDED scale (zoom x
  // font at each snapshot) instead of CodeMirror's separately measured-back
  // view.scaleX/scaleY, so this is an independent check, not the same
  // measured-back term reappearing on both sides of its own assert. dy is
  // asserted as a UNIFORM offset (no row reassignment) rather than near-zero,
  // because a real, expected constant vertical shift exists at some k (ascent
  // rounding of the zoomed font inside the fixed line box - see (1)); dx is
  // bounded at two LayoutUnits of the zoomed grid plus this producer's own
  // 0.01 rounding (page :31).
  expect(r.lineBoxAfter.length, "line count unchanged - no line added or removed").toBe(r.lineBoxBefore.length);
  for(let i=0;i<r.lineBoxBefore.length;i++){
   expect(Math.abs(r.lineBoxAfter[i].top-r.lineBoxBefore[i].top),`line ${i} top`).toBeLessThanOrEqual(1/64);
   expect(Math.abs(r.lineBoxAfter[i].height-r.lineBoxBefore[i].height),`line ${i} height - a re-wrap changes this even when the count doesn't move`).toBeLessThanOrEqual(1/64);
  }
  const dxBound=2/(64*Math.min(zoom,1))+.01;
  const dy0=r.layoutAfter[0][1]-r.layoutBefore[0][1];
  for(let i=0;i<r.layoutBefore.length;i++){
   const dx=r.layoutAfter[i][0]-r.layoutBefore[i][0],dy=r.layoutAfter[i][1]-r.layoutBefore[i][1];
   expect(Math.abs(dx),`glyph ${i} dx`).toBeLessThanOrEqual(dxBound);
   expect(Math.abs(dy-dy0),`glyph ${i} dy vs dy[0]=${dy0} - a uniform offset, not a row change`).toBeLessThanOrEqual(1/64);
   expect(Math.abs(dy),`glyph ${i} dy magnitude - under half the 24px row pitch`).toBeLessThan(12);
  }
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
   // Canvas on now (the zoom bar needs it live), so the glide decays on the canvas's own
   // shorter tau, 200ms not Fling.ts's 325 (InlinePenRouter.ts CANVAS_FLING_TAU_MS, not exported).
   const ideal=-(lifted.velocity-end.velocity)*200;
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
  expect(half.state.zoom).toBe(.5);expect(other.state.zoom).toBe(1);
  expect(half.engineZoom,"the harness engine supports css zoom").toBe(true);
  expect(half.hostZoom,"the overlay's host-form gate agrees with the engine").toBe(half.engineZoom);
  sameLayout(half.layout,before.layout);
  expect(half.buttons.map((b:any)=>b.height)).toEqual(before.buttons.map((b:any)=>b.height));
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
  const half=await page.evaluate(()=>(window as any).viewportFixture.snap("theme"));
  expect(half.engineZoom,"the harness engine supports css zoom").toBe(true);
  expect(half.hostZoom,"the overlay's host-form gate agrees with the engine").toBe(half.engineZoom);
  sameLayout(half.layout,before.layout);
  expect(half.paper.attachment).toBe(before.paper.attachment);expect(half.paper.image).toContain("repeating-linear-gradient");expect(half.paper.attachment).toContain("local");
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
  // The overlay owns position:relative and its own paper values (planned at
  // rest, so already in `original`) and removes both on teardown. Every other
  // declaration comes back exactly as found; the paper ones are carved out of
  // that comparison and checked on their own.
  const paper=/\s*--handwriting-paper-(pitch|rule|dot|phase|phase-x):[^;]*;/g;
  expect.soft((disposed.style??"").replace(paper,"").trim(),"the host's own inline declarations are restored exactly").toBe(original.replace("position: relative; ","").replace(paper,"").trim());
  expect.soft(disposed.style??"","none of the overlay's paper values remain after teardown").not.toMatch(/--handwriting-paper-/);
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

// Infinite canvas owns the touch pan from contact and still glides after the lift, as with it off.
it.each([.5,1,2])("infinite canvas momentum policy at%s",async zoom=>{
 for(const axis of ["x","y"] as const)for(const mode of ["on","off","toggle","native","pen","pinch"]){
  const page=await browser.newPage({viewport:{width:700,height:540}});
  try {
   await page.setContent("<!doctype html><body></body>");await page.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await page.addScriptTag({content:script});
   // The pan is read on screen: the content under the finger, from contact to lift. Scroll units differ
   // with Infinite canvas on and off at the same zoom, so a scroll delta cannot say whether the page kept up.
   await page.evaluate(axis=>{const w=window as any;w.__pan={};const at=()=>{const b=document.querySelector<HTMLElement>(".cm-content")!.getBoundingClientRect();return axis==="x"?b.left:b.top;};
    window.addEventListener("pointerdown",e=>{if(e.pointerId===301)w.__pan.down=at();},true);
    window.addEventListener("pointerup",e=>{if(e.pointerId===301)w.__pan.up=at();},true);},axis);
   const r=await page.evaluate(args=>(window as any).momentum(...args),[zoom,axis,mode]);
   const pan=await page.evaluate(()=>(window as any).__pan);
   expect(pan.down-pan.up,`${axis} ${mode} the page moved with the finger on screen`).toBeGreaterThan(80);
   expect(r.lifted).not.toBe(r.before);expect(r.running).toBe(false);expect(r.settled).toBe(r.end);
   if(mode==="off"){expect(r.started).toBe(true);expect(r.end).toBeGreaterThan(r.lifted);}
   else if(mode==="toggle"||mode==="pen"||mode==="pinch"){expect(r.started).toBe(true);expect(r.end).toBe(r.stopped);}
   else {expect(r.started,`${axis} ${mode} glide starts under Infinite canvas`).toBe(true);expect(r.end,`${axis} ${mode} glide carries past the lift`).toBeGreaterThan(r.lifted);expect(r.touchAction).toBe("none");}
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
  // The plugin's own glide may run after the lift and must stop; once it has, nothing else moves the page.
  const lifted=await page.evaluate(()=>(window as any).nativeMomentumState());expect(lifted.top).toBeGreaterThan(80);
  await page.waitForFunction(()=>!(window as any).nativeMomentumState().fling,undefined,{timeout:3000});
  const rested=await page.evaluate(()=>(window as any).nativeMomentumState());
  // A control only: headless Chromium does not coast CDP touch, so the touch-action check below is what catches a browser coast.
  await page.waitForTimeout(500);expect(await page.evaluate(()=>(window as any).nativeMomentumState()),"no motion after the glide ends").toEqual(rested);
  expect(lifted.touchAction).toBe("none");
  await page.mouse.move(300,200);await page.mouse.wheel(30,100);await page.waitForTimeout(150);const wheel=await page.evaluate(()=>(window as any).nativeMomentumState());expect(wheel.top).toBeGreaterThan(rested.top);
  await cdp.detach();
 }finally{await page.close();}
});

// The wording is product copy that changes, so only the row is pinned: the setting exists,
// drives the canvas key, and says something.
it("lists the Infinite canvas setting with a description",()=>{
 const main=readFileSync(fileURLToPath(new URL("../../src/main.ts",import.meta.url)),"utf8");
 const row=main.match(/name:\s*"Infinite canvas",\s*desc:\s*"([^"]*)",\s*control:\s*\{\s*type:\s*"toggle",\s*key:\s*"extendCanvasWhileScrolling"\s*\}/);
 expect(row,"the Infinite canvas toggle row").not.toBeNull();
 expect((row![1] ?? "").trim().length).toBeGreaterThan(0);
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
