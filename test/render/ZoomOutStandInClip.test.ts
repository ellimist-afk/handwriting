/**
 * INK CUT BY ONE RECTANGLE AFTER A ZOOM OUT BELOW 100 PERCENT.
 *
 * Seen on a device at a Fit zoom of 73.1 percent: everything right of one x and below one y was missing from the ink layer while
 * the paper drew past it. Zooming in and out a few times brought it back. When the zoom drops below 100 percent the overlay keeps
 * the old picture of the ink (the stand-in), scaled to the new zoom, until a sharp raster of the whole ink replaces it. A picture
 * of one band taken at 100 percent and shown at 0.731 ends at 0.731 of the band's width and height; past that edge it holds no ink.
 * If nothing replaces it, that edge is what the screen shows.
 *
 * The whole repaints of a zoom commit decide what follows the stand-in: they start the raster's build, or let the stand-in go when
 * no build will run. While a bounce plays or a stroke is being built they may do neither, and when that ends nothing asks again, so
 * the stand-in stays on screen until the next zoom. A pan into an edge leaves a bounce playing, and a zoom right after it lands
 * inside the bounce.
 *
 * Each cell paints the note whole at its first zoom, zooms out to a Fit-like zoom with six digits, with a bounce or a stroke live
 * over the commit where named, lets the clock pass the scroll quiet time and the build's pieces run, and then asks: is the stand-in
 * gone, is no build left pending, and does the layer hold the ink a direct paint at the same camera holds, in the right-most and
 * bottom-most quarters of the layer as well as in the whole. Then it zooms to 100 percent and back and asks again: the device's
 * recovery, which must not be the only way back. The pan arms move the view right and down at 100 percent before the zoom out to
 * 0.302, the pan left unbaked when the zoom commits, or baked first as the control.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/ZoomOutStandInClip.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const TEMPLATE = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/alan-ink-75d1627a.json", import.meta.url)), "utf8")) as Record<string, unknown>;
const PAGE_ID = "75d1627a-c4d7-4a11-947d-bc26b7f83c20";
const PANE = { w: 1184, h: 824 };
const DSF = 2;

function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function strokeJson(i: number, x: number, y: number, rnd: () => number) {
	let heading = rnd() * Math.PI * 2;
	const pts: number[] = [];
	for (let k = 0; k < 14; k++) {
		pts.push(Math.round(x * 100) / 100, Math.round(y * 100) / 100, 0.3 + 0.2 * rnd(), k * 8);
		heading += (rnd() - 0.5) * 0.9; x += Math.cos(heading) * 6; y += Math.sin(heading) * 6;
	}
	return { id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, tool: "pen", color: "#2f6de0", width: 2.6, createdAt: 1788552785194, pts };
}
/** `count` strokes spread over a world `w` by `h` css px from (40, 40): wider and taller than one band at every zoom here. */
function ink(count: number, w: number, h: number): string {
	const rnd = seeded(41);
	const strokes = [];
	for (let i = 0; i < count; i++) strokes.push(strokeJson(i + 1, 40 + rnd() * w, 40 + rnd() * h, rnd));
	return JSON.stringify({ ...TEMPLATE, strokes, images: [], textBoxes: [] });
}

// The layer against a direct paint of the store at the layer's own camera, read in three parts: the right-most quarter of the
// layer's width, the bottom-most quarter of its height, and the whole. Inked px of each (alpha above 0) on both, and the px where
// the direct paint has ink and the layer has none.
const ENTRY = `import "./panBakeRepaintPage.ts";
import { inlineInk, overlayForPath } from "../../src/inline/InkOverlay";
import { drawCommitted } from "../../src/ink/StrokeRenderer";
(window as any).clip = {
	/** The resting pan moved with no repaint asked, so the move is not baked into the raster, then a zoom commit in the same task. */
	panThenZoom(path: string, x: number, y: number, zoom: number) {
		const o: any = overlayForPath(path);
		o.viewportPan.x = x; o.viewportPan.y = y; o.writeViewportPan();
		const unbaked = !!o.rasterPanNeedsBake();
		return { unbaked, ok: !!o.commitCameraScale(zoom), canvasMode: !!o.canvasMode };
	},
	read(path: string) {
		const o: any = overlayForPath(path), c = o.committedCanvas as HTMLCanvasElement, W = c.width, H = c.height, b = o.committedBacking, cam = o.lastPaintCam;
		const ref = document.createElement("canvas"); ref.width = W; ref.height = H;
		const x = ref.getContext("2d")!; x.setTransform(o.committedCtx.getTransform());
		drawCommitted(x, cam, inlineInk.strokes(path), o.cssWidth, o.cssHeight, true, "pen", false, { backing: b, dpr: o.dpr });
		const P = o.committedCtx.getImageData(0, 0, W, H).data, Q = x.getImageData(0, 0, W, H).data;
		ref.width = 0; ref.height = 0;
		const part = (x0: number, y0: number, x1: number, y1: number) => {
			let layer = 0, direct = 0, lost = 0;
			for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
				const i = (yy * W + xx) * 4 + 3;
				if (P[i]! > 0) layer++;
				if (Q[i]! > 0) { direct++; if (P[i] === 0) lost++; }
			}
			return { layer, direct, lost };
		};
		const st = o.standIn;
		return { W, H, zoom: cam ? cam.zoom : null, cssScale: o.cssScale, standIn: !!st, standInSize: st ? [st.pen.width, st.pen.height] : null,
			building: !!o.extentBuild, ext: !!o.extentRaster, pinchRef: o.pinchRefScale, queued: !!o.repaintQueued, locked: !!o.frame?.locked,
			right: part(Math.floor(W * 0.75), 0, W, H), bottom: part(0, Math.floor(H * 0.75), W, H), whole: part(0, 0, W, H) };
	},
};`;

