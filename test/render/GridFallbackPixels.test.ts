/**
 * The small live canvases at a device ratio with no whole 1/64 px grid, in
 * Chromium, and no shift between the tile and the full canvas.
 *
 * A 200% display at a 91.3% page zoom reports devicePixelRatio
 * 1.8257418870925903. With no exact grid the wet tile was 1 x 1 and the tail a
 * full-size layer. Grid 1 now holds when the box is not transform-scaled and a
 * backing px is a displayed device px. The same applies at a free pinch zoom
 * (0.518, 0.8734) at ratio 2; Fit at 0.08 is read beside them. The pen arms
 * are 1.8257 at 100% and 0.8734 at ratio 2, with ratio 2 at 100% (an exact
 * grid) as the control; at 0.518 and Fit the tile moves on before the read
 * window, so those are read on the renderer pages only.
 *
 * Per arm, on the real overlay:
 * - TILES: the wet tile is on at 256 css px rounded up to whole backing px,
 *   and the tail has a grid and a compact tile.
 * - PLACEMENT: while the pen is down the tile's on-screen rect, in device px
 *   from the wet canvas's rect, is its origin in backing px, and its size is
 *   its backing size (a backing px is a device px).
 * - ZERO SNAP: one real pen stroke, screenshotted pen down and after the lift,
 *   once with the tile and once on the full-canvas arm (tile off, tail full):
 *   the start, top and bottom edges match between pen down and lift in each
 *   arm, and between the arms; the stroke's ink centre row moves at the lift by
 *   no more on the tile arm than on the full arm.
 * - COST: draws into the full wet canvas per pen event and penRaw time, printed.
 *
 * Device ratio regime: every page runs in a browser launched with the real
 * --force-device-scale-factor flag and no viewport (window-size only), never
 * Playwright's deviceScaleFactor emulation, which does not place layers on
 * device px the way the real flag does.
 *
 * And per configuration on the renderer pages, no overlay:
 * - WET TILE PIXELS: a stroke drawn tile on and tile off, compared per backing px.
 * - TAIL AND CARRY: the compact tail against the full-size tail on screen,
 *   before and after a band carry under a live head.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { penPress, penMove, penRelease, linePoints } from "./cdpPen";
import { decodePng, isInkLoose, type Decoded } from "./pngInk";

declare const process: { env: Record<string, string | undefined> };
const root = fileURLToPath(new URL("../../", import.meta.url));
let overlayBundle: string, tailBundle: string, wetBundle: string;
const browsers = new Map<number, Browser>();
/** A page in a browser launched with the real device scale factor flag, viewport from the window. */
async function pageAt(dsf: number): Promise<Page> {
	let b = browsers.get(dsf);
	if (!b) {
		b = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${dsf}`, "--window-size=1300,900"] });
		browsers.set(dsf, b);
	}
	const ctx = await b.newContext({ viewport: null });
	return ctx.newPage();
}

const ODD_DPR = 1.8257418870925903;

/** HW_GFP_LOOP=N adds the loop cell at the end of this file; unset, nothing here changes. */
const LOOP = Math.max(1, Math.floor(Number(process.env.HW_GFP_LOOP ?? 1)) || 1);

beforeAll(async () => {
	const bundle = async (entry: string) => (await build({
		entryPoints: [root + entry], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		nodePaths: process.env.HW_TAIL_TEST_NODE_MODULES ? [process.env.HW_TAIL_TEST_NODE_MODULES] : undefined,
		alias: { obsidian: root + "test/render/iphoneObsidianStub.ts" },
	})).outputFiles[0]!.text;
	overlayBundle = await bundle("test/render/gridFallbackPage.ts");
	tailBundle = await bundle("test/render/tailBackingPage.ts");
	wetBundle = await bundle("test/render/wetTilePage.ts");
}, 180_000);
afterAll(async () => { for (const b of browsers.values()) await b.close(); });

type Arm = { name: string; dsf: number; pinch: number; fit?: number };
const ARMS: Arm[] = [
	{ name: `ratio ${ODD_DPR}, 100%`, dsf: ODD_DPR, pinch: 1 },
	{ name: "ratio 2, pinch 0.8734", dsf: 2, pinch: 0.8734 },
	// Control: an exact grid, the tile on before this change.
	{ name: "ratio 2, 100% (exact grid)", dsf: 2, pinch: 1 },
];
const pane = { w: 945, h: 834 };

/** Ink edges in a clip, in device px: first ink column; first and last ink row in the start region; ink-weighted centre row there. */
function edges(d: Decoded, startCols: number) {
	let left = Infinity, top = Infinity, bottom = -Infinity, n = 0, wy = 0, w = 0;
	for (let py = 0; py < d.height; py++) for (let px = 0; px < d.width; px++) {
		const i = (py * d.width + px) * d.channels;
		if (px < startCols) {
			// Blue ink coverage: how far blue leads red and green (black or grey text adds nothing).
			const cover = Math.max(0, d.px[i + 2]! - Math.max(d.px[i]!, d.px[i + 1]!)) / 255;
			wy += cover * py; w += cover;
		}
		if (!isInkLoose(d, i, "blue")) continue;
		n++;
		left = Math.min(left, px);
		if (px < startCols) { top = Math.min(top, py); bottom = Math.max(bottom, py); }
	}
	return { n, left, top, bottom, centreY: w > 0 ? wy / w : NaN };
}

type Ink = { field: string; w: number; cx: number; cy: number };

/**
 * Blue ink on a whole-viewport shot over an absolute device px window: the sum
 * of coverage (blue's lead over red and green, as in edges()) and its centroid,
 * at pixel centres. Over white, coverage equals the layer's alpha when the
 * compositor copies the bitmap 1:1, so this sum equals the bitmap's alpha sum.
 */
function screenInk(d: Decoded, win: { x0: number; x1: number; y0: number; y1: number }) {
	let w = 0, wx = 0, wy = 0;
	for (let py = Math.max(0, Math.floor(win.y0)); py < Math.min(d.height, Math.ceil(win.y1)); py++) {
		for (let px = Math.max(0, Math.floor(win.x0)); px < Math.min(d.width, Math.ceil(win.x1)); px++) {
			const cx = px + 0.5, cy = py + 0.5;
			if (cx < win.x0 || cx >= win.x1 || cy < win.y0 || cy >= win.y1) continue;
			const i = (py * d.width + px) * d.channels;
			const cover = Math.max(0, d.px[i + 2]! - Math.max(d.px[i]!, d.px[i + 1]!)) / 255;
			w += cover; wx += cover * cx; wy += cover * cy;
		}
	}
	return { w, cx: wx / w, cy: wy / w };
}

type Layers = {
	dpr: number; cssScale: number; pinchScaleNow: number; backing: number; hostZoom: boolean;
	tile: { w: number; h: number; grid: number | null; on: boolean };
	tail: { w: number; h: number; grid: number | null; mode: string; tileW: number };
	band: { w: number; h: number };
};
type Meter = { events: number; fullDraws: number; perEvent: number; totalMs: number; p50: number; p90: number; max: number;
	tileGeom: { origin: { x: number; y: number } | null; backing: { w: number; h: number }; device: { x: number; y: number; w: number; h: number }; translate: string } | null };

type CommitCam = { x: number; y: number; zoom: number } | null;
type CommitSource = { flushes: number; strips: number; stripsOnTile: number;
	draws: { kind: "lift" | "repaint"; backing: number; cam: CommitCam; lastPaintCam: CommitCam; paintCam: CommitCam }[] };

/** Mount the arm, optionally switch to the full-canvas arm, draw one stroke, read layers, geometry, cost and screenshots. */
async function strokeArm(arm: Arm, full: boolean, capture: boolean | "late" = false) {
	const page = await pageAt(arm.dsf);
	try {
		await page.addScriptTag({ content: overlayBundle });
		const read = await page.evaluate(([p, k]) => (window as any).scrollColumnAnchor.runTearMount(k, 0, p, true, { fx: 0.5, fy: 0.5 }), [pane, arm.pinch] as const);
		if (arm.fit) await page.evaluate(k => (window as any).gridFallback.fitCommit(k), arm.fit);
		const layers = await page.evaluate(() => (window as any).gridFallback.layers()) as Layers;
		const fullArm = full ? await page.evaluate(() => (window as any).gridFallback.fullCanvasArm()) as { wetTile: boolean; tailTileW: number } : null;
		const r = read.rects.pane as { l: number; t: number; w: number; h: number };
		// A short stroke, so it stays inside one wet tile at 100%: its strips are on the tile when the pen-down shot is taken.
		const y = Math.round(r.t + r.h * 0.3), x0 = Math.round(r.l + 120), x1 = x0 + 90;
		const clip = { x: x0 - 40, y: y - 40, width: 200, height: 80 };
		const cdp = await page.context().newCDPSession(page);
		const points = linePoints({ x: x0, y }, { x: x1, y: y + 6 }, 30);
		if (capture === true) await page.evaluate(() => (window as any).gridFallback.sourceStart());
		await page.evaluate(() => (window as any).gridFallback.meterStart());
		await penPress(cdp, points[0]!.x, points[0]!.y, { pressure: 0.6 });
		let wet: Decoded;
		let meter: Meter;
		let tileInk: number | null = null;
		// The start region in absolute device px: the read window for the bitmap and screen ink sums.
		const win = { x0: clip.x * arm.dsf, x1: clip.x * arm.dsf + Math.round(arm.dsf * 60), y0: clip.y * arm.dsf, y1: (clip.y + clip.height) * arm.dsf };
		let down: { bitmap: Ink; screen: ReturnType<typeof screenInk> };
		try {
			for (const p of points.slice(1)) await penMove(cdp, p.x, p.y, { pressure: 0.6 });
			await page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))));
			wet = decodePng(await page.screenshot({ clip }));
			const downShot = decodePng(await page.screenshot());
			meter = await page.evaluate(() => (window as any).gridFallback.meterRead()) as Meter;
			// Read after the shots. On the tile arm the tile itself must hold the start region's ink (it moves on at low zoom).
			const bitmap = await page.evaluate(([f, w]) => (window as any).gridFallback.canvasInk(f, w), [full ? "wetCanvas" : "wetTileCanvas", win] as const) as Ink;
			down = { bitmap, screen: screenInk(downShot, win) };
			tileInk = full ? null : bitmap.w;
			if (capture === "late") await page.evaluate(() => (window as any).gridFallback.sourceStart());
		} finally {
			await penRelease(cdp, points.at(-1)!.x, points.at(-1)!.y);
		}
		await page.evaluate(() => new Promise(res => setTimeout(res, 300)));
		await page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))));
		const committed = decodePng(await page.screenshot({ clip }));
		const liftShot = decodePng(await page.screenshot());
		const lift = { bitmap: await page.evaluate(w => (window as any).gridFallback.canvasInk("committedCanvas", w), win) as Ink, screen: screenInk(liftShot, win) };
		const source = capture ? await page.evaluate(() => (window as any).gridFallback.sourceRead()) as CommitSource : null;
		const startCols = Math.round(arm.dsf * 60);
		await page.evaluate(() => (window as any).scrollColumnAnchor.runTearTeardown());
		return { layers, fullArm, meter, tileInk, down, lift, source, dpr: await page.evaluate(() => window.devicePixelRatio), wet: edges(wet, startCols), committed: edges(committed, startCols) };
	} finally {
		await page.context().close();
	}
}

/** One long stroke for the cost read: many pen events across the pane. */
async function costArm(arm: Arm) {
	const page = await pageAt(arm.dsf);
	try {
		await page.addScriptTag({ content: overlayBundle });
		const read = await page.evaluate(([p, k]) => (window as any).scrollColumnAnchor.runTearMount(k, 0, p, true, { fx: 0.5, fy: 0.5 }), [pane, arm.pinch] as const);
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
		const layers = await page.evaluate(() => (window as any).gridFallback.layers()) as Layers;
		await page.evaluate(() => (window as any).scrollColumnAnchor.runTearTeardown());
		return { meter, layers };
	} finally {
		await page.context().close();
	}
}

for (const arm of ARMS) it(`${arm.name}: tile and compact tail on, tile placed on device px, and no edge moves at the lift on the tile arm or against the full-canvas arm`, async () => {
	const tile = await strokeArm(arm, false, "late");
	const full = await strokeArm(arm, true, "late");
	// eslint-disable-next-line no-console
	console.log(`GRID LIFT INPUTS ${arm.name}: tile ${tile.committed.n < 0.95 * tile.wet.n ? "THIN" : "ok"} wet ${tile.wet.n} committed ${tile.committed.n} source ${JSON.stringify(tile.source)} | full wet ${full.wet.n} committed ${full.committed.n} source ${JSON.stringify(full.source)}`);
	const L = tile.layers;
	// eslint-disable-next-line no-console
	console.log(`GRID [real flag --force-device-scale-factor=${arm.dsf}] ${arm.name}: dpr ${tile.dpr} tile ink in window ${tile.tileInk} layers ${JSON.stringify(L)}`);
	// eslint-disable-next-line no-console
	console.log(`GRID [real flag] ${arm.name}: tile geom ${JSON.stringify(tile.meter.tileGeom)}`);
	// eslint-disable-next-line no-console
	console.log(`GRID [real flag] ${arm.name}: tile arm wet ${JSON.stringify(tile.wet)} committed ${JSON.stringify(tile.committed)}; full arm ${JSON.stringify(full.fullArm)} wet ${JSON.stringify(full.wet)} committed ${JSON.stringify(full.committed)}`);
	const sums = (x: { bitmap: Ink; screen: ReturnType<typeof screenInk> }) =>
		`${x.bitmap.field} bitmap ${x.bitmap.w} screen ${x.screen.w} (screen minus bitmap centroid ${(x.screen.cx - x.bitmap.cx).toFixed(4)}, ${(x.screen.cy - x.bitmap.cy).toFixed(4)})`;
	// eslint-disable-next-line no-console
	console.log(`GRID WEIGHT [real flag --force-device-scale-factor=${arm.dsf}] ${arm.name}: tile arm pen down ${sums(tile.down)}; lift ${sums(tile.lift)} | full arm pen down ${sums(full.down)}; lift ${sums(full.lift)}`);
	// eslint-disable-next-line no-console
	console.log(`GRID [real flag] ${arm.name}: cost tile arm ${JSON.stringify({ ...tile.meter, tileGeom: undefined })} full arm ${JSON.stringify({ ...full.meter, tileGeom: undefined })}`);

	expect(L.dpr, "the rig does not hold the device ratio").toBe(arm.dsf);
	if (arm.fit) expect(L.pinchScaleNow, "Fit did not commit below the floor").toBeCloseTo(arm.fit, 12);
	else expect(L.pinchScaleNow).toBeCloseTo(arm.pinch, 12);
	const side = Math.ceil(256 * L.backing / (L.tile.grid ?? 1)) * (L.tile.grid ?? 1);
	expect([L.tile.w, L.tile.h], "the wet tile is off (1 x 1): every pen event draws into the full wet canvas").toEqual([side, side]);
	expect(L.tail.grid, "the tail has no grid: it stays a full-size layer").not.toBeNull();
	expect(L.tail.tileW, "the tail has no compact tile").toBeGreaterThan(0);

	// Placement while the pen was down: device px from the wet canvas's rect equal the tile's backing px.
	const g = tile.meter.tileGeom;
	expect(g?.origin ?? null, "the wet tile was never placed during the stroke").not.toBeNull();
	expect(Math.abs(g!.device.x - g!.origin!.x), `tile x on screen ${g!.device.x} against origin ${g!.origin!.x} device px`).toBeLessThanOrEqual(0.05);
	expect(Math.abs(g!.device.y - g!.origin!.y), `tile y on screen ${g!.device.y} against origin ${g!.origin!.y} device px`).toBeLessThanOrEqual(0.05);
	expect(Math.abs(g!.device.w - g!.backing.w), "tile width on screen is not its backing width").toBeLessThanOrEqual(0.05);
	expect(Math.abs(g!.device.h - g!.backing.h), "tile height on screen is not its backing height").toBeLessThanOrEqual(0.05);

	expect(tile.tileInk ?? 0, "the tile held no ink in the read window at pen down: this arm does not test the tile").toBeGreaterThan(0);
	// The full-canvas arm really drew without the tile and with a full tail.
	expect(full.fullArm, "the full-canvas arm kept the tile or the compact tail").toEqual({ wetTile: false, tailTileW: 0 });

	for (const [name, s] of [["tile arm", tile], ["full arm", full]] as const) {
		expect(s.wet.n, `${name}: no wet ink on screen with the pen down`).toBeGreaterThan(0);
		expect(s.committed.n, `${name}: no committed ink on screen after the lift`).toBeGreaterThan(0);
		expect({ left: s.committed.left, top: s.committed.top, bottom: s.committed.bottom }, `${name}: the lift moved the stroke's start, top or bottom edge`)
			.toEqual({ left: s.wet.left, top: s.wet.top, bottom: s.wet.bottom });
	}
	expect({ left: tile.wet.left, top: tile.wet.top, bottom: tile.wet.bottom }, "pen down, the tile arm's edges differ from the full arm's")
		.toEqual({ left: full.wet.left, top: full.wet.top, bottom: full.wet.bottom });
	const liftTile = tile.committed.centreY - tile.wet.centreY, liftFull = full.committed.centreY - full.wet.centreY;
	expect(Math.abs(liftTile - liftFull), `the ink centre row moved ${liftTile.toFixed(4)} device px at the lift on the tile arm, ${liftFull.toFixed(4)} on the full arm`).toBeLessThanOrEqual(0.05);
}, 180_000);

