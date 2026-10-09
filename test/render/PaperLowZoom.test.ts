import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import css from "../../styles.css?raw";
declare const process:{env:Record<string,string|undefined>};
let browser:Browser,script:string;
beforeAll(async()=>{const b=await build({entryPoints:[fileURLToPath(new URL("./noteViewportCameraPage.ts",import.meta.url))],bundle:true,write:false,format:"iife",platform:"browser",alias:{obsidian:fileURLToPath(new URL("./iphoneObsidianStub.ts",import.meta.url))}});script=b.outputFiles[0]!.text;browser=await chromium.launch({headless:true});});
afterAll(async()=>{await browser?.close();});
// The paper scales with the text, not with the zoom: the host's CSS zoom and an
// external scale scale the gradient for free, so the overlay plans a pitch of
// 28 x the text's size over 16 px whatever the zoom. Only the thickness takes
// the zoom, floored at one device px (a dot's radius at sqrt(2)/2). These cells
// were written against the previous design's power-of-two levels (pitch * zoom
// pinned in a screen window) and were revised to that contract.
it("the pitch follows the text size and ignores zoom and external CSS scale; the rule floors at a device px; swatches keep their own pitch",async()=>{
 const p=await browser.newPage({viewport:{width:1400,height:1100}});try{
 await p.setContent('<!doctype html><body class="handwriting-paper-grid" style="--background-modifier-border:#777"></body>');await p.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await p.addScriptTag({content:script});
 // 24 px text under an external scale of 0.8, then Fit, which lands between 10% and 30%.
 await p.evaluate(async()=>{await (window as any).viewportFixture.setup("scaled","paper-scaled",1,.8);await (window as any).viewportFixture.font("scaled");const host=document.querySelector(".cm-editor") as HTMLElement;const swatch=host.appendChild(document.createElement("div"));swatch.className="handwriting-paper-swatch";swatch.dataset.paper="grid";});
 await p.getByRole("button",{name:"Fit handwriting",exact:true}).click();await p.evaluate(()=>(window as any).viewportFixture.settle());
 const s=await p.evaluate(()=>{const host=document.querySelector(".cm-editor") as HTMLElement;const zoom=(window as any).viewportFixture.snap("scaled").state.zoom;return {zoom,dpr:window.devicePixelRatio,pitch:host.style.getPropertyValue("--handwriting-paper-pitch"),rule:host.style.getPropertyValue("--handwriting-paper-rule"),swatch:getComputedStyle(document.querySelector(".handwriting-paper-swatch")!).backgroundImage};});
 expect(s.zoom,"premise: Fit zoomed out").toBeGreaterThanOrEqual(.1);expect(s.zoom).toBeLessThan(.3);
 expect(s.pitch,`the pitch at 24 px text, whatever the zoom (${s.zoom}) and the external 0.8`).toBe("42px");
 expect(Number.parseFloat(s.rule),`the rule: the 1.5 px literal, floored at 1 + 1/64 device px at zoom ${s.zoom} x 0.8, dpr ${s.dpr}`).toBeCloseTo(1.5*s.zoom*.8*s.dpr>=1?1.5:(1+1/64)/(s.zoom*.8*s.dpr),3);
 expect(s.swatch).toContain("28px");
 }finally{await p.close();}
});
it("a host's own paper values are never replaced, through a font change, Fit and teardown",async()=>{
 const p=await browser.newPage({viewport:{width:1400,height:1100}});try{
 await p.setContent('<!doctype html><body class="handwriting-paper-grid" style="--background-modifier-border:#777"></body>');await p.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await p.addScriptTag({content:script});
 await p.evaluate(async()=>{await (window as any).viewportFixture.setup("scaled","paper-scaled",1,.8);const host=document.querySelector(".cm-editor") as HTMLElement;host.style.setProperty("--handwriting-paper-pitch","31px","important");host.style.setProperty("--handwriting-paper-rule","2px","important");await (window as any).viewportFixture.font("scaled");});
 await p.getByRole("button",{name:"Fit handwriting",exact:true}).click();await p.evaluate(()=>(window as any).viewportFixture.settle());
 const s=await p.evaluate(()=>{const host=document.querySelector(".cm-editor") as HTMLElement;const read=(k:string)=>[host.style.getPropertyValue(k),host.style.getPropertyPriority(k)];return {zoom:(window as any).viewportFixture.snap("scaled").state.zoom,pitch:read("--handwriting-paper-pitch"),rule:read("--handwriting-paper-rule")};});
 expect(s.zoom,"premise: Fit zoomed out").toBeLessThan(.3);
 expect(s.pitch,"the host's pitch after a font change and Fit").toEqual(["31px","important"]);expect(s.rule,"the host's rule after a font change and Fit").toEqual(["2px","important"]);
 const disposed=await p.evaluate(()=>(window as any).viewportFixture.dispose("scaled"));expect(disposed.style).toContain("--handwriting-paper-pitch: 31px !important");expect(disposed.style).toContain("--handwriting-paper-rule: 2px !important");
 }finally{await p.close();}
});
it.each(["lines","grid"])("paper %s keeps its planned pitch and rule through zoom/Fit/reset and preserves dots",async kind=>{
 const p=await browser.newPage({viewport:{width:700,height:540}});try{
 await p.setContent(`<!doctype html><body class="handwriting-paper-${kind}" style="--background-modifier-border:#777; background:white"></body>`);await p.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await p.addScriptTag({content:script});
 const original=await p.evaluate(()=>(window as any).viewportFixture.setup("paper"));
 const sample=()=>p.evaluate(()=>{const sc=document.querySelector(".cm-scroller")!;const s=getComputedStyle(sc);return {image:s.backgroundImage,size:s.backgroundSize,attachment:s.backgroundAttachment,position:s.backgroundPosition,zoom:(window as any).viewportFixture.snap("paper").state.zoom};});
 for(const mode of ["normal","half","quarter","fit","reset"]){
 if(mode==="half"||mode==="quarter")await p.getByRole("button",{name:"Zoom out",exact:true}).click();
 if(mode==="fit")await p.getByRole("button",{name:"Fit handwriting",exact:true}).click();
 if(mode==="reset")await p.getByRole("button",{name:"Reset note zoom to 100%",exact:true}).click();
 // The "to bottom" gradient, the one the phase moves: every stop carries a
 // position, clear from the phase to the rule and the rule up to phase + pitch,
 // so the pitch is its last stop less its first and the rule its last less the
 // one before. The zoom scales both on screen; in layout px they stay put.
 await p.evaluate(()=>(window as any).viewportFixture.settle());const s=await sample();const bottom=s.image.split("repeating-linear-gradient(")[1]!;const nums=[...bottom.matchAll(/([\d.]+)px/g)].map(m=>Number(m[1]));
 expect(nums.at(-1)!-nums[0]!,`[${mode}] zoom ${s.zoom}: pitch from the to-bottom gradient's stops (serialised to 6 significant digits): ${s.image}`).toBeCloseTo(28,3);
 expect(nums.at(-1)!-nums.at(-2)!,`[${mode}] zoom ${s.zoom}: rule from the to-bottom gradient's stops, one px, and 1 + 1/64 device px where one px falls under one`).toBeCloseTo(s.zoom>=1?1:(1+1/64)/s.zoom,3);
 if(mode==="fit"&&process.env.HW_PAPER_SCREENSHOT)await p.screenshot({path:process.env.HW_PAPER_SCREENSHOT.replace(".png",`-${kind}.png`)});
 }
 await p.getByRole("button",{name:"Fit handwriting",exact:true}).click();await p.evaluate(()=>(window as any).viewportFixture.settle());const beforePan=await sample();await p.evaluate(()=>(window as any).viewportFixture.scroll("paper"));expect((await sample()).position).toBe(beforePan.position);expect((await sample()).attachment).toContain("local");
 await p.evaluate(()=>{document.body.className="handwriting-paper-dots";});expect((await sample()).size.split(", ").every(size=>size==="28px 28px"),"dots: every layer is one pitch square").toBe(true);
 const end=await p.evaluate(()=>(window as any).viewportFixture.snap("paper"));expect(end.strokes).toEqual(original.strokes);expect(end.writes).toBe(original.writes);
 await p.evaluate(kind=>{document.body.className=`handwriting-paper-${kind}`;},kind);expect((await sample()).image).toBe(beforePan.image);expect(original.state.zoom,"FIRST OPEN: a note never seen this session opens at 100 percent (issue 9)").toBe(1);await p.evaluate(async()=>{await (window as any).viewportFixture.reopen("paper");await (window as any).viewportFixture.settle();});const reopened=await sample();expect(reopened.zoom,"RETURN: the reopened note comes back at the zoom it was left at, the last Fit").toBeCloseTo(beforePan.zoom,10);const reopenedStops=[...reopened.image.split("repeating-linear-gradient(")[1]!.matchAll(/([\d.]+)px/g)].map(m=>Number(m[1]));expect(reopenedStops.at(-1)!-reopenedStops[0]!,`pitch after reopen, last stop less first of the phased to-bottom gradient: ${reopened.image}`).toBeCloseTo(28,3);
 }finally{await p.close();}
 });
