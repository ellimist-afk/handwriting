import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { resolve } from "node:path";

declare const process: { env: Record<string, string | undefined>; cwd(): string };

describe.skipIf(process.env.CX5_BROWSER !== "1")("PDF focus browser lifecycle", () => {
	let browser: Browser;
	let page: Page;
	beforeAll(async () => {
		const bundled = await build({
			stdin: { contents: `
import { PdfInkController } from "./src/pdf/PdfInkController";
import { setTipMode } from "./src/inline/TipMode";
import { setMouseInk } from "./src/inline/MouseInk";
HTMLElement.prototype.setCssStyles=function(styles){Object.assign(this.style,styles);};
HTMLElement.prototype.instanceOf=function(type){return this instanceof type;};
window.focusScene = (tabindex) => {
 document.body.innerHTML='<button id="prior">Other pane</button><div id="root" style="overflow:hidden"><input id="find"><div id="scroller" class="pdf-viewer-container" style="width:420px;height:260px;overflow:auto;position:relative"><div id="gray" style="height:5000px;width:100%;background:#ddd"></div></div></div><button id="other">New pane</button>';
 const root=document.querySelector('#root'); let scroller=document.querySelector('#scroller');
 if(tabindex!==null)scroller.setAttribute('tabindex',tabindex);
 const controller=new PdfInkController(root,window,()=>[],()=> 'pdf',()=>[]);
 controller.ensureTools=()=>{}; controller.schedule=()=>{}; controller.scheduleThrottled=()=>{};
 controller.pageElement=()=>null; // No raster layer is needed to exercise accepted pen focus.
 controller.probe=()=>({scroller,scaleFactor:1,pages:[{pageNumber:1,leftPx:0,topPx:0,widthPx:420,heightPx:5000,hasCanvas:true}]});
 controller.mount(); controller.bindTo(scroller); setMouseInk(false); setTipMode('eraser');
 const down=()=>{controller.penDown({x:50,y:50,pressure:.5,timestamp:0,tiltX:0,tiltY:0},{pointerType:'pen',buttons:1,button:0});controller.penUp();};
 return {controller, root, get scroller(){return scroller;}, down,
  replace:()=>{const old=scroller;scroller=old.cloneNode(true);scroller.removeAttribute('tabindex');old.replaceWith(scroller);controller.bindTo(scroller);return old;},
  dispose:()=>controller.unmount()
 };
};`, resolveDir: process.cwd(), loader: "js" },
			bundle:true, write:false, format:"iife", platform:"browser", alias:{obsidian:resolve("test/obsidian-stub.ts")},
		});
		browser=await chromium.launch({headless:true});
		page=await browser.newPage({viewport:{width:1000,height:800}});
		await page.setContent("<html><body></body></html>");
		await page.addScriptTag({content:bundled.outputFiles[0]!.text});
		console.log(`Focus browser: ${browser.version()}`);
	}, 30000);
	afterAll(async()=>{await browser?.close();});
	async function scene(tabindex: string | null = null) {
		await page.evaluate(tabindex=>{(window as any).scene=(window as any).focusScene(tabindex);},tabindex);
	}
	for(const disabled of [false,true]) for(const key of ["PageDown","Space","ArrowDown","ArrowUp"]) {
		it(`gray click keeps native ${key} scrolling, disabled=${disabled}`,async()=>{
			await scene();
			if(disabled)await page.evaluate(()=>(window as any).scene.dispose());
			await page.locator("#gray").click({position:{x:300,y:100}});
			await page.evaluate(()=>{(window as any).scene.scroller.scrollTop=600;});
			await page.keyboard.press(key);
			const sign=key==="ArrowUp"?-1:1;
			await page.waitForFunction(sign=>((window as any).scene.scroller.scrollTop-600)*sign>1,sign,{timeout:1500});
			if(!disabled)await page.evaluate(()=>(window as any).scene.dispose());
		});
	}
	it("accepted pen claims scroller; keyboard Delete and undo reach the root; teardown restores prior focus",async()=>{
		await scene();
		const result=await page.evaluate(()=>{
			const s=(window as any).scene, prior=document.querySelector<HTMLButtonElement>("#prior")!;
			prior.focus(); s.down();
			const active=document.activeElement===s.scroller; const calls:string[]=[];
			s.controller.deleteSelectionCommand=()=>{calls.push("delete");return true;};
			s.controller.historyStep=()=>{calls.push("undo");return true;};
			Object.defineProperty(s.controller,"hasSelection",{get:()=>true});
			(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown",{key:"Delete",bubbles:true,cancelable:true}));
			(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown",{key:"z",ctrlKey:true,bubbles:true,cancelable:true}));
			s.dispose();return {active,calls,restored:document.activeElement===prior,tabindex:s.scroller.getAttribute("tabindex"),rootTabindex:s.root.getAttribute("tabindex")};
		});
		expect(result.active).toBe(true);expect(result.calls).toEqual(["delete","undo"]);
		expect(result.restored).toBe(true);expect(result.tabindex).toBeNull();expect(result.rootTabindex).toBeNull();
	});
	it("same-pane find input outside scroller retains typing focus",async()=>{
		await scene();
		const result=await page.evaluate(()=>{const s=(window as any).scene;const find=document.querySelector<HTMLInputElement>("#find")!;find.focus();s.down();const kept=document.activeElement===find;s.dispose();return kept;});
		expect(result).toBe(true);
	});
	it("refused pen leaves focus in the prior pane",async()=>{
		await scene();
		const result=await page.evaluate(()=>{const s=(window as any).scene;const prior=document.querySelector<HTMLButtonElement>("#prior")!;prior.focus();s.controller.documentId=()=>null;s.down();const kept=document.activeElement===prior;s.dispose();return kept;});
		expect(result).toBe(true);
	});
	for(const change of ["host-before","host-after","pane-switch","detached-prior","replacement"]) {
		it(`focus ownership survives ${change}`,async()=>{
			await scene(change==="host-before"?"0":null);
			const result=await page.evaluate(change=>{
				const s=(window as any).scene;const prior=document.querySelector<HTMLButtonElement>("#prior")!;prior.focus();s.down();
				let old:any=null;
				if(change==="host-after")s.scroller.setAttribute("tabindex","3");
				if(change==="pane-switch")document.querySelector<HTMLButtonElement>("#other")!.focus();
				if(change==="detached-prior")prior.remove();
				if(change==="replacement"){old=s.replace();s.down();}
				const armed=s.scroller.getAttribute("tabindex");s.dispose();
				return {armed,tabindex:s.scroller.getAttribute("tabindex"),oldTabindex:old?.getAttribute("tabindex"),active:(document.activeElement as HTMLElement)?.id,priorConnected:prior.isConnected};
			},change);
			expect(result.tabindex).toBe(change==="host-before"?"0":change==="host-after"?"3":null);
			if(change==="pane-switch")expect(result.active).toBe("other");
			if(change==="detached-prior")expect(result.priorConnected).toBe(false);
			if(change==="replacement"){expect(result.oldTabindex).toBeNull();expect(result.armed).toBe("-1");}
		});
	}
});
