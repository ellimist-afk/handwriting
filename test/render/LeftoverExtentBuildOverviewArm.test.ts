/**
 * AN EXTENT BUILD LEFT OVER FROM THE FIT VIEW, STILL SET AT A 400 PERCENT LANDING.
 *
 * The zoom-out overview is armed only by a whole repaint that finds no extent raster held and no extent build under way. Below
 * 100 percent the extent raster is built in pieces, and a pinch holds the pieces back. So a pinch that opens while the fit view's
 * build is part way lands with that build still set: at 400 percent no build may be armed (the build is for below 100 percent
 * only), and the landing's whole repaint arms no overview either, because the old build is still there.
 *
 * Held pieces still run their timer. The old build's next timer finds the zoom changed and drops the build (the hold check comes
 * before the piece gate). It then asks for a whole repaint only when a stand-in is held. With none held nothing asks again, no
 * overview is ever armed, and a zoom out from the landing has nothing to show for the ink outside the start view: the old cut
 * stays on screen.
 *
 * Two cells, the same landing in each, with the landing frames run and the old build gone. The first asserts an overview is armed
 * by then. The control then asks one whole repaint, as the dropped build would with a stand-in held, and asserts that arms the
 * overview. The pair shows the first cell reads the missing repaint, not a rig that never arms an overview.
 *
 * A guard cell: the same build, half drawn, with the pinch to 400 percent opened and still held. The old build is dropped there,
 * as its timer drops it when it no longer holds (forced here: extentBuildHolds answers false for that one piece). Right before
 * that piece, any stand-in held is let go through the plugin's own dropStandIn, so the drop reads the no stand-in branch. Under the
 * pinch no overview may be armed; after the pinch ends, the landing arms one. Whether a stand-in or an extent raster is held at the
 * pinch open, around the drop's piece and after the drop's frames is logged, not checked: a paint under the pinch may make one.
 *
 * A plain landing cell: no build left over and no overview held. The mount's build runs whole, then a pinch to 400 percent and a
 * lift, with no usable extent raster and no build at the landing. The landing's paint is the pinch settle's, run while the pinch
 * is still counted as held, so it is a landing only if the overview arm lets the settle's paint through. Pass: an overview is
 * armed after the lift.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/LeftoverExtentBuildOverviewArm.test.ts
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
const COUNT = 4000;
const PANE = { w: 1184, h: 824 };
const DSF = 2;
const PATH = "Untitled 1.md";
const INK_W = 11000 + 40 + 120;
/** The fit view: the whole width of the ink inside the pane. */
const FIT_ZOOM = PANE.w / INK_W;
/** The mount at the pinch floor (MIN_PINCH_SCALE): below it a commit that is not Fit is refused. */
const MOUNT_ZOOM = 0.1;
const LAND_ZOOM = 4;

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
function syntheticInk(count: number): string {
	const rnd = seeded(37);
	const strokes = [];
	for (let i = 0; i < count; i++) strokes.push(strokeJson(i + 1, 40 + rnd() * 11000, 40 + rnd() * 13000, rnd));
	return JSON.stringify({ ...TEMPLATE, strokes, images: [], textBoxes: [] });
}
const FIXTURE = syntheticInk(COUNT);

