/**
 * The page for PdfZoomPaintedGap.test.ts: a stand-in for pdf.js's page list under the real PdfInkController, and a
 * reader that counts, at the paint point of every frame, the pages that show their own picture without our ink.
 *
 * The viewer here does to the page divs what the flicker arm and our comments record pdf.js doing: a page div holds a
 * `.canvasWrapper` with the page canvas; a re-render sweeps the page div's other children (ours among them) and keeps the
 * old canvas as a zoom layer until the new one shows; a first render appends its canvas hidden and shows it later; a page
 * the viewer lets go of loses its canvas. Every write is made from a timer or an animation frame callback, as the
 * viewer's are, never from inside the controller.
 *
 * The reader: an animation frame callback changes a 1 px sentinel's width every frame, and a ResizeObserver on the
 * sentinel reads. ResizeObserver callbacks run after every animation frame callback of the frame (the controller's
 * included) and after layout, and before paint, so what the reader sees is what that frame paints. Per page and frame
 * it reads: does the page show a picture (a viewer canvas, not hidden, with area, inside the scroller's box); the
 * backing alpha of our canvases at one point of the saved pen stroke and one of the saved highlight, each only when that
 * point is inside the scroller's box; how many pen canvases and highlight groups of ours the page holds.
 *
 * A frame is bad for a page that shows its picture when the pen point is on screen and no canvas of ours has alpha
 * there, or the highlight point is on screen and no canvas of ours has alpha there. Alpha, not elements: a canvas kept
 * but cleared is as missing as a canvas taken.
 *
 * It changes nothing in src/.
 */
import { PdfInkController } from "../../src/pdf/PdfInkController";
import { computeBBox, type InkStroke } from "../../src/ink/Stroke";
import { applyOp } from "../../src/pdf/PdfInkHistory";
import { HIGHLIGHT_CANVAS_CLASS, HIGHLIGHT_GROUP_CLASS, OVERLAY_CLASS } from "../../src/pdf/PdfInkBand";
import type { InkOp } from "../../src/inline/InkHistory";
import { frames, HIGHLIGHTER_HEX, installHostDom, type Pt } from "./penMarks";

installHostDom();

/**
 * Each sync, as the cells read it: when it started, whether it ran outside every animation frame callback, and how many
 * times it drew a viewer canvas (a page canvas of the viewer's, not ours) into another, which is how the controller
 * reads a page's pixels (`readCanvasDark`). In these cells every sync but the root observer's at-once sync comes from a
 * frame callback (`schedule`), so "outside a frame" is the at-once sync. Frame callbacks are wrapped below to count
 * their depth; the observer's own callback is a microtask that runs after the frame callback returns, so it reads 0.
 */
export interface SyncRead {
	t: number;
	atOnce: 0 | 1;
	reads: number;
}
let frameDepth = 0;
const ownRaf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
	ownRaf((t) => {
		frameDepth++;
		try {
			cb(t);
		} finally {
			frameDepth--;
		}
	});
let inSync: SyncRead | null = null;
const ownDrawImage = CanvasRenderingContext2D.prototype.drawImage as (...args: unknown[]) => void;
CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]): void {
	const src = args[0];
	if (inSync && src instanceof HTMLCanvasElement && !src.classList.contains(OVERLAY_CLASS)) inSync.reads++;
	ownDrawImage.apply(this, args);
} as CanvasRenderingContext2D["drawImage"];

/** A page in points (its css size at scale 1). */
export const PAGE = { w: 600, h: 800 };
const GAP = 10;
/** One point on each saved stroke, page points. */
export const PEN_PT: Pt = { x: 250, y: 200 };
export const HL_PT: Pt = { x: 250, y: 400 };

interface Ctl {
	sync(): void;
	lastSyncAt: number;
	trailingSync: number | null;
	syncQueued: boolean;
	overlays: Map<number, { canvas: HTMLCanvasElement }>;
	pair: { wetCanvas: HTMLCanvasElement; headCanvas: HTMLCanvasElement } | null;
}

let controller: PdfInkController | null = null;
let ctl: Ctl | null = null;
let root: HTMLElement | null = null;
let scroller: HTMLElement | null = null;
let strokes: InkStroke[] = [];
let scale = 0.5;
let ids = 0;
/** performance.now() of every sync, each sync's read (`SyncRead`), and callbacks to run once after the next sync returns. */
let syncs: number[] = [];
let syncReads: SyncRead[] = [];
let afterSync: Array<() => void> = [];
/** Pages the PDF file draws dark: their page canvas is #111111 with a white block. */
let darkPages: number[] = [];
/** The "dark pages" setting the controller is given: "darken" reads the pages, "lighten" never does. */
let assumption: "darken" | "lighten" = "darken";

