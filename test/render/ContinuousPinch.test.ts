/**
 * Actual frame-paced touch moves must reuse the raster while fingers move.
 * The 950 production path fails these assertions with hundreds of backing
 * assignments and committed clears. Final coordinates and ink remain guarded.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("../../",import.meta.url));
let browser:Browser,bundle:string;
const timingResults:unknown[]=[];
declare const process: { env: Record<string, string | undefined> };
beforeAll(async()=>{
 browser=await chromium.launch({headless:true});
 bundle=(await build({entryPoints:[root+"test/render/zoomWrittenInkPage.ts"],bundle:true,write:false,format:"iife",platform:"browser",alias:{obsidian:root+"test/render/iphoneObsidianStub.ts"},plugins:process.env.HW_COMPOSITE_ALPHA_PLANT?[{name:'opaque-highlighter-control',setup(builder){builder.onLoad({filter:/src[\\/]inline[\\/]InkOverlay\.ts$/},args=>{const contents=readFileSync(args.path,'utf8'),needle='ctx.globalAlpha = opacity;ctx.drawImage';if(!contents.includes(needle))throw Error('missing composite plant target');return {loader:'ts',contents:contents.replace(needle,'ctx.globalAlpha = 1;ctx.drawImage')};});}}]:[]})).outputFiles[0]!.text;
});
afterAll(async()=>{if(process.env.HW_PINCH_TIMING)writeFileSync(process.env.HW_PINCH_TIMING,JSON.stringify(timingResults,null,2));await browser?.close();});
async function mount(page:Page,count:number,focus=false,desktop=false,mixed:boolean|'overlap'=false){
   await page.setContent("<body></body>");await page.addStyleTag({content:readFileSync(root+"styles.css","utf8")});
   await page.addStyleTag({content:`html,body{margin:0;width:100%;height:100%;overflow:hidden}body{display:flex}.drift-host{position:relative;display:flex;flex:1;min-width:0;min-height:0;height:480px;overflow:hidden}.drift-host .cm-editor{display:flex;flex:1;min-width:0;min-height:0;height:480px}.drift-host .cm-scroller{flex:1;min-height:0;overflow:auto}.drift-host .cm-content{padding:8px 0!important}.drift-host .cm-line{padding:0}`});
   // Installed Obsidian1.13.7 app.css: a column flex host and this three-class
   // editor rule outrank a two-class plugin flex:none rule, regardless of order.
   await page.addStyleTag({content:`.markdown-source-view.mod-cm6{height:100%;display:flex;flex-direction:column}.markdown-source-view.mod-cm6 .cm-editor{flex:1 1;min-height:0}.drift-host.markdown-source-view{height:480px}`});
   await page.addStyleTag({content:`.markdown-source-view.mod-cm6 .cm-sizer{display:flex;flex-direction:column;align-items:stretch;width:100%;min-height:100%}.markdown-source-view.mod-cm6 .cm-contentContainer{flex:1 1 auto;display:flex;align-items:stretch;overflow-x:visible}.markdown-source-view.mod-cm6 .cm-content{flex-basis:unset!important;width:0;min-height:unset}`});
   await page.addScriptTag({content:bundle});
   await page.evaluate(([count,focus,desktop,mixed])=>{if(desktop)(window as any).zoomDrift.desktopPlatform();return (window as any).zoomDrift.setup(focus?(window as any).zoomDrift.focusSeed():(window as any).zoomDrift.dense(count,mixed),true);},[count,focus,desktop,mixed]);
}
it('only marks empty raster layers blank through repeated draws and partial clears',async()=>{
 const page=await browser.newPage({viewport:{width:900,height:700}});
 try{await mount(page,0);const rows=await page.evaluate(()=>(window as any).zoomDrift.blankLifecycle());
  for(const row of rows)for(const layer of [row.wet,row.tail]){expect(layer.blank,row.name).toBe(['empty','cleared','full-clear'].includes(row.name));if(layer.blank)expect(layer.pixels,row.name).toBe(0);else expect(layer.pixels,row.name).toBeGreaterThan(0);}
 }finally{await page.close();}
});
// THE GUARD MUST REFUSE. The pinch composite accepts the five canvases only
// when they share one placement (the counter-scale canvasLayerBox writes on
// all of them below 1.0); an input whose transform, or whose transform-origin
// alone, differs from the target's would composite its pixels into the wrong
// place, so the composite is refused and every canvas stays visible. Plant:
// drop the `style.transform !== targetStyle.transform` clause in
// preparePinchComposite and the first case reads composite true.
for(const foreign of ['foreign-transform','foreign-origin','foreign-translate','foreign-rotate','foreign-scale'] as const)it(`refuses the pinch composite when one canvas has a ${foreign} at 0.1`,async()=>{
 const page=await browser.newPage({viewport:{width:900,height:700},deviceScaleFactor:2});
 try{
  await mount(page,250,false,false,'overlap');
  const state=(action:string)=>page.evaluate(a=>(window as any).zoomDrift.layerVisual(a.action,a.zoom),{action,zoom:.1});
  const before=await state('setup');expect(before.pixels[0]).toBeGreaterThan(0);expect(before.pixels[2]).toBeGreaterThan(0);
  await state(foreign);
  const preview=await state('preview');
  expect(preview.composite,`${foreign}: composite refused`).toBe(false);
  // The preview still hides BLANK layers on its own (a separate step from the
  // composite); what refusal guarantees is that every canvas holding ink stays
  // on screen instead of being folded into one raster.
  for(let i=0;i<5;i++)if(preview.pixels[i]>0)expect(preview.visible[i],`${foreign}: inked canvas ${i} stays visible`).toBe('visible');
  await state('foreign-restore');await state('restore');
  // Liveness: with the foreign placement gone the same preview composites.
  const again=await state('preview');expect(again.composite,`${foreign}: composite accepted once placement agrees`).toBe(true);
  await state('restore');
 }finally{await page.close();}
});
for(const [zoom,scaled] of [[.1,false],[.4,false],[1,false],[.1,true],[.4,true]] as const)it(`preserves composited mixed ink and restores layers before writes: zoom=${zoom}, scaled=${scaled}`,async()=>{
 const page=await browser.newPage({viewport:{width:900,height:700},deviceScaleFactor:2});
 try{
  await mount(page,250,false,false,'overlap');
  const state=(action:string)=>page.evaluate(a=>(window as any).zoomDrift.layerVisual(a.action,a.zoom),{action,zoom});
  const before=await state('setup');expect(before.pixels[0]).toBeGreaterThan(0);expect(before.pixels[2]).toBeGreaterThan(0);
  let original=await page.screenshot();const preview=await state(scaled?'scaled-preview':'preview');expect(preview.composite).toBe(true);expect(preview.blank[3]).toBe(false);
  if(process.env.HW_COMPOSITE_THIN_PLANT)await state('thin-gap-plant');
  const combined=await page.screenshot();
  if(scaled){const restored=await state('restore');expect(restored.originalHashes).toEqual(before.originalHashes);expect(restored.pixels[3]).toBe(0);original=await page.screenshot();}
  await state('background');const background=await page.screenshot();const captured=await state('background-restore');
  if(process.env.HW_LAYER_SHOTS){writeFileSync(`${process.env.HW_LAYER_SHOTS}-${zoom}-${scaled}-original.png`,original);writeFileSync(`${process.env.HW_LAYER_SHOTS}-${zoom}-${scaled}-combined.png`,combined);}
  const diff=await page.evaluate(async ({images,arms})=>{
   const pixels=async(src:string)=>{const image=new Image();image.src='data:image/png;base64,'+src;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d')!;ctx.drawImage(image,0,0);return ctx.getImageData(0,0,c.width,c.height).data;};
   const a=await pixels(images[0]!),b=await pixels(images[1]!),bg=await pixels(images[2]!);let max=0,changed=0,total=0,yellow=0,roiPixels=0,roiChanged=0,massA=0,massB=0,coreMax=0,corePixels=0,missing=0;
   const width=1800,height=1400,maskA=new Uint8Array(width*height),maskB=new Uint8Array(width*height),darkA=new Uint8Array(width*height),darkB=new Uint8Array(width*height);let darkMassA=0,darkMassB=0,missingDark=0,edgeDifferences=0;
   for(let i=0;i<a.length;i+=4){let da=0,db=0,diff=0;for(let c=0;c<3;c++){const d=Math.abs(a[i+c]!-b[i+c]!);max=Math.max(max,d);diff=Math.max(diff,d);if(d>2)changed++;total+=d;da=Math.max(da,Math.abs(a[i+c]!-bg[i+c]!));db=Math.max(db,Math.abs(b[i+c]!-bg[i+c]!));}if(a[i]!>a[i+2]!+30&&a[i+1]!>a[i+2]!+30)yellow++;maskA[i/4]=da>8?1:0;maskB[i/4]=db>8?1:0;if(maskA[i/4]!==maskB[i/4])edgeDifferences++;const ba=Math.max(0,(bg[i]!+bg[i+1]!-a[i]!-a[i+1]!)/2),bb=Math.max(0,(bg[i]!+bg[i+1]!-b[i]!-b[i+1]!)/2);darkA[i/4]=ba>8?1:0;darkB[i/4]=bb>8?1:0;darkMassA+=ba;darkMassB+=bb;if(da>2||db>2){roiPixels++;if(diff>2)roiChanged++;massA+=da;massB+=db;}}
   const near=(mask:Uint8Array,x:number,y:number)=>{for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(x+dx>=0&&x+dx<width&&y+dy>=0&&y+dy<height&&mask[(y+dy)*width+x+dx])return true;return false;};
   for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){const p=y*width+x;if(maskA[p]&&!near(maskB,x,y)||maskB[p]&&!near(maskA,x,y))missing++;if(darkA[p]&&!near(darkB,x,y)||darkB[p]&&!near(darkA,x,y))missingDark++;if(!maskA[p])continue;let flat=true;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)for(let c=0;c<3;c++)if(Math.abs(a[p*4+c]!-a[((y+dy)*width+x+dx)*4+c]!)>1)flat=false;if(flat){corePixels++;for(let c=0;c<3;c++)coreMax=Math.max(coreMax,Math.abs(a[p*4+c]!-b[p*4+c]!));}}
   const thinArms=arms.map((arm:{width:number;x0:number;x1:number;y:number})=>{
    const x0=Math.ceil(arm.x0*2),x1=Math.floor(arm.x1*2),y=Math.round(arm.y*2);let originalPresent=0,combinedPresent=0;
    for(let x=x0;x<=x1;x++){
     let originalInk=false,combinedInk=false;
     for(let dy=-3;dy<=3;dy++){const p=(y+dy)*width+x;originalInk ||= !!darkA[p];combinedInk ||= !!darkB[p];}
     if(originalInk)originalPresent++;if(combinedInk)combinedPresent++;
    }
    return {...arm,samples:x1-x0+1,originalPresent,combinedPresent};
   });
   return {thinArms,max,changed,mean:total/a.length,yellow,roiPixels,roiChanged,roiFraction:roiChanged/roiPixels,massRatio:massB/massA,coreMax,corePixels,missing,missingDark,darkMassRatio:darkMassB/darkMassA,edgeDifferences};
  },{images:[original.toString('base64'),combined.toString('base64'),background.toString('base64')],arms:captured.thinArms});
  timingResults.push({kind:'composite-pixels',zoom,scaled,diff});expect(diff.yellow).toBeGreaterThan(0);
  // Separate-layer filtering and filtering the combined preview differ at
  // interpolation edges. Keep the strict color check for flat interiors and
  // fixed scale; during scaling also require the same ink footprint and mass.
  expect(diff.corePixels).toBeGreaterThan(0);expect(diff.coreMax).toBeLessThanOrEqual(2);
  expect(diff.missing).toBe(0);expect(diff.missingDark).toBe(0);
  for(const arm of diff.thinArms){expect(arm.samples).toBeGreaterThan(20);expect(arm.originalPresent,`original ${arm.width}px arm`).toBe(arm.samples);expect(arm.combinedPresent,`preview ${arm.width}px arm`).toBe(arm.samples);}
  expect(Math.abs(diff.massRatio-1)).toBeLessThan(.02);expect(Math.abs(diff.darkMassRatio-1)).toBeLessThan(.02);
  if(!scaled){expect(diff.max).toBeLessThanOrEqual(2);expect(diff.changed).toBe(0);const restored=await state('restore');expect(restored.originalHashes).toEqual(before.originalHashes);expect(restored.pixels[3]).toBe(0);expect((await page.screenshot()).equals(original)).toBe(true);}
  if(scaled)return;
  for(const action of ['restore','tail','tail-clear','repaint','resize','wet-clear','wet','pen']){
   // The tail-clear arm paints its tail on the full surface: the composite takes a
   // full-size occupied tail only (a compact one is refused; see the cell below).
   await state('restore');if(action==='tail-clear'){await state('tail-full');await state('tail');}const active=await state('preview');if(action==='tail-clear'){expect(active.composite).toBe(true);expect(active.pixels[4]).toBeGreaterThan(0);}
   const after=await state(action);expect.soft(after.composite,action).toBe(false);expect.soft(after.visible.every((v:string)=>v==='visible'),action).toBe(true);
   if(action==='tail-clear'||action==='wet-clear'){expect.soft(after.pixels[3],action).toBe(0);expect.soft(after.blank[3],action).toBe(true);}
   if(action==='tail-clear')expect(after.pixels[4]).toBe(0);
   if(action!=='pen')expect(after.strokes,action).toBe(before.strokes);
   if(action==='wet'){expect(after.pixels[3]).toBeGreaterThan(0);expect(after.blank[3]).toBe(false);const fallback=await state('preview');expect(fallback.composite).toBe(false);expect(fallback.visible[3]).toBe('visible');await state('restore');const cleared=await state('wet-clear');expect(cleared.blank[3]).toBe(true);expect(cleared.pixels[3]).toBe(0);}
  }
 }finally{await page.close();}
});
it('refuses the pinch composite over a compact occupied tail and keeps every inked layer visible',async()=>{
 const page=await browser.newPage({viewport:{width:900,height:700},deviceScaleFactor:2});
 try{
  await mount(page,250,false,false,'overlap');
  const state=(action:string)=>page.evaluate(a=>(window as any).zoomDrift.layerVisual(a.action,a.zoom),{action,zoom:1});
  const before=await state('setup');expect(before.pixels[2]).toBeGreaterThan(0);
  const drawn=await state('tail');expect(drawn.pixels[4],'tail occupied').toBeGreaterThan(0);
  expect(drawn.tailBacking.w*drawn.tailBacking.h,'tail is compact').toBeLessThan(drawn.tailBacking.bandW*drawn.tailBacking.bandH);
  const original=await page.screenshot();
  const preview=await state('preview');
  expect(preview.composite,'composite refused over a compact tail').toBe(false);
  // Blank layers may hide for the preview, as they do on every pinch; no inked one may,
  // and the occupied tail least of all.
  for(let i=0;i<5;i++)if(preview.pixels[i]>0)expect(preview.visible[i],`inked canvas ${i} stays visible`).toBe('visible');
  expect(preview.visible[4],'the occupied compact tail stays visible').toBe('visible');
  expect((await page.screenshot()).equals(original),'the screen is unchanged').toBe(true);
  await state('restore');
 }finally{await page.close();}
});
for(const mixed of [false,true])it(`uses one visible raster during repeated low-zoom pinches, mixed=${mixed}`,async()=>{
 const page=await browser.newPage({viewport:{width:900,height:700},deviceScaleFactor:2});
 try{await mount(page,90,false,false,mixed);
  for(const [startScale,ratio] of [[.1,4],[.4,.25]]){
   const r=await page.evaluate(a=>(window as any).zoomDrift.continuousPinch(a.ratio,false,true,false,{startScale:a.startScale,hover:true,moving:true}),{startScale,ratio});
   expect(r.liveDimensions.canvases.filter((c:any)=>c.visibility!=='hidden').length).toBe(1);
   expect(r.finalDimensions.canvases.every((c:any)=>c.visibility!=='hidden')).toBe(true);
   expect(r.before.strokes).toEqual(r.after.strokes);expect(r.before.saved).toBe(r.after.saved);
   // The pre-pinch scroll released the wet canvas. A pen-only pinch then writes no backing; a mixed note's composite
   // sizes the wet canvas once, at its start (width and height), and nothing else.
   expect(r.wetReleasedBefore,'premise: the scroll before the pinch released the wet canvas').toBe(true);
   expect(r.wetBackingWrites,'wet canvas backing writes in the live pinch').toBe(mixed?2:0);
   expect(r.backingWrites-r.wetBackingWrites,'other backing writes in the live pinch').toBe(0);expect(r.liveClears).toBe(0);expect(r.liveTransactions).toBe(0);
  }
 }finally{await page.close();}
});
// Native editor focus makes CodeMirror rewrite its complete root class attr.
// Window focus alone does not exercise this path. Synthetic routed pen events
// below use actual hit testing; native device timing remains separate.
for(const [zoom,locked,focus,desktop] of [[.2,true,true,false],[.1,true,true,false],[.2,false,true,false],[.1,false,true,false],[.2,true,false,false],[.1,true,false,false],[.2,true,false,true],[.1,true,false,true]] as const){
 it(`retains viewport through editor focus: zoom=${zoom}, locked=${locked}, focus=${focus}, desktop=${desktop}`,async()=>{
  const page=await browser.newPage({viewport:{width:900,height:700}});
  try{
   await mount(page,0,true,desktop);
   const r=await page.evaluate(([z,l,f])=>(window as any).zoomDrift.editorFocus(z,l,f),[zoom,locked,focus]);
   for(const state of [r.focused,r.blurred,r.refocused,r.after]){
    expect.soft(state.viewportClass).toBe(true);
    expect.soft(Math.abs(state.height-state.paneHeight)).toBeLessThan(.1);
    expect.soft(state.hit).toBe(true);
    expect.soft(state.scale).toBe(zoom);
   }
   expect(r.focused.locked).toBe(locked);expect(r.after.locked).toBe(false);
   expect(r.error).toBeNull();expect(r.oldUnchanged).toBe(true);expect(r.added).toBe(1);
  }finally{await page.close();}
 });
}
it("only contributes the viewport class while the overlay owns that layout",async()=>{
 const page=await browser.newPage({viewport:{width:900,height:700}});
 try{await mount(page,0);const r=await page.evaluate(()=>(window as any).zoomDrift.viewportOwnership());expect(r).toEqual({before:false,active:true,restored:false,detached:false});}
 finally{await page.close();}
});
for(const [count,target,cancel,dpr] of [[0,1.75,false,1],[250,1.75,true,2],[250,.75,false,1],[250,.75,true,2],[250,.322,false,1],[250,.322,true,2]] as const) {
 it(`reuses live raster: ${count} strokes, ${target} scale, cancel=${cancel}, DPR=${dpr}`,async()=>{
  const page=await browser.newPage({viewport:{width:900,height:700},deviceScaleFactor:dpr});
  try {
   await mount(page,count);
   const cdp=process.env.HW_PINCH_CPU||process.env.HW_PINCH_TRACE?await page.context().newCDPSession(page):null;
   if(process.env.HW_PINCH_CPU)await cdp!.send('Emulation.setCPUThrottlingRate',{rate:Number(process.env.HW_PINCH_CPU)});
   const traceEvents:unknown[]=[];
   if(process.env.HW_PINCH_TRACE){cdp!.on('Tracing.dataCollected',event=>traceEvents.push(...event.value));await cdp!.send('Tracing.start',{categories:'devtools.timeline,blink.user_timing,v8',options:'record-as-much-as-possible'});}
   const r=await page.evaluate(([target,cancel,measure,plant])=>(window as any).zoomDrift.continuousPinch(target,cancel,measure,plant),[target,cancel,!!process.env.HW_PINCH_TIMING,!!process.env.HW_PINCH_COST_PLANT]);
   if(process.env.HW_PINCH_TRACE){const complete=new Promise<void>(resolve=>cdp!.once('Tracing.tracingComplete',()=>resolve()));await cdp!.send('Tracing.end');await complete;writeFileSync(process.env.HW_PINCH_TRACE,JSON.stringify(traceEvents));}
   if(r.timing){timingResults.push({count,target,cancel,dpr,cpu:Number(process.env.HW_PINCH_CPU||1),plant:!!process.env.HW_PINCH_COST_PLANT,timing:r.timing,backingWrites:r.backingWrites,liveClears:r.liveClears,liveTransactions:r.liveTransactions});expect(r.timing.previews.length).toBeGreaterThan(30);if(process.env.HW_PINCH_COST_PLANT)expect(r.timing.methods.applyPreviewInkOffset.maxMs).toBeGreaterThanOrEqual(8);}
   expect.soft(r.backingWrites).toBe(0);expect.soft(r.liveClears).toBe(0);expect.soft(r.liveTransactions).toBe(0);
   expect(r.finalTransactions).toBe(1);
   expect(r.liveScale).toBeCloseTo(target,4);expect(r.finalScale).toBeCloseTo(target,4);
   expect(r.columnAfter).toBe(r.columnBefore);
   expect(r.liveAnchors.length).toBeGreaterThan(30);
   // Natural left/top origins win only where the original focal request is
   // unreachable. Both shifts come from independent zero-scroll DOM geometry;
   // raw errors and the older native-range shortfall remain observable below.
   for(const a of r.liveAnchors){expect(Math.abs(a.x-a.naturalBoundaryX)).toBeLessThan(2);expect(Math.abs(a.y-a.boundaryY)).toBeLessThan(2);expect(a.column).toBe(r.columnBefore);}
   // ...and the allowance dropped above was worth more than the threshold, so
   // dropping it tightened the arm instead of restating it.
   if(target<.5)expect.soft(Math.max(...r.liveAnchors.map((a:any)=>Math.abs(a.boundaryX))),"scroll clamp shortfall").toBeGreaterThan(2);
   expect.soft(Math.max(...r.liveAnchors.map((a:any)=>Math.abs(a.viewportWidth-r.pane.width)))).toBeLessThan(.1);
   expect.soft(Math.max(...r.liveAnchors.map((a:any)=>Math.abs(a.viewportHeight-r.pane.height)))).toBeLessThan(.1);
   expect.soft(Math.abs(r.viewport.width-r.pane.width)).toBeLessThan(.1);
   expect.soft(Math.abs(r.viewport.height-r.pane.height)).toBeLessThan(.1);
   expect(Math.abs(r.anchorError.x-r.anchorError.naturalBoundaryX)).toBeLessThan(2);expect(Math.abs(r.anchorError.y-r.anchorError.boundaryY)).toBeLessThan(2);
   expect(r.after.strokes).toEqual(r.before.strokes);expect(r.after.saved).toBe(r.before.saved);
   if(count)expect(r.pixels.black.count).toBeGreaterThan(0);
  }finally{await page.close();}
 });
}
for(const cancel of [false,true]){
 it(`covers immediate held ink after a pending pinch, cancel=${cancel}`,async()=>{
  const results=[];
  for(const measured of [false,true]){
   const page=await browser.newPage({viewport:{width:900,height:700}});
   try{
    await mount(page,0);
    const r=await page.evaluate(([measured,cancel])=>(window as any).zoomDrift.pendingPinchPen(measured,cancel),[measured,cancel]);
    expect(r.before.top).toBeLessThanOrEqual(0);expect(r.before.bottom).toBeGreaterThanOrEqual(0);
    expect(r.held.locked).toBe(true);expect(r.held.bluePixels).toBeGreaterThan(0);
    expect(r.held.band).toEqual(r.before.band);
    expect(r.held.top).toBeLessThanOrEqual(0);expect(r.held.bottom).toBeGreaterThanOrEqual(0);
    results.push(r);
   }finally{await page.close();}
  }
  // The unmeasured and measured paths must put the pen on the same note point.
  // Three decimals, not five: the settle re-derives the residual pan after each
  // of its scroll writes, and the two paths take a different number of those, so
  // the pan they end on differs in its last decimals - measured at 1.4e-5 painted
  // px, which is 4.4e-5 note px at this scale. A real divergence between the two
  // paths is a frame apart, not a rounding apart: before the pen mapping was
  // corrected for the pan this same pair sat 842 note px from the contact.
  expect(results[0].stroke.points[0].x).toBeCloseTo(results[1].stroke.points[0].x,3);
  expect(results[0].stroke.points[0].y).toBeCloseTo(results[1].stroke.points[0].y,3);
 });
}
for(const changed of [false,true])for(const zoom of [.322,.1]){
 it(`restores visible ink and contact targets after focus, resized=${changed}, zoom=${zoom}`,async()=>{
  const page=await browser.newPage({viewport:{width:900,height:700}});
  try{
   await mount(page,0,true);
   const r=await page.evaluate(([changed,zoom])=>(window as any).zoomDrift.focusReturn(changed,zoom),[changed,zoom]);
   expect(r.before.black).toBeGreaterThan(0);expect(r.hidden.valid).toBe(false);expect(r.hidden.width).toBe(0);
   expect(r.hidden.cachedColumn).toBe(r.before.cachedColumn);expect(r.hidden.styleDirty).toBe(true);
   expect(r.scheduled).toBe(true);expect(r.returns.length).toBeGreaterThan(0);
   for(const state of r.returns){
    expect.soft(state.valid).toBe(true);expect.soft(state.viewportClass).toBe(true);
    expect.soft(Math.abs(state.viewport.width-state.pane.width)).toBeLessThan(.1);
    expect.soft(Math.abs(state.viewport.height-state.pane.height)).toBeLessThan(.1);
    expect.soft(state.width).toBeGreaterThan(0);expect.soft(state.height).toBeGreaterThan(0);
   }
   expect(r.contact.hit).toBe(true);expect(r.contact.black).toBeGreaterThan(0);expect(r.error).toBeNull();
   expect(r.after.scale).toBeCloseTo(zoom*1.5,4);expect(r.bytesAfter).toBe(r.bytesBefore);expect(r.after.styleDirty).toBe(false);
  }finally{await page.close();}
 });
}
