/**
 * A highlighter held on a note: across the tip's start the live stroke reads as its trail (no darker dot).
 *
 * What the user sees when it fails: while a highlighter stroke is being drawn, a patch as wide as the highlight rides
 * just behind the Pencil tip, darker than the trail, and is gone at the lift. The wet layer and the tail canvas each carry
 * the 0.35 wash as their own CSS opacity; each strip piece ends in a round disc at its last point m, and the live tip
 * starts at m with the same half-width, so the tip's back end lies on the strip's end disc and that disc is washed twice.
 * The PDF half is PdfPlainWashHeadDot.test.ts.
 *
 * THE PAGE: a real CodeMirror note carrying inkOverlayExtension() (the page of LazyHighlightPairTrace.test.ts: the
 * iPhone stub, the plugin's stylesheet and Obsidian's readable-width sheet, a cm-sizer), one short line of text at the top
 * and blank paper below it. The highlighter (#ffd60a, size x2) is held through real pen PointerEvents, one sample a frame,
 * and not lifted.
 *
 * PLACING: the tip is put on screen from the camera, not from the last pen sample. The page reports the
 * wet renderer's last ribbon point m and the head's two ends through camera.worldToScreen and the router's own inverse
 * mapping, and the end disc's radius max(0.25, hw x zoom) in client px.
 *
 * THE BOUND (d3Bound.ts), every cell: over every pixel inside the stroke's outline, 2 px in from its long
 * edges, from a half-width behind m to the tip's front end, against a trail pixel: no channel more than 4 darker; none
 * more than 14 lighter; every pixel more than 4 lighter within 1.5 px of the end disc's edge; none reading as paper. The
 * same frame is shot again with the tail canvas hidden: a pixel the strip alone paints off the trail, and the tail leaves
 * as the strip painted it, is the strip's own and is not counted; the worst is in the record.
 *
 * CELLS, red first: head (level, 20 px step); slanted (about 27 degrees); short step
 * (3 px); zoom (400% on the zoom bar, the host's scale); camera zoom (the text at twice its mounted size, so the camera's
 * zoom is 2); arc (radius about three half-widths, plus no paper outside the bend); a repaint while held (1 px scroll,
 * then the overlay's repaint; premise: a repaint drew a head); prediction on (premise: the tail holds ink past the tip's
 * capsule). The head and zoom cells again at device scale 1.5; the head cell at device scale 2. Software
 * raster only: the trail's colour under graphics-card raster and fractional scales other than 1.5 are not covered.
 *
 * GUARDS, green before and after: the pen-down dot and a resting tap show the whole dot; a pen stroke keeps its tip (the
 * tail's backing alpha half a width behind the head's start stays above 0, the join reads the pen trail).
 *
 * Every premise is asserted. HW_D3_HEAD_EVIDENCE=<dir> writes each cell's screenshot and record there.
 *
 * Run: npx vitest run --config vitest.render.mts test/render/NoteHighlighterHeadDot.test.ts
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";
import type { Pt, RGB } from "./penMarks";
import { behind, boundStats, boxOf, expectBound, expectPlaced, gap, placedOf, placedRecord, r2, readPx, white, type Arc, type Placed, type Raw } from "./d3Bound";

declare const process: { env: Record<string, string | undefined> };

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { inlineInk, inkOverlayExtension, overlayForPath, setInlineTool, setInkSizeMult, setScrollExpansionEnabled } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { setPrediction } from "../../src/inline/StrokePrediction";
import { surfaceExtents } from "../../src/inline/SurfaceExtent";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { backingAlpha, frames, line, sample } from "./penMarks";

installObsidianDom();
const ids = new Map();
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async () => null, scheduleSidecar: () => {}, scheduleSidecarNow: async () => {}, notify: () => {} });

const PATH = "d3-head-dot.md";
const PANE = { left: 57, top: 41, w: 640, h: 480 };
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth;
}

const pen = (target, type, p, buttons) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true,
	pointerType: "pen", pointerId: 931, isPrimary: true, clientX: p.x, clientY: p.y, buttons, button: type === "pointermove" ? -1 : 0,
	pressure: buttons ? 0.5 : 0 }));

function tailInkCount(tail) {
	let n = 0;
	if (tail && tail.width > 0 && tail.height > 0) {
		const d = tail.getContext("2d").getImageData(0, 0, tail.width, tail.height).data;
		for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
	}
	return n;
}

window.d3Head = {
	/** canvas: the canvas switch on (the zoom bar is busy without it); prediction: stroke prediction on; doc: the note's text. */
	async mount(opts = {}) {
		ids.set(PATH, "d3-head-dot");
		surfaceExtents.grow(PATH, { x: 2000, y: 2000 });
		setPenInk(true);
		if (opts.canvas) setScrollExpansionEnabled(true);
		if (opts.prediction) setPrediction(true);
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:absolute;left:" + PANE.left + "px;top:" + PANE.top + "px;width:" + PANE.w + "px;height:" + PANE.h +
			"px;overflow:hidden;background:#ffffff";
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc: opts.doc ?? "reading notes", extensions: [EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path: PATH }, editor: {} })),
			inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE.w + "px", height: PANE.h + "px", backgroundColor: "#ffffff", color: "#777777" },
				".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		installSizer(view);
		await frames(12);
		const overlay = overlayForPath(PATH);
		if (!overlay) throw new Error("no overlay for " + PATH);
		rig = { pane, view, overlay, target: null, last: null, watch: null };
		const r = pane.getBoundingClientRect();
		return { left: r.left, top: r.top, width: r.width, height: r.height };
	},
	/** The zoom bar's own call, settled as noteViewportCameraPage.ts zoomTo does. */
	async zoom(factor) {
		const o = rig.overlay, want = o.getNoteViewportState().zoom * factor;
		for (let tries = 0; tries < 5 && o.getNoteViewportState().zoom !== want; tries++) {
			o.zoomNoteBy(want / o.getNoteViewportState().zoom);
			await frames(8);
		}
		const st = o.getNoteViewportState();
		return { canvasMode: o.canvasModeOn(), zoom: st.zoom, busy: st.busy, cameraZoom: o.camera.snapshot.zoom };
	},
	/** A stroke through the given client points by real pen events, one sample a frame, held at the last (no lift). */
	async holdPath(path, tool = "highlighter", hex = "#ffd60a", mult = 2) {
		setInlineTool(tool);
		setInkColorHex(tool, hex);
		setInkSizeMult(tool, mult);
		const target = document.elementFromPoint(path[0].x, path[0].y);
		if (!target) throw new Error("no element under the pen at " + path[0].x + "," + path[0].y);
		rig.target = target;
		rig.last = path[path.length - 1];
		pen(target, "pointerdown", path[0], 1);
		for (const p of path.slice(1)) {
			await frames(1);
			pen(target, "pointermove", p, 1);
		}
		await frames(3);
		const o = rig.overlay, tail = o.tailCanvas;
		const tailInk = tailInkCount(tail);
		const head = o.builder ? o.activeWet?.head?.() : undefined;
		return { samples: path.length, live: !!o.builder, highlighterWet: o.activeWet === o.highlightWet,
			head: head ? { from: head.from, to: head.to } : null, tailInk, tail: tail ? tail.width + "x" + tail.height : "none",
			tailOpacity: tail ? getComputedStyle(tail).opacity : "none", wetOpacity: getComputedStyle(o.highlightWetCanvas).opacity,
			targetTag: target.tagName.toLowerCase() + "." + target.className };
	},
	/** A stroke from a to b, step px a sample. The highlighter at x2 unless told. */
	async hold(a, b, step, tool = "highlighter", hex = "#ffd60a", mult = 2) {
		return this.holdPath(line(a, b, step), tool, hex, mult);
	},
	/** The highlighter touched down at p and held; nudge: one move that far right, under the builder's step (a resting tap). */
	async tap(p, nudge = 0) {
		setInlineTool("highlighter");
		setInkColorHex("highlighter", "#ffd60a");
		setInkSizeMult("highlighter", 2);
		const target = document.elementFromPoint(p.x, p.y);
		if (!target) throw new Error("no element under the pen at " + p.x + "," + p.y);
		rig.target = target;
		rig.last = p;
		pen(target, "pointerdown", p, 1);
		if (nudge) {
			await frames(1);
			pen(target, "pointermove", { x: p.x + nudge, y: p.y }, 1);
		}
		await frames(3);
		const o = rig.overlay, tail = o.tailCanvas;
		return { live: !!o.builder, highlighterWet: o.activeWet === o.highlightWet, tailInk: tailInkCount(tail),
			pointCount: o.builder ? o.builder.pointCount : 0,
			tailOpacity: tail ? getComputedStyle(tail).opacity : "none", wetOpacity: getComputedStyle(o.highlightWetCanvas).opacity };
	},
	/** The live stroke's head in world units, its half-widths, and the camera's zoom. */
	geometry() {
		const o = rig.overlay, head = o.builder ? o.activeWet?.head?.() : undefined;
		return { zoom: o.camera.snapshot.zoom, from: head ? head.from : null, to: head ? head.to : null,
			hw: head ? o.activeWet.liveHalfWidth(o.activeStyle, head.pressure) : null,
			contactHw: o.builder ? o.activeWet.contactHalfWidth(o.activeStyle, 0.5) : null,
			pointCount: o.builder ? o.builder.pointCount : 0 };
	},
	/**
	 * The strip's end disc and the head on screen, placed by the camera: world to screen through camera.worldToScreen,
	 * screen to client by the router's own inverse mapping (InlinePenRouter.clientPointForSample) on a fresh read of its
	 * element's rect, since the router's cached rect waits for the next pen event after a scroll; k is client px per
	 * screen unit there. The cached rect's answer for the strip's last point is kept beside it.
	 */
	place() {
		const o = rig.overlay, wet = o.activeWet, last = wet.lastRibbon, head = o.builder ? wet.head() : undefined, z = o.camera.snapshot.zoom;
		const rt = o.router, rect = rt.rectEl.getBoundingClientRect(), scale = rt.scaleProvider(), pan = rt.originPan?.();
		const px = pan && Number.isFinite(pan.x) ? pan.x : 0, py = pan && Number.isFinite(pan.y) ? pan.y : 0;
		const toClient = (s) => ({ x: rect.left + s.x * scale + px, y: rect.top + s.y * scale + py });
		const client = (w) => toClient(o.camera.worldToScreen(w.x, w.y));
		const s0 = o.camera.worldToScreen(0, 0), c0 = toClient(s0), c1 = toClient({ x: s0.x + 1, y: s0.y });
		const k = Math.hypot(c1.x - c0.x, c1.y - c0.y);
		const cached = last ? rt.clientPointForSample({ ...o.camera.worldToScreen(last.x, last.y), pressure: 0, timestamp: 0, tiltX: 0, tiltY: 0 }) : null;
		return { zoom: z, k, cssScale: o.cssScale, cached,
			last: last ? { ...client(last), hwWorld: last.hw } : null, r: last ? Math.max(0.25, last.hw * z) * k : null,
			from: head ? client(head.from) : null, to: head ? client(head.to) : null,
			hw: head ? wet.liveHalfWidth(o.activeStyle, head.pressure) * z * k : null };
	},
	/** Count the repaints, and the heads drawn inside one (InkOverlayLassoSpace.ts redrawSelectionUI), from now on. */
	watchRepaints() {
		const o = rig.overlay, w = { repaints: 0, heads: 0, headsInRepaint: 0, depth: 0 };
		const repaint = o.redrawSelectionUI;
		o.redrawSelectionUI = function (...a) { w.repaints++; w.depth++; try { return repaint.apply(this, a); } finally { w.depth--; } };
		const tail = o.tail, drawHead = tail.drawHead;
		tail.drawHead = function (...a) { w.heads++; if (w.depth > 0) w.headsInRepaint++; return drawHead.apply(this, a); };
		rig.watch = w;
		return true;
	},
	watched() {
		const w = rig.watch;
		return w ? { repaints: w.repaints, heads: w.heads, headsInRepaint: w.headsInRepaint } : null;
	},
	/** The tail canvas hidden or shown again, nothing else touched: the strip alone, same frame. */
	async tailHidden(on) {
		rig.overlay.tailCanvas.style.visibility = on ? "hidden" : "";
		await frames(1);
		return getComputedStyle(rig.overlay.tailCanvas).visibility;
	},
	/** A repaint landing while the pen is held: the overlay's own repaint of the selection layer, which redraws the tip. */
	async repaint() {
		rig.overlay.redrawSelectionUI();
		await frames(2);
		return true;
	},
	/** The note's text size set to px after mount: the camera carries the font zoom, px over the size it mounted at. */
	async fontPx(px) {
		rig.view.contentDOM.style.fontSize = px + "px";
		rig.view.contentDOM.style.lineHeight = (px * 1.5) + "px";
		rig.view.requestMeasure();
		await frames(8);
		return { cameraZoom: rig.overlay.camera.snapshot.zoom, refFontPx: rig.overlay.refFontPx };
	},
	async scrollBy(dy) {
		const s = rig.view.scrollDOM, before = s.scrollTop;
		s.scrollTop = before + dy;
		await frames(4);
		return { before, after: s.scrollTop };
	},
	/** Tail backing pixels painted outside the capsule from-to of half-width hw (client px), 1.5 px out. */
	tailBeyond(cap) {
		const t = rig.overlay.tailCanvas, r = t.getBoundingClientRect();
		if (!t.width || !t.height || !r.width || !r.height) return { beyond: 0, ink: 0 };
		const d = t.getContext("2d").getImageData(0, 0, t.width, t.height).data, sx = r.width / t.width, sy = r.height / t.height;
		const vx = cap.to.x - cap.from.x, vy = cap.to.y - cap.from.y, vv = vx * vx + vy * vy;
		let beyond = 0, ink = 0;
		for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
			if (d[(y * t.width + x) * 4 + 3] === 0) continue;
			ink++;
			const px = r.left + (x + 0.5) * sx - cap.from.x, py = r.top + (y + 0.5) * sy - cap.from.y;
			const s = vv > 0 ? Math.max(0, Math.min(1, (px * vx + py * vy) / vv)) : 0;
			if (Math.hypot(px - s * vx, py - s * vy) > cap.hw + 1.5) beyond++;
		}
		return { beyond, ink };
	},
	/** Each point's backing alpha on the live stroke's wet canvas and on the tail canvas. */
	alphas(points) {
		const o = rig.overlay, out = {};
		const wet = o.activeWet === o.highlightWet ? o.highlightWetCanvas : o.wetCanvas;
		for (const [k, p] of Object.entries(points)) out[k] = { wet: backingAlpha(wet, p), tail: backingAlpha(o.tailCanvas, p) };
		return out;
	},
	/** The screenshot's RGB in a box, row by row, three numbers a pixel. */
	async region(b64, x0, y0, w, h) {
		const img = new Image();
		img.src = "data:image/png;base64," + b64;
		await img.decode();
		const c = document.createElement("canvas");
		c.width = img.naturalWidth;
		c.height = img.naturalHeight;
		const g = c.getContext("2d", { willReadFrequently: true });
		g.drawImage(img, 0, 0);
		const d = g.getImageData(x0, y0, w, h).data, out = [];
		for (let i = 0; i < d.length; i += 4) out.push(d[i], d[i + 1], d[i + 2]);
		return out;
	},
	async lift() {
		pen(rig.target, "pointerup", rig.last, 0);
		await frames(4);
		return { live: !!rig.overlay.builder, strokes: inlineInk.strokes(PATH).length };
	},
	sample,
};
`;

let browser: Browser, script: string;

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "d3HeadDotPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
});

const call = <T>(p: Page, method: string, ...args: unknown[]): Promise<T> =>
	p.evaluate(([m, a]) => (window as any).d3Head[m](...a), [method, args] as const) as Promise<T>;

const A = 0.35;
const yellow: RGB = [255, 214, 10];
const plainWash = (b: RGB) => b.map((v, i) => v * (1 - A) + A * yellow[i]!) as RGB;

type Box = { left: number; top: number; width: number; height: number };
type Held = { samples: number; live: boolean; highlighterWet: boolean; head: { from: Pt; to: Pt } | null; tailInk: number; tail: string;
	tailOpacity: string; wetOpacity: string; targetTag: string };
type Geo = { zoom: number; from: Pt | null; to: Pt | null; hw: number | null; contactHw: number | null; pointCount: number };
type Mount = { canvas?: boolean; prediction?: boolean; doc?: string };
/** A page screenshot, typed from playwright itself: the render tsconfig has no node types, so no `Buffer` by name. */
type Png = Awaited<ReturnType<Page["screenshot"]>>;

const LEVEL: Pt = { x: 1, y: 0 };
// About 27 degrees below level: the join crosses the pixel grid at a slant.
const TH = 0.47;
const DIR: Pt = { x: Math.cos(TH), y: Math.sin(TH) };
async function openNote(errors: string[], b: Browser = browser, dpr = 1, mount: Mount = {}): Promise<{ page: Page; box: Box }> {
	const page = await b.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: dpr });
	page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
	page.on("console", (m) => console.log(`page: ${m.text()}`));
	await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addScriptTag({ content: script });
	const box = await call<Box>(page, "mount", mount);
	return { page, box };
}

function keep(name: string, png: Png, record: unknown): void {
	const directory = process.env.HW_D3_HEAD_EVIDENCE;
	if (!directory) return;
	writeFileSync(join(directory, `${name}.png`), png);
	writeFileSync(join(directory, `${name}.json`), JSON.stringify(record, null, 1));
}

const scaled = (pts: Record<string, Pt>, k: number): Record<string, Pt> =>
	Object.fromEntries(Object.entries(pts).map(([key, p]) => [key, { x: p.x * k, y: p.y * k }]));

/**
 * Place the tip by the camera, read the screenshot under the bound. The same frame is shot again with the tail canvas
 * hidden (the strip alone), then the tail shown again before anything else runs.
 */
async function readHeld(page: Page, dir: Pt, k: number, paperAt: Pt, trailAt?: Pt, arc?: Arc) {
	const raw = await call<Raw & { k: number; cssScale: number }>(page, "place");
	const placed = placedOf(raw, dir);
	const trailPt = trailAt ?? (placed ? behind(placed, placed.hw + 40) : paperAt);
	const alphas = await call<Record<string, { wet: number; tail: number }>>(page, "alphas",
		placed ? { m: placed.m, behindHalf: behind(placed, placed.hw / 2), trail: trailPt } : { trail: trailPt });
	const png = await page.screenshot({ scale: k === 1 ? "css" : "device" });
	const hidden = await call<string>(page, "tailHidden", true);
	const pngAlone = await page.screenshot({ scale: k === 1 ? "css" : "device" });
	const shown = await call<string>(page, "tailHidden", false);
	const b64 = png.toString("base64"), b64Alone = pngAlone.toString("base64");
	const s = await page.evaluate(({ b64, points }) => (window as any).d3Head.sample(b64, { x: 0, y: 0 }, points, 1) as Promise<Record<string, RGB>>,
		{ b64, points: scaled({ trail: trailPt, paper: paperAt }, k) });
	let stats = boundStats([], s.trail!);
	if (placed) {
		const bx = boxOf(placed, k);
		const region = (b: string) => page.evaluate(({ b64, bx }) => (window as any).d3Head.region(b64, bx.x0, bx.y0, bx.w, bx.h) as Promise<number[]>, { b64: b, bx });
		const data = await region(b64), alone = await region(b64Alone);
		stats = boundStats(readPx({ data, alone, ...bx, k }, placed, 2, arc), s.trail!);
	}
	return { raw, placed, png, pngAlone, b64, trail: s.trail!, paper: s.paper!, trailAt: trailPt, alphas, stats, tail: { hidden, shown } };
}

type Cell = {
	name: string;
	path: (box: Box) => Pt[];
	dir: Pt;
	paper: (box: Box) => Pt;
	trail?: (box: Box) => Pt;
	arc?: (box: Box) => Arc;
	dpr?: number;
	mount?: Mount;
	/** The zoom bar's factor (the host's scale). */
	zoom?: number;
	/** The text's px after mount (the camera's font zoom). */
	font?: number;
	/** After the hold, before the tip is placed: a premise's numbers. */
	afterHold?: (page: Page, box: Box) => Promise<Record<string, unknown>>;
	/** After the tip is placed, before the screenshot. */
	afterPlace?: (page: Page, placed: Placed, box: Box) => Promise<Record<string, unknown>>;
};

/** A held highlighter cell: the common premises, then the bound. Returns what the cell's own premises read. */
async function heldCell(c: Cell, extra?: (rec: Record<string, any>, brief: string) => void): Promise<void> {
	const errors: string[] = [];
	const k = c.dpr ?? 1;
	const { page, box } = await openNote(errors, browser, k, c.mount);
	try {
		const font = c.font ? await call<{ cameraZoom: number; refFontPx: number }>(page, "fontPx", c.font) : null;
		const zoomed = c.zoom ? await call<{ canvasMode: boolean; zoom: number; busy: boolean; cameraZoom: number }>(page, "zoom", c.zoom) : null;
		const held = await call<Held>(page, "holdPath", c.path(box));
		const after = c.afterHold ? await c.afterHold(page, box) : {};
		const first = placedOf(await call<Raw>(page, "place"), c.dir);
		const placedExtra = c.afterPlace && first ? await c.afterPlace(page, first, box) : {};
		const rd = await readHeld(page, c.dir, k, c.paper(box), c.trail?.(box), c.arc?.(box));
		const lifted = await call<{ live: boolean; strokes: number }>(page, "lift");
		const record: Record<string, any> = { cell: c.name, box, dpr: k, font, zoomed, held, after, placedExtra, raw: rd.raw, placed: placedRecord(rd.placed),
			trailAt: rd.trailAt, trail: rd.trail, paper: rd.paper, alphas: rd.alphas, stats: rd.stats, tail: rd.tail, plainWash: plainWash(white), lifted, errors };
		const brief = JSON.stringify(record);
		console.log(`D3_HEAD ${c.name} ${brief}`);
		keep(`d3-${c.name}`, rd.png, record);
		keep(`d3-${c.name}-strip-alone`, rd.pngAlone, { cell: c.name, tail: rd.tail });
		expect(errors, brief).toEqual([]);
		// PREMISES: a live highlighter stroke with a head on the tail canvas, placed by the camera; white paper; a trail of the one plain wash.
		if (c.zoom) {
			expect(zoomed?.canvasMode, `premise: the canvas is on, so the zoom bar is live (${brief})`).toBe(true);
			expect(zoomed?.zoom, `premise: the note is at ${c.zoom * 100}% (${brief})`).toBeCloseTo(c.zoom, 6);
		}
		expect(held.live, `premise: the stroke is live (${brief})`).toBe(true);
		expect(held.highlighterWet, `premise: the live stroke is on the highlighter's wet layer (${brief})`).toBe(true);
		expect(held.tailInk, `premise: the head is painted on the tail canvas (${brief})`).toBeGreaterThan(0);
		expectPlaced(rd.placed, brief);
		expect(gap(rd.paper, white), `premise: the paper reads white ${rd.paper}`).toBeLessThanOrEqual(2);
		expect(gap(rd.trail, plainWash(white)), `premise: the trail is the one plain wash ${rd.trail} against ${plainWash(white)}`).toBeLessThanOrEqual(3);
		expect(rd.stats.count, `premise: pixels under the bound (${brief})`).toBeGreaterThanOrEqual(50);
		expect(rd.tail, `premise: the strip-alone shot had the tail canvas hidden, and it was shown again (${brief})`).toEqual({ hidden: "hidden", shown: "visible" });
		extra?.(record, brief);
		expectBound(rd.stats, rd.trail, `D3 ${c.name}`);
	} finally {
		await page.close();
	}
}

