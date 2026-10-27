import { sideButtonErasesEnabled } from "./TipMode";
import { GuardDecision, ManipulationGuard } from "../input/ManipulationGuard";
import { PalmGate } from "../input/PalmGate";
import { PenSample } from "../input/PointerRouter";
import { visualToNote } from "./ZoomScale";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { VelocitySample } from "../input/Fling";

import { type ScrollCarry } from "./AssistScroll";
import { armGuardStyle, disarmGuardStyle } from "./GuardStyle";
import { HOVER_GHOST_MS } from "./PenCursor";
import { InkFeedArbiter } from "./InkFeed";
import { penGuardEatsEvent, penGuardReachesTarget, penGuardRoot } from "./PenGuardReach";
import { mouseActsAsPen, toolIsLit } from "./MouseInk";
import { MouseTrail } from "../input/MouseTrail";
import { deviceHasNeverSeenAPen } from "./PenToolsMode";
import { FINGER_INK_PRESSURE } from "./FingerInk";
import { installInlinePenRouterInput } from "./InlinePenRouterInput";
import { armWindowMirror, computedTouchActionNote, disarmWindowMirror, liveChromeDescribers, liveRouters, liveScrollers, liveSuppressedTypes, noteSuppressedNative, tr } from "./InlinePenRouterTrace";
import { installInlinePenRouterNav } from "./InlinePenRouterNav";
import { installInlinePenRouterBind } from "./InlinePenRouterBind";
import type { InlinePenCallbacks } from "./InlinePenCallbacks";
import { installInlinePenRouterEnd } from "./InlinePenRouterEnd";

/**
 * Pen capture for the inline overlay.
 *
 * This is deliberately NOT the canvas PointerRouter, although the pen path
 * mirrors it move for move. The difference is everything else: on the canvas,
 * Handwriting owns the whole surface, so touch pans the camera and mouse navigates.
 * On an ordinary note the EDITOR owns the surface. Touch must scroll and
 * place carets natively, the mouse must select text natively, and Handwriting may
 * claim the pen plus the note-only iPhone finger opt-in declared below.
 *
 * Rules:
 *   Pen tip      -> ink. Claimed in the CAPTURE phase on the editor's
 *                   scroller, before CodeMirror's own handlers (which live on
 *                   the child content element) can see it.
 *   Pen side    -> claimed: held at contact it lassos and moves ink.
 *   Pen eraser   -> claimed and swallowed (no ink, and no accidental
 *                   right-click storm from the eraser end).
 *   Touch        -> passed through/native-assisted navigation unless the palm
 *                   gate owns it, or the note host explicitly grants the first
 *                   iPhone finger to the selected nib. A second finger drops
 *                   that provisional ink and rejoins the existing pinch path.
 *   Mouse        -> native unless its explicit mode (or pen-less tool grant)
 *                   claims a fresh left contact while Keyboard mode is off.
 *
 * The pen hot path is byte-for-byte the frozen pipeline's shape: sync work
 * inside `pointerrawupdate`, coalesced samples, no allocation on move events
 * beyond the sample array.
 */

export type { InlinePenCallbacks } from "./InlinePenCallbacks";

/**
 * Pure: should a contact landing on the linked-mentions band claim as an
 * eraser? Eraser end and eraser mode say yes for the pen; the mouse only
 * when it is a pen (mouse ink) in eraser mode with the left button down.
 * Tip and side button stay native: tapping a backlink row with the pen must
 * keep clicking.
 */
export function bandEraserIntent(
	pointerType: string,
	buttons: number,
	button: number,
	eraserMode: boolean,
	mouseInk: boolean
): boolean {
	const eraserEnd = (buttons & 32) !== 0 || button === 5;
	if (pointerType === "pen") return eraserEnd || eraserMode || (sideButtonErasesEnabled() && (buttons & 2) !== 0);
	if (pointerType === "mouse") return eraserMode && mouseInk && (buttons & 1) !== 0;
	return false;
}

/**
 * The lifecycle trace and the window delivery mirror live in InlinePenRouterTrace.ts. Every exported name is re-exported here,
 * so no importer's import line changed.
 */
export {
	anyHandOnGlass,
	captureInlinePenTrace,
	clearInlinePenTrace,
	computedTouchActionNote,
	csOf,
	formatInlinePenTrace,
	liveRouters,
	summarizeAcquisitions,
	tr,
	traceSampleBudget,
	traceStripClick,
	traceSurface,
} from "./InlinePenRouterTrace";
export type { TraceCapture, TraceEntry, TraceEnv, TraceSample } from "./InlinePenRouterTrace";

