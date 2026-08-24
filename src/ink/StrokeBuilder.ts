import { InkPoint, InkStroke, InkTool, computeBBox, newStrokeId } from "./Stroke";

/**
 * Some pens keep reporting contact while the nib is already leaving the
 * glass. Pressure falls to a tiny value, coordinates travel, and pressure may
 * then recover without another pointerdown. Those coordinates are release
 * travel, not ink. The two pressure bands provide hysteresis; the time and
 * distance gates keep a brief light-pressure wobble in the stroke.
 */
const RELEASE_PRESSURE_MAX = 0.025;
const CONFIDENT_CONTACT_PRESSURE = 0.08;
const RELEASE_MIN_MS = 8;
const RELEASE_MIN_TRAVEL = 3;

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
		return this.buildStroke(this.points);
	}

	/**
	 * Finalize inline pen input after removing proven release travel.
	 *
	 * A recovered contact becomes another ordinary stroke so no renderer joins
	 * two letters across the physical gap. The caller still stores and records
	 * all returned strokes as one gesture. Other surfaces use finish(), so this
	 * hardware correction cannot alter canvas behavior.
	 */
	finishReleaseFiltered(): InkStroke[] {
		const groups = this.releaseFilteredPointGroups();
		if (groups.length === 0) return [];
		const createdAt = Date.now();
		return groups
			.map((points) => this.buildStroke(points, createdAt))
			.filter((stroke): stroke is InkStroke => stroke !== undefined);
	}

	private buildStroke(points: InkPoint[], createdAt = Date.now()): InkStroke | undefined {
		if (points.length === 0) return undefined;
		// A single tap should still leave a dot: duplicate the point slightly
		// so segment-based renderers have something to draw.
		const finishedPoints = points.length === 1
			? [points[0]!, { ...points[0]!, x: points[0]!.x + 0.01, t: points[0]!.t + 1 }]
			: points;
		return {
			id: newStrokeId(),
			tool: this.tool,
			color: this.color,
			width: this.width,
			points: finishedPoints,
			bbox: computeBBox(finishedPoints, this.width * 2),
			createdAt,
		};
	}

	private releaseFilteredPointGroups(): InkPoint[][] {
		if (this.points.length === 0) return [];
		const groups: InkPoint[][] = [];
		let groupStart = 0;
		let confidentContactSeen = false;
		let i = 0;

		while (i < this.points.length) {
			const point = this.points[i]!;
			if (point.pressure >= CONFIDENT_CONTACT_PRESSURE) confidentContactSeen = true;
			if (!confidentContactSeen || point.pressure > RELEASE_PRESSURE_MAX) {
				i++;
				continue;
			}

			const gapStart = i;
			let recoveryStart = -1;
			let recoveryConfirmed = -1;
			for (let j = i + 1; j < this.points.length; j++) {
				const pressure = this.points[j]!.pressure;
				if (pressure <= RELEASE_PRESSURE_MAX) {
					recoveryStart = -1;
				} else if (recoveryStart < 0) {
					recoveryStart = j;
				}
				if (pressure >= CONFIDENT_CONTACT_PRESSURE) {
					recoveryConfirmed = j;
					break;
				}
			}

			const gapEnd = recoveryConfirmed >= 0 ? recoveryStart - 1 : this.points.length - 1;
			// Include the edge entering the low-pressure run. On the captured
			// hardware that first sample can contain most of the false travel.
			const releaseEdge = Math.max(groupStart, gapStart - 1);
			const duration = this.points[gapEnd]!.t - this.points[releaseEdge]!.t;
			const travel = this.pathLength(releaseEdge, gapEnd);
			const provenRelease = duration >= RELEASE_MIN_MS && travel >= RELEASE_MIN_TRAVEL;

			if (!provenRelease) {
				if (recoveryConfirmed < 0) break;
				i = recoveryConfirmed + 1;
				continue;
			}

			groups.push(this.points.slice(groupStart, gapStart));
			if (recoveryConfirmed < 0) {
				groupStart = this.points.length;
				break;
			}

			groupStart = recoveryStart;
			confidentContactSeen = true;
			i = recoveryConfirmed + 1;
		}

		if (groupStart < this.points.length) groups.push(this.points.slice(groupStart));
		return groups.filter((points) => points.length > 0);
	}

	private pathLength(from: number, to: number): number {
		let length = 0;
		for (let i = from + 1; i <= to; i++) {
			const a = this.points[i - 1]!;
			const b = this.points[i]!;
			length += Math.hypot(b.x - a.x, b.y - a.y);
		}
		return length;
	}
}