// The shared page rig, plus a read of the extent build, the overview and the stand-in, a run of pieces to half the build, and one
// whole repaint. One bundle, one store instance.
const ENTRY = `import "./panBakeRepaintPage.ts";
import { overlayForPath, inlineInk } from "../../src/inline/InkOverlay";
const PATH = ${JSON.stringify(PATH)};
(window as any).leftover = {
	read() {
		const o: any = overlayForPath(PATH), e = o.extentBuild, b = o.overviewBuild;
		return { zoom: o.lastPaintCam?.zoom ?? null, cssScale: o.cssScale,
			extentBuild: e ? { next: e.next, count: e.count, zoom: e.cam0.zoom } : null,
			overviewBuild: b ? { next: b.next, count: b.count, zoom: b.at.zoom } : null,
			overview: !!o.overview, standIn: !!o.standIn, pinchHeld: !!o.pinchHeld() };
	},
	/** Whether the extent raster held, if any, holds at the last painted camera: usableExtent's test, read on its own. */
	extentUsable() {
		const o: any = overlayForPath(PATH), e = o.extentRaster, cam = o.lastPaintCam;
		return !!e && !!cam && !!o.extentHolds(e, cam, inlineInk.strokes(PATH));
	},
	/** Run pieces past the hold, one at a time as their timers would, until the build has drawn half its strokes. */
	toHalf(limit: number) {
		const P: any = (window as any).panBake, o: any = overlayForPath(PATH);
		for (let i = 0; i < limit; i++) {
			const e = o.extentBuild;
			if (!e || e.next * 2 >= e.count) break;
			P.stepPiece();
		}
		const e = o.extentBuild;
		return e ? { next: e.next, count: e.count } : null;
	},
	/** Open a pinch toward \`to\` and keep the fingers down: the begin and the moves of pinchLift, one move a frame, no end. */
	pinchOpen(to: number, steps: number) {
		const o: any = overlayForPath(PATH), router = o.router, from = o.pinchScaleNow;
		const r = (document.body.querySelector(":scope > div") as HTMLElement).getBoundingClientRect();
		const cx = r.left + r.width / 2, cy = r.top + r.height / 2, s0 = 100, s1 = 100 * to / from;
		const touch = (s: number) => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
		const ev = (type: string) => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		(window as any).leftover.pinchEnd = () => { router.endPinch(ev("pointerup"), { x: cx, y: cy }); router.touchPos.clear(); return true; };
		touch(s0); router.beginPinch(ev("pointerdown"));
		return new Promise<boolean>(done => {
			const move = (i: number) => {
				touch(s0 + (s1 - s0) * i / steps); router.updatePinch(ev("pointermove"));
				if (i < steps) requestAnimationFrame(() => move(i + 1)); else requestAnimationFrame(() => done(true));
			};
			requestAnimationFrame(() => move(1));
		});
	},
	/** Whether a stand-in and an extent raster are held. */
	held() {
		const o: any = overlayForPath(PATH);
		return { standIn: !!o.standIn, extentRaster: !!o.extentRaster };
	},
	/**
	 * Let go any stand-in held through the plugin's own dropStandIn, then run the old build's next piece with its hold check
	 * answering false, as its timer runs it once the build no longer holds. One task, so no paint runs between the two. Returns
	 * whether a stand-in is held right before the piece, and what is held right before and right after it.
	 */
	dropBuild() {
		const o: any = overlayForPath(PATH), L = (window as any).leftover;
		o.dropStandIn();
		const standInAtDrop = !!o.standIn, before = L.held();
		o.extentBuildHolds = () => false;
		try { o.runExtentPiece(); } finally { delete o.extentBuildHolds; }
		return { standInAtDrop, before, after: L.held() };
	},
	/** \`n\` animation frames. */
	frames(n: number) { return new Promise<boolean>(r => { const f = () => (--n > 0 ? requestAnimationFrame(f) : r(true)); requestAnimationFrame(f); }); },
	/** One whole repaint, as repaintOverStandIn asks one. */
	wholeRepaint() {
		const o: any = overlayForPath(PATH);
		o.damage.addAll(); o.scheduleRepaint("other");
		return true;
	},
};`;

