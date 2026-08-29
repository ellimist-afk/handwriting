/**
 * Where the ink canvases sit inside the scroller, and when they move.
 *
 * The problem this replaces: the ink layer used to be a child of `.cm-editor`
 * at `inset: 0` - viewport-anchored, so it did not scroll. Every pixel of its
 * movement had to be written by JavaScript, while the text was moved by the
 * compositor without asking the main thread anything. `FollowLayer` chased
 * that with a per-scroll transform and got closer and closer without ever
 * arriving, because it cannot: reading the scroll offset at frame time is the
 * best a main-thread write can do, and one frame at the fling speeds measured
 * on hardware (~6,800 px/s, 113px per frame) is a very visible band of ink
 * sliding against its text.
 *
 * So the layer moves INTO the scroller and is positioned in content
 * coordinates. The compositor now scrolls ink and text together, the way it
 * scrolls text and images together, and no amount of main-thread lateness can
 * separate them. Position correctness stops depending on timing at all.
 *
 * What lateness costs instead is COVERAGE. The canvases still only cover a
 * window, so a band that has not been repositioned yet runs out of drawn ink
 * at its leading edge. That is why the band is taller than the viewport: the
 * margin is the distance a fling can cover before a late repaint could show
 * anything, and "ink not drawn yet at the very edge" is a far quieter kind of
 * wrong than "all the ink is in the wrong place".
 *
 * The band also gets repositioned RARELY rather than every scroll, which is
 * a straight win elsewhere: any camera motion makes repaint() re-rasterize
 * every visible stroke, and that used to happen on every single scroll event.
 *
 * Pure arithmetic, no DOM, same reason FollowLayer and GuardStyle are shaped
 * this way - the rules that decide where ink is drawn should be testable
 * without an editor.
 */

/** Margin above and below the viewport, as a fraction of viewport height. */
export const BAND_MARGIN_FRACTION = 0.25;
/** Floor, so a short editor pane still has room to scroll into. */
export const BAND_MARGIN_MIN = 120;
/**
 * Ceiling. The margin is raster area on five canvases and it is charged
 * against MAX_BACKING_AREA, so an unbounded fraction would buy scroll headroom
 * by making ink softer at high zoom.
 */
export const BAND_MARGIN_MAX = 320;
/**
 * How far the wanted position must differ before the band is actually moved.
 *
 * Scroll offsets are fractional and `scrollHeight` is a rounded integer, so at
 * the end of a document the wanted position wobbles in its last decimals from
 * one scroll event to the next. Acting on that wobble repositions the band -
 * which moves the camera, and any camera motion re-rasterizes every visible
 * stroke - on every scroll event, at the bottom of every note. Exactly the
 * failure `SCALE_EPSILON` exists for, one measurement over.
 *
 * A whole pixel, because the cost of NOT moving is bounded by the slack, which
 * is never smaller than 60px. Nothing that matters is filtered out.
 */
export const BAND_MOVE_EPSILON = 1;

/** The scroller, as the numbers this needs. All layout px. */
export interface BandViewport {
	scrollLeft: number;
	scrollTop: number;
	clientWidth: number;
	clientHeight: number;
	scrollWidth: number;
	scrollHeight: number;
}

/** The band's box in the scroller's CONTENT coordinates. */
export interface Band {
	left: number;
	top: number;
	width: number;
	height: number;
}

export function emptyBand(): Band {
	return { left: 0, top: 0, width: 0, height: 0 };
}

/**
 * The furthest edge the band may reach, given a reported extent and where the
 * viewport actually sits.
 *
 * The allowance is ONE pixel and the bound matters as much as the allowance.
 * A rounded `scrollHeight` against a fractional `scrollTop` is worth a
 * hairline, and that is all this is for. Letting the viewport's own edge win
 * outright looked equivalent and is not: right after a pinch the client size
 * jumps before the scroll offset is reconciled with it, so `scrollTop +
 * clientHeight` briefly reads far past the end of the document. A band built
 * on that number hangs below the content, and an absolutely positioned child
 * hanging below the content ADDS scroll range - phantom room that the first
 * flick after a zoom falls into, before the next reposition takes it away
 * again (alan, hardware: "first finger scroll after zoom has greater velocity
 * than it should ... works properly after first scroll").
 */
