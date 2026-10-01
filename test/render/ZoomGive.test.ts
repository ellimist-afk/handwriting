/**
 * LINE 6: A PINCH PAST THE CAP GIVES, AND THE LIFT EASES BACK TO THE CAP.
 *
 * Alan, 2026-09-18, second video: "the zoom should expand and then settle like onenote". Before this
 * the preview stopped dead at 400%: the fingers kept spreading and nothing on screen answered. Now a
 * live pinch paints past the cap by PINCH_GIVE (preview only), and at the lift the same preview path
 * is driven back to the cap over the bounce's half second, then settles there once. The committed
 * range is unchanged: every settle and the zoom button still land inside 10%..400%.
 *
 * Read here, on the real router (two touch contacts, pointerType "touch", the plain note):
 *   1. past the cap the preview keeps painting: the last live frame reads above 4 (today: exactly 4);
 *   2. the lift does not move the page (the first read after it is still the overshoot), then the
 *      frames after it only ever shrink, never pass the cap, and the last one is exactly 4 with the
 *      preview down and the raster committed at 4;
 *   3. under the floor there is NO give: the preview stops at 10%
 *      and the lift settles at once;
 *   4. inside the range nothing changed: the lift settles at once, no ease frame;
 *   5. a new contact mid-ease lands on the cap first, and the next gesture starts from it;
 *   6. the zoom button is still refused at the cap.
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
import { MAX_PINCH_SCALE, MIN_PINCH_SCALE, PINCH_GIVE } from "../../src/inline/PinchScale";

declare const process: { env: Record<string, string | undefined> };
let browser: Browser, bundle: string;
const report: unknown[] = [];

beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./zoomGivePage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	bundle = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
	await browser?.close();
	if (process.env.HW_ZOOM_GIVE_REPORT) writeFileSync(process.env.HW_ZOOM_GIVE_REPORT, JSON.stringify(report, null, 1));
});

const PANE = { w: 945, h: 834 } as const;
// Every target in this file is read off the cap constant, not a literal.
// The cells were written when MAX_PINCH_SCALE was 4 and asked for 4.3; the 600 percent restore
// moved the cap to 6 and left them asking for a scale well inside the range, so nothing reached
// the cap and the give, the ease and the button refusal all had nothing to act on. PAST_CAP is the
// preview ceiling itself (MAX_PINCH_SCALE * PINCH_GIVE = 6.6 at this head), which is what the
// preview clamps to, so the gesture asks for exactly the far end of the give.
const PAST_CAP = MAX_PINCH_SCALE * PINCH_GIVE;
const CX = PANE.w / 2, CY = PANE.h / 2;
type Read = { k: number; preview: boolean; raster: number; css: number; give: boolean; bounce: boolean };

// Alan, 2026-09-20: the note zoom exists only under the Infinite Canvas, so every cell in
// this file mounts with the canvas ON. With it off the product ignores the whole gesture and
// there is no cap, no give and no ease to read.
async function mounted(infiniteCanvas = true): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: PANE.w, height: PANE.h }, deviceScaleFactor: 2 });
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addScriptTag({ content: bundle });
	await page.evaluate(([pane]) => (window as any).scrollColumnAnchor.runTearMount(1, 0, pane, true, { fx: 0.5, fy: 0.5 }), [{ w: PANE.w, h: PANE.h }] as const);
	await page.evaluate(ic => (window as any).scrollColumnAnchor.setScrollExpansionEnabled(ic), infiniteCanvas);
	return page;
}

const lift = (page: Page, to: number, steps = 30, maxFrames = 200) =>
	page.evaluate(([t, n, cx, cy, m]) => (window as any).zoomGive.liftPast(t, n, cx, cy, m), [to, steps, CX, CY, maxFrames] as const) as
	Promise<{ atLift: Read; scales: number[]; justAfterLift: Read; rows: Read[]; final: Read }>;

const show = (rows: Read[]) => rows.map(r => `${r.k.toFixed(3)}${r.preview ? "p" : ""}${r.give ? "g" : ""}`).join(" ");

it("1 + 2: past the cap the preview keeps painting, and the lift eases it back onto the cap, settling there once", async () => {
	const page = await mounted();
	try {
		const r = await lift(page, PAST_CAP);
		report.push({ cell: "past the cap", ...r });
		expect(r.atLift.k, "premise: the note starts at 100%").toBe(1);
		// 1. The last live frame is past the cap (today it stops dead at 4).
		expect(Math.max(...r.scales), `the preview stopped at the cap: live frames ${r.scales.map(s => s.toFixed(3)).join(" ")}`).toBeGreaterThan(MAX_PINCH_SCALE + 0.05);
		expect(Math.max(...r.scales), "the preview passed the give").toBeLessThanOrEqual(MAX_PINCH_SCALE * PINCH_GIVE + 1e-9);
		// 2. The lift itself moves nothing: the read right after it is still the overshoot, easing.
		expect(r.justAfterLift.k, "the lift snapped the scale").toBeGreaterThan(MAX_PINCH_SCALE + 0.05);
		expect(r.justAfterLift.give, "no give ease started at the lift").toBe(true);
		// Then the frames only shrink, never pass the cap, and the last one is the cap exactly.
		const over = r.rows.filter(x => x.k > MAX_PINCH_SCALE);
		expect(over.length, `the ease ran over several frames: ${show(r.rows)}`).toBeGreaterThanOrEqual(3);
		for (let i = 1; i < r.rows.length; i++) expect(r.rows[i]!.k, `frame ${i} went back up: ${show(r.rows)}`).toBeLessThanOrEqual(r.rows[i - 1]!.k + 1e-9);
		for (const x of r.rows) expect(x.k, `a frame passed the cap on the way back: ${show(r.rows)}`).toBeGreaterThanOrEqual(MAX_PINCH_SCALE - 1e-9);
		expect(r.rows.length, "the ease never ended").toBeLessThan(200);
		expect(r.final.k, "the settle is not exactly at the cap").toBe(MAX_PINCH_SCALE);
		expect(r.final.preview, "the preview did not come down").toBe(false);
		expect(r.final.give, "the give did not clear").toBe(false);
		expect(r.final.raster, "the raster is not committed at the cap").toBe(MAX_PINCH_SCALE);
	} finally { await page.close(); }
}, 180_000);

// RETIRED BY the ruling: this cell existed to show the cap give and its ease are the same with the
// Infinite Canvas on as with it off. There is no canvas-off zoom to compare against any more,
// and the cell above now runs with the canvas on, so the two are one cell.

it("3: under the floor there is no give: the preview stops at 10% and the lift settles at once", async () => {
	const page = await mounted();
	try {
		const r = await lift(page, 0.08, 30);
		report.push({ cell: "under the floor", ...r });
		expect(Math.min(...r.scales), `the preview went under the floor: ${r.scales.map(s => s.toFixed(4)).join(" ")}`).toBeGreaterThanOrEqual(MIN_PINCH_SCALE - 1e-9);
		expect(Math.min(...r.scales), "the preview never reached the floor").toBeCloseTo(MIN_PINCH_SCALE, 9);
		expect(r.justAfterLift.give, "a give ease started at the floor").toBe(false);
		expect(r.justAfterLift.preview, "the lift did not settle at once").toBe(false);
		expect(r.final.k, "the settle is not exactly at the floor").toBe(MIN_PINCH_SCALE);
		expect(r.final.raster).toBe(MIN_PINCH_SCALE);
	} finally { await page.close(); }
}, 180_000);

it("4: inside the range nothing changed: the lift settles at once, no ease frame", async () => {
	const page = await mounted();
	try {
		const r = await lift(page, 2, 30);
		report.push({ cell: "inside the range", ...r });
		expect(Math.max(...r.scales)).toBeCloseTo(2, 6);
		expect(r.justAfterLift.give, "a give ease started inside the range").toBe(false);
		expect(r.justAfterLift.preview, "the lift did not settle at once").toBe(false);
		expect(r.justAfterLift.k).toBeCloseTo(2, 6);
		expect(r.final.k).toBeCloseTo(2, 6);
		expect(r.final.raster).toBeCloseTo(2, 6);
		const exact = await lift(page, MAX_PINCH_SCALE, 30);
		expect(exact.justAfterLift.give, "the cap itself is inside the range: no ease").toBe(false);
		expect(exact.final.k).toBe(MAX_PINCH_SCALE);
	} finally { await page.close(); }
}, 180_000);

type RectRead = Read & { rect: { left: number; top: number; width: number } };

it("5: two fingers landing mid-ease take the zoom over where it is: nothing jumps, and the next gesture settles where it asks", async () => {
	const page = await mounted();
	try {
		const r = await page.evaluate(([cx, cy, past]) => (window as any).zoomGive.grabMidEase(past, 2, 20, cx, cy), [CX, CY, PAST_CAP] as const) as
			{ scales: number[]; easing: Read[]; beforeContact: RectRead; atNewContact: RectRead; engaged: RectRead[]; rows: Read[]; final: Read };
		report.push({ cell: "grab mid-ease", ...r });
		expect(r.easing.some(x => x.give && x.k > MAX_PINCH_SCALE), `premise: the ease was running when the new contact landed: ${show(r.easing)}`).toBe(true);
		// The contact itself moves nothing: same scale, same painted page, the ease still in flight.
		expect(r.atNewContact.k, "the new contact snapped the scale").toBe(r.beforeContact.k);
		expect(Math.abs(r.atNewContact.rect.left - r.beforeContact.rect.left), "the page moved at the contact").toBeLessThanOrEqual(1);
		expect(Math.abs(r.atNewContact.rect.width - r.beforeContact.rect.width), "the page resized at the contact").toBeLessThanOrEqual(1);
		// Once the pinch engages it continues from the scale on screen, past the cap: no frame drops to 4 first.
		const first = r.engaged[0]!;
		expect(first.give, "the ease was still running after the pinch engaged").toBe(false);
		expect(first.preview, "the preview came down under the fingers").toBe(true);
		// The gesture's own steps from there are uniform: the first engaged frame is one step below where the
		// ease stood (a takeover from above the cap lands its first step near the cap, not on it), and the
		// next two steps are the same size. A snap to the cap first would make the first step the odd one.
		expect(first.k, `the first engaged frame snapped down to the cap or below: ${show(r.engaged)}`).toBeGreaterThan(MAX_PINCH_SCALE - 0.2);
		const s1 = r.engaged[0]!.k - r.engaged[1]!.k, s2 = r.engaged[1]!.k - r.engaged[2]!.k;
		expect(Math.abs(s1 - s2), `the gesture's steps are not uniform after the takeover: ${show(r.engaged)}`).toBeLessThan(0.02);
		// The gesture's ratio is applied to the scale it engaged at, which the ease moved a little past the
		// contact's reading, so the landing is near the planned 2, inside the committed range, and settled.
		expect(Math.abs(r.final.k - 2), `the next gesture did not settle near where it asked (${r.final.k})`).toBeLessThan(0.15);
		expect(r.final.preview).toBe(false);
		expect(r.final.give).toBe(false);
		expect(r.final.raster, "the raster is not committed at the settled scale").toBe(r.final.k);
	} finally { await page.close(); }
}, 180_000);

it("7: a pen landing mid-ease holds the zoom where it is for the stroke, the stroke lands on the note, and the ease resumes to the cap after pen-up", async () => {
	const page = await mounted();
	try {
		const r = await page.evaluate(([cx, cy, past]) => (window as any).zoomGive.penMidEase(past, 30, cx, cy), [CX, CY, PAST_CAP] as const) as
			{ scales: number[]; easing: Read[]; atPenDown: RectRead; beforePenUp: RectRead; justAfterPenUp: Read; rows: Read[]; final: Read;
				strokeX: number | null; strokeY: number | null; expMid: { x: number; y: number }; control: { x: number; y: number; expX: number; expY: number } | null };
		report.push({ cell: "pen mid-ease", ...r });
		expect(r.easing.some(x => x.give && x.k > MAX_PINCH_SCALE), `premise: the ease was running when the pen landed: ${show(r.easing)}`).toBe(true);
		// Nothing moves under the pen: the scale at pen-down is the easing scale, still past the cap, and it is the same
		// scale and the same painted rect when the pen lifts.
		expect(r.atPenDown.k, "the pen landed on a snapped zoom (finished in one frame)").toBeGreaterThan(MAX_PINCH_SCALE);
		expect(r.atPenDown.give, "the give was dropped at pen-down").toBe(true);
		expect(r.beforePenUp.k, "the zoom moved during the stroke").toBe(r.atPenDown.k);
		expect(Math.abs(r.beforePenUp.rect.left - r.atPenDown.rect.left), "the page moved during the stroke").toBeLessThanOrEqual(0.5);
		expect(Math.abs(r.beforePenUp.rect.top - r.atPenDown.rect.top), "the page moved during the stroke (y)").toBeLessThanOrEqual(0.5);
		// After pen-up the ease resumes and settles once at the cap. Read BEFORE the landing rows so a plant that drops
		// the resume reddens here, and a plant that drops the mapping reddens below: one row per claim.
		expect(r.justAfterPenUp.give, "the ease did not resume after pen-up").toBe(true);
		for (let i = 1; i < r.rows.length; i++) expect(r.rows[i]!.k, `frame ${i} went back up after pen-up: ${show(r.rows)}`).toBeLessThanOrEqual(r.rows[i - 1]!.k + 1e-9);
		expect(r.final.k).toBe(MAX_PINCH_SCALE);
		expect(r.final.preview).toBe(false);
		expect(r.final.give).toBe(false);
		expect(r.final.raster).toBe(MAX_PINCH_SCALE);
		// The stroke is stored where the page stood under the pen: its residual against the naive mapping equals the
		// control stroke's residual at rest (a constant note offset cancels; a mapping that ignored the live preview does not).
		expect(r.strokeX, "no stroke was stored").not.toBeNull();
		expect(r.control, "no control stroke was stored").not.toBeNull();
		const dx = (r.strokeX! - r.expMid.x) - (r.control!.x - r.control!.expX), dy = (r.strokeY! - r.expMid.y) - (r.control!.y - r.control!.expY);
		expect(Math.abs(dx), `the mid-ease stroke is off the note point under the pen by ${dx.toFixed(2)} note px (x)`).toBeLessThanOrEqual(1.5);
		expect(Math.abs(dy), `the mid-ease stroke is off the note point under the pen by ${dy.toFixed(2)} note px (y)`).toBeLessThanOrEqual(1.5);
	} finally { await page.close(); }
}, 180_000);

// RETIRED BY the ruling. This cell zoomed out to 25% with the Infinite Canvas OFF and then dragged,
// to show the plain bound of the ruling stopping the page and the lift landing on it. A note cannot
// be at 25% with the canvas off any more - the pinch is ignored and the zoom commands read
// busy - so the state it measured cannot occur. The canvas-on twin of this gesture, where the
// band grants the give and the lift eases home, is covered by the overscroll bounce rows.

it("6: the zoom button is still refused at the cap", async () => {
	const page = await mounted();
	try {
		const at = await lift(page, MAX_PINCH_SCALE, 30);
		expect(at.final.k).toBe(MAX_PINCH_SCALE);
		const r = await page.evaluate(() => (window as any).zoomGive.button(1.25)) as { accepted: unknown; final: Read };
		report.push({ cell: "button at the cap", ...r });
		expect(r.final.k, "the button went past the cap").toBe(MAX_PINCH_SCALE);
		expect(r.final.give).toBe(false);
	} finally { await page.close(); }
}, 180_000);
