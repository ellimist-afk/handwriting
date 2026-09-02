import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { isolateHistory, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { Notice, Platform, editorInfoField } from "obsidian";
import { Camera } from "../camera/Camera";
import { CameraState } from "../camera/coordinates";
import {
	releaseTipMode,
	setTipModeListener,
	tipMode,
	tipModeHeld as tipModeHeldNow,
	toggleTipMode,
} from "./TipMode";
import {
	blankLinesAbove,
	boundsOf,
	lineSteps,
	rowsOf,
	snapLine,
	strokeIdsBelow,
	sweptRect,
} from "./InsertSpace";
import { MobileTools } from "./MobileTools";
import {
	clipboardSize,
	copyInk,
	inkClipboardMarker,
	markerIsCurrent,
	markerToken,
	pasteInk,
} from "./InkClipboard";

/** How long after a pinch-driven scroll write repaints stay suppressed. */
const PINCH_SCROLL_QUIET_MS = 120;

/**
 * Canvas backing-store reallocations since load, across every editor.
 *
 * A pinch that reallocates per frame and one that reallocates once look
 * identical from the outside and feel different only sometimes. This makes
 * the difference countable: pinch, read the zoom report, pinch again.
 */
let canvasReallocs = 0;

export function inkCanvasReallocs(): number {
	return canvasReallocs;
}

/**
 * Relative change in the measured scale worth acting on. Below this it is
 * sub-pixel rect noise, and adopting it costs a full repaint per frame.
 */
const SCALE_EPSILON = 1e-3;

const LASSO_CURSOR_CLASS = "handwriting-pen-hover-lasso";
const SPACE_CURSOR_CLASS = "handwriting-pen-hover-space";
const PAN_CURSOR_CLASS = "handwriting-pen-hover-pan";
import {
	DEFAULT_TOOLBAR_CORNER,
	ToolbarCorner,
} from "./ToolbarCorner";
import { getPenToolsMode, markPenSeen, penSeenThisSession, penToolsVisible } from "./PenToolsMode";
import { computeCanvasSize, countPaintedPixels } from "../diag/Raster";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { eraserRect, splitStrokeByCircle, strokesHitByCircle } from "../ink/Eraser";
import { DEFAULT_PEN, HIGHLIGHTER_ALPHA, HIGHLIGHTER_PEN, PenStyle } from "../ink/PenStyle";
import { clampInkSize } from "../ink/InkSize";
import { applyInkColor, colorsFor, getInkColorHex } from "../ink/InkColor";
import { Point2 } from "../ink/Smoothing";
import { BBox, InkStroke, InkTool, newStrokeId } from "../ink/Stroke";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { StrokeMetrics } from "../ink/StrokeMetrics";
import { drawCommitted,
	drawRegion, drawStroke } from "../ink/StrokeRenderer";
import { snipViewport } from "../pdf/PageMap";
import { TailRenderer } from "../ink/TailRenderer";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { PenSample } from "../input/PointerRouter";
import { padBBox, pointInBBox } from "../objects/Selection";
import { SelectionModel } from "../objects/SelectionModel";
import { runDetached } from "../util/Detached";
import {
	InkOp,
	eraseRemovalIndices,
	inkApplied,
	inkEffect,
	inkHistorySupport,
	snapHistoryOps,
} from "./InkHistory";
import {
	InlineSelectionDeleteKeys,
	removeSelectedInlineStrokes,
} from "./InlineSelectionDelete";
import { StrokeFrame } from "./StrokeFrame";
import { Band, BandViewport, bandFor, bandNeedsMove } from "./ScrollBand";
import { EINK_CAPS, adaptiveCaps, buildTail, correctionError } from "../ink/Prediction";
import { presentLagMs, recordPresentAge } from "../ink/LatencyEstimate";
import { predictionEinkOn, predictionEnabled } from "./StrokePrediction";
import {
	clearMetadataVisibility,
	frontmatterPropertyKeys,
	isMetadataMutation,
	updateMetadataVisibility,
} from "./MetadataVisibility";
import { handoffFinishedStroke } from "./StrokeHandoff";
import { InlineInkStore } from "./InlineInkStore";
import { focusClaimedPenEditor } from "./InlineFocus";
import { PEN_HOVER_CLASS, penCursorLayout } from "./PenCursor";
import { normalizeInlinePenPressure } from "./PenPressure";
import { observeStrokeMax, strokeGain } from "../ink/PressureGain";
import { embedInkLayerCount, embedInkPrintSwaps } from "./EmbedInk";
import { notifyInkChanged, onInkChanged } from "./InkEvents";
import { ExtentInputs, FrontierCache, sameExtentInputs } from "./FrontierCache";
import { DamageLedger } from "../ink/DamageLedger";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DWELL_MS, snapStroke } from "../ink/ShapeSnap";

const sessionStartMs = Date.now();
import { anchoredScroll, pinchScale } from "./PinchScale";
import { ERASER_CURSOR_CLASS } from "./PenCursor";
import { DEFAULT_ERASER_RADIUS_PX, clampEraserRadius } from "../ink/EraserSize";
import { backingScale, effectiveScale, fontZoomFactor, noteToVisual, visualToNote } from "./ZoomScale";
import {
	isPenProbeEnabled,
	markMappedTip,
	noteProbeStroke,
	recordProbe,
	setProbeGeometry,
} from "./PenProbe";
import { InlinePenRouter, bandEraserIntent } from "./InlinePenRouter";
import { armMouseInkQuietly, mouseInkEnabled } from "./MouseInk";
import { describeEl, setHitProbeContext } from "./PenHitProbe";
import { Extent, inkFrontier, isScrollableOverflow, ScrollAxisGuard, spacerPosition, surfaceExtents, surfaceOriginInScroller, ZERO_EXTENT, zoomFrontier } from "./SurfaceExtent";
import { ProbeBox, capturePresented, parseHexColor, regionCensus } from "./PresentProbe";
import {
	bboxVisibleInViewport,
	scrollProbeCommit,
	scrollProbeExtent,
	scrollProbePenDown,
	scrollProbeRepaint,
	scrollProbeSchedule,
	scrollProbeScroll,
	scrollProbeWheel,
} from "./ScrollProbe";

/**
 * Ink on the ordinary Obsidian editor.
 *
 * A CM6 ViewPlugin mounts three viewport-sized canvases over the editor
 * (committed / wet / live-head tail, the same layering the approved canvas
 * pipeline uses) and claims only pen input, in capture phase, on the editor's
 * scroller. The editor underneath is untouched: typing, selection, links,
 * touch scrolling and caret placement remain native CodeMirror/Obsidian.
 *
 * Coordinates are NOTE-SURFACE coordinates (the settled OneNote model):
 * origin at the top-left of the Markdown content column, y absolute down the
 * document, zoom 1. Markdown flows however Obsidian wants; ink stays where
 * the pen physically put it; editing Markdown never moves ink. The existing
 * Camera does the mapping with its state pinned to
 *   (overlayLeft − contentLeft, overlayTop − documentTop, zoom 1),
 * so every reused renderer works unmodified.
 *
 * The pen hot path is the frozen pipeline verbatim: synchronous draw inside
 * `pointerrawupdate`, coalesced samples, live raw head + smoothed tail. The
 * only editor-derived values it touches are two numbers cached at pen-down.
 * Scroll/reflow repaints of committed ink are rAF-throttled and never run
 * during a stroke's wet path.
 *
 * Ink is keyed by file path in the session and persisted by InlineInkStore
 * under the note's page id; the eraser, lasso and history live on this
 * surface too. An untouched note stays untouched by construction: nothing is
 * written until the first stroke commits. Ink renders above the text; nothing
 * here bakes that in (a z-order field per stroke group can arrive later
 * without moving a single coordinate).
 */

const SELECTION_COLOR = "#7f9cf5";
/** How far outside the selection box still counts as grabbing it, in px. */
const SELECTION_GRAB_PAD = 8;
/** Minimum spacing between lasso vertices, in screen px. */
const LASSO_MIN_STEP_PX = 2;

type PenMode = "ink" | "erase" | "lasso" | "space" | "pan";

let enabled = true;
/**
 * What the pen TIP draws: pen or highlighter. This is a property of the nib
 * (like its color), not an interaction mode. The eraser end and the side button
 * keep their hardware meanings regardless. Session-scoped; switched by command.
 */
let inlineTool: InkTool = "pen";
/**
 * Low-latency canvas request for the wet layers. OFF, and the name is a lie
 * on this stack: asking for it made everything worse.
 *
 * It was `true` from a v0.1.x A/B judged on feel alone - necessarily, because
 * the frame instrument on this surface never recorded anything until
 * 2026-08-30, so nobody could see what the flag did to frame cadence. With it
 * working, one A/B on the same class of machine (surface pro, intel, mains
 * power, 120Hz):
 *
 *              desynchronized: true      false
 *   frame            13-28ms          8.33ms locked
 *   age@present      25-37ms          7ms
 *   move events      25-40Hz          111-117Hz
 *   raw samples      65-100Hz         237-262Hz
 *   coalescing       2.7:1            1:1
 *
 * It was not merely costing frames, it was throttling INPUT: the pen reported
 * 80Hz because the queue was swallowing samples, and the digitizer is
 * actually 260Hz. That also explains the coalescing that looked like a busy
 * main thread - the thread was idle, the events were held.
 *
 * And it was the flicker. The stroke handoff notes that clearing a
 * desynchronized wet canvas "can reach the compositor while the main thread
 * is still drawing a long committed stroke"; the ordering there mitigates
 * that, and under sustained input the queue outran the mitigation. Turning
 * this off ended the flicker alan had been chasing since the night before.
 *
 * Long strokes were where it showed: at `true`, any stroke past ~200ms
 * degraded while flicks stayed clean. At `false`, a 2988ms stroke carrying
 * 786 samples holds 8.33ms frames.
 */
const INLINE_DESYNCHRONIZED = false;
/** No hover sample for this long means the pen is gone; see armHoverWatchdog. */
const HOVER_GHOST_MS = 1000;
/** Real samples kept for extrapolation; the turn guard averages a window. */
const PRED_HISTORY = 12;


// ---- ink size (v0.13.6) -----------------------------------------------------
//
// Size state lives here (session), pure step/clamp logic in ink/InkSize.ts,
// persistence in the plugin. Applied when a stroke BINDS its style at
// pen-down, so a size change takes effect on the next stroke with zero
// hot-path cost. Existing ink is never rewritten.

const inkSizeMult: Record<InkTool, number> = { pen: 1, highlighter: 1 };

export function getInkSizeMult(tool: InkTool): number {
	return inkSizeMult[tool];
}

export function setInkSizeMult(tool: InkTool, mult: number): void {
	inkSizeMult[tool] = clampInkSize(mult);
}

export function getInlineTool(): InkTool {
	return inlineTool;
}

export function setInlineTool(tool: InkTool): void {
	inlineTool = tool;
	// Picking a nib is how you put every other mode away - not just the
	// eraser. While this cleared one flag of four, "Switch between pen and
	// highlighter" left the tip panning while announcing a nib change.
	releaseTipMode();
}

/**
 * Eraser mode (v0.13.13).
 *
 * The pen normally decides what it is at contact and needs no mode at all:
 * eraser end erases, side button lassos, tip inks. That only works on a pen that
 * HAS an eraser end. Plenty do not, and on those the eraser was unreachable.
 *
 * So: an explicit mode, off by default, that makes the tip erase. Hardware
 * keeps every meaning it had. The eraser end still erases whatever the mode
 * says, and choosing a nib turns the mode off.
 */
/**
 * The tip's mode lives in TipMode.ts (DOM-free, so it can be tested). The
 * exported wrappers below are the names the rest of the plugin already calls.
 */
setTipModeListener(() => {
	for (const p of instances) p.refreshStrip();
	refreshStripSurfaces();
	// §5o: switching the tip to anything but lasso dissolves the selection
	// on every surface, immediately - Alan's device finding 2026-09-02 ("the
	// lasso selector remains" after a tool switch; before, only the NEXT
	// non-lasso pen contact cleared it).
	if (tipMode() !== "lasso") {
		for (const p of instances) p.dissolveSelection();
		for (const fn of tipModeSurfaces) fn();
	}
});

export function getInlineEraserMode(): boolean {
	return tipMode() === "eraser";
}

/** Eraser, lasso and space modes are exclusive: the tip can only be one thing. */
export function setInlineEraserMode(on: boolean): void {
	toggleTipMode("eraser", on);
}

export function getInlineLassoMode(): boolean {
	return tipMode() === "lasso";
}

/**
 * Lasso as a MODE (roadmap: pen GUI): the side button was the only way
 * in, and iPads and mice have no side button. While on, the tip lassos.
 */
export function setInlineLassoMode(on: boolean): void {
	toggleTipMode("lasso", on);
}

export function getInlineSpaceMode(): boolean {
	return tipMode() === "space";
}

/**
 * Insert space as a MODE, same grammar as eraser and lasso: while on, the
 * tip plants a divider and everything below it follows the pen vertically.
 * The side button and the eraser end keep their hardware meanings.
 */
export function setInlineSpaceMode(on: boolean): void {
	toggleTipMode("space", on);
}

/** True while any mode has taken the tip away from the nib. */
export function tipModeHeld(): boolean {
	return tipModeHeldNow();
}

/** Hand the tip back to the active nib, whichever mode was holding it. */
export function releaseTipModes(): void {
	releaseTipMode();
}

export function getInlinePanMode(): boolean {
	return tipMode() === "pan";
}

/**
 * Pan as a MODE, same grammar as lasso and insert space: while on, the tip
 * drags the view instead of inking. Touch already pans by finger, but a pen
 * user working on glass has no way to move the page without putting the pen
 * down - and on a Surface the fingers are usually holding the thing.
 */
export function setInlinePanMode(on: boolean): void {
	toggleTipMode("pan", on);
}

/** Eraser radius in screen px, shared by the hit test and both cursors. */
let inlineEraserRadiusPx: number = DEFAULT_ERASER_RADIUS_PX;

export function getEraserRadiusPx(): number {
	return inlineEraserRadiusPx;
}

export function setEraserRadiusPx(px: number): void {
	inlineEraserRadiusPx = clampEraserRadius(px);
}

/**
 * The eraser slider changes module state live and persists on release;
 * persistence lives with the plugin, which registers here at load.
 */
let persistEraserRadius: ((px: number) => void) | null = null;

export function setPersistEraserRadius(fn: ((px: number) => void) | null): void {
	persistEraserRadius = fn;
}

// Settings-tab flags (1.0.5), device-level like the modes above them.
let toolbarCorner: ToolbarCorner = DEFAULT_TOOLBAR_CORNER;

export function getToolbarCorner(): ToolbarCorner {
	return toolbarCorner;
}

/**
 * Surfaces that carry a strip but are not inline overlays.
 *
 * The fan-outs below walk `instances`, which is the editor overlays and
 * nothing else - so a corner change, or a tip-mode change, reached every open
 * NOTE and no open PDF. The PDF controller has had its own refreshStrip all
 * along; nothing ever called it. A callback rather than a second registry of
 * controllers, because this module is already imported by the PDF surface and
 * importing back would close the loop.
 */
const stripSurfaces = new Set<() => void>();

/**
 * §5o: the same non-editor surfaces also need to know when a tool change
 * should put a selection away, kept in its own set so a surface can register
 * a strip refresh without one, or vice versa.
 */
const tipModeSurfaces = new Set<() => void>();

/** Register an extra strip to refresh with the editors. Returns the undo. */
export function addStripSurface(refresh: () => void, onTipMode?: () => void): () => void {
	stripSurfaces.add(refresh);
	if (onTipMode) tipModeSurfaces.add(onTipMode);
	return () => {
		stripSurfaces.delete(refresh);
		if (onTipMode) tipModeSurfaces.delete(onTipMode);
	};
}

function refreshStripSurfaces(): void {
	for (const refresh of stripSurfaces) refresh();
}

/** Settings changed the corner: every open editor's strip moves at once. */
export function setToolbarCorner(corner: ToolbarCorner): void {
	toolbarCorner = corner;
	for (const p of instances) p.applyToolbarCorner();
	refreshStripSurfaces();
}

let penReticleOn = true;
let eraserWholeStrokes = true;
let shapeSnapOn = true;

export function setShapeSnap(on: boolean): void {
	shapeSnapOn = on;
}

export function setPenReticle(on: boolean): void {
	penReticleOn = on;
}

export function setEraserWholeStrokes(on: boolean): void {
	eraserWholeStrokes = on;
}

export function getEraserWholeStrokes(): boolean {
	return eraserWholeStrokes;
}

/** The strip's chips persist through here on flip (settings stay agreed). */
let persistEraserMode: ((on: boolean) => void) | null = null;

export function setPersistEraserMode(fn: ((on: boolean) => void) | null): void {
	persistEraserMode = fn;
}

/**
 * Put the ink marker on the system clipboard so ctrl+v can recognize it.
 * Best-effort by design: a denied clipboard (no user gesture, locked-down
 * platform) costs the keyboard paste and nothing else - the command and
 * the strip's paste button read module state and still work.
 */
function publishInkMarker(): void {
	const marker = inkClipboardMarker();
	if (marker === null) return;
	try {
		void navigator.clipboard?.writeText(marker).catch(() => {
			/* denied: keyboard paste falls back to the command */
		});
	} catch {
		/* no clipboard api at all */
	}
}

/**
 * A strip swatch was tapped: pick up the nib that wears this color, apply
 * and persist it, say so. One function serving BOTH strips (notes and pdf),
 * because the swatches must not depend on the per-name color commands -
 * those are registered behind an off-by-default setting, and a fresh
 * install had a palette of dead swatches (audit, 2026-08-31).
 */
export function pickStripColor(name: string, hex: string): void {
	const tool = getInlineTool();
	// Choosing a color reaches for the nib that wears it: every mode that
	// holds the tip lets go, the same exits the nib commands make.
	setInlineEraserMode(false);
	setInlineLassoMode(false);
	setInlineSpaceMode(false);
	setInlinePanMode(false);
	applyInkColor(tool, hex);
	// Every strip, not just the tapped one: exiting a mode here must dim
	// its light on every open pane, exactly as the commands do.
	refreshAllStrips();
	new Notice(`Handwriting: ${tool} ${name}`);
}

export function commitEraserRadius(): void {
	persistEraserRadius?.(inlineEraserRadiusPx);
}

/** Same shape for the nib-size sliders: live module state, plugin persists. */
let persistInkSize: ((tool: InkTool, mult: number) => void) | null = null;

export function setPersistInkSize(fn: ((tool: InkTool, mult: number) => void) | null): void {
	persistInkSize = fn;
}

export const inlineInk = new InlineInkStore();
const instances = new Set<InkOverlayPlugin>();
/** Shared across editors so an A/B session accumulates one summary list. */
/** Same area cap as the pdf snip (MAX_OVERLAY_PX there): one budget for
 * every raster this plugin produces. */
const NOTE_SNIP_CAP_PX = 4_000_000;

const metrics = new StrokeMetrics();

export function isInlineInkEnabled(): boolean {
	return enabled;
}

export function setInlineInkEnabled(on: boolean): void {
	enabled = on;
	for (const p of instances) (on ? p.mount() : p.unmount());
}

/** The mounted overlay showing `path`, if any editor has it open. */
export function overlayForPath(path: string): InkOverlayPlugin | null {
	for (const p of instances) {
		if (p.showsPath(path)) return p;
	}
	return null;
}

/** Re-evaluate the pen-tools strip on every open editor (mode command). */
export function refreshPenToolsAll(): void {
	for (const p of instances) p.ensurePenTools();
}

/**
 * Refresh every open editor's strip. The recording dot lives on the strip
 * and recording toggles from the PALETTE, with no pen anywhere near - the
 * pen-driven refreshes fire far too late for it (the dot appeared only
 * after the first stroke and outlived the recording it announced).
 */
export function refreshAllStrips(): void {
	for (const p of instances) p.refreshStrip();
	refreshStripSurfaces();
}

/** Repaint every open editor's committed ink (the shaping toggle uses this). */
export function repaintAllInkOverlays(): void {
	for (const p of instances) p.scheduleRepaint("shaping-toggle");
}