// ---- gesture guard ---------------------------------------------------------
//
// The prime suspect for the cut-off strokes: the editor's scroller is a
// pannable region and does NOT carry `touch-action: none` (the canvas root
// did, and fingers must keep scrolling here, so it never can statically).
// For direct-manipulation pointers, `preventDefault` on pointerdown does not
// opt out of native panning. Only `touch-action` does. So once the pen drags
// past the browser's slop threshold, Chromium reclassifies the contact as a
// pan and fires `pointercancel`. Our end funnel then honestly commits a
// centimetres-long stroke.
//
// v0.12.10, STANDING GUARD (the cold-contact fix). The hover-reactive guard
// above was necessary but not sufficient: Chromium snapshots the allowed
// gestures from the COMMITTED compositor state at contact, so arming on hover
// only protects contacts whose approach hover got committed a frame earlier.
// A cold strike (no prior hover) reached pointerdown with panning still
// allowed, the pan won, and the first stroke scrolled instead of inking.
// Hardware-repeatable; hover-first was always fine. There is no reactive fix for
// a cold contact; the protection must already be committed. So the guard's
// RESTING state is now `touch-action: none`. Wheel/touchpad and mouse ignore
// touch-action entirely; palm-blocked touches never open the window.
//
// v0.12.12: the window opens on LIFT, not on touchStart. v0.12.10 restored
// touch-action the instant a non-palm-gated finger landed, and hardware
// showed the residual failure that bought: on a cold slam the hand's edge
// reaches the glass milliseconds before the pen tip, the palm gate cannot
// block it (no hover in its 300 ms window; cold means cold for the palm
// too), the window opened on that graze, and the tip then landed on a
// restored-pan snapshot and scrolled. Post-touchpad contacts are always cold
// (pen hover disables the touchpad, so the pen was necessarily away), which
// is why the failure tracked "immediately after touchpad scrolling"; the
// ~1 s recovery is the deliberate approach leading with hover. Now the whole
// first gesture runs under the standing none, carried end-to-end by the 1:1
// assist pan; the native window (subsequent gestures fully native, one-shot
// re-arm timer) opens only when the last finger lifts, and only if the
// gesture actually panned. A tap or resting palm never disarms the guard.
// A pen claim mid-gesture reclassifies the carried touch as palm.
//
// v0.13.6 RC3: the guard covers the scroller's SUBTREE too. Blink re-enables
// panning inside every nested scroll container (AdjustTouchActionForElement:
// an element whose own overflow is auto/scroll gets pan-x/pan-y OR'ed back
// into the touch-action it inherits, whether or not it has anything to
// scroll). Obsidian's editor has several: the embedded backlinks pane
// (`.backlink-pane`, overflow-y: auto), table widgets, math blocks, callout
// content, embeds. Inside them the standing `none` on `.cm-scroller`
// was silently `pan-y`/`pan-x` again: a pen drag with a vertical component
// past slop became a scroll gesture, the stroke died with pointercancel, and
// the whole band across "Linked mentions / No backlinks found / Unlinked
// mentions" read as dead (hardware, 2026-08-22). The style write is now
// GuardStyle.ts: inline none on the scroller plus a class that styles.css
// turns into none on every descendant, toggled together so the touch window
// still opens everywhere at once.

export let guardEnabled = true;

export function isPenGestureGuardEnabled(): boolean {
	return guardEnabled;
}

export function setPenGestureGuardEnabled(on: boolean): void {
	guardEnabled = on;
}

/** One-shot re-arm delay after the last finger lifts. */
const GUARD_REARM_MS = 1000;

// ---- native-event ownership -------------------------------------------------
//
// Once Handwriting has positively classified a pen contact (tip / side / eraser),
// it owns that interaction. Cancelling pointerdown on the scroller is not
// enough: Windows synthesises `contextmenu` AFTER pointerup (so the
// during-stroke check missed it, and every side-button gesture stacked an Obsidian
// menu), and Obsidian/CodeMirror register handlers at DOCUMENT level, above
// the scroller, so mouse-compat / drag / selection machinery could still react
// to a claimed contact (the eraser visibly dragged the editor caret).
//
// The ownership guard is a set of WINDOW-capture listeners (window precedes
// document in the capture phase, so they pre-empt app-level handlers) that
// suppress mouse-like fallout while a claimed stroke is active and for a short
// tail after it ends (trailing click/auxclick/contextmenu land post-pointerup).
// Armed at claim, disarmed after the tail: never a standing global hook
// (§40/§82), and mouse/touch behavior outside a pen gesture is untouched.

/** Mouse-like fallout a claimed pen gesture must never leak to the app. */
const OWNED_NATIVE_EVENTS = [
	"mousedown",
	"mousemove",
	"mouseup",
	"click",
	"auxclick",
	"dblclick",
	"dragstart",
	"selectstart",
	"contextmenu",
] as const;

/** Trailing window after pen-up in which click/contextmenu fallout still lands. */
const OWNERSHIP_TAIL_MS = 350;

/** Pure decision, unit-tested: does Handwriting own native fallout right now? */
export function ownsNativeFallout(opts: {
	activeStroke: boolean;
	now: number;
	ownershipTailUntil: number;
}): boolean {
	return opts.activeStroke || opts.now < opts.ownershipTailUntil;
}

/**
 * Pure decision, unit-tested: suppress this owned-event dispatch?
 *
 * v0.13.2: touch-origin exemption in the tail. The post-stroke tail
 * exists for the PEN's trailing fallout (click/contextmenu land after
 * pointerup) and stray mouse compat events. A FINGER tapping right after
 * pen-up is the user placing the caret. Eating it made the pen-to-touch
 * handoff feel dead for a third of a second. During an active stroke everything is
 * still suppressed (that finger is a palm).
 */
export function suppressNativeFallout(opts: {
	activeStroke: boolean;
	now: number;
	ownershipTailUntil: number;
	fromTouch: boolean;
}): boolean {
	if (opts.activeStroke) return true;
	if (opts.now >= opts.ownershipTailUntil) return false;
	return !opts.fromTouch;
}

/**
 * Pure decision, unit-tested: suppress this contextmenu event?
 *
 * Yes when a claimed gesture owns the moment, when the event itself is
 * pen-sourced (Chromium ≥115 delivers contextmenu as a PointerEvent), or when
 * a pen is writing or hovering, because a side-button press while hovering raises
 * the menu with no contact to claim. An ordinary mouse right-click away from the pen is
 * never suppressed.
 */
export function contextMenuSuppressed(opts: {
	activeStroke: boolean;
	now: number;
	ownershipTailUntil: number;
	pointerType: string | undefined;
	penNear: boolean;
}): boolean {
	if (ownsNativeFallout(opts)) return true;
	if (opts.pointerType === "pen") return true;
	if (opts.penNear) return true;
	return false;
}

/**
 * Pure decision, unit-tested: may the WINDOW backstop end the stroke for this
 * pointerup/pointercancel, or must it stand down for the scroller's own
 * handler?
 *
 * Window capture runs BEFORE the scroller capture listener on the very same
 * dispatch, so on every ordinary pen-up the backstop used to win the race
 * against the normal path and the trace read "END VIA WINDOW BACKSTOP" for
 * perfectly healthy strokes (and, because the normal handler then saw a
 * stroke that was already over, the event escaped un-suppressed into
 * CodeMirror). Deferring with queueMicrotask does NOT fix this. The HTML
 * spec runs a microtask checkpoint after each listener returns, so the
 * deferred callback still executes before the scroller's listener fires.
 *
 * The correct rule needs no timing at all: if the scroller is on the event's
 * composed path, this same dispatch WILL reach the normal handler. The
 * backstop's only job is the event that bypasses the scroller entirely
 * (capture silently lost, pen released over other UI).
 */
