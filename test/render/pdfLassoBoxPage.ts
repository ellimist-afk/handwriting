/**
 * The page for PdfLassoBoxZoom.test.ts: the wet pair (the canvas pair live strokes, the lasso loop, the selection box
 * and the insert-space divider are drawn on) under the real PdfInkController, through a viewer zoom.
 *
 * Two page divs stacked in a scroller at the top left of the window, so a page point at scale s is the client point
 * (page left + x s, page top + y s). Each page has a page canvas in a `.canvasWrapper`. A zoom does what pdf.js does
 * to a page div on a zoom: the page div takes its new size, every child but the shown canvas's wrapper goes (ours with
 * them, through the real DOM, so the controller's root observer gets the browser's own records with a viewer canvas
 * still on the page), and the new canvas comes a frame later, hidden, then shows with the old one gone.
 *
 * The reader counts the pixels of the wet pair a user can see: none when the pair is off the page, else every pixel
 * of the wet and head canvases with any alpha, optionally only those outside a page rectangle.
 *
 * It changes nothing in src/.
 */
import { PdfInkController } from "../../src/pdf/PdfInkController";
import { computeBBox, type InkStroke } from "../../src/ink/Stroke";
import { applyOp } from "../../src/pdf/PdfInkHistory";
import { OVERLAY_CLASS } from "../../src/pdf/PdfInkBand";
import { setInlineTool } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { resetTipModeForTest, setTipMode } from "../../src/inline/TipMode";
import type { InkOp } from "../../src/inline/InkHistory";
import type { PenSample } from "../../src/input/PointerRouter";
import { frames, HIGHLIGHTER_HEX, installHostDom, type Pt } from "./penMarks";

installHostDom();

/** A page in points: its css size at scale 1. */
export const PAGE = { w: 600, h: 800 };
const GAP = 10;

interface Pair {
	wetCanvas: HTMLCanvasElement;
	headCanvas: HTMLCanvasElement;
}
interface Ctl {
	sync(): void;
	trailingSync: number | null;
	syncQueued: boolean;
	pair: Pair | null;
	wetHostPage: number;
	selected: string[];
	selectionPage: number;
	idle: boolean;
	drawLasso(box: unknown): void;
	clearSelection(): void;
	dissolveSelection(): void;
	copySelection(): void;
	pasteFromClipboard(): void;
	selectionBounds(page: number): { x: number; y: number; width: number; height: number } | null;
	penDown(s: PenSample, ev?: unknown): void;
	penRaw(s: PenSample[], ev?: unknown): void;
	penUp(ev?: unknown): void;
}

let controller: PdfInkController | null = null;
let ctl: Ctl | null = null;
let root: HTMLElement | null = null;
let scroller: HTMLElement | null = null;
let strokes: InkStroke[] = [];
/** Each page's scale; a zoom sets every page's unless a cell zooms one page alone. */
let scales: Record<number, number> = {};
let ids = 0;
let clock = 0;
let syncs = 0;
let lassoDraws = 0;

function line(a: Pt, b: Pt, step = 10): Pt[] {
	const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step));
	return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
}

function saved(page: number, a: Pt, b: Pt): InkStroke {
	const points = line(a, b).map((p, i) => ({ x: p.x, y: p.y, pressure: 0.5, t: i * 8 }));
	return { id: `s${++ids}`, tool: "pen", color: "#000000", width: 6, points, bbox: computeBBox(points, 6), createdAt: 0, page };
}

const pageEl = (n: number): HTMLElement => {
	const el = scroller?.querySelector<HTMLElement>(`div.page[data-page-number="${n}"]`);
	if (!el) throw new Error(`no page ${n}`);
	return el;
};

function makeCanvas(n: number, hidden: boolean): HTMLElement {
	const s = scales[n]!;
	const wrap = document.createElement("div");
	wrap.className = "canvasWrapper";
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(PAGE.w * s);
	canvas.height = Math.round(PAGE.h * s);
	canvas.style.cssText = `display:block;width:${PAGE.w * s}px;height:${PAGE.h * s}px`;
	canvas.hidden = hidden;
	const g = canvas.getContext("2d")!;
	g.fillStyle = "#ffffff";
	g.fillRect(0, 0, canvas.width, canvas.height);
	wrap.appendChild(canvas);
	return wrap;
}

