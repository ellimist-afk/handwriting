/**
 * The node half of the content-origin measurement: real Minimal theme rules,
 * a real browser, the real `contentOriginLeft` export under test.
 *
 * The page half (`columnPage.ts`) builds the CodeMirror-shaped subtree and
 * exposes `window.__hwcol`. This file supplies the stylesheets and holds
 * every citation, per its own header comment.
 *
 * Run: npm run test:render. Deliberately NOT in `npx vitest run` - see
 * `harness.ts` for why the render suite is a separate script.
 *
 * SOURCE OF THE MINIMAL RULES. Verbatim, from
 * `C:\Users\alanl\Obsidian\ObsidianVaults\vault test 2\.obsidian\themes\Minimal\theme.css`
 * (Minimal, 8709 lines on disk in this vault). Every declaration below is
 * copied from a specific line range, not paraphrased - the whole point of a
 * render suite is that a real engine resolves the real cascade, and a
 * hand-simplified copy would only prove the copy self-consistent. What is
 * OMITTED: every selector arm for `.markdown-preview-view` (reader mode,
 * irrelevant to `contentDOM`), `.is-mobile` / `.wide` / `.max` / `.cards`
 * modifier classes (not applied by this fixture), and the
 * `> *:not(div)` rule at theme.css:1863-1866 (styles the `cm-widgetBuffer`
 * img; omitted because that element has no `src` and already renders at
 * 0x0 without it, which is what `contentOriginLeft` is supposed to skip).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import type { ColumnReading } from "./columnPage";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/** theme.css:53,56 - the two lengths every other rule below is built from. */
const LINE_WIDTH_VARS = `
body { --line-width: 40rem; --max-width: 88%; }
`;

