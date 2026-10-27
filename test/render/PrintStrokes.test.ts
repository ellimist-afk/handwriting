/**
 * A HEAVILY INKED NOTE EXPORTED TO PDF OPENS FAST: THE PRINT LAYER DRAWS EVERY PEN STROKE AS ITS OWN PATH.
 *
 * The print layer (src/inline/EmbedInkPrint.ts, appendInk) folded consecutive strokes of one colour into one <path>.
 * Chromium writes each <path> as one PDF fill, so a page written in one colour printed as one fill holding every
 * stroke's outline, and a PDF reader drew that fill in seconds: Alan's Untitled 1 (5,795 strokes) took about 9 s in
 * Obsidian's pdf.js, the same shape the drawing PDF had before 2ba814de. Now every pen stroke is its own path; a
 * highlighter run stays one path (one wash, no dark seam where strokes cross). The drawing-only SVG export keeps
 * the fold (src/ink/SvgExport.test.ts holds it byte-equal).
 *
 * The note (printStrokesPage.ts): seeded rows of one-colour pen strokes and two highlighter strokes, mounted in the
 * Export to PDF shape and swapped to its print layer by beforeprint.
 *
 * Cells:
 * - the print layer holds one <path> per pen stroke and one for the highlighter run (always runs);
 * - opt-in, HW_PRINT_PDFJS=<folder holding pdf.min.mjs and pdf.worker.min.mjs, Obsidian's own pdf.js>: the note at
 *   Untitled 1's size is printed by page.pdf() and page 1 rendered at 1400 px wide in that pdf.js, three takes;
 *   the median is under 500 ms (it was over 5 s with the fold). HW_PRINT_OUT=<file> keeps the PDF.
 *
 * Run: npm run test:render -- PrintStrokes
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

const VIEW_CSS = `
body { margin: 0; font-family: sans-serif; }
.markdown-preview-view { font-size: 16px; line-height: 1.5; padding: 32px; position: relative; box-sizing: border-box; width: 100%; }
.markdown-rendered p { margin-block-start: 1rem; margin-block-end: 1rem; }
`;

declare const process: { env: Record<string, string | undefined> };

const PDFJS = process.env.HW_PRINT_PDFJS ?? "";
const HAVE_PDFJS = PDFJS !== "" && existsSync(`${PDFJS}/pdf.min.mjs`) && existsSync(`${PDFJS}/pdf.worker.min.mjs`);
if (!HAVE_PDFJS) console.log("SKIP the pdf.js cell: set HW_PRINT_PDFJS to a folder holding Obsidian's pdf.min.mjs and pdf.worker.min.mjs");

let browser: Browser;
let page: Page;
const errors: string[] = [];
beforeAll(async () => {
	const b = await build({ entryPoints: [fileURLToPath(new URL("./printStrokesPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) } });
	browser = await chromium.launch({ headless: true });
	page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addStyleTag({ content: VIEW_CSS });
	await page.addStyleTag({ content: readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8") });
	await page.addScriptTag({ content: b.outputFiles[0]!.text });
});
afterAll(async () => { await browser?.close(); });

it("print layer: one path per pen stroke, one for the highlighter run", async () => {
	const r = await page.evaluate(() => (window as any).mountPrint(20, 10));
	await page.evaluate(() => (window as any).endPrint());
	console.log("PRINT-STROKES dom", JSON.stringify(r));
	expect(r.layer, "the print layer was built").toBe(true);
	expect({ pen: r.penPaths, highlighter: r.highlighterPaths }).toEqual({ pen: r.penStrokes, highlighter: 1 });
	expect(errors).toEqual([]);
});

it.skipIf(!HAVE_PDFJS)("pdf.js: the exported page of 5,800 strokes renders at 1400 px wide in under 500 ms (median of three)", async () => {
	const t0 = Date.now();
	const r = await page.evaluate(() => (window as any).mountPrint(45, 129));
	const t1 = Date.now();
	await page.emulateMedia({ media: "print" });
	const pdf = await page.pdf({ format: "Letter", printBackground: true });
	const t2 = Date.now();
	if (process.env.HW_PRINT_OUT) writeFileSync(process.env.HW_PRINT_OUT, pdf);
	console.log("PRINT-STROKES stages", JSON.stringify({ mountMs: t1 - t0, pdfMs: t2 - t1, pdfBytes: pdf.length }));
	await page.emulateMedia({ media: "screen" });
	await page.evaluate(() => (window as any).endPrint());
	// The reader page is served by route: pdf.js as Obsidian ships it, and the PDF just printed.
	const files: Record<string, { contentType: string; body: string | typeof pdf }> = {
		"/pdf.min.mjs": { contentType: "text/javascript", body: readFileSync(`${PDFJS}/pdf.min.mjs`, "utf8") },
		"/pdf.worker.min.mjs": { contentType: "text/javascript", body: readFileSync(`${PDFJS}/pdf.worker.min.mjs`, "utf8") },
		"/note.pdf": { contentType: "application/pdf", body: pdf },
		"/h.html": { contentType: "text/html", body: `<script>window.activeWindow=window;window.activeDocument=document;</script><script type="module">
import * as pdfjs from "/pdf.min.mjs"; pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
window.measure = async () => { const doc = await pdfjs.getDocument({ url: "/note.pdf" }).promise; const pg = await doc.getPage(1);
  const vp0 = pg.getViewport({ scale: 1 }); const vp = pg.getViewport({ scale: 1400 / vp0.width });
  const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
  const a = performance.now(); await pg.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  const ms = performance.now() - a; await doc.destroy(); return ms; };
window.ready = true;</script>` },
	};
	const reader = await browser.newPage();
	await reader.route("http://print.test/**", (route) => {
		const f = files[new URL(route.request().url()).pathname];
		return f ? route.fulfill({ status: 200, contentType: f.contentType, body: f.body }) : route.fulfill({ status: 404 });
	});
	try {
		await reader.goto("http://print.test/h.html");
		await reader.waitForFunction(() => (window as any).ready === true);
		const takes: number[] = [];
		for (let i = 0; i < 3; i++) {
			takes.push(await reader.evaluate(() => (window as any).measure()));
			console.log("PRINT-STROKES take", i + 1, Math.round(takes[i]!));
		}
		const median = [...takes].sort((a, b) => a - b)[1]!;
		console.log("PRINT-STROKES pdfjs", JSON.stringify({ ...r, pdfBytes: pdf.length, takes: takes.map(Math.round), median: Math.round(median) }));
		expect(r.penStrokes).toBeGreaterThan(5000);
		expect(median, `render takes ${takes.map(Math.round).join(", ")} ms`).toBeLessThan(500);
	} finally {
		await reader.close();
	}
	expect(errors).toEqual([]);
}, 300_000);
