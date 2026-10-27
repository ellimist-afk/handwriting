/**
 * The note surface's cursor methods: the pen reticle, the eraser ring, the
 * lasso, space and pan cursors, and the hover watchdog. They are methods of
 * InkOverlayPlugin, installed on its prototype when InkOverlay.ts loads.
 * `showPenCursor`, the hover entry point, is one of them.
 */
import { installMethods } from "./InstallMethods";
import { markPenHardwareSeen, markPenSeen, pointerRaisesPenTools } from "./PenToolsMode";
import { getInkColorHex } from "../ink/InkColor";
import { DEFAULT_PEN, HIGHLIGHTER_ALPHA, HIGHLIGHTER_PEN } from "../ink/PenStyle";
import type { PenSample } from "../input/PointerRouter";
import { ERASER_CURSOR_CLASS, HOVER_GHOST_MS, PAN_DRAG_CLASS, PEN_HOVER_CLASS, penCursorLayout, penReticleShown } from "./PenCursor";
import { tipMode } from "./TipMode";
import { visualToNote } from "./ZoomScale";
import { anyHandOnGlass } from "./InlinePenRouter";
import { penInkEnabled } from "./PenInk";
import { getInkSizeMult, inlineEraserRadiusPx, inlineTool, type InkOverlayPlugin } from "./InkOverlay";
import { penReticleOn } from "./InkOverlayToolState";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		showPenCursor(sample: PenSample, pointerType?: string): void;
		refreshPenCursor(): void;
		paintPenCursor(sample: PenSample, cursorScale: number, cursorZoom: number, feedbackSample: PenSample | null): void;
		hidePenCursor(): void;
		concealPenCursor(): void;
		armHoverWatchdog(): void;
		clearHoverWatchdog(): void;
		showEraserCursor(sample: PenSample): void;
		hideEraserCursor(): void;
		showLassoCursor(sample: PenSample): void;
		hideLassoCursor(): void;
		beginPanDragCursor(): void;
		restoreReticleAfterPan(ev?: PointerEvent): void;
		showSpaceCursor(sample: PenSample): void;
		hideSpaceCursor(): void;
	}
}

const LASSO_CURSOR_CLASS = "handwriting-pen-hover-lasso";
const SPACE_CURSOR_CLASS = "handwriting-pen-hover-space";
const PAN_CURSOR_CLASS = "handwriting-pen-hover-pan";
const MODE_CURSOR_CLASSES = [ERASER_CURSOR_CLASS, LASSO_CURSOR_CLASS, SPACE_CURSOR_CLASS, PAN_CURSOR_CLASS];

/**
 * What the reticle element was last given, so a hover sample writes only
 * what changed: a class or style write that changes nothing still sets the
 * attribute, and on every sample that was a style recalculation for nothing.
 * Every write to the reticle goes through `writePenCursor`.
 */
const penCursorWritten = new WeakMap<HTMLElement, { modeClass?: string | null; style: Record<string, string> }>();

