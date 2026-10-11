/**
 * WHAT THE PAN BAKE REDRAWS ON A NOTE WITH A LOT OF INK, ZOOMED OUT.
 *
 * A heavy note (28,358 strokes, scale 0.344) shows full repaints of 130 to 270 ms while panning. Every slow frame reads
 * bake=yes work=all. InkOverlay.repaint() bakes a settled pan into the raster camera (rasterPanNeedsBake) and, in the same
 * step, adds whole-layer damage (this.damage.addAll()), so every stroke in the band is drawn again. A band move carries its
 * pixels and costs 2.5 to 16 ms.
 *
 * Each cell is on a resting pan and asserts WHAT the repaint drew (the work the committed layer was given, "all" or strips,
 * and how many paths landed on the committed canvas), or where the ink stands on screen, not how long anything took:
 *   1. bake with the camera still: the resting pan moves by a fraction of a backing pixel, inside the camera bar. The bake
 *      moves no ink and must paint nothing. Red until the bake stops adding whole-layer damage.
 *   2. zero snap, a guard that is green today: the ink stands on the same device pixels before and after each bake, for the
 *      camera-still nudge and for a 40 px settled pan. The screen is read with repaints held, then again once the bake ran; no
 *      pixel may change by more than 24 of 255 (the layer held at a fraction of a pixel is resampled, which moves no ink).
 * Premise cells that must stay green keep the rig honest: the ink is all there, the zoom is committed low, the bake happens,
 * and a whole-layer repaint draws many paths.
 *
 * Fixture: 4000 synthetic strokes over about 11,000 x 13,000 css px (a seeded generator, so every run draws the same ink),
 * zoomed to 0.34. HW_PANBAKE_MCB=<path> swaps in the MCB EXAM 3 ink copy (28,358 strokes) for the same cells.
 * HW_PANBAKE_OUT=<file> writes the rows as JSON.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/PanBakeRepaint.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { penStroke, linePoints } from "./cdpPen";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const TEMPLATE = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/alan-ink-75d1627a.json", import.meta.url)), "utf8")) as Record<string, unknown>;
const MCB_PATH = process.env.HW_PANBAKE_MCB ?? "";
const MCB_TEXT = MCB_PATH && existsSync(MCB_PATH) ? readFileSync(MCB_PATH, "utf8") : "";
const ZOOM = 0.34;
const PANE = { w: 1184, h: 824 };
const DSF = 2;
const OUT = process.env.HW_PANBAKE_OUT ?? "";
// HW_PANBAKE_FAR_MCB=<path>: the MCB EXAM 3 ink copy for the 17 percent bounce landing, whose raster (18.1 million device px) fits the
// desktop cap where the synthetic page's (20.6 million) does not. Without it that one cell is skipped and says so.
const FAR_MCB_PATH = process.env.HW_PANBAKE_FAR_MCB ?? MCB_PATH;
const FAR_MCB_TEXT = FAR_MCB_PATH && existsSync(FAR_MCB_PATH) ? readFileSync(FAR_MCB_PATH, "utf8") : "";

function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function syntheticInk(count: number): string {
	const rnd = seeded(37);
	const strokes = [];
	for (let i = 0; i < count; i++) {
		let x = 40 + rnd() * 11000, y = 40 + rnd() * 13000, heading = rnd() * Math.PI * 2;
		const pts: number[] = [];
		for (let k = 0; k < 14; k++) {
			pts.push(Math.round(x * 100) / 100, Math.round(y * 100) / 100, 0.3 + 0.2 * rnd(), k * 8);
			heading += (rnd() - 0.5) * 0.9; x += Math.cos(heading) * 6; y += Math.sin(heading) * 6;
		}
		strokes.push({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, tool: "pen", color: "#2f6de0", width: 2.6, createdAt: 1788552785194, pts });
	}
	return JSON.stringify({ ...TEMPLATE, strokes, images: [], textBoxes: [] });
}
const FIXTURE = MCB_TEXT || syntheticInk(4000);
const WANT = MCB_TEXT ? (JSON.parse(MCB_TEXT) as { strokes: unknown[] }).strokes.length : 4000;
const PAGE_ID = MCB_TEXT ? "cf77b392-e4c0-47b3-b87a-b9583f5884cb" : "75d1627a-c4d7-4a11-947d-bc26b7f83c20";

let browser: Browser, script: string;
beforeAll(async () => {
	const b = await build({ entryPoints: [fileURLToPath(new URL("./panBakeRepaintPage.ts", import.meta.url))], bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1700,1000"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Row = { phase: string; t: number; backing: number; bake: boolean; bounce: boolean; work: string | null; strokesGiven: number; painted: boolean; fills: number; pts: number;
	built?: boolean; scrollOnly?: boolean; locked?: boolean; copies?: number; standCopies?: number; ext?: boolean; vDiffer?: number; vInked?: number;
	vOver24?: number; vMax?: number; vEdge?: number; dDiffer?: number; dOver24?: number; dMax?: number; vFrameBad?: number; dPmOver24?: number; dPmMax?: number;
	restBefore: { x: number; y: number }; rasterBefore: { x: number; y: number } | null; camBefore: { x: number; y: number; zoom: number } | null;
	camAfter: { x: number; y: number; zoom: number } | null; rasterAfter: { x: number; y: number } | null };
const dump: Record<string, unknown> = {};

/** Mount the note at ZOOM with Infinite Canvas on, then run `body` with a touch driver and the recorder on. */
async function withRig(name: string, zoom: number, body: (api: { page: Page; mounted: any; touch: (type: string, x: number, y: number) => Promise<unknown>; rows: () => Promise<Row[]>; full: Row[] }) => Promise<void>,
	fx: { text: string; id: string; want: number } = { text: FIXTURE, id: PAGE_ID, want: WANT }) {
	const context = await browser.newContext({ viewport: null, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await page.evaluate(([z, s, id, w, h, n]) => (window as any).panBake.mount(z, s, id, w, h, n), [zoom, fx.text, fx.id, PANE.w, PANE.h, fx.want] as const) as any;
		expect(errors).toEqual([]);
		expect(mounted.strokes, "premise: every stroke loaded").toBe(fx.want);
		expect(mounted.dpr, "premise: the device ratio is the flag's").toBeCloseTo(DSF, 3);
		expect(mounted.canvasMode, "premise: Infinite Canvas on").toBe(true);
		expect(mounted.zoomCommitted, "premise: the zoom committed").toBe(true);
		await sleep(600);
		const whole0 = await page.evaluate(() => (window as any).panBake.awaitWhole()) as { pending: boolean };
		expect(whole0.pending, "premise: the build the mount armed finished").toBe(false);
		await page.evaluate(() => (window as any).panBake.record());
		const full = await page.evaluate(() => (window as any).panBake.full()) as Row[];
		const cdp = await context.newCDPSession(page);
		const touch = (type: string, x: number, y: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] } as any);
		let stopped: Row[] = [];
		try {
			await body({ page, mounted, touch, rows: () => page.evaluate(() => (window as any).panBake.rows()) as Promise<Row[]>, full });
		} finally {
			stopped = await page.evaluate(() => (window as any).panBake.stop()) as Row[];
			const copyLog = await page.evaluate(() => (window as any).panBake.copyLog()) as unknown[];
			if (copyLog.length > 0) console.log(`COPYDIRECT ${name} ` + JSON.stringify(copyLog));
			dump[name] = { mounted, full, rows: stopped, copyLog, state: await page.evaluate(() => (window as any).panBake.state()) };
		}
		expect(errors).toEqual([]);
		// Every copy's raster stands in the frame the branch's rule gives (scale, origin, size), computed in the test.
		expect(sum(stopped, r => r.vFrameBad), "premise: every copy's raster stands in the frame the branch's rule gives").toBe(0);
	} finally { await context.close(); }
}