/** Level, 20 px a sample, from 100 px in to 420, 300 px down the pane. */
const levelPath = (box: Box, step = 20, length = 320): Pt[] => {
	const y = Math.round(box.top + 300), x0 = Math.round(box.left + 100), pts: Pt[] = [];
	for (let x = 0; x <= length; x += step) pts.push({ x: x0 + x, y });
	return pts;
};
const levelPaper = (box: Box): Pt => ({ x: Math.round(box.left + 300), y: Math.round(box.top + 420) });

it("D3 note, head: a highlighter held, level, 20 px a sample: across the tip's start the bound holds (no darker dot)", async () => {
	await heldCell({ name: "note-held", path: (box) => levelPath(box), dir: LEVEL, paper: levelPaper,
		// The read this cell first made (583b42ff), kept in the record: one point every 4 px behind the last pen sample.
		afterPlace: async (page, _placed, box) => {
			const png = await page.screenshot({ scale: "css" });
			const path = levelPath(box), nib = path[path.length - 1]!, points: Record<string, Pt> = {};
			for (let d = 96; d >= 4; d -= 4) points[`behind${d}`] = { x: nib.x - d, y: nib.y };
			const s = await page.evaluate(({ b64, points }) => (window as any).d3Head.sample(b64, { x: 0, y: 0 }, points, 0) as Promise<Record<string, RGB>>,
				{ b64: png.toString("base64"), points });
			return { nib, pointRead: s };
		} });
}, 120_000);

