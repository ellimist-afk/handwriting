/**
 * Does the overlay's CAMERA hold under the Minimal theme, and by how much
 * does old ink move once 1.4.9's origin fix is in?
 *
 * Two questions, both measured rather than argued:
 *
 * (1) SCALE. `syncCamera` derives one number, `cssScale = rect.width /
 *     offsetWidth` on the overlay container, and the paint law is
 *
 *         painted_visual_x = contentOriginLeft + cssScale * fontZoom * note_x
 *
 *     which is only true if the overlay container and the text column live
 *     under the SAME visual/layout ratio. A `transform`, `zoom`, `scale` or
 *     `contain` on an ancestor of one and not the other breaks it silently -
 *     ink drifts proportionally to its distance from the column's left edge,
 *     which is exactly what "the ink is still broken with Minimal" looks
 *     like. This file loads Minimal 9.0.2's WHOLE stylesheet, walks every
 *     ancestor of the overlay reading those four properties, and then paints
 *     a marker through the real chain and compares with where the marker
 *     actually is, after each perturbation, at four device pixel ratios and
 *     three editor font sizes.
 *
 * (2) THE ONE-TIME SHIFT. Before 1.4.9 the overlay's origin was
 *     `.cm-content`'s own left. Under Minimal that is the pane's left edge,
 *     not the column's, so ink persisted before 1.4.9 was stored against an
 *     origin `M = contentOriginLeft - .cm-content.left` to the LEFT of the
 *     one it is now painted against, and it therefore sits M px to the RIGHT
 *     of the word it was drawn over. `M` is a pure function of the pane
 *     width under Minimal's defaults, and the table below is so a screenshot
 *     can be read against it: a reporter whose ink is displaced by exactly
 *     M(their pane) has pre-1.4.9 ink and no bug, and one whose displacement
 *     is anything else has something this branch has not found.
 *
 * SOURCE OF THE MINIMAL RULES. Unlike `ContentOriginColumn.test.ts`, which
 * hand-copies a handful of cited declarations, this file injects the
 * stylesheet WHOLE - every declaration verbatim, only the line endings left
 * to git's checkout, which CSS does not read - from
 * `test/render/fixtures/minimal-9.0.2-theme.css` - a verbatim copy of
 * `.obsidian/themes/Minimal/theme.css` (Minimal 9.0.2, MIT, (c) Steph Ango;
 * the licence header is preserved at the top of the fixture, and
 * `minimal-9.0.2-manifest.json` beside it pins the version). Vendored rather
 * than read from a vault path because a test that reads a path under
 * `C:\Users\alanl` measures this machine and finds nothing on CI. The point
 * of loading it whole is that the question is "does ANY rule in this theme
 * scale an ancestor", and a hand-picked subset cannot answer a question
 * about rules nobody thought to pick.
 *
 * WHAT IS INJECTED, and therefore a parameter rather than a measurement:
 * every value Obsidian's own `app.css` would supply. There is no `app.css`
 * on disk in this repo. They are collected in `APP_CSS` below with the
 * evidence for each, and - because an injected value that is wrong would
 * quietly invent a geometry - the first describe block asserts the
 * PRECONDITIONS the rest of the file depends on: that `.cm-content` really
 * is full-width, that the column really is `--line-width` wide, and that
 * `contentOriginLeft` really lands on it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { AncestorNote, Capture, LawProbe, ResyncMode, SyncState } from "./cameraPage";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/** Minimal 9.0.2's theme.css, verbatim, injected whole. */
const MINIMAL_CSS = readFileSync(here("./fixtures/minimal-9.0.2-theme.css"), "utf8");

/**
 * EVERY value Obsidian would have supplied. Each is a parameter of the
 * measurement, grouped by whether it can move a number.
 *
 * LOAD-BEARING, with its evidence:
 *
 * - `html { font-size: 16px }`. Minimal's `--line-width: 40rem`
 *   (theme.css:53) is a ROOT-relative length, so the column's width is a
 *   function of this and NOT of the editor font size. 16px is the engine
 *   default that Obsidian does not override; the sweep varies it explicitly
 *   rather than relying on it.
 * - `--font-text-size`. Obsidian's "Font size" setting. Minimal reads it as
 *   `--font-adaptive-normal: var(--font-text-size, var(--editor-font-size))`
 *   (theme.css:579) and applies that to the editor (theme.css:1780).
 * - the `--size-4-*` scale. Obsidian's 4px spacing ladder, referenced by
 *   Minimal's `--file-margins` (theme.css:1215, 1885-1901). Only the
 *   readable-line-width value matters here and Minimal sets that one to
 *   `1rem 0 0 0` itself (theme.css:1876), i.e. zero horizontally.
 * - the CodeMirror 6 base theme boxes and Obsidian's `--file-margins`
 *   padding on `.cm-scroller`. The padding's LOCATION is the one guess in
 *   this file, and it is a safe one: Minimal zeroes
 *   `padding-inline-start/end` on `.cm-scroller` specifically
 *   (theme.css:637-640), which is only meaningful if the app puts padding
 *   there - and under readable line width `--file-margins` is horizontally
 *   zero either way, so no displacement in this file depends on the guess.
 * - `box-sizing: border-box`. Obsidian's app-wide reset. Without it every
 *   border-box conclusion here is void.
 *
 * COSMETIC: colours, so the page is a render rather than a pile of invalid
 * declarations. None can move a geometry.
 */
