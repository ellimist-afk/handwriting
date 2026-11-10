/**
 * MINUS AT 100 PERCENT PUTS THE NOTE BACK WHERE IT OPENS. A zoom in to 200 percent and back out to 100 percent as the zoom bar's minus lands there,
 * on the device rig's pane (1174 x 710) and window (1402 x 788 at device pixel ratio 1.37), with Obsidian's file margins:
 * the scroller is padded 32 px, so with Readable line length off the lines start 32 px in.
 *
 * Measured before this fix (Readable line length off): the sizer stood 64 px in after the round trip, not 32, the scroll
 * width was 32 px wider, the 32 px was booked as column margin debt and paid as scroll, and the minus landed at scrollLeft
 * 33 for a zoom in at the centre and 173 for one at the device's pen point. The 32 was the scroller's padding counted again
 * as the column's margin; and the minus held the centre, so a zoom in anywhere else left the view slid sideways.
 *
 *   1. Readable line length off, zoom in at the centre: the minus lands at scrollLeft 0 and scrollTop 0, the sizer at 32,
 *      the scroll width as at the start, no margin written and no debt, the content within 1/64 px of where it started.
 *   2. Readable line length off, zoom in at the pen point: the minus lands at scrollLeft 0.
 *   3. Readable line length on, no file margins, zoom in at the pen point: unchanged, scrollLeft 0, the content where it
 *      started, no debt.
 *   4. Readable line length off, file margins on, from 23.5 percent scrolled down: the 100 percent button (resetNoteZoom)
 *      lands at scrollLeft 0 with the content where it opened, and scrollTop where the centre's hold puts it.
 *
 * The wheel total is scaled so the zoom in lands at 200 percent (calibrated on this profile: 2.584704 at scale 1).
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

// Obsidian's file margins (its app.css): the scroller is padded by --file-margins, 32 px each side.
const FILE_MARGINS_CSS = ":root{--size-4-8:32px;--file-margins-x:var(--size-4-8);--file-margins-y:var(--size-4-8);--file-margins:var(--file-margins-y) var(--file-margins-x);}" +
	".markdown-source-view.mod-cm6 > .cm-editor > .cm-scroller{padding:var(--file-margins);}";
const SCALE = 0.7299275013417234;
let browser: Browser, bundle: string;

beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./zoomOutRestPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	bundle = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => { await browser?.close(); });

type S = { k: number; css: number; rectH: number; maxTop: number; sl: number; st: number; scrollWidth: number; originX: number; originRel: number; contentW: number; scrollerW: number; rest: number | null; debt: number; marginVar: string; sizerOffsetLeft: number | null };
type Trip = { base: S; zoomedIn: S; minus: boolean; landed: S };

async function trip(readable: boolean, margins: boolean, pivot: "pen" | "centre"): Promise<Trip> {
	const page = await browser.newPage({ viewport: { width: 1402, height: 788 }, deviceScaleFactor: 1.37 });
	try {
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + (margins ? FILE_MARGINS_CSS : "") });
		await page.addScriptTag({ content: bundle });
		await page.evaluate(r => (window as any).zoomOutRest.mount(r), readable);
		const t = await page.evaluate(([p, s]) => (window as any).zoomOutRest.roundTrip(p, s), [pivot, SCALE] as const) as Trip;
		// eslint-disable-next-line no-console
		console.log(`MINUS REST ${readable ? "readable" : "off"} ${pivot} ${JSON.stringify(t)}`);
		return t;
	} finally {
		await page.close();
	}
}

function premise(t: Trip, readable: boolean): void {
	if (!readable) expect(Math.abs(t.base.originRel - 32), `premise: the lines start 32 px into the scroller (${t.base.originRel})`).toBeLessThanOrEqual(1);
	if (!readable) expect(t.base.contentW, "premise: the column fits inside the scroller at 100 percent").toBeLessThan(t.base.scrollerW);
	expect({ sl: t.base.sl, st: t.base.st }, "premise: the note opens at scroll 0, 0").toEqual({ sl: 0, st: 0 });
	expect(Math.abs(t.zoomedIn.k - 2), `premise: the wheel landed at 200 percent (${t.zoomedIn.k})`).toBeLessThan(1e-6);
	expect(t.minus, "premise: the minus committed").toBe(true);
	expect(Math.abs(t.landed.k - 1), `premise: the minus landed at 100 percent to float residue (${t.landed.k})`).toBeLessThanOrEqual(1e-9);
}

it("1: Readable line length off, zoom in at the centre: the minus puts the note back where it opened", async () => {
	const t = await trip(false, true, "centre");
	premise(t, false);
	const l = t.landed;
	expect({ sl: l.sl, st: l.st, sizerOffsetLeft: l.sizerOffsetLeft, scrollWidth: l.scrollWidth, debt: l.debt },
		`landed as opened (margin variable "${l.marginVar}", rest ${l.rest})`)
		.toEqual({ sl: 0, st: t.base.st, sizerOffsetLeft: t.base.sizerOffsetLeft, scrollWidth: t.base.scrollWidth, debt: 0 });
	expect(["", "0px"], "no column margin written").toContain(l.marginVar);
	expect(Math.abs(l.originX - t.base.originX), "the content within 1/64 px of where it opened").toBeLessThanOrEqual(1 / 64);
}, 120_000);

it("2: Readable line length off, zoom in at the pen point: the minus lands at scrollLeft 0", async () => {
	const t = await trip(false, true, "pen");
	premise(t, false);
	expect(t.landed.sl, `scrollLeft after the minus (zoomed in at ${t.zoomedIn.sl})`).toBe(0);
}, 120_000);

it("3: Readable line length on, zoom in at the pen point: the round trip lands as before, at scrollLeft 0 with the column where it opened", async () => {
	const t = await trip(true, false, "pen");
	premise(t, true);
	expect({ sl: t.landed.sl, debt: t.landed.debt }).toEqual({ sl: 0, debt: 0 });
	expect(Math.abs(t.landed.originX - t.base.originX), `the column within 1/64 px of where it opened (${t.base.originX} to ${t.landed.originX})`).toBeLessThanOrEqual(1 / 64 + 1e-6);
}, 120_000);

it("4: Readable line length off, from 23.5 percent: the 100 percent button puts the note back at its left rest, up and down held at the centre", async () => {
	const page = await browser.newPage({ viewport: { width: 1402, height: 788 }, deviceScaleFactor: 1.37 });
	try {
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS + FILE_MARGINS_CSS });
		await page.addScriptTag({ content: bundle });
		await page.evaluate(() => (window as any).zoomOutRest.mount(false));
		const t = await page.evaluate(() => (window as any).zoomOutRest.resetFrom(0.235, 400)) as { base: S; out: boolean; zoomedOut: S; reset: boolean; landed: S };
		// eslint-disable-next-line no-console
		console.log(`RESET REST ${JSON.stringify(t)}`);
		expect({ out: t.out, reset: t.reset }, "premise: both zooms committed").toEqual({ out: true, reset: true });
		expect(Math.abs(t.zoomedOut.k - 0.235), `premise: zoomed out to 23.5 percent (${t.zoomedOut.k})`).toBeLessThan(1e-9);
		expect(t.zoomedOut.st, "premise: scrolled down before the reset").toBeGreaterThan(0);
		expect(t.landed.k, "premise: the reset landed at 100 percent").toBe(1);
		const z = t.zoomedOut, held = Math.min(t.landed.maxTop, Math.max(0, z.st + (z.rectH / 2) * (1 / z.css - 1 / t.landed.css)));
		expect(t.landed.sl, `scrollLeft after the 100 percent button (at 23.5 percent ${z.sl})`).toBe(0);
		expect(Math.abs(t.landed.originX - t.base.originX), `the content within 1/64 px of where it opened (${t.base.originX} to ${t.landed.originX})`).toBeLessThanOrEqual(1 / 64);
		expect(Math.abs(t.landed.st - held), `scrollTop at the centre's hold (${held}, landed ${t.landed.st})`).toBeLessThanOrEqual(1);
	} finally {
		await page.close();
	}
}, 120_000);
