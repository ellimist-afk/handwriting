/**
 * The embed ink print path: the swap to a vector layer while a print or an export runs, the fit of the printed
 * column, the strips and the export diagnostic line. EmbedInk.ts re-exports the names it exported before.
 */
import { InkStroke } from "../ink/Stroke";
import { inkSvgLayers, InkSvgRun } from "../ink/SvgExport";
import { HIGHLIGHTER_ALPHA, shapeFor } from "../ink/PenStyle";
import { anchorLayer, anchorSizer, columnWidthFor, diagnose, embedInkBounds, inkZoomOf, isNotColumn, layerOrigins, layers, MIN_HEIGHT_ATTR, placeStrokes, reserveLeft, strokesFor, SVG_NS, sweepDisconnected } from "./EmbedInk";

/** Windows whose print swap is already wired; popouts each get their own. */
const printArmed = new WeakSet<Window>();
/**
 * Windows whose print is running now: set when the swap asks for the vector
 * layer, cleared when it lets go, and when the window closes. An embed that
 * attaches while its window is printing (its note was still being read) joins
 * the print; with no print the module never builds a vector layer.
 */
export const printing = new WeakSet<Window>();
/**
 * Teardowns for the print listeners, because the WeakSet above cannot survive
 * a plugin reload. Disable and re-enable and the module is evaluated afresh:
 * the set is empty, the listeners are added again, and the previous pair is
 * still on the window calling into the old module. Printing then fires both.
 *
 * Kept per window, and a window's entry leaves when that window closes: each
 * teardown holds its Window, so a flat list emptied only at unload kept every
 * closed popout that ever rendered an embed alive until the plugin went
 * (audit 58).
 */
const printDisarms = new Map<Window, Array<() => void>>();
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

/**
 * What the print vector layer is landing on.
 *
 * This layer exists ONLY while a print or an export is happening, and what it
 * lands on then is paper or a PDF page rather than the reading view's theme -
 * a print stylesheet drops the page to white whatever the editor looked like.
 * That is why the ink is made readable against white here and NOT against the
 * body's background: the swap is the moment the destination stops being the
 * screen. Outside the swap this module paints canvases, which are on-screen
 * surfaces and are left alone.
 */
const PRINT_PAGE_WHITE = "#ffffff";

/** The text of the export's diagnostic line, left here for `embedInkDiagLine` (see `noteExport`). */
export let printNote = "";

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
export function armPrintSwap(win: Window): void {
	if (printArmed.has(win)) return;
	printArmed.add(win);
	const disarms: Array<() => void> = [];
	printDisarms.set(win, disarms);
	const on = () => usePrintVector(true, win);
	const off = () => usePrintVector(false, win);
	win.addEventListener("beforeprint", on);
	win.addEventListener("afterprint", off);
	disarms.push(() => {
		win.removeEventListener("beforeprint", on);
		win.removeEventListener("afterprint", off);
	});
	// Second trigger, because the first is unreliable. A print stylesheet
	// becoming active is a media-query change, and some print paths flip that
	// without ever dispatching beforeprint. Both are idempotent: whichever
	// arrives first builds the layer and the other finds it already there.
	const mq = win.matchMedia?.("print");
	const onMq = (e: MediaQueryListEvent) => usePrintVector(e.matches, win);
	mq?.addEventListener?.("change", onMq);
	if (mq) disarms.push(() => mq.removeEventListener?.("change", onMq));
	// A popout closing lets go of its window here, not at plugin unload.
	// pagehide rather than unload: it fires on every close, and Chromium is
	// retiring unload.
	const onClose = () => {
		printing.delete(win);
		printDisarms.delete(win);
		// A window that outlives pagehide (kept for back/forward) arms again
		// at its next embed.
		printArmed.delete(win);
		for (const d of disarms) d();
	};
	win.addEventListener("pagehide", onClose);
	disarms.push(() => win.removeEventListener("pagehide", onClose));
}

/**
 * Whether a note shows Infinite Canvas now: its own choice, else the global one, as the overlay answers it. Wired by
 * the note surface beside the strokes provider; null (no answer) keeps every note on today's rule.
 */
let canvasNoteFor: ((path: string) => boolean) | null = null;

export function initEmbedInkPrintCanvas(provider: ((path: string) => boolean) | null): void {
	canvasNoteFor = provider;
}

/** Drop the print listeners at unload, so a reload cannot leave a pair behind. */
export function disarmPrintSwaps(): void {
	canvasNoteFor = null;
	const all = [...printDisarms.values()];
	printDisarms.clear();
	for (const disarms of all) for (const d of disarms) d();
}

function usePrintVector(on: boolean, win?: Window): void {
	if (on) printSwaps++;
	if (win) {
		if (on) printing.add(win);
		else printing.delete(win);
	}
	sweepDisconnected();
	for (const [root, path] of layers) printVectorFor(root, path, on);
}

/**
 * One root's print layer: built from the ink as it is now, or taken away.
 * Called for every root when a print starts or ends, for a root whose ink
 * changes under a print that is running (its canvas is hidden then, so the
 * vector layer is the picture), and for a root that attaches mid-print.
 */
