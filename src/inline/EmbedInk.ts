/**
 * Ink in rendered markdown (roadmap: ink showing in embeds).
 *
 * The overlay only ever painted the live editor. Everywhere else a note's
 * markdown is RENDERED - an ![[embed]] of it, or its own reading view - the
 * page showed text and no ink. This paints the committed strokes there,
 * read-only, using the committed renderer.
 *
 * Anchoring is the fixed-grid doctrine applied honestly: strokes live at
 * note-space coordinates, so they draw at those coordinates from the
 * rendered content's top-left. A rendered page wraps its text differently
 * than the editor did (narrower embed, different padding), and the ink does
 * not chase the text - it never does.
 *
 * Mechanics: markdown post-processors run once per SECTION, and the section
 * element is not attached to the document yet when the processor runs. So
 * each section registers a MarkdownRenderChild; on load (now attached) it
 * walks up to the rendered document's root and attaches ONE ink layer
 * there, keyed by a data attribute so the other sections' children see it
 * and stand down.
 *
 * Staleness (1.0.5): ink saves touch the sidecar and never the .md, so a
 * rendered embed used to keep its picture until Obsidian happened to
 * re-render it. Now every attached root sits in a registry, and one
 * ink-changed notification per persisted gesture repaints the roots showing
 * that path. The marker attribute carries a per-path revision, so attach
 * stays idempotent when nothing changed and repaints when the revision
 * moved. Disconnected roots are swept on every notification; the registry
 * holds at most a screenful of embeds between gestures.
 */

import { CameraState } from "../camera/coordinates";
import { drawStroke } from "../ink/StrokeRenderer";
import { InkStroke } from "../ink/Stroke";
import { InkSvgRun, inkSvgLayers } from "../ink/SvgExport";
import { HIGHLIGHTER_ALPHA } from "../ink/PenStyle";

/**
 * Total device pixels one rendered layer may hold.
 *
 * This replaced a 2048px cap on each SIDE, which was the wrong shape for the
 * thing it was protecting against. A per-side cap does not bound cost - two
 * capped sides still buy 4.2M pixels - and it CLIPS: a note with ink below
 * 2048px lost it, in reading view and in anything printed from it. Ink
 * silently missing from a page is a worse failure than a heavy canvas.
 *
 * An area budget bounds the real cost (this is 16MB of RGBA) while letting a
 * tall narrow page be tall. When ink genuinely exceeds it, the layer degrades
 * in RESOLUTION rather than dropping strokes - every stroke still renders,
 * slightly softer. Hover previews and multi-embed notes each pay for their
 * own canvas, so this is a battery bound as much as a memory one.
 */
const MAX_LAYER_PX = 4_000_000;
const MARKER_ATTR = "data-handwriting-embed-ink";
const SVG_NS = "http://www.w3.org/2000/svg";

/** Windows whose print swap is already wired; popouts each get their own. */
const printArmed = new WeakSet<Window>();
/**
 * Teardowns for the print listeners, because the WeakSet above cannot survive
 * a plugin reload. Disable and re-enable and the module is evaluated afresh:
 * the set is empty, the listeners are added again, and the previous pair is
 * still on the window calling into the old module. Printing then fires both.
 */
const printDisarms: Array<() => void> = [];
/**
 * How many times a print actually asked for the vector layer.
 *
 * `beforeprint` is not guaranteed: an export that renders through its own
 * pipeline rather than the browser's print flow may never fire it, and the
 * symptom of that is indistinguishable by eye from a swap that fired and
 * didn't help. A count settles it in one export instead of another round of
 * inference from how the ink looks.
 */
let printSwaps = 0;

export function embedInkPrintSwaps(): number {
	return printSwaps;
}

const CAM: CameraState = { x: 0, y: 0, zoom: 1 };

/** Live rendered roots, each mapped to the note path it shows. */
const layers = new Map<HTMLElement, string>();
/** Bumped per path on every persisted change; part of the marker. */
const revisions = new Map<string, number>();
let strokesFor: ((path: string) => readonly InkStroke[]) | null = null;

/**
 * The rendered document's root for a section element, if recognizable.
 *
 * Tried in order of how well each one pins the note's coordinate origin. The
 * last two are a fallback for render contexts that have no sizer at all -
 * an export or a print renders the markdown into a container of its own, and
 * "no sizer" there meant no root, which meant no ink on the page. A sizer,
 * where one exists, still wins: `closest` reaches it first walking up.
 */
export function embedInkRoot(sectionEl: HTMLElement): HTMLElement | null {
	return (
		sectionEl.closest<HTMLElement>(".markdown-embed-content") ??
		sectionEl.closest<HTMLElement>(".markdown-preview-sizer") ??
		sectionEl.closest<HTMLElement>(".markdown-preview-view") ??
		sectionEl.closest<HTMLElement>(".markdown-rendered")
	);
}

