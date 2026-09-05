/**
 * The node half of the RE-SYNC TRIGGER measurement: real Minimal theme rules,
 * a real browser, the real observers `InkOverlay.mount()` installs.
 *
 * `ContentOriginColumn.test.ts` proved the MEASUREMENT half of Bug C - given
 * that the overlay looks, `contentOriginLeft` returns the column's left under
 * Minimal. This file asks the other half, which that test cannot see: when
 * Minimal moves the column, does anything the overlay observes FIRE, so that
 * it looks at all? A camera that is right whenever it is re-derived and is
 * never re-derived is still ink in the wrong place on the user's screen.
 *
 * The page half (`minimalResyncPage.ts`) builds the subtree, installs the
 * observers and counts callbacks. This file supplies the stylesheets and
 * holds every citation, per the house style set by `ContentOriginColumn`.
 *
 * Run: npm run test:render.
 *
 * SOURCE OF THE MINIMAL RULES. Verbatim, from
 * `C:\Users\alanl\Obsidian\ObsidianVaults\vault test 2\.obsidian\themes\Minimal\theme.css`
 * (Minimal 9.0.2, 8709 lines on disk in this vault). Line numbers below were
 * re-verified against that file for this test, not inherited.
 *
 * SOURCE OF THE CODEMIRROR RULES. Verbatim, from
 * `node_modules/@codemirror/view/dist/index.js:6508-6564` (`baseTheme$1`),
 * at the version this repo pins, `@codemirror/view@6.38.6`. These are new
 * here - `ContentOriginColumn.test.ts` has no CodeMirror layout at all - and
 * they are load-bearing for THIS question rather than cosmetic: `.cm-scroller`
 * is what makes the editor a fixed-height scrolling box, and without that
 * `.cm-editor`'s height would track the document, so the plugin's editor
 * `ResizeObserver` would fire on every rewrap for a reason no real editor
 * has, and every "the plugin noticed" answer below would be a fixture
 * artefact.
 *
 * WHAT IS OMITTED, and why:
 *   - `.cm-scroller { display: flex; align-items: flex-start }` from that same
 *     base theme. Keeping it would make `.cm-sizer` a flex item that shrinks
 *     to its content, and the `flex-grow` that Obsidian's own app.css supplies
 *     to stop that is NOT on disk in this repo - so the fixture would have to
 *     invent it. Dropped instead, with a precondition asserted on every
 *     reading (`container.width === scroller.clientWidth`): the chain from
 *     the scroller down to `.cm-contentContainer` fills the pane in every
 *     state, which is the only property of it these measurements depend on.
 *     If a rule change ever breaks that, the preconditions go red rather
 *     than the numbers going quietly wrong.
 *   - every `.markdown-preview-view` arm (reader mode, irrelevant to
 *     `contentDOM`), `.is-mobile` / `.cards` modifiers, and the
 *     `> *:not(div)` rule at theme.css:1869-1872 - the same omissions
 *     `ContentOriginColumn.test.ts` documents, for the same reasons.
 *
 * WHAT THIS CANNOT ANSWER. There is no CodeMirror instance here, so the
 * overlay's fourth trigger - a `ViewUpdate` with `geometryChanged`
 * (InkOverlay.ts:1620) - cannot be counted. It is reasoned about instead,
 * from `ViewState.measure` in the pinned CodeMirror
 * (`node_modules/@codemirror/view/dist/index.js:6043-6101`), which sets
 * `UpdateFlag.Geometry` when and only when the content scale, the content
 * padding, `scrollDOM.clientWidth`, `scrollDOM.clientHeight` or
 * `contentDOM.getBoundingClientRect().width` changes - and which runs only
 * when something calls `requestMeasure`. CodeMirror's own DOMObserver has
 * exactly one `ResizeObserver`, on `view.scrollDOM`
 * (dist/index.js:6853-6859), plus a `window` resize listener
 * (dist/index.js:7183-7184). Each scenario below states what that machinery
 * would have done.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import type { BuildOptions, Kind, Trial } from "./minimalResyncPage";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/* ------------------------------------------------------------------ */
