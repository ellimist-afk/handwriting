/**
 * The document anchor ladder's surface checks, in real Chromium.
 *
 * WHAT EACH ONE IS PROTECTING, in one line: the anchor must not write inside
 * `contentDOM` while the reader scrolls, must not let CodeMirror's
 * scroll anchoring move a restored far scroll when it installs, and must
 * not add scroll range of its own when it grows. Each has the plant
 * the design names, and the plant is asserted to FAIL the same assertion the
 * shipped shape passes - a green here with a green plant would mean nothing.
 *
 * The lag check is the existing `LagAtLowZoom` arms and `ContinuousPinch`, which are run
 * unchanged and are not duplicated here.
 */

import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

/** The camera stabilizer's own cap, in displayed CSS px. */
const CAP = 1 / 1024;

let browser: Browser, script: string;
const report: Record<string, unknown> = {};

beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./documentAnchorPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
	await browser?.close();
	if (process.env.HW_ANCHOR_REPORT) writeFileSync(process.env.HW_ANCHOR_REPORT, JSON.stringify(report, null, 1));
});

async function call2(fn: string, arg?: unknown) {
	const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
	try {
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(e.message));
		await page.setContent('<!doctype html><body style="margin:0"></body>');
		if (process.env.HW_DRAW_HOST_CSS) await page.addStyleTag({ content: readFileSync(process.env.HW_DRAW_HOST_CSS, "utf8") });
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addScriptTag({ content: script });
		const r = await page.evaluate(a => (window as any).documentAnchorE2[a.fn](a.arg), { fn, arg });
		expect(errors, `page errors in ${fn}(${JSON.stringify(arg)}): ${errors.join(" | ")}`).toEqual([]);
		report[`${fn}:${JSON.stringify(arg ?? null)}`] = r;
		return r as any;
	} finally { await page.close(); }
}

async function call(fn: string, arg?: unknown) {
	const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
	try {
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(e.message));
		await page.setContent('<!doctype html><body style="margin:0"></body>');
		if (process.env.HW_DRAW_HOST_CSS) await page.addStyleTag({ content: readFileSync(process.env.HW_DRAW_HOST_CSS, "utf8") });
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addScriptTag({ content: script });
		const r = await page.evaluate(a => (window as any).documentAnchor[a.fn](a.arg), { fn, arg });
		expect(errors, `page errors in ${fn}(${JSON.stringify(arg)}): ${errors.join(" | ")}`).toEqual([]);
		report[`${fn}:${JSON.stringify(arg ?? null)}`] = r;
		return r as any;
	} finally { await page.close(); }
}

it("teardown: removing the overlay removes the anchor, and a remount leaves exactly one", async () => {
	const shipped = await call("runTeardown");
	const stale = await call("runTeardown", "staleBeforeRemount");
	const plant = await call("runTeardown", "staleAfterRemount");
	// eslint-disable-next-line no-console
	console.log("TEARDOWN " + JSON.stringify({ shipped, stale, plant }));
	// TWO HALVES, ONE GUARD EACH. `afterTeardown 0` is the only line that fails
	// when the overlay's teardown stops calling unmountDocumentAnchor, and
	// `stale.afterRemount 1` is the only line that fails when mount stops
	// clearing a wrapper it did not create. `afterRemount 1` alone passes with
	// either half missing, so neither expect below may be dropped.
	expect(shipped.mounted, "the anchor was mounted before teardown").toBe(1);
	expect(shipped.afterTeardown, "teardown removed it").toBe(0);
	expect(shipped.liveAfterTeardown, "the module forgot the ladder on teardown").toBe(false);
	expect(shipped.remountedOverlay, "the overlay came back").toBe(true);
	expect(shipped.afterRemount, "remount leaves exactly one").toBe(1);
	expect(shipped.liveAfterRemount).toBe(true);
	expect(stale.afterRemount, "a wrapper left by an earlier load is cleared on mount").toBe(1);
	// The count can read more than one, so the ones above are not vacuous.
	expect(plant.afterRemount, "a wrapper planted after the mount is counted").toBe(2);
}, 180_000);

