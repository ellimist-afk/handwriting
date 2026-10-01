/**
 * A TOUCHPAD PINCH, AND CTRL+WHEEL, ZOOM THE NOTE.
 *
 * Alan, device, 2026-09-20: "I can't pinch to zoom any further in than 100%, and zooming out
 * doesn't make the zoom counter correspond." Windows delivers a precision-touchpad pinch as a
 * wheel event with ctrlKey - there is no touch contact to route - Obsidian reads it as its quick
 * font size change, and the plugin only followed that font. So the note's own zoom never moved.
 *
 * Read here, on the real overlay through the tear rig, with real WheelEvents on the scroller:
 *   1. a ctrl+wheel run zooms the NOTE past 100%, the counter follows, and the editor font does
 *      not change;
 *   2. the point under the cursor is still under the cursor while the run is live - and at the
 *      settle it lands exactly where a two-finger pinch to the same scale lands it (cell 7).
 *      MEASURED, so that this cell does not claim more than the gesture gives: under Infinite
 *      Canvas the settle re-places a column that fits the pane at pan 0 (InkOverlay :5807), which
 *      moves the held point sideways by 54.34 px in this rig. That is the pinch path's own
 *      contract, identical to 14 decimal places for fingers and for ctrl+wheel, and it is not
 *      this brief's to change. Vertically the hold survives the settle exactly.
 *   3. wheeling the other way zooms out and the counter follows down;
 *   4. past the cap the preview gives, and the quiet end eases back to exactly 400%;
 *   5. with Infinite Canvas OFF nothing is prevented and the note's zoom does not move - Obsidian
 *      gets its event back;
 *   6. deltaMode 1 (lines) zooms by the same arithmetic as pixels.
 *
 * The zoom counter is not mounted in this rig (MobileTools is not in the bundle). `counter` is the
 * string MobileTools builds from `getNoteViewportState().zoom`, formatted by the same expression,
 * so this reads the number the counter renders and not a second copy of it.
 *
 * Run: npm run test:render. Not in `npx vitest run`.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";
import { MAX_PINCH_SCALE, PINCH_GIVE } from "../../src/inline/PinchScale";
import { TOUCHPAD_ZOOM_K, WHEEL_ZOOM_K, WHEEL_ZOOM_LINE_PX, wheelRatio } from "../../src/inline/WheelZoom";

declare const process: { env: Record<string, string | undefined> };
let browser: Browser, bundle: string;
const report: unknown[] = [];

beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./wheelZoomPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	bundle = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
	await browser?.close();
	if (process.env.HW_WHEEL_ZOOM_REPORT) writeFileSync(process.env.HW_WHEEL_ZOOM_REPORT, JSON.stringify(report, null, 1));
});

const PANE = { w: 945, h: 834 } as const;
const CX = PANE.w / 2, CY = PANE.h / 2;

async function mounted(): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: PANE.w, height: PANE.h }, deviceScaleFactor: 2 });
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addScriptTag({ content: bundle });
	await page.evaluate(([pane]) => (window as any).scrollColumnAnchor.runTearMount(1, 0, pane, true, { fx: 0.5, fy: 0.5 }), [{ w: PANE.w, h: PANE.h }] as const);
	// The ctrl+wheel zoom only exists in this mode.
	await page.evaluate(() => (window as any).wheelZoom.setCanvas(true));
	return page;
}

const run = (page: Page, totalDy: number, steps = 10, cx = CX, cy = CY) =>
	page.evaluate(([d, n, x, y]) => (window as any).wheelZoom.run(d, n, x, y), [totalDy, steps, cx, cy] as const) as Promise<any>;

it("1 + 2: a ctrl+wheel run zooms the note about the cursor, the counter follows, the editor font does not move", async () => {
	const page = await mounted();
	try {
		// -400 px of wheel travel: exp(400 * 0.002) = about 2.23x, well inside the cap.
		// Four events of 100 px, the size a mouse notch reports. The total travel, and so every
		// number below, is what it always was; only the event size changed, and it is what makes this
		// run a MOUSE run rather than a touchpad one.
		const r = await run(page, -400, 4);
		report.push({ cell: "zoom in", ...r });
		expect(r.before.k, "premise: the note starts at 100%").toBe(1);
		expect(r.prevented.every((p: boolean) => p), "the plugin let Obsidian's font zoom have the event").toBe(true);

		// 1. The NOTE zoomed, by the run's own arithmetic, and the counter reads it.
		const expected = wheelRatio(-400);
		expect(expected).toBeCloseTo(Math.exp(400 * WHEEL_ZOOM_K), 12);
		expect(r.final.k, `the note did not reach the run's ratio: live ${r.live.map((l: any) => l.k.toFixed(3)).join(" ")}`).toBeCloseTo(expected, 2);
		expect(r.final.counter).toBe(`${Number((r.final.k * 100).toPrecision(3))}%`);
		expect(r.final.zoom).toBeCloseTo(r.final.k, 6);
		expect(r.final.preview, "the run never settled: the preview is still up").toBe(false);

		// The font is Obsidian's business and must be untouched.
		expect(r.final.fontPx, "the editor font changed, so Obsidian's quick font size still saw the event").toBe(r.before.fontPx);

		// 2. THE FOCAL HOLD, read on the live frames: while the gesture is painting, the note point
		// under the cursor stays under the cursor. This is the frame series a user watches.
		const livePreview = r.live.filter((l: any) => l.preview);
		expect(livePreview.length, "no live preview frame to read the hold on").toBeGreaterThan(0);
		for (const l of livePreview) {
			const x = l.rect.left + r.noteX * l.k, y = l.rect.top + r.noteY * l.k;
			expect(Math.abs(x - r.cursor.x), `focal hold missed sideways by ${(x - r.cursor.x).toFixed(2)} px at k ${l.k.toFixed(3)}`).toBeLessThanOrEqual(1);
			expect(Math.abs(y - r.cursor.y), `focal hold missed vertically by ${(y - r.cursor.y).toFixed(2)} px at k ${l.k.toFixed(3)}`).toBeLessThanOrEqual(1);
		}
		// The settle keeps the vertical hold exactly; sideways it re-places the column, which cell 7
		// pins against a finger pinch rather than against an ideal this gesture never promised.
		expect(Math.abs(r.heldY - r.cursor.y), `the settle moved the held point vertically by ${(r.heldY - r.cursor.y).toFixed(2)} px`).toBeLessThanOrEqual(1);
	} finally {
		await page.close();
	}
}, 120_000);

it("3: wheeling the other way zooms the note out and the counter follows down", async () => {
	const page = await mounted();
	try {
		const r = await run(page, 300, 3); // Three events of 100 px, a mouse run
		report.push({ cell: "zoom out", ...r });
		const expected = wheelRatio(300);
		expect(expected).toBeLessThan(1);
		expect(r.final.k, "the note did not zoom out").toBeCloseTo(expected, 2);
		expect(r.final.counter).toBe(`${Number((r.final.k * 100).toPrecision(3))}%`);
		expect(r.final.fontPx).toBe(r.before.fontPx);
	} finally {
		await page.close();
	}
}, 120_000);

it("4: past the cap the preview gives, and the quiet end eases back to exactly 400%", async () => {
	const page = await mounted();
	try {
		// exp(1200 * 0.002) = about 11x: far past the 4x cap.
		const r = await run(page, -1200, 12); // Twelve events of 100 px, a mouse run
		report.push({ cell: "past the cap", ...r });
		const peak = Math.max(...r.live.map((l: any) => l.k as number));
		expect(peak, "the preview stopped dead at the cap instead of giving").toBeGreaterThan(MAX_PINCH_SCALE + 0.05);
		expect(peak, "the preview passed the give").toBeLessThanOrEqual(MAX_PINCH_SCALE * PINCH_GIVE + 1e-9);
		expect(r.final.k, "the run did not settle on the cap").toBeCloseTo(MAX_PINCH_SCALE, 6);
		expect(r.final.preview).toBe(false);
		expect(r.final.give).toBe(false);
	} finally {
		await page.close();
	}
}, 120_000);

it("5: with Infinite Canvas off the event is not prevented and the note's zoom does not move", async () => {
	const page = await mounted();
	try {
		await page.evaluate(() => (window as any).wheelZoom.setCanvas(false));
		const r = await page.evaluate(([x, y]) => (window as any).wheelZoom.one(-200, x, y), [CX, CY] as const) as any;
		report.push({ cell: "canvas off", ...r });
		expect(r.prevented, "the plugin swallowed the event with Infinite Canvas off, so Obsidian's font nudge never sees it").toBe(false);
		expect(r.after.k, "the note zoomed with Infinite Canvas off").toBe(r.before.k);
		expect(r.after.preview).toBe(false);
	} finally {
		await page.close();
	}
}, 120_000);

it("6: deltaMode 1 is lines, so the same gesture in line units lands on the same scale", async () => {
	const page = await mounted();
	try {
		const lines = -25;
		const r = await page.evaluate(([n, s, x, y]) => (window as any).wheelZoom.lines(n, s, x, y), [lines, 10, CX, CY] as const) as any;
		report.push({ cell: "deltaMode 1", ...r });
		expect(r.final.k, "line-reported deltas were taken as pixels").toBeCloseTo(wheelRatio(lines * WHEEL_ZOOM_LINE_PX), 2);
	} finally {
		await page.close();
	}
}, 120_000);

it("8: the same travel on a touchpad zooms 1.5 times as far as on a mouse wheel", async () => {
	const page = await mounted();
	try {
		// 25 events of 4 px: the stream a precision touchpad sends. Same -100 px of travel as the
		// mouse arm below, which sends it as one 100 px notch.
		const pad = await run(page, -100, 25);
		report.push({ cell: "touchpad", ...pad });
		expect(pad.final.k, "the touchpad run did not land at the touchpad gain").toBeCloseTo(Math.exp(100 * TOUCHPAD_ZOOM_K), 2);

		const mouse = await mounted();
		try {
			const wheel = await run(mouse, -100, 1);
			report.push({ cell: "mouse", ...wheel });
			expect(wheel.final.k, "the mouse run moved off 0.002").toBeCloseTo(Math.exp(100 * WHEEL_ZOOM_K), 2);
			// The claim itself, in log ratio, which is where "1.5 times as far" is a straight line.
			const gain = Math.log(pad.final.k) / Math.log(wheel.final.k);
			expect(gain, `the touchpad run was ${gain.toFixed(3)} times the mouse run, not 1.5`).toBeCloseTo(1.5, 1);
		} finally {
			await mouse.close();
		}
	} finally {
		await page.close();
	}
}, 180_000);

it("7 (control): a finger pinch to the same scale holds the same point in the same place", async () => {
	const page = await mounted();
	try {
		const wheel = await run(page, -400, 4);
		const p2 = await mounted();
		const fingers = await p2.evaluate(([to, n, x, y]) => (window as any).wheelZoom.fingers(to, n, x, y), [wheel.final.k, 10, CX, CY] as const) as any;
		report.push({ cell: "control: fingers", wheel: { k: wheel.final.k, heldX: wheel.heldX, heldY: wheel.heldY }, fingers: { k: fingers.final.k, heldX: fingers.heldX, heldY: fingers.heldY } });
		// PREMISE, so this cell cannot pass by both sides doing nothing: on a tree where ctrl+wheel is
		// not wired the wheel run ends at 1, the control is then asked to zoom to 1, and two notes at
		// rest would agree trivially.
		expect(wheel.final.k, "the wheel run did not zoom, so there is nothing to compare").toBeGreaterThan(1.5);
		expect(fingers.final.k, "the control did not reach the wheel run's scale").toBeCloseTo(wheel.final.k, 2);
		expect(Math.abs(wheel.heldX - fingers.heldX), `ctrl+wheel held the point ${(wheel.heldX - fingers.heldX).toFixed(2)} px from where a finger pinch holds it (wheel ${wheel.heldX.toFixed(2)}, fingers ${fingers.heldX.toFixed(2)}, cursor ${CX})`).toBeLessThanOrEqual(1);
		expect(Math.abs(wheel.heldY - fingers.heldY), `vertical parity off by ${(wheel.heldY - fingers.heldY).toFixed(2)} px`).toBeLessThanOrEqual(1);
		await p2.close();
	} finally {
		await page.close();
	}
}, 180_000);
