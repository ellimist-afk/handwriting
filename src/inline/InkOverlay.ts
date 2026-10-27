import { EditorView, ViewPlugin } from "@codemirror/view";
import { EditorState, StateEffect, Prec, type Text, type SelectionRange } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Platform, editorInfoField } from "obsidian";
import { Camera } from "../camera/Camera";
import type { CameraOriginY } from "./CameraOriginY";
import {
	InsertSpaceRows,
	type SpaceBoundary,
	type SpaceProtectedBlock,
} from "./InsertSpace";
import { MobileTools, NoteZoomControls } from "./MobileTools";


import { DEFAULT_PEN, HIGHLIGHTER_PEN, PenStyle } from "../ink/PenStyle";
import { Point2 } from "../ink/Smoothing";
import { BBox, InkStroke } from "../ink/Stroke";
import { LineAnchors, type LineSignature } from "./LineAnchor";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { TailRenderer } from "../ink/TailRenderer";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { PenSample } from "../input/PointerRouter";
import { SnapPreview, SnapPreviewCanvas } from "./SnapPreview";
import { SelectionModel } from "../objects/SelectionModel";
import {
	inkHistorySupport,
} from "./InkHistory";
import { SnapChip } from "./SnapChip";
import {
	InlineSelectionDeleteKeys,
} from "./InlineSelectionDelete";
import { StrokeFrame } from "./StrokeFrame";
import { Band } from "./ScrollBand";
import {
	frontmatterPropertyKeys,
} from "./MetadataVisibility";
import {
	committedFloorFor,
	enabled,
	instances,
	scrollExpansionEnabled,
	type GutterPanMode,
} from "./InkOverlayRegistry";
import {
	EmptyPageNoticeGate,
} from "./EmptyPageNotice";
import { ExtentInputs, FrontierCache } from "./FrontierCache";
import { DamageLedger } from "../ink/DamageLedger";
import { StrokeIndex } from "../ink/StrokeIndex";
import { MIN_PINCH_SCALE } from "./PinchScale";
import { WheelZoomRun, WHEEL_ZOOM_QUIET_MS } from "./WheelZoom";
import { installCursors } from "./InkOverlayCursors";
import { installLassoSpace } from "./InkOverlayLassoSpace";
import { installInkOverlayClipboard } from "./InkOverlayClipboard";
import { installPaperPinch } from "./InkOverlayPaperPinch";
import { installPanSettle } from "./InkOverlayPanSettle";
import { installInkOverlayViewportBox } from "./InkOverlayViewportBox";
import { installInkOverlayColumnMargin } from "./InkOverlayColumnMargin";
import { installDiagnostics } from "./InkOverlayDiagnostics";
import { installMeasureHold } from "./InkOverlayMeasureHold";
import { installLayout } from "./InkOverlayLayout";
import { installLifecycle } from "./InkOverlayLifecycle";
import { installKeys } from "./InkOverlayKeys";
import { installZoomApi } from "./InkOverlayZoomApi";
import { installPinch } from "./InkOverlayPinch";
import { installLineAnchors } from "./InkOverlayLineAnchors";
import { installReload } from "./InkOverlayReload";
import { installGestureEnd } from "./InkOverlayGestureEnd";
import { installInkOps } from "./InkOverlayOps";
import { installErase } from "./InkOverlayErase";
import { installExtent } from "./InkOverlayExtent";
import { installBand } from "./InkOverlayBand";
import { installPenSupport } from "./InkOverlayPenSupport";
import { installPenPath } from "./InkOverlayPenPath";
import { holdKeyboardForEveryPen } from "./InlineFocus";
import { penInkEnabled } from "./PenInk";
import { installInkOverlayCamera } from "./InkOverlayCamera";
import { installInkOverlayRepaint } from "./InkOverlayRepaint";
import {
	backingScale,
	rasterScale,
} from "./ZoomScale";
import { InlinePenRouter } from "./InlinePenRouter";
import {
	ScrollAxisGuard,
	ScrollExpansionDemand,
} from "./SurfaceExtent";
import { type PreviewPaperEnd } from "./PaperPan";

/** The module constants and helpers live in InkOverlayConstants.ts; the other overlay files keep importing them from here. */
import { bumpCanvasReallocs, SCALE_EPSILON, type MeasureHold, type PinchConstraintGeometry, type PinchConstraint, type PenMode } from "./InkOverlayConstants";
export { PINCH_SCROLL_QUIET_MS, PAN_MIN_VISIBLE_PX, PAN_DRAG_SCALE_EPS, PAN_DRAG_FRAME_EPS, PAN_DRAG_WINDOW, PAN_FIT_SLACK_PX, PAN_SETTLE_ZOOM_BAND, EXTENT_RASTER_MAX_PX_DESKTOP, EXTENT_RASTER_MAX_PX_MOBILE, inkLookKey, EXTENT_PIECE_MS, EXTENT_PIECE_RETRY_MS, EXTENT_SCROLL_QUIET_MS, extentRasterFits, EXTENT_PAIR_FACTOR, STAND_IN_MIN_FACTOR, ZOOM_STAND_IN_ENABLED, standInFactorFits, extentPairFits, OVERSCROLL_BOUNCE_MS, OVERSCROLL_BOUNCE_MIN_PX, OVERSCROLL_GIVE_PX, travelledEaseRoom, canvasReallocs, inkCanvasReallocs, bumpCanvasReallocs, SCALE_EPSILON, CONTENT_ORIGIN_EPSILON, PAPER_PROPERTIES, SELECTION_GRAB_PAD, INLINE_DESYNCHRONIZED, PRED_HISTORY } from "./InkOverlayConstants";
export type { CmMeasureRequest, MeasureHoldEntry, MeasureHold } from "./InkOverlayConstants";


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

/**
 * The tool and setting state lives in InkOverlayToolState.ts. Every exported
 * name is re-exported here, so no importer's import line changed.
 */
export {
	inlineTool,
	getInkSizeMult,
	setInkSizeMult,
	getInlineTool,
	setInlineTool,
	getInlineEraserMode,
	setInlineEraserMode,
	getInlineLassoMode,
	setInlineLassoMode,
	getInlineSpaceMode,
	setInlineSpaceMode,
	tipModeHeld,
	releaseTipModes,
	getInlinePanMode,
	setInlinePanMode,
	inlineEraserRadiusPx,
	getEraserRadiusPx,
	setEraserRadiusPx,
	setPersistEraserRadius,
	getToolbarCorner,
	addStripSurface,
	setToolbarCorner,
	setPersistToolbarCorner,
	applyToolbarPlacement,
	setShapeSnap,
	setPenReticle,
	penReticleEnabled,
	setEraserWholeStrokes,
	getEraserWholeStrokes,
	persistEraserMode,
	setPersistEraserMode,
	persistEraserModeNow,
	pickStripColor,
	commitEraserRadius,
	persistInkSize,
	setPersistInkSize,
	applyInkSize,
} from "./InkOverlayToolState";

/** What the committed layers hold after a zoom stand-in's last whole copy: camera, backing, device ratio, canvas size, highlight pair
 * state and stroke set (array, count, generation). A whole repaint that finds all of them unchanged paints nothing. */
export type StandInMark = {
	x: number; y: number; zoom: number; backing: number; dpr: number; w: number; h: number; hlDeferred: boolean;
	strokes: readonly InkStroke[]; count: number; generation: number;
};