function sizePage(n: number): void {
	const el = pageEl(n);
	el.style.width = `${PAGE.w * scales[n]!}px`;
	el.style.height = `${PAGE.h * scales[n]!}px`;
	el.style.setProperty("--scale-factor", String(scales[n]));
}

/** Two pages at scale 1, each with the given saved strokes (page points), and the controller mounted. */
async function open(ink: Array<{ page: number; a: Pt; b: Pt }>): Promise<void> {
	controller?.unmount();
	root?.remove();
	resetTipModeForTest();
	setInlineTool("pen");
	strokes = ink.map((s) => saved(s.page, s.a, s.b));
	scales = { 1: 1, 2: 1 };
	syncs = 0;
	lassoDraws = 0;
	document.body.className = "theme-light";
	root = document.body.createDiv();
	root.style.cssText = "position:absolute;left:0;top:0;width:640px;height:900px";
	scroller = root.createDiv({ cls: "pdfViewer" });
	scroller.style.cssText = "position:relative;width:640px;height:900px;overflow:auto;background:#808080";
	scroller.style.setProperty("--scale-factor", "1");
	for (const n of [1, 2]) {
		const el = scroller.createDiv({ cls: "page" });
		el.setAttribute("data-page-number", String(n));
		el.style.cssText = `position:relative;margin:0 0 ${GAP}px 0;background:#ffffff`;
		sizePage(n);
		el.appendChild(makeCanvas(n, false));
	}
	controller = new PdfInkController(
		root,
		window,
		(n: number) => strokes.filter((s) => s.page === n),
		() => "pdf-lasso-box-fixture",
		() => strokes,
		(op: InkOp) => {
			strokes = applyOp(strokes, op);
		},
		() => {},
		() => {},
		() => {},
		() => false,
		() => "darken"
	);
	ctl = controller as unknown as Ctl;
	const ownSync = ctl.sync;
	ctl.sync = function (this: Ctl) {
		syncs++;
		ownSync.call(this);
	};
	const ownDraw = ctl.drawLasso;
	ctl.drawLasso = function (this: Ctl, box: unknown) {
		lassoDraws++;
		ownDraw.call(this, box);
	};
	controller.mount();
	await frames(8);
	await quiet();
}

/** Frames until no sync is due and none ran for 250 ms (at most about 3 s). */
async function quiet(): Promise<boolean> {
	let last = syncs;
	let still = 0;
	for (let i = 0; i < 200; i++) {
		await frames(1);
		if (syncs !== last) {
			last = syncs;
			still = 0;
			continue;
		}
		if (ctl && ctl.trailingSync === null && !ctl.syncQueued && ++still >= 16) return true;
	}
	return false;
}

/** A page point to the client point at that page's scale now. */
function client(page: number, p: Pt): Pt {
	const r = pageEl(page).getBoundingClientRect();
	const s = scales[page]!;
	return { x: r.left + p.x * s, y: r.top + p.y * s };
}

const at = (page: number, p: Pt): PenSample => {
	const c = client(page, p);
	return { x: c.x, y: c.y, pressure: 0.5, timestamp: (clock += 16), tiltX: 0, tiltY: 0 };
};

/** Pen down and moved along `path` (page points); the contact stays down. */
async function hold(page: number, path: Pt[]): Promise<void> {
	ctl!.penDown(at(page, path[0]!), { pointerType: "pen", buttons: 1, button: 0 });
	for (const p of path.slice(1)) {
		await frames(1);
		ctl!.penRaw([at(page, p)], { pointerType: "pen", buttons: 1, button: -1 });
	}
	await frames(2);
}

async function lift(): Promise<void> {
	ctl!.penUp();
	await frames(4);
}

/** A closed lasso loop round a page rectangle, lifted: the selection and its box. */
async function lasso(page: number, r: { x: number; y: number; w: number; h: number }, up = true): Promise<void> {
	setTipMode("lasso");
	const c = [
		{ x: r.x, y: r.y },
		{ x: r.x + r.w, y: r.y },
		{ x: r.x + r.w, y: r.y + r.h },
		{ x: r.x, y: r.y + r.h },
		{ x: r.x, y: r.y },
	];
	const path = c.slice(1).flatMap((p, i) => line(c[i]!, p, 25).slice(1));
	await hold(page, [c[0]!, ...path]);
	if (up) await lift();
}