/* Stylesheets                                                         */
/* ------------------------------------------------------------------ */

const RESET_CSS = `
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-size: 16px; }
`;

/**
 * `@codemirror/view@6.38.6`, dist/index.js:6508-6564 (`baseTheme$1`),
 * transcribed from the JS object into CSS. `.cm-scroller`'s `height: 100%`
 * plus `overflow-x: auto` is the pair that makes the editor a fixed-height
 * scrolling box: per CSS overflow, an `overflow-y: visible` beside a
 * non-visible `overflow-x` computes to `auto`, so the scroller scrolls
 * vertically without CodeMirror ever saying so.
 */
const CM_BASE_CSS = `
.cm-editor { position: relative; box-sizing: border-box; }
.cm-scroller {
  height: 100%;
  overflow-x: auto;
  position: relative;
  z-index: 0;
  overflow-anchor: none;
  line-height: 1.4;
}
.cm-content {
  margin: 0;
  display: block;
  white-space: pre;
  word-wrap: normal;
  box-sizing: border-box;
  min-height: 100%;
  padding: 4px 0;
  outline: none;
}
.cm-lineWrapping {
  white-space: break-spaces;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.cm-line { display: block; padding: 0 2px 0 6px; }
`;

/**
 * Obsidian's own chrome, which has no app.css on disk in this repo. These
 * three declarations are PARAMETERS of the measurement, written down rather
 * than inherited by accident: the pane is a fixed box, and the editor fills
 * it. Any real Obsidian markdown pane has both properties.
 */
const HOST_CSS = `
.hw-pane { position: relative; overflow: hidden; }
.markdown-source-view { height: 100%; }
.cm-editor { height: 100%; }
`;

const PAGE_CSS = [RESET_CSS, CM_BASE_CSS, HOST_CSS].join("\n");

/** theme.css:53,56 - the two lengths every other rule below is built from. */
const LINE_WIDTH_VARS = `
body { --line-width: 40rem; --max-width: 88%; }
`;

/** theme.css:1831-1838 - the margin that centres a column child. */
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
 * theme.css:1852-1867. The root of the defect: `.cm-content` is forced full
 * width (never narrows, never moves), and the LINE `div`s inside it are given
 * the column width and centred instead.
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

/** theme.css:1924 and theme.css:1980-1983, as in `ContentOriginColumn`. */
const TABLE_VARS = `
body { --container-table-max-width: var(--max-width); }
body {
  --table-drag-space: 16px;
  --container-table-margin: calc(var(--content-margin-start) - var(--table-drag-space));
  --container-table-width: calc(var(--line-width) + var(--table-drag-space)*2);
}
`;

/** theme.css:2171-2178 - the wide block the origin rule has to step over. */
const WIDE_BLOCK_RULE = `
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > div:has(table) {
  width: var(--container-table-width);
  max-width: var(--container-table-max-width);
  margin-inline: var(--container-table-margin) !important;
}
`;

/**
 * theme.css:583 and theme.css:1951-1967. NEW here, and the reason scenario
 * (d) exists. Note the selectors: `body .wide` and `body .max` are DESCENDANT
 * selectors, so the class goes on an element INSIDE body - which is where
 * Obsidian puts a `cssclasses:` frontmatter value, on the view. A class on
 * `body` itself matches neither.
 */
const WIDE_MAX_HELPERS = `
body { --line-width-wide: calc(var(--line-width) + 12.5%); }
body .wide {
  --line-width: var(--line-width-wide);
  --container-table-width: var(--line-width-wide);
}
body .max {
  --line-width: var(--max-width);
  --container-table-width: var(--max-width);
}
`;

