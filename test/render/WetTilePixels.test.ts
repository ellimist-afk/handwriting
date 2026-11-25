/**
 * Arm E, pixels: a stroke that crosses the wet tile's edge must look the
 * same as the same stroke with the tile off, before the lift. What the user
 * sees with the tile on is the full wet canvas with the tile over it at the
 * tile origin; that is compared with the tile-off full wet canvas, per
 * backing pixel, max channel difference 2.
 *
 * The plant owed by the arm: drop the copy of the tile
 * into the full canvas when the origin moves (the flush). The ink drawn
 * before the move is then missing, and "crossing the edge" goes red.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

declare const process: { env: Record<string, string | undefined> };

type Result = { hasContract: boolean; origin: { x: number; y: number } | null; maxDiff: number; over: number; offInk: number; onFullInk: number; rawMaxDiff: number; rawOver: number; overPixels: unknown[]; rawOverPixels: unknown[]; tile: { width: number; height: number } };
/** Both measures, one line: the seen-over-paper one the cells assert and the raw stored-channel one. */
const measures = (r: Result) => `maxDiff ${r.maxDiff} over ${r.over} rawMaxDiff ${r.rawMaxDiff} rawOver ${r.rawOver} overPixels ${JSON.stringify(r.overPixels)} rawOverPixels ${JSON.stringify(r.rawOverPixels)}`;
let browser: Browser, page: Page;
/** The page bundle, kept for the note zoom cells, which launch their own browsers at a device ratio. */
let bundleText = "";
const ratioBrowsers = new Map<number, Browser>();

beforeAll(async () => {
	const entry = fileURLToPath(new URL("./wetTilePage.ts", import.meta.url));
	const nodeModules = process.env.HW_TAIL_TEST_NODE_MODULES;
	const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		nodePaths: nodeModules ? [nodeModules] : undefined,
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	browser = await chromium.launch({ headless: true });
	page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
	await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
	await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
	bundleText = bundle.outputFiles[0]!.text;
}, 120_000);
afterAll(async () => { await browser?.close(); for (const b of ratioBrowsers.values()) await b.close(); });

const compare = (config: { width: number; height: number; backing: number }, points: { x: number; y: number; pressure: number }[]) =>
	page.evaluate(({ config, points }) => (window as any).wetTilePage.compare(config, points), { config, points }) as Promise<Result>;

const across = Array.from({ length: 150 }, (_, i) => ({ x: 60 + i * 6, y: 60 + i * 2 + Math.sin(i / 7) * 20, pressure: 0.3 + 0.5 * Math.abs(Math.sin(i / 11)) }));
const inside = Array.from({ length: 25 }, (_, i) => ({ x: 100 + i * 3, y: 100 + i * 2, pressure: 0.6 }));

describe("arm E: wet tile pixels", () => {
	for (const backing of [1, 1.5, 2]) {
		it(`a stroke crossing the tile edge looks the same as tile off, backing ${backing}`, async () => {
			const r = await compare({ width: 1000, height: 600, backing }, across);
			// eslint-disable-next-line no-console
			console.log(`WET TILE PIXELS arm E across, backing ${backing}: ${measures(r)}`);
			expect(r.hasContract, "the tile contract is missing").toBe(true);
			expect(r.offInk, "the tile-off stroke drew nothing").toBeGreaterThan(1000);
			expect(r.onFullInk, "the stroke never crossed the tile edge: nothing was copied into the full canvas").toBeGreaterThan(0);
			expect(r.origin, "no tile origin").not.toBeNull();
			expect(r.maxDiff, `tile on differs from tile off at ${r.over} pixels`).toBeLessThanOrEqual(2);
		});
	}

	it("a stroke inside one tile looks the same as tile off", async () => {
		const r = await compare({ width: 1000, height: 600, backing: 2 }, inside);
		// eslint-disable-next-line no-console
		console.log(`WET TILE PIXELS arm E inside, backing 2: ${measures(r)}`);
		expect(r.hasContract, "the tile contract is missing").toBe(true);
		expect(r.offInk).toBeGreaterThan(100);
		expect(r.onFullInk, "a stroke inside one tile wrote the full canvas").toBe(0);
		expect(r.maxDiff, `tile on differs from tile off at ${r.over} pixels`).toBeLessThanOrEqual(2);
	});
});

