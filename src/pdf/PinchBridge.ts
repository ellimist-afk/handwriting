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

export class PinchBridge {
	private el: HTMLElement | null = null;
	private ids: [number, number] | null = null;
	private startSpread = 0;
	/** The element the live transform rides on: the viewer's content. */
	private contentEl: HTMLElement | null = null;
	/** The gesture's accumulated zoom, applied as CSS until the commit. */
	private liveRatio = 1;
	/**
	 * The centre is LOCKED where the pinch began - the note surface's rule
	 * ("pinch anchors where it started"), adopted here on Alan's call
	 * (2026-08-31): following the fingers read as the page wandering while
	 * zooming. Finger drift is ignored; every step anchors to this point.
	 */
	private startCentroid = { x: 0, y: 0 };
	/**
	 * ln(scale)/deltaY, learned from every commit and KEPT between
	 * gestures: the viewer's response fits no clean model (measured 0.0019
	 * to 0.0043 in one session), but it is locally consistent - so the
	 * previous pinch's measurement is the best guess for this one.
	 *
	 * One gain PER DIRECTION, because the measured spread is largely a
	 * direction split: with a single k, a zoom-out pinch overwrote it with
	 * the out-gain and the next zoom-in flew long on it (glass,
	 * 2026-08-31: "snap zooms in further"). Each direction learns only
	 * from its own landings.
	 */
	private kIn = 0.0035;
	private kOut = 0.0035;

	/** Gestures bridged since attach, for the diagnostics report. */
	bridged = 0;

	constructor(
		/** The pen always wins: no bridging while a gesture holds the pane. */
		private allowed: () => boolean,
		/** The viewer's current scale, read cheap; null when unknowable. */
		private getScale: () => number | null = () => null
	) {}

	/**
	 * A zoom step whose anchor correction is still owed: the anchored point
	 * measured as an offset INTO A PAGE, not into the scroller. A scroll
	 * formula assumed the content scales about the scroller's origin, but
	 * zoomed far out the page floats inside centering margins that do not
	 * scale with it - the miss was margin x zoom, largest exactly on a big
	 * zoom in from far away (glass, 2026-08-31). A page's own box scales
	 * rigidly, so an offset into the page can be scaled honestly, and
	 * re-measuring the page after the zoom prices the margins in for free.
	 */
	private pending: {
		pageNo: string;
		ax: number;
		ay: number;
		cx: number;
		cy: number;
		preScale: number;
	} | null = null;

	/** The page under the pinch centre, pre-zoom - the anchor's home. */
	private armAnchor(preScale: number): void {
		this.pending = null;
		const el = this.el;
		if (!el) return;
		const cx = this.startCentroid.x;
		const cy = this.startCentroid.y;
		let best: { pageNo: string; ax: number; ay: number } | null = null;
		let bestDist = Infinity;
		for (const page of Array.from(el.querySelectorAll<HTMLElement>("div.page[data-page-number]"))) {
			const pageNo = page.getAttribute("data-page-number");
			if (pageNo === null) continue;
			const r = page.getBoundingClientRect();
			const dist = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
			if (dist < bestDist) {
				bestDist = dist;
				best = { pageNo, ax: cx - r.left, ay: cy - r.top };
			}
		}
		if (best) this.pending = { ...best, cx, cy, preScale };
	}

