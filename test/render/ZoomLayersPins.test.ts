/**
 * The small live pen layers across note zoom, in Chromium: pinned on at every arm, from 100 percent to the pinch
 * ceiling of 800 percent.
 *
 * The raster scale is b = dpr x min(zoom, MAX_ZOOM_BACKING). That cap was 2 when this cell was written: above 200
 * percent b stayed at 2 x dpr, f = zoom x dpr / b = zoom / 2 was not 1, and at a ratio with no exact grid the live
 * layers stayed full size. It is now the pinch ceiling (6 when written, 8 now), so f is 1 at every arm here, as it is up to 200 percent:
 * a backing px is a displayed device px, and the wet tile and compact tail are on (an exact grid, or the grid 1
 * fallback). The area cap never binds on this pane. The cell pins that state at every arm, so a later change to the
 * live layers, or to how much of the zoom is spent on resolution, has to move these numbers on purpose.
 *
 * Asserted per arm: the wet tile is on, the tail has a compact tile, a 160-move stroke draws at most 10 times into the
 * full wet canvas, and the backing is ratio x zoom (f = 1). The backing check comes last, so at ratio 2, where the tile
 * still finds a grid with the cap at 2, it is the line that reads a lost zoom; at ratio 1.8257 the tile line reads it
 * first. 2.5 and 3.5 were printed and not pinned while the cap was 2, when that range was the full size state at ratio
 * 1.8257; 2, 4 and 8 are the boundary, a middle arm and the ceiling, and 6 the old ceiling.
 *
 * Arms: ratio 2 and ratio 1.8257, each at note zoom 1.5, 1.79, 1.95, 2, 2.5, 3.5, 4, 6 and 8, and 1 as the base case (the
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
 *
 * The text column: every page carries the owned `.cm-content` column rule, read verbatim from styles.css, as the app
 * does (the same load as ZoomSharpInk800). Without it the rig's column is only CodeMirror's memo of its widest line,
 * which it drops past 600 percent on this pane: the text wraps to the pane and the tear anchor finds no line in the DOM.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { penPress, penMove, penRelease, linePoints } from "./cdpPen";

declare const process: { env: Record<string, string | undefined> };
const root = fileURLToPath(new URL("../../", import.meta.url));
let overlayBundle: string;
let ownedColumnRule = "";
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
	// The owned column rule as the app loads it: the styles.css block whose first selector is `head`, through its
	// closing brace. Exactly one match, and the width pins present, or the run stops.
	const css = readFileSync(root + "styles.css", "utf8").replace(/\r\n/g, "\n");
	const head = ".cm-editor.handwriting-note-viewport:not(.handwriting-note-viewport-own-lines) > .cm-scroller > .cm-content,\n";
	const at = css.indexOf(head);
	if (at < 0 || css.indexOf(head, at + 1) >= 0) throw new Error("styles.css: the owned column rule must match exactly once");
	ownedColumnRule = css.slice(at, css.indexOf("}", at) + 1);
	if (!ownedColumnRule.includes("min-width: var(--handwriting-note-column-width);") || !ownedColumnRule.includes("max-width: var(--handwriting-note-column-width);")) throw new Error("styles.css: the owned column rule no longer pins the width");
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
const ZOOMS = [1, 1.5, 1.79, 1.95, 2, 2.5, 3.5, 4, 6, 8];
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
		await page.addStyleTag({ content: ownedColumnRule });
		const read = await page.evaluate(([p, k]) => (window as any).scrollColumnAnchor.runTearMount(k, 0, p, true, { fx: 0.5, fy: 0.5 }), [pane, zoom] as const);
		// The rule resolved on this page's DOM: `.cm-content`'s min-width is the column the overlay wrote. At 100 percent
		// the overlay writes no column (nothing to hold), so the rule is inert there; above it the column must be written.
		const column = await page.evaluate(() => {
			const host = document.querySelector(".cm-editor") as HTMLElement, content = document.querySelector(".cm-content") as HTMLElement;
			return { want: host.style.getPropertyValue("--handwriting-note-column-width").trim(), minWidth: getComputedStyle(content).minWidth };
		});
		if (column.want ? column.minWidth !== column.want : zoom > 1) throw new Error(`the owned column rule did not resolve at ${zoom}: ${JSON.stringify(column)}`);
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

for (const dsf of RATIOS) for (const zoom of ZOOMS) it(`ratio ${dsf}, note zoom ${zoom}: the small pen layers are on`, async () => {
	const { layers: L, meter } = await arm(dsf, zoom);
	// eslint-disable-next-line no-console
	console.log(`ZOOM LAYERS [real flag --force-device-scale-factor=${dsf}] zoom ${zoom}: layers ${JSON.stringify(L)} cost ${JSON.stringify(meter)}`);
	expect(L.dpr, "the rig does not hold the device ratio").toBe(dsf);
	expect(L.pinchScaleNow, "the note did not reach the zoom").toBeCloseTo(zoom, 12);
	expect(L.tile.w > 1 && L.tile.h > 1, `the wet tile is off at ${zoom}: every pen event draws into the full wet canvas`).toBe(true);
	expect(L.tail.tileW, "the tail has no compact tile").toBeGreaterThan(0);
	// A meter that saw no pen event passes the draw bound with 0: the stroke must have reached it.
	expect(meter.events, "the meter saw no pen event: the draw count below proves nothing").toBeGreaterThan(0);
	expect(meter.fullDraws, `a 160-move stroke drew ${meter.fullDraws} times into the full wet canvas`).toBeLessThanOrEqual(10);
	// f = 1: all of the zoom is spent on resolution, so a backing px is a displayed device px. Last on purpose: at
	// ratio 2 a capped backing still leaves the tile a grid, and this is the line that reads it.
	expect(L.backing, `the backing is ${L.backing} at ratio ${dsf}, zoom ${zoom}: not ratio x zoom, so the ink is a smaller raster stretched to the zoom`).toBeCloseTo(dsf * zoom, 9);
}, 120_000);
