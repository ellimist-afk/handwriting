/**
 * Highlight crossings on PDF pages read as dark (1.5.2 F1).
 *
 * A page read as dark (the file draws it dark, the app has made its pages dark
 * with "Adapt to theme", or the reader picked "Lighten for dark pages") shows
 * two crossing highlights as one coat, as a page read as light does, and a
 * single coat looks as it did before: the plain wash, b(1 - a) + a s at
 * a = 0.35. Pages read as light keep the multiply layer unchanged.
 *
 * The page stand-in is test/render/pdfDarkCrossingPage.ts: the real
 * controller over an opaque page canvas, the shipped stylesheet. Each cell
 * screenshots the page and reads composited pixels. "The reference" is the
 * same strokes painted by the controller's own `drawCommitted` onto a copy of
 * the page canvas: how a page read as dark was painted before this fix.
 *
 * Geometry (css px, scale 1). The page is #111111 with a #808080 panel at
 * x 80..520, y 450..700, and a white glyph at 200..260, 285..315 (the device
 * fixture's page 2 in small). On black: H1 along y = 300, V1 along x = 330,
 * crossing at (330, 300). On the panel: H2 along y = 560, V2 along x = 330,
 * crossing at (330, 560). Highlights are 24 px wide.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { launch, stylesCss } from "./harness";
import type { OpenOptions } from "./pdfDarkCrossingPage";
import type { Pt, RGB } from "./penMarks";
declare const process: { env: Record<string, string | undefined> };

let browser: Browser, bundle: string;
beforeAll(async () => {
	const result = await build({
		entryPoints: [fileURLToPath(new URL("./pdfDarkCrossingPage.ts", import.meta.url))],
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

const gap = (a: readonly number[], b: readonly number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

const DARK_PAGE: OpenOptions = { fill: "#111111", glyph: "#ffffff", panel: { x: 80, y: 450, w: 440, h: 250, fill: "#808080" } };
const WHITE_PAGE: OpenOptions = { fill: "#ffffff", glyph: "#000000" };

const H1 = { tool: "highlighter" as const, a: { x: 120, y: 300 }, b: { x: 440, y: 300 } };
const V1 = { tool: "highlighter" as const, a: { x: 330, y: 200 }, b: { x: 330, y: 420 } };
const H2 = { tool: "highlighter" as const, a: { x: 120, y: 560 }, b: { x: 440, y: 560 } };
const V2 = { tool: "highlighter" as const, a: { x: 330, y: 480 }, b: { x: 330, y: 680 } };

/** Points on black and on the panel: the crossing, and a pixel each stroke covers alone. */
const ON_BLACK = { crossing: { x: 330, y: 300 }, hOnly: { x: 400, y: 300 }, vOnly: { x: 330, y: 240 }, glyph: { x: 230, y: 300 } };
const ON_PANEL = { pCrossing: { x: 330, y: 560 }, pHOnly: { x: 400, y: 560 }, pVOnly: { x: 330, y: 640 } };

async function open(o: OpenOptions, dpr = 1): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 700, height: 900 }, deviceScaleFactor: dpr });
	page.on("console", (m) => console.log(`page: ${m.text()}`));
	await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
	await page.addStyleTag({ content: stylesCss() });
	await page.addScriptTag({ content: bundle });
	await page.evaluate((opts) => window.pdfDark.open(opts), o);
	return page;
}

async function shot(page: Page, label: string): Promise<string> {
	const directory = process.env.PDF_DARK_CROSSING_EVIDENCE;
	const png = await page.screenshot({ scale: "css", path: directory ? `${directory}/${label}.png` : undefined });
	return png.toString("base64");
}

async function pixels(page: Page, points: Record<string, Pt>, label: string, r = 2): Promise<Record<string, RGB>> {
	const b64 = await shot(page, label);
	const result = await page.evaluate(({ b64, points, r }) => window.pdfDark.sample(b64, { x: 0, y: 0 }, points, r), { b64, points, r });
	const layers = await page.evaluate(() => window.pdfDark.layers());
	console.log(`PDF_DARK ${label} ${JSON.stringify(result)} layers ${JSON.stringify(layers)}`);
	return result;
}

async function reference(page: Page, points: Record<string, Pt>, label: string): Promise<Record<string, RGB>> {
	const ref = await page.evaluate((points) => window.pdfDark.reference(points), points);
	console.log(`PDF_DARK ${label}-reference ${JSON.stringify(ref)}`);
	return ref;
}

