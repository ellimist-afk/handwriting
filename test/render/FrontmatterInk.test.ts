/**
 * INK ON A NOTE'S BODY MOVES AS ONE WITH THE BODY TEXT WHEN THE FRONTMATTER IS SHOWN ANOTHER WAY.
 *
 * Seen on the rig vault's ATMS note with Properties in document = Source: the first row of ink stayed on the opening `---`
 * while the second row dropped three lines with the text. The editor hides the frontmatter lines in Visible and Hidden, so
 * they share the first body line's top, and the line under a stroke on that body line was read as the first of them.
 *
 * A frontmatter display change is not a text change: each stroke keeps its offset to the body line it was drawn on, in every
 * one of the three views. The default view (Visible) does not change, saved ink included, and opening a note never writes
 * its ink file: a saved anchor's stored line may change, but only in a save made for another reason.
 *
 * The note is in the ATMS shape: four blank lines, then a paragraph. Strokes on body lines 0 and 1 and on the paragraph
 * (body line 4). Body line n is the nth line under the frontmatter, 0-based. Every cell draws or opens in Visible, then
 * switches to Source, to Hidden and back to Visible.
 *  - A: no frontmatter; draw; the plugin writes its page id at the top (the first stroke's claim).
 *  - B: page-id-only frontmatter first; draw.
 *  - C: saved ink whose first-body-line stroke is anchored to line 1 (the opening fence), as an older build saved it under
 *    hidden frontmatter; opened.
 *  - D: the same saved ink opened: through the open and all three switches the ink file and the note are not written.
 *  - E: page-id-only frontmatter; a stroke drawn from above body line 0 (its top above the line, a negative offset), with
 *    strokes on body line 0 and the paragraph beside it.
 * A switch is a display switch (the Properties in document setting), never a text edit: a decoration and block change with no
 * document change. Every check compares numbers the surface reports (each stroke's page y plus its line correction against
 * its line's top, editor px), never pixels.
 * Pass: after each switch each stroke's offset to its body line equals its first Visible offset within 1 px. In A to C the
 * strokes sit at one offset to their lines within 0.5 px in Visible (each was drawn at the same place on its line), and in C
 * each stroke sits where the saving mount showed it within 0.5 px. In E the stroke drawn from above keeps a negative offset.
 * Every row is written to HW_FRONTMATTER_INK_REPORT when set, so the Visible rows can be compared tree against tree (the
 * default view equals the tree before the fix within 0.5 px).
 *
 * Run: npx vitest run --config vitest.render.mts FrontmatterInk
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";

declare const process: { env: Record<string, string | undefined> };

const PAGE_ID = "5b0f6c1e-9a7d-4c2b-8e3f-1d2a3b4c5d6e";
const FRONTMATTER = `---\nhandwriting-page-id: ${PAGE_ID}\n---\n`;
const BODY = "\n\n\n\nAll the materials we use are made of atoms, and the way those atoms are held together decides how the material behaves under load.\nA second paragraph line.\n";
const STROKES_ON = [0, 1, 4];
const SWITCHES = ["source", "hidden", "visible"] as const;
const PANE = { w: 900, h: 700 };
const REPORT = process.env.HW_FRONTMATTER_INK_REPORT ?? "";

let browser: Browser;
let bundle = "";
const report: Record<string, unknown> = {};
const errors: string[] = [];

type Row = { body: number; docLine: number; anchorLine: number | null; anchorText: string | null; offset: number; dy: number };
type Read = { mode: string; rows: Row[]; sidecarWrites: number; sidecar: string | null; text: string };

beforeAll(async () => {
	const b = await build({ entryPoints: [fileURLToPath(new URL("./frontmatterInkPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	bundle = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	if (REPORT) writeFileSync(REPORT, JSON.stringify({ report, errors }, null, 1));
	await browser?.close();
});

async function fresh(): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: PANE.w, height: PANE.h }, deviceScaleFactor: 1 });
	page.on("pageerror", (e) => errors.push(e.message));
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addStyleTag({ content: css });
	await page.addScriptTag({ content: bundle });
	return page;
}
const call = (page: Page, fn: string, arg: unknown) => page.evaluate(([f, a]) => (window as any)[f](a), [fn, arg] as const) as Promise<any>;
/** The report keeps every row; the ink file's bytes and the note text are kept as lengths only. */
const log = (name: string, v: any) => {
	const kept = v && typeof v === "object" && "sidecar" in v ? { ...v, sidecar: v.sidecar?.length ?? null, text: v.text?.length ?? null } : v;
	report[name] = kept;
	console.log("FRONTMATTER-INK", name, JSON.stringify(kept));
};

