/**
 * WHAT DOES A SCROLL-THEN-DRAW COST AT 10% ZOOM WITH INFINITE CANVAS ON?
 *
 * Alan, on the device build: "zooming to 10% and then scrolling right and
 * quickly drawing and then scrolling right and then quickly drawing makes lag
 * really really bad", and it gets worse the more the sequence is repeated.
 *
 * This file only RUNS the arm and prints its numbers; the arm itself lives in
 * `scrollColumnAnchorPage.ts` beside the rest of the pinch geometry, because it
 * needs the same counter-sized host, the same readable-width stylesheet and the
 * same real Chromium canvases. It is its own file so the sequence can be
 * re-measured without paying for the twenty unrelated arms in
 * `ScrollColumnAnchorPinch.test.ts`.
 *
 * WHAT IT ASSERTS, and why it is not a time. The three patches must be shown to
 * intercept before any number is read, and the arm must actually reach virgin
 * surface - an arm whose extent was pre-granted reports a confident zero while
 * seeing nothing, which is exactly how the first version of this instrument
 * measured nothing at all. Wall times are PRINTED and not asserted: a threshold
 * on a shared CI box measures the box.
 */

import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };
let browser: Browser, script: string;
const report: unknown[] = [];
/** The stabilizer's own cap, in displayed CSS px (src/inline/CameraOriginY.ts). */
const STABILIZER_CAP = 1 / 1024;
/** The margin a raw delta must sit inside, so a count that went green on
 * which prior the stabilizer happened to retain cannot pass for a fix. */
const RAW_DELTA_MARGIN = STABILIZER_CAP / 4;
/** Q3: every far arm's raw per-frame delta, read across arms at the end. */
const farRawDeltas: { arm: string; maxFrame: number; maxPrior: number }[] = [];
// A DOCUMENT-TOP PARITY STATISTIC WAS TRIED HERE AND IS NOT LANDED. Comparing a
// candidate document top against the shipped contentDOM-rect formula cannot hold
// to any tight tolerance: the REFERENCE carries its own float32 rounding, half a
// ULP at the content rect's magnitude - 6.1e-5 displayed px at this offset and
// 7.8e-4 at 11482 - so a 2.5e-5 parity bound is unreachable whatever the
// candidate does. Measured on the 1.4.19 far-extent evidence runs.
// R6: the per-round LAGFAR/LAGZOOM lines cost ~76 s and 138 KB of log in the
// gate. They are the evidence a measurement run wants and noise in a gate run.
const verbose = () => !!(process.env.HW_LAG_REPORT || process.env.HW_LAG_VERBOSE);
/**
 * THE FAR ARMS ARE ORDINARY TESTS AGAIN, AND THAT IS THE ACCEPTANCE.
 *
 * They were RED on shipped source and stayed red through the first candidate
 * correction: at the far extent the document-top rect is a large-magnitude
 * float, its rounding exceeds the Y stabilizer's cap, and the camera moved on
 * frames the band sat still - 7 to 26 whole-world redraws per round at
 * 0.10-0.15 zoom, 57-133 ms each, with a raw per-frame origin delta of 6e-4 to
 * 2.3e-3 displayed px against a quarter-cap margin of 2.4e-4. While that defect
 * was open they ran as `fails`, so they still executed and printed, and the
 * gate would go red the day they passed.
 *
 * That day is this commit. The camera Y origin is now read from a fixed ladder
 * of rungs in an out-of-flow anchor beside the content, so the measured
 * quantity no longer carries the extent: the raw delta reads 3.05e-5 at 11482,
 * 17223, 22964 and 45928 alike (3.65e-5 at 0.15/17223), camera-only redraws are
 * 0, and the arms are asserted, not expected to fail. A regression puts the
 * magnitude back and reds them.
 *
 * The draw/zoom loop at the bottom is the one exception: it is a wall-time
 * measurement of the compositor, it costs about 35 s a run, and it stays
 * opt-in behind HW_LAG_FAR=1: a wall time on a shared box decides nothing.
 */
/** Distance between adjacent float32 values at `x` - the rounding the shipped
 * contentDOM-rect formula carries at its own magnitude, which a reading taken
 * against that rect cannot be tighter than. */
const ulp32 = (x: number): number => Math.pow(2, Math.floor(Math.log2(Math.abs(x) || 1)) - 23);
const zoomLoopIt = process.env.HW_LAG_FAR === "1" ? it : it.skip;
const note = (line: string): void => { if (verbose()) console.log(line); };

beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./scrollColumnAnchorPage.ts", import.meta.url))],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
	await browser?.close();
	if (process.env.HW_LAG_REPORT) writeFileSync(process.env.HW_LAG_REPORT, JSON.stringify(report, null, 1));
});

