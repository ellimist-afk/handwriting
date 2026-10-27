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

import { InkStroke } from "../ink/Stroke";
import { EmptyPageNoticeGate } from "../inline/EmptyPageNotice";
import { Point2 } from "../ink/Smoothing";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { TailRenderer } from "../ink/TailRenderer";
import { PalmShield } from "../input/PalmShield";
import { PinchBridge } from "./PinchBridge";
import { StrokeMetrics } from "../ink/StrokeMetrics";
import { PdfPageAssumption } from "../ink/InkPdf";
import { DEFAULT_PEN, PenStyle } from "../ink/PenStyle";
import {
	peelInkEscapeFloor,
} from "../inline/InkOverlay";
import { InlinePenRouter } from "../inline/InlinePenRouter";
import { PenSample } from "../input/PointerRouter";
import { InkOp } from "../inline/InkHistory";
import { MobileTools } from "../inline/MobileTools";
import { PdfInkHistory } from "./PdfInkHistory";
import { PAN_EDGE_CLEAR, type PanEdgeLatch } from "./PanScroll";
import { recordPdfScrollEvent } from "./PdfPanTrace";
import { PageBox, toPagePoint } from "./PageMap";
import {
	Band,
	PageBandBox,
	ScrollerSize,
} from "./PageBand";
import { findScaleFactor, ProbedViewer } from "./PdfViewerProbe";
import { installPdfCursors } from "./PdfInkCursors";
import { installPdfSelection } from "./PdfInkSelection";
import { installPdfTools } from "./PdfInkTools";
import { installPdfTrace } from "./PdfInkTrace";
import { installPdfBand, OVERLAY_CLASS } from "./PdfInkBand";
import { installPdfInkBind } from "./PdfInkBind";
import { installPdfInkPenPath } from "./PdfInkPenPath";
import { installPdfInkCommit } from "./PdfInkCommit";

/**
 * Which strokes an undo's `remove` actually took, keyed by the op's stroke
 * list (the redo hands back the same list). The redo's `add` puts back
 * only those: a stroke the undo did not find was erased since, by another
 * device whose file the sync poll adopted or by another pane, and laying it
 * back would undo that erase. The note surface keeps the same map in
 * InkOverlay.applyInkOp.
 */
export const removedByHistory = new WeakMap<readonly InkStroke[], ReadonlySet<string>>();

/** Put on the COMMITTED canvas while a highlighter is wet. See `dressWet`. */
export const INK_OVER_CLASS = "handwriting-pdf-ink-over";
/**
 * Classes that mark an element as ours, for `isOwnMutation`. Audit doc
 * §5b/D1: the root's own MutationObserver watched everything under it,
 * including the writes this controller makes to its own reticle and hover
 * class, so a hovering pen defeated its own probe cache every time it moved.
 */
export const OWN_CLASSES = [OVERLAY_CLASS, INK_OVER_CLASS, "handwriting-pdf-cursor", "handwriting-pdf-cursor-viewport"];
export const OWN_TOOLBAR_SELECTOR = ".handwriting-mobile-tools, .handwriting-pen-pill";

// ---- pdf trace --------------------------------------------------------------
//
// The bug-report recorder's timeline (`tr()` in InlinePenRouter.ts) had zero
// lines from this surface: every pdf bug report to date showed only the
// router's view of the pointer stream, never what this controller did with
// it. Two investigations stalled on that blindness on 2026-09-04 - a mouse
// eraser ring that reportedly freezes while erasing continues, and palm/pinch
// reports with only a point-in-time snapshot (`describe()`) to go on. These
// lines go through `traceSurface`, into the SAME ring, so a report merges
// both surfaces into one time-ordered read.
//
// THE CALL-SITE RULE applies here exactly as it does in the router: every
// site below reads `diagnosticsEnabled()` ONCE per call (`penDown`/`penRaw`/
// `penUp` each compute it into a local) and every string, `describeEl` call
// or reticle read happens only behind that boolean. Off, the added cost is
// one boolean read per pointer event plus one integer increment per raw
// batch - nothing heavier.

/**
 * Why `showCursor` (or one of its thin per-mode wrappers) did or did not
 * repaint the reticle. Diagnostic only - every real caller already ignored
 * the return value when it was `void`, and still does; this is read back
 * only by the trace sites below.
 */
export type ReticleOutcome =
	| "wrote"
	| "off"
	| "no-probe"
	| "no-scale"
	| "no-cursor-el"
	| "pan-drag"
	| "hand-on-glass";