/** The first Visible read, then one read after each switch: Source, Hidden, Visible again. */
async function allSwitches(page: Page, cell: string, bodyLines: number[]): Promise<{ def: Read; after: Read[] }> {
	const def = await call(page, "fmRead", bodyLines) as Read;
	log(`${cell}.visible`, def);
	const after: Read[] = [];
	for (const m of SWITCHES) {
		await call(page, "fmMode", m);
		const r = await call(page, "fmRead", bodyLines) as Read;
		log(`${cell}.${m}${m === "visible" ? "-again" : ""}`, r);
		after.push(r);
	}
	return { def, after };
}

/** After every switch each row's offset against its first Visible offset. */
function expectKeepsOffsets(cell: string, def: Read, after: Read[]): void {
	for (const r of after) {
		expect(r.rows.length, `${cell}: strokes in ${r.mode}`).toBe(def.rows.length);
		for (let i = 0; i < def.rows.length; i++) {
			const d = def.rows[i]!, s = r.rows[i]!;
			expect(Math.abs(s.offset - d.offset), `${cell}: ${r.mode}, body line ${d.body} offset ${s.offset} against ${d.offset} in Visible (anchor line ${s.anchorLine} "${s.anchorText}")`).toBeLessThanOrEqual(1);
		}
	}
}

/** In Visible the strokes drawn alike sit at one offset to their lines. */
function expectOneOffset(cell: string, def: Read): void {
	expect(def.rows.length, `${cell}: strokes`).toBe(STROKES_ON.length);
	const first = def.rows[0]!.offset;
	for (const r of def.rows) expect(Math.abs(r.offset - first), `${cell}: Visible, body line ${r.body} offset ${r.offset} against ${first}`).toBeLessThanOrEqual(0.5);
}

/** Draw on page-id-only frontmatter, read, and write the saved page with the first body line's stroke on the fence. */
async function savedOnTheFence(cell: string): Promise<{ saved: Read; sidecar: string }> {
	const first = await fresh();
	log(`${cell}.save.mount`, await call(first, "fmMount", { text: FRONTMATTER + BODY, paneW: PANE.w, paneH: PANE.h }));
	log(`${cell}.save.draw`, await call(first, "fmDraw", STROKES_ON));
	const saved = await call(first, "fmRead", STROKES_ON) as Read;
	log(`${cell}.save.visible`, saved);
	const legacy = await call(first, "fmSavedLegacy", STROKES_ON[0]);
	log(`${cell}.saved`, { rewritten: legacy.rewritten, anchors: legacy.anchors, error: legacy.error });
	expect(legacy.error).toBeUndefined();
	expect(legacy.anchors[0]?.line, `${cell}: the first body line's stroke saved with the fence anchor`).toBe(1);
	expect(legacy.rewritten, `${cell}: strokes saved with the fence anchor`).toBeGreaterThanOrEqual(1);
	await first.close();
	return { saved, sidecar: legacy.sidecar };
}

it("A: no frontmatter, draw, the page id is written at the top, then every view", async () => {
	const page = await fresh();
	log("A.mount", await call(page, "fmMount", { text: BODY, paneW: PANE.w, paneH: PANE.h }));
	const drew = await call(page, "fmDraw", STROKES_ON);
	log("A.draw", drew);
	expect(drew.claimWrites, "A: the page id was written into the note").toBe(1);
	const { def, after } = await allSwitches(page, "A", STROKES_ON);
	expect(errors, "page errors").toEqual([]);
	expectOneOffset("A", def);
	expectKeepsOffsets("A", def, after);
	await page.close();
}, 120_000);

it("B: page-id-only frontmatter first, draw, then every view", async () => {
	const page = await fresh();
	log("B.mount", await call(page, "fmMount", { text: FRONTMATTER + BODY, paneW: PANE.w, paneH: PANE.h }));
	log("B.draw", await call(page, "fmDraw", STROKES_ON));
	const { def, after } = await allSwitches(page, "B", STROKES_ON);
	expect(errors, "page errors").toEqual([]);
	expectOneOffset("B", def);
	expectKeepsOffsets("B", def, after);
	await page.close();
}, 120_000);

