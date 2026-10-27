/**
 * A ZOOM SETTLE REPAINTS THE WHOLE LAYER ONCE, AND NEVER ON THE BOUNCE.
 *
 * Measured at a3a99674 on a 28,358-stroke note with ZoomSettleBaseline.test.ts: a pinch from 25 to 10 percent ends in three whole
 * repaints drawn by path, one in the lift's task and two while the bounce plays (about 440 ms each on 28,358 strokes); a zoom bar
 * commit runs two in its own call and a third a frame later. Alan's device trace on the same note shows the same shape.
 *
 * The law: one zoom commit, at most one whole repaint drawn by path from the lift until the settle is quiet, and none while the
 * bounce plays outside the lift's own task (the commit starts the bounce and paints after it, in that task; a paint the bounce's
 * frames ask for is a second one). A whole paint that copies a picture (no path point drawn) is not counted; a paint by path is.
 *
 * Rig: the PanBakeRepaint page on the ZoomSettleStandIn note (4000 seeded strokes over about 11,000 x 13,000 css px), mounted at
 * 25 percent, Infinite Canvas on. Regime: Chromium launched with --force-device-scale-factor=2 (the forced flag, not a page
 * deviceScaleFactor). Cells:
 *   - pinch: twelve move frames about the pane centre, then the lift; the bounce that follows is a premise.
 *   - bar: one commit to 10 percent as the zoom bar makes it.
 *   - owed (pinch, bar): with the stand-in on, every whole paint in the commit's own task: one, a copy.
 *   - pace (pinch): pieces of the extent build between two consecutive bounce frames, a count with no clock bound.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/ZoomSettleOneRepaint.test.ts
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
const PANE = { w: 1184, h: 824 };
const DSF = 2;
const PAGE_ID = "75d1627a-c4d7-4a11-947d-bc26b7f83c20";
const FROM = 0.25, TO = 0.10, STEPS = 12;

function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** The ZoomSettleStandIn note: the same seeded generator, so the same ink. */
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
	const b = await build({ entryPoints: [fileURLToPath(new URL("./zoomSettleBaselinePage.ts", import.meta.url))], bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1700,1000"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const call = <T>(page: Page, obj: "panBake" | "zsb", name: string, ...a: unknown[]) =>
	page.evaluate(([o, n, args]) => (window as any)[o as string][n as string](...(args as unknown[])), [obj, name, a] as const) as Promise<T>;

for (const arm of ["pinch", "bar"] as const) it(`${arm}: a zoom settle from ${FROM * 100} to ${TO * 100} percent repaints the whole layer by path at most once, and never on the bounce`, async () => {
	const context = await browser.newContext({ viewport: null, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await call<any>(page, "panBake", "mount", FROM, FIXTURE, PAGE_ID, PANE.w, PANE.h, 4000);
		expect(errors).toEqual([]);
		expect(mounted.strokes, "premise: every stroke loaded").toBe(4000);
		expect(mounted.zoomCommitted, "premise: the start zoom committed").toBe(true);
		await sleep(600);
		expect((await call<{ pending: boolean }>(page, "panBake", "awaitWhole")).pending, "premise: the mount's build finished").toBe(false);
		await call(page, "panBake", "record");
		await call(page, "zsb", "watch");
		const g = arm === "pinch" ? await call<any>(page, "zsb", "pinch", TO / FROM, STEPS) : await call<any>(page, "zsb", "commit", TO);
		const s = await call<any>(page, "zsb", "settled", g.t0);
		const rows = await call<any[]>(page, "panBake", "rows");
		await call(page, "zsb", "unwatch");
		await call(page, "panBake", "stop");
		const t0 = g.t0 - 1, liftEnd = g.t0 + g.liftMs;
		const byPath = rows.filter(r => r.t >= t0 && r.painted && r.work === "all" && r.pts > 0);
		const seen = { byPath: byPath.length, onBounce: byPath.filter(r => r.bounce && r.t > liftEnd).length, inLift: byPath.filter(r => r.t <= liftEnd).length, pts: byPath.map(r => r.pts), sawBounce: s.sawBounce, longest: Math.round(s.longest) };
		console.log(`ZS1 ${arm} ${JSON.stringify(seen)}`);
		expect(g.scale, "premise: the zoom settled at the target").toBeCloseTo(TO, 3);
		if (arm === "pinch") expect(s.sawBounce, "premise: a bounce played after the lift").toBe(true);
		expect(seen.onBounce, `whole repaints by path while the bounce plays, outside the lift's task (${JSON.stringify(seen)})`).toBe(0);
		expect(seen.byPath, `whole repaints by path from the lift until quiet (${JSON.stringify(seen)})`).toBeLessThanOrEqual(1);
		expect(seen.inLift, `every whole repaint by path inside the lift's own task (${JSON.stringify(seen)})`).toBe(seen.byPath);
		expect(errors, "no page errors").toEqual([]);
	} finally { await context.close(); }
}, 300_000);

/** Mount the note at FROM, run one settle (a pinch or a zoom bar commit) to TO, and wait until it is quiet. */
async function settleOnce(arm: "pinch" | "bar") {
	const context = await browser.newContext({ viewport: null, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await call<any>(page, "panBake", "mount", FROM, FIXTURE, PAGE_ID, PANE.w, PANE.h, 4000);
		expect(mounted.strokes, "premise: every stroke loaded").toBe(4000);
		expect(mounted.zoomCommitted, "premise: the start zoom committed").toBe(true);
		await sleep(600);
		expect((await call<{ pending: boolean }>(page, "panBake", "awaitWhole")).pending, "premise: the mount's build finished").toBe(false);
		await call(page, "panBake", "record");
		await call(page, "zsb", "watch");
		const g = arm === "pinch" ? await call<any>(page, "zsb", "pinch", TO / FROM, STEPS) : await call<any>(page, "zsb", "commit", TO);
		const s = await call<any>(page, "zsb", "settled", g.t0);
		await call(page, "zsb", "unwatch");
		await call(page, "panBake", "stop");
		expect(g.scale, "premise: the zoom settled at the target").toBeCloseTo(TO, 3);
		expect(errors, "no page errors").toEqual([]);
		return { g, s };
	} finally { await context.close(); }
}

// Commit 1's owed paint, with the stand-in on. Inside a zoom commit each reallocation owes the whole layer one paint instead of
// painting it, and the commit pays the debt once, after its last reallocation, still in its own task, so no frame shows a blank or
// half-sized layer. With the stand-in on, that paint is a copy, not a path draw, so the by-path count above does not see it: this
// cell counts every whole paint in the commit's task and pins the outcome: one, a copy, no path drawn. A commit that skips the pay
// paints none there. A commit that paints on each reallocation instead of owing the paint is not covered: with the stand-in on,
// those paints add no whole paint this recorder sees.
for (const arm of ["pinch", "bar"] as const) it(`${arm}: with the stand-in on, the zoom commit pays its owed paint once, in its own task, as a copy`, async () => {
	const { s } = await settleOnce(arm);
	const inTask = (s.paints as any[]).filter(p => p.inTask);
	const seen = inTask.map(p => ({ stand: p.stand, copies: p.copies, pts: p.pts, heldAfter: p.heldAfter }));
	console.log(`ZS1 owed ${arm} ${JSON.stringify(seen)}`);
	expect(inTask.length, `whole paints in the commit's own task (${JSON.stringify(seen)})`).toBe(1);
	expect({ standIn: inTask[0].heldAfter, pts: inTask[0].pts }, `the commit's paint shows the stand-in and draws no path (${JSON.stringify(seen)})`).toEqual({ standIn: true, pts: 0 });
}, 300_000);

// The build's pace under the bounce, as a count, with no clock bound: between two consecutive frames that both had the bounce
// playing, at most one piece of the extent build runs. A chain that posts pieces back to back runs several between two frames.
it("pinch: at most one piece of the build runs between two consecutive bounce frames", async () => {
	const { s } = await settleOnce("pinch");
	const per = s.perBounceFrame as number[];
	console.log(`ZS1 pace ${JSON.stringify({ per, pieces: (s.pieceRuns as any[]).length, onBounce: (s.pieceRuns as any[]).filter(r => r.bounce).length })}`);
	expect(s.sawBounce, "premise: a bounce played after the lift").toBe(true);
	expect(per.length, "premise: bounce frames read").toBeGreaterThan(0);
	expect(per.reduce((a, n) => a + n, 0), `premise: pieces ran while the bounce played (${JSON.stringify(per)})`).toBeGreaterThan(0);
	expect(Math.max(...per), `at most one piece between two bounce frames (${JSON.stringify(per)})`).toBeLessThanOrEqual(1);
}, 300_000);
