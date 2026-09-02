import { diagnosticsEnabled } from "../diag/DiagSwitch";
/**
 * Ink on a PDF view: one overlay canvas per live page, kept in step with a
 * viewer we never touch.
 *
 * The whole integration is observation. We add canvases inside page divs and
 * read geometry; we do not patch pdf.js, do not call into Obsidian internals,
 * and do not require any API to function. What can break is markup, and
 * markup breaking turns into "no overlays" rather than a crash, because every
 * read goes through PdfViewerProbe and every failure there returns null.
 *
 * Two M0 findings shape this and neither was in the design:
 *
 * - Page divs are NOT virtualized. All 100 exist in a 100-page document, so
 *   an overlay per div is 100 canvases. Overlays follow the viewer's CANVAS
 *   window instead - the pages it has actually rendered - which is a policy
 *   Obsidian has already tuned, and which we then drift WITH rather than away
 *   from.
 * - Page geometry is stable and scroll-independent, so scrolling alone needs
 *   no repaint. Only the live set changing, or the scale changing, does.
 *
 * M1 is read-only: this renders stored ink and captures nothing. Input is M2.
 */

import { CameraState } from "../camera/coordinates";
import { InkPoint, InkStroke, InkTool } from "../ink/Stroke";
import { markPenSeen } from "../inline/PenToolsMode";
import {
	padBBox,
	pointInBBox,
	polygonBounds,
	strokeInLasso,
	unionBounds,
} from "../objects/Selection";
import { Point2 } from "../ink/Smoothing";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { TailRenderer } from "../ink/TailRenderer";
import { PalmShield, isAppleTouchPlatform, palmRadiusTrustworthy } from "../input/PalmShield";
import { PinchBridge } from "./PinchBridge";
import { StrokeMetrics } from "../ink/StrokeMetrics";
import { EINK_CAPS, adaptiveCaps, buildTail, correctionError } from "../ink/Prediction";
import { presentLagMs, recordPresentAge } from "../ink/LatencyEstimate";
import { predictionEinkOn, predictionEnabled } from "../inline/StrokePrediction";
import { rowsOf, snapLine, strokeIdsBelow } from "../inline/InsertSpace";
import { copyInk, pasteInk } from "../inline/InkClipboard";
import { drawStroke, ribbonCacheStats } from "../ink/StrokeRenderer";
import { DEFAULT_PEN, HIGHLIGHTER_ALPHA, HIGHLIGHTER_PEN, PenStyle } from "../ink/PenStyle";
import { getInkColorHex } from "../ink/InkColor";
import { getInkSizeMult, getInlineTool, penReticleEnabled, pickStripColor } from "../inline/InkOverlay";
import { InlinePenRouter } from "../inline/InlinePenRouter";
import { PenSample } from "../input/PointerRouter";
import { InkOp } from "../inline/InkHistory";
import { newStrokeId } from "../ink/Stroke";
import { splitStrokeByCircle, strokesHitByCircle } from "../ink/Eraser";
import {
	commitEraserRadius,
	getEraserRadiusPx,
	getEraserWholeStrokes,
	getInlineEraserMode,
	getInlineLassoMode,
	getInlinePanMode,
	getInlineSpaceMode,
	getToolbarCorner,
	setEraserRadiusPx,
	setEraserWholeStrokes,
	setInkSizeMult,
} from "../inline/InkOverlay";
import { armMouseInkQuietly, mouseInkEnabled } from "../inline/MouseInk";
import { MobileTools } from "../inline/MobileTools";
import {
	armStripPenFocus,
	stripPenDown,
	stripPenFocus,
	stripPenUp,
} from "../inline/StripPenChrome";
import { clipboardSize } from "../inline/InkClipboard";
import { colorsFor } from "../ink/InkColor";
import { tipMode } from "../inline/TipMode";
import { PdfInkHistory } from "./PdfInkHistory";
import { PageBox, livePages, pageAt, snipViewport, toPagePoint } from "./PageMap";
import { findScaleFactor, ProbedViewer, probeViewer, viewerCanvasOf } from "./PdfViewerProbe";

const OVERLAY_CLASS = "handwriting-pdf-ink";
/** Put on the COMMITTED canvas while a highlighter is wet. See `dressWet`. */
const INK_OVER_CLASS = "handwriting-pdf-ink-over";
/**
 * Classes that mark an element as ours, for `isOwnMutation`. Audit doc
 * §5b/D1: the root's own MutationObserver watched everything under it,
 * including the writes this controller makes to its own reticle and hover
 * class, so a hovering pen defeated its own probe cache every time it moved.
 */
const OWN_CLASSES = [OVERLAY_CLASS, INK_OVER_CLASS, "handwriting-pdf-cursor"];

/**
 * Is this event aimed at somewhere the user is typing?
 *
 * Duck-typed rather than `instanceof`: a popout window's elements belong to
 * another realm, where `instanceof HTMLInputElement` is false for a real
 * input.
 */
function isTypingTarget(target: EventTarget | null): boolean {
	const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
	if (!el || typeof el.tagName !== "string") return false;
	const tag = el.tagName.toLowerCase();
	return tag === "input" || tag === "textarea" || el.isContentEditable === true;
}

/** Device pixels one page overlay may hold, mirroring the note layer's bound. */
const MAX_OVERLAY_PX = 4_000_000;

/** A snip: the PNG and the page it left, or the reason there is none. */
export type SnipResult =
	| { ok: true; bytes: Uint8Array; pageNumber: number }
	| { ok: false; reason: string };

/** Screen-px slack around a selection for the grab that starts a drag. */
const SELECTION_GRAB_PAD_PX = 8;

/**
 * The pen's stored width on this surface, in PAGE units.
 *
 * One function because two call sites have to agree. The stroke stores this,
 * and the hover reticle draws it times the scale, because the dot promises the
 * width of the ink it is about to lay down. They drifted apart the moment the
 * stroke started dividing by the scale and the reticle did not: the dot came
 * out at nearly twice the width of the line (hardware, 2026-08-29).
 */
/**
 * The scale a pointer sample is converted with: from the BOX, falling back to
 * the viewer's own number when the page has no measured size yet.
 *
 * Pure, because the rule is the whole point and the class it lives on needs a
 * rendered viewer to reach. A page that has been painted has a size in points
 * that does not move with zoom, so the box divided by it is the true scale at
 * this instant; `--scale-factor` is the viewer's intention, which arrives on
 * its own schedule.
 */
export function pointerScale(boxWidthPx: number, pageWidthPt: number, fallback: number): number {
	return pageWidthPt > 0 && boxWidthPx > 0 ? boxWidthPx / pageWidthPt : fallback;
}

export function pdfPenWidth(baseWidth: number, sizeMult: number, scale: number): number {
	return (baseWidth * sizeMult) / scale;
}

/**
 * How long a viewer probe may be reused when nothing has invalidated it.
 *
 * A backstop, not the mechanism: the observers below invalidate on the things
 * that actually move page geometry. This bounds the damage from a change
 * neither of them sees.
 */
const PROBE_MAX_AGE_MS = 250;

/** Floor between mutation-driven syncs. See scheduleThrottled. */
const SYNC_MIN_GAP_MS = 120;

/** Where a page's strokes come from. Page numbers are 1-based. */
export type StrokeSource = (pageNumber: number) => readonly InkStroke[];

/**
 * A finished gesture, as an operation to apply.
 *
 * Operations rather than strokes because erase and undo cannot be expressed
 * as "here is a stroke": a partial erase removes one and inserts its pieces
 * as ONE step, and undo is whatever the inverse of that turns out to be.
 * Emitting ops means drawing, erasing and undoing all leave by the same door,
 * and the caller applies them the same way.
 */
/**
 * How an op should reach the store.
 *
 * "live" = apply it to the session, do not write. The eraser, the lasso drag
 * and insert-space each emit one op per pointer sample, and a write per
 * sample is a serialize of the whole document behind a debounce, at input
 * rate, during a gesture already doing hit-testing and repainting. The single
 * write is the `persist` callback at pen-up.
 */
export type OpMode = "live" | "commit";

export type OpSink = (op: InkOp, mode?: OpMode) => void;

interface Attached {
	/**
	 * The committed ink for this page, and the only canvas that is per page:
	 * it holds THIS page's stored strokes. The wet and head layers used to
	 * live here too, one pair per live page, and only ever one of them could
	 * be drawn on - see `WetPair` (audit doc §5h/H1).
	 */
	canvas: HTMLCanvasElement;
	/** What this canvas was last painted for, so an unchanged page is skipped. */
	paintedScale: number;
	paintedCount: number;
}

/**
 * The live stroke's own canvases, above the committed one - ONE pair for the
 * whole surface, owned by the controller and parented into whichever page the
 * current gesture is on.
 *
 * Separate from the committed canvas because the wet stroke is redrawn
 * constantly and the committed ink is not; sharing one canvas means either
 * clearing the committed ink every frame or never clearing the wet trail. The
 * note surface splits them for the same reason.
 *
 * Only ONE page can host a gesture at a time (`strokePageNumber`), so a pair
 * per live page was 2N-2 full-page backing stores allocated, resized on every
 * zoom and never drawn to: on a tablet at 3x dpr, ~5 MB each, ~100 MB across
 * ten live pages (audit doc §5h/H1, 2026-09-02).
 *
 * `headCanvas` is the head: the raw stub from the settled curve to the nib, on
 * a layer of its own because it is erased and redrawn on every event and the
 * wet canvas is append-only. The note surface has had this split since the
 * smoothing landed; without it the line here only advanced when the NEXT
 * sample settled a segment - one visible straight jump per sample, which at
 * mouse rates reads as jagged (alan, 2026-08-30).
 */
interface WetPair {
	wetCanvas: HTMLCanvasElement;
	wet: WetInkRenderer;
	headCanvas: HTMLCanvasElement;
	tail: TailRenderer;
}

export class PdfInkController {
	private overlays = new Map<number, Attached>();
	/**
	 * The one wet/head pair, built on first use and kept for the life of the
	 * controller. Two panes on one pdf are two controllers, so nothing here is
	 * shared across panes.
	 */
	private pair: WetPair | null = null;
	/**
	 * The page the pair is parented into right now, 0 when it is nowhere.
	 *
	 * Read by `wetOn`, which is what every wet/head site asks instead of the
	 * per-page overlay it used to ask: a wet operation aimed at a page the
	 * pair is not on is the no-op it always was, because that page used to
	 * have its own blank wet canvas.
	 */
	private wetHostPage = 0;
	/** Whether the stroke on the wet layer right now is a highlighter. */
	private wetHighlighter = false;
	/**
	 * A live pan gesture: where the last sample was, in scroller-viewport
	 * coordinates. Deltas of those ARE scroll deltas, which is what makes
	 * this whole mode three lines of arithmetic.
	 */
	private panLast: { x: number; y: number } | null = null;
	/**
	 * A live insert-space gesture: the divider's y in page units, the ids
	 * frozen at pen-down, and the drag so far. Same shape as the note
	 * surface's, minus the text half - a pdf page cannot grow, but the ink
	 * on it can make room.
	 */
	private spaceLineY: number | null = null;
	private spaceIds: string[] = [];
	private spaceLastY = 0;
	private spaceTotalDy = 0;
	/**
	 * True while the live stroke is a MOUSE wearing the pen's hat.
	 *
	 * The reticle keys off this: under a real pen the hand is its own marker
	 * and the dot is hidden at contact, but a mouse has nothing at the nib -
	 * hiding the dot at click handed the system arrow back mid-stroke, which
	 * read as the reticle giving up (alan, 2026-08-30).
	 */
	private mouseStroke = false;

	/**
	 * The last pen-down, as every number that went into placing it - kept so
	 * the view report can print the arithmetic instead of someone eyeballing
	 * an offset against a cursor tip. Diagnostic only; never read by code.
	 */
	private lastDownDebug: string | null = null;
	private disposers: Array<() => void> = [];
	/** Rejects palm-shaped touches before the viewer's pinch can see them. */
	private palmShield = new PalmShield();
	/** Re-anchors the viewer's pinch at the fingers; see PinchBridge. */
	private pinchBridge = new PinchBridge(
		() => this.idle,
		// One computed-style read off one element: cheap enough per step, and
		// the value the viewer itself lays pages out by.
		() => {
			const page = this.boundScroller?.querySelector("div.page[data-page-number]");
			if (!(page instanceof HTMLElement)) return null;
			return findScaleFactor(page, this.win).value;
		}
	);
	/**
	 * This surface's own latency instruments, stamped at the same points the
	 * note surface stamps its own. Latency work here was guesswork before
	 * this existed: the note surface's 25-37ms - measured, hunted to a flag,
	 * cut to ~7ms - happened because the numbers existed to argue with.
	 * Read through the PDF view report.
	 */
	private metrics = new StrokeMetrics();
	private metricsLive = false;
	private frameTicking = false;
	private presentProbePending = false;
	/**
	 * Recent REAL samples, newest last: what the predicted tail extrapolates
	 * from. Page units, which is this surface's sample space throughout.
	 */
	private predReal: PenSample[] = [];
	/** The tail drawn last event, kept only to score it against what arrived. */
	private predLastTail: PenSample[] = [];
	private syncQueued = false;
	private lastScale = 0;
	/**
	 * The last viewer probe, reused until something moves the page geometry.
	 *
	 * `probeViewer` reads clientWidth, clientHeight, offsetTop, offsetLeft and
	 * a rect off EVERY page div, and pdf.js keeps every page div alive (see
	 * PdfViewerProbe V5) - so on a long document one call is hundreds of
	 * forced layout reads. Hover fires at pen rates, which meant paying that
	 * continuously just for holding the pen over the page.
	 */
	private probedCache: ProbedViewer | null = null;
	private probedAt = 0;
	private probedValid = false;
	private lastSyncAt = 0;
	private trailingSync: ReturnType<Window["setTimeout"]> | null = null;
	/**
	 * What the probe cache is worth, counted rather than argued.
	 *
	 * `reads` is DOM work actually done. `served` and `inStroke` are calls the
	 * old path would have turned into a full sweep of every page div - served
	 * from the cache, and skipped entirely because a stroke carries its own
	 * frozen geometry.
	 */
	private probeReads = 0;
	private probeServed = 0;
	private probeInStroke = 0;
	/**
	 * The scroller the pen and the resize watch are attached to.
	 *
	 * Kept so the swap can be noticed. See bindTo.
	 */
	private boundScroller: HTMLElement | null = null;
	private ro: ResizeObserver | null = null;
	/**
	 * Each page's size in points, learned once per page.
	 *
	 * Per PAGE, not per document. A single cached width assumes every page is
	 * the same size, and a file with one landscape figure among portrait pages
	 * would then convert that page's samples with the wrong scale - storing
	 * coordinates that are wrong in the file, not merely drawn wrong. That is
	 * unrecoverable after the fact, which is why it is keyed correctly before
	 * anything is stored rather than after someone reports it.
	 */
	private pageSize = new Map<number, { wPt: number; hPt: number }>();
	/**
	 * Pages whose aspect changed after we first measured them - a rotation.
	 *
	 * Ink is refused there. Stored coordinates are page-local against an
	 * UNROTATED layout, and there is no way to reinterpret them for a rotated
	 * one without knowing which way it turned and when. Refusing costs a
	 * feature on a rare page; guessing costs the ink.
	 */
	private rotated = new Set<number>();

	/**
	 * Whether the user has already been told this document is still being
	 * identified. One notice per wait, not one per pen contact.
	 */
	private warnedNoId = false;
	/** Said once per pane: this viewer is not one we know how to ink. */
	private warnedNoViewer = false;

