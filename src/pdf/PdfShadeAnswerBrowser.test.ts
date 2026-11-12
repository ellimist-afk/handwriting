import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

declare const process: { env: Record<string, string | undefined>; cwd(): string; platform: string };

/**
 * More answers from the dark-page read on real canvases in Chromium, beside
 * PdfPageShadeBrowser.test.ts: pages where a cheaper read would answer wrong.
 *
 * - A light text page whose glyph pitch falls on the read's grid reads light:
 *   a read that samples single points on a coarse grid lands in a glyph every
 *   time and reads it dark.
 * - A dark page reads dark at large canvas sizes too: a read that gives up on
 *   large canvases and answers light passes every small-canvas cell.
 * - A dark page answers dark in the call that reads it: the caller keeps the
 *   first answer for the canvas, so a read that answers later is never asked
 *   again.
 * - Two canvases of one size get their own answers: an answer kept by size
 *   would hand the first page's answer to the next.
 * - A page answers as its mean does. A black band from one edge on white, in
 *   1% steps along each axis at two page sizes, reads light from 30 to 45% of
 *   the page and dark from 55 to 70%: a coarse grid of patches counts the band
 *   by whole columns and turns far from the middle. 46 to 54% is not asserted:
 *   the read before the freeze fix turned at 53%, by where its patch columns
 *   sat.
 * - Black stripes 8 px apart on white, along each axis at every one of the 8
 *   offsets, read light 2 px wide and dark 6 px wide: a read that takes one
 *   point per stripe period sees the same place in every period and answers by
 *   the offset.
 *
 * Opt in under the same guard as the other browser suites here: CX5_BROWSER=1.
 */

/** A GPU canvas where the machine has one, as a page canvas is drawn in the app. */
const GPU_ARGS = process.platform === "win32" ? ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-angle=d3d11"] : [];

const SCENES = `
// Obsidian's global createEl, which the read makes its sample canvas with; a plain Chromium page has none.
window.createEl = (tag) => document.createElement(tag);
// An opaque page canvas of one colour, as the viewer draws a page.
window.solid = (color, w, h) => {
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	const ctx = c.getContext("2d", { alpha: false });
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, w, h);
	return c;
};
// White, with #202020 glyphs 8 x 12 at a pitch of 11 across and 24 down from (35, 40).
window.alignedText = (w, h) => {
	const c = window.solid("#ffffff", w, h);
	const ctx = c.getContext("2d");
	ctx.fillStyle = "#202020";
	for (let y = 40; y + 12 < h; y += 24) for (let x = 35; x + 8 < w; x += 11) ctx.fillRect(x, y, 8, 12);
	return c;
};
window.solidDark = (color, w, h) => window.readCanvasDark(window.solid(color, w, h));
window.textDark = (w, h) => window.readCanvasDark(window.alignedText(w, h));
window.twoCanvases = (w, h) => {
	const white = window.solid("#ffffff", w, h);
	const black = window.solid("#000000", w, h);
	return [window.readCanvasDark(white), window.readCanvasDark(black)];
};
// Read a canvas, then let its pixels go: the sweeps make many large canvases.
window.readAndRelease = (c) => {
	const dark = window.readCanvasDark(c);
	c.width = 0;
	c.height = 0;
	return dark;
};
// White, with a black band from the left edge ("x") or the top edge ("y") over pct percent of that side, whole pixels.
window.band = (axis, pct, w, h) => {
	const c = window.solid("#ffffff", w, h);
	const ctx = c.getContext("2d");
	ctx.fillStyle = "#000000";
	if (axis === "x") ctx.fillRect(0, 0, Math.round((pct / 100) * w), h);
	else ctx.fillRect(0, 0, w, Math.round((pct / 100) * h));
	return c;
};
// Every asserted step of the band sweep at w x h, each axis: 30 to 45% wants light, 55 to 70% dark.
window.bandSweep = (w, h) => {
	const out = [];
	for (const axis of ["x", "y"]) {
		for (let pct = 30; pct <= 70; pct++) {
			if (pct > 45 && pct < 55) continue;
			out.push({ step: axis + " " + pct + "%", dark: window.readAndRelease(window.band(axis, pct, w, h)), want: pct >= 55 });
		}
	}
	return out;
};
// White, with black stripes \`width\` px wide every 8 px from \`offset\`, across ("x": columns) or down ("y": rows).
window.stripes = (axis, width, offset, side) => {
	const c = window.solid("#ffffff", side, side);
	const ctx = c.getContext("2d");
	ctx.fillStyle = "#000000";
	for (let at = offset - 8; at < side; at += 8) {
		if (axis === "x") ctx.fillRect(at, 0, width, side);
		else ctx.fillRect(0, at, side, width);
	}
	return c;
};
// Every step of the stripe sweep at side x side, each axis, all 8 offsets: 2 px wide wants light, 6 px wide dark.
window.stripeSweep = (side) => {
	const out = [];
	for (const axis of ["x", "y"]) {
		for (const width of [2, 6]) {
			for (let offset = 0; offset < 8; offset++) {
				out.push({ step: axis + " " + width + " px wide from " + offset, dark: window.readAndRelease(window.stripes(axis, width, offset, side)), want: width === 6 });
			}
		}
	}
	return out;
};
`;

