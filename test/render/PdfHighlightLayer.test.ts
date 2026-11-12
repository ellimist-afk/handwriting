/**
 * Composite pixels of PDF highlights: the page's text stays dark under a
 * highlight, crossings and the live stroke are one flat wash, the lift changes
 * nothing, pen ink keeps its colour, dark pages, and the snip.
 *
 * A PDF page stand-in (test/render/pdfHighlightPage.ts): an opaque page canvas
 * with a glyph block, the shipped stylesheet and the real controller. Each
 * cell screenshots the page and reads composited pixels, in the pattern of
 * SlidesHighlighter.test.ts. Yellow is HIGHLIGHTER_HEX (255, 214, 10) and the
 * wash is HIGHLIGHTER_ALPHA, 0.35.
 *
 * Arithmetic: a group at
 * opacity a blended multiply over a backdrop b with an opaque colour s gives
 * b(1 - a + a s): black text stays black, white paper takes today's colour.
 * Today's plain wash is b(1 - a) + a s.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { launch, stylesCss } from "./harness";
import type {} from "./pdfHighlightPage";
import type { Pt, RGB } from "./penMarks";
declare const process: { env: Record<string, string | undefined> };

let browser: Browser, bundle: string;
beforeAll(async () => {
	const result = await build({
		entryPoints: [fileURLToPath(new URL("./pdfHighlightPage.ts", import.meta.url))],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) },
	});
	bundle = result.outputFiles[0]!.text;
	browser = await launch();
});
afterAll(async () => {
	await browser?.close();
});

const A = 0.35;
const yellow: RGB = [255, 214, 10];
const white: RGB = [255, 255, 255];
const dark: RGB = [30, 30, 30];
const gap = (a: RGB, b: RGB) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
const multiplied = (b: RGB) => b.map((v, i) => v * (1 - A + (A * yellow[i]!) / 255)) as RGB;
const plainWash = (b: RGB) => b.map((v, i) => v * (1 - A) + A * yellow[i]!) as RGB;

/** The horizontal saved highlight runs along y = 300, across the glyph (200..260, 285..315). */
const P = {
	glyph: { x: 230, y: 300 },
	paperUnder: { x: 380, y: 300 },
	paper: { x: 380, y: 500 },
	crossing: { x: 330, y: 300 },
	verticalOnly: { x: 330, y: 240 },
	horizontalOnly: { x: 380, y: 300 },
} satisfies Record<string, Pt>;

async function open(darkPage = false, assumption: "darken" | "lighten" | "keep" = "darken", dpr = 1): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 700, height: 900 }, deviceScaleFactor: dpr });
	page.on("console", (m) => console.log(`page: ${m.text()}`));
	await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
	await page.addStyleTag({ content: stylesCss() });
	await page.addScriptTag({ content: bundle });
	await page.evaluate(([d, a]) => window.pdfHighlight.open(d as boolean, a as "darken"), [darkPage, assumption] as const);
	return page;
}

async function pixels(page: Page, points: Record<string, Pt>, label: string, r = 2): Promise<Record<string, RGB>> {
	const directory = process.env.PDF_HIGHLIGHT_EVIDENCE;
	const png = await page.screenshot({ scale: "css", path: directory ? `${directory}/${label}.png` : undefined });
	const result = await page.evaluate(
		({ b64, points, r }) => window.pdfHighlight.sample(b64, { x: 0, y: 0 }, points, r),
		{ b64: png.toString("base64"), points, r }
	);
	const layers = await page.evaluate(() => window.pdfHighlight.layers());
	console.log(`PDF_HIGHLIGHT ${label} ${JSON.stringify(result)} layers ${JSON.stringify(layers)}`);
	return result;
}

const horizontal = { tool: "highlighter" as const, a: { x: 120, y: 300 }, b: { x: 440, y: 300 } };
const vertical = { tool: "highlighter" as const, a: { x: 330, y: 200 }, b: { x: 330, y: 420 } };