/**
 * The module registry (the shared ink store, the mounted overlays, the on/off switches, the sweeps and reports
 * over every overlay, the copy and cut notices and the committed-layer floor) lives in InkOverlayRegistry.ts.
 * Every exported name is re-exported here, so no importer's import line changed.
 */
export {
	enabled,
	inlineInk,
	instances,
	scrollExpansionEnabled,
	setScrollExpansionEnabled,
	prepareFingerInkEverywhere,
	metrics,
	isInlineInkEnabled,
	setInlineInkEnabled,
	gutterPanMode,
	overlayForPath,
	overlayForActiveEditor,
	refreshPenToolsAll,
	endLiveStrokesEverywhere,
	refreshAllStrips,
	hidePenCursorsEverywhere,
	releaseMouseInkQuietlyEverywhere,
	peelInkEscapeFloor,
	peelInlineEscapeSelection,
	closeInlineInkDocument,
	bindInkEscapeWindow,
	armMouseInkQuietlyEverywhere,
	repaintAllInkOverlays,
	copyInlineInkMetrics,
	inkExternallyReloaded,
	inlineReloadBindings,
	inlineReloadCandidates,
	captureInlineReloadAdmission,
	copyInlineZoomReport,
	copyRegionCensus,
	copyPresentationReport,
	deleteAllInkOn,
	copyInlineSurfaceReport,
	copySelectionNotice,
	copySelectionNoticeIsRoutine,
	cutSelectionNotice,
	cutSelectionNoticeIsRoutine,
	committedFloorFor,
	onDeviceGrid,
} from "./InkOverlayRegistry";
export type {
	InlineReloadBinding,
	CutSelectionOutcome,
} from "./InkOverlayRegistry";

export class InkOverlayPlugin {
	view: EditorView;
	container: HTMLElement | null = null;
	committedCanvas!: HTMLCanvasElement;
	wetCanvas!: HTMLCanvasElement;
	/** The pen wet layer's small tile, over the full wet canvas (WetInkRenderer.configureWetTile). */
	wetTileCanvas!: HTMLCanvasElement;
	tailCanvas!: HTMLCanvasElement;
	/** Whether tailCanvas is dressed at highlighter alpha (see dressTail). */
	tailWashed = false;
	highlightCanvas!: HTMLCanvasElement;
	highlightWetCanvas!: HTMLCanvasElement;
	/**
	 * True while the highlight pair holds a 0x0 backing: no compositor layer,
	 * no GPU resource. A note with no highlighter ink then blends two
	 * full-size layers per frame instead of four. Set by mount(); cleared for
	 * the life of the mount by allocateHighlightPair(), the first time the
	 * note needs the pair (a highlighter pen-down, or a highlighter stroke to
	 * paint). Nothing is hidden instead: a canvas that is drawn while hidden
	 * makes Chromium block the main thread on the GPU on every later frame.
	 */
	highlightPairDeferred = false;
	/**
	 * True while the pen wet canvas holds a 0x0 backing, so a moving page
	 * blends one full-size layer fewer. False at mount: a note that never
	 * scrolls keeps its wet canvas sized. A scroll or a bounce frame with no
	 * stroke in flight and a proven-blank wet layer sets it
	 * (releaseWetIfIdle); the next pen stroke or pinch sizes the canvas again
	 * (allocateWet). The canvas keeps its box and is never hidden.
	 */
	wetDeferred = false;
	/** Read once at mount from window.HW_ARM_W_OFF: true keeps the wet canvas sized (a render cell's control arm). */
	wetReleaseOff = false;
	committedCtx!: CanvasRenderingContext2D;
	highlightCtx!: CanvasRenderingContext2D;
	wet!: WetInkRenderer;
	highlightWet!: WetInkRenderer;
	tail!: TailRenderer;
	router: InlinePenRouter | null = null;
	camera = new Camera();
	penStyle: PenStyle = { ...DEFAULT_PEN };
	highlighterStyle: PenStyle = { ...HIGHLIGHTER_PEN };
	/** Bound once at pen-down so the raw ink loop stays branch-free. */
	activeWet!: WetInkRenderer;
	activeStyle: PenStyle = this.penStyle;
	builder: StrokeBuilder | null = null;
	// Adaptive pressure gain, frozen at pen-down for the whole stroke so a
	// mid-stroke ratchet of the learned device max cannot kink the width.
	strokeGain = 1;
	strokeRawMax = 0;
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
	ribbonPressure = 0;
	strokePenGesture = false;
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
	mouseStroke = false;
	// Raw-layer dwell tracking: the last time the pen actually MOVED. The
	// builder filters stationary samples out of the stroke, so the hold
	// that requests a shape snap is only visible here.
	rawLastMoveT = 0;
	rawLastMoveX = 0;
	rawLastMoveY = 0;
	/**
	 * The mouse's shape snap: an offer, never a correction. See SnapChip.ts
	 * for the defect ("it's correcting into a straight line") and the ruling.
	 * One per surface, created here and never replaced - the chip it holds is
	 * per-offer and takes itself down.
	 */
	readonly snapChip = new SnapChip();
	snapPreview: SnapPreview | null = null;
	snapCanvas: SnapPreviewCanvas | null = null;
	snapContactId: number | null = null;

