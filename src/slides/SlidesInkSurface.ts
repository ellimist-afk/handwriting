import { SlidesInkHistory } from "./SlidesInkHistory";
import { slideActionAvailable, type SlidesAction, type SlidesActions, type SlidesStatus } from "./SlidesActions";
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
 *     `slidesBackingScale` - devicePixelRatio, reduced when four
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
import {
	PalmShield,
} from "../input/PalmShield";
import { MAX_BACKING_AREA } from "../inline/ZoomScale";
import { DEFAULT_PEN, HIGHLIGHTER_PEN, PenStyle } from "../ink/PenStyle";
import { InkStroke, InkTool } from "../ink/Stroke";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { TailRenderer } from "../ink/TailRenderer";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { PageData } from "../model/PageData";
import type { LoadResult } from "../persistence/PageStore";
import { SlidesMoveTrace } from "./SlidesMoveTrace";
import { type StoredSlide } from "./SlidesSections";
import {
	IDLE_SESSION,
	type StrokeSession,
} from "./SlidesStrokeSession";
import { installSlidesPersistence } from "./SlidesPersistence";
import { installSlidesPenGuards } from "./SlidesPenGuards";
import { installSlidesMount } from "./SlidesMount";
import { installSlidesPointerPath } from "./SlidesPointerPath";
import { installSlidesBind } from "./SlidesBind";
import { describe, log, now } from "./SlidesController";

export const COMMITTED_CLASS = "handwriting-slides-ink";
export const WET_CLASS = "handwriting-slides-ink-wet";
/**
 * The transient layer above the wet one, holding the unsmoothed head that
 * reaches the nib. `WetInkRenderer`'s own header says the caller must draw it,
 * and this surface did not: the wet layer's first painted thing is a disc at
 * mid(p0, p1) (`flattenSegment` excludes a segment's start), while the commit
 * starts at p0 with a round cap. On a pen that gap is sub-pixel; on a mouse it
 * is a whole frame of hand travel, and the committed stroke appeared to spray
 * backwards out of where the wet line began.
 */
export const TAIL_CLASS = "handwriting-slides-tail";

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
export const BLACK_DECK_LINK = 'link[href*="/lib/reveal/black.css"]';
export const WHITE_DECK_LINK = 'link[href*="/lib/reveal/white.css"]';

