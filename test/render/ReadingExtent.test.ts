/**
 * A CANVAS NOTE'S READING VIEW SCROLLS AS FAR AS ITS EDITOR.
 *
 * Alan's note "Untitled 1" (an Infinite Canvas note, 5,795 strokes, ink far right and down): scrolled far right and
 * down, the editor's range reaches past the ink (the extent it granted the note: room to write and the room scrolling
 * out grew), and Reading view's ended at the ink's own box. At the end of each range the far stroke sat about 280 px
 * lower on screen in Reading view than in the editor, so on the switch far ink moved down.
 *
 * One page holds both views, as Obsidian's leaf does: the real CodeMirror editor with the real overlay (Infinite Canvas
 * on) is mounted and scrolled so the far stroke sits at the middle of its viewport (the canvas grows its grant as it
 * goes), then hidden as Reading view hides it; the note's Reading view is mounted beside it and scrolled the same way.
 * The rig (readingDriftPage.ts) reads each stroke's place from each view's own transform. The editor's range is not
 * compared at its end: scrolled to the end, the canvas grows it again. Cells: the far stroke's place against the
 * viewport's middle in both views; no editor (no grant): no spacer; the tab opening another note (one with no ink, or a
 * canvas note with ink and no grant) takes the spacer off; Infinite Canvas off: no spacer; the plugin's teardown takes
 * the spacer off.
 *
 * Input: HW_JUMP_DIR (`Untitled 1.md`, `sidecar.json`). Output: HW_JUMP_OUT/extent-results.json.
 * Run: npx vitest run --config vitest.render.mts ReadingExtent
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
let FAR = "";
/** The Reading view's range with no grant: the ink's own box. */
let inkRange: { scrollWidth: number; scrollHeight: number } | null = null;
/** A row's box top-left against its viewport's middle, px. */
const fromMiddle = (row: any, vp: { w: number; h: number }) => ({ x: row.vx - vp.w / 2, y: row.vy - vp.h / 2 });
/** How far the view's range reaches past the stroke's box top-left, content px: where the range ends, against the ink. */
const tail = (row: any, scroll: { scrollLeft: number; scrollTop: number; scrollWidth: number; scrollHeight: number }) =>
	({ x: scroll.scrollWidth - scroll.scrollLeft - row.vx, y: scroll.scrollHeight - scroll.scrollTop - row.vy });

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
	if (HAVE) writeFileSync(`${OUT}/extent-results.json`, JSON.stringify({ ...results, errors }, null, 1));
	await browser?.close();
});

async function fresh(): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: PANE.w, height: PANE.h }, deviceScaleFactor: 1 });
	page.on("pageerror", (e) => errors.push(e.message));
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addScriptTag({ content: bundle });
	const load = await page.evaluate((s) => (window as any).driftLoad(s), SIDECAR);
	FAR = load.far.id;
	return page;
}
const call = (page: Page, fn: string, arg?: unknown) => page.evaluate(([f, a]) => (window as any)[f](a), [fn, arg] as const) as Promise<any>;

/** The editor mounted, scrolled so the far stroke sits at its viewport's middle (the canvas grows its grant), then hidden. */
async function editorAtFar(page: Page) {
	const m = await call(page, "driftEditorMount", { text: TEXT, sidecar: SIDECAR, keep: null, font: FONT, lh: 1.66, paneW: PANE.w, paneH: PANE.h });
	expect(m.error).toBeUndefined();
	await call(page, "driftEditorScrollTo", FAR);
	const read = await call(page, "driftEditorRead", { ids: [FAR] });
	const scroll = read.state;
	await call(page, "driftEditorHide");
	return { scroll, viewport: read.viewport, far: read.rows[0], fromMiddle: fromMiddle(read.rows[0], read.viewport), tail: tail(read.rows[0], scroll) };
}

/** The Reading view mounted and scrolled the same way (clamped by its range). */
async function readingAtFar(page: Page) {
	const m = await call(page, "driftReadingMount", { text: TEXT, keep: null, font: FONT, lh: 1.5, paneW: PANE.w, paneH: PANE.h });
	const spacer = await call(page, "driftReadingSpacer");
	await call(page, "driftReadingScrollTo", FAR);
	const read = await call(page, "driftReadingRead", { ids: [FAR] });
	const scroll = read.state;
	return { mount: m, spacer, scroll, viewport: read.viewport, far: read.rows[0], fromMiddle: fromMiddle(read.rows[0], read.viewport), tail: tail(read.rows[0], scroll) };
}

