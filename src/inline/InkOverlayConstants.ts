/**
 * The overlay's module constants and small helpers: the pan, extent, overscroll and paper numbers, the measure-hold types, the
 * pinch-constraint types and the canvas reallocation counter. They are re-exported from InkOverlay.ts, which the other overlay files import them from.
 */
import { EditorView } from "@codemirror/view";
import { Platform } from "obsidian";
import { pressureSensitivityEnabled } from "../ink/PenStyle";
import { inkThemeAdaptationEnabled, inkThemeOverride } from "../ink/InkTheme";
import { inkShapingEnabled } from "../ink/InkShape";
import { BandViewport, bandMarginMax } from "./ScrollBand";

/** How long after a pinch-driven scroll write repaints stay suppressed. */
export const PINCH_SCROLL_QUIET_MS = 120;

/** A CodeMirror measure request, as `EditorView.requestMeasure` takes it. */
export type CmMeasureRequest = NonNullable<Parameters<EditorView["requestMeasure"]>[0]>;

/** One entry of the view the hold shadows; see `holdMeasures`. */
export interface MeasureHoldEntry {
	name: "requestMeasure" | "measure";
	/** The own-property descriptor the shadow displaced, if the view had one. */
	displaced: PropertyDescriptor | undefined;
	/** What a call reached before the hold: the displaced callable, else the prototype's. Captured once. */
	callable: (this: EditorView, ...args: unknown[]) => unknown;
	shadow: (...args: unknown[]) => unknown;
}

