/**
 * What it looks like: a zoom commit on a heavy note repaints its whole layer by path, about 440 ms each on a 28,358-stroke note.
 * A paint of the whole layer at the camera and backing the layer already shows draws the same picture again: time spent for no
 * change on screen. A paint after the line correction moved the scroll is not that (the camera changed).
 *
 * GATE CELLS. Count per zoom commit, from the settled picture before it to the settled picture after it (no stand-in held, no
 * build pending): at most one whole paint by path, and no wasted whole paint. A wasted whole paint is a by-path paint of the whole
 * layer whose camera and backing equal the previous whole paint's; it names the call site that paid it (first pass, attempt N,
 * write, complete, finally; unnamed for anything else). Two by-path whole paints at different cameras in one commit are waste too
 * (the first is never shown), which the bound of one catches. Reported beside them, not asserted: whole copies of a zoom stand-in
 * and whole repaints deferred under a held stand-in.
 * Two arms. The app as it ships: a zoom stand-in may be held, and a whole repaint under it is deferred to one copy and draws
 * nothing, so an extra repaint there costs nothing and this arm stays green when a commit asks for one too many. The control arm,
 * with no stand-in taken, draws every whole repaint by path: it is the arm that decides. Every cell's counts go to HW_Z2_OUT, one
 * JSON line per cell, the whole file rewritten on each row, when it is set.
 * Three entries: a pinch lift (the settle hold and its attempts), the zoom bar (a bare commitCameraScale) and ctrl+wheel (four
 * real wheel events in or out, the run ended by its quiet time; the scale it reaches is measured, not set). Two fixtures: the heavy
 * note's sidecar (HW_ISL_SIDECAR, 28,358 strokes, the staged copy of the vault note, not checked in; skipped without it) and
 * Alan's "Untitled 1" ink (checked in). Each from 100 percent: the pinch and the bar to 150 and to 50 percent.
 *
 * PIXEL CELL. After the settle at 150 and 50 percent (zoom bar), the whole layer equals a path draw of every stroke at the camera
 * it was painted at: zero snap.
 *
 * Run: HW_ISL_SIDECAR=<sidecar copy> npx vitest run --config vitest.render.mts test/render/ZoomSettleWaste.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const SIDECAR_PATH = process.env.HW_ISL_SIDECAR ?? "";
const OUT = process.env.HW_Z2_OUT ?? "";
const rows: string[] = [];
/** The whole file is written again on every row, so a cell that fails later leaves the rows before it. */
const record = (row: unknown) => { if (OUT) { rows.push(JSON.stringify(row)); writeFileSync(OUT, rows.join("\n") + "\n"); } };
const HAVE_HEAVY = SIDECAR_PATH !== "" && existsSync(SIDECAR_PATH);
const HEAVY = HAVE_HEAVY ? readFileSync(SIDECAR_PATH, "utf8") : "";
const ALAN = readFileSync(fileURLToPath(new URL("./fixtures/alan-ink-75d1627a.json", import.meta.url)), "utf8");
type Fixture = { name: string; json: string; pageId: string; strokes: number; have: boolean };
const FIXTURES: Fixture[] = [
	{ name: "heavy", json: HEAVY, pageId: "cf77b392-e4c0-47b3-b87a-b9583f5884cb", strokes: HAVE_HEAVY ? (JSON.parse(HEAVY) as { strokes: unknown[] }).strokes.length : 0, have: HAVE_HEAVY },
	{ name: "alan", json: ALAN, pageId: "75d1627a-c4d7-4a11-947d-bc26b7f83c20", strokes: (JSON.parse(ALAN) as { strokes: unknown[] }).strokes.length, have: true },
];
const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const PANE = { w: 1184, h: 824 };
const DSF = 2;

