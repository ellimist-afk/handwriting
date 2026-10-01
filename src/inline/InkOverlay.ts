import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { EditorSelection, EditorState, StateEffect, Prec, type Text, type SelectionRange } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { isolateHistory, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { Notice, Platform, editorInfoField } from "obsidian";
import type { Editor, TFile } from "obsidian";
import { runGatedCommand } from "../CommandPaletteSplit";
import { Camera } from "../camera/Camera";
import { CameraState } from "../camera/coordinates";
import { contentOrigin, contentOriginLeft } from "./ContentOrigin";
import { anchorPaddingTop, anchorTop } from "./DocumentTop";
import { RUNG_SPACING, anchorParityBar, cameraOriginYLayout, documentAnchorLadder, growDocumentAnchorLadder, impliedDocumentTop, refuseDocumentAnchor, rungIndexFor, unmountDocumentAnchor } from "./DocumentAnchor";
import { stableCameraOriginY, type CameraOriginY } from "./CameraOriginY";
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
	spaceProtectedBlocks,
	type SpaceProtectedBlock,
} from "./InsertSpace";
import { MobileTools, NoteZoomControls, ensureNoteZoomControls, destroyNoteZoomControls } from "./MobileTools";
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
 * How long a pinch preview may hold CodeMirror's measure scheduling with no
 * preview frame before the hold releases itself; see `holdMeasures`.
 *
 * Every end path releases the hold. This is the bound for an end that never
 * arrives (a pointer lost without its cancel event, which leaves the preview
 * flagged for the rest of the gesture's lifetime): past it, CodeMirror
 * schedules again, so typing and scrolling get their measures back. The price
 * is on the other side: a pinch held still for longer than this gets one
 * CodeMirror rescale of the scroll under the frozen preview, the pre-fix
 * displacement, once, until the next preview frame solves the pan against
 * the moved scroll. Ten seconds is long for a held pinch and short for a
 * lost end.
 */
const PINCH_MEASURE_HOLD_MAX_MS = 10_000;

/** A CodeMirror measure request, as `EditorView.requestMeasure` takes it. */
type CmMeasureRequest = NonNullable<Parameters<EditorView["requestMeasure"]>[0]>;

/** One entry of the view the hold shadows; see `holdMeasures`. */
interface MeasureHoldEntry {
	name: "requestMeasure" | "measure";
	/** The own-property descriptor the shadow displaced, if the view had one. */
	displaced: PropertyDescriptor | undefined;
	/** What a call reached before the hold: the displaced callable, else the prototype's. Captured once. */
	callable: (this: EditorView, ...args: unknown[]) => unknown;
	shadow: (...args: unknown[]) => unknown;
}

/** CodeMirror's measuring, held for a pinch preview; see `holdMeasures`. */
interface MeasureHold {
	entries: MeasureHoldEntry[];
	/** Requests other callers made during the preview, last per key. */
	requests: CmMeasureRequest[];
	/** Whether a plain `requestMeasure()` was asked for during the preview. */
	plain: boolean;
	/** Whether a measure callback CodeMirror had already scheduled reached the shadow. */
	swallowed: boolean;
	/** The lost-end bound; see PINCH_MEASURE_HOLD_MAX_MS. */
	timer: ReturnType<Window["setTimeout"]>;
}

/**
 * How much of the note's box the focal pan must leave inside the pane.
 *
 * The pan is a translate with no clamp of its own, so a gesture computed
 * against a degenerate frame - a zero-width column, a host mid-relayout - could
 * ask for a displacement that carries the whole note off the pane and leaves
 * the reader looking at nothing, with no scrollbar to bring it back because the
 * scroller itself has not moved. Clamp against the note content bounds so
 * this much overlap remains on each axis where possible. The natural top edge
 * takes precedence when a very small note cannot provide that much overlap.
 *
 * NOT a dead band, and there is deliberately none of those: the preview pan is
 * applied at full precision on every frame. A dead band big enough to swallow
 * rect noise (the first attempt used 1.5px) is bigger than the 0.75px the
 * written-ink drift guard permits, so it would trade one visible error for
 * another; quantisation is handled where it actually arises, at the settle,
 * where the scroll takes whole pixels and the fraction stays as pan.
 */
const PAN_MIN_VISIBLE_PX = 24;
/**
 * A DRAG, NOT A ZOOM. The give is a pan claim, and a preview frame that is changing the scale must
 * keep the note under the focal point with no bound at all - that is what the settle-only bound exists for
 * and what the earlier attempt at this broke (3884c642, "take the preview clamp back out, it breaks the
 * focal hold"). A frame counts as a drag while the scale is within this of where the gesture started.
 */
const PAN_DRAG_SCALE_EPS = 0.05;
/**
 * The scale has held when it is within this of the scale PAN_DRAG_WINDOW frames ago. Measured: a
 * zoom the rig ramps at 0.31 percent a frame (RllColumnFocalHold, 85 percent with travel) moves 2.5
 * percent over eight frames and must keep its focal hold; a spread held by two fingers moves well under
 * 0.8 percent over eight. The window is the lead a drag gets before the band engages.
 */
const PAN_DRAG_FRAME_EPS = 0.008;
const PAN_DRAG_WINDOW = 8;
/**
 * Box comparisons under this are not a fit or a miss, just layout rounding: a
 * column that fits leaves a fraction of a pixel behind on some zooms, and a
 * fraction is not something a pan can be spent into. Measured on the render
 * fixture: the scroller's remaining range is 0 at 100% in both
 * readable-line-length states and 0 at 150% with readable line length on (the
 * 700 px column still fits the 1397.5 px pane), 466 at 150% with it off.
 */
const PAN_FIT_SLACK_PX = 1;
/**
 * A settle counts as a ZOOM, for the fitting clamp, only when it commits a
 * scale outside this band of the scale its gesture began at. A two-finger drag
 * is never a pure translation on a real screen: once the fingers have moved
 * past the router's 12 px pinch slop and the gesture is live, their spread keeps
 * wandering, a scale drift of 1-12% (a drift smaller than the slop never starts
 * the gesture at all). A drag that ends at 1.03 or 1.12 of its start is still a
 * drag, and it keeps the pan contract - the page stays where the fingers left
 * it. An in-then-out pinch that comes back near its start is the same case.
 */
const PAN_SETTLE_ZOOM_BAND = { below: 0.8, above: 1.25 };
/**
 * THE OVERSCROLL BOUNCE. Where the settle of a zoom clamps a
 * page that hung off the pane back inside it (panAxisWindow), the correction
 * used to arrive in one frame: the page jumped. It now plays out as a visual
 * offset that starts at the overshoot, where the last preview frame left the
 * page, and eases to zero, so the page springs back onto the pane.
 *
 * VISUAL ONLY. The settle writes its clamped rest into `viewportPan` exactly
 * as before, on the settle's own frame, and the bounce never touches it: the
 * offset rides on top in panX/panY, which every pan write reads (the text's
 * sizer, the ink layer, the paper), so ink, paper and text move as one. It
 * eases out and ends at zero - no momentum, nothing re-enters - and any input
 * that maps a point (a pen down, a new pinch, a wheel, a touch) takes the
 * page to its rest first.
 *
 * HALF A SECOND, matched to OneNote's overscroll as Alan filmed it (release to
 * rest about 0.53 s at 15 fps, one ease, never past the rest). It was 180 ms; if
 * that feels slow on the device, this one number sets it back.
 */
const OVERSCROLL_BOUNCE_MS = 500;
/** A correction smaller than this, in painted px, is not animated: it cannot be seen, and a settle stands within it. */
const OVERSCROLL_BOUNCE_MIN_PX = 2;
/**
 * THE GIVE AT AN END, painted px before the external scale: about an inch, the distance
 * Alan asked for ("give a little, then spring back"). A drag or a fling that runs out of
 * page may hold it this far past the end and no further; the lift eases it back through
 * the bounce above. Multiplied by the external scale at the point of use, so the give is
 * an inch of GLASS whatever the pane is scaled to. The ruled constant A.
 *
 * ONE CONSTANT FOR BOTH LANES: the fling's give at an end and the give a two-finger drag
 * preview gets past its bound are the same quantity, so the drag band reads this and no second copy
 * exists. Alan's reference for the drag half is about 90 px dragging down at 72%. A first guess, to
 * be tuned on the device, not a measured constant.
 */
const OVERSCROLL_GIVE_PX = 96;

interface PinchConstraintGeometry {
	left: number; top: number; paneWidth: number; paneHeight: number;
	/** The painted scrollbar in SCREEN px, measured at the last settle. Not predictable from the
	 *  host-local width - see applyViewportBox. Already in the consumer's units: do not scale it. */
	gutterScreen: number;
	width: number; height: number; external: number; x: boolean; y: boolean;
	/** The PAGE's own box on x, without the room Infinite Canvas has granted beside it: what "does it fit the pane" must ask. */
	pageWidth: number;
	/** Zero-native-scroll content-box inset, including its normal title/padding. */
	naturalLeft: number | null;
	naturalTop: number | null;
}

interface PinchConstraint {
	clientX: number; clientY: number; offsetX: number; offsetY: number;
	geometry: PinchConstraintGeometry | null;
}

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
import { Band, BandViewport, bandCovers, bandFor, bandNeedsMove } from "./ScrollBand";
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
import { DamageLedger, shiftPlan } from "../ink/DamageLedger";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DWELL_MS, snapStroke } from "../ink/ShapeSnap";
import { beginUndoWindow, discardUndoTrace, isUndoRedoKey, registerUndoTraceView, unregisterUndoTraceView } from "../diag/UndoHistoryTrace";

const sessionStartMs = Date.now();
import { anchoredScroll, pinchScale, fitInkBounds, clampToReachable, MIN_PINCH_SCALE, MAX_PINCH_SCALE, PINCH_GIVE, MAX_VIEWPORT_LAYOUT, type InkFitBounds } from "./PinchScale";
import { WheelZoomRun, WHEEL_ZOOM_QUIET_MS } from "./WheelZoom";
import { canvasForNote, onCanvasOverrideChanged } from "./CanvasNoteOverride";
import { ERASER_CURSOR_CLASS } from "./PenCursor";
import { DEFAULT_ERASER_RADIUS_PX, clampEraserRadius } from "../ink/EraserSize";
import {
	backingScale,
	ownedEffectiveScale,
	validCameraScale,
	fontZoomFactor,
	noteToVisual,
	visualToNote,
 canvasLayerBox,
 zoomScalesClientRects } from "./ZoomScale";
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
import { Extent, inkClaimX, inkFrontier, isScrollableOverflow, leftReserve, onScreenFloorX, ScrollAxisGuard, ScrollExpansionDemand, SHRINK_SCROLL_IDLE_MS, shrunkAxis, spacerPosition, surfaceExtents, surfaceOriginInScroller, writeFrontier, writeFrontierApplies, ZERO_EXTENT, zoomFrontier } from "./SurfaceExtent";
import { ProbeBox, capturePresented, parseHexColor, regionCensus } from "./PresentProbe";
import { paperPlan, type PaperPlan } from "./PaperPlan";
import { copyPreviewPaperBackground, foldIntoPitch, fractionOf, previewPaperCopyable, previewPaperPhase, previewPaperPitch, type PreviewPaperEnd, type PreviewPaperSource } from "./PaperPan";
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

/** The paper properties the overlay plans; see updatePaperSpacing. */
const PAPER_PROPERTIES = ["--handwriting-paper-pitch", "--handwriting-paper-rule", "--handwriting-paper-dot", "--handwriting-paper-phase", "--handwriting-paper-phase-x"] as const;

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

// ---- the committed raster's camera test -------------------------------------
//
// The camera is re-measured from DOM rects on every scrolled frame. At a
// fractional scroll offset those rects come back a hair off the camera the
// raster was painted with, far under one device pixel, and an exact compare
// read that as a move and redrew the whole layer: 59 of 67 still-band scroll
// repaints on Orion, 90 percent of the paint time, with the camera printing
// the same to two decimals. A move under a tenth of a backing pixel cannot
// change a pixel, so it is not a move.
//
// The compare is against the camera the raster was PAINTED with, and that
// record is left alone while the camera stays inside the bar, so many small
// steps add up against the painted camera and the one that crosses the bar
// redraws; error never stacks. Zoom stays exact.

/** A camera move under this many backing (device) pixels is not a move for the committed raster. */
export const CAMERA_STILL_BACKING_PX = 0.1;

export type RasterCamera = { x: number; y: number; zoom: number };

/** Why a repaint redraws the whole committed layer. */
export type RepaintAllSource = "first" | "zoom" | "camera" | "damage";

/**
 * Whether the camera (cx, cy, cz) is within `px` backing pixels of the painted one (px_, py, pz). Zoom must
 * match exactly. With no usable backing or zoom the bar is zero and only an exact match passes.
 */
export function cameraWithin(
	px_: number, py: number, pz: number, cx: number, cy: number, cz: number, backing: number, px: number
): boolean {
	if (pz !== cz) return false;
	if (px_ === cx && py === cy) return true;
	const bar = backing > 0 && Number.isFinite(backing) && cz > 0 ? px / (backing * cz) : 0;
	return Math.abs(cx - px_) < bar && Math.abs(cy - py) < bar;
}

/**
 * What a repaint owes the committed layer, and the camera to record as painted afterwards. A carried band
 * move gets the same bar as every other frame: the carry records the camera its slid pixels sit at.
 */
export function committedRepaintPlan(
	painted: RasterCamera | null, cam: RasterCamera, damage: "all" | BBox[], backing: number
): { work: "all" | BBox[]; sources: RepaintAllSource[]; painted: RasterCamera } {
	const sources: RepaintAllSource[] = [];
	let still = false;
	if (painted === null) sources.push("first");
	else if (painted.zoom !== cam.zoom) sources.push("zoom");
	else {
		still = cameraWithin(painted.x, painted.y, painted.zoom, cam.x, cam.y, cam.zoom, backing, CAMERA_STILL_BACKING_PX);
		if (!still) sources.push("camera");
	}
	if (damage === "all") sources.push("damage");
	const work = sources.length > 0 ? "all" : damage;
	// A full redraw paints at the camera now; inside the bar the raster is still the painted one.
	const next = work !== "all" && still && painted ? painted : { x: cam.x, y: cam.y, zoom: cam.zoom };
	return { work, sources, painted: next };
}


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
 *
 * Through the editor's own window: Chromium refuses a clipboard write from a
 * document that is not focused, and in a popout the main window's is not
 * (audit 60).
 */
function publishInkMarker(win: Window): void {
	const marker = inkClipboardMarker();
	if (marker === null) return;
	try {
		void win.navigator.clipboard?.writeText(marker).catch(() => {
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
	// Off: the room scrolling demanded is no longer asked for, so every note's
	// sideways grant comes back down to what its ink needs (shrinkSideways).
	if (!on) surfaceExtents.oweShrinkXEverywhere();
	// The mode IS the gate for the ctrl+wheel zoom, so turning it off
	// mid-run leaves a preview up with nothing left to end it. End it here, on
	// its own anchor, before the mode changes anything else.
	if (!on) for (const overlay of instances) overlay.endWheelZoomRun();
	// The global is only the DEFAULT now; each note answers for itself (a frontmatter
	// override, src/inline/CanvasNoteOverride.ts). Every mounted note re-reads its own answer and
	// applies it: momentum, the wheel zoom, and a zoomed note landing back at 100 percent when its
	// canvas goes off.
	for (const overlay of instances) {
		overlay.applyCanvasMode();
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

/** Peel one tool layer without disabling real pen contact or changing the chosen nib. */
export function peelInkEscapeFloor(event: KeyboardEvent): boolean {
	if (event.key !== "Escape" || event.defaultPrevented) return false;
	if (tipModeHeld()) {
		releaseTipModes();
		hidePenCursorsEverywhere();
		refreshAllStrips();
	} else if (mouseInkEnabled() || toolPickedHere()) {
		releaseMouseInkQuietlyEverywhere();
	} else return false;
	event.preventDefault();
	return true;
}

/** A selection still gets its own press when focus has left the editor. */
export function peelInlineEscapeSelection(doc: Document, event: KeyboardEvent): boolean {
	if (event.key !== "Escape" || event.defaultPrevented) return false;
	for (const overlay of instances) {
		if (overlay.ownerDocument === doc && overlay.hasSelection) return overlay.handleKeyDown(event);
	}
	return false;
}

/** The host may close a window before CodeMirror destroys its views. */
export function closeInlineInkDocument(doc: Document): void {
	for (const overlay of [...instances]) {
		if (overlay.ownerDocument === doc) overlay.destroy();
	}
}

/** Bubble on the window so host dialogs and every pane get Escape first. */
export function bindInkEscapeWindow(win: Window, peelSelection: (event: KeyboardEvent) => boolean): () => void {
	const doc = win.document;
	const onKey = (event: KeyboardEvent): void => {
		if (event.key !== "Escape" || event.defaultPrevented) return;
		const hostLayers = doc.querySelectorAll(".modal-container, .menu, .suggestion-container");
		if ([...hostLayers].some(layer => layer.getClientRects().length > 0 && win.getComputedStyle(layer).visibility !== "hidden")) return;
		if (!peelSelection(event)) peelInkEscapeFloor(event);
	};
	win.addEventListener("keydown", onKey);
	return () => win.removeEventListener("keydown", onKey);
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

export interface InlineReloadBinding {
	pane: object;
	attachment: object;
	epoch: number;
	file: object;
	editor: object | undefined;
	path: string;
	quiet: boolean;
}

/** Census includes busy bindings; a quiet sibling cannot hide one. */
export function inlineReloadBindings(): InlineReloadBinding[] {
	const bindings: InlineReloadBinding[] = [];
	for (const pane of instances) {
		const binding = pane.reloadBinding();
		if (binding) bindings.push(binding);
	}
	return bindings;
}

/** A note is eligible only when every attached pane on it is quiet. */
export function inlineReloadCandidates(): string[] {
	const quietByPath = new Map<string, boolean>();
	for (const binding of inlineReloadBindings()) {
		quietByPath.set(binding.path, (quietByPath.get(binding.path) ?? true) && binding.quiet);
	}
	return [...quietByPath].filter(([, quiet]) => quiet).map(([path]) => path);
}

/** The same cohort must remain attached, bound to this document, and quiet. */
export function captureInlineReloadAdmission(path: string): (() => boolean) | null {
	const bindings = () => inlineReloadBindings().filter(binding => binding.path === path);
	const expected = bindings();
	if (!expected.length || expected.some(binding => !binding.quiet)) return null;
	return () => {
		const current = bindings();
		return current.length === expected.length && expected.every((before, index) => {
			const now = current[index];
			return !!now && now.quiet && now.pane === before.pane && now.attachment === before.attachment &&
				now.epoch === before.epoch && now.file === before.file && now.editor === before.editor;
		});
	};
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
 * at `path` as ONE editor-history entry. A command may supply the pane it
 * started in; a missing or unmounted preferred pane refuses, never falls back
 * to the first pane showing the same note. Legacy path-only callers retain
 * their first-mounted lookup. A single Ctrl+Z restores all strokes with
 * z-order intact, exactly like undoing one big erase.
 * Returns the stroke count removed, 0 when the note
 * had none, or null when no mounted editor is showing that note (the wipe
 * needs an editor's history to be undoable, so there is no store-only path).
 */
export function deleteAllInkOn(path: string, preferred?: InkOverlayPlugin | null): number | null {
	if (preferred !== undefined) {
		return preferred && instances.has(preferred) && preferred.showsPath(path)
			? preferred.clearAllInk(path)
			: null;
	}
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

/**
 * The width floor a committed paint uses, or undefined when there is no
 * committed backing to floor against.
 *
 * A FREE FUNCTION, not a method, and that is load-bearing: `repaint` is invoked
 * in the render harness on partial objects that carry the overlay's data fields
 * without its prototype. `this.committedBacking` resolves there; a
 * `committedFloorFor(this.committedBacking, this.dpr)` does not - it fails with "is not a function" inside
 * the page, past the type checker, and only two render tests catch it. Taking
 * the values as arguments keeps ONE definition for both paint sites without
 * depending on what `this` is.
 *
 * `backing` is the exact multiplier the committed context was set with, never
 * re-derived - see WidthFloor.ts.
 */
function committedFloorFor(backing: number | null, dpr: number): { backing: number; dpr: number } | undefined {
	return backing === null ? undefined : { backing, dpr };
}

/**
 * `raw` moved toward `bounded` by the largest whole number of device px not above the exact clamp move, so
 * the page keeps the grid its ink is rastered on and never moves further than the bound asked. It can rest
 * under one device px past the bound, which is not a visible overscroll. `bounded` itself when the bound did
 * not move the page.
 */
export function onDeviceGrid(raw: number, bounded: number, dpr: number): number {
	const k = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
	const d = (raw - bounded) * k;
	// Float noise is not a correction: the bound's own value stands.
	if (!Number.isFinite(d) || Math.abs(d) < 1e-6) return bounded;
	return raw - (d > 0 ? Math.floor(d + 1e-6) : Math.ceil(d - 1e-6)) / k;
}

export class InkOverlayPlugin {
	private view: EditorView;
	private container: HTMLElement | null = null;
	private committedCanvas!: HTMLCanvasElement;
	private wetCanvas!: HTMLCanvasElement;
	/** The pen wet layer's small tile, over the full wet canvas (WetInkRenderer.configureWetTile). */
	private wetTileCanvas!: HTMLCanvasElement;
	private tailCanvas!: HTMLCanvasElement;
	/** Whether tailCanvas is dressed at highlighter alpha (see dressTail). */
	private tailWashed = false;
	private highlightCanvas!: HTMLCanvasElement;
	private highlightWetCanvas!: HTMLCanvasElement;
	/**
	 * True while the highlight pair holds a 0x0 backing: no compositor layer,
	 * no GPU resource. A note with no highlighter ink then blends two
	 * full-size layers per frame instead of four. Set by mount(); cleared for
	 * the life of the mount by allocateHighlightPair(), the first time the
	 * note needs the pair (a highlighter pen-down, or a highlighter stroke to
	 * paint). Nothing is hidden instead: a canvas that is drawn while hidden
	 * makes Chromium block the main thread on the GPU on every later frame.
	 */
	private highlightPairDeferred = false;
	/**
	 * True while the pen wet canvas holds a 0x0 backing, so a moving page
	 * blends one full-size layer fewer. False at mount: a note that never
	 * scrolls keeps its wet canvas sized. A scroll or a bounce frame with no
	 * stroke in flight and a proven-blank wet layer sets it
	 * (releaseWetIfIdle); the next pen stroke or pinch sizes the canvas again
	 * (allocateWet). The canvas keeps its box and is never hidden.
	 */
	private wetDeferred = false;
	/** Read once at mount from window.HW_ARM_W_OFF: true keeps the wet canvas sized (a render cell's control arm). */
	private wetReleaseOff = false;
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
	/** How many strokes the store held at the last committed paint, full or partial. A band carry trusts the raster only while the store still holds that many. */
	private paintedStrokeCount = -1;
	/** Diagnostic only: this frame's band move carried its pixels. Read by the scroll probe's repaint line, nowhere else. */
	private bandCarriedThisFrame = false;
	private originStyles = new WeakMap<Element, CSSStyleDeclaration>();
	private retiring = false;
	private selection = new SelectionModel();
	private readonly selectionDeleteKeys = new InlineSelectionDeleteKeys(
		() => !this.selection.isEmpty,
		() => this.deleteSelectedInk()
	);
	private lassoPts: Point2[] = [];
	private lassoActive = false;
	private dragFrom: { x: number; y: number } | null = null;
	private dragTotal: { dx: number; dy: number } | null = null;
	/** The strokes a selection drag picked up at pen-down; see commitLiveDrag. */
	private dragIds: string[] = [];
	/** The note a live selection drag moves ink in; see rollbackLiveGesture. */
	private dragHistoryIdentity: symbol | null = null;
	/** The note a live erase changes; see rollbackLiveGesture. */
	private eraseHistoryIdentity: symbol | null = null;
	/** Insert-space gesture: divider world y, or null when no gesture. */
	private spaceLineY: number | null = null;
	/** Ids frozen at pen-down; the live drag and the op both use this list. */
	private spaceIds: string[] = [];
	/** Box around those ids, tracked through the drag so damage stays bounded. */
	private spaceBounds: BBox | null = null;
	/** The same text/ink seam as the guide, frozen before any live movement. */
	private spacePlan: (SpaceBoundary & {doc: Text}) | null = null;
	/** Record identity survives rename and cannot resolve to a replacement note. */
	private spaceHistoryIdentity: symbol | null = null;
	private spaceRowsCache = new InsertSpaceRows();
	private spaceTextEnd: {doc:Text;pos:number;blocks:SpaceProtectedBlock[]} | null = null;
	private spacePreview: {plan:SpaceBoundary;doc:Text;moving:string[];staying:string[];rows:ReturnType<InsertSpaceRows["get"]>} | null = null;
	private spaceHoverY: number | null = null;
	private spaceFeedbackRaf: number | null = null;
	/** What the last hover feedback frame drew, so an identical frame is skipped. */
	private spaceFeedbackKey: {hoverY:number;doc:Text;mode:string;rows:unknown;x:number;y:number;zoom:number;w:number;h:number;preview:unknown} | null = null;
	/** Last viewport point of a pan drag; client space, so scrolling cannot
	 * feed back into the delta the way surface coordinates would. */
	private panLast: { x: number; y: number } | null = null;
	private spaceFromY = 0;
	private spaceTotalDy = 0;
	private penCursorEl: HTMLElement | null = null;
	private penCursorPinned = false;
	private penCursorClient: PenSample | null = null;
	// Whether the reticle is showing. The element itself stays display: block
	// from creation and is shown and hidden by opacity on its own layer, so
	// neither edge invalidates the document (a whole-window re-raster at
	// pen-down, measured on Orion); this field is the state a style read was.
	private penCursorShown = false;
	private mobileTools: MobileTools | null = null;
	private noteZoomControls: NoteZoomControls | null = null;
	private eraserEl: HTMLElement | null = null;

	private cssWidth = 0;
	private cssHeight = 0;
	private dpr = 1;
	/**
	 * The exact backing multiplier the committed canvas's OWN transform was
	 * last set with (assigned at the same point as that setTransform call,
	 * never recomputed). Reallocation is skipped whenever the "unchanged"
	 * check holds, and cssScale can still move in the meantime (e.g. during
	 * a locked frame) - so backingNow() read at paint time can disagree with
	 * what the raster actually is. This field cannot: it is only ever the
	 * value setTransform received.
	 */
	private committedBacking: number | null = null;
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
	/** The non-passive ctrl+wheel listener that zooms the note. Separate from `wheelFn`, which stays diagnostic-only and passive. */
	private ctrlWheelFn: ((e: WheelEvent) => void) | null = null;
	private wheelZoomRun = new WheelZoomRun();
	/**
	 * Alan, 2026-09-20: INFINITE CANVAS IS THE MODE, PER NOTE. True when this note is a canvas:
	 * its own frontmatter choice if it has one, else the global setting. Cached here and re-read by
	 * `applyCanvasMode` (mount, the global toggle, an override change), so the per-frame paths read a
	 * field and pay nothing. With it false the note is stock Obsidian: no pinch zoom, no wheel zoom,
	 * no zoom bar, no edge give; the scroller does what it does in any other note.
	 */
	private canvasMode = scrollExpansionEnabled;
	private offCanvasOverride: (() => void) | null = null;
	/** The pending quiet-time check for a live wheel zoom run; 0 when none is armed. */
	private wheelZoomTimer = 0;
	private hostPositionPatched = false;
	/** The element chromeHost() made positioned, so teardown can undo it. */
	private chromeHostPatched: HTMLElement | null = null;

	// ---- surface extent (reconstructed from the 2026-08-20 hardware build) --
	/** 1×1 invisible child of the scroller that extends its scroll range. */
	private spacer: HTMLElement | null = null;
	private spacerLeft = Number.NaN;
	private spacerTop = Number.NaN;
	/**
	 * Scroll room held left of the column for ink left of the origin, layout px
	 * (`leftReserve`). The pan carrier is shifted right by it with `translate`,
	 * which moves no layout, and the scroller is scrolled right by the same
	 * amount in the same pass, so nothing on screen moves and the ink is reached
	 * by scrolling left. 0 when none is held.
	 */
	private leftReserveHeld = 0;
	private axisGuard = new ScrollAxisGuard();
	/** The ink frontier per note, so a scroll repaint stops re-walking it. §5g/G1. */
	private frontierCache = new FrontierCache();
	/**
	 * THE INK'S OWN REACH on x, note px, cached for the settle's width tests to read as a field.
	 * Written where the extent pass already holds it; the events that move it - a stroke committed, an
	 * erase, a note loaded - are the same ones that run that pass, so the worst case is one pass old.
	 * Not read through `inlineInk.strokes()` per call: that is O(1) normally but FILTERS the stroke
	 * list while a note reloads (InlineInkStore.ts:414-420), a walk that scales with note length.
	 */
	private pageInkX = 0;
	/** Unsubscribes the frontier cache from ink-changed events. */
	private offInkChanged: (() => void) | null = null;
	/** What updateExtent last acted on; equal inputs mean equal output. */
	private lastExtentInputs: ExtentInputs | null = null;
	/** The ink frontier's x the last extent pass saw per note, to notice ink leaving. */
	private extentFrontierSeen = new Map<string, number>();
	/** The generation of each note's due shrink this editor has already taken a step on. */
	private shrinkStepped = new Map<string, number>();
	/** Takes a held shrink's next step once a scroll has gone quiet (SHRINK_SCROLL_IDLE_MS). */
	private shrinkIdleTimer: number | null = null;
	/** Each note's x-grant shrink count at this editor's last extent pass, so the band hears of a shrink made anywhere. */
	private shrinksSeen = new Map<string, number>();
	/** What this editor showed sideways at its last extent pass: a shrink made in any editor keeps it on screen. */
	private sidewaysView: { path: string; scrollLeft: number; clientWidth: number; originLeft: number; fontZoom: number } | null = null;
	/** The scroller's width measured without the band, for the next band sync only. */
	private bandFreeScrollWidth: number | null = null;
	/** The note's content height (view.contentHeight) at the last unlocked band sync: a drop is what asks for a band-free height read. */
	private bandContentHeight: number | null = null;
	/** Set by a scale commit: the next extent pass releases the band's margin, whether or not a grant shrank. */
	private bandMarginReleasePending = false;
	private scrollExpansion: ScrollExpansionDemand | null = null;
	/** The `.markdown-source-view` ancestor carrying the `handwriting-page` class. */
	private pageClassHost: HTMLElement | null = null;
	/** Keeps the page-id-only Properties block class in step with Obsidian's DOM. */
	private metadataObserver: MutationObserver | null = null;
	/** The one frame that observer owes, or null when it owes none. §5g/G2. */
	private metadataFrame: number | null = null;
	/** Live magnification of this editor. Session-local; never persisted. */
	private pinchScaleNow = 1;
	/**
	 * Lowest scale pinch, the zoom buttons and commitCameraScale may reach:
	 * MIN_PINCH_SCALE. Only Fit commits below it. Below it zoom-out is locked
	 * (Alan 2026-09-14): a pinch, a button or a commit may zoom in from the
	 * current scale but not back out, until a committed scale reaches the floor.
	 */
	private zoomFloor = MIN_PINCH_SCALE;
	/** The scale this gesture started from, so a pinch never accumulates. */
	private pinchRefScale: number | null = null;
	/** The pinch this frame owes, coalesced from however many moves arrived. */
	private pinchPending: { next: number } | null = null;
	/** When the pinch last wrote the scroll itself; see the scroll handler. */
	private pinchScrollAt = 0;
	/** Live transform owns the existing raster until the final layout transaction. */
	private pinchPreview = false;
	/** CodeMirror measures held back for the preview lifetime; null when CodeMirror schedules its own. */
	private measureHold: MeasureHold | null = null;
	/** True while CodeMirror is delivering an update to this plugin; see `update`. */
	private inUpdate = false;
	/** A resize the update hook met under a live hold, deferred whole to a frame; see `resizeOutOfUpdate`. */
	private resizeOutOfUpdateRaf = 0;
	/** The router's ratio at which `rebasePinch` re-anchored; its later ratios divide by it. */
	private pinchRatioBase = 1;
	/**
	 * THE LIFT PAST THE CAP. A live pinch may paint past MAX_PINCH_SCALE (and under
	 * MIN_PINCH_SCALE) by PINCH_GIVE, preview only; at the lift the preview is driven back to the cap
	 * over OVERSCROLL_BOUNCE_MS on the bounce's own curve and only then settles, once, inside the
	 * committed range. `stepping` marks the ease's own frames, which enter `pinch` as moves.
	 */
	private pinchGive: { from: number; to: number; startedAt: number; raf: number; centroid: { x: number; y: number }; stepping: boolean; scrollLeft: number; scrollTop: number; paused: boolean } | null = null;
	/** The router's last raw move ratio, for `rebasePinch`. */
	private pinchLastRatio = 1;
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
		/** Screen px, so the anchoring below never re-derives them from a rect. */
		focalX: number;
		focalY: number;
		/** Accepted screen target; the captured note reference above never changes. */
		targetX?: number;
		targetY?: number;
		/** Rejected screen-space motion; never changes the captured content point. */
		constraint?: PinchConstraint;
		/**
		 * The host's painted origin at gesture start, WITH whatever pan was in
		 * force then folded in - so the reference frame is the one the reader
		 * was actually looking at, not the unpanned one underneath it.
		 */
		hostLeft: number;
		hostTop: number;
		/** The column in host-local px at gesture start; null when unmeasurable. */
		columnLocal: number | null;
		/** The content's top in host-local px at gesture start; see anchorPanTo. */
		contentTopLocal: number | null;
		/** The scale the gesture started from, carried so the settle can reuse it. */
		fromScale: number;
	} | null = null;
	/**
	 * How far the note's contents are translated, in PAINTED px, to hold the
	 * pinch focal point where the scroll cannot reach.
	 *
	 * Zooming out from the top of a note needs the content moved RIGHT and DOWN
	 * to keep what is under the fingers under the fingers, and `scrollLeft` /
	 * `scrollTop` only go one way from zero. Measured on 547fd8b4: every arm of
	 * the focal-anchor probe reported `scrollLefts=[0]` - not clamped late, but
	 * never moved at all, because `anchoredScroll`'s target was negative on
	 * every frame and `Math.max(0, ...)` pinned it. A translate needs no scroll
	 * range, which is also why it cannot land the surface short the way a
	 * margin-based centring did (see the zoom-out-to-corner measurement).
	 *
	 * PAINTED px, because that is the frame the question is asked in: a finger
	 * is at a screen point. `writeViewportPan` divides by the painted scale on
	 * its way onto the elements, which live INSIDE the scaled host.
	 */
	private viewportPan = { x: 0, y: 0 };
	/**
	 * WHERE THE PAN STOOD WHEN THE GESTURE BEGAN, painted px. The give band may stop a frame
	 * carrying the page FURTHER out than its room, and it may never drag a page that was already resting
	 * outside that room back in - a zoom-button commit leaves the page on a legitimate position and the next
	 * touch must not spring. Captured with the anchor, read by the band, written nowhere else.
	 */
	private pinchStartPan = { x: 0, y: 0 };
	/**
	 * THE BAND WATCHES THE GESTURE FRAME BY FRAME. `history` holds the last PAN_DRAG_WINDOW preview
	 * scales (the scale has held when the newest is within PAN_DRAG_FRAME_EPS of the oldest), and `lastPan`
	 * the pan the last frame committed. A drag after a real zoom used to escape the band for the rest of the gesture (the gate
	 * compared against the gesture's START scale, and a pinch in the middle of the pane then a drag to
	 * the bottom right walked the page out as if Infinite Canvas were on - Alan, device, 2026-09-19). Now
	 * the band engages once the scale has held over the window, and it engages WITHOUT A JUMP: it never
	 * pulls the page back in, it only refuses further outward travel, so a page a zoom left past its room
	 * stops where it stands and the lift's ease brings it home.
	 */
	private pinchBand = { history: [] as number[], lastPan: { x: 0, y: 0 } };
	/** The overscroll bounce's visual offset on top of `viewportPan`, painted px; zero whenever no bounce is playing. */
	private bounceOffset = { x: 0, y: 0 };
	/**
	 * ONE SETTLE OWES AN EASE, and it is the pinch's own. Measured at f7e76419: THREE settling
	 * `anchorPanTo` calls follow every lift - `commitCameraScale` <- `applyPinchScale`, then
	 * `applyPinchScale` alone, then `Object.write` <- `EditorView.measure` - and only the first arrives
	 * with the preview's own pan. The other two saw `pan` already at `cx` and re-ran the same ease from
	 * a position the page had already left.
	 */
	private previewSettleOwed = false;
	/** Where the page was painted inside its pane on the last preview frame, for the settle's ease to measure against. */
	private previewPaintedBlank: { x: number; y: number } | null = null;
	/** The bounce playing now: the settle that started it, where it started, its frame request. */
	private bounceState: { hold: object; fromX: number; fromY: number; startedAt: number; raf: number } | null = null;
	/** The settle that has had its bounce, playing or over, until that settle retires: one bounce per settle. */
	private bouncedHold: object | null = null;
	/**
	 * The last settle's bound geometry, for `overscrollBounceReadout`. Written at the bound, read
	 * by production at :7688-7689, :7834-7835, :7866. A field initializer, so `Object.create(InkOverlayPlugin.prototype)` skips it - a
	 * fixture built that way must set it itself or any path that reads it throws on the missing keys.
	 */
	private boundReadout = { floorX: 0, floorY: 0, bx: 0, width: 0, rawX: 0, cx: 0, rawY: 0, cy: 0,
		// Read-only: the drag-frame gate's own inputs, so a fixture can say WHY a frame was or
		// was not bounded rather than infer it from the position it ended on.
		dragFrame: false, neverZoomed: false, steady: false, next: 0, fromScale: 0, fromScaleValid: false,
		restCeilX: 0, startX: 0, startY: 0, lastX: 0, lastY: 0, bounded: false, settling: false };
	/** Pan already drawn into the raster, in host-layout pixels. */
	private rasterPan = { x: 0, y: 0 };
	private cameraOriginY: CameraOriginY | null = null;
	/**
	 * The camera origin in LAYOUT px as the last accepted sync left it, which
	 * is the only input to picking a rung. Not a basis term and deliberately
	 * not one: the identity `cameraY_layout = k x spacing + residual/cssScale`
	 * gives the same camera for every k, so a different rung reseeds nothing
	 * and causes no redraw. NaN until the first sync, which falls back to the
	 * scroll offset - the same quantity to within a viewport.
	 */
	private anchorCameraYLayout = Number.NaN;

	/** Set by `canonicalCameraY` when it adopted a raw that differs from
	 * the retained origin - a basis reset, or a departure beyond the cap. Read
	 * and cleared by `syncCamera`, the only caller allowed to pay for the gate's
	 * rect read; the read-only twin never does. */
	private anchorAdoptionEvent = false;

	/** The parity gate has not run yet for the ladder now mounted, so the mount
	 * itself is gated as well as every later adoption. */
	private anchorGateDue = true;
	private readonly rasterInputPan = { x: 0, y: 0 };
	private committedBlank = false;
	private highlightBlank = false;
	private readonly pinchHiddenCanvases = new Map<HTMLCanvasElement,string>();
	private pinchComposite = false;
	/**
	 * Did the pan path actually measure and hold this gesture?
	 *
	 * A pan of zero is ambiguous on its own - it is both "nothing needed
	 * moving" and "there was nothing to measure". The settle spends the pan into
	 * the scroll, which is only the right target in the first case; in the
	 * second the old absolute anchor is still the best available answer. The
	 * unit fixtures drive the gesture with no DOM to measure, and are exactly
	 * that second case.
	 */
	private previewPanEngaged = false;
	/**
	 * The host's painted origin as of the last `columnLocalAt`, and whether that
	 * read happened at all. Mutated rather than replaced: this is written once
	 * per preview frame and a fresh object per frame is an allocation on the one
	 * path `deferPinchRaster` exists to keep free of them.
	 */
	private previewHostOrigin = { left: 0, top: 0, valid: false };
	/**
	 * The note origin the paper's phase is planned from, in the gradient's layout
	 * px, as updateExtent last computed it (null before the first).
	 */
	private paperOriginLayout: number | null = null;
	/** The text column's left edge the paper's vertical rules and dots are planned from, in the gradient's layout px. */
	private paperOriginLeft: number | null = null;
	/** The editor text's font size the paper was last planned at, as the refresh path or the camera sync read it. */
	private paperFontPx = Number.NaN;
	/** The zoom at rest right after a release (the external scale alone), until the refresh path measures one. */
	private paperRestZoom = Number.NaN;
	/** The paper values the overlay itself last wrote, so a takeover can tell its own plan from the host's. */
	private paperWritten = new Map<string, string>();
	/** The column in host-local px as of the last preview frame's one read. */
	private previewColumnLocal: number | null = null;
	/** `.cm-sizer`, cached: `writeViewportPan` runs once per preview frame. */
	private panSizerEl: HTMLElement | null = null;
	/**
	 * Armed for the duration of ONE settle transaction, so the several scroll
	 * writes inside `commitCameraScale` each re-derive the pan they need rather
	 * than leaving the note wherever the browser's clamp put it.
	 */
	private panAnchorHold: {
		focalX: number; focalY: number; targetX?: number; targetY?: number; hostLeft: number; hostTop: number;
		columnLocal: number | null; contentTopLocal: number | null; fromScale: number; scrollTop: number; toScale: number; generation: number; path: string | null; container: HTMLElement | null;
		expansion?: { left: number; top: number } | null;
		left: number; top: number; ready: boolean; outcome: "pending" | "converged" | "cancelled" | "failed"; attempts: number; request: unknown; issuance: readonly unknown[];
	} | null = null;
	private pinchRaf = 0;
	/** The scale the ink raster currently reflects, so a settle that would
	 * change nothing does not reallocate every canvas. */
	private pinchRasterScale = 1;
	/** Host-local px the preview raster is currently translated by. See applyPreviewInkOffset. */
	private previewInkOffset = 0;
	/**
	 * Host-local px the preview raster is moved DOWN by because a block above
	 * the content changed height during the gesture (a title that rewraps as the
	 * pinch narrows the host). See observeAboveContent.
	 */
	private previewInkOffsetY = 0;
	/** Watches the blocks above `.cm-contentContainer` in the sizer; see observeAboveContent. */
	private aboveContentObserver: ResizeObserver | null = null;
	/** Last delivered border-box height per watched block, host-local px. */
	private aboveContentHeights = new WeakMap<Element, number>();
	/** Height changes applied to a preview raster, counted: one per rewrap, never one per frame. */
	private aboveContentShifts = 0;
	/**
	 * Where the column was, in HOST-LOCAL px, when the committed raster was
	 * last drawn. Null when there is nothing measured to compare against.
	 */
	private rasterColumnLocal: number | null = null;
	/**
	 * The scroller's scrollLeft at the moment `rasterColumnLocal` was latched.
	 * `columnLocalAt` is host-local and therefore moves with the scroll; the
	 * ink layer rides inside the scroller and moves with it too, so a scroll
	 * change since the latch must NOT enter the preview offset a second time.
	 */
	private rasterColumnScroll = 0;
	/** A repaint redrew the raster mid-gesture; re-latch before the next box move. */
	private previewAnchorStale = false;
	private repaintDeferredByPinch = false;
	private pinchDeferTimer = 0;
	/**
	 * The layer holding the canvases, inside the band.
	 *
	 * The preview offset is written HERE and not on the band, and that is
	 * load-bearing: `syncCamera` derives the camera from
	 * `this.container.getBoundingClientRect()`, so translating the band moves
	 * the very box the camera is measured from - the camera absorbs the offset
	 * and the transform then applies it a second time. Measured while the band
	 * carried it: a pinch paused past PINCH_SCROLL_QUIET_MS came back 256.4px
	 * out at k 0.30 and stayed out for the rest of the gesture. The layer fills
	 * the band and nothing measures it.
	 */
	private inkLayer: HTMLElement | null = null;
	/** The ink band's box in scroller-content coordinates; see ScrollBand. */
	private band: Band | null = null;
	/** The band's widening for the ease playing now, fixed at its first sync (syncBand). */
	private bandEase: { bounce: object; px: number } | null = null;
	private bandSyncDeferred = false;
	/** A pane resize arrived while a stroke held the zoomed layout; see handleResize. */
	private resizeDeferred = false;
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
 /** Camera commits in progress, plus a settle measure's write while it re-anchors; commitCameraScale carries a pending settle only at depth 1. */
 private commitDepth = 0;
 private viewportStyleDirty: {path:string|null;container:HTMLElement|null} | null = null;
 private viewportLayout: {parent:HTMLElement; paneWidth:number; paneHeight:number; externalScale:number; gutterScreen:number; baseTransform:string; baseZoom:number; zoomVerified?:boolean; width:number; height:number; column:number; columnBox:number; gutterX:number; sizerColumn:boolean; columnInset:boolean; ownLines:boolean; left:string; right:string; columnLocal:number|null; columnReserve:number; columnAuto:{lineWidth:number;fixed:number;scrollbar:number}|null; styles:Map<string,{value:string;priority:string}>} | null = null;
 /** `CSS.supports("zoom", "0.5")`, asked once per overlay. See `hostZoomSupported`. */
 private hostZoomSupport: boolean | null = null;
 private translateSupport: boolean | null = null;
 /** Whether the page places a canvas with CSS translate (the wet tile moves by it). Asked once per overlay. */
 private translateSupported():boolean {
  if(typeof this.translateSupport!=="boolean") {
   const css=(this.winRef as unknown as {CSS?:{supports?:(property:string,value:string)=>boolean}}|undefined)?.CSS;
   this.translateSupport=css?.supports?.("translate","1px 1px")===true;
  }
  return this.translateSupport;
 }
 /**
  * The reallocation's own check that the backing it just allocated matches
  * the device pixels the container actually occupies. Null when they agree
  * within a pixel; the pair when they do not. Read by the suites; nothing in
  * production branches on it and nothing is logged.
  */
 backingBoxMismatch: {backingW:number; rectBackingW:number} | null = null;

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
	/** The TFile behind `lastPath`. Obsidian renames a file by mutating its path in place, so the same object
	 * under a new path is a rename, not a note switch. */
	private lastFile: unknown = null;
	private currentFile(): unknown {
		return this.view?.state?.field(editorInfoField, false)?.file ?? null;
	}
	private reloadBindingEpoch = 0;
	private reloadCameraSettlement: number | null = null;
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

	/**
	 * Table-cell editors inherit the note owner, but never own its ink surface.
	 * Neither do embedded editors (hover and footnote popovers, Canvas file
	 * cards, editable embeds): their owner names the whole note while their
	 * document can hold one section, so y = 0 is the section's first line and
	 * ink would be saved and erased against the wrong origin (audit #13).
	 */
	private ownsMarkdownEditorRoot(): boolean {
		const dom = this.view.dom;
		const root = dom.closest(".markdown-source-view");
		// Read live DOM in this view's document, including while detached. The
		// host removes a cell editor's own source-view class before initializing
		// it; after attachment, the parent's source view must not qualify it.
		return root !== null && root.ownerDocument === dom.ownerDocument
			&& (root === dom || root.querySelector(".cm-editor") === dom)
			&& !dom.parentElement?.closest(".cm-editor")
			&& !dom.closest(".table-cell-wrapper, .cm-table-widget")
			&& !dom.closest(".markdown-embed, .hover-popover");
	}

	mount(): void {
		if (this.container || !enabled) return;
		this.retiring = false;
		// Not a file-backed markdown editor (e.g. a bare CM instance): stay inert.
		// An owner with no file (a Canvas text card) has nowhere to save ink:
		// claiming the pen there dropped every stroke at lift (audit #13).
		const info = this.view.state.field(editorInfoField, false);
		if (info === undefined || !info.file) return;
		if (!this.ownsMarkdownEditorRoot()) return;
		this.invalidateReloadBindings(this.lastPath, this.filePath());
		this.reloadCameraSettlement = null;

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
		this.inkLayer = layer;
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
		this.wetTileCanvas = canvas();
		this.tailCanvas = canvas();
		this.tailWashed = false;

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
		// No backing for the highlight pair until the note needs it (see
		// highlightPairDeferred). A new canvas starts at 300x150.
		this.highlightPairDeferred = true;
		for (const c of [this.highlightCanvas, this.highlightWetCanvas]) {
			c.width = 0;
			c.height = 0;
		}
		this.highlightWet.noteBackingCleared();
		this.highlightBlank = true;
		// The wet canvas is sized by the resize path as ever; a scroll releases it (wetDeferred).
		this.wetDeferred = false;
		this.wetReleaseOff = (this.winRef as unknown as { HW_ARM_W_OFF?: unknown } | undefined)?.HW_ARM_W_OFF === true;
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

		// The reticle belongs to the pointer's client frame, outside the editor's
		// pinch transform and scrolling raster band. Use this window's document.
		this.penCursorEl = container.ownerDocument.body.createDiv({ cls: "handwriting-pen-cursor" });
		this.penCursorEl.setCssStyles({ position: "fixed", left: "0", top: "0", zIndex: "10000", display: "block", opacity: "0" });
		this.penCursorPinned = true;
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
				// Every contact (pen, finger or mouse) lands here first, a pen-down included: a preview paper riding a bounce comes down.
				// A give still easing back to the cap is NOT finished here - a two-finger contact takes the
				// zoom over from the scale on screen (pinch "start"), which is what keeps the page from jumping.
				onViewportInput: () => { if (!this.pinchPreview) this.endPreviewPaper("input"); this.cancelOverscrollBounce(); this.retirePanSettle("viewport input"); },
				onBeforePenDown: () => this.beforePenDown(),
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
				// THE GIVE BELONGS TO INFINITE CANVAS (Alan: the bounce shows you cannot
				// go further, and the lack of it shows the direction is infinite). With the canvas
				// off the note scrolls like any other Obsidian note and answers zero, which also
				// switches off the router's edge re-arm - both predicates read this number.
				// With it on, the page's OWN top and left are real ends and give; the far ends are
				// room, and the ceiling-only clamps below are what keep the give off them.
				overscrollAllowancePx: () =>
					this.canvasMode ? OVERSCROLL_GIVE_PX * (this.viewportLayout?.externalScale ?? 1) : 0,
				onOverscrollPull: (x, y) => this.holdOverscrollGive(x, y),
				onOverscrollRelease: () => this.releaseOverscrollGive(),
				onPenRaw: (samples, ev) => this.penRaw(samples, ev),
				onPenMove: (_ev, count) => metrics.recordEvent("move", count, 0, false),
				// The lift event is PASSED ON - see `penUp`'s own header. The
				// pan branch reads the pointer's position off it to put the
				// reticle back where the hand actually is.
				onPenUp: (ev) => this.penUp(ev),
				onAllContactsLifted: () => this.resumeStrandedPan(),
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
				// A two-finger gesture is only ours while the Infinite Canvas is on. With it off the
				// overlay already ignores every pinch phase, and this is what stops the router
				// claiming the contacts in the first place, so the host's own pinch is what the note gets.
				// PDF supplies no callback and keeps the router's existing behaviour.
				pinchZoom: () => this.canvasMode,
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
			() => this.cssScale,
			"none",
			// The pen's client point is in the frame the ink is painted in.
			// Subtract only the pan still carried by the layer's transform.
			// Settled pan is already represented by the raster camera.
			() => {
				this.rasterInputPan.x = this.inkInputPanX(); this.rasterInputPan.y = this.inkInputPanY();
				return this.rasterInputPan;
			}
		);

		this.router.setCanvasMomentumDisabled(this.canvasMode);
		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(host);
		this.contentResizeObserver = new ResizeObserver(() => this.onContentResize());
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
				visualToNote(clientX - rect.left - this.inkInputPanX(), this.cssScale),
				visualToNote(clientY - rect.top - this.inkInputPanY(), this.cssScale)
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
		}, this.view.dom);

		this.scrollFn = () => {
			this.clearSnapPreview();
			const during = this.router?.isStroking ?? false;
			if (during) this.scrollsDuringStroke++;
			this.releaseWetIfIdle();
			// Nothing here moves the ink any more. The layer is a child of
			// the scroller in content coordinates, so this scroll has already
			// moved it, on the compositor, together with the text. All that
			// is left is to notice when the viewport has eaten far enough
			// into the band's margin to need a wider one drawn - which
			// repaint() decides, through syncBand.
			const scroller = this.view.scrollDOM;
			const scrollLeft = scroller.scrollLeft;
			const scrollTop = scroller.scrollTop;
			// The preview paper is outside the scroller: a scroll while it is up moves the text, so it takes the scroll too.
			if (this.previewPaperEl && (scrollLeft !== this.paperScrollLeft || scrollTop !== this.paperScrollTop)) {
				this.paperScrollLeft = scrollLeft; this.paperScrollTop = scrollTop; this.writePaperPan();
			}
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
			// Only producer readbacks may compensate a settle. An unmatched
			// scroll belongs to navigation, including programmatic scrolling.
			const hold = this.panAnchorHold;
			if (hold && (scrollLeft !== hold.left || scrollTop !== hold.top)) this.retirePanSettle("a scroll off the settle target");
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
			const path = this.filePath();
			if (path) this.scrollExpansion?.sample(path, this.canvasMode, scrollLeft, scrollTop);
			if (path && surfaceExtents.owesShrinkX(path)) this.shrinkWhenScrollIsQuiet();
			this.scheduleRepaint("scroll");
		};
		this.view.scrollDOM.addEventListener("scroll", this.scrollFn, { passive: true });
		// Log-only wheel tap on the ACTUAL trigger path of the touchpad dead
		// zone: two-finger precision-touchpad scrolling arrives here, not as
		// touch pointers. Passive + capture: sees everything, changes nothing.
		// Wholly diagnostic, so the whole body is behind the switch (RC4).
		this.wheelFn = (e: WheelEvent) => {
			if (!this.pinchPreview) this.endPreviewPaper("input");
			// Alan: "a scroll should perform the elastic bounce/settle". A WHEEL OR TOUCHPAD
			// SCROLL NO LONGER KILLS AN EASE THAT IS ALREADY PLAYING. This called cancelOverscrollBounce(),
			// which puts the offset on 0 in ONE frame. Measured mid-ease with 153.8 px still owed, the frame
			// series after a wheel was [153.8, 0, 0, ...]: the whole correction closed as a single step, so the
			// page arrived by a jump and the ease the contract promises stopped happening. With the call gone
			// the same drive reads [0, 32.4, 14.4, 13.1, 12.1, 20.9, 9, 8.1, ...] decaying to zero.
			// The ease is a transform on the page and a wheel moves the scroller: they do not contend.
			// PEN DOWN STILL CANCELS: that path is onViewportInput (:2225), untouched, pinned by
			// OverscrollBounce.test.ts "PEN DOWN MID-BOUNCE" - a contact must be read against the page where it
			// rests, which is not the same question as a scroll passing over a playing ease.
			// NOTHING IS OWED AT THE END OF A SCROLL RUN ITSELF: scrollFn (:2359) never writes viewportPan and
			// the native scroller clamps scrollLeft/scrollTop at zero, so no wheel, touchpad or one-finger touch
			// scroll can leave the canvas's left or top edge inside the pane (read on the device, 1.4.20).
			this.retirePanSettle("wheel");
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
		// THE SECOND WHEEL LISTENER, AND THE ONLY NON-PASSIVE ONE. The
		// diagnostic tap above cannot take this job: it is registered passive,
		// so it may not `preventDefault`, and Obsidian's quick font size is
		// exactly what has to be prevented. Registered after it so the probe
		// still records every wheel event, including the ones zoomed here.
		this.ctrlWheelFn = (e: WheelEvent) => this.wheelZoom(e);
		this.view.scrollDOM.addEventListener("wheel", this.ctrlWheelFn, {
			capture: true,
			passive: false,
		});
		this.watchResolution();
		// Every committed mutation that reaches an event drops the cached
		// frontier for that note; the two that do not (erase, lasso move)
		// invalidate by hand at their gesture end. §5g/G1.
		// ...and the empty-page refusal it has already made about that note is
		// spent: ink arriving (or the last of it leaving) is exactly the event
		// that makes the sentence worth saying again. Same subscription, so
		// the two cannot drift apart over which notes they heard about.
		// This note's own canvas answer, and a re-apply whenever its frontmatter choice moves.
		this.canvasMode = canvasForNote(this.filePath(), scrollExpansionEnabled);
		this.router?.setCanvasMomentumDisabled(this.canvasMode);
		this.offCanvasOverride = onCanvasOverrideChanged((p) => { if (p === this.filePath()) this.applyCanvasMode(); });
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
			this.pruneSelectionOnInkChange(p);
		});
		this.lastPath = this.filePath();
		this.lastFile = this.currentFile();
		this.updateHandwritingPageClass();
		this.loadInk(this.lastPath);
	}

	/** Reconcile another pane's selection at the ink-change boundary, not on drag frames. */
	private pruneSelectionOnInkChange(path: string): void {
		if (path !== this.filePath() || this.selection.isEmpty) return;
		// A live gesture in the other pane leaves this lasso alone until its
		// gesture-end notification; only then is the shared stroke list final.
		const before = this.selection.size;
		this.selection.prune(
			new Set(inlineInk.strokes(path).map((stroke) => stroke.id)),
			new Set(this.selection.boxIds),
			new Set(this.selection.imageIds)
		);
		if (this.selection.size === before) return;
		this.redrawSelectionUI();
		this.refreshStrip();
	}

	/**
	 * ONE CTRL+WHEEL EVENT, DRIVEN THROUGH THE PINCH PATH.
	 *
	 * A precision touchpad's pinch arrives here on Windows - Chromium reports
	 * it as a wheel with `ctrlKey`, the same shape a mouse's ctrl+wheel has -
	 * and Obsidian's quick font size is the handler that used to consume it.
	 * Every frame goes through `pinch`, so the floor, the 400% cap and its
	 * give, the focal hold about the cursor, the constraint reducer and the
	 * single settle at the end are the same ones two fingers on glass get.
	 * Nothing about the zoom is decided here; only whether this event is ours.
	 * Ours means Infinite Canvas is on. See the gate below.
	 */
	private wheelZoom(e: WheelEvent): void {
		// Alan: THE MODE IS THE GATE, not a setting of its own.
		// With Infinite Canvas off this listener does nothing at all - the event
		// is not prevented and Obsidian's quick font size nudge works as it does
		// today. Canvas on is the mode where a note is a surface you move around
		// in, which is the mode where zooming it about the cursor is the answer.
		if (!this.canvasMode) return;
		// metaKey for a mac trackpad, where Electron reports a pinch the same
		// way but the modifier a user holds for a deliberate wheel zoom is cmd.
		if (!e.ctrlKey && !e.metaKey) return;
		if (this.retiring) return;
		// Never zoom out from under a stroke in flight. The router's own wheel
		// path makes the same refusal (PointerRouter :657).
		if (this.router?.isStroking) return;
		// Ask readiness before taking the event. `pinch` refuses a start
		// while the note is busy, so an event prevented here would be eaten with
		// no zoom and the host's font nudge blocked. A run already under way
		// stays ours, so a gesture is never handed back half way.
		if (!this.wheelZoomRun.isLive && this.getNoteViewportState().busy) return;
		// Both, and in this order: `preventDefault` is what stops Obsidian's
		// font zoom and the browser's own page zoom, `stopPropagation` keeps
		// the event from any handler deeper in the tree. Neither is possible
		// from a passive listener, which is why this one is not passive.
		e.preventDefault();
		e.stopPropagation();
		for (const step of this.wheelZoomRun.feed({
			deltaY: e.deltaY,
			deltaMode: e.deltaMode,
			x: e.clientX,
			y: e.clientY,
			t: performance.now(),
		})) {
			this.pinch(step.phase, step.ratio, step.centroid);
		}
		this.armWheelZoomQuiet();
	}

	/**
	 * A wheel run has no lift, so the end is a quiet time. One timer at a time:
	 * each event re-asks, and a timer that fires while the run is still live
	 * (an event landed after it was armed) re-arms rather than ending early.
	 */
	private armWheelZoomQuiet(): void {
		if (this.wheelZoomTimer !== 0) return;
		this.wheelZoomTimer = this.winRef.setTimeout(() => {
			this.wheelZoomTimer = 0;
			const end = this.wheelZoomRun.endIfQuiet(performance.now());
			if (end) {
				this.pinch(end.phase, end.ratio, end.centroid);
				return;
			}
			if (this.wheelZoomRun.isLive) this.armWheelZoomQuiet();
		}, WHEEL_ZOOM_QUIET_MS);
	}

	/** The router is about to hand this overlay a pen contact: the page stops moving under it first. */
	private beforePenDown(): void {
		// A ctrl+wheel or touchpad zoom has no lift; its run ends on a quiet timer. The pen ends it now,
		// as the router ends a finger pinch, or the timer ends it later under the stroke and the page
		// jumps mid-stroke. First, so a give the end starts is paused by the line below.
		this.endWheelZoomRun();
		// Alan, "fix it": a pen landing on a zoom still easing PAUSES the ease where it stands - nothing
		// moves under the pen, the stroke is mapped through the live preview - and pen-up resumes it to the cap.
		if (this.pinchGive) this.pausePinchGive();
		// No sample is mapped through a bounce: the page goes to its rest before the contact is read.
		this.cancelOverscrollBounce();
		this.restorePinchLayers();
		if (this.rasterPanNeedsBake()) this.repaint();
	}

	/**
	 * Infinite Canvas went off with a run in flight. End it where it stands:
	 * the preview is up, and nothing else will ever come to take it down.
	 */
	endWheelZoomRun(): void {
		if (!this.wheelZoomRun.isLive) return;
		const centroid = this.wheelZoomRun.centroid;
		this.wheelZoomRun.cancel();
		if (this.wheelZoomTimer !== 0) {
			this.winRef.clearTimeout(this.wheelZoomTimer);
			this.wheelZoomTimer = 0;
		}
		this.pinch("end", 1, centroid);
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
		this.adoptStoredFontRef(path);
		runDetached(
			inlineInk.ensureLoaded(path).then((changed) => {
				// A read that finishes after unmount must not revive the page-class
				// observer on a torn-down editor (audit 110).
				if (this.filePath() === path && !this.retiring && this.container) {
					this.adoptStoredFontRef(path);
					this.mobileTools?.refresh();
					this.noteZoomControls?.refresh();
					this.updateHandwritingPageClass();
					if (changed) this.scheduleRepaint();
				}
			}),
			`load inline ink for ${path}`
		);
	}

	/**
	 * Read the open note's ink in the frame of the font size stored with it
	 * (audit 46). Every stored coordinate is expressed against a reference
	 * size, and the reference used to be whatever the editor measured first,
	 * so a note reopened at another size, or opened second in the same
	 * editor, read its ink in the wrong frame. Runs when a note opens (mount
	 * and note switch both come through loadInk) and again once its sidecar
	 * has loaded, since the stored value often arrives after the first
	 * measurement. A stored reference that differs from the latch replaces
	 * it and the scale is re-measured. With none stored the latch is cleared,
	 * never carried over from the note open before: the re-measure latches
	 * this note's own size, and the store takes it once to ride its next save.
	 */
	private adoptStoredFontRef(path: string): void {
		const stored = inlineInk.fontRefPx(path);
		if (stored !== null && stored === this.refFontPx) return;
		this.refFontPx = stored ?? 0;
		// syncCamera recomputes fontZoom only on a font change it has not seen.
		this.lastSyncFontStr = "";
		if (this.container) this.handleResize();
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
				// The Properties container moves to the reading view beside this
				// editor; keep observing both without moving the page class.
				this.metadataObserver.observe(this.pageClassHost.closest(".view-content") ?? this.pageClassHost, {
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
		// Note zoom belongs to the editor, even when the pen strip is hidden.
		this.noteZoomControls = ensureNoteZoomControls(this.noteZoomControls, this.container, () => this.chromeHost(), {
				noteViewport: {
					getNoteViewportState: () => this.getNoteViewportState(),
					zoomNoteBy: factor => this.zoomNoteBy(factor),
					resetNoteZoom: () => this.resetNoteZoom(),
					fitHandwriting: () => this.fitHandwriting(),
				},
				notePath: () => this.filePath(),
		});
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

	/** Drop the six ink canvases to 0x0, releasing their backing memory now. */
	private releaseBackings(): void {
		for (const c of [
			this.committedCanvas,
			this.wetCanvas,
			this.wetTileCanvas,
			this.tailCanvas,
			this.highlightCanvas,
			this.highlightWetCanvas,
		]) {
			if (!c) continue;
			c.width = 0;
			c.height = 0;
		}
	}

	unmount(): void {
		this.retiring = true;
		this.endPreviewPaper("unmount");
		this.cancelOverscrollBounce();
		this.retirePanSettle("unmount");
		this.invalidateReloadBindings(this.lastPath, this.filePath());
		this.reloadCameraSettlement = null;
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
		if (this.shrinkIdleTimer !== null) {
			this.winRef.clearTimeout(this.shrinkIdleTimer);
			this.shrinkIdleTimer = null;
		}
		if (this.wheelFn) {
			this.view.scrollDOM.removeEventListener("wheel", this.wheelFn, { capture: true });
			this.wheelFn = null;
		}
		if (this.ctrlWheelFn) {
			this.view.scrollDOM.removeEventListener("wheel", this.ctrlWheelFn, { capture: true });
			this.ctrlWheelFn = null;
		}
		if (this.wheelZoomTimer !== 0) {
			this.winRef.clearTimeout(this.wheelZoomTimer);
			this.wheelZoomTimer = 0;
		}
		// No end step on the way out: the overlay is going, and `pinch` refuses
		// once `retiring` is set anyway.
		this.wheelZoomRun.cancel();
		this.unwatchResolution();
		this.offInkChanged?.();
		this.offInkChanged = null;
		this.offCanvasOverride?.();
		this.offCanvasOverride = null;
		this.lastExtentInputs = null;
		this.cameraOriginY = null;
		setHitProbeContext(null, this.view.dom);
		this.spacer?.remove();
		this.spacer = null;
		this.spacerLeft = Number.NaN;
		this.spacerTop = Number.NaN;
		this.dropLeftReserve();
		this.removeGridPaperBox();
		this.stopPaperKindWatch();
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
		this.restorePinchLayers();
		// Zero the backings before the container goes. Detached canvases hold
		// their full-size memory until collection, and a same-tab note switch
		// rebuilds the overlay, so a quick run of switches on an iPad stacked
		// five full-size backings per note behind the collector.
		if (this.container) this.releaseBackings();
		this.container?.remove();
		this.container = null;
		this.inkLayer = null;
		this.band = null;
		// A give easing past teardown would drive pinch frames against a dead overlay.
		if (this.pinchGive) { if (this.pinchGive.raf !== 0) this.winRef.cancelAnimationFrame(this.pinchGive.raf); this.pinchGive = null; }
		// A pinch frame outliving the overlay would touch a torn-down editor.
		if (this.pinchRaf !== 0) {
			this.winRef.cancelAnimationFrame(this.pinchRaf);
			this.pinchRaf = 0;
		}
		if (this.resizeOutOfUpdateRaf) { this.winRef.cancelAnimationFrame(this.resizeOutOfUpdateRaf); this.resizeOutOfUpdateRaf = 0; }
		// A preview torn down mid-gesture gives CodeMirror its measuring back;
		// the make-up measure waits a frame, since this can run inside
		// CodeMirror's own update.
		this.releaseMeasures(true);
		// OUTSIDE that guard: a teardown can find a deferred-repaint timer
		// armed with no pinch rAF in flight, and the timer would then be
		// left running. Inert today - the callback bails on a missing
		// container - but the contract is that the latch and the timer are
		// cleared together, and relying on a bail in the other file is how
		// that contract quietly stops holding.
		this.clearDeferredRepaint();
		// Same shape, and pre-existing: the insert-space feedback frame was
		// only ever cancelled by clearSpaceFeedback, never at teardown, so a
		// detach mid-hover left it queued against a dead overlay
		// (release-1.4.19, ec802917).
		if (this.spaceFeedbackRaf != null) {
			this.winRef.cancelAnimationFrame(this.spaceFeedbackRaf);
			this.spaceFeedbackRaf = null;
		}
		this.pinchPending = null;
		// Hand the editor back the way it was found. The transform, the
		// counter-sized box and the origin all live on view.dom, which
		// OUTLIVES this overlay: unmounting while zoomed used to leave the
		// editor painted at scale in a fraction-width box, with the only
		// code that could undo it now unloaded.
		this.restoreViewportLayout();
		// The camera anchor lives in the editor's own DOM, beside the content,
		// and the editor OUTLIVES this overlay: a plugin disable or reload
		// would otherwise leave the wrapper and its rungs in the note, and the
		// next load would add another beside it.
		unmountDocumentAnchor(this.view);
		this.pinchScaleNow = 1;
		this.zoomFloor = MIN_PINCH_SCALE;
		this.pinchRasterScale = 1;
		this.rasterColumnLocal = null;
		this.previewAnchorStale = false;
		this.pinchRefScale = null;
		this.pinchAnchor = null;
		this.pinchScrollAt = 0;
		this.builder = null;
		if (this.penCursorPinned) this.penCursorEl?.remove();
		this.penCursorEl = null;
		this.penCursorPinned = false;
		this.penCursorShown = false;
		this.penCursorClient = null;
		this.eraserEl = null;
		this.mobileTools?.destroy();
		this.mobileTools = null;
		this.noteZoomControls = destroyNoteZoomControls(this.noteZoomControls);
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
		// EVERY ROUTE OUT OF HERE IS INSIDE CODEMIRROR'S UPDATE. The routes
		// that can release the measure hold are handled by name (the file
		// switch's reset defers its measure; a font-size reflow's resize is
		// deferred whole, `resizeOutOfUpdate`). The flag is the net for a
		// route nobody named: a release under it defers its measure and says so.
		this.inUpdate = true;
		try { this.updateInner(u); } finally { this.inUpdate = false; }
	}

	private updateInner(u: ViewUpdate): void {
		// Attachment/reparenting can change ownership without changing the file.
		// Retire a surface that lost its root; a later valid update can remount it.
		if (!this.ownsMarkdownEditorRoot()) {
			if (this.container) this.unmount();
			return;
		}
		const hold = this.panAnchorHold;
		if (hold && u.transactions.some(tr => tr.docChanged || tr.selection || tr.scrollIntoView || tr.effects.some(effect => !hold.issuance.includes(effect)))) this.retirePanSettle("a transaction the settle did not issue");
		if(u.docChanged)this.clearSpaceFeedback();
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
		const file = this.currentFile();
		if (path === this.lastPath) this.lastFile = file;
		else if (this.renamedFrom(this.lastPath, path, file)) {
			// A rename or move of the open note. The stores were re-keyed by the vault's rename handler; the
			// view keeps its scroll, zoom, selection and toolbar, which the note-switch reset below would drop.
			// An external-reload capture taken before the rename names the old path, so it is retired as a switch does.
			this.invalidateReloadBindings(this.lastPath, path);
			this.lastPath = path;
			this.updateHandwritingPageClass();
		} else {
			this.lastFile = file;
			this.endPreviewPaper("note-switch");
			this.cancelOverscrollBounce();
			this.cameraOriginY = null;
			this.invalidateReloadBindings(this.lastPath, path);
			this.reloadCameraSettlement = null;
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
   // The release took the paper off; the note that now opens paints with its
   // at-rest paper from its first frame, re-planned here from the last text
   // size and origin (updateExtent moves the phase if this note's origin differs).
   this.updatePaperSpacing();
   this.pinchScaleNow=1; this.zoomFloor=MIN_PINCH_SCALE; this.pinchRasterScale=1; this.rasterColumnLocal=null; this.previewAnchorStale=false;
   // The column-margin bookkeeping belongs to the camera just reset: a new note starts without a baseline or a debt.
   this.restingColumnMargin=null; this.columnMarginDebt=0;
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
			// A stroke held across the switch left its frame ticker running on the
			// note that is gone (audit 109).
			this.stopFrameTicker();
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
			// (opacity 0, pointer-events none - styles.css ".is-inking") on the
			// NEW note: not merely invisible but unhit-testable, so every pen
			// tap on the toolbar strip lands on whatever is under it instead
			// and nothing happens. abandonActiveStroke() reports whether it
			// actually tore down a live stroke; only then is there stale
			// pen-down chrome to undo, so stripPenUp runs exactly then and a
			// routine switch with nothing to abandon stays the no-op it was.
			if (this.router?.abandonActiveStroke()) {
				stripPenUp(this.mobileTools, this.noteZoomControls);
			}
			this.wet.clear(this.cssWidth, this.cssHeight);
			this.highlightWet.clear(this.cssWidth, this.cssHeight);
			// A file switch mid-handoff would otherwise strand the wet
			// highlighter element hidden for the next note.
			this.highlightWetCanvas.setCssStyles({ opacity: String(HIGHLIGHTER_ALPHA) });
			this.tail.clearAll(this.cssWidth, this.cssHeight);
			this.tail.prepareLive(null, null);
			this.spaceFeedbackKey = null;
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
				// Under a held preview this resize can reach commitCameraScale,
				// whose release runs CodeMirror's measure; that must not happen
				// inside CodeMirror's own update, and deferring only the release
				// would put the settle's scroll write before the fold. So the
				// WHOLE resize moves to a frame of its own (`resizeOutOfUpdate`).
				if (this.measureHold) this.resizeOutOfUpdate(); else this.handleResize();
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
		if (!instances.delete(this)) return;
		this.unmount();
	}

	handleKeyDown(event: KeyboardEvent): boolean {
		if (event.key === "Escape" && event.defaultPrevented) return false;
		this.retirePanSettle("keyboard");
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
		if (peelInkEscapeFloor(event)) return true;
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
			`canvas reallocations since load (all editors): ${canvasReallocs}` +
				"  (4 per resize; a pinch should add ~4 in total, not ~4 per frame)",
		].join("\n");
	}

	/** See inkExternallyReloaded. */
	noteExternallyReloaded(path: string): void {
		if (this.filePath() !== path) return;
		if (this.selection.clear()) this.redrawSelectionUI();
		this.scheduleRepaint("external-reload");
	}

	/**
	 * Is the open note at `path` the note last seen at `lastPath`, renamed or moved? Identity first: two known
	 * file objects decide alone, and the store's rename record is asked only when either is unknown. A record
	 * that a rename left behind could otherwise turn a later switch between two different files into a rename
	 * (a new note made at the freed path, then back to the renamed one), keeping the old view. The
	 * record is still consumed when identity recognises the rename, so it cannot linger; a second pane on the
	 * same note knows it by its file object.
	 */
	private renamedFrom(lastPath: string | null, path: string | null, file: unknown): boolean {
		const history = lastPath !== null && path !== null;
		if (file !== null && this.lastFile !== null) {
			if (file !== this.lastFile) return false;
			if (history) inlineInk.consumeRename(lastPath, path);
			return true;
		}
		return history && inlineInk.consumeRename(lastPath, path);
	}

	private invalidateReloadBindings(...paths: (string | null)[]): void {
		// Invalidate existing captures even if a sibling joins and leaves before
		// the await completes. No retained path registry or new timer is needed.
		for (const pane of instances) {
			if (pane === this || (pane.container && paths.includes(pane.filePath()))) pane.reloadBindingEpoch++;
		}
	}

	/** Binding identity is available independently of this pane's busy state. */
	reloadBinding(): InlineReloadBinding | null {
		if (!this.container?.isConnected || !this.view.dom.isConnected) return null;
		const info = this.view.state.field(editorInfoField, false);
		if (!info?.file?.path) return null;
		return { pane: this, attachment: this.container, epoch: this.reloadBindingEpoch, file: info.file,
			editor: info.editor, path: info.file.path,
			quiet: this.builder === null && this.mode === "ink" && this.selection.isEmpty &&
				!this.router?.isStroking && !this.router?.hasActiveNavigation && this.pinchRefScale === null &&
				!this.pinchPreview && this.pinchPending === null && this.pinchRaf === 0 && this.reloadCameraSettlement === null };
	}

	/** This editor's path, when no ink gesture or retained selection is active. */
	reloadCandidatePath(): string | null {
		const binding = this.reloadBinding();
		return binding?.quiet ? binding.path : null;
	}

	/** The live overlay container, for the census's ghost detection. */
	setCanvasMomentumDisabled(on: boolean): void {
		if (this.panAnchorHold) this.panAnchorHold.expansion = null;
		this.scrollExpansion?.rebase(this.view.scrollDOM.scrollLeft, this.view.scrollDOM.scrollTop);
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

	/** The pen is up: run the pane resize a stroke held back (see handleResize). */
	private replayDeferredResize(): void {
		if (!this.resizeDeferred) return;
		this.resizeDeferred = false;
		if (this.container && !this.frame.locked) this.handleResize();
	}

	private handleResize(): void {
  if(this.deferPinchRaster())return;
		this.restorePinchLayers();
  this.mobileTools?.refresh();
  this.noteZoomControls?.refresh();
  // A mechanical band resize must retain forward demand admitted by scroll.
  this.scrollExpansion?.rebase(this.view.scrollDOM.scrollLeft,this.view.scrollDOM.scrollTop,true);
  const layout=this.viewportLayout;
  if(layout&&layout.parent.clientWidth>0&&layout.parent.clientHeight>0&&this.viewportStyleDirty)this.scheduleViewportStyleRefresh();
  // A stroke owns the frame, so the zoomed layout cannot follow the pane now.
  // Remember it: the lift replays this resize, or the pane kept a blank strip
  // or a clipped edge until something else resized it.
  this.resizeDeferred=!!layout&&this.frame.locked&&layout.parent.clientWidth>0&&layout.parent.clientHeight>0&&
   (layout.parent.clientWidth!==layout.paneWidth||layout.parent.clientHeight!==layout.paneHeight);
  if(layout && !this.frame.locked && layout.parent.clientWidth>0 && layout.parent.clientHeight>0 &&
   (layout.parent.clientWidth!==layout.paneWidth||layout.parent.clientHeight!==layout.paneHeight)) {
   const width=layout.width+layout.parent.clientWidth-layout.paneWidth;
   const height=layout.height+layout.parent.clientHeight-layout.paneHeight;
   if(width>0&&height>0&&width/this.pinchScaleNow<=MAX_VIEWPORT_LAYOUT&&height/this.pinchScaleNow<=MAX_VIEWPORT_LAYOUT) {
    // Measure the natural column with ownership removed below. A fixed-left
    // column does not follow half the width delta; a theme can change its cap.
    // Preserve native scroll across this temporary unscaled-width layout.
    const savedLeft=this.view.scrollDOM.scrollLeft,savedTop=this.view.scrollDOM.scrollTop;
        layout.width=width;layout.height=height;layout.paneWidth=layout.parent.clientWidth;layout.paneHeight=layout.parent.clientHeight;
    const natural=this.measureNaturalColumn({width,height});
    if(natural.column>0){layout.column=natural.column;layout.columnBox=natural.columnBox;layout.gutterX=natural.gutterX;layout.sizerColumn=natural.sizerColumn;layout.columnInset=natural.columnInset;layout.ownLines=natural.ownLines;layout.left=natural.left;layout.right=natural.right;}
    layout.columnLocal=natural.columnLocal;layout.columnReserve=natural.columnReserve;
    layout.columnAuto=natural.columnAuto;
    // Hidden editors release their backings and invalidate geometry. Restore
    // the full physical viewport before navigation can reject that stale state,
    // then let the common resize path measure and rebuild the visible surface.
    this.applyViewportBox(this.pinchScaleNow);
    this.view.scrollDOM.scrollLeft=savedLeft;this.view.scrollDOM.scrollTop=savedTop;
    if(this.scaleGeometryValid!==false&&this.commitCameraScale(this.pinchScaleNow, undefined, undefined, true))return;
   }
  }
		// UNDER THE HOLD (D-COV, AD-4 i): a resize that did not commit above
		// reallocates nothing and moves no band; the raster keeps the basis the
		// preview translate was solved against until the settle re-rasters.
		if (this.pinchPreview) return;
		this.clearSnapPreview();
		if (!this.container) return;
		if (this.canvasMode) this.lastExtentInputs = null;
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
			if (!this.frame.locked && this.committedCanvas.width > 0) this.releaseBackings();
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
			// The open note keeps this as its reference, once (audit 46). Only
			// with an editor state to name the note: a bare rig has none.
			const path = this.view.state ? this.filePath() : null;
			if (path !== null) inlineInk.setFontRefPx(path, fontPx);
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
			// The paper follows the text's size as just read, and the thickness the
			// scale just measured.
			this.paperFontPx = fontPx;
			this.paperRestZoom = Number.NaN;
			this.updatePaperSpacing();
		}
		// A canvas-off reset refused while the tab had no box runs now the geometry is back. Its commit has already
		// sized the canvases through its own handleResize, from the scale it set; going on here would size them
		// again from the scale measured above, before the reset.
		if (this.retryCanvasOffReset()) return;
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
		// Same backing, same box: reallocating would blank four full canvases
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
			this.highlightCanvas,
			this.highlightWetCanvas,
		]) {
			// Counted, because "the canvases are being reallocated every frame"
			// is a claim that should be a number rather than an argument. Each
			// assignment here throws away and re-allocates a backing store the
			// size of the viewport times the backing scale, four times over.
			// A deferred highlight pair, and a released wet canvas, keep their 0x0 backing and take only the box.
			const deferred = (this.highlightPairDeferred && (c === this.highlightCanvas || c === this.highlightWetCanvas)) ||
				(this.wetDeferred && c === this.wetCanvas);
			if (!deferred) {
				canvasReallocs++;
				c.width = size.backingW;
				c.height = size.backingH;
			}
			// The compositor's layer follows this box, not the backing: keep it
			// at the visual size and stretch it over the band (canvasLayerBox).
			// Under a zoom-shrunk host the inherited zoom already does that, so
			// the same call returns the plain band box and no transform.
			const box = canvasLayerBox(size.cssW, size.cssH, measuredCssScale, this.hostZoomSupported());
			c.setCssStyles({ width: `${box.width}px`, height: `${box.height}px`, transform: box.transform, transformOrigin: box.transform ? "0 0" : "" });
		}
		// The backing just allocated against the device pixels the container
		// really occupies. `rect` is the read this method already made and
		// nothing since has moved the container, so this costs no second forced
		// layout. They disagree when the box and the backing were computed from
		// different geometry, which resamples the ink: a host whose zoom came
		// from injected CSS rather than the overlay's own write. Recorded for
		// the suites, never logged.
		const rectBackingW = Math.round(rect.width * this.dpr);
		this.backingBoxMismatch = Math.abs(size.backingW - rectBackingW) > 1
			? { backingW: size.backingW, rectBackingW }
			: null;
		this.committedCtx.setTransform(backing, 0, 0, backing, 0, 0);
		this.committedBacking = backing;
		// A deferred pair is 0x0: no context call (allocateHighlightPair sets this transform when it sizes the pair).
		if (!this.highlightPairDeferred) this.highlightCtx.setTransform(backing, 0, 0, backing, 0, 0);
		this.wet.applyDpr(backing);
		this.highlightWet.applyDpr(backing);
		this.tail.applyDpr(backing);
		this.wet.noteBackingCleared?.();
		this.wet.dropWetTile?.();
		this.highlightWet.noteBackingCleared?.();
		this.tail.noteBackingCleared?.();
		this.tail.configureInlineBacking(size.cssW, size.cssH, backing, measuredCssScale, this.hostZoomSupported());
		this.wet.tileTranslate = this.translateSupported();
		this.wet.configureWetTile?.(this.wetTileCanvas, size.cssW, size.cssH, backing, measuredCssScale, this.hostZoomSupported());
		this.committedBlank = this.highlightBlank = true;
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
	 * Give the highlight pair the backing the other layers already have, the
	 * first time the note needs it. Idempotent. The committed canvas is the
	 * reference: handleResize sizes it on every change, so its backing and
	 * `committedBacking` are the current ones, and the pair's box was placed
	 * with the others all along. A committed canvas with no backing yet (no
	 * layout) leaves the pair at 0x0; the next resize sizes it with the rest.
	 *
	 * It asks for no repaint: every caller either draws the highlight layer
	 * right after (a repaint that holds a highlighter stroke) or holds no
	 * highlighter stroke to draw (a pen-down on a note without one), and a
	 * request from the pen-down would re-raster the note inside the stroke.
	 */
	private allocateHighlightPair(): void {
		if (!this.highlightPairDeferred) return;
		this.highlightPairDeferred = false;
		const w = this.committedCanvas.width, h = this.committedCanvas.height;
		const backing = this.committedBacking;
		if (!(w > 0 && h > 0) || backing === null) return;
		for (const c of [this.highlightCanvas, this.highlightWetCanvas]) {
			canvasReallocs++;
			c.width = w;
			c.height = h;
		}
		this.highlightCtx.setTransform(backing, 0, 0, backing, 0, 0);
		this.highlightWet.applyDpr(backing);
		this.highlightWet.noteBackingCleared?.();
		this.highlightBlank = true;
	}

	/**
	 * Drop the pen wet canvas to 0x0 while the page moves with nothing on it:
	 * no stroke in flight, no pinch live, the layer proven blank, a backing to
	 * drop. Called on every scrolled frame and every ink layer transform write
	 * (the one write per bounce frame); with nothing to do it costs a few
	 * reads. No context call and no box write: the css box stays where
	 * placeCanvasLayers puts it. A live pinch writes no backing at all (its
	 * composite may be borrowing this canvas); the settle's scroll releases it.
	 */
	private releaseWetIfIdle(): void {
		if (this.wetDeferred || this.wetReleaseOff || this.builder !== null || this.pinchRefScale !== null || this.pinchPreview ||
			!this.wet?.provenBlank || !(this.wetCanvas?.width > 0)) return;
		this.wetDeferred = true;
		this.wetCanvas.width = 0;
		this.wetCanvas.height = 0;
		this.wet.noteBackingCleared();
	}

	/**
	 * Give a released wet canvas the backing the committed canvas has, before
	 * the first wet write of a pen stroke, or before a pinch's composite
	 * borrows it (only when the composite engages: a pen-only pinch writes no
	 * backing).
	 * allocateHighlightPair's twin: idempotent, the committed canvas is the
	 * reference, and a committed canvas with no backing yet leaves the wet
	 * canvas at 0x0 for the next resize to size. No repaint is asked for.
	 */
	private allocateWet(): void {
		if (!this.wetDeferred) return;
		this.wetDeferred = false;
		const w = this.committedCanvas.width, h = this.committedCanvas.height;
		const backing = this.committedBacking;
		if (!(w > 0 && h > 0) || backing === null) return;
		canvasReallocs++;
		this.wetCanvas.width = w;
		this.wetCanvas.height = h;
		this.wet.applyDpr(backing);
		this.wet.noteBackingCleared();
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

	/**
	 * `resolveColumnLeft` over a fresh scan, for the sites that only paint.
	 *
	 * UNPANNED, and every caller wants it that way: the camera this feeds paints
	 * into the ink layer. Its raster camera and transform together carry the
	 * focal pan. De-panned BEFORE `resolveColumnLeft` so the
	 * cached last-good value is in the same frame as the live ones - a cache
	 * holding a panned number would come back out against a different pan.
	 */
	private columnLeft(): number {
		return this.resolveColumnLeft(this.unpanX(contentOriginLeft(this.view.contentDOM)));
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
		// De-panned, like every other camera-facing column read: `.cm-content`
		// rides inside `.cm-sizer`, which carries the text half of the focal
		// pan. The raster camera below accounts only for its baked portion;
		// the ink layer carries the rest. Letting raw pan into this read is the double-apply a
		// deferral lapse - a finger held still past PINCH_SCROLL_QUIET_MS, which
		// lets this method run mid-gesture - would otherwise produce.
		const contentLeft = this.resolveColumnLeft(this.unpanX(origin.left));
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
			// The paper too, on the same change and no other: this is the one
			// place a font change lands without the refresh path.
			this.paperFontPx = Number.parseFloat(fontStr);
			this.updatePaperSpacing();
		}
		// Unconditionally, not inside the epsilon branch above: the font zoom
		// can move on a frame where the css scale did not, and leaving
		// `this.scale` stale there was half of the same defect.
		this.scale = this.cssScale * this.fontZoom;
		// Use the adopted scale in both this method and its read-only twin.
		// ONE rect read, and it is the ANCHOR PROBE's rather than
		// `.cm-content`'s - see DocumentAnchor.ts for why the large rect is the
		// defect. `anchorTop` is still the fallback and is still what the
		// number below means, so nothing downstream changes shape.
		const anchor = this.anchorCameraY(overlay.top);
		const documentTopPanned = anchor ? anchor.impliedTop : anchorTop(this.view, this.contentStyle?.paddingTop, this.cssScale);
		const documentTop = documentTopPanned - this.panY();
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
		// Subtract the two scrolling rects before adding the pan. Removing it
		// from only one operand first rounds differently as both rects scroll,
		// creating camera motion and a full repaint while the band is still.
		const layoutColumn = this.ownedColumnLayoutLeft(origin.line);
		this.camera.setState(
			(layoutColumn === null ? visualToNote(origin.left === null ? overlay.left - contentLeft : (overlay.left - origin.left) + this.panX(), this.scale) : (this.band!.left - layoutColumn) / this.fontZoom) - (this.rasterPan?.x ?? 0) / this.fontZoom,
			// THE ANCHORED FORM, when the ladder answered: the rung's own offset
			// enters as an exact integer of layout px, and only the residual -
			// at most half a rung spacing from where the camera was left - is
			// divided by the believed cssScale. The fallback is the shipped
			// expression, unchanged, so a view without the widget is
			// arithmetically what it was.
			this.canonicalCameraY(anchor
				? anchor.layout / this.fontZoom - (this.rasterPan?.y ?? 0) / this.fontZoom
				: visualToNote((overlay.top - documentTopPanned) + this.panY(), this.scale) - (this.rasterPan?.y ?? 0) / this.fontZoom, true),
			this.fontZoom
		);
		// Where the next sync starts looking for a rung. A stored number, not a
		// DOM write: nothing inside contentDOM is touched on the scroll path.
		if (anchor) this.anchorCameraYLayout = anchor.layout;
		// The parity gate runs at mount, at every basis reset and at every adoption. All
		// three already cost a mount or a full redraw, and `basisResets` measures
		// 0 per round on the far arms, so the gate's one rect read is never on
		// the steady scroll path.
		if (anchor && (this.anchorGateDue || this.anchorAdoptionEvent)) {
			const why = this.anchorGateDue ? "mount" : "adoption";
			this.anchorGateDue = false;
			this.gateAnchorParity(why, anchor.impliedTop, anchor.rung * RUNG_SPACING);
		}
		this.anchorAdoptionEvent = false;
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
		// camera now says, on the same three fields and the same bar `repaint`
		// uses to decide the same question one step later. Absent means
		// nothing has been painted yet, and nothing painted cannot be stale;
		// truthiness rather than `!== null` because the prototype-built
		// fixtures that exercise this method leave the field off entirely,
		// and "no recorded paint" is the right reading of that too.
		//
		// "scroll" as the via ON PURPOSE. It asserts no damage and does not
		// dirty the index (the index is in world space; the camera cannot
		// stale it), and `repaint` upgrades any camera motion past the bar to a
		// full redraw by itself. So the frame this queues costs a full re-raster
		// exactly when one is needed, and costs an empty callback when this
		// call was already inside the repaint that is about to fix it.
		// The three getters and not `camera.snapshot`: that one spreads a
		// fresh object every call, and this runs on every scrolled frame.
		//
		// NOT WHILE AN EDGE BOUNCE PLAYS. The camera is built from rects that
		// ride the bounce's translate plus a pan that carries the same live
		// offset; the two cancel on paper and not bit for bit, so the exact
		// compare of the time found a new camera on every bounce frame and each repaint's
		// own sync queued the next - a full re-raster per frame for the whole
		// half second (Orion scroll probe, 2026-09-29). The camera still syncs
		// here; the bounce's last frame syncs once more, with no bounce live,
		// and that sync asks for the one repaint a real move owes.
		//
		// The same sub-pixel bar as `repaint` (committedRepaintPlan): a camera a
		// hair off the painted one owes no repaint here either.
		const painted = this.lastPaintCam;
		if (
			painted &&
			!this.bounceState &&
			!cameraWithin(painted.x, painted.y, painted.zoom, this.camera.x, this.camera.y, this.camera.zoom,
				this.committedBacking ?? 0, CAMERA_STILL_BACKING_PX)
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
		this.concealPenCursor();
		this.penCursorClient = null;
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
		stripPenDown(this.mobileTools, this.noteZoomControls);

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
			this.eraseHistoryIdentity = here ? inlineInk.captureHistoryIdentity(here) : null;
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
			metrics.begin("erase", performance.now(), this.tail?.resizeTotal);
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
		metrics.begin("ink", performance.now(), this.tail?.resizeTotal);
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
		stripPenDown(this.mobileTools, this.noteZoomControls);
		// Before the first wet pixel, in this task: the stroke must land on a sized layer.
		if (tool === "highlighter") this.allocateHighlightPair();
		else this.allocateWet();
		this.activeWet = tool === "highlighter" ? this.highlightWet : this.wet;
		// The dot, the head and the predicted tail are this stroke drawn on the
		// tail canvas; a highlighter's must wear its wash there too, or an
		// opaque disc rides the tip over the text until the pen lifts.
		this.dressTail(tool === "highlighter");
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
			const contactHalfWidth = this.activeWet.contactHalfWidth(this.activeStyle, point.pressure);
			this.tail.clear();
			this.tail.prepareLive({
				cam: this.camera.snapshot, style: this.activeStyle,
				from: { x: point.x, y: point.y }, to: { x: point.x, y: point.y },
				pressure: point.pressure, hwWorld: contactHalfWidth,
			}, null);
			this.tail.drawHead(
				this.camera.snapshot,
				this.activeStyle,
				{ x: point.x, y: point.y },
				{ x: point.x, y: point.y },
				point.pressure,
				contactHalfWidth
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
		const head = this.activeWet.head();
		let prediction: { fromX: number; fromY: number; points: readonly PenSample[]; lineWidthPx: number } | null = null;
		if (predictionEnabled()) {
			this.predReal.push(...samples);
			if (this.predReal.length > PRED_HISTORY) {
				this.predReal.splice(0, this.predReal.length - PRED_HISTORY);
			}
			prediction = this.planPredictedTail(ev, cam);
		}
		const liveHead = head ? {
			cam, style: this.activeStyle, from: head.from, to: head.to,
			pressure: head.pressure,
			hwWorld: this.activeWet.liveHalfWidth(this.activeStyle, head.pressure),
		} : null;
		this.tail.clear();
		this.tail.prepareLive(liveHead, prediction);
		if (head) {
			this.tail.drawHead(
				cam,
				this.activeStyle,
				head.from,
				head.to,
				head.pressure,
				liveHead!.hwWorld
			);
		}
		// The predicted tail goes on the same canvas, after the head, so the
		// one `clear()` above erases both: its dirty rect covers whatever was
		// drawn last event, whether that was real or a guess.
		if (prediction) this.tail.draw(prediction.fromX, prediction.fromY,
			prediction.points, this.activeStyle.color, prediction.lineWidthPx);
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
	private planPredictedTail(ev: PointerEvent, cam: CameraState):
		{ fromX: number; fromY: number; points: readonly PenSample[]; lineWidthPx: number } | null {
		const real = this.predReal;
		const newest = real[real.length - 1];
		if (!newest) return null;
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
			return null;
		}
		metrics.recordTail(result.points.length, result.horizonMs, result.tipDistPx);
		// Sample space IS canvas css px: a sample is the client offset from the
		// container divided by the css scale, and drawHead's own screen
		// arithmetic - (world - cam) * zoom - lands on the same number.
		return { fromX: newest.x, fromY: newest.y, points: result.points,
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
			lineWidthPx: this.activeWet.liveWidthPx(cam, this.activeStyle, this.ribbonPressure) };
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

	private originStyle(el: Element): CSSStyleDeclaration {
		this.originStyles ??= new WeakMap<Element, CSSStyleDeclaration>();
		let value = this.originStyles.get(el);
		if (!value) { value = this.winRef.getComputedStyle(el); this.originStyles.set(el, value); }
		return value;
	}

	/** Untransformed column position for the owned normal-flow sizer tree.
	 * A transformed DOM rect loses precision as it crosses the viewport; its
	 * de-panned value cannot be made stable by rearranging subtraction. Read
	 * resolved fractional margins and insets in the same layout coordinates
	 * as band.left instead. Unsupported positioning keeps the live DOM path.
	 */
	private ownedColumnLayoutLeft(line: Element | null): number | null {
		if (!this.viewportLayout || !this.band || !line) return null;
		const scroller = this.view.scrollDOM, sizer = this.panSizer();
		if (!sizer || !sizer.contains(line)) return null;
		// THE LEFT RESERVE'S TRANSLATE DOES NOT SEND THIS MEASURE TO THE DOM PATH. Refusing it did, and that path read
		// the column about 3450 local px right of the owned layout at 10% (reserve about 3980): the re-measure booked it
		// as a changed column, the margin debt paid it into the scroll, and the page jumped about 350 px in one frame.
		// Matched to 0.01 px, not exactly: a float miss would drop back to the DOM path and bring the jump back unseen.
		const reserve = this.leftReserveHeld > 0 ? this.leftReserveHeld : 0;
		const isReserve = (translate: string): boolean => {
			const parts = translate.trim().split(/\s+/);
			return reserve > 0 && parts.length === 1 && Math.abs(parseFloat(parts[0]!) - reserve) <= 0.01;
		};

		let x = 0;
		for (let el: Element | null = line; el && el !== scroller; el = el.parentElement) {
			const parent: Element | null = el.parentElement;
			if (!parent) return null;
			const cs = this.originStyle(el), ps = this.originStyle(parent);
			if (cs.direction !== 'ltr' || cs.writingMode !== 'horizontal-tb' || cs.cssFloat !== 'none' ||
				(cs.position !== 'static' && cs.position !== 'relative') ||
				(cs.position === 'relative' && ((cs.left !== 'auto' && parseFloat(cs.left) !== 0) || (cs.right !== 'auto' && parseFloat(cs.right) !== 0))) ||
				(el !== sizer && cs.transform !== 'none') || (cs.translate !== 'none' && !(el === sizer && isReserve(cs.translate))) || cs.rotate !== 'none' || cs.scale !== 'none' ||
				(cs.display !== 'block' && cs.display !== 'flow-root' && cs.display !== 'flex') || ps.display.includes('grid') ||
				(cs.zoom !== '1' && cs.zoom !== 'normal') || (ps.zoom !== '1' && ps.zoom !== 'normal')) return null;
			if (ps.display.includes('flex')) {
				const row = ps.flexDirection === 'row';
				const alignment = cs.alignSelf === 'auto' ? ps.alignItems : cs.alignSelf;
				if (ps.flexWrap !== 'nowrap' || cs.order !== '0') return null;
				if (row && ps.justifyContent !== 'normal' && ps.justifyContent !== 'start' && ps.justifyContent !== 'flex-start' && ps.justifyContent !== 'left') return null;
				if (!row && (ps.flexDirection !== 'column' || (alignment !== 'normal' && alignment !== 'stretch' && alignment !== 'start' && alignment !== 'flex-start'))) return null;
				if (row) for (let sibling: Element | null = parent.firstElementChild; sibling; sibling = sibling.nextElementSibling) {
					if (sibling === el) continue;
					const ss = this.originStyle(sibling);
					if (ss.display !== 'none' && ss.position !== 'absolute' && ss.position !== 'fixed') return null;
				}
			}
			const margin = parseFloat(cs.marginLeft), padding = parseFloat(ps.paddingLeft), border = parent === scroller ? 0 : parseFloat(ps.borderLeftWidth);
			if (!Number.isFinite(margin) || !Number.isFinite(padding) || !Number.isFinite(border)) return null;
			x += margin + padding + border;
			// The sizer's translate is the left reserve and nothing else. It is painted, so the column carries it here as it
			// does in `holdLeftReserve`, which shifts the owned layout's column by the same amount.
			if (el === sizer && cs.translate !== 'none') x += reserve;
			if (parent === scroller) return x;
		}
		return null;
	}

	/** Keep scroll-only rect rounding out of the camera shared by paint/input.
	 * A changed basis accepts raw geometry immediately. Unobserved flow changes
	 * still compare against the retained reference and cannot accumulate drift.
	 */
	private canonicalCameraY(raw: number, adopt: boolean): number {
		const canvases = [this.committedCanvas, this.highlightCanvas, this.wetCanvas, this.highlightWetCanvas, this.tailCanvas];
		const backing = Math.max(...canvases.map(c => c ? Math.max(c.width / this.cssWidth, c.height / this.cssHeight) : NaN));
		if (!this.viewportLayout || !this.band || !this.scaleGeometryValid || !Number.isFinite(raw) || !Number.isFinite(backing)) {
			if (adopt) this.cameraOriginY = null;
			return raw;
		}
		// NOT `viewportGeneration`. That counter is continuation OWNERSHIP: a
		// pen-down, a pinch start, `restoreViewportLayout` and a navigation each
		// bump it so a pending async measure can tell it no longer owns the
		// view. None of the four is a geometry input in its own right, and every
		// geometry a bump could stand for is already a term here - the band,
		// both pans, both scales, the padding, the dpr, the backing, the layout
		// object. With it in the basis every pen-down reseeded the retained
		// origin, so the first stroke after a scroll adopted a raw Y that sat
		// INSIDE both caps and re-rasterised the whole note for it: measured at
		// 6-17 ms a stroke, one per round at 0.15 and one per scroll at 0.10,
		// near and far alike, and every sub-cap basis reset in that measurement
		// was attributed to this term and to nothing else.
		// Removing it does not disable the rule at a pen-down; it stops a
		// pen-down from disabling the rule.
		const basis = [this.filePath(), this.view.contentDOM, this.container, this.panSizer(), this.band,
			this.cssScale, this.fontZoom, this.panX(), this.panY(), this.rasterPan?.x, this.rasterPan?.y,
			this.contentStyle?.paddingTop, this.view.scaleX, this.view.scaleY, this.dpr, backing,
			this.viewportLayout];
		// Did this call ADOPT a raw that differs from the retained one?
		// That is either a basis reset or a raw beyond the cap, and both are the
		// moments the anchor has to be re-proved against `anchorTop` - a theme
		// switch that displaces the wrapper by a constant looks exactly like
		// genuine text movement otherwise. Recorded here, acted on by
		// `syncCamera`, because the gate costs a rect read and this method is
		// called by the read-only twin too.
		const priorY = this.cameraOriginY ? this.cameraOriginY.y : null;
		const y = stableCameraOriginY(raw, this.cameraOriginY, basis, this.cssScale, this.fontZoom, backing);
		if (adopt) this.anchorAdoptionEvent = priorY === null || (y === raw && raw !== priorY);
		if (adopt && (y === raw || !this.cameraOriginY)) this.cameraOriginY = { y, basis };
		return y;
	}

	/**
	 * Prove the ladder still stands for the same document top `anchorTop`
	 * reports, and take it out of service for this view's lifetime if not.
	 *
	 * ONE `contentDOM` rect read, and only at the events that already cost a
	 * full redraw or a mount - `basisResets` measures 0 per round on the far
	 * arms, so this is never on the steady scroll path. Every consumer falls
	 * back together because the ladder itself is unmounted: the camera, the
	 * read-only twin and the diagnostics all ask `documentAnchorLadder` first.
	 */
	private gateAnchorParity(reason: string, implied: number, rungTopLayout: number): void {
		const shipped = anchorTop(this.view, this.contentStyle?.paddingTop, this.cssScale);
		const contentTop = this.view.contentDOM.getBoundingClientRect().top;
		const bar = anchorParityBar(contentTop, rungTopLayout, this.cssScale);
		if (Number.isFinite(implied) && Number.isFinite(shipped) && Math.abs(implied - shipped) <= bar) return;
		refuseDocumentAnchor(this.view, { implied, shipped, bar, reason });
		scrollProbeExtent(`document anchor refused (${reason}): implied ${implied} vs anchorTop ${shipped}, delta ${Math.abs(implied - shipped)} > bar ${bar}`);
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
		const origin = contentOrigin(this.view.contentDOM);
		const contentLeft = this.resolveColumnLeft(this.unpanX(origin.left));
		// The twin reads the anchor the same way and RE-PLACES NOTHING: a
		// read-only diagnostic that moved the probe would be a write.
		const anchor = this.anchorCameraY(overlay.top);
		const documentTopPanned = anchor ? anchor.impliedTop : anchorTop(this.view, this.contentStyle?.paddingTop, this.cssScale);
		const layoutColumn = this.ownedColumnLayoutLeft(origin.line);
		return {
			x: (layoutColumn === null ? visualToNote(origin.left === null ? overlay.left - contentLeft : (overlay.left - origin.left) + this.panX(), this.scale) : (this.band!.left - layoutColumn) / this.fontZoom) - (this.rasterPan?.x ?? 0) / this.fontZoom,
			y: this.canonicalCameraY(anchor
				? anchor.layout / this.fontZoom - (this.rasterPan?.y ?? 0) / this.fontZoom
				: visualToNote((overlay.top - documentTopPanned) + this.panY(), this.scale) - (this.rasterPan?.y ?? 0) / this.fontZoom, false),
		};
	}

	/**
	 * E's Y origin from the anchor probe, or `null` to fall back.
	 *
	 * ONE rect read, replacing the `.cm-content` rect read `anchorTop` would
	 * have done, so the layout-read count per sync is unchanged. Read-only:
	 * the re-placement is a separate call the twin does not make.
	 */
	private anchorCameraY(overlayTop: number): { layout: number; rung: number; impliedTop: number } | null {
		// Z10: on a css-zoom host `anchorTop` is already exact, and the ladder is
		// what moves the camera. See `anchorTopExactOnZoomHost`.
		if (this.anchorTopExactOnZoomHost(overlayTop)) return null;
		const held = documentAnchorLadder(this.view);
		if (!held) return null;
		// The wrapper sits at `.cm-content`'s BORDER-BOX top, so the document's
		// own padding edge is this much lower. Shared with `anchorTop` so the two
		// agree bit-for-bit; `null` means give up and let `anchorTop` answer.
		const padding = anchorPaddingTop(this.view, this.contentStyle?.paddingTop, this.cssScale);
		if (padding === null) return null;
		// WHICH RUNG, arithmetically and with no layout read of its own: where
		// the camera was left last sync, or - on the very first one - the scroll
		// offset. A wrong answer costs distance and never correctness.
		const from = Number.isFinite(this.anchorCameraYLayout) ? this.anchorCameraYLayout : this.view.scrollDOM.scrollTop;
		const k = rungIndexFor(from, held.spacing, held.rungs.length);
		const rungTopLayout = k * held.spacing;
		const rungRectTop = held.rungs[k]!.getBoundingClientRect().top;
		const layout = cameraOriginYLayout(rungTopLayout, overlayTop, rungRectTop, this.panY(), this.cssScale, padding);
		if (layout === null) return null;
		return { layout, rung: k, impliedTop: impliedDocumentTop(rungTopLayout, rungRectTop, this.cssScale, padding) };
	}

	/**
	 * Z10: WHERE THE LADDER IS THE DEFECT, NOT THE CURE.
	 *
	 * The ladder exists because a large rect is rounded at its magnitude: on the
	 * transform host `.cm-content`'s top is a float32 far from the screen, and
	 * that rounding moved the camera every frame. On a css-zoom host the same
	 * rect is not rounded at all. Blink stores zoomed positions as LayoutUnits
	 * (1/64 of a layout-zoom px) and the web-exposed scroll offset is a whole
	 * px, so the rect top is an exact dyadic value that float32 carries without
	 * loss - and `anchorTop` is exact.
	 *
	 * The ladder, on that host, is not. The rung's zoomed top is TRUNCATED to
	 * 1/64 (`LayoutUnit(float)`), so its implied document top is off by the
	 * dropped part, plus `rungTop x (zoom - cssScale)` where the measured scale
	 * is itself a truncated width over an integer offsetWidth. At adoption
	 * `gateAnchorParity` sees that difference, refuses the ladder, the next sync
	 * falls back to `anchorTop`, and the camera moves back: two camera-only
	 * whole-world redraws per refusal (LagAtLowZoom's far and fractional arms;
	 * recorded per sync in `test/render/z10Recorder.ts`).
	 *
	 * So the ladder is bypassed exactly where `anchorTop` is exact, and nowhere
	 * else - everywhere else the ladder path runs as it did:
	 *  - the host form in force is css zoom, with no transform of its own, and
	 *    the measured scale is the host's zoom and nothing more. An ancestor
	 *    transform would put a non-dyadic factor into the rect; the measured
	 *    quotient is within 2/offsetWidth of the product when it is only the
	 *    width's own truncation (the fd04036e bound);
	 *  - the layout zoom factor is 1 or 2. Page zoom and display scaling enter
	 *    Blink as a layout zoom factor the rect is divided by; at 1.25 the rect
	 *    reads 11468.7998046875 where 1 and 2 read 11468.796875 (measured,
	 *    real device scale factor). `devicePixelRatio` is how that factor is
	 *    seen from here;
	 *  - the coordinate is inside float32's exact range at that grid:
	 *    24 bits of mantissa over a 1/(64 x dpr) px grid is 2^18 / dpr px.
	 */
	private anchorTopExactOnZoomHost(overlayTop: number): boolean {
		const layout = this.viewportLayout;
		if (!layout || !this.container || !this.hostZoomSupported()) return false;
		if (layout.baseTransform !== "none" && layout.baseTransform !== "") return false;
		if (this.dpr !== 1 && this.dpr !== 2) return false;
		const width = this.container.offsetWidth;
		const own = layout.baseZoom * this.pinchScaleNow;
		if (!(width > 0) || !(own > 0) || !Number.isFinite(this.cssScale)) return false;
		if (Math.abs(this.cssScale / own - 1) > 2 / width) return false;
		return Math.abs(this.view.scrollDOM.scrollTop * this.cssScale) + Math.abs(overlayTop) < this.zoomRectExactLimit() / this.dpr;
	}

	/**
	 * float32's exact range for a 1/64 px grid, in zoomed px. A method rather
	 * than a constant so a render cell can plant a lower limit on the prototype
	 * and read the ladder path take over above it.
	 */
	private zoomRectExactLimit(): number {
		return 2 ** 18;
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
		// `> 0`, not the field alone: a unit rig built with Object.create never runs the initialiser.
		const reserveBefore = this.leftReserveHeld > 0 ? this.leftReserveHeld : 0;
		this.endPenGesture(ev);
		// Alan: nothing moves unless the page is past its edge, then it eases
		// back - no infinite blank standing forever. A pen that catches a bounce mid-flight and draws holds
		// the page still for the stroke (the fold, unchanged); after it lifts, a page still standing past
		// its bound resumes the same way the touch side does. A page already inside its room has nowhere to
		// ease to, so this is a no-op for it - OverscrollBounce.test.ts's "PEN DOWN MID-BOUNCE" row now
		// asserts both regimes.
		// AFTER the gesture's own work, on every branch, so the resume reads the world the extent pass left:
		// a stroke left of the page lands its left reserve in that pass, and the room it opens is what the
		// resume pays the standing pan into. Run before it, the resume saw no reserve and no scroll and eased
		// the page to the old edge, hiding the stroke it had just made room for.
		this.resumeStrandedPan();
		// THE COMMITTED LAYER FOLLOWS THE RESERVE IN THE SAME FRAME. The stroke was drawn on it at the camera from
		// before the reserve, and the reserve then shifted the layer with the column, so until the next frame's
		// repaint the new stroke showed about R * k left of the pen - measured about 400 px at 10%. Only when the
		// reserve moved; `repaint` here is the one the queued frame would have run, with the resume already applied.
		if ((this.leftReserveHeld > 0 ? this.leftReserveHeld : 0) !== reserveBefore) {
			this.damage.addAll();
			this.repaint();
		}
	}

	/** Everything a pen lift does before the page may resume: the gesture's branches, each ending in its extent pass. */
	private endPenGesture(ev?: PointerEvent): void {
		// Whatever the gesture was, it is over: the frame is live again and
		// re-reads the editor's current origin.
		this.frame.end();
		// A canvas-off reset refused while this stroke owned the frame runs now.
		this.retryCanvasOffReset();
		// Complete a band update skipped while the contact froze its geometry.
		if (this.bandSyncDeferred) {
			this.bandSyncDeferred = false;
			this.scheduleRepaint("scroll");
		}
		// And a pane resize the zoomed layout skipped for the same reason.
		this.replayDeferredResize();
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
		stripPenUp(this.mobileTools, this.noteZoomControls);
		// The stranded pan resumes in `penUp`, after this method returns.
		// A give paused for the stroke eases on to the cap now that the pen is up.
		if (this.pinchGive?.paused) this.resumePinchGive();
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
			metrics.end(performance.now(), this.tail?.resizeTotal);
			this.stopFrameTicker();
			this.hideEraserCursor();
			const erased = this.erased;
			const eraseFrom = this.eraseFrom;
			this.erased = [];
			this.eraseFrom = [];
			this.eraseHistoryIdentity = null;
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
		metrics.end(performance.now(), this.tail?.resizeTotal);
		this.stopFrameTicker();
		const builder = this.builder;
		const wasPen = this.strokePenGesture;
		// Finish before clearing the wet layer. Release filtering may produce
		// several stored strokes from one contact, but every committed segment
		// is drawn underneath the still-visible wet pixels before they clear.
		if (this.strokePenGesture) observeStrokeMax(this.strokeRawMax);
		// A mouse's samples come through a moving average that lags the pointer
		// and is never flushed, so a dash released while moving ended short of
		// the release. The pointerup carries the real position: it is the
		// stroke's last point, as the pdf's addFinalPoint does (audit 98).
		if (builder && this.mouseStroke && ev?.type === "pointerup") {
			const at = this.router?.sampleAt(ev);
			if (at) {
				const w = this.camera.screenToWorld(at.x, at.y);
				// Builder only: the wet layer clears once the commit below has
				// drawn the stroke, release point included, underneath it.
				builder.add(w.x, w.y, this.gainedPressure(at.pressure), at.timestamp, at.tiltX, at.tiltY);
			}
		}
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
			// One clock: the last move is stamped from the samples, in the clock of
			// the note's own window, so the hold is read there too. The global
			// clock is the main window's, and in a popout its origin differs, so
			// every stroke read as held (audit 116).
			// Read defensively: unit rigs build the overlay with no view, or a
			// window stand-in with no clock.
			const clock = this.view?.dom?.ownerDocument?.defaultView?.performance ?? performance;
			const heldMs = clock.now() - this.rawLastMoveT;
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
			this.tail.prepareLive(null, null);
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
				// A stroke can commit while a pinch preview is live - a pen
				// landing during a touch pinch, or a preview left standing by a
				// lost end event. This path writes the committed canvas WITHOUT
				// going through `repaint`, so nothing here would otherwise drop
				// the preview offset or invalidate its anchor.
				//
				// It is drawn at the CURRENT camera, which already accounts for
				// where the column is now, so the layer's translation would put
				// it dx away from the pen - permanently, since the pixels are
				// committed. Clearing that translation first is therefore not
				// optional.
				//
				// And clearing alone is not enough: the loop below draws only
				// `strokes`, while the rest of the layer still holds pixels
				// rasterised when the translation WAS in force. So ask for a
				// full frame as well, and let repaint's own guard re-latch the
				// anchor. One frame of inconsistency against a stroke that
				// would otherwise sit wrong until the gesture ended.
				// UNDER THE HOLD (D-COV, AD-4 i) the stroke is drawn at the camera
				// the raster already has, so it lands consistently with every
				// other pixel under the same translation; nothing is cleared,
				// invalidated or re-rastered. The paragraph above describes the
				// re-base this replaced (2026-09-13: it culled the panned-in ink).
				const paintCam = this.pinchPreview && this.lastPaintCam ? this.lastPaintCam : this.camera.snapshot;
				if (this.activeWet === this.highlightWet) {
					this.highlightWetCanvas.setCssStyles({ opacity: "0" });
				}
				for (const finished of strokes) {
					this.markCommittedPaint(finished.tool);
					drawStroke(
						this.committedCtxFor(finished.tool),
						paintCam,
						finished,
						undefined,
						true,
						undefined,
						committedFloorFor(this.committedBacking, this.dpr)
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
				this.tail.prepareLive(null, null);
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
	 * The part of the ink band the scroller shows, in the band's own css px.
	 * The band reaches up to a scroll margin past the pane on every side, so
	 * its own box is not what the reader can see. Two layout reads, once per
	 * snap offer; the whole band when either box has no size.
	 */
	private visibleBandArea(band: HTMLElement): { left: number; top: number; width: number; height: number } {
		const whole = { left: 0, top: 0, width: this.cssWidth, height: this.cssHeight };
		const scroller = this.view.scrollDOM;
		const b = band.getBoundingClientRect(), s = scroller.getBoundingClientRect();
		const k = this.cssWidth > 0 ? b.width / this.cssWidth : 0;
		if (!(k > 0) || !(s.width > 0) || !(s.height > 0)) return whole;
		// The scroller's client box: inside its border, without its scrollbars,
		// in screen px (its own layout px times whatever scales it).
		const sx = s.width / (scroller.offsetWidth || s.width), sy = s.height / (scroller.offsetHeight || s.height);
		const x0 = s.left + scroller.clientLeft * sx, y0 = s.top + scroller.clientTop * sy;
		const left = Math.max(0, (x0 - b.left) / k), top = Math.max(0, (y0 - b.top) / k);
		const right = Math.min(this.cssWidth, (x0 + scroller.clientWidth * sx - b.left) / k);
		const bottom = Math.min(this.cssHeight, (y0 + scroller.clientHeight * sy - b.top) / k);
		if (!(right > left) || !(bottom > top)) return whole;
		return { left, top, width: right - left, height: bottom - top };
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
				pane: this.visibleBandArea(parent),
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
		const cap = await capturePresented(t.client, inkRGB, this.winRef);
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
	 * from what was captured at "start", so an unconstrained pinch out and back
	 * lands exactly where it began. Visibility bounds discard blocked motion.
	 */
	private pinch(
		phase: "start" | "move" | "end",
		ratio: number,
		centroid: { x: number; y: number }
	): void {
		if (this.retiring) return;
		// With the canvas off a two-finger gesture is not a zoom. Every phase is ignored here, so
		// no preview starts, nothing settles and nothing is left pending; the router keeps its own
		// touch bookkeeping (two fingers still count as two) and the page does not move.
		if (!this.canvasMode) return;
		// The router's ratios are relative to ITS gesture start. A preview the
		// watchdog settled in place re-anchors mid-gesture (`rebasePinch`), so
		// from then on they divide by the ratio at which that happened.
		// A lift's give still easing back to the cap: its own frames come through here as moves. A new
		// pinch engaging mid-ease TAKES THE ZOOM OVER from the scale on screen: the ease is dropped, nothing
		// settles, and the gesture starts with the preview still up (the same shape as a pinch that never
		// lifted), so the page does not move under the fingers; its own lift eases past-cap scale back
		// again. A second end while it eases finishes in place.
		if (this.pinchGive && !this.pinchGive.stepping) {
			if (phase === "move") return;
			if (phase === "end") { this.finishPinchGive(); return; }
			const give = this.pinchGive;
			if (give.raf !== 0) { this.winRef.cancelAnimationFrame(give.raf); give.raf = 0; }
			this.pinchGive = null;
		}
		if (phase === "start") { this.pinchRatioBase = 1; this.pinchLastRatio = 1; }
		else if (phase === "move") { this.pinchLastRatio = ratio; ratio = ratio / (this.pinchRatioBase || 1); }
		if (phase === "start") {
			if(this.getNoteViewportState().busy) return;
			// A new gesture anchors on the page where it rests, not on a bounce passing through.
			this.cancelOverscrollBounce();
			this.retirePanSettle("a new pinch");
			this.hideBlankPinchLayers();
			// Invalidate an earlier navigation's pending measure write.
			this.viewportGeneration++;
			this.pinchRefScale = this.pinchScaleNow;
			// The anchor is captured ONCE, here. Every frame of the gesture
			// is then computed from this state, so the view cannot chase the
			// fingers as they drift and rounding cannot accumulate.
			const scroller = this.view.scrollDOM;
			const rect = scroller.getBoundingClientRect();
			// COLUMN-RELATIVE, because host-local is not a fixed frame: under
			// Readable line length `.cm-sizer`'s auto margins re-centre the
			// column as the counter-sized host grows, so the same note point
			// has a different host-local x at every scale. Measured ONCE here;
			// `columnLocalAt` leaves the host's painted origin in
			// `previewHostOrigin`, so this costs the gesture one read and the
			// frames after it none.
			this.previewPanEngaged = false;
			const columnLocal = this.columnLocalAt(this.pinchScaleNow);
			const origin = this.previewHostOrigin;
			const contentTopLocal = this.contentTopLocalAt(this.pinchScaleNow);
			this.pinchStartPan.x = this.viewportPan?.x ?? 0; this.pinchStartPan.y = this.viewportPan?.y ?? 0;
			this.pinchBand.history.length = 0;
			this.pinchBand.lastPan.x = this.pinchStartPan.x; this.pinchBand.lastPan.y = this.pinchStartPan.y;
			this.pinchAnchor = {
				scrollLeft: scroller.scrollLeft,
				scrollTop: scroller.scrollTop,
				offsetX: centroid.x - rect.left,
				offsetY: centroid.y - rect.top,
				focalX: centroid.x,
				focalY: centroid.y,
				// The PANNED origin: `columnLocalAt` and `contentTopLocalAt`
				// both subtract the live pan, so folding it back in here is what
				// makes the pair describe where the note was actually painted
				// when the fingers went down. A gesture that starts on top of a
				// residual pan is then the same arithmetic with no special case.
				hostLeft: (origin?.valid ? origin.left : rect.left) + this.panX(),
				hostTop: (origin?.valid ? origin.top : rect.top) + this.panY(),
				columnLocal,
				contentTopLocal,
				fromScale: this.pinchScaleNow,
				constraint: { clientX: centroid.x, clientY: centroid.y, offsetX: 0, offsetY: 0, geometry: null },
			};
			// Capture the geometry once before coalescing can discard an input.
			// Preparing the layout records its dimensions; it does not paint a zoom.
			if (this.panSizer() && this.prepareViewportLayout()) this.refreshPinchConstraint(columnLocal, contentTopLocal);
			return;
		}
		const anchor = this.pinchAnchor;
		const constraint = anchor?.constraint;
		const targetMoved = !!anchor && Number.isFinite(centroid.x) && Number.isFinite(centroid.y) &&
			(centroid.x !== (constraint?.clientX ?? anchor.targetX ?? anchor.focalX) || centroid.y !== (constraint?.clientY ?? anchor.targetY ?? anchor.focalY));
		// A live frame may reach past the cap by PINCH_GIVE (preview only); the lift below eases it back.
		let next = phase === "end" ? this.pinchPending?.next ?? this.pinchScaleNow : pinchScale(this.pinchRefScale ?? this.pinchScaleNow, ratio, this.zoomFloor, true);
		if (phase === "end" && anchor && this.pinchRefScale !== null && this.pinchGive === null) {
			// The scale the old lift would have settled at: the same clamp, without the give.
			const cap = pinchScale(this.pinchRefScale, next / this.pinchRefScale, this.zoomFloor);
			if (Number.isFinite(cap) && Math.abs(cap - next) > 1e-9) {
				// Painted past the cap: ease the preview back to it over the bounce's half second, then settle there.
				if (this.pinchPreview) { this.startPinchGive(next, cap, centroid); return; }
				// Nothing painted past the cap yet (the lift beat the frame): settle inside the range, as before.
				this.pinchPending = { next: cap };
				next = cap;
			}
		}
		if (anchor && Number.isFinite(centroid.x) && Number.isFinite(centroid.y)) {
			if (constraint) { constraint.clientX = centroid.x; constraint.clientY = centroid.y; }
			else { anchor.targetX = centroid.x; anchor.targetY = centroid.y; }
			this.reducePinchConstraint(next, phase === "end");
		}
		if (phase === "end") {
			if (targetMoved && this.pinchPending === null) this.pinchPending = { next: this.pinchScaleNow };
			// Nothing may still be queued behind the settle: a live frame
			// running after it would write the mid-gesture styles back.
			if (this.pinchRaf !== 0) {
				this.winRef.cancelAnimationFrame(this.pinchRaf);
				this.pinchRaf = 0;
				this.clearDeferredRepaint();
			}
			try {
				// Settle while the gesture-start anchor and scale are still
				// available to the final coalesced move.
				this.flushPinch(true);
			} finally {
				this.restorePinchLayers();
				this.pinchRefScale = null;
				this.pinchAnchor = null;
				this.pinchPreview = false;
				// A preview that ended without its settle (cancelled, refused, or thrown) takes its paper down here.
				if (!this.previewPaperHandoff) this.endPreviewPaper("cancel");
				this.previewPaperHandoff = false;
				// A cancelled preview drops the snap's residual it was carrying.
				if (this.paperPanWritten) this.writePaperPan();
				this.releaseMeasures();
				if (this.viewportStyleDirty) this.scheduleViewportStyleRefresh();
			}
			return;
		}
		if (this.pinchRefScale === null || this.pinchAnchor === null) return;
		if (next === this.pinchScaleNow && this.pinchPending === null && !targetMoved) return;
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

	/** Snapshot only at existing geometry reads, never for each pointer event. */
	private refreshPinchConstraint(columnLocal: number | null, contentTopLocal: number | null): void {
		const constraint = this.pinchAnchor?.constraint, layout = this.viewportLayout, origin = this.previewHostOrigin;
		if (!constraint) return;
		constraint.geometry = null;
		if (!layout || !origin?.valid || !this.panSizer()) return;
		const path = this.filePath(), extent = path ? surfaceExtents.get(path) : { x: 0, y: 0 };
		const width = Math.max(layout.columnBox, extent.x * this.fontZoom);
		const height = Math.max(this.view.contentHeight, extent.y * this.fontZoom);
		const naturalLeft = columnLocal === null ? null : columnLocal + this.view.scrollDOM.scrollLeft * layout.externalScale;
		const naturalTop = contentTopLocal === null ? null : contentTopLocal + this.view.scrollDOM.scrollTop * layout.externalScale;
		if (![origin.left, origin.top, layout.width, layout.paneHeight, layout.gutterScreen, width, height, layout.externalScale].every(Number.isFinite) ||
			layout.width <= 0 || layout.paneHeight <= 0 || layout.gutterScreen < 0 || !validCameraScale(layout.externalScale) || width < 0 || height < 0) return;
		// PREVIEW-TOUCHING (refreshPinchConstraint, called at :5618). `layout.width` (computed style, fractional)
		// rather than `layout.paneWidth` (parent.clientWidth, integer): measured 1397.5 against the scroller's own
		// 1397.48 screen px, and paneWidth - width is 0.5 on all 2333 frames sampled. The gutter is carried
		// through MEASURED and in screen px, so the consumer subtracts it without applying a scale of its own.
		constraint.geometry = { left: origin.left, top: origin.top, paneWidth: layout.width, paneHeight: layout.paneHeight, gutterScreen: layout.gutterScreen,
			// `width` is the page OR the room Infinite Canvas has granted around it, whichever is larger. That is
			// the right quantity for an overlap bound and the wrong one for "does the page fit the pane", so the
			// page's own box travels beside it. See the fit test in `reducePinchConstraint`.
			width, pageWidth: this.pageContentWidth(), height, external: layout.externalScale, x: naturalLeft !== null && Number.isFinite(naturalLeft), naturalLeft,
			y: naturalTop !== null && Number.isFinite(naturalTop), naturalTop };
	}

	/** Consume blocked motion in input order while leaving rendering coalesced.
	 * The measured column/content origin cancels from effective-target bounds.
	 * Offsets are painted pixels, including when a scale change hits a bound.
	 * A new snapshot reconciles the accepted target once; it cannot reconstruct
	 * unobserved intermediate layout changes. Settle receives only the final target.
	 */
	private reducePinchConstraint(next: number, settling: boolean): void {
		const anchor = this.pinchAnchor, constraint = anchor?.constraint;
		if (!anchor || !constraint) return;
		const geometry = constraint.geometry, layout = this.viewportLayout;
		if (geometry && layout && !this.frame.locked && this.scaleGeometryValid !== false &&
			validCameraScale(next) && validCameraScale(next * geometry.external) &&
			validCameraScale(next, layout.width, layout.height) &&
			[layout.width / next, layout.height / next].every(n => Number.isFinite(n) && n >= 0 && n <= MAX_VIEWPORT_LAYOUT)) {
			const axis = (client: number, offset: number, focal: number, host: number, local: number | null,
				origin: number, pane: number, gutter: number, extent: number, measured: boolean, naturalInset?: number | null, inset = false,
				/** The PAGE's own box on this axis. Defaults to `extent`, so an axis that does not distinguish them is unchanged. */
				pageExtent = extent): number => {
				if (local === null || !measured) return offset;
				const q = (focal - host) / anchor.fromScale - local;
				// `gutter` arrives already in screen px (measured at the last settle), so it is subtracted after the
				// pane is scaled and is NOT multiplied by `next` - the defect this replaces was a scale applied to a
				// quantity that had already been measured in the target units.
				const span = pane * geometry.external - gutter;
				const visible = Math.max(0, span - PAN_MIN_VISIBLE_PX);
				const size = extent * next * geometry.external;
				const lower = this.canvasMode && naturalInset != null
					? origin + (q + naturalInset) * next - MAX_VIEWPORT_LAYOUT * next * geometry.external
					: origin + q * next + (size > 0 ? PAN_MIN_VISIBLE_PX - size : -visible);
				// The same raised edge as anchorPanTo's: a column inset that fits may be carried as far right as the pane's edge.
				//
				// ASKED OF THE PAGE, NOT OF THE ROOM BESIDE IT. With Infinite Canvas on, `size` is the granted
				// canvas, it never fits the pane, and the target was pinned to the column's natural inset on
				// every preview frame - which walks away from the fingers by exactly the displacement the scroll
				// was expected to absorb later, and no preview frame writes the scroll. Measured on the focal arm
				// zooming out from 1 to 0.25, Readable line length on: the target went 1243.31, 1086.09, 928.88,
				// 824.06 against a finger that never moved from 1348.12, and froze at 824.06 once the granted
				// extent ran out. `anchorPanTo` then had nothing to do - the note was already at the target - so
				// it wrote no pan at all and the column slid out from under the fingers, 786.09 px by the settle.
				// The SAME column with the setting off keeps target == focal on every frame and holds the point
				// to 0.00 px. The page fits the pane in both; only the blank beside it differs.
				const pageSize = pageExtent * next * geometry.external;
				const fits = inset && naturalInset != null && pageSize > 0 && pageSize <= span + PAN_FIT_SLACK_PX;
				// NO WIDTH TEST, AND NO INSET PIN, WHILE THE FINGERS ARE DOWN. A preview frame's one job is
				// to keep the note under them; bounds belong at the settle, which knows the true width and
				// can ease to it. This clamp WAS the Family C defect at its source: pinned to the column's
				// natural inset, the target walked away from the finger by exactly the displacement the
				// scroll was expected to absorb later - measured 1243.31, 1086.09, 928.88, 824.06 against a
				// finger that never moved from 1348.12 - and no preview frame writes the scroll. A live
				// frame is now held only by what keeps the note visible.
				// AND NO SETTLE CLAMP UNDER INFINITE CANVAS EITHER: there the settle's target IS where
				// the fingers left it, so clamping the target to the column's natural inset moves the page
				// exactly as the preview clamp used to. Measured with this clamp still applied at the
				// settle: the preview held the note to 0 on every frame, then `anchorPanTo` was handed a
				// pan of 907.69 and computed a wanted pan of -0.00, because the note was already sitting
				// on the clamped target - so it dropped the whole hold and the page jumped 907.69 px. The
				// pan was never refused; the target had already moved.
				const upper = origin + q * next + (!settling || this.canvasMode || naturalInset == null ? visible
					: fits ? Math.max(naturalInset * next, span - pageSize) : naturalInset * next);
				const requested = client + offset;
				if (![lower, upper, requested].every(Number.isFinite)) return offset;
				// Natural left/top origins win if a tiny note cannot supply the
				// minimum opposite-edge overlap.
				// Consume rejected movement even when the accepted position is unchanged.
				const accepted = naturalInset == null ? Math.max(lower, Math.min(upper, requested)) : Math.min(upper, Math.max(lower, requested));
				return accepted === requested ? offset : accepted - client;
			};
			constraint.offsetX = axis(constraint.clientX, constraint.offsetX, anchor.focalX, anchor.hostLeft, anchor.columnLocal,
				geometry.left, geometry.paneWidth, geometry.gutterScreen, geometry.width, geometry.x, geometry.naturalLeft, layout.columnInset, geometry.pageWidth);
			constraint.offsetY = axis(constraint.clientY, constraint.offsetY, anchor.focalY, anchor.hostTop, anchor.contentTopLocal,
				geometry.top, geometry.paneHeight, 0, geometry.height, geometry.y, geometry.naturalTop);
		}
		anchor.targetX = constraint.clientX + constraint.offsetX;
		anchor.targetY = constraint.clientY + constraint.offsetY;
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

		if (settle) {
			// SPEND THE PAN INTO THE SCROLL, as far as the surface reaches. The
			// preview holds the note with a translate, which needs no scroll
			// range; the settle would rather carry it as scroll, because scroll
			// is the state every other part of the camera already understands -
			// and because the browser positions a scroll to whole pixels, which
			// is where the mid-gesture fractions go to die. Moving the scroll by
			// dS shifts painted content by -dS * effective, so a pan of P is
			// worth a scroll of -P/effective. Whatever the clamp refuses, and
			// whatever fraction the whole-pixel scroll cannot express, comes
			// straight back as pan in `reanchorPan` - which is what keeps the
			// settled frame standing exactly where the last preview frame stood.
			const effScale = external * next;
			const pan = this.previewPanEngaged ? this.viewportPan : null;
			// WHERE THE PAGE WAS PAINTED, captured here and nowhere later. The settle owes
			// the ease the distance from the last preview frame's painted position to where the page lands,
			// and this is the last point at which that position can be read: measured, the blank reads
			// +15.00 here, 79.00 by `reanchorPan`'s entry with the sizer's transform BYTE-IDENTICAL, so it
			// is the scroll commit in between that moves the edge, not the preview coming off. Capturing
			// while the transform is still on is necessary and not sufficient; it must be before that
			// commit, which is here (measured in a device trace).
			// One forced layout per settle, never per preview frame.
			// INFINITE CANVAS OFF ONLY. The thirteen expanded-right-viewport arms that guard
			// committed ink are all Infinite-Canvas-ON, and the true-travel ease displaces ink on five of
			// them: the ease moves the page by its offset while the ink's baked raster does not follow
			// (`inkPanX()` is `panX() - rasterPan.x * cssScale`). With the setting on, the settle keeps the
			// correction it has always had; making the ink mapping ride the ease there is owed.
			// On Alan's "i want it all in 1.4.20": THE CAPTURE RUNS UNDER THE CANVAS TOO.
			// An earlier rule took this branch canvas-off only because the ease moves the page while the ink's baked
			// raster does not follow it. That left the canvas lift with no true-travel measurement, so the whole
			// correction landed in the commit's own turn.
			this.previewPaintedBlank = this.settleBlank();
			const spendable = !!pan && Number.isFinite(effScale) && effScale > 0;
			let nextLeft = spendable && Number.isFinite(pan.x)
				? Math.max(0, anchor.scrollLeft - pan.x / effScale)
				: anchoredScroll(anchor.scrollLeft, anchor.offsetX, from*external, next*external);
			let nextTop = spendable && Number.isFinite(pan.y)
				? Math.max(0, anchor.scrollTop - pan.y / effScale)
				: anchoredScroll(anchor.scrollTop, anchor.offsetY, from*external, next*external);
			// The accepted target includes the final coalesced input, even if no
			// preview frame has painted. Derive its equivalent native offset from
			// the same zero-scroll snapshot used by the ordered constraint reducer.
			const geometry = anchor.constraint?.geometry;
			const offset = (focal: number, host: number, local: number | null, target: number,
				origin: number, inset: number | null, measured: boolean): number | null => {
				if (!measured || local === null || inset === null) return null;
				const q = (focal - host) / anchor.fromScale - local;
				const result = (origin + (q + inset) * next - target) / effScale;
				return Number.isFinite(result) ? Math.max(0, Math.min(MAX_VIEWPORT_LAYOUT, result)) : null;
			};
			const left = this.canvasMode && geometry ? offset(anchor.focalX, anchor.hostLeft, anchor.columnLocal,
				anchor.targetX ?? anchor.focalX, geometry.left, geometry.naturalLeft, geometry.x) : null;
			const top = this.canvasMode && geometry ? offset(anchor.focalY, anchor.hostTop, anchor.contentTopLocal,
				anchor.targetY ?? anchor.focalY, geometry.top, geometry.naturalTop, geometry.y) : null;
			if (left !== null) nextLeft = left;
			// THE SETTLE DOES NOT SCROLL INTO THE LEFT RESERVE. That scroll is room for ink left of the page, reached by
			// scrolling, so the fingers' place is written into the scroll no further left than the reserve, or than where
			// the scroll already stood if the user had scrolled into it. What the fingers took past that stays a pan, and
			// the settle's own ease takes it back to the page's edge, as a pen lift does.
			const reserveLeft = this.leftReserveHeld > 0 ? this.leftReserveHeld : 0;
			nextLeft = Math.max(nextLeft, Math.min(anchor.scrollLeft, reserveLeft));
			if (top !== null) nextTop = top;
			// This settle, and only this one, closes a preview this gesture painted.
			this.previewSettleOwed = true;
			this.pinchPreview = false;
			this.releaseMeasures();
			this.clearDeferredRepaint();
			// The commit below re-rasters against the settled column, so the
			// preview's translation must come off first or it would be applied
			// twice - once in the pixels, once in the transform.
			this.clearPreviewInkOffset();
			// Keep authority through geometry convergence and the owned scroll
			// request's consumption. New input or navigation retires it first.
			this.panAnchorHold = this.panSizer() ? {
				expansion: this.canvasMode && (left !== null || top !== null) ? {
					left: left ?? this.view.scrollDOM.scrollLeft, top: top ?? this.view.scrollDOM.scrollTop,
				} : null,
				focalX: anchor.focalX, focalY: anchor.focalY, targetX: anchor.targetX, targetY: anchor.targetY,
				hostLeft: anchor.hostLeft, hostTop: anchor.hostTop,
				columnLocal: anchor.columnLocal, contentTopLocal: anchor.contentTopLocal,
				fromScale: anchor.fromScale, scrollTop: anchor.scrollTop, toScale: next,
				generation: this.viewportGeneration + 1, path: this.filePath(), container: this.container,
				left: this.view.scrollDOM.scrollLeft, top: this.view.scrollDOM.scrollTop, ready: false, outcome: "pending", attempts: 0, request: null, issuance: [],
			} : null;
			// The final transaction establishes the range before its scroll writes.
			// Its commit ends the preview; the preview paper stays up until this settle decides below.
			this.previewPaperSettling = true;
			let committed = false;
			try { committed = this.commitCameraScale(next, {left:nextLeft,top:nextTop}, this.panAnchorHold); } finally { this.previewPaperSettling = false; }
			// A REFUSED SETTLE IS AN EXIT PATH. Nothing downstream is going to
			// re-derive this pan, so it must not be left on the children with
			// no gesture tracking it.
			if (!committed) { this.endPreviewPaper("cancel"); this.retirePanSettle("the settle commit was refused"); this.clearViewportPan(); return; }
			this.pinchRasterScale = next;
			this.setViewportScroll(nextLeft,nextTop);
			this.reanchorPan();
			// The preview paper comes down with the settle - unless a bounce is already playing, which happens when this
			// settle's own commit started one: then the element rides it, re-copied here at the settled zoom. A bounce begun
			// later, by the hold's measure or a convergence pass, puts its own element up (startOverscrollBounce), so
			// nothing here has to guess whether one is still coming.
			this.previewPaperHandoff = true;
			if (this.bounceState) this.rebasePreviewPaper();
			else this.endPreviewPaper("settle");
		} else {
			const effective = external * next;
			// The preview's ceiling is the given one; the commit guard (commitCameraScale) keeps the bare cap.
			if (this.frame.locked || this.scaleGeometryValid === false || next > MAX_PINCH_SCALE * PINCH_GIVE ||
				!validCameraScale(next) || !validCameraScale(effective) || !this.prepareViewportLayout()) return;
			const layout = this.viewportLayout!;
			// The scroll target is no longer in this guard because a preview
			// frame no longer writes one: the anchoring is a translate, and its
			// own bound is in `anchorPanTo`. What is left is the counter-sized
			// box, which this frame does write.
			if (!validCameraScale(next, layout.width, layout.height) ||
				![layout.width / next, layout.height / next]
					.every(n => Number.isFinite(n) && n >= 0 && n <= MAX_VIEWPORT_LAYOUT)) return;
			// FIRST frame of this gesture: latch the column against the raster
			// now on screen, while the host still carries the old scale. After
			// applyViewportBox below, that state is gone.
			// The hold goes on BEFORE the capture below and before the box
			// write: a CodeMirror measure between them would move the scroll
			// under the column the capture reads (`holdMeasures`).
			this.holdMeasures();
			if (!this.pinchPreview || this.previewAnchorStale) {
				this.captureRasterColumn(this.pinchScaleNow);
				this.previewAnchorStale = false;
			}
			// A new gesture cancels any ease the previous lift never collected.
			this.previewSettleOwed = false;
			this.previewPaintedBlank = null;
			// The paper leaves the scroller for its preview element on the first frame, before this frame's box write.
			if (!this.pinchPreview) this.beginPreviewPaper();
			this.pinchPreview = true;
			this.pinchScrollAt = performance.now();
			this.pinchScaleNow = next;
			this.cssScale = effective;
			this.scale = effective * this.fontZoom;
			this.router?.cameraTransformChanged();
			// Keep the scroller's physical viewport fixed while magnifying its
			// contents. Reuse the raster; observers cannot allocate it mid-move.
			// The preview paper's own write is deferred to anchorPanTo below, which runs synchronously before
			// paint, in this same task - so this call's old-pan/new-scale write of it would never be seen.
			this.applyViewportBox(next, true);
			// THIS FRAME'S READS ONLY. Both are filled by the single
			// `columnLocalAt` below; clearing them first is what stops
			// `anchorPanTo` anchoring against a rect from an earlier frame on a
			// frame that could not measure (a detached view, a unit fixture).
			if (this.previewHostOrigin) this.previewHostOrigin.valid = false;
			this.previewColumnLocal = null;
			// ...and keep that reused raster on the column, which the box above
			// has just re-centred under Readable line length.
			this.applyPreviewInkOffset(next);
			// THE FOCAL ANCHOR, and it deliberately does not touch the scroll.
			// A preview frame that wrote the scroll could only ever anchor in
			// the directions the surface already extends into - measured on
			// 547fd8b4, that was none of them on zoom-out, because the target
			// was negative on every frame. The translate reaches every
			// direction and costs no layout of its own; the settle above turns
			// as much of it as the surface allows back into scroll.
			const contentTopLocal = this.contentTopLocalAt(next);
			// Deferred, same reason as applyViewportBox above: anchorPanTo below is this frame's one real write of
			// the preview paper, synchronous and before paint. Two more immediate writers ahead of it - this one
			// and applyViewportBox's - were what actually produced three records for one frame's reposition.
			this.measurePreviewPaperBox(true);
			// Reconcile only the latest accepted target against this fresh geometry.
			// Earlier inputs were reduced against their own snapshot, not replayed.
			this.refreshPinchConstraint(this.previewColumnLocal, contentTopLocal);
			this.reducePinchConstraint(next, false);
			this.anchorPanTo(next, anchor, this.previewColumnLocal, contentTopLocal);
			// anchorPanTo has early returns ahead of its own tail (the flush that normally clears this flag); on a
			// frame that takes one, the deferred re-stamp above would otherwise go unpainted - exactly the frame at
			// the previous scale's quotient the re-stamp exists to prevent. No-op when anchorPanTo already wrote.
			if (this.previewPaperBoxDirty) { this.writePaperPan(); this.previewPaperBoxDirty = false; }
		}
		this.refreshPenCursor();
		// Stamp AFTER the writes: the scroll events they queue are the ones
		// the handler above should let pass without a repaint.
		this.pinchScrollAt = performance.now();
	}

	/**
	 * The column's left edge in HOST-LOCAL px, or null when it cannot be read.
	 *
	 * VIEWPORT-RELATIVE IS THE WRONG FRAME, and that was a real defect: both
	 * `contentOriginLeft` and `getBoundingClientRect().left` are measured from
	 * the viewport, so a difference of two of them taken at different scales
	 * keeps a `hostLeft * (1 - k/k0)` term. With a sidebar open (host left ~300)
	 * a zoom to 10% put +270px of drift on EVERY pinch, Readable line length off
	 * included. Subtracting the host's own left first removes that term at the
	 * source; dividing by the scale in force puts the answer in the host's
	 * untransformed units, where it can be compared across scales at all.
	 */
	private columnLocalAt(scale: number): number | null {
		const host = this.view?.dom;
		if (!host || !this.view?.contentDOM || !validCameraScale(scale)) return null;
		// THE HOST RECT FIRST, and kept. The host is the one element in this
		// chain the focal pan is NOT written to, so its painted origin is the
		// unpanned frame everything else is measured against - and reading it
		// before the column scan means a frame where the scan finds nothing
		// still leaves a usable origin for the vertical anchor. A second
		// `getBoundingClientRect` for that would double the per-frame forced
		// layout on the one path `deferPinchRaster` exists to keep cheap.
		const rect = host.getBoundingClientRect();
		const origin = this.previewHostOrigin;
		if (origin) { origin.left = rect.left; origin.top = rect.top; origin.valid = true; }
		const column = contentOriginLeft(this.view.contentDOM);
		if (column === null) return null;
		// UNPANNED. `.cm-content` sits inside `.cm-sizer`, which carries the
		// text half of the focal pan, so a raw read moves with the pan - and
		// the preview ink offset computed from it would then apply the pan a
		// second time on the layer that is already carrying it.
		const local = (column - this.panX() - rect.left) / scale;
		return Number.isFinite(local) ? local : null;
	}

	/**
	 * The content's top in HOST-LOCAL px, against the host origin the last
	 * `columnLocalAt` read. Measured only where the scroll moves under the
	 * anchor - gesture start and settle - never per preview frame, where the
	 * scroll is constant and the term cancels out of the difference entirely.
	 */
	private contentTopLocalAt(scale: number): number | null {
		const content = this.view?.contentDOM, origin = this.previewHostOrigin;
		if (!content || !origin?.valid || !validCameraScale(scale)) return null;
		const local = (content.getBoundingClientRect().top - this.panY() - origin.top) / scale;
		return Number.isFinite(local) ? local : null;
	}

	/** The live focal pan on x, in painted px. Zero when there is none. */
	private panX(): number {
		const bounce = this.bounceOffset;
		return this.restPanX() + (bounce && Number.isFinite(bounce.x) ? bounce.x : 0);
	}
	/** The live focal pan on y, in painted px. Zero when there is none. */
	private panY(): number {
		const bounce = this.bounceOffset;
		return this.restPanY() + (bounce && Number.isFinite(bounce.y) ? bounce.y : 0);
	}
	/** The far end's floor, negative where the page is bigger than its room (room - extent), 0 where it fits. */
	private panFloor(room: number, extent: number): number {
		return Math.min(0, room - extent);
	}
	/** The pan without a playing overscroll bounce: where the page rests. */
	private restPanX(): number {
		const pan = this.viewportPan;
		return pan && Number.isFinite(pan.x) ? pan.x : 0;
	}
	private restPanY(): number {
		const pan = this.viewportPan;
		return pan && Number.isFinite(pan.y) ? pan.y : 0;
	}
	/** Only the pan not already represented by the raster camera moves pixels. */
	private inkPanX(): number { return this.panX() - (this.rasterPan?.x ?? 0) * this.cssScale; }
	private inkPanY(): number { return this.panY() - (this.rasterPan?.y ?? 0) * this.cssScale; }
	/**
	 * WHERE THE INK IS PAINTED, for a pen sample. The ink layer's transform carries one more term
	 * than the pan: the preview offset (column re-centring under a live pinch preview, note px), which the pen's
	 * client point must also be read against or a stroke drawn under a live preview lands off by exactly that
	 * offset (measured: 115 note px, x only, on a paused cap ease). Zero outside a preview, so the settled path
	 * is byte-identical.
	 */
	private inkInputPanX(): number { return this.inkPanX() + this.previewInkOffset * this.cssScale; }
	private inkInputPanY(): number { return this.inkPanY() + (this.previewInkOffsetY || 0) * this.cssScale; }
	private rasterPanNeedsBake(): boolean {
		return !this.frame.locked && this.builder === null && !this.pinchPreview && Number.isFinite(this.cssScale) && this.cssScale > 0 &&
			((this.rasterPan?.x ?? 0) !== this.restPanX() / this.cssScale || (this.rasterPan?.y ?? 0) !== this.restPanY() / this.cssScale);
	}
	private hideBlankPinchLayers(): void {
		this.restorePinchLayers();
		if (this.preparePinchComposite()) return;
		const layers: [HTMLCanvasElement | undefined, boolean | undefined][] = [
			[this.committedCanvas, this.committedBlank], [this.highlightCanvas, this.highlightBlank],
			[this.wetCanvas, this.wet?.provenBlank], [this.highlightWetCanvas, this.highlightWet?.provenBlank],
			[this.tailCanvas, this.tail?.provenBlank], [this.wetTileCanvas, this.wet?.provenBlank],
		];
		for (const [canvas, blank] of layers) if (blank && canvas?.style && canvas.style.visibility !== "hidden") {
			this.pinchHiddenCanvases.set(canvas,canvas.style.visibility);
			canvas.setCssStyles({ visibility: "hidden" });
		}
		if (this.pinchHiddenCanvases.size) this.armPinchLayerRestore();
	}
	/** Reuse an empty wet backing; originals remain intact until preview ends. */
	private preparePinchComposite(): boolean {
		const target = this.wetCanvas;
		if (this.frame.locked || this.builder !== null || !this.wet?.provenBlank || !target?.style || !this.winRef?.getComputedStyle) return false;
		const layers: [HTMLCanvasElement, boolean][] = [
			[this.highlightCanvas, this.highlightBlank], [this.highlightWetCanvas, this.highlightWet.provenBlank],
			[this.committedCanvas, this.committedBlank], [this.tailCanvas, this.tail.provenBlank],
		];
		const occupied = layers.filter(([,blank]) => !blank);
		if (occupied.length < 2) return false;
		// The composite engages: a released wet canvas gets its backing now, before the first preview frame.
		this.allocateWet();
		if (!(target.width > 0)) return false;
		const targetStyle = this.winRef.getComputedStyle(target);
		// A transform is fine as long as every input carries the SAME one: the
		// composite draws backings into a backing, and the five canvases share
		// one box and one transform, whichever the path wrote - the counter-scale
		// below 1.0, or none at all under a zoom-shrunk host (canvasLayerBox).
		// Equality against the target is the check, not equality against a
		// constant, so neither path needs naming here and any canvas placed
		// differently from the target still refuses.
		// Filters, blend modes and clips would change the pixels.
		const supported = (style: CSSStyleDeclaration) => style.filter === "none" &&
			style.mixBlendMode === "normal" && style.clipPath === "none";
		if (!supported(targetStyle) || targetStyle.opacity !== "1" || targetStyle.visibility !== "visible" || targetStyle.display === "none") return false;
		const inputs: { canvas: HTMLCanvasElement; opacity: number }[] = [];
		for (const [canvas] of occupied) {
			if (canvas.width !== target.width || canvas.height !== target.height) return false;
			const style = this.winRef.getComputedStyle(canvas), opacity = Number(style.opacity);
			if (style.visibility !== "visible" || style.display === "none") continue;
			if (!supported(style) || !Number.isFinite(opacity) || opacity < 0 || opacity > 1 ||
				style.width !== targetStyle.width || style.height !== targetStyle.height ||
				style.left !== targetStyle.left || style.top !== targetStyle.top ||
				// Equal PLACEMENT, not only an equal `transform` string: the origin
				// and the individual translate/rotate/scale properties move
				// pixels too and are not part of the computed `transform`.
				style.transform !== targetStyle.transform || style.transformOrigin !== targetStyle.transformOrigin ||
				style.translate !== targetStyle.translate || style.rotate !== targetStyle.rotate || style.scale !== targetStyle.scale) return false;
			inputs.push({canvas, opacity});
		}
		if (inputs.length < 2) return false;
		const ctx = target.getContext("2d");
		if (!ctx) return false;
		this.pinchComposite = true;
		ctx.save();
		try {
			ctx.setTransform(1,0,0,1,0,0);ctx.globalCompositeOperation = "source-over";ctx.filter = "none";
			for (const {canvas,opacity} of inputs) { ctx.globalAlpha = opacity;ctx.drawImage(canvas,0,0); }
		} catch {
			ctx.restore();this.restorePinchLayers();return false;
		}
		ctx.restore();this.wet.notePixelsChanged();
		for (const [canvas] of layers) { this.pinchHiddenCanvases.set(canvas,canvas.style.visibility);canvas.setCssStyles({ visibility: "hidden" }); }
		// The wet tile is blank here (the composite needs a blank wet layer); it hides with the rest.
		if (this.wetTileCanvas?.style) { this.pinchHiddenCanvases.set(this.wetTileCanvas,this.wetTileCanvas.style.visibility);this.wetTileCanvas.setCssStyles({ visibility: "hidden" }); }
		this.armPinchLayerRestore();
		return true;
	}
	private armPinchLayerRestore(): void {
		const restore = () => this.restorePinchLayers();
		this.wet.beforeWrite = restore;this.highlightWet.beforeWrite = restore;this.tail.beforeWrite = restore;
	}
	private restorePinchLayers(): void {
		if (this.wet) this.wet.beforeWrite = undefined;
		if (this.highlightWet) this.highlightWet.beforeWrite = undefined;
		if (this.tail) this.tail.beforeWrite = undefined;
		if (this.pinchComposite) {
			this.pinchComposite = false;
			// A renderer callback may have already begun the next stroke.
			// Remove only the borrowed pixels, preserving its new gesture state.
			const ctx = this.wetCanvas.getContext("2d");
			if (ctx) {
				ctx.save();ctx.setTransform(1,0,0,1,0,0);
				ctx.clearRect(0,0,this.wetCanvas.width,this.wetCanvas.height);ctx.restore();
				this.wet.noteBackingCleared();
			}
		}
		for (const [canvas,visibility] of this.pinchHiddenCanvases ?? []) canvas.style.visibility = visibility;
		this.pinchHiddenCanvases?.clear();
	}
	private markCommittedPaint(tool: InkTool): void {
		this.restorePinchLayers();
		if (tool === "highlighter") this.highlightBlank = false; else this.committedBlank = false;
	}
	/** A painted x read, moved back into the unpanned frame the camera uses. */
	private unpanX(value: number | null): number | null {
		return value === null ? null : value - this.panX();
	}

	/**
	 * `view.documentTop` in the same unpanned frame as `columnLeft`.
	 *
	 * CodeMirror computes it as `contentDOM.getBoundingClientRect().top +
	 * paddingTop`, and `.cm-content` rides inside `.cm-sizer`, which carries the
	 * text half of the focal pan. The two callers below pair it with
	 * `columnLeft`, which is de-panned, to build ONE surface origin: a panned
	 * top against an unpanned left is not a frame at all, it is the pan sitting
	 * on one axis of a pair that is then differenced against scroll numbers the
	 * pan never touched. Both consumers - Fit's reachable-region clip and the
	 * extent grow - produce absolute scroll targets, and a scroll target is
	 * spent through `commitCameraScale`, which CLEARS the pan on its way: the
	 * frame those targets have to be right in is the one with no pan in it.
	 */
	private documentTopUnpanned(): number {
		// anchorTop, not `view.documentTop`: CodeMirror scales the padding it adds by the scale it last MEASURED, and it
		// only measures content with a size. An empty note's content box is 0 wide, so there the padding stayed at its
		// 100 percent value and every settle off 100 percent planned the paper's phase (and Fit's reachable edge)
		// padding x (1/k - 1) layout px off the text. anchorTop is what the ink camera already uses.
		return anchorTop(this.view, this.contentStyle?.paddingTop, this.cssScale) - this.panY();
	}

	/** Latch where the column was when the raster now on screen was drawn. */
	private captureRasterColumn(scale: number): void {
		this.rasterColumnLocal = this.columnLocalAt(scale);
		this.rasterColumnScroll = this.view?.scrollDOM?.scrollLeft ?? 0;
	}

	/**
	 * Keep the REUSED preview raster sitting on the text column.
	 *
	 * A pinch preview deliberately does not re-rasterise: it scales the raster
	 * the note already has (see the scroll handler's suppression comment). That
	 * is correct only while the column's position is a pure scaling of where it
	 * was - true when the column starts at the host's origin, false when Readable
	 * line length auto-centres `.cm-sizer` inside it.
	 *
	 * `applyViewportBox` re-lays the host out at `layout.width / k`, so the
	 * centring margin is recomputed every preview frame and the column lands at
	 * `(W - lineWidth*k) / 2`, while the raster merely scales about the origin.
	 * The gap is `W * (k/k0 - 1) / 2`: zero at k = k0, negative zooming out,
	 * growing the further the gesture goes, healed at pinch end because
	 * `commitCameraScale` re-rasters against the settled column. Measured in the
	 * render harness before this existed: at W 1398, k0 1 -> k 0.1 the ink sat
	 * 629.125 px LEFT of the column - W * 0.45 to three decimals - and healed to
	 * exactly 0 at settle. Alan, Orion, Readable line length ON: "the ink moves
	 * when zooming out".
	 *
	 * BOTH TERMS ARE HOST-LOCAL AND CAPTURED ATOMICALLY. The first cut compared
	 * `lastSyncContentLeft` against `pinchRasterScale`, two fields written by
	 * different methods at different moments: hold a pinch still past
	 * `PINCH_SCROLL_QUIET_MS` and `deferPinchRaster` goes false, any of six
	 * `syncCamera` callers rewrites the column at the CURRENT scale while the
	 * stored scale still describes the raster, and the offset is then wrong by
	 * the whole ratio. `rasterColumnLocal` is latched in one statement from one
	 * DOM state, at the moment the raster it describes was drawn, and re-latched
	 * whenever a repaint actually redraws that raster.
	 *
	 * READABLE LINE LENGTH OFF IS UNTOUCHED, by construction rather than by a
	 * flag: the column is then a fixed offset inside the host (zero, or the
	 * scrollbar gutter), so the local value is scale-invariant, the difference is
	 * exactly 0 and no transform is written. The same holds for any constant
	 * local inset.
	 *
	 * COLUMN NOT FOUND leaves the offset alone: a frame where the scan cannot see
	 * the column has no better answer than the one already on screen.
	 *
	 * WHAT A PREVIEW FRAME COSTS, counted rather than estimated. ONE forced
	 * synchronous layout: this reads after `applyViewportBox` has written, and it
	 * must, because the column it needs is the post-box one. Rect reads are 12 in
	 * the ordinary case, 24 bounded, 36 if phase B runs (ContentOrigin.ts:59, :72,
	 * :244-247). A latch frame does 2 reads and still only 1 forced layout. The
	 * host rect is NOT cached across the gesture: a pan moves the host.
	 *
	 * The deferred-repaint latch beside this costs at most ONE timer per
	 * PINCH_SCROLL_QUIET_MS while a repaint is being held - about 8 wake-ups a
	 * second, and zero when nothing is pending - against the 60/s a re-armed
	 * requestAnimationFrame would have cost for the whole gesture.
	 *
	 * This spends on exactly the path `deferPinchRaster` exists to keep cheap, so
	 * it is worth saying plainly that it is a layout read per gesture frame and
	 * nothing outside a preview. Computing the column from the layout box instead
	 * of measuring it would remove the read entirely; that is a post-1.4.19
	 * option and should be gated on a profile, not on this comment.
	 */
	private applyPreviewInkOffset(next: number): void {
		const band = this.inkLayer;
		// `pinch` is driven in unit fixtures against partial objects that carry
		// the overlay's fields without a real DOM - the pinch-end unit fixtures build
		// a container with no `style` and a view with no `contentDOM`. Nothing
		// here is worth a throw: with nothing to measure or move, leaving the
		// raster where it is IS the right answer.
		if (!band || !band.style) return;
		// ONE read per preview frame, and it happens before the early returns
		// below because the focal anchor needs its by-product (the host origin)
		// on exactly the frames this runs on.
		const localNow = this.columnLocalAt(next);
		this.previewColumnLocal = localNow;
		const anchor = this.rasterColumnLocal;
		if (anchor === null || localNow === null) return;
		// THE COLUMN'S MOVE IN CONTENT COORDINATES, not in host-local ones.
		// `columnLocalAt` reads host-local px, which fall as the scroller
		// scrolls right; the layer this offset is written to sits inside the
		// scroller and has already moved by exactly that scroll. Measured on
		// the pixel arm (2026-09-13): with Readable line length on, a
		// zoom-out preview that moved scrollLeft 93 -> 52 -> 0 wrote +41 and
		// +52 layer px here and the committed ink sat that far right of its
		// text until the next repaint. Adding the scroll change since the latch
		// leaves only the centring margin's own move, which is what the raster
		// needs to follow; the zoom-in compensation above 1.0 keeps its value
		// because there the column really moves.
		//
		// UNITS. `columnLocalAt` divides the client difference by the OWNED
		// scale only, so its px still carry the host's external scale, while
		// the layer this offset is written to counts layout px (the same way
		// `viewportLayout.columnLocal` divides by the external scale before it
		// adds `scrollLeft`). So the column term is divided by that scale and
		// the scroll delta, already layout px, is added as it is. Measured at
		// external scale 0.8 (2026-09-13): with the factor on the scroll term
		// instead, a genuine column move on zoom-in to 1.6 was applied at 0.8
		// of its size and the ink sat 34 device px off its text; scroll-only
		// frames cancel in either form, which is why the zoom-out cells could
		// not tell the two apart. At external scale 1 the two are identical.
		const scrollNow = this.view?.scrollDOM?.scrollLeft ?? this.rasterColumnScroll;
		const external = this.viewportLayout?.externalScale ?? (Number.isFinite(this.cssScale) && this.pinchScaleNow > 0 ? this.cssScale / this.pinchScaleNow : 1);
		const e = Number.isFinite(external) && external > 0 ? external : 1;
		const dx = (localNow - anchor) / e + (scrollNow - this.rasterColumnScroll);
		if (!Number.isFinite(dx)) return;
		this.previewInkOffset = dx;
		// Host-local units already: the band lives inside the scaled host, so no
		// second division by `k` belongs here.
		this.writeInkLayerTransform();
	}

	/**
	 * THE ONE WRITER for the ink layer's transform, and it must stay the only
	 * one.
	 *
	 * Two different corrections land on this element and neither may clobber the
	 * other: the column offset that keeps a REUSED preview raster on a column
	 * the centring margin has moved, and the focal pan that holds the note under
	 * the fingers. Two methods each assigning `style.transform` is not two
	 * corrections, it is whichever ran last - which is how the first attempt at
	 * this lane lost the column offset on every frame the pan moved. Summing
	 * them in one place is the whole fix.
	 *
	 * UNITS. The offset is already in the layer's own px (`columnLocalAt`
	 * divided the scale out, and the layer rides inside the scaled host). The
	 * pan is in PAINTED px, because that is the frame a finger is in, so it is
	 * divided by the painted scale on the way in.
	 */
	private writeInkLayerTransform(): void {
		const layer = this.inkLayer;
		if (!layer?.style) return;
		const k = this.cssScale;
		const s = Number.isFinite(k) && k > 0 ? 1 / k : 0;
		const x = this.previewInkOffset + this.panX() * s - (this.rasterPan?.x ?? 0);
		const y = (this.previewInkOffsetY || 0) + this.panY() * s - (this.rasterPan?.y ?? 0);
		layer.style.transform = x === 0 && y === 0 ? "" : `translate(${x}px,${y}px)`;
		this.releaseWetIfIdle();
	}

	/**
	 * The pan goes on the SCROLLER'S CHILDREN, never on the host and never on
	 * the scroller.
	 *
	 * The host contains the scroller, so panning the host moves the scroller's
	 * own box off the pane - and a pointer at a fixed client point then lands
	 * outside the hit surface entirely. That is the low-zoom input-death class,
	 * where the pen stops reaching the note at all; measured on the first
	 * attempt as "input outside scroller 710,350" at 0.1 zoom. Translating the
	 * children instead leaves the scroller exactly where it was, so it stays the
	 * hit surface at every scale.
	 *
	 * BOTH children, at the same level, or the cure is worse than the disease.
	 * `.cm-sizer` carries the text; the ink rides on the layer inside the band.
	 * Panning one without the other would slide ink across the words, which is
	 * the defect this whole lane exists to fix. Moving them together is also why
	 * this is invisible to the written-ink drift guard: that measures the ink
	 * canvas RELATIVE TO a `.cm-line`, and a shared translate cancels out of a
	 * difference.
	 *
	 * THE BAND ITSELF IS NOT TOUCHED, and that is load-bearing rather than
	 * incidental: `syncCamera` derives the camera from
	 * `this.container.getBoundingClientRect()`, so a pan on the band is absorbed
	 * into the camera and then applied a second time by the transform. Measured
	 * with the band carrying it: the focal drift went from 2.25/3.14 to
	 * 11.86/16.02/4.11 against a 2px threshold.
	 */
	private writeViewportPan(deferPaper = false): void {
		const k = this.cssScale;
		const s = Number.isFinite(k) && k > 0 ? 1 / k : 0;
		const x = this.panX() * s, y = this.panY() * s;
		const sizer = this.panSizer();
		if (sizer?.style) sizer.style.transform = x === 0 && y === 0 ? "" : `translate(${x}px,${y}px)`;
		// The sizer and ink layer above are stamped either way - a caller that defers the paper still needs the
		// scale it just changed reflected on those. Only the preview paper's own write can wait for anchorPanTo,
		// which runs synchronously before paint on the one caller that passes true (the live pinch frame).
		if (deferPaper) this.previewPaperBoxDirty = true;
		else this.writePaperPan();
		this.writeInkLayerTransform();
	}

	/** The title rewrap the paper has taken during this preview, layout px; spent where the origin is re-measured. */
	private paperRewrapY = 0;
	/** How far the text column has re-centred since the gesture began, painted px; spent where the origin is re-measured. */
	private paperColumnDrift = 0;
	/** The pan values last written on the scroller, so a frame that changes nothing writes nothing. */
	private paperPanWritten: { x: string; y: string } | null = null;
	/**
	 * How far the at-rest plan put the paper off the text to land it on the device px grid, layout px, per axis: the
	 * written phase less the text's own. The snap is an at-rest guarantee; a preview carries it back out, so the paper
	 * tracks the text through the gesture and lands on the new grid at the settle.
	 */
	private paperSnapResidual = { x: 0, y: 0 };
	/**
	 * THE PREVIEW PAPER: while a preview lives (and through the bounce its settle starts), the paper is this element under
	 * the scroller, moved by a transform, instead of the scroller's own background moved through its stops. A transform is
	 * composited; a stop moved by a pan re-rasters the whole background on every frame of a two-finger drag. Null at rest.
	 */
	private previewPaperEl: HTMLElement | null = null;
	/** The pitch the element was copied at, layout px: its fold and its margin. */
	private previewPaperPitch = 0;
	/** The phases the element's copy carries, layout px (0 where the host's are not px): what its rounding lands on the grid. */
	private previewPaperPhaseX = 0;
	private previewPaperPhaseY = 0;
	/** The scroller's padding box inside the host, layout px, before the margin: where the element's box is measured from. */
	private previewPaperBox: { top: number; right: number; bottom: number; left: number } | null = null;
	/** The device px per layout px the element was last placed at: a zoom frame with no pan still re-places it. */
	private previewPaperKd = 0;
	/**
	 * `applyViewportBox`'s own scale-change repaint of the preview paper, recorded but not yet written: on the live
	 * preview frame it defers to `anchorPanTo`, which runs synchronously afterward, before paint, and is this
	 * frame's one real write of the element - so the deferred one paints nothing extra, it just cleared the guard.
	 */
	private previewPaperBoxDirty = false;
	/** The inset and transform last written on the element, so a frame that changes neither writes nothing. */
	private previewPaperInset = "";
	private previewPaperTransform = "";
	/** The scroll the element's offset was last derived at, layout px; NaN until one is read. */
	private paperScrollLeft = Number.NaN;
	private paperScrollTop = Number.NaN;
	/** Set by the settle once it has taken the preview paper down or handed it to a bounce, so the gesture's end does not do it again. */
	private previewPaperHandoff = false;
	/** True only across the settle's own commit, which ends a preview without taking the preview paper down. */
	private previewPaperSettling = false;
	/** The path that last took the preview paper down, and how many times it has been put up: read by fixtures only. */
	private previewPaperEnded: PreviewPaperEnd | null = null;
	private previewPaperSwaps = 0;

	/**
	 * GRID PAPER'S SECOND BOX. Under grid paper the scroller paints the horizontal rules and this element,
	 * its first child, paints the vertical ones - one repeating gradient each, because two on one large box lose
	 * the first layer's rules as the box grows. Null under every other paper, and under none.
	 */
	private paperGridBox: HTMLElement | null = null;
	/**
	 * What tells this overlay the paper CHANGED. Nothing did before: the paper is the stylesheet's, and a class or a
	 * note's attribute needed no code to take effect. The box does, so two narrow watches - the body's own class (the
	 * global paper, the cycle command) and the `data-handwriting-paper` attribute anywhere (a note's own choice, which
	 * NotePaper writes on the leaf container). Deliberately NOT a class watch with `subtree`, which would fire on
	 * every `cm-activeLine` toggle - a callback per cursor move.
	 */
	private paperKindWatch: MutationObserver[] = [];
	private paperKindFrame: number | null = null;
	/** The box's written size, `w,h` in layout px, and its written pan: neither is written again unchanged. */
	private paperGridBoxSize: string | null = null;
	private paperGridBoxPanX = "";

	/**
	 * THE PAPER MOVES AS ONE WITH THE TEXT. The paper is the scroller's own
	 * background, and the scroller is the one element the pan may not move, so
	 * the translate `.cm-sizer` was just given is handed to the background as two
	 * registered, non-inherited properties the gradient stops (lines, grid) and
	 * the dot tile position (dots) read. Same units as the sizer's translate: the
	 * scroller's layout px, inside the zoom host. Two things move the text against
	 * the scroller during a preview that the pan does not carry, and the paper
	 * takes both: a title rewrap above the content (y) and the column re-centring
	 * under Readable line length (x). Two style writes when the values change,
	 * none when they do not, no read; zero removes them.
	 */
	private writePaperPan(): void {
		const scroller = this.view?.scrollDOM;
		if (!scroller?.style) return;
		const k = this.cssScale;
		const s = Number.isFinite(k) && k > 0 ? 1 / k : 0;
		const carry = this.pinchPreview ? this.paperSnapResidual : null;
		const x = (this.panX() + this.paperColumnDrift) * s - (carry?.x ?? 0), y = this.panY() * s + this.paperRewrapY - (carry?.y ?? 0);
		// While the preview paper is up it carries the pan, and the scroller's pan properties stay off.
		if (this.previewPaperEl) { this.movePreviewPaper(x, y); return; }
		// Folded by the pitch this overlay planned; a pitch the host owns is not known here, so its values go unfolded.
		const pitch = Number.parseFloat(this.paperWritten?.get("--handwriting-paper-pitch") ?? "");
		const ax = x === 0 ? "" : `${foldIntoPitch(x, pitch)}px`, ay = y === 0 ? "" : `${foldIntoPitch(y, pitch)}px`;
		const last = this.paperPanWritten;
		if (last ? last.x === ax && last.y === ay : !ax && !ay) return;
		if (ax) scroller.style.setProperty("--handwriting-paper-pan-x", ax); else scroller.style.removeProperty("--handwriting-paper-pan-x");
		if (ay) scroller.style.setProperty("--handwriting-paper-pan-y", ay); else scroller.style.removeProperty("--handwriting-paper-pan-y");
		this.paperPanWritten = ax || ay ? { x: ax, y: ay } : null;
		// The grid's vertical box reads its own copy - the property is registered `inherits: false`, so the
		// scroller's does not reach a child. Same value, same call, so both axes move on the same frame.
		this.writeGridBoxPan(ax);
	}

	/**
	 * PUT THE PREVIEW PAPER UP, on a preview's first frame: an element about a pitch (see movePreviewPaper) beyond the scroller's
	 * padding box on every side, under the scroller in the host, carrying the scroller's own resolved background.
	 *
	 * COPIED, NOT RE-DERIVED. The scroller's computed image, size, position, repeat and colour are what every stylesheet
	 * rule (global paper, a note's override, a theme) resolved to, so `none` shows nothing and a note's own tile survives
	 * a global one. The pan properties come off FIRST: the computed stops carry phase plus pan, and the element's transform
	 * carries the pan, so a copy taken with them on would move the paper by a standing pan twice.
	 *
	 * NOT PUT UP, and the scroller's own route carries the note: no paper; a layer that is not a gradient attached `local`
	 * (not the paper's); a pitch that is not a px length (the property is not registered, so a theme's `2.5rem` computes
	 * to the text "2.5rem", which is not a pitch); a scroller that is not left-to-right, whose scroll origin is not the
	 * one the offset below is derived for.
	 *
	 * One forced style read per gesture; the preview frame before it has already flushed layout.
	 */
	private beginPreviewPaper(): void {
		const host = this.view?.dom, scroller = this.view?.scrollDOM;
		if (this.previewPaperEl || !host?.style || !scroller?.style || scroller.parentElement !== host || !this.winRef?.getComputedStyle) return;
		// Live: every read below resolves the style as it stands at that read.
		const cs = this.winRef.getComputedStyle(scroller);
		const pitch = previewPaperPitch(cs);
		if (pitch === null || cs.direction !== "ltr" || !previewPaperCopyable(cs, pitch)) return;
		// Under grid the vertical rules live on their own box inside the scroller, so the copy takes that
		// layer too - the preview paints both axes on one pane-sized box, which is the shape measured clean.
		const grid = this.gridBoxPaperStyle(pitch);
		if (this.paperGridBox && !grid) return;
		this.clearScrollerPan(scroller);
		// OFF THE PAGE, and that is the whole point of the global helper here rather than `host.createDiv`: the
		// element takes its nine background properties below, and on an element already in the page each one is a
		// style write inside the preview frame - PaperZoomHost ZERO WRITES reads 11 that way against its cap of 2.
		// `insertBefore` adopts it into the host's document at the end of this call, as the native form did.
		const el = createDiv({ cls: "handwriting-paper-preview" });
		copyPreviewPaperBackground(el, cs, grid);
		this.previewPaperEl = el;
		this.previewPaperPitch = pitch;
		this.previewPaperPhaseX = previewPaperPhase(cs, "--handwriting-paper-phase-x");
		this.previewPaperPhaseY = previewPaperPhase(cs, "--handwriting-paper-phase");
		this.previewPaperInset = "";
		this.previewPaperTransform = "";
		this.paperScrollLeft = scroller.scrollLeft;
		this.paperScrollTop = scroller.scrollTop;
		this.measurePreviewPaperBox();
		host.insertBefore(el, scroller);
		scroller.classList.add("handwriting-paper-previewing");
		this.previewPaperSwaps++;
		this.writePaperPan();
	}

	/** The grid box's own horizontal pan, written only when it changes; "" removes it. */
	private writeGridBoxPan(ax: string): void {
		const box = this.paperGridBox;
		if (!box?.style || ax === this.paperGridBoxPanX) return;
		if (ax) box.style.setProperty("--handwriting-paper-pan-x", ax); else box.style.removeProperty("--handwriting-paper-pan-x");
		this.paperGridBoxPanX = ax;
	}

	/** One frame's worth of the watch's work, however many mutations arrived. */
	private watchPaperKind(): void {
		const doc = this.view?.dom?.ownerDocument;
		if (this.paperKindWatch.length || !doc?.body || typeof MutationObserver === "undefined") return;
		// IN THE MUTATION'S OWN TASK, not on the next frame: the scroller gives up its vertical layer under the class
		// this call adds, so a frame between the paper changing and the box arriving would paint the whole grid on the
		// scroller and then split it - a visible double step, and a state the paper cells read as the wrong image. A
		// paper change is rare (a command, the picker, a note switch), so the style read it costs is not a hot path.
		const queue = (): void => { this.syncGridPaperBox(); };
		const body = new MutationObserver(queue);
		body.observe(doc.body, { attributes: true, attributeFilter: ["class"] });
		const note = new MutationObserver(queue);
		note.observe(doc.body, { attributes: true, attributeFilter: ["data-handwriting-paper"], subtree: true });
		this.paperKindWatch = [body, note];
	}

	/**
	 * The content box changed size: every Enter, wrap and line-height fix lands here.
	 *
	 * A full repaint clears and redraws all visible ink and rebuilds the index, so it is kept for a resize that
	 * actually moved the camera, the column or the origin; a still camera takes the cheap frame (bands and the
	 * extent pass only). The grid's vertical box is sized from the content, and nothing else on this path re-sizes
	 * it when no extent spacer moves (Infinite Canvas off, no ink): the rules stopped partway down a grown note, or
	 * left blank scroll room under a shortened one. The box keeps its size unless it changed, so this is a read.
	 */
	private onContentResize(): void {
		if (!this.container || this.frame.locked) return;
		const left = this.lastSyncContentLeft, top = this.lastSyncDocumentTop, scale = this.scale;
		this.syncCamera();
		const moved =
			Math.abs(this.lastSyncContentLeft - left) > CONTENT_ORIGIN_EPSILON ||
			Math.abs(this.lastSyncDocumentTop - top) > CONTENT_ORIGIN_EPSILON ||
			this.scale !== scale;
		if (this.paperGridBox) this.syncGridPaperBox();
		this.scheduleRepaint(moved ? "content-resize" : "scroll");
	}

	/**
	 * THE GRID'S VERTICAL BOX, made, sized or taken away. Grid paper only: the stylesheet states
	 * `--handwriting-paper-grid` on the scroller for every paper kind, so a note's own choice beats a global one by
	 * the ordinary cascade and this reads the answer rather than re-deriving it.
	 *
	 * THE SIZE IS THE CONTENT AND THE GRANTED EXTENT, never `scrollWidth` or `scrollHeight`: the box is inside the
	 * scroller, so a size taken from the scroll range would feed the range it was taken from and grow on every pass.
	 * The sizer's own box is the content; the extent spacer's position is what this overlay has granted beyond it;
	 * the client box covers a note shorter than its pane. Nothing here can make the scroller scroll further than the
	 * spacer already does.
	 *
	 * NOT ON A PREVIEW FRAME, and nothing calls it on one: while a preview lives the paper is the preview element,
	 * which carries both axes itself, and this box is quiet under the previewing class. So a pinch adds no read and
	 * no write here. A scroll adds none either: scrolling changes neither the content nor the grant.
	 */
	private syncGridPaperBox(): void {
		const scroller = this.view?.scrollDOM;
		if (!scroller?.isConnected) { this.removeGridPaperBox(); return; }
		if (this.pinchPreview || !this.winRef?.getComputedStyle) return;
		this.watchPaperKind();
		const wanted = this.winRef.getComputedStyle(scroller).getPropertyValue("--handwriting-paper-grid").trim() === "1";
		if (!wanted) { this.removeGridPaperBox(); return; }
		if (!this.paperGridBox) {
			// The same patch the extent spacer makes, for the same reason: an absolutely placed child of a static
			// scroller would take its place from the pane instead.
			if (this.winRef.getComputedStyle(scroller).position === "static") {
				scroller.setCssStyles({ position: "relative" });
				this.scrollPositionPatched = true;
			}
			// `createDiv` appends, so the box is moved to the front in the same task: it is the scroller's FIRST child
			// on every frame that paints, and absolute from its first, so the append itself adds nothing to the flow.
			const box = scroller.createDiv({ cls: "handwriting-paper-grid-column" });
			scroller.insertBefore(box, scroller.firstChild);
			// FAIL SAFE: the stylesheet paints both axes on the scroller by default, because the box is
			// this overlay's and a grid scroller without one would otherwise show lined paper. The scroller gives up its
			// vertical layer only under this class, added in the SAME call that puts the box in the page and removed in
			// the same call that takes it out, so no frame paints the axis twice and none paints it not at all.
			scroller.classList.add("handwriting-paper-grid-split");
			this.paperGridBox = box;
			this.paperGridBoxSize = null;
			this.paperGridBoxPanX = "";
			const pan = this.paperPanWritten;
			if (pan?.x) this.writeGridBoxPan(pan.x);
		}
		const sizer = scroller.firstElementChild === this.paperGridBox ? this.paperGridBox.nextElementSibling : scroller.firstElementChild;
		const contentW = sizer instanceof HTMLElement ? sizer.offsetLeft + sizer.offsetWidth : 0;
		const contentH = sizer instanceof HTMLElement ? sizer.offsetTop + sizer.offsetHeight : 0;
		const grantedW = Number.isFinite(this.spacerLeft) ? this.spacerLeft + 1 : 0;
		const grantedH = Number.isFinite(this.spacerTop) ? this.spacerTop + 1 : 0;
		const w = Math.max(scroller.clientWidth, contentW, grantedW);
		const h = Math.max(scroller.clientHeight, contentH, grantedH);
		const size = `${w},${h}`;
		if (size === this.paperGridBoxSize) return;
		this.paperGridBoxSize = size;
		this.paperGridBox.setCssStyles({ width: `${w}px`, height: `${h}px` });
	}

	/** The box goes: paper switched away from grid, a note switch, a release. Its own state goes with it. */
	private removeGridPaperBox(): void {
		if (!this.paperGridBox) return;
		// The class goes first and in this same task: the scroller is painting one axis while the box paints the
		// other, so the box may not leave before the scroller has taken its own layer back.
		this.paperGridBox.parentElement?.classList.remove("handwriting-paper-grid-split");
		this.paperGridBox.remove();
		this.paperGridBox = null;
		this.paperGridBoxSize = null;
		this.paperGridBoxPanX = "";
	}

	/** The release: the watch and its owed frame go with the box. */
	private stopPaperKindWatch(): void {
		for (const observer of this.paperKindWatch) observer.disconnect();
		this.paperKindWatch = [];
		if (this.paperKindFrame !== null) { this.winRef?.cancelAnimationFrame?.(this.paperKindFrame); this.paperKindFrame = null; }
	}

	/** The scroller's pan properties off, each only if it is set: a removal of nothing is still a style call. */
	private clearScrollerPan(scroller: HTMLElement): void {
		if (scroller.style.getPropertyValue("--handwriting-paper-pan-x")) scroller.style.removeProperty("--handwriting-paper-pan-x");
		if (scroller.style.getPropertyValue("--handwriting-paper-pan-y")) scroller.style.removeProperty("--handwriting-paper-pan-y");
		this.paperPanWritten = null;
		// The grid's vertical box carries its own copy. Left set, the next
		// writePaperPan at zero pan finds nothing to do and the vertical rules
		// keep the old offset while the horizontal ones come back.
		this.writeGridBoxPan("");
	}

	/**
	 * The grid box's own resolved background, for a preview copy, or null when there is no box or its layer is
	 * not the paper this overlay planned. The previewing class is not on yet at this read (begin) or is taken off
	 * around it (rebase), exactly as the scroller's own copy is taken.
	 */
	private gridBoxPaperStyle(pitch: number): PreviewPaperSource | null {
		const box = this.paperGridBox;
		if (!box?.isConnected || !this.winRef?.getComputedStyle) return null;
		const cs = this.winRef.getComputedStyle(box);
		return previewPaperCopyable({ backgroundImage: cs.backgroundImage, backgroundAttachment: "local", backgroundSize: cs.backgroundSize }, pitch) ? cs : null;
	}

	/**
	 * The scroller's padding box inside the host, as insets, layout px. Insets rather than a size: the counter-sized host
	 * of a zoom preview, and a pane resize, move the host's edges and the scroller's together, and the element follows
	 * both without a write. Re-read on each preview frame where the column is read, so a change in what sits between the
	 * host and the scroller is followed too; the frame has already flushed its layout, so the reads force none.
	 */
	private measurePreviewPaperBox(deferPaper = false): void {
		const host = this.view?.dom, scroller = this.view?.scrollDOM;
		if (!this.previewPaperEl || !host || !scroller) return;
		const top = scroller.offsetTop + scroller.clientTop, left = scroller.offsetLeft + scroller.clientLeft;
		const right = host.clientWidth - (left + scroller.clientWidth), bottom = host.clientHeight - (top + scroller.clientHeight);
		const box = this.previewPaperBox, kd = this.cssScale * (this.dpr || 1);
		if (box && box.top === top && box.right === right && box.bottom === bottom && box.left === left && kd === this.previewPaperKd) return;
		this.previewPaperBox = { top, right, bottom, left };
		this.previewPaperKd = kd;
		if (deferPaper) { this.previewPaperBoxDirty = true; return; }
		this.writePaperPan();
	}

	/**
	 * THE PREVIEW PAPER'S PLACE for the pan `x`, `y` (layout px, as the scroller's pan properties would take it).
	 *
	 * The scroller's background is attached `local`: a stop at `phase + n x pitch` sits at `pan - scroll` in the
	 * scroller's box. The element's copy draws the stop at `phase + n x pitch` from its own edge, which is `margin` above
	 * and left of that box, so its offset is `pan - scroll + margin`, folded into one pitch (a repeating pattern moved by a
	 * pitch is the same pattern) and then placed on the device px grid.
	 *
	 * FOLD FIRST, THEN ROUND. A composited layer at a fractional device px is resampled, and a one-device-px rule becomes
	 * two half rows. Where the pitch is not a whole number of device px (28 layout px at 30 percent and DPR 2 is 16.8), a
	 * fold after the rounding would take a fractional device px back off.
	 *
	 * WHAT IS ROUNDED IS WHERE THE RULES LAND, not the offset alone: the copy's phase was put on the device px grid of the
	 * zoom it was planned at, and mid-zoom it is off this zoom's grid by a fraction, so the offset takes that fraction back
	 * out. The rules then land on whole device px (hard) at most half a device px from the text, the nearest whole px to
	 * the text's own place, which is where the settle's snap puts them: the lift moves them by nothing. On a drag the
	 * fraction is 0 and the offset itself is whole.
	 *
	 * The margin is a pitch rounded up to whole device px, plus one, so a rounded offset never uncovers the edge.
	 */
	private movePreviewPaper(x: number, y: number): void {
		const el = this.previewPaperEl, box = this.previewPaperBox, pitch = this.previewPaperPitch;
		const kd = this.cssScale * (this.dpr || 1);
		if (!el || !box || !(pitch > 0) || !(Number.isFinite(kd) && kd > 0)) return;
		const margin = (Math.ceil(pitch * kd - 1e-6) + 1) / kd;
		const inset = `${box.top - margin}px ${box.right - margin}px ${box.bottom - margin}px ${box.left - margin}px`;
		if (inset !== this.previewPaperInset) { el.style.inset = inset; this.previewPaperInset = inset; }
		const scroller = this.view?.scrollDOM;
		if (!Number.isFinite(this.paperScrollLeft) || !Number.isFinite(this.paperScrollTop)) { this.paperScrollLeft = scroller?.scrollLeft ?? 0; this.paperScrollTop = scroller?.scrollTop ?? 0; }
		const fx = fractionOf(this.previewPaperPhaseX * kd), fy = fractionOf(this.previewPaperPhaseY * kd);
		const tx = (Math.round(foldIntoPitch(x - this.paperScrollLeft + margin, pitch) * kd + fx) - fx) / kd;
		const ty = (Math.round(foldIntoPitch(y - this.paperScrollTop + margin, pitch) * kd + fy) - fy) / kd;
		const transform = `translate(${tx}px, ${ty}px)`;
		if (transform !== this.previewPaperTransform) { el.style.transform = transform; this.previewPaperTransform = transform; }
	}

	/**
	 * A SETTLE THAT STARTS A BOUNCE keeps the preview paper up, but the settle has re-planned the paper at the new zoom
	 * (a rule floored to a device px, a phase on the new device px grid) and spent the pan into the scroll. The copy is
	 * taken again from the scroller, with the suppressing class off for the one read, and the offset re-derived from the
	 * settled scroll, all in the settle's own task, so no frame paints the old zoom's rules.
	 */
	private rebasePreviewPaper(): void {
		const el = this.previewPaperEl, scroller = this.view?.scrollDOM;
		if (!el || !scroller?.style || !this.winRef?.getComputedStyle) return;
		scroller.classList.remove("handwriting-paper-previewing");
		this.clearScrollerPan(scroller);
		const cs = this.winRef.getComputedStyle(scroller);
		const pitch = previewPaperPitch(cs);
		const grid = pitch === null ? null : this.gridBoxPaperStyle(pitch);
		const copyable = pitch !== null && previewPaperCopyable(cs, pitch) && !(this.paperGridBox && !grid);
		if (copyable) copyPreviewPaperBackground(el, cs, grid);
		scroller.classList.add("handwriting-paper-previewing");
		if (!copyable) { this.endPreviewPaper("settle"); return; }
		this.previewPaperPitch = pitch;
		this.previewPaperPhaseX = previewPaperPhase(cs, "--handwriting-paper-phase-x");
		this.previewPaperPhaseY = previewPaperPhase(cs, "--handwriting-paper-phase");
		this.paperScrollLeft = scroller.scrollLeft;
		this.paperScrollTop = scroller.scrollTop;
		this.previewPaperBox = null;
		this.measurePreviewPaperBox();
	}

	/**
	 * TAKE THE PREVIEW PAPER DOWN: the one place it comes down, whichever path ends its life. The scroller's paper comes
	 * back in the same task, its pan properties rewritten from the pan in force, so no frame shows neither or both.
	 */
	private endPreviewPaper(reason: PreviewPaperEnd): void {
		const el = this.previewPaperEl;
		if (!el) return;
		this.previewPaperEl = null;
		this.previewPaperBox = null;
		this.previewPaperInset = "";
		this.previewPaperTransform = "";
		this.paperScrollLeft = Number.NaN;
		this.paperScrollTop = Number.NaN;
		this.previewPaperEnded = reason;
		el.remove();
		this.view?.scrollDOM?.classList.remove("handwriting-paper-previewing");
		this.paperPanWritten = null;
		this.writePaperPan();
	}

	/** The preview paper as it stands, read-only, for a fixture that has to see it rather than infer it from pixels. */
	previewPaperReadout(): { present: boolean; held: boolean; swaps: number; ended: PreviewPaperEnd | null; pitch: number; inset: string; transform: string } {
		return { present: !!this.previewPaperEl?.isConnected, held: !!this.previewPaperEl, swaps: this.previewPaperSwaps, ended: this.previewPaperEnded,
			pitch: this.previewPaperEl ? this.previewPaperPitch : 0, inset: this.previewPaperInset, transform: this.previewPaperTransform };
	}

	/** `.cm-sizer`, found once and re-found only if it leaves the document. */
	private panSizer(): HTMLElement | null {
		const cached = this.panSizerEl;
		if (cached && cached.isConnected) return cached;
		const found = this.view?.dom?.querySelector?.<HTMLElement>(".cm-sizer");
		this.panSizerEl = found && found.style ? found : null;
		return this.panSizerEl;
	}

	/** Drop the preview offset; the committed raster is drawn on the column. */
	private clearPreviewInkOffset(): void {
		if (this.previewInkOffset === 0 && !this.previewInkOffsetY) return;
		this.previewInkOffset = 0;
		this.previewInkOffsetY = 0;
		this.writeInkLayerTransform();
	}

	/**
	 * THE CONTENT'S TOP MOVES WHEN A BLOCK ABOVE IT REWRAPS, and a pinch preview
	 * does not look. During a live pinch `syncCamera` and the camera re-read are
	 * deferred (deferPinchRaster) and the committed raster is reused, so the ink
	 * keeps the content top it was drawn at. The inline title (and properties)
	 * sit in `.cm-sizer` above `.cm-contentContainer`, in normal flow: the pinch
	 * narrows the host, the title gains or loses a line, and every text line
	 * moves by that line's height at once while the ink does not - 25 note px
	 * per title line in the fixture, until the gesture ends.
	 *
	 * NO READ PER FRAME. A ResizeObserver delivers each watched block's new
	 * border-box size after the layout that changed it, before paint, with no
	 * forced layout of its own; a delivered HEIGHT difference is added to the
	 * preview raster's vertical offset through the one transform writer. The
	 * delivery is per frame, not per rewrap: the observer fires whenever the
	 * box changes, width included, and a pinch narrows the title on every
	 * frame. Measured on the render fixture (Readable line length off): 30
	 * callbacks over a 30-frame pinch, 0.2 ms of callback time in total, none
	 * during the settle. The callback only compares heights, so the transform
	 * write happens once per rewrap (2 in a gesture that rewraps twice).
	 * Outside a preview the new height is recorded and nothing moves: the
	 * ordinary camera path already reads the content's top.
	 *
	 * RECONCILED WHERE THE COLUMN OFFSET IS: the settle and a mid-gesture
	 * repaint redraw the raster against the moved content and clear both
	 * offsets together (clearPreviewInkOffset).
	 *
	 * The blocks are the sizer's children before the content container, taken
	 * at takeover; a block added later (properties appearing) is picked up at
	 * the next takeover, and until then a rewrap inside it is the old behaviour.
	 */
	private observeAboveContent(): void {
		if (this.aboveContentObserver || typeof ResizeObserver !== "function") return;
		const sizer = this.panSizer();
		const container = this.view?.contentDOM?.parentElement;
		if (!sizer || !container || container.parentElement !== sizer) return;
		const blocks: Element[] = [];
		for (let el = sizer.firstElementChild; el && el !== container; el = el.nextElementSibling) blocks.push(el);
		if (!blocks.length) return;
		this.aboveContentHeights = new WeakMap();
		const observer = new ResizeObserver(entries => {
			let dH = 0;
			for (const entry of entries) {
				const box = entry.borderBoxSize?.[0];
				const height = box ? box.blockSize : entry.contentRect.height;
				const before = this.aboveContentHeights.get(entry.target);
				this.aboveContentHeights.set(entry.target, height);
				if (before !== undefined) dH += height - before;
			}
			if (dH === 0 || !this.pinchPreview) return;
			this.previewInkOffsetY = (this.previewInkOffsetY || 0) + dH;
			this.aboveContentShifts = (this.aboveContentShifts || 0) + 1;
			this.writeInkLayerTransform();
			// The paper moves with the text too, on its own account: its shift is spent where the origin is next
			// re-measured (capturePaperOrigin), not where the ink's raster is redrawn.
			this.paperRewrapY += dH;
			this.writePaperPan();
		});
		for (const block of blocks) observer.observe(block);
		this.aboveContentObserver = observer;
	}

	/**
	 * Hold the note under the fingers, for this frame, with a translate.
	 *
	 * THE ONE INVARIANT: the note point that was under the focal point when the
	 * gesture started is still under it now. Written as an ABSOLUTE target and
	 * not as an increment - every term comes from an element the pan is not
	 * written to, or has had the live pan taken back out of it, so the answer is
	 * the whole pan rather than a correction to it. That is what makes a
	 * `syncCamera` during a deferral lapse (a pause past PINCH_SCROLL_QUIET_MS)
	 * harmless: there is no state here for it to absorb and re-apply, and a
	 * suppressed or re-derived frame cannot accumulate into the next.
	 *
	 * Horizontally the anchored point is held COLUMN-RELATIVE. Host-local is not
	 * a fixed frame: with Readable line length on, `.cm-sizer`'s auto margins
	 * re-centre the column inside the counter-sized host, so one note point has
	 * a different host-local x at every scale. `p` below - the point's offset
	 * from the column's left edge - does not, at any scale or scroll.
	 *
	 * Vertically there is no column, and none is needed: the content's top is a
	 * constant host-local offset while the scroll is constant, and a constant
	 * cancels out of the difference entirely. That is why the per-frame path
	 * reads the host's origin and nothing else for y.
	 */
	private anchorPanTo(
		next: number,
		a: { focalX: number; focalY: number; targetX?: number; targetY?: number; hostLeft: number; hostTop: number; columnLocal: number | null; contentTopLocal: number | null; fromScale: number; scrollTop: number },
		columnLocal: number | null,
		contentTopLocal?: number | null,
		/** Only the settle of a gesture that changed the scale asks for the fitting bound; a preview frame must keep the note under the focal point. */
		settleBound = false,
		/** Every settle, drag or zoom (the settle runs with the preview down): a centred column that fits goes back to its rest (columnRestPan). */
		settling = !this.pinchPreview
	): void {
		if (!validCameraScale(next) || !validCameraScale(a.fromScale)) return;
		// NO SIZER, NO PAN. The text half of the pan goes on `.cm-sizer`; a
		// surface without one takes the ink half and nothing else, which is ink
		// sliding off the words - the very defect this lane exists to fix.
		//
		// It is also unrecoverable rather than merely partial. Every term here
		// is measured against a column that has had the LIVE pan subtracted from
		// it, on the understanding that the column carries that pan; when it does
		// not, each frame subtracts a displacement the text never received and
		// asks for it again on top. Measured on the edge-audit fixture, whose
		// editor has no sizer: a 0.2 -> 0.1 pinch with identical inputs on every
		// frame walked the column read 0, -1612.5, -3225, -4837.5, -6160 and the
		// pan 161.25, 322.5, 483.75, 616 (clamped), 616 - a pane-sized
		// displacement out of a gesture that needed 161. Refusing here leaves
		// `previewPanEngaged` false. Preview remains scale-only on such hosts;
		// settle uses the existing `anchoredScroll` fallback.
		if (!this.panSizer()) return;
		const origin = this.previewHostOrigin;
		// The unit fixtures drive `pinch` against partial objects built with
		// Object.create, which reach the methods but not the class fields.
		const pan = this.viewportPan;
		if (!origin?.valid || !pan) return;
		// THE VERTICAL ORIGIN IS MEASURED, every frame, and the closed form it
		// replaces is worth naming because it looks right and is not. That form
		// assumed the content's top is a fixed host-local offset for the whole
		// gesture, on the grounds that no preview frame writes the scroll. The
		// scroll moves anyway, for two reasons a `scrollTop` delta cannot tell
		// apart: zooming OUT grows the scroller's client box inside the
		// counter-sized host, the reachable range shrinks with it and the browser
		// clamps `scrollTop` down - the content really has moved; zooming IN makes
		// CodeMirror re-anchor its own scroll to hold the visible text still - the
		// content has NOT moved, and correcting for that scroll is pure error.
		// Measured on the render fixture at scrollTop 2000: the closed form alone
		// left 9.60px on the zoom-out arms, and the scroll-delta correction that
		// fixes those put 144px on the zoom-in ones. The rect answers both.
		//
		// The cost is ONE `getBoundingClientRect` on `.cm-content` and NO extra
		// forced layout: `columnLocalAt` has already flushed the layout on this
		// frame, so this reads a clean tree. Callers with nothing to measure pass
		// null and get the closed form, which is exact for them.
		const y = contentTopLocal !== undefined && contentTopLocal !== null && a.contentTopLocal !== null
			? (a.targetY ?? a.focalY) - (origin.top + (contentTopLocal + ((a.focalY - a.hostTop) / a.fromScale - a.contentTopLocal)) * next)
			: (a.targetY ?? a.focalY) - origin.top - (a.focalY - a.hostTop) * (next / a.fromScale);
		// Without a column measurement at BOTH ends there is no column-relative
		// frame to hold, and a host-local fallback would silently reintroduce
		// the centring term. Hold y, leave x where it is: a partial anchor is
		// visible, a wrong one is a drift nobody can attribute.
		const x = columnLocal === null || a.columnLocal === null
			? pan.x
			: (a.targetX ?? a.focalX) - (origin.left + (columnLocal + ((a.focalX - a.hostLeft) / a.fromScale - a.columnLocal)) * next);
		// THE PAPER'S SHARE OF THE COLUMN'S RE-CENTRING. `x` holds the text column under the fingers, so while the column
		// re-centres inside the host (Readable line length under a zoom-in) the text moves against the scroller by exactly
		// that re-centring, in the painted px this formula uses, and the paper, which lives on the scroller, moves with
		// it. Preview frames only: the settle re-measures the origin instead (capturePaperOrigin).
		let paperDriftMoved = false;
		if (this.pinchPreview) {
			const drift = columnLocal === null || a.columnLocal === null ? 0 : (columnLocal - a.columnLocal) * next;
			paperDriftMoved = Number.isFinite(drift) && drift !== this.paperColumnDrift;
			if (paperDriftMoved) this.paperColumnDrift = drift;
		}
		// KEEP THE NOTE ON THE PANE. The translate has no clamp of its own and
		// the scroller does not move with it, so an unbounded pan can carry the
		// whole note off screen with nothing to bring it back.
		const layout = this.viewportLayout;
		const bx = layout ? Math.max(0, layout.paneWidth * layout.externalScale - PAN_MIN_VISIBLE_PX) : MAX_VIEWPORT_LAYOUT;
		const by = layout ? Math.max(0, layout.paneHeight * layout.externalScale - PAN_MIN_VISIBLE_PX) : MAX_VIEWPORT_LAYOUT;
		const path = this.filePath(), extent = path ? surfaceExtents.get(path) : { x: 0, y: 0 };
		const effective = layout ? next * layout.externalScale : next;
		// Bound the NOTE's visible overlap, not the translation's magnitude.
		// After scrolling, a pan larger than the pane can still leave the note
		// covering it. A symmetric pane-sized clamp broke the next zoom there.
		const left = columnLocal === null ? 0 : columnLocal * next;
		const top = contentTopLocal == null ? 0 : contentTopLocal * next;
		const width = Math.max(layout?.columnBox ?? 0, extent.x * this.fontZoom) * effective;
		const height = Math.max(this.view.contentHeight, extent.y * this.fontZoom) * effective;
		const minX = width > 0 ? PAN_MIN_VISIBLE_PX - left - width : -bx;
		const minY = height > 0 ? PAN_MIN_VISIBLE_PX - top - height : -by;
		// Only native scroll may be spent into right/down pan. At scroll zero
		// the content stays at its natural inset, including column/title margins.
		// Use the same origin-first precedence as the ordered input reducer.
		const nativeLeft = this.view.scrollDOM.scrollLeft, nativeTop = this.view.scrollDOM.scrollTop;
		// The preview paper's offset is taken against this scroll (zooming out clamps it); the read is this frame's already.
		if (this.previewPaperEl) { this.paperScrollLeft = nativeLeft; this.paperScrollTop = nativeTop; }
		// The scroller's CONTENT box: the page is laid out inside it, and the scrollbar is not room the column may use.
		// PREVIEW-TOUCHING (anchorPanTo, called at :5620 inside the preview frame body), so this reads the
		// LAST STORED gutterScreen. Staleness bound: one gesture - it is refreshed at every settle, and a
		// gesture's previews sit between two settles. Preview carries no width test since 24649b64, so the
		// pan window is the only consumer of this span here.
		const spanX = layout ? layout.width * layout.externalScale - layout.gutterScreen : NaN;
		// EXCEPT A COLUMN INSET THAT FITS. With Readable line length on, the blank either side of the column is the setting's
		// centring, not the note's origin edge, and the column's margin is frozen in host px (styles.css, the note viewport's
		// sizer), so at scroll zero the cap above anchored every zoom-out at the pane's left edge: the column slid out from
		// under the fingers while they were down, measured 524 px at 25% about the pane's centre. Where the column fits the
		// pane, the pan may carry it right as far as the pane's own edge - the settle's fitting window - so the fingers keep
		// it. Readable line length off has no inset (columnRestPan is null) and keeps the cap.
		// THE KEY IS THE FIT, not how a theme spells its column: where the page's own box sits inside the pane, the blank
		// beside it is the room a readable width leaves and the pan may carry the page right as far as the pane's edge.
		// SUPERSEDED (Alan, direct: "just get rid of the settle. page is where you leave it"). The
		// settle no longer has a rest to return to, so `rest`/`columnRestPan` and the `fitsX` room-beside-
		// the-column question they were asked with are both gone from this path. `columnRestPan` itself
		// stays: the scroll-zero path above still reads it.
		// THE SAME QUESTION, ASKED AGAIN ONE STEP LATER. `reducePinchConstraint` frees the target; this bound
		// then decides whether the pan may reach it. `width` is the page OR the room Infinite Canvas has
		// granted around it, whichever is larger - right for the overlap bound above, wrong here - so with
		// the setting on `fitsX` went false and the ceiling collapsed to the scroller's own position, which
		// is 0 because no preview frame writes the scroll. Freeing the target alone does nothing: measured,
		// reverting this line while keeping the constraint fix put all eight frames back, the full 786.09 px.
		// Both terms are the same mistake about the same quantity, one step apart.
		const pageX = this.pageContentWidth() * effective;
		const fitsPageX = (layout?.columnInset ?? false) && pageX > 0 && Number.isFinite(spanX) && pageX <= spanX + PAN_FIT_SLACK_PX;
		// PREVIEW AND SETTLE ALIKE. The settle was left on `fitsX` on the understanding that the commit
		// would convert the pan into scroll, so a refused ceiling there cost nothing. It does not: at the
		// commit the conversion wants scrollLeft -3144.375 from a scroller sitting at 0, because the pan
		// carried the page RIGHT and the scroll that would hold it is BELOW zero - a direction that does
		// not exist. `maxScrollLeft` is 0 at that moment (the 4796 in the frame sample is read after the
		// commit re-grants extent), so there is no range in any direction to spend it into either.
		//
		// The refused remainder is meant to come back as pan here, and this bound is what threw it away:
		// measured at the settle, x wanted 786.09, `fitsX` false on width 2496 against span 1383, ceiling
		// 0, pan 0 - the page dropped the whole hold in one frame. The page's own box is 175. The setting-
		// off arm, asking the same question of the same page, carries 267.66 against a ceiling of 604.26
		// and eases onto its rest.
		//
		// `restX` deliberately still reads `fitsX`: whether a page with room granted beside it returns to
		// the centred rest is Alan's open question, and `columnRestPan` is null in that regime anyway.
		// This changes what the settle may HOLD, not where it decides to land.
		// SETTLE ONLY. While the fingers are down there is no ceiling at all: the preview pays in pan
		// whatever the page's width, and the settle - which is where this bound belongs - eases to a
		// position it computes from the true content box. Measured with a ceiling still in the preview
		// path on an inked note: 7 frames off, up to 925.95 px, because a page wider than the pane was
		// refused the pan and nothing else carries it mid-gesture.
		const carriesX = fitsPageX;
		const carryWidth = pageX;
		// UNDER INFINITE CANVAS THE SETTLE'S TARGET IS B CLAMPED TO THE WORLD:
		// the page stays where the fingers left it, and the one thing it may not keep is blank to the LEFT
		// of its own natural margin. Infinite Canvas grants room to the right and below - room the user is
		// entitled to - and nothing is ever granted left of the natural margin, so blank there is not canvas.
		//
		// This ceiling was +Infinity here, which is what left 200 px of margin standing on the pane after
		// the page had settled: measured at e27fbcf0, zoom-out-settled and reachable-settled both 200.00 on
		// corner / Readable line length on / Infinite Canvas on, and the same shape on every setting-on cell
		// of the family. With the setting OFF no *-settled row was ever red, which is the asymmetry that
		// names the cause: the clamp is missing on one side of a boolean, not wrong everywhere.
		//
		// THE EDGE HALF ONLY, never the centring half. The ceiling is the natural margin itself, so the ease
		// travels the MINIMUM distance that closes the exposure and stops there; a page that settles inside
		// the world is not touched, which is what keeps B. The fitting window's re-centring stays off under
		// the setting - that is what jumped an inked note 907.69 px when it was applied here, and it is a
		// different question from the edge.
		//
		// Y already reads exactly this way one line below, unconditionally, and no *-settled row on the Y
		// axis was ever red. X is now the same shape.
		//
		// With the setting OFF the ceiling is the no-room law and stays: the page eases back to the
		// position the bounds allow, which is what ships today.
		const rightX = !settling ? Number.POSITIVE_INFINITY
			: this.canvasMode ? nativeLeft * effective
			: carriesX ? Math.max(nativeLeft * effective, -left + Math.max(0, spanX - carryWidth)) : nativeLeft * effective;
		// Y TAKES THE SAME SHAPE, and the reason the older note here gave for exempting it does not survive the
		// measurement. That note said a hold carried down through the preview came back as a jump at the lift, so
		// y kept its cap on every frame. The jump it describes is not the cap's absence - it is the cap's
		// correction never reaching the ease, which is fixed one screen below. With the correction delivered, the
		// preview may hold the page under the fingers on y exactly as it does on x, and the settle closes it.
		// Measured at 678b74e2 on an Infinite-Canvas-on cell, fingers down: y = 450.000 asked, nativeTop * effective
		// = 0.000, rawY = 0.000. The cap ate the whole request on every preview frame, which is why the page did not
		// move vertically at all and `reverse-75` read 0 instead of -75.
		const bottomY = !settling ? Number.POSITIVE_INFINITY : nativeTop * effective;
		// THE POSITION BEFORE THE EDGE CAP, kept on both axes because the ease needs it. The difference between it
		// and the committed pan IS the correction the edge applied, and that difference is what the bounce travels.
		const uncappedX = columnLocal !== null && Number.isFinite(nativeLeft)
			? Math.max(this.canvasMode ? (nativeLeft - MAX_VIEWPORT_LAYOUT) * effective : minX, x) : pan.x;
		const uncappedY = contentTopLocal != null && Number.isFinite(nativeTop)
			? Math.max(this.canvasMode ? (nativeTop - MAX_VIEWPORT_LAYOUT) * effective : minY, y) : pan.y;
		const rawX = columnLocal !== null && Number.isFinite(nativeLeft) ? Math.min(rightX, uncappedX) : pan.x;
		const rawY = contentTopLocal != null && Number.isFinite(nativeTop) ? Math.min(bottomY, uncappedY) : pan.y;
		// THE SETTLE'S TARGET, and only it: where the page fits the viewport on an axis, the pan it lands on is held to
		// the TIGHTER of what this bound already allows and the page's own box inside the pane (panAxisWindow). The
		// gesture's own frames are not touched - the note stays under the focal point while the fingers are down.
		// SEVENTH SITE, and the last of them: the settle's pan window. It is the third clamp on the same
		// frame, and under Infinite Canvas it is off for the same reason as the other two - there the
		// settle's target IS where the fingers left it, so nothing may pull the page off it.
		// Measured on a fresh note, setting on, Readable line length off: the pan needed to hold the
		// fingers was 786.09, nothing else clamped it, and this window cut it to 615.01 - exactly the
		// 171.08 px the page missed B by. Routing it through the page box instead of the granted extent
		// fixed that arm and broke two others, because with ink the page box is nearly the whole span
		// and the window then closed to ~27 px: B went to -925.94 with the page easing 24.16 px after
		// the lift. The width was never the question on this path; the SETTING is.
		//
		// THE WINDOW IS GONE WITH THE SETTLE. Its two jobs were the fitting clamp, which Alan removed
		// outright, and the near-side bound, which was kept and which `-left`/`-top` state directly below
		// without a fits test and without a max side. `panAxisWindow` itself stays: `panFitReadout` and the
		// preview paths still read it.
		// THE ONE BOUND ALAN KEPT, and nothing else. "Bounded by the top and left": the
		// drawing canvas's own left and top edge may not come to rest inside the pane. No rest, no fitting
		// clamp, no margin payment, nothing at the right or bottom, in every regime.
		//
		// A CEILING ON THE PAN, not a floor, and the ceiling is the HOST'S OWN LAYOUT: pan 0. Positive pan
		// carries the page right of where the layout puts it, which is the blank Alan's bound forbids;
		// negative pan is the hang past the pane, which he allows. So `Math.min(raw, 0)` per axis.
		//
		// NOT `-left`, which is the PANE edge. With Readable line
		// length on, `left = columnLocal * next` is the column's native margin and is positive, so a bound
		// at `-left` would drag the column out of its margin and onto the pane edge at every lift - Alan's
		// "jumps left". With the setting off `left` is 0 and the two forms are the same expression.
		//
		// SETTLE ONLY, on `settling` - the gate `rawX`/`rawY` themselves take through `rightX`/`bottomY`.
		// `settleBound` is narrower, true only for the lift of a gesture that changed the scale, and the
		// bound is owed at every settle. A preview frame keeps the note under the fingers, untouched.
		const bounded = settling && columnLocal !== null && contentTopLocal != null;
		// THE FAR END EASES BACK, "like OneNote's bounce back" (Alan direct). A page
		// pushed past the far end of its room stays where the fingers left it at the lift, then
		// eases back until it is within its room - the ceiling above is unchanged, the bound is now
		// two-sided. floor = 0 where the page fits its room already (Infinite Canvas off, room is
		// bx/by against the page's own width/height); floor = room - extent, negative, where the
		// page is bigger than its room, so the far edge may still come to rest flush with the pane.
		// IC on keeps 3578f29e's own ceiling-only bound, byte-identical. IC off only, the floor.
		const floorX = this.panFloor(bx, width);
		const floorY = this.panFloor(by, height);
		// Read-only: the bound's own numbers, so a cell can derive the rest
		// puts the page on instead of pinning a measured constant. Four property writes, no read.
		this.boundReadout.floorX = floorX; this.boundReadout.floorY = floorY;
		this.boundReadout.bx = bx; this.boundReadout.width = width;
		// THE PREVIEW GETS THE SAME BOUND, PLUS THE GIVE. Measured at 4e4738f8 on this file's two
		// allowance rows: a preview frame had no near-side bound of any kind, so the committed pan WAS the
		// geometric ask - drift 0.00, margin 0.00 and raw == ask on all 60 preview frames of both arms, the
		// page following the fingers to -391.55 and 381.60 against a floor of -50.49 and a ceiling of 0.
		// Alan's contract is that it stops: the same two-sided bound the settle takes, widened by the give,
		// so the page passes its room by the allowance and no further, and the lift's existing bounce eases
		// that give back to the bound itself.
		//
		// A DRAG ONLY, and Infinite Canvas off only. A frame that is changing the scale keeps the note under
		// the focal point with no bound - `PAN_DRAG_SCALE_EPS` is what separates the two, and skipping that
		// gate is what broke the focal hold at 3884c642. With Infinite Canvas on the preview stays exactly as
		// it was, for the same reason the settle's floor is off there: the page is where the fingers
		// left it and nothing may pull it off that.
		const give = OVERSCROLL_GIVE_PX * (layout?.externalScale ?? 1);
		// A frame is a drag frame when the scale has held over the last PAN_DRAG_WINDOW frames (within
		// PAN_DRAG_FRAME_EPS of the scale that many frames ago), whatever the gesture did before. A zoom, even a
		// slow one, moves more than that over the window and keeps the note under the focal point with no
		// bound; a held spread does not.
		let steady = false;
		if (!settling) {
			const h = this.pinchBand.history;
			if (h.length === PAN_DRAG_WINDOW) steady = validCameraScale(h[0]!) && Math.abs(next / h[0]! - 1) < PAN_DRAG_FRAME_EPS;
			h.push(next);
			if (h.length > PAN_DRAG_WINDOW) h.shift();
		}
		// A gesture that has never zoomed (within PAN_DRAG_SCALE_EPS of its start) is a drag from its first frame,
		// as before; the window is what catches a drag AFTER a zoom in the same gesture.
		const neverZoomed = validCameraScale(a.fromScale) && Math.abs(next / a.fromScale - 1) < PAN_DRAG_SCALE_EPS;
		// A drag frame in EITHER mode; the bound it takes below is what the mode decides.
		const dragFrame = !settling && Number.isFinite(give) &&
			columnLocal !== null && contentTopLocal != null && (neverZoomed || steady);
		// THE X CEILING IS THE COLUMN'S OWN REST, not 0. With Readable line length on and a
		// column that fits, the settle leaves the page on a centred rest whose pan is not zero, and a ceiling
		// of 0 + give pulls that legitimate rest back and hands the difference to the bounce - measured as the
		// "next touch does not bounce" cell of RllColumnFocalHold going red, a file that is 24/24 green
		// without this band. `columnRestPan` is arithmetic on this path, no forced read on a preview frame,
		// and is null everywhere the rest is 0, so the `?? 0` is the old form unchanged. Computed on a drag
		// frame only, so a zoom frame pays nothing.
		const restCeilX = dragFrame ? (this.columnRestPan(next, effective) ?? 0) : 0;
		// THE BAND STOPS TRAVEL, IT NEVER MOVES A RESTING PAGE. Measured after a zoom-button
		// commit to 50% with Readable line length on: viewportPan.x was 0 and the next touch still bounced,
		// because the ceiling clamped a frame the page was already legally sitting on. Widening each end to
		// the pan the GESTURE started from fixes that without a new quantity: a page resting outside its room
		// keeps its position, and a frame may still never carry it further out than the give allows.
		const startX = Number.isFinite(this.pinchStartPan.x) ? this.pinchStartPan.x : 0;
		const startY = Number.isFinite(this.pinchStartPan.y) ? this.pinchStartPan.y : 0;
		// The band's edges are widened to where the page ALREADY stands (the last frame's pan), so
		// engaging mid-gesture moves nothing; travel back inside the band is always allowed.
		const lastX = this.pinchBand.lastPan.x, lastY = this.pinchBand.lastPan.y;
		// CEILING SIDE ONLY. The band's floor term was the far end's give, and in canvas mode the far
		// side is room the page grows into, not a boundary - measured, the grow rule keeps headroom ahead of
		// the frontier on both axes, so there is nothing there to spring back from. The ceiling side is the
		// page's own origin edge, which the direction check measured as the POSITIVE side (a finger dragging
		// right at scrollLeft 0 pulls +96).
		// CANVAS OFF TAKES THE PLAIN BOUND ON A DRAG FRAME, floor and ceiling, no give. Leaving the
		// preview unbounded there drifted the page 21.21 px past the fingers on a fitting page (measured, every
		// travel, ScrollColumnAnchorPinch tiny arm), and stock scrolling is exactly "the page never moves where
		// the fingers did not ask". A bound that stops at the edge also leaves the settle nothing to close.
		const plainX = Math.max(floorX, Math.min(rawX, 0)), plainY = Math.max(floorY, Math.min(rawY, 0));
		// A NON-DRAG FRAME IS UNTOUCHED IN BOTH MODES: a zoom frame keeps the note under the focal point and
		// carries no bound of its own, which is what the focal-hold cells measure.
		// THE SETTLE'S CORRECTION IS A WHOLE NUMBER OF DEVICE PX. The scroll commit rounds, so the pan it
		// leaves can sit a fraction of a px past the bound; clamping that fraction away moved the text by
		// 0.633 px at 150 percent, off the device grid the ink is rastered on, and the ink then read a
		// quarter px off its line. The correction is the largest whole number of device px not above the exact
		// clamp move, so the page keeps the grid it was on and never moves further than the bound asked; it can
		// rest under one device px past the bound, which is not a visible overscroll. Settle only; preview and
		// drag frames are untouched.
		const cx = bounded ? onDeviceGrid(rawX, this.canvasMode ? Math.min(rawX, 0) : plainX, this.dpr)
			: dragFrame ? (this.canvasMode ? Math.min(rawX, Math.max(Math.max(restCeilX, startX) + give, lastX)) : plainX)
			: rawX;
		const cy = bounded ? onDeviceGrid(rawY, this.canvasMode ? Math.min(rawY, 0) : plainY, this.dpr)
			: dragFrame ? (this.canvasMode ? Math.min(rawY, Math.max(Math.max(0, startY) + give, lastY)) : plainY)
			: rawY;
		if (!settling) { this.pinchBand.lastPan.x = cx; this.pinchBand.lastPan.y = cy; }
		this.boundReadout.rawX = rawX; this.boundReadout.cx = cx; this.boundReadout.rawY = rawY; this.boundReadout.cy = cy;
		this.boundReadout.dragFrame = dragFrame; this.boundReadout.neverZoomed = neverZoomed; this.boundReadout.steady = steady;
		this.boundReadout.next = next; this.boundReadout.fromScale = a.fromScale; this.boundReadout.fromScaleValid = validCameraScale(a.fromScale);
		this.boundReadout.restCeilX = restCeilX; this.boundReadout.startX = startX; this.boundReadout.startY = startY;
		this.boundReadout.lastX = lastX; this.boundReadout.lastY = lastY; this.boundReadout.bounded = bounded; this.boundReadout.settling = settling;
		if (bounded) {
			this.notePanBound(cx !== rawX, rawX, cx);
			this.notePanBound(cy !== rawY, rawY, cy);
		}
		if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
		this.previewPanEngaged = true;
		// The clamp's correction becomes the bounce: the page starts where the gesture left it and eases onto its rest.
		// EVERY CORRECTION ON THE AXIS, not only the window's. The edge cap (`rightX`, `bottomY`) also moves the
		// committed pan, and its correction was not handed over - so at the lift the page did not ease closed, it
		// SNAPPED. Measured at 678b74e2 on an Infinite-Canvas-on cell at the lift: x = 200.000 asked, rightX = 0,
		// cx = 0.000, and the bounce was handed 0.000 - the whole 200 px closed in one frame. On the screen that is
		// 200 px of blank held open while the fingers are down and then swallowed in a single frame at the lift,
		// where the rule says the page holds under the fingers and eases closed.
		// Measuring the correction from the position BEFORE the cap covers both: where only the window moved the
		// pan, `uncapped` equals `raw` and this is the old expression; where the edge moved it, the edge's share is
		// now included; where nothing moved it, the difference is zero and no bounce starts.
		// ANY SETTLE WITH A CORRECTION EASES. The gate this replaces was `settleBound || restX` - the fitting
		// window, or the rest. Both are real reasons to ease and neither is the only one: the edge caps
		// (`rightX`, `bottomY`) also move the committed pan, and on a drag settle they are the ONLY thing that
		// moves it, so those arms were refused the call outright. Measured on an Infinite-Canvas-on cell with
		// the corrections already delivered: `repeat-0-lift` and `reachable-lift` ran with settling true,
		// settleBound false, a correction of 450.00 and 200.00 waiting, and no bounce started - the page closed
		// the whole distance in one frame, while `zoom-out-lift` (settleBound true) eased.
		// The rule draws no line between a drag's settle and a zoom's settle, so neither does this.
		// `settleBound` keeps its own meaning - the fitting window - and is untouched.
		// PREVIEW FRAMES ARE NOT TOUCHED: off the settle both caps are +Infinity and both rests are off, so
		// every correction below is zero and this cannot fire while the fingers are down.
		// THE EDGE CAP'S SHARE IS NOT HANDED TO THE EASE. Measuring the correction from the position
		// BEFORE the cap displaced the ink: six `draws across the expanded right viewport` cells stored
		// strokes up to 652.331 px from the pen, and on `scroll-fast` and `scroll-zero` that distance was
		// EXACTLY the correction handed to this call - 652.331 against hypot(544.000, 360.000) and
		// 374.401 against hypot(224.000, 300.000), both to the digit. A term-by-term read of the mapping
		// at every pointer event found no displaced term to fix instead: pan, rest, bounce, raster and
		// ink pan were all zero and constant while the error stood. So the edge's share comes back out,
		// the window's and the rest's stay, and the edge close is a same-frame write again - the same
		// shape it already has with Infinite Canvas off.
		// THE FLAG STILL APPLIES, on its own merits: only the settle that closes a preview may ease at
		// all, so the second and third settling passes for one lift write their target instead of
		// re-running the ease from a position the page has left.
		const owesPreviewEase = settling && this.previewSettleOwed;
		if (settling) this.previewSettleOwed = false;
		// The correction is whatever the one bound actually moved, and the ease fires when there is
		// one. The old gate read `restX || windowX.fits` - proxies for "something might have moved" - and
		// started a bounce on `settleBound` alone, which under the no-settle rule is an ease with nothing to correct.
		// THE CORRECTION IS THE DISTANCE THE PAGE ACTUALLY TRAVELLED, painted px against the scroller.
		// Three earlier shapes failed on the quantity: `rawX - cx` hands over only what the bound moved
		// and leaves the rest to the commit, a 15 px jump at the lift; `pan.x - cx` hands over a PAN
		// number, 98 where the page moves 15 px on screen; and a painted read taken HERE reads 79 or 0,
		// because the scroll has already been spent by the time this runs. The painted position comes
		// from the capture at the settle-close path instead, and the landed position is read here.
		//
		// SAME TASK: the write, the second read and the ease, with no await and no animation frame
		// between them, so nothing paints at the landed position before the offset is set.
		const paintedBefore = owesPreviewEase ? this.previewPaintedBlank : null;
		this.previewPaintedBlank = null;
		// IC on keeps 3578f29e's own gate, consumption and early bounce start, byte-identical.
		// IC off: starting a bounce here on the bound's share alone, before `landed` can be
		// read below, is what made the later carry read a position the running ease already hid (the
		// paper arm). The IC-off ease is deferred whole to the merged call after the pan write.
		const legacyX = this.canvasMode && !paintedBefore && owesPreviewEase && cx !== rawX ? rawX - cx : 0;
		const legacyY = this.canvasMode && !paintedBefore && owesPreviewEase && cy !== rawY ? rawY - cy : 0;
		const legacyBounced = (legacyX !== 0 || legacyY !== 0) && this.startOverscrollBounce(a, legacyX, legacyY);
		// A settle whose bound target already equals the standing pan still owes the
		// ease for whatever the scroll commit moved - the second settle of a round trip lands here
		// with cx === pan.x and an owed capture. Returning there dropped that ease. The pan write
		// below is the only thing this return saves, so with a capture owed it is skipped instead.
		if (cx === pan.x && cy === pan.y && !(paintedBefore && !this.canvasMode)) {
			if (legacyBounced) this.writeViewportPan();
			else if (paperDriftMoved || this.previewPaperBoxDirty) this.writePaperPan();
			this.previewPaperBoxDirty = false;
			return;
		}
		// Mutated, not replaced: this runs once per preview frame, and a fresh
		// object per frame is an allocation on the one path the pinch deferral
		// exists to keep free of them.
		pan.x = cx; pan.y = cy;
		this.writeViewportPan();
		this.previewPaperBoxDirty = false;
		if (!paintedBefore) return;
		const landed = this.settleBlank();
		if (this.canvasMode) {
			// IC on only, byte-identical to 3578f29e.
			const correctionX = paintedBefore.x - landed.x, correctionY = paintedBefore.y - landed.y;
			if ((correctionX !== 0 || correctionY !== 0) && this.startOverscrollBounce(a, correctionX, correctionY, true)) this.writeViewportPan();
			return;
		}
		// IC off - the ease is the carry ALONE. `landed` is read here, after the pan
		// write and before any ease is live, so `paintedBefore - landed` is already the WHOLE distance
		// the commit moved the page, the bound's own share included. Adding `rawX - cx` on top counted
		// that share twice: measured on EDGE INSIDE THE PANE (LEFT), carry 34 against a travel of 34,
		// share 19, ease started at 53. Standing pan is
		// `cx` alone, already written above; nothing is added to pan directly (an earlier error).
		const easeX = paintedBefore.x - landed.x;
		const easeY = paintedBefore.y - landed.y;
		if ((easeX !== 0 || easeY !== 0) && this.startOverscrollBounce(a, easeX, easeY)) this.writeViewportPan();
	}

	/**
	 * THE PAGE'S BLANK INSIDE ITS PANE, painted px, both axes from one read pair. Positive means the
	 * canvas's edge sits inside the pane, which is the case the left-and-top bound corrects. Against the
	 * SCROLLER and not the viewport: the settle writes scroll as well as pan, so an absolute rect moves
	 * by the scroll too and reports a distance the page never travelled. The sizer is not read - the
	 * intermediates carry their own offsets.
	 */
	private settleBlank(): { x: number; y: number } {
		const content = this.view.contentDOM.getBoundingClientRect(), scroller = this.view.scrollDOM.getBoundingClientRect();
		return { x: content.left - scroller.left, y: content.top - scroller.top };
	}

	/**
	 * THE WINDOW A SETTLED PAN MAY SIT IN on one axis, as offsets from the
	 * position the content sits at with no pan (its leading edge against the
	 * viewport's).
	 *
	 * A pinch holds the note with a translate because above the scale the
	 * content fits at, the scroller's range runs out before the gesture does.
	 * The bound on that translate is the note's VISIBLE OVERLAP: drag until only
	 * 24 px of the note is left on the pane. That is right for a page bigger
	 * than its viewport, and wrong for a page smaller than it - there the same
	 * rule lets a gesture leave the whole note hanging off the pane's edge with
	 * nothing to bring it back, because at that scale there is no scroll range
	 * to undo it either. What the user saw: pinch in, pinch back out somewhere
	 * else, and at 100% the note sits off to the left with its first characters
	 * past the edge until a Fit, a zoom button or a file switch (measured:
	 * 226.67 px past it with readable line length off).
	 *
	 * ONLY A SETTLE THAT CHANGED THE SCALE IS BOUND BY THIS. While the fingers
	 * are down the note stays under the focal point - that is the gesture's
	 * contract and it is pinned by its own cells - so the preview's pan and the
	 * ordered constraint reducer are left alone. The settle of a zoom already
	 * moves the frame it commits; clamping its TARGET means the correction rides
	 * that motion instead of arriving as a jump after it. A pure two-finger pan
	 * has no such motion to ride: a page dragged past the pane's edge stays
	 * where the fingers left it, as it always has, and a clamp there would be a
	 * spring-back on the most common gesture (800 px, measured, before this
	 * condition). "Changed the scale" is a band, not equality
	 * (PAN_SETTLE_ZOOM_BAND): a drag whose spread drifted, and an in-then-out
	 * pinch that comes back near its start, both read as pans and are not
	 * clamped.
	 */
	private panAxisWindow(size: number, span: number): { fits: boolean; min: number; max: number } {
		if (!(Number.isFinite(size) && Number.isFinite(span))) return { fits: false, min: -MAX_VIEWPORT_LAYOUT, max: MAX_VIEWPORT_LAYOUT };
		if (size > 0 && size <= span + PAN_FIT_SLACK_PX) return { fits: true, min: 0, max: Math.max(0, span - size) };
		const visible = Math.max(0, span - PAN_MIN_VISIBLE_PX);
		return { fits: false, min: size > 0 ? PAN_MIN_VISIBLE_PX - size : -visible, max: visible };
	}

	/**
	 * THE PAGE'S CONTENT BOX on x, note px: the text column, or the ink, whichever reaches further
	 * Every SETTLE-TIME width test reads this and nothing else. No preview-time test reads
	 * any width at all - while the fingers are down the note is held, and bounds belong at the settle.
	 *
	 * NOT the granted extent. `surfaceExtents` is grown from the ink claim OR the zoom and scroll
	 * grants, whichever is largest, then quantised up to a 256 px block: measured, an ink frontier of
	 * 10116 is stored as 10496. A fit test reading that asks "is there room beside the page", which is
	 * a different question - at k = 0.134 it called a 1355.54 px page non-fitting in a 1383 px span and
	 * left it 309.06 px off its own rest.
	 *
	 * ONE FUNCTION, SIX CALLERS, deliberately. The first cut of this fix wrote the page's box at two
	 * sites by hand and left four more reading the conflated field; two had to be found by
	 * instrumenting, and one of those - the site that SPENDS the rest - disagreed with the site that
	 * COMPUTES it about whether a rest existed at all.
	 */
	private pageContentWidth(): number {
		return Math.max(this.viewportLayout?.columnBox ?? 0, this.pageInkX * this.fontZoom);
	}

	/**
	 * THE MARGIN THE PAGE ACTUALLY SITS AT at scale `next`, host-local: what the box write asked for, after the
	 * stylesheet clamps it against the auto term. NOT the custom property, which is written unclamped - measured on a
	 * tiny note at 10% with Readable line length off, the property reads 6907.03 and the page sits at 6562.5, and it is
	 * this one that carries the page.
	 *
	 * One expression, two readers that must agree or the page pays twice: `columnRestPan` turns the part the layout did
	 * not take into a pan, and the box write records it so the next resting frame can tell that the law moved under it.
	 */
	private appliedColumnMargin(next: number): number {
		const layout = this.viewportLayout, auto = layout?.columnAuto;
		if (!layout || layout.columnLocal === null) return 0;
		const want = Math.max(0, this.columnRestMargin ?? this.columnMarginLocal(layout)!);
		return (layout.sizerColumn || layout.ownLines) && auto
			? Math.max(0, Math.min(Math.max(0, (layout.width / next - auto.fixed - (this.hostZoomSupported() ? auto.scrollbar / next : auto.scrollbar) - auto.lineWidth) / 2), want))
			: want;
	}

	/**
	 * THE CENTRING, RECOMPUTED AGAINST THE GRANT THIS COMMIT JUST MADE, with whatever the page was actually showing
	 * booked as a debt for the scroll below to pay.
	 *
	 * `applyViewportBox` runs before `updateExtent`, so the margin it wrote was computed from the granted extent as it
	 * stood at the top of the commit. Under Infinite Canvas the extent then grows - measured 3072 -> 22528 on a tiny
	 * note at 10% - which leaves a centring that was correct when written and is stale by the end of the same commit.
	 * Nothing withdrew it there, so the page went on standing centred until the NEXT commit of any kind recomputed it
	 * and dropped it: measured 536.70 px on a bare commit at the same scale, no gesture behind it at all. That is the
	 * defect: it snaps on any commit rather than only at a lift. Not the device report about ink separating from
	 * text - this is page and column POSITION, and the anchor holds through it.
	 *
	 * Done BEFORE the frame is presented, so the stale value is never shown and there is usually nothing to pay. The
	 * debt is measured against what the page WAS showing - the previous commit's settled margin - and never against the
	 * stale write this call replaces, which the page never presented.
	 */
	private restColumnAgainstCurrentGrant(next: number, effective: number): void {
		const layout = this.viewportLayout;
		if (!layout || this.pinchPreview || layout.columnLocal === null) return;
		this.columnRestMargin = !layout.sizerColumn ? null : this.columnRestCentred(next, layout.externalScale * next);
		const settled = this.appliedColumnMargin(next), shown = this.restingColumnMargin;
		const host = this.view.dom, value = `${Math.max(0, this.columnRestMargin ?? (layout.sizerColumn || layout.ownLines ? this.columnMarginLocal(layout)! : 0))}px`;
		if (host.style.getPropertyValue("--handwriting-column-margin-left") !== value) host.style.setProperty("--handwriting-column-margin-left", value);
		this.restingColumnMargin = settled;
		if (shown === null || settled === shown) return;
		this.columnMarginDebt += (shown - settled) * effective;
	}

	/**
	 * THE MARGIN DEBT, PAID IN THIS COMMIT'S OWN SCROLL TARGET. Scroll and not pan, at a commit: a pan parked here is
	 * indistinguishable from the gesture residue `commitCameraScale` clears on any later commit carrying a scroll
	 * target, it cannot be reached at all by a commit with no gesture behind it (Fit, the zoom buttons, Ctrl+scroll
	 * establish no pan anchor hold), and a standing pan at rest costs on every path that assumes none.
	 *
	 * A positive debt owes the page a move RIGHT, which is a scroll LEFT, and the room for it is the scroll already
	 * taken. A negative debt owes a move left, and its room is the range past it. Anything the range cannot cover stays
	 * owed rather than being silently dropped, so a later commit with room pays the remainder.
	 */
	private columnMarginDebtScrollLeft(effective: number, left: number): number {
		const debt = this.columnMarginDebt;
		if (!debt || !Number.isFinite(left) || !(effective > 0)) return left;
		const scroller = this.view.scrollDOM, want = -debt / effective;
		const room = want > 0 ? Math.max(0, scroller.scrollWidth - scroller.clientWidth - left) : Math.max(0, left);
		const by = want > 0 ? Math.min(room, want) : -Math.min(room, -want);
		if (!Number.isFinite(by) || by === 0) return left;
		this.columnMarginDebt = debt + by * effective;
		return left + by;
	}

	/**
	 * THE PAN THAT PUTS A READABLE-LINE-LENGTH COLUMN AT ITS REST at scale
	 * `next`, painted px from where it sits with no pan and no scroll; null when
	 * the column has no inset to rest in.
	 *
	 * The rest is centred, which is what the setting means at every zoom. The
	 * layout does not centre it below 100%: the sizer's margin is
	 * `clamp(0, auto, frozen)` (styles.css, the note viewport's sizer), the frozen
	 * term holding the 100% margin in host px so that a margin re-centring by 1/k
	 * cannot open a blank band Infinite Canvas would scroll into. The difference
	 * between the centring the engine would give this column and the margin the
	 * clamp applies is carried as pan instead; above 100% the auto term already
	 * wins and this is 0. Arithmetic only, from the inputs `applyViewportBox`
	 * writes the auto term from, so a preview frame reads nothing for it.
	 *
	 * Keyed on the column itself, not the setting's class: its inset must BE the
	 * centring, a margin within a px of half the room beside the column at 100%.
	 * Null for a frozen margin of zero (Readable line length off), no measured
	 * inputs, a column as wide as the scroller's content (a pane narrower than the
	 * line), and an inset that is not centred (a theme's or a note's own left
	 * margin), which keeps its natural inset as before.
	 * Null too where the page does not fit the pane at this scale - the column, or
	 * ink granted room past it - since there the scroll is the rest, as it was.
	 */
	private columnRestPan(next: number, effective: number): number | null {
		const centred = this.columnRestCentred(next, effective);
		const layout = this.viewportLayout;
		if (centred === null || !layout || layout.columnLocal === null) return null;
		// A THEME THAT CENTRES ITS OWN LINES is its own rest: with the freeze lifted, the column sits where the theme centres
		// it at this zoom, so there is nothing for the overlay to add - not a margin, not a translate.
		//
		// KNOWN, WITH ITS NUMBER, and not fixed here: the theme centres the LINE, and it knows nothing about ink granted
		// room past the column, so where a note has some the theme's centring carries it out of the pane. Measured on Fit
		// with a stroke 3000 note px past the column under Minimal: the ink's right edge lands 16.31 px past the pane's
		// (1713.81 against 1697.5). Correcting it needs a carrier a no-gesture commit does not have - Fit takes no settle
		// and establishes no pan anchor, and the sizer margin is not the column's place under this theme - so it is a
		// resting translate, which is the cost this candidate exists to remove. Pinned as KNOWN in the cell, a decision
		// still open. Under Obsidian's own theme the centring is taken over the page's whole box, ink
		// included, and the ink stays inside the pane as it always did.
		if (layout.ownLines) return 0;
		// WHERE THE COLUMN ALREADY IS at pan zero, as a host-local margin. Where the sizer carries the column this is the
		// margin the stylesheet resolves - the one this frame wrote, clamped against the auto term - as before. Where it
		// does not (Minimal: a full-width sizer with the LINE centred inside it) the sizer's margin is not the column's
		// place at all, and the column sits at its own measured inset instead. Arithmetic either way: no forced read on a
		// preview frame, which is the reason this is not simply re-measured here.
		const rest = (centred - this.appliedColumnMargin(next)) * effective;
		return Number.isFinite(rest) ? rest : null;
	}

	/**
	 * THIS COMMIT'S SCROLL TARGET, WITH THE PAGE BOX PULLED BACK INSIDE THE PANE under a theme that centres its own
	 * lines. Returns `left` unchanged everywhere else, which is every path on Obsidian's own theme.
	 *
	 * Part 21 Edge 2's contract is that the PAGE BOX - the column plus whatever room ink has been granted past it -
	 * stays inside the pane at every commit. Obsidian's own theme meets it through the sizer margin, which
	 * `columnRestCentred` sizes over the whole box. A theme that centres its own LINES meets it for an ordinary note
	 * and breaks it for a note with far ink: the theme knows only the line, so it centres as if the page ended at the
	 * column and carries the ink out of the pane with it - measured on Fit with a stroke 3000 note px past the column
	 * under Minimal, 16 to 24 px past the pane's right edge.
	 *
	 * `own` below is where the theme puts the page's left edge: half the room beside the COLUMN's box, which is all it
	 * knows. From there the box's right edge is `own + width`, and whatever that is past the pane, measured from the
	 * scroll this commit is about to take, is the debt. THE MINIMUM, not a re-centring: centring the box instead moved
	 * the page 247 px where 16 were owed. An ordinary note has `width` equal to the column's own box, which makes the
	 * overflow negative and the debt zero, so an ordinary page is never scrolled by this.
	 *
	 * PAID IN SCROLL, in this commit's own scroll target, and never as a pan. A pan parked here is indistinguishable
	 * from the gesture residue `commitCameraScale` clears on any later commit carrying a scroll target, which made an
	 * earlier attempt at this intermittent (the same fixture read 0.81, 8.81 and 16.31 px). Scroll survives, and the
	 * room is there by construction: ink granted room past the column IS scrollable range - measured 471 local px on
	 * the arm that needs it, against the ~66 local px it asks for.
	 *
	 * Measured from `left` rather than from the live scroll, so this is idempotent: a commit re-running against an
	 * already-corrected page computes a debt of zero rather than paying it twice.
	 */
	private ownLinesPageBoxScrollLeft(next: number, effective: number, left: number): number {
		const layout = this.viewportLayout;
		if (!layout || !layout.ownLines || !(effective > 0) || !Number.isFinite(left)) return left;
		const width = this.pageContentWidth() * effective;
		const span = layout.width * layout.externalScale - layout.gutterScreen;
		// The same fit gate `columnRestCentred` takes: where the page does NOT fit the pane the scroll is already the
		// rest, as it always was, and this owes nothing.
		if (!(width > 0 && width <= span + PAN_FIT_SLACK_PX)) return left;
		// The line inset is frozen at its 100% value (styles.css own-lines rule), so the column sits at that inset,
		// clamped by the theme's auto term above 100%, and no longer at the centre of the widened box.
		const own = Math.max(0, this.appliedColumnMargin(next) * effective);
		const overflow = own + width - span - left * effective;
		if (!Number.isFinite(overflow) || !(overflow > PAN_FIT_SLACK_PX)) return left;
		const scroller = this.view.scrollDOM;
		const room = Math.max(0, scroller.scrollWidth - scroller.clientWidth - left);
		const by = Math.min(room, overflow / effective);
		return by > 0 ? left + by : left;
	}

	/**
	 * THE FIT QUESTION SURVIVES THE CENTRED REST. Two settle sites asked "does the column have a
	 * rest to sit in" by testing `columnRestPan !== null`, and used the answer for something else: a page that
	 * fits the pane never settles onto a sideways SCROLL (its place is the margin, and a scroll left standing
	 * displaces it by its whole width - measured at :8622, 57 px of column off the pane). With the centred rest
	 * gone that answer went false everywhere, and the 25 -> 100 round trip missed the text by 1079 px.
	 * The predicate is the fit half of what columnRestCentred used to compute, and only that.
	 */
	private columnFitsPane(next: number, effective: number): boolean {
		const layout = this.viewportLayout;
		if (!layout || !layout.columnInset || !(next > 0) || !(effective > 0)) return false;
		if (this.canvasMode) return false;
		const width = this.pageContentWidth() * effective;
		const span = layout.width * layout.externalScale - layout.gutterScreen;
		return width > 0 && width <= span + PAN_FIT_SLACK_PX;
	}

	private columnRestCentred(_next: number, _effective: number): number | null {
		// ALAN DIRECT, AND IT RETIRES THIS QUANTITY: "I don't want it to center anywhere."
		// The contract: Readable line length moves the LEFT BOUND to the column's border and does
		// nothing else; the viewport is otherwise Obsidian's own, and zoomed out the note sits top-left. The
		// plugin never adds a centring rest under either setting, so there is nothing here to compute.
		//
		// WHAT IT USED TO DO, kept because the numbers are the reason it is gone: it centred the page in the
		// room beside it and returned that as a HOST-LOCAL margin, so the value grew as the zoom fell.
		// Measured on Alan's device (Orion, fresh Untitled, Readable line length OFF, opened at 100% and
		// pinched to 10%): --handwriting-column-margin-left written at 4292.70px, the sizer 432.46 px right of
		// the scroller, "Untitled" mid-top. Measured in the rig on a theme-narrow column, setting off: 6588.50px.
		// It read `layout.columnInset` to decide there was a column to centre, and that flag is true of any page
		// that fits its scroller - which at 10% is every page.
		//
		// THE COLUMN'S OWN PLACE IS UNTOUCHED. With the setting on, `columnRestMargin` now falls through to
		// `columnLocal` - Obsidian's own margin for the readable column - so the column still sits where
		// Obsidian puts it and the left bound still lands on its border. We simply stop adding anything.
		return null;
	}

	/**
	 * The margin a RESTING frame gives a centred column, or null while a gesture is live (the pan holds it then) and for
	 * every column that has no rest. Set on each commit before `applyViewportBox` writes the box; cleared for preview
	 * frames, which keep the frozen margin so no layout moves under the fingers.
	 *
	 * WHERE A CENTRED COLUMN RESTS at scale `next`, as a host-local margin, or null when this column has no rest (the
	 * guards are the ones above). `applyViewportBox` writes it as the sizer's margin at rest, so the resting page needs no
	 * pan; `columnRestPan` reads it too, and returns the difference the layout has not taken.
	 */
	private columnRestMargin: number | null = null;

	/** The resolved margin the last RESTING frame left the page at, host-local. Null until the first one. */
	private restingColumnMargin: number | null = null;

	/**
	 * Screen px the page is owed because a RESTING commit moved the margin under it. A regime change - the page ceasing
	 * to fit the pane, so the centring is withdrawn - is a change of law, not of position, and the page may not move on
	 * its own for it. Accrued at the box write and paid by the settle in the same commit.
	 */
	private columnMarginDebt = 0;

	/** Counted whenever the settle's clamp moved a pan on a FITTING axis, with the largest correction so far. */
	private panBoundHits = 0;
	private panBoundMaxPx = 0;
	/**
	 * The page is being held past an end by the finger. Painted here, live, on the same
	 * offset the bounce uses - `panX`/`panY` already add it, so one write shows it on the
	 * sizer, the paper and the ink together and nothing else has to learn about it.
	 *
	 * The scroller's own offset is not touched: the router kept it inside its range, and
	 * this give is visual for as long as the hand holds it.
	 *
	 * Alan 2026-09-21, the slide ships in 1.4.20: `travelled` marks a correction that is the page's own MEASURED
	 * travel across the commit (painted before minus landed), not a bound's share. The direction rule above is about a
	 * bound with nothing to bounce off; measured travel is a move the viewer would otherwise see land in one frame
	 * whichever way it points (measured: a held-out page let go at scrollLeft 500 closed 154 px leftward-signed in the
	 * lift's own frame), so it is eased in both directions. Callers that pass a bound's share keep the rule.
	 */
	private holdOverscrollGive(x: number, y: number): void {
		const offset = this.bounceOffset;
		if (!offset) return;
		// A give that arrives mid-bounce replaces it: the finger is back on the glass and
		// owns the page again.
		if (this.bounceState) this.cancelOverscrollBounce();
		// THE GIVE IS MEASURED FROM THE REST, NOT FROM WHERE THE FINGER LANDED. The cancel above
		// folds what the spring still owed into the standing pan (so the page does not jump
		// under the finger), and the router's pull starts from zero on every gesture. Painted as it
		// arrived, the page then stood the allowance PAST that fold - and a hand that grabbed early in
		// each spring and pulled again walked the page out by nearly the allowance per grab (Alan,
		// device, 2026-09-20: "repeatedly left scroll, lift, left scroll" goes way out of bounds).
		// So the pull is applied to the page's standing overshoot past its bound - the same bound the
		// lift's resume measures against - and the total is held to the allowance: a page already
		// standing out is pulled no further than the allowance itself, a pull back inward is
		// carried in full, and a page inside its bound gives exactly as before.
		const pan = this.viewportPan, px = pan?.x ?? 0, py = pan?.y ?? 0;
		const give = OVERSCROLL_GIVE_PX * (this.viewportLayout?.externalScale ?? 1);
		const standX = px - (this.canvasMode ? Math.min(px, 0) : Math.max(this.boundReadout.floorX, Math.min(px, 0)));
		const standY = py - (this.canvasMode ? Math.min(py, 0) : Math.max(this.boundReadout.floorY, Math.min(py, 0)));
		// THE ORIGIN SIDE ONLY, and never past the allowance. The lower bound is 0, not -give: a
		// negative total is the page held past a FAR end, which in canvas mode is room rather than a
		// boundary, so a step refused there paints no pull. The upper bound is unchanged.
		const gx = Number.isFinite(give) ? Math.max(0, Math.min(give, standX + x)) - standX : x;
		const gy = Number.isFinite(give) ? Math.max(0, Math.min(give, standY + y)) - standY : y;
		if (offset.x === gx && offset.y === gy) return;
		if (offset.x === 0 && offset.y === 0) this.beginPreviewPaper();
		offset.x = gx;
		offset.y = gy;
		this.writeViewportPan();
	}

	/** The hand is off: send the give home through the one return the lift already has. */
	private releaseOverscrollGive(): void {
		const offset = this.bounceOffset;
		if (!offset) return;
		const x = offset.x, y = offset.y;
		// A RELEASE WITH NOTHING HELD STILL SENDS A STANDING PAGE HOME. With the give measured
		// from the rest, a finger that lands on a page already standing the allowance past its end
		// holds nothing (its pull adds no offset), and its lift used to return here at once - the page
		// then stayed out until the next contact. The resume below measures the way home from the
		// standing pan and is a no-op when nothing is owed, so it is the right call either way.
		// ONE RETURN MECHANISM. The give goes back through `resumeStrandedPan`, the same
		// method a lift already uses for a pan left standing, rather than starting a bounce
		// of its own. That method measures the way home from the STANDING pan, and the give
		// is not in the standing pan - it is in this offset - so fold it in first. A bare
		// hand-off finds no distance to cover, does nothing, and leaves the page held out
		// past the end.
		offset.x = 0;
		offset.y = 0;
		const pan = this.viewportPan;
		pan.x += x;
		pan.y += y;
		if (this.resumeStrandedPan()) return;
		// Nothing was held and nothing is owed (or a spring already running carries it): leave
		// the page and its paper exactly as they are.
		if (x === 0 && y === 0) return;
		// It would not take it: a bounce already running, a preview holding the frame, or a
		// give too small to animate. Put the page back on the bound and take the preview
		// paper down - what a refused bounce did here before.
		pan.x -= x;
		pan.y -= y;
		this.endPreviewPaper("bounce-end");
		this.writeViewportPan();
	}

	/**
	 * Start the bounce for the settle `hold`, from the overshoot `dx`/`dy` (the
	 * clamp's correction, painted px, requested minus accepted). A settle
	 * re-anchoring itself on a later frame does not bounce again, whether its
	 * bounce is still playing or has ended: that would put the page back at the
	 * overshoot.
	 *
	 * Per axis, and not where Infinite Canvas is on in that direction: a page
	 * pushed left or up shows the room scrolling would grow into there, so there
	 * is no boundary to bounce off (the correction then lands as it always did).
	 * A page pushed right or down shows the note's origin edge, which Infinite
	 * Canvas never extends past, so it bounces either way.
	 */
	private startOverscrollBounce(hold: object, dx: number, dy: number, travelled = false): boolean {
		const offset = this.bounceOffset;
		// The unit fixtures drive the settle against partial objects built with Object.create: no class fields, no bounce.
		if (!offset || this.bouncedHold === hold) return false;
		// A LEFTWARD OR UPWARD EASE SHOWS THE INK RASTER'S FAR EDGE. The ink canvases ride the page by the same
		// offset, and they cover the pane plus the band margin and no more (measured: 185 to 200 px spare at rest; an
		// offset of -326 left 141 px of the pane's right with no ink raster while the ease played). So measured travel in
		// that direction is eased only as far as the raster already covers; past that it lands in the commit's frame,
		// as it did before the slide. One rect pair, at the settle only, and only when such a correction exists.
		let coverX = Infinity, coverY = Infinity;
		if (travelled && this.canvasMode && (dx < 0 || dy < 0)) {
			const ink = this.committedCanvas?.getBoundingClientRect?.(), pane = this.view?.scrollDOM?.getBoundingClientRect?.();
			coverX = ink && pane ? Math.max(0, ink.right - pane.right) : 0;
			coverY = ink && pane ? Math.max(0, ink.bottom - pane.bottom) : 0;
		}
		const bx = Math.abs(dx) >= OVERSCROLL_BOUNCE_MIN_PX && !(this.canvasMode && dx < 0 && (!travelled || -dx > coverX)) ? dx : 0;
		const by = Math.abs(dy) >= OVERSCROLL_BOUNCE_MIN_PX && !(this.canvasMode && dy < 0 && (!travelled || -dy > coverY)) ? dy : 0;
		if (bx === 0 && by === 0) return false;
		this.cancelOverscrollBounce();
		this.bouncedHold = hold;
		offset.x = bx; offset.y = by;
		// THE BOUNCE MOVES THE PAGE, so it moves the paper the way a preview does: on the element, by a transform, not by
		// re-rastering the scroller's background every frame. The copy is taken here, after the settle, so it is the
		// settled zoom's rules the bounce carries. Its last frame takes the element down again.
		this.beginPreviewPaper();
		// This window's clock: the frames below are stamped by it, and a popout's is not the main window's (audit 59).
		const state = { hold, fromX: bx, fromY: by, startedAt: this.winRef.performance.now(), raf: 0 };
		this.bounceState = state;
		const step = (now: number): void => {
			if (this.bounceState !== state) return;
			const t = Math.min(1, Math.max(0, (now - state.startedAt) / OVERSCROLL_BOUNCE_MS));
			// Ease out: fast off the overshoot, settling gently onto the rest, never past it.
			const left = t >= 1 ? 0 : (1 - t) ** 3;
			// Exactly zero at the end, not the -0 a negative overshoot times zero leaves.
			offset.x = left === 0 ? 0 : bx * left; offset.y = left === 0 ? 0 : by * left;
			this.writeViewportPan();
			// The page is at its rest: a preview paper that rode the bounce comes down on this frame.
			// The compare in syncCamera sat out the bounce; one sync now asks for the repaint a moved camera owes.
			if (t >= 1) { this.bounceState = null; this.endPreviewPaper("bounce-end"); this.syncCamera(); return; }
			state.raf = this.winRef.requestAnimationFrame(step);
		};
		state.raf = this.winRef.requestAnimationFrame(step);
		scrollProbeExtent(`overscroll bounce from ${bx.toFixed(2)},${by.toFixed(2)} px`);
		return true;
	}

	/** Put the page on its rest now, ending a bounce wherever it is: before an input is mapped, a new gesture, a teardown. */
	private cancelOverscrollBounce(): void {
		const offset = this.bounceOffset, state = this.bounceState;
		if (!offset || (!state && offset.x === 0 && offset.y === 0)) return;
		if (state?.raf) this.winRef.cancelAnimationFrame(state.raf);
		this.bounceState = null;
		// A CANCELLED EASE LEAVES THE PAGE WHERE IT IS. What the viewer sees is
		// `pan + offset`, so zeroing the offset on its own drops the page by whatever the ease still had
		// to run - measured, the seed release arrived at -225.20 and -244.50 against the -300.00 it owed,
		// and on that arm no ease ever reached its last frame because the next gesture cancels it. The
		// remainder folds into the pan here, which moves nothing on screen and leaves the page under the
		// fingers that grabbed it. Every cancel site inherits it.
		// Infinite Canvas ON keeps 3578f29e's drop, byte-identical.
		// Alan direct, "yes fix it": BOTH SETTINGS. The fold is what keeps a page from
		// jumping when an ease is cut, and that is as true with Infinite Canvas on as off; the earlier
		// byte-identical rule is relaxed for this one site by his word. Everything else on the IC-on
		// path stays 3578f29e.
		if (offset.x !== 0 || offset.y !== 0) {
			this.viewportPan.x += offset.x; this.viewportPan.y += offset.y;
		}
		offset.x = 0; offset.y = 0;
		this.writeViewportPan();
	}

	/**
	 * EVERY CONTACT IS GONE AND NOTHING CLAIMED THE VIEWPORT. A tap, a palm or a pen stroke calls
	 * `onViewportInput` at its own pointerdown (InlinePenRouter.pointerDown, before it knows what the
	 * contact is), which cancels a playing ease; the fold leaves the difference sitting in
	 * `viewportPan` rather than dropping it, so the page is exactly where it was, just no longer easing
	 * anywhere. A real gesture's own settle already drives the page to its rest before this fires, so in
	 * that case there is nothing left to do here - this only ever finds work behind a contact that owned
	 * nothing. The rest is not always 0: a page bigger than its room keeps the far-end floor,
	 * read off the last settle's own numbers (`boundReadout`, no scale change since) rather than
	 * recomputed here. Park the standing pan at that bound and ease the difference back in as the bounce
	 * offset, so the page keeps painting exactly where it stood and glides on from there.
	 */
	private resumeStrandedPan(): boolean {
		if (this.bounceState || this.pinchPreview || this.frame.locked) return false;
		const pan = this.viewportPan;
		// SCROLL BEYOND THE LEFT RESERVE IS PAID FIRST. A pan standing right of the ceiling while the scroller holds scroll
		// past the reserve is the same world place as less pan and less scroll, so that much is paid into the scroll in this
		// frame and the screen does not move. The reserve's own scroll is never paid: it is room for ink left of the page,
		// reached by scrolling, so the rest of the pan eases back below and the page slides to its edge with the margin ink
		// off-screen left. A scroll already inside the reserve (the user scrolled there) pays nothing and is kept.
		if (pan.x > 0) {
			const scroller = this.view.scrollDOM, scale = this.cssScale > 0 ? this.cssScale : 1, before = scroller.scrollLeft;
			const reserve = this.leftReserveHeld > 0 ? this.leftReserveHeld : 0;
			const want = Math.min(pan.x, Math.max(0, before - reserve) * scale);
			if (want > 0) {
				this.setViewportScroll(before - want / scale, scroller.scrollTop);
				// What the range actually moved, not what was asked: scrollLeft rounds.
				pan.x -= (before - scroller.scrollLeft) * scale;
				this.writeViewportPan();
			}
		}
		// The bound the last settle left standing, at the scale still in force (no zoom since): a ceiling of 0
		// always, and IC off only, a floor too - byte-identical to 3578f29e with it on.
		const targetX = this.canvasMode ? Math.min(pan.x, 0) : Math.max(this.boundReadout.floorX, Math.min(pan.x, 0));
		const targetY = this.canvasMode ? Math.min(pan.y, 0) : Math.max(this.boundReadout.floorY, Math.min(pan.y, 0));
		const dx = pan.x - targetX, dy = pan.y - targetY;
		if (dx === 0 && dy === 0) return false;
		pan.x = targetX; pan.y = targetY;
		if (!this.startOverscrollBounce({}, dx, dy)) { pan.x += dx; pan.y += dy; return false; }
		this.writeViewportPan();
		return true;
	}

	/** The bounce as it stands, read-only, for a fixture that has to see it rather than infer it from positions. */
	overscrollBounceReadout(): { active: boolean; x: number; y: number; fromX: number; fromY: number; startedAt: number | null; restX: number; restY: number;
		floorX: number; floorY: number; bx: number; width: number; rawX: number; cx: number; rawY: number; cy: number } {
		const s = this.bounceState;
		return { active: !!s, x: this.bounceOffset.x, y: this.bounceOffset.y, fromX: s?.fromX ?? 0, fromY: s?.fromY ?? 0, startedAt: s?.startedAt ?? null,
			restX: this.restPanX(), restY: this.restPanY(),
			// The bound's own geometry from the last settle.
			floorX: this.boundReadout.floorX, floorY: this.boundReadout.floorY, bx: this.boundReadout.bx, width: this.boundReadout.width,
			rawX: this.boundReadout.rawX, cx: this.boundReadout.cx, rawY: this.boundReadout.rawY, cy: this.boundReadout.cy };
	}

	private notePanBound(fits: boolean, requested: number, accepted: number): void {
		if (!fits || !(Number.isFinite(requested) && Number.isFinite(accepted)) || accepted === requested) return;
		this.panBoundHits++;
		const by = Math.abs(accepted - requested);
		if (by > this.panBoundMaxPx) this.panBoundMaxPx = by;
	}

	/** Read-only: the drag-frame gate's inputs on the last preview frame. */
	dragGateReadout(): { dragFrame: boolean; neverZoomed: boolean; steady: boolean; next: number; fromScale: number; fromScaleValid: boolean;
		rawX: number; cx: number; rawY: number; cy: number; restCeilX: number; startX: number; startY: number; lastX: number; lastY: number;
		bounded: boolean; settling: boolean; floorX: number; floorY: number } {
		const b = this.boundReadout;
		return { dragFrame: b.dragFrame, neverZoomed: b.neverZoomed, steady: b.steady, next: b.next, fromScale: b.fromScale,
			fromScaleValid: b.fromScaleValid, rawX: b.rawX, cx: b.cx, rawY: b.rawY, cy: b.cy, restCeilX: b.restCeilX,
			startX: b.startX, startY: b.startY, lastX: b.lastX, lastY: b.lastY, bounded: b.bounded, settling: b.settling,
			floorX: b.floorX, floorY: b.floorY };
	}

	/**
	 * The fit quantities the settle bounds by, read-only, for a fixture that has
	 * to check its own regime against the code's rather than re-derive it from
	 * the DOM. Sizes are painted px at the scale in force.
	 */
	panFitReadout(): { fitsX: boolean; fitsY: boolean; contentX: number; contentY: number; viewportX: number; viewportY: number; boundHits: number; boundMaxPx: number } {
		const layout = this.viewportLayout;
		const path = this.filePath(), extent = (path ? surfaceExtents.get(path) : null) ?? { x: 0, y: 0 };
		const effective = layout ? this.pinchScaleNow * layout.externalScale : this.pinchScaleNow;
		// THE SAME QUANTITY THE PREDICATE TAKES. A readout that answers "does it fit" from a different
		// width than the code does agrees with the product exactly until the two definitions diverge,
		// which is the case this whole fix is about - and a fixture reading it would inherit the lie.
		const contentX = this.pageContentWidth() * effective;
		const contentY = Math.max(this.view?.contentHeight ?? 0, extent.y * this.fontZoom) * effective;
		const viewportX = layout ? layout.width * layout.externalScale - layout.gutterScreen : 0;
		const viewportY = layout ? layout.paneHeight * layout.externalScale : 0;
		return { fitsX: this.panAxisWindow(contentX, viewportX).fits, fitsY: this.panAxisWindow(contentY, viewportY).fits,
			contentX, contentY, viewportX, viewportY, boundHits: this.panBoundHits, boundMaxPx: this.panBoundMaxPx };
	}

	/**
	 * Put back, as pan, whatever the scroll write could not deliver.
	 *
	 * The browser clamps `scrollLeft`/`scrollTop` to the range the surface has
	 * actually grown into, and positions what it does accept on whole pixels -
	 * both silently. A settle that asked for more than that would otherwise land
	 * the note somewhere the preview never showed: a jump at pinch end, in the
	 * direction of the clamp. Re-measuring here and re-deriving the pan makes
	 * the settled frame agree with the last preview frame whether the scroll
	 * arrived in full, in part, or not at all - and leaves the pan at zero in
	 * the ordinary case where it did.
	 */
	private reanchorPan(): void {
		const hold = this.panAnchorHold;
		if (!hold) return;
		if (!this.ownsPanSettle(hold)) { if (this.panAnchorHold === hold) this.retirePanSettle("ownership lost before the anchor pan"); return; }
		// Read the owned column without its pan. Subtracting a full-precision
		// pan from the browser's rounded transformed rect feeds a small error
		// back into every iteration and can prevent exact convergence.
		const sizer = this.panSizer();
		if (!sizer) return;
		const transform = sizer.style.transform;
		let local: number | null = null, top: number | null = null;
		try {
			sizer.style.removeProperty("transform");
			const host = this.view.dom.getBoundingClientRect();
			const column = contentOriginLeft(this.view.contentDOM);
			const content = this.view.contentDOM.getBoundingClientRect();
			this.previewHostOrigin = { left: host.left, top: host.top, valid: true };
			local = column === null ? null : (column - host.left) / hold.toScale;
			top = (content.top - host.top) / hold.toScale;
		} finally { sizer.style.transform = transform; }
		const ratio = hold.toScale / hold.fromScale;
		const zoomed = Number.isFinite(ratio) && (ratio < PAN_SETTLE_ZOOM_BAND.below || ratio > PAN_SETTLE_ZOOM_BAND.above);
		this.anchorPanTo(hold.toScale, hold, local, top, zoomed);
		hold.left = this.view.scrollDOM.scrollLeft; hold.top = this.view.scrollDOM.scrollTop;
	}

	private get scrollRangeOwners(): WeakMap<SelectionRange, object> {
		return viewportScrollLifetime(this.view).owners;
	}

	/** Preserve the public range value while carrying provenance through the
	 * actual mapping performed by CM. Only the private wrapper is registered;
	 * a fresh foreign range with identical positions remains unrelated.
	 */
	private ownScrollRange(range: SelectionRange, owner: object): SelectionRange | null {
		if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from < 0 || range.to > this.view.state.doc.length) return null;
		const wrappers = new WeakMap<SelectionRange, SelectionRange>();
		const wrap = (original: SelectionRange): SelectionRange => {
			const existing = wrappers.get(original);
			if (existing) return existing;
			const map = (...args: Parameters<SelectionRange["map"]>): SelectionRange =>
				wrap(original.map(...args));
			const wrapped = new Proxy(original, {
				get: (target, key, receiver): unknown => key === "map" ? map : Reflect.get(target, key, receiver),
			});
			wrappers.set(original, wrapped);
			this.scrollRangeOwners.set(wrapped, owner);
			return wrapped;
		};
		return wrap(range);
	}

	private firstSettleConsumer(): boolean {
		return this.view.state.facet(EditorView.scrollHandler)[0] === consumeViewportScroll;
	}

	/** A receipt survives cancellation so its pending request cannot become a
	 * default scroll. This consumer never changes geometry or dispatches.
	 */
	consumeViewportScroll(range: SelectionRange): boolean {
		const owner = this.scrollRangeOwners.get(range);
		if (!owner) { this.retirePanSettle("a scroll request the overlay did not issue"); return false; }
		const hold = this.panAnchorHold;
		if (hold === owner) {
			if (!this.ownsPanSettle(hold) || this.view.scrollDOM.scrollLeft !== hold.left || this.view.scrollDOM.scrollTop !== hold.top) hold.outcome = "cancelled";
			else if (!hold.ready) { hold.outcome = "failed"; console.warn("Pinch settlement consumed before convergence"); }
			else hold.outcome = "converged";
			this.retirePanSettle("consumed");
		}
		return true;
	}

	/** `reason` names the caller; a hold retired while still pending is logged
	 * with it through the scroll probe, so a cancelled settle is never silent. */
	private retirePanSettle(reason: string): void {
		const hold = this.panAnchorHold;
		if (this.bouncedHold === hold) this.bouncedHold = null;
		if (hold?.outcome === "pending") {
			hold.outcome = "cancelled";
			scrollProbeExtent(`settle hold cancelled while pending: ${reason}`);
		}
		this.panAnchorHold = null;
	}

	private ownsPanSettle(hold: NonNullable<InkOverlayPlugin["panAnchorHold"]>): boolean {
		return this.panAnchorHold === hold && hold.generation === this.viewportGeneration &&
			hold.path === this.filePath() && hold.container === this.container && !!this.container &&
			!this.retiring && !this.frame.locked;
	}

	/** Take the pan off the children; every exit from a gesture lands here. */
	private clearViewportPan(): void {
		this.cancelOverscrollBounce();
		this.restorePinchLayers();
		this.previewPanEngaged = false;
		this.retirePanSettle("the pan was cleared");
		this.previewColumnLocal = null;
		if (this.previewHostOrigin) this.previewHostOrigin.valid = false;
		const pan = this.viewportPan;
		const had = !pan || pan.x !== 0 || pan.y !== 0;
		if (pan) { pan.x = 0; pan.y = 0; }
		// Written even when the pan was already zero on the `!pan` branch: the
		// unit fixtures have no field to read, and a stale transform left on a
		// real `.cm-sizer` outlives this overlay.
		if (had) this.writeViewportPan();
		this.panSizerEl = null;
	}

	/**
	 * Hold ONE repaint until the pinch deferral lapses.
	 *
	 * Idempotent: while the latch is set nothing new is scheduled, so a gesture
	 * of any length costs one timer and no per-frame work. The timer re-arms
	 * itself only while the deferral is still in force, which a live gesture
	 * keeps true; a settle clears the latch through `clearDeferredRepaint`
	 * before this can matter.
	 */
	private armDeferredRepaint(): void {
		if (this.repaintDeferredByPinch) return;
		this.repaintDeferredByPinch = true;
		const tick = (): void => {
			this.pinchDeferTimer = 0;
			if (!this.container) { this.repaintDeferredByPinch = false; return; }
			if (!this.repaintDeferredByPinch) return;
			if (this.deferPinchRaster()) {
				this.pinchDeferTimer = this.winRef.setTimeout(tick, PINCH_SCROLL_QUIET_MS);
				return;
			}
			this.repaintDeferredByPinch = false;
			// "partial" preserves the pending rects; every other via asserts
			// `damage.addAll()` and would escalate them to a full re-raster.
			this.scheduleRepaint("partial");
		};
		this.pinchDeferTimer = this.winRef.setTimeout(tick, PINCH_SCROLL_QUIET_MS);
	}

	/** The deferral is over and the raster is being redrawn anyway. */
	private clearDeferredRepaint(): void {
		this.repaintDeferredByPinch = false;
		if (this.pinchDeferTimer) {
			this.winRef.clearTimeout(this.pinchDeferTimer);
			this.pinchDeferTimer = 0;
		}
	}

	/**
	 * Keep CodeMirror from measuring for the preview lifetime.
	 *
	 * THE WRITER OF THE MID-PREVIEW SCROLL IS CODEMIRROR. Every preview frame
	 * writes the counter-sized host box and its scale; CodeMirror's observer
	 * schedules a measure for that, and `EditorView.measure` (6.38.6) reads
	 * `scrollTop` with its previous `scaleY`, refreshes the scale, then writes
	 * `scrollTop = S x k_prev / k_next` back, keeping its scaled scroll
	 * constant across a scale change its ancestor made. That write lands in
	 * CodeMirror's animation frame, after this frame's pan solve and before
	 * the paint, so the pan is one rescale behind on every frame it runs.
	 * Measured on the far fixture at scrollTop 114820, k 0.10 -> 0.11: the
	 * write was 105252, about 1052 visual px, and text and ink left the pane
	 * together, registration intact (2026-09-13, lag-far-xy-fixture d4nav2).
	 * The preview needs no measure of its own: it is a transform and a
	 * translate, and its reads are client rects. So the scheduling entry is
	 * held for the preview and released on every end path, where CodeMirror
	 * then measures once against the settled layout, which is also where the
	 * plugin's own settle requests go. Other callers' requests made meanwhile
	 * are kept, last per key as CodeMirror itself keeps them, and replayed at
	 * the release. What goes with the write: the two or three CodeMirror
	 * measures a preview frame paid before.
	 *
	 * TWO ENTRIES ARE SHADOWED on the instance, and both are needed.
	 * `requestMeasure`, the public scheduler, is where the resize debounce,
	 * the mutation flush and every other caller arrive. `measure`, the sink,
	 * is where a callback CodeMirror scheduled BEFORE the hold went on still
	 * arrives (its animation frame resolves `this.measure` at call time), and
	 * where the synchronous measure a scroll event runs arrives - and the
	 * browser raises a scroll event on its own when a zoom-out shrinks the
	 * scroll range under a far scroll and clamps it. Holding the scheduler
	 * alone leaves both of those to rescale the scroll under the pan.
	 * `measure` is not in CodeMirror's typings (marked internal); a build
	 * where it is absent degrades to holding the scheduler only.
	 *
	 * A swallowed callback leaves CodeMirror's own "measure scheduled" mark
	 * set, and its public scheduler queues without scheduling while that mark
	 * is set, so the release does not rely on it: when anything was held, the
	 * release runs the captured `measure` itself in the next animation frame,
	 * which drains every queued request and clears the mark (a destroyed view
	 * returns from it at once). Each shadow is inert once its hold is over:
	 * a caller that kept the function, or a wrapper that displaced it, reaches
	 * the callable captured at install, never the live property, so no wrapper
	 * chain can loop. The release puts back what it displaced only where the
	 * property is still its own. Re-armed on every preview frame;
	 * PINCH_MEASURE_HOLD_MAX_MS bounds a lost end (`rebasePinch`).
	 */
	private holdMeasures(): void {
		const view = this.view as EditorView | null;
		if (!view) return;
		const held = this.measureHold ?? null;
		if (held) {
			this.winRef.clearTimeout(held.timer);
			held.timer = this.winRef.setTimeout(() => this.rebasePinch(), PINCH_MEASURE_HOLD_MAX_MS);
			return;
		}
		const hold: MeasureHold = { entries: [], requests: [], plain: false, swallowed: false, timer: 0 };
		const target = view as unknown as Record<string, unknown>;
		for (const name of ["requestMeasure", "measure"] as const) {
			const displaced = Object.getOwnPropertyDescriptor(view, name);
			const resolved: unknown = displaced ? (displaced.get ? displaced.get.call(view) : displaced.value) : (Object.getPrototypeOf(view) as Record<string, unknown> | null)?.[name];
			if (typeof resolved !== "function") continue;
			const callable = resolved as MeasureHoldEntry["callable"];
			const shadow = name === "requestMeasure"
				? (request?: CmMeasureRequest): void => {
					if (this.measureHold !== hold) { callable.call(view, request); return; }
					if (!request) { hold.plain = true; return; }
					if (hold.requests.includes(request)) return;
					const key: unknown = request.key;
					const at = key == null ? -1 : hold.requests.findIndex((r) => r.key === key);
					if (at > -1) hold.requests[at] = request; else hold.requests.push(request);
				}
				: (flush?: boolean): void => {
					if (this.measureHold !== hold) { callable.call(view, flush); return; }
					hold.swallowed = true;
				};
			Object.defineProperty(target, name, { configurable: true, writable: true, enumerable: false, value: shadow });
			hold.entries.push({ name, displaced, callable, shadow: shadow as MeasureHoldEntry["shadow"] });
		}
		// COMPATIBILITY LIMIT, not an observed case: CodeMirror 6.38.6 has
		// `measure` on the instance chain and every build measured had it. In
		// a build without it the supported fallback is the scheduler-only
		// hold: the preview, the clip lift and the settle proceed; requests
		// through `requestMeasure` are still held and replayed; but a measure
		// entered synchronously (a scroll event, an intersection flip) would
		// rescale the scroll under the pan, and the release's plain
		// `requestMeasure()` cannot put the fold before the settle write. The
		// warning names that once per gesture; `measureHold.entries` says
		// which entries were found, for the arms that read the hold state.
		if (!hold.entries.some((e) => e.name === "measure")) console.warn("Handwriting: pinch preview holds CodeMirror's scheduler only; view.measure was not found");
		hold.timer = this.winRef.setTimeout(() => this.rebasePinch(), PINCH_MEASURE_HOLD_MAX_MS);
		this.measureHold = hold;
		// THE CONTAINER'S CLIP COMES OFF FOR THE SAME LIFETIME. With the scroll
		// held, the focal pan carries the whole move, and the inner layer's
		// translate takes the canvases out of the band-sized, overflow-hidden
		// container, which clips them (measured 2026-09-13, zoom-out to k 0.3
		// at scrollTop 1809: translate 983 layout px, the mark inside the band
		// and inside the pane, and absent). `.cm-sizer` carries the same
		// translate with no clip of its own, so the pixels land where the text
		// does. One style write per gesture; the clip returns with the release.
		this.container?.setCssStyles({ overflow: "visible" });
	}

	/**
	 * A resize met inside CodeMirror's update while the measure hold is live,
	 * run whole in the next frame with the state re-checked: the same view,
	 * note and viewport generation, and a container still mounted. Outside
	 * the update its commit releases the hold the ordinary way, fold first.
	 */
	private resizeOutOfUpdate(): void {
		if (this.resizeOutOfUpdateRaf) return;
		const view = this.view, path = this.filePath(), generation = this.viewportGeneration;
		this.resizeOutOfUpdateRaf = this.winRef.requestAnimationFrame(() => {
			this.resizeOutOfUpdateRaf = 0;
			if (this.retiring || !this.container || this.view !== view || this.filePath() !== path || this.viewportGeneration !== generation) return;
			this.handleResize();
		});
	}

	/**
	 * Give CodeMirror its measuring back and replay what was held. Idempotent;
	 * every end path calls it.
	 *
	 * THE FOLD COMES FIRST. CodeMirror's first measure after a scale change
	 * rescales `scrollTop` by the scale ratio it missed; on the settle path
	 * that measure must land BEFORE the settle's own scroll write, as it did
	 * when CodeMirror measured every frame, so the settle overwrites the fold
	 * and not the other way round (measured 2026-09-13 with the fold replayed
	 * a frame later: zoom-in 1 -> 2 settled at scrollTop 969 for 2048). So
	 * the captured `measure` runs synchronously here whenever anything was
	 * held; a teardown passes `deferred` and gets it in the next frame, since
	 * an unmount can run inside CodeMirror's own update.
	 */
	private releaseMeasures(deferred = false): void {
		const hold = this.measureHold ?? null;
		if (!hold) return;
		if (this.inUpdate && !deferred) {
			// The net, not a route: see `update`. Named so it can be found.
			console.warn("Handwriting: measure hold released inside CodeMirror's update; measure deferred a frame", new Error().stack);
			deferred = true;
		}
		this.measureHold = null;
		this.winRef.clearTimeout(hold.timer);
		// THE TRANSLATE COMES OFF BEFORE THE CLIP RETURNS (D-COV, AD-4 ii): a
		// resize commit ends the preview without the pinch-end path, and the
		// column term it left on the layer put the mark into the pane's own
		// clip (measured on e355b259: translate(-341.25px, 0) at in2 k 2.0,
		// 59% of the mark by the detector's area). Every release is a commit
		// or a teardown, and both re-raster against the settled column.
		this.clearPreviewInkOffset();
		this.container?.setCssStyles({ overflow: "hidden" });
		const view = this.view as EditorView | null;
		if (!view) return;
		const target = view as unknown as Record<string, unknown>;
		for (const entry of hold.entries) {
			// Still the hold's own property: put back what it displaced. A
			// wrapper that took the property over meanwhile keeps it; the
			// shadow it may still reach is inert now (see holdMeasures).
			if (Object.getOwnPropertyDescriptor(view, entry.name)?.value !== entry.shadow) continue;
			if (entry.displaced) Object.defineProperty(target, entry.name, entry.displaced);
			else delete target[entry.name];
		}
		for (const request of hold.requests) view.requestMeasure(request);
		if (!hold.plain && !hold.swallowed && hold.requests.length === 0) return;
		const measure = hold.entries.find((e) => e.name === "measure")?.callable;
		if (!measure) view.requestMeasure();
		else if (deferred) this.winRef.requestAnimationFrame(() => {
			// OWNERSHIP AT FIRE TIME, through the view's LIVE entry. A hold this
			// overlay installed since the capture takes the measure as its own
			// swallowed callback; so does a hold a SUCCESSOR overlay on the same
			// view installed after this one unmounted (its shadow is what the
			// live entry resolves to, and it replays at that hold's release).
			// Only when nothing holds the view does the call reach CodeMirror.
			// The captured callable is never called from here: it would measure
			// beneath whatever hold is live.
			if (this.view !== view) return;
			const own = this.measureHold ?? null;
			if (own) { own.swallowed = true; return; }
			const entry = (view as unknown as Record<string, unknown>).measure;
			if (typeof entry === "function") (entry as (this: EditorView, flush?: boolean) => unknown).call(view, false);
			else view.requestMeasure();
		});
		else measure.call(view, false);
	}

	/**
	 * The watchdog's outcome for a preview still live at PINCH_MEASURE_HOLD_MAX_MS.
	 *
	 * Releasing the hold under a frozen preview would let CodeMirror's next
	 * measure rescale the scroll under the pan - the displacement the hold
	 * exists to prevent - and re-arming it would keep an editor whose end
	 * event was lost from measuring for its lifetime. So the gesture is
	 * settled IN PLACE, the way a lift settles it (the raster lands at the
	 * current scale where the preview showed it), and re-anchored at once at
	 * the same target, the way the router itself re-arms a live pinch when a
	 * third finger lands. Fingers still on the glass continue from that
	 * anchor: their ratios are the router's, relative to its own start, so
	 * `pinch` divides them by the ratio at which this happened. A lost end
	 * gets the same settle and a harmless re-anchor the next real start
	 * replaces.
	 */
	private rebasePinch(): void {
		// A give easing back at the watchdog's deadline finishes in place; no fingers are on the glass to re-anchor.
		if (this.pinchGive) { this.finishPinchGive(); return; }
		const anchor = this.pinchAnchor;
		if (!this.pinchPreview || !anchor || this.pinchRefScale === null || this.retiring) { this.releaseMeasures(); return; }
		// THE RAW CLIENT CENTROID, not the accepted target: `pinch` takes the
		// client point and applies the constraint's offset itself, so the
		// offset-applied target would be offset twice and a still hold would
		// move when this fires. With the same client point the next move reads
		// as not moved, which is what a still hold is.
		const c = anchor.constraint;
		const target = c ? { x: c.clientX, y: c.clientY } : { x: anchor.targetX ?? anchor.focalX, y: anchor.targetY ?? anchor.focalY };
		const base = this.pinchLastRatio || 1;
		this.pinch("end", 1, target);
		this.pinch("start", 1, target);
		this.pinchRatioBase = base;
	}

	/**
	 * The fingers lifted with the preview past the cap. Drive the SAME preview path from
	 * the overshoot back to the cap on the bounce's curve, one move per frame, then lift for real at the
	 * cap. No second scale in flight, no per-frame commit: each frame is a preview frame exactly like
	 * a slow pinch, and the single settle runs at `to`, inside the committed range.
	 */
	private startPinchGive(from: number, to: number, centroid: { x: number; y: number }): void {
		if (this.pinchRaf !== 0) { this.winRef.cancelAnimationFrame(this.pinchRaf); this.pinchRaf = 0; }
		const sd = this.view.scrollDOM;
		const give = { from, to, startedAt: performance.now(), raf: 0, centroid: { x: centroid.x, y: centroid.y }, stepping: false, scrollLeft: sd.scrollLeft, scrollTop: sd.scrollTop, paused: false };
		this.pinchGive = give;
		give.raf = this.winRef.requestAnimationFrame(() => this.pinchGiveStep(give));
	}

	/** One tick of the give: the eased scale for this instant, painted, and the next tick requested. */
	private pinchGiveStep(give: NonNullable<InkOverlayPlugin["pinchGive"]>): void {
		if (this.pinchGive !== give || give.paused) return;
		give.raf = 0;
		const t = Math.min(1, Math.max(0, (performance.now() - give.startedAt) / OVERSCROLL_BOUNCE_MS));
		if (t >= 1) { this.finishPinchGive(); return; }
		// Ease out, the bounce's own curve: fast off the overshoot, gently onto the cap, never past it.
		this.pinchGiveFrame(give.to + (give.from - give.to) * (1 - t) ** 3, give);
		if (this.pinchGive === give && !give.paused) give.raf = this.winRef.requestAnimationFrame(() => this.pinchGiveStep(give));
	}

	/** Hold the ease where it stands for a pen stroke; the preview stays up at this scale, nothing moves. */
	private pausePinchGive(): void {
		const give = this.pinchGive;
		if (!give || give.paused) return;
		if (give.raf !== 0) { this.winRef.cancelAnimationFrame(give.raf); give.raf = 0; }
		give.paused = true;
	}

	/** After the stroke, ease on from the scale on screen to the cap over a fresh half second. */
	private resumePinchGive(): void {
		const give = this.pinchGive;
		if (!give || !give.paused) return;
		give.paused = false;
		give.from = this.pinchScaleNow;
		give.startedAt = performance.now();
		if (Math.abs(give.from - give.to) < 1e-9) { this.finishPinchGive(); return; }
		give.raf = this.winRef.requestAnimationFrame(() => this.pinchGiveStep(give));
	}

	/** One frame of the give: a move at `scale` through `pinch`, painted now rather than on the frame it would request. */
	private pinchGiveFrame(scale: number, give: NonNullable<InkOverlayPlugin["pinchGive"]>): void {
		const ref = this.pinchRefScale ?? this.pinchScaleNow;
		if (!Number.isFinite(ref) || ref <= 0) return;
		give.stepping = true;
		try {
			// `pinch` divides a move's ratio by `pinchRatioBase`; hand it the ratio that lands on `scale`.
			this.pinch("move", (scale / ref) * (this.pinchRatioBase || 1), give.centroid);
			if (this.pinchRaf !== 0) { this.winRef.cancelAnimationFrame(this.pinchRaf); this.pinchRaf = 0; this.flushPinch(false); }
		} finally { give.stepping = false; }
	}

	/** End the give now: the settle runs at the cap, the way the lift would have without it. */
	private finishPinchGive(): void {
		const give = this.pinchGive;
		if (!give) return;
		if (give.raf !== 0) { this.winRef.cancelAnimationFrame(give.raf); give.raf = 0; }
		this.pinchGive = null;
		if (this.retiring) return;
		// A scroll that ran under the ease (one finger, a wheel) moved the scroller; the settle anchors on the
		// gesture's start scroll, so that movement is folded into the anchor or the settle would take it back.
		const a = this.pinchAnchor, sd = this.view.scrollDOM;
		if (a) { a.scrollLeft += sd.scrollLeft - give.scrollLeft; a.scrollTop += sd.scrollTop - give.scrollTop; }
		this.pinchPending = { next: give.to };
		this.pinch("end", 1, give.centroid);
	}

	private deferPinchRaster(): boolean {
		// Match the scroll handler's bounded suppression: a lost end event must
		// never suppress future geometry work for the lifetime of the editor.
		return this.pinchPreview && performance.now() - this.pinchScrollAt < PINCH_SCROLL_QUIET_MS;
	}


 /** The column's margin in host-local px: its painted position less the left reserve's translate. */
 private columnMarginLocal(layout:NonNullable<InkOverlayPlugin["viewportLayout"]>):number|null {
  // `> 0`, not the field alone: a unit rig builds the layout by hand without it.
  return layout.columnLocal===null?null:layout.columnLocal-(layout.columnReserve>0?layout.columnReserve:0);
 }

 private restoreViewportLayout():void {
  this.pinchPreview=false;
  // Before the no-layout return: an unmount at rest leaves nothing behind either.
  this.clearOwnPaperVars();
  // Reached from update() on a file switch, inside CodeMirror's own update:
  // the make-up measure waits a frame (a synchronous one would nest).
  this.releaseMeasures(true);
  this.clearViewportPan();
  this.clearPreviewInkOffset();
  this.rasterColumnLocal=null; this.previewAnchorStale=false; this.clearDeferredRepaint();
  this.viewportGeneration++;
  this.viewportPaneObserver?.disconnect();this.viewportPaneObserver=null;
  this.aboveContentObserver?.disconnect();this.aboveContentObserver=null;
  this.viewportStyleObserver?.disconnect();this.viewportStyleObserver=null;
  this.viewportStyleDirty=null;
  if(this.viewportStyleFrame){this.winRef.cancelAnimationFrame(this.viewportStyleFrame);this.viewportStyleFrame=0;}
  const layout=this.viewportLayout;
  if(!layout) return;
  // At rest after the release the zoom is the external scale alone; the
  // measured cssScale still holds the gesture's until the next refresh.
  this.paperRestZoom=layout.externalScale;
  const host=this.view.dom;
  host.classList.remove("handwriting-note-viewport","handwriting-note-viewport-own-lines");
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
   // `zoom` is in the list because the release replays exactly what is named
   // here: a shrink the host was never given back would outlive the overlay,
   // with no counter-sized box left to justify it.
   // THE HOST'S OWN `zoom`, before the overlay writes one. `zoom` is a
   // single property, so the box write below REPLACES a theme's
   // `.cm-editor { zoom: 1.25 }` rather than composing with it, and the
   // camera would then be reading a scale the host is not at. Captured
   // here, once per takeover, and multiplied into every frame's write.
   // Read while no plugin zoom is on the host: the release replays the
   // saved inline value, so a later capture sees the theme's again.
   // Not a finite positive number - `normal`, or a rig with no `zoom` at
   // all - is a factor of 1, which writes exactly what it wrote before.
   const names=["width","height","transform","transform-origin","zoom","--handwriting-note-column-width","--handwriting-note-column-margin-left","--handwriting-note-column-margin-right","--handwriting-column-margin-left","--handwriting-column-auto-left","--handwriting-paper-pitch","--handwriting-paper-rule","--handwriting-paper-dot","--handwriting-paper-phase","--handwriting-paper-phase-x"];
   const layout:NonNullable<InkOverlayPlugin["viewportLayout"]>={parent,paneWidth:parent.clientWidth,paneHeight:parent.clientHeight,externalScale:this.cssScale/this.pinchScaleNow,baseTransform:this.winRef.getComputedStyle(host).transform,baseZoom:(()=>{const z=Number.parseFloat(this.winRef.getComputedStyle(host).zoom);return Number.isFinite(z)&&z>0?z:1;})(),width:Number.parseFloat(this.winRef.getComputedStyle(host).width)||host.clientWidth,height:Number.parseFloat(this.winRef.getComputedStyle(host).height)||host.clientHeight,column:0,columnBox:0,gutterX:0,gutterScreen:0,sizerColumn:false,columnInset:false,ownLines:false,left:"",right:"",columnLocal:null,columnReserve:0,columnAuto:null,styles:new Map(names.map(n=>[n,{value:host.style.getPropertyValue(n),priority:host.style.getPropertyPriority(n)}]))};
   this.viewportLayout=layout;
   {
    const sc0=this.view.scrollDOM,r0=sc0.getBoundingClientRect();
    const st0=this.winRef.getComputedStyle(sc0);
    const bx0=(Number.parseFloat(st0.borderLeftWidth)||0)+(Number.parseFloat(st0.borderRightWidth)||0);
    const gl0=Math.max(0,sc0.offsetWidth-sc0.clientWidth-bx0);
    const gs0=sc0.offsetWidth>0&&r0.width>0?gl0*r0.width/sc0.offsetWidth:0;
    if(Number.isFinite(gs0)&&gs0>=0)layout.gutterScreen=gs0;
   }
   // Paper values that are the overlay's own at-rest plan are not the host's
   // to be given back: a release takes them off (clearOwnPaperVars) and the
   // paper is planned at rest again, rather than replaying a plan made before
   // the gesture. A host's own inline value (a theme's,
   // or one set with a priority) is still restored as it was found.
   for(const name of PAPER_PROPERTIES){const saved=layout.styles.get(name);if(saved?.value&&!saved.priority&&saved.value===this.paperWritten?.get(name))layout.styles.delete(name);}
   // The same measurement a resize and a theme refresh take, so the frozen
   // value they compare against was read in the same basis. The saved styles
   // above are captured first: the measurement writes the host's box.
   const natural=this.measureNaturalColumn(null);
   layout.column=natural.column;layout.columnBox=natural.columnBox;layout.gutterX=natural.gutterX;layout.sizerColumn=natural.sizerColumn;layout.columnInset=natural.columnInset;layout.ownLines=natural.ownLines;layout.left=natural.left;layout.right=natural.right;layout.columnLocal=natural.columnLocal;layout.columnReserve=natural.columnReserve;layout.columnAuto=natural.columnAuto;
  }
  this.observeAboveContent();
  if(!this.viewportPaneObserver) {
   this.viewportPaneObserver=new ResizeObserver(()=>this.handleResize());
   this.viewportPaneObserver.observe(parent);
   const doc=host.ownerDocument;
   // The pane's class TOKENS minus the overlay's own, never its class string:
   // removing the token from the string left a trailing space, so the first
   // owned box write changed the stamp and scheduled a refresh after every
   // takeover - a forced layout, and a re-commit that could retire a pending
   // settle. Tokens compare the same however the list was edited.
   const stamp=()=>[doc.documentElement.className,doc.documentElement.getAttribute("style"),doc.body.className,doc.body.getAttribute("style"),Array.from(parent.classList).filter(token=>token!=="handwriting-note-viewport-pane").join(" "),parent.getAttribute("style")].join("|");
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
  const scroller=this.view.scrollDOM;
  const savedLeft=scroller.scrollLeft,savedTop=scroller.scrollTop;
  const {column,columnBox,gutterX,sizerColumn,columnInset,ownLines,left,right,columnLocal,columnReserve,columnAuto}=this.measureNaturalColumn({width:layout.width,height:layout.height});
  // columnBox and sizerColumn are in the compare because a theme change can move the column without moving `.cm-content`
  // - that is exactly what Minimal does, and it is why neither the ResizeObserver nor the content-origin compare fired.
  const changed=column!==layout.column||columnBox!==layout.columnBox||sizerColumn!==layout.sizerColumn||columnInset!==layout.columnInset||ownLines!==layout.ownLines||left!==layout.left||right!==layout.right||(columnLocal===null?null:columnLocal-columnReserve)!==this.columnMarginLocal(layout);
  if(column>0&&changed){layout.column=column;layout.columnBox=columnBox;layout.gutterX=gutterX;layout.sizerColumn=sizerColumn;layout.columnInset=columnInset;layout.ownLines=ownLines;layout.left=left;layout.right=right;layout.columnLocal=columnLocal;layout.columnReserve=columnReserve;}
  // A theme change is the one way `--file-line-width` moves at a constant pane
  // size, so the auto term's inputs are re-read in the same unowned layout.
  if(column>0)layout.columnAuto=columnAuto;
  this.applyViewportBox(this.pinchScaleNow);
  scroller.scrollLeft=savedLeft;scroller.scrollTop=savedTop;
  if(column>0&&changed)this.commitCameraScale(this.pinchScaleNow, undefined, undefined, true);
  return column>0;
 }

 /**
  * THE NATURAL COLUMN, MEASURED AT UNITY: the one measurement takeover, a pane
  * resize and a theme refresh all take, so the frozen column they compare is
  * always read in the same basis. Ownership comes off first - the class, and
  * with a `box` the host's box at that local size and its `zoom` back to the
  * value the host had before the overlay (the saved inline one, or none). The
  * zoom is the part the class cannot take off: on the transform host the shrink
  * lifted with the class, but on the zoom host it is an inline style, and a
  * column measured under it resolves the theme's auto margin in a mixed basis
  * (7.5 local px short at k .5, frozen, then a hop at the next pinch end).
  * Nothing is restored here: every caller ends in `applyViewportBox`, which
  * writes class, box and zoom back, and writes the layout fields BEFORE it so no
  * measured value is stored while the plugin's zoom is on the host.
  * `box` null is takeover: nothing of the overlay's is on the host yet and its
  * own box is left alone.
  * With the zoom off, the rect fallback divides by the external scale alone;
  * the transform fallback still carries its scale inline, as it always did.
  */
 /**
  * THE COLUMN, MEASURED, and three numbers no stylesheet decides.
  *
  * `columnBox` is the TEXT COLUMN's width, read off the LINE BOX - the element `contentOrigin` already picks for the
  * column's LEFT - rather than off `.cm-content`. That element is the column only under a theme that caps and centres
  * it, which is Obsidian's own; Minimal forces `.cm-content` and `.cm-sizer` to full width and gives the LINE the
  * readable width (theme.css:1852-1867), so `column` there is the whole pane and reads "this page cannot fit" at every
  * zoom. Measured: default 700 in a 1383 content box at inset 341.25; Minimal 648 in 1383 at 367.25; the setting off
  * 1383 in 1383. Same note, same pane.
  *
  * `gutterX` is the vertical scrollbar, in painted px. The pane is the scroller's BORDER box and the page is laid out
  * inside its CONTENT box, narrower by this. Fifteen px, and leaving it out put every centred rest half a gutter right
  * of where the engine's own centring puts the column - 7.75 px, at every zoom, on both themes.
  *
  * `sizerColumn` says whether the SIZER is the thing that carries the column's inset, which is the only case where
  * freezing the sizer's margin restates where the column already was. Measured unowned: Obsidian's own theme puts the
  * sizer at 341 with the column at 341.25 - the same place. Minimal puts it at 0, full width.
  */
 private measureNaturalColumn(box:{width:number;height:number}|null):{column:number;columnBox:number;gutterX:number;sizerColumn:boolean;columnInset:boolean;ownLines:boolean;left:string;right:string;columnLocal:number|null;columnReserve:number;columnAuto:{lineWidth:number;fixed:number;scrollbar:number}|null} {
  const layout=this.viewportLayout!,host=this.view.dom,scroller=this.view.scrollDOM;
  if(box) {
   host.classList.remove("handwriting-note-viewport");
   host.setCssStyles({width:`${box.width}px`,height:`${box.height}px`});
   const saved=layout.styles.get("zoom");
   if(saved?.value)host.style.setProperty("zoom",saved.value,saved.priority);else host.style.removeProperty("zoom");
  }
  const style=this.winRef.getComputedStyle(this.view.contentDOM);
  const sizer=this.panSizer();
  const column=this.view.contentDOM.offsetWidth;
  const natural=contentOrigin(this.view.contentDOM);
  const rectScale=!box||this.hostZoomSupported()?this.cssScale/this.pinchScaleNow:this.cssScale;
  const hostRect=host.getBoundingClientRect();
  // Takeover's read used to be `columnLocalAt`, which leaves the host's painted
  // origin for the gesture's later reads; kept, so a takeover inside a gesture
  // hands the same origin on. Resize and refresh never wrote it.
  if(!box&&this.previewHostOrigin){this.previewHostOrigin.left=hostRect.left;this.previewHostOrigin.top=hostRect.top;this.previewHostOrigin.valid=true;}
  // TAKEOVER READS THE RECT, as it always did. The margin walk sums the owned
  // tree's resolved margins, and before the first owned write the sizer's
  // theme `margin-left: auto` can read 0px while the sizer sits at its centred
  // offset: measured 0px against offsetLeft 341 at scroll 4000 on a 10838 px
  // extent, which froze the column at 0 and made the first refresh "change"
  // it to 341.25 - a re-commit and an 85 px hop at 25 percent.
  const columnLocal=(box?this.ownedColumnLayoutLeft(natural.line):null) ?? (natural.left===null?null:(natural.left-this.panX()-hostRect.left)/rectScale+scroller.scrollLeft);
  // No extra forced read: the scan above already laid all of this out.
  const lineBox=natural.line instanceof HTMLElement?natural.line.offsetWidth:0;
  const sr=scroller.getBoundingClientRect(),ss=this.winRef.getComputedStyle(scroller);
  const border=(Number.parseFloat(ss.borderLeftWidth)||0)+(Number.parseFloat(ss.borderRightWidth)||0);
  const gutterLocal=Math.max(0,scroller.offsetWidth-scroller.clientWidth-border);
  const gutterX=scroller.offsetWidth>0&&sr.width>0?gutterLocal*sr.width/scroller.offsetWidth:0;
  const sizerLeft=sizer?sizer.offsetLeft:null;
  // THE LEFT RESERVE IS PAINTED, NOT LAID OUT. Its `translate` on the sizer is in the rect read above, so
  // `columnLocal` is where the column is painted (the pinch anchor and the pan bounds want that), while
  // `offsetLeft` and every margin written from `columnLocal` do not carry it: those subtract `columnReserve`.
  const columnReserve=this.leftReserveHeld>0?this.leftReserveHeld:0;
  const sizerColumn=columnLocal!==null&&sizerLeft!==null&&Math.abs(sizerLeft-(columnLocal-columnReserve))<=PAN_FIT_SLACK_PX;
  // IS THERE A READABLE COLUMN HERE AT ALL: the page is NARROWER than the scroller's content box in its own natural
  // layout. This is not the old `|columnLocal - beside/2| <= 1` gate coming back - that one asked `.cm-content`, which is
  // why it read "no column" under a theme that centres its lines. This asks the measured column, and it is the half of
  // the question the fit cannot answer: with Readable line length OFF the page is 1383 local px at EVERY zoom, so below
  // 100% it fits the pane with room to spare and a fit-only test engages on it - measured, a 524.06 px preview pan at
  // 25% and the settle 345.75 px off the note's origin edge, on a setting that is meant to be untouched. Measured
  // natural widths: default 700 in 1383, Minimal 648 in 1383, setting off 1383 in 1383.
  const columnBoxLocal=lineBox>0?lineBox:column;
  const columnInset=columnBoxLocal>0&&scroller.clientWidth>0&&columnBoxLocal<=scroller.clientWidth-PAN_FIT_SLACK_PX;
  // DOES THE THEME CENTRE ITS OWN LINES: there is a readable column, it is inset, and the SIZER is not what puts it there
  // - the sizer sits at the scroller's left edge while the line does not. Minimal, measured unowned: sizer offsetLeft 0,
  // line inset 367.25, column 648 in 1383. Obsidian's own theme fails it (sizer 341 = the inset) and keeps the freeze;
  // Readable line length off fails it (no inset). Under it `applyViewportBox` does not freeze `.cm-content`'s width.
  const ownLines=columnInset&&sizerLeft!==null&&Math.abs(sizerLeft)<=PAN_FIT_SLACK_PX&&columnLocal!==null&&columnLocal>PAN_FIT_SLACK_PX;
  return {column,columnBox:columnBoxLocal,gutterX:Number.isFinite(gutterX)?gutterX:0,sizerColumn,columnInset,ownLines,left:style.marginLeft,right:style.marginRight,columnLocal,columnReserve,columnAuto:this.measureColumnAuto(box?box.width:layout.width,ownLines?columnBoxLocal:null)};
 }

 /**
  * The inputs of Readable line length's auto-centring term, read in an
  * UNOWNED layout (takeover, a pane resize, a theme refresh), so that
  * `applyViewportBox` can write the term as a number on every frame with no
  * read of its own. The stylesheet used to compute it as
  * `(100% - var(--file-line-width)) / 2`; under the zoom host the engine
  * resolves that `100%` in a mixed basis (the scroller's width with its
  * scrollbar counted in screen px), so the term shrank with k and won the
  * clamp against the frozen column: a column 7.5 (1/k - 1) local px left of
  * where it was, and a hop of that size when a pinch settled.
  *
  * `hostWidth` is the host's local width in this layout. Read only through
  * `measureNaturalColumn`, so the plugin's zoom is never on the host here and
  * local px are the host's own. Returns:
  * - `lineWidth`: `--file-line-width` when it is plain px (the old rule's own
  *   term), else the sizer's computed `max-width` in px;
  * - `fixed`: what the host holds beside the scroller's content box that does
  *   NOT scale - everything outside the scroller, plus its border and padding;
  * - `scrollbar`: the scrollbar at the host's own size (`offsetWidth -
  *   clientWidth - borders`, an integer difference, exact for an integer
  *   scrollbar). Under css zoom it keeps this screen size, which is why
  *   `applyViewportBox` divides it by the zoom.
  * Null when the line width is not px: `applyViewportBox` then leaves the
  * property unset and the stylesheet's percentage fallback applies, as before.
  * NOT COVERED: a scrollbar that appears or disappears with k (a note short
  * enough to stop overflowing at some scale) keeps the value read here until
  * the next resize or theme refresh.
  */
 private measureColumnAuto(hostWidth:number,ownLineBox:number|null=null):{lineWidth:number;fixed:number;scrollbar:number}|null {
  const host=this.view.dom,scroller=this.view.scrollDOM,sizer=this.panSizer();
  // A unit rig's stand-in DOM has no rects: no inputs, the stylesheet fallback.
  if(!sizer||!(hostWidth>0)||typeof host.getBoundingClientRect!=="function"||typeof scroller?.getBoundingClientRect!=="function")return null;
  const px=(value:string|undefined):number|null=>{const m=/^\s*(\d*\.?\d+)px\s*$/.exec(value??"");return m?Number(m[1]):null;};
  const sizerStyle=this.winRef.getComputedStyle(sizer);
  // A theme that centres its own lines sizes them itself (Minimal: 648 for a --file-line-width of 700), so the
  // auto term takes the measured line box there; with 700 it read 26 px short of the natural inset at 100%.
  const lineWidth=(ownLineBox!==null&&ownLineBox>0?ownLineBox:null)??px(sizerStyle.getPropertyValue?.("--file-line-width"))??px(sizerStyle.maxWidth);
  const hostRect=host.getBoundingClientRect().width;
  if(lineWidth===null||!(hostRect>0))return null;
  const s=this.winRef.getComputedStyle(scroller);
  const edge=(Number.parseFloat(s.borderLeftWidth)||0)+(Number.parseFloat(s.borderRightWidth)||0)+(Number.parseFloat(s.paddingLeft)||0)+(Number.parseFloat(s.paddingRight)||0);
  // Screen rects in one ratio: the scroller's border box in host-local px.
  const scrollerLocal=scroller.getBoundingClientRect().width*hostWidth/hostRect;
  const bar=Math.max(0,scroller.offsetWidth-scroller.clientWidth-(Number.parseFloat(s.borderLeftWidth)||0)-(Number.parseFloat(s.borderRightWidth)||0));
  return {lineWidth,fixed:Math.max(0,hostWidth-scrollerLocal)+edge,scrollbar:bar};
 }

 private setViewportScroll(left:number,top:number):void {
  const scroller=this.view.scrollDOM;
  scroller.scrollLeft=left;scroller.scrollTop=top;
  this.scrollExpansion?.rebase(scroller.scrollLeft,scroller.scrollTop);
 }

 /**
  * Does this engine have standard CSS `zoom`? Chromium 128+ and WebKit 17.4+
  * do; older mobile WebKit does not, and there the host keeps the scale
  * transform it has always had, byte for byte.
  *
  * Asked ONCE and cached: `applyViewportBox` runs per pinch-preview frame,
  * and a feature query per frame is a parse per frame. The answer cannot
  * change for the life of a window.
  */
 private hostZoomSupported():boolean {
  // `typeof`, not `=== null`: a class field initialiser does not run for an
  // object made with `Object.create`, which is how the unit rigs build one.
  if(typeof this.hostZoomSupport!=="boolean") {
   const css=(this.winRef as unknown as {CSS?:{supports?:(property:string,value:string)=>boolean}}).CSS;
   const supported=css?.supports?.("zoom","0.5")===true;
   // An engine whose rects ignore CSS zoom takes the transform path. No answer
   // keeps the feature query's for this overlay; the window is not marked, so
   // the next overlay asks again.
   const scaled=supported?zoomScalesClientRects(this.winRef):null;
   this.hostZoomSupport=scaled===null?supported:scaled;
  }
  return this.hostZoomSupport;
 }

 /**
  * The five ink canvases' layer boxes, from the band box and scale already
  * cached on the overlay - the same `canvasLayerBox` the reallocation path
  * calls, with no read of its own, so it is safe on a frame that owns the
  * layout. Silent until the band box is known: before the first allocation
  * there is nothing to place.
  */
 private placeCanvasLayers():void {
  if(!(this.cssWidth>0)||!(this.cssHeight>0))return;
  const box=canvasLayerBox(this.cssWidth,this.cssHeight,this.cssScale,this.hostZoomSupported());
  for(const c of [this.committedCanvas,this.wetCanvas,this.highlightCanvas,this.highlightWetCanvas]) {
   c?.setCssStyles({width:`${box.width}px`,height:`${box.height}px`,transform:box.transform,transformOrigin:box.transform?"0 0":""});
  }
		this.tail?.placeInline(this.cssScale, this.hostZoomSupported());
		this.wet?.placeWetTile?.(this.cssScale, this.hostZoomSupported());
 }

 private applyViewportBox(next:number,deferPaper=false):void {
  const layout=this.viewportLayout!,host=this.view.dom;
  // Only when missing: an add of a token already present still queues a class
  // mutation record, and the viewport style observer then ran its stamp on
  // every preview frame for a class that never changed.
  if(!host.classList.contains("handwriting-note-viewport"))host.classList.add("handwriting-note-viewport");
  if(!layout.parent.classList.contains("handwriting-note-viewport-pane"))layout.parent.classList.add("handwriting-note-viewport-pane");
  // The pane must never carry a scroll offset of its own: the stylesheet makes
  // it a clip rather than a scroll container, and this resets whatever an
  // engine without `overflow: clip` let through, so an already-shifted surface
  // heals the next time its box is applied. Cheap: two reads, writes only when
  // nonzero.
  const pane=layout.parent;
  if(pane.scrollLeft!==0||pane.scrollTop!==0){pane.scrollLeft=0;pane.scrollTop=0;}
  // THE COLUMN FREEZE, and where it does not apply. `.cm-content` is pinned at its 100% width (styles.css, the owned
  // host's content rule) so a re-centring margin cannot grow with 1/k under the counter-sized host. Under a theme that
  // centres its own LINES inside a full-width `.cm-content` that pin is exactly what stops the theme centring them:
  // measured under Minimal, the line stayed at its 100% inset and needed a 518 px rest at 25%. There the rule is scoped
  // off by a class and the theme centres the column at every zoom - no margin, no translate at rest. The anchor already
  // measures the column at both ends of a frame, so a column the theme moves stays under the fingers.
  if(host.classList.contains("handwriting-note-viewport-own-lines")!==layout.ownLines)host.classList.toggle("handwriting-note-viewport-own-lines",layout.ownLines);
  host.style.setProperty("--handwriting-note-column-width",`${layout.column}px`);
  host.style.setProperty("--handwriting-note-column-margin-left",layout.left);
  // THE COLUMN'S OWN host-local left, frozen at the scale the viewport was
  // taken over at. Written from `contentOriginLeft` minus the host rect - the
  // read syncCamera already does - so it records where the column ACTUALLY
  // was, whichever element the theme used to put it there. `layout.left`
  // above cannot serve: it reads contentDOM, which under Readable line length
  // carries no margin at all because the editor centres the sizer.
  // Left unset when the column could not be measured, so the stylesheet's
  // fallback keeps the declaration valid and the frame stays centred.
  // Stored RAW and clamped only here: a pane narrower than the line drives it
  // negative, and keeping that lets a later widening recover the exact value
  // instead of starting from a floor.
  // AT REST, A CENTRED COLUMN IS CENTRED BY THIS MARGIN, not by a pan standing on the sizer. A pan at rest costs on every
  // path that assumes none: measured, a scroll frame at 25 percent with Readable line length on ran 4.5 -> 5.9 ms against
  // 1.4.19 while the centring stood as pan. A LIVE FRAME KEEPS THE FROZEN MARGIN - the column is held under the fingers by
  // the pan there, and moving its margin per frame would reflow the sizer under them - so this is the resting frame's
  // own value, recorded in `columnRestMargin` for `columnRestPan` to read, and it is one property write in this batch.
  // THE PAINTED SCROLLBAR, MEASURED ON THE FRAME THAT ASKS. It cannot be predicted from the host-local
  // width: measured CONSTANT at 14.00..15.95 across k 0.100..1.500 in one rig and SCALING at
  // 11.25..44.98 across k 0.600..3.000 in another, with the local width flooring at 15 partway up the
  // second rig's own range. Both regimes are real and both were measured; the mechanism is not chased here.
  // ONE rect, and only on a settle - this function runs on EVERY PREVIEW FRAME (:5598), so an unguarded
  // read here would be a forced layout per frame on the hot path. The guard is production's own: the same
  // `pinchPreview` test the line below already uses to decide whether there is a rest to compute.
  if(!this.pinchPreview){
   const sc=this.view.scrollDOM,r=sc.getBoundingClientRect();
   const st=this.winRef.getComputedStyle(sc);
   const bx=(Number.parseFloat(st.borderLeftWidth)||0)+(Number.parseFloat(st.borderRightWidth)||0);
   const gl=Math.max(0,sc.offsetWidth-sc.clientWidth-bx);
   const gs=sc.offsetWidth>0&&r.width>0?gl*r.width/sc.offsetWidth:0;
   if(Number.isFinite(gs)&&gs>=0)layout.gutterScreen=gs;
  }
  this.columnRestMargin=this.pinchPreview||!layout.sizerColumn?null:this.columnRestCentred(next,layout.externalScale*next);
  // A theme that centres its own lines (ownLines) takes the same frozen inset as a sizer column; the stylesheet
  // applies it to the LINE there (styles.css, the own-lines rule) so the column stops re-centring in the widened host.
  if(layout.columnLocal!==null)host.style.setProperty("--handwriting-column-margin-left",`${Math.max(0,this.columnRestMargin??(layout.sizerColumn||layout.ownLines?this.columnMarginLocal(layout)!:0))}px`);

  // THE AUTO TERM the frozen column is clamped against, as a number: the
  // scroller's content width at this scale minus the line width, halved.
  // Arithmetic only, from inputs read in an unowned layout (measureColumnAuto),
  // and written in this same batch before anything reads, so a preview frame
  // keeps its one flush. On the zoom host the host is layout.width/next local
  // px wide and the scrollbar keeps its screen size (scrollbar/next local); on
  // the transform host the scrollbar is local like everything else. At k = 1
  // both are the engine's own centring, so the freeze stays invisible at 100%.
  const auto=layout.columnAuto;
  const autoLeft=!(layout.sizerColumn||layout.ownLines)?0
   :auto?Math.max(0,(layout.width/next-auto.fixed-(this.hostZoomSupported()?auto.scrollbar/next:auto.scrollbar)-auto.lineWidth)/2)
   :Math.max(0,this.columnMarginLocal(layout)??0);
  const autoValue=`${autoLeft}px`;
  if(host.style.getPropertyValue("--handwriting-column-auto-left")!==autoValue)host.style.setProperty("--handwriting-column-auto-left",autoValue);
  host.style.setProperty("--handwriting-note-column-margin-right",layout.right);
  // THE SHRINK. `zoom` where the engine has it: it is a layout property with
  // no transform node, so the host's effect node never gets the render
  // surface that a scale transform over composited descendants earns - the
  // surface that is redrawn at LAYOUT resolution on every inked frame far
  // out. The counter-sized box is unchanged either way; only the mechanism
  // that shrinks it back moves. A theme's own transform is kept whole (the
  // shrink is no longer folded into it), and the origin only matters while
  // such a transform is there. Anything a previous path left in `transform`
  // is cleared in the same write: a scale under a zoom would shrink twice.
  // The clear runs BOTH ways - the fallback clears a zoom the same way - so
  // neither branch can inherit the other's shrink and land at k squared. The
  // cached gate means production never crosses between them; only code that
  // changes the feature query's answer at runtime could, and a host shrunk
  // twice then reports a coordinate fault that code caused, not the overlay.
  // The PRODUCT, not `next`: the host's own factor is part of the scale the
  // camera measured, and a bare `next` would drop it. With no zoom of its own
  // the factor is 1 and the written string is what it always was.
  const base=layout.baseTransform!=="none"?layout.baseTransform:"";
  // `zoom: ""` above clears the property outright, which is right for a zoom
  // THIS path wrote and wrong for one the host brought with it INLINE: that
  // declaration is the host's own, and removing it is a shrink taken away from
  // an element the overlay never gave one to - visible even against a
  // competing stylesheet, because the inline one may be the `!important` that
  // wins. Replayed with its priority, exactly as the release replays it, and
  // only when there was one: a host with no inline zoom is left with the
  // property removed, which is what the clear already did.
  const fallback=():void=>{
   host.setCssStyles({width:`${layout.width/next}px`,height:`${layout.height/next}px`,zoom:"",transform:`${layout.baseTransform!=="none"?layout.baseTransform+" ":""}scale(${next})`,transformOrigin:"0 0"});
   const saved=layout.styles.get("zoom");
   if(saved?.value)host.style.setProperty("zoom",saved.value,saved.priority);
  };
  if(this.hostZoomSupported()) {
   const want=layout.baseZoom*next;
   host.setCssStyles({width:`${layout.width/next}px`,height:`${layout.height/next}px`,zoom:String(want),transform:base,transformOrigin:base?"0 0":""});
   // THE PRIORITY THE HOST'S OWN DECLARATION HAD. The bulk write above is a
   // camelCase assignment, which cannot carry `!important`: on a host whose
   // own `zoom` was inline AND important it replaces a declaration that was
   // winning the cascade with one that loses to any `!important` sheet rule,
   // so the host lands on the SHEET's factor instead of the product. At a
   // shrink the read-back below catches that; at unity there is no read-back -
   // `baseZoom * 1` asks for nothing, so nothing is certified - and the host
   // would sit demoted until some later frame. Re-writing the product with the
   // saved priority keeps the declaration where it was, and at unity makes the
   // write a restore of exactly what was there.
   // Only when there was an important one to inherit: with no priority to
   // carry, the bulk write above already produced the same declaration, and
   // the shipping host - which has no inline zoom at all - is written the same
   // single call it always was.
   const saved=layout.styles.get("zoom");
   if(saved?.priority)host.style.setProperty("zoom",String(want),saved.priority);
   // DID IT TAKE? A stylesheet `zoom: ... !important` out-specifies an inline
   // write, and the host would keep its full size behind a camera that
   // believes it shrank. One read per TAKEOVER, never per frame, and the
   // fallback form - which out-specifies nothing - is written in the same
   // call so no frame is painted at the wrong size.
   // ONLY a factor that asks the host to move can certify anything. At k = 1
   // the product IS the host's own factor, so the read agrees with the write
   // whether or not the write had any effect - a stylesheet `!important` at
   // that same factor passes it - and certifying there would spend the one
   // read on the one value that cannot fail, leaving the real shrink
   // unverified behind a counter-sized box. The first owned factor off unity
   // does the reading; after it there are no more reads, preview frames
   // included.
   if(layout.zoomVerified!==true&&Math.abs(next-1)>SCALE_EPSILON) {
    layout.zoomVerified=true;
    const got=Number.parseFloat(this.winRef.getComputedStyle(host).zoom);
    if(Number.isFinite(got)&&Math.abs(got-want)>1e-6){
     this.hostZoomSupport=false;fallback();
     // The five canvases were placed for the zoom form - the plain band box,
     // no transform - and the host has just moved to the other one, where the
     // layer that matters is the band times k stretched back. Left alone they
     // stay full-band compositor layers (five of 19900x22380 on Orion), which
     // is the cost `canvasLayerBox` exists to cap. Re-placed from the cached
     // box and scale: no DOM read, and nothing to do until one exists.
     this.placeCanvasLayers();
    }
   }
  }
  else fallback();
  // The pan is stored in PAINTED px and written in the children's own units, so
  // the scale it is divided by has just changed underneath it. Re-stamping here
  // costs two style writes and no read, and is what stops a frame being painted
  // with the previous scale's quotient. The host's own transform above is scale
  // only: the pan is never written here, because this element contains the
  // scroller and moving it takes the hit surface off the pane.
  if(this.panX()!==0||this.panY()!==0)this.writeViewportPan(deferPaper);
  // With no pan, a preview frame still carries the snap's residual out of the paper.
  else if(this.pinchPreview&&(this.paperSnapResidual.x!==0||this.paperSnapResidual.y!==0)){if(deferPaper)this.previewPaperBoxDirty=true;else this.writePaperPan();}
 }

 /**
  * The lined, grid and dotted paper: pitch, phase, rule and dot thickness in
  * layout px; the arithmetic is PaperPlan.ts. The pitch takes the text's size
  * and the phase the note origin, never the zoom's scale (the host's CSS zoom
  * scales the background with the note). The zoom reaches thickness, so it
  * never goes under a device px, and the phase's device px grid, both at the
  * INTENDED zoom: the external scale times the camera's own, not the measured
  * read-back. Planned on the refresh path and the camera sync when the text
  * size is read, when updateExtent captures a moved origin, when a note switch
  * opens another note, and at a commit, where a thickness can change and the
  * phase moves at most half a device px onto the new grid. Never on a preview
  * frame. In the task that read its
  * inputs, so the first paint after any of them already has it.
  */
 private updatePaperSpacing():void {
  // A detached editor gets nothing.
  if(!this.view?.dom?.isConnected)return;
  const layout=this.viewportLayout;
  const zoom=layout?layout.externalScale*this.pinchScaleNow:Number.isFinite(this.paperRestZoom)?this.paperRestZoom:this.cssScale;
  const plan=paperPlan(this.paperFontPx,this.paperOriginLayout,(this.dpr||1)*zoom,this.paperOriginLeft);
  if(!plan)return;
  // A re-plan while the preview paper rides a bounce (its settle's measure, say) is copied onto it at once; the settle re-copies its own.
  if(this.writePaperVars(plan)&&this.previewPaperEl&&!this.pinchPreview&&!this.previewPaperSettling)this.rebasePreviewPaper();
  // The snap's residual, only for a phase this overlay wrote: what a preview carries back out.
  const residual=(phase:number|null,origin:number|null,name:string):number=>{
   if(phase===null||origin===null||!Number.isFinite(origin)||this.paperWritten?.get(name)!==`${phase}px`)return 0;
   const t=((origin%plan.pitch)+plan.pitch)%plan.pitch;
   const d=phase-t;
   return d>plan.pitch/2?d-plan.pitch:d<-plan.pitch/2?d+plan.pitch:d;
  };
  this.paperSnapResidual={x:residual(plan.phaseX,this.paperOriginLeft,"--handwriting-paper-phase-x"),y:residual(plan.phase,this.paperOriginLayout,"--handwriting-paper-phase")};
  // A pan written while a residual was carried is re-written once the preview has ended.
  if(this.paperPanWritten)this.writePaperPan();
  // The paper kind can have changed with the plan (a note switch, the picker, the cycle command), and the
  // content can have grown since the last pass. Never on a preview frame: this method is not called on one.
  this.syncGridPaperBox();
 }

 /**
  * The paper's properties on the host, each only when it changes; a plan
  * with no phase keeps the last one. A value the host holds that the overlay did
  * not write (a theme's, or one with a priority) is never replaced, at rest or
  * zoomed: the paper needs no write to follow a zoom, so there is nothing to
  * override it for.
  */
 private writePaperVars(plan:PaperPlan):boolean {
  const host=this.view.dom;
  let wrote=false;
  for(const [name,px] of [["--handwriting-paper-pitch",plan.pitch],["--handwriting-paper-rule",plan.rule],["--handwriting-paper-dot",plan.dot],["--handwriting-paper-phase",plan.phase],["--handwriting-paper-phase-x",plan.phaseX]] as const) {
   if(px===null)continue;
   const value=`${px}px`,current=host.style.getPropertyValue(name);
   if(current===value)continue;
   if(current&&(host.style.getPropertyPriority(name)||current!==this.paperWritten?.get(name)))continue;
   host.style.setProperty(name,value);this.paperWritten?.set(name,value);wrote=true;
  }
  return wrote;
 }

 /**
  * Takes the overlay's own paper values off the editor at a release. The
  * editor outlives the overlay: a zoomed plan left inline stands until the
  * next at-rest plan, and an overlay mounted later on the same editor (a
  * plugin reload) takes it for the host's own and never replaces it. Until
  * the at-rest plan lands the stylesheet's fallback shows. A value that is
  * not the one written here, or carries a priority, is the host's and stays.
  */
 private clearOwnPaperVars():void {
  const host=this.view?.dom;
  if(host)for(const name of PAPER_PROPERTIES){const own=this.paperWritten?.get(name);if(own&&host.style.getPropertyValue(name)===own&&!host.style.getPropertyPriority(name))host.style.removeProperty(name);}
  this.paperWritten?.clear();
  // The pan properties live on the scroller and are only ever this overlay's.
  const scroller=this.view?.scrollDOM;
  if(scroller?.style){scroller.style.removeProperty("--handwriting-paper-pan-x");scroller.style.removeProperty("--handwriting-paper-pan-y");}
  this.paperPanWritten=null;this.paperRewrapY=0;this.paperColumnDrift=0;this.paperSnapResidual={x:0,y:0};
  this.writeGridBoxPan("");
 }

 /**
  * The note origin the paper's phase is planned from, in the gradient's own
  * layout px, from the origin updateExtent has just computed. Re-plans only when
  * it really moved. The origin does not move in layout px while the note zooms
  * or scrolls, but it is read through rects, whose positions the engine stores
  * to 1/64 screen px: at 10 percent that is a sixth of a layout px, and a
  * compare on the raw number re-planned the phase on zoom commits and scrolled
  * frames where nothing moved. A move under 1/32 screen px is not one.
  */
 private capturePaperOrigin(originTopInScroller:number,originLeftInScroller:number):void {
  // Never on a preview frame: the paper follows a preview through its pan, rewrap and column shifts, which this
  // re-measure would otherwise count a second time.
  if(this.pinchPreview)return;
  // surfaceOriginInScroller measures from the scroller's border box; the
  // gradient's positioning area starts at its padding box, clientTop lower and clientLeft to the right.
  // Read in the layout updateExtent has just flushed, before any write.
  const top=originTopInScroller-this.view.scrollDOM.clientTop;
  const left=originLeftInScroller-this.view.scrollDOM.clientLeft;
  const scale=Number.isFinite(this.cssScale)&&this.cssScale>0?this.cssScale:1;
  // A move under 1/32 screen px is not one: rect positions are stored to 1/64 screen px.
  const moved=(now:number,previous:number|null)=>Number.isFinite(now)&&(previous===null||Math.abs(now-previous)>=1/32/scale);
  const topMoved=moved(top,this.paperOriginLayout),leftMoved=moved(left,this.paperOriginLeft);
  if(topMoved)this.paperOriginLayout=top;
  if(leftMoved)this.paperOriginLeft=left;
  if(topMoved||leftMoved)this.updatePaperSpacing();
  // The phases now carry the origin a title rewrap or a column re-centring moved, so the paper's own shifts are spent,
  // in the same block as the re-plan.
  if(this.paperRewrapY!==0||this.paperColumnDrift!==0){this.paperRewrapY=0;this.paperColumnDrift=0;this.writePaperPan();}
 }

 // CodeMirror owns the root class attribute and rewrites it on focus changes.
 // Its facet must agree with our synchronous camera writes, including while a
 // stroke owns the frame. Reading the DOM class here would retain its loss.
 ownsNoteViewport():boolean {return this.viewportLayout!==null;}
 /**
  * DOES THE OWNED HOST CARRY THE OWN-LINES TOKEN, asked by the same `editorAttributes` facet that asserts
  * `handwriting-note-viewport`. It has to be asked there and not only written in `applyViewportBox`, because
  * CodeMirror REWRITES the host's whole `class` attribute from that facet on every `updateAttrs`: a token the overlay
  * only adds imperatively survives exactly until the next view update. Measured on the zoom button at 50 percent under
  * Minimal: `applyViewportBox` ran once, added the token (traced), and CodeMirror's next `updateAttrs` set
  * `class="cm-editor ... handwriting-note-viewport"` over it - the freeze came back on and the column stayed 345.5 px
  * off its centred rest. A pinch hid it, because its preview re-runs the box write every frame and the last one lands
  * after the update. The imperative write below stays: it makes the token right WITHIN the frame that computes it,
  * before any update, and this keeps it right across every update after.
  */
 noteViewportOwnLines():boolean {return this.viewportLayout?.ownLines===true;}

 getNoteViewportState():{zoom:number;busy:boolean;fitAvailable:boolean} {
  const path=this.filePath();
  // No note zoom of any kind with the canvas off: the bar, its buttons, Fit and the zoom
  // commands all read `busy` and stand down together.
  const busy=!this.container || !path || !inlineInk.isLoaded(path) || inlineInk.deleteAllReadiness(path).kind==="unsettled" || this.frame.locked || this.builder!==null || this.mode!=="ink" || !this.canvasMode;
  return {zoom:this.pinchScaleNow,busy,fitAvailable:!busy&&this.scaleGeometryValid!==false};
 }

 /**
  * RE-READ THIS NOTE'S CANVAS ANSWER AND APPLY IT. Called by the global setter for every
  * mounted note, by the frontmatter override when this note's choice moves, and by the host after a
  * toggle. Off: the wheel zoom run ends, momentum follows the mode, and a zoomed note lands at 100
  * percent about the pane centre through the ordinary commit (no saved zoom exists to keep: a note's
  * scale lives only while it is mounted, so canvas on again simply starts from 100 percent).
  */
 applyCanvasMode():void {
  const path=this.filePath();
  const on=canvasForNote(path,scrollExpansionEnabled);
  const was=this.canvasMode;
  this.canvasMode=on;
  this.router?.setCanvasMomentumDisabled(on);
  this.canvasOffResetPending=false;
  if(!on){
   this.endWheelZoomRun();
   // The room the canvas granted sideways is no longer asked for: owe the shrink for THIS note, the way
   // the global setter owes it for every note.
   if(was&&path) surfaceExtents.oweShrinkX(path);
   // The one reset can be refused (a hidden tab has no box, a stroke owns the frame). Keep it pending and
   // retry at pen-up and when the geometry comes back, so the note never stays zoomed with every zoom
   // control dead.
   if(this.pinchScaleNow!==1) this.canvasOffResetPending=true;
   this.retryCanvasOffReset();
  }
  if(was!==on) this.scheduleRepaint("canvas-mode");
 }
 /** A canvas-off reset to 100 percent that could not run yet; see applyCanvasMode. */
 private canvasOffResetPending=false;
 /** True when the pending reset committed now. */
 private retryCanvasOffReset():boolean {
  if(!this.canvasOffResetPending) return false;
  if(this.canvasMode||this.pinchScaleNow===1){this.canvasOffResetPending=false;return false;}
  if(!this.container||this.frame.locked||this.builder!==null) return false;
  if(!this.zoomAroundCenter(1)) return false;
  this.canvasOffResetPending=false;
  return true;
 }
 /** Read-only, for the zoom bar and the tests. */
 canvasModeOn():boolean { return this.canvasMode; }
 zoomNoteBy(factor:number):boolean {
  if(this.getNoteViewportState().busy||!Number.isFinite(factor)||factor<=0) return false;
  // Below the floor the lower bound is the current scale: minus is a no-op
  // there, never a jump in to the floor.
  const next=Math.max(Math.min(this.zoomFloor,this.pinchScaleNow),Math.min(MAX_PINCH_SCALE,this.pinchScaleNow*factor));
  return next===this.pinchScaleNow || this.zoomAroundCenter(next);
 }
 resetNoteZoom():boolean {
  // With the canvas off every zoom control is busy, but a note still left zoomed must be resettable.
  if(!this.canvasMode&&this.pinchScaleNow!==1&&!this.frame.locked&&this.builder===null) return this.zoomAroundCenter(1);
  return !this.getNoteViewportState().busy && this.zoomAroundCenter(1);
 }
 private zoomAroundCenter(next:number):boolean {
  const scroller=this.view.scrollDOM,rect=scroller.getBoundingClientRect();
  const external=this.cssScale/this.pinchScaleNow;
  // The left target is handed over UNCLAMPED: the column-margin debt this commit books is paid against the true anchor,
  // and only then clamped to the range. Clamping first dropped the part below 0 and paid the whole debt on top of it.
  const left=scroller.scrollLeft+(rect.width/2)*(1/this.cssScale-1/(next*external));
  return this.commitCameraScale(next,{left:Number.isFinite(left)?left:0,top:anchoredScroll(scroller.scrollTop,rect.height/2,this.cssScale,next*external)});
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
  const origin=surfaceOriginInScroller({contentLeftVisual:this.columnLeft(),documentTopVisual:this.documentTopUnpanned(),scrollRectLeft:rect.left,scrollRectTop:rect.top,scrollLeft:scroller.scrollLeft,scrollTop:scroller.scrollTop,scale:this.cssScale});
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
  // Fit alone passes bypassFloor: it may commit below the manual floor.
  return this.commitCameraScale(plan.zoom,{left,top},undefined,false,true)?"fit":refuse();
 }

 /** One validated transaction owns layout, transform, native range and scroll. */
 commitCameraScale(next:number,scroll?:{left:number;top:number},settleHold?:object|null,preserveScrollDemand=false,bypassFloor=false):boolean {
  this.commitDepth=(this.commitDepth||0)+1;
  try {
	this.restorePinchLayers();
  // A SAME-SCALE RE-COMMIT CARRIES A PENDING SETTLE. A refresh after a theme or
  // column change, or a resize, re-commits in place with no settle of its own
  // and no scroll target; retiring the pinch's pending hold there cancelled a
  // settle nothing had superseded. The hold is carried to this commit and
  // re-anchored under the refreshed geometry. A new scale or an explicit scroll
  // target is new navigation and still retires it.
  const pendingHold=this.panAnchorHold;
  // NOT inside another commit: a commit nested in a commit's own synchronous
  // work (its resize, extent, band) or in its settle measure's write would be a
  // second consumer of the same hold before it converged, which failed the
  // settle. It retires, named. This call's own entry is depth 1.
  // NOR inside CodeMirror's own update: the carried settle dispatches its scroll
  // request, and a dispatch during the update throws, which makes CodeMirror
  // deactivate this plugin (a font reflow's resize, with the pane not yet
  // delivered, reaches here from updateInner).
  const nested=this.commitDepth>1;
  const carry=!nested&&!this.inUpdate&&settleHold===undefined&&scroll===undefined&&!!pendingHold&&pendingHold.outcome==="pending"&&next===this.pinchScaleNow;
  if(carry)settleHold=pendingHold;
  else if(this.panAnchorHold!==settleHold)this.retirePanSettle(nested?"nested":this.inUpdate?"inside CodeMirror's update":settleHold===undefined?"a commit at a new scale or scroll":"another settle");
  // A commit that ends a live preview (a zoom button, Fit) takes its paper down; the settle's own commit leaves that to the settle.
  if(!this.previewPaperSettling)this.endPreviewPaper("commit");
  this.pinchPreview=false;
  this.releaseMeasures();
  // Below the floor only a scale at or above the reference commits: the
  // gesture's start while a pinch settles (its previews already wrote
  // pinchScaleNow), else the current scale, so a re-commit in place passes.
  if(this.frame.locked||this.scaleGeometryValid===false||(!bypassFloor&&next<this.zoomFloor&&!(next>=(this.pinchRefScale??this.pinchScaleNow)))||next>MAX_PINCH_SCALE||!validCameraScale(next,this.view.dom.clientWidth,this.view.dom.clientHeight))return false;
  const previous=this.pinchScaleNow,effective=this.cssScale/previous*next;
  if(!validCameraScale(effective)||!this.prepareViewportLayout())return false;
  const layout=this.viewportLayout!;
  const width=layout.width/next,height=layout.height/next;
  const target=scroll?{left:scroll.left,top:scroll.top}:{left:this.view.scrollDOM.scrollLeft,top:this.view.scrollDOM.scrollTop};
  // A target below 0 on x is an anchor the range cannot hold; what is below 0 is kept for the margin debt, below.
  const underflowLeft=Math.min(0,target.left);target.left=Math.max(0,target.left);
  // An explicit navigation that is NOT a pinch settle - Fit, the zoom buttons,
  // reset - computes its own absolute scroll and expects the note square on its
  // origin. Leaving a previous gesture's residual pan in place would displace
  // every one of those targets by it.
  if(scroll&&!this.panAnchorHold&&(this.panX()!==0||this.panY()!==0))this.clearViewportPan();
  if(![width,height,target.left,target.top].every(n=>Number.isFinite(n)&&n>=0&&n<=MAX_VIEWPORT_LAYOUT)||width===0||height===0)return false;
  if(next!==previous)this.router?.cameraTransformChanged();
  const generation=++this.viewportGeneration,path=this.filePath();
  this.reloadCameraSettlement=generation;
  const settled=()=>{if(this.reloadCameraSettlement===generation)this.reloadCameraSettlement=null;};
  // The carried hold belongs to this commit now; the commit that issued it sees
  // the newer generation on the hold and stands down without cancelling it.
  if(carry&&pendingHold&&this.panAnchorHold===pendingHold)pendingHold.generation=generation;
  const hold=this.panAnchorHold, container=this.container;
  const owns=()=>generation===this.viewportGeneration&&path===this.filePath()&&container===this.container&&!!container&&!this.retiring&&!this.frame.locked&&(!hold||this.ownsPanSettle(hold));
  const matchesScroll=()=>!hold||(this.view.scrollDOM.scrollLeft===hold.left&&this.view.scrollDOM.scrollTop===hold.top);
  const finish=()=>{settled();if(hold&&hold.generation===generation){if(hold.outcome==="pending")hold.outcome="cancelled";if(this.panAnchorHold===hold)this.retirePanSettle("its settle measure lost ownership or the scroll moved");}};
  // The first commit on a fresh editor has no resting margin to measure the debt from: the baseline is the margin the
  // page is showing now, at the scale it is leaving.
  if(this.restingColumnMargin===null&&layout.columnLocal!==null&&!this.pinchPreview)this.restingColumnMargin=this.appliedColumnMargin(previous);
  this.pinchScaleNow=next;this.cssScale=effective;this.scale=effective*this.fontZoom;
  // At the new zoom the pitch plans the same; the thickness can change and the phase moves onto the new device px grid.
  this.updatePaperSpacing();
  this.refreshPenCursor();
  this.applyViewportBox(next);
  this.scrollExpansion?.rebase(this.view.scrollDOM.scrollLeft,this.view.scrollDOM.scrollTop,preserveScrollDemand);
  // The extent pass below releases the band's margin on this commit, not only when a grant shrank.
  this.bandMarginReleasePending=true;
  // THE BAND IS RE-PINNED TO THE SETTLED VIEWPORT FIRST. Its margin is headroom for a fling, sized for the viewport it
  // was pinned in; a zoom-out pins it for the counter-sized one and a settle back at 100 percent used to leave that
  // margin holding scrollable range nothing had granted - measured on a blank note, 100 -> 25 -> 100: rangeX 175 and the
  // view parked at scrollLeft 160 with Readable line length on, 175/175 with it off, against 0/0 on a note that never
  // moved, with the extent's own grant 0 throughout. Re-pinned here, before the extent, the scroll target and the fit
  // test, the settle lands where a fresh note sits.
  this.handleResize();if(this.syncBand()!=="none")this.handleResize();this.updateExtent(true,hold?.expansion??undefined);
  // THE REST THE EXTENT JUST INVALIDATED. `handleResize` above writes the centring margin from the granted extent as
  // it stood; `updateExtent` then grants more room, so that margin is already stale by the end of this same commit and
  // the NEXT commit of any kind withdraws it. Measured: the page moves 536.70 px on a bare commit at the same scale
  // with no gesture behind it at all, which is why it snaps "no matter what" rather than only at a lift.
  //
  // Recomputed here against the grant this commit just made, BEFORE the frame is presented, so no stale margin is ever
  // carried out of a commit and there is usually nothing left to pay. What the page was actually showing - the last
  // commit's final margin - is what the debt below is measured against.
  this.restColumnAgainstCurrentGrant(next,effective);
  // THE PAGE BOX INSIDE THE PANE, folded into this commit's own scroll target once the box and the extent are
  // written, because it is read off both. Written back onto `target` deliberately: this commit has four scroll
  // writes (here, the settle measure's re-anchor, and the two convergence retries) and they all write the same
  // target, so a correction applied to one alone would be handed straight back by the next.
  target.left=this.ownLinesPageBoxScrollLeft(next,effective,target.left);
  target.left=Math.max(0,this.columnMarginDebtScrollLeft(effective,target.left+underflowLeft));
  // A FITTING COLUMN SETTLES ON ITS REST, AND THE REST IS NOT A SCROLL - the same law the pinch settle
  // already takes one screen up, on the same predicate and with no new term. Where `columnRestPan` is
  // non-null the column has an inset to rest in and the page fits the pane, and the margin this commit
  // just wrote IS that rest; a scroll standing from before the commit then displaces the page by its
  // whole width. Measured on Fit with ink wider than the page, Readable line length on, at k 0.2192:
  // the margin was the rest to the last digit (41.07033029241483) while scrollLeft stood at 301.03, and
  // the column landed at 243.00 against a pane edge of 300 - 57 px of it off the screen, with the ink's
  // left edge off with it. Zeroing the scroll puts it at 309.00, which is where centring wants it.
  // NOT carried as pan: a fitting page left panned by a stale scroll is the standing-pan class that was
  // already closed elsewhere, and the rest belongs in the margin, which now holds it.
  // The fit predicate itself, now that there is no centred rest to stand in for it.
  if (this.columnFitsPane(next, effective)) target.left = 0;
  this.setViewportScroll(target.left,target.top);this.reanchorPan();
  // The target scroll can leave the old raster band, especially on zoom-out.
  // Finish its coverage before the router can map and lock the next pen down.
  if(this.syncBand()!=="none")this.handleResize();
  const settledLeft=this.view.scrollDOM.scrollLeft,settledTop=this.view.scrollDOM.scrollTop;
  if(hold && this.firstSettleConsumer()) {
   // Use a real currently visible document position. Issue separately from
   // edits: CM clips an incoming effect against the existing document.
   const range=this.ownScrollRange(EditorSelection.cursor(this.view.viewport.from),hold);
   if(!range){finish();return false;}
   const request=EditorView.scrollIntoView(range,{x:"nearest",y:"nearest"});
   hold.request=request;
   const lifetime=viewportScrollLifetime(this.view);
   lifetime.pending=hold;
   // Append the cancellation extension only when this editor lacks it: every
   // zoom lift came through here and appended it again, and each append
   // re-resolves the editor's whole configuration.
   const effects=lifetime.installed(this.view.state)?[request]:[request,StateEffect.appendConfig.of(lifetime.extension)];
   hold.issuance=effects;
   const geometry=()=>[this.panX(),this.panY(),this.view.scrollDOM.scrollLeft,this.view.scrollDOM.scrollTop,this.view.scrollDOM.scrollWidth,this.view.scrollDOM.scrollHeight,this.view.contentHeight,this.view.viewport.from,this.view.viewport.to];
   const measure={key:this,read:()=>owns()&&matchesScroll()?geometry():null,write:(before:number[]|null)=>{
    if(!before||!owns()||!matchesScroll()){finish();return;}
    // The hold's own consumer re-anchoring: a commit its resize triggers is nested
    // too. Load-bearing: this write runs inside CodeMirror's measure (its update
    // phase), where a carried commit's dispatch would throw; do not remove.
    this.commitDepth=(this.commitDepth||0)+1;
    try{this.handleResize();this.updateExtent(true,hold?.expansion??undefined);this.setViewportScroll(target.left,target.top);this.reanchorPan();
    if(this.syncBand()!=="none")this.handleResize();}finally{this.commitDepth--;}
    this.scheduleRepaint();
    const after=geometry();
    hold.ready=after.every((value,index)=>value===before[index]);
    // Pending measurements keep CM's explicit target ahead of auto-anchoring
    // until a full readback needs no further geometry correction.
    if(!hold.ready) {
     // Bound failure by attempted corrections, never declare convergence
     // merely because time or frames passed. Leave the canceled receipt
     // recognizable so draining it cannot perform default scrolling.
     if(++hold.attempts>=4){hold.outcome="failed";console.warn("Pinch geometry did not converge");finish();}
     else this.view.requestMeasure(measure);
    } else {
     // Load-bearing: nothing else calls finish() on this path. Without this,
     // the reload gate this commit opened above never closes after a
     // converged pinch settle.
     settled();
    }
   }};
   this.view.requestMeasure(measure);
   this.view.dispatch({effects,filter:false});
  } else if(hold) {
   finish();
  } else {
  this.view.requestMeasure({key:this,read:()=>{
   const valid=owns()&&matchesScroll()&&(!!hold||(this.view.scrollDOM.scrollLeft===settledLeft&&this.view.scrollDOM.scrollTop===settledTop));

   return valid;
  },write:valid=>{
   if(!valid||!owns()||!matchesScroll()){finish();return;}
   this.handleResize();this.updateExtent(true);this.setViewportScroll(target.left,target.top);this.reanchorPan();
   if(this.syncBand()!=="none")this.handleResize();
   this.scheduleRepaint();
   const complete=()=>{
    if(!owns()){finish();return;}
    this.setViewportScroll(target.left,target.top);this.reanchorPan();
    this.updateExtent(true);this.reanchorPan();
    if(this.syncBand()!=="none")this.handleResize();
    this.scheduleRepaint();
    finish();
   };
   // Generic camera navigation keeps its existing guarded follow-up.
   // Pinch settlement completes through the owned consumer above.
   queueMicrotask(()=>{
    if(!owns()||!matchesScroll()){finish();return;}
    complete();
   });
  }});
  }
  this.mobileTools?.refresh();
  this.noteZoomControls?.refresh();
  return true;
  } finally { this.commitDepth--; }
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
		const client = this.penCursorPinned ? this.router?.clientPointForSample(sample) : null;
		const position = client ? { ...sample, x: client.x, y: client.y } : sample;
		this.penCursorClient = client ? position : null;
		this.paintPenCursor(position, this.penCursorPinned ? 1 : this.cssScale,
			this.camera.zoom * (this.penCursorPinned ? this.cssScale : 1), sample);
	}

	/** Cursor-only writes: no input replay, watchdog extension or raster work. */
	private refreshPenCursor(): void {
		if (!this.penCursorClient || !this.penCursorEl || !this.penCursorShown) return;
		this.paintPenCursor(this.penCursorClient, 1, this.camera.zoom * this.cssScale, null);
	}

	private paintPenCursor(sample: PenSample, cursorScale: number, cursorZoom: number, feedbackSample: PenSample | null): void {
		if (!this.penCursorEl) return;
		// Every branch below writes a visible opacity.
		this.penCursorShown = true;
		// In eraser mode the nib width is a lie: what the tip is about to do
		// is bounded by the eraser radius, so the reticle shows THAT. Radius
		// is screen-space (same physical size at any zoom), like the eraser
		// cursor that follows a live erase.
		if (tipMode() === "eraser") {
			const r = visualToNote(inlineEraserRadiusPx, cursorScale);
			this.penCursorEl.classList.remove(LASSO_CURSOR_CLASS);
			this.penCursorEl.classList.remove(SPACE_CURSOR_CLASS);
			this.penCursorEl.classList.remove(PAN_CURSOR_CLASS);
			this.penCursorEl.classList.add(ERASER_CURSOR_CLASS);
			this.penCursorEl.setCssStyles({
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
			const r = visualToNote(9, cursorScale);
			this.penCursorEl.classList.remove(SPACE_CURSOR_CLASS);
			this.penCursorEl.classList.remove(PAN_CURSOR_CLASS);
			this.penCursorEl.classList.add(LASSO_CURSOR_CLASS);
			this.penCursorEl.setCssStyles({
				width: `${r * 2}px`,
				height: `${r * 2}px`,
				transform: `translate(${sample.x - r}px, ${sample.y - r}px)`,
				backgroundColor: "transparent",
				opacity: "1",
			});
			return;
		}
		this.penCursorEl.classList.remove(LASSO_CURSOR_CLASS);
		// Aim stays under the pointer. The eligible seam and whole-group
		// exceptions live on the transient canvas, independently of this mark.
		if (tipMode() === "space") {
			const half = visualToNote(7, cursorScale);
			this.penCursorEl.classList.add(SPACE_CURSOR_CLASS);
			this.penCursorEl.setCssStyles({
				width: `${half * 2}px`,
				height: "0px",
				transform: `translate(${sample.x - half}px, ${sample.y}px)`,
				backgroundColor: "transparent",
				opacity: "1",
			});
			if (feedbackSample) this.queueSpaceFeedback(this.camera.screenToWorld(feedbackSample.x,feedbackSample.y).y);
			return;
		}
		this.penCursorEl.classList.remove(SPACE_CURSOR_CLASS);
		// Pan mode: a solid ring, the one reticle that is not dashed, so the
		// tip reads as "grab" rather than as any of the marking tools.
		if (tipMode() === "pan") {
			const r = visualToNote(11, cursorScale);
			this.penCursorEl.classList.add(PAN_CURSOR_CLASS);
			this.penCursorEl.setCssStyles({
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
			cameraZoom: cursorZoom,
			cssScale: cursorScale,
		});
		this.penCursorEl.setCssStyles({
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
		this.penCursorClient = null;
		// The reticle only, while an insert-space drag is live: a touch in
		// another pane (the hand-on-glass fan-out) and the hover watchdog both
		// land here mid-drag, and taking the divider, the highlight and the
		// "Release" label with the reticle left the rest of the drag blind.
		// The gesture's own end and every reset clear the feedback themselves.
		if (this.mode !== "space" || this.spacePlan === null) this.clearSpaceFeedback();
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
		this.concealPenCursor();
	}

	/** Hide the reticle by opacity only: a compositor change, never a layout or root repaint. */
	private concealPenCursor(): void {
		if (!this.penCursorEl) return;
		this.penCursorShown = false;
		this.penCursorEl.setCssStyles({ opacity: "0" });
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
		// Every current index showing this note, this pane's included (the
		// candidates call above has just made it current), and the rects the
		// other panes redraw.
		const indexes = this.currentIndexes(path);
		const changed: BBox[] = [];
		if (this.eraseWhole) {
			// Contact deletes the stroke, no split - v0.13.12's behavior,
			// back by request as a setting.
			for (const { stroke, index } of inlineInk.takeLive(path, hits)) {
				if (!this.erasePieces.delete(stroke.id)) {
					this.erased.push({ stroke, index });
				}
				this.damage.addRect(stroke.bbox);
				changed.push(stroke.bbox);
				for (const idx of indexes) idx.remove(stroke);
			}
			this.scheduleRepaint("partial");
			this.repaintPath(path, changed);
			return;
		}
		// Partial erase: the ring takes what it covers and the rest of the
		// stroke stays. Each stroke comes out and its survivors go back in at
		// the same position, so z-order holds; all of this pass's survivors go
		// back in one call, which places them in the original order.
		const back: Array<{ index: number; pieces: InkStroke[] }> = [];
		for (const { stroke, index } of inlineInk.takeLive(path, hits)) {
			this.damage.addRect(stroke.bbox);
			changed.push(stroke.bbox);
			for (const idx of indexes) idx.remove(stroke);
			const pieces = splitStrokeByCircle(stroke, w.x, w.y, r, newStrokeId);
			if (pieces.length === 1 && pieces[0] === stroke) {
				// Hit by the bbox-then-segment test but the ring never crossed
				// the line itself. Put it back exactly as it was.
				back.push({ index, pieces: [stroke] });
				for (const idx of indexes) idx.insertLike(stroke, stroke);
				continue;
			}
			if (!this.erasePieces.delete(stroke.id)) {
				this.erased.push({ stroke, index });
			}
			// A group even when the ring swallowed the whole stroke (no pieces):
			// reinsertLive counts groups as the strokes taken before each one.
			back.push({ index, pieces });
			for (const piece of pieces) this.erasePieces.add(piece.id);
			for (const idx of indexes) for (const piece of pieces) idx.insertLike(piece, stroke);
		}
		inlineInk.reinsertLive(path, back);
		// Batched to the next frame, exactly like the canvas eraser.
		this.scheduleRepaint("partial");
		this.repaintPath(path, changed);
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
			x: visualToNote(ev.clientX - rect.left - this.inkInputPanX(), this.cssScale),
			y: visualToNote(ev.clientY - rect.top - this.inkInputPanY(), this.cssScale),
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
			this.dragIds = [...this.selection.strokeIds];
			const here = this.filePath();
			this.dragHistoryIdentity = here ? inlineInk.captureHistoryIdentity(here) : null;
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
			// Escape or a tool change let go of the selection with the pen
			// still down: the ink stays where it was let go for the rest of
			// the contact, and the move the lift records stops growing with it.
			if (this.selection.isEmpty) return;
			const w = this.camera.screenToWorld(last.x, last.y);
			const dx = w.x - this.dragFrom.x;
			const dy = w.y - this.dragFrom.y;
			// Live drag only translates coordinates in the store; the history
			// op is pushed once at release, naming the ids frozen at pen-down,
			// which are also the ids moved here.
			const before = this.selectionBounds();
			this.moveLive(path, this.dragIds, dx, dy);
			this.dragTotal.dx += dx;
			this.dragTotal.dy += dy;
			this.dragFrom = w;
			let moved: BBox[] | undefined;
			if (before) {
				moved = [before, { x: before.x + dx, y: before.y + dy, width: before.width, height: before.height }];
				for (const rect of moved) this.damage.addRect(rect);
			} else {
				this.damage.addAll();
			}
			this.scheduleRepaint("partial");
			this.repaintPath(path, moved);
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

	/**
	 * End a live selection drag where it stands: one save and one undoable
	 * move of the strokes picked up at pen-down.
	 *
	 * Pen-up is the usual caller. Escape, Delete and a tool change can arrive
	 * with the pen still down and clear the selection; the ids frozen at
	 * pen-down keep the pen-up's move naming the strokes that moved. Delete
	 * also changes those strokes, so it commits the drag first: the move so
	 * far is one step and the delete the next, in that order.
	 */
	private commitLiveDrag(): void {
		if (!this.dragTotal) return;
		const { dx, dy } = this.dragTotal;
		// The op freezes WHICH strokes moved, as picked up at pen-down. An old
		// move must never later act on whatever happens to be selected, and a
		// selection cleared mid-drag must not turn the move into one of nothing.
		const strokeIds = this.dragIds;
		this.dragFrom = null;
		this.dragTotal = null;
		this.dragIds = [];
		this.dragHistoryIdentity = null;
		const path = this.filePath();
		if (path && strokeIds.length && (dx !== 0 || dy !== 0)) {
			inlineInk.save(path);
			this.dispatchInk({ type: "move", path, strokeIds, dx, dy });
			// A move changes no stroke COUNT, so the cache's cheap guard
			// cannot see it. §5g/G1.
			this.frontierCache.invalidate(path);
		}
	}

	private lassoUp(): void {
		if (this.dragTotal) {
			this.commitLiveDrag();
			this.redrawSelectionUI();
			return;
		}
		// A drag committed early (Delete mid-drag) leaves the pen down with no
		// drag and no loop: there is nothing to select at lift.
		if (!this.lassoActive) {
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
			let blockFallback=false;
			if(block&&(line.number>block.from||from>line.from||block.frontmatter)){
				blockFallback=true;
				if(direction<0){if(block.frontmatter)return null;from=this.view.state.doc.line(block.from).from;}
				else if(block.to<this.view.state.doc.lines)from=this.view.state.doc.line(block.to+1).from;
				else return null;
			}else if(from>line.from&&!canSplitParagraph(line.text,from-line.from)){
				blockFallback=true;
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
			return {y:(rowTop-origin)/this.scale,from,lineHeight:lh/this.scale,blockFallback};
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
			return {y,from:doc.length,lineHeight:this.view.defaultLineHeight/this.scale,text:false};
		}
		return nearestSpaceBoundary(y,(at,direction)=>this.spaceTextBoundary(at,direction));
	}

	private previewSpace(plan:SpaceBoundary):NonNullable<InkOverlayPlugin["spacePreview"]> {
		const strokes=this.strokesHere();
		const rows=(this.spaceRowsCache??=new InsertSpaceRows()).get(strokes);
		const moving=strokeIdsBelow(strokes,plan.y,rows),ids=new Set(moving);
		const staying=rows.filter(row=>row.top<plan.y&&row.bottom>plan.y)
			.flatMap(row=>row.ids).filter(id=>!ids.has(id));
		return {plan,doc:this.view.state.doc,moving,staying,rows};
	}

	/** Coalesce hover feedback without repainting the committed ink layer.
	 * The pointer itself updates synchronously, even when no seam is legal. */
	private queueSpaceFeedback(y:number):void {
		if(!this.tail)return;
		this.spaceHoverY=y;
		if(this.spaceFeedbackRaf!=null)return;
		this.spaceFeedbackRaf=this.winRef.requestAnimationFrame(()=>{
			this.spaceFeedbackRaf=null;
			// The overlay can be torn down between the request and the frame;
			// planSpace/previewSpace/redrawSelectionUI all reach geometry that
			// is gone by then.
			if(!this.container)return;
			if(this.spaceHoverY===null||tipMode()!=="space")return;
			// A frame that would draw what the last one drew is skipped: the
			// pen sliding along a line re-planned the seam and re-stroked every
			// previewed stroke at hover rate. Same hover y skips the plan too;
			// same plan skips the redraw. The key also carries what the drawing
			// depends on besides the plan: the document, the ink (the rows
			// cache returns a new array after any change), the camera and size.
			const last=this.spaceFeedbackKey;
			const cam=this.camera.snapshot;
			const same=(k:NonNullable<typeof last>)=>k.doc===this.view.state.doc&&k.mode===this.mode&&
				k.rows===this.spaceRowsCache?.get(this.strokesHere())&&k.x===cam.x&&k.y===cam.y&&k.zoom===cam.zoom&&
				k.w===this.cssWidth&&k.h===this.cssHeight&&k.preview===this.spacePreview;
			if(last&&last.hoverY===this.spaceHoverY&&same(last))return;
			if(this.mode!=="space"){
				const plan=this.planSpace(this.spaceHoverY);
				const prior=this.spacePreview;
				if(plan&&prior&&last&&same(last)&&samePlan(plan,prior.plan)){
					last.hoverY=this.spaceHoverY;
					return;
				}
				this.spacePreview=plan?this.previewSpace(plan):null;
			}
			this.redrawSelectionUI();
			this.spaceFeedbackKey={hoverY:this.spaceHoverY,doc:this.view.state.doc,mode:this.mode,
				rows:this.spaceRowsCache?.get(this.strokesHere()),x:cam.x,y:cam.y,zoom:cam.zoom,
				w:this.cssWidth,h:this.cssHeight,preview:this.spacePreview};
		});
	}

	private clearSpaceFeedback():void {
		if(this.spaceFeedbackRaf!=null)this.winRef.cancelAnimationFrame(this.spaceFeedbackRaf);
		this.spaceFeedbackRaf=null;
		this.spaceFeedbackKey=null;
		this.spaceHoverY=null;
		const hadPreview=!!this.spacePreview;
		this.spacePreview=null;
		if(hadPreview)this.redrawSelectionUI();
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
		if(!plan){this.spacePlan=null;this.spaceLineY=null;this.clearSpaceFeedback();this.showSpaceCursor(sample);return;}
		const cut = plan.y;
		this.spacePlan={...plan,doc:this.view.state.doc};
		const path=this.filePath();
		this.spaceHistoryIdentity=path?inlineInk.captureHistoryIdentity(path):null;
		this.spacePreview=this.previewSpace(plan);
		this.spaceLineY = cut;
		this.showSpaceCursor(sample);
		this.spaceFromY = w.y;
		this.spaceTotalDy = 0;
		// The id list freezes at pen-down, and so does the box around it:
		// membership cannot change mid-drag, so the damage region is just
		// that box swept by the distance travelled.
		this.spaceIds = [...this.spacePreview.moving];
		this.spaceBounds = boundsOf(here, this.spaceIds);
		if (this.spaceIds.length === 0 && !this.view.state.doc.sliceString(plan.from).trim()) {
			new Notice("Handwriting: no content below the line");
			this.spacePlan=null;this.spaceLineY=null;this.clearSpaceFeedback();
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
		this.moveLive(path, this.spaceIds, 0, dy);
		this.spaceTotalDy += dy;
		this.spaceFromY = w.y;
		// The live seam follows raw displacement. The origin and rounded
		// release destination are drawn separately from the frozen plan.
		if (this.spaceLineY !== null) this.spaceLineY += dy;
		// Damage the swept band only. Marking the whole page dirty per frame
		// re-rasterized every stroke in the note and the drag went jagged on
		// a full page; the moved ink is one contiguous band moving straight
		// down, so one rect covers where it was and where it landed.
		let swept: BBox[] | undefined;
		if (this.spaceBounds) {
			swept = [sweptRect(this.spaceBounds, dy)];
			this.damage.addRect(swept[0]!);
			this.spaceBounds = { ...this.spaceBounds, y: this.spaceBounds.y + dy };
		} else {
			this.damage.addAll();
		}
		this.scheduleRepaint("partial");
		this.repaintPath(path, swept);
		this.redrawSelectionUI();
	}

	private spaceUp(): void {
		const path = this.filePath();
		const applied = this.spaceTotalDy;
		const strokeIds = this.spaceIds;
		const plan = this.spacePlan;
		// This is the normal commit path (also native cancel/blur). Teardown
		// must never undo its movement again after the paired transaction.
		this.spaceHistoryIdentity = null;
		this.spaceLineY = null;
		this.spaceIds = [];
		this.spaceBounds = null;
		this.spacePlan = null;
		this.spaceTotalDy = 0;
		this.clearSpaceFeedback();
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
			// the live drag back: no op worth recording. But a save queued
			// mid-drag may have serialised the shifted strokes, so the restored
			// state has to reach the disk too, the way rollbackSpaceMove does.
			if (correction !== 0 && strokeIds.length) inlineInk.save(path);
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
	): { changes: { from: number; to: number; insert: string } | null; dy: number; lines: number } {
		const none = { changes: null, dy: 0, lines: 0 };
		if (!plan || plan.doc!==this.view.state.doc) return none;
		if(plan.text===false)return {changes:null,dy:applied,lines:0};
		const lineHeight = plan.lineHeight;
		const steps = lineSteps(applied, lineHeight);
		if (steps === 0) return none;
		// The drag snaps in rows of the seam line, but what opens or closes in
		// the text is BLANK lines, at body height. At a heading the two differ,
		// and moving the ink by the heading's rows walked it off its words.
		// The stylesheet's line height, as the seam's own is read: CodeMirror's
		// measured default rounds, and at 10% zoom that put ink an eighth of a
		// unit off the text over two lines.
		const css = parseFloat(this.contentStyle?.lineHeight ?? "") * this.cssScale;
		const blank = (css > 0 ? css : this.view.defaultLineHeight) / this.scale;
		const rowHeight = blank > 0 ? blank : lineHeight;
		const pos = plan.from;
		const doc = this.view.state.doc;
		const line = doc.lineAt(pos);
		if (steps > 0) {
			return {
				// An internal break replaces an existing visual wrap. One extra
				// newline preserves that wrap before opening the requested space.
				changes: { from: pos, to: pos, insert: "\n".repeat(steps+(pos>line.from?1:0)) },
				dy: steps * rowHeight,
				lines: steps,
			};
		}
		// Closing up: take back only blank lines, never a word of writing.
		if(pos!==line.from)return none;
		const removable = blankLinesAbove((n) => doc.line(n).text, line.number, -steps);
		if (removable === 0) return none;
		const first = doc.line(line.number - removable);
		return {
			changes: { from: first.from, to: line.from, insert: "" },
			dy: -removable * rowHeight,
			lines: -removable,
		};
	}

	/** Move this editor's strip to the configured corner. */
	applyToolbarCorner(): void {
		this.mobileTools?.setCorner(toolbarCorner);
	}

	/** The strip's active-tool marks are stale; recompute them. */
	refreshStrip(): void {
		if(tipMode()!=="space")this.clearSpaceFeedback();
		this.snapPreview?.check();
		this.mobileTools?.refresh();
		this.noteZoomControls?.refresh();
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

	/**
	 * The tail canvas carries a live highlighter's tip and, between strokes,
	 * selection chrome. The tip is a wash like the trail under it (what the
	 * PDF head canvas does); the chrome is UI and stays opaque.
	 */
	private dressTail(highlighter: boolean): void {
		if (this.tailWashed === highlighter) return;
		this.tailWashed = highlighter;
		// Optional-chained for the harnesses that build this off the prototype.
		this.tailCanvas?.setCssStyles({ opacity: highlighter ? String(HIGHLIGHTER_ALPHA) : "1" });
	}

	private redrawSelectionUI(): void {
		if (!this.tail) return;
		// A repaint with no selection still needs a compact live head; an idle
		// repaint releases the bitmap instead of restoring the whole band.
		if(this.spacePreview&&!this.spacePlan&&this.spaceRowsCache.get(this.strokesHere())!==this.spacePreview.rows)this.spacePreview=null;
		const preview=this.spacePreview;
		const bounds = this.selectionBounds();
		const head = this.builder ? this.activeWet.head() : undefined;
		const fullUI = (this.lassoActive && this.lassoPts.length > 1) ||
			(preview !== null && preview.doc === this.view.state.doc) || bounds !== null;
		if (fullUI) this.tail.restoreFullSurface();
		this.tail.clearAll(this.cssWidth, this.cssHeight);
		this.dressTail(this.builder !== null && this.activeWet === this.highlightWet);
		const cam = this.camera.snapshot;
		if (!fullUI) this.tail.prepareLive(head ? {
			cam, style: this.activeStyle, from: head.from, to: head.to,
			pressure: head.pressure,
			hwWorld: this.activeWet.liveHalfWidth(this.activeStyle, head.pressure),
		} : null, null);
		if (this.lassoActive && this.lassoPts.length > 1) {
			this.tail.drawLasso(cam, this.lassoPts, SELECTION_COLOR);
		}
		// A reload/erase while hovering invalidates the affected-set promise.
		// A live drag intentionally keeps its frozen set despite translations.
		if (preview && preview.doc===this.view.state.doc) {
			const moving=new Set(preview.moving),staying=new Set(preview.staying);
			for(const stroke of this.strokesHere()){
				if(moving.has(stroke.id)||staying.has(stroke.id))this.tail.drawSpaceStroke(
					cam,stroke,moving.has(stroke.id)?SELECTION_COLOR:"#d98b00",this.cssWidth,this.cssHeight,this.cssScale);
			}
			this.tail.drawSpaceDivider(cam,preview.plan.y,SELECTION_COLOR,this.cssWidth);
			const label=preview.plan.blockFallback?"Block boundary":preview.plan.text===false?"Ink gap":"Text boundary";
			this.tail.drawSpaceLabel(cam,preview.plan.y,label+(moving.size?" · blue ink moves":"")+(staying.size?" · amber ink stays":""),SELECTION_COLOR,this.cssScale);
			if(this.spacePlan && this.spaceLineY!==null){
				const {dy,lines}=this.spaceTextChange(this.spacePlan,this.spaceTotalDy);
				const landing=this.spacePlan.y+dy;
				const gap=this.spacePlan.text===false?`${Math.round(dy*10)/10} gap`:`${lines} lines`;
				this.tail.drawSpaceLabel(cam,landing,`Release: ${gap}`,SELECTION_COLOR,this.cssScale,true);
			}
		}
		if (bounds) this.tail.drawSelectionBox(cam, bounds, SELECTION_COLOR);
		// A repaint can land mid-stroke - a scroll, an external reload, damage
		// from an erase elsewhere. clearAll above takes the live head with it,
		// and the head is the lag-free tip: erasing it until the next pointer
		// event is a blink at exactly the place the eye is resting.
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
		const replayBand = this.bandSyncDeferred;
		stripPenUp(this.mobileTools, this.noteZoomControls);
		this.resetGestureState();
		if (replayBand) this.scheduleRepaint("scroll");
		this.replayDeferredResize();
		this.wet.clear(this.cssWidth, this.cssHeight);
		this.highlightWet.clear(this.cssWidth, this.cssHeight);
		// A teardown mid-handoff would otherwise strand the wet highlighter
		// element hidden for every later stroke - update()'s path-change
		// branch carries this same line for the same reason.
		this.highlightWetCanvas.setCssStyles({ opacity: String(HIGHLIGHTER_ALPHA) });
		this.tail.clearAll(this.cssWidth, this.cssHeight);
		this.tail.prepareLive(null, null);
	}

	/**
	 * An erase or a selection drag torn down with the pen still down: a file
	 * switch, a rename, a close, a window blur. Both change the store live and
	 * save and record their undo step only at pen-up, which never comes, so the
	 * change stayed on screen, reached the disk with the next save, and no undo
	 * could take it back. Put the note back as the gesture found it, as
	 * rollbackSpaceMove does for insert space, in the note the gesture began in.
	 */
	private rollbackLiveGesture(): void {
		const eraseIdentity = this.eraseHistoryIdentity, dragIdentity = this.dragHistoryIdentity;
		this.eraseHistoryIdentity = null;
		this.dragHistoryIdentity = null;
		const erasePath = eraseIdentity && this.erased.length ? inlineInk.pathForHistoryIdentity(eraseIdentity) : null;
		if (erasePath) {
			// The pieces this gesture cut come out; the originals go back where
			// the pre-gesture list had them.
			inlineInk.takeLive(erasePath, [...this.erasePieces]);
			inlineInk.applyAddLive(
				erasePath,
				this.erased.map((e) => e.stroke),
				eraseRemovalIndices(this.eraseFrom, this.erased)
			);
			this.restoredByRollback(erasePath);
		}
		const moved = this.dragTotal;
		const dragPath = dragIdentity && moved && (moved.dx !== 0 || moved.dy !== 0) && this.dragIds.length
			? inlineInk.pathForHistoryIdentity(dragIdentity) : null;
		if (dragPath && moved) {
			inlineInk.moveStrokes(dragPath, this.dragIds, -moved.dx, -moved.dy);
			this.restoredByRollback(dragPath);
		}
		this.dragIds = [];
	}

	/** A live change was undone behind the history: persist it and repaint every pane on the note. */
	private restoredByRollback(path: string): void {
		// Persist even if another save observed the live coordinates. Store
		// guards still own write eligibility.
		inlineInk.save(path);
		this.frontierCache.invalidate(path);
		this.repaintPath(path);
		if (path === this.filePath()) this.scheduleRepaint();
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
		metrics.end(performance.now(), this.tail?.resizeTotal);
		this.stopFrameTicker();
		this.strokePenGesture = false;
		this.strokeAbandoned();
	}

	private resetGestureState(): void {
		this.rollbackSpaceMove();
		this.rollbackLiveGesture();
		this.clearSnapPreview();
		// Lifecycle rule (v0.13.6 fix): every gesture-state reset releases the
		// stroke frame lock. File switch and unmount reach here mid-stroke;
		// leaving the lock held froze the NEXT note's camera and repaints
		// until its first pen-down. A cancelled frame never leaks forward.
		this.frame.cancel();
		this.bandSyncDeferred = false;
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

	/** A note switch has already changed filePath/lastPath when reset runs.
	 * Resolve the ORIGINAL record instead, before throwing away the inverse.
	 * This also handles unmount and ignores a deleted/replaced record. */
	private rollbackSpaceMove():void {
		const identity=this.spaceHistoryIdentity,dy=this.spaceTotalDy;
		this.spaceHistoryIdentity=null;
		this.spaceTotalDy=0;
		if(!identity||!dy||!this.spaceIds.length)return;
		const path=inlineInk.pathForHistoryIdentity(identity);
		if(!path)return;
		inlineInk.moveStrokes(path,this.spaceIds,0,-dy);
		// Persist the restored state even if another save observed the live
		// provisional coordinates. Store guards still own write eligibility.
		inlineInk.save(path);
		this.frontierCache.invalidate(path);
		this.repaintPath(path);
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
		if (this.selection.clear()) this.redrawSelectionUI();
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

	/** The owning document survives long enough to retire a closing window. */
	get ownerDocument(): Document {
		return this.view.dom.ownerDocument;
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
		if (n > 0) publishInkMarker(this.winRef);
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
		if (clipboardSize() === 0) return 0;
		// A cell editor inherits the note's file identity and this extension, but
		// its effects-only ink history never reaches the note editor. Refuse
		// before pasteInk advances the source stagger or mints stroke IDs.
		if (!path || !this.container || !this.ownsMarkdownEditorRoot()) {
			const inTable = this.view.dom.closest(".table-cell-wrapper, .cm-table-widget") !== null;
			new Notice(inTable
				? "Handwriting: click outside the table to paste ink."
				: "Handwriting: click in the note to paste ink.");
			return 0;
		}
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
		// Mid-drag, the move so far is its own step, before the delete's.
		this.commitLiveDrag();
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
			const before = this.selection.size;
			this.selection.prune(
				new Set(inlineInk.strokes(current).map((s) => s.id)),
				new Set(),
				new Set()
			);
			// The repaint draws selection chrome only over a selection that is
			// still there; a box whose ink an undo just took stays drawn unless
			// the chrome is redrawn here.
			if (this.selection.size !== before) this.redrawSelectionUI();
		}
		this.scheduleRepaint();
		this.repaintPath(op.path);
	}



	/**
	 * Repaint every OTHER pane showing this note (ink belongs to the note).
	 *
	 * `damage` is for the per-sample gestures (live erase, lasso and space
	 * drags): those panes redraw only the rects that changed, where they
	 * used to re-rasterize the whole note every frame. Their stroke indexes
	 * are kept exact by the gesture through `currentIndexes`, so a partial
	 * repaint there finds the strokes where they now are. Without it, the
	 * whole note repaints, as for every boundary change.
	 */
	private repaintPath(path: string, damage?: readonly BBox[]): void {
		for (const p of instances) {
			if (p === this || p.filePath() !== path) continue;
			if (damage) {
				for (const rect of damage) p.damage.addRect(rect);
				p.scheduleRepaint("partial");
			} else {
				p.scheduleRepaint();
			}
		}
	}

	/**
	 * The stroke index of every pane showing this note, this one included,
	 * that is current. A dirty one is left out: it rebuilds from the store at
	 * its next repaint, which reads the strokes as they are by then.
	 */
	private currentIndexes(path: string): StrokeIndex[] {
		const out: StrokeIndex[] = [];
		for (const p of instances) {
			if (!p.indexDirty && (p === this || p.filePath() === path)) out.push(p.strokeIndex);
		}
		return out;
	}

	/**
	 * A live drag's translation, with every current index kept exact: each
	 * moved stroke leaves its old cells and enters its new ones. The drags
	 * used to mark the index dirty on every sample, and the repaint that
	 * followed rebuilt the whole note's index once per frame.
	 *
	 * Moving a stroke through the index costs about seven times what
	 * rebuilding it does (measured on 6000 strokes), so a drag that moves
	 * more than an eighth of the note (an insert-space drag near the top)
	 * marks the indexes dirty instead, and each pane rebuilds once at its
	 * next repaint.
	 */
	private moveLive(path: string, ids: readonly string[], dx: number, dy: number): void {
		const indexes = this.currentIndexes(path);
		const all = inlineInk.strokes(path);
		if (indexes.length === 0 || ids.length * 8 > all.length) {
			inlineInk.moveStrokes(path, ids, dx, dy);
			for (const p of instances) {
				if (p === this || p.filePath() === path) p.indexDirty = true;
			}
			return;
		}
		const wanted = new Set(ids);
		const moving = all.filter((s) => wanted.has(s.id));
		for (const idx of indexes) for (const s of moving) idx.remove(s);
		inlineInk.moveStrokes(path, ids, dx, dy);
		for (const idx of indexes) for (const s of moving) idx.insertLike(s, s);
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

	/**
	 * Draw committed ink for one frame: everything at `cam` when `work` is
	 * "all", else the damaged rects through the stroke index. Shared by the
	 * ordinary repaint and the repaint under a pinch hold, which paints at
	 * the RETAINED camera (see `repaint`). Returns whether the purge probe
	 * is armed, for the heal check that follows an ordinary repaint.
	 */
	private paintCommittedWork(cam: { x: number; y: number; zoom: number }, work: "all" | BBox[], strokes: readonly InkStroke[]): boolean {
		const probeArmed = purgeProbeArmed(Platform.isMobileApp, diagnosticsEnabled());
		// One source for both branches: a partial repaint must match a full
		// one, or ink would visibly change width between a damage frame and
		// the next full one. See fillRibbon/WidthFloor.ts.
		const floor = committedFloorFor(this.committedBacking, this.dpr);
		if (work === "all") {
			// A note holding a highlighter stroke needs the pair; one without it
			// leaves the pair at 0x0 and skips its draw.
			if (this.highlightPairDeferred && strokes.some(stroke => stroke.tool === "highlighter")) this.allocateHighlightPair();
			this.markCommittedPaint("highlighter");
			this.markCommittedPaint("pen");
			if (!this.highlightPairDeferred) drawCommitted(this.highlightCtx, cam, strokes, this.cssWidth, this.cssHeight, true, "highlighter", undefined, floor);
			drawCommitted(this.committedCtx, cam, strokes, this.cssWidth, this.cssHeight, true, "pen", probeArmed, floor);
			this.highlightBlank = !strokes.some(stroke => stroke.tool === "highlighter");
			this.committedBlank = !probeArmed && !strokes.some(stroke => stroke.tool !== "highlighter");
		} else if (work.length > 0) {
			// A deferred highlight layer stays blank: marked painted, its 0x0
			// canvas would count as an occupied layer in the pinch composite.
			if (!this.highlightPairDeferred) this.markCommittedPaint("highlighter");
			this.markCommittedPaint("pen");
			if (this.indexDirty) {
				this.strokeIndex.rebuild(strokes);
				this.indexDirty = false;
			}
			for (const rect of work) {
				const hit = this.strokeIndex.query(rect);
				// A highlighter stroke reaching a deferred layer (undo, paste, sync)
				// gets a fresh blank backing: paint the whole highlight layer once.
				if (this.highlightPairDeferred && hit.some(stroke => stroke.tool === "highlighter")) {
					this.allocateHighlightPair();
					this.markCommittedPaint("highlighter");
					drawCommitted(this.highlightCtx, cam, strokes, this.cssWidth, this.cssHeight, true, "highlighter", undefined, floor);
				}
				if (!this.highlightPairDeferred) drawRegion(this.highlightCtx, cam, hit, rect, true, "highlighter", floor);
				drawRegion(this.committedCtx, cam, hit, rect, true, "pen", floor);
			}
			// A damage rect covering the band corner clears the marker, and
			// `drawRegion` has no reason to know about it. Repainting is
			// idempotent, so this needs no test for whether it was hit.
			if (probeArmed) paintPurgeSentinel(this.committedCtx);
		}
		// Only a whole-world paint puts every stroke of the store on the raster; a partial one draws the strokes in its rects.
		if (work === "all") this.paintedStrokeCount = strokes.length;
		return probeArmed;
	}

	private repaint(): void {
		if (this.deferPinchRaster()) {
			// The queued frame is CONSUMED here: `scheduleRepaint`'s rAF clears
			// `repaintQueued` before calling this. During an active pinch
			// `pinchScrollAt` is re-stamped every preview frame, so this stays
			// true for the whole gesture and damage pending when the deferral
			// began would never be drawn. The case that matters is a stroke
			// committing mid-gesture: `drawCommitted` clears the preview offset
			// and marks the layer dirty synchronously so the new stroke lands
			// right, but the REST of the layer would keep showing the pre-gesture
			// raster, untranslated, for the rest of the pinch - the original
			// slide, re-introduced by the fix for it.
			//
			// A LATCH AND ONE TIMER, not a re-armed rAF. Re-arming per frame is a
			// requestAnimationFrame loop for the duration of the gesture, on the
			// path the deferral exists to keep free. Settle needs nothing:
			// `commitCameraScale` re-rasters and clears the latch. What is left is
			// a pause past the quiet window or a lost end event, and one timer
			// covers both.
			if (!this.damage.isEmpty) this.armDeferredRepaint();
			return;
		}
		this.restorePinchLayers();
		if (!this.container) return;
		// UNDER THE HOLD (D-COV): no band move, no reallocation,
		// no camera re-base, no offset clearing. The raster keeps the basis the
		// preview translate was solved against, and damage that arrived
		// mid-gesture (a stroke committing) paints into the retained backing at
		// that camera, so the new ink lands where the pen put it and the rest
		// of the layer stays put. Measured on e355b259 (2026-09-13): a stroke
		// committing in a held zoom-in at k 0.75 sent this frame through
		// syncBand and handleResize, which re-sized the band from the unpanned
		// viewport (6000 -> 1601 layout px tall), and the mark at rows
		// 2372-2612 fell outside it until the settle. What a bigger band would
		// show waits for the settle, which re-rasters against the settled column.
		if (this.pinchPreview && this.lastPaintCam !== null) {
			const work = this.damage.take();
			if (work === "all" || work.length > 0) {
				const path = this.filePath();
				this.paintCommittedWork(this.lastPaintCam, work, path ? inlineInk.strokes(path) : []);
			}
			return;
		}
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
		// Diagnostic only: the scroll probe's repaint line reads the carry and the two spans timed below. With the switch
		// off this costs one boolean read and one field write.
		const diag = diagnosticsEnabled();
		this.bandCarriedThisFrame = false;
		const bandMove = this.syncBand();
		if (bandMove === "resized") {
			this.handleResize();
			return;
		}
		// Diagnostic only, for the probe's repaint line: whether this frame baked a settled pan.
		const panBaked = this.rasterPanNeedsBake();
		if (panBaked) {
			// A settled pan must move ink within the bounded raster, not move
			// every canvas away from part of the writable editor. Change the
			// camera and input origin together, then redraw all affected layers.
			// The rest, not a bounce passing through: the ink layer's translate carries the bounce, and baking each of its
			// frames would re-raster the world a dozen times for an animation that ends where it began.
			this.rasterPan = { x: this.restPanX() / this.cssScale, y: this.restPanY() / this.cssScale };
			this.writeInkLayerTransform();
			this.wet.clear(this.cssWidth, this.cssHeight);
			this.highlightWet.clear(this.cssWidth, this.cssHeight);
			this.tail.clearAll(this.cssWidth, this.cssHeight);
			this.tail.prepareLive(null, null);
			this.spaceFeedbackKey = null;
			this.damage.addAll();
			this.router?.refreshRect();
		}
		const syncAt = diag ? performance.now() : 0;
		this.syncCamera();
		const syncCameraMs = diag ? performance.now() - syncAt : 0;
		const path = this.filePath();
		const strokes = path ? inlineInk.strokes(path) : [];
		const cam = this.camera.snapshot;
		const last = this.lastPaintCam;
		// A successful carry already moved the overlap by whole backing pixels
		// and recorded the camera those pixels sit at; its frame gets the same
		// sub-pixel bar as every other (committedRepaintPlan).
		const damageIn = this.damage.take();
		const plan = committedRepaintPlan(last, cam, damageIn, this.committedBacking ?? 0);
		const work = plan.work;
		this.lastPaintCam = plan.painted;
		// This frame redraws the committed layer against the CURRENT column, so
		// any preview translation is now baked into the pixels and must come
		// off, and the anchor must describe this raster rather than the one it
		// replaced. Reachable mid-gesture: holding a pinch still past
		// PINCH_SCROLL_QUIET_MS lets deferPinchRaster go false and a repaint
		// through.
		if (this.pinchPreview) {
			this.clearPreviewInkOffset();
			// INVALIDATE, do not re-latch here. The anchor has to be read while
			// the host still carries the scale the raster was drawn at, and by
			// the time the NEXT preview frame calls this method
			// `applyViewportBox` has already moved the column. Re-latching from
			// inside repaint measured the column one box-change too late and
			// put a constant 855 host-local px into the anchor - measured as a
			// residual that decayed exactly in proportion to k (-256.4 at 0.30,
			// -170.9 at 0.20, -128.2 at 0.15, -85.5 at 0.10; all -855 * k).
			this.previewAnchorStale = true;
		}
		// The purged-canvas marker, and everything about it, is off unless
		// this is a mobile surface with diagnostics recording (PurgeSentinel.ts
		// says why it is not on for everyone yet). Desktop pays one boolean.
		const paintAt = diag ? performance.now() : 0;
		const probeArmed = this.paintCommittedWork(cam, work, strokes);
		const paintMs = diag ? performance.now() - paintAt : 0;
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
		if (!this.selection.isEmpty || this.lassoActive || this.spaceLineY !== null || this.spacePreview)
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
				work: work === "all" ? "all" : `${work.length} rect`,
				allFrom: plan.sources.join("+"),
				panBaked,
				damageIn: damageIn === "all" ? "all" : `${damageIn.length} rect`,
				camDeltaX: last ? cam.x - last.x : undefined,
				camDeltaY: last ? cam.y - last.y : undefined,
				bandMoved: bandMove === "moved",
				carried: this.bandCarriedThisFrame,
				syncCameraMs,
				paintMs,
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
		if (!this.container) return "none";
		const scroller = this.view.scrollDOM;
		const viewport: BandViewport = {
			scrollLeft: scroller.scrollLeft,
			scrollTop: scroller.scrollTop,
			clientWidth: scroller.clientWidth,
			clientHeight: scroller.clientHeight,
			scrollWidth: this.bandFreeScrollWidth ?? scroller.scrollWidth,
			scrollHeight: scroller.scrollHeight,
			// The band's margin is headroom for a fling, and a fling is measured
			// in the px the reader sees. Below 1.0 the host is counter-sized, so
			// the scroller's own px are worth `cssScale` of those - without this
			// term the margin shrinks with the zoom and the band is re-pinned on
			// every frame of a flick, each one a whole-world rasterisation.
			scale: this.cssScale,
		};
		// AN EASE BACK TO THE PAGE'S EDGE SHOWS ROOM LEFT OF THE SCROLL. The bounce moves the layer by a translate, and
		// the band is placed from the scroll alone, so while a page slides back from right of its edge the pane shows
		// scroll the band does not hold - ink in the left reserve, just drawn there, painted nowhere until the ease has
		// carried it off the pane. The band is widened to cover both ends of the ease, once: the width is taken at the
		// first sync of the bounce, rounded up to a whole px, and held while that bounce lives. Recomputed per sync it is
		// divided by a cssScale read back from the band's own rect, which each resize moves by a few millionths - a new
		// width, another resize, measured 1821 of them in one ease at 7% before the renderer died. Nothing lies left of
		// scroll zero, so the widening stops there: an ease on a page with no scroll to its left moves no band.
		const bounce = this.bounceState;
		if (!bounce || !(bounce.fromX > 0) || !(this.cssScale > 0)) this.bandEase = null;
		else if (this.bandEase?.bounce !== bounce) this.bandEase = { bounce, px: Math.ceil(bounce.fromX / this.cssScale) };
		const easeFrom = this.bandEase ? Math.min(this.bandEase.px, viewport.scrollLeft) : 0;
		if (easeFrom > 0) { viewport.scrollLeft -= easeFrom; viewport.clientWidth += easeFrom; }
		if (this.frame.locked) {
			// A stroke owns the frame. The band may stay where it is ONLY while
			// every pixel the viewport shows is inside it: deferring past that
			// point leaves the pen walking off the canvas edge, drawing wet ink
			// nowhere (Orion 2026-09-13, 10% far down and right: the mark that
			// lands before the frame that would have followed the last scroll
			// sits on a band one scroll behind, and its right-hand end is never
			// painted). A size change is still deferred: a reallocation blanks
			// five canvases and cannot be carried.
			if (!this.band || bandCovers(this.band, viewport)) { this.bandSyncDeferred = true; return "none"; }
			const want = bandFor(viewport);
			if (want.width !== this.band.width || want.height !== this.band.height) { this.bandSyncDeferred = true; return "none"; }
			return this.carryBandUnderLock(want);
		}
		this.bandSyncDeferred = false;
		this.bandFreeScrollWidth = null;
		// The note got shorter under a band that holds the scroll's end: place the band against the height the note
		// has without it, and as if the scroll had already clamped into that range (audit 178). Past the hysteresis,
		// because a shrink between half a margin and one and a half margins asks no move of bandNeedsMove.
		const freeHeight = this.measureBandFreeHeight(scroller, viewport.scrollHeight);
		if (freeHeight !== null) {
			viewport.scrollHeight = freeHeight;
			if (viewport.scrollTop > freeHeight - viewport.clientHeight) viewport.scrollTop = Math.max(0, freeHeight - viewport.clientHeight);
		} else if (!bandNeedsMove(this.band, viewport)) return "none";
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
		// A MOVE OF THE SAME BOX CARRIES ITS PIXELS, AT REST AS UNDER A STROKE. Placing the box and re-rastering the
		// world cost 7 to 10 ms per move with 1500 strokes on the pane, four moves per 300 px fling (ScrollCost, the
		// canvas-on finger-right arm). The carry slides the painted pixels by a whole number of device px and owes only
		// the strips the move uncovers. A shift that snaps to zero device px moves the box the old way. So does a raster
		// that may not hold what the store holds: one not of the camera now held, inside the sub-pixel bar (at rest a camera change can be waiting
		// for its repaint), or one painted when the store held a different number of strokes (a load that asked for no
		// repaint). The full redraw of the old path is what showed that ink; a carry would keep it missing for good.
		const last = this.lastPaintCam;
		if (!resized && last) {
			const held = this.camera.snapshot, path = this.filePath();
			if (cameraWithin(last.x, last.y, last.zoom, held.x, held.y, held.zoom, this.committedBacking ?? 0, CAMERA_STILL_BACKING_PX)
				&& this.paintedStrokeCount === (path ? inlineInk.strokes(path).length : 0)) {
				if (this.carryBandUnderLock(band) === "moved") {
					this.bandCarriedThisFrame = true;
					return "moved";
				}
				this.bandSyncDeferred = false;
			}
		}
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


	/**
	 * Move the band under a live stroke without moving anything the reader
	 * sees, and without a whole-world raster on the pen's own frame. The
	 * same carry serves a band move at rest (syncBand), for the same reason:
	 * the pixels are already right, only their box moved.
	 *
	 * The frozen pipeline's rule stands: the camera and the router's rect
	 * froze together at pen-down and are moved together here, by one delta.
	 * The band container slides by (dx, dy) layout px; the camera's world
	 * origin moves by the same amount, so every sample after this maps to the
	 * same world point it would have before; the router re-reads the
	 * container's rect once, so the client point the pen reports is measured
	 * against the box where it now is. Ink already painted on the five
	 * canvases is slid by the opposite amount, a WHOLE number of device px
	 * (the delta is snapped to the backing grid first), so it is pixel-exact,
	 * not resampled. The strips the move uncovers are the only committed work
	 * left, and they go through the ordinary partial-repaint path; the last
	 * painted camera is advanced so repaint() does not read the shift as a
	 * camera move and re-raster the world mid-contact.
	 *
	 * Wet ink that was never painted because it lay past the old edge is not
	 * recovered here; the commit redraws the stroke from its world points.
	 */
	private carryBandUnderLock(want: Band): "none" | "moved" {
		const current = this.band!, container = this.container;
		if (!container) return "none";
		const backing = this.committedBacking ?? this.backingNow();
		if (!(backing > 0) || !Number.isFinite(backing)) { this.bandSyncDeferred = true; return "none"; }
		// Snap to the backing grid: an integer device-px blit is exact.
		const dx = Math.round((want.left - current.left) * backing) / backing;
		const dy = Math.round((want.top - current.top) * backing) / backing;
		if (dx === 0 && dy === 0) { this.bandSyncDeferred = true; return "none"; }
		const cam = this.camera.snapshot;
		// UNITS. The band and the blit are layout px; the camera is note units
		// with the font zoom as its zoom (syncCamera divides the band offset by
		// fontZoom before setState). A layout delta enters the camera divided
		// by the same factor, and shiftPlan multiplies it back out for the
		// css-px blit, so the two agree at every font size and not only at 1.
		const f = Number.isFinite(this.fontZoom) && this.fontZoom > 0 ? this.fontZoom : 1;
		const camX = cam.x + dx / f, camY = cam.y + dy / f;
		const plan = shiftPlan(dx / f, dy / f, cam.zoom, camX, camY, this.cssWidth, this.cssHeight);
		if (plan === null) { this.bandSyncDeferred = true; return "none"; }
		this.band = { left: current.left + dx, top: current.top + dy, width: current.width, height: current.height };
		container.setCssStyles({ left: `${this.band.left}px`, top: `${this.band.top}px` });
		this.camera.setState(camX, camY, cam.zoom);
		for (const [ctx, canvas] of [[this.committedCtx, this.committedCanvas], [this.highlightCtx, this.highlightCanvas]] as const) {
			// drawImage throws on a 0x0 source; a deferred layer has nothing to carry.
			if (canvas === this.highlightCanvas && this.highlightPairDeferred) continue;
			ctx.save();
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.globalCompositeOperation = "copy";
			ctx.drawImage(canvas, Math.round(plan.shiftX * backing), Math.round(plan.shiftY * backing));
			ctx.restore();
		}
		this.wet.carry(plan.shiftX, plan.shiftY);
		if (!this.highlightPairDeferred) this.highlightWet.carry(plan.shiftX, plan.shiftY);
		this.tail.carry(plan.shiftX, plan.shiftY);
		// Prediction history is in the same canvas px as the tail it drew. Left
		// behind, the next guess extrapolated from points one carry away and
		// the tail vanished or pointed the wrong way. New objects: the samples
		// may be shared with the stroke being built.
		const carried = (s: PenSample): PenSample => ({ ...s, x: s.x + plan.shiftX, y: s.y + plan.shiftY });
		this.predReal = this.predReal.map(carried);
		this.predLastTail = this.predLastTail.map(carried);
		// The pixels moved with the camera: the next repaint owes only the
		// uncovered strips, not the world. The record is the camera the slid
		// pixels sit at - the painted one plus the shift - which can sit inside
		// the sub-pixel bar of the camera held; recording the held one instead
		// would let that gap stack up across carries.
		const base = this.lastPaintCam ?? cam;
		this.lastPaintCam = { x: base.x + dx / f, y: base.y + dy / f, zoom: cam.zoom };
		for (const rect of plan.exposed) this.damage.addRect(rect);
		this.router?.refreshRect();
		this.bandSyncDeferred = false;
		return "moved";
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

	private updateExtent(force = false, navigation?: { left: number; top: number }): void {
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
		const expansion = this.scrollExpansion ?? (this.canvasMode ? (this.scrollExpansion = new ScrollExpansionDemand()) : null);
		const scrollRevision = expansion?.sample(path, this.canvasMode, scroller.scrollLeft, scroller.scrollTop) ?? 0;
		const inputs: ExtentInputs = {
			scrollRevision,
			granted: surfaceExtents.get(path),
			path,
			frontier: (() => { const f = this.frontierCache.get(path, inlineInk.strokes(path)); this.pageInkX = f.x; return f; })(),
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
		// FIRST OF TWO: the ladder must cover the surface that already
		// exists, not only the one the spacer invents. A long note with Infinite
		// Canvas off never reaches the spacer branch below at all, and its own
		// scroll height is the whole distance the anchor has to span. This is
		// past the skip above, so it is not on the scroll path, and the method
		// has already forced layout for its own reads.
		growDocumentAnchorLadder(this.view, scroller.scrollHeight);
		// The origin is needed BEFORE growing now: the zoom frontier is
		// origin-relative, and it joins the ink frontier in one grow so a
		// magnified note's overhang is scrollable (see zoomFrontier).
		const contentRect = this.view.contentDOM.getBoundingClientRect();
		const preRect = scroller.getBoundingClientRect();
		const origin = surfaceOriginInScroller({
			contentLeftVisual: this.columnLeft(),
			documentTopVisual: this.documentTopUnpanned(),
			scrollRectLeft: preRect.left,
			scrollRectTop: preRect.top,
			scrollLeft: scroller.scrollLeft,
			scrollTop: scroller.scrollTop,
			scale: this.cssScale,
		});
		// Room left of the column first: it moves the origin in the scroller's
		// content px, and everything below is placed from the origin. Held under
		// a pinch zoom too: the owned layout lasts until a file switch or an
		// unmount, so a reserve lifted for it would be gone for the note's life.
		const reserveDelta = this.holdLeftReserve(path, origin);
		// The paper's phase follows this origin: read here, where the extent has
		// already paid for the layout, and never on a preview frame.
		this.capturePaperOrigin(origin.top, origin.left);
		const ink = inputs.frontier;
		// Shared with writeFrontier below - both need the same document-bottom
		// number and neither may re-read layout to get it.
		// Content extent is unpanned, just like the origin above. Including
		// residual pan here makes settling change its own native scroll range.
		const contentBottom = (contentRect.bottom - this.panY() - preRect.top) / this.cssScale + scroller.scrollTop;
		const zoom = this.viewportLayout ? ZERO_EXTENT : zoomFrontier({
			clientWidth: scroller.clientWidth,
			clientHeight: scroller.clientHeight,
			contentBottom,
			origin,
			pinchScale: this.pinchScaleNow,
			fontZoom: this.fontZoom,
		});
		// Room to write at the top of the screen (1.4.6 §5n): granted while the
		// surface is being written on, and while the note viewport is zoomed
		// out, which is a handwriting act of its own. A typing-only note at 1.0
		// keeps a byte-identical extent.
		const write = writeFrontierApplies(inputs)
			? writeFrontier({
					// WHICH VIEWPORT the 0.75 is a fraction OF. Zoomed out, the
					// scroller is counter-sized and CSS-scaled back down, so the
					// takeover pane height is a TENTH of a screenful at 0.1 - the
					// grant it buys is ~60 visual px, which is the same "nothing
					// below the text" the frontier is here to fix. Below 1.0 the
					// screenful IS the scroller's client box, so measure against
					// that; written-on notes have the same need and take the same
					// term. At and above 1.0 the term is unchanged, so zoom-in and
					// 100% stay byte-identical.
					clientHeight: inputs.pinchScale < 1 ? scroller.clientHeight : (this.viewportLayout?.height ?? scroller.clientHeight),
					contentBottom,
					origin,
					fontZoom: this.fontZoom,
				})
			: ZERO_EXTENT;
		const scroll = this.canvasMode && expansion ? expansion.reserve({
			left: scroller.scrollLeft, top: scroller.scrollTop,
			nativeWidth: scroller.clientWidth, nativeHeight: scroller.clientHeight,
			width: scroller.clientWidth,
			height: scroller.clientHeight,
			edgeX: scroller.scrollWidth, edgeY: scroller.scrollHeight,
			origin, fontZoom: this.fontZoom, pinchScale: this.pinchScaleNow,
		}, navigation) : ZERO_EXTENT;
		// Sideways room is the ink's to ask for only when it reaches past the pane,
		// unless Infinite Canvas is on (inkClaimX).
		const inkX = inkClaimX({
			frontierX: ink.x,
			originLeft: origin.left,
			clientWidth: scroller.clientWidth,
			fontZoom: this.fontZoom,
			infiniteCanvas: this.canvasMode,
		});
		const grown = surfaceExtents.grow(path, {
			x: Math.max(inkX, zoom.x, scroll.x),
			y: Math.max(ink.y, zoom.y, write.y, scroll.y),
		});
		const granted = this.shrinkSideways(path, ink, grown, Math.max(inkX, zoom.x), origin.left, scroller, force);
		if (!this.spacer && granted.x === 0 && granted.y === 0 && !(this.leftReserveHeld > 0)) return;
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
		// The origin computed above, and the granted extent (note px)
		// converted with the font zoom, so the scroll range tracks the
		// ink's rendered size.
		const atGrant = spacerPosition(origin, {
			x: granted.x * this.fontZoom,
			y: granted.y * this.fontZoom,
		});
		// A reserve needs a full view of range past it, or the scroll that pays for
		// it is clamped and the column moves. The view is the scroller's OUTER
		// width: with its x overflow hidden the engine stops the scroll short of the
		// range by the vertical scrollbar's gutter (measured: scrollLeft 218 asked,
		// 203 given, scrollWidth 723, clientWidth 505, offsetWidth 520). The cost,
		// stated: where the x overflow scrolls, the range while a reserve is held
		// reaches up to one gutter further right than the view needs. That room is
		// right of the page, never blank left of the ink.
		const pos = this.leftReserveHeld > 0
			? { left: Math.max(atGrant.left, Math.ceil(this.leftReserveHeld + Math.max(scroller.clientWidth, scroller.offsetWidth || 0)) - 1), top: atGrant.top }
			: atGrant;
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
		// The reserve's scroll, now that the range holds it: the column comes back
		// to where it was on screen in the same pass that shifted it.
		if (reserveDelta !== 0) {
			scroller.scrollLeft = Math.max(0, scroller.scrollLeft + reserveDelta);
			expansion?.rebase(scroller.scrollLeft, scroller.scrollTop, true);
			scrollProbeExtent(`left reserve ${this.leftReserveHeld} (moved ${reserveDelta})`);
		}
		// The grant is one of the box's two size terms, so it follows the spacer - only when the spacer moved,
		// which is not a scrolled frame.
		if (moved) this.syncGridPaperBox();
		// The grant shrank since this editor's last pass, here or in another pane
		// showing the note. Not on first sight of a note: a note switch is not a shrink.
		const shrinks = surfaceExtents.shrinkCount(path), shrinksSeen = this.shrinksSeen.get(path);
		this.shrinksSeen.set(path, shrinks);
		// AND AFTER A SCALE COMMIT, whether or not the grant moved: the band's margin is sized for the viewport it was
		// pinned in, so a zoom-out pins it for the counter-sized one and the settle back used to leave that margin holding
		// range nothing had granted (measured on a blank note, 100 -> 25 -> 100: 200 px of it, with the grant 0 throughout).
		const releaseAfterCommit = this.bandMarginReleasePending;
		this.bandMarginReleasePending = false;
		if ((shrinksSeen !== undefined && shrinks !== shrinksSeen) || releaseAfterCommit) this.releaseBandMargin(scroller, pos.left + 1);
		// SECOND OF TWO: the spacer's own demand, which can exceed the
		// scroll height the browser has applied so far. Growth is monotonic and
		// idempotent, so the two calls cannot fight; between them the ladder
		// covers whichever of the two surfaces is longer, and it never reaches
		// past the surface that exists.
		//
		// HERE AND NOWHERE ELSE (with the call above): this frame is already a
		// write moment and has already forced layout, so the one childList
		// mutation costs the CodeMirror measure that any mutation costs on a
		// frame that was doing that work anyway - instead of putting a measure
		// on the scroll path, which is what the design ruled out.
		growDocumentAnchorLadder(this.view, pos.top);
		scroller.classList.toggle("handwriting-hscroll", granted.x > 0 || this.leftReserveHeld > 0);
		// AFTER the class rather than twenty-one lines before it. ORDER IS NOT THE
		// MECHANISM, and saying so was wrong: measured on read, `handwriting-hscroll`
		// styles only the horizontal scrollbar (styles.css:2198-2211); the property
		// the guard reads is changed by `handwriting-hscroll-axis`, which the guard
		// itself adds. So the pre-class read saw the same `overflow-x` the post-class
		// read sees, and moving the call cannot by itself have fixed anything. It is
		// kept because reading the state a pass established, in that pass, is the
		// honest order - not because it was the defect.
		//
		// THE DEFECT IS THE LATCH BELOW, and that one is on the read: the check
		// marked itself done without a verdict, so a pass with nothing to open
		// spent the only attempt the note ever got. The
		// axis then stayed shut for the life of the note, and the only things
		// that re-arm it are teardown and handleResize's reallocation, which is
		// exactly why toggling the setting off and on was the cure and nothing
		// else was (alan: "i cannot scroll to the right because i havent toggled
		// infinite canvas off and then on").
		//
		// Left ink only, which is what made it look arbitrary: the surface never
		// goes negative, so ink to the RIGHT is reachable without granting an x
		// extent at all and never needs the axis. A stroke left of the column is
		// the one case that does.
		this.ensureScrollableAxis(scroller);
		if (moved || !this.lastReach) this.measureReach(scroller, pos.left + 1);
	}

	/**
	 * The x grant comes back down to what the ink and the zoom still need, when
	 * one is due: ink was removed (erase, lasso delete, Delete all ink, an undo),
	 * noticed here as the frontier getting smaller, which writing never does, so
	 * the chunked growth that keeps a scrollbar from pumping per stroke is
	 * untouched; or Infinite Canvas was turned off (setScrollExpansionEnabled),
	 * which takes back the room scrolling had demanded.
	 *
	 * Never under what is on screen: not in this editor, and not in any other
	 * editor showing the note, since the grant is the note's and every pane's
	 * spacer follows it. The part off to the right of every view goes now; the
	 * rest stays due until the views move left or a later pass finds it clear.
	 * The vertical grant is not touched. While Infinite Canvas is on nothing
	 * shrinks: the grant holds room scrolling demanded, which no frontier knows.
	 *
	 * WHEN. A shrink takes its first step at the pass that made it due, which
	 * follows the removal or the setting. What a view held back steps again only
	 * at the end of a gesture: a forced pass (a pen, pan, space or pinch
	 * settle), or once a scroll has been quiet for SHRINK_SCROLL_IDLE_MS. Never
	 * on a scrolled frame, so a scroll in progress never has its range move.
	 */
	private shrinkSideways(path: string, ink: Extent, granted: Extent, neededX: number, originLeft: number, scroller: HTMLElement, force: boolean): Extent {
		const seen = this.extentFrontierSeen.get(path);
		if (seen !== undefined && ink.x < seen) surfaceExtents.oweShrinkX(path);
		this.extentFrontierSeen.set(path, ink.x);
		this.sidewaysView = { path, scrollLeft: scroller.scrollLeft, clientWidth: scroller.clientWidth, originLeft, fontZoom: this.fontZoom };
		const due = surfaceExtents.shrinkDue(path);
		if (due === undefined) return granted;
		if (this.canvasMode) {
			surfaceExtents.settleShrinkX(path);
			return granted;
		}
		if (this.shrinkStepped.get(path) === due && !force) return granted;
		this.shrinkStepped.set(path, due);
		let floor = 0;
		for (const p of instances) {
			const view = p.sidewaysView;
			if (view && view.path === path) floor = Math.max(floor, onScreenFloorX(view));
		}
		const shrunk = shrunkAxis(granted.x, neededX, floor);
		if (shrunk.complete) surfaceExtents.settleShrinkX(path);
		if (shrunk.value === granted.x) return granted;
		scrollProbeExtent(`x grant ${granted.x} -> ${shrunk.value}${shrunk.complete ? "" : " (held by a view)"}`);
		const next = surfaceExtents.shrinkX(path, shrunk.value);
		// Every other pane showing the note moves its spacer to the new grant.
		for (const p of instances) if (p !== this && p.filePath() === path) p.scheduleRepaint("extent-shrink");
		return next;
	}

	/** Take a held shrink's next step once the scroll has been quiet a moment; re-armed by every scroll event. */
	private shrinkWhenScrollIsQuiet(): void {
		if (this.shrinkIdleTimer !== null) this.winRef.clearTimeout(this.shrinkIdleTimer);
		this.shrinkIdleTimer = this.winRef.setTimeout(() => {
			this.shrinkIdleTimer = null;
			const path = this.filePath();
			if (this.view?.dom?.isConnected && path && surfaceExtents.owesShrinkX(path)) this.updateExtent(true);
		}, SHRINK_SCROLL_IDLE_MS);
	}

	/**
	 * The band is an absolutely positioned child of the scroller too, and while
	 * the range was wider it took a sideways margin (bandFor) reaching past where
	 * the spacer now stands. After a shrink that margin alone holds the range at
	 * the band's right edge, and every band sync reads back the range it is
	 * holding up and keeps it: measured, a note scrolled home after its far ink
	 * was deleted kept a margin's width of sideways scroll for good. So measure
	 * the range once without the band's margin and let the next sync place the
	 * band against that. Only on the first pass after the note's grant shrank,
	 * never on a scroll.
	 *
	 * NOT FOR ANY OTHER SPACER MOVE. A spacer that moved left for another reason
	 * is left to the band, as before: on the note-switch lifecycle cell in
	 * ScrollColumnAnchorPinch (10 percent) a switch moved the spacer's right edge
	 * to 342 px against a 1383 px view, a release there re-pinned the band to the
	 * view's own width, and the band stopped covering the pane.
	 *
	 * And never when the range without the band would end short of the view,
	 * which layout would answer by clamping scrollLeft. A shrink never does that
	 * (onScreenFloorX); this is the guard that it stays so.
	 *
	 * The band is slid left, not hidden, so its right edge meets the spacer while
	 * its size and top stay put: the range read is everything else's, and the
	 * vertical range, which the band's bottom can touch, is not disturbed.
	 */
	private releaseBandMargin(scroller: HTMLElement, spacerRight: number): void {
		const band = this.band, container = this.container;
		if (!band || !container || band.left + band.width <= Math.max(scroller.clientWidth, spacerRight)) return;
		if (Math.max(scroller.clientWidth, spacerRight) < scroller.scrollLeft + scroller.clientWidth) return;
		container.setCssStyles({ left: `${spacerRight - band.width}px` });
		const free = scroller.scrollWidth;
		container.setCssStyles({ left: `${band.left}px` });
		this.bandFreeScrollWidth = free;
		scrollProbeExtent(`band margin released: range without the band ${free}`);
		this.scheduleRepaint("extent-shrink");
	}

	/**
	 * The vertical twin of releaseBandMargin. Near the end of a note bandFor puts the band's bottom on the
	 * scroller's reported height, and the band is an absolutely positioned child of the scroller, so that height
	 * already counts the band: after the note shrinks the scroller keeps reporting the old height, the band asks
	 * for the old bottom again, and the blank room below the last line never goes (audit 178).
	 *
	 * So when CodeMirror's content height has dropped since the last sync AND the band's bottom is what holds
	 * the scroll's end, the band is slid wholly above the scroll origin for one read of scrollHeight and put back.
	 * Returns that band-free height when it is shorter than the band's bottom, else null.
	 *
	 * COST. The gate is a compare against a number CodeMirror already holds, so a scroll frame on an unchanged
	 * note adds no layout read. Only a shrink with the band at the end pays one forced layout.
	 */
	private measureBandFreeHeight(scroller: HTMLElement, reported: number): number | null {
		const contentHeight = this.view.contentHeight;
		const seen = this.bandContentHeight;
		this.bandContentHeight = contentHeight;
		// `typeof`, not `!== null`: a unit rig built with Object.create never runs the initialiser.
		if (typeof seen !== "number" || !(contentHeight < seen)) return null;
		const band = this.band, container = this.container;
		if (!band || !container || band.top + band.height < reported - 1) return null;
		container.setCssStyles({ top: `${-band.height}px` });
		const free = scroller.scrollHeight;
		container.setCssStyles({ top: `${band.top}px` });
		scrollProbeExtent(`band bottom released: height without the band ${free}`);
		return free < band.top + band.height ? free : null;
	}

	/**
	 * Hold exactly the room ink left of the origin needs beside the column, at
	 * rest and unzoomed: measured against the margin the column has without it,
	 * so a pane that widens stops holding any and one that narrows holds the
	 * shortfall. Shifts the pan carrier and moves `origin` with it; returns the
	 * change, which the caller scrolls by once the range can hold it.
	 */
	private holdLeftReserve(path: string, origin: { left: number; top: number }): number {
		const sizer = this.panSizer();
		const reach = this.frontierCache.leftReach(path, inlineInk.strokes(path));
		// `> 0`, not the field alone: a unit rig built with Object.create never runs the initialiser.
		const held = this.leftReserveHeld > 0 ? this.leftReserveHeld : 0;
		const want = sizer ? leftReserve({ reachNote: reach, naturalMargin: origin.left - held, fontZoom: this.fontZoom }) : 0;
		const delta = want - held;
		if (delta === 0) return 0;
		if (sizer) {
			if (want > 0) sizer.style.setProperty("translate", `${want}px`);
			else if (sizer.style.getPropertyValue("translate") === `${held}px`) sizer.style.removeProperty("translate");
		}
		this.leftReserveHeld = want;
		origin.left += delta;
		// Under a pinch zoom the frozen column is painted where it was measured
		// plus the new shift; its margin does not move.
		const layout = this.viewportLayout;
		if (layout && layout.columnLocal !== null) {
			layout.columnLocal += delta;
			layout.columnReserve = want;
		}
		return delta;
	}

	/** Teardown: the carrier's shift comes off and the scroll that paid for it with it. */
	private dropLeftReserve(): void {
		const held = this.leftReserveHeld;
		if (!(held > 0)) return;
		this.leftReserveHeld = 0;
		const sizer = this.panSizer();
		if (sizer && sizer.style.getPropertyValue("translate") === `${held}px`) sizer.style.removeProperty("translate");
		const scroller = this.view.scrollDOM;
		scroller.scrollLeft = Math.max(0, scroller.scrollLeft - held);
	}

	private ensureScrollableAxis(scroller: HTMLElement): void {
		if (this.axisChecked || this.axisGuard.patched) return;
		// LATCHED ONLY ON A VERDICT. Setting this before knowing the outcome spent
		// the single check on a pass that had nothing to open, and no later pass
		// could try again. The guard is idempotent - `assert` returns immediately
		// once `patched` - so leaving it unlatched costs one early-out per extent
		// pass and buys back every retry.
		const overflowX = this.winRef.getComputedStyle(scroller).overflowX;
		this.axisGuard.assert(scroller, overflowX);
		if (this.axisGuard.patched) {
			this.axisChecked = true;
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
	provide: plugin => EditorView.editorAttributes.of(view => {
		const overlay = view.plugin(plugin);
		if (!overlay?.ownsNoteViewport()) return null;
		// BOTH tokens, because this facet is the host's class attribute: CodeMirror writes it whole on every update and
		// anything not named here is dropped. See `noteViewportOwnLines`.
		return { class: overlay.noteViewportOwnLines() ? "handwriting-note-viewport handwriting-note-viewport-own-lines" : "handwriting-note-viewport" };
	}),
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

type ViewportScrollLifetime = {
	owners: WeakMap<SelectionRange, object>;
	pending: object | null;
	extension: Extension;
	/** Whether `extension` is already part of this state's configuration. */
	installed: (state: EditorState) => boolean;
};
const viewportScrollLifetimes = new WeakMap<EditorView, ViewportScrollLifetime>();

/** Cancellation belongs to the issued request's editor, beyond the overlay's
 * own lifetime. Reconfiguration may remove every ordinary plugin extension.
 */
function viewportScrollLifetime(view: EditorView): ViewportScrollLifetime {
	const existing = viewportScrollLifetimes.get(view);
	if (existing) return existing;
	const lifetime: ViewportScrollLifetime = { owners: new WeakMap(), pending: null, extension: [], installed: () => false };
	const extender: Parameters<typeof EditorState.transactionExtender.of>[0] = tr => {
		if (!lifetime.pending) return null;
		if (lifetime.installed(tr.state)) return null;
		// Preserve only cancellation capability. Never reinstall the overlay,
		// change a document/selection, or replace another navigation request.
		return { effects: StateEffect.appendConfig.of(lifetime.extension) };
	};
	lifetime.installed = state =>
		state.facet(EditorView.scrollHandler).includes(consumeViewportScroll) &&
		state.facet(EditorState.transactionExtender).includes(extender);
	const retirement = ViewPlugin.define(() => ({ destroy: () => { lifetime.pending = null; } }));
	lifetime.extension = [Prec.highest(EditorView.scrollHandler.of(consumeViewportScroll)), EditorState.transactionExtender.of(extender), retirement];
	viewportScrollLifetimes.set(view, lifetime);
	return lifetime;
}

const consumeViewportScroll = (view: EditorView, range: SelectionRange): boolean => {
	const lifetime = viewportScrollLifetimes.get(view);
	// CM has one pending target. A foreign target reaching this handler also
	// proves it replaced the old request; that discarded receipt will never
	// get a separate completion. Recognition stays weak, preservation stops.
	if (lifetime) lifetime.pending = null;
	const overlay = view.plugin(inkOverlayPlugin);
	return overlay ? overlay.consumeViewportScroll(range) : !!lifetime?.owners.has(range);
};

export function inkOverlayExtension(): Extension {
	return [
		Prec.highest(EditorView.scrollHandler.of(consumeViewportScroll)),
		inlineSelectionKeyHandlers,
		inkOverlayPlugin,
		inkHistorySupport(),
	];
}

/** Two insert-space seams that draw the same preview. */
function samePlan(a: SpaceBoundary, b: SpaceBoundary): boolean {
	return a.y === b.y && a.from === b.from && a.lineHeight === b.lineHeight &&
		a.text === b.text && a.blockFallback === b.blockFallback;
}
