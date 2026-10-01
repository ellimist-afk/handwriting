/**
 * Alan, 2026-09-20: INFINITE CANVAS IS PER NOTE, and with the canvas OFF a note is stock
 * Obsidian: a two-finger gesture is not a zoom. this reverses an earlier ruling, which had kept the pinch in both
 * modes for 1.4.20; the refusal and its cells are back, and this file carries the pin the other rigs copy.
 *
 * What ships here: a note answers for itself, its own frontmatter choice (`handwriting-canvas`) if
 * it has one, else the global setting; the overlay's cached answer follows the global toggle and the
 * note's own choice while mounted; the pinch zooms with the canvas on and is refused with it off.
 *
 * Red-first at the base without the per-note read (the overlay has no canvasModeOn, an override
 * changes nothing); green with slice B.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

let browser: Browser, bundle: string;

beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./canvasModePage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	bundle = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => { await browser?.close(); });

const PANE = { w: 945, h: 834 } as const;
const CX = PANE.w / 2, CY = PANE.h / 2;
type Read = { k: number; preview: boolean; busy: boolean; canvas: boolean; scrollLeft: number; scrollTop: number; allowance: number };

/** Mount with the fake override module installed first, then the global set as asked. */
async function mounted(global: boolean): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: PANE.w, height: PANE.h }, deviceScaleFactor: 2 });
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addScriptTag({ content: bundle });
	await page.evaluate(() => (window as any).canvasMode.install());
	await page.evaluate(([pane]) => (window as any).scrollColumnAnchor.runTearMount(1, 0, pane, true, { fx: 0.5, fy: 0.5 }), [{ w: PANE.w, h: PANE.h }] as const);
	// The tear mount writes the page's own default; the global under test is set after it, the way
	// the setting's toggle reaches a mounted note.
	await page.evaluate(g => (window as any).scrollColumnAnchor.setScrollExpansionEnabled(g), global);
	await page.evaluate(() => (window as any).canvasMode.settle(2));
	return page;
}

const call = (page: Page, method: string, ...args: unknown[]) => page.evaluate(([m, a]) => (window as any).canvasMode[m](...a), [method, args] as const);
const pinchTo = (page: Page, to: number) => call(page, "pinchTo", to, 20, CX, CY) as Promise<Read[]>;
const show = (rows: Read[]) => rows.map(r => `${r.k.toFixed(3)}${r.preview ? "p" : ""}`).join(" ");

/**
 * Alan direct, reverses the ruling: THE PIN. With the canvas off a two-finger gesture is not a zoom.
 *
 * This is the ONE cell each rig keeps about canvas-off zoom, and its shape is the shape the other seats
 * copy into their own files: canvas off, pinch, NOTHING MOVES - no preview frame is opened, the scale is
 * still 1 at the end of the gesture and after the settle, the scroller has not been written, and the zoom
 * bar reads busy so its buttons, Fit and the zoom commands all stand down together.
 *
 * It replaces the 1.4.20 cell that pinned the opposite ("a pinch still zooms to 200 percent"), whose whole
 * subject was the behaviour this ruling removes. Retired, not widened and not marked expected-to-fail:
 * a cell whose subject is gone is deleted, and the claim that replaces it is asserted outright.
 */
it("CANVAS OFF: a two-finger pinch is not a zoom - no preview, the scale stays 1, the scroller is not written, and the bar reads busy", async () => {
	const page = await mounted(false);
	try {
		const before = await call(page, "read") as Read;
		expect(before.canvas, "premise: the note reads canvas off").toBe(false);
		expect(before.k, "premise: the note starts at 100 percent").toBeCloseTo(1, 5);
		expect(before.busy, "with the canvas off the zoom bar stands down").toBe(true);
		const rows = await pinchTo(page, 2);
		expect(rows.some(r => r.preview), `a preview frame was opened with the canvas off: ${show(rows)}`).toBe(false);
		expect(Math.max(...rows.map(r => Math.abs(r.k - 1))), `the scale moved during the gesture: ${show(rows)}`).toBeLessThanOrEqual(0.0001);
		const final = await call(page, "settle", 4) as Read;
		expect(final.k, `the scale moved after the lift: ${show(rows)}`).toBeCloseTo(1, 5);
		// The gesture must not leak into the scroller either: nothing moves means nothing, not "nothing visible".
		expect(final.scrollLeft, "the gesture wrote the scroller sideways").toBe(before.scrollLeft);
		expect(final.scrollTop, "the gesture wrote the scroller down the page").toBe(before.scrollTop);
		expect(final.busy, "the bar came back up after a gesture the canvas-off note refused").toBe(true);
		// Alan, 2026-09-20, "it should stay obsidian stock behavior": THE PLUGIN CLAIMS NOTHING.
		// The rows above are driven through `beginPinch`, which is downstream of the claim, so the
		// gesture is driven once more as real contacts: two fingers land on the surface the router
		// listens to and the router must leave both of them to the host.
		const claim = await call(page, "twoFingerContacts", CX, CY) as { touches: number; guarded: number; watched: number; touchAction: string; pinchCalls: number };
		expect(claim.touches, `the second contact was recorded with the canvas off: ${JSON.stringify(claim)}`).toBe(1);
		expect(claim.guarded, `the second contact was added to the guard's touch set: ${JSON.stringify(claim)}`).toBe(1);
		expect(claim.watched, `a pinch was watched with the canvas off: ${JSON.stringify(claim)}`).toBe(0);
		expect(claim.pinchCalls, `onPinch was called with the canvas off: ${JSON.stringify(claim)}`).toBe(0);
	} finally { await page.close(); }
}, 120_000);