/** theme.css:1832-1836 - the margin that centres a column child. */
const CONTENT_MARGIN_VARS = `
body {
  --content-margin: auto;
  --content-margin-start: max(
    calc(50% - var(--line-width)/2),
    calc(50% - var(--max-width)/2) );
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

/**
 * theme.css:1924 and theme.css:1980-1983. The default (no `.wide`/`.max`/
 * `.cards`/`.is-mobile` modifier) cascade for a table's container width and
 * margin - the LAST unqualified `body { }` block in the file to set these,
 * so it is what actually wins; the earlier declarations at theme.css:1953
 * and 1962 are the `.wide`/`.max` helper classes and do not apply here.
 */
const TABLE_VARS = `
body { --container-table-max-width: var(--max-width); }
body {
  --table-drag-space: 16px;
  --container-table-margin: calc(var(--content-margin-start) - var(--table-drag-space));
  --container-table-width: calc(var(--line-width) + var(--table-drag-space)*2);
}
`;

/**
 * theme.css:2171-2178. Deliberately wider than the column, and pulled
 * correspondingly further left by its own negative-relative margin - this is
 * the hazard `contentOriginLeft`'s doc comment calls out: a block that starts
 * further LEFT than the text and must not be allowed to drag the origin.
 */
const WIDE_BLOCK_RULE = `
.markdown-source-view.mod-cm6.is-readable-line-width .cm-contentContainer.cm-contentContainer > .cm-content > div:has(table) {
  width: var(--container-table-width);
  max-width: var(--container-table-max-width);
  margin-inline: var(--container-table-margin) !important;
}
`;

const MINIMAL_CSS = [
  LINE_WIDTH_VARS,
  CONTENT_MARGIN_VARS,
  COLUMN_RULE,
  TABLE_VARS,
  WIDE_BLOCK_RULE,
].join("\n");

/**
 * Stock Obsidian's own rule, NOT from a vendor file - there is no app.css on
 * disk in this repo. Written down from the citation already in this
 * codebase: `InkOverlay.ts:1836` ("Readable line length caps `.cm-content`
 * at `--file-line-width` and centres it") and `PaneWidthGeometry.test.ts:640`
 * ("`--file-line-width` (700px by default)"). Unlike Minimal, `.cm-content`
 * ITSELF is the thing that narrows and centres - which is the whole reason
 * the pre-1.4.9 code worked under this theme and nowhere else.
 */
const STOCK_CSS = `
body { --file-line-width: 700px; }
.markdown-source-view.mod-cm6.is-readable-line-width .cm-content {
  max-width: var(--file-line-width);
  margin: 0 auto;
}
`;

const RESET_CSS = `
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; }
`;

let bundled: string | null = null;

/** Bundles `columnPage.ts`, which imports the real `contentOriginLeft`. */
async function pageBundle(): Promise<string> {
  if (bundled) return bundled;
  const out = await build({
    entryPoints: [here("./columnPage.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
  });
  const file = out.outputFiles[0];
  if (!file) throw new Error("esbuild produced no output for columnPage.ts");
  bundled = file.text;
  return bundled;
}

async function openColumnPage(browser: Browser, css: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.setContent("<!doctype html><meta charset=utf-8><title>content origin</title>");
  await page.addStyleTag({ content: RESET_CSS });
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: await pageBundle() });
  await page.evaluate(() => window.__hwcol.build());
  return page;
}

/** Sets pane width and the readable-line-width class, then measures. */
async function readColumn(page: Page, readable: boolean, paneWidth: number): Promise<ColumnReading> {
  return page.evaluate(
    (args) => {
      window.__hwcol.setPaneWidth(args.paneWidth);
      window.__hwcol.setReadable(args.readable);
      return window.__hwcol.read();
    },
    { readable, paneWidth }
  );
}

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

describe("Minimal: readable-line-width moves the column without moving .cm-content", () => {
  it("RED, demonstrated: the pre-1.4.9 measurement does not track the column", async () => {
    const page = await openColumnPage(browser, MINIMAL_CSS);
    const off = await readColumn(page, false, 1400);
    const on = await readColumn(page, true, 1400);
    await page.close();

    // eslint-disable-next-line no-console
    console.log("Minimal, readable OFF:", JSON.stringify(off));
    // eslint-disable-next-line no-console
    console.log("Minimal, readable ON: ", JSON.stringify(on));

    // Precondition: the text column really did move. If it didn't, the
    // fixture isn't reproducing the defect and nothing below proves anything.
    expect(on.textLeft - off.textLeft).toBeGreaterThan(100);

    // THE BUG, captured failing. `.cm-content`'s own left - what every call
    // site in InkOverlay.ts read before this change - stays put while the
    // text it is supposed to describe moves out from under it.
    expect(Math.abs(on.contentLeft - off.contentLeft)).toBeLessThan(0.5);
  });

  it("GREEN: contentOriginLeft tracks the column in both states", async () => {
    const page = await openColumnPage(browser, MINIMAL_CSS);
    const off = await readColumn(page, false, 1400);
    const on = await readColumn(page, true, 1400);
    await page.close();

    expect(off.originLeft).toBeCloseTo(off.textLeft, 1);
    expect(on.originLeft).toBeCloseTo(on.textLeft, 1);
    // And it is the ON case that matters: origin moved with the column even
    // though .cm-content (asserted above) did not.
    expect(on.originLeft - off.originLeft).toBeGreaterThan(100);
  });

  it("a wider block (a table line) starts left of the column and is ignored", async () => {
    const page = await openColumnPage(browser, MINIMAL_CSS);
    const on = await readColumn(page, true, 1400);
    await page.close();

    // Precondition: Minimal really did widen the table line past the column.
    expect(on.wideLeft).toBeLessThan(on.textLeft - 1);
    // The maximum-over-candidates rule is what keeps it from winning.
    expect(on.originLeft).toBeCloseTo(on.textLeft, 1);
  });

  it("the collapsed block marker (zero-size) cannot drag the origin to a point", async () => {
    const page = await openColumnPage(browser, MINIMAL_CSS);
    const on = await readColumn(page, true, 1400);
    await page.close();

    // Precondition: the marker really did collapse to nothing.
    expect(on.markerWidth).toBe(0);
    expect(on.markerHeight).toBe(0);
    expect(on.originLeft).toBeCloseTo(on.textLeft, 1);
  });
});

describe("stock Obsidian: the two readings are the same number, to the pixel", () => {
  it("contentOriginLeft equals .cm-content's own left in both readable states", async () => {
    const page = await openColumnPage(browser, STOCK_CSS);
    const off = await readColumn(page, false, 1400);
    const on = await readColumn(page, true, 1400);
    await page.close();

    // Precondition: stock geometry moves .cm-content itself (unlike Minimal).
    expect(Math.abs(on.contentLeft - off.contentLeft)).toBeGreaterThan(100);

    // The equality that keeps every already-persisted stroke meaning what it
    // meant: nothing changes for a theme the old code already handled.
    expect(off.originLeft).toBeCloseTo(off.contentLeft, 1);
    expect(on.originLeft).toBeCloseTo(on.contentLeft, 1);
  });
});
