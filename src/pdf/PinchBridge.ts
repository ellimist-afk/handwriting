/**
 * Two fingers on a pdf, translated into the zoom the viewer anchors right.
 *
 * The viewer owns pinch on this surface (1.4.3, and for good reason on the
 * iPad), but its own pinch re-centres on its idea of an anchor rather than
 * the fingers - zooming out from under the point being pinched. Its
 * ctrl+wheel zoom, meanwhile, anchors at the cursor exactly (verified on
 * glass, 2026-08-30). So this claims two-finger gestures at capture - the
 * palm shield's proven mechanism, starving the viewer's touch handlers and
 * the browser's - and re-issues the pinch as the events the viewer already
 * handles well: synthesized ctrl+wheel at the pinch centroid for scale,
 * scrolling for centroid drift.
 *
 * No internals touched: the bridge speaks to the viewer only in DOM events
 * it publicly listens for, which is what keeps the containment rule intact.
 *
 * Desktop-only, behind the same platform gate as the palm shield: the iPad's
 * native behaviour predates tonight and stays as it is until it is tested as
 * its own platform rather than patched blind.
 */

import { TouchLike } from "../input/PalmShield";

/**
 * How hard a spread change pushes the wheel.
 *
 * The viewer's wheel-zoom steps are its own; this maps ln(spreadRatio) into
 * deltaY so that doubling the finger spread lands in the same territory a
 * few wheel notches would. Felt-tuned on glass rather than derived - the
 * viewer's handler is not ours to read.
 */
export const PINCH_WHEEL_GAIN = 500;

export interface PinchPoint {
	identifier: number;
	clientX: number;
	clientY: number;
}