function writePenCursor(el: HTMLElement, modeClass: string | null | undefined, style: Record<string, string>): void {
	let written = penCursorWritten.get(el);
	if (!written) {
		written = { style: {} };
		penCursorWritten.set(el, written);
	}
	if (modeClass !== undefined && written.modeClass !== modeClass) {
		for (const cls of MODE_CURSOR_CLASSES) if (cls !== modeClass) el.classList.remove(cls);
		if (modeClass) el.classList.add(modeClass);
		written.modeClass = modeClass;
	}
	let changed: Record<string, string> | null = null;
	for (const key in style) {
		const value = style[key]!;
		if (written.style[key] === value) continue;
		written.style[key] = value;
		(changed ??= {})[key] = value;
	}
	if (changed) el.setCssStyles(changed);
}

	function showPenCursor(this: InkOverlayPlugin, sample: PenSample, pointerType?: string): void {
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
		// `contains` is a read; an `add` of a class already there still writes.
		if (!this.view.scrollDOM.classList.contains(PEN_HOVER_CLASS)) this.view.scrollDOM.classList.add(PEN_HOVER_CLASS);
		const client = this.penCursorPinned ? this.router?.clientPointForSample(sample) : null;
		const position = client ? { ...sample, x: client.x, y: client.y } : sample;
		this.penCursorClient = client ? position : null;
		this.paintPenCursor(position, this.penCursorPinned ? 1 : this.cssScale,
			this.camera.zoom * (this.penCursorPinned ? this.cssScale : 1), sample);
	}

	/** Cursor-only writes: no input replay, watchdog extension or raster work. */
	function refreshPenCursor(this: InkOverlayPlugin): void {
		if (!this.penCursorClient || !this.penCursorEl || !this.penCursorShown) return;
		this.paintPenCursor(this.penCursorClient, 1, this.camera.zoom * this.cssScale, null);
	}

	function paintPenCursor(this: InkOverlayPlugin, sample: PenSample, cursorScale: number, cursorZoom: number, feedbackSample: PenSample | null): void {
		if (!this.penCursorEl) return;
		// Every branch below writes a visible opacity.
		this.penCursorShown = true;
		// In eraser mode the nib width is a lie: what the tip is about to do
		// is bounded by the eraser radius, so the reticle shows THAT. Radius
		// is screen-space (same physical size at any zoom), like the eraser
		// cursor that follows a live erase.
		if (tipMode() === "eraser") {
			const r = visualToNote(inlineEraserRadiusPx, cursorScale);
			writePenCursor(this.penCursorEl, ERASER_CURSOR_CLASS, {
				width: `${r * 2}px`,
				height: `${r * 2}px`,
				transform: `translate(${sample.x - r}px, ${sample.y - r}px)`,
				backgroundColor: "transparent",
				opacity: "1",
			});
			return;
		}
		// Lasso mode: the nib is about to select, and the reticle says so - a
		// dashed ring, fixed size, visually distinct from both nib and eraser.
		if (tipMode() === "lasso") {
			const r = visualToNote(9, cursorScale);
			writePenCursor(this.penCursorEl, LASSO_CURSOR_CLASS, {
				width: `${r * 2}px`,
				height: `${r * 2}px`,
				transform: `translate(${sample.x - r}px, ${sample.y - r}px)`,
				backgroundColor: "transparent",
				opacity: "1",
			});
			return;
		}
		// Aim stays under the pointer. The eligible seam and whole-group
		// exceptions live on the transient canvas, independently of this mark.
		if (tipMode() === "space") {
			const half = visualToNote(7, cursorScale);
			// The pan rule follows the space rule in styles.css at the same
			// specificity, so a pan class left from a pan hover wins: solid
			// border and ring shadow instead of the dashed seam.
			writePenCursor(this.penCursorEl, SPACE_CURSOR_CLASS, {
				width: `${half * 2}px`,
				height: "0px",
				transform: `translate(${sample.x - half}px, ${sample.y}px)`,
				backgroundColor: "transparent",
				opacity: "1",
			});
			if (feedbackSample) this.queueSpaceFeedback(this.camera.screenToWorld(feedbackSample.x,feedbackSample.y).y);
			return;
		}
		// Pan mode: a solid ring, the one reticle that is not dashed, so the
		// tip reads as "grab" rather than as any of the marking tools.
		if (tipMode() === "pan") {
			const r = visualToNote(11, cursorScale);
			writePenCursor(this.penCursorEl, PAN_CURSOR_CLASS, {
				width: `${r * 2}px`,
				height: `${r * 2}px`,
				transform: `translate(${sample.x - r}px, ${sample.y - r}px)`,
				backgroundColor: "transparent",
				opacity: "1",
			});
			return;
		}
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
		writePenCursor(this.penCursorEl, null, {
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
	function hidePenCursor(this: InkOverlayPlugin): void {
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
	function concealPenCursor(this: InkOverlayPlugin): void {
		if (!this.penCursorEl) return;
		this.penCursorShown = false;
		writePenCursor(this.penCursorEl, undefined, { opacity: "0" });
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
	 *
	 * Each hover sample stamps its time; the one pending timer, when it
	 * fires, re-arms for the rest of the second if a sample came since, and
	 * hides only once none has. A timer replaced per hover sample woke the
	 * main thread on every one of them.
	 */
	function armHoverWatchdog(this: InkOverlayPlugin): void {
		this.hoverSeenAt = performance.now();
		if (this.hoverWatchdog === null) startHoverWatchdog(this, HOVER_GHOST_MS);
	}

	function startHoverWatchdog(plugin: InkOverlayPlugin, ms: number): void {
		plugin.hoverWatchdog = plugin.winRef.setTimeout(() => {
			plugin.hoverWatchdog = null;
			const rest = plugin.hoverSeenAt + HOVER_GHOST_MS - performance.now();
			if (rest > 0) { startHoverWatchdog(plugin, rest); return; }
			plugin.hidePenCursor();
		}, ms);
	}

	function clearHoverWatchdog(this: InkOverlayPlugin): void {
		if (this.hoverWatchdog === null) return;
		this.winRef.clearTimeout(this.hoverWatchdog);
		this.hoverWatchdog = null;
	}

	function showEraserCursor(this: InkOverlayPlugin, sample: PenSample): void {
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

	function hideEraserCursor(this: InkOverlayPlugin): void {
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
	function showLassoCursor(this: InkOverlayPlugin, sample: PenSample): void {
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
	function hideLassoCursor(this: InkOverlayPlugin): void {
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
	function beginPanDragCursor(this: InkOverlayPlugin): void {
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
	function restoreReticleAfterPan(this: InkOverlayPlugin, ev?: PointerEvent): void {
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
	function showSpaceCursor(this: InkOverlayPlugin, sample: PenSample): void {
		this.showPenCursor(sample);
	}

	/** Put the insert-space reticle away with the gesture. See hideLassoCursor. */
	function hideSpaceCursor(this: InkOverlayPlugin): void {
		this.hidePenCursor();
	}

export function installCursors(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		showPenCursor,
		refreshPenCursor,
		paintPenCursor,
		hidePenCursor,
		concealPenCursor,
		armHoverWatchdog,
		clearHoverWatchdog,
		showEraserCursor,
		hideEraserCursor,
		showLassoCursor,
		hideLassoCursor,
		beginPanDragCursor,
		restoreReticleAfterPan,
		showSpaceCursor,
		hideSpaceCursor,
	});
}