/** Per-gesture trace bookkeeping. Reset at the top of every `penDown`. */
interface PdfTraceGestureState {
	/** Every `penRaw` call this gesture, traced or not. */
	batchIndex: number;
	/** The batch index the rate limit last actually emitted, 0 if none yet. */
	lastEmittedIndex: number;
	/** The note the rate limit would have printed for the current batch. */
	lastNote: string;
	/** The event that came with the current batch, for the forced pen-up line. */
	lastEv: PointerEvent | null;
	/** How many erase/draw batches this gesture asked the reticle for anything. */
	reticleAttempts: number;
	/** Outcome -> count, across this gesture's erase/draw batches. */
	reticleOutcomeCounts: Record<string, number>;
}

export function freshPdfTraceState(): PdfTraceGestureState {
	return {
		batchIndex: 0,
		lastEmittedIndex: 0,
		lastNote: "",
		lastEv: null,
		reticleAttempts: 0,
		reticleOutcomeCounts: {},
	};
}

/**
 * Is this event aimed at somewhere the user is typing?
 *
 * Duck-typed rather than `instanceof`: a popout window's elements belong to
 * another realm, where `instanceof HTMLInputElement` is false for a real
 * input.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
	const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
	if (!el || typeof el.tagName !== "string") return false;
	const tag = el.tagName.toLowerCase();
	return tag === "input" || tag === "textarea" || el.isContentEditable === true;
}

/**
 * The geometry a gesture froze at pen-down: every live page's box, the scale
 * they were measured at, and the scroller they belong to. Named because
 * `penUp` now hands it to `addFinalPoint` rather than leaving it on the field
 * for it to read - the field is released above the mode branches, so nothing
 * below that line may still believe it is there.
 */
export type PenFrame = { boxes: PageBox[]; scale: number; scroller: HTMLElement };

/** A snip: the PNG and the page it left, or the reason there is none. */
export type SnipResult =
	| { ok: true; bytes: Uint8Array; pageNumber: number }
	| { ok: false; reason: string };

/**
 * The page scale at which a pdf nib weighs exactly its note width, in css px
 * per page point. pdf.js calls this zoom "150%".
 *
 * A REFERENCE, never the live scale, and that distinction is the whole of the
 * fix below: the stored width is divided by this fixed number once, so it is a
 * constant in page points and the ink obeys the page rather than the pane.
 * Dividing by the LIVE scale instead made every stroke the same number of css
 * px whatever the zoom - draw at 3x and the line was a third of a nib on the
 * page, invisible again the moment you zoomed back out (alan, hardware,
 * 2026-09-04).
 *
 * 2 is chosen so an ordinary view lands where 2026-08-29 asked it to: a
 * fit-width portrait page in a normal pane measured 1.87 css px/pt on
 * hardware, at which a 2.2 note nib shows as 2.06 css px - within a few
 * percent of note ink. It is the ONE number to turn if pdf ink should be
 * heavier or lighter across the board; nothing else in the width path is a
 * free constant.
 */
export const PDF_NIB_REFERENCE_SCALE = 2;

/**
 * The pen's stored width on this surface, in PAGE units.
 *
 * One function because two call sites have to agree. The stroke stores this,
 * and the hover reticle draws it times the scale, because the dot promises the
 * width of the ink it is about to lay down. They drifted apart the moment the
 * stroke started dividing by the scale and the reticle did not: the dot came
 * out at nearly twice the width of the line (hardware, 2026-08-29).
 *
 * The scale is not an argument any more. Both sites multiply the result by the
 * live scale themselves - the renderer does it for the stroke, `showCursor`
 * for the dot - so a width that came in already divided by that same scale
 * cancelled it out, and the ink stopped belonging to the page. On screen a
 * stroke is now `baseWidth * sizeMult * liveScale / PDF_NIB_REFERENCE_SCALE`:
 * it thickens with the text as you zoom in, and it weighs the same on the page
 * whatever zoom it was drawn at, which is the law the note surface has always
 * had (InkOverlay's activeStyle.baseWidth is never divided by anything).
 */
export function pdfPenWidth(baseWidth: number, sizeMult: number): number {
	return (baseWidth * sizeMult) / PDF_NIB_REFERENCE_SCALE;
}

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

/**
 * How long a viewer probe may be reused when nothing has invalidated it.
 *
 * A backstop, not the mechanism: the observers below invalidate on the things
 * that actually move page geometry. This bounds the damage from a change
 * neither of them sees.
 */
export const PROBE_MAX_AGE_MS = 250;

