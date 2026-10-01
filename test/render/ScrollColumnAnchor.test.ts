/**
 * Reproduction for Alan's scroll snap-back with Readable line length on.
 *
 * Alan, Throwaway, every note: ink moves with the scroll and then snaps back,
 * not left-anchored.
 *
 * THE MECHANISM UNDER TEST. Readable line length caps `.cm-sizer` at
 * `--file-line-width` and centres it with auto margins. Anything that changes
 * the SCROLLER's client width therefore moves the text column sideways by half
 * that change - and a vertical scrollbar appearing as CodeMirror's height
 * estimate settles during a scroll does exactly that. No `.cm-line` changes
 * size (they are capped), and `.cm-editor`'s box does not change, so neither
 * `originLineObserver` nor `handleResize`'s origin compare is triggered:
 * InkOverlay's own field comment says "A ResizeObserver sees size, not
 * position, so it still misses a column that moves at CONSTANT line width".
 * Committed ink then keeps the old column left until some later sync corrects
 * it, which is move-then-snap, sideways.
 *
 * THE ASSERTION IS PHYSICAL: note-space x = 0 must render at the column's left
 * edge, every frame. Not one internal field compared against another - where
 * the pixels actually are, against where the text actually is.
 *
 * The readable-line-width rules are pasted VERBATIM from the app.css extracted
 * for candidate-48170426. An earlier version of this file emulated them by
 * centring `.cm-content`, which is not what Obsidian does, and so measured a
 * geometry that was its author's rather than the product's.
 *
 * SCAFFOLDING, DECLARED: the page half hand-builds the
 * `.cm-sizer > .cm-contentContainer` wrapper that Obsidian adds and vanilla
 * CodeMirror does not. See that file's header. A red here is evidence about
 * the mechanism, not proof about Obsidian's own sizer.
 */

import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import css from "../../styles.css?raw";

/** A displacement smaller than this is measurement noise. Matches the page. */
const VISIBLE_PX = 0.5;

/**
 * Obsidian's Readable line length, VERBATIM.
 *
 * From the CSS extracted from the running app for the 1.4.18 candidate 48170426: `--file-line-width` at
 * :2240 and the four `is-readable-line-width` rules at :3546-3559.
 *
 * The shape that matters: the auto margins are on `.cm-sizer`. `.cm-content`
 * and `.cm-line` get a bare `max-width` and are NOT centred by these rules.
 */
const READABLE_LINE_WIDTH_CSS = `
body { --file-line-width: 700px; }
/*
 * Obsidian's STRUCTURAL rules for the wrapper, copied verbatim from this
 * repo's ContinuousPinch.test.ts:24. Without them the hand-built sizer is a
 * bare flex item inside CodeMirror's flex scroller, so it shrink-wraps to its
 * content (measured: 386.27px) and the readable cap never binds - the first
 * run of this file calibrated blind for exactly that reason, and the geometry
 * dump is what caught it. width:100% is what makes max-width mean anything.
 */
.markdown-source-view.mod-cm6 .cm-sizer{display:flex;flex-direction:column;align-items:stretch;width:100%;min-height:100%}
.markdown-source-view.mod-cm6 .cm-contentContainer{flex:1 1 auto;display:flex;align-items:stretch;overflow-x:visible}
.markdown-source-view.mod-cm6 .cm-content{flex-basis:unset!important;width:0;min-height:unset}
.markdown-source-view.mod-cm6.is-readable-line-width .cm-sizer {
  max-width: var(--file-line-width);
  margin-left: auto;
  margin-right: auto;
}
.markdown-source-view.mod-cm6.is-readable-line-width .cm-content {
  max-width: var(--file-line-width);
}
.markdown-source-view.mod-cm6.is-readable-line-width .cm-line {
  max-width: var(--file-line-width);
}
.markdown-source-view.mod-cm6.is-readable-line-width .cm-line.HyperMD-table-row {
  max-width: 100%;
}
`;

declare const process: { env: Record<string, string | undefined> };
let browser: Browser, script: string;
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
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
	await browser?.close();
	if (process.env.HW_SCROLL_ANCHOR) writeFileSync(process.env.HW_SCROLL_ANCHOR, JSON.stringify(report, null, 1));
});

