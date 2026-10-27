/**
 * The pdf surface's cursor methods: the hover reticle, the eraser ring, the lasso, space and pan cursors, the hide paths and the
 * painted-class sweep. They are methods of PdfInkController, installed on its prototype when PdfInkController.ts loads.
 */
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { markPenHardwareSeen, markPenSeen, pointerRaisesPenTools } from "../inline/PenToolsMode";
import { DEFAULT_PEN, HIGHLIGHTER_PEN } from "../ink/PenStyle";
import { getInkColorHex } from "../ink/InkColor";
import { getInkSizeMult, getInlineTool, penReticleEnabled } from "../inline/InkOverlay";
import { anyHandOnGlass, traceSurface } from "../inline/InlinePenRouter";
import { describeEl } from "../inline/PenHitProbe";
import { PenSample } from "../input/PointerRouter";
import { getEraserRadiusPx } from "../inline/InkOverlay";
import { penInkEnabled } from "../inline/PenInk";
import { penReticleShown } from "../inline/PenCursor";
import { tipMode } from "../inline/TipMode";
import { installMethods } from "../inline/InstallMethods";
import { pdfPenWidth, type ReticleOutcome, type PdfInkController } from "./PdfInkController";

declare module "./PdfInkController" {
	interface PdfInkController {
		showCursor(sample: PenSample, pointerType?: string): ReticleOutcome;
		hideCursor(): void;
		showEraserCursor(sample: PenSample): ReticleOutcome;
		hideEraserCursor(): void;
		showLassoCursor(sample: PenSample): void;
		hideLassoCursor(): void;
		beginPanDragCursor(scroller: HTMLElement): void;
		endPanDragCursor(): void;
		showSpaceCursor(sample: PenSample): void;
		hideSpaceCursor(): void;
	}
}

/**
 * The three fixed reticle sizes for modes that are not the eraser, in screen
 * px. Not scaled by the page's zoom - see `showCursor`'s eraser radius,
 * which is the same fixed-under-any-zoom reasoning - and not derived, on
 * purpose: these are the exact constants `InkOverlay.showPenCursor` uses for
 * `LASSO_CURSOR_CLASS`, `PAN_CURSOR_CLASS` and `SPACE_CURSOR_CLASS` (9, 11,
 * 24), reused rather than re-picked so the two surfaces show the same size
 * reticle for the same mode.
 */
const LASSO_CURSOR_RADIUS_PX = 9;
const PAN_CURSOR_RADIUS_PX = 11;
const SPACE_CURSOR_HALF_PX = 24;

/**
 * EVERY element currently wearing a cursor class, across every controller and
 * every window - the reference that makes a stuck class findable again.
 *
 * `showCursor` paints `handwriting-pdf-hover` on whatever `probe()` returned
 * AT THE TIME. pdf.js rebuilds its viewer routinely, so that element is often
 * not `boundScroller`, and it is only ever recorded in ONE field
 * (`cursorScroller`) that the next paint overwrites and the teardown nulls.
 * Whatever was painted and then lost went on wearing `cursor: none` - which
 * styles.css puts on the container AND EVERY DESCENDANT - with no reference
 * left anywhere that could take it off. In a popout window holding one PDF
 * leaf that viewer is most of the window, which is how it reads as "the whole
 * window has no cursor".
 *
 * A MODULE-LEVEL set and not a per-controller one, deliberately: a popout is a
 * second window with its own controller instance, and the instance that
 * hides is not always the instance that painted. Per-instance bookkeeping
 * cannot answer for an element another instance stranded, which is the case
 * `PdfCursorStrandAcrossWindows.test.ts` executes.
 *
 * This does NOT change how the class is applied - `showCursor` still paints
 * exactly what it painted before, on the same element, under the same gates.
 * It only makes the painting recoverable.
 *
 * It cannot grow without bound: every sweep clears it, and a sweep runs on
 * every hide and every teardown. An element that dies with its window is held
 * only until the next hide, which any pointer movement anywhere causes.
 */
const cursorPaintedEls = new Set<HTMLElement>();

/** Record that `el` has been given a cursor class, so a hide can find it. */
function noteCursorPainted(el: HTMLElement): void {
	cursorPaintedEls.add(el);
}

