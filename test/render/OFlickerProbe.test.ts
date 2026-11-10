/**
 * PROBE: WHICH ORDERS OF A NEW NOTE'S FIRST FRONTMATTER WRITE PAINT A FRAME WITH THE INK DROPPED.
 *
 * In 1.5.0, with Properties in document set to Visible, the drawn O on a new note dropped down at the next pen down and
 * came back in under a second. The first stroke on a note with no page id wrote the id frontmatter; Obsidian then drew a
 * Properties block above the text, and the plugin's id-only class, added a frame after its observer saw the block, was
 * what hid it. While the block showed, the text and the ink under it sat lower by its height.
 *
 * The page (oFlickerProbePage.ts) runs the reported steps on a new note, once per order of editor text, block and row (see the
 * Order type there), and samples every frame after paint. This is a probe: it records which orders paint a dropped frame
 * and gates only its own instrument.
 *  - inlineHidden (control): the block hidden by inline style never shows, so no frame may drop.
 *  - userRow (plant): a block with a user row stays shown, so the text must end lower by the block height (46 px, within
 *    1 px) and the frames after it must read the block shown. A probe that reads nothing here is blind.
 * Every other order is reported, not gated: per order the dropped frames (a frame after the claim, block shown, where the
 * O's drawn top or `.cm-content` top is 1 px or more off its settled value), the largest drop and how long the drop lasts.
 * It cannot say which order Obsidian uses; only the live run in real Obsidian says that.
 *
 * Rows go to HW_O_FLICKER_PROBE_REPORT when set.
 *
 * Run: npx vitest run --config vitest.render.mts OFlickerProbe
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import type { Order } from "./oFlickerProbePage";

declare const process: { env: Record<string, string | undefined> };

const hostCss = readFileSync(fileURLToPath(new URL("./obsidianMetadataHost.css", import.meta.url)), "utf8");
const BODY = "\n\n\n\nAll the materials we use are made of atoms, and the way those atoms are held together decides how the material behaves under load.\nA second paragraph line.\n";
const PANE = { w: 900, h: 700 };
const PROPERTIES_PX = 46;
const STEPS = { onBody: 1, gapMs: 500, holdMs: 200, tailMs: 1500 };
const ORDERS: Order[] = ["textThenBlock", "blockThenText", "rowsNextFrame", "blockInFrame", "blockBeforeText", "inlineHidden", "userRow"];
const REPORT = process.env.HW_O_FLICKER_PROBE_REPORT ?? "";

type Sample = { f: number; t: number; mark: string; block: boolean; display: string; height: number; idOnly: boolean; rows: number;
	docHasFm: boolean; contentTop: number; cmDocTop: number; camDocTop: number; oTop: number | null; oDy: number | null; anchorGen: number | null; shownMoves: number | null };
type Run = { order: Order; samples: Sample[]; times: Record<string, number>; strokes: number; frontmatterEnd: number };

let browser: Browser;
let bundle = "";
const report: Record<string, unknown> = {};
const errors: string[] = [];

beforeAll(async () => {
	const b = await build({ entryPoints: [fileURLToPath(new URL("./oFlickerProbePage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	bundle = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	if (REPORT) writeFileSync(REPORT, JSON.stringify({ steps: STEPS, report, errors }, null, 1));
	await browser?.close();
});

async function fresh(): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: PANE.w, height: PANE.h }, deviceScaleFactor: 1 });
	page.on("pageerror", (e) => errors.push(e.message));
	await page.setContent("<!doctype html><html><body></body></html>");
	// Host rules first, then the shipped sheet, as Obsidian loads a plugin's styles after its own.
	await page.addStyleTag({ content: hostCss });
	await page.addStyleTag({ content: css });
	await page.addScriptTag({ content: bundle });
	return page;
}
const call = (page: Page, fn: string, arg: unknown) => page.evaluate(([f, a]) => (window as any)[f](a), [fn, arg] as const) as Promise<any>;

/** Per order: the rest and settled tops, and every frame after the claim where the block shows and a top is off settled. */
function summarise(run: Run) {
	const s = run.samples, claimAt = run.times.claimAt ?? -1;
	const rest = [...s].reverse().find((x) => x.mark === "rest") ?? s[0]!;
	const settled = s[s.length - 1]!;
	const after = s.filter((x) => claimAt > 0 && x.t >= claimAt);
	const off = (x: Sample) => Math.max(Math.abs(x.contentTop - settled.contentTop), x.oTop !== null && settled.oTop !== null ? Math.abs(x.oTop - settled.oTop) : 0);
	const dropped = after.filter((x) => x.display !== "none" && x.display !== "absent" && x.height > 0 && off(x) >= 1);
	const shown = after.filter((x) => x.display !== "none" && x.display !== "absent" && x.height > 0);
	return {
		order: run.order, frames: s.length, strokes: run.strokes, times: run.times,
		rest: { contentTop: rest.contentTop, oTop: rest.oTop }, settled: { contentTop: settled.contentTop, oTop: settled.oTop, display: settled.display, idOnly: settled.idOnly, rows: settled.rows },
		shownFrames: shown.length, droppedFrames: dropped.length, maxDropPx: dropped.reduce((m, x) => Math.max(m, off(x)), 0),
		dropMs: dropped.length ? Math.round(dropped[dropped.length - 1]!.t - dropped[0]!.t) : 0,
		firstDrop: dropped[0] ?? null, marksDropped: [...new Set(dropped.map((x) => x.mark))],
	};
}

for (const order of ORDERS) {
	it(`order ${order}: a new note, an O, a pen down 0.5 s later, every frame read`, async () => {
		const page = await fresh();
		const mount = await call(page, "ofMount", { text: BODY, paneW: PANE.w, paneH: PANE.h, order });
		expect(mount.error, `${order}: mounted`).toBeUndefined();
		const run = await call(page, "ofRun", STEPS) as Run;
		const sum = summarise(run);
		report[order] = { summary: sum, samples: run.samples };
		console.log("O-FLICKER", order, JSON.stringify(sum));
		expect(errors, "page errors").toEqual([]);
		expect(run.times.claimAt, `${order}: the first stroke claimed the note`).toBeGreaterThan(0);
		expect(run.frontmatterEnd, `${order}: the id frontmatter is in the editor text`).toBe(3);
		if (order === "inlineHidden") {
			expect(sum.shownFrames, "control: the inline-hidden block never shows").toBe(0);
			expect(sum.droppedFrames, "control: no frame drops").toBe(0);
		}
		if (order === "userRow") {
			expect(Math.abs(sum.settled.contentTop - sum.rest.contentTop - PROPERTIES_PX), `plant: the text ends ${PROPERTIES_PX} px lower (rest ${sum.rest.contentTop}, settled ${sum.settled.contentTop})`).toBeLessThanOrEqual(1);
			expect(sum.settled.display, "plant: the block with a user row stays shown").not.toBe("none");
			expect(sum.shownFrames, "plant: the frames after the claim read the block shown").toBeGreaterThan(0);
		}
		await page.close();
	}, 120_000);
}
