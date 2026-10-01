/**
 * Step 7: the pinch on a note that actually HAS ink.
 *
 * WHY THIS ARM EXISTS. Steps 2 to 5 all read flat - the step sweep (8/100/400
 * `updatePinch` calls), the coalesced-burst sweep (1/5/10/40 moves per frame),
 * and real CDP touch through the page's own listeners. The reason they were
 * flat is in their own receipts: every one of them mounts a note whose
 * `runTearRead()` reports `strokes: 0`. There was no committed ink, so the
 * repaint that Alan's device spends seconds in had nothing to paint.
 *
 * WHAT THE DEVICE SAID. The Orion trace carries one 3536.8 ms task on the
 * renderer's main thread at pinch-end. Restricted to the renderer's own sample
 * thread, 3536.4 ms of its 3536.8 ms is attributed, and the largest self time
 * is canvas `closePath` at 3332.0 ms (94.2%). The stack is
 * `pointerUpOrCancel` -> `endPinch` -> `flushPinch` -> `commitCameraScale` ->
 * `handleResize` -> `repaint` -> `paintCommittedWork` -> `fillRibbon`, ending
 * at RibbonRenderer.ts:156-159. No `drawImage`, `getImageData`, `clearRect` or
 * tile allocation appears in that window's self time at all.
 *
 * WHAT THIS CELL MEASURES, AND WHY IT IS SEEDED BY EXTENT. `drawCommitted`
 * culls per stroke by BBOX ONLY (StrokeRenderer.ts:376-384) and never clips
 * inside a stroke, while `fillRibbon` emits `moveTo` + 3x `lineTo` +
 * `closePath` per SEGMENT - one segment per sample - plus an `arc` per joint
 * (RibbonRenderer.ts:113-160). So a long stroke whose bbox the camera touches
 * pays its entire sample count even when a fingertip's worth of it is on
 * screen, and a zoom-out that widens the camera pulls more such bboxes in. A
 * few long, sample-dense strokes is therefore the seeding shape that reaches
 * the device's numbers; the same total sample count spread over many short
 * strokes would be culled away instead.
 *
 * PRE-REGISTERED, before the first run:
 *  - the count of `closePath` calls inside one `commitCameraScale` tracks the
 *    samples of the strokes the cull keeps, not the pixels on screen;
 *  - `drawImage` / `getImageData` / `putImageData` stay at or near zero across
 *    the gesture, which is the rig's independent check on the trace's claim
 *    that no per-tile allocate-and-blit is involved;
 *  - `beginPath` per commit equals the strokes the cull keeps, since
 *    `fillRibbon` opens exactly one path per stroke painted. A divergence means
 *    something other than the ribbon is drawing and the reading is not clean.
 *
 * WHAT THIS CELL IS NOW. It was the reproduction; it is the guard. At
 * 683f0490, before the per-quad `closePath` came out of RibbonRenderer, the
 * heavy arm's longest task was 1467-1482 ms. With the close removed it is
 * 189 ms, its worst commit 82.7 ms against 612.1, and the settle behind that
 * commit 243.6 ms against 1755.
 *
 * TWO ASSERTIONS, AND THE DETERMINISTIC ONE CARRIES THE CLAIM. The defect has a
 * signature that does not depend on how busy the machine is: a `closePath` per
 * quad inside the pinch commit. That count is asserted at zero, and it reads the
 * same on an idle box and under a full gate.
 *
 * The wall clock beside it is a coarse guard, and its bound is 600 ms rather
 * than the 200 the ruling asked for. The fix measures 189 ms alone and 318 ms
 * inside the full gate, where the suite's other 900 render cells are competing
 * for the same box - so a 200 or 300 ms bound would red on a green tree, which
 * is an instrument defect and not a finding. 600 ms is nearly a third of the
 * 1467 ms the defect cost and still reds on its return.
 *
 * WHAT THE FIRST CLEAN RUNS SAID, so the next reader does not re-derive it:
 * control 58-64 ms, light 150-153 ms, heavy 1468-1482 ms. The heavy arm's
 * gesture is not one expensive moment but four full repaints of everything the
 * cull keeps - the commit inside `endPinch` traces 118 007 closePath in 621 ms,
 * and the settle that follows traces 328 014 more in 1761 ms across three more
 * repaints. The move frames paint NOTHING at all (`deferPinchRaster` holds),
 * which is why the phase rows are reported separately: a receipt that showed
 * only the commit would attribute a quarter of the cost and miss the rest.
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
	if (process.env.HW_S93_HEAVY_REPORT) writeFileSync(process.env.HW_S93_HEAVY_REPORT, JSON.stringify(report, null, 1));
});

const PANE = { w: 945, h: 834 } as const;
const ALIVE_MS = 3_000;
const GESTURE_MS = 120_000;
/** Moves per gesture, held constant: the seeding is the variable here. */
const STEPS = 24;