const baked = (rows: Row[]) => rows.filter(r => r.painted && r.bake);

it("premise: a whole-layer repaint on this note draws many paths on the committed canvas", async () => {
	await withRig("premise-full", ZOOM, async ({ full }) => {
		const all = full.filter(r => r.work === "all");
		expect(all.length, "premise: a forced whole-layer repaint ran").toBeGreaterThan(0);
		expect(Math.max(...all.map(r => r.fills)), "premise: it drew the ink, not nothing").toBeGreaterThan(200);
	});
}, 120_000);

it("a bake that leaves the camera still paints nothing", async () => {
	await withRig("camera-still", ZOOM, async ({ page, rows }) => {
		const n0 = (await rows()).length;
		const nudge = await page.evaluate(() => (window as any).panBake.nudge(0.02)) as any;
		const all = (await rows()).slice(n0);
		const bakes = baked(all);
		// Either a bake was owed and ran, or the nudge was below the whole-pixel step and none was owed. In both cases nothing was drawn.
		expect(all.every(r => r.fills === 0), `a nudge below the camera bar draws no paths on any repaint (${bakes.length} bakes ran)`).toBe(true);
		for (const b of bakes) {
			const bar = 0.1 / (b.backing * b.camBefore!.zoom);
			const moved = Math.max(Math.abs(b.camAfter!.x - b.camBefore!.x), Math.abs(b.camAfter!.y - b.camBefore!.y));
			expect(moved, `premise: the camera moved less than the bar, ${bar.toFixed(4)} (${JSON.stringify(nudge)})`).toBeLessThan(bar);
			expect(b.fills, "a bake that moves no ink draws no paths").toBe(0);
			expect(b.work, "and gives the layer no whole-layer work").not.toBe("all");
		}
	});
}, 120_000);

/** Screen of the pane. */
const paneClip = (m: any) => ({ x: m.scrollRect.left, y: m.scrollRect.top, width: m.scrollRect.width, height: m.scrollRect.height });

/**
 * How far apart two screenshots are, read in the page: the largest channel difference on any pixel and the count of pixels that
 * differ by more than 24 of 255. Pixel equality is the wrong bar for a zero-snap guard: a layer held at a fraction of a device pixel
 * is resampled by the compositor, which moves no ink and still changes a few edge values (measured: at most 13 of 255 for the
 * nudge, 7 for the 40 px settle). A shift of the ink by one device pixel moves a stroke edge by far more than 24.
 */
/** A screenshot as playwright returns it; only its base64 form is read, so the test needs no Node type. */
type Shot = { toString(encoding: "base64"): string };
async function screenDiff(page: Page, a: Shot, b: Shot): Promise<{ max: number; over: number; pixels: number }> {
	return await page.evaluate(async ([x, y]) => {
		const load = async (s: string) => {
			const bm = await createImageBitmap(await (await fetch("data:image/png;base64," + s)).blob());
			const c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext("2d")!;
			g.drawImage(bm, 0, 0);
			return g.getImageData(0, 0, bm.width, bm.height).data;
		};
		const p = await load(x), q = await load(y);
		let max = 0, over = 0;
		for (let i = 0; i < p.length; i += 4) {
			const d = Math.max(Math.abs(p[i]! - q[i]!), Math.abs(p[i + 1]! - q[i + 1]!), Math.abs(p[i + 2]! - q[i + 2]!));
			if (d > max) max = d;
			if (d > 24) over++;
		}
		return { max, over, pixels: p.length / 4 };
	}, [a.toString("base64"), b.toString("base64")] as const);
}
const SNAP_MAX = 24;

const zeroSnapCell = (name: string, move: string) => async () => {
	await withRig(name, ZOOM, async ({ page, mounted, rows }) => {
		const clip = paneClip(mounted);
		const reference = await page.screenshot({ clip });
		const n0 = (await rows()).length;
		// The pan moves with repaints held: the ink layer's transform shows it, nothing has been baked.
		const held = await page.evaluate(([m]) => (window as any).panBake.holdAndMove(m), [move] as const) as any;
		const beforeBake = await page.screenshot({ clip });
		// A settle always owes a bake. A nudge below the whole-pixel step owes none where the layer is only carried by whole pixels.
		if (move === "settle") expect(held.bakePending, "premise: the pan is off the raster, a bake is pending").toBe(true);
		expect((await rows()).slice(n0).filter(r => r.painted && r.bake).length, "premise: nothing was baked while held").toBe(0);
		await page.evaluate(() => (window as any).panBake.release());
		const afterBake = await page.screenshot({ clip });
		const bakes = baked((await rows()).slice(n0));
		if (move === "settle") expect(bakes.length, "premise: the release baked the pan with a repaint").toBeGreaterThan(0);
		else expect(bakes.length > 0, "premise: a bake ran exactly when one was owed").toBe(held.bakePending);
		expect(held.pan.x !== 0 || held.pan.y !== 0, "premise: the pan is off its start").toBe(true);
		if (move === "settle") expect((await screenDiff(page, beforeBake, reference)).over, "premise: a 40 px settle shows the ink somewhere else").toBeGreaterThan(1000);
		const moved = await screenDiff(page, beforeBake, afterBake);
		expect(moved.pixels, "premise: both screens are the whole pane").toBeGreaterThan(1_000_000);
		expect(moved.over, `zero snap: no pixel changes by more than ${SNAP_MAX} of 255 across the bake (largest change ${moved.max})`).toBe(0);
	});
};
it("zero snap: a bake that leaves the camera still does not move the ink on screen", zeroSnapCell("zero-snap-nudge", "nudge"), 120_000);
it("zero snap: a settled pan's bake does not move the ink on screen", zeroSnapCell("zero-snap-settle", "settle"), 120_000);

