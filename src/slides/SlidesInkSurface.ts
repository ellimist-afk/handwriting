import { timerHost } from "../util/RuntimeScheduler";
/**
 * Slides ink: the pen writes on Obsidian's core Slides presentation, and the
 * ink is still there the next time the note is presented.
 *
 * This file replaces `SlidesInkProbe.ts`. Everything the probe learned on
 * Alan's screen is carried over unchanged and is NOT re-litigated here - the
 * mount signal, the coordinate mapping, the stroke session reducer and the
 * gesture guard are the probe's, verified on hardware 2026-09-05. What is new
 * is persistence, slide identity, the wet/committed split, and the tap rule.
 * The findings are restated in short because a later reader will change this
 * file and not the deleted one:
 *
 * S1  The presenter is `div.slides-container` appended to `<body>`, not a
 *     workspace view and not a leaf. NO WORKSPACE EVENT FIRES for it. A
 *     MutationObserver on `body` (childList) is the only mount/unmount signal
 *     there is, and teardown is the container being detached.
 *
 * S2  `.reveal > .slides > section`, one section per `---`, created up front
 *     and never re-created. The current one carries the class `present`;
 *     `data-index-h` is not written (Obsidian builds the deck with
 *     `overview:false`), so the index is the section's position among the
 *     direct children of `.slides`.
 *
 * S3  `.slides` is laid out at the LOGICAL deck size (960x700 by default) and
 *     then scaled: `k = slidesRect.width / slides.clientWidth`, measured off
 *     the element rather than read from `--slide-scale`, because
 *     `getBoundingClientRect` is post-transform and `clientWidth` is not.
 *
 * S4  NEVER `stopPropagation()` a PEN or MOUSE pointerdown. Reveal's focus
 *     plugin takes the deck's focus from it and the keyboard dies without it.
 *     `preventDefault` is fine; it does not stop propagation. That half is
 *     unconditional and still exactly true.
 *
 *     A TOUCH pointerdown is the one exception (`PEN_CONTACT_GUARDED_EVENTS`),
 *     and this rule used to say the exception was "while the pen is already
 *     down", justified by "the pen's own pointerdown bubbled first and already
 *     kept the focus, so the palm's has none left to take away". AMENDED
 *     2026-09-05 (the palm work): that window left three real palms
 *     unguarded - one planted BEFORE the nib lands, one still lingering just
 *     after it lifts, and one with no pen in the room at all - so the window
 *     is now pen DOWN, pen NEAR (hovering, `PEN_NEAR_TAIL_MS`),
 *     `PEN_RELEASE_TAIL_MS` after a lift, or a palm-SHAPED contact on a
 *     platform whose contact radii mean something (`palmShapedContact`,
 *     `palmRadiusTrustworthy`). The old justification only ever covered the
 *     first of those four; the reason for the other three is that a
 *     palm-shaped or pen-shadowed touch is not a gesture the presenter made,
 *     and declining to focus the deck on one costs nothing the pen, the mouse
 *     or the keyboard cannot still do - the pen's own contact focuses the
 *     deck itself (`ensureDeckFocused`).
 *
 * S5  A cancel is not a lift. Chromium reclassifies a direct-manipulation
 *     contact as a pan a few samples in and fires `pointercancel`; a handler
 *     that commits there produces a stroke that inks two centimetres and
 *     stops. `strokeSessionReducer` holds the stroke open instead, and the
 *     standing `touch-action: none` guard (InlinePenRouter's, subtree class
 *     included - Blink ORs panning back into every nested scroller) is what
 *     stops the cancel happening at all.
 *
 *     EXTENDED 2026-09-05 (silent lift): the converse also holds - A LIFT IS
 *     NOT ALWAYS AN EVENT. The Surface Slim Pen can leave the glass with no
 *     `pointerup` at all; the stream just resumes hovering under the same
 *     pointerId. This file's end vocabulary used to be closed at the four
 *     events it listened for, so that lift fell out of all of them: the
 *     stroke stayed live, every hover sample was inked across the projected
 *     slide, the navigation guard kept swallowing the reader's taps on the
 *     arrows and the close button, and the next contact was appended to the
 *     old stroke under the old nib. `silentLift` reads the hover sample;
 *     `SILENT_LIFT_QUIET_MS` covers the lift that resumes no hover either.
 *     Note the shape of the pair: S5 refuses to end a stroke on an EVENT that
 *     is not evidence of a lift, and this refuses to keep one open through
 *     SILENCE that is.
 *
 * S6  Navigation on a tap comes from Reveal's Controls, which bind `click` and
 *     `touchstart` on `.navigate-*`, and Progress, which binds `click`.
 *     Obsidian binds `click` only on `.slides-close-btn`. Reveal's touch
 *     plugin ignores pens outright, so a pen cannot swipe the deck.
 *
 * ---- what this file adds -------------------------------------------------
 *
 * A1  **The tap rule** (design §3.3, Alan: "pen should be able to tap the next
 *     slide arrow yep"). The probe swallowed every click while a pen owned the
 *     contact, which cost the pen the arrows and the close button. Here a
 *     contact only becomes a STROKE once it has moved more than TAP_SLOP_PX or
 *     lasted more than TAP_MS; until then it records nothing and its click
 *     passes through to Reveal. So a pen tap on `.navigate-right` turns the
 *     page and a pen drag across it draws a line, and the difference is one
 *     pure predicate (`contactBecameStroke`) rather than a target whitelist.
 *
 * A3  **A tap runs uncaptured.** A1 let the tap's click through, but the click
 *     still did not turn the page (Alan, mouse, 2026-09-05). `setPointerCapture`
 *     at pointerdown retargets the pointerup to `.reveal`, and the browser
 *     builds the compatibility `click` from the common ancestor of the down
 *     and up targets - `.reveal`, never `.navigate-right` - so Reveal's
 *     Controls, which bind `click` on the buttons, never fired. Capture is
 *     therefore taken at PROMOTION (the slop test on a move, or the TAP_MS
 *     test at the end of a motionless hold), not at contact. An eraser
 *     contact takes the SAME promotion (Alan, Orion, pen, 2026-09-05: the
 *     close button ate every eraser tap because the eraser used to capture,
 *     and swallow the navigation click, at pointerdown) - it is just as
 *     capable of being a tap, and until promoted it hit-tests nothing.
 *
 * A2  **Two canvases, both over the whole `.reveal` viewport** (design §3.4).
 *     The committed one is static: it is repainted on a slide change, a load,
 *     a resize or an erase, and never per sample. The live stroke goes through
 *     `WetInkRenderer`, which is the whole of "no lag" - the probe redrew every
 *     committed stroke on every sample, which is the lag Alan saw and is not a
 *     renderer limit.
 *
 *     The viewport, not the deck box: the reader is looking at the whole
 *     screen, and refusing the letterbox margin is what made the first probe
 *     run's contacts vanish. Ink there is stored with negative or
 *     past-the-edge logical coordinates, which is a true statement about where
 *     the pen was and re-lands in the same place on a projector.
 *
 * A3  **Coordinates are the camera's job, not the context transform's.** The
 *     canvases cover the viewport and the ink is in deck-logical units, so the
 *     camera is `{x: -offsetX/k, y: -offsetY/k, zoom: k}` where the offset is
 *     the letterbox. Two things fall out that a `setTransform(dpr*k, ...)`
 *     would break: `WetInkRenderer.clear/clearStroke` take css pixels and
 *     clamp them at zero, so with the transform carrying k a stroke in the
 *     left margin would leave wet residue behind it; and the stroke widths
 *     scale with the deck the way every other painted thing does.
 *
 *     AMENDED 2026-09-05 (device-pixel ceiling). "The transform carries dpr"
 *     was true when the backing store was always `css x devicePixelRatio`.
 *     It is now `css x EFFECTIVE dpr`, where the effective ratio is
 *     `slidesBackingScale` - devicePixelRatio, reduced when three
 *     full-viewport canvases would blow `MAX_BACKING_AREA`. The separation
 *     this rule is about is untouched and is what makes the ceiling safe to
 *     have: the camera still carries k and ONLY k, so a reduced ratio costs
 *     raster density and moves no ink. Every consumer of the ratio -
 *     `setTransform`, both `applyDpr` calls, the css box, and the css-px
 *     clears - takes the same one number out of `syncGeometry`, because a
 *     transform and a backing store that disagree is exactly how ink lands
 *     in the wrong place.
 *
 * A4  **Identity.** The note is `getActiveFile()` at the moment the container
 *     appears - Start presentation acts on the active file, and the workspace
 *     can move under a presentation. Its `handwriting-page-id` is claimed on
 *     the FIRST STROKE through the same `claimMarkdown` path the note surface
 *     uses (the host owns it; this file never writes Markdown). The ink then
 *     lives in its OWN sidecar, `<pageId>.slides`, never the note's: an older
 *     build reads `handwriting-page-id` and asks for the bare id, so it can
 *     never open slides ink as a page, and this build can never open a note as
 *     slides ink. That isolation is the same one the pdf surface has, one step
 *     harder, and it is what makes §3.1 true by construction.
 *
 * A5  **Slide identity** is the index PLUS a hash of the section's source text
 *     (§3.6). An index alone is not an identity: one `---` added above the
 *     first slide shifts every later index by one, and the ink would follow
 *     the number instead of the slide. On load, a stored slide whose hash no
 *     longer matches its index is re-attached to the unique section that does
 *     match. Ink is NEVER deleted for a mismatch - an unmatched slide keeps
 *     its index and waits for the section to come back.
 */

import { CameraState } from "../camera/coordinates";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { computeCanvasSize } from "../diag/Raster";
import { markPenHardwareSeen, penHardwareEverSeen } from "../inline/PenToolsMode";
import { mouseInkEnabled } from "../inline/MouseInk";
import {
	PALM_RADIUS_SWALLOW_PX,
	PalmShield,
	palmRadiusTrustworthy,
} from "../input/PalmShield";
import { predictionEinkOn } from "../inline/StrokePrediction";
import { penContactIntent, tipMode } from "../inline/TipMode";
import { MAX_BACKING_AREA } from "../inline/ZoomScale";
import { splitStrokeByCircle, strokesHitByCircle } from "../ink/Eraser";
import { DEFAULT_ERASER_RADIUS_PX } from "../ink/EraserSize";
import {
	DARK_MAX_LUMINANCE,
	isDarkTheme,
	relativeLuminance,
	setInkThemeOverride,
} from "../ink/InkTheme";
import { DEFAULT_PEN, HIGHLIGHTER_PEN, PenStyle } from "../ink/PenStyle";
import { InkStroke, InkTool, newStrokeId } from "../ink/Stroke";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { drawStroke } from "../ink/StrokeRenderer";
import { TailRenderer } from "../ink/TailRenderer";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { parseMarkdownPage } from "../model/MarkdownPage";
import { PageData, ParseResult, emptyPage } from "../model/PageData";
import { SlidesMoveTrace } from "./SlidesMoveTrace";

const COMMITTED_CLASS = "handwriting-slides-ink";
const WET_CLASS = "handwriting-slides-ink-wet";
/**
 * The transient layer above the wet one, holding the unsmoothed head that
 * reaches the nib. `WetInkRenderer`'s own header says the caller must draw it,
 * and this surface did not: the wet layer's first painted thing is a disc at
 * mid(p0, p1) (`flattenSegment` excludes a segment's start), while the commit
 * starts at p0 with a round cap. On a pen that gap is sub-pixel; on a mouse it
 * is a whole frame of hand travel, and the committed stroke appeared to spray
 * backwards out of where the wet line began.
 */
const TAIL_CLASS = "handwriting-slides-tail";

/**
 * Low-latency canvas request for the wet layer. OFF.
 *
 * `src/inline/InkOverlay.ts`, in the comment above its own
 * `INLINE_DESYNCHRONIZED`, records an A/B of exactly this flag on a surface
 * pro, intel, mains power, 120Hz:
 *
 *              desynchronized: true      false
 *   frame            13-28ms          8.33ms locked
 *   age@present      25-37ms          7ms
 *   move events      25-40Hz          111-117Hz
 *   raw samples      65-100Hz         237-262Hz
 *   coalescing       2.7:1            1:1
 *
 * The finding was that the flag did not merely cost frames, it throttled
 * INPUT: the queue held samples instead of delivering them, on a thread that
 * was otherwise idle.
 *
 * It matters here because the slides wet canvas is full-viewport - a
 * 5120x2784 backing store at devicePixelRatio 2 on a 2560x1392 viewport - and
 * on 2026-09-05 the same class of machine reported this surface as "very very
 * laggy" drawing with a mouse, the shape InkOverlay's A/B predicts.
 *
 * AMENDED 2026-09-05 (device-pixel ceiling): 5120x2784 is what this surface
 * USED to allocate on that machine, and the sentence above is kept because
 * the measurement it justifies was taken there. It is no longer what it
 * allocates. That is 14.25M device pixels on one canvas, over
 * `MAX_BACKING_AREA` and 89% of the 16M WebKit refuses SILENTLY, three times
 * over; `slidesBackingScale` now reduces the ratio to ~1.675 on that viewport
 * and the store is 4288x2331 (~10.0M). The fill cost the "very very laggy"
 * report is about therefore fell by ~30% on that machine as a side effect -
 * which is a consequence of the ceiling, not a reason for it. The reason is
 * that a silently refused allocation paints nothing at all.
 */
export const SLIDES_DESYNCHRONIZED = false;

/**
 * The presenter's two stylesheets, and the reason this surface has to think
 * about the deck's theme at all.
 *
 * Obsidian picks between them from the Appearance CONFIG value, not from the
 * body class: `"moonstone" === vault.getConfig("theme")` loads white.css and
 * everything else loads black.css. So "adapt to system" on a light-mode OS
 * presents the BLACK deck under a body carrying no `theme-dark` class - and
 * ink, which follows the body class (`isDarkTheme`), would resolve near-black
 * ink as light-theme ink and paint it black on a black deck. Invisible.
 *
 * These selectors are the FALLBACK, for a deck whose own paint cannot be read.
 * The measurement below is the primary test, because it answers what is
 * actually on the screen rather than what we believe Obsidian ships.
 */
const BLACK_DECK_LINK = 'link[href*="/lib/reveal/black.css"]';
const WHITE_DECK_LINK = 'link[href*="/lib/reveal/white.css"]';

/** Only the part of `document.head` the fallback uses, so fakes can supply it. */
interface HeadLike {
	querySelector?(selectors: string): unknown;
}

/**
 * A computed background colour we may draw a conclusion from, or `null`.
 *
 * Narrower than `InkTheme`'s own parser on purpose: that one reads a colour a
 * note STORED and keeps its alpha so the ink can be repainted with it, while
 * this one asks a different question - "is this element opaquely painted, and
 * what colour" - and must answer `null` to everything else. `transparent`
 * computes to `rgba(0, 0, 0, 0)`, which the ink parser would happily read as
 * pitch black; a `.reveal` with no background of its own (Reveal 4 paints
 * `.reveal-viewport` instead) would then be measured "dark" on a white deck,
 * which is the exact defect this file is fixing, mirrored. Any translucency
 * is the same story more quietly, so anything under alpha 1 is a refusal and
 * the link fallback takes over.
 */
function opaqueRgb(value: unknown): { r: number; g: number; b: number } | null {
	if (typeof value !== "string") return null;
	const m = /^rgba?\(([^)]*)\)$/i.exec(value.trim());
	if (!m) return null;
	const parts = m[1]!
		.replace(/\//g, " ")
		.split(/[\s,]+/)
		.filter((p) => p !== "");
	if (parts.length !== 3 && parts.length !== 4) return null;
	if (parts.length === 4) {
		const a = parts[3]!;
		const alpha = a.endsWith("%") ? Number(a.slice(0, -1)) / 100 : Number(a);
		if (!Number.isFinite(alpha) || alpha < 1) return null;
	}
	const chans: number[] = [];
	for (let i = 0; i < 3; i++) {
		const p = parts[i]!;
		// Percentage channels are legal CSS but no engine reports a computed
		// background in them; reading them wrong would be worse than refusing.
		if (p.endsWith("%")) return null;
		const n = Number(p);
		if (!Number.isFinite(n)) return null;
		chans.push(Math.min(255, Math.max(0, Math.round(n))));
	}
	return { r: chans[0]!, g: chans[1]!, b: chans[2]! };
}

/** What the surface needs to know about the nib, supplied by the caller. */
export interface SlideNib {
	tool: InkTool;
	color: string;
	width: number;
}

/**
 * The slice of the plugin this surface needs. Narrow on purpose: `src/slides`
 * depends on `src/ink` and `src/model` and on no CodeMirror and no Obsidian
 * API, so the whole mechanism is constructible in a test.
 */
export interface SlidesInkHost {
	/** The presented note's vault path, read once when the deck appears. */
	activeFilePath(): string | null;
	/** The note's text, for the section hashes. */
	readSource(path: string): Promise<string | null>;
	/** The note's persisted page id from cheap metadata, or null. */
	readPageId(path: string): string | null;
	/** Atomically stamp (or discover) the page id in the Markdown. */
	claimId(path: string, proposedId: string): Promise<{ pageId: string; futureVersion?: number }>;
	/** A fresh page id to propose. */
	newPageId(): string;
	loadSidecar(sidecarId: string): Promise<ParseResult | null>;
	scheduleSidecar(sidecarId: string, page: PageData): void;
	/** No quiet period: the first save after an identity claim. */
	saveSidecarNow(sidecarId: string, page: PageData): Promise<void>;
	nib(): SlideNib;
	/**
	 * The live eraser radius, in screen px (B1) - the same setting and
	 * `Next eraser size` command the inline surface reads
	 * (`getEraserRadiusPx`, InkOverlay.ts), so the two agree rather than the
	 * slides eraser quietly ignoring it.
	 */
	eraserRadiusPx(): number;
	/**
	 * Whether the eraser takes a whole stroke or only the part under the ring
	 * (B1) - the same `getEraserWholeStrokes()` the note surface reads, so a
	 * reader who set the eraser to partial in their notes gets partial on a
	 * slide too rather than a second setting that silently disagrees.
	 */
	eraseWholeStrokes(): boolean;
	notify(message: string): void;
	/**
	 * The running plugin's manifest version (e.g. `slides-1.4.13-dev`), printed
	 * once per surface start and once per deck mount so a stale Obsidian
	 * plugin cache is visible in the console at a glance instead of costing an
	 * hour of re-testing against the wrong build.
	 */
	buildId: string;
}

// ---- pure helpers (the tested part) ---------------------------------------

/** Ink is captured in deck-logical units; the camera carries scale and offset. */
export interface SectionLike {
	classList: { contains(token: string): boolean };
}

/**
 * Index of the slide currently on screen, or -1 when none is marked (S2).
 *
 * -1 is a real answer: it is what a deck looks like between `initialize()` and
 * Reveal's first layout, and the mount path must do nothing until it turns
 * positive rather than guessing slide 0. The FIRST match wins - a rebuilt deck
 * has been seen mid-transition with two `present` classes co-resident.
 */
export function presentIndex(sections: readonly SectionLike[]): number {
	for (let i = 0; i < sections.length; i++) {
		if (sections[i]!.classList.contains("present")) return i;
	}
	return -1;
}

/** A rect as `getBoundingClientRect` gives it - post-transform, screen px. */
export interface ScreenRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * Reveal's slide scale, measured off the element instead of read from CSS (S3).
 *
 * Returns 1 rather than dividing by zero when the element has no layout yet - a
 * deck mid-mount measures zero and wants "leave the coordinates alone" over NaN.
 */
export function slideScale(rect: ScreenRect, layoutWidth: number): number {
	if (!Number.isFinite(rect.width) || !Number.isFinite(layoutWidth)) return 1;
	if (layoutWidth <= 0 || rect.width <= 0) return 1;
	return rect.width / layoutWidth;
}

/** Is a screen point inside a rect (edges included)? */
export function insideRect(clientX: number, clientY: number, rect: ScreenRect): boolean {
	return (
		clientX >= rect.left &&
		clientX <= rect.left + rect.width &&
		clientY >= rect.top &&
		clientY <= rect.top + rect.height
	);
}

/**
 * Screen point -> deck-logical units, the inverse of S3's transform, and the
 * only coordinate conversion in this file.
 *
 * Composing the scale and the offset at the call site is the same arithmetic
 * but it is the shape that lets one call site drift from another: measuring k
 * off one element and the offset off another is the bug this signature makes
 * unwriteable. Nothing is clamped - a point in the letterbox is negative or
 * past the deck, and that is the truth about where the pen was.
 */
export interface SlidePoint {
	x: number;
	y: number;
}

export function mapScreenToSlide(
	clientX: number,
	clientY: number,
	rect: ScreenRect,
	layoutWidth: number
): SlidePoint;
/**
 * The same mapping, written into a point the caller already owns.
 *
 * The pen path runs this once per COALESCED sample - 120-240 Hz on the hardware
 * this feature is for - and the allocation it used to make there was the one
 * per-sample allocation §3.2 does not allow. Nothing keeps the returned object:
 * `StrokeBuilder.add` reads the two numbers out of it, so one point can serve
 * every sample of every stroke for the life of the deck.
 */
export function mapScreenToSlide(
	clientX: number,
	clientY: number,
	rect: ScreenRect,
	layoutWidth: number,
	out: SlidePoint
): SlidePoint;
export function mapScreenToSlide(
	clientX: number,
	clientY: number,
	rect: ScreenRect,
	layoutWidth: number,
	out?: SlidePoint
): SlidePoint {
	const k = slideScale(rect, layoutWidth);
	const x = (clientX - rect.left) / k;
	const y = (clientY - rect.top) / k;
	if (!out) return { x, y };
	out.x = x;
	out.y = y;
	return out;
}

/**
 * The camera that paints deck-logical ink onto a canvas covering the `.reveal`
 * viewport (A3).
 *
 * `deck` and `viewport` are both screen rects, so the offset between them is
 * the letterbox in screen px; dividing it by k puts the camera origin in the
 * same logical units the strokes are stored in.
 */
export function slideCamera(deck: ScreenRect, viewport: ScreenRect, k: number): CameraState {
	const zoom = k > 0 && Number.isFinite(k) ? k : 1;
	return {
		x: -(deck.left - viewport.left) / zoom,
		y: -(deck.top - viewport.top) / zoom,
		zoom,
	};
}

/**
 * The device-pixel ratio these canvases may actually spend, bounded.
 *
 * Both mature surfaces cap the ABSOLUTE size of a backing store, each with its
 * own constant - `MAX_BACKING_AREA` (10M, `ZoomScale.ts`) for the note's five
 * pane-sized canvases, `MAX_OVERLAY_PX` (4M, `PdfInkController.ts`) for one
 * page overlay - because WebKit refuses to allocate much past 16M and does it
 * SILENTLY: the canvas simply stays blank, with no error to find it by.
 *
 * This surface had no ceiling at all, and it is the one that needs it most:
 * A2 puts all three canvases over the WHOLE viewport, so the largest pane the
 * plugin ever makes is allocated three times. A 5K panel is 14.7M per canvas
 * and a 6K one is 20.4M, past the silent refusal on its own.
 *
 * The note's number is reused rather than a third one invented. It is a
 * per-canvas budget, and three canvases at 10M is 30M device pixels - 120MB at
 * 4 bytes a pixel, inside the ~200MB `MAX_BACKING_AREA` already budgets for
 * the note's set of five, and each canvas comfortably under 16M.
 *
 * The NOTE's `backingScale` is deliberately not called here even though it
 * holds the same constant: its area cap is floored at `d * min(1, scale)`, so
 * at the scale 1 this surface always passes (the deck's k rides in the camera,
 * A3, and never in the backing store) the floor equals d and the cap can never
 * bite. That floor exists to stop pinch zoom downgrading an unzoomed editor -
 * correct there, inert here. So this is the pdf surface's shape instead: the
 * ratio is reduced by exactly the square root of the overshoot, which lands
 * the area on the budget.
 *
 * Reducing the RATIO rather than clipping the box is what keeps the ink where
 * the pen was: the css box, the backing store, the context transform and both
 * renderers' `applyDpr` all take this one number (A3), so the whole viewport
 * is still covered, just rasterized less densely.
 */
export function slidesBackingScale(cssWidth: number, cssHeight: number, dpr: number): number {
	const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
	const px = cssWidth * cssHeight;
	if (!Number.isFinite(px) || px <= 0) return d;
	return px * d * d <= MAX_BACKING_AREA ? d : Math.sqrt(MAX_BACKING_AREA / px);
}

// ---- tap vs stroke (A1) ---------------------------------------------------

/** How far a pen may travel and still be a tap, in screen px. */
export const TAP_SLOP_PX = 6;
/** How long a pen may stay down and still be a tap, in ms. */
export const TAP_MS = 250;

/**
 * Has this contact become a stroke, or is it still a tap? (§3.3)
 *
 * Screen px rather than logical units on purpose: this is a question about the
 * reader's hand, and the same wobble is the same wobble whether the deck is
 * scaled to a laptop or a projector. Distance OR time, because a slow
 * deliberate dot is ink and a fast flick across a button is not a tap.
 */
