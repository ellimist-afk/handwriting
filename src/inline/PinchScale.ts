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

export const MIN_PINCH_SCALE = 0.5;
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
 * The layout size the scaled box needs so it still fills its pane.
 *
 * A transform paints at a different size without changing layout, so a box
 * scaled to 2 would paint twice as wide while still claiming the pane's width,
 * and half of it would hang outside. Sizing the box to 100/k percent first
 * means the painted result lands back at exactly 100%.
 */
export function counterSizePercent(scale: number): number {
	const k = clampPinchScale(scale);
	return 100 / k;
}

/**
 * Scroll offset that keeps the point under the fingers still while the scale
 * changes, on one axis.
 *
 * The content coordinate under the centroid is `(scroll + centroid) / from`.
 * Holding that coordinate under the same screen position at the new scale
 * gives the offset below. Returns 0 rather than a NaN for junk input, which
 * shows up as the view jumping to the origin instead of vanishing.
 */
export function anchoredScroll(
	scroll: number,
	centroid: number,
	from: number,
	to: number
): number {
	if (!Number.isFinite(scroll) || !Number.isFinite(centroid)) return 0;
	if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) return scroll;
	const next = (scroll + centroid) * (to / from) - centroid;
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