export function printVectorFor(root: HTMLElement, path: string, on: boolean): void {
	const canvas = root.querySelector<HTMLCanvasElement>(
		":scope > canvas.handwriting-embed-ink"
	);
	const existing = root.querySelector<SVGSVGElement>(
		":scope > svg.handwriting-embed-ink"
	);
	if (!on) {
		existing?.remove();
		releasePrintStrips(root);
		printSpans.delete(root);
		printFoots.delete(root);
		releasePrintFit(root);
		canvas?.style.removeProperty("display");
		// Back on screen: the print's room comes off and a reading view's scroll room returns.
		if (canvas) {
			reserveLeft(root);
			anchorLayer(root, canvas);
		}
		return;
	}
	const all = strokesFor ? strokesFor(path) : [];
	const box = embedInkBounds(all);
	if (all.length === 0 || box.w <= 0 || box.h <= 0) {
		// The last stroke went while the print ran: the vector layer goes too.
		existing?.remove();
		releasePrintStrips(root);
		return;
	}
	// The ink at its text's size, as the canvas draws it (`inkZoomOf`): px per world unit. Read before the fit.
	const zoom = inkZoomOf(root, path);
	// An Infinite Canvas note can hold ink anywhere. While all of it lies on the text's pages the note prints as any note does
	// (the width fit of all the ink, the room grown for it). Once ink leaves those pages the export is one page: the text and every
	// stroke are fitted together, as Fit shows them (`wantsOnePage`). The screen call lays the text out at the column width first,
	// so its foot is read as it will print.
	const onCanvas = canvasNoteFor?.(path) === true;
	let spans: number | null | undefined = onCanvas ? holdPrintSpans(root, path) : undefined;
	const foot = onCanvas ? textFoot(root) : null;
	// The print-media call keeps the layout the screen call chose; a print with no screen call keeps the plain layout.
	const chosen = onCanvas ? printFits.get(root)?.onePage === true : false;
	// Ink left of the text is on the page: the container is padded by the reach. Ink above the text likewise, once it is placed.
	const reachLeft = chosen ? Math.max(0, -embedInkBounds(all, zoom).x) : 0;
	// Before the layer is anchored: the text re-wraps at the column width, so the first block is measured after.
	// A placed stroke moves down or up only, so the ink's right edge is the stored one, drawn at the zoom.
	const fit = fitPrintColumn(root, path, (box.x + box.w) * zoom, reachLeft);
	spans = fit ? null : spans !== undefined ? spans : holdPrintSpans(root, path);
	holdReach(root, reachLeft, 0);
	// Placed once the column width holds. The print-media call has paged the layout, and a block on a later page reads a
	// top that includes the room left at the foot of the page before it: there the tops held before paging are used.
	const held = fit ? printSpans.get(root) : undefined;
	const blocks = held ? printBlocks(root) : [];
	const strokes = placeStrokes(root, all, held && blocks.length === held.tops.length ? { blocks, tops: held.tops } : undefined, zoom, path).strokes;
	// The layer's box in px, as the canvas's; the viewBox is that box in world units, so the svg draws them at the zoom.
	const { x, y, w, h } = embedInkBounds(strokes, zoom);
	layerOrigins.set(root, { x, y });
	// createElementNS, not createEl: an <svg> built as an HTML element is
	// an unknown tag that renders nothing.
	const svg = existing ?? root.ownerDocument.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", "handwriting-embed-ink");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("viewBox", `${x / zoom} ${y / zoom} ${w / zoom} ${h / zoom}`);
	svg.setAttribute("width", `${w}`);
	svg.setAttribute("height", `${h}`);
	// Built as elements rather than markup. The content is safe either
	// way - colours pass through normalizeInkColor and the rest is
	// formatted numbers - but assigning markup is flagged on sight by
	// the community review, and building nodes costs nothing here.
	while (svg.firstChild) svg.removeChild(svg.firstChild);
	appendInk(root, svg, strokes);
	if (!existing) root.appendChild(svg);
	// A print lays the page out at the paper's width, so the room is measured again.
	reserveLeft(root);
	holdReach(root, reachLeft, chosen ? Math.max(0, -y) : 0);
	anchorLayer(root, svg);
	// Again here: a print lays the page out anew, and a title that wraps at
	// the paper's width moves the layer down after the paint grew the room.
	growPrintContainer(root, svg, h);
	// The screen call decides the layout once the layer stands and the room is grown; ink that left the text's pages pads the
	// container by its reach, and the layer is placed again inside the padding.
	let onePage = chosen;
	if (!fit && onCanvas && foot !== null) {
		const inkFoot = Number.parseFloat(root.style.minHeight ?? "");
		const shown = inkReachOf(strokes, zoom);
		onePage = wantsOnePage(root, path, { x: shown.x, y: shown.y, bottom: Number.isFinite(inkFoot) ? inkFoot : y + h, right: (box.x + box.w) * zoom }, foot);
		const heldFit = printFits.get(root);
		if (heldFit) heldFit.onePage = onePage;
		if (onePage !== chosen) {
			holdReach(root, onePage ? Math.max(0, -embedInkBounds(all, zoom).x) : 0, onePage ? Math.max(0, -y) : 0);
			anchorLayer(root, svg);
			growPrintContainer(root, svg, h);
		}
	}
	// The print-media call is the one that has paged the layout: the ink is cut into one strip per block then.
	const strips = fit ? buildPrintStrips(root, svg, { x, y, w, h }, strokes, zoom) : 0;
	canvas?.setCssStyles({ display: "none" });
	// At the screen call (no fit yet), after the layer is placed from the unzoomed flow: the zoom for the page count.
	const screened = fit ? null : holdScreenZoom(root, path, (box.x + box.w) * zoom, onePage && foot !== null ? { reachLeft: Math.max(0, -embedInkBounds(all, zoom).x), reachTop: Math.max(0, -y), foot } : undefined);
	noteExport(root, path, fit ?? screened, spans, strips);
}

/** The foot of a note's text, px from its layer's top: the container's height, read once before a layer grows it and held to the print's end. */
const printFoots = new WeakMap<HTMLElement, number>();

