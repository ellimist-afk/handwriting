/**
 * Contract cell 1 (cells 2 and 3, and the "mounted at a zoomed font" /
 * "reload while zoomed" arms, are covered in the other paper files). Written
 * against cc62734a: the paper must scale with
 * the SAME factor as the ink (cssScale x fontZoom) - today the pitch ignores
 * fontZoom entirely (InkOverlay.ts's own comment: "Font size does not scale
 * CSS backgrounds, so the font zoom is not in it").
 *
 * THE PITCH IS ONE PLAIN BODY ROW of the text: the content's computed line
 * height, read where the font is read. The rule and dot thickness still follow
 * font-size / 16. So the paper scales with the text when the text's ROWS scale
 * with it, as they do in Obsidian (line-height 1.5 x the font size). This
 * harness's own theme pins `.cm-content` line-height to a fixed 24px at every
 * font size (noteViewportCameraPage.ts's `setup()`): left that way, a font
 * change moves no row and the pitch rightly stays put, which says nothing
 * about following the text. So both cells put Obsidian's own unitless 1.5 back
 * on the content (ROW_SCALES_WITH_TEXT) and read the row off the page.
 * The premise for "the text grew" is ten monospace characters' own glyph
 * width, the same font-size ratio the overlay's fontZoomFactor measures.
 *
 * Reuses the existing camera fixture - `viewportFixture.setup`/`edgeAudit.
 * commit` drive the real overlay; every assertion here is computed style,
 * never an internal field, so the cell does not depend on how the fix is
 * implemented.
 *
 * 1a: a LIVE font-zoom-only change (16px -> 20px, no pinch), the row moving
 *     with it, scales lined, grid and dots paper by the row's own ratio (the
 *     same 1.25x the glyphs grew), and the rule by the font-size ratio - the
 *     premises (the text and its row really grew) are asserted first.
 * 1b: MOUNTED directly at font 1.25 (20px, no live change), commit z 0.5:
 *     the screen pitch is the row read off the page x 0.5, all three styles.
 *     Deliberately mount-time, not built up from a live change: this is the
 *     "mounted at an already-zoomed font" case, which a mount-relative
 *     implementation would get wrong.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";

let browser: Browser, script: string;
const OBSIDIAN_CAMERA_CSS = readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8");

beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./noteViewportCameraPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => { await browser?.close(); });

/** The fixture's own default text (NOT an empty doc): this cell measures
 * glyph WIDTH growth, which needs real characters on the line. `kind` selects
 * the body class; `font` is the mount-time font multiplier `setup` already
 * takes (its own `.cm-content` fontSize is `16 * font`px). One far ink stroke
 * (the "far" kind) so Fit has something to frame, matching the other paper
 * cells' convention - irrelevant to this cell but harmless. */
/** Obsidian's own row: line-height 1.5 x the font size, over the fixture theme's fixed 24px, so the row moves with the
 * text. In place before the mount, so the 1b mount-time read sees it. */
const ROW_SCALES_WITH_TEXT = ".camera-proof .cm-content { line-height: 1.5 !important; }";

async function mountPaper(p: Page, kind: "lines" | "grid" | "dots", font = 1, id = "paper") {
	await p.setContent(`<!doctype html><body class="handwriting-paper-${kind}" style="margin:0; background:#ffffff; --background-modifier-border:#777777"></body>`);
	await p.addStyleTag({ content: css + OBSIDIAN_CAMERA_CSS + ROW_SCALES_WITH_TEXT });
	await p.addScriptTag({ content: script });
	await p.evaluate(({ id, font }) => (window as any).viewportFixture.setup(id, "far", font), { id, font });
}

