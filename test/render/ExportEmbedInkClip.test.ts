/**
 * AN EMBED'S INK IS CUT AT THE EMBED'S BOX IN AN EXPORT, AS IT IS ON SCREEN.
 *
 * A note embeds another whose ink sits on blank lines above its first line of text. A rendered view folds those blank
 * lines, and a stroke anchored on a blank line is drawn the blank lines' height above the block below it
 * (EmbedInkLines.ts lineTopIn), so the embedded note's ink lands above the embed's box. On screen Obsidian's embed box
 * clips it (`.inline-embed > .markdown-embed-content`: a max height and `overflow: auto`, app.css:11948-11952) and
 * nothing shows. The export's print rules drop that clip (`.print .markdown-preview-view .markdown-embed-content`: no
 * max height, `overflow: visible`, app.css:3157-3160), so the exported PDF drew the embedded note's ink over the host
 * note's typed lines above the embed. The export now clips an embed's ink layer to the embed's box, as the screen does.
 *
 * The page: a host note's print container (div.print > .markdown-preview-view, no sizer) with four typed lines, then
 * an embed of a note whose text starts on its line 14 after ten blank lines. Two strokes in the embedded note: a magenta
 * one anchored on blank line 6, which the placement puts eight rows above the embed's first block, so above the embed
 * box and over the host's lines; and a blue one anchored on the embed's second line of text, inside the box. The same
 * page is built without the print wrapper as the live embed. Each case counts the magenta rows painted above the embed
 * box and the blue rows inside it, for the canvas (an export that fires no print event) and for the vector layer a
 * print swaps in, and reads the embed root's and the host root's computed overflow.
 *
 * The page's geometry comes from Obsidian's real stylesheet: every rule below is a verbatim slice of app.css 1.13.7
 * (637090 bytes, sha256 f612f1e8f36486fa57f3b8bd45f0c848409d5b168002e757a13c6d286a7b4c41), cited by line, plus this
 * plugin's own styles.css. The print rules are applied as plain rules, as in ExportPrintClip.test.ts: they are scoped
 * by the `.print` wrapper, which only the export builds.
 *
 * Run: npm run test:render -- ExportEmbedInkClip.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { decodePng } from "./pngInk";

const OBSIDIAN_CSS = `
/* app.css:3190-3192 */
* {
  box-sizing: border-box;
}
/* app.css:2240-2244 */
body {
  --file-line-width: 700px;
  --file-folding-offset: 24px;
  --file-margins: var(--file-margins-y) var(--file-margins-x);
  --file-margins-x: var(--size-4-8);
  --file-margins-y: var(--size-4-8);
}
/* app.css:2577, 2321, 2002, 2662, 3122, 2220 (custom properties the rules below read) */
body { --p-spacing: 1rem; --line-height-normal: 1.5; --size-4-8: 32px; --font-text-size: 16px; --embed-max-height: 4000px; }
/* app.css:4464-4478 */
.markdown-preview-view {
  font-size: var(--font-text-size);
  font-family: var(--font-text);
  line-height: var(--line-height-normal);
  width: 100%;
  height: 100%;
  padding: var(--file-margins);
  position: relative;
  overflow-y: auto;
  overflow-wrap: break-word;
  color: var(--text-normal);
  user-select: text;
  -webkit-user-select: text;
  scrollbar-gutter: stable;
}
/* app.css:4495-4500 */
.markdown-rendered > :first-child {
  margin-top: 0;
}
.markdown-rendered > :last-child {
  margin-bottom: 0;
}
/* app.css:14167-14171 */
.markdown-rendered p {
  margin-block-start: var(--p-spacing);
  margin-block-end: var(--p-spacing);
  unicode-bidi: plaintext;
}
/* app.css:11763-11767 */
.markdown-preview-view .markdown-embed .markdown-preview-view {
  --file-folding-offset: 0px;
  height: 100%;
  padding: 0;
}
/* app.css:11841-11844 */
.markdown-embed,
.file-embed {
  position: relative;
}
/* app.css:11905-11907 */
.markdown-embed-content {
  height: 100%;
}
/* app.css:11928-11933 */
.markdown-embed .markdown-preview-view {
  padding: 0;
}
.internal-embed:not(.image-embed) {
  display: block;
}
/* app.css:11948-11952 */
.inline-embed > .markdown-embed-content {
  height: fit-content;
  max-height: var(--embed-max-height);
  overflow: auto;
}
/* app.css:3126-3132, inside @media print at 3125 (applied as plain rules: the export prints this window) */
html,
body {
  padding-top: 0 !important;
  overflow: auto !important;
  height: auto !important;
  contain: initial !important;
}
/* app.css:3146-3150, same @media print block */
.print .markdown-preview-view {
  -webkit-print-color-adjust: exact;
  color: initial;
  height: unset !important;
}
/* app.css:3157-3160, same @media print block */
.print .markdown-preview-view .markdown-embed-content {
  max-height: none;
  overflow: visible;
}
`;

const PAGE = `
import { attachEmbedInkOnceReady, initEmbedInkRefresh, teardownEmbedInk } from "../../src/inline/EmbedInk";
import { aboveOf, lineKey, newAboveRun } from "../../src/inline/LineAnchor";
import { installObsidianDom } from "./obsidianDom";

