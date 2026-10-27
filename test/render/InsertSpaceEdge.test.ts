/** An insert-space drag from a line inside a tall drawing that runs above the ink band makes its picture once.
 *
 * What it looked like: with the line near the top of the screen inside a drawing tall enough to run above the ink band (the
 * canvases sit in the scroller as a band from the viewport's top minus a margin to its bottom plus one), every sample of a
 * downward drag made the drag's picture again (a new canvas, then a raster of all the moving ink on screen) until the drag had
 * moved as far as the drawing ran above the band. The picture now holds the rows above the band and rasters them only as the
 * drag reveals them, a chunk at a time.
 *
 * Both cells use InsertSpacePrecision's tall fixture and 40 moves of 2 css px down. "tower": the tall stroke runs world y 50 to
 * 1050 (midpoint 550), a short stroke at world y 3000 lets the note scroll, the pane is scrolled to 400 and the pen goes down at
 * world 400, so the band's top (the margin above the pane) is below the drawing's top. "short" is the control: the stroke runs
 * 50 to 190, scroll 100, the pen at 119; the band's margin covers the drawing, and one picture served before the fix as well.
 * HW_ISE_OUT=<file> writes each cell's probe result as JSON (<file>.<cell>.json) before the assertions.
 */
import {beforeAll,afterAll,it,expect} from "vitest";
import {build} from "esbuild";
import {fileURLToPath} from "node:url";
import {readFileSync,writeFileSync} from "node:fs";
import {chromium,type Browser} from "playwright";
declare const process:{env:Record<string,string|undefined>};
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

/** The picture's row raster chunk (SPACE_ROWS_CHUNK in InkOverlayLassoSpace.ts). */
const CHUNK=64;
/** The most a premultiplied channel may differ between the tail with the picture as the drag built it (its rows rastered in
 * chunks, each under its own clip) and with the same window rastered again in one pass: this backend's antialiasing moves with
 * the clip a stroke is drawn under. Measured on the tower cell: 13 levels at 2 px, 5 or 6 at 168 px, under 4 elsewhere. A row
 * placed one off or rastered twice differs by far more. */
const CLIP_LEVELS=16;
const CELLS=[
 {name:"tower",scroll:400,contactY:400,options:{tallBottom:1050,room:3000},aboveBand:true},
 {name:"short",scroll:100,contactY:119,options:{},aboveBand:false},
] as const;

it.each(CELLS)("makes the picture once for a downward drag from a line inside a tall drawing: $name",async cell=>{
 const page=await mounted();try{
  const moves=Array.from({length:40},(_,i)=>2*(i+1));
  const r=await page.evaluate(([moves,c])=>(window as any).insertSpaceProbe(1,1,c.scroll,false,{shortText:"",tall:true,contactY:c.contactY,...c.options,moves,dy:80,pictures:true}),[moves,cell] as const);
  if(process.env.HW_ISE_OUT)writeFileSync(`${process.env.HW_ISE_OUT}.${cell.name}.json`,JSON.stringify({scroll:r.before.scroll,scale:r.scale,origin:r.origin,contact:r.contact,pictures:r.pictures,moves:r.moves.map((m:any)=>({dy:m.dy,total:m.total,pictures:m.pictures})),down:r.down.ids,cut:r.down.cut},null,1));
  const p=r.pictures,k=p.down.cam.zoom*p.down.backing;
  // The premise: the pen down on the line, the tall stroke moving, the moving box's top above the band's top (the tail's row 0)
  // in the tower and below it in the control.
  expect(r.down.cut).toBeCloseTo(cell.contactY,6);
  expect(r.down.ids).toContain("tall");
  expect(p.down.box.y<p.down.cam.y).toBe(cell.aboveBand);
  expect(p.down.picture).toBe(1);
  // Each move: the offset follows the pen and the picture made at pen-down still serves.
  for(const move of r.moves){
   expect(move.total).toBeCloseTo(move.dy,6);
   expect(move.pictures.picture,`pictures after the move to ${move.dy}`).toBe(1);
  }
  // Row rasters: the pen-down one, then the rows the drag reveals above the band a chunk at a time. The drag reveals at most
  // its own offset in rows.
  expect(r.moves.at(-1).pictures.rows).toBeLessThanOrEqual(Math.ceil(Math.round(80*k)/CHUNK)+1);
  // The look: the tail with the picture as the drag built it, against the same window rastered again in one pass.
  if(cell.aboveBand)expect(p.look.inkedRevealed).toBeGreaterThan(0);
  expect(p.look.maxPremult).toBeLessThanOrEqual(CLIP_LEVELS);
  // The release moves the moving strokes by exactly the drag and nothing else.
  expect(r.after.strokes.map((s:any)=>s.id)).toEqual(r.before.strokes.map((s:any)=>s.id));
  for(let i=0;i<r.before.strokes.length;i++){
   const dy=r.down.ids.includes(r.before.strokes[i].id)?80:0;
   expect(r.after.strokes[i].points).toEqual(r.before.strokes[i].points.map((q:any)=>({...q,y:q.y+dy})));
  }
 }finally{await page.close();}
});

it("makes the picture lazily: at pen-down the low cursor sits at the canvas top and no row above the band is rastered",async()=>{
 const cell=CELLS[0],page=await mounted();try{
  const r=await page.evaluate(([c])=>(window as any).insertSpaceProbe(1,1,c.scroll,false,{shortText:"",tall:true,contactY:c.contactY,...c.options,moves:[2],dy:80,pictures:true}),[cell] as const);
  const down=r.pictures.down,s=down.state;
  // The premise: the box runs above the band, so the picture's top is above the canvas's row 0.
  expect(down.box.y<down.cam.y,"premise: the moving box's top is above the band's top").toBe(true);
  expect(s.top,"premise: the picture's window starts above the canvas top").toBeLessThan(0);
  // At pen-down the offset is 0: the low cursor is the canvas top, not the window's top, and what was rastered is the band's rows.
  expect(s.lo,"the low cursor started at the window's top instead of the canvas top").toBeCloseTo(Math.max(s.top,0),6);
  expect(s.done-s.lo,"rows rastered at pen-down reach above the band or past what it shows").toBeLessThanOrEqual(down.tailH+CHUNK);
 }finally{await page.close();}
});

