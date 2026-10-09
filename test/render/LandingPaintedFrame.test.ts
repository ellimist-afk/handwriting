/**
 * A pinch's lift lands the page on the last frame the user saw, not on a finger reading that arrived after it.
 *
 * Alan's Orion run on dd68f6d4: four of seven settles eased 2.85 to 8.38 px, and every one of them committed a scale 0.1 to 0.2
 * percent away from the last painted scale; the two settles whose scales matched landed at 0. A move sample that arrives after
 * the last preview frame is never drawn, yet the lift used to commit it. At scroll offsets in the thousands, a 0.2 percent scale
 * step moves the page several px, and the settle then eased it back.
 *
 * Each cell paints the pinch frame by frame, then delivers one more move sample (scale times 1.002, centroid 1 px over) and the
 * lift in the same task, so no frame paints that sample. The correction handed to the settle's bounce must stay within 0.5 px on
 * both axes and the landed scale must equal the last painted scale. The twin cell lets a frame paint the extra sample before the
 * lift: there the last painted frame IS that sample, and the landing must again stay within 0.5 px.
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
	async pinch(path: string, to: number, steps: number, paintLast: boolean) {
		const o: any = overlayForPath(path), sd = o.view.scrollDOM, r = sd.getBoundingClientRect(), from = o.pinchScaleNow;
		const focal = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
		const orig = o.startOverscrollBounce;
		W.log.length = 0;
		o.startOverscrollBounce = function (this: any, hold: any, dx: number, dy: number, travelled?: boolean) {
			const started = orig.call(this, hold, dx, dy, travelled); W.log.push({ dx, dy, started }); return started; };
		o.pinch("start", 1, focal);
		let ratio = 1;
		for (let i = 1; i <= steps; i++) { ratio = 1 + (to / from - 1) * i / steps; o.pinch("move", ratio, focal); await frame(); }
		await frame();
		const paintedBefore = o.pinchScaleNow, preview = !!o.pinchPreview;
		// One more finger reading: 0.2 percent further and 1 px over.
		const late = { x: focal.x + 1, y: focal.y + 1 };
		o.pinch("move", ratio * 1.002, late);
		if (paintLast) { await frame(); await frame(); }
		const painted = o.pinchScaleNow;
		o.pinch("end", ratio * 1.002, late);
		for (let j = 0; j < 60; j++) await frame();
		o.startOverscrollBounce = orig;
		return { preview, paintedBefore, painted, bounces: W.log.splice(0), zoom: o.pinchScaleNow, scroll: [sd.scrollLeft, sd.scrollTop] };
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
		stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("./", import.meta.url)), sourcefile: "landingPaintedFrameEntry.ts", loader: "ts" },
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

for (const setup of SETUPS) for (const paintLast of [false, true]) {
	const what = paintLast ? "the last finger reading painted before the lift" : "one finger reading after the last painted frame, lifted in the same task";
	it(`a zoom-out from ${SETTLE.from.toFixed(4)} to ${SETTLE.to.toFixed(4)} at scroll (${SETTLE.left}, ${SETTLE.top}), ${what}, outer scale ${setup.outer}, dpr ${setup.dsf}: the lift lands the last painted frame, within 0.5 px`, async () => {
		await withNote(setup, async (page) => {
			expect(await page.evaluate((p) => (window as any).ll.readable(p), PATH), "premise: the re-measure commit ran").toBe(true);
			const at = await page.evaluate(([p, l, t]) => (window as any).ll.scrollTo(p, l, t), [PATH, SETTLE.left, SETTLE.top] as const) as any;
			expect(at.canvasMode, "premise: Infinite Canvas is on").toBe(true);
			expect(Math.min(at.left, at.top), `premise: scroll in the thousands (${at.left}, ${at.top})`).toBeGreaterThanOrEqual(1000);
			const leg = await page.evaluate(([p, z, k]) => (window as any).ll.pinch(p, z, 8, k), [PATH, SETTLE.to, paintLast] as const) as any;
			expect(leg.preview, "premise: preview frames painted before the extra reading").toBe(true);
			if (paintLast) expect(leg.painted, "premise: a frame painted the extra reading").toBeCloseTo(leg.paintedBefore * 1.002, 9);
			else expect(leg.painted, "premise: no frame painted the extra reading").toBe(leg.paintedBefore);
			expect(leg.zoom, `the landed scale is the last painted scale (${JSON.stringify(leg)})`).toBeCloseTo(leg.painted, 9);
			expect(leg.bounces.length, "premise: the settle handed its correction to the bounce").toBeGreaterThan(0);
			const corr = leg.bounces.map((b: any) => [b.dx, b.dy]);
			for (const [dx, dy] of corr) {
				expect(Math.abs(dx), `the settle's correction on x (${JSON.stringify(corr)})`).toBeLessThanOrEqual(0.5);
				expect(Math.abs(dy), `the settle's correction on y (${JSON.stringify(corr)})`).toBeLessThanOrEqual(0.5);
			}
		});
	}, 120_000);
}
