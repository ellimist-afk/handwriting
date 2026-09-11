import {it,expect} from "vitest";
import {build} from "esbuild";
import {chromium} from "playwright";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import css from "../../styles.css?raw";

it("root momentum policy survives guard transitions and restores host style",async()=>{
 const b=await build({stdin:{contents:`import './test/render/noteViewportCameraPage';import {overlayForPath,setScrollExpansionEnabled} from './src/inline/InkOverlay';import {setPenGestureGuardEnabled} from './src/inline/InlinePenRouter';window.policy=async()=>{await window.nativeMomentumSetup();const r=overlayForPath('fit-native.md').router,el=document.querySelector('.cm-scroller'),states=[];const snap=()=>states.push({inline:el.style.touchAction,computed:getComputedStyle(el).touchAction,guard:el.classList.contains('handwriting-touch-guard')});r.applyGuard({touchAction:''},'disabled');snap();setPenGestureGuardEnabled(true);r.applyGuard({touchAction:'none'},'test');snap();setScrollExpansionEnabled(false);snap();r.applyGuard({touchAction:''},'test');snap();setScrollExpansionEnabled(true);setPenGestureGuardEnabled(false);snap();r.dispose();snap();return states;};`,resolveDir:fileURLToPath(new URL('../../',import.meta.url)),loader:'ts'},bundle:true,write:false,format:'iife',platform:'browser',alias:{obsidian:fileURLToPath(new URL('./iphoneObsidianStub.ts',import.meta.url))}});
 const browser=await chromium.launch({headless:true});const p=await browser.newPage({viewport:{width:700,height:540}});try{await p.setContent('<!doctype html><body></body>');await p.addStyleTag({content:css+readFileSync(fileURLToPath(new URL('./noteViewportCamera.css',import.meta.url)),'utf8')});await p.addScriptTag({content:b.outputFiles[0]!.text});const states=await p.evaluate(()=>(window as any).policy());expect(states.map((s:any)=>s.inline)).toEqual(['none','none','none','','none','']);expect(states.map((s:any)=>s.guard)).toEqual([false,true,true,false,false,false]);expect(states[4].computed).toBe('none');expect(states[5].computed).toBe('auto');}finally{await browser.close();}
});