	// gesture state (one pen contact at a time; mode decided at pen-down)
	mode: PenMode = "ink";
	erased: Array<{ stroke: InkStroke; index: number }> = [];
	/**
	 * Ids minted by this erase gesture. A piece cut a moment ago is not an
	 * original: undo restores what the note held when the gesture began, so a
	 * second pass over a survivor must not record it as something lost.
	 */
	erasePieces = new Set<string>();
	/** The stroke list as the erase gesture found it. See the erase pen-down. */
	eraseFrom: InkStroke[] = [];
	eraseWhole = false;
	// Damage-repaint state (renderer debt): the committed canvases are their
	// own cache. The ledger says what changed; the index answers per-rect
	// stroke queries; lastPaintCam turns camera motion into a blit.
	damage = new DamageLedger();
	strokeIndex = new StrokeIndex();
	indexDirty = true;
	lastPaintCam: { x: number; y: number; zoom: number } | null = null;
	/** How many strokes the store held at the last committed paint, full or partial. A band carry trusts the raster only while the store still holds that many. */
	paintedStrokeCount = -1;
	/**
	 * The note's whole ink drawn once below 100 percent (within extentRasterFits), on the committed raster's device grid: origin
	 * `kx, ky` device px from the camera `cam0` it was built at, drawn at the camera `at`, covering the world rect `world`. Valid
	 * while its content holds - the note, the zoom, the backing, the device ratio, the settings that shape ink (inkLookKey) and the
	 * store's stroke list (the same array, count and generation) - whatever frame asks. A pen commit draws its strokes into it and keeps it valid; any other change to
	 * the ink leaves it stale, and the next whole repaint that is no pan, stroke or bounce frame builds it again.
	 */
	extentRaster: {
		path: string; pen: HTMLCanvasElement; hl: HTMLCanvasElement | null; kx: number; ky: number;
		cam0: { x: number; y: number; zoom: number }; at: { x: number; y: number; zoom: number };
		world: { x0: number; y0: number; x1: number; y1: number }; backing: number; dpr: number; look: number;
		strokes: readonly InkStroke[]; generation: number; count: number;
	} | null = null;
	/** Whether this repaint's one paint may start building the extent raster; set by `repaint`, false otherwise. */
	extentMayBuild = false;
	/** One extent raster arm asked by an insert space release, consumed by the next partial repaint (paintCommittedWork). */
	extentArmAsked = false;
	/** A tail shrink waiting for its task (queueTailShrink). */
	tailShrinkQueued = false;
	/**
	 * The extent raster being built, a piece at a time, after the frame that asked for it (INBOX rows 501 and 511): that frame paints by
	 * path as it always did, and the raster is drawn on later tasks, stroke by stroke in store order, each piece at most
	 * EXTENT_PIECE_MS plus one stroke, never while a contact, a stroke, a pan, a pinch, a bounce or a queued repaint is live. Its
	 * target is what the finished raster must hold; `next` is the store index the next piece starts at. Used only once whole.
	 */
	extentBuild: {
		path: string; cam0: { x: number; y: number; zoom: number }; at: { x: number; y: number; zoom: number }; kx: number; ky: number;
		w: number; h: number; world: { x0: number; y0: number; x1: number; y1: number }; backing: number; dpr: number; look: number;
		floor: ReturnType<typeof committedFloorFor>; strokes: readonly InkStroke[]; count: number; generation: number; hasHl: boolean;
		pen: HTMLCanvasElement | null; hl: HTMLCanvasElement | null; next: number; timer: number;
	} | null = null;
	/**
	 * A picture of the ink shown at a new scale while the sharp extent raster is built (zoom settle design, 2026-10-04): the old whole
	 * raster once only its zoom or backing no longer match, or a copy of the layer's own pixels taken just before a resize clears them.
	 * Device px = (world - at) * at.zoom * backing. It holds the store's first `count` strokes; strokes added at the end since are drawn
	 * by path over the copy. Released by the whole repaint that copies the finished raster in, and on any fallback (usableStandIn).
	 * `mark` is what the layers hold after its last whole copy (copyFromStandIn writes it); any other paint onto the committed layers
	 * and a resize clear it.
	 */
	standIn: {
		path: string; pen: HTMLCanvasElement; hl: HTMLCanvasElement | null; at: { x: number; y: number; zoom: number }; backing: number;
		dpr: number; look: number; strokes: readonly InkStroke[]; count: number; generation: number; mark: StandInMark | null;
	} | null = null;
	/** Stand-ins taken from the layer's own pixels, counted for the suites (one per settle); read nowhere else. */
	standInSnapshots = 0;
	/** Whole repaints that left the stand-in copy to the queued frame, counted for the suites; read nowhere else. */
	standInDeferrals = 0;
	/**
	 * The wait before a whole repaint is asked for a stand-in that a whole repaint kept with no build started (see retryStandInLater);
	 * 0 when none is pending.
	 */
	standInRetryTimer = 0;
	/** True while the frame scheduleRepaint queued is running its repaint (requestAnimationFrame, before that frame paints). */
	inQueuedFrame = false;
	/** When the last scroll repaint was asked for (performance.now): a wheel or trackpad pan has no contact down between its events. */
	lastScrollAskAt = -Infinity;
	/** Diagnostic only: this frame's band move carried its pixels. Read by the scroll probe's repaint line, nowhere else. */
	bandCarriedThisFrame = false;
	originStyles = new WeakMap<Element, CSSStyleDeclaration>();
	retiring = false;
	selection = new SelectionModel();
	readonly selectionDeleteKeys = new InlineSelectionDeleteKeys(
		() => !this.selection.isEmpty,
		() => this.deleteSelectedInk()
	);
	lassoPts: Point2[] = [];
	lassoActive = false;
	dragFrom: { x: number; y: number } | null = null;
	dragTotal: { dx: number; dy: number } | null = null;
	/**
	 * The selection's box at pen-down, and how many objects it held. The box of
	 * a live drag is this box moved by the distance travelled: the selection
	 * cannot gain strokes mid-drag, so reading it from every stroke of the
	 * note on each sample only repeats what pen-down already knew. A selection
	 * that changed size (Escape, an ink change that removed strokes) stops
	 * using it.
	 */
	dragBox: { box: BBox; size: number } | null = null;
	/** The strokes a selection drag picked up at pen-down; see commitLiveDrag. */
	dragIds: string[] = [];
	/** The note a live selection drag moves ink in; see rollbackLiveGesture. */
	dragHistoryIdentity: symbol | null = null;
	/** The note a live erase changes; see rollbackLiveGesture. */
	eraseHistoryIdentity: symbol | null = null;
	/** Insert-space gesture: divider world y, or null when no gesture. */
	spaceLineY: number | null = null;
	/** Ids frozen at pen-down; the live drag and the op both use this list. */
	spaceIds: string[] = [];
	/** Box around those ids, tracked through the drag so damage stays bounded. */
	spaceBounds: BBox | null = null;
	/** The same text/ink seam as the guide, frozen before any live movement. */
	spacePlan: (SpaceBoundary & {doc: Text}) | null = null;
	/** Record identity survives rename and cannot resolve to a replacement note. */
	spaceHistoryIdentity: symbol | null = null;
	spaceRowsCache = new InsertSpaceRows();
	spaceTextEnd: {doc:Text;pos:number;blocks:SpaceProtectedBlock[]} | null = null;
	spacePreview: {plan:SpaceBoundary;doc:Text;moving:string[];staying:string[];rows:ReturnType<InsertSpaceRows["get"]>} | null = null;
	/** The hover preview's strokes on screen with their colors, in store order, and what they were read from (spaceDrawItems). */
	spaceDrawList: {moving:string[];staying:string[];rows:ReturnType<InsertSpaceRows["get"]>;x:number;y:number;zoom:number;
		w:number;h:number;scale:number;items:{stroke:InkStroke;color:string}[]} | null = null;
	spaceHoverY: number | null = null;
	spaceFeedbackRaf: number | null = null;
	/** What the last hover feedback frame drew, so an identical frame is skipped. */
	spaceFeedbackKey: {hoverY:number;doc:Text;mode:string;rows:unknown;x:number;y:number;zoom:number;w:number;h:number;preview:unknown} | null = null;
	/** Last viewport point of a pan drag; client space, so scrolling cannot
	 * feed back into the delta the way surface coordinates would. */
	panLast: { x: number; y: number } | null = null;
	spaceFromY = 0;
	spaceTotalDy = 0;
	/** The rows the drag froze its ids from, and every dy it moved them by,
	 * so the commit can shift the cached rows instead of rebuilding them. */
	spaceRows: ReturnType<InsertSpaceRows["get"]> | null = null;
	spaceSteps: number[] = [];
	penCursorEl: HTMLElement | null = null;
	penCursorPinned = false;
	penCursorClient: PenSample | null = null;
	// Whether the reticle is showing. The element itself stays display: block
	// from creation and is shown and hidden by opacity on its own layer, so
	// neither edge invalidates the document (a whole-window re-raster at
	// pen-down, measured on Orion); this field is the state a style read was.
	penCursorShown = false;
	mobileTools: MobileTools | null = null;
	noteZoomControls: NoteZoomControls | null = null;
	eraserEl: HTMLElement | null = null;

