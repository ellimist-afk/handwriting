/**
 * ATTACHED INK'S TILES DRAW WHAT ONE SPRITE WOULD.
 *
 * What it looks like: a tall attached group is held as tiles of 1024 device px. Were a tile to draw only the strokes whose
 * box reaches it, a stroke whose anti-aliased edge or width floor crosses a seam past its box would be cut along the seam,
 * a hairline gap in thin ink. Were a tile copied a pixel off, the seam would show as a step.
 *
 * One page, no editor: the attached layer paints one group, whole, onto a real canvas at backing 2 and zoom 0.6 (below
 * 100 percent, so the width floor engages). The group has a stroke across the vertical seam, a stroke across the
 * horizontal seam, and one thin stroke under the floor whose box ends 0.2 device px above the horizontal seam. The
 * reference is one drawCommitted of the same members into one canvas at the sprite's origin, copied to the same place.
 * THE CLAIM: within 1 device px of a seam no byte differs by more than 8 levels; elsewhere no
 * byte differs by more than 2, and only in alpha; the ink pixel count is equal. Premises: the group holds four tiles;
 * both canvases hold ink; the reference holds ink in the first device row under the horizontal seam where the thin
 * stroke lies.
 *
 * Why not zero (measured at 6a4cbaed, CPU raster on both sides): 31 bytes differ, at most 5 levels; 15 within 1 px of a
 * seam, the rest 1 or 2 levels of alpha on the two strokes that cross a seam, up to 92 px along them. The geometry is the
 * same both ways (one point's device x and y through the tile camera and the sprite camera agree to 1.1e-13). The cause
 * is Skia's anti-aliasing of one long path clipped at the canvas edge: the same path rasterised whole and in a clipped
 * canvas accumulates coverage a level or two apart. Not a cut, and 2 of 255 is not visible. The plants differ by 255.
 *
 * Plants: the tile build culling by the bare tile, and a tile copied one device px right, must
 * each turn it red. No timing claim: runs under a plain lock.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/AttachTileSeam.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";

const PAGE = `
import { AttachedLayer, SPRITE_PAD, TILE_DEVICE_PX } from "../../src/inline/InkOverlayAttachedLayer";
import { drawCommitted } from "../../src/ink/StrokeRenderer";
import { computeBBox } from "../../src/ink/Stroke";

const BACKING = 2, ZOOM = 0.6, K = ZOOM * BACKING, FLOOR = { backing: BACKING, dpr: BACKING };
const stroke = (id, pts, width) => {
	const points = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#ffffff", width, points, bbox: computeBBox(points, width * 2), createdAt: 1 };
};
const line = (x0, y0, x1, y1, n) => Array.from({ length: n }, (_, i) => [x0 + ((x1 - x0) * i) / (n - 1), y0 + ((y1 - y0) * i) / (n - 1)]);

window.tileSeam = {
	run() {
		// The top-left stroke fixes the sprite's origin: its box starts at (-2, -2), so the origin is SPRITE_PAD css px above.
		const corner = stroke("corner", [[0, 0], [4, 2], [8, 0], [12, 2]], 1);
		const ox = corner.bbox.x - SPRITE_PAD / ZOOM, oy = corner.bbox.y - SPRITE_PAD / ZOOM;
		const seam = TILE_DEVICE_PX / K;
		const across = stroke("across", line(ox + seam - 150, oy + 300, ox + seam + 150, oy + 310, 40), 2);
		const down = stroke("down", line(ox + 300, oy + seam - 150, ox + 310, oy + seam + 150, 40), 2);
		const far = stroke("far", [[ox + seam + 150, oy + seam + 150], [ox + seam + 160, oy + seam + 152]], 1);
		// Thin, under the floor: its box (width times 2 of pad) ends 0.2 device px above the horizontal seam.
		const thinW = 0.05, thinY = oy + seam - 0.2 / K - thinW * 2;
		const thin = stroke("thin", line(ox + 100, thinY, ox + 400, thinY, 60), thinW);
		const members = [corner, across, down, far, thin];
		const cam = { x: ox - 20, y: oy - 20, zoom: ZOOM };
		const cssW = 1100, cssH = 1100, W = cssW * BACKING, H = cssH * BACKING;
		// Every canvas, tiles and reference alike, read back on the CPU raster: one rasteriser for both sides.
		const mk = () => { const c = document.createElement("canvas"); c.getContext("2d", { willReadFrequently: true }); return c; };
		const pen = mk(), hl = mk();
		const layer = new AttachedLayer(pen, hl, mk);
		const group = { id: "seam", members, offset: { dx: 0, dy: 0 }, shown: () => members };
		layer.paint(cam, [group], true, FLOOR, { backingW: W, backingH: H, backing: BACKING, cssW, cssH });
		// The reference: one canvas for the whole sprite, drawn once, copied where the layer copies the sprite's origin.
		const sprite = mk(); sprite.width = 1600; sprite.height = 1600;
		const sctx = sprite.getContext("2d");
		sctx.setTransform(BACKING, 0, 0, BACKING, 0, 0);
		drawCommitted(sctx, { x: ox, y: oy, zoom: ZOOM }, members, 800, 800, true, "pen", false, FLOOR);
		const ref = mk(); ref.width = W; ref.height = H;
		const rctx = ref.getContext("2d");
		rctx.drawImage(sprite, Math.round((ox - cam.x) * K), Math.round((oy - cam.y) * K));
		const a = pen.getContext("2d").getImageData(0, 0, W, H).data, b = rctx.getImageData(0, 0, W, H).data;
		let diff = 0, maxDelta = 0, inkA = 0, inkB = 0, nearSeam = 0, within1 = 0, over = 0;
		const away = [];
		const sx = Math.round((ox - cam.x) * K) + TILE_DEVICE_PX, sy = Math.round((oy - cam.y) * K) + TILE_DEVICE_PX;
		for (let i = 0; i < a.length; i++) {
			const d = Math.abs(a[i] - b[i]);
			if (d) {
				diff++;
				if (d > maxDelta) maxDelta = d;
				const px = (i >> 2) % W, py = Math.floor((i >> 2) / W);
				const dist = Math.min(Math.abs(px - sx), Math.abs(py - sy));
				if (dist <= 8) nearSeam++;
				if (dist <= 1) { within1++; if (d > 8) over++; }
				else {
					if (d > 2 || (i & 3) !== 3) over++;
					if (away.length < 40) away.push([px, py, i & 3, a[i], b[i], dist]);
				}
			}
			if ((i & 3) === 3) { if (a[i]) inkA++; if (b[i]) inkB++; }
		}
		// The first device row under the horizontal seam, over the thin stroke's columns.
		const dy0 = Math.round((oy - cam.y) * K) + TILE_DEVICE_PX, dx0 = Math.round((ox - cam.x) * K);
		let under = 0;
		for (let x = dx0 + Math.ceil(110 * K); x < dx0 + Math.floor(390 * K); x++) if (b[(dy0 * W + x) * 4 + 3]) under++;
		// One point's device x and y both ways, the tile's camera against the sprite's, for every member
		// point in every tile: the largest gap. Tiles at whole device px from the sprite origin, pad as the layer pads.
		const pad = SPRITE_PAD * BACKING;
		let camGap = 0;
		for (const s of members) for (const p of s.points) for (const tx of [0, TILE_DEVICE_PX]) for (const ty of [0, TILE_DEVICE_PX]) {
			const tcx = ox + (tx - pad) / K, tcy = oy + (ty - pad) / K;
			const viaTileX = (p.x - tcx) * K - pad + tx, viaTileY = (p.y - tcy) * K - pad + ty;
			camGap = Math.max(camGap, Math.abs(viaTileX - (p.x - ox) * K), Math.abs(viaTileY - (p.y - oy) * K));
		}
		return { tiles: layer.counts.tiles, built: layer.counts.built, byPath: layer.counts.byPath, diff, maxDelta, nearSeam, within1, over, inkA, inkB, under, camGap, seams: [sx, sy], away };
	},
};
`;

let browser: Browser, script: string;

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "tileSeamPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => { await browser?.close(); });

it("a tiled group's copy matches one drawCommitted of its members at the sprite's origin across both seams, within Skia's clip-edge anti-aliasing", async () => {
	const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 });
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
	try {
		await page.setContent("<!doctype html><body style=\"margin:0\"></body>");
		await page.addScriptTag({ content: script });
		const r = await page.evaluate(() => (window as any).tileSeam.run()) as Record<string, number>;
		const brief = `\n${JSON.stringify(r)}`;
		expect(errors).toEqual([]);
		expect([r.built, r.tiles, r.byPath], `premise: one build of four tiles, nothing by path${brief}`).toEqual([1, 4, 0]);
		expect(r.inkB, `premise: the reference holds ink${brief}`).toBeGreaterThan(1000);
		expect(r.under, `premise: the thin stroke's floor reaches the first row under the seam${brief}`).toBeGreaterThan(0);
		expect(r.inkA, `tiled and untiled differ: ink pixel count${brief}`).toBe(r.inkB);
		expect(r.over, `tiled and untiled differ: past 8 levels at a seam or 2 of alpha elsewhere${brief}`).toBe(0);
	} finally {
		await page.close();
	}
}, 120_000);