/** Everything the A/B comparison against the canvas view needs, as text. */
export function copyInlineInkMetrics(): string {
	let downs = 0;
	let ups = 0;
	let backstops = 0;
	let silentLifts = 0;
	let palms = 0;
	for (const p of instances) {
		downs += p.routerCounters().downs;
		ups += p.routerCounters().ups;
		backstops += p.routerCounters().backstops;
		silentLifts += p.routerCounters().silentLifts;
		palms += p.routerCounters().palms;
	}
	// Session health: the accumulation suspects for slow-after-hours
	// reports. If draw times in the summaries below stay flat but strokes
	// FEEL late, the lag is upstream of the canvas (input or compositor).
	const cache = inlineInk.cacheStats();
	const lines = [
		`Handwriting ink metrics: ${metrics.summaries.length} stroke(s)`,
		`down/up/backstop/silent: ${downs}/${ups}/${backstops}/${silentLifts}  palms blocked: ${palms}`,
		`session: up ${((Date.now() - sessionStartMs) / 60000).toFixed(0)} min  overlays ${instances.size}  embed layers ${embedInkLayerCount()}  print swaps ${embedInkPrintSwaps()}`,
		`ink cache: ${cache.notes} note(s), ${cache.strokes} strokes, ${cache.points} points`,
		// `desynchronized` is a hint, not a contract - a browser may refuse it
		// without saying so. Report what was GRANTED, so "the tip is on the
		// low-latency path" is something this panel can settle rather than
		// something the code merely asked for.
		[...instances][0]?.latencyReport() ?? "canvas latency: (no overlay mounted)",
		"",
		...metrics.summaries.map((s) => StrokeMetrics.summaryText(s)),
	];
	return lines.join("\n");
}


/**
 * A note's ink was replaced by an external reload: the overlays showing it
 * drop any lasso selection (its stroke ids may no longer exist) and repaint.
 * Path-scoped on purpose - other notes' overlays have nothing to redraw.
 */
export function inkExternallyReloaded(path: string): void {
	for (const p of instances) p.noteExternallyReloaded(path);
}

/** Paths whose editors are quiet enough to adopt an external reload. */
export function inlineReloadCandidates(): string[] {
	const out = new Set<string>();
	for (const p of instances) {
		const path = p.reloadCandidatePath();
		if (path) out.add(path);
	}
	return [...out];
}

/** Zoom diagnostics for every live editor. Run at 100% and at zoom, then diff. */
export function copyInlineZoomReport(): string {
	if (instances.size === 0) return "Handwriting zoom report: no editors mounted";
	const parts = [`Handwriting zoom report: ${instances.size} editor(s)`];
	let n = 0;
	for (const p of instances) parts.push(`\n--- editor ${++n} ---`, p.zoomReport());
	return parts.join("\n");
}

/** The pane with the MOST RECENT commit, never an older pane's stale box. */
function newestCommitInstance(): InkOverlayPlugin | null {
	let best: InkOverlayPlugin | null = null;
	for (const p of instances) {
		if (p.lastCommitAt > (best?.lastCommitAt ?? Number.NEGATIVE_INFINITY)) best = p;
	}
	return best && best.lastCommitAt > Number.NEGATIVE_INFINITY ? best : null;
}

/** Region census at the last committed stroke's screen box (occluder hunt). */
export function copyRegionCensus(): string {
	const p = newestCommitInstance();
	const live = [...instances].map((i) => i.containerEl()).filter((c): c is Element => !!c);
	const r = p?.censusReport(live);
	return r ?? "Handwriting region census: no committed stroke this session. Draw one first.";
}

/** Composited-frame capture vs committed backing at the last stroke's box. */
export async function copyPresentationReport(): Promise<string> {
	const p = newestCommitInstance();
	const r = await p?.presentationReport();
	return r ?? "Handwriting presentation capture: no committed stroke this session. Draw one first.";
}

/**
 * "Delete all ink" (command entry): remove every committed stroke on the note
 * at `path` in whichever live editor shows it, as ONE editor-history entry,
 * so a single Ctrl+Z restores all of them with z-order intact, exactly like
 * undoing one big erase. Returns the stroke count removed, 0 when the note
 * had none, or null when no mounted editor is showing that note (the wipe
 * needs an editor's history to be undoable, so there is no store-only path).
 */
export function deleteAllInkOn(path: string): number | null {
	for (const p of instances) {
		const n = p.clearAllInk(path);
		if (n !== null) return n;
	}
	return null;
}

/** Surface-extent diagnostics: spacer, granted extent, scroll reach. */
export function copyInlineSurfaceReport(): string {
	if (instances.size === 0) return "Handwriting surface report: no editors mounted";
	const parts = [`Handwriting surface report: ${instances.size} editor(s)`];
	let n = 0;
	for (const p of instances) parts.push(`\n--- editor ${++n} ---`, p.surfaceReport());
	return parts.join("\n");
}

export class InkOverlayPlugin {
	private view: EditorView;
	private container: HTMLElement | null = null;
	private committedCanvas!: HTMLCanvasElement;
	private wetCanvas!: HTMLCanvasElement;
	private tailCanvas!: HTMLCanvasElement;
	private highlightCanvas!: HTMLCanvasElement;
	private highlightWetCanvas!: HTMLCanvasElement;
	private committedCtx!: CanvasRenderingContext2D;
	private highlightCtx!: CanvasRenderingContext2D;
	private wet!: WetInkRenderer;
	private highlightWet!: WetInkRenderer;
	private tail!: TailRenderer;
	private router: InlinePenRouter | null = null;
	private camera = new Camera();
	private penStyle: PenStyle = { ...DEFAULT_PEN };
	private highlighterStyle: PenStyle = { ...HIGHLIGHTER_PEN };
	/** Bound once at pen-down so the raw ink loop stays branch-free. */
	private activeWet!: WetInkRenderer;
	private activeStyle: PenStyle = this.penStyle;
	private builder: StrokeBuilder | null = null;
	// Adaptive pressure gain, frozen at pen-down for the whole stroke so a
	// mid-stroke ratchet of the learned device max cannot kink the width.
	private strokeGain = 1;
	private strokeRawMax = 0;
	private strokePenGesture = false;
	// Raw-layer dwell tracking: the last time the pen actually MOVED. The
	// builder filters stationary samples out of the stroke, so the hold
	// that requests a shape snap is only visible here.
	private rawLastMoveT = 0;
	private rawLastMoveX = 0;
	private rawLastMoveY = 0;

	// gesture state (one pen contact at a time; mode decided at pen-down)
	private mode: PenMode = "ink";
	private erased: Array<{ stroke: InkStroke; index: number }> = [];
	/**
	 * Ids minted by this erase gesture. A piece cut a moment ago is not an
	 * original: undo restores what the note held when the gesture began, so a
	 * second pass over a survivor must not record it as something lost.
	 */
	private erasePieces = new Set<string>();
	/** The stroke list as the erase gesture found it. See the erase pen-down. */
	private eraseFrom: InkStroke[] = [];
	private eraseWhole = false;
	// Damage-repaint state (renderer debt): the committed canvases are their
	// own cache. The ledger says what changed; the index answers per-rect
	// stroke queries; lastPaintCam turns camera motion into a blit.
	private damage = new DamageLedger();
	private strokeIndex = new StrokeIndex();
	private indexDirty = true;
	private lastPaintCam: { x: number; y: number; zoom: number } | null = null;
	private selection = new SelectionModel();
	private readonly selectionDeleteKeys = new InlineSelectionDeleteKeys(
		() => !this.selection.isEmpty,
		() => this.deleteSelectedInk()
	);
	private lassoPts: Point2[] = [];
	private lassoActive = false;
	private dragFrom: { x: number; y: number } | null = null;
	private dragTotal: { dx: number; dy: number } | null = null;
	/** Insert-space gesture: divider world y, or null when no gesture. */
	private spaceLineY: number | null = null;
	/** Ids frozen at pen-down; the live drag and the op both use this list. */
	private spaceIds: string[] = [];
	/** Box around those ids, tracked through the drag so damage stays bounded. */
	private spaceBounds: BBox | null = null;
	/** Viewport point of the contact, for locating the text line to open. */
	private spaceClient: { x: number; y: number } | null = null;
	/** Last viewport point of a pan drag; client space, so scrolling cannot
	 * feed back into the delta the way surface coordinates would. */
	private panLast: { x: number; y: number } | null = null;
	private spaceFromY = 0;
	private spaceTotalDy = 0;
	private penCursorEl: HTMLElement | null = null;
	private mobileTools: MobileTools | null = null;
	private eraserEl: HTMLElement | null = null;

	private cssWidth = 0;
	private cssHeight = 0;
	private dpr = 1;
	private resizeObserver: ResizeObserver | null = null;
	private repaintQueued = false;
	private presentProbePending = false;
	private scrollFn: (() => void) | null = null;
	private wheelFn: ((e: WheelEvent) => void) | null = null;
	private hostPositionPatched = false;
	/** The element chromeHost() made positioned, so teardown can undo it. */
	private chromeHostPatched: HTMLElement | null = null;

	// ---- surface extent (reconstructed from the 2026-08-20 hardware build) --
	/** 1×1 invisible child of the scroller that extends its scroll range. */
	private spacer: HTMLElement | null = null;
	private spacerLeft = Number.NaN;
	private spacerTop = Number.NaN;
	private axisGuard = new ScrollAxisGuard();
	/** The ink frontier per note, so a scroll repaint stops re-walking it. §5g/G1. */
	private frontierCache = new FrontierCache();
	/** Unsubscribes the frontier cache from ink-changed events. */
	private offInkChanged: (() => void) | null = null;
	/** What updateExtent last acted on; equal inputs mean equal output. */
	private lastExtentInputs: ExtentInputs | null = null;
	/** The `.markdown-source-view` ancestor carrying the `handwriting-page` class. */
	private pageClassHost: HTMLElement | null = null;
	/** Keeps the page-id-only Properties block class in step with Obsidian's DOM. */
	private metadataObserver: MutationObserver | null = null;
	/** The one frame that observer owes, or null when it owes none. §5g/G2. */
	private metadataFrame: number | null = null;
	/** Base font size captured when a pinch began; null when no pinch is live. */
	/** Live magnification of this editor. Session-local; never persisted. */
	private pinchScaleNow = 1;
	/** The scale this gesture started from, so a pinch never accumulates. */
	private pinchRefScale: number | null = null;
	/** The pinch this frame owes, coalesced from however many moves arrived. */
	private pinchPending: { next: number } | null = null;
	/** When the pinch last wrote the scroll itself; see the scroll handler. */
	private pinchScrollAt = 0;
	/** Hides a reticle left behind by a pen that never sent pointerleave. */
	private hoverWatchdog: ReturnType<Window["setTimeout"]> | null = null;
	/** Whether the metrics frame ticker is running; see startFrameTicker. */
	private frameTicking = false;
	/** Recent REAL samples, newest last: what prediction extrapolates from. */
	private predReal: PenSample[] = [];
	/** The tail drawn last event, kept only to score it against what arrived. */
	private predLastTail: readonly PenSample[] = [];
	/** Gesture-start state the whole pinch is computed from; see anchoredScroll. */
	private pinchAnchor: {
		scrollLeft: number;
		scrollTop: number;
		offsetX: number;
		offsetY: number;
	} | null = null;
	private pinchRaf = 0;
	/** The scale the ink raster currently reflects, so a settle that would
	 * change nothing does not reallocate every canvas. */
	private pinchRasterScale = 1;
	/** Inner canvas layer the scroll-follow translate is applied to. */
	/**
	 * Scroll-follow state: the baseline the current translate is measured
	 * from, and whether one is applied. Lives in its own object so the whole
	 * cycle (scroll, scroll, repaint, scroll) is unit-testable; this file
	 * cannot be instantiated without a live CodeMirror view.
	 */
	/** The ink band's box in scroller-content coordinates; see ScrollBand. */
	private band: Band | null = null;
	// Font-zoom tracking (quick font size / touchpad pinch; see ZoomScale).
	/** Live computed style of the content element; .fontSize is a cheap read. */
	private contentStyle: CSSStyleDeclaration | null = null;
	/** Editor font size at overlay mount, the fontZoom reference. */
	private refFontPx = 0;
	private lastFontStr = "";
	/** CSS-transform scale alone (visual px per layout px), fontZoom excluded. */
	private cssScale = 1;
	private fontZoom = 1;
	/** overflow-x re-checked once per resize/mount, not per repaint. */
	private axisChecked = false;
	private scrollPositionPatched = false;
	private lastReach: {
		required: number;
		scrollWidth: number;
		clientWidth: number;
		overflowX: string;
		patched: boolean;
	} | null = null;

	// Geometry stash: what syncCamera actually read this frame, kept for the
	// scroll probe so instrumentation never adds layout reads of its own.
	private lastSyncRectLeft = 0;
	private lastSyncRectTop = 0;
	private lastSyncContentLeft = 0;
	private lastSyncDocumentTop = 0;
	private lastSyncScrollLeft = 0;
	private lastSyncScrollTop = 0;
	/** Scroll events observed while the current stroke was active. */
	private scrollsDuringStroke = 0;

	/**
	 * Presentation-probe target: the last committed stroke, anchored in NOTE
	 * space (never screen space: scrolling moves the ink's canvas position,
	 * so a screen-space target goes stale the moment anything repaints).
	 * Probes recompute the canvas/client box under the CURRENT camera and
	 * hard-gate on the committed backing actually containing pixels there.
	 */
	private lastCommitNote: { x: number; y: number; w: number; h: number } | null = null;
	private lastCommitPath: string | null = null;
	private lastCommitId = "";
	private lastCommitColor = "";
	lastCommitAt = Number.NEGATIVE_INFINITY;

	// LIVEPAINT sampler state (right-edge dead-zone diagnosis): during an
	// active ink stroke, every ~30 ms a small box around the newest SETTLED
	// wet segment is read back from the wet canvas. Zero paint while the
	// user is drawing = the rasterization never reached the backing store;
	// paint present while the glass is blank = presentation/compositor.
	/** The file this editor was last showing. Ink isolation depends on it. */
	private lastPath: string | null = null;
	/**
	 * Visual px per layout px for this editor (1 unless something applies a
	 * CSS zoom/transform). Every conversion between screen geometry and note
	 * space goes through it; see ZoomScale.ts.
	 */
	private scale = 1;
	private mediaQuery: MediaQueryList | null = null;
	private mediaFn: (() => void) | null = null;
	/**
	 * True from pen-down to pen-up. While set, syncCamera() is a no-op so the
	 * stroke's coordinate frame cannot move underneath it.
	 *
	 * Without this, any repaint that lands mid-stroke (a ResizeObserver tick,
	 * a CodeMirror geometry update, the resolution watcher) re-reads
	 * documentTop/contentLeft and rewrites the camera. Ink already drawn used
	 * the old origin and everything after it uses the new one, so the live
	 * stroke kinks by exactly the origin delta, a spatial discontinuity in
	 * the middle of a handwritten line.
	 */
	private readonly frame = new StrokeFrame();

	constructor(view: EditorView) {
		this.view = view;
		instances.add(this);
		if (enabled) this.mount();
	}

	// ---- lifecycle ----------------------------------------------------------

	/** Whether this mounted overlay is showing `path` right now. */
	showsPath(path: string): boolean {
		return this.container !== null && this.filePath() === path;
	}

	/** The file behind this editor, resolved live, because Obsidian reuses editors. */
	private filePath(): string | null {
		const info = this.view.state.field(editorInfoField, false);
		return info?.file?.path ?? null;
	}

	/**
	 * The window this editor actually lives in. A popout editor's frames,
	 * devicePixelRatio, and media queries belong to ITS window; the main
	 * window's values are wrong there (mixed-DPI monitors, page zoom).
	 */
	private get winRef(): Window {
		return this.view.dom.ownerDocument.defaultView ?? window;
	}

