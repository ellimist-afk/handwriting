import { CameraState } from "../camera/coordinates";
import { countPaintedPixels } from "../diag/Raster";
import { PenStyle, widthForPressure } from "./PenStyle";
import { InkPoint } from "./Stroke";
import { IncrementalSmoother, Point2 } from "./Smoothing";
import { RibbonPt, flattenSegment, flattenSegmentHw } from "./Ribbon";
import { IncrementalShaper, inkShapingEnabled } from "./InkShape";
import { fillRibbon } from "./RibbonRenderer";
import { drawSegment } from "./StrokeRenderer";

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
	/** Screen box of everything this stroke has painted, for clearStroke. */
	private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;

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
	/**
	 * Shaped width law (InkShape) for this layer's strokes. The overlay sets
	 * it for pen wet layers only; the highlighter keeps its flat wash. The
	 * global shaping switch is consulted per stroke at beginStroke.
	 */
	shape = false;
	private shaper = new IncrementalShaper();
	private shapingThisStroke = false;
	private lastMidHw: number | undefined;
	private prevSampleHw = 0;

	beginStroke(first: InkPoint, style?: PenStyle): void {
		this.lastPoint = first;
		this.smoother.reset(first);
		this.lastRibbon = undefined;
		this.dirty = null;
		this.shapingThisStroke = this.shape && inkShapingEnabled();
		if (this.shapingThisStroke) {
			this.shaper.reset(first, style);
			this.prevSampleHw = this.shaper.last();
			this.lastMidHw = undefined;
		}
	}

	appendPoint(cam: CameraState, style: PenStyle, point: InkPoint): void {
		if (this.lastPoint) {
			if (this.smooth) {
				// Emits the segment that just became final, one sample behind
				// the pen. The head covers the rest.
				const sampleHw = this.shapingThisStroke
					? this.shaper.push(style, point)
					: 0;
				const seg = this.smoother.push(point);
				if (seg) {
					// Same ribbon construction the committed layer uses, emitted
					// one segment at a time so the pen path stays O(1). The strip
					// starts at the previous strip's last point, so consecutive
					// fills share an edge exactly and leave no seam.
					let flatSeg: RibbonPt[];
					if (this.shapingThisStroke) {
						const midHw = (this.prevSampleHw + sampleHw) / 2;
						flatSeg = flattenSegmentHw(
							seg,
							this.lastMidHw ?? this.prevSampleHw,
							midHw,
							cam.zoom
						);
						this.lastMidHw = midHw;
					} else {
						flatSeg = flattenSegment(seg, style, cam.zoom);
					}
					const strip: RibbonPt[] = this.lastRibbon
						? [this.lastRibbon, ...flatSeg]
						: flatSeg;
					fillRibbon(this.ctx, cam, strip, style.color);
					this.growDirtyStrip(cam, strip);
					this.lastRibbon = strip[strip.length - 1];
				}
				if (this.shapingThisStroke) this.prevSampleHw = sampleHw;
			} else {
				drawSegment(this.ctx, cam, style, this.lastPoint, point);
				const hw = widthForPressure(style, (this.lastPoint.pressure + point.pressure) / 2) / 2;
				this.growDirty(
					(this.lastPoint.x - cam.x) * cam.zoom,
					(this.lastPoint.y - cam.y) * cam.zoom,
					(point.x - cam.x) * cam.zoom,
					(point.y - cam.y) * cam.zoom,
					hw * cam.zoom + 2
				);
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
	 * The width the ribbon is laying down right now, in css px.
	 *
	 * The predicted tail asks for this rather than computing one from raw
	 * pressure. With shaping on the ribbon is velocity-thinned, so a tail
	 * sized from pressure alone is much fatter than the ink it extends - a
	 * bulge that runs ahead of the nib and deflates as the real samples
	 * land. Reported from hardware 2026-08-29: distorting while writing,
	 * while the finished stroke looked perfect. The finished stroke WAS
	 * perfect; only the guess was drawn wrong.
	 */
	liveWidthPx(cam: CameraState, style: PenStyle, pressure: number): number {
		const world = this.shapingThisStroke
			? this.shaper.last() * 2
			: widthForPressure(style, pressure);
		return world * cam.zoom;
	}

	/**
	 * Close the smoothed curve out to the final sample at pen-up, so the wet
	 * stroke reaches the nib before it is replaced by the committed one.
	 */
	finishStroke(cam: CameraState, style: PenStyle): void {
		if (!this.smooth) return;
		const seg = this.smoother.finish();
		if (!seg) return;
		const flatSeg = this.shapingThisStroke
			? flattenSegmentHw(
					seg,
					this.lastMidHw ?? this.prevSampleHw,
					this.shaper.last(),
					cam.zoom
				)
			: flattenSegment(seg, style, cam.zoom);
		const strip: RibbonPt[] = this.lastRibbon
			? [this.lastRibbon, ...flatSeg]
			: flatSeg;
		fillRibbon(this.ctx, cam, strip, style.color);
		this.growDirtyStrip(cam, strip);
		this.lastRibbon = strip[strip.length - 1];
	}

	clear(cssWidth: number, cssHeight: number): void {
		this.ctx.clearRect(0, 0, cssWidth, cssHeight);
		this.reset();
	}

	/**
	 * Clear only what this stroke painted. Same result as clear() when the
	 * canvas holds one finished stroke, which at pen-up it always does.
	 *
	 * E-ink refreshes the region a frame damaged. A whole-canvas clearRect
	 * damages the whole canvas, so every pen-up was a whole-screen refresh -
	 * the ~800ms freezes a NoteAir reported once per stroke (2026-09-01).
	 * Clearing the stroke's own box keeps the damage the size of the ink.
	 */
	clearStroke(cssWidth: number, cssHeight: number): void {
		const d = this.dirty;
		const x0 = d ? Math.max(0, Math.floor(d.x0)) : NaN;
		const y0 = d ? Math.max(0, Math.floor(d.y0)) : NaN;
		const x1 = d ? Math.min(cssWidth, Math.ceil(d.x1)) : NaN;
		const y1 = d ? Math.min(cssHeight, Math.ceil(d.y1)) : NaN;
		// No box, or a box that is not a box (a NaN pressure poisons the
		// width): clear everything. Leaving wet ink behind is the one outcome
		// this must never produce.
		if (x1 > x0 && y1 > y0) this.ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
		else this.ctx.clearRect(0, 0, cssWidth, cssHeight);
		this.reset();
	}

	private reset(): void {
		this.lastPoint = undefined;
		this.lastRibbon = undefined;
		this.dirty = null;
		this.smoother.reset();
	}

	private growDirty(x1: number, y1: number, x2: number, y2: number, pad: number): void {
		const box = {
			x0: Math.min(x1, x2) - pad,
			y0: Math.min(y1, y2) - pad,
			x1: Math.max(x1, x2) + pad,
			y1: Math.max(y1, y2) + pad,
		};
		this.dirty = this.dirty
			? {
					x0: Math.min(this.dirty.x0, box.x0),
					y0: Math.min(this.dirty.y0, box.y0),
					x1: Math.max(this.dirty.x1, box.x1),
					y1: Math.max(this.dirty.y1, box.y1),
				}
			: box;
	}

	/** The ribbon's points are world-space with a world half-width each. */
	private growDirtyStrip(cam: CameraState, strip: readonly RibbonPt[]): void {
		let hw = 0;
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const p of strip) {
			if (p.hw > hw) hw = p.hw;
			if (p.x < minX) minX = p.x;
			if (p.y < minY) minY = p.y;
			if (p.x > maxX) maxX = p.x;
			if (p.y > maxY) maxY = p.y;
		}
		if (!Number.isFinite(minX)) return;
		this.growDirty(
			(minX - cam.x) * cam.zoom,
			(minY - cam.y) * cam.zoom,
			(maxX - cam.x) * cam.zoom,
			(maxY - cam.y) * cam.zoom,
			hw * cam.zoom + 2
		);
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
