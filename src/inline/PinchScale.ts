/**
 * Pinch magnification for the inline surface.
 *
 * The first version of pinch drove Obsidian's base font size. That reflows:
 * text re-wraps at a different point, paragraphs change height, and the words
 * slide out from under ink that lives at fixed note coordinates. Zooming in to
 * look at an annotation was the one thing that pulled it off the line it
 * annotated. It also wrote a vault-wide appearance setting, so pinching a note
 * silently resized every other pane and anything a snippet sized in rem.
 *
 * This scales the editor instead. Text and ink magnify as one object, so every
 * stroke keeps its exact relationship to every word at any zoom, and nothing
 * outside the note moves. The overlay needs no new plumbing to follow it:
 * `effectiveScale` already measures visual width against layout width, which
 * is precisely what an ancestor transform changes.
 *
 * Everything here is pure.
 */

/**
 * No zooming out. One, not a half.
 *
 * The transform has `transform-origin: 0 0` and the layout box is deliberately
 * never resized, so a scale below 1 paints the editor into the top-left
 * FRACTION of its own box and leaves the remainder empty - not just blank but
 * dead: nothing to click, nothing to draw on. At the old floor of 0.5 that was
 * three quarters of the pane (alan, hardware).
 *
 * There is no fix for that short of counter-sizing the box, which is retired
 * below and for good reason: a resized box re-wraps the text and slides words
 * out from under ink anchored to note coordinates. Zooming IN has a coherent
 * story without it - the note overhangs the pane and the scroller reaches it,
 * the same as any pdf viewer - and zooming out simply never had one.
 *
 * Nothing is really lost. Shrinking a note to see more of it is what the
 * editor's own font zoom is for, and that reflows honestly instead of
 * pretending to.
 */
export const MIN_PINCH_SCALE = 1;
export const MAX_PINCH_SCALE = 4;

/** Keep a live or restored scale inside something usable. */
export function clampPinchScale(scale: number): number {
	if (!Number.isFinite(scale) || scale <= 0) return 1;
	return Math.min(MAX_PINCH_SCALE, Math.max(MIN_PINCH_SCALE, scale));
}

/**
 * The scale a gesture is asking for. Always the scale captured at gesture
 * start times the spread ratio, never accumulated step to step, so a pinch out
 * and back lands exactly where it began.
 */
export function pinchScale(referenceScale: number, ratio: number): number {
	if (!Number.isFinite(referenceScale) || referenceScale <= 0) return 1;
	if (!Number.isFinite(ratio) || ratio <= 0) return clampPinchScale(referenceScale);
	return clampPinchScale(referenceScale * ratio);
}

/**
 * RETIRED, kept only so an old import fails loudly in review rather than
 * silently at runtime: counter-sizing the box was wrong twice over. The
 * narrower layout box made the text RE-WRAP while zooming, so words changed
 * lines while world-anchored ink stayed put - the exact misregistration this
 * module exists to prevent - and the re-wrap is a full document reflow,
 * which is why every variant of it was laggy. A magnified note keeps its
 * layout and overhangs the pane; that is what the scroller is for.
 */
export function counterSizePercent(scale: number): number {
	const k = clampPinchScale(scale);
	return 100 / k;
}

/**
 * Scroll offset that keeps the point you STARTED pinching at under the place
 * you started pinching it, on one axis.
 *
 * Absolute, from the gesture's own start state - never from the previous
 * frame. The first version recomputed each frame against the live centroid
 * and the live scale, which failed twice over: fingers move during a pinch,
 * so the anchor point moved with them and the view chased both fingers
 * around; and each frame's rounding fed into the next, so the drift
 * accumulated the longer you pinched.
 *
 * The geometry, and it matters: the transform sits on the EDITOR, and the
 * scroller is a child INSIDE it. Scroll offsets are therefore layout px in
 * the scroller's untransformed space, while the centroid offset is painted
 * px measured against the scroller's transformed rect: o = k * (p - s).
 * The content point under the start centroid is p = s0 + o0/f, and holding
 * it under the same painted offset at scale t gives
 * s = s0 + o0 * (1/f - 1/t). Getting this backwards (treating the content
 * as a transformed child inside a still scroller) anchors nothing: the
 * zoom slides around the point instead of holding it.
 */
export function anchoredScroll(
	startScroll: number,
	startOffset: number,
	fromScale: number,
	toScale: number
): number {
	if (!Number.isFinite(startScroll) || !Number.isFinite(startOffset)) return 0;
	if (!Number.isFinite(fromScale) || fromScale <= 0) return startScroll;
	if (!Number.isFinite(toScale) || toScale <= 0) return startScroll;
	const next = startScroll + startOffset * (1 / fromScale - 1 / toScale);
	return Number.isFinite(next) ? Math.max(0, next) : 0;
}

/* ---- gesture detection (unchanged from the font-size version) ---- */

/**
 * Spread change, in pixels, before a two-finger contact counts as a pinch.
 * A two-finger tap or a slight settle of the resting hand must not resize the
 * note under it.
 */
export const PINCH_SLOP_PX = 12;

export interface PinchPoint {
	x: number;
	y: number;
}

/** Distance between the two contacts. Zero when they arrive on top of each other. */
export function pinchSpread(a: PinchPoint, b: PinchPoint): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const d = Math.hypot(dx, dy);
	return Number.isFinite(d) ? d : 0;
}

/**
 * Has the gesture moved far enough to be a deliberate pinch? Measured against
 * the spread at first contact, so a pinch that starts wide and closes counts
 * the same as one that starts narrow and opens.
 */
export function pinchEngaged(startSpread: number, currentSpread: number): boolean {
	if (!Number.isFinite(startSpread) || !Number.isFinite(currentSpread)) return false;
	return Math.abs(currentSpread - startSpread) >= PINCH_SLOP_PX;
}

/**
 * Spread ratio for a live gesture. A start spread too small to be meaningful
 * (two fingers landing almost on the same point) yields 1, so the note holds
 * still until the contacts separate.
 */
export function pinchRatio(startSpread: number, currentSpread: number): number {
	if (!Number.isFinite(startSpread) || startSpread < 1) return 1;
	if (!Number.isFinite(currentSpread) || currentSpread <= 0) return 1;
	return currentSpread / startSpread;
}
