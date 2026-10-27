/**
 * Why a stroke ended. `up` is a healthy lift; anything else names what took
 * the contact, and that distinction is the whole diagnostic value of the log.
 *
 * `silent-lift` is a lift that delivered no event (see `silentLift` below):
 * the vocabulary used to be closed at four, and a nib that left the glass
 * without a `pointerup` fell out of all four - which is the whole of the bug
 * it is here to name.
 *
 * `slide-change` is the deck moving out from under a live stroke - a clicker,
 * an arrow key, anything that is not a pointer. It is the note surface's
 * `abandonActiveStroke`/`onStrokeAbandoned` in this surface's terms: the
 * stroke is committed to the surface it was DRAWN on and the live layers are
 * cleared, so no half-drawn line is left painted over the new slide and no ink
 * lands on a page the reader never wrote it on.
 */
export type StrokeEndReason =
	| "up"
	| "cancel"
	| "lost-capture"
	| "leave"
	| "silent-lift"
	| "slide-change";

/**
 * How long a stroke is held open after a cancel or a capture theft before it
 * is committed. A pen that is still down keeps delivering moves at 120-240 Hz,
 * so one further sample inside this window means the contact survived and the
 * cancel was the browser changing its mind, not the reader lifting off.
 */
export const STROKE_HOLD_MS = 300;

/**
 * A pen sample that claims the live stroke but is already hovering.
 *
 * `PointerRouter.silentLift` (src/input/PointerRouter.ts ~126), restated
 * rather than imported for the reason `eraserIntent` and the palm tails are
 * restated: PointerRouter drags the whole editor input stack - telemetry, the
 * palm gate, the camera - into a bundle that deliberately depends on nothing
 * but `src/ink` and `src/model`. PointerRouter.ts IS the source of truth for
 * this predicate and a drift here is a bug here.
 *
 * Its words, because they are the finding: the Surface Slim Pen can lift
 * without a discrete `pointerup` ever reaching the app; the raw stream simply
 * resumes hovering under the same pointerId, and every hover sample would
 * become trailing ink. The Surface Pen (1776) always delivers the event, so
 * this never fires for it. Both contact bits (tip = 1, eraser = 32) and the
 * pressure must read zero together, which is exactly the hover signature; a
 * mid-stroke pressure dip still carries the tip bit and a buttons glitch still
 * carries pressure, so neither ends a real stroke.
 *
 * Not `isPenHoverEvent`, which is the same question one notch coarser: that
 * one asks `buttons === 0` because it classifies events for a pointer this
 * surface holds no session for, where there is no stroke to be wrong about.
 * The side-button bit (2) can be HELD THROUGH a lift, and a reader who lifts
 * with the barrel button down would keep `buttons === 2` and keep inking.
 */
export function silentLift(pressure: number, buttons: number): boolean {
	return pressure === 0 && (buttons & 1) === 0 && (buttons & 32) === 0;
}

/**
 * How long a live contact may say NOTHING AT ALL before it is called a lift.
 *
 * The second half of the silent lift, for the lift that resumes no hover
 * either - the nib leaves the digitizer's range in the same motion, or the
 * deck loses the window, and the stream simply stops. `silentLift` above needs
 * a sample to read and there is none.
 *
 * `STROKE_HOLD_MS`, not a number of its own, and the reason is already written
 * on it: a pen that is still down keeps delivering at 120-240 Hz, so a silence
 * this long is the only evidence there is that the contact is over. It is the
 * same interval `PEN_GUARD_TAIL_MS` uses for the same judgement about the same
 * hardware, and a third number here would be a third thing to keep true.
 *
 * The note surface has NO such constant to copy: `silentLift` is the whole of
 * its rule there and it is event-driven end to end (PointerRouter.ts ~395 and
 * ~426, InlinePenRouter.ts ~1688 and ~1778 - four call sites, no timer). This
 * half is this surface's own, and it exists because a deck can outlive the
 * hover stream in ways an editor pane cannot: the presentation container is
 * torn off `<body>` (S1) and a projector can take the window with it.
 */
export const SILENT_LIFT_QUIET_MS = STROKE_HOLD_MS;

export interface StrokeSession {
	readonly phase: "idle" | "drawing";
	readonly pointerId: number | null;
	/** Whether we believe we still hold `setPointerCapture` for this pointer. */
	readonly captured: boolean;
	readonly samples: number;
	/** When a cancel / capture theft started being held open, else null. */
	readonly holdSince: number | null;
	readonly holdReason: StrokeEndReason | null;
}

export const IDLE_SESSION: StrokeSession = {
	phase: "idle",
	pointerId: null,
	captured: false,
	samples: 0,
	holdSince: null,
	holdReason: null,
};

export type StrokeSessionEvent =
	/**
	 * `captured` is whether the caller actually took `setPointerCapture` at
	 * this contact, which is NOT every contact any more: a contact that might
	 * still turn out to be a tap runs uncaptured (A1/S4, `onPointerDown`).
	 */
	| { kind: "down"; pointerId: number; t: number; captured: boolean }
	| { kind: "move"; pointerId: number; t: number }
	| { kind: "up"; pointerId: number; t: number }
	| { kind: "cancel"; pointerId: number; t: number }
	| { kind: "lost-capture"; pointerId: number; t: number }
	| { kind: "got-capture"; pointerId: number; t: number }
	| { kind: "leave"; pointerId: number; t: number }
	/**
	 * The nib is off the glass and said so in a `pointermove` instead of a
	 * `pointerup` (`silentLift`), or it said nothing for `SILENT_LIFT_QUIET_MS`.
	 * Pointer-addressed like every other input event: only the live contact's
	 * own hover can end the live contact's stroke.
	 */
	| { kind: "silent-lift"; pointerId: number; t: number }
	/**
	 * The deck moved to another slide under the live stroke. Carries no
	 * pointer, like `tick`: it is the surface talking, not the input stream,
	 * and the contact it ends is still physically on the glass.
	 */
	| { kind: "slide-change"; t: number }
	/** The hold deadline fired. Carries no pointer: it is a clock, not input. */
	| { kind: "tick"; t: number };