/**
 * The foot of a canvas note's text in a print container, px: the container's height before a layer grows it or a reach pads it,
 * read once and held to the print's end. The canvas paint has already grown the container to the foot of all the ink: the
 * text's own height is read with that room taken off, and put back. The box height, not the scroll height: the canvas the
 * paint laid out, as tall as the ink, overflows the box and would count in the scroll height. Null with no print container.
 */
function textFoot(root: HTMLElement): number | null {
	if (!isPrintContainer(root) || !root.offsetParent) return null;
	let foot = printFoots.get(root);
	if (foot === undefined) {
		const grown = root.getAttribute(MIN_HEIGHT_ATTR);
		const ours = grown !== null && root.style.minHeight === grown;
		if (ours) root.style.removeProperty("min-height");
		foot = root.offsetHeight || 0;
		if (ours && grown !== null) root.style.minHeight = grown;
		printFoots.set(root, foot);
	}
	return foot;
}

/** Obsidian's print container: a `.markdown-preview-view` with no sizer (see `printAnchor`). */
export function isPrintContainer(root: HTMLElement): boolean {
	return root.classList?.contains("markdown-preview-view") === true && anchorSizer(root) === null;
}

/** What a print changed on its container: the inline width and zoom it had, and the paper it measured. */
interface PrintFit {
	width: string;
	zoom: string;
	overflow: string;
	/** The container's own width before the print changed it: the paper, padding and scrollbar included. */
	paper: number;
	/** Left plus right padding, px. */
	pad: number;
	/** The left and top padding the theme gives, px, and the inline values the container had; a canvas note's reach pads on top of them. */
	padLeft: number;
	padTop: number;
	paddingLeft: string;
	paddingTop: string;
	/** The width the print lays the container out at before any reach, and whether it is a border box (the padding counts in it). */
	layoutWidth: number;
	borderBox: boolean;
	/** Room a canvas note's ink needs left of and above its text, px: the container is padded by it. */
	reachLeft: number;
	reachTop: number;
	/** The zoom the screen call set from the viewport (see `holdScreenZoom`); the print-media call keeps it. Unset: no screen call fitted. */
	screenZoom?: number;
	/** The paper's width in px the screen call computed from the export dialog's settings; the print-media call checks the measured paper against it. */
	screenPaper?: number;
	/** A canvas note whose ink left the text's pages: the screen call chose the one-page layout, the print-media call keeps it. */
	onePage?: boolean;
	/** The one-page box's height in px the screen call fitted to the saved page's height, and that height; unset for a width fit. */
	screenTall?: number;
	screenPage?: number;
}

const printFits = new WeakMap<HTMLElement, PrintFit>();

/**
 * Lay the container out at the column width and keep it there until the print ends.
 *
 * The print counts its pages from the layout it makes as the media flips, before the print-media call can change
 * anything, and prints nothing past that count. A container still as wide as the paper at that moment counts fewer
 * lines than the column's width wraps to, so the last lines of a long note were lost. The screen call therefore sets
 * the width (and no scrollbar: it would take 15 px off the text width) and the print-media call only adds the zoom.
 * The container's own width, zoom and overflow are held for `releasePrintFit`; the paper is read at the print-media
 * call (`paper` 0 until then).
 */
function holdPrintLayout(root: HTMLElement, column: number): PrintFit {
	const style = root.ownerDocument?.defaultView?.getComputedStyle?.(root);
	const pad = (parseFloat(style?.paddingLeft ?? "") || 0) + (parseFloat(style?.paddingRight ?? "") || 0);
	const borderBox = style?.boxSizing !== "content-box";
	const layoutWidth = column + (borderBox ? pad : 0);
	const held: PrintFit = {
		width: root.style.width, zoom: root.style.zoom, overflow: root.style.overflow, paper: 0, pad,
		padLeft: parseFloat(style?.paddingLeft ?? "") || 0, padTop: parseFloat(style?.paddingTop ?? "") || 0,
		paddingLeft: root.style.paddingLeft, paddingTop: root.style.paddingTop, layoutWidth, borderBox, reachLeft: 0, reachTop: 0,
	};
	printFits.set(root, held);
	root.setCssStyles({ overflow: "visible" });
	root.style.width = `${layoutWidth}px`;
	return held;
}

/** Room kept around the ink inside the shrunk page, px (right and below it; left and above it where it reaches past the text). */
const PRINT_INK_PAD = 16;

/**
 * Pad a canvas note's print container by the room its ink needs left of and above the text, so the layer's origin, which lies
 * at the ink's own left and top, falls on the page and not off it. The text stays where it is relative to the first block; the
 * anchor moves with the padding. The container's own width grows by the left reach when it is a border box. Idempotent: the
 * theme's padding and the width are the ones held by `holdPrintLayout`, a reach of 0 puts them back, and `releasePrintFit`
 * gives them back at the print's end.
 */
function holdReach(root: HTMLElement, left: number, top: number): void {
	const held = printFits.get(root);
	if (!held) return;
	if (left !== held.reachLeft) {
		held.reachLeft = left;
		if (left > 0) root.style.paddingLeft = `${held.padLeft + left}px`;
		else if (held.paddingLeft) root.style.paddingLeft = held.paddingLeft;
		else root.style.removeProperty("padding-left");
		if (held.borderBox) root.style.width = `${held.layoutWidth + left}px`;
	}
	if (top !== held.reachTop) {
		held.reachTop = top;
		if (top > 0) root.style.paddingTop = `${held.padTop + top}px`;
		else if (held.paddingTop) root.style.paddingTop = held.paddingTop;
		else root.style.removeProperty("padding-top");
	}
}

