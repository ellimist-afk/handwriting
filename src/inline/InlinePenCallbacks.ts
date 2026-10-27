import type { PenSample } from "../input/PointerRouter";

export interface InlinePenCallbacks {
	onPenDown(sample: PenSample, ev: PointerEvent): void;
	/** Retire earlier viewport ownership before new input changes its frame. */
	onViewportInput?(): void;
	/** Every contact has lifted (no touch, no assist pan) and none replaced it. A cancelled ease may have left the page stranded off its rest; the overlay decides whether there is anything to resume. */
	onAllContactsLifted?(): void;
	/** Finish pending raster coverage before the first sample is mapped. */
	onBeforePenDown?(): void;
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
	/**
	 * The give the page is allowed past an end, painted px, or 0 for none.
	 *
	 * Asked of the host because the host knows the external scale, and because
	 * a host with no boundary to bounce off - Infinite Canvas on, where the
	 * page is showing room it can grow into - answers 0 and nothing is carried.
	 */
	overscrollAllowancePx?(): number;
	/**
	 * The page is held past an end by this much, painted px: cumulative, and
	 * already capped at the allowance. The host paints it. It is transient, and
	 * the scroller's own offset never leaves its range while it is carried.
	 */
	onOverscrollPull?(x: number, y: number): void;
	/** The gesture ended with a give outstanding: ease it back to zero. */
	onOverscrollRelease?(): void;
	/** Input-rate coalesced samples while a stroke is active. */
	onPenRaw(samples: PenSample[], ev: PointerEvent): void;
	/** rAF-rate move, for metrics only (`coalescedCount`). */
	onPenMove(ev: PointerEvent, coalescedCount: number): void;
	/**
	 * The stroke ended. `ev` is the pointerup/pointercancel that ended it -
	 * ABSENT when the stroke ended without one, which is the window-blur case
	 * `finishActiveStroke()` serves (alt-tab, a system dialog, the on-screen
	 * keyboard). Optional rather than synthesised: the one thing a surface
	 * reads off this event is the lift POSITION, which it appends as the
	 * stroke's final point (`PdfInkController.addFinalPoint`) because a
	 * pointerup carries a position no `onPenRaw` sample does. A blur has no
	 * lift, so there is no such position, and a made-up one would put a point
	 * where the pen never was. Undefined says exactly that: end the stroke at
	 * the last sample the router actually fed.
	 */
	onPenUp(ev?: PointerEvent): void;
	/**
	 * Is the pen OFF on this surface? (PenInk.ts, design §5.)
	 *
	 * The one gate for the pen-off state, asked at every point this router
	 * would otherwise take the pen away from the app. True means: do not
	 * claim, do not preventDefault, do not capture, do not arm a guard, do
	 * not eat the parallel touch stream, do not paint a reticle - the pen
	 * reaches whatever is under it (CodeMirror on a note, the pdf viewer on a
	 * pdf) exactly as it would if this plugin were not installed, so a tap
	 * places a caret and the software keyboard comes up with it. Two e-ink
	 * reports asked for precisely that; PenInk.ts carries them and the
	 * decisions behind the state.
	 *
	 * BOTH SURFACES ANSWER IT THE SAME WAY: `() => !penInkEnabled()`. The pdf
	 * passed nothing for two days, on the reasoning that there is nothing to
	 * type into on a pdf, and the owner reversed that - "why would you take
	 * keyboard mode away from pdf" - because the state is not about typing, it
	 * is about whether this router claims the pen at all. It is in
	 * `INLINE_PEN_CALLBACKS` (InkSurfaces.ts), the list both ink surfaces must
	 * wire, so a surface that drops the gate again is loud rather than quiet.
	 *
	 * A PREDICATE and not a flag, because the state is session state living
	 * in a module and this router must not import it - both surfaces read
	 * PenInk.ts themselves and hand the answer down.
	 *
	 * OPTIONAL still, in the TYPE only: an undefined member reads as "the pen
	 * is never off here", which is the harnesses' answer and the answer for
	 * any future surface built before it has an opinion. Both real surfaces
	 * owe it.
	 *
	 * REFUSES A CLAIM; NEVER BREAKS ONE. Every site below asks this only
	 * where no stroke of ours is live, so flipping the state with the nib on
	 * the glass cannot freeze a half-drawn stroke with `activePenId` set and
	 * the ownership guard armed - the failure mode `abandonActiveStroke` was
	 * written for. Ending that live stroke is the toggle's own job (main.ts's
	 * `pen-ink-toggle` -> `endLiveStrokesEverywhere`, which COMMITS it the way
	 * a window blur does); this router only stops claiming the next contact.
	 */
	penOff?: () => boolean;
	/**
	 * Should a contact OUTSIDE the scroller (the linked-mentions band renders
	 * outside it, in the same view) be claimed as a Handwriting gesture? The
	 * overlay answers yes only for eraser intent - see bandEraserIntent.
	 */
	claimBandContact?(ev: PointerEvent): boolean;
	/**
	 * Trace-only: describe the pen-toolbar chrome's hit-testability for
	 * `target`, the deepest element a pen pointerdown actually hit. Called
	 * ONLY by the window mirror below, and only while composing a trace line
	 * for a pen pointerdown whose composed path missed every live scroller -
	 * the strip is mounted as a SIBLING of the scroller (MobileTools.ts), so
	 * a tap that lands on it, or near it, never reaches this router's own
	 * scroller-attached listeners at all. This is the seam that lets a
	 * trace-only caller reach chrome the router otherwise holds no reference
	 * to, by design (see the window-mirror section below). The overlay
	 * implements this by asking its MobileTools instance for a snapshot; the
	 * pdf surface has no strip and leaves it undefined.
	 */
	describeChrome?(target: Element | null): string;
	/**
	 * A live stroke was torn down with no lift by a path that cannot commit
	 * what was drawn, and the surface has pen-down chrome to put back.
	 *
	 * NOT the blur any more. This was written as "the blur half of the
	 * abandoned-stroke fix" when a window blur DROPPED the stroke; the ruling
	 * of 2026-09-04 made a blur commit instead, through
	 * `finishActiveStroke()` and `onPenUp`, so the router's own remaining call
	 * site (the blur handler's second branch) is unreachable: it runs only
	 * when no stroke was live, and `abandonActiveStroke()` returns false in
	 * exactly that case. The callback stays declared and stays wired, because
	 * the paths that still DROP a stroke are the surfaces' own - the note
	 * switch (`InkOverlayPlugin.update`) and the pdf's in-place document
	 * change (`forgetHistory`) - and each of them calls `abandonActiveStroke()`
	 * itself, reads the return value (`f5f2333`), and runs the very same
	 * `strokeAbandoned` body this member is bound to.
	 *
	 * Fires ONLY when a claimed pen stroke was really torn down - never inside
	 * the post-stroke tail (that stroke's own pointerup already ran the
	 * surface's pen-up path) and never with nothing live. Deliberately NOT
	 * `onPenUp`: that one commits ink, and a stroke being DROPPED must not be
	 * half-committed through a path meant for a real lift. Chrome only.
	 *
	 * Optional so a router can be built by something with no chrome to stand
	 * down; both real surfaces wire it, and `INLINE_PEN_CALLBACKS`
	 * (InkSurfaces.ts) is what holds them to that.
	 */
	onStrokeAbandoned?(): void;
	/**
	 * Note-only opt-in for drawing with the first finger. Undefined means
	 * native touch, which keeps PDF and every existing caller unchanged.
	 */
	fingerInk?(): boolean;
	/**
	 * Does a two-finger gesture belong to the host at all? (Alan, 2026-09-20: "it should stay
	 * obsidian stock behavior"). Undefined means yes, which keeps PDF and every existing caller
	 * unchanged. False and the router does not watch, guard or claim the second contact: both
	 * fingers stay the browser's and the host pinches the way it does with no plugin loaded.
	 */
	pinchZoom?(): boolean;
	/** Drop the provisional finger stroke before handing two contacts to pinch. */
	onFingerInkCancelled?(): void;
	/**
	 * A HAND JUST LANDED ON THE GLASS with none there a moment ago: whatever
	 * hover reticle a MOUSE is holding up is not wanted while it writes.
	 *
	 * The ruling (alan, 1.4.12): "hide the mouse reticle when a finger or pen
	 * is active". With mouse ink armed a parked mouse is still HOVERING, so
	 * its ring floats wherever the pointer was last left - bottom right in one
	 * vault, mid-screen in another - the whole time a finger is flinging the
	 * page or the pen is writing. A marker for a pointer nobody is using is
	 * noise, and on a tablet it reads as a smudge on the glass.
	 *
	 * ONLY A FINGER FIRES THIS, and only the FIRST one, because it is the only
	 * landing that leaves a stale ring behind. A pen announces itself twice
	 * over - `onPenHover` while it approaches and `onPenDown` when it lands -
	 * and both repaint the one reticle element AT THE PEN, so the mouse's ring
	 * is replaced rather than stranded. A finger announces itself to this
	 * router and to nothing else: the touch branch of `pointerDown` returns
	 * before any callback, so with the mouse sitting still no later event of
	 * any kind reaches the surface, and the ring simply stays lit.
	 *
	 * EDGE, NOT LEVEL. `handOnGlass()` is consulted BEFORE this contact is
	 * recorded, so a palm settling beside a working pen - the commonest touch
	 * on the hardware this ships to - sees a hand already there and says
	 * nothing, and the pen's own ring never blinks. Two fingers of a pinch
	 * fire it once, for the same reason.
	 *
	 * The other half of the rule is `handOnGlass()`, read where the reticle is
	 * decided: this takes a stale ring down, that keeps a mouse from putting
	 * one back while the hand is still there. Neither disarms mouse ink - a
	 * mouse that draws still draws, and its own in-gesture ring is the only
	 * one it loses.
	 *
		 * Optional, and NOT in `INLINE_PEN_CALLBACKS` (InkSurfaces.ts): note-only
	 * today, like `claimBandContact?` and `describeChrome?`. An undefined
	 * member reads as "this surface has no reticle to stand down", which is
	 * the harnesses' answer and the pdf's until somebody rules on it there.
	 */
	onHandOnGlass?(): void;
}
