/**
 * Step 5: the same gesture through Chromium's REAL input pipeline.
 *
 * Everything the rig has driven so far calls `router.updatePinch(...)` directly.
 * That skips what a real finger goes through: the pointer listeners the plugin
 * registers, `getCoalescedEvents`, `preventDefault`, hit testing, and whatever
 * layout each listener reads before the router ever sees the gesture. Two sweeps
 * came back flat through that shortcut - 8 to 400 sequential moves, and 1 to 40
 * moves coalesced inside one frame - so the router path is not where the cost
 * lives, and the listener path is the remaining gap between this rig and Orion.
 *
 * So this cell dispatches touches with CDP `Input.dispatchTouchEvent`: two touch
 * points, touchStart, a stream of touchMove, touchEnd. Chromium turns those into
 * real pointer events and delivers them to the page's own listeners, which is as
 * close to Alan's finger as a headless browser gets.
 *
 * Instruments unchanged: a longtask tape armed before the gesture, and
 * `page.evaluate(() => 1)` raced against 3 s.
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
	if (process.env.HW_S93_TOUCH_REPORT) writeFileSync(process.env.HW_S93_TOUCH_REPORT, JSON.stringify(report, null, 1));
});

const PANE = { w: 945, h: 834 } as const;
const ALIVE_MS = 3_000;
const GESTURE_MS = 30_000;
/** Moves per gesture. A real pinch is a few hundred events over a second or so. */
const MOVES = 60;

// The pinch zoom exists only under the Infinite Canvas, so the cost sweep runs with the
// canvas on. The canvas-off half of this sweep is retired and replaced by the refusal pin at the
// foot of this file, which is this rig's one canvas-off zoom cell.
for (const infiniteCanvas of [true]) it(`CDP touch pinch through the real listeners, IC ${infiniteCanvas ? "on" : "off"}`, async () => {
	const context = await browser.newContext({ viewport: { width: PANE.w, height: PANE.h }, deviceScaleFactor: 2, hasTouch: true, isMobile: false });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(e.message));
	const warnings: string[] = [];
	page.on("console", m => { if (m.type() === "warning" || m.type() === "error") warnings.push(m.text()); });
	const cdp = await context.newCDPSession(page);

	const alive = async () => await Promise.race([
		page.evaluate(() => 1).then(() => "alive" as const).catch(() => "closed" as const),
		new Promise<"wedged">(resolve => setTimeout(() => resolve("wedged"), ALIVE_MS)),
	]);

	const cx = PANE.w / 2, cy = PANE.h / 2;
	const points = (spread: number) => [
		{ x: cx - spread / 2, y: cy, id: 1, radiusX: 12, radiusY: 12, force: 1 },
		{ x: cx + spread / 2, y: cy, id: 2, radiusX: 12, radiusY: 12, force: 1 },
	];
	/** One pinch: touchStart at `from`, a stream of moves, touchEnd at `to`. */
	const pinch = async (from: number, to: number) => {
		await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(from) });
		for (let i = 1; i <= MOVES; i++) {
			await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(from + (to - from) * i / MOVES) });
		}
		await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	};

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
		await page.evaluate(ic => (window as any).scrollColumnAnchor.setScrollExpansionEnabled(ic), infiniteCanvas);

		expect(await alive(), "premise: the page answers before any touch").toBe("alive");

		const run = async (label: string, from: number, to: number) => {
			const began = Date.now();
			const outcome = await Promise.race([
				pinch(from, to).then(() => "returned" as const).catch((e: Error) => `threw: ${e.message}` as const),
				new Promise<"did not return">(resolve => setTimeout(() => resolve("did not return"), GESTURE_MS)),
			]);
			return { label, ms: Date.now() - began, outcome };
		};

		// SPREAD SHRINKS = ZOOM OUT, then widens = zoom in. Alan's order.
		const out = await run("touch pinch out (spread 600 -> 120)", 600, 120);
		const aliveAfterOut = await alive();
		const back = await run("touch pinch in (spread 120 -> 600)", 120, 600);
		const aliveAfterIn = await alive();

		// Did the plugin's own pinch machinery see the gesture at all? A flat
		// result means nothing if the touches never reached the router.
		const sawPinch = await page.evaluate(() => {
			const overlay = (window as any).scrollColumnAnchor ? (window as any).__s93overlay : null;
			return overlay ? { scale: overlay.scale, pinchScaleNow: overlay.pinchScaleNow } : null;
		}).catch(() => null);
		const zoom = await page.evaluate(() => (window as any).scrollColumnAnchor.runTearRead?.()).catch(() => null);

		const tasks = await page.evaluate(() => (window as any).__s93tasks as number[]).catch(() => [] as number[]);
		const longest = tasks.length ? Math.round(Math.max(...tasks)) : 0;
		report.push({ infiniteCanvas, moves: MOVES, out, back, aliveAfterOut, aliveAfterIn, longest, tasks: tasks.length, sawPinch, zoom, errors, warnings: warnings.slice(0, 5) });

		expect(errors, "no page errors during the gesture").toEqual([]);
		expect(aliveAfterOut, `after the touch zoom-out the page answers within ${ALIVE_MS} ms`).toBe("alive");
		expect(aliveAfterIn, `after the touch zoom-in the page answers within ${ALIVE_MS} ms`).toBe("alive");
		expect(longest, `longest single task across ${MOVES * 2} dispatched touch moves, ms`).toBeLessThan(1_000);
	} finally {
		await context.close();
	}
}, 180_000);

