/**
 * The pen router's stroke end: finishing a live stroke the way a lift would, and abandoning one when the surface switches.
 * They are methods of InlinePenRouter, installed on its prototype when InlinePenRouter.ts loads.
 */
import { telemetry } from "../diag/Telemetry";
import { hideProbeMarkers } from "./PenProbe";
import { installMethods } from "./InstallMethods";
import type { InlinePenRouter } from "./InlinePenRouter";

declare module "./InlinePenRouter" {
	interface InlinePenRouter {
		finishActiveStroke(opts?: { preserveMouse?: boolean }): boolean;
		abandonActiveStroke(): boolean;
	}
}


	/**
	 * End a live pen stroke the way a LIFT would, with no pointer event to end
	 * it. The blur half of `endPenStroke`, and `abandonActiveStroke`'s
	 * opposite number.
	 *
	 * The owner's ruling (2026-09-04, "alt tab mid stroke - sure make it
	 * consistent"): a window blur mid-stroke commits what was drawn instead of
	 * dropping it, which is what `docs/manual.md` already promises for the pdf
	 * viewer rebuilding under the pen - "the stroke commits what was drawn
	 * instead of vanishing; only the gesture ends".
	 *
	 * Deliberately NOT routed through `abandonActiveStroke()`. That method's
	 * contract is a stroke being DROPPED: it never calls `cb.onPenUp`, and it
	 * tears down state a real lift leaves standing (the touch bookkeeping, the
	 * ownership guard, and the resting touch-action guard whose removal was
	 * the lit-nib regression `2e880b4` fixed). This one is `endPenStroke`'s
	 * body instead, for the same reason a real pen-up is:
	 *
	 *   - the ownership tail is ARMED, not torn down, so the click/auxclick/
	 *     contextmenu fallout that follows any stroke end is still eaten for
	 *     the same 350 ms a normal lift eats it for;
	 *   - `guardApplied` is untouched, because armed IS the resting state.
	 *
	 * The touch bookkeeping IS cleared, and that is the one place this method
	 * cannot copy a real lift. A lift is a pointer event, so the fingers that
	 * were down alongside it still report their own; a blur is precisely the
	 * event that reports nothing, which is this handler's whole reason for
	 * existing (see its header: "the pen contact just goes quiet"). That
	 * argument was written about the pen and is exactly as true of a palm
	 * resting beside it - its `pointerup` and its `touchend` never arrive
	 * either, so `guardTouches.delete` and `manip.touchEnd` never run. Leave
	 * the maps alone and they are stranded for the life of the router, which
	 * makes `abandonActiveStroke`'s `hasLiveGesture` permanently true: every
	 * later note switch and every pdf `forgetHistory` stops being the
	 * `2e880b4` no-op and calls `restoreGuardStyle()` with nothing live,
	 * stripping the standing `touch-action: none` from under the first contact
	 * as a note opens. That is the lit-nib regression, reached the long way.
	 *
	 * Cleared, NOT released: no `restoreGuardStyle()`, no `manip.touchEnd()`,
	 * because there is no lift to report and the guard's resting state is
	 * armed. A contact that does report later finds nothing to delete and does
	 * nothing - the "never saw this contact" state `abandonActiveStroke`'s own
	 * header argues a stood-down router should be left in.
	 *
	 * Capture IS released, which `endPenStroke` does not do: a real pointerup
	 * releases it implicitly and a blur delivers no pointerup at all, so
	 * without this the scroller keeps an implicit capture for a pointer that
	 * will never report again.
	 *
	 * `cb.onPenUp()` is called with NO event - see the callback's own header
	 * for why nothing is synthesised in its place. Returns whether a live pen
	 * stroke was actually finished, so the blur handler can tell this case
	 * from "nothing live" and from "ownership bookkeeping only".
	 */
	function finishActiveStroke(this: InlinePenRouter, opts: { preserveMouse?: boolean } = {}): boolean {
		if (this.activePenId === null) return false;
		const wasFinger = this.activeIsFinger;
		if (opts.preserveMouse && !wasFinger && !this.activeIsPen) return false;
		// Null FIRST, then release. `releasePointerCapture` is what raises
		// `lostpointercapture`, whose handler calls `endPenStroke(e, false)` -
		// a second full commit, `cb.onPenUp` included - and the only thing
		// stopping it is `endPenStroke`'s own `activePenId === null` test.
		// Chromium dispatches that event asynchronously, so nothing re-enters
		// here on a device, but that is the engine's scheduling holding the
		// invariant up rather than this code, and it became load-bearing the
		// moment this path started calling `onPenUp`.
		const penId = this.activePenId;
		this.activePenId = null;
		this.activeIsFinger = false;
		try {
			this.scrollEl.releasePointerCapture(penId);
		} catch {
			/* best-effort; capture may already be gone */
		}
		this.penUps++;
		telemetry.bump("inline.penUp");
		this.disarmEndBackstop();
		this.inkFeed.strokeEnd();
		if (!wasFinger) this.gate.penStrokeEnded(performance.now());
		this.touchesAtStrokeStart.clear();
		// The contacts the blur orphans alongside the pen - see the header.
		// liveTouchIds is NOT among them: unlike touchPos/guardTouches (OUR
		// bookkeeping), it mirrors what the browser itself still thinks is
		// down, fed only by real touchstart/touchend/touchcancel. A finger
		// physically on the glass across the blur is still physically on the
		// glass after it; clearing the mirror here would just make it wrong
		// until that finger's own touchend/touchcancel arrives to correct
		// it - and the NEXT stroke's touchesAtStrokeStart snapshot (see
		// touchesPredateStroke) would read empty for a contact that has been
		// down the whole time, so its later touchend gets eaten as if it
		// were a fresh mid-stroke touch.
		this.touchPos.clear();
		this.guardTouches.clear();
		// And the palms the gate swallowed: the same orphan, in the set
		// handOnGlass and resumeEaseIfIdle read beside guardTouches.
		this.swallowedTouches.clear();
		this.paroleId = null;
		this.paroleOverlapped = false;
		this.fingerInkBlockedUntilAllLift = false;
		if (wasFinger) this.applyGuard(this.manip.penSignal(), "finger-blur");
		this.gesturePanned = false;
		this.cancelFling();
		// Standing guard: no release. Armed IS the resting state.
		hideProbeMarkers();
		// A blur is not the end of the fallout. The window that took focus can
		// hand it straight back (a dismissed dialog, the on-screen keyboard
		// closing) and the trailing click lands here, so the tail is armed the
		// same way `endPenStroke` arms it.
		if (!wasFinger) this.scheduleOwnershipDisarm();
		this.cb.onPenUp();
		this.finishFingerInkPreparation();
		return true;
	}

	/**
	 * Called when the surface this router is bound to is about to show a
	 * different note (or otherwise loses continuity with whatever pen/touch
	 * contacts it was tracking): end any in-flight stroke and stand ownership
	 * down immediately, not through the normal post-stroke tail.
	 *
	 * Unlike `dispose()` this does NOT remove the scroller listeners or drop
	 * the router from `liveScrollers` - the router keeps routing for the new
	 * note, it just cannot carry the old note's gesture into it. A lost
	 * pointerup (finger resting through the switch, so its lift never reaches
	 * this editor) must not leave `activePenId` set: that would keep the
	 * window-capture click suppressor armed forever, eating every future pen
	 * tap on the toolbar strip.
	 *
	 * Touch bookkeeping (`touchesAtStrokeStart`/`touchPos`/`liveTouchIds`/
	 * `guardTouches`) is cleared ONLY when a claimed pen stroke was torn down
	 * here. The argument for clearing it every time was that a brand-new
	 * `InlinePenRouter` (opening the note in a fresh pane) starts with these
	 * collections empty even when a finger is already resting on the glass at
	 * construction time, because `pointerdown` only fires for contacts made
	 * AFTER the listener attaches - a pre-existing finger is simply invisible
	 * to a fresh router until it lifts and lands again - so standing
	 * ownership down should leave the router in that same "never saw this
	 * contact" state. `e0ff9c3` narrowed that to the contacts a STROKE owned
	 * (1.4.10-design.md §17 deferral (2)): the pdf controller's in-place
	 * document switch runs this method mid-pinch, and forgetting the pinch's
	 * contacts while `assistPointerId`/`assistEngaged`/`pinchLive`/`paroleId`
	 * survive leaves the two halves of the touch model disagreeing about what
	 * is still down. A pinch, or a finger resting through a switch, therefore
	 * survives an abandon-without-a-stroke exactly as it survives a blur -
	 * see the clears' own comment in the body. The guard and ownership
	 * teardown at the foot is gated on the same question for the same reason:
	 * a PEN gesture being torn down, not anything at all being live.
	 *
	 * Returns whether a live PEN STROKE was actually torn down (as opposed to
	 * nothing live, or only touch/gesture bookkeeping with no claimed pen
	 * contact). Only a claimed stroke could have told the strip chrome
	 * `setInking(true)` (InkOverlay.penDown -> stripPenDown), and this path
	 * - unlike a normal pointerup - never calls back into the overlay at all,
	 * so the caller uses the return value to put that chrome down itself
	 * (`stripPenUp`) exactly when there is a stale "mid-stroke" strip to
	 * undo. Skipping that call the rest of the time keeps a routine switch
	 * with nothing to abandon byte-for-byte the no-op it already was.
	 */
	function abandonActiveStroke(this: InlinePenRouter): boolean {
		// `guardApplied` is deliberately NOT part of this predicate. The
		// resting state of a router is guard-ARMED (touch-action: none on
		// the scroller, ManipulationGuard's header: "the resting state must
		// already be touch-action: none BEFORE the pen exists") - every
		// fresh router starts with guardApplied === true before any pen or
		// touch has been seen. `restoreGuardStyle()` below un-arms it, which
		// is correct cleanup for a stroke/ownership this method is actually
		// tearing down, but firing it on a router that never armed anything
		// ELSE (no stroke, no ownership, no touch) strips the baseline
		// touch-action guard right as a note opens (`update()`'s path-change
		// branch, unconditionally) or on any window blur (`dcf0254`, also
		// unconditionally) - a frame or more before a pen can exist, which
		// is exactly when Chromium needs that guard already committed to
		// recognize pen contact/hover cleanly. That is the lit-nib
		// regression: the light never gets the hardware event it is waiting
		// on because the guard that was supposed to already be in place got
		// pulled out from under the first contact.
		//
		// So: nothing live to abandon means no stroke, no armed ownership,
		// no pending ownership tail/timer, no fling, no touch bookkeeping.
		// "Abandon the active stroke" with none of that present must change
		// NO state - guard style included. This predicate is every OTHER
		// condition the block below can act on; keep it in sync as this
		// method grows.
		//
		// `ownershipTailUntil` is read as the DEADLINE it is, not as a flag.
		// It is set at every stroke end (`scheduleOwnershipDisarm`) and
		// cleared nowhere but the teardown below, so `!== 0` - what this term
		// said until now - was permanently true from the session's FIRST
		// completed stroke onward. That made the whole predicate permanently
		// true, which meant every later note switch and every later blur ran
		// the full teardown including `restoreGuardStyle()`: the lit-nib
		// regression this predicate was written to stop, back again after one
		// stroke. Nothing WRITES the field differently, which is what keeps
		// `suppressNativeFallout` (which reads the same deadline for the same
		// 350ms) behaving exactly as it did inside a live tail.
		// THE GATE (the term below decides IF this call acts; it does NOT
		// decide whether the guard/ownership teardown at the foot is right,
		// and since `e0ff9c3` those are two different questions). The touch
		// maps are no longer cleared when `hadStroke` is false - a pinch or a
		// resting finger has to survive a switch, see the clears' own comment
		// below - so a contact whose pointerup never arrives (an OS gesture
		// steals the pointer, the pane is hidden mid-contact, a popout closes
		// under a finger) leaves one map entry behind for the life of the
		// router. That single entry keeps `hasLiveGesture` permanently true,
		// and every later note switch and every later blur would reach
		// `restoreGuardStyle()` again: the lit-nib regression once more, this
		// time by a stale finger rather than the stale tail the paragraph
		// above closed.
		//
		// So `disarmOwnership()`/`restoreGuardStyle()` hang off
		// `tearingDownPenGesture` (below) instead: a claimed stroke, armed
		// ownership, or a live tail - the three things a PEN put in place, and
		// the only things those two calls are cleanup FOR. Touch bookkeeping
		// is deliberately not a term: those contacts may still be on the glass
		// (that is precisely why their maps now survive), and un-arming the
		// standing touch-action guard out from under a live pinch is the same
		// mistake wearing a different hat.

		const hasLiveGesture =
			this.activePenId !== null ||
			this.ownershipFn !== null ||
			this.ownershipDisarmTimer !== null ||
			performance.now() < this.ownershipTailUntil ||
			this.flingRaf !== 0 ||
			this.gesturePanned ||
			this.touchesAtStrokeStart.size > 0 ||
			this.touchPos.size > 0 ||
			this.liveTouchIds.size > 0 ||
			this.guardTouches.size > 0;
		if (!hasLiveGesture) return false;
		const hadStroke = this.activePenId !== null;
		const abandonedFinger = hadStroke && this.activeIsFinger;
		// Read BEFORE the teardown below zeroes the terms it is made of.
		const tearingDownPenGesture =
			hadStroke ||
			this.ownershipFn !== null ||
			this.ownershipDisarmTimer !== null ||
			performance.now() < this.ownershipTailUntil;
		if (this.activePenId !== null) {
			// Null FIRST, then release - same ordering as `finishActiveStroke`
			// and for a sharper reason. `lostpointercapture` commits through
			// `endPenStroke`, so a synchronous dispatch would make THIS method
			// call `cb.onPenUp` for a stroke it is dropping, which is the one
			// thing its contract promises it never does.
			const penId = this.activePenId;
			this.activePenId = null;
			this.activeIsFinger = false;
			try {
				this.scrollEl.releasePointerCapture(penId);
			} catch {
				/* best-effort; capture may already be gone */
			}
			this.disarmEndBackstop();
			this.inkFeed.strokeEnd();
			if (!abandonedFinger) this.gate.penStrokeEnded(performance.now());
			hideProbeMarkers();
		}
		// These four touch-map clears run ONLY when `hadStroke` - a claimed
		// pen contact was actually torn down above. The previous comment
		// here claimed a note switch is "defined" to forget a resting
		// finger even though it is still physically down; that definition
		// is exactly what produced 1.4.10-design.md §17 deferral (2): the
		// pdf controller's in-place document switch runs this method mid
		// pinch, and wiping touchPos/liveTouchIds/guardTouches for the
		// pinch's second contact while assistPointerId/assistEngaged/
		// pinchLive/paroleId survived untouched left the assist panning on
		// the first contact with no idea where the second one went - the
		// two halves of the touch model disagreeing about what was still
		// down. (The other fix considered, clearing the assist/pinch
		// quartet alongside the maps, was rejected: a parked branch,
		// 1.4.10-fix-abandon-assist, tried standing the assist down on
		// abandon and un-protected a contact still on the glass.)
		//
		// The rule now: a switch forgets a CONTACT ONLY WHEN IT WAS THE
		// STROKE'S. When `hadStroke` is false, nothing here belonged to a
		// pen - only touch/gesture bookkeeping for contacts still resting
		// on the glass kept `hasLiveGesture` true - and a switch must leave
		// that bookkeeping alone exactly as a blur does, so a pinch or a
		// resting finger survives an abandon-without-a-stroke the same way
		// it survives a blur.
		if (hadStroke) {
			this.touchesAtStrokeStart.clear();
			this.touchPos.clear();
			this.liveTouchIds.clear();
			this.guardTouches.clear();
			this.fingerInkBlockedUntilAllLift = false;
			if (abandonedFinger) this.manip.penSignal();
		}
		this.gesturePanned = false;
		this.cancelFling();
		if (this.ownershipDisarmTimer !== null) {
			window.clearTimeout(this.ownershipDisarmTimer);
			this.ownershipDisarmTimer = null;
		}
		this.ownershipTailUntil = 0;
		// `disarmOwnership()` sits inside the gate for readability rather than
		// for effect - it already returns early when `ownershipFn` is null,
		// which is one of the gate's own terms.
		if (tearingDownPenGesture) {
			this.disarmOwnership();
			this.restoreGuardStyle();
		}
		return hadStroke;
	}

export function installInlinePenRouterEnd(proto: InlinePenRouter): void {
	installMethods(proto, {
		finishActiveStroke,
		abandonActiveStroke,
	});
}