export interface StrokeSessionStep {
	state: StrokeSession;
	begin: boolean;
	sample: boolean;
	/** Capture was lost and the pen is still down: take it again. */
	recapture: boolean;
	/** Non-null means commit the stroke now, for this reason. */
	end: StrokeEndReason | null;
}

/**
 * The whole of a stroke's lifetime, as a pure function (S5).
 *
 * A cancel or a lost capture does NOT end a stroke while the pen is still
 * down: the stroke is held open for STROKE_HOLD_MS, one more move re-acquires
 * the capture and carries on in the same stroke, and only a silence that
 * outlives the window commits, with the reason recorded.
 *
 * The caller drives the deadline off `state.holdSince`: non-null means a timer
 * should be pending, null means it should not. Idempotent, so re-arming on
 * every step is correct.
 */
export function strokeSessionReducer(
	state: StrokeSession,
	ev: StrokeSessionEvent
): StrokeSessionStep {
	const idle: StrokeSessionStep = {
		state,
		begin: false,
		sample: false,
		recapture: false,
		end: null,
	};
	if (ev.kind === "down") {
		// A second contact while one is drawing is ignored outright: the
		// surface is single-stroke, and claiming it would orphan the builder.
		if (state.phase === "drawing") return idle;
		return {
			state: {
				phase: "drawing",
				pointerId: ev.pointerId,
				captured: ev.captured,
				samples: 1,
				holdSince: null,
				holdReason: null,
			},
			begin: true,
			sample: true,
			recapture: false,
			end: null,
		};
	}
	if (ev.kind === "slide-change") {
		// Unconditional, like `up` and unlike `cancel`: the ink belongs to the
		// slide it was drawn on and that slide is leaving the screen NOW, so
		// there is nothing a hold could wait for that would improve the answer.
		if (state.phase !== "drawing") return idle;
		return {
			state: IDLE_SESSION,
			begin: false,
			sample: false,
			recapture: false,
			end: "slide-change",
		};
	}
	if (ev.kind === "tick") {
		if (state.phase !== "drawing" || state.holdSince === null) return idle;
		if (ev.t - state.holdSince < STROKE_HOLD_MS) return idle;
		return {
			state: IDLE_SESSION,
			begin: false,
			sample: false,
			recapture: false,
			end: state.holdReason ?? "cancel",
		};
	}
	// Everything below is pointer-addressed: a stray event for another pointer
	// (a finger, a second pen) must not touch the live stroke.
	if (state.phase !== "drawing" || state.pointerId !== ev.pointerId) return idle;
	switch (ev.kind) {
		case "move": {
			// Capture is only ever LOST alongside a hold (`cancel` and
			// `lost-capture` both open one), so a hold is what tells a stolen
			// capture apart from one that was deliberately never taken. A
			// contact that is still deciding whether it is a tap is the second
			// kind and must NOT be handed a capture here - that is the whole
			// of the arrow-click fix (A1/S4).
			const recapture = !state.captured && state.holdSince !== null;
			// The pen is demonstrably still down, so any hold is void.
			//
			// AMENDED 2026-09-05 (silent lift): "demonstrably" is the CALLER's
			// promise now, not this branch's. A hover sample is a `pointermove`
			// too, and feeding one in here as a `move` would not merely fail to
			// end the stroke, it would clear the hold and reinforce the belief
			// that the nib is on the glass. `onPointerMoveBody` reads
			// `silentLift` BEFORE it builds this event, so a hover arrives as
			// `silent-lift` and never as `move`; a caller that skipped that
			// test would resurrect the whole bug from inside this line.
			return {
				state: {
					...state,
					captured: state.captured || recapture,
					samples: state.samples + 1,
					holdSince: null,
					holdReason: null,
				},
				begin: false,
				sample: true,
				recapture,
				end: null,
			};
		}
		case "got-capture":
			return { ...idle, state: { ...state, captured: true } };
		case "up":
			return {
				state: IDLE_SESSION,
				begin: false,
				sample: false,
				recapture: false,
				end: "up",
			};
		case "silent-lift":
			// As final as an `up` and for the same physical reason - the nib is
			// off the glass. NOT a hold: a hold exists for a contact that may
			// still be down (S5), and this event is the evidence that it is
			// not, so holding one open would be holding it open against the
			// only witness there is.
			return {
				state: IDLE_SESSION,
				begin: false,
				sample: false,
				recapture: false,
				end: "silent-lift",
			};
		case "cancel":
			// Held, not committed. A cancel outranks a capture theft as an
			// explanation, so it takes the reason even if a theft armed first.
			return {
				...idle,
				state: {
					...state,
					captured: false,
					holdSince: state.holdSince ?? ev.t,
					holdReason: "cancel",
				},
			};
		case "lost-capture":
			return {
				...idle,
				state: {
					...state,
					captured: false,
					holdSince: state.holdSince ?? ev.t,
					holdReason: state.holdReason ?? "lost-capture",
				},
			};
		case "leave":
			return {
				state: IDLE_SESSION,
				begin: false,
				sample: false,
				recapture: false,
				end: "leave",
			};
	}
}