function line(a: Pt, b: Pt, step = 10): Pt[] {
	const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step));
	return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
}

function saved(page: number, tool: "pen" | "highlighter", a: Pt, b: Pt): InkStroke {
	const width = tool === "highlighter" ? 24 : 6;
	const points = line(a, b).map((p, i) => ({ x: p.x, y: p.y, pressure: 0.5, t: i * 8 }));
	return { id: `s${++ids}`, tool, color: tool === "highlighter" ? HIGHLIGHTER_HEX : "#000000", width, points, bbox: computeBBox(points, width), createdAt: 0, page };
}

const pageEl = (n: number): HTMLElement | null => scroller?.querySelector<HTMLElement>(`div.page[data-page-number="${n}"]`) ?? null;
const cssW = (): number => Math.round(PAGE.w * scale);
const cssH = (): number => Math.round(PAGE.h * scale);

/**
 * Page `n`'s canvas in its wrapper, as a page render leaves it: white with one dark block, or, on a page the file draws
 * dark, #111111 with one white block.
 */
function makeCanvas(hidden: boolean, n: number): { wrap: HTMLElement; canvas: HTMLCanvasElement } {
	const dark = darkPages.includes(n);
	const wrap = document.createElement("div");
	wrap.className = "canvasWrapper";
	const canvas = document.createElement("canvas");
	canvas.width = cssW();
	canvas.height = cssH();
	canvas.style.cssText = `display:block;width:${cssW()}px;height:${cssH()}px`;
	canvas.hidden = hidden;
	const g = canvas.getContext("2d")!;
	g.fillStyle = dark ? "#111111" : "#ffffff";
	g.fillRect(0, 0, canvas.width, canvas.height);
	g.fillStyle = dark ? "#ffffff" : "#000000";
	g.fillRect(40 * scale, 40 * scale, 120 * scale, 30 * scale);
	wrap.appendChild(canvas);
	return { wrap, canvas };
}

/** First render of a page: its canvas, shown or still hidden. */
function render(n: number, hidden = false): HTMLCanvasElement | null {
	const el = pageEl(n);
	if (!el) return null;
	const { wrap, canvas } = makeCanvas(hidden, n);
	el.appendChild(wrap);
	return canvas;
}

/**
 * Build the document: `pages` page divs at `startScale`, the first `rendered` of them with a page canvas, a saved pen
 * stroke and a saved highlight on every page but the `bare` ones (no ink at all), and the controller mounted on it.
 */
async function open(pages = 4, rendered = 2, startScale = 0.5, height = 1300, bare: number[] = [], dark: number[] = [], assume: "darken" | "lighten" = "darken"): Promise<void> {
	controller?.unmount();
	root?.remove();
	strokes = [];
	syncs = [];
	syncReads = [];
	afterSync = [];
	darkPages = dark;
	assumption = assume;
	scale = startScale;
	document.body.className = "theme-light";
	root = document.body.createDiv();
	root.style.cssText = `position:absolute;left:0;top:0;width:640px;height:${height}px`;
	scroller = root.createDiv({ cls: "pdfViewer" });
	scroller.style.cssText = `position:relative;width:640px;height:${height}px;overflow:auto;background:#808080`;
	scroller.style.setProperty("--scale-factor", String(scale));
	for (let n = 1; n <= pages; n++) {
		const el = scroller.createDiv({ cls: "page" });
		el.setAttribute("data-page-number", String(n));
		el.style.cssText = `position:relative;margin:${GAP}px auto;width:${cssW()}px;height:${cssH()}px;background:#ffffff`;
		if (bare.includes(n)) continue;
		strokes.push(saved(n, "pen", { x: 100, y: PEN_PT.y }, { x: 400, y: PEN_PT.y }));
		strokes.push(saved(n, "highlighter", { x: 100, y: HL_PT.y }, { x: 400, y: HL_PT.y }));
	}
	for (let n = 1; n <= rendered; n++) render(n);
	controller = new PdfInkController(
		root,
		window,
		(n: number) => strokes.filter((s) => s.page === n),
		() => "pdf-painted-gap-fixture",
		() => strokes,
		(op: InkOp) => {
			strokes = applyOp(strokes, op);
		},
		() => {},
		() => {},
		() => {},
		() => false,
		() => assumption
	);
	ctl = controller as unknown as Ctl;
	const own = ctl.sync;
	ctl.sync = function (this: Ctl) {
		const read: SyncRead = { t: performance.now(), atOnce: frameDepth === 0 ? 1 : 0, reads: 0 };
		syncs.push(read.t);
		syncReads.push(read);
		const outer = inSync;
		inSync = read;
		try {
			own.call(this);
		} finally {
			inSync = outer;
		}
		for (const f of afterSync.splice(0)) f();
	};
	controller.mount();
	await frames(8);
}

