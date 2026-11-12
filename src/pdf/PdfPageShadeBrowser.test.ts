import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { writeFileSync } from "node:fs";

declare const process: { env: Record<string, string | undefined>; cwd(): string; platform: string };

/**
 * What a real canvas reads as: the page read the PDF ink takes its dark-page
 * answer from (`readCanvasDark`), run in Chromium on canvases drawn here.
 * PdfFileDarkPage.test.ts proves which canvas is read and when; this proves
 * what the read says about the pixels, and what one read costs on a page
 * canvas of 16 million pixels.
 *
 * Opt in under the same guard as the other browser suites here: CX5_BROWSER=1.
 * HW_SHADE_OUT names a file for the cost record.
 */

/** A GPU canvas where the machine has one, as a page canvas is drawn in the app. */
const GPU_ARGS = process.platform === "win32" ? ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-angle=d3d11"] : [];

/** Two sizes of one page, as two zooms draw it: odd sides on the first, so the patch places round. */
const SMALL = { w: 1231, h: 1597 };
const LARGE = { w: 2462, h: 3194 };
/** The cost run's two sizes: C7 holds at these too. */
const SQUARE_2K = { w: 2000, h: 2000 };
const SQUARE_4K = { w: 4000, h: 4000 };

const SCENES = `
// Obsidian's global createEl, which the read makes its sample canvas with; a plain Chromium page has none.
window.createEl = (tag) => document.createElement(tag);
window.drawScene = (kind, w, h) => {
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	const ctx = c.getContext("2d", { alpha: kind === "see-through" });
	const fill = (style, x, y, fw, fh) => { ctx.fillStyle = style; ctx.fillRect(x, y, fw, fh); };
	const s = w / 1231;
	if (kind === "see-through") return c;
	if (kind === "grey-77") { fill("#777777", 0, 0, w, h); return c; }
	if (kind === "grey-88") { fill("#888888", 0, 0, w, h); return c; }
	fill("#ffffff", 0, 0, w, h);
	if (kind === "middle-tenth") {
		const bw = w * Math.sqrt(0.1), bh = h * Math.sqrt(0.1);
		fill("#000000", (w - bw) / 2, (h - bh) / 2, bw, bh);
	} else if (kind === "forty-dark") {
		fill("#000000", 0, 0, w * 0.4, h);
	} else if (kind === "ruled") {
		for (let y = 6 * s; y < h; y += 12 * s) fill("#000000", 0, Math.round(y), w, Math.max(1, Math.round(s)));
	} else if (kind === "text") {
		for (let y = 40; y + 12 < h; y += 24) for (let x = 40; x + 8 < w; x += 11) fill("#202020", x, y, 8, 12);
	}
	return c;
};
window.shadeOf = (kind, w, h) => window.readCanvasDark(window.drawScene(kind, w, h));
window.renderer = () => {
	const gl = document.createElement("canvas").getContext("webgl");
	const info = gl && gl.getExtension("WEBGL_debug_renderer_info");
	return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
};
window.cost = async (w, h, runs) => {
	const c = window.drawScene("text", w, h);
	c.style.width = "100px";
	c.style.height = "100px";
	document.body.appendChild(c);
	await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	const ms = [];
	let dark = null;
	for (let i = 0; i < runs; i++) {
		const t0 = performance.now();
		dark = window.readCanvasDark(c);
		ms.push(performance.now() - t0);
	}
	c.remove();
	c.width = 0;
	c.height = 0;
	return { ms, dark };
};
`;

describe.skipIf(process.env.CX5_BROWSER !== "1")("PDF page shade read, in a real browser", () => {
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
		console.log(`Shade browser: ${browser.version()}`);
	}, 60_000);
	afterAll(async () => {
		await browser?.close();
	});

	const shade = (kind: string, size: { w: number; h: number }) =>
		page.evaluate(([k, w, h]) => (window as any).shadeOf(k, w, h) as boolean | null, [kind, size.w, size.h] as const);

	it("C10 a see-through canvas reads light: the sample is drawn over white", async () => {
		expect(await shade("see-through", SMALL), "C10 a see-through canvas read dark").toBe(false);
	});

	it("C10 the scale: #777777 reads dark and #888888 light", async () => {
		expect(await shade("grey-77", SMALL), "C10 #777777 did not read dark").toBe(true);
		expect(await shade("grey-88", SMALL), "C10 #888888 did not read light").toBe(false);
	});

	it("C10 a light canvas with a dark block over its middle tenth reads light at two canvas sizes", async () => {
		expect(await shade("middle-tenth", SMALL), "C10 the middle-tenth page read dark at the small size").toBe(false);
		expect(await shade("middle-tenth", LARGE), "C10 the middle-tenth page read dark at the large size").toBe(false);
	});

	it("C7 a page 40 percent dark gives one answer at four canvas sizes", async () => {
		const small = await shade("forty-dark", SMALL);
		const large = await shade("forty-dark", LARGE);
		expect(small, "C7 the 40 percent page could not be read").not.toBeNull();
		expect(large, "C7 the 40 percent page gave two answers at two sizes").toBe(small);
		expect(await shade("forty-dark", SQUARE_2K), "C7 the 40 percent page gave another answer at 2000 x 2000").toBe(small);
		expect(await shade("forty-dark", SQUARE_4K), "C7 the 40 percent page gave another answer at 4000 x 4000").toBe(small);
		expect(small, "C7 a page 60 percent white read dark").toBe(false);
	});

	it("C7 a white page ruled with thin dark lines gives one answer at four canvas sizes", async () => {
		const small = await shade("ruled", SMALL);
		const large = await shade("ruled", LARGE);
		expect(small, "C7 the ruled page could not be read").not.toBeNull();
		expect(large, "C7 the ruled page gave two answers at two sizes").toBe(small);
		expect(await shade("ruled", SQUARE_2K), "C7 the ruled page gave another answer at 2000 x 2000").toBe(small);
		expect(await shade("ruled", SQUARE_4K), "C7 the ruled page gave another answer at 4000 x 4000").toBe(small);
		expect(small, "C7 the ruled page read dark").toBe(false);
	});

	it("a canvas with no size cannot be read: null, no throw", async () => {
		expect(await shade("grey-77", { w: 0, h: 0 })).toBeNull();
	});

	it("cost: ms per read on a page canvas of 16 million pixels", async () => {
		const w = 4000;
		const h = 4000;
		const runs = 6;
		const result = (await page.evaluate(([cw, ch, n]) => (window as any).cost(cw, ch, n), [w, h, runs] as const)) as { ms: number[]; dark: boolean | null };
		const renderer = (await page.evaluate(() => (window as any).renderer())) as string;
		const warm = [...result.ms.slice(1)].sort((a, b) => a - b);
		const record = {
			browser: browser.version(),
			renderer,
			args: GPU_ARGS,
			w,
			h,
			px: w * h,
			ms: result.ms.map((m) => Math.round(m * 100) / 100),
			firstMs: Math.round(result.ms[0]! * 100) / 100,
			medianAfterFirstMs: Math.round(warm[Math.floor(warm.length / 2)]! * 100) / 100,
			dark: result.dark,
		};
		console.log(`SHADE-COST ${JSON.stringify(record)}`);
		if (process.env.HW_SHADE_OUT) writeFileSync(process.env.HW_SHADE_OUT, JSON.stringify(record, null, 1));
		expect(result.dark, "the 16 million pixel page could not be read").toBe(false);
	});
});