const MINIMAL_CSS = [
	LINE_WIDTH_VARS,
	CONTENT_MARGIN_VARS,
	COLUMN_RULE,
	TABLE_VARS,
	WIDE_BLOCK_RULE,
	WIDE_MAX_HELPERS,
].join("\n");

/**
 * Stock Obsidian's own rule, NOT from a vendor file - there is no app.css on
 * disk in this repo. Written down from the citation already in this codebase
 * (`InkOverlay.ts:1868`, `PaneWidthGeometry.test.ts:640`), exactly as
 * `ContentOriginColumn.test.ts` does. `.cm-content` ITSELF narrows and
 * centres, which is why every trigger below behaves differently under it.
 */
const STOCK_CSS = `
body { --file-line-width: 700px; }
.markdown-source-view.mod-cm6.is-readable-line-width .cm-content {
  max-width: var(--file-line-width);
  margin: 0 auto;
}
`;

/* ------------------------------------------------------------------ */
/* Driving the page                                                    */
/* ------------------------------------------------------------------ */

let bundled: string | null = null;

async function pageBundle(): Promise<string> {
	if (bundled) return bundled;
	const out = await esbuild({
		entryPoints: [here("./minimalResyncPage.ts")],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		target: "es2022",
	});
	const file = out.outputFiles[0];
	if (!file) throw new Error("esbuild produced no output for minimalResyncPage.ts");
	bundled = file.text;
	return bundled;
}

async function openPage(browser: Browser, css: string): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
	await page.setContent("<!doctype html><meta charset=utf-8><title>resync trigger</title>");
	await page.addStyleTag({ content: PAGE_CSS });
	await page.addStyleTag({ content: css });
	await page.addScriptTag({ content: await pageBundle() });
	return page;
}

/** Builds a fresh fixture and runs one perturbation on it. */
async function trial(
	page: Page,
	opts: BuildOptions,
	kind: Kind,
	arg?: string | number
): Promise<Trial> {
	const t = await page.evaluate(
		async (a) => {
			window.__hwsync.build(a.opts);
			return window.__hwsync.trial(a.kind, a.arg);
		},
		{ opts, kind, arg }
	);
	assertFixtureSane(t);
	return t;
}

/**
 * Runs `first`, discards its result, then measures `second` - the only way to
 * perturb something that is already in the fixture's default state.
 */
async function trialAfter(
	page: Page,
	opts: BuildOptions,
	first: Kind,
	second: Kind
): Promise<Trial> {
	const t = await page.evaluate(
		async (a) => {
			window.__hwsync.build(a.opts);
			await window.__hwsync.trial(a.first);
			return window.__hwsync.trial(a.second);
		},
		{ opts, first, second }
	);
	assertFixtureSane(t);
	return t;
}

/**
 * The standing precondition named in the header: the chain from the scroller
 * down to `.cm-contentContainer` fills the pane in every state, so dropping
 * CodeMirror's flex display cannot have moved anything measured here. It is
 * asserted on the CONTAINER rather than on `.cm-content`, because under stock
 * Obsidian `.cm-content` is precisely the element that does not fill - that
 * is the theme difference the whole file turns on.
 */
function assertFixtureSane(t: Trial): void {
	for (const s of [t.before, t.after]) {
		expect(s.container.width).toBeCloseTo(s.scrollerClientWidth, 0);
	}
}

/** Short lines: a note of headings and bullets. Nothing rewraps, ever. */
const SHORT = (paneWidth: number): BuildOptions => ({
	paneWidth,
	paneHeight: 600,
	wrap: false,
});
/** Wrapping prose: the other ordinary kind of note. */
const PROSE = (paneWidth: number): BuildOptions => ({
	paneWidth,
	paneHeight: 600,
	wrap: true,
});

/** Did any observer the PLUGIN actually installs fire? */
const pluginNoticed = (t: Trial): boolean =>
	t.fired.editorRO > 0 ||
	t.fired.contentRO > 0 ||
	t.fired.metadataMO > 0 ||
	t.fired.originLineRO > 0;