	mount(): void {
		if (this.container || !enabled) return;
		// Not a file-backed markdown editor (e.g. a bare CM instance): stay inert.
		if (this.view.state.field(editorInfoField, false) === undefined) return;

		const host = this.view.dom;
		if (this.winRef.getComputedStyle(host).position === "static") {
			host.setCssStyles({ position: "relative" });
			this.hostPositionPatched = true;
		}
		// The lost 2026-08-20 build carried this class (reconstruction gap,
		// found via the census counter reading 0). No stylesheet references
		// it. Restoring it is render-inert and gives diagnostics a selector.
		//
		// The overlay lives INSIDE the scroller, positioned in content
		// coordinates, so the compositor scrolls ink and text together and no
		// main-thread lateness can separate them. See ScrollBand for why the
		// viewport-anchored version could not be made to keep up.
		const scroller = this.view.scrollDOM;
		if (this.winRef.getComputedStyle(scroller).position === "static") {
			scroller.setCssStyles({ position: "relative" });
			this.scrollPositionPatched = true;
		}
		const container = scroller.createDiv({ cls: "handwriting-ink-overlay" });
		this.container = container;
		// Zero until syncBand writes the first box: an absolutely positioned
		// child extends scrollable overflow, and a full-height band placed
		// before the clamp is applied would inflate the scrollHeight that the
		// clamp then reads.
		container.setCssStyles({
			position: "absolute",
			left: "0",
			top: "0",
			width: "0",
			height: "0",
			overflow: "hidden",
			pointerEvents: "none",
			// As a child of `.cm-editor` this sat above the whole editor by
			// DOM order alone. Inside the scroller it is a sibling of the
			// content, and CodeMirror gives `.cm-gutters` z-index 200 - so
			// without this, ink drawn left of the text column would vanish
			// behind the fold gutter. Ink paints above the Markdown; that
			// rule is older than where this element happens to live.
			zIndex: "250",
		});

		// The canvases sit in an inner layer that fills the band. Between
		// v0.13.5 and the ScrollBand change the layer was the thing scroll
		// events translated, chasing the text from the main thread. It does
		// not move any anymore - the band it lives in is scrolled by the
		// compositor along with the text - so `will-change: transform` was
		// left behind pointing at a transform that no longer exists.
		//
		// Dropped, on the theory that folding five canvases into one promoted
		// layer is what keeps the wet canvas off the low-latency path it was
		// granted: ink is on the canvas ~1.5ms after the pen moves and ~30ms
		// before it is on screen, and that whole gap is compositing.
		//
		// If it costs scrolling smoothness, put it back - that is the trade
		// being tested, and the two are measured by different numbers
		// (age@present in the ink metrics against how the scroll feels).
		const layer = container.createDiv({ cls: "handwriting-ink-layer" });
		layer.setCssStyles({
			position: "absolute",
			inset: "0",
			pointerEvents: "none",
		});

		const canvas = (): HTMLCanvasElement => {
			const c = layer.createEl("canvas");
			c.setCssStyles({
				position: "absolute",
				inset: "0",
				pointerEvents: "none",
			});
			return c;
		};
		// Highlighter layers first: on the inline surface all ink paints above
		// the Markdown (the editor owns the DOM under it), so the stacking that
		// matters is highlight-under-PEN: a highlight never dims ink lines.
		// The v0.6.0 rule is unchanged where it counts: strokes are painted
		// OPAQUE and the whole layer carries one alpha, so a highlight crossing
		// itself stays a single flat wash instead of double-blending into seams.
		this.highlightCanvas = canvas();
		this.highlightWetCanvas = canvas();
		this.highlightCanvas.setCssStyles({ opacity: String(HIGHLIGHTER_ALPHA) });
		this.highlightWetCanvas.setCssStyles({ opacity: String(HIGHLIGHTER_ALPHA) });
		this.committedCanvas = canvas();
		this.wetCanvas = canvas();
		this.tailCanvas = canvas();

		const ctx = this.committedCanvas.getContext("2d");
		const hctx = this.highlightCanvas.getContext("2d");
		if (!ctx || !hctx) {
			this.unmount();
			return;
		}
		this.committedCtx = ctx;
		this.highlightCtx = hctx;
		// Frozen pipeline: synchronized canvas (desynchronized: false), smoothed tail.
		this.wet = new WetInkRenderer(this.wetCanvas, INLINE_DESYNCHRONIZED);
		this.wet.smooth = true;
		this.wet.shape = true; // pen ink takes the shaped width law (InkShape)
		this.highlightWet = new WetInkRenderer(this.highlightWetCanvas, INLINE_DESYNCHRONIZED);
		this.highlightWet.smooth = true;
		this.activeWet = this.wet;
		// NOT desynchronized, and that is a hardware finding rather than an
		// oversight. The reasoning for giving the tip layer the low-latency
		// path is sound - it carries the stub that reaches the nib, while the
		// wet layer below it is by construction already behind the pen - and
		// it was tried on 2026-08-28. It produced SECONDS of lag: a second
		// desynchronized canvas in this stack does not present faster, it
		// queues, and at pen sample rates the queue never drains.
		//
		// The wet layer keeps the flag because it demonstrably works there.
		// One low-latency surface in the stack is apparently the budget.
		this.tail = new TailRenderer(this.tailCanvas);

		this.penCursorEl = container.createDiv({ cls: "handwriting-pen-cursor" });
		this.penCursorEl.setAttribute("aria-hidden", "true");
		this.eraserEl = container.createDiv({ cls: "handwriting-eraser-cursor" });
		this.eraserEl.setAttribute("aria-hidden", "true");

		// Pen tools strip: on mobile the palette hides with the keyboard, so
		// the strip is the only path; on desktop it appears once a pen is
		// actually seen (PenToolsMode owns the rule). Mount-time check plus
		// re-checks from pen events, so a Surface picking up its pen mid-
		// session gets the strip without a remount.
		//
		// BULKHEADED (1.0.1): this call sits before the router is created,
		// so a throw here would kill the pen entirely while text kept
		// working - the exact iPad symptom reported on release day. Chrome
		// must never take the ink down with it.
		try {
			this.ensurePenTools();
		} catch (err) {
			console.error("[handwriting] pen tools strip failed to mount", err);
		}

		this.router = new InlinePenRouter(
			this.view.scrollDOM,
			container,
			{
				onPenDown: (s, ev) => this.penDown(s, ev),
				onPenHover: (s) => this.showPenCursor(s),
				onPenLeave: () => this.hidePenCursor(),
				onPinch: (phase, ratio, centroid) => this.pinch(phase, ratio, centroid),
				onPenRaw: (samples, ev) => this.penRaw(samples, ev),
				onPenMove: (_ev, count) => metrics.recordEvent("move", count, 0, false),
				onPenUp: () => this.penUp(),
			claimBandContact: (ev) =>
				bandEraserIntent(
					ev.pointerType,
					ev.buttons,
					ev.button,
					tipMode() === "eraser",
					mouseInkEnabled()
				),
			},
			() => this.cssScale
		);

		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(host);
		this.handleResize();

		// Hit-probe context: what note-space point and granted extent this
		// overlay would assign to a client coordinate right now.
		setHitProbeContext((clientX, clientY) => {
			if (!this.container) return null;
			const rect = this.container.getBoundingClientRect();
			const w = this.camera.screenToWorld(
				visualToNote(clientX - rect.left, this.cssScale),
				visualToNote(clientY - rect.top, this.cssScale)
			);
			const path = this.filePath();
			const granted = path ? surfaceExtents.get(path) : ZERO_EXTENT;
			return {
				noteX: w.x,
				noteY: w.y,
				scrollLeft: this.view.scrollDOM.scrollLeft,
				scrollTop: this.view.scrollDOM.scrollTop,
				grantedX: granted.x,
				grantedY: granted.y,
				scale: this.scale,
			};
		});

		this.scrollFn = () => {
			const during = this.router?.isStroking ?? false;
			if (during) this.scrollsDuringStroke++;
			// Nothing here moves the ink any more. The layer is a child of
			// the scroller in content coordinates, so this scroll has already
			// moved it, on the compositor, together with the text. All that
			// is left is to notice when the viewport has eaten far enough
			// into the band's margin to need a wider one drawn - which
			// repaint() decides, through syncBand.
			const scroller = this.view.scrollDOM;
			const scrollLeft = scroller.scrollLeft;
			const scrollTop = scroller.scrollTop;
			// The overlay is inside the scroller now, so its client rect moves
			// with every scroll - and the router caches that rect to map
			// pointer coordinates. It used to be safe to cache across scrolls
			// because the overlay did not move; it is not any more. Stale by a
			// scroll delta shows up as the hover reticle sitting away from the
			// pen tip, and as lasso and insert-space landing where the ink was
			// a moment ago.
			//
			// A stroke in flight keeps the rect it froze at pen-down. That is
			// the same coordinate frame the camera froze with, and refreshing
			// one without the other is exactly the forward/inverse mismatch
			// the frozen pipeline exists to prevent.
			if (!during) this.router?.refreshRect();
			if (diagnosticsEnabled()) {
				scrollProbeScroll(scrollLeft, scrollTop, during);
			}
			// A live pinch writes the scroll itself, every frame, and any
			// camera motion makes repaint() re-raster every visible stroke.
			// Zooming OUT grows the visible set, so the gesture stuttered in
			// exactly one direction. Mid-pinch the repaint buys nothing: the
			// canvases sit inside the transformed host, so the raster the
			// note already has scales with it, and the settle re-rasters
			// crisply once.
			//
			// A TIME WINDOW, not a flag. The first cut was a boolean cleared
			// on pinch-end, and a pinch that never delivered its end left it
			// stuck - suppressing every repaint for the rest of the session,
			// so the camera went stale and the reticle drew far from the pen
			// (alan, 1.3.1, hardware). This cannot wedge: it expires on its
			// own a few frames after the last pinch-driven scroll, whatever
			// happens to the gesture.
			if (performance.now() - this.pinchScrollAt < PINCH_SCROLL_QUIET_MS) return;
			this.scheduleRepaint("scroll");
		};
		this.view.scrollDOM.addEventListener("scroll", this.scrollFn, { passive: true });
		// Log-only wheel tap on the ACTUAL trigger path of the touchpad dead
		// zone: two-finger precision-touchpad scrolling arrives here, not as
		// touch pointers. Passive + capture: sees everything, changes nothing.
		// Wholly diagnostic, so the whole body is behind the switch (RC4).
		this.wheelFn = (e: WheelEvent) => {
			if (!diagnosticsEnabled()) return;
			scrollProbeWheel(
				e,
				this.view.scrollDOM.scrollLeft,
				this.view.scrollDOM.scrollTop,
				this.router?.isStroking ?? false
			);
		};
		this.view.scrollDOM.addEventListener("wheel", this.wheelFn, {
			capture: true,
			passive: true,
		});
		this.watchResolution();
		// Every committed mutation that reaches an event drops the cached
		// frontier for that note; the two that do not (erase, lasso move)
		// invalidate by hand at their gesture end. §5g/G1.
		this.offInkChanged = onInkChanged((p) => this.frontierCache.invalidate(p));
		this.lastPath = this.filePath();
		this.updateHandwritingPageClass();
		this.loadInk(this.lastPath);
	}

	/**
	 * Obsidian's Ctrl+/Ctrl- is Electron page zoom, which changes
	 * devicePixelRatio without necessarily changing anything's CSS-px size,
	 * so neither the ResizeObserver nor a CodeMirror geometry update is
	 * guaranteed to fire. This listener is: a resolution media query flips
	 * exactly when the zoom factor does. Re-arms itself for the new dpr.
	 */
	private watchResolution(): void {
		this.unwatchResolution();
		const dpr = this.winRef.devicePixelRatio || 1;
		const mq = this.winRef.matchMedia(`(resolution: ${dpr}dppx)`);
		const fn = () => {
			this.handleResize();
			this.watchResolution();
		};
		this.mediaQuery = mq;
		this.mediaFn = fn;
		mq.addEventListener("change", fn);
	}

	private unwatchResolution(): void {
		if (this.mediaQuery && this.mediaFn) {
			this.mediaQuery.removeEventListener("change", this.mediaFn);
		}
		this.mediaQuery = null;
		this.mediaFn = null;
	}

	/** Persisted ink arrives lazily; an untouched note costs one cache lookup. */
	private loadInk(path: string | null): void {
		if (!path) return;
		runDetached(
			inlineInk.ensureLoaded(path).then((changed) => {
				if (this.filePath() === path) {
					this.updateHandwritingPageClass();
					if (changed) this.scheduleRepaint();
				}
			}),
			`load inline ink for ${path}`
		);
	}

	/**
	 * Presentation only: mark the editor chrome of a note that IS a Handwriting
	 * page (`handwriting-page` on the markdown view, for scoped CSS hooks like the
	 * backlinks divider), and mark the scroller once Handwriting has actually made
	 * it horizontally scrollable (`handwriting-hscroll`, for the visible horizontal
	 * scrollbar). Reads session state and cheap metadata; never mutates the
	 * note.
	 */
	private updateHandwritingPageClass(): void {
		if (!this.pageClassHost) {
			this.pageClassHost =
				this.view.dom.closest(".markdown-source-view") ?? this.view.dom;
			if (typeof MutationObserver !== "undefined") {
				this.metadataObserver = new MutationObserver((records) => {
					// This root is the whole editor, and CodeMirror recycles
					// line DOM, so most batches arriving here cannot have
					// changed a Properties block: gate first, then coalesce
					// the survivors into ONE frame's work. §5g/G2.
					if (!records.some(isMetadataMutation)) return;
					if (this.metadataFrame !== null) return;
					this.metadataFrame = this.winRef.requestAnimationFrame(() => {
						this.metadataFrame = null;
						if (this.pageClassHost)
							updateMetadataVisibility(this.pageClassHost, this.headFrontmatterKeys);
					});
				});
				this.metadataObserver.observe(this.pageClassHost, {
					childList: true,
					subtree: true,
					attributes: true,
					attributeFilter: ["data-property-key"],
				});
			}
		}
		const path = this.filePath();
		this.pageClassHost.classList.toggle(
			"handwriting-page",
			!!path && inlineInk.isHandwritingPage(path)
		);
		updateMetadataVisibility(this.pageClassHost, this.headFrontmatterKeys);
	}

	// Property so a detached observer callback cannot arrive with a stray
	// `this`. 4000 chars is far past any id-only frontmatter; a block the
	// slice truncates parses as null, and null never hides anything.
	private headFrontmatterKeys = (): readonly string[] | null =>
		frontmatterPropertyKeys(this.view.state.sliceDoc(0, 4000));

	/**
	 * Create or destroy the strip to match the visibility rule. Called at
	 * mount, from pen sightings, and by the mode command via
	 * refreshPenToolsAll. Cheap when nothing changes.
	 */
	ensurePenTools(): void {
		try {
			this.ensurePenToolsInner();
		} catch (err) {
			console.error("[handwriting] pen tools strip failed", err);
		}
	}

	private ensurePenToolsInner(): void {
		const want =
			this.container !== null &&
			penToolsVisible(getPenToolsMode(), Platform.isMobileApp, penSeenThisSession());
		if (want === (this.mobileTools !== null)) return;
		if (!want) {
			this.mobileTools?.destroy();
			this.mobileTools = null;
			return;
		}
		const info = this.view.state.field(editorInfoField, false);
		const app = info?.app as
			| { commands?: { executeCommandById(id: string): void } }
			| undefined;
		if (!app?.commands) return;
		const commands = app.commands;
		this.mobileTools = new MobileTools(this.chromeHost(), {
			exec: (id) => {
				{
					// "editor:undo" and "editor:redo" are NOT Obsidian
					// commands - undo/redo are native keybindings - so
					// executeCommandById returned false and did nothing,
					// silently, on every build that ever shipped. Nobody
					// noticed because everyone presses Ctrl+Z; the tracker's
					// first real issue was the first person who tapped the
					// button before the keys (issue #1, fixed on the release
					// line as 7b5aa20, ported here). Dispatched straight into
					// this view's own history, which also makes the button
					// definitionally equal to Ctrl+Z.
					if (id === "editor:undo") undo(this.view);
					else if (id === "editor:redo") redo(this.view);
					else commands.executeCommandById(id);
				}
			},
			activeTool: () => getInlineTool(),
			eraserOn: () => getInlineEraserMode(),
			eraserWholeStroke: () => getEraserWholeStrokes(),
			setEraserWholeStroke: (on) => {
				setEraserWholeStrokes(on);
				persistEraserMode?.(on);
			},
			lassoOn: () => getInlineLassoMode(),
			spaceOn: () => getInlineSpaceMode(),
			panOn: () => getInlinePanMode(),
			activeColor: () => getInkColorHex(getInlineTool()),
			eraserRadiusPx: () => getEraserRadiusPx(),
			setEraserRadiusPx: (px, commit) => {
				setEraserRadiusPx(px);
				if (commit) commitEraserRadius();
			},
			canUndo: () => undoDepth(this.view.state) > 0,
			canRedo: () => redoDepth(this.view.state) > 0,
			canPasteInk: () => clipboardSize() > 0,
			recordingOn: () => diagnosticsEnabled(),
			hasInkSelection: () => !this.selection.isEmpty,
			mouseInkOn: () => mouseInkEnabled(),
			setMouseInk: (on) => {
				// Through the command, so the setting persists and the Notice
				// says what the mouse now holds.
				if (mouseInkEnabled() !== on) commands.executeCommandById("handwriting:mouse-ink-toggle");
			},
			armMouseInkQuietly: () => armMouseInkQuietly(),
			palette: () => colorsFor(getInlineTool()),
			pickColor: (name, hex) => pickStripColor(name, hex),
			inkSizeMult: (tool) => getInkSizeMult(tool as InkTool),
			setInkSizeMult: (tool, mult, commit) => {
				setInkSizeMult(tool as InkTool, mult);
				if (commit) persistInkSize?.(tool as InkTool, getInkSizeMult(tool as InkTool));
			},
		});
		// A strip born mid-session starts in the configured corner, not the
		// default one: ensurePenTools creates it on the first pen contact,
		// long after settings were read.
		this.applyToolbarCorner();
	}

	unmount(): void {
		this.router?.dispose();
		this.router = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		if (this.scrollFn) {
			this.view.scrollDOM.removeEventListener("scroll", this.scrollFn);
			this.scrollFn = null;
		}
		if (this.wheelFn) {
			this.view.scrollDOM.removeEventListener("wheel", this.wheelFn, { capture: true });
			this.wheelFn = null;
		}
		this.unwatchResolution();
		this.offInkChanged?.();
		this.offInkChanged = null;
		this.lastExtentInputs = null;
		setHitProbeContext(null);
		this.spacer?.remove();
		this.spacer = null;
		this.spacerLeft = Number.NaN;
		this.spacerTop = Number.NaN;
		this.view.scrollDOM.classList.remove("handwriting-hscroll");
		this.metadataObserver?.disconnect();
		this.metadataObserver = null;
		if (this.metadataFrame !== null) {
			this.winRef.cancelAnimationFrame(this.metadataFrame);
			this.metadataFrame = null;
		}
		if (this.pageClassHost) clearMetadataVisibility(this.pageClassHost);
		this.pageClassHost?.classList.remove("handwriting-page");
		this.pageClassHost = null;
		this.restoreScrollableAxis();
		this.axisChecked = false;
		this.lastReach = null;
		if (this.scrollPositionPatched) {
			this.view.scrollDOM.setCssStyles({ position: "" });
			this.scrollPositionPatched = false;
		}
		this.clearHoverWatchdog();
		// A stroke interrupted by teardown never reaches pen-up, so the
		// ticker rAF would keep rescheduling itself against a dead overlay.
		this.stopFrameTicker();
		this.container?.remove();
		this.container = null;
		this.band = null;
		// A pinch frame outliving the overlay would touch a torn-down editor.
		if (this.pinchRaf !== 0) {
			this.winRef.cancelAnimationFrame(this.pinchRaf);
			this.pinchRaf = 0;
		}
		this.pinchPending = null;
		// Hand the editor back the way it was found. The transform, the
		// counter-sized box and the origin all live on view.dom, which
		// OUTLIVES this overlay: unmounting while zoomed used to leave the
		// editor painted at scale in a fraction-width box, with the only
		// code that could undo it now unloaded.
		const host = this.view.dom;
		host.style.removeProperty("transform");
		host.style.removeProperty("transform-origin");
		host.style.removeProperty("width");
		host.style.removeProperty("height");
		this.pinchScaleNow = 1;
		this.pinchRasterScale = 1;
		this.pinchRefScale = null;
		this.pinchAnchor = null;
		this.pinchScrollAt = 0;
		this.builder = null;
		this.penCursorEl = null;
		this.eraserEl = null;
		this.mobileTools?.destroy();
		this.mobileTools = null;
		this.resetGestureState();
		if (this.hostPositionPatched) {
			this.view.dom.setCssStyles({ position: "" });
			this.hostPositionPatched = false;
		}
		if (this.chromeHostPatched) {
			this.chromeHostPatched.setCssStyles({ position: "" });
			this.chromeHostPatched = null;
		}
	}

	update(u: ViewUpdate): void {
		if (!this.container) {
			if (enabled) this.mount();
			return;
		}
		// Obsidian reuses the same editor across file switches. When a
		// different note takes over, NOTHING of the previous note's ink may
		// survive on screen: drop any in-flight stroke, wipe the transient
		// layers, and repaint committed ink from the new file's store entry
		// (which clears the canvas even when that entry is empty). Without
		// this the old bitmap sat there until the next repaint trigger: the
		// v0.9.1 cross-file ink leak.
		// Ink history ops re-dispatched by the editor's undo/redo. Original
		// gestures carry the inkApplied annotation (the store already reflects
		// them); anything else is history's work and gets applied here. The op
		// carries its own path, so undo after a file switch still acts on the
		// note where the ink lives.
		for (const tr of u.transactions) {
			if (tr.annotation(inkApplied)) continue;
			for (const effect of tr.effects) {
				if (effect.is(inkEffect)) this.applyInkOp(effect.value);
			}
		}

		const path = this.filePath();
		if (path !== this.lastPath) {
			this.lastPath = path;
			this.updateHandwritingPageClass();
			// A fresh note starts reading, so the strip starts as the pill.
			this.mobileTools?.closeInkSliders();
			this.mobileTools?.setCollapsed(true);
			this.builder = null;
			this.resetGestureState();
			this.wet.clear(this.cssWidth, this.cssHeight);
			this.highlightWet.clear(this.cssWidth, this.cssHeight);
			// A file switch mid-handoff would otherwise strand the wet
			// highlighter element hidden for the next note.
			this.highlightWetCanvas.setCssStyles({ opacity: String(HIGHLIGHTER_ALPHA) });
			this.tail.clearAll(this.cssWidth, this.cssHeight);
			this.scheduleRepaint();
			this.loadInk(path);
			return;
		}
		// Reflow, resize, edits, viewport moves: committed ink repaints from
		// note-surface coordinates. Note what is NOT here: nothing repositions
		// strokes. Text edits are invisible to ink by construction.
		if (u.geometryChanged || u.viewportChanged || u.docChanged) {
			// Font-zoom edge: the quick-font-size reflow arrives here as a
			// geometry update. One string compare against a LIVE computed
			// style. No per-frame polling, no new style objects.
			if (
				u.geometryChanged &&
				this.contentStyle &&
				this.contentStyle.fontSize !== this.lastFontStr
			) {
				this.handleResize();
			}
			// "scroll", not the default: the default marks the whole surface
			// damaged and the index dirty, so every keystroke in a note with
			// ink re-rasterized every visible stroke and rebuilt the index -
			// for an edit that cannot move ink, by construction. "scroll"
			// asks for a repaint without asserting damage, and repaint()
			// already upgrades ANY camera motion to a full one, which is what
			// a reflow actually produces. The paths that do move ink (the
			// lasso drag, insert-space and its correction) mark their own
			// damage and are unaffected.
			this.scheduleRepaint("scroll");
		}
	}

	destroy(): void {
		this.unmount();
		instances.delete(this);
	}

	handleKeyDown(event: KeyboardEvent): boolean {
		// Escape deselects, like everywhere else lassos exist.
		if (event.key === "Escape" && !this.selection.isEmpty) {
			this.selection.clear();
			this.redrawSelectionUI();
			this.mobileTools?.refresh();
			event.preventDefault();
			return true;
		}
		// ...and with nothing selected, Escape leaves whatever mode has the
		// tip. Landing in pan or insert space used to strand you until you
		// found the Pen button; Escape is what a hand reaches for, and the
		// nib it returns to is the one that was already chosen.
		if (event.key === "Escape" && tipModeHeld()) {
			releaseTipModes();
			this.mobileTools?.refresh();
			this.hidePenCursor();
			event.preventDefault();
			return true;
		}
		// Ctrl/Cmd+C and X act on lassoed INK while any is selected: that is
		// what a lasso means everywhere else (orion 2026-08-26: ctrl+c after
		// a lasso copied nothing, and a stale ink clipboard pasted a page).
		// Mod-V stays the editor's - pasting text with nothing selected is
		// normal, so ink paste keeps its command and its strip button.
		// Only while the EDITOR's own selection is empty: someone who lassoed
		// ink and then swept text with the mouse means the text when they
		// press ctrl+c, and stealing that copy would be the worse surprise.
		if (
			(event.ctrlKey || event.metaKey) &&
			!event.altKey &&
			!this.selection.isEmpty &&
			this.view.state.selection.main.empty
		) {
			const k = event.key.toLowerCase();
			if (k === "c" || k === "x") {
				const n = k === "c" ? this.copySelectedInk() : this.cutSelectedInk();
				if (n > 0) {
					event.preventDefault();
					new Notice(`Handwriting: ${k === "c" ? "copied" : "cut"} ${n} stroke(s)`);
					// The strip's paste button wakes now, without waiting for
					// the next tap or stroke.
					this.mobileTools?.refresh();
					return true;
				}
			}
		}
		return this.selectionDeleteKeys.keydown(event);
	}

