/**
 * A PDF page stand-in for highlight crossings on pages read as dark, under the
 * real PdfInkController: one page div holding an opaque page canvas (a fill,
 * an optional panel and a glyph block), the shipped stylesheet (injected by
 * the test), and the container and body classes the app marks its own dark
 * pages with. The controller's own sync, paint, wet pair and snip run on it.
 *
 * Beside pdfHighlightPage.ts, which fixes the page at white or rgb(30,30,30)
 * and has no container: here the page fill, a panel inside it, "Adapt to
 * theme", the body's theme, a page still drawing, and a zoom settle (a new
 * whole-page canvas at a new scale) are each set by the cell.
 *
 * `reference` paints the same strokes with the controller's own
 * `drawCommitted` onto a copy of the page canvas: the plain wash, one stroke
 * at a time at the highlighter's alpha, which is how a page read as dark is
 * painted before this fix. Its single coat is the look a dark page keeps.
 */
import { PdfInkController } from "../../src/pdf/PdfInkController";
import { setViewTurnSource } from "../../src/pdf/PdfInkBand";
import { computeBBox, type InkStroke } from "../../src/ink/Stroke";
import { setInlineTool } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { applyOp } from "../../src/pdf/PdfInkHistory";
import { snipViewport } from "../../src/pdf/PageMap";
import type { PdfPageAssumption } from "../../src/ink/InkPdf";
import type { InkOp } from "../../src/inline/InkHistory";
import type { PenSample } from "../../src/input/PointerRouter";
import { frames, HIGHLIGHTER_HEX, installHostDom, sample, type Pt } from "./penMarks";

installHostDom();

/** The page at scale 1, in css px and in points. */
export const PAGE = { w: 600, h: 800 };
/** The glyph: an opaque block of text colour on the page canvas. */
export const GLYPH = { x: 200, y: 285, w: 60, h: 30 };

export interface Panel {
	x: number;
	y: number;
	w: number;
	h: number;
	fill: string;
}

export interface OpenOptions {
	/** The page canvas's fill. */
	fill: string;
	/** The glyph's colour; light on a dark fill unless given. */
	glyph?: string;
	/** A block of another colour inside the page, as the device fixture's grey panel. */
	panel?: Panel;
	assumption?: PdfPageAssumption;
	/** "Adapt to theme": `mod-themed` on the container. */
	themed?: boolean;
	/** `theme-dark` on the body. */
	bodyDark?: boolean;
	/** The page starts still drawing (pdf.js's `loadingIcon` on the page div). */
	loading?: boolean;
}

let controller: PdfInkController | null = null;
let root: HTMLElement | null = null;
let pageEl: HTMLElement | null = null;
let opts: OpenOptions = { fill: "#ffffff" };
let scaleNow = 1;
let strokes: InkStroke[] = [];
let clock = 0;
let ids = 0;
let assumptionNow: PdfPageAssumption = "darken";
/** The viewer's page turn, as its turn source answers it; 0 unless a cell turns the page. */
let turnNow: 0 | 90 = 0;
let syncs = 0;
let reads = 0;
let readCounting = false;

function line(a: Pt, b: Pt, step = 10): Pt[] {
	const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step));
	return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
}

function saved(tool: "pen" | "highlighter", a: Pt, b: Pt, color: string, width: number): InkStroke {
	const points = line(a, b).map((p, i) => ({ x: p.x, y: p.y, pressure: 0.5, t: i * 8 }));
	return { id: `s${++ids}`, tool, color, width, points, bbox: computeBBox(points, width), createdAt: 0, page: 1 };
}

/** The page's own pixels at a scale: the fill, the panel, the glyph. */
function drawPage(g: CanvasRenderingContext2D, scale: number): void {
	g.setTransform(scale, 0, 0, scale, 0, 0);
	g.fillStyle = opts.fill;
	if (turnNow === 90) {
		// A turned page is the fill alone, its box swapped.
		g.fillRect(0, 0, PAGE.h, PAGE.w);
		g.setTransform(1, 0, 0, 1, 0, 0);
		return;
	}
	g.fillRect(0, 0, PAGE.w, PAGE.h);
	if (opts.panel) {
		g.fillStyle = opts.panel.fill;
		g.fillRect(opts.panel.x, opts.panel.y, opts.panel.w, opts.panel.h);
	}
	g.fillStyle = opts.glyph ?? "#000000";
	g.fillRect(GLYPH.x, GLYPH.y, GLYPH.w, GLYPH.h);
	g.setTransform(1, 0, 0, 1, 0, 0);
}

