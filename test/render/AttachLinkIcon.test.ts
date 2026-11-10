/**
 * THE LINK ICON ON A REAL CANVAS, AT 100 AND 200 PERCENT.
 *
 * What it looks like: three attached groups down a dark page, the first selected. The two unselected groups each show a
 * small grey link icon (two rings, the theme's --text-muted) just outside their top-left corner; the selected one shows
 * none. At 200 percent the icons are the same size on screen as at 100: only their place moves with the ink.
 *
 * One page, no editor: a real canvas at backing 2, the real attachChromeOf (which keeps the marks) and paintHeldTags
 * (which draws them on the committed layer) over a surface object holding what the overlay holds. Read back from the
 * canvas: the icon's painted pixels near each group's corner, their extent in css px and their colour.
 * Screenshots of both zooms go to HW_ATTACH_ICON_SHOTS when it names a folder.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/AttachLinkIcon.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";

declare const process: { env: Record<string, string | undefined> };
const SHOTS = process.env.HW_ATTACH_ICON_SHOTS ?? "";

const PAGE = `
import { attachChromeOf, paintHeldTags } from "../../src/inline/AttachDecoration";
import { computeBBox } from "../../src/ink/Stroke";

const BACKING = 2, CSS_W = 900, CSS_H = 700;

const stroke = (id, x, y) => {
	const points = [0, 1, 2, 3, 4, 5].map((i) => ({ x: x + i * 20, y: y + (i % 2) * 18, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#ffffff", width: 2, points, bbox: computeBBox(points, 2), createdAt: 1 };
};

window.icon = {
	run(zoom) {
		document.body.innerHTML = "";
		const canvas = document.body.appendChild(document.createElement("canvas"));
		canvas.width = CSS_W * BACKING; canvas.height = CSS_H * BACKING;
		canvas.style.cssText = "width:" + CSS_W + "px;height:" + CSS_H + "px;display:block";
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		ctx.setTransform(BACKING, 0, 0, BACKING, 0, 0);
		// Three groups of two strokes, 100 apart down the page; g0 is selected.
		const strokes = [], list = [], members = new Map(), memberMap = new Map();
		for (let g = 0; g < 3; g++) {
			const ms = [stroke("s" + g + "a", 60, 40 + g * 100), stroke("s" + g + "b", 90, 60 + g * 100)];
			for (const s of ms) { strokes.push(s); memberMap.set(s.id, "g" + g); }
			members.set("g" + g, ms);
			list.push({ v: 1, id: "g" + g, strokeIds: ms.map((s) => s.id), target: { kind: "paragraph", from: g * 10, to: g * 10 + 8, text: "", before: "", after: "" }, ref: { x: 0, y: 0 }, layout: { width: 900, font: 16 }, probe: { id: ms[0].id, x: 0, y: 0 } });
		}
		const surface = {
			filePath: () => "icon-" + zoom + ".md",
			lineAnchors: {
				follow: { setList() {}, memberMap, groupOffset: () => ({ dx: 0, dy: 0 }), followsText: () => true, generation: 1 },
				freeFor: () => ({ free: [], members }),
			},
			selection: { strokeIds: members.get("g0").map((s) => s.id), revision: 1, isEmpty: false },
			view: { dom: document.body, dispatch() {} },
			refreshStrip() {},
			camera: { snapshot: { x: 0, y: 0, zoom } }, cssScale: 1, damage: { addRect() {} }, scheduleRepaint() {},
		};
		const cam = { x: 0, y: 0, zoom };
		attachChromeOf(surface, list, strokes, 1);
		paintHeldTags(surface, ctx, cam, "all", CSS_W, CSS_H);
		// Each group's box corner on screen, css px, and the painted pixels in the 24 css px square up and left of it.
		const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		const out = [];
		for (let g = 0; g < 3; g++) {
			const ms = members.get("g" + g);
			const bx = Math.min(...ms.map((s) => s.bbox.x)), by = Math.min(...ms.map((s) => s.bbox.y));
			const cx = bx * zoom, cy = by * zoom;
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, best = null, n = 0;
			for (let py = Math.floor((cy - 24) * BACKING); py < Math.ceil((cy + 4) * BACKING); py++) {
				for (let px = Math.floor((cx - 24) * BACKING); px < Math.ceil((cx + 4) * BACKING); px++) {
					if (px < 0 || py < 0) continue;
					const i = (py * canvas.width + px) * 4, a = img[i + 3];
					if (a < 40) continue;
					n++;
					x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
					if (!best || a > best[3]) best = [img[i], img[i + 1], img[i + 2], a];
				}
			}
			out.push({ group: "g" + g, corner: [cx, cy], pixels: n,
				extent: n ? { left: x0 / BACKING - cx, top: y0 / BACKING - cy, right: (x1 + 1) / BACKING - cx, bottom: (y1 + 1) / BACKING - cy, width: (x1 + 1 - x0) / BACKING, height: (y1 + 1 - y0) / BACKING } : null,
				colour: best });
		}
		return out;
	},
};
`;

let browser: Browser, script: string;

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "attachLinkIconPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => { await browser?.close(); });

it("the link icon at 100 and 200 percent: on the unselected groups only, the same css size, muted, outside the corner", async () => {
	const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 2 });
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent("<!doctype html><body class=\"theme-dark\" style=\"margin:0;background:#202020;--background-primary:#202020;--text-normal:#dadada;--text-error:#fb464c;--text-muted:#8a8a8a\"></body>");
		await page.addScriptTag({ content: script });
		const runs: Record<string, any>[][] = [];
		for (const zoom of [1, 2]) {
			runs.push(await page.evaluate((z) => (window as any).icon.run(z), zoom) as Record<string, any>[]);
			if (SHOTS) await page.screenshot({ path: `${SHOTS}/attach-link-icon-${zoom * 100}.png` });
		}
		const brief = `\n${JSON.stringify(runs)}`;
		console.log(`[attach-link-icon] ${JSON.stringify(runs)}`);
		expect(errors).toEqual([]);
		for (const [k, run] of runs.entries()) {
			const at = `at ${(k + 1) * 100} percent`;
			expect(run.map((g) => g.pixels > 0), `[g0 selected, g1, g2] icon painted ${at}${brief}`).toEqual([false, true, true]);
			for (const g of run.slice(1)) {
				expect(g.extent.right <= 0 && g.extent.bottom <= 0, `${g.group}'s icon clear of its box, up and left, ${at}${brief}`).toBe(true);
				expect(g.colour.slice(0, 3), `${g.group}'s icon in --text-muted ${at}${brief}`).toEqual([0x8a, 0x8a, 0x8a]);
			}
		}
		const size = (run: Record<string, any>[]) => run.slice(1).map((g) => [g.extent.width, g.extent.height]);
		const [one, two] = [size(runs[0]!), size(runs[1]!)];
		for (const [i, [w, h]] of one.entries()) {
			expect(Math.abs(w! - two[i]![0]!) <= 0.5 && Math.abs(h! - two[i]![1]!) <= 0.5, `the icon's css size the same at 200 percent as at 100: ${JSON.stringify([one, two])}`).toBe(true);
			expect(w! >= 10 && w! <= 16, `the icon about 12 css px across: ${w}`).toBe(true);
		}
	} finally {
		await page.close();
	}
}, 120_000);