/** Floor between mutation-driven syncs. See scheduleThrottled. */
export const SYNC_MIN_GAP_MS = 120;

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
 *
 * "live-page" = "live", for a single-page `replace` whose indices are positions
 * in that page's stroke list rather than the document's: the eraser's
 * per-sample op, so its cost follows the page it is on and not the ink on
 * every other page (PdfInkStore.applyLivePage).
 */
export type OpMode = "live" | "live-page" | "commit";

export type OpSink = (op: InkOp, mode?: OpMode) => void;

export interface Attached {
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
	/**
	 * And WHERE it was painted. The band joins the skip test because a band
	 * move changes nothing else: same scale, same stroke count, different
	 * pixels. Without it the scroll that repositions a canvas would leave the
	 * old raster in the new place - the ink visibly sliding by the size of the
	 * move - which is exactly the failure the note surface's `scheduleRepaint`
	 * on a moved band prevents.
	 */
	paintedBand: PageBandBox | null;
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
export interface WetPair {
	wetCanvas: HTMLCanvasElement;
	wet: WetInkRenderer;
	headCanvas: HTMLCanvasElement;
	tail: TailRenderer;
}

export class PdfInkController {
	overlays = new Map<number, Attached>();
	/**
	 * The box every page's canvases are cut from, in the SCROLLER's content
	 * coordinates - one band for the whole document, intersected per page.
	 *
	 * One rather than one-per-page because that is what makes the total honest:
	 * the pages tile the scroller, so the sum of their bands is the band, and
	 * the pixel cost of a hundred-page pdf at 800% is the same as a one-page
	 * pdf at 100%. Null until the first sync measures the scroller.
	 */
	band: Band | null = null;
	/**
	 * Device pixels per css pixel for every canvas the band touches - ONE
	 * number, derived from the band above and not from any page's slice of it.
	 *
	 * It was per page, and that was wrong twice over. A page holding only the
	 * band's top 400px measured 400px, found it fitted the cap with room to
	 * spare and took a full `dpr`, while the page below it measured the whole
	 * 1200 and was divided down: two pages side by side on screen rasterised
	 * at different resolutions, with a visible seam at the join. And the cap
	 * then bounded EACH canvas rather than the band, so N pages in one band
	 * could hold N times the budget - which is the opposite of the claim this
	 * whole change rests on, that the cost of a document is the band's area.
	 *
	 * Zero means "not derived yet". Recomputed when the band moves and when
	 * the display changes underneath us (`bandBackingDpr`), which is the one
	 * input that can change without the band moving at all.
	 */
	bandBackingPx = 0;
	/** The `devicePixelRatio` `bandBackingPx` was derived at. */
	bandBackingDpr = 0;
	/**
	 * The scroller's four size fields, measured at each `sync` and re-used by
	 * every scroll event until the next one. See `ScrollerSize`: these are
	 * layout reads and the scroll listener must not make them. Null until the
	 * first sync, and dropped when the scroller is replaced.
	 */
	scrollerSize: ScrollerSize | null = null;
	/** The scroll listener, kept so add and remove pass the same function. */
	readonly onScroll = (): void => {
		const scroller = this.boundScroller;
		if (!scroller) return;
		// The finger-scroll instrument (PdfPanTrace.ts), and the ONE boolean
		// read it adds to this listener. The pan branch could reuse `penRaw`'s
		// single `diagnosticsEnabled()`; this handler had none to reuse, so it
		// takes its own - which is exactly what THE CALL-SITE RULE
		// (DiagSwitch.ts) asks for and all it asks for. With the switch off
		// that is a boolean read and a `diagOn ? ... : 0` on a local: no clock
		// read, no entry object, no animation frame requested.
		//
		// Named `scrollDiagOn` and not `diagOn`: `PdfPanTrace.test.ts` counts
		// `const diagOn = diagnosticsEnabled();` across this file and holds it
		// at exactly one, which is how it proves the PAN branch added no
		// boolean read of its own. A second identical line here would have
		// broken that assertion by satisfying it somewhere else.
		const scrollDiagOn = diagnosticsEnabled();
		const scrollT0 = scrollDiagOn ? performance.now() : 0;
		// A LIVE PAN RECONCILES ITS CARRIED POSITION HERE, and this is the only
		// place the drag reads the scroller after pen-down (`panLast`).
		//
		// HOW OUR OWN WRITES ARE TOLD FROM THE VIEWER'S: they are not, and they
		// do not need to be. Reading the element answers for BOTH - after a
		// write of ours the offsets already equal the carried value and this
		// stores back what it just read, and after a wheel, a keyboard page or
		// a scrollbar drag it is the correction. A flag set around the write
		// and cleared here would be cheaper by one read and WRONG in one case:
		// scroll events are coalesced to at most one per frame, so a foreign
		// scroll landing in the same frame as one of our writes would be
		// swallowed as ours and the drag would stay offset by it for good.
		//
		// AND IT COSTS NO LAYOUT THAT WAS NOT ALREADY BEING PAID. A pan is not
		// a wet gesture (`wetGestureLive`), so `syncBand` below does not take
		// its early return during one - it reads these same two offsets on
		// every scroll event of every pan already. This read sits immediately
		// before it on the same layout, so the pair is one update between them,
		// and it happens at most once per frame rather than once per move.
		const pan = this.panLast;
		if (pan !== null) {
			pan.scrollX = scroller.scrollLeft;
			pan.scrollY = scroller.scrollTop;
		}
		// The whole hot path. `syncBand` is a `bandNeedsMove` call and nothing
		// else when the viewport is still inside the margin, which is the
		// overwhelming majority of scroll events; only a scroll that has eaten
		// into the margin reaches `schedule`, and only then does anything
		// proportional to the ink on screen run.
		const repaint = this.syncBand(scroller);
		if (repaint) this.schedule();
		// Timed to HERE, past the schedule: `repaint` is the column that tells
		// a cheap scroll event from an expensive one, so the work it stands
		// for belongs inside the number it is printed beside.
		if (scrollDiagOn) {
			recordPdfScrollEvent(
				{ t: scrollT0, handlerMs: performance.now() - scrollT0, repaint },
				this.win
			);
		}
	};
	/**
	 * The one wet/head pair, built on first use and kept for the life of the
	 * controller. Two panes on one pdf are two controllers, so nothing here is
	 * shared across panes.
	 */
	pair: WetPair | null = null;
	/**
	 * The page the pair is parented into right now, 0 when it is nowhere.
	 *
	 * Read by `wetOn`, which is what every wet/head site asks instead of the
	 * per-page overlay it used to ask: a wet operation aimed at a page the
	 * pair is not on is the no-op it always was, because that page used to
	 * have its own blank wet canvas.
	 */
	wetHostPage = 0;
	/**
	 * The band `attachPair` last wrote into the pair's transform, so a pure
	 * translation (same width/height, different origin - a tall page at high
	 * zoom) can be told apart from a genuine resize or a page change. See the
	 * clear condition in `attachPair`: the transform is rewritten on every
	 * attach regardless, but the RASTER already on the pair does not move
	 * with it, so a translation with neither condition true left standing
	 * pixels (today: a lasso outline) to be re-presented displaced by the
	 * band delta the next time anything drew. Null exactly when `pair` is
	 * null or detached, same as `wetHostPage` tracks parentage.
	 */
	pairBand: PageBandBox | null = null;
	/** Whether the stroke on the wet layer right now is a highlighter. */
	wetHighlighter = false;
	/**
	 * A live pan gesture: where the last sample left the HAND, in
	 * scroller-viewport coordinates, and where the last write left the
	 * SCROLLER. Deltas of the samples ARE scroll deltas, which is what makes
	 * this whole mode arithmetic.
	 *
	 * THE SCROLL HALF IS CARRIED RATHER THAN READ, and that is the point of
	 * it. `scroller.scrollLeft -= d` is a read AND a write, and in Blink the
	 * read goes through the same layout update `clientWidth` does (see
	 * `syncBand`'s own comment, and `ScrollerSize` in PageBand.ts). pdf.js
	 * does not virtualise its page divs, so on a heavy document that read is a
	 * forced layout over the whole viewer - two of them per sample, at pointer
	 * rate. Reading once at pen-down and carrying the total from there leaves
	 * the move path with two writes and no read at all. The arithmetic is
	 * `PanScroll.ts`, which is pure and tested; this field is its state.
	 *
	 * THE ONE THING THAT CAN MAKE IT STALE is the viewer scrolling under the
	 * drag by some other means - a wheel, a keyboard page, a programmatic
	 * jump. `onScroll` reconciles it; see the comment there for why that needs
	 * no flag and costs no layout that was not already being paid.
	 */
	panLast: { x: number; y: number; scrollX: number; scrollY: number } | null = null;
	/**
	 * Which axes this drag is currently sitting at the far end of, and so has
	 * already re-measured `scrollerSize` at. Per axis rather than shared, and
	 * cleared at pen-down; `panEdgeContact` (PanScroll.ts) is the rule and the
	 * reasons. Meaningless while `panLast` is null.
	 */
	panEdge: PanEdgeLatch = PAN_EDGE_CLEAR;
	/**
	 * A live insert-space gesture: the divider's y in page units, the ids
	 * frozen at pen-down, and the drag so far. Same shape as the note
	 * surface's, minus the text half - a pdf page cannot grow, but the ink
	 * on it can make room.
	 */
	spaceLineY: number | null = null;
	spaceIds: string[] = [];
	spaceLastY = 0;
	spaceTotalDy = 0;
	/**
	 * True while the live stroke is a MOUSE wearing the pen's hat.
	 *
	 * The reticle keys off this: under a real pen the hand is its own marker
	 * and the dot is hidden at contact, but a mouse has nothing at the nib -
	 * hiding the dot at click handed the system arrow back mid-stroke, which
	 * read as the reticle giving up (alan, 2026-08-30).
	 */
	mouseStroke = false;

