/**
 * The pen router's navigation: the pinch, the finger-ink preparation, the assist pan and the fling with its overscroll pull.
 * They are methods of InlinePenRouter, installed on its prototype when InlinePenRouter.ts loads.
 */
import { noteToVisual, visualToNote } from "./ZoomScale";
import { flingStep, releaseVelocity } from "../input/Fling";
import { carryFrom, carryPinned, carryStep, scrollGrid } from "./AssistScroll";
import { pinchEngaged, pinchMidpoint, pinchRatio, pinchSpread } from "./PinchScale";
import { tr } from "./InlinePenRouterTrace";
import { installMethods } from "./InstallMethods";
import type { InlinePenRouter } from "./InlinePenRouter";

declare module "./InlinePenRouter" {
	interface InlinePenRouter {
		beginPinch(e: PointerEvent): void;
		pinchCentroid(): { x: number; y: number };
		rebasePinch(): void;
		updatePinch(e: PointerEvent): boolean;
		endPinch(e: PointerEvent | null, centroid?: { x: number; y: number }): void;
		prepareFingerInk(): void;
		fingerInkContactActive(): boolean;
		finishFingerInkPreparation(): void;
		setCanvasMomentumDisabled(on: boolean): void;
		beginAssist(e: PointerEvent): void;
		yieldAssistToHost(pointerId: number): void;
		cameraTransformChanged(): void;
		assistMove(e: PointerEvent): boolean;
		endAssist(e: PointerEvent): boolean;
		startFling(vx: number, vy: number): void;
		carryScrollBy(dx: number, dy: number): ReturnType<typeof carryScrollBy>;
		accrueOverscrollPull(refusedNoteX: number, refusedNoteY: number, scale: number): void;
		releaseOverscrollPull(): void;
		liftAgainstAnEnd(): boolean;
		dragBeginsAgainstAnEnd(): boolean;
		cancelFling(): void;
	}
}

/** The glide's decay in canvas mode, shorter than Fling.ts's default so the open room is not crossed in one flick. */
const CANVAS_FLING_TAU_MS = 200;