async function group(page: Page): Promise<{ blend: string; opacity: string } | null> {
	const layers = await page.evaluate(() => window.pdfDark.layers());
	const g = layers.find((l) => l.cls.includes("handwriting-pdf-highlight-group"));
	return g ? { blend: g.blend, opacity: g.opacity } : null;
}

describe("F1: on a page read as dark, crossing highlights are one coat and one coat looks as before", () => {
	it("D1: the file draws the page dark: crossings on black and on the grey panel are one coat (within 1), and one coat equals the plain wash before the fix (within 1)", async () => {
		const page = await open(DARK_PAGE);
		try {
			await page.evaluate((s) => window.pdfDark.save(s), [H1, V1, H2, V2]);
			const points = { ...ON_BLACK, ...ON_PANEL };
			const s = await pixels(page, points, "d1");
			const ref = await reference(page, points, "d1");
			for (const key of ["hOnly", "vOnly", "glyph", "pHOnly", "pVOnly"]) {
				expect(gap(s[key]!, ref[key]!), `D1 one coat ${key} ${s[key]} reference ${ref[key]}`).toBeLessThanOrEqual(1);
			}
			expect(gap(s.hOnly!, [17, 17, 17]), `D1 the band shows on black ${s.hOnly}`).toBeGreaterThanOrEqual(40);
			expect(gap(s.crossing!, s.hOnly!), `D1 crossing on black ${s.crossing} once ${s.hOnly}`).toBeLessThanOrEqual(1);
			expect(gap(s.crossing!, s.vOnly!), `D1 crossing on black ${s.crossing} once ${s.vOnly}`).toBeLessThanOrEqual(1);
			expect(gap(s.pCrossing!, s.pHOnly!), `D1 crossing on the panel ${s.pCrossing} once ${s.pHOnly}`).toBeLessThanOrEqual(1);
			expect(gap(s.pCrossing!, s.pVOnly!), `D1 crossing on the panel ${s.pCrossing} once ${s.pVOnly}`).toBeLessThanOrEqual(1);
		} finally {
			await page.close();
		}
	});

	it("D2: one coat on a page read as dark equals the plain wash before the fix row by row across the band, edges included (within 1)", async () => {
		const page = await open(DARK_PAGE);
		try {
			await page.evaluate((s) => window.pdfDark.save(s), [H1, H2]);
			const b64 = await shot(page, "d2");
			for (const [label, y0, y1] of [["black", 280, 320], ["panel", 540, 580]] as const) {
				const screen = await page.evaluate(({ b64, y0, y1 }) => window.pdfDark.column(b64, 400, y0, y1), { b64, y0, y1 });
				const ref = await page.evaluate(({ y0, y1 }) => window.pdfDark.referenceColumn(400, y0, y1), { y0, y1 });
				console.log(`PDF_DARK d2-${label} screen ${JSON.stringify(screen)} reference ${JSON.stringify(ref)}`);
				const worst = Math.max(...screen.map((px, i) => gap(px, ref[i]!)));
				expect(worst, `D2 ${label}: the largest row gap against the plain wash`).toBeLessThanOrEqual(1);
			}
		} finally {
			await page.close();
		}
	});

	it("D3: yellow then blue crossing on a page read as dark shows the later colour at one coat (within 1)", async () => {
		const page = await open(DARK_PAGE);
		try {
			const yellow = { tool: "highlighter" as const, a: { x: 120, y: 750 }, b: { x: 520, y: 750 } };
			const blue = { tool: "highlighter" as const, a: { x: 480, y: 720 }, b: { x: 480, y: 790 }, color: "#2060ff" };
			await page.evaluate((s) => window.pdfDark.save(s), [yellow, blue]);
			const s = await pixels(page, { crossing: { x: 480, y: 750 }, blueOnly: { x: 480, y: 782 }, yellowOnly: { x: 200, y: 750 } }, "d3");
			expect(gap(s.blueOnly!, s.yellowOnly!), `D3 the two colours differ ${s.blueOnly} ${s.yellowOnly}`).toBeGreaterThanOrEqual(30);
			expect(gap(s.crossing!, s.blueOnly!), `D3 crossing ${s.crossing} blue once ${s.blueOnly}`).toBeLessThanOrEqual(1);
		} finally {
			await page.close();
		}
	});

	it("D4: a white page under \"Lighten for dark pages\" (read dark by the reader's word): crossing is one coat, one coat is the plain wash before the fix", async () => {
		const page = await open({ ...WHITE_PAGE, assumption: "lighten" });
		try {
			await page.evaluate((s) => window.pdfDark.save(s), [H1, V1]);
			const s = await pixels(page, ON_BLACK, "d4");
			const ref = await reference(page, ON_BLACK, "d4");
			for (const key of ["hOnly", "vOnly", "glyph"]) {
				expect(gap(s[key]!, ref[key]!), `D4 one coat ${key} ${s[key]} reference ${ref[key]}`).toBeLessThanOrEqual(1);
			}
			expect(gap(s.crossing!, s.hOnly!), `D4 crossing ${s.crossing} once ${s.hOnly}`).toBeLessThanOrEqual(1);
		} finally {
			await page.close();
		}
	});

	it("D5: the app's dark pages (\"Adapt to theme\" under a dark theme): crossing is one coat, one coat is the plain wash before the fix", async () => {
		const page = await open({ ...WHITE_PAGE, themed: true, bodyDark: true });
		try {
			await page.evaluate((s) => window.pdfDark.save(s), [H1, V1]);
			const s = await pixels(page, ON_BLACK, "d5");
			const ref = await reference(page, ON_BLACK, "d5");
			for (const key of ["hOnly", "vOnly", "glyph"]) {
				expect(gap(s[key]!, ref[key]!), `D5 one coat ${key} ${s[key]} reference ${ref[key]}`).toBeLessThanOrEqual(1);
			}
			expect(gap(s.crossing!, s.hOnly!), `D5 crossing ${s.crossing} once ${s.hOnly}`).toBeLessThanOrEqual(1);
		} finally {
			await page.close();
		}
	});

	it("D6: the group a page read as dark gets blends normal at 0.35; a page read as light keeps multiply at 0.35", async () => {
		const light = await open(WHITE_PAGE);
		try {
			await light.evaluate((s) => window.pdfDark.save(s), [H1]);
			expect(await group(light), "D6 light page").toEqual({ blend: "multiply", opacity: "0.35" });
		} finally {
			await light.close();
		}
		const dark = await open(DARK_PAGE);
		try {
			await dark.evaluate((s) => window.pdfDark.save(s), [H1]);
			expect(await group(dark), "D6 page read dark").toEqual({ blend: "normal", opacity: "0.35" });
		} finally {
			await dark.close();
		}
	});

	it("D7: the snip of a page read as dark: crossings one coat on black and on the panel, one coat equals the plain wash before the fix (within 1)", async () => {
		const page = await open(DARK_PAGE);
		try {
			await page.evaluate((s) => window.pdfDark.save(s), [H1, V1, H2, V2]);
			const cut = await page.evaluate(() => window.pdfDark.snip());
			const inSnip = (p: Pt): Pt => ({ x: (p.x - cut.x0) * cut.scale, y: (p.y - cut.y0) * cut.scale });
			const points = { ...ON_BLACK, ...ON_PANEL };
			const at: Record<string, Pt> = {};
			for (const [k, p] of Object.entries(points)) at[k] = inSnip(p);
			const s = await page.evaluate(({ b64, at }) => window.pdfDark.sample(b64, { x: 0, y: 0 }, at, 1), { b64: cut.b64, at });
			const ref = await reference(page, points, "d7");
			console.log(`PDF_DARK d7-snip ${JSON.stringify(s)} origin ${cut.x0},${cut.y0} scale ${cut.scale}`);
			for (const key of ["hOnly", "vOnly", "pHOnly", "pVOnly"]) {
				expect(gap(s[key]!, ref[key]!), `D7 snip one coat ${key} ${s[key]} reference ${ref[key]}`).toBeLessThanOrEqual(1);
			}
			expect(gap(s.crossing!, s.hOnly!), `D7 snip crossing on black ${s.crossing} once ${s.hOnly}`).toBeLessThanOrEqual(1);
			expect(gap(s.pCrossing!, s.pHOnly!), `D7 snip crossing on the panel ${s.pCrossing} once ${s.pHOnly}`).toBeLessThanOrEqual(1);
		} finally {
			await page.close();
		}
	});

	it("D8: a highlighter held across a saved one on a page read as dark is one coat with it, and the lift changes no pixel (within 1)", async () => {
		const page = await open(DARK_PAGE);
		try {
			await page.evaluate((s) => window.pdfDark.save(s), [H1]);
			await page.evaluate(([a, b]) => window.pdfDark.hold("highlighter", a, b), [V1.a, V1.b] as const);
			const held = await pixels(page, ON_BLACK, "d8-held");
			expect(gap(held.vOnly!, [17, 17, 17]), `D8 the live band shows on black ${held.vOnly}`).toBeGreaterThanOrEqual(40);
			expect(gap(held.crossing!, held.hOnly!), `D8 held crossing ${held.crossing} saved only ${held.hOnly}`).toBeLessThanOrEqual(1);
			expect(gap(held.crossing!, held.vOnly!), `D8 held crossing ${held.crossing} live only ${held.vOnly}`).toBeLessThanOrEqual(1);
			await page.evaluate(() => window.pdfDark.lift());
			const after = await pixels(page, ON_BLACK, "d8-lifted");
			for (const key of Object.keys(ON_BLACK)) {
				expect(gap(after[key]!, held[key]!), `D8 ${key} before the lift ${held[key]} after ${after[key]}`).toBeLessThanOrEqual(1);
			}
		} finally {
			await page.close();
		}
	});
});