/** Pure: the css extent that covers every stroke. Never clipped. */
export function embedInkExtent(strokes: readonly InkStroke[]): { w: number; h: number } {
	let maxX = 0;
	let maxY = 0;
	for (const s of strokes) {
		maxX = Math.max(maxX, s.bbox.x + s.bbox.width);
		maxY = Math.max(maxY, s.bbox.y + s.bbox.height);
	}
	return { w: Math.ceil(maxX), h: Math.ceil(maxY) };
}

/**
 * Pure: device pixels per css pixel for a layer of this size.
 *
 * The display's own ratio, unless that would exceed the budget, in which case
 * as much resolution as the budget affords. Rendered ink used to be drawn at
 * exactly 1x - one device pixel per css pixel - which is soft on every modern
 * screen and softer still in an exported PDF, where it sits beside text that
 * was rasterized at the printer's resolution.
 */
export function embedInkScale(w: number, h: number, dpr: number): number {
	if (w <= 0 || h <= 0) return 1;
	const want = Math.max(1, dpr);
	const area = w * h * want * want;
	if (area <= MAX_LAYER_PX) return want;
	return Math.max(0.25, Math.sqrt(MAX_LAYER_PX / (w * h)));
}

/** Pure: what the marker attribute holds for a (path, revision) pair. */
export function embedInkMarker(path: string, rev: number): string {
	return `${path}@${rev}`;
}

/**
 * Pure: does this root need painting?
 *
 * The marker alone is not proof the picture is still there. Reading view
 * re-renders its sections as you scroll while KEEPING the sizer element, so
 * Obsidian can drop our canvas and leave the attribute behind - and a
 * marker-only check then decides everything is up to date and paints nothing.
 * That is why a note's own reading view came up blank while an embed of the
 * same note was fine: an embed is rebuilt whole, marker and all (reported
 * twice, iPad and Onyx Boox, 2026-08-27).
 */
export function embedInkNeedsPaint(
	currentMarker: string | null,
	wantedMarker: string,
	hasCanvas: boolean
): boolean {
	return currentMarker !== wantedMarker || !hasCanvas;
}

/** Diagnostics: how many rendered roots the registry currently holds. */
export function embedInkLayerCount(): number {
	return layers.size;
}

/** Where repaints read fresh strokes from. Wired once at plugin load. */
export function initEmbedInkRefresh(provider: (path: string) => readonly InkStroke[]): void {
	strokesFor = provider;
}

/**
 * A note's ink was persisted: bump its revision and repaint every connected
 * root showing it. Every notification also sweeps roots the DOM dropped.
 */
export function embedInkChanged(path: string): void {
	revisions.set(path, (revisions.get(path) ?? 0) + 1);
	sweepDisconnected();
	for (const [root, p] of layers) {
		if (p !== path) continue;
		paint(root, path, strokesFor ? strokesFor(path) : []);
	}
}

/**
 * Drop roots the DOM let go of. Runs on every attach AND every change
 * notification, so growth is bounded by render activity as well as save
 * activity - a session that only READS (hover previews register roots and
 * never draws) must not accumulate detached trees and their canvases.
 */
function sweepDisconnected(): void {
	for (const root of [...layers.keys()]) {
		if (!root.isConnected) layers.delete(root);
	}
}

/**
 * Attach (or refresh) the ink layer on a rendered document root and put it
 * in the registry. Idempotent per (root, path, revision): a second section
 * with the same path finds the marker and leaves the existing layer alone.
 * Registered even with zero strokes, so an embed rendered before its note
 * was ever drawn on still gains ink at the first gesture.
 */
export function attachEmbedInk(
	root: HTMLElement,
	path: string,
	strokes: readonly InkStroke[]
): void {
	sweepDisconnected();
	layers.set(root, path);
	armPrintSwap(root.ownerDocument.defaultView ?? window);
	paint(root, path, strokes);
}

/**
 * Canvas on screen, vector on paper.
 *
 * The two representations are good at opposite things and the choice is not a
 * compromise, it is a switch. A canvas costs what the PAGE costs - ten strokes
 * and ten thousand render identically - so no amount of drawing can slow a
 * note down, which is the only acceptable behaviour for a surface people are
 * meant to draw freely on. But a canvas is a fixed grid of pixels, and a
 * printer wants a resolution nobody knew at render time, so ink came out of a
 * PDF visibly soft beside the text.
 *
 * Vector has exactly the inverse profile: nothing to choose a resolution for,
 * and a cost that grows with how much was drawn. So it exists only while a
 * print is actually happening - built on `beforeprint`, dropped on
 * `afterprint`, never present during ordinary use.
 *
 * If a print path never fires these events, nothing swaps and the canvas is
 * printed, which is exactly the behaviour before any of this. The failure mode
 * is the old output, not a broken one.
 */
