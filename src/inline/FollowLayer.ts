/**
 * Scroll-follow for the inline ink layer.
 *
 * The problem it solves: committed ink is rasterized into canvases at a
 * camera, and the camera is only recomputed on the main thread inside
 * repaint(). A scroll moves the TEXT immediately, on the compositor, but
 * the ink canvases keep their old screen position until that repaint runs.
 * The ink therefore floats away from the text during the scroll and jumps
 * back into place when the frame lands. Stored coordinates are never wrong;
 * this is purely when the pixels are moved.
 *
 * The fix is one compositor-cheap style write per scroll event: translate
 * the layer by how far the scroller has moved since the last repaint, so
 * the pixels track the text between repaints. The repaint then redraws at
 * the real camera and zeroes the translate in the same frame, which is why
 * `rebase` is the only place the baseline moves.
 *
 * v0.13.5 built the architecture (`.handwriting-ink-layer`, the baseline, the
 * repaint-time reset) and described this translate, but never implemented
 * it: `layerShifted` was assigned false in three places and true in none,
 * so the reset branch was dead code and the scroll handler only scheduled
 * a repaint. That is the snap.
 *
 * Two rules that are easy to get wrong:
 *
 * - The delta is LAYOUT pixels, straight from `scrollLeft`/`scrollTop`, and
 *   nothing scales it. Not cssScale, not fontZoom, not devicePixelRatio,
 *   not camera.zoom. The layer lives inside whatever visual transform the
 *   editor carries, so the browser applies that scaling to the translate
 *   for us. Multiplying here would double-apply it.
 * - While a stroke owns the frame nothing translates. The pen froze its
 *   coordinate frame at pen-down and every sample maps through that frozen
 *   camera; shifting the layer under it would shear the stroke being drawn.
 *
 * DOM-free by construction (the target is structural), which
 * is what lets the whole cycle be unit-tested. Same reason GuardStyle.ts is
 * shaped this way.
 */

/** The bit of an HTMLElement this needs: somewhere to put a transform. */
export interface FollowTarget {
	style: { transform: string };
	setCssStyles(styles: { transform: string }): void;
}

/** A transform that is exactly "no shift", written once at the boundary. */
export const NO_SHIFT = "translate(0px, 0px)";

export class FollowLayer {
	private baseLeft = 0;
	private baseTop = 0;
	private shiftedFlag = false;
	private paintedLeft = 0;
	private paintedTop = 0;

	/** True while the layer is carrying a scroll translate. */
	get shifted(): boolean {
		return this.shiftedFlag;
	}

	/** The scroll position the next delta is measured from. */
	get baseline(): { left: number; top: number } {
		return { left: this.baseLeft, top: this.baseTop };
	}

	/**
	 * A scroll happened: move the layer by the delta since the last repaint
	 * baseline, immediately. Fractions are kept, because scrollers report
	 * fractional offsets at fractional zoom and rounding here would show up
	 * as ink jitter against the text.
	 */
	follow(layer: FollowTarget | null, scrollLeft: number, scrollTop: number, frameLocked: boolean): void {
		if (frameLocked) return;
		const x = this.baseLeft - scrollLeft;
		const y = this.baseTop - scrollTop;
		const shift = x !== 0 || y !== 0;
		// Write only when there is something to say: a shift to apply, or a
		// previous one to clear. A still scroller repaints often, and an
		// unchanging transform written every frame is a CSSOM touch on the
		// one element the compositor is animating.
		if (layer && (shift || this.shiftedFlag)) {
			layer.setCssStyles({ transform: `translate(${x}px, ${y}px)` });
		}
		this.shiftedFlag = shift;
	}

	/**
	 * The scroll position the camera was computed for, recorded when the
	 * camera is synced and BEFORE the ink is drawn.
	 *
	 * This exists so `rebase` cannot be handed the wrong number. The baseline
	 * has to be the position the pixels actually have; taking it from a fresh
	 * read after drawing records a position they never had, and during a
	 * fling the scroller moves far enough between the two that every later
	 * scroll is short by the difference - ink lagging behind the text and
	 * springing back when the scrolling stops.
	 */
	markPainted(scrollLeft: number, scrollTop: number): void {
		this.paintedLeft = scrollLeft;
		this.paintedTop = scrollTop;
	}

	/**
	 * The repaint boundary. Committed ink has just been redrawn at the camera
	 * synced by `markPainted`, so THAT position becomes the baseline - not
	 * wherever the scroller has reached by now. The caller follows this with
	 * a `follow` at the live position, which is zero in the common case and
	 * carries the fling's remainder when the scroller kept moving.
	 */
	rebase(layer: FollowTarget | null, frameLocked: boolean): void {
		if (frameLocked) return;
		this.baseLeft = this.paintedLeft;
		this.baseTop = this.paintedTop;
		if (this.shiftedFlag && layer) layer.setCssStyles({ transform: NO_SHIFT });
		this.shiftedFlag = false;
	}

	/** The layer element is gone (unmount, file switch). */
	forget(): void {
		this.shiftedFlag = false;
	}
}
