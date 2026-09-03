import { telemetry } from "../diag/Telemetry";
import { GuardDecision, ManipulationGuard } from "../input/ManipulationGuard";
import { PalmGate, paroleEarned } from "../input/PalmGate";
import { PenSample, silentLift } from "../input/PointerRouter";
import { visualToNote } from "./ZoomScale";
import { hideProbeMarkers, markRawPointer } from "./PenProbe";
import { hitProbeDown, hitProbeHover, isHitProbeEnabled } from "./PenHitProbe";
import { scrollProbeTouch } from "./ScrollProbe";
import { DIAG_OFF_NOTE, diagnosticsEnabled } from "../diag/DiagSwitch";
import { VelocitySample, flingStep, releaseVelocity } from "../input/Fling";
import { armGuardStyle, disarmGuardStyle } from "./GuardStyle";
import { isPenCompatMouseMove } from "./PenCursor";
import { pinchEngaged, pinchMidpoint, pinchRatio, pinchSpread } from "./PinchScale";
import { InkFeedArbiter } from "./InkFeed";
import {
	palmSizedTouches,
	stylusOnlyTouches,
	touchesPredateStroke,
} from "./StylusTouch";
import { mouseInkEnabled } from "./MouseInk";
import { MouseTrail } from "../input/MouseTrail";
import { penSeenThisSession } from "./PenToolsMode";

/**
 * Pen capture for the inline overlay.
 *
 * This is deliberately NOT the canvas PointerRouter, although the pen path
 * mirrors it move for move. The difference is everything else: on the canvas,
 * Handwriting owns the whole surface, so touch pans the camera and mouse navigates.
 * On an ordinary note the EDITOR owns the surface. Touch must scroll and
 * place carets natively, the mouse must select text natively, and Handwriting may
 * claim exactly one thing: the pen.
 *
 * Rules:
 *   Pen tip      -> ink. Claimed in the CAPTURE phase on the editor's
 *                   scroller, before CodeMirror's own handlers (which live on
 *                   the child content element) can see it.
 *   Pen side    -> claimed: held at contact it lassos and moves ink.
 *   Pen eraser   -> claimed and swallowed (no ink, and no accidental
 *                   right-click storm from the eraser end).
 *   Touch        -> passed through untouched, UNLESS the palm gate says a pen
 *                   is active or hovering, in which case the contact is
 *                   swallowed before the editor can scroll or place a caret
 *                   under the writer's palm. This is the only touch handling,
 *                   and it is not on the pen hot path.
 *   Mouse        -> never touched.
 *
 * The pen hot path is byte-for-byte the frozen pipeline's shape: sync work
 * inside `pointerrawupdate`, coalesced samples, no allocation on move events
 * beyond the sample array.
 */

export interface InlinePenCallbacks {
	onPenDown(sample: PenSample, ev: PointerEvent): void;
	/**
	 * Display-rate pen hover, outside an active contact.
	 *
	 * `pointerType` because a reticle serves two audiences: under a pen it is
	 * a preview the nib will cover, under a mouse it is the POINTER, and the
	 * two want different chrome. Optional so implementors that do not care
	 * keep their one-argument shape.
	 */
	onPenHover(sample: PenSample, pointerType?: string): void;
	/** The hovering pen left the editor. */
	onPenLeave(): void;
	/**
	 * Two-finger pinch with the pen away from the glass. `ratio` is the current
	 * spread over the spread at gesture start, so the caller scales from what
	 * it captured on "start" and nothing accumulates.
	 */
	onPinch(
		phase: "start" | "move" | "end",
		ratio: number,
		/** Midpoint between the two contacts, in client px. The zoom anchors
		 *  here so the page does not slide out from under the fingers. */
		centroid: { x: number; y: number }
	): void;
	/** Input-rate coalesced samples while a stroke is active. */
	onPenRaw(samples: PenSample[], ev: PointerEvent): void;
	/** rAF-rate move, for metrics only (`coalescedCount`). */
	onPenMove(ev: PointerEvent, coalescedCount: number): void;
	onPenUp(ev: PointerEvent): void;
	/**
	 * Should a contact OUTSIDE the scroller (the linked-mentions band renders
	 * outside it, in the same view) be claimed as a Handwriting gesture? The
	 * overlay answers yes only for eraser intent - see bandEraserIntent.
	 */
	claimBandContact?(ev: PointerEvent): boolean;
}

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
	if (pointerType === "pen") return eraserEnd || eraserMode;
	if (pointerType === "mouse") return eraserMode && mouseInk && (buttons & 1) !== 0;
	return false;
}

// ---- lifecycle trace -------------------------------------------------------
//
// Every pointer event the router sees goes into this ring, cheap enough to be
// always on (one small object per EVENT, not per coalesced sample; the hot
// path already allocates far more building the sample array). `Diagnostics:
// copy pen trace` dumps it. This exists because strokes on the test Surface
// terminated after a few centimetres. The trace tells us exactly which event
// ended the stream: a `pointercancel` (browser gesture takeover), a
// `lostpointercapture` without a cancel (someone stole capture), or a silent
// stop (delivery ceased).

/** One coalesced sample as the ink consumed it - floats, untouched. */
export interface TraceSample {
	t: number;
	x: number;
	y: number;
	p: number;
}

export interface TraceEntry {
	t: number;
	type: string;
	id: number;
	ptr: string;
	buttons: number;
	button: number;
	pressure: number;
	x: number;
	y: number;
	tx: number;
	ty: number;
	note: string;
	/**
	 * The coalesced list the ink path actually consumed, when there was
	 * one. NOT diagnostic decoration: the router expands this list into
	 * builder samples (see the RC4 comment at the raw handler), so a replay
	 * without it collapses an iPad's 4-per-move stream into single points.
	 */
	cs?: TraceSample[];
}

const TRACE_MAX = 3000;
const trace: TraceEntry[] = [];

function tr(type: string, e: PointerEvent | null, note = "", cs?: TraceSample[]): void {
	if (!diagnosticsEnabled()) return;
	trace.push({
		t: performance.now(),
		type,
		id: e?.pointerId ?? -1,
		ptr: e?.pointerType ?? "",
		buttons: e?.buttons ?? -1,
		button: e?.button ?? -1,
		pressure: e?.pressure ?? -1,
		// Floats, deliberately: the ink path consumes the UNROUNDED values,
		// and a rounded trace made every replay lossy by half a pixel per
		// point. The human table rounds at FORMAT time instead.
		x: e ? e.clientX : 0,
		y: e ? e.clientY : 0,
		tx: e?.tiltX ?? 0,
		ty: e?.tiltY ?? 0,
		note,
		...(cs && cs.length > 0 ? { cs } : {}),
	});
	if (trace.length > TRACE_MAX) trace.splice(0, trace.length - TRACE_MAX);
}

/** The consumed coalesced list, as trace samples. */
function csOf(events: ReadonlyArray<PointerEvent>): TraceSample[] {
	return events.map((ce) => ({ t: ce.timeStamp, x: ce.clientX, y: ce.clientY, p: ce.pressure }));
}

/** Pure, unit-tested: the acquisition-health counts the summary prints. */
export function summarizeAcquisitions(
	events: ReadonlyArray<{ type: string; note: string }>
): { delivered: number; claimed: number; ignored: number; cancelled: number; pressedHover: number } {
	let delivered = 0;
	let claimed = 0;
	let ignored = 0;
	let cancelled = 0;
	let pressedHover = 0;
	for (const e of events) {
		if (e.type === "window-pointerdown") delivered++;
		else if (e.type === "pointerdown" && e.note.includes("CLAIMED")) claimed++;
		else if (e.type === "pointerdown" && e.note.includes("IGNORED")) ignored++;
		else if (e.type === "pointercancel") cancelled++;
		else if (e.type === "pen-hover" && e.note.includes("PRESSED")) pressedHover++;
	}
	return { delivered, claimed, ignored, cancelled, pressedHover };
}