// ---- the reader ----

interface PageRead {
	/** Shows its picture. */
	s: 0 | 1;
	/** Alpha of our canvases at the pen point and the highlight point; -1 when that point is off screen. */
	pen: number;
	hl: number;
	/** Pen canvases and highlight groups of ours on the page; viewer canvases there (hidden ones counted in vh). */
	pens: number;
	groups: number;
	vc: number;
	vh: number;
	/** The controller holds an overlay for this page. */
	held: 0 | 1;
	/** The page has saved ink. A page with none is never bad; it must hold none of our canvases. */
	ink: 0 | 1;
	/** A highlight group of ours on the page blends multiply (its computed mix-blend-mode): over a dark page, no band. */
	mul: 0 | 1;
}
interface FrameRead {
	f: number;
	t: number;
	pages: Record<number, PageRead>;
	pensTotal: number;
	liveInked: number;
}

let reading: { log: FrameRead[]; watch: number[]; count: number } | null = null;
let sentinel: HTMLElement | null = null;
let tickOn = false;

function alphaAt(canvas: HTMLCanvasElement, p: Pt, r = 2): number {
	const rect = canvas.getBoundingClientRect();
	if (rect.width === 0 || rect.height === 0 || canvas.width === 0 || canvas.height === 0) return 0;
	const sx = canvas.width / rect.width;
	const sy = canvas.height / rect.height;
	const x0 = Math.max(0, Math.floor((p.x - r - rect.left) * sx));
	const y0 = Math.max(0, Math.floor((p.y - r - rect.top) * sy));
	const x1 = Math.min(canvas.width, Math.ceil((p.x + r - rect.left) * sx));
	const y1 = Math.min(canvas.height, Math.ceil((p.y + r - rect.top) * sy));
	if (x1 <= x0 || y1 <= y0) return 0;
	const ctx = canvas.getContext("2d");
	if (!ctx) return 0;
	const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
	let a = 0;
	for (let i = 3; i < d.length; i += 4) a = Math.max(a, d[i]!);
	return a;
}

function inBox(p: Pt, b: DOMRect): boolean {
	return p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;
}

function readPage(n: number, view: DOMRect): PageRead {
	const el = pageEl(n);
	const held: 0 | 1 = ctl?.overlays.has(n) ? 1 : 0;
	const ink: 0 | 1 = strokes.some((s) => s.page === n) ? 1 : 0;
	if (!el || !el.isConnected) return { s: 0, pen: -1, hl: -1, pens: 0, groups: 0, vc: 0, vh: 0, held, ink, mul: 0 };
	const pair = ctl?.pair;
	const kids = [...el.children] as HTMLElement[];
	const pens = kids.filter((k) => k.tagName === "CANVAS" && k.className === OVERLAY_CLASS && k !== pair?.wetCanvas && k !== pair?.headCanvas) as HTMLCanvasElement[];
	const groups = kids.filter((k) => k.classList.contains(HIGHLIGHT_GROUP_CLASS));
	const hlCanvases = groups.flatMap((g) => [...g.querySelectorAll<HTMLCanvasElement>(`canvas.${HIGHLIGHT_CANVAS_CLASS}`)]);
	const viewer = [...el.querySelectorAll<HTMLCanvasElement>(`canvas:not(.${OVERLAY_CLASS})`)];
	const shown = viewer.filter((c) => {
		if (c.hidden) return false;
		const r = c.getBoundingClientRect();
		return r.width > 0 && r.height > 0 && r.right > view.left && r.left < view.right && r.bottom > view.top && r.top < view.bottom;
	});
	const box = el.getBoundingClientRect();
	const k = box.width / PAGE.w;
	const at = (p: Pt): Pt => ({ x: box.left + el.clientLeft + p.x * k, y: box.top + el.clientTop + p.y * k });
	const ours = [...pens, ...hlCanvases];
	const penP = at(PEN_PT);
	const hlP = at(HL_PT);
	const pen = inBox(penP, view) ? Math.max(0, ...ours.map((c) => alphaAt(c, penP))) : -1;
	const hl = inBox(hlP, view) ? Math.max(0, ...ours.map((c) => alphaAt(c, hlP))) : -1;
	const mul: 0 | 1 = groups.some((g) => getComputedStyle(g).mixBlendMode === "multiply") ? 1 : 0;
	return { s: shown.length > 0 ? 1 : 0, pen, hl, pens: pens.length, groups: groups.length, vc: viewer.length, vh: viewer.filter((c) => c.hidden).length, held, ink, mul };
}

