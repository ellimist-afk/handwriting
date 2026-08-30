/**
 * Palm rejection state machine (handoff §14).
 *
 * Rules:
 * - While a pen stroke is active, all NEW touch contacts are ignored.
 * - For a short tail after the pen lifts, new touch contacts stay ignored
 *   (the palm usually lingers).
 * - While the pen is merely hovering near the screen, the hand is holding
 *   the pen. New touches are very likely palm, so they are also ignored
 *   for a short window after the last hover event ("palm placed before
 *   pen", §61).
 *
 * Touch contacts that began BEFORE the pen arrived are handled by the
 * TouchController (it drops its gesture when the pen goes active).
 *
 * All timing uses performance.now() passed in by callers so the class stays
 * trivially testable.
 */

/**
 * v0.13.2 feel pass: 500 → 250 ms. The pen retreating through hover range
 * keeps `blocksNewTouch` true via the hover rule anyway, so the fixed tail
 * only governs the moment AFTER the pen has left the glass entirely, and
 * half a second of dead fingers there is what made pen-to-scroll feel sticky.
 * A palm that was already planted stays swallowed per-contact regardless.
 */
const RELEASE_TAIL_MS = 250;
const HOVER_TAIL_MS = 300;

export class PalmGate {
	private penStrokeActive = false;
	private lastPenContactEnd = -Infinity;
	private lastPenHover = -Infinity;

	get isPenStrokeActive(): boolean {
		return this.penStrokeActive;
	}

	penStrokeStarted(): void {
		this.penStrokeActive = true;
	}

	penStrokeEnded(now: number): void {
		this.penStrokeActive = false;
		this.lastPenContactEnd = now;
	}

	penHoverSeen(now: number): void {
		this.lastPenHover = now;
	}

	/** Should a NEW touch contact be ignored right now? */
	blocksNewTouch(now: number): boolean {
		if (this.penStrokeActive) return true;
		if (now - this.lastPenContactEnd < RELEASE_TAIL_MS) return true;
		if (now - this.lastPenHover < HOVER_TAIL_MS) return true;
		return false;
	}

	/**
	 * Is a pen writing or hovering right now? Read-only view of the same state
	 * the touch rule uses. A side-button press while merely HOVERING produces a
	 * native context menu with no contact for the router to claim, and this is
	 * how that menu gets attributed to the pen.
	 */
	isPenNear(now: number): boolean {
		if (this.penStrokeActive) return true;
		return now - this.lastPenHover < HOVER_TAIL_MS;
	}
}

// ---- palm parole (v0.13.3 feel pass) ---------------------------------------
//
// blocksNewTouch swallows every contact while the pen is near. Correct for
// palms, but it also deadened deliberate scroll fingers: pen in hand near
// the glass meant touch "just doesn't work". The discriminator is MOTION:
// a palm plants and rests; a scroll finger travels immediately. A swallowed
// contact that moves like a swipe earns parole and becomes an assist pan; a
// resting contact stays swallowed. If the pen lands mid-parole, the claim
// path cancels the assist and reclassifies the touch as palm. The pen
// always wins.
//
// v0.13.6 RC3, overlap veto. Motion alone misjudged the hand that FOLLOWS
// the pen: eraser scrubbing lifts and re-lands the nib every few hundred
// ms, the hand's edge re-plants and slides between those contacts, and a
// contact that landed mid-stroke (parole denied only WHILE the stroke was
// active) earned parole the instant the nib lifted, and the viewport walked
// with the scrub (hardware, 2026-08-22). A contact a pen stroke overlapped
// at any point in its life is that hand, for the rest of its life.

/** Travel (px, Manhattan) a blocked contact must show to earn parole. */
export const PAROLE_DIST_PX = 18;
/** ...within this long after it landed. Later slow drifts stay palm. */
export const PAROLE_WINDOW_MS = 400;
/**
 * Contacts the digitizer reports BIGGER than this never earn parole: a
 * palm heel is huge and can slide fast while planting; a fingertip is not.
 * Geometry is a VETO only. Small contacts still need the motion test,
 * because the classic palm-rejection failures (knuckle, pinky edge) are
 * small. Contacts with no size information (width/height ≤ 1, the spec
 * default) are judged by motion alone.
 */
export const PAROLE_MAX_CONTACT_PX = 50;

/** Pure, unit-tested: does this blocked contact's motion look like a swipe? */
export function paroleEarned(g: {
	travelPx: number;
	sinceDownMs: number;
	penStrokeActive: boolean;
	/** max(width, height) of the contact at pointerdown; ≤1 = unknown. */
	contactPx?: number;
	/**
	 * A pen stroke was active at SOME point while this contact was down: it
	 * landed mid-stroke, or the pen landed while it was down. Palm for life.
	 */
	penContactOverlapped?: boolean;
}): boolean {
	if (g.penStrokeActive) return false; // while writing, everything is palm
	if (g.penContactOverlapped) return false; // …and so is the hand the pen overlapped
	if ((g.contactPx ?? 0) > PAROLE_MAX_CONTACT_PX) return false; // palm-sized
	if (g.sinceDownMs > PAROLE_WINDOW_MS) return false;
	return g.travelPx >= PAROLE_DIST_PX;
}