	/** The stroke in progress, and the page it was bound to at pen-down. */
	private builder: StrokeBuilder | null = null;
	private strokePageNumber = 0;
	private strokeStyle: PenStyle = { ...DEFAULT_PEN };
	private router: InlinePenRouter | null = null;
	/** Live geometry for the stroke, read once at pen-down and then frozen. */
	private frame: { boxes: PageBox[]; scale: number; scroller: HTMLElement } | null = null;
	/** The last drawn point, in page units, for the wet segment. */
	private wetFrom: { x: number; y: number; pressure: number } | null = null;
	/**
	 * Whether the wet layer has been told this stroke started.
	 *
	 * This surface never called `beginStroke` at all: pen-down cleared the
	 * canvas and the first sample went straight to `appendPoint`, so the wet
	 * renderer's per-stroke decisions were stuck at their initialisers - the
	 * centerline smoothed forever while the commit followed the setting
	 * (Alan, on a PDF with Ink smoothing off, 2026-09-02), and the shaped
	 * width law it is dressed for never once ran.
	 */
	private wetBegun = false;
	/**
	 * The flatness of the tool the live stroke is drawn with, read at
	 * pen-down. It cannot be read off the wet layer: ONE pair serves both
	 * tools here (`dressWet` changes its opacity, not its renderer), so the
	 * highlighter's exemption has to travel with the stroke.
	 */
	private wetFlat = false;
	/** True for the whole of an erase gesture, decided once at pen-down. */
	private erasing = false;
	/** The lasso being drawn, in page units. Empty when not lassoing. */
	private lassoPts: Point2[] = [];
	/** Ids of the strokes the last lasso caught, and the page they are on. */
	private selected: string[] = [];
	/**
	 * The page the selection lives on - NOT the page being drawn on now.
	 *
	 * They differ the moment someone lassos on one page and draws on another,
	 * and clearing the chrome by the wrong one leaves a dashed loop stranded
	 * on a page nothing is selected on.
	 */
	private selectionPage = 0;
	/** Set while dragging a selection; the point the drag started from. */
	private dragFrom: Point2 | null = null;
	private dragTotal = { dx: 0, dy: 0 };
	/** The hover reticle, and the timer that hides it when the pen is gone. */
	private cursorEl: HTMLElement | null = null;
	/** Whether the reticle's single teardown is already registered. */
	private cursorDisposed = false;
	private cursorTimer: ReturnType<Window["setTimeout"]> | null = null;
	/** The floating pen strip, once this view has seen a pen. */
	private tools: MobileTools | null = null;
	/**
	 * The page's strokes as they were when an erase gesture began.
	 *
	 * One swipe of the eraser crosses dozens of samples. Recording each as its
	 * own operation would make a single gesture into dozens of undo steps -
	 * press Ctrl+Z and take back one sample's worth of erasing. The store is
	 * still updated per sample, because the ink has to disappear under the nib
	 * as you move it; the HISTORY gets one entry, computed from this snapshot
	 * against the result at pen-up.
	 */
	private eraseFrom: InkStroke[] | null = null;
	/**
	 * Between mount() and unmount(). Gates the sync path, which is the only
	 * thing here that can BIND: a queued frame or a late refresh() must not
	 * rebuild a router and its capture listeners on a dead controller.
	 */
	private mounted = false;
	/** A live op has been applied and not yet written. See OpMode. */
	private liveDirty = false;

	constructor(
		private root: HTMLElement,
		private win: Window,
		private strokes: StrokeSource,
		private documentId: () => string | null = () => null,
		/**
		 * Every stroke in the document, in the order the store holds them.
		 *
		 * The op indices MUST be positions in this list, because that is the
		 * list applyOp splices into (the store applies every op against the
		 * whole document). `strokes` is page-filtered, so indices taken from
		 * it were page-local and only ever right on page one - undo an erase
		 * on page five and the pieces came back at whatever depth those
		 * numbers happened to name among the document's strokes.
		 */
		private allStrokes: () => readonly InkStroke[] = () => [],
		private onOp: OpSink = () => {},
		/** Runs an Obsidian command by id, for the toolbar's buttons. */
		private exec: (commandId: string) => void = () => {},
		/**
		 * Say something to the user. Injected rather than importing Notice,
		 * for the same reason `exec` is: this file observes the DOM and does
		 * nothing else, which is what lets it be built in a test.
		 */
		private notify: (message: string) => void = () => {},
		/**
		 * Write this document now. Called once at the end of a gesture whose
		 * ops were applied live; see OpMode.
		 */
		private persist: (id: string) => void = () => {}
	) {}

	/**
	 * The floating pen strip, on the PDF view.
	 *
	 * The same component the note surface uses, against the same global tool
	 * state - so switching to the eraser on a PDF and switching back on a note
	 * are one setting, not two that drift. Almost every method here delegates
	 * to a module-level accessor for exactly that reason.
	 *
	 * Created on the first pen contact rather than at mount, like the note
	 * surface: a vault opened on a desktop with no pen never grows a strip.
	 */
	private ensureTools(): void {
		if (this.tools) return;
		try {
			this.buildTools();
		} catch (err) {
			// A strip that cannot mount must never take the ink down with it.
			// The note surface learned this on release day, on an iPad, where
			// chrome failing stopped the pen working entirely.
			console.error("[handwriting] pdf pen tools strip failed to mount", err);
		}
	}

	private buildTools(): void {
		this.tools = new MobileTools(this.root, {
			// Mouse ink is a global mode; the toggle command flips it and the
			// strip lights follow the input here exactly as on notes.
			mouseInkOn: () => mouseInkEnabled(),
			recordingOn: () => diagnosticsEnabled(),
			setMouseInk: (on) => {
				if (mouseInkEnabled() !== on) this.exec("handwriting:mouse-ink-toggle");
			},
			armMouseInkQuietly: () => armMouseInkQuietly(),
			exec: (id) => this.stripExec(id),
			activeTool: () => getInlineTool(),
			eraserOn: () => getInlineEraserMode(),
			eraserWholeStroke: () => getEraserWholeStrokes(),
			setEraserWholeStroke: (on) => setEraserWholeStrokes(on),
			lassoOn: () => getInlineLassoMode(),
			spaceOn: () => getInlineSpaceMode(),
			panOn: () => getInlinePanMode(),
			activeColor: () => getInkColorHex(getInlineTool()),
			eraserRadiusPx: () => getEraserRadiusPx(),
			setEraserRadiusPx: (px, commit) => {
				setEraserRadiusPx(px);
				if (commit) commitEraserRadius();
			},
			// This view's own ring, not the editor's history - there is no
			// CodeMirror here to ask.
			canUndo: () => this.history.depth.done > 0,
			canRedo: () => this.history.depth.undone > 0,
			// The id gate as well as the clipboard, audit doc §5k/AD4: a paste
			// offered while the document is still being hashed reached
			// `pasteFromClipboard`'s `if (!id) return` and did nothing at all,
			// with a lit button as the only account of it.
			canPasteInk: () => clipboardSize() > 0 && this.documentId() !== null,
			// The bounds, not the raw id list - the same question `hasSelection`
			// answers, and for the reason its own comment gives: ids outlive a
			// sidecar reload, so a selection whose strokes were deleted on
			// another device is a list of ids that match nothing.
			// `deleteSelection` resolves those ids against live strokes and
			// returns false when none match, and `idle` is true while a
			// completed selection is held, so the reload poll can run exactly
			// then - leaving a lit trash button, a click that passed the
			// enablement gate, and "lasso some ink first" over a visible
			// lasso. One question, one answer.
			hasInkSelection: () => this.hasSelection,
			palette: () => colorsFor(getInlineTool()),
			pickColor: (name, hex) => pickStripColor(name, hex),
			inkSizeMult: (tool) => getInkSizeMult(tool as InkTool),
			setInkSizeMult: (tool, mult, commit) => {
				setInkSizeMult(tool as InkTool, mult);
				void commit;
			},
		});
		this.tools.setCorner(getToolbarCorner());
	}

	/**
	 * What a button on THIS controller's strip does.
	 *
	 * editor:undo/redo are native keybindings rather than plugin commands, so
	 * they were always answered here - this view has no CodeMirror to undo.
	 *
	 * The selection buttons are answered here too, audit doc §5k/AD1. Z moved
	 * their dispatch out to the commands on the reasoning that one
	 * implementation should have one caller; the implementation is shared (the
	 * commands call these same methods), but the DISPATCH cannot be, because
	 * the commands resolve a surface from the workspace and a strip button
	 * never takes focus - MobileTools preventDefaults pointerdown so the pen
	 * does not leave the page. Note left and active with a live lasso, PDF
	 * right, lasso on the PDF, press the PDF strip's trash: the command
	 * resolved the NOTE and deleted the note's strokes, and a paste put
	 * page-stamped PDF strokes into a note. The button knows its controller;
	 * the palette does not, so the palette keeps `activeInkSurface` and the
	 * button asks the controller it is mounted on.
	 */
	private stripExec(id: string): void {
		if (id === "editor:undo" || id === "editor:redo") {
			this.historyStep(id === "editor:redo");
			return;
		}
		if (id === "handwriting:delete-selected-ink") {
			this.deleteSelectionCommand();
			return;
		}
		if (id === "handwriting:copy-selected-ink") {
			this.copySelection();
			return;
		}
		if (id === "handwriting:cut-selected-ink") {
			this.cutSelectionCommand();
			return;
		}
		if (id === "handwriting:paste-ink") {
			this.pasteFromClipboard();
			return;
		}
		this.exec(id);
	}

	/** The strip's active-tool marks are stale; recompute them. */
	refreshStrip(): void {
		this.tools?.setCorner(getToolbarCorner());
		this.tools?.refresh();
		// Audit doc §5f: this is the fan-out that already runs on setting
		// changes for PDFs (addStripSurface, main.ts). If "Pen reticle" (or
		// Boox mode) turned off while the dot was showing - the pen held
		// still, no further hover sample to hit the new gate in showCursor -
		// the existing hide path is enough; no new plumbing needed.
		if (!penReticleEnabled()) this.hideCursor();
	}

	/**
	 * This view's undo ring.
	 *
	 * Per view, matching the note surface, where undo is CodeMirror's history
	 * and therefore per editor. Every op carries its document id, so an undo
	 * pressed after this pane opened a different PDF still acts on the one the
	 * ink belongs to. See PdfInkHistory.
	 */
	private history = new PdfInkHistory();

	mount(): void {
		this.mounted = true;
		// The keydown listener below is bound to this root, so the root has to
		// be able to hold focus at all before a claimed pen can hand it any
		// (StripPenChrome.ts). Once, here, rather than at pen contact: it is an
		// attribute on the pane, not part of a gesture.
		armStripPenFocus(this.root);
		// No probe gate here. The viewer is not necessarily built when the leaf
		// appears, and a controller that returned early here stayed inert for
		// the life of the pane with nothing to say for itself - the same silent
		// death as binding to a viewer that was later replaced. Watching the
		// leaf costs nothing until there is something to see, and the first sync
		// that finds a scroller binds the pen to it.

		// The viewer's own windowing is a DOM mutation - canvases appearing
		// and disappearing inside page divs - so that is what we watch. A
		// scroll listener would fire far more often and tell us less: page
		// geometry does not move with scroll (M0).
		// Attributes as well as children. A trackpad pinch changes the zoom by
		// restyling pages and resizing the existing canvases - no element is
		// added or removed - so childList alone never fires and the overlays
		// are left at the old scale (hardware: the marks vanished on a
		// two-finger zoom). Every sync is coalesced into one frame, so a noisy
		// filter costs a boolean per mutation and nothing more.
		// Observed on the LEAF container, not on the scroller. The viewer
		// element can be replaced inside a leaf that survives, and an observer
		// bound to the old one never fires again - which is the difference
		// between noticing the swap and never syncing another frame. The root
		// contains the scroller, so every signal the old placement saw still
		// arrives here.
		const mo = new MutationObserver((mutations) => {
			// Audit doc §5b/D1: filter our own writes before anything else
			// runs, so a hovering pen - which only ever touches the reticle
			// and the scroller's hover class - stops re-invalidating the
			// probe cache it just filled. See `isOwnMutation`.
			const records = mutations.filter((m) => !this.isOwnMutation(m));
			if (records.length === 0) return;
			this.invalidateProbe();
			// A zoom that lands MID-GESTURE breaks the frozen frame's whole
			// contract: the wet preview keeps drawing in pre-zoom geometry on
			// a canvas the page just stretched - offset ink and blurred lines
			// until pen-up snapped it true (alan, 2026-08-30). The stroke's
			// samples are page units and survive the zoom untouched, so the
			// honest move is to END the gesture at the moment its page
			// provably resized, committing what was drawn. Checked against
			// the stroke's own page div, one direct read, so the storm of
			// unrelated mutations (canvas swaps while scrolling) costs one
			// comparison and commits nothing.
			const frame = this.frame;
			if (frame && !this.idle) {
				const el = this.pageElement(frame.scroller, this.strokePageNumber);
				const box = frame.boxes.find((b) => b.pageNumber === this.strokePageNumber);
				if (el && box && Math.abs(el.clientWidth - box.widthPx) > 1) {
					this.penUp();
				}
			}
			// Throttled, which is what scheduleThrottled was written for and
			// never actually got: this fires on every viewer reflow, and each
			// sync probes every page div. A zoom or a fast scroll produced
			// sixty of them a second.
			this.scheduleThrottled();
		});
		mo.observe(this.root, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["style", "width", "height", "class"],
		});
		this.disposers.push(() => mo.disconnect());

		// The pen binds on the first sync that finds a scroller, and rebinds
		// whenever that element is replaced.
		this.disposers.push(() => {
			this.router?.dispose();
			this.ro?.disconnect();
		});

		// Undo scoped to this view, not a global command. Obsidian's own undo
		// stack owns Ctrl+Z everywhere else, and a global binding would fight
		// it in every editor in the vault.
		const keys = (ev: KeyboardEvent): void => {
			// A PDF pane still contains places to type: the viewer's find
			// bar, and form fields in the document itself. This listener runs
			// ahead of them, so Backspace in a search box deleted the ink
			// selection and never reached the box. Undo is the same story -
			// Ctrl+Z in a text field belongs to the field.
			if (isTypingTarget(ev.target)) return;
			// Escape puts a selection away; Delete takes it. Both ahead of the
			// modifier check, because neither uses one.
			if (ev.key === "Escape" && this.selected.length > 0) {
				this.clearSelection();
				this.refreshStrip();
				ev.preventDefault();
				return;
			}
			// Audit doc §5r/§5s: this used to call `deleteSelection()` directly -
			// a fourth dispatcher beside the strip button, the palette and the
			// hotkey (Slice AD unified only those three onto the controller's
			// command methods). `deleteSelection()` carries no id gate and no
			// notice, so a Delete pressed with a live selection whose document
			// id was still missing, or whose ids no longer matched a live
			// stroke, did nothing and said nothing.
			// §5s/AM-B, correcting this file's own first pass (9c17b12, which
			// made `deleteSelectionCommand()` answer - and consume - every
			// Delete/Backspace unconditionally): a toast is a fair answer to a
			// deliberate press of a control labelled delete, and noise in
			// answer to an ordinary Backspace that was never a request to
			// delete ink. `this.selected` is the raw id list, the same field
			// the Escape branch above already reads for the identical reason -
			// non-empty means SOMETHING was lassoed, which is what makes the
			// key a deliberate request, whether or not that request can still
			// be honoured:
			//  - empty: an ordinary Backspace. Do nothing, say nothing, do not
			//    consume - `deleteSelectionCommand()` is not even called, so it
			//    cannot notify.
			//  - non-empty, refused (no document id yet, or the ids resolve to
			//    no live stroke - the id gate and the empty-after-resolution
			//    case `deleteSelection` itself covers): notify with the
			//    existing wording and consume - the request was real and it
			//    failed for a reason the user cannot see.
			//  - non-empty, succeeds: delete silently and consume, as today.
			// `deleteSelectionCommand()` returns whether it deleted (§5s/AM-A)
			// for a future caller that needs to know; this branch does not
			// need the value; only whether it was asked at all decides
			// whether the key is consumed, and every path that IS asked
			// consumes it, by construction of the gate above.
			if (ev.key === "Delete" || ev.key === "Backspace") {
				// §5u: `this.selected` is the raw id list and outlives a sidecar
				// reload, so ids from a selection deleted on another device
				// still pass a length check while resolving to nothing. `hasSelection`
				// is the bounds-resolved question the strip's trash button (:541)
				// already asks - one question, one answer, in this file.
				if (!this.hasSelection) return;
				this.deleteSelectionCommand();
				ev.preventDefault();
				return;
			}
			if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
			const key = ev.key.toLowerCase();
			const redo = key === "y" || (key === "z" && ev.shiftKey);
			if (key !== "z" && key !== "y") return;
			if (this.historyStep(redo)) {
				ev.preventDefault();
				ev.stopPropagation();
			}
		};
		this.root.addEventListener("keydown", keys, { capture: true });
		this.disposers.push(() => this.root.removeEventListener("keydown", keys, { capture: true }));