/** The column moved far enough that ink pinned to the old origin is visibly wrong. */
const COLUMN_MOVED_PX = 1;

let browser: Browser;
beforeAll(async () => {
	browser = await chromium.launch();
});
afterAll(async () => {
	await browser?.close();
});


/* ------------------------------------------------------------------ */
/* The control                                                         */
/* ------------------------------------------------------------------ */

/**
 * A count of zero only means something if a count of one is reachable. This
 * runs first. It was also the companion green test the three
 * "an overlay observer fires" blocks leaned on while they were `it.fails` -
 * `.fails` passes on ANY error, a broken harness included. Those three are
 * ordinary assertions since 1.4.10 armed the origin-line observer, so they
 * now carry their own weight; this stays because a count of zero anywhere
 * below still means nothing unless a count of one is reachable.
 */
describe("control: the mirrored observers do fire, and the fixture is sane", () => {
	it("narrowing the pane reaches the editor observer, under both width bindings", async () => {
		const page = await openPage(browser, MINIMAL_CSS);
		// The cap binding: `width: var(--line-width)` (40rem) decides, because
		// 88% of either pane is wider than that. The column MOVES and the line
		// does not change size at all.
		const cap = await trial(page, SHORT(1400), "pane-width", 1100);
		// The percentage binding: at 700px, `max-width: 88%` decides, so the
		// line both moves and narrows.
		const pct = await trial(page, SHORT(700), "pane-width", 600);
		await page.close();

		expect(Math.abs(cap.columnShift)).toBeGreaterThan(COLUMN_MOVED_PX);
		expect(Math.abs(pct.columnShift)).toBeGreaterThan(COLUMN_MOVED_PX);

		// The plumbing works. If `settle()` were resolving before
		// `ResizeObserver` delivery, or the observers were watching the wrong
		// elements, this is what would go red.
		expect(cap.fired.editorRO).toBeGreaterThan(0);
		expect(pct.fired.editorRO).toBeGreaterThan(0);

		// And the two bindings differ exactly where they should: the cap case
		// moves the line without resizing it, which is why a line-size trigger
		// alone could not cover a sidebar toggle.
		expect(cap.before.textWidth).toBeCloseTo(cap.after.textWidth, 1);
		expect(cap.fired.lineRO).toBe(0);
		expect(pct.after.textWidth).toBeLessThan(pct.before.textWidth - 1);
		expect(pct.fired.lineRO).toBeGreaterThan(0);
	});

	it("the production origin rule agrees with the text column in the ordinary case", async () => {
		const page = await openPage(browser, MINIMAL_CSS);
		const t = await trial(page, SHORT(1400), "pane-width", 1100);
		await page.close();

		// Not a restatement of `ContentOriginColumn.test.ts`: it is the tie
		// between THIS fixture's ground truth (`textLeft`, read from a plain
		// `.cm-line`) and the bundled production measurement. Everything below
		// reports both, and they must agree wherever nothing exotic is on.
		expect(t.before.originLeft).toBeCloseTo(t.before.textLeft, 1);
		expect(t.after.originLeft).toBeCloseTo(t.after.textLeft, 1);
	});
});

/* ------------------------------------------------------------------ */
/* Minimal, a note of short lines: three confirmed trigger gaps         */
/* ------------------------------------------------------------------ */

/**
 * Every scenario in this block is a note whose lines are SHORT - headings,
 * short bullets, a task list. Nothing rewraps when the column narrows, so
 * `.cm-content`'s height is constant, and constant height plus Minimal's
 * constant full width means `.cm-content` does not change size at all. That
 * is the whole mechanism: both of the overlay's `ResizeObserver`s watch
 * elements that Minimal deliberately holds still.
 */
