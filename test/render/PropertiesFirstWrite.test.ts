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
 *  - userRow (plant): a block that also holds a user row must stay shown with its height in the layout: the scroll top
 *    change plus the text's move is the block's height. A read that sees no shown block here cannot see one above either.
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

type Sample = { t: number; mark: string; display: string; height: number; idOnly: boolean; rows: number; contentTop: number; scrollTop: number; oTop: number | null; topLineTop: number | null };
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

async function runOrder(order: Order, o: { text?: string; topLine?: number; onBody?: number } = {}): Promise<Run & { top?: { line: number; text: string; scrollTop: number } }> {
	const page: Page = await browser.newPage({ viewport: { width: PANE.w, height: PANE.h }, deviceScaleFactor: 1 });
	page.on("pageerror", (e) => errors.push(e.message));
	await page.setContent("<!doctype html><html><body></body></html>");
	// Host rules first, then the shipped sheet, as Obsidian loads a plugin's styles after its own.
	await page.addStyleTag({ content: hostCss });
	await page.addStyleTag({ content: css });
	await page.addScriptTag({ content: bundle });
	const mount = await page.evaluate((m) => (window as any).ofMount(m), { text: o.text ?? BODY, paneW: PANE.w, paneH: PANE.h, order, topLine: o.topLine });
	expect(mount.error, `${order}: mounted`).toBeUndefined();
	const run = await page.evaluate((s) => (window as any).ofRun(s), { ...STEPS, onBody: o.onBody ?? STEPS.onBody }) as Run;
	await page.close();
	expect(errors, "page errors").toEqual([]);
	expect(run.times.claimAt, `${order}: the first stroke wrote the page id`).toBeGreaterThan(0);
	expect(run.frontmatterEnd, `${order}: the id frontmatter is in the editor text`).toBe(3);
	expect(run.strokes, `${order}: both strokes kept`).toBe(2);
	return { ...run, top: mount.top };
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

it("plant: a block holding a user row stays shown, its height in the layout (scroll top change plus text move)", async () => {
	const run = await runOrder("userRow");
	const rest = [...run.samples].reverse().find((x) => x.mark === "rest")!;
	const settled = run.samples[run.samples.length - 1]!;
	expect(shown(settled), `the block with a user row is shown at the end: ${row(settled)}`).toBe(true);
	expect(after(run).filter(shown).length, "the frames after the write read the block shown").toBeGreaterThan(0);
	expect(Math.abs(settled.scrollTop - rest.scrollTop + settled.contentTop - rest.contentTop - PROPERTIES_PX),
		`scroll top change plus text move is ${PROPERTIES_PX} px (scroll ${rest.scrollTop} -> ${settled.scrollTop}, text ${rest.contentTop} -> ${settled.contentTop})`).toBeLessThanOrEqual(1);
}, 120_000);

/** A long note scrolled so a blank line sits at the view's top edge: there the editor's own read of the line is not its plain box. */
const TEXT_LINE = "All the materials we use are made of atoms, held together in ways that decide how they behave.";
const BLANK_TOP_LINE = 31;
const BLANK_TOP_BODY = `${Array.from({ length: BLANK_TOP_LINE - 1 }, (_, i) => `${i + 1}. ${TEXT_LINE}`).join("\n")}\n\n${Array.from({ length: 30 }, (_, i) => `${i + BLANK_TOP_LINE + 1}. ${TEXT_LINE}`).join("\n")}\n`;

it("the view's top on a blank line, the note scrolled: that line settles within 1 px of its place through the first stroke's page id write", async () => {
	const run = await runOrder("blockInFrame", { text: BLANK_TOP_BODY, topLine: BLANK_TOP_LINE, onBody: BLANK_TOP_LINE + 1 });
	expect(run.top, "precondition: a blank line at the view's top, the note scrolled").toEqual({ line: BLANK_TOP_LINE, text: "", scrollTop: expect.any(Number) });
	expect(run.top!.scrollTop, "precondition: the note scrolled").toBeGreaterThan(100);
	const rest = [...run.samples].reverse().find((x) => x.mark === "rest")!;
	const settled = run.samples[run.samples.length - 1]!;
	expect(rest.topLineTop, "precondition: the top line is drawn before the stroke").not.toBeNull();
	expect(settled.topLineTop, `the top line is drawn at the end: ${row(settled)}`).not.toBeNull();
	expect(Math.abs(settled.topLineTop! - rest.topLineTop!), `the top line settles where it was: ${rest.topLineTop} -> ${settled.topLineTop}, ${row(settled)}`).toBeLessThan(1);
}, 120_000);