const APP_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html { font-size: 16px; }
body {
  margin: 0;
  /* Obsidian's "Font size" setting reaches the editor by inheritance from
     the body. Minimal restates the same rule through its own
     --font-adaptive-normal (theme.css:579, 1778-1784); without this the
     STOCK arm of every font comparison would silently hold the font at
     16px and compare a zoom against no zoom. */
  font-size: var(--font-text-size);
  --font-text-size: 16px;
  --editor-font-size: 16px;
  --font-text: sans-serif;
  --font-interface: sans-serif;
  --font-monospace: monospace;
  --size-4-1: 4px;  --size-4-2: 8px;  --size-4-3: 12px; --size-4-4: 16px;
  --size-4-5: 20px; --size-4-6: 24px; --size-4-8: 32px; --size-4-9: 36px;
  --size-4-12: 48px; --size-4-18: 72px;
  --size-2-1: 2px; --size-2-2: 4px; --size-2-3: 6px;
  --file-line-width: 700px;
  --file-margins: var(--size-4-8);
  --p-spacing: 1rem;
  --background-primary: #ffffff;
  --background-secondary: #f2f3f5;
  --background-modifier-border: #dcddde;
  --text-normal: #1f1f1f;
  --text-muted: #6a6a6a;
  --text-faint: #999999;
  --text-accent: #705dcf;
  --interactive-accent: #7b6cd9;
  --text-selection: rgba(0,0,0,0.1);
  --border-width: 1px;
  --gutter-background: transparent;
}

/* The workspace chain: flex columns, which is what makes the leaf's width
   the editor's width. */
.app-container, .horizontal-main-container, .workspace, .workspace-split,
.workspace-tabs, .workspace-tab-container, .workspace-leaf {
  display: flex; flex-direction: column; min-width: 0;
}
.workspace-leaf-content { display: flex; flex-direction: column; }
.view-content { display: flex; flex-direction: column; flex-grow: 1; min-height: 0; }
.markdown-source-view { flex-grow: 1; min-height: 0; }
/* CodeMirror gives .cm-content flex-grow 2 so it fills the scroller.
   Obsidian wraps the content in .cm-sizer > .cm-contentContainer, which
   moves that job onto the sizer - without it the sizer shrink-to-fits and
   "margin: 0 auto" has nothing to centre in. Cited from the shape of
   Minimal's own override (theme.css:1853): it forces .cm-sizer to
   width 100% under readable line width, which is only a change if the
   sizer is otherwise being stretched by the flex line. */
.markdown-source-view.mod-cm6 .cm-sizer { flex-grow: 1; }

/* CodeMirror 6's own base theme (@codemirror/view), the boxes Obsidian
   inherits and Minimal restyles. */
