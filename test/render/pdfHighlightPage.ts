/**
 * A PDF page stand-in under the real PdfInkController: one page div holding an
 * opaque canvas with glyph pixels, as pdf.js lays a page out, and the shipped
 * stylesheet (injected by the test). The controller's own sync, paint, wet pair
 * and snip run on it; strokes are saved straight into its store, and live
 * strokes go through its own pen callbacks. Nothing of the plugin is stubbed.
 */
import { PdfInkController } from "../../src/pdf/PdfInkController";
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

/** The page, in css px and in points (scale 1). */
export const PAGE = { w: 600, h: 800 };
/** The glyph: an opaque block of text colour on the page canvas. */
export const GLYPH = { x: 200, y: 285, w: 60, h: 30 };

let controller: PdfInkController | null = null;
let root: HTMLElement | null = null;
let pageEl: HTMLElement | null = null;
let strokes: InkStroke[] = [];
let clock = 0;
let ids = 0;

function line(a: Pt, b: Pt, step = 10): Pt[] {
	const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step));
	return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
}

function saved(tool: "pen" | "highlighter", a: Pt, b: Pt, color: string, width: number): InkStroke {
	const points = line(a, b).map((p, i) => ({ x: p.x, y: p.y, pressure: 0.5, t: i * 8 }));
	return { id: `s${++ids}`, tool, color, width, points, bbox: computeBBox(points, width), createdAt: 0, page: 1 };
}

/** Build the page. `dark`: a dark page with light glyphs, as a dark slide deck is. */
async function open(dark: boolean, assumption: PdfPageAssumption): Promise<void> {
	controller?.unmount();
	root?.remove();
	strokes = [];
	document.body.className = "theme-light";
	root = document.body.createDiv();
	root.style.cssText = "position:absolute;left:0;top:0;width:620px;height:820px";
	const scroller = root.createDiv({ cls: "pdfViewer" });
	scroller.style.cssText = "position:relative;width:620px;height:820px;overflow:auto;background:#808080";
	pageEl = scroller.createDiv({ cls: "page" });
	pageEl.setAttribute("data-page-number", "1");
	pageEl.style.cssText = `position:relative;margin:0;width:${PAGE.w}px;height:${PAGE.h}px;--scale-factor:1`;
	const wrap = pageEl.createDiv({ cls: "canvasWrapper" });
	const canvas = wrap.createEl("canvas");
	canvas.width = PAGE.w;
	canvas.height = PAGE.h;
	canvas.style.cssText = `display:block;width:${PAGE.w}px;height:${PAGE.h}px`;
	const g = canvas.getContext("2d")!;
	g.fillStyle = dark ? "rgb(30,30,30)" : "#ffffff";
	g.fillRect(0, 0, PAGE.w, PAGE.h);
	g.fillStyle = dark ? "#ffffff" : "#000000";
	g.fillRect(GLYPH.x, GLYPH.y, GLYPH.w, GLYPH.h);
	controller = new PdfInkController(
		root,
		window,
		() => strokes,
		() => "pdf-highlight-fixture",
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
	controller.mount();
	await frames(4);
}

/** Save strokes into the store and let the controller repaint, as an adoption from disk does. */
async function save(list: Array<{ tool: "pen" | "highlighter"; a: Pt; b: Pt; color?: string; width?: number }>): Promise<void> {
	for (const s of list) {
		strokes = [...strokes, saved(s.tool, s.a, s.b, s.color ?? (s.tool === "highlighter" ? HIGHLIGHTER_HEX : "#000000"), s.width ?? (s.tool === "highlighter" ? 24 : 6))];
	}
	(controller as unknown as { refresh(): void }).refresh();
	await frames(4);
}

type Pen = { penDown(s: PenSample, ev?: unknown): void; penRaw(s: PenSample[], ev?: unknown): void; penUp(ev?: unknown): void };
const pen = (): Pen => controller as unknown as Pen;
const at = (p: Pt): PenSample => ({ x: p.x, y: p.y, pressure: 0.5, timestamp: (clock += 16), tiltX: 0, tiltY: 0 });

/** A live stroke through the controller's own pen callbacks, held at its last point (no lift). */
async function hold(tool: "pen" | "highlighter", a: Pt, b: Pt, color?: string): Promise<void> {
	setInlineTool(tool);
	if (color) setInkColorHex(tool, color);
	else if (tool === "highlighter") setInkColorHex("highlighter", HIGHLIGHTER_HEX);
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

/** The page's own elements, for the record each cell logs. */
function layers(): Array<{ tag: string; cls: string; opacity: string; blend: string; parent: string }> {
	return [...(pageEl?.querySelectorAll<HTMLElement>(".handwriting-pdf-ink") ?? [])].map((el) => ({
		tag: el.tagName.toLowerCase(),
		cls: el.className,
		opacity: getComputedStyle(el).opacity,
		blend: getComputedStyle(el).mixBlendMode,
		parent: el.parentElement === pageEl ? "page" : el.parentElement?.className ?? "",
	}));
}

/** Select every saved stroke and snip; the PNG and where page point (0, 0) and one point land in it. */
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
	// The same crop the snip took: the viewer's canvas is 1 backing px per point here.
	const vp = snipViewport(b, 8, PAGE.w, PAGE.h, 1, 8_000_000);
	if (!vp) throw new Error("no snip viewport");
	let s = "";
	for (const byte of result.bytes) s += String.fromCharCode(byte);
	return { b64: btoa(s), x0: vp.x0, y0: vp.y0, scale: vp.scale };
}

const api = { open, save, hold, lift, layers, snip, sample, frames };
declare global {
	interface Window {
		pdfHighlight: typeof api;
	}
}
window.pdfHighlight = api;