it("scroll: scrolling across rung boundaries writes nothing inside contentDOM", async () => {
	const live = await call("runScroll", false);
	const plant = await call("runScroll", true);
	// eslint-disable-next-line no-console
	console.log(`scroll shipped ${JSON.stringify({ ...live, steps: undefined })}`);
	// eslint-disable-next-line no-console
	console.log(`scroll plant   ${JSON.stringify({ ...plant, steps: undefined })}`);

	// THE ARM DID THE THING IT CLAIMS: several rung boundaries were crossed, so
	// a zero mutation count is not the zero of a scroll that never switched.
	expect(live.switches, "the scroll crossed rung boundaries").toBeGreaterThanOrEqual(3);
	expect(live.ladderLen, "the ladder covers the grown surface").toBeGreaterThan(20);

	// THE CLAIM.
	expect(live.contentMutations, `nothing may be written inside contentDOM while scrolling: ${JSON.stringify(live.mutationSample)}`).toBe(0);
	// THE PLANT: the ruled-out mechanism, and the observer sees it.
	expect(plant.contentMutations, "the style.top plant must be visible to the same observer").toBeGreaterThan(0);

	// The camera followed the scroll exactly across every switch.
	expect(live.maxCameraError, `camera continuity across rung switches: ${JSON.stringify(live.worstJump)}`).toBeLessThanOrEqual(CAP);
	// A SWITCH COSTS NOTHING, attributed rather than assumed: a step that
	// changed rung must repaint no more than a step that did not. Both counts
	// are real (the scroll repaints either way), so this is a comparison and
	// not a zero.
	expect(live.maxRepaintsOnSwitch, `repaints on a switch step vs a holding step: ${JSON.stringify({ onSwitch: live.repaintsOnSwitchSteps, onHold: live.repaintsOnHoldSteps })}`)
		.toBeLessThanOrEqual(live.maxRepaintsOnHold);
}, 240_000);

it("install: installing the anchor leaves a restored far scroll where it was", async () => {
	const control = await call("runInstall", "control");
	const live = await call("runInstall", "shipped");
	const plant = await call("runInstall", "plant");
	// CALIBRATION for the plant: 1 px may simply be below the resolution of what
	// CodeMirror's own clamp does to a restored scroll, and a plant that cannot
	// fire proves nothing. 200 px says whether height in this position moves the
	// surface at all.
	const plantBig = await call("runInstall", "plantBig");
	for (const [name, r] of [["control", control], ["shipped", live], ["plant", plant], ["plantBig", plantBig]] as const) {
		// eslint-disable-next-line no-console
		console.log(`install ${name} ${JSON.stringify(r)}`);
	}

	expect(live.ladderLen, "the ladder is installed").toBeGreaterThan(0);
	expect(live.wrapperHeight, "the widget adds no height").toBe(0);
	expect(live.wrapperOverflow, "the wrapper clips, so rungs add no scroll range").toBe("hidden");
	expect(control.ladderLen, "the control has no anchor at all").toBe(0);

	// THE CLAIM, AGAINST THE CONTROL AND NOT AGAINST THE TARGET. CodeMirror
	// clamps a scroll restored before its first measure to whatever scrollHeight
	// it has rendered by then, with or without any widget - the control measures
	// that - so what the anchor must add is nothing.
	expect(live.afterMount, `scrollTop after the install, vs the control's ${control.afterMount}`).toBe(control.afterMount);
	expect(live.afterMeasure, "scrollTop after the first measure").toBe(control.afterMeasure);
	expect(live.movedOnMeasure, "the first measure must not move the surface").toBe(0);

	// THE PLANT: CodeMirror's default unknown height. Recorded either way -
	// The reason for the guard is CodeMirror's source (an unknown height
	// feeds the height map until measured), and this arm says what it measured
	// rather than pretending to have proven the mechanism.
	// eslint-disable-next-line no-console
	console.log(`install PLANT height 1px: afterMount ${plant.afterMount} vs control ${control.afterMount} (delta ${plant.afterMount - control.afterMount}); ` +
		`height 200px: afterMount ${plantBig.afterMount} (delta ${plantBig.afterMount - control.afterMount})`);
	expect(plant.mode, "the plant really ran").toBe("plant");
	expect(plantBig.mode, "the calibration really ran").toBe("plantBig");
}, 240_000);