it(`cost at ratio ${ODD_DPR}: draws into the full wet canvas per pen event and penRaw time, one long stroke`, async () => {
	const arm = ARMS[0]!;
	const r = await costArm(arm);
	// eslint-disable-next-line no-console
	console.log(`GRID COST [real flag] ${arm.name}: ${JSON.stringify({ ...r.meter, tileGeom: undefined })} layers ${JSON.stringify(r.layers)}`);
	expect(r.meter.events, "the stroke reached penRaw").toBeGreaterThan(50);
	expect(r.layers.tile.w * r.layers.tile.h, "the wet tile is off for the cost stroke").toBeGreaterThan(1);
	expect(r.meter.perEvent, "the full wet canvas still takes about one draw per pen event").toBeLessThan(0.5);
}, 180_000);

const across = Array.from({ length: 150 }, (_, i) => ({ x: 60 + i * 6, y: 60 + i * 2 + Math.sin(i / 7) * 20, pressure: 0.3 + 0.5 * Math.abs(Math.sin(i / 11)) }));

it(`wet tile pixels at ratio ${ODD_DPR}: tile on equals tile off per backing px`, async () => {
	const page = await pageAt(ODD_DPR);
	try {
		await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
		await page.addScriptTag({ content: wetBundle });
		const r = await page.evaluate(([c, p]) => (window as any).wetTilePage.compare(c, p), [{ width: 1200, height: 800, backing: ODD_DPR }, across] as const) as
			{ hasContract: boolean; origin: { x: number; y: number } | null; maxDiff: number; over: number; offInk: number; tile: { width: number; height: number } };
		// eslint-disable-next-line no-console
		console.log(`GRID WET [real flag] ${ODD_DPR}: ${JSON.stringify(r)}`);
		expect(r.tile, "the wet tile is off").toEqual({ width: 468, height: 468 });
		expect(r.origin, "the tile was never placed").not.toBeNull();
		expect(r.offInk).toBeGreaterThan(0);
		expect(r.over, `tile on differs from tile off (max channel difference ${r.maxDiff})`).toBe(0);
	} finally {
		await page.context().close();
	}
}, 120_000);

