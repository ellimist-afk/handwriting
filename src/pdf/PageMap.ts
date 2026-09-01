/**
 * The PDF page coordinate model: where a point on screen lives on a page, and
 * where a point on a page belongs on screen.
 *
 * Ink is stored per page, in PDF POINTS from the page's top-left corner. Not
 * in screen pixels, which change with every zoom; not in the scroller's
 * content coordinates, which change with every page above it re-laying out;
 * and not in PDF's own bottom-left convention, because every other coordinate
 * in this plugin counts y downward and one file should not flip that.
 *
 * The conversion rests on one measured fact (M0, see PdfViewerProbe):
 *
 *     page size in points = pageDiv.clientWidth / --scale-factor
 *
 * verified zoom-invariant across a 3.5x range and checked against a document
 * whose MediaBox was known exactly. Everything here is that division and its
 * inverse, kept pure so the arithmetic can be tested without a viewer.
 *
 * The other M0 fact that shapes this: page divs are NOT virtualized. All of
 * them exist, with stable scroll-independent offsets, so any page's geometry
 * can be computed whether or not it is on screen - which is what lets ink be
 * placed on a page nobody is looking at.
 */

/** A page div as measured, in the scroller's content coordinates. */
export interface PageBox {
	pageNumber: number;
	leftPx: number;
	topPx: number;
	widthPx: number;
	heightPx: number;
}

/** A point on a specific page, in points from that page's top-left. */
export interface PagePoint {
	pageNumber: number;
	x: number;
	y: number;
}

/** Page size in points, from the measured box and the viewer's scale. */
export function pageSizePt(box: PageBox, scale: number): { w: number; h: number } | null {
	if (!Number.isFinite(scale) || scale <= 0) return null;
	return { w: box.widthPx / scale, h: box.heightPx / scale };
}

/**
 * Scroller-content coordinates to a point on this page.
 *
 * Returns a point even when it falls OUTSIDE the page box - negative, or past
 * the edge. That is deliberate: a stroke that wanders off the page keeps
 * honest coordinates rather than being silently clamped into a shape the user
 * did not draw. Deciding what to do about it is `strokePage`'s job, once, at
 * the start of a stroke.
 */
export function toPagePoint(box: PageBox, scale: number, contentX: number, contentY: number): PagePoint | null {
	if (!Number.isFinite(scale) || scale <= 0) return null;
	return {
		pageNumber: box.pageNumber,
		x: (contentX - box.leftPx) / scale,
		y: (contentY - box.topPx) / scale,
	};
}

/** The inverse: a stored page point back to scroller-content coordinates. */
export function fromPagePoint(box: PageBox, scale: number, x: number, y: number): { x: number; y: number } {
	return { x: box.leftPx + x * scale, y: box.topPx + y * scale };
}

/** Is this content point inside the page's box? */
export function boxContains(box: PageBox, contentX: number, contentY: number): boolean {
	return (
		contentX >= box.leftPx &&
		contentX <= box.leftPx + box.widthPx &&
		contentY >= box.topPx &&
		contentY <= box.topPx + box.heightPx
	);
}

/**
 * Which page a content point belongs to.
 *
 * Exact hit first. Failing that - the point is in the gap between pages, or
 * past the last one - the NEAREST page by vertical distance, because a pen
 * that starts a hair above a page still means that page. Null only for an
 * empty list.
 */
export function pageAt(boxes: readonly PageBox[], contentX: number, contentY: number): PageBox | null {
	let best: PageBox | null = null;
	let bestDist = Infinity;
	for (const box of boxes) {
		if (boxContains(box, contentX, contentY)) return box;
		const above = box.topPx - contentY;
		const below = contentY - (box.topPx + box.heightPx);
		const dist = Math.max(0, above, below);
		if (dist < bestDist) {
			bestDist = dist;
			best = box;
		}
	}
	return best;
}

/**
 * The page a whole stroke belongs to: the one its FIRST sample landed on.
 *
 * A stroke crossing a page boundary is something users will do, and every
 * alternative is worse than this one. Splitting it makes one gesture into two
 * objects that erase and undo separately. Letting it belong to both duplicates
 * it. Re-deciding per sample makes a stroke change owner halfway through and
 * tear. Clamping to the starting page means a descender that overruns the page
 * edge stays part of the letter it belongs to, and the only cost is that it is
 * clipped where the page ends - which is what a real page does to real ink.
 */
export function strokePage(boxes: readonly PageBox[], firstX: number, firstY: number): PageBox | null {
	return pageAt(boxes, firstX, firstY);
}

/**
 * Pages worth carrying an overlay, given which ones the viewer has rendered.
 *
 * Mirrors the viewer instead of inventing a policy: M0 found pdf.js keeps
 * about five canvases around the viewport (plus page 1) while retaining all
 * hundred divs. Following its own answer means inheriting thresholds that are
 * already tuned, and drifting with it rather than away from it.
 */
export function livePages(boxes: readonly PageBox[], hasCanvas: (page: number) => boolean): PageBox[] {
	return boxes.filter((b) => hasCanvas(b.pageNumber));
}

/**
 * The crop for a snip: the selection's box padded a little, clamped to the
 * page, and the scale capped so the output AREA stays within `capPx`. Pure
 * for the same reason as everything else here - the numbers can be checked
 * without a viewer.
 *
 * Area, not longest side: what a canvas costs is its pixel count, and a
 * per-side cap lets a page-shaped crop reach three or four times the budget
 * the overlays themselves are held to. Same shape of limit as MAX_OVERLAY_PX
 * so the two cannot drift apart in kind.
 *
 * Null when the box misses the page entirely or any input is degenerate: a
 * snip of nothing is a caller bug, not an empty image.
 */
export function snipViewport(
	b: { x: number; y: number; width: number; height: number },
	padPt: number,
	wPt: number,
	hPt: number,
	pxPerPt: number,
	capPx: number
): { x0: number; y0: number; x1: number; y1: number; scale: number } | null {
	if (!(wPt > 0) || !(hPt > 0) || !(pxPerPt > 0) || !(capPx > 0)) return null;
	const x0 = Math.max(0, b.x - padPt);
	const y0 = Math.max(0, b.y - padPt);
	const x1 = Math.min(wPt, b.x + b.width + padPt);
	const y1 = Math.min(hPt, b.y + b.height + padPt);
	if (!(x1 > x0) || !(y1 > y0)) return null;
	let scale = pxPerPt;
	const area = (x1 - x0) * scale * ((y1 - y0) * scale);
	if (area > capPx) scale *= Math.sqrt(capPx / area);
	return { x0, y0, x1, y1, scale };
}
