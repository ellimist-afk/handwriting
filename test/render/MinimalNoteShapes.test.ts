/**
 * The note-shape sweep: does `contentOriginLeft`'s twelve-child scan ever
 * return an edge that is NOT the text column, under real Minimal rules?
 *
 * 1.4.9 replaced `.cm-content`'s own left with the left of the text COLUMN,
 * measured from the leading `.cm-line` children, because Minimal centres the
 * lines and leaves `.cm-content` full width (`ContentOrigin.ts`,
 * `ContentOriginColumn.test.ts`). That measurement is a scan: at most twelve
 * children, `.cm-line`s preferred, degenerate rects skipped, maximum left
 * wins. Each of those four decisions is a bet about what a note looks like,
 * and this file is the sweep that collects the notes where a bet loses.
 *
 * WHAT DECIDES A VERDICT. `error = originLeft - columnLeft`, where
 * `columnLeft` is measured from an ordinary prose line in a RULER pane of the
 * same width, built by the same code, under the same cascade (see
 * `shapesPage.ts`). `|error| > 1px` is a defect: the overlay paints
 * `screen_x = origin + x * scale`, so every px of error is a px of ink
 * sitting off its words. Every shape long enough for it also carries a prose
 * line PAST the scan window, and the first test asserts that line and the
 * ruler agree - if they ever disagree the ruler is lying and no verdict below
 * means anything.
 *
 * SOURCE OF THE MINIMAL RULES. Hand-copied, verbatim, from
 * `C:\Users\alanl\Obsidian\ObsidianVaults\vault test 2\.obsidian\themes\Minimal\theme.css`
 * (Minimal 9.0.2, 8709 lines on disk), citing line ranges the way
 * `ContentOriginColumn.test.ts` does, and from `@codemirror/view`'s own base
 * theme in `node_modules` for the two CodeMirror-owned elements the sweep
 * includes. What is OMITTED and why: every `.markdown-preview-view` arm (that
 * is reader mode, which has no `contentDOM`), the `.is-mobile`, `.max`,
 * `.cards`, `.callouts-outlined` and `maximize-tables-*` modifier arms (not
 * applied by any shape here), and `.cm-content`'s flex declarations (the
 * fixture's `.cm-scroller` is not a flex container, so they would resolve to
 * nothing).
 *
 * PARAMETERS, not measurements: the root font size (16px, so `40rem` is
 * 640px), the pane width (1400px unless a shape says otherwise), and the fact
 * that Obsidian's own app.css applies a border-box reset. Change one and the
 * numbers below change; that is what makes them parameters.
 *
 * Run: npm run test:render.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import type { ChildKind, ShapeReading, ShapeRequest } from "./shapesPage";
import originSource from "../../src/inline/ContentOrigin.ts?raw";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/* -------------------------------------------------------------------------
 * The cascade under test.
 * ---------------------------------------------------------------------- */

/**
 * Obsidian's app.css border-box reset (stated as a parameter by
 * `harness.ts`), plus the root font size `40rem` is resolved against.
 */
