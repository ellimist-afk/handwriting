/**
 * Z10 RECORDER RUN: the far and fractional LagAtLowZoom arms with every camera
 * sync's ladder terms recorded (`z10Recorder.ts`), written to disk for the
 * offline reconstruction to be checked against live doubles.
 *
 * NOT A GATE TEST. It asserts liveness only: the recorder saw syncs, the
 * ladder was read, the arm reached its extent. The camera verdicts stay in
 * `LagAtLowZoom.test.ts`. It runs only when HW_Z10_OUT names an output
 * directory, so `npm run test:render` skips it.
 *
 * Cells:
 *  - the five LagAtLowZoom rows that are red on eb9e7239: far 0.1/11482 IC on
 *    and off, far 0.1/22964, fractional 0.15/both IC on and off;
 *  - a phase sweep at 0.1 whose extents put the band on rungs with
 *    n mod 5 = 3 and 4, where a 1/64 floor and a 1/64 round disagree;
 *  - the transform host on the same commit (base control) at 0.1/11482;
 *  - zoom 1 fractional, where the model predicts no snap and no scale term;
 *  - the bypass guards: a planted exact-range limit, an ancestor transform, and
 *    a real device scale factor of 1.25, each of which must keep the ladder;
 *  - a real device scale factor of 2, Orion's 1/128 px layout grid.
 */

import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };
const OUT = process.env.HW_Z10_OUT;
let browser: Browser, script: string;

