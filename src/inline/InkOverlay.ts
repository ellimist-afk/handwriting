import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { Prec, type Text } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { isolateHistory, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { Notice, Platform, editorInfoField } from "obsidian";
import type { Editor, TFile } from "obsidian";
import { runGatedCommand } from "../CommandPaletteSplit";
import { Camera } from "../camera/Camera";
import { CameraState } from "../camera/coordinates";
import { contentOrigin, contentOriginLeft } from "./ContentOrigin";
import { anchorTop } from "./DocumentTop";
import {
	penContactIntent,
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
	strokeIdsBelow,
	sweptRect,
	InsertSpaceRows,
	nearestSpaceBoundary,
	type SpaceBoundary,
	canSplitParagraph,
	snapLine,
	spaceProtectedBlocks,
	type SpaceProtectedBlock,
} from "./InsertSpace";
import { MobileTools } from "./MobileTools";
import { stripPenDown, stripPenUp } from "./StripPenChrome";
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

/**
 * Whole CSS px the content origin must move before it is treated as a real
 * reposition rather than rect-measurement wobble.
 *
 * The COLUMN'S LEFT EDGE, which is the horizontal half of that origin.
 * Same shape as `SCALE_EPSILON` and `ScrollBand`'s `BAND_MOVE_EPSILON`:
 * `getBoundingClientRect().left` is fractional, so an exact compare against
 * `lastSyncContentLeft` would fire on sub-pixel noise most ticks - which
 * defeats the guard as completely as never checking at all, re-syncing and
 * re-scheduling a repaint every time `handleResize` runs for an unrelated
 * reason. A whole pixel is the smallest displacement that could ever
 * separate ink from the text under it.
 *
 * The VERTICAL half is not guarded by a threshold on the measurement:
 * `syncCamera` compares the camera it just built against the camera the
 * pixels were drawn with, which is the same exact three-field compare
 * `repaint` makes about the same question, so this constant does not apply
 * there.
 */
const CONTENT_ORIGIN_EPSILON = 1;

const LASSO_CURSOR_CLASS = "handwriting-pen-hover-lasso";
const SPACE_CURSOR_CLASS = "handwriting-pen-hover-space";
const PAN_CURSOR_CLASS = "handwriting-pen-hover-pan";
import {
	DEFAULT_TOOLBAR_CORNER,
	ToolbarCorner,
	normalizeToolbarCorner,
} from "./ToolbarCorner";
import {
	getPenToolsMode,
	markPenHardwareSeen,
	markPenSeen,
	penSeenThisSession,
	penToolsVisible,
	pointerRaisesPenTools,
	releaseMouseInkQuietly,
} from "./PenToolsMode";
import { deviceHasTouch } from "./DeviceInput";
import { computeCanvasSize, countPaintedPixels } from "../diag/Raster";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { routineNoticesVisible } from "../diag/RoutineNotices";
import { eraserRect, splitStrokeByCircle, strokesHitByCircle } from "../ink/Eraser";
import { DEFAULT_PEN, HIGHLIGHTER_ALPHA, HIGHLIGHTER_PEN, PenStyle } from "../ink/PenStyle";
import { clampInkSize } from "../ink/InkSize";
import { withInkDestination } from "../ink/InkTheme";
import { applyInkColor, colorsFor, getInkColorHex } from "../ink/InkColor";
import {
	applyInkPreset,
	forgetInkPreset,
	inkPresetsFor,
	starInkPreset,
} from "../ink/InkPresets";
import {
	paintPurgeSentinel,
	purgeDetected,
	purgeProbeArmed,
	purgeProbeDue,
	readPurgeSentinel,
} from "../ink/PurgeSentinel";
import { Point2 } from "../ink/Smoothing";
import { BBox, InkStroke, InkTool, newStrokeId } from "../ink/Stroke";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { strokeWidthPolicy, type StrokeWidthMode } from "../ink/StrokeWidth";
import { StrokeMetrics } from "../ink/StrokeMetrics";
import { drawCommitted,
	drawRegion, drawStroke, ribbonCacheStats } from "../ink/StrokeRenderer";
import { snipViewport } from "../pdf/PageMap";
import { TailRenderer } from "../ink/TailRenderer";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { PenSample, silentLift } from "../input/PointerRouter";
import { SnapPreview, SnapPreviewCanvas } from "./SnapPreview";
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
	snapReplaceOp,
} from "./InkHistory";
import { SnapChip } from "./SnapChip";
import {
	type DeleteSelectionOutcome,
	InlineSelectionDeleteKeys,
	lassoDeleteNotice,
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
import {
	EmptyPageNoticeGate,
	EmptyPageTool,
	emptyPageNoticeText,
	inkChangeRearmsNotice,
} from "./EmptyPageNotice";
import { focusClaimedPenEditor, setKeyboardFocus } from "./InlineFocus";
import {
	HOVER_GHOST_MS,
	PAN_DRAG_CLASS,
	PEN_HOVER_CLASS,
	penCursorLayout,
	penReticleShown,
} from "./PenCursor";
import { normalizeInlinePenPressure } from "./PenPressure";
import { observeStrokeMax, strokeGain } from "../ink/PressureGain";
import { embedInkLayerCount, embedInkPrintSwaps } from "./EmbedInk";
import { notifyInkChanged, onInkChanged } from "./InkEvents";
import { ExtentInputs, FrontierCache, sameExtentInputs } from "./FrontierCache";
import { DamageLedger } from "../ink/DamageLedger";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DWELL_MS, snapStroke } from "../ink/ShapeSnap";
import { beginUndoWindow, discardUndoTrace, isUndoRedoKey, registerUndoTraceView, unregisterUndoTraceView } from "../diag/UndoHistoryTrace";

const sessionStartMs = Date.now();
import { anchoredScroll, pinchScale, fitInkBounds, clampToReachable, MIN_PINCH_SCALE, MAX_VIEWPORT_LAYOUT, type InkFitBounds } from "./PinchScale";
import { ERASER_CURSOR_CLASS } from "./PenCursor";
import { DEFAULT_ERASER_RADIUS_PX, clampEraserRadius } from "../ink/EraserSize";
import {
	backingScale,
	ownedEffectiveScale,
	validCameraScale,
	fontZoomFactor,
	noteToVisual,
	visualToNote,
} from "./ZoomScale";
import {
	isPenProbeEnabled,
	markMappedTip,
	noteProbeStroke,
	recordProbe,
	setProbeGeometry,
} from "./PenProbe";
import { InlinePenRouter, anyHandOnGlass, bandEraserIntent } from "./InlinePenRouter";
import { armMouseInkQuietly, markToolPicked, mouseInkEnabled, toolPickedHere } from "./MouseInk";
import { penInkEnabled } from "./PenInk";
import { fingerInkEligible } from "./FingerInk";
import { describeEl, setHitProbeContext } from "./PenHitProbe";
import { Extent, inkFrontier, isScrollableOverflow, ScrollAxisGuard, ScrollExpansionDemand, spacerPosition, surfaceExtents, surfaceOriginInScroller, writeFrontier, ZERO_EXTENT, zoomFrontier } from "./SurfaceExtent";
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

/** Whether one centerline segment crosses a screen-space viewport rectangle. */
function segmentIntersectsViewport(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	left: number,
	top: number,
	right: number,
	bottom: number,
): boolean {
	if (![ax, ay, bx, by].every(Number.isFinite)) return false;
	let enter = 0;
	let leave = 1;
	const dx = bx - ax;
	const dy = by - ay;
	for (const [p, q] of [
		[-dx, ax - left],
		[dx, right - ax],
		[-dy, ay - top],
		[dy, bottom - ay],
	] as const) {
		if (p === 0) {
			if (q < 0) return false;
			continue;
		}
		const ratio = q / p;
		if (p < 0) {
			if (ratio > leave) return false;
			if (ratio > enter) enter = ratio;
		} else {
			if (ratio < enter) return false;
			if (ratio < leave) leave = ratio;
		}
	}
	return true;
}

/** Actual stroke geometry, not its possibly-empty bounding-box interior. */
function strokeIntersectsViewport(
	stroke: InkStroke,
	cam: Readonly<CameraState>,
	viewW: number,
	viewH: number,
	offsetX: number,
	offsetY: number,
): boolean {
	if (stroke.points.length === 0 || viewW <= 0 || viewH <= 0) return false;
	const pad = Math.max(1, (stroke.width * cam.zoom) / 2);
	const screen = (point: InkStroke["points"][number]): { x: number; y: number } => ({
		x: (point.x - cam.x) * cam.zoom + offsetX,
		y: (point.y - cam.y) * cam.zoom + offsetY,
	});
	if (stroke.points.length === 1) {
		const point = screen(stroke.points[0]!);
		return point.x >= -pad && point.y >= -pad && point.x <= viewW + pad && point.y <= viewH + pad;
	}
	let from = screen(stroke.points[0]!);
	for (let i = 1; i < stroke.points.length; i++) {
		const to = screen(stroke.points[i]!);
		if (segmentIntersectsViewport(from.x, from.y, to.x, to.y, -pad, -pad, viewW + pad, viewH + pad)) {
			return true;
		}
		from = to;
	}
	return false;
}

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
	for (const overlay of instances) overlay.clearSnapPreview();
}

export function getInlineTool(): InkTool {
	return inlineTool;
}