const penLine = (m: any, shift = 0) => {
	const cx = m.scrollRect.left + m.scrollRect.width / 2 + shift, cy = m.scrollRect.top + m.scrollRect.height / 2;
	return linePoints({ x: cx - 200, y: cy }, { x: cx + 200, y: cy + 60 }, 20);
};
/** Pixels allowed past the 24 of 255 bar between two draws of one stroke: its ends take their shape from sampling and differ by a few dozen. */
const PEN_EDGE_PIXELS = 300;
it("a pen down on the frame after a bounce ends draws where the pointer is", async () => {
	let reference: Shot | null = null as unknown as Shot | null;
	await withRig("pen-reference", ZOOM, async ({ page, mounted }) => {
		const cdp = await page.context().newCDPSession(page);
		await penStroke(cdp, penLine(mounted));
		await sleep(500);
		reference = await page.screenshot({ clip: paneClip(mounted) });
	});
	let shifted: Shot | null = null as unknown as Shot | null;
	await withRig("pen-shifted", ZOOM, async ({ page, mounted }) => {
		const cdp = await page.context().newCDPSession(page);
		await penStroke(cdp, penLine(mounted, 0.5));
		await sleep(500);
		shifted = await page.screenshot({ clip: paneClip(mounted) });
	});
	await withRig("pen-after-bounce", ZOOM, async ({ page, mounted }) => {
		const cdp = await page.context().newCDPSession(page);
		const bare = await page.screenshot({ clip: paneClip(mounted) });
		const end = await page.evaluate(() => (window as any).panBake.pullAndReleaseToEnd()) as any;
		expect(end.started && end.springFrames, "premise: the spring played").toBeGreaterThanOrEqual(10);
		expect(end.bounce, "premise: the bounce has ended").toBe(false);
		await penStroke(cdp, penLine(mounted));
		await sleep(500);
		const drawn = await page.screenshot({ clip: paneClip(mounted) });
		expect((await screenDiff(page, bare, drawn)).over, "premise: the pen stroke put ink on the screen").toBeGreaterThan(100);
		expect((await screenDiff(page, reference!, shifted!)).over, "premise: a stroke one device pixel to the side is told apart from the reference").toBeGreaterThan(PEN_EDGE_PIXELS * 3);
		const moved = await screenDiff(page, reference!, drawn);
		expect(moved.over, `the stroke after the bounce is where the same stroke is with no bounce: pixels off by more than ${SNAP_MAX} of 255 (largest change ${moved.max})`).toBeLessThan(PEN_EDGE_PIXELS);
	});
}, 180_000);

/**
 * The page pulled past its left or top edge at 10 percent and let go: the edge bounces of Alan's touch pan on the MCB EXAM 3 note
 * (Orion scroll probe, 2026-10-03: "overscroll bounce from 96.00,0.00 px", each followed by a whole-layer repaint of 130 to 270 ms
 * with 28,358 strokes). The pull and the bounce move the page by the ink layer's translate; when the raster follows, the pixels it
 * already holds can be carried by whole device pixels and only the uncovered strips drawn, so no repaint of the pull or the bounce
 * has to re-raster the whole committed layer. No pen.
 */
const edgePullCell = (name: string, axis: "x" | "y" | "xy", zoom = 0.10) => async () => {
	await withRig(name, zoom, async ({ page, mounted, rows }) => {
		expect(mounted.cssScale, "premise: zoomed to the cell's level").toBeCloseTo(zoom, 3);
		const n0 = (await rows()).length;
		const pull = await page.evaluate(([a]) => (window as any).panBake.pullAndRelease(a, 96), [axis] as const) as any;
		await sleep(300);
		const all = (await rows()).slice(n0);
		expect(Math.min(axis === "y" ? 1 : pull.held.panX, axis === "x" ? 1 : pull.held.panY), "premise: the page was held past its edge").toBeGreaterThan(0);
		expect(all.some(r => r.phase === "hold" && r.painted), "premise: a repaint ran during the hold").toBe(true);
		console.log(`SPRING ${name} frames ${pull.springFrames}`);
		expect(pull.started && pull.springFrames, "premise: the release started a spring that played").toBeGreaterThanOrEqual(3);
		expect(Math.abs(pull.pan.x) + Math.abs(pull.pan.y), "premise: the page came back to its edge").toBeCloseTo(0, 3);
		expect(all.filter(r => r.painted && r.work === "all").map(r => `${r.phase}:${r.fills}`),
			"no repaint of the pull or the bounce redraws the whole ink layer (phase and paths filled of each one that did)").toEqual([]);
	});
};
it("a page pulled past its left edge at 10 percent and let go redraws the whole ink layer on no frame", edgePullCell("edge-pull-left-10", "x"), 120_000);
it("a page pulled past its top edge at 10 percent and let go redraws the whole ink layer on no frame", edgePullCell("edge-pull-top-10", "y"), 120_000);
// The corner bounces of Alan's probe (from 96,96 on a note at 10 percent; from 152.57,222.63 and 96,93 on MCB EXAM 3 at 17 percent),
// at his scales: 0.1118 is 10 percent on a note whose 100 percent is 1.1176, 0.1708 is 17 percent on MCB EXAM 3.
it("a page pulled past its top left corner at 10 percent and let go redraws the whole ink layer on no frame", edgePullCell("corner-pull-10", "xy", 0.1118), 120_000);
it("a page pulled past its top left corner at 17 percent and let go redraws the whole ink layer on no frame", edgePullCell("corner-pull-17", "xy", 0.1708), 120_000);

/**
 * Where ink stands, as the centre of its pixel mass on two screens, in screenshot (device) px: what moved from the first to the
 * second, and how many pixels differ by more than 24 of 255. Ink is anything off the background, read at the pane's corner.
 */
async function inkShift(page: Page, a: Shot, b: Shot): Promise<{ dx: number; dy: number; mass: number; over: number }> {
	return await page.evaluate(async ([x, y]) => {
		const load = async (s: string) => {
			const bm = await createImageBitmap(await (await fetch("data:image/png;base64," + s)).blob());
			const c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext("2d")!;
			g.drawImage(bm, 0, 0);
			return { w: bm.width, d: g.getImageData(0, 0, bm.width, bm.height).data };
		};
		const p = await load(x), q = await load(y);
		const centre = (img: { w: number; d: Uint8ClampedArray }) => {
			const d = img.d, br = d[0]!, bg = d[1]!, bb = d[2]!;
			let m = 0, sx = 0, sy = 0;
			for (let i = 0; i < d.length; i += 4) {
				const v = Math.max(Math.abs(d[i]! - br), Math.abs(d[i + 1]! - bg), Math.abs(d[i + 2]! - bb));
				if (v <= 8) continue;
				const px = (i / 4) % img.w, py = Math.floor(i / 4 / img.w);
				m += v; sx += v * px; sy += v * py;
			}
			return { m, x: m ? sx / m : 0, y: m ? sy / m : 0 };
		};
		const cp = centre(p), cq = centre(q);
		let over = 0;
		for (let i = 0; i < p.d.length; i += 4) {
			if (Math.max(Math.abs(p.d[i]! - q.d[i]!), Math.abs(p.d[i + 1]! - q.d[i + 1]!), Math.abs(p.d[i + 2]! - q.d[i + 2]!)) > 24) over++;
		}
		return { dx: cq.x - cp.x, dy: cq.y - cp.y, mass: Math.min(cp.m, cq.m) / 255, over };
	}, [a.toString("base64"), b.toString("base64")] as const);
}

/**
 * Below 100 percent a bake carries the painted pixels by whole device pixels. A page held past its edge by part of a pixel carries
 * that part in the ink layer's translate while it is held; the bounce takes it back to the edge, where the snapped moves cancel.
 * At rest nothing is left in the translate, and the screen is the one a whole-layer redraw at the exact pan gives: the cell reads
 * the shift of the ink between those two screens in device px and the pixels that differ by more than 24 of 255.
 */
