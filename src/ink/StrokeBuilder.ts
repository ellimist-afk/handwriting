import { InkPoint, InkStroke, InkTool, computeBBox, newStrokeId } from "./Stroke";

/**
 * Accumulates world-space samples for the stroke currently being written.
 * Latency path stays trivial: push a sample, return. Cleanup (dedupe of
 * near-identical samples) happens inline and cheaply; heavier smoothing and
 * simplification is deliberately not done here
 * (handoff §11: do not aggressively simplify handwriting).
 */
export class StrokeBuilder {
	private points: InkPoint[] = [];
	private startedAt = 0;
	private tool: InkTool;
	private color: string;
	private width: number;
	/** Min world-space movement to accept a new sample (dedupe threshold). */
	private minDist: number;

	constructor(tool: InkTool, color: string, width: number, minDistWorld = 0.15) {
		this.tool = tool;
		this.color = color;
		this.width = width;
		this.minDist = minDistWorld;
	}

	get pointCount(): number {
		return this.points.length;
	}

	get lastPoint(): InkPoint | undefined {
		return this.points[this.points.length - 1];
	}

	start(now: number): void {
		this.startedAt = now;
		this.points = [];
	}

	/**
	 * Add a world-space sample. Returns the accepted point, or undefined if
	 * it was deduped (too close to the previous sample).
	 */
	add(x: number, y: number, pressure: number, timestamp: number, tiltX?: number, tiltY?: number): InkPoint | undefined {
		const prev = this.lastPoint;
		if (prev) {
			const dx = x - prev.x;
			const dy = y - prev.y;
			if (dx * dx + dy * dy < this.minDist * this.minDist) {
				// Keep the newest pressure on the retained point so a held,
				// pressed pen still updates width later.
				prev.pressure = pressure;
				return undefined;
			}
		}
		const point: InkPoint = {
			x,
			y,
			pressure,
			t: Math.max(0, Math.round(timestamp - this.startedAt)),
		};
		if (tiltX !== undefined) point.tiltX = tiltX;
		if (tiltY !== undefined) point.tiltY = tiltY;
		this.points.push(point);
		return point;
	}

	/** Finalize into a persistent stroke. Returns undefined for empty/dot-less strokes. */
	finish(): InkStroke | undefined {
		if (this.points.length === 0) return undefined;
		// A single tap should still leave a dot: duplicate the point slightly
		// so segment-based renderers have something to draw.
		if (this.points.length === 1) {
			const p = this.points[0]!;
			this.points.push({ ...p, x: p.x + 0.01, t: p.t + 1 });
		}
		return {
			id: newStrokeId(),
			tool: this.tool,
			color: this.color,
			width: this.width,
			points: this.points,
			bbox: computeBBox(this.points, this.width * 2),
			createdAt: Date.now(),
		};
	}
}