beforeAll(async () => {
	if (!OUT) return;
	mkdirSync(OUT, { recursive: true });
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./scrollColumnAnchorPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

// REAL device scale factors, one browser each: the launch flag reaches Blink's layout zoom factor, where Playwright's
// `deviceScaleFactor` emulation does not (measured: emulated 1.25 keeps the 1/64 css grid, the flag at 1.25 does not).
const realBrowsers = new Map<number, Browser>();
async function browserFor(realDsf?: number): Promise<Browser> {
	if (realDsf === undefined) return browser;
	let b = realBrowsers.get(realDsf);
	if (!b) { b = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${realDsf}`, "--window-size=1500,900"] }); realBrowsers.set(realDsf, b); }
	return b;
}

afterAll(async () => { await browser?.close(); for (const b of realBrowsers.values()) await b.close(); });

type Cell = { name: string; zoom: number; infiniteCanvas: boolean; farVisual?: number; transformHost?: boolean; dsf?: number; realDsf?: number; plantLimit?: number; external?: number; resizeBy?: number };

// Same page, same stylesheet, same options as LagAtLowZoom's `arm` and `farExtentArm`, plus `z10`.
async function record(cell: Cell): Promise<any> {
	const page = cell.realDsf !== undefined
		? await (await (await browserFor(cell.realDsf)).newContext({ viewport: null })).newPage()
		: await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: cell.dsf ?? 2 });
	try {
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(e.message));
		await page.setContent('<!doctype html><body style="margin:0"></body>');
		await page.addStyleTag({
			content: css + readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8") + REAL_OBSIDIAN_CSS,
		});
		await page.addScriptTag({ content: script });
		const far = cell.farVisual !== undefined;
		const options = { axis: "both", infiniteCanvas: cell.infiniteCanvas, routed: true, far: true, rapid: true, frames: 30, distance: 39, pixels: true,
			...(far ? { farVisual: cell.farVisual, host: false, fitCommit: false } : {}), z10: true, z10TransformHost: !!cell.transformHost, z10PlantLimit: cell.plantLimit, z10External: cell.external, z10ResizeBy: cell.resizeBy };
		const t0 = Date.now();
		const r = await page.evaluate(
			a => (window as any).scrollColumnAnchor.run(true, "lagFlingDense", a.zoom, false, false, 0, .25, a.options),
			{ zoom: cell.zoom, options }
		);
		const summary = {
			cell, wallMs: Date.now() - t0, errors, farReached: r.farReached,
			rounds: r.rounds.map((x: any) => ({ round: x.round, full: x.scroll.full, bandMoved: x.scroll.bandMoved,
				cameraOnly: x.scroll.cameraChangesWithoutBand.length, maxFrameDeltaVisual: x.scroll.camera.maxFrameDeltaVisual,
				changes: x.scroll.cameraChangesWithoutBand, drawCameraOnly: x.draw.cameraChangesWithoutBand.length })),
			z10Rows: r.z10?.rows.length ?? 0, z10Anchor: r.z10?.rows.reduce((n: number, row: any) => n + row.anchor.length, 0) ?? 0,
			refusals: r.z10?.refusalLog ?? null, installedAt: r.z10?.installedAt ?? null,
		};
		// The recording and the arm's own camera verdict rows, in one file per cell.
		writeFileSync(`${OUT}/${cell.name}.json`, JSON.stringify({ summary, z10: r.z10, rounds: r.rounds.map((x: any) => ({ round: x.round, scroll: x.scroll })) }));
		// eslint-disable-next-line no-console
		console.log(`Z10 ${cell.name} rows=${summary.z10Rows} anchorCalls=${summary.z10Anchor} refusals=${JSON.stringify(summary.refusals)} ` +
			`rounds=${JSON.stringify(summary.rounds.map((x: any) => [x.full, x.bandMoved, x.cameraOnly]))} wallMs=${summary.wallMs}`);
		return { r, summary };
	} finally {
		await page.close();
	}
}

const CELLS: Cell[] = [
	{ name: "far-0.1-11482-ic", zoom: .1, infiniteCanvas: true, farVisual: 11482 },
	{ name: "far-0.1-22964-ic", zoom: .1, infiniteCanvas: true, farVisual: 22964 },
	{ name: "frac-0.15-both-ic", zoom: .15, infiniteCanvas: true },
	// Phase sweep. The band re-pins about 2050 layout px above scrollTop on the 11482 arm (camera y 113798 at
	// scrollTop 115850), so these extents put the camera near rungs 58 and 59 (n mod 5 = 3, 4). Which rungs are
	// actually visited is read from the rows, not assumed from this comment.
	{ name: "sweep-0.1-12080-ic", zoom: .1, infiniteCanvas: true, farVisual: 12080 },
	{ name: "sweep-0.1-12290-ic", zoom: .1, infiniteCanvas: true, farVisual: 12290 },
	{ name: "base-transform-0.1-11482-ic", zoom: .1, infiniteCanvas: true, farVisual: 11482, transformHost: true },
	{ name: "unit-1-both-ic", zoom: 1, infiniteCanvas: true },
	// THE BYPASS GUARDS, each a cell whose rows must show the ladder path running as it did before the fix:
	// a planted exact-range limit below this arm's zoomed coordinate (about 11585 px);
	{ name: "guard-limit-2e13-far-0.1-11482-ic", zoom: .1, infiniteCanvas: true, farVisual: 11482, plantLimit: 2 ** 13 },
	// an ancestor transform (a non-zoom factor in the rect);
	{ name: "guard-external-0.9-frac-0.1-both-ic", zoom: .1, infiniteCanvas: true, external: .9 },
	// a real layout zoom factor that is not a power of two: display scaling 125%, the proxy for page zoom 80/125.
	{ name: "guard-realdsf1.25-far-0.1-11482-ic", zoom: .1, infiniteCanvas: true, farVisual: 11482, realDsf: 1.25 },
	{ name: "guard-realdsf1.25-frac-0.15-both-ic", zoom: .15, infiniteCanvas: true, realDsf: 1.25 },
	// THE DEVICE GRID: a real factor of 2 lays out on 1/128 css px (Orion's regime); the bypass applies there.
	{ name: "realdsf2-far-0.1-11482-ic", zoom: .1, infiniteCanvas: true, farVisual: 11482, realDsf: 2 },
	{ name: "realdsf2-frac-0.15-both-ic", zoom: .15, infiniteCanvas: true, realDsf: 2 },
	// A real layout zoom factor of 1 (the launch flag, not emulation): the guard admits dpr 1 and its exact-range
	// limit takes the 2^18 / 1 branch, which no dpr-2 cell reaches.
	{ name: "realdsf1-far-0.1-11482-ic", zoom: .1, infiniteCanvas: true, farVisual: 11482, realDsf: 1 },
	// C1's resize path (measureNaturalColumn takes the plugin's zoom off the host and applyViewportBox writes it back),
	// run at the committed 10% before the far scroll: the bypass must still answer on every zoom-host read after it.
	{ name: "resize-40-far-0.1-11482-ic", zoom: .1, infiniteCanvas: true, farVisual: 11482, resizeBy: 40 },
	// The two canvas-off cells that stood here are retired. With the Infinite Canvas off the
	// product ignores every pinch phase, so they recorded a note at 100 percent while their names said
	// 0.1 and 0.15, and no assertion in the cell reads the scale. Their canvas-on twins far-0.1-11482-ic
	// and frac-0.15-both-ic make the same claim. See RETIRED-CELLS.md.
];

it.skipIf(!OUT).each(CELLS)("z10 recorder: $name", async cell => {
	const { r, summary } = await record(cell);
	expect(summary.errors, "page errors").toEqual([]);
	// LIVENESS: the recorder saw this overlay's syncs and the ladder was consulted at least once.
	expect(summary.z10Rows, "syncs recorded").toBeGreaterThan(10);
	expect(summary.z10Anchor, "anchorCameraY calls recorded").toBeGreaterThan(0);
	// The resize cell's term firing: C1's measurement ran with a box (the resize path) after takeover.
	if (cell.resizeBy) expect((r.z10?.measureCalls ?? []).filter((c: any) => c.box).length, "resize took measureNaturalColumn with a box").toBeGreaterThan(0);
	if (cell.farVisual !== undefined && cell.external === undefined) {
		expect(Math.abs(r.farReached.visualTop - cell.farVisual), "scrollTop reached the extent").toBeLessThan(2);
	}
}, 300_000);