const placeCell = (zoom: number) => async () => {
	await withRig(`place-${zoom}`, zoom, async ({ page, mounted, rows }) => {
		expect(mounted.cssScale, "premise: zoomed to the cell's level").toBeCloseTo(zoom, 3);
		const clip = paneClip(mounted);
		const n0 = (await rows()).length;
		const pull = await page.evaluate(() => (window as any).panBake.pullAndRelease("x", 96.37)) as any;
		await sleep(300);
		console.log(`SPRING place-${zoom} frames ${pull.springFrames}`);
		expect(pull.started && pull.springFrames, "premise: the release started a spring that played").toBeGreaterThanOrEqual(3);
		const bakes = (await rows()).slice(n0).filter(r => r.painted && r.bake);
		expect(bakes.length, "premise: the pull and the bounce baked").toBeGreaterThan(0);
		expect(bakes.map(r => r.work), "premise: every bake carried, none redrew the whole layer").not.toContain("all");
		const rem = await page.evaluate(() => (window as any).panBake.remainder()) as { x: number; y: number };
		const carried = await page.screenshot({ clip });
		const exact = await page.evaluate(() => (window as any).panBake.exactRedraw()) as any;
		expect(exact.bake, "premise: the exact pan owes no further bake").toBe(false);
		const redrawn = await page.screenshot({ clip });
		const place = await inkShift(page, carried, redrawn);
		dump[`place-${zoom}`] = { place, rem };
		console.log(`PLACE zoom ${zoom} ${JSON.stringify({ place, rem })}`);
		expect(place.mass, "premise: the screens hold ink").toBeGreaterThan(1000);
		expect(Math.max(Math.abs(rem.x), Math.abs(rem.y)), "at rest no part of a pixel is left in the ink layer's translate").toBeLessThan(1e-6);
		expect({ over: place.over, dx: Math.round(place.dx * 1000) / 1000, dy: Math.round(place.dy * 1000) / 1000 },
			"the ink at rest is where a whole-layer redraw at the exact pan puts it, pixel for pixel").toEqual({ over: 0, dx: 0, dy: 0 });
	});
};
it("place: a pull past the edge by part of a pixel at 10 percent comes to rest where a whole-layer redraw puts the ink", placeCell(0.10), 120_000);
it("place: a pull past the edge by part of a pixel at 34 percent comes to rest where a whole-layer redraw puts the ink", placeCell(0.34), 120_000);

it("a page at rest moved by part of a pixel at 10 percent bakes to the exact pan and leaves nothing in the translate", async () => {
	await withRig("rest-fraction-10", 0.10, async ({ page, rows }) => {
		const n0 = (await rows()).length;
		await page.evaluate(() => (window as any).panBake.settlePan(-37.37, -23.61));
		const bakes = (await rows()).slice(n0).filter(r => r.painted && r.bake);
		expect(bakes.length, "premise: the settled pan baked").toBeGreaterThan(0);
		const rem = await page.evaluate(() => (window as any).panBake.remainder()) as { x: number; y: number };
		expect(Math.max(Math.abs(rem.x), Math.abs(rem.y)), "nothing left in the translate").toBeLessThan(1e-6);
	});
}, 120_000);

/**
 * A carried strip that holds ink. In the cells above, the strips a carry uncovers lie
 * past the top and left edges or off the pane, so they hold no ink, and a carry that drew no strips would leave blank ink after a
 * bounce that no cell sees. At 34 percent the note runs past the right and bottom of the layer, so the strips the bounce uncovers
 * hold ink. After every repaint that carried, the uncovered strips must equal, byte for byte, the whole layer drawn under their clip at the camera
 * they were drawn at, a camera within the repaint plan's still bar of the one the carry recorded; the carried pixels are not compared. The clip's own effect is
 * read against the unclipped whole layer. On the synthetic note it may change no pixel by more than 24 of 255. On a real note (HW_PANBAKE_MCB) it is printed
 * per carry and not asserted: the renderer fills a clipped path differently wherever the clip edge sits, by up to 36 of 255 at a few pixels on a real note,
 * and a strip drawn without a clip costs more than twice the strip work on a carry frame. Premise: the strips hold at least STRIP_INK_MIN inked pixels in all.
 */
const STRIP_INK_MIN = 200;
it("a corner pull at 34 percent: every strip a carry uncovers, ink in it, equals a whole-layer redraw at the same camera", async () => {
	await withRig("carried-strips-34", 0.34, async ({ page, mounted }) => {
		expect(mounted.cssScale, "premise: zoomed to the cell's level").toBeCloseTo(0.34, 3);
		const r = await page.evaluate(() => (window as any).panBake.pullAndReleaseStrips("xy", 96)) as any;
		dump["carried-strips-34"] = r;
		console.log(`STRIPS ${JSON.stringify(r.carries.map((c: any) => ({ phase: c.phase, sx: c.sx, sy: c.sy, drawn: c.stripsDrawn, camWithin: c.camWithin, inked: c.inked, differ: c.differ, max: c.max, clipDiffer: c.clipDiffer, clipOver24: c.clipOver24, clipMaxPm: c.clipMaxPm, pad: c.pad, clips: c.clips })))}`);
		console.log(`SPRING carried-strips-34 frames ${r.pull.springFrames}`);
		expect(r.pull.started && r.pull.springFrames, "premise: the release started a spring that played").toBeGreaterThanOrEqual(3);
		expect(r.carries.some((c: any) => c.phase === "hold"), "premise: the hold carried").toBe(true);
		expect(r.carries.every((c: any) => c.pad > 0 && c.clips > 0), "premise: the reference clips are the slide's strips, padded as a damage rect is").toBe(true);
		expect(r.carries.some((c: any) => c.phase !== "hold"), "premise: the bounce carried").toBe(true);
		const inked = r.carries.reduce((n: number, c: any) => n + c.inked, 0);
		expect(inked, `premise: the uncovered strips hold at least ${STRIP_INK_MIN} inked pixels`).toBeGreaterThanOrEqual(STRIP_INK_MIN);
		// The clip's effect against the unclipped whole layer is asserted on the synthetic note only; a real note prints it.
		const clipPart = !MCB_TEXT;
		if (!clipPart) console.log(`STRIPS CLIP ${JSON.stringify(r.carries.map((c: any) => ({ phase: c.phase, differ: c.clipDiffer, over24: c.clipOver24, maxPremultiplied: c.clipMaxPm })))}`);
		expect(r.carries.map((c: any) => `${c.phase} ${c.sx},${c.sy}: ${c.differ} px, camera ${c.camWithin ? "within" : "off"}` + (clipPart ? `, clip over 24: ${c.clipOver24}` : "")),
			"every uncovered strip equals the whole layer drawn under its clip at its camera, drawn at the carry's camera, and on the synthetic note the clip changes no pixel visibly (phase, shift in canvas px: pixels that differ)")
			.toEqual(r.carries.map((c: any) => `${c.phase} ${c.sx},${c.sy}: 0 px, camera within` + (clipPart ? ", clip over 24: 0" : "")));
	});
}, 120_000);

/**
 * A touch pan down the page at `zoom`, no pen: the band moves as the scroll eats its margin, and each move owes the strips it
 * uncovered. Returns the rows of the repaints that drew strips. With `still`, the finger rests twice the fling's velocity window
 * (FLING_VELOCITY_WINDOW_MS, 80) before it lifts, so no fling starts and the pan ends where the finger put it; `lift` is the scroll
 * top read on the arrived sample, just before the lift. Without it the release sometimes fell inside the window and sometimes not,
 * and the same pan ended at 6000 or about 6680 in either copy mode.
 */
