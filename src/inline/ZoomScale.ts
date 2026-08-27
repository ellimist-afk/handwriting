/**
 * Effective editor scale: the one number that reconciles the two pixel units
 * the inline overlay has to live in.
 *
 * Obsidian's Ctrl+/Ctrl- is Electron `webFrame` page zoom: CSS pixels stay
 * numerically consistent and `devicePixelRatio` changes, so layout px and
 * visual px agree and this scale is 1. But the moment anything applies a CSS
 * `zoom` or `transform: scale()` to an ancestor of the editor (Obsidian
 * itself, a theme, or a zoom plugin), the two units diverge:
 *
 *   layout px  what the element's own box is measured in (offsetWidth),
 *              what a canvas's internal coordinate space uses, and what
 *              note-surface ink coordinates are persisted in.
 *   visual px  what getBoundingClientRect() and PointerEvent.clientX report
 *              (the transformed, on-screen geometry).
 *
 * Every geometry read the overlay makes is a rect or a clientX, in visual px,
 * while ink is stored and drawn in layout px. With no scale factor between
 * them, ink stops tracking the text the instant the editor is scaled. That is
 * the whole bug, and this is the whole fix: measure the ratio, divide by it.
 *
 * Nothing here touches persistence. Note-space coordinates are logical CSS px
 * at scale 1, exactly as before; scale enters only where screen geometry is
 * converted to note space and back.
 */

/** Scales outside this range are nonsense (a collapsed or hidden editor). */
const MIN_SCALE = 0.05;
const MAX_SCALE = 20;

export interface ScaleInputs {
	/** Width from getBoundingClientRect(), in visual px. */
	visualWidth: number;
	/** offsetWidth, in layout px, untransformed. */
	layoutWidth: number;
	/** CodeMirror's own view.scaleX, when available. */
	cmScaleX?: number;
}

/**
 * Visual px per layout px. 1 when nothing is scaled (page zoom included, since
 * page zoom scales both units identically).
 *
 * Measured from the overlay element itself rather than trusting one source:
 * the ratio of its transformed rect to its untransformed box is true for CSS
 * `zoom` and `transform` alike. CodeMirror's `scaleX` is the fallback for the
 * degenerate case where the element has no layout width to measure against.
 */
export function effectiveScale(inputs: ScaleInputs): number {
	const { visualWidth, layoutWidth, cmScaleX } = inputs;
	if (
		Number.isFinite(visualWidth) &&
		Number.isFinite(layoutWidth) &&
		layoutWidth > 0 &&
		visualWidth > 0
	) {
		return clampScale(visualWidth / layoutWidth);
	}
	if (cmScaleX !== undefined && Number.isFinite(cmScaleX) && cmScaleX > 0) {
		return clampScale(cmScaleX);
	}
	return 1;
}

