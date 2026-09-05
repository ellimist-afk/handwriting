/**
 * THE QUESTION. Is there any Minimal configuration a desktop user can reach in
 * which `contentOriginLeft` does not equal the visible text column's left
 * edge, or in which the reduced paint law
 *
 *     screen_x = origin + noteX * scale
 *
 * misplaces ink after a Readable-line-length toggle?
 *
 * `ContentOriginColumn.test.ts` proved the measurement right for ONE
 * configuration: Minimal's shipped defaults, one pane width, no `cssclasses`.
 * That is the configuration the owner tested on hardware after 1.4.9, and it
 * passes. Samuel is on the same theme and says the ink is still broken. This
 * file sweeps the settings space between those two facts.
 *
 * SOURCE OF THE MINIMAL RULES. Verbatim, from
 * `C:\Users\alanl\Obsidian\ObsidianVaults\vault test 2\.obsidian\themes\Minimal\theme.css`
 * (Minimal 9.0.2 per its own `manifest.json`, 8709 lines on disk). Every
 * declaration below is copied from a named line range, not paraphrased. What
 * is OMITTED, and why:
 *   - every `.markdown-preview-view` selector arm (reader mode has no
 *     `contentDOM`, so the overlay never measures it);
 *   - `.is-mobile` (theme.css:1986) and `.cards` (theme.css:2001, 2004) - this
 *     is the desktop question, and neither class is applied by this fixture;
 *   - the map / chart / iframe / bases / dataview helper families
 *     (theme.css:2102-2170, 2189-2218, 2242-2270). They are the same shape as
 *     the img family already swept here - a container width plus a container
 *     max-width, centred by the base rule's `margin-inline: auto !important` -
 *     and they move the same element the same way. The img family stands for
 *     them, and scenario E says what that costs.
 *   - the `--table-min-width` / `--table-margin` / `--table-edge-cell-padding-*`
 *     declarations INSIDE the copied helper blocks are carried anyway, because
 *     they are part of the blocks; they style the `<table>`, not the line box
 *     whose left edge is the origin, so they cannot move a number here.
 *
 * WHAT THIS CANNOT ANSWER. There is no Obsidian here and no CodeMirror. Every
 * Obsidian value is INJECTED below and is therefore a parameter of the
 * measurement, not part of it. The DOM shape is the one the theme's own
 * selectors imply (`minimalSweepPage.ts` says why each element is there), but
 * whether Obsidian's live preview really renders a table as a `.cm-line` with
 * a `<table>` inside it, or as a separate non-line widget div, is a fact about
 * Obsidian that this file cannot check - see scenario E for how much rests on
 * it and how little.
 *
 * Run: npm run test:render (the gate runs it too, see package.json:12).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import type { Reading, SweepConfig } from "./minimalSweepPage";
import { fontZoomFactor, noteToVisual, visualToNote } from "../../src/inline/ZoomScale";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

// ---------------------------------------------------------------------------
// The Minimal rules, verbatim.
// ---------------------------------------------------------------------------

/**
 * theme.css:52-56 (`--line-width`, `--max-width`) and theme.css:583
 * (`--line-width-wide`).
 *
 * The two lengths are declared here at their SHIPPED values and then
 * overridden per-configuration by an inline style on `body`, which is how the
 * Minimal Settings plugin's "Line width" and "Maximum width" controls reach
 * them. `--line-width-wide` resolves its `var(--line-width)` at computed-value
 * time on `body`, so it follows the swept value rather than the shipped one -
 * asserted in scenario A's preconditions rather than assumed.
 */
const LINE_WIDTH_VARS = `
body {
  --line-width: 40rem;
  --max-width: 88%;
}
body {
  --line-width-wide:calc(var(--line-width) + 12.5%);
}
`;

/** theme.css:1831-1838 - the margins every centred child is built from. */
const CONTENT_MARGIN_VARS = `
body {
  --content-margin: auto;
  --content-margin-start: max(
  	calc(50% - var(--line-width)/2),
  	calc(50% - var(--max-width)/2) );
  --content-line-width: min(var(--line-width), var(--max-width));
  --map-header-padding: 2px;
}
`;

/**
 * theme.css:638-641. Load-bearing for this fixture rather than decorative:
 * Minimal zeroes the scroller's INLINE padding, so Obsidian's `--file-margins`
 * reaches the column only vertically. Without it the readable-OFF column would
 * be inset by the file margin and every delta below would carry it.
 */
const SCROLLER_RULE = `
.markdown-source-view.mod-cm6 .cm-scroller {
  padding-inline-end: 0;
  padding-inline-start: 0;
}
`;

/**
 * theme.css:1852-1872. The root of the defect: `.cm-content` is forced full
 * width (never narrows, never moves) and the LINE `div`s inside it are given
 * the column width and centred instead. The `*:not(div)` arm is the widget
 * buffer's.
 */
const COLUMN_RULE = `
.markdown-source-view.mod-cm6.is-readable-line-width .cm-content,
.markdown-source-view.mod-cm6.is-readable-line-width .cm-sizer {
  max-width: 100%;
  width: 100%;
}
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > div,
.markdown-source-view.mod-cm6.is-readable-line-width .cm-sizer > .inline-title,
.markdown-source-view.mod-cm6.is-readable-line-width .cm-sizer > .embedded-backlinks,
.markdown-source-view.mod-cm6.is-readable-line-width .cm-sizer > .metadata-container {
  max-width: var(--max-width);
  width: var(--line-width);
  margin-inline: var(--content-margin) !important;
}
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > *:not(div) {
  max-width: var(--content-line-width);
  margin-inline-start: var(--content-margin-start) !important;
}
`;

/** theme.css:1875-1877. */
const FILE_MARGINS_RULE = `
.is-readable-line-width {
  --file-margins: 1rem 0 0 0;
}
`;