it("CANVAS ON: the note reads canvas on and the same pinch zooms to 200 percent", async () => {
	const page = await mounted(true);
	try {
		const before = await call(page, "read") as Read;
		expect(before.canvas, "premise: the note reads canvas on").toBe(true);
		const rows = await pinchTo(page, 2);
		const final = await call(page, "settle", 4) as Read;
		expect(final.k, `did not settle at 200 percent: ${show(rows)}`).toBeCloseTo(2, 2);
	} finally { await page.close(); }
}, 120_000);

it("PER NOTE: global off, this note's own choice on turns its canvas on; off turns it off; 'use default' hands it back to the global", async () => {
	const page = await mounted(false);
	try {
		const on = await call(page, "setOverride", true) as Read;
		expect(on.canvas, "the note's own choice did not turn the canvas on").toBe(true);
		const off = await call(page, "setOverride", false) as Read;
		expect(off.canvas, "the note's own choice did not turn the canvas off").toBe(false);
		const back = await call(page, "setOverride", null) as Read;
		expect(back.canvas, "'use default' did not return to the global (off)").toBe(false);
	} finally { await page.close(); }
}, 120_000);

it("PER NOTE: global on, this note's own choice off overrides it, and 'use default' returns to on", async () => {
	const page = await mounted(true);
	try {
		const off = await call(page, "setOverride", false) as Read;
		expect(off.canvas, "the note's own choice did not override the global on").toBe(false);
		const back = await call(page, "setOverride", null) as Read;
		expect(back.canvas, "'use default' did not return to the global (on)").toBe(true);
	} finally { await page.close(); }
}, 120_000);

it("THE GLOBAL TOGGLE reaches a mounted note both ways, and the canvas going off lands the zoomed note back at 100 percent", async () => {
	const page = await mounted(true);
	try {
		await pinchTo(page, 2);
		const zoomed = await call(page, "settle", 4) as Read;
		expect(zoomed.k, "premise: zoomed").toBeCloseTo(2, 2);
		const off = await call(page, "setGlobal", false) as Read;
		expect(off.canvas, "the global off did not reach the mounted note").toBe(false);
		const held = await call(page, "settle", 6) as Read;
		// The ruling reverses the 1.4.20 line here too: with the canvas off there is no note zoom to hold, so the
		// toggle lands the note back at 100 percent through the ordinary commit. No saved zoom is lost by
		// that - a note's scale lives only while it is mounted, so canvas on again starts from 100 percent.
		expect(held.k, "the canvas going off left the note zoomed").toBeCloseTo(1, 2);
		const on = await call(page, "setGlobal", true) as Read;
		expect(on.canvas, "the global on did not reach the mounted note").toBe(true);
	} finally { await page.close(); }
}, 120_000);

it("PER NOTE: the edge give follows the note's own choice - the router is offered the allowance with the choice on under a global off, and none with the choice off under a global on", async () => {
	const page = await mounted(false);
	try {
		const before = await call(page, "read") as Read;
		expect(before.allowance, "premise: global off, no override, no give").toBe(0);
		const on = await call(page, "setOverride", true) as Read;
		expect(on.allowance, "the note's own choice on did not open the give").toBeGreaterThan(0);
		const back = await call(page, "setOverride", null) as Read;
		expect(back.allowance, "'use default' did not close the give again").toBe(0);
	} finally { await page.close(); }
	const page2 = await mounted(true);
	try {
		const before = await call(page2, "read") as Read;
		expect(before.allowance, "premise: global on, the give is offered").toBeGreaterThan(0);
		const off = await call(page2, "setOverride", false) as Read;
		expect(off.allowance, "the note's own choice off did not close the give").toBe(0);
	} finally { await page2.close(); }
}, 120_000);