function readFrame(): void {
	if (!reading || !scroller) return;
	const view = scroller.getBoundingClientRect();
	const pages: Record<number, PageRead> = {};
	let pensTotal = 0;
	let liveInked = 0;
	const all = [...scroller.querySelectorAll<HTMLElement>("div.page[data-page-number]")].map((el) => Number(el.getAttribute("data-page-number")));
	for (const n of all) {
		const r = readPage(n, view);
		pensTotal += r.pens;
		if (r.vc > 0 && strokes.some((s) => s.page === n)) liveInked++;
		if (reading.watch.includes(n)) pages[n] = r;
	}
	reading.log.push({ f: reading.count++, t: Math.round(performance.now() * 10) / 10, pages, pensTotal, liveInked });
}

function startReader(watch: number[]): void {
	reading = { log: [], watch, count: 0 };
	if (!sentinel) {
		sentinel = document.body.createDiv();
		sentinel.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none";
		new ResizeObserver(() => readFrame()).observe(sentinel);
	}
	if (!tickOn) {
		tickOn = true;
		let wide = false;
		const tick = (): void => {
			if (!tickOn || !sentinel) return;
			wide = !wide;
			sentinel.style.width = wide ? "2px" : "1px";
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}
}

function stopReader(): FrameRead[] {
	tickOn = false;
	const log = reading?.log ?? [];
	reading = null;
	return log;
}

// ---- the viewer's writes ----

/** A viewer write that touches no ink: a class on the last page div. The controller's observer takes it as the viewer's. */
function poke(): void {
	const all = scroller?.querySelectorAll<HTMLElement>("div.page[data-page-number]");
	const last = all?.[all.length - 1];
	last?.classList.toggle("hw-poke");
}

const pensOf = (n: number): HTMLElement[] => {
	const el = pageEl(n);
	const pair = ctl?.pair;
	return el ? ([...el.children] as HTMLElement[]).filter((k) => k.tagName === "CANVAS" && k.className === OVERLAY_CLASS && k !== pair?.wetCanvas && k !== pair?.headCanvas) : [];
};
const groupsOf = (n: number): HTMLElement[] => {
	const el = pageEl(n);
	return el ? ([...el.children] as HTMLElement[]).filter((k) => k.classList.contains(HIGHLIGHT_GROUP_CLASS)) : [];
};

export type Action =
	| "control"
	| "takePen"
	| "takeHighlights"
	| "sweep"
	| "destroy"
	| "showNew"
	| "showHidden"
	| "swap"
	| "swapZoomLayer"
	| "zoomInBare"
	| "zoomInDrawing"
	| "sweepLateDraw"
	| "zoomInTwice"
	| "otherFile";

export interface Spec {
	action: Action;
	page: number;
	/** "sync": the action runs `delay` ms after a sync returns. "none": at least 250 ms after the last sync. */
	before: "sync" | "none";
	delay: number;
	/**
	 * The action runs inside an animation frame callback registered after the controller's in the same frame. For
	 * "zoomInBare", its second write (the new canvas) runs in the next frame's callback instead of a 4 ms timer.
	 */
	inRaf?: boolean;
	/** Frames read after the action's last write. */
	watch?: number;
	/** Pages the reader reports. */
	pages?: number[];
}

export interface Result {
	spec: Spec;
	/** performance.now() of the action's first write, its last write, and the last sync that returned before the first. */
	actionAt: number | null;
	lastWriteAt: number | null;
	syncBefore: number | null;
	syncsDuring: number;
	/** Every sync from the action's start on (`SyncRead`). */
	syncLog: SyncRead[];
	/**
	 * performance.now() of the write that showed a new viewer canvas ("zoomInBare", "zoomInDrawing", "zoomInTwice" its
	 * first step, "sweepLateDraw", "otherFile"), else null.
	 */
	newCanvasAt: number | null;
	/** The watched page as the reader saw it just before the action. */
	before: PageRead | null;
	log: FrameRead[];
	notes: string[];
}

/** Wait until no sync has run for 250 ms and none is queued or trailing. */
async function quiet(): Promise<boolean> {
	for (let i = 0; i < 180; i++) {
		const last = syncs[syncs.length - 1] ?? 0;
		if (ctl && ctl.trailingSync === null && !ctl.syncQueued && performance.now() - last >= 250) return true;
		await frames(1);
	}
	return false;
}

async function run(spec: Spec): Promise<Result> {
	const notes: string[] = [];
	if (!(await quiet())) notes.push("never quiet before the action");
	const n = spec.page;
	let actionAt: number | null = null;
	let lastWriteAt: number | null = null;
	let syncBefore: number | null = null;
	let newCanvasAt: number | null = null;
	let done = false;
	const before = scroller ? readPage(n, scroller.getBoundingClientRect()) : null;
	const wrote = (): void => {
		const now = performance.now();
		if (actionAt === null) {
			actionAt = now;
			syncBefore = syncs.filter((t) => t <= now).pop() ?? null;
		}
		lastWriteAt = now;
	};
	const finish = (): void => {
		wrote();
		done = true;
	};
	/** A zoom step's new size: the scale goes up 0.1 and every page div, and every other page's canvas, takes it. */
	const zoomStep = (el: HTMLElement): void => {
		scale = Math.round((scale + 0.1) * 100) / 100;
		scroller!.style.setProperty("--scale-factor", String(scale));
		for (const p of [...scroller!.querySelectorAll<HTMLElement>("div.page[data-page-number]")]) {
			p.style.width = `${cssW()}px`;
			p.style.height = `${cssH()}px`;
			const c = p.querySelector<HTMLCanvasElement>(":scope > .canvasWrapper > canvas");
			if (p !== el && c) c.style.cssText = `display:block;width:${cssW()}px;height:${cssH()}px`;
		}
	};
	/** A zoom in's reset with no zoom layer kept: a zoom step, then everything off the page div, the page drawing. */
	const zoomInReset = (el: HTMLElement): void => {
		if (!el.querySelector(":scope > .canvasWrapper")) notes.push("no canvas wrapper to reset");
		zoomStep(el);
		for (const k of [...el.children]) k.remove();
		el.classList.add("loadingIcon");
		wrote();
	};
	/**
	 * pdf.js's reset keeping the zoom layer: the shown canvas's wrapper stays (stretched to the new size when `zoom`
	 * makes this a zoom step), every other child goes, the page is drawing. Returns the kept wrapper.
	 */
	const zoomLayerReset = (el: HTMLElement, zoom = false): HTMLElement | null => {
		if (zoom) zoomStep(el);
		const wrappers = [...el.querySelectorAll<HTMLElement>(":scope > .canvasWrapper")];
		const old = wrappers.reverse().find((w) => w.querySelector("canvas")?.hidden === false) ?? null;
		if (!old) notes.push("no shown canvas to keep as the zoom layer");
		old?.classList.add("zoomLayer");
		const c = old?.querySelector("canvas");
		if (zoom && c) c.style.cssText = `display:block;width:${cssW()}px;height:${cssH()}px`;
		for (const k of [...el.children]) if (k !== old) k.remove();
		el.classList.add("loadingIcon");
		wrote();
		return old;
	};
	const act = (): void => {
		const el = pageEl(n);
		if (!el) {
			notes.push(`no page ${n}`);
			finish();
			return;
		}
		switch (spec.action) {
			case "control":
				el.classList.toggle("hw-control");
				finish();
				return;
			case "takePen": {
				const p = pensOf(n);
				if (p.length === 0) notes.push("no pen canvas to take");
				for (const c of p) c.remove();
				finish();
				return;
			}
			case "takeHighlights": {
				const g = groupsOf(n);
				if (g.length === 0) notes.push("no highlight group to take");
				for (const x of g) x.remove();
				finish();
				return;
			}
			case "destroy": {
				// pdf.js letting a page go for good (out of its render buffer): every child goes, its own canvas too, and
				// nothing is drawn again. None of ours may come back onto it.
				if (!el.querySelector(":scope > .canvasWrapper")) notes.push("no canvas wrapper to destroy");
				for (const k of [...el.children]) k.remove();
				finish();
				return;
			}
			case "sweep": {
				// pdf.js's reset keeping the zoom layer: every child but the old canvas wrapper goes, the page shows its
				// loading state; the new canvas comes hidden a frame later and shows (old one gone) 20 ms after that.
				const old = el.querySelector<HTMLElement>(":scope > .canvasWrapper");
				if (!old) notes.push("no canvas wrapper to keep");
				old?.classList.add("zoomLayer");
				for (const k of [...el.children]) if (k !== old) k.remove();
				el.classList.add("loadingIcon");
				wrote();
				requestAnimationFrame(() => {
					const { wrap, canvas } = makeCanvas(true, n);
					el.appendChild(wrap);
					wrote();
					setTimeout(() => {
						canvas.hidden = false;
						old?.remove();
						el.classList.remove("loadingIcon");
						finish();
					}, 20);
				});
				return;
			}
			case "showNew":
				if (el.querySelector("canvas")) notes.push("page already rendered");
				render(n, false);
				finish();
				return;
			case "showHidden": {
				if (el.querySelector("canvas")) notes.push("page already rendered");
				const c = render(n, true);
				wrote();
				setTimeout(() => {
					if (c) c.hidden = false;
					finish();
				}, 1);
				return;
			}
			case "swap": {
				// The viewer lets go of the page (its canvas goes), a sync runs on that, and `delay` ms after it the page
				// comes back with a new canvas, shown.
				for (const w of [...el.querySelectorAll(":scope > .canvasWrapper")]) w.remove();
				wrote();
				afterSync.push(() =>
					setTimeout(() => {
						render(n, false);
						finish();
					}, spec.delay)
				);
				return;
			}
			case "swapZoomLayer": {
				// The old canvas stays (as a zoom layer) while the new one comes hidden; `delay` ms after the sync that
				// follows, the new one shows and the old one goes. The page never has no canvas.
				const old = el.querySelector<HTMLElement>(":scope > .canvasWrapper");
				old?.classList.add("zoomLayer");
				const { wrap, canvas } = makeCanvas(true, n);
				el.appendChild(wrap);
				wrote();
				afterSync.push(() =>
					setTimeout(() => {
						canvas.hidden = false;
						old?.remove();
						finish();
					}, spec.delay)
				);
				return;
			}
			case "zoomInBare": {
				// A zoom in whose reset takes everything off the page div, the viewer's own canvas with ours, before the
				// new canvas is there (no zoom layer kept), the page marked drawing. Every page div takes the new size.
				// Then the new canvas lands finished and shown, and the drawing mark goes, in one write: 4 ms later from
				// a timer, or (inRaf) from the next frame's callback. Our canvases are not put back on a page with no
				// viewer canvas, so the new one lands on a page with saved ink and none of ours: the at-once path.
				zoomInReset(el);
				const land = (): void => {
					const { wrap } = makeCanvas(false, n);
					el.appendChild(wrap);
					el.classList.remove("loadingIcon");
					newCanvasAt = performance.now();
					finish();
				};
				if (spec.inRaf) requestAnimationFrame(land);
				else setTimeout(land, 4);
				return;
			}
			case "zoomInDrawing": {
				// BR3-a: "zoomInBare" whose new canvas lands shown while the page is still drawing: the drawing mark stays
				// on in the landing write and goes 60 ms later. The landing still takes the at-once path.
				zoomInReset(el);
				setTimeout(() => {
					const { wrap } = makeCanvas(false, n);
					el.appendChild(wrap);
					newCanvasAt = performance.now();
					wrote();
					setTimeout(() => {
						el.classList.remove("loadingIcon");
						finish();
					}, 60);
				}, 4);
				return;
			}
			case "sweepLateDraw": {
				// BR3-b: "sweep" with the show split from the draw's end. The reset keeps the old canvas as the zoom layer
				// and sweeps the rest (ours among it, which the controller puts back); the new canvas comes hidden a frame
				// later; 20 ms after that it shows and the zoom layer goes while the page is still drawing; the drawing
				// mark goes 120 ms after the show.
				const old = zoomLayerReset(el);
				requestAnimationFrame(() => {
					const { wrap, canvas } = makeCanvas(true, n);
					el.appendChild(wrap);
					wrote();
					setTimeout(() => {
						canvas.hidden = false;
						old?.remove();
						newCanvasAt = performance.now();
						wrote();
						setTimeout(() => {
							el.classList.remove("loadingIcon");
							finish();
						}, 120);
					}, 20);
				});
				return;
			}
			case "zoomInTwice": {
				// W1: "zoomInBare" (its new canvas lands finished, the at-once path), then a second zoom step whose reset
				// runs right after that at-once sync returns, before any later sync: the first step's canvas stays as the
				// zoom layer (the page shows it), the rest is swept, the second step's canvas comes hidden and the page is
				// drawing. 200 ms later the second canvas shows, the zoom layer goes and the drawing mark goes.
				zoomInReset(el);
				setTimeout(() => {
					const { wrap } = makeCanvas(false, n);
					afterSync.push(() => {
						if (syncReads[syncReads.length - 1]?.atOnce !== 1) notes.push("the second step did not follow the at-once sync");
						const old = zoomLayerReset(el, true);
						const second = makeCanvas(true, n);
						el.appendChild(second.wrap);
						wrote();
						setTimeout(() => {
							second.canvas.hidden = false;
							old?.remove();
							el.classList.remove("loadingIcon");
							finish();
						}, 200);
					});
					el.appendChild(wrap);
					el.classList.remove("loadingIcon");
					newCanvasAt = performance.now();
					wrote();
				}, 4);
				return;
			}
			case "otherFile": {
				// Another file in the same pane: the viewer drops every page div, a frame later puts up new empty ones at
				// the same size (no page the file draws dark), and 4 ms after that pages 1 and 2 land drawn and shown.
				const count = scroller!.querySelectorAll("div.page[data-page-number]").length;
				for (const p of [...scroller!.querySelectorAll<HTMLElement>("div.page[data-page-number]")]) p.remove();
				darkPages = [];
				wrote();
				requestAnimationFrame(() => {
					for (let k = 1; k <= count; k++) {
						const p = scroller!.createDiv({ cls: "page" });
						p.setAttribute("data-page-number", String(k));
						p.style.cssText = `position:relative;margin:${GAP}px auto;width:${cssW()}px;height:${cssH()}px;background:#ffffff`;
					}
					wrote();
					setTimeout(() => {
						render(1);
						render(2);
						newCanvasAt = performance.now();
						finish();
					}, 4);
				});
				return;
			}
		}
	};
	startReader(spec.pages ?? [n]);
	const startCount = syncs.length;
	if (spec.inRaf) {
		// Our observer schedules the controller's frame on the poke; this frame is asked for after it, so it runs after.
		poke();
		queueMicrotask(() => requestAnimationFrame(act));
	} else if (spec.before === "sync") {
		poke();
		afterSync.push(() => setTimeout(act, spec.delay));
	} else {
		setTimeout(act, 0);
	}
	let after = 0;
	for (let i = 0; i < 600; i++) {
		await frames(1);
		if (done) after++;
		if (done && after >= (spec.watch ?? 30)) break;
	}
	if (!done) notes.push("the action never finished");
	const log = stopReader();
	return { spec, actionAt, lastWriteAt, syncBefore, syncsDuring: syncs.length - startCount, syncLog: syncReads.slice(startCount), newCanvasAt, before, log, notes };
}

/**
 * The arm's button-scroll, in the stand-in: two zoom-out clicks 310 ms apart, each a pdf.js zoom (the page boxes and
 * the scale change, every rendered page keeps its old canvas as a zoom layer and loses its other children, then the
 * visible pages render one after another, two frames apiece), then four scroll steps of 15 px, 50 ms apart, less than
 * the band's margin. Pages that come into view render as they do.
 */
async function zoomScroll(scales: number[] = [0.4, 0.3], watch = 40): Promise<Result> {
	const notes: string[] = [];
	if (!(await quiet())) notes.push("never quiet before the action");
	const pages = [...(scroller?.querySelectorAll<HTMLElement>("div.page[data-page-number]") ?? [])];
	const nums = pages.map((el) => Number(el.getAttribute("data-page-number")));
	let actionAt: number | null = null;
	let lastWriteAt: number | null = null;
	const wrote = (): void => {
		const now = performance.now();
		if (actionAt === null) actionAt = now;
		lastWriteAt = now;
	};
	let queue: number[] = [];
	let pumping = false;
	const visible = (el: HTMLElement): boolean => {
		const v = scroller!.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		return r.bottom > v.top && r.top < v.bottom;
	};
	const pump = (): void => {
		if (pumping) return;
		pumping = true;
		const next = (): void => {
			const n = queue.shift();
			if (n === undefined) {
				pumping = false;
				return;
			}
			const el = pageEl(n)!;
			const old = el.querySelector<HTMLElement>(":scope > .canvasWrapper.zoomLayer");
			const { wrap, canvas } = makeCanvas(true, n);
			el.appendChild(wrap);
			wrote();
			requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					// A render the next zoom cancelled (its wrapper swept) shows nothing and takes nothing away.
					if (wrap.isConnected) {
						canvas.hidden = false;
						old?.remove();
						el.classList.remove("loadingIcon");
						wrote();
					}
					next();
				})
			);
		};
		next();
	};
	const want = (): void => {
		for (const el of pages) {
			const n = Number(el.getAttribute("data-page-number"));
			const has = el.querySelector(":scope > .canvasWrapper:not(.zoomLayer)");
			const zl = el.querySelector(":scope > .canvasWrapper.zoomLayer");
			if (visible(el) && (!has || zl) && !queue.includes(n)) queue.push(n);
		}
		pump();
	};
	const zoom = (s: number): void => {
		scale = s;
		scroller!.style.setProperty("--scale-factor", String(s));
		for (const el of pages) {
			el.style.width = `${cssW()}px`;
			el.style.height = `${cssH()}px`;
			// The canvas on screen stays as the zoom layer: the last wrapper whose canvas is shown. Everything else goes,
			// a render still in flight among it.
			const wrappers = [...el.querySelectorAll<HTMLElement>(":scope > .canvasWrapper")];
			const old = wrappers.reverse().find((w) => w.querySelector("canvas")?.hidden === false) ?? null;
			for (const k of [...el.children]) if (k !== old) k.remove();
			if (old) {
				old.classList.add("zoomLayer");
				const c = old.querySelector("canvas");
				if (c) c.style.cssText = `display:block;width:${cssW()}px;height:${cssH()}px`;
				el.classList.add("loadingIcon");
			}
		}
		wrote();
		queue = [];
		want();
	};
	startReader(nums);
	const startCount = syncs.length;
	let done = false;
	let t = 0;
	for (const s of scales) {
		setTimeout(() => zoom(s), t);
		t += 310;
	}
	for (let i = 0; i < 4; i++) {
		setTimeout(() => {
			scroller!.scrollTop += 15;
			wrote();
			want();
			if (i === 3) done = true;
		}, t + i * 50);
	}
	let after = 0;
	for (let i = 0; i < 900; i++) {
		await frames(1);
		if (done && !pumping) after++;
		if (after >= watch) break;
	}
	if (!done) notes.push("the scroll never finished");
	const log = stopReader();
	return { spec: { action: "sweep", page: 0, before: "none", delay: 0, pages: nums }, actionAt, lastWriteAt, syncBefore: null, syncsDuring: syncs.length - startCount, syncLog: syncReads.slice(startCount), newCanvasAt: null, before: null, log, notes };
}