export function backstopMayEnd(opts: {
	pointerType: string | undefined;
	scrollerInPath: boolean;
}): boolean {
	if (opts.pointerType !== "pen") return false;
	return !opts.scrollerInPath;
}

/** Whether an unclaimed mouse may enter the ink/hover path. */
export function mouseMayStartOrHover(mouseGranted: boolean, keyboardPaused: boolean): boolean {
	return mouseGranted && !keyboardPaused;
}

/** Whether this event belongs to the exact mouse pointer that already owns a stroke. */
export function ownedMouseStroke(
	pointerType: string | undefined,
	pointerId: number,
	activePointerId: number | null,
	activeIsMouse: boolean
): boolean {
	return pointerType === "mouse" && activeIsMouse && activePointerId !== null && pointerId === activePointerId;
}

/** The default `originPan`: a surface whose ink layer never moves. */
const NO_ORIGIN_PAN = Object.freeze({ x: 0, y: 0 });

export class InlinePenRouter {
	/** The element listeners attach to: the editor's scroller. */
	scrollEl: HTMLElement;
	/** The element pen coordinates are made relative to: the overlay. */
	rectEl: HTMLElement;
	rect: DOMRect;
	/**
	 * Set while the live stroke is a mouse wearing the pen's hat, so its
	 * samples run through the grid filter. A pen's samples never do - see
	 * MouseTrail for the rule this deliberately bends and for whom.
	 */
	mouseStrokeTrail: MouseTrail | null = null;
	readonly mouseTrail = new MouseTrail();
	cb: InlinePenCallbacks;
	/**
	 * `cb.describeChrome`, wrapped so `dispose()` can remove exactly this
	 * closure from the shared `liveChromeDescribers` set; null when the
	 * overlay left `describeChrome` undefined (the pdf surface).
	 */
	private describeChromeFn: ((target: Element | null) => string) | null = null;
	scaleProvider: () => number;
	gate = new PalmGate();

	activePenId: number | null = null;
	/**
	 * Was the CLAIMED contact a real pen? Read ONLY as
	 * `activePenId !== null && this.activeIsPen`, never on its own.
	 *
	 * `activePenId` alone cannot answer, because an armed mouse claims through
	 * exactly the same door (`mouseActsAsPen`) and a mouse is the pointer this
	 * whole question is asked ABOUT. Written at the claim and never cleared -
	 * deliberately, and it is the same idiom (and the same argument) as
	 * `InkOverlay.mouseStroke`: the field speaks only where the hardened one
	 * has already said a contact is live, so it cannot outlive it. Every path
	 * that ends a stroke - `endPenStroke`, `finishActiveStroke`,
	 * `abandonActiveStroke`, `dispose` - nulls `activePenId`, so all four
	 * silence this too without knowing it exists.
	 */
	activeIsPen = false;
	/** True only while the claimed pointer is the note-only iPhone finger. */
	activeIsFinger = false;
	/** After finger ink yields to pinch, no contact in that gesture may re-arm it. */
	fingerInkBlockedUntilAllLift = false;
	/** Palm contacts we swallowed at pointerdown; their later events die too. */
	swallowedTouches = new Set<number>();
	// Palm parole (v0.13.3): the latest swallowed contact is watched. If it
	// moves like a swipe it converts into the assist pan (see PalmGate.ts).
	paroleId: number | null = null;
	paroleDownX = 0;
	paroleDownY = 0;
	paroleDownAt = 0;
	paroleContactPx = 0;
	/** A pen stroke overlapped the watched contact's life, so parole is off (RC3). */
	paroleOverlapped = false;
	disposers: Array<() => void> = [];
	winEndFn: ((e: Event) => void) | null = null;

	// Standing guard state (see module comment above). Built in the constructor,
	// which knows whether this surface keeps the native touch window.
	manip: ManipulationGuard;
	guardApplied = false;
	private rearmTimer: number | null = null;
	/** A toolbar/command entry waiting for every current note touch to finish. */
	fingerInkPreparationPending = false;
	private savedTouchAction = "";
	private savedTouchActionKnown = false;
	private savedTouchActionPriority = "";
	/** Non-palm touches currently counted by the guard's touch window. */
	guardTouches = new Set<number>();
	/**
	 * Live positions of guard-tracked (non-palm) touches. Only these can pinch:
	 * a contact the palm gate swallowed is the writing hand, and two of those
	 * are a hand, not a gesture.
	 */
	touchPos = new Map<number, { x: number; y: number }>();
	/**
	 * The spread the pinch's ratio is measured from, and the last midpoint read
	 * with exactly two contacts down. Both always belong to the PAIR DOWN NOW:
	 * set when a pair forms, and set again whenever a pinch ends with two
	 * contacts still down or a lift leaves a new pair (`rebasePinch`). A third
	 * contact leaves both as the pair last had them, so an end sent while it is
	 * down lands on the pinch's own focal point, never on client (0,0).
	 */
	pinchStartSpread = 0;
	pinchFocal = { x: 0, y: 0 };
	/**
	 * Touch identifiers currently down, from the TOUCH stream's own numbering
	 * - `touchPos` keys are pointer ids, which are a different sequence and
	 * cannot be compared against `Touch.identifier`.
	 */
	liveTouchIds = new Set<number>();
	// Native identifiers are independent of PointerEvent.pointerId. Once a
	// new native contact is rejected, keep its whole stream off the editor.
	blockedNativeTouchIds = new Set<number>();
	/** Snapshot of the above taken when the current pen stroke began. */
	touchesAtStrokeStart = new Set<number>();
	pinchLive = false;
	/** The one transition gesture the assist pan is carrying. */
	assistPointerId: number | null = null;
	assistLastX = 0;
	assistLastY = 0;
	assistMoved = 0;
	/**
	 * The plugin's own finger scroll carries its position per gesture
	 * (AssistScroll.ts): null between gestures, seeded from the settled
	 * read-back on the gesture's first write, shared by the assist pan, the
	 * parole catch-up and the fling that follows them.
	 */
	scrollCarryX: ScrollCarry | null = null;
	scrollCarryY: ScrollCarry | null = null;
	assistEngaged = false;
	/** Latched when the assist engages; the current touch gesture really panned. */
	gesturePanned = false;
	/** Recent assist positions for release-velocity measurement. */
	assistSamples: VelocitySample[] = [];
	/** Nonzero while an assist fling is gliding (rAF chain, finite). */
	flingRaf = 0;
	flingVx = 0;
	flingVy = 0;
	flingLastT = 0;