/**
 * Take BOTH cursor classes off every element that was given one, wherever it
 * lives. Removing a class an element does not carry is a no-op, so this costs
 * one call per painted element and changes nothing in the common case where
 * the only entry is the one the caller was about to clean anyway.
 */
function releasePaintedCursorEls(): void {
	for (const el of cursorPaintedEls) {
		el.classList.remove("handwriting-pdf-hover");
		el.classList.remove("handwriting-pdf-pan-drag");
	}
	cursorPaintedEls.clear();
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
	function showCursor(this: PdfInkController, sample: PenSample, pointerType?: string): ReticleOutcome {
		// Keyboard mode pauses fresh mouse claims but does not strand a mouse
		// stroke that was already claimed. Its wet loop calls this seam with an
		// explicit "mouse", while in-gesture wrappers omit the type; neither
		// may repaint the reticle after the keyboard command hid it.
		const mousePaused =
			!penInkEnabled() &&
			(pointerType === "mouse" || (pointerType === undefined && this.mouseStroke));
		if (mousePaused) return "off";
		// Both marks sit ahead of the reticle gate below - audit doc §5k/(d):
		// turning "Pen reticle" off, or Boox mode, which turns it off for you,
		// must not also stop the pointer being noticed.
		//
		// THE HARDWARE CLAIM, gated on a real pen. `nibIsLit` (MobileTools.ts)
		// reads `penHardwareSeen()` as of `cff850d`; that fix landed on the
		// note surface alone, and a user who only ever wrote on PDFs never set
		// the flag, so their pen and highlighter buttons stayed dark unless
		// mouse ink was on. Eighth time in this cycle a ruling reached one
		// surface and not the other, and it was inside the seventh's own fix.
		// An armed mouse never sets this: it is not a pen, and the light
		// answers it through `nibIsLit`'s own `|| h.mouseInkOn()`.
		if (pointerType === "pen") markPenHardwareSeen();
		// THE VISIBILITY CLAIM, and this is a REVERSAL of a ruling, not a bug
		// fix. This comment used to end: "a mouse in the room, reticle off,
		// raised the pen toolbar in auto mode for a pointer that was never a
		// pen (1.4.6-design.md 5m/AF5)" - so the mark was refused to every
		// mouse, and the note surface raised the strip for one while this
		// surface would not. AF5 SUPERSEDED BY ALAN, 2026-09-03, asked
		// directly and with that sentence quoted back to him: "with mouse ink
		// armed, yes a hovering mouse should bring toolbar out". The half of
		// AF5 that stands is the UNARMED mouse, which still raises nothing -
		// what it did not separate out was a mouse whose owner had turned
		// mouse ink on deliberately, and that mouse is asking for the tools.
		//
		// `pointerRaisesPenTools` (PenToolsMode.ts) is the shared predicate,
		// read by the note surface's showPenCursor as well, so the two cannot
		// drift apart again. The explicit call matters here beyond tidiness:
		// this method has a second caller that does NOT come through the
		// router's own gate - the wet-draw loop below calls
		// `showCursor(s, "mouse")` for an actively drawing mouse - so relying
		// on the router's guarantee would be relying on the wrong caller.
		else if (pointerRaisesPenTools(pointerType)) markPenSeen();
		// Audit doc §5f: the note surface's reticle obeys the "Pen reticle"
		// setting (InkOverlay.ts's own `penReticleOn`, gated at its
		// showPenCursor); this surface consulted nothing, so turning the
		// setting off - or Boox mode, whose description promises the reticle
		// off because "every redraw costs on e-ink" - left the dot repainting
		// under the pen on every PDF. Same flag, checked before any paint AND
		// before the watchdog timer below is armed: an invisible dot that
		// still costs a timer per move defeats the e-ink point as much as a
		// visible one would.
		if (!penReticleEnabled()) return "off";
		// A PAN DRAG PAINTS NO RETICLE (1.4.12-design §11). The
		// rule and its reasoning are the note surface's own pure function,
		// `penReticleShown` (PenCursor.ts), called rather than copied: this
		// surface's whole recurring defect is a ruling that reached one ink
		// surface and not the other, and a second implementation of a
		// predicate is the shape that keeps causing it.
		//
		// A GATE AND NOT JUST A DELETED CALL SITE. The two calls that painted
		// the ring - one at pen-down, one per raw batch - are gone from
		// `penDown` and `penRaw`, but `refreshStrip`, the hover path and any
		// future caller all reach this method, and a pan holds the pointer for
		// as long as the button is down. This refuses them.
		//
		// It REFUSES rather than hides, and that distinction is the whole of
		// what `beginPanDragCursor` set up: hiding here would run `hideCursor`
		// and take the grabbing hand off with the ring, leaving the surface
		// with no pointer at all mid-drag - the exact defect the note's
		// PAN_DRAG_CLASS exists to prevent.
		if (!penReticleShown(tipMode(), this.panLast !== null)) return "pan-drag";
		// IS THE POINTER IN HAND A MOUSE? Two of the decisions below turn on
		// that and not on which caller asked, and the callers do not all say.
		//
		// The in-stroke wrappers - showEraserCursor, showLassoCursor,
		// showSpaceCursor - pass NO pointerType, deliberately and
		// permanently: the marks above are claims about a pen approaching
		// or landing, not about every sample of a gesture already in flight.
		// So a MOUSE erasing, lassoing or panning arrived here looking
		// exactly like a pen, inherited the watchdog it is meant to be exempt
		// from, and had its ring taken away by any stall over a second while
		// the button was held (alan, hardware, 2026-09-04, mouse ink armed).
		// There were FOUR of them; the pan's is gone, and its gesture now
		// reaches the reticle exactly twice, at each end of the drag.
		// `mouseStroke` is what penDown already wrote down about the pointer
		// that is drawing, so it answers for the callers that cannot.
		//
		// AND ONLY FOR THOSE CALLERS. `mouseStroke` is written at pen-down
		// and never cleared at pen-up - only unmount and a document change
		// reset it - so `pointerType === "mouse" || this.mouseStroke` would
		// hand the next PEN hover after any mouse stroke the mouse's
		// exemption, deleting the pen's only guard against a reticle stranded
		// by a pointerleave that never came. An explicit "pen" says pen and
		// is believed; the field only speaks where nothing else does.
		const mousePointer =
			pointerType === "mouse" || (pointerType === undefined && this.mouseStroke);
		// A HAND IS ON THE GLASS: THE MOUSE PAINTS NOTHING. The ruling,
		// alan, 1.4.12: "hide the mouse reticle when a finger or pen is
		// active". With mouse ink armed a parked mouse is still HOVERING,
		// so without this its ring sits wherever the pointer was last left
		// the whole time a finger flings the page or the pen writes.
		//
		// `InlinePenRouter.handOnGlass()` is the question, reused rather
		// than a second notion of "a hand is on the glass" - it is derived,
		// not stored, off state the router already keeps and already
		// recovers (guardTouches/swallowedTouches, activePenId +
		// activeIsPen, penHoverAt). Byte-for-byte the note surface's own
		// gate (InkOverlay.ts's `showPenCursor`), which reached this
		// ruling first (1.4.12) through the same router - this surface
		// shares it (`this.router = new InlinePenRouter(...)` above)
		// rather than a second router, so nothing here needed a second
		// mechanism, only this read.
		//
		// ONE BOOLEAN READ, on a path that already runs: the router has
		// already recorded every term `handOnGlass` inspects by the time
		// any hover reaches this method, so this adds no new listener and
		// no new layout read.
		//
		// `router` is null before `bindTo` and in this file's own unit
		// rigs that construct the controller without mounting one - both
		// read as "nothing is on the glass", which is what a mouse hover
		// behaved as before this rule existed.
		// EVERY OPEN SURFACE, not just this one (1.4.13) - byte-for-byte the
		// note surface's change and its reasoning (InkOverlay.ts): a hand on a
		// note pane's glass must take this pdf's parked mouse ring down too,
		// and `anyHandOnGlass` (InlinePenRouter.ts) is the same derived answer
		// ORed over every live router. Still under `mousePointer`, so the pen
		// and touch paths pay nothing.
		if (mousePointer && anyHandOnGlass()) return "hand-on-glass";
		const probed = this.probe();
		if (!probed) return "no-probe";
		if (probed.scaleFactor === null) return "no-scale";
		this.ensureTools();
		// Re-created whenever its owned viewport is not in the CURRENT scroller. It lives in
		// that scroller's subtree, so a viewer rebuild took it away and left
		// this field holding a detached div - and because the old test was
		// "is the field null", the reticle then never came back in that pane
		// for the rest of the session. pdf.js rebuilds its viewer often
		// enough that this is an ordinary Tuesday, not an edge case.
		if (
			this.cursorEl?.parentElement?.parentElement !== probed.scroller ||
			!this.cursorEl.parentElement.classList.contains("handwriting-pdf-cursor-viewport")
		) {
			// Trace-only, and only on this rebuild transition, not per move -
			// this is the "ordinary Tuesday" path the comment above names,
			// and a palm/pinch investigation needs to see it happen without
			// wading through a hover line for every sample.
			if (diagnosticsEnabled()) {
				traceSurface(
					"pdf-hover",
					null,
					`reticle rebuilt: old parent ${describeEl(this.cursorEl?.parentElement ?? null)} -> new scroller ${describeEl(probed.scroller)}`
				);
			}
			const oldViewport = this.cursorEl?.parentElement;
			if (oldViewport?.classList.contains("handwriting-pdf-cursor-viewport")) oldViewport.remove();
			else this.cursorEl?.remove();
			if (this.win.getComputedStyle(probed.scroller).position === "static") {
				probed.scroller.setCssStyles({ position: "relative" });
			}
			const viewport = probed.scroller.createDiv({ cls: "handwriting-pdf-cursor-viewport" });
			viewport.setCssStyles({ position: "absolute", overflow: "hidden", pointerEvents: "none", zIndex: "100" });
			this.cursorEl = viewport.createDiv({ cls: "handwriting-pdf-cursor" });
			this.cursorEl.setAttribute("aria-hidden", "true");
			// One disposer for the life of the controller, not one per
			// rebuild: it cleans up whatever the current element and scroller
			// are, so re-creating cannot pile up closures over dead ones.
			if (!this.cursorDisposed) {
				this.cursorDisposed = true;
				this.disposers.push(() => {
					const viewport = this.cursorEl?.parentElement;
					if (viewport?.classList.contains("handwriting-pdf-cursor-viewport")) viewport.remove();
					else this.cursorEl?.remove();
					this.cursorEl = null;
					this.boundScroller?.classList.remove("handwriting-pdf-hover");
					this.boundScroller?.classList.remove("handwriting-pdf-pan-drag");
					// BEFORE the field is nulled, and reaching wider than it:
					// this disposer used to clean `boundScroller` and then drop
					// the only reference to whatever else had been painted. A
					// pane torn down after a viewer rebuild - which is what a
					// move to a popout window does - left that element wearing
					// `cursor: none` with nothing able to find it again.
					releasePaintedCursorEls();
					this.cursorScroller = null;
				});
			}
		}
		// Trace-only, and only on THIS transition: the first hover after a
		// pen-up or a hide, not every move - a move-by-move line is exactly
		// the flood item 4 of the brief forbids.
		if (diagnosticsEnabled() && this.cursorTraceHidden) {
			traceSurface("pdf-hover", null, "reticle resumed: first hover after hide/pen-up");
		}
		this.cursorTraceHidden = false;
		// Clip paint at the scrollport without moving the actual pointer center.
		// The wrapper contributes no overflow beyond the existing visible area.
		this.cursorEl.parentElement!.setCssStyles({
			display: "block",
			left: `${probed.scroller.scrollLeft}px`,
			top: `${probed.scroller.scrollTop}px`,
			width: `${probed.scroller.clientWidth}px`,
			height: `${probed.scroller.clientHeight}px`,
		});
		const cx = sample.x;
		const cy = sample.y;
		const mode = this.erasing ? "eraser" : tipMode();
		// The nib dot is the SIZE OF THE INK it will lay down, not a fixed
		// blob: page units are css px at scale 1, so the nib's on-screen width
		// is its width times the scale. A dot that is the same size whatever
		// the pen is set to tells you nothing about what you are about to draw.
		//
		// Times the LIVE scale, and the stroke is rendered times that same live
		// scale, which is the only reason the dot can promise the line. Times
		// the reference instead and the dot would be honest at exactly one
		// zoom and a lie at every other.
		const tool = getInlineTool();
		const nib =
			(pdfPenWidth(
				tool === "highlighter" ? HIGHLIGHTER_PEN.baseWidth : DEFAULT_PEN.baseWidth,
				getInkSizeMult(tool)
			) *
				probed.scaleFactor) /
			2;
		// Every mode class is cleared before the branches below pick one:
		// `classList.toggle(x, false)` on a class the PREVIOUS call left off is
		// a silent no-op, so a stale mode class would otherwise ride into the
		// next paint. The note surface's `showPenCursor` avoids the same trap
		// by removing every other mode's class in each branch before adding
		// its own; clearing all three here once does the same job in one
		// place. Lasso has no class of its own - it shares `-ring` with the
		// eraser, told apart by size - so there are three, not four.
		this.cursorEl.classList.remove(
			"handwriting-pdf-cursor-ring",
			"handwriting-pdf-cursor-pan",
			"handwriting-pdf-cursor-space"
		);
		// A pen's hand covers the dot, so the dot alone is enough. A mouse
		// HAS no hand: at small nib sizes the ink-true dot is a four-pixel
		// speck and it is the only pointer on screen, so it gets a locator
		// ring of fixed size - obviously not the ink width, because it never
		// changes when the ink width does.
		//
		// FOLLOWS THE GESTURE TOO, decided with the watchdog above and for
		// the same reason: nothing about "a mouse has no hand" stops being
		// true once the button goes down. On `pointerType === "mouse"` alone
		// the in-stroke refresh - which passes none - toggled the ring OFF at
		// the first erase/lasso/pan sample, so the mouse lost the mark it was
		// steering by exactly while it was steering, and lost it in only two
		// of the three cases: the wet-draw loop passes "mouse" explicitly, so
		// a mouse DRAWING kept its ring while the same mouse ERASING did not.
		// One rule for both, and the pen is untouched either way -
		// `mouseStroke` is false for the whole of every pen gesture.
		this.cursorEl.classList.toggle("handwriting-pdf-cursor-mouse", mousePointer);
		// Dimmed while there is no id: the pen is about to refuse, and the
		// reticle is the only thing on screen that can say so.
		this.cursorEl.classList.toggle("handwriting-pdf-cursor-waiting", !this.documentId());
		// Insert-space: the reticle IS the divider, in miniature - a short
		// dashed rule lying where the seam would be planted, rather than a dot
		// that would say "pen" for a tip about to move rows instead. Same
		// visual as the note surface's SPACE_CURSOR_CLASS (InkOverlay
		// showPenCursor); it is a rule, not a ring, so it gets its own branch
		// instead of a radius.
		if (mode === "space") {
			this.cursorEl.classList.add("handwriting-pdf-cursor-space");
			const transform = `translate(${cx - SPACE_CURSOR_HALF_PX}px, ${cy}px)`;
			this.cursorEl.setCssStyles({
				display: "block",
				width: `${SPACE_CURSOR_HALF_PX * 2}px`,
				height: "0px",
				transform,
				backgroundColor: "transparent",
			});
			this.lastCursorTransform = transform;
		} else {
			const r =
				mode === "eraser"
					? getEraserRadiusPx()
					: mode === "lasso"
						? LASSO_CURSOR_RADIUS_PX
						: mode === "pan"
							? PAN_CURSOR_RADIUS_PX
							: Math.max(1.5, nib);
			// Eraser and lasso both read as "reach" and are dashed to say
			// "removes / selects" at a glance - the note surface's own
			// reasoning for ERASER_CURSOR_CLASS and LASSO_CURSOR_CLASS. Told
			// apart by SIZE: the eraser's radius is the user's erase-radius
			// setting, the lasso's is the fixed constant above.
			this.cursorEl.classList.toggle("handwriting-pdf-cursor-ring", mode === "eraser" || mode === "lasso");
			// Pan is the one SOLID ring: "grab the page" must never read as
			// one of the dashed marking tools, matching the note surface's own
			// rule for PAN_CURSOR_CLASS.
			this.cursorEl.classList.toggle("handwriting-pdf-cursor-pan", mode === "pan");
			const transform = `translate(${cx - r}px, ${cy - r}px)`;
			this.cursorEl.setCssStyles({
				display: "block",
				width: `${r * 2}px`,
				height: `${r * 2}px`,
				transform,
				backgroundColor: mode === "nib" ? getInkColorHex(tool) : "transparent",
			});
			this.lastCursorTransform = transform;
		}
		// The system cursor is drawn too, and two dots near each other read as
		// one being wrong. The note surface hides it the same way while a pen
		// is near; the class comes off when the pen leaves, not at contact.
		probed.scroller.classList.add("handwriting-pdf-hover");
		// WHICH element got it, so the hide path can take it off without a
		// probe of its own. See `cursorScroller`.
		this.cursorScroller = probed.scroller;
		// AND in the module-level set, which is what survives this field being
		// overwritten by the next paint or nulled by the teardown. See
		// `cursorPaintedEls`.
		noteCursorPainted(probed.scroller);
		// A pen that leaves hover range without sending pointerleave would
		// otherwise strand the reticle on screen; see the note surface, which
		// learned this the same way.
		//
		// A MOUSE cannot leave hover range - it is either over the pane or it
		// has sent pointerleave - so the watchdog has nothing to protect
		// against there, and firing it just took the pointer away from anyone
		// who paused for a second before drawing. That is as true of a mouse
		// mid-gesture as it is of one hovering, which is why this reads
		// `mousePointer` (see its definition above) rather than the argument.
		if (this.cursorTimer !== null) this.win.clearTimeout(this.cursorTimer);
		this.cursorTimer = mousePointer ? null : this.win.setTimeout(() => this.hideCursor(), 1000);
		return "wrote";
	}

	/**
	 * Not private: `hidePenCursorsEverywhere` (InkOverlay.ts) calls it on
	 * every open controller when mouse ink goes off, through the
	 * `addStripSurface` registration in main.ts - the same access
	 * `refreshStrip` and `dissolveSelection` already have for their own
	 * fan-outs on that registration.
	 */
	function hideCursor(this: PdfInkController): void {
		if (this.cursorTimer !== null) {
			this.win.clearTimeout(this.cursorTimer);
			this.cursorTimer = null;
		}
		this.cursorEl?.setCssStyles({ display: "none" });
		const viewport = this.cursorEl?.parentElement;
		if (viewport?.classList.contains("handwriting-pdf-cursor-viewport")) {
			viewport.setCssStyles({ display: "none" });
		}
		// NO `probe()` HERE, and that is the point of this method's shape.
		// The ResizeObserver callback calls `invalidateProbe()` and then this,
		// so a `probe()` on this path could never be served from cache: every
		// delivery ran `probeViewer` in full, synchronously, even with no
		// cursor on screen. The elements carrying the classes are known
		// without asking the layout for them - see `cursorScroller`.
		this.cursorScroller?.classList.remove("handwriting-pdf-hover");
		// AND the scroller the class was actually put on. `showCursor` adds it
		// to whatever the probe returned at the time; this used to take it off
		// whatever the probe returns now, and those are not the same element
		// after pdf.js rebuilds its viewer - "an ordinary Tuesday", in that
		// method's own words - nor is there one at all when the probe has gone
		// null. Either way the class stayed, and its rule is `cursor: none` on
		// the container and every descendant (styles.css), so the pointer was
		// invisible over the whole viewer with nothing on screen to explain
		// it. The disposer has always cleaned up from `boundScroller` for this
		// exact reason; the hide path now does the same. Removing a class an
		// element does not carry is a no-op, so the common case where the two
		// agree costs one call and changes nothing.
		this.boundScroller?.classList.remove("handwriting-pdf-hover");
		// The pan drag's grabbing hand comes off wherever the reticle does,
		// and that is not tidiness: this is the ONE place every abandon path
		// already passes through. `resetGestureState` (a file switch, a
		// viewer rebuild), `onPenLeave`, the disposer and
		// `hidePenCursorsEverywhere` all reach it, and a pan torn down by any
		// of them would otherwise leave the viewer wearing `cursor: grabbing`
		// with no gesture behind it for the rest of the session. Both
		// elements again, for the reason the two lines above give: the probe
		// and the bound scroller are not the same element after pdf.js
		// rebuilds its viewer, and the class was added to whichever one
		// pen-down held.
		this.cursorScroller?.classList.remove("handwriting-pdf-pan-drag");
		this.boundScroller?.classList.remove("handwriting-pdf-pan-drag");
		// AND every element anyone painted, which is the only line here that
		// can reach one this instance never recorded - a viewer rebuilt under
		// a previous paint, or a pane that now lives in another window with
		// its own controller. The two pairs above stay because they are this
		// method's documented contract and cost nothing when they agree; this
		// is what makes the set of them complete. See `cursorPaintedEls`.
		releasePaintedCursorEls();
		// One boolean write, always: arms the next showCursor's `pdf-hover`
		// "resumed" transition line. See `cursorTraceHidden`.
		this.cursorTraceHidden = true;
	}

	/**
	 * The eraser's ring, during an erase stroke.
	 *
	 * Thin on purpose: `showCursor` already reads `tipMode()` and sizes itself
	 * to `getEraserRadiusPx()` when that is "eraser", so there is no second
	 * implementation here and no second radius to drift. What this buys is a
	 * NAME. The erase branches say what they are doing instead of making a
	 * generic hover call, and - the reason it is a method rather than a
	 * comment - the surface registry gets one spelling that means "this
	 * surface drives its eraser reticle" on BOTH surfaces.
	 *
	 * A registry marker of `showCursor(` would have been vacuous: that call is
	 * in this file for hover whether or not the erase path ever touches the
	 * reticle, so the row would have passed green across the entire life of
	 * the defect it exists to catch. `showEraserCursor(` is only here because
	 * the erase path drives the ring, and deleting that makes the row fail.
	 */
	function showEraserCursor(this: PdfInkController, sample: PenSample): ReticleOutcome {
		// REUSE the reticle, never build one mid-stroke. The note surface can
		// style unconditionally because its `eraserEl` is created once at
		// mount and lives as long as the overlay; this surface's `cursorEl` is
		// created lazily inside `showCursor` and thrown away whenever pdf.js
		// rebuilds its viewer, which that method's own comment calls "an
		// ordinary Tuesday". Letting an erase sample be the thing that first
		// builds it would put element creation on the erase path.
		//
		// THE LIMIT THIS ACCEPTS, stated rather than found later: an erase
		// that never hovered first draws no ring for that gesture, and the
		// next hover restores it. A digitizer sees a pen approaching, so hover
		// has effectively always happened by the time a nib touches - the case
		// that loses the ring is a finger in eraser mode, which never had one.
		//
		// Returns the outcome rather than void, same seam as `showCursor`
		// itself: the pdf-raw trace of an erase batch reports THIS reason
		// ("no-cursor-el") when it is the one that fired, not showCursor's.
		if (!this.cursorEl) return "no-cursor-el";
		return this.showCursor(sample);
	}

	/** Put the eraser's ring away. The note surface's name for the same act. */
	function hideEraserCursor(this: PdfInkController): void {
		this.hideCursor();
	}

	/**
	 * The lasso's reticle, during a lasso gesture - including the "grab an
	 * existing selection and drag it" branch, which reaches the tip through
	 * `lassoDown` exactly like a fresh loop does. Same shape and same reason
	 * as `showEraserCursor`: named rather than a raw `showCursor` call so the
	 * surface registry has something to look for, and thin because
	 * `showCursor` already reads `tipMode() === "lasso"` and picks the fixed
	 * radius itself.
	 */
	function showLassoCursor(this: PdfInkController, sample: PenSample): void {
		// Same reuse-only rule as the eraser: never build the reticle mid-
		// gesture. See showEraserCursor's comment for why.
		if (!this.cursorEl) return;
		this.showCursor(sample);
	}

	/** Put the lasso's reticle away. */
	function hideLassoCursor(this: PdfInkController): void {
		this.hideCursor();
	}

	/**
	 * Enter the pan drag's cursor state: no reticle, and the grabbing hand
	 * over the viewer until the drag ends.
	 *
	 * THERE IS NO `showPanCursor` BESIDE `showLassoCursor` AND
	 * `showSpaceCursor` ANY MORE, and its absence is the point (see
	 * 1.4.12-design §11; the note surface made the same swap first, and this
	 * method is deliberately its twin down to the name). Those two exist
	 * because a lasso and a space gesture want the ring KEPT ALIVE through a
	 * drag that produces no hover samples. A pan wants the opposite: the ring
	 * says "marking" for the one tip that is not marking, and what a hand
	 * holding a page should look like is a hand.
	 *
	 * WHAT IT COST, stated exactly, because the finding that opened this
	 * reads "per sample" and the code said something slightly different.
	 * (1.4.12-design §11): "the pdf pan still paints the ring per sample via
	 * `showPanCursor`". `penRaw`'s pan branch called it once per BATCH, on
	 * the batch's last sample - so per sample for a mouse, which delivers
	 * one, and once per four for a Surface pen delivering coalesced batches.
	 * Per MOVE either way, which is the rate that matters, and each of those
	 * moves paid a `toContent` (two scroll reads), a `setCssStyles`, six
	 * `classList` calls, and a `clearTimeout` - plus, under a pen, the
	 * `setTimeout` that re-armed the watchdog. A mouse is exempt from the
	 * timer (a7eba85) and was panning anyway, so for the hardware that
	 * reported this it was the two reads and the style write.
	 *
	 * ONCE PER DRAG, both ways. Nothing in `penRaw`'s pan branch touches the
	 * cursor now, so a move costs the two scroll writes and nothing else.
	 *
	 * `hideCursor` FIRST, then the class - the same ordering the note's
	 * `beginPanDragCursor` needs and for the same reason. It clears the hover
	 * watchdog that would otherwise fire mid-drag, takes
	 * `handwriting-pdf-hover`'s `cursor: none` off, AND removes the pan-drag
	 * class, so the add below cannot be undone by the line above it and the
	 * viewer is left wearing exactly one cursor rule.
	 *
	 * Takes the scroller rather than probing for one: `penDown` has the
	 * probed element in hand, and probing again to reach the same element is
	 * the kind of layout read this slice exists to remove.
	 */
	function beginPanDragCursor(this: PdfInkController, scroller: HTMLElement): void {
		this.hideCursor();
		scroller.classList.add("handwriting-pdf-pan-drag");
		// Recorded for the same reason `showCursor` records it: this is a
		// cursor class too, and `hideCursor` now takes both off the recorded
		// owner rather than off a fresh probe. `hideCursor` ran one line above,
		// so the field would otherwise still name the element the HOVER class
		// was last on, and a pen-down that lands after a viewer rebuild would
		// leave the grabbing hand on with no gesture behind it.
		this.cursorScroller = scroller;
		// And in the module-level set for the same reason the hover paint is:
		// `hideCursor` ran one line above and CLEARED that set, so without
		// this the grabbing hand would be the one class nothing could find.
		noteCursorPainted(scroller);
	}

	/**
	 * Leave it: the hand comes off and the reticle stays down until the next
	 * hover paints it.
	 *
	 * Thin, because `hideCursor` is where the class removal lives - see its
	 * comment for why that is the one place every abandon path already passes
	 * through. The name is here so the pan branch says what it is doing and
	 * so the surface registry has a call site to look for.
	 *
	 * NO RESTORE UNDER THE LIFT, unlike the note's `restoreReticleAfterPan`,
	 * and that is a difference in the surfaces rather than an omission. The
	 * note has to re-measure a rect its pan scrolled out from under, and
	 * having paid for that it may as well repaint; this surface's samples are
	 * viewport-relative and scroll-independent (`penRaw`'s own comment), so
	 * there is nothing stale to fix and the next hover is enough - which is
	 * exactly what the eraser, the lasso and the space gesture already do
	 * here at pen-up.
	 */
	function endPanDragCursor(this: PdfInkController): void {
		this.hideCursor();
	}

	/** The insert-space divider reticle, during a space gesture. See showLassoCursor. */
	function showSpaceCursor(this: PdfInkController, sample: PenSample): void {
		if (!this.cursorEl) return;
		this.showCursor(sample);
	}

	/** Put the insert-space reticle away. */
	function hideSpaceCursor(this: PdfInkController): void {
		this.hideCursor();
	}

export function installPdfCursors(proto: PdfInkController): void {
	installMethods(proto, {
		showCursor,
		hideCursor,
		showEraserCursor,
		hideEraserCursor,
		showLassoCursor,
		hideLassoCursor,
		beginPanDragCursor,
		endPanDragCursor,
		showSpaceCursor,
		hideSpaceCursor,
	});
}
