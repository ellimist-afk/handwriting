/**
 * A ZOOM SETTLE ON AN INK-HEAVY NOTE SHOWS A STAND-IN, NOT A PATH REPAINT.
 *
 * Below 100 percent the settle of a zoom gives the layers a new backing and repaints the whole layer at once. Today that repaint
 * draws every stroke by path, two or three times in the one task (commitCameraScale calls handleResize more than once): 0.45 to
 * 1.1 s on MCB EXAM 3. The law (zoom settle design 2026-10-04): when a picture of the ink already exists, the
 * settle shows it at the new scale - the old whole-note raster, or the layer's own pixels when no raster is held - and the sharp
 * raster replaces it once the pieces build is whole.
 *
 *   1. With a whole raster held, the settle draws no stroke by path and shows the old raster (no snapshot taken).
 *   2-3. The stand-in frame puts the ink where the sharp frame does (the place measure, under the camera still bar); the sharp frame
 *      is the whole layer drawn by path at the same camera, pixel for pixel, and the raster is the one-pass reference; it is whole
 *      within 1000 ms of the pieces being let go.
 *   4. A stroke written while the stand-in is up is drawn sharp on top at once, and is in the whole raster when it arrives.
 *   5. The first zoom out from 100 percent (no raster held) draws no stroke by path, takes one snapshot for the settle, and shows the
 *      ink the old layer held.
 *   6. Each fallback paints by path and holds no stand-in after: a settle to 100 percent, an erase and a smoothing change while the
 *      stand-in is up.
 *   7. The stand-in's canvases are released when the sharp raster is copied in, and when it is dropped.
 *
 * Rig: the PanBakeRepaint page (panBakeRepaintPage.ts) on its synthetic note (4000 strokes over about 11,000 x 13,000 css px).
 * The zoom is committed as a zoom control does (rezoom); pieces are held where a cell must see the stand-in on screen.
 *
 * Skipped in 1.4.23, the zoom stand-in being off: every cell that asserts a held stand-in; see HELD_SKIP below.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/ZoomSettleStandIn.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { penStroke, linePoints } from "./cdpPen";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const TEMPLATE = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/alan-ink-75d1627a.json", import.meta.url)), "utf8")) as Record<string, unknown>;
const PANE = { w: 1184, h: 824 };
const DSF = 2;
const PAGE_ID = "75d1627a-c4d7-4a11-947d-bc26b7f83c20";
/**
 * The zoom stand-in is off for 1.4.23 (ZOOM_STAND_IN_ENABLED in InkOverlay.ts): no stand-in is ever held, so
 * every cell that asserts a held stand-in is skipped as a group, with this reason in its name. 8c, 8d and 8e assert none is held
 * and still run. The stand-in returns in 1.4.24 reworked or not at all; these cells come back with it.
 */
const HELD_SKIP = "skipped in 1.4.23: the zoom stand-in is off, so none is ever held";
function itHeld(name: string, fn: () => Promise<void>, timeout?: number): void {
	it.skip(`${name} (${HELD_SKIP})`, fn, timeout);
}
/** The camera still bar in device px (InkOverlay CAMERA_STILL_BACKING_PX): the bar for where the soft frame's ink stands. */
const PLACE_BAR_PX = 0.1;

function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** The PanBakeRepaint note: the same seeded generator, so the same ink. */
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
const FIXTURE = syntheticInk(4000);