	/**
	 * The last pen-down, as every number that went into placing it - kept so
	 * the view report can print the arithmetic instead of someone eyeballing
	 * an offset against a cursor tip. Diagnostic only; never read by code.
	 */
	lastDownDebug: string | null = null;
	disposers: Array<() => void> = [];
	/** Rejects palm-shaped touches before the viewer's pinch can see them. */
	palmShield = new PalmShield();
	/** Re-anchors the viewer's pinch at the fingers; see PinchBridge. */
	pinchBridge = new PinchBridge(
		() => this.idle,
		// One computed-style read off one element: cheap enough per step, and
		// the value the viewer itself lays pages out by.
		() => {
			const page = this.boundScroller?.querySelector("div.page[data-page-number]");
			if (!(page instanceof HTMLElement)) return null;
			return findScaleFactor(page, this.win).value;
		},
		(identifier) => this.palmShield.hasSwallowedContact(identifier)
	);
	/**
	 * This surface's own latency instruments, stamped at the same points the
	 * note surface stamps its own. Latency work here was guesswork before
	 * this existed: the note surface's 25-37ms - measured, hunted to a flag,
	 * cut to ~7ms - happened because the numbers existed to argue with.
	 * Read through the PDF view report.
	 */
	metrics = new StrokeMetrics();
	metricsLive = false;
	frameTicking = false;
	presentProbePending = false;
	/**
	 * Recent REAL samples, newest last: what the predicted tail extrapolates
	 * from. Page units, which is this surface's sample space throughout.
	 */
	predReal: PenSample[] = [];
	/** The tail drawn last event, kept only to score it against what arrived. */
	predLastTail: PenSample[] = [];
	syncQueued = false;
	lastScale = 0;
	/**
	 * The last viewer probe, reused until something moves the page geometry.
	 *
	 * `probeViewer` reads clientWidth, clientHeight, offsetTop, offsetLeft and
	 * a rect off EVERY page div, and pdf.js keeps every page div alive (see
	 * PdfViewerProbe V5) - so on a long document one call is hundreds of
	 * forced layout reads. Hover fires at pen rates, which meant paying that
	 * continuously just for holding the pen over the page.
	 */
	probedCache: ProbedViewer | null = null;
	probedAt = 0;
	probedValid = false;
	lastSyncAt = 0;
	trailingSync: ReturnType<Window["setTimeout"]> | null = null;
	/**
	 * What the probe cache is worth, counted rather than argued.
	 *
	 * `reads` is DOM work actually done. `served` and `inStroke` are calls the
	 * old path would have turned into a full sweep of every page div - served
	 * from the cache, and skipped entirely because a stroke carries its own
	 * frozen geometry.
	 */
	probeReads = 0;
	probeServed = 0;
	probeInStroke = 0;
	/**
	 * The scroller the pen and the resize watch are attached to.
	 *
	 * Kept so the swap can be noticed. See bindTo.
	 */
	boundScroller: HTMLElement | null = null;
	focusBinding: { scroller: HTMLElement; addedTabindex: boolean; priorFocus: HTMLElement | null } | null = null;
	/**
	 * The scroller the cursor classes were last put ON.
	 *
	 * `showCursor` adds them to whatever `probe()` returned AT THE TIME, and
	 * after pdf.js rebuilds its viewer that is not the element a fresh probe
	 * returns. Recording the owner is what lets `hideCursor` take them off
	 * again while calling no `probe()` at all, and that matters because the
	 * hide path runs on EVERY ResizeObserver delivery: `probe()` there is a
	 * full `probeViewer` scan - `clientWidth`, `clientHeight`, `offsetTop`,
	 * `offsetLeft` and a rect off every page div pdf.js keeps alive - taken
	 * synchronously inside the callback, on a long document hundreds of
	 * forced layout reads, and a forced read also flushes pending layout.
	 * Dragging a split divider fires resize continuously.
	 *
	 * Not a substitute for `boundScroller`, which is cleared alongside it:
	 * the two are different elements after a viewer rebuild, and removing a
	 * class an element does not carry is a no-op, so clearing both is safe.
	 */
	cursorScroller: HTMLElement | null = null;
	ro: ResizeObserver | null = null;
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
	pageSize = new Map<number, { wPt: number; hPt: number }>();
	/**
	 * Pages whose aspect changed after we first measured them - a rotation.
	 *
	 * Ink is refused there. Stored coordinates are page-local against an
	 * UNROTATED layout, and there is no way to reinterpret them for a rotated
	 * one without knowing which way it turned and when. Refusing costs a
	 * feature on a rare page; guessing costs the ink.
	 */
	rotated = new Set<number>();
	warnedRotated = new Set<number>();