/** A stroke held with a tool, left down. */
async function stroke(page: number, tool: "pen" | "highlighter", a: Pt, b: Pt): Promise<void> {
	setTipMode("nib");
	setInlineTool(tool);
	if (tool === "highlighter") setInkColorHex("highlighter", HIGHLIGHTER_HEX);
	(controller as unknown as { syncForTool(): void }).syncForTool();
	await frames(2);
	await hold(page, line(a, b, 20));
}

/** The insert-space divider dragged from `y0` to `y1`, left down. */
async function space(page: number, y0: number, y1: number): Promise<void> {
	setTipMode("space");
	await hold(page, line({ x: 20, y: y0 }, { x: 20, y: y1 }, 10));
}

/**
 * pdf.js's zoom on the given pages (all when none named): each page div takes its new size; then every child but the
 * shown canvas's wrapper goes, or, with `penOnly`, only our pen canvas goes; the new canvas comes a frame later hidden,
 * and shows 20 ms after that with the old one gone. `syncNow` runs the controller's sync in the same task as the
 * resize, before the root observer hears of it (a sync already due at that moment). Waits until quiet.
 */
async function zoom(to: number, opts: { pages?: number[]; penOnly?: boolean; syncNow?: boolean; wait?: boolean } = {}): Promise<boolean> {
	const pages = opts.pages ?? [1, 2];
	for (const n of pages) {
		scales[n] = to;
		sizePage(n);
	}
	if (pages.length === 2) scroller!.style.setProperty("--scale-factor", String(to));
	if (opts.syncNow) ctl!.sync();
	for (const n of pages) {
		const el = pageEl(n);
		const old = el.querySelector<HTMLElement>(":scope > .canvasWrapper");
		const c = old?.querySelector("canvas");
		if (c) c.style.cssText = `display:block;width:${PAGE.w * to}px;height:${PAGE.h * to}px`;
		if (opts.penOnly) {
			for (const k of [...el.querySelectorAll(`:scope > canvas.${OVERLAY_CLASS}`)]) k.remove();
			continue;
		}
		old?.classList.add("zoomLayer");
		for (const k of [...el.children]) if (k !== old) k.remove();
		el.classList.add("loadingIcon");
		requestAnimationFrame(() => {
			const wrap = makeCanvas(n, true);
			el.appendChild(wrap);
			setTimeout(() => {
				wrap.querySelector("canvas")!.hidden = false;
				old?.remove();
				el.classList.remove("loadingIcon");
			}, 20);
		});
	}
	if (opts.wait === false) return true;
	await frames(4);
	return quiet();
}

/** Visible wet pixels: 0 when the pair is off every page, else pixels with alpha on the wet and head canvases, outside `except` (a page rectangle on `page`) when given. */
function wetPixels(except?: { page: number; x: number; y: number; w: number; h: number }): number {
	const pair = ctl?.pair;
	if (!pair || !pair.wetCanvas.isConnected) return 0;
	let n = 0;
	for (const canvas of [pair.wetCanvas, pair.headCanvas]) {
		if (canvas.width === 0 || canvas.height === 0) continue;
		const rect = canvas.getBoundingClientRect();
		const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
		let ex: { l: number; t: number; r: number; b: number } | null = null;
		if (except) {
			const a = client(except.page, { x: except.x, y: except.y });
			const b = client(except.page, { x: except.x + except.w, y: except.y + except.h });
			ex = { l: a.x, t: a.y, r: b.x, b: b.y };
		}
		const sx = rect.width / canvas.width;
		const sy = rect.height / canvas.height;
		for (let y = 0; y < canvas.height; y++) {
			for (let x = 0; x < canvas.width; x++) {
				if (data[(y * canvas.width + x) * 4 + 3] === 0) continue;
				if (ex) {
					const cx = rect.left + (x + 0.5) * sx;
					const cy = rect.top + (y + 0.5) * sy;
					if (cx >= ex.l && cx <= ex.r && cy >= ex.t && cy <= ex.b) continue;
				}
				n++;
			}
		}
	}
	return n;
}

