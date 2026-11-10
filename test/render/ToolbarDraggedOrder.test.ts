import { afterAll, beforeAll, expect, it } from "vitest";
import { launch, openFoldOrder, type Browser, type FoldHarness } from "./harness";

let browser: Browser;
const qaDirectory = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.TOOLBAR_QA_DIR;
beforeAll(async () => { browser = await launch(); });
afterAll(async () => { await browser?.close(); });

const settingsHostCss = `.setting-item { display:flex; align-items:center; justify-content:space-between; padding:18px; }
.setting-item-info { flex:1 1 auto; } .setting-item-control { display:flex; flex:1 1 auto; justify-content:flex-end; }
* { box-sizing:border-box; }`;

it("mounted stable settings row-body dragging updates both strips", async () => {
	const h = await openFoldOrder(browser,{realSettings:true,realStrip:true,modalWidth:1000,modalFluid:true,viewport:1400,hostCss:settingsHostCss});
	try {
		const before = await snapshot(h);
		expect(before.priority).not.toContain("Recognize math");
		expect(before.priority).not.toContain("Recognize text");
		expect(await h.page.locator(".modal").getAttribute("data-separate-recognition-toggle")).toBe("false");
		await h.page.evaluate(() => {
			const label = Array.from(document.querySelectorAll<HTMLElement>(".handwriting-fold-name")).find(el=>el.textContent==="Redo")!;
			const y=label.getBoundingClientRect().top+5;
			label.dispatchEvent(new PointerEvent("pointerdown",{pointerId:77,button:0,clientY:y,bubbles:true,cancelable:true}));
			document.dispatchEvent(new PointerEvent("pointermove",{pointerId:77,clientY:y-1000,bubbles:true}));
			document.dispatchEvent(new PointerEvent("pointerup",{pointerId:77,clientY:y-1000,bubbles:true}));
		});
		const after=await snapshot(h);
		expect(after.priority[0]).toBe("Redo");
		for(const width of [1400,350]) {
			await h.setWidth(width);
			const current=await snapshot(h);
			for(const strip of current.strips) {
				expect(strip.first.filter(name=>current.priority.includes(name))).toEqual(current.priority.filter(name=>!strip.more.includes(name)));
				expect(strip.more).toEqual(current.priority.filter(name=>strip.more.includes(name)));
			}
			const boxes=await h.page.evaluate(()=>{
				const rect=(q:string)=>{const r=document.querySelector(q)!.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
				return {card:rect(".handwriting-fold-card"),preview:rect(".handwriting-fold-preview"),stage:rect(".handwriting-fold-preview-stage"),modal:rect(".modal"),row:rect(".handwriting-fold-row"),layout:getComputedStyle(document.querySelector(".setting-item")!).display};
			});
			expect(boxes.layout).toBe("block");
			expect(boxes.card.width).toBeLessThanOrEqual(466);
			expect(boxes.card.right).toBeLessThanOrEqual(boxes.modal.right);
			expect(boxes.row.right).toBeLessThanOrEqual(boxes.card.right);
			expect(boxes.stage.height).toBeLessThan(120);
			if(width===1400) {
				expect(boxes.preview.left).toBeGreaterThanOrEqual(boxes.card.right+20);
				expect(Math.abs(boxes.preview.top-boxes.card.top)).toBeLessThanOrEqual(1);
			} else expect(boxes.preview.top).toBeGreaterThan(boxes.card.bottom);
			expect(boxes.preview.right).toBeLessThanOrEqual(boxes.modal.right);
			if(qaDirectory) await h.page.locator(".modal").screenshot({path:`${qaDirectory}/toolbar-${width}.png`});
		}
	} finally { await h.close(); }
});

it.each(["mouse","touch","pen"])("whole-row %s taps and cancelled drags preserve saved order", async pointerType => {
	const h=await openFoldOrder(browser,{realSettings:true,realStrip:true,modalWidth:700,viewport:1400});
	try {
		const before=await snapshot(h);
		for(const ending of ["tap","pointercancel","Escape"]) {
			await h.page.evaluate(({pointerType,ending})=>{
				const row=document.querySelector<HTMLElement>(".handwriting-fold-row")!;
				row.dispatchEvent(new PointerEvent("pointerdown",{pointerId:90,pointerType,button:0,clientY:0,bubbles:true,cancelable:true}));
				if(ending!=="tap") document.dispatchEvent(new PointerEvent("pointermove",{pointerId:90,pointerType,clientY:120,bubbles:true}));
				if(ending==="Escape") document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
				else document.dispatchEvent(new PointerEvent(ending==="tap"?"pointerup":"pointercancel",{pointerId:90,pointerType,bubbles:true}));
			},{pointerType,ending});
			expect(await snapshot(h)).toEqual(before);
		}
	} finally { await h.close(); }
});

it.each(["top-right","middle-center","bottom-right"] as const)("frames readable %s preview controls without changing detected fold width", async corner => {
	const h = await openFoldOrder(browser,{realStrip:true,modalWidth:700,modalFluid:true,viewport:985,corner});
	try {
		for(const width of [985,360]) {
			await h.setWidth(width);
			const visual=await h.page.evaluate(()=>{
				const stage=document.querySelector<HTMLElement>(".handwriting-fold-preview-stage")!;
				const pane=document.querySelector<HTMLElement>(".handwriting-fold-preview-pane")!;
				const strip=pane.querySelector<HTMLElement>(".handwriting-mobile-tools")!;
				const box=stage.getBoundingClientRect();
				const buttons=Array.from(strip.querySelector<HTMLElement>(".handwriting-mobile-tools-face")!.querySelectorAll<HTMLElement>(":scope > button, .handwriting-mobile-tools-more > button")).filter(el=>el.offsetWidth>0).map(el=>{const r=el.getBoundingClientRect();return{name:el.dataset.tipLabel,width:r.width,left:r.left,right:r.right,top:r.top,bottom:r.bottom};});
				return {paneWidth:pane.clientWidth,stage:{left:box.left,right:box.right,top:box.top,bottom:box.bottom},buttons};
			});
			expect(visual.paneWidth).toBe(width);
			expect(visual.buttons.length).toBeGreaterThan(5);
			for(const button of visual.buttons) {
				expect(button.width).toBeGreaterThanOrEqual(width===985 ? 24 : 18);
				expect(button.left).toBeGreaterThanOrEqual(visual.stage.left-1);
				expect(button.right,JSON.stringify({button,visual})).toBeLessThanOrEqual(visual.stage.right+1);
				expect(button.top).toBeGreaterThanOrEqual(visual.stage.top-1);
				expect(button.bottom).toBeLessThanOrEqual(visual.stage.bottom+1);
			}
		}
	} finally { await h.close(); }
});

async function snapshot(h: FoldHarness) {
	return h.page.evaluate(() => {
		const priority = Array.from(document.querySelectorAll<HTMLElement>(".handwriting-fold-name")).map(el => el.textContent!);
		const strips = Array.from(document.querySelectorAll<HTMLElement>(".workspace-leaf .handwriting-mobile-tools-face, .handwriting-fold-preview-pane .handwriting-mobile-tools-face"));
		const name = (el: HTMLElement) => el.dataset.tipLabel ?? el.getAttribute("aria-label") ?? el.className;
		return {priority, saved:window.__fold.savedOrder(), strips:strips.map(strip => ({
			first:Array.from(strip.querySelectorAll<HTMLElement>(":scope > button")).map(name),
			more:Array.from(strip.querySelectorAll<HTMLElement>(".handwriting-mobile-tools-more > button")).map(name),
			fixed:Array.from(strip.children).filter(el => !priority.includes(name(el as HTMLElement)) && !el.classList.contains("handwriting-mobile-tools-more")).map(el=>name(el as HTMLElement)),
		}))};
	});
}

it("keyboard drag order reaches wide preview/live strips, survives More and reload", async () => {
	let h = await openFoldOrder(browser,{realStrip:true,modalWidth:700,viewport:1400,fingerAvailable:true});
	try {
		const original = await snapshot(h);
		await h.page.evaluate(() => {
			const grip = document.querySelector<HTMLElement>(".handwriting-fold-row:last-child .handwriting-fold-grip")!;
			grip.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true,cancelable:true}));
		});
		const changed = await snapshot(h);
		expect(changed.priority).not.toEqual(original.priority);
		expect(changed.strips).toHaveLength(2);
		for (const [i,strip] of changed.strips.entries()) {
			expect(strip.first.filter(name=>changed.priority.includes(name))).toEqual(changed.priority);
			expect(strip.fixed).toEqual(original.strips[i]!.fixed);
		}
		await h.setWidth(350);
		const narrow = await snapshot(h);
		for (const strip of narrow.strips) {
			expect(strip.more.length).toBeGreaterThan(0);
			expect(strip.more).toEqual(changed.priority.filter(name=>strip.more.includes(name)));
			expect(strip.first.filter(name=>changed.priority.includes(name))).toEqual(changed.priority.filter(name=>!strip.more.includes(name)));
		}
		await h.setWidth(1400);
		const restored = await snapshot(h);
		expect(restored.strips).toEqual(changed.strips);
		const moves = await h.page.evaluate(async () => {
			let moves=0;
			const observer=new MutationObserver(records=>{moves+=records.filter(r=>r.type==="childList").length;});
			for(const strip of document.querySelectorAll(".handwriting-mobile-tools")) observer.observe(strip,{childList:true,subtree:true});
			for(let n=0;n<5;n++)window.dispatchEvent(new Event("resize"));
			await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
			observer.disconnect(); return moves;
		});
		expect(moves).toBe(0);
		await h.close();
		h = await openFoldOrder(browser,{realStrip:true,modalWidth:700,viewport:1400,initialOrder:changed.saved,fingerAvailable:false});
		const reloaded = await snapshot(h);
		expect(reloaded.saved).toEqual(changed.saved);
		expect(reloaded.priority.length).toBe(changed.priority.length-1);
		for(const strip of reloaded.strips) expect(strip.first.filter(name=>reloaded.priority.includes(name))).toEqual(reloaded.priority);
	} finally { await h.close(); }
});

it("pointer dragging changes the wide preview and toolbar immediately", async () => {
	const h = await openFoldOrder(browser,{realStrip:true,modalWidth:700,viewport:1400});
	try {
		const before = await snapshot(h);
		await h.page.evaluate(() => {
			const grip = document.querySelector<HTMLElement>(".handwriting-fold-row:last-child .handwriting-fold-grip")!;
			const y = grip.getBoundingClientRect().top + 5;
			grip.dispatchEvent(new PointerEvent("pointerdown",{pointerId:41,button:0,clientY:y,bubbles:true,cancelable:true}));
			document.dispatchEvent(new PointerEvent("pointermove",{pointerId:41,clientY:y-1000,bubbles:true}));
			document.dispatchEvent(new PointerEvent("pointerup",{pointerId:41,clientY:y-1000,bubbles:true}));
		});
		const after = await snapshot(h);
		expect(after.priority[0]).toBe(before.priority.at(-1));
		for(const strip of after.strips) expect(strip.first.filter(name=>after.priority.includes(name))).toEqual(after.priority);
		expect((await h.probe()).caption).toBe("Drag to order. Everything fits on the screen.");
	} finally { await h.close(); }
});