/** A new whole-page canvas at `scale`, in place of the one the page has: what pdf.js does at every zoom settle. */
function pageCanvas(scale: number): HTMLCanvasElement {
	if (!pageEl) throw new Error("no page");
	let wrap = pageEl.querySelector<HTMLElement>(".canvasWrapper");
	if (!wrap) wrap = pageEl.createDiv({ cls: "canvasWrapper" });
	wrap.empty();
	const canvas = wrap.createEl("canvas");
	const [w, h] = turnNow === 90 ? [PAGE.h, PAGE.w] : [PAGE.w, PAGE.h];
	canvas.width = Math.round(w * scale);
	canvas.height = Math.round(h * scale);
	canvas.style.cssText = `display:block;width:${w * scale}px;height:${h * scale}px`;
	drawPage(canvas.getContext("2d")!, scale);
	return canvas;
}

async function open(o: OpenOptions): Promise<void> {
	controller?.unmount();
	root?.remove();
	opts = o;
	strokes = [];
	scaleNow = 1;
	turnNow = 0;
	assumptionNow = o.assumption ?? "darken";
	document.body.className = o.bodyDark ? "theme-dark" : "theme-light";
	root = document.body.createDiv({ cls: "pdf-container" });
	if (o.themed) root.addClass("mod-themed");
	root.style.cssText = "position:absolute;left:0;top:0;width:620px;height:820px";
	const scroller = root.createDiv({ cls: "pdfViewer" });
	scroller.style.cssText = "position:relative;width:620px;height:820px;overflow:auto;background:#808080";
	pageEl = scroller.createDiv({ cls: "page" });
	pageEl.setAttribute("data-page-number", "1");
	pageEl.style.cssText = `position:relative;margin:0;width:${PAGE.w}px;height:${PAGE.h}px;--scale-factor:1`;
	if (o.loading) pageEl.addClass("loadingIcon");
	pageCanvas(1);
	controller = new PdfInkController(
		root,
		window,
		() => strokes,
		() => "pdf-dark-crossing-fixture",
		() => strokes,
		(op: InkOp) => {
			strokes = applyOp(strokes, op);
		},
		() => {},
		() => {},
		() => {},
		() => false,
		() => assumptionNow
	);
	// The viewer's own page turn, as PdfClaims registers it for an open PDF.
	setViewTurnSource(controller, () => turnNow);
	const c = controller as unknown as { sync(): void };
	const own = c.sync;
	c.sync = function (this: unknown) {
		syncs++;
		own.call(this);
	};
	controller.mount();
	await frames(4);
}

async function save(list: Array<{ tool: "pen" | "highlighter"; a: Pt; b: Pt; color?: string; width?: number }>): Promise<void> {
	for (const s of list) {
		strokes = [...strokes, saved(s.tool, s.a, s.b, s.color ?? (s.tool === "highlighter" ? HIGHLIGHTER_HEX : "#000000"), s.width ?? (s.tool === "highlighter" ? 24 : 6))];
	}
	(controller as unknown as { refresh(): void }).refresh();
	await frames(4);
}

/** One sync of the controller's own, with nothing else changed, and the frames for it to show. */
async function syncOnce(): Promise<void> {
	(controller as unknown as { sync(): void }).sync();
	await frames(2);
}

/**
 * A sync the controller's root observer schedules, not one of the cell's own:
 * after a change the viewer makes (a zoom settle's new canvas, the page's
 * class when its draw ends). Frames until the sync count moves, at most `cap`,
 * then the frames for it to show. The syncs that landed, 0 if none did.
 */
async function observerSync(cap = 60): Promise<number> {
	const from = syncs;
	for (let i = 0; i < cap && syncs === from; i++) await frames(1);
	await frames(2);
	return syncs - from;
}

/** The page finishes drawing; frames till a sync has landed and none is queued, at most `cap`: syncs landed, and whether it settled. */
async function finishDrawSettled(cap = 60): Promise<{ landed: number; settled: boolean }> {
	const c = controller as unknown as { trailingSync: unknown; syncQueued: boolean };
	const from = syncs;
	finishDraw();
	const idle = (): boolean => syncs > from && c.trailingSync === null && !c.syncQueued;
	for (let i = 0; i < cap && !idle(); i++) await frames(1);
	const settled = idle();
	await frames(2);
	return { landed: syncs - from, settled };
}

type Pen = { penDown(s: PenSample, ev?: unknown): void; penRaw(s: PenSample[], ev?: unknown): void; penUp(ev?: unknown): void };
const pen = (): Pen => controller as unknown as Pen;
const at = (p: Pt): PenSample => ({ x: p.x, y: p.y, pressure: 0.5, timestamp: (clock += 16), tiltX: 0, tiltY: 0 });