/**
 * Whether a canvas note's ink has left the pages its text makes, so the note exports as one page. At the screen call, with the
 * layer placed and the container grown to its foot. Ink at x or y of at least minus the print pad, whose bottom is at most the
 * text's foot plus one page's height at the width fit's zoom, is on the text's pages. Anything else is not. Without the export
 * dialog's settings the page's size is not known, and the note keeps the plain layout.
 */
function wantsOnePage(root: HTMLElement, path: string, ink: { x: number; y: number; bottom: number; right: number }, foot: number): boolean {
	if (!isPrintContainer(root) || !root.offsetParent || !columnWidthFor || printMedia(root)) return false;
	const column = printColumnFor(path);
	if (column === null || !Number.isFinite(column) || column <= 0) return false;
	const held = printFits.get(root);
	if (!held) return false;
	let saved: unknown = null;
	try {
		saved = paperSettingsFor ? paperSettingsFor() : null;
	} catch {
		// The config is unofficial API: a provider that throws is no settings.
	}
	const paper = paperWidthFor(saved);
	const page = paperHeightFor(saved);
	if (paper === null || page === null) return false;
	if (ink.x < -PRINT_INK_PAD || ink.y < -PRINT_INK_PAD) return true;
	const widthZoom = Math.min(1, paper / wantedWidth(held, column, ink.right, 0));
	return ink.bottom > foot + page / widthZoom;
}

/**
 * How far the drawn ink reaches left of and above the layer's origin, px at `zoom`: each stroke's points widened by the half
 * width its pen can draw at most. The stored box is padded by twice the stroke's width, four times the highlighter's drawn
 * reach, so a highlight over a line's first word read as ink off the text's pages. Both bound the drawn ink, so each stroke
 * counts the tighter of the two. Only the one-page choice reads this; the layer and its padding keep the stored box.
 */
function inkReachOf(strokes: readonly InkStroke[], zoom: number): { x: number; y: number } {
	let minX = 0, minY = 0;
	for (const s of strokes) {
		const shape = shapeFor(s.tool === "highlighter", s.pressureProfile);
		const half = Math.max(0.5, (s.width * Math.max(shape.minWidthFactor, shape.maxWidthFactor, shape.pressureOffWidthFactor)) / 2);
		let left = Infinity, top = Infinity;
		for (const p of s.points) {
			left = Math.min(left, p.x - half);
			top = Math.min(top, p.y - half);
		}
		minX = Math.min(minX, Math.max(s.bbox.x, left) * zoom);
		minY = Math.min(minY, Math.max(s.bbox.y, top) * zoom);
	}
	return { x: Math.floor(minX), y: Math.floor(minY) };
}

/** The width a fit has to hold: the container's padding, the room left of the text, and the column or the ink past it. */
function wantedWidth(held: PrintFit, column: number, inkRight: number, reachLeft: number): number {
	return held.pad + reachLeft + (reachLeft > 0 ? PRINT_INK_PAD : 0) + Math.max(column, inkRight + PRINT_INK_PAD);
}

/**
 * Print the note the way it looked on screen, shrunk to the paper.
 *
 * Ink is stored against the editor's text column, so it only stays under its
 * words if the text wraps where it wrapped on screen. The print container is
 * as wide as the paper (739 px on Letter with 0.4 in margins against a 700 px
 * column), so every paragraph that re-wrapped pushed the words below it down
 * and away from their ink. The container is therefore laid out at the column
 * width the note surface reports and `zoom`ed down to the paper; wide ink
 * counts toward what has to fit. A paper wider than the layout keeps full
 * size. With no column width to report (no editor shows the note) the
 * container is left as it is. `releasePrintFit` puts both properties back.
 *
 * The paper is the container's width in the PRINT layout. `beforeprint` fires
 * while the page is still laid out for the screen (Chromium 151: 816 px where
 * Letter with 0.4 in margins prints 742), so only a call made with the print
 * media on measures; the earlier one leaves the container alone and the media
 * change that follows does the work.
 *
 * Only a print container with a box is touched, and only at a print; nothing
 * on screen reads or writes this.
 */
function fitPrintColumn(root: HTMLElement, path: string, inkRight: number, reachLeft = 0): PrintFitInfo | null {
	if (!isPrintContainer(root) || !root.offsetParent || !columnWidthFor || !printMedia(root)) return null;
	const column = printColumnFor(path);
	if (column === null || !Number.isFinite(column) || column <= 0) return null;
	let held = printFits.get(root) ?? holdPrintLayout(root, column);
	if (held.paper <= 0) {
		// The screen call already set the column's width, so the paper is read with the container's own width back for
		// this one read, then the column's width returns.
		const ours = root.style.width;
		const oursZoom = root.style.zoom;
		if (held.width) root.style.width = held.width;
		else root.style.removeProperty("width");
		// The paper is the container's width unzoomed: the screen call's zoom comes off for this one read.
		root.style.removeProperty("zoom");
		held.paper = root.offsetWidth;
		root.style.width = ours;
		if (oursZoom) root.style.zoom = oursZoom;
	}
	const wanted = wantedWidth(held, column, inkRight, reachLeft);
	// The screen call's zoom stands: the print counted its pages from the layout at the flip, and a zoom grown or shrunk
	// after that leaves a blank page or clips the right edge. Only a print that had no screen call (the media came first)
	// takes its zoom from the paper it measures here.
	const exact = held.paper > 0 ? Math.min(1, held.paper / wanted) : 1;
	// The computed paper stands only while the measured one is at least as wide (a px of rounding aside); a narrower paper (the
	// settings were stale, or the margin's inches differ) takes the exact zoom, which never clips: a blank page is possible that once.
	const kept = held.screenZoom !== undefined && held.screenPaper !== undefined && held.paper + 1 >= held.screenPaper;
	let zoom = kept ? held.screenZoom! : exact;
	// A one-page fit was sized to the saved page's height. A measured paper that is another page of the dialog's (the settings were
	// stale: landscape printed against portrait saved, Letter against A4) may be a shorter page, and the kept zoom would spill the one
	// page onto a second. The height is not measurable here, so it is the shortest dialog page this wide; the zoom refits to it.
	if (held.screenTall !== undefined && held.screenPage !== undefined && held.paper > 0) {
		const page = shortestPageFor(held.paper, held.screenPaper);
		if (page !== null && page + 1 < held.screenPage) zoom = Math.min(zoom, exact, page / held.screenTall);
	}
	if (zoom < 1) root.style.zoom = `${zoom}`;
	else if (held.zoom) root.style.zoom = held.zoom;
	else root.style.removeProperty("zoom");
	return { column, paper: held.paper, zoom, screenZoom: held.screenZoom, expected: held.screenPaper };
}