async function touchPanDown(page: Page, mounted: any, touch: (type: string, x: number, y: number) => Promise<unknown>, rows: () => Promise<Row[]>, still = false) {
	const n0 = (await rows()).length;
	const r = mounted.scrollRect;
	const x = Math.round(r.left + r.width / 2);
	let y = Math.round(r.top + r.height * 0.85);
	await touch("touchStart", x, y);
	for (let i = 0; i < 50; i++) { await sleep(30); y -= 12; await touch("touchMove", x, y); }
	let lift: number | null = null;
	if (still) { await sleep(160); lift = (await page.evaluate(() => (window as any).panBake.state()) as any).top; }
	await touch("touchEnd", x, y);
	await sleep(900);
	const end = { ...(await page.evaluate(() => (window as any).panBake.state()) as any), lift };
	const strips = (await rows()).slice(n0).filter(row => row.painted && typeof row.work === "string" && row.work.startsWith("strips") && row.work !== "strips:0");
	return { end, strips };
}
const meanPts = (rs: Row[]) => rs.length ? rs.reduce((a, r) => a + r.pts, 0) / rs.length : 0;
const sum = (rs: Row[], f: (r: Row) => number | undefined) => rs.reduce((a, r) => a + (f(r) ?? 0), 0);
/** What a run of repaints did with the extent raster: path points, copies, builds, and the copy check's differing and inked pixels. */
const tally = (rs: Row[]) => ({ rows: rs.length, pts: sum(rs, r => r.pts), copies: sum(rs, r => r.copies), standCopies: sum(rs, r => r.standCopies), built: rs.filter(r => r.built).length,
	vDiffer: sum(rs, r => r.vDiffer), vInked: sum(rs, r => r.vInked), vOver24: sum(rs, r => r.vOver24), vEdge: sum(rs, r => r.vEdge),
	vMax: rs.reduce((m, r) => Math.max(m, r.vMax ?? 0), 0),
	frameBad: sum(rs, r => r.vFrameBad),
	direct: { differ: sum(rs, r => r.dDiffer), over24: sum(rs, r => r.dOver24), max: rs.reduce((m, r) => Math.max(m, r.dMax ?? 0), 0),
		pmOver24: sum(rs, r => r.dPmOver24), pmMax: rs.reduce((m, r) => Math.max(m, r.dPmMax ?? 0), 0) } });

// Alan's touch pan at 10 percent on a heavy note (MCB EXAM 3: each band move drew 160,000 to 198,000 path points in the rig): a band
// move below 100 percent fills its strips by copy from a raster of the note's whole ink drawn when the zoom settled, so a strip at
// 10 percent costs no more path work than the same pan at 100 percent.
it("a touch pan at 10 percent draws no more path points per band move than the same pan at 100 percent", async () => {
	const per: Record<string, { mean: number; strips: number; top: number }> = {};
	for (const zoom of [1, 0.10]) {
		await withRig(`band-pts-${zoom}`, zoom, async ({ page, mounted, touch, rows }) => {
			const { end, strips } = await touchPanDown(page, mounted, touch, rows);
			per[String(zoom)] = { mean: meanPts(strips), strips: strips.length, top: end.top };
			expect(end.top, "premise: the touch pan scrolled the page").toBeGreaterThan(200);
			expect(strips.length, "premise: the band moved and owed strips").toBeGreaterThan(0);
		});
	}
	console.log("BANDPTS " + JSON.stringify(per));
	expect(per["1"]!.mean, "premise: at 100 percent the strips held ink").toBeGreaterThan(0);
	expect(per["0.1"]!.mean, `path points per band move at 10 percent (${per["0.1"]!.mean}) against 100 percent (${per["1"]!.mean})`).toBeLessThanOrEqual(per["1"]!.mean);
}, 240_000);

// One pan, two halves. Every strip a band move fills by copy is exactly the store's
// current ink drawn by path on a canvas of the raster's own size at its camera and read back at the copy's offset (rasterFrameDiff in the rig, checked on the
// spot, so pixels the band carried from earlier frames do not enter that count). And the whole layer after the pan is no further
// from a direct paint with copies on than with copies off: on this base the band carry leaves some pixels drawn at an earlier
// camera either way (600 and 833 measured), so whole-layer byte equality is not the bar; adding to it is.
it("at 10 percent every strip a band move fills by copy is the pixels a path draw gives, and copies add no pixel off a direct paint", async () => {
	const layer: Record<string, { differ: number; inked: number; top: number; copies: number }> = {};
	for (const mode of ["on", "off"]) {
		await withRig(`extent-bytes-10-${mode}`, 0.10, async ({ page, mounted, touch, rows }) => {
			if (mode === "off") await page.evaluate(() => (window as any).panBake.copiesOff());
			const { end, strips } = await touchPanDown(page, mounted, touch, rows, true);
			expect(end.top, "premise: no fling, the pan ends on the arrived sample").toBe(end.lift);
			const t = tally(strips);
			const v = await page.evaluate(() => (window as any).panBake.layerVsPath()) as { differ: number; inked: number };
			layer[mode] = { ...v, top: end.top, copies: t.copies };
			if (mode === "on") {
				expect(t.copies, "premise: the band moves filled strips by copy").toBeGreaterThan(0);
				expect(t.vDiffer, `pixels that differ from a path draw inside the copied strips (${JSON.stringify(t)})`).toBe(0);
				expect(t.vInked, "premise: the copied strips hold ink").toBeGreaterThanOrEqual(2000);
			}
		});
	}
	console.log("LAYERVSPATH " + JSON.stringify(layer));
	expect({ off: layer.off!.copies, sameEnd: layer.on!.top === layer.off!.top }, "premise: the same pan, every strip by path with copies off").toEqual({ off: 0, sameEnd: true });
	expect(layer.on!.differ, `pixels off a direct paint with copies on against off (${JSON.stringify(layer)})`).toBeLessThanOrEqual(layer.off!.differ);
}, 240_000);

// A pen stroke at 10 percent is drawn into the raster when it commits (same paint as the committed layer, at the raster's zoom), so
// a whole repaint copies the stroke with the rest - no build, no path - and the next pan still fills by copy.
it("at 10 percent a pan after writing still fills by copy, and the copy holds the new stroke", async () => {
	await withRig("extent-after-pen-10", 0.10, async ({ page, mounted, touch, rows }) => {
		const s0 = (await page.evaluate(() => (window as any).panBake.state()) as any).strokes;
		const cdp = await page.context().newCDPSession(page);
		await penStroke(cdp, penLine(mounted));
		await sleep(500);
		const s1 = (await page.evaluate(() => (window as any).panBake.state()) as any).strokes;
		expect(s1, "premise: the pen stroke committed").toBeGreaterThan(s0);
		const n0 = (await rows()).length;
		await page.evaluate(() => (window as any).panBake.wholeRepaint());
		const whole = tally((await rows()).slice(n0).filter(r => r.painted));
		expect(whole.rows, "premise: the whole repaint ran").toBeGreaterThan(0);
		expect({ built: whole.built, pts: whole.pts, copies: whole.copies, vDiffer: whole.vDiffer }, `the whole layer after writing (${JSON.stringify(whole)})`)
			.toEqual({ built: 0, pts: 0, copies: 1, vDiffer: 0 });
		expect(whole.vInked, "premise: the whole layer holds ink").toBeGreaterThan(1000);
		const t = tally((await touchPanDown(page, mounted, touch, rows)).strips);
		expect(t.rows, "premise: the band moved and owed strips").toBeGreaterThan(0);
		expect({ pts: t.pts, built: t.built, vDiffer: t.vDiffer, copied: t.copies > 0 }, `band moves after writing (${JSON.stringify(t)})`)
			.toEqual({ pts: 0, built: 0, vDiffer: 0, copied: true });
	});
}, 180_000);

