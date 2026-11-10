/**
 * AT OR ABOVE 100 PERCENT A ZOOM COMMIT SHOWS A SOFT PICTURE AT ONCE, THEN THE CRISP REPAINT.
 *
 * Below 100 percent a zoom settle shows a stand-in (the old raster scaled) while the sharp raster builds (ZoomSettleStandIn.test.ts).
 * At or above 100 percent the settle drew every stroke by path in the commit's task: on a heavy note that is the freeze the user sees.
 * Now the stand-in is taken there too, from the committed layer already in memory, and the crisp picture is the
 * by-path repaint a moment later (no extent raster builds above 100 percent).
 *
 *   1. k 1.5 and k 3: the commit's task draws nothing by path; the first frame after it copies the stand-in once and holds ink.
 *   2. The stand-in frame puts the ink where the path draw puts it, within 0.1 device px; the crisp frame that follows is the path
 *      redraw at the same camera, pixel for pixel (zero snap at the swap).
 *   3. A zoom out from k 3 to k 1.5 shows world the old layer never held: no stand-in, by path, ink in the first frame (no blank strip).
 *   4. A copy factor above 4 (from 20 to 150 percent): no stand-in, by path.
 *   5. A second zoom while the stand-in is up: the stand-in goes (never a copy of a copy), by path.
 *   6. A held pinch's pause commit: no stand-in, by path; released, the same commit holds it.
 *   7. The scale-source gap (cssScale against CodeMirror's scaleY) at k 1.5, 3 and 6, measured and recorded, not closed here.
 *   8. On a phone a layer over the 8 million device px cap: no stand-in, by path.
 *   9. A pinch lift to 150 percent (the router's own pinch, the settle path): the lift takes one snapshot and shows it, nothing by path.
 *  10. Timing, with a control arm: the longest task from the commit to the crisp layer is no longer than the control arm's
 *      (no stand-in, by path in the commit) and within 1 s. Run with the timing lock.
 *
 * Rig: the PanBakeRepaint page on the heavy note's real sidecar (HW_ISL_SIDECAR, 28,358 strokes, the staged copy of the vault note, not checked in). Gate arm DSF 2,
 * bounce off (Alan's device). HW_Z1A_DSF=1 runs the DSF 1 probe.
 *
 * Run: HW_ISL_SIDECAR=<sidecar copy> npx vitest run --config vitest.render.mts test/render/ZoomStandInAbove100.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";
import { timingBound } from "../ciBounds";

declare const process: { env: Record<string, string | undefined> };

const SIDECAR_PATH = process.env.HW_ISL_SIDECAR ?? "";
const HAVE = SIDECAR_PATH !== "" && existsSync(SIDECAR_PATH);
const FIXTURE = HAVE ? readFileSync(SIDECAR_PATH, "utf8") : "";
/** Every stroke in the sidecar copy (28358 in the staged copy; the vault note had 28555 on Orion). */
const STROKES = HAVE ? (JSON.parse(FIXTURE) as { strokes: unknown[] }).strokes.length : 0;
const PAGE_ID = "cf77b392-e4c0-47b3-b87a-b9583f5884cb";
const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const PANE = { w: 1184, h: 824 };
/** A taller and wider pane for the phone cap cell: at PANE the layer is about 7.8 million device px, under the 8 million cap. */
const CAP_PANE = { w: 1400, h: 950 };
const DSF = Number(process.env.HW_Z1A_DSF ?? "2");
/** The camera still bar in device px (InkOverlay CAMERA_STILL_BACKING_PX): the bar for where the soft frame's ink stands. */
const PLACE_BAR_PX = 0.1;
const cell = HAVE ? it : it.skip;