type TailConfig = { width: number; height: number; backing: number; cssScale?: number; hostZoom?: boolean };
const TAIL_CASES: { name: string; dsf: number; config: TailConfig }[] = [
	{ name: `ratio ${ODD_DPR}, 100%`, dsf: ODD_DPR, config: { width: 800, height: 500, backing: ODD_DPR, cssScale: 1, hostZoom: true } },
	{ name: "ratio 2, pinch 0.518", dsf: 2, config: { width: 800, height: 500, backing: 2 * 0.518, cssScale: 0.518, hostZoom: true } },
	{ name: "ratio 2, pinch 0.8734", dsf: 2, config: { width: 800, height: 500, backing: 2 * 0.8734, cssScale: 0.8734, hostZoom: true } },
	{ name: "ratio 2, Fit 0.08", dsf: 2, config: { width: 1600, height: 1000, backing: 2 * 0.08, cssScale: 0.08, hostZoom: true } },
];
const little = { from: { x: 50, y: 50 }, to: { x: 66, y: 61 }, hw: 4 };
const longPrediction = { fromX: 66, fromY: 61, points: [{ x: 135, y: 82 }, { x: 220, y: 90 }], width: 8 };

/** Both arms at the same page origin, so their device px phase is the same; each shot with the other hidden. */
async function stackArms(page: Page): Promise<void> {
	await page.evaluate(() => {
		document.body.style.display = "block";
		for (const name of ["full", "compact"]) {
			const el = document.querySelector(`[data-arm="${name}"]`) as HTMLElement;
			el.style.position = "absolute"; el.style.left = "0px"; el.style.top = "0px";
		}
	});
}
async function armShot(page: Page, show: "full" | "compact"): Promise<Decoded> {
	const rect = await page.evaluate(s => {
		for (const name of ["full", "compact"]) (document.querySelector(`[data-arm="${name}"]`) as HTMLElement).style.visibility = name === s ? "visible" : "hidden";
		const r = (document.querySelector(`[data-arm="${s}"]`) as HTMLElement).getBoundingClientRect();
		return { x: r.left, y: r.top, width: r.width, height: r.height };
	}, show);
	return decodePng(await page.screenshot({ clip: rect }));
}
async function armMismatch(page: Page): Promise<number> {
	const a = await armShot(page, "full");
	const b = await armShot(page, "compact");
	expect([b.width, b.height, b.channels]).toEqual([a.width, a.height, a.channels]);
	let mismatch = 0;
	for (let i = 0; i < a.px.length; i += a.channels) {
		for (let c = 0; c < a.channels; c++) if (a.px[i + c] !== b.px[i + c]) { mismatch++; break; }
	}
	return mismatch;
}