describe("Minimal, short lines: readable line length", () => {
	/**
	 * What CodeMirror would have done: nothing. `is-readable-line-width` is a
	 * class flip with no DOM mutation, no change to `scrollDOM.clientWidth` or
	 * `clientHeight`, and no change to `contentDOM`'s width - so CodeMirror's
	 * `resizeScroll` observer (on `scrollDOM`) does not fire, nothing calls
	 * `requestMeasure`, and no `ViewUpdate` is produced at all. `repaint()`
	 * would not have run either.
	 */
	it("the column moves while `.cm-content` neither moves nor resizes", async () => {
		const page = await openPage(browser, MINIMAL_CSS);
		const off = await trial(page, SHORT(1400), "readable-off");
		const on = await trialAfter(page, SHORT(1400), "readable-off", "readable-on");
		await page.close();

		// The column really moved, both ways, by a quarter of the pane.
		expect(off.columnShift).toBeLessThan(-COLUMN_MOVED_PX);
		expect(on.columnShift).toBeGreaterThan(COLUMN_MOVED_PX);

		// And `.cm-content` - the element BOTH plugin ResizeObservers watch,
		// and the element every call site read before 1.4.9 - held perfectly
		// still through it. This is the defect in one pair of numbers.
		for (const t of [off, on]) {
			expect(t.contentShift).toBeLessThan(0.5);
			expect(t.contentResize).toBeLessThan(0.5);
			expect(t.editorResize).toBeLessThan(0.5);
		}

		// Which candidate triggers WOULD have caught it: the line's own size,
		// and the view element's class attribute.
		for (const t of [off, on]) {
			expect(t.fired.lineRO).toBeGreaterThan(0);
			expect(t.fired.textLineRO).toBeGreaterThan(0);
			expect(t.fired.viewClassMO).toBeGreaterThan(0);
		}
	});

	// The fix, from the outside. Was `it.fails` while 1.4.9 shipped with no
	// trigger for this; 1.4.10 arms a ResizeObserver on the line the origin
	// scan picks, and the readable-line-length flip resizes that line.
	it("an overlay observer fires when readable line length moves the column", async () => {
		const page = await openPage(browser, MINIMAL_CSS);
		const off = await trial(page, SHORT(1400), "readable-off");
		await page.close();
		expect(Math.abs(off.columnShift)).toBeGreaterThan(COLUMN_MOVED_PX);
		expect(pluginNoticed(off)).toBe(true);
	});
});

describe("Minimal, short lines: the theme's own line-width setting", () => {
	/**
	 * What CodeMirror would have done: nothing, for the same reasons as the
	 * class flip - a custom property changes, no element CodeMirror measures
	 * changes size, nothing calls `requestMeasure`.
	 */
	it("`--line-width` moves the column by either delivery route", async () => {
		const page = await openPage(browser, MINIMAL_CSS);
		const narrow = await trial(page, SHORT(1400), "line-width-inline", "30rem");
		const wide = await trial(page, SHORT(1400), "line-width-inline", "50rem");
		const viaTag = await trial(page, SHORT(1400), "line-width-style-tag", "30rem");
		await page.close();

		// Narrower column centres further right, wider further left.
		expect(narrow.columnShift).toBeGreaterThan(COLUMN_MOVED_PX);
		expect(wide.columnShift).toBeLessThan(-COLUMN_MOVED_PX);
		// The two routes are the same change: an inline custom property on
		// `body`, and a `<style>` element appended to the head - which is how
		// a settings plugin actually delivers one.
		expect(viaTag.columnShift).toBeCloseTo(narrow.columnShift, 1);

		for (const t of [narrow, wide, viaTag]) {
			expect(t.contentShift).toBeLessThan(0.5);
			expect(t.contentResize).toBeLessThan(0.5);
		}

		// THE DECIDING MEASUREMENT FOR THE FIX. A class observer - on the view
		// or on `body` - is blind to this one: no class changed anywhere. Only
		// the line's own size caught all three.
		for (const t of [narrow, wide, viaTag]) {
			expect(t.fired.viewClassMO).toBe(0);
			expect(t.fired.bodyClassMO).toBe(0);
			expect(t.fired.lineRO).toBeGreaterThan(0);
		}
		// The head observer sees only the route that touches the head, so it
		// is not a trigger either - it is a second partial answer.
		expect(narrow.fired.headStyleMO).toBe(0);
		expect(viaTag.fired.headStyleMO).toBeGreaterThan(0);
	});

	// The route no class observer could ever have caught: `viewClassMO` and
	// `bodyClassMO` are pinned at zero four lines above, and the line's own
	// size is what carries it.
	it("an overlay observer fires when `--line-width` moves the column", async () => {
		const page = await openPage(browser, MINIMAL_CSS);
		const narrow = await trial(page, SHORT(1400), "line-width-inline", "30rem");
		await page.close();
		expect(Math.abs(narrow.columnShift)).toBeGreaterThan(COLUMN_MOVED_PX);
		expect(pluginNoticed(narrow)).toBe(true);
	});
});