/**
 * What Obsidian's export dialog last saved ("pdfExportSettings": pageSize, landscape, margin, downscalePercent), or null.
 * Wired once at plugin load; null with no provider. The shape is unofficial, so every field is checked at use.
 */
let paperSettingsFor: (() => unknown) | null = null;

export function initEmbedInkPrintPaper(provider: (() => unknown) | null): void {
	paperSettingsFor = provider;
}

/** Page sizes the export dialog offers, in inches (portrait width, height). */
const PAGE_INCHES: Record<string, readonly [number, number]> = {
	A3: [11.69, 16.54],
	A4: [8.27, 11.69],
	A5: [5.83, 8.27],
	Legal: [8.5, 14],
	Letter: [8.5, 11],
	Tabloid: [11, 17],
};

/** The dialog's margin codes ("0" default, "2" minimal, "1" none) and a side's inches. */
const MARGIN_INCHES: Record<string, number> = { "0": 0.4, "2": 0.16, "1": 0 };

/** The dialog's saved settings as numbers, or null when the settings are missing or any field is not one the dialog writes. */
function paperSettings(raw: unknown): { size: readonly [number, number]; margin: number; landscape: boolean; scale: number } | null {
	if (typeof raw !== "object" || raw === null) return null;
	const o = raw as Record<string, unknown>;
	const size = typeof o.pageSize === "string" && Object.prototype.hasOwnProperty.call(PAGE_INCHES, o.pageSize) ? PAGE_INCHES[o.pageSize] : undefined;
	const margin = typeof o.margin === "string" && Object.prototype.hasOwnProperty.call(MARGIN_INCHES, o.margin) ? MARGIN_INCHES[o.margin] : undefined;
	const percent = o.downscalePercent;
	if (!size || margin === undefined || typeof o.landscape !== "boolean" || typeof percent !== "number" || !Number.isFinite(percent) || percent <= 0) return null;
	return { size, margin, landscape: o.landscape, scale: Math.min(2, Math.max(0.1, percent / 100)) };
}

/**
 * The page area's width in css px that a print with these settings lays out: the paper's width at 96 px an inch (the height when
 * landscape) less two margins, over the downscale (the dialog's percent as a scale, 0.1 to 2 as Obsidian clamps it). Null when
 * the settings are missing or any field is not one the dialog writes.
 */
export function paperWidthFor(raw: unknown): number | null {
	const o = paperSettings(raw);
	return o ? ((o.landscape ? o.size[1] : o.size[0]) - 2 * o.margin) * 96 / o.scale : null;
}

/** How far a measured paper may sit from a computed one and still be that page: the print layout's own rounding (742 for 739). */
const PAPER_MATCH_PX = 8;

/**
 * The page area's height, px, of the shortest page the export dialog offers whose width is the measured paper's, under the saved
 * settings' margin and scale; null when the measured paper is the saved one (`saved`, its computed width) or no page matches.
 */
function shortestPageFor(measured: number, saved: number | undefined): number | null {
	if (saved !== undefined && Math.abs(measured - saved) <= PAPER_MATCH_PX) return null;
	let raw: unknown = null;
	try {
		raw = paperSettingsFor ? paperSettingsFor() : null;
	} catch {
		return null;
	}
	const o = paperSettings(raw);
	if (!o) return null;
	let best: number | null = null;
	for (const size of Object.values(PAGE_INCHES)) {
		for (const landscape of [false, true]) {
			const w = ((landscape ? size[1] : size[0]) - 2 * o.margin) * 96 / o.scale;
			const h = ((landscape ? size[0] : size[1]) - 2 * o.margin) * 96 / o.scale;
			if (Math.abs(w - measured) <= PAPER_MATCH_PX && (best === null || h < best)) best = h;
		}
	}
	return best;
}

/** The page area's height, from the same settings as `paperWidthFor`: the other side of the paper, less two margins, over the downscale. */
export function paperHeightFor(raw: unknown): number | null {
	const o = paperSettings(raw);
	return o ? ((o.landscape ? o.size[0] : o.size[1]) - 2 * o.margin) * 96 / o.scale : null;
}

/**
 * Phase 1 of the fit, at the screen call: the zoom the text prints at.
 *
 * The print takes its page count from the layout it makes as the media flips, before the print-media call can change
 * anything. A zoom first set in the print-media call shrinks content the pages were counted without, and the count has a
 * blank page at the foot (measured: forcing the zoom to 1 clears all three blanks of the control). The paper is not
 * measurable at the screen call (the window's viewport is the window's, not the paper's), so it is computed from the
 * export dialog's saved settings (`paperWidthFor`) and the zoom is set here with the column width; the print-media
 * call measures the paper and keeps this zoom while the measured paper is at least as wide.
 * Nothing is set when the settings cannot be read: the print-media call then zooms to what it measures, as before.
 * Returns what was decided, for the export line, or null.
 */
