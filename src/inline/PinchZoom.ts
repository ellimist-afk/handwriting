/**
 * Two-finger pinch on the inline surface (tier 1: pen away from the glass).
 *
 * Inline "zoom" is not a transform the plugin owns. The three mechanisms the
 * overlay already follows are page zoom, a measured CSS scale, and Obsidian's
 * base font size (see ZoomScale). Only the last one is note-local, so a pinch
 * drives THAT: the gesture picks a new base font size, the editor reflows, and
 * ink follows through the existing font-zoom path. Nothing here rewrites a
 * stored coordinate.
 *
 * Everything in this file is pure. The router owns when a pinch is live; the
 * host owns how a font size is applied.
 */

/** Obsidian's own quick-adjust lives in this neighbourhood; stay inside it. */
export const MIN_FONT_PX = 10;
export const MAX_FONT_PX = 40;

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
 * The font size this pinch is asking for.
 *
 * Always computed from the size at gesture start times the spread ratio, never
 * accumulated step to step, so a pinch out and back lands exactly where it
 * began. Returns null when there is nothing sane to ask for, and the caller
 * then does nothing at all.
 */
export function pinchFontSize(referencePx: number, ratio: number): number | null {
	if (!Number.isFinite(referencePx) || referencePx <= 0) return null;
	if (!Number.isFinite(ratio) || ratio <= 0) return null;
	const raw = Math.round(referencePx * ratio);
	if (!Number.isFinite(raw)) return null;
	return Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, raw));
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
