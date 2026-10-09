/**
 * PR 31 reader, cell 1 in pixels: the 1.4.22 ink fixture
 * painted by today's committed renderer equals, pixel for pixel, the draw
 * 1.4.22 itself recorded (test/fixtures/pressure-mark-1.4.22.json, frozen by
 * executing refs/tags/1.4.22), with pressure on and with it off. No stroke in
 * the fixture carries the pressure mark, so the switch alone decides, as it
 * did in 1.4.22.
 *
 * The plant owed: an absent mark read as "off". Pressure on then paints the
 * even line and "pressure on" goes red.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import frozen from "../fixtures/pressure-mark-1.4.22.json";

declare const process: { env: Record<string, string | undefined> };

let browser: Browser, page: Page;

beforeAll(async () => {
	const entry = fileURLToPath(new URL("./pressureMarkPage.ts", import.meta.url));
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

describe("a 1.4.22 ink file paints pixel for pixel as 1.4.22 painted it", () => {
	for (const pressureOn of [true, false]) {
		it(`pressure ${pressureOn ? "on" : "off"}`, async () => {
			const r = (await page.evaluate(({ stored, cases, pressureOn }) =>
				(window as any).pressureMarkPage.compare(stored, cases, pressureOn),
				{ stored: frozen.stored, cases: frozen.cases, pressureOn })) as { over: number; ink: number; maxDiff: number };
			expect(r.ink, "the 1.4.22 replay drew nothing").toBeGreaterThan(1000);
			expect(r.over, `today's paint differs from 1.4.22's at ${r.over} channel values (max ${r.maxDiff})`).toBe(0);
		});
	}
});