/** CodeMirror's measuring, held for a pinch preview; see `holdMeasures`. */
export interface MeasureHold {
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
export const PAN_MIN_VISIBLE_PX = 24;
/**
 * A DRAG, NOT A ZOOM. The give is a pan claim, and a preview frame that is changing the scale must
 * keep the note under the focal point with no bound at all - that is what the settle-only bound exists for
 * and what the earlier attempt at this broke (3884c642, "take the preview clamp back out, it breaks the
 * focal hold"). A frame counts as a drag while the scale is within this of where the gesture started.
 */
export const PAN_DRAG_SCALE_EPS = 0.05;
/**
 * The scale has held when it is within this of the scale PAN_DRAG_WINDOW frames ago. Measured: a
 * zoom the rig ramps at 0.31 percent a frame (RllColumnFocalHold, 85 percent with travel) moves 2.5
 * percent over eight frames and must keep its focal hold; a spread held by two fingers moves well under
 * 0.8 percent over eight. The window is the lead a drag gets before the band engages.
 */
export const PAN_DRAG_FRAME_EPS = 0.008;
export const PAN_DRAG_WINDOW = 8;
/**
 * Box comparisons under this are not a fit or a miss, just layout rounding: a
 * column that fits leaves a fraction of a pixel behind on some zooms, and a
 * fraction is not something a pan can be spent into. Measured on the render
 * fixture: the scroller's remaining range is 0 at 100% in both
 * readable-line-length states and 0 at 150% with readable line length on (the
 * 700 px column still fits the 1397.5 px pane), 466 at 150% with it off.
 */
export const PAN_FIT_SLACK_PX = 1;
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
export const PAN_SETTLE_ZOOM_BAND = { below: 0.8, above: 1.25 };

/**
 * The most device pixels one extent raster may hold, per layer. Below 100 percent a note's whole ink, drawn once, fills the strips a
 * pan uncovers by copy instead of by path: on the MCB EXAM 3 note at 10 percent a strip drew 160,000 to 198,000 path points (17 to
 * 24 ms on the rig, far more on Orion), and a far fling at 17 percent froze for 543 to 951 ms redrawing the whole layer. That note's
 * ink is 6.2 million device px at 10 percent and 18.1 million at 17 percent at a ratio of 2 (15.1 million on Orion), so the desktop
 * cap holds the largest exam note at 17 percent: 80 MB a layer at most. Mobile canvas memory is tight, so a phone or tablet keeps
 * the smaller cap and pans a larger note by path as before.
 */
export const EXTENT_RASTER_MAX_PX_DESKTOP = 20_000_000;
export const EXTENT_RASTER_MAX_PX_MOBILE = 8_000_000;
/**
 * The settings that change how a stroke paints without changing the stroke, as one number: the width law and smoothing
 * (InkShape), pressure, and the theme adaptation and its override. An extent raster drawn under one value is stale under another.
 * Live paint ignores the theme today (InkTheme.inkColorFor returns the stored colour on screen); the two theme bits keep the raster
 * honest if that ever changes, at no cost.
 */
export function inkLookKey(): number {
	const o = inkThemeOverride();
	return (inkShapingEnabled() ? 1 : 0) | (pressureSensitivityEnabled() ? 2 : 0) | (inkThemeAdaptationEnabled() ? 4 : 0) | (o === null ? 0 : o ? 8 : 16);
}
/** Whether an extent raster of w x h device px may be kept on this platform. */
/** The longest a piece of the extent raster's build draws before it yields, in ms; one stroke may run past it (INBOX row 511). */
export const EXTENT_PIECE_MS = 4;
/** How long a piece that may not run waits before it asks again, in ms. */
export const EXTENT_PIECE_RETRY_MS = 50;
/** How long after the last scroll repaint was asked for before a piece may run, in ms: a wheel or trackpad pan holds no contact. */
export const EXTENT_SCROLL_QUIET_MS = 150;

export function extentRasterFits(w: number, h: number, mobile: boolean = Platform.isMobile): boolean {
	const cap = mobile ? EXTENT_RASTER_MAX_PX_MOBILE : EXTENT_RASTER_MAX_PX_DESKTOP;
	return w > 0 && h > 0 && w <= 16_384 && h <= 16_384 && w * h <= cap;
}
/** While a zoom stand-in is held, the stand-in and the build together may hold this many times the raster cap (arm: 96 MB peak on MCB). */
export const EXTENT_PAIR_FACTOR = 1.6;
/**
 * The smallest scale a zoom stand-in is copied at. A raster shown much smaller drops floor-width strokes between its samples (a Fit
 * far below 10 percent copied at about one twentieth showed the note blank for some 200 ms; one fifth kept the ink), so below this
 * the layer is drawn by path, as before the stand-in. The small slack keeps a copy at exactly one quarter on the stand-in.
 */
export const STAND_IN_MIN_FACTOR = 0.25;
/**
 * Whether a zoom stand-in may be taken at all. On: a zoom's settle shows the old raster scaled into place, the raster is built
 * after it in pieces, and a pinch lift takes the stand-in. It was off for 1.4.23, where a stand-in taken while a bounce played
 * over the zoom commit was a small old picture at the layer's corner, its ink 500 to 575 device px from where the sharp ink lands,
 * held about a second; with it off, the layer is drawn by path, as before the stand-in.
 */
export const ZOOM_STAND_IN_ENABLED: boolean = true;
export function standInFactorFits(f: number): boolean {
	return f >= STAND_IN_MIN_FACTOR - 1e-9;
}
/** Whether a build of `buildPx` device px (both layers) may run beside a held stand-in of `heldPx`. */
export function extentPairFits(buildPx: number, heldPx: number, mobile: boolean = Platform.isMobile): boolean {
	return buildPx + heldPx <= EXTENT_PAIR_FACTOR * (mobile ? EXTENT_RASTER_MAX_PX_MOBILE : EXTENT_RASTER_MAX_PX_DESKTOP);
}
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
export const OVERSCROLL_BOUNCE_MS = 500;
/** A correction smaller than this, in painted px, is not animated: it cannot be seen, and a settle stands within it. */
export const OVERSCROLL_BOUNCE_MIN_PX = 2;
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
export const OVERSCROLL_GIVE_PX = 96;

/**
 * HOW FAR A TRAVELLED EASE MAY SLIDE BACK LEFTWARD OR UPWARD, in band px, per axis: one maximal band margin at the
 * ink's css scale, and never more than the scroll room on the side the ease uncovers. The settle eases a correction
 * within it and refuses one past it, and syncBand widens the band for the ease by no more than it, so the band is
 * never asked to cover a slide of thousands of px (a zoom-out to 0.322 at scrollTop 5000 settled a 3433 px
 * correction, and widening the band for it crashed the renderer).
 */
export function travelledEaseRoom(v: BandViewport): { x: number; y: number } {
	const max = bandMarginMax(v.scale ?? 1);
	return {
		x: Math.min(max, Math.max(0, v.scrollWidth - v.scrollLeft - v.clientWidth)),
		y: Math.min(max, Math.max(0, v.scrollHeight - v.scrollTop - v.clientHeight)),
	};
}

export interface PinchConstraintGeometry {
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
	/** The native scroll this snapshot was read at. Scroll taken after it moved the painted page with no preview frame
	 *  to follow it, so the settle carries that much on into its target. */
	scrollLeft: number; scrollTop: number;
}

export interface PinchConstraint {
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
export let canvasReallocs = 0;

export function inkCanvasReallocs(): number {
	return canvasReallocs;
}
/**
 * Count one canvas reallocation from code outside this module, which
 * cannot assign the binding itself (the resize in InkOverlayLayout.ts).
 */
export function bumpCanvasReallocs(): void { canvasReallocs++; }

/**
 * Relative change in the measured scale worth acting on. Below this it is
 * sub-pixel rect noise, and adopting it costs a full repaint per frame.
 */
export const SCALE_EPSILON = 1e-3;

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
export const CONTENT_ORIGIN_EPSILON = 1;

/** The paper properties the overlay plans; see updatePaperSpacing. */
export const PAPER_PROPERTIES = ["--handwriting-paper-pitch", "--handwriting-paper-rule", "--handwriting-paper-dot", "--handwriting-paper-phase", "--handwriting-paper-phase-x"] as const;

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

/** How far outside the selection box still counts as grabbing it, in px. */
export const SELECTION_GRAB_PAD = 8;

export type PenMode = "ink" | "erase" | "lasso" | "space" | "pan";

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
export const INLINE_DESYNCHRONIZED = false;
/** Real samples kept for extrapolation; the turn guard averages a window. */
export const PRED_HISTORY = 12;
