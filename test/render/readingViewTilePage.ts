/**
 * The page for ReadingViewTile.test.ts: a note's own Reading view with ink far bigger than the layer budget, the shape
 * of Alan's Infinite Canvas note (an ink box of 9,241 x 6,025 css px), and a one-page note beside it for the path that
 * must not change.
 *
 * - `mount(big)`: a reading view (view > sizer > pusher, one section), the view 1,400 x 900 css px and scrolled to
 *   y = 1,000, painted with a grid of short strokes over the whole box (`big`) or one page of them.
 * - `layer()`: the canvas's backing size, css content box, scroll range and the tile it holds.
 * - `scrollBy(dy, dx)`: scroll the view, let two frames run, and count the paints the scroll caused; with both tiles'
 *   pixels compared over their overlap, device px for device px.
 * - `shrink()`: the note's ink becomes one page and is saved, so the layer goes back to the whole box.
 * - `handlerCost(n)`: the scroll listener's own JS time over n small scrolls that stay inside the tile.
 */
import * as Embed from "../../src/inline/EmbedInk";
import type { InkStroke } from "../../src/ink/Stroke";
import { installObsidianDom } from "./obsidianDom";

installObsidianDom();

const BIG = { w: 9241, h: 6025 };
const PAGE = { w: 700, h: 1000 };
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** A grid of short diagonal strokes covering a w x h box, mixed lengths and colours so no two tiles look alike. */
function grid(w: number, h: number): InkStroke[] {
	const out: InkStroke[] = [];
	let k = 0;
	for (let y = 20; y < h - 20; y += 97) for (let x = 20; x < w - 20; x += 131) {
		const len = 30 + (k % 7) * 9;
		const points = Array.from({ length: 8 }, (_, j) => ({ x: x + (j * len) / 7, y: y + (j * len) / 11 + (j % 2) * 3, pressure: 0.3 + (j % 3) * 0.2, t: j * 9 }));
		const pad = 4;
		const bbox = { x: x - pad, y: y - pad, width: len + 2 * pad, height: len / 1.57 + 3 + 2 * pad };
		out.push({ id: `g${k}`, tool: "pen", color: ["#ff00ff", "#0080ff", "#20a020"][k % 3]!, width: 2 + (k % 4), createdAt: 0, points, bbox } as InkStroke);
		k++;
	}
	// The box's far corner, so the ink box is the whole size whatever the grid's step.
	out.push({ id: "corner", tool: "pen", color: "#000000", width: 2, createdAt: 0,
		points: [{ x: w - 12, y: h - 12, pressure: 0.5, t: 0 }, { x: w - 6, y: h - 6, pressure: 0.5, t: 9 }],
		bbox: { x: w - 14, y: h - 14, width: 14, height: 14 } } as InkStroke);
	return out;
}

let root: HTMLElement;
let strokes: InkStroke[] = [];
/** The tile the layer holds; null on a build without tiles, as on a one-page note. */
type Tile = { x: number; y: number; bx: number; by: number; bw: number; bh: number };
const tileOf = (): Tile | null => ((Embed as Record<string, unknown>).embedInkTileOf as ((r: HTMLElement) => Tile | null) | undefined)?.(root) ?? null;
let paints = 0;
let handler: { fn: EventListener; ms: number[] } | null = null;

// Paints: one getContext per paint of the layer. The scroll listener the layer adds to the view: wrapped to time it.
const getContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...a: Parameters<typeof getContext>) {
	if (this.classList.contains("handwriting-embed-ink")) paints++;
	return (getContext as (...x: unknown[]) => unknown).apply(this, a);
} as typeof getContext;
const add = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) {
	if (type === "scroll" && this === root && typeof fn === "function") {
		const h = { fn, ms: [] as number[] };
		handler = h;
		const timed = function (this: unknown, e: Event) {
			const t0 = performance.now();
			h.fn.call(this, e);
			h.ms.push(performance.now() - t0);
		};
		return add.call(this, type, timed, o);
	}
	return add.call(this, type, fn, o);
};

async function mount(big: boolean, shape: "reading" | "export" = "reading") {
	Embed.teardownEmbedInk();
	document.body.replaceChildren();
	handler = null;
	root = document.createElement("div");
	root.className = "markdown-preview-view markdown-rendered";
	// An export renders into a view of its own with no sizer, every block a child of the view.
	(shape === "export" ? document.body.createDiv({ cls: "print" }) : document.body).appendChild(root);
	const sizer = shape === "export" ? root : root.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
	if (shape === "reading") sizer.createDiv({ cls: "markdown-preview-pusher" });
	const section = sizer.createDiv({ cls: "el-p" });
	section.innerHTML = "<p>A note whose drawing is far bigger than its text.</p>";
	await frame();
	const box = big ? BIG : PAGE;
	strokes = grid(box.w, box.h);
	Embed.initEmbedInkRefresh(() => strokes);
	paints = 0;
	Embed.attachEmbedInkOnceReady(section, sizer, "tile.md", () => strokes, undefined, false, {
		section: () => ({ text: "A note whose drawing is far bigger than its text.", lineStart: 0, lineEnd: 0 }),
		cached: () => null,
	});
	await frame();
	await frame();
	if (big && shape === "reading") {
		root.scrollTop = 1000;
		await frame();
		await frame();
	}
	return { paints, ...layer() };
}

function canvasOf(): HTMLCanvasElement | null {
	return root.querySelector<HTMLCanvasElement>(":scope > canvas.handwriting-embed-ink");
}