export function setInlineTool(tool: InkTool): void {
	inlineTool = tool;
	for (const overlay of instances) overlay.clearSnapPreview();
	// THE NIB HALF OF "a tool has been picked" (MouseInk.ts, `toolPicked`).
	// Here rather than in the two tool commands, the strip's two nib buttons,
	// the colour commands and the quick-pen chips, because every one of them
	// ends in this line and a rule written at all six drifts at one of them.
	// The mouse-draws-from-a-lit-tool grant on a pen-less device reads that
	// flag; on a device that has seen a pen nothing reads it at all.
	markToolPicked();
	// Picking a nib is how you put every other mode away - not just the
	// eraser. While this cleared one flag of four, "Switch between pen and
	// highlighter" left the tip panning while announcing a nib change.
	releaseTipMode();
	// Commands and strip buttons both end here. If that pick makes iPhone
	// finger ink eligible, commit its pre-contact guard on every mounted note;
	// a toolbar-only hook would leave command entry in a native-scroll window.
	prepareFingerInkEverywhere();
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

/**
 * And the same surfaces need to know when a RENDER-TIME setting changed the
 * committed geometry under them. `repaintAllInkOverlays` walked `instances`,
 * which is the editor overlays and nothing else, so flipping Ink smoothing or
 * pressure sensitivity left every open PDF and every page view showing ink in
 * the old shape until something unrelated happened to repaint it - on the
 * surface the plugin calls the headline use for writing.
 */
const repaintSurfaces = new Set<() => void>();

/**
 * And the same surfaces need to hear the mouse-ink OFF edge, because that
 * edge can strand a reticle. Its own set, not `stripSurfaces`: a strip
 * refresh runs on every corner change and every tip-mode change, and hiding
 * a live reticle on those would take the ring out from under a pen that is
 * still hovering.
 */
const hideCursorSurfaces = new Set<() => void>();

/**
 * And the same surfaces need to hear the pen going OFF while a stroke of
 * theirs is live, because the router refuses new claims without breaking the
 * one it already made (`InlinePenCallbacks.penOff`). Its own set for the same
 * reason as the one above: a strip refresh is not a stroke end, and ending a
 * live stroke on every corner change would take the word out from under a pen
 * that is still writing.
 *
 * The pen-off state was note-only when this fan-out did not exist, so a pdf
 * had nothing live to end. It is not note-only any more ("why would you take
 * keyboard mode away from pdf"), and a pdf whose stroke was left running would
 * hold `activePenId` with the window-capture click suppressor armed behind it
 * - the failure `abandonActiveStroke` was written for, reached a different
 * way.
 */
const endStrokeSurfaces = new Set<(preserveMouse?: boolean) => void>();

/** Register an extra strip to refresh with the editors. Returns the undo. */
export function addStripSurface(
	refresh: () => void,
	onTipMode?: () => void,
	onRepaint?: () => void,
	onHideCursor?: () => void,
	onEndLiveStroke?: (preserveMouse?: boolean) => void
): () => void {
	stripSurfaces.add(refresh);
	if (onTipMode) tipModeSurfaces.add(onTipMode);
	if (onRepaint) repaintSurfaces.add(onRepaint);
	if (onHideCursor) hideCursorSurfaces.add(onHideCursor);
	if (onEndLiveStroke) endStrokeSurfaces.add(onEndLiveStroke);
	return () => {
		stripSurfaces.delete(refresh);
		if (onTipMode) tipModeSurfaces.delete(onTipMode);
		if (onRepaint) repaintSurfaces.delete(onRepaint);
		if (onHideCursor) hideCursorSurfaces.delete(onHideCursor);
		if (onEndLiveStroke) endStrokeSurfaces.delete(onEndLiveStroke);
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

/** The placement changed live and has to survive a restart; the plugin owns
 * data.json, so it registers the write here at load. */
let persistToolbarCorner: ((corner: ToolbarCorner) => void) | null = null;

export function setPersistToolbarCorner(fn: ((corner: ToolbarCorner) => void) | null): void {
	persistToolbarCorner = fn;
}

/**
 * Move the toolbar and remember it: `applyInkSize`'s shape, for the other
 * setting a strip can now change on its own.
 *
 * ONE ROAD, and this is the whole point of the function. The placement has
 * two writers since drag-to-anchor (1.4.12) - the settings dropdown and a
 * drag of the strip's grip - and each of them owes the other's half: a drop
 * that only called `setToolbarCorner` would move the toolbar until the next
 * restart and leave the dropdown reading the placement it had before, and one
 * that only wrote settings would persist a move nobody could see. The
 * dropdown's `case "toolbarCorner"` (main.ts) calls this, and both strip
 * hosts wire `MobileToolsHost.setPlacement` to it, so there is nothing to
 * keep level.
 *
 * The value is NORMALISED here rather than trusted, for the same reason
 * `setStripFoldOrder` normalises: a caller that has not is then safe, and
 * both of today's callers already had to.
 */
export function applyToolbarPlacement(corner: ToolbarCorner): void {
	const safe = normalizeToolbarCorner(corner);
	setToolbarCorner(safe);
	persistToolbarCorner?.(safe);
}

let penReticleOn = true;
let eraserWholeStrokes = true;
let shapeSnapOn = true;

export function setShapeSnap(on: boolean): void {
	shapeSnapOn = on;
	if (!on) for (const overlay of instances) overlay.clearSnapPreview();
}

export function setPenReticle(on: boolean): void {
	penReticleOn = on;
}

export function penReticleEnabled(): boolean {
	return penReticleOn;
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
 * A way in for a host that cannot reach `persistEraserMode` itself. The note
 * host pairs `setEraserWholeStrokes(on)` with `persistEraserMode?.(on)`
 * inline (the strip spec below) because both live in this module; the PDF
 * host builds its strip spec in a different file and needs a call to make
 * the same pairing there.
 */
export function persistEraserModeNow(on: boolean): void {
	persistEraserMode?.(on);
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
	if (routineNoticesVisible()) new Notice(`Handwriting: ${tool} ${name}`);
}

export function commitEraserRadius(): void {
	persistEraserRadius?.(inlineEraserRadiusPx);
}

/** Same shape for the nib-size sliders: live module state, plugin persists. */
let persistInkSize: ((tool: InkTool, mult: number) => void) | null = null;

export function setPersistInkSize(fn: ((tool: InkTool, mult: number) => void) | null): void {
	persistInkSize = fn;
}

/**
 * Set and persist a tool's nib size in one move: `applyInkColor`'s twin for
 * the other half of a pen (InkColor.ts).
 *
 * The pair was already written twice - inline in each strip host's
 * `setInkSizeMult(tool, mult, commit)` - because `persistInkSize` is module
 * state here and only this file could reach it. Quick pens (1.4.12 §4) is the
 * third caller and the first one OUTSIDE this module, and a preset must land
 * by the same road a slider release does or the two persist differently.
 * The clamped value is what gets persisted, never the caller's raw number.
 */
export function applyInkSize(tool: InkTool, mult: number): void {
	setInkSizeMult(tool, mult);
	persistInkSize?.(tool, getInkSizeMult(tool));
}

export const inlineInk = new InlineInkStore();
const instances = new Set<InkOverlayPlugin>();

let scrollExpansionEnabled = false;
export function setScrollExpansionEnabled(on: boolean): void {
	if (on === scrollExpansionEnabled) return;
	scrollExpansionEnabled = on;
	for (const overlay of instances) {
		overlay.setCanvasMomentumDisabled(on);
		overlay.scheduleRepaint("scroll-expansion-setting");
	}
}

function prepareFingerInkEverywhere(): void {
	for (const p of instances) p.prepareFingerInk();
}
/** Shared across editors so an A/B session accumulates one summary list. */
/** Same area cap as the pdf snip (MAX_OVERLAY_PX there): one budget for
 * every raster this plugin produces. */
const NOTE_SNIP_CAP_PX = 4_000_000;

/**
 * The page a note snip paints for itself, and therefore the destination its
 * ink has to be readable on. One constant so the fill and the readability
 * rule cannot be changed apart.
 */
const SNIP_PAGE = "#ffffff";

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

/**
 * The mounted overlay that IS the editor the user is working in.
 *
 * `overlayForPath` answers the FIRST overlay showing a path. That is the right
 * answer for a background repaint, where every pane on the path shows the same
 * ink, and the wrong one for a command: two panes on one note share a path, so
 * the palette and the hotkeys reached whichever pane mounted first - deleting
 * ink the user could see was not selected, and leaving the undo step in a pane
 * they were not looking at.
 *
 * IDENTITY, NEVER A PATH, on both halves. Two `TFile` objects can name one
 * path, and Obsidian reuses editors, so an `Editor` can still be paired with
 * the file it used to show. Either comparison alone can be satisfied by the
 * wrong pane.
 *
 * NULL RATHER THAN A GUESS. No fallback to the path, and never to another
 * pane's selection: a command that refuses is recoverable, and ink deleted in
 * a pane the user is not looking at is not. `overlayForPath` itself keeps its
 * policy unchanged for every caller that wants the old, broader question.
 */
export function overlayForActiveEditor(editor: Editor, file: TFile): InkOverlayPlugin | null {
	for (const p of instances) {
		if (p.ownsActiveEditor(editor, file)) return p;
	}
	return null;
}

/** Re-evaluate the pen-tools strip on every open editor (mode command). */
export function refreshPenToolsAll(): void {
	for (const p of instances) p.ensurePenTools();
}

/**
 * The pen just went off (or on): end any live stroke on every open surface.
 *
 * The state can be flipped with the nib on the glass - a hotkey, the palette,
 * or the other hand on the strip - and the router's gate deliberately refuses
 * only NEW claims (see `InlinePenCallbacks.penOff`). Without this, a stroke
 * claimed a moment earlier would keep `activePenId` set with the window-
 * capture click suppressor armed behind it, which is the note-switch failure
 * `abandonActiveStroke` was written for, reached a different way.
 *
 * COMMITS, it does not drop. `finishActiveStroke()` ends the stroke exactly
 * as a lift does - the surface's own `penUp` commits the ink and stands the
 * strip chrome down - which is the ruling already settled for the other
 * teardown a writer hits mid-stroke (alan, 2026-09-04, on a window blur:
 * "alt tab mid stroke - sure make it consistent"). Turning the pen off is not
 * a request to throw away the word being written, and a toggle that ate it
 * would be a worse bug than the one this feature fixes.
 *
 * Nothing live means nothing done: `finishActiveStroke()` returns false and
 * changes no state at all. Deliberately NOT `abandonActiveStroke()`, whose
 * teardown also runs `restoreGuardStyle()` whenever an ownership tail is
 * still open - that would strip the standing touch-action guard off the
 * scroller on every toggle made just after a stroke, which is the lit-nib
 * regression its own header spells out.
 * `preserveMouse` is the Keyboard-OFF exception: an owned mouse stays live
 * until its own up/cancel; blur and teardown use the default false.
 *
 * EVERY SURFACE, like the state itself. This walked `instances` alone while
 * the pen-off state was note-only; the owner's reversal ("why would you take
 * keyboard mode away from pdf") gave the pdf a gate of its own, and with it a
 * live stroke that has to end the same way. `instances` is the editor overlays
 * and nothing else, so the pdf half comes through `addStripSurface`'s
 * `onEndLiveStroke` - the same registry the reticle and strip fan-outs use,
 * and for the reason `stripSurfaces` states: this module is imported BY the
 * pdf surface, so importing back would close the loop.
 */
export function endLiveStrokesEverywhere(preserveMouse = false): void {
	for (const p of instances) p.endLiveStroke(preserveMouse);
	for (const end of endStrokeSurfaces) end(preserveMouse);
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

/**
 * Put a mouse-claimed tool down QUIETLY, and repaint every open strip's
 * light - not just the one that was clicked.
 *
 * `releaseMouseInkQuietly` (PenToolsMode.ts) clears the mode and the pen
 * light's `penHardware` flag but does not `announce()` - it changes no
 * surface's existence, only how a strip draws, so it leaves the repaint to
 * its callers. Before this wrapper, both hosts' `disarmMouseInkQuietly`
 * called it directly and then relied on `MobileTools`'s own post-click
 * `this.refresh()`, which repaints only the ONE strip the pointer is on. A
 * second open pane - another note, or the PDF - kept showing whatever light
 * it had before the put-down until something unrelated repainted it
 * (hardware finding, 2026-09-03, the same class of bug as the mouse-ink-off
 * command carried).
 *
 * Defined once, here, rather than duplicated in both hosts' object literals:
 * PenToolsMode.ts's own comment on `releaseMouseInkQuietly` names that kind
 * of duplication as this project's most expensive recurring defect, and
 * `MobileTools.ts` cannot reach `refreshAllStrips` itself (it is imported BY
 * this file, so importing back would close a cycle) - this module is the one
 * place that can pair the two calls once for every surface.
 */
/**
 * Mouse ink just went OFF: put the reticle away on every open surface.
 *
 * The reticle is taken down by two things and neither of them fires here. A
 * pen's is taken down by the 1000ms hover watchdog (`armHoverWatchdog`); an
 * armed mouse's is taken down by `pointerleave`, and it is EXEMPT from the
 * watchdog on both surfaces, on the correct grounds that a mouse is either
 * over the pane or has sent that event. Turning mouse ink off is the third
 * way, and it is neither: the pointer has not moved and never will - the
 * hotkey, the command palette and the strip's own put-down all reach this
 * edge with the mouse sitting still over the pane. The ring stayed lit and
 * `PEN_HOVER_CLASS`'s `cursor: none` stayed on the scroller, so the surface
 * had no pointer at all until something unrelated happened to hide it
 * (adversarial review, 2026-09-04, of the exemption this branch added).
 *
 * Fanned out the way the nib light already is on this same edge, and for the
 * same reason: a second open pane is not repainted by whatever the pointer is
 * over. Both halves are here rather than at the two call sites for the reason
 * `applyMouseInkUiFanout` (main.ts) gives - the loud toggle command and the
 * quiet put-down are one rule with two writers.
 *
 * A PEN hovering when this fires loses its ring for one sample and gets it
 * straight back: hover samples stream continuously from a hand-held pen, and
 * `showPenCursor` rebuilds the ring from the next one. That is the same trade
 * `hidePenCursor` already makes everywhere else it is called.
 *
 * Costs nothing when nothing toggles: no caller but the OFF edge.
 */
export function hidePenCursorsEverywhere(): void {
	for (const p of instances) p.hidePenCursor();
	for (const hide of hideCursorSurfaces) hide();
}

export function releaseMouseInkQuietlyEverywhere(): void {
	releaseMouseInkQuietly();
	refreshAllStrips();
	// The mode is off as of the line above, so the reticle it was holding up
	// is now a ring with nothing behind it; see hidePenCursorsEverywhere.
	hidePenCursorsEverywhere();
}

/**
 * Arm mouse ink QUIETLY, and repaint what the ON edge has always repainted.
 *
 * The mirror of the wrapper above, and it exists for the same reason: the
 * bare `armMouseInkQuietly` (MouseInk.ts) flips a module flag and nothing
 * else, so a second open pane keeps its stale dark nib - the strip's own
 * post-click `this.refresh()` repaints only the strip the pointer is on.
 *
 * The three calls are exactly `applyMouseInkUiFanout(true)`'s (main.ts),
 * because this is the SAME edge reached quietly. Until now the strip's
 * active-nib mouse click reached it through the loud toggle command, which
 * did that fan-out on the way past; routing that click to the quiet arm - so
 * it stops writing data.json - would otherwise have dropped the fan-out
 * along with the write, which is a different bug rather than a fix.
 * `markPenSeen` because arming mouse ink IS declaring yourself a pen person,
 * the toggle command's own words: the toolbar must not go on waiting for
 * hardware that is never coming.
 *
 * Defined here rather than in `MouseInk.ts` for the reason its neighbour
 * gives: `refreshAllStrips` lives in this module, which `MouseInk` cannot
 * import back without closing a real cycle.
 */
export function armMouseInkQuietlyEverywhere(): void {
	armMouseInkQuietly();
	markPenSeen();
	refreshPenToolsAll();
	refreshAllStrips();
}

/**
 * Repaint every surface's committed ink: the shaping, smoothing and pressure
 * toggles all change render-time geometry and none of them touches a stroke,
 * so nothing else would.
 */
export function repaintAllInkOverlays(): void {
	for (const p of instances) { p.clearSnapPreview(); p.scheduleRepaint("shaping-toggle"); }
	for (const repaint of repaintSurfaces) repaint();
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
		`ribbon cache: ${ribbonCacheStats().hits} hit / ${ribbonCacheStats().misses} miss`,
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

/**
 * What a lasso cut actually did, `DeleteSelectionOutcome`'s
 * (InlineSelectionDelete.ts) own shape for `cutSelectedInk`, and for the
 * same reason: a bare count answered 0 both when nothing was selected and
 * when the copy worked but the delete matched nothing in the store, and
 * every caller that reached 0 said "lasso some ink first" over ink that had,
 * in fact, just been copied and left on the page.
 *
 * Defined here rather than in `InlineSelectionDelete.ts`: that module owns
 * the delete outcome and nothing about cutting, and a cut is copy-then-
 * delete, a fact only this file knows.
 */
export type CutSelectionOutcome =
	/** Copied and removed. `count` is how many strokes. */
	| { kind: "cut"; count: number }
	/** Nothing was selected, or there is no path to cut from. */
	| { kind: "empty" }
	/** Copied, but the delete matched nothing in the store - the ink and the
	 *  lasso both stayed on the page. */
	| { kind: "unmatched"; count: number };

/**
 * The notice a lasso copy owes the user.
 *
 * Same shape and same reason as `cutSelectionNotice` below: ONE owner for
 * the sentence, so the strip button and the registered command cannot drift
 * into two wordings for one outcome. Both strings are exactly the ones the
 * command site's ternary produced before this function existed - moved, not
 * rewritten - and the empty-selection one stays byte-identical, as it has
 * through every box that has touched this row.
 */
export function copySelectionNotice(copied: number): string {
	if (copied > 0) return `Handwriting: copied ${copied} stroke(s)`;
	return "Handwriting: lasso some ink first";
}

/**
 * Which arm of `copySelectionNotice` a call is going to take, so a caller can
 * hide the routine one behind the developer switch without hiding the other.
 *
 * BRANCH-AWARE ON PURPOSE (root, 2026-09-09). The count is a routine success
 * and goes quiet; "lasso some ink first" is no-op guidance and must keep
 * showing. Gating the CALL would have taken both. This sits beside the string
 * helper rather than inside it so the helper's API and its exact sentences are
 * untouched, and so the wording still has one owner.
 */
export function copySelectionNoticeIsRoutine(copied: number): boolean {
	return copied > 0;
}

/**
 * The notice a lasso cut owes the user, `lassoDeleteNotice`'s
 * (InlineSelectionDelete.ts) own shape and reason: pinned by execution
 * rather than by reading a caller as text, and the empty-selection string
 * must stay byte-identical, since it was always true.
 */
export function cutSelectionNotice(outcome: CutSelectionOutcome): string {
	if (outcome.kind === "cut") return `Handwriting: cut ${outcome.count} stroke(s)`;
	if (outcome.kind === "empty") return "Handwriting: lasso some ink first";
	return `Handwriting: copied ${outcome.count} stroke(s) but could not remove them - the lasso has been kept`;
}

/**
 * `copySelectionNoticeIsRoutine`'s counterpart, and the reason this one is
 * worth stating separately: `cutSelectionNotice` has THREE arms, and only the
 * first is routine. "empty" is no-op guidance and the third is a partial
 * FAILURE - ink was copied but could not be removed - which is the last
 * sentence that should ever be hidden behind a developer switch.
 */
export function cutSelectionNoticeIsRoutine(outcome: CutSelectionOutcome): boolean {
	return outcome.kind === "cut";
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
	/**
	 * The pressure the wet ribbon was last handed, recorded at the moment it
	 * was handed over - the GAINED value, which is what a builder point
	 * carries.
	 *
	 * The predicted tail reads this instead of the newest raw sample so the
	 * guess ahead of the nib and the ribbon behind it are sized from one
	 * input (C21). Recorded rather than re-derived because `gainedPressure`
	 * is not pure: it feeds `strokeRawMax`, the stroke's running raw maximum,
	 * and calling it again at the tail site would mean the gain's own
	 * evidence came partly from a place that lays down no ink.
	 *
	 * Recording is also the only ANSWER available, not merely the safe one.
	 * The tail runs on the newest sample and the builder's dedupe may have
	 * refused it, in which case the ribbon's tip is still the sample before -
	 * so re-gaining the newest one would name a pressure the ribbon never
	 * drew with. A number, not the point: `StrokeBuilder.add` writes the
	 * newest pressure onto the retained point when it rejects a sample, so a
	 * reference here would drift off what was actually painted.
	 */
	private ribbonPressure = 0;
	private strokePenGesture = false;
	/**
	 * Was the pointer that started the CURRENT gesture a mouse?
	 *
	 * Byte-for-byte the pdf surface's field of the same name, for its reason:
	 * the in-gesture reticle wrappers (`showLassoCursor`, `showSpaceCursor`,
	 * and `restoreReticleAfterPan`, which is what a pan has instead of one
	 * since 1.4.12) pass no `pointerType` - deliberately and permanently,
	 * because the hardware and pen-seen claims belong to the hover and the
	 * pen-down that already happened, not to every sample of a gesture in
	 * flight - so the surface has to answer for them from what contact wrote
	 * down. `strokePenGesture` cannot: it is cleared at pen-up, so after any
	 * gesture it reads "mouse" for a pen.
	 *
	 * Written at pen-down, cleared only by `resetGestureState` (a file switch,
	 * an unmount, an abandoned gesture) - never at pen-up, exactly like the
	 * pdf's. Which is why an explicit "pen" always wins over it at the read
	 * site: the field only speaks where nothing else does.
	 */
	private mouseStroke = false;
	// Raw-layer dwell tracking: the last time the pen actually MOVED. The
	// builder filters stationary samples out of the stroke, so the hold
	// that requests a shape snap is only visible here.
	private rawLastMoveT = 0;
	private rawLastMoveX = 0;
	private rawLastMoveY = 0;
	/**
	 * The mouse's shape snap: an offer, never a correction. See SnapChip.ts
	 * for the defect ("it's correcting into a straight line") and the ruling.
	 * One per surface, created here and never replaced - the chip it holds is
	 * per-offer and takes itself down.
	 */
	private readonly snapChip = new SnapChip();
	private snapPreview: SnapPreview | null = null;
	private snapCanvas: SnapPreviewCanvas | null = null;
	private snapContactId: number | null = null;

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
	/** The same text/ink seam as the guide, frozen before any live movement. */
	private spacePlan: (SpaceBoundary & {doc: Text}) | null = null;
	private spaceRowsCache = new InsertSpaceRows();
	private spaceTextEnd: {doc:Text;pos:number;blocks:SpaceProtectedBlock[]} | null = null;
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
	/**
	 * A second observer, on `.cm-content`. `resizeObserver` above watches
	 * `.cm-editor`, whose box does not change when Obsidian's "Readable line
	 * length" toggles - that setting caps `.cm-content`'s max-width while the
	 * editor keeps filling the leaf, and the scroller and overlay-container
	 * boxes stay the size they were. Without a second observer, `syncCamera`
	 * never re-reads the content origin, `cam.x` stays at its pre-toggle
	 * value, and every stroke paints against a stale content-relative frame:
	 * the samuelbits drift, reproduced by Alan on 2026-09-03 the moment the
	 * Readable line length toggle became the recipe. `handleResize` cannot
	 * be reused here - its `unchanged` guard early-returns when canvas box
	 * has not moved, which is exactly this case - so the callback goes
	 * straight to `syncCamera` + `scheduleRepaint`, the two steps that
	 * actually re-anchor the paint against the fresh content origin.
	 */
	private contentResizeObserver: ResizeObserver | null = null;
	/**
	 * A THIRD observer, on the one element `contentOrigin` actually measured.
	 *
	 * The two above watch `.cm-editor` and `.cm-content`, and the Minimal
	 * theme holds both of them perfectly still while it moves the column.
	 * Minimal forces `.cm-content` to `width: 100%` and centres the LINE
	 * divs inside it (theme.css 9.0.2:1852-1867), so Readable line length,
	 * the theme's own `--line-width` setting and a per-note `cssclasses:
	 * wide` each re-centre the text without changing `.cm-content`'s box at
	 * all. Measured in `test/render/MinimalResync.test.ts`: on a note of
	 * short lines all three move the column by more than a pixel while
	 * `editorRO`, `contentRO` and `metadataMO` fire zero times between them.
	 * The camera then keeps its stale origin until the user scrolls or puts
	 * the pen down - so a user who changes a setting and LOOKS sees the ink
	 * sitting off the words, which is what samuelbits reported against the
	 * real 1.4.9.
	 *
	 * WHY THE LINE'S SIZE AND NOT A CLASS. The same measurement scored the
	 * cheaper candidates: a class MutationObserver on `.markdown-source-view`
	 * caught two of the three and missed both `--line-width` routes outright
	 * (a custom property moves the column with no class change anywhere), and
	 * a `<style>` observer on `document.head` caught only the injected route.
	 * The line's rendered size is downstream of ALL of them, so this trigger
	 * does not care how a theme or a settings plugin delivers the change.
	 * Widening `metadataObserver`'s `attributeFilter` was rejected outright:
	 * it is registered with `subtree: true`, so a class filter would fire on
	 * every `cm-activeLine` toggle - a callback per cursor move whose record
	 * array grows with the edit batch.
	 *
	 * A ResizeObserver sees size, not position, so it still misses a column
	 * that moves at CONSTANT line width - a sidebar while `width:
	 * var(--line-width)` is the binding that decides, where the line neither
	 * moves nor resizes but the editor does. That one is the editor
	 * observer's, and `handleResize`'s origin compare already covers it.
	 * Minimal declares `--content-margin` exactly once (theme.css:1832, as
	 * `auto`), so for this theme as shipped the pair is complete.
	 */
	private originLineObserver: ResizeObserver | null = null;
	/** The element `originLineObserver` is currently watching, if any. */
	private originLine: Element | null = null;
	private repaintQueued = false;
	/**
	 * Did nothing but scrolling ask for the queued frame? The purged-canvas
	 * probe (PurgeSentinel.ts) fires on that frame and no other, because it is
	 * the one that legitimately draws nothing.
	 */
	private repaintScrollOnly = false;
	/**
	 * `performance.now()` of the last sentinel readback. -Infinity, not 0, so
	 * the first one is due immediately rather than 300ms into the session.
	 */
	private lastPurgeProbe = Number.NEGATIVE_INFINITY;
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
	private scrollExpansion: ScrollExpansionDemand | null = null;
	/** The `.markdown-source-view` ancestor carrying the `handwriting-page` class. */
	private pageClassHost: HTMLElement | null = null;
	/** Keeps the page-id-only Properties block class in step with Obsidian's DOM. */
	private metadataObserver: MutationObserver | null = null;
	/** The one frame that observer owes, or null when it owes none. §5g/G2. */
	private metadataFrame: number | null = null;
	/** Live magnification of this editor. Session-local; never persisted. */
	private pinchScaleNow = 1;
	/** The scale this gesture started from, so a pinch never accumulates. */
	private pinchRefScale: number | null = null;
	/** The pinch this frame owes, coalesced from however many moves arrived. */
	private pinchPending: { next: number } | null = null;
	/** When the pinch last wrote the scroll itself; see the scroll handler. */
	private pinchScrollAt = 0;
	/** Live transform owns the existing raster until the final layout transaction. */
	private pinchPreview = false;
	/** Hides a reticle left behind by a pen that never sent pointerleave. */
	private hoverWatchdog: ReturnType<Window["setTimeout"]> | null = null;
	/** Whether the metrics frame ticker is running; see startFrameTicker. */
	private frameTicking = false;
	private frameRaf = 0;
	private frameTickToken: object | null = null;
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
	/** The ink band's box in scroller-content coordinates; see ScrollBand. */
	private band: Band | null = null;
	// Font-zoom tracking (quick font size / touchpad pinch; see ZoomScale).
	/** Live computed style of the content element; .fontSize is a cheap read. */
	private contentStyle: CSSStyleDeclaration | null = null;
	/** Editor font size at overlay mount, the fontZoom reference. */
	private refFontPx = 0;
	/** The font `update()` last saw. Written by `handleResize` only. */
	private lastFontStr = "";
	/**
	 * The font `syncCamera` last saw, which is a DIFFERENT question.
	 *
	 * `update()` decides whether to call `handleResize` on a geometry update
	 * by comparing the live computed `fontSize` against `lastFontStr`. When
	 * `syncCamera` started re-deriving `fontZoom` for itself it wrote that
	 * same field, so whichever of the two observers fired first CONSUMED the
	 * difference and the other one saw a font that had not changed - and the
	 * one that got disarmed was `handleResize`, whose canvas path is the only
	 * writer of the backing store.
	 *
	 * Benign as things stand: the backing size depends on `cssScale` and not
	 * on the font zoom, and the repaint that follows re-rasterizes at the new
	 * zoom either way. But it is an implicit coupling between two triggers
	 * that are deliberately independent, and the next thing `handleResize`
	 * learns to do on a font change would inherit it silently. Two fields,
	 * two questions, no coupling.
	 */
	private lastSyncFontStr = "";
	/** CSS-transform scale alone (visual px per layout px), fontZoom excluded. */
	private cssScale = 1;
	private scaleGeometryValid = true;
 private viewportGeneration = 0;
 private viewportPaneObserver: ResizeObserver | null = null;
 private viewportStyleObserver: MutationObserver | null = null;
 private viewportStyleFrame = 0;
 private viewportStyleStamp = "";
 private viewportStyleDirty: {path:string|null;container:HTMLElement|null} | null = null;
 private viewportLayout: {parent:HTMLElement; paneWidth:number; paneHeight:number; externalScale:number; baseTransform:string; width:number; height:number; column:number; left:string; right:string; styles:Map<string,{value:string;priority:string}>} | null = null;

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
	/**
	 * Diagnostic only, and NOT the thing to compare a drift against:
	 * `documentTop` is a SCREEN coordinate (`contentDOM.getBoundingClientRect()
	 * .top + paddingTop`, negative when scrolled down), so it changes by the
	 * whole delta on every scroll. The camera origin, which is that number
	 * minus the band's own rect top, is what stays still through a scroll and
	 * is what `syncCamera` compares. See the compare there.
	 *
	 * The ANCHOR THE CAMERA USED, which is `anchorTop`'s answer and not
	 * `view.documentTop` verbatim: the two differ only while CodeMirror has
	 * not measured its own padding yet, and a probe row that reported the
	 * number the mapping did NOT use would misdescribe exactly the frame the
	 * probe exists for.
	 */
	private lastSyncDocumentTop = 0;
	private lastSyncScrollLeft = 0;
	private lastSyncScrollTop = 0;
	/**
	 * The last column left the scan actually found, across every call site.
	 * `null` only before the first successful scan.
	 *
	 * Separate from `lastSyncContentLeft`, which is a stash of what SYNCCAMERA
	 * read and is compared against in `handleResize` to decide whether the
	 * column moved. Overwriting that from the diagnostic and extent paths
	 * would make that comparison lie.
	 */
	private lastGoodColumnLeft: number | null = null;
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
	private undoIdentity: object | null = null;
	private undoIdentityStale = false;
	/**
	 * What this overlay has already said about an empty page, so an eraser
	 * scrub - many contacts, one piece of news - says it once. See
	 * EmptyPageNotice.ts; cleared by ink changes and by a note switch.
	 *
	 * REACHED THROUGH A GETTER, and that is not decoration. Half a dozen
	 * tests in this suite drive real methods on a rig built with
	 * `Object.create(InkOverlayPlugin.prototype)` - a deliberate technique
	 * here, since it exercises the shipping code without a DOM - and
	 * `Object.create` runs NO field initialisers, so a plain `= new
	 * EmptyPageNoticeGate()` is `undefined` on every one of those rigs. The
	 * first version of this field was exactly that, and it took out five
	 * rigs at once (AbandonedGestureStandsDown, InlineEraserSelection,
	 * RemountFontRef) the moment `resetGestureState` touched it. A getter
	 * lives on the PROTOTYPE, so a rig gets it for free, and the lazy
	 * construction means no caller has to know whether it exists yet.
	 */
	private emptyNoticeGate: EmptyPageNoticeGate | null = null;
	private get emptyNotice(): EmptyPageNoticeGate {
		return (this.emptyNoticeGate ??= new EmptyPageNoticeGate());
	}
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

	/**
	 * Whether this mounted overlay is the pane behind `editor`, showing
	 * `file`. The predicate half of `overlayForActiveEditor`, here because the
	 * view is private and stays that way.
	 *
	 * Read live from the same `editorInfoField` `filePath()` reads, and for
	 * the same reason it is read live: Obsidian reuses editors, so a cached
	 * answer can outlive the pairing it was true for.
	 */
	ownsActiveEditor(editor: Editor, file: TFile): boolean {
		if (this.container === null) return false;
		const info = this.view.state.field(editorInfoField, false);
		if (!info) return false;
		return info.editor === editor && info.file === file;
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
				// The pointerType is PASSED ON. The interface has always
				// declared it (onPenHover(sample, pointerType?)) and the
				// router has always supplied it; this call site dropped it,
				// so the hover path could not tell a pen from a mouse and
				// marked a pen seen for both - `mouseActsAsPen` lets a plain
				// mouse move reach here whenever mouse ink is armed. That is
				// one of the two writers that made nibIsLit's flag a constant
				// for a mouse-only user (alan, 2026-09-02).
				onPenHover: (s, pt) => this.showPenCursor(s, pt),
				onPenLeave: () => this.hidePenCursor(),
				// A finger just landed with nothing else on the glass, so a
				// mouse's hover ring is the only thing that can be lit - and
				// it is not wanted while the hand writes (alan, 1.4.12: "hide
				// the mouse reticle when a finger or pen is active"). The
				// router asks only on that edge, so this cannot blink a pen's
				// ring; `InlinePenRouter.onHandOnGlass` carries the whole rule.
				//
				// `hidePenCursor` and not a narrower hide, deliberately: it is
				// the one teardown every abandon path already goes through,
				// and it takes `PEN_HOVER_CLASS`'s `cursor: none` off with the
				// ring, so the reader is left with the native cursor rather
				// than with no pointer at all.
				onHandOnGlass: () => this.hidePenCursor(),
				onPinch: (phase, ratio, centroid) => this.pinch(phase, ratio, centroid),
				onPenRaw: (samples, ev) => this.penRaw(samples, ev),
				onPenMove: (_ev, count) => metrics.recordEvent("move", count, 0, false),
				// The lift event is PASSED ON - see `penUp`'s own header. The
				// pan branch reads the pointer's position off it to put the
				// reticle back where the hand actually is.
				onPenUp: (ev) => this.penUp(ev),
				// Ordinary-note iPhone only. The predicate is read at contact,
				// after a toolbar command has explicitly picked the current nib.
				// PDF supplies no callback, so its touch behavior cannot widen.
				fingerInk: () =>
					fingerInkEligible({
						isIosApp: Platform.isIosApp,
						isPhone: Platform.isPhone,
						toolPicked: toolPickedHere(),
						penInkEnabled: penInkEnabled(),
						tipMode: tipMode(),
						tool: inlineTool,
					}),
				onFingerInkCancelled: () => this.cancelFingerInkForPinch(),
			// PEN OFF (PenInk.ts, design §5): the note surface is the only
			// one that answers this. Off means the router claims nothing, so
			// the pen is a native pointer here - taps place the caret and
			// raise the keyboard on a touch device, which is what two e-ink
			// users asked for. `PdfInkController` leaves this member
			// undefined, which reads as "never off", because there is no
			// keyboard use case on a pdf and taking the pen away there would
			// answer a request nobody made.
			penOff: () => !penInkEnabled() || this.scaleGeometryValid === false,
			claimBandContact: (ev) =>
				bandEraserIntent(
					ev.pointerType,
					ev.buttons,
					ev.button,
					tipMode() === "eraser",
					mouseInkEnabled()
				),
			// Trace-only (InlinePenRouter's window mirror calls this ONLY
			// while composing a trace line for a scroller-missing pen down -
			// see InlinePenCallbacks.describeChrome). The router holds no
			// reference to the strip by design, so this is the seam: ask
			// MobileTools for a snapshot of its own DOM, since only it has
			// the real element references to classify a hit against.
			describeChrome: (target) => this.mobileTools?.traceState(target) ?? "no strip mounted",
			// See `strokeAbandoned`. A named method rather than the body
			// inline: the surface registry's check for this wiring is a scan
			// of raw source text, which a comment satisfies, so the body needs
			// to be somewhere a test can call - and nothing in this repo can
			// construct an InkOverlayPlugin to reach a closure.
			onStrokeAbandoned: () => this.strokeAbandoned(),
			},
			() => this.cssScale
		);

		this.router.setCanvasMomentumDisabled(scrollExpansionEnabled);
		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(host);
		this.contentResizeObserver = new ResizeObserver(() => {
			if (!this.container || this.frame.locked) return;
			this.syncCamera();
			this.scheduleRepaint("content-resize");
		});
		this.contentResizeObserver.observe(this.view.contentDOM);
		// Created with no target: `syncCamera` arms it against whichever line
		// the origin scan picks, and `handleResize` below reaches `syncCamera`
		// on this very call. The body is a named method rather than a closure
		// like the one above it, because what it decides - repaint or not - is
		// the difference between a scroll costing one partial repaint and
		// costing a full re-raster of every visible stroke, and a decision
		// that load-bearing has to be reachable by a test that CALLS it rather
		// than by one that greps for it.
		this.originLineObserver = new ResizeObserver(() => this.originLineResized());
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
			this.clearSnapPreview();
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
		// ...and the empty-page refusal it has already made about that note is
		// spent: ink arriving (or the last of it leaving) is exactly the event
		// that makes the sentence worth saying again. Same subscription, so
		// the two cannot drift apart over which notes they heard about.
		this.offInkChanged = onInkChanged((p) => {
			this.frontierCache.invalidate(p);
			// ...but ONLY when ink ARRIVED. The sentence above said "or the
			// last of it leaving", and that half was wrong on a user's screen:
			// an eraser scrub re-lands the nib every few hundred ms, each
			// re-land a fresh pointerdown, so erasing the last stroke re-armed
			// this gate and the very next landing of the SAME scrub announced
			// that there was no ink to erase - to the person who had just
			// erased it (alan, 1.4.12: "flip to erase end worked but it also
			// gave me the toast for no ink to erase"). Emptying a page is the
			// one ink change that must NOT make the sentence worth saying
			// again: the user knows, they did it. Ink arriving still re-arms,
			// which is the case the gate exists for - a note that gains ink and
			// later loses it elsewhere should speak again.
			if (inkChangeRearmsNotice(inlineInk.inkPresence(p))) this.emptyNotice.forget(p);
		});
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
					this.mobileTools?.refresh();
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

	/** One eligibility-scoped entry shared by commands and this note's strip. */
	prepareFingerInk(): void {
		if (
			!fingerInkEligible({
				isIosApp: Platform.isIosApp,
				isPhone: Platform.isPhone,
				toolPicked: toolPickedHere(),
				penInkEnabled: penInkEnabled(),
				tipMode: tipMode(),
				tool: inlineTool,
			})
		) return;
		this.router?.prepareFingerInk();
	}

	private ensurePenToolsInner(): void {
		const want =
			this.container !== null &&
			penToolsVisible(getPenToolsMode(), Platform.isMobileApp, penSeenThisSession());
		// A strip whose BUILD-TIME answers have moved is rebuilt, not left
		// standing. `ButtonSpec.shownOn` is read once per strip, and one of
		// the facts it reads has an edge - the first real pen contact latches
		// `penHardwareEverSeen`, which is what gives the device a Keyboard
		// button. (Since 1.4.12 that latch is also restored at load, before
		// any strip is built, from THIS DEVICE's local store under
		// `handwriting-device-pen-hardware-seen` - not from settings: an old
		// `data.json` key is deliberately ignored, because that file syncs
		// and a pen on one machine is not a pen on this one. So a device
		// that has already held a pen never reaches this edge at all.) On
		// mobile the strip already
		// exists by then (`penToolsVisible` is unconditionally true there), so
		// the create-or-destroy test below would answer "no change" and the
		// button would never appear. Dropping the strip here puts it through
		// the build path on the next line, which is the only path that reads
		// `shownOn` at all. At most once per session per strip: the latch
		// cannot go back down and a device does not grow a digitizer.
		if (want && this.mobileTools?.stale()) {
			this.mobileTools.destroy();
			this.mobileTools = null;
		}
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
   noteViewport: {
    getNoteViewportState:()=>this.getNoteViewportState(),
    zoomNoteBy:factor=>this.zoomNoteBy(factor),
    resetNoteZoom:()=>this.resetNoteZoom(),
    fitHandwriting:()=>this.fitHandwriting(),
   },
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
					// The trash acts on THIS overlay, never on whichever editor
					// `overlayForPath` would pick. That lookup answers the FIRST
					// mounted editor showing the note, so with two editors open
					// on the same file and this one active, routing the button
					// through the registered command (which resolves the
					// surface via `overlayForPath`) deleted - or refused to find
					// - the OTHER editor's selection instead of this strip's
					// own. The pdf strip's `stripExec` faced the identical
					// thing first (PdfInkController.ts) and answers it the same
					// way: the button knows its own overlay and asks it
					// directly. Same notice the registered command shows, off
					// the same `lassoDeleteNotice`, so the two paths can never
					// drift into two sentences for one outcome.
					else if (id === "handwriting:delete-selected-ink") {
						const said = lassoDeleteNotice(this.deleteSelectedInk());
						if (said) new Notice(said);
					}
					// Copy and cut for the same reason and by the same route. Cut is
					// the one that mattered most: routed through the command it
					// DELETED from whichever editor `overlayForPath` answered first,
					// which is not the one the button is sitting in. Both take their
					// sentence from the same helper the registered command uses, so
					// no wording is written twice.
					else if (id === "handwriting:copy-selected-ink") {
						// The copy runs either way; only the success sentence is routine.
						const copied = this.copySelectedInk();
						if (routineNoticesVisible() || !copySelectionNoticeIsRoutine(copied))
							new Notice(copySelectionNotice(copied));
					}
					else if (id === "handwriting:cut-selected-ink") {
						const outcome = this.cutSelectedInk();
						if (routineNoticesVisible() || !cutSelectionNoticeIsRoutine(outcome))
							new Notice(cutSelectionNotice(outcome));
					}
					// The eraser, lasso, insert-space and pan buttons run
					// commands that "Extra commands for hotkeys" keeps out of
					// the palette while it is off - executeCommandById would
					// find nothing and the buttons would be dead on a default
					// install. `runGatedCommand` holds exactly the actions
					// that were not registered, so it answers true only for
					// them (CommandPaletteSplit.ts).
					else if (!runGatedCommand(id)) commands.executeCommandById(id);
				}
			},
			activeTool: () => getInlineTool(),
			// The strip was dragged to an anchor: the same road the settings
			// dropdown takes, so the placement moves everywhere AND survives
			// a restart. The pdf host wires the identical call.
			setPlacement: (corner) => applyToolbarPlacement(corner),
			eraserOn: () => getInlineEraserMode(),
			eraserWholeStroke: () => getEraserWholeStrokes(),
			setEraserWholeStroke: (on) => {
				setEraserWholeStrokes(on);
				persistEraserMode?.(on);
			},
			lassoOn: () => getInlineLassoMode(),
			spaceOn: () => getInlineSpaceMode(),
			panOn: () => getInlinePanMode(),
			toolColor: (tool) => getInkColorHex(tool as InkTool),
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
			armMouseInkQuietly: () => armMouseInkQuietlyEverywhere(),
			disarmMouseInkQuietly: () => releaseMouseInkQuietlyEverywhere(),
			toast: (message) => {
				new Notice(message);
			},
			paletteFor: (tool) => colorsFor(tool as InkTool),
			pickColor: (name, hex) => pickStripColor(name, hex),
			// Quick pens: the list, and the three actions main registered.
			// Same wiring on the pdf strip, so a preset starred on a note is
			// the same preset on a pdf.
			presetsFor: (tool) => inkPresetsFor(tool as InkTool),
			applyPreset: (tool, index) => applyInkPreset(tool as InkTool, index),
			starPreset: (tool) => starInkPreset(tool as InkTool),
			forgetPreset: (tool, index) => forgetInkPreset(tool as InkTool, index),
			inkSizeMult: (tool) => getInkSizeMult(tool as InkTool),
			setInkSizeMult: (tool, mult, commit) => {
				setInkSizeMult(tool as InkTool, mult);
				if (commit) persistInkSize?.(tool as InkTool, getInkSizeMult(tool as InkTool));
			},
			// The pen-off button's other half: focus this editor inside the
			// button's own click so the software keyboard rises, blur it when
			// the pen comes back. `setKeyboardFocus` (InlineFocus.ts) rather
			// than a `.focus()` here - the note's focus rules live in that
			// module and StripPenChrome.test.ts's sweep is what keeps them
			// there.
			setEditorFocus: (focused) => setKeyboardFocus(this.view, focused),
			// This router gates on the flag (`penOff` above), so the flag is
			// the honest answer to "does the pen ink here" - the pdf host
			// answers the same read for the same reason (MobileTools.ts's
			// `penInksHere`, design §5).
			penInksHere: () => penInkEnabled(),
			// Capability, not current mode: Keyboard remains reachable after it
			// turns pen input off. PDF deliberately supplies no such capability.
			fingerInkAvailable: () => Platform.isIosApp && Platform.isPhone,
			// Close any native-scroll window while the toolbar contact is still
			// between gestures. Doing this at the next note pointerdown is too late:
			// WebKit has already snapshotted touch-action for that contact.
			prepareFingerInk: () => this.prepareFingerInk(),
			// The DEVICE's digitizer, not this pane's anything - the rule and
			// its reasoning live in DeviceInput.ts, and both surfaces read the
			// one implementation so a phone cannot get a different answer on a
			// note than it gets on a pdf.
			hasTouch: () => deviceHasTouch(),
		});
		// A strip born mid-session starts in the configured corner, not the
		// default one: ensurePenTools creates it on the first pen contact,
		// long after settings were read.
		this.applyToolbarCorner();
	}

	unmount(): void {
		if (diagnosticsEnabled() && this.undoIdentity) discardUndoTrace(this.undoIdentity);
		this.router?.dispose();
		this.router = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.contentResizeObserver?.disconnect();
		this.contentResizeObserver = null;
		this.originLineObserver?.disconnect();
		this.originLineObserver = null;
		this.originLine = null;
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
		this.restoreViewportLayout();
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
		// A remount puts a genuinely fresh screen in front of the reader, so
		// the refusal is allowed to speak once more on it.
		this.emptyNotice.forgetAll();
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
			if (diagnosticsEnabled() && this.undoIdentity) {
				discardUndoTrace(this.undoIdentity);
				unregisterUndoTraceView(this.view.dom);
				this.undoIdentity = null;
				this.undoIdentityStale = false;
			} else if (this.undoIdentity) {
				this.undoIdentity = null;
				this.undoIdentityStale = true;
			}
   this.restoreViewportLayout();
   this.pinchScaleNow=1; this.pinchRasterScale=1;
   this.pinchPending=null; this.pinchAnchor=null; this.pinchRefScale=null;
   this.view.scrollDOM.scrollLeft=0; this.view.scrollDOM.scrollTop=0;
   this.scrollExpansion?.rebase(0,0);
			this.lastPath = path;
			this.updateHandwritingPageClass();
			// A fresh note starts reading, so the strip starts as the pill.
			this.mobileTools?.closeInkSliders();
			this.mobileTools?.setCollapsed(true);
			this.builder = null;
			this.resetGestureState();
			// A different note has heard nothing yet, so the empty-page refusal
			// is news again. Here rather than inside resetGestureState, which an
			// abandoned gesture also runs - on the same note, mid-scrub.
			this.emptyNotice.forgetAll();
			// resetGestureState() only clears the overlay's own drawing state
			// (mode, selection, drag...). The router is a separate object with
			// its own gesture memory - an in-flight stroke and the pen-click
			// ownership guard it arms - that survives a file switch untouched
			// unless told otherwise, because Obsidian reuses this editor (and
			// this router) across notes.
			//
			// A stroke abandoned here (a claimed pen contact whose lift was
			// lost across the switch - a finger resting on the glass through
			// it, same shape as the click-suppressor bug this call already
			// fixes) called stripPenDown -> setInking(true) on the OLD note
			// and, because abandonActiveStroke ends the gesture without a
			// PointerEvent, never reaches the normal onPenUp -> penUp ->
			// stripPenUp -> setInking(false) that would put it back. That
			// leaves the strip and its collapsed pill wearing `is-inking`
			// (opacity 0, visibility hidden - styles.css ".is-inking") on the
			// NEW note: not merely invisible but unhit-testable, so every pen
			// tap on the toolbar strip lands on whatever is under it instead
			// and nothing happens. abandonActiveStroke() reports whether it
			// actually tore down a live stroke; only then is there stale
			// pen-down chrome to undo, so stripPenUp runs exactly then and a
			// routine switch with nothing to abandon stays the no-op it was.
			if (this.router?.abandonActiveStroke()) stripPenUp(this.mobileTools);
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
		const undoKind = diagnosticsEnabled() ? isUndoRedoKey(event) : null;
		if (undoKind) {
			if (this.undoIdentityStale) {
				unregisterUndoTraceView(this.view.dom);
				this.undoIdentityStale = false;
			}
			this.undoIdentity ??= registerUndoTraceView(this.view.dom, {});
			const selection = this.view.state.selection.main;
			const target = event.target instanceof Element && this.view.dom.contains(event.target) ? "editor" : "other";
			beginUndoWindow(this.undoIdentity, {
				kind: undoKind,
				key: {
					key: event.key.toLowerCase() as "z" | "y",
					ctrl: event.ctrlKey,
					meta: event.metaKey,
					shift: event.shiftKey,
					alt: event.altKey,
					defaultPrevented: event.defaultPrevented,
					target,
				},
				selection: {
					from: selection.from,
					to: selection.to,
					anchor: selection.anchor,
					head: selection.head,
					empty: selection.empty,
				},
				scroll: { x: this.view.scrollDOM.scrollLeft, y: this.view.scrollDOM.scrollTop, phase: "before", axes: "" },
			});
		}
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
				if (k === "c") {
					const n = this.copySelectedInk();
					if (n > 0) {
						event.preventDefault();
						if (routineNoticesVisible()) new Notice(`Handwriting: copied ${n} stroke(s)`);
						// The strip's paste button wakes now, without waiting for
						// the next tap or stroke.
						this.mobileTools?.refresh();
						return true;
					}
				} else {
					// Cut answers an outcome now, not a count: a copy that worked
					// followed by a removal that did not is neither a cut nor an
					// empty lasso, and `cutSelectionNotice` is what says so.
					const outcome = this.cutSelectedInk();
					if (outcome.kind !== "empty") {
						event.preventDefault();
						if (routineNoticesVisible() || !cutSelectionNoticeIsRoutine(outcome))
							new Notice(cutSelectionNotice(outcome));
						this.mobileTools?.refresh();
						return true;
					}
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
		if (n > 0 && routineNoticesVisible()) new Notice(`Handwriting: pasted ${n} stroke(s)`);
		return true;
	}

	handleKeyUp(event: KeyboardEvent): boolean {
		return this.selectionDeleteKeys.keyup(event);
	}

	/** Everything needed to identify the zoom mechanism from hardware. */
	zoomReport(): string {
		const rect = this.container?.getBoundingClientRect();
		const content = this.view.contentDOM.getBoundingClientRect();
		const originLeft = this.columnLeft();
		const cs = this.winRef.getComputedStyle(this.view.contentDOM);
		return [
			`file: ${this.filePath() ?? "(none)"}`,
			`devicePixelRatio: ${this.winRef.devicePixelRatio}`,
			`measured scale: ${this.scale}  (cssScale ${this.cssScale} × fontZoom ${this.fontZoom}; CM scaleX ${this.view.scaleX}, scaleY ${this.view.scaleY})`,
			`font: current ${this.lastFontStr || "(unread)"} reference ${this.refFontPx}px  camera zoom ${this.camera.zoom}`,
			`overlay rect: ${rect?.width.toFixed(2)} x ${rect?.height.toFixed(2)} (visual px)`,
			`overlay offset: ${this.container?.offsetWidth} x ${this.container?.offsetHeight} (layout px)`,
			`content rect left/width: ${content.left.toFixed(2)} / ${content.width.toFixed(2)}` +
				`  origin (column left, camera-facing): ${originLeft.toFixed(2)}`,
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
	setCanvasMomentumDisabled(on: boolean): void {
		this.router?.setCanvasMomentumDisabled(on);
	}

	containerEl(): Element | null {
		return this.container;
	}

	/**
	 * End a stroke that is live right now, committing it. The per-editor half
	 * of `endLiveStrokesEverywhere`, whose header carries the whole reasoning; a
	 * no-op when nothing is live, and no chrome call of its own because
	 * `finishActiveStroke` reaches `penUp()` through `onPenUp` and that is
	 * where the strip already comes down.
	 * `preserveMouse` keeps an owned mouse live for Keyboard-OFF; other callers
	 * use the default and commit immediately.
	 */
	endLiveStroke(preserveMouse = false): void {
		this.router?.finishActiveStroke({ preserveMouse });
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
  if(this.deferPinchRaster())return;
  this.mobileTools?.refresh();
  this.scrollExpansion?.rebase(this.view.scrollDOM.scrollLeft,this.view.scrollDOM.scrollTop);
  const layout=this.viewportLayout;
  if(layout&&layout.parent.clientWidth>0&&layout.parent.clientHeight>0&&this.viewportStyleDirty)this.scheduleViewportStyleRefresh();
  if(layout && !this.frame.locked && layout.parent.clientWidth>0 && layout.parent.clientHeight>0 &&
   (layout.parent.clientWidth!==layout.paneWidth||layout.parent.clientHeight!==layout.paneHeight)) {
   const width=layout.width+layout.parent.clientWidth-layout.paneWidth;
   const height=layout.height+layout.parent.clientHeight-layout.paneHeight;
   if(width>0&&height>0&&width/this.pinchScaleNow<=MAX_VIEWPORT_LAYOUT&&height/this.pinchScaleNow<=MAX_VIEWPORT_LAYOUT) {
    layout.width=width;layout.height=height;layout.paneWidth=layout.parent.clientWidth;layout.paneHeight=layout.parent.clientHeight;
    const host=this.view.dom;
    host.classList.remove("handwriting-note-viewport");
    host.setCssStyles({width:`${width}px`,height:`${height}px`});
    const style=this.winRef.getComputedStyle(this.view.contentDOM);
    const column=this.view.contentDOM.offsetWidth;
    if(column>0){layout.column=column;layout.left=style.marginLeft;layout.right=style.marginRight;}
    // Hidden editors release their backings and invalidate geometry. Restore
    // the full physical viewport before navigation can reject that stale state,
    // then let the common resize path measure and rebuild the visible surface.
    this.applyViewportBox(this.pinchScaleNow);
    if(this.scaleGeometryValid!==false&&this.commitCameraScale(this.pinchScaleNow))return;
   }
  }
		this.clearSnapPreview();
		if (!this.container) return;
		if (scrollExpansionEnabled) this.lastExtentInputs = null;
		// The container no longer inherits the editor's box, so its size is
		// whatever syncBand last wrote. Resize it FIRST or every measurement
		// below - including the zero-size check that releases the backings in
		// a background tab - reads the previous viewport's band.
		this.syncBand();
		const prevScale = this.scale;
		const rect = this.container.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) {
			if (!this.frame.locked) {
				this.scaleGeometryValid = false;
				this.router?.cameraTransformChanged();
			}
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
		const measuredCssScale = ownedEffectiveScale({
			visualWidth: rect.width,
			layoutWidth: this.container.offsetWidth,
			cmScaleX: this.view.scaleX,
		}, this.pinchScaleNow);
		if (measuredCssScale === null) {
			if (!this.frame.locked) {
				this.scaleGeometryValid = false;
				this.router?.cameraTransformChanged();
			}
			return;
		}
		// Quick-font-size zoom (Ctrl+scroll / touchpad pinch) is a reflow:
		// dpr and the transform scale both stay put while the text grows.
		// The current/mount-time font ratio is the missing zoom factor.
		this.contentStyle ??= this.winRef.getComputedStyle(this.view.contentDOM);
		this.lastFontStr = this.contentStyle.fontSize;
		const fontPx = Number.parseFloat(this.lastFontStr);
		if (this.refFontPx <= 0 && Number.isFinite(fontPx) && fontPx > 0) {
			this.refFontPx = fontPx;
		}
		const measuredFontZoom = fontZoomFactor(fontPx, this.refFontPx);
		// A STROKE IN FLIGHT OWNS ITS COORDINATE FRAME, and `cssScale` is
		// half of that frame: the router divides every sample by it
		// (`scaleProvider`, InlinePenRouter.sampleFrom) and the camera that
		// inverts the result is frozen at pen-down. Writing it here moved the
		// divisor under a stroke that could not follow, so every sample after
		// the resize landed at a different note point than the same finger
		// position did before it - the rest of the letter jumping toward the
		// top-left, mid-stroke. That is the same shear `scrollFn` refuses by
		// not refreshing the router's rect mid-stroke and `syncBand` refuses
		// by returning early, and this method was the one geometry path left
		// that did it anyway. `UnsettledDocumentTop.test.ts` pins it: a 1.5x
		// resize under a planted pen moved one client point 66.7 note px.
		//
		// Nothing is deferred for long. `syncCamera` re-measures the scale
		// from its own rect read on every sync rather than trusting anything
		// cached here (see its comment below), so the first unlocked sync
		// after pen-up adopts both numbers - which pen-up reaches through the
		// commit's own repaint. The BACKING below is computed from the
		// measured values regardless, so canvas resolution is unaffected and
		// the reallocation path behaves exactly as it did.
		if (!this.frame.locked) {
			this.scaleGeometryValid = true;
			if (Math.abs(measuredCssScale - this.cssScale) > this.cssScale * SCALE_EPSILON)
				this.router?.cameraTransformChanged();
			this.cssScale = measuredCssScale;
   if(this.viewportLayout && Math.abs(measuredCssScale/this.pinchScaleNow-this.viewportLayout.externalScale)>SCALE_EPSILON) this.viewportLayout.externalScale=measuredCssScale/this.pinchScaleNow;
			this.fontZoom = measuredFontZoom;
			this.scale = this.cssScale * this.fontZoom;
			this.updatePaperSpacing();
		}
		const layoutW = this.container.offsetWidth || rect.width;
		const layoutH = this.container.offsetHeight || rect.height;
		// Backing resolution: device px per SCREEN css px. The font zoom is
		// GEOMETRY (applied by the camera before rasterization), not
		// resolution. Folding it in here was the part-2 bug's sibling.
		const backing = backingScale(
			this.dpr,
			measuredCssScale,
			layoutW,
			layoutH,
			Platform.isMobileApp
		);
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
			// Not while a stroke owns the frame, for the reason below and for
			// `scrollFn`'s: the rect the router maps through and the camera
			// that inverts the result froze together at pen-down, and
			// refreshing one without the other IS the mismatch the frozen
			// pipeline exists to prevent. The next pen-down refreshes it
			// (:2776), which is the same guarantee the scroll handler relies
			// on.
			if (!this.frame.locked) this.router?.refreshRect();
			// `ResizeObserver` fires on SIZE changes only. Readable line length
			// caps `.cm-content` at `--file-line-width` and centres it in the
			// scroller, so opening or closing a sidebar at constant pane width
			// re-centres the column without moving anything `unchanged` just
			// compared - band, canvas dims and cssWidth/cssHeight all stay put,
			// and neither ResizeObserver's callback fires either (nothing sized).
			// This is the only path left that runs on every geometry-relevant
			// tick, so it is where a shifted COLUMN actually gets noticed.
			// The other half of the origin, the document top, is NOT checked
			// here and could not usefully be: it moves with nothing resizing
			// at all, so this callback is not reached in its failing case.
			// `syncCamera` notices that one, against the camera the pixels
			// were painted with.
			// Same frame guard as contentResizeObserver's callback: a stroke in
			// flight owns its coordinate frame and must not have the camera
			// moved under it.
			if (!this.frame.locked) {
				const contentLeft = this.columnLeft();
				if (Math.abs(contentLeft - this.lastSyncContentLeft) > CONTENT_ORIGIN_EPSILON) {
					this.syncCamera();
					this.scheduleRepaint("content-resize");
				}
			}
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
		// Same guard as the unchanged arm's: re-basing the router's rect
		// mid-stroke shifts every sample after it while the camera stays
		// frozen. The backings above are reallocated either way - that blanks
		// pixels, which the repaint below restores, and moves nothing.
		if (!this.frame.locked) this.router?.refreshRect();
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

	/**
	 * The backing factor every canvas and every probe must agree on. One
	 * accessor because five call sites computed it independently: if they
	 * ever disagreed, ink would rasterise at one resolution and be drawn
	 * through a transform built for another.
	 */
	private backingNow(layoutW?: number, layoutH?: number): number {
		const w = layoutW ?? this.container?.offsetWidth ?? 0;
		const h = layoutH ?? this.container?.offsetHeight ?? 0;
		return backingScale(this.dpr, this.cssScale, w, h, Platform.isMobileApp);
	}

	/**
	 * Turn the scan's answer into the number the camera can actually use.
	 *
	 * ONE rule for six call sites. `contentOrigin` reports COLUMN NOT FOUND
	 * (`left: null`) when nothing in the rendered viewport has a width - a
	 * viewport of collapsed markers, a detached editor, a fixture. Before
	 * 1.4.10 it answered `.cm-content`'s own left there, which under a theme
	 * that caps `.cm-content` is the same number and under Minimal is the PANE
	 * edge: a 380px jump at a 1400px pane, applied to a camera that was
	 * correct a frame earlier. Keeping the last origin the scan DID find is
	 * strictly better, because the column has not moved just because this
	 * frame could not see it. The `.cm-content` fallback survives only for the
	 * very first sync, where there is no last good value and a wrong guess is
	 * still better than NaN.
	 */
	private resolveColumnLeft(left: number | null): number {
		if (left !== null) {
			this.lastGoodColumnLeft = left;
			return left;
		}
		return (
			this.lastGoodColumnLeft ?? this.view.contentDOM.getBoundingClientRect().left
		);
	}

	/** `resolveColumnLeft` over a fresh scan, for the sites that only paint. */
	private columnLeft(): number {
		return this.resolveColumnLeft(contentOriginLeft(this.view.contentDOM));
	}

	/**
	 * The origin line changed size. Re-sync the camera, and repaint ONLY if
	 * the column actually moved.
	 *
	 * The guard is the one `handleResize`'s `unchanged` arm already uses, and
	 * it is here for the same reason it is there, only more urgently.
	 *
	 * This observer is re-pointed from `syncCamera`, and
	 * `ResizeObserver.observe` delivers one callback for a NEWLY observed
	 * element on the next frame whatever its size - the spec starts its
	 * `lastReportedSize` at 0x0, so the first delivery is unconditional. Every
	 * frame that re-points the watch therefore also arms a callback. Under a
	 * theme where the sampled lines share a left edge the scan's tie rule
	 * (strict `>`) keeps the FIRST sampled line, and CodeMirror replaces the
	 * leading `.cm-line` div on every viewport re-render, so a scroll re-points
	 * the watch several times a second.
	 *
	 * Repainting unconditionally from here cost `damage.addAll()` plus
	 * `indexDirty = true` on each of those - a full re-rasterization of every
	 * visible stroke and an index rebuild - per viewport re-render during a
	 * scroll, and again on a cursor move that changes the first line's height
	 * (a heading, or a wrapping paragraph revealing its markup). Before this
	 * observer existed a scroll cost one "scroll" repaint. It costs one again.
	 *
	 * A callback where the column really did move still repaints, which is the
	 * entire reason the observer exists: `MinimalResync.test.ts` measures three
	 * routes by which Minimal moves the column while nothing else fires.
	 */
	private originLineResized(): void {
		if (!this.container || this.frame.locked) return;
		const before = this.lastSyncContentLeft;
		this.syncCamera();
		if (Math.abs(this.lastSyncContentLeft - before) > CONTENT_ORIGIN_EPSILON) {
			this.scheduleRepaint("content-resize");
		}
	}

	/**
	 * Point `originLineObserver` at the line the origin scan just picked.
	 *
	 * Called from `syncCamera` on every sync, which is the cheapest place it
	 * can live: the scan has already run, so this is a reference comparison
	 * and, on the rare frame where CodeMirror recycled the line out from
	 * under us, one `unobserve` plus one `observe`. Nothing here reads
	 * layout, nothing scales with the length of the note, and it is never
	 * reached from a pointermove or a keystroke path that does not already
	 * sync the camera.
	 *
	 * `left` is the column edge THIS sync measured. It is passed rather than
	 * re-read because the scan already has it, and because the comparison
	 * below has to happen before `syncCamera` overwrites
	 * `lastSyncContentLeft` with it.
	 */
	private watchOriginLine(line: Element | null, left: number): void {
		if (line === this.originLine) return;
		const observer = this.originLineObserver;
		// Not mounted, or already torn down: leave `originLine` alone so a
		// late sync cannot leave a stale element recorded as watched.
		if (!observer) return;
		// COLUMN NOT FOUND this frame. The watch is the only thing that will
		// tell us the column moved, so dropping it here would disarm the
		// re-sync for exactly as long as the viewport stays unmeasurable -
		// and the element we were watching is usually still the column, just
		// scrolled out of a viewport full of collapsed markers. Keep it while
		// it is still in the document; a recycled or removed line is dropped.
		if (line === null && this.originLine?.isConnected) return;
		// A DIFFERENT element at the SAME left edge. That is the ordinary
		// scrolling case rather than a moved column: CodeMirror replaces the
		// leading `.cm-line` div on every viewport re-render, and where the
		// sampled lines share a left edge the scan's tie rule (strict `>`)
		// keeps whichever one it saw first - so the scan hands back a
		// scroll-fresh div at the identical position several times a second.
		// Re-pointing there costs an `unobserve` and an `observe` per tick,
		// and `observe()` arms a delivery for a newly observed element on the
		// next frame no matter what its size, so the churn is what was
		// manufacturing the callbacks in the first place. Keeping the
		// observation stops them at the source; `originLineResized`'s epsilon
		// guard is what makes the ones that still arrive cheap.
		//
		// `lastSyncContentLeft` is the PREVIOUS sync's answer - the edge the
		// still-observed line was measured at - and `left` is this sync's, so
		// the comparison costs no rect read of its own. A line that has left
		// the document is not kept: a stale observation on a detached div is a
		// watch on nothing, and the next sync re-points it.
		if (
			line !== null &&
			this.originLine?.isConnected &&
			Math.abs(left - this.lastSyncContentLeft) <= CONTENT_ORIGIN_EPSILON
		) {
			return;
		}
		if (this.originLine) observer.unobserve(this.originLine);
		this.originLine = line;
		if (line) observer.observe(line);
	}

	/**
	 * Pin the camera so world == note surface: the camera holds the surface
	 * point currently at the overlay's top-left. `documentTop` is CM's public
	 * "top of the document in screen coordinates", so this is two subtractions.
	 * No scrollTop bookkeeping; padding is handled by CM - see `anchorTop` for
	 * the one frame in which CM's own answer for it is not yet true.
	 */
	private syncCamera(): void {
		if (this.deferPinchRaster()) return;
		if (!this.container) return;
		// A stroke in flight owns its coordinate frame until it ends.
		if (this.frame.locked) return;
		const overlay = this.container.getBoundingClientRect();
		// One scan, two uses: the number the camera paints against, and the
		// element that has to be watched for it to change. CodeMirror recycles
		// `.cm-line` divs, so the watch is re-pointed from here rather than
		// installed once - and since the scan has just run anyway, the re-arm
		// costs one reference comparison on the frames where it did not move.
		const origin = contentOrigin(this.view.contentDOM);
		const contentLeft = this.resolveColumnLeft(origin.left);
		this.watchOriginLine(origin.line, contentLeft);
		// THE ANCHOR THE TEXT IS LAID OUT WITH, which for one frame is not the
		// anchor CodeMirror reports.
		//
		// `view.documentTop` is `contentDOM.getBoundingClientRect().top +
		// viewState.paddingTop`, and that second term is a BELIEF: 0 from
		// construction until CodeMirror's first measure cycle writes the
		// computed value into it, a cycle reached only from the rAF the
		// constructor requests. The CSS padding is in force the whole time, so
		// in that window the top is short by the padding while the text has not
		// moved at all - and a stroke stored there is stored that far off its
		// own line, for good, because the store is what persists. Measured on a
		// real editor at `test/render/UnsettledTopMechanisms.test.ts`: with
		// Minimal's 8px the belief is 0, the stylesheet says 8, one frame later
		// the top has moved by exactly 8, and the `.cm-line` has not moved.
		//
		// The heal at the end of this method cannot reach it. That compare
		// re-rasterizes so the picture and the eraser agree about where the ink
		// IS; it cannot put the ink back on the line, because by then the wrong
		// number is already in the stored coordinate. This is the half that has
		// to be right at store time.
		//
		// Only the PADDING term is replaced. The rect term passes through
		// untouched on purpose: when something above `.cm-content` grows, the
		// content and every line in it move together, so ink stored before it
		// is still on its line and correcting for that would move correct ink
		// off the words (mechanism R in the same file).
		//
		// `this.contentStyle` is the live `getComputedStyle(contentDOM)` object
		// `handleResize` already holds and this method already reads `fontSize`
		// off a few lines down, so the cost is one more property read after the
		// rects above have forced layout, and no `getComputedStyle` call. Absent
		// only before the first `handleResize` has run, and `anchorTop` falls
		// back to CodeMirror's own answer there.

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
		const measured = ownedEffectiveScale({
			visualWidth: overlay.width,
			layoutWidth: this.container.offsetWidth,
			cmScaleX: this.view.scaleX,
		}, this.pinchScaleNow);
		if (measured === null) {
			this.scaleGeometryValid = false;
			this.router?.cameraTransformChanged();
			return;
		}
		this.scaleGeometryValid = true;
		const documentTop = anchorTop(this.view, this.contentStyle?.paddingTop, measured);
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
			this.router?.cameraTransformChanged();
			this.cssScale = measured;
   if(this.viewportLayout && Math.abs(measured/this.pinchScaleNow-this.viewportLayout.externalScale)>SCALE_EPSILON) this.viewportLayout.externalScale=measured/this.pinchScaleNow;
		}
		// And the FONT zoom, which until 1.4.10 only `handleResize` ever
		// wrote. The two observers do not fire together: changing the editor
		// font size makes the lines taller, which resizes `.cm-content` and
		// not `.cm-editor`, so `contentResizeObserver` fires alone and lands
		// here with `this.fontZoom` still describing the old font. The camera
		// was then rebuilt with a scale short by the whole font ratio - 48px
		// of displacement at a 1400px pane going 16px to 20px, measured in
		// `test/render/MinimalCameraScale.test.ts`, and theme-independent:
		// Minimal and stock produce the same number to six places.
		//
		// One string compare against the style object `handleResize` already
		// holds, so a sync where the font did not change costs a property read
		// and a comparison and no new style object. `refFontPx` is NOT touched
		// here: it latches at mount and is what every persisted coordinate on
		// the note is expressed against.
		//
		// Against `lastSyncFontStr` and not `lastFontStr`: that field is how
		// `update()` decides to call `handleResize` on a font change, and
		// writing it here consumed the difference before `update()` could see
		// it. See the field's own comment.
		const fontStr = this.contentStyle?.fontSize;
		if (fontStr !== undefined && fontStr !== this.lastSyncFontStr) {
			this.lastSyncFontStr = fontStr;
			this.fontZoom = fontZoomFactor(Number.parseFloat(fontStr), this.refFontPx);
		}
		// Unconditionally, not inside the epsilon branch above: the font zoom
		// can move on a frame where the css scale did not, and leaving
		// `this.scale` stale there was half of the same defect.
		this.scale = this.cssScale * this.fontZoom;
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
		// THE ORIGIN MOVED SINCE THE PIXELS WERE DRAWN. Ask for the frame that
		// redraws them.
		//
		// Ink is anchored to two numbers and nothing else - the text column's
		// left edge and the document top - and both of them are in this
		// camera (`UnsettledDocumentTop.test.ts` derives that identity through
		// this method and the router). The column has had a compare since
		// Minimal: `handleResize`'s unchanged arm and `originLineResized`,
		// both against `lastSyncContentLeft`, both scheduling a repaint. The
		// document top had NONE, and that was a real defect rather than a
		// theoretical one. CodeMirror's `viewState.paddingTop` is 0 until its
		// first measure cycle, and Obsidian's inline title, its properties
		// block and any font swap all sit ABOVE `.cm-content` and settle on
		// their own schedule - so on a fresh mount the top moves at a fixed
		// scroll position, and something above `.cm-content` growing does not
		// RESIZE `.cm-content`, `.cm-editor` or the watched `.cm-line`. No
		// observer fires. The camera then adopted the new top at the next
		// sync for any reason, NOTHING repainted, and committed ink went on
		// being drawn where the old top put it - so the eraser probed where
		// the ink is not, found nothing, and returned silently on a page
		// whose store is not empty (alan, relaying the owner, 1.4.11).
		//
		// AGAINST `lastPaintCam`, AND NOT AGAINST `lastSyncDocumentTop`. The
		// document top is a SCREEN coordinate: `contentDOM
		// .getBoundingClientRect().top + paddingTop`, which CodeMirror
		// documents as going negative when the editor is scrolled down. It
		// moves by the whole delta on every scroll, so comparing it directly
		// would ask for a repaint on every scrolled frame - and, with a via
		// that asserts damage, a full re-rasterization of every visible
		// stroke plus an index rebuild per frame, on a plugin that runs on
		// e-ink. Measured against the tests below, that cut asked for twelve
		// repaints where this one asks for two. The camera origin is that
		// number minus the band's own rect top, and the band lives INSIDE the
		// scroller, so both terms move together and the origin is exactly
		// still through a scroll. It moves when the anchor really moved,
		// which is the event this is for.
		//
		// `lastPaintCam` is the camera the committed layer was last drawn
		// with (set in `repaint`, cleared when a reallocation blanks the
		// canvases), so this compares what the pixels say against what the
		// camera now says - exactly, and on the same three fields `repaint`
		// uses to decide the same question one step later. Absent means
		// nothing has been painted yet, and nothing painted cannot be stale;
		// truthiness rather than `!== null` because the prototype-built
		// fixtures that exercise this method leave the field off entirely,
		// and "no recorded paint" is the right reading of that too.
		//
		// "scroll" as the via ON PURPOSE. It asserts no damage and does not
		// dirty the index (the index is in world space; the camera cannot
		// stale it), and `repaint` upgrades ANY camera motion to a full
		// redraw by itself. So the frame this queues costs a full re-raster
		// exactly when one is needed, and costs an empty callback when this
		// call was already inside the repaint that is about to fix it.
		// The three getters and not `camera.snapshot`: that one spreads a
		// fresh object every call, and this runs on every scrolled frame.
		const painted = this.lastPaintCam;
		if (
			painted &&
			(painted.x !== this.camera.x ||
				painted.y !== this.camera.y ||
				painted.zoom !== this.camera.zoom)
		) {
			this.scheduleRepaint("scroll");
		}
	}

	// ---- pen path (frozen pipeline) ----------------------------------------

	private penDown(sample: PenSample, ev: PointerEvent): void {
		// A new owned gesture invalidates any previous camera/reveal continuation.
		this.viewportGeneration++;
		this.clearSnapPreview();
		// The router cancels pointerdown so the pen cannot move CodeMirror's
		// caret. That also cancels native focus. Give keyboard ownership back to
		// this editor before freezing geometry, or Delete and undo go wherever
		// focus happened to be before the pen landed.
		if (ev.pointerType !== "touch") {
			focusClaimedPenEditor(this.view, Platform.isMobileApp);
		}
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
		// already, so only the hide was one-sided. Shared with the pdf
		// surface (StripPenChrome.ts, §5o) so the two cannot diverge again.
		stripPenDown(this.mobileTools);

		// The pen decides what it is at contact (§52/§53, mode-free):
		// eraser end erases, side button held lassos/moves, tip inks - and
		// each of those meanings also has a strip mode, for hardware that has
		// neither button. The whole arbitration is `penContactIntent`
		// (TipMode.ts), ONE implementation shared with the pdf surface, which
		// had its own hand-written copy of these three lines. It answers with
		// the mode too, so the pan and space branches further down read the
		// same value rather than re-asking `tipMode()` behind their own
		// `!eraser` guards.
		// Before the branches, so the three in-gesture reticle wrappers can
		// read it whichever gesture this turns out to be - the pdf writes its
		// own in the same place, ahead of its own `penContactIntent` call.
		this.mouseStroke = ev.pointerType === "mouse";
		const intent = penContactIntent(ev.buttons, ev.button, tipMode());
		const eraser = intent === "erase";
		if (intent === "lasso") {
			this.mode = "lasso";
			this.lassoDown(sample);
			return;
		}
		// A bare tip landing INSIDE an active selection drags it - OneNote's
		// grammar (alan, 2026-08-27): the side button selects, then either
		// the tip or the held side button moves. Outside, the tip dissolves the
		// selection and inks, same as always. Esc backs out without a move.
		//
		// BARE is the load-bearing word and the test below did not carry it:
		// an eraser is not a bare tip, so it must not be swallowed here. Left
		// out, the ink a user had just lassoed was the one ink on the page the
		// eraser could not reach - it dragged the selection instead, on every
		// contact, with no way out but dismissing the selection first. The
		// rule was already written three lines down ("Tip and eraser return
		// the pen to normal behavior"); only the code disagreed with it.
		if (ev.pointerType !== "touch" && !eraser && !this.selection.isEmpty) {
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
			if (this.eraseFrom.length === 0) {
				// A gesture that touches nothing is indistinguishable from a
				// broken one - the same lesson insert-space paid an evening of
				// hardware testing to learn. This page has no ink at all, so
				// the whole gesture is guaranteed to find nothing, whichever
				// way the eraser moves; say so once, right here, rather than
				// leaving the eraser to look dead for however long it drags.
				//
				// ONCE PER PAGE, not once per contact, and only when the store
				// is CERTAIN the page is empty. An empty `eraseFrom` used to
				// be treated as proof of both, and it is proof of neither: an
				// eraser scrub re-lands the nib every few hundred ms (each
				// re-land a fresh pointerdown, and so a fresh toast), and a
				// note whose sidecar has not been read yet holds zero strokes
				// here while showing ink on screen. Both halves of Alan's
				// 1.4.12 report - the spam, and "even though there is" - are
				// in this one line; the rules are in EmptyPageNotice.ts and
				// `InlineInkStore.inkPresence`.
				this.sayIfPageEmpty(here, "erase");
			}
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
		if (intent === "pan") {
			this.mode = "pan";
			// A pan MOVES the surface under the ink, so the frame must stay
			// live: the lock exists to stop reflow shearing a stroke, and
			// here there is no stroke - freezing it would leave the ink
			// behind the scroll until pen-up.
			this.frame.cancel();
			this.panLast = { x: ev.clientX, y: ev.clientY };
			// NO RETICLE THROUGH A PAN, unlike the eraser and the lasso above.
			// The ring used to be driven from here and from every raw batch,
			// and it flung itself away from the nib as the drag went on
			// (alan, 2026-09-05, hardware: "pan reticle allows you to like
			// fling it away from the point of pan and it flickers"). The whole
			// mechanism, and the rule that replaced it, is written down once
			// at `penReticleShown` (PenCursor.ts); the short version is that a
			// pan is the one gesture that scrolls the overlay out from under
			// the frozen rect its samples are mapped through, so there is no
			// coordinate here worth painting. The grabbing hand says what the
			// ring was there to say.
			this.beginPanDragCursor();
			return;
		}
		if (intent === "space") {
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
		const fromMouse = this.mouseStroke;
		const fromFinger = ev.pointerType === "touch";
		const widthMode: StrokeWidthMode | undefined = fromFinger ? "uniform" : undefined;
		const widthPolicy = strokeWidthPolicy(this.activeStyle, widthMode);
		this.activeStyle = widthPolicy.style;
		// Same split as showPenCursor: the strip appears for any stroke, but
		// only a real pen proves the tip inks without mouse ink. A mouse
		// stroke reaches here whenever mouse ink is armed, and marking that
		// as hardware is the second of the two writers that left the nib
		// light stuck on. The iPhone finger reaches this same ink path now,
		// but it proves neither pen hardware nor mouse intent and marks neither.
		if (ev.pointerType === "pen") markPenHardwareSeen();
		else if (ev.pointerType === "mouse") markPenSeen();
		this.ensurePenTools();
		// The strip stepped aside at contact, above; a strip only just created
		// by ensurePenTools has not heard that yet, so tell it now.
		// stripPenDown, not a bare setInking: closeInkSliders is a no-op on a
		// strip that was just built (nothing on it can be open yet), so
		// calling the pair again here is exactly today's behaviour.
		stripPenDown(this.mobileTools);
		this.activeWet = tool === "highlighter" ? this.highlightWet : this.wet;
		// The wet layer's shaping follows the device per stroke: a mouse
		// stroke draws flat live, exactly as it will commit.
		// The same question `mouseStroke` was just asked, read back rather than
		// re-derived: two spellings of one fact in one method is how they come
		// apart.
		this.wet.shape = widthPolicy.shapeWidth && !fromMouse;
		// A mouse's constant 0.5 is neither evidence about the pen hardware
		// nor something to amplify: gain 1, and its max is never reported.
		this.strokeGain = fromMouse || fromFinger ? 1 : strokeGain();
		this.strokeRawMax = 0;
		this.strokePenGesture = !fromMouse && !fromFinger;
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
			fromMouse ? "mouse" : undefined,
			widthMode
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
			// The tool's flatness travels with the stroke. Inferring it from
			// the layer's `shape` made every MOUSE stroke look flat, so mouse
			// ink drew smoothed and committed raw whenever the setting was
			// off - the case the line above exists to protect.
			this.ribbonPressure = point.pressure;
			this.activeWet.beginStroke(point, this.activeStyle, tool === "highlighter", this.builder.resolvedPressureProfile);
			// A tap that never moves produces no rawupdate, so without this the
			// dot only appears at pen-up. Draw the contact point immediately.
			//
			// This is the ONE head draw that is not gated on `head()`, so for
			// a tap it is the whole visible mark - which is why it asks for
			// `contactHalfWidth` and not the bare live width. The floor lives
			// in there; nothing about it is computed here.
			this.tail.clear();
			this.tail.drawHead(
				this.camera.snapshot,
				this.activeStyle,
				{ x: point.x, y: point.y },
				{ x: point.x, y: point.y },
				point.pressure,
				this.activeWet.contactHalfWidth(this.activeStyle, point.pressure)
			);
			this.probeSample(sample, ev, point, 1, true, "down");
		}
		this.beginSnapPreview(sample, ev);
		noteProbeStroke();
	}

	/** The builder and note are captured once; a stale timer cannot follow either. */
	private beginSnapPreview(sample: Pick<PenSample, "x" | "y">, ev: PointerEvent): void {
		this.clearSnapPreview();
		if (!shapeSnapOn || ev.pointerType !== "pen" || !this.strokePenGesture || !this.builder || !this.container) return;
		const builder = this.builder;
		const path = this.filePath();
		if (!path) return;
		const tool = inlineTool;
		const color = getInkColorHex(tool);
		const size = getInkSizeMult(tool);
		this.snapContactId = ev.pointerId;
		this.snapCanvas ??= new SnapPreviewCanvas();
		this.snapPreview = new SnapPreview({
			clock: this.winRef,
			valid: () => shapeSnapOn && this.builder === builder && this.strokePenGesture && this.mode === "ink" &&
				this.filePath() === path && !!this.container && inlineTool === tool &&
				getInkColorHex(tool) === color && getInkSizeMult(tool) === size,
			snapshot: () => builder.snapshotReleaseFiltered(),
			show: stroke => !!this.container && this.snapCanvas!.show(this.container, this.camera.snapshot,
				stroke, this.cssWidth, this.cssHeight, this.backingNow()),
			hide: () => this.snapCanvas?.clear(),
		});
		this.snapPreview.start(sample.x, sample.y);
	}

	clearSnapPreview(): void {
		this.snapPreview?.clear();
		this.snapPreview = null;
		this.snapContactId = null;
		this.snapCanvas?.clear();
	}

	private penRaw(samples: PenSample[], ev: PointerEvent): void {
		if (this.mode === "lasso") {
			this.lassoMove(samples);
			// Last sample only, matching the erase branch below: one DOM
			// write per batch, and every call re-arms the watchdog for the
			// length of the drag.
			const last = samples[samples.length - 1];
			if (last) this.showLassoCursor(last);
			return;
		}
		if (this.mode === "space") {
			this.spaceMove(samples);
			// Last sample only, same reasoning as lasso and erase.
			const last = samples[samples.length - 1];
			if (last) this.showSpaceCursor(last);
			return;
		}
		if (this.mode === "pan") {
			// SCROLLS AND NOTHING ELSE. Unlike the lasso and space branches
			// above, this handler positions no reticle - it is the handler
			// that made the ring fly, because `samples` are mapped through the
			// rect the router froze at pen-down and this line is what scrolls
			// the overlay out from under it. `penReticleShown` (PenCursor.ts)
			// carries the reasoning and Alan's rule; `PenCursor.test.ts` reads
			// this branch's source and fails if a reticle call comes back.
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
			this.snapPreview?.move(s.x, s.y);
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
				this.ribbonPressure = point.pressure;
				this.activeWet.appendPoint(cam, this.activeStyle, point);
				lastAccepted = point;
				accepted++;
			}
		}
		const drawEnd = performance.now();
		const newestTs = samples[samples.length - 1]!.timestamp;
		metrics.recordAccepted(accepted);
		metrics.recordDraw(drawEnd - drawStart, drawEnd - newestTs);

		// Live raw head, exactly as the approved pipeline draws it - and at
		// the width the ribbon under it is being laid down at, which the wet
		// layer reports rather than the head guessing from raw pressure.
		this.tail.clear();
		const head = this.activeWet.head();
		if (head) {
			this.tail.drawHead(
				cam,
				this.activeStyle,
				head.from,
				head.to,
				head.pressure,
				this.activeWet.liveHalfWidth(this.activeStyle, head.pressure)
			);
		}
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
			//
			// `ribbonPressure`, not `newest.pressure`: the ribbon is fed
			// `gainedPressure`, so raw pressure is an input it never saw and
			// the two disagree wherever the gain is not 1. The argument is
			// dead on the shaped branch - `liveHalfWidth` returns
			// `shaper.last()` there - so what this corrects is the UNSHAPED
			// branch: every mouse stroke and every highlighter.
			this.activeWet.liveWidthPx(cam, this.activeStyle, this.ribbonPressure)
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
	 *
	 * Through `anchorTop`, for the same reason every other word here says
	 * "twin": a diagnostic that took its y from a different anchor than the
	 * camera does would report a displacement of the padding on the one frame
	 * where the two numbers disagree, and there is nothing displaced there.
	 */
	private freshFrame(): { x: number; y: number } | null {
		if (!this.container) return null;
		const overlay = this.container.getBoundingClientRect();
		const contentLeft = this.columnLeft();
		const documentTop = anchorTop(this.view, this.contentStyle?.paddingTop, this.cssScale);
		return {
			x: visualToNote(overlay.left - contentLeft, this.scale),
			y: visualToNote(overlay.top - documentTop, this.scale),
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

	/**
	 * `ev` is the pointerup/pointercancel that ended the gesture, ABSENT when
	 * it ended without one (`finishActiveStroke`: a window blur, a note
	 * switch). This call site used to drop it - `onPenUp: () => this.penUp()`
	 * - and the pan branch needs it: the one place the pointer's CURRENT
	 * position exists at release is that event. A blur has no lift and no
	 * position, which is what `undefined` says, and nothing is synthesised in
	 * its place (the callback's own header, InlinePenRouter.ts, argues that at
	 * length for the pdf's final stroke point).
	 */
	private penUp(ev?: PointerEvent): void {
		// Whatever the gesture was, it is over: the frame is live again and
		// re-reads the editor's current origin.
		this.frame.end();
		if(this.viewportStyleDirty)this.scheduleViewportStyleRefresh();
		// The stroke is over: the strip returns (a beat later, so an eraser
		// scrub's rapid lift-and-reland does not strobe it) and its buttons
		// catch up with what undo can do now. The catch-up is a microtask,
		// NOT immediate: every branch below this line dispatches its ops
		// later in this same method, so a synchronous refresh here reads the
		// history depth from BEFORE the gesture - after the first stroke on
		// a fresh note, a working undo button kept wearing the disabled look
		// that issue #1 was filed about. The microtask runs once penUp and
		// all its dispatches have returned, whichever branch they took.
		// Shared with the pdf surface (StripPenChrome.ts, §5o).
		stripPenUp(this.mobileTools);
		if (this.mode === "pan") {
			// The mode goes back FIRST, before the reticle is restored below:
			// `showPenCursor` refuses to paint while `mode` says a pan drag is
			// live (`penReticleShown`), which is the whole point of that gate.
			this.mode = "ink";
			this.panLast = null;
			// Takes the grabbing hand off with it - `hidePenCursor` drops both
			// scroller classes - so the surface is left in exactly the state a
			// hover would find it in, and the restore below puts the ring back
			// under the pointer.
			this.hidePenCursor();
			this.restoreReticleAfterPan(ev);
			this.updateExtent(true);
			return;
		}
		if (this.mode === "space") {
			this.mode = "ink";
			// Same reasoning as pan above.
			this.hideSpaceCursor();
			this.spaceUp();
			this.updateExtent(true);
			return;
		}
		if (this.mode === "lasso") {
			this.mode = "ink";
			// Same reasoning as pan and space above.
			this.hideLassoCursor();
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
			// The successful erase already explained why this note is empty.
			// Consume the episode after save/change notifications have settled.
			if (inlineInk.inkPresence(path) === "none") this.emptyNotice.claim(path, "erase");
			return;
		}
		metrics.end(performance.now());
		this.stopFrameTicker();
		const builder = this.builder;
		const wasPen = this.strokePenGesture;
		// Finish before clearing the wet layer. Release filtering may produce
		// several stored strokes from one contact, but every committed segment
		// is drawn underneath the still-visible wet pixels before they clear.
		if (this.strokePenGesture) observeStrokeMax(this.strokeRawMax);
		let strokes = builder?.finishReleaseFiltered() ?? [];
		const lift = !!ev && ev.pointerType === "pen" && ev.pointerId === this.snapContactId &&
			(ev.type === "pointerup" || ((ev.type === "pointermove" || ev.type === "pointerrawupdate") && silentLift(ev)));
		const visibleSnap = this.snapPreview?.take(strokes, lift) ?? null;
		this.clearSnapPreview();
		this.builder = null;
		this.strokePenGesture = false;
		// Hold the pen still at the end and the figure snaps to the clean
		// shape it meant (line, triangle, rectangle, circle, ellipse). The
		// dwell is the request; an ordinary lift never gets here.
		let snapReplaced: InkStroke | null = null;
		// A MOUSE'S snap, waiting to be asked for rather than taken. Set only
		// on the mouse branch below; the offer is made after the commit, since
		// what the chip replaces is the stroke that has already landed.
		let snapOffered: InkStroke | null = null;
		if (wasPen && visibleSnap && strokes.length === 1) {
			snapReplaced = strokes[0]!;
			strokes = [{ ...visibleSnap, createdAt: strokes[0]!.createdAt }];
		}
		// Mouse offers and finger input retain the existing release behavior.
		if (!wasPen && shapeSnapOn && strokes.length === 1) {
			const heldMs = performance.now() - this.rawLastMoveT;
			if (heldMs >= DWELL_MS) {
				const snapped = snapStroke(strokes[0]!, true);
				if (snapped) {
					// A MOUSE NEVER SNAPS ON ITS OWN. The dwell above is not
					// evidence of intent from a mouse: a mouse sits exactly
					// where it stopped while the button comes up, so an
					// ordinary deliberate stroke always clears DWELL_MS and
					// the figure was being replaced by one nobody asked for
					// ("it's correcting into a straight line", alan,
					// 2026-09-05). The same two facts - the hold and a fit the
					// recognizer will stand behind - become an OFFER instead.
					// SnapChip.ts carries the reasoning and the ruling; the
					// pen and the finger below are untouched by it.
					if (this.mouseStroke) {
						snapOffered = snapped;
					} else {
						// Kept for history: undo UN-SNAPS back to the freehand
						// (replace inverts to replace), a second undo removes.
						snapReplaced = strokes[0]!;
						strokes = [snapped];
					}
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
			// Every device clears the stroke's own box (see clearTransient below
			// for why the gate went, and why the tail keeps one).
			this.activeWet.clearStroke(this.cssWidth, this.cssHeight);
			this.tail.clear(this.cssWidth, this.cssHeight);
			this.highlightWetCanvas.setCssStyles({ opacity: String(HIGHLIGHTER_ALPHA) });
			return;
		}
		handoffFinishedStroke({
			store: () => {
				inlineInk.commitGesture(path, strokes);
				// The index has to hear about the stroke, and the commit is
				// the one mutation that reaches this view's store without
				// passing through scheduleRepaint's full-repaint branch: it
				// paints straight onto the committed canvas below, and
				// repaintPath is every pane EXCEPT this one. Left unsaid,
				// eraseCandidates kept answering from an index that predates
				// the stroke, so eraseAt returned early on an empty hit list -
				// ink present at open erased, ink drawn since did not,
				// silently (user report, Android 1.4.6; not a 1.4.6
				// regression). Set beside the store call rather than after the
				// handoff so the mutation and its invalidation cannot drift.
				this.indexDirty = true;
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
				// The wet layer clears the stroke's OWN BOX on every device.
				//
				// This used to be Boox-only, "until an e-ink user has confirmed
				// the box on hardware". Nobody on this project has an e-ink
				// device, so that confirmation was never going to arrive, and
				// the whole-canvas clearRect stayed on the default path where
				// it damages the entire canvas once per pen-up. What replaced
				// the confirmation is a pixel proof: every one of the four
				// `appendPoint` branches, over four path shapes, at both zooms,
				// both device pixel ratios and both pens' width laws - 128
				// cases - drawn in real Chromium and read back EXHAUSTIVELY
				// (every pixel, no stride) leaves nothing behind, each against
				// a paired control that does leave a rim. See
				// `test/measure/WetClearBox.test.ts`. `clearStroke` also falls
				// back to clearing everything when it has no box or a NaN one,
				// so the failure mode is the old behaviour, not stale ink.
				//
				// The TAIL takes its dirty rect here too, and for the same
				// reason - leaving it on `clearAll` would have kept a
				// whole-canvas damage per pen-up on the layer above, which
				// defeats most of the change below it. It has its own proof
				// (`test/measure/TailClearBox.test.ts`): the head and the
				// head-plus-prediction states are erased completely by the
				// dirty rect at both zooms and both device pixel ratios.
				//
				// It is conditional on the FALLBACK. The two classes were not
				// symmetric: `clear()` was `if (!this.dirty) return;`, and
				// three paths here paint and then null the box without leaving
				// one - so against a nulled box it erased nothing at all. It
				// now falls back to the whole canvas when handed a size, which
				// is why a size is handed to it here and not on the per-event
				// callers. See `TailRenderer.clear`.
				this.activeWet.clearStroke(this.cssWidth, this.cssHeight);
				this.tail.clear(this.cssWidth, this.cssHeight);
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
		// The mouse's offer, made only now: the chip replaces a stroke that is
		// already in the note and already in the history, which is the whole
		// difference between it and the pen's dwell snap. `stroke` is that
		// stroke - `strokes` was left exactly as drawn on this branch.
		if (snapOffered) this.offerSnapChip(path, stroke, snapOffered);
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
	 * Put the Snap button beside a mouse stroke that just landed.
	 *
	 * The coordinates are `rawLastMoveX/Y` - the last place the pointer
	 * actually MOVED, in the overlay container's own space, the same space the
	 * hover reticle is translated in. For the stroke that raises this chip
	 * they ARE the end of the stroke: a mouse that dwelled did not move again
	 * before the button came up, which is the whole reason the dwell fired.
	 * Using the raw layer rather than the stored points also skips the
	 * builder's min-distance filter, which discards exactly the stationary
	 * samples at the end.
	 */
	private offerSnapChip(path: string, freehand: InkStroke, snapped: InkStroke): void {
		const parent = this.container;
		if (!parent) return;
		this.snapChip.offer(
			{
				parent,
				// One node OUT from the scroller: the pen router's own
				// pointerdown is a CAPTURE listener on the scroller itself, and
				// a second capture listener on the same node would run after
				// it. SnapChip.ts's header says what that would cost.
				guardRoot: this.view.dom,
				scroller: this.view.scrollDOM,
				keyRoot: this.view.dom.ownerDocument,
				pane: { width: this.cssWidth, height: this.cssHeight },
				// The EDITOR's window, not the global one: a popped-out pane
				// has its own, and a timer from the wrong one is a timer that
				// keeps running over a closed window.
				clock: this.winRef,
			},
			this.rawLastMoveX,
			this.rawLastMoveY,
			() => this.takeSnapOffer(path, freehand, snapped)
		);
	}

	/**
	 * The offer accepted: the freehand comes out, the fitted figure goes in at
	 * the same depth, and the history gets THE SAME `replace` the pen's dwell
	 * snap publishes (`snapReplaceOp`, InkHistory.ts).
	 *
	 * One op and not two, and that is not a shortcut: the mouse's freehand was
	 * committed as drawn, so its `add` already went into the history at
	 * pen-up. The pen's snap has to invent that landing because its freehand
	 * never reached the store at all. Either way the reader gets the same two
	 * presses - the first undo un-snaps back to the freehand, the second
	 * removes it.
	 *
	 * REFUSES A STALE OFFER. Between the chip appearing and the click, the
	 * stroke can be undone or erased from another pane. `findIndex` answering
	 * -1 means the thing this offer was about is gone, and replacing nothing
	 * would insert the figure out of nowhere.
	 */
	private takeSnapOffer(path: string, freehand: InkStroke, snapped: InkStroke): void {
		const at = inlineInk.strokes(path).findIndex((s) => s.id === freehand.id);
		if (at < 0) return;
		// Same order as `applyInkOp`'s replace leg, for the reason written
		// there: out first, or the index the op carries names a list that no
		// longer exists.
		inlineInk.takeLive(path, [freehand.id]);
		inlineInk.applyAddLive(path, [snapped], [at]);
		// Publish once, after the complete replacement is visible to subscribers.
		inlineInk.save(path);
		// The eraser answers from `strokeIndex`, and a swap it never heard
		// about leaves it hit-testing a stroke that is gone - the 1.4.6 defect
		// `InlineEraseFresh.test.ts` exists over.
		this.indexDirty = true;
		this.dispatchInk(snapReplaceOp(path, freehand, [snapped], at));
		this.scheduleRepaint();
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

	/**
	 * The stroke's screen-space bbox (camera frame, CSS px), padded by the
	 * pen width and clamped to the canvas. `clippedPct` is how much of the
	 * padded bbox fell OUTSIDE the canvas, a direct measure of edge
	 * clipping at the viewport boundary.
	 */
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
			contentLeft: this.columnLeft(),
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
	 * Two-finger pinch magnifies the editor without changing stored coordinates.
	 * Layout and raster changes wait until the gesture ends. Scale is computed
	 * from what was captured at "start", so a pinch out and back lands exactly
	 * where it began.
	 */
	private pinch(
		phase: "start" | "move" | "end",
		ratio: number,
		centroid: { x: number; y: number }
	): void {
		if (phase === "start") {
			if(this.getNoteViewportState().busy) return;
			// Invalidate an earlier navigation's pending measure write.
			this.viewportGeneration++;
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
			// Nothing may still be queued behind the settle: a live frame
			// running after it would write the mid-gesture styles back.
			if (this.pinchRaf !== 0) {
				this.winRef.cancelAnimationFrame(this.pinchRaf);
				this.pinchRaf = 0;
			}
			try {
				// Settle while the gesture-start anchor and scale are still
				// available to the final coalesced move.
				this.flushPinch(true);
			} finally {
				this.pinchRefScale = null;
				this.pinchAnchor = null;
				this.pinchPreview = false;
				if (this.viewportStyleDirty) this.scheduleViewportStyleRefresh();
			}
			return;
		}
		if (this.pinchRefScale === null || this.pinchAnchor === null) return;
		const next = pinchScale(this.pinchRefScale, ratio);
		if (next === this.pinchScaleNow && this.pinchPending === null) return;
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
	 * Live frames keep the physical viewport fixed with a counter-sized box,
	 * transform and anchored scroll. The fixed text column does not rewrap.
	 * `handleResize`, canvas allocation and rerasterization wait for lift.
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
		else if (settle && (this.pinchPreview || this.pinchScaleNow !== this.pinchRasterScale))
			this.applyPinchScale(this.pinchScaleNow, true);
	}

	/**
	 * Magnify this editor, anchored under the fingers.
	 *
	 * The transform goes on the element the overlay hangs off, so text, ink and
	 * the overlay itself scale as one object and no stored coordinate moves.
	 * The overlay picks the new scale up on its own: `effectiveScale` measures
	 * painted width against layout width, which is exactly what a transform
	 * changes. This path retains the current magnification-only layout.
	 */
	private applyPinchScale(next: number, settle: boolean): void {
		const anchor = this.pinchAnchor;
		if (!anchor) return;
		// Both scales come from the GESTURE, not from the previous frame: the
		// reference the gesture started at, and where it is being asked to go.
		const from = this.pinchRefScale ?? this.pinchScaleNow;
		const external=this.cssScale/this.pinchScaleNow;
		const nextLeft = anchoredScroll(anchor.scrollLeft, anchor.offsetX, from*external, next*external);
		const nextTop = anchoredScroll(anchor.scrollTop, anchor.offsetY, from*external, next*external);

		if (settle) {
			this.pinchPreview = false;
			// The final transaction establishes the range before its scroll writes.
			if (!this.commitCameraScale(next, {left:nextLeft,top:nextTop})) return;
			this.pinchRasterScale = next;
		} else {
			const effective = external * next;
			if (this.frame.locked || this.scaleGeometryValid === false || next > 4 ||
				!validCameraScale(next) || !validCameraScale(effective) || !this.prepareViewportLayout()) return;
			const layout = this.viewportLayout!;
			if (!validCameraScale(next, layout.width, layout.height) ||
				![layout.width / next, layout.height / next, nextLeft, nextTop]
					.every(n => Number.isFinite(n) && n >= 0 && n <= MAX_VIEWPORT_LAYOUT)) return;
			this.pinchPreview = true;
			this.pinchScrollAt = performance.now();
			this.pinchScaleNow = next;
			this.cssScale = effective;
			this.scale = effective * this.fontZoom;
			this.router?.cameraTransformChanged();
			// Keep the scroller's physical viewport fixed while magnifying its
			// contents. Reuse the raster; observers cannot allocate it mid-move.
			this.applyViewportBox(next);
		}
		this.setViewportScroll(nextLeft,nextTop);
		// Stamp AFTER the writes: the scroll events they queue are the ones
		// the handler above should let pass without a repaint.
		this.pinchScrollAt = performance.now();
	}

	private deferPinchRaster(): boolean {
		// Match the scroll handler's bounded suppression: a lost end event must
		// never suppress future geometry work for the lifetime of the editor.
		return this.pinchPreview && performance.now() - this.pinchScrollAt < PINCH_SCROLL_QUIET_MS;
	}


 private restoreViewportLayout():void {
  this.pinchPreview=false;
  this.viewportGeneration++;
  this.viewportPaneObserver?.disconnect();this.viewportPaneObserver=null;
  this.viewportStyleObserver?.disconnect();this.viewportStyleObserver=null;
  this.viewportStyleDirty=null;
  if(this.viewportStyleFrame){this.winRef.cancelAnimationFrame(this.viewportStyleFrame);this.viewportStyleFrame=0;}
  const layout=this.viewportLayout;
  if(!layout) return;
  const host=this.view.dom;
  host.classList.remove("handwriting-note-viewport");
  layout.parent.classList.remove("handwriting-note-viewport-pane");
  for(const [name,saved] of layout.styles) {
   if(saved.value) host.style.setProperty(name,saved.value,saved.priority); else host.style.removeProperty(name);
  }
  this.viewportLayout=null;
 }

 private prepareViewportLayout():boolean {
  const host=this.view.dom,parent=host.parentElement;
  if(!parent||!host.clientWidth||!host.clientHeight) return false;
  if(!this.viewportLayout) {
   const names=["width","height","transform","transform-origin","--handwriting-note-column-width","--handwriting-note-column-margin-left","--handwriting-note-column-margin-right","--handwriting-paper-pitch","--handwriting-paper-rule"];
   const style=this.winRef.getComputedStyle(this.view.contentDOM);
   this.viewportLayout={parent,paneWidth:parent.clientWidth,paneHeight:parent.clientHeight,externalScale:this.cssScale/this.pinchScaleNow,baseTransform:this.winRef.getComputedStyle(host).transform,width:host.clientWidth,height:host.clientHeight,column:this.view.contentDOM.offsetWidth,left:style.marginLeft,right:style.marginRight,styles:new Map(names.map(n=>[n,{value:host.style.getPropertyValue(n),priority:host.style.getPropertyPriority(n)}]))};
  }
  if(!this.viewportPaneObserver) {
   this.viewportPaneObserver=new ResizeObserver(()=>this.handleResize());
   this.viewportPaneObserver.observe(parent);
   const doc=host.ownerDocument;
   const stamp=()=>[doc.documentElement.className,doc.documentElement.getAttribute("style"),doc.body.className,doc.body.getAttribute("style"),parent.className.replace(/handwriting-note-viewport-pane/g,""),parent.getAttribute("style")].join("|");
   this.viewportStyleStamp=stamp();
   this.viewportStyleObserver=new MutationObserver(records=>{
    const next=stamp();
    if(next===this.viewportStyleStamp&&!records.some(r=>doc.head.contains(r.target)))return;
    this.viewportStyleStamp=next;
    this.viewportStyleDirty={path:this.filePath(),container:this.container};
    this.scheduleViewportStyleRefresh();
   });
   this.viewportStyleObserver.observe(doc.head,{childList:true,subtree:true,characterData:true});
   for(const el of new Set([doc.documentElement,doc.body,parent]))this.viewportStyleObserver.observe(el,{attributes:true,attributeFilter:["class","style"]});
  }
  return true;
 }



 private scheduleViewportStyleRefresh():void {
  if(!this.viewportStyleDirty||this.viewportStyleFrame)return;
  this.viewportStyleFrame=this.winRef.requestAnimationFrame(()=>{
   this.viewportStyleFrame=0;
   const dirty=this.viewportStyleDirty;
   if(!dirty)return;
   if(dirty.path!==this.filePath()||dirty.container!==this.container){this.viewportStyleDirty=null;return;}
   // Keep one dirty marker; pen-up schedules the single retry, never a loop.
   if(this.frame.locked||this.deferPinchRaster()||!this.viewportLayout?.parent.clientWidth||!this.viewportLayout.parent.clientHeight)return;
   if(this.refreshViewportColumn())this.viewportStyleDirty=null;
  });
 }

 /** Re-measure the ordinary column when a theme changes at constant pane size. */
 private refreshViewportColumn():boolean {
  const layout=this.viewportLayout;
  if(!layout||this.frame.locked||!this.container)return false;
  const host=this.view.dom;
  host.classList.remove("handwriting-note-viewport");
  host.setCssStyles({width:`${layout.width}px`,height:`${layout.height}px`});
  const style=this.winRef.getComputedStyle(this.view.contentDOM);
  const column=this.view.contentDOM.offsetWidth,left=style.marginLeft,right=style.marginRight;
  const changed=column!==layout.column||left!==layout.left||right!==layout.right;
  if(column>0&&changed){layout.column=column;layout.left=left;layout.right=right;}
  this.applyViewportBox(this.pinchScaleNow);
  if(column>0&&changed)this.commitCameraScale(this.pinchScaleNow);
  return column>0;
 }

 private setViewportScroll(left:number,top:number):void {
  const scroller=this.view.scrollDOM;
  scroller.scrollLeft=left;scroller.scrollTop=top;
  this.scrollExpansion?.rebase(scroller.scrollLeft,scroller.scrollTop);
 }

 private applyViewportBox(next:number):void {
  const layout=this.viewportLayout!,host=this.view.dom;
  host.classList.add("handwriting-note-viewport");layout.parent.classList.add("handwriting-note-viewport-pane");
  host.style.setProperty("--handwriting-note-column-width",`${layout.column}px`);
  host.style.setProperty("--handwriting-note-column-margin-left",layout.left);
  host.style.setProperty("--handwriting-note-column-margin-right",layout.right);
  host.setCssStyles({width:`${layout.width/next}px`,height:`${layout.height/next}px`,transform:`${layout.baseTransform!=="none"?layout.baseTransform+" ":""}scale(${next})`,transformOrigin:"0 0"});
 }

 private updatePaperSpacing():void {
  if(!this.viewportLayout||!Number.isFinite(this.cssScale)||this.cssScale<=0)return;
  // Keep every power-of-two rule at low CSS zoom. Font size does not
  // scale CSS backgrounds. Levels stay bounded by the camera's layout range.
  const level=Math.min(20,Math.max(0,Math.ceil(Math.log2(1/this.cssScale)-1e-6)));
  const host=this.view.dom;
  for(const [name,value] of [["--handwriting-paper-pitch",`${28*2**level}px`],["--handwriting-paper-rule",`${1/Math.min(1,this.cssScale)}px`]]) {
   if(host.style.getPropertyValue(name!)!==value)host.style.setProperty(name!,value!);
  }
 }

 // CodeMirror owns the root class attribute and rewrites it on focus changes.
 // Its facet must agree with our synchronous camera writes, including while a
 // stroke owns the frame. Reading the DOM class here would retain its loss.
 ownsNoteViewport():boolean {return this.viewportLayout!==null;}

 getNoteViewportState():{zoom:number;busy:boolean;fitAvailable:boolean} {
  const path=this.filePath();
  const busy=!this.container || !path || !inlineInk.isLoaded(path) || inlineInk.deleteAllReadiness(path).kind==="unsettled" || this.frame.locked || this.builder!==null || this.mode!=="ink";
  return {zoom:this.pinchScaleNow,busy,fitAvailable:!busy&&this.scaleGeometryValid!==false};
 }

 zoomNoteBy(factor:number):boolean {
  if(this.getNoteViewportState().busy||!Number.isFinite(factor)||factor<=0) return false;
  const next=Math.max(MIN_PINCH_SCALE,Math.min(4,this.pinchScaleNow*factor));
  return next===this.pinchScaleNow || this.zoomAroundCenter(next);
 }
 resetNoteZoom():boolean {
  return !this.getNoteViewportState().busy && this.zoomAroundCenter(1);
 }
 private zoomAroundCenter(next:number):boolean {
  const scroller=this.view.scrollDOM,rect=scroller.getBoundingClientRect();
  const external=this.cssScale/this.pinchScaleNow;
  return this.commitCameraScale(next,{left:anchoredScroll(scroller.scrollLeft,rect.width/2,this.cssScale,next*external),top:anchoredScroll(scroller.scrollTop,rect.height/2,this.cssScale,next*external)});
 }

 fitHandwriting():"fit"|"empty"|"busy"|"unrepresentable" {
  if(this.getNoteViewportState().busy) return "busy";
  const refuse=()=>{new Notice("Handwriting: this ink cannot fit in the current view.");return "unrepresentable" as const;};
  const path=this.filePath()!;
  const scroller=this.view.scrollDOM,rect=scroller.getBoundingClientRect();
  const external=this.viewportLayout?.externalScale??this.cssScale/this.pinchScaleNow;
  const screenWidth=this.viewportLayout?this.viewportLayout.width*external:rect.width;
  const screenHeight=this.viewportLayout?this.viewportLayout.height*external:rect.height;
  // The surface grows right and bottom only, so ink above or left of the origin
  // cannot be scrolled to. Frame the reachable part instead of refusing the whole
  // note: one stroke above the first line used to disable Fit forever.
  //
  // Clip EACH stroke before the union, not the finished union. A stroke that is
  // wholly unreachable must contribute nothing at all; clamping afterwards lets
  // its other dimension still drag the union outward, so Fit zooms away to
  // accommodate ink it can never display.
  const origin=surfaceOriginInScroller({contentLeftVisual:this.columnLeft(),documentTopVisual:this.view.documentTop,scrollRectLeft:rect.left,scrollRectTop:rect.top,scrollLeft:scroller.scrollLeft,scrollTop:scroller.scrollTop,scale:this.cssScale});
  const f=Number.isFinite(this.fontZoom)&&this.fontZoom>0?this.fontZoom:1;
  const reach={originLeftNote:-origin.left/f,originTopNote:-origin.top/f};
  let bounds:InkFitBounds|null=null,sawStroke=false;
  for(const stroke of inlineInk.strokes(path)) {
   // Loaded and freshly built bboxes already include width*2 allowance.
   const b=stroke.bbox;
   if(![b.x,b.y,b.width,b.height].every(Number.isFinite)||b.width<0||b.height<0) return refuse();
   sawStroke=true;
   const clipped=clampToReachable({x:b.x,y:b.y,width:b.width,height:b.height},reach);
   if(!clipped) continue;
   const right=clipped.x+clipped.width,bottom=clipped.y+clipped.height;
   if(!bounds) bounds={x:clipped.x,y:clipped.y,width:clipped.width,height:clipped.height};
   else {const endX=Math.max(bounds.x+bounds.width,right),endY=Math.max(bounds.y+bounds.height,bottom);bounds.x=Math.min(bounds.x,clipped.x);bounds.y=Math.min(bounds.y,clipped.y);bounds.width=endX-bounds.x;bounds.height=endY-bounds.y;}
  }
  // Strokes exist but not one of them is reachable: the only remaining refusal.
  // No strokes at all stays "empty", which resets to 100% rather than refusing.
  if(sawStroke&&!bounds) return refuse();
  const plan=fitInkBounds({bounds,viewportWidthScreen:screenWidth,viewportHeightScreen:screenHeight,externalScale:external,fontZoom:this.fontZoom,marginScreen:24});
  if(plan.kind==="below-minimum") {new Notice(`Handwriting: this ink cannot fit above the ${MIN_PINCH_SCALE*100}% zoom limit.`);return "unrepresentable";}
  if(plan.kind==="unrepresentable") return refuse();
  if(!bounds) return this.commitCameraScale(1,{left:0,top:0})?"empty":refuse();
  const scale=external*plan.zoom;
  // `f`, not raw fontZoom: the same guarded value the reachable region above
  // was built from, so a stroke placed with it lands exactly where the
  // reachability test thought it was. (Today the two never actually differ -
  // fitInkBounds already refused above whenever fontZoom fails the same
  // finite/>0 test that makes f fall back - but that agreement is worth
  // keeping explicit rather than relying on a guard two calls away.)
  const left=Math.max(0,origin.left+(bounds.x+bounds.width/2)*f-screenWidth/scale/2);
  const top=Math.max(0,origin.top+(bounds.y+bounds.height/2)*f-screenHeight/scale/2);
  return this.commitCameraScale(plan.zoom,{left,top})?"fit":refuse();
 }

 /** One validated transaction owns layout, transform, native range and scroll. */
 commitCameraScale(next:number,scroll?:{left:number;top:number}):boolean {
  this.pinchPreview=false;
  if(this.frame.locked||this.scaleGeometryValid===false||next<MIN_PINCH_SCALE||next>4||!validCameraScale(next,this.view.dom.clientWidth,this.view.dom.clientHeight))return false;
  const previous=this.pinchScaleNow,effective=this.cssScale/previous*next;
  if(!validCameraScale(effective)||!this.prepareViewportLayout())return false;
  const layout=this.viewportLayout!;
  const width=layout.width/next,height=layout.height/next;
  const target=scroll??{left:this.view.scrollDOM.scrollLeft,top:this.view.scrollDOM.scrollTop};
  if(![width,height,target.left,target.top].every(n=>Number.isFinite(n)&&n>=0&&n<=MAX_VIEWPORT_LAYOUT)||width===0||height===0)return false;
  if(next!==previous)this.router?.cameraTransformChanged();
  const generation=++this.viewportGeneration,path=this.filePath();
  this.pinchScaleNow=next;this.cssScale=effective;this.scale=effective*this.fontZoom;
  this.updatePaperSpacing();
  this.applyViewportBox(next);
  this.scrollExpansion?.rebase(this.view.scrollDOM.scrollLeft,this.view.scrollDOM.scrollTop);
  this.handleResize();this.updateExtent(true);this.setViewportScroll(target.left,target.top);
  // The target scroll can leave the old raster band, especially on zoom-out.
  // Finish its coverage before the router can map and lock the next pen down.
  if(this.syncBand()!=="none")this.handleResize();
  const settledLeft=this.view.scrollDOM.scrollLeft,settledTop=this.view.scrollDOM.scrollTop;
  this.view.requestMeasure({key:this,read:()=>generation===this.viewportGeneration&&path===this.filePath()&&!!this.container&&this.view.scrollDOM.scrollLeft===settledLeft&&this.view.scrollDOM.scrollTop===settledTop,write:valid=>{
   if(!valid||generation!==this.viewportGeneration||path!==this.filePath()||this.frame.locked)return;
   this.handleResize();this.updateExtent(true);this.setViewportScroll(target.left,target.top);
   if(this.syncBand()!=="none")this.handleResize();
   this.scheduleRepaint();
   // CodeMirror adjusts its text scroll anchor after measurement writes.
   // Finish this explicit camera navigation after that adjustment, before
   // the next input event, retaining the same note/gesture ownership guards.
   queueMicrotask(()=>{
    if(generation!==this.viewportGeneration||path!==this.filePath()||!this.container||this.frame.locked)return;
    this.setViewportScroll(target.left,target.top);
    if(this.syncBand()!=="none")this.handleResize();
    this.scheduleRepaint();
   });
  }});
  this.mobileTools?.refresh();
  return true;
 }

	private showPenCursor(sample: PenSample, pointerType?: string): void {
		// Keyboard mode is an overarching pause for mouse ink. The router keeps
		// an already-claimed mouse alive so its samples can commit, and these
		// in-gesture wrappers intentionally omit pointerType; do not let either
		// path repaint the drawing cursor after the keyboard command hid it.
		const mousePaused =
			!penInkEnabled() &&
			(pointerType === "mouse" || (pointerType === undefined && this.mouseStroke));
		if (mousePaused) return;
		// Visibility for anything that can ink - a mouse hovering with mouse
		// ink armed still wants the strip, and gating that would silently take
		// the toolbar away from every mouse-ink user. Alan ruled for exactly
		// this on 2026-09-03 and made the pdf surface match it; the predicate
		// is `pointerRaisesPenTools` (PenToolsMode.ts) and both surfaces read
		// it now, so neither can drift from the other again.
		//
		// Not a behaviour change HERE. It says out loud what the unconditional
		// `else markPenSeen()` already did, because the router fires
		// onPenHover only for a pen or a mouse with ink armed (its own
		// `mouseActsAsPen` gate, which the predicate is built from). Saying it
		// at the call site is what lets the surface guard demand the pdf say
		// the same thing.
		//
		// Only the HARDWARE claim is gated on a real pen, on both surfaces. An
		// armed mouse may raise the strip and may never claim to be a pen;
		// `nibIsLit` answers the mouse through its own `|| h.mouseInkOn()`.
		if (pointerType === "pen") markPenHardwareSeen();
		else if (pointerRaisesPenTools(pointerType)) markPenSeen();
		this.ensurePenTools();
		// Reticle off: the native cursor stays, so no hover class either.
		if (!penReticleOn) return;
		if (!this.penCursorEl) return;
		// A PAN DRAG PAINTS NO RETICLE - the rule and the defect behind it are
		// written down at `penReticleShown` (PenCursor.ts). The two call sites
		// that used to paint it mid-pan are gone, so nothing reaches here
		// during a pan today; this is the gate that keeps it that way, because
		// the next mode or the next caller must not be able to reintroduce a
		// ring whose coordinates cannot be right.
		//
		// Returns BEFORE the hover class and the watchdog below, and hides
		// nothing: the drag already put the ring away and swapped `cursor:
		// none` for the grabbing hand (`beginPanDragCursor`), and calling
		// `hidePenCursor` here would take that hand off and leave the surface
		// with no pointer at all mid-drag.
		//
		// `this.mode === "pan"` is the drag state the predicate wants: it is
		// true exactly while a pan drag is live, and a pan drag is the only
		// thing the predicate ever refuses.
		if (!penReticleShown(tipMode(), this.mode === "pan")) return;
		// IS THE POINTER IN HAND A MOUSE? The watchdog exists for a pen that
		// leaves HOVER RANGE without sending pointerleave - digitizers differ,
		// and the reticle is otherwise left on screen for good. A mouse cannot
		// do that: it is either over the pane or it has sent pointerleave. So
		// it protects a mouse against nothing, and firing it under one took
		// the pointer away from anyone who paused for a second - at hover, and
		// worse mid-drag, where `hidePenCursor` also strips PEN_HOVER_CLASS
		// and its `cursor: none` while the button is still down. That is as
		// true of a mouse mid-gesture as of one hovering, and the three
		// in-gesture wrappers pass no `pointerType` at all, so this reads the
		// field contact wrote rather than the argument.
		//
		// AND ONLY WHERE NOTHING ELSE SPEAKS. `mouseStroke` is not cleared at
		// pen-up, so `pointerType === "mouse" || this.mouseStroke` would hand
		// the next PEN hover after any mouse stroke the mouse's exemption and
		// delete the pen's only guard against a stranded reticle. An explicit
		// "pen" says pen and is believed.
		//
		// The pdf reached this ruling first (a7eba85, alan, hardware, mouse
		// ink armed) and this surface was left with no exemption at all -
		// which is this project's most expensive defect shape, so the two
		// sites are now the same rule spelled the same way. Cleared either
		// way, like the pdf's: a watchdog armed by an earlier PEN hover must
		// not be left running to fire in the middle of the mouse gesture that
		// replaced it.
		const mousePointer =
			pointerType === "mouse" || (pointerType === undefined && this.mouseStroke);
		// A HAND IS ON THE GLASS: THE MOUSE PAINTS NOTHING.
		//
		// The ruling, alan, 1.4.12: "hide the mouse reticle when a finger or
		// pen is active". With mouse ink armed a parked mouse is still
		// HOVERING, so its ring sits wherever the pointer was last left the
		// whole time a finger flings the page or the pen writes - a marker for
		// a pointer nobody is using, and on a tablet a smudge on the glass.
		// `InlinePenRouter.handOnGlass` is the question and carries the terms;
		// its `onHandOnGlass` is what took the ring down when the finger
		// landed, and this is what stops the next mouse sample putting one
		// back before the hand leaves.
		//
		// REFUSES, LIKE THE PAN GATE ABOVE, and for the same reason spelled
		// out there: `PEN_HOVER_CLASS` two lines down is `cursor: none` over
		// the whole scroller, so painting nothing while ADDING it is the
		// no-pointer-at-all defect of 2026-09-04. Returning here leaves the
		// class exactly as the stand-down left it - off - so the reader keeps
		// the native cursor for as long as the ring is refused.
		//
		// AND ABOVE THE WATCHDOG, which is not tidiness either. A refused
		// mouse sample must not settle a timer it is not going to paint for:
		// clearing here would take down the guard of a PEN whose ring is on
		// screen and hovering, and leave it stranded if that pen then left
		// without a pointerleave - the exact failure `armHoverWatchdog` is the
		// answer to. The mouse changes nothing on its way past.
		//
		// MOUSE INK IS UNTOUCHED. This hides a reticle; it disarms nothing,
		// refuses no claim, and a mouse that draws still draws.
		//
		// `router` is null before `mount()` and stubbed in the surface's unit
		// rigs, both of which read as "nothing is on the glass" - which is
		// what the hover behaved as before this rule existed.
		// EVERY OPEN SURFACE, not just this one (1.4.13). `handOnGlass` is
		// per-surface because the router is, so a finger writing in one pane
		// left the mouse's ring lit in the other - the same smudge, in the
		// pane the user is not touching. `anyHandOnGlass` (InlinePenRouter.ts)
		// ORs the same derived answer over every live router and carries the
		// cost note; it is read only under `mousePointer`, so nothing on the
		// pen or touch path pays for it.
		if (mousePointer && anyHandOnGlass()) return;
		// Every branch below returns, so the watchdog is settled here, once.
		if (mousePointer) this.clearHoverWatchdog();
		else this.armHoverWatchdog();
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
			const world=this.camera.screenToWorld(sample.x,sample.y);
			const cut=this.spaceLineY??this.planSpace(world.y)?.y;
			if (cut===undefined) {this.penCursorEl.style.display="none";return;}
			const y=this.camera.worldToScreen(world.x,cut).y;
			this.penCursorEl.classList.add(SPACE_CURSOR_CLASS);
			this.penCursorEl.setCssStyles({
				display: "block",
				width: `${half * 2}px`,
				height: "0px",
				transform: `translate(${sample.x - half}px, ${y}px)`,
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

	/**
	 * Not private: `hidePenCursorsEverywhere` calls it on every registered
	 * overlay when mouse ink goes off, the same access `refreshStrip` and
	 * `ensurePenTools` already have for their own fan-outs.
	 */
	hidePenCursor(): void {
		this.clearHoverWatchdog();
		this.view.scrollDOM.classList.remove(PEN_HOVER_CLASS);
		// The pan drag's grabbing hand comes off wherever the reticle does,
		// and that is not tidiness: this is the ONE place every abandon path
		// already passes through. `resetGestureState` (a file switch, an
		// unmount, a window blur mid-gesture) calls it, `onPenLeave` calls it,
		// and `hidePenCursorsEverywhere` calls it on every open surface when
		// mouse ink goes off. A pan drag torn down by any of those would
		// otherwise leave the scroller wearing `cursor: grabbing` with no
		// gesture behind it, for the rest of the session - the same shape of
		// stranded-cursor defect the mouse-ink-off edge was fixed for on
		// 2026-09-04, and `AbandonedGestureStandsDown.test.ts` is the
		// neighbouring rule.
		this.view.scrollDOM.classList.remove(PAN_DRAG_CLASS);
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
		const token = this.frameTickToken = {};
		const tick = (ts: number): void => {
			if (this.frameTickToken !== token) return;
			this.frameRaf = 0;
			this.snapPreview?.check();
			if (this.frameTickToken !== token) return;
			metrics.recordFrame(ts);
			this.frameRaf = this.winRef.requestAnimationFrame(tick);
		};
		this.frameRaf = this.winRef.requestAnimationFrame(tick);
	}

	private stopFrameTicker(): void {
		this.frameTicking = false;
		// A new pen-down may precede the old callback. Cancel its frame and
		// invalidate its closure so consecutive strokes cannot multiply tickers.
		this.frameTickToken = null;
		if (this.frameRaf) this.winRef.cancelAnimationFrame(this.frameRaf);
		this.frameRaf = 0;
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

	/**
	 * The lasso reticle, during a lasso gesture - including the "grab an
	 * existing selection and drag it" branch, which reaches the tip through
	 * `lassoDown` exactly like a fresh loop does (both call sites in
	 * `penDown` land there). One call site covers the family.
	 *
	 * Named rather than a raw `showPenCursor` call, the same reasoning as
	 * `showEraserCursor` two methods up: the surface registry
	 * (InkSurfaceRules.test.ts) needs a marker that cannot be satisfied by a
	 * declaration nobody calls, and `this.showLassoCursor(` is that marker
	 * here now - never the declaration below, since a method never calls
	 * itself through `this.` in its own signature - mirroring the pdf's own
	 * wrapper of the same name from 2127ed6.
	 *
	 * `showPenCursor` already switches its look by `tipMode()` - lasso adds
	 * `LASSO_CURSOR_CLASS` - so this is thin on purpose: no new look is
	 * added here, only persistence through the gesture.
	 *
	 * No `pointerType`: the hardware/pen-seen claims belong to the hover and
	 * pen-down that already happened, not to every sample of a gesture in
	 * flight. `pointerRaisesPenTools(undefined)` is false (`mouseActsAsPen`,
	 * MouseInk.ts, requires `pointerType === "mouse"`), so this never makes
	 * a claim the hover call site did not already make.
	 */
	private showLassoCursor(sample: PenSample): void {
		this.showPenCursor(sample);
	}

	/**
	 * Put the lasso reticle away with the gesture, not the watchdog - a
	 * released lasso should not strand its ring on screen for up to a
	 * second. Reuses `hidePenCursor` because lasso, space and pan all paint
	 * through the SAME element hover does (`penCursorEl`), unlike the eraser
	 * which has its own (`eraserEl`) - pan by hiding it for the length of the
	 * drag rather than by keeping it lit, but through that element either way.
	 */
	private hideLassoCursor(): void {
		this.hidePenCursor();
	}

	/**
	 * Enter the pan drag's cursor state: no reticle, and the grabbing hand
	 * over the scroller until the drag ends.
	 *
	 * There is no `showPanCursor` beside `showLassoCursor` and
	 * `showSpaceCursor` any more, and its absence is the point. Those two
	 * exist because a lasso and a space gesture want the ring KEPT ALIVE
	 * through a drag that produces no hover samples; a pan wants the opposite,
	 * for the reason `penReticleShown` (PenCursor.ts) sets out - it is the one
	 * gesture that scrolls the overlay out from under the rect its samples are
	 * mapped through, so the ring flung itself away from the nib and flickered
	 * (alan, 2026-09-05, hardware).
	 *
	 * `hidePenCursor` FIRST, then the class. It clears the hover watchdog that
	 * would otherwise fire mid-drag, takes `PEN_HOVER_CLASS`'s `cursor: none`
	 * off, and removes `PAN_DRAG_CLASS` - so the add below cannot be undone by
	 * the line above it, and the scroller is left wearing exactly one cursor
	 * rule. The ring itself is usually already down: `penDown` hides the dot
	 * for every gesture before it branches.
	 */
	private beginPanDragCursor(): void {
		this.hidePenCursor();
		this.view.scrollDOM.classList.add(PAN_DRAG_CLASS);
	}

	/**
	 * Put the reticle back under the pointer as the pan releases, with no
	 * jump.
	 *
	 * WHERE THE POSITION COMES FROM, and why it is right. Two things are stale
	 * at this moment and both are fixed here, in order. The router caches the
	 * overlay's client rect at pen-down and refuses to refresh it while a
	 * contact is claimed (`scrollFn`'s `if (!during)`); a pan spends its whole
	 * length scrolling the overlay under that frozen rect, and NOTHING
	 * refreshes it afterwards, because the refresh is wired to the scroll
	 * event and the scrolling has stopped. So the next hover sample after a
	 * pan would be mapped through a rect stale by the entire pan - a ring that
	 * lands the whole scroll distance away from the pen. `refreshRect()`
	 * closes that, and it is safe here where it is not mid-gesture: the router
	 * clears `activePenId` BEFORE calling `onPenUp`, so no frozen camera is
	 * left disagreeing with it.
	 *
	 * Then the position itself, from the lift event's client coordinates
	 * mapped through the overlay's rect READ FRESH on the line below. Same
	 * element the router just re-measured and the same conversion
	 * (`visualToNote`, cssScale) its `sampleFrom` uses, so the ring lands in
	 * exactly the frame every following hover sample will be mapped into.
	 * That is what makes it a restore rather than a jump: the pointer has not
	 * moved, the frame is now current, and the first real hover sample paints
	 * the ring in the same place this one did.
	 *
	 * No event, no RESTORE - but the rect is refreshed either way, which is
	 * why that line sits above the guard. `finishActiveStroke` (a window blur
	 * mid-pan: alt-tab, a system dialog) ends the gesture with no lift and
	 * therefore no position, so the ring stays down and the next hover brings
	 * it back - and that next hover has to be mapped through a rect that
	 * accounts for the scrolling the pan did, or the ring comes back the whole
	 * pan distance from the pen. The refresh is what the abandoned pan needs
	 * MOST, not least.
	 */
	private restoreReticleAfterPan(ev?: PointerEvent): void {
		this.router?.refreshRect();
		if (!ev || !this.container) return;
		const rect = this.container.getBoundingClientRect();
		// No `pointerType`, exactly like the in-gesture wrappers and for their
		// reason: the hardware and pen-seen claims belong to the hover and the
		// pen-down that already happened. `mouseStroke` answers for a mouse.
		this.showPenCursor({
			x: visualToNote(ev.clientX - rect.left, this.cssScale),
			y: visualToNote(ev.clientY - rect.top, this.cssScale),
			pressure: 0,
			timestamp: ev.timeStamp,
			tiltX: 0,
			tiltY: 0,
		});
	}

	/** The insert-space divider reticle, during a space gesture. See showLassoCursor. */
	private showSpaceCursor(sample: PenSample): void {
		this.showPenCursor(sample);
	}

	/** Put the insert-space reticle away with the gesture. See hideLassoCursor. */
	private hideSpaceCursor(): void {
		this.hidePenCursor();
	}

	// ---- lasso / move (side button held; §52/§53, ink-only on the inline surface) --

	private strokesHere(): readonly InkStroke[] {
		const path = this.filePath();
		return path ? inlineInk.strokes(path) : [];
	}

	/**
	 * The empty-page refusal, for whichever tool discovered it - the ONE
	 * place either of them is allowed to say it.
	 *
	 * Three things happen here that the two call sites each used to get
	 * wrong on their own:
	 *
	 * 1. CERTAINTY FIRST. An empty stroke list is not evidence the page is
	 *    empty; it is the store's cache, and until `ensureLoaded` has read
	 *    the sidecar the cache is empty for every note in the vault. On
	 *    "unknown" this says nothing and kicks the read instead - which is
	 *    also what puts the ink on screen, so the user gets their page back
	 *    rather than a sentence denying it exists.
	 * 2. ONCE PER EPISODE. `EmptyPageNoticeGate` remembers what has been
	 *    said, so an eraser scrub's second through twentieth contacts are
	 *    silent. Cleared when the note's ink changes, or the note does.
	 * 3. NO PALETTE COMMAND. This raises a Notice and returns. It does not
	 *    reach `app.commands`, and a source guard
	 *    (EraserContactSource.test.ts) holds the whole eraser branch to
	 *    that - the original 1.4.12 report was filed against
	 *    `delete-all-ink`'s toast, and the first thing worth being able to
	 *    prove is that a pen contact cannot run a palette command at all.
	 */
	private sayIfPageEmpty(path: string | null, kind: EmptyPageTool): void {
		if (!path) return;
		const presence = inlineInk.inkPresence(path);
		if (presence === "unknown") {
			this.loadInk(path);
			return;
		}
		const text = emptyPageNoticeText(presence, kind);
		if (text !== null && this.emptyNotice.claim(path, kind)) new Notice(text);
	}

	private selectionBounds(): BBox | null {
		return this.selection.bounds(this.strokesHere(), () => null, () => null);
	}

	private lassoDown(sample: PenSample): void {
		// One call site for both paths into a lasso gesture - a fresh loop
		// and grabbing an existing selection to drag both reach here, from
		// the two call sites in `penDown` - so the reticle persists through
		// either kind of lasso without either call site having to remember
		// it. Same watchdog reasoning as the eraser: hover has gone quiet by
		// the time a contact is claimed, and nothing else touches
		// `penCursorEl` for the length of the gesture without this.
		this.showLassoCursor(sample);
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
		if (this.strokesHere().length === 0) {
			// Same reasoning as the eraser's own empty-page check right above
			// it: a fresh loop on a page with no ink at all can never select
			// anything, whatever shape it ends up drawing, so say so now
			// rather than let the lasso close over nothing in silence.
			//
			// And the same gate, for the same reason. Only the eraser was
			// reported (a lasso is not scrubbed, so it spams less readily),
			// but the "even though there is" half is identical here - an
			// unread sidecar makes this branch claim an inked note is empty -
			// and this file's own test header says the eraser and the lasso
			// "are the same shape". Leaving one of a declared pair fixed is
			// how the divergences StripPenChrome.test.ts exists to catch get
			// started.
			this.sayIfPageEmpty(this.filePath(), "select");
		}
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

	/** A visual line start, not the beginning of its entire Markdown paragraph.
	 * Layout rectangles are screen pixels; converting through the fresh note
	 * origin and effective ink scale also covers font scaling and scrolling. */
	private spaceTextBoundary(y:number,direction:-1|1):SpaceBoundary|null {
		if (!this.container || !this.view.dom.isConnected || !(this.scale>0)) return null;
		const origin=anchorTop(this.view,this.contentStyle?.paddingTop,this.cssScale);
		const clientY=origin+y*this.scale;
		const x=this.view.contentDOM.getBoundingClientRect().left+this.cssScale;
		const find=(screenY:number):SpaceBoundary|null=>{
			const pos=this.view.posAtCoords({x,y:screenY});
			if(pos===null)return null;
			const hit=this.view.coordsAtPos(pos,1);
			if(!hit)return null;
			// CM's visual-line navigation samples one SCREEN pixel inside the
			// editor. At 10% that can skip the first character. Find the first
			// position on this rendered row by its vertical coordinates instead.
			let from=this.view.state.doc.lineAt(pos).from,hi=pos;
			while(from<hi){
				const mid=Math.floor((from+hi)/2),rect=this.view.coordsAtPos(mid,1);
				if(!rect)return null;
				if(rect.top<hit.top-.01*this.cssScale)from=mid+1;else hi=mid;
			}
			const line=this.view.state.doc.lineAt(from);
			const block=this.spaceTextEnd?.blocks.find(block=>line.number>=block.from&&line.number<=block.to);
			if(block&&(line.number>block.from||from>line.from||block.frontmatter)){
				if(direction<0){if(block.frontmatter)return null;from=this.view.state.doc.line(block.from).from;}
				else if(block.to<this.view.state.doc.lines)from=this.view.state.doc.line(block.to+1).from;
				else return null;
			}else if(from>line.from&&!canSplitParagraph(line.text,from-line.from)){
				if(direction<0)from=line.from;
				else if(line.number<this.view.state.doc.lines)from=this.view.state.doc.line(line.number+1).from;
				else return null;
			}
			const rect=this.view.coordsAtPos(from,1);
			if(!rect)return null;
			const dom=this.view.domAtPos(from).node;
			const el=(dom.nodeType===1?dom as Element:dom.parentElement)?.closest(".cm-line");
			if(!el)return null;
			const style=this.winRef.getComputedStyle(el);
			const lh=parseFloat(style.lineHeight)*this.cssScale || this.view.defaultLineHeight;
			if(!(lh>0))return null;
			const top=el.getBoundingClientRect().top;
			const rowTop=top+Math.max(0,Math.round((rect.top-top)/lh))*lh;
			return {y:(rowTop-origin)/this.scale,from,lineHeight:lh/this.scale};
		};
		let boundary=find(clientY);
		if(!boundary)return null;
		if(direction>0&&boundary.y<y-1e-5) {
			boundary=find(origin+(boundary.y+boundary.lineHeight)*this.scale+Math.min(.1,this.cssScale));
		}
		if(!boundary||(boundary.y-y)*direction < -1e-5)return null;
		return boundary;
	}

	private planSpace(y:number):SpaceBoundary|null {
		const rows=(this.spaceRowsCache??=new InsertSpaceRows()).get(this.strokesHere());
		const doc=this.view.state.doc;
		if(this.spaceTextEnd?.doc!==doc){
			let pos=0;
			for(let n=doc.lines;n>0;n--){const line=doc.line(n),text=line.text.trimEnd();if(text.trim()){pos=line.from+text.length;break;}}
			this.spaceTextEnd={doc,pos,blocks:spaceProtectedBlocks(n=>doc.line(n).text,doc.lines)};
		}
		// No text below the contact: the ink seam remains continuous instead
		// of jumping back to the final Markdown line. No blank lines are
		// manufactured in a note just to move ink that has no text to follow.
		const end=this.spaceTextEnd.pos;
		const textBottom=end===0?0:this.view.lineBlockAt(end).bottom/this.scale;
		if(end===0||y>=textBottom){
			let cut=snapLine(rows,y);
			if(cut<textBottom)cut=rows.find(row=>row.top<=y&&row.bottom>=y)?.bottom??textBottom;
			return {y:cut,from:doc.length,lineHeight:this.view.defaultLineHeight/this.scale,text:false};
		}
		return nearestSpaceBoundary(rows,y,(at,direction)=>this.spaceTextBoundary(at,direction));
	}

	private spaceDown(sample: PenSample, _ev: PointerEvent): void {
		// Same watchdog reasoning as lassoDown and the pan branch above: this
		// is the one call site into a space gesture, so the reticle persists
		// through it from the first sample rather than only from whatever
		// hover happened to leave behind.
		const w = this.camera.screenToWorld(sample.x, sample.y);
		const here = this.strokesHere();
		// Resolve the seam once for the text position, ink membership and
		// displayed guide. Never re-hit-test the original contact at release.
		const plan=this.planSpace(w.y);
		if(!plan){this.spacePlan=null;this.spaceLineY=null;this.hideSpaceCursor();return;}
		const cut = plan.y;
		this.spacePlan={...plan,doc:this.view.state.doc};
		this.spaceLineY = cut;
		this.showSpaceCursor(sample);
		this.spaceFromY = w.y;
		this.spaceTotalDy = 0;
		// The id list freezes at pen-down, and so does the box around it:
		// membership cannot change mid-drag, so the damage region is just
		// that box swept by the distance travelled.
		this.spaceIds = strokeIdsBelow(here, cut);
		this.spaceBounds = boundsOf(here, this.spaceIds);
		if (this.spaceIds.length === 0 && !this.view.state.doc.sliceString(plan.from).trim()) {
			new Notice("Handwriting: no content below the line");
			this.spacePlan=null;this.spaceLineY=null;this.hideSpaceCursor();
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
		// Keep the initial snapped offset from the nib as the seam moves.
		// The small reticle and full-width divider follow this same value.
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
		const plan = this.spacePlan;
		this.spaceLineY = null;
		this.spaceIds = [];
		this.spaceBounds = null;
		this.spacePlan = null;
		this.spaceTotalDy = 0;
		if (!path || applied === 0 || !plan) {
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
		const change = this.spaceTextChange(plan, applied);
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
		if(strokeIds.length)inlineInk.save(path);
		const op = strokeIds.length?this.stampInkIdentity({ type: "move", path, strokeIds, dx: 0, dy }):null;
		try {
			this.view.dispatch({
				changes: change.changes ?? undefined,
				effects: op?inkEffect.of(op):undefined,
				annotations: op?[inkApplied.of(true), isolateHistory.of("full")]:isolateHistory.of("full"),
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
	 * A changed document, short drag or upward drag over nonblank text
	 * returns zero; the caller then rolls back the live ink movement.
	 */
	private spaceTextChange(
		plan: (SpaceBoundary & {doc: Text}) | null,
		applied: number
	): { changes: { from: number; to: number; insert: string } | null; dy: number } {
		const none = { changes: null, dy: 0 };
		if (!plan || plan.doc!==this.view.state.doc) return none;
		if(plan.text===false)return {changes:null,dy:applied};
		const lineHeight = plan.lineHeight;
		const steps = lineSteps(applied, lineHeight);
		if (steps === 0) return none;
		const pos = plan.from;
		const doc = this.view.state.doc;
		const line = doc.lineAt(pos);
		if (steps > 0) {
			return {
				// An internal break replaces an existing visual wrap. One extra
				// newline preserves that wrap before opening the requested space.
				changes: { from: pos, to: pos, insert: "\n".repeat(steps+(pos>line.from?1:0)) },
				dy: steps * lineHeight,
			};
		}
		// Closing up: take back only blank lines, never a word of writing.
		if(pos!==line.from)return none;
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
		this.snapPreview?.check();
		this.mobileTools?.refresh();
	}

	/**
	 * A TOOL change puts a selection away too, not just the next contact.
	 * Design §5o: leaving a lasso outline live after the strip's tool
	 * changed read as "the lasso selector remains" (Alan, device finding
	 * 2026-09-02). Exact idiom as the pen-contact clear at `:1919-1920`.
	 *
	 * The strip too, not just the canvas. The §5o listener refreshes every
	 * strip BEFORE it dissolves, so a refresh done there sees the selection
	 * that is about to go; Delete and Copy are gated on `hasInkSelection()`
	 * and stayed lit over nothing. Picking up Pan with ink selected is how
	 * that shows: the ruling clears the selection (pan and lasso are
	 * exclusive - alan, 2026-09-02) and the two buttons were left behind.
	 * `pasteInkHere` is the symmetric case and already does this - it selects
	 * what it pasted and refreshes so the buttons light UP. The pdf's
	 * `dissolveSelection` has ended in `refreshStrip()` all along; this is the
	 * note surface agreeing with it.
	 *
	 * Only when a selection actually went away: the listener has already
	 * refreshed once for the mode change itself, and an unconditional second
	 * refresh would run on every tool change for nothing.
	 */
	dissolveSelection(): void {
		if (!this.selection.clear()) return;
		this.redrawSelectionUI();
		this.refreshStrip();
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
		if (head) {
			this.tail.drawHead(
				cam,
				this.activeStyle,
				head.from,
				head.to,
				head.pressure,
				this.activeWet.liveHalfWidth(this.activeStyle, head.pressure)
			);
		}
	}

	/**
	 * A live gesture was torn down inside the router with no pointerup: a
	 * window blur (alt-tab, a system dialog, the on-screen keyboard).
	 *
	 * The blur twin of update()'s path-change branch, which is where each of
	 * these lines comes from - the same stale state, reached without a switch,
	 * and the branch that repairs it can never run because no path changed.
	 *
	 * NOT THE WINDOW BLUR ANY MORE (alan, 2026-09-04: "alt tab mid stroke -
	 * sure make it consistent"). A blur mid-stroke now COMMITS what was drawn,
	 * through the router's `finishActiveStroke()` -> `onPenUp` -> `penUp()`,
	 * which is the rule `docs/manual.md` already states for the pdf viewer
	 * rebuilding under the pen. What this method is FOR is the teardown that
	 * really does DROP a stroke - a note switch, where the editor is already
	 * showing a different note and the old note's fragment has nowhere to
	 * land. The pdf surface's twin carries the same split for the same reason.
	 *
	 * Nothing reaches it today, and that is worth saying out loud rather than
	 * leaving for a reader to discover with a grep. Its only caller is
	 * `onStrokeAbandoned`, and the router's one remaining call site for that
	 * callback (the blur handler's second branch) can only run when no stroke
	 * was live, which is exactly when `abandonActiveStroke()` returns false.
	 * The note switch that WOULD want this runs the same teardown inline
	 * instead - `update()`'s path-change branch: `resetGestureState()`, then
	 * `stripPenUp` gated on the boolean, then the wet/tail clears and the
	 * highlighter opacity. Kept as a method, kept wired, and kept executed by
	 * `AbandonedGestureStandsDown.test.ts`, because the callback's contract is
	 * "a stroke was really torn down" and a future caller of that branch could
	 * satisfy it; on the pdf the twin is live code, called by `forgetHistory`.
	 *
	 * The strip first. Such a teardown happens inside the router, where the
	 * `stripPenDown` the contact ran left `is-inking` on the strip and its
	 * collapsed pill (styles.css: opacity 0 AND visibility hidden, so
	 * unhit-testable) until some later stroke completed. Deliberately not
	 * `penUp()`, which commits ink - and committing is exactly what a dropped
	 * stroke must not do.
	 *
	 * THEN THE SURFACE'S OWN STATE, which the chrome-only version left
	 * untouched for two releases. `builder` stays live, the half-drawn stroke
	 * stays painted on the wet layer over a note nobody drew it on, and -
	 * worst of the three because it outlives the gesture - the stroke frame
	 * stays LOCKED, which freezes the camera and every repaint until the next
	 * pen-down (the v0.13.6 lifecycle rule `resetGestureState` states in its
	 * own header). The pdf surface has the identical body under the identical
	 * name, for the identical reason.
	 */
	private strokeAbandoned(): void {
		stripPenUp(this.mobileTools);
		this.resetGestureState();
		this.wet.clear(this.cssWidth, this.cssHeight);
		this.highlightWet.clear(this.cssWidth, this.cssHeight);
		// A teardown mid-handoff would otherwise strand the wet highlighter
		// element hidden for every later stroke - update()'s path-change
		// branch carries this same line for the same reason.
		this.highlightWetCanvas.setCssStyles({ opacity: String(HIGHLIGHTER_ALPHA) });
		this.tail.clearAll(this.cssWidth, this.cssHeight);
	}

	/**
	 * A second finger changes intent from drawing to pinch. Clear every
	 * provisional surface without entering penUp: there is no persistence,
	 * no undo record, and no ghost wet/tail frame left behind.
	 */
	private cancelFingerInkForPinch(): void {
		// penUp normally balances both of these, but pinch cancellation must
		// never enter penUp because that commits. End only the instrumentation
		// lifecycle before clearing the provisional surface state below.
		metrics.end(performance.now());
		this.stopFrameTicker();
		this.strokePenGesture = false;
		this.strokeAbandoned();
	}

	private resetGestureState(): void {
		this.clearSnapPreview();
		// Lifecycle rule (v0.13.6 fix): every gesture-state reset releases the
		// stroke frame lock. File switch and unmount reach here mid-stroke;
		// leaving the lock held froze the NEXT note's camera and repaints
		// until its first pen-down. A cancelled frame never leaks forward.
		this.frame.cancel();
		// A standing snap offer belongs to the note and the stroke it was made
		// about, and this method is every way both of those go away: a file
		// switch, an unmount (which is also what `destroy` and plugin unload
		// run) and an abandoned gesture. It takes the element out of the tree
		// AND unhooks the three listeners and the timer, none of which the
		// container's own removal would reach - they sit on the editor root,
		// the scroller and the document, all of which outlive this overlay.
		// Optional-chained because the harnesses that drive `penUp` through
		// `Object.create(prototype)` never run a field initialiser.
		this.snapChip?.dismiss();
		this.builder = null;
		this.mode = "ink";
		this.erased = [];
		// The other three erase-gesture fields, wiped here for the same reason
		// `erased` is: a file switch, an unmount or an abandoned gesture (window
		// blur, in-place switch) all reach this method with an erase mid-flight,
		// and none of them ever reach the erase pen-up that would otherwise be
		// the only place clearing them. Left alone, `erasePieces` carries the
		// abandoned gesture's minted ids into the next erase - so a stroke this
		// NEW gesture cuts for the first time is misread as a survivor rather
		// than a loss - and `eraseFrom` carries its stale pre-gesture list into
		// an undo op built for a note that isn't live anymore (deferral 3,
		// 1.4.10 design doc). `eraseWhole` is reset alongside them because it's
		// the same gesture's flag and pen-down sets all three together.
		this.erasePieces.clear();
		this.eraseFrom = [];
		this.eraseWhole = false;
		this.selection.clear();
		this.lassoPts = [];
		this.lassoActive = false;
		this.dragFrom = null;
		this.dragTotal = null;
		this.spaceLineY = null;
		this.spaceIds = [];
		this.spaceBounds = null;
		this.spacePlan = null;
		this.spaceTotalDy = 0;
		this.panLast = null;
		// The gesture is over, so the device that started it stops answering
		// for the wrappers. Reset here rather than at pen-up for the reason
		// the field's own comment gives, and in the same place the pdf's
		// `resetGestureState` resets its own.
		this.mouseStroke = false;
		this.selectionDeleteKeys.reset();
		// The empty-page refusal is NOT forgotten here, and that is the point.
		// This method is the ABANDON path too (`strokeAbandoned`: a window
		// blur, an alt-tab, a system dialog mid-scrub), and re-arming the gate
		// there brings back the spam the gate exists to stop - alt-tab away
		// mid-scrub, come back, scrub on, and the toast says it all over again,
		// on the same note with the same tool. EmptyPageNotice.ts header lists
		// what makes the sentence news again, and an interrupted gesture is not
		// on it. The two callers that really do put a fresh screen in front of
		// the reader - update()s path-change branch and unmount() - call
		// emptyNotice.forgetAll() themselves, right after this.
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
			// ONE constant for the page and the destination, because the two
			// must not drift: the ink is made readable against exactly the
			// rectangle that was just painted under it.
			ctx.fillStyle = SNIP_PAGE;
			ctx.fillRect(0, 0, out.width, out.height);
			ctx.setTransform(1, 0, 0, 1, -vp.x0 * vp.scale, -vp.y0 * vp.scale);
			const cam = { x: 0, y: 0, zoom: vp.scale };
			// A snip PNG is NOT transparent and does not inherit the note's
			// theme - it lands on the white rectangle above whatever theme it
			// was taken under - so its destination is known here and the ink
			// adapts to it, same direction as the PDF and for the same reason.
			//
			// The scope, rather than an argument: these strokes are drawn by
			// the shared committed renderer, whose colour accessor is the hot
			// path and may not grow a per-stroke parameter.
			withInkDestination(SNIP_PAGE, () => {
				// The pdf snip's layering exactly: highlighter as a wash under
				// the pen, both from committed geometry.
				ctx.globalAlpha = 0.35;
				for (const st of strokes) if (st.tool === "highlighter") drawStroke(ctx, cam, st, undefined, true);
				ctx.globalAlpha = 1;
				for (const st of strokes) if (st.tool !== "highlighter") drawStroke(ctx, cam, st, undefined, true);
			});
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

	/**
	 * Copy the lasso selection to the session ink clipboard (roadmap:
	 * copy/paste ink). Returns how many strokes were copied; 0 = no selection.
	 */
	copySelectedInk(): number {
		const path = this.filePath();
		if (!path || this.selection.isEmpty) return 0;
		const ids = new Set(this.selection.strokeIds);
		const strokes = this.strokesHere().filter((s) => ids.has(s.id));
		const n = copyInk(strokes, path);
		if (n > 0) publishInkMarker();
		return n;
	}

	/** Copy, then delete as one normal history step. */
	cutSelectedInk(): CutSelectionOutcome {
		const n = this.copySelectedInk();
		if (n === 0) return { kind: "empty" };
		// A cut is a copy AND a delete. When the delete removes nothing the
		// ink is still on the page, so answering "cut" here would report a
		// cut that did not happen - the clipboard holds the strokes and so
		// does the note. `cutSelectionNotice` owns the honest sentence for
		// that case, the same way `lassoDeleteNotice` owns the delete one.
		const outcome = this.deleteSelectedInk();
		return outcome.kind === "deleted" ? { kind: "cut", count: n } : { kind: "unmatched", count: n };
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
		// A blank note has no extent spacer yet. Grow it synchronously before
		// writing either scroll offset: browsers clamp an early write to the
		// old zero range, and the repaint that later creates the spacer does
		// not retry it. Fixed-grid ink can be offscreen on either axis.
		this.updateExtent(true);
		// Re-read the camera AFTER that layout change. The viewport mapping
		// below also reads fresh element rects, and a cached pre-extent camera
		// combined with post-extent rects would mix two coordinate frames.
		// syncCamera itself respects the active-stroke frame lock.
		this.syncCamera();
		const cam = this.camera.snapshot;
		const scroller = this.view.scrollDOM;
		const viewW = scroller.clientWidth;
		const viewH = scroller.clientHeight;
		// Camera screen coordinates are relative to the moving canvas BAND,
		// while scroll offsets and client sizes describe the scroller viewport.
		// Carry the band's current visual offset into the same layout-px space.
		const overlayRect = this.container?.getBoundingClientRect();
		const viewportRect = overlayRect ? scroller.getBoundingClientRect() : null;
		const offsetX = overlayRect && viewportRect
			? visualToNote(overlayRect.left - viewportRect.left, this.cssScale) - scroller.clientLeft
			: 0;
		const offsetY = overlayRect && viewportRect
			? visualToNote(overlayRect.top - viewportRect.top, this.cssScale) - scroller.clientTop
			: 0;
		const pastedInkIsVisible = strokes.some((stroke) =>
			strokeIntersectsViewport(stroke, cam, viewW, viewH, offsetX, offsetY)
		);
		if (!pastedInkIsVisible) {
			// A sparse selection can span the pane while its union bbox starts
			// in an EMPTY in-view corner (one stroke far right, one far below).
			// One bent stroke's bbox can do the same. Reveal a real centerline
			// point, not either kind of empty bounding-box corner.
			const target = strokes.find((stroke) => stroke.points.length > 0)?.points[0];
			if (target) {
				const leftX = (target.x - cam.x) * cam.zoom + offsetX;
				const topY = (target.y - cam.y) * cam.zoom + offsetY;
				if (leftX < 0 || leftX > viewW - 40) {
					scroller.scrollLeft += leftX - Math.min(120, viewW / 4);
				}
				if (topY < 0 || topY > viewH - 40) {
					scroller.scrollTop += topY - Math.min(120, viewH / 4);
				}
			}
		}
		this.mobileTools?.refresh();
		return strokes.length;
	}

	/**
	 * Delete the current lasso selection as one normal editor-history step.
	 * Returns how many strokes went, so callers can say "nothing selected".
	 */
	deleteSelectedInk(): DeleteSelectionOutcome {
		const path = this.filePath();
		// Copied before the store is asked: the ids are the evidence the
		// unresolved root-cause question needs, and on both failure paths
		// below the selection must survive to be logged AND to stay on
		// screen.
		const ids = [...this.selection.strokeIds];
		const n = ids.length;
		if (!path) {
			// A live selection with no resolvable path is not "nothing
			// selected" either - the user did lasso something, there is just
			// nowhere to look it up. Reuses "unmatched" rather than a third
			// kind: from the caller's side this and a selection the store
			// matched nothing in are the same fact, a real selection that
			// could not be removed, so they earn the same honest sentence and
			// the same kept lasso.
			if (n === 0) return { kind: "empty" };
			console.error("[handwriting] lasso delete with no resolvable path", { path: null, strokeIds: ids });
			return { kind: "unmatched", count: n };
		}
		const op = removeSelectedInlineStrokes(inlineInk, path, ids);
		// THE CHECK COMES BEFORE THE CLEAR. It used to come after, so a delete
		// that removed nothing still destroyed the lasso, and the user was told
		// to "lasso some ink first" with their selection already wiped -
		// re-lassoing the same strokes then failed identically.
		if (!op && n > 0) {
			// The one thing nobody was collecting. Which of the two candidate
			// causes this is - a selection holding ids an external sidecar
			// reload replaced, or `filePath()` resolving somewhere the strokes
			// are not stored - is not decided here, and these two values are
			// what decides it.
			console.error("[handwriting] lasso delete matched no strokes", { path, strokeIds: ids });
			return { kind: "unmatched", count: n };
		}
		this.selection.clear();
		this.redrawSelectionUI();
		if (!op) return { kind: "empty" };
		this.dispatchInk(op);
		this.scheduleRepaint();
		this.repaintPath(path);
		return { kind: "deleted", count: n };
	}

	/** Bind every live publication to its record before asynchronous claims settle. */
	private stampInkIdentity(op: InkOp): InkOp {
		if (op.historyIdentity === undefined) {
			op = { ...op, historyIdentity: inlineInk.captureHistoryIdentity(op.path) };
		}
		if (op.pageId === undefined) {
			const id = inlineInk.pageIdOf(op.path);
			if (id) op = { ...op, pageId: id };
		}
		return op;
	}

	/**
	 * Record a finished gesture in the EDITOR's history, so unmodified Ctrl+Z /
	 * Redo covers ink in chronological order with text edits. The store
	 * already reflects the gesture (inkApplied), and isolateHistory keeps
	 * each gesture its own undo step; strokes never merge into one entry.
	 */
	private dispatchInk(op: InkOp): void {
		op = this.stampInkIdentity(op);
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
	 * The session token follows the record through renames and page-id
	 * reassignment, including before the first claim. A missing token target
	 * means the record was removed: skip without guessing by page id or path.
	 * Older ops without a token retain their page-id/path resolution.
	 */
	private opPath(op: InkOp): string | null {
		if (op.historyIdentity !== undefined) {
			return inlineInk.pathForHistoryIdentity(op.historyIdentity);
		}
		if (op.pageId === undefined) return op.path;
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
				inlineInk.takeLive(op.path, op.removed.map((st) => st.id));
				inlineInk.applyAddLive(op.path, op.inserted, op.insertedAt);
				// Persist and notify only the complete replacement, never its removal half.
				inlineInk.save(op.path);
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
		if (this.repaintQueued) {
			// A second request folded into the frame already queued. The
			// purged-canvas probe only fires on a frame that NOTHING but
			// scrolling asked for, so any other caller joining takes that
			// away - the frame is now doing work on somebody's behalf.
			if (via !== "scroll") this.repaintScrollOnly = false;
			return;
		}
		if (!this.container) return;
		this.repaintScrollOnly = via === "scroll";
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
		if (this.deferPinchRaster()) return;
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
		// The purged-canvas marker, and everything about it, is off unless
		// this is a mobile surface with diagnostics recording (PurgeSentinel.ts
		// says why it is not on for everyone yet). Desktop pays one boolean.
		const probeArmed = purgeProbeArmed(Platform.isMobileApp, diagnosticsEnabled());
		if (work === "all") {
			drawCommitted(this.highlightCtx, cam, strokes, this.cssWidth, this.cssHeight, true, "highlighter");
			drawCommitted(this.committedCtx, cam, strokes, this.cssWidth, this.cssHeight, true, "pen", probeArmed);
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
			// A damage rect covering the band corner clears the marker, and
			// `drawRegion` has no reason to know about it. Repainting is
			// idempotent, so this needs no test for whether it was hit.
			if (probeArmed) paintPurgeSentinel(this.committedCtx);
		}
		// ---- the purge heal (1.4.12-design.md §14, cause B) -----------------
		// A scroll repaint with no work drew nothing, which is correct while
		// the camera is still and catastrophic if WebKit has quietly taken the
		// canvas's pixels: nothing would ask for them again until the band
		// moved. Read the marker back; a zero means they are gone, and
		// `scheduleRepaint` with any via but "scroll"/"partial" is what
		// asserts `damage.addAll()` and puts the world back on screen.
		if (
			purgeProbeDue({
				armed: probeArmed,
				scrollRepaint: this.repaintScrollOnly,
				foundWork: work === "all" || work.length > 0,
				strokeOwnsFrame: this.frame.locked,
				noteHasInk: strokes.length > 0,
				now: performance.now(),
				lastProbe: this.lastPurgeProbe,
			})
		) {
			this.lastPurgeProbe = performance.now();
			if (purgeDetected(readPurgeSentinel(this.committedCtx))) {
				this.scheduleRepaint("purge-heal");
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
		if (this.deferPinchRaster()) return;
		if (!this.container || this.frame.locked) return;
		const path = this.filePath();
		if (!path) return;
		// Repaint ends here, so this runs on every scrolled frame. Nothing
		// below can grant a different extent while the ink frontier and the
		// camera/zoom/viewport inputs all stand still, and everything below
		// forces layout - two getBoundingClientRect, the origin, the spacer
		// position. Skip it. Gesture ends pass force and never skip. §5g/G1.
		const cam = this.camera.snapshot;
		// Written-on: ink present, or the pen has been seen this session (the
		// same predicate the strip uses, InkOverlay.ts:1270 - PenToolsMode's
		// flag can flip true on pen contact alone, before any stroke exists).
		// Carried as its own ExtentInputs field, not folded into `frontier`:
		// that flip changes no stroke count, so `frontier` would stay the same
		// object and the G1 skip guard below would hold the pre-contact extent
		// for a whole gesture (1.4.6 §5n).
		const writtenOn = inlineInk.strokes(path).length > 0 || penSeenThisSession();
		const scroller = this.view.scrollDOM;
		const expansion = this.scrollExpansion ?? (scrollExpansionEnabled ? (this.scrollExpansion = new ScrollExpansionDemand()) : null);
		const scrollRevision = expansion?.sample(path, scrollExpansionEnabled, scroller.scrollLeft, scroller.scrollTop) ?? 0;
		const inputs: ExtentInputs = {
			scrollRevision,
			granted: surfaceExtents.get(path),
			path,
			frontier: this.frontierCache.get(path, inlineInk.strokes(path)),
			writtenOn,
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
		// The origin is needed BEFORE growing now: the zoom frontier is
		// origin-relative, and it joins the ink frontier in one grow so a
		// magnified note's overhang is scrollable (see zoomFrontier).
		const contentRect = this.view.contentDOM.getBoundingClientRect();
		const preRect = scroller.getBoundingClientRect();
		const origin = surfaceOriginInScroller({
			contentLeftVisual: this.columnLeft(),
			documentTopVisual: this.view.documentTop,
			scrollRectLeft: preRect.left,
			scrollRectTop: preRect.top,
			scrollLeft: scroller.scrollLeft,
			scrollTop: scroller.scrollTop,
			scale: this.cssScale,
		});
		const ink = inputs.frontier;
		// Shared with writeFrontier below - both need the same document-bottom
		// number and neither may re-read layout to get it.
		const contentBottom = (contentRect.bottom - preRect.top) / this.cssScale + scroller.scrollTop;
		const zoom = this.viewportLayout ? ZERO_EXTENT : zoomFrontier({
			clientWidth: scroller.clientWidth,
			clientHeight: scroller.clientHeight,
			contentBottom,
			origin,
			pinchScale: this.pinchScaleNow,
			fontZoom: this.fontZoom,
		});
		// Room to write at the top of the screen (1.4.6 §5n): only granted
		// while the surface is being written on, so a typing-only note keeps a
		// byte-identical extent.
		const write = inputs.writtenOn
			? writeFrontier({
					clientHeight: this.viewportLayout?.height ?? scroller.clientHeight,
					contentBottom,
					origin,
					fontZoom: this.fontZoom,
				})
			: ZERO_EXTENT;
		const scroll = scrollExpansionEnabled && expansion ? expansion.reserve({
			left: scroller.scrollLeft, top: scroller.scrollTop,
			nativeWidth: scroller.clientWidth, nativeHeight: scroller.clientHeight,
			width: scroller.clientWidth,
			height: scroller.clientHeight,
			edgeX: scroller.scrollWidth, edgeY: scroller.scrollHeight,
			origin, fontZoom: this.fontZoom, pinchScale: this.pinchScaleNow,
		}) : ZERO_EXTENT;
		const granted = surfaceExtents.grow(path, {
			x: Math.max(ink.x, zoom.x, scroll.x),
			y: Math.max(ink.y, zoom.y, write.y, scroll.y),
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
		expansion?.applied(pos.left + 1, pos.top + 1);
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

const inkOverlayPlugin = ViewPlugin.fromClass(InkOverlayPlugin, {
	provide: plugin => EditorView.editorAttributes.of(view =>
		view.plugin(plugin)?.ownsNoteViewport() ? { class: "handwriting-note-viewport" } : null
	),
});

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
