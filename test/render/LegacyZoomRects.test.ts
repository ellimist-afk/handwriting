/**
 * GitHub #32: on an iPad, after zooming out, ink lands at the zoom factor
 * times the pen's distance from the top-left of the screen - at about 55% a
 * stroke in the bottom-right corner is drawn in the middle.
 *
 * WebKit before Safari 26.4 returned getBoundingClientRect in unscaled
 * lengths under CSS zoom: the whole rect divided by the element's effective
 * zoom (WebKit bug 77998, fixed via 300474; Safari 26.4 release notes). The
 * overlay zooms the host with CSS zoom on any engine that supports the
 * property, and measures its scale as band rect width over offsetWidth. On
 * that WebKit the ratio reads 1 at any zoom, so a pen sample is never divided
 * by the zoom and lands where the zoom puts it.
 *
 * The page here stands in for that WebKit: getBoundingClientRect divides by
 * the effective CSS zoom, as the old engine did. The oracle reads the real
 * rects: blue pixels found on the ink canvases, mapped to client px, against
 * where the nib was. A control arm without the stand-in holds the same bound.
 *
 * Numbers from the reporter's call (2026-09-28): landscape viewport of at
 * least 1290 x 960, Infinite Canvas on, Readable line length on, two pinches
 * to about 55%, then a stroke near the bottom-right corner.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build, type Plugin } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
let browser: Browser, bundle: string;

// The iPad: the iPhone stub with isPhone false and isTablet true, loaded in memory.
const ipad: Plugin = {
	name: "ipad-flags",
	setup(b) {
		b.onLoad({ filter: /iphoneObsidianStub\.ts$/ }, (a) => {
			const src = readFileSync(a.path, "utf8").replace("isPhone: true", "isPhone: false").replace("isTablet: false", "isTablet: true");
			if (!src.includes("isTablet: true")) throw new Error("stub flags not rewritten");
			return { contents: src, loader: "ts" };
		});
	},
};

beforeAll(async () => {
	browser = await chromium.launch({ headless: true });
	bundle = (await build({
		entryPoints: [root + "test/render/scrollColumnAnchorPage.ts"], bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: root + "test/render/iphoneObsidianStub.ts" }, plugins: [ipad],
	})).outputFiles[0]!.text;
}, 180_000);

// Every dot's reading, written once when HW_LEGACYZOOM_REPORT names a file.
const report: unknown[] = [];
afterAll(async () => {
	await browser?.close();
	const out = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.HW_LEGACYZOOM_REPORT;
	if (out) writeFileSync(out, JSON.stringify(report, null, 1));
});

const VIEW = { w: 1366, h: 1024, dpr: 2 };
const PANE = { w: 1066, h: 1000 };

type Rig = {
	runTearMount(a: number, b: number, c: unknown, d: boolean, e: unknown): Promise<{ rects: { pane: { l: number; t: number; w: number; h: number } } }>;
	runTearPinch(from: number, to: number, steps: number, cx: number, cy: number): Promise<unknown>;
	runTearRead(): { cssScale: number; strokes: number };
};

async function penDot(legacyRects: boolean, zoom: number, fx: number, fy: number) {
	const page = await browser.newPage({ viewport: { width: VIEW.w, height: VIEW.h }, deviceScaleFactor: VIEW.dpr });
	try {
		await page.addScriptTag({ content: bundle });
		await page.evaluate((legacy) => {
			const real = Element.prototype.getBoundingClientRect;
			(window as unknown as { __realRect: typeof real }).__realRect = real;
			if (!legacy) return;
			Element.prototype.getBoundingClientRect = function (this: Element) {
				const r = real.call(this);
				let z = 1;
				for (let e: Element | null = this; e; e = e.parentElement) {
					const v = Number.parseFloat(getComputedStyle(e).zoom);
					if (Number.isFinite(v) && v > 0) z *= v;
				}
				return z === 1 ? r : new DOMRect(r.x / z, r.y / z, r.width / z, r.height / z);
			};
		}, legacyRects);
		const mounted = await page.evaluate((pane) => (window as unknown as { scrollColumnAnchor: Rig }).scrollColumnAnchor.runTearMount(1, 0, pane, false, { fx: 0.5, fy: 0.5 }), PANE);
		const p = mounted.rects.pane;
		const at = (x: number, y: number) => [Math.round(p.l + p.w * x / 1290), Math.round(p.t + p.h * y / 960)];
		// Her two pinches, at her focal points, each half the zoom's ratio.
		const mid = Math.sqrt(zoom);
		await page.evaluate(([to, x, y]) => (window as unknown as { scrollColumnAnchor: Rig }).scrollColumnAnchor.runTearPinch(1, to!, 8, x!, y!), [mid, ...at(832, 598)]);
		await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
		await page.evaluate(([from, to, x, y]) => (window as unknown as { scrollColumnAnchor: Rig }).scrollColumnAnchor.runTearPinch(from!, to!, 8, x!, y!), [mid, zoom, ...at(587, 607)]);
		await page.evaluate(() => new Promise((r) => { let n = 0; const f = () => (++n < 20 ? requestAnimationFrame(f) : setTimeout(r, 400)); requestAnimationFrame(f); }));
		const P = { x: Math.round(p.l + p.w * fx) + 0.5, y: Math.round(p.t + p.h * fy) + 0.5 };
		return await page.evaluate(async (P) => {
			const w = window as unknown as { scrollColumnAnchor: Rig; __realRect: (this: Element) => DOMRect };
			const rect = (e: Element) => w.__realRect.call(e);
			const target = document.elementFromPoint(P.x, P.y);
			const pen = (type: string, x: number, y: number, buttons: number) => target?.dispatchEvent(new PointerEvent(type, {
				bubbles: true, cancelable: true, pointerType: "pen", pointerId: 7, isPrimary: true, clientX: x, clientY: y, buttons, pressure: buttons ? 0.5 : 0,
			}));
			const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			const before = w.scrollColumnAnchor.runTearRead().strokes;
			// A dot: four samples inside a 2 px square; its paint centre is P + (1, 1).
			pen("pointerdown", P.x, P.y, 1); pen("pointermove", P.x + 2, P.y, 1); pen("pointermove", P.x + 2, P.y + 2, 1);
			pen("pointermove", P.x, P.y + 2, 1); pen("pointerup", P.x, P.y + 2, 0);
			await raf2(); await raf2(); await new Promise((r) => setTimeout(r, 300)); await raf2();
			const read = w.scrollColumnAnchor.runTearRead();
			let n = 0, sx = 0, sy = 0;
			for (const cv of Array.from(document.querySelectorAll("canvas"))) {
				const r = rect(cv);
				if (!(r.width > 0 && r.height > 0 && cv.width > 0 && cv.height > 0)) continue;
				const kx = cv.width / r.width, ky = cv.height / r.height;
				let img: ImageData | undefined;
				try { img = cv.getContext("2d")?.getImageData(0, 0, cv.width, cv.height); } catch { continue; }
				if (!img) continue;
				for (let j = 0; j < img.height; j++) for (let i = 0; i < img.width; i++) {
					const o = (j * img.width + i) * 4;
					if (img.data[o + 3]! > 60 && img.data[o + 2]! > 120 && img.data[o]! < 90 && img.data[o + 1]! < 90) {
						n++; sx += r.left + (i + 0.5) / kx; sy += r.top + (j + 0.5) / ky;
					}
				}
			}
			const host = document.querySelector(".handwriting-note-viewport");
			return {
				strokes: read.strokes - before, cssScale: read.cssScale,
				hostZoom: host ? getComputedStyle(host).zoom : null, hostTransform: host ? getComputedStyle(host).transform : null,
				paint: n ? { x: sx / n, y: sy / n, px: n } : null, nib: { x: P.x + 1, y: P.y + 1 },
			};
		}, P);
	} finally {
		await page.close();
	}
}

// Two zooms: out to her 55%, and in to 2. Bound: under 2 note px on each axis.
for (const zoom of [0.55, 2]) for (const legacy of [false, true]) for (const [spot, fx, fy] of [["bottom-right", 1240 / 1290, 830 / 960], ["top-left", 299 / 1290, 190 / 960]] as const) {
	it(`${legacy ? "WebKit before 26.4 (unscaled rects)" : "current engines"}: after two pinches to ${zoom}, a pen dot at the ${spot} is painted under the nib`, async () => {
		const r = await penDot(legacy, zoom, fx, fy);
		// eslint-disable-next-line no-console
		console.log(`LEGACYZOOM zoom=${zoom} legacy=${legacy} spot=${spot} ${JSON.stringify(r)}`);
		report.push({ zoom, legacy, spot, ...r, dxNote: (r.paint ? (r.paint.x - r.nib.x) / zoom : null), dyNote: (r.paint ? (r.paint.y - r.nib.y) / zoom : null) });
		expect(r.strokes, "the dot did not become a stroke").toBe(1);
		expect(r.paint, "no ink found on any canvas").not.toBeNull();
		expect(Math.abs(r.cssScale - zoom) / zoom, `the overlay's scale reads ${r.cssScale}, not the ${zoom} on screen`).toBeLessThan(0.02);
		const dx = (r.paint!.x - r.nib.x) / zoom, dy = (r.paint!.y - r.nib.y) / zoom;
		expect(Math.max(Math.abs(dx), Math.abs(dy)), `ink painted ${dx.toFixed(2)}, ${dy.toFixed(2)} note px from the nib`).toBeLessThan(2);
	}, 120_000);
}
