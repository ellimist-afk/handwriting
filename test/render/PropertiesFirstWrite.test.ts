/**
 * A NEW NOTE'S FIRST STROKE MUST NOT MAKE THE TEXT OR THE INK JUMP WHILE THE PAGE ID IS WRITTEN.
 *
 * The first stroke on a note with no page id writes the id frontmatter. With Properties in document set to Visible,
 * Obsidian then draws a Properties block above the text, and only the plugin's id-only class hides it. In real Obsidian
 * 1.13.7 the block arrives with its id row from inside an animation frame, after the editor text already holds the id.
 * If the class lands a frame late, that frame paints the block: the text drops by the block's height, the ink drops with
 * it on the next camera sync, and both come back a frame later. In real Obsidian the drawn O jumped 119 px for one frame
 * in 2 of 2 runs with Properties visible, and 0 of 2 with them hidden.
 *
 * The page (oFlickerProbePage.ts) is the real CodeMirror editor with the real ink overlay, Obsidian's host rule that shows
 * the block, and the shipped styles.css that hides it. It samples every frame after paint.
 *  - blockInFrame: the block with its id row inserted from inside the next animation callback, as in Obsidian. No frame
 *    after the claim may show the block, and the text and the O must stay within 1 px of where they settle.
 *  - userRow (plant): a block that also holds a user row must stay shown and push the text down by its height. A read
 *    that sees no shown block here cannot see one in the cell above either.
 *
 * Run: npx vitest run --config vitest.render.mts PropertiesFirstWrite
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import type { Order } from "./oFlickerProbePage";

const hostCss = readFileSync(fileURLToPath(new URL("./obsidianMetadataHost.css", import.meta.url)), "utf8");
const BODY = "\n\n\n\nAll the materials we use are made of atoms, and the way those atoms are held together decides how the material behaves under load.\nA second paragraph line.\n";
const PANE = { w: 900, h: 700 };
const PROPERTIES_PX = 46;
const STEPS = { onBody: 1, gapMs: 500, holdMs: 200, tailMs: 1000 };

type Sample = { t: number; mark: string; display: string; height: number; idOnly: boolean; rows: number; contentTop: number; oTop: number | null };
type Run = { samples: Sample[]; times: Record<string, number>; strokes: number; frontmatterEnd: number };

let browser: Browser;
let bundle = "";
const errors: string[] = [];

beforeAll(async () => {
	const b = await build({ entryPoints: [fileURLToPath(new URL("./oFlickerProbePage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	bundle = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => { await browser?.close(); });

async function runOrder(order: Order): Promise<Run> {
	const page: Page = await browser.newPage({ viewport: { width: PANE.w, height: PANE.h }, deviceScaleFactor: 1 });
	page.on("pageerror", (e) => errors.push(e.message));
	await page.setContent("<!doctype html><html><body></body></html>");
	// Host rules first, then the shipped sheet, as Obsidian loads a plugin's styles after its own.
	await page.addStyleTag({ content: hostCss });
	await page.addStyleTag({ content: css });
	await page.addScriptTag({ content: bundle });
	const mount = await page.evaluate((o) => (window as any).ofMount(o), { text: BODY, paneW: PANE.w, paneH: PANE.h, order });
	expect(mount.error, `${order}: mounted`).toBeUndefined();
	const run = await page.evaluate((o) => (window as any).ofRun(o), STEPS) as Run;
	await page.close();
	expect(errors, "page errors").toEqual([]);
	expect(run.times.claimAt, `${order}: the first stroke wrote the page id`).toBeGreaterThan(0);
	expect(run.frontmatterEnd, `${order}: the id frontmatter is in the editor text`).toBe(3);
	expect(run.strokes, `${order}: both strokes kept`).toBe(2);
	return run;
}

const shown = (x: Sample) => x.display !== "none" && x.display !== "absent" && x.height > 0;
const after = (run: Run) => run.samples.filter((x) => x.t >= run.times.claimAt!);
const row = (x: Sample) => `t ${x.t} ${x.mark}: display ${x.display} h ${x.height} idOnly ${x.idOnly} rows ${x.rows} contentTop ${x.contentTop} oTop ${x.oTop}`;

it("a new note's first stroke: the Properties block for the page id never paints, so the text and the O never jump", async () => {
	const run = await runOrder("blockInFrame");
	const frames = after(run), settled = run.samples[run.samples.length - 1]!;
	expect(frames.length, "frames were read after the page id was written").toBeGreaterThan(30);
	expect(settled.idOnly && settled.display === "none", `the block ends hidden: ${row(settled)}`).toBe(true);
	const painted = frames.filter(shown);
	expect(painted.map(row), "frames that painted the id-only Properties block").toEqual([]);
	const off = (x: Sample) => Math.max(Math.abs(x.contentTop - settled.contentTop),
		x.oTop !== null && settled.oTop !== null ? Math.abs(x.oTop - settled.oTop) : 0);
	const jumped = frames.filter((x) => off(x) >= 1);
	expect(jumped.map(row), "frames where the text or the O sat 1 px or more off where it settles").toEqual([]);
}, 120_000);

it("plant: a block holding a user row stays shown and pushes the text down by its height", async () => {
	const run = await runOrder("userRow");
	const rest = [...run.samples].reverse().find((x) => x.mark === "rest")!;
	const settled = run.samples[run.samples.length - 1]!;
	expect(shown(settled), `the block with a user row is shown at the end: ${row(settled)}`).toBe(true);
	expect(after(run).filter(shown).length, "the frames after the write read the block shown").toBeGreaterThan(0);
	expect(Math.abs(settled.contentTop - rest.contentTop - PROPERTIES_PX),
		`the text ends ${PROPERTIES_PX} px lower (rest ${rest.contentTop}, settled ${settled.contentTop})`).toBeLessThanOrEqual(1);
}, 120_000);