type Step = { step: string; dark: boolean | null; want: boolean };
/** The steps that answered other than they should, named, with what they answered. */
const wrongSteps = (steps: Step[]) => steps.filter((s) => s.dark !== s.want).map((s) => `${s.step} read ${s.dark === null ? "null" : s.dark ? "dark" : "light"}`);

describe.skipIf(process.env.CX5_BROWSER !== "1")("PDF page shade read, answers a cheaper read gets wrong, in a real browser", () => {
	let browser: Browser;
	let page: Page;
	beforeAll(async () => {
		const bundled = await build({
			stdin: {
				contents: `import { readCanvasDark } from "./src/pdf/PdfViewerProbe";\n(window as any).readCanvasDark = readCanvasDark;\n`,
				resolveDir: process.cwd(),
				loader: "ts",
			},
			bundle: true,
			write: false,
			format: "iife",
			platform: "browser",
		});
		browser = await chromium.launch({ headless: true, args: GPU_ARGS });
		page = await browser.newPage({ viewport: { width: 800, height: 600 } });
		await page.setContent("<html><body></body></html>");
		await page.addScriptTag({ content: bundled.outputFiles[0]!.text });
		await page.addScriptTag({ content: SCENES });
		console.log(`Shade answer browser: ${browser.version()}`);
	}, 60_000);
	afterAll(async () => {
		await browser?.close();
	});

	const solidDark = (color: string, w: number, h: number) =>
		page.evaluate(([c, cw, ch]) => (window as any).solidDark(c, cw, ch) as boolean | null, [color, w, h] as const);

	it("a light text page whose glyph pitch falls on the read's grid reads light, 1232 x 1536", async () => {
		const dark = await page.evaluate(([w, h]) => (window as any).textDark(w, h) as boolean | null, [1232, 1536] as const);
		expect(dark, "a light text page read dark: the read samples points, not patches").toBe(false);
	});

	it("#777777 reads dark at 2462 x 3194 and at 4000 x 4000", async () => {
		expect(await solidDark("#777777", 2462, 3194), "a dark page read light at 2462 x 3194").toBe(true);
		expect(await solidDark("#777777", 4000, 4000), "a dark page read light at 4000 x 4000").toBe(true);
	});

	it("a black page canvas of 2051 x 2660 answers dark in the call that reads it", async () => {
		expect(await solidDark("#000000", 2051, 2660), "a dark page did not answer dark in the call that read it").toBe(true);
	});

	it("two canvases of one size, white then black, get their own answers", async () => {
		const answers = await page.evaluate(([w, h]) => (window as any).twoCanvases(w, h) as (boolean | null)[], [1231, 1597] as const);
		expect(answers, "the second canvas got the first one's answer").toEqual([false, true]);
	});

	for (const [w, h] of [
		[1231, 1597],
		[2462, 3194],
	] as const) {
		it(`a black band from one edge on white reads as its share of the page, each axis, ${w} x ${h}: 30 to 45% light, 55 to 70% dark`, async () => {
			const steps = await page.evaluate(([cw, ch]) => (window as any).bandSweep(cw, ch) as Step[], [w, h] as const);
			expect(steps.length, "precondition: the band sweep did not make 64 steps").toBe(64);
			expect(wrongSteps(steps), `a band page at ${w} x ${h} read other than its mean`).toEqual([]);
		}, 60_000);
	}

	it("black stripes 8 px apart on white, each axis, all 8 offsets, 2048 x 2048: 2 px wide light, 6 px wide dark", async () => {
		const steps = await page.evaluate((side) => (window as any).stripeSweep(side) as Step[], 2048);
		expect(steps.length, "precondition: the stripe sweep did not make 32 steps").toBe(32);
		expect(wrongSteps(steps), "a striped page read other than its mean: the read takes one point per stripe period").toEqual([]);
	}, 60_000);
});
