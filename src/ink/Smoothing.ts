import { InkPoint } from "./Stroke";

/**
 * Very basic stroke smoothing, for the Raw vs Smoothed comparison.
 *
 * Method: midpoint-quadratic. Each pair of consecutive samples contributes a
 * quadratic curve that runs from the midpoint of the previous pair, through
 * the shared sample as its control point, to the midpoint of the current pair.
 * The polyline's corners become tangent-continuous curves, so the faceting you
 * get from drawing straight lines between samples disappears, without any
 * filter, averaging window, or lag term.
 *
 * A midpoint curve can only be drawn once the sample after it has arrived, so
 * smoothing on its own would leave the visible line half a sample behind the
 * nib. It does not, because rendering is split:
 *
 *   settled tail   every segment behind the newest sample, smoothed, final
 *   live head      a raw straight stub from the last midpoint to the newest
 *                  sample, redrawn on every event
 *
 * The drawn line therefore always reaches the pen exactly where the raw build
 * put it, while everything behind the nib is curved. At pen-up the head is
 * replaced by the closing curve and the whole stroke converges on the same
 * geometry the committed layer draws.
 *
 * What it deliberately does NOT do: touch pressure, resample, simplify, or
 * alter stored samples. Canonical point data stays the real pen data;
 * smoothing is rendering geometry, not an input filter.
 */

export interface Point2 {
	x: number;
	y: number;
}

export interface SmoothSegment {
	from: Point2;
	/** Quadratic control point: the real sample the curve bends around. */
	ctrl: Point2;
	to: Point2;
	/** Pressure to width this segment with (mean of its two samples). */
	pressure: number;
}

export function midpoint(a: Point2, b: Point2): Point2 {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Whole-stroke smoothing, used for committed ink. The final segment runs out
 * to the true last sample so a finished stroke ends where the pen did.
 */
export function smoothSegments(points: readonly InkPoint[]): SmoothSegment[] {
	const out: SmoothSegment[] = [];
	if (points.length < 2) return out;
	let prev = points[0]!;
	let lastMid: Point2 | undefined;
	for (let i = 1; i < points.length; i++) {
		const cur = points[i]!;
		const mid = midpoint(prev, cur);
		out.push({
			from: lastMid ?? { x: prev.x, y: prev.y },
			ctrl: { x: prev.x, y: prev.y },
			to: mid,
			pressure: (prev.pressure + cur.pressure) / 2,
		});
		lastMid = mid;
		prev = cur;
	}
	if (lastMid) {
		out.push({
			from: lastMid,
			ctrl: { x: prev.x, y: prev.y },
			to: { x: prev.x, y: prev.y },
			pressure: prev.pressure,
		});
	}
	return out;
}

/**
 * The same curve, produced one sample at a time for the wet layer. Feeding
 * this the same points as `smoothSegments` yields the same segments (minus the
 * closing tail, which only exists once the stroke is finished), so ink does
 * not visibly change shape when it commits.
 */
export class IncrementalSmoother {
	private prev: InkPoint | undefined;
	private lastMid: Point2 | undefined;
	private lastPressure = 0.5;

	reset(first?: InkPoint): void {
		this.prev = first;
		this.lastMid = undefined;
		this.lastPressure = first?.pressure ?? 0.5;
	}

	/** Returns the segment that became drawable, if any. */
	push(point: InkPoint): SmoothSegment | undefined {
		const prev = this.prev;
		this.prev = point;
		if (!prev) return undefined;
		const mid = midpoint(prev, point);
		const seg: SmoothSegment = {
			from: this.lastMid ?? { x: prev.x, y: prev.y },
			ctrl: { x: prev.x, y: prev.y },
			to: mid,
			pressure: (prev.pressure + point.pressure) / 2,
		};
		this.lastMid = mid;
		this.lastPressure = seg.pressure;
		return seg;
	}

	/**
	 * The live head: the piece of line that is NOT smoothed yet, running from
	 * the last settled midpoint straight to the newest sample.
	 *
	 * This is what keeps the nib response identical to the raw build. A
	 * midpoint curve can only be drawn once the sample after it has arrived,
	 * so smoothing alone would leave the drawn line half a sample behind the
	 * pen. Instead the settled curve stops at the last midpoint and this raw
	 * stub, at most half a sample interval long, carries it the rest of the
	 * way to where the pen actually is. The drawn geometry therefore always
	 * reaches the newest sample, with zero added lag.
	 */
	head(): { from: Point2; to: Point2; pressure: number } | undefined {
		const prev = this.prev;
		if (!prev) return undefined;
		const to = { x: prev.x, y: prev.y };
		return {
			from: this.lastMid ?? to,
			to,
			pressure: this.lastMid ? this.lastPressure : prev.pressure,
		};
	}

	/** The closing segment out to the last sample, at pen-up. */
	finish(): SmoothSegment | undefined {
		if (!this.prev || !this.lastMid) return undefined;
		return {
			from: this.lastMid,
			ctrl: { x: this.prev.x, y: this.prev.y },
			to: { x: this.prev.x, y: this.prev.y },
			pressure: this.prev.pressure,
		};
	}
}
