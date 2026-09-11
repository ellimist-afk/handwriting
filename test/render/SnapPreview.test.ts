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
 const b=new StrokeBuilder('pen','#112233',3);b.start(0);
 for(let i=0;i<16;i++)b.add(100+i*8,100+i%2,0.5,i*8);
 const stroke=snapStroke(b.snapshotReleaseFiltered()[0],true);
 const preview=new SnapPreviewCanvas();
 window.previewCase=(zoom,backing)=>{
 const parent=document.getElementById('band');const cam={x:20,y:30,zoom};
 const visible=preview.show(parent,cam,stroke,800,600,backing);
 const canvas=parent.querySelector('canvas');
 const ref=document.createElement('canvas');ref.width=800*backing;ref.height=600*backing;
 const ctx=ref.getContext('2d');ctx.setTransform(backing,0,0,backing,0,0);drawStroke(ctx,cam,stroke,undefined,true,false);
 const left=parseFloat(canvas.style.left),top=parseFloat(canvas.style.top);
 const actual=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
 const expected=ctx.getImageData(left*backing,top*backing,canvas.width,canvas.height).data;
 let diff=0,paint=0;for(let i=0;i<actual.length;i++){if(actual[i]!==expected[i])diff++;if(i%4===3&&actual[i])paint++;}
 return {visible,diff,paint,width:canvas.width,height:canvas.height,left,top,pointer:getComputedStyle(canvas).pointerEvents,opacity:getComputedStyle(canvas).opacity};
 };
 window.clearPreview=()=>preview.clear();
 `,resolveDir:fileURLToPath(new URL('../../',import.meta.url)),loader:'ts'},bundle:true,write:false,format:'iife',platform:'browser',alias:{obsidian:fileURLToPath(new URL('../obsidian-stub.ts',import.meta.url))}});
 script=result.outputFiles[0]!.text;
});
afterAll(async()=>{await browser?.close();});
it.each([[0.5,1],[1,2],[2,3]])("uses normal stroke geometry at zoom%f/backing%i in a bounded canvas",async(zoom,backing)=>{
 const page=await browser.newPage({viewport:{width:900,height:700},deviceScaleFactor:backing});
 try {
  await page.setContent('<div id="scroll" style="height:400px;overflow:auto"><div id="band" style="position:relative;width:800px;height:600px"></div><div style="height:1200px"></div></div>');
  await page.addScriptTag({content:script});
  const result=await page.evaluate(([z,b])=>(window as any).previewCase(z,b),[zoom,backing]);
  expect(result.visible).toBe(true);expect(result.paint).toBeGreaterThan(0);expect(result.diff).toBe(0);
  expect(result.width).toBeLessThan(350*backing);expect(result.height).toBeLessThan(40*backing);
  expect(result.pointer).toBe('none');expect(result.opacity).toBe('0.45');
  const canvas=page.locator('.handwriting-snap-preview');const before=await canvas.boundingBox();
  await page.evaluate(()=>{document.getElementById('scroll')!.scrollTop=40;});
  const after=await canvas.boundingBox();expect(after!.y).toBeCloseTo(before!.y-40,5);
  await page.evaluate(()=>{(window as any).clearPreview();});expect(await canvas.count()).toBe(0);
 } finally {await page.close();}
});