describe("Minimal, short lines: a per-note `cssclasses` width helper", () => {
	/**
	 * What CodeMirror would have done: nothing. Obsidian writes the
	 * frontmatter class onto the view element; no element CodeMirror measures
	 * changes size.
	 */
	it("`wide` and `max` on the view element move the column", async () => {
		const page = await openPage(browser, MINIMAL_CSS);
		const wide = await trial(page, SHORT(1400), "view-wide");
		const max = await trial(page, SHORT(1400), "view-max");
		await page.close();

		expect(wide.columnShift).toBeLessThan(-COLUMN_MOVED_PX);
		expect(max.columnShift).toBeLessThan(-COLUMN_MOVED_PX);
		for (const t of [wide, max]) {
			expect(t.contentShift).toBeLessThan(0.5);
			expect(t.contentResize).toBeLessThan(0.5);
			expect(t.fired.lineRO).toBeGreaterThan(0);
			expect(t.fired.viewClassMO).toBeGreaterThan(0);
		}

		// THE FINDING THIS FILE PINNED IN 1.4.9, fixed in 1.4.10 and kept here
		// as a regression. `.wide` widens the table's
		// `--container-table-width` but leaves `--container-table-margin` at
		// the value `--content-margin-start` computed on `body` from the BASE
		// `--line-width` (theme.css:1951-1958 sets the width and not the
		// margin), so the table line ends up to the RIGHT of the text - and
		// the maximum rule took it, which put the origin past the words rather
		// than on them. The scan now drops a `.cm-line` carrying a block
		// widget before reading its rect, so a table line is no longer
		// evidence about where the column is.
		expect(wide.after.originLeft).toBeCloseTo(wide.after.textLeft, 1);
		expect(max.after.originLeft).toBeCloseTo(max.after.textLeft, 1);
	});

	// Same trigger, third delivery route: a class on the view element.
	it("an overlay observer fires when a width helper moves the column", async () => {
		const page = await openPage(browser, MINIMAL_CSS);
		const wide = await trial(page, SHORT(1400), "view-wide");
		await page.close();
		expect(Math.abs(wide.columnShift)).toBeGreaterThan(COLUMN_MOVED_PX);
		expect(pluginNoticed(wide)).toBe(true);
	});
});

/* ------------------------------------------------------------------ */
/* Minimal, wrapping prose: why the same bug passes on some machines    */
/* ------------------------------------------------------------------ */

/**
 * The single most useful result in this file. Change nothing but the LENGTH
 * of the lines and all three gaps above close: prose rewraps when the column
 * narrows, rewrapping changes `.cm-content`'s HEIGHT, and a height change is
 * a size change, so the overlay's own `contentResizeObserver` fires and
 * `syncCamera()` runs.
 *
 * So "Minimal is broken" and "I tested Minimal and it was fine" can both be
 * honest reports of the same build: it depends on whether the note under test
 * has lines long enough to rewrap.
 */