.cm-editor { display: flex; flex-direction: column; height: 100%; position: relative; }
.cm-scroller {
  display: flex; align-items: flex-start; flex-grow: 1;
  overflow-x: auto; overflow-y: auto; position: relative;
  line-height: 1.5;
}
.cm-sizer { position: relative; }
.cm-content {
  display: block; margin: 0; padding: 4px 0; outline: none;
  min-height: 100%; white-space: pre;
}
.cm-lineWrapping { white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
.cm-line { display: block; padding: 0 2px 0 6px; }

/* Obsidian's markdown editor rules. */
.markdown-source-view.mod-cm6 .cm-scroller { padding: var(--file-margins); }
.markdown-source-view.mod-cm6 .cm-content { padding: 0; }
`;

/**
 * Stock Obsidian's readable-line-width rule, the control. Written down from
 * the citation already in this codebase (`InkOverlay.ts:1836`,
 * `PaneWidthGeometry.test.ts:640`): `.cm-content` ITSELF narrows and centres,
 * which is why the pre-1.4.9 origin was right under this theme and only this
 * theme.
 */
const STOCK_CSS = `
.markdown-source-view.mod-cm6.is-readable-line-width .cm-content {
  max-width: var(--file-line-width);
  margin: 0 auto;
}
`;

let bundled: string | null = null;

/** Bundles `cameraPage.ts`, which imports the real camera code from `src/`. */
async function pageBundle(): Promise<string> {
	if (bundled) return bundled;
	const out = await build({
		entryPoints: [here("./cameraPage.ts")],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		target: "es2022",
	});
	const file = out.outputFiles[0];
	if (!file) throw new Error("esbuild produced no output for cameraPage.ts");
	bundled = file.text;
	return bundled;
}

type Theme = "minimal" | "stock";

interface OpenOptions {
	theme: Theme;
	paneWidth: number;
	/** Obsidian's editor font size setting, in px. */
	fontPx?: number;
	/** The root font size `--line-width: 40rem` is built on. */
	rootFontPx?: number;
	readable?: boolean;
	/**
	 * Overrides `.cm-line`'s `padding-left`. CodeMirror's base theme sets
	 * `0 2px 0 6px` and whether Obsidian zeroes it is not knowable from this
	 * repo - so the one conclusion that depends on it is measured at two
	 * values instead of resting on a guess.
	 */
	linePaddingPx?: number;
}

async function openCameraPage(ctx: BrowserContext, opts: OpenOptions): Promise<Page> {
	const page = await ctx.newPage();
	await page.setContent("<!doctype html><meta charset=utf-8><title>camera scale</title>");
	await page.addStyleTag({ content: APP_CSS });
	await page.addStyleTag({ content: opts.theme === "minimal" ? MINIMAL_CSS : STOCK_CSS });
	if (opts.linePaddingPx !== undefined) {
		await page.addStyleTag({
			content: `.cm-line { padding-left: ${opts.linePaddingPx}px; padding-right: ${opts.linePaddingPx}px; }`,
		});
	}
	await page.addScriptTag({ content: await pageBundle() });
	await page.evaluate((o) => {
		window.__hwcam.build();
		if (o.rootFontPx !== undefined) window.__hwcam.setRootFontPx(o.rootFontPx);
		if (o.fontPx !== undefined) window.__hwcam.setEditorFontPx(o.fontPx);
		window.__hwcam.setPaneWidth(o.paneWidth);
		window.__hwcam.setReadable(o.readable ?? true);
		window.__hwcam.syncBand();
	}, {
		paneWidth: opts.paneWidth,
		fontPx: opts.fontPx,
		rootFontPx: opts.rootFontPx,
		readable: opts.readable,
	});
	return page;
}

const capture = (page: Page): Promise<Capture> => page.evaluate(() => window.__hwcam.capture());

const probe = (page: Page, cap: Capture, mode: ResyncMode): Promise<LawProbe> =>
	page.evaluate((a) => window.__hwcam.probe(a.cap, a.mode), { cap, mode });

const sync = (page: Page): Promise<SyncState> => page.evaluate(() => window.__hwcam.sync());

const ancestors = (page: Page): Promise<AncestorNote[]> =>
	page.evaluate(() => window.__hwcam.ancestorTransforms());

const displacement = (page: Page): Promise<ReturnType<Window["__hwcam"]["displacement"]>> =>
	page.evaluate(() => window.__hwcam.displacement());

const round = (n: number, dp = 4): number => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * The GEOMETRY perturbations: the column moves, the font does not. Each is
 * applied AFTER a capture and before the probe, and each is a thing a user
 * does with a mouse in a couple of seconds. A font-size change is handled
 * separately, because it is not a rigid motion of the column and the law's
 * behaviour under it has its own closed form.
 */
const PERTURBATIONS = {
	"readable off": (page: Page) => page.evaluate(() => window.__hwcam.setReadable(false)),
	"readable off+on": (page: Page) =>
		page.evaluate(() => {
			window.__hwcam.setReadable(false);
			window.__hwcam.setReadable(true);
		}),
	"pane narrowed 1400->900": (page: Page) =>
		page.evaluate(() => window.__hwcam.setPaneWidth(900)),
	"pane widened 1400->1700": (page: Page) =>
		page.evaluate(() => window.__hwcam.setPaneWidth(1700)),
	"pane narrowed to 700 (88% binds)": (page: Page) =>
		page.evaluate(() => window.__hwcam.setPaneWidth(700)),
} as const;

let browser: Browser;
beforeAll(async () => {
	browser = await chromium.launch();
});
afterAll(async () => {
	await browser?.close();
});

/** The device pixel ratios the sweep runs at. */
const DEVICE_SCALES = [1, 1.25, 1.5, 2] as const;
/** The editor font sizes the sweep runs at. */
const FONT_SIZES = [14, 16, 20] as const;

/**
 * A pixel of slack. Every number in this file is a layout computation, not a
 * glyph measurement, so the expected residual is float noise; a whole tenth
 * of a pixel is orders of magnitude above that and still far below anything
 * a person could see.
 */
const SUBPIXEL = 0.1;

describe("fixture preconditions: this really is Minimal's geometry", () => {
	it("`.cm-content` is full width and the column is the line, centred inside it", async () => {
		const ctx = await browser.newContext({ viewport: { width: 1800, height: 1000 } });
		const page = await openCameraPage(ctx, { theme: "minimal", paneWidth: 1400 });
		const s = await sync(page);
		const d = await displacement(page);
		await ctx.close();

		// eslint-disable-next-line no-console
		console.log("Minimal precondition:", JSON.stringify({ ...s, M: round(d.M) }));

		// `.cm-content` spans the whole pane: Minimal forces width 100%.
		expect(s.contentWidth).toBeCloseTo(1400, 1);
		// The column is --line-width: 40rem = 640px at a 16px root, since
		// --max-width: 88% of 1400 = 1232 does not bind.
		expect(s.lineWidth).toBeCloseTo(640, 1);
		// Centred: the line sits (1400-640)/2 = 380px in from .cm-content.
		expect(s.lineLeft - s.contentLeft).toBeCloseTo(380, 1);
		// And the origin under test lands on the column, not on .cm-content.
		expect(s.origin).toBeCloseTo(s.lineLeft, 1);
	});

	it("stock Obsidian narrows `.cm-content` itself, so the shift is zero there", async () => {
		const ctx = await browser.newContext({ viewport: { width: 1800, height: 1000 } });
		const page = await openCameraPage(ctx, { theme: "stock", paneWidth: 1400 });
		const d = await displacement(page);
		await ctx.close();

		expect(d.contentWidth).toBeCloseTo(700, 1);
		expect(round(d.M, 2)).toBe(0);
	});
});

describe("Q1: nothing in Minimal puts a scale between the overlay and the column", () => {
	it("no ancestor of the overlay carries a transform, zoom, scale or contain", async () => {
		const ctx = await browser.newContext({ viewport: { width: 1800, height: 1000 } });
		const page = await openCameraPage(ctx, { theme: "minimal", paneWidth: 1400 });
		const notes = await ancestors(page);
		await ctx.close();

		// eslint-disable-next-line no-console
		console.log(
			"ancestor sweep (overlay -> html):\n" +
				notes
					.map(
						(n) =>
							`  ${n.tag}.${n.cls}  transform=${n.transform} zoom=${n.zoom} ` +
							`scale=${n.scale} contain=${n.contain} ratio=${n.ratio === null ? "n/a" : round(n.ratio, 6)}`
					)
					.join("\n")
		);

		// The chain from the overlay to <html> is the whole cascade the
		// camera's cssScale has to survive. Nothing may scale it.
		for (const n of notes) {
			expect(n.transform, `${n.tag}.${n.cls} transform`).toBe("none");
			expect(n.zoom, `${n.tag}.${n.cls} zoom`).toBe("1");
			expect(n.scale, `${n.tag}.${n.cls} scale`).toBe("none");
			expect(n.contain, `${n.tag}.${n.cls} contain`).toBe("none");
		}
	});

	for (const dsf of DEVICE_SCALES) {
		for (const fontPx of FONT_SIZES) {
			it(`cssScale is 1 and matches the column's own ratio at dpr ${dsf}, font ${fontPx}px`, async () => {
				const ctx = await browser.newContext({
					viewport: { width: 1800, height: 1000 },
					deviceScaleFactor: dsf,
				});
				const page = await openCameraPage(ctx, {
					theme: "minimal",
					paneWidth: 1400,
					fontPx,
				});
				const dpr = await page.evaluate(() => window.devicePixelRatio);
				const s = await sync(page);
				await ctx.close();

				// Precondition: the context really is at that ratio, or the
				// row below is a measurement of dpr 1 wearing a label.
				expect(dpr).toBeCloseTo(dsf, 6);

				// eslint-disable-next-line no-console
				console.log(
					`dpr ${dsf} font ${fontPx}: cssScale=${round(s.cssScale, 8)} ` +
						`overlay ${round(s.overlayVisualWidth, 4)}/${s.overlayLayoutWidth} ` +
						`line ${round(s.lineWidth, 4)}/${s.lineLayoutWidth} ` +
						`fontPx=${s.fontPx} origin=${round(s.origin, 3)}`
				);

				// The device pixel ratio is not a CSS-px scale: rects and
				// offsetWidth are both CSS px, so this quotient stays 1.
				expect(s.cssScale).toBeCloseTo(1, 6);
				// And the column scales the same way the overlay does - the
				// disagreement the paint law would not survive.
				expect(s.lineWidth / s.lineLayoutWidth).toBeCloseTo(s.cssScale, 3);
				// The editor font size reached the content, so the font rows
				// are not three copies of one measurement.
				expect(s.fontPx).toBeCloseTo(fontPx, 3);
			});
		}
	}
});