/** The on-screen WIDTH of the first 10 characters of text, read fresh each
 * call (no caching, so a live font change is reflected).
 *
 * NOT the `.cm-line` element's own box, and NOT line HEIGHT:
 *  - line height is the paper's pitch here, the thing under test, and this
 *    cell sets it itself (ROW_SCALES_WITH_TEXT); it cannot also be the
 *    independent proof that the text grew. It is read separately (rowPx).
 *  - the fixture wraps text at a fixed 640 LAYOUT px content width
 *    (`EditorView.lineWrapping` + the theme's `width:"640px"`), so the
 *    rendered `.cm-line` BOX width stays clamped to that container - a
 *    bigger font fits fewer characters per visual line, not a wider box.
 * A `Range` over the first 10 characters of the (monospace) text sidesteps
 * both: `fontZoom` itself is measured from fontSize alone (InkOverlay.ts's
 * `fontZoomFactor(fontSize, refFontPx)`), and ten monospace characters' own
 * advance width scales with it directly, well inside the wrap width at every
 * font size this cell uses. */
const glyphSpanWidthPx = (p: Page): Promise<number> =>
	p.evaluate(() => {
		const line = document.querySelector(".camera-proof .cm-line")!;
		// Walk to the first real text node rather than assuming `firstChild` is
		// one - robust whether the line renders as a bare text node or wraps it
		// in a span.
		const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
		const textNode = walker.nextNode() as Text | null;
		if (!textNode) throw new Error("no text node found in the first .cm-line - the fixture's default doc changed shape");
		const range = document.createRange();
		range.setStart(textNode, 0);
		range.setEnd(textNode, Math.min(10, textNode.length));
		return range.getBoundingClientRect().width;
	});

/** Lined/grid paper's pitch and rule in LAYOUT px, straight off the custom
 * properties `updatePaperSpacing` writes on `.cm-editor` - never an internal
 * field, just the two CSS variables the gradients themselves consume. */
const readPitchRuleLayout = (p: Page): Promise<{ pitchLayout: number; ruleLayout: number }> =>
	p.evaluate(() => {
		const host = document.querySelector(".cm-editor") as HTMLElement;
		return {
			// NaN when unwritten, never a stand-in number: a default would hide a paper the overlay never planned.
			pitchLayout: Number.parseFloat(host.style.getPropertyValue("--handwriting-paper-pitch")),
			ruleLayout: Number.parseFloat(host.style.getPropertyValue("--handwriting-paper-rule")),
		};
	});

/** Dots: the rendering claim is the computed `background-size` itself (one
 * pitch square), in the scroller's own layout px (the zoomed ancestor scales
 * the whole visual result, exactly as it does for the gradient-based styles). */
const readDotsSizeLayout = (p: Page): Promise<{ w: number; h: number }> =>
	p.evaluate(() => {
		const s = getComputedStyle(document.querySelector(".cm-scroller")!).backgroundSize;
		const [w, h] = s.split(" ").map(v => Number.parseFloat(v));
		return { w: w ?? Number.NaN, h: h ?? Number.NaN };
	});

/** One plain body row in layout px, read the way the overlay plans the pitch: the content's px line height, else a
 * plain line box's height, to 1/64 px. */
const rowPx = (p: Page): Promise<number> =>
	p.evaluate(() => {
		const c = document.querySelector(".camera-proof .cm-content") as HTMLElement, lh = getComputedStyle(c).lineHeight;
		const line = c.querySelector(".cm-line") as HTMLElement | null;
		const row = /px$/.test(lh.trim()) ? Number.parseFloat(lh) : line ? line.offsetHeight : Number.NaN;
		return Math.round(row * 64) / 64;
	});

const setFontSizePx = (p: Page, px: number): Promise<void> =>
	p.evaluate(px => {
		const el = document.querySelector(".camera-proof .cm-content") as HTMLElement;
		el.style.fontSize = `${px}px`;
	}, px).then(() => p.evaluate(() => (window as any).viewportFixture.settle()));