// An erase leaves the raster stale: the next pan draws by path, and once a whole repaint that is no pan, stroke or bounce frame
// has built it again, pans fill by copy again. A few strokes in view go, so the erase repaint stays partial and builds nothing.
it("at 10 percent a pan after an erase draws by path until the raster is built again, then fills by copy", async () => {
	await withRig("extent-after-erase-10", 0.10, async ({ page, mounted, touch, rows }) => {
		const n0 = (await rows()).length;
		const er = await page.evaluate(() => (window as any).panBake.eraseVisible(3)) as { erased: number };
		expect(er.erased, "premise: strokes in view were erased").toBe(3);
		const erase = tally((await rows()).slice(n0).filter(r => r.painted));
		expect({ built: erase.built, copies: erase.copies }, `the erase repaint builds nothing (${JSON.stringify(erase)})`).toEqual({ built: 0, copies: 0 });
		const stale = tally((await touchPanDown(page, mounted, touch, rows)).strips);
		expect(stale.rows, "premise: the band moved and owed strips").toBeGreaterThan(0);
		expect({ copies: stale.copies, built: stale.built, drewByPath: stale.pts > 0, vDiffer: stale.vDiffer }, `band moves while stale (${JSON.stringify(stale)})`)
			.toEqual({ copies: 0, built: 0, drewByPath: true, vDiffer: 0 });
		const n1 = (await rows()).length;
		await page.evaluate(() => (window as any).panBake.wholeRepaint());
		const rebuilt = tally((await rows()).slice(n1).filter(r => r.painted));
		expect({ built: rebuilt.built, copies: rebuilt.copies, drewByPath: rebuilt.pts > 0 }, `the whole repaint paints by path and builds nothing on its frame (${JSON.stringify(rebuilt)})`)
			.toEqual({ built: 0, copies: 0, drewByPath: true });
		const whole = await page.evaluate(() => (window as any).panBake.awaitWhole()) as any;
		expect(whole.ext && { pending: whole.pending, count: whole.ext.count, generation: whole.ext.generation }, `the raster built after it holds the store as it is (${JSON.stringify(whole)})`)
			.toEqual(whole.ext && { pending: false, count: whole.ext.storeCount, generation: whole.ext.storeGeneration });
		const again = tally((await touchPanDown(page, mounted, touch, rows)).strips);
		expect(again.rows, "premise: the band moved again").toBeGreaterThan(0);
		expect({ pts: again.pts, vDiffer: again.vDiffer, copied: again.copies > 0 }, `band moves after the rebuild (${JSON.stringify(again)})`)
			.toEqual({ pts: 0, vDiffer: 0, copied: true });
	});
}, 180_000);

// An erase across the whole note (one stroke in ten) damages so much that its repaint is a whole repaint, which is no pan, stroke
// or bounce frame: it paints by path and arms a build, and the raster built after it holds the store as it is (count and generation).
// The strips a pan uncovers hold erased ink, so a stale raster copied there would show it.
it("at 10 percent an erase across the whole note rebuilds the raster on its own repaint, and a pan after it copies the ink as it is now", async () => {
	await withRig("extent-after-wide-erase-10", 0.10, async ({ page, mounted, touch, rows }) => {
		const n0 = (await rows()).length;
		const er = await page.evaluate(() => (window as any).panBake.eraseEvery(10)) as { erased: number };
		expect(er.erased, "premise: one stroke in ten was erased, across the note").toBe(Math.ceil(WANT / 10));
		const erase = (await rows()).slice(n0).filter(r => r.painted);
		expect(erase.some(r => r.work === "all"), `premise: the erase repaint was a whole repaint (${JSON.stringify(erase.map(r => r.work))})`).toBe(true);
		const t = tally(erase);
		expect({ built: t.built, copies: t.copies ?? 0 }, `the erase's whole repaint builds nothing on its frame (${JSON.stringify(t)})`).toEqual({ built: 0, copies: 0 });
		const ext = ((await page.evaluate(() => (window as any).panBake.awaitWhole())) as any).ext;
		expect(ext && { count: ext.count, generation: ext.generation }, `the raster holds the store as it is (${JSON.stringify(ext)})`)
			.toEqual(ext && { count: ext.storeCount, generation: ext.storeGeneration });
		const after = tally((await touchPanDown(page, mounted, touch, rows)).strips);
		expect(after.rows, "premise: the band moved and owed strips").toBeGreaterThan(0);
		expect({ pts: after.pts, vDiffer: after.vDiffer, copied: after.copies > 0 }, `band moves after the wide erase (${JSON.stringify(after)})`)
			.toEqual({ pts: 0, vDiffer: 0, copied: true });
	});
}, 180_000);

// A setting that changes how every stroke paints without changing any stroke (smoothing, pressure; a synced settings change
// repaints every overlay) leaves the raster stale: the repaint that follows builds it again under the new setting, and a pan
// after it fills strips that are the pixels a path draw gives now, not the old shape.
it("at 10 percent a smoothing change rebuilds the raster, and a pan after it copies the new shape", async () => {
	await withRig("extent-shaping-10", 0.10, async ({ page, mounted, touch, rows }) => {
		const n0 = (await rows()).length;
		await page.evaluate(() => (window as any).panBake.shapingOff());
		const flip = tally((await rows()).slice(n0).filter(r => r.painted));
		expect(flip.rows, "premise: the settings change repainted").toBeGreaterThan(0);
		expect({ built: flip.built, copies: flip.copies }, `the repaint after the change paints by path and builds nothing on its frame (${JSON.stringify(flip)})`).toEqual({ built: 0, copies: 0 });
		const whole = await page.evaluate(() => (window as any).panBake.awaitWhole()) as any;
		expect(whole.ext && whole.ext.count, `premise: the raster was built again after the change (${JSON.stringify(whole)})`).toBe(whole.ext && whole.ext.storeCount);
		const t = tally((await touchPanDown(page, mounted, touch, rows)).strips);
		expect(t.rows, "premise: the band moved and owed strips").toBeGreaterThan(0);
		expect({ pts: t.pts, vDiffer: t.vDiffer, copied: t.copies > 0 }, `band moves after the change (${JSON.stringify(t)})`).toEqual({ pts: 0, vDiffer: 0, copied: true });
		expect(t.vInked, "premise: the copied strips hold ink").toBeGreaterThanOrEqual(2000);
	});
}, 180_000);

// The raster is built where the whole layer is redrawn anyway, never on a frame a pan, a stroke or a bounce asked for: those are the
// frames whose lag it exists to remove. With the raster stale after an erase, the pen stroke, the pan and the bounce that follow
// must leave it unbuilt, including any whole-layer repaint such a frame asks for.
it("at 10 percent the extent raster is built on no pan, stroke or bounce frame", async () => {
	await withRig("extent-no-build-10", 0.10, async ({ page, mounted, touch, rows }) => {
		const er = await page.evaluate(() => (window as any).panBake.eraseVisible(3)) as { erased: number };
		expect(er.erased, "premise: strokes in view were erased").toBe(3);
		const n0 = (await rows()).length;
		const cdp = await page.context().newCDPSession(page);
		await penStroke(cdp, penLine(mounted));
		await sleep(500);
		await touchPanDown(page, mounted, touch, rows);
		await page.evaluate(() => (window as any).panBake.pullAndRelease("xy", 96));
		const all = (await rows()).slice(n0);
		const asked = all.filter(r => r.scrollOnly || r.locked || r.bounce);
		console.log("NOBUILD " + JSON.stringify(asked.filter(r => r.painted && r.work !== "strips:0").map(r => ({ phase: r.phase, work: r.work, sc: r.scrollOnly, lk: r.locked, bo: r.bounce, ext: r.ext, built: !!r.built }))));
		expect(all.filter(r => r.scrollOnly).length, "premise: the pan asked for repaints").toBeGreaterThan(0);
		expect(all.filter(r => r.bounce).length, "premise: repaints ran while the bounce played").toBeGreaterThan(0);
		expect(asked.filter(r => r.painted && r.work === "all" && !r.ext).length, "premise: a whole-layer repaint ran on such a frame with no raster").toBeGreaterThan(0);
		expect(asked.filter(r => r.built).map(r => r.phase), "builds on a pan, stroke or bounce frame").toEqual([]);
	});
}, 180_000);

