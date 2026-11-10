/**
 * AFTER A ZOOM, A LINE NO LONGER DRAWN KEEPS ITS LAST READ BOX TOP, AND ITS INK MAY SHOW IN VIEW OFF ITS TEXT.
 *
 * The path as the sweep read it: a line no longer drawn keeps its last read box top (LineAnchors.boxTops), which answers the
 * line's top over the height map when the two differ by more than BOX_AGREE_PX (LineAnchors.top). Nothing drops it on a zoom.
 * The zoom's centre-line hold (InkOverlayZoomApi) moves the scroll by what the centre line moved, so the stale top could land
 * in view while its line is not drawn, and so is not read again.
 *
 * Rig: the issue 48 page (issue48EmbedZoomPage.ts) with Obsidian's wrappers: forty lines, a 700 x 525 slide on every other
 * line with no height estimate, so CodeMirror's height map takes one text line for every slide it has not drawn. One pen
 * stroke on the slide at the viewport's middle after a scroll to 2900; its line's box is read (asked through the overlay's own
 * requestLineBoxes when no editor update has asked it within 30 frames: see settle in the page). The scroll then moves on
 * (down, leaving the line above, or up, leaving it below) until the line leaves CodeMirror's drawn range, a zoom bar step
 * commits (x2 or x0.5) with the slides beyond the drawn range at estimates, and the scroll walks on the same way, then back
 * the other way past the line. The
 * failure, at the settle, after 60 quiet frames and at every walk step: the stroke's line is not drawn and its pixels are
 * inside the scroller's rect. CodeMirror draws a margin past the visible rect, so ink placed on its text never meets this.
 *
 * Sensor: the same failure made on purpose by the sweep's path. With the line not drawn, a box top is written for it
 * through the overlay's own box write (boxesRead, then lineAnchorsMoved), chosen to put the ink at the scroller's middle;
 * the readout must see the undrawn line's ink in view.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/ZoomUndrawnBoxTop.test.ts   (HW_ZOOM_BOX_OUT=<file> writes every read)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
declare const process: { env: Record<string, string | undefined> };
const root = fileURLToPath(new URL("../../", import.meta.url));
let browser: Browser, bundle: string;
const rows: Record<string, unknown> = {};
beforeAll(async () => {
	browser = await chromium.launch({ headless: true });
	bundle = (await build({ entryPoints: [root + "test/render/zoomUndrawnBoxTopPage.ts"], bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: root + "test/render/iphoneObsidianStub.ts" } })).outputFiles[0]!.text;
}, 180_000);
afterAll(async () => { await browser?.close(); if (process.env.HW_ZOOM_BOX_OUT) writeFileSync(process.env.HW_ZOOM_BOX_OUT, JSON.stringify(rows, null, 1)); });

async function open(): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
	await page.setContent("<body></body>"); await page.addStyleTag({ content: readFileSync(root + "styles.css", "utf8") });
	await page.addStyleTag({ content: `html,body{margin:0;width:100%;height:100%;overflow:hidden}body{display:flex}.issue48-host{position:relative;display:flex;flex:1;min-width:0;min-height:0;height:600px;overflow:hidden}.issue48-host .cm-editor{display:flex;flex:1;min-width:0;min-height:0;height:600px}.issue48-host .cm-scroller{flex:1;min-height:0;overflow:auto}.issue48-host .cm-content{padding:8px 0!important}.issue48-host .cm-line{padding:0}` });
	await page.addScriptTag({ content: bundle });
	await page.evaluate(() => (window as any).issue48.setup(true));
	return page;
}

type State = { n: number | null; anchorTop: number | null; drawn: [number, number]; lineDrawn: boolean; box: number | null; hm: number | null;
	dy: number | null; scale: number; scrollTop: number; inView: boolean; ink: { count: number; top: number; bottom: number };
	viewport: { top: number; bottom: number }; slides: number[] };
/** The failure: the stroke's line is not drawn and its ink is in view. */
const bad = (s: State) => !s.lineDrawn && s.inView;
const brief = (s: State) => ({ n: s.n, drawn: s.drawn, box: s.box, hm: s.hm, dy: s.dy, scale: s.scale, scrollTop: s.scrollTop,
	ink: [s.ink.count, s.ink.top, s.ink.bottom], view: [s.viewport.top, s.viewport.bottom], inView: s.inView, slides: s.slides });

/** Write the stroke, see its line read from its box, then scroll `dir` until the line leaves the drawn range. */
async function prepare(page: Page, dir: 1 | -1) {
	const w = await page.evaluate(() => (window as any).issue48.write(2900));
	const at = await page.evaluate(() => (window as any).zoomBox.settle(240)) as State & { waited: number; nudged: boolean };
	// eslint-disable-next-line no-console
	console.log(`box read after ${at.waited} frames${at.nudged ? ", nudged" : ""}`);
	expect(w.strokes, "premise: one stroke written").toBe(1);
	expect(at.n, "premise: the stroke has a line anchor").not.toBeNull();
	expect(at.lineDrawn && at.inView, `premise: the stroke's line is drawn and its ink in view (${JSON.stringify(brief(at))})`).toBe(true);
	expect(at.box, `premise: the stroke's line box was read (${JSON.stringify(brief(at))})`).not.toBeNull();
	const away = await page.evaluate(d => (window as any).zoomBox.away(d * 300), dir) as { steps: number; stuck: boolean; after: State };
	expect(away.after.lineDrawn, `premise: the stroke's line left the drawn range (${JSON.stringify(brief(away.after))})`).toBe(false);
	expect(away.after.box, "premise: its box top is still on record before the zoom").not.toBeNull();
	return { at, away };
}

