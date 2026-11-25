/**
 * The PDF wet pair after a zoom: once the sync that paints a page at its new size has run, with no gesture down, a pair
 * seated on that page has the page's size, band and transform now, or is off the page, with or without a selection; a
 * live selection's box is drawn again once at the new size; a clear leaves no box pixel; no pixel of a box, a stroke's
 * wet copy or a divider is left on the pair; nothing is drawn off its ink. Under a live gesture the pair is not moved,
 * resized or cleared.
 *
 * The page (test/render/pdfLassoBoxPage.ts) runs the real controller on two page divs; a zoom sweeps the page divs as
 * the viewer does, through the real DOM, with the old page canvas kept on the page while the new one draws, so the
 * controller's root observer gets the browser's own records and puts our canvases back. Pixels are read after the
 * sync, when the document is quiet.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { launch, stylesCss } from "./harness";

let browser: Browser, bundle: string;
beforeAll(async () => {
	const result = await build({
		entryPoints: [fileURLToPath(new URL("./pdfLassoBoxPage.ts", import.meta.url))],
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

type Pt = { x: number; y: number };
type Ink = Array<{ page: number; a: Pt; b: Pt }>;

/** Two strokes in the lower right of page 1: past the top left quarter, so a zoom out to half leaves them outside it. */
const LOWER_RIGHT: Ink = [
	{ page: 1, a: { x: 380, y: 560 }, b: { x: 540, y: 560 } },
	{ page: 1, a: { x: 380, y: 660 }, b: { x: 540, y: 660 } },
];
const LOOP = { x: 350, y: 520, w: 220, h: 180 };
/** The box is drawn a few px outside the ink's bounds; this much room either way is "on its ink". */
const PAD = 16;

async function open(ink: Ink): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 700, height: 940 }, deviceScaleFactor: 1 });
	page.on("console", (m) => console.log(`page: ${m.text()}`));
	await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
	await page.addStyleTag({ content: stylesCss() });
	await page.addScriptTag({ content: bundle });
	await page.evaluate((k) => window.pdfLassoBox.open(k), ink);
	return page;
}

const st = (p: Page) => p.evaluate(() => window.pdfLassoBox.state());
const fit = (p: Page, n = 1) => p.evaluate((k) => window.pdfLassoBox.pairFit(k), n);
const quiet = (p: Page) => p.evaluate(() => window.pdfLassoBox.quiet());

/** Pixels on the pair outside the selection's bounds, padded: a box off its ink. */
async function offInk(p: Page): Promise<number> {
	return p.evaluate((pad) => {
		const b = window.pdfLassoBox.bounds(1);
		if (!b) return window.pdfLassoBox.wetPixels();
		return window.pdfLassoBox.wetPixels({ page: 1, x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad });
	}, PAD);
}

async function selected(p: Page): Promise<void> {
	await p.evaluate((r) => window.pdfLassoBox.lasso(1, r), LOOP);
	await quiet(p);
	const s = await st(p);
	expect(s.selected, "the loop picked both strokes").toBe(2);
	expect(s.host).toBe(1);
	expect(await p.evaluate(() => window.pdfLassoBox.wetPixels()), "the box is drawn").toBeGreaterThan(0);
	await p.evaluate(() => window.pdfLassoBox.resetDraws());
}