let browser: Browser, script: string;
beforeAll(async () => {
	const b = await build({ entryPoints: [fileURLToPath(new URL("./panBakeRepaintPage.ts", import.meta.url))], bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1700,1000"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Row = { phase: string; work: string | null; painted: boolean; pts: number; fills: number; copies?: number; standCopies?: number };
type Stand = { held: boolean; w: number; h: number; backing: number; count: number; snapshots: number | null; building: boolean; ext: boolean };
const pb = (page: Page) => ({
	call: <T>(name: string, ...a: unknown[]) => page.evaluate(([n, args]) => (window as any).panBake[n as string](...(args as unknown[])), [name, a] as const) as Promise<T>,
});

/** Mount the note at `zoom` with Infinite Canvas on, wait out the mount's build, then run `body` with the recorder on. */
async function withRig(zoom: number, body: (api: { page: Page; mounted: any; rows: () => Promise<Row[]>; call: <T>(name: string, ...a: unknown[]) => Promise<T> }) => Promise<void>) {
	const context = await browser.newContext({ viewport: null, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await page.evaluate(([z, s, id, w, h, n]) => (window as any).panBake.mount(z, s, id, w, h, n), [zoom, FIXTURE, PAGE_ID, PANE.w, PANE.h, 4000] as const) as any;
		expect(errors).toEqual([]);
		expect(mounted.strokes, "premise: every stroke loaded").toBe(4000);
		expect(mounted.dpr, "premise: the device ratio is the flag's").toBeCloseTo(DSF, 3);
		expect(mounted.canvasMode, "premise: Infinite Canvas on").toBe(true);
		expect(mounted.zoomCommitted, "premise: the zoom committed").toBe(true);
		await sleep(600);
		const whole0 = await page.evaluate(() => (window as any).panBake.awaitWhole()) as { pending: boolean };
		expect(whole0.pending, "premise: the build the mount armed finished").toBe(false);
		await page.evaluate(() => (window as any).panBake.record());
		try {
			await body({ page, mounted, rows: () => page.evaluate(() => (window as any).panBake.rows()) as Promise<Row[]>, call: pb(page).call });
		} finally {
			await page.evaluate(() => (window as any).panBake.stop());
		}
		expect(errors).toEqual([]);
	} finally { await context.close(); }
}

const paneClip = (m: any) => ({ x: m.scrollRect.left, y: m.scrollRect.top, width: m.scrollRect.width, height: m.scrollRect.height });
const pathPts = (rs: Row[]) => rs.reduce((a, r) => a + (r.pts ?? 0), 0);

type Shot = { toString(encoding: "base64"): string };
/**
 * Where ink stands, as the centre of its pixel mass on two screens, in screenshot (device) px: what moved from the first to the
 * second, and how many pixels differ by more than 24 of 255 (PanBakeRepaint's place measure).
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

/** Hold the pieces, commit 10 to 12 percent, and return the settle's whole-layer rows and the stand-in as the settle left it. */
async function softSettle(call: <T>(name: string, ...a: unknown[]) => Promise<T>, rows: () => Promise<Row[]>, to = 0.12) {
	await call("holdPieces", true);
	const s0 = await call<Stand>("standIn");
	const n0 = (await rows()).length;
	const z = await call<{ ok: boolean }>("rezoom", to);
	expect(z.ok, "premise: the zoom committed").toBe(true);
	const settle = (await rows()).slice(n0).filter(r => r.painted && r.work === "all");
	expect(settle.length, "premise: the settle repainted the whole layer").toBeGreaterThan(0);
	return { settle, s0, s1: await call<Stand>("standIn") };
}

itHeld("1: a zoom settle with a whole raster held draws no stroke by path and shows the old raster", async () => {
	await withRig(0.10, async ({ call, rows }) => {
		expect((await call<any>("extent"))?.count, "premise: a whole raster is held at 10 percent").toBe(4000);
		const { settle, s0, s1 } = await softSettle(call, rows);
		expect({ pathPts: pathPts(settle), held: s1.held, snapshots: (s1.snapshots ?? -1) - (s0.snapshots ?? 0) },
			`the settle frames draw nothing by path and show the old raster as the stand-in (${JSON.stringify({ s0, s1, works: settle.map(r => [r.work, r.pts]) })})`)
			.toEqual({ pathPts: 0, held: true, snapshots: 0 });
	});
}, 120_000);

itHeld("2-3: the stand-in frame puts the ink where the sharp frame does, the sharp frame is the path redraw, and it is whole within 1000 ms", async () => {
	await withRig(0.10, async ({ page, mounted, call, rows }) => {
		const clip = paneClip(mounted);
		const { s1 } = await softSettle(call, rows);
		expect(s1.held, "premise: the stand-in is on screen").toBe(true);
		// Where the soft frame's ink stands is read on the layer against the path draw at its camera (placeVsPath), not by the centroid
		// of the screens: the stand-in's strokes carry the old backing's width floor, and a width change moves the centroid.
		const softPlace = await call<{ dx: number; dy: number; inked: number }>("placeVsPath");
		const soft = await page.screenshot({ clip });
		await call("holdPieces", false);
		const sharpAt = await call<{ whole: number; building: boolean; held: boolean }>("awaitSharp");
		expect({ building: sharpAt.building, held: sharpAt.held }, "premise: the build finished and the stand-in went").toEqual({ building: false, held: false });
		const sharp = await page.screenshot({ clip });
		await call("pathRedraw");
		const path = await page.screenshot({ clip });
		const place = await inkShift(page, soft, sharp), exact = await inkShift(page, sharp, path);
		const v = await call<any>("extentVsOnePass");
		console.log(`STANDIN place ${JSON.stringify({ softPlace, centroid: place, exact, whole: sharpAt.whole, raster: v })}`);
		expect(softPlace.inked, "premise: the window holds ink").toBeGreaterThan(1000);
		expect(Math.max(Math.abs(softPlace.dx), Math.abs(softPlace.dy)), `the stand-in frame's ink stands where the path draw puts it, within ${PLACE_BAR_PX} px (${JSON.stringify(softPlace)})`)
			.toBeLessThanOrEqual(PLACE_BAR_PX);
		// At a zoom the redraw differs from the raster copy by antialias steps under 24 of 255 (over 0), which move the centre by about
		// 0.0005 px; two decimals keep any real shift (a 0.1 px misplacement moves it about 0.1 px).
		expect({ over: exact.over, dx: Math.round(exact.dx * 100) / 100, dy: Math.round(exact.dy * 100) / 100 }, `the sharp frame is the path redraw at the same camera, pixel for pixel, and its ink centre within 0.005 px (${JSON.stringify(exact)})`)
			.toEqual({ over: 0, dx: 0, dy: 0 });
		expect(v && { pen: v.pen.differ, count: v.count }, `the raster is the one-pass reference (${JSON.stringify(v)})`).toEqual(v && { pen: 0, count: v.storeCount });
		expect(sharpAt.whole, "the sharp raster is whole within 1000 ms of the pieces being let go").toBeLessThanOrEqual(1000);
	});
}, 120_000);

const penLine = (m: any) => {
	const cx = m.scrollRect.left + m.scrollRect.width / 2, cy = m.scrollRect.top + m.scrollRect.height / 2;
	return linePoints({ x: cx - 200, y: cy }, { x: cx + 200, y: cy + 60 }, 20);
};

itHeld("4: a stroke written while the stand-in is up is drawn sharp on top at once, and is in the whole raster", async () => {
	await withRig(0.10, async ({ page, mounted, call, rows }) => {
		const { s1 } = await softSettle(call, rows);
		expect(s1.held, "premise: the stand-in is on screen").toBe(true);
		const cdp = await page.context().newCDPSession(page);
		await penStroke(cdp, penLine(mounted));
		await sleep(300);
		const s2 = await call<Stand>("standIn");
		expect(s2.held, "premise: the stand-in is still up after the stroke").toBe(true);
		// A later frame's whole repaint while the stand-in is up: the copy, then the new stroke by path on top.
		await call("repaintNow");
		const sharpStroke = await call<{ solid: number; bad: number; count: number }>("lastStrokeSharp");
		expect(sharpStroke && sharpStroke.count, "premise: the stroke was added to the store").toBe(4001);
		expect(sharpStroke && sharpStroke.solid, "premise: the stroke has solid pixels").toBeGreaterThan(100);
		expect(sharpStroke && sharpStroke.bad, `the new stroke's solid pixels on the stand-in frame, drawn sharp (${JSON.stringify(sharpStroke)})`).toBe(0);
		await call("holdPieces", false);
		const sharpAt = await call<{ whole: number; held: boolean }>("awaitSharp");
		expect(sharpAt.held, "premise: the stand-in went").toBe(false);
		const v = await call<any>("extentVsOnePass");
		expect(v && { pen: v.pen.differ, count: v.count }, `the whole raster holds the stroke, the one-pass reference (${JSON.stringify(v)})`).toEqual(v && { pen: 0, count: 4001 });
	});
}, 120_000);

// From 50 percent: a zoom out from 100 percent to 10 percent copies at one tenth, past the stand-in's bar, and draws by path (8e).
itHeld("5: the first zoom out from 50 percent (no raster held) draws no stroke by path, takes one snapshot for the settle, and shows the ink the old layer held", async () => {
	await withRig(0.5, async ({ call, rows }) => {
		expect(await call<any>("extent"), "premise: no raster is held at 50 percent").toBe(null);
		const { settle, s0, s1 } = await softSettle(call, rows, 0.15);
		const rect = await call<{ x: number; y: number; w: number; h: number } | null>("standInRect");
		const inkSoft = rect ? await call<number>("layerInk", rect) : -1;
		await call("holdPieces", false);
		const sharpAt = await call<{ held: boolean }>("awaitSharp");
		const inkSharp = rect ? await call<number>("layerInk", rect) : -1;
		console.log(`STANDIN first-out ${JSON.stringify({ s0, s1, rect, inkSoft, inkSharp, works: settle.map(r => [r.work, r.pts]) })}`);
		expect({ pathPts: pathPts(settle), held: s1.held, snapshots: (s1.snapshots ?? -1) - (s0.snapshots ?? 0) },
			"the settle draws nothing by path and shows one snapshot of the old layer").toEqual({ pathPts: 0, held: true, snapshots: 1 });
		expect(sharpAt.held, "premise: the stand-in went").toBe(false);
		expect(inkSharp, "premise: the old layer's place holds ink once sharp").toBeGreaterThan(100);
		const ratio = inkSoft / inkSharp;
		expect(ratio > 0.5 && ratio < 1.5, `the stand-in shows the ink the old layer held in its place (soft ${inkSoft} px, sharp ${inkSharp} px)`).toBe(true);
	});
}, 120_000);

itHeld("5b: a second zoom while the stand-in is up keeps the first stand-in and takes no new snapshot", async () => {
	await withRig(0.5, async ({ call, rows }) => {
		const { s0, s1 } = await softSettle(call, rows, 0.15);
		expect({ held: s1.held, snapshots: (s1.snapshots ?? -1) - (s0.snapshots ?? 0) }, "premise: the first zoom out took one snapshot").toEqual({ held: true, snapshots: 1 });
		expect(await call<boolean>("keepStandInCanvas"), "premise: the stand-in's canvas is kept for the check").toBe(true);
		const n1 = (await rows()).length;
		// 13.5 percent, not higher: a larger build would not fit beside the held stand-in (pair cap) and the stand-in would go.
		const z = await call<{ ok: boolean }>("rezoom", 0.135);
		expect(z.ok, "premise: the second zoom committed").toBe(true);
		const settle = (await rows()).slice(n1).filter(r => r.painted && r.work === "all");
		expect(settle.length, "premise: the second settle repainted the whole layer").toBeGreaterThan(0);
		const s2 = await call<Stand>("standIn");
		const same = await call<boolean>("standInIsKept");
		expect({ held: s2.held, same, snapshots: (s2.snapshots ?? -1) - (s1.snapshots ?? 0), pathPts: pathPts(settle) },
			`the second settle shows the first stand-in, not a copy of the soft frame (${JSON.stringify({ s1, s2, works: settle.map(r => [r.work, r.pts]) })})`)
			.toEqual({ held: true, same: true, snapshots: 0, pathPts: 0 });
		await call("holdPieces", false);
		expect((await call<{ held: boolean }>("awaitSharp")).held, "the stand-in went once the build was whole").toBe(false);
	});
}, 120_000);

type TaskRows = { ok: boolean; rows: Array<{ pts: number; stand: number }>; deferrals: number | null; held: boolean; factor: number | null };
type FrameRow = { work: string | null; pts: number; stand: number };
type FrameRows = { rows: FrameRow[]; first: FrameRow[]; later: FrameRow[]; held: boolean; deferrals: number | null;
	rect: { x: number; y: number; w: number; h: number } | null; ink: number; layerInk: number; did: any };
const sumOf = (rs: Array<{ pts: number; stand: number }>) => ({ pts: rs.reduce((a, r) => a + r.pts, 0), stand: rs.reduce((a, r) => a + r.stand, 0) });

// While a stand-in is held, a whole repaint draws nothing in its task and the next animation frame copies the stand-in once, before
// that frame paints (zoom settle design, the deferred copy): a commit's repaints coalesce into one copy, the frame is never blank.
itHeld("5c: two whole repaints in one task while the stand-in is up copy nothing in the task and the stand-in once in the next frame", async () => {
	await withRig(0.10, async ({ call, rows }) => {
		const { s1 } = await softSettle(call, rows);
		expect(s1.held, "premise: the stand-in is on screen").toBe(true);
		const t = await call<TaskRows>("commitThen", null, "twice");
		const f = await call<FrameRows>("afterFrame", null);
		expect(t.rows.length, "premise: two whole repaints ran in the task").toBe(2);
		expect({ task: sumOf(t.rows), frame: sumOf(f.rows) }, `stand-in copies and path points, in the task and in the next frame (${JSON.stringify({ t, f })})`)
			.toEqual({ task: { pts: 0, stand: 0 }, frame: { pts: 0, stand: 1 } });
	});
}, 120_000);

// The stand-in is copied at a factor of 0.25 or more (STAND_IN_MIN_FACTOR); from 50 percent, 12.5 and 15 percent copy at 0.25 and 0.30.
for (const [to, factor] of [[0.125, 0.25], [0.15, 0.30]] as const) itHeld(`8a: a zoom commit under the stand-in (copy factor ${factor}) leaves no blank frame: the next frame shows the stand-in's ink before it paints`, async () => {
	await withRig(0.5, async ({ call }) => {
		await call("holdPieces", true);
		const t = await call<TaskRows>("commitThen", to, "none", "none", true);
		expect({ ok: t.ok, held: t.held }, "premise: the zoom committed and the stand-in is held").toEqual({ ok: true, held: true });
		expect(t.factor, `premise: the copy factor (${JSON.stringify(t)})`).toBeCloseTo(factor, 6);
		const f = await call<FrameRows>("afterFrame");
		expect(f.rect, "premise: the stand-in lands on the layer").not.toBe(null);
		// The commit asks one more whole repaint in a second frame (the editor's reflow, then the settle's follow-up); with nothing
		// changed since the copy, that frame paints nothing.
		expect({ taskPts: sumOf(t.rows).pts, firstStand: sumOf(f.first).stand, frameStand: sumOf(f.rows).stand, pts: sumOf(f.rows).pts, inked: f.ink > 100 },
			`the commit draws nothing by path; the first frame copies the stand-in and holds ink before it paints, and no frame copies it again (${JSON.stringify({ t, f })})`)
			.toEqual({ taskPts: 0, firstStand: 1, frameStand: 1, pts: 0, inked: true });
	});
}, 120_000);

it("8e: below a copy factor of 0.25 (0.24) a zoom commit holds no stand-in and draws by path, with ink in the first frame", async () => {
	await withRig(0.5, async ({ call }) => {
		await call("holdPieces", true);
		const t = await call<TaskRows>("commitThen", 0.12, "none", "none", true);
		expect(t.ok, "premise: the zoom committed").toBe(true);
		expect(t.factor, `premise: the copy factor (${JSON.stringify(t)})`).toBeCloseTo(0.24, 6);
		const f = await call<FrameRows>("afterFrame");
		expect({ held: t.held, taskStand: sumOf(t.rows).stand, frameStand: sumOf(f.rows).stand, byPath: sumOf(t.rows).pts + sumOf(f.rows).pts > 0, inked: f.layerInk > 100 },
			`no stand-in is held or copied; the commit draws by path and the first frame holds ink (${JSON.stringify({ t, f })})`)
			.toEqual({ held: false, taskStand: 0, frameStand: 0, byPath: true, inked: true });
		await call("holdPieces", false);
	});
}, 120_000);

// A held pinch takes no stand-in: the preview scales whatever the layer shows, and a copy scaled up lands off its place, so its
// commits paint by path. Released, the same commit keeps the stand-in (the settle the stand-in is for).
itHeld("8f: a zoom commit while a pinch is held holds no stand-in and draws by path, with ink in the first frame; released, the same commit holds it", async () => {
	for (const pinch of [true, false]) await withRig(0.5, async ({ call }) => {
		await call("holdPieces", true);
		await call("gate", "pinch", pinch);
		const t = await call<TaskRows>("commitThen", 0.125, "none", "none", true);
		expect(t.ok, "premise: the zoom committed").toBe(true);
		const f = await call<FrameRows>("afterFrame");
		await call("gate", "pinch", false);
		const got = { held: t.held, frameStand: sumOf(f.rows).stand, byPath: sumOf(t.rows).pts + sumOf(f.rows).pts > 0, inked: f.layerInk > 100 };
		expect(got, `pinch ${pinch ? "held" : "released"}: stand-in held or copied, path points, ink in the first frame (${JSON.stringify({ t, f })})`)
			.toEqual(pinch ? { held: false, frameStand: 0, byPath: true, inked: true } : { held: true, frameStand: 1, byPath: false, inked: true });
		await call("holdPieces", false);
	});
}, 240_000);

itHeld("8b: a pan asking for its repaint before the frame does not drop the copy", async () => {
	await withRig(0.10, async ({ call }) => {
		await call("holdPieces", true);
		const t = await call<TaskRows>("commitThen", 0.12, "scroll");
		expect(t.held, "premise: the stand-in is held").toBe(true);
		const f = await call<FrameRows>("afterFrame");
		expect({ held: f.held, first: sumOf(f.first).stand, ...sumOf(f.rows) }, `the first frame copies the stand-in, no frame copies it again or draws by path (${JSON.stringify(f)})`)
			.toEqual({ held: true, first: 1, pts: 0, stand: 1 });
	});
}, 120_000);

// The copy mark: a whole repaint in the queued frame paints nothing only while the layers still hold the stand-in copy
// at the current camera, backing, canvas size and stroke set. A change between the copy frame and the next whole repaint copies again.
itHeld("9a: the camera moved between the copy frame and the next whole repaint copies the stand-in again", async () => {
	await withRig(0.10, async ({ call }) => {
		await call("holdPieces", true);
		const t = await call<TaskRows>("commitThen", 0.12, "none", "pan");
		expect(t.held, "premise: the stand-in is held").toBe(true);
		const f = await call<FrameRows>("afterFrame");
		expect({ held: f.held, first: sumOf(f.first).stand }, `premise: the first frame copied the stand-in (${JSON.stringify(f)})`).toEqual({ held: true, first: 1 });
		const later = sumOf(f.later);
		expect({ again: later.stand >= 1, pts: later.pts }, `the frames after the pan copy the stand-in again at the new camera, nothing by path (${JSON.stringify(f)})`)
			.toEqual({ again: true, pts: 0 });
	});
}, 120_000);

itHeld("9b: a stroke committed between the copy frame and the next whole repaint copies the stand-in again and draws the new stroke by path", async () => {
	await withRig(0.10, async ({ call }) => {
		await call("holdPieces", true);
		const t = await call<TaskRows>("commitThen", 0.12, "none", "stroke");
		expect(t.held, "premise: the stand-in is held").toBe(true);
		const f = await call<FrameRows>("afterFrame");
		expect({ held: f.held, first: sumOf(f.first).stand, did: f.did }, `premise: the first frame copied the stand-in, then a stroke was committed (${JSON.stringify(f)})`)
			.toEqual({ held: true, first: 1, did: { stroke: true, count: 4001 } });
		const later = sumOf(f.later);
		expect({ again: later.stand >= 1, byPath: later.pts > 0 }, `the frames after the stroke copy the stand-in again and draw the stroke by path (${JSON.stringify(f)})`)
			.toEqual({ again: true, byPath: true });
	});
}, 120_000);

itHeld("9c: a resize between the copy frame and the next whole repaint copies the stand-in again", async () => {
	await withRig(0.10, async ({ call }) => {
		await call("holdPieces", true);
		const t = await call<TaskRows>("commitThen", 0.12, "none", "resize");
		expect(t.held, "premise: the stand-in is held").toBe(true);
		const f = await call<FrameRows>("afterFrame");
		expect({ held: f.held, first: sumOf(f.first).stand, resized: f.did && f.did.w1 !== f.did.w0 }, `premise: the first frame copied the stand-in, then the layer was resized (${JSON.stringify(f)})`)
			.toEqual({ held: true, first: 1, resized: true });
		const later = sumOf(f.later);
		expect({ again: later.stand >= 1, pts: later.pts }, `the frames after the resize copy the stand-in again, nothing by path (${JSON.stringify(f)})`)
			.toEqual({ again: true, pts: 0 });
	});
}, 120_000);

itHeld("9d: a resize at the same camera that leaves its repaint to the queued frame (eraser tool active) after the copy frame copies the stand-in again", async () => {
	await withRig(0.10, async ({ call }) => {
		await call("holdPieces", true);
		const t = await call<TaskRows>("commitThen", 0.12, "none", "resize-scheduled");
		expect(t.held, "premise: the stand-in is held").toBe(true);
		const f = await call<FrameRows>("afterFrame");
		expect({ held: f.held, first: sumOf(f.first).stand, resized: f.did && f.did.h1 !== f.did.h0, inTask: f.did && f.did.inTask, queued: f.did && f.did.queued,
			camKept: f.did && f.did.camKept },
			`premise: the first frame copied the stand-in, then the layer was reallocated shorter at the same camera, with no repaint in its task and one queued (${JSON.stringify(f)})`)
			.toEqual({ held: true, first: 1, resized: true, inTask: 0, queued: true, camKept: true });
		const later = sumOf(f.later);
		expect({ again: later.stand >= 1, pts: later.pts }, `the queued frame copies the stand-in again onto the reallocated layer, nothing by path (${JSON.stringify(f)})`)
			.toEqual({ again: true, pts: 0 });
	});
}, 120_000);

itHeld("9e: a device ratio change between the copy frame and the next whole repaint lets the stand-in go and draws by path, with ink", async () => {
	await withRig(0.10, async ({ call }) => {
		await call("holdPieces", true);
		const t = await call<TaskRows>("commitThen", 0.12, "none", "dpr", true);
		expect(t.held, "premise: the stand-in is held").toBe(true);
		const f = await call<FrameRows>("afterFrame");
		expect({ first: sumOf(f.first).stand, d1: f.did && f.did.d1, held: f.held }, `premise: the first frame copied the stand-in, then the device ratio went to 1.5 (${JSON.stringify(f)})`)
			.toEqual({ first: 1, d1: 1.5, held: false });
		const later = sumOf(f.later);
		expect({ stand: later.stand, byPath: later.pts > 0 }, `the frames after the change copy nothing and draw by path (${JSON.stringify(f)})`)
			.toEqual({ stand: 0, byPath: true });
		expect(await call<number>("wholeLayerInk"), "the layer holds ink after").toBeGreaterThan(100);
		await call("holdPieces", false);
	});
}, 120_000);

it("8c: the stand-in let go before the frame cancels the copy, and the frame draws by path", async () => {
	await withRig(0.10, async ({ call }) => {
		await call("holdPieces", true);
		const t = await call<TaskRows>("commitThen", 0.12, "drop");
		expect(t.held, "premise: the stand-in was let go in the task").toBe(false);
		const f = await call<FrameRows>("afterFrame", null);
		const sm = sumOf(f.rows);
		expect({ stand: sm.stand, drewByPath: sm.pts > 0 }, `the frame (${JSON.stringify(f)})`).toEqual({ stand: 0, drewByPath: true });
		await call("holdPieces", false);
	});
}, 120_000);

it("8d: with no stand-in, whole repaints draw in their own task as before", async () => {
	await withRig(1, async ({ call }) => {
		const t = await call<TaskRows>("commitThen", null, "twice");
		expect({ held: t.held, repaints: t.rows.length, byPath: t.rows.every(r => r.pts > 0), stand: sumOf(t.rows).stand },
			`the two repaints at 100 percent (${JSON.stringify(t)})`).toEqual({ held: false, repaints: 2, byPath: true, stand: 0 });
	});
}, 120_000);

for (const fallback of ["settle to 100 percent", "erase", "smoothing change"] as const) {
	itHeld(`6: ${fallback} while the stand-in is up paints by path and holds no stand-in after`, async () => {
		await withRig(0.10, async ({ page, mounted, call, rows }) => {
			const { s1 } = await softSettle(call, rows);
			expect(s1.held, "premise: the stand-in is on screen").toBe(true);
			expect(await call<boolean>("keepStandInCanvas"), "premise: the stand-in's canvas is kept for the check").toBe(true);
			const n1 = (await rows()).length;
			if (fallback === "settle to 100 percent") await call("rezoom", 1);
			else if (fallback === "erase") await call("eraseVisible", 3);
			else await call("shapingOff");
			await call("holdPieces", false);
			await sleep(300);
			const after = (await rows()).slice(n1).filter(r => r.painted);
			const s2 = await call<Stand>("standIn");
			const kept = await call<number[] | null>("keptStandInSize");
			expect({ held: s2.held, released: kept, drewByPath: pathPts(after) > 0 },
				`after the ${fallback}: no stand-in, its canvas released, the layer drawn by path (${JSON.stringify({ s2, works: after.map(r => [r.work, r.pts]) })})`)
				.toEqual({ held: false, released: [0, 0], drewByPath: true });
			await call("awaitSharp");
			const clip = paneClip(mounted);
			const shown = await page.screenshot({ clip });
			await call("pathRedraw");
			const path = await page.screenshot({ clip });
			const d = await inkShift(page, shown, path);
			expect(d.over, `the layer after the ${fallback} is the path redraw (${JSON.stringify(d)})`).toBe(0);
		});
	}, 120_000);
}

itHeld("7: the stand-in's canvases are released when the sharp raster is copied in", async () => {
	await withRig(0.10, async ({ call, rows }) => {
		const { s1 } = await softSettle(call, rows);
		expect(s1.held, "premise: the stand-in is on screen").toBe(true);
		expect(await call<boolean>("keepStandInCanvas"), "premise: the stand-in's canvas is kept for the check").toBe(true);
		const size0 = await call<number[] | null>("keptStandInSize");
		expect(size0 && size0[0]! * size0[1]!, "premise: the kept canvas has a backing").toBeGreaterThan(0);
		await call("holdPieces", false);
		const sharpAt = await call<{ held: boolean }>("awaitSharp");
		expect({ held: sharpAt.held, size: await call<number[] | null>("keptStandInSize") }, "after the copy-in: no stand-in, its canvas released").toEqual({ held: false, size: [0, 0] });
	});
}, 120_000);
