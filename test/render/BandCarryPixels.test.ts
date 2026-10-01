/**
 * A BAND MOVE AT REST CARRIES ITS PIXELS: THE OVERLAP IS THE PRE-MOVE PICTURE SHIFTED, THE EXPOSED STRIPS ARE WHAT A FULL
 * RE-RASTER DRAWS, AND THE MOVE DOES NOT REDRAW THE WORLD.
 *
 * What it looks like: a sideways fling on a heavy note hitches each time the ink band repositions. With 1500 strokes on
 * the pane a band move re-rastered every stroke, 7 to 10 ms per move and four moves per 300 px fling (ScrollCost.test.ts,
 * the canvas-on finger-right arm). The fix carries the committed and highlight pixels by a whole number of device px, as a
 * band move under a live stroke already did, and repaints only the strips the move uncovers.
 *
 * One rig page, dpr 2, the Infinite Canvas on, strokes spread over the pane and past it. The scroller sits at one
 * scrollLeft, the committed canvas is read; the scroller jumps far enough that the band moves, a few frames run, the
 * canvas is read again; then the overlay is made to re-raster everything at the same camera and the canvas is read a
 * third time. THE CLAIMS, per direction:
 *   - the band moved and kept its size (premise);
 *   - where the old and new band overlap, every device pixel equals the pre-move pixel at the shifted position;
 *   - in the exposed strip, every device pixel equals the full re-raster's;
 *   both off the seam: 64 device px (32 css px, a little more than one rig stroke's length) either side of the line
 *   where the exposed strip meets the carried pixels. A stroke crossing that line is redrawn from the damage path,
 *   clipped to the strip, and its anti-aliased edge is a few levels of alpha off either picture (measured in the first
 *   runs: within about 24 device px of the line, up to 52 levels).
 *   The overlap is not compared with the full re-raster: it carries the seams of earlier moves as they were drawn, a
 *   few levels of edge alpha apart from a fresh raster (counted in the output as overlapFull);
 *   - the move's own repaints drew under half the committed draws of the full re-raster.
 *
 * CPU launch, on purpose. On a GPU canvas (the lag rig's flags, which ScrollCost.test.ts uses for the price) the carry's
 * pixels equal the parent's full redraw bit for bit, but every render made after the cell's first getImageData differs
 * from the move frame's at stroke edges, with or without the carry, so no later render can be the reference there
 * (inferred: the readback switches Chromium's rasteriser for that canvas). The CPU canvas does not switch.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/BandCarryPixels.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { surfaceExtents } from "../../src/inline/SurfaceExtent";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";
import { computeBBox } from "../../src/ink/Stroke";

installObsidianDom();

// Committed-canvas draw calls, counted while armed.
const DRAW = new Set(["stroke", "fill", "fillRect", "drawImage", "putImageData", "fillText", "strokeText", "strokeRect"]);
const counter = { on: false, canvas: null, draws: 0 };
const ctxProto = CanvasRenderingContext2D.prototype;
for (const k of DRAW) {
	const orig = ctxProto[k];
	if (typeof orig !== "function") continue;
	ctxProto[k] = function (...a) { if (counter.on && this.canvas === counter.canvas) counter.draws++; return orig.apply(this, a); };
}

const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300, STROKES = 400;
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}
const pixels = c => c.getContext("2d").getImageData(0, 0, c.width, c.height).data;

window.bandCarry = {
	async mount() {
		setPenInk(true); setScrollExpansionEnabled(true);
		setInlineTool("pen"); setInkColorHex("pen", "#222222"); setInkSizeMult("pen", 2);
		const path = "band-carry.md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:" + (HOST_LEFT + 1 / 3) + "px;margin-top:77.5px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const FENCE = String.fromCharCode(96).repeat(3);
		const doc = [FENCE + FENCE, FENCE + "7", "", "", "", "", "line 6 alpha beta gamma", "", "", "", ""].join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" } })] }) });
		installSizer(view);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { view, overlay, path };
		const PATH = [[0, 0], [9, 7], [18, 0], [27, 7]];
		const ink = [];
		for (let k = 0; k < STROKES; k++) {
			const ox = (k * 977) % 2600, oy = (k * 613) % 700;
			// The bbox a pen stroke gets (StrokeBuilder: computeBBox(points, width * 2)); a tighter one clips the stroke's own
			// damage repaint, and that clipped picture is what a carry would then keep.
			const points = PATH.map(([dx, dy], j) => ({ x: ox + dx, y: oy + dy, pressure: 0.5, t: j * 8 }));
			ink.push({ id: "bc-" + k, tool: "pen", color: "#222", width: 2, createdAt: 1, bbox: computeBBox(points, 4), points });
		}
		inlineInk.applyAdd(path, ink);
		// A bulk add from outside the overlay damages nothing on its own; the overlay's own add paths ask for the repaint.
		// Without it the committed canvas stays blank until a camera move, and a carry would keep the blank.
		overlay.scheduleRepaint();
		surfaceExtents.grow(path, { x: 1500, y: 0 });
		overlay.updateExtent(true);
		await settle(12);
		setPenInk(false);
		return { strokes: inlineInk.strokes(path).length, canvasMode: !!overlay.canvasMode, scrollWidth: view.scrollDOM.scrollWidth, clientWidth: view.scrollDOM.clientWidth };
	},
	/**
	 * Sit at \`from\`, read; jump to \`to\`, read; re-raster everything at that camera, read. Comparisons stay in the page.
	 * The seam is SEAM device px either side of the line between carried pixels and the exposed strip: a stroke crossing
	 * it is redrawn clipped to the strip, and its anti-aliased edge near there is not bit-equal to either picture.
	 */
	async move(from, to) {
		const SEAM = 64;
		const { view, overlay } = rig, sd = view.scrollDOM, cv = overlay.committedCanvas;
		sd.scrollTop = 0; sd.scrollLeft = from;
		await settle(10);
		const band0 = { ...overlay.band }, W = cv.width, H = cv.height;
		const backing = W / band0.width;
		const A = pixels(cv);
		counter.canvas = cv; counter.draws = 0; counter.on = true;
		sd.scrollLeft = to;
		await settle(10);
		counter.on = false;
		const moveDraws = counter.draws, band1 = { ...overlay.band }, cam1 = { ...overlay.camera.snapshot };
		const B = pixels(cv);
		counter.draws = 0; counter.on = true;
		overlay.damage.addAll(); overlay.lastPaintCam = null; overlay.repaint();
		await settle(2);
		counter.on = false;
		const fullDraws = counter.draws, cam2 = { ...overlay.camera.snapshot };
		const C = pixels(cv);
		const sx = Math.round((band1.left - band0.left) * backing), sy = Math.round((band1.top - band0.top) * backing);
		const edgeX = sx < 0 ? -sx : W - sx;
		const r = { inkedBefore: 0, inked: 0, overlap: 0, strip: 0, seam: 0, shiftedOff: 0, shiftedSeam: 0, fullOff: 0, fullSeam: 0, fullMax: 0, overlapFull: 0, bad: [] };
		const same = (P, i, Q, j) => P[i] === Q[j] && P[i + 1] === Q[j + 1] && P[i + 2] === Q[j + 2] && P[i + 3] === Q[j + 3];
		const at = (P, i) => Array.from(P.slice(i, i + 4)).join("/");
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4;
			if (A[i + 3]) r.inkedBefore++;
			if (C[i + 3]) r.inked++;
			const inSeam = Math.abs(x - edgeX) < SEAM;
			if (inSeam) r.seam++;
			const ox = x + sx, oy = y + sy;
			const inOld = ox >= 0 && ox < W && oy >= 0 && oy < H;
			if (inOld) {
				r.overlap++;
				const j = (oy * W + ox) * 4;
				if (!same(B, i, A, j)) {
					if (inSeam) r.shiftedSeam++;
					else { r.shiftedOff++; if (r.bad.length < 6) r.bad.push("overlap " + x + "," + y + " now " + at(B, i) + " before " + at(A, j)); }
				}
			} else r.strip++;
			if (!same(B, i, C, i)) {
				// Info only in the overlap: it holds the seams of earlier moves, carried as they were drawn.
				if (inOld) r.overlapFull++;
				else if (inSeam) r.fullSeam++;
				else { for (let c = 0; c < 4; c++) r.fullMax = Math.max(r.fullMax, Math.abs(B[i + c] - C[i + c])); r.fullOff++; if (r.bad.length < 6) r.bad.push("strip " + x + "," + y + " now " + at(B, i) + " full " + at(C, i)); }
			}
		}
		return { band0, band1, cam1, cam2, backing, sx, sy, W, H, moveDraws, fullDraws, ...r, scrollLeft: sd.scrollLeft };
	},
};
`;

let browser: Browser, script: string;

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "bandCarryPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).bandCarry[m](...a), [method, args] as const);

const MOVES = [
	{ name: "the scroll falls (finger right)", from: 900, to: 600 },
	{ name: "the scroll rises (finger left)", from: 300, to: 600 },
] as const;
for (const m of MOVES) {
	it(`a band move at rest when ${m.name} carries its pixels and redraws only the exposed strips`, async () => {
		const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: 2, hasTouch: true });
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
		try {
			await page.setContent('<!doctype html><body class="theme-dark" style="margin:0; --font-text-size:19px; --background-modifier-border:#777777"></body>');
			await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
			await page.addScriptTag({ content: script });
			const mounted = await call(page, "mount") as any;
			const r = await call(page, "move", m.from, m.to) as any;
			const brief = `\n${JSON.stringify({ mounted, ...r })}`;
			expect(errors).toEqual([]);
			expect(mounted.canvasMode, "premise: the Infinite Canvas is on").toBe(true);
			expect(mounted.scrollWidth - mounted.clientWidth, `premise: the scroller has a horizontal range${brief}`).toBeGreaterThan(1000);
			expect(r.scrollLeft, `premise: the scroll reached the target${brief}`).toBeCloseTo(m.to, 0);
			expect(r.band1.left, `premise: the band moved${brief}`).not.toBe(r.band0.left);
			expect([r.band1.width, r.band1.height], `premise: the band kept its size${brief}`).toEqual([r.band0.width, r.band0.height]);
			expect(r.inked, `premise: the canvas holds ink${brief}`).toBeGreaterThan(10_000);
			expect(r.sy, `premise: a sideways move${brief}`).toBe(0);
			expect(r.inkedBefore, `premise: the picture before the move holds ink${brief}`).toBeGreaterThan(10_000);
			expect(r.strip, `premise: the move exposed a strip${brief}`).toBeGreaterThan(0);
			expect(r.cam2, `premise: the full re-raster ran at the camera the move left${brief}`).toEqual(r.cam1);
			// THE CLAIMS. The cost first: at a move that re-rasters the world this is the line that goes red.
			expect(r.moveDraws, `the move drew under half of a full re-raster's ${r.fullDraws} committed draws${brief}`).toBeLessThan(r.fullDraws / 2);
			expect(r.shiftedOff, `overlap pixels off the seam that differ from the pre-move picture shifted by (${r.sx}, ${r.sy}) device px${brief}`).toBe(0);
			expect(r.fullOff, `exposed-strip pixels off the seam that differ from a full re-raster${brief}`).toBe(0);
		} finally { await page.close(); }
	}, 240_000);
}