export function clampScale(scale: number): number {
	if (!Number.isFinite(scale) || scale <= 0) return 1;
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Convert an on-screen distance to note space.
 *
 * Used for pointer positions (a clientX delta from the overlay's rect) and for
 * every constant that is defined in screen terms: the eraser's radius, the
 * selection grab pad, the lasso's minimum vertex spacing. Those must stay the
 * same size under the user's finger at any zoom, which means shrinking in note
 * space as the editor grows.
 */
export function visualToNote(distance: number, scale: number): number {
	return distance / clampScale(scale);
}

/** The inverse: a note-space distance as it appears on screen. */
export function noteToVisual(distance: number, scale: number): number {
	return distance * clampScale(scale);
}

/**
 * The device-pixel factor a canvas needs so its layout-px coordinate space
 * still rasterises 1:1 with physical pixels when the editor is scaled.
 */
/**
 * How much of the ZOOM may be spent on resolution. Past this the ink is
 * rasterised below the painted size and upscaled by the transform: visibly
 * softer at high magnification, which is a far better failure than the
 * alternative below.
 */
export const MAX_ZOOM_BACKING = 2;

/**
 * Total device pixels ONE canvas may claim.
 *
 * WebKit refuses to allocate much past 16M and does it SILENTLY - the canvas
 * simply stays blank, with no error to find it by. The budget here is lower
 * than that limit on purpose, because five of these exist per editor
 * (committed, wet, tail, and the two highlighter layers): at 4 bytes a pixel
 * this ceiling is about 200MB for the set, and the naive limit would be over
 * 300MB on a tablet. Chosen so no UNZOOMED pane on any plausible display is
 * touched - only magnification can reach it.
 */
export const MAX_BACKING_AREA = 10_000_000;

/**
 * The device-pixel factor a canvas needs so its layout-px coordinate space
 * still rasterises 1:1 with physical pixels when the editor is scaled -
 * bounded, because 1:1 is not always affordable.
 *
 * Pinch zoom is a transform on the editor, so `effectiveScale` measures it
 * and the backing would follow it multiplicatively: at 4x on a dpr-2 tablet
 * that is 8x linear, 64x the pixels, across five canvases. iPadOS would
 * refuse the allocation and the ink would simply vanish at high zoom, with
 * no error to find it by. So the zoom's contribution is capped, and an
 * absolute area budget backstops it for panes large enough to blow the
 * budget on their own. Ink that is soft at 4x is a non-event; ink that
 * disappears is a bug report nobody can reproduce.
 *
 * Pass the layout box to get the area cap; without it only the zoom cap
 * applies, which is what every pre-existing caller wants.
 */
export function backingScale(
	dpr: number,
	scale: number,
	layoutW = 0,
	layoutH = 0
): number {
	const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
	let b = d * Math.min(clampScale(scale), MAX_ZOOM_BACKING);
	if (layoutW > 0 && layoutH > 0 && Number.isFinite(layoutW) && Number.isFinite(layoutH)) {
		const area = layoutW * b * layoutH * b;
		if (area > MAX_BACKING_AREA) {
			// Only the ZOOM's share of the resolution is ever spent. The
			// floor is what this pane would use unzoomed, so a dense display
			// (dpr 3 at 100%) keeps every device pixel it has today and only
			// magnification can be traded away. Without the floor the budget
			// quietly downgraded ordinary editors on high-dpi hardware -
			// caught by the test that pins exactly that.
			const floor = d * Math.min(1, clampScale(scale));
			b = Math.max(floor, b * Math.sqrt(MAX_BACKING_AREA / area));
		}
	}
	return b > 0 && Number.isFinite(b) ? b : 1;
}

/**
 * Font-zoom factor: the THIRD zoom mechanism (v0.13.0).
 *
 * Obsidian's "Quick font size adjustment" (Ctrl+scroll / touchpad pinch,
 * which Windows delivers as ctrl+wheel) changes the editor's base FONT
 * SIZE. That is a reflow, not a geometric zoom: devicePixelRatio does not
 * move (so the page-zoom media query never fires) and no CSS transform
 * appears (so the measured visual/layout scale stays 1). The two
 * mechanisms v0.11.2 handles both stay silent while the text grows, and
 * ink used to stay frozen at CSS-px size.
 *
 * The view-transform answer: treat the ratio of the current editor font
 * size to the size at overlay mount as a zoom factor and fold it into the
 * effective scale. Ink scales continuously and stays anchored to the note
 * origin; stored stroke coordinates are never rewritten; returning to the
 * mount-time font size makes the factor exactly 1 again (ratio of absolute
 * values, so nothing accumulates). Cross-session font changes keep their
 * pre-existing semantics: a session opened at some font size renders ink
 * 1:1 at that size.
 */
export function fontZoomFactor(currentFontPx: number, referenceFontPx: number): number {
	if (!Number.isFinite(currentFontPx) || currentFontPx <= 0) return 1;
	if (!Number.isFinite(referenceFontPx) || referenceFontPx <= 0) return 1;
	const r = currentFontPx / referenceFontPx;
	if (!Number.isFinite(r) || r <= 0) return 1;
	return Math.min(Math.max(r, MIN_SCALE), MAX_SCALE);
}
