/**
 * The small live canvases on a pane that measures a hair off 1, and no shift
 * at the lift.
 *
 * The overlay measures its scale as rect width over offsetWidth. A device at
 * 100% measured 0.9999960866 and 0.9998392990: off in the fourth to sixth
 * decimal, a scale with no pixel grid, so the wet tile was 1 x 1 and the tail a
 * full-size layer and every pen event drew into full-size canvases. The owned
 * scale (1) now builds the backing and both grids. The rig reproduces each
 * measured scale exactly with a scale() on the page body (the band's own width
 * is a whole css px here, as on the device: 1596 there).
 *
 * Three reads, at device pixel ratio 2, on the real overlay in Chromium:
 * - PREMISE: the overlay measures the device's scale (to 6 decimals), so the
 *   rig holds the device's condition.
 * - TILES: the wet tile's backing is 512 x 512 and the tail has a grid.
 * - LIFT: one real pen stroke, screenshotted with the pen down (wet ink) and
 *   after the lift (committed ink): the stroke's start edge, top edge and
 *   bottom edge sit on the same device px in both. The far end is not read:
 *   the prediction tail runs ahead of the pen while it is down.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { penPress, penMove, penRelease, linePoints } from "./cdpPen";
import { decodePng, isInkLoose, type Decoded } from "./pngInk";

declare const process: { env: Record<string, string | undefined> };
const root = fileURLToPath(new URL("../../", import.meta.url));
let browser: Browser, bundle: string;

beforeAll(async () => {
	browser = await chromium.launch({ headless: true });
	bundle = (await build({
		entryPoints: [root + "test/render/scrollColumnAnchorPage.ts"], bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: root + "test/render/iphoneObsidianStub.ts" },
	})).outputFiles[0]!.text;
}, 180_000);
afterAll(async () => { await browser?.close(); });

/** First and last ink column in the clip's start region, and first and last ink row, in device px of the clip. */
function edges(d: Decoded, startCols: number) {
	let left = Infinity, top = Infinity, bottom = -Infinity, n = 0;
	for (let py = 0; py < d.height; py++) for (let px = 0; px < d.width; px++) {
		if (!isInkLoose(d, (py * d.width + px) * d.channels, "blue")) continue;
		n++;
		left = Math.min(left, px);
		if (px < startCols) { top = Math.min(top, py); bottom = Math.max(bottom, py); }
	}
	return { n, left, top, bottom };
}

/** The two scales a device measured at 100%. */
const DEVICE_SCALES = [0.9999960866, 0.999839299] as const;
const pane = { w: 945, h: 834 };

for (const measured of DEVICE_SCALES) it(`measured ${measured}, ratio 2: the wet tile is on, the tail has a grid, and the lift moves no edge of the stroke`, async () => {
	const page = await browser.newPage({ viewport: { width: 1300, height: 900 }, deviceScaleFactor: 2 });
	try {
		await page.addStyleTag({ content: `body { transform: scale(${measured}); transform-origin: 0 0; }` });
		await page.addScriptTag({ content: bundle });
		const read = await page.evaluate(([p]) => (window as any).scrollColumnAnchor.runTearMount(1, 0, p, true, { fx: 0.5, fy: 0.5 }), [{ w: pane.w, h: pane.h }]);
		// eslint-disable-next-line no-console
		console.log(`SNAP ${measured}: cssScale=${read.cssScale}`);
		expect(read.cssScale, "the rig does not measure the device's scale").toBeCloseTo(measured, 6);

		const tiles = await page.evaluate(() => (window as any).scrollColumnAnchor.runTileRead([], false));
		const wetTile = (tiles.canvases as { field: string | null; backing: { w: number; h: number } }[]).find(c => c.field === "wetTileCanvas");
		// eslint-disable-next-line no-console
		console.log(`SNAP ${measured}: wet tile ${JSON.stringify(wetTile?.backing)} tail ${JSON.stringify(tiles.tailBacking)}`);
		expect(wetTile?.backing, "the wet tile is off (1 x 1): every pen event draws into the full wet canvas").toEqual({ w: 512, h: 512 });
		expect(tiles.tailBacking?.grid ?? null, "the tail has no grid: it stays a full-size layer").not.toBeNull();

		const r = read.rects.pane as { l: number; t: number; w: number; h: number };
		const y = Math.round(r.t + r.h * 0.3), x0 = Math.round(r.l + 120), x1 = x0 + 240;
		const clip = { x: x0 - 40, y: y - 40, width: 320, height: 80 };
		const cdp = await page.context().newCDPSession(page);
		const points = linePoints({ x: x0, y }, { x: x1, y: y + 12 }, 24);
		await penPress(cdp, points[0]!.x, points[0]!.y, { pressure: 0.6 });
		let wet: Decoded;
		try {
			for (const p of points.slice(1)) await penMove(cdp, p.x, p.y, { pressure: 0.6 });
			await page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))));
			wet = decodePng(await page.screenshot({ clip }));
		} finally {
			await penRelease(cdp, points.at(-1)!.x, points.at(-1)!.y);
		}
		await page.evaluate(() => new Promise(res => setTimeout(res, 300)));
		await page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))));
		const committed = decodePng(await page.screenshot({ clip }));
		const startCols = 2 * 80;
		const before = edges(wet, startCols), after = edges(committed, startCols);
		// eslint-disable-next-line no-console
		console.log(`SNAP ${measured}: wet ${JSON.stringify(before)} committed ${JSON.stringify(after)}`);
		expect(before.n, "no wet ink on screen with the pen down").toBeGreaterThan(0);
		expect(after.n, "no committed ink on screen after the lift").toBeGreaterThan(0);
		expect({ left: after.left, top: after.top, bottom: after.bottom }, "the lift moved the stroke's start, top or bottom edge")
			.toEqual({ left: before.left, top: before.top, bottom: before.bottom });
		await page.evaluate(() => (window as any).scrollColumnAnchor.runTearTeardown());
	} finally {
		await page.close();
	}
}, 120_000);