it("1a: a live font-zoom-only change scales lined, grid and dots paper by the text's own growth factor", async () => {
	for (const kind of ["lines", "grid", "dots"] as const) {
		const p = await browser.newPage();
		try {
			await mountPaper(p, kind, 1);
			await p.evaluate(() => (window as any).edgeAudit.commit("paper", 1));
			const before = kind === "dots" ? await readDotsSizeLayout(p) : await readPitchRuleLayout(p);
			const lineBefore = await glyphSpanWidthPx(p), rowBefore = await rowPx(p);

			// LIVE font-zoom change, no pinch: 16px -> 20px (1.25x), a plain
			// style write plus a settle - the same shape a real ctrl+wheel
			// takes (it resizes `.cm-content`, which fires contentResizeObserver
			// into `fontZoomFactor`). The row follows through the cell's 1.5.
			await setFontSizePx(p, 20);

			const lineAfter = await glyphSpanWidthPx(p), rowAfter = await rowPx(p);
			const lineRatio = lineAfter / lineBefore, rowRatio = rowAfter / rowBefore;
			// PREMISES: the text itself really did grow, and its row with it, before any paper claim.
			expect(lineRatio, `[${kind}] premise failed - line width did not grow (before=${lineBefore}, after=${lineAfter})`).toBeCloseTo(1.25, 1);
			expect(rowRatio, `[${kind}] premise failed - the row did not grow with the text (before=${rowBefore}, after=${rowAfter}, lineRatio=${lineRatio})`).toBeCloseTo(lineRatio, 1);

			if (kind === "dots") {
				const after = await readDotsSizeLayout(p);
				const wRatio = after.w / (before as { w: number; h: number }).w;
				const hRatio = after.h / (before as { w: number; h: number }).h;
				expect(wRatio, `[dots] background-size width did not scale with the text's row (before=${(before as any).w} after=${after.w} rowRatio=${rowRatio})`).toBeCloseTo(rowRatio, 1);
				expect(hRatio, `[dots] background-size height did not scale with the text's row (before=${(before as any).h} after=${after.h} rowRatio=${rowRatio})`).toBeCloseTo(rowRatio, 1);
			} else {
				const after = await readPitchRuleLayout(p);
				const pitchRatio = after.pitchLayout / (before as { pitchLayout: number; ruleLayout: number }).pitchLayout;
				const ruleRatio = after.ruleLayout / (before as { pitchLayout: number; ruleLayout: number }).ruleLayout;
				expect(pitchRatio, `[${kind}] pitch did not scale with the text's row (before=${(before as any).pitchLayout} after=${after.pitchLayout} rowRatio=${rowRatio})`).toBeCloseTo(rowRatio, 1);
				// The rule's thickness follows the font size, not the row.
				expect(ruleRatio, `[${kind}] rule did not scale with the text (before=${(before as any).ruleLayout} after=${after.ruleLayout} lineRatio=${lineRatio})`).toBeCloseTo(lineRatio, 1);
			}
		} finally {
			await p.close();
		}
	}
});

it("1b: combined pinch x font at rest - commit z 0.5 with font already at 1.25x gives the text's row x 0.5 screen px spacing, all three styles", async () => {
	const z = 0.5;
	for (const kind of ["lines", "grid", "dots"] as const) {
		const p = await browser.newPage();
		try {
			await mountPaper(p, kind, 1.25);
			// Sanity the mount-time font actually landed before trusting the
			// paper claim on top of it.
			const fontSizePx = await p.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector(".camera-proof .cm-content")!).fontSize));
			expect(fontSizePx, `[${kind}] mount-time font did not reach 1.25x (16px base): got ${fontSizePx}px`).toBeCloseTo(20, 0);

			await p.evaluate(z => (window as any).edgeAudit.commit("paper", z), z);
			// The row at the mounted text size, read off the page: the screen pitch is that row at the committed zoom.
			const row = await rowPx(p), expectedScreen = row * z;
			expect(Number.isFinite(row) && row > 0, `[${kind}] premise: a row height was read off the page (${row})`).toBe(true);

			if (kind === "dots") {
				const { w, h } = await readDotsSizeLayout(p);
				expect(w * z, `[dots] screen background-size width: layout=${w} z=${z}`).toBeCloseTo(expectedScreen, 0);
				expect(h * z, `[dots] screen background-size height: layout=${h} z=${z}`).toBeCloseTo(expectedScreen, 0);
			} else {
				const { pitchLayout } = await readPitchRuleLayout(p);
				const screen = pitchLayout * z;
				expect(screen, `[${kind}] screen pitch: layout=${pitchLayout} z=${z}, row ${row}`).toBeCloseTo(expectedScreen, 0);
			}
		} finally {
			await p.close();
		}
	}
});