for (const tc of TAIL_CASES) it(`tail and carry, ${tc.name}: the compact tail equals the full-size tail on screen, before and after a band carry under a live head`, async () => {
	const page = await pageAt(tc.dsf);
	const call = <T>(name: string, ...args: unknown[]) => page.evaluate(({ name, args }) => (window as any).tailBackingPage[name](...args), { name, args }) as Promise<T>;
	try {
		await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
		await page.addScriptTag({ content: tailBundle });
		await call("setup", tc.config);
		await stackArms(page);
		await call("event", little, longPrediction);
		type Snap = { full: { layers: { tail: { width: number; height: number } } }; compact: { layers: { tail: { width: number; height: number } } }; mismatch: number; tailInk: number };
		const s = await call<Snap>("read");
		// eslint-disable-next-line no-console
		console.log(`GRID TAIL [real flag] ${tc.name}: full ${JSON.stringify(s.full.layers.tail)} compact ${JSON.stringify(s.compact.layers.tail)} mismatch ${s.mismatch}`);
		expect(s.compact.layers.tail.width * s.compact.layers.tail.height, "the compact tail is full size: no grid")
			.toBeLessThan(s.full.layers.tail.width * s.full.layers.tail.height);
		expect(s.tailInk).toBeGreaterThan(0);
		expect(s.mismatch, "compact tail backing differs from full").toBe(0);
		expect(await armMismatch(page), "compact tail differs from full on screen").toBe(0);
		await call("carry", 10.25, 5.5);
		const c = await call<Snap>("read");
		expect(c.tailInk).toBeGreaterThan(0);
		expect(c.mismatch, "the carry shifted one bitmap differently").toBe(0);
		expect(await armMismatch(page), "on screen after the carry, compact differs from full").toBe(0);
	} finally {
		await page.context().close();
	}
}, 120_000);

