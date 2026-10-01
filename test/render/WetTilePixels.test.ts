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

type Result = { hasContract: boolean; origin: { x: number; y: number } | null; maxDiff: number; over: number; offInk: number; onFullInk: number; tile: { width: number; height: number } };
let browser: Browser, page: Page;

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
}, 120_000);
afterAll(async () => { await browser?.close(); });

const compare = (config: { width: number; height: number; backing: number }, points: { x: number; y: number; pressure: number }[]) =>
	page.evaluate(({ config, points }) => (window as any).wetTilePage.compare(config, points), { config, points }) as Promise<Result>;

const across = Array.from({ length: 150 }, (_, i) => ({ x: 60 + i * 6, y: 60 + i * 2 + Math.sin(i / 7) * 20, pressure: 0.3 + 0.5 * Math.abs(Math.sin(i / 11)) }));
const inside = Array.from({ length: 25 }, (_, i) => ({ x: 100 + i * 3, y: 100 + i * 2, pressure: 0.6 }));

describe("arm E: wet tile pixels", () => {
	for (const backing of [1, 1.5, 2]) {
		it(`a stroke crossing the tile edge looks the same as tile off, backing ${backing}`, async () => {
			const r = await compare({ width: 1000, height: 600, backing }, across);
			expect(r.hasContract, "the tile contract is missing").toBe(true);
			expect(r.offInk, "the tile-off stroke drew nothing").toBeGreaterThan(1000);
			expect(r.onFullInk, "the stroke never crossed the tile edge: nothing was copied into the full canvas").toBeGreaterThan(0);
			expect(r.origin, "no tile origin").not.toBeNull();
			expect(r.maxDiff, `tile on differs from tile off at ${r.over} pixels`).toBeLessThanOrEqual(2);
		});
	}

	it("a stroke inside one tile looks the same as tile off", async () => {
		const r = await compare({ width: 1000, height: 600, backing: 2 }, inside);
		expect(r.hasContract, "the tile contract is missing").toBe(true);
		expect(r.offInk).toBeGreaterThan(100);
		expect(r.onFullInk, "a stroke inside one tile wrote the full canvas").toBe(0);
		expect(r.maxDiff, `tile on differs from tile off at ${r.over} pixels`).toBeLessThanOrEqual(2);
	});
});
