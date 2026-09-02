import { PenStyle, widthForPressure } from "./PenStyle";
import { smoothSegments } from "./Smoothing";
import { InkPoint } from "./Stroke";
import { RibbonPt, flattenSegmentHw } from "./Ribbon";

/**
 * Ink shaping: the difference between a polyline that tracks the pen and a
 * line that looks like it was written. Three effects, all computed from the
 * stored samples (x, y, pressure, t) at render time, so the canonical stroke
 * data is untouched and wet and committed ink always agree:
 *
 *   pressure settling   raw digitizer pressure jitters sample to sample, and
 *                       mapping it straight to width puts that jitter on the
 *                       outline. A one-pole filter settles it.
 *
 *   velocity thinning   a real nib starves at speed: fast strokes come out
 *                       thinner than slow ones. This is most of what makes
 *                       handwriting read as handwriting; without it every
 *                       letter has the same dead weight everywhere.
 *
 *   endpoint taper      strokes start and end at a tip, not at a blunt round
 *                       cap. The taper runs over a short arc length at each
 *                       end. The wet layer can only taper the start (the end
 *                       is unknown until pen-up); the committed repaint at
 *                       hand-off adds the end taper, so the stroke visibly
 *                       "dries" into its final shape the way OneNote's does.
 *
 * The highlighter is exempt: a chisel tip does not taper or starve, and its
 * flat, even wash is the whole point of the tool.
 */

export interface ShapeParams {
	/** One-pole filter weight for pressure (1 = no filtering). */
	pressureAlpha: number;
	/** One-pole filter weight for velocity. */
	velocityAlpha: number;
	/** Thinning strength per world-unit-per-ms of nib speed (0 = off). */
	thinningK: number;
	/** Width floor under velocity thinning, as a fraction of full width. */
	minVelocityFactor: number;
	/** Taper length at each end, in multiples of the style's base width. */
	taperWidths: number;
	/** Each taper may cover at most this fraction of the stroke's length. */
	taperMaxShare: number;
	/** Half-width multiplier remaining at the extreme tip (0 aliases away). */
	tipFloor: number;
}

/**
 * Tuned on a Surface at zoom 1, where world units are CSS pixels and
 * ordinary handwriting moves the nib at roughly 0.5 to 2.5 units/ms.
 */
export const PEN_SHAPE: ShapeParams = {
	pressureAlpha: 0.4,
	velocityAlpha: 0.3,
	thinningK: 0.18,
	minVelocityFactor: 0.65,
	taperWidths: 2.4,
	// How much of a stroke the taper may claim. The taper is a multiple of the
	// nib WIDTH, so a fat nib tapers over a longer distance and a short stroke
	// hits this cap: measured 2026-08-29, a 2.5x nib gave up 27% of a short
	// stroke and 24% of a long one, which reads as the end being clipped off.
	// At 0.18 it holds near 14% whatever the nib. The tip floor is deliberately
	// NOT raised with it - ends are tips, not blunt caps, and there is a test
	// that says so.
	taperMaxShare: 0.18,
	tipFloor: 0.12,
};

// ---- global switch ----------------------------------------------------------

let shapingOn = true;

export function setInkShaping(on: boolean): void {
	shapingOn = on;
}

export function inkShapingEnabled(): boolean {
	return shapingOn;
}

// ---- per-sample width law ---------------------------------------------------

/** Smoothstep eased from the tip floor up to 1. */
function taperEase(u: number, tipFloor: number): number {
	const c = Math.min(1, Math.max(0, u));
	const s = c * c * (3 - 2 * c);
	return tipFloor + (1 - tipFloor) * s;
}

/**
 * Per-sample half-widths for a whole stroke: filtered pressure through the
 * style's width law, then velocity thinning. No taper here; taper depends on
 * arc length over the flattened ribbon and is applied by applyEndTaper.
 */
export function shapedHalfWidths(
	points: readonly InkPoint[],
	style: PenStyle,
	params: ShapeParams = PEN_SHAPE
): number[] {
	const out: number[] = [];
	if (points.length === 0) return out;
	let pHat = points[0]!.pressure;
	let vHat = 0;
	let prev = points[0]!;
	for (let i = 0; i < points.length; i++) {
		const pt = points[i]!;
		if (i > 0) {
			const d = Math.hypot(pt.x - prev.x, pt.y - prev.y);
			const dt = Math.max(1, pt.t - prev.t);
			vHat += params.velocityAlpha * (d / dt - vHat);
			pHat += params.pressureAlpha * (pt.pressure - pHat);
		}
		const f = Math.max(params.minVelocityFactor, 1 / (1 + params.thinningK * vHat));
		out.push((widthForPressure(style, pHat) / 2) * f);
		prev = pt;
	}
	return out;
}

// ---- endpoint taper ---------------------------------------------------------

/**
 * Multiply half-widths down toward the tip floor over a short arc length at
 * both ends of a flattened ribbon. Mutates `pts` in place (they are always
 * freshly built by the caller).
 */
