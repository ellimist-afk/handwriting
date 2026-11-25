/**
 * INK STAYS ON ITS WORDS AT ANOTHER TEXT SIZE (issue 58).
 *
 * Device A (desktop) draws one magenta loop on a phrase and saves. Device B opens the SAME bytes (note text, page id, ink
 * file) in a new browser context at another text size, or A changes its own text size after drawing. With Infinite Canvas
 * on, and with it off where the pane has room, the ink must sit on the words it was drawn on: the ink's painted centroid
 * against the phrase's text box moves under 1 px down, and across by no more than 1 px past the px of the phrase's line that
 * do not scale with the text (its padding, a quote's rule and indent) times the size ratio less 1: a named limit. The text column follows the text size, so the words
 * wrap as where the ink was drawn, and a line anchor taken at one size is honoured at another moved by the same ratio.
 *
 * Pins: at the note's own size nothing changes (nothing differs, B narrower or wider, a picture above, a phone); typed text above
 * free ink still leaves the ink where it was (-96 px); a save with no edit on the other device rewrites no anchor and no
 * width or size reference; a file another device saved before this fix shows its ink in place on both devices. With the
 * canvas off and no room for the wider column, the text re-wraps as in a narrow pane, as before.
 *
 * Rig: the issue 58 repro rig (issue58FontPage.ts): CodeMirror with the real ink overlay, block stand-ins of a set height.
 * Run: npm run test:render -- test/render/Issue58Font.test.ts. HW_ISSUE58_REPORT=<path> writes every row as JSON.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const PHRASE = "ink rides here";
const WORDS = ["router", "packet", "address", "private", "public", "network", "table", "port", "gateway", "client", "server", "header"];
function filler(n: number, seed: number): string {
	let out = "", i = seed;
	while (out.length < n) { out += (out ? " " : "") + WORDS[i % WORDS.length]; i += 5; }
	return out.slice(0, n).replace(/ $/, "x");
}
const CJK = "在上方的中文段落用于检查不同设备上的回退字体是否改变行高与换行位置，公式与图像之间的文字也会影响墨迹的显示位置。".repeat(2);
const BLOCKS: Record<string, string> = {
	none: "",
	math: "$$\n\\oint V(N)\\,dN = \\frac{1}{2}\\sum_{i} V_i\n$$",
	image: "![[pic.png]]",
	embed: "![[Other note]]",
	callout: "> [!note] A callout\n> " + filler(220, 4),
	cjk: CJK,
};
/** The Properties block: the note's frontmatter, drawn as one block of a set height at the top. */
const PROPS = "---\ntags: networking\naliases: NAT\n---";
/**
 * The note: a heading, two wrapping paragraphs, the block, a paragraph, the phrase's line, a paragraph, a last line. With
 * the "props" block the frontmatter comes first instead.
 */
function note(block: string, mid = false): string {
	const b = BLOCKS[block] ?? "";
	// mid: the phrase sits mid-row in a wrapping paragraph (about 130 characters in), so a re-wrap moves it across.
	const phraseLine = mid ? filler(130, 6) + " " + PHRASE + " " + filler(200, 8) : PHRASE + " " + filler(90, 6);
	return [...(block === "props" ? [PROPS] : []), "# Network Address Translation", "", filler(210, 1), "", filler(190, 2), "", ...(b ? [b, ""] : []), filler(160, 3), "",
		phraseLine, "", filler(150, 7), "", "last line"].join("\n");
}
const TYPED = filler(260, 9);

interface Dev {
	paneW: number; paneH: number; fontPx: number; canvas: boolean; mobile: boolean; mathH: number; calloutPad: number; fontFamily: string; imageH?: number;
	imageLateMs?: number; imageUnknown?: boolean; imageAfterMeasure?: boolean; embedH?: number; embedAfterMeasure?: boolean; propsH?: number; linePad?: number; phraseIn?: "list" | "quote"; hidden?: boolean; path?: string;
}
const A: Dev = { paneW: 820, paneH: 900, fontPx: 16, canvas: true, mobile: false, mathH: 56, calloutPad: 12, fontFamily: "'Segoe UI', 'Microsoft YaHei', sans-serif" };
/** A pane with room for the note's 805 px column at 1.25 times the text size: canvas-off cells that must hold. */
const ROOM = 1060;
const ANDROID = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
	userAgent: "Mozilla/5.0 (Linux; Android 16; CMF Phone 1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36" };

type Step = ["draw"] | ["saveMark"] | ["typeAbove", number, string] | ["setFont", number] | ["setPane", number] | ["setFontCss", number] | ["zoom", number] |
	["contactFont", number] | ["attachFirst"] | ["roomEdge"] | ["switchTo", { text: string; pageId: string | null; sidecar: string | null; path: string }];
/**
 * What a cell asserts, on every shift it reads (B as opened, B after its steps, A reopened, A after its own steps):
 * "zero": under 1 px down, and across within 1 px of the line's fixed px times (ratio - 1) (Shift.px; 0 at one size), at the
 * first painted frame too. { dy, on, dx }: on the named reads (a first paint reads as its open row), down within 1 px of dy and
 * across within 1 px of dx (Shift.px when absent); every other read as "zero".
 * "save": "zero", and B's saved first anchor, column width and size reference are A's to the byte.
 */