describe("Q1: the paint law puts ink back on its word after every perturbation", () => {
	for (const dsf of DEVICE_SCALES) {
		for (const fontPx of FONT_SIZES) {
			it(`law holds through all perturbations at dpr ${dsf}, font ${fontPx}px`, async () => {
				const ctx = await browser.newContext({
					viewport: { width: 1800, height: 1000 },
					deviceScaleFactor: dsf,
				});
				const rows: string[] = [];
				for (const [name, apply] of Object.entries(PERTURBATIONS)) {
					const page = await openCameraPage(ctx, {
						theme: "minimal",
						paneWidth: 1400,
						fontPx,
					});
					const cap = await capture(page);
					await apply(page);
					const after = await probe(page, cap, "full");
					await page.close();
					rows.push(
						`  ${name.padEnd(24)} err=${round(after.error, 4)
							.toString()
							.padStart(9)}  origin ${round(after.before.origin, 2)} -> ${round(after.after.origin, 2)}` +
							`  scale ${round(after.before.scale, 4)} -> ${round(after.after.scale, 4)}`
					);
					expect(
						Math.abs(after.error),
						`dpr ${dsf} font ${fontPx}: ${name}`
					).toBeLessThan(SUBPIXEL);
				}
				await ctx.close();
				// eslint-disable-next-line no-console
				console.log(`law, dpr ${dsf} font ${fontPx}px:\n${rows.join("\n")}`);
			});
		}
	}

	it("the law is not vacuous: without a re-sync the same perturbations displace ink", async () => {
		const ctx = await browser.newContext({ viewport: { width: 1800, height: 1000 } });
		const rows: string[] = [];
		let worst = 0;
		for (const [name, apply] of Object.entries(PERTURBATIONS)) {
			const page = await openCameraPage(ctx, { theme: "minimal", paneWidth: 1400 });
			const cap = await capture(page);
			await apply(page);
			const stale = await probe(page, cap, "none");
			await page.close();
			rows.push(`  ${name.padEnd(24)} stale err=${round(stale.error, 3)}`);
			worst = Math.max(worst, Math.abs(stale.error));
		}
		await ctx.close();
		// eslint-disable-next-line no-console
		console.log(`stale camera (no re-sync), dpr 1 font 16px:\n${rows.join("\n")}`);

		// If a perturbation moved nothing at all, the row above proves
		// nothing about the law - it would pass on a page that never
		// changed. At least one of them must be visibly wrong when the
		// camera is not re-synced.
		expect(worst).toBeGreaterThan(10);
	});

	it("stock Obsidian: the same perturbations, the same exactness", async () => {
		const ctx = await browser.newContext({ viewport: { width: 1800, height: 1000 } });
		const rows: string[] = [];
		for (const [name, apply] of Object.entries(PERTURBATIONS)) {
			const page = await openCameraPage(ctx, { theme: "stock", paneWidth: 1400 });
			const cap = await capture(page);
			await apply(page);
			const after = await probe(page, cap, "full");
			await page.close();
			rows.push(`  ${name.padEnd(32)} err=${round(after.error, 4)}`);
			expect(Math.abs(after.error), `stock: ${name}`).toBeLessThan(SUBPIXEL);
		}
		await ctx.close();
		// eslint-disable-next-line no-console
		console.log(`law under stock Obsidian, dpr 1 font 16px:\n${rows.join("\n")}`);
	});
});