	// Native-event ownership (armed per claimed stroke + tail).
	ownershipTailUntil = 0;
	ownershipFn: ((e: Event) => void) | null = null;
	ownershipDisarmTimer: number | null = null;
	/**
	 * How far the ownership guard reaches: the ink surface plus the Obsidian
	 * chrome that overlaps it (PenGuardReach.ts). Resolved at each claim, so
	 * it is null only before the first stroke - and `penGuardReachesTarget`
	 * reads a null root as "keep the event", which is the palm-safe answer.
	 */
	private guardRoot: HTMLElement | null = null;
	/** Event types suppressed this ownership window, traced once each. */
	private suppressedTraced = new Set<string>();

	// Cold-contact diagnosis (M2 bug #2): when did the claimed stroke start,
	// and how late did its first input-rate samples arrive?
	strokeDownAt = 0;
	firstRawTraced = false;
	/** Raw-vs-move ink arbitration; see InkFeed.ts for the whole story. */
	inkFeed = new InkFeedArbiter();

	// Acquisition context printed with every CLAIMED pen-down.
	lastTouchAt = Number.NEGATIVE_INFINITY;
	lastPenHoverAt = Number.NEGATIVE_INFINITY;
	/**
	 * When a PEN last hovered, and ONLY a pen. See `handOnGlass`.
	 *
	 * Not `lastPenHoverAt`, three lines up, however much the name suggests it:
	 * that one is written by the hover branch for every pointer the branch
	 * accepts, and with mouse ink armed that includes the MOUSE. Reading it
	 * for "is a pen near the glass" would answer yes for a mouse moving on a
	 * desk with no pen in the room, which is the exact opposite of the
	 * question. Kept as it is - the trace line and `isPenCompatMouseMove` are
	 * its readers and neither is this one - and this stamp is written beside
	 * it under a `pointerType === "pen"` test.
	 */
	penHoverAt = Number.NEGATIVE_INFINITY;
	lastPenHoverX = Number.NEGATIVE_INFINITY;
	lastPenHoverY = Number.NEGATIVE_INFINITY;
	lastHoverTraceAt = Number.NEGATIVE_INFINITY;
	lastHoverButtons = -1;

	penDowns = 0;
	penUps = 0;
	fallbackEnds = 0;
	/** Stroke ends synthesized from a hover sample (no pointerup arrived). */
	silentLiftEnds = 0;
	palmsBlocked = 0;

	constructor(
		scrollEl: HTMLElement,
		rectEl: HTMLElement,
		cb: InlinePenCallbacks,
		/**
		 * Visual px per layout px of the overlay. Pointer coordinates arrive in
		 * visual px; the overlay's canvases and the note-space ink they hold are
		 * in layout px. Without this the pen lands in the wrong place, and
		 * draws at the wrong size, whenever the editor is scaled.
		 */
		scaleProvider: () => number = () => 1,
		/**
		 * What the standing guard writes while armed. An editor wants "none",
		 * because the assist pan replaces finger scrolling and owes the browser
		 * nothing back. A pdf viewer wants "pinch-zoom": nothing here implements
		 * a pinch, so "none" hands two-finger touches to the app, which reads
		 * them as its open-the-sidebar swipe.
		 */
		private guardTouchAction: string = "none",
		/**
		 * How far the ink the reader can see is translated, in visual px, away
		 * from `rectEl`.
		 *
		 * `rectEl` is the overlay band, and the band is deliberately never
		 * translated - the camera is derived from its rect, so a transform there
		 * would be absorbed and then applied a second time. The ink the reader
		 * is looking at rides one level in, on a layer that CAN be translated,
		 * and while a pinch's focal anchor leaves a residual there the pen's
		 * client point is in that translated frame while `this.rect` is not.
		 * Subtracting it here is what keeps "the pen lands where the ink is" true
		 * at the one moment the two frames differ.
		 *
		 * Returns the surface's OWN live object rather than a fresh one: this is
		 * read once per pointer sample.
		 */
		readonly originPan: () => { x: number; y: number } = () => NO_ORIGIN_PAN,
		/**
		 * Whether a finger pan's lift opens the native touch window. A note keeps
		 * it. A pdf viewer passes false: there only the assist is known to pan
		 * with one finger, so every pan stays with it (ManipulationGuard).
		 */
		nativeTouchWindow = true
	) {
		this.manip = new ManipulationGuard(nativeTouchWindow);
		this.scrollEl = scrollEl;
		this.rectEl = rectEl;
		this.cb = cb;
		this.scaleProvider = scaleProvider;
		this.rect = rectEl.getBoundingClientRect();
		liveScrollers.add(scrollEl);
		liveRouters.add(this);
		liveSuppressedTypes.add(this.suppressedTraced);
		if (cb.describeChrome) {
			this.describeChromeFn = (target) => cb.describeChrome!(target);
			liveChromeDescribers.add(this.describeChromeFn);
		}
		armWindowMirror(() => [...liveScrollers]);
		// Standing guard: armed from birth, so even the very first contact of
		// a session, with zero hover, meets a committed touch-action: none.
		this.applyGuard(this.manip.penSignal(), "resting");

		this.bindPointerListeners();
		this.bindBandRoot(scrollEl);

		this.bindStylusTouches();

		this.bindContextMenu();
	}

