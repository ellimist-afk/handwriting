/**
 * Draw-time ink adaptation for the active Obsidian theme.
 *
 * The complaint this answers (alan, 2026-09-04): "the ink is black on black
 * obsidian". Ink imported from OneNote is stored as #000000, Obsidian's dark
 * theme paints the page near-black, and a whole imported page reads as blank.
 *
 * ONE rule, in ONE direction: near-black neutral ink is painted light on the
 * DARK theme, and nothing at all happens on the light theme. There used to be
 * a mirror rule - near-white ink painted #1E1E1E on the light theme - added
 * for symmetry rather than for a report, and symmetry was the wrong instinct.
 * The palette's "white" pen (#f4f4f2, InkColor.ts) is not ink that was
 * written on a light page and now needs rescuing; it is the pen you pick to
 * write ON something dark - a photo, a scanned figure, a highlighter wash -
 * and it stays white there whatever theme surrounds it. The mirror rule
 * turned every such annotation near-black, which is a defect the dark rule
 * exists to prevent, aimed at the other end of the palette (review,
 * 2026-09-04). No complaint ever motivated it, and it is gone.
 *
 * Nothing here ever touches a stroke. `InkStroke.color` stays exactly what was
 * written or imported; this module only decides what colour that stroke is
 * PAINTED with on this theme, on this frame. Switch the theme back, or turn
 * the setting off, and the same stored bytes paint their original colour
 * again. That is the whole promise, and it is the reason this is a renderer
 * concern and not a migration.
 *
 * ## Why luminance alone is not the test
 *
 * The rule wanted is "near-black ink goes light on a dark page", and the
 * obvious spelling of it - WCAG relative luminance below a threshold - is
 * wrong, because saturated dark HUES sit below the same threshold. A dark
 * navy (#004F8B) has relative luminance 0.075 and a deep green (#008C3A) has
 * 0.19; a luminance-only rule would repaint a page of blue annotations light
 * grey and throw away the colour the writer chose. (Navy is below the
 * threshold this module actually uses, so the neutrality test is what saves
 * it, not the threshold.)
 *
 * So a colour is a candidate only if it is NEUTRAL - its channels are within
 * NEUTRAL_SPREAD of each other, which is what "a grey" means numerically -
 * and only then is its luminance compared. #000, #111, #1F1F1F and OneNote's
 * slightly tinted blacks are neutral; every hue in the palette is not, and
 * passes through untouched.
 *
 * ## Hot path
 *
 * `inkColorFor` runs once per stroke per frame on a full committed repaint -
 * thousands of calls per frame on a long note - so after the first miss for a
 * given colour there is no allocation and no parse on this path: two Maps
 * (one per theme) keyed by the colour string itself, so the lookup key needs
 * no concatenation.
 */

import { InkTool } from "./Stroke";

/** Foreground painted in place of near-black ink on the dark theme. */
const LIGHT_INK = "#E6E6E6";

const LIGHT_INK_RGB: readonly [number, number, number] = [230, 230, 230];

/**
 * Below this relative luminance a NEUTRAL colour counts as near-black.
 *
 * 0.10, not the 0.18 this shipped with. The palette holds TWO neutral pens -
 * black #1c1f26 (luminance 0.014) and graphite #5f6673 (0.132) - and 0.18
 * caught both, so a note written half in one and half in the other came out
 * on the dark theme as one flat #E6E6E6 and the distinction the writer chose
 * was gone (review, 2026-09-04). 0.10 sits between them with room on either
 * side: it still catches #000, #1c1f26, #1E1E1E and #333 (0.033) - every
 * black a note or a OneNote import actually carries - while graphite and
 * anything lighter passes through and stays a lighter grey, which is exactly
 * what it is FOR. Nothing between 0.033 and 0.132 is a colour either palette
 * offers, so the threshold has half a stop of slack in both directions.
 *
 * Exported because one other place decides dark-or-light by luminance - the
 * slides surface, measuring the deck it is about to hang canvases over - and
 * a copy of the number there would be a second source of truth that drifts
 * the first time this one is retuned.
 */
export const DARK_MAX_LUMINANCE = 0.10;
/**
 * Largest channel spread (0..1) a colour may have and still be treated as a
 * grey. #1c1f26 - the palette's "black", and the shape OneNote's near-blacks
 * take - spreads 0.039, and graphite #5f6673 spreads 0.078; both are greys
 * and pass this test. Whether either one then MOVES is DARK_MAX_LUMINANCE's
 * decision, and it separates them. Any real hue is an order of magnitude
 * past this.
 */