describe("Minimal, wrapping prose: the content observer fires after all", () => {
	it("all three perturbations reach `contentResizeObserver` when lines rewrap", async () => {
		const page = await openPage(browser, MINIMAL_CSS);
		const readable = await trial(page, PROSE(1400), "readable-off");
		const lineWidth = await trial(page, PROSE(1400), "line-width-inline", "30rem");
		const helper = await trial(page, PROSE(1400), "view-wide");
		await page.close();

		for (const t of [readable, lineWidth, helper]) {
			// Same column movement as the short-line block.
			expect(Math.abs(t.columnShift)).toBeGreaterThan(COLUMN_MOVED_PX);
			// `.cm-content` still does not MOVE and still does not change
			// WIDTH - Minimal holds both of those fixed either way.
			expect(t.contentShift).toBeLessThan(0.5);
			expect(t.after.content.width).toBeCloseTo(t.before.content.width, 1);
			// What changed is height, and that alone is enough.
			expect(Math.abs(t.after.content.height - t.before.content.height)).toBeGreaterThan(1);
			expect(t.fired.contentRO).toBeGreaterThan(0);
			expect(pluginNoticed(t)).toBe(true);
		}
	});
});

/* ------------------------------------------------------------------ */
/* Minimal: perturbations that turn out to move nothing                 */
/* ------------------------------------------------------------------ */

describe("Minimal: perturbations that do not move the column", () => {
	/**
	 * The brief asked for `body.wide` and `body.max`. Minimal's selectors are
	 * `body .wide` and `body .max` (theme.css:1951, 1960) - DESCENDANT
	 * combinators - so a class on `body` itself matches neither rule. Obsidian
	 * puts a `cssclasses:` value on the view element, which is the case
	 * covered above; this one is here to record that the `body` spelling is
	 * inert rather than to leave it untested.
	 */
	it("`wide` / `max` on `body` itself match nothing and move nothing", async () => {
		const page = await openPage(browser, MINIMAL_CSS);
		const wide = await trial(page, SHORT(1400), "body-wide");
		const max = await trial(page, SHORT(1400), "body-max");
		await page.close();

		for (const t of [wide, max]) {
			expect(t.columnShift).toBeCloseTo(0, 1);
			expect(t.after.textWidth).toBeCloseTo(t.before.textWidth, 1);
			// The body-class observer fires; there is simply nothing to react
			// to. A trigger built on it would be pure cost here.
			expect(t.fired.bodyClassMO).toBeGreaterThan(0);
		}
	});

	/**
	 * Minimal's focus mode. Every `minimal-focus-mode` selector in the theme
	 * (theme.css:1014-1015, 3056-3131 and the rest) styles the ribbon, the
	 * workspace split and the view header; the file contains no
	 * `minimal-focus-mode` rule that touches `--line-width`, `--max-width`,
	 * `--content-margin` or `.cm-content`. So it moves the column only by
	 * changing the PANE's width - which is the sidebar case the editor
	 * observer already catches. Held at constant pane width here, it does
	 * nothing at all.
	 */
	it("focus mode at constant pane width does not move the column", async () => {
		const page = await openPage(browser, MINIMAL_CSS);
		const t = await trial(page, SHORT(1400), "focus-mode");
		await page.close();
		expect(t.columnShift).toBeCloseTo(0, 1);
		expect(pluginNoticed(t)).toBe(false);
	});

	/**
	 * Editor font size. `--line-width` is `40rem` - ROOT-relative - so the
	 * column keeps its width and its position while every line gets taller.
	 * The content observer fires anyway, on the height change, which is why
	 * this is not a gap in either direction.
	 *
	 * What CodeMirror would have done: `.cm-content`'s height changes, so a
	 * `requestMeasure` triggered by anything else would see
	 * `contentDOMHeight != domRect.height` and re-measure line heights - but
	 * its own `resizeScroll` observer watches `scrollDOM`, whose size is
	 * unchanged, so nothing schedules that measure on its own.
	 */
	it("editor font size changes the column's height, not its left edge", async () => {
		const page = await openPage(browser, MINIMAL_CSS);
		const t = await trial(page, SHORT(1400), "font-size", "24px");
		await page.close();

		expect(t.columnShift).toBeCloseTo(0, 1);
		expect(t.after.textWidth).toBeCloseTo(t.before.textWidth, 1);
		expect(t.after.content.height).toBeGreaterThan(t.before.content.height + 1);
		expect(t.fired.contentRO).toBeGreaterThan(0);
	});
});