async function run(readable: boolean, plant: "none" | "scrollbar" | "recentre") {
	const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
	try {
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(e.message));
		await page.setContent('<!doctype html><body style="margin:0"></body>');
		await page.addStyleTag({
			content:
				css +
				readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8") +
				READABLE_LINE_WIDTH_CSS,
		});
		await page.addScriptTag({ content: script });
		const r = await page.evaluate(
			a => (window as any).scrollColumnAnchor.run(a.readable, a.plant),
			{ readable, plant }
		);
		expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);
		report.push(r);
		return r;
	} finally {
		await page.close();
	}
}

it("ink stays on the column through a scroll, and when the column recentres", async () => {
	const base = await run(true, "none");
	const scrollbar = await run(true, "scrollbar");
	const recentre = await run(true, "recentre");

	const row = (r: any) =>
		`  ${String(r.plant).padEnd(10)} off=${String(r.offFrames).padEnd(4)} maxOffBy=${r.maxOffBy.toFixed(2).padEnd(8)} ` +
		`endsOff=${String(r.endsOff).padEnd(6)} columnXs=${JSON.stringify(r.columnXs)} ` +
		`clientWidths=${JSON.stringify(r.clientWidths)} sizerLefts=${JSON.stringify(r.sizerLefts)}`;

	// eslint-disable-next-line no-console
	console.log("\nink vs column\n" + [base, scrollbar, recentre].map(row).join("\n") + "\n");

	// Liveness. A fixture that drew nothing, never scrolled, or never centred
	// the sizer reports zero displacement and looks exactly like a pass.
	for (const r of [base, scrollbar, recentre]) {
		expect(r.strokes, `no stroke committed in plant=${r.plant}`).toBe(2);
		expect(r.scrolled, `plant=${r.plant} never scrolled`).toBe(true);
		expect(
			r.sizerCentred,
			`plant=${r.plant}: the sizer is not centred, so readable line width is not in effect. sizerLefts=${JSON.stringify(r.sizerLefts)}`
		).toBe(true);
	}

	// DETECTOR GATE. Every arm below reports zero displacement, and a probe
	// that has never once produced a non-zero cannot refute anything - an
	// earlier version of this file reported a confident zero while being
	// structurally blind. Each arm therefore displaces its own painted camera
	// by a known 10 note-px and reads it back through the same path.
	for (const r of [base, scrollbar, recentre]) {
		expect(
			r.detectorProves,
			`detector blind in plant=${r.plant}: a planted 10px displacement read back as ${r.detectorProves}. ` +
				`Every zero in this file is void until this passes.`
		).toBeCloseTo(10 * r.probeScale, 1);
	}

	// PLANT EFFICACY. "The ink tracked the column" is vacuous unless the column
	// actually moved. The scrollbar plant takes 15px off the scroller's content
	// box, which slides the capped sizer LEFT by half of it - 350.00 -> 342.50
	// as measured - with no line resizing and no editor resize, which is the
	// exact blind spot InkOverlay's originLineObserver comment describes.
	expect(
		scrollbar.columnXs.length,
		`the scrollbar plant did not move the column: ${JSON.stringify(scrollbar.columnXs)}. ` +
			`overflow-y:scroll is inert under headless Chromium's overlay scrollbars; padding-right is what reproduces a classic scrollbar.`
	).toBeGreaterThan(1);
	expect(
		recentre.columnXs.length,
		`the recentre plant did not move the column: ${JSON.stringify(recentre.columnXs)}`
	).toBeGreaterThan(1);

	// THE BEHAVIOUR THIS FILE PROTECTS. Committed ink stays on the text column
	// through a scroll, and through a column that moves mid-scroll by either
	// route. Measured, not assumed: the detector above is proven live and the
	// plants above are proven to move the column.
	for (const r of [base, scrollbar, recentre]) {
		expect(
			r.offFrames,
			`plant=${r.plant} displaced ink off the column by up to ${r.maxOffBy}px over ${r.offFrames} frames ` +
				`(columns seen: ${JSON.stringify(r.columnXs)})`
		).toBe(0);
	}
}, 240_000);