describe("Q1: a font-size change is a reflow, and the camera models it as a zoom", () => {
	/**
	 * The one place the law is NOT exact, its closed form, and its size.
	 *
	 * `syncCamera` folds the editor's font ratio into the camera as a real
	 * zoom (`InkOverlay.ts:1841-1842`, `2033-2038`), i.e. it assumes a
	 * font-size change is a similarity transform about the column's left
	 * edge. That is exactly true for every length the layout expresses in
	 * `em` - which is what a glyph advance is - and exactly false for every
	 * length it expresses in `px`. The residual is therefore
	 *
	 *     error = fixedPxInset * (fontZoom - 1)
	 *
	 * where `fixedPxInset` is whatever un-scaled px sits between the column's
	 * left edge and the ink. In CodeMirror's default line box that is
	 * `padding-left: 6px`, so one zoom step (16 -> 20px) moves ink 1.5px.
	 *
	 * Measured at two `.cm-line` paddings, because whether Obsidian keeps
	 * CodeMirror's 6px is not knowable from this repo and the conclusion must
	 * not rest on the guess: at 0px the law is exact, at 24px the residual is
	 * four times the 6px one. And measured under BOTH themes, because the
	 * whole question in front of this branch is what Minimal does that stock
	 * does not - and the answer here is nothing.
	 */
	for (const pad of [0, 6, 24]) {
		it(`residual is padding*(fontZoom-1) with a ${pad}px line inset, both themes`, async () => {
			const ctx = await browser.newContext({ viewport: { width: 1800, height: 1000 } });
			const rows: string[] = [];
			for (const theme of ["minimal", "stock"] as const) {
				for (const to of [20, 13]) {
					const page = await openCameraPage(ctx, {
						theme,
						paneWidth: 1400,
						fontPx: 16,
						linePaddingPx: pad,
					});
					const cap = await capture(page);
					await page.evaluate((px) => window.__hwcam.setEditorFontPx(px), to);
					const after = await probe(page, cap, "full");
					await page.close();

					// The fixture really applied the padding under test.
					expect(after.before.linePaddingLeft).toBeCloseTo(pad, 3);
					// And the font really changed. Without this the whole
					// closed form collapses to 0 == 0 the moment a theme arm
					// fails to receive the setting, which is exactly how the
					// stock arm passed vacuously on the first cut.
					expect(after.after.fontPx).toBeCloseTo(to, 3);
					expect(after.after.fontZoom).toBeCloseTo(to / 16, 4);
					const predicted = pad * (after.after.fontZoom - 1);
					rows.push(
						`  ${theme.padEnd(8)} 16->${to}px  fontZoom=${round(after.after.fontZoom, 4)}` +
							`  err=${round(after.error, 4)}  closed form=${round(predicted, 4)}`
					);
					// The closed form, to a thousandth of a pixel. Not a
					// bound: the exact number.
					expect(after.error, `${theme} 16->${to} pad ${pad}`).toBeCloseTo(predicted, 3);
				}
			}
			await ctx.close();
			// eslint-disable-next-line no-console
			console.log(`font-zoom residual, ${pad}px line inset:\n${rows.join("\n")}`);
		});
	}

	it("the residual is theme-independent: Minimal and stock give the same number", async () => {
		const ctx = await browser.newContext({ viewport: { width: 1800, height: 1000 } });
		const errs: number[] = [];
		for (const theme of ["minimal", "stock"] as const) {
			const page = await openCameraPage(ctx, {
				theme,
				paneWidth: 1400,
				fontPx: 16,
				linePaddingPx: 6,
			});
			const cap = await capture(page);
			await page.evaluate(() => window.__hwcam.setEditorFontPx(20));
			const after = await probe(page, cap, "full");
			await page.close();
			errs.push(after.error);
		}
		await ctx.close();
		const [minimal, stock] = errs;
		if (minimal === undefined || stock === undefined) throw new Error("row missing");
		// eslint-disable-next-line no-console
		console.log(`font 16->20, 6px inset: minimal ${round(minimal, 4)}px, stock ${round(stock, 4)}px`);
		// The decisive control for "the ink is still broken with Minimal":
		// this residual is not something Minimal does.
		expect(minimal).toBeCloseTo(stock, 6);
	});
});