// The zoom settle law, as the zoom settle design of 2026-10-04 changed it: the frame that settles a zoom below 100
// percent draws no stroke by path and builds nothing; it shows the stand-in (the old raster scaled into place). The raster is built
// after it in pieces on later tasks, none on a frame, and once whole it is byte for byte the one-pass reference.
const settleCell = (fx?: { text: string; id: string; want: number }) => async () => {
	await withRig(`pieces-settle${fx ? "-mcb" : ""}`, 0.10, async ({ page, rows }) => {
		await page.evaluate(() => (window as any).panBake.pieces());
		const n0 = (await rows()).length;
		const z = await page.evaluate(() => (window as any).panBake.rezoom(0.12)) as { ok: boolean };
		expect(z.ok, "premise: the zoom committed").toBe(true);
		const settle = (await rows()).slice(n0).filter(r => r.painted && r.work === "all");
		expect(settle.length, "premise: the zoom's settle repainted the whole layer").toBeGreaterThan(0);
		const t = tally(settle);
		const perRow = settle.map(r => ({ phase: r.phase, pts: r.pts, copies: r.copies ?? 0, stand: r.standCopies ?? 0 }));
		expect({ built: t.built, drewByPath: t.pts > 0, standIn: t.standCopies > 0 }, `the settle frames paint by path with the stand-in off, show no stand-in and build nothing (${JSON.stringify({ t, perRow })})`)
			.toEqual({ built: 0, drewByPath: true, standIn: false });
		const whole = await page.evaluate(() => (window as any).panBake.awaitWhole()) as any;
		const pieces = await page.evaluate(() => (window as any).panBake.pieces()) as Array<{ ms: number; drew: number; inFrame: boolean }>;
		console.log(`PIECES settle${fx ? "-mcb" : ""} ` + JSON.stringify({ n: pieces.length, longest: Math.max(0, ...pieces.map(p => p.ms)), drew: pieces.reduce((a, p) => a + p.drew, 0), whole: whole.ms }));
		expect(whole.pending, "premise: the build finished").toBe(false);
		expect(pieces.length, "premise: the raster was built in more than one piece").toBeGreaterThan(1);
		expect(pieces.filter(p => p.inFrame).length, "pieces that ran inside a repaint").toBe(0);
		const v = await page.evaluate(() => (window as any).panBake.extentVsOnePass()) as any;
		expect(v && v.pen.inked, "premise: the raster holds ink").toBeGreaterThan(1000);
		expect(v && { pen: v.pen.differ, hl: v.hl ? v.hl.differ : 0, count: v.count }, `the whole raster against the one-pass reference (${JSON.stringify(v)})`)
			.toEqual(v && { pen: 0, hl: 0, count: v.storeCount });
	}, fx);
};
it("a zoom's settle frame paints by path with the stand-in off in 1.4.23 and builds nothing; the raster is built after it in pieces, byte for byte the one-pass reference", settleCell(), 180_000);
it.skipIf(!FAR_MCB_TEXT)("on MCB EXAM 3 a zoom's settle frame paints by path with the stand-in off in 1.4.23 and builds nothing; the raster is built after it in pieces, byte for byte the one-pass reference",
	settleCell({ text: FAR_MCB_TEXT, id: "cf77b392-e4c0-47b3-b87a-b9583f5884cb", want: FAR_MCB_TEXT ? (JSON.parse(FAR_MCB_TEXT) as { strokes: unknown[] }).strokes.length : 0 }), 300_000);

// Row 511: one cell per member of the piece gate. A build is armed and held, the member is set, the hold is let go: no piece may
// draw while the member holds. Then the member is let go and the build finishes, equal to the one-pass reference.
for (const member of ["contact", "stroke", "pinch", "bounce", "queued", "scroll"]) {
	it(`no piece of the build runs while the gate member "${member}" holds, and the build finishes after`, async () => {
		await withRig(`pieces-gate-${member}`, 0.10, async ({ page }) => {
			await page.evaluate(() => (window as any).panBake.holdPieces(true));
			await page.evaluate(() => (window as any).panBake.rezoom(0.12));
			const b0 = await page.evaluate(() => (window as any).panBake.build()) as any;
			expect(b0 && b0.next, `premise: a build is armed and has drawn nothing (${JSON.stringify(b0)})`).toBe(0);
			if (member !== "scroll") await page.evaluate((m) => (window as any).panBake.gate(m, true), member);
			await page.evaluate(() => (window as any).panBake.holdPieces(false));
			if (member === "scroll") await page.evaluate(() => (window as any).panBake.gate("scroll", true));
			await page.evaluate(() => (window as any).panBake.pieces());
			await sleep(400);
			const held = await page.evaluate(() => (window as any).panBake.pieces()) as unknown[];
			const b1 = await page.evaluate(() => (window as any).panBake.build()) as any;
			await page.evaluate((m) => (window as any).panBake.gate(m, false), member);
			expect({ pieces: held.length, next: b1 && b1.next }, `pieces while "${member}" held (${JSON.stringify(b1)})`).toEqual({ pieces: 0, next: 0 });
			const whole = await page.evaluate(() => (window as any).panBake.awaitWhole()) as any;
			expect(whole.pending, "premise: the build finished once the member let go").toBe(false);
			const v = await page.evaluate(() => (window as any).panBake.extentVsOnePass()) as any;
			expect(v && v.pen.differ, `the raster against the one-pass reference (${JSON.stringify(v)})`).toBe(0);
		});
	}, 120_000);
}

