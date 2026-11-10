import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Trace rows for the issue 48 cell: no gate, rows only. Each arm runs the cell's note and
// stroke, then the zoom, and records every settle-measure write and the geometry at the settle and after 60 quiet frames.
// HW_ISSUE48_TRACE_OUT=<file> writes the rows. 1.4.24 and later only.
declare const process: { env: Record<string, string | undefined> };
const root=fileURLToPath(new URL("../../",import.meta.url));
let browser:Browser, bundle:string;
const rows:Record<string,unknown>={};
beforeAll(async()=>{browser=await chromium.launch({headless:true});bundle=(await build({entryPoints:[root+"test/render/issue48TracePage.ts"],bundle:true,write:false,format:"iife",platform:"browser",alias:{obsidian:root+"test/render/iphoneObsidianStub.ts"}})).outputFiles[0]!.text;});
afterAll(async()=>{await browser?.close();if(process.env.HW_ISSUE48_TRACE_OUT)writeFileSync(process.env.HW_ISSUE48_TRACE_OUT,JSON.stringify(rows,null,1));});
for(const [arm,obsidian] of [["plus",false],["pinch",false],["plus",true],["pinch",true],["fit",true]] as const)it(`trace ${arm}${obsidian?" obsidian wrappers":""}`,async()=>{
 const page=await browser.newPage({viewport:{width:1000,height:700}});
 try{
  await page.setContent("<body></body>");await page.addStyleTag({content:readFileSync(root+"styles.css","utf8")});
  await page.addStyleTag({content:`html,body{margin:0;width:100%;height:100%;overflow:hidden}body{display:flex}.issue48-host{position:relative;display:flex;flex:1;min-width:0;min-height:0;height:600px;overflow:hidden}.issue48-host .cm-editor{display:flex;flex:1;min-width:0;min-height:0;height:600px}.issue48-host .cm-scroller{flex:1;min-height:0;overflow:auto}.issue48-host .cm-content{padding:8px 0!important}.issue48-host .cm-line{padding:0}`});
  await page.addScriptTag({content:bundle});
  const r=await page.evaluate(([a,o])=>(window as any).issue48Trace.trace(a,o),[arm,obsidian] as const);
  rows[obsidian?`${arm}-obsidian`:arm]=r;
  expect(r.ok,"premise: the zoom was taken").toBe(true);
  expect(r.attempts.length,"rows: at least one measure write traced").toBeGreaterThan(0);
 }finally{await page.close();}
});