it("D3 note, slanted: a highlighter held at about 27 degrees: across the tip's start the bound holds", async () => {
	await heldCell({ name: "slanted-held", dir: DIR, paper: (box) => ({ x: box.left + 500, y: box.top + 120 }),
		path: (box) => {
			const pts: Pt[] = [], a = { x: box.left + 100, y: box.top + 150 };
			for (let d = 0; d <= 300; d += 20) pts.push({ x: a.x + d * DIR.x, y: a.y + d * DIR.y });
			return pts;
		} });
}, 120_000);

it("D3 note, short step: a highlighter held, level, 3 px a sample (the tip nearly all disc): the bound holds", async () => {
	await heldCell({ name: "short-step-held", path: (box) => levelPath(box, 3, 180), dir: LEVEL, paper: levelPaper });
}, 120_000);

/** Level at 400%: 240 px down the pane, so the 126 px wide stroke clears the pane's edges and the paper read below it. */
const zoomCell = (name: string, dpr = 1): Cell => ({ name, dpr, mount: { canvas: true }, zoom: 4, dir: LEVEL,
	path: (box) => levelPath(box).map((p) => ({ x: p.x, y: Math.round(box.top + 240) })),
	paper: (box) => ({ x: Math.round(box.left + 300), y: Math.round(box.top + 440) }) });