	cssWidth = 0;
	cssHeight = 0;
	dpr = 1;
	/**
	 * The exact backing multiplier the committed canvas's OWN transform was
	 * last set with (assigned at the same point as that setTransform call,
	 * never recomputed). Reallocation is skipped whenever the "unchanged"
	 * check holds, and cssScale can still move in the meantime (e.g. during
	 * a locked frame) - so backingNow() read at paint time can disagree with
	 * what the raster actually is. This field cannot: it is only ever the
	 * value setTransform received.
	 */
	committedBacking: number | null = null;
	resizeObserver: ResizeObserver | null = null;
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
	contentResizeObserver: ResizeObserver | null = null;
	/** The content width that observer last reported, layout px; a change reads the line anchors' signature. */
	contentWidthSeen = -1;
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
	originLineObserver: ResizeObserver | null = null;
	/** The element `originLineObserver` is currently watching, if any. */
	originLine: Element | null = null;
	repaintQueued = false;
	/**
	 * Did nothing but scrolling ask for the queued frame? The purged-canvas
	 * probe (PurgeSentinel.ts) fires on that frame and no other, because it is
	 * the one that legitimately draws nothing.
	 */
	repaintScrollOnly = false;
	/**
	 * `performance.now()` of the last sentinel readback. -Infinity, not 0, so
	 * the first one is due immediately rather than 300ms into the session.
	 */
	lastPurgeProbe = Number.NEGATIVE_INFINITY;
	presentProbePending = false;
	/** The newest sample's stamp a pending present probe waits to age on the frame ticker; null when none waits. */
	presentProbeTs: number | null = null;
	scrollFn: (() => void) | null = null;
	wheelFn: ((e: WheelEvent) => void) | null = null;
	/** The non-passive ctrl+wheel listener that zooms the note. Separate from `wheelFn`, which stays diagnostic-only and passive. */
	ctrlWheelFn: ((e: WheelEvent) => void) | null = null;
	wheelZoomRun = new WheelZoomRun();
	/**
	 * Alan, 2026-09-20: INFINITE CANVAS IS THE MODE, PER NOTE. True when this note is a canvas:
	 * its own frontmatter choice if it has one, else the global setting. Cached here and re-read by
	 * `applyCanvasMode` (mount, the global toggle, an override change), so the per-frame paths read a
	 * field and pay nothing. With it false the note is stock Obsidian: no pinch zoom, no wheel zoom,
	 * no zoom bar, no edge give; the scroller does what it does in any other note.
	 */
	canvasMode = scrollExpansionEnabled;
	offCanvasOverride: (() => void) | null = null;
	/** The pending quiet-time check for a live wheel zoom run; 0 when none is armed. */
	wheelZoomTimer = 0;
	hostPositionPatched = false;
	/** The element chromeHost() made positioned, so teardown can undo it. */
	chromeHostPatched: HTMLElement | null = null;