/** Finger movement before the assist pan engages (native slop analog). */
const ASSIST_SLOP_PX = 8;


	/** The transition gesture: 1:1 pan while Chromium's snapshot said none. */
	// ---- pinch (tier 1: two fingers, pen away) ------------------------------

	/**
	 * A second non-palm finger turns the gesture into a pinch. The assist pan
	 * is dropped without a fling: the note must not coast while it resizes.
	 */
	function beginPinch(this: InlinePenRouter, e: PointerEvent): void {
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
		this.pinchFocal = pinchMidpoint(pts[0]!, pts[1]!);
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

	/**
	 * Midpoint of the two live contacts, in client px. With any other count
	 * down (a third contact, or one left) it is the last midpoint the pair had.
	 */
	function pinchCentroid(this: InlinePenRouter): { x: number; y: number } {
		const pts = [...this.touchPos.values()];
		if (pts.length === 2) this.pinchFocal = pinchMidpoint(pts[0]!, pts[1]!);
		return { ...this.pinchFocal };
	}

	/**
	 * Measure the next pinch from the pair down NOW. Run after a pinch ends and
	 * after a lift; does nothing while a pinch is live (its ratio is relative to
	 * the spread its "start" was sent at) or unless exactly two contacts are
	 * down. Without it a pinch that re-engages measures from a spread an
	 * earlier pair had - after a stray third contact, a pen tap, or one finger
	 * of the pair lifting under a third - and the note zooms by that stale
	 * ratio on the next move.
	 */
	function rebasePinch(this: InlinePenRouter): void {
		if (this.pinchLive || this.touchPos.size !== 2) return;
		const pts = [...this.touchPos.values()];
		this.pinchStartSpread = pinchSpread(pts[0]!, pts[1]!);
		this.pinchFocal = pinchMidpoint(pts[0]!, pts[1]!);
	}

	/** Returns true when the pinch owned this move. */
	function updatePinch(this: InlinePenRouter, e: PointerEvent): boolean {
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
	 * `pinchCentroid()` here would see one touch (it reported {0,0}; it now
	 * falls back to the pair's last midpoint)
	 * (audit-fixes-design.md 5i I2). Callers that still have both contacts
	 * live when they call this (none do today) can omit it.
	 */
	function endPinch(this: InlinePenRouter, e: PointerEvent | null, centroid?: { x: number; y: number }): void {
		if (!this.pinchLive) return;
		this.pinchLive = false;
		this.cb.onPinch("end", 1, centroid ?? this.pinchCentroid());
		tr("guard", e, "pinch released");
	}

	/**
	 * Close a native-touch window when the toolbar explicitly enters iPhone
	 * finger ink. The compositor decides whether the next contact may pan from
	 * touch-action before it dispatches pointerdown, so the ordinary claim path
	 * is necessarily too late to make this transition itself.
	 */
	function prepareFingerInk(this: InlinePenRouter): void {
		if (!(this.cb.fingerInk?.() ?? false)) {
			this.fingerInkPreparationPending = false;
			return;
		}
		// Do not rewrite the guard underneath another contact. Remember the
		// entry instead; pointer and native-touch streams retire independently.
		if (this.fingerInkContactActive()) {
			this.fingerInkPreparationPending = true;
			return;
		}
		this.fingerInkPreparationPending = false;
		this.cancelFling();
		this.gesturePanned = false;
		this.applyGuard(this.manip.penSignal(), "finger-ink-selected");
	}

	function fingerInkContactActive(this: InlinePenRouter): boolean {
		return (
			this.activePenId !== null ||
			this.guardTouches.size > 0 ||
			this.swallowedTouches.size > 0 ||
			this.liveTouchIds.size > 0
		);
	}

	/** Apply a deferred entry only after both browser input streams are quiet. */
	function finishFingerInkPreparation(this: InlinePenRouter): void {
		if (!this.fingerInkPreparationPending || this.fingerInkContactActive()) return;
		if (!(this.cb.fingerInk?.() ?? false)) {
			this.fingerInkPreparationPending = false;
			return;
		}
		this.fingerInkPreparationPending = false;
		this.cancelFling();
		this.gesturePanned = false;
		this.applyGuard(this.manip.penSignal(), "finger-ink-selected-after-touch");
	}

	/**
	 * Inline-note policy: own the touch pan from contact start. This used to refuse the
	 * release glide as well, so a canvas flick stopped dead at the lift. Owning the pan and gliding
	 * after it are separate things - the assist carries both - so the glide now runs in either mode
	 * and only the ownership follows this flag.
	 */
	function setCanvasMomentumDisabled(this: InlinePenRouter, on: boolean): void {
		if (on === this.canvasMomentumDisabled) return;
		if (on) this.captureRootTouchAction();
		this.canvasMomentumDisabled = on;
		this.scrollEl.classList.toggle("handwriting-no-momentum", on);
		this.syncRootTouchAction();
		if (on) {
			this.cancelFling();
			// Request an immediate stop of any native scroll animation already running.
			// New touch gestures cannot acquire native pan under touch-action:none.
			this.scrollEl.scrollTo({ left: this.scrollEl.scrollLeft, top: this.scrollEl.scrollTop, behavior: "instant" });
		}
	}

	function beginAssist(this: InlinePenRouter, e: PointerEvent): void {
		this.cb.onViewportInput?.();
		this.cancelFling(); // a new finger takes over the glide
		this.assistSamples = [];
		this.assistPointerId = e.pointerId;
		this.assistLastX = e.clientX;
		this.assistLastY = e.clientY;
		this.assistMoved = 0;
		this.assistEngaged = false;
		// A new gesture starts from where the scroller settled, never from the
		// previous gesture's carried target.
		this.scrollCarryX = null;
		this.scrollCarryY = null;
	}

	/**
	 * A second finger landed with the zoom off while `pointerId` was assist-panning. End
	 * the pan now: no glide, the pointer released, the guard told the way a lift tells it, and the
	 * contact forgotten, so finger one's later moves and its lift are the host's and write nothing.
	 */
	function yieldAssistToHost(this: InlinePenRouter, pointerId: number): void {
		this.releaseOverscrollPull();
		this.cancelFling();
		this.assistPointerId = null;
		this.assistEngaged = false;
		this.assistSamples = [];
		try {
			this.scrollEl.releasePointerCapture(pointerId);
		} catch {
			/* best-effort */
		}
		this.touchPos.delete(pointerId);
		if (this.guardTouches.delete(pointerId)) {
			this.applyGuard(this.manip.touchEnd(true), "second finger: gesture to host");
			if (this.guardTouches.size === 0) {
				this.gesturePanned = false;
				this.fingerInkBlockedUntilAllLift = false;
			}
		}
		tr("guard", null, "assist pan ended: second finger, gesture to host");
	}

	/** A new camera frame ends old screen-space momentum and touch run-up. */
	function cameraTransformChanged(this: InlinePenRouter): void {
		this.cancelFling();
		this.assistPointerId = null;
		this.assistEngaged = false;
		this.assistSamples = [];
		this.paroleId = null;
		this.scrollCarryX = null;
		this.scrollCarryY = null;
	}

	function assistMove(this: InlinePenRouter, e: PointerEvent): boolean {
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
			this.carryScrollBy(dx, dy);
			const now = performance.now();
			this.assistSamples.push({ t: now, x: e.clientX, y: e.clientY });
			if (this.assistSamples.length > 12) this.assistSamples.shift();
			return true;
		}
		return false;
	}

	function endAssist(this: InlinePenRouter, e: PointerEvent): boolean {
		if (e.pointerId !== this.assistPointerId) return false;
		// The hand is off the glass: any give it was holding eases back from here.
		this.releaseOverscrollPull();
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
	function startFling(this: InlinePenRouter, vx: number, vy: number): void {
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
			// THE CANVAS GLIDE IS SHORTER. Travel is v0 * tau, so 200 ms against the default 325
			// carries a hard flick about 1600 px instead of about 2600 - the room is open there and the
			// default sails across it. Canvas off keeps the shipped glide. Alan tunes the number on the device.
			const s = flingStep(this.flingVx, this.flingVy, now - this.flingLastT,
				this.canvasMomentumDisabled ? CANVAS_FLING_TAU_MS : undefined);
			this.flingLastT = now;
			this.flingVx = s.vx;
			this.flingVy = s.vy;
			const w = this.carryScrollBy(s.dx, s.dy);
			const xPinned = carryPinned(w.x, w.left, w.grid), yPinned = carryPinned(w.y, w.top, w.grid);
			// THE GLIDE ENDS AT THE END IT HITS. Every real flick carries a small residual across its
			// own direction, and that residual kept the glide alive - `done` reads the speed of both axes
			// together, so a flick into the left edge with a hand's worth of drift downward went on gliding
			// down by fractions of a pixel for the better part of two seconds while the give stood at its
			// cap waiting for the glide to end (Alan, device, 2026-09-20: "it will hang for a bit too long").
			// So the glide is over when the axis carrying its main direction is pinned, not only when both
			// are; the give springs back at once and the residual is dropped with it, which is what hitting
			// an edge looks like. A glide whose main axis still has room is untouched.
			// The axis carrying the glide's main direction; when BOTH are pinned this is one of them, so the
			// old `(xPinned && yPinned) || mainPinned` could never be true where this is not.
			const pinned = Math.abs(this.flingVx) >= Math.abs(this.flingVy) ? xPinned : yPinned;
			// Done when the physics say so, or the carried target is clamped at an
			// edge and the glide has nowhere left to go.
			if (s.done || (pinned && Math.abs(s.dx) + Math.abs(s.dy) > 0.5)) {
				// THE GLIDE'S OWN GIVE. `carryScrollBy` above accrues what the scroller
				// refused on every frame of this chain, exactly as it does under a finger,
				// and a glide that runs out of page against an end accrues the lot. The
				// hand left at the lift, so if this does not hand it back nothing ever
				// will: the page stays held an allowance past the end, with the preview
				// paper up, until the next contact. A no-op when no pull stands.
				this.releaseOverscrollPull();
				return;
			}
			this.flingRaf = this.winRef.requestAnimationFrame(tick);
		};
		this.flingRaf = this.winRef.requestAnimationFrame(tick);
	}

	/**
	 * Scroll by a screen-px hand delta as part of the current finger gesture:
	 * content follows the hand, so the offsets move against it. The carried
	 * target advances, is clamped to the scroller's range and is written
	 * absolutely; the read-back is only compared with the last write, to
	 * adopt a scroll something else made (AssistScroll.ts says why it is
	 * never the start). The six reads share one layout: nothing between them
	 * writes.
	 */
	function carryScrollBy(this: InlinePenRouter, dx: number, dy: number) {
		const el = this.scrollEl;
		const scale = this.scaleProvider();
		const grid = scrollGrid(visualToNote(1, scale));
		const left = el.scrollLeft;
		const top = el.scrollTop;
		const beforeX = this.scrollCarryX ?? carryFrom(left);
		const beforeY = this.scrollCarryY ?? carryFrom(top);
		const stepX = -visualToNote(dx, scale);
		const stepY = -visualToNote(dy, scale);
		const x = carryStep(beforeX, { offset: left, range: el.scrollWidth - el.clientWidth }, stepX, grid);
		const y = carryStep(beforeY, { offset: top, range: el.scrollHeight - el.clientHeight }, stepY, grid);
		this.scrollCarryX = x.carry;
		this.scrollCarryY = y.carry;
		el.scrollLeft = x.carry.target;
		el.scrollTop = y.carry.target;
		// THE GIVE AT AN END. What the clamp refused is not nothing: it is the hand still
		// moving against a page that has run out. `carryStep` starts from the adopted
		// offset or the carried target and clamps the sum into [0, range], so the part it
		// would not take is the step minus the distance actually travelled. That remainder
		// is carried as a transient pull and handed to the host, which paints it and eases
		// it back on the lift. The scroller's own offset is untouched: it stays inside its
		// range, exactly as written above.
		this.accrueOverscrollPull(
			stepX - (x.carry.target - (x.adopted ? left : beforeX.target)),
			stepY - (y.carry.target - (y.adopted ? top : beforeY.target)),
			scale,
		);
		return { x, y, left, top, grid };
	}

	/**
	 * Accrue the part of a step the scroller refused, in note px, as a pull in
	 * painted px.
	 *
	 * The allowance comes from the host (`overscrollAllowancePx`) because it is
	 * the host that knows the external scale, and because a host with no give
	 * to offer - Infinite Canvas on, where an end is not a boundary - answers
	 * zero and nothing is carried at all.
	 */
	function accrueOverscrollPull(this: InlinePenRouter, refusedNoteX: number, refusedNoteY: number, scale: number): void {
		const allowance = this.cb.overscrollAllowancePx?.() ?? 0;
		if (allowance <= 0) return;
		const refusedX = noteToVisual(refusedNoteX, scale);
		const refusedY = noteToVisual(refusedNoteY, scale);
		if (Math.abs(refusedX) < 1e-9 && Math.abs(refusedY) < 1e-9) return;
		const clamp = (v: number): number => Math.max(-allowance, Math.min(allowance, v));
		// The pull is the hand's direction: the content follows the hand, and
		// the refused step was expressed against it.
		this.overscrollPullX = clamp(this.overscrollPullX - refusedX);
		this.overscrollPullY = clamp(this.overscrollPullY - refusedY);
		this.cb.onOverscrollPull?.(this.overscrollPullX, this.overscrollPullY);
	}

	/** The gesture ended: hand the give back to the host, which eases it to zero. */
	function releaseOverscrollPull(this: InlinePenRouter): void {
		if (this.overscrollPullX === 0 && this.overscrollPullY === 0) return;
		this.overscrollPullX = 0;
		this.overscrollPullY = 0;
		this.cb.onOverscrollRelease?.();
	}

	/**
	 * THE LIFT SITS WHERE NATIVE SCROLLING HAS NOTHING TO DO. Narrower than `dragBeginsAgainstAnEnd`
	 * on purpose: an axis with no range at all is ignored (a note that fits sideways still scrolls natively
	 * up and down), so only a lift at the top, bottom, left or right of an axis that CAN scroll, or on a note
	 * with no range on either axis, keeps the guard armed. Mid-page lifts open the native window as before.
	 */
	function liftAgainstAnEnd(this: InlinePenRouter): boolean {
		if ((this.cb.overscrollAllowancePx?.() ?? 0) <= 0) return false;
		const el = this.scrollEl;
		const rangeX = el.scrollWidth - el.clientWidth;
		const rangeY = el.scrollHeight - el.clientHeight;
		const endX = rangeX > 0 && (el.scrollLeft <= 0 || el.scrollLeft >= rangeX);
		const endY = rangeY > 0 && (el.scrollTop <= 0 || el.scrollTop >= rangeY);
		return endX || endY || (rangeX <= 0 && rangeY <= 0);
	}

	/**
	 * True when a drag starting now could only produce give, not scrolling: the host offers an
	 * allowance - which is Infinite Canvas OFF, since it answers 0 when on - and the scroller is
	 * against an end on an axis, or has no range there at all.
	 *
	 * Asked at the CONTACT, because that is when ownership is decided; no later point in the gesture
	 * can recover a drag that was handed to the native scroller. The direction is not known yet, so
	 * either axis being at an end is enough: a drag that turns out to head back into the range is
	 * carried by the assist exactly as it is at any other offset, and gives nothing.
	 */
	function dragBeginsAgainstAnEnd(this: InlinePenRouter): boolean {
		if ((this.cb.overscrollAllowancePx?.() ?? 0) <= 0) return false;
		const el = this.scrollEl;
		const rangeX = el.scrollWidth - el.clientWidth;
		const rangeY = el.scrollHeight - el.clientHeight;
		const atX = rangeX <= 0 || el.scrollLeft <= 0 || el.scrollLeft >= rangeX;
		const atY = rangeY <= 0 || el.scrollTop <= 0 || el.scrollTop >= rangeY;
		return atX || atY;
	}

	function cancelFling(this: InlinePenRouter): void {
		if (this.flingRaf !== 0) {
			this.winRef.cancelAnimationFrame(this.flingRaf);
			this.flingRaf = 0;
		}
		// A glide cut short with a give standing leaves the page held past an end by a
		// gesture that is over. Every caller here is a gesture ending or changing hands -
		// a new contact, a pinch beginning, a tool or camera change, a blur, teardown - so
		// the give goes home from all of them rather than being stranded by whichever one
		// happened to arrive. A no-op when no pull stands, which is the common case: the
		// release returns at once and the host is never called.
		this.releaseOverscrollPull();
	}

export function installInlinePenRouterNav(proto: InlinePenRouter): void {
	installMethods(proto, {
		beginPinch,
		pinchCentroid,
		rebasePinch,
		updatePinch,
		endPinch,
		prepareFingerInk,
		fingerInkContactActive,
		finishFingerInkPreparation,
		setCanvasMomentumDisabled,
		beginAssist,
		yieldAssistToHost,
		cameraTransformChanged,
		assistMove,
		endAssist,
		startFling,
		carryScrollBy,
		accrueOverscrollPull,
		releaseOverscrollPull,
		liftAgainstAnEnd,
		dragBeginsAgainstAnEnd,
		cancelFling,
	});
}