export function formatInlinePenTrace(): string {
	if (trace.length === 0) {
		return diagnosticsEnabled()
			? "Handwriting pen trace: empty"
			: `Handwriting pen trace: empty. ${DIAG_OFF_NOTE}`;
	}
	const t0 = trace[0]!.t;
	const lines = trace.map((e) => {
		const at = (e.t - t0).toFixed(1).padStart(8);
		return (
			`${at}ms  ${e.type.padEnd(18)} id=${e.id} ${e.ptr || "-"} ` +
			`buttons=${e.buttons} button=${e.button} p=${e.pressure.toFixed(3)} ` +
			`(${Math.round(e.x)},${Math.round(e.y)})${e.note ? "  " + e.note : ""}`
		);
	});
	const s = summarizeAcquisitions(trace);
	return [
		`Handwriting pen trace: ${trace.length} event(s)`,
		"",
		`SUMMARY: ${s.delivered} pen contact(s) delivered to the page, ${s.claimed} claimed, ${s.ignored} ignored, ${s.cancelled} cancelled.`,
		s.pressedHover > 0
			? `  *** ${s.pressedHover} hover sample(s) with the pen PRESSED and no pointerdown. Search "PRESSED BUT NO". ***`
			: "  No pressed-but-undelivered hover samples.",
		s.delivered === s.claimed && s.ignored === 0 && s.cancelled === 0 && s.pressedHover === 0
			? "  Every acquisition in this capture was healthy. No failure recorded."
			: "  At least one acquisition did not follow the healthy path.",
		"",
		"How to read an acquisition:",
		"  window-pointerdown  = the PAGE received the pen contact (window capture,",
		"                        before every other listener). Absent => the browser",
		"                        never delivered it.",
		"  pointerdown … CLAIMED   = the router received it and took it. guard=prearmed",
		"                        means hover had already pan-locked the scroller;",
		"                        guard=COLD means it had not.",
		"  pointerdown … IGNORED   = the router received it and dropped it (a previous",
		"                        stroke was still active).",
		"  pointercancel       = delivered, then reclassified as a gesture by the browser.",
		"  pen-hover           = pen NEAR, no contact claimed. buttons=1 here means the",
		"                        nib was pressed and the browser sent no pointerdown.",
		"",
		...lines,
	].join("\n");
}

/**
 * Environment context for a capture. Loose on purpose: the recorder fills
 * what it can reach, a future version adds fields, and unknown ones ride
 * through parse and re-serialize untouched - the sidecar discipline.
 */
export type TraceEnv = Record<string, unknown>;

export interface TraceCapture {
	v: 1;
	env: TraceEnv;
	events: TraceEntry[];
}

/**
 * A machine-readable snapshot of the ring buffer. The human table
 * (formatInlinePenTrace) stays exactly as it is - people paste it into
 * GitHub issues - and this is what becomes a replay fixture: a pointerdown
 * at (400, 300) is meaningless without the world it landed in, so the
 * recorder passes that world in env.
 */
export function captureInlinePenTrace(env: TraceEnv): TraceCapture {
	return {
		v: 1,
		env: { ...env },
		events: trace.map((r) => ({ ...r, ...(r.cs ? { cs: r.cs.map((c) => ({ ...c })) } : {}) })),
	};
}

export function clearInlinePenTrace(): void {
	trace.length = 0;
}

// ---- window delivery mirror -------------------------------------------------
//
// Log-only, always on while any router lives: a window-CAPTURE listener for
// pen pointerdown/pointercancel, ahead of every other handler in the page.
// Its entries prove whether the browser delivered a contact at all, the
// difference between "the page never got it" (OS/Chromium withheld it) and
// "the page got it and something upstream of the router ate it". Refcounted
// across routers; never intercepts, only traces.

let mirrorRefs = 0;
let mirrorFn: ((e: Event) => void) | null = null;
const MIRRORED_TYPES = ["pointerdown", "pointercancel"] as const;
/** Every live router's scroller, so the mirror can say "was this for us". */
const liveScrollers = new Set<HTMLElement>();

function armWindowMirror(scrollers: () => HTMLElement[]): void {
	mirrorRefs++;
	if (mirrorFn) return;
	const fn = (e: Event) => {
		// RC4: the switch is read BEFORE any work. This listener is on the
		// window capture path for every pen contact, so composedPath() (a full
		// ancestor-array allocation) and the live-scroller scan used to run at
		// the start of every stroke and be thrown away inside tr().
		if (!diagnosticsEnabled()) return;
		const pe = e as PointerEvent;
		if (pe.pointerType !== "pen") return;
		const path = typeof pe.composedPath === "function" ? pe.composedPath() : [];
		const forUs = scrollers().some((el) => path.includes(el));
		tr(
			`window-${pe.type}`,
			pe,
			`PAGE RECEIVED IT; composed path ${forUs ? "includes" : "does NOT include"} a Handwriting editor scroller`
		);
	};
	mirrorFn = fn;
	for (const type of MIRRORED_TYPES) {
		window.addEventListener(type, fn, { capture: true });
	}
}

function disarmWindowMirror(): void {
	mirrorRefs = Math.max(0, mirrorRefs - 1);
	if (mirrorRefs > 0 || !mirrorFn) return;
	for (const type of MIRRORED_TYPES) {
		window.removeEventListener(type, mirrorFn, { capture: true });
	}
	mirrorFn = null;
}

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

let guardEnabled = true;

export function isPenGestureGuardEnabled(): boolean {
	return guardEnabled;
}

export function setPenGestureGuardEnabled(on: boolean): void {
	guardEnabled = on;
}

/** One-shot re-arm delay after the last finger lifts. */
const GUARD_REARM_MS = 1000;
/** Finger movement before the assist pan engages (native slop analog). */
const ASSIST_SLOP_PX = 8;

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

export class InlinePenRouter {
	/** The element listeners attach to: the editor's scroller. */
	private scrollEl: HTMLElement;
	/** The element pen coordinates are made relative to: the overlay. */
	private rectEl: HTMLElement;
	private rect: DOMRect;
	/**
	 * Set while the live stroke is a mouse wearing the pen's hat, so its
	 * samples run through the grid filter. A pen's samples never do - see
	 * MouseTrail for the rule this deliberately bends and for whom.
	 */
	private mouseStrokeTrail: MouseTrail | null = null;
	private readonly mouseTrail = new MouseTrail();
	private cb: InlinePenCallbacks;
	private scaleProvider: () => number;
	private gate = new PalmGate();

	private activePenId: number | null = null;
	/** Palm contacts we swallowed at pointerdown; their later events die too. */
	private swallowedTouches = new Set<number>();
	// Palm parole (v0.13.3): the latest swallowed contact is watched. If it
	// moves like a swipe it converts into the assist pan (see PalmGate.ts).
	private paroleId: number | null = null;
	private paroleDownX = 0;
	private paroleDownY = 0;
	private paroleDownAt = 0;
	private paroleContactPx = 0;
	/** A pen stroke overlapped the watched contact's life, so parole is off (RC3). */
	private paroleOverlapped = false;
	private disposers: Array<() => void> = [];
	private winEndFn: ((e: Event) => void) | null = null;

	// Standing guard state (see module comment above).
	private manip = new ManipulationGuard();
	private guardApplied = false;
	private rearmTimer: number | null = null;
	private savedTouchAction = "";
	private savedTouchActionKnown = false;
	/** Non-palm touches currently counted by the guard's touch window. */
	private guardTouches = new Set<number>();
	/**
	 * Live positions of guard-tracked (non-palm) touches. Only these can pinch:
	 * a contact the palm gate swallowed is the writing hand, and two of those
	 * are a hand, not a gesture.
	 */
	private touchPos = new Map<number, { x: number; y: number }>();
	private pinchStartSpread = 0;
	/**
	 * Touch identifiers currently down, from the TOUCH stream's own numbering
	 * - `touchPos` keys are pointer ids, which are a different sequence and
	 * cannot be compared against `Touch.identifier`.
	 */
	private liveTouchIds = new Set<number>();
	/** Snapshot of the above taken when the current pen stroke began. */
	private touchesAtStrokeStart = new Set<number>();
	private pinchLive = false;
	/** The one transition gesture the assist pan is carrying. */
	private assistPointerId: number | null = null;
	private assistLastX = 0;
	private assistLastY = 0;
	private assistMoved = 0;
	private assistEngaged = false;
	/** Latched when the assist engages; the current touch gesture really panned. */
	private gesturePanned = false;
	/** Recent assist positions for release-velocity measurement. */
	private assistSamples: VelocitySample[] = [];
	/** Nonzero while an assist fling is gliding (rAF chain, finite). */
	private flingRaf = 0;
	private flingVx = 0;
	private flingVy = 0;
	private flingLastT = 0;

