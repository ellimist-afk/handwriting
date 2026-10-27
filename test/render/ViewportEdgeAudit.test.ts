import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import { MAX_PINCH_SCALE } from "../../src/inline/PinchScale";
import { withoutLineAnchor } from "./storedInk";
let browser:Browser,script:string;
beforeAll(async()=>{const b=await build({entryPoints:[fileURLToPath(new URL("./noteViewportCameraPage.ts",import.meta.url))],bundle:true,write:false,format:"iife",platform:"browser",alias:{obsidian:fileURLToPath(new URL("./iphoneObsidianStub.ts",import.meta.url))}});script=b.outputFiles[0]!.text;browser=await chromium.launch({headless:true});});
afterAll(async()=>{await browser?.close();});
async function mounted(){const p=await browser.newPage({viewport:{width:1400,height:1100}});await p.setContent("<!doctype html><body></body>");await p.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await p.addScriptTag({content:script});return p;}
const call=(p:Page,method:string,...args:unknown[])=>p.evaluate(([method,args])=>(window as any).viewportFixture[method](...args),[method,args] as const);
const edge=(p:Page,method:string,...args:unknown[])=>p.evaluate(([method,args])=>(window as any).edgeAudit[method](...args),[method,args] as const);
/** Every stroke the fixture holds left real ink on screen, not just one of them. */
function eachStrokePainted(s:any,where:string){
 expect(s.strokesPainted.length,`${where}: a stroke count to sample`).toBeGreaterThan(0);
 for(const stroke of s.strokesPainted) expect(stroke.painted,`${where}: stroke ${stroke.id} painted pixels (sampled=${stroke.sampled})`).toBeGreaterThan(0);
}
function framed(s:any){for(const b of s.ink){expect(b.x).toBeGreaterThanOrEqual(s.viewport.x-.5);expect(b.y).toBeGreaterThanOrEqual(s.viewport.y-.5);expect(b.right).toBeLessThanOrEqual(s.viewport.x+s.viewport.width+.5);expect(b.bottom).toBeLessThanOrEqual(s.viewport.y+s.viewport.height+.5);}}
it.each(["negative-width-padding","partial-negative-y"])("edge audit: reachable %s still fits and paints",async kind=>{const p=await mounted();try{
 const original=await call(p,"setup","partial",kind),fitted=await call(p,"fitVisible","partial");
 expect(kind==="negative-width-padding"?original.strokes[0].bbox.x:original.strokes[0].bbox.y).toBeLessThan(0);
 expect(fitted.result).toBe("fit");expect(fitted.visiblePainted).toBeGreaterThan(0);eachStrokePainted(fitted,kind);
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
 for(let i=0;i<3;i++){const smaller=await edge(p,"zoom","edge",.5);expect(smaller.accepted).toBe(true);}for(let i=0;i<2;i++){const limited=await edge(p,"zoom","edge",1e-9);expect(limited.accepted).toBe(true);expect(limited.state.zoom).toBe(.1);}const upper=await edge(p,"zoom","edge",1e9);expect(upper.state.zoom).toBe(MAX_PINCH_SCALE);expect((await edge(p,"zoom","edge",2)).state.zoom).toBe(MAX_PINCH_SCALE);
 for(let i=0;i<3;i++){await p.getByRole("button",{name:"Reset note zoom to 100%",exact:true}).click();await call(p,"settle");framed(await call(p,"fit","edge"));}
 const end=await call(p,"snap","edge");expect(withoutLineAnchor(end.strokes)).toEqual(withoutLineAnchor(original.strokes));expect(end.writes).toBe(original.writes);expect(end.history).toBe(original.history);
}finally{await p.close();}},20000);
// REVISED 2026-09-13, Alan: "when they hit fit it should allow the zoom to break
// the 10% clamp, but they cannot do it with pinch or manually". This test used to
// pin Fit's refusal ("unrepresentable" plus the 10% notice) for these kinds. Fit
// now commits below ten percent; the manual floor from 20% is still ten percent,
// and at Fit's scale manual zoom-out stops at Fit's scale while zoom-in works.
it.each(["below-minimum","former-far"])("Fit breaks the ten-percent floor for %s; manual paths keep it and cannot pass Fit's scale",async kind=>{const p=await mounted();try{
 const original=await call(p,"setup","floor",kind);
 const pinch=await edge(p,"floorPinch","floor");expect(pinch.live.state.zoom).toBe(.1);expect(pinch.after.state.zoom).toBe(.1);
 const before=await call(p,"snap","floor");const rejected=await edge(p,"commit","floor",.01);expect(rejected.accepted).toBe(false);expect(rejected.state.zoom).toBe(before.state.zoom);expect(rejected.scroll).toEqual(before.scroll);
 const fitted=await call(p,"fitVisible","floor");expect(fitted.result).toBe("fit");expect(fitted.state.zoom).toBeLessThan(.1);framed(fitted);expect(fitted.visiblePainted,"ink is painted on screen at Fit's scale").toBeGreaterThan(0);
 // Per stroke, not one bit for the note: at 0.43% and 1.9% a width-floor
 // regression would leave one stroke painting and the others invisible.
 eachStrokePainted(fitted,`${kind} at Fit's scale`);
 expect(withoutLineAnchor(fitted.strokes)).toEqual(withoutLineAnchor(original.strokes));expect(fitted.writes).toBe(original.writes);expect(fitted.history).toBe(original.history);
 const F=fitted.state.zoom;
 // Manual zoom-out at Fit's scale: the button clamps to F, a commit below F is refused, a pinch out holds F.
 expect((await edge(p,"zoom","floor",.5)).state.zoom).toBe(F);
 const under=await edge(p,"commit","floor",F*.9);expect(under.accepted).toBe(false);expect(under.state.zoom).toBe(F);
 const pinchedOut=await edge(p,"pinchBy","floor",100,10);expect(pinchedOut.live.state.zoom).toBe(F);expect(pinchedOut.after.state.zoom).toBe(F);
 // Hit-testable: the pen lands on the far stroke at Fit's scale, and undo puts it back.
 const erased=await edge(p,"eraseOutlier","floor");expect(erased.strokes,"the far stroke was hit at Fit's scale").toHaveLength(original.strokes.length-1);
 const undone=await edge(p,"history","floor","undo");expect(undone.accepted).toBe(true);expect(withoutLineAnchor(undone.strokes)).toEqual(withoutLineAnchor(original.strokes));
 // Manual zoom-in works from Fit's scale.
 const recovery=await edge(p,"zoom","floor",2);expect(recovery.state.zoom).toBe(F*2);
}finally{await p.close();}},20000);
// REVISED 2026-09-14, Alan: below ten percent zoom-out is locked; from Fit's scale
// a pinch, a button or a commit may zoom in but not back out, even to Fit's scale,
// until a committed scale is at ten percent again. Fit itself is always allowed.
it("Fit floor at six percent: in to 8% allowed, back to 6% and 5% refused, minus and a pinch out hold, 12% restores the floor to 10%",async()=>{const p=await mounted();try{
 const original=await call(p,"setup","six","fit-six");
 const fitted=await call(p,"fitVisible","six");expect(fitted.result).toBe("fit");framed(fitted);expect(fitted.visiblePainted).toBeGreaterThan(0);eachStrokePainted(fitted,"six percent");
 const F=fitted.state.zoom;expect(F,"the fixture fits near six percent").toBeGreaterThan(.055);expect(F).toBeLessThan(.065);
 const commit=(s:number)=>edge(p,"commit","six",s);
 const E=F*4/3;
 const eight=await commit(E);expect(eight.accepted).toBe(true);expect(eight.state.zoom).toBe(E);
 const back=await commit(F);expect(back.accepted,"zoom-out below 10% is locked, even back to Fit's scale").toBe(false);expect(back.state.zoom).toBe(E);
 const five=await commit(F*5/6);expect(five.accepted,"below Fit's scale is refused").toBe(false);expect(five.state.zoom).toBe(E);
 // A pane resize re-commits at the current scale; below the floor that re-commit
 // must still pass rather than being refused or snapping back to ten percent.
 const resized=await call(p,"resize","six");expect(resized.state.zoom,"the resize kept the scale below the floor").toBe(E);
 expect((await commit(E*.9)).accepted,"still refused after a resize re-commit").toBe(false);
 // Below the floor minus is a no-op, never a jump in to 10%, and a pinch out stays where it started.
 const minus=await edge(p,"zoom","six",.5);expect(minus.accepted).toBe(true);expect(minus.state.zoom,"minus below 10% holds").toBe(E);
 expect((await edge(p,"pinchBy","six",100,10)).after.state.zoom,"a pinch out below 10% holds where it started").toBe(E);
 // Zoom-in still works below the floor: a 1.125 step from 8% lands on 9%, not 10%.
 const step=await edge(p,"zoom","six",1.125);expect(step.accepted).toBe(true);expect(step.state.zoom).toBeCloseTo(F*1.5,12);
 // A small pinch in from 9% stays below the floor: zoom-in works there and does not jump to 10%.
 // 480 to 492 px: the router needs a 12 px spread change (PINCH_SLOP_PX) to count a pinch, and the ratio 1.025 keeps
 // 1.5 x 1.025 x F under 10% across the fixture's whole admitted Fit band (F < .065 gives < .09994).
 const pinchIn=await edge(p,"pinchBy","six",480,492);expect(pinchIn.after.state.zoom).toBeGreaterThan(step.state.zoom);expect(pinchIn.after.state.zoom,"a small pinch in stays below 10%").toBeLessThan(.1);
 // A pinch in that crosses 10% commits above it, and from there the floor is 10% again: a pinch out stops at 10%.
 const crossed=await edge(p,"pinchBy","six",100,160);expect(crossed.after.state.zoom,"the pinch in crossed the floor").toBeGreaterThan(.1);
 expect((await edge(p,"pinchBy","six",100,10)).after.state.zoom,"above 10% a pinch out stops at 10%").toBe(.1);
 // A committed 12% restores the ten-percent floor.
 const twelve=await commit(.12);expect(twelve.accepted).toBe(true);expect(twelve.state.zoom).toBe(.12);
 expect((await edge(p,"zoom","six",.5)).state.zoom,"after 12% the button stops at 10%").toBe(.1);
 const again=await commit(F);expect(again.accepted,"Fit's old scale is no longer reachable by hand").toBe(false);expect(again.state.zoom).toBe(.1);
 expect((await edge(p,"pinchBy","six",100,10)).after.state.zoom,"a pinch out stops at 10% again").toBe(.1);
 // Fit is still the way back down. The pane was resized smaller above, so Fit
 // frames the same ink at a SMALLER scale than F, and zoom-out is locked there again.
 const refit=await call(p,"fit","six");expect(refit.result).toBe("fit");expect(refit.state.zoom).toBeLessThan(F);expect(refit.state.zoom).toBeLessThan(.1);
 expect((await commit(refit.state.zoom*.9)).accepted,"below Fit's new scale is refused").toBe(false);
 const end=await call(p,"snap","six");expect(withoutLineAnchor(end.strokes)).toEqual(withoutLineAnchor(original.strokes));expect(end.writes).toBe(original.writes);expect(end.history).toBe(original.history);
}finally{await p.close();}},20000);
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
 // The exact receipted configuration: one outlier left-and-below the origin
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
 expect(mixedFit.visiblePainted).toBe(88); // measured in this harness; an independent harness reported 84 for the equivalent body
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
 expect(fitted.visiblePainted).toBe(88); // measured in this harness; an independent harness reported 84 for the equivalent body
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