type Want = "zero" | "save" | { dy: number; on: string[]; dx?: number };
const AFTER_TYPING_ON_B = ["B after", "A reopen"], AFTER_TYPING_ON_A = ["B open", "A self"], NO_ROOM = ["B open"];
interface Cell {
	name: string;
	block: string;
	mid?: boolean;
	/** Canvas on A and on B: true ON on both, false OFF on both. */
	canvas: boolean;
	/** The canvas on A and on B where they differ; overrides `canvas`. */
	canvasAB?: [boolean, boolean];
	b: Partial<Dev>;
	both?: Partial<Dev>;
	android?: boolean;
	aAfter?: Step[];
	bSteps?: Step[];
	/** B opens bytes A saved, with the first stroke's anchor replaced by the one a second device saved before this fix. */
	prefixAnchor?: boolean;
	/** A's own changes (a text size, a path). */
	a?: Partial<Dev>;
	/**
	 * B first opens another note a 16 px desktop drew (the plain note), then its pane switches to this cell's note, which A
	 * drew: B's open reads are the switched note's.
	 */
	switchFrom?: boolean;
	/** The arrived layout only: no first paint is asserted (an image that decodes after it). */
	noFirst?: boolean;
	/** B opens in a browser whose scrollbars take room (Playwright hides them in headless by default). */
	scrollbars?: boolean;
	/**
	 * What else the cell checks on A's own last step: "layout", the size change reached the overlay's layout read;
	 * "content", it reached the overlay only through the content's resize (the layout read still had the old size when the
	 * change had settled); "contact", the column did not move while the pen was down, and the stroke stayed one stroke;
	 * "zoomed", the note was at 300% when the size changed and no anchor pairs the new size with the old width.
	 */
	check?: "layout" | "content" | "contact" | "zoomed" | "edge";
	want: Want;
}

/** One cell per canvas setting: ON as given; OFF with the given `off` changes (room for the wider column), or none. */
function both(c: Omit<Cell, "canvas" | "name"> & { name: string; off?: Partial<Cell> }): Cell[] {
	const { off, ...rest } = c;
	return [{ ...rest, canvas: true, name: rest.name + " | canvas ON" }, { ...rest, ...off, canvas: false, name: (off?.name ?? rest.name) + " | canvas OFF" }];
}
const roomB = (name: string, b: Partial<Dev>): Partial<Cell> => ({ name: name + ", B pane " + ROOM, b: { ...b, paneW: ROOM } });

/**
 * The anchor a 1.5.1 device at text size 18 wrote into this note's first stroke on a save with no edit (the repro's
 * dump, arms run 84fd544a: line 7, top 216, its line's key and lines-above hash, size 18, A's width). Same text, same key.
 */
const PREFIX_ANCHOR = { line: 7, top: 216, key: 2839462505, width: 805, fontPx: 18, above: 2751362125 };