/**
 * theme.css:1923-1949. The default container widths - the LAST unqualified
 * `body { }` block to set them, so it is what actually wins.
 */
const CONTAINER_VARS = `
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
  --container-chart-width: var(--line-width);
  --container-chart-max-width: var(--max-width);
  --chart-max-width: none;
  --chart-width: auto;
  --container-map-width: var(--line-width);
  --container-map-max-width: var(--max-width);
  --map-max-width: none;
  --map-width: auto;
  --container-iframe-width: var(--line-width);
  --container-iframe-max-width: var(--max-width);
  --iframe-max-width: none;
  --iframe-width: auto;
}
`;

/**
 * theme.css:1951-1968.
 *
 * NOTE THE SELECTORS. They are `body .wide` and `body .max` - DESCENDANT
 * combinators, not `body.wide` / `body.max`. The class has to sit on an
 * element INSIDE `body`, which is where Obsidian puts a note's `cssclasses`
 * frontmatter (the `.markdown-source-view`); a class on `body` itself matches
 * neither rule and changes nothing. The fixture applies these through
 * `viewClasses` for exactly that reason.
 */
const WIDE_MAX_HELPERS = `
body .wide {
  --line-width: var(--line-width-wide);
  --container-table-width: var(--line-width-wide);
  --container-dataview-table-width: var(--line-width-wide);
  --container-img-width: var(--line-width-wide);
  --container-iframe-width: var(--line-width-wide);
  --container-map-width: var(--line-width-wide);
  --container-chart-width: var(--line-width-wide);
}
body .max {
  --line-width: var(--max-width);
  --container-table-width: var(--max-width);
  --container-dataview-table-width: var(--max-width);
  --container-img-width: var(--max-width);
  --container-iframe-width: var(--max-width);
  --container-map-width: var(--max-width);
  --container-chart-width: var(--max-width);
}
`;

/** theme.css:1979-1984 - the table container's own default width and margin. */
const TABLE_VARS = `
body {
  --table-drag-space: 16px;
  --container-table-margin: calc(var(--content-margin-start) - var(--table-drag-space));
  --container-table-width: calc(var(--line-width) + var(--table-drag-space)*2);
  --table-drag-padding: var(--table-drag-space);
}
`;

/** theme.css:1991-2000 and 2008-2020 - the two Minimal Settings body toggles. */
const MAXIMIZE_TABLES = `
.maximize-tables-auto {
  --container-table-max-width: 100%;
  --container-table-width: 100%;
  --container-dataview-table-width: 100%;
  --container-table-margin: 0;
  --table-drag-padding: var(--table-drag-space) 0;
  --table-max-width: 100%;
  --table-margin: var(--content-margin-start) auto;
  --table-width: auto;
}
.maximize-tables {
  --container-table-max-width: 100%;
  --container-table-width: 100%;
  --container-table-margin: 0;
  --table-drag-padding: var(--table-drag-space) 0;
  --table-min-width: min(var(--line-width), var(--max-width));
  --table-max-width: 100%;
  --table-margin: auto;
  --table-width: auto;
  --table-edge-cell-padding-first: 8px;
  --table-edge-cell-padding-last: 8px;
  --table-wrapper-width: auto;
}
`;

/** theme.css:2022-2058 - the per-file table helpers. */
const TABLE_HELPERS = `
.table-wide,
.table-max,
.table-100 {
  --table-max-width: 100%;
  --table-width: 100%;
}
.table-wide {
  --container-table-width: var(--line-width-wide);
  --container-dataview-table-width: var(--line-width-wide);
  --container-table-margin: auto;
  --table-edge-cell-padding-first: 0px;
}
.table-max {
  --container-table-width: var(--max-width);
  --container-table-max-width: calc(var(--max-width) + var(--table-drag-space)*2);
  --container-dataview-table-width: var(--max-width);
  --container-table-margin: auto;
  --table-edge-cell-padding-first: 0px;
  --table-margin: 0;
}
.table-100 {
  --container-table-width: 100%;
  --container-dataview-table-width: 100%;
  --container-table-max-width: 100%;
  --container-table-margin: 0;
  --table-edge-cell-padding-first: 16px;
  --table-edge-cell-padding-last: 16px;
  --table-margin: 0;
  --table-drag-padding: var(--table-drag-space) 0;
  --table-wrapper-width: min(fit-content, 100%);
}
`;

/** theme.css:2076-2100 - the per-file image helpers. */
const IMG_HELPERS = `
.img-wide,
.img-max,
.img-100 {
  --img-max-width: 100%;
  --img-width: 100%;
}
.img-wide {
  --container-img-width: var(--line-width-wide);
  --img-line-width: var(--line-width-wide);
  --img-margin-start: calc(50% - var(--line-width-wide)/2);
}
.img-max {
  --container-img-width: var(--max-width);
  --img-line-width: var(--max-width);
  --img-margin-start: calc(50% - var(--max-width)/2);
}
.img-100 {
  --container-img-width: 100%;
  --container-img-max-width: 100%;
  --img-line-width: 100%;
  --img-margin-start:0;
}
`;

/**
 * theme.css:2171-2178 (tables) and theme.css:2224-2229 (images).
 *
 * These are the rules that make SOME block children wider than the text and
 * pull them further left - the hazard `contentOriginLeft`'s maximum-over-
 * candidates rule exists to step over. The table arm sets its own
 * `margin-inline` (`!important`, and more specific than the base rule's, so it
 * wins); the image arm sets width only and inherits `margin-inline: auto` from
 * the base rule, which is why an image line under DEFAULT Minimal sits exactly
 * on the column and only the `.img-*` helpers move it.
 */