async function hold(tool: "pen" | "highlighter", a: Pt, b: Pt, color?: string): Promise<void> {
	setInlineTool(tool);
	if (color) setInkColorHex(tool, color);
	else if (tool === "highlighter") setInkColorHex("highlighter", HIGHLIGHTER_HEX);
	// The app's tool pick syncs each open PDF in the pick's own task (`syncForTool`), so a page with
	// no saved highlight is read before the first highlighter stroke on it.
	(controller as unknown as { syncForTool(): void }).syncForTool();
	await frames(2);
	const path = line(a, b, 20);
	pen().penDown(at(path[0]!), { pointerType: "pen", buttons: 1, button: 0 });
	for (const p of path.slice(1)) {
		await frames(1);
		pen().penRaw([at(p)], { pointerType: "pen", buttons: 1, button: -1 });
	}
	await frames(3);
}

async function lift(): Promise<void> {
	pen().penUp();
	await frames(4);
}

/** The reader's declaration changed with no event behind it. */
function setAssumption(a: PdfPageAssumption): void {
	assumptionNow = a;
}

/** "Adapt to theme" on or off: the container's class, as the option's own click writes it. */
function setThemed(on: boolean): void {
	root?.toggleClass("mod-themed", on);
}

/** The body's theme, as a theme switch writes it. */
function setBodyDark(on: boolean): void {
	document.body.className = on ? "theme-dark" : "theme-light";
}

/** pdf.js finishes drawing the page: the page div loses `loadingIcon`. */
function finishDraw(): void {
	pageEl?.removeClass("loadingIcon");
}

/** A zoom settle: the page box and scale factor at `scale`, and a new whole-page canvas, drawn or still drawing. */
function zoomTo(scale: number, loading: boolean): void {
	if (!pageEl) throw new Error("no page");
	scaleNow = scale;
	pageEl.style.width = `${PAGE.w * scale}px`;
	pageEl.style.height = `${PAGE.h * scale}px`;
	pageEl.style.setProperty("--scale-factor", String(scale));
	pageEl.toggleClass("loadingIcon", loading);
	pageCanvas(scale);
}

/** The viewer turns the page a quarter turn clockwise: its box swaps, a new page canvas, then a sync and its frames. */
async function turn90(): Promise<void> {
	if (!pageEl) throw new Error("no page");
	turnNow = 90;
	pageEl.style.width = `${PAGE.h * scaleNow}px`;
	pageEl.style.height = `${PAGE.w * scaleNow}px`;
	pageCanvas(scaleNow);
	await syncOnce();
	await frames(2);
}

/** The page's own overlay elements, for the record each cell logs and asserts on. */
function layers(): Array<{ tag: string; cls: string; opacity: string; blend: string; parent: string; backing: number }> {
	return [...(pageEl?.querySelectorAll<HTMLElement>(".handwriting-pdf-ink") ?? [])].map((el) => ({
		tag: el.tagName.toLowerCase(),
		cls: el.className,
		opacity: getComputedStyle(el).opacity,
		blend: getComputedStyle(el).mixBlendMode,
		parent: el.parentElement === pageEl ? "page" : el.parentElement?.className ?? "",
		backing: el instanceof HTMLCanvasElement ? el.width * el.height : 0,
	}));
}

/** The live pair: where its wet canvas sits and what opacity it wears. */
function pairState(): { parent: string; opacity: string } | null {
	const c = controller as unknown as { pair: { wetCanvas: HTMLCanvasElement } | null };
	const w = c.pair?.wetCanvas;
	if (!w) return null;
	return { parent: w.parentElement === pageEl ? "page" : w.parentElement?.className ?? "", opacity: getComputedStyle(w).opacity };
}

/**
 * The same saved strokes painted the way a page read as dark was painted
 * before this fix: the controller's `drawCommitted` (each highlight at the
 * wash, one at a time, then the pen ink) onto a copy of the page canvas at
 * scale 1. The median of a (2r+1)^2 block at each point, as `sample` reads.
 */
function reference(points: Record<string, Pt>, r = 2): Record<string, [number, number, number]> {
	const c = document.createElement("canvas");
	c.width = PAGE.w;
	c.height = PAGE.h;
	const g = c.getContext("2d", { willReadFrequently: true })!;
	drawPage(g, 1);
	(controller as unknown as { drawCommitted(ctx: CanvasRenderingContext2D, cam: { x: number; y: number; zoom: number }, s: readonly InkStroke[]): void }).drawCommitted(
		g,
		{ x: 0, y: 0, zoom: 1 },
		strokes
	);
	const out: Record<string, [number, number, number]> = {};
	for (const [key, p] of Object.entries(points)) {
		const d = g.getImageData(Math.round(p.x) - r, Math.round(p.y) - r, 2 * r + 1, 2 * r + 1).data;
		const ch: number[][] = [[], [], []];
		for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) ch[k]!.push(d[i + k]!);
		out[key] = ch.map((v) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)]!) as [number, number, number];
	}
	return out;
}

