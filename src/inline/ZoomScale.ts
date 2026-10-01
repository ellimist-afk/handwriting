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

/** An owned transform is not an external-CSS sanity limit. */
export function validCameraScale(scale: number, width = 1, height = 1): boolean {
	return Number.isFinite(scale) && scale > 0 && Number.isFinite(1 / scale) &&
		Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 &&
		Number.isFinite(width / scale) && Number.isFinite(height / scale) &&
		width / scale <= Number.MAX_SAFE_INTEGER && height / scale <= Number.MAX_SAFE_INTEGER &&
		Number.isFinite(width * scale) && Number.isFinite(height * scale) &&
		width * scale <= Number.MAX_SAFE_INTEGER && height * scale <= Number.MAX_SAFE_INTEGER;
}

/** Null means defer this geometry; never substitute a different inverse. */
export function ownedEffectiveScale(inputs: ScaleInputs, owned: number): number | null {
	if (!validCameraScale(owned) || !Number.isFinite(inputs.visualWidth) ||
		!Number.isFinite(inputs.layoutWidth) || inputs.visualWidth <= 0 || inputs.layoutWidth <= 0) return null;
	const combined = inputs.visualWidth / inputs.layoutWidth;
	const external = combined / owned;
	if (!validCameraScale(combined) || external < MIN_SCALE || external > MAX_SCALE) return null;
	return combined;
}

/** Callers validate provenance when adopting geometry, not on each conversion. */
function coherentScale(scale: number): number {
	return Number.isFinite(scale) && scale > 0 && Number.isFinite(1 / scale) ? scale : 1;
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
	return distance / coherentScale(scale);
}