// Dots: the same pitch and thickness as lines and grid, through a real 1.0 ->
// 0.1 pinch preview (read while the fingers are still down), its commit, a
// commit back at 100% and a change of the text size, for global dots and for a
// note set to dots under global lines. One dot per tile, one gradient layer,
// centred in the tile; the tile is one pitch square and
// follows the text (28 px, then 42 px at 24 px text); the dot's radius and soft
// edge come from the dot thickness (floored at sqrt(2)/2 device px at 10
// percent, then 1.5 px at 24 px text), and the soft edge stays inside half the
// tile, so no dot is cut at a tile edge. The tile's POSITION is the text's origin
// plus the text's pinch pan on each axis (the paper's origin is the text's, on
// both axes), revised on record from the old rule that pinned
// background-position-y to 0 when dots carried no phase.
it.each([["global dots","handwriting-paper-dots",""],["a note set to dots under global lines","handwriting-paper-lines","dots"]] as const)("dots (%s): one centred dot per pitch-square tile that follows the text, never cut at the tile edge, positioned on the text's origin through a preview, commit and font change",async(_label,bodyClass,noteKind)=>{
 const p=await browser.newPage({viewport:{width:700,height:540}});try{
 await p.setContent(`<!doctype html><body class="${bodyClass}" style="--background-modifier-border:#777; background:white"></body>`);await p.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await p.addScriptTag({content:script});
 await p.evaluate(()=>(window as any).viewportFixture.setup("dots-control"));
 // The per-note setting sits on an ancestor of the view: wrap the rig's host in one.
 if(noteKind)await p.evaluate(kind=>{const host=document.querySelector('[data-rig="dots-control"]')!;const note=document.createElement("div");note.dataset.handwritingPaper=kind;host.before(note);note.appendChild(host);},noteKind);
 const r=await p.evaluate(async()=>{
  const fx=(window as any).viewportFixture,scroller=document.querySelector(".cm-scroller")!,host=document.querySelector(".cm-editor") as HTMLElement;
  // During a preview the paper is the preview element: its tile carries the phase alone and its translate the pan.
  const read=()=>{const el=host.querySelector(":scope > .handwriting-paper-preview"),s=getComputedStyle(el??scroller),pan=(name:string)=>el?"0px":s.getPropertyValue(name);return {source:el?"element":"scroller",image:s.backgroundImage,size:s.backgroundSize,y:s.backgroundPositionY,x:s.backgroundPositionX,phase:host.style.getPropertyValue("--handwriting-paper-phase"),phaseX:host.style.getPropertyValue("--handwriting-paper-phase-x"),panX:pan("--handwriting-paper-pan-x"),panY:pan("--handwriting-paper-pan-y"),rule:host.style.getPropertyValue("--handwriting-paper-rule"),dot:host.style.getPropertyValue("--handwriting-paper-dot"),zoom:fx.snap("dots-control").state.zoom};};
  // edgeAudit.pinchBy's gesture (ViewportEdgeAudit.test.ts:55, R: 100 -> 10 px lands at the 10% floor), with a read between the move and the lift.
  const send=(type:string,id:number,x:number)=>{const t=document.elementFromPoint(x,250)!;if(!scroller.contains(t))throw Error("pinch outside editor");t.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:"touch",pointerId:id,isPrimary:id===701,clientX:x,clientY:250,buttons:type==="pointerup"?0:1,width:8,height:8}));};
  const before=read();
  send("pointerdown",701,250);send("pointerdown",702,350);send("pointermove",701,295);send("pointermove",702,305);await fx.settle();
  const live=read();
  send("pointerup",701,295);send("pointerup",702,305);await fx.settle();
  const after=read();
  await (window as any).edgeAudit.commit("dots-control",1);
  const reset=read();
  await fx.fontPx("dots-control",24);
  return {before,live,after,reset,font:read()};
 });
 const offset=(y:string)=>Number.parseFloat(y);
 const layers=(size:string)=>size.split(", ");
 // The radial layer's shape and position (a centred circle serialises with no "at") and its two stops (dot radius, soft edge).
 const dot=(image:string)=>{const first=image.split("radial-gradient(")[1]!;const head=first.split(",")[0]!.trim();const stops=[...first.matchAll(/\) (-?[\d.]+)px/g)].map(m=>Number(m[1]));return {head,stops};};
 const report=JSON.stringify(r);
 expect(r.before.image,`dots are the paper drawn; ${report}`).toContain("radial-gradient");expect.soft(r.before.image.match(/radial-gradient/g)?.length,`one dot layer; ${report}`).toBe(1);
 for(const [at,s,px] of [["before",r.before,28],["mid-preview",r.live,28],["after commit",r.after,28],["at 100%",r.reset,28],["at 24 px text",r.font,42]] as const){
  expect.soft(layers(s.size).every(l=>l===`${px}px ${px}px`),`[${at}] every layer ${px}px square: ${s.size}`).toBe(true);
  // Old rule: background-position-y 0. Now: phase + pan-y, and phase-x + pan-x across.
  const want=(phase:string,pan:string)=>(Number.parseFloat(phase)||0)+(Number.parseFloat(pan)||0);
  expect.soft(Math.abs(offset(s.y)-want(s.phase,s.panY)),`[${at}] background-position-y ${s.y} against phase ${s.phase} + pan-y ${s.panY}`).toBeLessThanOrEqual(1/64);
  expect.soft(Math.abs(offset(s.x)-want(s.phaseX,s.panX)),`[${at}] background-position-x ${s.x} against phase-x ${s.phaseX} + pan-x ${s.panX}`).toBeLessThanOrEqual(1/64);
  const radius=Number.parseFloat(s.dot),d=dot(s.image);
  expect.soft(d.stops.map(v=>Math.round(v*1e3)/1e3),`[${at}] dot radius and soft edge from the dot thickness ${s.dot}: ${s.image}`).toEqual([Math.round(radius*1e3)/1e3,Math.round(radius*1.5e3)/1e3]);
  expect.soft(d.head,`[${at}] the dot is a circle centred in its tile, with no position of its own: ${s.image}`).toBe("circle");
  expect.soft(radius*1.5,`[${at}] the dot's soft edge (1.5 x ${s.dot}) stays inside half the ${px} px tile, so no dot is cut at the tile edge`).toBeLessThanOrEqual(px/2);
 }
 expect(r.live.zoom,"preview reached the 10% floor before the lift").toBeCloseTo(.1,3);
 expect([r.before.source,r.live.source,r.after.source],"premise: the mid-preview read is the preview element, the others the scroller's own paper").toEqual(["scroller","element","scroller"]);
 expect(r.after.zoom,"committed at the 10% floor").toBeCloseTo(.1,3);
 expect(r.reset.zoom,"committed back at 100%").toBeCloseTo(1,3);
 expect(offset(r.after.dot)*1.5,`premise: at 10 percent the dot is floored well past its 1 px literal (got "${r.after.dot}"), so the edge check above reads a large dot`).toBeGreaterThan(5);
 }finally{await p.close();}
});
