/**
 * INK IN READING VIEW IS DRAWN AT THE SIZE OF ITS TEXT.
 *
 * A note's ink is stored in world units: one px at the note's reference font, the editor font the note was first inked
 * at. The editor draws it at its current font over that reference, so ink grows and shrinks with the text. Reading
 * view drew world units at one px each whatever its text size: on Alan's three-paragraph note (reference 26 px, his
 * vault's text 12 px) the ink came out 2.17 times too large, and each stroke's distance under its line 2.17 times too
 * long, so the circle on paragraph 2 sat over paragraph 3 and the underline fell well below its words.
 *
 * The note and its three strokes are Alan's (fixtures/three-paragraph-note.md, fixtures/alan-ink-e5cb5010.json, copied
 * from his vault). Each case paints one stroke with the text at the reference size, where world units are px, and
 * again at the case's size; the second paint must be the first scaled by font over reference, about its anchor line's
 * top and the column's left: centre within 1 px, width and height within 2 px. At the reference size the picture is
 * the same as before, byte for byte; a note with no reference keeps one px per world unit.
 *
 * Regime: the real --force-device-scale-factor flag, 1 and 1.8257 (Orion's ratio), viewport from the window; never
 * deviceScaleFactor emulation.
 *
 * Run: npm run test:render -- ReadingViewInkFont.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import type { FontCase, FontNote } from "./readingViewInkFontPage";

/** Reading view geometry, as ReadingViewInk.test.ts lays it out; the text size is set per case on the view. */
const VIEW_CSS = `
body { margin: 0; font-family: sans-serif; }
.markdown-preview-view { font-size: 16px; line-height: 1.5; padding: 32px; position: relative; overflow-y: auto; box-sizing: border-box; width: 100%; }
.markdown-rendered > :first-child { margin-top: 0; }
.markdown-rendered p { margin-block-start: 1rem; margin-block-end: 1rem; }
.markdown-preview-sizer { max-width: 700px; margin: 0 auto; }
.inline-title { font-size: 2em; line-height: 1.2; font-weight: 700; margin-bottom: 0.5em; }
.metadata-container { padding: 8px 0; }
.metadata-property { height: 30px; }
.mod-frontmatter { display: none; }
`;

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
const NOTE: FontNote = { text: fixture("three-paragraph-note.md"), sidecar: fixture("alan-ink-e5cb5010.json") };
const STROKES = [["the circle on 'is second'", 0], ["the underline's short stroke", 1], ["the underline's long stroke", 2]] as const;
const ODD_DPR = 1.8257418870925903;

let script: string;
const browsers = new Map<number, Browser>();
const pages = new Map<number, Page>();
const errors: string[] = [];
beforeAll(async () => {
	const b = await build({ entryPoints: [fileURLToPath(new URL("./readingViewInkFontPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
}, 180_000);
afterAll(async () => { for (const b of browsers.values()) await b.close(); });

/** A page in a browser launched with the real device scale factor flag, viewport from the window. */
async function pageAt(dsf: number): Promise<Page> {
	const held = pages.get(dsf);
	if (held) return held;
	let b = browsers.get(dsf);
	if (!b) {
		b = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${dsf}`, "--window-size=900,1200"] });
		browsers.set(dsf, b);
	}
	const page = await (await b.newContext({ viewport: null })).newPage();
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addStyleTag({ content: VIEW_CSS });
	await page.addStyleTag({ content: readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8") });
	await page.addScriptTag({ content: script });
	pages.set(dsf, page);
	return page;
}

async function run(dsf: number, c: FontCase) {
	const page = await pageAt(dsf);
	return page.evaluate(([n, k]) => (window as any).fontCase(n, k), [NOTE, c] as const);
}

function expectScaled(r: any): void {
	expect(r.error, "a layer was painted").toBeUndefined();
	expect({ centreY: Math.abs(r.centreY) <= 1, centreX: Math.abs(r.centreX) <= 1, height: Math.abs(r.height) <= 2, width: Math.abs(r.width) <= 2 },
		`painted ${JSON.stringify(r.got)} want ${JSON.stringify(r.want)}`).toEqual({ centreY: true, centreX: true, height: true, width: true });
	expect(errors).toEqual([]);
}

it.each(STROKES)("reading view, text 12 px against a 26 px reference: %s is drawn at 12/26 of its size, on its line", async (name, stroke) => {
	const r = await run(1, { stroke, font: 12, ref: 26, view: "reading" });
	console.log("READING-VIEW-INK-FONT 12", name, JSON.stringify(r));
	expectScaled(r);
});

it.each(STROKES)("reading view, text 39 px against a 26 px reference: %s is drawn at 39/26 of its size, on its line", async (name, stroke) => {
	const r = await run(1, { stroke, font: 39, ref: 26, view: "reading" });
	console.log("READING-VIEW-INK-FONT 39", name, JSON.stringify(r));
	expectScaled(r);
});

it.each(STROKES)("reading view, text at the 26 px reference: %s is drawn as before", async (name, stroke) => {
	const r = await run(1, { stroke, font: 26, ref: 26, view: "reading" });
	console.log("READING-VIEW-INK-FONT 26", name, JSON.stringify(r));
	expectScaled(r);
});

it("reading view, a note with no reference at text 12 px: the circle keeps one px per world unit", async () => {
	const r = await run(1, { stroke: 0, font: 12, ref: null, view: "reading" });
	console.log("READING-VIEW-INK-FONT no reference", JSON.stringify(r));
	expectScaled(r);
});

it("reading view at device scale 1.8257, text 12 px against 26: the circle is drawn at 12/26 of its size, on its line", async () => {
	const r = await run(ODD_DPR, { stroke: 0, font: 12, ref: 26, view: "reading" });
	console.log("READING-VIEW-INK-FONT dpr", JSON.stringify(r));
	expect(r.dpr).toBeCloseTo(ODD_DPR, 3);
	expectScaled(r);
});

it.each(STROKES.slice(0, 1).concat(STROKES.slice(2)))("embed, text 12 px against a 26 px reference: %s is drawn at 12/26 of its size, on its line", async (name, stroke) => {
	const r = await run(1, { stroke, font: 12, ref: 26, view: "embed" });
	console.log("READING-VIEW-INK-FONT embed", name, JSON.stringify(r));
	expectScaled(r);
});
