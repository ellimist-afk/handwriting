import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
let browser:Browser,script:string;
beforeAll(async()=>{const b=await build({entryPoints:[fileURLToPath(new URL("./noteViewportCameraPage.ts",import.meta.url))],bundle:true,write:false,format:"iife",platform:"browser",alias:{obsidian:fileURLToPath(new URL("./iphoneObsidianStub.ts",import.meta.url))}});script=b.outputFiles[0]!.text;browser=await chromium.launch({headless:true});});
afterAll(async()=>{await browser?.close();});
async function mounted(){const p=await browser.newPage({viewport:{width:1400,height:1100}});await p.setContent("<!doctype html><body></body>");await p.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await p.addScriptTag({content:script});return p;}
const call=(p:Page,method:string,...args:unknown[])=>p.evaluate(([method,args])=>(window as any).viewportFixture[method](...args),[method,args] as const);
const edge=(p:Page,method:string,...args:unknown[])=>p.evaluate(([method,args])=>(window as any).edgeAudit[method](...args),[method,args] as const);
function framed(s:any){for(const b of s.ink){expect(b.x).toBeGreaterThanOrEqual(s.viewport.x-.5);expect(b.y).toBeGreaterThanOrEqual(s.viewport.y-.5);expect(b.right).toBeLessThanOrEqual(s.viewport.x+s.viewport.width+.5);expect(b.bottom).toBeLessThanOrEqual(s.viewport.y+s.viewport.height+.5);}}
it.each(["negative-width-padding","partial-negative-y"])("edge audit: reachable %s still fits and paints",async kind=>{const p=await mounted();try{
 const original=await call(p,"setup","partial",kind),fitted=await call(p,"fitVisible","partial");
 expect(kind==="negative-width-padding"?original.strokes[0].bbox.x:original.strokes[0].bbox.y).toBeLessThan(0);
 expect(fitted.result).toBe("fit");expect(fitted.visiblePainted).toBeGreaterThan(0);
 expect(fitted.strokes).toEqual(original.strokes);expect(fitted.writes).toBe(original.writes);
}finally{await p.close();}});
it("edge audit: invalid hidden geometry refuses Fit without altering ink",async()=>{const p=await mounted();try{
 const original=await call(p,"setup","hidden-body","reachable-body-only"),hidden=await call(p,"hiddenFit","hidden-body");
 expect(hidden.valid).toBe(false);expect(hidden.result).toBe("unrepresentable");expect(hidden.strokes).toEqual(original.strokes);expect(hidden.writes).toBe(original.writes);
}finally{await p.close();}});
it("edge audit: low zoom Fit resize and upper/lower zoom rejection preserve ink and recover",async()=>{const p=await mounted();try{
 const original=await call(p,"setup","edge");const fitted=await call(p,"fit","edge");expect(fitted.state.zoom).toBeLessThan(.3);
 const resized=await call(p,"resize","edge");expect(resized.viewport.width).toBeCloseTo(580,0);expect(resized.state.zoom).toBe(fitted.state.zoom);
 const refit=await call(p,"fit","edge");framed(refit);expect(refit.state.zoom).toBeLessThan(fitted.state.zoom);
 for(let i=0;i<3;i++){const smaller=await edge(p,"zoom","edge",.5);expect(smaller.accepted).toBe(true);}for(let i=0;i<2;i++){const limited=await edge(p,"zoom","edge",1e-9);expect(limited.accepted).toBe(true);expect(limited.state.zoom).toBe(.1);}const upper=await edge(p,"zoom","edge",1e9);expect(upper.state.zoom).toBe(4);expect((await edge(p,"zoom","edge",2)).state.zoom).toBe(4);
 for(let i=0;i<3;i++){await p.getByRole("button",{name:"Reset note zoom to 100%",exact:true}).click();await call(p,"settle");framed(await call(p,"fit","edge"));}
 const end=await call(p,"snap","edge");expect(end.strokes).toEqual(original.strokes);expect(end.writes).toBe(original.writes);expect(end.history).toBe(original.history);
}finally{await p.close();}},20000);
it.each(["below-minimum","former-far"])("ten-percent floor covers live pinch, commits and Fit for %s without changing ink",async kind=>{const p=await mounted();try{
 const original=await call(p,"setup","floor",kind);
 const pinch=await edge(p,"floorPinch","floor");expect(pinch.live.state.zoom).toBe(.1);expect(pinch.after.state.zoom).toBe(.1);
 const before=await call(p,"snap","floor");const rejected=await edge(p,"commit","floor",.01);expect(rejected.accepted).toBe(false);expect(rejected.state.zoom).toBe(before.state.zoom);expect(rejected.scroll).toEqual(before.scroll);
 const fitted=await call(p,"fit","floor");expect(fitted.result).toBe("unrepresentable");expect(fitted.state.zoom).toBe(before.state.zoom);expect(fitted.scroll).toEqual(before.scroll);
 expect(fitted.strokes).toEqual(original.strokes);expect(fitted.writes).toBe(original.writes);expect(fitted.history).toBe(original.history);
 const recovery=await edge(p,"zoom","floor",2);expect(recovery.state.zoom).toBe(.2);
}finally{await p.close();}});
it("edge audit: erase distant outlier then undo/redo changes live Fit bounds",async()=>{const p=await mounted();try{
 const original=await call(p,"setup","history");const fitted=await call(p,"fit","history");const erased=await edge(p,"eraseOutlier","history");expect(erased.strokes).toHaveLength(1);
 const near=await call(p,"fit","history");framed(near);expect(near.state.zoom).toBeGreaterThan(fitted.state.zoom*3);
 const undone=await edge(p,"history","history","undo");expect(undone.accepted).toBe(true);expect(undone.strokes).toEqual(original.strokes);const restored=await call(p,"fit","history");expect(restored.state.zoom).toBe(fitted.state.zoom);framed(restored);
 const redone=await edge(p,"history","history","redo");expect(redone.accepted).toBe(true);expect(redone.strokes).toEqual(erased.strokes);expect((await call(p,"fit","history")).state.zoom).toBe(near.state.zoom);
}finally{await p.close();}});
it.each(["erase","lasso"])("edge audit: held %s refuses Fit until release",async kind=>{const p=await mounted();try{await call(p,"setup","tool");await call(p,"fit","tool");const r=await edge(p,"heldTool","tool",kind);expect(r.before.state.busy).toBe(true);expect(r.result).toBe("busy");expect(r.after.state.zoom).toBe(r.before.state.zoom);expect((await call(p,"fit","tool")).result).toBe("fit");}finally{await p.close();}});
it("edge audit: low zoom Fit touch pan stops and pinch retains saved geometry",async()=>{const p=await mounted();try{const original=await call(p,"setup","touch");await call(p,"fit","touch");const r=await edge(p,"tinyTouch","touch");expect(r.before.state.zoom).toBeLessThan(.3);expect(r.panned.scroll.top).toBeGreaterThan(r.before.scroll.top);expect(r.fling).toBe(false);expect(r.pinched.state.zoom).toBeGreaterThan(r.before.state.zoom);expect(r.after.strokes).toEqual(original.strokes);expect(r.after.writes).toBe(original.writes);framed(await call(p,"fit","touch"));}finally{await p.close();}});
it.each(["thick-dot","negative"])("edge audit: supported stored %s geometry",async kind=>{const p=await mounted();try{const original=await call(p,"setup","geometry",kind);expect(original.strokes).toHaveLength(1);expect(original.strokes[0].points).toHaveLength(1);const fitted=await call(p,"fit","geometry");expect(fitted.strokes).toEqual(original.strokes);expect(fitted.writes).toBe(original.writes);if(kind==="thick-dot"){expect(fitted.result).toBe("fit");framed(fitted);}else{expect(fitted.result).toBe("unrepresentable");expect(fitted.state.zoom).toBe(original.state.zoom);expect(fitted.scroll).toEqual(original.scroll);}}finally{await p.close();}});