const RESET_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html { font-size: 16px; }
body { margin: 0; }
`;

/**
 * `@codemirror/view/dist/index.js:6537-6563` (baseTheme) - the declarations
 * that give `.cm-content` and `.cm-line` their boxes, and
 * `:6712-6717` for the widget buffer, whose `width: 0` is the reason a
 * buffer is degenerate rather than a column-width child.
 */
const CM_BASE_CSS = `
.cm-content {
  margin: 0;
  display: block;
  white-space: pre;
  word-wrap: normal;
  box-sizing: border-box;
  min-height: 100%;
  padding: 4px 0;
}
.cm-lineWrapping {
  white-space: break-spaces;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.cm-line { display: block; padding: 0 2px 0 6px; }
.cm-widgetBuffer { vertical-align: text-top; height: 1em; width: 0; display: inline; }
`;

/** theme.css:53,56 and theme.css:583 - the lengths everything else is built from. */
const LINE_WIDTH_VARS = `
body { --line-width: 40rem; --max-width: 88%; }
body { --line-width-wide: calc(var(--line-width) + 12.5%); }
`;

/** theme.css:1831-1838 - the margins that centre a column child. */
const CONTENT_MARGIN_VARS = `
body {
  --content-margin: auto;
  --content-margin-start: max(
    calc(50% - var(--line-width)/2),
    calc(50% - var(--max-width)/2) );
  --content-line-width: min(var(--line-width), var(--max-width));
}
`;

/**
 * theme.css:1852-1867. The root of the 1.4.9 defect: `.cm-content` is forced
 * full width and the LINE `div`s inside it are centred instead.
 */
const COLUMN_RULE = `
.markdown-source-view.mod-cm6.is-readable-line-width .cm-content,
.markdown-source-view.mod-cm6.is-readable-line-width .cm-sizer {
  max-width: 100%;
  width: 100%;
}
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > div {
  max-width: var(--max-width);
  width: var(--line-width);
  margin-inline: var(--content-margin) !important;
}
`;

/**
 * theme.css:1868-1871. The arm for NON-`div` children - an `img` child, a
 * widget buffer. It sets a start margin rather than centring, which is the
 * same left edge in LTR and the mirror of it in RTL.
 */
const NON_DIV_RULE = `
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > *:not(div) {
  max-width: var(--content-line-width);
  margin-inline-start: var(--content-margin-start) !important;
}
`;

/**
 * theme.css:1923-1948 - the per-container width variables, and theme.css:
 * 1951-1959 for the `wide` per-note cssclass that overrides `--line-width`
 * itself.
 */
const BLOCK_VARS = `
body {
  --container-table-max-width: var(--max-width);
  --table-max-width: none;
  --table-width: auto;
  --table-margin: inherit;
  --table-wrapper-width: fit-content;
  --container-dataview-table-width: var(--line-width);
  --container-img-width: var(--line-width);
  --container-img-max-width: var(--max-width);
  --img-max-width: 100%;
  --img-width: auto;
  --img-margin-start: var(--content-margin-start);
  --img-line-width: var(--content-line-width);
  --container-iframe-width: var(--line-width);
  --container-iframe-max-width: var(--max-width);
}
body .wide {
  --line-width: var(--line-width-wide);
  --container-table-width: var(--line-width-wide);
  --container-dataview-table-width: var(--line-width-wide);
  --container-img-width: var(--line-width-wide);
  --container-iframe-width: var(--line-width-wide);
}
`;

/**
 * theme.css:1979-1984. The table's own margin is NOT `auto`: it is the
 * column's start margin minus the drag space, so a table starts 16px LEFT of
 * the text and stays there at every pane width.
 */
const TABLE_DRAG_VARS = `
body {
  --table-drag-space: 16px;
  --container-table-margin: calc(var(--content-margin-start) - var(--table-drag-space));
  --container-table-width: calc(var(--line-width) + var(--table-drag-space)*2);
  --table-drag-padding: var(--table-drag-space);
}
`;

/** theme.css:2076-2100 - the per-note image cssclasses. */
const IMG_CLASS_VARS = `
.img-wide, .img-max, .img-100 { --img-max-width: 100%; --img-width: 100%; }
.img-wide {
  --container-img-width: var(--line-width-wide);
  --img-line-width: var(--line-width-wide);
  --img-margin-start: calc(50% - var(--line-width-wide)/2);
}
.img-100 {
  --container-img-width: 100%;
  --container-img-max-width: 100%;
  --img-line-width: 100%;
  --img-margin-start: 0;
}
`;

/**
 * theme.css:2170-2199 - the deliberately-wide blocks: tables (and the table
 * widget), then bases and dataview tables. theme.css:1695-1697 for the
 * widget's own padding, which is inside its border box and therefore cannot
 * move its left edge.
 */
const WIDE_BLOCK_RULES = `
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content .cm-table-widget,
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > div:has(table) {
  width: var(--container-table-width);
  max-width: var(--container-table-max-width);
  margin-inline: var(--container-table-margin) !important;
  padding-inline-start: var(--table-drag-padding);
}
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > .bases-embed,
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > div:has(:is(.block-language-base, .bases-embed)),
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > :has(> :is(.block-language-dataview, .block-language-dataviewjs) table) {
  width: var(--container-dataview-table-width);
  max-width: var(--container-table-max-width);
}
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content table {
  width: var(--table-width);
  max-width: var(--table-max-width);
  margin-inline: var(--table-margin);
}
.cm-embed-block.cm-table-widget.markdown-rendered {
  padding: var(--table-drag-padding);
}
`;

/** theme.css:2216-2240 - image containers, and a bare `img` child. */
const IMAGE_RULES = `
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > .image-embed,
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > div:has(.image-embed) {
  width: var(--container-img-width);
  max-width: var(--container-img-max-width);
}
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > .image-embed img,
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > div:has(.image-embed) img {
  max-width: var(--img-max-width);
}
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > img {
  max-width: var(--img-line-width);
  margin-inline-start: var(--img-margin-start) !important;
}
`;

/** theme.css:2262-2266 - an HTML block (`.cm-html-embed`) or an iframe. */
const HTML_EMBED_RULE = `
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > div:has(> :is(iframe, .cm-html-embed)) {
  width: var(--container-iframe-width);
  max-width: var(--container-iframe-max-width);
}
`;

const MINIMAL_CSS = [
	LINE_WIDTH_VARS,
	CONTENT_MARGIN_VARS,
	COLUMN_RULE,
	NON_DIV_RULE,
	BLOCK_VARS,
	TABLE_DRAG_VARS,
	IMG_CLASS_VARS,
	WIDE_BLOCK_RULES,
	IMAGE_RULES,
	HTML_EMBED_RULE,
].join("\n");

/* -------------------------------------------------------------------------
 * The browser side.
 * ---------------------------------------------------------------------- */

let bundled: string | null = null;

/** Bundles `shapesPage.ts`, which imports the real `contentOriginLeft`. */
async function pageBundle(): Promise<string> {
	if (bundled) return bundled;
	const out = await build({
		entryPoints: [here("./shapesPage.ts")],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		target: "es2022",
	});
	const file = out.outputFiles[0];
	if (!file) throw new Error("esbuild produced no output for shapesPage.ts");
	bundled = file.text;
	return bundled;
}

let browser: Browser;
let page: Page;

beforeAll(async () => {
	browser = await chromium.launch();
	page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
	await page.setContent("<!doctype html><meta charset=utf-8><title>note shapes</title>");
	await page.addStyleTag({ content: RESET_CSS });
	await page.addStyleTag({ content: CM_BASE_CSS });
	await page.addStyleTag({ content: MINIMAL_CSS });
	await page.addScriptTag({ content: await pageBundle() });
});
afterAll(async () => {
	await browser?.close();
});

/* -------------------------------------------------------------------------
 * The shapes.
 * ---------------------------------------------------------------------- */

const rep = (kind: ChildKind, n: number): ChildKind[] => Array.from({ length: n }, () => kind);

interface Scenario {
	name: string;
	/** Why this shape exists in the sweep - the note a user would have. */
	note: string;
	req: ShapeRequest;
}

const SCENARIOS: Scenario[] = [
	{
		name: "prose control",
		note: "an ordinary note: twelve lines of text",
		req: { kinds: rep("prose", 12) },
	},
	{
		name: "mixed prose note",
		note: "headings, blanks, list items and code lines - all still .cm-line",
		req: {
			kinds: [
				"heading",
				"blank",
				"prose",
				"prose",
				"blank",
				"listItem",
				"listItem",
				"blank",
				"heading",
				"prose",
				"codeLine",
				"codeLine",
			],
		},
	},
	{
		name: "table first, prose after",
		note: "a note that opens with a table, then text",
		req: { kinds: ["tableWidget", ...rep("prose", 11)] },
	},
	{
		name: "twelve table widgets",
		note: "twelve rendered tables before any text line",
		req: { kinds: rep("tableWidget", 12) },
	},
	{
		name: "twelve table lines",
		note: "twelve .cm-line children that each hold a rendered table",
		req: { kinds: rep("tableSourceLine", 12) },
	},
	{
		name: "twelve dataview tables",
		note: "a dashboard note: twelve dataview table blocks",
		req: { kinds: rep("dataviewTable", 12) },
	},
	{
		name: "twelve bases embeds",
		note: "twelve Bases embeds before any text",
		req: { kinds: rep("basesEmbed", 12) },
	},
	{
		name: "image first, prose after",
		note: "a note that opens with an image, then text",
		req: { kinds: ["imageContainer", ...rep("prose", 11)] },
	},
	{
		name: "twelve image blocks",
		note: "a gallery note: twelve image embeds, no text between them",
		req: { kinds: rep("imageContainer", 12) },
	},
	{
		name: "twelve image blocks, img-100",
		note: "the same gallery with Minimal's `cssclasses: img-100`",
		req: { kinds: rep("imageContainer", 12), noteClass: "img-100" },
	},
	{
		name: "twelve image blocks, img-wide",
		note: "the same gallery with Minimal's `cssclasses: img-wide`",
		req: { kinds: rep("imageContainer", 12), noteClass: "img-wide" },
	},
	{
		name: "twelve direct image embeds",
		note: "the embed element itself as the child (`> .cm-content > .image-embed`)",
		req: { kinds: rep("imageDirect", 12) },
	},
	{
		name: "twelve callouts",
		note: "a note built out of callouts",
		req: { kinds: rep("callout", 12) },
	},
	{
		name: "twelve code lines",
		note: "a note that opens with a long fenced code block",
		req: { kinds: rep("codeLine", 12) },
	},
	{
		name: "twelve math blocks",
		note: "a note that opens with twelve display-math blocks",
		req: { kinds: rep("mathBlock", 12) },
	},
	{
		name: "twelve hidden html embeds",
		note: "twelve blocks that render to nothing - the shape a hidden HTML comment takes",
		req: { kinds: rep("htmlEmbedHidden", 12) },
	},
	{
		name: "twelve collapsed markers",
		note: "twelve zero-by-zero block markers",
		req: { kinds: rep("markerCollapsed", 12) },
	},
	{
		name: "widgets only, all degenerate",
		note: "collapsed markers alternating with CodeMirror widget buffers",
		req: {
			kinds: Array.from({ length: 12 }, (_, i) =>
				i % 2 === 0 ? "markerCollapsed" : "widgetBuffer"
			),
		},
	},
	{
		name: "virtualised: gap then prose",
		note: "scrolled mid-document: CodeMirror's cm-gap, then text",
		req: { kinds: ["gap", ...rep("prose", 11)] },
	},
	{
		name: "virtualised: gap then tables",
		note: "scrolled into a run of tables, with the gap above them",
		req: { kinds: ["gap", ...rep("tableWidget", 11)] },
	},
	{
		name: "twelve external images",
		note: "bare `img` children (`> .cm-content > img`)",
		req: { kinds: rep("externalImg", 12) },
	},
	{
		name: "RTL prose control",
		note: "an ordinary RTL note",
		req: { kinds: rep("prose", 12), rtl: true },
	},
	{
		name: "RTL twelve table widgets",
		note: "the table run, in an RTL note",
		req: { kinds: rep("tableWidget", 12), rtl: true },
	},
	{
		name: "RTL twelve external images",
		note: "bare `img` children in an RTL note - the start margin is on the right",
		req: { kinds: rep("externalImg", 12), rtl: true },
	},
	{
		name: "narrow pane, prose",
		note: "a 600px pane, where --max-width (88%) beats --line-width",
		req: { kinds: rep("prose", 12), paneWidth: 600 },
	},
	{
		name: "narrow pane, table widgets",
		note: "the table run in a 600px pane",
		req: { kinds: rep("tableWidget", 12), paneWidth: 600 },
	},
	{
		name: "readable line length off",
		note: "the control for the whole file: no centring at all",
		req: { kinds: rep("prose", 12), readable: false },
	},
	{
		name: "wide cssclass, prose",
		note: "`cssclasses: wide` widens the column itself",
		req: { kinds: rep("prose", 12), noteClass: "wide" },
	},
	{
		name: "img-100 gallery, blank lines",
		note: "the same img-100 gallery with the blank lines Markdown usually puts between blocks",
		req: {
			kinds: Array.from({ length: 12 }, (_, i) =>
				i % 2 === 0 ? "imageContainer" : "blank"
			),
			noteClass: "img-100",
		},
	},
	{
		name: "table run, blank lines",
		note: "tables separated by blank lines - what consecutive Markdown tables actually need",
		req: {
			kinds: Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? "tableWidget" : "blank")),
		},
	},
	{
		name: "hidden html embeds, no text at all",
		note: "the same flat blocks, in a note that holds no text line anywhere",
		req: { kinds: rep("htmlEmbedHidden", 12), tail: false },
	},
	{
		name: "collapsed markers, no text at all",
		note: "zero-by-zero children only: nothing in the viewport can be measured",
		req: { kinds: rep("markerCollapsed", 12), tail: false },
	},
];

/* -------------------------------------------------------------------------
 * The verdicts. Every shape in SCENARIOS belongs to exactly one list, and a
 * test below asserts that, so nothing can be swept and then ignored.
 * ---------------------------------------------------------------------- */

/** Shapes where today's scan already lands on the column. */
const CONTROLS = [
	"prose control",
	"mixed prose note",
	"table first, prose after",
	"twelve bases embeds",
	"image first, prose after",
	"twelve image blocks",
	"twelve direct image embeds",
	"twelve callouts",
	"twelve code lines",
	"twelve math blocks",
	"virtualised: gap then prose",
	"virtualised: gap then tables",
	"RTL prose control",
	"narrow pane, prose",
	"readable line length off",
	"wide cssclass, prose",
	"img-100 gallery, blank lines",
	"table run, blank lines",
];

/** A leading run of deliberately-wide BLOCKS, none of them a `.cm-line`. */
const WIDE_BLOCKS = [
	"twelve table widgets",
	"twelve dataview tables",
	"RTL twelve table widgets",
	"narrow pane, table widgets",
];

/** A leading run of wide `.cm-line`s: the preferred pool is the wrong pool. */
const WIDE_LINES = ["twelve table lines"];

/** Minimal's per-note image classes make the leading blocks full-width. */
const IMAGE_CLASSES = ["twelve image blocks, img-100", "twelve image blocks, img-wide"];

/** Blocks with a real width, a correct left edge, and no height. */
const FLAT_BLOCKS = ["twelve hidden html embeds", "hidden html embeds, no text at all"];

/** Nothing in the window can be measured, but the note has text below it. */
const NOTHING_MEASURABLE = ["twelve collapsed markers", "widgets only, all degenerate"];

/** Nothing in the whole viewport can be measured. The documented limit. */
const RESIDUAL = ["collapsed markers, no text at all"];

/** Non-`div` children, which Minimal starts rather than centres. */
const NON_DIV = ["twelve external images", "RTL twelve external images"];

const readings = new Map<string, ShapeReading>();

async function measure(name: string): Promise<ShapeReading> {
	const cached = readings.get(name);
	if (cached) return cached;
	const scenario = SCENARIOS.find((s) => s.name === name);
	if (!scenario) throw new Error(`no scenario named ${name}`);
	const reading = await page.evaluate((req) => window.__hwshapes.measure(req), scenario.req);
	readings.set(name, reading);
	return reading;
}

async function measureAll(): Promise<void> {
	for (const scenario of SCENARIOS) await measure(scenario.name);
}

const px = (n: number): string => n.toFixed(2).padStart(9);

/* -------------------------------------------------------------------------
 * The sweep.
 * ---------------------------------------------------------------------- */

describe("the sweep: every shape, measured", () => {
	it("reports origin, column and error for every note shape", async () => {
		await measureAll();
		const rows = SCENARIOS.map((s) => {
			const r = readings.get(s.name);
			if (!r) throw new Error(`unmeasured: ${s.name}`);
			return [
				s.name.padEnd(34),
				px(r.originLeft),
				px(r.columnLeft),
				px(r.error),
				px(r.originWidthOnly - r.columnLeft),
				px(r.originProposed - r.columnLeft),
				String(r.linesInWindow).padStart(5),
				String(r.usableInWindow).padStart(6),
				String(r.linesInDoc).padStart(5),
			].join(" ");
		});
		// eslint-disable-next-line no-console
		console.log(
			[
				`${"shape".padEnd(34)} ${"origin".padStart(9)} ${"column".padStart(9)} ${"error".padStart(9)} ${"errW".padStart(9)} ${"errFix".padStart(9)} lines usable doc`,
				...rows,
			].join("\n")
		);
		expect(readings.size).toBe(SCENARIOS.length);
	});

	it("the ruler is honest: it agrees with a prose line past the scan window", async () => {
		await measureAll();
		// The whole file's ground truth. Every shape with at least SCAN_LIMIT
		// children also carries a prose line at index 12 - outside the scan,
		// inside the same `.cm-content` - and its left must be the ruler's. If
		// this goes red the ruler pane is not the note's column and no verdict
		// in this file means anything.
		for (const scenario of SCENARIOS) {
			const r = readings.get(scenario.name);
			if (!r || r.tailProseLeft === null) continue;
			expect(
				Math.abs(r.tailProseLeft - r.columnLeft),
				`${scenario.name}: tail prose ${r.tailProseLeft} vs ruler ${r.columnLeft}`
			).toBeLessThan(0.5);
		}
	});

	it("every shape is classified: control, defect, or documented residual", () => {
		const classified = new Set([
			...CONTROLS,
			...WIDE_BLOCKS,
			...WIDE_LINES,
			...IMAGE_CLASSES,
			...FLAT_BLOCKS,
			...NOTHING_MEASURABLE,
			...RESIDUAL,
			...NON_DIV,
		]);
		// A shape added to the sweep and left out of every list below would be
		// measured, printed, and asserted on by nothing at all.
		expect([...classified].sort()).toEqual(SCENARIOS.map((s) => s.name).sort());
	});

	it("the scan window this file probes is the one the source scans", async () => {
		// `SCAN_WINDOW` in shapesPage.ts is a copy for reporting. If someone
		// changes SCAN_LIMIT, the sweep's window must follow or its `lines`
		// and `usable` columns become fiction.
		const declared = /const SCAN_LIMIT = (\d+);/.exec(originSource.replace(/\r\n/g, "\n"));
		expect(declared, "SCAN_LIMIT declaration not found in ContentOrigin.ts").not.toBeNull();
		expect(declared?.[1]).toBe("12");
	});
});

/* -------------------------------------------------------------------------
 * Verdicts.
 *
 * Each confirmed defect is a PAIR: a green test that proves the shape really
 * reproduces the conditions claimed for it, and an `it.fails` holding the
 * invariant in its true form. The pairing is the repo's idiom and the reason
 * for it is in `src/persistence/PageStoreTwoDocuments.test.ts` - `it.fails`
 * passes on ANY error, so a broken harness would hide a defect rather than
 * report it unless the setup is asserted separately.
 *
 * THE INVARIANT, once, since six tests state it: `|originLeft - columnLeft|`
 * must be at most 1px, because the overlay paints `origin + x * scale` and
 * every px of error is a px of ink sitting off the words it was written on.
 * ---------------------------------------------------------------------- */

const at = (name: string): ShapeReading => {
	const reading = readings.get(name);
	if (!reading) throw new Error(`unmeasured scenario: ${name}`);
	return reading;
};

/** The invariant, applied to a group. */
function expectOnColumn(names: string[]): void {
	for (const name of names) {
		const r = at(name);
		expect(
			Math.abs(r.error),
			`${name}: origin ${r.originLeft}, column ${r.columnLeft}`
		).toBeLessThanOrEqual(1);
	}
}

describe("REFUTED: shapes the twelve-child scan already gets right", () => {
	it("eighteen note shapes measure the column to within 1px", async () => {
		await measureAll();
		expectOnColumn(CONTROLS);
	});

	it("a blank line between blocks is what rescues the two worst shapes", async () => {
		await measureAll();
		// The same twelve blocks that fail below, with the blank lines
		// Markdown puts between consecutive tables: the blank `.cm-line` is an
		// ordinary column-width line, it enters the preferred pool, and the
		// maximum picks it. This is the boundary of every defect in this file
		// - they all need an UNBROKEN leading run of non-text children.
		for (const name of ["img-100 gallery, blank lines", "table run, blank lines"]) {
			expect(at(name).linesInWindow).toBe(6);
			expect(Math.abs(at(name).error)).toBeLessThanOrEqual(1);
		}
	});
});

describe("CONFIRMED: a leading run of wide blocks drags the origin left", () => {
	it("the shapes reproduce: no line in the window, every block left of the column", async () => {
		await measureAll();
		for (const name of WIDE_BLOCKS) {
			const r = at(name);
			// Nothing in the window is a `.cm-line`, so the preferred pool is
			// empty and the fallback pool - these blocks - decides.
			expect(r.linesInWindow, name).toBe(0);
			expect(r.usableInWindow, name).toBe(12);
			// Minimal really did widen them: `--container-table-margin` is the
			// column's start margin minus `--table-drag-space`
			// (theme.css:1981), so every one starts left of the text.
			for (const child of r.window) {
				expect(child.left, `${name}: ${child.cls}`).toBeLessThan(r.columnLeft - 1);
			}
			// And the note is not all table: there IS a text line below, one
			// child past the window, which a scan that kept looking would find.
			expect(r.linesInDoc, name).toBeGreaterThanOrEqual(1);
		}
	});

	it("the origin sits on the text column for a run of wide blocks", async () => {
		await measureAll();
		expectOnColumn(WIDE_BLOCKS);
	});
});

describe("CONFIRMED: a leading run of wide LINES poisons the preferred pool", () => {
	it("the shapes reproduce: twelve `.cm-line`s, all of them wide", async () => {
		await measureAll();
		for (const name of WIDE_LINES) {
			const r = at(name);
			// Every scanned child is a `.cm-line`, so `.cm-line` preference -
			// the thing that saves the shapes above from their table - is what
			// selects the wrong children here.
			expect(r.linesInWindow, name).toBe(12);
			for (const child of r.window) {
				expect(child.isLine, `${name}: ${child.cls}`).toBe(true);
				expect(child.left, `${name}: ${child.cls}`).toBeLessThan(r.columnLeft - 1);
			}
			// The ordinary line exists; it is the thirteenth child.
			expect(r.linesInDoc, name).toBe(13);
		}
	});

	it("the origin sits on the text column for a run of wide lines", async () => {
		await measureAll();
		expectOnColumn(WIDE_LINES);
	});
});

describe("CONFIRMED: Minimal's image cssclasses widen the leading blocks", () => {
	it("the shapes reproduce: wide image blocks, no line in the window", async () => {
		await measureAll();
		for (const name of IMAGE_CLASSES) {
			const r = at(name);
			expect(r.linesInWindow, name).toBe(0);
			for (const child of r.window) {
				// Wider than the text column, therefore starting left of it.
				expect(child.width, `${name}: ${child.cls}`).toBeGreaterThan(r.columnWidth);
				expect(child.left, `${name}: ${child.cls}`).toBeLessThan(r.columnLeft - 1);
			}
		}
		// `img-100` is the worst case in the whole sweep: every block in the
		// window is the full pane, so the window offers nothing but
		// `.cm-content`'s own left - exactly the pre-1.4.9 number 1.4.9
		// existed to stop returning, and what the twelve-child scan returned
		// until 1.4.10. The hazard is the WINDOW and it is still here; what
		// changed is that the scan now looks past it.
		const hundred = at("twelve image blocks, img-100");
		for (const child of hundred.window) {
			expect(child.left, child.cls).toBeCloseTo(hundred.contentLeft, 1);
		}
		expect(hundred.originWidthOnly).toBeCloseTo(hundred.contentLeft, 1);
		expect(hundred.columnLeft - hundred.contentLeft).toBeGreaterThan(100);
	});

	it("the origin sits on the text column under img-100 and img-wide", async () => {
		await measureAll();
		expectOnColumn(IMAGE_CLASSES);
	});
});

describe("CONFIRMED: flat blocks are discarded although their edge is the column", () => {
	it("the shapes reproduce: zero height, full column width, correct left", async () => {
		await measureAll();
		for (const name of FLAT_BLOCKS) {
			const r = at(name);
			// The sharpest statement in the file: the answer was in the DOM,
			// on every one of the twelve children, and the degenerate test
			// threw all twelve away for having no height.
			for (const child of r.window) {
				expect(child.height, `${name}: ${child.cls}`).toBe(0);
				expect(child.width, `${name}: ${child.cls}`).toBeGreaterThan(0);
				expect(Math.abs(child.left - r.columnLeft), name).toBeLessThan(0.5);
			}
			expect(r.usableInWindow, name).toBe(0);
			// And dropping only the height arm of that test is enough here.
			expect(Math.abs(r.originWidthOnly - r.columnLeft), name).toBeLessThanOrEqual(1);
		}
	});

	it("the origin sits on the text column for a run of flat blocks", async () => {
		await measureAll();
		expectOnColumn(FLAT_BLOCKS);
	});
});

describe("CONFIRMED: an unmeasurable window falls back to `.cm-content`", () => {
	it("the shapes reproduce: no width in the window, text below it", async () => {
		await measureAll();
		for (const name of NOTHING_MEASURABLE) {
			const r = at(name);
			for (const child of r.window) {
				expect(child.width, `${name}: ${child.cls}`).toBe(0);
			}
			expect(r.usableInWindow, name).toBe(0);
			// A scan confined to the window has nothing to answer but
			// `.cm-content`'s own left, which under Minimal is the pane edge -
			// the whole centring margin away from the ink. That is what
			// shipped until 1.4.10 and it is what the width-only
			// counterfactual, which is still window-confined, still returns.
			expect(r.originWidthOnly, name).toBeCloseTo(r.contentLeft, 1);
			// A measurable line exists in the viewport; the scan stopped short.
			expect(r.linesInDoc, name).toBe(1);
		}
	});

	it("the origin sits on the text column when only the window is blank", async () => {
		await measureAll();
		expectOnColumn(NOTHING_MEASURABLE);
	});

	it("the residual, stated: nothing measurable anywhere leaves nothing to measure", async () => {
		await measureAll();
		for (const name of RESIDUAL) {
			const r = at(name);
			// No child in the viewport has a width and there is no line
			// anywhere, so no scan of any length can find the column. The
			// origin is `.cm-content`'s left and the ink is off by the
			// centring margin. This is a limit of measuring the DOM, not a bug
			// in the scan, and it is recorded so a later fix does not mistake
			// it for one.
			expect(r.linesInDoc, name).toBe(0);
			expect(r.usableInWindow, name).toBe(0);
			expect(r.originLeft, name).toBeCloseTo(r.contentLeft, 1);
			expect(r.originProposed, name).toBeCloseTo(r.contentLeft, 1);
		}
	});
});

describe("CONFIRMED mechanism, unattested shape: a non-div child right of the column", () => {
	it("the shape reproduces: a child right of the column wins the maximum", async () => {
		await measureAll();
		for (const name of NON_DIV) {
			const r = at(name);
			expect(r.linesInWindow, name).toBe(0);
			// The direction is what matters. `Math.max` over the candidates
			// has no upper bound, so a child that lands RIGHT of the column
			// wins outright - and theme.css:1868-1871 gives a non-`div` child
			// a start margin (mirrored in RTL) rather than centring it, while
			// an inline child sits wherever the line box put it. The first one
			// lands ON the column (its start margin IS the column's), and the
			// ones after it are pushed along the line box - so the shape is
			// not uniformly wrong, it is wrong at the top end, which is the
			// only end `Math.max` looks at.
			const maxLeft = Math.max(...r.window.map((child) => child.left));
			expect(maxLeft, name).toBeGreaterThan(r.columnLeft + 1);
			// A window-confined scan takes that maximum: 960 against a column
			// at 380. Since 1.4.10 these children are consulted only when the
			// note has no `.cm-line` at all, and this one has one past the
			// window - so the unbounded top end is still there and is no
			// longer reachable from a note that has any text in view.
			expect(r.originWidthOnly, name).toBeCloseTo(maxLeft, 1);
			expect(r.originWidthOnly - r.columnLeft, name).toBeGreaterThan(1);
		}
		// HONEST LIMIT: `> .cm-content > img` and `> .cm-content > *:not(div)`
		// are Minimal's own selectors, which is why the shape is in the sweep,
		// but nothing here shows Obsidian putting a bare `img` there:
		// CodeMirror's own `img.cm-widgetBuffer` is appended to a LINE
		// (@codemirror/view/dist/index.js:1747,1830), not to `.cm-content`.
		// Read the number as the reducer's unbounded top end, not as a note
		// somebody has.
	});

	it("the origin sits on the text column with a non-div child in the window", async () => {
		await measureAll();
		expectOnColumn(NON_DIV);
	});
});

describe("what a wider scan would cost, counted rather than timed", () => {
	it("the proposal reads no more rects than today's, at any note length", async () => {
		const small = await page.evaluate(() => window.__hwshapes.cost(50));
		const large = await page.evaluate(() => window.__hwshapes.cost(400));
		// eslint-disable-next-line no-console
		console.log("cost:", JSON.stringify({ small, large }));

		// `getBoundingClientRect` is the call that can force a layout, and
		// `contentOriginLeft` runs inside `syncCamera` - on resize, on scroll
		// ticks, at pen-down. So the budget that matters is rect reads, and
		// the proposal spends the same twelve however long the note is.
		expect(small.todayRects).toBeLessThanOrEqual(12);
		expect(large.todayRects).toBeLessThanOrEqual(12);
		expect(small.proposedRects).toBeLessThanOrEqual(12);
		expect(large.proposedRects).toBeLessThanOrEqual(12);
		expect(large.proposedRects).toBe(small.proposedRects);
		// What DOES scale is a `classList.contains` per child, which forces
		// nothing. Recorded so the trade is explicit rather than implied.
		expect(large.proposedVisited).toBe(400);
	});
});
