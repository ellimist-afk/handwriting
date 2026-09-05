/**
 * Which part of a pdf page its ink canvases actually cover, and how much
 * resolution that part gets.
 *
 * The problem this replaces: every attached page got ink canvases stretched
 * over the WHOLE page div, and the backing store for them was capped at
 * `MAX_OVERLAY_PX` device pixels. At ordinary zoom that cap never bites. At
 * high zoom a single page is many millions of css px, so the cap divides the
 * resolution down - `sqrt(MAX / area)` device pixels per css pixel, which at
 * 800% on a letter page is well under one - and the ink is rasterised below
 * screen resolution and upscaled. pdf.js's own page canvas has a far larger
 * budget, so the page underneath stayed sharp while the ink on top went soft:
 * "at max zoom, pretty blurry still" (alan, hardware, 2026-09-04).
 *
 * Resolution was never the thing that was scarce. AREA was. A page at 800%
 * is mostly off screen, and the pixels the reader cannot see are the ones
 * eating the budget. So the canvases stop covering the page and cover a BAND
 * instead: the part of the page the viewport is looking at, plus a margin.
 * The band's area is bounded by the VIEWPORT rather than by the zoom, so it
 * stops growing exactly where the cap used to start hurting, and the backing
 * can be a full device pixel per css pixel at any zoom.
 *
 * The band law itself is not re-invented here: `ScrollBand` already decides
 * where a band belongs and when it is worth moving, for the note surface,
 * which solved this same problem when its ink layer moved into the scroller.
 * The margin, the hysteresis and the epsilon are all its rules. What is new
 * is only the last step - intersecting one scroller-wide band with one page's
 * box - because a pdf has many pages inside one scroller where a note has one
 * surface.
 *
 * Pure arithmetic, no DOM, for the reason ScrollBand gives: the rules that
 * decide where ink is drawn should be testable without a viewer.
 */
import { Band, BandViewport, bandFor } from "../inline/ScrollBand";

export type { Band, BandViewport };
export { bandCovers, bandFor, bandMargin, bandNeedsMove } from "../inline/ScrollBand";

/** A page's box in the scroller's CONTENT coordinates, as the probe reports it. */
export interface PageRect {
	leftPx: number;
	topPx: number;
	widthPx: number;
	heightPx: number;
}

/**
 * The band a page's canvases cover, in the PAGE's own css px - the offset an
 * absolutely positioned child of the page div needs, and its size.
 */
export interface PageBandBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** The whole page, for a page that fits inside the band. */
export function wholePage(page: PageRect): PageBandBox {
	return { left: 0, top: 0, width: page.widthPx, height: page.heightPx };
}

/**
 * The four fields of a scroller that only a RESIZE can change.
 *
 * Split out from the scroll offsets because they cost differently, not
 * because one flushes layout and the other does not - in Blink,
 * `scrollTop`/`scrollLeft` go through the same layout update `clientWidth`
 * does. Reading two offsets on an already-clean layout is free; reading four
 * size fields is not, and the size fields are the ones that change only on
 * resize or zoom - which is why they are the ones measured once per sync and
 * cached, leaving the scroll listener's hot path to read only the offsets.
 */
export interface ScrollerSize {
	clientWidth: number;
	clientHeight: number;
	scrollWidth: number;
	scrollHeight: number;
}

/** Measure the four size fields. Forces layout when it is dirty; see above. */
export function scrollerSizeOf(scroller: ScrollerSize): ScrollerSize {
	return {
		clientWidth: scroller.clientWidth || 0,
		clientHeight: scroller.clientHeight || 0,
		scrollWidth: scroller.scrollWidth || 0,
		scrollHeight: scroller.scrollHeight || 0,
	};
}

/** A measured size plus where the scroller is right now. No layout. */
export function viewportAt(size: ScrollerSize, scrollLeft: number, scrollTop: number): BandViewport {
	return {
		scrollLeft: scrollLeft || 0,
		scrollTop: scrollTop || 0,
		clientWidth: size.clientWidth,
		clientHeight: size.clientHeight,
		scrollWidth: size.scrollWidth,
		scrollHeight: size.scrollHeight,
	};
}

/**
 * One scroller-wide band, cut down to one page.
 *
 * Integer edges, and outwards on both: `floor` the near edge and `ceil` the
 * far one. A band whose left is 12.4 css px into the page would put the
 * canvas at a fractional offset while its backing store is a whole number of
 * device pixels, and the half pixel of disagreement is exactly the softness
 * this whole change exists to remove. Rounding OUT rather than to nearest
 * because the band's job is coverage: a band one pixel too big costs a
 * hairline of raster, a band one pixel too small is undrawn ink at an edge.
 *
 * Null when the page is not in the band at all - a page the reader has
 * scrolled away from, which should be holding no pixels rather than a
 * zero-area canvas.
 */
export function pageBandFor(band: Band, page: PageRect): PageBandBox | null {
	if (page.widthPx <= 0 || page.heightPx <= 0) return null;
	if (band.width <= 0 || band.height <= 0) return null;
	const l = Math.max(band.left, page.leftPx);
	const t = Math.max(band.top, page.topPx);
	const r = Math.min(band.left + band.width, page.leftPx + page.widthPx);
	const b = Math.min(band.top + band.height, page.topPx + page.heightPx);
	if (r <= l || b <= t) return null;
	const left = Math.max(0, Math.floor(l - page.leftPx));
	const top = Math.max(0, Math.floor(t - page.topPx));
	const right = Math.min(page.widthPx, Math.ceil(r - page.leftPx));
	const bottom = Math.min(page.heightPx, Math.ceil(b - page.topPx));
	if (right <= left || bottom <= top) return null;
	return { left, top, width: right - left, height: bottom - top };
}

/**
 * Device pixels per css pixel for a canvas of this css size.
 *
 * `dpr` unless the area genuinely will not fit, and that inversion is the
 * point. The old law asked the same question of a whole page, which at high
 * zoom is millions of css px, so the answer was almost always "no" and the
 * ink was drawn soft. Asked of a BAND - viewport-sized plus a margin, a
 * quantity that does not grow with zoom - the answer is "yes" for every
 * plausible pane on every plausible display, and the cap is what it was
 * always meant to be: a backstop against an allocation the browser would
 * refuse (WebKit gives up silently past ~16M px and leaves the canvas blank),
 * not a resolution policy.
 */
export function bandBacking(width: number, height: number, dpr: number, maxPx: number): number {
	const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
	const px = width * height;
	if (px <= 0) return d;
	return px * d * d <= maxPx ? d : Math.sqrt(maxPx / px);
}
