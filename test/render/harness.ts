/**
 * A rendered-geometry harness: measure what the engine actually paints, from
 * the plugin's OWN stylesheet.
 *
 * Every CSS assertion in this repo before this file was a text match against
 * `styles.css`. A text match cannot see a declaration the engine ignores, and
 * two real defects survived a green suite because of it: a `min-width: 5ch`
 * floor that sits below the chip's natural border-box width and never binds,
 * and `font-variant-numeric: tabular-nums` under Georgia, which has old-style
 * figures and no `tnum` feature, so the digits stay genuinely unequal.
 *
 * WHAT THIS CAN ANSWER
 *   - the rendered border-box width of a real element built by real plugin
 *     code, under the real `styles.css`, for every label a slider produces
 *   - whether a candidate `min-width` changes that width at all - i.e.
 *     whether a proposed floor binds or is a no-op
 *   - whether a font substitution changes the answer, which is the only way
 *     to see `tabular-nums` being ignored
 *   - what a declaration RESOLVED to (`getComputedStyle`), not what it said
 *
 * WHAT THIS CANNOT ANSWER
 *   - anything about Obsidian. There is no Obsidian here. The theme
 *     variables below are INJECTED by this file, and an injected value is a
 *     parameter, not a measurement: a real theme sets different ones, and a
 *     `--font-monospace` that resolves to a proportional face would break the
 *     chip on hardware while this harness stayed green.
 *   - anything about the fonts on a user's machine. Chromium here resolves
 *     `monospace` and `Georgia` against THIS machine's font list. A machine
 *     without Georgia measures a substitute, which is why the serif case
 *     carries a control span and fails loudly instead of passing quietly.
 *   - anything about iOS or Android. This is desktop Chromium; Playwright's
 *     WebKit is a patched build and its font stack is not iOS Safari's.
 *   - whether the pop MOVES. It measures the chip, which is the pop's widest
 *     child and therefore the cause; `hangUnder`'s re-centring is not
 *     exercised.
 *   - anything about a real device's pixel ratio, zoom, or accessibility text
 *     scaling.
 *   - correctness of anything the fake host stands in for.
 */

import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import type { FloorProbe, Sweep } from "./stripPage";
import rawStyles from "../../styles.css?raw";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/**
 * The stylesheet is read from disk, verbatim, and injected whole. This is the
 * non-negotiable property of the whole facility: a harness built from a
 * hand-written copy of the rules measures the copy.
 */
export const stylesCss = (): string => rawStyles;

/**
 * EVERY value this harness supplies that Obsidian would have supplied.
 *
 * Each one is a parameter of the measurement, not part of it. They are
 * grouped by whether they can move a number, because that is the only
 * distinction that matters when reading a result.
 */
export const INJECTED = {
	/**
	 * Load-bearing: change one of these and the measured width changes.
	 *
	 * `--font-monospace` is what `.handwriting-slider-val` pins its family to.
	 * Left unset, the `var()` is invalid at computed-value time, `font-family`
	 * falls back to the inherited face, and the harness would silently be
	 * measuring the very defect it exists to catch. `monospace` is the CSS
	 * generic - the value a theme that overrides nothing falls through to -
	 * NOT Obsidian's own default stack, which this worktree has no copy of.
	 *
	 * `--background-modifier-border` is inside the chip's
	 * `border: 1px solid var(...)`. Unset, that shorthand is invalid at
	 * computed-value time and border-width reverts to `medium` - 3px a side,
	 * 4px on the border box.
	 */
	loadBearing: {
		"--font-monospace": "monospace",
		"--background-modifier-border": "#dcddde",
	},
	/**
	 * Cosmetic: referenced by the chip and its pop, cannot move a width.
	 * Injected so the page is a render rather than a pile of invalid
	 * declarations.
	 */
	cosmetic: {
		"--background-primary": "#ffffff",
		"--background-secondary": "#f2f3f5",
		"--text-normal": "#1f1f1f",
		"--text-muted": "#6a6a6a",
		"--text-on-accent": "#ffffff",
		"--interactive-accent": "#7b6cd9",
	},
} as const;

/**
 * Obsidian's app.css applies a border-box reset. `styles.css` does not set
 * box-sizing on the chip, so without this the chip renders content-box and
 * every border-box conclusion drawn here is void - which is exactly the
 * mistake that measured `min-width: 5ch` as a fix. Stated here as a
 * parameter, and asserted to have taken effect rather than assumed.
 */
export const BOX_SIZING_RESET = "*, *::before, *::after { box-sizing: border-box; }";

/** The interface font the page inherits. The chip is supposed to ignore it. */
export interface ThemeCase {
	name: string;
	/** What `body { font-family }` is set to. */
	interfaceFont: string;
	/**
	 * Which sliders' label sets this face renders at MORE than one width when
	 * nothing pins the chip's family - i.e. where an unpinned chip would
	 * judder. MEASURED on this machine, not reasoned about, and asserted both
	 * ways: a slider listed here must be uneven and one left out must be even.
	 * A missing font substitutes and moves these, which is the point - it
	 * fails loudly instead of passing for nothing.
	 */
	unevenSliders: readonly string[];
}