describe("F1: a verdict change alone re-blends the group at the next sync, and the re-blend brings on no sync", () => {
	/** Flip one source, run one sync, read the group; the next 6 frames bring on no sync of their own. */
	async function flip(page: Page, label: string, apply: () => Promise<void>, want: string): Promise<void> {
		await apply();
		await page.evaluate(() => window.pdfDark.syncOnce());
		const g = await group(page);
		console.log(`PDF_DARK ${label} group ${JSON.stringify(g)}`);
		expect(g, `${label}: the group after one sync`).toEqual({ blend: want, opacity: "0.35" });
		await page.evaluate(() => window.pdfDark.resetCounts());
		await page.evaluate(() => window.pdfDark.frames(6));
		const n = await page.evaluate(() => window.pdfDark.counts());
		expect(n.syncs, `${label}: syncs in the 6 frames after`).toBe(0);
	}

	it("D9a: the reader switches to \"Lighten for dark pages\" and back", async () => {
		const page = await open(WHITE_PAGE);
		try {
			await page.evaluate((s) => window.pdfDark.save(s), [H1]);
			expect(await group(page)).toEqual({ blend: "multiply", opacity: "0.35" });
			await flip(page, "D9a lighten", () => page.evaluate(() => window.pdfDark.setAssumption("lighten")), "normal");
			// The glyph under the band: the plain wash tints it; multiply would keep it black.
			const s = await pixels(page, { glyph: ON_BLACK.glyph }, "d9a-lighten");
			const ref = await reference(page, { glyph: ON_BLACK.glyph }, "d9a-lighten");
			expect(gap(s.glyph!, ref.glyph!), `D9a glyph ${s.glyph} reference ${ref.glyph}`).toBeLessThanOrEqual(1);
			await flip(page, "D9a darken", () => page.evaluate(() => window.pdfDark.setAssumption("darken")), "multiply");
		} finally {
			await page.close();
		}
	});

	it("D9b: \"Adapt to theme\" turned on and off under a dark theme", async () => {
		const page = await open({ ...WHITE_PAGE, bodyDark: true });
		// The option turns and the page's own sync for it lands, in one page call, before the cell counts.
		const themed = async (label: string, on: boolean, want: string): Promise<void> => {
			const landed = await page.evaluate(async (v) => {
				window.pdfDark.setThemed(v);
				return window.pdfDark.observerSync();
			}, on);
			expect(landed, `${label}: the page's own syncs after the option turns`).toBeGreaterThanOrEqual(1);
			expect(await group(page), `${label}: the group after the page's own sync`).toEqual({ blend: want, opacity: "0.35" });
		};
		try {
			await page.evaluate((s) => window.pdfDark.save(s), [H1]);
			expect(await group(page)).toEqual({ blend: "multiply", opacity: "0.35" });
			await flip(page, "D9b adapt on", () => themed("D9b adapt on", true, "normal"), "normal");
			await flip(page, "D9b adapt off", () => themed("D9b adapt off", false, "multiply"), "multiply");
		} finally {
			await page.close();
		}
	});

	it("D9c: a theme switch with \"Adapt to theme\" on", async () => {
		const page = await open({ ...WHITE_PAGE, themed: true });
		try {
			await page.evaluate((s) => window.pdfDark.save(s), [H1]);
			expect(await group(page)).toEqual({ blend: "multiply", opacity: "0.35" });
			await flip(page, "D9c to dark", () => page.evaluate(() => window.pdfDark.setBodyDark(true)), "normal");
			await flip(page, "D9c to light", () => page.evaluate(() => window.pdfDark.setBodyDark(false)), "multiply");
		} finally {
			await page.close();
		}
	});

	it("D9d: a page the file draws dark finishes drawing: read dark at that sync", async () => {
		const page = await open({ ...DARK_PAGE, loading: true });
		try {
			await page.evaluate((s) => window.pdfDark.save(s), [H1]);
			// Still drawing: unread, so light meanwhile.
			expect(await group(page)).toEqual({ blend: "multiply", opacity: "0.35" });
			await flip(page, "D9d drawn", async () => {
				// The draw ends and the wait runs in one page call, till the controller has no sync queued.
				const r = await page.evaluate(() => window.pdfDark.finishDrawSettled());
				expect(r.settled, `D9d drawn: the controller settled after the draw ends (${r.landed} syncs)`).toBe(true);
				expect(r.landed, "D9d drawn: the page's own syncs after the draw ends").toBeGreaterThanOrEqual(1);
				expect(await group(page), "D9d drawn: the group after the page's own sync").toEqual({ blend: "normal", opacity: "0.35" });
			}, "normal");
		} finally {
			await page.close();
		}
	});
});