	/**
	 * Ctrl+V (and right-click paste, and a clipboard manager's history)
	 * pastes INK when the system clipboard carries our marker. Anything
	 * else is somebody's text and passes straight through, which is what
	 * makes this safe: copying text after ink pastes the text.
	 */
	handlePaste(event: ClipboardEvent): boolean {
		const text = event.clipboardData?.getData("text/plain") ?? "";
		if (text === "" || markerToken(text) === null) return false;
		// Ours either way now: the marker is bookkeeping, and letting it
		// land in a note as literal text would be the worse outcome.
		event.preventDefault();
		event.stopPropagation();
		if (!markerIsCurrent(text)) {
			// A marker outliving the ink it named: a clipboard manager
			// replaying an entry from a previous run of the app.
			new Notice("Handwriting: that ink was copied before the app restarted");
			return true;
		}
		const n = this.pasteInkHere();
		if (n > 0) new Notice(`Handwriting: pasted ${n} stroke(s)`);
		return true;
	}

	handleKeyUp(event: KeyboardEvent): boolean {
		return this.selectionDeleteKeys.keyup(event);
	}

	/** Everything needed to identify the zoom mechanism from hardware. */
	zoomReport(): string {
		const rect = this.container?.getBoundingClientRect();
		const content = this.view.contentDOM.getBoundingClientRect();
		const cs = this.winRef.getComputedStyle(this.view.contentDOM);
		return [
			`file: ${this.filePath() ?? "(none)"}`,
			`devicePixelRatio: ${this.winRef.devicePixelRatio}`,
			`measured scale: ${this.scale}  (cssScale ${this.cssScale} × fontZoom ${this.fontZoom}; CM scaleX ${this.view.scaleX}, scaleY ${this.view.scaleY})`,
			`font: current ${this.lastFontStr || "(unread)"} reference ${this.refFontPx}px  camera zoom ${this.camera.zoom}`,
			`overlay rect: ${rect?.width.toFixed(2)} x ${rect?.height.toFixed(2)} (visual px)`,
			`overlay offset: ${this.container?.offsetWidth} x ${this.container?.offsetHeight} (layout px)`,
			`content rect left/width: ${content.left.toFixed(2)} / ${content.width.toFixed(2)}`,
			`content offsetWidth: ${this.view.contentDOM.offsetWidth}`,
			`content font-size / line-height: ${cs.fontSize} / ${cs.lineHeight}`,
			`documentTop: ${this.view.documentTop.toFixed(2)}  contentHeight: ${this.view.contentHeight.toFixed(2)}`,
			`canvas backing: ${this.committedCanvas?.width} x ${this.committedCanvas?.height}` +
				`  css: ${this.cssWidth.toFixed(2)} x ${this.cssHeight.toFixed(2)}`,
			`camera origin (note space): ${this.camera.x.toFixed(2)}, ${this.camera.y.toFixed(2)}`,
			`strokes on this note: ${this.filePath() ? inlineInk.strokes(this.filePath()!).length : 0}`,
			`canvas reallocations since load: ${canvasReallocs}` +
				"  (5 per resize; a pinch should add ~5 in total, not ~5 per frame)",
		].join("\n");
	}

	/** See inkExternallyReloaded. */
	noteExternallyReloaded(path: string): void {
		if (this.filePath() !== path) return;
		if (this.selection.clear()) this.redrawSelectionUI();
		this.scheduleRepaint("external-reload");
	}

	/** This editor's path, when no gesture is active (the reload poll gate). */
	reloadCandidatePath(): string | null {
		if (this.builder !== null || this.mode !== "ink") return null;
		return this.filePath();
	}

	/** The live overlay container, for the census's ghost detection. */
	containerEl(): Element | null {
		return this.container;
	}

	routerCounters(): {
		downs: number;
		ups: number;
		backstops: number;
		silentLifts: number;
		palms: number;
	} {
		return {
			downs: this.router?.penDowns ?? 0,
			ups: this.router?.penUps ?? 0,
			backstops: this.router?.fallbackEnds ?? 0,
			silentLifts: this.router?.silentLiftEnds ?? 0,
			palms: this.router?.palmsBlocked ?? 0,
		};
	}

	// ---- geometry -----------------------------------------------------------

