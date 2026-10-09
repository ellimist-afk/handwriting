/**
 * The small live pen layers across note zoom, in Chromium: pinned on up to 200 percent; read and printed above.
 *
 * The raster scale is b = dpr x min(zoom, 2) (MAX_ZOOM_BACKING = 2). Up to 200 percent the display factor
 * f = zoom x dpr / b is 1, a backing px is a displayed device px, and the wet tile and compact tail are on
 * (an exact grid, or the grid 1 fallback). Above 200 percent b stays at 2 x dpr, f = zoom / 2 is not 1, and at
 * a ratio with no exact grid the live layers stay full size (read, not pinned). The area cap never binds on this pane.
 * The cell reads those layers at pinch scales across 200 percent and pins what 89d9950c does up to it, so a later
 * change to the live layers has to move these numbers on purpose.
 *
 * Only 1, 1.5, 1.79 and 1.95 are asserted (tile on, compact tail, at most 10 draws into the full wet canvas per 160-move
 * stroke). Above 200 percent the cell prints and pins nothing: asserting the full size state would pin the slow state.
 *
 * Arms: ratio 2 and ratio 1.8257, each at note zoom 1.5, 1.79, 1.95, 2.5 and 3.5, and 1 as the base case (the
 * band reads 1778 x 1367 css there). Per arm, on the real overlay:
 * - LAYERS: the wet tile, the tail, and the committed band as sized by the overlay (layers() line, printed).
 * - COST: one 160-move pen stroke; draws into the full wet canvas per pen event (full size layers draw there
 *   every event, the tile does not), printed.
 *
 * Mode: Infinite Canvas ON for the note (canvas mode on, readable line length on), as the mount helper sets it: a
 * note's own choice wins over the global setting, and the note zoom exists only with the canvas on.
 *
 * Device ratio regime: every page runs in a browser launched with the real --force-device-scale-factor flag
 * and no viewport (window-size only), never Playwright's deviceScaleFactor emulation, which does not place layers on device px the way the real flag does.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { penPress, penMove, penRelease, linePoints } from "./cdpPen";

declare const process: { env: Record<string, string | undefined> };
const root = fileURLToPath(new URL("../../", import.meta.url));
let overlayBundle: string;
const browsers = new Map<number, Browser>();
/** A page in a browser launched with the real device scale factor flag, viewport from the window. */
async function pageAt(dsf: number): Promise<Page> {
	let b = browsers.get(dsf);
	if (!b) {
		b = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${dsf}`, "--window-size=1700,1300"] });
		browsers.set(dsf, b);
	}
	const ctx = await b.newContext({ viewport: null });
	return ctx.newPage();
}

beforeAll(async () => {
	overlayBundle = (await build({
		entryPoints: [root + "test/render/gridFallbackPage.ts"], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		nodePaths: process.env.HW_TAIL_TEST_NODE_MODULES ? [process.env.HW_TAIL_TEST_NODE_MODULES] : undefined,
		alias: { obsidian: root + "test/render/iphoneObsidianStub.ts" },
	})).outputFiles[0]!.text;
}, 180_000);
afterAll(async () => { for (const b of browsers.values()) await b.close(); });

const ODD_DPR = 1.8257418870925903;
/**
 * Orion's pane in css px. Its band at 100 percent is 1778 x 1367 css: the band is the
 * pane plus a margin of round(0.25 x height) on each side, so height 911 gives 911 + 2 x 228 = 1367 and width
 * 1322 gives 1322 + 2 x 228 = 1778. At ratio 1.8257 that is 8.10M device px, under the 10M area cap; a larger pane
 * puts the cap in force and no tile is the right answer there (the first run of this cell, pane 1596 x 1236, read it).
 */
const pane = { w: 1322, h: 911 };
/** 1 is the base case: the band reads 1778 x 1367 css there. */
const ZOOMS = [1, 1.5, 1.79, 1.95, 2.5, 3.5];
const RATIOS = [2, ODD_DPR];

type Layers = {
	dpr: number; cssScale: number; pinchScaleNow: number; backing: number; hostZoom: boolean;
	tile: { w: number; h: number; grid: number | null; on: boolean };
	tail: { w: number; h: number; grid: number | null; mode: string; tileW: number };
	band: { w: number; h: number };
};
type Meter = { events: number; fullDraws: number; perEvent: number };

async function arm(dsf: number, zoom: number) {
	const page = await pageAt(dsf);
	try {
		await page.addScriptTag({ content: overlayBundle });
		const read = await page.evaluate(([p, k]) => (window as any).scrollColumnAnchor.runTearMount(k, 0, p, true, { fx: 0.5, fy: 0.5 }), [pane, zoom] as const);
		const layers = await page.evaluate(() => (window as any).gridFallback.layers()) as Layers;
		const r = read.rects.pane as { l: number; t: number; w: number; h: number };
		const cdp = await page.context().newCDPSession(page);
		const y = Math.round(r.t + r.h * 0.4), x0 = Math.round(r.l + 60);
		const points = linePoints({ x: x0, y }, { x: x0 + 600, y: y + 120 }, 160);
		await page.evaluate(() => (window as any).gridFallback.meterStart());
		await penPress(cdp, points[0]!.x, points[0]!.y, { pressure: 0.6 });
		let meter: Meter;
		try {
			for (const p of points.slice(1)) await penMove(cdp, p.x, p.y, { pressure: 0.6 });
			meter = await page.evaluate(() => (window as any).gridFallback.meterRead()) as Meter;
		} finally {
			await penRelease(cdp, points.at(-1)!.x, points.at(-1)!.y);
		}
		await page.evaluate(() => (window as any).scrollColumnAnchor.runTearTeardown());
		return { layers, meter };
	} finally {
		await page.context().close();
	}
}

for (const dsf of RATIOS) for (const zoom of ZOOMS) it(`ratio ${dsf}, note zoom ${zoom}: ${zoom <= 2 ? "the small pen layers are on" : "layers and cost read, printed, not pinned"}`, async () => {
	const { layers: L, meter } = await arm(dsf, zoom);
	// eslint-disable-next-line no-console
	console.log(`ZOOM LAYERS [real flag --force-device-scale-factor=${dsf}] zoom ${zoom}: layers ${JSON.stringify(L)} cost ${JSON.stringify(meter)}`);
	expect(L.dpr, "the rig does not hold the device ratio").toBe(dsf);
	expect(L.pinchScaleNow, "the note did not reach the zoom").toBeCloseTo(zoom, 12);
	// Above 200 percent the layers and the cost are printed only: pinning the full size state there would pin the slow
	// state as correct. The values are in the result file.
	if (zoom > 2) return;
	expect(L.tile.w > 1 && L.tile.h > 1, `the wet tile is off at ${zoom}: every pen event draws into the full wet canvas`).toBe(true);
	expect(L.tail.tileW, "the tail has no compact tile").toBeGreaterThan(0);
	// A meter that saw no pen event passes the draw bound with 0: the stroke must have reached it.
	expect(meter.events, "the meter saw no pen event: the draw count below proves nothing").toBeGreaterThan(0);
	expect(meter.fullDraws, `a 160-move stroke drew ${meter.fullDraws} times into the full wet canvas`).toBeLessThanOrEqual(10);
}, 120_000);
