// Harness engine supports CSS zoom; hostZoom pinned true; the transform fallback in applyViewportBox has no harness coverage.
import {beforeAll,afterAll,it,expect} from "vitest";
import {build} from "esbuild";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import {writeFileSync} from "node:fs";
import {chromium,type Browser} from "playwright";
import css from "../../styles.css?raw";
let browser:Browser; let script:string;
declare const process: { env: Record<string, string | undefined> };
const root=fileURLToPath(new URL("../../",import.meta.url));
const baseline=process.env.HW_SCROLL_BASELINE==="1";
const evidence:any[]=[];
beforeAll(async()=>{
	const bundled=await build({entryPoints:[fileURLToPath(new URL("./scrollExpansionPage.ts",import.meta.url))],bundle:true,write:false,format:"iife",platform:"browser",target:"es2022",alias:{obsidian:fileURLToPath(new URL("./iphoneObsidianStub.ts",import.meta.url))},plugins:baseline?[{name:"exact-baseline-production",setup(builder){builder.onLoad({filter:/src[\\/]inline[\\/](InkOverlay|SurfaceExtent|FrontierCache)\.ts$/},args=>({contents:execFileSync("git",["show",`df51029855a33a645cd1637789e17dcb568f46e0:${args.path.slice(root.length).replaceAll("\\","/")}`],{cwd:root,encoding:"utf8"}),loader:"ts"}));}}]:[]});
	script=bundled.outputFiles[0]!.text;browser=await chromium.launch({headless:true});
});
afterAll(async()=>{await browser?.close();if(process.env.HW_SCROLL_EVIDENCE)writeFileSync(process.env.HW_SCROLL_EVIDENCE,JSON.stringify({baseline,evidence},null,2));});
it.each([[true,true,1],[true,false,1.5],[true,false,2],[false,false,1]] as const)("mounted native scroll on=%s seeded=%s scale=%s",async(on,seeded,scale)=>{
	const page=await browser.newPage({viewport:{width:500,height:850}});
	try{
		const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
		await page.setContent("<!doctype html><html><body></body></html>");await page.addStyleTag({content:css});await page.addScriptTag({content:script});
		const trace=await page.evaluate(([on,seeded,scale])=>(window as any).scrollExpansionRun(on,seeded,scale),[on,seeded,scale]);evidence.push(trace);
		expect(errors).toEqual([]);
		if(on){
			expect(trace.initial.grant.x).toBeGreaterThan(0);expect(trace.initial.grant.y).toBeGreaterThan(0);
			for(const step of trace.steps){expect(step.after.grant[step.axis]).toBeGreaterThan(step.before.grant[step.axis]);if(step.axis==="y")expect(step.after.grant.x).toBe(step.before.grant.x);}
			expect(trace.steps.some((s:any)=>JSON.stringify(s.before.camera)===JSON.stringify(s.after.camera)&&s.after.grant[s.axis]>s.before.grant[s.axis])).toBe(true);
		}else expect(trace.initial.grant).toEqual({x:0,y:0});
		expect(trace.afterStill).toEqual(trace.beforeStill);
		expect(trace.disabled.left).toBe(trace.afterStill.left);expect(trace.disabled.top).toBe(trace.afterStill.top);
		// Turning Infinite Canvas off takes back the sideways room scrolling made (Alan, 2026-09-15): the x grant may only
		// shrink, never under the view, and nothing moves. The vertical grant is untouched.
		expect(trace.disabled.grant.y).toBe(trace.afterStill.grant.y);expect(trace.disabled.grant.x).toBeLessThanOrEqual(trace.afterStill.grant.x);
		expect(trace.disabled.width).toBeGreaterThanOrEqual(trace.disabled.left+trace.disabled.clientWidth);
		expect(trace.afterStill.history).toBe(0);expect(trace.afterStill.writes).toBe(0);expect(trace.afterStill.strokes).toBe(0);
		for(const canvas of trace.afterStill.backings)expect(canvas.width*canvas.height).toBeLessThan(8_000_000);
		if (on && !baseline) {
			const c = trace.controls;
			expect(c.drawn.strokes).toBe(1);
			expect(Math.abs(c.alignment.x)).toBeLessThan(1);
			expect(Math.abs(c.alignment.y)).toBeLessThan(1);
			expect(c.drawn.writes).toBeGreaterThan(0);
			expect(c.undoOk).toBe(true); expect(c.undone.strokes).toBe(0);
			expect(c.redoOk).toBe(true); expect(c.redone.strokes).toBe(1);
			expect(c.restored).toEqual(c.stroke);
			for (const state of [c.undone,c.redone]) { expect(state.top).toBe(c.drawn.top); expect(state.left).toBe(c.drawn.left); }
			expect(c.afterPan.top).toBeGreaterThan(c.beforePan.top);
			expect(c.afterPan.grant.y).toBeGreaterThan(c.beforePan.grant.y);
			expect(c.afterPan.strokes).toBe(1);
			expect(c.resizeStill).toEqual(c.resized);
			expect(c.zoomStill).toEqual(c.zoomed);
			expect(c.zoomTravel.scale).toBe(scale);
			// The zoom host is the form under test: the harness engine has css zoom and the overlay's gate agrees with it (file header).
			expect(c.zoomTravel.engineZoom, "the harness engine supports css zoom").toBe(true);
			expect(c.zoomTravel.hostZoom, "the overlay's host-form gate agrees with the engine").toBe(c.zoomTravel.engineZoom);
			// THE FORM PER k (zoomFormAt): above 1 the transform form, where the host carries the scale (after any sub-px
			// scroll residual) and no zoom; at or below 1 the zoom form, where the transform is left empty (this page sets
			// none of its own) and the scale is the host's inline `zoom`.
			if (scale > 1) {
				expect(c.zoomTravel.transform.endsWith(`scale(${scale})`), `above 1: the transform form carries the scale (${c.zoomTravel.transform})`).toBe(true);
				expect(c.zoomTravel.inlineZoom, "above 1: no zoom on the host").toBe("");
			} else {
				expect(c.zoomTravel.transform, "zoom host: no scale transform").toBe("");
				if (scale !== 1) {
					// Production writes the host's own zoom times the scale. This page sets no zoom on the host, so the base is 1 and the
					// written zoom is the scale; the base is asserted rather than assumed.
					expect(c.zoomTravel.baseZoom, "this page sets no zoom of its own on the host").toBe("1");
					expect(Number(c.zoomTravel.inlineZoom), "zoom host: the host's zoom is its base zoom times the pinched scale").toBeCloseTo(Number(c.zoomTravel.baseZoom) * scale, 9);
				}
			}
			for (const step of c.zoomTravel.steps) expect(step.after.grant[step.axis]).toBeGreaterThan(step.before.grant[step.axis]);
			expect(c.oldGrantAfterSwitch).toEqual(c.savedGrant);
			expect(c.exportBeforeTravel).toContain("<svg");
			expect(c.exportAfterTravel).toBe(c.exportBeforeTravel);
			expect(c.reloaded).toBe(false); // Same persisted ink: no content change.
            expect(c.reloadReads).toBe(1);
			expect(c.reopenedOverlay).toBe(true);
			// Zero tilt is intentionally omitted by the persisted point format.
			const normalized = (s:any) => ({...s,points:s.points.map((p:any)=>({...p,tiltX:p.tiltX ?? 0,tiltY:p.tiltY ?? 0}))});
			expect(normalized(c.reopenedStroke)).toEqual(normalized(c.stroke));
			expect(c.exportReopened).toBe(c.exportBeforeTravel);
			for(const state of [c.resized,c.zoomed]) for(const canvas of state.backings) expect(canvas.width*canvas.height).toBeLessThan(8_000_000);
		}
	}finally{await page.close();}
});
