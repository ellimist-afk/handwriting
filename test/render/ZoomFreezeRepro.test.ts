/**
 * Pinch zoom-OUT then zoom-IN on a plain Markdown note wedges the app.
 *
 * Alan, measured on his devices, not inferred here:
 *  - gesture: touchscreen pinch, zoom OUT first, then a zoom-IN attempt. The
 *    freeze lands on the zoom-in, not on first contact.
 *  - severity varies: the first freeze tonight needed Task Manager; a later one
 *    recovered after a wait.
 *  - reproduces with Infinite Canvas ON **and OFF**, so it is not the extent
 *    machinery.
 *  - reproduces on Orion at 1.4.20-e529a2e7-dev, which is pre-reconcile, so it
 *    is not e534f2df's own commits.
 *
 * WHAT A RECOVERING FREEZE MEANS FOR THE INSTRUMENT. A cycle that never yields
 * can only be force-quit; one that recovers is a bounded job that is merely
 * enormous - work scaling with what a low zoom exposes (extent, pages, strokes
 * in view, paper plan) fits the evidence as well as a loop does. So this cell
 * does not ask "did it hang forever". It asks two questions with two
 * instruments:
 *   1. does the renderer's main thread still answer `page.evaluate(() => 1)`
 *      within 3 s - a round trip that needs nothing but a free thread, so a
 *      timeout is the wedge regardless of how slow the machine is;
 *   2. how long the longest single task was, from a PerformanceObserver armed
 *      before the gesture. A 4 s longtask and a 40 s one are the same "frozen"
 *      to a user and very different to a fix.
 *
 * Both numbers are reported on every arm, pass or fail, because "it recovered"
 * is a measurement, not an absence of one.
 *
 * The rig is already in the tree at this SHA: `runTearMount` mounts a plain
 * Markdown note with readable line length on, and `runTearPinch` drives the
 * REAL router - beginPinch / updatePinch / endPinch with two touch contacts,
 * pointerType "touch" - which is Alan's input. IC is toggled after mount.
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
	if (process.env.HW_S93_REPORT) writeFileSync(process.env.HW_S93_REPORT, JSON.stringify(report, null, 1));
});

const PANE = { w: 945, h: 834 } as const;
/** A free main thread answers this in single-digit ms; 3 s is the wedge. */
const ALIVE_MS = 3_000;
/** The gesture itself is allowed this long before the call counts as not returning. */
const GESTURE_MS = 20_000;

type Probe = { phase: string; alive: "alive" | "wedged" | "closed"; longestTaskMs: number; tasks: number };

/** IC OFF first: Alan reproduces in both, and off is the simpler failing config. */
// The pinch zoom exists only under the Infinite Canvas. The IC-off arms of this sweep
// measured a gesture the product now ignores, so they are retired; the refusal itself is
// pinned once for this rig in ZoomFreezeTouch.test.ts, through the real touch listeners.
const ICS = [
	{ name: "IC on", infiniteCanvas: true },
] as const;

/**
 * THE STEP COUNT IS THE VARIABLE, and it is the rig's largest known gap from the
 * device. `runTearPinch` delivers this many `updatePinch` calls per
 * gesture; a touchscreen delivers hundreds, coalesced. If the cost per event is
 * what grows at low zoom, wall time and the longest task grow with this number
 * and the rig can show on 400 what the device shows on a real stream. If they
 * stay flat, the rig cannot reach it and the measurement belongs on the device.
 */
const STEPS = [8, 100, 400] as const;

const ARMS = ICS.flatMap(ic => STEPS.map(steps => ({ ...ic, steps, name: `${ic.name}, ${steps} steps` })));