describe("F1: the pair, the tip, the canvas cap", () => {
	it("D10: after a highlighter stroke on a page read as dark the pair is back on the page at opacity 1 (a lasso next is not washed)", async () => {
		const page = await open(DARK_PAGE);
		try {
			await page.evaluate(() => window.pdfDark.hold("highlighter", { x: 140, y: 380 }, { x: 420, y: 380 }));
			const during = await page.evaluate(() => window.pdfDark.pairState());
			await page.evaluate(() => window.pdfDark.lift());
			const after = await page.evaluate(() => window.pdfDark.pairState());
			console.log(`PDF_DARK d10 during ${JSON.stringify(during)} after ${JSON.stringify(after)}`);
			expect(after, "D10 the pair after the lift").toEqual({ parent: "page", opacity: "1" });
		} finally {
			await page.close();
		}
	});

	it("D11: a highlighter held on a page read as dark, 20 px a sample: the pixels behind the nib match the trail (no darker dot)", async () => {
		const page = await open({ fill: "#111111", glyph: "#ffffff" });
		try {
			await page.evaluate(() => window.pdfDark.hold("highlighter", { x: 140, y: 560 }, { x: 420, y: 560 }));
			const points: Record<string, Pt> = { mid: { x: 220, y: 560 } };
			for (let x = 340; x <= 412; x += 8) points[`head${x}`] = { x, y: 560 };
			const s = await pixels(page, points, "d11-held", 0);
			expect(gap(s.mid!, [17, 17, 17]), `D11 the trail shows ${s.mid}`).toBeGreaterThanOrEqual(40);
			for (const [key, v] of Object.entries(s)) {
				if (key === "mid") continue;
				expect(gap(v, s.mid!), `D11 ${key} ${v} against the mid trail ${s.mid}`).toBeLessThanOrEqual(2);
			}
			await page.evaluate(() => window.pdfDark.lift());
		} finally {
			await page.close();
		}
	});

	it("D13: a highlighter held on a page read as dark that holds pen ink only: the band shows while held, and the lift changes nothing", async () => {
		const page = await open({ fill: "#111111", glyph: "#111111", assumption: "lighten" });
		try {
			await page.evaluate((s) => window.pdfDark.save(s), [{ tool: "pen" as const, a: { x: 120, y: 420 }, b: { x: 440, y: 420 } }]);
			await page.evaluate(() => window.pdfDark.hold("highlighter", { x: 140, y: 300 }, { x: 420, y: 300 }));
			const held = await pixels(page, { trail: { x: 240, y: 300 } }, "d13-held");
			const pair = await page.evaluate(() => window.pdfDark.pairState());
			const g = await group(page);
			await page.evaluate(() => window.pdfDark.lift());
			const lifted = await pixels(page, { trail: { x: 240, y: 300 } }, "d13-lifted");
			console.log(`PDF_DARK d13 pair ${JSON.stringify(pair)} group ${JSON.stringify(g)}`);
			expect(gap(held.trail!, [17, 17, 17]), `D13 the band does not show while held ${held.trail} (pair ${JSON.stringify(pair)}, group ${JSON.stringify(g)})`).toBeGreaterThanOrEqual(40);
			expect(gap(held.trail!, lifted.trail!), `D13 the lift changed the band: held ${held.trail} lifted ${lifted.trail}`).toBeLessThanOrEqual(2);
		} finally {
			await page.close();
		}
	});

	it("D12: no 2d context for the highlight canvas (the canvas cap) on a page read as dark: the highlights still show, at the plain wash", async () => {
		const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
		try {
			await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
			await page.addStyleTag({ content: stylesCss() });
			await page.addScriptTag({ content: bundle });
			await page.evaluate(() => window.pdfDark.capHighlightCanvas(true));
			await page.evaluate((o) => window.pdfDark.open(o), DARK_PAGE);
			await page.evaluate((s) => window.pdfDark.save(s), [H1]);
			const s = await pixels(page, { hOnly: ON_BLACK.hOnly }, "d12");
			const ref = await reference(page, { hOnly: ON_BLACK.hOnly }, "d12");
			expect(gap(s.hOnly!, ref.hOnly!), `D12 ${s.hOnly} reference ${ref.hOnly}`).toBeLessThanOrEqual(1);
		} finally {
			await page.close();
		}
	});
});