export function spreadOf(a: PinchPoint, b: PinchPoint): number {
	return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

export function centroidOf(a: PinchPoint, b: PinchPoint): { x: number; y: number } {
	return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

/**
 * Where the scroll must sit after a zoom so the anchored point stays put.
 *
 * `pre` is the scroll before the zoom, `px` the anchor's offset inside the
 * viewport, `f` the scale ratio actually applied. Computed from PRE-zoom
 * scroll absolutely, which makes assigning it idempotent: if the viewer
 * already anchored this zoom itself, the assignment writes the same number.
 * That matters because the viewer anchors REAL wheels and ignored ours -
 * synthesized events evidently skip its correction - so the zoom scaled
 * from wherever the scroll happened to be and the view walked top-left
 * (glass, 2026-08-30).
 */
export function anchorScroll(pre: number, px: number, f: number): number {
	return (pre + px) * f - px;
}

/** deltaY for one move step whose spread grew by `ratio` (>1 = zoom in). */
export function wheelDeltaFor(ratio: number): number {
	if (!Number.isFinite(ratio) || ratio <= 0) return 0;
	// `|| 0` folds the negative zero ln(1) produces - a -0 deltaY is
	// harmless to the viewer but lies to every Object.is comparison.
	return -Math.log(ratio) * PINCH_WHEEL_GAIN || 0;
}

export class PinchBridge {
	private el: HTMLElement | null = null;
	private ids: [number, number] | null = null;
	private lastSpread = 0;
	private lastCentroid = { x: 0, y: 0 };
	/** Gestures bridged since attach, for the diagnostics report. */
	bridged = 0;

	constructor(
		/** The pen always wins: no bridging while a gesture holds the pane. */
		private allowed: () => boolean,
		/** The viewer's current scale, read cheap; null when unknowable. */
		private getScale: () => number | null = () => null
	) {}

	/** A zoom step whose anchor correction is still owed. */
	private pending: {
		preL: number;
		preT: number;
		px: number;
		py: number;
		preScale: number;
	} | null = null;

	/**
	 * Settle the owed correction against the scale the viewer actually
	 * applied. Sync when the viewer zoomed synchronously; retried once on
	 * the next frame when it deferred.
	 */
	private settle(): void {
		const el = this.el;
		const p = this.pending;
		if (!el || !p) return;
		const scale = this.getScale();
		if (scale === null || scale === p.preScale) return;
		this.pending = null;
		const f = scale / p.preScale;
		el.scrollLeft = anchorScroll(p.preL, p.px, f);
		el.scrollTop = anchorScroll(p.preT, p.py, f);
	}

	private points(e: TouchEvent): PinchPoint[] {
		return Array.from(e.touches).map((t) => ({
			identifier: t.identifier,
			clientX: t.clientX,
			clientY: t.clientY,
		}));
	}

	private claim(e: TouchEvent): void {
		e.preventDefault();
		e.stopImmediatePropagation();
	}

	private onStart = (e: TouchEvent): void => {
		if (!this.allowed()) return;
		const pts = this.points(e);
		if (pts.length !== 2) {
			// A third finger ends the bridge; whatever the browser makes of
			// three is not a pinch.
			this.ids = null;
			return;
		}
		this.ids = [pts[0]!.identifier, pts[1]!.identifier];
		this.lastSpread = spreadOf(pts[0]!, pts[1]!);
		this.lastCentroid = centroidOf(pts[0]!, pts[1]!);
		this.bridged++;
		this.claim(e);
	};

	private onMove = (e: TouchEvent): void => {
		if (!this.ids) return;
		const pts = this.points(e);
		if (pts.length !== 2) return;
		const spread = spreadOf(pts[0]!, pts[1]!);
		const centroid = centroidOf(pts[0]!, pts[1]!);
		this.claim(e);
		const el = this.el;
		if (!el) return;
		// A correction still owed from the previous step lands first, so its
		// pre-zoom baseline cannot go stale under this step's pan.
		this.settle();
		// Pan: the content follows the fingers between zoom steps.
		el.scrollLeft -= centroid.x - this.lastCentroid.x;
		el.scrollTop -= centroid.y - this.lastCentroid.y;
		// Scale, through the viewer's wheel path - with the anchor held by
		// OUR correction, since the viewer only anchors trusted wheels.
		if (this.lastSpread > 0 && spread > 0) {
			const deltaY = wheelDeltaFor(spread / this.lastSpread);
			const preScale = this.getScale();
			if (deltaY !== 0 && preScale !== null) {
				const rect = el.getBoundingClientRect();
				this.pending = {
					preL: el.scrollLeft,
					preT: el.scrollTop,
					px: centroid.x - rect.left,
					py: centroid.y - rect.top,
					preScale,
				};
				el.dispatchEvent(
					new WheelEvent("wheel", {
						clientX: centroid.x,
						clientY: centroid.y,
						deltaY,
						deltaMode: 0,
						ctrlKey: true,
						bubbles: true,
						cancelable: true,
					})
				);
				// Sync if the viewer zoomed in the dispatch; one frame later
				// if it deferred.
				this.settle();
				if (this.pending) {
					el.ownerDocument.defaultView?.requestAnimationFrame(() => this.settle());
				}
			}
		}
		this.lastSpread = spread;
		this.lastCentroid = centroid;
	};

	private onEnd = (e: TouchEvent): void => {
		if (!this.ids) return;
		for (const t of Array.from(e.changedTouches)) {
			if (this.ids.includes(t.identifier)) {
				this.ids = null;
				this.claim(e);
				return;
			}
		}
	};

	attach(el: HTMLElement): void {
		this.dispose();
		this.el = el;
		const opts = { capture: true, passive: false } as const;
		el.addEventListener("touchstart", this.onStart, opts);
		el.addEventListener("touchmove", this.onMove, opts);
		el.addEventListener("touchend", this.onEnd, opts);
		el.addEventListener("touchcancel", this.onEnd, opts);
	}

	dispose(): void {
		if (!this.el) return;
		const opts = { capture: true } as const;
		this.el.removeEventListener("touchstart", this.onStart, opts);
		this.el.removeEventListener("touchmove", this.onMove, opts);
		this.el.removeEventListener("touchend", this.onEnd, opts);
		this.el.removeEventListener("touchcancel", this.onEnd, opts);
		this.el = null;
		this.ids = null;
	}
}

// Referenced so the import shape matches the shield's; the bridge itself
// never inspects radii - two fingers are two fingers whatever their size.
export type { TouchLike };
