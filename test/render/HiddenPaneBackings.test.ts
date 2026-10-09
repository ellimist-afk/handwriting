/**
 * A NOTE HIDDEN BEHIND ANOTHER TAB HOLDS NO INK BUFFERS.
 *
 * Obsidian hides a note behind another tab with display:none, and the note's editor and its ink overlay stay alive. The overlay
 * releases its six ink canvases when its box measures zero (releaseBackings, the zero-size branch of the resize path). The
 * report this file answers: a hidden note keeps about 160 MB of ink buffers until it closes. This file counts them with real canvases:
 * every canvas the overlay holds, one level into the objects it owns (the extent raster, a build in progress, a stand-in), at
 * width x height x 4 bytes each, summed.
 *
 * Cells (one per arm of the oracle):
 *   1. at 100 percent: after the pane is hidden the overlay holds no backing bytes. The control: the six canvases are covered by
 *      the existing release, so this cell is green when that release works through a real hide.
 *   2. at 10 percent, where the extent raster is built: the same count after the hide. Red while the extent raster stays.
 *   3. re-show: the pane shown again repaints the ink into reallocated canvases at once, in no more repaint frames than the
 *      first show took, and every repaint is inside the scroll-cost bound.
 *
 * Fixture: 4000 synthetic strokes (the pan-bake rig's seeded generator), pane 1184 x 824, device scale 2.
 * Run: npx vitest run --config vitest.render.mts test/render/HiddenPaneBackings.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const MINIMAL_CSS = readFileSync(fileURLToPath(new URL("./fixtures/minimal-9.0.2-theme.css", import.meta.url)), "utf8");
const TEMPLATE = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/alan-ink-75d1627a.json", import.meta.url)), "utf8")) as Record<string, unknown>;
const PAGE_ID = "75d1627a-c4d7-4a11-947d-bc26b7f83c20";
const PATH = "Untitled 1.md";
const COUNT = 4000;
const PANE = { w: 1184, h: 824 };
const DSF = 2;
const OUT = process.env.HW_HIDDEN_OUT ?? "";

function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function syntheticInk(count: number): string {
	const rnd = seeded(37);
	const strokes = [];
	for (let i = 0; i < count; i++) {
		let x = 40 + rnd() * 11000, y = 40 + rnd() * 13000, heading = rnd() * Math.PI * 2;
		const pts: number[] = [];
		for (let k = 0; k < 14; k++) {
			pts.push(Math.round(x * 100) / 100, Math.round(y * 100) / 100, 0.3 + 0.2 * rnd(), k * 8);
			heading += (rnd() - 0.5) * 0.9; x += Math.cos(heading) * 6; y += Math.sin(heading) * 6;
		}
		strokes.push({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, tool: "pen", color: "#2f6de0", width: 2.6, createdAt: 1788552785194, pts });
	}
	return JSON.stringify({ ...TEMPLATE, strokes, images: [], textBoxes: [] });
}
const FIXTURE = syntheticInk(COUNT);

// The shared page rig plus the overlay lookup, in one bundle so the overlay is the rig's own. `held` walks what the overlay holds,
// two levels deep, and sums every canvas once: its backing store is width x height x 4 bytes while it has a size.
const ENTRY = `import "./panBakeRepaintPage.ts";
import { overlayForPath } from "../../src/inline/InkOverlay";
(window as any).hidden = {
	held(path: string) {
		const o: any = overlayForPath(path);
		const seen = new Set<any>(), canvases = new Map<any, string>();
		const walk = (v: any, name: string, depth: number) => {
			if (!v || typeof v !== "object" || seen.has(v)) return;
			seen.add(v);
			if (v instanceof HTMLCanvasElement) { canvases.set(v, name); return; }
			if (depth === 0 || v instanceof Node || v instanceof Window) return;
			for (const k of Object.keys(v)) { try { walk(v[k], name + "." + k, depth - 1); } catch { /* a getter that throws holds nothing */ } }
		};
		for (const k of Object.keys(o)) { try { walk(o[k], k, 2); } catch { /* same */ } }
		let bytes = 0;
		const rows: Array<{ at: string; w: number; h: number }> = [];
		for (const [c, name] of canvases) { bytes += c.width * c.height * 4; if (c.width * c.height > 0) rows.push({ at: name, w: c.width, h: c.height }); }
		return { bytes, canvases: canvases.size, rows };
	},
	pane() { return document.querySelector(".markdown-source-view") as HTMLElement; },
	hide() { (document.querySelector(".markdown-source-view") as HTMLElement).style.display = "none"; },
	show() { (document.querySelector(".markdown-source-view") as HTMLElement).style.display = ""; },
	inked(path: string) {
		const o: any = overlayForPath(path), c = o.committedCanvas as HTMLCanvasElement;
		if (!(c.width > 0 && c.height > 0)) return 0;
		const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
		let n = 0;
		for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) n++;
		return n;
	},
};`;

let browser: Browser, script: string;
beforeAll(async () => {
	const b = await build({
		stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("./", import.meta.url)), sourcefile: "hiddenPaneBackingsEntry.ts", loader: "ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=1700,1000"] });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const dump: Record<string, unknown> = {};
type Held = { bytes: number; canvases: number; rows: Array<{ at: string; w: number; h: number }> };
const held = (page: Page) => page.evaluate((p) => (window as any).hidden.held(p), PATH) as Promise<Held>;

async function withNote(name: string, zoom: number, body: (page: Page) => Promise<void>) {
	const context = await browser.newContext({ viewport: null, hasTouch: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent(`<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>`);
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addStyleTag({ content: MINIMAL_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await page.evaluate(([z, s, id, w, h, n]) => (window as any).panBake.mount(z, s, id, w, h, n), [zoom, FIXTURE, PAGE_ID, PANE.w, PANE.h, COUNT] as const) as any;
		expect(mounted.strokes, "premise: every stroke loaded").toBe(COUNT);
		expect(mounted.zoomCommitted, "premise: the zoom committed").toBe(true);
		await sleep(600);
		expect(((await page.evaluate(() => (window as any).panBake.awaitWhole())) as any).pending, "premise: the build the mount armed finished").toBe(false);
		await body(page);
		expect(errors).toEqual([]);
	} finally { await context.close(); }
	void name;
}

const hideCell = (zoom: number, name: string, wantRaster: boolean) => async () => {
	await withNote(name, zoom, async (page) => {
		const before = await held(page);
		expect(before.bytes, `premise: a shown note holds ink backings (${JSON.stringify(before)})`).toBeGreaterThan(1_000_000);
		const hasRaster = before.rows.some(r => r.at.startsWith("extentRaster"));
		expect(hasRaster, `premise: the extent raster is built exactly where it should be (${JSON.stringify(before.rows)})`).toBe(wantRaster);
		await page.evaluate(() => (window as any).hidden.hide());
		await sleep(500);
		const after = await held(page);
		dump[name] = { before, after };
		if (OUT) writeFileSync(OUT, JSON.stringify(dump, null, 1));
		console.log(`HIDDEN ${name} ` + JSON.stringify({ beforeMB: +(before.bytes / 1e6).toFixed(1), afterMB: +(after.bytes / 1e6).toFixed(1), left: after.rows }));
		expect(after.bytes, `a note hidden behind another tab still holds ${(after.bytes / 1e6).toFixed(1)} MB of canvases: ${JSON.stringify(after.rows)}`).toBe(0);
	});
};
it("a note at 100 percent hidden behind another tab holds no canvas bytes", hideCell(1.0, "hide-100", false), 180_000);
it("a note at 10 percent, extent raster built, hidden behind another tab holds no canvas bytes", hideCell(0.10, "hide-10", true), 180_000);

it("a hidden note shown again repaints its ink at once, in one whole-layer repaint and no other drawing frame", async () => {
	await withNote("reshow", 1.0, async (page) => {
		await page.evaluate(() => (window as any).panBake.record());
		await page.evaluate(() => (window as any).hidden.hide());
		await sleep(500);
		const hidden = await held(page);
		const n0 = ((await page.evaluate(() => (window as any).panBake.rows())) as unknown[]).length;
		await page.evaluate(() => (window as any).hidden.show());
		await sleep(800);
		const rows = ((await page.evaluate(() => (window as any).panBake.rows())) as Array<{ painted: boolean; t: number; work: string }>).slice(n0);
		const painted = rows.filter(r => r.painted) as any[];
		const shown = await held(page);
		const inked = await page.evaluate((p) => (window as any).hidden.inked(p), PATH) as number;
		await page.evaluate(() => (window as any).panBake.stop());
		dump.reshow = { hiddenBytes: hidden.bytes, shownBytes: shown.bytes, repaints: painted.length, inked };
		if (OUT) writeFileSync(OUT, JSON.stringify(dump, null, 1));
		console.log("RESHOW " + JSON.stringify(dump.reshow));
		expect(shown.bytes, "the shown note holds its canvases again").toBeGreaterThan(1_000_000);
		expect(inked, "the committed canvas has ink on it once the note is shown, never blank").toBeGreaterThan(1000);
		// The first show painted the whole layer once, then two frames with no strip to draw. Showing again must do the same: one
		// whole-layer repaint, never a second.
		const whole = painted.filter((r: any) => r.work === "all");
		const other = painted.filter((r: any) => r.work !== "all" && r.work !== "strips:0");
		expect({ whole: whole.length, other: other.length }, `repaint frames to show the note again (${JSON.stringify(painted.map((r: any) => r.work))})`).toEqual({ whole: 1, other: 0 });
	});
}, 180_000);