it("C: saved ink anchored to the opening fence under page-id-only frontmatter, opened, then every view", async () => {
	const { saved, sidecar } = await savedOnTheFence("C");
	const page = await fresh();
	log("C.mount", await call(page, "fmMount", { text: FRONTMATTER + BODY, sidecar, paneW: PANE.w, paneH: PANE.h }));
	const { def, after } = await allSwitches(page, "C", STROKES_ON);
	// The saved fence anchor survives the load as a screen fact: each stroke shows where the saving mount showed it.
	for (let i = 0; i < saved.rows.length; i++) {
		const was = saved.rows[i]!, now = def.rows[i]!;
		expect(Math.abs(now.offset - was.offset), `C: Visible, body line ${was.body} offset ${now.offset} against ${was.offset} when saved`).toBeLessThanOrEqual(0.5);
	}
	expect(errors, "page errors").toEqual([]);
	expectOneOffset("C", def);
	expectKeepsOffsets("C", def, after);
	await page.close();
}, 180_000);

it("C2: saved ink anchored to the opening fence, opened first in Source, then Visible", async () => {
	const { saved, sidecar } = await savedOnTheFence("C2");
	const page = await fresh();
	log("C2.mount", await call(page, "fmMount", { text: FRONTMATTER + BODY, sidecar, paneW: PANE.w, paneH: PANE.h, mode: "source" }));
	const src = await call(page, "fmRead", STROKES_ON) as Read;
	log("C2.source-first", src);
	await call(page, "fmMode", "visible");
	const vis = await call(page, "fmRead", STROKES_ON) as Read;
	log("C2.visible", vis);
	for (let i = 0; i < saved.rows.length; i++) {
		const was = saved.rows[i]!, now = vis.rows[i]!;
		expect.soft(Math.abs(now.offset - was.offset), `C2: Visible after a Source open, body line ${was.body} offset ${now.offset} against ${was.offset} when saved`).toBeLessThanOrEqual(0.5);
	}
	for (let i = 0; i < src.rows.length; i++) {
		const was = saved.rows[i]!, now = src.rows[i]!;
		expect.soft(Math.abs(now.offset - was.offset), `C2: Source first, body line ${was.body} offset ${now.offset} against ${was.offset} when saved (anchor line ${now.anchorLine})`).toBeLessThanOrEqual(1);
	}
	expect(errors, "page errors").toEqual([]);
	await page.close();
}, 180_000);

it("D: the same saved ink opened and shown every way writes neither the ink file nor the note", async () => {
	const { sidecar } = await savedOnTheFence("D");
	const page = await fresh();
	const text = FRONTMATTER + BODY;
	log("D.mount", await call(page, "fmMount", { text, sidecar, paneW: PANE.w, paneH: PANE.h }));
	const { def, after } = await allSwitches(page, "D", STROKES_ON);
	expect(errors, "page errors").toEqual([]);
	for (const r of [def, ...after]) {
		expect(r.sidecarWrites, `D: ink file writes after the open, in ${r.mode}`).toBe(0);
		expect(r.sidecar === sidecar, `D: the ink file's bytes are the saved bytes, in ${r.mode}`).toBe(true);
		expect(r.text === text, `D: the note's text is the saved text, in ${r.mode}`).toBe(true);
	}
	await page.close();
}, 180_000);

it("E: a stroke drawn from above the first body line keeps its negative offset in every view", async () => {
	const page = await fresh();
	log("E.mount", await call(page, "fmMount", { text: FRONTMATTER + BODY, paneW: PANE.w, paneH: PANE.h }));
	log("E.draw", await call(page, "fmDraw", ["above:0", 0, 4]));
	const { def, after } = await allSwitches(page, "E", [0, 0, 4]);
	expect(errors, "page errors").toEqual([]);
	expect(def.rows.length, "E: strokes").toBe(3);
	const above = def.rows[0]!;
	expect(above.offset, `E: the stroke drawn from above body line 0 shows above it in Visible (offset ${above.offset})`).toBeLessThan(0);
	expectKeepsOffsets("E", def, after);
	await page.close();
}, 120_000);
