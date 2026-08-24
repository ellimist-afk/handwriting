/**
 * Standing manipulation guard: the cold-contact fix.
 *
 * Root cause (hardware-established): pen drag panning is opted out ONLY by
 * `touch-action`, and Chromium snapshots the allowed gestures from the
 * compositor's COMMITTED state when the contact arrives. The old guard set
 * `touch-action: none` reactively on pen hover, a frame or more before
 * contact when the pen approaches slowly, which is why hover-first always
 * inks. A cold strike reaches pointerdown before any hover event can be
 * committed, the pan wins, and the first stroke scrolls instead of inking.
 * `preventDefault` on pointerdown does not help (empirically verified on
 * hardware: every claimed pen-down already calls it).
 *
 * A cold contact can therefore never be handled reactively. The guard's
 * resting state must already be `touch-action: none` BEFORE the pen exists.
 * Fingers still need native panning, so the guard opens a TOUCH WINDOW:
 *
 *   ARMED  (resting)      scroller carries touch-action:none.
 *                         Any pen contact, hovered or stone cold, inks.
 *                         Wheel/touchpad and mouse are unaffected by
 *                         touch-action and keep working throughout.
 *   ARMED-ASSIST          a non-palm-gated finger arrived while armed.
 *                         touch-action STAYS none for the whole gesture.
 *                         The gesture is carried entirely by the router's
 *                         assist pan (1:1 with the finger; Chromium already
 *                         snapshotted "none" for it, so restoring the style
 *                         mid-gesture buys the finger nothing and sells the
 *                         pen out). v0.12.12: v0.12.10 restored touch-action
 *                         HERE, at touchStart, and that was the residual
 *                         cold-contact hole. On a cold slam the hand's
 *                         edge/palm reaches the glass milliseconds before
 *                         the tip; with no hover in the last 300 ms the palm
 *                         gate cannot block it, v0.12.10 opened the window
 *                         on it, and the tip then landed on a restored-pan
 *                         snapshot and scrolled. Hover-first approaches ink
 *                         because hover makes the gate swallow the palm.
 *                         That is the hover/cold discriminator, and why the
 *                         failure tracked "immediately after touchpad
 *                         scrolling": touchpad use forces the pen away
 *                         (hover disables the touchpad), so every
 *                         post-touchpad contact is a cold slam.
 *   TOUCH WINDOW          opens when the last finger of an assist gesture
 *                         LIFTS, and only if the gesture actually panned.
 *                         Subsequent finger gestures are fully native
 *                         (inertia included). A tap or a palm that rested
 *                         and lifted never opens the window at all.
 *   RE-ARM                one-shot timer after the window opens (same
 *                         pattern as before: event-driven, no polling, no
 *                         recurring timers). Any pen signal re-arms
 *                         instantly and cancels it; a pen signal during an
 *                         assist gesture reclassifies that touch as palm.
 *
 * Residual hole, accepted and documented: a cold pen strike inside the
 * ~1 s window after a REAL finger pan can still pan. Physically rare: the
 * fingers must scroll, leave the glass, and the pen must land with zero
 * hover inside a second.
 *
 * Pure state machine. Timers and styles live in the router; this class is
 * fully unit-testable.
 */

export type GuardState = "armed" | "armed-assist" | "touch-open" | "touch-linger";

export interface GuardDecision {
	/** What the scroller's inline touch-action should be right now. */
	touchAction: "none" | "";
	/** Router must carry THIS touch gesture with the JS assist pan. */
	assistThisGesture: boolean;
	/** Router should (re)schedule the one-shot re-arm timer. */
	scheduleRearm: boolean;
	/** Router should cancel a pending re-arm timer. */
	cancelRearm: boolean;
}

const NO_CHANGE: Omit<GuardDecision, "touchAction"> = {
	assistThisGesture: false,
	scheduleRearm: false,
	cancelRearm: false,
};

export class ManipulationGuard {
	private state: GuardState = "armed";
	private activeTouches = 0;

	get current(): GuardState {
		return this.state;
	}

	private touchActionFor(state: GuardState): "none" | "" {
		return state === "armed" || state === "armed-assist" ? "none" : "";
	}

	/**
	 * Any pen signal: hover, raw hover, contact. Arms instantly. During an
	 * assist gesture this reclassifies the carried touch as palm: the guard
	 * forgets it (the router stops assisting it) and the window never opens.
	 */
	penSignal(): GuardDecision {
		const was = this.state;
		this.state = "armed";
		this.activeTouches = 0;
		return {
			...NO_CHANGE,
			touchAction: "none",
			cancelRearm: was === "touch-linger",
		};
	}

	/**
	 * A finger contact the palm gate did not block. While armed this does NOT
	 * restore touch-action (v0.12.12; see the module comment). The gesture runs
	 * under the standing guard, carried by the assist pan, so a pen strike at
	 * any moment during it still meets a committed touch-action: none.
	 */
	touchStart(): GuardDecision {
		if (this.state === "armed" || this.state === "armed-assist") {
			const first = this.state === "armed";
			this.state = "armed-assist";
			this.activeTouches++;
			return {
				touchAction: "none",
				// Only the first finger gets the assist; its snapshot (and any
				// simultaneous sibling's) was taken with none in force.
				assistThisGesture: first,
				scheduleRearm: false,
				cancelRearm: false,
			};
		}
		const wasLinger = this.state === "touch-linger";
		this.state = "touch-open";
		this.activeTouches++;
		return {
			touchAction: "",
			assistThisGesture: false,
			scheduleRearm: false,
			cancelRearm: wasLinger,
		};
	}

	/**
	 * A tracked finger lifted (pointerup or pointercancel). `panned` = the
	 * gesture actually scrolled (the router's assist engaged, or the state
	 * was already the native window). The window opens (touch-action
	 * restored, re-arm scheduled) only when the LAST finger of a gesture
	 * that really panned lifts; a tap or a resting palm leaves the guard
	 * armed and the window shut.
	 */
	touchEnd(panned: boolean): GuardDecision {
		if (this.state !== "touch-open" && this.state !== "armed-assist") {
			return { ...NO_CHANGE, touchAction: this.touchActionFor(this.state) };
		}
		this.activeTouches = Math.max(0, this.activeTouches - 1);
		if (this.activeTouches > 0) {
			return { ...NO_CHANGE, touchAction: this.touchActionFor(this.state) };
		}
		if (this.state === "armed-assist" && !panned) {
			this.state = "armed";
			return { ...NO_CHANGE, touchAction: "none" };
		}
		this.state = "touch-linger";
		return { ...NO_CHANGE, touchAction: "", scheduleRearm: true };
	}

	/** The one-shot re-arm timer fired. */
	rearm(): GuardDecision {
		if (this.state !== "touch-linger") {
			return { ...NO_CHANGE, touchAction: this.touchActionFor(this.state) };
		}
		this.state = "armed";
		return { ...NO_CHANGE, touchAction: "none" };
	}
}