// Row 501 law 5: no piece between pen down and lift, with a real pen. The build is armed and held, the pen goes down, the hold is
// let go, and the pen moves for a while before it lifts: no piece draws until the lift. The stroke is added at the end of the store
// inside the raster's world, so the build takes it (row 511 change 1) and finishes with it, equal to the one-pass reference.
it("no piece of the build runs between pen down and lift, and a stroke committed mid-build is in the finished raster", async () => {
	await withRig("pieces-pen", 0.10, async ({ page, mounted }) => {
		await page.evaluate(() => (window as any).panBake.holdPieces(true));
		await page.evaluate(() => (window as any).panBake.rezoom(0.12));
		await page.evaluate(() => (window as any).panBake.stepPiece());
		const b0 = await page.evaluate(() => (window as any).panBake.build()) as any;
		expect(b0 && b0.next > 0 && b0.next < b0.count, `premise: a build is part way (${JSON.stringify(b0)})`).toBe(true);
		const cdp = await page.context().newCDPSession(page);
		let during: unknown[] = [];
		await penStroke(cdp, penLine(mounted), { between: async (i) => {
			if (i === 1) { await page.evaluate(() => { (window as any).panBake.holdPieces(false); (window as any).panBake.pieces(); }); }
			if (i === 10) await sleep(300);
			if (i === 19) during = await page.evaluate(() => (window as any).panBake.pieces()) as unknown[];
		} });
		const b1 = await page.evaluate(() => (window as any).panBake.build()) as any;
		expect(during.length, "pieces between pen down and lift").toBe(0);
		await sleep(500);
		const s = await page.evaluate(() => (window as any).panBake.state()) as any;
		const whole = await page.evaluate(() => (window as any).panBake.awaitWhole()) as any;
		expect(s.strokes, `premise: the pen stroke committed (${JSON.stringify(b1)})`).toBeGreaterThan(b0.storeCount);
		expect(whole.ext && { pending: whole.pending, count: whole.ext.count }, `the build took the stroke and finished with it (${JSON.stringify(whole)})`)
			.toEqual(whole.ext && { pending: false, count: s.strokes });
		const v = await page.evaluate(() => (window as any).panBake.extentVsOnePass()) as any;
		expect(v && v.pen.differ, `the raster with the stroke against the one-pass reference (${JSON.stringify(v)})`).toBe(0);
	});
}, 180_000);

// Row 501 law 3 and row 511 change 2: a change of zoom, an erase, or a smoothing change while a build is part way drops it, and its
// canvases are released at once (0 x 0); no raster is handed over from the dropped build.
for (const change of ["zoom", "erase", "shaping"]) {
	it(`a ${change} change while the build is part way drops it and releases its canvases`, async () => {
		await withRig(`pieces-drop-${change}`, 0.10, async ({ page }) => {
			await page.evaluate(() => (window as any).panBake.holdPieces(true));
			await page.evaluate(() => (window as any).panBake.rezoom(0.12));
			await page.evaluate(() => (window as any).panBake.stepPiece());
			const b0 = await page.evaluate(() => (window as any).panBake.build()) as any;
			expect(b0 && b0.allocated && b0.next < b0.count, `premise: a build is part way with its canvases (${JSON.stringify(b0)})`).toBe(true);
			expect(await page.evaluate(() => (window as any).panBake.keepBuildCanvas()), "premise: the build's canvas is kept for the check").toBe(true);
			if (change === "zoom") await page.evaluate(() => (window as any).panBake.rezoom(0.14));
			else if (change === "erase") await page.evaluate(() => (window as any).panBake.eraseVisible(3));
			else await page.evaluate(() => (window as any).panBake.shapingOff());
			await page.evaluate(() => (window as any).panBake.stepPiece());
			const size = await page.evaluate(() => (window as any).panBake.keptCanvasSize()) as number[];
			const b1 = await page.evaluate(() => (window as any).panBake.build()) as any;
			expect(size, `the dropped build's canvas, released (${JSON.stringify({ b0, b1 })})`).toEqual([0, 0]);
			await page.evaluate(() => (window as any).panBake.holdPieces(false));
			await page.evaluate(() => (window as any).panBake.awaitWhole());
		});
	}, 120_000);
}

// Alan's freezes at 17 percent on MCB EXAM 3 (543 to 951 ms): a zoom change left the page past its edges, it bounced back from
// (152.57, 222.63) px, and the landing redrew the whole layer by path (from=camera+damage, carry=no). The landing now fills from the
// raster - whole by copy, or by the bounce carry's strips by copy - with no path drawn, and every copy the pixels a path draw gives.
const landingCell = (zoom: number, fx?: { text: string; id: string; want: number }) => async () => {
	await withRig(`bounce-landing-${zoom}`, zoom, async ({ page, rows }) => {
		const n0 = (await rows()).length;
		const b = await page.evaluate(() => (window as any).panBake.pullAndRelease("xy", 153, 223)) as any;
		expect(b.started && b.springFrames > 0, "premise: the bounce played").toBe(true);
		const landed = (await rows()).slice(n0).filter(r => r.painted && r.work !== "strips:0" && (r.phase === "release" || r.phase === "after"));
		const t = tally(landed);
		console.log(`LANDING ${zoom} ` + JSON.stringify({ t, rows: landed.map(r => ({ phase: r.phase, work: r.work, pts: r.pts, copies: r.copies ?? 0, bake: r.bake, bounce: r.bounce })) }));
		expect(landed.some(r => r.bake || r.work === "all"), "premise: the bounce landed with a bake or a whole-layer repaint").toBe(true);
		expect({ pts: t.pts, built: t.built, vDiffer: t.vDiffer, copied: t.copies > 0 }, `the landing (${JSON.stringify(t)})`).toEqual({ pts: 0, built: 0, vDiffer: 0, copied: true });
		expect(t.vInked, "premise: the copies hold ink").toBeGreaterThan(1000);
	}, fx);
};
it("a bounce landing at 10 percent fills from the raster, no path, the pixels a path draw gives", landingCell(0.10), 120_000);
it.skipIf(!FAR_MCB_TEXT)("a bounce landing at 17 percent on MCB EXAM 3 fills from the raster, no path, the pixels a path draw gives",
	landingCell(0.17, { text: FAR_MCB_TEXT, id: "cf77b392-e4c0-47b3-b87a-b9583f5884cb", want: FAR_MCB_TEXT ? (JSON.parse(FAR_MCB_TEXT) as { strokes: unknown[] }).strokes.length : 0 }), 240_000);
if (!FAR_MCB_TEXT) console.log("SKIP the 17 percent bounce landing: set HW_PANBAKE_FAR_MCB to the MCB EXAM 3 ink copy");

// The bar a copy is held to. The renderer does not draw the same ink byte for byte at an origin moved by whole device
// px (measured: one pixel moves 50 px, 3 of them past the zero-snap bar). So a copy is held, exactly, to the store's current ink drawn
// by the committed layer's own painter in the raster's frame and read back at the copy's offset (rasterFrameDiff in the rig), and
// its distance from a direct paint at the layer's camera is recorded beside it, not barred. This cell holds the premise: the same
// ink drawn twice at the same origin is byte for byte the same; the shifted numbers go in its message.
const SHIFTS = [1, 7, 600, 2400];
type Cmp = { differ: number; over24: number; maxDelta: number; inked: number };
type Shift = { n: number; same: Cmp; cam: Cmp; translate: Cmp };
it("premise: the same ink drawn twice by path at the same origin is byte for byte the same", async () => {
	for (const zoom of [0.10, 0.17]) await withRig(`shift-control-${zoom}`, zoom, async ({ page }) => {
		const got: Shift[] = [];
		for (const n of SHIFTS) got.push(await page.evaluate((m) => (window as any).panBake.shiftControl(m), n) as Shift);
		console.log(`SHIFT ${zoom} ` + JSON.stringify(got));
		expect(got.every(g => g.same.inked > 1000), "premise: the layer holds ink").toBe(true);
		expect(got.map(g => g.same.differ), `pixels that differ between two draws at one origin (moved origins, recorded: ${JSON.stringify(got.map(g => ({ n: g.n, cam: g.cam, translate: g.translate })))})`)
			.toEqual(SHIFTS.map(() => 0));
	});
}, 240_000);

afterAll(() => { if (OUT) writeFileSync(OUT, JSON.stringify(dump, null, 1)); });