	/**
	 * Whether the user has already been told this document is still being
	 * identified. One notice per wait, not one per pen contact.
	 */
	warnedNoId = false;
	warnedInkNotReady = false;
	/** Said once per pane: this viewer is not one we know how to ink. */
	warnedNoViewer = false;

	/** The stroke in progress, and the page it was bound to at pen-down. */
	builder: StrokeBuilder | null = null;
	strokePageNumber = 0;
	strokeStyle: PenStyle = { ...DEFAULT_PEN };
	router: InlinePenRouter | null = null;
	/** Live geometry for the stroke, read once at pen-down and then frozen. */
	frame: PenFrame | null = null;
	/** The last drawn point, in page units, for the wet segment. */
	wetFrom: { x: number; y: number; pressure: number } | null = null;
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
	wetBegun = false;
	/**
	 * The flatness of the tool the live stroke is drawn with, read at
	 * pen-down. It cannot be read off the wet layer: ONE pair serves both
	 * tools here (`dressWet` changes its opacity, not its renderer), so the
	 * highlighter's exemption has to travel with the stroke.
	 */
	wetFlat = false;
	/** True for the whole of an erase gesture, decided once at pen-down. */
	erasing = false;
	/** The lasso being drawn, in page units. Empty when not lassoing. */
	lassoPts: Point2[] = [];
	/** Ids of the strokes the last lasso caught, and the page they are on. */
	selected: string[] = [];
	/**
	 * The page the selection lives on - NOT the page being drawn on now.
	 *
	 * They differ the moment someone lassos on one page and draws on another,
	 * and clearing the chrome by the wrong one leaves a dashed loop stranded
	 * on a page nothing is selected on.
	 */
	selectionPage = 0;
	/** Set while dragging a selection; the point the drag started from. */
	dragFrom: Point2 | null = null;
	dragTotal = { dx: 0, dy: 0 };
	editFrame: number | null = null;
	editPaint: { box: PageBox; kind: "lasso" | "space" } | null = null;
	editTarget: { path: string; page: number; strokeIds: string[] } | null = null;
	editDelta = { dx: 0, dy: 0 };