describe("PDF highlights: one wash, the page's text stays dark", () => {
	it("R1: a black glyph pixel under one saved highlight stays black (max channel 20 or less)", async () => {
		const page = await open();
		try {
			await page.evaluate((h) => window.pdfHighlight.save([h]), horizontal);
			const s = await pixels(page, P, "r1");
			expect(Math.max(...s.glyph!), `glyph under the highlight ${s.glyph}`).toBeLessThanOrEqual(20);
			// White paper takes today's colour.
			expect(gap(s.paperUnder!, multiplied(white)), `paper under the highlight ${s.paperUnder}`).toBeLessThanOrEqual(3);
			expect(gap(s.paper!, white)).toBeLessThanOrEqual(2);
		} finally {
			await page.close();
		}
	});

	it("R2: two crossing saved highlights: the crossing and a once-covered pixel differ by 2 or less a channel", async () => {
		const page = await open();
		try {
			await page.evaluate(([h, v]) => window.pdfHighlight.save([h, v]), [horizontal, vertical] as const);
			const s = await pixels(page, P, "r2");
			// The marks are on screen at all: a page with nothing painted is flat too.
			expect(gap(s.horizontalOnly!, multiplied(white)), `once-covered paper ${s.horizontalOnly}`).toBeLessThanOrEqual(3);
			expect(gap(s.verticalOnly!, multiplied(white)), `once-covered paper ${s.verticalOnly}`).toBeLessThanOrEqual(3);
			expect(gap(s.crossing!, s.horizontalOnly!), `crossing ${s.crossing} once ${s.horizontalOnly}`).toBeLessThanOrEqual(2);
			expect(gap(s.crossing!, s.verticalOnly!), `crossing ${s.crossing} once ${s.verticalOnly}`).toBeLessThanOrEqual(2);
		} finally {
			await page.close();
		}
	});

	it("R3: a highlighter held across a saved highlight is one wash with it, and the lift changes no pixel", async () => {
		const page = await open();
		try {
			await page.evaluate((h) => window.pdfHighlight.save([h]), horizontal);
			await page.evaluate(([a, b]) => window.pdfHighlight.hold("highlighter", a, b), [vertical.a, vertical.b] as const);
			const held = await pixels(page, P, "r3-held");
			expect(gap(held.crossing!, held.horizontalOnly!), `held crossing ${held.crossing} saved only ${held.horizontalOnly}`).toBeLessThanOrEqual(2);
			expect(gap(held.crossing!, held.verticalOnly!), `held crossing ${held.crossing} live only ${held.verticalOnly}`).toBeLessThanOrEqual(2);
			await page.evaluate(() => window.pdfHighlight.lift());
			const after = await pixels(page, P, "r3-lifted");
			for (const key of Object.keys(P)) {
				expect(gap(after[key]!, held[key]!), `${key} before the lift ${held[key]} after ${after[key]}`).toBeLessThanOrEqual(2);
			}
		} finally {
			await page.close();
		}
	});

	it("R4: a highlighter held for several samples: the pixels behind the nib match the trail (no darker dot)", async () => {
		const page = await open();
		try {
			// Along y = 560, clear of the glyph and the saved marks; held at x = 420.
			await page.evaluate(() => window.pdfHighlight.hold("highlighter", { x: 140, y: 560 }, { x: 420, y: 560 }));
			const points: Record<string, Pt> = { mid: { x: 220, y: 560 } };
			for (let x = 340; x <= 412; x += 8) points[`head${x}`] = { x, y: 560 };
			const s = await pixels(page, points, "r4-held", 0);
			expect(gap(s.mid!, white), `the trail shows no wash ${s.mid}`).toBeGreaterThanOrEqual(40);
			for (const [key, v] of Object.entries(s)) {
				if (key === "mid") continue;
				expect(gap(v, s.mid!), `${key} ${v} against the mid trail ${s.mid}`).toBeLessThanOrEqual(2);
			}
			await page.evaluate(() => window.pdfHighlight.lift());
		} finally {
			await page.close();
		}
	});

	it("R5 (control): pen ink over a highlight reads its own colour, and a pen drawn after a highlighter shows over saved pen ink", async () => {
		const page = await open();
		try {
			await page.evaluate(
				([h]) =>
					window.pdfHighlight.save([
						h,
						{ tool: "pen", a: { x: 300, y: 220 }, b: { x: 300, y: 420 }, color: "#000000" },
						{ tool: "pen", a: { x: 360, y: 220 }, b: { x: 360, y: 420 }, color: "#d02020" },
					]),
				[horizontal] as const
			);
			const s = await pixels(page, { black: { x: 300, y: 300 }, red: { x: 360, y: 300 } }, "r5-saved", 0);
			expect(gap(s.black!, [0, 0, 0]), `black pen over the highlight ${s.black}`).toBeLessThanOrEqual(12);
			expect(gap(s.red!, [208, 32, 32]), `red pen over the highlight ${s.red}`).toBeLessThanOrEqual(12);
			// A highlighter stroke, lifted, then a pen held across the saved black pen ink.
			await page.evaluate(() => window.pdfHighlight.hold("highlighter", { x: 120, y: 650 }, { x: 440, y: 650 }));
			await page.evaluate(() => window.pdfHighlight.lift());
			await page.evaluate(() => window.pdfHighlight.hold("pen", { x: 260, y: 400 }, { x: 340, y: 400 }, "#1060e0"));
			const live = await pixels(page, { over: { x: 300, y: 400 } }, "r5-live-pen", 0);
			// The live pen is thinner than the saved one, so the sampled pixel is part covered (0.75 at
			// 0ffa3c71 as here): it must read as the live colour over the black it covers, at some coverage k,
			// not as the black, and not washed.
			const k = live.over![2] / 224;
			expect(k, `live pen over saved pen ink ${live.over}`).toBeGreaterThanOrEqual(0.5);
			expect(gap(live.over!, [16 * k, 96 * k, 224 * k]), `live pen over saved pen ink ${live.over}`).toBeLessThanOrEqual(3);
			await page.evaluate(() => window.pdfHighlight.lift());
		} finally {
			await page.close();
		}
	});

	it("R6: a page the file draws dark keeps today's plain wash, under the default and under the dark-page setting", async () => {
		const tinted = await open(true, "darken");
		try {
			await tinted.evaluate((h) => window.pdfHighlight.save([h]), horizontal);
			const s = await pixels(tinted, P, "r6-darken");
			// The default on a page the file itself draws dark: no highlight layer, the plain wash on the
			// pen canvas, b(1 - a) + a s, the same formula as the setting below. On the white glyph the
			// two formulas give the same number; the dark paper is the pixel that tells them apart.
			expect(gap(s.glyph!, white), `the glyph under the highlight is not tinted ${s.glyph}`).toBeGreaterThanOrEqual(40);
			expect(gap(s.glyph!, plainWash(white)), `glyph ${s.glyph}`).toBeLessThanOrEqual(3);
			expect(gap(s.paperUnder!, plainWash(dark)), `dark paper under the highlight ${s.paperUnder}`).toBeLessThanOrEqual(3);
		} finally {
			await tinted.close();
		}
		const plain = await open(true, "lighten");
		try {
			await plain.evaluate((h) => window.pdfHighlight.save([h]), horizontal);
			const s = await pixels(plain, P, "r6-lighten");
			// The plain wash, as at 0ffa3c71: b(1 - a) + a s.
			expect(gap(s.glyph!, plainWash(white)), `glyph ${s.glyph}`).toBeLessThanOrEqual(3);
			expect(gap(s.paperUnder!, plainWash(dark)), `dark paper under the highlight ${s.paperUnder}`).toBeLessThanOrEqual(3);
		} finally {
			await plain.close();
		}
	});

	it("U7: the snip: a black glyph pixel under a highlight stays black, and a crossing is flat", async () => {
		const page = await open();
		try {
			await page.evaluate(([h, v]) => window.pdfHighlight.save([h, v]), [horizontal, vertical] as const);
			const shot = await page.evaluate(() => window.pdfHighlight.snip());
			const inSnip = (p: Pt): Pt => ({ x: (p.x - shot.x0) * shot.scale, y: (p.y - shot.y0) * shot.scale });
			const points = { glyph: inSnip(P.glyph), crossing: inSnip(P.crossing), once: inSnip(P.horizontalOnly), vonce: inSnip(P.verticalOnly) };
			const s = await page.evaluate(({ b64, points }) => window.pdfHighlight.sample(b64, { x: 0, y: 0 }, points, 1), { b64: shot.b64, points });
			console.log(`PDF_HIGHLIGHT u7-snip ${JSON.stringify(s)} origin ${shot.x0},${shot.y0} scale ${shot.scale}`);
			expect(Math.max(...s.glyph!), `snip glyph under the highlight ${s.glyph}`).toBeLessThanOrEqual(20);
			expect(gap(s.crossing!, s.once!), `snip crossing ${s.crossing} once ${s.once}`).toBeLessThanOrEqual(2);
			expect(gap(s.crossing!, s.vonce!), `snip crossing ${s.crossing} once ${s.vonce}`).toBeLessThanOrEqual(2);
		} finally {
			await page.close();
		}
	});
});