const NEUTRAL_SPREAD = 0.12;

/**
 * A colour the caller handed us that we could not read is a colour we do not
 * touch. `null` from the parser means exactly that, and the resolver returns
 * the input string unchanged.
 */
interface ParsedColor {
	r: number;
	g: number;
	b: number;
	/** Two hex digits when the input carried them, else null. */
	alphaHex: string | null;
	/** 0..1 when the input was an rgba(), else null. */
	alphaNum: number | null;
}

const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC_RE = /^rgba?\(([^)]*)\)$/i;

function hexPair(s: string): number {
	return parseInt(s, 16);
}

function parseColor(input: string): ParsedColor | null {
	const s = input.trim();
	if (s === "") return null;
	if (HEX_RE.test(s)) {
		const body = s.slice(1);
		if (body.length <= 4) {
			return {
				r: hexPair(body[0]! + body[0]!),
				g: hexPair(body[1]! + body[1]!),
				b: hexPair(body[2]! + body[2]!),
				alphaHex: body.length === 4 ? body[3]! + body[3]! : null,
				alphaNum: null,
			};
		}
		return {
			r: hexPair(body.slice(0, 2)),
			g: hexPair(body.slice(2, 4)),
			b: hexPair(body.slice(4, 6)),
			alphaHex: body.length === 8 ? body.slice(6, 8) : null,
			alphaNum: null,
		};
	}
	const m = FUNC_RE.exec(s);
	if (!m) return null;
	// Both spellings in one pass: the comma form, and the modern slash form
	// that CSS colour variables resolve to on some themes.
	const parts = m[1]!
		.replace(/\//g, " ")
		.split(/[\s,]+/)
		.filter((p) => p !== "");
	if (parts.length !== 3 && parts.length !== 4) return null;
	const chans: number[] = [];
	for (let i = 0; i < 3; i++) {
		const p = parts[i]!;
		// Percentage channels are legal CSS and vanishingly rare in stored
		// ink; reading them wrong would be worse than leaving them alone.
		if (p.endsWith("%")) return null;
		const n = Number(p);
		if (!Number.isFinite(n)) return null;
		chans.push(Math.min(255, Math.max(0, Math.round(n))));
	}
	let alphaNum: number | null = null;
	if (parts.length === 4) {
		const a = parts[3]!;
		const n = a.endsWith("%") ? Number(a.slice(0, -1)) / 100 : Number(a);
		if (!Number.isFinite(n)) return null;
		alphaNum = Math.min(1, Math.max(0, n));
	}
	return { r: chans[0]!, g: chans[1]!, b: chans[2]!, alphaHex: null, alphaNum };
}

function channel(v: number): number {
	const c = v / 255;
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(r: number, g: number, b: number): number {
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function isNeutral(p: ParsedColor): boolean {
	const max = Math.max(p.r, p.g, p.b);
	const min = Math.min(p.r, p.g, p.b);
	return (max - min) / 255 <= NEUTRAL_SPREAD;
}

function painted(p: ParsedColor, hex: string, rgb: readonly [number, number, number]): string {
	if (p.alphaHex !== null) return hex + p.alphaHex;
	if (p.alphaNum !== null && p.alphaNum < 1) {
		return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${p.alphaNum})`;
	}
	return hex;
}

function compute(color: string, dark: boolean): string {
	// The light theme has no rule at all, so it never parses: a light-theme
	// session memoises the identity answer on the first touch of each colour
	// and does nothing else for the rest of its life.
	if (!dark) return color;
	const p = parseColor(color);
	if (p === null) return color;
	if (!isNeutral(p)) return color;
	const lum = relativeLuminance(p.r, p.g, p.b);
	return lum < DARK_MAX_LUMINANCE ? painted(p, LIGHT_INK, LIGHT_INK_RGB) : color;
}

// One Map per theme rather than one keyed by `color + dark`: the composite key
// would be a fresh string on every lookup, which is an allocation per stroke
// per frame - the one thing this path may not do.
const darkCache = new Map<string, string>();
const lightCache = new Map<string, string>();
/**
 * A note holds a handful of ink colours; a generated or corrupt source could
 * hold many more, and an unbounded Map on a render path is a leak with a
 * polite name.
 *
 * Past the cap the memo simply STOPS GROWING: what is in it stays memoised
 * and everything else is computed and thrown away. It used to `clear()`
 * instead, which is the worst behaviour available on this path - a note with
 * 513 distinct colours empties the map on the 513th stroke of every frame and
 * then re-parses all 513 on the next one, for ever, at exactly the size where
 * a repaint can least afford it. Never clearing means the pathological note
 * pays one parse per stroke past the cap and the ordinary note pays nothing,
 * and the bound the cap exists for is unchanged.
 */
const CACHE_CAP = 512;

/**
 * Pure: the colour `color` should be PAINTED with under a dark (or light)
 * theme. Memoised per theme, so a repeat call for a colour already seen is a
 * Map hit and allocates nothing. Anything unparseable comes back unchanged,
 * and so does everything on the light theme.
 */
export function resolveInkColor(color: string, dark: boolean): string {
	const cache = dark ? darkCache : lightCache;
	const hit = cache.get(color);
	if (hit !== undefined) return hit;
	const out = compute(color, dark);
	if (cache.size < CACHE_CAP) cache.set(color, out);
	return out;
}

/**
 * ## Readable at the destination
 *
 * A second rule, aimed at a different complaint and pointing the other way.
 * Public, from the Reddit thread: ink drawn on the dark theme with the
 * palette's near-white pen (#f4f4f2) is exported onto a white PDF page and is
 * invisible. Alan was asked directly whether an export should reproduce the
 * screen or guarantee readable ink, and ruled: "guarantee readable ink".
 *
 * THIS IS NOT THE MIRROR RULE the header above describes deleting, and it is
 * not the dark rule pointed at the light theme. `resolveInkColor(color,
 * false)` still returns its input before it parses, and nothing drawn on
 * screen changes. This is a CONTRAST guarantee against a destination whose
 * luminance is known: if a stroke would land on that destination below the
 * target ratio, its LIGHTNESS is moved until it passes, and nothing else
 * about it is touched.
 *
 * Why a contrast rule and not "near-white goes dark": the mirror fixes
 * #f4f4f2 and nothing else. Highlighter yellow #ffd60a sits at relative
 * luminance 0.69 - about 1.4:1 on white, which is not readable - and it is
 * not neutral, so the neutrality gate that protects hues on the dark side
 * waves it straight through. A rule that leaves the palette's lightest inks
 * invisible does not guarantee anything.
 *
 * THE PROMISE HERE IS WEAKER THAN THE DARK SIDE'S, AND IT IS WRITTEN DOWN
 * BECAUSE OF THAT. The dark rule protects hues by refusing anything
 * non-neutral outright, and its header records why: a luminance-only rule
 * would have repainted a page of blue annotations grey. A contrast rule MUST
 * touch hued ink - catching the yellow is the whole point - so it cannot hide
 * behind the same gate. What it promises instead: only LIGHTNESS moves. Hue
 * and saturation are carried through the adjustment unchanged, so ink that
 * has to darken is still the colour it was, and a page of blue annotations is
 * still blue. Anything that repaints a hue as a grey is a bug in this
 * function, not a trade-off it is allowed to make.
 *
 * A limit documented rather than solved: `InkStroke` stores only `color`
 * (Stroke.ts) - no provenance. Nothing here can tell "I chose white to write
 * on a dark scan" from "the pen was white because my theme is dark". Under a
 * READABILITY guarantee that stops being a blocker, because the promise holds
 * either way; the indifference is deliberate. Do not add a provenance field
 * to make this cleverer.
 */

/**
 * The contrast a stroke must reach against its destination.
 *
 * 3:1, CITED and not invented: WCAG 2.1 SC 1.4.11 (Non-text Contrast) sets
 * 3:1 for graphical objects. Ink is graphics and not body text, so SC 1.4.3's
 * 4.5:1 is the wrong clause - it would darken far more of the palette than
 * this complaint asks for, every mid-tone pen along with it.
 *
 * Exported for the reason DARK_MAX_LUMINANCE is: the tests assert against the
 * number the rule actually uses, and a second copy of a threshold drifts the
 * first time either one is retuned.
 */
export const EXPORT_MIN_CONTRAST = 3;

/**
 * How far past the target the adjustment actually aims.
 *
 * Not padding for its own sake: the PDF writer emits colour channels to two
 * decimal places (`pdfNum`), so a result that lands exactly on 3.00 here can
 * be written to the file as 2.98 and the guarantee would be true of what this
 * function returned and false of what the user opens. The margin is smaller
 * than one 8-bit step, so it costs nothing visible, and it makes the promise
 * hold of the BYTES rather than of the intermediate value.
 *
 * The early-out above does not use it: ink that already passes at the target
 * is ink this rule has no business touching.
 */
const CONTRAST_MARGIN = 0.05;

/**
 * What a NEUTRAL pen that fails on a LIGHT page is painted instead: the
 * palette's black pen (PEN_COLORS in InkColor.ts), whole, and not the mid
 * grey the smallest passing move lands on. The palette's white pen, #dddddd
 * and #cccccc all used to arrive on a white page as the same grey near
 * #959595, which reads as faded pencil rather than as the writing.
 *
 * Only grey ink and only a light page. Hued ink still takes the smallest move,
 * because it is the hue that is the user's choice; on a dark page the move
 * still points toward white. The cost, written down: a stroke stores no
 * record of what it was drawn over, so white ink written over a dark picture
 * also leaves as black. "Keep original colors" keeps it white.
 */
const LIGHT_PAGE_NEUTRAL_INK = "#000000";
const LIGHT_PAGE_NEUTRAL_INK_RGB: readonly [number, number, number] = [0, 0, 0];

/** WCAG contrast between two relative luminances: (L1 + 0.05) / (L2 + 0.05). */
export function contrastRatio(lumA: number, lumB: number): number {
	const hi = Math.max(lumA, lumB);
	const lo = Math.min(lumA, lumB);
	return (hi + 0.05) / (lo + 0.05);
}

/**
 * RGB 0..255 to HSL 0..1 - the space the adjustment moves in, because it is
 * the one where "change the lightness and nothing else" is a single axis.
 */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) return { h: 0, s: 0, l };
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	const h =
		max === rn
			? ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
			: max === gn
				? ((bn - rn) / d + 2) / 6
				: ((rn - gn) / d + 4) / 6;
	return { h, s, l };
}

function hueChannel(p: number, q: number, t: number): number {
	const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
	if (x < 1 / 6) return p + (q - p) * 6 * x;
	if (x < 1 / 2) return q;
	if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
	return p;
}

/** HSL 0..1 back to RGB 0..255. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	if (s === 0) {
		const v = Math.round(l * 255);
		return [v, v, v];
	}
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	return [
		Math.round(hueChannel(p, q, h + 1 / 3) * 255),
		Math.round(hueChannel(p, q, h) * 255),
		Math.round(hueChannel(p, q, h - 1 / 3) * 255),
	];
}

function hexOf(r: number, g: number, b: number): string {
	const two = (v: number) => v.toString(16).padStart(2, "0");
	return `#${two(r)}${two(g)}${two(b)}`;
}

/**
 * The colour `color` has to be painted with to stay readable on
 * `destination`.
 *
 * Pure, and deliberately ignorant of the setting - `exportInkColor` below is
 * the gated entry point the painters call. Returns the input unchanged
 * whenever the rule does not apply: an unreadable colour, an unreadable
 * destination, a highlighter, or ink that already passes.
 *
 * HIGHLIGHTER IS EXEMPT, and that is not an oversight. It is deliberately
 * light and rides a 0.35-alpha wash UNDER the writing - the snip paints the
 * highlighter at `globalAlpha = 0.35` and then the pen at 1. Darkening a
 * highlighter until it passes 3:1 against the page destroys what it is for:
 * it would stop being a wash you read through and become a bar you read over.
 *
 * THE ADJUSTMENT HAS A FLOOR, FOR HUES AND FOR DARK PAGES. It stops at the
 * first lightness that reaches the target instead of continuing to maximum
 * contrast, so a page of coloured annotations does not arrive uniformly
 * crushed to #000 - a different complaint arriving by the same route. The
 * search bisects between the ink's own lightness and the pole with the most
 * headroom against the destination, so what comes back is the SMALLEST move
 * that satisfies the guarantee.
 *
 * A neutral pen on a light page is the one case that skips the search: it is
 * painted LIGHT_PAGE_NEUTRAL_INK, the palette's black. See that constant.
 */
export function readableInkColor(
	color: string,
	destination: string,
	tool: InkTool = "pen"
): string {
	if (tool === "highlighter") return color;
	const p = parseColor(color);
	if (p === null) return color;
	const d = parseColor(destination);
	if (d === null) return color;
	const destLum = relativeLuminance(d.r, d.g, d.b);
	if (contrastRatio(relativeLuminance(p.r, p.g, p.b), destLum) >= EXPORT_MIN_CONTRAST) {
		return color;
	}
	const { h, s, l } = rgbToHsl(p.r, p.g, p.b);
	// Toward whichever pole has the most room against this destination. Black
	// is luminance 0 and white is 1, and the better of the two is always worth
	// at least 4.58:1 - the two curves cross at destination luminance 0.179 -
	// so the target is reachable for every destination and the bisection below
	// always closes on a passing value.
	const pole = contrastRatio(0, destLum) >= contrastRatio(1, destLum) ? 0 : 1;
	if (pole === 0 && isNeutral(p)) return painted(p, LIGHT_PAGE_NEUTRAL_INK, LIGHT_PAGE_NEUTRAL_INK_RGB);
	let fails = l;
	let passes = pole;
	// 20 halvings of a 0..1 range settle far below one 8-bit step.
	for (let i = 0; i < 20; i++) {
		const mid = (fails + passes) / 2;
		const [mr, mg, mb] = hslToRgb(h, s, mid);
		if (
			contrastRatio(relativeLuminance(mr, mg, mb), destLum) >=
			EXPORT_MIN_CONTRAST + CONTRAST_MARGIN
		) {
			passes = mid;
		} else {
			fails = mid;
		}
	}
	const [r, g, b] = hslToRgb(h, s, passes);
	return painted(p, hexOf(r, g, b), [r, g, b]);
}

/**
 * Is Obsidian showing a dark theme? The one signal it gives is the body class
 * it stamps, which is also what every theme and snippet keys off.
 */
export function isDarkTheme(doc: Document = document): boolean {
	return doc?.body?.classList?.contains("theme-dark") === true;
}

let adaptEnabled = true;
/** `setInkThemeOverride`'s flag: non-null wins over the body class. */
let darkOverride: boolean | null = null;

/** The persisted legacy `inkAdaptsToTheme` value, retained for compatibility. */
export function setInkThemeAdaptation(on: boolean): void {
	adaptEnabled = on;
}

export function inkThemeAdaptationEnabled(): boolean {
	return adaptEnabled;
}

/** Compatibility seam for callers that refresh on Obsidian's `css-change`. */
export function refreshInkTheme(doc?: Document): void {
	// Kept as a compatibility seam for callers that refresh on css-change.
	void doc;
}

/**
 * Set while a surface is painting on a background that is NOT the body's, and
 * `null` the rest of the time.
 *
 * The case that forces it: Obsidian's presenter picks its deck stylesheet from
 * the Appearance CONFIG value, not from the body class - white.css only when
 * the setting is literally "moonstone", black.css otherwise - so "adapt to
 * system" on a light-mode OS presents a black deck under a body with no
 * `theme-dark` class. Ink would follow the body, resolve as light-theme, and
 * paint black on black: a whole presentation of invisible ink.
 *
 * Module-wide, deliberately. It is one flag rather than a per-surface field
 * because `inkColorFor` is the hot path and must not grow a parameter or a
 * lookup per stroke. The cost is that an editor pane repainting behind a live
 * presentation (or in a pop-out window) takes the DECK's theme for that
 * repaint. That is accepted: a presentation covers the screen, the repaint
 * behind it is not being looked at, and the next repaint after teardown is
 * correct again.
 *
 * Not cleared by `refreshInkTheme`: a `css-change` during a presentation
 * (a theme switch, a snippet toggle) must not disturb the override. The
 * override exists to ignore body-theme changes. `resetInkTheme` clears it, because a
 * test seam that left it standing would leak one test's deck into the next.
 */
export function setInkThemeOverride(dark: boolean | null): void {
	darkOverride = dark;
}

/** The standing override, or `null` when ink follows the body as usual. */
export function inkThemeOverride(): boolean | null {
	return darkOverride;
}

/**
 * THE accessor. Every place a stroke or pen style's colour reaches a canvas
 * goes through this and nowhere else. Live ink is the colour the user chose;
 * only an explicit export destination may adjust it for readability.
 *
 * Takes anything carrying a `color`, which is both `InkStroke` and `PenStyle`
 * - the wet layer and the committed layer paint the same ink and must agree
 * at pen-up, and structural typing is what keeps that from being two rules -
 * or the bare string, for the one painter (TailRenderer's predicted tail)
 * that is handed a colour rather than the style it came from. Wrapping that
 * string in an object literal to satisfy a single signature would be an
 * allocation per frame on a path whose whole point is not to have one.
 */
export function inkColorFor(
	source: string | { readonly color: string; readonly tool?: InkTool }
): string {
	const color = typeof source === "string" ? source : source.color;
	// A known destination is an export operation: the surface has said what
	// the ink is landing on, and being readable there is the export promise.
	// This is null on every frame drawn on screen.
	if (destination !== null) {
		return exportInkColor(
			color,
			destination,
			typeof source === "string" ? "pen" : source.tool
		);
	}
	// Live paint is never themed. This covers committed, wet, head/contact and
	// predicted-tail renderers on notes, PDFs and Slides without asking every
	// caller to remember a scope. Keep the string byte-for-byte as stored.
	return color;
}

/**
 * Paint with STORED colours for the duration of `painter`.
 *
 * What leaves the vault is not themed. A PNG snip, an SVG export or ink burnt
 * into a PDF is a document that will be opened somewhere with no idea what
 * theme it was taken under, so it carries the colour the writer chose - the
 * same bytes the note holds. The SVG and PDF writers never reach a canvas and
 * so never touch this module at all; the two PNG snips share their painter
 * with an on-screen surface, and this is how they say which they are.
 *
 * Live painting is already raw; this scope remains for export callers and
 * compatibility. Synchronous by contract: the callback must not await inside
 * the scope.
 */
export function withRawInk<T>(painter: () => T): T {
	return painter();
}

/**
 * The `inkReadableInExports` setting.
 *
 * ON by default (alan, 2026-09-08: "export toggle should default on"), unlike
 * `inkAdaptsToTheme`, which stays OFF. The two look alike and answer opposite
 * ways ON PURPOSE: on screen you are looking at your own canvas, so the
 * expected behaviour is the colour you picked; in an export you are producing
 * something for elsewhere, so the expected behaviour is that you can read it.
 * The settings copy has to carry that difference or the pair reads as a bug.
 */
let exportReadable = true;

/**
 * The destination the CANVAS painters are currently painting onto, and null
 * the rest of the time - which is every frame drawn on screen.
 *
 * Module-wide for exactly the reason `setInkThemeOverride` is: `inkColorFor`
 * is the hot path and must not grow a parameter or a lookup per stroke. The
 * string painters (SvgExport, InkPdf) never reach a canvas and never read
 * this; they take their destination as an argument, because a caller writing
 * an SVG knows something this module cannot.
 */
let destination: string | null = null;

export function setInkExportReadability(on: boolean): void {
	exportReadable = on;
}

export function inkExportReadabilityEnabled(): boolean {
	return exportReadable;
}

/**
 * THE gated entry point for every export painter.
 *
 * One place decides whether the rule runs, so the setting cannot be honoured
 * by three painters and forgotten by the fourth - which is how this defect
 * survived four paint paths in the first place. A null or absent destination
 * means the caller does not know what the ink is landing on (a transparent
 * SVG, say), and then the stored colour is what leaves.
 */
export function exportInkColor(
	color: string,
	dest: string | null | undefined,
	tool?: InkTool
): string {
	if (dest === null || dest === undefined || !exportReadable) return color;
	return readableInkColor(color, dest, tool ?? "pen");
}

/**
 * Paint onto a known destination for the duration of `painter`.
 *
 * This is for the CANVAS exports. The note snip paints its own white page and
 * then draws committed strokes through the shared renderer, so a scope like
 * this is the only way to tell that renderer where the ink is going without
 * giving `inkColorFor` the per-stroke parameter it may not have.
 *
 * Saves and restores rather than counting like `withRawInk`, because it
 * carries a value: a nested scope has to put the outer destination back
 * rather than clear it.
 *
 * Synchronous by contract, same as `withRawInk`: the flag is module-wide, so
 * the callback must not await inside the scope.
 */
export function withInkDestination<T>(dest: string | null, painter: () => T): T {
	const prev = destination;
	destination = dest;
	try {
		return painter();
	} finally {
		destination = prev;
	}
}

/** The destination a canvas painter is currently inside, or null. */
export function inkDestination(): string | null {
	return destination;
}

/** Test seam: forget the memo and the theme, and re-arm the setting. */
export function resetInkTheme(): void {
	darkCache.clear();
	lightCache.clear();
	adaptEnabled = true;
	darkOverride = null;
	exportReadable = true;
	destination = null;
}

/** Test and diagnostic seam: how many colours each theme's memo holds. */
export function inkThemeCacheSize(): { dark: number; light: number } {
	return { dark: darkCache.size, light: lightCache.size };
}
