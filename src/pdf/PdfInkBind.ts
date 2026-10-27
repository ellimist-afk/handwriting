/**
 * Binding and lifecycle of the PDF ink controller, moved from PdfInkController.ts. Each is a method of PdfInkController, installed on its prototype when PdfInkController.ts loads.
 * Bodies moved unchanged.
 */
import { emptyPageNoticeText, inkChangeRearmsNotice } from "../inline/EmptyPageNotice";
import { isAppleTouchPlatform, palmRadiusTrustworthy } from "../input/PalmShield";
import { InlinePenRouter } from "../inline/InlinePenRouter";
import { penInkEnabled } from "../inline/PenInk";
import { armStripPenFocus, stripPenFocus, stripPenUp } from "../inline/StripPenChrome";
import { installMethods } from "../inline/InstallMethods";
import type { PdfInkController } from "./PdfInkController";

declare module "./PdfInkController" {
	interface PdfInkController {
		emptyPageNoticeKey(pageNumber: number): string | null;
		sayIfPageEmpty(pageNumber: number, kind: "erase" | "select"): void;
		peelEscapeSelection(ev: KeyboardEvent): boolean;
		textSelectionLive(): boolean;
		releaseFocusBinding(): void;
		bindTo(scroller: HTMLElement): void;
		endLiveStroke(preserveMouse?: boolean): void;
		strokeAbandoned(): void;
		clearWetTrail(page: number): void;
		resetGestureState(): void;
		refresh(): void;
	}
}


	/**
	 * PAGE-scoped, not document-scoped: a pdf page with no ink of its own can
	 * never be touched by an erase or lasso gesture even while other pages
	 * carry ink, so the same episode-key module the note surface uses
	 * (EmptyPageNotice.ts, which keys purely on an opaque path string) gets a
	 * composite key here instead of a second gate class or a module change.
	 *
	 * `null` when the document is not identified yet, exactly like the note
	 * surface's own `path` - the gate's `claim` already refuses to speak OR
	 * record for a null path (`EmptyPageNotice.ts`: "there is no key that
	 * would later be forgotten"), and an unidentified PDF must keep that
	 * contract rather than fall back to a key every unidentified document
	 * would share (`"#3"`, `documentId() ?? ""`) - which would speak once for
	 * the FIRST unidentified document to touch page 3 and then wrongly stay
	 * silent for every other one, since they all reduce to the same key.
	 * (In practice `penDown`'s own `!this.documentId()` guard, above every
	 * call site below, already returns before this runs; kept anyway so the
	 * method's own contract does not depend on staying downstream of that
	 * guard forever.)
	 */
	function emptyPageNoticeKey(this: PdfInkController, pageNumber: number): string | null {
		const id = this.documentId();
		return id === null ? null : `${id}#${pageNumber}`;
	}

	/**
	 * Say `kind`'s empty-page sentence once per page, and forget it the
	 * moment that page gains ink again; ruled 2026-09-14.
	 *
	 * This is a BELT, not the only re-arm: `refresh()` (the ink-changed-
	 * underneath-us path) already forgets a page the
	 * instant its ink arrives, even between gestures, which is what makes
	 * the two surfaces match the note surface's rule EXACTLY (note:
	 * an earlier version of this comment claimed that on its own, which was
	 * false - a page that gained ink and lost it again between gestures,
	 * with `refresh()` never called, would have stayed silently un-armed).
	 * Kept here too so a gesture that starts on a page `refresh()` never saw
	 * (no store subscription fired) still self-corrects at the one moment
	 * this method looks anyway. Emptying a page during THIS call never
	 * re-arms it either way (`inkChangeRearmsNotice` is true only for "ink").
	 */
	function sayIfPageEmpty(this: PdfInkController, pageNumber: number, kind: "erase" | "select"): void {
		const key = this.emptyPageNoticeKey(pageNumber);
		const presence = !this.inkReady() ? "unknown" : this.strokes(pageNumber).length > 0 ? "ink" : "none";
		if (key !== null && inkChangeRearmsNotice(presence)) { this.emptyPageNotice.forget(key); this.claimedPages.delete(pageNumber); }
		const text = emptyPageNoticeText(presence, kind);
		if (text && this.emptyPageNotice.claim(key, kind)) { this.notify(text); this.claimedPages.add(pageNumber); }
	}

	/** Release a selection before a tool layer, including the window's focus fallback. */
	function peelEscapeSelection(this: PdfInkController, ev: KeyboardEvent): boolean {
		if (ev.key !== "Escape" || ev.defaultPrevented || this.selected.length === 0) return false;
		this.clearSelection();
		this.refreshStrip();
		ev.preventDefault();
		return true;
	}

	/**
	 * Is there a live (non-collapsed) text selection somewhere inside this
	 * pane right now - pdf.js's own text layer, most likely, since that is
	 * the only selectable text a PDF view holds?
	 *
	 * The note surface's equivalent guard is `this.view.state.selection.main.empty`
	 * - CodeMirror's own model of THAT editor's selection. A PDF pane has no
	 * CodeMirror; the reader selects text through the browser's native DOM
	 * Selection API instead, which is why this asks `this.win.getSelection()`
	 * rather than reading any state of ours. Scoped to `this.root` - the same
	 * containerEl `probeViewer` walks, so it holds the whole pane including
	 * the text layer - not the whole window: a selection left over in some
	 * other pane must not block a Ctrl+C meant for this one's lasso, the same
	 * way it would not on the note surface, where the check is per-editor.
	 * `this.win`, not the bare global, for the same popout-window reason
	 * every other DOM read in this file goes through it.
	 */
	function textSelectionLive(this: PdfInkController): boolean {
		const sel = this.win.getSelection?.();
		return !!sel && !sel.isCollapsed && this.root.contains(sel.anchorNode);
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
	function releaseFocusBinding(this: PdfInkController): void {
		const binding = this.focusBinding;
		this.focusBinding = null;
		if (!binding) return;
		const { scroller, priorFocus } = binding;
		const ownsFocus = scroller.ownerDocument?.activeElement === scroller;
		if (binding.addedTabindex && scroller.getAttribute?.("tabindex") === "-1") scroller.removeAttribute?.("tabindex");
		if (ownsFocus && priorFocus?.isConnected && priorFocus.ownerDocument === scroller.ownerDocument) {
			stripPenFocus(priorFocus);
		}
	}

	function bindTo(this: PdfInkController, scroller: HTMLElement): void {
		if (this.focusBinding?.scroller !== scroller) {
			this.releaseFocusBinding();
			const hadTabindex = scroller.hasAttribute?.("tabindex") ?? true;
			armStripPenFocus(scroller);
			this.focusBinding = {
				scroller,
				addedTabindex: !hadTabindex && scroller.getAttribute?.("tabindex") === "-1",
				priorFocus: null,
			};
		}
		this.router?.dispose();
		this.ro?.disconnect();
		this.boundScroller?.removeEventListener("scroll", this.onScroll);
		this.boundScroller = scroller;
		// A scroll listener, which this surface deliberately did not have.
		//
		// The note at the mutation observer says a scroll listener "would fire
		// far more often and tell us less: page geometry does not move with
		// scroll", and that is still true of GEOMETRY. It is no longer true of
		// COVERAGE: the canvases cover a band around the viewport now, so
		// where the viewport is is the one thing scroll - and only scroll -
		// changes. The cost objection is answered by the listener's own body:
		// passive, and a comparison against the current band before anything
		// else happens.
		this.band = null;
		// A different element is a different size; the cached one belongs to
		// the scroller that just went.
		this.scrollerSize = null;
		scroller.addEventListener("scroll", this.onScroll, { passive: true });
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
		//
		// TWO DIFFERENT CACHES, BOTH STALE ON A RESIZE, NEITHER COVERED BY THE
		// OTHER. `invalidateProbe` only clears THIS controller's view of the
		// scroller (page boxes, scale) - it says nothing to `this.router`,
		// which keeps its own `this.rect` (an `InlinePenRouter` field, refreshed
		// only on that router's own pointerdown) for turning a raw
		// `e.clientX/Y` into a sample. This fires on RESIZE: a split opening or
		// closing beside this pane changes ITS WIDTH, which is what the
		// observer below actually sees. A ResizeObserver sees size, not
		// position (the note surface's own lesson, `InkOverlay.ts:1143`), so a
		// pane move at CONSTANT size is NOT covered by this fix - nobody has a
		// repro for that shape; it is owed work, not fixed here. Within what
		// IS covered: the router's own `rect` goes stale, and nothing refreshes
		// it without a pointerdown - which leaves the router mapping every
		// HOVER against the OLD origin: the reticle painted far outside its own
		// pane.
		// The working explanation for the vanished ARROW, not yet confirmed on
		// device: the same paint adds `handwriting-pdf-hover` (below, in
		// `showCursor`), whose `cursor: none` on the whole viewer would hide
		// the native pointer too. The one probe taken during the symptom found
		// that class absent on both viewers; the device re-pass has to settle
		// it. `refreshRect()` exists
		// precisely for a host to call when geometry changes; this is that
		// call, ported from the note surface. What that surface actually does,
		// measured rather than remembered: `refreshRect()` is the host-callable
		// hook, and `InkOverlay.ts` calls it from six places - `mount` (:1658),
		// `handleResize` (:2420, :2471), `penDown` (:2891),
		// `restoreReticleAfterPan` (:4574) and `syncBand` (:5564). TWO of those
		// six ARE inside a ResizeObserver: `handleResize` is that surface's
		// observer callback (`new ResizeObserver(() => this.handleResize())`,
		// :1593). So the precedent this line cites is real for those two and
		// not for the other four. Do NOT delete this as redundant with
		// `invalidateProbe()` above - they cache different things, one this
		// controller's and one the router's, and only the router's feeds
		// `e.clientX - this.rect.left`.
		this.ro = new ResizeObserver(() => {
			this.invalidateProbe();
			this.router?.refreshRect();
			// A reticle already painted at a pre-resize content position is
			// stranded there until the next hover repaints it; hiding it now
			// also takes `handwriting-pdf-hover` off the scroller immediately.
			// Whether that is what restores the native arrow is the working
			// explanation recorded above and NOT a settled fact - the one probe
			// taken during the symptom found the class absent on both viewers,
			// and the device re-pass has to settle it.
			this.hideCursor();
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
				// Was `() => {}` from this surface's first commit (`579b678`,
				// "the pen writes on pdfs") with no comment and an empty commit
				// body - an oversight, not a decision. This surface instruments
				// everything else on the same StrokeMetrics: raw, accepted,
				// draw, present, prediction tails, frames. It then PRINTS the
				// result in debugSummary, and summaryText's first line is
				// `move ${moveHz}Hz`, so a PDF report has always read `move 0Hz`
				// while a note's reads a real rate. That is the exact failure
				// StrokeMetrics' own header was hardened against - "a stat with
				// no samples did not measure zero, nothing measured it", written
				// after `frame 0/0ms` sent a flicker hunt astray on Alan's
				// hardware - and moveHz is a bare number rather than a Stat, so
				// it cannot say "(not recorded)". It can only lie quietly.
				//
				// Byte-for-byte the note's line (InkOverlay.ts), on this
				// surface's own metrics object. Nothing new on the hot path:
				// the closure is built once here, not per event; recordEvent
				// returns on its first line unless a stroke is live; and with
				// isInkSource false it does one increment and touches no Stat,
				// so there is no allocation on a move. The gate is `active`,
				// the note's gate, deliberately NOT diagnosticsEnabled() - a
				// stricter gate on one of two surfaces is this project's most
				// expensive defect shape rebuilt at small scale.
				onPenMove: (_ev, count) => this.metrics.recordEvent("move", count, 0, false),
				onPenUp: (ev) => this.penUp(ev),
				// A HAND IS LANDING WITH NOTHING ELSE ON THE GLASS (alan,
				// 1.4.12: "hide the mouse reticle when a finger or pen is
				// active"). `InlinePenRouter.onHandOnGlass` fires only on that
				// edge - a stale mouse ring left over from before the finger or
				// pen arrived - so `hideCursor` is safe here even mid pen-stroke:
				// the router asks only when `handOnGlass()` was false a moment
				// ago, which a claimed pen already made true. Byte-for-byte the
				// note surface's reasoning (InkOverlay.ts, `onHandOnGlass:
				// () => this.hidePenCursor()`); this surface had no reticle to
				// stand down until now, so it was left `undefined` (an optional,
				// note-only member) rather than sharing the rule - the gap this
				// brief closes. `hideCursor` and not a narrower hide: it is the
				// one teardown every abandon path already goes through, and it
				// takes `handwriting-pdf-hover`'s `cursor: none` off with the
				// ring, leaving the native cursor rather than no pointer at all.
				onHandOnGlass: () => this.hideCursor(),
				// PEN OFF (PenInk.ts, design §5): byte-for-byte the note
				// overlay's line, because it is byte-for-byte the same rule.
				// This surface passed NOTHING for two days - the state was
				// declared note-only on the grounds that a pdf has nothing to
				// type into - and the owner reversed it: "i think the dude was
				// having trouble with his keyboard coming up on pdf when he
				// didnt want it to? so why would you take keyboard mode away
				// from pdf". Off means this router claims nothing, so the pen
				// is a native pointer on the viewer: it selects text, follows
				// a link, reaches a form field, and a tap in one raises the
				// keyboard the way any other app's would.
				penOff: () => !penInkEnabled(),
				// See `strokeAbandoned`. A named method rather than the body
				// inline: the surface registry's check for this wiring is a
				// scan of raw source text, which a comment satisfies, so the
				// body needs to be somewhere a test can call.
				onStrokeAbandoned: () => this.strokeAbandoned(),
			},
			() => 1,
			// The viewer keeps its own pinch: nothing here implements one, and
			// "none" leaks the two-finger touches to the app as a sidebar swipe.
			"pinch-zoom",
			undefined,
			// No native touch window: a finger handed to the browser after a
			// pan moved nothing on the viewer, so every pan stays with the assist.
			false
		);
	}

	/**
	 * End a stroke that is live right now, committing it. The pdf half of
	 * `endLiveStrokesEverywhere` (InkOverlay.ts), whose header carries the
	 * whole reasoning, and byte-for-byte the note's `endLiveStroke`.
	 *
	 * The pen can be turned off with the nib on the glass - a hotkey, the
	 * palette, or the other hand on this strip - and the router's gate refuses
	 * only NEW claims. COMMITS rather than drops: `finishActiveStroke()` ends
	 * the stroke exactly as a lift does, reaching `penUp()` through `onPenUp`,
	 * which is where the ink is stored and the strip chrome comes back down.
	 * Keyboard-OFF passes `preserveMouse` so an owned mouse remains live until
	 * its own lift; blur and teardown retain the default forced finish.
	 * Deliberately NOT `abandonActiveStroke()` - that is the teardown for a
	 * stroke whose page is going away (`forgetHistory` above), and turning the
	 * pen off is not a request to throw away the word being written.
	 *
	 * A no-op with nothing live, and no chrome call of its own, for the same
	 * reasons the note's twin gives.
	 */
	function endLiveStroke(this: PdfInkController, preserveMouse = false): void {
		this.router?.finishActiveStroke({ preserveMouse });
	}

	/**
	 * A live gesture was torn down inside the router with no pointerup.
	 *
	 * NOT THE WINDOW BLUR ANY MORE (alan, 2026-09-04: "alt tab mid stroke -
	 * sure make it consistent"). A blur mid-stroke now COMMITS what was drawn,
	 * through the router's `finishActiveStroke()` -> `penUp()`, the rule
	 * `docs/manual.md` already states for the viewer rebuilding under the pen.
	 * What still arrives here is the teardown that really does drop a stroke:
	 * `forgetHistory()`, the in-place document change, where the pane is
	 * showing a different file and committing the old one's fragment onto it
	 * would be worse than losing it. The note surface's twin carries the same
	 * split for the same reason.
	 *
	 * The strip first, and byte-for-byte the note's line. `stripPenDown` ran
	 * at contact, and abandoning ends the stroke without a PointerEvent, so
	 * nothing reaches `penUp()` to put it back - the strip and pill would
	 * stand `is-inking` (styles.css: opacity 0 AND pointer-events none, so
	 * unhit-testable, not merely invisible) until some later stroke completed.
	 * Deliberately NOT `penUp()` itself, which commits ink, ends metrics and
	 * closes an erase batch for a stroke that is being dropped.
	 *
	 * THE SURFACE'S OWN GESTURE STATE IS THE OTHER HALF, and for two releases
	 * this method was the chrome half alone. `builder`, `erasing`, `lassoPts`,
	 * `spaceLineY`, `dragFrom`, `frame` and `wetBegun` all stayed set, because
	 * the one path that clears them is `resetGestureState()` and no teardown
	 * without a lift reached it. `get idle` is computed from five of those,
	 * and main.ts skips a pane that is not idle when reloading ink - so a
	 * document switch mid-erase or mid-lasso left that pane silently refusing
	 * another device's ink for the life of the view, with nothing on screen to
	 * say so. `resetGestureState` names exactly that hazard in its own header.
	 * `forgetHistory` calls it unconditionally afterwards for the state a
	 * switch inherits with nothing live; this is the half that has to run
	 * while `erasing` and `builder` still say what the gesture WAS.
	 *
	 * The reticle goes with it. Hover has gone quiet under a claimed contact,
	 * and for a mouse there is deliberately no watchdog left to catch it
	 * (a7eba85), so nothing else would take the ring - or
	 * `handwriting-pdf-hover`'s `cursor: none` over the whole viewer - away.
	 *
	 * AND THE WET TRAIL, which `resetGestureState` cannot take off: it clears
	 * `wetFrom` and `wetBegun` - the bookkeeping that says a wet stroke is in
	 * progress - and the samples already painted on the canvas are not state,
	 * they are pixels. The one path that clears them is `penUp`, and an
	 * abandoned stroke by definition never reaches it, so a half-drawn stroke
	 * stayed lit on the page across the switch - the OLD file's ink, painted
	 * over the new one, never committed anywhere - until some later gesture
	 * happened to draw on the same layer.
	 * Cleared, not committed: `penUp()` would store the fragment, and a
	 * stroke torn down with no lift is dropped on this surface exactly as it
	 * is on the note's (InkOverlay.strokeAbandoned clears both its wet layers
	 * and restores the highlighter element the same way).
	 *
	 * The file-switch path DOES come through here, as of this branch's
	 * fix-up: `forgetHistory` reads `router.abandonActiveStroke()` itself -
	 * it has its own reason to, and its own unconditional
	 * `resetGestureState()` for the state a switch inherits with nothing live
	 * - and calls this when the boolean says a stroke was really torn down.
	 * It carried a hand-copied `stripPenUp` before that, and the copy had
	 * already drifted: no reticle, and no wet clear either.
	 */
	function strokeAbandoned(this: PdfInkController): void {
		stripPenUp(this.tools);
		this.hideCursor();
		// Before `resetGestureState()`, which zeroes `strokePageNumber`: the
		// page the trail was painted on is what says which canvas to clear
		// and at what size.
		this.clearWetTrail(this.strokePageNumber);
		this.resetGestureState();
	}

	/**
	 * Take a gesture's wet trail off the page it was drawn on, and put the
	 * shared layer back to its resting dress.
	 *
	 * `penUp`'s empty-stroke branch, lifted out for its second caller: an
	 * abandoned stroke is the same event as a stroke that finished with
	 * nothing to commit - there is no committed ink coming to replace what is
	 * painted, so this is the only thing that can take it off.
	 *
	 * The COMMIT branch at the end of `penUp` deliberately does not call
	 * this. It measures the page before `emit`/`sync` and clears afterwards,
	 * so the box it clears at is the one the wet ink was drawn at rather than
	 * whatever the repaint left behind; that ordering is the handoff, and it
	 * is not this method's to hold.
	 *
	 * `wetOn` answers null when the pair has moved on to another page, which
	 * is the right answer: a pair the DOM says is somewhere else is holding
	 * nothing of this gesture's. `undressWet` runs either way - the wash is
	 * this controller's state, not the canvas's.
	 */
	function clearWetTrail(this: PdfInkController, page: number): void {
		const pair = this.wetOn(page);
		const box = this.frameBox(page);
		if (pair && box) {
			// Every device clears the stroke's own box, and the tail its dirty
			// rect. Same reasoning as `penUp`'s commit branch below - see the
			// comment there, which is where it is written out.
			pair.wet.clearStroke(box.widthPx, box.heightPx);
			pair.tail.clear(box.widthPx, box.heightPx);
		}
		this.undressWet(this.overlays.get(page));
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
	function resetGestureState(this: PdfInkController): void {
		if (this.editFrame !== null) this.win.cancelAnimationFrame(this.editFrame);
		this.editFrame = null;
		this.editPaint = null;
		this.editTarget = null;
		this.editDelta = { dx: 0, dy: 0 };
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

	/**
	 * Repaint every live page: the ink changed underneath us.
	 *
	 * Also the note surface's re-arm point: "a note that gains ink and later loses it elsewhere should speak
	 * again" (InkOverlay.ts:2280-2288's own words) has to hold here too, not
	 * only at the next erase/lasso start on that page - a page that gains ink
	 * and loses it again BETWEEN gestures (undo, another pane, a sync) must
	 * still be forgotten the moment the ink arrives, or the eraser's later
	 * verdict on that now-empty page is silently stale.
	 *
	 * `refresh()` runs on every undo,
	 * paste, other-pane commit and sync - walking EVERY probed page and
	 * filtering the whole document's strokes per page on that path measured
	 * 7-34 ms at 300-600 pages, on a path that did no such scan before this
	 * item at all; it also called `probe()` (a DOM geometry read) even when
	 * nothing was claimed. `claimedPages` is normally empty and at most one
	 * entry per page a toast has actually fired for, so walking ONLY it -
	 * never `probe()`, never the other pages - is the whole fix: usually
	 * zero strokes-filter calls, never more than the claimed count.
	 */
	function refresh(this: PdfInkController): void {
		for (const page of this.claimedPages) {
			if (this.strokes(page).length === 0) continue; // still empty: stays claimed
			const key = this.emptyPageNoticeKey(page);
			if (key !== null) this.emptyPageNotice.forget(key);
			this.claimedPages.delete(page);
		}
		for (const a of this.overlays.values()) a.paintedCount = -1;
		this.schedule();
	}

export function installPdfInkBind(proto: PdfInkController): void {
	installMethods(proto, {
		emptyPageNoticeKey,
		sayIfPageEmpty,
		peelEscapeSelection,
		textSelectionLive,
		releaseFocusBinding,
		bindTo,
		endLiveStroke,
		strokeAbandoned,
		clearWetTrail,
		resetGestureState,
		refresh,
	});
}