	// ---- native-event ownership ----------------------------------------------

	/**
	 * Window-capture guards, armed only while a claimed stroke (plus its short
	 * tail) owns the interaction. Window precedes document in capture order, so
	 * these pre-empt Obsidian's app-level handlers, which is where the eraser's
	 * caret-drag leak lived. Touch and mouse OUTSIDE a claimed pen gesture never
	 * meet this code.
	 *
	 * A finger INSIDE the tail is a different question, and the answer is no
	 * longer the palm gate. This comment used to say the gate quarantined
	 * touches for longer than the tail, which was true when RELEASE_TAIL_MS was
	 * 500 and has been false since v0.13.2 lowered it to 250 - below the 350 of
	 * OWNERSHIP_TAIL_MS, leaving 100ms the gate does not cover. What protects
	 * the finger there is the explicit `fromTouch` exemption in
	 * `suppressNativeFallout`, added in that same commit for that same reason:
	 * a finger tap right after pen-up is caret placement, and eating it made
	 * the pen-to-touch handoff feel dead for a third of a second.
	 *
	 * WINDOW-WIDE IS NOT APP-WIDE, and since v0.11.1 (`c4b7b5d`, where this
	 * guard was born) it was. These
	 * listeners are on the window because they have to run before Obsidian's
	 * document-level handlers, and nothing here ever asked WHERE the event
	 * landed - so with the eraser resting on a note, a finger poke on another
	 * note in the file explorer arrived as `mousedown`/`mouseup`/`click`, met
	 * `suppressNativeFallout({ activeStroke: true })` answering true
	 * unconditionally, and died on the window (alan, 2026-09-05: "i cant poke
	 * another note to switch while my pen eraser end is touching the screen").
	 * `penGuardEatsEvent` (PenGuardReach.ts) is now asked first, and it answers
	 * no for any target outside the ink surface. It cannot answer no INSIDE
	 * the surface while this guard would have eaten - `suppressNativeFallout`
	 * true implies `ownsNativeFallout` true implies `penContactLive` - so the
	 * palm rejection and the eraser's caret-drag leak are untouched, and only
	 * the reach changed.
	 */
	armOwnership(): void {
		if (this.ownershipDisarmTimer !== null) {
			window.clearTimeout(this.ownershipDisarmTimer);
			this.ownershipDisarmTimer = null;
		}
		this.suppressedTraced.clear();
		// Once per claim, not per event: `closest` walks the tree and
		// `mousemove` is on the guarded list. Refreshed ahead of the
		// still-armed return below, so a stroke that lands after the scroller
		// was re-parented measures against where it lives now.
		this.guardRoot = penGuardRoot(this.scrollEl);
		if (this.ownershipFn) return; // still armed from the previous stroke's tail
		const fn = (ev: Event) => {
			const now = performance.now();
			// REACH BEFORE SWALLOW. Obsidian's own tap handling needs this
			// event at capture time, so the test has to happen here rather
			// than by moving the listener down onto the surface: on the
			// surface it would run AFTER every app-level handler, which is
			// the exact pre-emption failure the comment above describes.
			if (
				!penGuardEatsEvent({
					targetInsideSurface: penGuardReachesTarget(this.guardRoot, ev.target),
					penContactLive: ownsNativeFallout({
						activeStroke: this.activePenId !== null,
						now,
						ownershipTailUntil: this.ownershipTailUntil,
					}),
					penHoverLive: this.gate.isPenNear(now),
				})
			) {
				return;
			}
			const fromTouch =
				(ev as PointerEvent).pointerType === "touch" ||
				((ev as UIEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } })
					.sourceCapabilities?.firesTouchEvents ??
					false);
			if (
				!suppressNativeFallout({
					activeStroke: this.activePenId !== null,
					now,
					ownershipTailUntil: this.ownershipTailUntil,
					fromTouch,
				})
			) {
				return;
			}
			this.traceSuppressed(ev.type);
			ev.preventDefault();
			ev.stopPropagation();
		};
		this.ownershipFn = fn;
		for (const type of OWNED_NATIVE_EVENTS) {
			this.winRef.addEventListener(type, fn, { capture: true });
		}
	}

	/** Called at stroke end: keep the guards through the fallout tail, then drop. */
	scheduleOwnershipDisarm(): void {
		this.ownershipTailUntil = performance.now() + OWNERSHIP_TAIL_MS;
		if (this.ownershipDisarmTimer !== null) window.clearTimeout(this.ownershipDisarmTimer);
		this.ownershipDisarmTimer = window.setTimeout(() => {
			this.ownershipDisarmTimer = null;
			this.disarmOwnership();
		}, OWNERSHIP_TAIL_MS + 50);
	}

	disarmOwnership(): void {
		if (!this.ownershipFn) return;
		if (this.activePenId !== null) return; // a new stroke re-claimed meanwhile
		for (const type of OWNED_NATIVE_EVENTS) {
			this.winRef.removeEventListener(type, this.ownershipFn, { capture: true });
		}
		this.ownershipFn = null;
	}

	traceSuppressed(type: string): void {
		// Gate FIRST: the de-dupe bookkeeping below must never run while
		// recording is off, or a type "already traced" while OFF stays silent
		// forever after - even once recording turns back on - until the next
		// armOwnership() happens to clear the set. Same call-site rule tr()
		// itself follows (DiagSwitch.ts): nothing here costs more than the one
		// boolean read when diagnostics are off.
		if (!diagnosticsEnabled()) return;
		noteSuppressedNative();
		if (this.suppressedTraced.has(type)) return;
		this.suppressedTraced.add(type);
		tr("suppressed", null, `${type}: claimed pen gesture owns this interaction`);
	}

	dispose(): void {
		this.blockedNativeTouchIds.clear();
		this.canvasMomentumDisabled = false;
		this.scrollEl.classList.remove("handwriting-no-momentum");
		this.cancelFling();
		this.touchPos.clear();
		this.pinchLive = false;
		liveScrollers.delete(this.scrollEl);
		// OUT OF THE SET IS THE WHOLE TEARDOWN, and it is why a pane closed
		// mid-gesture cannot strand the other panes' rings. This method does
		// not clear `guardTouches`/`swallowedTouches` (it never did), so a
		// router disposed with a finger still down keeps saying true for good
		// - but nothing asks it any more, so `anyHandOnGlass()` stops
		// counting it on the very next mouse sample. No cleanup call, and
		// nothing to get wrong at the call sites.
		liveRouters.delete(this);
		liveSuppressedTypes.delete(this.suppressedTraced);
		if (this.describeChromeFn) {
			liveChromeDescribers.delete(this.describeChromeFn);
			this.describeChromeFn = null;
		}
		disarmWindowMirror();
		for (const d of this.disposers) d();
		this.disposers = [];
		this.disarmEndBackstop();
		this.restoreGuardStyle();
		if (this.ownershipDisarmTimer !== null) {
			window.clearTimeout(this.ownershipDisarmTimer);
			this.ownershipDisarmTimer = null;
		}
		this.activePenId = null;
		this.activeIsFinger = false;
		this.disarmOwnership();
	}

	// ---- standing gesture guard ---------------------------------------------

	/**
	 * WHAT THE STANDING GUARD WRITES, for this surface AND this moment.
	 * Chromium reads `touch-action` at the FIRST contact of a sequence, so refusing to claim the
	 * SECOND finger buys nothing while the first has already put `none` on the scroller - the
	 * browser has decided the whole gesture is ours by then. With the host's own pinch in force the
	 * guard arms at `pinch-zoom` instead: the browser keeps two-finger zoom, and one-finger panning
	 * is still refused to it, which is what the assist pan replaces.
	 *
	 * The constructor value is the surface's own (an editor asks for `none`, the PDF viewer already
	 * asks for `pinch-zoom`), and it is what a host that answers nothing still gets.
	 */
	private armedTouchAction(): string {
		return (this.cb.pinchZoom?.() ?? true) ? this.guardTouchAction : "pinch-zoom";
	}

	/** Apply a ManipulationGuard decision to the scroller and timers. */
	applyGuard(d: GuardDecision, why: string): void {
		if (!guardEnabled) {
			this.restoreGuardStyle();
			return;
		}
		if (d.cancelRearm && this.rearmTimer !== null) {
			window.clearTimeout(this.rearmTimer);
			this.rearmTimer = null;
		}
		if (d.scheduleRearm) {
			if (this.rearmTimer !== null) window.clearTimeout(this.rearmTimer);
			this.rearmTimer = window.setTimeout(() => {
				this.rearmTimer = null;
				this.applyGuard(this.manip.rearm(), "rearm");
			}, GUARD_REARM_MS);
		}
		const wantNone = d.touchAction === "none";
		if (wantNone && !this.guardApplied) {
			this.captureRootTouchAction();
			this.guardApplied = true;
			armGuardStyle(this.scrollEl, this.armedTouchAction());
			tr("guard", null, `touch-action: none (${why})`);
		} else if (!wantNone && this.guardApplied) {
			this.guardApplied = false;
			disarmGuardStyle(this.scrollEl, this.savedTouchAction);
			tr("guard", null, `touch-action restored (${why})${computedTouchActionNote("scroller", this.scrollEl)}`);
		}
		this.syncRootTouchAction();
	}

	restoreGuardStyle(): void {
		if (this.rearmTimer !== null) {
			window.clearTimeout(this.rearmTimer);
			this.rearmTimer = null;
		}
		if (this.guardApplied) {
			this.guardApplied = false;
			disarmGuardStyle(this.scrollEl, this.savedTouchAction);
			tr("guard", null, "touch-action restored (guard disabled/disposed)");
		}
		this.syncRootTouchAction();
	}

	captureRootTouchAction(): void {
		if (this.savedTouchActionKnown) return;
		this.savedTouchAction = this.scrollEl.style.touchAction;
		this.savedTouchActionPriority = this.scrollEl.style.getPropertyPriority?.("touch-action") ?? "";
		this.savedTouchActionKnown = true;
	}

	/** One root policy; subtree guard classes retain their existing ownership. */
	syncRootTouchAction(): void {
		if (!this.savedTouchActionKnown) return;
		const owned = this.canvasMomentumDisabled || this.guardApplied;
		const touchAction = this.canvasMomentumDisabled ? "none" : this.guardApplied ? this.armedTouchAction() : this.savedTouchAction;
		if (this.scrollEl.style.touchAction !== touchAction) this.scrollEl.setCssStyles({ touchAction });
		if (!owned && this.savedTouchActionPriority) this.scrollEl.style.setProperty("touch-action", this.savedTouchAction, this.savedTouchActionPriority);
	}

	canvasMomentumDisabled = false;

	/** The transient give, painted px, per axis. Zero whenever the page is not held past an end. */
	overscrollPullX = 0;
	overscrollPullY = 0;

	/**
	 * Which side of the assist gate the last touch contact went, and why. Written at the gate, never
	 * read by production: a fixture that finds no give has to be able to say whether the assist
	 * refused the gesture or took it and found nothing to refuse, and the guard's own state cannot
	 * answer that - `touchStart` moves armed to armed-assist whether it grants or refuses.
	 */
	assistGateReadout: { assistThisGesture: boolean; guardEnabled: boolean; edgeStart: boolean; took: boolean } =
		{ assistThisGesture: false, guardEnabled: false, edgeStart: false, took: false };

	get isStroking(): boolean {
		return this.activePenId !== null;
	}

	/** Existing navigation lifetime only: hover and swallowed palms do not hold sync. */
	get hasActiveNavigation(): boolean {
		return this.guardTouches.size > 0 || this.pinchLive || this.assistPointerId !== null || this.flingRaf !== 0;
	}

	/**
	 * PALM REJECTION IS ONE HAND'S, NOT ONE PANE'S. Each router's gate is warmed
	 * only by its own pen, so with two panes side by side a palm landing in pane
	 * B while the pen wrote or hovered in pane A read B's cold gate and scrolled
	 * B. There is one writing hand, so the new-touch decision, the parole veto
	 * for a palm that landed mid-stroke, and the stroke-active read all ask every
	 * live router. One iteration per open ink surface, on touch events only.
	 */
	anyGateBlocksNewTouch(now: number): boolean {
		for (const r of liveRouters) if (r.gate.blocksNewTouch(now)) return true;
		return false;
	}

	anyPenStrokeActive(): boolean {
		for (const r of liveRouters) if (r.gate.isPenStrokeActive) return true;
		return false;
	}

	anyPenDown(): boolean {
		for (const r of liveRouters) if (r.activePenId !== null) return true;
		return false;
	}

	/**
	 * The pen landed in another pane while a pen stroke here is still open: no
	 * pointerup, cancel, lost capture or blur ever reached this one, and its
	 * gate flag would hold every pane's touch as a palm until a stroke ends
	 * here. Ended the way a blur ends it (`finishActiveStroke`): committed,
	 * ink kept, the gate let go. A mouse or finger stroke is not the pen's and
	 * is left alone.
	 */
	finishStrandedPenStroke(): void {
		if (this.activePenId === null || !this.activeIsPen) return;
		this.finishActiveStroke();
	}

	/** A pen landed in some pane: a contact on parole here is the hand that follows it, palm for life. */
	voidParoleOnPenDown(e: PointerEvent): void {
		if (this.paroleId === null || this.paroleOverlapped) return;
		this.paroleOverlapped = true;
		tr("guard", e, `parole voided: pen landed while touch ${this.paroleId} was down (palm for life)`);
	}

	/**
	 * IS A HAND ON THE GLASS - a finger down, a pen down, or a pen hovering?
	 *
	 * The read half of the 1.4.12 ruling "hide the mouse reticle when a finger
	 * or pen is active" (alan). A surface asks this where it decides whether
	 * to paint a MOUSE's hover reticle and paints nothing while it is true;
	 * `onHandOnGlass` above is the write half, which takes down a ring that is
	 * already lit. Nothing else consults it, and it grants and refuses no
	 * claim: mouse ink is untouched, a mouse that draws still draws.
	 *
	 * DERIVED, NOT STORED, and that is the whole design. A stored bit would
	 * need its own clearing, and a bit that never clears is a mouse reticle
	 * that never comes back - so every term below is state this router already
	 * keeps and already recovers, and this method adds no recovery of its own:
	 *
	 *   - FINGERS are `guardTouches` (the guard's non-palm contacts) and
	 *     `swallowedTouches` (the palm gate's). Between them they are the
	 *     router's whole pointer-stream record of touch, added at pointerdown
	 *     and deleted at that contact's pointerup/pointercancel, which is
	 *     exactly the window the ruling names.
	 *   - A CLAIMED PEN is `activePenId` plus `activeIsPen` - see that field
	 *     for why the id alone will not do - and `activePenId` is the most
	 *     hardened state in this file: pointerup, pointercancel,
	 *     lostpointercapture, the silent lift, the window end backstop, a
	 *     window blur and a note switch all null it.
	 *   - A HOVERING PEN is the `HOVER_GHOST_MS` window, the same one the
	 *     reticle's own watchdog measures and imported from the same module
	 *     (PenCursor.ts, whose comment on that constant asks for precisely
	 *     this sharing). A pen that leaves hover range may send no event at
	 *     all - digitizers differ, which is why the watchdog exists - so a
	 *     boolean set on hover-in could only be cleared by an event that may
	 *     never arrive. A stamp expires on its own.
	 *
	 * WHAT A LOST POINTERUP COSTS, said plainly. The pen terms cannot strand:
	 * the stamp times out and `activePenId` has seven ways home. A touch id
	 * whose pointerup never arrives does strand, in the same two sets the palm
	 * gate and `abandonActiveStroke`'s `hasLiveGesture` already depend on
	 * being honest - so this reads a fragility rather than adding one, and the
	 * paths that heal those sets (`finishActiveStroke` and
	 * `abandonActiveStroke` both clear `guardTouches`) heal this with them.
	 * The worst case is bounded and is not a dead pointer: the surface's
	 * stand-down goes through its ordinary hide, which takes `cursor: none`
	 * off with the ring, so the reader keeps the native cursor and loses only
	 * the mouse's ring until the note is reopened.
	 *
	 * CHEAP, in that order deliberately: two set sizes, then two field reads,
	 * and the clock only when the first four have all said no.
	 */
	handOnGlass(): boolean {
		if (this.guardTouches.size > 0 || this.swallowedTouches.size > 0) return true;
		if (this.activePenId !== null && this.activeIsPen) return true;
		return performance.now() - this.penHoverAt <= HOVER_GHOST_MS;
	}

	/**
	 * The platform's own guess at where this pointer is heading, mapped into
	 * the same sample space as the real ones.
	 *
	 * Mapping lives here because the rect does: the overlay has no business
	 * knowing how a client coordinate becomes a sample, and a predicted point
	 * that went through a different conversion than its real neighbours would
	 * be a tail that starts with a jump. Empty on engines without the API, and
	 * on a throw - a prediction is a nicety and must never cost a stroke.
	 */
	predictedSamples(e: PointerEvent): PenSample[] {
		const pe = e as PointerEvent & { getPredictedEvents?: () => PointerEvent[] };
		if (typeof pe.getPredictedEvents !== "function") return [];
		try {
			return pe.getPredictedEvents().map((p) => this.sampleFrom(p));
		} catch {
			return [];
		}
	}

	refreshRect(): void {
		this.rect = this.rectEl.getBoundingClientRect();
	}

	/**
	 * The window this view's editor actually lives in. A popout is another
	 * BrowserWindow: its events never reach the main window's listeners, so
	 * the ownership guards and the end backstop must arm where the pen is.
	 * On the main window this is `window` itself - identical behavior.
	 */
	get winRef(): Window {
		return this.scrollEl.ownerDocument?.defaultView ?? window;
	}

	/**
	 * Mouse-ink mode (roadmap: mouse input): while the switch is on, the
	 * mouse's LEFT button is treated as a pen tip. Right and middle stay
	 * native so the context menu and paste-click keep working; everything
	 * downstream of the claim is the ordinary pen path.
	 */
	mouseActsAsPen(e: PointerEvent): boolean {
		// The expression itself moved to MouseInk.ts, unchanged, so that
		// `pointerRaisesPenTools` (PenToolsMode.ts) - which both ink surfaces
		// now read at their hover sites - is built from THIS rule rather than
		// from a second copy of it. Still a method here because every caller
		// in this file has an event in hand and none of them should learn a
		// new import. No allocation and no extra work on the move path: one
		// module call replaces one module call.
		//
		// WIDENED, 2026-09-05 ("button should become the truth", then Alan's
		// same-day addendum from the pen nib alone to any lit tool). `!this
		// .penOff()` is "some tool - pen, highlighter, eraser, lasso, insert
		// space or pan - currently has the tip"; `penOff()` is the one state
		// none of them do (keyboard mode, taps place the caret). `deviceHas
		// NeverSeenAPen()` is this base's least-wrong read of "no pen yet" -
		// see its own docstring (PenToolsMode.ts) before assuming it survives
		// a restart or a mouse-ink-off; it does not, on either count.
		//
		// This one seam is why BOTH ink surfaces get the widened rule for
		// free: `PdfInkController` builds its stroke handling on this same
		// `InlinePenRouter` class (`this.router = new InlinePenRouter(...)`,
		// PdfInkController.ts) rather than a second router, so nothing there
		// needed a second edit.
		// TIGHTENED, same day, after an auditor found the widening above
		// granting the mouse the tip on a pen-less device STRAIGHT FROM
		// LAUNCH: `!this.penOff()` is the pen-ink switch, whose default is
		// TRUE, so "a tool is lit" read true with nothing picked and a plain
		// left-drag inked instead of selecting text - the exact opposite of
		// the ruling's own "no lit tool means the mouse selects text" and of
		// `docs/manual.md`'s "By default, only the pen draws". `toolIsLit`
		// (MouseInk.ts) is the whole of the fix: it ANDs this same pen-ink
		// read, still through this router's own `penOff` callback, with
		// whether a tool has actually been picked. One function, and
		// `nibIsLit` (MobileTools.ts) calls it too, so the light and the
		// grant still cannot disagree.
		return mouseActsAsPen(e.pointerType, toolIsLit(!this.penOff()), deviceHasNeverSeenAPen());
	}

	mouseMayStartOrHover(e: PointerEvent): boolean {
		return mouseMayStartOrHover(this.mouseActsAsPen(e), this.penOff());
	}

	ownedMouseStroke(e: PointerEvent): boolean {
		return ownedMouseStroke(e.pointerType, e.pointerId, this.activePenId, !this.activeIsPen && !this.activeIsFinger);
	}

	/**
	 * The pen-off gate (see `InlinePenCallbacks.penOff`), read once per site
	 * so the surfaces keep the state and this file keeps the rule.
	 *
	 * PEN ONLY at every call site, spelled `pointerType === "pen"` there
	 * rather than folded in here: a mouse standing in for a pen is a
	 * different mode with a different owner (MouseInk.ts), and the one thing
	 * this must never do is quietly take mouse ink down with it.
	 */
	penOff(): boolean {
		return this.cb.penOff?.() ?? false;
	}

	/** Inverse of the cached input mapping, without another geometry read. */
	clientPointForSample(sample: PenSample): { x: number; y: number } {
		const scale = this.scaleProvider(), pan = this.originPan?.();
		return { x: this.rect.left + sample.x * scale + (pan && Number.isFinite(pan.x) ? pan.x : 0),
			y: this.rect.top + sample.y * scale + (pan && Number.isFinite(pan.y) ? pan.y : 0) };
	}

	/**
	 * The event's position as a note sample, unsmoothed: the same mapping every
	 * fed sample goes through, without the mouse trail. For a surface that
	 * appends the lift position as the stroke's last point (audit 98).
	 */
	sampleAt(e: PointerEvent): PenSample {
		return this.sampleFrom(e);
	}

	sampleFrom(e: PointerEvent): PenSample {
		const scale = this.scaleProvider();
		// Guarded rather than trusted, twice over. The provider reads a live field
		// on the surface, and a surface mid-teardown can hand back a partial
		// object; and the unit fixtures reach this method on routers built with
		// `Object.create`, which inherits the prototype's methods but none of the
		// constructor's parameter properties - so the provider itself can be
		// missing. A surface with no provider has no pan, which is the right
		// answer for every one of them.
		const pan = this.originPan?.();
		const panX = pan && Number.isFinite(pan.x) ? pan.x : 0;
		const panY = pan && Number.isFinite(pan.y) ? pan.y : 0;
		return {
			x: visualToNote(e.clientX - this.rect.left - panX, scale),
			y: visualToNote(e.clientY - this.rect.top - panY, scale),
			pressure:
				e.pointerType === "touch"
					? FINGER_INK_PRESSURE
					: e.pressure > 0
					? e.pressure
					: e.pointerType === "pen"
						? 0
						: 0.5,
			timestamp: e.timeStamp,
			tiltX: e.tiltX,
			tiltY: e.tiltY,
		};
	}
}

installInlinePenRouterNav(InlinePenRouter.prototype);
installInlinePenRouterBind(InlinePenRouter.prototype);
installInlinePenRouterEnd(InlinePenRouter.prototype);
installInlinePenRouterInput(InlinePenRouter.prototype);