	private handleResize(): void {
		if (!this.container) return;
		// The container no longer inherits the editor's box, so its size is
		// whatever syncBand last wrote. Resize it FIRST or every measurement
		// below - including the zero-size check that releases the backings in
		// a background tab - reads the previous viewport's band.
		this.syncBand();
		const prevScale = this.scale;
		const rect = this.container.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) {
			// A background tab keeps its editor - and this overlay - alive
			// at zero size. Five full-size backings on an invisible surface
			// are ~70MB at high dpr (seen live: a 0x0 editor holding a
			// 2239x1620 backing), and it climbs with every background tab
			// over a session. Release them; the ResizeObserver refires when
			// the tab fronts, and the non-zero path reallocates and
			// repaints synchronously, so nothing is ever shown blank.
			if (!this.frame.locked && this.committedCanvas.width > 0) {
				for (const c of [
					this.committedCanvas,
					this.wetCanvas,
					this.tailCanvas,
					this.highlightCanvas,
					this.highlightWetCanvas,
				]) {
					c.width = 0;
					c.height = 0;
				}
			}
			return;
		}
		this.dpr = this.winRef.devicePixelRatio || 1;
		// The canvases live INSIDE whatever is scaled, so their coordinate
		// space is layout px, the same unit ink is stored in. Size them from
		// the untransformed box and give the backing store the extra device
		// pixels the scale demands, so ink stays crisp instead of being
		// upscaled by the compositor.
		this.cssScale = effectiveScale({
			visualWidth: rect.width,
			layoutWidth: this.container.offsetWidth,
			cmScaleX: this.view.scaleX,
		});
		// Quick-font-size zoom (Ctrl+scroll / touchpad pinch) is a reflow:
		// dpr and the transform scale both stay put while the text grows.
		// The current/mount-time font ratio is the missing zoom factor.
		this.contentStyle ??= this.winRef.getComputedStyle(this.view.contentDOM);
		this.lastFontStr = this.contentStyle.fontSize;
		const fontPx = Number.parseFloat(this.lastFontStr);
		if (this.refFontPx <= 0 && Number.isFinite(fontPx) && fontPx > 0) {
			this.refFontPx = fontPx;
		}
		this.fontZoom = fontZoomFactor(fontPx, this.refFontPx);
		this.scale = this.cssScale * this.fontZoom;
		const layoutW = this.container.offsetWidth || rect.width;
		const layoutH = this.container.offsetHeight || rect.height;
		// Backing resolution: device px per SCREEN css px. The font zoom is
		// GEOMETRY (applied by the camera before rasterization), not
		// resolution. Folding it in here was the part-2 bug's sibling.
		const backing = this.backingNow(layoutW, layoutH);
		const size = computeCanvasSize(layoutW, layoutH, backing);
		// Same backing, same box: reallocating would blank five canvases
		// for nothing (setting width clears a canvas even to the same
		// value). The ios keyboard animation streams resize ticks, and
		// every needless blank was a visible flicker frame.
		// Scale is part of "unchanged": a pinch or ctrl-scroll zoom reflows
		// the text and moves this.scale WITHOUT touching the canvas size,
		// and skipping its repaint left ink painted at the old zoom (the
		// 1.0.9 regression this guard shipped with).
		const unchanged =
			this.scale === prevScale &&
			this.committedCanvas.width === size.backingW &&
			this.committedCanvas.height === size.backingH &&
			this.cssWidth === size.cssW &&
			this.cssHeight === size.cssH;
		this.cssWidth = size.cssW;
		this.cssHeight = size.cssH;
		if (unchanged) {
			this.router?.refreshRect();
			return;
		}
		for (const c of [
			this.committedCanvas,
			this.wetCanvas,
			this.tailCanvas,
			this.highlightCanvas,
			this.highlightWetCanvas,
		]) {
			// Counted, because "the canvases are being reallocated every frame"
			// is a claim that should be a number rather than an argument. Each
			// assignment here throws away and re-allocates a backing store the
			// size of the viewport times the backing scale, five times over.
			canvasReallocs++;
			c.width = size.backingW;
			c.height = size.backingH;
			c.setCssStyles({ width: `${size.cssW}px`, height: `${size.cssH}px` });
		}
		this.committedCtx.setTransform(backing, 0, 0, backing, 0, 0);
		this.highlightCtx.setTransform(backing, 0, 0, backing, 0, 0);
		this.wet.applyDpr(backing);
		this.highlightWet.applyDpr(backing);
		this.tail.applyDpr(backing);
		this.router?.refreshRect();
		this.axisChecked = false;
		// Reallocation blanked the canvases: the ledger and the camera latch
		// must both know, or the sync repaint below would paint nothing.
		this.damage.addAll();
		this.indexDirty = true;
		this.lastPaintCam = null;
		// Reallocation just blanked the backing. Painting NOW, in the same
		// task, means no frame is ever presented empty; the scheduled path
		// waits for the next animation frame and shows one blank frame per
		// resize event - a sustained flicker under the ios keyboard's
		// animation. Mid-gesture keeps the scheduled path: the frozen
		// frame owns the coordinate space until pen-up.
		if (this.builder === null && this.mode === "ink") {
			this.repaint();
		} else {
			this.scheduleRepaint("resize");
		}
	}

	/**
	 * Pin the camera so world == note surface: the camera holds the surface
	 * point currently at the overlay's top-left. `documentTop` is CM's public
	 * "top of the document in screen coordinates", so this is two subtractions.
	 * No scrollTop bookkeeping; padding is handled by CM.
	 */
	/**
	 * The backing factor every canvas and every probe must agree on. One
	 * accessor because five call sites computed it independently: if they
	 * ever disagreed, ink would rasterise at one resolution and be drawn
	 * through a transform built for another.
	 */
	/**
	 * Where floating chrome hangs: OUTSIDE the element pinch zoom scales.
	 *
	 * The strip lived on `view.dom`, which is the element the zoom transform
	 * is applied to. That was invisible while the box was counter-sized -
	 * the narrower layout box and the scale cancelled out - but the moment
	 * zoom became a pure transform, `right: 8px` started meaning "the right
	 * edge of a box painted k times too wide", and the toolbar flew off the
	 * screen (alan, 1.3.2, hardware).
	 *
	 * The parent is the editor's own container, which never scales, so the
	 * strip stays put and stays its own size at any magnification - which is
	 * what chrome should do anyway: nobody wants 4x buttons. Falls back to
	 * the editor itself if there is no parent to hang from.
	 */
	private chromeHost(): HTMLElement {
		const parent = this.view.dom.parentElement;
		if (!parent) return this.view.dom;
		if (this.winRef.getComputedStyle(parent).position === "static") {
			parent.setCssStyles({ position: "relative" });
			// Remember the ELEMENT, not the fact. Teardown used to re-derive
			// it from `view.dom.parentElement`, and by then Obsidian may have
			// already detached the editor - leaving a container we do not own
			// with a position it did not have, and no record that we set it.
			this.chromeHostPatched = parent;
		}
		return parent;
	}

	/** What the two latency-critical canvases actually got, not what was asked. */
	latencyReport(): string {
		return `canvas latency: wet [${this.wet.describe()}]  ${this.tail.describeLatency()}`;
	}

	private backingNow(layoutW?: number, layoutH?: number): number {
		const w = layoutW ?? this.container?.offsetWidth ?? 0;
		const h = layoutH ?? this.container?.offsetHeight ?? 0;
		return backingScale(this.dpr, this.cssScale, w, h);
	}

	private syncCamera(): void {
		if (!this.container) return;
		// A stroke in flight owns its coordinate frame until it ends.
		if (this.frame.locked) return;
		const overlay = this.container.getBoundingClientRect();
		const contentLeft = this.view.contentDOM.getBoundingClientRect().left;
		const documentTop = this.view.documentTop;
		// Measure the SCALE from the same rect read as the camera, every
		// time, instead of trusting the value handleResize last cached.
		//
		// The cache was the bug (alan, hardware, zoom report): after a pinch
		// it read 2.1730 while the editor was really scaled 1.7115 - the
		// overlay's own 2389.26 visual over 1396 layout px, which CM's scaleX
		// and the content element both agreed with. The pen divides by this
		// number, so every coordinate came out at 0.788 of where it belonged,
		// compressed toward the top-left. Which code path failed to refill
		// the cache stopped mattering once the pen measures for itself: the
		// scale and the camera now come from one read and cannot disagree.
		const measured = effectiveScale({
			visualWidth: overlay.width,
			layoutWidth: this.container.offsetWidth,
			cmScaleX: this.view.scaleX,
		});
		// Adopt it only when it MEANS something. Rect widths are fractional,
		// so this quotient wobbles in its last decimals every frame; letting
		// that through moved the camera origin every frame, and repaint()
		// treats any camera motion as a full re-rasterization of every
		// stroke - turning the damage-rect fast path off entirely, and
		// defeating handleResize's unchanged guard so five 10-megapixel
		// canvases could be reallocated for nothing. A real zoom step is
		// thousands of times larger than this threshold, so nothing that
		// matters is filtered out.
		if (Math.abs(measured - this.cssScale) > this.cssScale * SCALE_EPSILON) {
			this.cssScale = measured;
			this.scale = this.cssScale * this.fontZoom;
		}
		// Stashed for the scroll probe: read once, here, never re-read there.
		this.lastSyncRectLeft = overlay.left;
		this.lastSyncRectTop = overlay.top;
		this.lastSyncContentLeft = contentLeft;
		this.lastSyncDocumentTop = documentTop;
		// Stashed for the scroll probe, in the same synchronous block as the
		// rects above so a diagnostic can never blame a mismatch on having
		// read the two at different moments.
		this.lastSyncScrollLeft = this.view.scrollDOM.scrollLeft;
		this.lastSyncScrollTop = this.view.scrollDOM.scrollTop;
		// Both reads are visual px; the difference becomes note space by
		// dividing out the scale. At scale 1 this is arithmetically identical
		// to what shipped, so persisted coordinates keep their meaning.
		// Both reads are visual px. The camera origin is the overlay's WORLD
		// coordinate, so the division is by the TOTAL factor (cssScale × font
		// zoom). The font zoom itself rides on the camera as a real zoom:
		// worldToScreen multiplies by it, screenToWorld divides by it, so the
		// forward and inverse transforms are inverses by construction.
		this.camera.setState(
			visualToNote(overlay.left - contentLeft, this.scale),
			visualToNote(overlay.top - documentTop, this.scale),
			this.fontZoom
		);
	}

	// ---- pen path (frozen pipeline) ----------------------------------------

	private penDown(sample: PenSample, ev: PointerEvent): void {
		// The router cancels pointerdown so the pen cannot move CodeMirror's
		// caret. That also cancels native focus. Give keyboard ownership back to
		// this editor before freezing geometry, or Delete and undo go wherever
		// focus happened to be before the pen landed.
		focusClaimedPenEditor(this.view, Platform.isMobileApp);
		// Hide the DOT only. The hover class stays on: it is what holds
		// `cursor: none` over the scroller, and dropping it here handed every
		// stroke to CodeMirror's I-beam - the reticle "flickered" because each
		// pen-down swapped it for a text cursor and each pen-up swapped it
		// back. The class comes off when the pen leaves (onPenLeave), not
		// when it touches down.
		if (this.penCursorEl) this.penCursorEl.setCssStyles({ display: "none" });
		// The only layout reads on the whole stroke happen here, once. From
		// here the frame is frozen until pen-up.
		this.frame.end();
		// The band is deliberately NOT moved here. The sample this was handed
		// was already mapped by the router against the box as it stands, and
		// moving it now would leave that ONE point in a different coordinate
		// frame from every sample that follows - which draws as a straight
		// line from nowhere into the stroke (alan, hardware: writing near the
		// bottom of a page, where the end-of-document clamp makes the move a
		// large one). Nothing is lost by leaving it: the band is guaranteed to
		// cover the viewport at every scroll position that has been checked,
		// and pen-down does not move the viewport.
		this.syncCamera();
		this.router?.refreshRect();
		this.frame.begin();
		if (isPenProbeEnabled()) this.captureProbeGeometry();
		this.recordPenDownState(sample);

		// A gesture is starting, whichever one: the strip steps aside and its
		// drop-down chrome closes. This sat in the ink branch alone, so the
		// toolbar stayed put under an eraser and covered the ink being
		// rubbed out (alan, 2026-08-27). penUp restores it for every gesture
		// already, so only the hide was one-sided.
		this.mobileTools?.setInking(true);
		this.mobileTools?.closeInkSliders();

		// The pen decides what it is at contact (§52/§53, mode-free):
		// eraser end erases, side button held lassos/moves, tip inks.
		const eraserEnd = (ev.buttons & 32) !== 0 || ev.button === 5;
		const eraser = eraserEnd || tipMode() === "eraser";
		// Lasso mode makes the TIP lasso: the side-button path for hardware that
		// has no side button (every apple pencil, every mouse).
		const side = !eraser && ((ev.buttons & 2) !== 0 || tipMode() === "lasso");
		if (side) {
			this.mode = "lasso";
			this.lassoDown(sample);
			return;
		}
		// A bare tip landing INSIDE an active selection drags it - OneNote's
		// grammar (alan, 2026-08-27): the side button selects, then either
		// the tip or the held side button moves. Outside, the tip dissolves the
		// selection and inks, same as always. Esc backs out without a move.
		if (!this.selection.isEmpty) {
			const w = this.camera.screenToWorld(sample.x, sample.y);
			const bounds = this.selectionBounds();
			if (
				bounds &&
				pointInBBox(w.x, w.y, padBBox(bounds, visualToNote(SELECTION_GRAB_PAD, this.scale)))
			) {
				this.mode = "lasso";
				this.lassoDown(sample);
				return;
			}
		}
		// Tip and eraser return the pen to normal behavior: selection dissolves.
		if (this.selection.clear()) this.redrawSelectionUI();
		if (eraser) {
			this.mode = "erase";
			this.erased = [];
			// The list as it stands BEFORE the gesture. Indices for the undo
			// op are taken against this at pen-up, not against the list as it
			// is being emptied: takeLive reports each stroke's position in
			// whatever the list held at that instant, so the second stroke a
			// drag crossed recorded a position already short by the first,
			// and undoing a multi-stroke erase put the ink back at the wrong
			// depth. The op's indices have to name one stable list, and the
			// only one that means anything to `replace` is the pre-gesture
			// one. This is the note surface's version of what
			// PdfInkController.recordErase does with eraseFrom.
			const here = this.filePath();
			this.eraseFrom = here ? [...inlineInk.strokes(here)] : [];
			// Stroke or reticle is a property of the ERASER, whichever way
			// it was reached (eraser end or the mode). The radius still
			// decides what counts as touched either way.
			this.eraseWhole = eraserWholeStrokes;
			metrics.begin("erase", performance.now());
			this.startFrameTicker();
			this.showEraserCursor(sample);
			this.eraseAt(sample);
			return;
		}
		if (tipMode() === "pan") {
			this.mode = "pan";
			// A pan MOVES the surface under the ink, so the frame must stay
			// live: the lock exists to stop reflow shearing a stroke, and
			// here there is no stroke - freezing it would leave the ink
			// behind the scroll until pen-up.
			this.frame.cancel();
			this.panLast = { x: ev.clientX, y: ev.clientY };
			return;
		}
		if (tipMode() === "space") {
			this.mode = "space";
			this.spaceDown(sample, ev);
			return;
		}
		this.mode = "ink";
		metrics.begin("ink", performance.now());
		this.startFrameTicker();
		// Bind the nib once: the raw loop never asks which tool is active.
		const tool = inlineTool;
		this.activeStyle = tool === "highlighter" ? this.highlighterStyle : this.penStyle;
		// Nib size and color: bound per stroke from the current selection.
		// The stroke stores both, so later selection changes never touch it.
		this.activeStyle.baseWidth =
			(tool === "highlighter" ? HIGHLIGHTER_PEN.baseWidth : DEFAULT_PEN.baseWidth) *
			getInkSizeMult(tool);
		this.activeStyle.color = getInkColorHex(tool);
		markPenSeen();
		this.ensurePenTools();
		// The strip stepped aside at contact, above; a strip only just created
		// by ensurePenTools has not heard that yet, so tell it now.
		this.mobileTools?.setInking(true);
		this.activeWet = tool === "highlighter" ? this.highlightWet : this.wet;
		// The wet layer's shaping follows the device per stroke: a mouse
		// stroke draws flat live, exactly as it will commit.
		const fromMouse = ev.pointerType === "mouse";
		this.wet.shape = !fromMouse;
		// A mouse's constant 0.5 is neither evidence about the pen hardware
		// nor something to amplify: gain 1, and its max is never reported.
		this.strokeGain = fromMouse ? 1 : strokeGain();
		this.strokeRawMax = 0;
		this.strokePenGesture = !fromMouse;
		this.rawLastMoveT = sample.timestamp;
		this.rawLastMoveX = sample.x;
		this.rawLastMoveY = sample.y;
		// Prediction never carries across strokes: extrapolating a new stroke
		// from the tail of the last one would guess a direction from a pen
		// that has been lifted and put down somewhere else.
		this.predReal = [];
		this.predLastTail = [];
		this.builder = new StrokeBuilder(
			tool,
			this.activeStyle.color,
			this.activeStyle.baseWidth,
			undefined,
			fromMouse ? "mouse" : undefined
		);
		this.builder.start(sample.timestamp);
		const w = this.camera.screenToWorld(sample.x, sample.y);
		const point = this.builder.add(
			w.x,
			w.y,
			this.gainedPressure(sample.pressure),
			sample.timestamp,
			sample.tiltX,
			sample.tiltY
		);
		if (point) {
			this.activeWet.beginStroke(point, this.activeStyle);
			// A tap that never moves produces no rawupdate, so without this the
			// dot only appears at pen-up. Draw the contact point immediately.
			this.tail.clear();
			this.tail.drawHead(
				this.camera.snapshot,
				this.activeStyle,
				{ x: point.x, y: point.y },
				{ x: point.x, y: point.y },
				point.pressure
			);
			this.probeSample(sample, ev, point, 1, true, "down");
		}
		noteProbeStroke();
	}

	private penRaw(samples: PenSample[], ev: PointerEvent): void {
		if (this.mode === "lasso") {
			this.lassoMove(samples);
			return;
		}
		if (this.mode === "space") {
			this.spaceMove(samples);
			return;
		}
		if (this.mode === "pan") {
			this.panMove(ev);
			return;
		}
		if (this.mode === "erase") {
			for (const s of samples) this.eraseAt(s);
			const last = samples[samples.length - 1];
			if (last) this.showEraserCursor(last);
			return;
		}
		if (!this.builder || samples.length === 0) return;
		const t0 = performance.now();
		metrics.recordEvent("raw", samples.length, t0 - ev.timeStamp, true);
		const cam = this.camera.snapshot;
		const drawStart = performance.now();
		let accepted = 0;
		let lastAccepted: { x: number; y: number } | undefined;
		for (const s of samples) {
			if (Math.hypot(s.x - this.rawLastMoveX, s.y - this.rawLastMoveY) > 4) {
				this.rawLastMoveT = s.timestamp;
				this.rawLastMoveX = s.x;
				this.rawLastMoveY = s.y;
			}
			const w = this.camera.screenToWorld(s.x, s.y);
			const point = this.builder.add(
				w.x,
				w.y,
				this.gainedPressure(s.pressure),
				s.timestamp,
				s.tiltX,
				s.tiltY
			);
			if (point) {
				this.activeWet.appendPoint(cam, this.activeStyle, point);
				lastAccepted = point;
				accepted++;
			}
		}
		const drawEnd = performance.now();
		const newestTs = samples[samples.length - 1]!.timestamp;
		metrics.recordAccepted(accepted);
		metrics.recordDraw(drawEnd - drawStart, drawEnd - newestTs);

		// Live raw head, exactly as the approved pipeline draws it.
		this.tail.clear();
		const head = this.activeWet.head();
		if (head) this.tail.drawHead(cam, this.activeStyle, head.from, head.to, head.pressure);
		// The predicted tail goes on the same canvas, after the head, so the
		// one `clear()` above erases both: its dirty rect covers whatever was
		// drawn last event, whether that was real or a guess.
		if (predictionEnabled()) {
			this.predReal.push(...samples);
			if (this.predReal.length > PRED_HISTORY) {
				this.predReal.splice(0, this.predReal.length - PRED_HISTORY);
			}
			this.drawPredictedTail(ev, cam);
		}
		// Probe AFTER the head is drawn: `head()` is then exactly the geometry
		// on screen, so the recorded endpoint is the rendered endpoint.
		if (isPenProbeEnabled()) {
			const newest = samples[samples.length - 1]!;
			this.probeSample(
				newest,
				ev,
				lastAccepted,
				samples.length,
				lastAccepted !== undefined,
				samples.length > 1 ? "coalesced" : "rawupdate"
			);
		}
		this.schedulePresentProbe(newestTs);
	}

	/**
	 * Draw a short disposable tail ahead of the newest real sample.
	 *
	 * Never added to the stroke: `builder.add` has already seen every real
	 * sample by the time this runs, and these points touch nothing but the
	 * transient canvas. A stroke saved mid-prediction is exactly the stroke
	 * that would have been saved without it.
	 *
	 * The scoring happens FIRST, against the tail drawn last event: the sample
	 * that just arrived is the ground truth for the guess made before it, and
	 * once `predLastTail` is overwritten that comparison is gone. It is what
	 * turns "does prediction overshoot on my handwriting" into a number in the
	 * ink metrics rather than an argument.
	 */
	private drawPredictedTail(ev: PointerEvent, cam: CameraState): void {
		const real = this.predReal;
		const newest = real[real.length - 1];
		if (!newest) return;
		if (this.predLastTail.length > 0) {
			const err = correctionError(this.predLastTail, newest);
			if (err !== undefined) metrics.recordCorrection(err);
		}
		const predicted = this.router?.predictedSamples(ev) ?? [];
		const mode = predicted.length > 0 ? "chromium" : "extrap";
		// Boox mode keeps its fixed e-ink horizon; everyone else gets one
		// sized from what this machine's own frames measured.
		const caps = predictionEinkOn() ? EINK_CAPS : adaptiveCaps(presentLagMs());
		const result = buildTail(real, predicted, mode, caps);
		metrics.setPrediction("on", result.source, caps.maxHorizonMs);
		this.predLastTail = result.points;
		if (result.suppressed || result.points.length === 0) {
			metrics.recordTailSuppressed();
			return;
		}
		metrics.recordTail(result.points.length, result.horizonMs, result.tipDistPx);
		// Sample space IS canvas css px: a sample is the client offset from the
		// container divided by the css scale, and drawHead's own screen
		// arithmetic - (world - cam) * zoom - lands on the same number.
		this.tail.draw(
			newest.x,
			newest.y,
			result.points,
			this.activeStyle.color,
			// The width the ribbon is actually laying down, not one derived
			// from raw pressure: with shaping on those differ by a lot at
			// speed, and the tail was drawing the fatter of the two.
			this.activeWet.liveWidthPx(cam, this.activeStyle, newest.pressure)
		);
	}

	private schedulePresentProbe(newestTs: number): void {
		if (this.presentProbePending) return;
		this.presentProbePending = true;
		this.winRef.requestAnimationFrame(() => {
			this.presentProbePending = false;
			const presentAge = performance.now() - newestTs;
			recordPresentAge(presentAge);
			metrics.recordPresent(presentAge);
		});
	}

	/**
	 * What syncCamera WOULD produce right now, without touching the camera.
	 * Read-only diagnostic twin of syncCamera: while frameLocked freezes the
	 * stroke's frame, the difference between this and the live camera is the
	 * exact on-screen displacement of the ink layer relative to the document.
	 */
	private freshFrame(): { x: number; y: number } | null {
		if (!this.container) return null;
		const overlay = this.container.getBoundingClientRect();
		const contentLeft = this.view.contentDOM.getBoundingClientRect().left;
		return {
			x: visualToNote(overlay.left - contentLeft, this.scale),
			y: visualToNote(overlay.top - this.view.documentTop, this.scale),
		};
	}

	/** One scroll-probe row per acquisition: everything the mapping read. */
	private recordPenDownState(sample: PenSample): void {
		this.scrollsDuringStroke = 0;
		if (!diagnosticsEnabled()) return;
		const scroller = this.view.scrollDOM;
		const w = this.camera.screenToWorld(sample.x, sample.y);
		scrollProbePenDown({
			clientX: this.lastSyncRectLeft + noteToVisual(sample.x, this.cssScale),
			clientY: this.lastSyncRectTop + noteToVisual(sample.y, this.cssScale),
			noteX: w.x,
			noteY: w.y,
			scrollLeft: scroller.scrollLeft,
			scrollTop: scroller.scrollTop,
			rectLeft: this.lastSyncRectLeft,
			rectTop: this.lastSyncRectTop,
			cssW: this.cssWidth,
			cssH: this.cssHeight,
			camX: this.camera.x,
			camY: this.camera.y,
			scale: this.scale,
			spacerLeft: this.spacerLeft,
			spacerTop: this.spacerTop,
			axisPatched: this.axisGuard.patched,
			scrollWidth: scroller.scrollWidth,
			scrollHeight: scroller.scrollHeight,
			clientWidth: scroller.clientWidth,
			clientHeight: scroller.clientHeight,
		});
	}

	/** Adaptive gain, then the existing clamp; tracks the raw per-stroke max. */
	private gainedPressure(raw: number): number {
		if (Number.isFinite(raw) && raw > this.strokeRawMax) this.strokeRawMax = raw;
		return normalizeInlinePenPressure(raw * this.strokeGain);
	}

	private penUp(): void {
		// Whatever the gesture was, it is over: the frame is live again and
		// re-reads the editor's current origin.
		this.frame.end();
		// The stroke is over: the strip returns (a beat later, so an eraser
		// scrub's rapid lift-and-reland does not strobe it) and its buttons
		// catch up with what undo can do now. The catch-up is a microtask,
		// NOT immediate: every branch below this line dispatches its ops
		// later in this same method, so a synchronous refresh here reads the
		// history depth from BEFORE the gesture - after the first stroke on
		// a fresh note, a working undo button kept wearing the disabled look
		// that issue #1 was filed about. The microtask runs once penUp and
		// all its dispatches have returned, whichever branch they took.
		this.mobileTools?.setInking(false);
		queueMicrotask(() => this.mobileTools?.refresh());
		if (this.mode === "pan") {
			this.mode = "ink";
			this.panLast = null;
			this.updateExtent(true);
			return;
		}
		if (this.mode === "space") {
			this.mode = "ink";
			this.spaceUp();
			this.updateExtent(true);
			return;
		}
		if (this.mode === "lasso") {
			this.mode = "ink";
			this.lassoUp();
			this.updateExtent(true);
			return;
		}
		if (this.mode === "erase") {
			this.mode = "ink";
			metrics.end(performance.now());
			this.stopFrameTicker();
			this.hideEraserCursor();
			const erased = this.erased;
			const eraseFrom = this.eraseFrom;
			this.erased = [];
			this.eraseFrom = [];
			const path = this.filePath();
			if (erased.length === 0 || !path) return;
			// One persist per gesture, at pen-up. Never on the erase hot path.
			inlineInk.save(path);
			// What survived the gesture, at the positions it now occupies.
			const inserted: InkStroke[] = [];
			const insertedAt: number[] = [];
			inlineInk.strokes(path).forEach((st, i) => {
				if (this.erasePieces.has(st.id)) {
					inserted.push(st);
					insertedAt.push(i);
				}
			});
			this.erasePieces.clear();
			const removed = erased.map((e) => e.stroke);
			const removedAt = eraseRemovalIndices(eraseFrom, erased);
			this.dispatchInk({
				type: "replace",
				path,
				removed,
				removedAt,
				inserted,
				insertedAt,
			});
			// The gesture is over and the splices are in. Not per sample:
			// mid-gesture the frontier can only shrink, and a stale LARGER
			// frontier only over-grants a scroll range that never shrinks
			// anyway. §5g/G1.
			this.frontierCache.invalidate(path);
			this.repaintPath(path);
			return;
		}
		metrics.end(performance.now());
		this.stopFrameTicker();
		const builder = this.builder;
		this.builder = null;
		// Finish before clearing the wet layer. Release filtering may produce
		// several stored strokes from one contact, but every committed segment
		// is drawn underneath the still-visible wet pixels before they clear.
		if (this.strokePenGesture) observeStrokeMax(this.strokeRawMax);
		this.strokePenGesture = false;
		let strokes = builder?.finishReleaseFiltered() ?? [];
		// Hold the pen still at the end and the figure snaps to the clean
		// shape it meant (line, triangle, rectangle, circle, ellipse). The
		// dwell is the request; an ordinary lift never gets here.
		let snapReplaced: InkStroke | null = null;
		if (shapeSnapOn && strokes.length === 1) {
			const heldMs = performance.now() - this.rawLastMoveT;
			if (heldMs >= DWELL_MS) {
				const snapped = snapStroke(strokes[0]!, true);
				if (snapped) {
					// Kept for history: undo UN-SNAPS back to the freehand
					// (replace inverts to replace), a second undo removes.
					snapReplaced = strokes[0]!;
					strokes = [snapped];
				}
			}
		}
		const stroke = strokes.at(-1);
		const path = stroke ? this.filePath() : null;
		// Paint ground truth, part 1: was the WET ink actually in the backing
		// store? Sampled over the stroke's screen bbox (clamped to canvas).
		let wetPx = -1;
		let sample = { x: 0, y: 0, w: 0, h: 0, clippedPct: 0 };
		if (diagnosticsEnabled() && stroke && path) {
			sample = this.strokeScreenSample(stroke);
			wetPx = this.activeWet.countPainted(
				sample.x,
				sample.y,
				sample.w,
				sample.h,
				this.backingNow()
			);
		}
		if (!stroke || !path) {
			// Boox mode clears the stroke's own box; everyone else keeps the full
			// clear until an e-ink user has confirmed the box on hardware.
			if (predictionEinkOn()) {
				this.activeWet.clearStroke(this.cssWidth, this.cssHeight);
				this.tail.clear();
			} else {
				this.activeWet.clear(this.cssWidth, this.cssHeight);
				this.tail.clearAll(this.cssWidth, this.cssHeight);
			}
			this.highlightWetCanvas.setCssStyles({ opacity: String(HIGHLIGHTER_ALPHA) });
			return;
		}
		handoffFinishedStroke({
			store: () => {
				inlineInk.commitGesture(path, strokes);
				this.updateHandwritingPageClass();
			},
			// Paint underneath the still-visible wet layer. Long strokes can
			// take long enough to flatten that clearing the wet canvas first
			// produces a visible blank frame, especially over Moonlight. That
			// was sharpest while the wet layer was desynchronized, which it no
			// longer is (see INLINE_DESYNCHRONIZED); the ordering is kept
			// because painting before clearing is right either way.
			//
			// That works because pen ink is OPAQUE: the same pixels land twice
			// and nobody can tell. The highlighter is not - both its canvases
			// carry opacity 0.35, so an overlap composites two translucent
			// copies of one stroke into something much darker, and a quick
			// series of strokes strobes (alan, 2026-08-27). Taking the wet
			// element out of the composite in the SAME frame the committed
			// stroke lands keeps the atomicity without the double-paint: the
			// style write and the draw are presented together, and the
			// desynchronized canvas cannot show what it is no longer showing.
			drawCommitted: () => {
				if (this.activeWet === this.highlightWet) {
					this.highlightWetCanvas.setCssStyles({ opacity: "0" });
				}
				for (const finished of strokes) {
					drawStroke(
						this.committedCtxFor(finished.tool),
						this.camera.snapshot,
						finished,
						undefined,
						true
					);
				}
			},
			clearTransient: () => {
				// Boox mode clears the stroke's own box; everyone else keeps the full
				// clear until an e-ink user has confirmed the box on hardware.
				if (predictionEinkOn()) {
					this.activeWet.clearStroke(this.cssWidth, this.cssHeight);
					this.tail.clear();
				} else {
					this.activeWet.clear(this.cssWidth, this.cssHeight);
					this.tail.clearAll(this.cssWidth, this.cssHeight);
				}
				// Cleared, so it is safe to be visible again for the next
				// stroke. Restoring here rather than on the next pen-down
				// keeps the element's resting state honest.
				if (this.activeWet === this.highlightWet) {
					this.highlightWetCanvas.setCssStyles({ opacity: String(HIGHLIGHTER_ALPHA) });
				}
			},
			publishHistory: () => {
				if (snapReplaced) {
					// Two steps, isolated from each other: the stroke landing
					// and the snap over it. One op could not express both, and
					// undo used to strand the un-snapped freehand.
					const at = inlineInk.strokes(path).length - 1;
					for (const op of snapHistoryOps(path, snapReplaced, strokes, at)) {
						this.dispatchInk(op);
					}
				} else {
					this.dispatchInk({ type: "add", path, strokes });
				}
			},
		});
		// Diagnostics (explicitly enabled only): paint ground truth part 2
		// (did the commit draw reach the committed backing store?), plus the
		// frame-desync measure and the COMMIT trace row. Ordinary writing
		// skips every readback and layout read in this block.
		if (diagnosticsEnabled()) this.recordCommitDiagnostics(stroke, path, wetPx, sample);
		this.scrollsDuringStroke = 0;
		// Presentation-probe target: NOTE-space bbox (pen-width padded) plus
		// identity, so later probes can re-locate the ink under whatever
		// camera is current and verify the backing before judging anything.
		const pad = 4;
		this.lastCommitNote = {
			x: stroke.bbox.x - pad,
			y: stroke.bbox.y - pad,
			w: stroke.bbox.width + pad * 2,
			h: stroke.bbox.height + pad * 2,
		};
		this.lastCommitPath = path;
		this.lastCommitId = stroke.id;
		this.lastCommitColor = stroke.color;
		this.lastCommitAt = performance.now();
		// A second pane on the same note shows the new ink too.
		this.repaintPath(path);
		this.updateExtent(true);
	}

	/**
	 * The last committed stroke's box under the CURRENT camera, clamped to
	 * the canvas. Null when there is no target or it left the viewport.
	 */
	private currentTargetBox(): { canvas: ProbeBox; client: ProbeBox } | null {
		if (!this.lastCommitNote || !this.container) return null;
		const n = this.lastCommitNote;
		const z = this.camera.zoom;
		const sx = (n.x - this.camera.x) * z;
		const sy = (n.y - this.camera.y) * z;
		const x = Math.max(0, sx);
		const y = Math.max(0, sy);
		const w = Math.min(this.cssWidth, sx + n.w * z) - x;
		const h = Math.min(this.cssHeight, sy + n.h * z) - y;
		if (w <= 0 || h <= 0) return null;
		return {
			canvas: { x, y, w, h },
			client: {
				x: this.lastSyncRectLeft + noteToVisual(x, this.cssScale),
				y: this.lastSyncRectTop + noteToVisual(y, this.cssScale),
				w: noteToVisual(w, this.cssScale),
				h: noteToVisual(h, this.cssScale),
			},
		};
	}

	/** Region census at the last commit's current screen box. */
	censusReport(liveContainers: Element[]): string | null {
		const t = this.currentTargetBox();
		if (!t || !this.container) return null;
		const b = t.client;
		// Pad a little so near-miss overlays are listed too.
		return regionCensus(
			{ x: b.x - 8, y: b.y - 8, w: b.w + 16, h: b.h + 16 },
			this.container,
			liveContainers
		);
	}

	/**
	 * Composited frame vs committed backing, note-anchored. HARD VALIDITY
	 * GATE: no verdict unless the committed backing contains pixels at the
	 * target at the moment of capture.
	 */
	async presentationReport(): Promise<string | null> {
		if (!this.lastCommitNote) return null;
		const header = `Handwriting presentation capture: stroke ${this.lastCommitId.slice(0, 8)}, committed ${((performance.now() - this.lastCommitAt) / 1000).toFixed(1)}s ago, note box (${this.lastCommitNote.x.toFixed(0)},${this.lastCommitNote.y.toFixed(0)} ${this.lastCommitNote.w.toFixed(0)}x${this.lastCommitNote.h.toFixed(0)})`;
		if (this.filePath() !== this.lastCommitPath) {
			return `${header}\nINVALID: this pane no longer shows ${this.lastCommitPath ?? "(unknown)"}; no verdict.`;
		}
		const t = this.currentTargetBox();
		if (!t) {
			return `${header}\nINVALID: target is outside the viewport under the current camera (scroll it into view and rerun); no verdict.`;
		}
		const backingNow = countPaintedPixels(
			this.committedCtx,
			t.canvas.x,
			t.canvas.y,
			t.canvas.w,
			t.canvas.h,
			this.backingNow()
		);
		if (backingNow <= 0) {
			return `${header}\nINVALID: committed backing has ${backingNow === 0 ? "no pixels" : "unreadable pixels"} at the recomputed target (canvas box ${t.canvas.x.toFixed(0)},${t.canvas.y.toFixed(0)} ${t.canvas.w.toFixed(0)}x${t.canvas.h.toFixed(0)}); no verdict. A repaint may not have run since a camera move. Nudge scroll by one notch and rerun.`;
		}
		const inkRGB = parseHexColor(this.lastCommitColor);
		const cap = await capturePresented(t.client, inkRGB);
		const inkPresent = inkRGB ? cap.inkMatchedPx > 0 : cap.presentedPx > 0;
		const verdict = !cap.ok
			? "NO VERDICT: capture unavailable; census + eyes remain the instruments"
			: !inkPresent
				? "*** VERDICT: BACKING HAS INK, COMPOSITED FRAME DOES NOT. The compositor dropped the layer content (or an exact-background occluder; cross-check census). ***"
				: "*** VERDICT: COMPOSITED FRAME CONTAINS THE INK. If the glass still shows nothing, the loss is BELOW the compositor (DComp/DWM presentation). ***";
		return [
			header,
			`target (current camera)   : canvas (${t.canvas.x.toFixed(0)},${t.canvas.y.toFixed(0)} ${t.canvas.w.toFixed(0)}x${t.canvas.h.toFixed(0)})  client (${t.client.x.toFixed(0)},${t.client.y.toFixed(0)} ${t.client.w.toFixed(0)}x${t.client.h.toFixed(0)})`,
			`committed backing (now)   : ${backingNow} painted px  (VALID target)`,
			`composited frame (capture): ${cap.presentedPx} / ${cap.sampledPx} non-background px, ${cap.inkMatchedPx} matching the stroke's own color ${this.lastCommitColor || "(unknown)"}`,
			`capture detail            : ${cap.detail}`,
			verdict,
		].join("\n");
	}

	/**
	 * The stroke's screen-space bbox (camera frame, CSS px), padded by the
	 * pen width and clamped to the canvas. `clippedPct` is how much of the
	 * padded bbox fell OUTSIDE the canvas, a direct measure of edge
	 * clipping at the viewport boundary.
	 */
	/** Diagnostics-only (explicitly enabled): commit readback + COMMIT row. */
	private recordCommitDiagnostics(
		stroke: InkStroke,
		path: string,
		wetPx: number,
		sample: { x: number; y: number; w: number; h: number; clippedPct: number }
	): void {
		// Paint ground truth, part 2: did the commit draw reach the committed
		// backing store?
		const committedPx = countPaintedPixels(
			this.committedCtxFor(stroke.tool),
			sample.x,
			sample.y,
			sample.w,
			sample.h,
			this.backingNow()
		);
		// Frame-desync measure: the stroke was committed with the PEN-DOWN
		// camera; if the scroller moved during the stroke, a fresh frame
		// differs by exactly the visible snap-back distance.
		const fresh = this.freshFrame();
		scrollProbeCommit({
			strokeId: stroke.id,
			points: stroke.points.length,
			bboxX: stroke.bbox.x,
			bboxY: stroke.bbox.y,
			bboxW: stroke.bbox.width,
			bboxH: stroke.bbox.height,
			visible: bboxVisibleInViewport(
				stroke.bbox,
				this.camera.snapshot,
				this.cssWidth / this.camera.zoom,
				this.cssHeight / this.camera.zoom
			),
			storeCount: inlineInk.strokes(path).length,
			camX: this.camera.x,
			camY: this.camera.y,
			scrollLeft: this.view.scrollDOM.scrollLeft,
			scrollTop: this.view.scrollDOM.scrollTop,
			driftX: fresh ? fresh.x - this.camera.x : 0,
			driftY: fresh ? fresh.y - this.camera.y : 0,
			scrollsDuring: this.scrollsDuringStroke,
			wetPx,
			committedPx,
			sampleW: sample.w,
			sampleH: sample.h,
			clippedPct: sample.clippedPct,
			topEl: this.topElementAtStroke(sample),
		});
	}

	private strokeScreenSample(stroke: InkStroke): {
		x: number;
		y: number;
		w: number;
		h: number;
		clippedPct: number;
	} {
		const pad = 4;
		const z = this.camera.zoom;
		const sx = (stroke.bbox.x - this.camera.x) * z - pad;
		const sy = (stroke.bbox.y - this.camera.y) * z - pad;
		const sw = stroke.bbox.width * z + pad * 2;
		const sh = stroke.bbox.height * z + pad * 2;
		const x = Math.max(0, sx);
		const y = Math.max(0, sy);
		const w = Math.min(this.cssWidth, sx + sw) - x;
		const h = Math.min(this.cssHeight, sy + sh) - y;
		const fullArea = sw * sh;
		const clampedArea = Math.max(0, w) * Math.max(0, h);
		return {
			x,
			y,
			w: Math.max(0, w),
			h: Math.max(0, h),
			clippedPct: fullArea > 0 ? 1 - clampedArea / fullArea : 0,
		};
	}

	/** Top hit-testable element at the stroke sample's center, at commit. */
	private topElementAtStroke(sample: { x: number; y: number; w: number; h: number }): string {
		const cx = this.lastSyncRectLeft + noteToVisual(sample.x + sample.w / 2, this.cssScale);
		const cy = this.lastSyncRectTop + noteToVisual(sample.y + sample.h / 2, this.cssScale);
		try {
			return describeEl(this.view.dom.ownerDocument.elementFromPoint(cx, cy));
		} catch {
			return "(err)";
		}
	}

	// ---- pen probe (spatial/latency diagnosis) --------------------------------

	private captureProbeGeometry(): void {
		const rect = this.container?.getBoundingClientRect();
		setProbeGeometry({
			rectLeft: rect?.left ?? 0,
			rectTop: rect?.top ?? 0,
			scale: this.cssScale,
			dpr: this.dpr,
			backing: this.backingNow(),
			canvasCssW: this.cssWidth,
			canvasCssH: this.cssHeight,
			canvasBackingW: this.committedCanvas?.width ?? 0,
			canvasBackingH: this.committedCanvas?.height ?? 0,
			camX: this.camera.x,
			camY: this.camera.y,
			camZoom: this.camera.zoom,
			contentLeft: this.view.contentDOM.getBoundingClientRect().left,
			documentTop: this.view.documentTop,
			desynchronizedRequested: this.wet?.requested ?? false,
			desynchronizedActual: String(this.wet?.actualDesynchronized),
		});
	}

	/**
	 * Record the newest sample's full chain, and map the DRAWN endpoint back
	 * out to client space so the round-trip error is measured against the real
	 * transforms rather than asserted.
	 */
	private probeSample(
		sample: PenSample,
		ev: PointerEvent,
		point: { x: number; y: number } | undefined,
		coalesced: number,
		accepted: boolean,
		source: "down" | "rawupdate" | "coalesced"
	): void {
		if (!isPenProbeEnabled()) return;
		const rect = this.container?.getBoundingClientRect();
		if (!rect) return;
		const head = this.activeWet?.head();
		// The endpoint actually submitted for drawing. Falls back to the
		// accepted point when the head has not formed yet (first sample).
		const headX = head?.to.x ?? point?.x ?? 0;
		const headY = head?.to.y ?? point?.y ?? 0;
		// …mapped back out through the production camera + scale.
		const screen = this.camera.worldToScreen(headX, headY);
		const backX = rect.left + noteToVisual(screen.x, this.cssScale);
		const backY = rect.top + noteToVisual(screen.y, this.cssScale);
		const noteWorld = this.camera.screenToWorld(sample.x, sample.y);
		// Where the raw pointer itself maps to, for the tip-gap measure.
		const rawScreen = this.camera.worldToScreen(noteWorld.x, noteWorld.y);
		const rawBackX = rect.left + noteToVisual(rawScreen.x, this.cssScale);
		const rawBackY = rect.top + noteToVisual(rawScreen.y, this.cssScale);
		recordProbe({
			at: performance.now(),
			source,
			clientX: ev.clientX,
			clientY: ev.clientY,
			eventTs: ev.timeStamp,
			deliveryAgeMs: performance.now() - ev.timeStamp,
			coalesced,
			accepted,
			noteX: noteWorld.x,
			noteY: noteWorld.y,
			headX,
			headY,
			backX,
			backY,
			// Round-trip fidelity of the raw pointer through every transform.
			errPx: Math.hypot(rawBackX - ev.clientX, rawBackY - ev.clientY),
			// How far the drawn tip sits behind the raw pointer.
			tipGapPx: Math.hypot(backX - ev.clientX, backY - ev.clientY),
		});
		markMappedTip(backX, backY);
	}

	// ---- eraser (canvas semantics: whole-stroke, hit-circle, live) -----------

	/**
	 * Two-finger pinch resizes the editor's base font, which reflows the note.
	 * Ink follows through the font-zoom path the overlay already runs, so
	 * nothing here touches a stored coordinate. The size is always computed
	 * from what was captured at "start", so a pinch out and back lands exactly
	 * where it began.
	 */
	private pinch(
		phase: "start" | "move" | "end",
		ratio: number,
		centroid: { x: number; y: number }
	): void {
		if (phase === "start") {
			this.pinchRefScale = this.pinchScaleNow;
			// The anchor is captured ONCE, here. Every frame of the gesture
			// is then computed from this state, so the view cannot chase the
			// fingers as they drift and rounding cannot accumulate.
			const scroller = this.view.scrollDOM;
			const rect = scroller.getBoundingClientRect();
			this.pinchAnchor = {
				scrollLeft: scroller.scrollLeft,
				scrollTop: scroller.scrollTop,
				offsetX: centroid.x - rect.left,
				offsetY: centroid.y - rect.top,
			};
			return;
		}
		if (phase === "end") {
			this.pinchRefScale = null;
			this.pinchAnchor = null;
			// Nothing may still be queued behind the settle: a live frame
			// running after it would write the mid-gesture styles back.
			if (this.pinchRaf !== 0) {
				this.winRef.cancelAnimationFrame(this.pinchRaf);
				this.pinchRaf = 0;
			}
			// Settle: the box and the ink raster catch up with the final
			// scale, once, where the cost is invisible.
			this.flushPinch(true);
			return;
		}
		if (this.pinchRefScale === null || this.pinchAnchor === null) return;
		const next = pinchScale(this.pinchRefScale, ratio);
		if (next === this.pinchScaleNow) return;
		// Coalesce to one update per FRAME. Two fingers deliver pointermoves
		// faster than the display refreshes, and the work below is not the
		// kind you do twice for one frame.
		this.pinchPending = { next };
		if (this.pinchRaf === 0) {
			this.pinchRaf = this.winRef.requestAnimationFrame(() => {
				this.pinchRaf = 0;
				this.flushPinch(false);
			});
		}
	}

	/**
	 * Apply the pinch that this frame is owed.
	 *
	 * Live frames write ONLY the compositor transform and the anchored scroll.
	 * The expensive half - resizing the counter-scaled box, which reflows the
	 * whole editor, and `handleResize`, which reallocates the canvases and
	 * re-rasterizes every stroke - waits for the fingers to leave.
	 *
	 * Doing all of it per pointermove is what made the gesture jagged and
	 * laggy on hardware (alan, 2026-08-27): a forced layout read, a full
	 * editor reflow and a complete ink re-raster, several times per frame.
	 * The cost of deferring is that the ink is a scaled raster mid-gesture -
	 * very slightly soft until release, which is what every canvas app does
	 * and what the eye forgives; a stuttering pinch is not.
	 */
	private flushPinch(settle: boolean): void {
		if (!this.container) return;
		const pending = this.pinchPending;
		this.pinchPending = null;
		if (!pending && !settle) return;
		if (pending) this.applyPinchScale(pending.next, settle);
		else if (settle) this.settlePinchRaster();
	}

	/**
	 * Magnify this editor, anchored under the fingers.
	 *
	 * The transform goes on the element the overlay hangs off, so text, ink and
	 * the overlay itself scale as one object and no stored coordinate moves.
	 * The overlay picks the new scale up on its own: `effectiveScale` measures
	 * painted width against layout width, which is exactly what a transform
	 * changes. Sizing the box to 100/k percent first keeps the painted result
	 * filling the pane instead of hanging outside it.
	 */
	private applyPinchScale(next: number, settle: boolean): void {
		const anchor = this.pinchAnchor;
		if (!anchor) return;
		const host = this.view.dom;
		const scroller = this.view.scrollDOM;
		// Both scales come from the GESTURE, not from the previous frame: the
		// reference the gesture started at, and where it is being asked to go.
		const from = this.pinchRefScale ?? this.pinchScaleNow;
		const nextLeft = anchoredScroll(anchor.scrollLeft, anchor.offsetX, from, next);
		const nextTop = anchoredScroll(anchor.scrollTop, anchor.offsetY, from, next);

		this.pinchScaleNow = next;
		// Transform ONLY - never width or height. The counter-sized box made
		// the text re-wrap while zooming (words changed lines while the
		// world-anchored ink stayed put), and the re-wrap is a full document
		// reflow, which is why every variant of it was laggy. A magnified
		// note keeps its exact layout: lines overhang the pane and the
		// scroller reaches them, the same as any canvas or pdf viewer. The
		// transform is compositor work, so the live gesture costs nothing.
		if (next === 1) {
			host.style.removeProperty("transform");
			host.style.removeProperty("transform-origin");
		} else {
			host.setCssStyles({ transform: `scale(${next})`, transformOrigin: "0 0" });
		}
		scroller.scrollLeft = nextLeft;
		scroller.scrollTop = nextTop;
		// Stamp AFTER the writes: the scroll events they queue are the ones
		// the handler above should let pass without a repaint.
		this.pinchScrollAt = performance.now();
		// The measured scale changed, so the ink geometry has to be rebuilt at
		// the new backing resolution - but only once the fingers are gone.
		if (settle) this.settlePinchRaster();
	}

	/**
	 * Pinch over: re-raster the ink crisply at the final scale. A no-op when
	 * nothing changed since the last raster, because `handleResize`
	 * reallocates both committed canvases and redraws every stroke - too
	 * much to spend on a two-finger settle that crossed the slop and
	 * changed nothing.
	 */
	private settlePinchRaster(): void {
		if (this.pinchScaleNow === this.pinchRasterScale) return;
		this.pinchRasterScale = this.pinchScaleNow;
		this.handleResize();
	}

	private showPenCursor(sample: PenSample): void {
		markPenSeen();
		this.ensurePenTools();
		// Reticle off: the native cursor stays, so no hover class either.
		if (!penReticleOn) return;
		if (!this.penCursorEl) return;
		// Every branch below returns, so the watchdog is armed here, once.
		this.armHoverWatchdog();
		this.view.scrollDOM.classList.add(PEN_HOVER_CLASS);
		// In eraser mode the nib width is a lie: what the tip is about to do
		// is bounded by the eraser radius, so the reticle shows THAT. Radius
		// is screen-space (same physical size at any zoom), like the eraser
		// cursor that follows a live erase.
		if (tipMode() === "eraser") {
			const r = visualToNote(inlineEraserRadiusPx, this.cssScale);
			this.penCursorEl.classList.remove(LASSO_CURSOR_CLASS);
			this.penCursorEl.classList.remove(SPACE_CURSOR_CLASS);
			this.penCursorEl.classList.remove(PAN_CURSOR_CLASS);
			this.penCursorEl.classList.add(ERASER_CURSOR_CLASS);
			this.penCursorEl.setCssStyles({
				display: "block",
				width: `${r * 2}px`,
				height: `${r * 2}px`,
				transform: `translate(${sample.x - r}px, ${sample.y - r}px)`,
				backgroundColor: "transparent",
				opacity: "1",
			});
			return;
		}
		this.penCursorEl.classList.remove(ERASER_CURSOR_CLASS);
		// Lasso mode: the nib is about to select, and the reticle says so - a
		// dashed ring, fixed size, visually distinct from both nib and eraser.
		if (tipMode() === "lasso") {
			const r = visualToNote(9, this.cssScale);
			this.penCursorEl.classList.remove(SPACE_CURSOR_CLASS);
			this.penCursorEl.classList.remove(PAN_CURSOR_CLASS);
			this.penCursorEl.classList.add(LASSO_CURSOR_CLASS);
			this.penCursorEl.setCssStyles({
				display: "block",
				width: `${r * 2}px`,
				height: `${r * 2}px`,
				transform: `translate(${sample.x - r}px, ${sample.y - r}px)`,
				backgroundColor: "transparent",
				opacity: "1",
			});
			return;
		}
		this.penCursorEl.classList.remove(LASSO_CURSOR_CLASS);
		// Insert-space mode: the reticle IS the divider, in miniature - a
		// short dashed rule lying where the seam would be planted. The nib
		// dot would say "pen" for a tip that is about to move rows instead.
		if (tipMode() === "space") {
			const half = visualToNote(24, this.cssScale);
			this.penCursorEl.classList.add(SPACE_CURSOR_CLASS);
			this.penCursorEl.setCssStyles({
				display: "block",
				width: `${half * 2}px`,
				height: "0px",
				transform: `translate(${sample.x - half}px, ${sample.y}px)`,
				backgroundColor: "transparent",
				opacity: "1",
			});
			return;
		}
		this.penCursorEl.classList.remove(SPACE_CURSOR_CLASS);
		// Pan mode: a solid ring, the one reticle that is not dashed, so the
		// tip reads as "grab" rather than as any of the marking tools.
		if (tipMode() === "pan") {
			const r = visualToNote(11, this.cssScale);
			this.penCursorEl.classList.add(PAN_CURSOR_CLASS);
			this.penCursorEl.setCssStyles({
				display: "block",
				width: `${r * 2}px`,
				height: `${r * 2}px`,
				transform: `translate(${sample.x - r}px, ${sample.y - r}px)`,
				backgroundColor: "transparent",
				opacity: "1",
			});
			return;
		}
		this.penCursorEl.classList.remove(PAN_CURSOR_CLASS);
		const tool = inlineTool;
		const strokeWidth =
			(tool === "highlighter" ? HIGHLIGHTER_PEN.baseWidth : DEFAULT_PEN.baseWidth) *
			getInkSizeMult(tool);
		const cursor = penCursorLayout({
			x: sample.x,
			y: sample.y,
			strokeWidth,
			cameraZoom: this.camera.zoom,
			cssScale: this.cssScale,
		});
		this.penCursorEl.setCssStyles({
			display: "block",
			width: `${cursor.diameter}px`,
			height: `${cursor.diameter}px`,
			transform: `translate(${cursor.x}px, ${cursor.y}px)`,
			backgroundColor: getInkColorHex(tool),
			opacity: tool === "highlighter" ? String(HIGHLIGHTER_ALPHA) : "0.9",
		});
	}

	private hidePenCursor(): void {
		this.clearHoverWatchdog();
		this.view.scrollDOM.classList.remove(PEN_HOVER_CLASS);
		if (this.penCursorEl) this.penCursorEl.setCssStyles({ display: "none" });
	}

	/**
	 * The reticle is shown from hover samples and hidden from `pointerleave`.
	 * A pen that leaves HOVER RANGE without leaving the element may never send
	 * one - digitizers differ - and the reticle is then simply left on screen.
	 *
	 * It became visible when the overlay moved inside the scroller: a stale
	 * reticle used to sit at a fixed screen position, and now it is glued to
	 * the document and scrolls along with the text, which reads as a mark ON
	 * the page (alan, hardware). The staleness was always there; the band just
	 * stopped hiding it.
	 *
	 * So the reticle stops depending on an event that may never arrive. A
	 * second is far longer than the gap between samples from a hand-held pen -
	 * a hand is never still - so this only ever fires once the pen is really
	 * gone, and the next hover sample brings it straight back.
	 */
	private armHoverWatchdog(): void {
		this.clearHoverWatchdog();
		this.hoverWatchdog = this.winRef.setTimeout(() => {
			this.hoverWatchdog = null;
			this.hidePenCursor();
		}, HOVER_GHOST_MS);
	}

	private clearHoverWatchdog(): void {
		if (this.hoverWatchdog === null) return;
		this.winRef.clearTimeout(this.hoverWatchdog);
		this.hoverWatchdog = null;
	}

	/**
	 * Feed StrokeMetrics.recordFrame while a stroke is live.
	 *
	 * That recorder had exactly ONE caller - the canvas page view's ticker -
	 * so every stroke drawn in a note reported `frame 0/0ms`. Not "the frames
	 * were perfect": nothing ever measured them. It cost a flicker hunt the
	 * one number that would have located it (alan, hardware, 2026-08-30).
	 *
	 * Runs only between pen-down and pen-up, and does nothing per frame but
	 * read a timestamp, so the latency path pays a rAF callback and no work.
	 */
	private startFrameTicker(): void {
		if (this.frameTicking) return;
		this.frameTicking = true;
		const tick = (ts: number): void => {
			if (!this.frameTicking) return;
			metrics.recordFrame(ts);
			this.winRef.requestAnimationFrame(tick);
		};
		this.winRef.requestAnimationFrame(tick);
	}

	private stopFrameTicker(): void {
		this.frameTicking = false;
	}

	/**
	 * The strokes an eraser circle at world `w`, radius `r`, could touch
	 * (design doc §5 C1, 2026-09-02).
	 *
	 * eraseAt used to hit-test `inlineInk.strokes(path)` - the whole note,
	 * every stroke, on every pointer sample - and the erase paths marked the
	 * index dirty after each sample, so a drag ALSO rebuilt the whole index
	 * once per frame. Querying the index instead was not possible while it
	 * was stale between samples: a piece made earlier in the same gesture
	 * was missing from it, and a stroke taken earlier was still in it. It is
	 * now kept exact by strokeIndex.remove/insertLike at the takeLive and
	 * applyAddLive sites in eraseAt, so the only rebuild left is the one
	 * that settles a load or a paste which dirtied the index since the last
	 * repaint - at most once per gesture, at pen-down.
	 */
	private eraseCandidates(w: { x: number; y: number }, r: number): readonly InkStroke[] {
		if (this.indexDirty) {
			const path = this.filePath();
			this.strokeIndex.rebuild(path ? inlineInk.strokes(path) : []);
			this.indexDirty = false;
		}
		return this.strokeIndex.query(eraserRect(w.x, w.y, r));
	}

	private eraseAt(sample: PenSample): void {
		const path = this.filePath();
		if (!path) return;
		const w = this.camera.screenToWorld(sample.x, sample.y);
		const r = visualToNote(inlineEraserRadiusPx, this.scale);
		const hits = strokesHitByCircle(this.eraseCandidates(w, r), w.x, w.y, r);
		if (hits.length === 0) return;
		if (this.eraseWhole) {
			// Contact deletes the stroke, no split - v0.13.12's behavior,
			// back by request as a setting.
			for (const { stroke, index } of inlineInk.takeLive(path, hits)) {
				if (!this.erasePieces.delete(stroke.id)) {
					this.erased.push({ stroke, index });
				}
				this.damage.addRect(stroke.bbox);
				this.strokeIndex.remove(stroke);
			}
			this.scheduleRepaint("partial");
			this.repaintPath(path);
			return;
		}
		// Partial erase: the ring takes what it covers and the rest of the
		// stroke stays. Each stroke comes out and its survivors go back in at
		// the same position, so z-order holds.
		for (const { stroke, index } of inlineInk.takeLive(path, hits)) {
			this.damage.addRect(stroke.bbox);
			this.strokeIndex.remove(stroke);
			const pieces = splitStrokeByCircle(stroke, w.x, w.y, r, newStrokeId);
			if (pieces.length === 1 && pieces[0] === stroke) {
				// Hit by the bbox-then-segment test but the ring never crossed
				// the line itself. Put it back exactly as it was.
				inlineInk.applyAddLive(path, [stroke], [index]);
				this.strokeIndex.insertLike(stroke, stroke);
				continue;
			}
			if (!this.erasePieces.delete(stroke.id)) {
				this.erased.push({ stroke, index });
			}
			if (pieces.length > 0) {
				inlineInk.applyAddLive(path, pieces, pieces.map((_, i) => index + i));
				for (const piece of pieces) this.erasePieces.add(piece.id);
				for (const piece of pieces) this.strokeIndex.insertLike(piece, stroke);
			}
		}
		// Batched to the next frame, exactly like the canvas eraser.
		this.scheduleRepaint("partial");
		this.repaintPath(path);
	}

	private showEraserCursor(sample: PenSample): void {
		if (!this.eraserEl) return;
		// Screen-space element: convert the visual constant with cssScale
		// only (samples are screen css px).
		const r = visualToNote(inlineEraserRadiusPx, this.cssScale);
		this.eraserEl.setCssStyles({
			display: "block",
			width: `${r * 2}px`,
			height: `${r * 2}px`,
			transform: `translate(${sample.x - r}px, ${sample.y - r}px)`,
		});
	}

	private hideEraserCursor(): void {
		if (this.eraserEl) this.eraserEl.setCssStyles({ display: "none" });
	}

	// ---- lasso / move (side button held; §52/§53, ink-only on the inline surface) --

	private strokesHere(): readonly InkStroke[] {
		const path = this.filePath();
		return path ? inlineInk.strokes(path) : [];
	}

	private selectionBounds(): BBox | null {
		return this.selection.bounds(this.strokesHere(), () => null, () => null);
	}

	private lassoDown(sample: PenSample): void {
		const w = this.camera.screenToWorld(sample.x, sample.y);
		const bounds = this.selectionBounds();
		// Landing inside an existing selection moves it; anywhere else lassos.
		if (
			bounds &&
			pointInBBox(w.x, w.y, padBBox(bounds, visualToNote(SELECTION_GRAB_PAD, this.scale)))
		) {
			this.dragFrom = { x: w.x, y: w.y };
			this.dragTotal = { dx: 0, dy: 0 };
			return;
		}
		this.selection.clear();
		this.lassoActive = true;
		this.lassoPts = [w];
		this.redrawSelectionUI();
	}

	private lassoMove(samples: PenSample[]): void {
		const last = samples[samples.length - 1];
		if (!last) return;

		if (this.dragFrom && this.dragTotal) {
			const path = this.filePath();
			if (!path) return;
			const w = this.camera.screenToWorld(last.x, last.y);
			const dx = w.x - this.dragFrom.x;
			const dy = w.y - this.dragFrom.y;
			// Live drag only translates coordinates in the store; the history
			// op is pushed once at release, with the id list frozen there.
			const before = this.selectionBounds();
			inlineInk.moveStrokes(path, this.selection.strokeIds, dx, dy);
			this.dragTotal.dx += dx;
			this.dragTotal.dy += dy;
			this.dragFrom = w;
			if (before) {
				this.damage.addRect(before);
				this.damage.addRect({ x: before.x + dx, y: before.y + dy, width: before.width, height: before.height });
			} else {
				this.damage.addAll();
			}
			this.indexDirty = true;
			this.scheduleRepaint("partial");
			this.repaintPath(path);
			this.redrawSelectionUI();
			return;
		}

		if (!this.lassoActive) return;
		const minStep = visualToNote(LASSO_MIN_STEP_PX, this.scale);
		for (const sample of samples) {
			const p = this.camera.screenToWorld(sample.x, sample.y);
			const prev = this.lassoPts[this.lassoPts.length - 1];
			if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) >= minStep) {
				this.lassoPts.push(p);
			}
		}
		this.redrawSelectionUI();
	}

	private lassoUp(): void {
		if (this.dragTotal) {
			const { dx, dy } = this.dragTotal;
			this.dragFrom = null;
			this.dragTotal = null;
			const path = this.filePath();
			if (path && (dx !== 0 || dy !== 0)) {
				// The op freezes WHICH strokes moved. An old move must never
				// later act on whatever happens to be selected.
				const strokeIds = [...this.selection.strokeIds];
				inlineInk.save(path);
				this.dispatchInk({ type: "move", path, strokeIds, dx, dy });
				// A move changes no stroke COUNT, so the cache's cheap guard
				// cannot see it. §5g/G1.
				this.frontierCache.invalidate(path);
			}
			this.redrawSelectionUI();
			return;
		}
		this.lassoActive = false;
		this.selection.selectByLasso(this.lassoPts, this.strokesHere(), [], () => null);
		this.lassoPts = [];
		this.redrawSelectionUI();
	}

	// ---- pan (the tip drags the view; no ink, no history) --------------------

	/**
	 * Drag the scroller by the pen's travel. Client coordinates, like the
	 * touch assist pan: they are viewport-absolute, so scrolling the surface
	 * cannot feed back into the next delta the way overlay-relative ones
	 * would (the page would accelerate away under the nib).
	 */
	private panMove(ev: PointerEvent): void {
		const last = this.panLast;
		if (!last) return;
		const dx = ev.clientX - last.x;
		const dy = ev.clientY - last.y;
		if (dx === 0 && dy === 0) return;
		this.panLast = { x: ev.clientX, y: ev.clientY };
		const el = this.view.scrollDOM;
		el.scrollLeft -= dx;
		el.scrollTop -= dy;
	}

	// ---- insert space (divider gesture: ink below the line follows the pen) --

	private spaceDown(sample: PenSample, ev: PointerEvent): void {
		const w = this.camera.screenToWorld(sample.x, sample.y);
		const here = this.strokesHere();
		// Snap out of any row the line was drawn through, and DRAW it where it
		// snapped: the seam the gesture will actually cut at is the one worth
		// showing, and seeing it jump into the gap is how the rule explains
		// itself without a word of documentation.
		const cut = snapLine(rowsOf(here), w.y);
		this.spaceLineY = cut;
		this.spaceFromY = w.y;
		this.spaceTotalDy = 0;
		// The id list freezes at pen-down, and so does the box around it:
		// membership cannot change mid-drag, so the damage region is just
		// that box swept by the distance travelled.
		this.spaceIds = strokeIdsBelow(here, w.y);
		this.spaceBounds = boundsOf(here, this.spaceIds);
		// The contact's CLIENT point, kept as-is: the editor can turn that
		// into a document position exactly, with no world-to-viewport
		// conversion of ours to drift out of step with the camera.
		this.spaceClient = { x: ev.clientX, y: ev.clientY };
		if (this.spaceIds.length === 0) {
			// A gesture that moves nothing is indistinguishable from a broken
			// one - it cost an evening of hardware testing to learn that once.
			new Notice("Handwriting: no ink below the line");
		}
		this.redrawSelectionUI();
	}

	private spaceMove(samples: PenSample[]): void {
		const last = samples[samples.length - 1];
		if (!last || this.spaceLineY === null) return;
		const path = this.filePath();
		if (!path) return;
		const w = this.camera.screenToWorld(last.x, last.y);
		const dy = w.y - this.spaceFromY;
		if (dy === 0) return;
		// Live drag only translates coordinates in the store; the history op
		// is pushed once at release with the total (the lasso drag's shape).
		// Vertical only: the divider is a seam, not a joystick.
		inlineInk.moveStrokes(path, this.spaceIds, 0, dy);
		this.spaceTotalDy += dy;
		this.spaceFromY = w.y;
		// The line rides with the pen, leading the ink it is pushing: it stays
		// under the nib all through the drag, so the gesture reads as shoving a
		// seam down the page rather than watching a mark sit still.
		if (this.spaceLineY !== null) this.spaceLineY += dy;
		// Damage the swept band only. Marking the whole page dirty per frame
		// re-rasterized every stroke in the note and the drag went jagged on
		// a full page; the moved ink is one contiguous band moving straight
		// down, so one rect covers where it was and where it landed.
		if (this.spaceBounds) {
			this.damage.addRect(sweptRect(this.spaceBounds, dy));
			this.spaceBounds = { ...this.spaceBounds, y: this.spaceBounds.y + dy };
		} else {
			this.damage.addAll();
		}
		this.indexDirty = true;
		this.scheduleRepaint("partial");
		this.repaintPath(path);
		this.redrawSelectionUI();
	}

	private spaceUp(): void {
		const path = this.filePath();
		const applied = this.spaceTotalDy;
		const strokeIds = this.spaceIds;
		const client = this.spaceClient;
		this.spaceLineY = null;
		this.spaceIds = [];
		this.spaceBounds = null;
		this.spaceClient = null;
		this.spaceTotalDy = 0;
		if (!path || applied === 0 || strokeIds.length === 0) {
			this.redrawSelectionUI();
			return;
		}
		// Open (or close) the same distance in the TEXT, so the note keeps
		// its shape instead of the ink sliding off the words it belongs to.
		// Both halves ride one transaction: undo puts the lines and the ink
		// back together, which is the only way this can be reversible.
		// The TEXT is authoritative. Whatever the text could not do, the ink
		// does not do either: a drag under half a line, or an upward drag over
		// writing that must not be deleted, settles back to zero rather than
		// leaving the ink permanently offset from the line it belongs to -
		// which is the one thing this gesture exists to prevent.
		const change = this.spaceTextChange(client, applied);
		const dy = change.dy;
		const correction = dy - applied;
		if (correction !== 0) inlineInk.moveStrokes(path, strokeIds, 0, correction);
		if (dy === 0) {
			// Nothing moved in the end, and the correction above already put
			// the live drag back: no op worth recording.
			this.scheduleRepaint();
			this.repaintPath(path);
			this.redrawSelectionUI();
			return;
		}
		inlineInk.save(path);
		const op: InkOp = { type: "move", path, strokeIds, dx: 0, dy };
		try {
			this.view.dispatch({
				changes: change.changes ?? undefined,
				effects: inkEffect.of(op),
				annotations: [inkApplied.of(true), isolateHistory.of("full")],
			});
		} catch (err) {
			console.error("[handwriting] insert-space dispatch failed", err);
		}
		this.scheduleRepaint();
		this.repaintPath(path);
		this.redrawSelectionUI();
	}

	/**
	 * The document edit that matches a drag of `applied` note units: blank
	 * lines inserted at the divider, or blank ones taken back when the drag
	 * closed a gap. Returns the SNAPPED distance too, because the ink has to
	 * land on the same whole number of lines the text just moved by.
	 *
	 * Null when there is nothing honest to do - no contact point, a drag
	 * shorter than half a line, or a close-up drag over text that is not
	 * blank. In every one of those the ink still moves; only the text is
	 * left alone.
	 */
	private spaceTextChange(
		client: { x: number; y: number } | null,
		applied: number
	): { changes: { from: number; to: number; insert: string } | null; dy: number } {
		const none = { changes: null, dy: 0 };
		if (!client) return none;
		const lineHeight = visualToNote(this.view.defaultLineHeight, this.scale);
		const steps = lineSteps(applied, lineHeight);
		if (steps === 0) return none;
		const pos = this.view.posAtCoords(client);
		if (pos === null) return none;
		const doc = this.view.state.doc;
		const line = doc.lineAt(pos);
		if (steps > 0) {
			return {
				changes: { from: line.from, to: line.from, insert: "\n".repeat(steps) },
				dy: steps * lineHeight,
			};
		}
		// Closing up: take back only blank lines, never a word of writing.
		const removable = blankLinesAbove((n) => doc.line(n).text, line.number, -steps);
		if (removable === 0) return none;
		const first = doc.line(line.number - removable);
		return {
			changes: { from: first.from, to: line.from, insert: "" },
			dy: -removable * lineHeight,
		};
	}

	/** Move this editor's strip to the configured corner. */
	applyToolbarCorner(): void {
		this.mobileTools?.setCorner(toolbarCorner);
	}

	/** The strip's active-tool marks are stale; recompute them. */
	refreshStrip(): void {
		this.mobileTools?.refresh();
	}

	/**
	 * A TOOL change puts a selection away too, not just the next contact.
	 * Design §5o: leaving a lasso outline live after the strip's tool
	 * changed read as "the lasso selector remains" (Alan, device finding
	 * 2026-09-02). Exact idiom as the pen-contact clear at `:1919-1920`.
	 */
	dissolveSelection(): void {
		if (this.selection.clear()) this.redrawSelectionUI();
	}

	private redrawSelectionUI(): void {
		if (!this.tail) return;
		this.tail.clearAll(this.cssWidth, this.cssHeight);
		const cam = this.camera.snapshot;
		if (this.lassoActive && this.lassoPts.length > 1) {
			this.tail.drawLasso(cam, this.lassoPts, SELECTION_COLOR);
		}
		if (this.spaceLineY !== null) {
			this.tail.drawSpaceDivider(cam, this.spaceLineY, SELECTION_COLOR, this.cssWidth);
		}
		const bounds = this.selectionBounds();
		if (bounds) this.tail.drawSelectionBox(cam, bounds, SELECTION_COLOR);
		// A repaint can land mid-stroke - a scroll, an external reload, damage
		// from an erase elsewhere. clearAll above takes the live head with it,
		// and the head is the lag-free tip: erasing it until the next pointer
		// event is a blink at exactly the place the eye is resting.
		const head = this.builder ? this.activeWet.head() : undefined;
		if (head) this.tail.drawHead(cam, this.activeStyle, head.from, head.to, head.pressure);
	}

	private resetGestureState(): void {
		// Lifecycle rule (v0.13.6 fix): every gesture-state reset releases the
		// stroke frame lock. File switch and unmount reach here mid-stroke;
		// leaving the lock held froze the NEXT note's camera and repaints
		// until its first pen-down. A cancelled frame never leaks forward.
		this.frame.cancel();
		this.builder = null;
		this.mode = "ink";
		this.erased = [];
		this.selection.clear();
		this.lassoPts = [];
		this.lassoActive = false;
		this.dragFrom = null;
		this.dragTotal = null;
		this.spaceLineY = null;
		this.spaceIds = [];
		this.spaceBounds = null;
		this.spaceClient = null;
		this.spaceTotalDy = 0;
		this.panLast = null;
		this.selectionDeleteKeys.reset();
		this.hidePenCursor();
		this.hideEraserCursor();
	}

	// ---- history --------------------------------------------------------------

	/**
	 * Wipe every committed stroke on this editor's note as ONE undoable
	 * history op (the delete-all command). Same machinery as an erase: the
	 * store change is applied directly, the op captures the full strokes and
	 * indices, and undo restores everything in original z-order. The caller
	 * (main.ts) has already made the .handwriting/trash/ safety copy.
	 */
	clearAllInk(path: string): number | null {
		if (this.filePath() !== path) return null;
		const strokes = [...inlineInk.strokes(path)];
		if (strokes.length === 0) return 0;
		const indices = strokes.map((_, i) => i);
		inlineInk.applyRemove(
			path,
			strokes.map((s) => s.id)
		);
		this.dispatchInk({ type: "remove", path, strokes, indices });
		this.selection.clear();
		this.scheduleRepaint();
		this.repaintPath(path);
		return strokes.length;
	}

	/**
	 * Copy the lasso selection to the session ink clipboard (roadmap:
	 * copy/paste ink). Returns how many strokes were copied; 0 = no selection.
	 */
	/**
	 * The lassoed region as a PNG: ink on white, cropped to the selection
	 * plus a little air. The pdf surface composites the page under its
	 * strokes; a note's ground is live editor DOM, which is not honestly
	 * rasterizable, so this is the drawing alone - the same bargain the SVG
	 * export states. Same crop math and area cap as the pdf snip, so the
	 * two commands cannot drift apart in kind.
	 */
	async snipSelection(): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }> {
		if (this.selection.isEmpty) return { ok: false, reason: "nothing is selected to snip" };
		const bounds = this.selectionBounds();
		if (!bounds) return { ok: false, reason: "nothing is selected to snip" };
		const strokes = this.strokesHere();
		const pxPerWorld = this.winRef.devicePixelRatio || 1;
		// No page to clamp to: a note's canvas is as big as its ink.
		const vp = snipViewport(bounds, 8, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, pxPerWorld, NOTE_SNIP_CAP_PX);
		if (!vp) return { ok: false, reason: "the selection could not be framed" };
		const out = createEl("canvas");
		try {
			out.width = Math.max(1, Math.round((vp.x1 - vp.x0) * vp.scale));
			out.height = Math.max(1, Math.round((vp.y1 - vp.y0) * vp.scale));
			const ctx = out.getContext("2d");
			if (!ctx) return { ok: false, reason: "the image could not be drawn" };
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, out.width, out.height);
			ctx.setTransform(1, 0, 0, 1, -vp.x0 * vp.scale, -vp.y0 * vp.scale);
			const cam = { x: 0, y: 0, zoom: vp.scale };
			// The pdf snip's layering exactly: highlighter as a wash under
			// the pen, both from committed geometry.
			ctx.globalAlpha = 0.35;
			for (const st of strokes) if (st.tool === "highlighter") drawStroke(ctx, cam, st, undefined, true);
			ctx.globalAlpha = 1;
			for (const st of strokes) if (st.tool !== "highlighter") drawStroke(ctx, cam, st, undefined, true);
			const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"));
			if (!blob) return { ok: false, reason: "the image could not be encoded" };
			return { ok: true, bytes: new Uint8Array(await blob.arrayBuffer()) };
		} finally {
			out.width = 0;
			out.height = 0;
		}
	}

	/** Whether the lasso currently holds anything, for command gating. */
	get hasSelection(): boolean {
		return !this.selection.isEmpty;
	}

	copySelectedInk(): number {
		const path = this.filePath();
		if (!path || this.selection.isEmpty) return 0;
		const ids = new Set(this.selection.strokeIds);
		const strokes = this.strokesHere().filter((s) => ids.has(s.id));
		const n = copyInk(strokes, path);
		if (n > 0) publishInkMarker();
		return n;
	}

	/** Copy, then delete as one normal history step. Returns the count. */
	cutSelectedInk(): number {
		const n = this.copySelectedInk();
		if (n > 0) this.deleteSelectedInk();
		return n;
	}

	/**
	 * Paste the clipboard into this note as one history step. Coordinates
	 * are kept (fixed grid); pastes into the source note stagger. Returns
	 * how many strokes landed.
	 */
	pasteInkHere(): number {
		const path = this.filePath();
		if (!path || clipboardSize() === 0) return 0;
		const strokes = pasteInk(path);
		if (strokes.length === 0) return 0;
		inlineInk.applyAdd(path, strokes);
		inlineInk.save(path);
		this.dispatchInk({ type: "add", path, strokes });
		this.scheduleRepaint();
		this.repaintPath(path);
		// Seamlessness: what was pasted is SELECTED, so it is visible and
		// movable at once - and if the fixed-grid coordinates put it outside
		// the viewport, scroll to it rather than pasting into the void.
		this.selection.selectExactly(strokes.map((st) => st.id));
		this.redrawSelectionUI();
		const bounds = this.selectionBounds();
		if (bounds) {
			const cam = this.camera.snapshot;
			const topY = (bounds.y - cam.y) * cam.zoom;
			const viewH = this.view.scrollDOM.clientHeight;
			if (topY < 0 || topY > viewH - 40) {
				this.view.scrollDOM.scrollTop += topY - Math.min(120, viewH / 4);
			}
		}
		this.mobileTools?.refresh();
		return strokes.length;
	}

	/**
	 * Delete the current lasso selection as one normal editor-history step.
	 * Returns how many strokes went, so callers can say "nothing selected".
	 */
	deleteSelectedInk(): number {
		const path = this.filePath();
		if (!path) return 0;
		const n = this.selection.strokeIds.length;
		const op = removeSelectedInlineStrokes(inlineInk, path, this.selection.strokeIds);
		this.selection.clear();
		this.redrawSelectionUI();
		if (!op) return 0;
		this.dispatchInk(op);
		this.scheduleRepaint();
		this.repaintPath(path);
		return n;
	}

	/**
	 * Record a finished gesture in the EDITOR's history, so unmodified Ctrl+Z /
	 * Redo covers ink in chronological order with text edits. The store
	 * already reflects the gesture (inkApplied), and isolateHistory keeps
	 * each gesture its own undo step; strokes never merge into one entry.
	 */
	private dispatchInk(op: InkOp): void {
		// Stamp the note's IDENTITY on the way into the editor's history. The
		// op outlives the path it was recorded at: the view keeps its history
		// across a rename, and an undo afterwards named a path nothing lives
		// at any more. See InkOpIdentity.
		if (op.pageId === undefined) {
			const id = inlineInk.pageIdOf(op.path);
			if (id) op = { ...op, pageId: id };
		}
		try {
			this.view.dispatch({
				effects: inkEffect.of(op),
				annotations: [inkApplied.of(true), isolateHistory.of("full")],
			});
		} catch (err) {
			console.error("[handwriting] ink history dispatch failed", err);
		}
	}

	/**
	 * Where an op from the editor's history should land now.
	 *
	 * Not `op.path`: the view survives a rename with its history intact, so
	 * an op recorded before one names the old location. Applying it there put
	 * the ink into a record for a path nothing lives at - and a note later
	 * created at that name inherited it. The page id is in the file and does
	 * not move, so it answers correctly across any number of renames.
	 *
	 * Null means "do not apply": the op knows which note it belongs to and
	 * that note is not open, so there is nothing to apply it to and guessing
	 * by path is how the ink ends up somewhere else.
	 */
	private opPath(op: InkOp): string | null {
		if (op.pageId === undefined) return op.path; // unclaimed, or recorded by an older build
		return inlineInk.pathForPageId(op.pageId);
	}

	/** Undo/redo handed us an op: apply it to the store and persist. */
	private applyInkOp(op: InkOp): void {
		const path = this.opPath(op);
		if (path === null) return;
		if (path !== op.path) op = { ...op, path };
		switch (op.type) {
			case "add":
				inlineInk.applyAdd(op.path, op.strokes, op.indices);
				// applyAdd is silent by design (erase hot path); an undone
				// remove is a gesture boundary, so the embeds hear it here.
				notifyInkChanged(op.path);
				break;
			case "remove":
				inlineInk.applyRemove(op.path, op.strokes.map((s) => s.id));
				break;
			case "move":
				inlineInk.moveStrokes(op.path, op.strokeIds, op.dx, op.dy);
				inlineInk.save(op.path);
				break;
			case "replace":
				// Order matters: take the old ones out before putting the new
				// ones back at their recorded positions, or the indices the op
				// carries describe a list that no longer exists.
				inlineInk.applyRemove(op.path, op.removed.map((st) => st.id));
				inlineInk.applyAdd(op.path, op.inserted, op.insertedAt);
				break;
		}
		const current = this.filePath();
		if (current === op.path) {
			this.selection.prune(
				new Set(inlineInk.strokes(current).map((s) => s.id)),
				new Set(),
				new Set()
			);
		}
		this.scheduleRepaint();
		this.repaintPath(op.path);
	}



	/** Repaint every OTHER pane showing this note (ink belongs to the note). */
	private repaintPath(path: string): void {
		for (const p of instances) {
			if (p !== this && p.filePath() === path) p.scheduleRepaint();
		}
	}

	// ---- committed repaint --------------------------------------------------

	scheduleRepaint(via = "other"): void {
		// Meaning is unchanged for every caller except the two hot paths:
		// "scroll" means only the camera moved (repaint blits and renders
		// the exposed bands), "partial" means the caller already added its
		// own damage rects. Everything else still repaints the world.
		if (via !== "scroll" && via !== "partial") {
			this.damage.addAll();
			this.indexDirty = true;
		}
		if (this.repaintQueued || !this.container) return;
		this.repaintQueued = true;
		scrollProbeSchedule(via);
		this.winRef.requestAnimationFrame(() => {
			this.repaintQueued = false;
			this.repaint();
		});
	}

	/** The committed layer a finished stroke belongs to. */
	private committedCtxFor(tool: InkTool): CanvasRenderingContext2D {
		return tool === "highlighter" ? this.highlightCtx : this.committedCtx;
	}

	private repaint(): void {
		if (!this.container) return;
		if ((this.winRef.devicePixelRatio || 1) !== this.dpr) {
			this.handleResize();
			return;
		}
		// Position, then measure, then draw - all inside this one frame. That
		// ordering is what makes the ink's position independent of timing: a
		// late repaint costs coverage at a band edge, never a displacement.
		// A resize reallocates the backings and repaints synchronously, so
		// this frame's work is done there; carrying on would paint twice at
		// the same camera. Same shape as the dpr check above.
		if (this.syncBand() === "resized") {
			this.handleResize();
			return;
		}
		this.syncCamera();
		const path = this.filePath();
		const strokes = path ? inlineInk.strokes(path) : [];
		const cam = this.camera.snapshot;
		const last = this.lastPaintCam;
		let work: "all" | BBox[] = this.damage.take();
		// Any camera motion is a full repaint. A blit was tried and pulled
		// the same night: camera deltas are fractional css px, and a
		// fractional drawImage resamples the whole layer soft for a frame -
		// strokes "flickered" right after the micro-scroll that follows a
		// pen-up. The partial path is for damage while the camera is STILL,
		// which is where the actual cost lived (erase frames, drag frames).
		if (last === null || last.zoom !== cam.zoom || last.x !== cam.x || last.y !== cam.y) {
			work = "all";
		}
		this.lastPaintCam = { x: cam.x, y: cam.y, zoom: cam.zoom };
		if (work === "all") {
			drawCommitted(this.highlightCtx, cam, strokes, this.cssWidth, this.cssHeight, true, "highlighter");
			drawCommitted(this.committedCtx, cam, strokes, this.cssWidth, this.cssHeight, true, "pen");
		} else if (work.length > 0) {
			if (this.indexDirty) {
				this.strokeIndex.rebuild(strokes);
				this.indexDirty = false;
			}
			for (const rect of work) {
				const hit = this.strokeIndex.query(rect);
				drawRegion(this.highlightCtx, cam, hit, rect, true, "highlighter");
				drawRegion(this.committedCtx, cam, hit, rect, true, "pen");
			}
		}
		// Selection chrome lives in world coordinates: scrolling and reflow
		// repaint it at the strokes' current position.
		if (!this.selection.isEmpty || this.lassoActive || this.spaceLineY !== null)
			this.redrawSelectionUI();
		// While a stroke is active this repaint ran with the LOCKED pen-down
		// camera (syncCamera above was a no-op); measure how far that frame
		// has diverged from a fresh read: the ink layer's on-screen error.
		if (diagnosticsEnabled()) {
			let driftX = 0;
			let driftY = 0;
			if (this.frame.locked) {
				const fresh = this.freshFrame();
				if (fresh) {
					driftX = fresh.x - this.camera.x;
					driftY = fresh.y - this.camera.y;
				}
			}
			scrollProbeRepaint({
				camX: this.camera.x,
				camY: this.camera.y,
				documentTop: this.lastSyncDocumentTop,
				contentLeft: this.lastSyncContentLeft,
				rectLeft: this.lastSyncRectLeft,
				rectTop: this.lastSyncRectTop,
				scale: this.scale,
				scrollLeft: this.view.scrollDOM.scrollLeft,
				scrollTop: this.view.scrollDOM.scrollTop,
				strokesDrawn: strokes.length,
				locked: this.frame.locked,
				driftX,
				driftY,
			});
		}
		this.updateExtent();
	}

	/**
	 * Put the ink band where this viewport needs it, and say whether it moved.
	 *
	 * The band is the box the canvases cover, in the scroller's own content
	 * coordinates. It is deliberately LAZY: the whole point of living inside
	 * the scroller is that ordinary scrolling needs no work at all, so this
	 * writes nothing until the viewport has eaten into the margin. Moving it
	 * is what costs a full re-rasterization, and doing that per scroll event
	 * is what the viewport-anchored layer used to do.
	 *
	 * Skipped while a stroke owns the frame. The pen froze its camera at
	 * pen-down and every sample maps through that frozen frame; moving the
	 * box under it would shear the stroke being drawn. Nothing is lost by
	 * waiting - the band scrolls with the text on its own.
	 */
	private syncBand(): "none" | "moved" | "resized" {
		if (!this.container || this.frame.locked) return "none";
		const scroller = this.view.scrollDOM;
		const viewport: BandViewport = {
			scrollLeft: scroller.scrollLeft,
			scrollTop: scroller.scrollTop,
			clientWidth: scroller.clientWidth,
			clientHeight: scroller.clientHeight,
			scrollWidth: scroller.scrollWidth,
			scrollHeight: scroller.scrollHeight,
		};
		if (!bandNeedsMove(this.band, viewport)) return "none";
		const band = bandFor(viewport);
		// A SIZE change has to reach handleResize, and the ResizeObserver will
		// not carry it: that observer watches the editor, so it fires when the
		// viewport changes and never when we resize our own container.
		//
		// Vertically that gap is invisible, because the band's height only
		// changes when the viewport's does - which the observer sees. The
		// width is the one that bites: it changes when the surface becomes
		// horizontally scrollable, which INK causes, not a resize. The
		// container widened to hold the margin while the canvases stayed at
		// their old width, so every stroke past the old right edge was drawn
		// outside the canvas and simply never appeared (alan, hardware:
		// "drawing breaks on the right extended canvas ... no ink comes out").
		const resized = this.band === null || this.band.width !== band.width || this.band.height !== band.height;
		this.band = band;
		this.container.setCssStyles({
			left: `${band.left}px`,
			top: `${band.top}px`,
			width: `${band.width}px`,
			height: `${band.height}px`,
		});
		// The box just moved under the router's cached rect. The scroll
		// handler refreshes it for the scrolling itself, but that runs BEFORE
		// this frame repositions the band, so without this the rect stays
		// stale by exactly the reposition - the hover reticle drifting off the
		// pen tip after every band move. Safe unconditionally: this method
		// returns early while a stroke owns the frame, so a refresh here can
		// never disturb a frozen one.
		this.router?.refreshRect();
		return resized ? "resized" : "moved";
	}


	// ---- surface extent -----------------------------------------------------
	//
	// Reconstructed from the 2026-08-20 deployed hardware build (its source
	// was lost with the session container). The note surface must be
	// SCROLLABLE wherever ink lives, including below the last line and right
	// of the content column: an invisible 1×1 spacer inside the scroller,
	// positioned at (note origin + granted extent) in scroller-content
	// coordinates, extends scrollWidth/scrollHeight so native scrolling
	// (finger, touchpad, scrollbar) reaches all of it. Obsidian ships the
	// scroller with `overflow-x: hidden`, so the axis guard flips exactly
	// that property to `auto` while ink needs it.
	//
	// This is the one piece of Handwriting that changes what SCROLLING itself can
	// do, and wheel input (the touchpad pipeline) can pan a scrollable x-axis
	// that an axis-locked touch drag never touches. That made it the first
	// suspect in the 2026-08 touchpad dead-zone investigation, which is why
	// every mutation here is traced.

	private updateExtent(force = false): void {
		if (!this.container || this.frame.locked) return;
		const path = this.filePath();
		if (!path) return;
		// Repaint ends here, so this runs on every scrolled frame. Nothing
		// below can grant a different extent while the ink frontier and the
		// camera/zoom/viewport inputs all stand still, and everything below
		// forces layout - two getBoundingClientRect, the origin, the spacer
		// position. Skip it. Gesture ends pass force and never skip. §5g/G1.
		const cam = this.camera.snapshot;
		const inputs: ExtentInputs = {
			path,
			frontier: this.frontierCache.get(path, inlineInk.strokes(path)),
			camX: cam.x,
			camY: cam.y,
			camZoom: cam.zoom,
			fontZoom: this.fontZoom,
			pinchScale: this.pinchScaleNow,
			cssScale: this.cssScale,
			cssWidth: this.cssWidth,
			cssHeight: this.cssHeight,
		};
		if (!force && sameExtentInputs(this.lastExtentInputs, inputs)) return;
		this.lastExtentInputs = inputs;
		const scroller = this.view.scrollDOM;
		// The origin is needed BEFORE growing now: the zoom frontier is
		// origin-relative, and it joins the ink frontier in one grow so a
		// magnified note's overhang is scrollable (see zoomFrontier).
		const contentRect = this.view.contentDOM.getBoundingClientRect();
		const preRect = scroller.getBoundingClientRect();
		const origin = surfaceOriginInScroller({
			contentLeftVisual: contentRect.left,
			documentTopVisual: this.view.documentTop,
			scrollRectLeft: preRect.left,
			scrollRectTop: preRect.top,
			scrollLeft: scroller.scrollLeft,
			scrollTop: scroller.scrollTop,
			scale: this.cssScale,
		});
		const ink = inputs.frontier;
		const zoom = zoomFrontier({
			clientWidth: scroller.clientWidth,
			clientHeight: scroller.clientHeight,
			contentBottom: (contentRect.bottom - preRect.top) / this.cssScale + scroller.scrollTop,
			origin,
			pinchScale: this.pinchScaleNow,
			fontZoom: this.fontZoom,
		});
		const granted = surfaceExtents.grow(path, {
			x: Math.max(ink.x, zoom.x),
			y: Math.max(ink.y, zoom.y),
		});
		if (!this.spacer && granted.x === 0 && granted.y === 0) return;
		if (!this.spacer) {
			if (this.winRef.getComputedStyle(scroller).position === "static") {
				scroller.setCssStyles({ position: "relative" });
				this.scrollPositionPatched = true;
			}
			this.spacer = scroller.createDiv({ cls: "handwriting-surface-extent" });
			this.spacer.setCssStyles({
				position: "absolute",
				width: "1px",
				height: "1px",
				visibility: "hidden",
				pointerEvents: "none",
			});
			scrollProbeExtent("spacer created");
		}
		this.ensureScrollableAxis(scroller);
		// The origin computed above, and the granted extent (note px)
		// converted with the font zoom, so the scroll range tracks the
		// ink's rendered size.
		const pos = spacerPosition(origin, {
			x: granted.x * this.fontZoom,
			y: granted.y * this.fontZoom,
		});
		let moved = false;
		if (pos.left !== this.spacerLeft) {
			this.spacerLeft = pos.left;
			this.spacer.setCssStyles({ left: `${pos.left}px` });
			moved = true;
		}
		if (pos.top !== this.spacerTop) {
			this.spacerTop = pos.top;
			this.spacer.setCssStyles({ top: `${pos.top}px` });
			moved = true;
		}
		if (moved) scrollProbeExtent(`spacer -> (${pos.left},${pos.top})`);
		scroller.classList.toggle("handwriting-hscroll", granted.x > 0);
		if (moved || !this.lastReach) this.measureReach(scroller, pos.left + 1);
	}

	private ensureScrollableAxis(scroller: HTMLElement): void {
		if (this.axisChecked || this.axisGuard.patched) return;
		this.axisChecked = true;
		const overflowX = this.winRef.getComputedStyle(scroller).overflowX;
		this.axisGuard.assert(scroller, overflowX);
		if (this.axisGuard.patched) {
			scrollProbeExtent(`axis guard: overflow-x "${overflowX}" -> auto`);
		}
	}

	private restoreScrollableAxis(): void {
		this.axisGuard.restore(this.view.scrollDOM);
	}

	private measureReach(scroller: HTMLElement, required: number): void {
		this.lastReach = {
			required,
			scrollWidth: scroller.scrollWidth,
			clientWidth: scroller.clientWidth,
			overflowX: this.winRef.getComputedStyle(scroller).overflowX,
			patched: this.axisGuard.patched,
		};
	}

	surfaceReport(): string {
		const path = this.filePath();
		const scroller = this.view.scrollDOM;
		const granted: Extent = path ? surfaceExtents.get(path) : ZERO_EXTENT;
		const frontier = path ? inkFrontier(inlineInk.strokes(path)) : ZERO_EXTENT;
		const reach = this.lastReach;
		return [
			`file: ${path ?? "(none)"}`,
			`ink frontier (note units): ${frontier.x.toFixed(1)}, ${frontier.y.toFixed(1)}`,
			`granted extent: ${granted.x}, ${granted.y}`,
			`spacer: ${this.spacer ? `present at ${this.spacerLeft}, ${this.spacerTop}` : "none"}  parent: ${this.spacer?.parentElement?.className ?? "-"}`,
			`scroller: client ${scroller.clientWidth} x ${scroller.clientHeight}  scroll ${scroller.scrollWidth} x ${scroller.scrollHeight}  at ${scroller.scrollLeft}, ${scroller.scrollTop}`,
			`computed overflow-x: ${this.winRef.getComputedStyle(scroller).overflowX}  overflow-y: ${this.winRef.getComputedStyle(scroller).overflowY}  position: ${this.winRef.getComputedStyle(scroller).position}`,
			`axis asserted by Handwriting: ${this.axisGuard.patched}`,
			reach
				? `last reconcile: required ${reach.required}, scrollWidth ${reach.scrollWidth}, client ${reach.clientWidth}: ` +
					(reach.scrollWidth >= reach.required
						? isScrollableOverflow(reach.overflowX)
							? "REACHABLE"
							: `EXTENT PRESENT BUT NOT USER-SCROLLABLE (overflow-x: ${reach.overflowX})`
						: "EXTENT MISSING: scrollWidth did not grow")
				: "last reconcile: (none yet)",
		].join("\n");
	}
}

const inkOverlayPlugin = ViewPlugin.fromClass(InkOverlayPlugin);

// Obsidian's ordinary editor keymap also handles Delete and Backspace. Put
// the selected-ink handler first, but claim those keys only while ink is
// selected. Every other key still falls through untouched.
const inlineSelectionKeyHandlers = Prec.highest(
	EditorView.domEventHandlers({
		keydown(event, view) {
			return view.plugin(inkOverlayPlugin)?.handleKeyDown(event) ?? false;
		},
		keyup(event, view) {
			return view.plugin(inkOverlayPlugin)?.handleKeyUp(event) ?? false;
		},
		paste(event, view) {
			return view.plugin(inkOverlayPlugin)?.handlePaste(event) ?? false;
		},
	})
);

export function inkOverlayExtension(): Extension {
	return [
		inlineSelectionKeyHandlers,
		inkOverlayPlugin,
		inkHistorySupport(),
	];
}