	/**
	 * Settle the owed correction against the zoom the viewer actually
	 * applied: find the anchor page again, see where the anchored point
	 * landed, and scroll the error away. Sync when the viewer zoomed
	 * synchronously; retried on the next frame when it deferred. Needed at
	 * all because the viewer anchors REAL wheels and ignores ours -
	 * synthesized events evidently skip its correction (glass, 2026-08-30).
	 */
	private settle(): void {
		const el = this.el;
		const p = this.pending;
		if (!el || !p) return;
		const scale = this.getScale();
		if (scale === null || scale === p.preScale) return;
		this.pending = null;
		const page = el.querySelector<HTMLElement>(`div.page[data-page-number="${p.pageNo}"]`);
		if (!page) return;
		const f = scale / p.preScale;
		const r = page.getBoundingClientRect();
		el.scrollLeft += r.left + p.ax * f - p.cx;
		el.scrollTop += r.top + p.ay * f - p.cy;
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
		this.startSpread = spreadOf(pts[0]!, pts[1]!);
		this.startCentroid = centroidOf(pts[0]!, pts[1]!);
		this.liveRatio = 1;
		// The gesture is a TRANSFORM; the wheel comes once, at the end.
		// Stepwise wheels re-laid the document out on every finger move -
		// pdf.js rebuilds pages per zoom step - and the pinch felt like it
		// was climbing stairs. Scaling the viewer's content in CSS costs a
		// composite per frame, and the single commit re-renders sharp.
		const el = this.el;
		if (el) {
			this.contentEl =
				el.querySelector<HTMLElement>(".pdfViewer") ??
				(el.firstElementChild as HTMLElement | null);
			if (this.contentEl) {
				const rect = el.getBoundingClientRect();
				const ox = this.startCentroid.x - rect.left + el.scrollLeft;
				const oy = this.startCentroid.y - rect.top + el.scrollTop;
				this.contentEl.setCssStyles({
					transformOrigin: `${ox}px ${oy}px`,
					willChange: "transform",
				});
			}
		}
		this.bridged++;
		this.claim(e);
	};

	private onMove = (e: TouchEvent): void => {
		if (!this.ids) return;
		const pts = this.points(e);
		if (pts.length !== 2) return;
		this.claim(e);
		const spread = spreadOf(pts[0]!, pts[1]!);
		if (this.startSpread <= 0 || spread <= 0 || !this.contentEl) return;
		// Soft bounds: the viewer clamps real zoom anyway; the preview
		// should not sail past anything the commit can honour.
		this.liveRatio = Math.min(6, Math.max(0.25, spread / this.startSpread));
		this.contentEl.setCssStyles({ transform: `scale(${this.liveRatio})` });
		// The gain is measured INSIDE the first pinch, once the gesture has
		// crossed the dead-zone and declared its direction. An idle-time
		// calibration blip did the same measurement at pane-open and was
		// visible - any synthesized zoom re-rasterizes the page, and a page
		// twitching at rest reads as a bug (glass, 2026-08-31). Under two
		// moving fingers the same twitch is part of the gesture.
		if (!this.calibrated && !this.probing && Math.abs(Math.log(this.liveRatio)) > 0.08) {
			this.probing = true;
			this.probe(this.liveRatio > 1);
		}
	};

	private onEnd = (e: TouchEvent): void => {
		if (!this.ids) return;
		for (const t of Array.from(e.changedTouches)) {
			if (this.ids.includes(t.identifier)) {
				this.ids = null;
				this.claim(e);
				this.commit();
				return;
			}
		}
	};