/**
 * THE REFUSAL PIN for this rig: with the Infinite Canvas off a two-finger pinch is not a
 * zoom at all. Alan's decision of 2026-09-20 takes the note zoom out of the canvas-off mode, so
 * the product ignores every phase of the gesture, the zoom bar and its buttons stand down, and
 * the page is left exactly where it was.
 *
 * THE DRIVER IS THE ROUTER PATH (`runTearPinch`), not the CDP touch stream the cost cell above
 * uses. Measured at aa437ff1 while writing this cell: the CDP gesture left `pinchScaleNow` at 1
 * even with the canvas ON, so it cannot tell a refusal from a gesture that never arrived. The cost
 * cell above asks only whether the page keeps answering, which that path does answer.
 *
 * NON-VACUITY: the same gesture, same fixture, same driver, runs first with the canvas ON and has
 * to move the scale. Without that control a rig whose router had stopped delivering the gesture
 * would pass this cell while the product was broken.
 */
it("canvas off: a two-finger pinch does nothing - scale stays 1, the text stays put, the zoom bar reads busy", async () => {
	const page = await browser.newPage({ viewport: { width: PANE.w, height: PANE.h }, deviceScaleFactor: 2 });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(e.message));

	const scaleRead = () => page.evaluate(() => (window as any).scrollColumnAnchor.runTearScaleRead()) as Promise<{ pinchScaleNow: number; cssScale: number; busy: boolean }>;
	// 2: , class C: THE NaN WAS THIS LINE. runTearRead().rects.text is {l, t, r, b, w, h};
	// reading .left and .top off it gave undefined, and Math.abs(undefined - undefined) is the NaN the lone
	// run reported - a rig read, not a claim about the page. With the keys the rig uses, the text does not
	// move: l 781 t 425 before the pinch and l 781 t 425 after it.
	const textRect = async () => (await page.evaluate(() => (window as any).scrollColumnAnchor.runTearRead())).rects.text as { l: number; t: number };
	const pinch = () => page.evaluate(([cx, cy]) => (window as any).scrollColumnAnchor.runTearPinch(1, 0.4, 20, cx, cy), [PANE.w / 2, PANE.h / 2] as const);
	/**
	 * THE OVERLAY'S pinchZoom ANSWER, WHERE IT REACHES THE SCREEN. Nothing pinned it: the router
	 * unit rig supplies its own callback and never imports the overlay, and every render rig calls
	 * router.beginPinch directly, past the pointerdown gate. The route left is InlinePenRouter's
	 * armedTouchAction(), which writes the standing guard onto the scroller the router holds: the guard's
	 * own value when the overlay answers true, "pinch-zoom" when it answers false. Read off the LIVE
	 * element, with no pointer synthesised.
	 */
	const readTouchAction = () => page.evaluate(() => {
		const el = document.querySelector(".cm-scroller") as HTMLElement | null;
		return el ? { inline: el.style.touchAction, computed: getComputedStyle(el).touchAction } : null;
		});
	const mount = async (infiniteCanvas: boolean) => {
		await page.evaluate(([pane]) => (window as any).scrollColumnAnchor.runTearMount(1, 0, pane, true, { fx: 0.5, fy: 0.5 }),
			[{ w: PANE.w, h: PANE.h }] as const);
		await page.evaluate(ic => (window as any).scrollColumnAnchor.setScrollExpansionEnabled(ic), infiniteCanvas);
	};

	try {
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addScriptTag({ content: bundle });

		// CONTROL: canvas on, the identical gesture has to reach the zoom.
		await mount(true);
		const onBefore = await scaleRead();
		await pinch();
		const onAfter = await scaleRead();
		const touchActionOn = await readTouchAction();
		await page.evaluate(() => (window as any).scrollColumnAnchor.runTearTeardown());

		// THE PIN: canvas off, the same gesture on a fresh mount.
		await mount(false);
		const offBefore = await scaleRead();
		const textBefore = await textRect();
		await pinch();
		const offAfter = await scaleRead();
		const textAfter = await textRect();
		// THE OVERLAY'S OWN ANSWER, read off the live scroller the router guards
		// (InlinePenRouter.ts armedTouchAction / :2069 writes it there), with no pointer synthesised.
		const touchActionOff = await readTouchAction();

		report.push({ pin: "canvas-off refusal", control: { before: onBefore.pinchScaleNow, after: onAfter.pinchScaleNow, busy: onAfter.busy }, off: { before: offBefore.pinchScaleNow, after: offAfter.pinchScaleNow, busy: offAfter.busy, cssScale: offAfter.cssScale }, textBefore, textAfter, errors });

		expect(errors, "no page errors during either gesture").toEqual([]);

		// The control first: if this does not move, nothing below means anything.
		expect(onBefore.pinchScaleNow, "control premise: the canvas-on mount starts at 100%").toBeCloseTo(1, 3);
		expect(onBefore.busy, "control premise: the zoom bar is live with the canvas on").toBe(false);
		expect(Math.abs(onAfter.pinchScaleNow - 1), `control: with the canvas ON the same pinch moved the scale (read ${onAfter.pinchScaleNow})`).toBeGreaterThan(0.05);

		// The refusal, four claims.
		expect(offBefore.pinchScaleNow, "premise: the canvas-off note starts at 100%").toBe(1);
		expect(offAfter.pinchScaleNow, "canvas off: the note's scale after the pinch").toBe(1);
		expect(offAfter.cssScale, "canvas off: the painted scale after the pinch").toBeCloseTo(1, 3);
		expect(offAfter.busy, "canvas off: the zoom bar, its buttons, Fit and the zoom commands read busy").toBe(true);
		expect(Math.abs(textAfter.l - textBefore.l), "canvas off: the text's screen left after the pinch").toBeLessThanOrEqual(0.5);
		expect(Math.abs(textAfter.t - textBefore.t), "canvas off: the text's screen top after the pinch").toBeLessThanOrEqual(0.5);
		// The overlay's own answer, one line per mode. Measured: "pinch-zoom" with the canvas off,
		// so the browser keeps the two-finger zoom and the plugin claims nothing; the guard's own value with it
		// on. RED-FIRST is the plant at InkOverlay.ts pinchZoom: () => this.canvasMode rewritten to () => true,
		// which makes the canvas-off line read the guard value instead.
		expect(touchActionOff?.computed, "canvas off: the surface the router guards hands the pinch to the host").toBe("pinch-zoom");
		expect(touchActionOn?.computed, `canvas on: the guard holds the surface instead (read "${touchActionOn?.computed}")`).not.toBe("pinch-zoom");
	} finally {
		await page.close();
	}
}, 180_000);