it("growth: growing the ladder moves neither the scroll nor the scroll range", async () => {
	const live = await call("runExtent");
	const plant = await call("runExtent", "noOverflowHidden");
	// eslint-disable-next-line no-console
	console.log(`growth shipped ${JSON.stringify(live)}`);
	// eslint-disable-next-line no-console
	console.log(`growth plant   ${JSON.stringify(plant)}`);

	// THE ARM DID THE THING IT CLAIMS: the extent really grew and rungs really
	// were appended.
	expect(live.appended, "rungs appended when the spacer grew").toBeGreaterThan(10);
	// THE CLAIM.
	expect(live.scrollMoved, "the surface must not move when the ladder grows").toBe(0);
	expect(live.cameraMoved, "the camera must not jump when the ladder grows").toBeLessThanOrEqual(CAP);
	expect(live.scrollHeightOverSpacer, "the ladder adds no scroll range beyond the spacer").toBeLessThanOrEqual(0);
	// THE PLANT: the same ladder without `overflow: hidden`. The design says
	// to record whichever way this goes and keep the guard either way.
	// eslint-disable-next-line no-console
	console.log(`growth PLANT no-overflow-hidden: overflow=${plant.plantOverflow} rungs=${plant.plantRungs} scrollHeightOverSpacer=${plant.scrollHeightOverSpacer} (shipped ${live.scrollHeightOverSpacer})`);
	expect(plant.plantOverflow, "the plant really dropped the clip").not.toBe("hidden");
	expect(plant.plantRungs, "the plant ladder really exists").toBeGreaterThan(10);
}, 240_000);

it("parity: the document top the ladder implies matches anchorTop within the amended bar", async () => {
	const near = await call("runParity", 0);
	const far = await call("runParity", 20000);
	for (const [name, r] of [["near", near], ["far", far]] as const) {
		// eslint-disable-next-line no-console
		console.log(`parity ${name} maxError=${r.maxError} bar=${r.bar} minPlantError=${r.minPlantError} cssScale=${r.cssScale} ladderLen=${r.ladderLen} samples=${JSON.stringify(r.samples.slice(0, 2))}`);
		expect(r.samples.length, `${name} produced samples`).toBeGreaterThan(2);
		// THE CLAIM, against the per-extent bar and not a flat 2.5e-5:
		// anchorTop reads the noisy rect E exists to remove, so the two MUST
		// differ by that rect's own rounding.
		expect(r.maxError, `${name} parity against the amended bar`).toBeLessThanOrEqual(r.bar);
		// THE PLANT: the rung's offset off by one integer layout px must be far
		// outside the bar, or the bar is loose enough to hide a real mistake.
		expect(r.minPlantError, `${name} plant (T off by one) must exceed the bar`).toBeGreaterThan(r.bar * 10);
	}
}, 240_000);