export function applyEndTaper(
	pts: RibbonPt[],
	style: PenStyle,
	params: ShapeParams = PEN_SHAPE
): void {
	const n = pts.length;
	if (n < 2) return;
	const arc: number[] = [0];
	for (let i = 1; i < n; i++) {
		const a = pts[i - 1]!;
		const b = pts[i]!;
		arc.push(arc[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
	}
	const total = arc[n - 1]!;
	if (total < 1e-9) return;
	// A TAP is not a short line, and tapering one destroys it.
	//
	// The taper zone is capped at a share of the stroke, so on a tap it is a
	// share of almost nothing - and a stroke that short flattens to a ribbon
	// of two points, both of which are ends. Both then get multiplied to the
	// tip floor and the dot renders at 12% of the nib: measured 0.132 against
	// a 1.1 half-width, which is the near-invisible sliver reported on canvas,
	// SVG and PDF alike (all three flatten through here).
	//
	// Below one nib width of travel there is no direction to taper ALONG, so
	// the honest shape is the nib itself. Real short strokes are unaffected:
	// the existing 5-unit case is more than twice this bound.
	if (total < style.baseWidth) return;
	const taperLen = Math.min(params.taperWidths * style.baseWidth, total * params.taperMaxShare);
	if (taperLen < 1e-9) return;
	for (let i = 0; i < n; i++) {
		const fromStart = taperEase(arc[i]! / taperLen, params.tipFloor);
		const fromEnd = taperEase((total - arc[i]!) / taperLen, params.tipFloor);
		pts[i]!.hw *= fromStart * fromEnd;
	}
}

// ---- committed rendering ----------------------------------------------------

/**
 * The shaped counterpart of Ribbon's flattenStroke: the same midpoint-
 * quadratic centerline at the same flatness, but half-widths come from the
 * shaped per-sample law, interpolated along each segment, with the endpoint
 * taper applied over the finished ribbon.
 */
export function flattenStrokeShaped(
	points: readonly InkPoint[],
	style: PenStyle,
	pxPerWorld: number,
	params: ShapeParams = PEN_SHAPE
): RibbonPt[] {
	if (points.length === 0) return [];
	const hws = shapedHalfWidths(points, style, params);
	if (points.length === 1) {
		const p = points[0]!;
		return [{ x: p.x, y: p.y, hw: hws[0]! }];
	}
	const segs = smoothSegments(points);
	const midHw = (a: number, b: number) => (hws[a]! + hws[b]!) / 2;
	const last = points.length - 1;
	const out: RibbonPt[] = [{ x: segs[0]!.from.x, y: segs[0]!.from.y, hw: hws[0]! }];
	for (let j = 0; j < segs.length; j++) {
		// Segment j bends around sample j; its ends sit on the midpoints
		// (j-1,j) and (j,j+1). The closing segment runs out to the last
		// sample itself.
		const hwFrom = j === 0 ? hws[0]! : midHw(j - 1, Math.min(j, last));
		const hwTo = j >= last ? hws[last]! : midHw(j, j + 1);
		for (const p of flattenSegmentHw(segs[j]!, hwFrom, hwTo, pxPerWorld)) out.push(p);
	}
	applyEndTaper(out, style, params);
	return out;
}

// ---- wet rendering ----------------------------------------------------------

/**
 * The same width law, one sample at a time, for the wet layer. Start taper
 * only: the end taper needs the total length, which exists at pen-up, and the
 * committed repaint applies it then.
 */
export class IncrementalShaper {
	private pHat = 0.5;
	private vHat = 0;
	private prev: InkPoint | undefined;
	private arcFromStart = 0;
	private lastHw = 0;

	constructor(private params: ShapeParams = PEN_SHAPE) {}

	reset(first: InkPoint | undefined, style: PenStyle | undefined): void {
		this.pHat = first?.pressure ?? 0.5;
		this.vHat = 0;
		this.prev = first;
		this.arcFromStart = 0;
		this.lastHw =
			first && style
				? (widthForPressure(style, first.pressure) / 2) * this.params.tipFloor
				: 0;
	}

	/** Shaped half-width at this sample, start taper included. */
	push(style: PenStyle, pt: InkPoint): number {
		const prev = this.prev;
		if (prev) {
			const d = Math.hypot(pt.x - prev.x, pt.y - prev.y);
			const dt = Math.max(1, pt.t - prev.t);
			this.arcFromStart += d;
			this.vHat += this.params.velocityAlpha * (d / dt - this.vHat);
			this.pHat += this.params.pressureAlpha * (pt.pressure - this.pHat);
		}
		const f = Math.max(
			this.params.minVelocityFactor,
			1 / (1 + this.params.thinningK * this.vHat)
		);
		const taper = taperEase(
			this.arcFromStart / (this.params.taperWidths * style.baseWidth),
			this.params.tipFloor
		);
		this.prev = pt;
		this.lastHw = (widthForPressure(style, this.pHat) / 2) * f * taper;
		return this.lastHw;
	}

	/** Half-width of the most recent sample (for the closing segment). */
	last(): number {
		return this.lastHw;
	}
}