installObsidianDom();
const proto = HTMLElement.prototype;
proto.setCssStyles ??= function (s) { for (const k of Object.keys(s)) this.style[k] = s[k]; };
window.createDiv ??= () => document.createElement("div");

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const r2 = v => Math.round(v * 100) / 100;

// The embedded note: frontmatter, ten blank lines, two lines of text (0-based 13 and 14), two blank lines.
const NOTE = ["---", "tags: organic", "---", "", "", "", "", "", "", "", "", "", "",
	"Sn1 - the stability of the carbocation decides the rate", "Sn2 - more alkyl groups make it slower", "", ""];
const TEXT = NOTE.join("\\n");
const EDITOR_LINE = 24;
const editorTop = line => (line - 4) * EDITOR_LINE;

/** One horizontal stroke 120 px long at editor y, anchored to 1-based \`line\`. */
function stroke(id, color, line) {
	const y = editorTop(line) + 10, pad = 4;
	const points = Array.from({ length: 16 }, (_, j) => ({ x: 40 + j * 8, y, pressure: 0.5, t: j * 9 }));
	const bbox = { x: 40 - pad, y: y - pad, width: 120 + 2 * pad, height: 2 * pad };
	return { id, tool: "pen", color, width: 3, createdAt: 0, points, bbox,
		lineAnchor: { line, top: editorTop(line), y: bbox.y, key: lineKey(NOTE[line - 1]), width: 668, fontPx: 16,
			above: aboveOf(newAboveRun(), line, k => lineKey(NOTE[k - 1])) } };
}

let open = null;

/**
 * The host note with four typed lines, then the embed. print: inside div.print (the export's container), else the live
 * embed in a reading view without the print wrapper. mode "svg" dispatches beforeprint (the print swap); "canvas" fires
 * no print event.
 */
window.embedClip = async (print, mode) => {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "theme-light";
	const outer = document.body.appendChild(document.createElement("div"));
	if (print) outer.className = "print";
	const host = outer.appendChild(document.createElement("div")); host.className = "markdown-preview-view markdown-rendered";
	for (let i = 1; i <= 4; i++) { const d = host.appendChild(document.createElement("div")); d.innerHTML = "<p>Host line " + i + " typed above the embed.</p>"; }
	const wrap = host.appendChild(document.createElement("div"));
	const embed = wrap.appendChild(document.createElement("span")); embed.className = "internal-embed markdown-embed inline-embed is-loaded"; embed.setAttribute("src", "Organic");
	const content = embed.appendChild(document.createElement("div")); content.className = "markdown-embed-content";
	const view = content.appendChild(document.createElement("div")); view.className = "markdown-preview-view markdown-rendered";
	const sections = [];
	for (const line of [13, 14]) {
		const el = view.appendChild(document.createElement("div")); el.innerHTML = "<p>" + NOTE[line] + "</p>";
		sections.push({ el, lineStart: line, lineEnd: line });
	}
	await frame();
	const strokes = [stroke("above", "#ff00ff", 6), stroke("inside", "#0000ff", 15)];
	initEmbedInkRefresh(() => strokes);
	for (const s of sections) {
		attachEmbedInkOnceReady(s.el, view, "Organic.md", () => strokes, undefined, false, {
			section: () => ({ text: TEXT, lineStart: s.lineStart, lineEnd: s.lineEnd }),
			cached: () => null,
		});
	}
	await frame(); await frame();
	if (mode === "svg") { window.dispatchEvent(new Event("beforeprint")); await frame(); await frame(); }
	open = { mode };
	const layer = content.querySelector(mode === "svg" ? ":scope > svg.handwriting-embed-ink" : ":scope > canvas.handwriting-embed-ink");
	if (!layer) return { error: "no " + mode + " layer on the embed root" };
	const lr = layer.getBoundingClientRect(), cr = content.getBoundingClientRect(), hr = host.getBoundingClientRect();
	const lastHost = host.children[3].getBoundingClientRect();
	const firstEmbed = sections[0].el.getBoundingClientRect();
	return {
		layerTop: r2(lr.top), embedTop: r2(cr.top), embedBottom: r2(cr.bottom), hostTop: r2(hr.top), lastHostLineBottom: r2(lastHost.bottom),
		firstEmbedBlockTop: r2(firstEmbed.top),
		embedOverflowY: getComputedStyle(content).overflowY, embedOverflowX: getComputedStyle(content).overflowX,
		hostOverflowY: getComputedStyle(host).overflowY, hostOverflowX: getComputedStyle(host).overflowX,
		// Above the embed box: from the host's top to one px above the embed's top. Inside: the embed's box.
		above: { x: Math.floor(cr.left), y: Math.floor(hr.top), width: Math.ceil(cr.width), height: Math.max(1, Math.floor(cr.top - hr.top) - 1) },
		inside: { x: Math.floor(cr.left), y: Math.ceil(cr.top), width: Math.ceil(cr.width), height: Math.max(1, Math.floor(cr.height)) },
	};
};

