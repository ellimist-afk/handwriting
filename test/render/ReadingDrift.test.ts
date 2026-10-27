/**
 * WHERE INK SITS AGAINST THE TEXT IN THE EDITOR AND IN READING VIEW. A measurement rig: it changes nothing and asserts
 * only that it measured.
 *
 * Alan's note "Untitled 1" (canvas note, 5,795 strokes): on the switch to Reading view, far ink moves (mostly down) and
 * the purple "Vault test" ink at the top left barely moves. For two strokes (the purple stroke nearest the top left and
 * the stroke reaching farthest right and down) each view reports the stroke box's top-left as px from the first body
 * text line's top-left (dx, dy) and as px inside the scroller's viewport. Editor: the real CodeMirror editor with the
 * real overlay, Infinite Canvas on, pinch 1 and 0.5, scrolled to the top left and to the far stroke. Reading view: the
 * ReadingViewJump rig's view, at scroll 0 and scrolled to the far stroke. Single-stroke mounts check the transforms
 * against painted pixels.
 *
 * Assumptions: both views at 12 px text (vault test 2's base font; Minimal gives both views one variable); editor line
 * height 1.66 (the pitch the sidecar's anchors record), Reading view 1.5 (the jump rig's default); readable line length
 * on (700 px column); pane 900 x 700; editor frontmatter hidden (the anchors put line 4 at world y 0).
 *
 * Input: HW_JUMP_DIR (`Untitled 1.md`, `sidecar.json`). Output: HW_JUMP_OUT/results.json.
 * Run: npx vitest run --config vitest.render.mts ReadingDrift
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const IN = process.env.HW_JUMP_DIR ?? "";
const OUT = process.env.HW_JUMP_OUT ?? "";
const HAVE = IN !== "" && OUT !== "" && existsSync(`${IN}/Untitled 1.md`) && existsSync(`${IN}/sidecar.json`);
const TEXT = HAVE ? readFileSync(`${IN}/Untitled 1.md`, "utf8") : "";
const SIDECAR = HAVE ? readFileSync(`${IN}/sidecar.json`, "utf8") : "";
const PANE = { w: 900, h: 700 };
const FONT = 12;

let browser: Browser;
let bundle = "";
const results: Record<string, unknown> = {};
const errors: string[] = [];
let PURPLE = "", FAR = "";

beforeAll(async () => {
	if (!HAVE) return;
	mkdirSync(OUT, { recursive: true });
	const b = await build({ entryPoints: [fileURLToPath(new URL("./readingDriftPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	bundle = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	if (HAVE) writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
	await browser?.close();
});

async function fresh(editor: boolean): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: PANE.w, height: PANE.h }, deviceScaleFactor: 1 });
	page.on("pageerror", (e) => errors.push(e.message));
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addStyleTag({ content: css + (editor ? REAL_OBSIDIAN_CSS : "") });
	await page.addScriptTag({ content: bundle });
	const load = await page.evaluate((s) => (window as any).driftLoad(s), SIDECAR);
	results.load ??= load;
	return page;
}
const call = (page: Page, fn: string, arg: unknown) => page.evaluate(([f, a]) => (window as any)[f](a), [fn, arg] as const) as Promise<any>;
const log = (name: string, v: unknown) => { results[name] = v; console.log("READING-DRIFT", name, JSON.stringify(v)); };

it.skipIf(!HAVE)("targets: the purple stroke nearest the top left and the farthest stroke", async () => {
	const page = await fresh(false);
	const load = results.load as any;
	PURPLE = load.purple.id;
	FAR = load.far.id;
	log("targets", { colours: load.colours, purple: load.purple, far: load.far, inkExtent: load.inkExtent, fontRef: load.fontRef });
	expect(load.strokes).toBe(5795);
	await page.close();
});

it.skipIf(!HAVE)("editor, every stroke: pinch 1 and 0.5, top left and scrolled to the far stroke", async () => {
	const page = await fresh(true);
	const m = await call(page, "driftEditorMount", { text: TEXT, sidecar: SIDECAR, keep: null, font: FONT, lh: 1.66, paneW: PANE.w, paneH: PANE.h });
	log("editor.mount", m);
	expect(m.error).toBeUndefined();
	const ids = [PURPLE, FAR];
	log("editor.p1.top", await call(page, "driftEditorRead", { ids }));
	log("editor.p1.far.scroll", await call(page, "driftEditorScrollTo", FAR));
	log("editor.p1.far", await call(page, "driftEditorRead", { ids }));
	await page.evaluate(async () => { const v = document.querySelector(".cm-scroller") as HTMLElement; v.scrollLeft = 0; v.scrollTop = 0; for (let i = 0; i < 10; i++) await new Promise((r) => requestAnimationFrame(r)); });
	log("editor.p05.zoom", await call(page, "driftEditorZoom", 0.5));
	await page.evaluate(async () => { const v = document.querySelector(".cm-scroller") as HTMLElement; v.scrollLeft = 0; v.scrollTop = 0; for (let i = 0; i < 10; i++) await new Promise((r) => requestAnimationFrame(r)); });
	log("editor.p05.top", await call(page, "driftEditorRead", { ids }));
	log("editor.p05.far.scroll", await call(page, "driftEditorScrollTo", FAR));
	log("editor.p05.far", await call(page, "driftEditorRead", { ids }));
	await page.screenshot({ path: `${OUT}/editor-p05-far.png` });
	await page.close();
}, 600_000);

it.skipIf(!HAVE)("editor, two strokes alone: the camera transform against painted pixels", async () => {
	const page = await fresh(true);
	const m = await call(page, "driftEditorMount", { text: TEXT, sidecar: SIDECAR, keep: [PURPLE, FAR], font: FONT, lh: 1.66, paneW: PANE.w, paneH: PANE.h });
	expect(m.error).toBeUndefined();
	log("editorPix.p1.top", await call(page, "driftEditorRead", { ids: [PURPLE], pixels: true }));
	await page.screenshot({ path: `${OUT}/editor-single-p1-top.png` });
	await call(page, "driftEditorScrollTo", FAR);
	log("editorPix.p1.far", await call(page, "driftEditorRead", { ids: [FAR], pixels: true }));
	await page.close();
}, 300_000);

it.skipIf(!HAVE)("Reading view, every stroke: scroll 0 and scrolled to the far stroke", async () => {
	const page = await fresh(false);
	const m = await call(page, "driftReadingMount", { text: TEXT, keep: null, font: FONT, lh: 1.5, paneW: PANE.w, paneH: PANE.h });
	log("reading.mount", m);
	const ids = [PURPLE, FAR];
	log("reading.top", await call(page, "driftReadingRead", { ids }));
	await page.screenshot({ path: `${OUT}/reading-top.png` });
	log("reading.trace.jump", await call(page, "driftReadingTrace", { left: 6757, top: 3890, steps: 1, after: 6 }));
	log("reading.trace.steps", await call(page, "driftReadingTrace", { left: 6757, top: 3890, steps: 40, after: 6 }));
	log("reading.far.scroll", await call(page, "driftReadingScrollTo", FAR));
	log("reading.far", await call(page, "driftReadingRead", { ids }));
	await page.screenshot({ path: `${OUT}/reading-far.png` });
	await page.close();
}, 600_000);

it.skipIf(!HAVE)("Reading view, two strokes alone: the anchor transform against painted pixels", async () => {
	const page = await fresh(false);
	await call(page, "driftReadingMount", { text: TEXT, keep: [PURPLE, FAR], font: FONT, lh: 1.5, paneW: PANE.w, paneH: PANE.h });
	log("readingPix.top", await call(page, "driftReadingRead", { ids: [PURPLE], pixels: true }));
	await call(page, "driftReadingScrollTo", FAR);
	log("readingPix.far", await call(page, "driftReadingRead", { ids: [FAR], pixels: true }));
	await page.close();
	log("pageErrors", errors);
}, 300_000);
