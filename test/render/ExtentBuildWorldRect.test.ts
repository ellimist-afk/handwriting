/**
 * A STROKE COMMITTED OUTSIDE THE EXTENT RASTER'S WORLD WHILE ITS BUILD IS PART WAY.
 *
 * Below 100 percent the extent raster is built in pieces. A stroke added to the end of the store while a build is under way is taken
 * into it only when the stroke lies inside the raster's world rect (extentBuildHolds); a stroke outside it must drop the build. If
 * that check were lost, the build would finish with a raster that counts the stroke but holds none of its ink, and every strip
 * copied from it would show the note without the stroke.
 *
 * The finished raster compared with a one-pass reference cannot see this: the reference is drawn on a canvas of the raster's own
 * size, so both leave the stroke out. These cells read the rule instead: no raster is handed over whose stroke list holds a stroke
 * its world rect does not cover.
 *
 * Three cells: a stroke below the whole ink drops the build (red against a build that keeps it), and a stroke inside the world is
 * taken into the build and its count (the control: the hold is not a drop of everything).
 *
 * Run: npx vitest run --config vitest.render.mts test/render/ExtentBuildWorldRect.test.ts
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

// The shared page rig plus the ink store and the overlay lookup it already bundles, so a cell can add a stroke to the store the rig's
// overlay reads and read what the build and the raster hold. One bundle, one store instance.
const ENTRY = `import "./panBakeRepaintPage.ts";
import { inlineInk, overlayForPath } from "../../src/inline/InkOverlay";
import { parsePage } from "../../src/model/PageData";
(window as any).worldRect = {
	add(path: string, json: string, id: string) { inlineInk.applyAdd(path, parsePage(json, id).data.strokes); return inlineInk.strokes(path).length; },
	read(path: string) {
		const o: any = overlayForPath(path), b = o.extentBuild, e = o.extentRaster;
		const outside = (r: any) => r.strokes.slice(0, r.count).filter((s: any) => !(s.bbox.x >= r.world.x0 && s.bbox.y >= r.world.y0 &&
			s.bbox.x + s.bbox.width <= r.world.x1 && s.bbox.y + s.bbox.height <= r.world.y1)).length;
		return { build: b ? { next: b.next, count: b.count, outside: outside(b) } : null,
			raster: e ? { count: e.count, outside: outside(e) } : null, store: inlineInk.strokes(path).length };
	},
};`;

let browser: Browser, script: string;
beforeAll(async () => {
	const b = await build({
		stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("./", import.meta.url)), sourcefile: "extentBuildWorldRectEntry.ts", loader: "ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1700,1000"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Mount the note at 10 percent, arm a build by a zoom to 12 percent, hold the pieces, and run one so the build is part way. */
async function withPartWayBuild(body: (page: Page) => Promise<void>) {
	const context = await browser.newContext({ viewport: null, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await page.evaluate(([z, s, id, w, h, n]) => (window as any).panBake.mount(z, s, id, w, h, n), [0.10, FIXTURE, PAGE_ID, PANE.w, PANE.h, COUNT] as const) as any;
		expect(mounted.strokes, "premise: every stroke loaded").toBe(COUNT);
		expect(mounted.zoomCommitted, "premise: the zoom committed").toBe(true);
		await sleep(600);
		expect(((await page.evaluate(() => (window as any).panBake.awaitWhole())) as any).pending, "premise: the build the mount armed finished").toBe(false);
		await page.evaluate(() => (window as any).panBake.holdPieces(true));
		await page.evaluate(() => (window as any).panBake.rezoom(0.12));
		await page.evaluate(() => (window as any).panBake.stepPiece());
		const b0 = await page.evaluate(() => (window as any).panBake.build()) as any;
		expect(b0 && b0.next > 0 && b0.next < b0.count, `premise: a build is part way (${JSON.stringify(b0)})`).toBe(true);
		const r0 = await page.evaluate((p) => (window as any).worldRect.read(p), PATH) as any;
		expect(r0.build.outside, "premise: every stroke the build counts lies inside its world").toBe(0);
		await body(page);
		expect(errors).toEqual([]);
	} finally { await context.close(); }
}

/** One stroke as a page's JSON, its first point at (x, y) in world css px. */
const oneStroke = (x: number, y: number) => JSON.stringify({ ...TEMPLATE, strokes: [strokeJson(COUNT + 1, x, y, seeded(5))], images: [], textBoxes: [] });

it("a stroke committed below the raster's world while the build is part way drops the build; no raster is handed over that counts it unseen", async () => {
	await withPartWayBuild(async (page) => {
		const n = await page.evaluate(([p, j, id]) => (window as any).worldRect.add(p, j, id), [PATH, oneStroke(500, 14500), PAGE_ID] as const) as number;
		expect(n, "premise: the stroke is in the store").toBe(COUNT + 1);
		await page.evaluate(() => (window as any).panBake.holdPieces(false));
		await page.evaluate(() => (window as any).panBake.awaitWhole());
		await sleep(300);
		const r = await page.evaluate((p) => (window as any).worldRect.read(p), PATH) as any;
		expect(r.build?.outside ?? 0, `the build still counts the outside stroke (${JSON.stringify(r)})`).toBe(0);
		expect(r.raster?.outside ?? 0, `a finished raster counts a stroke its world does not hold (${JSON.stringify(r)})`).toBe(0);
	});
}, 180_000);

it("control: a stroke committed inside the raster's world while the build is part way is taken into the build, which finishes holding it", async () => {
	await withPartWayBuild(async (page) => {
		const n = await page.evaluate(([p, j, id]) => (window as any).worldRect.add(p, j, id), [PATH, oneStroke(5000, 6000), PAGE_ID] as const) as number;
		expect(n, "premise: the stroke is in the store").toBe(COUNT + 1);
		await page.evaluate(() => (window as any).panBake.holdPieces(false));
		const whole = await page.evaluate(() => (window as any).panBake.awaitWhole()) as any;
		expect(whole.pending, "premise: the build finished").toBe(false);
		const r = await page.evaluate((p) => (window as any).worldRect.read(p), PATH) as any;
		expect(r.raster && { count: r.raster.count, outside: r.raster.outside }, `the finished raster holds the stroke (${JSON.stringify(r)})`).toEqual({ count: COUNT + 1, outside: 0 });
	});
}, 180_000);

it("a stroke committed beyond the raster's world on the right while the build is part way drops the build; no raster is handed over that counts it unseen", async () => {
	await withPartWayBuild(async (page) => {
		const n = await page.evaluate(([p, j, id]) => (window as any).worldRect.add(p, j, id), [PATH, oneStroke(12500, 5000), PAGE_ID] as const) as number;
		expect(n, "premise: the stroke is in the store").toBe(COUNT + 1);
		await page.evaluate(() => (window as any).panBake.holdPieces(false));
		await page.evaluate(() => (window as any).panBake.awaitWhole());
		await sleep(300);
		const r = await page.evaluate((p) => (window as any).worldRect.read(p), PATH) as any;
		expect(r.build?.outside ?? 0, `the build still counts the outside stroke (${JSON.stringify(r)})`).toBe(0);
		expect(r.raster?.outside ?? 0, `a finished raster counts a stroke its world does not hold (${JSON.stringify(r)})`).toBe(0);
	});
}, 180_000);