	// ---- surface extent (reconstructed from the 2026-08-20 hardware build) --
	/** 1×1 invisible child of the scroller that extends its scroll range. */
	spacer: HTMLElement | null = null;
	spacerLeft = Number.NaN;
	spacerTop = Number.NaN;
	/**
	 * Scroll room held left of the column for ink left of the origin, layout px
	 * (`leftReserve`). The pan carrier is shifted right by it with `translate`,
	 * which moves no layout, and the scroller is scrolled right by the same
	 * amount in the same pass, so nothing on screen moves and the ink is reached
	 * by scrolling left. 0 when none is held.
	 */
	leftReserveHeld = 0;
	axisGuard = new ScrollAxisGuard();
	/** The ink frontier per note, so a scroll repaint stops re-walking it. §5g/G1. */
	frontierCache = new FrontierCache();
	lineAnchorState: LineAnchors | null = null;
	/** Ink that remembers its line on this surface: each stroke shown moved with the line it was written on (LineAnchor.ts). */
	get lineAnchors(): LineAnchors {
		return (this.lineAnchorState ??= new LineAnchors(() => this.lineLayout(), () => this.view?.hasFocus === true,
			() => this.lineOnScreen()));
	}
	/** The measure after a document change: the anchors' rebase window closes there when that measure read every line of it. */
	readonly lineWindowMeasure = { key: {}, read: (): null => null, write: (): void => this.lineWindowMeasured() };
	/** Reads the layout the anchors are honoured under in a measure, for the mount and a font change. */
	readonly lineSignatureMeasure = {
		key: {},
		read: (view: EditorView): LineSignature => this.readLineSignature(view),
		write: (sig: LineSignature): void => this.lineSignatureMeasured(sig),
	};
	/**
	 * THE INK'S OWN REACH on x, note px, cached for the settle's width tests to read as a field.
	 * Written where the extent pass already holds it; the events that move it - a stroke committed, an
	 * erase, a note loaded - are the same ones that run that pass, so the worst case is one pass old.
	 * Not read through `inlineInk.strokes()` per call: that is O(1) normally but FILTERS the stroke
	 * list while a note reloads (InlineInkStore.ts:414-420), a walk that scales with note length.
	 */
	pageInkX = 0;
	/** Unsubscribes the frontier cache from ink-changed events. */
	offInkChanged: (() => void) | null = null;
	/** What updateExtent last acted on; equal inputs mean equal output. */
	lastExtentInputs: ExtentInputs | null = null;
	/** The ink frontier's x the last extent pass saw per note, to notice ink leaving. */
	extentFrontierSeen = new Map<string, number>();
	/** The generation of each note's due shrink this editor has already taken a step on. */
	shrinkStepped = new Map<string, number>();
	/** Takes a held shrink's next step once a scroll has gone quiet (SHRINK_SCROLL_IDLE_MS). */
	shrinkIdleTimer: number | null = null;
	/** Each note's x-grant shrink count at this editor's last extent pass, so the band hears of a shrink made anywhere. */
	shrinksSeen = new Map<string, number>();
	/** What this editor showed sideways at its last extent pass: a shrink made in any editor keeps it on screen. */
	sidewaysView: { path: string; scrollLeft: number; clientWidth: number; originLeft: number; fontZoom: number } | null = null;
	/** The scroller's width measured without the band, for the next band sync only. */
	bandFreeScrollWidth: number | null = null;
	/** The note's content height (view.contentHeight) at the last unlocked band sync: a drop is what asks for a band-free height read. */
	bandContentHeight: number | null = null;
	/** Set by a scale commit: the next extent pass releases the band's margin, whether or not a grant shrank. */
	bandMarginReleasePending = false;
	scrollExpansion: ScrollExpansionDemand | null = null;
	/** The `.markdown-source-view` ancestor carrying the `handwriting-page` class. */
	pageClassHost: HTMLElement | null = null;
	/** Keeps the page-id-only Properties block class in step with Obsidian's DOM. */
	metadataObserver: MutationObserver | null = null;
	/** The one frame that observer owes, or null when it owes none. §5g/G2. */
	metadataFrame: number | null = null;
	/** Live magnification of this editor. Session-local; never persisted. */
	pinchScaleNow = 1;
	/**
	 * Lowest scale pinch, the zoom buttons and commitCameraScale may reach:
	 * MIN_PINCH_SCALE. Only Fit commits below it. Below it zoom-out is locked
	 * (Alan 2026-09-14): a pinch, a button or a commit may zoom in from the
	 * current scale but not back out, until a committed scale reaches the floor.
	 */
	zoomFloor = MIN_PINCH_SCALE;
	/** The scale this gesture started from, so a pinch never accumulates. */
	pinchRefScale: number | null = null;
	/** The pinch this frame owes, coalesced from however many moves arrived. */
	pinchPending: { next: number } | null = null;
	/** When the pinch last wrote the scroll itself; see the scroll handler. */
	pinchScrollAt = 0;
	/** Live transform owns the existing raster until the final layout transaction. */
	pinchPreview = false;
	/**
	 * Where the last preview frame held the fingers: its target (constraint client point and offset, or the bare target).
	 * The lift lands this frame, not a finger reading that arrived after it and was never drawn. Written once per painted
	 * frame, four numbers, never per pointer event.
	 */
	pinchPaintedValid = false;
	pinchPaintedX = 0;
	pinchPaintedY = 0;
	pinchPaintedOffsetX = 0;
	pinchPaintedOffsetY = 0;
	/** The give is finishing: its own lift settles on the cap through the ordinary end path, not the painted frame. */
	pinchGiveEnding = false;
	/** A pinch is held: its gesture has started and not ended, or its preview still owns the raster. */
	pinchHeld(): boolean {
		return this.pinchRefScale !== null || this.pinchPreview;
	}
	/** CodeMirror measures held back for the preview lifetime; null when CodeMirror schedules its own. */
	measureHold: MeasureHold | null = null;
	/** True while CodeMirror is delivering an update to this plugin; see `update`. */
	inUpdate = false;
	/** A resize the update hook met under a live hold, deferred whole to a frame; see `resizeOutOfUpdate`. */
	resizeOutOfUpdateRaf = 0;
	/** The router's ratio at which `rebasePinch` re-anchored; its later ratios divide by it. */
	pinchRatioBase = 1;
	/**
	 * THE LIFT PAST THE CAP. A live pinch may paint past MAX_PINCH_SCALE (and under
	 * MIN_PINCH_SCALE) by PINCH_GIVE, preview only; at the lift the preview is driven back to the cap
	 * over OVERSCROLL_BOUNCE_MS on the bounce's own curve and only then settles, once, inside the
	 * committed range. `stepping` marks the ease's own frames, which enter `pinch` as moves.
	 */
	pinchGive: { from: number; to: number; startedAt: number; raf: number; centroid: { x: number; y: number }; stepping: boolean; scrollLeft: number; scrollTop: number; paused: boolean } | null = null;
	/** The router's last raw move ratio, for `rebasePinch`. */
	pinchLastRatio = 1;
	/** Hides a reticle left behind by a pen that never sent pointerleave. */
	hoverWatchdog: ReturnType<Window["setTimeout"]> | null = null;
	/** performance.now() of the last pen hover sample; the watchdog hides only a second after it. */
	hoverSeenAt = Number.NEGATIVE_INFINITY;
	/** Whether the metrics frame ticker is running; see startFrameTicker. */
	frameTicking = false;
	frameRaf = 0;
	frameTickToken: object | null = null;
	/** Recent REAL samples, newest last: what prediction extrapolates from. */
	predReal: PenSample[] = [];
	/** The tail drawn last event, kept only to score it against what arrived. */
	predLastTail: readonly PenSample[] = [];
	/** The target and scale the last preview frame painted at; the settle's probe line compares the commit's against it. */
	pinchPaintedTarget: { x: number; y: number; scale: number; columnLocal: number | null; geometry: PinchConstraintGeometry | null } | null = null;
	/** Gesture-start state the whole pinch is computed from; see anchoredScroll. */
	pinchAnchor: {
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
	viewportPan = { x: 0, y: 0 };
	/**
	 * WHERE THE PAN STOOD WHEN THE GESTURE BEGAN, painted px. The give band may stop a frame
	 * carrying the page FURTHER out than its room, and it may never drag a page that was already resting
	 * outside that room back in - a zoom-button commit leaves the page on a legitimate position and the next
	 * touch must not spring. Captured with the anchor, read by the band, written nowhere else.
	 */
	pinchStartPan = { x: 0, y: 0 };
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
	pinchBand = { history: [] as number[], lastPan: { x: 0, y: 0 } };
	/** The overscroll bounce's visual offset on top of `viewportPan`, painted px; zero whenever no bounce is playing. */
	bounceOffset = { x: 0, y: 0 };
	/**
	 * ONE SETTLE OWES AN EASE, and it is the pinch's own. Measured at f7e76419: THREE settling
	 * `anchorPanTo` calls follow every lift - `commitCameraScale` <- `applyPinchScale`, then
	 * `applyPinchScale` alone, then `Object.write` <- `EditorView.measure` - and only the first arrives
	 * with the preview's own pan. The other two saw `pan` already at `cx` and re-ran the same ease from
	 * a position the page had already left.
	 */
	previewSettleOwed = false;
	/** Where the page was painted inside its pane on the last preview frame, for the settle's ease to measure against. */
	previewPaintedBlank: { x: number; y: number } | null = null;
	/** The bounce playing now: the settle that started it, where it started, its frame request. */
	bounceState: { hold: object; fromX: number; fromY: number; startedAt: number; raf: number } | null = null;
	/** The settle that has had its bounce, playing or over, until that settle retires: one bounce per settle. */
	bouncedHold: object | null = null;
	/**
	 * The last settle's bound geometry, for `overscrollBounceReadout`. Written at the bound, read
	 * by production at :7688-7689, :7834-7835, :7866. A field initializer, so `Object.create(InkOverlayPlugin.prototype)` skips it - a
	 * fixture built that way must set it itself or any path that reads it throws on the missing keys.
	 */
	boundReadout = { floorX: 0, floorY: 0, bx: 0, width: 0, rawX: 0, cx: 0, rawY: 0, cy: 0,
		// Read-only: the drag-frame gate's own inputs, so a fixture can say WHY a frame was or
		// was not bounded rather than infer it from the position it ended on.
		dragFrame: false, neverZoomed: false, steady: false, next: 0, fromScale: 0, fromScaleValid: false,
		restCeilX: 0, startX: 0, startY: 0, lastX: 0, lastY: 0, bounded: false, settling: false };
	/** Pan already drawn into the raster, in host-layout pixels. */
	rasterPan = { x: 0, y: 0 };
	cameraOriginY: CameraOriginY | null = null;
	/**
	 * The camera origin in LAYOUT px as the last accepted sync left it, which
	 * is the only input to picking a rung. Not a basis term and deliberately
	 * not one: the identity `cameraY_layout = k x spacing + residual/cssScale`
	 * gives the same camera for every k, so a different rung reseeds nothing
	 * and causes no redraw. NaN until the first sync, which falls back to the
	 * scroll offset - the same quantity to within a viewport.
	 */
	anchorCameraYLayout = Number.NaN;

	/** Set by `canonicalCameraY` when it adopted a raw that differs from
	 * the retained origin - a basis reset, or a departure beyond the cap. Read
	 * and cleared by `syncCamera`, the only caller allowed to pay for the gate's
	 * rect read; the read-only twin never does. */
	anchorAdoptionEvent = false;

	/** The parity gate has not run yet for the ladder now mounted, so the mount
	 * itself is gated as well as every later adoption. */
	anchorGateDue = true;
	readonly rasterInputPan = { x: 0, y: 0 };
	committedBlank = false;
	highlightBlank = false;
	readonly pinchHiddenCanvases = new Map<HTMLCanvasElement,string>();
	pinchComposite = false;
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
	previewPanEngaged = false;
	/**
	 * The host's painted origin as of the last `columnLocalAt`, and whether that
	 * read happened at all. Mutated rather than replaced: this is written once
	 * per preview frame and a fresh object per frame is an allocation on the one
	 * path `deferPinchRaster` exists to keep free of them.
	 */
	previewHostOrigin = { left: 0, top: 0, valid: false };
	/**
	 * The note origin the paper's phase is planned from, in the gradient's layout
	 * px, as updateExtent last computed it (null before the first).
	 */
	paperOriginLayout: number | null = null;
	/** The text column's left edge the paper's vertical rules and dots are planned from, in the gradient's layout px. */
	paperOriginLeft: number | null = null;
	/** The editor text's font size the paper was last planned at, as the refresh path or the camera sync read it. */
	paperFontPx = Number.NaN;
	/** The zoom at rest right after a release (the external scale alone), until the refresh path measures one. */
	paperRestZoom = Number.NaN;
	/** The paper values the overlay itself last wrote, so a takeover can tell its own plan from the host's. */
	paperWritten = new Map<string, string>();
	/** The column in host-local px as of the last preview frame's one read. */
	previewColumnLocal: number | null = null;
	/** `.cm-sizer`, cached: `writeViewportPan` runs once per preview frame. */
	panSizerEl: HTMLElement | null = null;
	panGuttersEl: HTMLElement | null = null;
	/** How the gutters follow the sizer's pan, read once when a pan starts; null while the pan is empty
	 *  and after a column margin write, which moves the sizer the counter translate was read from. */
	panGuttersMode: GutterPanMode | null = null;
	/** The transform last written on `panGuttersEl`, so a frame that changes nothing writes nothing. */
	panGuttersWritten = "";
	/**
	 * Armed for the duration of ONE settle transaction, so the several scroll
	 * writes inside `commitCameraScale` each re-derive the pan they need rather
	 * than leaving the note wherever the browser's clamp put it.
	 */
	panAnchorHold: {
		focalX: number; focalY: number; targetX?: number; targetY?: number; hostLeft: number; hostTop: number;
		columnLocal: number | null; contentTopLocal: number | null; fromScale: number; scrollLeft: number; scrollTop: number; toScale: number; generation: number; path: string | null; container: HTMLElement | null;
		expansion?: { left: number; top: number } | null;
		left: number; top: number; ready: boolean; outcome: "pending" | "converged" | "cancelled" | "failed"; attempts: number; request: unknown; issuance: readonly unknown[];
	} | null = null;
	pinchRaf = 0;
	/** The scale the ink raster currently reflects, so a settle that would
	 * change nothing does not reallocate every canvas. */
	pinchRasterScale = 1;
	/** Host-local px the preview raster is currently translated by. See applyPreviewInkOffset. */
	previewInkOffset = 0;
	/**
	 * Host-local px the preview raster is moved DOWN by because a block above
	 * the content changed height during the gesture (a title that rewraps as the
	 * pinch narrows the host). See observeAboveContent.
	 */
	previewInkOffsetY = 0;
	/** Watches the blocks above `.cm-contentContainer` in the sizer; see observeAboveContent. */
	aboveContentObserver: ResizeObserver | null = null;
	/** Last delivered border-box height per watched block, host-local px. */
	aboveContentHeights = new WeakMap<Element, number>();
	/** Height changes applied to a preview raster, counted: one per rewrap, never one per frame. */
	aboveContentShifts = 0;
	/**
	 * Where the column was, in HOST-LOCAL px, when the committed raster was
	 * last drawn. Null when there is nothing measured to compare against.
	 */
	rasterColumnLocal: number | null = null;
	/**
	 * The scroller's scrollLeft at the moment `rasterColumnLocal` was latched.
	 * `columnLocalAt` is host-local and therefore moves with the scroll; the
	 * ink layer rides inside the scroller and moves with it too, so a scroll
	 * change since the latch must NOT enter the preview offset a second time.
	 */
	rasterColumnScroll = 0;
	/** A repaint redrew the raster mid-gesture; re-latch before the next box move. */
	previewAnchorStale = false;
	repaintDeferredByPinch = false;
	pinchDeferTimer = 0;
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
	inkLayer: HTMLElement | null = null;
	/** The ink band's box in scroller-content coordinates; see ScrollBand. */
	band: Band | null = null;
	/** The band's widening for the ease playing now, fixed at its first sync (syncBand). */
	bandEase: { bounce: object; x: number; y: number } | null = null;
	bandSyncDeferred = false;
	/** A pane resize arrived while a stroke held the zoomed layout; see handleResize. */
	resizeDeferred = false;
	// Font-zoom tracking (quick font size / touchpad pinch; see ZoomScale).
	/** Live computed style of the content element; .fontSize is a cheap read. */
	contentStyle: CSSStyleDeclaration | null = null;
	/** Editor font size at overlay mount, the fontZoom reference. */
	refFontPx = 0;
	/** The font `update()` last saw. Written by `handleResize` only. */
	lastFontStr = "";
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
	lastSyncFontStr = "";
	/** CSS-transform scale alone (visual px per layout px), fontZoom excluded. */
	cssScale = 1;
	scaleGeometryValid = true;
 viewportGeneration = 0;
 viewportPaneObserver: ResizeObserver | null = null;
 viewportStyleObserver: MutationObserver | null = null;
 viewportStyleFrame = 0;
 viewportStyleStamp = "";
 /** Camera commits in progress, plus a settle measure's write while it re-anchors; commitCameraScale carries a pending settle only at depth 1. */
 commitDepth = 0;
 viewportStyleDirty: {path:string|null;container:HTMLElement|null} | null = null;
 viewportLayout: {parent:HTMLElement; paneWidth:number; paneHeight:number; externalScale:number; gutterScreen:number; baseTransform:string; baseZoom:number; zoomVerified?:boolean; width:number; height:number; column:number; columnBox:number; lineContent:number; gutterX:number; sizerColumn:boolean; columnInset:boolean; ownLines:boolean; left:string; right:string; columnLocal:number|null; columnReserve:number; columnAuto:{lineWidth:number;fixed:number;scrollbar:number}|null; styles:Map<string,{value:string;priority:string}>} | null = null;
 /** `CSS.supports("zoom", "0.5")`, asked once per overlay. See `hostZoomSupported`. */
 hostZoomSupport: boolean | null = null;
 /** The form `applyViewportBox` last wrote (true: zoom), so a crossing of k = 1 re-places the canvases. Null until one is. */
 hostZoomWritten: boolean | null = null;
 /** The inverse note zoom the last box write put on the scroller's bar (`scrollbarUnscaleAt`), null at 100 percent or where the bar is not Obsidian's styled one. */
 scrollbarUnscale: number | null = null;
 private translateSupport: boolean | null = null;
 /** Whether the page places a canvas with CSS translate (the wet tile moves by it). Asked once per overlay. */
 translateSupported():boolean {
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

	fontZoom = 1;
	/** overflow-x re-checked once per resize/mount, not per repaint. */
	axisChecked = false;
	scrollPositionPatched = false;
	lastReach: {
		required: number;
		scrollWidth: number;
		clientWidth: number;
		overflowX: string;
		patched: boolean;
	} | null = null;

	// Geometry stash: what syncCamera actually read this frame, kept for the
	// scroll probe so instrumentation never adds layout reads of its own.
	lastSyncRectLeft = 0;
	lastSyncRectTop = 0;
	lastSyncContentLeft = 0;
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
	lastSyncDocumentTop = 0;
	lastSyncScrollLeft = 0;
	lastSyncScrollTop = 0;
	/**
	 * The last column left the scan actually found, across every call site.
	 * `null` only before the first successful scan.
	 *
	 * Separate from `lastSyncContentLeft`, which is a stash of what SYNCCAMERA
	 * read and is compared against in `handleResize` to decide whether the
	 * column moved. Overwriting that from the diagnostic and extent paths
	 * would make that comparison lie.
	 */
	lastGoodColumnLeft: number | null = null;
	/** Scroll events observed while the current stroke was active. */
	scrollsDuringStroke = 0;

	/**
	 * Presentation-probe target: the last committed stroke, anchored in NOTE
	 * space (never screen space: scrolling moves the ink's canvas position,
	 * so a screen-space target goes stale the moment anything repaints).
	 * Probes recompute the canvas/client box under the CURRENT camera and
	 * hard-gate on the committed backing actually containing pixels there.
	 */
	lastCommitNote: { x: number; y: number; w: number; h: number } | null = null;
	lastCommitPath: string | null = null;
	lastCommitId = "";
	lastCommitColor = "";
	lastCommitAt = Number.NEGATIVE_INFINITY;

	// LIVEPAINT sampler state (right-edge dead-zone diagnosis): during an
	// active ink stroke, every ~30 ms a small box around the newest SETTLED
	// wet segment is read back from the wet canvas. Zero paint while the
	// user is drawing = the rasterization never reached the backing store;
	// paint present while the glass is blank = presentation/compositor.
	/** The file this editor was last showing. Ink isolation depends on it. */
	lastPath: string | null = null;
	/** The TFile behind `lastPath`. Obsidian renames a file by mutating its path in place, so the same object
	 * under a new path is a rename, not a note switch. */
	lastFile: unknown = null;
	currentFile(): unknown {
		return this.view?.state?.field(editorInfoField, false)?.file ?? null;
	}
	reloadBindingEpoch = 0;
	reloadCameraSettlement: number | null = null;
	undoIdentity: object | null = null;
	undoIdentityStale = false;
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
	get emptyNotice(): EmptyPageNoticeGate {
		return (this.emptyNoticeGate ??= new EmptyPageNoticeGate());
	}
	/**
	 * Visual px per layout px for this editor (1 unless something applies a
	 * CSS zoom/transform). Every conversion between screen geometry and note
	 * space goes through it; see ZoomScale.ts.
	 */
	scale = 1;
	mediaQuery: MediaQueryList | null = null;
	mediaFn: (() => void) | null = null;
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
	readonly frame = new StrokeFrame();

	constructor(view: EditorView) {
		this.view = view;
		instances.add(this);
		this.releasePenHold = holdKeyboardForEveryPen(view,() => (this.destroyed ? "overlay gone" : Platform.isMobileApp ? "mobile app" : !enabled ? "inline ink off" : penInkEnabled() ? null : "pen ink off"));
		if (enabled) this.mount();
	}

	// ---- lifecycle ----------------------------------------------------------

	/**
	 * The window this editor actually lives in. A popout editor's frames,
	 * devicePixelRatio, and media queries belong to ITS window; the main
	 * window's values are wrong there (mixed-DPI monitors, page zoom).
	 */
	get winRef(): Window {
		return this.view.dom.ownerDocument.defaultView ?? window;
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
	wheelZoom(e: WheelEvent): void {
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
	beforePenDown(): void {
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

	/** A font reference adoption held while a contact owned the frame; see adoptStoredFontRef. */
	heldFontRef: string | null = null;

	// Property so a detached observer callback cannot arrive with a stray
	// `this`. 4000 chars is far past any id-only frontmatter; a block the
	// slice truncates parses as null, and null never hides anything.
	headFrontmatterKeys = (): readonly string[] | null =>
		frontmatterPropertyKeys(this.view.state.sliceDoc(0, 4000));

	/** Set while a pass anchoring the note's old ink waits for the editor to go quiet. */
	lineAnchorPassTimer = 0;
	/** Set when the pass came due while the editor was off screen: the next lines drawn arm it. */
	lineAnchorPassWaits = false;
	/** When an editor update last drew lines, performance.now() ms: the pass waits LINE_ANCHOR_QUIET_MS past it. */
	lineDrawnAt = 0;

	/** Set where the overlay leaves `instances`, its one way out; mount() refuses from then on. */
	destroyed = false;
	/** Takes the pen keyboard-hold listener off the editor root; destroy() calls it, the root outlives the overlay. */
	releasePenHold: () => void = () => {};

	/** The note whose remembered camera waits to be restored (issue 9); see restoreNoteCamera. */
	noteCameraRestore: string | null = null;
	/** The key of the restore's measure request, so a second arm replaces the first. */
	readonly noteCameraMeasure = {};

	/** The live overlay container, for the census's ghost detection. */
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

	// ---- geometry -----------------------------------------------------------

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
	allocateHighlightPair(): void {
		if (!this.highlightPairDeferred) return;
		this.highlightPairDeferred = false;
		const w = this.committedCanvas.width, h = this.committedCanvas.height;
		const backing = this.committedBacking;
		if (!(w > 0 && h > 0) || backing === null) return;
		for (const c of [this.highlightCanvas, this.highlightWetCanvas]) {
			bumpCanvasReallocs();
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
	releaseWetIfIdle(): void {
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
	allocateWet(): void {
		if (!this.wetDeferred) return;
		this.wetDeferred = false;
		const w = this.committedCanvas.width, h = this.committedCanvas.height;
		const backing = this.committedBacking;
		if (!(w > 0 && h > 0) || backing === null) return;
		bumpCanvasReallocs();
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
	chromeHost(): HTMLElement {
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

	/**
	 * The backing factor every canvas and every probe must agree on. One
	 * accessor because five call sites computed it independently: if they
	 * ever disagreed, ink would rasterise at one resolution and be drawn
	 * through a transform built for another.
	 */
	backingNow(layoutW?: number, layoutH?: number): number {
		const w = layoutW ?? this.container?.offsetWidth ?? 0;
		const h = layoutH ?? this.container?.offsetHeight ?? 0;
		return backingScale(this.dpr, rasterScale(this.cssScale, this.pinchScaleNow, SCALE_EPSILON), w, h, Platform.isMobileApp);
	}

	// ---- pen path (frozen pipeline) ----------------------------------------

	// ---- pen probe (spatial/latency diagnosis) --------------------------------

	/** The title rewrap the paper has taken during this preview, layout px; spent where the origin is re-measured. */
	paperRewrapY = 0;
	/** How far the text column has re-centred since the gesture began, painted px; spent where the origin is re-measured. */
	paperColumnDrift = 0;
	/** The pan values last written on the scroller, so a frame that changes nothing writes nothing. */
	paperPanWritten: { x: string; y: string } | null = null;
	/**
	 * How far the at-rest plan put the paper off the text to land it on the device px grid, layout px, per axis: the
	 * written phase less the text's own. The snap is an at-rest guarantee; a preview carries it back out, so the paper
	 * tracks the text through the gesture and lands on the new grid at the settle.
	 */
	paperSnapResidual = { x: 0, y: 0 };
	/**
	 * THE PREVIEW PAPER: while a preview lives (and through the bounce its settle starts), the paper is this element under
	 * the scroller, moved by a transform, instead of the scroller's own background moved through its stops. A transform is
	 * composited; a stop moved by a pan re-rasters the whole background on every frame of a two-finger drag. Null at rest.
	 */
	previewPaperEl: HTMLElement | null = null;
	/** The pitch the element was copied at, layout px: its fold and its margin. */
	previewPaperPitch = 0;
	/** The phases the element's copy carries, layout px (0 where the host's are not px): what its rounding lands on the grid. */
	previewPaperPhaseX = 0;
	previewPaperPhaseY = 0;
	/** The scroller's padding box inside the host, layout px, before the margin: where the element's box is measured from. */
	previewPaperBox: { top: number; right: number; bottom: number; left: number } | null = null;
	/** The device px per layout px the element was last placed at: a zoom frame with no pan still re-places it. */
	previewPaperKd = 0;
	/**
	 * `applyViewportBox`'s own scale-change repaint of the preview paper, recorded but not yet written: on the live
	 * preview frame it defers to `anchorPanTo`, which runs synchronously afterward, before paint, and is this
	 * frame's one real write of the element - so the deferred one paints nothing extra, it just cleared the guard.
	 */
	previewPaperBoxDirty = false;
	/** The inset and transform last written on the element, so a frame that changes neither writes nothing. */
	previewPaperInset = "";
	previewPaperTransform = "";
	/** The scroll the element's offset was last derived at, layout px; NaN until one is read. */
	paperScrollLeft = Number.NaN;
	paperScrollTop = Number.NaN;
	/** Set by the settle once it has taken the preview paper down or handed it to a bounce, so the gesture's end does not do it again. */
	previewPaperHandoff = false;
	/** True only across the settle's own commit, which ends a preview without taking the preview paper down. */
	previewPaperSettling = false;
	/** The path that last took the preview paper down, and how many times it has been put up: read by fixtures only. */
	previewPaperEnded: PreviewPaperEnd | null = null;
	previewPaperSwaps = 0;

	/**
	 * GRID PAPER'S SECOND BOX. Under grid paper the scroller paints the horizontal rules and this element,
	 * its first child, paints the vertical ones - one repeating gradient each, because two on one large box lose
	 * the first layer's rules as the box grows. Null under every other paper, and under none.
	 */
	paperGridBox: HTMLElement | null = null;
	/**
	 * What tells this overlay the paper CHANGED. Nothing did before: the paper is the stylesheet's, and a class or a
	 * note's attribute needed no code to take effect. The box does, so two narrow watches - the body's own class (the
	 * global paper, the cycle command) and the `data-handwriting-paper` attribute anywhere (a note's own choice, which
	 * NotePaper writes on the leaf container). Deliberately NOT a class watch with `subtree`, which would fire on
	 * every `cm-activeLine` toggle - a callback per cursor move.
	 */
	paperKindWatch: MutationObserver[] = [];
	paperKindFrame: number | null = null;
	/** The box's written size, `w,h` in layout px, and its written pan: neither is written again unchanged. */
	paperGridBoxSize: string | null = null;
	paperGridBoxPanX = "";

	/** When the settle being traced began, performance.now() ms; NaN outside one. Diagnostics only. */
	settlePaperT0 = Number.NaN;
	/** The frame chain that traces the paper after a settle; 0 when none is queued. Diagnostics only. */
	settlePaperRaf = 0;

	/**
	 * The margin a RESTING frame gives a centred column, or null while a gesture is live (the pan holds it then) and for
	 * every column that has no rest. Set on each commit before `applyViewportBox` writes the box; cleared for preview
	 * frames, which keep the frozen margin so no layout moves under the fingers.
	 *
	 * WHERE A CENTRED COLUMN RESTS at scale `next`, as a host-local margin, or null when this column has no rest (the
	 * guards are the ones above). `applyViewportBox` writes it as the sizer's margin at rest, so the resting page needs no
	 * pan; `columnRestPan` reads it too, and returns the difference the layout has not taken.
	 */
	columnRestMargin: number | null = null;

	/** The resolved margin the last RESTING frame left the page at, host-local. Null until the first one. */
	restingColumnMargin: number | null = null;

	/**
	 * Screen px the page is owed because a RESTING commit moved the margin under it. A regime change - the page ceasing
	 * to fit the pane, so the centring is withdrawn - is a change of law, not of position, and the page may not move on
	 * its own for it. Accrued at the box write and paid by the settle in the same commit.
	 */
	columnMarginDebt = 0;

	/** Counted whenever the settle's clamp moved a pan on a FITTING axis, with the largest correction so far. */
	panBoundHits = 0;
	panBoundMaxPx = 0;

	get scrollRangeOwners(): WeakMap<SelectionRange, object> {
		return viewportScrollLifetime(this.view).owners;
	}


 /**
  * WHAT THE BROWSER DID NOT KEEP of the last owned scroll write, host-local px per axis: the written offset less the
  * kept one. The transform form's scroller keeps whole px, so a settle that writes 2586.5 gets 2587 and the page lands
  * half a host px short, k times that on screen (measured: 1 px at k 2, the focal settle cells). It rides on the host's
  * transform as a translate until the next owned write. A scroll the overlay did not write moves by whole px and keeps
  * it, except at either end of an axis. A clamp at either end of the range is never a residual: the page edge does not
  * move. The zoom form keeps nothing here.
  */
 scrollResidual={x:0,y:0,left:0,top:0};
 /** The factor the host's transform form was last written with, or null while the host is in the zoom form or released. */
 hostTransformScale:number|null=null;
 /** A canvas-off reset to 100 percent that could not run yet; see applyCanvasMode. */
 canvasOffResetPending=false;

	// ---- history --------------------------------------------------------------

	/** The owning document survives long enough to retire a closing window. */
	get ownerDocument(): Document {
		return this.view.dom.ownerDocument;
	}

	/** Whether the lasso currently holds anything, for command gating. */
	get hasSelection(): boolean {
		return !this.selection.isEmpty;
	}
}
installCursors(InkOverlayPlugin.prototype);
installLassoSpace(InkOverlayPlugin.prototype);
installInkOverlayClipboard(InkOverlayPlugin.prototype);
installPaperPinch(InkOverlayPlugin.prototype);
installPanSettle(InkOverlayPlugin.prototype);
installInkOverlayViewportBox(InkOverlayPlugin.prototype);
installInkOverlayColumnMargin(InkOverlayPlugin.prototype);
installDiagnostics(InkOverlayPlugin.prototype);
installMeasureHold(InkOverlayPlugin.prototype);
installLayout(InkOverlayPlugin.prototype);
installLifecycle(InkOverlayPlugin.prototype);
installKeys(InkOverlayPlugin.prototype);
installZoomApi(InkOverlayPlugin.prototype);
installPinch(InkOverlayPlugin.prototype);
installLineAnchors(InkOverlayPlugin.prototype);
installReload(InkOverlayPlugin.prototype);
installGestureEnd(InkOverlayPlugin.prototype);
installInkOps(InkOverlayPlugin.prototype);
installErase(InkOverlayPlugin.prototype);
installExtent(InkOverlayPlugin.prototype);
installBand(InkOverlayPlugin.prototype);
installPenSupport(InkOverlayPlugin.prototype);
installPenPath(InkOverlayPlugin.prototype);
installInkOverlayCamera(InkOverlayPlugin.prototype);
installInkOverlayRepaint(InkOverlayPlugin.prototype);

const inkOverlayPlugin = ViewPlugin.fromClass(InkOverlayPlugin, {
	provide: plugin => EditorView.editorAttributes.of(view => {
		const overlay = view.plugin(plugin);
		if (!overlay?.ownsNoteViewport()) return null;
		// BOTH tokens, because this facet is the host's class attribute: CodeMirror writes it whole on every update and
		// anything not named here is dropped. See `noteViewportOwnLines`.
		return { class: "handwriting-note-viewport" + (overlay.noteViewportOwnLines() ? " handwriting-note-viewport-own-lines" : "") + (overlay.noteScrollbarUnscaled() ? " handwriting-scrollbar-unscaled" : "") };
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
export function viewportScrollLifetime(view: EditorView): ViewportScrollLifetime {
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

export const consumeViewportScroll = (view: EditorView, range: SelectionRange): boolean => {
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