let browser: Browser, script: string;
beforeAll(async () => {
	if (!HAVE) return;
	const b = await build({ entryPoints: [fileURLToPath(new URL("./panBakeRepaintPage.ts", import.meta.url))], bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1700,1000"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Stand = { held: boolean; w: number; h: number; backing: number; count: number; snapshots: number | null };
type TaskRows = { ok: boolean; rows: Array<{ pts: number; stand: number }>; deferrals: number | null; held: boolean; factor: number | null };
type FrameRow = { work: string | null; pts: number; stand: number };
type FrameRows = { rows: FrameRow[]; first: FrameRow[]; later: FrameRow[]; held: boolean; rect: { x: number; y: number; w: number; h: number } | null; ink: number; layerInk: number };
const sumOf = (rs: Array<{ pts: number; stand: number }>) => ({ pts: rs.reduce((a, r) => a + r.pts, 0), stand: rs.reduce((a, r) => a + r.stand, 0) });
type Call = <T>(name: string, ...a: unknown[]) => Promise<T>;

/** Mount the heavy note at canvas zoom 1 with Infinite Canvas on, as desktop (the gate arm) or a phone, then run `body` with the recorder on. */
async function withRig(body: (api: { page: Page; mounted: any; call: Call }) => Promise<void>, mobile = false, pane = PANE) {
	const context = await browser.newContext({ viewport: null, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	page.on("console", m => { if (m.text().startsWith("Z1A ")) console.log(m.text()); });
	const call: Call = (name, ...a) => page.evaluate(([n, args]) => (window as any).panBake[n as string](...(args as unknown[])), [name, a] as const) as Promise<any>;
	try {
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		expect((await call<{ isMobile: boolean }>("platform", mobile)).isMobile, "premise: the platform").toBe(mobile);
		const mounted = await page.evaluate(([s, id, w, h, n]) => (window as any).panBake.mount(1, s, id, w, h, n), [FIXTURE, PAGE_ID, pane.w, pane.h, STROKES] as const) as any;
		expect(errors).toEqual([]);
		expect(mounted.strokes, "premise: every stroke loaded").toBe(STROKES);
		expect(mounted.dpr, "premise: the device ratio is the flag's").toBeCloseTo(DSF, 3);
		expect(mounted.canvasMode, "premise: Infinite Canvas on").toBe(true);
		await sleep(600);
		await page.evaluate(() => (window as any).panBake.record());
		try {
			await body({ page, mounted, call });
		} finally {
			await page.evaluate(() => (window as any).panBake.stop());
		}
		expect(errors).toEqual([]);
	} finally { await context.close(); }
}

/** Commit `to` from where the rig stands, with the pieces held so a stand-in stays up, and read the commit's task and frames. */
async function commit(call: Call, to: number) {
	await call("holdPieces", true);
	const t = await call<TaskRows>("commitThen", to, "none", "none", true);
	const f = await call<FrameRows>("afterFrame");
	return { t, f };
}

for (const to of [1.5, 3]) cell(`1: a zoom commit from 100 to ${to * 100} percent draws nothing by path in its task; the first frame copies the stand-in once and holds ink`, async () => {
	await withRig(async ({ call }) => {
		const { t, f } = await commit(call, to);
		expect(t.ok, "premise: the zoom committed").toBe(true);
		console.log(`Z1A first-frame k${to} ${JSON.stringify({ factor: t.factor, task: sumOf(t.rows), first: sumOf(f.first), frame: sumOf(f.rows), ink: f.ink, layerInk: f.layerInk })}`);
		expect({ held: t.held, taskPts: sumOf(t.rows).pts, firstStand: sumOf(f.first).stand, inked: f.ink > 100 },
			`stand-in held, no path points in the commit's task, one stand-in copy in the first frame, ink in it (${JSON.stringify({ t, f })})`)
			.toEqual({ held: true, taskPts: 0, firstStand: 1, inked: true });
		await call("holdPieces", false);
	});
}, 180_000);

for (const to of [1.5, 3]) cell(`2: at ${to * 100} percent the stand-in frame's ink stands where the path draw puts it, and the crisp frame is the path redraw (zero snap)`, async () => {
	await withRig(async ({ page, mounted, call }) => {
		const clip = { x: mounted.scrollRect.left, y: mounted.scrollRect.top, width: mounted.scrollRect.width, height: mounted.scrollRect.height };
		const { t } = await commit(call, to);
		expect(t.held, "premise: the stand-in is on screen").toBe(true);
		const softPlace = await call<{ dx: number; dy: number; inked: number }>("placeVsPath");
		await call("holdPieces", false);
		const t0 = Date.now();
		const sharpAt = await call<{ held: boolean }>("awaitSharp");
		const crispMs = Date.now() - t0;
		expect(sharpAt.held, "premise: the stand-in went").toBe(false);
		const sharp = await page.screenshot({ clip });
		const crispPlace = await call<{ dx: number; dy: number; inked: number }>("placeVsPath");
		await call("pathRedraw");
		const path = await page.screenshot({ clip });
		console.log(`Z1A swap k${to} ${JSON.stringify({ softPlace, crispPlace, crispMs, same: sharp.equals(path) })}`);
		expect(softPlace.inked, "premise: the window holds ink").toBeGreaterThan(1000);
		expect(Math.max(Math.abs(softPlace.dx), Math.abs(softPlace.dy)), `the stand-in frame's ink within ${PLACE_BAR_PX} px of the path draw (${JSON.stringify(softPlace)})`)
			.toBeLessThanOrEqual(PLACE_BAR_PX);
		// The sub-pixel fit reads a small residual even on identical rasters (the ink is not symmetric about the window), so the
		// crisp frame is held to the same bar as the stand-in frame, and to pixel equality with a path redraw at the same camera.
		expect({ near: Math.max(Math.abs(crispPlace.dx), Math.abs(crispPlace.dy)) <= PLACE_BAR_PX, same: sharp.equals(path) },
			`the crisp frame is the path redraw at the same camera (${JSON.stringify(crispPlace)})`).toEqual({ near: true, same: true });
	});
}, 180_000);

cell("3: a zoom out from 300 to 150 percent shows world the old layer never held: no stand-in, by path, ink in the first frame", async () => {
	await withRig(async ({ call }) => {
		const z = await call<{ ok: boolean }>("rezoom", 3);
		expect(z.ok, "premise: the zoom to 300 percent committed").toBe(true);
		expect((await call<{ held: boolean }>("awaitSharp")).held, "premise: nothing held at 300 percent before the zoom out").toBe(false);
		const { t, f } = await commit(call, 1.5);
		expect(t.ok, "premise: the zoom out committed").toBe(true);
		expect({ held: t.held, frameStand: sumOf(f.rows).stand, byPath: sumOf(t.rows).pts + sumOf(f.rows).pts > 0, inked: f.layerInk > 100 },
			`no stand-in held or copied; drawn by path; ink in the first frame (${JSON.stringify({ t, f })})`)
			.toEqual({ held: false, frameStand: 0, byPath: true, inked: true });
		await call("holdPieces", false);
	});
}, 180_000);

// At or above 100 percent the copy factor is the backing ratio only (the camera's zoom is the font zoom, the layer covers the band),
// at most 2 at one device ratio; a factor above 4 comes from a commit that starts below 100 percent.
cell("4: a zoom commit from 20 to 150 percent (copy factor above 4) holds no stand-in and draws by path", async () => {
	await withRig(async ({ call }) => {
		const z = await call<{ ok: boolean }>("rezoom", 0.2);
		expect(z.ok, "premise: the zoom to 20 percent committed").toBe(true);
		await call("awaitWhole");
		expect((await call<{ held: boolean }>("awaitSharp")).held, "premise: nothing held before the commit").toBe(false);
		const { t, f } = await commit(call, 1.5);
		expect(t.ok, "premise: the zoom committed").toBe(true);
		expect(t.factor, `premise: the copy factor is above 4 (${JSON.stringify(t)})`).toBeGreaterThan(4);
		expect({ held: t.held, frameStand: sumOf(f.rows).stand, byPath: sumOf(t.rows).pts + sumOf(f.rows).pts > 0 },
			`no stand-in held or copied; drawn by path (${JSON.stringify({ t, f })})`).toEqual({ held: false, frameStand: 0, byPath: true });
		await call("holdPieces", false);
	});
}, 180_000);

cell("5: a second zoom while the stand-in is up lets it go and draws by path (never a copy of a copy)", async () => {
	await withRig(async ({ call }) => {
		const first = await commit(call, 1.5);
		expect(first.t.held, "premise: the first zoom holds a stand-in").toBe(true);
		const s1 = await call<Stand>("standIn");
		const { t, f } = await commit(call, 2);
		const s2 = await call<Stand>("standIn");
		expect({ held: t.held, snapshots: (s2.snapshots ?? -1) - (s1.snapshots ?? 0), frameStand: sumOf(f.rows).stand, byPath: sumOf(t.rows).pts + sumOf(f.rows).pts > 0, inked: f.layerInk > 100 },
			`the second zoom holds no stand-in, takes no snapshot, copies none, draws by path with ink (${JSON.stringify({ t, f, s1, s2 })})`)
			.toEqual({ held: false, snapshots: 0, frameStand: 0, byPath: true, inked: true });
		await call("holdPieces", false);
	});
}, 180_000);

cell("6: a zoom commit to 150 percent while a pinch is held takes no snapshot and draws by path; released, the same commit takes one and holds the stand-in", async () => {
	const got: Record<string, unknown> = {};
	for (const pinch of [true, false]) await withRig(async ({ call }) => {
		await call("gate", "pinch", pinch);
		// The snapshot count, as in cell 5: a snapshot taken inside a held pinch and dropped by the next paint leaves the
		// screen the same, so only the count shows the whole-layer copy a held pinch would waste.
		const s0 = await call<Stand>("standIn");
		const { t, f } = await commit(call, 1.5);
		const s1 = await call<Stand>("standIn");
		await call("gate", "pinch", false);
		got[pinch ? "held" : "released"] = { held: t.held, snapshots: (s1.snapshots ?? -1) - (s0.snapshots ?? 0), frameStand: sumOf(f.rows).stand, inked: f.layerInk > 100 };
		await call("holdPieces", false);
	});
	expect(got, `pinch held: no snapshot, by path; released: one snapshot, the stand-in (${JSON.stringify(got)})`).toEqual({
		held: { held: false, snapshots: 0, frameStand: 0, inked: true },
		released: { held: true, snapshots: 1, frameStand: 1, inked: true },
	});
}, 240_000);

cell("7: the scale-source gap at 150, 300 and 600 percent, measured and recorded; the gap stays open", async () => {
	await withRig(async ({ call }) => {
		const rows: unknown[] = [];
		for (const to of [1.5, 3, 6]) {
			const z = await call<{ ok: boolean; cssScale: number }>("rezoom", to);
			expect(z.ok, `premise: the zoom to ${to} committed`).toBe(true);
			const r = await call<{ cssScale: number; scaleY: number; docPx: number }>("scaleGap");
			rows.push({ to, ...r });
		}
		console.log(`Z1A scale-gap ${JSON.stringify(rows.map((r: any) => ({ ...r, gapPx: r.docPx ? Math.abs(r.cssScale - r.scaleY) * r.docPx : null })))}`);
		expect(rows.length).toBe(3);
	});
}, 180_000);

cell("8: on a phone a stand-in over the 8 million device px cap is refused: a zoom commit to 150 percent draws by path", async () => {
	await withRig(async ({ call }) => {
		// The stand-in's source is the layer on screen before the commit, so the cap premise reads that layer.
		const layer = await call<{ w: number; h: number }>("layerSize");
		expect(layer.w * layer.h, `premise: the layer is over the mobile cap (${JSON.stringify(layer)})`).toBeGreaterThan(8_000_000);
		const { t, f } = await commit(call, 1.5);
		expect(t.ok, "premise: the zoom committed").toBe(true);
		expect({ held: t.held, frameStand: sumOf(f.rows).stand, byPath: sumOf(t.rows).pts + sumOf(f.rows).pts > 0, inked: f.layerInk > 100 },
			`no stand-in held or copied; drawn by path with ink (${JSON.stringify({ t, f })})`).toEqual({ held: false, frameStand: 0, byPath: true, inked: true });
		await call("holdPieces", false);
	}, true, CAP_PANE);
}, 180_000);

cell("9: a pinch lift from 100 to 150 percent takes one snapshot and shows it: the settle draws nothing by path", async () => {
	await withRig(async ({ call }) => {
		await call("holdPieces", true);
		const p = await call<{ cssScale: number; rows: Array<{ pts: number; stand: number }>; held: boolean; snapshots: number }>("pinchLift", 1.5);
		console.log(`Z1A pinch-lift ${JSON.stringify(p)}`);
		expect(p.cssScale, `premise: the lift settled near 150 percent (${JSON.stringify(p)})`).toBeGreaterThan(1.3);
		expect({ snapshots: p.snapshots, held: p.held, stand: sumOf(p.rows).stand > 0, pts: sumOf(p.rows).pts },
			`one snapshot, held, copied, no path points from the lift on (${JSON.stringify(p)})`).toEqual({ snapshots: 1, held: true, stand: true, pts: 0 });
		await call("holdPieces", false);
	});
}, 180_000);

cell("10: timing at 150 and 300 percent: the longest task from the commit to the crisp layer is no longer than the control arm's (no stand-in), and within 1 s", async () => {
	const longest: Record<string, number> = {};
	for (const to of [1.5, 3]) for (const arm of ["control", "stand-in"] as const) await withRig(async ({ call }) => {
		if (arm === "control") await call("standInOff");
		await call("longTasks", true);
		const z = await call<{ ok: boolean }>("rezoom", to);
		expect(z.ok, "premise: the zoom committed").toBe(true);
		const sharp = await call<{ held: boolean }>("awaitSharp");
		expect(sharp.held, "premise: no stand-in left").toBe(false);
		await sleep(300);
		const tape = await call<Array<{ start: number; dur: number }>>("longTasks", false);
		longest[`${arm} k${to}`] = Math.round(tape.reduce((m, x) => Math.max(m, x.dur), 0));
	});
	console.log(`Z1A timing ${JSON.stringify(longest)}`);
	for (const to of [1.5, 3]) {
		const s = longest[`stand-in k${to}`]!, c = longest[`control k${to}`]!;
		expect(s, `k${to}: longest task with the stand-in against the control arm, ms (${JSON.stringify(longest)})`).toBeLessThanOrEqual(c * 1.1 + 50);
		expect(s, `k${to}: longest task with the stand-in within the bound, ms (${JSON.stringify(longest)})`).toBeLessThanOrEqual(timingBound(1000));
	}
}, 600_000);
