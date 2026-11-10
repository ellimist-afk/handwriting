/**
 * The pen router's pointer input: pointerdown, pointermove and pointerrawupdate, pointerup and cancel, the finger-ink hand-offs and
 * the end backstop. They are methods of InlinePenRouter, installed on its prototype when InlinePenRouter.ts loads.
 */
import { sideButtonErasesEnabled } from "./TipMode";
import { sideButtonAirHover, sideButtonAirInterrupt } from "./SideButtonAir";
import { telemetry } from "../diag/Telemetry";
import { PAROLE_MAX_CONTACT_PX, paroleEarned } from "../input/PalmGate";
import { isAppleTouchPlatform } from "../input/PalmShield";
import { PenSample, silentLift, TAP_MAX_MOVE_PX, TAP_MAX_MS } from "../input/PointerRouter";
import { hideProbeMarkers, markRawPointer } from "./PenProbe";
import { hitProbeDown, hitProbeHover, isHitProbeEnabled } from "./PenHitProbe";
import { scrollProbeTouch } from "./ScrollProbe";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { isPenCompatMouseMove } from "./PenCursor";
import { deviceHasNeverSeenAPen } from "./PenToolsMode";
import { setPenInk } from "./PenInk";
import { installMethods } from "./InstallMethods";
import { backstopMayEnd, computedTouchActionNote, csOf, guardEnabled, liveRouters, tr, type InlinePenRouter } from "./InlinePenRouter";

/**
 * Each router's lone-finger landings, by pointer id, for the tap test at the lift (the same bounds as PointerRouter's
 * own tap: TAP_MAX_MOVE_PX, TAP_MAX_MS). Only a finger that lands alone can end as a tap; a second contact spoils
 * every start.
 */
type TapStart = { x: number; y: number; at: number; caught: boolean };
const tapStarts = new WeakMap<InlinePenRouter, Map<number, TapStart>>();
/** `caught`: the contact landed on a gliding or easing page, which stops a scroll and is scrolling, never a tap. */
function noteTapStart(router: InlinePenRouter, e: PointerEvent, caught: boolean): void {
	let starts = tapStarts.get(router);
	if (!starts) tapStarts.set(router, (starts = new Map<number, TapStart>()));
	if (router.touchPos.size === 0 && router.activePenId === null) starts.set(e.pointerId, { x: e.clientX, y: e.clientY, at: e.timeStamp, caught });
	else starts.clear();
}

/**
 * A finger that landed alone on the selection (its padded box, a handle, the Attach button or a pin: the surface's
 * claimTouch). Nothing claims it at the down: no ink, no pan, no lasso. Past TAP_MAX_MOVE_PX from `x, y` the selection
 * claims it with `down`, the sample where it landed, so the drag counts from there. A lift inside the limit is the tap
 * it is today (onTapLift).
 */
type SelectionTouch = { pointerId: number; x: number; y: number; down: PenSample };
const selectionTouches = new WeakMap<InlinePenRouter, SelectionTouch>();

/** Does the surface's selection take this lone finger? Only a finger the palm rule would not call a palm by its size. */
function selectionTakesTouch(router: InlinePenRouter, e: PointerEvent): boolean {
	if (!router.cb.claimTouch || router.touchPos.size !== 0 || router.activePenId !== null || router.fingerInkBlockedUntilAllLift) return false;
	const contactPx = typeof navigator !== "undefined" && isAppleTouchPlatform(navigator) ? 0 : Math.max(e.width || 0, e.height || 0);
	if (contactPx > PAROLE_MAX_CONTACT_PX) return false;
	router.refreshRect();
	return router.cb.claimTouch(router.sampleFrom(e));
}

/** How long a tap the surface took keeps its trailing touch events and mouse fallout from the editor, ms. */
export const TAP_FALLOUT_MS = 350;
/** How far from the tap a trailing event may land and still be its fallout, css px. */
export const TAP_FALLOUT_PX = 24;
const TAP_FALLOUT_EVENTS = ["touchend", "mousedown", "mouseup", "click"] as const;
const tapEaters = new WeakMap<InlinePenRouter, () => void>();
/** Each router's one disposer that stops its armed eater, kept so a tap does not add a second to `disposers`. */
const tapEaterDisposers = new WeakMap<InlinePenRouter, () => void>();

/**
 * A tap the surface took: its own eater, armed once on the window's capture phase ahead of the editor and Obsidian, for
 * the touch's trailing touchend, its compatibility mousedown and mouseup and its click near the tap point, for
 * TAP_FALLOUT_MS. The touchend is only prevented (the router's own touch bookkeeping still reads it), the rest prevented
 * and stopped; the click ends it. The pen's ownership guard cannot do this: it lets touch fallout through on purpose.
 */
function eatTapFallout(router: InlinePenRouter, e: PointerEvent): void {
	tapEaters.get(router)?.();
	const win = router.winRef, x = e.clientX, y = e.clientY;
	const near = (ev: Event): boolean => {
		const t = (ev as TouchEvent).changedTouches?.[0], m = ev as MouseEvent;
		const cx = t ? t.clientX : m.clientX, cy = t ? t.clientY : m.clientY;
		return typeof cx !== "number" || typeof cy !== "number" || Math.hypot(cx - x, cy - y) <= TAP_FALLOUT_PX;
	};
	const eat = (ev: Event): void => {
		if (!near(ev)) return;
		ev.preventDefault();
		if (ev.type !== "touchend") ev.stopPropagation();
		if (ev.type === "click") stop();
	};
	let timer: number | null = null;
	const stop = (): void => {
		for (const type of TAP_FALLOUT_EVENTS) win.removeEventListener(type, eat, { capture: true });
		if (timer !== null) win.clearTimeout(timer);
		timer = null;
		if (tapEaters.get(router) === stop) tapEaters.delete(router);
	};
	for (const type of TAP_FALLOUT_EVENTS) win.addEventListener(type, eat, { capture: true, passive: false });
	timer = win.setTimeout(stop, TAP_FALLOUT_MS);
	tapEaters.set(router, stop);
	// The router's dispose stops the eater too, as it clears its own timers: a pane closed inside the window leaves no
	// listener on the window and no timer behind.
	let drop = tapEaterDisposers.get(router);
	if (!drop) tapEaterDisposers.set(router, (drop = () => tapEaters.get(router)?.()));
	if (!router.disposers.includes(drop)) router.disposers.push(drop);
}