let browser: Browser, script: string;
beforeAll(async () => {
	const b = await build({
		stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("./", import.meta.url)), sourcefile: "leftoverExtentBuildEntry.ts", loader: "ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1700,1000"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

type Read = { zoom: number | null; cssScale: number; extentBuild: { next: number; count: number; zoom: number } | null;
	overviewBuild: { next: number; count: number; zoom: number } | null; overview: boolean; standIn: boolean; pinchHeld: boolean };
const read = (page: Page) => page.evaluate(() => (window as any).leftover.read()) as Promise<Read>;
type Held = { standIn: boolean; extentRaster: boolean };
const held = (page: Page) => page.evaluate(() => (window as any).leftover.held()) as Promise<Held>;

/** Mount the note at the pinch floor and let the mount's own build finish: an extent raster held, no build pending. */
async function mountWhole(page: Page): Promise<void> {
	console.log("[cell] mount");
	await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addStyleTag({ content: MINIMAL_CSS });
	await page.addScriptTag({ content: script });
	const mounted = await page.evaluate(([z, s, id, w, h, n]) => (window as any).panBake.mount(z, s, id, w, h, n), [MOUNT_ZOOM, FIXTURE, PAGE_ID, PANE.w, PANE.h, COUNT] as const) as any;
	expect(mounted.strokes, "premise: every stroke loaded").toBe(COUNT);
	expect(mounted.zoomCommitted, "premise: the mount's zoom committed").toBe(true);
	// The mount's build is armed and then whole: an extent raster held and no build pending. On a miss the premise below reads why.
	await page.waitForFunction(() => { const P = (window as any).panBake; return P.extent() !== null && P.build() === null; }, null, { timeout: 30_000 }).catch(() => {});
	expect(((await page.evaluate(() => (window as any).panBake.awaitWhole())) as any).pending, "premise: the build the mount armed finished").toBe(false);
}

/** Mount the note, let the mount's own build finish, hold the pieces, commit the fit view and run its build to half. */
async function halfDrawnFitBuild(page: Page): Promise<void> {
	await mountWhole(page);
	await page.evaluate(() => (window as any).panBake.holdPieces(true));
	console.log("[cell] fit");
	const fit = await page.evaluate((z) => (window as any).panBake.rezoom(z), FIT_ZOOM) as any;
	expect(fit.ok, "premise: the fit view committed").toBe(true);
	console.log("[cell] half");
	const half = await page.evaluate(() => (window as any).leftover.toHalf(4000)) as { next: number; count: number } | null;
	expect(half && half.next * 2 >= half.count && half.next < half.count, `premise: the fit view's build is half drawn (${JSON.stringify(half)})`).toBe(true);
}

/**
 * The half drawn fit view build, then a pinch to 400 percent and a lift, the pieces still held. Runs the landing frames and returns
 * the state then.
 */
async function landWithLeftoverBuild(page: Page): Promise<Read> {
	await halfDrawnFitBuild(page);
	console.log("[cell] pinch");
	const lift = await page.evaluate((z) => (window as any).panBake.pinchLift(z), LAND_ZOOM) as any;
	console.log("[cell] landing frames");
	const land = await frames(page);
	expect(land.cssScale, `premise: the pinch landed at 400 percent (${JSON.stringify(lift)})`).toBeCloseTo(LAND_ZOOM, 1);
	expect(land.pinchHeld, "premise: the pinch is over").toBe(false);
	expect(land.extentBuild, `premise: the fit view's build is gone after the landing frames (${JSON.stringify(land)})`).toBeNull();
	expect(land.standIn, `premise: no stand-in is held at the landing (${JSON.stringify(land)})`).toBe(false);
	return land;
}

/**
 * Wait until the pinch is over and the old build is gone (its piece timer dropped it), then run 8 frames and read. On a miss the
 * caller's premises read the state.
 */
async function frames(page: Page): Promise<Read> {
	await page.waitForFunction(() => { const r = (window as any).leftover.read(); return !r.pinchHeld && r.extentBuild === null; }, null, { timeout: 10_000 }).catch(() => {});
	await page.evaluate(() => new Promise<void>(r => { let n = 8; const f = () => (--n > 0 ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); }));
	return read(page);
}

async function withPage(body: (page: Page) => Promise<void>) {
	const context = await browser.newContext({ viewport: null, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await body(page);
		expect(errors).toEqual([]);
	} finally { await context.close(); }
}

it("a fit view build left half drawn through a pinch to 400 percent, no stand-in held: once the build is dropped, an overview is armed for the zoom out", async () => {
	await withPage(async (page) => {
		const land = await landWithLeftoverBuild(page);
		expect(land.overviewBuild !== null || land.overview, `no overview armed after the old build dropped itself (${JSON.stringify(land)})`).toBe(true);
	});
}, 60_000);

it("control: the same landing, then one whole repaint: it arms the overview", async () => {
	await withPage(async (page) => {
		await landWithLeftoverBuild(page);
		console.log("[cell] whole repaint");
		await page.evaluate(() => (window as any).leftover.wholeRepaint());
		const after = await frames(page);
		expect(after.overviewBuild !== null || after.overview, `no overview armed after a whole repaint (${JSON.stringify(after)})`).toBe(true);
	});
}, 60_000);

it("guard: the old build drops itself while the pinch is still held: no overview is armed under the pinch, and the pinch end arms one", async () => {
	await withPage(async (page) => {
		await halfDrawnFitBuild(page);
		console.log("[cell] pinch open");
		await page.evaluate((z) => (window as any).leftover.pinchOpen(z, 8), LAND_ZOOM);
		const open = await read(page);
		console.log(`[cell] held at the pinch open ${JSON.stringify(await held(page))}`);
		expect(open.pinchHeld, `premise: the pinch is held (${JSON.stringify(open)})`).toBe(true);
		expect(open.extentBuild, `premise: the fit view's build is still set under the pinch (${JSON.stringify(open)})`).not.toBeNull();
		console.log("[cell] let go the stand-in, drop under the pinch");
		const drop = await page.evaluate(() => (window as any).leftover.dropBuild()) as { standInAtDrop: boolean; before: Held; after: Held };
		console.log(`[cell] held before the drop's piece ${JSON.stringify(drop.before)}, after it ${JSON.stringify(drop.after)}`);
		expect(drop.standInAtDrop, `premise: no stand-in is held right before the drop (${JSON.stringify(drop)})`).toBe(false);
		await page.evaluate(() => (window as any).leftover.frames(8));
		const mid = await read(page);
		console.log(`[cell] held after the drop's frames ${JSON.stringify(await held(page))}`);
		expect(mid.pinchHeld, "premise: the pinch is still held after the drop").toBe(true);
		expect(mid.extentBuild, `premise: the old build dropped itself (${JSON.stringify(mid)})`).toBeNull();
		expect(mid.overviewBuild === null && !mid.overview, `an overview was armed under the pinch (${JSON.stringify(mid)})`).toBe(true);
		console.log("[cell] pinch end");
		await page.evaluate(() => (window as any).leftover.pinchEnd());
		const end = await frames(page);
		expect(end.cssScale, `premise: the pinch landed at 400 percent (${JSON.stringify(end)})`).toBeCloseTo(LAND_ZOOM, 1);
		expect(end.overviewBuild !== null || end.overview, `no overview armed after the pinch end (${JSON.stringify(end)})`).toBe(true);
	});
}, 60_000);

it("a plain pinch landing at 400 percent, no build left over and no overview held: the landing arms an overview for the zoom out", async () => {
	await withPage(async (page) => {
		await mountWhole(page);
		const before = await read(page);
		expect(before.extentBuild, `premise: no build is left over before the pinch (${JSON.stringify(before)})`).toBeNull();
		expect(before.overviewBuild === null && !before.overview, `premise: no overview is held before the pinch (${JSON.stringify(before)})`).toBe(true);
		console.log("[cell] pinch");
		const lift = await page.evaluate((z) => (window as any).panBake.pinchLift(z), LAND_ZOOM) as any;
		console.log("[cell] landing frames");
		const land = await frames(page);
		expect(land.cssScale, `premise: the pinch landed at 400 percent (${JSON.stringify(lift)})`).toBeCloseTo(LAND_ZOOM, 1);
		expect(land.pinchHeld, "premise: the pinch is over").toBe(false);
		expect(land.extentBuild, `premise: no build at the landing (${JSON.stringify(land)})`).toBeNull();
		expect(await page.evaluate(() => (window as any).leftover.extentUsable()), `premise: no usable extent raster at the landing (${JSON.stringify(land)})`).toBe(false);
		expect(land.overviewBuild !== null || land.overview, `no overview armed after a plain pinch landing (${JSON.stringify(land)})`).toBe(true);
	});
}, 60_000);