const BLOCK_RULES = `
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content .cm-table-widget,
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > div:has(table) {
  width: var(--container-table-width);
  max-width: var(--container-table-max-width);
  margin-inline: var(--container-table-margin) !important;
  padding-inline-start: var(--table-drag-padding);
}
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content table {
  width: var(--table-width);
  max-width: var(--table-max-width);
  margin-inline: var(--table-margin);
  min-width: var(--table-min-width);
}
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > .image-embed,
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > div:has(.image-embed) {
  width: var(--container-img-width);
  max-width: var(--container-img-max-width);
}
`;

const MINIMAL_CSS = [
	LINE_WIDTH_VARS,
	CONTENT_MARGIN_VARS,
	SCROLLER_RULE,
	COLUMN_RULE,
	FILE_MARGINS_RULE,
	CONTAINER_VARS,
	WIDE_MAX_HELPERS,
	TABLE_VARS,
	MAXIMIZE_TABLES,
	TABLE_HELPERS,
	IMG_HELPERS,
	BLOCK_RULES,
].join("\n");

/**
 * Stock Obsidian's own readable-line-width rule, and the app values Minimal
 * reads but does not define. NOT from a vendor file - there is no app.css on
 * disk in this repo - so every one of these is a PARAMETER of the measurement,
 * written down here the way `harness.ts#INJECTED` writes down its own.
 *
 * `--file-line-width: 700px` is the citation already in this codebase
 * (`InkOverlay.ts:1836`, `PaneWidthGeometry.test.ts:640`). Unlike Minimal,
 * `.cm-content` ITSELF narrows and centres, which is the whole reason the
 * pre-1.4.9 code worked under stock and nowhere else.
 */
const STOCK_APP_CSS = `
body {
  --size-4-2: 8px;
  --size-4-5: 20px;
  --size-4-8: 32px;
  --file-margins: var(--size-4-8);
  --font-text-size: 16px;
  --editor-font-size: 16px;
  --file-line-width: 700px;
}
.markdown-source-view.mod-cm6 .cm-scroller { padding: var(--file-margins); }
`;

const STOCK_READABLE_RULE = `
.markdown-source-view.mod-cm6.is-readable-line-width .cm-content {
  max-width: var(--file-line-width);
  margin: 0 auto;
}
`;

/**
 * The fixture's own parameters: sizes the theme leaves to the content, plus
 * the overlay geometry `styles.css` gives `.handwriting-ink-overlay`. Stated
 * here so no number below can be mistaken for a measurement of the theme.
 *
 * `line-height` is pinned so a line box has height WITHOUT depending on which
 * fonts exist - the CI runner is Linux and fontless, and a zero-height line
 * would be skipped by `contentOriginLeft` and silently change what is being
 * measured. The image embed gets an explicit height for the same reason: there
 * is no network here and an `<img>` with no src renders 0x0.
 */