/**
 * The same comparison above 200 percent note zoom, where a backing px is still a displayed device px but the
 * backing is large. Each row is the band the real overlay sizes at that zoom on the zoom pins' tablet pane
 * (ZoomLayersPins.test.ts), in a browser launched with the real device ratio, with the zoom and a zoom host passed
 * as the overlay passes them, so the tile finds the grid it finds in the app. The stroke spans most of the band and
 * crosses the tile edge, so ink is copied into the full canvas at least once. Same contract: diff 2 seen over paper
 * (alpha, and colour times alpha), as wetTilePage.ts measures it.
 */
const ODD_RATIO = 1.8257418870925903;
const ZOOM_ROWS: { dpr: number; zoom: number; band: [number, number] }[] = [
	{ dpr: 2, zoom: 2.5, band: [3555, 2730] },
	{ dpr: 2, zoom: 6, band: [3552, 2736] },
	{ dpr: 2, zoom: 8, band: [3568, 2752] },
	{ dpr: ODD_RATIO, zoom: 8, band: [3257, 2512] },
];

async function ratioPage(dsf: number): Promise<Page> {
	let b = ratioBrowsers.get(dsf);
	if (!b) {
		b = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${dsf}`, "--window-size=1400,900"] });
		ratioBrowsers.set(dsf, b);
	}
	const p = await (await b.newContext({ viewport: null })).newPage();
	await p.setContent("<!doctype html><html><body style='margin:0'></body></html>");
	await p.addScriptTag({ content: bundleText });
	return p;
}

describe("wet tile pixels above 200 percent note zoom", () => {
	for (const row of ZOOM_ROWS) {
		const backing = row.dpr * row.zoom;
		it(`ratio ${row.dpr}, note zoom ${row.zoom}, backing ${backing}: a stroke crossing the tile edge looks the same as tile off`, async () => {
			const width = row.band[0] / backing, height = row.band[1] / backing;
			const stroke = Array.from({ length: 150 }, (_, i) => ({
				x: width * (0.1 + 0.8 * i / 149),
				y: height * (0.2 + 0.5 * i / 149) + Math.sin(i / 7) * height * 0.03,
				pressure: 0.3 + 0.5 * Math.abs(Math.sin(i / 11)),
			}));
			const p = await ratioPage(row.dpr);
			try {
				const dpr = await p.evaluate(() => window.devicePixelRatio);
				expect(dpr, "the rig does not hold the device ratio").toBe(row.dpr);
				const r = await p.evaluate(({ config, points }) => (window as any).wetTilePage.compare(config, points),
					{ config: { width, height, backing, cssScale: row.zoom, hostZoom: true }, points: stroke }) as Result;
				// eslint-disable-next-line no-console
				console.log(`WET TILE PIXELS ratio ${row.dpr} zoom ${row.zoom} backing ${backing}: tile ${JSON.stringify(r.tile)} origin ${JSON.stringify(r.origin)} offInk ${r.offInk} onFullInk ${r.onFullInk} ${measures(r)}`);
				expect(r.hasContract, "the tile contract is missing").toBe(true);
				expect(r.tile.width > 1 && r.tile.height > 1, `the wet tile is off at ${row.zoom}: the comparison would be full canvas against full canvas`).toBe(true);
				expect(r.offInk, "the tile-off stroke drew nothing").toBeGreaterThan(1000);
				expect(r.onFullInk, "the stroke never crossed the tile edge: nothing was copied into the full canvas").toBeGreaterThan(0);
				expect(r.origin, "no tile origin").not.toBeNull();
				expect(r.maxDiff, `tile on differs from tile off at ${r.over} pixels`).toBeLessThanOrEqual(2);
			} finally {
				await p.context().close();
			}
		}, 120_000);
	}
});