for (const arm of ARMS) it(`plain Markdown note, touch pinch out then in, ${arm.name}: the page keeps answering`, async () => {
	const page = await browser.newPage({ viewport: { width: PANE.w, height: PANE.h }, deviceScaleFactor: 2 });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(e.message));
	// "Pinch geometry did not converge" is the settle measure giving up at its
	// 4-attempt cap (InkOverlay.ts:8287). Counting it separates two shapes: the
	// retry loop running and exiting, versus the path never being reached at all.
	const warnings: string[] = [];
	page.on("console", m => { if (m.type() === "warning" || m.type() === "error") warnings.push(m.text()); });
	const probes: Probe[] = [];
	const timings: { label: string; ms: number; outcome: string }[] = [];

	/** Ask the page the cheapest possible question, and read the longtask tape. */
	const probe = async (phase: string): Promise<Probe> => {
		const alive = await Promise.race([
			page.evaluate(() => 1).then(() => "alive" as const).catch(() => "closed" as const),
			new Promise<"wedged">(resolve => setTimeout(() => resolve("wedged"), ALIVE_MS)),
		]);
		// A wedged thread cannot report its own tape; read what we have.
		const tape = alive === "alive"
			? await page.evaluate(() => (window as any).__s93tasks as number[]).catch(() => [] as number[])
			: [];
		const p: Probe = { phase, alive, longestTaskMs: tape.length ? Math.round(Math.max(...tape)) : 0, tasks: tape.length };
		probes.push(p);
		return p;
	};

	try {
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addScriptTag({ content: bundle });

		// The tape is armed BEFORE the gesture, so a long task during the pinch
		// is recorded even if the thread is busy when we come back to read it.
		await page.evaluate(() => {
			(window as any).__s93tasks = [];
			try {
				new PerformanceObserver(list => {
					for (const entry of list.getEntries()) (window as any).__s93tasks.push(entry.duration);
				}).observe({ entryTypes: ["longtask"] });
			} catch { /* longtask unsupported: the liveness probe still decides */ }
		});

		await page.evaluate(([pane]) => (window as any).scrollColumnAnchor.runTearMount(1, 0, pane, true, { fx: 0.5, fy: 0.5 }),
			[{ w: PANE.w, h: PANE.h }] as const);
		await page.evaluate(ic => (window as any).scrollColumnAnchor.setScrollExpansionEnabled(ic), arm.infiniteCanvas);

		// PREMISE: the page answers before the gesture. Without this a rig that
		// was already wedged at mount would read as a pinch that hung.
		const mounted = await probe("after mount");
		expect(mounted.alive, "premise: the page answers before any pinch").toBe("alive");

		const pinch = (from: number, to: number) => page.evaluate(([f, t, n, cx, cy]) =>
			(window as any).scrollColumnAnchor.runTearPinch(f, t, n, cx, cy),
			[from, to, arm.steps, PANE.w / 2, PANE.h / 2] as const);
		/** Wall time the gesture itself took, which a longtask tape alone does not give. */
		const timed = async (label: string, run: Promise<unknown>) => {
			const began = Date.now();
			const outcome = await Promise.race([
				run.then(() => "returned" as const).catch((e: Error) => `threw: ${e.message}` as const),
				new Promise<"did not return">(resolve => setTimeout(() => resolve("did not return"), GESTURE_MS)),
			]);
			const ms = Date.now() - began;
			timings.push({ label, ms, outcome });
			return outcome;
		};

		// ZOOM OUT, the half Alan says survives.
		const outReturned = await timed("pinch out 1 -> 0.3", pinch(1, 0.3));
		const afterOut = await probe("after pinch out to 0.3");

		// ZOOM IN, the half that freezes on his device.
		const inReturned = await timed("pinch in 0.3 -> 1", pinch(0.3, 1));
		const afterIn = await probe("after pinch in to 1");

		const didNotConverge = warnings.filter(w => w.includes("Pinch geometry did not converge")).length;
		report.push({ arm: arm.name, steps: arm.steps, infiniteCanvas: arm.infiniteCanvas, outReturned, inReturned, timings, probes, errors, didNotConverge, warnings: warnings.slice(0, 5) });

		expect(errors, "no page errors during the gesture").toEqual([]);
		expect(afterOut.alive, `after the zoom-out the page answers within ${ALIVE_MS} ms`).toBe("alive");
		expect(inReturned, `the zoom-in pinch returned within ${GESTURE_MS} ms`).toBe("returned");
		expect(afterIn.alive, `after the zoom-in the page answers within ${ALIVE_MS} ms (this is the wedge Alan hits)`).toBe("alive");
		// A recovering freeze is still the defect. Any single task over a second
		// is a frozen app to the person holding the tablet.
		expect(afterIn.longestTaskMs, `longest single task across the gesture, ms (tasks seen: ${afterIn.tasks})`).toBeLessThan(1_000);
	} finally {
		await page.close();
	}
}, 180_000);