describe("PDF lasso box and wet pair after a zoom", () => {
	for (const penOnly of [false, true]) {
		it(`a selection, zoom in${penOnly ? " (the viewer takes only the pen canvas)" : ""}: the pair has the page's box and backing, the box is drawn once, on its ink`, async () => {
			const p = await open(LOWER_RIGHT);
			try {
				await selected(p);
				expect(await p.evaluate((o) => window.pdfLassoBox.zoom(1.5, { penOnly: o }), penOnly), "quiet after the zoom").toBe(true);
				const f = await fit(p);
				console.log("fit", JSON.stringify(f), JSON.stringify(await st(p)));
				expect(f.seated, "pair on the page").toBe(true);
				expect(f.sameBox, `pair ${f.pair} vs pen ${f.pen}`).toBe(true);
				expect(f.sameBacking, `pair ${f.pair} vs pen ${f.pen}`).toBe(true);
				expect((await st(p)).lassoDraws, "box drawn again once").toBe(1);
				expect(await p.evaluate(() => window.pdfLassoBox.wetPixels()), "box on screen").toBeGreaterThan(0);
				expect(await offInk(p), "no box pixel off its ink").toBe(0);
			} finally {
				await p.close();
			}
		});
	}

	for (const clear of ["escape", "pickTool"] as const) {
		it(`a selection, zoom out to half, then ${clear === "escape" ? "Escape" : "a tool pick"}: no box pixel is left`, async () => {
			const p = await open(LOWER_RIGHT);
			try {
				await selected(p);
				expect(await p.evaluate(() => window.pdfLassoBox.zoom(0.5)), "quiet after the zoom").toBe(true);
				await p.evaluate((c) => window.pdfLassoBox[c](), clear);
				await p.evaluate(() => window.pdfLassoBox.syncOnce());
				expect((await st(p)).selected).toBe(0);
				expect(await p.evaluate(() => window.pdfLassoBox.wetPixels()), "wet pixels left").toBe(0);
			} finally {
				await p.close();
			}
		});
	}

	it("copy, Escape, zoom, paste on the same page: the box is round the pasted ink, or there is none", async () => {
		const p = await open(LOWER_RIGHT);
		try {
			await selected(p);
			await p.evaluate(() => window.pdfLassoBox.copy());
			await p.evaluate(() => window.pdfLassoBox.escape());
			expect(await p.evaluate(() => window.pdfLassoBox.zoom(0.5)), "quiet after the zoom").toBe(true);
			const before = (await st(p)).selected;
			await p.evaluate(() => window.pdfLassoBox.paste());
			await quiet(p);
			const s = await st(p);
			console.log("paste", JSON.stringify(s), JSON.stringify(await fit(p)));
			expect(s.selected, "the paste selected its ink").toBeGreaterThan(before);
			const f = await fit(p);
			if (f.seated) {
				expect(f.sameBox, `pair ${f.pair} vs pen ${f.pen}`).toBe(true);
				expect(f.sameBacking, `pair ${f.pair} vs pen ${f.pen}`).toBe(true);
			}
			expect(await offInk(p), "no box pixel off the pasted ink").toBe(0);
		} finally {
			await p.close();
		}
	});

	it("a zoom then a sync with nothing changed: the box is drawn once, not at every sync", async () => {
		const p = await open(LOWER_RIGHT);
		try {
			await selected(p);
			expect(await p.evaluate(() => window.pdfLassoBox.zoom(1.5)), "quiet after the zoom").toBe(true);
			expect((await st(p)).lassoDraws, "drawn again at the zoom").toBe(1);
			await p.evaluate(() => window.pdfLassoBox.syncOnce());
			await p.evaluate(() => window.pdfLassoBox.syncOnce());
			expect((await st(p)).lassoDraws, "not again at a sync with nothing changed").toBe(1);
		} finally {
			await p.close();
		}
	});

	for (const tool of ["highlighter", "pen"] as const) {
		it(`a ${tool} stroke across the right of the page, ended by a zoom out to half: no wet pixel is left after the sync`, async () => {
			const p = await open([{ page: 1, a: { x: 60, y: 100 }, b: { x: 120, y: 100 } }]);
			try {
				await p.evaluate((t) => window.pdfLassoBox.stroke(1, t, { x: 320, y: 420 }, { x: 580, y: 420 }), tool);
				expect((await st(p)).idle, "the stroke is down").toBe(false);
				expect(await p.evaluate(() => window.pdfLassoBox.zoom(0.5)), "quiet after the zoom").toBe(true);
				const s = await st(p);
				expect(s.idle, "the zoom ended the stroke").toBe(true);
				console.log("cut", JSON.stringify(s), JSON.stringify(await fit(p)));
				expect(await p.evaluate(() => window.pdfLassoBox.wetPixels()), "wet pixels left").toBe(0);
			} finally {
				await p.close();
			}
		});
	}

	it("the insert-space divider, ended by a zoom out to half: no divider pixel is left after the next sync", async () => {
		const p = await open(LOWER_RIGHT);
		try {
			await p.evaluate(() => window.pdfLassoBox.space(1, 400, 440));
			expect((await st(p)).idle, "the divider is down").toBe(false);
			expect(await p.evaluate(() => window.pdfLassoBox.wetPixels()), "the divider is drawn").toBeGreaterThan(0);
			expect(await p.evaluate(() => window.pdfLassoBox.zoom(0.5)), "quiet after the zoom").toBe(true);
			expect((await st(p)).idle, "the zoom ended the divider").toBe(true);
			expect(await p.evaluate(() => window.pdfLassoBox.wetPixels()), "wet pixels left").toBe(0);
		} finally {
			await p.close();
		}
	});

	it("a selection on page 1 and a stroke held on page 2, page 1 repainted at a new size: the stroke's wet pixels and the pair stay", async () => {
		const p = await open([...LOWER_RIGHT, { page: 2, a: { x: 60, y: 100 }, b: { x: 120, y: 100 } }]);
		try {
			await selected(p);
			await p.evaluate(() => window.pdfLassoBox.stroke(2, "pen", { x: 100, y: 300 }, { x: 400, y: 300 }));
			const s0 = await st(p);
			expect(s0.idle, "the stroke is down").toBe(false);
			expect(s0.host, "the pair is on page 2").toBe(2);
			const before = await p.evaluate(() => window.pdfLassoBox.wetHash());
			expect(await p.evaluate(() => window.pdfLassoBox.zoom(0.75, { pages: [1] })), "quiet after the zoom").toBe(true);
			const s1 = await st(p);
			expect(s1.idle, "the stroke is still down").toBe(false);
			expect(s1.host).toBe(2);
			expect(await p.evaluate(() => window.pdfLassoBox.wetHash()), "wet pixels unchanged").toBe(before);
			await p.evaluate(() => window.pdfLassoBox.lift());
		} finally {
			await p.close();
		}
	});

	it("a lasso loop being drawn, its page synced at a new size before the loop ends: the loop's pixels stay and the pair is not moved", async () => {
		const p = await open(LOWER_RIGHT);
		try {
			await p.evaluate((r) => window.pdfLassoBox.lasso(1, r, false), LOOP);
			const r = await p.evaluate(() => window.pdfLassoBox.syncUnderGesture(1, 0.5));
			console.log("loop", JSON.stringify(r));
			expect(r.idle, "the loop is down").toBe(false);
			expect(r.hostBefore).toBe(1);
			expect(r.hostAfter, "the pair stays").toBe(1);
			expect(r.after, "the loop's pixels stay").toBe(r.before);
			await p.evaluate(() => window.pdfLassoBox.lift());
		} finally {
			await p.close();
		}
	});
});