/**
 * A pinch restyle storm: every frame for `n` frames every page div and its canvas change size by a pixel, no element
 * added or removed. Returns the syncs that ran and the reads.
 */
async function storm(n = 60): Promise<Result> {
	const notes: string[] = [];
	if (!(await quiet())) notes.push("never quiet before the action");
	const pages = [...(scroller?.querySelectorAll<HTMLElement>("div.page[data-page-number]") ?? [])];
	const nums = pages.map((el) => Number(el.getAttribute("data-page-number")));
	startReader(nums);
	const startCount = syncs.length;
	let actionAt: number | null = null;
	let lastWriteAt: number | null = null;
	for (let i = 0; i < n; i++) {
		await frames(1);
		const d = i % 2 === 0 ? 1 : 0;
		for (const el of pages) {
			el.style.width = `${cssW() + d}px`;
			el.style.height = `${cssH() + d}px`;
			const c = el.querySelector<HTMLCanvasElement>(":scope > .canvasWrapper > canvas");
			if (c) c.style.cssText = `display:block;width:${cssW() + d}px;height:${cssH() + d}px`;
		}
		const now = performance.now();
		if (actionAt === null) actionAt = now;
		lastWriteAt = now;
	}
	await frames(30);
	const log = stopReader();
	return { spec: { action: "control", page: 0, before: "none", delay: 0, pages: nums }, actionAt, lastWriteAt, syncBefore: null, syncsDuring: syncs.length - startCount, syncLog: syncReads.slice(startCount), newCanvasAt: null, before: null, log, notes };
}