it("D3 note, zoom: a highlighter held at 400%, 20 px a sample: the bound holds", async () => {
	await heldCell(zoomCell("zoom-held"));
}, 120_000);

// An arc of radius about three half-widths (the highlighter's is about 15.8 px at x2): a level lead-in, then 20 px steps
// round a circle turning down. The smoothed centre line runs through the step midpoints, R cos(theta/2) from the centre.
const ARC_R = 48, ARC_TH = 20 / ARC_R, ARC_STEPS = 5;
const arcCentre = (box: Box): Pt => ({ x: Math.round(box.left + 220), y: Math.round(box.top + 150) + ARC_R });

it("D3 note, arc: a highlighter held round a bend of about three half-widths: the bound holds, and no paper outside the bend", async () => {
	await heldCell({ name: "arc-held", dir: LEVEL, paper: (box) => ({ x: box.left + 400, y: box.top + 400 }),
		path: (box) => {
			const c = arcCentre(box), pts: Pt[] = [];
			for (let x = 100; x < 220; x += 20) pts.push({ x: Math.round(box.left + x), y: c.y - ARC_R });
			for (let i = 0; i <= ARC_STEPS; i++) pts.push({ x: c.x + ARC_R * Math.sin(i * ARC_TH), y: c.y - ARC_R * Math.cos(i * ARC_TH) });
			return pts;
		},
		trail: (box) => ({ x: Math.round(box.left + 150), y: arcCentre(box).y - ARC_R }),
		arc: (box) => ({ c: arcCentre(box), R: ARC_R * Math.cos(ARC_TH / 2) }) },
	(rec, brief) => {
		expect(rec.stats.outsideBend.count, `premise: pixels outside the bend (${brief})`).toBeGreaterThanOrEqual(20);
		expect.soft(rec.stats.outsideBend.paper.gap, `D3 arc-held: paper outside the bend ${JSON.stringify(rec.stats.outsideBend)}`).toBeGreaterThanOrEqual(40);
	});
}, 120_000);