		this.schedule();
	}

	/**
	 * Attach the pen and the resize watch to THIS scroller.
	 *
	 * Separate from mount because the viewer can be rebuilt inside a leaf that
	 * outlives it. Obsidian replaces the .pdf-viewer-container and everything
	 * bound to the old one is now bound to a subtree that is not in the
	 * document: the pen goes dead, because pointer events do not reach a
	 * detached node, and nothing schedules a sync either, so no overlay
	 * attaches and the committed ink goes with it. The controller is only
	 * rebuilt when the LEAF goes, and the leaf does not go - so this lasted
	 * the life of the pane and looked exactly like a broken plugin (hardware,
	 * 2026-08-29: "pen stopped working on pdfs", cured by opening the same
	 * file in a new tab, which is a new leaf).
	 *
	 * The router is host-parameterized - it takes the element that scrolls and
	 * the element pointer coordinates are measured against - so a PDF needs no
	 * new input machinery, only different coordinates on the way out. Scale is
	 * 1: the viewer resizes its pages rather than applying a transform, so
	 * there is no visual/layout gap of the kind the note surface divides out.
	 */
	private bindTo(scroller: HTMLElement): void {
		this.router?.dispose();
		this.ro?.disconnect();
		this.boundScroller = scroller;
		// This surface hands two-finger gestures to the viewer on purpose
		// (see the touch-action note below), which means the pen-proximity
		// gate cannot be the whole answer: a hand nudging the glass with no
		// pen anywhere near reads as a pinch and zooms the document. The
		// shield rejects by contact SHAPE instead, at capture, which is the
		// last stage where a native gesture can still be refused. Only where
		// the radii are calibrated: see palmRadiusTrustworthy for the iPad
		// that lost scrolling to it.
		if (palmRadiusTrustworthy(this.win.navigator)) this.palmShield.attach(scroller);
		else this.palmShield.dispose();
		// The pinch bridge shares the shield's platform gate for the same
		// reason in mirror image: on the iPad the viewer's own pinch is the
		// tested behaviour, and on the desktop it zooms away from the
		// fingers. One platform's cure is the other's regression.
		// No idle-time calibration: the bridge measures its gain inside the
		// first pinch itself, where the twitch belongs to the gesture.
		if (!isAppleTouchPlatform(this.win.navigator)) this.pinchBridge.attach(scroller);
		else this.pinchBridge.dispose();
		// Zoom changes the page boxes, which changes what every overlay must be
		// sized and scaled for.
		this.ro = new ResizeObserver(() => {
			this.invalidateProbe();
			this.schedule();
		});
		this.ro.observe(scroller);
		this.router = new InlinePenRouter(
			scroller,
			scroller,
			{
				onPenDown: (s, ev) => this.penDown(s, ev),
				onPenHover: (s, pointerType) => this.showCursor(s, pointerType),
				onPenLeave: () => this.hideCursor(),
				onPinch: () => {},
				onPenRaw: (samples, ev) => this.penRaw(samples, ev),
				onPenMove: () => {},
				onPenUp: (ev) => this.penUp(ev),
			},
			() => 1,
			// The viewer keeps its own pinch: nothing here implements one, and
			// "none" leaks the two-finger touches to the app as a sidebar swipe.
			"pinch-zoom"
		);
	}

	unmount(): void {
		// A gesture interrupted by the pane closing has applied live ops that
		// nothing has written yet. Before this batching existed every sample
		// wrote, so an interrupted erase was already durable; it has to stay
		// that way.
		this.persistLive();
		// Before anything else: a sync already queued for the next frame,
		// or a refresh() arriving from the store after the pane closed,
		// would otherwise reach bindTo and install capture listeners and a
		// router on a controller that is gone - the leak unmount exists to
		// prevent, rebuilt one frame later.
		this.mounted = false;
		this.palmShield.dispose();
		this.pinchBridge.dispose();
		// A trailing sync outlives the controller otherwise, and fires into a
		// viewer that is gone.
		if (this.trailingSync !== null) {
			this.win.clearTimeout(this.trailingSync);
			this.trailingSync = null;
		}
		// Disposers FIRST. One of them disposes the router, and nulling the
		// field before running them meant it never was - the router installs
		// capture listeners ahead of the whole page, and one was left behind
		// per closed pdf.
		for (const d of this.disposers) d();
		this.disposers = [];
		this.router = null;
		this.resetGestureState();
		this.tools?.destroy();
		this.tools = null;
		this.dropOverlays();
		this.boundScroller = null;
	}

	/**
	 * The view is showing a different document now.
	 *
	 * The ring is dropped rather than kept. Its ops name the old document, so
	 * they would still be applied correctly - but offering an undo for ink
	 * that is no longer on screen, in a file the user has navigated away from,
	 * is a surprise with no upside.
	 */
	forgetHistory(): void {
		this.history.clear();
		this.pageSize.clear();
		this.rotated.clear();
		// The selection names strokes in the OLD document - a Delete pressed
		// after switching files would ask this one to remove ids it has never
		// heard of - and a gesture caught mid-air is inherited whole.
		this.resetGestureState();
		// A new document is a new wait, so it may say so once more.
		this.warnedNoId = false;
	}

	/**
	 * Drop everything a gesture in progress was holding.
	 *
	 * The note surface resets the same way on a file switch and on unmount
	 * (InkOverlay.resetGestureState), for the same reason: a pane is REUSED,
	 * so whatever survives the switch is inherited by the next document.
	 *
	 * `idle` is computed from the builder, the erase flag and the drag, and
	 * the reload poll skips a pane that is not idle. A gesture left half-open
	 * here therefore stops that pane receiving another device's ink at all -
	 * silently, and for as long as the view lives.
	 */
	private resetGestureState(): void {
		this.builder = null;
		this.frame = null;
		this.wetFrom = null;
		this.wetBegun = false;
		this.erasing = false;
		this.eraseFrom = null;
		this.dragFrom = null;
		this.dragTotal = { dx: 0, dy: 0 };
		this.strokePageNumber = 0;
		// The gestures that arrived after this list was written, or a switch
		// mid-shove inherits them: pan scrolling the wrong document, a space
		// divider holding ids the new document has never heard of, a lasso
		// loop finishing around strokes that are gone.
		this.panLast = null;
		this.spaceLineY = null;
		this.spaceIds = [];
		this.spaceTotalDy = 0;
		this.lassoPts = [];
		this.mouseStroke = false;
		this.predReal = [];
		this.predLastTail = [];
		// Also the frame ticker: left running, its rAF loop re-arms itself
		// once per display frame for the LIFE OF THE PANE, measuring nothing.
		this.endMetrics();
		this.clearSelection();
	}

	/** Repaint every live page: the ink changed underneath us. */
	refresh(): void {
		for (const a of this.overlays.values()) a.paintedCount = -1;
		this.schedule();
	}

	/**
	 * Is it safe to swap this document's ink out from under the view?
	 *
	 * False mid-gesture only. A stroke in progress would be committed against
	 * a list that changed underneath it, and a drag moves strokes the reload
	 * is replacing.
	 *
	 * A mere SELECTION does not block it, though an earlier version said it
	 * did. Selections are held by stroke id, and ids survive a reload - so a
	 * selection still resolves afterwards, and anything genuinely deleted
	 * elsewhere simply stops matching. Blocking on it meant a document
	 * stopped syncing for as long as ink sat selected, which is a stall with
	 * no symptom: the other device's ink just never arrives.
	 */
	get idle(): boolean {
		// Everything that would be torn mid-air by the store swapping strokes
		// underneath it. Pan is deliberately absent: it only scrolls the
		// viewer, so a sync landing mid-pan costs nothing and pan can be held
		// for a long time.
		return (
			this.builder === null &&
			!this.erasing &&
			!this.dragFrom &&
			this.lassoPts.length === 0 &&
			this.spaceLineY === null
		);
	}

	/** Diagnostics: how many page overlays are currently attached. */
	get attachedCount(): number {
		return this.overlays.size;
	}

	/** Diagnostics: overlays we still believe in that left the document. */
	get orphanCount(): number {
		let count = 0;
		for (const a of this.overlays.values()) if (!a.canvas.isConnected) count++;
		return count;
	}

	/**
	 * Diagnostics: what the last sync actually decided, per page.
	 *
	 * "The marks did not appear" has several possible causes that look
	 * identical on screen - the page never went live, it went live and we
	 * asked for no strokes, or we painted and something covered it - and this
	 * separates them without another build.
	 */
	/**
	 * Every term of one pointer-to-page conversion, and the round trip back
	 * through the OVERLAY's real screen rectangle. The delta on the last line
	 * is the offset the person is seeing, decomposed: if it is zero here and
	 * visible on screen, the drawing is elsewhere than the overlay; if it is
	 * nonzero, one of these numbers names the term that put it there.
	 */
	private recordDown(
		ev: PointerEvent | undefined,
		sample: PenSample,
		box: PageBox,
		scale: number,
		scroller: HTMLElement,
		content: { x: number; y: number }
	): void {
		// A diagnostic must never take the gesture down with it: the test
		// harness has no layout, and a real pane can be mid-teardown.
		try {
			this.recordDownUnsafe(ev, sample, box, scale, scroller, content);
		} catch {
			this.lastDownDebug = "  (unreadable this time)";
		}
	}

	private recordDownUnsafe(
		ev: PointerEvent | undefined,
		sample: PenSample,
		box: PageBox,
		scale: number,
		scroller: HTMLElement,
		content: { x: number; y: number }
	): void {
		const r = (v: number): string => v.toFixed(2);
		const p = toPagePoint(box, scale, content.x, content.y);
		const rect = scroller.getBoundingClientRect();
		const overlay = this.overlays.get(box.pageNumber)?.canvas.getBoundingClientRect() ?? null;
		const lines = [
			`  client (${ev ? r(ev.clientX) : "?"}, ${ev ? r(ev.clientY) : "?"})  type ${ev?.pointerType ?? "?"}`,
			`  sample (${r(sample.x)}, ${r(sample.y)})  scroller rect (${r(rect.left)}, ${r(rect.top)})` +
				`  scroll (${r(scroller.scrollLeft)}, ${r(scroller.scrollTop)})`,
			`  content (${r(content.x)}, ${r(content.y)})  box page ${box.pageNumber}` +
				` at (${r(box.leftPx)}, ${r(box.topPx)}) size ${r(box.widthPx)}x${r(box.heightPx)}`,
			`  scale ${scale.toFixed(6)} (viewer says ${this.probe()?.scaleFactor?.toFixed(6) ?? "?"})` +
				`  page point (${p ? r(p.x) : "?"}, ${p ? r(p.y) : "?"})`,
		];
		if (overlay && p) {
			// Where the ink will actually be painted, measured off the live
			// overlay element rather than believed from the box numbers.
			const sx = overlay.left + p.x * (overlay.width / box.widthPx) * scale;
			const sy = overlay.top + p.y * (overlay.height / box.heightPx) * scale;
			lines.push(
				`  overlay rect (${r(overlay.left)}, ${r(overlay.top)}) size ${r(overlay.width)}x${r(overlay.height)}`,
				`  ink lands at client (${r(sx)}, ${r(sy)})` +
					(ev ? `  DELTA (${r(sx - ev.clientX)}, ${r(sy - ev.clientY)})` : "")
			);
		} else {
			lines.push(`  overlay: ${overlay ? "present" : "NOT ATTACHED YET"}  page point: ${p ? "ok" : "null"}`);
		}
		this.lastDownDebug = lines.join("\n");
	}

	describe(): string {
		// Uncached: a diagnostic that reports a cached reading is reporting on
		// itself.
		const probed = probeViewer(this.root, this.win);
		if (!probed) return "  controller: viewer not recognized";
		const live = probed.pages.filter((p) => p.hasCanvas).map((p) => p.pageNumber);
		const attached = [...this.overlays.keys()].sort((a, b) => a - b);
		const asked = probed.pages
			.filter((p) => this.strokes(p.pageNumber).length > 0)
			.map((p) => p.pageNumber);
		return [
			`  document id: ${this.documentId() ?? "(not identified yet - strokes are refused)"}`,
			`  viewer probes: ${this.probeReads} read, ${
				this.probeServed + this.probeInStroke
			} avoided (${this.probeInStroke} inside a stroke, ${this.probeServed} from cache)`,
			`  bound element: ${
				this.boundScroller === probed.scroller
					? "current"
					: "STALE - the viewer was replaced, rebinding"
			}`,
			`  live pages (viewer): ${live.join(", ") || "(none)"}`,
			`  pages with strokes to draw: ${asked.join(", ") || "(none)"}`,
			`  overlays attached: ${attached.join(", ") || "(none)"}`,
			`  overlays detached by the viewer: ${this.orphanCount}`,
			`  pages refused as rotated: ${[...this.rotated].join(", ") || "(none)"}`,
			`  palm touches shielded: ${this.palmShield.rejected}`,
			`  pinches bridged: ${this.pinchBridge.bridged}`,
			`  ribbon cache (all surfaces): ${ribbonCacheStats().hits} hit / ${ribbonCacheStats().misses} miss`,
			`  ink metrics (${this.metrics.summaries.length} stroke(s) this session):` +
				(this.metrics.summaries.length > 0
					? "\n" +
						StrokeMetrics.summaryText(this.metrics.summaries[this.metrics.summaries.length - 1]!)
							.split("\n")
							.map((line) => `    ${line}`)
							.join("\n")
					: " (none yet - draw a stroke first)"),
			`  last pen-down:${this.lastDownDebug ? "\n" + this.lastDownDebug : " (none this session)"}`,
		].join("\n");
	}

	// ---- reticle ------------------------------------------------------------

	/**
	 * The hover reticle, in the scroller's own content coordinates.
	 *
	 * NOT `position: fixed`. Fixed resolves against the viewport only while no
	 * ancestor carries a transform; an ancestor that does becomes the
	 * containing block instead and everything shifts by its offset. Obsidian's
	 * panes do, and the reticle sat visibly down and to the right of the nib
	 * while the system cursor under it was correct (hardware, 2026-08-29).
	 *
	 * Content coordinates are what every sample is converted into anyway, so
	 * this shares one convention with the ink rather than inventing a second.
	 *
	 * Size follows the mode, the way it does on a note: the eraser shows what
	 * it is about to take, so its ring is the real nib. A dot that lies about
	 * the eraser's reach is worse than no dot.
	 */
	private showCursor(sample: PenSample, pointerType?: string): void {
		// A hover sample is proof of a pen only when it came from one -
		// audit doc §5k/(d) put the mark ahead of the reticle gate below so
		// turning "Pen reticle" off (or Boox mode, which turns it off for
		// you) would not also stop the pen being noticed, but left it
		// unconditional. This method also draws the dot for an actively
		// drawing mouse (this file's wet-draw loop calls
		// `showCursor(s, "mouse")`) and, via onPenHover, for a mouse that is
		// merely hovering when mouse ink is armed (InlinePenRouter.ts's
		// `mouseActsAsPen` gate lets it reach here) - so a mouse in the
		// room, reticle off, raised the pen toolbar in auto mode for a
		// pointer that was never a pen (1.4.6-design.md 5m/AF5). penDown
		// marks it ahead of its own gates for the same reason as this line
		// meant to, and is unaffected: it fires only on real pen contact.
		if (pointerType === "pen") markPenSeen();
		// Audit doc §5f: the note surface's reticle obeys the "Pen reticle"
		// setting (InkOverlay.ts's own `penReticleOn`, gated at its
		// showPenCursor); this surface consulted nothing, so turning the
		// setting off - or Boox mode, whose description promises the reticle
		// off because "every redraw costs on e-ink" - left the dot repainting
		// under the pen on every PDF. Same flag, checked before any paint AND
		// before the watchdog timer below is armed: an invisible dot that
		// still costs a timer per move defeats the e-ink point as much as a
		// visible one would.
		if (!penReticleEnabled()) return;
		const probed = this.probe();
		if (!probed || probed.scaleFactor === null) return;
		this.ensureTools();
		// Re-created whenever it is not in the CURRENT scroller. It lives in
		// that scroller's subtree, so a viewer rebuild took it away and left
		// this field holding a detached div - and because the old test was
		// "is the field null", the reticle then never came back in that pane
		// for the rest of the session. pdf.js rebuilds its viewer often
		// enough that this is an ordinary Tuesday, not an edge case.
		if (this.cursorEl?.parentElement !== probed.scroller) {
			this.cursorEl?.remove();
			if (this.win.getComputedStyle(probed.scroller).position === "static") {
				probed.scroller.setCssStyles({ position: "relative" });
			}
			this.cursorEl = probed.scroller.createDiv({ cls: "handwriting-pdf-cursor" });
			this.cursorEl.setAttribute("aria-hidden", "true");
			// One disposer for the life of the controller, not one per
			// rebuild: it cleans up whatever the current element and scroller
			// are, so re-creating cannot pile up closures over dead ones.
			if (!this.cursorDisposed) {
				this.cursorDisposed = true;
				this.disposers.push(() => {
					this.cursorEl?.remove();
					this.cursorEl = null;
					this.boundScroller?.classList.remove("handwriting-pdf-hover");
				});
			}
		}
		const content = this.toContent(sample, probed.scroller);
		const cx = content.x;
		const cy = content.y;
		const mode = tipMode();
		// The nib dot is the SIZE OF THE INK it will lay down, not a fixed
		// blob: page units are css px at scale 1, so the nib's on-screen width
		// is its width times the scale. A dot that is the same size whatever
		// the pen is set to tells you nothing about what you are about to draw.
		const tool = getInlineTool();
		const nib =
			(pdfPenWidth(
				tool === "highlighter" ? HIGHLIGHTER_PEN.baseWidth : DEFAULT_PEN.baseWidth,
				getInkSizeMult(tool),
				probed.scaleFactor
			) *
				probed.scaleFactor) /
			2;
		const r = mode === "eraser" ? getEraserRadiusPx() : Math.max(1.5, nib);
		this.cursorEl.classList.toggle("handwriting-pdf-cursor-ring", mode !== "nib");
		// A pen's hand covers the dot, so the dot alone is enough. A mouse
		// HAS no hand: at small nib sizes the ink-true dot is a four-pixel
		// speck and it is the only pointer on screen, so it gets a locator
		// ring of fixed size - obviously not the ink width, because it never
		// changes when the ink width does.
		this.cursorEl.classList.toggle("handwriting-pdf-cursor-mouse", pointerType === "mouse");
		// Dimmed while there is no id: the pen is about to refuse, and the
		// reticle is the only thing on screen that can say so.
		this.cursorEl.classList.toggle("handwriting-pdf-cursor-waiting", !this.documentId());
		this.cursorEl.setCssStyles({
			display: "block",
			width: `${r * 2}px`,
			height: `${r * 2}px`,
			transform: `translate(${cx - r}px, ${cy - r}px)`,
			backgroundColor: mode === "nib" ? getInkColorHex(tool) : "transparent",
		});
		// The system cursor is drawn too, and two dots near each other read as
		// one being wrong. The note surface hides it the same way while a pen
		// is near; the class comes off when the pen leaves, not at contact.
		probed.scroller.classList.add("handwriting-pdf-hover");
		// A pen that leaves hover range without sending pointerleave would
		// otherwise strand the reticle on screen; see the note surface, which
		// learned this the same way.
		//
		// A MOUSE cannot leave hover range - it is either over the pane or it
		// has sent pointerleave - so the watchdog has nothing to protect
		// against there, and firing it just took the pointer away from anyone
		// who paused for a second before drawing.
		if (this.cursorTimer !== null) this.win.clearTimeout(this.cursorTimer);
		this.cursorTimer =
			pointerType === "mouse" ? null : this.win.setTimeout(() => this.hideCursor(), 1000);
	}

	private hideCursor(): void {
		if (this.cursorTimer !== null) {
			this.win.clearTimeout(this.cursorTimer);
			this.cursorTimer = null;
		}
		this.cursorEl?.setCssStyles({ display: "none" });
		const probed = this.probe();
		probed?.scroller.classList.remove("handwriting-pdf-hover");
	}

	// ---- pen ----------------------------------------------------------------

	/**
	 * Scroller-relative sample to scroller-CONTENT coordinates.
	 *
	 * The router measures against the scroller's client box; page boxes are
	 * measured in its content box. The scroll offset is the whole difference,
	 * and forgetting it puts every stroke on page 1.
	 */
	private toContent(sample: PenSample, scroller: HTMLElement): { x: number; y: number } {
		return { x: sample.x + scroller.scrollLeft, y: sample.y + scroller.scrollTop };
	}

	/**
	 * Bind the stroke to one page, once, and freeze the geometry it will use.
	 *
	 * Read once here and never again during the stroke: re-reading per sample
	 * would let a scroll or a zoom mid-stroke change the conversion halfway
	 * through and shear the line. The note surface freezes its camera at
	 * pen-down for exactly this reason.
	 */
	private penDown(sample: PenSample, ev?: PointerEvent): void {
		// A pen on the glass is proof of a pen, and on much hardware it is the
		// ONLY proof: an Apple Pencil without hover support never fires
		// onPenHover, so a strip built only from the hover path was never built
		// at all and the toolbar simply did not exist (hardware, ipad,
		// 2026-08-29). Ahead of the id gate, because a pen that cannot draw yet
		// still wants its tools - and the dimmed reticle explains the refusal.
		markPenSeen();
		// A pen on a viewer whose markup we do not recognise inks nothing, and
		// until now said nothing: from the outside that is indistinguishable
		// from the plugin being broken. It happens to a pane Obsidian has not
		// finished building - a tab restored but never opened - so the advice
		// is real rather than an apology.
		if (!this.probe()) {
			if (!this.warnedNoViewer) {
				this.warnedNoViewer = true;
				this.notify(
					"Handwriting: this PDF pane is not ready for ink - click the page once, or reopen the file."
				);
			}
			return;
		}
		this.warnedNoViewer = false;
		this.ensureTools();
		// Nothing starts before the document has been identified. Drawing
		// anyway means wet ink appears under the nib and then vanishes at
		// pen-up when there is no id to store it under - a stroke silently
		// lost, which is worse than a stroke that never began.
		//
		// SAYING SO is the other half. Refusing in silence is indistinguishable
		// from a broken plugin: notes drew, PDFs did not, and nothing on screen
		// said why (hardware, 2026-08-29). The wait is short, so the notice is
		// said once and then the reticle carries it.
		if (!this.documentId()) {
			if (!this.warnedNoId) {
				this.warnedNoId = true;
				this.notify("Handwriting: still identifying this PDF, ink starts in a moment");
			}
			return;
		}
		this.warnedNoId = false;
		const probed = this.probe();
		if (!probed || probed.scaleFactor === null) return;
		const scroller = probed.scroller;
		const boxes: PageBox[] = probed.pages.map((p) => ({
			pageNumber: p.pageNumber,
			leftPx: p.leftPx,
			topPx: p.topPx,
			widthPx: p.widthPx,
			heightPx: p.heightPx,
		}));
		const content = this.toContent(sample, scroller);
		const box = pageAt(boxes, content.x, content.y);
		if (!box || this.rotated.has(box.pageNumber)) return;
		// A gesture is starting, whichever one: the strip steps aside and its
		// drop-down chrome closes, the same as a note (StripPenChrome.ts,
		// §5o) - this surface never called either half of that before.
		stripPenDown(this.tools);
		// And the keyboard comes with it: the router cancelled the mousedown
		// that would have focused this pane, and Delete/Escape/undo here are a
		// keydown listener on this root rather than commands, so without this
		// the key went wherever focus already was (StripPenChrome.ts). Placed
		// with the strip chrome, after every early return that can refuse the
		// gesture: a pen on a pane with no viewer, no id or no page under the
		// sample has not acted on anything, and taking the keyboard away from
		// wherever it was would be a theft that bought nothing.
		stripPenFocus(this.root);
		// Frozen for the stroke, as it always was - but frozen from the box
		// rather than from the viewer variable that lags behind it.
		const scale = this.scaleFor(box, probed.scaleFactor);
		this.frame = { boxes, scale, scroller };
		this.recordDown(ev, sample, box, scale, scroller, content);
		this.strokePageNumber = box.pageNumber;
		// The one wet/head pair moves onto this page before any branch below
		// can draw on it: the lasso's loop and the space divider both return
		// early and both live on the wet layer (§5h/H1).
		const strokePageEl = this.pageElement(scroller, box.pageNumber);
		if (strokePageEl) this.attachPair(strokePageEl, box.pageNumber);
		this.mouseStroke = ev?.pointerType === "mouse";
		// Under a pen the dot comes off at contact: the hand is at the nib
		// and a dot under it reads as a smudge. Under a mouse the dot IS the
		// nib, so it stays on and follows the ink instead.
		if (!this.mouseStroke) this.hideCursor();
		// Decided once, at contact: reading this per sample would let a
		// mid-gesture toggle turn half a stroke into an erase.
		//
		// The pen's own eraser end counts as well as the mode. A pen turned
		// over is an unambiguous statement of intent and should not need the
		// toolbar to agree with it first - the same test the note surface uses.
		const eraserEnd = ev ? (ev.buttons & 32) !== 0 || ev.button === 5 : false;
		this.erasing = eraserEnd || tipMode() === "eraser";
		// The side button lassos here exactly as it does on a note. Only the
		// toolbar mode was checked, so holding the button over a pdf did nothing
		// at all - the one way into the lasso that needs no toolbar was missing
		// from the surface where the toolbar is hardest to reach (hardware,
		// 2026-08-29).
		const sideHeld = ev ? (ev.buttons & 2) !== 0 : false;
		if (!this.erasing && (sideHeld || tipMode() === "lasso")) {
			this.lassoDown(box, scale, sample, probed.scroller);
			return;
		}
		// Pan and space, before anything inks. Both buttons are on this
		// surface's strip and both modes silently DREW here - a control that
		// looks alive and does the wrong thing is worse than one that is
		// missing (alan, 2026-08-30). Pan drags the viewer's own scroller;
		// space is refused with the reason, because a pdf page cannot grow.
		if (!this.erasing && tipMode() === "pan") {
			this.panLast = { x: sample.x, y: sample.y };
			return;
		}
		if (!this.erasing && tipMode() === "space") {
			// The page cannot grow, but the ink can make room: everything in
			// the rows below the divider follows the pen, the same gesture -
			// and the same pure membership rule - the note surface uses.
			// Page-scoped: a divider on page 3 is a statement about page 3.
			const p = toPagePoint(box, scale, content.x, content.y);
			if (!p) return;
			const here = this.strokes(box.pageNumber);
			this.spaceIds = strokeIdsBelow(here, p.y);
			if (this.spaceIds.length === 0) {
				// A gesture that moves nothing is indistinguishable from a
				// broken one; the note surface paid hardware time to learn it.
				this.notify("Handwriting: no ink below the line");
				return;
			}
			// Snapped out of any row the line was drawn through, and DRAWN
			// where it snapped: the seam shown is the seam that will cut.
			this.spaceLineY = snapLine(rowsOf(here), p.y);
			this.spaceLastY = p.y;
			this.spaceTotalDy = 0;
			this.drawSpaceLine(box);
			return;
		}
		// Any other contact puts a selection away. Leaving it live while ink
		// is drawn over it is how a later drag moves something the user had
		// forgotten was picked up.
		this.clearSelection();
		if (this.erasing) {
			this.eraseFrom = [...this.opList(box.pageNumber)];
			this.metrics.begin("pdf-erase", performance.now());
			this.metricsLive = true;
			this.startFrameTicker();
			this.eraseAt(box, scale, sample, probed.scroller);
			return;
		}
		const tool = getInlineTool();
		this.strokeStyle = {
			...(tool === "highlighter" ? HIGHLIGHTER_PEN : DEFAULT_PEN),
			color: getInkColorHex(tool),
			// Divided by the page scale, because widths here are stored in PAGE
			// units and the renderer multiplies by that same scale. Undivided, a
			// note's 2.2 landed as 4.1 css px on a page shown at 1.87: pdf ink was
			// close to twice as thick as note ink at a document's ordinary view.
			// The taper is proportional to width, so it ate twice the share of a
			// stroke too - measured at 27% of a short stroke against 14% on a
			// note, which is the end looking clipped. Storing it in page units
			// keeps the ink locked to the page, so it still scales with zoom the
			// way the text does.
			baseWidth: pdfPenWidth(
				tool === "highlighter" ? HIGHLIGHTER_PEN.baseWidth : DEFAULT_PEN.baseWidth,
				getInkSizeMult(tool),
				scale
			),
		};
		this.builder = new StrokeBuilder(tool, this.strokeStyle.color, this.strokeStyle.baseWidth);
		this.predReal = [];
		this.predLastTail = [];
		this.metrics.begin("pdf-ink", performance.now());
		this.metricsLive = true;
		this.startFrameTicker();
		this.wetFrom = null;
		this.wetBegun = false;
		// Read here and not off the wet layer: the pair is shared between the
		// pen and the highlighter, so only the stroke knows which tool it is.
		this.wetFlat = tool === "highlighter";
		// Before the first sample, so a clean page has a canvas to draw on.
		this.ensureOverlay(box.pageNumber);
		const pair = this.wetOn(box.pageNumber);
		if (pair) pair.wet.clear(box.widthPx, box.heightPx);
		this.wetHighlighter = tool === "highlighter";
		this.dressWet(this.overlays.get(box.pageNumber));
		// With its event, so the down sample's delivery is stamped like every
		// other's - without it the summary counted one more acceptance than it
		// had samples and printed dedup -1.
		this.penRaw([sample], ev);
	}

	private penRaw(samples: PenSample[], ev?: PointerEvent): void {
		const frame = this.frame;
		const builder = this.builder;
		if (!frame) return;
		// No probe here. The scroller was frozen with the rest of the geometry
		// at pen-down, and probeViewer reads clientWidth, offsetTop and a rect
		// off EVERY page div - which pdf.js does not virtualise, so a hundred
		// page document meant a hundred forced layout reads per pointer event,
		// at pen rates, for the one thing wanted here: scroll offsets, which
		// are read live off the element.
		const scroller = frame.scroller;
		this.probeInStroke++;
		if (this.panLast !== null) {
			// Content follows the pen: the page moves WITH the hand, so the
			// scroll offsets move against the sample deltas. 1:1 and direct -
			// no glide, no curve - because the pen is literally holding the
			// page. Viewport-relative samples are already scroll-independent.
			const last = { ...this.panLast };
			for (const smp of samples) {
				scroller.scrollLeft -= smp.x - last.x;
				scroller.scrollTop -= smp.y - last.y;
				last.x = smp.x;
				last.y = smp.y;
			}
			this.panLast = last;
			return;
		}
		const box = frame.boxes.find((b) => b.pageNumber === this.strokePageNumber);
		if (!box) return;
		if (this.spaceLineY !== null) {
			const id = this.documentId();
			for (const s of samples) {
				const content = this.toContent(s, scroller);
				const p = toPagePoint(box, frame.scale, content.x, content.y);
				if (!p) continue;
				const dy = p.y - this.spaceLastY;
				if (dy === 0) continue;
				this.spaceLastY = p.y;
				this.spaceTotalDy += dy;
				// The line rides with the pen, leading the ink it pushes.
				this.spaceLineY += dy;
				// Vertical only: the divider is a seam, not a joystick. Applied
				// live and unrecorded, one op into history at release - the
				// lasso drag's shape exactly.
				if (id) {
					this.apply(
						{ type: "move", path: id, strokeIds: this.spaceIds, dx: 0, dy },
						this.strokePageNumber,
						"live"
					);
				}
			}
			this.drawSpaceLine(box);
			return;
		}
		// A lasso runs with no builder and no eraser, so it has to be routed
		// before the guard that requires one of them. Below that guard the
		// whole gesture was unreachable: every sample returned early, so no
		// loop was ever drawn and pen-up closed a one-point polygon that
		// selected nothing.
		if (this.lassoPts.length > 0 || this.dragFrom) {
			for (const s of samples) this.lassoMove(box, frame.scale, s, scroller);
			return;
		}
		if (!builder && !this.erasing) return;
		if (this.erasing) {
			for (const s of samples) this.eraseAt(box, frame.scale, s, scroller);
			return;
		}
		if (!builder) return;
		const t0 = performance.now();
		if (ev) this.metrics.recordEvent("raw", samples.length, t0 - ev.timeStamp, true);
		let accepted = 0;
		for (const s of samples) {
			const content = this.toContent(s, scroller);
			// Converted against the STROKE'S page, whatever page the sample is
			// over now. A descender that runs past the page edge belongs to the
			// letter it came from; see PageMap.strokePage.
			const p = toPagePoint(box, frame.scale, content.x, content.y);
			if (!p) continue;
			const point = builder.add(p.x, p.y, s.pressure, s.timestamp, s.tiltX, s.tiltY);
			// The last REAL reading, for the lift point to inherit. This field was
			// declared and nulled and never once written, so addFinalPoint fell
			// through to its 0.5 default on every stroke: the closing point was
			// laid down at mid pressure however hard you were pressing, and the
			// end pulled thin as the committed stroke replaced the wet one.
			this.wetFrom = { x: p.x, y: p.y, pressure: s.pressure };
			// What prediction extrapolates from. Bounded: the caps only ever
			// look at the last handful, and an unbounded list on a long
			// stroke is a leak nobody notices until a page of writing.
			this.predReal.push({ ...s, x: p.x, y: p.y });
			if (this.predReal.length > 12) this.predReal.shift();
			if (point) {
				this.drawWet(box, point);
				accepted++;
			}
			// The dot rides the newest sample, so a mouse always has a nib.
			if (this.mouseStroke) this.showCursor(s, "mouse");
		}
		// The predicted tail rides on top of the head, from the newest real
		// sample outward. Fed in PAGE units like everything else here: the
		// caps are in css px and the two differ by the page scale, so the
		// samples are converted on the way in and the result converted back.
		if (ev && predictionEnabled()) this.drawPredictedTail(ev, box, frame.scale, scroller);
		const drawEnd = performance.now();
		const newestTs = samples[samples.length - 1]?.timestamp ?? t0;
		this.metrics.recordAccepted(accepted);
		this.metrics.recordDraw(drawEnd - t0, drawEnd - newestTs);
		// age@present: from the newest sample's own stamp to the frame after
		// this handler - the same probe the note surface runs, so the two
		// surfaces' numbers can be laid side by side and mean the same thing.
		if (!this.presentProbePending) {
			this.presentProbePending = true;
			this.win.requestAnimationFrame(() => {
				this.presentProbePending = false;
				const presentAge = performance.now() - newestTs;
				recordPresentAge(presentAge);
				this.metrics.recordPresent(presentAge);
			});
		}
	}

	/**
	 * The disposable guess ahead of the nib.
	 *
	 * Never added to the stroke - `builder.add` has already seen every real
	 * sample by the time this runs, and these points touch nothing but the
	 * head canvas, which is cleared on the next event regardless. A stroke
	 * saved mid-prediction is the stroke that would have been saved without
	 * it.
	 *
	 * Screen space, not page space. `Prediction`'s caps are css px and ms -
	 * "never guess more than 10px ahead" means ten pixels of glass, at any
	 * zoom - so the samples go in multiplied by the page scale and the
	 * result comes back divided by it. The note surface does not have to do
	 * this because its sample space already IS css px.
	 *
	 * Scoring runs first, against the tail drawn last event: the sample that
	 * just arrived is the ground truth for the guess made before it, and once
	 * `predLastTail` is overwritten that comparison is gone.
	 */
	private drawPredictedTail(ev: PointerEvent, box: PageBox, scale: number, scroller: HTMLElement): void {
		const pair = this.wetOn(box.pageNumber);
		const cam = this.cameraFor(box);
		const newest = this.predReal[this.predReal.length - 1];
		if (!pair || !cam || !newest) return;
		const toScreen = (s: PenSample): PenSample => ({ ...s, x: s.x * scale, y: s.y * scale });
		if (this.predLastTail.length > 0) {
			const err = correctionError(this.predLastTail.map(toScreen), toScreen(newest));
			if (err !== undefined) this.metrics.recordCorrection(err);
		}
		// Chromium's predicted samples are scroller-relative css px, like
		// every router sample - and the real samples here have already been
		// converted to page units. Mixing the two origins put the predicted
		// tail wherever the scroll offset happened to be. The conversion the
		// real samples walk (toContent, toPagePoint, then toScreen) collapses
		// for these to one subtraction per axis: page units times `scale` is
		// content px measured from the page box's corner.
		const predicted = (this.router?.predictedSamples(ev) ?? []).map((pr) => ({
			...pr,
			x: pr.x + scroller.scrollLeft - box.leftPx,
			y: pr.y + scroller.scrollTop - box.topPx,
		}));
		// Boox mode's e-ink horizon applies HERE too - writing on pdfs is
		// the headline use, and the caps switch must not be an inline-only
		// courtesy.
		const caps = predictionEinkOn() ? EINK_CAPS : adaptiveCaps(presentLagMs());
		const result = buildTail(
			this.predReal.map(toScreen),
			predicted,
			predicted.length > 0 ? "chromium" : "extrap",
			caps
		);
		this.metrics.setPrediction("on", result.source, caps.maxHorizonMs);
		// Page units for SCORING only - the next event compares in screen
		// space after mapping back through toScreen. The DRAW takes screen
		// px directly: TailRenderer.draw has no camera (drawHead converts
		// for itself; draw does not), so handing it page units painted the
		// tail at 1/scale toward the page corner - the tiny stray dot
		// up-left of every pen contact (alan, 2026-08-31).
		this.predLastTail = result.points.map((s) => ({ ...s, x: s.x / scale, y: s.y / scale }));
		if (result.suppressed || result.points.length === 0) {
			this.metrics.recordTailSuppressed();
			return;
		}
		this.metrics.recordTail(result.points.length, result.horizonMs, result.tipDistPx);
		pair.tail.draw(
			newest.x * scale,
			newest.y * scale,
			result.points,
			this.strokeStyle.color,
			pair.wet.liveWidthPx(cam, this.strokeStyle, newest.pressure)
		);
	}

	/** Feed recordFrame while a gesture is live; see the note surface's twin. */
	private startFrameTicker(): void {
		if (this.frameTicking) return;
		this.frameTicking = true;
		const tick = (ts: number): void => {
			if (!this.frameTicking) return;
			this.metrics.recordFrame(ts);
			this.win.requestAnimationFrame(tick);
		};
		this.win.requestAnimationFrame(tick);
	}

	private stopFrameTicker(): void {
		this.frameTicking = false;
	}

	/** Close the live gesture's measurement, if one is open. */
	private endMetrics(): void {
		this.stopFrameTicker();
		if (!this.metricsLive) return;
		this.metricsLive = false;
		this.metrics.end(performance.now());
	}

	/**
	 * Draw the newest segment onto the page's wet overlay.
	 *
	 * This surface has had a wet canvas of its own since the pen survived the
	 * viewer being rebuilt underneath it. What it still lacks is the note
	 * surface's third layer for the unsmoothed head, which is why the wet
	 * renderer here is left unsmoothed - see where `smooth` is set.
	 */
	/**
	 * The scale a POINTER sample is converted with.
	 *
	 * From the box, exactly as the drawing scale is, and for the same reason:
	 * `--scale-factor` updates on its own schedule while the box is whatever
	 * it is right now, so during a zoom the two disagree. Converting input
	 * with one and drawing with the other put the ink where the pointer USED
	 * to be - an offset that grew with how far the zoom had moved and then
	 * healed itself once the viewer settled and the two agreed again (alan,
	 * on hardware, 2026-08-30).
	 *
	 * The fallback is the viewer's own number, for a page whose size in
	 * points has not been measured yet. That page has never been painted, so
	 * there is nothing better to ask, and it is right whenever the viewer is
	 * settled - which is every moment except the one this exists for.
	 */
	private scaleFor(box: PageBox, fallback: number): number {
		return pointerScale(box.widthPx, this.pageSize.get(box.pageNumber)?.wPt ?? 0, fallback);
	}

	/** The camera a page's ink is drawn with: page units to css px. */
	private cameraFor(box: PageBox): CameraState | null {
		const wPt = this.pageSize.get(box.pageNumber)?.wPt ?? 0;
		if (wPt <= 0) return null;
		return { x: 0, y: 0, zoom: box.widthPx / wPt };
	}

	/**
	 * Redraw the stub between the settled curve and the nib.
	 *
	 * After every appended sample: the wet layer's smoothed tail is always
	 * one segment behind by construction, and this is the piece that reaches
	 * the pen. Cleared and redrawn whole each time - it is a few dozen
	 * pixels, and TailRenderer clears only the last draw's bounding box.
	 */
	private drawHead(pair: WetPair, cam: CameraState): void {
		const head = pair.wet.head();
		pair.tail.clear();
		if (head) {
			pair.tail.drawHead(cam, this.strokeStyle, head.from, head.to, head.pressure);
		}
	}

	/** Extend the live stroke, drawn exactly as it will be once committed. */
	private drawWet(box: PageBox, point: InkPoint): void {
		const pair = this.wetOn(box.pageNumber);
		const cam = this.cameraFor(box);
		if (!pair || !cam) return;
		if (this.wetBegun) {
			pair.wet.appendPoint(cam, this.strokeStyle, point);
		} else {
			// The first accepted sample of the stroke. `appendPoint` used to
			// take it too, which drew nothing (it has no previous point) but
			// also told the renderer nothing: the smoothed-centerline and
			// shaped-width decisions are made here, per stroke, from the
			// TOOL - never from the layer, which is one pair for both tools.
			this.wetBegun = true;
			pair.wet.beginStroke(point, this.strokeStyle, this.wetFlat);
		}
		this.drawHead(pair, cam);
	}

	/**
	 * Erase under the nib, as one operation per contact point.
	 *
	 * Two modes, the same two the note surface has, chosen by the strip's
	 * Stroke | Reticle toggle:
	 *
	 * - **Reticle** (partial): a stroke the circle crosses comes out and its
	 *   surviving pieces go back in, as a single `replace`, so undo restores
	 *   the original rather than the fragments.
	 * - **Stroke** (whole): the whole stroke goes, indices kept so undo puts
	 *   it back at its original depth rather than on top of everything.
	 */
	/**
	 * The list op indices are measured against. See `allStrokes`.
	 *
	 * Falls back to the page list only when the document list is EMPTY, which
	 * is a document with no ink at all - nothing to index, so the fallback is
	 * unreachable in practice. It exists so a harness that supplies only a
	 * page source still behaves as it did.
	 */
	private opList(page: number): readonly InkStroke[] {
		const all = this.allStrokes();
		return all.length > 0 ? all : this.strokes(page);
	}

	private eraseAt(box: PageBox, scale: number, sample: PenSample, scroller: HTMLElement): void {
		const id = this.documentId();
		if (!id) return;
		const content = this.toContent(sample, scroller);
		const p = toPagePoint(box, scale, content.x, content.y);
		if (!p) return;
		// Hit-tested against the PAGE (the nib can only reach what is on it),
		// but indexed against the document. Two different lists on purpose.
		const onPage = [...this.strokes(box.pageNumber)];
		const all = this.opList(box.pageNumber);
		// The radius is screen px; page units are screen px divided by scale,
		// so the nib covers the same physical area at any zoom.
		const r = getEraserRadiusPx() / scale;
		const hitIds = new Set(strokesHitByCircle(onPage, p.x, p.y, r));
		if (hitIds.size === 0) return;
		const removed: InkStroke[] = [];
		const removedAt: number[] = [];
		const inserted: InkStroke[] = [];
		const insertedAt: number[] = [];
		const whole = getEraserWholeStrokes();
		for (const stroke of onPage.filter((s) => hitIds.has(s.id))) {
			const at = all.indexOf(stroke);
			removed.push(stroke);
			removedAt.push(at);
			if (whole) continue; // nothing survives; there are no pieces to put back
			for (const piece of splitStrokeByCircle(stroke, p.x, p.y, r, newStrokeId)) {
				inserted.push({ ...piece, page: box.pageNumber });
				insertedAt.push(at);
			}
		}
		// Applied, not recorded. The gesture's single history entry is built at
		// pen-up from the snapshot taken when it started.
		this.apply(
			{ type: "replace", path: id, removed, removedAt, inserted, insertedAt },
			box.pageNumber,
			"live"
		);
	}

	/** One history entry for a whole erase gesture, or none if nothing went. */
	private recordErase(id: string, page: number): void {
		// Both snapshots are of the DOCUMENT list, or the indices in this op
		// would not name positions applyOp can splice at. See allStrokes.
		const before = this.eraseFrom ?? [];
		const after = this.opList(page);
		const afterIds = new Set(after.map((s) => s.id));
		const beforeIds = new Set(before.map((s) => s.id));
		const removed = before.filter((s) => !afterIds.has(s.id));
		if (removed.length === 0) return;
		const removedAt = removed.map((s) => before.indexOf(s));
		const inserted = after.filter((s) => !beforeIds.has(s.id));
		const insertedAt = inserted.map((s) => after.indexOf(s));
		this.history.record({ type: "replace", path: id, removed, removedAt, inserted, insertedAt });
	}

	// ---- lasso --------------------------------------------------------------

	/** Page-unit point for a sample, or null when it cannot be converted. */
	private pagePoint(box: PageBox, scale: number, sample: PenSample, scroller: HTMLElement) {
		const content = this.toContent(sample, scroller);
		return toPagePoint(box, scale, content.x, content.y);
	}

	/**
	 * A lasso contact either grabs the existing selection or starts a new one.
	 *
	 * Inside the selection's bounds means move it; anywhere else means the
	 * user is drawing a new loop and the old selection is finished with. That
	 * is the note surface's rule, and it is what makes a selection feel like
	 * an object rather than a mode.
	 */
	private lassoDown(box: PageBox, scale: number, sample: PenSample, scroller: HTMLElement): void {
		const p = this.pagePoint(box, scale, sample, scroller);
		if (!p) return;
		const bounds = this.selectionBounds(box.pageNumber);
		// Padded, the way the note surface pads its own grab test. The pad is
		// screen px turned into page units here, so the slack stays the same
		// size on the glass at any zoom.
		if (bounds && pointInBBox(p.x, p.y, padBBox(bounds, SELECTION_GRAB_PAD_PX / scale))) {
			this.dragFrom = { x: p.x, y: p.y };
			this.dragTotal = { dx: 0, dy: 0 };
			return;
		}
		// Through clearSelection, never by assignment: clearing the field here
		// left the old page's chrome on screen, because wiping it is keyed to
		// the page the selection BELONGED to and only clearSelection knows it.
		this.clearSelection();
		this.lassoPts = [{ x: p.x, y: p.y }];
	}

	private lassoMove(box: PageBox, scale: number, sample: PenSample, scroller: HTMLElement): void {
		const p = this.pagePoint(box, scale, sample, scroller);
		if (!p) return;
		if (this.dragFrom) {
			const dx = p.x - this.dragFrom.x;
			const dy = p.y - this.dragFrom.y;
			this.dragFrom = { x: p.x, y: p.y };
			this.dragTotal.dx += dx;
			this.dragTotal.dy += dy;
			const id = this.documentId();
			// Applied without recording: the whole drag becomes ONE move op at
			// pen-up, or a single drag would be dozens of undo steps.
			if (id) {
				this.apply(
					{ type: "move", path: id, strokeIds: this.selected, dx, dy },
					this.selectionPage,
					"live"
				);
			}
			// The outline travels with the ink. Left until pen-up, it would sit
			// where the selection started while the strokes moved out from under
			// it.
			this.drawLasso(box);
			return;
		}
		this.lassoPts.push({ x: p.x, y: p.y });
		this.drawLasso(box);
	}

	/**
	 * Whether a lasso selection is currently held, for the command gate.
	 *
	 * Asked of the bounds, not of the id list. Ids outlive a sidecar reload
	 * (see `idle`), so a selection whose strokes were deleted on another
	 * device is a list of ids that match nothing. Gating on the list offered
	 * the snip and then reported "nothing is selected" - one question,
	 * answered two ways.
	 */
	get hasSelection(): boolean {
		return this.selectionBounds(this.selectionPage) !== null;
	}

	/**
	 * Render the selected region - page and committed ink together - to a
	 * PNG. The selection's bounding box, padded a little, is the crop.
	 *
	 * The page comes off the viewer's own canvas rather than re-rendered:
	 * rendering the PDF is the viewer's job, and observation is this whole
	 * integration's contract. The ink is NOT copied from the overlay,
	 * whose backing store is capped (MAX_OVERLAY_PX) and can be softer
	 * than the viewer's pixels; the strokes are redrawn at the snip's own
	 * scale instead, through the same `drawCommitted` paint() uses.
	 *
	 * A page the viewer has not rendered yet snips as paper white with the
	 * ink on it - honest about what is known, rather than failing.
	 *
	 * Every refusal names its reason. The command is only offered while a
	 * selection is held, so a snip that comes back empty was stopped by
	 * something else - a page that is rotated, a pane with no width - and
	 * "nothing is selected" under a lasso that is plainly on screen sends
	 * the reader lassoing again for the same answer.
	 */
	async snipSelection(): Promise<SnipResult> {
		const page = this.selectionPage;
		const b = this.selectionBounds(page);
		if (!b) return { ok: false, reason: "nothing is selected to snip" };
		const probed = this.probe();
		if (!probed || probed.scaleFactor === null) {
			return { ok: false, reason: "the PDF viewer could not be read" };
		}
		const pageEl = this.pageElement(probed.scroller, page);
		if (!pageEl) return { ok: false, reason: `page ${page} is not in the viewer` };
		const wPx = pageEl.clientWidth;
		const hPx = pageEl.clientHeight;
		if (wPx <= 0 || hPx <= 0) return { ok: false, reason: `page ${page} has no size on screen` };
		// `pageWidthPt` is also where a rotation is noticed - the aspect flips
		// against the cached size - so it runs before the rotation check, and
		// the height comes from the same cache rather than from the box: for
		// a rotated page the box is the WRONG shape, which is the whole point.
		const wPt = this.pageWidthPt(page, wPx, hPx, probed.scaleFactor);
		const size = this.pageSize.get(page);
		if (wPt <= 0 || !size) return { ok: false, reason: `page ${page} has not settled yet` };
		if (this.rotated.has(page)) {
			return { ok: false, reason: `page ${page} is rotated, and ink on a rotated page is not supported` };
		}
		// The viewer's canvas sets the snip's resolution: `k` is its backing
		// pixels per point, and both the crop out of it and the output scale
		// come from the one number. Without a canvas the CSS size at device
		// pixels is the honest fallback.
		const pageCanvas = viewerCanvasOf(pageEl);
		const k = pageCanvas && pageCanvas.width > 0 ? pageCanvas.width / wPt : null;
		const pxPerPt = k ?? (wPx / wPt) * (this.win.devicePixelRatio || 1);
		const vp = snipViewport(b, 8, wPt, size.hPt, pxPerPt, MAX_OVERLAY_PX);
		if (!vp) return { ok: false, reason: "the selection lies off the page" };
		const out = createEl("canvas");
		try {
			out.width = Math.max(1, Math.round((vp.x1 - vp.x0) * vp.scale));
			out.height = Math.max(1, Math.round((vp.y1 - vp.y0) * vp.scale));
			const ctx = out.getContext("2d");
			if (!ctx) return { ok: false, reason: "the image could not be drawn" };
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, out.width, out.height);
			if (pageCanvas && k !== null) {
				ctx.drawImage(
					pageCanvas,
					vp.x0 * k,
					vp.y0 * k,
					(vp.x1 - vp.x0) * k,
					(vp.y1 - vp.y0) * k,
					0,
					0,
					out.width,
					out.height
				);
			}
			ctx.setTransform(1, 0, 0, 1, -vp.x0 * vp.scale, -vp.y0 * vp.scale);
			this.drawCommitted(ctx, { x: 0, y: 0, zoom: vp.scale }, this.strokes(page));
			const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"));
			if (!blob) return { ok: false, reason: "the image could not be encoded" };
			return { ok: true, bytes: new Uint8Array(await blob.arrayBuffer()), pageNumber: page };
		} finally {
			// The backing store is the size of the cap; released now rather
			// than whenever the collector gets to a detached canvas.
			out.width = 0;
			out.height = 0;
		}
	}

	/** The box around everything currently selected, in page units. */
	private selectionBounds(page: number): ReturnType<typeof unionBounds> {
		if (page !== this.selectionPage) return null;
		if (this.selected.length === 0) return null;
		const picked = new Set(this.selected);
		return unionBounds(
			this.strokes(page)
				.filter((s) => picked.has(s.id))
				.map((s) => s.bbox)
		);
	}

	private clearSelection(): void {
		if (this.selected.length === 0 && this.lassoPts.length === 0) return;
		const page = this.selectionPage;
		this.selected = [];
		this.lassoPts = [];
		this.selectionPage = 0;
		const pair = this.wetOn(page);
		const box = this.frameBox(page);
		if (pair && box) pair.wet.clear(box.widthPx, box.heightPx);
	}

	/**
	 * A TOOL change puts a selection away too, not just the next contact.
	 * Design §5o: leaving a lasso outline live after the strip's tool
	 * changed read as "the lasso selector remains" (Alan, device finding
	 * 2026-09-02) - only the next non-lasso pen contact cleared it before.
	 */
	dissolveSelection(): void {
		this.clearSelection();
		this.refreshStrip();
	}

	/**
	 * The divider, dashed across the page at the seam it will cut. On the
	 * wet canvas like the lasso's loop: no stroke is wet during either
	 * gesture, so the layer is free.
	 */
	private drawSpaceLine(box: PageBox): void {
		const pair = this.wetOn(box.pageNumber);
		const cam = this.cameraFor(box);
		if (!pair || !cam || this.spaceLineY === null) return;
		const ctx = pair.wetCanvas.getContext("2d");
		if (!ctx) return;
		ctx.clearRect(0, 0, box.widthPx, box.heightPx);
		ctx.save();
		ctx.strokeStyle = "#4b7bec";
		ctx.lineWidth = 1;
		ctx.setLineDash([6, 4]);
		const y = this.spaceLineY * cam.zoom;
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(box.widthPx, y);
		ctx.stroke();
		ctx.restore();
	}

	/** The loop being drawn, and the box around what it has caught. */
	private drawLasso(box: PageBox): void {
		const pair = this.wetOn(box.pageNumber);
		const cam = this.cameraFor(box);
		if (!pair || !cam) return;
		const ctx = pair.wetCanvas.getContext("2d");
		if (!ctx) return;
		ctx.clearRect(0, 0, box.widthPx, box.heightPx);
		ctx.save();
		ctx.strokeStyle = "#4b7bec";
		ctx.lineWidth = 1;
		// The LOOP is the conditional part, never the box. Gating both on the
		// loop meant the selection outline could never be drawn at all: while
		// the loop is being drawn nothing is selected yet, and by the time
		// something is selected the loop has already been thrown away.
		if (this.lassoPts.length >= 2) {
			ctx.setLineDash([4, 4]);
			ctx.beginPath();
			ctx.moveTo(this.lassoPts[0]!.x * cam.zoom, this.lassoPts[0]!.y * cam.zoom);
			for (const q of this.lassoPts.slice(1)) ctx.lineTo(q.x * cam.zoom, q.y * cam.zoom);
			ctx.stroke();
		}
		const b = this.selectionBounds(box.pageNumber);
		if (b) {
			ctx.setLineDash([2, 3]);
			ctx.strokeRect(b.x * cam.zoom, b.y * cam.zoom, b.width * cam.zoom, b.height * cam.zoom);
		}
		ctx.restore();
	}

	/**
	 * Remove the selected strokes. True when there was something to remove.
	 *
	 * One op, with the original indices, so undo puts them back at the depth
	 * they were at rather than on top of everything drawn since.
	 */
	deleteSelection(): boolean {
		const id = this.documentId();
		const page = this.selectionPage;
		if (!id || this.selected.length === 0) return false;
		const all = this.opList(page);
		const picked = new Set(this.selected);
		const strokes = all.filter((s) => picked.has(s.id));
		if (strokes.length === 0) return false;
		const indices = strokes.map((s) => all.indexOf(s));
		this.emit({ type: "remove", path: id, strokes, indices });
		this.clearSelection();
		this.refreshStrip();
		return true;
	}

	/** Close the loop and keep whatever it caught. */
	private lassoUp(page: number): void {
		const pts = this.lassoPts;
		this.lassoPts = [];
		if (pts.length < 3) return;
		const bounds = polygonBounds(pts);
		this.selected = this.strokes(page)
			.filter((s) => strokeInLasso(s, pts, bounds))
			.map((s) => s.id);
		this.selectionPage = page;
		this.refreshStrip();
		const box = this.frameBox(page);
		if (box) this.drawLasso(box);
	}

	private penUp(ev?: PointerEvent): void {
		this.endMetrics();
		// Whatever the gesture was, it is over: the strip returns, the same
		// as a note (StripPenChrome.ts, §5o). The router funnels pointerup
		// AND pointercancel here (InlinePenRouter.pointerUpOrCancel), and the
		// two manual call sites below also route through this one method, so
		// one call covers every teardown.
		stripPenUp(this.tools);
		if (this.panLast !== null) {
			this.panLast = null;
			return;
		}
		if (this.spaceLineY !== null) {
			const spaceId = this.documentId();
			if (spaceId && this.spaceTotalDy !== 0 && this.spaceIds.length > 0) {
				// Recorded but not re-applied: the moves already landed live.
				this.history.record({
					type: "move",
					path: spaceId,
					strokeIds: this.spaceIds,
					dx: 0,
					dy: this.spaceTotalDy,
				});
			}
			this.spaceLineY = null;
			this.spaceIds = [];
			this.persistLive();
			const spaceBox = this.frameBox(this.strokePageNumber);
			const spacePair = this.wetOn(this.strokePageNumber);
			if (spacePair && spaceBox) spacePair.wet.clear(spaceBox.widthPx, spaceBox.heightPx);
			return;
		}
		// The lift itself. `pointerup` carries a position that never arrives
		// through onPenRaw, so without this the stroke ends at the last
		// SAMPLED point and the tail between there and where the pen actually
		// left the glass is missing - visible as ends being cut off
		// (hardware, 2026-08-29). The note surface closes the same gap.
		if (ev && this.builder && !this.erasing) this.addFinalPoint(ev);
		const builder = this.builder;
		const page = this.strokePageNumber;
		const id = this.documentId();
		this.builder = null;
		this.frame = null;
		this.wetFrom = null;
		this.wetBegun = false;
		const wasErasing = this.erasing;
		this.erasing = false;
		if (this.dragFrom) {
			this.dragFrom = null;
			const { dx, dy } = this.dragTotal;
			// One op for the whole drag, recorded but NOT re-applied: the
			// moves already landed live, sample by sample.
			if (id && (dx !== 0 || dy !== 0) && this.selected.length > 0) {
				this.history.record({ type: "move", path: id, strokeIds: this.selected, dx, dy });
			}
			this.persistLive();
			const box = this.frameBox(page);
			if (box) this.drawLasso(box);
			return;
		}
		if (this.lassoPts.length > 0) {
			this.lassoUp(page);
			return;
		}
		if (wasErasing) {
			if (id && page > 0) this.recordErase(id, page);
			this.eraseFrom = null;
			// The gesture's ops were applied live; this is its one write.
			this.persistLive();
			return;
		}
		if (!builder || page <= 0 || !id) return;
		const stroke = builder.finish();
		// The committed layer takes over now, so the wet trail comes off. Done
		// after `emit` below would leave both drawn for a frame; done here, the
		// repaint that emit triggers puts the committed stroke straight back.
		const attached = this.overlays.get(page);
		const pair = this.wetOn(page);
		const box = this.frameBox(page);
		if (!stroke) {
			if (pair && box) {
				if (predictionEinkOn()) {
					pair.wet.clearStroke(box.widthPx, box.heightPx);
					pair.tail.clear();
				} else {
					pair.wet.clear(box.widthPx, box.heightPx);
					pair.tail.clearAll(box.widthPx, box.heightPx);
				}
			}
			this.undressWet(attached);
			return;
		}
		// The page is the stroke's, from pen-down. Everything downstream - the
		// store, the sidecar, the render filter - keys on this one field.
		this.emit({ type: "add", path: id, strokes: [{ ...stroke, page }] });
		// Committed first, wet second, both in THIS frame. Clearing first left a
		// frame with neither drawn, because emit only schedules the repaint - and
		// the two layers do not agree at the ends: the wet layer applies the start
		// taper only, by design, so the end taper appears for the first time when
		// the committed stroke lands. Wet ink is opaque, so painting under it and
		// then lifting it costs nothing and nobody can see the double paint. The
		// note surface calls this the handoff and has done it this way since
		// v0.13.6; this surface never got it.
		// ...and that is true of pen ink only. Both copies of a highlighter
		// stroke are translucent, so the frame they share composites the wash
		// twice and flashes dark - a fast series of strokes strobes. Taking
		// the wet element out of the composite in the same frame keeps the
		// handoff atomic without the double paint, which is what the note
		// surface does (InkOverlay, drawCommitted).
		if (pair && this.wetHighlighter) pair.wetCanvas.setCssProps({ opacity: "0" });
		this.sync();
		if (pair && box) {
			if (predictionEinkOn()) {
				pair.wet.clearStroke(box.widthPx, box.heightPx);
				pair.tail.clear();
			} else {
				pair.wet.clear(box.widthPx, box.heightPx);
				pair.tail.clearAll(box.widthPx, box.heightPx);
			}
		}
		this.undressWet(attached);
	}

	/**
	 * Dress the wet layer for the tool about to draw on it.
	 *
	 * One canvas serves both tools here, unlike the note surface, which gives
	 * the highlighter a layer pair of its own. So this canvas has to be told
	 * twice over what the committed painter already knows: a highlighter is a
	 * WASH, drawn at HIGHLIGHTER_ALPHA, and it belongs UNDER the ink it marks.
	 * Untold, a highlighter stroke was opaque and above everything while it
	 * was being drawn and dropped to a wash underneath the instant it landed
	 * (alan, on hardware, 2026-08-30).
	 *
	 * The committed canvas is raised rather than the wet one lowered. Both
	 * sit over a page whose own layers this plugin does not control, and
	 * moving ours DOWN is the move that can put ink behind the page; moving
	 * ours up cannot.
	 */
	private dressWet(attached: Attached | undefined): void {
		const alpha = this.wetHighlighter ? String(HIGHLIGHTER_ALPHA) : "1";
		if (this.pair) {
			this.pair.wetCanvas.setCssProps({ opacity: alpha });
			// The head is the same stroke, one segment further on - it wears
			// the same wash or a highlighter's tip runs darker than its trail.
			this.pair.headCanvas.setCssProps({ opacity: alpha });
		}
		// The raise is the COMMITTED canvas's, so it is per page and stays
		// with the overlay; the pair being shared changes nothing about which
		// page's ink has to come up over the wash (§5h/H1).
		attached?.canvas.toggleClass(INK_OVER_CLASS, this.wetHighlighter);
	}

	/**
	 * Back to the resting state, once the stroke is committed and cleared.
	 *
	 * Here rather than at the next pen-down, so the element is honest between
	 * strokes: the lasso draws on this same canvas, and a wash left over from
	 * a highlighter would render its loop at a third of its brightness.
	 */
	private undressWet(attached: Attached | undefined): void {
		this.wetHighlighter = false;
		this.dressWet(attached);
	}

	/**
	 * Add the pen-up position to the stroke in progress.
	 *
	 * Measured the way the router measures: against the scroller, at scale 1,
	 * which is what it was given as its rect element. Doing it here rather
	 * than asking the router for a sample keeps the one coordinate convention
	 * in one place - client px minus the scroller's box, then into content
	 * and page units exactly like every other sample.
	 */
	private addFinalPoint(ev: PointerEvent): void {
		const frame = this.frame;
		const builder = this.builder;
		if (!frame || !builder) return;
		// The stroke's own frozen scroller, like every other sample.
		const scroller = frame.scroller;
		const box = frame.boxes.find((b) => b.pageNumber === this.strokePageNumber);
		if (!box) return;
		const rect = scroller.getBoundingClientRect();
		const content = {
			x: ev.clientX - rect.left + scroller.scrollLeft,
			y: ev.clientY - rect.top + scroller.scrollTop,
		};
		const p = toPagePoint(box, frame.scale, content.x, content.y);
		if (!p) return;
		// Pressure at lift is unreliable - it is often already zero - so the
		// last real reading is carried across rather than tapering the stroke
		// to nothing on a value the hardware reports on the way up.
		const pressure = this.wetFrom?.pressure ?? 0.5;
		const point = builder.add(p.x, p.y, pressure, ev.timeStamp);
		if (point) this.drawWet(box, point);
		// Close the smoothed curve out to the final sample, so the wet stroke
		// reaches the nib before the committed one replaces it.
		const cam = this.cameraFor(box);
		const pair = this.wetOn(box.pageNumber);
		if (cam && pair) pair.wet.finishStroke(cam, this.strokeStyle);
	}

	/**
	 * Apply an op and repaint what it touched.
	 *
	 * `onlyPage` is the gesture hot path. A drag and an erase fire an op per
	 * pointer sample, and a full `refresh` invalidates every attached overlay
	 * - the whole window of canvases the viewer is holding - when the only
	 * page whose ink can have changed is the one under the nib.
	 */
	private apply(op: InkOp, onlyPage?: number, mode: OpMode = "commit"): void {
		this.onOp(op, mode);
		if (mode === "live") this.liveDirty = true;
		if (onlyPage === undefined) this.refresh();
		else this.refreshPage(onlyPage);
	}

	/**
	 * The single write at the end of a live gesture. See OpMode.
	 *
	 * Idempotent and cheap, so every gesture end can call it without first
	 * proving something changed - but it does nothing when no live op ran,
	 * which keeps a gesture that moved nothing from touching the file.
	 */
	private persistLive(): void {
		if (!this.liveDirty) return;
		this.liveDirty = false;
		const id = this.documentId();
		if (id) this.persist(id);
	}

	/**
	 * Mark one page for repaint.
	 *
	 * The freshness check compares stroke COUNTS, which a move does not
	 * change, so the page has to be invalidated explicitly or the drag would
	 * not draw at all.
	 */
	private refreshPage(pageNumber: number): void {
		const attached = this.overlays.get(pageNumber);
		// Invalidate if it is attached, but schedule EITHER WAY: a page with no
		// overlay yet is exactly the page whose first stroke needs the sync that
		// attaches one. Returning early here left that to the next viewer
		// mutation to fix.
		if (attached) attached.paintedCount = -1;
		this.schedule();
	}

	/** Apply an op, remember it for undo, and repaint. */
	/** One undo or redo step, shared by Ctrl+Z and the strip's buttons. */
	private historyStep(redo: boolean): boolean {
		this.clearSelection();
		const op = redo ? this.history.redo() : this.history.undo();
		if (!op) return false;
		this.onOp(op);
		this.refresh();
		this.refreshStrip();
		return true;
	}

	/**
	 * The lassoed strokes into the session clipboard, quietly - shared by
	 * `copySelection` (which notifies) and `cutSelection` (which notifies
	 * with "cut", not "copied", so it cannot call copySelection and would
	 * double-notify if it did).
	 */
	private copyToClipboard(): number {
		const id = this.documentId();
		if (!id || this.selected.length === 0) return 0;
		const chosen = new Set(this.selected);
		const strokes = this.strokes(this.selectionPage).filter((st) => chosen.has(st.id));
		return copyInk(strokes, id);
	}

	/**
	 * The lassoed strokes into the session clipboard - the same clipboard
	 * the note surface uses, under the document id, so pasting back into
	 * this document staggers the copies the way pasting into a note does.
	 */
	copySelection(): void {
		if (!this.identified) {
			this.notifyUnidentified();
			return;
		}
		const n = this.copyToClipboard();
		// Audit doc §5k/AD3: an empty selection said "copied 0 strokes" and
		// left the clipboard alone, so the next paste brought back an older
		// copy and read as this one having gone somewhere. `copyToClipboard`
		// returns before `copyInk` when there is nothing selected, so nothing
		// to undo here - only something to say, in the sentence the note
		// surface's command already says for the same state.
		if (n === 0) {
			this.notify("Handwriting: lasso some ink first");
			return;
		}
		// 1.4.6-design.md 5m/AF6: this said "copied 1 stroke" / "copied N
		// strokes", new prose next to cutSelectionCommand's "cut N
		// stroke(s)" below - the wording the note command already uses.
		// Reused verbatim, not recomposed.
		this.notify(`Handwriting: copied ${n} stroke(s)`);
		this.refreshStrip();
	}

	/**
	 * Delete, said out loud - the command's half of `deleteSelection`, shared
	 * with the strip button so both name the same cause. Returns whether ink
	 * was actually removed (audit doc §5s/AM-A), so a caller that must not
	 * treat a refusal the same as a success - the keydown handler's three-way
	 * split, §5s/AM-B - can tell them apart without re-running the gates
	 * here.
	 *
	 * The id is checked BEFORE the selection, audit doc §5k/AD4: a document
	 * still being hashed has no id, `deleteSelection` returns false for that
	 * reason as readily as for an empty lasso, and "lasso some ink first" told
	 * somebody staring at their own lasso the one thing that was not wrong.
	 *
	 * Notifies on every refusal, unconditionally - the strip button and the
	 * palette/hotkey command both reach this, and pressing either one is
	 * itself the deliberate act (§5s/AM-B). The keydown handler's own
	 * "nothing lassoed" case is filtered out before this is ever called, not
	 * inside it, so that rule lives once, at the one caller that needs it.
	 */
	deleteSelectionCommand(): boolean {
		if (!this.identified) {
			this.notifyUnidentified();
			return false;
		}
		const deleted = this.deleteSelection();
		if (!deleted) this.notify("Handwriting: lasso some ink first");
		return deleted;
	}

	/** Cut, said out loud, in the wording the note command already uses. */
	cutSelectionCommand(): void {
		if (!this.identified) {
			this.notifyUnidentified();
			return;
		}
		const n = this.cutSelection();
		this.notify(n > 0 ? `Handwriting: cut ${n} stroke(s)` : "Handwriting: lasso some ink first");
	}

	/** Has this document been hashed yet? Nothing may touch ink until it has. */
	get identified(): boolean {
		return this.documentId() !== null;
	}

	/**
	 * The wait, in the sentence the PDF commands in main.ts already use for
	 * it. The pen's own refusal (penDown) says "ink starts in a moment"
	 * because drawing resumes by itself; a palette or button action does not
	 * resume by itself, so this is the one that asks for the retry.
	 */
	private notifyUnidentified(): void {
		this.notify("Handwriting: still identifying this PDF - try again in a moment");
	}

	/**
	 * Copy, then delete - the PDF side of InkOverlay.cutSelectedInk. Kept
	 * quiet (no notify of its own, like deleteSelection) so the command in
	 * main.ts owns the "cut N stroke(s)" / "lasso some ink first" wording,
	 * the same text it already uses for the note surface.
	 */
	cutSelection(): number {
		const n = this.copyToClipboard();
		if (n > 0) this.deleteSelection();
		// Its own refresh, audit doc §5k/(b): the strip was only ever correct
		// here because `deleteSelection` refreshes on the way out, so a cut
		// that copied nothing - or any future cut that stops short of the
		// delete - left the trash and paste buttons lit from a selection that
		// is gone.
		this.refreshStrip();
		return n;
	}

	/**
	 * Paste, page-true: pdf strokes carry the page they were copied from and
	 * go back to it. Ink copied from a NOTE has no page and its coordinates
	 * are note pixels besides - placing it would be a guess at both position
	 * and scale - so it is refused with the reason instead of appearing tiny
	 * in a corner nobody chose.
	 */
	pasteFromClipboard(): void {
		const id = this.documentId();
		// Audit doc §5k/AD4: this returned in silence, and the button and the
		// palette entry both offered the paste that reached it. The offer is
		// withdrawn now (canPasteInk and the command's checkCallback both ask
		// for an id), and if one is taken anyway the wait is said rather than
		// swallowed.
		if (!id) {
			this.notifyUnidentified();
			return;
		}
		if (clipboardSize() === 0) return;
		const pasted = pasteInk(id);
		if (pasted.some((st) => st.page === undefined)) {
			this.notify("Handwriting: that ink was copied from a note - paste it on a note.");
			return;
		}
		this.emit({ type: "add", path: id, strokes: pasted });
		this.refresh();
		const n = pasted.length;
		this.notify(n === 1 ? "Handwriting: pasted 1 stroke" : `Handwriting: pasted ${n} strokes`);
	}

	private emit(op: InkOp): void {
		this.apply(op);
		this.history.record(op);
	}

	/** The viewer geometry, re-read only when it can have changed. */
	private probe(): ProbedViewer | null {
		const now = Date.now();
		if (this.probedValid && now - this.probedAt < PROBE_MAX_AGE_MS) {
			this.probeServed++;
			return this.probedCache;
		}
		this.probeReads++;
		this.probedCache = probeViewer(this.root, this.win);
		this.probedAt = now;
		this.probedValid = true;
		return this.probedCache;
	}

	/**
	 * Is this mutation record one of OUR writes inside `this.root`, not the
	 * viewer's?
	 *
	 * Audit doc §5b/D1: the observer's `attributeFilter` includes `class`
	 * and `style`, and this controller writes both on every hover move (the
	 * cursor reticle's transform, the scroller's hover class) - each one
	 * landing back in the same observer it is bound to and invalidating a
	 * probe cache that was still correct. Exact match, not a heuristic: the
	 * target is `this.cursorEl` (everything we ever write on it, including
	 * `style`, is ours); or the target is an Element carrying one of
	 * `OWN_CLASSES` (the overlay canvases, the wet/head canvases, the
	 * cursor div itself - all created by us, so nothing else can carry
	 * those classes); or the record is an `attributes` record on the bound
	 * scroller with `attributeName === "class"` (the hover class we
	 * toggle). The scroller's OWN `style` writes (`position: relative`) are
	 * deliberately excluded - that attribute is not one of ours to own, and
	 * a viewer restyle there must still invalidate.
	 */
	private isOwnMutation(record: MutationRecord): boolean {
		if (record.target === this.cursorEl) return true;
		if (record.target instanceof Element) {
			for (const cls of OWN_CLASSES) {
				if (record.target.classList.contains(cls)) return true;
			}
		}
		if (
			record.type === "attributes" &&
			record.attributeName === "class" &&
			record.target === this.boundScroller
		) {
			return true;
		}
		return false;
	}

	/**
	 * The next read must go to the DOM: something restyled or resized.
	 *
	 * Called from the two observers, which is where a zoom, a re-render or a
	 * page appearing arrives. Scrolling deliberately does NOT invalidate:
	 * page offsets are scroll-independent, and scroll offsets are read live
	 * off the element rather than cached here.
	 */
	private invalidateProbe(): void {
		this.probedValid = false;
	}

	/** Forget every page overlay, removing the canvases we can still reach. */
	private dropOverlays(): void {
		for (const { canvas } of this.overlays.values()) canvas.remove();
		this.overlays.clear();
		// The pair goes with them. Both callers - unmount and a viewer that
		// was rebuilt under us - mean every element we were holding is gone or
		// going, and a renderer bound to an orphaned canvas is not reusable.
		this.dropPair();
	}


	/**
	 * Mutation-driven syncs, throttled to a floor between them.
	 *
	 * A sync re-reads layout off every page div in the document, and pdf.js
	 * does not virtualise those - a hundred-page file has a hundred. During a
	 * pinch it restyles the pages on every frame, so every frame invalidated
	 * the cache, scheduled a sync, and forced a full reflow while the zoom was
	 * trying to animate. Reported from an ipad as the zoom not looking smooth.
	 *
	 * The first mutation still syncs immediately, so a page rendering as you
	 * scroll gets its ink without waiting. Everything arriving inside the floor
	 * collapses into one trailing sync, which is what turns sixty reflows a
	 * second into about eight. The overlays are absolutely positioned at the
	 * page's full size, so they scale WITH the page in the meantime: the ink
	 * goes a little soft during the gesture and sharpens when it settles,
	 * rather than stuttering throughout.
	 */
	private scheduleThrottled(): void {
		const now = Date.now();
		const since = now - this.lastSyncAt;
		if (since >= SYNC_MIN_GAP_MS) {
			this.schedule();
			return;
		}
		if (this.trailingSync !== null) return;
		this.trailingSync = this.win.setTimeout(() => {
			this.trailingSync = null;
			this.schedule();
		}, SYNC_MIN_GAP_MS - since);
	}
	private schedule(): void {
		if (!this.mounted || this.syncQueued) return;
		this.syncQueued = true;
		this.win.requestAnimationFrame(() => {
			this.syncQueued = false;
			this.sync();
		});
	}

	private sync(): void {
		if (!this.mounted) return;
		// Stamped here, not in scheduleThrottled: the floor is between syncs
		// that actually ran, and this is the work being spaced out. Without
		// it `lastSyncAt` stayed 0 forever, every gap measured as "longer
		// ago than the floor", and the throttle passed everything straight
		// through even once it was being called.
		this.lastSyncAt = Date.now();
		const probed = this.probe();
		if (!probed) return;
		// The viewer was rebuilt under us. Rebind the pen before anything else,
		// or this pane never sees another pointer event; and our overlays lived
		// in the subtree that just went, so they are gone whatever we believe.
		if (probed.scroller !== this.boundScroller) {
			// A live gesture cannot survive the rebuild, but its samples are
			// page units and CAN: end it honestly, committing what was drawn,
			// instead of discarding the half-stroke - the same rule the
			// mid-stroke zoom already follows. The store write is DOM-free,
			// so the dying scroller costs it nothing.
			if (this.builder !== null || this.erasing) this.penUp();
			this.dropOverlays();
			this.resetGestureState();
			this.bindTo(probed.scroller);
		}
		if (probed.scaleFactor === null) return;
		const scale = probed.scaleFactor;
		const boxes: PageBox[] = probed.pages.map((p) => ({
			pageNumber: p.pageNumber,
			leftPx: p.leftPx,
			topPx: p.topPx,
			widthPx: p.widthPx,
			heightPx: p.heightPx,
		}));
		const hasCanvas = new Set(probed.pages.filter((p) => p.hasCanvas).map((p) => p.pageNumber));
		const live = livePages(boxes, (n) => hasCanvas.has(n));
		const liveNumbers = new Set(live.map((b) => b.pageNumber));

		// Evict first: a page the viewer let go of should not keep a canvas
		// alive, and doing this before attaching keeps the peak count at the
		// window size rather than the sum of both sets.
		for (const [pageNumber, a] of [...this.overlays]) {
			if (!liveNumbers.has(pageNumber)) {
				a.canvas.remove();
				this.detachPairFrom(pageNumber);
				this.overlays.delete(pageNumber);
			}
		}

		const zoomed = scale !== this.lastScale;
		this.lastScale = scale;
		for (const box of live) {
			const pageEl = this.pageElement(probed.scroller, box.pageNumber);
			if (!pageEl) continue;
			this.paint(pageEl, box, scale, zoomed);
		}
	}

	/**
	 * The page's intrinsic width in points - a property of the DOCUMENT, not
	 * of the zoom, so it is learned once and reused.
	 *
	 * Caching it is what breaks the dependence on a live scale factor: the
	 * first settled reading defines the page, and every later paint measures
	 * only the box. A document whose pages differ in size would need this per
	 * page; the fixture and the overwhelming majority of PDFs do not, and the
	 * report's `stride` line is what would show otherwise.
	 */
	private pageWidthPt(pageNumber: number, wPx: number, hPx: number, scale: number): number {
		const known = this.pageSize.get(pageNumber);
		if (known) {
			// A page whose proportions changed since we measured it has been
			// rotated. Aspect rather than a rotation attribute, because this
			// integration reads the DOM only and the viewer's own markup for
			// rotation is not something we have verified.
			const wasPortrait = known.hPt >= known.wPt;
			const isPortrait = hPx >= wPx;
			if (wasPortrait !== isPortrait) this.rotated.add(pageNumber);
			return known.wPt;
		}
		if (!Number.isFinite(scale) || scale <= 0 || wPx <= 0 || hPx <= 0) return 0;
		const size = { wPt: wPx / scale, hPt: hPx / scale };
		this.pageSize.set(pageNumber, size);
		return size.wPt;
	}

	/** Is this page one we refuse to ink? See `rotated`. */
	isRotated(pageNumber: number): boolean {
		return this.rotated.has(pageNumber);
	}

	/** A live page's measured box, for clearing the wet layer at its size. */
	private frameBox(pageNumber: number): PageBox | null {
		const probed = this.probe();
		const p = probed?.pages.find((x) => x.pageNumber === pageNumber);
		return p
			? {
					pageNumber: p.pageNumber,
					leftPx: p.leftPx,
					topPx: p.topPx,
					widthPx: p.widthPx,
					heightPx: p.heightPx,
				}
			: null;
	}

	/** Is a gesture in progress on this page? */
	private owns(pageNumber: number): boolean {
		return pageNumber === this.strokePageNumber && (this.builder !== null || this.erasing);
	}

	/**
	 * Make sure this page has somewhere to draw, before the first sample.
	 *
	 * A page with no stored ink has no overlay - there was nothing to paint -
	 * so the first stroke on a clean page had nowhere to go and stayed
	 * invisible until pen-up put a stroke in the store and a repaint built the
	 * canvas. It looked like the pen did not work until you had already used
	 * it once (hardware, 2026-08-29).
	 */
	private ensureOverlay(pageNumber: number): void {
		const probed = this.probe();
		if (!probed) return;
		const pageEl = this.pageElement(probed.scroller, pageNumber);
		const box = probed.pages.find((p) => p.pageNumber === pageNumber);
		if (!pageEl || !box || probed.scaleFactor === null) return;
		this.paint(
			pageEl,
			{
				pageNumber: box.pageNumber,
				leftPx: box.leftPx,
				topPx: box.topPx,
				widthPx: box.widthPx,
				heightPx: box.heightPx,
			},
			probed.scaleFactor,
			false
		);
	}

	private pageElement(scroller: HTMLElement, pageNumber: number): HTMLElement | null {
		return scroller.querySelector(`div.page[data-page-number="${pageNumber}"]`);
	}

	/**
	 * The pair, but only while it is parented into this page.
	 *
	 * The same reading the per-page fields gave: a page's wet canvas was
	 * drawable iff that page had an overlay, and only the gesture's page was
	 * ever drawn on. Asking for the wet layer of a page the pair has left
	 * answers nothing, exactly as a blank per-page canvas answered nothing.
	 */
	private wetOn(pageNumber: number): WetPair | null {
		return this.pair !== null && this.wetHostPage === pageNumber ? this.pair : null;
	}

	/**
	 * Backing-store size for a canvas stretched over this page element.
	 *
	 * One law, two callers: the committed canvas in `paint` and the shared
	 * pair in `attachPair`. Both must agree or the wet stroke is drawn at a
	 * different resolution from the committed one that replaces it. The css
	 * size is read from the element, never written into it - see `paint`.
	 */
	private backingFor(
		pageEl: HTMLElement
	): { wPx: number; hPx: number; w: number; h: number; backing: number } | null {
		const wPx = pageEl.clientWidth;
		const hPx = pageEl.clientHeight;
		if (wPx <= 0 || hPx <= 0) return null;
		const dpr = this.win.devicePixelRatio || 1;
		const px = wPx * hPx;
		const backing = px * dpr * dpr <= MAX_OVERLAY_PX ? dpr : Math.sqrt(MAX_OVERLAY_PX / px);
		return {
			wPx,
			hPx,
			w: Math.max(1, Math.round(wPx * backing)),
			h: Math.max(1, Math.round(hPx * backing)),
			backing,
		};
	}

	/**
	 * Put the one pair on the page this gesture is on, sized to it.
	 *
	 * Called at every pen-down, and the parentage is checked against the DOM
	 * rather than against `wetHostPage`: a gesture that never got its pen-up
	 * (pointercancel, a viewer re-render) leaves the pair on the old page, and
	 * bookkeeping that believed otherwise would strand the wet ink there. The
	 * re-append is skipped only when the DOM already says the pair is this
	 * page's last two children - which is the same DOM, not a belief about it.
	 * Skipping it matters: moving a node is a childList mutation on the page
	 * div, which our own observer cannot tell from the viewer's writes, so an
	 * unconditional move would invalidate the probe and schedule a full sync
	 * at the start of every stroke.
	 *
	 * Last two children on purpose. All three canvases share `z-index: 2`
	 * (styles.css), so DOM order is what puts the wet ink above the committed
	 * ink.
	 */
	private attachPair(pageEl: HTMLElement, pageNumber: number): WetPair | null {
		const size = this.backingFor(pageEl);
		if (!size) return this.pair;
		let pair = this.pair;
		if (!pair) {
			const wetCanvas = pageEl.createEl("canvas", { cls: OVERLAY_CLASS });
			wetCanvas.setAttribute("aria-hidden", "true");
			const headCanvas = pageEl.createEl("canvas", { cls: OVERLAY_CLASS });
			headCanvas.setAttribute("aria-hidden", "true");
			const wet = new WetInkRenderer(wetCanvas, false);
			const tail = new TailRenderer(headCanvas);
			// ON, with a known cost this surface has not yet paid off.
			//
			// A smoothed wet layer holds the SETTLED tail only and leaves the
			// head that reaches the nib to the caller, on a layer of its own.
			// The note surface draws that head (TailRenderer); this one never
			// has, so the live stroke sits one sample behind the pointer -
			// about 4ms at pen rates, invisible; a visible trail at mouse
			// rates.
			//
			// Turning smoothing OFF instead was tried (2026-08-30) and
			// reverted the same day: the unsmoothed path draws per-segment
			// strokes whose anti-aliased end caps overlap at every sample,
			// and the stacked edges read as a fuzzy line at zoom. The real
			// fix is porting the head layer; until then the lag is the
			// smaller of the two evils.
			wet.smooth = true;
			// The same shaped width law the committed layer uses. Without it
			// the live stroke is drawn one way and redrawn another at pen-up,
			// and the ends visibly pull back as the taper appears (hardware,
			// 2026-08-29).
			wet.shape = true;
			pair = { wetCanvas, headCanvas, wet, tail };
			this.pair = pair;
		} else if (pair.wetCanvas.parentElement !== pageEl || pageEl.lastElementChild !== pair.headCanvas) {
			pageEl.appendChild(pair.wetCanvas);
			pageEl.appendChild(pair.headCanvas);
		}
		if (pair.wetCanvas.width !== size.w || pair.wetCanvas.height !== size.h) {
			pair.wetCanvas.width = size.w;
			pair.wetCanvas.height = size.h;
			pair.headCanvas.width = size.w;
			pair.headCanvas.height = size.h;
			pair.wet.applyDpr(size.backing);
			pair.tail.applyDpr(size.backing);
		}
		// A different page is a different, blank canvas as far as anything on
		// screen is concerned - that is what a pair per page gave for free.
		// The same page keeps its pixels: the lasso's outline lives on the wet
		// layer between gestures, and grabbing a selection must not blink it
		// off before the first move redraws it.
		if (this.wetHostPage !== pageNumber) {
			pair.wet.clear(size.wPx, size.hPx);
			pair.tail.clearAll(size.wPx, size.hPx);
		}
		this.wetHostPage = pageNumber;
		return pair;
	}

	/**
	 * Take the pair off a page that is going away - an eviction, or an overlay
	 * being rebuilt because the viewer replaced the page's children. The
	 * renderers and their backing stores survive; only the parentage goes, and
	 * the next pen-down re-parents.
	 */
	private detachPairFrom(pageNumber: number): void {
		if (this.wetHostPage !== pageNumber) return;
		this.pair?.wetCanvas.remove();
		this.pair?.headCanvas.remove();
		this.wetHostPage = 0;
	}

	/** Destroy the pair: unmount, or a viewer rebuild that took our subtree. */
	private dropPair(): void {
		this.pair?.wetCanvas.remove();
		this.pair?.headCanvas.remove();
		this.pair = null;
		this.wetHostPage = 0;
	}

	private paint(pageEl: HTMLElement, box: PageBox, scale: number, zoomed: boolean): void {
		const strokes = this.strokes(box.pageNumber);
		let attached = this.overlays.get(box.pageNumber);
		if (strokes.length === 0 && !this.owns(box.pageNumber)) {
			// Nothing to draw: drop the canvas rather than keep an empty one.
			// Unless a gesture is on this page - the FIRST stroke on a clean
			// page has nothing stored yet, and dropping its canvas would leave
			// the wet ink with nowhere to go until pen-up.
			if (attached) {
				attached.canvas.remove();
				this.detachPairFrom(box.pageNumber);
				this.overlays.delete(box.pageNumber);
			}
			return;
		}
		// We are a guest inside someone else's element, and the host rewrites
		// it. On re-render the viewer can replace a page's children - taking
		// our canvas with them - and it can rewrite the page div's style
		// attribute, dropping the `position: relative` that our absolutely
		// positioned overlay resolves against. Either one leaves us believing
		// we are attached while we are detached, or positioned against some
		// ancestor far away. That is why the marks survived one zoom and then
		// went for good (hardware).
		//
		// So neither is assumed once. Both are re-checked every paint: the
		// page is re-positioned if it lost it, and an overlay that is no
		// longer OUR page's child is discarded and rebuilt rather than
		// painted into invisibly.
		if (this.win.getComputedStyle(pageEl).position === "static") {
			pageEl.setCssStyles({ position: "relative" });
		}
		if (attached && attached.canvas.parentElement !== pageEl) {
			attached.canvas.remove();
			this.detachPairFrom(box.pageNumber);
			this.overlays.delete(box.pageNumber);
			attached = undefined;
		}
		if (!attached) {
			const canvas = pageEl.createEl("canvas", { cls: OVERLAY_CLASS });
			canvas.setAttribute("aria-hidden", "true");
			attached = { canvas, paintedScale: 0, paintedCount: -1 };
			this.overlays.set(box.pageNumber, attached);
			// The committed canvas was just appended, so it is on top of a
			// pair that is already on this page - the first stroke on a clean
			// page builds the overlay AFTER the pair went on. All three share
			// one z-index, so putting the pair back last is what keeps the wet
			// ink visible over the committed ink (§5h/H1).
			if (this.wetHostPage === box.pageNumber && this.pair) {
				pageEl.appendChild(this.pair.wetCanvas);
				pageEl.appendChild(this.pair.headCanvas);
			}
		}
		if (!zoomed && attached.paintedScale === scale && attached.paintedCount === strokes.length) {
			return; // already correct; the commonest case while scrolling
		}

		// The overlay's size is read from the box it is filling, NOT written
		// into it. The stylesheet stretches it over the page div; all this
		// does is give the backing store enough pixels for that size. Writing
		// left/top/width/height was three separate bugs in one afternoon,
		// every one of them a number going stale while the viewer re-rendered
		// underneath us.
		const size = this.backingFor(pageEl);
		if (!size) return;
		const { wPx, hPx, w, h, backing } = size;
		const canvas = attached.canvas;
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(backing, 0, 0, backing, 0, 0);
		ctx.clearRect(0, 0, wPx, hPx);
		// The drawing scale comes from the box we are filling divided by the
		// page's size in points - NOT from `--scale-factor` directly. The two
		// agree when the viewer is settled, and during a zoom they do not:
		// the scale factor updates on its own schedule while the box is
		// whatever it is right now. Deriving from the box means the ink always
		// fills the same fraction of the page it is drawn on, settled or not.
		const pageWidthPt = this.pageWidthPt(box.pageNumber, wPx, hPx, scale);
		if (pageWidthPt <= 0) return;
		this.drawCommitted(ctx, { x: 0, y: 0, zoom: wPx / pageWidthPt }, strokes);
		attached.paintedScale = scale;
		attached.paintedCount = strokes.length;
	}

	/**
	 * Committed ink onto a context, in the one order every surface uses:
	 * highlighter washes first and translucent, then the ink over them.
	 * Shared by the overlay and the snip so the picture a reader takes
	 * away is the picture they were looking at.
	 */
	private drawCommitted(ctx: CanvasRenderingContext2D, cam: CameraState, strokes: readonly InkStroke[]): void {
		ctx.globalAlpha = 0.35;
		for (const s of strokes) if (s.tool === "highlighter") drawStroke(ctx, cam, s, undefined, true);
		ctx.globalAlpha = 1;
		for (const s of strokes) if (s.tool !== "highlighter") drawStroke(ctx, cam, s, undefined, true);
	}
}