function reachable(reported: number, viewportEdge: number): number {
	return Math.min(Math.max(reported, viewportEdge), reported + 1);
}

export function bandMargin(clientHeight: number): number {
	const want = Math.round(clientHeight * BAND_MARGIN_FRACTION);
	return Math.min(BAND_MARGIN_MAX, Math.max(BAND_MARGIN_MIN, want));
}

/**
 * Where the band wants to be for this viewport.
 *
 * Two clamps, and both of them are load-bearing:
 *
 * - The band never extends past the end of the scrollable content, because an
 *   absolutely positioned child EXTENDS a scroll container's scrollable
 *   overflow. A band hanging below the document would add scroll range, which
 *   would let the viewport move further down, which would move the band and
 *   add more range. Clamping the bottom is what keeps that from running away
 *   - and it also keeps `scrollHeight` a clean number to read, since a band
 *   that never exceeds the content never contributes to it.
 * - The height does NOT depend on the document, only on the viewport. A height
 *   that tracked `scrollHeight` would change on every edit to a short note,
 *   and every change reallocates five backing stores.
 *
 * Horizontal margin is only spent when the content is actually scrollable
 * sideways, which for ordinary notes is never. Ink drawn out to the right is
 * what makes it scrollable, and that is exactly when it is worth paying for.
 */
export function bandFor(v: BandViewport): Band {
	// A background tab keeps its editor alive at zero size. Reporting an empty
	// band is what lets the canvases be released there instead of holding five
	// full-size backings on an invisible surface.
	if (v.clientWidth <= 0 || v.clientHeight <= 0) return emptyBand();
	const margin = bandMargin(v.clientHeight);
	const height = v.clientHeight + margin * 2;
	// `scrollHeight` is reported as a rounded integer while `scrollTop` is
	// fractional, so a scroller can sit a fraction of a pixel past its own
	// reported end. Clamping to the plain number would put the band's bottom
	// edge inside the viewport there - a hairline of missing ink at the very
	// end of a note. Taking whichever bottom is genuinely reachable cannot run
	// away, because a position the viewport has already reached is by
	// definition inside the real scrollable extent.
	const bottom = reachable(v.scrollHeight, v.scrollTop + v.clientHeight);
	const top = Math.min(v.scrollTop - margin, bottom - height);
	const hMargin = v.scrollWidth > v.clientWidth ? margin : 0;
	const width = v.clientWidth + hMargin * 2;
	const right = reachable(v.scrollWidth, v.scrollLeft + v.clientWidth);
	const left = Math.min(v.scrollLeft - hMargin, right - width);
	return { left, top, width, height };
}

/** Is every pixel the viewport shows inside this band? The whole point. */
export function bandCovers(band: Band, v: BandViewport): boolean {
	return (
		band.top <= v.scrollTop &&
		band.left <= v.scrollLeft &&
		band.top + band.height >= v.scrollTop + v.clientHeight &&
		band.left + band.width >= v.scrollLeft + v.clientWidth
	);
}

/**
 * Should the band be moved and redrawn?
 *
 * Hysteresis, not tracking: the band is left alone until the viewport comes
 * within half a margin of an edge. Without that it would move on every scroll
 * event and buy nothing, since moving it is what costs a full re-raster.
 *
 * The `!==` guard ahead of each check is what stops the ends of a document
 * from repainting forever: at the very bottom the wanted position is clamped,
 * so it equals the current one, and no amount of remaining slack asks for a
 * move that would not change anything.
 */
export function bandNeedsMove(current: Band | null, v: BandViewport): boolean {
	if (!current) return true;
	const want = bandFor(v);
	// A size change is a resize, not a scroll: always take it, or the canvases
	// keep a stale box and the zero-size release never happens.
	if (current.width !== want.width || current.height !== want.height) return true;
	const slack = bandMargin(v.clientHeight) / 2;
	if (Math.abs(current.top - want.top) >= BAND_MOVE_EPSILON) {
		const above = v.scrollTop - current.top;
		const below = current.top + current.height - (v.scrollTop + v.clientHeight);
		if (above < slack || below < slack) return true;
	}
	if (Math.abs(current.left - want.left) >= BAND_MOVE_EPSILON) {
		const before = v.scrollLeft - current.left;
		const after = current.left + current.width - (v.scrollLeft + v.clientWidth);
		if (before < slack || after < slack) return true;
	}
	return false;
}