/**
 * The ratio ODD_DPR, 100% arm, LOOP times inside the run it is part of (the package gate's whole render): each time one
 * stroke on the tile arm and one on the full-canvas arm, each on a fresh page. A committed stroke once came out thinner
 * than the wet one in a loaded whole render (once in 14), so this asks that many times under load, and logs per stroke
 * where the committed ink came from: the draw at the lift (markCommittedPaint outside a repaint, its camera, backing and
 * floor) and any repaint before the read. The lift-move bound here is the snap bound, 0.5 device px: a real jump reds,
 * resampling noise does not. The 0.05 bound stays in the single cells above.
 */
const camEq = (a: CommitCam, b: CommitCam) => !!a && !!b && a.x === b.x && a.y === b.y && a.zoom === b.zoom;
if (LOOP > 1) it(`loop, ratio ${ODD_DPR}, 100%, ${LOOP} times, tile and full arms: committed ink keeps the wet ink and its edges, no lift move of half a device px, one lift draw at the last paint's camera and the arm's backing, strips on the tile, no repaint before the read`, async () => {
	const arm = ARMS.find(a => a.dsf === ODD_DPR && a.pinch === 1 && !a.fit)!;
	let thin = 0;
	for (let i = 1; i <= LOOP; i++) {
		const tile = await strokeArm(arm, false, true);
		const full = await strokeArm(arm, true, true);
		for (const [name, r] of [["tile arm", tile], ["full arm", full]] as const) {
			const s = r.source!;
			const lifts = s.draws.filter(d => d.kind === "lift"), repaints = s.draws.filter(d => d.kind === "repaint").length;
			const move = r.committed.centreY - r.wet.centreY;
			const isThin = r.committed.n < 0.95 * r.wet.n;
			if (isThin) thin++;
			// eslint-disable-next-line no-console
			console.log(`GRID LOOP ${i} of ${LOOP} ${name} ${isThin ? "THIN" : "ok"}: lift move ${move.toFixed(4)} device px; wet ${JSON.stringify(r.wet)} committed ${JSON.stringify(r.committed)} lift bitmap ${r.lift.bitmap.w.toFixed(1)} backing ${r.layers.backing} source ${JSON.stringify(s)}`);
			const at = `stroke ${i}, ${name}`;
			expect.soft(r.committed.n, `${at}: committed ink ${r.committed.n} is under 0.95 of the wet ink ${r.wet.n}`).toBeGreaterThanOrEqual(0.95 * r.wet.n);
			expect.soft({ left: r.committed.left, top: r.committed.top, bottom: r.committed.bottom }, `${at}: the lift moved the stroke's start, top or bottom edge`)
				.toEqual({ left: r.wet.left, top: r.wet.top, bottom: r.wet.bottom });
			expect.soft(Math.abs(move), `${at}: the ink centre row moved ${move.toFixed(4)} device px at the lift`).toBeLessThan(0.5);
			expect.soft(lifts.length, `${at}: lift draws`).toBe(1);
			expect.soft(camEq(lifts[0]?.cam ?? null, lifts[0]?.lastPaintCam ?? null), `${at}: the lift drew at a camera other than the last paint's (${JSON.stringify(lifts[0])})`).toBe(true);
			expect.soft(lifts[0]?.backing, `${at}: the lift drew at a backing other than the arm's`).toBe(r.layers.backing);
			expect.soft(repaints, `${at}: repaints between the lift and the read`).toBe(0);
			expect.soft(s.strips, `${at}: no strip was drawn`).toBeGreaterThan(0);
			if (name === "tile arm") {
				expect.soft(s.stripsOnTile, `${at}: a strip fell off the tile`).toBe(s.strips);
				expect.soft(s.flushes, `${at}: the tile never reached the wet canvas`).toBeGreaterThanOrEqual(1);
			} else {
				expect.soft({ onTile: s.stripsOnTile, flushes: s.flushes }, `${at}: the full-canvas arm used the tile`).toEqual({ onTile: 0, flushes: 0 });
			}
		}
	}
	// eslint-disable-next-line no-console
	console.log(`GRID LOOP SUMMARY ${LOOP} times, ${2 * LOOP} strokes, thin ${thin}`);
}, 90_000 * LOOP);
