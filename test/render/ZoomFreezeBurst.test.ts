/**
 * Step 4: does the cost stack when moves arrive WITHIN one frame?
 *
 * The step sweep (ZoomFreezeRepro.test.ts) found per-event cost frame-bound and
 * flat: 8, 100 and 400 `updatePinch` calls gave the same 57-77 ms longest task,
 * because that driver awaits a frame after every single move. A touchscreen does
 * not: it delivers several moves per frame, coalesced, and the handler runs them
 * all before the browser gets a chance to paint.
 *
 * So the variable here is the BURST - how many moves land inside one frame - at
 * a fixed frame count. If per-event work is what grows at low zoom, the longest
 * single task grows with the burst and the rig can finally show what Alan's
 * device shows. If it stays flat at 40 moves per frame, the router path is not
 * where the freeze lives and the remaining rig gap is the DOM listener path.
 *
 * Instruments are the ones the ruling has used throughout: a longtask tape armed before
 * the gesture, and `page.evaluate(() => 1)` raced against 3 s, which needs only
 * a free main thread and so reads a wedge regardless of machine speed.
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
	if (process.env.HW_S93_BURST_REPORT) writeFileSync(process.env.HW_S93_BURST_REPORT, JSON.stringify(report, null, 1));
});

const PANE = { w: 945, h: 834 } as const;
const ALIVE_MS = 3_000;
const GESTURE_MS = 30_000;
/** Frames held constant so the burst is the only thing that changes. */
const FRAMES = 8;
/** Moves delivered inside ONE frame, no await between them. */
const BURSTS = [1, 5, 10, 40] as const;

for (const burst of BURSTS) it(`IC on, ${burst} coalesced move(s) per frame across ${FRAMES} frames, out then in`, async () => {
	const page = await browser.newPage({ viewport: { width: PANE.w, height: PANE.h }, deviceScaleFactor: 2 });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(e.message));
	const warnings: string[] = [];
	page.on("console", m => { if (m.type() === "warning" || m.type() === "error") warnings.push(m.text()); });

	const tape = async () => await page.evaluate(() => (window as any).__s93tasks as number[]).catch(() => [] as number[]);
	const alive = async () => await Promise.race([
		page.evaluate(() => 1).then(() => "alive" as const).catch(() => "closed" as const),
		new Promise<"wedged">(resolve => setTimeout(() => resolve("wedged"), ALIVE_MS)),
	]);

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
		// The pinch zoom exists only under the Infinite Canvas now, so a cost cell that
		// pinched with the canvas off would measure a gesture the product ignores. The mode is on
		// here and the cost question is unchanged: does per-event work stack inside one frame.
		await page.evaluate(() => (window as any).scrollColumnAnchor.setScrollExpansionEnabled(true));

		expect(await alive(), "premise: the page answers before any pinch").toBe("alive");

		const gesture = (from: number, to: number) => page.evaluate(([f, t, frames, b, cx, cy]) =>
			(window as any).scrollColumnAnchor.runTearPinchBurst(f, t, frames, b, cx, cy),
			[from, to, FRAMES, burst, PANE.w / 2, PANE.h / 2] as const);

		const run = async (label: string, from: number, to: number) => {
			const began = Date.now();
			const outcome = await Promise.race([
				gesture(from, to).then(() => "returned" as const).catch((e: Error) => `threw: ${e.message}` as const),
				new Promise<"did not return">(resolve => setTimeout(() => resolve("did not return"), GESTURE_MS)),
			]);
			return { label, ms: Date.now() - began, outcome };
		};

		const out = await run("out 1 -> 0.3", 1, 0.3);
		const aliveAfterOut = await alive();
		const back = await run("in 0.3 -> 1", 0.3, 1);
		const aliveAfterIn = await alive();

		const tasks = await tape();
		const longest = tasks.length ? Math.round(Math.max(...tasks)) : 0;
		const didNotConverge = warnings.filter(w => w.includes("Pinch geometry did not converge")).length;
		report.push({ burst, frames: FRAMES, moves: FRAMES * burst, out, back, aliveAfterOut, aliveAfterIn, longest, tasks: tasks.length, didNotConverge, errors, warnings: warnings.slice(0, 5) });

		expect(errors, "no page errors during the gesture").toEqual([]);
		expect(aliveAfterOut, `after the zoom-out the page answers within ${ALIVE_MS} ms`).toBe("alive");
		expect(aliveAfterIn, `after the zoom-in the page answers within ${ALIVE_MS} ms`).toBe("alive");
		expect(longest, `longest single task with ${burst} move(s) per frame, ms (${tasks.length} longtasks)`).toBeLessThan(1_000);
	} finally {
		await page.close();
	}
}, 180_000);