/** Only the part of `document.head` the fallback uses, so fakes can supply it. */
export interface HeadLike {
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
export function opaqueRgb(value: unknown): { r: number; g: number; b: number } | null {
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
	mountTools?(parent: HTMLElement, actions: SlidesActions): () => void;
	/** Ranked note paths; the deck verifies their content before using one. */
	candidatePaths?(): string[];
	/** Kept for older hosts; the release host supplies candidatePaths. */
	activeFilePath?(): string | null;
	/** All live workspace documents, including popout windows. */
	documents?(): Document[];
	/** Calls back after a workspace window opens or closes. */
	onDocumentChange?(cb: () => void): () => void;
	/** The note's text, for the section hashes. */
	readSource(path: string): Promise<string | null>;
	/** The note's persisted page id from cheap metadata, or null. */
	readPageId(path: string): string | null;
	/** Atomically stamp (or discover) the page id in the Markdown. */
	claimId(path: string, proposedId: string): Promise<{ pageId: string; futureVersion?: number }>;
	/** A fresh page id to propose. */
	newPageId(): string;
	/** `transient` on a damaged result: the read threw, and the file may be healthy. */
	loadSidecar(sidecarId: string): Promise<LoadResult | null>;
	scheduleSidecar(sidecarId: string, page: PageData): void;
	/** Includes queued, in-flight, and failed writes awaiting retry. */
	hasQueuedSidecar?(sidecarId: string): boolean;
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
 * A2 puts all four canvases over the WHOLE viewport, so the largest pane the
 * plugin ever makes is allocated four times. A 5K panel is 14.7M per canvas
 * and a 6K one is 20.4M, past the silent refusal on its own.
 *
 * The note's number is reused rather than a third one invented. It is a
 * per-canvas budget, and four canvases at 10M is 40M device pixels - 160MB at
 * 4 bytes a pixel, below the note's five backing stores. This does not bound
 * the compositor's extra allocations for the opacity group. Each individual
 * canvas stays comfortably under 16M.
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

// ---- contact and eraser helpers (SlidesContact.ts) -------------------------

export {
	claimsContact,
	contactBecameStroke,
	eraserHitsInSlide,
	eraserIntent,
	isEraserContact,
	isPenHoverEvent,
	PALM_CONTACT_SWALLOW_PX,
	palmShapedContact,
	partialEraseInSlide,
	PEN_CONTACT_GUARDED_EVENTS,
	PEN_GUARD_TAIL_MS,
	PEN_GUARDED_EVENTS,
	PEN_NEAR_TAIL_MS,
	PEN_RELEASE_TAIL_MS,
	penIsNear,
	slideEraseCircle,
	suppressDeckContextMenu,
	swallowDuringPenContact,
	TAP_MS,
	TAP_SLOP_PX,
	withinPalmReleaseTail,
} from "./SlidesContact";
export type {
	SlideEraseCircle,
} from "./SlidesContact";

// ---- slide sections and note matching (SlidesSections.ts) ------------------

export {
	NOTE_CHECK_CHARS,
	NOTE_CHECK_COVERAGE_DENOMINATOR,
	NOTE_CHECK_COVERAGE_NUMERATOR,
	NOTE_CHECK_NEEDLE_CHARS,
	SLIDES_SIDECAR_SUFFIX,
	deckSectionText,
	keptSlides,
	noteMatchesDeck,
	pageOfSlide,
	remapSlides,
	remapStrokes,
	sectionHash,
	sectionHashes,
	slideOfPage,
	slidesSidecarId,
	splitSlideSections,
} from "./SlidesSections";
export type { DeckSectionEl, StoredSlide } from "./SlidesSections";

// ---- stroke session state machine (S5, the probe's, unchanged) ------------

export {
	IDLE_SESSION,
	SILENT_LIFT_QUIET_MS,
	STROKE_HOLD_MS,
	silentLift,
	strokeSessionReducer,
} from "./SlidesStrokeSession";
export type {
	StrokeEndReason,
	StrokeSession,
	StrokeSessionEvent,
	StrokeSessionStep,
} from "./SlidesStrokeSession";

/**
 * The contact the silence deadline ended, remembered so that a later sample from
 * the same pointer can write again. The deadline still
 * commits what was drawn and frees the session; this is only what the surface
 * needs to tell "the nib never left" from "a new contact", which always sends a
 * pointerdown.
 */
export interface RestedContact {
	readonly pointerId: number;
	/** The contact's own tool: an eraser contact that rests goes on erasing. */
	readonly erasing: boolean;
	readonly nib: SlideNib | null;
	/** Where and when the contact started, kept for a held dot that the deadline did not save. */
	readonly start: { x: number; y: number; t: number; pressure: number } | null;
	/** The contact had already become a stroke (or an erase) when the deadline ended it. */
	readonly promoted: boolean;
}


// ---- the surface ----------------------------------------------------------

/** A deck measurement and everything derived from it, cached together. */
export interface DeckGeometry {
	rect: ScreenRect;
	k: number;
	layoutWidth: number;
	camera: CameraState;
}

export interface Layers {
	/** Opaque highlights and their live stroke share one translucent group. */
	highlightGroup: HTMLElement;
	highlight: HTMLCanvasElement;
	highlightCtx: CanvasRenderingContext2D;
	wetTool: InkTool;
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
export class SlidesDeck implements SlidesActions {
	sourceUncertain = false;
	actionsReadBlocked = false;
	private actionRevision = 0;
	readonly history = new SlidesInkHistory();
	gestureBefore: { index: number; strokes: InkStroke[] } | null = null;
	readonly actionListeners = new Set<() => void>();
	get ownerDocument(): Document { return this.revealEl.ownerDocument; }
	status(): SlidesStatus {
		const live = !this.disposed && this._container.isConnected !== false;
		const index = this.layers?.index ?? -1;
		return { revision: this.actionRevision, pendingGesture: this.session.phase === "drawing" && this.penStroke, live, mutable: live && index >= 0 && this.loaded && !this.loadInFlight &&
			!this.claimInFlight && !this.futureLocked && !this.noteMismatch && !!this.path && !this.sourceUncertain && !this.actionsReadBlocked, index,
			currentCount: this.strokes.get(index)?.length ?? 0, totalCount: this.totalStrokes(),
			undoLabel: this.history.undoLabel, redoLabel: this.history.redoLabel };
	}
	finishGesture(): void { if (!this.disposed) this.endStrokeForSlideChange(); }
	repaintSettings(): void { if (!this.disposed) this.repaint(); }
	onChange(fn: () => void): () => void { this.actionListeners.add(fn); return () => { this.actionListeners.delete(fn); }; }
	actionsChanged(): void { this.actionRevision++; for (const fn of this.actionListeners) fn(); }
	run(action: SlidesAction): boolean {
		if (!this.status().mutable) return false;
		this.finishGesture();
		const status = this.status();
		if (!slideActionAvailable(status, action)) return false;
		let label: string | null;
		if (action === "undo" || action === "redo") {
			label = this.history[action](this.strokes);
		} else {
			const indexes = action === "clear-all" ? [...this.strokes.keys()] : [status.index];
			label = action === "clear-all" ? "Clear all presentation ink" : `Clear ink on slide ${status.index + 1}`;
			const changes = indexes.map(index => ({ index, before: this.strokes.get(index) ?? [], after: [] }));
			if (!this.history.record(label, changes)) return false;
			for (const index of indexes) this.strokes.delete(index);
		}
		if (!label) return false;
		this.repaint();
		this.persist();
		this.actionsChanged();
		this.host.notify(`Handwriting: ${action === "undo" ? "Undid " : action === "redo" ? "Redid " : ""}${label}`);
		return true;
	}
	recordGesture(label: string): void {
		const before = this.gestureBefore;
		this.gestureBefore = null;
		if (before) this.history.record(`${label} on slide ${before.index + 1}`, [{ index: before.index, before: before.strokes, after: this.strokes.get(before.index) ?? [] }]);
		this.actionsChanged();
	}

	/** slide index -> strokes, in deck-logical units. */
	readonly strokes = new Map<number, InkStroke[]>();
	layers: Layers | null = null;
	/**
	 * The last answer `measureDeckTheme` set, so `onSlidesCssChange` can tell
	 * a real flip from a `css-change` that left the deck's own paint alone.
	 * `null` until the first measurement (GAP 16).
	 */
	deckDark: boolean | null = null;
	/** Re-entrancy guard for `ensureCanvasesMounted`'s one recursive step. */
	remounting = false;
	/** The resolution media query armed by `watchResolution`, and its handler. */
	mediaQuery: MediaQueryList | null = null;
	mediaFn: (() => void) | null = null;
	/** The devicePixelRatio `mediaQuery` was armed for. NaN = nothing armed. */
	watchedDpr = Number.NaN;
	readonly disposers: Array<() => void> = [];
	builder: StrokeBuilder | null = null;
	/**
	 * The nib this stroke opened with, held for its lifetime (§3.2).
	 *
	 * Read once at pen-down rather than per move: the pen path must not
	 * allocate, and the wet layer has to paint the stroke with the SAME style
	 * the builder was constructed with or the ink would change shape at pen-up.
	 */
	activeStyle: PenStyle | null = null;
	session: StrokeSession = IDLE_SESSION;
	holdTimer: number | null = null;
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
	quietTimer: number | null = null;
	/** Whether the non-passive touchstart listener is on the deck. */
	contactGuardArmed = false;
	/**
	 * Whether the pointerdown that fired most recently was a PEN.
	 *
	 * Every contact fires pointerdown before touchstart, so this is always
	 * fresh when the touchstart handler reads it. Cleared when the contact
	 * ends so a stray touchstart with no pointerdown before it cannot inherit
	 * a stale yes.
	 */
	penContactPending = false;
	awaitingPresent = false;
	disposed = false;
	/** `ensureDeckFocused` moved the keyboard once already; log it once, not per call. */
	deckFocusLogged = false;
	/** A pen owns the contact, whether or not it has become a stroke yet. */
	penContact = false;
	/** A1: the contact crossed the slop or the clock, so it is ink. */
	penStroke = false;
	/**
	 * A3: do we hold `setPointerCapture` for the live contact? False for the
	 * whole of a tap - capture is what retargets the pointerup and costs the
	 * arrow its click - and true from the moment the contact becomes a stroke.
	 */
	capturedContact = false;
	contactStart: { x: number; y: number; t: number; pressure: number } | null = null;
	/** The nib the live ink contact opened with, kept so a rest can hand it to the contact's next stroke. */
	contactNib: SlideNib | null = null;
	/**
	 * The pointer whose contact the silence deadline ended, until it is heard from
	 * in a way that proves the nib left: its pointerup, a hover sample, a cancel, a
	 * pointerdown that starts a new contact (a palm's touch does not), a slide
	 * change, the end of a gesture, or dispose. Null otherwise.
	 */
	restedContact: RestedContact | null = null;
	penGuardRelease: number | null = null;
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
	penGuardTail: number | null = null;
	/** Which pointer armed the guard, so a later lift can be recognised. */
	guardPointerId: number | null = null;
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
	lastPenHoverAt = -Infinity;
	/** When a pen last LIFTED, for `PEN_RELEASE_TAIL_MS`. Same clock, same reason. */
	lastPenLiftAt = -Infinity;
	/**
	 * The shape-based veto, live only where contact radii are calibrated.
	 *
	 * Attached to `.reveal` exactly as `PdfInkController` attaches it to its
	 * scroller, and for the same reason in a different shape: with no pen in
	 * the room the proximity rule cannot fire at all, so a hand resting on the
	 * glass to steady a presenter is an ordinary touch and Reveal turns the
	 * slide under it.
	 */
	readonly palmShield = new PalmShield();
	/** Whether the shape rule is in force at all - see `armPalmShield`. */
	palmShieldLive = false;
	/** When that pointer was last heard from, on the same clock as `now()`. */
	lastPointerAt = 0;
	/**
	 * The deck's measured geometry AND the camera that comes out of it.
	 *
	 * Measured on mount, on every `refresh` (slide change, resize, load) and
	 * once per pen-down - never per sample. `getBoundingClientRect` forces
	 * layout, and the move path used to take two of them per pointermove while
	 * the compositor was already busy with the reader's ink; that is the cost
	 * §3.2 rules out and it scales with the deck, not with the stroke.
	 */
	geom: DeckGeometry | null = null;
	/** The one point every coalesced sample is mapped into (§3.2). */
	readonly samplePoint: SlidePoint = { x: 0, y: 0 };
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
	readonly moveTrace = new SlidesMoveTrace({
		now: () => now(),
		requestAnimationFrame: (fn) => this.win().requestAnimationFrame(fn),
		cancelAnimationFrame: (h) => this.win().cancelAnimationFrame(h),
	});
	/** B1: this contact was claimed as the stylus's tail eraser end. */
	erasing = false;
	/** How many strokes the live erase gesture has removed so far. */
	erasedCount = 0;
	/** The slide's committed ink has changed and has not been painted yet. */
	eraseDirty = false;
	/** The frame that will paint it, or null when none is pending. */
	eraseFrame: number | null = null;

	// ---- identity and persistence ----
	path: string | null = null;
	pageId: string | null = null;
	sidecarId: string | null = null;
	basePage: PageData | null = null;
	hashes: string[] = [];
	/** Stored identities whose slide cannot safely move into the current deck. */
	retainedSlides = new Map<number, StoredSlide>();
	/** A visible slide may keep an older storage slot when a deleted slide reserves its index. */
	visualSlots = new Map<number, number>();
	deckSize: { width: number; height: number } | null = null;
	claimInFlight: Promise<void> | null = null;
	/**
	 * The cold load or live reload, while it is running. Held, like the claim,
	 * because teardown has to be able to WAIT for it. `settle()` is the other
	 * reader.
	 */
	loadInFlight: Promise<void> | null = null;
	/** Only an outer rejection before completion permits a user-triggered retry. */
	initialLoadFailed = false;
	/**
	 * Disposed, but a parked claim or load is still being drained: the deck's
	 * state (`strokes`, `sidecarId`, `basePage`) must survive until that write
	 * has gone out. `stale()` is the predicate every parked continuation asks.
	 */
	draining = false;
	/** The teardown drain itself, for `settle()` to await. */
	teardownDrain: Promise<void> | null = null;
	memoryOnlyLogged = false;
	/** §3.5: the note we resolved is not the deck on screen. Memory only. */
	noteMismatch = false;
	saveFailureNoticed = false;
	/** One Notice per presentation for the read-only locks, like save failures. */
	readOnlyNoticed = false;
	futureLocked = false;
	/** A damaged live read holds writes until a good retry restores a trusted base. */
	reloadDamaged = false;
	/**
	 * The first read of the sidecar threw, so nothing has been adopted yet.
	 * A throw is not damage: the file may be healthy and not readable yet (a
	 * sync client mid-write, a cloud placeholder). The deck holds writes as for
	 * a damaged live read, says nothing, stays a poll candidate, and the next
	 * read runs as the first load rather than as a reload.
	 */
	coldReadPending = false;
	/** When the first read first threw, for the 60 s bound on the silence. Null otherwise. */
	transientSince: number | null = null;
	/** The "could not be read yet" notice was shown for the current hold. */
	transientNoticed = false;
	/** A successful live read waits here when the pen landed during its I/O. */
	reloadAfterStroke: (() => void) | null = null;
	/**
	 * Stroke ids adopted from or queued for the sidecar, including ids erased since adoption.
	 *
	 * `adoptSidecar` APPENDS (that is what lets a load-window stroke survive),
	 * so a SECOND adopt of the same sidecar - a live reload after another
	 * device wrote it - would double every stored stroke. These ids are what a
	 * reload replaces after its read succeeds. Read-window erases retain their
	 * ids here as well, so subsequent polls cannot resurrect a saved copy.
	 */
	adoptedIds = new Set<string>();
	/** Stroke ids in the latest snapshot submitted to the store's save queue. */
	queuedIds = new Set<string>();
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
	loaded = false;
	/** A save was asked for inside the load window; run it once the load lands. */
	saveAfterLoad = false;
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
	dirty = false;

	constructor(
		private readonly _container: HTMLElement,
		readonly revealEl: HTMLElement,
		readonly slidesEl: HTMLElement,
		readonly host: SlidesInkHost
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
		this.path = this.host.candidatePaths ? null : (this.host.activeFilePath?.() ?? null);
		const unmountTools = this.host.mountTools?.(this._container, this);
		if (unmountTools) this.disposers.push(unmountTools);
		if (diagnosticsEnabled()) log(`file resolved: ${this.path ?? "none"}`);
		// Held, not fired and forgotten: a stroke drawn in the load window
		// parks its write behind this promise, and teardown has to be able to
		// wait for it rather than dropping the ink (`settle`, `dispose`).
		void this.startInitialLoad();
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

	sections(): HTMLElement[] {
		return Array.from(this.slidesEl.children).filter(
			(el): el is HTMLElement => el.tagName.toLowerCase() === "section"
		);
	}

	// ---- binding ---------------------------------------------------------

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
	readonly onDeckTouchStart = (ev: Event): void => {
		if (!this.penContactPending) return;
		ev.preventDefault();
	};

	// ---- input ------------------------------------------------------------

	style(nib: SlideNib): PenStyle {
		const base = nib.tool === "highlighter" ? HIGHLIGHTER_PEN : DEFAULT_PEN;
		return { ...base, color: nib.color, baseWidth: nib.width };
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
}

installSlidesPersistence(SlidesDeck.prototype);
installSlidesPenGuards(SlidesDeck.prototype);
installSlidesMount(SlidesDeck.prototype);
installSlidesPointerPath(SlidesDeck.prototype);
installSlidesBind(SlidesDeck.prototype);

// ---- module-level controller (SlidesController.ts) ------------------------

export {
	activeSlidesActions,
	describe,
	drains,
	isTextEntryElement,
	log,
	now,
	onSlidesCssChange,
	reloadSlidesExternal,
	scanForSlides,
	setSlidesInk,
	settleSlidesInk,
	slidesInkEnabled,
	slidesReloadCandidate,
} from "./SlidesController";