/** End a print the last call started, if it started one. */
window.embedClipEnd = async () => {
	if (open && open.mode === "svg") { window.dispatchEvent(new Event("afterprint")); await frame(); }
	open = null;
};
`;

let browser: Browser;
let page: Page;
const errors: string[] = [];
beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "exportEmbedInkClipPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) } });
	browser = await chromium.launch({ headless: true });
	page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
	page.on("pageerror", error => errors.push(error.message));
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addStyleTag({ content: OBSIDIAN_CSS });
	await page.addStyleTag({ content: readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8") });
	await page.addScriptTag({ content: b.outputFiles[0]!.text });
});
afterAll(async () => { await browser?.close(); });

type Box = { x: number; y: number; width: number; height: number };

/** Rows of a screenshot box with at least one pixel of the colour: magenta (#ff00ff) or blue (#0000ff). Both keep 3:1 on
 * white, so the print path emits them unchanged (exportInkColor darkens a lighter colour, which a cyan would be). */
async function rowsOf(box: Box, colour: "magenta" | "blue"): Promise<number> {
	const d = decodePng(await page.screenshot({ clip: box }));
	let rows = 0;
	for (let y = 0; y < d.height; y++) {
		for (let x = 0; x < d.width; x++) {
			const o = (y * d.width + x) * d.channels;
			const r = d.px[o]!, g = d.px[o + 1]!, b = d.px[o + 2]!;
			const hit = colour === "magenta" ? r >= 200 && g <= 100 && b >= 200 : r <= 100 && g <= 100 && b >= 200;
			if (hit) { rows++; break; }
		}
	}
	return rows;
}

async function run(print: boolean, mode: "canvas" | "svg") {
	const r = await page.evaluate(([p, m]) => (window as any).embedClip(p, m), [print, mode] as const);
	const counts = r.error ? null : { magentaAbove: await rowsOf(r.above, "magenta"), blueInside: await rowsOf(r.inside, "blue") };
	await page.evaluate(() => (window as any).embedClipEnd());
	return { ...r, ...counts };
}

const PRINT_CASES: Array<[string, "canvas" | "svg"]> = [
	["export, canvas, no print event", "canvas"],
	["export, vector print layer", "svg"],
];

it.each(PRINT_CASES)("%s: the embedded note's ink above its first line is cut at the embed's box, its ink inside still prints", async (name, mode) => {
	const r = await run(true, mode);
	console.log("EXPORT-EMBED-INK-CLIP", name, JSON.stringify(r));
	expect(r.error, "the page built and painted a layer on the embed root").toBeUndefined();
	// The fixture is the bug's case: the layer starts above the embed box, over the host's typed lines.
	expect(r.layerTop, "the anchored ink is placed above the embed box").toBeLessThan(r.embedTop - 100);
	expect(r.layerTop, "and over the host's typed lines").toBeLessThan(r.lastHostLineBottom);
	expect(r.magentaAbove, "rows of the embedded note's ink painted above the embed box, over the host's text").toBe(0);
	expect(r.blueInside, "rows of the embedded note's ink painted inside the embed box").toBeGreaterThan(0);
	// Only the embed root clips, and only on the vertical: the host's print container keeps Obsidian's overflow.
	expect([r.embedOverflowY, r.embedOverflowX]).toEqual(["clip", "visible"]);
	expect([r.hostOverflowY, r.hostOverflowX]).toEqual(["auto", "auto"]);
	expect(errors).toEqual([]);
});

it("the live embed (no print wrapper) is unchanged: Obsidian's box clips the ink above, the ink inside shows", async () => {
	const r = await run(false, "canvas");
	console.log("EXPORT-EMBED-INK-CLIP live embed", JSON.stringify(r));
	expect(r.error).toBeUndefined();
	expect(r.layerTop, "the same placement as the export").toBeLessThan(r.embedTop - 100);
	expect(r.magentaAbove).toBe(0);
	expect(r.blueInside).toBeGreaterThan(0);
	expect([r.embedOverflowY, r.embedOverflowX]).toEqual(["auto", "auto"]);
	expect(errors).toEqual([]);
});