	/** The hover reticle, and the timer that hides it when the pen is gone. */
	cursorEl: HTMLElement | null = null;
	/** Whether the reticle's single teardown is already registered. */
	cursorDisposed = false;
	cursorTimer: ReturnType<Window["setTimeout"]> | null = null;
	/**
	 * The exact transform string the last successful `showCursor` wrote, for
	 * the `pdf-raw` trace to read back - never recomputed independently,
	 * which would be a second copy of the cx/cy/r arithmetic to drift.
	 */
	lastCursorTransform: string | null = null;
	/** Trace-only: was the reticle hidden as of the last showCursor/hideCursor call? Drives the `pdf-hover` transition line - see `showCursor`. */
	cursorTraceHidden = true;
	/** This gesture's `penRaw` trace bookkeeping. Reset at `penDown`. */
	pdfTrace: PdfTraceGestureState = freshPdfTraceState();
	/** The floating pen strip, whenever the visibility rule says there is one. */
	tools: MobileTools | null = null;
	/**
	 * Drop this pane's subscription to the pen-toolbar rule.
	 *
	 * Held rather than fired-and-forgotten because the thing being unhooked
	 * outlives the reason for it: main.ts unmounts and rebuilds a controller
	 * whenever a leaf's file changes, and a listener left behind by each of
	 * those would keep a closed pane's strip logic running for the session.
	 */
	unwatchPenTools: (() => void) | null = null;
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
	eraseFrom: InkStroke[] | null = null;
	/**
	 * "No ink on the page to erase/select", said once per page rather than
	 * once per contact; the notice is suppressed per page until that page
	 * gains ink again, ruled 2026-09-14. The SAME gate the
	 * note surface uses (EmptyPageNotice.ts): that module keys purely on an
	 * opaque path string plus a tool kind, so a composite key
	 * `${documentId}#${pageNumber}` (see `emptyPageNoticeKey`) gives per-page
	 * suppression within one PDF with zero change to the module or to the
	 * note surface's own (unscoped) keys.
	 */
	readonly emptyPageNotice = new EmptyPageNoticeGate();
	/**
	 * Which page numbers currently hold a claimed empty-page episode (erase
	 * or select, either counts - `forget` clears both together).
	 * `refresh()` used to walk EVERY page the viewer probe reports, filtering
	 * document strokes once per page, on every ink change (undo, paste,
	 * another pane's commit, a sync) - `O(pages x strokes)` on a path that
	 * previously did no such scan at all, and it called `probe()` (a DOM
	 * geometry read) even when nothing was claimed. This set is the only
	 * thing `refresh()` needs to walk: usually empty, at most one entry per
	 * page a toast has actually fired for.
	 */
	claimedPages = new Set<number>();
	/**
	 * Between mount() and unmount(). Gates the sync path, which is the only
	 * thing here that can BIND: a queued frame or a late refresh() must not
	 * rebuild a router and its capture listeners on a dead controller.
	 */
	mounted = false;
	/** A live op has been applied and not yet written. See OpMode. */
	liveDirty = false;

