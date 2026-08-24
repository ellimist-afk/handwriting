import { CameraState } from "../camera/coordinates";
import { countPaintedPixels } from "../diag/Raster";
import { PenStyle } from "./PenStyle";
import { InkPoint } from "./Stroke";
import { IncrementalSmoother, Point2 } from "./Smoothing";
import { RibbonPt, flattenSegment } from "./Ribbon";
import { fillRibbon } from "./RibbonRenderer";
import { drawSegment, drawSmoothSegment } from "./StrokeRenderer";

/**
 * The wet ink layer: incremental screen-space drawing of the stroke that is
 * currently being written (handoff §7). The latency path is:
 *
 *   PointerEvent -> convert to world -> drawSegment -> return
 *
 * No full-page rerender, no rAF wait. Segments are painted synchronously in
 * the pointer handler for minimum perceived latency.
 *
 * v0.1.2: the `desynchronized` context attribute is a request, not a promise.
 * Chromium decides whether a canvas is eligible for the low-latency path based
 * on compositing state, which is not necessarily settled at getContext() time.
 * So we snapshot getContextAttributes() at three moments (creation, after the
 * first real draw, and on demand) instead of trusting a single early read.
 */

export interface CanvasAttrs {
	alpha?: boolean;
	desynchronized?: boolean;
	willReadFrequently?: boolean;
	colorSpace?: string;
}

export class WetInkRenderer {
	private ctx: CanvasRenderingContext2D;
	private lastPoint: InkPoint | undefined;
	private smoother = new IncrementalSmoother();
	private lastRibbon: RibbonPt | undefined;

	/** What we asked Chromium for. */
	readonly requested: boolean;
	/** getContextAttributes() immediately after getContext(). */
	readonly attrsAtCreate: CanvasAttrs | undefined;
	/** getContextAttributes() sampled after the first segment was painted. */
	attrsAfterFirstDraw: CanvasAttrs | undefined;
	private drewOnce = false;

	constructor(private canvas: HTMLCanvasElement, desynchronized: boolean) {
		this.requested = desynchronized;
		const ctx = canvas.getContext("2d", { desynchronized });
		if (!ctx) throw new Error("Handwriting: could not acquire wet ink 2d context");
		this.ctx = ctx;
		this.attrsAtCreate = this.currentAttrs();
	}

	currentAttrs(): CanvasAttrs | undefined {
		return (
			this.ctx as CanvasRenderingContext2D & {
				getContextAttributes?: () => CanvasAttrs;
			}
		).getContextAttributes?.();
	}

	/** Best current answer to "is this actually a low-latency canvas?". */
	get actualDesynchronized(): boolean | undefined {
		return this.currentAttrs()?.desynchronized;
	}

	/** Compact one-line report for the metrics panel / export. */
	describe(): string {
		const at = (a: CanvasAttrs | undefined) =>
			a ? String(a.desynchronized) : "n/a";
		return (
			`req ${this.requested} | at-create ${at(this.attrsAtCreate)}` +
			` | post-draw ${at(this.attrsAfterFirstDraw)} | now ${at(this.currentAttrs())}`
		);
	}

	/** Call after the canvas backing store has been resized (dpr-scaled). */
	applyDpr(dpr: number): void {
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	/**
	 * Smoothed rendering geometry. When on, this canvas holds the SETTLED tail
	 * only: every segment behind the newest sample, curved and final. The
	 * unsmoothed head that reaches the nib is drawn by the caller on an overlay
	 * layer, because it has to be erased and redrawn on every event and this
	 * canvas is append-only.
	 */
	smooth = false;

	beginStroke(first: InkPoint): void {
		this.lastPoint = first;
		this.smoother.reset(first);
		this.lastRibbon = undefined;
	}

	appendPoint(cam: CameraState, style: PenStyle, point: InkPoint): void {
		if (this.lastPoint) {
			if (this.smooth) {
				// Emits the segment that just became final, one sample behind
				// the pen. The head covers the rest.
				const seg = this.smoother.push(point);
				if (seg) {
					// Same ribbon construction the committed layer uses, emitted
					// one segment at a time so the pen path stays O(1). The strip
					// starts at the previous strip's last point, so consecutive
					// fills share an edge exactly and leave no seam.
					const strip: RibbonPt[] = this.lastRibbon
						? [this.lastRibbon, ...flattenSegment(seg, style, cam.zoom)]
						: flattenSegment(seg, style, cam.zoom);
					fillRibbon(this.ctx, cam, strip, style.color);
					this.lastRibbon = strip[strip.length - 1];
				}
			} else {
				drawSegment(this.ctx, cam, style, this.lastPoint, point);
			}
			if (!this.drewOnce) {
				this.drewOnce = true;
				this.attrsAfterFirstDraw = this.currentAttrs();
			}
		}
		this.lastPoint = point;
	}

	/** The raw stub from the settled curve to the nib; undefined in raw mode. */
	head(): { from: Point2; to: Point2; pressure: number } | undefined {
		return this.smooth ? this.smoother.head() : undefined;
	}

	/**
	 * Close the smoothed curve out to the final sample at pen-up, so the wet
	 * stroke reaches the nib before it is replaced by the committed one.
	 */
	finishStroke(cam: CameraState, style: PenStyle): void {
		if (!this.smooth) return;
		const seg = this.smoother.finish();
		if (!seg) return;
		const strip: RibbonPt[] = this.lastRibbon
			? [this.lastRibbon, ...flattenSegment(seg, style, cam.zoom)]
			: flattenSegment(seg, style, cam.zoom);
		fillRibbon(this.ctx, cam, strip, style.color);
		this.lastRibbon = strip[strip.length - 1];
	}

	clear(cssWidth: number, cssHeight: number): void {
		this.ctx.clearRect(0, 0, cssWidth, cssHeight);
		this.lastPoint = undefined;
		this.lastRibbon = undefined;
		this.smoother.reset();
	}

	/**
	 * Diagnostic readback: non-transparent pixels in a CSS-px rect of this
	 * wet canvas. Called once per pen-up (before clear) by the scroll probe,
	 * never on the hot path.
	 */
	countPainted(
		xCss: number,
		yCss: number,
		wCss: number,
		hCss: number,
		backing: number
	): number {
		return countPaintedPixels(this.ctx, xCss, yCss, wCss, hCss, backing);
	}
}
