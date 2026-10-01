/**
 * A NOTE WITH NO HIGHLIGHTER INK DRAWS TWO FULL-SIZE LAYERS, AND NO INK CANVAS IS HIDDEN TO GET THERE.
 *
 * What it costs the user: every frame that scrolls, bounces or writes, the compositor blends each full-size ink canvas
 * of the note. There were four (committed ink, the committed highlight layer, the wet layer, the wet highlight layer);
 * on a note with no highlighter ink the highlight pair is blank on every frame. The pair now keeps a 0x0 backing until
 * the note needs it, which leaves two. An earlier try hid blank canvases instead; a canvas that is drawn while hidden
 * is never committed by the compositor, Chromium then builds a per-canvas rate limiter for it, and every later canvas
 * frame blocked the main thread on the GPU (SharedContextRateLimiter::Tick): writing on the device was ruined.
 *
 * THE CELL: OverscrollBounce.test.ts's page (400 lines of monospace 16/24), the pen only, device pixel ratio 2. Traced
 * with the categories the plugin's own ink trace records (src/diag/InkTrace.ts): ten pen strokes, one frame per
 * sample, then one touch fling into the top edge, pen up, a settle. Claims: (i) at rest, no ink canvas (committed,
 * wet, highlight, wet highlight, wet tile) has computed visibility hidden; (ii) the last layer tree the compositor
 * recorded after the writing shows exactly two TextureLayerImpl layers of the band's size that draw content (committed
 * and wet), and the last one after the fling shows one (committed: the fling released the wet canvas to 0x0, arm W).
 * The writing and the fling are traced separately for that. Premises, each asserted: ten
 * strokes stored, the fling played a spring, each trace holds layer trees, the band's layers are found.
 *
 * NOT ASSERTED: the rate limiter's own events. The count of SharedContextRateLimiter::Tick and their time are printed
 * in the readout only. Headless Chromium has no swap chain, so the limiter never waits here: the same count and a
 * fraction of a millisecond came out with two layers, with four, and with the hiding rule planted. The proof that the
 * limiter stays quiet is the device's own ink trace, read after a run on the device.
 *
 * On Windows the browser runs with the GPU (the flags of the lag rig), elsewhere (CI's Linux runner) with software
 * canvases; both claims hold on either.
 *
 * Plant HW_LAZY_HIGHLIGHT_PLANT_HIDE_BLANK=1: the hide-blank-layers rule that failed on the device, applied on top of
 * the page's InkOverlay.ts as the bundle is built. Both claims must go red under it: a hidden canvas, and one full-size
 * layer instead of two after the writing (after the fling the wet canvas is 0x0 either way, so that read does not see the
 * plant). HW_LAZY_HIGHLIGHT_OUT=<file> writes the readout; HW_LAZY_HIGHLIGHT_TRACE=<file> keeps the fling's trace, and
 * <file>.write.json the writing's.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/LazyHighlightPairTrace.test.ts
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";
import { INK_TRACE_CATEGORIES } from "../../src/diag/InkTrace";

declare const process: { env: Record<string, string | undefined>; platform: string };

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

installObsidianDom();
const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const rendered = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const PANE_W = 1397.5, PANE_H = 800;
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}
const dims = c => c.width + "x" + c.height;

window.lazyHighlight = {
	async mount() {
		setPenInk(true); setScrollExpansionEnabled(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 2);
		const path = "lazy-highlight-trace.md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:300px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const doc = Array.from({ length: 400 }, (_, i) => "line " + i + " alpha beta gamma delta epsilon zeta").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" },
				".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		installSizer(view);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, path };
		return this.layers();
	},
	/** The four full-size canvases as the page holds them (backing and on-screen box), and every ink canvas the rule could hide. */
	layers() {
		const o = rig.overlay, box = c => { const r = c.getBoundingClientRect(); return Math.round(r.width) + "x" + Math.round(r.height); };
		const inkCanvases = { committed: o.committedCanvas, wet: o.wetCanvas, highlight: o.highlightCanvas, highlightWet: o.highlightWetCanvas, wetTile: o.wetTileCanvas };
		const hidden = Object.entries(inkCanvases).filter(([, c]) => !c || getComputedStyle(c).visibility === "hidden").map(([name]) => name);
		return { dpr: devicePixelRatio, committed: dims(o.committedCanvas), wet: dims(o.wetCanvas), highlight: dims(o.highlightCanvas),
			highlightWet: dims(o.highlightWetCanvas), box: box(o.committedCanvas), strokes: inlineInk.strokes(rig.path).length, hidden };
	},
	/** Ten pen strokes, each sample on its own frame, the way a 60 Hz pen reaches the page. */
	async write() {
		const r = rig.view.scrollDOM.getBoundingClientRect();
		const pen = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
			pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));
		for (let s = 0; s < 10; s++) {
			const x = r.left + 200 + (s % 5) * 60, y = r.top + 120 + s * 40;
			pen("pointerdown", x, y, 1); await frame();
			for (let i = 1; i <= 12; i++) { pen("pointermove", x + 25 * i, y + 6 * Math.sin(i / 2), 1); await frame(); }
			pen("pointerup", x + 300, y, 0); await frame();
		}
		await settle(8);
		return this.layers();
	},
	/** One touch fling into the top edge (BounceRepaint.test.ts's fling), then the spring to its end. */
	async flingTop() {
		const { view, overlay } = rig, router = overlay.router, sd = view.scrollDOM;
		setPenInk(false);
		sd.scrollTop = 0; sd.scrollLeft = 0;
		await settle(8);
		// The assist guard re-arms a second after the last lift, on a real timer (OverscrollBounce.test.ts, giveRegrab).
		await new Promise(res => setTimeout(res, 1200));
		await settle(4);
		const r = sd.getBoundingClientRect(), x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
		const finger = (type, py, buttons) => {
			const e = { type, pointerType: "touch", pointerId: 951, isPrimary: true, clientX: x0, clientY: py, pressure: buttons === 0 ? 0 : 0.5,
				buttons, button: 0, timeStamp: performance.now(), tiltX: 0, tiltY: 0, width: 0, height: 0, target: sd, preventDefault() {}, stopPropagation() {} };
			if (type === "pointerdown") router.pointerDown(e); else if (type === "pointermove") router.pointerMove(e); else router.pointerUpOrCancel(e);
		};
		finger("pointerdown", y0, 1);
		for (let i = 1; i <= 16; i++) { await new Promise(res => setTimeout(res, 16)); finger("pointermove", y0 + 30 * i, 1); }
		finger("pointerup", y0 + 480, 0);
		let springFrames = 0, ended = -1;
		for (let j = 0; j < 120; j++) {
			await rendered();
			const b = overlay.overscrollBounceReadout();
			if (b.active) springFrames++;
			if (springFrames > 0 && !b.active && router.flingRaf === 0) { ended = j; break; }
		}
		await settle(12);
		return { springFrames, ended, ...this.layers() };
	},
};
`;

/**
 * The hide-blank-layers rule that failed on the device (its InkOverlay.ts change), re-expressed as anchored insertions
 * on this file. Each anchor must be found exactly once, or the plant is refused.
 */
const PLANT_HIDE_BLANK: { from: string; to: string }[] = [
	{ from: "\tprivate hideBlankPinchLayers(): void {\n\t\tthis.restorePinchLayers();\n",
		to: "\tprivate hideBlankPinchLayers(): void {\n\t\tthis.restorePinchLayers();\n\t\tthis.setLayerVisible(this.wetCanvas, true);\n" },
	{ from: "\t\tthis.wet.beforeWrite = restore;this.highlightWet.beforeWrite = restore;this.tail.beforeWrite = restore;\n\t}\n",
		to: "\t\tthis.wet.beforeWrite = this.layerWriteHook(this.wet, this.wetCanvas);\n\t\tthis.highlightWet.beforeWrite = this.layerWriteHook(this.highlightWet, this.highlightWetCanvas);\n\t\tthis.tail.beforeWrite = restore;\n\t}\n" +
			"\tprivate applyLayerVisibility(): void {\n\t\tif (this.pinchComposite || this.pinchHiddenCanvases?.size) return;\n" +
			"\t\tthis.setLayerVisible(this.committedCanvas, !this.committedBlank);\n\t\tthis.setLayerVisible(this.highlightCanvas, !this.highlightBlank);\n" +
			"\t\tthis.setLayerVisible(this.wetCanvas, !this.wet?.provenBlank);\n\t\tthis.setLayerVisible(this.highlightWetCanvas, !this.highlightWet?.provenBlank);\n" +
			"\t\tthis.armLayerHooks();\n\t}\n" +
			"\tprivate setLayerVisible(canvas, visible) {\n\t\tif (!canvas?.style) return;\n\t\tconst value = visible ? \"\" : \"hidden\";\n\t\tif (canvas.style.visibility !== value) canvas.style.visibility = value;\n\t}\n" +
			"\tprivate armLayerHooks(): void {\n\t\tif (this.wet) this.wet.onBlank ??= () => this.applyLayerVisibility();\n\t\tif (this.highlightWet) this.highlightWet.onBlank ??= () => this.applyLayerVisibility();\n" +
			"\t\tif (this.wet) this.wet.beforeWrite = this.wetCanvas?.style?.visibility === \"hidden\" ? this.layerWriteHook(this.wet, this.wetCanvas) : undefined;\n" +
			"\t\tif (this.highlightWet) this.highlightWet.beforeWrite = this.highlightWetCanvas?.style?.visibility === \"hidden\"\n\t\t\t? this.layerWriteHook(this.highlightWet, this.highlightWetCanvas) : undefined;\n\t}\n" +
			"\tprivate layerWriteHook(renderer, canvas) {\n\t\treturn () => {\n\t\t\tthis.restorePinchLayers();\n\t\t\tthis.setLayerVisible(canvas, true);\n\t\t\trenderer.beforeWrite = undefined;\n\t\t};\n\t}\n" },
	{ from: "\tprivate restorePinchLayers(): void {\n\t\tif (this.wet) this.wet.beforeWrite = undefined;\n",
		to: "\tprivate restorePinchLayers(): void {\n\t\tconst pinchHeld = this.pinchComposite || (this.pinchHiddenCanvases?.size ?? 0) > 0;\n\t\tif (this.wet) this.wet.beforeWrite = undefined;\n" },
	{ from: "\t\tfor (const [canvas,visibility] of this.pinchHiddenCanvases ?? []) canvas.style.visibility = visibility;\n\t\tthis.pinchHiddenCanvases?.clear();\n\t}\n",
		to: "\t\tfor (const [canvas,visibility] of this.pinchHiddenCanvases ?? []) canvas.style.visibility = visibility;\n\t\tthis.pinchHiddenCanvases?.clear();\n\t\tif (pinchHeld) this.applyLayerVisibility(); else this.armLayerHooks();\n\t}\n" },
	{ from: "\t\tthis.updateExtent();\n\t}\n\n\t/**\n",
		to: "\t\tthis.updateExtent();\n\t\tthis.applyLayerVisibility();\n\t}\n\n\t/**\n" },
];
const PLANT = !!process.env.HW_LAZY_HIGHLIGHT_PLANT_HIDE_BLANK;
/** The lag rig's flags: a GPU canvas, the kind the device draws with. */
const GPU_ARGS = process.platform === "win32" ? ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-angle=d3d11"] : [];

let browser: Browser, script: string, planted = 0;
const record: Record<string, unknown> = {};

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "lazyHighlightPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: PLANT ? [{ name: "lazy-highlight-plant-hide-blank", setup(pluginBuild) {
			pluginBuild.onLoad({ filter: /src[\\/]inline[\\/]InkOverlay\.ts$/ }, args => {
				let text = readFileSync(args.path, "utf8").replace(/\r\n/g, "\n");
				for (const pl of PLANT_HIDE_BLANK) {
					const found = text.split(pl.from).length - 1;
					if (found !== 1) throw new Error(`plant hide-blank: anchor found ${found} times: ${JSON.stringify(pl.from.slice(0, 60))}`);
					text = text.replace(pl.from, pl.to);
					planted++;
				}
				return { loader: "ts", contents: text };
			});
		} }] : [] });
	if (PLANT && planted !== PLANT_HIDE_BLANK.length) throw new Error(`plant hide-blank: ${planted} of ${PLANT_HIDE_BLANK.length} insertions applied`);
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: GPU_ARGS });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_LAZY_HIGHLIGHT_OUT) writeFileSync(process.env.HW_LAZY_HIGHLIGHT_OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).lazyHighlight[m](...a), [method, args] as const);

type TraceEvent = { name?: string; ph?: string; ts?: number; dur?: number; args?: { snapshot?: unknown } };
type LayerRow = { type: string; w: number; h: number; draws: boolean };

/** The layers of one "LayerTreeHostImpl:snapshot" event's active tree (disabled-by-default-cc.debug), flattened. */
function treeLayers(e: TraceEvent): LayerRow[] {
	const tree = (e.args?.snapshot as { active_tree?: { layers?: unknown[] } } | undefined)?.active_tree;
	return (tree?.layers ?? []).map(l => {
		// The layer's class is the id's prefix: "cc::TextureLayerImpl/0x...". draws_content is 0 or 1.
		const layer = l as { id?: string; bounds?: { width?: number; height?: number }; draws_content?: number | boolean };
		return { type: String(layer.id ?? "").split("/")[0]!, w: Number(layer.bounds?.width), h: Number(layer.bounds?.height), draws: !!layer.draws_content };
	});
}

it("a pen-only note: after writing and a top fling, no ink canvas is hidden and two full-size canvas layers draw", async () => {
	const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: 2, hasTouch: true });
	try {
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
		await page.setContent("<!doctype html><body style='margin:0'></body>");
		await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
		await page.addScriptTag({ content: script });
		const mounted = await call(page, "mount") as any;
		// Two traces: the writing, then the fling, so each ends on its own resting layer tree.
		await browser.startTracing(page, { categories: INK_TRACE_CATEGORIES });
		const written = await call(page, "write") as any;
		const writeBuffer = await browser.stopTracing();
		await browser.startTracing(page, { categories: INK_TRACE_CATEGORIES });
		const flung = await call(page, "flingTop") as any;
		const buffer = await browser.stopTracing();
		if (process.env.HW_LAZY_HIGHLIGHT_TRACE) {
			writeFileSync(process.env.HW_LAZY_HIGHLIGHT_TRACE, buffer);
			writeFileSync(`${process.env.HW_LAZY_HIGHLIGHT_TRACE}.write.json`, writeBuffer);
		}
		const read = (buf: { toString(encoding: "utf8"): string }) => {
			const trace = JSON.parse(buf.toString("utf8")) as { traceEvents?: TraceEvent[] } | TraceEvent[];
			const events = Array.isArray(trace) ? trace : trace.traceEvents ?? [];
			const ticks = events.filter(e => e.name === "SharedContextRateLimiter::Tick");
			// Many snapshot events carry no tree; the ones that do hold the frame's layers.
			const trees = events.filter(e => e.name === "LayerTreeHostImpl:snapshot" && treeLayers(e).length > 0)
				.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
			const last = trees.length ? treeLayers(trees[trees.length - 1]!) : [];
			const textures = last.filter(l => l.type === "cc::TextureLayerImpl");
			// The band: the largest texture layer the tree holds. The committed canvas is that size; so is the wet canvas's
			// layer while it is sized; the tail and the wet tile are smaller.
			const band = textures.reduce((m, l) => (l.w * l.h > m.w * m.h ? l : m), { type: "", w: 0, h: 0, draws: false });
			const bandLayers = textures.filter(l => l.w === band.w && l.h === band.h);
			return { events: events.length, ticks, trees: trees.length, textures, band, bandLayers, drawing: bandLayers.filter(l => l.draws) };
		};
		const w = read(writeBuffer), f = read(buffer);
		const ticks = [...w.ticks, ...f.ticks];
		const tickMs = ticks.reduce((sum, e) => sum + (e.dur ?? 0), 0) / 1000;
		const tickMaxMs = ticks.reduce((m, e) => Math.max(m, e.dur ?? 0), 0) / 1000;
		const band = f.band, trees = w.trees + f.trees;
		Object.assign(record, { gpuArgs: GPU_ARGS, planted, mounted, written, flung, events: w.events + f.events, ticks: ticks.length, tickMs, tickMaxMs,
			trees, treesWrite: w.trees, treesFling: f.trees, bandWrite: `${w.band.w}x${w.band.h}`, band: `${band.w}x${band.h}`,
			texturesWrite: w.textures, textures: f.textures, errors });
		const brief = JSON.stringify({ planted, mounted, written, flung, ticks: ticks.length, tickMs, tickMaxMs, treesWrite: w.trees, treesFling: f.trees,
			bandWrite: `${w.band.w}x${w.band.h}`, band: `${band.w}x${band.h}`, texturesWrite: w.textures, textures: f.textures });
		// Printed, not asserted (see the header): headless Chromium has no swap chain, so these count nothing the user feels.
		console.log(`LAZY-HIGHLIGHT planted ${planted} ticks ${ticks.length} tickMs ${tickMs} tickMaxMs ${tickMaxMs} hidden [${flung.hidden}] full-size drawing after writing ${w.drawing.length} of ${w.bandLayers.length}, after the fling ${f.drawing.length} of ${f.bandLayers.length}`);
		expect(errors, brief).toEqual([]);
		// PREMISES: the strokes were stored, the fling played a spring and it ended, each trace holds layer trees and a band.
		expect(written.strokes, `premise: ten strokes stored (${brief})`).toBe(10);
		expect(flung.springFrames, `premise: the fling played a spring (${brief})`).toBeGreaterThanOrEqual(10);
		expect(flung.ended, `premise: the spring ended (${brief})`).toBeGreaterThanOrEqual(0);
		expect(w.trees, `premise: the writing's trace recorded layer trees (${brief})`).toBeGreaterThan(0);
		expect(f.trees, `premise: the fling's trace recorded layer trees (${brief})`).toBeGreaterThan(0);
		expect(w.band.w * w.band.h, `premise: a full-size texture layer was found after the writing (${brief})`).toBeGreaterThan(0);
		expect(band.w * band.h, `premise: a full-size texture layer was found after the fling (${brief})`).toBeGreaterThan(0);
		// (i) Nothing is hidden: at rest after the burst and the fling, every ink canvas is visible.
		// The claims are soft, so a run reports each on its own line: the plant reddens (i) and (ii) after the writing.
		expect.soft(flung.hidden, `ink canvases with computed visibility hidden at rest (${brief})`).toEqual([]);
		// (ii) After the writing: two full-size canvas layers drawing content, committed ink and the wet layer, no highlight pair.
		expect.soft(w.drawing.length, `full-size texture layers drawing content after the writing (${brief})`).toBe(2);
		// (ii) After the fling: one, committed ink; the wet canvas was released to 0x0 when the page moved (arm W).
		expect.soft(f.drawing.length, `full-size texture layers drawing content after the fling (${brief})`).toBe(1);
	} finally {
		await page.close();
	}
}, 240_000);