	constructor(
		readonly root: HTMLElement,
		readonly win: Window,
		readonly strokes: StrokeSource,
		readonly documentId: () => string | null = () => null,
		/**
		 * Every stroke in the document, in the order the store holds them.
		 *
		 * The op indices MUST be positions in this list, because that is the
		 * list applyOp splices into (the store applies every op against the
		 * whole document). `strokes` is page-filtered, so indices taken from
		 * it were page-local and only ever right on page one - undo an erase
		 * on page five and the pieces came back at whatever depth those
		 * numbers happened to name among the document's strokes.
		 *
		 * Required, and deliberately without a default. `= () => []` read as
		 * "this document has no ink" AND as "nobody wired a document source",
		 * two different facts that agree only while both lists are empty - so
		 * a caller that simply forgot got page-local indices and a controller
		 * that looked like it worked. Every construction site now has to say
		 * which list it means, including when the answer is nothing.
		 */
		readonly allStrokes: () => readonly InkStroke[],
		readonly onOp: OpSink = () => {},
		/** Runs an Obsidian command by id, for the toolbar's buttons. */
		readonly exec: (commandId: string) => void = () => {},
		/**
		 * Say something to the user. Injected rather than importing Notice,
		 * for the same reason `exec` is: this file observes the DOM and does
		 * nothing else, which is what lets it be built in a test.
		 */
		readonly notify: (message: string) => void = () => {},
		/**
		 * Write this document now. Called once at the end of a gesture whose
		 * ops were applied live; see OpMode.
		 */
		readonly persist: (id: string) => void = () => {},
		/**
		 * Are this controller's stroke sources SYNTHETIC - generated for
		 * measurement rather than read from the store?
		 *
		 * Design doc §5o/C22. PDF calibration mode makes the two sources
		 * disagree on purpose (main.ts hands the page source
		 * `calibrationStrokes(page)` and the document source an empty list),
		 * and the controller could not tell. So the eraser hit-tested the
		 * synthetic crosses like real ink and emitted a real op, and
		 * `applyOp`'s `replace` spliced the split halves of a cross into the
		 * user's sidecar - geometry that was never theirs, in the one class
		 * §4 calls unrecoverable.
		 *
		 * Asked as a QUESTION ABOUT THE SOURCES, not about calibration, and
		 * answered at the op boundary rather than in the gestures: a guard on
		 * the `cal-` id prefix would cover exactly today's crosses, and the
		 * next synthetic source - a third one is already contemplated - would
		 * arrive uncovered and silent. Whoever adds one substitutes the
		 * sources in main.ts, which is the same line that sets this.
		 */
		readonly syntheticSources: () => boolean = () => false,
		/**
		 * What the user says this PDF's pages look like: the `inkPdfColorMode`
		 * setting ("Ink color on PDFs"), which the snip's ink is
		 * made readable against.
		 *
		 * A getter, asked at the moment of each snip and never captured, so a
		 * change in settings applies to the very next snip. The snip needs an
		 * ANSWER rather than a look: the page under its ink is the viewer's own
		 * rendered page, a dark slide as easily as paper, and this file reads
		 * no pixels. The flatten asks the same setting the same question
		 * (`pdfPageDestination`). The default is that setting's shipped default.
		 */
		readonly pageAssumption: () => PdfPageAssumption = () => "darken",
		/** The sidecar has finished a trustworthy read; destructive tools may start. */
		readonly inkReady: () => boolean = () => true
	) {}

