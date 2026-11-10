/**
 * Editable colour slots (1.5.0), in a real browser canvas.
 *
 * 1. Saved ink never changes how it looks: a stroke drawn in a slot's colour
 *    paints pixel for pixel the same after that slot is edited.
 * 2. A custom near-white and a custom near-black slot are readable when the
 *    ink lands on a known page: drawn onto a white page and onto a dark page
 *    with the export readability setting on, the painted colour reaches
 *    EXPORT_MIN_CONTRAST on both - the contrast readableInkColor promises,
 *    which it meets with the smallest move past it. Screen paint with no
 *    known page stays the stored colour, byte for byte; a white pick on a
 *    light theme is the user's choice.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { launch, type Browser } from "./harness";
import { EXPORT_MIN_CONTRAST, contrastRatio, relativeLuminance } from "../../src/ink/InkTheme";

let browser: Browser;
let script: string;
beforeAll(async () => {
	browser = await launch();
	const result = await build({
		stdin: {
			contents: `
import { installObsidianDom } from './test/render/obsidianDom';
installObsidianDom();
import { StrokeBuilder } from './src/ink/StrokeBuilder';
import { drawStroke } from './src/ink/StrokeRenderer';
import { PEN_COLORS, colorsFor, setInkPalette, setInkPaletteSlot } from './src/ink/InkColor';
import { setInkExportReadability, withInkDestination } from './src/ink/InkTheme';
const W = 300, H = 120, cam = { x: 0, y: 0, zoom: 2 };
const stroke = (hex) => {
	const b = new StrokeBuilder('pen', hex, 8);
	b.start(0);
	for (let i = 0; i < 20; i++) b.add(20 + i * 6, 30, 0.6, i * 8, 0, 0);
	return b.finish();
};
const paint = (s, page) => {
	const c = document.createElement('canvas'); c.width = W; c.height = H;
	const ctx = c.getContext('2d');
	if (page) { ctx.fillStyle = page; ctx.fillRect(0, 0, W, H); }
	if (page) withInkDestination(page, () => drawStroke(ctx, cam, s, undefined, true, false));
	else drawStroke(ctx, cam, s, undefined, true, false);
	return ctx.getImageData(0, 0, W, H).data;
};
const reset = () => setInkPalette('pen', PEN_COLORS.map((c) => c.hex));
window.oldInk = () => {
	reset();
	const s = stroke(PEN_COLORS[4].hex);
	const before = paint(s, null);
	setInkPaletteSlot('pen', 4, '#aa0011');
	const after = paint(s, null);
	reset();
	let diff = 0, ink = 0;
	for (let i = 0; i < before.length; i++) { if (before[i] !== after[i]) diff++; if (i % 4 === 3 && before[i]) ink++; }
	return { diff, ink };
};
// One pixel inside the stroke, on a page and with no page known (screen
// paint). The stroke runs from x 40 to 268 on row 60 at zoom 2 and is 16 px
// wide there, so (150, 60) is ink on both, never page or antialiased edge.
// Not "the most opaque pixel": with a page under it every pixel is opaque.
window.onPage = (hex, page) => {
	reset();
	setInkExportReadability(true);
	setInkPaletteSlot('pen', 3, hex);
	const s = stroke(colorsFor('pen')[3].hex);
	const pick = (data) => {
		const at = (60 * W + 150) * 4;
		return [data[at], data[at + 1], data[at + 2], data[at + 3]];
	};
	const onPage = pick(paint(s, page));
	const screen = pick(paint(s, null));
	reset();
	return { onPage, screen, stored: s.color };
};
`,
			resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
			loader: "ts",
		},
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) },
	});
	script = result.outputFiles[0]!.text;
});
afterAll(async () => {
	await browser?.close();
});

const open = async () => {
	const page = await browser.newPage({ viewport: { width: 400, height: 200 }, deviceScaleFactor: 1 });
	await page.setContent("<div></div>");
	await page.addScriptTag({ content: script });
	return page;
};

it("a stroke drawn in a slot's colour paints the same pixels after that slot is edited", async () => {
	const page = await open();
	try {
		const r = await page.evaluate(() => (window as any).oldInk());
		expect(r.ink, "the stroke painted nothing").toBeGreaterThan(100);
		expect(r.diff, "pixels changed under saved ink").toBe(0);
	} finally {
		await page.close();
	}
});

const lum = ([r, g, b]: number[]): number => relativeLuminance(r!, g!, b!);
const hexRgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

it.each([
	["near-white", "#fafafa"],
	["near-black", "#050505"],
])("a custom %s slot is readable on a white page and on a dark page", async (_label, hex) => {
	const page = await open();
	try {
		for (const bg of ["#ffffff", "#1e1e1e"]) {
			const r = await page.evaluate(([h, p]) => (window as any).onPage(h, p), [hex, bg]);
			// The sample spot is ink: with no page under it, it is fully covered by the stroke.
			expect(r.screen[3], `premise: (150, 60) is inside the stroke (${JSON.stringify(r)})`).toBe(255);
			expect(r.onPage[3], `${hex} on ${bg}: nothing painted`).toBe(255);
			const ratio = contrastRatio(lum(r.onPage), lum(hexRgb(bg)));
			// The measured number goes in the log on a pass too; the handback quotes it.
			console.log(`contrast ${hex} on ${bg}: ${ratio.toFixed(3)}`);
			expect(ratio, `${hex} on ${bg}: painted rgb(${r.onPage.slice(0, 3)}), contrast ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
				EXPORT_MIN_CONTRAST
			);
			// With no page known (the screen), the stored colour is what paints.
			expect(r.stored).toBe(hex);
			expect(r.screen.slice(0, 3), `${hex}: screen paint was adjusted`).toEqual(hexRgb(hex));
		}
	} finally {
		await page.close();
	}
});
