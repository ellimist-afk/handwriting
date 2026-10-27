/**
 * THE PAGE SHAPE OF AN EXPORT TO PDF OF "UNTITLED 1", WITH AND WITHOUT THE EDITOR'S COLUMN. A measurement cell: it
 * changes nothing.
 *
 * Alan's Orion export of Untitled 1 at package-bd74a192 printed 5 Letter pages, the ink at full size and cut at the
 * right; the same note at 355ff932 printed one page, text and ink shrunk together (the 10-21 rule). The print fits the
 * note only when a column width is known (columnWidthFor), and the column comes from the editor showing the note. In
 * Reading view the editor is hidden.
 *
 * The note's text (lines after the frontmatter, one block each) and its 5,795 strokes are printed in the Export to PDF
 * shape: the screen call at beforeprint, then the media flips to print (the print-media call), then page.pdf() on
 * Letter with no margin, as the paper provider says. Three times: the editor's column given (700 px, the rig's width);
 * none and no view of the note; none with the note's own Reading view shown at a 700 px column (Alan's 10-23 export).
 *
 * Input: HW_SHAPE_DIR holds `Untitled 1.md` and `sidecar.json`. Output: HW_SHAPE_OUT (results.json, one pdf per case).
 * Run: npm run test:render -- ExportShape.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

declare const process: { env: Record<string, string | undefined> };

const IN = process.env.HW_SHAPE_DIR ?? "";
const OUT = process.env.HW_SHAPE_OUT ?? "";
const HAVE = IN !== "" && OUT !== "" && existsSync(`${IN}/Untitled 1.md`) && existsSync(`${IN}/sidecar.json`);
const TEXT = HAVE ? readFileSync(`${IN}/Untitled 1.md`, "utf8") : "";
const SIDECAR = HAVE ? readFileSync(`${IN}/sidecar.json`, "utf8") : "";

/**
 * Obsidian's print rules, verbatim from app.css 1.13.7 :3125-3150 (637090 bytes, sha256 f612f1e8...). At print media
 * everything but the print container is hidden: the editor and the Reading view both read width 0 then.
 */
const OBSIDIAN_PRINT_CSS = `
@media print {
  html,
  body {
    padding-top: 0 !important;
    overflow: auto !important;
    height: auto !important;
    contain: initial !important;
  }
  iframe,
  .titlebar,
  .app-container,
  .progress-bar,
  .popover,
  .markdown-embed-link,
  .suggestion-container,
  .cm-tooltip.cm-tooltip-autocomplete {
    display: none !important;
  }
  body > :not(.print) {
    display: none !important;
  }
  .print .markdown-preview-view {
    -webkit-print-color-adjust: exact;
    color: initial;
    height: unset !important;
  }
}
`;

let browser: Browser;
let page: Page;
const errors: string[] = [];
const results: Record<string, unknown> = {};

/** The text lines after the frontmatter, tabs dropped: the blocks Reading view prints. */
function bodyLines(text: string): string[] {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let i = 0;
	if (lines[0] === "---") {
		i = lines.indexOf("---", 1) + 1;
	}
	return lines.slice(i).map((l) => l.replace(/\t/g, "")).filter((l) => l.length > 0);
}

/** Pages in a Chromium PDF: page objects, not the page tree. */
function pageCount(pdf: Uint8Array): number {
	return (new TextDecoder("latin1").decode(pdf).match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

beforeAll(async () => {
	if (!HAVE) return;
	mkdirSync(OUT, { recursive: true });
	const b = await build({ entryPoints: [fileURLToPath(new URL("./exportShapePage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) } });
	browser = await chromium.launch({ headless: true });
	page = await browser.newPage({ viewport: { width: 900, height: 700 } });
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addStyleTag({ content: readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8") });
	await page.addStyleTag({ content: OBSIDIAN_PRINT_CSS });
	await page.addScriptTag({ content: b.outputFiles[0]!.text });
});
afterAll(async () => {
	if (HAVE) writeFileSync(`${OUT}/results.json`, JSON.stringify({ ...results, errors }, null, 1));
	await browser?.close();
});

/** The unpinched editor's export: a Reading view export must lay the page out exactly as it does. */
let unpinched: { pages: number; screen: any; print: any } | null = null;
const shape = (read: any) => ({ zoom: read.zoom, width: read.width, paddingLeft: read.paddingLeft, paddingTop: read.paddingTop, minHeight: read.minHeight, rootBox: read.rootBox, layer: read.layer });

async function exportCase(name: string, column: number | null, reading = false, columnAtPrint = true): Promise<{ pages: number; screen: any; print: any }> {
	await page.emulateMedia({ media: "screen" });
	await page.evaluate(([l, c, r, a]) => (window as any).shapeMount(l, c, r, a), [bodyLines(TEXT), column, reading, columnAtPrint] as const);
	const screen = await page.evaluate(() => (window as any).shapeRead());
	await page.emulateMedia({ media: "print" });
	const print = await page.evaluate(() => (window as any).shapeRead());
	const pdf = await page.pdf({ format: "Letter", printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
	writeFileSync(`${OUT}/${name}.pdf`, pdf);
	await page.evaluate(() => (window as any).shapeEnd());
	await page.emulateMedia({ media: "screen" });
	const pages = pageCount(pdf);
	results[name] = { column, reading, columnAtPrint, pages, bytes: pdf.length, screen, print };
	return { pages, screen, print };
}

it.skipIf(!HAVE)("loads the sidecar", async () => {
	const r = await page.evaluate((s) => (window as any).shapeLoad(s), SIDECAR);
	results.load = { ...r, lines: bodyLines(TEXT).length };
	expect(r.strokes).toBe(5795);
	expect(r.noteCanvas).toBe(true);
});

it.skipIf(!HAVE)("the editor's column given: pages and shape", async () => {
	const r = await exportCase("column-700", 700);
	expect(r.pages).toBe(1);
});

it.skipIf(!HAVE)("an editor not pinched (its column null once the print media hides it): pages and shape", async () => {
	const r = await exportCase("editor-unpinched", 700, false, false);
	expect(r.pages).toBe(1);
	unpinched = r;
});

it.skipIf(!HAVE)("no editor column and no view of the note: pages and shape", async () => {
	const r = await exportCase("column-none", null);
	expect(r.pages).toBeGreaterThan(0);
	expect(errors).toEqual([]);
});

it.skipIf(!HAVE)("exported from Reading view (editor hidden, its column null): one page, text and ink fitted together", async () => {
	const r = await exportCase("reading-view", null, true);
	expect(r.pages).toBe(1);
	expect(r.print.zoom).not.toBe("");
	// Read after the media flipped: the Reading view is hidden then, so the fallback has no answer at the print-media call.
	expect(r.screen.readingColumnFor).toBe(700);
	// The same layout as the editor's export at the same column, at both calls: the zoom, the reach padding that keeps
	// ink left of and above the text on the page, the container's box and the layer.
	expect(unpinched).not.toBeNull();
	expect(shape(r.screen)).toEqual(shape(unpinched!.screen));
	expect(shape(r.print)).toEqual(shape(unpinched!.print));
	expect(errors).toEqual([]);
});
