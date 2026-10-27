/**
 * A note's own Reading view draws only the part of its ink that is on screen, at the display's ratio.
 *
 * The whole-box layer is held to an area budget (`embedInkScale`), so a huge note (an Infinite Canvas note spanning
 * thousands of px both ways) came out as a blown-up thumbnail: 0.27 device px per css px on a 1.83 display. A Reading
 * view root over that budget instead draws a tile: the scroller's visible rect inside the ink box, grown a quarter
 * viewport each side, against a budget that a viewport always fits. Scrolling repaints the tile only once the visible
 * rect leaves it.
 *
 * Pure geometry only; the paint and the scroll watch live in EmbedInk.ts.
 */

/** Device px a Reading view tile may hold: 64 MB of RGBA on desktop, half that on mobile. */
export const TILE_PX = 16_000_000;
export const TILE_PX_MOBILE = 8_000_000;

/** A rect in the ink box's own css px: 0, 0 is the box's top-left. */
export interface InkRect { x: number; y: number; w: number; h: number }

/**
 * A painted tile: its css rect inside the ink box, the device px per css px it is drawn at, and its backing store's
 * origin and size in device px. `bx`, `by` are whole device px, so two tiles of one box at one scale differ by a whole
 * pixel shift and a stroke lands on the same device px in either. With scale = dpr the canvas's fractional css offset
 * (bx / scale) lands on a whole device px, so a stroke sits on the same device px as the whole-box layer would draw it.
 */
export interface InkTile extends InkRect { scale: number; bx: number; by: number; bw: number; bh: number }

/** Pure: does a root draw a tile? Only a note's own Reading view, and only when the whole box would be drawn under the display's ratio. */
export function embedInkUsesTile(readingView: boolean, wholeScale: number, dpr: number): boolean {
	return readingView && wholeScale < dpr;
}

/** Pure: the part of the ink box the scroller shows, or null when none of it is on screen. */
export function embedInkVisible(box: { w: number; h: number }, view: InkRect): InkRect | null {
	const x0 = Math.max(0, view.x), y0 = Math.max(0, view.y);
	const x1 = Math.min(box.w, view.x + view.w), y1 = Math.min(box.h, view.y + view.h);
	if (x1 <= x0 || y1 <= y0) return null;
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Pure: the tile for this view of the box. The visible rect grown a quarter viewport each side and cut to the box,
 * scaled by `scaleOf` (the layer's own function against the tile budget) at the grown view's size, so every tile of
 * one view size shares one scale, its origin and far edge moved out to whole device px. Null when none of the box is on screen.
 */
export function embedInkTile(
	box: { w: number; h: number },
	view: InkRect,
	scaleOf: (w: number, h: number) => number
): InkTile | null {
	if (!embedInkVisible(box, view)) return null;
	const mx = view.w / 4, my = view.h / 4;
	const x0 = Math.max(0, Math.floor(view.x - mx)), y0 = Math.max(0, Math.floor(view.y - my));
	const x1 = Math.min(box.w, Math.ceil(view.x + view.w + mx)), y1 = Math.min(box.h, Math.ceil(view.y + view.h + my));
	// Scaled as the grown view, before the box's edge cuts it: a cut tile must not draw finer than an interior one when
	// the budget binds, or a repaint across the edge moves every stroke by a part of a device px.
	const scale = scaleOf(view.w + view.w / 2, view.h + view.h / 2);
	const bx = Math.floor(x0 * scale), by = Math.floor(y0 * scale);
	const bw = Math.max(1, Math.ceil(x1 * scale) - bx), bh = Math.max(1, Math.ceil(y1 * scale) - by);
	return { x: bx / scale, y: by / scale, w: bw / scale, h: bh / scale, scale, bx, by, bw, bh };
}

/** Pure: does the painted tile still hold everything the view shows? A view showing none of the box needs no repaint. */
export function embedInkTileHolds(tile: InkTile | null, box: { w: number; h: number }, view: InkRect): boolean {
	const seen = embedInkVisible(box, view);
	if (!seen) return true;
	if (!tile) return false;
	return seen.x >= tile.x && seen.y >= tile.y && seen.x + seen.w <= tile.x + tile.w && seen.y + seen.h <= tile.y + tile.h;
}