describe("Q1: `syncCamera` alone re-measures cssScale but not the font zoom", () => {
	/**
	 * CONFIRMED DEFECT, not fixed on this branch, so it is declared as an
	 * expected failure per the repo's `it.fails` convention (see
	 * `src/persistence/PageStoreTwoDocuments.test.ts` for where that idiom
	 * was chosen and why).
	 *
	 * `InkOverlay.mount` wires TWO observers:
	 *   - `ResizeObserver(view.dom)` -> `handleResize`, which is the ONLY
	 *     place `this.fontZoom` is recomputed (InkOverlay.ts:1835-1842);
	 *   - `ResizeObserver(view.contentDOM)` -> `syncCamera` + repaint, which
	 *     re-measures `cssScale` from a fresh rect (InkOverlay.ts:1999-2016)
	 *     and reuses whatever `fontZoom` was last cached.
	 *
	 * An editor font-size change resizes `.cm-content` (its lines get taller)
	 * without resizing `.cm-editor` (the pane is unchanged), so the second
	 * observer fires and the first does not. The camera is then rebuilt with
	 * a scale that is short by the whole font ratio, and every stroke paints
	 * displaced by `(1 - ratio) * distance-from-the-column`.
	 *
	 * There is a repair: the `ViewUpdate` handler compares
	 * `contentStyle.fontSize` against `lastFontStr` on `geometryChanged` and
	 * calls `handleResize` (InkOverlay.ts:1622-1630). Whether that lands in
	 * the same frame as the observer, or a frame later with a wrong paint in
	 * between, is a CodeMirror scheduling question this harness cannot see -
	 * there is no CodeMirror here. What it CAN see, and what the number
	 * below is, is that the syncCamera path on its own is not self-
	 * consistent.
	 */
	it("syncCamera alone keeps ink on its word after a font-size change", async () => {
		const ctx = await browser.newContext({ viewport: { width: 1800, height: 1000 } });
		const page = await openCameraPage(ctx, {
			theme: "minimal",
			paneWidth: 1400,
			// Zero, so the only thing this test can fail on is the stale
			// zoom - not the px-inset residual characterised above.
			linePaddingPx: 0,
		});
		const cap = await capture(page);
		await page.evaluate(() => window.__hwcam.setEditorFontPx(20));
		const after = await probe(page, cap, "syncOnly");
		await ctx.close();

		expect(Math.abs(after.error)).toBeLessThan(SUBPIXEL);
	});

	it("the same change through `handleResize` + `syncCamera` is exact, and the gap is measured", async () => {
		const ctx = await browser.newContext({ viewport: { width: 1800, height: 1000 } });

		const stalePage = await openCameraPage(ctx, {
			theme: "minimal",
			paneWidth: 1400,
			linePaddingPx: 0,
		});
		const staleCap = await capture(stalePage);
		await stalePage.evaluate(() => window.__hwcam.setEditorFontPx(20));
		const stale = await probe(stalePage, staleCap, "syncOnly");
		await stalePage.close();

		const fullPage = await openCameraPage(ctx, {
			theme: "minimal",
			paneWidth: 1400,
			linePaddingPx: 0,
		});
		const fullCap = await capture(fullPage);
		await fullPage.evaluate(() => window.__hwcam.setEditorFontPx(20));
		const full = await probe(fullPage, fullCap, "full");
		await fullPage.close();
		await ctx.close();

		// eslint-disable-next-line no-console
		console.log(
			`font 16->20 at 1400px pane, 0px line inset: syncCamera-only err=${round(stale.error, 3)}px ` +
				`(scale stayed ${round(stale.after.scale, 4)}), handleResize+syncCamera err=${round(full.error, 4)}px ` +
				`(scale ${round(full.after.scale, 4)})`
		);

		// With no px inset the full path is exact, which is what made the
		// syncCamera-only number attributable to the zoom alone.
		expect(Math.abs(full.error)).toBeLessThan(SUBPIXEL);
		// AND SO IS THE OTHER ONE, since 1.4.10. This assertion read
		// `toBeGreaterThan(10)` while the defect stood: the syncCamera-only
		// path was out by a whole multiple of the font ratio - 48px at this
		// pane - rather than by a rounding wobble, which is what made it a
		// mechanism rather than a tolerance argument. `syncCamera` now
		// refreshes the font zoom itself, so the two paths reach the same
		// scale and the gap that was measured here is zero.
		expect(Math.abs(stale.error)).toBeLessThan(SUBPIXEL);
		// Both paths agree on where the column is, and now on the scale too.
		expect(stale.after.origin).toBeCloseTo(full.after.origin, 3);
		expect(stale.after.scale).toBeCloseTo(full.after.scale, 6);
	});
});