	// Native-event ownership (armed per claimed stroke + tail).
	private ownershipTailUntil = 0;
	private ownershipFn: ((e: Event) => void) | null = null;
	private ownershipDisarmTimer: number | null = null;
	/** Event types suppressed this ownership window, traced once each. */
	private suppressedTraced = new Set<string>();
	suppressedNative = 0;

	// Cold-contact diagnosis (M2 bug #2): when did the claimed stroke start,
	// and how late did its first input-rate samples arrive?
	private strokeDownAt = 0;
	private firstRawTraced = false;
	/** Raw-vs-move ink arbitration; see InkFeed.ts for the whole story. */
	private inkFeed = new InkFeedArbiter();

	// Acquisition context printed with every CLAIMED pen-down.
	private lastTouchAt = Number.NEGATIVE_INFINITY;
	private lastPenHoverAt = Number.NEGATIVE_INFINITY;
	private lastPenHoverX = Number.NEGATIVE_INFINITY;
	private lastPenHoverY = Number.NEGATIVE_INFINITY;
	private lastHoverTraceAt = Number.NEGATIVE_INFINITY;
	private lastHoverButtons = -1;

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
		private guardTouchAction: string = "none"
	) {
		this.scrollEl = scrollEl;
		this.rectEl = rectEl;
		this.cb = cb;
		this.scaleProvider = scaleProvider;
		this.rect = rectEl.getBoundingClientRect();
		liveScrollers.add(scrollEl);
		armWindowMirror(() => [...liveScrollers]);
		// Standing guard: armed from birth, so even the very first contact of
		// a session, with zero hover, meets a committed touch-action: none.
		this.applyGuard(this.manip.penSignal(), "resting");

		// Everything is CAPTURE phase: the scroller is the content element's
		// parent, so these run before any CodeMirror handler regardless of
		// registration order. Non-pen events (and pen hover) fall straight
		// through; the listener returns without touching them.
		const on = (type: string, fn: (ev: PointerEvent) => void) => {
			const h = (ev: Event) => fn(ev as PointerEvent);
			this.scrollEl.addEventListener(type, h, { capture: true });
			this.disposers.push(() =>
				this.scrollEl.removeEventListener(type, h, { capture: true })
			);
		};

		on("pointerdown", (e) => this.pointerDown(e));
		on("pointermove", (e) => this.pointerMove(e));
		on("pointerrawupdate", (e) => this.pointerRawUpdate(e));
		on("pointerup", (e) => this.pointerUpOrCancel(e));
		on("pointercancel", (e) => this.pointerUpOrCancel(e));
		on("gotpointercapture", (e) => {
			if (e.pointerType === "pen") tr("gotpointercapture", e);
		});
		on("lostpointercapture", (e) => {
			if (e.pointerType !== "pen" && !this.mouseActsAsPen(e)) return;
			tr("lostpointercapture", e, this.activePenId !== null ? "DURING STROKE" : "");
			this.endPenStroke(e, false);
		});
		on("pointerleave", (e) => {
			if (e.pointerType === "pen") {
				tr("pointerleave", e, this.activePenId !== null ? "DURING STROKE" : "");
				const next = e.relatedTarget as Node | null;
				const stillInside =
					next !== null && typeof next.nodeType === "number" && this.scrollEl.contains(next);
				if (this.activePenId === null && !stillInside) this.cb.onPenLeave();
			}
		});
		// The linked-mentions band (`.embedded-backlinks`) renders in the SAME
		// view but OUTSIDE the scroller, so a pen landing there was never
		// claimed: the contact stayed native and the browser synthesized a
		// click - erasing near the band pressed its buttons (orion
		// 2026-08-26). One capture listener on the view root claims
		// eraser-intent contacts whose target sits inside the band; after the
		// claim, setPointerCapture retargets the rest of the gesture to the
		// scroller and every existing listener takes over. Tip and side button
		// contacts on the band stay native so backlink rows keep clicking.
		const bandRoot =
			typeof scrollEl.closest === "function"
				? scrollEl.closest(".markdown-source-view")
				: null;
		if (bandRoot && bandRoot !== scrollEl) {
			const h = (ev: Event) => {
				const pe = ev as PointerEvent;
				const t = pe.target as Element | null;
				// Duck-typed, not instanceof: a popout window's elements are
				// another realm's and instanceof would refuse them.
				if (!t || typeof t.closest !== "function") return;
				if (this.scrollEl.contains(t)) return; // scroller listeners own it
				if (!t.closest(".embedded-backlinks")) return;
				if (!(this.cb.claimBandContact?.(pe) ?? false)) return;
				this.pointerDown(pe);
			};
			bandRoot.addEventListener("pointerdown", h, { capture: true });
			this.disposers.push(() =>
				bandRoot.removeEventListener("pointerdown", h, { capture: true })
			);
		}

		// iOS port: on iPadOS the Pencil produces a SECOND event stream, the
		// touch events Safari synthesizes for compatibility, and that stream
		// is the one CodeMirror and the system read for text interaction.
		// preventDefault on our pointer events never touches it, which is why
		// the keyboard rose on every stroke and the selection wash painted
		// over fresh ink on both test iPads. WebKit marks these touches
		// `touchType: "stylus"`; eat any touch event made only of them, in
		// the capture phase, before the editor sees it. Finger touches pass
		// (scroll and caret placement by hand keep working), and on engines
		// without the property nothing matches, so this is inert on the
		// Surface. Registered non-passive explicitly: preventDefault is the
		// entire point.
		{
			const eatStylus = (ev: Event) => {
				const te = ev as TouchEvent;
				if (!te.changedTouches) return;
				// Registered on the WINDOW (see below), so the first question
				// is whether this touch is even ours. Everything past this
				// line behaves exactly as it did when the listener sat on the
				// scroller - including the bookkeeping, which must only ever
				// count contacts on our own surface.
				//
				// `contains` and not instanceof: a popout window's elements
				// belong to another realm, and the scroller is asked about its
				// own descendants either way.
				const target = te.target as Node | null;
				if (!target || !this.scrollEl.contains(target)) return;
				// Bookkeeping first, and for every event including the ones
				// eaten below: the set has to reflect what the browser thinks
				// is down, not what we let through.
				if (te.type === "touchstart") {
					for (let i = 0; i < te.changedTouches.length; i++) {
						const id = te.changedTouches[i]?.identifier;
						if (typeof id === "number") this.liveTouchIds.add(id);
					}
				} else if (te.type === "touchend" || te.type === "touchcancel") {
					for (let i = 0; i < te.changedTouches.length; i++) {
						const id = te.changedTouches[i]?.identifier;
						if (typeof id === "number") this.liveTouchIds.delete(id);
					}
				}
				if (stylusOnlyTouches(te.changedTouches)) {
					te.preventDefault();
					te.stopPropagation();
					tr(te.type, null, "stylus touch eaten (webkit text layer)");
					return;
				}
				// The pen's parallel TOUCH stream on engines with no stylus
				// marking. WebKit tags Pencil touches and the branch above
				// eats them; Chromium tags nothing, so on Android tablets
				// (Onyx Boox, reported 2026-08-27) the stylus arrives twice -
				// once as the pointer events we claim, once as touches we
				// never saw. Those touches reach the app: they focus the
				// contenteditable and raise the keyboard, and a stroke that
				// travels sideways reads as Obsidian's open-the-sidebar
				// swipe, mid-word.
				//
				// PalmGate already states the rule - "while a pen stroke is
				// active, all NEW touch contacts are ignored" - it just never
				// governed the touch stream. It does now, and it is the pen's
				// OWN state rather than a platform sniff, so nothing here
				// needs to know what device it is running on.
				if (this.gate.isPenStrokeActive) {
					// ...except the tail of a gesture that was already running
					// when the pen landed. Killing a scroll mid-fling because
					// someone rested the pen to write is its own bug, and an
					// eaten touchend leaves the browser tracking a touch that
					// never ended.
					if (!touchesPredateStroke(te.changedTouches, this.touchesAtStrokeStart)) {
						te.preventDefault();
						te.stopPropagation();
						tr(te.type, null, "touch eaten: a pen stroke owns the surface");
						return;
					}
					tr(te.type, null, "touch allowed: it was down before the stroke");
					return;
				}
				// A palm resting BEFORE the pen touches down. PalmGate's
				// "palm placed before pen" rule keys off pen hover, and
				// Pencil hover only exists on recent iPads - on the rest the
				// palm reaches the contenteditable with no pen signal yet and
				// the keyboard slides up before a stroke is drawn (alan,
				// iPad). Contact size is the only signal at that instant.
				// The radius threshold is the one constant here chosen without
				// hardware to check it against. Trace what the device actually
				// reports on every touchstart, so a single pen trace from an
				// Android tablet settles whether 40px is right rather than
				// another round of guessing.
				if (te.type === "touchstart" && diagnosticsEnabled()) {
					const sizes: string[] = [];
					for (let i = 0; i < te.changedTouches.length; i++) {
						const touch = te.changedTouches[i];
						sizes.push(
							`${touch?.radiusX ?? "?"}x${touch?.radiusY ?? "?"}` +
								(typeof (touch as { touchType?: string })?.touchType === "string"
									? `/${(touch as { touchType?: string }).touchType}`
									: "")
						);
					}
					tr(te.type, null, `touch radii: ${sizes.join(", ")}`);
				}
				if (palmSizedTouches(te.changedTouches)) {
					te.preventDefault();
					te.stopPropagation();
					tr(te.type, null, "palm-sized touch eaten (keyboard suppression)");
				}
			};
			// On the WINDOW, not the scroller. Capture descends from the
			// outside in, so a listener on the scroller is the LAST thing to
			// see a touch - after every app-level handler above it. Obsidian's
			// open-the-sidebar swipe is one of those, which is why a sideways
			// stroke still opened a side panel on an Onyx Boox even with the
			// rule below saying it must not (reported 2026-08-27, and the rule
			// was right; it was just being applied somewhere it could be
			// pre-empted). armOwnership already states the principle for
			// mouse-like fallout - "window precedes document in capture order,
			// so these pre-empt Obsidian's app-level handlers" - and the touch
			// stream simply never got the same treatment.
			//
			// Nothing widens except reach: the target check above confines
			// every decision to our own scroller, so touches anywhere else in
			// the app never meet this code at all.
			// touchcancel included, and it is the reason this list is not
			// just the three "normal" ones. The browser sends it instead of
			// touchend whenever it takes a gesture over - a system swipe, a
			// palm the OS rejects - and without it the contact's id was
			// never removed from liveTouchIds. The set is what
			// touchesAtStrokeStart is snapshotted from, so one cancelled
			// touch made every later stroke believe a finger had been down
			// since before it started, and stopped eating it.
			for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
				this.winRef.addEventListener(type, eatStylus, {
					capture: true,
					passive: false,
				});
				this.disposers.push(() =>
					this.winRef.removeEventListener(type, eatStylus, { capture: true })
				);
			}
		}

		// Pen-sourced context menus on the note are never wanted: mid-stroke
		// long-press, side-button press at contact (fires AFTER pointerup, so the old
		// during-stroke check missed it and menus stacked), and side-button press
		// while merely hovering. Mouse right-click away from the pen passes.
		{
			const h = (ev: Event) => {
				// Mouse-ink mode: hover moves run the pen-hover path, so the
				// palm gate reads "pen near" whenever the mouse just moved -
				// and a right-click straight after moving is the NORMAL case.
				// The first click ate the menu (orion 2026-08-26); the mouse
				// keeps its menu, and only its own stroke/tail suppress it.
				const pt = (ev as PointerEvent).pointerType;
				// A finger planted to stabilize the hand BEFORE the pen
				// arrives long-presses into a right-click on windows (orion
				// 2026-08-26: switch note, plant finger, menu). Chromium
				// stamps that contextmenu pointerType "touch". Once a pen
				// has been seen this session, a touch long-press on the
				// writing surface is a stabilizing hand; sessions that never
				// see a pen keep their long-press menu.
				const stabilizingHand = pt === "touch" && penSeenThisSession();
				const suppress =
					stabilizingHand ||
					contextMenuSuppressed({
						activeStroke: this.activePenId !== null,
						now: performance.now(),
						ownershipTailUntil: this.ownershipTailUntil,
						pointerType: pt,
						penNear:
							this.gate.isPenNear(performance.now()) &&
							!(pt === "mouse" && mouseInkEnabled()),
					});
				if (suppress) {
					this.traceSuppressed("contextmenu(scroller)");
					ev.preventDefault();
					ev.stopPropagation();
				}
			};
			this.scrollEl.addEventListener("contextmenu", h, { capture: true });
			this.disposers.push(() =>
				this.scrollEl.removeEventListener("contextmenu", h, { capture: true })
			);
		}
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
	 */
	private armOwnership(): void {
		if (this.ownershipDisarmTimer !== null) {
			window.clearTimeout(this.ownershipDisarmTimer);
			this.ownershipDisarmTimer = null;
		}
		this.suppressedTraced.clear();
		if (this.ownershipFn) return; // still armed from the previous stroke's tail
		const fn = (ev: Event) => {
			const fromTouch =
				(ev as PointerEvent).pointerType === "touch" ||
				((ev as UIEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } })
					.sourceCapabilities?.firesTouchEvents ??
					false);
			if (
				!suppressNativeFallout({
					activeStroke: this.activePenId !== null,
					now: performance.now(),
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
	private scheduleOwnershipDisarm(): void {
		this.ownershipTailUntil = performance.now() + OWNERSHIP_TAIL_MS;
		if (this.ownershipDisarmTimer !== null) window.clearTimeout(this.ownershipDisarmTimer);
		this.ownershipDisarmTimer = window.setTimeout(() => {
			this.ownershipDisarmTimer = null;
			this.disarmOwnership();
		}, OWNERSHIP_TAIL_MS + 50);
	}

	private disarmOwnership(): void {
		if (!this.ownershipFn) return;
		if (this.activePenId !== null) return; // a new stroke re-claimed meanwhile
		for (const type of OWNED_NATIVE_EVENTS) {
			this.winRef.removeEventListener(type, this.ownershipFn, { capture: true });
		}
		this.ownershipFn = null;
	}

	private traceSuppressed(type: string): void {
		this.suppressedNative++;
		if (this.suppressedTraced.has(type)) return;
		this.suppressedTraced.add(type);
		tr("suppressed", null, `${type}: claimed pen gesture owns this interaction`);
	}

	dispose(): void {
		this.cancelFling();
		this.touchPos.clear();
		this.pinchLive = false;
		liveScrollers.delete(this.scrollEl);
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
		this.disarmOwnership();
	}

	// ---- standing gesture guard ---------------------------------------------

	/** Apply a ManipulationGuard decision to the scroller and timers. */
	private applyGuard(d: GuardDecision, why: string): void {
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
			if (!this.savedTouchActionKnown) {
				this.savedTouchAction = this.scrollEl.style.touchAction;
				this.savedTouchActionKnown = true;
			}
			this.guardApplied = true;
			armGuardStyle(this.scrollEl, this.guardTouchAction);
			tr("guard", null, `touch-action: none (${why})`);
		} else if (!wantNone && this.guardApplied) {
			this.guardApplied = false;
			disarmGuardStyle(this.scrollEl, this.savedTouchAction);
			tr("guard", null, `touch-action restored (${why})`);
		}
	}

	private restoreGuardStyle(): void {
		if (this.rearmTimer !== null) {
			window.clearTimeout(this.rearmTimer);
			this.rearmTimer = null;
		}
		if (this.guardApplied) {
			this.guardApplied = false;
			disarmGuardStyle(this.scrollEl, this.savedTouchAction);
			tr("guard", null, "touch-action restored (guard disabled/disposed)");
		}
	}

	/** The transition gesture: 1:1 pan while Chromium's snapshot said none. */
	// ---- pinch (tier 1: two fingers, pen away) ------------------------------

	/**
	 * A second non-palm finger turns the gesture into a pinch. The assist pan
	 * is dropped without a fling: the note must not coast while it resizes.
	 */
	private beginPinch(e: PointerEvent): void {
		const pts = [...this.touchPos.values()];
		if (pts.length !== 2) return;
		this.cancelFling();
		if (this.assistPointerId !== null) {
			this.assistPointerId = null;
			this.assistEngaged = false;
			this.assistSamples = [];
		}
		// Take the surface back. Left in the native window, the browser claims
		// the two contacts and cancels them before the pinch does anything.
		this.applyGuard(this.manip.pinchStart(), "pinch");
		this.pinchStartSpread = pinchSpread(pts[0]!, pts[1]!);
		// Re-arming over a LIVE pinch (a third finger lands, or one lifts and
		// another takes its place) used to clear the flag silently, so the
		// listener never heard "end" for a pinch it had heard "start" for.
		// Every start is matched by an end, or state built on that pairing
		// wedges - which is exactly what happened downstream.
		if (this.pinchLive) {
			this.pinchLive = false;
			this.cb.onPinch("end", 1, this.pinchCentroid());
			tr("guard", e, "pinch re-armed: ended the live one first");
		}
		this.pinchLive = false;
		tr("guard", e, `pinch watched (spread ${this.pinchStartSpread.toFixed(0)}px)`);
	}

	/** Midpoint of the two live contacts, in client px. */
	private pinchCentroid(): { x: number; y: number } {
		const pts = [...this.touchPos.values()];
		if (pts.length !== 2) return { x: 0, y: 0 };
		return pinchMidpoint(pts[0]!, pts[1]!);
	}

	/** Returns true when the pinch owned this move. */
	private updatePinch(e: PointerEvent): boolean {
		if (this.touchPos.size !== 2) return false;
		const pts = [...this.touchPos.values()];
		const spread = pinchSpread(pts[0]!, pts[1]!);
		if (!this.pinchLive) {
			if (!pinchEngaged(this.pinchStartSpread, spread)) return false;
			this.pinchLive = true;
			this.cb.onPinch("start", 1, this.pinchCentroid());
			tr("guard", e, "pinch engaged");
		}
		this.cb.onPinch("move", pinchRatio(this.pinchStartSpread, spread), this.pinchCentroid());
		return true;
	}

	/**
	 * Any lift ends the pinch; the remaining finger does not resume panning.
	 *
	 * `centroid`, when given, is the release-path caller's own reading of
	 * `pinchCentroid()` taken BEFORE it removed the lifted contact from
	 * `touchPos` - by the time this runs that contact is already gone, so
	 * `pinchCentroid()` here would see one touch and report {0,0}
	 * (audit-fixes-design.md 5i I2). Callers that still have both contacts
	 * live when they call this (none do today) can omit it.
	 */
	private endPinch(e: PointerEvent, centroid?: { x: number; y: number }): void {
		if (!this.pinchLive) return;
		this.pinchLive = false;
		this.cb.onPinch("end", 1, centroid ?? this.pinchCentroid());
		tr("guard", e, "pinch released");
	}

	private beginAssist(e: PointerEvent): void {
		this.cancelFling(); // a new finger takes over the glide
		this.assistSamples = [];
		this.assistPointerId = e.pointerId;
		this.assistLastX = e.clientX;
		this.assistLastY = e.clientY;
		this.assistMoved = 0;
		this.assistEngaged = false;
	}

	private assistMove(e: PointerEvent): boolean {
		if (e.pointerId !== this.assistPointerId) return false;
		const dx = e.clientX - this.assistLastX;
		const dy = e.clientY - this.assistLastY;
		this.assistLastX = e.clientX;
		this.assistLastY = e.clientY;
		this.assistMoved += Math.abs(dx) + Math.abs(dy);
		if (!this.assistEngaged && this.assistMoved > ASSIST_SLOP_PX) {
			this.assistEngaged = true;
			this.gesturePanned = true;
			// Keep the rest of the gesture off the editor, like a native pan
			// would (a native pan pointercancels the tap machinery).
			try {
				this.scrollEl.setPointerCapture(e.pointerId);
			} catch {
				/* best-effort */
			}
			tr("guard", e, "assist pan engaged (transition gesture)");
		}
		if (this.assistEngaged) {
			this.scrollEl.scrollLeft -= dx;
			this.scrollEl.scrollTop -= dy;
			const now = performance.now();
			this.assistSamples.push({ t: now, x: e.clientX, y: e.clientY });
			if (this.assistSamples.length > 12) this.assistSamples.shift();
			return true;
		}
		return false;
	}

	private endAssist(e: PointerEvent): boolean {
		if (e.pointerId !== this.assistPointerId) return false;
		const engaged = this.assistEngaged;
		this.assistPointerId = null;
		this.assistEngaged = false;
		if (engaged) {
			// A native pan would fling here; give the assist the same physics.
			const v = releaseVelocity(this.assistSamples, performance.now());
			if (v) this.startFling(v.vx, v.vy);
		}
		this.assistSamples = [];
		return engaged;
	}

	/**
	 * Assist momentum: a finite, self-ending rAF chain (see Fling.ts).
	 * Cancelled by ANY new pointer contact. The pen always wins instantly.
	 */
	private startFling(vx: number, vy: number): void {
		// The one number a "scrolling feels too fast" report needs: what the
		// release actually measured. Everything downstream is deterministic
		// physics, so a bad glide is either a bad velocity here or a surface
		// with too much room to glide in - and the trace says which.
		tr(
			"fling",
			null,
			`release v=(${vx.toFixed(2)}, ${vy.toFixed(2)}) px/ms  speed ${Math.hypot(vx, vy).toFixed(2)}`
		);
		this.cancelFling();
		this.flingVx = vx;
		this.flingVy = vy;
		this.flingLastT = performance.now();
		const tick = () => {
			this.flingRaf = 0;
			const now = performance.now();
			const s = flingStep(this.flingVx, this.flingVy, now - this.flingLastT);
			this.flingLastT = now;
			this.flingVx = s.vx;
			this.flingVy = s.vy;
			const beforeL = this.scrollEl.scrollLeft;
			const beforeT = this.scrollEl.scrollTop;
			this.scrollEl.scrollLeft = beforeL - s.dx;
			this.scrollEl.scrollTop = beforeT - s.dy;
			const moved =
				this.scrollEl.scrollLeft !== beforeL || this.scrollEl.scrollTop !== beforeT;
			// Done when the physics say so, or the scroller is clamped at an
			// edge and the glide has nowhere left to go.
			if (s.done || (!moved && Math.abs(s.dx) + Math.abs(s.dy) > 0.5)) return;
			this.flingRaf = this.winRef.requestAnimationFrame(tick);
		};
		this.flingRaf = this.winRef.requestAnimationFrame(tick);
	}

	private cancelFling(): void {
		if (this.flingRaf !== 0) {
			this.winRef.cancelAnimationFrame(this.flingRaf);
			this.flingRaf = 0;
		}
	}

	get isStroking(): boolean {
		return this.activePenId !== null;
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
	private get winRef(): Window {
		return this.scrollEl.ownerDocument?.defaultView ?? window;
	}

	/**
	 * Mouse-ink mode (roadmap: mouse input): while the switch is on, the
	 * mouse's LEFT button is treated as a pen tip. Right and middle stay
	 * native so the context menu and paste-click keep working; everything
	 * downstream of the claim is the ordinary pen path.
	 */
	private mouseActsAsPen(e: PointerEvent): boolean {
		return e.pointerType === "mouse" && mouseInkEnabled();
	}

	private sampleFrom(e: PointerEvent): PenSample {
		const scale = this.scaleProvider();
		return {
			x: visualToNote(e.clientX - this.rect.left, scale),
			y: visualToNote(e.clientY - this.rect.top, scale),
			pressure: e.pressure > 0 ? e.pressure : e.pointerType === "pen" ? 0 : 0.5,
			timestamp: e.timeStamp,
			tiltX: e.tiltX,
			tiltY: e.tiltY,
		};
	}

	// ---- pointerdown --------------------------------------------------------

	private pointerDown(e: PointerEvent): void {
		this.cancelFling(); // any new contact ends the glide (pen wins instantly)
		if (e.pointerType === "touch") {
			this.lastTouchAt = performance.now();
			scrollProbeTouch();
			// The one piece of touch arbitration Handwriting owns: a palm planted
			// while the pen is writing or hovering must not scroll the note or
			// move the caret. Everything else about touch is the editor's.
			// Palm-blocked contacts never open the guard's touch window.
			if (this.gate.blocksNewTouch(performance.now())) {
				this.palmsBlocked++;
				telemetry.bump("inline.palmBlocked");
				this.swallowedTouches.add(e.pointerId);
				// Watch it: a swipe-like start earns parole (assist pan);
				// a resting palm stays swallowed.
				this.paroleId = e.pointerId;
				this.paroleDownX = e.clientX;
				this.paroleDownY = e.clientY;
				this.paroleDownAt = performance.now();
				this.paroleContactPx = Math.max(e.width || 0, e.height || 0);
				// Landed while the pen is down: the hand that follows the pen,
				// never a scroll finger. No parole, ever (eraser-scrub fix).
				this.paroleOverlapped = this.activePenId !== null;
				tr(
					"pointerdown",
					e,
					this.paroleOverlapped
						? "touch PALM-BLOCKED (landed mid-stroke: palm for life)"
						: "touch PALM-BLOCKED (parole watched)"
				);
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			// Non-palm-gated finger. While the guard is armed the gesture runs
			// UNDER the standing touch-action: none, carried by the assist pan
			// (v0.12.12: the window no longer opens at touchStart; a cold
			// slam's leading palm graze must never sell out the pen that lands
			// milliseconds later). The native window opens on last-finger lift,
			// and only if the gesture actually panned.
			this.guardTouches.add(e.pointerId);
			this.touchPos.set(e.pointerId, { x: e.clientX, y: e.clientY });
			const d = this.manip.touchStart();
			// Second finger down with no pen near: this is a pinch, not a pan.
			// Registered with the guard first, so the touch count stays honest.
			if (this.touchPos.size === 2) {
				this.beginPinch(e);
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			this.applyGuard(d, "touch");
			if (d.assistThisGesture && guardEnabled) {
				this.beginAssist(e);
				tr("pointerdown", e, "touch (guard held; assist will carry this gesture)");
			} else {
				tr(
					"pointerdown",
					e,
					d.touchAction === "" ? "touch passthrough (native window)" : "touch (guard held)"
				);
			}
			return;
		}
		// Mouse: never touched, unless mouse-ink mode is on - then the left
		// button is a pen tip and other buttons stay native.
		if (e.pointerType !== "pen") {
			if (!this.mouseActsAsPen(e) || (e.buttons & 1) === 0) return;
		}
		if (this.activePenId !== null) {
			// one pen at a time
			tr("pointerdown", e, `pen IGNORED: stroke ${this.activePenId} still active`);
			if (isHitProbeEnabled()) hitProbeDown(e, false, this.scrollEl);
			return;
		}

		// EVERY pen contact is a Handwriting gesture now: tip = ink, eraser end =
		// erase, side button held = lasso/manipulate (§52/§53, the interaction the
		// canvas settled). The overlay reads ev.buttons at pen-down to decide
		// which; the router's job is only to claim the contact before the
		// editor can turn it into selection or a context menu.
		const kind =
			(e.buttons & 32) !== 0 || e.button === 5
				? "eraser"
				: (e.buttons & 2) !== 0
					? "side"
					: "tip";
		// COLD = the gesture guard was not pre-armed by hover; if cold contacts
		// start late, the first-raw trace line below tells us exactly how the
		// samples arrived (withheld-then-flushed vs genuinely delayed).
		{
			const now = performance.now();
			const ago = (at: number) =>
				at === Number.NEGATIVE_INFINITY ? "never" : `${(now - at).toFixed(0)}ms ago`;
			tr(
				"pointerdown",
				e,
				`pen CLAIMED (${kind}) guard=${this.guardApplied ? "prearmed" : "COLD"}` +
					` | last finger ${ago(this.lastTouchAt)}, last pen hover ${ago(this.lastPenHoverAt)}` +
					` | touch-action at entry "${this.scrollEl.style.touchAction || "(unset)"}"`
			);
		}
		this.strokeDownAt = performance.now();
		this.firstRawTraced = false;
		// Ink feed floor: samples stamped at or before the down never ink
		// (the down itself goes through onPenDown). Same clock as the
		// coalesced samples', so the comparison is apples to apples.
		this.inkFeed.strokeStart(e.timeStamp);
		this.armOwnership();
		// Pen signal: the standing guard (re-)arms and cancels any pending
		// touch-window re-arm timer. A touch the assist was carrying is
		// reclassified as palm. The hand's edge reached the glass just ahead
		// of the tip on a cold slam, and it must not pan under the writing hand.
		if (this.assistPointerId !== null) {
			tr("guard", e, `assist cancelled: leading touch ${this.assistPointerId} reclassified as palm`);
			this.assistPointerId = null;
			this.assistEngaged = false;
		}
		// Same for a pinch: fingers still down when the tip lands belong to the
		// writing hand now, so the note must stop resizing under it.
		if (this.pinchLive) {
			this.pinchLive = false;
			this.cb.onPinch("end", 1, this.pinchCentroid());
			tr("guard", e, "pinch cancelled: pen claimed the surface");
		}
		// A swallowed contact still down when the pen lands is the hand that
		// follows the pen; it can never earn parole afterwards. Eraser
		// scrubbing lifts and re-lands the nib every few hundred ms with the
		// hand's edge sliding in between. Judged by motion alone, that slide
		// became an assist pan and walked the viewport (RC3).
		if (this.paroleId !== null && !this.paroleOverlapped) {
			this.paroleOverlapped = true;
			tr("guard", e, `parole voided: pen landed while touch ${this.paroleId} was down (palm for life)`);
		}
		this.gesturePanned = false;
		this.applyGuard(this.manip.penSignal(), "pen-down");
		e.preventDefault();
		e.stopPropagation();
		this.refreshRect();
		this.activePenId = e.pointerId;
		this.penDowns++;
		telemetry.bump("inline.penDown");
		this.armEndBackstop();
		this.gate.penStrokeStarted();
		// Whatever fingers were already down get to finish their gesture; see
		// touchesPredateStroke.
		this.touchesAtStrokeStart = new Set(this.liveTouchIds);
		try {
			this.scrollEl.setPointerCapture(e.pointerId);
		} catch {
			/* best-effort; the backstop covers a failed capture */
		}
		if (isHitProbeEnabled()) hitProbeDown(e, true, this.scrollEl);
		if (this.mouseActsAsPen(e)) {
			this.mouseTrail.reset();
			this.mouseStrokeTrail = this.mouseTrail;
		} else {
			this.mouseStrokeTrail = null;
		}
		// The down sample is the anchor and goes through raw: the reader of
		// an export should find the stroke starting where the click was.
		this.cb.onPenDown(this.sampleFrom(e), e);
	}

	/**
	 * Hover with no active stroke, throttled: one line per 150 ms OR whenever
	 * `buttons` changes. `buttons !== 0` while hovering means the digitizer
	 * reports the nib PRESSED yet no pointerdown arrived, the smoking gun the
	 * summary counts as a pressed-but-undelivered sample.
	 */
	private traceHover(e: PointerEvent): void {
		// RC4: switch first. Hover fires continuously whenever the pen is near
		// the glass, writing or not.
		if (!diagnosticsEnabled()) return;
		const now = performance.now();
		if (e.buttons === this.lastHoverButtons && now - this.lastHoverTraceAt < 150) return;
		this.lastHoverTraceAt = now;
		this.lastHoverButtons = e.buttons;
		tr(
			"pen-hover",
			e,
			`NO CONTACT CLAIMED; buttons=${e.buttons} pressure=${e.pressure.toFixed(3)}` +
				(e.buttons !== 0 ? "  <-- PRESSED BUT NO pointerdown" : "")
		);
	}

	// ---- pointermove / pointerrawupdate -------------------------------------

	private pointerMove(e: PointerEvent): void {
		// A real mouse entering while the pen remains nearby gets the ordinary
		// editor cursor. The same-point compatibility move Windows emits right
		// after pen hover is still the pen and must not flash the I-beam.
		if (
			e.pointerType === "mouse" &&
			!mouseInkEnabled() &&
			!isPenCompatMouseMove({
				now: performance.now(),
				lastPenHoverAt: this.lastPenHoverAt,
				mouseX: e.clientX,
				mouseY: e.clientY,
				penX: this.lastPenHoverX,
				penY: this.lastPenHoverY,
			})
		) {
			this.cb.onPenLeave();
		}
		if (e.pointerType === "touch") {
			this.lastTouchAt = performance.now();
			scrollProbeTouch();
			if (this.swallowedTouches.has(e.pointerId)) {
				if (
					e.pointerId === this.paroleId &&
					paroleEarned({
						travelPx:
							Math.abs(e.clientX - this.paroleDownX) +
							Math.abs(e.clientY - this.paroleDownY),
						sinceDownMs: performance.now() - this.paroleDownAt,
						penStrokeActive: this.gate.isPenStrokeActive,
						contactPx: this.paroleContactPx,
						penContactOverlapped: this.paroleOverlapped,
					})
				) {
					// Swipe-like: this was a deliberate scroll finger the palm
					// gate swallowed (pen hovering nearby). Convert it into the
					// assist pan. Its native default died at pointerdown, so the
					// assist must carry it regardless of guard state; a pen
					// claim still cancels the assist instantly (pen wins).
					this.swallowedTouches.delete(e.pointerId);
					this.paroleId = null;
					this.paroleOverlapped = false;
					this.guardTouches.add(e.pointerId);
					this.applyGuard(this.manip.touchStart(), "touch-parole");
					this.beginAssist(e);
					this.assistEngaged = true;
					this.gesturePanned = true;
					// Retroactive catch-up: the run-up traveled while being
					// watched is applied now, so total displacement matches a
					// 1:1 pan from touchdown, so parole feels like touch slop,
					// not a dead zone. Seed the velocity window with the down
					// point so a fast conversion still flings correctly.
					this.scrollEl.scrollLeft -= e.clientX - this.paroleDownX;
					this.scrollEl.scrollTop -= e.clientY - this.paroleDownY;
					this.assistSamples.push({
						t: this.paroleDownAt,
						x: this.paroleDownX,
						y: this.paroleDownY,
					});
					try {
						this.scrollEl.setPointerCapture(e.pointerId);
					} catch {
						/* best-effort */
					}
					tr("guard", e, "palm parole: swallowed touch became assist pan");
					e.preventDefault();
					e.stopPropagation();
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (this.touchPos.has(e.pointerId)) {
				this.touchPos.set(e.pointerId, { x: e.clientX, y: e.clientY });
				if (this.updatePinch(e)) {
					e.preventDefault();
					e.stopPropagation();
					return;
				}
			}
			// A guard-tracked touch during a claimed stroke is a palm (its
			// assist, if any, was cancelled at claim): keep it off the editor.
			if (this.activePenId !== null && this.guardTouches.has(e.pointerId)) {
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			// Transition gesture: carry the pan ourselves and keep it off the
			// editor, exactly as a native pan would.
			if (this.assistMove(e)) {
				e.preventDefault();
				e.stopPropagation();
			}
			return;
		}
		if (e.pointerType !== "pen" && !this.mouseActsAsPen(e)) return;
		if (this.activePenId === null) {
			// Hovering keeps the palm gate warm ("palm placed before pen") and
			// re-arms the standing guard instantly if a touch window was open.
			this.lastPenHoverAt = performance.now();
			this.lastPenHoverX = e.clientX;
			this.lastPenHoverY = e.clientY;
			this.gate.penHoverSeen(performance.now());
			this.applyGuard(this.manip.penSignal(), "pen-hover");
			this.traceHover(e);
			if (isHitProbeEnabled()) hitProbeHover(e);
			this.cb.onPenHover(this.sampleFrom(e), e.pointerType);
			return;
		}
		if (e.pointerId !== this.activePenId) return;
		if (silentLift(e)) {
			this.silentLiftEnds++;
			telemetry.bump("inline.penUp.silentLift");
			tr(e.type, e, "SILENT LIFT, TERMINATES STROKE");
			this.endPenStroke(e, false);
			return;
		}
		e.preventDefault();
		e.stopPropagation(); // no link-hover popovers under a moving nib
		telemetry.bump("inline.penMove");
		// iOS port: WebKit never fires pointerrawupdate, so while no pen raw
		// has ever arrived this session the move stream carries the ink,
		// expanded from its coalesced list (up to 4 samples per move on the
		// iPad that proved this out; hardware report 2026-08-25). The first
		// raw anywhere, hover included, retires this branch for the session,
		// and on Chromium that has happened before any stroke exists. Same
		// downstream contract as the raw path: onPenRaw feeds StrokeBuilder,
		// the tools, the wet layer, all of it.
		if (this.inkFeed.moveFeedsInk()) {
			markRawPointer(e.clientX, e.clientY);
			telemetry.bump("inline.moveFedInk");
			const coalesced =
				typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
			const events = coalesced.length > 0 ? coalesced : [e];
			// This row IS the webkit stream's record: on the iPad no raw ever
			// arrives, so without it a capture holds no geometry at all for
			// the events that carried the ink.
			//
			// Gated, like the raw path below and for the reason stated there:
			// tr() returns early with the switch off, but the ARGUMENTS are
			// built first, so csOf allocated a TraceSample per coalesced
			// sample - up to four - plus a template string, on every move of
			// every stroke. This is the WebKit ink hot path; it is the one
			// call site that never got the RC4 rule.
			if (diagnosticsEnabled()) {
				tr("pointermove", e, `move-fed coalesced=${events.length}`, csOf(events));
			}
			const fed = this.inkFeed.feed(events.map((ce) => ce.timeStamp));
			const samples: PenSample[] = [];
			for (const i of fed) {
				const ce = events[i];
				if (ce !== undefined) samples.push(this.sampleFrom(ce));
			}
			if (diagnosticsEnabled()) {
				// The label reports what the arbiter DECIDED, after the
				// timestamp gate: the ipad trace of 2026-08-26 delivered every
				// move twice, and the duplicates printed "INK-FED" while
				// feeding nothing.
				tr(
					"pointermove",
					e,
					`coalesced=${events.length} ` +
						(samples.length > 0
							? `INK-FED ${samples.length} sample(s), no rawupdate this session`
							: "fed nothing (all samples at or below the stroke's high-water mark)")
				);
			}
			if (samples.length > 0) this.cb.onPenRaw(this.smoothed(samples), e);
			this.cb.onPenMove(e, events.length);
			return;
		}
		// RC4: nothing here draws. `onPenMove` only feeds the move counter in
		// StrokeMetrics (ink comes from pointerrawupdate below), so the
		// coalesced-array allocation and the trace string exist purely to be
		// counted. While the switch is off they were allocated and thrown
		// away on every move event of every stroke.
		if (diagnosticsEnabled()) {
			const coalesced =
				typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
			const n = coalesced.length > 0 ? coalesced.length : 1;
			tr("pointermove", e, `coalesced=${n}`, coalesced.length > 0 ? csOf(coalesced) : undefined);
			this.cb.onPenMove(e, n);
		} else {
			this.cb.onPenMove(e, 1);
		}
	}

	private pointerRawUpdate(e: PointerEvent): void {
		if (e.pointerType !== "pen" && !this.mouseActsAsPen(e)) return;
		// Any pen raw, hover included, proves the channel exists for the
		// session and keeps the move handler out of the ink business.
		this.inkFeed.noteRawChannel();
		if (this.activePenId === null) {
			this.lastPenHoverAt = performance.now();
			this.gate.penHoverSeen(performance.now());
			this.applyGuard(this.manip.penSignal(), "pen-hover");
			this.traceHover(e);
			return;
		}
		if (e.pointerId !== this.activePenId) return;
		if (silentLift(e)) {
			this.silentLiftEnds++;
			telemetry.bump("inline.penUp.silentLift");
			tr(e.type, e, "SILENT LIFT, TERMINATES STROKE");
			this.endPenStroke(e, false);
			return;
		}
		// Ground truth for the probe, taken before a single line of the code
		// under test has run.
		markRawPointer(e.clientX, e.clientY);
		telemetry.bump("inline.rawUpdate");
		const coalesced =
			typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
		const events = coalesced.length > 0 ? coalesced : [e];
		// RC4: the coalesced array above is NOT diagnostic. It is the ink
		// itself, and stays unconditional. Only the trace rows are gated, and
		// they are gated here rather than inside tr() so their `toFixed` calls
		// and template strings are never built while the switch is off. This
		// is the hottest path in the plugin (200 to 250 Hz on the test Surface).
		if (diagnosticsEnabled()) {
			if (!this.firstRawTraced) {
				this.firstRawTraced = true;
				const sinceDown = performance.now() - this.strokeDownAt;
				const span = e.timeStamp - (events[0]?.timeStamp ?? e.timeStamp);
				// The cold-contact verdict lives in this line: a large `+N ms`
				// with samples SPANNING the gap = Chromium withheld-then-flushed
				// the stream (gesture arbitration); a large gap with a tiny span
				// = input genuinely started late (OS-level).
				tr(
					"first-raw",
					e,
					`+${sinceDown.toFixed(1)}ms after down, ${events.length} coalesced spanning ${span.toFixed(1)}ms`
				);
			}
			tr("pointerrawupdate", e, `coalesced=${events.length}`, csOf(events));
		}
		// Through the arbiter like every ink delivery, so a raw flushing the
		// samples a move already fed (session-first cold strike) drops its
		// duplicates by timestamp. The normal Chromium stroke passes intact.
		const fed = this.inkFeed.feed(events.map((ce) => ce.timeStamp));
		const samples: PenSample[] = [];
		for (const i of fed) {
			const ce = events[i];
			if (ce !== undefined) samples.push(this.sampleFrom(ce));
		}
		if (samples.length > 0) this.cb.onPenRaw(this.smoothed(samples), e);
	}

	/** Mouse samples through the grid filter; a pen's untouched. */
	private smoothed(samples: PenSample[]): PenSample[] {
		const trail = this.mouseStrokeTrail;
		return trail === null ? samples : samples.map((sample) => trail.push(sample));
	}

	// ---- stroke end ---------------------------------------------------------

	private pointerUpOrCancel(e: PointerEvent): void {
		if (e.pointerType === "touch") {
			if (this.swallowedTouches.delete(e.pointerId)) {
				if (this.paroleId === e.pointerId) {
					this.paroleId = null;
					this.paroleOverlapped = false;
				}
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (this.touchPos.has(e.pointerId)) {
				// Read the centroid while BOTH contacts are still in touchPos -
				// deleting first (the old order) left only the remaining
				// contact, so pinchCentroid() always reported {0,0} for an
				// ordinary pinch end (audit-fixes-design.md 5i I2).
				const centroid = this.pinchCentroid();
				this.touchPos.delete(e.pointerId);
				this.endPinch(e, centroid);
			}
			const wasAssistPan = this.endAssist(e);
			const duringStroke = this.activePenId !== null && this.guardTouches.has(e.pointerId);
			if (this.guardTouches.delete(e.pointerId)) {
				// `panned` = this gesture really scrolled (assist engaged at any
				// point). Only then does the native touch window open on the
				// last lift; taps and resting palms leave the guard armed.
				this.applyGuard(this.manip.touchEnd(this.gesturePanned || wasAssistPan), "touch-end");
				if (this.guardTouches.size === 0) this.gesturePanned = false;
			}
			if (wasAssistPan || duringStroke) {
				// The pan already happened (or a palm is lifting mid-stroke);
				// keep the trailing tap machinery off the editor, matching a
				// native pan's cancel semantics.
				e.preventDefault();
				e.stopPropagation();
			}
			return;
		}
		if (e.pointerType !== "pen" && !this.mouseActsAsPen(e)) return;
		const wasOurs = this.activePenId !== null && e.pointerId === this.activePenId;
		tr(e.type, e, wasOurs ? "TERMINATES STROKE" : "");
		if (wasOurs) {
			e.preventDefault();
			e.stopPropagation();
		}
		this.endPenStroke(e, false);
	}

	/** Idempotent single funnel, same as the canvas router. */
	private endPenStroke(e: PointerEvent, viaFallback: boolean): void {
		if (this.activePenId === null || e.pointerId !== this.activePenId) return;
		this.activePenId = null;
		this.penUps++;
		telemetry.bump("inline.penUp");
		if (viaFallback) {
			this.fallbackEnds++;
			telemetry.bump("inline.penUp.backstop");
			tr(e.type, e, "END VIA WINDOW BACKSTOP");
		}
		this.disarmEndBackstop();
		this.inkFeed.strokeEnd();
		this.gate.penStrokeEnded(performance.now());
		this.touchesAtStrokeStart.clear();
		// Standing guard: no release. Armed IS the resting state.
		hideProbeMarkers();
		// Trailing click/auxclick/contextmenu from this contact land AFTER
		// pointerup, so the ownership guard stays up through the tail.
		this.scheduleOwnershipDisarm();
		this.cb.onPenUp(e);
	}

	/** Armed only while a stroke is active, not a standing document listener. */
	private armEndBackstop(): void {
		this.disarmEndBackstop();
		const fn = (ev: Event) => {
			const pe = ev as PointerEvent;
			const path = typeof pe.composedPath === "function" ? pe.composedPath() : [];
			if (!backstopMayEnd({ pointerType: pe.pointerType, scrollerInPath: path.includes(this.scrollEl) })) {
				if (pe.pointerType === "pen" && this.activePenId !== null) {
					tr(`window-${pe.type}`, pe, "backstop stood down: scroller in path, normal handler ends it");
				}
				return;
			}
			this.endPenStroke(pe, true);
		};
		this.winEndFn = fn;
		this.winRef.addEventListener("pointerup", fn, { capture: true });
		this.winRef.addEventListener("pointercancel", fn, { capture: true });
	}

	private disarmEndBackstop(): void {
		if (!this.winEndFn) return;
		this.winRef.removeEventListener("pointerup", this.winEndFn, { capture: true });
		this.winRef.removeEventListener("pointercancel", this.winEndFn, { capture: true });
		this.winEndFn = null;
	}
}