async function arm(plant: "lag" | "lagNoIc" | "lagDense" | "lagFling" | "lagFlingDense" | "lagCreep" | "bandCost", pinch = 0.1, options?: { axis: "x" | "y" | "both"; routed: boolean; far: boolean; rapid: boolean; infiniteCanvas: boolean; frames: number; distance: number; pixels?: boolean; farVisual?: number; host?: boolean; zoomCycles?: number; fitCommit?: boolean; fitThenPinch?: number[] }, readable = true) {
	const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
	try {
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(e.message));
		await page.setContent('<!doctype html><body style="margin:0"></body>');
		// The installed app's own stylesheet, first, as the expanded-draw arms load
		// it. Opt-in per arm so the arms above keep measuring what they measured.
		if (options?.host && process.env.HW_DRAW_HOST_CSS) await page.addStyleTag({ content: readFileSync(process.env.HW_DRAW_HOST_CSS, "utf8") });
		await page.addStyleTag({
			content:
				css +
				readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8") +
				REAL_OBSIDIAN_CSS,
		});
		await page.addScriptTag({ content: script });
		// Opt-in Chromium trace for the zoom loop: attributes a long frame to
		// layout, paint or raster where Long Animation Frame timing cannot.
		const tracing = !!(options?.zoomCycles && process.env.HW_LAG_TRACE);
		if (tracing) await browser.startTracing(page, { path: `${process.env.HW_LAG_TRACE}-${pinch}-${options!.farVisual}.json`, categories: process.env.HW_LAG_TRACE_CATS?.split(",") ?? ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink.user_timing"] });
		const r = await page.evaluate(
			a => (window as any).scrollColumnAnchor.run(a.readable, a.plant, a.pinch, false, false, 0, .25, a.options),
			{ plant, pinch, options, readable }
		);
		if (tracing) await browser.stopTracing();
		expect(errors, `page errors in ${plant}: ${errors.join(" | ")}`).toEqual([]);
		report.push(r);
		return r;
	} finally {
		await page.close();
	}
}

/**
 * Liveness and patch-proof, applied to every arm alike. Wall times stay
 * printed and unasserted; what IS asserted is that the arm reached the state
 * whose cost it claims to report.
 */
function checkArmPatches(name: string, r: any): void {
	// eslint-disable-next-line no-console
	console.log(`LAG ${name} step=${r.step} points=${r.points} (${r.injected}x${r.pointsPer}) flingEvents=${r.flingEvents} selfTest=${JSON.stringify(r.selfTest)}`);
	expect(r.selfTest, `${name} self-test`).toEqual({ repaintSeen: true, resizeSeen: true, extentSeen: true, scheduleSeen: true, bandSeen: true });
	expect(r.strokes, `${name} strokes injected`).toBeGreaterThanOrEqual(r.injected);
}

function checkArm(name: string, r: any): void {
	// eslint-disable-next-line no-console
	console.log(`LAG ${name} step=${r.step} points=${r.points} (${r.injected}x${r.pointsPer}) flingEvents=${r.flingEvents} selfTest=${JSON.stringify(r.selfTest)}`);
	for (const round of r.rounds) {
		// eslint-disable-next-line no-console
		console.log(`LAG ${name} ` + JSON.stringify(round));
	}
	// THE PATCHES, before the numbers. A zero from an unproven patch is
	// silence.
	expect(r.selfTest, `${name} self-test`).toEqual({ repaintSeen: true, resizeSeen: true, extentSeen: true, scheduleSeen: true, bandSeen: true });
	// EVERY round moves. Two dead rounds behind one live one is how the first
	// version of this arm reported three rounds of nothing: the surface ran out
	// after the first flick and rounds 1 and 2 scrolled zero px.
	const lefts = r.rounds.map((x: any) => x.scrollLeft);
	expect(lefts[0], `${name} round 0 did not move: ${lefts.join()}`).toBeGreaterThan(0);
	expect(lefts[1], `${name} round 1 did not move: ${lefts.join()}`).toBeGreaterThan(lefts[0]);
	expect(lefts[2], `${name} round 2 did not move: ${lefts.join()}`).toBeGreaterThan(lefts[1]);
	// The ink really is as dense as the arm says. `applyAdd` dropping strokes
	// would make a cheap dense arm indistinguishable from a cheap sparse one.
	expect(r.strokes, `${name} strokes injected`).toBeGreaterThanOrEqual(r.injected);
}

it("the scroll-then-draw sequence at 10% zoom is measured, not assumed", async () => {
	const on = await arm("lag");
	// Alan, 2026-09-20: the two Infinite-Canvas-off arms are retired. Both reached 10% zoom
	// by pinching with the canvas off, and the product no longer zooms in that mode, so the state
	// they measured cannot occur. The refusal itself is pinned once for this rig, in
	// ZoomFreezeTouch.test.ts, through the real touch listeners. The cost question these arms
	// answered - does a scroll-then-draw at low zoom repaint the world - belongs to the IC-on arm
	// now, which is the only mode that can be at low zoom at all.
	checkArm("IC-on", on);
	// THE ARM IS LIVE: the flick has somewhere to go. Without this an extent
	// that was already large enough would make every counter below read zero
	// for a reason that has nothing to do with the code under test.
	expect(on.rounds.map((x: any) => x.scrollLeft).some((n: number) => n > 0)).toBe(true);
});

/**
 * DENSITY AND FLING, the two ways the arm above differs from the surface Alan
 * complains about.
 *
 * The sparse single-event arm reported a whole-world repaint at about a
 * millisecond, which is a true number about a note of 1500 four-point strokes
 * scrolled one event at a time. Alan's note carries real captured strokes and
 * his finger delivers a momentum scroll. These arms move one variable each.
 */
it("density and fling are measured on the same sequence", async () => {
	const dense = await arm("lagDense");
	const flung = await arm("lagFling");
	const both = await arm("lagFlingDense");
	checkArm("dense", dense);
	checkArm("fling", flung);
	checkArm("fling-dense", both);
	// THE FLING REALLY FLUNG: 30 scroll events, not one. Without this a fling
	// arm that silently collapsed to a single event would report the sparse
	// arm's numbers and look like a refutation.
	for (const r of [flung, both]) {
		expect(r.flingEvents, "fling events").toBe(30);
		for (const round of r.rounds) {
			expect(round.scroll.gaps.length, "frames driven in the fling").toBe(30);
		}
	}
	// THE DENSE ARM IS DENSE: 50x the segments over the same paths.
	for (const r of [dense, both]) expect(r.pointsPer).toBe(200);
	// THE FIX, AS A COUNT AND NOT AS A TIME. How often the band is re-pinned
	// during a fling is arithmetic - scroll distance against the band's margin -
	// so it is the same on any box, while the milliseconds it saves are not.
	// Before the margin ceiling was lifted this read 30 of 30 on every round,
	// and each one was a whole-world rasterisation of the note.
	for (const r of [flung, both]) {
		for (const round of r.rounds) {
			expect(round.scroll.bandMoved, `band re-pins in a fling: ${JSON.stringify(round.scroll.bandMoved)}`).toBeLessThan(15);
			expect(round.scroll.bandStill, "frames the band sat still through").toBeGreaterThan(15);
			// The repaint branch follows the band, which is the mechanism the
			// whole fix rests on: a frame that does not move the band does not
			// move the camera, and repaint only upgrades to the whole world on
			// camera motion.
			expect(round.scroll.full, "whole-world repaints").toBe(round.scroll.bandMoved);
		}
	}
});

/**
 * IS THE REPOSITION THE CAUSE, or is a scroll expensive whatever the band does?
 *
 * The band exists to make ordinary scrolling free. It is deliberately lazy, and
 * ScrollBand's own header says a reposition is what costs a re-rasterisation:
 * "any camera motion makes repaint() re-rasterize every visible stroke, and
 * that used to happen on every single scroll event". At 10% zoom the scroller's
 * layout px are a tenth of a visual px, so a flick the finger sees as 900px is
 * 9000 layout px - far past a margin capped at 320 layout px - and the band is
 * re-pinned on every frame of it. This arm drives the same 30 events at 10
 * layout px each, which no band margin can be eaten through, and reads the
 * band's own answer beside the repaint branch.
 */
it("a scroll that does not move the band does not re-rasterise the world", async () => {
	const creep = await arm("lagCreep");
	checkArmPatches("creep", creep);
	for (const round of creep.rounds) {
		// eslint-disable-next-line no-console
		console.log("LAG creep " + JSON.stringify(round));
	}
	// LIVENESS: the events really were delivered.
	for (const round of creep.rounds) {
		expect(round.scroll.gaps.length, "frames driven").toBe(30);
		expect(round.scroll.bandStill + round.scroll.bandMoved + round.scroll.bandResized, "band consulted").toBeGreaterThan(0);
	}
	expect(creep.rounds[2].scrollLeft, "creep moved the scroller").toBeGreaterThan(creep.rounds[0].scrollLeft);
});

/** Small finger steps at 10% move scrolling rects by fractional screen pixels.
 * Their independent rounding must not turn a stationary raster camera into a
 * full redraw each frame. X-only and 100% controls isolate the scaled Y path;
 * each round still commits a routed stroke and preserves saved geometry.
 */
it.each([
	{ zoom: .1, axis: "both" as const, infiniteCanvas: true },
	{ zoom: .15, axis: "both" as const, infiniteCanvas: true },
	{ zoom: .1, axis: "x" as const, infiniteCanvas: true },
	{ zoom: 1, axis: "both" as const, infiniteCanvas: true },
	// The canvas-off rows that stood here are retired. With the Infinite Canvas off the
	// product now ignores every pinch phase, so the note stays at 100 percent and there is no
	// zoomed canvas-off state left to measure. See RETIRED-CELLS.md.
])("fractional scroll/draw steps keep a stationary band cheap: $zoom/$axis/IC=$infiniteCanvas", async ({ zoom, axis, infiniteCanvas }) => {
	const r = await arm("lagFlingDense", zoom, { axis, infiniteCanvas, routed: true, far: true, rapid: true, frames: 30, distance: 39, pixels: true });
	checkArmPatches("fractional", r);
	expect(r.quality.originalUnchanged).toBe(true);
	expect(r.quality.roundtrip).toBe(true);
	expect(r.quality.savedCount).toBe(r.strokes);
	expect(r.reflow[1].origin - r.reflow[0].origin, "the content really moved by a fractional layout offset").toBeCloseTo(1.25, 2);
	expect(r.reflow[2].origin).toBeCloseTo(r.reflow[0].origin, 2);
	for (const sample of r.reflow) expect(sample.error, "ink follows real Y layout changes").toBeLessThan(.002);
	for (const round of r.rounds) {
		expect(round.added, "a routed stroke committed in every round").toBe(1);
		expect(round.acceptedPoints, "the routed down and both distinct moves reached stored ink").toEqual([3]);
		expect(round.wetPixels + round.tailPixels, "new ink reaches the live ribbon/head at the routed endpoint").toBeGreaterThan(0);
		expect(round.committedPixels, "new ink reaches the committed canvas at the same endpoint").toBeGreaterThan(0);
		expect(round.freshPure, "diagnostic reads do not advance the canonical origin").toBe(true);
		expect(round.freshError).toBeLessThan(.002);
		const first = round.scroll.input[0].before, last = round.scroll.input.at(-1).after;
		expect((last[0] - first[0]) * zoom, "the finger reached the tested X range").toBeGreaterThan(25);
		if (axis === "both") expect((last[1] - first[1]) * zoom, "the finger reached the tested Y range").toBeGreaterThan(25);
		expect.soft(round.scroll.cameraChangesWithoutBand, "scrolling alone must not manufacture Y camera motion").toEqual([]);
		expect.soft(round.scroll.full, "full redraws follow actual band moves").toBe(round.scroll.bandMoved);
		// THE SAME RAW-DELTA MEASUREMENT AS THE FAR ARMS, here as the positive
		// control: at this offset the rects round by a fraction of the margin,
		// so the statistic the far arms fail is shown passing on the same code.
		expect.soft(round.scroll.camera.maxFrameDeltaVisual, "raw origin delta per frame near the top").toBeLessThanOrEqual(RAW_DELTA_MARGIN);
		// THE FIRST STROKE AFTER A SCROLL IS NOT A GEOMETRY CHANGE. `penDown`
		// bumps `viewportGeneration`, and while that counter was a term in the
		// camera-origin basis the bump reseeded the retained origin: the stroke
		// adopted a raw Y inside both caps and repaint upgraded the frame to a
		// whole-world rasterisation - one per round here, 6-17 ms each, at a
		// scale where the whole note is on screen. The camera is allowed to move
		// when the band moves; this counts the frames where it moved and the
		// band did not, through the stroke phase rather than the scroll phase.
		expect.soft(round.draw.cameraChangesWithoutBand.length, `a stroke after a scroll must not move the camera on its own at ${zoom}`).toBe(0);
	}
});

/**
 * WHAT THE LIFTED CEILING COSTS AT A SCALE NOBODY FLOORS.
 *
 * 0.1 is not the reachable minimum. Since 2026-09-13 (Alan: Fit breaks the 10%
 * clamp) Fit commits below it - `fitHandwriting` has been measured wanting
 * 0.019176 on a far-ink note - while pinch and the buttons stop at 10% from
 * above, and below it may only zoom in. Dividing the band's ceiling by
 * the scale would be indefensible if the band's COST followed 1/scale with it,
 * so this reads the cost at 0.019 and at 1.0 on the same pane and compares them.
 *
 * The equality is not a coincidence and it is worth stating as arithmetic as
 * well as measuring: `bandMargin` is `min(320/scale, max(120, 0.25 * clientH))`
 * and the counter-sized `clientH` is the pane's height DIVIDED by the scale, so
 * both live terms are (something fixed)/scale - the margin in the px the reader
 * sees is scale-free. `backingScale` multiplies by `cssScale` in turn, so the
 * canvases are sized from visual area and the scale cancels outright.
 */
it("a pinch to 0.019 settles at the ten-percent floor, and Fit's commit at 0.019 costs what the band at 1.0 costs", async () => {
	// The pinch arm this test always ran: a manual gesture from 100% still may
	// not pass 10%, so the band it reads is the 10% band.
	const pinched = await arm("bandCost", 0.019);
	expect(pinched.cssScale, `0.019 was pinched to; the manual floor is what settled`).toBe(0.1);
	// THE SCALE THE CLAIM IS ABOUT. Fit's own commit (the floor-bypass path) is
	// the only way to 0.019, so the cost is read there. Until 2026-09-13 this
	// arm could only ever read 0.1, and the equality below was measured at 10%.
	const fit = await arm("bandCost", 0.019, { fitCommit: true } as any);
	const one = await arm("bandCost", 1);
	for (const [name, r] of [["fit-0.019", fit], ["one-1.0", one]] as const) {
		// eslint-disable-next-line no-console
		console.log(`BAND ${name} cssScale=${r.cssScale} client=${r.clientWidth}x${r.clientHeight} margin=${r.margin} (visual ${r.marginVisual}) band=${JSON.stringify(r.band)} bandVisual=${JSON.stringify(r.bandVisual)} canvases=${r.canvasCount} max=${r.maxCanvasPx} px=${r.backingPx} bytes=${r.backingBytes} cap/canvas=${r.capPerCanvas}`);
	}
	// REVISED 2026-09-13: this used to assert 0.1 here, recording that Fit
	// refused 0.019 ("below-minimum" and the 10% notice). Fit now commits it.
	// REVISED 2026-09-14: cssScale is MEASURED BACK after the commit as the
	// container's rect width over its offset width. The rect is the host's
	// zoomed (or transformed) layout box snapped to 1/64 css px, and the offset
	// width is the unzoomed layout width W rounded to an integer, so the
	// measurement sits within (1 / (128 x scale) + 0.5) / W of the request -
	// under one part in W at any scale at or above 1/64 - and read as
	// 0.019000088 = (88479 / 64) / 72762 here, 4.6e-6 relative, on the zoom
	// host; the transform host has no rect snap of its own and rounds the same
	// integer. The tolerance is derived from the read's own offset width, two
	// parts in W, on both host forms: a fixed digit count was a claim about the
	// engine's grid, not about what Fit committed. The claim is still that it
	// settled BELOW the ten-percent floor at all.
	const fitOffsetWidth = (fit as { containerOffsetWidth?: number | null }).containerOffsetWidth ?? 0;
	expect(fitOffsetWidth, "the Fit read carries the container's offset width").toBeGreaterThan(0);
	expect(Math.abs(fit.cssScale - 0.019), `Fit committed 0.019 within the measurement's own bound, 2 x 0.019 / ${fitOffsetWidth}`).toBeLessThanOrEqual(2 * 0.019 / fitOffsetWidth);
	expect(fit.cssScale, "Fit settled under the manual floor").toBeLessThan(0.1);
	expect(one.cssScale).toBe(1);
	// RECORDED, NOT ASSERTED: the horizontal margin is only spent when the
	// surface is sideways scrollable, and in this arm neither scale reaches
	// that - both bands are `clientWidth` wide with hMargin 0. The two sides
	// are therefore still like for like, and the vertical term, which is the
	// one the ceiling governs, is exercised at both.
	expect(fit.hScrollable, "hMargin state must match between the two arms").toBe(one.hScrollable);
	// THE CEILING DID NOT BIND: the fraction did, which is the term that was
	// right all along. If this ever flips, the margin is a constant again and
	// the equality below stops being structural.
	expect(fit.margin, "the fraction binds, not the lifted ceiling").toBeLessThan(320 / fit.cssScale);
	// THE CLAIM. Same pane, same band in the reader's px, same allocation.
	expect(fit.bandVisual!.height).toBeCloseTo(one.bandVisual!.height, 0);
	// WIDTH IS NOT A NEAR-EQUALITY UNDER THE CANVAS. The old row asked for
	// the two visual widths to agree within 2 percent, on the cell's own note that "the horizontal
	// margin is only spent when the surface is sideways scrollable, and in this arm neither scale
	// reaches that". With the Infinite Canvas on the zoomed-out arm IS sideways scrollable, so it
	// spends the margin on both sides and the widths part company by exactly that: measured at
	// aa437ff1, 1782.48 against 1383 with a visual margin of 199.99, and 1383 + 2 x 199.99 =
	// 1782.48. The structural claim is that difference and nothing else - two margins, no more -
	// so it is asserted directly instead of being hidden inside a tolerance.
	// The residue is the scrollbar gutter, which is a fixed VISUAL width and so a different share of a
	// counter-sized client box: measured 0.50 px at aa437ff1 (399.48 against 2 x 199.99 = 399.98).
	// The bound is 1 px on a 400 px quantity, so the two margins are the claim and the gutter is the
	// only thing allowed to sit inside it.
	expect(Math.abs((fit.bandVisual!.width - one.bandVisual!.width) - 2 * (fit.marginVisual as number)),
		`the zoomed-out band is wider by its two horizontal margins, px (band delta ${(fit.bandVisual!.width - one.bandVisual!.width).toFixed(2)}, margins ${(2 * (fit.marginVisual as number)).toFixed(2)})`)
		.toBeLessThanOrEqual(1);
	// The backing follows the band, and under the canvas the band is wider by its two
	// margins, so the old "same backing as 1.0" row cannot hold either. Measured at aa437ff1:
	// 42,780,000 device px against 33,192,000, a ratio of 1.2889, and the band width ratio is
	// 1782.48 / 1383 = 1.2888 - the same number. THE CLAIM: the backing buys the band and nothing
	// more, so the two ratios agree; a backing that grew for any other reason parts from it.
	// Over the four band layers: the live tail's backing is compact, sized once,
	// and does not follow the band, so it is asserted apart below.
	const bandPx = (r: unknown) => (r as { bandLayersBackingPx: number }).bandLayersBackingPx;
	expect(bandPx(fit) / bandPx(one), "the backing grows exactly as the band does, zoomed out : 1.0")
		.toBeCloseTo(fit.bandVisual!.width / one.bandVisual!.width, 2);
	type TailRead = { w: number; h: number; grid: number | null; tileW: number; tileH: number; backing: number; fullW: number; fullH: number };
	for (const [name, r] of [["fit", fit], ["1.0", one]] as const) {
		const t = (r as unknown as { tailBacking: TailRead | null }).tailBacking;
		expect(t, `${name}: the tail's own backing is read`).toBeTruthy();
		if (t!.grid) {
			const side = Math.ceil(256 * t!.backing / t!.grid) * t!.grid;
			const tile = { w: Math.min(side, Math.floor(t!.fullW / t!.grid) * t!.grid), h: Math.min(side, Math.floor(t!.fullH / t!.grid) * t!.grid) };
			expect({ w: t!.w, h: t!.h }, `${name}: the idle tail is the 256 css px tile on the joint grid`).toEqual(tile);
		} else {
			expect({ w: t!.w, h: t!.h }, `${name}: no joint grid, the idle tail keeps the full band`).toEqual({ w: t!.fullW, h: t!.fullH });
		}
	}
	// AND IT IS INSIDE THE CEILING THAT ACTUALLY EXISTS - per canvas, which is
	// what `backingScale` trims against.
	expect(fit.maxCanvasPx).toBeLessThanOrEqual(fit.capPerCanvas);
});

/**
 * BELOW TEN PERCENT ZOOM-OUT IS LOCKED (Alan 2026-09-14): Fit may commit under
 * the floor; from there a pinch may zoom in but not back out, until a commit is
 * at ten percent again. Real gestures on the mounted overlay after Fit's own
 * commit, each read back as the settled scale.
 */
it("after Fit to 5%, a pinch in to 7% settles, a pinch out to 6% leaves 7%, and from 12% a pinch out stops at 10%", async () => {
	const r = await arm("bandCost", 0.05, { fitCommit: true, fitThenPinch: [0.07, 0.06, 0.12, 0.05] } as any);
	const steps = (r as { fitPinchSteps: { from: number; target: number; pinchScaleNow: number; cssScale: number; offsetWidth: number | null; bounceSyncs: number; bounceResized: number; bounceMoved: number }[] }).fitPinchSteps;
	note(`FITFLOOR steps=${JSON.stringify(steps)}`);
	expect(steps.map(s => s.target)).toEqual([0.07, 0.06, 0.12, 0.05]);
	const settled = [0.07, 0.07, 0.12, 0.1];
	steps.forEach((s, i) => {
		expect(s.pinchScaleNow, `step ${i} ${s.from} -> ${s.target} committed`).toBeCloseTo(settled[i]!, 9);
		// cssScale is measured back from the container's rect over its offset width.
		expect(Math.abs(s.cssScale - settled[i]!), `step ${i} ${s.from} -> ${s.target} settled cssScale ${s.cssScale}`).toBeLessThanOrEqual(2 * settled[i]! / (s.offsetWidth ?? 1));
		// A settle's ease moves the band at most once: the band is sized for the whole ease when it starts.
		expect(s.bounceSyncs, `step ${i} ${s.from} -> ${s.target}: band moves while the ease plays`).toBeLessThanOrEqual(1);
	});
	// The pinch in from Fit's 5% eases the page back from right of its edge over scroll to its left: the band is resized
	// once for that ease, and only once.
	expect(steps[0]!.bounceResized, `step 0 ${steps[0]!.from} -> ${steps[0]!.target}: band resizes while the ease plays (${JSON.stringify(steps.map(s => [s.bounceResized, s.bounceMoved]))})`).toBe(1);
});

/**
 * THE SAME FRACTIONAL ARM AT ALAN'S EXTENT. The stabilizer's cap is absolute
 * (1/1024 displayed CSS px) and the arm above scrolls to about 1200 visual px.
 * Alan's recorded note extent is 114822 note px - 11482 visual px at 10% - and
 * float32 rounding at that magnitude is 2^-10 px, the cap itself. These arms
 * shift ink, extent and scroll together to 11482 and twice it, and read the raw
 * origin the stabilizer is handed rather than only the redraws it causes.
 *
 * Host CSS is the installed app's stylesheet when HW_DRAW_HOST_CSS names it,
 * with the workspace-leaf shell, because `ownedColumnLayoutLeft` answers from
 * computed styles and X has no stabilizer when it answers null.
 */
const FAR_ALAN = 11482;
const farHost = () => !!process.env.HW_DRAW_HOST_CSS;
function logFar(name: string, r: any): void {
	note(`LAGFAR ${name} stabilizer=${r.stabilizerPresent} host=${farHost()} hostProof=${JSON.stringify(r.hostProof)} reached=${JSON.stringify(r.farReached)} reflow=${JSON.stringify(r.reflow)}`);
	for (const round of r.rounds) {
		const c = round.scroll.camera;
		note(`LAGFAR ${name} round=${round.round} cameraOnly=${round.scroll.cameraChangesWithoutBand.length} full=${round.scroll.full} bandMoved=${round.scroll.bandMoved} ` +
			`syncs=${c.syncs} pairs=${c.pairs} maxPrior=${c.maxPriorDeltaVisual} overCapPrior=${c.overCapPrior}/${c.withPrior} maxFrame=${c.maxFrameDeltaVisual} overCapFrame=${c.overCapFrame}/${c.pairs} ` +
			`yChanges=${c.cameraYChangesSameBasis} xChanges=${c.cameraXChangesSameBasis} maxX=${c.maxXDeltaVisual} errOverlayTop=${c.maxOverlayTopErr} errDocTop=${c.maxDocTopErr} ` +
			`errOverlayLeft=${c.maxOverlayLeftErr} errContentLeft=${c.maxContentLeftErr} ownedNull=${JSON.stringify(round.scroll.ownedColumn)} at=${JSON.stringify(c.at)} worst=${JSON.stringify(c.worst)} ` +
			`gapMax=${round.scroll.gapMax} draw.full=${round.draw.full} draw.cameraOnly=${round.draw.cameraChangesWithoutBand.length} draw.camera=${JSON.stringify({ ...round.draw.camera, worst: undefined })}`);
	}
}

/**
 * S1: THE FAR FIXTURE ITSELF, AS AN ORDINARY TEST.
 *
 * Written while the far arms above were `fails`, because `it.fails` passes when
 * ANYTHING in the arm throws: under it, ink that stopped reaching the canvas, a
 * scroll write clamped short of the extent or a save that stopped round-tripping
 * would all have read as "still failing, as expected". The arms are ordinary
 * tests again, but this one stays: it runs the same far fixture at the same zoom
 * and offset and asserts ONLY the reach, the stroke, the pixels and the store,
 * making NO camera assertion, so a future camera regression that puts those arms
 * back under a marker cannot take the ink path's coverage down with it.
 */
it("the far extent fixture still draws, reaches and saves: 0.15/17223", async () => {
	const far = Math.round(114822 * .15);
	const r = await arm("lagFlingDense", .15, { axis: "both", infiniteCanvas: true, routed: true, far: true, farVisual: far, rapid: true, frames: 30, distance: 39, pixels: true, host: farHost() });
	checkArmPatches(`far-live-${far}`, r);
	if (farHost()) expect(r.hostProof.shell && r.hostProof.appCssVar !== "", `host CSS in force: ${JSON.stringify(r.hostProof)}`).toBe(true);
	expect(Math.abs(r.farReached.visualTop - far), `scrollTop reached ${far} visual px`).toBeLessThan(2);
	expect(Math.abs(r.farReached.visualLeft - far), `scrollLeft reached ${far} visual px`).toBeLessThan(2);
	expect(r.quality.originalUnchanged, "the ink that was there is untouched").toBe(true);
	expect(r.quality.roundtrip, "every stroke survives the save round trip").toBe(true);
	expect(r.quality.savedCount, "the store holds every live stroke").toBe(r.strokes);
	for (const round of r.rounds) {
		expect(round.added, "a routed stroke committed in every round").toBe(1);
		expect(round.committedPixels, "new ink reaches the committed canvas").toBeGreaterThan(0);
		// The probe is intercepting: a zero from a dead patch is silence.
		expect(round.scroll.camera.syncs, "adopted camera syncs recorded").toBeGreaterThan(10);
		expect(round.scroll.camera.pairs, "same-basis pairs recorded").toBeGreaterThan(5);
		if (r.stabilizerPresent) expect(round.scroll.camera.withPrior, "raw compared against a retained origin").toBeGreaterThan(0);
	}
}, 180_000);

it.each([
	{ zoom: .1, far: FAR_ALAN, infiniteCanvas: true },
	{ zoom: .1, far: FAR_ALAN * 2, infiniteCanvas: true },
	{ zoom: .15, far: FAR_ALAN, infiniteCanvas: true },
	// Alan's 114822 NOTE px at 15%: the same layout magnitude as 11482 at 10%.
	{ zoom: .15, far: Math.round(114822 * .15), infiniteCanvas: true },
	{ zoom: .15, far: FAR_ALAN * 2, infiniteCanvas: true },
	// TWICE ALAN'S EXTENT, so magnitude independence is shown and not assumed:
	// the float32 step doubles again above 32768 visual px, and a fix that
	// removed the magnitude from the measurement does not notice.
	{ zoom: .15, far: FAR_ALAN * 4, infiniteCanvas: true },
	// The canvas-off rows that stood here are retired. With the Infinite Canvas off the
	// product now ignores every pinch phase, so the note stays at 100 percent and there is no
	// zoomed canvas-off state left to measure. See RETIRED-CELLS.md.
])("far extent fractional scroll/draw keeps a stationary band cheap: $zoom/$far/IC=$infiniteCanvas", async ({ zoom, far, infiniteCanvas }) => {
	await farExtentArm(zoom, far, infiniteCanvas, false);
}, 180_000);

/**
 * THE SAME ARM AT A SCALE ONLY FIT REACHES. Since 2026-09-13 Fit commits below
 * ten percent, so 5% at Alan's extent is a state a user can actually be in.
 *
 * ENV-GATED, and why: measured 2026-09-13 on 9b25f409, both arms EXCEED the
 * 180 s budget the ten-percent arms run in and neither completes its three
 * rounds - round 1 of 0.05/5741 recorded cameraOnly=0 and full=0 (the scroll
 * itself stays cheap) with gapMax 3309.9 ms, on the same headless SOFTWARE
 * compositor L3 is qualifying for G1. A timing-out arm asserts nothing, so it
 * does not belong in the gate until that cost is understood; set
 * HW_FIT_SCALE_ARMS=1 to run it. The run is recorded with the lane's evidence.
 */
it.skipIf(!process.env.HW_FIT_SCALE_ARMS).each([
	{ zoom: .05, far: Math.round(114822 * .05), infiniteCanvas: true },
	{ zoom: .05, far: FAR_ALAN, infiniteCanvas: true },
])("fit-scale far extent fractional scroll/draw: $zoom/$far/IC=$infiniteCanvas", async ({ zoom, far, infiniteCanvas }) => {
	await farExtentArm(zoom, far, infiniteCanvas, true);
}, 600_000);

async function farExtentArm(zoom: number, far: number, infiniteCanvas: boolean, fitCommit: boolean): Promise<void> {
	const r = await arm("lagFlingDense", zoom, { axis: "both", infiniteCanvas, routed: true, far: true, farVisual: far, rapid: true, frames: 30, distance: 39, pixels: true, host: farHost(), fitCommit });
	checkArmPatches(`far-${zoom}-${far}-${infiniteCanvas}`, r);
	// The host stylesheet is what U2 is read under; prove it was in force.
	if (farHost()) expect(r.hostProof.shell && r.hostProof.appCssVar !== "", `host CSS in force: ${JSON.stringify(r.hostProof)}`).toBe(true);
	logFar(`${zoom}/${far}/IC=${infiniteCanvas}`, r);
	// THE ARM IS FAR: the scroll write was not clamped short of the extent.
	expect(Math.abs(r.farReached.visualTop - far), `scrollTop reached ${far} visual px`).toBeLessThan(2);
	expect(Math.abs(r.farReached.visualLeft - far), `scrollLeft reached ${far} visual px`).toBeLessThan(2);
	expect(r.quality.originalUnchanged).toBe(true);
	expect(r.quality.roundtrip).toBe(true);
	expect(r.quality.savedCount).toBe(r.strokes);
	// TWO OPERANDS, ONE NOISY. This reads the ink origin against the shipped
	// contentDOM-rect formula, so it can never be tighter than THAT rect's own
	// float32 rounding, which doubles with its visual magnitude. A flat 0.002
	// was unreachable past 16384 visual px (measured 0.00247 at 22964 and
	// 0.00342 at 45928) and would have failed a correct fix. The quantity under
	// test is the ink following a real layout change; the bar is the control's
	// noise.
	const reflowBar = 2.5e-5 + 2 * ulp32(far);
	for (const sample of r.reflow) expect.soft(sample.error, `ink follows real Y layout changes (bar ${reflowBar} at ${far} visual px)`).toBeLessThanOrEqual(reflowBar);
	for (const round of r.rounds) {
		expect(round.added, "a routed stroke committed in every round").toBe(1);
		expect(round.committedPixels, "new ink reaches the committed canvas").toBeGreaterThan(0);
		const first = round.scroll.input[0].before, last = round.scroll.input.at(-1).after;
		expect((last[0] - first[0]) * zoom, "the finger reached the tested X range").toBeGreaterThan(25);
		expect((last[1] - first[1]) * zoom, "the finger reached the tested Y range").toBeGreaterThan(25);
		// THE PROBE IS LIVE: adopted syncs were read, in one basis, pairwise.
		expect(round.scroll.camera.syncs, "adopted camera syncs recorded").toBeGreaterThan(10);
		expect(round.scroll.camera.pairs, "same-basis pairs recorded").toBeGreaterThan(5);
		if (r.stabilizerPresent) expect(round.scroll.camera.withPrior, "raw compared against a retained origin").toBeGreaterThan(0);
		expect.soft(round.scroll.cameraChangesWithoutBand.length, "scrolling alone must not manufacture camera motion at the far extent").toBe(0);
		expect.soft(round.scroll.full, "full redraws follow actual band moves").toBe(round.scroll.bandMoved);
		// THE RAW DELTA, NOT ONLY THE COUNT. A redraw count depends on which
		// prior the stabilizer happened to retain - .10/22964 counted 9/0/0 on
		// 6dee0d06 while the raw error was the same in all three rounds - so a
		// count alone can go green by luck. This is the measurement the cap acts
		// on: the largest per-frame move of the raw origin in one raster basis,
		// in displayed CSS px. The production cap is untouched; a quarter of it
		// is the margin this fixture demands.
		expect.soft(round.scroll.camera.maxFrameDeltaVisual, `raw origin delta per frame at ${zoom}/${far}`).toBeLessThanOrEqual(RAW_DELTA_MARGIN);
		// The same pen-down regression at the far extent, where it was first
		// seen. Parked with its arm; green under the fix at both extents.
		expect.soft(round.draw.cameraChangesWithoutBand.length, `a stroke after a scroll must not move the camera on its own at ${zoom}/${far}`).toBe(0);
	}
	farRawDeltas.push({ arm: `${zoom}/${far}/IC=${infiniteCanvas}`,
		maxFrame: Math.max(...r.rounds.map((x: any) => x.scroll.camera.maxFrameDeltaVisual)),
		maxPrior: Math.max(...r.rounds.map((x: any) => x.scroll.camera.maxPriorDeltaVisual)),
	});
}

/**
 * Q3: THE DELTA MUST NOT FOLLOW THE EXTENT. Float32 rounding of a rect grows
 * with the rect's VISUAL magnitude - note position times zoom - and its step
 * doubles at every power of two, so an arm can pass at one extent and fail at
 * the next. A fix that took the magnitude out of the measurement reads the same
 * delta at 11482, 17223, 22964 and 45928; a lucky pass still grows with them.
 */
it("the raw origin delta does not scale with the extent", () => {
	// eslint-disable-next-line no-console
	console.log("LAGFAR deltas " + JSON.stringify(farRawDeltas));
	expect(farRawDeltas.length, "far arms recorded").toBeGreaterThanOrEqual(4);
	const all = farRawDeltas.map(d => d.maxFrame);
	// THE REQUIREMENT IS THE ABSOLUTE ONE. A delta inside a quarter of the cap
	// is a delta the stabilizer holds at any extent, whatever its neighbours read.
	expect.soft(Math.max(...all), `largest raw delta across extents: ${JSON.stringify(farRawDeltas)}`).toBeLessThanOrEqual(RAW_DELTA_MARGIN);
	// AND THE SHAPE, within one zoom, where the arms differ in extent alone.
	// Comparing across zooms compares two different visual magnitudes, which is
	// the very thing being tested for. The ratio is only read while the values
	// are big enough to have a shape: once the magnitude term is gone the arms
	// sit in the last bits of a float, where 2.5e-5 against 6e-5 is a ratio of
	// 2.4 and means nothing at all - a correct fix must not be red for that.
	const FLOOR = RAW_DELTA_MARGIN / 4;
	const byZoom = new Map<string, number[]>();
	for (const d of farRawDeltas) {
		const zoom = d.arm.split("/")[0]!;
		byZoom.set(zoom, [...(byZoom.get(zoom) ?? []), d.maxFrame]);
	}
	for (const [zoom, deltas] of byZoom) {
		if (deltas.length < 2) continue;
		const hi = Math.max(...deltas);
		if (hi <= FLOOR) continue;
		const lo = Math.min(...deltas);
		expect.soft(hi / Math.max(lo, Number.MIN_VALUE), `extent scaling at zoom ${zoom}: ${JSON.stringify(deltas)} of ${JSON.stringify(farRawDeltas)}`).toBeLessThan(2);
	}
});

/**
 * S3: THE DRAW/ZOOM CONTRACT, IN THE ORDINARY GATE, WITHOUT A WALL TIME.
 *
 * The six-cycle far loop below is a MEASUREMENT of the compositor and stays
 * opt-in; what must not leave the gate with it is the contract that loop also
 * happens to assert - that a pinch settles where it was aimed, that a stroke
 * drawn after each pinch commits, that the stored count only grows, and that
 * what is stored still round-trips through the sidecar. Two cycles at the near
 * offset exercise all four in a few seconds, and assert no time at all.
 */
it("draw, pinch, draw again: the loop keeps ink and scale", async () => {
	const r = await arm("lagFlingDense", .1, { axis: "both", infiniteCanvas: true, routed: true, far: true, farVisual: 1200, rapid: true, frames: 30, distance: 39, pixels: true, zoomCycles: 2, host: farHost() });
	checkArmPatches("zoom-liveness-1200", r);
	expect(r.zoomLoop.length, "two draw/zoom/draw/zoom cycles").toBe(4);
	let stored = r.zoomLoop[0].stored - 1;
	for (const c of r.zoomLoop) {
		expect(c.zoom.settled, `cycle ${c.cycle} pinch settled at its target`).toBeCloseTo(c.zoom.to, 2);
		expect(c.added, `cycle ${c.cycle} stroke committed`).toBe(1);
		expect(c.stored, `cycle ${c.cycle} stored count`).toBe(stored + 1);
		stored = c.stored;
		expect(c.roundtrip, `cycle ${c.cycle} saved roundtrip`).toBe(true);
	}
}, 180_000);

/**
 * G1: DRAW -> ZOOM -> DRAW -> ZOOM between 10% and 15% at Alan's extent. Six
 * full cycles (twelve draw+pinch pairs) after the same three scroll/draw
 * rounds. Recorded per half-cycle: full redraws, reallocations, repaint ms,
 * frame gaps, repaints in the late half of the settle window, stored strokes
 * and the saved roundtrip. Liveness is asserted; cost is printed.
 */
zoomLoopIt.each([
	{ far: FAR_ALAN },
	// NEAR CONTROL: the same loop at the 1200-px offset the fractional arm uses,
	// so a cost that belongs to the extent is told apart from one that does not.
	{ far: 1200 },
])("far extent draw/zoom loop between 10% and 15% is measured: $far", async ({ far }) => {
	const r = await arm("lagFlingDense", .1, { axis: "both", infiniteCanvas: true, routed: true, far: true, farVisual: far, rapid: true, frames: 30, distance: 39, pixels: true, zoomCycles: 6, host: farHost() });
	checkArmPatches(`zoom-loop-${far}`, r);
	logFar(`zoom-loop-${far}`, r);
	expect(r.zoomLoop.length, "six draw/zoom/draw/zoom cycles").toBe(12);
	let stored = r.zoomLoop[0].stored - 1;
	for (const c of r.zoomLoop) {
		note(`LAGZOOM cycle=${c.cycle} scaleAtDraw=${c.scaleAtDraw} added=${c.added} stored=${c.stored} roundtrip=${c.roundtrip} ` +
			`roundtripMs=${c.roundtripMs} backingBytes=${c.backingBytes} draw{work=${JSON.stringify(c.draw.drawWork)} gaps=${JSON.stringify(c.draw.gaps)} full=${c.draw.full} repaints=${c.draw.repaints} reallocs=${c.draw.reallocs} paintMs=${c.draw.paintMs} commitMs=${c.draw.commitMs} gapMax=${c.draw.gapMax} cameraOnly=${c.draw.cameraChangesWithoutBand.length}} ` +
			`zoom{${c.zoom.from}->${c.zoom.to} settled=${c.zoom.settled} full=${c.zoom.full} repaints=${c.zoom.repaints} reallocs=${c.zoom.reallocs} paintMs=${c.zoom.paintMs} paintMsMax=${c.zoom.paintMsMax} ` +
			`settleGaps=${JSON.stringify(c.zoom.settleGaps)} settleWork=${JSON.stringify(c.zoom.settleWork)} work=${JSON.stringify(c.zoom.work)} gapMax=${c.zoom.gapMax} gapsOver32=${c.zoom.gapsOver32} late=${c.zoom.lateRepaints}/${c.zoom.lateFull}/${c.zoom.lateMs}ms handleResizes=${c.zoom.handleResizes} bandMoved=${c.zoom.bandMoved} bandResized=${c.zoom.bandResized} ` +
			`visualTop=${Math.round(c.zoom.visualTop)} cameraOnly=${c.zoom.cameraChangesWithoutBand.length} camSyncs=${c.zoom.camera.syncs} overCapPrior=${c.zoom.camera.overCapPrior}}`);
		// LIVENESS: the pinch took, the stroke landed, the store kept it.
		expect(c.zoom.settled, `cycle ${c.cycle} pinch settled at its target`).toBeCloseTo(c.zoom.to, 2);
		expect(c.added, `cycle ${c.cycle} stroke committed`).toBe(1);
		expect(c.stored, `cycle ${c.cycle} stored count`).toBe(stored + 1);
		stored = c.stored;
		expect(c.roundtrip, `cycle ${c.cycle} saved roundtrip`).toBe(true);
		expect(c.zoom.visualTop, `cycle ${c.cycle} still at the tested offset`).toBeGreaterThan(far * .9);
		note(`LAGZOOM cycle=${c.cycle} longFrames draw=${JSON.stringify(c.drawLongFrames)} zoom=${JSON.stringify(c.zoomLongFrames)}`);
		// THE DEFECT G1 FOUND, as a frame and not a sum. Measured on 6dee0d06 at
		// 11482 visual px: after every pinch commit, and on the next stroke, one
		// or two frames of 400-1100 ms with no time inside any patched plugin
		// method and none in script per Long Animation Frame timing; a Chromium
		// trace puts it in SoftwareRenderer::DoDrawQuad on the display
		// compositor, five quads in a render pass that first appears at the
		// first zoom. The same loop at 1200 px holds 16 ms frames after a
		// ~60 ms commit frame. 250 ms is a stall on any box, not a budget.
		// R4: RECORDED BY DEFAULT, ASSERTED ON REQUEST. The 400-1100 ms frames
		// this found are on headless Chromium's SOFTWARE compositor, with no
		// plugin method time in them; whether they exist on a GPU compositor or
		// on the device is a separate lane's measurement. A wall time on a
		// shared box must not decide a gate, so it asserts only under
		// HW_LAG_WALLTIME=1 and is printed either way.
		const longest = Math.max(...c.zoom.settleGaps, ...c.draw.gaps);
		// eslint-disable-next-line no-console
		console.log(`LAGZOOM cycle=${c.cycle} longestFrameMs=${longest}`);
		if (process.env.HW_LAG_WALLTIME === "1") {
			expect.soft(longest, `cycle ${c.cycle} longest frame after the zoom commit or the next stroke`).toBeLessThan(250);
		}
	}
}, 300_000);
