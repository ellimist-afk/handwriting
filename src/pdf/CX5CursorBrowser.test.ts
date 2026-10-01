import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

declare const process: { env: Record<string, string | undefined>; cwd(): string };

// Opt in under the same execution guard as other browser/render checks.
describe.skipIf(process.env.CX5_BROWSER !== "1")("PDF cursor browser overflow", () => {
	let browser: Browser;
	let page: Page;
	beforeAll(async () => {
		const bundled = await build({
			stdin: { contents: `
import { PdfInkController } from "./src/pdf/PdfInkController";
import { setPenReticle, setEraserRadiusPx } from "./src/inline/InkOverlay";
import { setTipMode } from "./src/inline/TipMode";
import { setMouseInk } from "./src/inline/MouseInk";
const proto = HTMLElement.prototype;
proto.setCssStyles = function(styles) { Object.assign(this.style, styles); };
proto.createDiv = function(options) { const el = document.createElement('div'); el.className = options?.cls ?? ''; this.append(el); return el; };
proto.instanceOf = function(type) { return this instanceof type; };
window.cursorScene = (mode, pointer, horizontal) => {
 document.body.innerHTML = '<div id="root" style="transform:translate(17px,11px);position:relative"><div class="pdf-viewer-container" style="position:relative;width:420px;height:260px;overflow:scroll;scrollbar-gutter:stable;margin:30px"><div class="pdfViewer" style="width:' + (horizontal ? '840px' : '100%') + ';height:2000px;background:white"></div></div></div>';
 let scroller = document.querySelector('.pdf-viewer-container');
 const controller = new PdfInkController(document.querySelector('#root'), window, () => [], () => 'browser-pdf', () => []);
 controller.ensureTools = () => {};
 controller.probe = () => ({ scroller, scaleFactor:2, pages:[] });
 controller.boundScroller = scroller;
 setMouseInk(true); setPenReticle(true); setTipMode(mode); setEraserRadiusPx(48);
 scroller.scrollLeft = horizontal ? 200 : 0; scroller.scrollTop = 500;
 const extent = () => ({ width:scroller.scrollWidth, height:scroller.scrollHeight, left:scroller.scrollLeft, top:scroller.scrollTop });
 const before = extent();
 const show = (edge) => {
  const x = edge === 'right' ? scroller.clientWidth-1 : edge === 'left' ? 1 : scroller.clientWidth/2;
  const y = edge === 'bottom' ? scroller.clientHeight-1 : edge === 'top' ? 1 : scroller.clientHeight/2;
  controller.showCursor({x,y,pressure:.5,timestamp:0,tiltX:0,tiltY:0}, pointer);
  const cursor = controller.cursorEl, r = cursor.getBoundingClientRect(), s = scroller.getBoundingClientRect();
  return { ...extent(), centerX:r.x+r.width/2, centerY:mode === 'space' ? r.y : r.y+r.height/2, wantX:s.x+x, wantY:s.y+y, visible:getComputedStyle(cursor).display !== 'none', locator:getComputedStyle(cursor, '::after').width };
 };
 return { before, clientWidth:scroller.clientWidth, show,
  clip:() => { const r=scroller.getBoundingClientRect(); return {x:r.x,y:r.y,width:scroller.clientWidth,height:scroller.clientHeight}; },
  hide:() => controller.hideCursor(),
  shrink:() => { controller.hideCursor(); const display=scroller.style.display; scroller.style.width='200px'; scroller.style.height='120px'; const content=scroller.querySelector('.pdfViewer'); content.style.width='100px'; content.style.height='100px'; return {...extent(), clientWidth:scroller.clientWidth, clientHeight:scroller.clientHeight, hostDisplay:scroller.style.display, priorDisplay:display}; },
  identity:() => ({ cursor:controller.cursorEl, wrapper:controller.cursorEl?.parentElement, disposers:controller.disposers.length }),
  hideForeign:() => { const own=controller.cursorEl; const child=scroller.createDiv({}); controller.cursorEl=child; controller.hideCursor(); const display=scroller.style.display; child.remove(); controller.cursorEl=own; return display; },
  replace:() => { const old=scroller; scroller=old.cloneNode(false); scroller.append(old.querySelector('.pdfViewer').cloneNode(true)); old.replaceWith(scroller); controller.boundScroller=scroller; show('center'); return document.querySelectorAll('.handwriting-pdf-cursor').length; },
  dispose:() => { controller.unmount(); return document.querySelectorAll('.handwriting-pdf-cursor, .handwriting-pdf-cursor-viewport').length; }
 };
};`, resolveDir: process.cwd(), loader: "js" },
			bundle: true, write: false, format: "iife", platform: "browser",
			alias: { obsidian: resolve("test/obsidian-stub.ts") },
		});
		browser = await chromium.launch({ headless: true });
		page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
		await page.setContent("<html><body></body></html>");
		await page.addStyleTag({ content: readFileSync(resolve("styles.css"), "utf8") + "body{margin:0;background:#777}" });
		await page.addScriptTag({ content: bundled.outputFiles[0]!.text });
		await page.screenshot(); // Warm screenshot/font setup before the pen watchdog starts.
		console.log(`Cursor browser: ${browser.version()}`);
	}, 30000);
	afterAll(async () => { await browser?.close(); });
	for (const mode of ["nib", "eraser", "space"]) for (const pointer of ["pen", "mouse"]) for (const horizontal of [false, true]) {
		it(`${mode}/${pointer}/${horizontal ? "horizontal scroll" : "fit width"}: stable extent, center, replacement and teardown`, async () => {
			const result = await page.evaluate(({ mode, pointer, horizontal }) => {
				const scene = (window as any).cursorScene(mode, pointer, horizontal);
				const samples = ["center", "right", "bottom", "left", "top"].map(edge => ({ edge, ...scene.show(edge) }));
				const replacement = scene.replace();
				const remaining = scene.dispose();
				return { before:scene.before, clientWidth:scene.clientWidth, samples, replacement, remaining };
			}, { mode, pointer, horizontal });
			expect(result.clientWidth).toBeLessThan(420);
			for (const s of result.samples) {
				expect.soft(s.width, `${s.edge}: scrollWidth`).toBe(result.before.width);
				expect.soft(s.height, `${s.edge}: scrollHeight`).toBe(result.before.height);
				expect.soft(s.left, `${s.edge}: scrollLeft`).toBe(result.before.left);
				expect.soft(s.top, `${s.edge}: scrollTop`).toBe(result.before.top);
				expect.soft(s.centerX, `${s.edge}: center x`).toBeCloseTo(s.wantX, 1);
				expect.soft(s.centerY, `${s.edge}: center y`).toBeCloseTo(s.wantY, 1);
				expect.soft(s.visible).toBe(true);
				if (pointer === "mouse" && mode === "nib") expect.soft(s.locator).toBe("22px");
			}
			expect(result.replacement).toBe(1);
			expect(result.remaining).toBe(0);
		});
	}
	for (const mode of ["nib", "eraser", "space"]) for (const pointer of ["pen", "mouse"]) {
		it(`${mode}/${pointer}: pixels remain visible at every viewport edge`, async () => {
			await page.evaluate(({ mode, pointer }) => { (window as any).scene = (window as any).cursorScene(mode, pointer, false); }, { mode, pointer });
			for (const edge of ["center", "left", "right", "top", "bottom"]) {
				await page.evaluate(edge => (window as any).scene.show(edge), edge);
				const clip = await page.evaluate(() => (window as any).scene.clip());
				const painted = await page.screenshot({ clip });
				await page.evaluate(() => (window as any).scene.hide());
				const hidden = await page.screenshot({ clip });
				const stable = await page.screenshot({ clip });
				expect(hidden.equals(stable), `${edge}: stable screenshot control`).toBe(true);
				expect(painted.equals(hidden), `${edge}: visible cursor pixels`).toBe(false);
				if (process.env.CX5_BROWSER_OUTPUT) {
					mkdirSync(process.env.CX5_BROWSER_OUTPUT, { recursive: true });
					writeFileSync(resolve(process.env.CX5_BROWSER_OUTPUT, `${mode}-${pointer}-${edge}.png`), painted);
				}
			}
			await page.evaluate(() => (window as any).scene.dispose());
		}, 30000);
	}
	it("hidden cursor releases extent after content and viewport shrink; next hover restores paint", async () => {
		const result = await page.evaluate(() => {
			const scene = (window as any).cursorScene("eraser", "mouse", true);
			scene.show("right"); const first=scene.identity(); scene.show("left"); const second=scene.identity();
			const shrunk=scene.shrink(); const shown=scene.show("center");
			return {shrunk, shown, foreignDisplay:scene.hideForeign(), reused:first.cursor===second.cursor && first.wrapper===second.wrapper, disposers:[first.disposers,second.disposers], remaining:scene.dispose()};
		});
		expect.soft(result.shrunk.width).toBe(result.shrunk.clientWidth);
		expect.soft(result.shrunk.height).toBe(result.shrunk.clientHeight);
		expect.soft(result.shrunk.hostDisplay).toBe(result.shrunk.priorDisplay);
		expect(result.foreignDisplay).toBe(result.shrunk.priorDisplay);
		expect(result.shown.visible).toBe(true);
		expect(result.shown.centerX).toBeCloseTo(result.shown.wantX, 1);
		expect(result.shown.centerY).toBeCloseTo(result.shown.wantY, 1);
		expect(result.reused).toBe(true);
		expect(result.disposers[1]).toBe(result.disposers[0]);
		expect(result.remaining).toBe(0);
	});
});