export const THEME_CASES: ThemeCase[] = [
	// A proportional UI face whose digits are all one advance and which
	// HONOURS tabular-nums. Nothing is uneven here even with the family pin
	// gone, so this case is coverage rather than a defect case - and saying so
	// in the list is the point: it is the serif case that bites.
	{
		name: "proportional (Arial)",
		interfaceFont: "Arial, sans-serif",
		unevenSliders: [],
	},
	// The Georgia case. Old-style figures, no `tnum` feature, so
	// `font-variant-numeric: tabular-nums` is a request the engine declines
	// and the digits are genuinely unequal - every slider is affected,
	// padded or not.
	{
		name: "serif (Georgia)",
		interfaceFont: "Georgia, serif",
		unevenSliders: ["Eraser size", "Pen size", "Highlighter size"],
	},
];

/** The three sliders, by the aria-label their own constructor gave them. */
export const SLIDERS = ["Eraser size", "Pen size", "Highlighter size"] as const;

let bundled: string | null = null;

/**
 * Bundles `stripPage.ts` - and with it the real `MobileTools` - for the page.
 * `obsidian` is aliased to the suite's existing runtime stub; the real package
 * ships types and no runtime entry, so nothing importing it can be bundled.
 */
async function pageBundle(): Promise<string> {
	if (bundled) return bundled;
	const out = await build({
		entryPoints: [here("./stripPage.ts")],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		target: "es2022",
		alias: { obsidian: here("../obsidian-stub.ts") },
	});
	const file = out.outputFiles[0];
	if (!file) throw new Error("esbuild produced no output for the page bundle");
	bundled = file.text;
	return bundled;
}

export interface Harness {
	page: Page;
	close(): Promise<void>;
	sweep(aria: string): Promise<Sweep>;
	floor(aria: string, candidate: string, boxSizing?: string): Promise<FloorProbe>;
	glyphs(samples: string[], fontVariantNumeric?: string): Promise<Record<string, number>>;
}

export interface OpenOptions {
	theme: ThemeCase;
	/** Overrides the on-disk stylesheet. Only the teeth demonstrations use it. */
	css?: string;
}

/** Opens a page holding the real strip under the real stylesheet. */
export async function openStrip(browser: Browser, opts: OpenOptions): Promise<Harness> {
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	const vars = Object.entries({ ...INJECTED.loadBearing, ...INJECTED.cosmetic })
		.map(([k, v]) => `${k}: ${v};`)
		.join("\n\t");
	await page.setContent("<!doctype html><meta charset=utf-8><title>chip geometry</title>");
	await page.addStyleTag({
		content: [
			BOX_SIZING_RESET,
			`:root {\n\t${vars}\n}`,
			// 16px is the browser default, written down rather than inherited
			// by accident. The chip sets its own 11px, so this reaches the
			// control span only.
			`body { margin: 0; font-size: 16px; font-family: ${opts.theme.interfaceFont}; }`,
		].join("\n"),
	});
	await page.addStyleTag({ content: opts.css ?? stylesCss() });
	await page.addScriptTag({ content: await pageBundle() });
	await page.evaluate(() => {
		(window as unknown as { __pane: HTMLElement }).__pane = window.__hw.buildStrip();
	});
	return {
		page,
		close: () => page.close(),
		sweep: (aria) =>
			page.evaluate(
				(a) =>
					window.__hw.sweepSlider(
						(window as unknown as { __pane: HTMLElement }).__pane,
						a
					),
				aria
			),
		floor: (aria, candidate, boxSizing) =>
			page.evaluate(
				(args) =>
					window.__hw.floorProbe(
						(window as unknown as { __pane: HTMLElement }).__pane,
						args.aria,
						args.candidate,
						args.boxSizing
					),
				{ aria, candidate, boxSizing }
			),
		glyphs: (samples, fontVariantNumeric) =>
			page.evaluate(
				(a) => window.__hw.measureGlyphs(a.samples, a.fontVariantNumeric),
				{ samples, fontVariantNumeric }
			),
	};
}

export async function launch(): Promise<Browser> {
	return chromium.launch();
}

/**
 * Whether `family` resolves to a real face in `browser`, measured inside a
 * throwaway page. See `stripPage.ts#fontAvailable` for the technique and why
 * `document.fonts.check()` was rejected.
 */
export async function fontAvailable(browser: Browser, family: string): Promise<boolean> {
	const page = await browser.newPage();
	await page.setContent("<!doctype html><meta charset=utf-8><title>font check</title>");
	await page.addScriptTag({ content: await pageBundle() });
	const available = await page.evaluate((f) => window.__hw.fontAvailable(f), family);
	await page.close();
	return available;
}

/** Distinct widths, rounded off float noise but not off a real difference. */
export const distinct = (widths: number[]): number[] => [
	...new Set(widths.map((w) => Math.round(w * 100) / 100)),
];

/**
 * The `min-width` declared on `.handwriting-slider-val` in a stylesheet, or
 * null. Read off the text so the check follows the file rather than a memory
 * of what the file says.
 */
export function declaredChipMinWidth(css: string): string | null {
	const block = css.match(/\.handwriting-slider-val\s*\{([\s\S]*?)\}/);
	if (!block || block[1] === undefined) return null;
	const decl = block[1]
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.match(/(?:^|;)\s*min-width\s*:\s*([^;}]+)/);
	return decl && decl[1] !== undefined ? decl[1].trim() : null;
}