function holdScreenZoom(root: HTMLElement, path: string, inkRight: number, canvas?: { reachLeft: number; reachTop: number; foot: number }): PrintFitInfo | null {
	if (!isPrintContainer(root) || !root.offsetParent || !columnWidthFor || printMedia(root)) return null;
	const column = printColumnFor(path);
	if (column === null || !Number.isFinite(column) || column <= 0) return null;
	let saved: unknown = null;
	try {
		saved = paperSettingsFor ? paperSettingsFor() : null;
	} catch {
		// The config is unofficial API: a provider that throws is no settings.
	}
	const paper = paperWidthFor(saved);
	if (paper === null) return null;
	const held = printFits.get(root) ?? holdPrintLayout(root, column);
	const wanted = wantedWidth(held, column, inkRight, canvas?.reachLeft ?? 0);
	let zoom = Math.min(1, paper / wanted);
	held.screenTall = undefined;
	held.screenPage = undefined;
	if (canvas) {
		// A canvas note whose ink left the text's pages is one page: the height decides too. The box runs from the container's top to the lower of the text's foot
		// (padded by the reach above it) and the ink's foot, which the container has just been grown to.
		const page = paperHeightFor(saved);
		const inkFoot = Number.parseFloat(root.style.minHeight ?? "");
		const tall = Math.max(canvas.foot + canvas.reachTop, Number.isFinite(inkFoot) ? inkFoot + PRINT_INK_PAD : 0) + (canvas.reachTop > 0 ? PRINT_INK_PAD : 0);
		if (page !== null && tall > 0) {
			zoom = Math.min(zoom, page / tall);
			held.screenTall = tall;
			held.screenPage = page;
		}
	}
	held.screenZoom = zoom;
	held.screenPaper = paper;
	if (zoom < 1) root.style.zoom = `${zoom}`;
	else if (held.zoom) root.style.zoom = held.zoom;
	else root.style.removeProperty("zoom");
	return { column, paper: 0, zoom, screenZoom: zoom, expected: paper };
}

/** What a fit measured, for the export's line. */
interface PrintFitInfo {
	column: number;
	paper: number;
	zoom: number;
	/** The zoom the screen call set, and the paper's width it computed from the export settings (see `holdScreenZoom`). */
	screenZoom?: number;
	expected?: number;
}

function printMedia(root: HTMLElement): boolean {
	return root.ownerDocument?.defaultView?.matchMedia?.("print")?.matches === true;
}

/** The blocks of the note in a print container: every child that is not the title, not one of our layers, and laid out. */
function printBlocks(root: HTMLElement): HTMLElement[] {
	const title = root.querySelector<HTMLElement>(":scope > h1");
	const out: HTMLElement[] = [];
	const children = root.children as ArrayLike<Element> | undefined;
	if (!children) return out;
	for (let i = 0; i < children.length; i++) {
		const child = children[i] as HTMLElement | undefined;
		if (!child || child === title || isNotColumn(child) || !child.offsetParent) continue;
		out.push(child);
	}
	return out;
}

/** Each block's top relative to the first block, px, measured at the screen call (see `holdPrintSpans`). */
export const printSpans = new WeakMap<HTMLElement, { tops: number[] }>();

/**
 * Phase 1 of a print: where each block of the note sits when the text flows at the column width, before any page.
 *
 * The print-media call comes after the layout has been paged, and a block that moved to the next page reads a top
 * that includes the space left at the foot of the page before it. The ink does not move with that space, so the
 * spans the ink is cut by must come from the flow before paging: this call, made at `beforeprint` (screen media,
 * one tall column), sets the container to the column width (`holdPrintLayout`, which stays until the print ends) and
 * reads every block's offset from the first block. Nothing is zoomed: the paper is not known until the media flips.
 * Returns the block count held, or null when nothing was measured (not a print container, no column width, a print
 * already in media).
 */
function holdPrintSpans(root: HTMLElement, path: string): number | null {
	if (!isPrintContainer(root) || !root.offsetParent || !columnWidthFor || printMedia(root)) return null;
	const column = printColumnFor(path);
	if (column === null || !Number.isFinite(column) || column <= 0) return null;
	if (!printFits.has(root)) holdPrintLayout(root, column);
	releasePrintStrips(root);
	const blocks = printBlocks(root);
	const raw = blocks.map((b) => b.offsetTop);
	const tops = raw.map((top) => top - (raw[0] ?? 0));
	if (tops.length === 0) {
		printSpans.delete(root);
		return 0;
	}
	printSpans.set(root, { tops });
	holdWholeBlocks(root, blocks);
	return tops.length;
}

/**
 * Keep every block's lines together, and make each block the box its strip is placed in.
 *
 * Set at the screen call, not at the print-media call: the print takes its page count from the layout it makes as the
 * media flips, before any later call can change it, so a block pushed to the next page by `break-inside: avoid` set
 * only after that left the pages it needed unprinted (text lost at the foot of the note). Both are inline, held and
 * given back at `releasePrintStrips`; neither changes the screen layout this call runs in.
 */
function holdWholeBlocks(root: HTMLElement, blocks: HTMLElement[]): void {
	const held: PrintStrips = { blocks: [], strips: [] };
	for (const block of blocks) {
		held.blocks.push({ el: block, position: block.style.position, breakInside: block.style.breakInside });
		block.setCssStyles({ position: "relative", breakInside: "avoid" });
	}
	printStrips.set(root, held);
}

/** What strips took over on one container: each block's own position and break-inside, and the strips added. */
interface PrintStrips {
	blocks: Array<{ el: HTMLElement; position: string; breakInside: string }>;
	strips: Element[];
}