const CELLS: Cell[] = [
	// Red on the base: the text size differs.
	...both({ name: "B font 18 (A 16)", block: "none", b: { fontPx: 18 }, want: "zero", off: roomB("B font 18 (A 16)", { fontPx: 18 }) }),
	...both({ name: "B font 20 (A 16)", block: "none", b: { fontPx: 20 }, want: "zero", off: roomB("B font 20 (A 16)", { fontPx: 20 }) }),
	...both({ name: "phrase mid-row, B font 18", block: "none", mid: true, b: { fontPx: 18 }, want: "zero", off: roomB("phrase mid-row, B font 18", { fontPx: 18 }) }),
	...both({ name: "phrase mid-row, B font 14", block: "none", mid: true, b: { fontPx: 14 }, want: "zero" }),
	...both({ name: "one device, A draws then its own font 16 to 18", block: "none", b: {}, aAfter: [["setFont", 18]], want: "zero", check: "layout",
		off: { name: "one device, A draws, its pane to " + ROOM + ", then its own font 16 to 18", aAfter: [["setPane", ROOM], ["setFont", 18]] } }),
	// The same change heard only through the content's own resize (the second place the ink's text size ratio is written).
	...both({ name: "one device, A's own font 16 to 18 by the css variable alone", block: "none", b: {}, aAfter: [["setFontCss", 18]], want: "zero", check: "content",
		off: { name: "one device, its pane to " + ROOM + ", then A's own font 16 to 18 by the css variable alone", aAfter: [["setPane", ROOM], ["setFontCss", 18]] } }),
	// The size change with a pen down: the column waits for the lift, then the ink is on its words.
	...both({ name: "one device, A's own font 16 to 18 with a pen down, then the lift", block: "none", b: {}, aAfter: [["contactFont", 18]], want: "zero", check: "contact",
		off: { name: "one device, its pane to " + ROOM + ", A's own font 16 to 18 with a pen down, then the lift", aAfter: [["setPane", ROOM], ["contactFont", 18]] } }),
	// The size change while the note is zoomed to 300%, asserted back at 100%.
	{ name: "one device, A zooms to 300%, its own font 16 to 18, back to 100% | canvas ON", block: "none", canvas: true, b: {}, aAfter: [["zoom", 3], ["setFont", 18], ["zoom", 1]],
		want: "zero", check: "zoomed" },
	// A fractional size (Android text scale, a quick font step): 805 x 18.4 / 16 = 925.75.
	...both({ name: "B font 18.4 (A 16)", block: "none", b: { fontPx: 18.4 }, want: "zero", off: roomB("B font 18.4 (A 16)", { fontPx: 18.4 }) }),
	...both({ name: "phrase mid-row, B font 18.4", block: "none", mid: true, b: { fontPx: 18.4 }, want: "zero", off: roomB("phrase mid-row, B font 18.4", { fontPx: 18.4 }) }),
	// Px inside the column: the phrase's line two list levels in (an em indent), inside a quote (px), and 24 px line padding.
	...both({ name: "phrase mid-row in a nested list item, B font 18", block: "none", mid: true, both: { phraseIn: "list" }, b: { fontPx: 18 }, want: "zero",
		off: roomB("phrase mid-row in a nested list item, B font 18", { fontPx: 18 }) }),
	...both({ name: "phrase mid-row in a quote (4 px rule, 24 px indent), B font 18", block: "none", mid: true, both: { phraseIn: "quote" }, b: { fontPx: 18 }, want: "zero",
		off: roomB("phrase mid-row in a quote (4 px rule, 24 px indent), B font 18", { fontPx: 18 }) }),
	...both({ name: "phrase mid-row, 24 px line padding, B font 18", block: "none", mid: true, both: { linePad: 24 }, b: { fontPx: 18 }, want: "zero",
		off: roomB("phrase mid-row, 24 px line padding, B font 18", { fontPx: 18 }) }),
	// The first paint: a pane with no box at mount, shown once the ink is in; and one pane switching to a note drawn at 18.
	...both({ name: "B font 18, pane hidden at mount, shown once the ink is in", block: "none", b: { fontPx: 18, hidden: true }, want: "zero",
		off: roomB("B font 18, pane hidden at mount, shown once the ink is in", { fontPx: 18, hidden: true }) }),
	...both({ name: "B at 16 opens a note drawn at 16, then the pane switches to a note drawn at 18 (phrase mid-row)", block: "none", mid: true,
		a: { fontPx: 18, path: "issue-58-b.md" }, b: {}, switchFrom: true, want: "zero" }),
	// Blocks that do not scale, above the ink: the Properties block, and an image that decodes after the first paint.
	...both({ name: "B font 18, Properties block above (120 px)", block: "props", b: { fontPx: 18 }, want: "zero",
		off: roomB("B font 18, Properties block above (120 px)", { fontPx: 18 }) }),
	...both({ name: "B font 18, 300 px image above decoding 150 ms after it is drawn", block: "image", both: { imageH: 300, imageLateMs: 150 }, b: { fontPx: 18 }, want: "zero",
		noFirst: true, off: roomB("B font 18, 300 px image above decoding 150 ms after it is drawn", { fontPx: 18 }) }),
	...both({ name: "B font 18, fixed 300 px image above", block: "image", both: { imageH: 300 }, b: { fontPx: 18 }, want: "zero",
		off: roomB("B font 18, fixed 300 px image above", { fontPx: 18 }) }),
	// The same late image at the note's own size: whether a late image alone moves the ink (the rig or the base).
	...both({ name: "300 px image above decoding 150 ms after it is drawn, nothing else differs", block: "image", both: { imageH: 300, imageLateMs: 150 }, b: {},
		want: "zero", noFirst: true }),
	{ name: "B Android 412x915 mobile, font 18 | canvas ON", block: "none", canvas: true, b: { paneW: 412, paneH: 860, mobile: true, fontPx: 18 }, android: true, want: "zero" },
	// Zero pins: green on the base and after.
	...both({ name: "nothing differs", block: "none", b: {}, want: "zero" }),
	...both({ name: "B font 14 (A 16)", block: "none", b: { fontPx: 14 }, want: "zero" }),
	...both({ name: "B Georgia serif, same size", block: "none", b: { fontFamily: "Georgia, 'Times New Roman', serif" }, want: "zero" }),
	...both({ name: "B column wider (1060)", block: "none", b: { paneW: 1060 }, want: "zero" }),
	...both({ name: "display math above, B block 80 px (A 56)", block: "math", b: { mathH: 80 }, want: "zero" }),
	...both({ name: "image above, B column wider (1060)", block: "image", b: { paneW: 1060 }, want: "zero" }),
	...both({ name: "callout above, B padding 22 (A 12)", block: "callout", b: { calloutPad: 22 }, want: "zero" }),
	...both({ name: "CJK above, B falls back to SimSun", block: "cjk", b: { fontFamily: "'Segoe UI', SimSun, sans-serif" }, want: "zero" }),
	{ name: "B column narrower (420) | canvas ON", block: "none", canvas: true, b: { paneW: 420 }, want: "zero" },
	// The first frame at open painted the ink from the height map's estimate before the editor measured the re-wrapped text
	// (-53.50 on the base and on 1.5.1, in place a frame later): the first frame shows it in place.
	{ name: "image above, B column narrower (420) | canvas ON", block: "image", canvas: true, b: { paneW: 420 }, want: "zero" },
	// A picture or an embed alone on its line above the ink, readable line length off (this rig's pane never has it): the app
	// first painted the ink above its words by the block's height less one line (picture 200 px: -176; embed 168 px: -144),
	// in place a frame or two later. The editor learns the block's height only when it measures it; the first frame shows the
	// ink in place.
	...both({ name: "B font 18, a 200 px picture alone on its line above, its height unknown until measured", block: "image", both: { imageH: 200, imageUnknown: true },
		b: { fontPx: 18 }, want: "zero", off: roomB("B font 18, a 200 px picture alone on its line above, its height unknown until measured", { fontPx: 18 }) }),
	...both({ name: "B font 18, a 168 px embed alone on its line above", block: "embed", both: { embedH: 168 }, b: { fontPx: 18 }, want: "zero",
		off: roomB("B font 18, a 168 px embed alone on its line above", { fontPx: 18 }) }),
	// The same road at the note's own size: on B the picture's height arrives after the editor's first measure, which read
	// one line; the height map keeps the line until the editor measures again, so ink placed from it sits the block's height
	// less one line above its words. The first frame shows the ink in place.
	{ name: "a 200 px picture alone on its line above, its height set after the editor's first measure | canvas ON", block: "image", canvas: true,
		both: { imageH: 200 }, b: { imageAfterMeasure: true }, want: "zero" },
	// The same road for an embed of another note: the first frame would show the ink the embed's height less one line high.
	{ name: "a 168 px embed alone on its line above, its height set after the editor's first measure | canvas ON", block: "embed", canvas: true,
		both: { embedH: 168 }, b: { embedAfterMeasure: true }, want: "zero" },
	{ name: "a 168 px embed alone on its line above, its height set after the editor's first measure, B pane " + ROOM + " | canvas OFF", block: "embed",
		canvas: false, both: { embedH: 168 }, b: { embedAfterMeasure: true, paneW: ROOM }, want: "zero" },
	{ name: "B narrower (420) saves with no edit, A reopens | canvas ON", block: "none", canvas: true, b: { paneW: 420 }, bSteps: [["saveMark"]], want: "zero" },
	{ name: "B Android 412x915 mobile | canvas ON", block: "none", canvas: true, b: { paneW: 412, paneH: 860, mobile: true }, android: true, want: "zero" },
	{ name: "A canvas ON, B canvas OFF, same width", block: "none", canvas: true, canvasAB: [true, false], b: {}, want: "zero" },
	{ name: "A canvas OFF, B canvas ON, same width", block: "none", canvas: true, canvasAB: [false, true], b: {}, want: "zero" },
	{ name: "A canvas OFF, B canvas ON, B narrower (420)", block: "none", canvas: true, canvasAB: [false, true], b: { paneW: 420 }, want: "zero" },
	// Canvas off and a narrower pane: the text re-wraps under ink that stays put (contract; base -144).
	{ name: "canvas off, B column narrower (420) | canvas OFF", block: "none", canvas: false, b: { paneW: 420 }, want: { dy: -143.99, on: NO_ROOM } },
	{ name: "B column narrower (420) | canvas OFF", block: "none", canvas: false, b: { paneW: 420 }, want: { dy: -144, on: NO_ROOM } },
	{ name: "B narrower (420) saves with no edit, A reopens | canvas OFF", block: "none", canvas: false, b: { paneW: 420 }, bSteps: [["saveMark"]], want: { dy: -143.99, on: ["B open", "B after"] } },
	{ name: "B Android 412x915 mobile | canvas OFF", block: "none", canvas: false, b: { paneW: 412, paneH: 860, mobile: true }, android: true, want: { dy: -143.78, on: NO_ROOM } },
	{ name: "A canvas ON, B canvas OFF, B narrower (420)", block: "none", canvas: false, canvasAB: [true, false], b: { paneW: 420 }, want: { dy: -144, on: NO_ROOM } },
	// Typed text above free ink: the ink stays where it was (contract).
	...both({ name: "B types a paragraph two lines above, A reopens", block: "none", b: {}, bSteps: [["typeAbove", 2, TYPED]], want: { dy: -96, on: AFTER_TYPING_ON_B } }),
	...both({ name: "A types above after drawing, B opens wider (1060)", block: "none", b: { paneW: 1060 }, aAfter: [["typeAbove", 2, TYPED]], want: { dy: -96, on: AFTER_TYPING_ON_A } }),
	// The same first frame (-120 on the base and on 1.5.1, -96 a frame later): the first frame shows the ink at -96.
	...both({ name: "A types above after drawing and saves, B opens wider (1060)", block: "none", b: { paneW: 1060 }, aAfter: [["typeAbove", 2, TYPED], ["saveMark"]],
		want: { dy: -96, on: AFTER_TYPING_ON_A } }),
	...both({ name: "A types above after drawing, B opens at the same width", block: "none", b: {}, aAfter: [["typeAbove", 2, TYPED]], want: { dy: -96, on: AFTER_TYPING_ON_A } }),
	// A save with no edit on the other device rewrites nothing A wrote.
	...both({ name: "B font 18 saves with no edit, A reopens", block: "none", b: { fontPx: 18 }, bSteps: [["saveMark"]], want: "save",
		off: roomB("B font 18 saves with no edit, A reopens", { fontPx: 18 }) }),
	// A file a second device saved before this fix.
	...both({ name: "B font 18 opens a file a font-18 device saved before the fix, saves, A reopens", block: "none", b: { fontPx: 18 }, prefixAnchor: true,
		bSteps: [["saveMark"]], want: "zero", off: roomB("B font 18 opens a file a font-18 device saved before the fix, saves, A reopens", { fontPx: 18 }) }),
	// Canvas off with no room for the wider column: re-wraps as in a narrow pane, as before (base: -27.19, -59.81, -188.71).
	{ name: "B font 18, B pane 820, no room | canvas OFF", block: "none", canvas: false, b: { fontPx: 18 }, want: { dy: -27.19, on: NO_ROOM } },
	{ name: "B font 20, B pane 820, no room | canvas OFF", block: "none", canvas: false, b: { fontPx: 20 }, want: { dy: -59.81, dx: 1.6, on: NO_ROOM } },
	// The room edge: the pane at the scaled column's edge, its height at the note's, so the scrollbar decides the room. The
	// held column settles within two observer rounds and never alternates.
	{ name: "room edge: B font 18, pane at the scaled column plus half a scrollbar | canvas OFF", block: "none", canvas: false, b: { fontPx: 18, paneW: ROOM },
		bSteps: [["roomEdge"]], check: "edge", scrollbars: true, want: "zero" },
	// An attached group stays on its word at another text size, moved once.
	...both({ name: "attached group, B font 18", block: "none", b: { fontPx: 18 }, aAfter: [["attachFirst"]], want: "zero",
		off: roomB("attached group, B font 18", { fontPx: 18 }) }),
	{ name: "B Android 412x915 mobile, font 18, no room | canvas OFF", block: "none", canvas: false, b: { paneW: 412, paneH: 860, mobile: true, fontPx: 18 }, android: true, want: { dy: -188.71, on: NO_ROOM } },
];