/** The inverse: a note-space distance as it appears on screen. */
export function noteToVisual(distance: number, scale: number): number {
	return distance * coherentScale(scale);
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
 * 300MB on a tablet.
 *
 * WHAT THIS COMMENT USED TO CLAIM, and it was never true: "chosen so no
 * UNZOOMED pane on any plausible display is touched - only magnification can
 * reach it". Full-screen editors pass it unzoomed on ordinary hardware. A
 * 1920x1500 band (a maximised 4K pane at 200% scaling: a 1000px scroller
 * plus `bandFor`'s 250 of margin each way) is 2.9M layout px, which at dpr 2
 * asks for 11.5M device px. The old floor then handed such panes their full
 * device ratio back anyway, so the budget could only ever trade away the
 * plugin's own pinch.
 *
 * The other half of 1.4.12-design.md §14 - a tall band at dpr 3 reaching
 * WebKit's ~16.7M per-canvas ceiling with no zoom at all, 1400x900 already
 * asking 11.3M - is HYPOTHETICAL, and has to be read as one. Every SHIPPING
 * iPad reports devicePixelRatio 2; dpr 3 is iPhone. At dpr 2 an iPad band is
 * ~1.8M CSS px against this budget's 2.5M threshold (MAX_BACKING_AREA /
 * dpr^2), so it never reaches the cap at all.
 *
 * Those figures are arithmetic, not recollection, and this paragraph is why
 * they have to be. The revision before this one cited "a 1920x1720 band ...
 * at dpr 2", which cannot exist: a 4K viewport at 200% is 1920x1080, and a
 * 1720-tall band needs an 1147px scroller (`bandFor`: clientHeight + 2 *
 * clamp(0.25 * clientHeight, 120, 320), so 1.5x the scroller here). A
 * 1920x1720 band IS reachable at 150% scaling - and dpr there is 1.5, so
 * 7.4M device px, comfortably under this budget and never trimmed. Wrong in
 * both directions at once, and it shipped as the justification for a change
 * that cost every large retina desktop 20-40% of its linear ink resolution.
 *
 * ON MOBILE, since that fix, this number is a real ceiling on every axis: a
 * pane over budget rasterises at whatever scale fits, the device ratio
 * included. The cost is bounded and visible - slightly softer ink on the
 * largest, densest panes - and it is exactly the cost the old floor was
 * hiding behind a canvas that might silently never allocate.
 *
 * ON DESKTOP the floor stays, because the ceiling it was hiding does not
 * exist there. Electron has no equivalent of WebKit's silent per-canvas
 * refusal, so resolution a desktop pane gives up here buys nothing at all.
 * Bounding the device ratio everywhere cost a 5K pane at 200% about 30% of
 * its linear ink resolution, and a 6K XDR nearly 40%, to dodge a limit that
 * is not on that machine. `backingScale` takes a `mobile` flag for this.
 */
export const MAX_BACKING_AREA = 10_000_000;

/**
 * The css box an ink canvas is given, and the transform that keeps it on the
 * band, so that the COMPOSITOR sizes its layer by the visual box and not by
 * the band's layout box.
 *
 * Below 1.0 the note viewport lays the editor out at 1/scale and CSS-scales
 * it back down, so a canvas covering the band is `cssW x cssH` LAYOUT px:
 * at 10% about 13,000 x 10,000 for a 1,300 x 1,000 visual band. The backing
 * store is already charged for visual area (`backingScale`), but Chromium
 * sizes the canvas's compositor layer by the element's css box, and the
 * device (Orion, 2026-09-13, DevTools Layers) held five 19,900 x 22,380
 * layers, about 9 GB and 79% of its GPU memory limit, at the far position
 * where every pen frame waited 100-280 ms on the GPU process.
 *
 * So the element's box is the VISUAL size, `cssW * scale x cssH * scale`,
 * and a `scale(1/scale)` transform from the top-left corner stretches it back
 * over the band. Everything drawn into the canvas is unchanged: the backing
 * dimensions, the context transform (device px per layout px) and every
 * coordinate the renderers and the router use are in layout px as before;
 * only the box the compositor measures moves. At 1.0 and above the box is
 * the layout box and the transform is empty, so nothing outside the
 * zoomed-out regime changes at all.
 *
 * `hostZoom` is the other way the host can be shrunk: CSS `zoom` instead of
 * `transform: scale`. Zoom is inherited EFFECTIVE zoom, so the compositor
 * already measures a descendant's css box at the zoomed size - the band's
 * layout box times k IS the visual box - and the counter-scale above would
 * shrink the layer a second time. Under it the canvas is plain: the band's
 * own box, no element transform, nothing for a transform node to attach to.
 */
export function canvasLayerBox(cssW: number, cssH: number, cssScale: number, hostZoom = false): { width: number; height: number; transform: string } {
	const k = Number.isFinite(cssScale) && cssScale > 0 && cssScale < 1 ? cssScale : 1;
	if (k === 1 || hostZoom) return { width: cssW, height: cssH, transform: "" };
	return { width: cssW * k, height: cssH * k, transform: `scale(${1 / k})` };
}

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
 * applies, which is what every pre-existing caller wants. Pass `mobile` for
 * the STRICT form of the cap, which bounds the DEVICE ratio as well as the
 * zoom because iOS is where a canvas can be refused outright; desktop keeps
 * its device pixels and trades away magnification only. Both default off, so
 * a caller that passes neither means exactly what it always meant.
 *
 * The platform arrives as a parameter rather than an `import { Platform }`
 * on purpose: this module has no imports and its tests are pure arithmetic,
 * and the one production call site (`InkOverlay.backingNow`) is already in a
 * file that imports Platform.
 */
export function backingScale(
	dpr: number,
	scale: number,
	layoutW = 0,
	layoutH = 0,
	mobile = false
): number {
	const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
	let b = d * Math.min(coherentScale(scale), MAX_ZOOM_BACKING);
	if (layoutW > 0 && layoutH > 0 && Number.isFinite(layoutW) && Number.isFinite(layoutH)) {
		const area = layoutW * b * layoutH * b;
		if (area > MAX_BACKING_AREA) {
			// The scale at which this pane EXACTLY fills the budget.
			//
			// Written as a plain square root rather than `b * sqrt(MAX/area)`
			// because with `area = layoutW * layoutH * b^2` that expression
			// reduces to exactly this - the `b` cancels. Same number, one
			// fewer place to get it wrong.
			const trimmed = Math.sqrt(MAX_BACKING_AREA / (layoutW * layoutH));
			// ON MOBILE take it flat, which bounds the DEVICE ratio as well
			// as the zoom. That is an iOS fact and not a preference: WebKit
			// refuses a per-canvas allocation past ~16.7M device px and does
			// it SILENTLY, and a tall band at a high dpr can reach that
			// ceiling with no zoom applied at all (1.4.12-design.md §14).
			// This CAN land below the device ratio, and on a big enough pane
			// below 1 - soft ink at a known scale, instead of an allocation
			// WebKit may refuse without saying so.
			//
			// ON DESKTOP floor it at what this pane would use UNZOOMED, so a
			// dense display at 100% keeps every device pixel it has and only
			// magnification is ever traded away. Electron has no equivalent
			// of WebKit's silent refusal, so resolution surrendered here buys
			// nothing: bounding the device ratio on desktop too cost a 5K
			// pane at 200% about 30% of its linear ink resolution for a
			// ceiling that machine does not have. Without this floor the
			// budget quietly downgrades ordinary editors on high-dpi
			// hardware; ZoomScale.test.ts keeps a TRIPWIRE on exactly that,
			// and a change that makes it fail is a question, not a licence to
			// rewrite it.
			b = mobile ? trimmed : Math.max(d * Math.min(1, coherentScale(scale)), trimmed);
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

/**
 * Whether this window's engine reports getBoundingClientRect in zoomed
 * lengths under CSS zoom. WebKit before Safari 26.4 returned them unscaled,
 * the whole rect divided by the element's effective zoom (WebKit bug 77998).
 * The overlay measures its scale as a rect width over offsetWidth, so on that
 * engine a host shrunk with CSS zoom reads 1 at every zoom and pen samples
 * are never divided by it: zoomed out on an iPad, ink lands at the zoom times
 * the pen's distance from the top left of the screen (GitHub #32).
 *
 * Two hidden boxes of one width, one at zoom 2 and one at zoom 1, compared by
 * ratio, so a zoom or transform on the body cancels out. Near 2: scaled. Near
 * 1: unscaled. Anything else, a zero rect or a throw: null, no answer, not
 * remembered, so the next call asks again. A real answer is kept per window.
 */
const zoomRectAnswers = new WeakMap<object, boolean>();
export function zoomScalesClientRects(win: Window | undefined): boolean | null {
	if (!win) return null;
	const kept = zoomRectAnswers.get(win);
	if (kept !== undefined) return kept;
	let answer: boolean | null = null;
	try {
		const doc = win.document, body = doc?.body;
		if (!body || typeof (win as { createDiv?: unknown }).createDiv !== "function") return null;
		const box = (zoom: string): HTMLElement => {
			const el = (win as Window & { createDiv(): HTMLDivElement }).createDiv();
			el.style.cssText = `position:absolute;left:-10000px;top:0;width:100px;height:1px;zoom:${zoom};visibility:hidden;pointer-events:none`;
			body.appendChild(el);
			return el;
		};
		const one = box("1"), two = box("2");
		try {
			const w1 = one.getBoundingClientRect().width, w2 = two.getBoundingClientRect().width;
			const ratio = w1 > 0 && w2 > 0 ? w2 / w1 : NaN;
			if (ratio > 1.5 && ratio < 2.5) answer = true;
			else if (ratio > 0.5 && ratio < 1.5) answer = false;
		} finally {
			one.remove();
			two.remove();
		}
	} catch {
		return null;
	}
	if (answer !== null) zoomRectAnswers.set(win, answer);
	return answer;
}
