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

import { validCameraScale } from "./ZoomScale";

export const MAX_PINCH_SCALE = 4;
export const MIN_PINCH_SCALE = 0.1;

/** Bound user zoom requests before creating an extreme counter-sized editor. */
export function clampPinchScale(scale: number): number {
 return validCameraScale(scale) ? Math.max(MIN_PINCH_SCALE, Math.min(MAX_PINCH_SCALE, scale)) : 1;
}

/** Intersect one stroke with the reachable right/down surface; never mutate it. */
export function clampToReachable(
 bounds: InkFitBounds | null,
 origin: { originLeftNote: number; originTopNote: number },
): InkFitBounds | null {
 if (!bounds) return null;
 const { originLeftNote: minX, originTopNote: minY } = origin;
 if (![bounds.x, bounds.y, bounds.width, bounds.height, minX, minY].every(Number.isFinite)) return null;
 if (bounds.width < 0 || bounds.height < 0) return null;
 const right = bounds.x + bounds.width, bottom = bounds.y + bounds.height;
 const x = Math.max(bounds.x, minX), y = Math.max(bounds.y, minY);
 if (right < x || bottom < y) return null;
 return { x, y, width: right - x, height: bottom - y };
}

export interface InkFitBounds { x:number; y:number; width:number; height:number; }
export type InkFitPlan = { kind:"fit"; zoom:number } | { kind:"empty"; zoom:1 } | { kind:"unrepresentable" } | { kind:"below-minimum" };
/** Native Chromium layout has a finite range; refuse before saturating it. */
export const MAX_VIEWPORT_LAYOUT = 8_000_000;
export function fitInkBounds(g:{bounds:InkFitBounds|null; viewportWidthScreen:number; viewportHeightScreen:number; externalScale:number; fontZoom:number; marginScreen:number}):InkFitPlan {
 const {bounds:b,viewportWidthScreen:w,viewportHeightScreen:h,externalScale:e,fontZoom:f}=g;
 if (![w,h,e,f].every(n=>Number.isFinite(n)&&n>0) || !Number.isFinite(g.marginScreen)||g.marginScreen<0) return {kind:"unrepresentable"};
 if (!b) return {kind:"empty",zoom:1};
 if (![b.x,b.y,b.width,b.height,b.x+b.width,b.y+b.height].every(Number.isFinite)||b.width<0||b.height<0) return {kind:"unrepresentable"};
 const margin=Math.min(g.marginScreen,w/4,h/4);
 const zoom=Math.min(1,(w-2*margin)/(Math.max(1,b.width)*e*f),(h-2*margin)/(Math.max(1,b.height)*e*f));
 if (!validCameraScale(zoom,w/e,h/e)||Math.max(w/(e*zoom),h/(e*zoom),Math.abs(b.x*f),Math.abs(b.y*f),(b.x+b.width)*f,(b.y+b.height)*f)>MAX_VIEWPORT_LAYOUT) return {kind:"unrepresentable"};
 if (zoom < MIN_PINCH_SCALE) return {kind:"below-minimum"};
 return {kind:"fit",zoom};
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

/** Counter-size the viewport; its text column is held independently. */
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
 * Midpoint of the two contacts, in client px. Pulled out of the router so the
 * one piece of "the pinch-end centroid" that is pure math has a seam a test
 * can reach directly - the router's own release-path ordering (which contact
 * is still live WHEN this is called) is stateful and has to be reasoned about
 * against the router itself (audit-fixes-design.md 5i I2).
 */
export function pinchMidpoint(a: PinchPoint, b: PinchPoint): PinchPoint {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
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