/** Hash of the wet canvas's pixels and its size: equal before and after means untouched. */
function wetHash(): string {
	const pair = ctl?.pair;
	if (!pair) return "none";
	const c = pair.wetCanvas;
	if (c.width === 0 || c.height === 0) return `${c.width}x${c.height}`;
	const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
	let h = 2166136261;
	for (let i = 3; i < d.length; i += 4) h = Math.imul(h ^ d[i]!, 16777619);
	return `${c.width}x${c.height}:${(h >>> 0).toString(16)}`;
}

/** Where the pair sits against the page's pen canvas: same box on screen and same backing size, or why not. */
function pairFit(page: number): { seated: boolean; host: number; sameBox: boolean; sameBacking: boolean; pair: string; pen: string } {
	const pair = ctl?.pair ?? null;
	const pen = pageEl(page).querySelector<HTMLCanvasElement>(`:scope > canvas.${OVERLAY_CLASS}`);
	const box = (c: HTMLCanvasElement | null | undefined): string => {
		if (!c) return "none";
		const r = c.getBoundingClientRect();
		return `${r.left.toFixed(1)},${r.top.toFixed(1)} ${r.width.toFixed(1)}x${r.height.toFixed(1)} @${c.width}x${c.height}`;
	};
	const seated = !!pair && pair.wetCanvas.isConnected && pageEl(page).contains(pair.wetCanvas);
	const pr = pair?.wetCanvas.getBoundingClientRect();
	const qr = pen?.getBoundingClientRect();
	const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.6;
	return {
		seated,
		host: ctl?.wetHostPage ?? -1,
		sameBox: !!pr && !!qr && near(pr.left, qr.left) && near(pr.top, qr.top) && near(pr.width, qr.width) && near(pr.height, qr.height),
		sameBacking: !!pair && !!pen && pair.wetCanvas.width === pen.width && pair.wetCanvas.height === pen.height,
		pair: box(pair?.wetCanvas),
		pen: box(pen),
	};
}

function state(): { selected: number; selectionPage: number; host: number; idle: boolean; lassoDraws: number; syncs: number } {
	return { selected: ctl!.selected.length, selectionPage: ctl!.selectionPage, host: ctl!.wetHostPage, idle: ctl!.idle, lassoDraws, syncs };
}

/** The selection's box in page points, as the controller draws it ({x, y, width, height}); a box that is not finite throws. */
function bounds(page: number): { x: number; y: number; w: number; h: number } | null {
	const b = ctl!.selectionBounds(page);
	if (!b) return null;
	const r = { x: b.x, y: b.y, w: b.width, h: b.height };
	if (![r.x, r.y, r.w, r.h].every(Number.isFinite)) throw new Error(`selection bounds not finite: ${JSON.stringify(b)}`);
	return r;
}

const api = {
	open,
	quiet,
	lasso,
	stroke,
	space,
	lift,
	zoom,
	wetPixels,
	wetHash,
	pairFit,
	state,
	bounds,
	syncOnce: async (): Promise<void> => {
		ctl!.sync();
		await frames(2);
	},
	escape: (): void => ctl!.clearSelection(),
	pickTool: (): void => ctl!.dissolveSelection(),
	copy: (): void => ctl!.copySelection(),
	paste: async (): Promise<void> => {
		ctl!.pasteFromClipboard();
		await frames(4);
	},
	/** Page `page` takes scale `to` and the controller syncs in the same task, under whatever gesture is down: the pair's host and pixels before and after that sync, read before the root observer hears of the resize. */
	syncUnderGesture: (page: number, to: number): { idle: boolean; hostBefore: number; hostAfter: number; before: string; after: string } => {
		const idle = ctl!.idle;
		const hostBefore = ctl!.wetHostPage;
		const before = wetHash();
		scales[page] = to;
		sizePage(page);
		ctl!.sync();
		return { idle, hostBefore, hostAfter: ctl!.wetHostPage, before, after: wetHash() };
	},
	resetDraws: (): void => {
		lassoDraws = 0;
	},
};
declare global {
	interface Window {
		pdfLassoBox: typeof api;
	}
}
window.pdfLassoBox = api;