export function contactBecameStroke(
	dxPx: number,
	dyPx: number,
	elapsedMs: number
): boolean {
	if (elapsedMs > TAP_MS) return true;
	return Math.hypot(dxPx, dyPx) > TAP_SLOP_PX;
}

/**
 * The event types that can navigate the deck once a contact has been delivered
 * (S6), and which a live pen STROKE therefore has to swallow.
 *
 * `click` is the one that actually navigated the deck on hardware: a pen tap
 * still produces one however hard the pointerdown was preventDefaulted. The
 * touch three are Reveal's other navigation path, swallowed at no cost since a
 * pen does not synthesise them.
 *
 * This list is matched against events of EVERY pointer type, so `pointerdown`
 * is deliberately absent and MUST stay absent: swallowing a pen's own
 * pointerdown once its stroke went live would cost the deck its focus and its
 * keyboard (S4). The palm guard does need `pointerdown`, and that is exactly
 * why it has a list of its own - see `PEN_CONTACT_GUARDED_EVENTS`.
 */
export const PEN_GUARDED_EVENTS: readonly string[] = [
	"click",
	"auxclick",
	"dblclick",
	"pointerup",
	"touchstart",
	"touchmove",
	"touchend",
];

/**
 * The event types swallowed for a TOUCH contact the whole time a pen owns the
 * glass - the palm guard (Alan, 2026-09-05: "palm during a stroke, yes add the
 * palm rejection so it is bullet proof").
 *
 * Reveal 4 navigates touch through its POINTER handlers as well as its touch
 * handlers - `onPointerMove` forwards a `pointerType === "touch"` event
 * straight to `onTouchMove` - so a palm resting on the deck and dragged while
 * the pen writes reaches Reveal's swipe as a plain `pointermove`, which the
 * stroke list above never saw. The standing `touch-action: none` does not stop
 * it either: that guard stops the BROWSER's gesture, not Reveal's own
 * JavaScript one. The slide turned mid-stroke.
 *
 * TWO LISTS, AND THEY MUST STAY TWO. This one is consulted only for touch (a
 * `pointerType === "touch"` pointer event, or a `touch*` event, which carries
 * no pointer type and is touch by definition), so it can afford `pointerdown`;
 * the stroke list is consulted for every pointer type, so it cannot (S4).
 * Folding these four into `PEN_GUARDED_EVENTS` would swallow the PEN's own
 * pointerdown the moment a stroke went live and take the deck's keyboard with
 * it. `swallowDuringPenContact` is the one place the two rules meet.
 *
 * The window is CONTACT, not stroke: the palm has to be rejected from the
 * instant the pen claims the glass, including the whole life of a tap that has
 * not been promoted yet.
 */
export const PEN_CONTACT_GUARDED_EVENTS: readonly string[] = [
	"pointerdown",
	"pointermove",
	"pointerup",
	"pointercancel",
	"touchstart",
	"touchmove",
	"touchend",
];

/**
 * How long the navigation guard outlives a stroke that ended without a lift.
 *
 * The same 300 ms as `STROKE_HOLD_MS` and for the same reason: a pen that is
 * still on the glass keeps reporting, so a silence this long is the only
 * evidence there is that the contact really is over.
 */
export const PEN_GUARD_TAIL_MS = 300;

// ---- the palm's three unguarded windows (S4, amended) ----------------------
//
// `PEN_NEAR_TAIL_MS`, `PEN_RELEASE_TAIL_MS` and `PALM_CONTACT_SWALLOW_PX` are
// the three numbers the palm rule was missing. The first two are `PalmGate`'s
// own, restated rather than imported because `src/input/PalmGate.ts` declares
// them `const` at module scope and exports NEITHER (only `PAROLE_*` are
// exported), so there is nothing to import - the same restating this file
// already does for `bandEraserIntent`, and for the same kind of reason. IF
// PalmGate ever exports them, delete these two and import them: PalmGate.ts is
// the source of truth for both and a drift here is a bug here.
//
// The third is genuinely imported: `PalmShield.ts` is a LEAF (it imports
// nothing at all - checked, not assumed), so unlike `InlinePenRouter.ts` it
// drags no input stack into the slides bundle. Only the conversion is local,
// see `PALM_CONTACT_SWALLOW_PX`.

/**
 * How long after the last pen HOVER sample the pen still counts as near.
 *
 * PalmGate.ts's `HOVER_TAIL_MS`, which is the source of truth for this number.
 * Its reason is this file's reason: while the pen hovers, the hand is holding
 * the pen, so a new touch is very likely the palm arriving a beat ahead of the
 * nib ("palm placed before pen"). Without it the slides palm guard could not
 * arm until the pen's own pointerdown, which is one beat too late.
 */
export const PEN_NEAR_TAIL_MS = 300;

/**
 * How long the PALM half of the guard outlives a normal lift.
 *
 * PalmGate.ts's `RELEASE_TAIL_MS`, which is the source of truth: "the palm
 * usually lingers". The nib leaves the glass first and the heel of the hand
 * follows, so the moves it makes on the way up are the ones that reach
 * Reveal's swipe and carry the ink that was just written off the screen.
 *
 * This is NOT `PEN_GUARD_TAIL_MS` and must not be folded into it. That one is
 * 300 ms and covers a stroke that ended WITHOUT a lift, holding the whole
 * navigation guard - the `click` rule included - until the real `pointerup`
 * arrives. This one runs only AFTER a lift, holds only the touch-shaped rule,
 * and deliberately lets the pen's own trailing `click` through on the next
 * tick exactly as it does today (that is what lets a pen tap reach the arrow).
 */
export const PEN_RELEASE_TAIL_MS = 250;

/**
 * Contact size, in css px, at and above which a POINTER event is palm-shaped.
 *
 * `PalmShield.PALM_RADIUS_SWALLOW_PX` is a RADIUS (`Touch.radiusX/radiusY`);
 * `PointerEvent.width/height` are the contact's full extent. Doubling is the
 * whole of the conversion, and it is the only thing restated from the shield -
 * the classifier itself, and the platform gate that decides whether contact
 * radii mean anything at all, are imported and used unchanged.
 *
 * Why a pointer-side copy exists when the shield is attached to `.reveal`
 * anyway: `PalmShield` listens to `touch*` only, and this file's whole reason
 * for having a palm guard is that Reveal 4 ALSO navigates through its POINTER
 * handlers (see `PEN_CONTACT_GUARDED_EVENTS`). The shield closes the
 * `touchstart` half - Controls' `.navigate-*` bindings, and the browser's own
 * defaults - and cannot see the pointer half at all.
 */
export const PALM_CONTACT_SWALLOW_PX = PALM_RADIUS_SWALLOW_PX * 2;

/**
 * Is this pointer event a pen HOVER sample - the nib in range, off the glass?
 *
 * `buttons === 0` is the test: a pen on the glass reports at least the tip
 * bit, so zero buttons on a pen `pointermove` is the nib in the air. Read
 * from the capture-phase guard listener rather than from the session
 * handlers, because those return early for any pointer that is not the active
 * contact (`this.session.pointerId !== ev.pointerId`) and a hovering nib is
 * never the active contact by definition.
 */
export function isPenHoverEvent(
	type: string,
	pointerType: string | undefined,
	buttons: number | undefined
): boolean {
	return type === "pointermove" && pointerType === "pen" && buttons === 0;
}

/** Is the pen still near, `PEN_NEAR_TAIL_MS` after its last hover sample? */
export function penIsNear(lastHoverAt: number, at: number): boolean {
	return at - lastHoverAt < PEN_NEAR_TAIL_MS;
}

/** Is the lift recent enough that the palm is still expected on the glass? */
export function withinPalmReleaseTail(lastLiftAt: number, at: number): boolean {
	return at - lastLiftAt < PEN_RELEASE_TAIL_MS;
}

/**
 * Does this contact's reported geometry look like a slab rather than a finger?
 *
 * `PalmShield.isPalmTouch` for the pointer path. A pointer event that carries
 * no size information reports width/height 1 (the spec default), which is
 * nowhere near the threshold, so unknown geometry is judged by nothing at all
 * rather than judged wrongly - the shield's own rule ("a shield that cannot
 * see palms must not start seeing them everywhere").
 */
export function palmShapedContact(width: number | undefined, height: number | undefined): boolean {
	return Math.max(width ?? 0, height ?? 0) >= PALM_CONTACT_SWALLOW_PX;
}

/**
 * Should this `contextmenu` be suppressed?
 *
 * `InlinePenRouter.contextMenuSuppressed` (~475) in this surface's terms, and
 * deliberately the same shape: suppress while a claimed gesture owns the
 * moment, when the event is itself pen-sourced (Chromium >=115 delivers
 * `contextmenu` as a PointerEvent), or while a pen is writing or hovering -
 * because a side-button press while merely HOVERING raises the menu with no
 * contact for anything to claim. A reader with no pen in the room keeps the
 * deck's ordinary right-click, which is why this is a predicate and not a
 * blanket `preventDefault`.
 *
 * The mouse needs no carve-out here that the note surface needed: there,
 * `penNear` is fed by mouse hover moves in mouse-ink mode, so an ordinary
 * right-click after moving the mouse read as "pen near" and ate the menu. This
 * file's `penNear` is fed by `isPenHoverEvent`, which requires
 * `pointerType === "pen"`, so a mouse can never set it. A mouse right-click
 * during the mouse's OWN live stroke is suppressed, and that is the same
 * answer the note surface gives.
 */
export function suppressDeckContextMenu(opts: {
	penDown: boolean;
	strokeLive: boolean;
	penNear: boolean;
	pointerType: string | undefined;
}): boolean {
	if (opts.strokeLive || opts.penDown) return true;
	if (opts.pointerType === "pen") return true;
	return opts.penNear;
}

/**
 * Should this event be swallowed because a pen owns the contact?
 *
 * The whole of Alan's ruling as one pure predicate, in two rules that stack:
 *
 * - The PALM rule (`penOwnsGlass`): from the instant a pen claims the glass,
 *   promoted or not, every touch-shaped event is swallowed. A resting palm
 *   cannot swipe the deck, tap a control or start a second gesture while its
 *   hand is writing. Pen and mouse are never touched by this rule, so a
 *   pointerdown of theirs still bubbles and the deck keeps its focus (S4).
 *
 *   The parameter used to be `penDown` and this comment used to end "with no
 *   pen down nothing changes at all: a finger alone still swipes". AMENDED
 *   2026-09-05: the first clause was too narrow and the second is now only
 *   half true. `penOwnsGlass` is pen-down OR pen-near OR inside the release
 *   tail (`penIsNear`, `withinPalmReleaseTail`), because a palm plants a beat
 *   before the nib lands and lingers a beat after it lifts. The deliberate
 *   part survives unchanged and is still the point: a FINGER, with no pen
 *   anywhere near the glass, still swipes the deck - touch navigation is
 *   Reveal's on purpose. What no longer swipes is a palm-SHAPED contact, and
 *   that rule is `palmShapedContact`, deliberately kept OUT of this predicate
 *   so the shape question and the proximity question stay separable.
 *
 * - The STROKE rule (`strokeLive`): `strokeLive` is false for the entire life
 *   of a tap, so a pen tap's click reaches `.navigate-right` and
 *   `.slides-close-btn` exactly as a mouse click does; it is true from the
 *   moment a contact crosses the slop or the clock until one tick past the
 *   lift, so nothing a drawing hand produces can turn the page.
 *
 * There is no target whitelist in either: a whitelist would have to name every
 * control Reveal ever adds.
 *
 * `pointerType` is `undefined` for every event that is not a PointerEvent -
 * `click` and the `touch*` three - which is why the palm rule reads the event
 * NAME as well: a `touchmove` is touch whatever it fails to say about itself.
 */
export function swallowDuringPenContact(
	penOwnsGlass: boolean,
	strokeLive: boolean,
	type: string,
	pointerType: string | undefined
): boolean {
	if (penOwnsGlass && PEN_CONTACT_GUARDED_EVENTS.includes(type)) {
		if (pointerType === "touch" || type.startsWith("touch")) return true;
	}
	if (!strokeLive) return false;
	return PEN_GUARDED_EVENTS.includes(type);
}

// ---- claim (mouse ink, roadmap: mouse input) -------------------------------

/**
 * Should this pointer contact be claimed as a slides-ink gesture?
 *
 * Bug: "slides dont work with mouse ink" (Alan, Paladin, mouse-only,
 * 2026-09-05) - this used to be pen-only (`pointerType === "pen"`), so
 * turning on mouse-ink mode (`MouseInk.ts`, roadmap: mouse input) had no
 * effect here even though the editor surface already honoured it.
 *
 * Pen: any primary contact, unchanged - Reveal's touch plugin ignores pens
 * outright (S6, top of file), so claiming one never costs the deck a
 * navigation gesture. Mouse: only while mouse-ink mode is on AND the LEFT
 * button is down - the same two-part test `InlinePenRouter.mouseActsAsPen`
 * plus its pointerdown call sites' `buttons&1` guard apply for the editor
 * (InlinePenRouter.ts ~1284 and ~1454), restated here rather than imported so
 * this file does not have to pull in the router's whole input stack (see the
 * comment on `eraserIntent`, below, for why that matters). Right and middle
 * stay native even with mouse ink on: there is no lasso on slides for a side
 * button to reach for, so those two are simply left alone, same as the
 * editor leaves them to the context menu. Touch is never claimed, mode or
 * not - Reveal's swipe is touch's only navigation path and this file has no
 * reason to take it from it.
 */
export function claimsContact(
	pointerType: string,
	isPrimary: boolean,
	buttons: number,
	mouseInk: boolean
): boolean {
	if (pointerType === "pen") return isPrimary !== false;
	if (pointerType === "mouse") return mouseInk && (buttons & 1) !== 0;
	return false;
}

// ---- eraser (§3.7, item B1) ------------------------------------------------

/**
 * Same eraser test InlinePenRouter uses to classify a pen contact
 * (`kind = buttons&32 || button===5 ? "eraser" : (buttons&2)!==0 ? "side" :
 * "tip"`, InlinePenRouter.ts): `buttons&32` and `button===5` are two
 * browsers' different ways of reporting the SAME thing, the stylus's tail
 * eraser end touching the surface, not two separate gestures. The barrel
 * (side) button is InlinePenRouter's OTHER arm, `buttons&2`, mapped there to
 * lasso/move - slides ink has no lasso yet, so a held barrel button falls
 * through to the tip here exactly as it does nowhere else in this file.
 */
export function isEraserContact(buttons: number, button: number): boolean {
	return (buttons & 32) !== 0 || button === 5;
}

/**
 * The mouse's share of the erase-or-ink split, once mouse ink can reach the
 * deck at all (roadmap: mouse input): a mouse has no tail end for
 * `isEraserContact` to read, so without a mode there is no way for a mouse
 * contact to mean erase. `InlinePenRouter.ts`'s `bandEraserIntent` (~106)
 * makes the identical call for a mouse contact on the linked-mentions band -
 * `eraserMode && mouseInk && (buttons & 1) !== 0` - and this restates that
 * one line rather than importing it: `InlinePenRouter.ts` pulls in the whole
 * editor input stack (eighteen imports - Telemetry, PalmGate, PointerRouter,
 * ZoomScale, PenProbe and thirteen more), where today `src/slides` depends on
 * nothing heavier than `src/ink`, `src/model`, and the DOM-free
 * `src/inline` leaves (`GuardStyle.ts`, and now `MouseInk.ts`/`TipMode.ts`);
 * reaching into the router for one pure function would drag all eighteen
 * into the slides bundle for free and silently, since it still compiles and
 * the gate stays green either way. `bandEraserIntent` is also not free to
 * extract to somewhere shared: `InkOverlay.ts` imports it AND
 * `BandEraser.test.ts` imports it by name from `InlinePenRouter.ts`, so
 * moving it touches two files this brief has no business touching. Pinned
 * instead: `SlidesInkSurface.test.ts` copies `BandEraser.test.ts`'s own
 * vectors verbatim onto this function - BOTH arms now, not just the mouse's -
 * so the two rules cannot drift apart without turning a test red on one side
 * or the other.
 *
 * AMENDED: that whole eighteen-import argument used to be given for the PEN
 * arm as well, which restated `eraserEnd || eraserMode` inline. It was never
 * true of the pen arm. Pen-contact arbitration already has one shared
 * implementation - `penContactIntent` in `TipMode.ts`, a DOM-free leaf this
 * file ALREADY imports for `tipMode()` - so calling it costs no imports at
 * all, let alone eighteen, and the note and pdf surfaces both go through it.
 * The pen arm calls it now. Only the mouse arm is genuinely restated, and
 * only because `bandEraserIntent` is where its one line lives.
 *
 * The pen arm asks `penContactIntent` for "erase", which is `eraserEnd ||
 * mode === "eraser"`, deliberately identical to the
 * router's. It used to be the tail end alone, and that divergence was
 * documented here as intentional; Alan overruled it ("slides needs to be
 * able to be erased with eraser end", "with a pen", "it should work
 * seamlessly", 2026-09-05). The mode arm is not a convenience: it is the only
 * way a pen with NO tail eraser can erase on a slide at all, and remote
 * desktop drops the eraser-end flag even for pens that have one, so without
 * it those pens could ink on a deck and never take anything back off it.
 *
 * `penContactIntent`'s other answers do not change this one: it takes a
 * `TipMode` rather than a boolean, and the only mode this arm has to hand is
 * "is the eraser mode on", so a pen contact with the mode off asks it as
 * "nib". Everything that answer can be other than "erase" - a held barrel
 * button is "lasso" there - is not "erase" here and falls through to the tip,
 * exactly as the restated line left it, because there is no lasso on a slide
 * for the barrel button to reach for.
 */
export function eraserIntent(
	pointerType: string,
	buttons: number,
	button: number,
	eraserMode: boolean,
	mouseInk: boolean
): boolean {
	if (pointerType === "pen")
		return penContactIntent(buttons, button, eraserMode ? "eraser" : "nib") === "erase";
	if (pointerType === "mouse") return eraserMode && mouseInk && (buttons & 1) !== 0;
	return false;
}

/** The eraser ring, in the slide's own deck-logical units. */
export interface SlideEraseCircle {
	x: number;
	y: number;
	r: number;
}

/**
 * The eraser ring at a screen point, mapped into deck-logical units.
 *
 * The centre goes through the same `mapScreenToSlide` every ink sample uses,
 * and the radius is divided by the same `k` (screen px stay a constant
 * physical size on the glass at any zoom, exactly like the inline eraser's
 * `visualToNote`), so the ring lines up with the ink under the nib whatever
 * the deck's current scale.
 *
 * One function, because the hit test and the PARTIAL cut have to use the SAME
 * ring: a circle computed twice from two spellings of the mapping is exactly
 * how a stroke gets reported as hit and then cut with a ring that missed it.
 */
export function slideEraseCircle(
	clientX: number,
	clientY: number,
	rect: ScreenRect,
	layoutWidth: number,
	radiusPx: number
): SlideEraseCircle {
	const k = slideScale(rect, layoutWidth);
	const center = mapScreenToSlide(clientX, clientY, rect, layoutWidth);
	return { x: center.x, y: center.y, r: k > 0 ? radiusPx / k : radiusPx };
}

/**
 * Ids of the strokes an eraser circle at a screen point touches, in the
 * slide's own deck-logical space. The hit test itself is `Eraser.ts`'s,
 * unchanged - stroke-level, and coarse on purpose: it is the bbox-then-segment
 * gate that BOTH erase branches start from.
 */
export function eraserHitsInSlide(
	strokes: readonly InkStroke[],
	clientX: number,
	clientY: number,
	rect: ScreenRect,
	layoutWidth: number,
	radiusPx: number
): string[] {
	const c = slideEraseCircle(clientX, clientY, rect, layoutWidth, radiusPx);
	return strokesHitByCircle(strokes, c.x, c.y, c.r);
}

/**
 * The PARTIAL erase pass over one slide's strokes: the note surface's rule
 * (`InkOverlay.eraseAt`'s second branch) restated in deck-logical units.
 *
 * Every hit stroke is replaced, AT ITS OWN INDEX, by whatever `Eraser.ts`
 * leaves of it - which is what holds z-order, so erasing through the middle of
 * a line under a highlighter does not bring the halves back on top of it.
 * `splitStrokeByCircle` spreads the original, so each piece keeps the stroke's
 * `page`, i.e. its slide, along with its tool, colour and width; only the id
 * and the geometry are new.
 *
 * A result of exactly ONE piece that is the SAME OBJECT means the ring never
 * crossed the line - the stroke was hit by the coarse bbox-then-segment gate
 * and nothing more - so it goes back untouched and is not counted. That is not
 * an optimisation: counting it would make an eraser pass NEAR ink report a
 * change, repaint, and persist a save for ink nobody altered.
 *
 * `touched` is the number of ORIGINAL strokes actually cut or consumed, which
 * is what the gesture's log line and its one save at lift are gated on.
 */
export function partialEraseInSlide(
	list: readonly InkStroke[],
	hits: readonly string[],
	circle: SlideEraseCircle,
	makeId: () => string
): { strokes: InkStroke[]; touched: number } {
	const hitSet = new Set(hits);
	const out: InkStroke[] = [];
	let touched = 0;
	for (const s of list) {
		if (!hitSet.has(s.id)) {
			out.push(s);
			continue;
		}
		const pieces = splitStrokeByCircle(s, circle.x, circle.y, circle.r, makeId);
		if (pieces.length === 1 && pieces[0] === s) {
			out.push(s);
			continue;
		}
		touched++;
		for (const p of pieces) out.push(p);
	}
	return { strokes: out, touched };
}

// ---- slide identity (A5) --------------------------------------------------

/**
 * The sidecar id for a note's slides ink.
 *
 * A SEPARATE id, not the note's, and that is the whole of design §3.1: an
 * older plugin reads `handwriting-page-id` from frontmatter and loads the bare
 * id, so it can never ask for this one. `isSafePageId` accepts it (dots are
 * legal inside an id), so `PageStore.path` will build a path for it.
 */
export const SLIDES_SIDECAR_SUFFIX = ".slides";

export function slidesSidecarId(pageId: string): string {
	return `${pageId}${SLIDES_SIDECAR_SUFFIX}`;
}

/**
 * A stroke's `page` field is 1-BASED (PageData drops anything below 1, because
 * for the pdf surface it is a page number), and a slide index is 0-based.
 * The two conversions live here so the off-by-one is written once.
 */
export function pageOfSlide(index: number): number {
	return index + 1;
}

export function slideOfPage(page: number | undefined): number {
	return typeof page === "number" && Number.isInteger(page) && page >= 1 ? page - 1 : 0;
}

/**
 * A CommonMark thematic break: three or more `*`, `-` or `_`, all the same
 * character, spaces or tabs allowed between them, up to three leading spaces
 * and nothing else on the line.
 */
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/**
 * A setext heading underline, as the presenter's OWN parser reads it.
 *
 * Obsidian's presenter splits with legacy remark-parse under
 * `{breaks: true, commonmark: true}`, whose setext tokenizer takes a line that
 * is ONLY `=` or `-` characters - no leading and no trailing whitespace. Only
 * `-` can reach here, because a line of `=` is never a thematic break. So
 * `- - -` under a paragraph is a break, and so is `--- ` with a trailing
 * space; bare `---` under a single line of text is that line's h2.
 */
const SETEXT_UNDERLINE = /^-+$/;

/** Opens or closes a fenced code block: three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The close has to be bare - an info string only ever rides the opener. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Lines that start a block a paragraph cannot continue into, so a `---` under
 * one of them is a break rather than that line's setext underline.
 */
const OPENS_OTHER_BLOCK = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|[-*+][ \t]|\d{1,9}[.)][ \t]|<)/;

