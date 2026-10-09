/**
 * A pinch's lift lands the page where the fingers left it, including the touch scroll taken after the last preview frame.
 *
 * Probe 2's settle 1090.4 (Alan's device, a zoom-out from 1.2650 to 1.0704 at scroll (1231, 1563), Infinite Canvas on), replayed
 * with the fingers resting on the glass: the browser's touch scroll moves the scroller about 0.3 px every 10 ms after the last
 * preview frame, about 5 scroller px by the lift, and the page moves with it on screen. The settle's measured target comes from
 * that last frame's geometry; without carrying the scroll taken since, the commit pulled the page back about 5.4 px at the lift
 * and the settle eased it (or refused the ease and jumped). Here the correction handed to the settle's bounce must stay within
 * 0.5 px: the browser keeps the scroll at whole px, and the pan carries the rest.
 *
 * Four setups: outer scales 0.894, 0.913 and 1 at dpr 1.8257 and pane 1184 by 824 (the outer scale a CSS transform on the pane
 * that hosts the editor, read by the plugin as viewportLayout.externalScale), and outer scale 1 at dpr 2 and pane 1181 by 834.
 * Premise on every cell: the scroller moved at least 2 px on y between the gesture start and the lift, so the cell exercises
 * the late scroll at all.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const SIDECAR = readFileSync(fileURLToPath(new URL("./fixtures/alan-ink-75d1627a.json", import.meta.url)), "utf8");
const PAGE_ID = "75d1627a-c4d7-4a11-947d-bc26b7f83c20";

const ENTRY = `import "./panBakeRepaintPage.ts";
import { overlayForPath } from "../../src/inline/InkOverlay";
const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const W: any = { log: [] as any[] };
(window as any).ll = {
	async scrollTo(path: string, left: number, top: number) {
		const o: any = overlayForPath(path), sd = o.view.scrollDOM;
		sd.scrollLeft = left; sd.scrollTop = top;
		await settle(12);
		o.scheduleRepaint("scroll");
		await settle(12);
		return { left: sd.scrollLeft, top: sd.scrollTop, canvasMode: !!o.canvasMode };
	},
	async outer(path: string, s: number) {
		const o: any = overlayForPath(path), pane = o.view.dom.parentElement as HTMLElement;
		pane.style.transform = "scale(" + s + ")"; pane.style.transformOrigin = "0 0";
		o.handleResize();
		await settle(12);
		o.scheduleRepaint("other");
		await settle(12);
		return o.viewportLayout ? o.viewportLayout.externalScale : null;
	},
	async readable(path: string) {
		const o: any = overlayForPath(path);
		o.view.dom.closest(".markdown-source-view").classList.add("is-readable-line-width");
		await settle(4);
		const ok = !!o.commitCameraScale(o.pinchScaleNow, { left: 0, top: 0 });
		await settle(12);
		return ok;
	},
	async pinch(path: string, to: number, steps: number) {
		const o: any = overlayForPath(path), sd = o.view.scrollDOM, r = sd.getBoundingClientRect(), from = o.pinchScaleNow;
		const focal = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
		const orig = o.startOverscrollBounce;
		W.log.length = 0;
		o.startOverscrollBounce = function (this: any, hold: any, dx: number, dy: number, travelled?: boolean) {
			const started = orig.call(this, hold, dx, dy, travelled); W.log.push({ dx, dy, started }); return started; };
		const s0 = [sd.scrollLeft, sd.scrollTop];
		o.pinch("start", 1, focal);
		for (let i = 1; i <= steps; i++) { o.pinch("move", 1 + (to / from - 1) * i / steps, focal); await frame(); }
		// Fingers resting: the browser's touch scroll moves the scroller by about 0.3 px every 10 ms until the lift.
		for (let i = 0; i < 30; i++) {
			sd.scrollLeft = sd.scrollLeft + (i % 2 ? 0.3 : -0.3); sd.scrollTop = sd.scrollTop + (i % 3 === 0 ? -0.3 : 0.3);
			await sleep(10);
		}
		await frame();
		const s1 = [sd.scrollLeft, sd.scrollTop];
		o.pinch("end", to / from, focal);
		for (let j = 0; j < 60; j++) await frame();
		o.startOverscrollBounce = orig;
		return { net: [s1[0] - s0[0], s1[1] - s0[1]], bounces: W.log.splice(0), zoom: o.pinchScaleNow };
	},
};`;

const SETUPS = [
	{ dsf: 1.8257, pane: { w: 1184, h: 824 }, outer: 0.894 },
	{ dsf: 1.8257, pane: { w: 1184, h: 824 }, outer: 0.913 },
	{ dsf: 1.8257, pane: { w: 1184, h: 824 }, outer: 1 },
	{ dsf: 2, pane: { w: 1181, h: 834 }, outer: 1 },
] as const;
const SETTLE = { from: 1.265020275646411, to: 1.0703957776292337, left: 1231, top: 1563 };
const PATH = "Untitled 1.md";

let script: string;
const browsers = new Map<number, Browser>();
beforeAll(async () => {
	const b = await build({
		stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("./", import.meta.url)), sourcefile: "landingLateScrollEntry.ts", loader: "ts" },
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles![0]!.text;
	for (const dsf of new Set(SETUPS.map(s => s.dsf)))
		browsers.set(dsf, await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${dsf}`, "--window-size=1700,1000"] }));
}, 180_000);
afterAll(async () => { for (const b of browsers.values()) await b.close(); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function withNote(setup: typeof SETUPS[number], body: (page: Page) => Promise<void>) {
	const count = (JSON.parse(SIDECAR).strokes as unknown[]).length;
	const context = await browsers.get(setup.dsf)!.newContext({ viewport: null, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await page.evaluate(([z, s, id, w, h, n]) => (window as any).panBake.mount(z, s, id, w, h, n),
			[SETTLE.from, SIDECAR, PAGE_ID, setup.pane.w, setup.pane.h, count] as const) as any;
		expect(mounted.strokes, "premise: every stroke loaded").toBe(count);
		expect(mounted.dpr, `premise: dpr ${setup.dsf}`).toBeCloseTo(setup.dsf, 3);
		expect(mounted.zoomCommitted, "premise: the first zoom committed").toBe(true);
		const external = await page.evaluate(([p, s]) => (window as any).ll.outer(p, s), [PATH, setup.outer] as const);
		expect(external, `premise: the plugin reads the outer scale ${setup.outer}`).toBeCloseTo(setup.outer, 3);
		await sleep(400);
		await page.evaluate(() => (window as any).panBake.awaitSharp());
		await body(page);
		expect(errors).toEqual([]);
	} finally { await context.close(); }
}

for (const setup of SETUPS) {
	it(`a zoom-out from ${SETTLE.from.toFixed(4)} to ${SETTLE.to.toFixed(4)} with the fingers resting until the lift, outer scale ${setup.outer}, dpr ${setup.dsf}: the lift lands the page where the fingers left it, within 0.5 px`, async () => {
		await withNote(setup, async (page) => {
			expect(await page.evaluate((p) => (window as any).ll.readable(p), PATH), "premise: the re-measure commit ran").toBe(true);
			const at = await page.evaluate(([p, l, t]) => (window as any).ll.scrollTo(p, l, t), [PATH, SETTLE.left, SETTLE.top] as const) as any;
			expect(at.canvasMode, "premise: Infinite Canvas is on").toBe(true);
			const leg = await page.evaluate(([p, z]) => (window as any).ll.pinch(p, z, 8), [PATH, SETTLE.to] as const) as any;
			expect(leg.zoom, "premise: the settle committed the gesture's scale").toBeCloseTo(SETTLE.to, 4);
			expect(Math.abs(leg.net[1]), `premise: the scroller moved on y while the fingers rested (${JSON.stringify(leg.net)})`).toBeGreaterThanOrEqual(2);
			expect(leg.bounces.length, "premise: the settle handed its correction to the bounce").toBeGreaterThan(0);
			const corr = leg.bounces.map((b: any) => [b.dx, b.dy]);
			for (const [dx, dy] of corr) {
				expect(Math.abs(dx), `the settle's correction on x (${JSON.stringify(corr)})`).toBeLessThanOrEqual(0.5);
				expect(Math.abs(dy), `the settle's correction on y (${JSON.stringify(corr)})`).toBeLessThanOrEqual(0.5);
			}
		});
	}, 120_000);
}