const FIXTURE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; }
.cm-content { line-height: 1.5; }
.cm-line { min-height: 1.5em; }
.internal-embed.image-embed { display: block; height: 120px; background: #eee; }
.cm-scroller { position: relative; }
.handwriting-ink-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
`;

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

let bundled: string | null = null;

/** Bundles `minimalSweepPage.ts`, which imports the real production code. */
async function pageBundle(): Promise<string> {
	if (bundled) return bundled;
	const out = await build({
		entryPoints: [here("./minimalSweepPage.ts")],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		target: "es2022",
	});
	const file = out.outputFiles[0];
	if (!file) throw new Error("esbuild produced no output for minimalSweepPage.ts");
	bundled = file.text;
	return bundled;
}

interface OpenOptions {
	css?: string;
	/** Windows display scaling, as Chromium sees it. */
	deviceScaleFactor?: number;
}

async function openSweep(browser: Browser, opts: OpenOptions = {}): Promise<Page> {
	const page = await browser.newPage({
		viewport: { width: 1500, height: 900 },
		...(opts.deviceScaleFactor === undefined
			? {}
			: { deviceScaleFactor: opts.deviceScaleFactor }),
	});
	await page.setContent("<!doctype html><meta charset=utf-8><title>minimal sweep</title>");
	await page.addStyleTag({ content: FIXTURE_CSS });
	await page.addStyleTag({ content: STOCK_APP_CSS });
	await page.addStyleTag({ content: opts.css ?? MINIMAL_CSS });
	await page.addScriptTag({ content: await pageBundle() });
	return page;
}

const BASE: SweepConfig = {
	shape: "prose",
	lineWidth: "40rem",
	maxWidth: "88%",
	viewClasses: [],
	bodyClasses: [],
	paneWidth: 1400,
	fontSize: "16px",
	readable: true,
	editorScale: 1,
};

const cfg = (over: Partial<SweepConfig> = {}): SweepConfig => ({ ...BASE, ...over });

async function read(page: Page, c: SweepConfig): Promise<Reading> {
	return page.evaluate((x) => window.__hwmin.apply(x), c);
}

/** Both readable states of one configuration, in one round trip each. */
async function toggle(page: Page, c: SweepConfig): Promise<{ off: Reading; on: Reading }> {
	const off = await read(page, { ...c, readable: false });
	const on = await read(page, { ...c, readable: true });
	return { off, on };
}

/**
 * The whole of the plugin's horizontal transform, in the two directions it
 * actually runs, built from the REAL `ZoomScale` functions.
 *
 * FORWARD (pen-down, `InkOverlay.ts:1196` then `screenToWorld`): the router
 * maps `clientX` to overlay-relative note units and the camera adds its own
 * origin, which is `visualToNote(overlay.left - contentLeft, scale)`. The
 * overlay's own left cancels, leaving `(clientX - origin) / scale`.
 *
 * BACK (paint, `InkOverlay.ts:2961`): `rect.left + noteToVisual(worldToScreen(...))`,
 * which by the same cancellation is `origin + noteX * scale`. That is the
 * reduced paint law this file tests, and it is why the overlay's position is
 * not a parameter of it.
 */
const noteXof = (clientX: number, origin: number, scale: number): number =>
	visualToNote(clientX - origin, scale);
const paintedXof = (noteX: number, origin: number, scale: number): number =>
	origin + noteToVisual(noteX, scale);

/** `this.scale` as `InkOverlay.ts:1842` builds it. */
const totalScale = (r: Reading, refFontPx: number): number =>
	r.cssScale * fontZoomFactor(r.fontPx, refFontPx);

interface Row {
	name: string;
	/** Which width helper was applied, "" for none. */
	helper: string;
	originError: number;
	paintError: number;
	columnMove: number;
	/** Readable-ON column and content widths, for the flat-cell precondition. */
	colWidth: number;
	contentWidth: number;
	detail: string;
}

/** The geometry fields every Row carries, taken from the readable-ON reading. */
const geom = (r: Reading, helper = ""): Pick<Row, "helper" | "colWidth" | "contentWidth"> => ({
	helper,
	colWidth: r.textWidth,
	contentWidth: r.contentWidth,
});

/** The house tolerance: anything past a pixel is a defect, per the brief. */
const TOL = 1;

const table = (title: string, rows: Row[]): void => {
	const lines = rows.map(
		(r) =>
			`  ${r.name.padEnd(52)} origin ${r.originError.toFixed(2).padStart(9)}  ` +
			`paint ${r.paintError.toFixed(2).padStart(9)}  move ${r.columnMove.toFixed(2).padStart(9)}  ${r.detail}`
	);
	// eslint-disable-next-line no-console
	console.log(`\n${title}\n${lines.join("\n")}`);
};

let browser: Browser;
beforeAll(async () => {
	browser = await chromium.launch();
});
afterAll(async () => {
	await browser?.close();
});

// ---------------------------------------------------------------------------
// A. The settings matrix.
// ---------------------------------------------------------------------------

/** Minimal Settings' "Line width", plus the percentage form the helpers use. */
const LINE_WIDTHS = ["30rem", "40rem", "50rem", "100%"];
/** Minimal Settings' "Maximum width". */
const MAX_WIDTHS = ["80%", "88%", "100%"];
/**
 * Every width helper Minimal exposes to a desktop user, by where the class
 * lands: `viewClasses` are a note's `cssclasses` frontmatter, `bodyClasses`
 * are the Minimal Settings global toggles.
 */
const CLASS_CASES: { name: string; viewClasses: string[]; bodyClasses: string[] }[] = [
	{ name: "(none)", viewClasses: [], bodyClasses: [] },
	{ name: "wide", viewClasses: ["wide"], bodyClasses: [] },
	{ name: "max", viewClasses: ["max"], bodyClasses: [] },
	{ name: "table-wide", viewClasses: ["table-wide"], bodyClasses: [] },
	{ name: "table-max", viewClasses: ["table-max"], bodyClasses: [] },
	{ name: "table-100", viewClasses: ["table-100"], bodyClasses: [] },
	{ name: "img-wide", viewClasses: ["img-wide"], bodyClasses: [] },
	{ name: "img-max", viewClasses: ["img-max"], bodyClasses: [] },
	{ name: "img-100", viewClasses: ["img-100"], bodyClasses: [] },
	{ name: "body.maximize-tables", viewClasses: [], bodyClasses: ["maximize-tables"] },
	{ name: "body.maximize-tables-auto", viewClasses: [], bodyClasses: ["maximize-tables-auto"] },
];
/** A wide pane and one narrow enough that `--max-width` binds instead. */
const PANES = [1400, 760];

async function sweepMatrix(page: Page): Promise<Row[]> {
	const rows: Row[] = [];
	for (const lineWidth of LINE_WIDTHS) {
		for (const maxWidth of MAX_WIDTHS) {
			for (const cc of CLASS_CASES) {
				for (const paneWidth of PANES) {
					const c = cfg({
						lineWidth,
						maxWidth,
						viewClasses: cc.viewClasses,
						bodyClasses: cc.bodyClasses,
						paneWidth,
					});
					const { off, on } = await toggle(page, c);
					// A stroke laid over the word with readable OFF, repainted
					// with readable ON. Same word, same offset inside its line.
					const scaleOff = totalScale(off, off.fontPx);
					const scaleOn = totalScale(on, off.fontPx);
					const noteX = noteXof(off.wordLeft, off.originLeft, scaleOff);
					const painted = paintedXof(noteX, on.originLeft, scaleOn);
					rows.push({
						name: `${lineWidth}/${maxWidth}/${cc.name}/${paneWidth}px`,
						helper: cc.name === "(none)" ? "" : cc.name,
						originError: on.originLeft - on.textLeft,
						paintError: painted - on.wordLeft,
						columnMove: on.textLeft - off.textLeft,
						colWidth: on.textWidth,
						contentWidth: on.contentWidth,
						detail:
							`col ${on.textLeft.toFixed(1)} w ${on.textWidth.toFixed(1)} ` +
							`content ${on.contentLeft.toFixed(1)}/${on.contentWidth.toFixed(1)} ` +
							`tbl ${on.tableLeft?.toFixed(1) ?? "-"} img ${on.imgLeft?.toFixed(1) ?? "-"}`,
					});
				}
			}
		}
	}
	return rows;
}

/**
 * WHAT THE MATRIX FOUND, and why it is the theme's own arithmetic rather than
 * a fixture artefact.
 *
 * `--content-margin-start` (theme.css:1833) is declared on `body`, and the
 * `var(--line-width)` inside it is substituted AT COMPUTED-VALUE TIME ON BODY.
 * `body .wide` and `body .max` (theme.css:1951, 1960) redefine `--line-width`
 * further DOWN the tree, on the element carrying the note's `cssclasses`. The
 * already-computed `--content-margin-start` merely inherits past them: it still
 * describes the DEFAULT column.
 *
 * The line boxes are centred by `margin-inline: auto` and so follow the new
 * `--line-width` correctly. The TABLE container is not: its margin is
 * `calc(var(--content-margin-start) - var(--table-drag-space))`
 * (theme.css:1981), a hard offset built from the stale value. Under `.wide` the
 * text column widens and moves LEFT while the table line stays where the
 * default column used to be - so the table line ends up to the RIGHT of the
 * text.
 *
 * That falsifies the stated premise of `contentOriginLeft`'s maximum rule -
 * "Nothing in these rules pushes a text line further right than the column, so
 * the maximum is safe in the other direction" (`ContentOrigin.ts`). The maximum
 * then picks the table line, and every stroke on the note paints that far right
 * of where it was written.
 */
describe("A. the Minimal settings matrix, ordinary prose", () => {
	let rows: Row[];
	beforeAll(async () => {
		const page = await openSweep(browser);
		rows = await sweepMatrix(page);
		await page.close();
		table("A. matrix, cells past the one-pixel tolerance", rows.filter((r) => Math.abs(r.originError) > TOL || Math.abs(r.paintError) > TOL));
		table("A. matrix, shipped defaults", rows.filter((r) => r.name.startsWith("40rem/88%/")));
	}, 180_000);

	it("preconditions: every cell really is a Minimal cell that moves", () => {
		expect(rows.length).toBe(
			LINE_WIDTHS.length * MAX_WIDTHS.length * CLASS_CASES.length * PANES.length
		);
		// The toggle has to MOVE the column, or nothing below is exercised.
		// The legitimate exception is a cell whose readable-ON column already
		// spans the whole content box - there is nothing left to re-centre.
		const moved = rows.filter((r) => Math.abs(r.columnMove) > TOL);
		const flat = rows.filter((r) => Math.abs(r.columnMove) <= TOL);
		expect(moved.length).toBeGreaterThan(200);
		for (const r of flat) expect(r.colWidth).toBeCloseTo(r.contentWidth, 1);
	});

	it("outside the wide/max helpers, origin and ink are exact in every cell", () => {
		// 1.4.9's claim, restated over the whole width space rather than the
		// one configuration it was tested against: line width, maximum width,
		// pane width, the table and image helper families, and both Minimal
		// Settings table toggles. This is the green half and it is the larger
		// half - the defect is not "Minimal", it is two specific helpers.
		const scoped = rows.filter((r) => r.helper !== "wide" && r.helper !== "max");
		expect(scoped.length).toBe(rows.length - LINE_WIDTHS.length * MAX_WIDTHS.length * 2 * PANES.length);
		expect(scoped.filter((r) => Math.abs(r.originError) > TOL).map((r) => r.name)).toEqual([]);
		expect(scoped.filter((r) => Math.abs(r.paintError) > TOL).map((r) => r.name)).toEqual([]);
	});

	/**
	 * The setup proof for the two `it.fails` below, kept green on purpose:
	 * `it.fails` passes on ANY error, a broken fixture included, so what those
	 * two depend on is asserted separately here
	 * (`PageStoreTwoDocuments.test.ts:66-76` states the rule). Break the
	 * cascade and this goes red instead of quietly passing.
	 */
	it("mechanism: under wide/max the table line lands RIGHT of the text column", async () => {
		const page = await openSweep(browser);
		const wide = await read(page, cfg({ viewClasses: ["wide"] }));
		const max = await read(page, cfg({ viewClasses: ["max"] }));
		const none = await read(page, cfg());
		await page.close();

		// Default: the table is pulled LEFT by --table-drag-space, exactly as
		// `contentOriginLeft`'s doc comment describes, and the maximum rule
		// steps over it.
		expect(none.tableLeft).toBeCloseTo(none.textLeft - 16, 1);
		expect(none.originLeft).toBeCloseTo(none.textLeft, 1);

		// `.wide` widens the column (40rem -> 40rem + 12.5%) and so moves it
		// left, while the table's margin stays built on the stale
		// `--content-margin-start`. The premise of the maximum rule fails.
		expect(wide.textWidth).toBeGreaterThan(none.textWidth + 100);
		expect(wide.textLeft).toBeLessThan(none.textLeft - 50);
		expect(wide.tableLeft).toBeCloseTo(none.textLeft - 16, 1);
		expect(wide.tableLeft as number).toBeGreaterThan(wide.textLeft + 50);

		// `.max` is the same mechanism with a bigger arm.
		expect(max.tableLeft).toBeCloseTo(none.textLeft - 16, 1);
		expect(max.tableLeft as number).toBeGreaterThan(max.textLeft + 200);
	}, 120_000);

	it("CONFIRMED: contentOriginLeft equals the visible text column in every cell", () => {
		const bad = rows.filter((r) => Math.abs(r.originError) > TOL);
		expect(bad.map((r) => r.name)).toEqual([]);
	});

	it("CONFIRMED: the reduced paint law survives the toggle in every cell", () => {
		const bad = rows.filter((r) => Math.abs(r.paintError) > TOL);
		expect(bad.map((r) => r.name)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// B. Windows display scaling.
// ---------------------------------------------------------------------------

describe("B. Windows display scaling (deviceScaleFactor)", () => {
	it("1, 1.25, 1.5 and 2 are the same geometry to the pixel", async () => {
		const rows: Row[] = [];
		for (const dpr of [1, 1.25, 1.5, 2]) {
			const page = await openSweep(browser, { deviceScaleFactor: dpr });
			for (const cc of CLASS_CASES.slice(0, 3)) {
				for (const paneWidth of PANES) {
					const c = cfg({
						viewClasses: cc.viewClasses,
						bodyClasses: cc.bodyClasses,
						paneWidth,
					});
					const { off, on } = await toggle(page, c);
					const scaleOff = totalScale(off, off.fontPx);
					const scaleOn = totalScale(on, off.fontPx);
					const noteX = noteXof(off.wordLeft, off.originLeft, scaleOff);
					rows.push({
						name: `dpr ${dpr} / ${cc.name} / ${paneWidth}px`,
						helper: cc.name === "(none)" ? "" : cc.name,
						originError: on.originLeft - on.textLeft,
						paintError: paintedXof(noteX, on.originLeft, scaleOn) - on.wordLeft,
						columnMove: on.textLeft - off.textLeft,
						colWidth: on.textWidth,
						contentWidth: on.contentWidth,
						detail: `cssScale ${on.cssScale.toFixed(4)} col ${on.textLeft.toFixed(2)}`,
					});
				}
			}
			await page.close();
		}
		table("B. device scale factor", rows);

		// Precondition: the toggle is still doing something at every dpr.
		for (const r of rows) expect(Math.abs(r.columnMove)).toBeGreaterThan(TOL);

		// THE ANSWER. Windows display scaling arrives as `devicePixelRatio`;
		// layout, `getBoundingClientRect` and `offsetWidth` are all CSS px and
		// none of them move. Asserted as an EQUALITY between the four runs
		// rather than as four independent tolerances, because "dpr changes
		// nothing" is the claim and a per-run tolerance would not test it.
		const perDpr = [1, 1.25, 1.5, 2].map((d) => rows.filter((r) => r.name.startsWith(`dpr ${d} /`)));
		const first = perDpr[0];
		if (!first) throw new Error("no dpr 1 rows");
		for (const set of perDpr.slice(1)) {
			expect(set.length).toBe(first.length);
			for (let i = 0; i < set.length; i++) {
				const a = first[i];
				const b = set[i];
				if (!a || !b) throw new Error("dpr row mismatch");
				expect(b.originError).toBeCloseTo(a.originError, 4);
				expect(b.colWidth).toBeCloseTo(a.colWidth, 4);
			}
		}
		// And where 1.4.9 is correct at dpr 1 it stays correct at 2: the
		// `wide`/`max` rows carry scenario A's defect at every dpr, which is
		// itself the point - display scaling neither causes nor cures it.
		const plain = rows.filter((r) => r.helper === "");
		expect(plain.filter((r) => Math.abs(r.originError) > TOL).map((r) => r.name)).toEqual([]);
		expect(plain.filter((r) => Math.abs(r.paintError) > TOL).map((r) => r.name)).toEqual([]);
	}, 180_000);
});

// ---------------------------------------------------------------------------
// C. Font zoom, D. transform zoom.
// ---------------------------------------------------------------------------

describe("C. a font-size change on .cm-content", () => {
	it("does not move Minimal's rem column, and the origin agrees at every size", async () => {
		const page = await openSweep(browser);
		const rows: Row[] = [];
		const base = await read(page, cfg({ fontSize: "16px" }));
		for (const fontSize of ["12px", "16px", "20px", "26px"]) {
			const r = await read(page, cfg({ fontSize }));
			const noteX = noteXof(base.wordLeft, base.originLeft, totalScale(base, base.fontPx));
			rows.push({
				name: `font ${fontSize}`,
				...geom(r),
				originError: r.originLeft - r.textLeft,
				paintError: paintedXof(noteX, r.originLeft, totalScale(r, base.fontPx)) - r.wordLeft,
				columnMove: r.textLeft - base.textLeft,
				detail:
					`col ${r.textLeft.toFixed(2)} w ${r.textWidth.toFixed(2)} ` +
					`fontZoom ${fontZoomFactor(r.fontPx, base.fontPx).toFixed(4)} ` +
					`word ${r.wordLeft.toFixed(2)}`,
			});
		}
		await page.close();
		table("C. font zoom", rows);

		// The origin question, which is what this branch's code answers.
		expect(rows.filter((r) => Math.abs(r.originError) > TOL).map((r) => r.name)).toEqual([]);
		// And the mechanism behind it, asserted rather than assumed: Minimal's
		// `--line-width` is 40REM - root-relative - so an editor font change
		// reflows the text INSIDE a column that does not move. This is the
		// same under stock (`--file-line-width` is px), so it is not a
		// Minimal-specific hazard; scenario C's paint numbers are the cost of
		// `fontZoom` scaling ink against a fixed column, which is the shipped
		// view-transform semantics and not this branch's question.
		for (const r of rows) expect(Math.abs(r.columnMove)).toBeLessThanOrEqual(TOL);
	}, 120_000);
});

describe("D. a CSS transform on .cm-editor", () => {
	it("origin and scale come from one frame, so the toggle still lands", async () => {
		const page = await openSweep(browser);
		const rows: Row[] = [];
		for (const editorScale of [1, 1.25, 1.75]) {
			const { off, on } = await toggle(page, cfg({ editorScale }));
			const scaleOff = totalScale(off, off.fontPx);
			const scaleOn = totalScale(on, off.fontPx);
			const noteX = noteXof(off.wordLeft, off.originLeft, scaleOff);
			rows.push({
				name: `editor scale ${editorScale}`,
				...geom(on),
				originError: on.originLeft - on.textLeft,
				paintError: paintedXof(noteX, on.originLeft, scaleOn) - on.wordLeft,
				columnMove: on.textLeft - off.textLeft,
				detail: `cssScale ${on.cssScale.toFixed(4)} noteX ${noteX.toFixed(2)}`,
			});
		}
		await page.close();
		table("D. transform zoom", rows);
		// Precondition: the transform really is visible to `effectiveScale`,
		// or this scenario is measuring an untransformed page three times.
		const scaled = rows.filter((r) => r.name !== "editor scale 1");
		expect(scaled.length).toBe(2);
		for (const r of scaled) expect(r.detail).not.toContain("cssScale 1.0000");
		expect(rows.filter((r) => Math.abs(r.originError) > TOL).map((r) => r.name)).toEqual([]);
		expect(rows.filter((r) => Math.abs(r.paintError) > TOL).map((r) => r.name)).toEqual([]);
	}, 120_000);
});

// ---------------------------------------------------------------------------
// E. A viewport of wide block lines - the one confirmed defect.
// ---------------------------------------------------------------------------

/**
 * WHAT SCENARIO E IS. `contentOriginLeft` scans at most
 * `ContentOrigin.ts#SCAN_LIMIT` (12) children of `.cm-content` and takes the
 * MAXIMUM left over the `.cm-line`s among them, which steps over Minimal's
 * deliberately-wider block lines. `.cm-content`'s children are CodeMirror's
 * RENDERED RANGE, not the whole document, so what is in that window changes as
 * the note scrolls. Scroll into a run of twelve consecutive embed lines and
 * every candidate in the window is a wide block: the maximum is then the
 * widest block's left, not the column's, and every stroke on the note
 * repaints shifted left until an ordinary line scrolls back into the window.
 *
 * HOW MUCH RESTS ON THE DOM SHAPE. The image arm rests on `div:has(.image-embed)`
 * being a direct `div` child of `.cm-content` that also carries `.cm-line` -
 * which is what Minimal's own selector implies, and what this repo's existing
 * fixture (`columnPage.ts`) already assumed for the table arm. If Obsidian in
 * fact renders these as non-`.cm-line` widget divs, they land in
 * `contentOriginLeft`'s `others` bucket instead, `lines` is empty, and the
 * function returns the same wrong number by the other branch - the defect
 * survives either way, which is why the fix spec does not depend on settling
 * it.
 */
describe("E. a viewport whose scanned children are all wide block lines", () => {
	let img100: { off: Reading; on: Reading };
	let imgDefault: { off: Reading; on: Reading };
	let tableDefault: { off: Reading; on: Reading };
	let mixed: { off: Reading; on: Reading };

	beforeAll(async () => {
		const page = await openSweep(browser);
		img100 = await toggle(page, cfg({ shape: "gallery-img", viewClasses: ["img-100"] }));
		imgDefault = await toggle(page, cfg({ shape: "gallery-img" }));
		tableDefault = await toggle(page, cfg({ shape: "gallery-table" }));
		mixed = await toggle(page, cfg({ shape: "gallery-mixed", viewClasses: ["img-100"] }));
		await page.close();
		/** Origin error and paint error, from the same pair of readings. */
		const eRow = (name: string, t: { off: Reading; on: Reading }, helper: string): Row => {
			const noteX = noteXof(t.off.wordLeft, t.off.originLeft, totalScale(t.off, t.off.fontPx));
			return {
				name,
				...geom(t.on, helper),
				originError: t.on.originLeft - t.on.textLeft,
				paintError:
					paintedXof(noteX, t.on.originLeft, totalScale(t.on, t.off.fontPx)) - t.on.wordLeft,
				columnMove: t.on.textLeft - t.off.textLeft,
				detail:
					`origin ${t.on.originLeft.toFixed(2)} col ${t.on.textLeft.toFixed(2)} ` +
					`img ${t.on.imgLeft?.toFixed(2) ?? "-"} tbl ${t.on.tableLeft?.toFixed(2) ?? "-"}`,
			};
		};
		table("E. wide-block viewports", [
			eRow("gallery-img + img-100", img100, "img-100"),
			eRow("gallery-img + default Minimal", imgDefault, ""),
			eRow("gallery-table + default Minimal", tableDefault, ""),
			eRow("gallery-mixed + img-100 (control)", mixed, "img-100"),
		]);
	}, 120_000);

	/**
	 * The setup proof for the two `it.fails` below, kept green on purpose:
	 * `it.fails` passes on ANY error, including a broken fixture, so what those
	 * two depend on is asserted separately here. Break the fixture and this
	 * one goes red (`PageStoreTwoDocuments.test.ts:66-76` states the rule).
	 */
	it("setup: the scan window really is closed before any text line", () => {
		// Twelve wide lines, then the text. More children than the window.
		expect(img100.on.childCount).toBeGreaterThan(12);
		expect(tableDefault.on.childCount).toBeGreaterThan(12);
		// The ground-truth column exists and is where Minimal centres it.
		expect(img100.on.textLeft).toBeGreaterThan(img100.on.contentLeft + 100);
		expect(tableDefault.on.textLeft).toBeGreaterThan(tableDefault.on.contentLeft + 100);
		// And the wide lines really are wide - the hazard is present, not
		// assumed. `img-100` pins the image line to `.cm-content`'s own left;
		// a default table line is pulled out by `--table-drag-space` only.
		expect(img100.on.imgLeft).toBeCloseTo(img100.on.contentLeft, 1);
		expect(tableDefault.on.tableLeft).toBeCloseTo(tableDefault.on.textLeft - 16, 1);
	});

	it("control: with one ordinary line co-visible the maximum rule picks the column", () => {
		// Same theme, same helper, same shape of hazard - only the scan window
		// differs. This is the case 1.4.9 was written for and it holds.
		expect(mixed.on.imgLeft).toBeCloseTo(mixed.on.contentLeft, 1);
		expect(mixed.on.originLeft).toBeCloseTo(mixed.on.textLeft, 1);
	});

	it("an image line under DEFAULT Minimal sits on the column, so default galleries are safe", () => {
		// theme.css:2224-2229 sets width only; `margin-inline: auto !important`
		// from the base rule (theme.css:1866) still centres it, and
		// `--container-img-width` defaults to `--line-width`. So the wide-image
		// hazard needs one of the `.img-*` helpers to exist at all.
		expect(imgDefault.on.imgLeft).toBeCloseTo(imgDefault.on.textLeft, 1);
		expect(imgDefault.on.originLeft).toBeCloseTo(imgDefault.on.textLeft, 1);
	});

	it(
		"CONFIRMED (img-100): the origin follows the images, not the text column",
		() => {
			expect(img100.on.originLeft).toBeCloseTo(img100.on.textLeft, 1);
		}
	);

	it(
		"CONFIRMED (default Minimal, tables): the origin is short by --table-drag-space",
		() => {
			expect(tableDefault.on.originLeft).toBeCloseTo(tableDefault.on.textLeft, 1);
		}
	);
});

// ---------------------------------------------------------------------------
// F. Stock control.
// ---------------------------------------------------------------------------

describe("F. stock Obsidian, the same sweep", () => {
	it("the origin stays on .cm-content's own left, wide blocks and all", async () => {
		const page = await openSweep(browser, {
			css: [STOCK_READABLE_RULE, LINE_WIDTH_VARS].join("\n"),
		});
		const prose = await toggle(page, cfg());
		const gallery = await read(page, cfg({ shape: "gallery-img" }));
		await page.close();
		// Precondition: stock geometry moves `.cm-content` ITSELF, which is
		// the property that made the pre-1.4.9 code correct here.
		expect(Math.abs(prose.on.contentLeft - prose.off.contentLeft)).toBeGreaterThan(100);
		// The equality that keeps every already-persisted stroke meaning what
		// it meant under the theme the old code already handled.
		expect(prose.off.originLeft).toBeCloseTo(prose.off.contentLeft, 1);
		expect(prose.on.originLeft).toBeCloseTo(prose.on.contentLeft, 1);
		expect(prose.on.originLeft).toBeCloseTo(prose.on.textLeft, 1);
		// And scenario E's hazard does not exist here: with no theme rule
		// widening a block past the column, a gallery viewport measures the
		// same left as the text does.
		expect(gallery.originLeft).toBeCloseTo(gallery.textLeft, 1);
	}, 120_000);
});

// ---------------------------------------------------------------------------
// G. Inline image embeds inside ordinary lines.
// ---------------------------------------------------------------------------

/**
 * THE HAZARD THE PROBE ITSELF CREATED.
 *
 * Scenario E above is why `contentOrigin` drops a `.cm-line` carrying a block
 * widget: under `cssclasses: wide` the table line sits RIGHT of the text and
 * wins the maximum outright. The probe that does the dropping asked
 * `line.querySelector('table, .image-embed, ...')` - a SUBTREE query.
 *
 * `.image-embed` is not only a block shape. `text ![[img.png]] text` renders
 * `span.internal-embed.image-embed` in the middle of an ordinary line, and
 * Obsidian users write that constantly. A subtree probe rejects that line -
 * whose left edge IS the column's - and if every line phase A samples carries
 * one, phase A finds nothing and hands the answer to phase B, which measures
 * the leading children of any kind. The first of those is the table line, and
 * the origin lands on it: the +71.5px error scenario E exists to prevent,
 * reintroduced through the fix for it.
 *
 * The discriminator is free and it is the tag. Obsidian spells a block embed
 * `div` and an inline one `span`, and the probe now looks at a line's
 * IMMEDIATE children only - which also stops it walking the subtree of every
 * ordinary line on a path that runs per keystroke.
 *
 * `--container-img-width` (theme.css:2225) defaults to `--line-width`, so
 * these lines sit on the column under every helper except the `img-*` family,
 * which is what makes them ground truth here. The table line is what moves.
 */
describe("G. ordinary lines carrying an inline image embed", () => {
	let wide: Reading;
	let stockish: Reading;

	beforeAll(async () => {
		const page = await openSweep(browser);
		wide = await read(page, cfg({ shape: "inline-img", viewClasses: ["wide"] }));
		stockish = await read(page, cfg({ shape: "inline-img" }));
		await page.close();
		table("G. inline image embeds", [
			{
				name: "inline-img + wide",
				...geom(wide, "wide"),
				originError: wide.originLeft - wide.textLeft,
				paintError: 0,
				columnMove: 0,
				detail:
					`origin ${wide.originLeft.toFixed(2)} col ${wide.textLeft.toFixed(2)} ` +
					`tbl ${wide.tableLeft?.toFixed(2) ?? "-"}`,
			},
			{
				name: "inline-img + default Minimal",
				...geom(stockish, ""),
				originError: stockish.originLeft - stockish.textLeft,
				paintError: 0,
				columnMove: 0,
				detail:
					`origin ${stockish.originLeft.toFixed(2)} col ${stockish.textLeft.toFixed(2)} ` +
					`tbl ${stockish.tableLeft?.toFixed(2) ?? "-"}`,
			},
		]);
	}, 120_000);

	it("setup: the hazard is present - a wide table line right of the column", () => {
		// `it.fails` is not used here, but the same rule applies: a scenario
		// that cannot go wrong proves nothing when it goes right. Under
		// `wide` the table really does sit right of the text, and the inline
		// lines really do sit on it.
		expect(wide.tableLeft).not.toBeNull();
		expect(wide.tableLeft ?? 0).toBeGreaterThan(wide.textLeft + 1);
		// Every child in the scan window is one of these lines, so there is no
		// ordinary widget-free line for phase A to fall back on: the thirteen
		// children are the table line plus twelve inline-embed lines.
		expect(wide.childCount).toBe(13);
		expect(wide.scannedLines).toBe(12);
	});

	it("the origin is the text column, not the wide table line beside it", () => {
		expect(wide.originLeft).toBeCloseTo(wide.textLeft, 1);
	});

	it("holds under default Minimal too, where the table sits LEFT of the text", () => {
		// The other direction of the same rule: a default table line is pulled
		// out by `--table-drag-space` and loses the maximum, so this one was
		// never going to move the origin. It is here so a fix that only
		// special-cases `wide` is visible as a fix that only special-cases
		// `wide`.
		expect(stockish.originLeft).toBeCloseTo(stockish.textLeft, 1);
	});
});