/**
 * Zoom on a page read as dark is no worse than before the fix, by count, not
 * clock (no timing run): the dark reads per zoom settle, the frames where the
 * band is gone over black after a settle, and our canvases' backing pixels at
 * 600% against a light page with the same highlights. The numbers each cell
 * holds to are the ones the base (cef861e0) gave in the same cell.
 */
describe("F1: zoom on a page read as dark is no worse than before", () => {
	/** Measured at cef861e0 in Z1 below: three settles, each a new canvas, drawn when it lands. */
	const BASE_READS = 3;
	/** Measured at cef861e0 in Z2 below: of its six syncs, from a settle that lands still drawing to two after the draw, those with no band over black. */
	const BASE_GONE = 3;

	it("Z1: three zoom settles on a page read as dark: no more dark reads than before the fix", async () => {
		const page = await open(DARK_PAGE);
		try {
			await page.evaluate((s) => window.pdfDark.save(s), [H1, V1]);
			await page.evaluate(() => {
				window.pdfDark.resetCounts();
				window.pdfDark.countReads(true);
			});
			for (const scale of [2, 1.5, 1]) {
				await page.evaluate((k) => window.pdfDark.zoomTo(k, false), scale);
				await page.evaluate(() => window.pdfDark.syncOnce());
				await page.evaluate(() => window.pdfDark.frames(4));
			}
			await page.evaluate(() => window.pdfDark.countReads(false));
			const n = await page.evaluate(() => window.pdfDark.counts());
			console.log(`PDF_DARK z1 ${JSON.stringify(n)} base ${BASE_READS}`);
			expect(n.reads, "Z1 dark reads over three settles").toBeLessThanOrEqual(BASE_READS);
			// And the band is there at the end: the page was read dark at each settle.
			const s = await pixels(page, ON_BLACK, "z1-end");
			expect(gap(s.hOnly!, [17, 17, 17]), `Z1 band on black after the settles ${s.hOnly}`).toBeGreaterThanOrEqual(40);
		} finally {
			await page.close();
		}
	});

	it("Z2: a zoom settle that lands still drawing: no more syncs with the band gone over black than before the fix", async () => {
		const page = await open(DARK_PAGE);
		try {
			await page.evaluate((s) => window.pdfDark.save(s), [H1, V1]);
			const at = { hOnly: { x: 400 * 1.5, y: 300 * 1.5 } };
			// Six syncs, each sampled once it shows: the root observer's after the
			// settle and after the draw ends, and the cell's own between. More
			// syncs than BASE_GONE, so a band gone longer than before shows.
			const steps = ["observer", "own", "own", "draw-ends", "own", "own"] as const;
			let gone = 0;
			let last: RGB = [0, 0, 0];
			await page.evaluate(() => window.pdfDark.zoomTo(1.5, true));
			for (const [i, step] of steps.entries()) {
				if (step === "own") await page.evaluate(() => window.pdfDark.syncOnce());
				else {
					if (step === "draw-ends") await page.evaluate(() => window.pdfDark.finishDraw());
					const landed = await page.evaluate(() => window.pdfDark.observerSync());
					expect(landed, `Z2 step ${i} ${step}: the root observer's sync landed`).toBeGreaterThanOrEqual(1);
				}
				const s = await pixels(page, at, `z2-${i}-${step}`);
				last = s.hOnly!;
				if (gap(last, [17, 17, 17]) < 40) gone++;
			}
			console.log(`PDF_DARK z2 gone ${gone} of ${steps.length} base ${BASE_GONE}`);
			expect(gone, "Z2 syncs with the band gone, from the settle to two syncs after the draw").toBeLessThanOrEqual(BASE_GONE);
			expect(gap(last, [17, 17, 17]), `Z2 band on black once drawn ${last}`).toBeGreaterThanOrEqual(40);
		} finally {
			await page.close();
		}
	});

	it("Z3: at 600% a page read as dark holds no more backing pixels than a light page with the same highlights", async () => {
		const sum = async (o: OpenOptions, label: string): Promise<number> => {
			const page = await open(o);
			try {
				await page.evaluate((s) => window.pdfDark.save(s), [H1, V1]);
				await page.evaluate(() => window.pdfDark.zoomTo(6, false));
				await page.evaluate(() => window.pdfDark.syncOnce());
				await page.evaluate(() => window.pdfDark.frames(4));
				const layers = await page.evaluate(() => window.pdfDark.layers());
				console.log(`PDF_DARK z3-${label} ${JSON.stringify(layers)}`);
				return layers.reduce((n, l) => n + l.backing, 0);
			} finally {
				await page.close();
			}
		};
		const dark = await sum(DARK_PAGE, "dark");
		const light = await sum(WHITE_PAGE, "light");
		expect(light, "Z3 the light page has a backing at all").toBeGreaterThan(0);
		expect(dark, `Z3 dark ${dark} light ${light}`).toBeLessThanOrEqual(light);
	});
});