it.skipIf(!HAVE)("no editor this session (no grant): no spacer, the ink's own range", async () => {
	const page = await fresh();
	// A canvas note (Infinite Canvas on) that no editor has laid out: the store holds no grant for it.
	await call(page, "driftCanvasSetting", true);
	const r = await readingAtFar(page);
	results.noGrant = r;
	expect(r.spacer).toBeNull();
	inkRange = { scrollWidth: r.scroll.scrollWidth, scrollHeight: r.scroll.scrollHeight };
	await page.close();
}, 600_000);

it.skipIf(!HAVE)("scrolled to the far stroke, it sits at the same place against the viewport's middle in both views", async () => {
	const page = await fresh();
	const editor = await editorAtFar(page);
	const reading = await readingAtFar(page);
	results.grant = { editor, reading };
	expect(Math.abs(editor.fromMiddle.y), "premise: the editor brought the far stroke to its middle").toBeLessThanOrEqual(100);
	const dy = reading.fromMiddle.y - editor.fromMiddle.y, dx = reading.fromMiddle.x - editor.fromMiddle.x;
	expect(Math.abs(dy), `far stroke against the middle, y: Reading ${reading.fromMiddle.y}, editor ${editor.fromMiddle.y}`).toBeLessThanOrEqual(2);
	expect(Math.abs(dx), `far stroke against the middle, x: Reading ${reading.fromMiddle.x}, editor ${editor.fromMiddle.x}`).toBeLessThanOrEqual(2);
	// The range ends where the editor's does, measured from the same stroke: the grant at the view's ink zoom.
	expect(Math.abs(reading.tail.y - editor.tail.y), `range past the far stroke, y: Reading ${reading.tail.y}, editor ${editor.tail.y}`).toBeLessThanOrEqual(2);
	expect(Math.abs(reading.tail.x - editor.tail.x), `range past the far stroke, x: Reading ${reading.tail.x}, editor ${editor.tail.x}`).toBeLessThanOrEqual(2);
	// The plugin's teardown (unload) takes the spacer off.
	const torn = await call(page, "driftTeardown");
	results.teardown = torn;
	expect(torn.spacer).toBeNull();
	await page.close();
}, 600_000);

it.skipIf(!HAVE)("the tab opens a note with no ink: the spacer goes, the range is the text's", async () => {
	const page = await fresh();
	await editorAtFar(page);
	const before = await readingAtFar(page);
	expect(before.spacer, "premise: the canvas note's Reading view holds the spacer").not.toBeNull();
	const r = await call(page, "driftReadingSwitch", { path: "Empty.md", ink: false });
	results.switchEmpty = r;
	expect(r.spacer).toBeNull();
	expect(r.scrollHeight).toBeLessThan(before.scroll.scrollHeight);
	await page.close();
}, 600_000);

it.skipIf(!HAVE)("the tab opens a canvas note with ink and no grant: the spacer goes, the range is the ink's", async () => {
	const page = await fresh();
	await editorAtFar(page);
	const before = await readingAtFar(page);
	expect(before.spacer, "premise: the canvas note's Reading view holds the spacer").not.toBeNull();
	const r = await call(page, "driftReadingSwitch", { path: "Other.md", ink: true });
	results.switchNoGrant = r;
	expect(r.spacer).toBeNull();
	expect(r.scrollHeight).toBeLessThan(before.scroll.scrollHeight);
	await page.close();
}, 600_000);

it.skipIf(!HAVE)("Infinite Canvas off: the note is not a canvas note, no spacer", async () => {
	const page = await fresh();
	await editorAtFar(page);
	await call(page, "driftCanvasSetting", false);
	const r = await readingAtFar(page);
	results.notCanvas = r;
	expect(r.spacer).toBeNull();
	// The range is the ink's box, shorter than the granted one. Not compared with the no-editor page's: the hidden editor
	// lends its line signature here, which places some anchored strokes elsewhere (EmbedInkLines.ts).
	expect(r.scroll.scrollHeight).toBeLessThan((results.grant as any).reading.scroll.scrollHeight);
	await page.close();
	expect(errors).toEqual([]);
}, 600_000);