const printStrips = new WeakMap<HTMLElement, PrintStrips>();

/** Class of the per-block strips of the print ink layer (position and pointer events come from the stylesheet). */
const STRIP_CLS = "handwriting-embed-ink-strip";

/** Class on the one ink box while strips stand in its place (the stylesheet hides it). */
const STRIPPED_CLS = "is-stripped";

/**
 * One strip: an svg whose viewBox is the span [start, end) of the layer, drawn from the strokes whose vertical extent
 * meets that span, in their own order (a stroke across a break is in both strips, each clipped by its viewBox). Built
 * from the strokes rather than copied from the layer, so a note of many blocks does not carry every path in every strip.
 * The box and the span are px; the strokes and the viewBox are world units, drawn at `zoom` px each as the layer is.
 * Null when no stroke meets the span.
 */
function buildStrip(root: HTMLElement, strokes: readonly InkStroke[], box: { x: number; y: number; w: number; h: number }, start: number, end: number, zoom: number): SVGSVGElement | null {
	const meeting = strokes.filter((s) => s.bbox.y * zoom <= end && (s.bbox.y + s.bbox.height) * zoom >= start);
	if (meeting.length === 0) return null;
	const doc = root.ownerDocument;
	const strip = doc.createElementNS(SVG_NS, "svg");
	strip.setAttribute("class", STRIP_CLS);
	strip.setAttribute("aria-hidden", "true");
	strip.setAttribute("viewBox", `${box.x / zoom} ${start / zoom} ${box.w / zoom} ${(end - start) / zoom}`);
	strip.setAttribute("width", `${box.w}`);
	strip.setAttribute("height", `${end - start}`);
	appendInk(root, strip, meeting);
	return strip;
}

/**
 * Draw strokes into an svg: the highlighter runs in one translucent group under the pen strokes, each pen stroke its
 * own <path>. Chromium prints each path as one PDF fill; folded into runs, a heavily inked note printed as a few fills
 * of a million segments, which a PDF reader took seconds to draw (Untitled 1: 9 s in Obsidian's pdf.js).
 */
function appendInk(root: HTMLElement, svg: SVGSVGElement, strokes: readonly InkStroke[]): void {
	const layers = inkSvgLayers(strokes, PRINT_PAGE_WHITE, { penPerStroke: true });
	if (layers.highlighter.length > 0) {
		const g = root.ownerDocument.createElementNS(SVG_NS, "g");
		g.setAttribute("opacity", String(HIGHLIGHTER_ALPHA));
		for (const run of layers.highlighter) g.appendChild(inkPathEl(root, run));
		svg.appendChild(g);
	}
	for (const run of layers.pen) svg.appendChild(inkPathEl(root, run));
}

/**
 * Phase 2 of a print: cut the ink layer into one strip per block, so a block that moves to the next page takes its
 * ink with it. Called with the print media on, after the layer is anchored.
 *
 * The blocks already hold `position: relative` (the strips are absolute in them) and `break-inside: avoid` (lines
 * move whole with their block), set at the screen call (see `holdWholeBlocks`). A block's span runs from its held top to the
 * next block's held top, the first from the top of the ink and the last to its foot; a block whose span meets no ink
 * gets no strip. The strip is an svg drawn from the strokes that meet the span, whose viewBox starts at the span and
 * whose box is placed at the span's start inside the block, left at the layer's own left. The layer itself is hidden while strips stand.
 * With no spans held (the print media came first), or a different block count, the layer stays as one box.
 * `box` is the layer's in px; `zoom` is the px per world unit it draws at. Returns the strips made.
 */
function buildPrintStrips(root: HTMLElement, svg: SVGSVGElement, box: { x: number; y: number; w: number; h: number }, strokes: readonly InkStroke[], zoom: number): number {
	dropStrips(root);
	const spans = printSpans.get(root);
	if (!spans) return 0;
	const tops = spans.tops;
	const held = printStrips.get(root);
	const blocks = printBlocks(root);
	if (!held || blocks.length === 0 || blocks.length !== tops.length || held.blocks.some((b, i) => b.el !== blocks[i])) return 0;
	const boxLeft = parseFloat(svg.style.left) || 0;
	const foot = box.y + box.h;
	blocks.forEach((block, i) => {
		const start = i === 0 ? box.y : Math.max(tops[i]!, box.y);
		const end = i === blocks.length - 1 ? foot : Math.min(tops[i + 1]!, foot);
		if (end - start <= 0.5) return;
		const strip = buildStrip(root, strokes, box, start, end, zoom);
		if (!strip) return;
		strip.style.left = `${boxLeft - block.offsetLeft}px`;
		strip.style.top = `${start - tops[i]!}px`;
		block.appendChild(strip);
		held.strips.push(strip);
	});
	if (held.strips.length === 0) return 0;
	svg.classList.add(STRIPPED_CLS);
	return held.strips.length;
}

/** Take the strips off and show the layer again, keeping the blocks as held. */
function dropStrips(root: HTMLElement): void {
	const held = printStrips.get(root);
	if (!held) return;
	for (const strip of held.strips) strip.remove();
	held.strips = [];
	root.querySelector<SVGSVGElement>(":scope > svg.handwriting-embed-ink")?.classList.remove(STRIPPED_CLS);
}

/** Take the strips off, give the blocks their own position and break-inside back, show the layer. Returns 0. */
export function releasePrintStrips(root: HTMLElement): number {
	const held = printStrips.get(root);
	if (!held) return 0;
	printStrips.delete(root);
	for (const strip of held.strips) strip.remove();
	for (const b of held.blocks) {
		if (b.position) b.el.style.position = b.position;
		else b.el.style.removeProperty("position");
		if (b.breakInside) b.el.style.breakInside = b.breakInside;
		else b.el.style.removeProperty("break-inside");
	}
	root.querySelector<SVGSVGElement>(":scope > svg.handwriting-embed-ink")?.classList.remove(STRIPPED_CLS);
	return 0;
}