describe("an undrawn line's ink stays out of view across a zoom", () => {
	for (const [dir, f] of [[1, 2], [1, 0.5], [-1, 2], [-1, 0.5]] as const) {
		const key = `${dir > 0 ? "down" : "up"} x${f}`;
		it(`${key}: the line left ${dir > 0 ? "above" : "below"}, zoom x${f}, then the scroll walks on`, async () => {
			const page = await open();
			try {
				const p = await prepare(page, dir);
				const z = await page.evaluate(k => (window as any).zoomBox.zoom(k), f) as { ok: boolean; settled: State; quiet: State };
				expect(z.ok, "premise: the zoom was taken").toBe(true);
				const ahead = await page.evaluate(d => (window as any).zoomBox.walk(d * 200, 30), dir) as State[];
				// And back the other way, past where the line was: the approach toward the line and its stale ink.
				const back = await page.evaluate(d => (window as any).zoomBox.walk(-d * 200, 60), dir) as State[];
				const walk = [...ahead, ...back];
				rows[key] = { at: p.at, away: p.away, zoom: z, walk, ahead: ahead.length };
				// eslint-disable-next-line no-console
				console.log(`zoom ${key} ${JSON.stringify({ at: brief(p.at), away: brief(p.away.after), settled: brief(z.settled), quiet: brief(z.quiet),
					walkSteps: walk.length, walkBad: walk.map((s, i) => bad(s) ? { i, ...brief(s) } : null).filter(Boolean), walkLast: walk.length ? brief(walk[walk.length - 1]!) : null })}`);
				expect.soft(bad(z.settled), `settle: line ${z.settled.n} not drawn (${z.settled.drawn}) and its ink in view (${JSON.stringify(brief(z.settled))})`).toBe(false);
				expect.soft(bad(z.quiet), `quiet: line ${z.quiet.n} not drawn (${z.quiet.drawn}) and its ink in view (${JSON.stringify(brief(z.quiet))})`).toBe(false);
				expect.soft(walk.map((s, i) => bad(s) ? i : -1).filter(i => i >= 0), "walk: the steps where the undrawn line's ink is in view").toEqual([]);
			} finally { await page.close(); }
		}, 180_000);
	}

	// The walk back down after the up walk: down past the line, zoom x2, down on, up past where the line was, then down again,
	// leaving the line above once more after it was drawn and read again on the way up.
	it("down x2, walk back down: the line left above, zoom x2, down, up past it, then down again", async () => {
		const page = await open();
		try {
			const p = await prepare(page, 1);
			const z = await page.evaluate(k => (window as any).zoomBox.zoom(k), 2) as { ok: boolean; settled: State; quiet: State };
			expect(z.ok, "premise: the zoom was taken").toBe(true);
			const ahead = await page.evaluate(() => (window as any).zoomBox.walk(200, 30)) as State[];
			const back = await page.evaluate(() => (window as any).zoomBox.walk(-200, 60)) as State[];
			const down = await page.evaluate(() => (window as any).zoomBox.walk(200, 60)) as State[];
			rows["down x2 back down"] = { at: p.at, away: p.away, zoom: z, ahead, back, down };
			// eslint-disable-next-line no-console
			console.log(`down x2 back down ${JSON.stringify({ steps: [ahead.length, back.length, down.length],
				backDrawn: back.some(s => s.lineDrawn), downBad: down.map((s, i) => bad(s) ? { i, ...brief(s) } : null).filter(Boolean),
				downLast: down.length ? brief(down[down.length - 1]!) : null })}`);
			expect(back.some(s => s.lineDrawn), "premise: the walk up drew the line again").toBe(true);
			expect.soft([...ahead, ...back].map((s, i) => bad(s) ? i : -1).filter(i => i >= 0), "walk down and up: the steps where the undrawn line's ink is in view").toEqual([]);
			expect.soft(down.map((s, i) => bad(s) ? i : -1).filter(i => i >= 0), "walk back down: the steps where the undrawn line's ink is in view").toEqual([]);
		} finally { await page.close(); }
	}, 240_000);

	it("sensor: a box top written for the undrawn line puts its ink in view, and the readout sees it", async () => {
		const page = await open();
		try {
			await prepare(page, 1);
			const s = await page.evaluate(() => (window as any).zoomBox.plantBox()) as { mid: number; target: number; moved: boolean; before: State; after: State };
			rows.sensor = s;
			// eslint-disable-next-line no-console
			console.log(`sensor ${JSON.stringify({ mid: s.mid, target: s.target, moved: s.moved, before: brief(s.before), after: brief(s.after) })}`);
			expect(s.before.inView, "premise: before the write the undrawn line's ink is not in view").toBe(false);
			expect(bad(s.after), `the readout sees the undrawn line's ink in view (${JSON.stringify(brief(s.after))})`).toBe(true);
		} finally { await page.close(); }
	}, 180_000);
});