it("edge audit: two outliers disjoint on opposite axes contribute nothing to Fit, and paint no visible pixels themselves",async()=>{const p=await mounted();try{
 // R2's exact receipted configuration: one outlier left-and-below the origin
 // (x<0, y huge positive), one right-and-above (x huge positive, y<0). Each
 // is wholly unreachable on its OWN axis, but its OTHER axis sits well
 // inside reachable range - a union taken before clipping fabricates a huge
 // box neither outlier's reachable extent supports (the bug the combined-
 // bbox clamp got wrong). Per-stroke clipping must make both contribute
 // nothing: same zoom AND same visible painted-pixel count as the body alone.
 const bodyOnly=await call(p,"setup","body-only","reachable-body-only");
 const bodyFit=await call(p,"fitVisible","body-only");expect(bodyFit.result).toBe("fit");framed(bodyFit);
 const mixed=await call(p,"setup","disjoint","disjoint");expect(mixed.strokes).toHaveLength(3);
 const mixedFit=await call(p,"fitVisible","disjoint");expect(mixedFit.result).toBe("fit");
 expect(mixedFit.strokes).toEqual(mixed.strokes);expect(mixedFit.writes).toBe(mixed.writes);
 expect(mixedFit.state.zoom).toBe(bodyFit.state.zoom);
 expect(mixedFit.visiblePainted).toBe(bodyFit.visiblePainted);
 expect(mixedFit.visiblePainted).toBe(88); // measured in this harness; R2's independent harness reported 84 for the equivalent body
 const body=mixedFit.ink.find((s:any)=>s.id==="body")!;
 expect(body.x).toBeGreaterThanOrEqual(mixedFit.viewport.x-.5);expect(body.y).toBeGreaterThanOrEqual(mixedFit.viewport.y-.5);
 expect(body.right).toBeLessThanOrEqual(mixedFit.viewport.x+mixedFit.viewport.width+.5);expect(body.bottom).toBeLessThanOrEqual(mixedFit.viewport.y+mixedFit.viewport.height+.5);
 for(const id of ["outlierLeftBelow","outlierRightAbove"]){
  const outlier=mixedFit.ink.find((s:any)=>s.id===id)!;
  const outside=outlier.bottom<mixedFit.viewport.y-.5||outlier.right<mixedFit.viewport.x-.5||outlier.y>mixedFit.viewport.y+mixedFit.viewport.height+.5||outlier.x>mixedFit.viewport.x+mixedFit.viewport.width+.5;
  expect(outside).toBe(true);
 }
}finally{await p.close();}});
it("edge audit: ink wholly above the first line still lets a separate reachable body fit and paint",async()=>{const p=await mounted();try{
 // Unlike "negative" (wholly left of the origin, correctly unrepresentable),
 // this is the shape of Alan's real note: one stroke wholly above the first
 // line, one reachable stroke below it. The reachable one must still produce
 // "fit" and actually paint, not just compute a plausible-looking bbox.
 const bodyOnly=await call(p,"setup","negative-y-body-only","reachable-body-only");
 const bodyFit=await call(p,"fitVisible","negative-y-body-only");expect(bodyFit.result).toBe("fit");
 const original=await call(p,"setup","straddle","negative-y-with-body");expect(original.strokes).toHaveLength(2);
 const fitted=await call(p,"fitVisible","straddle");
 expect(fitted.result).toBe("fit");
 expect(fitted.strokes).toEqual(original.strokes);
 expect(fitted.writes).toBe(original.writes);
 expect(fitted.state.zoom).toBe(bodyFit.state.zoom);
 expect(fitted.visiblePainted).toBe(bodyFit.visiblePainted);
 expect(fitted.visiblePainted).toBe(88); // measured in this harness; R2's independent harness reported 84 for the equivalent body
}finally{await p.close();}});
it("edge audit: no ink resets zoom and scroll to empty's 100%/origin, distinct from ink that is wholly unreachable",async()=>{const p=await mounted();try{
 const emptyOriginal=await call(p,"setup","none","empty");expect(emptyOriginal.strokes).toHaveLength(0);
 // Move the camera away from (1, 0, 0) first, so asserting the reset below
 // actually proves recovery rather than restating the starting state.
 const zoomed=await edge(p,"zoom","none",2);expect(zoomed.accepted).toBe(true);expect(zoomed.state.zoom).toBe(2);
 const scrolled=await call(p,"scroll","none");
 expect(scrolled.after.scroll.left>0||scrolled.after.scroll.top>0).toBe(true);
 const emptyFit=await call(p,"fit","none");
 expect(emptyFit.result).toBe("empty");expect(emptyFit.state.zoom).toBe(1);expect(emptyFit.scroll.left).toBe(0);expect(emptyFit.scroll.top).toBe(0);
}finally{await p.close();}});
it("edge audit: two outliers disjoint on opposite axes with no body refuse rather than reset to empty",async()=>{const p=await mounted();try{
 const original=await call(p,"setup","unreachable2","wholly-unreachable-multi");expect(original.strokes).toHaveLength(2);
 const fitted=await call(p,"fit","unreachable2");
 expect(fitted.result).toBe("unrepresentable");
 expect(fitted.strokes).toEqual(original.strokes);
 expect(fitted.writes).toBe(original.writes);
 expect(fitted.state.zoom).toBe(original.state.zoom);
 expect(fitted.scroll).toEqual(original.scroll);
}finally{await p.close();}});