/**
 * The export's one diagnostic line, behind the developer diagnostics setting: which call this was (the screen call
 * that holds the spans, or the print-media call that fits and cuts), whether spans were held, the blocks, the strips
 * made, the zoom, the paper and the column the fit used, and how many print swaps have run. A dash where the call
 * measured nothing. It is the line that tells, from one export on a machine we cannot see, whether the fit measured
 * the paper in the print media change.
 */
function noteExport(root: HTMLElement, path: string, fit: PrintFitInfo | null, held: number | null, strips: number): void {
	if (!diagnose) return;
	const media = printMedia(root);
	const spans = printSpans.get(root);
	const num = (v: number | undefined, digits = 3): string => (v === undefined || !Number.isFinite(v) ? "-" : `${Math.round(v * 10 ** digits) / 10 ** digits}`);
	printNote = [
		`phase=${media ? "print" : "screen"}`,
		`spans=${spans ? "held" : "none"}`,
		`blocks=${spans ? spans.tops.length : held ?? "-"}`,
		`strips=${strips}`,
		`zoom=${num(fit?.zoom)}`,
		`paper=${num(fit?.paper, 1)}`,
		`column=${num(fit?.column, 1)}`,
		...(fit?.screenZoom !== undefined ? [`screen=${num(fit.screenZoom)}`, `expected=${num(fit.expected, 1)}`] : []),
		`swaps=${printSwaps}`,
	].join(" ");
	diagnose("print", path, 0);
}

/**
 * The column a print of `path` lays out at: the column of the view showing the note. The editor's when it is laid out,
 * else the note's own Reading view: Reading view hides the editor, whose column then reads null, and a print with no
 * column keeps the plain layout, the ink at full size and cut at the paper's edge (Alan's 10-23 export). The 10-16 rule
 * shrinks the screen column to the paper, and under Reading view the screen column is the Reading view's.
 */
function printColumnFor(path: string): number | null {
	return (columnWidthFor ? columnWidthFor(path) : null) ?? readingColumnFor(path);
}

/**
 * The text column of a Reading view showing `path`, px: its sizer's content width. Only a view of the note itself
 * counts: a print container (no sizer), an embed of the note in another note and a hover popover are skipped, and a
 * hidden view (width 0, the editor shown) is no answer. Null when no Reading view of the note is laid out.
 */
export function readingColumnFor(path: string): number | null {
	for (const [root, shown] of layers) {
		if (shown !== path || !root.isConnected || isPrintContainer(root)) continue;
		if (root.closest(".markdown-embed, .popover")) continue;
		const sizer = anchorSizer(root);
		if (!sizer) continue;
		const style = sizer.ownerDocument?.defaultView?.getComputedStyle(sizer);
		const pad = style ? (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0) : 0;
		const width = sizer.clientWidth - pad;
		if (Number.isFinite(width) && width > 0) return width;
	}
	return null;
}

/**
 * The text column width a print should lay out at: the editor's column box when it has one, else the first line's width.
 * A column box of 0 (the editor hidden, or not measured yet) is no answer, so it falls through to the line; null when neither has width.
 */
export function printColumnWidth(columnBox: number | null | undefined, lineWidth: number | null | undefined): number | null {
	if (columnBox !== null && columnBox !== undefined && columnBox > 0) return columnBox;
	return lineWidth !== null && lineWidth !== undefined && lineWidth > 0 ? lineWidth : null;
}

/** Give a print container back the inline width and zoom it had before `fitPrintColumn`. */
function releasePrintFit(root: HTMLElement): void {
	const held = printFits.get(root);
	if (!held) return;
	printFits.delete(root);
	if (held.width) root.style.width = held.width;
	else root.style.removeProperty("width");
	if (held.overflow) root.style.overflow = held.overflow;
	else root.style.removeProperty("overflow");
	if (held.zoom) root.style.zoom = held.zoom;
	else root.style.removeProperty("zoom");
	if (held.reachLeft > 0) {
		if (held.paddingLeft) root.style.paddingLeft = held.paddingLeft;
		else root.style.removeProperty("padding-left");
	}
	if (held.reachTop > 0) {
		if (held.paddingTop) root.style.paddingTop = held.paddingTop;
		else root.style.removeProperty("padding-top");
	}
}

/**
 * Grow the print container to the foot of its ink layer, as `paint` grows an
 * embed. The container sizes itself to its text, and the print rules make html
 * and body scroll containers that tall, so ink running below the text was cut
 * off the exported page at the text's bottom edge. The layer's top is the
 * print anchor's top plus the ink's y (`anchorLayer`), so its foot is that
 * plus h. Left alone until the container is laid out: with no box there is no
 * anchor to measure from.
 */
export function growPrintContainer(root: HTMLElement, layer: { style: CSSStyleDeclaration }, h: number): void {
	if (!isPrintContainer(root) || !root.offsetParent) return;
	const minHeight = `${parseFloat(layer.style.top) + h}px`;
	root.setCssStyles({ minHeight });
	root.setAttribute(MIN_HEIGHT_ATTR, minHeight);
}

/** One merged run as an SVG <path>, in the root's own document. */
function inkPathEl(root: HTMLElement, run: InkSvgRun): SVGPathElement {
	const el = root.ownerDocument.createElementNS(SVG_NS, "path");
	el.setAttribute("fill", run.color);
	el.setAttribute("fill-rule", "nonzero");
	el.setAttribute("d", run.d);
	return el;
}