/**
 * The sweep. `span` is how far right and down each stroke runs in note px, and
 * `samples` is how many points it carries - together they are "long and
 * sample-dense". The control seeds nothing, which is exactly what steps 2 to 5
 * measured, so it is the arm that says whether the rig itself changed.
 */
const ARMS = [
	{ name: "control, no seeded ink", strokes: 0, samples: 0, span: 0 },
	{ name: "light: 20 strokes x 500 samples over 30k px", strokes: 20, samples: 500, span: 30_000 },
	{ name: "heavy: 200 strokes x 2000 samples over 30k px", strokes: 200, samples: 2_000, span: 30_000 },
] as const;

for (const arm of ARMS) it(`pinch out then in, ${arm.name}: the page keeps answering`, async () => {
	const page = await browser.newPage({ viewport: { width: PANE.w, height: PANE.h }, deviceScaleFactor: 2 });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(e.message));
	const warnings: string[] = [];
	page.on("console", m => { if (m.type() === "warning" || m.type() === "error") warnings.push(m.text()); });

	const alive = async () => await Promise.race([
		page.evaluate(() => 1).then(() => "alive" as const).catch(() => "closed" as const),
		new Promise<"wedged">(resolve => setTimeout(() => resolve("wedged"), ALIVE_MS)),
	]);
	const tape = async () => await page.evaluate(() => (window as any).__s93tasks as number[]).catch(() => [] as number[]);

	try {
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addScriptTag({ content: bundle });
		await page.evaluate(() => {
			(window as any).__s93tasks = [];
			try {
				new PerformanceObserver(list => {
					for (const entry of list.getEntries()) (window as any).__s93tasks.push(entry.duration);
				}).observe({ entryTypes: ["longtask"] });
			} catch { /* the liveness probe still decides */ }
		});
		await page.evaluate(([pane]) => (window as any).scrollColumnAnchor.runTearMount(1, 0, pane, true, { fx: 0.5, fy: 0.5 }),
			[{ w: PANE.w, h: PANE.h }] as const);
		// The canvas-off mode no longer zooms, so this cost cell runs under the Infinite
		// Canvas. The variable is unchanged.
		await page.evaluate(() => (window as any).scrollColumnAnchor.setScrollExpansionEnabled(true));

		const seed = arm.strokes === 0 ? null : await page.evaluate(([n, s, span]) =>
			(window as any).scrollColumnAnchor.runTearSeedExtentInk(n, s, span),
			[arm.strokes, arm.samples, arm.span] as const);

		// PREMISE, and it is the one every earlier arm failed silently: the note
		// holds the ink we think it holds before the gesture starts. A seeded arm
		// that reports zero strokes would read as "the pinch is cheap" when it
		// really means "there was nothing to paint" - the exact mistake steps 2
		// to 5 made without noticing.
		const mounted = await page.evaluate(() => (window as any).scrollColumnAnchor.runTearRead());
		expect(await alive(), "premise: the page answers before any pinch").toBe("alive");
		expect(mounted.strokes, `premise: the note carries the seeded strokes (+1 template)`)
			.toBe(arm.strokes === 0 ? 0 : arm.strokes + 1);

		// THE TAPE IS RESET HERE, AFTER SEEDING, AND THIS IS LOAD-BEARING.
		// `runTearSeedExtentInk` builds 400 000 point objects and grows the extent
		// synchronously, which is one long task of the RIG's own making - the
		// first run of this cell read 1462 ms while the heaviest commit in it was
		// 619.8 ms, so the tape's maximum was partly the seed loop and not the
		// product. Everything the assertion below reads is now work the GESTURE
		// did.
		await page.evaluate(() => { (window as any).__s93tasks = []; });

		const run = async (label: string, from: number, to: number) => {
			const began = Date.now();
			const outcome = await Promise.race([
				page.evaluate(([f, t, steps, cx, cy]) => (window as any).scrollColumnAnchor.runTearPinchCounted(f, t, steps, cx, cy),
					[from, to, STEPS, PANE.w / 2, PANE.h / 2] as const)
					.then(r => ({ kind: "returned" as const, ...(r as Record<string, unknown>) }))
					.catch((e: Error) => ({ kind: `threw: ${e.message}` as const })),
				new Promise<{ kind: "did not return" }>(resolve => setTimeout(() => resolve({ kind: "did not return" }), GESTURE_MS)),
			]);
			return { label, wallMs: Date.now() - began, ...outcome };
		};

		// OUT first, then back IN. Alan's order, and the half he freezes on is the
		// zoom-in - which is also the one that pulls the far strokes' bboxes back
		// across the camera at the commit.
		const out = await run("pinch out 1 -> 0.3", 1, 0.3);
		const aliveAfterOut = await alive();
		const back = await run("pinch in 0.3 -> 1", 0.3, 1);
		const aliveAfterIn = await alive();

		const tasks = await tape();
		const longest = tasks.length ? Math.round(Math.max(...tasks)) : 0;
		/** The single most expensive commit of either gesture, which is the device's shape. */
		const commitRows = [...((out as any).commits ?? []), ...((back as any).commits ?? [])] as { ms: number; intersecting: number; delta: Record<string, number> }[];
		// The move phase, summarised. The commit is not the only place that paints
		// (see the per-frame rows), so a receipt that showed only commits would
		// hide most of the gesture's work.
		const moveRows = [...((out as any).moves ?? []), ...((back as any).moves ?? [])] as { i: number; ms: number; delta: Record<string, number> }[];
		const worstMove = moveRows.reduce<typeof moveRows[number] | null>((w, r) => (w === null || r.ms > w.ms ? r : w), null);
		const moveTotals = moveRows.reduce((acc, r) => { for (const k of Object.keys(r.delta)) acc[k] = (acc[k] ?? 0) + r.delta[k]!; return acc; }, {} as Record<string, number>);
		const worstCommit = commitRows.reduce<typeof commitRows[number] | null>((w, r) => (w === null || r.ms > w.ms ? r : w), null);
		const didNotConverge = warnings.filter(w => w.includes("Pinch geometry did not converge")).length;
		report.push({ arm: arm.name, seed, steps: STEPS, out, back, aliveAfterOut, aliveAfterIn, longest, tasks: tasks.length, worstCommit, commits: commitRows.length, phases: { out: { endPinchMs: (out as any).endPinchMs, endPinchDelta: (out as any).endPinchDelta, settleMs: (out as any).settleMs, settleDelta: (out as any).settleDelta }, back: { endPinchMs: (back as any).endPinchMs, endPinchDelta: (back as any).endPinchDelta, settleMs: (back as any).settleMs, settleDelta: (back as any).settleDelta } }, worstMove, moveTotals, moveMsTotal: Math.round(moveRows.reduce((a, r) => a + r.ms, 0)), didNotConverge, errors, warnings: warnings.slice(0, 5) });

		expect(errors, "no page errors during the gesture").toEqual([]);
		expect(aliveAfterOut, `after the zoom-out the page answers within ${ALIVE_MS} ms`).toBe("alive");
		expect(aliveAfterIn, `after the zoom-in the page answers within ${ALIVE_MS} ms (this is the wedge Alan hits)`).toBe("alive");
		// THE SIGNATURE, load-invariant: not one close per quad anywhere in the
		// gesture. `fillRibbon` is the only closePath in the committed paint path,
		// so a nonzero count here is the defect returning, whatever the clock says.
		const closesInGesture = ((out as any).totals?.closePath ?? 0) + ((back as any).totals?.closePath ?? 0);
		expect(worstCommit?.delta.closePath ?? 0, "no closePath inside the pinch commit").toBe(0);
		expect(closesInGesture, "no closePath anywhere in the gesture, commit or settle").toBe(0);

		expect(longest, `longest single task, ms, with ${arm.strokes} seeded strokes (worst commit: ${worstCommit ? `${worstCommit.ms} ms, ${worstCommit.delta.closePath} closePath, ${worstCommit.intersecting} strokes in camera` : "none recorded"})`)
			.toBeLessThan(600);
	} finally {
		await page.close();
	}
}, 600_000);