function layer() {
	const c = canvasOf();
	if (!c) return { error: "no layer" };
	const s = getComputedStyle(c);
	const cssW = c.clientWidth, cssH = c.clientHeight;
	const r = c.getBoundingClientRect(), v = root.getBoundingClientRect();
	const left = r.left + parseFloat(s.borderLeftWidth), top = r.top + parseFloat(s.borderTopWidth);
	return {
		width: c.width, height: c.height, cssW, cssH,
		density: cssW > 0 ? c.width / cssW : 0,
		holdsView: holds(c, left, top, cssW, cssH, r),
		scrollHeight: root.scrollHeight, scrollWidth: root.scrollWidth,
		borders: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].join(" "),
		style: c.getAttribute("style"),
		tile: tileOf(),
		dpr: devicePixelRatio,
	};
}

/**
 * Does the content box hold the part of the view the ink box covers? Page px. The ink box runs from the tile's own
 * place back by the tile's offset, to the border box's far edges; with no tile it is the canvas itself.
 */
function holds(c: HTMLCanvasElement, left: number, top: number, cssW: number, cssH: number, r: DOMRect): boolean {
	const t = tileOf();
	const v = { left: root.getBoundingClientRect().left + root.clientLeft, top: root.getBoundingClientRect().top + root.clientTop };
	const box = { left: left - (t?.x ?? 0), top: top - (t?.y ?? 0), right: r.right, bottom: r.bottom };
	const need = { left: Math.max(v.left, box.left), top: Math.max(v.top, box.top),
		right: Math.min(v.left + root.clientWidth, box.right), bottom: Math.min(v.top + root.clientHeight, box.bottom) };
	if (need.right <= need.left || need.bottom <= need.top) return c.width > 0;
	return left <= need.left + 0.5 && top <= need.top + 0.5 && left + cssW >= need.right - 0.5 && top + cssH >= need.bottom - 0.5;
}

function pixels(c: HTMLCanvasElement) {
	return { data: c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
}

/** Scroll the view (or, at 0, 0, repaint it where it is from a save), then compare the two tiles over their overlap. */
async function scrollBy(dy: number, dx = 0) {
	const c = canvasOf()!;
	const a = tileOf();
	const pa = pixels(c);
	paints = 0;
	if (dy === 0 && dx === 0) Embed.embedInkChanged("tile.md");
	root.scrollTop += dy;
	root.scrollLeft += dx;
	await frame();
	await frame();
	await frame();
	const counted = paints;
	const b = tileOf();
	const pb = pixels(c);
	let overlap = 0, differ = 0, inked = 0;
	const where: number[][] = [];
	// Differing px within 3 device px of either tile's edge, inside the overlap: a cluster there is a seam.
	let seam = 0;
	// Ink one tile drew and the other did not: one side blank, the other at least half covered. Raster noise moves
	// coverage by a little; a stroke one tile left out moves it from nothing to most.
	let missing = 0, seamMissing = 0;
	let maxDelta = 0;
	if (a && b) {
		const x0 = Math.max(a.bx, b.bx), x1 = Math.min(a.bx + a.bw, b.bx + b.bw);
		const y0 = Math.max(a.by, b.by), y1 = Math.min(a.by + a.bh, b.by + b.bh);
		for (let Y = y0; Y < y1; Y++) for (let X = x0; X < x1; X++) {
			const ia = ((Y - a.by) * pa.w + (X - a.bx)) * 4, ib = ((Y - b.by) * pb.w + (X - b.bx)) * 4;
			overlap++;
			if (pa.data[ia + 3]! > 0) inked++;
			if (pa.data[ia] !== pb.data[ib] || pa.data[ia + 1] !== pb.data[ib + 1] || pa.data[ia + 2] !== pb.data[ib + 2] || pa.data[ia + 3] !== pb.data[ib + 3]) { differ++; const onEdge = !!a && !!b && Math.min(X - a.bx, a.bx + a.bw - 1 - X, Y - a.by, a.by + a.bh - 1 - Y, X - b.bx, b.bx + b.bw - 1 - X, Y - b.by, b.by + b.bh - 1 - Y) < 3; if (onEdge) seam++; const aa = pa.data[ia + 3]!, ab = pb.data[ib + 3]!; if ((aa === 0 && ab >= 128) || (ab === 0 && aa >= 128)) { missing++; if (onEdge) seamMissing++; } for (let q = 0; q < 4; q++) maxDelta = Math.max(maxDelta, Math.abs((pa.data[ia + q]! * pa.data[ia + 3]!) - (pb.data[ib + q]! * pb.data[ib + 3]!)) / 255); if (where.length < 12) where.push([X, Y, pa.data[ia + 3]!, pb.data[ib + 3]!]); }
		}
	}
	return { paints: counted, before: a, after: b, overlap, inked, differ, seam, missing, seamMissing, maxDelta, where, ...layer() };
}

async function handlerCost(n: number) {
	if (!handler) return { error: "no scroll listener", ms: [] as number[] };
	handler.ms = [];
	for (let k = 0; k < n; k++) {
		root.scrollTop += k % 2 ? -3 : 3;
		await frame();
	}
	const ms = [...handler.ms].sort((p, q) => p - q);
	return { calls: ms.length, median: ms[Math.floor(ms.length / 2)] ?? 0, max: ms[ms.length - 1] ?? 0, ms };
}

/** The note's ink shrinks to one page and is saved: the layer leaves the tile path. */
async function shrink() {
	strokes = grid(PAGE.w, PAGE.h);
	Embed.embedInkChanged("tile.md");
	await frame();
	await frame();
	return layer();
}

const w = window as unknown as Record<string, unknown>;
w.shrink = shrink;
w.mount = mount;
w.layer = layer;
w.scrollBy = scrollBy;
w.handlerCost = handlerCost;