function armPrintSwap(win: Window): void {
	if (printArmed.has(win)) return;
	printArmed.add(win);
	const on = () => usePrintVector(true);
	const off = () => usePrintVector(false);
	win.addEventListener("beforeprint", on);
	win.addEventListener("afterprint", off);
	printDisarms.push(() => {
		win.removeEventListener("beforeprint", on);
		win.removeEventListener("afterprint", off);
	});
	// Second trigger, because the first is unreliable. A print stylesheet
	// becoming active is a media-query change, and some print paths flip that
	// without ever dispatching beforeprint. Both are idempotent: whichever
	// arrives first builds the layer and the other finds it already there.
	const mq = win.matchMedia?.("print");
	const onMq = (e: MediaQueryListEvent) => usePrintVector(e.matches);
	mq?.addEventListener?.("change", onMq);
	if (mq) printDisarms.push(() => mq.removeEventListener?.("change", onMq));
}

/** Drop the print listeners at unload, so a reload cannot leave a pair behind. */
export function disarmPrintSwaps(): void {
	for (const d of printDisarms.splice(0)) d();
}

function usePrintVector(on: boolean): void {
	if (on) printSwaps++;
	sweepDisconnected();
	for (const [root, path] of layers) {
		const canvas = root.querySelector<HTMLCanvasElement>(
			":scope > canvas.handwriting-embed-ink"
		);
		const existing = root.querySelector<SVGSVGElement>(
			":scope > svg.handwriting-embed-ink"
		);
		if (!on) {
			existing?.remove();
			canvas?.style.removeProperty("display");
			continue;
		}
		const strokes = strokesFor ? strokesFor(path) : [];
		const { w, h } = embedInkExtent(strokes);
		if (strokes.length === 0 || w <= 0 || h <= 0) continue;
		// createElementNS, not createEl: an <svg> built as an HTML element is
		// an unknown tag that renders nothing.
		const svg = existing ?? root.ownerDocument.createElementNS(SVG_NS, "svg");
		svg.setAttribute("class", "handwriting-embed-ink");
		svg.setAttribute("aria-hidden", "true");
		svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
		svg.setAttribute("width", `${w}`);
		svg.setAttribute("height", `${h}`);
		// Built as elements rather than markup. The content is safe either
		// way - colours pass through normalizeInkColor and the rest is
		// formatted numbers - but assigning markup is flagged on sight by
		// the community review, and building nodes costs nothing here.
		while (svg.firstChild) svg.removeChild(svg.firstChild);
		const layers = inkSvgLayers(strokes);
		if (layers.highlighter.length > 0) {
			const g = root.ownerDocument.createElementNS(SVG_NS, "g");
			g.setAttribute("opacity", String(HIGHLIGHTER_ALPHA));
			for (const run of layers.highlighter) g.appendChild(inkPathEl(root, run));
			svg.appendChild(g);
		}
		for (const run of layers.pen) svg.appendChild(inkPathEl(root, run));
		if (!existing) root.appendChild(svg);
		canvas?.setCssStyles({ display: "none" });
	}
}

/** One merged run as an SVG <path>, in the root's own document. */
function inkPathEl(root: HTMLElement, run: InkSvgRun): SVGPathElement {
	const el = root.ownerDocument.createElementNS(SVG_NS, "path");
	el.setAttribute("fill", run.color);
	el.setAttribute("fill-rule", "nonzero");
	el.setAttribute("d", run.d);
	return el;
}

function paint(root: HTMLElement, path: string, strokes: readonly InkStroke[]): void {
	const marker = embedInkMarker(path, revisions.get(path) ?? 0);
	let canvas = root.querySelector<HTMLCanvasElement>(
		":scope > canvas.handwriting-embed-ink"
	);
	if (!embedInkNeedsPaint(root.getAttribute(MARKER_ATTR), marker, canvas !== null)) return;
	root.setAttribute(MARKER_ATTR, marker);
	const view = root.ownerDocument.defaultView ?? window;
	const { w, h } = embedInkExtent(strokes);
	if (strokes.length === 0 || w <= 0 || h <= 0) {
		// The last stroke was erased: the picture goes too.
		canvas?.remove();
		return;
	}
	if (view.getComputedStyle(root).position === "static") {
		root.setCssStyles({ position: "relative" });
	}
	if (!canvas) {
		canvas = root.createEl("canvas", { cls: "handwriting-embed-ink" });
	}
	// The canvas is sized in DEVICE pixels and laid out in css pixels, so the
	// strokes below can go on drawing in note units and come out sharp.
	const scale = embedInkScale(w, h, view.devicePixelRatio || 1);
	const backingW = Math.max(1, Math.round(w * scale));
	const backingH = Math.max(1, Math.round(h * scale));
	if (canvas.width !== backingW || canvas.height !== backingH) {
		canvas.width = backingW;
		canvas.height = backingH;
		canvas.setCssStyles({ width: `${w}px`, height: `${h}px` });
	}
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.setTransform(scale, 0, 0, scale, 0, 0);
	ctx.clearRect(0, 0, w, h);
	// Highlighter first and translucent as a layer would be; then pen.
	ctx.globalAlpha = 0.35;
	for (const s of strokes) if (s.tool === "highlighter") drawStroke(ctx, CAM, s, undefined, true);
	ctx.globalAlpha = 1;
	for (const s of strokes) if (s.tool !== "highlighter") drawStroke(ctx, CAM, s, undefined, true);
}