	/**
	 * This view's undo ring.
	 *
	 * Per view, matching the note surface, where undo is CodeMirror's history
	 * and therefore per editor. Every op carries its document id, so an undo
	 * pressed after this pane opened a different PDF still acts on the one the
	 * ink belongs to. See PdfInkHistory.
	 */
	history = new PdfInkHistory();

	/**
	 * The keydown listener bound to this pane's root, above. A class field
	 * rather than a local closure so it is one fixed function reference for
	 * add/removeEventListener (the pair must match) and so it can be driven
	 * directly, the same way the strip/palette dispatch already is
	 * (`stripExec`) - PdfInkController.test.ts calls this like any other
	 * private method, cast into reach, rather than needing a live root that
	 * implements `addEventListener` for real.
	 */
	handleKeyDown = (ev: KeyboardEvent): void => {
		// A PDF pane still contains places to type: the viewer's find
		// bar, and form fields in the document itself. This listener runs
		// ahead of them, so Backspace in a search box deleted the ink
		// selection and never reached the box. Undo is the same story -
		// Ctrl+Z in a text field belongs to the field.
		if (isTypingTarget(ev.target)) return;
		// Escape puts a selection away; Delete takes it. Both ahead of the
		// modifier check, because neither uses one.
		if (this.peelEscapeSelection(ev)) return;
		// Notes and PDFs share the same tip-then-mouse floor, preserving the last nib.
		if (peelInkEscapeFloor(ev)) return;
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
		// Ctrl/Cmd+C and X act on lassoed ink while a selection is held, the
		// note surface's rule (InkOverlay.ts:1638-1664, "that is what a lasso
		// means everywhere else"), ported here for the first time. Gated on
		// `hasSelection` FIRST so the branch is not even entered - and the
		// key not consumed - without a lasso: a plain Ctrl+C over a PDF's own
		// selectable text must reach the viewer untouched. `textSelectionLive`
		// is this surface's answer to the note's second guard (its own
		// editor's text selection must also be empty); see that method for
		// why. Once both hold, this reuses the controller's own
		// copy/cut-selected-ink command methods (`copySelection`,
		// `cutSelectionCommand`) rather than a fourth dispatcher (main.ts's
		// own audit note on `activeInkSurface`, next to `pdfControllerWithSelection`,
		// is the same lesson) - they already say the identical "copied/cut N
		// stroke(s)" the note command uses, and already notify every refusal,
		// so nothing here needs to.
		if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && this.hasSelection && !this.textSelectionLive()) {
			const key = ev.key.toLowerCase();
			if (key === "c" || key === "x") {
				ev.preventDefault();
				if (key === "c") this.copySelection();
				else this.cutSelectionCommand();
				return;
			}
		}
		if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
		// A layout that types another script (Russian, Greek) reports its own letter in
		// `key`, so Z and Y read as neither. Only then does the physical key decide; a
		// Latin layout, however remapped, keeps what `key` says.
		const typed = ev.key.toLowerCase();
		const key = /^[a-z]$/.test(typed) ? typed : /^Key[A-Z]$/.test(ev.code ?? "") ? ev.code.slice(3).toLowerCase() : typed;
		const redo = key === "y" || (key === "z" && ev.shiftKey);
		if (key !== "z" && key !== "y") return;
		if (this.historyStep(redo)) {
			ev.preventDefault();
			ev.stopPropagation();
		}
	};

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

	// ---- lasso --------------------------------------------------------------

	/** Page-unit point for a sample, or null when it cannot be converted. */
	pagePoint(box: PageBox, scale: number, sample: PenSample, scroller: HTMLElement) {
		const content = this.toContent(sample, scroller);
		return toPagePoint(box, scale, content.x, content.y);
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
	 * The divider, dashed across the page at the seam it will cut. On the
	 * wet canvas like the lasso's loop: no stroke is wet during either
	 * gesture, so the layer is free.
	 */
	drawSpaceLine(box: PageBox): void {
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

	/** Has this document been hashed yet? Nothing may touch ink until it has. */
	get identified(): boolean {
		return this.documentId() !== null;
	}
}

installPdfCursors(PdfInkController.prototype);
installPdfSelection(PdfInkController.prototype);
installPdfTools(PdfInkController.prototype);
installPdfTrace(PdfInkController.prototype);
installPdfBand(PdfInkController.prototype);
installPdfInkBind(PdfInkController.prototype);
installPdfInkPenPath(PdfInkController.prototype);
installPdfInkCommit(PdfInkController.prototype);