// The 1 px scroll alone reaches no repaint (measured on Rogue: 0 repaints, 0 heads after it): the band
// is carried under the held stroke and the committed repaint redraws the selection layer only over chrome, which a
// highlighter's pen-down clears. So the repaint is then driven by its own call, the stand-in for one landing mid-stroke;
// that direct call counts as the repaint, and the cell is named for it.
it("D3 note, a repaint while held: a highlighter held, the note scrolled 1 px, then the overlay's repaint: the tip is redrawn and the bound holds", async () => {
	await heldCell({ name: "repaint-held", path: (box) => levelPath(box), dir: LEVEL, paper: levelPaper,
		// Blank lines below the text, so the note scrolls and the paper under the stroke stays blank.
		mount: { doc: "reading notes" + "\n".repeat(60) },
		afterHold: async (page) => {
			await call(page, "watchRepaints");
			const scrolled = await call<{ before: number; after: number }>(page, "scrollBy", 1);
			const byScroll = await call<{ repaints: number; heads: number; headsInRepaint: number }>(page, "watched");
			await call(page, "repaint");
			return { scrolled, byScroll, watched: await call<{ repaints: number; heads: number; headsInRepaint: number }>(page, "watched") };
		} },
	(rec, brief) => {
		expect(rec.after.scrolled.after - rec.after.scrolled.before, `premise: the note scrolled 1 px (${brief})`).toBe(1);
		// The read must follow a repaint that drew the tip, or this cell is green with or without the cut there.
		expect(rec.after.watched.headsInRepaint, `premise: a repaint drew a head (${brief})`).toBeGreaterThan(0);
	});
}, 120_000);