describe("Q2: the one-time shift table for pre-1.4.9 ink under Minimal", () => {
	const PANE_WIDTHS = [800, 1000, 1200, 1400, 1600] as const;

	it("M = contentOriginLeft - .cm-content.left, by pane width", async () => {
		const ctx = await browser.newContext({ viewport: { width: 2000, height: 1000 } });
		const rows: { pane: number; contentWidth: number; colWidth: number; M: number }[] = [];
		for (const pane of PANE_WIDTHS) {
			const page = await openCameraPage(ctx, { theme: "minimal", paneWidth: pane });
			const d = await displacement(page);
			await page.close();
			rows.push({
				pane,
				contentWidth: round(d.contentWidth, 2),
				colWidth: round(d.lineWidth, 2),
				M: round(d.M, 2),
			});
		}
		await ctx.close();

		// eslint-disable-next-line no-console
		console.log(
			"one-time shift under Minimal 9.0.2 defaults (root 16px, --line-width 40rem):\n" +
				"  pane   .cm-content   column    M (px, ink sits this far RIGHT of its word)\n" +
				rows
					.map(
						(r) =>
							`  ${String(r.pane).padStart(4)}   ${String(r.contentWidth).padStart(9)}   ` +
							`${String(r.colWidth).padStart(6)}   ${String(r.M).padStart(6)}`
					)
					.join("\n")
		);

		// The pane width really did reach `.cm-content` - no scrollbar ate
		// part of it - so M is a function of the number in the first column.
		for (const r of rows) expect(r.contentWidth).toBeCloseTo(r.pane, 1);

		// Every pane here is wide enough that `--line-width: 40rem` wins over
		// `--max-width: 88%` (88% of 800 = 704 > 640), so the column is a
		// constant and M is exactly half the leftover.
		for (const r of rows) {
			expect(r.colWidth).toBeCloseTo(640, 1);
			expect(r.M).toBeCloseTo((r.pane - 640) / 2, 1);
			// The general law behind the five numbers, so a reader whose
			// `--line-width` is not the default (Minimal Theme Settings
			// changes it) can still use the table: M is half the leftover,
			// whatever the column happens to be.
			expect(r.M).toBeCloseTo((r.contentWidth - r.colWidth) / 2, 1);
		}
		// Monotone in pane width, which is the property that makes the table
		// readable off a screenshot at a width that is not in it.
		for (let i = 1; i < rows.length; i++) {
			const prev = rows[i - 1];
			const cur = rows[i];
			if (!prev || !cur) throw new Error("row missing");
			expect(cur.M).toBeGreaterThan(prev.M);
		}
	});

	it("with Readable line length OFF there is no shift at all", async () => {
		const ctx = await browser.newContext({ viewport: { width: 1800, height: 1000 } });
		const page = await openCameraPage(ctx, {
			theme: "minimal",
			paneWidth: 1400,
			readable: false,
		});
		const d = await displacement(page);
		await ctx.close();

		// eslint-disable-next-line no-console
		console.log(`readable OFF at 1400px: column ${round(d.lineWidth, 2)}  M ${round(d.M, 2)}`);

		// Minimal's centring rule is scoped to `.is-readable-line-width`, so
		// with the setting off the line fills `.cm-content` and the old and
		// new origins are the same number. A reporter who has the setting
		// off and still sees displaced ink has something else.
		expect(round(d.M, 2)).toBe(0);
	});

	it("below 727px of pane, `--max-width: 88%` binds and M becomes 6% of the pane", async () => {
		const ctx = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
		const rows: string[] = [];
		for (const pane of [500, 600, 700]) {
			const page = await openCameraPage(ctx, { theme: "minimal", paneWidth: pane });
			const d = await displacement(page);
			await page.close();
			rows.push(`  pane ${pane}: column ${round(d.lineWidth, 2)}  M ${round(d.M, 2)}`);
			// 88% of the pane, so the leftover is 12% and M is half of it.
			expect(d.lineWidth).toBeCloseTo(pane * 0.88, 1);
			expect(d.M).toBeCloseTo(pane * 0.06, 1);
		}
		await ctx.close();
		// eslint-disable-next-line no-console
		console.log(`narrow panes (88% binds):\n${rows.join("\n")}`);
	});

	it("the editor font size does not move M; the ROOT font size does", async () => {
		const ctx = await browser.newContext({ viewport: { width: 1800, height: 1000 } });
		const rows: string[] = [];

		// Minimal's column is `--line-width: 40rem`, a ROOT-relative length,
		// so Obsidian's editor font size setting cannot move it - which is
		// why one number per pane width is a complete table.
		for (const fontPx of FONT_SIZES) {
			const page = await openCameraPage(ctx, {
				theme: "minimal",
				paneWidth: 1400,
				fontPx,
			});
			const d = await displacement(page);
			await page.close();
			rows.push(`  editor font ${fontPx}px: column ${round(d.lineWidth, 2)}  M ${round(d.M, 2)}`);
			expect(d.M).toBeCloseTo(380, 1);
		}

		// The root font size is the one thing that does move it, and it is
		// what Obsidian's Ctrl+/Ctrl- zoom and the OS text scale both change.
		for (const rootPx of [12, 16, 20]) {
			const page = await openCameraPage(ctx, {
				theme: "minimal",
				paneWidth: 1400,
				rootFontPx: rootPx,
			});
			const d = await displacement(page);
			await page.close();
			rows.push(`  root font ${rootPx}px: column ${round(d.lineWidth, 2)}  M ${round(d.M, 2)}`);
			expect(d.lineWidth).toBeCloseTo(40 * rootPx, 1);
			expect(d.M).toBeCloseTo((1400 - 40 * rootPx) / 2, 1);
		}
		await ctx.close();
		// eslint-disable-next-line no-console
		console.log(`M against font sizes, 1400px pane:\n${rows.join("\n")}`);
	});
});