/** The screenshot's RGB along a column, one pixel a row, for edge rows. */
async function column(b64: string, x: number, y0: number, y1: number): Promise<number[][]> {
	const img = new Image();
	img.src = `data:image/png;base64,${b64}`;
	await img.decode();
	const c = document.createElement("canvas");
	c.width = img.naturalWidth;
	c.height = img.naturalHeight;
	const g = c.getContext("2d", { willReadFrequently: true })!;
	g.drawImage(img, 0, 0);
	const d = g.getImageData(x, y0, 1, y1 - y0 + 1).data, out: number[][] = [];
	for (let i = 0; i < d.length; i += 4) out.push([d[i]!, d[i + 1]!, d[i + 2]!]);
	return out;
}

/** The reference's column, the same rows. */
function referenceColumn(x: number, y0: number, y1: number): number[][] {
	const c = document.createElement("canvas");
	c.width = PAGE.w;
	c.height = PAGE.h;
	const g = c.getContext("2d", { willReadFrequently: true })!;
	drawPage(g, 1);
	(controller as unknown as { drawCommitted(ctx: CanvasRenderingContext2D, cam: { x: number; y: number; zoom: number }, s: readonly InkStroke[]): void }).drawCommitted(
		g,
		{ x: 0, y: 0, zoom: 1 },
		strokes
	);
	const d = g.getImageData(x, y0, 1, y1 - y0 + 1).data, out: number[][] = [];
	for (let i = 0; i < d.length; i += 4) out.push([d[i]!, d[i + 1]!, d[i + 2]!]);
	return out;
}

/** Counts since the last reset: the controller's syncs, and pixel reads of canvases that are not this fixture's own. */
function counts(): { syncs: number; reads: number } {
	return { syncs, reads };
}
function resetCounts(): void {
	syncs = 0;
	reads = 0;
}
/** Count `getImageData` calls (the dark read's one read back) while on; the fixture's own reads run with it off. */
function countReads(on: boolean): void {
	readCounting = on;
}
const ownGetImageData = CanvasRenderingContext2D.prototype.getImageData;
CanvasRenderingContext2D.prototype.getImageData = function (this: CanvasRenderingContext2D, ...args: Parameters<typeof ownGetImageData>) {
	if (readCounting) reads++;
	return ownGetImageData.apply(this, args);
} as typeof ownGetImageData;

/** A browser at its canvas memory cap: no 2d context for a page's highlight canvas. */
function capHighlightCanvas(on: boolean): void {
	const proto = HTMLCanvasElement.prototype as unknown as { getContext: (...a: unknown[]) => unknown; __own?: (...a: unknown[]) => unknown };
	if (on && !proto.__own) {
		const own = proto.getContext;
		proto.__own = own;
		proto.getContext = function (this: HTMLCanvasElement, ...a: unknown[]) {
			if (this.classList.contains("handwriting-pdf-highlight")) return null;
			return own.apply(this, a);
		};
	} else if (!on && proto.__own) {
		proto.getContext = proto.__own;
		delete proto.__own;
	}
}

/** Select every saved stroke and snip; the PNG and where page point (0, 0) lands in it. */
async function snip(): Promise<{ b64: string; x0: number; y0: number; scale: number }> {
	const c = controller as unknown as {
		selected: string[];
		selectionPage: number;
		selectionBounds(page: number): { x: number; y: number; width: number; height: number } | null;
		snipSelection(): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }>;
	};
	c.selected = strokes.map((s) => s.id);
	c.selectionPage = 1;
	const b = c.selectionBounds(1);
	if (!b) throw new Error("nothing selected");
	const result = await c.snipSelection();
	if (!result.ok) throw new Error(`snip refused: ${result.reason}`);
	// The same crop the snip took: the viewer's canvas is `scaleNow` backing px per point here.
	const vp = snipViewport(b, 8, PAGE.w, PAGE.h, scaleNow, 8_000_000);
	if (!vp) throw new Error("no snip viewport");
	let s = "";
	for (const byte of result.bytes) s += String.fromCharCode(byte);
	return { b64: btoa(s), x0: vp.x0, y0: vp.y0, scale: vp.scale };
}

const api = {
	open,
	save,
	syncOnce,
	observerSync,
	finishDrawSettled,
	hold,
	lift,
	setAssumption,
	setThemed,
	setBodyDark,
	finishDraw,
	zoomTo,
	turn90,
	layers,
	pairState,
	reference,
	column,
	referenceColumn,
	counts,
	resetCounts,
	countReads,
	capHighlightCanvas,
	snip,
	sample,
	frames,
};
declare global {
	interface Window {
		pdfDark: typeof api;
	}
}
window.pdfDark = api;