it("D3 note, prediction on: a highlighter held with the predicted line drawn past the tip: the bound holds", async () => {
	await heldCell({ name: "prediction-held", path: (box) => levelPath(box), dir: LEVEL, paper: levelPaper, mount: { prediction: true },
		afterPlace: async (page, p) => ({ tail: await call<{ beyond: number; ink: number }>(page, "tailBeyond", { from: p.from, to: p.to, hw: p.hw }) }) },
	(rec, brief) => {
		expect(rec.placedExtra.tail.beyond, `premise: the tail holds ink past the tip's capsule, the predicted line (${brief})`).toBeGreaterThan(0);
	});
}, 120_000);

// The 400% of the zoom bar is the host's scale: the camera's zoom stays 1 there. The camera carries the font zoom, so
// this cell sets the text to twice the size it mounted at, and the disc's radius takes hw x 2.
it("D3 note, camera zoom: a highlighter held with the text at twice its size (camera zoom 2): the bound holds", async () => {
	await heldCell({ name: "camera-zoom-held", path: (box) => levelPath(box), dir: LEVEL, paper: levelPaper, font: 32 },
	(rec, brief) => {
		expect(rec.font?.cameraZoom, `premise: the camera's zoom is 2 (${brief})`).toBeCloseTo(2, 2);
	});
}, 120_000);