/* ------------------------------------------------------------------ */
/* Stock Obsidian: the contrast                                        */
/* ------------------------------------------------------------------ */

/**
 * The same perturbations under the geometry the pre-1.4.9 code was written
 * for. Nothing here is a gap, and the reason is structural rather than lucky:
 * under stock, `.cm-content` IS the column, so anything that moves the column
 * either resizes it or moves it, and one of the two observers sees it.
 */
describe("stock Obsidian: every column move already reaches an observer", () => {
	it("readable line length resizes `.cm-content` itself", async () => {
		const page = await openPage(browser, STOCK_CSS);
		const off = await trial(page, SHORT(1400), "readable-off");
		const on = await trialAfter(page, SHORT(1400), "readable-off", "readable-on");
		await page.close();

		for (const t of [off, on]) {
			expect(Math.abs(t.columnShift)).toBeGreaterThan(COLUMN_MOVED_PX);
			// Unlike Minimal: the element the overlay watches is the element
			// that moved and resized.
			expect(t.contentShift).toBeGreaterThan(COLUMN_MOVED_PX);
			expect(t.contentResize).toBeGreaterThan(COLUMN_MOVED_PX);
			expect(t.fired.contentRO).toBeGreaterThan(0);
		}
	});

	/**
	 * The case InkOverlay.ts:1866-1874 already describes in prose: a sidebar
	 * at constant `--file-line-width` re-centres `.cm-content` without
	 * resizing it, so the content observer stays quiet and the editor
	 * observer's `handleResize` - and specifically its `contentOriginLeft`
	 * compare in the `unchanged` branch - is what notices.
	 */
	it("a sidebar at the cap moves `.cm-content` without resizing it", async () => {
		const page = await openPage(browser, STOCK_CSS);
		const t = await trial(page, SHORT(1400), "pane-width", 1100);
		await page.close();

		expect(Math.abs(t.columnShift)).toBeGreaterThan(COLUMN_MOVED_PX);
		expect(t.contentShift).toBeGreaterThan(COLUMN_MOVED_PX);
		expect(t.after.content.width).toBeCloseTo(t.before.content.width, 1);
		expect(t.fired.contentRO).toBe(0);
		expect(t.fired.editorRO).toBeGreaterThan(0);
	});

	it("Minimal's own knobs move nothing under stock rules", async () => {
		const page = await openPage(browser, STOCK_CSS);
		const lineWidth = await trial(page, SHORT(1400), "line-width-inline", "30rem");
		const wide = await trial(page, SHORT(1400), "view-wide");
		const max = await trial(page, SHORT(1400), "view-max");
		await page.close();

		// `--line-width`, `.wide` and `.max` are Minimal's vocabulary; stock
		// Obsidian reads `--file-line-width` and nothing else. This is why the
		// bug is a theme report and not a general one.
		for (const t of [lineWidth, wide, max]) {
			expect(t.columnShift).toBeCloseTo(0, 1);
			expect(t.after.textWidth).toBeCloseTo(t.before.textWidth, 1);
		}
	});
});