let script = "";
let desktop: Browser | null = null, mobile: Browser | null = null, bars: Browser | null = null;
const report: unknown[] = [];

beforeAll(async () => {
	const b = await build({ entryPoints: [fileURLToPath(new URL("./issue58FontPage.ts", import.meta.url))], bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	desktop = await chromium.launch({ headless: true, args: ["--force-device-scale-factor=2", "--window-size=1440,960"] });
	mobile = await chromium.launch({ headless: true });
	// Desktop with scrollbars that take room: Playwright passes --hide-scrollbars in headless, which zeroes every scrollbar.
	bars = await chromium.launch({ headless: true, args: ["--force-device-scale-factor=2", "--window-size=1440,960"], ignoreDefaultArgs: ["--hide-scrollbars"] });
	// The first page a browser opens starts with a different line-height estimate: opened and dropped, as InkStaysOnItsLine.
	for (const br of [desktop, mobile, bars]) { const w = await open(br, false); await w.ctx.close(); }
}, 180_000);
afterAll(async () => {
	await desktop?.close(); await mobile?.close(); await bars?.close();
	if (process.env.HW_ISSUE58_REPORT) writeFileSync(process.env.HW_ISSUE58_REPORT, JSON.stringify(report, null, 1));
});

async function open(br: Browser, android: boolean): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
	const ctx = await br.newContext(android ? ANDROID : { viewport: null });
	const page = await ctx.newPage(), errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	page.on("console", msg => { const t = msg.text(); if (/plugin crashed|isn't allowed during an update/.test(t)) errors.push(("console: " + t).slice(0, 200)); });
	await page.setContent('<!doctype html><body class="theme-dark" style="margin:0"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addScriptTag({ content: script });
	return { ctx, page, errors };
}
type Bytes = { text: string; pageId: string | null; sidecar: string | null; saves: number };
const call = (p: Page, method: string, ...args: unknown[]): Promise<any> => p.evaluate(([n, a]) => (window as any).issue58[n](...a), [method, args] as const);
async function device(dev: Dev, android: boolean, bytes: { text: string; pageId: string | null; sidecar: string | null }, steps: Step[], errors: string[],
	scrollbars = false): Promise<{ open: any; rows: any[]; bytes: Bytes }> {
	const d = await open(android ? mobile! : scrollbars ? bars! : desktop!, android);
	try {
		const open0 = await call(d.page, "mount", { ...dev, ...bytes, phrase: PHRASE, measure: MEASURE });
		const rows: any[] = [];
		for (const [m, ...args] of steps) rows.push(await call(d.page, m, ...args));
		const out = await call(d.page, "bytes") as Bytes;
		errors.push(...d.errors);
		return { open: open0, rows, bytes: out };
	} finally { await d.ctx.close(); }
}

/**
 * First-paint measure, opt in (HW_FIRST_PAINT_MEASURE=1): each open logs the overlay's repaints from the mount and one read per
 * frame for 40 frames after the first paint; nothing asserted changes. A measure, not a check.
 */
const MEASURE = process.env.HW_FIRST_PAINT_MEASURE === "1";
/** The frames from the first paint until the ink sits within 1 px of the open read, and the repaints logged. */
function measureLine(tag: string, o: any): string {
	if (!o?.first?.trail) return `${tag}: no first paint`;
	const want = o.offY, tr = o.first.trail as any[];
	const at = typeof want === "number" ? tr.findIndex(r => typeof r.offY === "number" && Math.abs(r.offY - want) < 1) : -1;
	const fp = o.first.offY;
	return `${tag}: first paint frame ${o.first.frame} offY ${f(fp)} vs open ${f(want)}; in place ${typeof fp === "number" && Math.abs(fp - want) < 1 ? "at first paint" : at < 0 ? "not within 40 frames" : `after ${tr[at].k} frame(s)`}; ` +
		`trail offY ${tr.slice(0, 8).map(r => f(r.offY)).join(" ")}; repaints ${o.paints?.length ?? 0}: ` +
		(o.paints ?? []).slice(0, 12).map((p: any) => `[dy ${f(p.dyMemo)} e${p.dyEpoch}/${p.laEpoch} sigW ${p.sigW} cw ${p.clientW} held ${p.columnHeld} cm ${f(p.cmTop)} box ${f(p.boxTop)} aTop ${f(p.anchorTop)}]`).join(" ");
}

const stripBom =(s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
/** The first stroke record in an ink file's JSON (color plus points), in document order. */
function firstStroke(j: unknown): Record<string, unknown> | undefined {
	if (Array.isArray(j)) { for (const x of j) { const r = firstStroke(x); if (r) return r; } return undefined; }
	if (j && typeof j === "object") {
		const o = j as Record<string, unknown>;
		if (o.color !== undefined && (o.ptsd !== undefined || o.pts !== undefined)) return o;
		for (const k of Object.keys(o)) { const r = firstStroke(o[k]); if (r) return r; }
	}
	return undefined;
}
/** What a save must not rewrite: the first stroke's anchor and the file's width and size references, as JSON text. */
function savedRefs(sidecar: string | null): string {
	if (!sidecar) return "no ink file";
	const j = JSON.parse(stripBom(sidecar)) as Record<string, unknown>;
	return JSON.stringify({ lineAnchor: firstStroke(j)?.lineAnchor ?? null, columnRefPx: j.columnRefPx ?? null, fontRefPx: j.fontRefPx ?? null });
}
/** A's ink file with the first stroke's anchor replaced by the one a second device saved before this fix. */
function withPrefixAnchor(sidecar: string): string {
	const j = JSON.parse(stripBom(sidecar)) as Record<string, unknown>, s = firstStroke(j);
	const a = s?.lineAnchor as Record<string, unknown> | undefined;
	if (!a) throw new Error("A's first stroke has no anchor to replace");
	s!.lineAnchor = { ...a, ...PREFIX_ANCHOR };
	return JSON.stringify(j);
}

const f = (v: unknown, n = 2): string => typeof v === "number" ? v.toFixed(n) : String(v);
/**
 * A shift between two reads, and `px`: how far across the ink sits from its words there by the px of the phrase's line that
 * do not scale with the text (a named limit). The ink scales about the content's left by the text size ratio; the text scales
 * about its line's start (lineX), whose px part does not: px = ratio x lineX before - lineX after + (ratio - 1) x the ink's own
 * offset before, which is P x (ratio - 1) for P the line's fixed px. 0 at one size. Null when a read lacks the line.
 */
type Shift = { dx: number | null; dy: number | null; px: number | null };
function shift(from: any, to: any): Shift {
	const ok = (r: any) => r && typeof r.offX === "number" && typeof r.offY === "number";
	if (!ok(from) || !ok(to)) return { dx: null, dy: null, px: null };
	const ratio = to.fontZoom / from.fontZoom;
	const px = typeof from.lineX === "number" && typeof to.lineX === "number" && Number.isFinite(ratio)
		? ratio * from.lineX - to.lineX + (ratio - 1) * from.offX : null;
	return { dx: to.offX - from.offX, dy: to.offY - from.offY, px };
}
function line(tag: string, r: any): string {
	return `${tag.padEnd(9)} off ${f(r.offX)},${f(r.offY)} under "${r.under}" own "${r.own}" | canvas ${r.canvasMode} held ${r.columnHeld} capped ${r.columnCapped} ` +
		`colRef ${r.columnRefPx} fontRef ${r.fontRefPx} clientW ${r.clientW} font ${r.fontCss} fontZoom ${f(r.fontZoom, 4)} | anchor L${r.anchorLine} ` +
		`w ${r.anchorW} font ${r.anchorFont} dy ${f(r.dy)} sig ${r.sigW}/${r.sigFont}`;
}

for (const cell of CELLS) {
	it(cell.name, async () => {
		const errors: string[] = [], fails: string[] = [];
		const [canvasA, canvasB] = cell.canvasAB ?? [cell.canvas, cell.canvas];
		const devA: Dev = { ...A, ...cell.both, ...cell.a, canvas: canvasA };
		const devB: Dev = { ...A, ...cell.both, ...cell.b, ...(cell.a?.path ? { path: cell.a.path } : {}), canvas: canvasB };
		const a = await device(devA, false, { text: note(cell.block, cell.mid), pageId: null, sidecar: null }, [["draw"], ...(cell.aAfter ?? [])], errors);
		const drawn = a.rows[0];
		const bBytes = cell.prefixAnchor && a.bytes.sidecar ? { ...a.bytes, sidecar: withPrefixAnchor(a.bytes.sidecar) } : a.bytes;
		// switchFrom: B opens the plain note a 16 px desktop drew, then its pane switches to the cell's note.
		const from = cell.switchFrom ? await device({ ...A, canvas: canvasA }, false, { text: note("none"), pageId: null, sidecar: null }, [["draw"]], errors) : null;
		const b = from
			? await device({ ...devB, path: undefined }, !!cell.android, from.bytes, [["switchTo", { ...bBytes, path: cell.a!.path! }], ...(cell.bSteps ?? [])], errors)
			: await device(devB, !!cell.android, bBytes, cell.bSteps ?? [], errors, !!cell.scrollbars);
		if (from) { const sw = b.rows.shift(); b.open = sw; }
		const reopen = cell.bSteps ? await device(devA, false, b.bytes, [], errors) : null;
		// Every shift the cell reads, against A as drawn. A's own steps are read where they end (a size change: the arrived
		// layout, never a sample mid-change); typed text moves the reference to where A shows the ink after it.
		const shifts: [string, Shift][] = [["B open", shift(drawn, b.open)]];
		if (b.open.first && !cell.noFirst) shifts.push(["B first paint", shift(drawn, b.open.first)]);
		if (cell.bSteps && cell.check !== "edge") shifts.push(["B after", shift(drawn, b.rows.at(-1))]);
		if (reopen) { shifts.push(["A reopen", shift(drawn, reopen.open)]); if (reopen.open.first && !cell.noFirst) shifts.push(["A reopen first paint", shift(drawn, reopen.open.first)]); }
		if (cell.aAfter) shifts.push(["A self", shift(drawn, a.rows.at(-1))]);
		// For the record only, not asserted: the first paint as the older read inside a frame callback saw it.
		const inFrame: [string, Shift][] = [];
		if (b.open.first?.inFrame) inFrame.push(["B first paint, in frame", shift(drawn, b.open.first.inFrame)]);
		if (reopen?.open.first?.inFrame) inFrame.push(["A reopen first paint, in frame", shift(drawn, reopen.open.first.inFrame)]);
		const rows: [string, any][] = [["A drawn", drawn], ...a.rows.slice(1).map((r: any, i: number) => [`A step${i + 1}`, r] as [string, any]),
			["B first", b.open.first ?? {}], ["B open", b.open], ...b.rows.map((r: any, i: number) => [`B step${i + 1}`, r] as [string, any]),
			...(reopen ? [["A reopen", reopen.open] as [string, any]] : [])];
		const refsA = savedRefs(a.bytes.sidecar), refsB = cell.bSteps ? savedRefs(b.bytes.sidecar) : null;
		report.push({ cell: cell.name, devA, devB, shifts, inFrame, refsA, refsB, errors, rows });
		// eslint-disable-next-line no-console
		console.log(`ISSUE58FONT ${cell.name}: ` + [...shifts, ...inFrame].map(([t, s]) => `${t} ${f(s.dx)},${f(s.dy)} (px ${f(s.px)})`).join("; ") +
			`\n  refs A ${refsA}` + (refsB ? `\n  refs B ${refsB}` : "") + "\n  " + rows.map(([t, r]) => line(t, r)).join("\n  "));
		// eslint-disable-next-line no-console
		if (MEASURE) console.log(`FIRSTPAINT ${cell.name}\n  ${measureLine("B open", b.open)}` + (reopen ? `\n  ${measureLine("A reopen", reopen.open)}` : ""));
		if (errors.length) fails.push(`page errors ${JSON.stringify(errors)}`);
		if (drawn.strokes !== 1) fails.push(`A drew ${drawn.strokes} strokes, not 1`);
		// Every shift is read against A as drawn: A's own ink must sit on its words there.
		if (drawn.under !== drawn.own) fails.push(`A's ink is not on its words as drawn: under "${drawn.under}", phrase "${drawn.own}", off ${f(drawn.offX)},${f(drawn.offY)}; blocks at the pen ${JSON.stringify(drawn.blocksAtPen)}, after ${JSON.stringify(drawn.blocks)}; phrase line top, height map / page, at the pen ${JSON.stringify(drawn.topsAtPen)}, after ${JSON.stringify([drawn.cmTop, drawn.domTop])}`);
		for (const [t, s] of shifts) {
			if (s.dx === null || s.dy === null) { fails.push(`${t}: ink or phrase not read`); continue; }
			const w = cell.want, as = t.replace(/ first paint$/, "") === "B" ? "B open" : t.replace(/ first paint$/, "");
			// Across: the named limit, the line's fixed px times (ratio - 1), read per line; a named dx where the cell gives one.
			const on = typeof w === "object" && w.on.includes(as), wantDy = on ? w.dy : 0, wantDx = on && w.dx !== undefined ? w.dx : s.px ?? 0;
			if (Math.abs(s.dx - wantDx) >= 1 || Math.abs(s.dy - wantDy) >= 1) fails.push(`${t}: moved ${f(s.dx)},${f(s.dy)} (want ${f(wantDx)},${f(wantDy)}, under 1 px)`);
		}
		if (!b.open.first && !cell.noFirst) fails.push("B: no frame painted the opened ink");
		if (cell.want === "save" && refsB !== refsA) fails.push(`B's save rewrote A's refs:\n    A ${refsA}\n    B ${refsB}`);
		const last = a.rows.at(-1);
		// A's own size change keeps the anchor A drew: its width and size as drawn, honoured at the new size by the ratio,
		// never rewritten to pair the new size with a new width.
		if (cell.check === "layout" || cell.check === "content" || cell.check === "contact" || cell.check === "zoomed") {
			if (last.anchorW !== drawn.anchorW || last.anchorFont !== drawn.anchorFont) fails.push(`A's anchor rewritten by its own size change: ${drawn.anchorW}/${drawn.anchorFont} as drawn, ${last.anchorW}/${last.anchorFont} after`);
		}
		if (cell.check === "layout" && last.layoutFont !== last.fontCss) fails.push(`premise: the size change did not reach the layout read (${last.layoutFont} vs ${last.fontCss})`);
		if (cell.check === "content" && last.layoutAtSync !== last.layoutBefore) fails.push(`premise: the size change reached the layout read first (${last.layoutBefore} -> ${last.layoutAtSync} when the content's resize took it; settled ${last.layoutAfterChange})`);
		if (cell.check === "contact") {
			if (last.heldDown !== last.heldBefore) fails.push(`the column moved under the pen: ${last.heldBefore} -> ${last.heldDown} while down`);
			if (last.strokesAdded !== 1) fails.push(`the stroke drawn across the size change is ${last.strokesAdded} strokes, not 1`);
			if (last.fontDown !== "18px") fails.push(`premise: the size had not changed while the pen was down (${last.fontDown})`);
		}
		if (cell.check === "zoomed") {
			const z = a.rows.at(-3);
			if (!z.stepped || Math.abs(z.zoom - 3) > 0.01) fails.push(`premise: the note did not zoom to 300% (stepped ${z.stepped}, zoom ${z.zoom})`);
			const j = a.bytes.sidecar ? JSON.parse(stripBom(a.bytes.sidecar)) : null;
			const anchors: Array<{ width: number; fontPx: number }> = [];
			const walk = (o: unknown): void => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === "object") { const r = o as Record<string, unknown>; if (r.lineAnchor) anchors.push(r.lineAnchor as any); for (const k of Object.keys(r)) if (k !== "lineAnchor") walk(r[k]); } };
			walk(j);
			anchors.push({ width: last.anchorW, fontPx: last.anchorFont });
			for (const an of anchors) if (Math.abs(an.fontPx - 18) < 1e-3 && Math.abs(an.width - 805) <= 9) fails.push(`an anchor pairs the new size with the old width: ${an.width} at ${an.fontPx}`);
			// The size changed at 300%: back at 100% the column held for the ink is the drawn column moved by 18 / 16.
			const heldWant = drawn.columnHeld * 18 / 16;
			if (!(Math.abs(last.columnHeld - heldWant) < 0.5)) fails.push(`the held column after the zoomed size change is ${last.columnHeld}, not ${heldWant} (${drawn.columnHeld} x 18 / 16)`);
		}
		if (cell.check === "edge") {
			const e = b.rows.at(-1);
			if (!(e.sbw > 0)) fails.push(`premise: the scrollbar takes no room at the room edge (sbw ${e.sbw})`);
			if (e.changes > 2 || e.lastChange >= 10) fails.push(`the held column did not settle at the room edge: ${e.changes} changes, last at frame ${e.lastChange}: ${JSON.stringify(e.seen)}`);
		}
		if (cell.aAfter?.some(s => s[0] === "attachFirst")) {
			const at = a.rows.at(-1);
			if (at.attached !== 1) fails.push(`premise: A's group not recorded (${at.attached})`);
			if (b.open.groups !== 1) fails.push(`B shows ${b.open.groups} attached groups, not 1`);
		}
		expect(fails, fails.join("\n")).toEqual([]);
	}, 180_000);
}
