/**
 * The snap preview's reused canvas: a second show on the same SnapPreviewCanvas, after a larger figure (shrink: the canvas
 * is kept and cleared) or a smaller one (grow: the canvas is resized with room), in a pane narrow enough that the box is
 * kept inside the pane, left of the figure. The canvas pixels must equal a fresh full-pane draw of the last figure at the
 * box, and the whole figure must be inside the canvas. A preview drawn off its place would jump at the lift.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { launch, type Browser } from "./harness";

let browser: Browser;
let script: string;
beforeAll(async()=>{
 browser=await launch();
 const result=await build({stdin:{contents:`
 import {SnapPreviewCanvas} from './src/inline/SnapPreview';
 import {installObsidianDom} from './test/render/obsidianDom';
 installObsidianDom();
 import {StrokeBuilder} from './src/ink/StrokeBuilder';
 import {snapStroke} from './src/ink/ShapeSnap';
 import {drawStroke} from './src/ink/StrokeRenderer';
 const line=(x0,step)=>{const b=new StrokeBuilder('pen','#112233',3);b.start(0);for(let i=0;i<16;i++)b.add(x0+i*step,100+i%2,0.5,i*8);return snapStroke(b.snapshotReleaseFiltered()[0],true);};
 const small=line(100,8),big=line(70,12);
 const W=260,H=600;
 window.reuseCase=(order,backing)=>{
  const parent=document.getElementById('band');const cam={x:20,y:30,zoom:1};
  const preview=new SnapPreviewCanvas();
  const seq=order==='shrink'?[big,small]:[small,big];
  let visible=true;for(const s of seq)visible=preview.show(parent,cam,s,W,H,backing)&&visible;
  const last=seq[seq.length-1];
  const canvas=parent.querySelector('canvas');
  const ref=document.createElement('canvas');ref.width=W*backing;ref.height=H*backing;
  const ctx=ref.getContext('2d');ctx.setTransform(backing,0,0,backing,0,0);drawStroke(ctx,cam,last,undefined,true,false);
  const left=parseFloat(canvas.style.left),top=parseFloat(canvas.style.top);
  const nat=Math.max(0,Math.floor((last.bbox.x-cam.x)*cam.zoom-2));
  const actual=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  const expected=ctx.getImageData(Math.round(left*backing),Math.round(top*backing),canvas.width,canvas.height).data;
  let diff=0,paint=0;for(let i=0;i<actual.length;i++){if(actual[i]!==expected[i])diff++;if(i%4===3&&actual[i])paint++;}
  const all=ctx.getImageData(0,0,ref.width,ref.height).data;let allPaint=0;for(let i=3;i<all.length;i+=4)if(all[i])allPaint++;
  const out={visible,diff,paint,allPaint,width:canvas.width,height:canvas.height,left,top,nat};
  preview.clear();
  return out;
 };
 `,resolveDir:fileURLToPath(new URL('../../',import.meta.url)),loader:'ts'},bundle:true,write:false,format:'iife',platform:'browser',alias:{obsidian:fileURLToPath(new URL('../obsidian-stub.ts',import.meta.url))}});
 script=result.outputFiles[0]!.text;
});
afterAll(async()=>{await browser?.close();});
it.each([["shrink",1],["shrink",2],["shrink",3],["grow",1],["grow",2],["grow",3]])("a reused snap preview canvas after a %s, at backing %i, shows the figure where a fresh draw puts it",async(order,backing)=>{
 const page=await browser.newPage({viewport:{width:900,height:700},deviceScaleFactor:backing as number});
 try {
  await page.setContent('<div id="band" style="position:relative;width:260px;height:600px"></div>');
  await page.addScriptTag({content:script});
  const r=await page.evaluate(([o,b])=>(window as any).reuseCase(o,b),[order,backing]);
  console.log("SNAP-REUSE "+order+" "+backing+" "+JSON.stringify(r));
  expect(r.visible,"premise: both shows drew").toBe(true);
  expect(r.left,"premise: the box was kept inside the pane, left of the figure").toBeLessThan(r.nat);
  expect(r.paint,"premise: the figure painted").toBeGreaterThan(0);
  expect(r.diff,"canvas pixels equal a fresh full-pane draw at the box").toBe(0);
  expect(r.paint,"the whole figure is inside the canvas").toBe(r.allPaint);
 } finally {await page.close();}
});