declare module "./InlinePenRouter" {
	interface InlinePenRouter {
		pointerDown(e: PointerEvent): void;
		claimFingerInk(e: PointerEvent, down?: PenSample): void;
		cancelFingerInkForPinch(): void;
		commitFingerInkForPenPreemption(): void;
		traceHover(e: PointerEvent): void;
		pointerMove(e: PointerEvent): void;
		pointerRawUpdate(e: PointerEvent): void;
		feedBeforeSilentLift(e: PointerEvent): void;
		smoothed(samples: PenSample[]): PenSample[];
		pointerUpOrCancel(e: PointerEvent): void;
		resumeEaseIfIdle(): void;
		endPenStroke(e: PointerEvent, viaFallback: boolean): void;
		retireAllContactsOnNativeEnd(): void;
		retireEndedFingerContact(pointerId: number): void;
		armEndBackstop(): void;
		disarmEndBackstop(): void;
	}
}


	/** Per router: the pen pointer whose button went down in the air, until its pointerup (GitHub issue 41). */
	const airPress = new WeakMap<InlinePenRouter, number>();

	// ---- pointerdown --------------------------------------------------------

	function pointerDown(this: InlinePenRouter, e: PointerEvent): void {
		// A new contact comes after the last taken tap's own fallout, so it ends that tap's eater: a second tap close by
		// and soon after reaches the text. Any pointer, before any branch.
		tapEaters.get(this)?.();
		// Read before the two lines below stop them: a glide still running or the surface's ease still playing.
		const caughtGlide = this.flingRaf !== 0 || (this.cb.easePlaying?.() ?? false);
		this.cb.onViewportInput?.();
		this.cancelFling(); // any new contact ends the glide (pen wins instantly)
		// A contact in the middle of a side-button press in the air: the press
		// is not a click (SideButtonAir.ts). Any pointer, before any branch.
		{
			const held = sideButtonAirInterrupt();
			if (held !== null) tr("pointerdown", e, held);
		}
		if (e.pointerType === "touch") {
			this.lastTouchAt = performance.now();
			scrollProbeTouch();
			// A PRIMARY TOUCH IS THE ONLY TOUCH ON THE GLASS (Pointer Events: the primary touch pointer is the
			// first contact made while no other touch is active). A contact this router still holds when one
			// lands lost its lift, and the touchend that heals that on the browser's word (InlinePenRouterBind.ts)
			// can be lost with it: the stale contact made this finger the second one, a pinch, and one finger
			// moved nothing (issue 51, Linux). Retired here before anything reads the touch maps.
			if (e.isPrimary && !this.touchPos.has(e.pointerId) && (this.touchPos.size > 0 || this.guardTouches.size > 0 || this.assistPointerId !== null)) {
				tr("pointerdown", e, "primary touch with a contact still held: lost lift retired");
				this.retireAllContactsOnNativeEnd();
			}
			noteTapStart(this, e, caughtGlide);
			// A HAND IS LANDING. Asked BEFORE this contact is recorded, so a
			// true answer means one was already there - a palm settling beside
			// a working pen, or the second finger of a pinch - and the surface
			// is left alone. See `onHandOnGlass` for why a finger is the only
			// pointer that has anything to say here.
			//
			// ABOVE EVERY BRANCH BELOW, palm gate included: a contact this
			// router is about to swallow is still a hand on the glass, and the
			// mouse's ring is as unwanted under it as under any other.
			//
			// THE QUESTION IS THIS ROUTER'S; THE ANSWER GOES TO EVERY PANE.
			// The ask stays `this.handOnGlass()` so the edge-not-level
			// property above survives exactly as written - a palm settling
			// beside a working pen sees a hand already on ITS OWN glass and
			// says nothing, and the pen's ring never blinks. What changes is
			// who hears it: a parked mouse in ANOTHER pane sends no further
			// event of any kind, so the `anyHandOnGlass()` gate at the reticle
			// sites - which only ever runs on a mouse SAMPLE - can never take
			// down a ring that is already lit over there. This edge is the
			// only thing that can, and it has to reach every live router.
			//
			// Fanned out here rather than by the surfaces' callback bodies
			// (which stay each surface's own stand-down, unchanged) because
			// this module must not import `InkOverlay` to reach
			// `hidePenCursorsEverywhere` - that closes a real cycle, the one
			// `stripSurfaces` exists to avoid. `liveRouters` already holds
			// every surface of both kinds, and each router's `onHandOnGlass`
			// is that surface's own hide, so the set is the fan-out.
			//
			// Includes THIS router, which is the 1.4.12 behaviour unchanged:
			// with one pane open the loop runs once and calls exactly the
			// callback the old line called.
			if (!this.handOnGlass()) for (const r of liveRouters) r.cb.onHandOnGlass?.();
			// A second contact ends a finger still waiting on the selection: it is a pinch or a palm now.
			if (selectionTouches.get(this)?.pointerId !== e.pointerId) selectionTouches.delete(this);
			// Asked before the finger-ink claim: a finger on the selection makes no ink, on iPhone too.
			const onSelection = selectionTakesTouch(this, e);

			// Finger ink is a deliberately tiny opt-in: first contact only, on
			// the ordinary-note host that supplied the predicate. Record it in
			// the normal touch maps before claiming it so a second contact can
			// atomically turn this same gesture into the existing pinch path.
			if (
				!onSelection &&
				!this.fingerInkBlockedUntilAllLift &&
				this.activePenId === null &&
				this.touchPos.size === 0 &&
				(this.cb.fingerInk?.() ?? false)
			) {
				this.guardTouches.add(e.pointerId);
				this.touchPos.set(e.pointerId, { x: e.clientX, y: e.clientY });
				this.applyGuard(this.manip.touchStart(), "finger-ink");
				this.claimFingerInk(e);
				return;
			}

			// A second finger revokes the provisional stroke before pinch sees
			// either move. Keep both touch-map entries: pinch, third fingers and
			// replacement contacts all depend on that bookkeeping staying whole.
			if (this.activeIsFinger && this.activePenId !== null) {
				this.guardTouches.add(e.pointerId);
				this.touchPos.set(e.pointerId, { x: e.clientX, y: e.clientY });
				this.manip.touchStart();
				this.cancelFingerInkForPinch();
				// With the host's own pinch in force the second contact is not ours to turn into a zoom.
				// The provisional finger stroke is already revoked above; the gesture is left to the browser.
				if (this.touchPos.size === 2 && (this.cb.pinchZoom?.() ?? true)) this.beginPinch(e);
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			// The one piece of touch arbitration Handwriting owns: a palm planted
			// while the pen is writing or hovering must not scroll the note or
			// move the caret. Everything else about touch is the editor's.
			// Palm-blocked contacts never open the guard's touch window.
			if (this.anyGateBlocksNewTouch(performance.now())) {
				this.palmsBlocked++;
				telemetry.bump("inline.palmBlocked");
				this.swallowedTouches.add(e.pointerId);
				// Watch it: a swipe-like start earns parole (assist pan);
				// a resting palm stays swallowed.
				this.paroleId = e.pointerId;
				this.paroleDownX = e.clientX;
				this.paroleDownY = e.clientY;
				this.paroleDownAt = performance.now();
				// The size veto was calibrated on Windows, where a fingertip reports a
				// few px. iOS reports width as twice the contact radius, so an iPad
				// fingertip lands at 62-84 px and was vetoed as a palm: a finger swipe
				// near the Pencil never scrolled. On Apple touch platforms the size is
				// read as unknown and the motion test alone decides (PalmShield.ts
				// turns its own size rule off there for the same reason).
				this.paroleContactPx =
					typeof navigator !== "undefined" && isAppleTouchPlatform(navigator)
						? 0
						: Math.max(e.width || 0, e.height || 0);
				// Landed while the pen is down: the hand that follows the pen,
				// never a scroll finger. No parole, ever (eraser-scrub fix).
				// The pen in ANY pane: one hand writes across a split.
				this.paroleOverlapped = this.anyPenDown();
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
			// ALAN DIRECT (2026-09-20, "it should stay obsidian stock behavior"): A SECOND FINGER IS NOT
			// OURS WITH THE ZOOM OFF. The overlay already ignores every pinch phase with the Infinite Canvas off
			// (a4508b26), but the router still claimed both contacts and armed the guard, so the host never saw
			// the gesture at all: no stock pinch, and nothing in its place. Asked BEFORE the contact is recorded
			// or guarded, so the browser owns it from the first event rather than having it handed back later.
			if (this.touchPos.size === 1 && !(this.cb.pinchZoom?.() ?? true)) {
				// Alan: "yes native obsidian": a first finger that is assist-panning ends its pan
				// here, as if it had lifted, so the whole two-finger gesture is the host's. A finger that has not
				// engaged a pan yet stays tracked but stops being a pan candidate: in a real pinch both fingers
				// land within milliseconds, before the first has travelled the slop, and left as a candidate it
				// engaged its own pan mid-gesture and flung on lift.
				const first = this.assistPointerId;
				if (first !== null && this.assistEngaged && this.touchPos.has(first)) this.yieldAssistToHost(first);
				else if (first !== null) {
					this.assistPointerId = null;
					this.assistSamples = [];
				}
				return;
			}
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
			if (this.fingerInkBlockedUntilAllLift) {
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			// On the selection: no pan to begin. Held here until it passes the tap limit or lifts.
			if (onSelection) {
				selectionTouches.set(this, { pointerId: e.pointerId, x: e.clientX, y: e.clientY, down: this.sampleFrom(e) });
				tr("pointerdown", e, "touch on the selection (waits for the tap limit)");
				return;
			}
			// A DRAG THAT BEGINS AGAINST AN END IS OURS, whatever the guard thinks. The give is the
			// remainder `carryScrollBy` refuses, and that only runs while the assist owns the drag;
			// when it does not, the touch goes to the native scroller instead. Inside the range that
			// is invisible - native scrolling carries it and nobody can tell who owned it - but
			// against an end the native scroller has nothing to do, so the gesture is dropped and
			// there is no refused remainder for the give to carry. The guard is armed for the FIRST
			// finger of a gesture and re-arms a second after the last lift, so the drag that fails
			// this way is the SECOND one: try, nothing happens, try again, still nothing. Measured at
			// 20c182e1 in AssistEdgeGive - the first drag gives, the second gives nothing.
			const edgeStart = this.dragBeginsAgainstAnEnd();
			this.assistGateReadout = { assistThisGesture: d.assistThisGesture, guardEnabled, edgeStart, took: false };
			if (this.canvasMomentumDisabled || (d.assistThisGesture && guardEnabled) || edgeStart) {
				this.assistGateReadout.took = true;
				this.beginAssist(e);
				tr("pointerdown", e, "touch (guard held; assist will carry this gesture)");
			} else {
				tr(
					"pointerdown",
					e,
					d.touchAction === ""
						? `touch passthrough (native window)${computedTouchActionNote("touched element", e.target)}`
						: "touch (guard held)"
				);
			}
			return;
		}
		// A real pen is the more specific instrument. If it lands while the
		// iPhone finger stroke is live, finish the received finger ink exactly
		// once before the pen walks the unchanged claim path below. This is not
		// a pinch, so the user's mark is retained; the resting finger stays in
		// the touch maps and is reclassified by the existing pen/palm rules.
		if (e.pointerType === "pen" && this.activeIsFinger) {
			this.commitFingerInkForPenPreemption();
		}
		// ALAN, 2026-09-05 ("button should become the truth",
		// ~16:4x, verbatim): "what if we're on mouse cursor and then they
		// touch with a pen, it should light up." A device that has NEVER
		// seen a pen and sits in cursor mode (pen off here) gets its first
		// real pen contact treated as a request into pen input, and that
		// very contact must ink.
		//
		// THIS IS AN ORDERING FIX, NOT A REFUSAL FIX - stated because an
		// earlier version of this change argued the pen-off early return
		// two blocks down would otherwise REFUSE this exact contact and the
		// latch would never flip. THAT WAS WRONG, and is on the record as
		// wrong rather than quietly dropped: `penOff()` reads `!penInkEnabled
		// ()`, which DEFAULTS TRUE (PenInk.ts, `let enabled = true`), so a
		// pen-less device in ordinary use is never refused there in the
		// first place - the early return only bites a device that has
		// DELIBERATELY entered keyboard mode, which this branch's own
		// `deviceHasNeverSeenAPen()` guard already leaves untouched (see
		// below). The real problem is ORDER: the CLAIM DECISION two blocks
		// down reads `penOff()` (`!penInkEnabled()`), and nothing upstream of
		// it turns that flag on for a device sitting in keyboard mode - so
		// without this, a pen-less device's first real contact while in
		// keyboard mode is refused, exactly as any other pen contact would
		// be while pen input is off. Alan asks for that ONE contact to
		// be let in instead, which means `penOff()` has to already read
		// false by the time the claim decision two lines down runs it.
		//
		// GATED ON THE EDGE, and nothing else - not "a pen touched", but "a
		// pen touched and the latch was false until now". A device that has
		// ALREADY seen a pen and sits in keyboard mode on purpose is
		// UNTOUCHED: `deviceHasNeverSeenAPen()` already reads false for it,
		// so this branch is never reached and its keyboard mode stands
		// exactly as the user left it.
		//
		// ONE CHEAP FLIP, AND NOTHING ELSE, deliberately - the comment on the
		// pen-off check two blocks down is explicit that nothing may be
		// spent above it ("hand the contact back before anything is spent
		// on it... above this line only cancelFling() has run"), and a
		// synchronous strip rebuild is exactly the kind of spend that
		// warns against. `setPenInk(true)` is a single module-level boolean
		// (PenInk.ts) with NO listeners and NO DOM work of its own - it is
		// the one thing the claim decision three lines down actually reads,
		// so it is the only thing that has to happen this early.
		// `markPenHardwareSeen()` (PenToolsMode.ts) is DELIBERATELY NOT
		// called from here: it fires `markPenSeen()` -> `announce()`
		// synchronously, and `announce()`'s one production subscriber today
		// is `PdfInkController`'s `onPenToolsChanged(() => this.ensureTools())`
		// (InkOverlay.ts's registration), which builds or destroys an entire
		// PDF strip - precisely the DOM work that must not run in front of
		// this contact's first ink sample, and precisely what the comment
		// below warns against spending. The latch still flips: both
		// surfaces' own `markPenHardwareSeen()` calls (InkOverlay.ts's
		// `penDown`, PdfInkController.ts's `penDown`/`showCursor`) already
		// run moments later in this SAME synchronous call, from inside
		// `this.cb.onPenDown(...)` at the end of this method, once the claim
		// this flip just enabled has gone through - unchanged, exactly where
		// they already ran for every other pen contact. So the strip's
		// light catches up on the very same event, just after the claim
		// rather than before it; only the pen-input flip itself needed to
		// move earlier.
		if (e.pointerType === "pen" && deviceHasNeverSeenAPen() && this.penOff()) {
			setPenInk(true);
		}
		// PEN OFF on this surface: hand the contact back before anything is
		// spent on it. Above this line only `cancelFling()` has run, which any
		// new contact earns whoever it belongs to; below it every branch
		// claims - preventDefault, stopPropagation, setPointerCapture, the
		// standing guard, the end backstop. So the answer has to be given
		// here, and given by RETURNING rather than by suppressing: the tap
		// this refuses is a caret placement, and on a touch device the
		// keyboard that comes up with it is the entire feature (PenInk.ts).
		//
		// Reached by the linked-mentions band listener too, which calls this
		// method directly for an eraser-intent contact outside the scroller -
		// a backlink row is one more thing the pen should just click while it
		// is off.
		//
		// The addendum-3 branch just above runs first and, on its own edge,
		// turns `penOff()` false before this reads it - so THIS check still
		// reads the CURRENT state; it does not need its own carve-out.
		if (e.pointerType === "pen" && this.penOff()) {
			tr("pointerdown", e, "pen NOT CLAIMED: pen off on this surface");
			return;
		}
		// Mouse: never touched, unless mouse-ink mode is on - then the left
		// button is a pen tip and other buttons stay native.
		if (e.pointerType !== "pen") {
			if (!this.mouseMayStartOrHover(e) || (e.buttons & 1) === 0) return;
		}
		if (this.activePenId !== null) {
			// one pen at a time
			tr("pointerdown", e, `pen IGNORED: stroke ${this.activePenId} still active`);
			if (isHitProbeEnabled()) hitProbeDown(e, false, this.scrollEl);
			return;
		}
		// A PEN DOWN WITH THE BARREL BIT AND NO TIP OR ERASER IS A BUTTON PRESSED IN THE AIR (GitHub issue 41). Linux
		// reports the side button as a real button: pressed while the pen hovers it is a pointerdown with buttons 2 and pressure
		// 0, and the tip landing afterwards is a pointermove with buttons 3, never a second pointerdown. Claimed here
		// it started a lasso at pressure 0 that the next hover row ended as a silent lift, and the real contact then
		// found no pen claimed. So it claims nothing; the pointer is remembered, and the move that brings the tip down
		// is claimed in its place (pointerMove). Windows sends its side-button contact as this pointerdown, with pressure above 0; only the pressure-0 air press is held back here. A
		// pointerdown with no button bit at all is claimed as before.
		if (e.pointerType === "pen" && (e.buttons & 2) !== 0 && (e.buttons & 1) === 0 && (e.buttons & 32) === 0 && e.pressure === 0) {
			airPress.set(this, e.pointerId);
			tr("pointerdown", e, `pen NOT CLAIMED: button pressed in the air (buttons=${e.buttons}); the tip landing claims`);
			return;
		}

		// EVERY pen contact is a Handwriting gesture now: tip = ink, eraser end =
		// erase, side button held = lasso/manipulate (§52/§53, the interaction the
		// canvas settled). The overlay reads ev.buttons at pen-down to decide
		// which; the router's job is only to claim the contact before the
		// editor can turn it into selection or a context menu.
		const kind =
			(e.buttons & 32) !== 0 || e.button === 5 || (sideButtonErasesEnabled() && (e.buttons & 2) !== 0)
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
			this.rebasePinch();
			tr("guard", e, "pinch cancelled: pen claimed the surface");
		}
		// A swallowed contact still down when the pen lands is the hand that
		// follows the pen; it can never earn parole afterwards. Eraser
		// scrubbing lifts and re-lands the nib every few hundred ms with the
		// hand's edge sliding in between. Judged by motion alone, that slide
		// became an assist pan and walked the viewport (RC3).
		// In ANY pane: one hand writes across a split, so the palm resting in
		// the other pane is the same hand. And the pen cannot be down in two
		// panes: a stroke another pane still holds open stopped without any
		// lift reaching it, and is ended here, ink kept.
		for (const r of liveRouters) {
			if (r !== this) r.finishStrandedPenStroke();
			r.voidParoleOnPenDown(e);
		}
		this.gesturePanned = false;
		this.applyGuard(this.manip.penSignal(), "pen-down");
		e.preventDefault();
		e.stopPropagation();
		this.refreshRect();
		this.activePenId = e.pointerId;
		// Beside the id it is only ever read with, so the two cannot drift.
		this.activeIsPen = e.pointerType === "pen";
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
		// Ending a live pinch above may have created a new settle owner. Revoke
		// it before the first sample, retaining the pan it already painted.
		this.cb.onViewportInput?.();
		this.cb.onBeforePenDown?.();
		// GH-32: an offset-after-zoom report has client x,y only - no rect, no
		// scale, no pan, so a stale one of the three can't be told apart from
		// the others. One row, the same sample onPenDown gets, so this can
		// never drift from what actually inked.
		const s = this.sampleFrom(e);
		if (diagnosticsEnabled()) {
			const scale = this.scaleProvider();
			const pan = this.originPan?.();
			const panX = pan && Number.isFinite(pan.x) ? pan.x : 0;
			const panY = pan && Number.isFinite(pan.y) ? pan.y : 0;
			const offsetX = Number.isFinite(e.offsetX) ? e.offsetX : -1;
			const offsetY = Number.isFinite(e.offsetY) ? e.offsetY : -1;
			const tgt = e.target === this.rectEl ? 1 : 0;
			tr(
				"guard",
				e,
				`geo rect=(${this.rect.left.toFixed(3)},${this.rect.top.toFixed(3)})` +
					` scale=${scale.toFixed(3)} pan=(${panX.toFixed(3)},${panY.toFixed(3)})` +
					` offset=(${offsetX.toFixed(3)},${offsetY.toFixed(3)}) tgt=${tgt}` +
					` sample=(${s.x.toFixed(3)},${s.y.toFixed(3)})`
			);
		}
		this.cb.onPenDown(s, e);
	}

	/** Claim one eligible touch without impersonating pen hardware or its palm gate. */
	function claimFingerInk(this: InlinePenRouter, e: PointerEvent, down?: PenSample): void {
		this.strokeDownAt = performance.now();
		this.firstRawTraced = false;
		// The feed's floor is the down's time. A selection finger is claimed on a move (`down` is where it landed), and
		// that move feeds next: floored at its own time it would feed nothing, and the box would skip it.
		this.inkFeed.strokeStart(down ? down.timestamp : e.timeStamp);
		e.preventDefault();
		e.stopPropagation();
		this.refreshRect();
		this.activePenId = e.pointerId;
		this.activeIsPen = false;
		this.activeIsFinger = true;
		this.penDowns++;
		telemetry.bump("inline.fingerDown");
		this.armEndBackstop();
		try {
			this.scrollEl.setPointerCapture(e.pointerId);
		} catch {
			/* best-effort; the window backstop covers a failed capture */
		}
		this.mouseStrokeTrail = null;
		// Ending a live pinch above may have created a new settle owner. Revoke
		// it before the first sample, retaining the pan it already painted.
		this.cb.onViewportInput?.();
		this.cb.onBeforePenDown?.();
		this.cb.onPenDown(down ?? this.sampleFrom(e), e);
	}

	/** Cancel, never commit, the one-finger preview before pinch owns the gesture. */
	function cancelFingerInkForPinch(this: InlinePenRouter): void {
		if (this.activePenId === null || !this.activeIsFinger) return;
		const pointerId = this.activePenId;
		this.activePenId = null;
		this.activeIsFinger = false;
		this.fingerInkBlockedUntilAllLift = true;
		try {
			this.scrollEl.releasePointerCapture(pointerId);
		} catch {
			/* best-effort; the gesture is already unowned */
		}
		this.disarmEndBackstop();
		this.inkFeed.strokeEnd();
		this.mouseStrokeTrail = null;
		this.cb.onFingerInkCancelled?.();
	}

	/** Commit a non-pinch finger stroke before a real pen takes ownership. */
	function commitFingerInkForPenPreemption(this: InlinePenRouter): void {
		if (this.activePenId === null || !this.activeIsFinger) return;
		const pointerId = this.activePenId;
		// Null before release: lostpointercapture must not finish this twice.
		this.activePenId = null;
		this.activeIsFinger = false;
		try {
			this.scrollEl.releasePointerCapture(pointerId);
		} catch {
			/* best-effort; the incoming pen is about to own capture */
		}
		this.penUps++;
		telemetry.bump("inline.fingerUp.penPreempted");
		this.disarmEndBackstop();
		this.inkFeed.strokeEnd();
		this.mouseStrokeTrail = null;
		this.touchesAtStrokeStart.clear();
		hideProbeMarkers();
		// No event: the incoming pen event is not the finger's lift and must
		// not be mistaken for one by the surface's reticle restoration.
		this.cb.onPenUp();
	}

	/**
	 * Hover with no active stroke, throttled: one line per 150 ms OR whenever
	 * `buttons` changes. `buttons !== 0` while hovering means the digitizer
	 * reports the nib PRESSED yet no pointerdown arrived, the smoking gun the
	 * summary counts as a pressed-but-undelivered sample.
	 */
	function traceHover(this: InlinePenRouter, e: PointerEvent): void {
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

	function pointerMove(this: InlinePenRouter, e: PointerEvent): void {
		const ownedFinger =
			e.pointerType === "touch" && this.activeIsFinger && e.pointerId === this.activePenId;
		if (ownedFinger && this.touchPos.has(e.pointerId)) {
			this.touchPos.set(e.pointerId, { x: e.clientX, y: e.clientY });
		}
		// A real mouse entering while the pen remains nearby gets the ordinary
		// editor cursor. The same-point compatibility move Windows emits right
		// after pen hover is still the pen and must not flash the I-beam.
		if (
			e.pointerType === "mouse" &&
			!this.mouseMayStartOrHover(e) &&
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
		if (e.pointerType === "touch" && !ownedFinger) {
			this.lastTouchAt = performance.now();
			scrollProbeTouch();
			// A finger waiting on the selection: inside the tap limit nothing moves; past it the selection claims the
			// contact from where it landed, and this move is its first.
			const waiting = selectionTouches.get(this);
			if (waiting?.pointerId === e.pointerId) {
				this.touchPos.set(e.pointerId, { x: e.clientX, y: e.clientY });
				if (Math.hypot(e.clientX - waiting.x, e.clientY - waiting.y) <= TAP_MAX_MOVE_PX) return;
				selectionTouches.delete(this);
				// Asked again at the claim: a pen that landed during the wait owns the contact, and a selection gone since the
				// down has nothing to take. Either way the finger is a palm's to the lift: no claim, no ink, no pan.
				if (this.activePenId !== null || this.fingerInkBlockedUntilAllLift || !(this.cb.claimTouch?.(waiting.down) ?? false)) {
					this.swallowedTouches.add(e.pointerId);
					tr("pointermove", e, "touch on the selection passed the tap limit: the pen or the selection went, swallowed");
					e.preventDefault();
					e.stopPropagation();
					return;
				}
				tr("pointermove", e, "touch on the selection passed the tap limit: claimed");
				this.claimFingerInk(e, waiting.down);
				this.pointerMove(e);
				return;
			}
			if (this.swallowedTouches.has(e.pointerId)) {
				if (
					e.pointerId === this.paroleId &&
					paroleEarned({
						travelPx:
							Math.abs(e.clientX - this.paroleDownX) +
							Math.abs(e.clientY - this.paroleDownY),
						sinceDownMs: performance.now() - this.paroleDownAt,
						penStrokeActive: this.anyPenStrokeActive(),
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
					this.carryScrollBy(e.clientX - this.paroleDownX, e.clientY - this.paroleDownY);
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
			if (this.fingerInkBlockedUntilAllLift && this.guardTouches.has(e.pointerId)) {
				e.preventDefault();
				e.stopPropagation();
				return;
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
		if (!ownedFinger && e.pointerType !== "pen" && !this.ownedMouseStroke(e) && !this.mouseMayStartOrHover(e)) return;
		if (this.activePenId === null) {
			// PEN OFF: a hovering pen is not our pen. Everything below this
			// line is preparation for a claim that is never coming - the palm
			// gate's "pen near" window, the standing guard's pen signal, and
			// the reticle the surface paints from `onPenHover` - and each of
			// them costs the user something while the pen is off. The gate is
			// the sharpest: it blocks NEW touch contacts while a pen is near
			// the glass, so a Boox user resting the pen an inch above the
			// screen could not tap at all. The reticle is the other half of
			// step 5 - no hover call, no ring, on desktop and Surface alike.
			//
			// Only here, where no stroke is live. A claimed stroke runs to its
			// own lift; see `InlinePenCallbacks.penOff`.
			if (e.pointerType === "pen" && this.penOff()) return;
			// The tip landing after a button pressed in the air (GitHub issue 41, see pointerDown): the same pointer,
			// the tip bit set and pressure above 0. This row is the contact, claimed as a pointerdown would be, so the
			// overlay reads its buttons (3: the side button held) and starts the lasso. Only after that air press, so
			// a hover row that reports the tip pressed with no pointerdown at all is still not claimed.
			if (e.pointerType === "pen" && airPress.get(this) === e.pointerId && e.pressure > 0) {
				tr(e.type, e, "pen contact after a button pressed in the air: claimed on this row");
				this.pointerDown(e);
				return;
			}
			// Hovering keeps the palm gate warm ("palm placed before pen") and
			// re-arms the standing guard instantly if a touch window was open.
			this.lastPenHoverAt = performance.now();
			// A PEN, and not the armed mouse this branch also accepts. See the
			// field, and `handOnGlass` for what the stamp answers.
			if (e.pointerType === "pen") this.penHoverAt = this.lastPenHoverAt;
			this.lastPenHoverX = e.clientX;
			this.lastPenHoverY = e.clientY;
			// A PEN warms the palm gate, and not the armed mouse this branch
			// also accepts: `blocksNewTouch` reads this stamp before it
			// swallows the next finger, and a mouse moving on a desk with no
			// pen in the room must not turn that finger into a palm. Same test
			// as the `penHoverAt` stamp above, for the same reason.
			if (e.pointerType === "pen") this.gate.penHoverSeen(performance.now());
			// A PEN re-arms the standing guard, and not the armed mouse either.
			// The guard's touch-action: none exists so a cold pen contact meets
			// a committed opt-out and inks instead of panning; a mouse is not
			// subject to touch-action at all, so signalling from its hover
			// bought the mouse nothing and shut the touch window a finger pan
			// had just opened. Same test as the two stamps above.
			if (e.pointerType === "pen") this.applyGuard(this.manip.penSignal(), "pen-hover");
			this.traceHover(e);
			// Side button pressed and released in the air: pen <-> eraser on
			// Android (SideButtonAir.ts). Below the pen-off return, so a pen
			// that is off switches nothing.
			{
				const click = sideButtonAirHover(e.pointerType, e.buttons, e.pressure, e.timeStamp);
				if (click !== null) tr("pen-hover", e, click);
			}
			if (isHitProbeEnabled()) hitProbeHover(e);
			this.cb.onPenHover(this.sampleFrom(e), e.pointerType);
			return;
		}
		if (e.pointerId !== this.activePenId) return;
		if (silentLift(e)) {
			this.feedBeforeSilentLift(e);
			this.silentLiftEnds++;
			telemetry.bump("inline.penUp.silentLift");
			tr(e.type, e, "SILENT LIFT, TERMINATES STROKE", undefined, "lifecycle", "silent-lift");
			// A lift with the side button still held (Linux, GitHub issue 41): the button stays down in the air, so the
			// next landing is a move row with buttons 3 and no pointerdown, claimed as after a press in the air. The
			// pointerup that releases the button forgets it.
			if (e.pointerType === "pen" && (e.buttons & 2) !== 0) airPress.set(this, e.pointerId);
			this.endPenStroke(e, false);
			return;
		}
		e.preventDefault();
		e.stopPropagation(); // no link-hover popovers under a moving nib
		telemetry.bump("inline.penMove");
		// iOS port: WebKit never fires pointerrawupdate, so while no pen raw
		// has arrived this stroke the move stream carries the ink, expanded
		// from its coalesced list (up to 4 samples per move on the iPad that
		// proved this out; hardware report 2026-08-25). On Chromium the raw
		// listener is new at every claim and its stream starts a few ms
		// later, so the first moves of each stroke feed here until that
		// stroke's first raw retires the branch (InkFeed.ts). Same downstream
		// contract as the raw path: onPenRaw feeds StrokeBuilder, the tools,
		// the wet layer, all of it.
		// Finger ink is intentionally move-capable even if a real pen proved
		// this browser's raw channel earlier in the session. WebKit may expose
		// raw for Pencil but only moves for a direct touch; the arbiter's
		// timestamp floor still deduplicates a raw/move overlap when both arrive.
		if (ownedFinger || this.inkFeed.moveFeedsInk()) {
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
				tr("pointermove", e, `move-fed coalesced=${events.length}`, csOf(events), "sample");
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
					, undefined, "annotation"
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
			tr("pointermove", e, `coalesced=${n}`, coalesced.length > 0 ? csOf(coalesced) : undefined, "sample");
			this.cb.onPenMove(e, n);
		} else {
			this.cb.onPenMove(e, 1);
		}
	}

	function pointerRawUpdate(this: InlinePenRouter, e: PointerEvent): void {
		const ownedFinger =
			e.pointerType === "touch" && this.activeIsFinger && e.pointerId === this.activePenId;
		if (!ownedFinger && e.pointerType !== "pen" && !this.ownedMouseStroke(e) && !this.mouseMayStartOrHover(e)) return;
		// A PEN/MOUSE raw in a stroke moves that stroke's ink to the raw stream
		// and keeps its move handler out of the ink business. A direct touch
		// does not impersonate that hardware capability: finger strokes remain
		// move-capable even when their engine also emits raw events.
		if (!ownedFinger) this.inkFeed.noteRawChannel();
		if (this.activePenId === null) {
			// No stroke: the raw listener is bound only from a claim to its end
			// (InlinePenRouter.bindRawListener), so a raw lands here only in the
			// gap between a claim and the router taking the pointer, or from a
			// listener a test binds by hand. Hover bookkeeping lives on
			// `pointermove`; this keeps the same steps for that gap. PEN OFF:
			// the raw stream's half of the hover gate above.
			if (e.pointerType === "pen" && this.penOff()) return;
			this.lastPenHoverAt = performance.now();
			// The raw stream's half of the pen-only stamp; same rule, same
			// reason (see the move handler above and `handOnGlass`).
			if (e.pointerType === "pen") this.penHoverAt = this.lastPenHoverAt;
			// The raw stream's half of the pen-only gate warm; same rule, same
			// reason (see the move handler above).
			if (e.pointerType === "pen") this.gate.penHoverSeen(performance.now());
			// The raw stream's half of the pen-only guard signal; same rule,
			// same reason (see the move handler above).
			if (e.pointerType === "pen") this.applyGuard(this.manip.penSignal(), "pen-hover");
			this.traceHover(e);
			// The raw stream's half of the side button in the air; the same
			// release seen on both streams switches once.
			{
				const click = sideButtonAirHover(e.pointerType, e.buttons, e.pressure, e.timeStamp);
				if (click !== null) tr("pen-hover", e, click);
			}
			return;
		}
		if (e.pointerId !== this.activePenId) return;
		if (silentLift(e)) {
			this.feedBeforeSilentLift(e);
			this.silentLiftEnds++;
			telemetry.bump("inline.penUp.silentLift");
			tr(e.type, e, "SILENT LIFT, TERMINATES STROKE", undefined, "lifecycle", "silent-lift");
			// The raw stream's half of the lift with the side button still held (see the move handler above). On
			// Chromium the raw copy of a row comes first and ends the stroke here, so the move copy never reaches its line.
			if (e.pointerType === "pen" && (e.buttons & 2) !== 0) airPress.set(this, e.pointerId);
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
			tr("pointerrawupdate", e, `coalesced=${events.length}`, csOf(events), "sample");
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

	/** Keep earlier contact samples when a coalesced delivery ends in hover. */
	function feedBeforeSilentLift(this: InlinePenRouter, e: PointerEvent): void {
		if (e.pointerType !== "pen" || typeof e.getCoalescedEvents !== "function") return;
		const events = e.getCoalescedEvents().filter((ce) =>
			ce.pointerType === "pen" && ce.pointerId === this.activePenId &&
			ce.timeStamp <= e.timeStamp && !silentLift(ce)
		);
		// Raw and move can deliver the same batch. Use the stroke's existing
		// timestamp floor so already-fed points never enter the builder twice.
		const fed = this.inkFeed.feed(events.map((ce) => ce.timeStamp));
		const samples: PenSample[] = [];
		let lastContact: PointerEvent | undefined;
		for (const i of fed) {
			const ce = events[i];
			if (ce !== undefined) {
				samples.push(this.sampleFrom(ce));
				lastContact = ce;
			}
		}
		if (diagnosticsEnabled() && samples.length > 0) {
			tr(e.type, e, `pre-lift INK-FED ${samples.length} sample(s)`, csOf(events), "sample");
		}
		// Pan consumes client coordinates from the callback event, not samples.
		// Movement ends at contact; the caller still finalizes with the lift event.
		if (lastContact !== undefined) this.cb.onPenRaw(samples, lastContact);
	}

	/** Mouse samples through the grid filter; a pen's untouched. */
	function smoothed(this: InlinePenRouter, samples: PenSample[]): PenSample[] {
		const trail = this.mouseStrokeTrail;
		return trail === null ? samples : samples.map((sample) => trail.push(sample));
	}

	// ---- stroke end ---------------------------------------------------------

	function pointerUpOrCancel(this: InlinePenRouter, e: PointerEvent): void {
		if (e.pointerType === "touch") {
			if (selectionTouches.get(this)?.pointerId === e.pointerId) selectionTouches.delete(this);
			const blockedFingerGesture = this.fingerInkBlockedUntilAllLift;
			const ownedFinger = this.activeIsFinger && e.pointerId === this.activePenId;
			if (ownedFinger) this.endPenStroke(e, false);
			if (this.swallowedTouches.delete(e.pointerId)) {
				if (this.paroleId === e.pointerId) {
					this.paroleId = null;
					this.paroleOverlapped = false;
				}
				e.preventDefault();
				e.stopPropagation();
				this.finishFingerInkPreparation();
				this.resumeEaseIfIdle();
				return;
			}
			// Read BEFORE endPinch clears it: whether this lift genuinely ended a live pinch, not merely
			// whether this pointerId happened to be in touchPos (a lone tap sits there too).
			const endedLivePinch = this.touchPos.has(e.pointerId) && this.pinchLive;
			if (this.touchPos.has(e.pointerId)) {
				// Read the centroid while BOTH contacts are still in touchPos -
				// deleting first (the old order) left only the remaining
				// contact, so pinchCentroid() always reported {0,0} for an
				// ordinary pinch end (audit-fixes-design.md 5i I2).
				const centroid = this.pinchCentroid();
				this.touchPos.delete(e.pointerId);
				this.endPinch(e, centroid);
				// Two left after three: a new pair, or the old one after a stray contact.
				this.rebasePinch();
			}
			const wasAssistPan = this.endAssist(e);
			const duringStroke =
				ownedFinger || (this.activePenId !== null && this.guardTouches.has(e.pointerId));
			// Read before the lift below resets it: whether this gesture scrolled at any point.
			const panned = this.gesturePanned || wasAssistPan;
			const start = tapStarts.get(this)?.get(e.pointerId);
			tapStarts.get(this)?.delete(e.pointerId);
			if (this.guardTouches.delete(e.pointerId)) {
				// `panned` = this gesture really scrolled (assist engaged at any
				// point). Only then does the native touch window open on the
				// last lift; taps and resting palms leave the guard armed.
				// A LIFT AGAINST AN END DOES NOT OPEN THE NATIVE WINDOW. The window hands the next finger to the
				// browser; against an end the browser has nothing to scroll and cancels that finger a few px in
				// (pointercancel -> retireAllContactsOnNativeEnd -> the pull released), which is the give "letting go
				// immediately" on Alan's device at the top, the left and the corner. touch-action is read by the
				// browser at the touch's start, so the guard has to be armed BEFORE that finger lands: re-arm now.
				// A native touch's lift gets its own row: each one inside the window schedules the re-arm again.
				if (this.manip.current === "touch-open") tr("guard", e, `touch lift inside the native window (${e.type})`);
				let lift = this.manip.touchEnd(this.gesturePanned || wasAssistPan);
				if (lift.scheduleRearm && this.liftAgainstAnEnd()) lift = this.manip.rearm();
				this.applyGuard(lift, "touch-end");
				if (this.guardTouches.size === 0) {
					this.gesturePanned = false;
					this.fingerInkBlockedUntilAllLift = false;
				}
			}
			this.finishFingerInkPreparation();
			// Every contact is gone AND this lift was not itself a pinch, an assist pan or a stroke -
			// a tap or a resting palm, the only contacts that can cancel a playing ease (onViewportInput,
			// pointerDown) without owning anything to replace it with. A real gesture's own settle already
			// starts its own bounce synchronously inside endPinch/endAssist above, so excluding those here
			// (rather than trusting the overlay's bounceState no-op alone) keeps this from racing the very
			// first frame of that settle's own ease - measured: THE BOUNCE's commit-frame step widened past
			// its 9.5px bound (10.37) when this fired unconditionally on the pinch's own last-finger lift.
			if (!endedLivePinch && !wasAssistPan && !duringStroke && this.touchPos.size === 0 && this.guardTouches.size === 0) {
				this.cb.onAllContactsLifted?.();
			}
			// A TAP: one finger, down and up near the same place and soon, with no pan, pinch, stroke or palm in it.
			// The surface decides what a tap does (the note: select the attached ink it landed on, else let go of an ink
			// selection it landed off). A tap it took is kept from the text: this lift and its fallout.
			if (
				e.type === "pointerup" && start !== undefined && !start.caught && !panned && !endedLivePinch && !duringStroke &&
				!blockedFingerGesture && this.touchPos.size === 0 && this.guardTouches.size === 0 &&
				Math.hypot(e.clientX - start.x, e.clientY - start.y) <= TAP_MAX_MOVE_PX &&
				e.timeStamp - start.at <= TAP_MAX_MS
			) {
				if (this.cb.onTapLift?.(this.sampleFrom(e), e) === true) {
					e.preventDefault();
					e.stopPropagation();
					eatTapFallout(this, e);
				}
			}
			if (wasAssistPan || duringStroke || blockedFingerGesture) {
				// The pan already happened (or a palm is lifting mid-stroke);
				// keep the trailing tap machinery off the editor, matching a
				// native pan's cancel semantics.
				e.preventDefault();
				e.stopPropagation();
			}
			return;
		}
		if (e.pointerType !== "pen" && !this.ownedMouseStroke(e)) {
			this.resumeEaseIfIdle();
			return;
		}
		// The button pressed in the air is released: the next landing is an ordinary contact again.
		if (e.pointerType === "pen" && airPress.get(this) === e.pointerId) airPress.delete(this);
		const wasOurs = this.activePenId !== null && e.pointerId === this.activePenId;
		tr(e.type, e, wasOurs ? "TERMINATES STROKE" : "");
		if (wasOurs) {
			e.preventDefault();
			e.stopPropagation();
		}
		this.endPenStroke(e, false);
		if (!wasOurs) this.resumeEaseIfIdle();
	}

	/**
	 * A contact that owned nothing has ended: give back the ease its
	 * pointerDown cancelled (`onViewportInput`). The touch lift path already
	 * does this for a tap; a mouse click, a pen tap with the pen off and a palm
	 * the gate swallowed end elsewhere and left the edge ease frozen. Only when
	 * nothing else is down, so a contact still owning a stroke or a gesture
	 * keeps the ease off until its own end.
	 */
	function resumeEaseIfIdle(this: InlinePenRouter): void {
		if (
			this.activePenId !== null ||
			this.touchPos.size > 0 ||
			this.guardTouches.size > 0 ||
			this.swallowedTouches.size > 0
		) {
			return;
		}
		this.cb.onAllContactsLifted?.();
	}

	/** Idempotent single funnel, same as the canvas router. */
	function endPenStroke(this: InlinePenRouter, e: PointerEvent, viaFallback: boolean): void {
		if (this.activePenId === null || e.pointerId !== this.activePenId) return;
		const wasFinger = this.activeIsFinger;
		this.activePenId = null;
		this.activeIsFinger = false;
		this.penUps++;
		telemetry.bump("inline.penUp");
		if (viaFallback) {
			this.fallbackEnds++;
			telemetry.bump("inline.penUp.backstop");
			tr(e.type, e, "END VIA WINDOW BACKSTOP");
		}
		this.disarmEndBackstop();
		this.inkFeed.strokeEnd();
		if (!wasFinger) this.gate.penStrokeEnded(performance.now());
		this.touchesAtStrokeStart.clear();
		if (wasFinger) this.retireEndedFingerContact(e.pointerId);
		// Standing guard: no release. Armed IS the resting state.
		hideProbeMarkers();
		// Trailing click/auxclick/contextmenu from this contact land AFTER
		// pointerup, so the ownership guard stays up through the tail.
		if (!wasFinger) this.scheduleOwnershipDisarm();
		this.cb.onPenUp(e);
		this.finishFingerInkPreparation();
	}

	/**
	 * Every contact goes at once, because the browser says none are left.
	 *
	 * The helpers around this one each retire ONE contact, keyed by pointer
	 * id, off the pointer stream. Nothing retired a contact on the browser's
	 * word, and pointer ids are never reconciled with `Touch.identifier`, so a
	 * contact whose `pointerup` never arrived - the selection UI or the OS
	 * swallowed it - stayed in `touchPos` for the rest of the session: the next
	 * single finger made the size 2, which is the pinch trigger, and one finger
	 * zoomed the note (iPad: long-press to select, then one finger down).
	 *
	 * `liveTouchIds` is deliberately not touched here. It mirrors the native
	 * stream and the branch that calls this has already maintained it.
	 */
	function retireAllContactsOnNativeEnd(this: InlinePenRouter): void {
		selectionTouches.delete(this);
		if (this.pinchLive) {
			// Read the centroid while the contacts are still there, the same
			// order the release path uses (audit-fixes-design.md 5i I2).
			const centroid = this.pinchCentroid();
			this.endPinch(null, centroid);
		}
		// The assist stands down without a fling: this is a recovery, not a
		// release the writer made, and there is no velocity to honour.
		this.assistPointerId = null;
		this.assistEngaged = false;
		this.assistSamples = [];
		this.releaseOverscrollPull();
		// Every finger contact we still hold, including a paroled touch that
		// lives in guardTouches only, and the finger of a live ink stroke. A
		// real lift sends its pointerup before this touchend, and the stroke's
		// end has retired that finger already; it is still here only when its
		// lift was lost, and an entry left in touchPos then is the one-finger
		// pinch above. Retiring an id twice changes nothing.
		for (const id of new Set([...this.touchPos.keys(), ...this.guardTouches])) {
			this.retireEndedFingerContact(id);
		}
		this.pinchStartSpread = 0;
		this.paroleId = null;
		this.paroleOverlapped = false;
	}

	/**
	 * Balance the touch maps when capture/window ends a finger without the
	 * scroller's normal touch-up tail. Normal pointer-up reaches this same
	 * helper first and therefore cannot double-decrement the guard afterward.
	 */
	function retireEndedFingerContact(this: InlinePenRouter, pointerId: number): void {
		this.touchPos.delete(pointerId);
		if (!this.guardTouches.delete(pointerId)) return;
		this.applyGuard(this.manip.touchEnd(this.gesturePanned), "finger-ink-end");
		if (this.guardTouches.size === 0) {
			this.gesturePanned = false;
			this.fingerInkBlockedUntilAllLift = false;
		}
	}

	/** Armed only while a stroke is active, not a standing document listener. */
	function armEndBackstop(this: InlinePenRouter): void {
		this.disarmEndBackstop();
		const fn = (ev: Event) => {
			const pe = ev as PointerEvent;
			const path = typeof pe.composedPath === "function" ? pe.composedPath() : [];
			const fingerMayEnd =
				this.activeIsFinger &&
				pe.pointerType === "touch" &&
				pe.pointerId === this.activePenId &&
				!path.includes(this.scrollEl);
			if (
				!fingerMayEnd &&
				!backstopMayEnd({ pointerType: pe.pointerType, scrollerInPath: path.includes(this.scrollEl) })
			) {
				if (pe.pointerType === "pen" && this.activePenId !== null) {
					tr(`window-${pe.type}`, pe, "backstop stood down: scroller in path, normal handler ends it");
				}
				return;
			}
			if (fingerMayEnd) {
				pe.preventDefault();
				pe.stopPropagation();
			}
			this.endPenStroke(pe, true);
		};
		this.winEndFn = fn;
		this.winRef.addEventListener("pointerup", fn, { capture: true });
		this.winRef.addEventListener("pointercancel", fn, { capture: true });
	}

	function disarmEndBackstop(this: InlinePenRouter): void {
		if (!this.winEndFn) return;
		this.winRef.removeEventListener("pointerup", this.winEndFn, { capture: true });
		this.winRef.removeEventListener("pointercancel", this.winEndFn, { capture: true });
		this.winEndFn = null;
	}

export function installInlinePenRouterInput(proto: InlinePenRouter): void {
	installMethods(proto, {
		pointerDown,
		claimFingerInk,
		cancelFingerInkForPinch,
		commitFingerInkForPenPreemption,
		traceHover,
		pointerMove,
		pointerRawUpdate,
		feedBeforeSilentLift,
		smoothed,
		pointerUpOrCancel,
		resumeEaseIfIdle,
		endPenStroke,
		retireAllContactsOnNativeEnd,
		retireEndedFingerContact,
		armEndBackstop,
		disarmEndBackstop,
	});
}