let browser: Browser, script: string;
beforeAll(async () => {
	const b = await build({ entryPoints: [fileURLToPath(new URL("./panBakeRepaintPage.ts", import.meta.url))], bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1700,1000"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Call = <T>(name: string, ...a: unknown[]) => Promise<T>;
type Counts = { whole: number; wasted: number; copies: number; deferrals: number; sites: string[] };

/** Mount the fixture at canvas zoom 1 with Infinite Canvas on, as desktop, then run `body` with the recorder on. */
async function withRig(fx: Fixture, body: (api: { page: Page; call: Call }) => Promise<void>) {
	const context = await browser.newContext({ viewport: null, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	const call: Call = (name, ...a) => page.evaluate(([n, args]) => (window as any).panBake[n as string](...(args as unknown[])), [name, a] as const) as Promise<any>;
	try {
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		expect((await call<{ isMobile: boolean }>("platform", false)).isMobile, "premise: the platform").toBe(false);
		const mounted = await page.evaluate(([s, id, w, h, n]) => (window as any).panBake.mount(1, s, id, w, h, n), [fx.json, fx.pageId, PANE.w, PANE.h, fx.strokes] as const) as any;
		expect(errors).toEqual([]);
		expect(mounted.strokes, "premise: every stroke loaded").toBe(fx.strokes);
		expect(mounted.dpr, "premise: the device ratio is the flag's").toBeCloseTo(DSF, 3);
		expect(mounted.canvasMode, "premise: Infinite Canvas on").toBe(true);
		await sleep(600);
		await page.evaluate(() => (window as any).panBake.record());
		try {
			await body({ page, call });
		} finally {
			await page.evaluate(() => (window as any).panBake.stop());
		}
		expect(errors).toEqual([]);
	} finally { await context.close(); }
}

type Entry = "pinch" | "bar" | "wheel";
/** One zoom commit from 100 percent through `entry` towards `to`, counted from the settled picture before it to the settled one after. */
async function commitCounted(call: Call, entry: Entry, to: number) {
	await call("awaitSharp");
	await call("resetPaintCounts");
	let scale: number;
	if (entry === "pinch") scale = (await call<{ cssScale: number }>("pinchLift", to)).cssScale;
	else if (entry === "bar") {
		const t = await call<{ ok: boolean }>("commitThen", to, "none");
		expect(t.ok, "premise: the zoom committed").toBe(true);
		await call("afterFrame");
		scale = to;
	} else scale = (await call<{ cssScale: number }>("ctrlWheel", 4, to > 1 ? -100 : 100)).cssScale;
	const sharp = await call<{ building: boolean; held: boolean }>("awaitSharp");
	await sleep(300);
	const counts = await call<Counts>("paintCounts");
	const cssScale = (await call<{ cssScale: number }>("scaleGap")).cssScale;
	return { scale, cssScale, sharp, counts };
}

for (const arm of ["shipped", "no stand-in"] as const) for (const fx of FIXTURES) for (const entry of ["pinch", "bar", "wheel"] as const) for (const to of [1.5, 0.5]) {
	const move = entry === "wheel" ? `four notches ${to > 1 ? "in" : "out"}` : `100 to ${to * 100} percent`;
	(fx.have ? it : it.skip)(`waste, ${arm}: ${fx.name}, ${entry}, ${move}: at most one whole paint by path, none repeating the camera and backing of the one before it`, async () => {
		await withRig(fx, async ({ call }) => {
			if (arm === "no stand-in") await call("standInOff");
			const r = await commitCounted(call, entry, to);
			record({ cell: "waste", arm, fixture: fx.name, entry, to, ...r });
			expect(to > 1 ? r.cssScale > 1.05 : r.cssScale < 0.95, `premise: the zoom moved the note (${JSON.stringify(r)})`).toBe(true);
			expect({ building: r.sharp.building, held: r.sharp.held }, "premise: settled, no build pending, no stand-in held").toEqual({ building: false, held: false });
			expect(r.counts.whole + r.counts.copies, `premise: the commit painted the layer (${JSON.stringify(r.counts)})`).toBeGreaterThan(0);
			expect({ wasted: r.counts.wasted, sites: r.counts.sites }, `wasted whole paints, with the call sites that paid them (${JSON.stringify(r)})`)
				.toEqual({ wasted: 0, sites: [] });
			expect(r.counts.whole, `whole paints by path in the commit, at most one (${JSON.stringify(r)})`).toBeLessThanOrEqual(1);
		});
	}, 240_000);
}

for (const fx of FIXTURES) for (const to of [1.5, 0.5]) {
	(fx.have ? it : it.skip)(`pixel: ${fx.name}, zoom bar to ${to * 100} percent: the settled layer is a path draw at the camera it was painted at (zero snap)`, async () => {
		await withRig(fx, async ({ call }) => {
			await commitCounted(call, "bar", to);
			const v = await call<{ differ: number; inked: number }>("layerVsPath");
			record({ cell: "pixel", fixture: fx.name, to, ...v });
			expect(v.inked, "premise: the layer holds ink").toBeGreaterThan(1000);
			expect(v.differ, `pixels that differ from the path draw (${JSON.stringify(v)})`).toBe(0);
		});
	}, 240_000);
}