let browser: Browser, script: string;
beforeAll(async () => {
	const b = await build({
		stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("./", import.meta.url)), sourcefile: "zoomOutStandInClipEntry.ts", loader: "ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1700,1000"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const PATH = "Untitled 1.md";

async function withNote(fixture: string, count: number, zoom: number, body: (page: Page) => Promise<void>) {
	const context = await browser.newContext({ viewport: null, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await page.evaluate(([z, s, id, w, h, n]) => (window as any).panBake.mount(z, s, id, w, h, n), [zoom, fixture, PAGE_ID, PANE.w, PANE.h, count] as const) as any;
		expect(mounted.strokes, "premise: every stroke loaded").toBe(count);
		expect(mounted.zoomCommitted, "premise: the first zoom committed").toBe(true);
		await sleep(400);
		await page.evaluate(() => (window as any).panBake.awaitSharp());
		await body(page);
		expect(errors).toEqual([]);
	} finally { await context.close(); }
}

/** After the settle: the clock past the scroll quiet time, pieces run, the frames after them painted. */
async function afterSettle(page: Page) {
	await sleep(400);
	await page.evaluate(() => (window as any).panBake.awaitSharp(20_000));
	await sleep(200);
	await page.evaluate(() => (window as any).panBake.awaitSharp(5_000));
	return page.evaluate((p) => (window as any).clip.read(p), PATH) as Promise<any>;
}

/** Which of the four ways the stand-in can outlive its use this state shows. */
function why(r: any): string {
	if (!r.standIn) return "no stand-in held";
	if (r.building && (r.pinchRef !== null || r.queued)) return "(a) a build is armed but no piece is ever allowed (pinch scale held or a repaint queued)";
	if (r.building) return "(a) or (b): a build is armed and never finished";
	if (r.ext) return "(c) a finished raster is held but not used";
	return "(d) no build was armed after the settle and the stand-in was kept";
}

// A copy from the raster or the layer's own repaints after a pan differ from a one-pass direct paint by a few hundred px at stroke
// edges (recorded as not covered elsewhere); a cut leaves most of a quarter blank.
const LOST_BAR = 0.1;

function expectWhole(r: any, label: string) {
	const s = `${label}: ${why(r)} ${JSON.stringify(r)}`;
	expect(r.right.direct, `premise: the direct paint has ink in the right-most quarter (${s})`).toBeGreaterThan(200);
	expect(r.bottom.direct, `premise: the direct paint has ink in the bottom quarter (${s})`).toBeGreaterThan(200);
	expect(r.standIn, `the stand-in is still held (${s})`).toBe(false);
	expect(r.building, `a build is still pending (${s})`).toBe(false);
	expect(r.right.lost, `right-most quarter: px the direct paint inks and the layer leaves blank (${s})`).toBeLessThan(r.right.direct * LOST_BAR);
	expect(r.bottom.lost, `bottom quarter: px the direct paint inks and the layer leaves blank (${s})`).toBeLessThan(r.bottom.direct * LOST_BAR);
	expect(r.whole.lost, `whole layer: px the direct paint inks and the layer leaves blank (${s})`).toBeLessThan(r.whole.direct * LOST_BAR);
}

// Ink whose whole raster at 0.731 is beyond the raster cap (no build), and ink whose raster fits (a build runs).
const BIG = { count: 4000, w: 11000, h: 13000 };
const SMALL = { count: 1500, w: 2400, h: 2600 };
const FIT = 0.731284;
const PINCHED = 0.302417;

/** A zoom commit while `member` holds (a bounce still playing, a stroke being built), then the hold ends with nothing else asked. */
async function commitUnder(page: Page, member: "bounce" | "stroke", zoom: number) {
	await page.evaluate((m) => (window as any).panBake.gate(m, true), member);
	await page.evaluate((z) => (window as any).panBake.rezoom(z), zoom);
	await page.evaluate((m) => (window as any).panBake.gate(m, false), member);
}

/**
 * The first settle read, then the recovery seen on the device: a zoom to 100 percent and back to `zoom`, read again. Both are read
 * before anything is asserted, so a red first settle shows whether the re-zoom clears it.
 */
async function settleThenRecover(page: Page, zoom: number, label: string) {
	const first = await afterSettle(page);
	await page.evaluate(() => (window as any).panBake.rezoom(1.0));
	await afterSettle(page);
	await page.evaluate((z) => (window as any).panBake.rezoom(z), zoom);
	const again = await afterSettle(page);
	expectWhole(first, `${label}, first settle (after the re-zoom: ${why(again)}, ${again.whole.lost} of ${again.whole.direct} px lost)`);
	expectWhole(again, `${label}, after a zoom to 100 percent and back`);
}

/** A pan right and down at 100 percent, baked by its own repaint or left unbaked, then a zoom out to `zoom` with no scroll target. */
async function panThenZoom(page: Page, baked: boolean, zoom: number) {
	if (baked) await page.evaluate(() => (window as any).panBake.settlePan(-600, -500));
	const r = await page.evaluate(([p, b, z]) => (window as any).clip.panThenZoom(p, -600, -500, z), [PATH, baked, zoom] as const) as any;
	expect(r.ok, "premise: the zoom committed").toBe(true);
	expect(r.canvasMode, "premise: Infinite Canvas is on").toBe(true);
	if (!baked) expect(r.unbaked, "premise: the pan was not baked when the zoom committed").toBe(true);
	await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
}

// The pan arms use the large ink only: at 0.302 the small ink no longer reaches the right-most quarter of the view.
const BIG_FIXTURE = ink(BIG.count, BIG.w, BIG.h);

it(`ink too large for a raster: a pan right and down at 100 percent left unbaked, then a zoom out to ${PINCHED}, leaves no stand-in and no ink cut at an edge`, async () => {
	await withNote(BIG_FIXTURE, BIG.count, 1.0, async (page) => {
		await panThenZoom(page, false, PINCHED);
		await settleThenRecover(page, PINCHED, "unbaked pan, then 0.302");
	});
}, 180_000);

it(`ink too large for a raster, control: a pan right and down at 100 percent baked first, then a zoom out to ${PINCHED}, leaves no stand-in and no ink cut at an edge`, async () => {
	await withNote(BIG_FIXTURE, BIG.count, 1.0, async (page) => {
		await panThenZoom(page, true, PINCHED);
		await settleThenRecover(page, PINCHED, "baked pan, then 0.302");
	});
}, 180_000);

for (const [name, n] of [["ink too large for a raster", BIG], ["ink whose raster fits", SMALL]] as const) {
	const fixture = n === BIG ? BIG_FIXTURE : ink(n.count, n.w, n.h);

	it(`${name}: painted whole at 100 percent, then a zoom out to ${FIT}, leaves no stand-in and no ink cut at an edge`, async () => {
		await withNote(fixture, n.count, 1.0, async (page) => {
			await page.evaluate((z) => (window as any).panBake.rezoom(z), FIT);
			await settleThenRecover(page, FIT, "from 100 to the Fit zoom");
		});
	}, 180_000);

	for (const [member, from] of [["bounce", 1.0], ["bounce", 1.47], ["stroke", 1.47]] as const) {
		const live = member === "bounce" ? "a bounce plays" : "a stroke is built";
		it(`${name}: painted whole at ${Math.round(from * 100)} percent, then a zoom out to ${FIT} while ${live}, leaves no stand-in and no ink cut at an edge once it ends`, async () => {
			await withNote(fixture, n.count, from, async (page) => {
				await commitUnder(page, member, FIT);
				await settleThenRecover(page, FIT, `from ${Math.round(from * 100)}, ${member} over the commit`);
			});
		}, 180_000);
	}
}