/**
 * The pixels of our canvases on each page at rest, as a hash per canvas (FNV-1a over the backing's RGBA, with its
 * size): the same document at rest must hash the same on the base and on a fix that only changes what happens in a
 * re-render. Read after the controller has been quiet for 250 ms.
 */
async function restHash(): Promise<{ quiet: boolean; pages: Record<number, string[]> }> {
	const ok = await quiet();
	const pages: Record<number, string[]> = {};
	for (const el of [...(scroller?.querySelectorAll<HTMLElement>("div.page[data-page-number]") ?? [])]) {
		const n = Number(el.getAttribute("data-page-number"));
		const ours = [...el.querySelectorAll<HTMLCanvasElement>(`canvas.${OVERLAY_CLASS}`)];
		pages[n] = ours.map((c) => {
			let h = 0x811c9dc5;
			const ctx = c.width > 0 && c.height > 0 ? c.getContext("2d") : null;
			const d = ctx ? ctx.getImageData(0, 0, c.width, c.height).data : new Uint8ClampedArray(0);
			for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i]!, 0x01000193) >>> 0;
			return `${c.className.split(" ").pop()} ${c.width}x${c.height} ${h.toString(16)}`;
		});
	}
	return { quiet: ok, pages };
}

const api = { open, run, zoomScroll, storm, restHash, frames };
declare global {
	interface Window {
		pdfPaintedGap: typeof api;
	}
}
window.pdfPaintedGap = api;