it("D3 note, N1 device scale 1.5: the head cell", async () => {
	await heldCell({ name: "dpr15-note-held", dpr: 1.5, path: (box) => levelPath(box), dir: LEVEL, paper: levelPaper });
}, 120_000);

it("D3 note, N1 device scale 1.5: the zoom cell", async () => {
	await heldCell(zoomCell("dpr15-zoom-held", 1.5));
}, 120_000);

// The head cell once more at device scale 2, Orion's, read at device pixels.
it("D3 note, device scale 2: the head cell", async () => {
	await heldCell({ name: "dpr2-note-held", dpr: 2, path: (box) => levelPath(box), dir: LEVEL, paper: levelPaper });
}, 120_000);

/** Every screen pixel inside the contact width, 2 px in, around p: how many, and how many read as paper. */
async function dotRead(page: Page, png: Png, p: Pt, rc: number) {
	const pad = Math.ceil(rc) + 2, x0 = Math.floor(p.x) - pad, y0 = Math.floor(p.y) - pad, w = 2 * pad + 1;
	const data = await page.evaluate(({ b64, x0, y0, w }) => (window as any).d3Head.region(b64, x0, y0, w, w) as Promise<number[]>,
		{ b64: png.toString("base64"), x0, y0, w });
	let inside = 0, bare = 0, nearest: { x: number; y: number; d: number; rgb: RGB } | null = null;
	for (let r = 0; r < w; r++) {
		for (let c = 0; c < w; c++) {
			const x = x0 + c, y = y0 + r, d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y);
			if (d > rc - 2) continue;
			const i = (r * w + c) * 3, rgb: RGB = [data[i]!, data[i + 1]!, data[i + 2]!];
			inside++;
			if (gap(rgb, white) < 40) {
				bare++;
				if (!nearest || gap(rgb, white) < gap(nearest.rgb, white)) nearest = { x, y, d: r2(d), rgb };
			}
		}
	}
	return { inside, bare, nearest };
}