describe("F1: a page read as dark, turned in the viewer", () => {
	it("T1: \"Lighten for dark pages\", the page turned 90: the layer blends normal, the band lands where the turn puts it, its crossing is one coat and one coat is as upright", async () => {
		const page = await open({ fill: "#111111", glyph: "#111111", assumption: "lighten" });
		try {
			await page.evaluate((s) => window.pdfDark.save(s), [H1, V1]);
			const up = await pixels(page, { hOnly: ON_BLACK.hOnly }, "t1-upright");
			await page.evaluate(() => window.pdfDark.turn90());
			// The upright point (x, y) shows at (PAGE.h - y, x) on the page turned clockwise by 90.
			const T = (p: Pt): Pt => ({ x: 800 - p.y, y: p.x });
			const s = await pixels(page, { crossing: T(ON_BLACK.crossing), hOnly: T(ON_BLACK.hOnly), vOnly: T(ON_BLACK.vOnly), wasHOnly: ON_BLACK.hOnly }, "t1-turned");
			const g = await group(page);
			expect(g?.blend, `T1 the turned page's group ${JSON.stringify(g)}`).toBe("normal");
			expect(gap(s.hOnly!, [17, 17, 17]), `T1 the band does not show where the turn puts it ${s.hOnly}`).toBeGreaterThanOrEqual(40);
			expect(gap(s.wasHOnly!, [17, 17, 17]), `T1 the band stayed where it was upright ${s.wasHOnly}`).toBeLessThanOrEqual(1);
			expect(gap(s.hOnly!, up.hOnly!), `T1 one coat turned ${s.hOnly} upright ${up.hOnly}`).toBeLessThanOrEqual(1);
			expect(gap(s.crossing!, s.hOnly!), `T1 crossing ${s.crossing} once ${s.hOnly}`).toBeLessThanOrEqual(1);
			expect(gap(s.crossing!, s.vOnly!), `T1 crossing ${s.crossing} once ${s.vOnly}`).toBeLessThanOrEqual(1);
		} finally {
			await page.close();
		}
	});
});
