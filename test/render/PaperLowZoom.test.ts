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
it("paper accounts external CSS once, ignores font zoom, isolates swatches and restores inline values",async()=>{
 const p=await browser.newPage({viewport:{width:1400,height:1100}});try{
 await p.setContent('<!doctype html><body class="handwriting-paper-grid" style="--background-modifier-border:#777"></body>');await p.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await p.addScriptTag({content:script});
 // Keep the font/external-scale Fit inside the 10% floor so spacing is actually recomputed.
 await p.evaluate(async()=>{await (window as any).viewportFixture.setup("scaled","paper-scaled",1,.8);await (window as any).viewportFixture.font("scaled");const host=document.querySelector(".cm-editor") as HTMLElement;host.style.setProperty("--handwriting-paper-pitch","31px","important");host.style.setProperty("--handwriting-paper-rule","2px","important");const swatch=host.appendChild(document.createElement("div"));swatch.className="handwriting-paper-swatch";swatch.dataset.paper="grid";});
 await p.getByRole("button",{name:"Fit handwriting",exact:true}).click();await p.evaluate(()=>(window as any).viewportFixture.settle());
 const s=await p.evaluate(()=>{const host=document.querySelector(".cm-editor") as HTMLElement;const zoom=(window as any).viewportFixture.snap("scaled").state.zoom;return {zoom,pitch:parseFloat(host.style.getPropertyValue("--handwriting-paper-pitch")),rule:parseFloat(host.style.getPropertyValue("--handwriting-paper-rule")),swatch:getComputedStyle(document.querySelector(".handwriting-paper-swatch")!).backgroundImage};});expect(s.zoom).toBeGreaterThanOrEqual(.1);expect(s.zoom).toBeLessThan(.3);expect(s.pitch*s.zoom*.8).toBeGreaterThanOrEqual(28);expect(s.pitch*s.zoom*.8).toBeLessThan(56);expect(s.rule*s.zoom*.8).toBeCloseTo(1,3);expect(s.swatch).toContain("28px");
 const disposed=await p.evaluate(()=>(window as any).viewportFixture.dispose("scaled"));expect(disposed.style).toContain("--handwriting-paper-pitch: 31px !important");expect(disposed.style).toContain("--handwriting-paper-rule: 2px !important");
 }finally{await p.close();}
});
it.each(["lines","grid"])("paper %s stays sparse through zoom/Fit/reset and preserves dots",async kind=>{
 const p=await browser.newPage({viewport:{width:700,height:540}});try{
 await p.setContent(`<!doctype html><body class="handwriting-paper-${kind}" style="--background-modifier-border:#777; background:white"></body>`);await p.addStyleTag({content:css+readFileSync(fileURLToPath(new URL("./noteViewportCamera.css",import.meta.url)),"utf8")});await p.addScriptTag({content:script});
 const original=await p.evaluate(()=>(window as any).viewportFixture.setup("paper"));
 const sample=()=>p.evaluate(()=>{const sc=document.querySelector(".cm-scroller")!;const s=getComputedStyle(sc);return {image:s.backgroundImage,size:s.backgroundSize,attachment:s.backgroundAttachment,position:s.backgroundPosition,zoom:(window as any).viewportFixture.snap("paper").state.zoom};});
 for(const mode of ["normal","half","quarter","fit","reset"]){
 if(mode==="half"||mode==="quarter")await p.getByRole("button",{name:"Zoom out",exact:true}).click();
 if(mode==="fit")await p.getByRole("button",{name:"Fit handwriting",exact:true}).click();
 if(mode==="reset")await p.getByRole("button",{name:"Reset note zoom to 100%",exact:true}).click();
 await p.evaluate(()=>(window as any).viewportFixture.settle());const s=await sample();const nums=[...s.image.matchAll(/([\d.]+)px/g)].map(m=>Number(m[1]));const pitch=nums.at(-1)!;expect(pitch*s.zoom).toBeGreaterThanOrEqual(27.99);expect(pitch*s.zoom).toBeLessThan(56.01);expect((pitch-nums.at(-2)!)*s.zoom).toBeCloseTo(1,2);
 if(mode==="normal"||mode==="reset")expect(pitch).toBe(28);
 if(mode==="fit"&&process.env.HW_PAPER_SCREENSHOT)await p.screenshot({path:process.env.HW_PAPER_SCREENSHOT.replace(".png",`-${kind}.png`)});
 }
 await p.getByRole("button",{name:"Fit handwriting",exact:true}).click();await p.evaluate(()=>(window as any).viewportFixture.settle());const beforePan=await sample();await p.evaluate(()=>(window as any).viewportFixture.scroll("paper"));expect((await sample()).position).toBe(beforePan.position);expect((await sample()).attachment).toContain("local");
 await p.evaluate(()=>{document.body.className="handwriting-paper-dots";});expect((await sample()).size).toBe("28px 28px");
 const end=await p.evaluate(()=>(window as any).viewportFixture.snap("paper"));expect(end.strokes).toEqual(original.strokes);expect(end.writes).toBe(original.writes);
 await p.evaluate(kind=>{document.body.className=`handwriting-paper-${kind}`;},kind);expect((await sample()).image).toBe(beforePan.image);await p.evaluate(()=>(window as any).viewportFixture.reopen("paper"));const reopened=await sample();expect(reopened.zoom).toBe(1);expect(reopened.image).toContain("28px");
 }finally{await p.close();}
 });