it("reflow: reflow above the content moves the anchor with it", async () => {
	const r = await call("runReflow");
	// eslint-disable-next-line no-console
	console.log(`reflow ${JSON.stringify(r)}`);
	// THE WRAPPER IS WHERE THE PLACEMENT CHECK SAYS, checked by the same DOM properties the
	// production path checks every sync.
	expect(r.live, "wrapper is the in-flow sibling immediately before contentDOM").toEqual({ isConnected: true, nextIsContent: true, sameParent: true });
	// THE CLAIM: 1 layout px of growth above the content moves the rung by
	// 1 x cssScale, so the camera sees the reflow and adopts it. A scroller-
	// anchored probe reads 0 here - that is what this plant caught in the first measurement.
	expect(r.rungMoved, `rung must move by ${r.expected}`).toBeCloseTo(r.expected, 2);
	expect(r.contentMoved, "contentDOM moves by the same amount").toBeCloseTo(r.expected, 2);
	expect(r.docTopMoved, "the document top the camera used moves with it").toBeCloseTo(r.expected, 2);
	expect(r.rungRestored, "and comes back when the growth is taken back").toBeLessThan(0.01);
}, 240_000);

it("placement: static position, a pinned cross axis, and a gate that refuses what cannot be pinned", async () => {
	const above = await call2("runE2", "above");
	const aboveTop0 = await call2("runE2", "aboveTop0");
	const center = await call2("runE2", "center");
	const unpinnable = await call2("runE2", "unpinnable");
	for (const [n, r] of [["above", above], ["aboveTop0", aboveTop0], ["center", center], ["unpinnable", unpinnable]] as const) {
		// eslint-disable-next-line no-console
		console.log(`placement ${n} ${JSON.stringify(r)}`);
	}

	// Block above: with a 37px block above the content, the static position and the
	// scroller's origin are no longer the same point - which is what makes this
	// arm able to tell `auto` from `top: 0` at all.
	expect(above.ladderUsed, "auto offsets keep the ladder in service").toBe(true);
	expect(above.parity, "auto offsets sit exactly on the document top").toBe(0);
	expect(aboveTop0.parity, "top:0 resolves against the scroller and must NOT be 0").toBeGreaterThan(0);

	// Centred container: the wrapper's own align-self pins the cross axis whatever the container aligns to.
	expect(center.containerAlignItems, "the arm really centred the container").toBe("center");
	expect(center.wrapperAlignSelf, "the wrapper's align-self is in force").toBe("flex-start");
	expect(center.ladderUsed, "the ladder is used under align-items:center").toBe(true);
	expect(center.parity, "and it still sits on the document top").toBe(0);

	// Unpinnable: what the wrapper's align-self cannot pin, the gate must refuse - and everything falls
	// back TOGETHER, which is the point of unmounting rather than flagging.
	expect(unpinnable.refusalsAdded, "the gate fired exactly once").toBe(1);
	expect(unpinnable.ladderUsed, "the ladder is out of service").toBe(false);
	expect(unpinnable.cameraEqualsShipped, "the camera is the shipped formula, exactly").toBe(true);
	expect(unpinnable.refusal, "the refusal carries both values and the bar").toMatchObject({
		reason: expect.any(String), implied: expect.any(Number), shipped: expect.any(Number), bar: expect.any(Number), delta: expect.any(Number),
	});
	expect(unpinnable.refusal.delta, "and the delta is what broke the bar").toBeGreaterThan(unpinnable.refusal.bar);
}, 300_000);

it("COST: what the ladder costs per sync, present vs absent, at 8 and 34 rungs", async () => {
	const arms: any[] = [];
	for (const surface of [16128, 60000]) for (const noAnchor of [false, true]) {
		arms.push(await call("runScroll", { plant: false, surface, noAnchor }));
	}
	for (const r of arms) {
		// eslint-disable-next-line no-console
		console.log(`COST surface=${r.surface} anchor=${!r.noAnchor} rungs=${r.ladderLen} syncs=${r.syncs} msPerSync=${r.msPerSync} rectsPerSync=${r.rectReadsPerSync} repaints=${r.repaints} bandMoves=${r.bandMoves}`);
	}
	expect(arms.filter(r => !r.noAnchor).every(r => r.ladderLen > 0), "the anchor arms really have a ladder").toBe(true);
	expect(arms.filter(r => r.noAnchor).every(r => r.ladderLen === 0), "the control arms really have none").toBe(true);
}, 600_000);