	/**
	 * The commit, kept deliberately SIMPLE: drop the preview, fire ONE
	 * wheel sized by the learned gain, measure, learn, stop.
	 *
	 * Every cleverer design was tried on glass and flickered worse: a
	 * probe-then-burst staircase, an adaptive loop, a compensating
	 * transform that pdf.js stomped mid-zoom. One transition from the
	 * previewed size to the real one is honest and calm; and because the
	 * gain persists between gestures, the landing error shrinks to a
	 * whisker after the first pinch of a session.
	 */
	private commit(): void {
		const el = this.el;
		const content = this.contentEl;
		this.contentEl = null;
		const ratio = this.liveRatio;
		this.liveRatio = 1;
		content?.setCssStyles({ transform: "", willChange: "", transformOrigin: "" });
		if (!el) return;
		// Dead-zone: a very brief pinch reads as ratio ~1; any wheel would
		// still zoom. Nothing happened.
		if (Math.abs(Math.log(ratio)) < 0.08) return;
		const preScale = this.getScale();
		if (preScale === null) return;
		const win = el.ownerDocument.defaultView ?? window;
		const zoomIn = ratio > 1;
		const k = zoomIn ? this.kIn : this.kOut;
		const delta = -Math.log(ratio) / k;
		this.armAnchor(preScale);
		el.dispatchEvent(
			new WheelEvent("wheel", {
				// The locked centre, so a viewer that anchors trusted
				// wheels itself agrees with our correction about where.
				clientX: this.startCentroid.x,
				clientY: this.startCentroid.y,
				deltaY: delta,
				deltaMode: 0,
				ctrlKey: true,
				bubbles: true,
				cancelable: true,
			})
		);
		this.settle();
		win.requestAnimationFrame(() => this.settle());
		// Learn for next time; never correct THIS time. A pane rebound
		// inside the window reads as a different viewer: no learning
		// across it.
		win.setTimeout(() => {
			if (this.el !== el) return;
			this.settle();
			const actual = this.getScale();
			if (actual === null) return;
			const observed = Math.log(actual / preScale);
			if (Math.abs(observed) > 1e-4 && Math.abs(delta) > 1) {
				const learned = Math.abs(observed / delta);
				if (zoomIn) this.kIn = learned;
				else this.kOut = learned;
				this.calibrated = true;
			}
		}, 120);
	}

	/** True once k comes from a measurement, not the seed. */
	private calibrated = false;
	/** True once this pane's one mid-gesture probe has been spent. */
	private probing = false;

	/**
	 * One small zoom in the gesture's own direction, fired mid-pinch, so
	 * the commit flies on a measured gain the very first time. This used
	 * to run at pane-open as a blip-and-restore, and it showed: any
	 * synthesized zoom makes the viewer re-rasterize, and a page twitching
	 * at rest reads as a bug (alan, 2026-08-31, twice). Under two moving
	 * fingers the same twitch is part of the gesture. The 3% it adds is
	 * never restored - the commit reads the scale fresh at release and
	 * aims relative to it, so the pinch simply absorbs it.
	 */
	private probe(zoomIn: boolean): void {
		const el = this.el;
		if (!el) return;
		const pre = this.getScale();
		if (pre === null) return;
		const delta = (zoomIn ? -1 : 1) * (0.03 / (zoomIn ? this.kIn : this.kOut));
		el.dispatchEvent(
			new WheelEvent("wheel", {
				clientX: this.startCentroid.x,
				clientY: this.startCentroid.y,
				deltaY: delta,
				deltaMode: 0,
				ctrlKey: true,
				bubbles: true,
				cancelable: true,
			})
		);
		const win = el.ownerDocument.defaultView ?? window;
		win.setTimeout(() => {
			// Not across a rebind, and not once a commit is in flight - a
			// released pinch's own wheel would be read into the measurement.
			// The landing teaches instead then, as it always has.
			if (this.el !== el || this.pending !== null) return;
			const after = this.getScale();
			if (after === null) return;
			const moved = Math.log(after / pre);
			// Nothing (a zoom bound), or far more than our 3% (a commit or a
			// real wheel landed inside the window): nothing usable measured.
			if (Math.abs(moved) <= 1e-4 || Math.abs(moved) > 0.1) return;
			const k = Math.abs(moved / delta);
			if (zoomIn) this.kIn = k;
			else this.kOut = k;
			this.calibrated = true;
		}, 120);
	}

	attach(el: HTMLElement): void {
		this.dispose();
		this.el = el;
		// A fresh binding gets a fresh probe; the learned gains survive on
		// purpose - the viewer is the same viewer.
		this.probing = false;
		const opts = { capture: true, passive: false } as const;
		el.addEventListener("touchstart", this.onStart, opts);
		el.addEventListener("touchmove", this.onMove, opts);
		el.addEventListener("touchend", this.onEnd, opts);
		el.addEventListener("touchcancel", this.onEnd, opts);
	}

	dispose(): void {
		if (!this.el) return;
		// An owed correction is owed to THIS binding; the next one starts
		// with nothing pending.
		this.pending = null;
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