async function dotGuard(name: string, nudge: number): Promise<void> {
	const errors: string[] = [];
	const { page, box } = await openNote(errors);
	try {
		const p = { x: Math.round(box.left + 300) + 0.5, y: Math.round(box.top + 300) + 0.5 };
		const tapped = await call<{ live: boolean; highlighterWet: boolean; tailInk: number; pointCount: number; tailOpacity: string; wetOpacity: string }>(page, "tap", p, nudge);
		const geo = await call<Geo>(page, "geometry");
		const rc = geo.contactHw! * geo.zoom;
		const png = await page.screenshot({ scale: "css" });
		const dot = await dotRead(page, png, p, rc);
		const lifted = await call<{ live: boolean; strokes: number }>(page, "lift");
		const record = { box, p, nudge, tapped, geo, rc: r2(rc), ...dot, lifted, errors };
		const brief = JSON.stringify(record);
		console.log(`D3_HEAD ${name} ${brief}`);
		keep(`d3-${name}`, png, record);
		expect(errors, brief).toEqual([]);
		expect(tapped.live, `premise: the stroke is live (${brief})`).toBe(true);
		expect(tapped.tailInk, `premise: the dot is painted on the tail canvas (${brief})`).toBeGreaterThan(0);
		if (nudge) expect(tapped.pointCount, `premise: the nudge was under the builder's step, so the contact is still the whole stroke (${brief})`).toBe(1);
		expect(dot.inside, `premise: pixels inside the dot (${brief})`).toBeGreaterThanOrEqual(50);
		// GUARD: every pixel inside the contact width, 2 px in, shows the wash.
		expect(dot.bare, `pixels inside the dot that read as paper (${brief})`).toBe(0);
	} finally {
		await page.close();
	}
}

it("D3 guard, pen-down dot: a highlighter touched down and held still shows its whole dot", async () => {
	await dotGuard("dot-held", 0);
}, 120_000);

it("D3 guard, resting tap: a highlighter touched down and nudged under the builder's step shows its whole dot", async () => {
	// 0.1 css px: under the builder's 0.15 world px step at 100% (StrokeBuilder minDistWorld), so nothing is accepted.
	await dotGuard("resting-tap-held", 0.1);
}, 120_000);

it("D3 guard, pen: a pen stroke held at a slant keeps its tip: the head's round back end is painted and the join reads the trail's colour", async () => {
	const errors: string[] = [];
	const { page, box } = await openNote(errors);
	try {
		const a = { x: box.left + 100, y: box.top + 150 }, L = 300;
		const nib = { x: a.x + L * DIR.x, y: a.y + L * DIR.y };
		const held = await call<Held>(page, "hold", a, nib, 20, "pen", "#1060e0", 3);
		const raw = await call<Raw>(page, "place");
		const placed = placedOf(raw, DIR);
		const brief0 = JSON.stringify({ held, raw });
		expect(placed, `premise: the pen's last strip point and head are known (${brief0})`).not.toBeNull();
		const p = placed!;
		const behindFrom = behind(p, p.hw / 2), trailAt = behind(p, 40);
		const alphas = await call<Record<string, { wet: number; tail: number }>>(page, "alphas", { behindFrom, trail: trailAt });
		const png = await page.screenshot({ scale: "css" });
		const b64 = png.toString("base64");
		const s = await page.evaluate(({ b64, points }) => (window as any).d3Head.sample(b64, { x: 0, y: 0 }, points, 0) as Promise<Record<string, RGB>>,
			{ b64, points: { trail: trailAt } });
		const bx = boxOf(p, 1);
		const data = await page.evaluate(({ b64, bx }) => (window as any).d3Head.region(b64, bx.x0, bx.y0, bx.w, bx.h) as Promise<number[]>, { b64, bx });
		const px = readPx({ data, ...bx, k: 1 }, p, 1.5);
		const trail = s.trail!;
		let worst = px[0]!;
		for (const q of px) if (gap(q.rgb, trail) > gap(worst.rgb, trail)) worst = q;
		const lifted = await call<{ live: boolean; strokes: number }>(page, "lift");
		const record = { box, a, nib, held, raw, placed: placedRecord(p), alphas, trail, count: px.length,
			worst: px.length ? { gap: gap(worst.rgb, trail), at: { x: worst.x, y: worst.y, t: r2(worst.t), n: r2(worst.n), rgb: worst.rgb } } : null, lifted, errors };
		const brief = JSON.stringify(record);
		console.log(`D3_HEAD pen ${brief}`);
		keep("d3-pen-held", png, record);
		expect(errors, brief).toEqual([]);
		expect(held.live, `premise: the stroke is live (${brief})`).toBe(true);
		expect(held.highlighterWet, `premise: the live stroke is on the pen's wet layer (${brief})`).toBe(false);
		expect(p.hw, `premise: the pen is wide enough to read across (${brief})`).toBeGreaterThanOrEqual(3);
		expect(gap(trail, white), `premise: the trail shows the pen ${trail}`).toBeGreaterThanOrEqual(100);
		expect(px.length, `premise: pixels across the join (${brief})`).toBeGreaterThanOrEqual(20);
		// GUARDS: the pen's head still starts with its round back end, and the join reads as the trail.
		expect.soft(alphas.behindFrom!.tail, `the tail canvas half a width behind the head's start (${brief})`).toBeGreaterThan(0);
		expect.soft(worst ? gap(worst.rgb, trail) : 0, `across the join against the pen trail ${trail} at ${JSON.stringify(record.worst)}`).toBeLessThanOrEqual(12);
	} finally {
		await page.close();
	}
}, 120_000);
