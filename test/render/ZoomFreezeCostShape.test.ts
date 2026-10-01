/**
 * Step 8: WHAT the pinch-end repaint's cost is made of, at a fixed point
 * count.
 *
 * ZoomFreezeHeavyNote.test.ts is the red: 200 strokes x 2000 samples spanning
 * 30 000 px reds the "no task over a second" bound at 1468-1482 ms, with
 * 118 007 `closePath` calls inside the 621 ms commit and 328 014 more in the
 * settle behind it. This cell holds the point count fixed and varies only the
 * geometry, so the reading separates causes that the red arm cannot tell apart.
 *
 * THE FOUR ARMS. Every arm seeds the SAME 200 strokes x 2000 samples = 400 000
 * points, so the call count is nearly identical in all of them and any time
 * difference is about the numbers, not the number of calls.
 *
 *   span 400    at the origin        compact strokes, small coordinates
 *   span 30000  at the origin        long strokes, small coordinates  (the red arm)
 *   span 400    at scroll 40000      compact strokes, large coordinates
 *   span 30000  at scroll 40000      long strokes, large coordinates
 *
 * `span` is how far a stroke runs. The far arms MOUNT at their scroll and seed
 * at the camera's own top-left, which puts the same geometry at note-space
 * coordinates in the tens of thousands. Seeding at a fixed note-space offset
 * instead does not work: note space and scroll px are not the same units, the
 * ink landed outside the camera, and both far arms traced nothing at all.
 *
 * PRE-REGISTERED, before the first run:
 *  - SPAN is the variable that matters. A long stroke is traced in full even
 *    where it leaves the canvas (`drawCommitted` culls per stroke by bbox and
 *    never clips inside one), so the long arms pay for quads that land far
 *    outside the raster while the compact arms do not. If the long arms cost
 *    several times the compact ones at an equal call count, the fix has a
 *    within-stroke clip in it and not only a lower call count.
 *  - OFFSET does not matter. `toScreenX/Y` subtracts the camera before the
 *    coordinate reaches canvas, so the native calls see small numbers in every
 *    arm; a difference here would mean the cost tracks coordinate magnitude,
 *    which would be a fact about Skia, not about this plugin.
 *  - The strokes the cull KEEPS are a fraction of the note in the long arms and
 *    most of the note in the compact ones, and `beginPath` per commit reports
 *    that fraction directly. `drawCommitted` culling at all is the claim being
 *    checked here; `strokesStored` beside `intersecting` is what checks it.
 *
 * This cell asserts only that the rig measured what it says it measured - that
 * the ink is there, that the cull kept some of it, and that the gesture ran.
 * The numbers are the product; the bound that reds lives in
 * ZoomFreezeHeavyNote.test.ts, and duplicating it here would only re-fail the
 * same defect twice.
 *
 * WHAT THE FIRST CLEAN RUN SAID. The first pre-registration above is REFUTED,
 * and it was mine: span does not matter. At the origin, compact strokes cost
 * 629.2 ms for 122 007 closes and long ones 607.5 ms for 118 007 - the same,
 * within noise, though the long strokes run 30 000 px off every edge of a
 * 4490 x 4170 css window. The mean cost per close is 5.15 to 5.48 us in all
 * four arms. So the cost tracks the NUMBER of path calls and not the area they
 * cover, and clipping within a stroke would buy nothing; lowering the call
 * count, or making each call cheaper, is the whole lever.
 *
 * The second holds: large coordinates cost 4% more per close (5.48 and 5.36 us
 * against 5.16 and 5.15), which is nothing next to the call count.
 *
 * The third holds, and answers whether `drawCommitted` culls at all: it does.
 * 201 strokes stored, 60 to 71 traced. At the origin `beginPath` equals the
 * modelled cull exactly (62 and 62, 60 and 60); at the far scroll it reads 71
 * against a modelled 47, because this cell samples the camera after the commit
 * returns and the commit painted at a different one. The measured `beginPath`
 * is the honest number there, not the model.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };
let browser: Browser, bundle: string;
const report: unknown[] = [];

beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./scrollColumnAnchorPage.ts", import.meta.url))],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	bundle = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
	await browser?.close();
	if (process.env.HW_S93_SHAPE_REPORT) writeFileSync(process.env.HW_S93_SHAPE_REPORT, JSON.stringify(report, null, 1));
});

const PANE = { w: 945, h: 834 } as const;
const STROKES = 200;
const SAMPLES = 2_000;
const STEPS = 24;

const ARMS = [
	{ name: "span 400, at the origin", span: 400, scroll: 0, anchor: "origin" },
	{ name: "span 30000, at the origin", span: 30_000, scroll: 0, anchor: "origin" },
	{ name: "span 400, at scroll 40000", span: 400, scroll: 40_000, anchor: "camera" },
	{ name: "span 30000, at scroll 40000", span: 30_000, scroll: 40_000, anchor: "camera" },
] as const;

for (const arm of ARMS) it(`cost shape at ${STROKES} x ${SAMPLES} points: ${arm.name}`, async () => {
	const page = await browser.newPage({ viewport: { width: PANE.w, height: PANE.h }, deviceScaleFactor: 2 });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(e.message));

	try {
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addScriptTag({ content: bundle });
		await page.evaluate(() => {
			(window as any).__s93tasks = [];
			try {
				new PerformanceObserver(list => {
					for (const entry of list.getEntries()) (window as any).__s93tasks.push(entry.duration);
				}).observe({ entryTypes: ["longtask"] });
			} catch { /* the commit rows carry the measurement either way */ }
		});
		// The far arms MOUNT at their own scroll, because mounting is what grows
		// the extent and takes the camera there. Seeding first and scrolling
		// afterwards left the camera somewhere the cull rejected every stroke:
		// the first run of this cell traced zero strokes in both offset arms and
		// so measured nothing at all.
		await page.evaluate(([pane, scroll]) => (window as any).scrollColumnAnchor.runTearMount(1, scroll, pane, true, { fx: 0.5, fy: 0.5 }),
			[{ w: PANE.w, h: PANE.h }, arm.scroll] as const);
		// The canvas-off mode no longer zooms, so this cost cell runs under the Infinite
		// Canvas. The variable is unchanged.
		await page.evaluate(() => (window as any).scrollColumnAnchor.setScrollExpansionEnabled(true));

		const seed = await page.evaluate(([n, s, span, anchor]) =>
			(window as any).scrollColumnAnchor.runTearSeedExtentInk(n, s, span, anchor),
			[STROKES, SAMPLES, arm.span, arm.anchor] as const);
		const scrolled = await page.evaluate(() => (window as any).scrollColumnAnchor.runTearRead());
		// The seed loop is one long synchronous task of the rig's own making, and
		// it would otherwise be the tape's maximum. Reset after it.
		await page.evaluate(() => { (window as any).__s93tasks = []; });

		const pinch = (from: number, to: number) => page.evaluate(([f, t, steps, cx, cy]) =>
			(window as any).scrollColumnAnchor.runTearPinchCounted(f, t, steps, cx, cy),
			[from, to, STEPS, PANE.w / 2, PANE.h / 2] as const) as Promise<any>;

		const out = await pinch(1, 0.3);
		const back = await pinch(0.3, 1);

		const commits = [...(out.commits ?? []), ...(back.commits ?? [])] as { ms: number; intersecting: number; delta: Record<string, number>; backing: unknown }[];
		const worst = commits.reduce<typeof commits[number] | null>((w, r) => (w === null || r.ms > w.ms ? r : w), null);
		const tasks = await page.evaluate(() => (window as any).__s93tasks as number[]).catch(() => [] as number[]);
		const longest = tasks.length ? Math.round(Math.max(...tasks)) : 0;
		/**
		 * The number review asked for: the mean cost of one closePath in the
		 * worst commit, as an UPPER bound. It is the whole commit divided by the
		 * closes, so it carries the moveTo, lineTo, fill and clear as well; the
		 * closePath-only figure comes from the no-op probe's difference, not from
		 * this division.
		 */
		const usPerClose = worst && worst.delta.closePath ? Math.round(worst.ms * 1000 / worst.delta.closePath * 100) / 100 : null;

		report.push({
			arm: arm.name, span: arm.span, scroll: arm.scroll, anchor: arm.anchor, strokes: STROKES, samples: SAMPLES,
			seed, scrolled: { scroll: scrolled.scroll, cssScale: scrolled.cssScale },
			strokesStored: out.after?.strokes, longest, endPinchOutMs: out.endPinchMs, endPinchBackMs: back.endPinchMs,
			worstCommitMs: worst?.ms ?? null, worstCommitIntersecting: worst?.intersecting ?? null,
			worstCommitDelta: worst?.delta ?? null, usPerCloseUpperBound: usPerClose,
			backingBefore: out.backingBefore, backingAfterOut: out.backingAfter, backingAfterIn: back.backingAfter,
			commits: commits.map(c => ({ ms: c.ms, intersecting: c.intersecting, closePath: c.delta.closePath, beginPath: c.delta.beginPath, clearRect: c.delta.clearRect, backing: c.backing })),
			totals: back.totals, errors,
		});

		expect(errors, "no page errors during the gesture").toEqual([]);
		expect(out.after?.strokes, "premise: the seeded strokes are in the note").toBe(STROKES + 1);
		// PREMISE, and the whole arm is void without it: ink the camera never
		// touches is never traced, so an arm whose cull keeps nothing measures an
		// empty repaint and its time would read as "this geometry is cheap".
		expect(worst?.intersecting ?? 0, `premise: the camera's cull keeps some of the seeded ink (worst commit kept ${worst?.intersecting ?? 0} of ${STROKES + 1})`).toBeGreaterThan(0);
	} finally {
		await page.close();
	}
}, 600_000);