/** Clean one inline block: %% closes on its line; HTML and code may span soft breaks. */
function stripInlineComments(line: string): string {
	let out = "";
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\\") {
			out += line.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (line[i] === "`") {
			const ticks = /^`+/.exec(line.slice(i))![0];
			let end = line.indexOf(ticks, i + ticks.length);
			while (end >= 0 && (line[end - 1] === "`" || line[end + ticks.length] === "`")) {
				end = line.indexOf(ticks, end + ticks.length);
			}
			if (end >= 0) {
				out += line.slice(i, end + ticks.length);
				i = end + ticks.length;
				continue;
			}
			out += ticks;
			i += ticks.length;
			continue;
		}
		const open = line.startsWith("%%", i) ? "%%" : line.startsWith("<!--", i) ? "<!--" : null;
		if (open) {
			const close = open === "%%" ? "%%" : "-->";
			const end = line.indexOf(close, i + open.length);
			const newline = line.indexOf("\n", i);
			if (end >= 0 && (open !== "%%" || newline < 0 || end < newline)) {
				out += line.slice(i, end + close.length).replace(/[^\n]/g, "");
				i = end + close.length;
				continue;
			}
		}
		out += line[i++]!;
	}
	return out;
}

/**
 * The note's slide sections, in deck order (§3.6).
 *
 * This has to agree with Obsidian's own presenter, because the slide INDEX it
 * produces is what a stroke's `page` is keyed off: the presenter parses the
 * note to mdast, splits the top-level children on `thematicBreak` nodes and
 * SKIPS EMPTY GROUPS. So a `---` here is a CommonMark thematic break, not any
 * line of three dashes: one inside a fence is code, one directly under a
 * SINGLE line of text is that line's setext underline (the presenter's own
 * tokenizer takes one content line, and setext never interrupts a paragraph
 * already under way). Only groups without mdast nodes are dropped; a comment
 * node can make a real slide whose rendered text is blank.
 *
 * The frontmatter is skipped through the one parser the rest of the plugin
 * uses (`parseMarkdownPage.rawBody`), so the malformed-fence corpus is handled
 * by construction rather than by a second, subtly different, `---` scanner.
 *
 * Comments (`%%...%%` and `<!-- ... -->`) are dropped here, ONCE, for the same
 * reason: the presenter does not render them, so a note whose first slide
 * opens `%%rel%%# Slide one` is on screen as "Slide one". This is the only
 * place they are stripped - the section texts every caller reads are already
 * comment-free, so nothing downstream pays for it per sample or per stroke.
 * Not inside a fence, where `%%` is code.
 */
export function splitSlideSections(source: string): string[] {
	const parsed = parseMarkdownPage(source);
	const lines = parsed.rawBody.split(/\r\n|\n|\r/);
	const groups: Array<{ lines: string[]; hasNode: boolean }> = [];
	let current: string[] = [];
	let inlineRun: string[] = [];
	const flushInline = (): void => {
		if (inlineRun.length === 0) return;
		current.push(...stripInlineComments(inlineRun.join("\n")).split("\n"));
		inlineRun = [];
	};
	let hasNode = false;
	let fence: { char: string; len: number } | null = null;
	let blockClose: "%%" | "-->" | null = null;
	// Structural decisions use the raw paragraph, before inline comments are
	// removed. `%%hidden%%\n---` is a setext heading, while `%%hidden%%---`
	// is ordinary text. Neither becomes a rule when its comment disappears.
	let paragraphRun = 0;
	for (let index = 0; index < lines.length; index++) {
		let raw = lines[index]!;
		if (fence) {
			current.push(raw);
			const close = FENCE_CLOSE.exec(raw)?.[1];
			if (close && close[0] === fence.char && close.length >= fence.len) fence = null;
			continue;
		}
		if (blockClose) {
			const end = raw.indexOf(blockClose);
			if (end < 0) {
				current.push("");
				continue;
			}
			raw = raw.slice(end + blockClose.length);
			blockClose = null;
		}
		// A top-level indented code line is literal, just like a fenced one.
		if (paragraphRun === 0 && /^(?: {4}|\t)/.test(raw)) {
			flushInline();
			hasNode = true;
			current.push(raw);
			continue;
		}
		// The installed presenter's %% block tokenizer accepts a line-start
		// opener only when no further percent occurs on that opening line.
		// The entire block is one mdast node, including any rules inside it.
		if (/^ {0,3}%%[^%]*$/.test(raw)) {
			flushInline();
			hasNode = true;
			blockClose = "%%";
			paragraphRun = 0;
			current.push("");
			continue;
		}
		// Legacy remark gives a one-line setext heading priority over an HTML
		// block. Preserve that measured exception (`<!--\n---`), too.
		const htmlSetext = paragraphRun === 0 && /^ {0,3}<!--/.test(raw) && SETEXT_UNDERLINE.test(lines[index + 1] ?? "");
		if (/^ {0,3}<!--/.test(raw) && !htmlSetext) {
			flushInline();
			hasNode = true;
			paragraphRun = 0;
			const end = raw.indexOf("-->", raw.indexOf("<!--") + 4);
			if (end < 0) {
				blockClose = "-->";
				current.push("");
				continue;
			}
			raw = raw.slice(end + 3);
		}
		const open = FENCE.exec(raw)?.[1];
		if (open) {
			flushInline();
			fence = { char: open[0]!, len: open.length };
			hasNode = true;
			paragraphRun = 0;
			current.push(raw);
			continue;
		}
		if (THEMATIC_BREAK.test(raw)) {
			flushInline();
			if (paragraphRun === 1 && SETEXT_UNDERLINE.test(raw)) {
				current.push(raw);
				paragraphRun = 0;
				continue;
			}
			groups.push({ lines: current, hasNode });
			current = [];
			hasNode = false;
			paragraphRun = 0;
			continue;
		}
		if (raw.trim() !== "") hasNode = true;
		paragraphRun = raw.trim() !== "" && (htmlSetext || !OPENS_OTHER_BLOCK.test(raw)) ? paragraphRun + 1 : 0;
		if (paragraphRun > 0) inlineRun.push(raw);
		else {
			flushInline();
			current.push(stripInlineComments(raw));
		}
	}
	flushInline();
	groups.push({ lines: current, hasNode });
	// The presenter drops empty mdast groups, not groups whose rendered text
	// is empty. Comments and frontmatter both keep a real, possibly blank slide.
	const hasFrontmatter = parsed.frontmatter.length > 0;
	return groups.filter((group, i) => (hasFrontmatter && i === 0) || group.hasNode)
		.map((group) => group.lines.join("\n"));
}

/**
 * FNV-1a, 32-bit, lower-case hex (§3.6). Trimmed first, so re-indenting a
 * slide's last line does not detach its ink.
 *
 * Not cryptographic and does not need to be: the only cost of a collision is
 * that two identical slides cannot be told apart, and identical slides are
 * exactly the case `remapSlides` already refuses to guess about.
 */
export function sectionHash(text: string): string {
	let h = 0x811c9dc5;
	const s = text.trim();
	for (let i = 0; i < s.length; i++) {
		h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

export function sectionHashes(source: string): string[] {
	return splitSlideSections(source).map(sectionHash);
}

/** How much of the first section is compared. Enough to be a fingerprint. */
export const NOTE_CHECK_CHARS = 200;

/**
 * Pass as the normaliser's limit to take the whole thing.
 *
 * The DECK side is never cut. One slide's rendered text is small, and a note
 * with a long frontmatter block would otherwise spend the whole window on
 * properties and push the slide's actual words out of the comparison.
 */
const UNCUT = Number.POSITIVE_INFINITY;

/**
 * The classes Obsidian puts on a rendered frontmatter block.
 *
 * The presenter parses the note to mdast and the frontmatter node lands in the
 * FIRST slide's group, rendered, so that section's `textContent` begins with
 * the note's own properties - `handwriting-page-id` above all, which is on
 * every note that has ever been inked. The note side starts at the body
 * (`parseMarkdownPage(...).rawBody`), so without this the two sides disagree
 * on every note this feature has ever touched.
 */
const FRONTMATTER_CLASSES = ["frontmatter", "metadata-container"];

/** The little of an element the deck-side gather reads. */
export interface DeckSectionEl {
	readonly textContent: string | null;
	readonly children: ArrayLike<DeckSectionEl>;
	readonly classList: { contains(token: string): boolean };
}

/** Every frontmatter block under `el`, in order, without descending into one. */
function frontmatterTexts(el: DeckSectionEl, out: string[]): string[] {
	const kids = el.children;
	for (let i = 0; i < kids.length; i++) {
		const child = kids[i];
		if (!child) continue;
		if (FRONTMATTER_CLASSES.some((c) => child.classList.contains(c))) {
			// The whole block goes, so there is nothing inside it to look at.
			out.push(child.textContent ?? "");
			continue;
		}
		frontmatterTexts(child, out);
	}
	return out;
}

/**
 * One slide section's text, with the rendered frontmatter left out (§3.5).
 *
 * Load-time only - this walks the section once per presentation, never per
 * sample and never per stroke. The DOM is not cloned: the frontmatter blocks'
 * `textContent` is subtracted from the section's, which is the same string a
 * clone would have produced and costs one walk.
 */
export function deckSectionText(section: DeckSectionEl): string {
	let text = section.textContent ?? "";
	for (const skip of frontmatterTexts(section, [])) {
		if (skip === "") continue;
		const at = text.indexOf(skip);
		if (at >= 0) text = text.slice(0, at) + text.slice(at + skip.length);
	}
	return text;
}

/**
 * How much of the note's first section has to turn up in the deck's.
 *
 * Shorter than NOTE_CHECK_CHARS on purpose: it is a needle to find, not a
 * string to match, and the deck's copy of it can be surrounded by anything
 * Obsidian chose to render around the slide.
 */
export const NOTE_CHECK_NEEDLE_CHARS = 80;

/**
 * Markdown source and rendered text, reduced to the one thing they share.
 *
 * The two sides of `noteMatchesDeck` are NOT the same string and never can be:
 * one is the note's own `---`-split source, the other is what Reveal put on the
 * screen after Obsidian rendered it. `# Title` is `Title` by the time it is a
 * section's `textContent`. So everything that is syntax rather than content is
 * dropped - fences, link targets, and finally every character that is not a
 * letter or a digit - and what is left is the letters and digits, lower-cased.
 * That is a fingerprint, which is all this check needs: it is answering "is
 * this the same note at all", not "is this byte-identical".
 *
 * What is NOT dropped here is anything the presenter removes before it renders
 * at all: the note's comments (`%%...%%`, `<!-- ... -->`) are gone by the time
 * the text reaches this function, stripped once by `splitSlideSections`. A
 * reader adding to this list has to check there too - a comment left in the
 * note's first section put "rel" at the head of the needle, the deck's text
 * began "slide one", and the whole presentation's ink was parked in memory
 * (owner's console, 2026-09-06).
 *
 * Separators are dropped rather than collapsed to a space, because the two
 * sides do not agree on where a space belongs. The rendered side is a
 * `textContent`, and there is no whitespace BETWEEN block elements:
 * `<h1>Slide one</h1><p>Draw here` reads as "Slide oneDraw here", so a
 * space-collapsing fingerprint compared "slide one draw here" against
 * "slide onedraw here" and failed every real deck. With the separators gone
 * both sides fuse the same way.
 */
function normaliseSectionText(text: string, limit: number = NOTE_CHECK_CHARS): string {
	return text
		.replace(/`{1,3}[^`]*`{1,3}/g, " ")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[^\p{L}\p{N}]+/gu, "")
		.toLowerCase()
		.slice(0, limit);
}

/**
 * Is the note we resolved actually the note on the screen? (§3.5)
 *
 * `activeFilePath()` is read at container time and is only ever a good guess:
 * Start presentation acts on the active file, but a second pane or a popout
 * window can make the workspace's active file something other than the deck the
 * reader is looking at. Without this the surface would stamp
 * `handwriting-page-id` into an innocent note and file the presentation's ink
 * under it - a Markdown write on the wrong file, which is the one thing this
 * feature must never do.
 *
 * Two cheap questions, both of which a wrong note fails: the deck has one
 * section per `---` in the source, so the COUNTS must agree; and the first
 * slide as rendered must CONTAIN the first section's opening words. A note
 * whose first slide says something else fails that outright. A note that
 * passes both is
 * the note, near enough to write to. A note that fails either takes the
 * memory-only arm: ink still flows, nothing is stamped, nothing is saved.
 *
 * An empty first section (a title slide that is only an image, say) proves
 * nothing either way, so the count alone decides it rather than a blank string
 * being read as a mismatch.
 */
export function noteMatchesDeck(
	sectionTexts: readonly string[],
	deckTexts: readonly string[]
): boolean {
	if (sectionTexts.length !== deckTexts.length) return false;
	if (sectionTexts.length === 0) return true;
	const note = normaliseSectionText(sectionTexts[0] ?? "");
	const deck = normaliseSectionText(deckTexts[0] ?? "", UNCUT);
	// A note whose body opens with a bare `---` right under its frontmatter
	// gives `splitSlideSections` an empty string for section 0 (kept on
	// purpose, see above), so `note` is "" here. That is fine: the deck's
	// first section is frontmatter-only and the gather above strips that
	// text to "" too, so an empty needle is the CORRECT match, not a blank
	// standing in for an unknown one.
	if (note === "" || deck === "") return true;
	// CONTAINS, not a prefix: the rendered side legitimately carries text the
	// source does not begin with. The frontmatter is the case that cost this
	// feature every save it ever tried to make - Obsidian renders the note's
	// properties into the FIRST slide, so the deck's text began with
	// `handwriting-page-id...` while the note's began with the body, and a
	// prefix relation failed on every note that had ever been inked. The
	// gather above drops that block by class; this is the belt to its braces,
	// and it holds for anything else Obsidian decides to render around a slide.
	return deck.includes(note.slice(0, NOTE_CHECK_NEEDLE_CHARS));
}

export interface StoredSlide {
	index: number;
	hash: string;
}

/**
 * Where each stored slide's ink belongs in the deck as it is NOW (§3.6).
 *
 * Returns old index -> new index for every entry that moved; an entry that did
 * not move is absent. The rules, in order:
 *
 *  - the hash still matches the section at that index: nothing moved.
 *  - exactly one section in the whole deck matches: the slide moved there.
 *    This is the case that matters - a `---` added above the first slide - and
 *    it is why an index alone was never enough.
 *  - no match, or several (a duplicated slide): KEEP THE INDEX. Ink is never
 *    deleted and never guessed onto a slide it might not belong to; a section
 *    that comes back finds its ink where it left it.
 */
export function remapSlides(
	stored: readonly StoredSlide[],
	current: readonly string[]
): Map<number, number> {
	const moved = new Map<number, number>();
	// Built once: a deck is small, but this is a load-time loop over both
	// lists and the nested scan was the shape that made it quadratic.
	const byHash = new Map<string, number[]>();
	for (let i = 0; i < current.length; i++) {
		const list = byHash.get(current[i]!);
		if (list) list.push(i);
		else byHash.set(current[i]!, [i]);
	}
	// A section that still holds its own stored slide is SPOKEN FOR, and a
	// duplicate elsewhere must not be moved on top of it.
	const settled = new Set<number>();
	for (const slide of stored) {
		if (current[slide.index] === slide.hash) settled.add(slide.index);
	}
	// Claimants per section. Two STORED slides that share a hash both used to
	// resolve to the one surviving section and their ink was merged there,
	// which is a silent loss of the distinction between them - and §3.6 never
	// merges. Only the nearest claimant moves; the rest keep their index and
	// are counted as kept, exactly like the ambiguous case below.
	const claims = new Map<number, number[]>();
	for (const slide of stored) {
		if (current[slide.index] === slide.hash) continue;
		const matches = byHash.get(slide.hash);
		if (!matches || matches.length !== 1) continue;
		const target = matches[0]!;
		if (target === slide.index || settled.has(target)) continue;
		const list = claims.get(target);
		if (list) list.push(slide.index);
		else claims.set(target, [slide.index]);
	}
	for (const [target, claimants] of claims) {
		// Nearest by index, ties to the lower index: an edit moves a slide a
		// short way far more often than a long way, and a tie has to break
		// somewhere it can be written down.
		let best = claimants[0]!;
		for (const c of claimants) {
			const d = Math.abs(c - target);
			const bd = Math.abs(best - target);
			if (d < bd || (d === bd && c < best)) best = c;
		}
		moved.set(best, target);
	}
	return moved;
}

/**
 * The stored slides `remapSlides` could NOT place, split by what the reader
 * will see. Both cases keep their index - §3.6 never deletes and never guesses
 * - but they are not the same experience and the log has to tell them apart:
 *
 *  - `kept` counts every unplaced slide (no matching section, or several).
 *  - `visible` counts the ones whose old index still names a real section, so
 *    that ink is now drawn on a DIFFERENT, currently-shown slide. The rest sit
 *    past the end of the deck and are simply invisible until it grows back.
 *
 * A slide whose hash still matches its own index is placed, not kept.
 */
export function keptSlides(
	stored: readonly StoredSlide[],
	current: readonly string[],
	moved: ReadonlyMap<number, number>
): { kept: number; visible: number } {
	let kept = 0;
	let visible = 0;
	for (const slide of stored) {
		if (current[slide.index] === slide.hash) continue;
		if (moved.has(slide.index)) continue;
		kept++;
		if (slide.index < current.length) visible++;
	}
	return { kept, visible };
}

/** Apply a remap to the strokes' 1-based page numbers. Returns how many moved. */
export function remapStrokes(strokes: InkStroke[], moved: Map<number, number>): number {
	if (moved.size === 0) return 0;
	let n = 0;
	for (const s of strokes) {
		const from = slideOfPage(s.page);
		const to = moved.get(from);
		if (to === undefined) continue;
		s.page = pageOfSlide(to);
		n++;
	}
	return n;
}

// ---- stroke session state machine (S5, the probe's, unchanged) ------------

/**
 * Why a stroke ended. `up` is a healthy lift; anything else names what took
 * the contact, and that distinction is the whole diagnostic value of the log.
 *
 * `silent-lift` is a lift that delivered no event (see `silentLift` below):
 * the vocabulary used to be closed at four, and a nib that left the glass
 * without a `pointerup` fell out of all four - which is the whole of the bug
 * it is here to name.
 *
 * `slide-change` is the deck moving out from under a live stroke - a clicker,
 * an arrow key, anything that is not a pointer. It is the note surface's
 * `abandonActiveStroke`/`onStrokeAbandoned` in this surface's terms: the
 * stroke is committed to the surface it was DRAWN on and the live layers are
 * cleared, so no half-drawn line is left painted over the new slide and no ink
 * lands on a page the reader never wrote it on.
 */
export type StrokeEndReason =
	| "up"
	| "cancel"
	| "lost-capture"
	| "leave"
	| "silent-lift"
	| "slide-change";

/**
 * How long a stroke is held open after a cancel or a capture theft before it
 * is committed. A pen that is still down keeps delivering moves at 120-240 Hz,
 * so one further sample inside this window means the contact survived and the
 * cancel was the browser changing its mind, not the reader lifting off.
 */
export const STROKE_HOLD_MS = 300;

/**
 * A pen sample that claims the live stroke but is already hovering.
 *
 * `PointerRouter.silentLift` (src/input/PointerRouter.ts ~126), restated
 * rather than imported for the reason `eraserIntent` and the palm tails are
 * restated: PointerRouter drags the whole editor input stack - telemetry, the
 * palm gate, the camera - into a bundle that deliberately depends on nothing
 * but `src/ink` and `src/model`. PointerRouter.ts IS the source of truth for
 * this predicate and a drift here is a bug here.
 *
 * Its words, because they are the finding: the Surface Slim Pen can lift
 * without a discrete `pointerup` ever reaching the app; the raw stream simply
 * resumes hovering under the same pointerId, and every hover sample would
 * become trailing ink. The Surface Pen (1776) always delivers the event, so
 * this never fires for it. Both contact bits (tip = 1, eraser = 32) and the
 * pressure must read zero together, which is exactly the hover signature; a
 * mid-stroke pressure dip still carries the tip bit and a buttons glitch still
 * carries pressure, so neither ends a real stroke.
 *
 * Not `isPenHoverEvent`, which is the same question one notch coarser: that
 * one asks `buttons === 0` because it classifies events for a pointer this
 * surface holds no session for, where there is no stroke to be wrong about.
 * The side-button bit (2) can be HELD THROUGH a lift, and a reader who lifts
 * with the barrel button down would keep `buttons === 2` and keep inking.
 */
export function silentLift(pressure: number, buttons: number): boolean {
	return pressure === 0 && (buttons & 1) === 0 && (buttons & 32) === 0;
}

/**
 * How long a live contact may say NOTHING AT ALL before it is called a lift.
 *
 * The second half of the silent lift, for the lift that resumes no hover
 * either - the nib leaves the digitizer's range in the same motion, or the
 * deck loses the window, and the stream simply stops. `silentLift` above needs
 * a sample to read and there is none.
 *
 * `STROKE_HOLD_MS`, not a number of its own, and the reason is already written
 * on it: a pen that is still down keeps delivering at 120-240 Hz, so a silence
 * this long is the only evidence there is that the contact is over. It is the
 * same interval `PEN_GUARD_TAIL_MS` uses for the same judgement about the same
 * hardware, and a third number here would be a third thing to keep true.
 *
 * The note surface has NO such constant to copy: `silentLift` is the whole of
 * its rule there and it is event-driven end to end (PointerRouter.ts ~395 and
 * ~426, InlinePenRouter.ts ~1688 and ~1778 - four call sites, no timer). This
 * half is this surface's own, and it exists because a deck can outlive the
 * hover stream in ways an editor pane cannot: the presentation container is
 * torn off `<body>` (S1) and a projector can take the window with it.
 */
export const SILENT_LIFT_QUIET_MS = STROKE_HOLD_MS;

export interface StrokeSession {
	readonly phase: "idle" | "drawing";
	readonly pointerId: number | null;
	/** Whether we believe we still hold `setPointerCapture` for this pointer. */
	readonly captured: boolean;
	readonly samples: number;
	/** When a cancel / capture theft started being held open, else null. */
	readonly holdSince: number | null;
	readonly holdReason: StrokeEndReason | null;
}

export const IDLE_SESSION: StrokeSession = {
	phase: "idle",
	pointerId: null,
	captured: false,
	samples: 0,
	holdSince: null,
	holdReason: null,
};

export type StrokeSessionEvent =
	/**
	 * `captured` is whether the caller actually took `setPointerCapture` at
	 * this contact, which is NOT every contact any more: a contact that might
	 * still turn out to be a tap runs uncaptured (A1/S4, `onPointerDown`).
	 */
	| { kind: "down"; pointerId: number; t: number; captured: boolean }
	| { kind: "move"; pointerId: number; t: number }
	| { kind: "up"; pointerId: number; t: number }
	| { kind: "cancel"; pointerId: number; t: number }
	| { kind: "lost-capture"; pointerId: number; t: number }
	| { kind: "got-capture"; pointerId: number; t: number }
	| { kind: "leave"; pointerId: number; t: number }
	/**
	 * The nib is off the glass and said so in a `pointermove` instead of a
	 * `pointerup` (`silentLift`), or it said nothing for `SILENT_LIFT_QUIET_MS`.
	 * Pointer-addressed like every other input event: only the live contact's
	 * own hover can end the live contact's stroke.
	 */
	| { kind: "silent-lift"; pointerId: number; t: number }
	/**
	 * The deck moved to another slide under the live stroke. Carries no
	 * pointer, like `tick`: it is the surface talking, not the input stream,
	 * and the contact it ends is still physically on the glass.
	 */
	| { kind: "slide-change"; t: number }
	/** The hold deadline fired. Carries no pointer: it is a clock, not input. */
	| { kind: "tick"; t: number };

export interface StrokeSessionStep {
	state: StrokeSession;
	begin: boolean;
	sample: boolean;
	/** Capture was lost and the pen is still down: take it again. */
	recapture: boolean;
	/** Non-null means commit the stroke now, for this reason. */
	end: StrokeEndReason | null;
}

/**
 * The whole of a stroke's lifetime, as a pure function (S5).
 *
 * A cancel or a lost capture does NOT end a stroke while the pen is still
 * down: the stroke is held open for STROKE_HOLD_MS, one more move re-acquires
 * the capture and carries on in the same stroke, and only a silence that
 * outlives the window commits, with the reason recorded.
 *
 * The caller drives the deadline off `state.holdSince`: non-null means a timer
 * should be pending, null means it should not. Idempotent, so re-arming on
 * every step is correct.
 */
export function strokeSessionReducer(
	state: StrokeSession,
	ev: StrokeSessionEvent
): StrokeSessionStep {
	const idle: StrokeSessionStep = {
		state,
		begin: false,
		sample: false,
		recapture: false,
		end: null,
	};
	if (ev.kind === "down") {
		// A second contact while one is drawing is ignored outright: the
		// surface is single-stroke, and claiming it would orphan the builder.
		if (state.phase === "drawing") return idle;
		return {
			state: {
				phase: "drawing",
				pointerId: ev.pointerId,
				captured: ev.captured,
				samples: 1,
				holdSince: null,
				holdReason: null,
			},
			begin: true,
			sample: true,
			recapture: false,
			end: null,
		};
	}
	if (ev.kind === "slide-change") {
		// Unconditional, like `up` and unlike `cancel`: the ink belongs to the
		// slide it was drawn on and that slide is leaving the screen NOW, so
		// there is nothing a hold could wait for that would improve the answer.
		if (state.phase !== "drawing") return idle;
		return {
			state: IDLE_SESSION,
			begin: false,
			sample: false,
			recapture: false,
			end: "slide-change",
		};
	}
	if (ev.kind === "tick") {
		if (state.phase !== "drawing" || state.holdSince === null) return idle;
		if (ev.t - state.holdSince < STROKE_HOLD_MS) return idle;
		return {
			state: IDLE_SESSION,
			begin: false,
			sample: false,
			recapture: false,
			end: state.holdReason ?? "cancel",
		};
	}
	// Everything below is pointer-addressed: a stray event for another pointer
	// (a finger, a second pen) must not touch the live stroke.
	if (state.phase !== "drawing" || state.pointerId !== ev.pointerId) return idle;
	switch (ev.kind) {
		case "move": {
			// Capture is only ever LOST alongside a hold (`cancel` and
			// `lost-capture` both open one), so a hold is what tells a stolen
			// capture apart from one that was deliberately never taken. A
			// contact that is still deciding whether it is a tap is the second
			// kind and must NOT be handed a capture here - that is the whole
			// of the arrow-click fix (A1/S4).
			const recapture = !state.captured && state.holdSince !== null;
			// The pen is demonstrably still down, so any hold is void.
			//
			// AMENDED 2026-09-05 (silent lift): "demonstrably" is the CALLER's
			// promise now, not this branch's. A hover sample is a `pointermove`
			// too, and feeding one in here as a `move` would not merely fail to
			// end the stroke, it would clear the hold and reinforce the belief
			// that the nib is on the glass. `onPointerMoveBody` reads
			// `silentLift` BEFORE it builds this event, so a hover arrives as
			// `silent-lift` and never as `move`; a caller that skipped that
			// test would resurrect the whole bug from inside this line.
			return {
				state: {
					...state,
					captured: state.captured || recapture,
					samples: state.samples + 1,
					holdSince: null,
					holdReason: null,
				},
				begin: false,
				sample: true,
				recapture,
				end: null,
			};
		}
		case "got-capture":
			return { ...idle, state: { ...state, captured: true } };
		case "up":
			return {
				state: IDLE_SESSION,
				begin: false,
				sample: false,
				recapture: false,
				end: "up",
			};
		case "silent-lift":
			// As final as an `up` and for the same physical reason - the nib is
			// off the glass. NOT a hold: a hold exists for a contact that may
			// still be down (S5), and this event is the evidence that it is
			// not, so holding one open would be holding it open against the
			// only witness there is.
			return {
				state: IDLE_SESSION,
				begin: false,
				sample: false,
				recapture: false,
				end: "silent-lift",
			};
		case "cancel":
			// Held, not committed. A cancel outranks a capture theft as an
			// explanation, so it takes the reason even if a theft armed first.
			return {
				...idle,
				state: {
					...state,
					captured: false,
					holdSince: state.holdSince ?? ev.t,
					holdReason: "cancel",
				},
			};
		case "lost-capture":
			return {
				...idle,
				state: {
					...state,
					captured: false,
					holdSince: state.holdSince ?? ev.t,
					holdReason: state.holdReason ?? "lost-capture",
				},
			};
		case "leave":
			return {
				state: IDLE_SESSION,
				begin: false,
				sample: false,
				recapture: false,
				end: "leave",
			};
	}
}

// ---- the surface ----------------------------------------------------------

/** A deck measurement and everything derived from it, cached together. */
interface DeckGeometry {
	rect: ScreenRect;
	k: number;
	layoutWidth: number;
	camera: CameraState;
}

interface Layers {
	/** Committed ink. Repainted on slide change, load, erase and resize only. */
	committed: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	/** The live stroke, through the real wet path (A2). */
	wetCanvas: HTMLCanvasElement;
	wet: WetInkRenderer;
	/**
	 * The head that reaches the nib, redrawn and erased every event. It cannot
	 * share the append-only wet canvas, which is why it is a third layer here
	 * exactly as it is on the note surface and the page view.
	 */
	tailCanvas: HTMLCanvasElement;
	tail: TailRenderer;
	/** Whose strokes are painted right now. */
	index: number;
	/**
	 * The canvases' css box, for the wet layer's clears. Derived back from the
	 * rounded backing store, so `cssWidth * ratio === backingW` exactly and a
	 * clear reaches the last column - not the raw `clientWidth`.
	 */
	cssWidth: number;
	cssHeight: number;
}

/**
 * One live presentation, watched. Lifetime is the `.slides-container` div's.
 *
 * Exported for the tests only - nothing outside this file constructs one, the
 * module-level controller below owns the single instance. The alternative was
 * leaving the load race, the geometry cache and the guard tail untestable: they
 * are all statements about a live deck, not about a pure function, and the suite
 * runs with no DOM, so the constructor's four arguments ARE the seam.
 */
export class SlidesDeck {
	/** slide index -> strokes, in deck-logical units. */
	private readonly strokes = new Map<number, InkStroke[]>();
	private layers: Layers | null = null;
	/**
	 * The last answer `measureDeckTheme` set, so `onSlidesCssChange` can tell
	 * a real flip from a `css-change` that left the deck's own paint alone.
	 * `null` until the first measurement (GAP 16).
	 */
	private deckDark: boolean | null = null;
	/** Re-entrancy guard for `ensureCanvasesMounted`'s one recursive step. */
	private remounting = false;
	/** The resolution media query armed by `watchResolution`, and its handler. */
	private mediaQuery: MediaQueryList | null = null;
	private mediaFn: (() => void) | null = null;
	/** The devicePixelRatio `mediaQuery` was armed for. NaN = nothing armed. */
	private watchedDpr = Number.NaN;
	private readonly disposers: Array<() => void> = [];
	private builder: StrokeBuilder | null = null;
	/**
	 * The nib this stroke opened with, held for its lifetime (§3.2).
	 *
	 * Read once at pen-down rather than per move: the pen path must not
	 * allocate, and the wet layer has to paint the stroke with the SAME style
	 * the builder was constructed with or the ink would change shape at pen-up.
	 */
	private activeStyle: PenStyle | null = null;
	private session: StrokeSession = IDLE_SESSION;
	private holdTimer: number | null = null;
	/**
	 * The silence deadline for the live contact (`SILENT_LIFT_QUIET_MS`).
	 *
	 * One self-rescheduling timer, armed at contact and re-armed from inside
	 * its own expiry, rather than a `clearTimeout`/`setTimeout` pair per
	 * sample: samples arrive at 120-240 Hz and that pair is real per-event work
	 * for a rule a subtraction answers exactly - the same trade `lastPenHoverAt`
	 * is written up for, with `lastPointerAt` playing the part of the
	 * timestamp. `holdPenGuard` already decides its own tail this way ("from
	 * the LAST event for it, not from here").
	 */
	private quietTimer: number | null = null;
	/** Whether the non-passive touchstart listener is on the deck. */
	private contactGuardArmed = false;
	/**
	 * Whether the pointerdown that fired most recently was a PEN.
	 *
	 * Every contact fires pointerdown before touchstart, so this is always
	 * fresh when the touchstart handler reads it. Cleared when the contact
	 * ends so a stray touchstart with no pointerdown before it cannot inherit
	 * a stale yes.
	 */
	private penContactPending = false;
	private awaitingPresent = false;
	private disposed = false;
	/** `ensureDeckFocused` moved the keyboard once already; log it once, not per call. */
	private deckFocusLogged = false;
	/** A pen owns the contact, whether or not it has become a stroke yet. */
	private penContact = false;
	/** A1: the contact crossed the slop or the clock, so it is ink. */
	private penStroke = false;
	/**
	 * A3: do we hold `setPointerCapture` for the live contact? False for the
	 * whole of a tap - capture is what retargets the pointerup and costs the
	 * arrow its click - and true from the moment the contact becomes a stroke.
	 */
	private capturedContact = false;
	private contactStart: { x: number; y: number; t: number } | null = null;
	private penGuardRelease: number | null = null;
	/**
	 * The fallback release for a stroke that ended without a `pointerup`.
	 *
	 * A hold expiry and a `leave` both COMMIT the stroke while the pen may
	 * still be down, and the guard used to be dropped with them - so the real
	 * lift that arrived afterwards brought a `click` that nothing was watching
	 * and the deck turned the page under the reader's hand. The guard now
	 * stands until that `pointerup` or until the pointer has been silent for
	 * PEN_GUARD_TAIL_MS, whichever comes first.
	 */
	private penGuardTail: number | null = null;
	/** Which pointer armed the guard, so a later lift can be recognised. */
	private guardPointerId: number | null = null;
	/**
	 * When a pen was last seen HOVERING, on the same clock as `now()`.
	 *
	 * A timestamp rather than a flag plus a timer, deliberately: hover samples
	 * arrive on the same ~200 Hz stream as ink, and a `clearTimeout` +
	 * `setTimeout` pair per sample is real per-event work for a rule that a
	 * subtraction answers exactly. `-Infinity` so the very first question -
	 * asked before any pen has ever hovered - is answered "not near" without a
	 * special case, which is `PalmGate`'s own initial value.
	 */
	private lastPenHoverAt = -Infinity;
	/** When a pen last LIFTED, for `PEN_RELEASE_TAIL_MS`. Same clock, same reason. */
	private lastPenLiftAt = -Infinity;
	/**
	 * The shape-based veto, live only where contact radii are calibrated.
	 *
	 * Attached to `.reveal` exactly as `PdfInkController` attaches it to its
	 * scroller, and for the same reason in a different shape: with no pen in
	 * the room the proximity rule cannot fire at all, so a hand resting on the
	 * glass to steady a presenter is an ordinary touch and Reveal turns the
	 * slide under it.
	 */
	private readonly palmShield = new PalmShield();
	/** Whether the shape rule is in force at all - see `armPalmShield`. */
	private palmShieldLive = false;
	/** When that pointer was last heard from, on the same clock as `now()`. */
	private lastPointerAt = 0;
	/**
	 * The deck's measured geometry AND the camera that comes out of it.
	 *
	 * Measured on mount, on every `refresh` (slide change, resize, load) and
	 * once per pen-down - never per sample. `getBoundingClientRect` forces
	 * layout, and the move path used to take two of them per pointermove while
	 * the compositor was already busy with the reader's ink; that is the cost
	 * §3.2 rules out and it scales with the deck, not with the stroke.
	 */
	private geom: DeckGeometry | null = null;
	/** The one point every coalesced sample is mapped into (§3.2). */
	private readonly samplePoint: SlidePoint = { x: 0, y: 0 };
	/**
	 * The move-path instrument (SlidesMoveTrace.ts), for the Orion mouse lag.
	 *
	 * The host is three arrow functions rather than a captured window,
	 * because a field initialiser cannot rely on `this.revealEl` having been
	 * assigned yet - a parameter property and a field initialiser are two
	 * different phases of the same constructor, and their order has changed
	 * under `useDefineForClassFields` before. Resolving the window per call
	 * is free next to the frame it belongs to, and only happens at all when
	 * the diagnostics switch is on.
	 */
	private readonly moveTrace = new SlidesMoveTrace({
		now: () => now(),
		requestAnimationFrame: (fn) => this.win().requestAnimationFrame(fn),
		cancelAnimationFrame: (h) => this.win().cancelAnimationFrame(h),
	});
	/** B1: this contact was claimed as the stylus's tail eraser end. */
	private erasing = false;
	/** How many strokes the live erase gesture has removed so far. */
	private erasedCount = 0;
	/** The slide's committed ink has changed and has not been painted yet. */
	private eraseDirty = false;
	/** The frame that will paint it, or null when none is pending. */
	private eraseFrame: number | null = null;

	// ---- identity and persistence ----
	private path: string | null = null;
	private pageId: string | null = null;
	private sidecarId: string | null = null;
	private basePage: PageData | null = null;
	private hashes: string[] = [];
	private deckSize: { width: number; height: number } | null = null;
	private claimInFlight: Promise<void> | null = null;
	/**
	 * The cold load or live reload, while it is running. Held, like the claim,
	 * because teardown has to be able to WAIT for it. `settle()` is the other
	 * reader.
	 */
	private loadInFlight: Promise<void> | null = null;
	/**
	 * Disposed, but a parked claim or load is still being drained: the deck's
	 * state (`strokes`, `sidecarId`, `basePage`) must survive until that write
	 * has gone out. `stale()` is the predicate every parked continuation asks.
	 */
	private draining = false;
	/** The teardown drain itself, for `settle()` to await. */
	private teardownDrain: Promise<void> | null = null;
	private memoryOnlyLogged = false;
	/** §3.5: the note we resolved is not the deck on screen. Memory only. */
	private noteMismatch = false;
	private saveFailureNoticed = false;
	/** One Notice per presentation for the read-only locks, like save failures. */
	private readOnlyNoticed = false;
	private futureLocked = false;
	/**
	 * Stroke ids adopted from the sidecar, including ids erased since adoption.
	 *
	 * `adoptSidecar` APPENDS (that is what lets a load-window stroke survive),
	 * so a SECOND adopt of the same sidecar - a live reload after another
	 * device wrote it - would double every stored stroke. These ids are what a
	 * reload replaces after its read succeeds. Read-window erases retain their
	 * ids here as well, so subsequent polls cannot resurrect a saved copy.
	 */
	private adoptedIds = new Set<string>();
	/**
	 * The load has finished and `sidecarId` may be written through.
	 *
	 * The gate, not decoration. `persist()` used to fire on `sidecarId` alone,
	 * and `sidecarId` used to be published one line BEFORE `adoptSidecar`
	 * awaited the store: a stroke drawn inside that window found an id, no
	 * `basePage`, and `snapshot()` falling back to `emptyPage`, so it scheduled
	 * a write of ONE stroke over the reader's whole sidecar - and did it before
	 * `damaged`/`futureVersion` had been seen, so the fail-closed lock could not
	 * stop it either. The id is now held in a local until the load returns, and
	 * a stroke drawn meanwhile waits here rather than racing it.
	 */
	private loaded = false;
	/** A save was asked for inside the load window; run it once the load lands. */
	private saveAfterLoad = false;
	/**
	 * Something reached `save()` since this deck was built: a stroke, an
	 * erase, or the deferred write a load-window stroke leaves behind.
	 *
	 * Teardown flushes only when this is true. A presented note with a page
	 * id but nothing drawn on it - or one whose sidecar loaded and was never
	 * touched - has nothing to write, and writing it anyway is a phantom
	 * sidecar (or a churned mtime) for no change at all.
	 *
	 * A claim or a load-window save PARKED at teardown counts as dirty even
	 * though it has not reached `save()`: both are opened by the reader's own
	 * stroke, and reading the flag literally is what silently lost the first
	 * mark on a never-inked note.
	 */
	private dirty = false;

	constructor(
		private readonly _container: HTMLElement,
		private readonly revealEl: HTMLElement,
		private readonly slidesEl: HTMLElement,
		private readonly host: SlidesInkHost
	) {
		if (diagnosticsEnabled()) {
			log(
				`deck found: container ${describe(_container)}, reveal ${describe(revealEl)}, ` +
					`slides ${describe(slidesEl)}, ${this.sections().length} section(s)`
			);
		}
		this.bind();
		// Reveal may not have marked a slide `present` yet. If it has - an
		// already-running deck - this mounts now; if it has not, the class
		// observer bound above does it the instant Reveal writes the class.
		this.remount();
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		const raf1 = win.requestAnimationFrame(() => {
			const raf2 = win.requestAnimationFrame(() => this.remount());
			this.disposers.push(() => win.cancelAnimationFrame(raf2));
		});
		this.disposers.push(() => win.cancelAnimationFrame(raf1));
		// A4: the active file is read NOW, at container time, not at the first
		// stroke. Start presentation acts on the active file, and by the time
		// the reader draws, the workspace behind the deck may have moved on.
		this.path = this.host.activeFilePath();
		if (diagnosticsEnabled()) log(`file resolved: ${this.path ?? "none"}`);
		// Held, not fired and forgotten: a stroke drawn in the load window
		// parks its write behind this promise, and teardown has to be able to
		// wait for it rather than dropping the ink (`settle`, `dispose`).
		this.loadInFlight = this.loadSidecar()
			.catch((err) => {
				log(`sidecar load failed: ${String(err)}`);
			})
			.finally(() => {
				this.loadInFlight = null;
			});
		// Take the keyboard once, at mount, without waiting for a first contact.
		// Obsidian dispatches its own synthetic `pointerdown` to set Reveal's
		// `focused` flag as part of building the presenter, but never moves DOM
		// focus off whatever the workspace had - typically the note's own
		// editor. Scheduled at 0ms, from the end of this constructor, so it runs
		// after both this constructor's own synchronous work AND that synthetic
		// pointerdown, on the very next turn. The existing pointerdown-time call
		// below is unchanged; this just closes the gap before a reader's first
		// contact.
		win.setTimeout(() => {
			if (this.disposed) return;
			this.ensureDeckFocused();
		}, 0);
	}

	private sections(): HTMLElement[] {
		return Array.from(this.slidesEl.children).filter(
			(el): el is HTMLElement => el.tagName.toLowerCase() === "section"
		);
	}

	// ---- load ------------------------------------------------------------

	/**
	 * Section hashes first, then the sidecar, then the remap.
	 *
	 * In that order because the remap needs both, and because the hashes are
	 * worth computing even when there is no sidecar: they are what the FIRST
	 * save writes, and without them the first presentation's ink would come
	 * back with no identity but its index.
	 */
	private async loadSidecar(): Promise<void> {
		const path = this.path;
		if (!path) {
			this.noteMemoryOnly(
				"no active file when the presentation opened",
				"the note it belongs to could not be identified"
			);
			this.finishLoad();
			return;
		}
		let sections: string[] | null = null;
		try {
			const source = await this.host.readSource(path);
			if (source !== null) sections = splitSlideSections(source);
		} catch (err) {
			// A note we cannot read still takes ink; it just keeps its slides
			// by index alone until the next presentation reads it.
			log(`could not read ${path} for section hashes: ${String(err)}`);
		}
		if (this.stale()) return;
		if (sections) {
			// §3.5: the note was a guess until here. Everything downstream of
			// this line writes Markdown or a sidecar keyed off it, so the guess
			// is checked BEFORE the first claim rather than after the wrong note
			// has been stamped.
			// Without the rendered frontmatter: Obsidian puts the note's own
			// properties into the FIRST slide's group, and every note that has
			// been inked carries `handwriting-page-id` there.
			const deckTexts = this.sections().map((s) => deckSectionText(s));
			if (!noteMatchesDeck(sections, deckTexts)) {
				// The counts alone never said WHICH side was wrong. The two
				// fingerprints do, and this runs once per presentation.
				const noteHead = normaliseSectionText(sections[0] ?? "").slice(0, 40);
				const deckHead = normaliseSectionText(deckTexts[0] ?? "").slice(0, 40);
				log(
					`note check failed: ${path}, deck ${deckTexts.length} sections vs ` +
						`note ${sections.length}; ink kept in memory; ` +
						`note "${noteHead}" vs deck "${deckHead}"`
				);
				this.noteMismatch = true;
				this.noteMemoryOnly("the resolved note does not match the deck on screen");
				// No load either: the sidecar under that note's id is some other
				// presentation's ink and painting it here would be the same
				// mistake in the other direction.
				this.finishLoad();
				return;
			}
			this.hashes = sections.map(sectionHash);
		}
		const pageId = this.host.readPageId(path);
		if (!pageId) {
			// Unclaimed. Nothing to load - the first stroke claims - and that
			// is not a failure, it is a note nobody has drawn on yet.
			if (diagnosticsEnabled()) log(`sidecar loaded: none (${path} carries no page id yet)`);
			this.finishLoad();
			return;
		}
		// A LOCAL, not the field: `this.sidecarId` is what `persist()` writes
		// through, and publishing it before the store has answered is what let
		// a stroke drawn in the load window overwrite the whole sidecar.
		const sidecarId = slidesSidecarId(pageId);
		const remapResult = await this.adoptSidecar(sidecarId);
		if (this.stale()) return;
		this.pageId = pageId;
		this.sidecarId = sidecarId;
		this.finishLoad();
		// The remap's INPUT is the stored hashes, and the remap itself never
		// writes: skip this and a note edited twice between presentations is
		// matched against hashes two edits stale next time. `finishLoad` may
		// already have flushed (a stroke landed during the load window), in
		// which case `this.strokes`/`this.hashes` - already current above -
		// rode that write and a second one here would be a bare duplicate.
		if (remapResult && !this.dirty && (remapResult.remapped > 0 || remapResult.hashesChanged > 0)) {
			this.persist();
			log(
				`remap persisted: ${remapResult.remapped} stroke(s) moved, ` +
					`${remapResult.hashesChanged} hash(es) changed`
			);
		}
	}

	/**
	 * The load is over: writes are allowed, and one that arrived early runs now.
	 *
	 * The early stroke is already MERGED rather than merging here: it went into
	 * `this.strokes` at commit time and `adoptSidecar` appends the stored ink to
	 * those same per-slide lists, so `snapshot()` sees both. All this has to do
	 * is let the write it deferred happen.
	 */
	private finishLoad(): void {
		if (this.loaded) return;
		this.loaded = true;
		if (!this.saveAfterLoad) return;
		this.saveAfterLoad = false;
		log("flushing the stroke(s) drawn while the sidecar was still loading");
		this.persist();
	}

	private async adoptSidecar(
		sidecarId: string,
		replaceAdopted = false
	): Promise<{ remapped: number; hashesChanged: number } | null> {
		const beforeIds = new Set<string>();
		if (replaceAdopted) {
			for (const id of this.adoptedIds) beforeIds.add(id);
			for (const list of this.strokes.values()) for (const s of list) beforeIds.add(s.id);
		}
		let result: ParseResult | null = null;
		const erased = new Set<string>();
		try {
			result = await this.host.loadSidecar(sidecarId);
		} catch (err) {
			log(`sidecar load failed for ${sidecarId}: ${String(err)}`);
			return null;
		} finally {
			// Remember read-window erases even when the read fails, so a retry
			// cannot bring an erased local stroke back from its saved copy.
			if (replaceAdopted && !this.stale()) {
				const remaining = new Set<string>();
				for (const list of this.strokes.values()) for (const s of list) remaining.add(s.id);
				for (const id of beforeIds) if (!remaining.has(id)) {
					erased.add(id);
					this.adoptedIds.add(id);
				}
			}
		}
		if (this.stale()) return null;
		if (!result) {
			if (diagnosticsEnabled()) log(`sidecar loaded: none (${sidecarId} has no file yet)`);
			return null;
		}
		if (result.damaged) {
			// Fail closed, the store's own rule, and there is genuinely nothing
			// to draw: `parsePage`'s catch arm hands back `emptyPage`, which is
			// a placeholder rather than the reader's ink. Ink still flows; it
			// just does not overwrite what we could not read.
			this.futureLocked = true;
			log(`sidecar loaded: REFUSED (damaged); ink this session is not saved`);
			this.noticeReadOnly(
				"Handwriting: this presentation's ink file could not be read, so new ink is not being saved."
			);
			return null;
		}
		if (result.futureVersion !== undefined) {
			// READ-ONLY, NOT INVISIBLE - InlineInkStore's rule, on the same
			// evidence ("this used to return here, so a note whose sidecar came
			// from a newer build showed NO ink at all - which reads as the data
			// loss the lock exists to prevent"). `parsePage` has already
			// migrated as much of the newer page as this build understands, and
			// `snapshot()` refuses outright for a future-locked deck, so
			// putting that ink on screen cannot lead to writing it back.
			//
			// The note surface's one exception - refusing to adopt ZERO strokes
			// out of a schema it does not fully understand - has no analogue
			// here: adoption APPENDS to the per-slide lists rather than
			// replacing them, so adopting nothing changes nothing.
			this.futureLocked = true;
			log(
				`sidecar loaded: READ-ONLY (schema v${result.futureVersion}); ` +
					`stored ink is shown, ink this session is not saved`
			);
			this.noticeReadOnly(
				"Handwriting: this presentation's ink was written by a newer Handwriting. " +
					"It is shown here but new ink is not being saved."
			);
		}
		// A live reload keeps the displayed ink until this read has succeeded.
		// Its starting ids also identify any ink erased during the await:
		// those ids must not be resurrected by the older disk snapshot.
		if (replaceAdopted) {
			for (const [index, list] of this.strokes) {
				const local = list.filter((s) => !this.adoptedIds.has(s.id));
				if (local.length > 0) this.strokes.set(index, local);
				else this.strokes.delete(index);
			}
			// Keep erased ids across later polls of the same older disk snapshot.
			this.adoptedIds = new Set(erased);
		}
		const page = result.data;
		this.basePage = page;
		if (page.deck) this.deckSize = page.deck;
		const stored = page.slides ?? [];
		const moved = this.hashes.length > 0 ? remapSlides(stored, this.hashes) : new Map<number, number>();
		const strokes = page.strokes.slice();
		const remapped = remapStrokes(strokes, moved);
		// Ids already on screen are SKIPPED, not appended. On a cold load this
		// is inert (nothing is on screen yet); on a live reload it is what
		// stops the reader's own ink - already written to the sidecar the other
		// device then edited - coming back a second time under the same id.
		const present = new Set<string>();
		for (const list of this.strokes.values()) for (const s of list) present.add(s.id);
		for (const s of strokes) {
			if (present.has(s.id) || erased.has(s.id)) continue;
			const index = slideOfPage(s.page);
			const list = this.strokes.get(index) ?? [];
			list.push(s);
			this.strokes.set(index, list);
			this.adoptedIds.add(s.id);
		}
		// §3.6's "keep the index" is two different outcomes and only the log can
		// tell them apart: ink parked past the end of the deck is invisible and
		// harmless, while ink kept at an index the edit has since filled with
		// OTHER content is now drawn on a slide it was not drawn on. Neither is
		// a data loss and neither earns a Notice, but a reader who sees ink in
		// the wrong place deserves a line that explains it.
		const { kept, visible } = this.hashes.length > 0
			? keptSlides(stored, this.hashes, moved)
			: { kept: 0, visible: 0 };
		log(
			`sidecar loaded: ${sidecarId}, ${strokes.length} stroke(s), ` +
				`${stored.length} slide(s), remapped ${remapped}` +
				(kept > 0
					? `, kept ${kept} slide(s) at their old index (ambiguous or no match), ` +
						`${visible} of them on a slide this deck still shows`
					: "")
		);
		this.repaint();
		// The remap's INPUT, not its output: `stored` is what the deck was
		// matched against just now, `this.hashes` is what it would be matched
		// against next time. Different lengths count as different at every
		// index past the shorter list's end - an added or removed slide is
		// exactly the case a stale sidecar must not paper over.
		let hashesChanged = 0;
		const hashCount = Math.max(stored.length, this.hashes.length);
		for (let i = 0; i < hashCount; i++) {
			if (stored[i]?.hash !== this.hashes[i]) hashesChanged++;
		}
		return { remapped, hashesChanged };
	}

	private noteMemoryOnly(why: string, plain = "the note does not match the deck"): void {
		if (this.memoryOnlyLogged) return;
		this.memoryOnlyLogged = true;
		// The log line is unchanged - it is what found the comment bug - and it
		// is no longer the ONLY signal. The failure matrix used to spend this
		// arm's Notice on the grounds that a reader who opened a presentation
		// from nowhere did not ask to be interrupted; the owner then drew
		// sixteen items across a presentation whose note held a `%%` comment
		// and lost all of it at Escape, having been told nothing (2026-09-06).
		// Silence is only kind when nothing is at stake, and here the whole
		// presentation's ink is. Once per deck, `noticeReadOnly`'s discipline,
		// and reset with the flag when a new deck is built.
		log(`memory only: ${why}; ink drawn here is not saved`);
		this.host.notify(
			`Handwriting: ink on this presentation is not being saved (${plain}). ` +
				"Close and reopen the presentation."
		);
	}

	// ---- binding ---------------------------------------------------------

	private bind(): void {
		// `slidechanged` is dispatched on the `.reveal` element itself and
		// bubbles. Listening on the element rather than reaching for the deck
		// object is the containment rule: no Reveal API is ever touched.
		const onSlideChanged = () => this.remount();
		this.revealEl.addEventListener("slidechanged", onSlideChanged);
		this.disposers.push(() =>
			this.revealEl.removeEventListener("slidechanged", onSlideChanged)
		);
		// `slidechanged` never fires for the slide the deck opens on, so on its
		// own it leaves slide 0 without ink. `ready` does fire, once.
		const onReady = () => this.remount();
		this.revealEl.addEventListener("ready", onReady);
		this.disposers.push(() => this.revealEl.removeEventListener("ready", onReady));
		// ...and the class itself, for the case `ready` has already gone by.
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		const classes = new win.MutationObserver(() => this.onPresentClassChanged());
		classes.observe(this.slidesEl, {
			subtree: true,
			attributes: true,
			attributeFilter: ["class"],
		});
		this.disposers.push(() => classes.disconnect());
		// Reveal's own resize, fired when k changes, plus the window's: the
		// canvas box is in screen px and the camera carries k, so both the
		// backing store and the camera want re-measuring (§3.4).
		const onResize = () => this.refresh();
		this.revealEl.addEventListener("resize", onResize);
		this.disposers.push(() => this.revealEl.removeEventListener("resize", onResize));
		win.addEventListener("resize", onResize);
		this.disposers.push(() => win.removeEventListener("resize", onResize));
		// B2: neither of the above fires for every way `.reveal`'s own box can
		// change - a pane resize, a sidebar toggling, an Obsidian layout
		// change - only Reveal's internal resize and the window's. A
		// ResizeObserver on `.reveal` itself catches those too, through the
		// SAME re-measure-then-repaint path (`refresh`), not a second one:
		// `refresh` already re-measures k and the offset (`syncGeometry`),
		// resizes both canvases' backing stores, and repaints, so there is
		// nothing for this observer to do but call it again. Calling it twice
		// for one real resize costs a redundant re-measure, never a race.
		if (typeof win.ResizeObserver !== "undefined") {
			const ro = new win.ResizeObserver((entries) => {
				if (diagnosticsEnabled()) {
					const box = entries[0]?.contentRect;
					log(
						`reveal resize observed: ${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "?"}`
					);
				}
				this.refresh();
			});
			ro.observe(this.revealEl);
			this.disposers.push(() => ro.disconnect());
		}
		// B2's other half, and the one no box observer can see: the ratio can
		// change while the box does not. Electron moves devicePixelRatio when
		// the window crosses onto a different-DPI monitor - plugging into a
		// projector mid-deck, unplugging from it, or Windows changing display
		// scale - and the `.reveal` box stays exactly the size it was in css
		// px, so `resize` never fires and the ResizeObserver never beats. Page
		// zoom IS covered by the observer above, because these canvases are
		// sized off the viewport and zoom changes the viewport's css size; a
		// monitor move is not. Same repair, same path: `refresh` re-reads the
		// ratio and re-sizes all three stores, so this arms nothing parallel.
		this.watchResolution();
		this.disposers.push(() => this.unwatchResolution());

		// Pointer routing. A capture-phase listener on the HOST decides, by
		// pointerType, whether to claim; on a claim it preventDefaults and
		// takes setPointerCapture. Unclaimed contacts are left completely
		// alone, so mouse clicks and touch swipes still reach Reveal.
		//
		// S4: no `stopPropagation`, ever. The bubbled pointerdown is what keeps
		// Reveal focused and the arrow keys alive.
		const handlers: Array<[string, (ev: Event) => void]> = [
			["pointerdown", (ev) => this.onPointerDown(ev as PointerEvent)],
			["pointermove", (ev) => this.onPointerMove(ev as PointerEvent)],
			["pointerup", (ev) => this.onPointerEnd(ev as PointerEvent, "up")],
			["pointercancel", (ev) => this.onPointerEnd(ev as PointerEvent, "cancel")],
			["lostpointercapture", (ev) => this.onPointerEnd(ev as PointerEvent, "lost-capture")],
			["gotpointercapture", (ev) => this.onPointerEnd(ev as PointerEvent, "got-capture")],
		];
		for (const [type, fn] of handlers) {
			this.revealEl.addEventListener(type, fn, { capture: true });
			this.disposers.push(() =>
				this.revealEl.removeEventListener(type, fn, { capture: true })
			);
		}

		// A1/S6: the navigation guard. Capture phase on `.reveal`, so it runs
		// before Reveal's own listeners wherever they sit - the arrow buttons
		// and the progress bar are descendants, and a capture-phase
		// stopPropagation on the ancestor never lets the event reach them.
		// Registered as its own listener rather than folded into the pointer
		// handlers, because `stopPropagation` does not stop the other listeners
		// on the element it is called on and the two must not be able to cancel
		// each other by registration order.
		// The UNION of the two guarded lists, registered blind: which rule an
		// event falls under - the stroke one, the palm one, or neither - is
		// `swallowDuringPenContact`'s decision and nothing else's. The lists
		// stay separate for the reason spelled out on
		// `PEN_CONTACT_GUARDED_EVENTS`; only the registration is shared,
		// because a listener that never swallows costs nothing.
		//
		// The guard runs AFTER the pointer handlers above on the same element
		// and the same phase (registration order), so `penContact` is already
		// true for the pen's own pointerdown by the time the palm rule is
		// asked about the next touch - and stopPropagation here cannot cancel
		// them, since it does not stop other listeners on the element it is
		// called on.
		const guard = (ev: Event) => this.onGuardedEvent(ev);
		for (const type of new Set([...PEN_GUARDED_EVENTS, ...PEN_CONTACT_GUARDED_EVENTS])) {
			this.revealEl.addEventListener(type, guard, { capture: true });
			this.disposers.push(() =>
				this.revealEl.removeEventListener(type, guard, { capture: true })
			);
		}

		// The native menu over a live deck. Its own listener and its own
		// element scope, because `onGuardedEvent` never calls preventDefault
		// and a menu is a default action - see `onDeckContextMenu`.
		const menu = (ev: Event) => this.onDeckContextMenu(ev);
		this.revealEl.addEventListener("contextmenu", menu, { capture: true });
		this.disposers.push(() =>
			this.revealEl.removeEventListener("contextmenu", menu, { capture: true })
		);

		this.armPalmShield();
		this.armGestureGuard();
	}

	/**
	 * The shape-based veto, on the platform condition the pdf surface uses.
	 *
	 * `palmRadiusTrustworthy` is the whole of the gate and it is imported, not
	 * restated: the 16px line is calibrated for Windows touch digitizers, an
	 * iPad reports the honest contact ellipse and every fingertip would read as
	 * a palm, and a Boox is the same. A deck presented on a Surface Pro is
	 * exactly the case it is calibrated for.
	 *
	 * Fail CLOSED when there is no `navigator` to ask. A window that cannot say
	 * what platform it is cannot have its radii trusted, and the shield's own
	 * doctrine is that a shield which cannot see palms must stay inert rather
	 * than start seeing them everywhere.
	 *
	 * `palmShieldLive` mirrors the decision for the POINTER half of the same
	 * rule (`palmShapedContact` in `onGuardedEvent`), which the shield itself
	 * cannot see: one platform question, one answer, two paths.
	 */
	private armPalmShield(): void {
		const nav = (this.revealEl.ownerDocument.defaultView ?? window)?.navigator;
		this.palmShieldLive = !!nav && palmRadiusTrustworthy(nav);
		if (this.palmShieldLive) this.palmShield.attach(this.revealEl);
		else this.palmShield.dispose();
		this.disposers.push(() => {
			this.palmShieldLive = false;
			this.palmShield.dispose();
		});
	}

	/**
	 * DECIDE AT CONTACT, NOT BEFORE IT. The deck keeps `touch-action: auto`.
	 *
	 * WHAT THIS REPLACES. The deck used to carry a standing `touch-action:
	 * none` plus a subtree rule forcing it on every descendant, armed on every
	 * presentation and conditional on nothing - so pinch, swipe and section
	 * scrolling were gone for every user, including one who has never owned a
	 * stylus. Alan, 2026-09-08: "oh hell nah that's not ok" / "it must work
	 * seamlessly".
	 *
	 * WHY A `touch-action` ANSWER CANNOT BE SEAMLESS. Measured by the latency
	 * seat on Chromium 151: `touch-action` is LATCHED AT CONTACT. Set after the
	 * contact's `touchstart` and the deck scrolls exactly like an unguarded
	 * control. So the value has to be committed before the pen lands, which is
	 * why it was unconditional, which is why touch paid for it.
	 *
	 * WHAT WORKS INSTEAD, and it needs no arming window at all. `pointerdown`
	 * fires BEFORE `touchstart` for the same contact and carries `pointerType`
	 * - so by the time `touchstart` runs, the page already knows whether a pen
	 * or a finger is landing. A `preventDefault()` in a NON-PASSIVE
	 * `touchstart` stops the pan with the deck at `auto`, measured 0px, and
	 * measured 0px INSIDE a nested `overflow:auto` scroller too, because it
	 * cancels the touch sequence rather than negotiating with an inherited
	 * value. That is why this route needs no `*` subtree rule: the Blink
	 * pan-x/pan-y OR-back is a `touch-action` problem and this is not one.
	 *
	 * `preventDefault` on `pointerdown` does nothing (measured, and it agrees
	 * with the hardware note in `ManipulationGuard.ts`) - it must be the
	 * `touchstart`.
	 *
	 * THE COST, NAMED. A non-passive `touchstart` listener makes the browser
	 * wait for the main thread before any finger gesture in the deck may
	 * begin: one frame on a healthy thread, up to Chrome's touch-ack timeout
	 * on a busy e-ink one. So it is registered ONLY on a device that has
	 * actually seen a pen - `penHardwareEver` is persisted per device
	 * (`PenToolsMode`), restored before any deck opens, and a synced `true`
	 * from another machine is deliberately ignored. A device that has never
	 * held a stylus never registers the listener and pays exactly nothing,
	 * which is stronger than making the handler cheap.
	 */
	private armGestureGuard(): void {
		this.disposers.push(() => this.disarmContactGuard());
		if (penHardwareEverSeen()) this.armContactGuard();
	}

	/** Idempotent: the first pen event arms, every later one is a no-op. */
	private armContactGuard(): void {
		if (this.contactGuardArmed || this.disposed) return;
		this.contactGuardArmed = true;
		// NON-PASSIVE on purpose: a passive listener may not preventDefault,
		// and preventDefault is the whole mechanism. Capture phase so it runs
		// before Reveal's own touch plugin, which is what would otherwise
		// carry the swipe.
		this.revealEl.addEventListener("touchstart", this.onDeckTouchStart, {
			capture: true,
			passive: false,
		});
	}

	private disarmContactGuard(): void {
		if (!this.contactGuardArmed) return;
		this.contactGuardArmed = false;
		this.revealEl.removeEventListener("touchstart", this.onDeckTouchStart, { capture: true });
	}

	/**
	 * The decision itself, and it is one boolean read.
	 *
	 * Bound once as a field so arm and disarm pass the SAME reference to
	 * add/removeEventListener - a fresh arrow per call would leave the
	 * listener attached for the life of the deck.
	 *
	 * `penContactPending` was set by the `pointerdown` that fired immediately
	 * before this, for this same contact. A finger returns here without
	 * touching the event, so the browser keeps the gesture and starts it on
	 * the compositor as usual.
	 */
	private readonly onDeckTouchStart = (ev: Event): void => {
		if (!this.penContactPending) return;
		ev.preventDefault();
	};

	/** A section's class list changed: repoint if that made a slide current. */
	private onPresentClassChanged(): void {
		if (this.disposed) return;
		const index = presentIndex(this.sections());
		if (index < 0) return;
		if (this.layers && this.layers.index === index) return;
		this.remount();
	}

	// ---- mounting and painting -------------------------------------------

	private remount(): void {
		if (this.disposed) return;
		const index = presentIndex(this.sections());
		if (index < 0) {
			if (!this.awaitingPresent) {
				this.awaitingPresent = true;
				if (diagnosticsEnabled()) log("no slide marked present yet; waiting for reveal to mark one");
			}
			return;
		}
		if (!this.layers && !this.mountCanvases(index)) return;
		const l = this.layers;
		if (!l) return;
		if (l.index !== index) {
			// The stroke in the reader's hand, FIRST and against the OLD index,
			// which `l.index` still is on this line. A clicker or an arrow key
			// changes the slide with no pointer event of any kind, so nothing
			// on the input path can see this coming.
			this.endStrokeForSlideChange();
			l.index = index;
			if (diagnosticsEnabled()) {
				log(
					`slide ${index} now present: repainting ` +
						`${(this.strokes.get(index) ?? []).length} stroke(s)`
				);
			}
		}
		this.refresh();
	}

	/**
	 * The deck is about to show another slide and a stroke or an erase is live.
	 *
	 * The note surface's rule for a stroke torn off its surface
	 * (`abandonActiveStroke` / `onStrokeAbandoned`, InlinePenRouter and
	 * InkOverlay): COMMIT it to the surface it started on, then clear the live
	 * layers and stand the guards down. Both halves matter and they are
	 * different bugs. Without the commit the ink is finished later against
	 * whichever index the layer carries by then, so the reader's sentence
	 * lands on the next slide. Without the clear the half-drawn wet line and
	 * the head on the tail canvas stay painted over the new slide until the
	 * stroke ends - and the committed layer under them has already been
	 * repainted for the new index, so the reader is looking at two slides at
	 * once.
	 *
	 * `commitStroke` does all of it, unchanged: it is the one funnel, it takes
	 * the OLD `l.index` because the caller has not moved it yet, and it clears
	 * both live canvases and releases the capture on the way through.
	 *
	 * The contact is still physically DOWN. Nothing here tries to end it: the
	 * session is idle after this, so its further moves are dropped at
	 * `onPointerMoveBody`'s pointer-identity test and start nothing on the new
	 * slide, and `commitStroke`'s `holdPenGuard` keeps the navigation guard up
	 * until the real lift - whose `click` would otherwise turn the page a
	 * SECOND time, one slide past where the reader asked to be.
	 *
	 * Persistence needs no special case: `persist` already parks behind a claim
	 * or a load in flight, and every parked continuation asks `stale()`.
	 * `remount` itself returns early once `disposed` is set, so a slide change
	 * cannot reach here during a teardown drain at all.
	 */
	private endStrokeForSlideChange(): void {
		const before = this.session;
		if (before.phase !== "drawing") return;
		const step = strokeSessionReducer(before, { kind: "slide-change", t: now() });
		this.session = step.state;
		this.syncHoldTimer();
		if (!step.end) return;
		this.commitStroke(before.pointerId ?? -1, step.end, before.samples);
	}

	/** Hang the three canvases over the `.reveal` viewport (A2). */
	private mountCanvases(index: number): boolean {
		const doc = this.revealEl.ownerDocument;
		const win = doc.defaultView ?? window;
		const make = (cls: string, z: string): HTMLCanvasElement => {
			const canvas = this.revealEl.createEl("canvas");
			canvas.className = cls;
			// `pointer-events:none` is not an optimisation, it is the routing
			// design: input is claimed on `.reveal`, never on a canvas. A
			// canvas that took pointers would sit between Reveal and its own
			// controls.
			Object.assign(canvas.style, {
				position: "absolute",
				left: "0",
				top: "0",
				pointerEvents: "none",
				// Above the sections and BELOW Reveal's controls (z-index 30ish),
				// so the arrows stay visible under ink drawn across them.
				zIndex: z,
			} as Partial<CSSStyleDeclaration>);
			return canvas;
		};
		const committed = make(COMMITTED_CLASS, "20");
		const wetCanvas = make(WET_CLASS, "21");
		// Above the wet layer and still below Reveal's controls: the head is
		// the newest ink and must not be painted under the strip behind it.
		const tailCanvas = make(TAIL_CLASS, "22");
		if (win.getComputedStyle(this.revealEl).position === "static") {
			// Reveal positions `.reveal` itself; this is defensive only. A
			// static one would put both canvases at the nearest positioned
			// ancestor's corner, which is the body.
			//
			// Restored on dispose, like the touch-action guard beside it: the
			// surface leaves no trace on somebody else's element, and a
			// `position` this file wrote outliving the presentation is a change
			// to Reveal's own layout that nobody would think to look here for.
			const saved = this.revealEl.style.position;
			this.revealEl.setCssStyles({ position: "relative" });
			this.disposers.push(() => {
				this.revealEl.setCssStyles({ position: saved });
			});
			if (diagnosticsEnabled()) log("reveal element was position:static; patched to relative");
		}
		// `.reveal` carries no tabindex of its own, so a later call from
		// `ensureDeckFocused` to take DOM focus is a silent no-op: the
		// deck never actually takes it, a caret left in the note behind the
		// presentation keeps it, and Reveal's own document keydown handler
		// returns early whenever `document.activeElement.isContentEditable` is
		// true. `-1`: focusable from script, never from Tab - this is a
		// presentation, not a form. A `.reveal` that already carries a tabindex
		// (a snippet, a Reveal plugin) is left exactly as it is.
		if (this.revealEl.tabIndex < 0 && !this.revealEl.hasAttribute("tabindex")) {
			this.revealEl.tabIndex = -1;
			if (diagnosticsEnabled()) log("reveal element had no tabindex; patched to -1");
		} else {
			if (diagnosticsEnabled()) {
				log(
					`reveal element already has a tabindex ` +
						`(${this.revealEl.getAttribute("tabindex") ?? this.revealEl.tabIndex}); left alone`
				);
			}
		}
		this.revealEl.appendChild(committed);
		this.revealEl.appendChild(wetCanvas);
		this.revealEl.appendChild(tailCanvas);
		const ctx = committed.getContext("2d");
		if (!ctx) {
			committed.remove();
			wetCanvas.remove();
			tailCanvas.remove();
			log("2d context refused; slides ink inert for this deck");
			return false;
		}
		let wet: WetInkRenderer;
		let tail: TailRenderer;
		try {
			wet = new WetInkRenderer(wetCanvas, SLIDES_DESYNCHRONIZED);
			// Both layers are plain (non-desynchronized) canvases: see
			// `SLIDES_DESYNCHRONIZED` above for the A/B InkOverlay ran on this
			// flag. The tail was never desynchronized in the first place - there
			// is no separate finding for it here.
			tail = new TailRenderer(tailCanvas);
		} catch (err) {
			committed.remove();
			wetCanvas.remove();
			tailCanvas.remove();
			log(`wet ink context refused (${String(err)}); slides ink inert for this deck`);
			return false;
		}
		wet.smooth = true;
		wet.shape = true;
		this.layers = {
			committed,
			ctx,
			wetCanvas,
			wet,
			tailCanvas,
			tail,
			index,
			cssWidth: 0,
			cssHeight: 0,
		};
		// The allocation this deck is about to ask for, beside the flag that
		// was measured against it. `syncGeometry` writes the stores a moment
		// later; this is the same arithmetic it will do, reported where a
		// reader looking at a blank deck will find it. `capped` is the whole
		// diagnosis for the silent-refusal failure: with no ceiling this
		// surface asked for three stores of whatever the display implied.
		if (diagnosticsEnabled()) {
			const vw = this.revealEl.clientWidth;
			const vh = this.revealEl.clientHeight;
			const mountDpr = win.devicePixelRatio || 1;
			const ratio = slidesBackingScale(vw, vh, mountDpr);
			const mountSize = computeCanvasSize(vw, vh, ratio);
			log(
				`mount: three canvases on ${describe(this.revealEl)}, starting on slide ${index}, ` +
					`wet desynchronized: requested ${wet.requested} actual ${wet.actualDesynchronized}, ` +
					`backing ${mountSize.backingW}x${mountSize.backingH} at ratio ${ratio.toFixed(3)} ` +
					`(dpr ${mountDpr}${ratio < mountDpr ? ", capped" : ""}), build ${this.host.buildId}`
			);
		}
		this.measureDeckTheme();
		return true;
	}

	/**
	 * Once per deck mount, plus once more per `css-change` that actually
	 * moves `.reveal`'s paint (`onCssChange`, GAP 16) - never per stroke,
	 * never per repaint or slide change otherwise: tell the ink layer which
	 * way the DECK is painted, because it is not the way the body is.
	 *
	 * Measured from the deck's own paint rather than from Obsidian's Appearance
	 * setting. The setting is what Obsidian consults (see BLACK_DECK_LINK), but
	 * it is one indirection away from the thing that matters, and a theme or
	 * snippet that restyles `.reveal` moves the paint without moving the
	 * setting. Luminance against `DARK_MAX_LUMINANCE` - the same threshold the
	 * ink itself is judged by, imported rather than copied - separates the two
	 * decks with room to spare: black.css's #191919 sits at 0.010 and
	 * white.css's #fff at 1.0.
	 *
	 * The override it sets is module-wide while the deck is live, so an editor
	 * pane repainting behind the presentation takes the deck's theme for that
	 * repaint. Accepted: a presentation covers the screen. `dispose` clears it.
	 */
	private measureDeckTheme(): void {
		const doc = this.revealEl.ownerDocument;
		const win = doc.defaultView ?? window;
		const rgb = opaqueRgb(win.getComputedStyle(this.revealEl)?.backgroundColor);
		if (rgb !== null) {
			this.setDeckTheme(relativeLuminance(rgb.r, rgb.g, rgb.b) < DARK_MAX_LUMINANCE, "measured");
			return;
		}
		// Nothing readable on `.reveal` itself. Which stylesheet the presenter
		// loaded says it just as well, and says it about the deck rather than
		// about the workspace behind it.
		const head: HeadLike | null = (doc as unknown as { head?: HeadLike | null }).head ?? null;
		if (typeof head?.querySelector === "function") {
			if (head.querySelector(BLACK_DECK_LINK)) return void this.setDeckTheme(true, "link");
			if (head.querySelector(WHITE_DECK_LINK)) return void this.setDeckTheme(false, "link");
		}
		// Neither: this is not the presenter we know about, so the body class is
		// the best evidence left and is what ink would have used anyway.
		this.setDeckTheme(isDarkTheme(doc), "body");
	}

	private setDeckTheme(dark: boolean, how: "measured" | "link" | "body"): void {
		this.deckDark = dark;
		setInkThemeOverride(dark);
		if (diagnosticsEnabled()) log(`deck theme: ${dark ? "dark" : "light"} (${how})`);
	}

	/**
	 * `css-change` re-arms the theme measurement (GAP 16): a theme or snippet
	 * switch mid-presentation restyles `.reveal` without remounting the deck,
	 * so nothing else calls `measureDeckTheme` again for the life of the
	 * presentation - the override taken at mount goes stale and ink is
	 * painted invisible against the new paint. Re-measure, and only reset the
	 * override and repaint when the answer actually changed, so a
	 * `css-change` for an unrelated reason (a font, a plugin's own CSS) costs
	 * one `getComputedStyle` and nothing else.
	 */
	onCssChange(): void {
		if (this.disposed) return;
		const before = this.deckDark;
		this.measureDeckTheme();
		if (this.deckDark !== before) this.repaint();
	}

	/** The deck's window. One place, so nothing has to spell it out again. */
	private win(): Window {
		return this.revealEl.ownerDocument.defaultView ?? window;
	}

	/**
	 * The deck rect, its pre-transform width and its scale, measured off
	 * `.slides` (S3).
	 *
	 * `layoutWidth` is carried out with the rect rather than re-read at the
	 * call site so that every mapping divides by a k measured off the SAME
	 * pair of numbers as the offset it subtracts.
	 */
	private measureGeometry(): DeckGeometry {
		// The move path's forced-layout counter. This method is the ONLY
		// forced layout reachable from a pointermove (through `geometry()`,
		// and only when the cache is empty), so a non-zero count in the trace
		// line is the whole finding: the cache was missed mid-stroke. Counted
		// once per entry rather than once per read - there are three reads
		// below - because the number that matters is zero versus not zero.
		this.moveTrace.countLayoutRead();
		const rect = this.slidesEl.getBoundingClientRect();
		const layoutWidth = this.slidesEl.clientWidth;
		const k = slideScale(rect, layoutWidth);
		// The camera is measured with the rect, not derived from it later: the
		// two used to be taken from separate `getBoundingClientRect` calls two
		// lines apart, which is both the second forced layout and the shape
		// that lets an offset drift from the k it is divided by.
		const camera = slideCamera(rect, this.revealEl.getBoundingClientRect(), k);
		const geom = { rect, k, layoutWidth, camera };
		this.geom = geom;
		return geom;
	}

	/** The cached geometry, measured on the spot only if there is none yet. */
	private geometry(): DeckGeometry {
		return this.geom ?? this.measureGeometry();
	}

	/** Re-measure, then redraw. The one entry point after any layout move. */
	private refresh(): void {
		this.syncGeometry();
		this.repaint();
	}

	/**
	 * Fire `refresh` when devicePixelRatio changes, and re-arm on the new one.
	 *
	 * A `(resolution: Ndppx)` query matches exactly while the ratio is N, so it
	 * flips the moment the ratio moves and only then - which is why both mature
	 * surfaces use one rather than polling. It is one-shot by nature (the new
	 * ratio does not match the old query either), so the handler re-arms
	 * itself, exactly as `InkOverlay.watchResolution` does.
	 *
	 * It calls `refresh`, the same path the resize listeners and the
	 * ResizeObserver call. Nothing about a ratio change is special: the css box
	 * is unchanged, the camera is unchanged (it carries k, A3), and all that is
	 * wrong is the raster density of three backing stores, which `syncGeometry`
	 * is already the sole owner of.
	 *
	 * Guarded on the method existing: this surface's window is a real one in
	 * Obsidian, but a host without `matchMedia` should lose the watcher, not
	 * the deck - the same shape as the `typeof win.ResizeObserver` guard.
	 */
	private watchResolution(): void {
		this.unwatchResolution();
		const win = this.win();
		const dpr = win.devicePixelRatio || 1;
		this.watchedDpr = dpr;
		if (typeof win.matchMedia !== "function") return;
		const mq = win.matchMedia(`(resolution: ${dpr}dppx)`);
		if (!mq || typeof mq.addEventListener !== "function") return;
		const fn = () => {
			if (this.disposed) return;
			if (diagnosticsEnabled()) {
				log(`devicePixelRatio changed from ${dpr} to ${this.win().devicePixelRatio || 1}`);
			}
			this.refresh();
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

	/**
	 * Size both canvases to the `.reveal` viewport, backing stores in device
	 * pixels.
	 *
	 * The context transform carries the EFFECTIVE device-pixel ratio alone; k
	 * rides in the camera (A3). So the wet layer's css-pixel clears stay honest
	 * for ink in the letterbox, where the logical coordinates are negative.
	 * "Effective" because `slidesBackingScale` reduces it when three
	 * full-viewport stores would blow the area budget - and because it is one
	 * number used four ways here (css box, backing store, `setTransform`, both
	 * `applyDpr` calls), a cap can never put the transform out of step with the
	 * store it is transforming into.
	 *
	 * The css box is derived BACK from the rounded backing store
	 * (`computeCanvasSize`, the same one the note surface and the page view
	 * use), never left at the raw measured size. Rounding the store while
	 * leaving the css box fractional - the obvious version - makes the ratio
	 * `round(w*r)/w` instead of `r`, and the compositor then resamples the
	 * whole full-viewport canvas every frame. `clientWidth` is integral, so
	 * this only bites when the RATIO is fractional: dpr 1.5 at 150% Windows
	 * scaling, any Obsidian zoom off zero, and now every capped ratio, which is
	 * fractional by construction. It also closes a second hole in the clears:
	 * `cssWidth * ratio` is now exactly `backingW`, so the last sub-pixel
	 * column and row are inside every clear instead of outside all of them.
	 */
	private syncGeometry(): void {
		this.measureGeometry();
		// Before anything is sized: the canvases the last sync sized may not be
		// in the document any more (see `ensureCanvasesMounted`). Re-mounted
		// ones are sized by the recursive call this makes, and then again,
		// identically, by the rest of this pass.
		if (!this.ensureCanvasesMounted()) return;
		const l = this.layers;
		if (!l) return;
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		const w = this.revealEl.clientWidth;
		const h = this.revealEl.clientHeight;
		if (w <= 0 || h <= 0) return;
		const dpr = win.devicePixelRatio || 1;
		// Belt and braces for the media query below: a dpr change that arrived
		// through a resize instead re-arms the watcher on the new value, so it
		// is never left listening for a resolution the display already left.
		if (dpr !== this.watchedDpr) this.watchResolution();
		const ratio = slidesBackingScale(w, h, dpr);
		const size = computeCanvasSize(w, h, ratio);
		const cssW = `${size.cssW}px`;
		const cssH = `${size.cssH}px`;
		l.cssWidth = size.cssW;
		l.cssHeight = size.cssH;
		for (const canvas of [l.committed, l.wetCanvas, l.tailCanvas]) {
			if (canvas.style.width !== cssW || canvas.style.height !== cssH) {
				canvas.style.width = cssW;
				canvas.style.height = cssH;
			}
			if (canvas.width !== size.backingW || canvas.height !== size.backingH) {
				canvas.width = size.backingW;
				canvas.height = size.backingH;
			}
		}
		l.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		l.wet.applyDpr(ratio);
		l.tail.applyDpr(ratio);
		// The deck size the theme actually produced, measured rather than
		// assumed to be Reveal's 960x700, and stored with the ink (§4).
		const deckW = this.slidesEl.clientWidth;
		const deckH = this.slidesEl.clientHeight;
		if (deckW > 0 && deckH > 0) this.deckSize = { width: deckW, height: deckH };
	}

	/**
	 * Are the three canvases still children of `.reveal`, and if not, put them
	 * back.
	 *
	 * `mountCanvases` used to be unreachable for the life of a presentation:
	 * `remount` gates it on `!this.layers` and only `dispose` ever nulls that.
	 * So if the host removed or replaced the canvases while `.reveal` survived,
	 * input kept working perfectly - capture, the palm guard and the tap rule
	 * all live on `.reveal`, not on a canvas - and nothing was painted. The
	 * reader draws invisibly for the rest of the deck, and the strokes DO reach
	 * the sidecar, so the ink turns up correctly the next time the note is
	 * presented and the report is unreproducible. `owns()`/`findDeck` catch the
	 * CONTAINER being swapped and nothing else; the body observer is
	 * deliberately non-subtree (S1), so a rebuild one level in is invisible to
	 * every signal this file has.
	 *
	 * Three property reads, no layout, no allocation, and NOT on the sample
	 * path: the two callers are `syncGeometry` and `repaint`, so this runs once
	 * per geometry sync and once per committed stroke or erase - never per
	 * pointer event. That is the cheapest place that still notices within one
	 * stroke of the damage. The pdf surface makes the same comparison, and
	 * makes it every paint (`PdfInkController`), which is the precedent.
	 *
	 * `parentElement !== revealEl` rather than `isConnected`: it answers the
	 * re-parented case too, and `.reveal` is the element every coordinate here
	 * is relative to, so being attached SOMEWHERE ELSE is just as wrong as
	 * being detached.
	 *
	 * Returns false when there is nothing to paint on - no layers, a remount
	 * refused a 2d context, or a remount is already in flight - so both callers
	 * bail exactly the way they always did on `!this.layers`.
	 */
	private ensureCanvasesMounted(): boolean {
		const l = this.layers;
		if (!l) return false;
		if (
			l.committed.parentElement === this.revealEl &&
			l.wetCanvas.parentElement === this.revealEl &&
			l.tailCanvas.parentElement === this.revealEl
		) {
			return true;
		}
		// `mountCanvases` ends in `syncGeometry` (through the caller), which
		// calls this again. One level, and the flag makes that explicit rather
		// than relying on the re-check above happening to be true by then.
		if (this.remounting) return false;
		this.remounting = true;
		try {
			const index = l.index;
			l.committed.remove();
			l.wetCanvas.remove();
			l.tailCanvas.remove();
			this.layers = null;
			log(`canvases no longer under ${describe(this.revealEl)}; remounting on slide ${index}`);
			if (!this.mountCanvases(index)) return false;
			// The fresh canvases are 0x0 until this runs, so a `repaint` that
			// triggered the remount would otherwise paint into nothing.
			this.syncGeometry();
		} finally {
			this.remounting = false;
		}
		return this.layers !== null;
	}

	/**
	 * Redraw the current slide's COMMITTED ink. Slide change, load, erase and
	 * resize only - never per sample (A2). That is the lag fix.
	 */
	private repaint(): void {
		if (!this.ensureCanvasesMounted()) return;
		const l = this.layers;
		if (!l) return;
		l.ctx.clearRect(0, 0, l.cssWidth || l.committed.width, l.cssHeight || l.committed.height);
		const cam = this.geometry().camera;
		for (const s of this.strokes.get(l.index) ?? []) {
			drawStroke(l.ctx, cam, s, undefined, true);
		}
	}

	// ---- input ------------------------------------------------------------

	private claims(ev: PointerEvent): boolean {
		return claimsContact(ev.pointerType, ev.isPrimary, ev.buttons, mouseInkEnabled());
	}

	/**
	 * A1 + the palm guard: swallow Reveal's navigation events - the ones a live
	 * pen STROKE produces, and every touch-shaped one for as long as a pen owns
	 * the contact at all.
	 */
	private onGuardedEvent(ev: Event): void {
		// `pointerType` is a PointerEvent member and this handler takes plain
		// Events: `click` and the `touch*` three simply do not have one, and
		// `undefined` is what the predicate's touch rows are written to expect.
		const pe = ev as PointerEvent;
		const pointerType = pe.pointerType;
		// The hover key, fed here rather than from `onPointerMove`: that one
		// returns early for every pointer that is not the active contact, and
		// a hovering nib is never the active contact. This listener sees the
		// raw stream because `pointermove` is in PEN_CONTACT_GUARDED_EVENTS.
		if (isPenHoverEvent(ev.type, pointerType, pe.buttons)) this.lastPenHoverAt = now();
		const at = now();
		// Shape first, and independent of the pen: this is the arm that works
		// with no pen in the room at all. Touch only, so S4's pen/mouse
		// pointerdown promise is untouched.
		if (
			this.palmShieldLive &&
			pointerType === "touch" &&
			PEN_CONTACT_GUARDED_EVENTS.includes(ev.type) &&
			palmShapedContact(pe.width, pe.height)
		) {
			ev.stopPropagation();
			return;
		}
		const swallow = swallowDuringPenContact(
			this.penOwnsGlass(at),
			this.penContact && this.penStroke,
			ev.type,
			pointerType
		);
		if (!swallow) return;
		ev.stopPropagation();
	}

	/**
	 * Is the glass the pen's right now - down, near, or just lifted?
	 *
	 * The three windows S4 names, in one place so the guard listener and the
	 * contextmenu listener cannot disagree about them. Only `penContact` is
	 * state the surface sets; the other two are subtractions.
	 */
	private penOwnsGlass(at: number): boolean {
		if (this.penContact) return true;
		if (penIsNear(this.lastPenHoverAt, at)) return true;
		return withinPalmReleaseTail(this.lastPenLiftAt, at);
	}

	/**
	 * The native menu over a live deck (`suppressDeckContextMenu`).
	 *
	 * Its own listener, not a row in `PEN_GUARDED_EVENTS`: `onGuardedEvent`
	 * ends in `stopPropagation` alone, and a context menu is a DEFAULT ACTION -
	 * only `preventDefault` can refuse it. Cancelling the pointerdown does not
	 * reach it either, per InlinePenRouter's hardware finding: Windows
	 * synthesises `contextmenu` AFTER pointerup, so it is not that
	 * pointerdown's default action to cancel.
	 *
	 * `stopPropagation` as well as `preventDefault`, matching the note
	 * surface: Obsidian's own menu is raised by a listener, not by the browser,
	 * and only the first of the two can refuse that. Capture on `.reveal`
	 * reaches every listener below it; a document-level handler above `.reveal`
	 * is out of this listener's range, which is a known and deliberate limit of
	 * binding here rather than on the window (the wiring comment above says why
	 * `.reveal` is the element this surface uses).
	 */
	private onDeckContextMenu(ev: Event): void {
		const at = now();
		if (
			!suppressDeckContextMenu({
				penDown: this.penContact,
				strokeLive: this.penContact && this.penStroke,
				penNear: penIsNear(this.lastPenHoverAt, at),
				pointerType: (ev as PointerEvent).pointerType,
			})
		) {
			return;
		}
		ev.preventDefault();
		ev.stopPropagation();
	}

	private armPenGuard(pointerId: number): void {
		this.clearGuardTimers();
		this.penContact = true;
		this.guardPointerId = pointerId;
		this.lastPointerAt = now();
	}

	private clearGuardTimers(): void {
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		if (this.penGuardRelease !== null) {
			win.clearTimeout(this.penGuardRelease);
			this.penGuardRelease = null;
		}
		if (this.penGuardTail !== null) {
			win.clearTimeout(this.penGuardTail);
			this.penGuardTail = null;
		}
	}

	/**
	 * Let go of the guard one tick after the contact ended.
	 *
	 * Not synchronously: the `click` that navigates is dispatched AFTER the
	 * pointerup, so a guard released in the pointerup handler would let through
	 * the one event it exists to stop - and a guard released a tick late is
	 * what lets a TAP's click reach the arrow, because a tap never set
	 * `penStroke` in the first place.
	 */
	private releasePenGuard(): void {
		if (!this.penContact || this.penGuardRelease !== null) return;
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		if (this.penGuardTail !== null) {
			win.clearTimeout(this.penGuardTail);
			this.penGuardTail = null;
		}
		this.penGuardRelease = win.setTimeout(() => {
			this.penGuardRelease = null;
			this.dropPenGuard();
		}, 0);
	}

	/**
	 * Keep the guard up after a stroke that ended WITHOUT a lift.
	 *
	 * A commit is not a lift: a cancel that outlived its hold window, or a
	 * `leave`, ends the stroke while the pen may still be on the glass, and the
	 * `pointerup` that eventually comes brings the `click` that turns the page.
	 * So the guard stands until that lift, or until the pointer has said
	 * nothing for PEN_GUARD_TAIL_MS - measured from the LAST event for it, not
	 * from here, because a hold expiry already spent its own 300 ms waiting.
	 */
	private holdPenGuard(): void {
		if (!this.penContact || this.penGuardRelease !== null) return;
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		if (this.penGuardTail !== null) win.clearTimeout(this.penGuardTail);
		const waited = now() - this.lastPointerAt;
		const wait = Math.max(0, PEN_GUARD_TAIL_MS - (Number.isFinite(waited) ? waited : 0));
		this.penGuardTail = win.setTimeout(() => {
			this.penGuardTail = null;
			this.dropPenGuard();
		}, wait);
	}

	private dropPenGuard(): void {
		this.penContact = false;
		this.penStroke = false;
		this.guardPointerId = null;
	}

	/**
	 * Make sure Reveal's deck already holds focus before we claim.
	 *
	 * Reveal's focus plugin focuses the deck FROM the pointerdown, and a
	 * document-level pointerdown outside `.reveal` blurs it. Doing it ourselves
	 * first, in the capture phase, means Reveal's own bubble-phase handler
	 * finds the deck already focused and the focus/blur cycle does not straddle
	 * the start of the stroke.
	 *
	 * Belt and braces: taking focus can still be a no-op - some snippet's CSS, a
	 * detached element, a browser quirk - and Reveal's own keydown handler
	 * returns early for `document.activeElement.isContentEditable` (or an
	 * input/textarea/select) regardless of whether `.reveal` itself ever took
	 * DOM focus. So when the active element is STILL outside `.reveal` after
	 * the attempt, and it is one of those, it is blurred: a deck that cannot
	 * take focus must at least free the keyboard.
	 */
	private ensureDeckFocused(): void {
		const doc = this.revealEl.ownerDocument;
		const before = doc.activeElement;
		if (before && this.revealEl.contains(before)) return;
		try {
			this.revealEl.focus({ preventScroll: true });
		} catch {
			/* not focusable; nothing to recover */
		}
		const after = doc.activeElement;
		if (after && this.revealEl.contains(after)) {
			this.logDeckTookFocus(before);
			return;
		}
		if (after && isTextEntryElement(after)) {
			after.blur();
			this.logDeckTookFocus(before);
		}
	}

	/** Once per deck, not once per pointerdown - `ensureDeckFocused` runs on every contact. */
	private logDeckTookFocus(from: Element | null): void {
		if (this.deckFocusLogged) return;
		this.deckFocusLogged = true;
		if (diagnosticsEnabled()) log(`deck took focus from ${from ? describe(from) : "none"}`);
	}

	private style(nib: SlideNib): PenStyle {
		const base = nib.tool === "highlighter" ? HIGHLIGHTER_PEN : DEFAULT_PEN;
		return { ...base, color: nib.color, baseWidth: nib.width };
	}

	private onPointerDown(ev: PointerEvent): void {
		// THE DECISION, RECORDED. This runs before the same contact's
		// `touchstart`, which is the whole basis of the route - see
		// `armGestureGuard`. It must be before the claim check, because a pen
		// the surface does not claim (a deck with nothing mounted) must still
		// not be arbitrated as a pan.
		this.penContactPending = ev.pointerType === "pen";
		if (ev.pointerType === "pen") markPenHardwareSeen();
		if (ev.pointerType === "pen") this.armContactGuard();
		if (!this.claims(ev) || this.session.phase === "drawing") return;
		const l = this.layers;
		if (!l) {
			log("UNEXPECTED pen down with nothing mounted (no slide marked present); ignored");
			return;
		}
		if (!insideRect(ev.clientX, ev.clientY, this.revealEl.getBoundingClientRect())) return;
		// preventDefault, never stopPropagation (S4): this suppresses the
		// compatibility mouse events and the text selection drag, while the
		// event still bubbles to `.reveal` and keeps the deck focused so the
		// arrow keys keep working. FIRST, before anything that could yield -
		// there is no await on this path and there must never be one, because a
		// preventDefault after the task that delivered the event is ignored.
		ev.preventDefault();
		// B1: the tail eraser end erases, and so does the tip while the
		// palette's Eraser mode is on - a pen without a tail end has no other
		// way to take ink off a slide. Everything else, including a held
		// barrel button (no lasso here), inks. Same test as InlinePenRouter's
		// `bandEraserIntent`, read once at contact - plus the mouse's own arm,
		// once mouse ink is on (`eraserIntent`, above).
		const erasing = eraserIntent(
			ev.pointerType,
			ev.buttons,
			ev.button,
			tipMode() === "eraser",
			mouseInkEnabled()
		);
		this.erasing = erasing;
		// Once per CONTACT, not per sample: a layout may have moved under the
		// deck without firing any of the events `refresh` listens for, and the
		// pen-down is the last moment that is cheap to be sure at.
		this.measureGeometry();
		this.armPenGuard(ev.pointerId);
		// A1: an erase contact waits on §3.3's slop/clock test exactly like an
		// ink one now - manual.md promises a pen TAP still turns the page or
		// closes the presentation, and that has to hold with the eraser end
		// down too, or the reader loses the close button the moment they pick
		// up the eraser. Until it is promoted (a move past the slop, or the
		// TAP_MS clock at the end) it is only a candidate erase and touches
		// nothing.
		this.penStroke = false;
		this.contactStart = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp };
		this.ensureDeckFocused();
		// A3: capture is NOT taken here unless the contact is already a stroke.
		// `setPointerCapture` retargets every later event for this pointer to
		// `.reveal`, so the browser computes the compatibility `click` from the
		// common ancestor of the pointerdown target (`.navigate-right`) and the
		// retargeted pointerup target (`.reveal`) - which is `.reveal` itself,
		// never the button. Reveal's Controls bind `click` on the buttons, so
		// the tap passed through (correctly, A1) and then landed on nothing.
		// An erase contact is promoted the same way, so it is just as capable
		// of being a tap and stays uncaptured until then.
		this.capturedContact = false;
		if (this.penStroke) this.capture(ev.pointerId);
		this.session = strokeSessionReducer(this.session, {
			kind: "down",
			pointerId: ev.pointerId,
			t: ev.timeStamp,
			captured: this.capturedContact,
		}).state;
		// The other half of the silent lift: a contact that stops reporting
		// altogether has no sample left for `silentLift` to read, so the only
		// witness is the clock. Armed for every claimed contact, ink or erase,
		// tap or stroke - a tap can be abandoned exactly as easily, and it
		// leaves the same stale session behind it (`onPointerDown` returns
		// early while one is live, so the reader's NEXT stroke is the one that
		// is lost).
		this.armQuietTimer(SILENT_LIFT_QUIET_MS);
		if (erasing) {
			// B1: no hit test yet - promotion (on move or at TAP_MS) decides
			// whether this contact ever touches the slide's ink at all.
			this.erasedCount = 0;
			return;
		}
		const nib = this.host.nib();
		this.activeStyle = this.style(nib);
		const { rect, layoutWidth, camera: cam } = this.geometry();
		const p = mapScreenToSlide(ev.clientX, ev.clientY, rect, layoutWidth, this.samplePoint);
		const fromMouse = ev.pointerType === "mouse";
		// The wet layer's shaping follows the DEVICE, per stroke, exactly as
		// the editor sets it at pen-down (`this.wet.shape = !fromMouse`,
		// InkOverlay.ts): a mouse stroke draws flat live, the same way it will
		// commit. `shape` was set once at MOUNT here, so a mouse stroke drew
		// SHAPED - velocity thinning and start taper, off a constant 0.5
		// pressure that is evidence for neither - while the hand moved, and
		// then turned flat the instant it committed, because
		// `StrokeRenderer.drawStroke` already exempts `stroke.device ===
		// "mouse"` and that is the tag the builder below writes. One stroke,
		// drawn two different ways. Set BEFORE `beginStroke`, which is where
		// `WetInkRenderer` latches it (`shapingThisStroke`) for the stroke.
		l.wet.shape = !fromMouse;
		// `device: "mouse"` (StrokeBuilder's own arg) tags the stroke the same
		// way the editor's does (InkOverlay.ts ~4835, ~7070): a mouse's steady
		// 0.5 pressure is not evidence to shape a width law from, and PageData
		// only round-trips the tag for a device it recognises as one.
		this.builder = new StrokeBuilder(
			nib.tool,
			nib.color,
			nib.width,
			undefined,
			fromMouse ? "mouse" : undefined
		);
		this.builder.start(ev.timeStamp);
		this.builder.add(p.x, p.y, ev.pressure, ev.timeStamp);
		l.wet.beginStroke(
			{ x: p.x, y: p.y, pressure: ev.pressure, t: ev.timeStamp },
			this.activeStyle,
			nib.tool === "highlighter",
			this.builder.resolvedPressureProfile
		);
		// The contact point, on screen from the first event. The wet layer
		// paints nothing until a segment settles - and when it does, it starts
		// at mid(p0, p1) - so without this the stroke's first half-segment is
		// missing live and arrives whole at pen-up, reading as a stub sprayed
		// backwards out of the pen. AFTER `beginStroke`, which is where the
		// shaper resets: `contactHalfWidth` reads it.
		//
		// This is the ONE head draw not gated on `head()`, so for a tap it is
		// the entire visible mark - hence `contactHalfWidth`, whose floor lives
		// in the wet layer and is not recomputed here (InkOverlay ~9002).
		l.tail.clear();
		l.tail.drawHead(
			cam,
			this.activeStyle,
			{ x: p.x, y: p.y },
			{ x: p.x, y: p.y },
			ev.pressure,
			l.wet.contactHalfWidth(this.activeStyle, ev.pressure)
		);
	}

	/**
	 * The live eraser radius from the host, falling back to the same default
	 * the inline surface starts at if the host ever answers something the
	 * circle math cannot use - a stale setting, not a reason to erase nothing.
	 */
	private eraserRadiusPx(): number {
		const r = this.host.eraserRadiusPx();
		return Number.isFinite(r) && r > 0 ? r : DEFAULT_ERASER_RADIUS_PX;
	}

	/**
	 * B1: erase whatever the eraser circle at this screen point touches on the
	 * CURRENT slide only - an erase gesture cannot outlive a slide change
	 * because it holds the navigation guard for its whole life (S6/A1 above).
	 *
	 * AMENDED 2026-09-05 (slide change): the guard is not the reason, and on
	 * its own it was never enough. It swallows POINTER and CLICK navigation,
	 * and the two commonest ways to turn a slide mid-gesture reach Reveal
	 * through neither: a presenter clicker is a keyboard, and so is the arrow
	 * key beside it. What makes the sentence true now is
	 * `endStrokeForSlideChange`, which ends the gesture as the index moves, so
	 * "the CURRENT slide" is still the only slide this ever touches - it just
	 * gets there by ending the gesture rather than by refusing the change.
	 *
	 * Whole-stroke or partial, whichever the NOTE surface is set to: the host
	 * answers `eraseWholeStrokes()` from the same `getEraserWholeStrokes()` the
	 * inline eraser reads, so the eraser behaves one way across the plugin
	 * rather than being silently whole-stroke-only on a deck. The two branches
	 * are `InkOverlay.eraseAt`'s two branches; the partial one is
	 * `partialEraseInSlide`, above.
	 *
	 * A2: this does NOT repaint. It answers whether the slide's ink changed and
	 * the CALLER repaints once, because a single pointermove carries several
	 * coalesced samples and repainting inside here fired a whole-canvas clear
	 * and redraw of every surviving stroke several times over inside one JS
	 * turn, before the browser painted once. Blank slide still costs nothing.
	 */
	private eraseAt(clientX: number, clientY: number): boolean {
		const l = this.layers;
		if (!l) return false;
		const list = this.strokes.get(l.index);
		if (!list || list.length === 0) return false;
		const { rect, layoutWidth } = this.geometry();
		const radiusPx = this.eraserRadiusPx();
		const hits = eraserHitsInSlide(list, clientX, clientY, rect, layoutWidth, radiusPx);
		if (hits.length === 0) return false;
		if (this.host.eraseWholeStrokes()) {
			const hitSet = new Set(hits);
			const remaining = list.filter((s) => !hitSet.has(s.id));
			if (remaining.length === list.length) return false;
			this.erasedCount += list.length - remaining.length;
			this.strokes.set(l.index, remaining);
			return true;
		}
		// The SAME ring the hit test just used: `eraserHitsInSlide` is this
		// call plus `strokesHitByCircle`, so the circle the split cuts with
		// cannot drift from the circle that reported the hit.
		const circle = slideEraseCircle(clientX, clientY, rect, layoutWidth, radiusPx);
		const cut = partialEraseInSlide(list, hits, circle, newStrokeId);
		if (cut.touched === 0) return false;
		this.erasedCount += cut.touched;
		this.strokes.set(l.index, cut.strokes);
		return true;
	}

	/**
	 * The current slide's ink changed under the eraser: paint it, once, on the
	 * next frame.
	 *
	 * Coalescing the repaint per MOVE was the first fix and it is not enough. A
	 * pen delivers moves at 120-240 Hz and the browser paints at 60, so a scrub
	 * across a busy slide still ran two, three, four full clear-and-redraw
	 * passes over every surviving stroke between one frame and the next, all
	 * but the last of which nobody ever saw. A dirty flag plus one
	 * `requestAnimationFrame` makes the work per FRAME, which is the rate the
	 * reader can actually perceive, and the cost stops scaling with the pen's
	 * report rate.
	 */
	private markErased(): void {
		this.eraseDirty = true;
		if (this.eraseFrame !== null) return;
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		this.eraseFrame = win.requestAnimationFrame(() => {
			this.eraseFrame = null;
			if (!this.eraseDirty || this.disposed) return;
			this.eraseDirty = false;
			this.repaint();
		});
	}

	/**
	 * Paint the pending erase NOW, cancelling its frame.
	 *
	 * At the lift and at teardown: the gesture is over, and leaving the last
	 * hit to a frame that a disposed deck will never run would show the reader
	 * ink that is no longer there.
	 */
	private flushErase(): void {
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		if (this.eraseFrame !== null) {
			win.cancelAnimationFrame(this.eraseFrame);
			this.eraseFrame = null;
		}
		if (!this.eraseDirty) return;
		this.eraseDirty = false;
		this.repaint();
	}

	/** setPointerCapture, with the refusal logged rather than swallowed. */
	private capture(pointerId: number): void {
		try {
			this.revealEl.setPointerCapture(pointerId);
			this.capturedContact = true;
		} catch (e) {
			log(`setPointerCapture refused: ${String(e)}`);
		}
	}

	/**
	 * The contact just became a stroke (A1). Capture it - once, whichever of
	 * the two promotion sites got there first: the slop test on a move, or the
	 * TAP_MS test when a motionless contact ends.
	 *
	 * A tap never reaches here, and that is the point: it runs its whole life
	 * uncaptured so its `click` is still aimed at the arrow it was aimed at.
	 */
	private promoteToStroke(pointerId: number): void {
		// The contact just became ink, which is the moment the frame clock
		// starts mattering. Before the switch is gated inside `begin`, so a
		// reader who never turned diagnostics on never starts a rAF loop.
		if (diagnosticsEnabled() && !this.moveTrace.active) this.moveTrace.begin();
		if (this.capturedContact) return;
		this.capture(pointerId);
	}

	/**
	 * The timed wrapper around the move handler.
	 *
	 * Separated from the body so the measurement brackets the WHOLE handler -
	 * the reducer step, the hold timer, the mapping loop, the ribbon fills
	 * and the head - rather than whichever part somebody already suspected.
	 * When the recorder is off `markHandlerStart` returns undefined after one
	 * boolean read and the body is called exactly as it was before.
	 */
	private onPointerMove(ev: PointerEvent): void {
		// A pen HOVER arms the listener before the tip ever lands. Unlike the
		// touch-action route this is not load-bearing - the pointerdown above
		// arms in time on its own, because the decision is made at contact
		// rather than committed before it. It only means the very first pen
		// contact on a never-seen-a-pen device is covered too.
		if (ev.pointerType === "pen") markPenHardwareSeen();
		if (ev.pointerType === "pen") this.armContactGuard();
		const startedAt = this.moveTrace.markHandlerStart();
		if (startedAt === undefined) {
			this.onPointerMoveBody(ev);
			return;
		}
		try {
			this.onPointerMoveBody(ev);
		} finally {
			this.moveTrace.endHandler(startedAt);
		}
	}

	private onPointerMoveBody(ev: PointerEvent): void {
		if (this.guardPointerId === ev.pointerId) this.lastPointerAt = now();
		if (this.session.pointerId !== ev.pointerId) return;
		// The lift that delivered no `pointerup` (`silentLift`), read before a
		// single thing is done with the sample - it is a hover sample, and the
		// builder, the wet ribbon and the head must never see one. Here rather
		// than in the guard listener that feeds `lastPenHoverAt`: that listener
		// runs AFTER these handlers on the same element (registration order),
		// so by the time it saw the hover the nib's flight would already be
		// inked. The hover KEY stays where it is, fed once from the raw stream
		// it needs, because it answers about a pointer that owns no session.
		if (ev.pointerType === "pen" && silentLift(ev.pressure, ev.buttons)) {
			this.endSilentLift(ev.pointerId, ev.timeStamp);
			return;
		}
		const l = this.layers;
		if (!l) return;
		const step = strokeSessionReducer(this.session, {
			kind: "move",
			pointerId: ev.pointerId,
			t: ev.timeStamp,
		});
		this.session = step.state;
		this.syncHoldTimer();
		if (step.recapture) this.capture(ev.pointerId);
		// A1: has the contact earned the right to be a stroke - ink or erase
		// alike? An erase contact takes exactly the same slop/clock test now
		// (B1), rather than the immediate promotion this used to give it.
		const start = this.contactStart;
		if (!this.penStroke && start) {
			this.penStroke = contactBecameStroke(
				ev.clientX - start.x,
				ev.clientY - start.y,
				ev.timeStamp - start.t
			);
			// A3: and with it, the capture that was withheld at pointerdown.
			// The pointer is still active, so this is legal here.
			if (this.penStroke) {
				this.promoteToStroke(ev.pointerId);
				// B1: ink folds its pointerdown point into the stroke regardless
				// of when promotion lands (`builder.add` at pointerdown, above) -
				// an erase has to do the same or the reader sees a gap exactly
				// where the promotion was decided, one hit test for the point
				// the contact started at, on top of whatever this move covers.
				if (this.erasing && this.eraseAt(start.x, start.y)) this.markErased();
			}
		}
		if (this.erasing) {
			// B1: still a candidate tap until promoted - touch nothing yet, and
			// leave its default action (and the click behind it) alone.
			if (this.penStroke) {
				// B1: scrub as the pen drags, one hit test per coalesced sample -
				// the same reason the ink path reads getCoalescedEvents. A2: the
				// hits accumulate across the whole loop the way `erasedCount`
				// does and the canvas is repainted ONCE after it, not once per
				// sample.
				const samples = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [];
				const list = samples.length > 0 ? samples : [ev];
				let erased = false;
				for (const s of list) {
					if (this.eraseAt(s.clientX, s.clientY)) erased = true;
				}
				if (erased) this.markErased();
			}
			ev.preventDefault();
			return;
		}
		if (!this.builder) return;
		const style = this.activeStyle;
		if (!style) return;
		// The cached measurement, taken at pen-down and at every layout move:
		// zero `getBoundingClientRect` on this path (A2, §3.2).
		const { rect, layoutWidth, camera: cam } = this.geometry();
		// Coalesced events matter more here than on the editor surface: the
		// deck runs its own rAF work and there is no prediction, so the dropped
		// samples would be visible as corners.
		const samples = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [];
		const list = samples.length > 0 ? samples : [ev];
		// Reported from here rather than re-derived by the wrapper: a second
		// `getCoalescedEvents()` would sit inside the timed window and inflate
		// the number this trace exists to establish.
		this.moveTrace.countSamples(list.length);
		for (const s of list) {
			const p = mapScreenToSlide(s.clientX, s.clientY, rect, layoutWidth, this.samplePoint);
			const point = this.builder.add(p.x, p.y, s.pressure, s.timeStamp);
			if (point) l.wet.appendPoint(cam, style, point);
		}
		// The live raw head, at the width the ribbon under it is being laid
		// down at - the wet layer reports it rather than the head guessing
		// from raw pressure (InkOverlay ~9073). `head()` answers undefined
		// when this stroke's centerline is raw, and then the wet ribbon
		// already reaches the nib and there is nothing to add.
		l.tail.clear();
		const head = l.wet.head();
		if (head) {
			l.tail.drawHead(
				cam,
				style,
				head.from,
				head.to,
				head.pressure,
				l.wet.liveHalfWidth(style, head.pressure)
			);
		}
		ev.preventDefault();
	}

	/**
	 * Every event that could end a stroke, plus the two capture events, funnel
	 * here so exactly one place decides - and logs - what happened.
	 *
	 * AMENDED 2026-09-05 (silent lift): "every event" is now every event that
	 * ANNOUNCES an ending. A hover sample ends a stroke too and arrives as a
	 * `pointermove` (`silentLift`, `onPointerMoveBody`), and the silence
	 * deadline ends one with no event at all (`onQuietExpired`). What is still
	 * true, and is the part that matters, is that all three run the same
	 * `commitStroke` - one place decides what a stroke's ending DOES, even
	 * though three places now recognise one.
	 */
	private onPointerEnd(
		ev: PointerEvent,
		kind: "up" | "cancel" | "lost-capture" | "got-capture"
	): void {
		// The contact is over, so the answer recorded for it expires with it.
		// Hygiene rather than a known hole: every contact fires pointerdown
		// before touchstart, so the flag is always rewritten before it is
		// read - but a stale `true` outliving its pen would swallow the next
		// finger's gesture, and that is not a failure worth leaving available.
		if (ev.pointerType === "pen") this.penContactPending = false;
		if (this.guardPointerId === ev.pointerId) {
			this.lastPointerAt = now();
			// The lift, whatever the stroke did. It is checked BEFORE the
			// session, because the stroke may already have been committed by a
			// hold expiry or a leave and this is still the event whose `click`
			// would navigate.
			//
			// The lift is also where the PALM half of the guard starts its own
			// tail (PEN_RELEASE_TAIL_MS): the nib leaves first and the heel of
			// the hand follows, so the moves the hand makes on its way up are
			// the ones that reach Reveal's swipe. Recorded here rather than
			// inside `releasePenGuard`, which declines to run at all when a
			// hold expiry already dropped the guard - the palm is on the glass
			// either way.
			if (kind === "up") {
				this.lastPenLiftAt = now();
				this.releasePenGuard();
			}
		}
		if (this.session.phase !== "drawing" || this.session.pointerId !== ev.pointerId) return;
		const before = this.session;
		const step = strokeSessionReducer(before, {
			kind,
			pointerId: ev.pointerId,
			t: ev.timeStamp,
		});
		this.session = step.state;
		this.syncHoldTimer();
		// Keep the DOM truth beside the reducer's belief: a theft means we no
		// longer hold it (the next move re-acquires, `step.recapture`), and a
		// grant means we do.
		if (kind === "lost-capture" || kind === "cancel") this.capturedContact = false;
		if (kind === "got-capture") {
			this.capturedContact = true;
			return;
		}
		if (!step.end) return;
		// A tap that lasted past TAP_MS is ink (or an erase) even though it
		// never moved: the deliberate dot, or the held eraser. Decided here
		// as well as on move because a motionless contact produces no move
		// events at all.
		const start = this.contactStart;
		if (!this.penStroke && start) {
			this.penStroke = contactBecameStroke(
				ev.clientX - start.x,
				ev.clientY - start.y,
				ev.timeStamp - start.t
			);
			// A3: the second promotion site. Today this only ever runs on the
			// `pointerup` that ends a motionless hold, so the capture it takes
			// is immediately released below and it is the pen guard, not the
			// capture, that stops that click reaching an arrow. It is taken
			// anyway so that "a contact that becomes a stroke is captured"
			// holds at BOTH sites rather than at whichever one is live today.
			if (this.penStroke) this.promoteToStroke(ev.pointerId);
			// B1: a held eraser promoted here has never run a hit test - no
			// move ever fired for it - so this is the one chance to erase
			// what is sitting under the point before the gesture commits.
			if (this.penStroke && this.erasing) {
				if (this.eraseAt(ev.clientX, ev.clientY)) this.markErased();
			}
		}
		this.commitStroke(ev.pointerId, step.end, before.samples);
	}

	/** The hold deadline fired: nothing more arrived, so the stroke is over. */
	private onHoldExpired(): void {
		if (this.disposed) return;
		const before = this.session;
		const step = strokeSessionReducer(before, { kind: "tick", t: now() });
		this.session = step.state;
		this.syncHoldTimer();
		if (!step.end || before.pointerId === null) return;
		this.commitStroke(before.pointerId, step.end, before.samples);
	}

	/** Mirror the reducer's `holdSince` onto a real timer. Idempotent. */
	private syncHoldTimer(): void {
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		if (this.session.holdSince === null) {
			if (this.holdTimer !== null) {
				win.clearTimeout(this.holdTimer);
				this.holdTimer = null;
			}
			return;
		}
		if (this.holdTimer !== null) return;
		this.holdTimer = win.setTimeout(() => {
			this.holdTimer = null;
			this.onHoldExpired();
		}, STROKE_HOLD_MS);
	}

	/**
	 * The nib is off the glass and no `pointerup` said so. End the stroke the
	 * way a lift ends it.
	 *
	 * The same three lines every other ending runs - the reducer decides, the
	 * hold timer is re-synced, `commitStroke` does the rest (capture released,
	 * the guard handed to its tail, both live canvases cleared, persist) - so a
	 * silent lift and a real one differ in the log line and nowhere else.
	 */
	private endSilentLift(pointerId: number, t: number): void {
		const before = this.session;
		const step = strokeSessionReducer(before, { kind: "silent-lift", pointerId, t });
		this.session = step.state;
		this.syncHoldTimer();
		if (!step.end) return;
		this.commitStroke(pointerId, step.end, before.samples);
	}

	/** Arm (or re-arm) the silence deadline. Idempotent; the last arm wins. */
	private armQuietTimer(waitMs: number): void {
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		if (this.quietTimer !== null) win.clearTimeout(this.quietTimer);
		this.quietTimer = win.setTimeout(() => {
			this.quietTimer = null;
			this.onQuietExpired();
		}, Math.max(0, waitMs));
	}

	private clearQuietTimer(): void {
		if (this.quietTimer === null) return;
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		win.clearTimeout(this.quietTimer);
		this.quietTimer = null;
	}

	/**
	 * The silence deadline fired: is the contact really silent, or did it just
	 * outlive the arm that was taken at pen-down?
	 *
	 * The deadline is armed ONCE per contact and asks `lastPointerAt` - the
	 * timestamp the move path already keeps for the guard - rather than being
	 * re-armed per sample. A pen that has been heard from since simply gets the
	 * remainder of its window and this costs one timer per 300 ms of stroke.
	 */
	private onQuietExpired(): void {
		if (this.disposed) return;
		const before = this.session;
		if (before.phase !== "drawing" || before.pointerId === null) return;
		const since = now() - this.lastPointerAt;
		if (Number.isFinite(since) && since < SILENT_LIFT_QUIET_MS) {
			this.armQuietTimer(SILENT_LIFT_QUIET_MS - since);
			return;
		}
		this.endSilentLift(before.pointerId, now());
	}

	/**
	 * The diagnostic Alan's mouse-only machine could not get by hand: what has
	 * the keyboard the instant a stroke ends, and does Reveal's own focus
	 * plugin (the `focused` class, its `keyboardCondition`) agree with the DOM.
	 */
	private logStrokeEndFocus(): void {
		if (diagnosticsEnabled()) {
			const active = this.revealEl.ownerDocument.activeElement;
			log(
				`focus at stroke end: active=${active ? describe(active) : "none"}, ` +
					`insideDeck=${active ? this.revealEl.contains(active) : false}, ` +
					`revealFocused=${this.revealEl.classList.contains("focused")}`
			);
		}
	}

	private commitStroke(pointerId: number, reason: StrokeEndReason, samples: number): void {
		const builder = this.builder;
		this.builder = null;
		this.activeStyle = null;
		const wasStroke = this.penStroke;
		const wasErasing = this.erasing;
		this.erasing = false;
		this.contactStart = null;
		// The contact is over however it ended, so its silence deadline is too.
		// Here rather than at each ending: this is the one funnel.
		this.clearQuietTimer();
		// The endings that are NOT a lift - a hold that expired, a leave, a
		// silent lift, a slide change - hand the guard to its tail rather than
		// dropping it: the pen may still be down, and its eventual `pointerup`
		// carries a `click` that would turn the page. A real lift has already
		// released it, above.
		//
		// AMENDED 2026-09-05: a silent lift is the one ending here where the
		// nib is known to be OFF the glass, and it still takes the tail. The
		// pen is hovering, the reader's hand is still over the deck, and the
		// tail costs a pen tap 300 ms of patience it would otherwise have spent
		// finishing the stroke that never ended. Dropping the guard on the spot
		// would be arguable; taking the tail is what makes "a commit is not a
		// lift" one rule instead of five.
		this.holdPenGuard();
		// A3: a tap runs uncaptured from end to end, so "nothing to release"
		// is a normal ending here, not a fault. The flag keeps this from
		// being a call the browser has to refuse on every tap.
		if (this.capturedContact) {
			this.capturedContact = false;
			try {
				this.revealEl.releasePointerCapture(pointerId);
			} catch {
				/* already released with the pointer */
			}
		}
		const l = this.layers;
		if (l) {
			// THE HANDOFF ORDER, named because it is the OPPOSITE of the note
			// surface's and was never written down (GAP 11). `StrokeHandoff.ts`
			// (`handoffFinishedStroke`) draws the committed stroke FIRST and
			// clears the transient layers after it - "never clear what replaces
			// a thing before the replacement exists" - and this surface clears
			// here, ~100 lines before `repaint()` puts the committed stroke on
			// the glass. That is deliberate and it is safe HERE for one reason
			// that has to stay true: `SLIDES_DESYNCHRONIZED` is false, so the
			// wet, tail and committed canvases are all plain canvases that
			// present together, and everything between this clear and that
			// repaint is synchronous in one task - no await, no rAF, no yield
			// (the 0 ms focus timer below is only SCHEDULED). Both halves land
			// in the same frame, so there is no frame in which the ink the
			// reader just drew is missing. Two changes break that and they are
			// the two to watch: flipping `SLIDES_DESYNCHRONIZED` back to true,
			// or putting anything that yields between here and the repaint. If
			// either happens, adopt `handoffFinishedStroke`'s order instead of
			// keeping this one - but note that the ordering is not free to
			// simply invert, because the tap and erase branches below RETURN
			// after this clear with no committed paint at all, and each would
			// need its own clear. Pinned by a clear-order test rather than left
			// to this comment.
			//
			// Boox mode clears the stroke's own box; everyone else keeps the
			// full clear until an e-ink user has confirmed the box on hardware.
			// The note surface's pen-up (`InkOverlay`, `predictionEinkOn()`)
			// and the pdf's make the identical split, and this surface has more
			// to lose by not making it: e-ink refreshes the region a frame
			// damaged, this wet canvas is the WHOLE VIEWPORT rather than the
			// note's editor column (see the backing-store note at the top of
			// this file), so a whole-canvas clearRect at every lift is a
			// whole-screen refresh - the ~800 ms freeze per stroke a NoteAir
			// reported (2026-09-01, `WetInkRenderer.clearStroke`). Off e-ink
			// `predictionEinkOn()` is false and this is byte-for-byte what it
			// always did.
			//
			// AMENDED (GAP 8): the sentence beside the tail clear used to read
			// "and whole rather than dirty-rect: every ending funnels through
			// here (a lift, a cancel, a hold expiry, a leave, the teardown), so
			// this is the one place that has to guarantee no head outlives the
			// stroke it belonged to". The guarantee stands and is still the
			// reason this is here; "whole rather than dirty-rect" is what is no
			// longer true in Boox mode. `TailRenderer.clear()` erases the box
			// it last painted, and the head is redrawn through that same dirty
			// rect on every pointer event (the two `l.tail.clear()` calls on
			// the contact and the live-head paths), so the box it holds at this
			// instant IS the head that would otherwise outlive the stroke.
			// `clearAll` stays the answer everywhere else, where a stale
			// dirty-rect costs nothing to over-clear.
			if (predictionEinkOn()) {
				l.wet.clearStroke(l.cssWidth, l.cssHeight);
				l.tail.clear();
			} else {
				l.wet.clear(l.cssWidth, l.cssHeight);
				l.tail.clearAll(l.cssWidth, l.cssHeight);
			}
		}
		// The stroke is over: stop the frame clock and print the one line.
		// Called on the `active` flag rather than on the switch, so a stroke
		// that started recording and had diagnostics turned off under it
		// still stops its rAF loop instead of running for the session.
		// `console.log` and not `log()` - the prefix is part of the line the
		// pure formatter is tested against, and log() would double it.
		if (this.moveTrace.active) {
			const line = this.moveTrace.end({
				cssWidth: l?.cssWidth ?? 0,
				cssHeight: l?.cssHeight ?? 0,
				dpr: this.win().devicePixelRatio || 1,
			});
			if (line) console.log(line);
		}
		// Alan, same machine, caret NOT in the note: arrows worked before the
		// stroke and stopped after it, so something ELSE also lets go of focus
		// somewhere between pen-down and here. Not diagnosed - but every
		// ending (a lift, a cancel, a hold expiry, a leave, the teardown) funnels
		// through this one place, so re-taking focus here covers it either way.
		// Focus recovery remains unconditional before and after the timer;
		// only the diagnostic recording inside `logStrokeEndFocus` is opt-in.
		this.logStrokeEndFocus();
		this.ensureDeckFocused();
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		// A pointerup's default action, or a click handler it triggers, can run
		// AFTER this handler and move focus again - the same race
		// `InkOverlay.focusEditorSoon` closes for the note editor. The 0ms
		// timer undoes whatever that later default did.
		win.setTimeout(() => {
			if (this.disposed) return;
			this.logStrokeEndFocus();
			this.ensureDeckFocused();
		}, 0);
		if (wasErasing) {
			if (!wasStroke) {
				// A1: an erase contact that never crossed the slop or the clock
				// is a tap, exactly like the ink branch below - nothing was
				// touched (there is nothing to flush; `eraseAt` never ran) and
				// the click passed through to Reveal or the close button.
				if (l) {
					if (diagnosticsEnabled()) {
						log(
							`erase end on slide ${l.index}: reason=tap, samples=${samples}, ` +
								`nothing touched (click passed through)`
						);
					}
				}
				return;
			}
			// The gesture is over: whatever the last frame did not get to is
			// painted now, and only then is the result saved.
			this.flushErase();
			// B1: one persist per gesture, at lift, never on the erase hot
			// path - the note surface's rule (InkOverlay.eraseAt/penUp).
			const erased = this.erasedCount;
			this.erasedCount = 0;
			if (!l) return;
			if (erased === 0) {
				if (diagnosticsEnabled()) {
					log(`erase end on slide ${l.index}: reason=${reason}, samples=${samples}, nothing touched`);
				}
				return;
			}
			if (diagnosticsEnabled()) {
				log(
					`erase end on slide ${l.index}: reason=${reason}, samples=${samples}, ` +
						`-${erased}, slide total ${this.strokes.get(l.index)?.length ?? 0}, ` +
						`deck total ${this.totalStrokes()}`
				);
			}
			this.persist();
			return;
		}
		if (!builder || !l) return;
		if (!wasStroke) {
			// A1: a TAP. Nothing is recorded and nothing was swallowed, so the
			// click that follows reaches Reveal's arrow or Obsidian's close
			// button exactly as a mouse click would.
			if (diagnosticsEnabled()) {
				log(`stroke end on slide ${l.index}: reason=tap, samples=${samples}, +0 (click passed through)`);
			}
			return;
		}
		// The inline surface's release filter, not plain `finish()`: the same
		// pens are in the room, and a stroke that ends with a hook of release
		// travel would look like a bug rather than the hardware artefact it is.
		const finished = builder.finishReleaseFiltered();
		if (finished.length > 0) {
			for (const s of finished) s.page = pageOfSlide(l.index);
			const list = this.strokes.get(l.index) ?? [];
			list.push(...finished);
			this.strokes.set(l.index, list);
		}
		this.repaint();
		if (diagnosticsEnabled()) {
			log(
				`stroke end on slide ${l.index}: reason=${reason}, samples=${samples}, ` +
					`+${finished.length}, slide total ${this.strokes.get(l.index)?.length ?? 0}, ` +
					`deck total ${this.totalStrokes()}`
			);
		}
		if (finished.length > 0) this.persist();
	}

	// ---- persistence ------------------------------------------------------

	/**
	 * Save, claiming the note's page id first if this is the first stroke.
	 *
	 * The reference must exist before the referent (InlineClaim's rule): the
	 * sidecar write waits for the id to be in the note's frontmatter. Strokes
	 * committed meanwhile ride the same record, so the one write that follows
	 * carries all of them.
	 */
	private persist(): void {
		if (this.futureLocked) return;
		// §3.5, before the path check: a mismatched note is not "no note", it is
		// the WRONG note, and the difference is a Markdown write on a file the
		// reader is not looking at.
		if (this.noteMismatch) {
			this.noteMemoryOnly("the resolved note does not match the deck on screen");
			return;
		}
		// The load window. Not `sidecarId`: the id is the thing being loaded
		// AGAINST, and writing on the strength of it alone is the overwrite this
		// gate exists to stop. `finishLoad` runs this again the moment the store
		// has answered, by which time `basePage` and the fail-closed lock are
		// both real.
		if (!this.loaded) {
			this.saveAfterLoad = true;
			return;
		}
		const path = this.path;
		if (!path) {
			this.noteMemoryOnly(
				"no active file when the presentation opened",
				"the note it belongs to could not be identified"
			);
			return;
		}
		if (this.sidecarId) {
			this.save(false);
			return;
		}
		if (this.claimInFlight) return;
		const proposed = this.host.newPageId();
		this.claimInFlight = this.host
			.claimId(path, proposed)
			.then(async (result) => {
				// `stale()`, not `disposed`: teardown DRAINS this claim rather
				// than abandoning it, because the stroke that opened it is
				// still only in memory (§ the `dirty` gate below).
				if (this.stale()) return;
				if (result.futureVersion !== undefined) {
					this.futureLocked = true;
					this.noticeReadOnly(
						"Handwriting: this note declares a newer Handwriting format. Ink drawn on it is not saved."
					);
					return;
				}
				this.pageId = result.pageId;
				// A LOCAL until the merge is done - the same fix the load path
				// carries (see `loaded` above). `persist()` tests `sidecarId`
				// BEFORE `claimInFlight`, so publishing it one line early let a
				// stroke lifted inside the awaited adopt schedule a write whose
				// `snapshot()` had no `basePage` yet: this session's strokes
				// alone, over the other device's whole sidecar, with the
				// store's conflict guard already disarmed by the read.
				const sidecarId = slidesSidecarId(result.pageId);
				// The note may already have had an id we never saw (another
				// pane, another device, a cold metadata cache). Its sidecar can
				// hold ink; merge it BEFORE our first write can overwrite it.
				if (result.pageId !== proposed) await this.adoptSidecar(sidecarId);
				if (this.stale()) return;
				this.sidecarId = sidecarId;
				// Disposed, but draining: the id is published (teardown's own
				// flush needs it) and the write is teardown's to make, once,
				// with the whole snapshot.
				if (this.disposed) return;
				this.save(true);
			})
			.catch((err) => {
				log(`save failed: could not claim a page id for ${path}: ${String(err)}`);
				this.noticeSaveFailure();
			})
			.finally(() => {
				this.claimInFlight = null;
			});
	}

	/** The page this deck would write right now, or null if it must not write. */
	private snapshot(): PageData | null {
		const sidecarId = this.sidecarId;
		if (!sidecarId || this.futureLocked) return null;
		const base = this.basePage ?? emptyPage(sidecarId);
		const strokes: InkStroke[] = [];
		for (const list of this.strokes.values()) strokes.push(...list);
		return {
			...base,
			pageId: sidecarId,
			surface: "slides",
			coordSpace: "slide-logical",
			...(this.deckSize ? { deck: this.deckSize } : {}),
			...(this.hashes.length > 0
				? { slides: this.hashes.map((hash, index) => ({ index, hash })) }
				: {}),
			strokes,
		};
	}

	private save(immediate: boolean): void {
		// Every caller reached here because something changed - a stroke
		// committed, an erase removed one, or a load-window write was deferred
		// and is running now. Teardown reads this to decide whether it has
		// anything to flush at all.
		this.dirty = true;
		// After teardown the DRAIN is the only writer. A parked claim or load
		// that lands post-dispose still runs through here (that is the point of
		// draining it), and a second, debounced copy of the same bytes would
		// only churn the sidecar's mtime behind the drain's immediate write.
		if (this.disposed) return;
		const page = this.snapshot();
		const sidecarId = this.sidecarId;
		if (!page || !sidecarId) return;
		if (!immediate) {
			this.host.scheduleSidecar(sidecarId, page);
			if (diagnosticsEnabled()) log(`save scheduled: ${sidecarId}, ${page.strokes.length} stroke(s)`);
			return;
		}
		if (diagnosticsEnabled()) {
			log(`save scheduled: ${sidecarId}, ${page.strokes.length} stroke(s) (first write after claim)`);
		}
		void this.host.saveSidecarNow(sidecarId, page).catch((err) => {
			log(`save failed: ${sidecarId}: ${String(err)}`);
			this.noticeSaveFailure();
		});
	}

	/** One Notice per presentation (failure matrix), and one log line each time. */
	private noticeSaveFailure(): void {
		if (this.saveFailureNoticed) return;
		this.saveFailureNoticed = true;
		this.host.notify("Handwriting: this presentation's ink could not be saved.");
	}

	/**
	 * The read-only locks say their piece ONCE, `noticeSaveFailure`'s rule.
	 *
	 * One flag for all three (damaged, future sidecar, future note) rather than
	 * one each: they are the same sentence to the reader - "this is shown but
	 * not saved" - and a deck that hits two of them in one presentation would
	 * otherwise stack Notices over the projected slide. A live reload re-reads
	 * the same sidecar every time the poll sees it change, which is exactly the
	 * repeat this guard exists to swallow.
	 */
	private noticeReadOnly(message: string): void {
		if (this.readOnlyNoticed) return;
		this.readOnlyNoticed = true;
		this.host.notify(message);
	}

	/**
	 * The deck is gone AND nothing parked is still being drained for it.
	 *
	 * Every continuation that outlives `dispose()` asks this instead of
	 * `disposed`: a claim or a load that the reader's own stroke is waiting
	 * behind has to be allowed to finish, publish its id and merge, or the
	 * stroke that opened it is lost. A bare `disposed` is still right for the
	 * last step - the WRITE - which teardown makes itself, once.
	 */
	private stale(): boolean {
		return this.disposed && !this.draining;
	}

	/** Everything a shutdown must wait for before it flushes the store. */
	inFlightWork(): Promise<unknown>[] {
		const out: Promise<unknown>[] = [];
		if (this.claimInFlight) out.push(this.claimInFlight);
		if (this.loadInFlight) out.push(this.loadInFlight);
		if (this.teardownDrain) out.push(this.teardownDrain);
		return out;
	}

	/**
	 * The sidecar this deck would let the live-reload poll re-read, or null.
	 *
	 * Deliberately narrow, and it is the poll's own re-check (main.ts) that
	 * makes it worth anything: the answer is a tick old by the time the stat
	 * comes back, so the caller asks again in the same microtask as the adopt.
	 */
	reloadCandidateSidecarId(): string | null {
		if (this.disposed || this.draining) return null;
		// Not loaded yet, or mid-claim: the cold load is the reload, and
		// re-entering `adoptSidecar` underneath it would interleave two merges
		// into the same per-slide lists.
		if (!this.loaded || this.loadInFlight || this.claimInFlight) return null;
		// Fail closed, both directions: a memory-only deck has no sidecar it is
		// entitled to read, and a future-locked one must not drop the lock by
		// re-reading (InlineInkStore.reloadExternal refuses for the same set).
		if (this.noteMismatch || this.futureLocked) return null;
		// A pen on the glass. Swapping the committed lists under a live stroke
		// is the one thing a reload can do that the reader would see.
		if (this.session.phase === "drawing" || this.erasing || this.eraseDirty) return null;
		return this.sidecarId;
	}

	/**
	 * Re-read a quiet deck through the cold load's adoption and save gate.
	 * Keep the live lists intact during I/O, then replace adopted ink only if
	 * the read succeeds. Local ink and erases made during the read survive.
	 * The tracked completion includes adoption and deferred saves so teardown
	 * can drain it, and a second poll cannot start an overlapping read.
	 */
	async reloadExternal(sidecarId: string): Promise<boolean> {
		if (this.reloadCandidateSidecarId() !== sidecarId) return false;
		const before = this.strokeFingerprint();
		this.loaded = false;
		let changed = false;
		const loading = this.adoptSidecar(sidecarId, true)
			.then((result) => {
				if (!this.stale() && result) changed = this.strokeFingerprint() !== before;
			})
			.finally(() => {
				this.loadInFlight = null;
				if (!this.stale()) this.finishLoad();
			});
		this.loadInFlight = loading;
		await loading;
		return changed;
	}

	/** Ids and slide numbers, in a stable order: does a reload change anything? */
	private strokeFingerprint(): string {
		const parts: string[] = [];
		for (const [index, list] of this.strokes) {
			for (const s of list) parts.push(`${index}:${s.id}`);
		}
		return parts.sort().join(",");
	}

	private totalStrokes(): number {
		let n = 0;
		for (const list of this.strokes.values()) n += list.length;
		return n;
	}

	/** Is this surface's presentation still the one in the document? */
	owns(container: Node): boolean {
		return this._container === container;
	}

	/**
	 * The element this deck is mounted in, read-only. `scanForSlides` uses
	 * this to tell "still attached, just not the document that got scanned"
	 * (a pop-out stealing focus) from "actually gone" (S1) - `owns()` alone
	 * cannot make that distinction because it takes the candidate as an
	 * argument instead of answering what the deck itself is attached to.
	 */
	get container(): HTMLElement {
		return this._container;
	}

	dispose(): void {
		if (this.disposed) return;
		// The stroke in the reader's hand, FIRST. Teardown is a closed
		// presentation and a closed presentation is usually a pen still on the
		// glass: dropping the builder here threw away the last stroke drawn,
		// silently, and the flush below then wrote the sidecar without it.
		// `commitStroke` is the same tail every other ending runs - the release
		// filter, the page number, the repaint, the log - so the stroke that
		// survives a teardown is the same stroke a lift would have produced.
		if (this.session.phase === "drawing" && (this.builder !== null || this.erasing)) {
			this.commitStroke(this.session.pointerId ?? -1, "leave", this.session.samples);
		}
		this.flushErase();
		this.disposed = true;
		this.session = IDLE_SESSION;
		this.syncHoldTimer();
		this.clearQuietTimer();
		this.clearGuardTimers();
		this.dropPenGuard();
		this.builder = null;
		this.activeStyle = null;
		// Flush before the canvases go: the debounce is 700 ms and a reader who
		// closes a presentation right after a stroke would otherwise lose it.
		// `saveNow` is the store's own no-quiet-period write, so this is a
		// flush and not a second copy of the write path.
		//
		// Only when something is actually dirty, though. A deck that changed
		// nothing - no sidecar loaded, and no stroke or erase this session -
		// has nothing to write, and writing it anyway is what turned "present a
		// note, press Escape" into a phantom `.slides.json` and every later
		// close into an unchanged rewrite.
		//
		// AMENDED (live-reload/settle slice): this used to read "`save()` is
		// the only place that sets it, and every path that changes what the
		// sidecar should hold already runs through `save()`". The second half
		// was never true. A stroke can park its write behind a first-stroke
		// claim or behind the load window and reach `save()` only when that
		// promise lands, which is after teardown - so `dirty` was false and the
		// stroke was dropped. Teardown now marks those two parked states dirty
		// itself and drains them below.
		// A claim or a load-window save that is still PARKED is dirt the flag
		// cannot see. Both are opened by the reader's own stroke - `persist()`
		// reaches the claim branch and the `!loaded` branch only from a commit
		// or an erase - and neither has reached `save()` yet, so a literal
		// reading of `dirty` logged "nothing changed, no write" and threw the
		// first mark on a never-inked note away. The gate stands; what counts
		// as dirty is what widens.
		const parked = this.claimInFlight ?? ((this.saveAfterLoad || this.dirty) ? this.loadInFlight : null);
		if (parked) this.dirty = true;
		if (this.dirty && parked) {
			// The deck's state is kept alive until the parked work lands: the
			// claim publishes the id and merges any sidecar the note turned out
			// to already have, and only then is there something to write. The
			// UI thread is not held - `dispose()` returns now, and `settle()`
			// is what a shutdown awaits.
			log(
				`teardown: ${this.strokes.size} slide(s) inked, ${this.totalStrokes()} stroke(s), ` +
					`waiting on the ${this.claimInFlight ? "page id claim" : "sidecar load"} before the write` +
					`${this.loaded ? "" : " (load never finished)"}`
			);
			this.draining = true;
			const drain = this.drainParkedWrite(parked);
			this.teardownDrain = drain;
			drains.add(drain);
			void drain.finally(() => drains.delete(drain));
		} else if (this.dirty) {
			const page = this.snapshot();
			if (page && this.sidecarId) {
				const id = this.sidecarId;
				void this.host.saveSidecarNow(id, page).catch((err) => {
					log(`save failed at teardown: ${id}: ${String(err)}`);
				});
			}
			log(
				`teardown: ${this.strokes.size} slide(s) inked, ${this.totalStrokes()} stroke(s), ` +
					`${this.sidecarId ? `flushed to ${this.sidecarId}` : "nothing to save"}` +
					`${this.loaded ? "" : " (load never finished)"}`
			);
		} else {
			log(
				`teardown: ${this.strokes.size} slide(s) inked, ${this.totalStrokes()} stroke(s), ` +
					`nothing changed, no write` +
					`${this.loaded ? "" : " (load never finished)"}`
			);
		}
		// The deck's theme dies with the deck. Cleared before the canvases go,
		// and unconditionally: a mount that never happened leaves the override
		// null already, and a `null` written over a `null` costs nothing.
		setInkThemeOverride(null);
		if (this.layers) {
			this.layers.committed.remove();
			this.layers.wetCanvas.remove();
			this.layers.tailCanvas.remove();
			this.layers = null;
		}
		this.moveTrace.dispose();
		for (const d of this.disposers.splice(0)) d();
		// Not while a drain is running: `snapshot()` reads these lists, and
		// clearing them here is what made the disposed-bails in the claim and
		// load continuations load-bearing (letting one through would have
		// written an EMPTY page). The drain clears them when it is done.
		if (!this.draining) this.strokes.clear();
	}

	/**
	 * Teardown's one write, made after the claim or load it was waiting on.
	 *
	 * The parked promise is the WHOLE chain, `finally` included, so by the time
	 * it resolves `sidecarId` is published and any sidecar the note already had
	 * is merged. `save()` refuses once `disposed` is set, so nothing else can
	 * have written in the meantime and this is the single flush.
	 */
	private async drainParkedWrite(parked: Promise<unknown>): Promise<void> {
		try {
			await parked;
			// A claim can end by parking a load (the merge), and a load can end
			// by starting a claim (`finishLoad` -> `persist`). One more round
			// covers that hand-off; beyond it the reader has gone.
			const second = this.claimInFlight ?? this.loadInFlight;
			if (second && second !== parked) await second;
			const page = this.snapshot();
			const id = this.sidecarId;
			if (page && id) {
				await this.host.saveSidecarNow(id, page);
				log(
					`teardown: parked write flushed to ${id}, ${page.strokes.length} stroke(s) ` +
						`(the claim/load landed after the deck was gone)`
				);
			} else {
				log(
					`teardown: parked write dropped - ${id ? "the deck is read-only" : "no page id was claimed"}`
				);
			}
		} catch (err) {
			log(`save failed at teardown: ${String(err)}`);
		} finally {
			this.draining = false;
			this.teardownDrain = null;
			this.strokes.clear();
		}
	}
}

// ---- module-level controller ----------------------------------------------

let enabled = false;
let observer: MutationObserver | null = null;
let deck: SlidesDeck | null = null;
let host: SlidesInkHost | null = null;
/**
 * Teardown drains of decks that are already gone.
 *
 * Module-level because `deck` is nulled the moment the container is detached,
 * and the write we are still waiting on belongs to that dead deck: a shutdown
 * that only asked the LIVE deck would report settled while the last stroke of
 * the presentation the reader just closed was still unwritten.
 */
const drains = new Set<Promise<void>>();

function log(message: string): void {
	console.log(`[slides] ${message}`);
}

/**
 * Monotonic clock on the same base as `event.timeStamp`, so the hold
 * arithmetic in the reducer compares like with like.
 */
function now(): number {
	return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function describe(el: Element): string {
	const cls =
		typeof el.className === "string" && el.className
			? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
			: "";
	return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}`;
}

/**
 * True for anything that would eat a keystroke Reveal expects for itself:
 * `document.activeElement.isContentEditable`, or the input-family elements a
 * browser also excludes from ordinary keydown handling the same way.
 */
function isTextEntryElement(el: Element): el is HTMLElement {
	if ((el as HTMLElement).isContentEditable) return true;
	const tag = el.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** The document the presentation would be built in (popout-aware, S1). */
function presentationDoc(): Document {
	const active = typeof activeDocument === "undefined" ? undefined : activeDocument;
	return active ?? document;
}

/**
 * Find a live presentation, or null.
 *
 * Selector list rather than one string: this is someone else's markup, and the
 * only thing that makes a future rename a one-line change is knowing which
 * candidate matched.
 */
function findDeck(
	doc: Document
): { container: HTMLElement; reveal: HTMLElement; slides: HTMLElement } | null {
	const container = doc.body?.querySelector<HTMLElement>(":scope > .slides-container");
	if (!container) return null;
	const reveal = container.querySelector<HTMLElement>(".reveal");
	if (!reveal) return null;
	const slides = reveal.querySelector<HTMLElement>(".slides");
	if (!slides) return null;
	return { container, reveal, slides };
}

/**
 * Re-check the document for a presentation.
 *
 * Idempotent and cheap, so the workspace events in main.ts can call it freely.
 * It is NOT the mount signal - see S1 - the observer is.
 *
 * A live deck is disposed only when ITS OWN container is gone, never because
 * a scan of some other document did not turn it up. Presenting on one screen
 * with notes in a pop-out on the other focuses that pop-out constantly, and
 * every focus change that fires the body observer used to scan the pop-out's
 * (empty) document, find nothing there, and tear down the still-live deck on
 * the presentation screen - ink kept flushing, but the canvases were gone and
 * drawing stayed dead until the presenter exited and re-presented.
 */
export function scanForSlides(): void {
	if (!enabled || !host) return;
	if (deck) {
		if (deck.container.isConnected) return;
		deck.dispose();
		deck = null;
	}
	// No live deck (or the old one just proved dead): look for a new one.
	// The active document first, then the main window's document too if
	// `activeDocument` has pointed us at a pop-out - the presentation is
	// still on the main screen even while a pop-out has focus.
	const active = presentationDoc();
	const found = findDeck(active) ?? (active !== document ? findDeck(document) : null);
	if (found) {
		deck = new SlidesDeck(found.container, found.reveal, found.slides, host);
	}
}

/**
 * main.ts's `css-change` handler (GAP 16): a theme switch or a snippet
 * toggle mid-presentation moves `.reveal`'s paint without remounting the
 * deck, and nothing else re-arms `measureDeckTheme` for a live deck. A
 * no-op with no deck live, so registering this beside the note-surface
 * fan-out costs nothing on every OTHER `css-change` this workspace fires.
 */
export function onSlidesCssChange(): void {
	deck?.onCssChange();
}

/** Whether slides ink is currently watching. */
export function slidesInkEnabled(): boolean {
	return enabled;
}

/**
 * The sidecar the live deck would let the live-reload poll re-read, or null.
 *
 * The poll in main.ts owns the timer for every surface; a deck presenting while
 * Syncthing writes its `.slides` sidecar rides that one tick rather than
 * keeping time of its own.
 */
export function slidesReloadCandidate(): string | null {
	return deck?.reloadCandidateSidecarId() ?? null;
}

/** Adopt an external `.slides` sidecar edit. True when the deck actually changed. */
export async function reloadSlidesExternal(sidecarId: string): Promise<boolean> {
	const live = deck;
	if (!live) return false;
	return live.reloadExternal(sidecarId);
}

/**
 * Wait for the live deck's parked claims, loads and teardown drains.
 *
 * `InlineInkStore.settle`'s shape and its reasons: bounded so a hung vault
 * write cannot wedge shutdown, several passes because a load can end by
 * starting a claim, and TRUE only when everything actually drained. A deck
 * disposed a moment ago is still in `drains` - its drain outlives the `deck`
 * binding, which `scanForSlides` nulls the instant the container goes.
 */
export async function settleSlidesInk(maxWaitMs = 2000): Promise<boolean> {
	let expire: (v: boolean) => void = () => {};
	const deadline = new Promise<boolean>((r) => {
		expire = r;
	});
	const scheduler = timerHost();
    const timer = scheduler.setTimeout(() => expire(true), maxWaitMs);
	try {
		for (let pass = 0; pass < 4; pass++) {
			const inFlight: Promise<unknown>[] = [...drains, ...(deck?.inFlightWork() ?? [])];
			if (inFlight.length === 0) return true;
			const timedOut = await Promise.race([
				Promise.all(inFlight).then(() => false),
				deadline,
			]);
			if (timedOut) return false;
		}
		return false;
	} finally {
		scheduler.clearTimeout(timer);
	}
}

/**
 * Turn slides ink on or off.
 *
 * Off is genuinely off: the observer is disconnected, the deck disposed (which
 * flushes its save), the canvases removed. With the setting off the observer is
 * never installed, so the whole cost of the feature to a reader who does not
 * present is its bundle size.
 */
export function setSlidesInk(on: boolean, next?: SlidesInkHost): void {
	if (next) host = next;
	if (on === enabled) return;
	enabled = on;
	if (!on) {
		observer?.disconnect();
		observer = null;
		deck?.dispose();
		deck = null;
		if (diagnosticsEnabled()) log("slides ink off");
		return;
	}
	if (!host) {
		// Nothing to draw with and nowhere to save: refuse rather than
		// installing an observer that would build a deck with no host.
		enabled = false;
		log("slides ink asked to start with no host; ignored");
		return;
	}
	const doc = presentationDoc();
	// The only reliable mount signal there is (S1). `childList` on `body`
	// alone: the container is a direct child, and a subtree observer on the
	// whole body during a presentation would fire on every Reveal transition.
	observer = new MutationObserver(() => scanForSlides());
	observer.observe(doc.body, { childList: true });
	if (diagnosticsEnabled()) log(`slides ink on; watching body for .slides-container, build ${host.buildId}`);
	scanForSlides();
}
