import { InkPoint, InkStroke, InkTool, computeBBox, newStrokeId } from "./Stroke";
import type { StrokeWidthMode, PressureProfile } from "./StrokeWidth";

/**
 * Some pens keep reporting contact while the nib is already leaving the
 * glass. Pressure falls to a tiny value and coordinates travel. At the END of
 * a contact those coordinates are release travel, not ink, and are trimmed.
 * The two pressure bands provide hysteresis; the time and distance gates keep
 * a brief light-pressure wobble in the stroke.
 *
 * A light run that is followed by confident contact, with no lift between,
 * is not release: the pen never left the glass, so the run is ink drawn in
 * contact (a pressure dip) and stays in the stroke whole, as one stroke. A
 * split there would delete ink the pen drew and change the line at the lift.
 * Real captures hold no pen that travels far in contact and then returns to
 * pressure; only a run with no recovery is removed.
 *
 * Pressure cannot tell release travel from a deliberate light glide: Alan's
 * in-contact glide (trace d1c16bdb) went down to 0.0039, below the release
 * values the filter was written against. Duration can. A light run is release
 * travel only while its light samples span at most RELEASE_MAX_MS; a longer
 * run is writing and stays in the stroke whole, unsplit, mid-stroke or at the
 * end.
 */
const RELEASE_PRESSURE_MAX = 0.025;
const CONFIDENT_CONTACT_PRESSURE = 0.08;
const RELEASE_MIN_MS = 8;
const RELEASE_MIN_TRAVEL = 3;
/**
 * The longest light run still read as release travel, timed from the run's
 * FIRST light sample to the last sample it would remove, including any
 * above-band samples that ride with it at a stroke end: a still hold at confident pressure before
 * the run is not part of it (the builder accepts no sample while the pen is
 * still, so an edge-inclusive time would count the hold). RELEASE_MIN_MS keeps
 * its edge-inclusive measure.
 *
 * 50, on these measurements:
 * - Alan's kept glide spans 188 ms;
 * - the fixture's release runs span 0-22 ms (synthetic, no captured release);
 * - 1285 real samples on Orion hold no light run at a stroke end (a real lift
 *   is one sample under 12 ms);
 * - a real lift-and-hop on the Surface holds no light sample at all.
 */
export const RELEASE_MAX_MS = 50;

/**
 * Accumulates world-space samples for the stroke currently being written.
 * Latency path stays trivial: push a sample, return. Cleanup (dedupe of
 * near-identical samples) happens inline and cheaply; heavier smoothing and
 * simplification is deliberately not done here
 * (handoff §11: do not aggressively simplify handwriting).
 */
export class StrokeBuilder {
	private points: InkPoint[] = [];
	/** Pressure each point arrived with. The release filter judges by the higher of this and the point's latest pressure: a deduped sample with a low pressure must not make a confident point read as release, and one with a high pressure must not leave a pressed point read as release. */
	private arrivalPressure: number[] = [];
	/** Newest pressure of a held pen on each point, from samples the distance filter drops. The release filter reads it; the point never does, because the wet layer drew the point at its arrival pressure and the saved stroke must match. */
	private latestPressure: number[] = [];
	private startedAt = 0;
	private tool: InkTool;
	private color: string;
	private width: number;
	/** Min world-space movement to accept a new sample (dedupe threshold). */
	private minDist: number;
	private readonly pressureProfile: PressureProfile | undefined;

	constructor(
		tool: InkTool,
		color: string,
		width: number,
		minDistWorld = 0.15,
		private device?: "mouse",
		private widthMode?: StrokeWidthMode
	) {
		this.tool = tool;
		this.color = color;
		this.width = width;
		this.minDist = minDistWorld;
		this.pressureProfile = tool === "pen" && widthMode !== "uniform" ? "exp7" : undefined;
	}

	get pointCount(): number {
		return this.points.length;
	}

	get lastPoint(): InkPoint | undefined {
		return this.points[this.points.length - 1];
	}

	/** Resolved once for this builder and passed to wet rendering at pen-down. */
	get resolvedPressureProfile(): PressureProfile | undefined {
		return this.pressureProfile;
	}

	start(now: number): void {
		this.startedAt = now;
		this.points = [];
		this.arrivalPressure = [];
		this.latestPressure = [];
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
				// The retained point keeps the pressure it was drawn wet with;
				// only the release filter hears a held pen's newer pressure.
				this.latestPressure[this.points.length - 1] = pressure;
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
		this.arrivalPressure.push(pressure);
		this.latestPressure.push(pressure);
		return point;
	}

	/** Finalize into a persistent stroke. Returns undefined for empty/dot-less strokes. */
	finish(): InkStroke | undefined {
		const result = this.buildStroke(this.points);
		return result;
	}

	/**
	 * Finalize inline pen input after removing proven release travel.
	 *
	 * Only a light ending with no recovery is cut off, so a contact is one
	 * stroke. The inline and slides surfaces and the website demo's pen use
	 * it; the other surfaces use finish(), so this hardware correction cannot
	 * alter canvas behavior.
	 */
	finishReleaseFiltered(): InkStroke[] {
		const groups = this.releaseFilteredPointGroups();
		if (groups.length === 0) {
			return [];
		}
		const createdAt = Date.now();
		const result = groups
			.map((points) => this.buildStroke(points, createdAt))
			.filter((stroke): stroke is InkStroke => stroke !== undefined);
		return result;
	}

	/** Read-only pause snapshot, with exactly the release filter used at lift. */
	snapshotReleaseFiltered(): InkStroke[] {
		return this.releaseFilteredPointGroups()
			.map(points => this.buildStroke(points.map(point => ({ ...point })), this.startedAt, "snap-preview"))
			.filter((stroke): stroke is InkStroke => stroke !== undefined);
	}

	private buildStroke(points: InkPoint[], createdAt = Date.now(), id?: string): InkStroke | undefined {
		if (points.length === 0) return undefined;
		// A single tap should still leave a dot: duplicate the point slightly
		// so segment-based renderers have something to draw.
		const finishedPoints = points.length === 1
			? [points[0]!, { ...points[0]!, x: points[0]!.x + 0.01, t: points[0]!.t + 1 }]
			: points;
		// A tap: the builder accepted one point over the whole contact, so the
		// screen showed the nib dot, which pressure never sizes. It is saved as
		// uniform ink, the shape a finger stroke has, and draws at the nib.
		// Counted on the contact, not on a release-filtered group: a contact
		// that moved was drawn as a ribbon and is saved as one.
		const tap = this.pressureProfile !== undefined && this.points.length === 1;
		return {
			id: id ?? newStrokeId(),
			tool: this.tool,
			color: this.color,
			width: this.width,
			points: finishedPoints,
			bbox: computeBBox(finishedPoints, this.width * 2),
			createdAt,
			...(this.device === "mouse" ? { device: this.device } : {}),
			...(this.widthMode === "uniform" || tap ? { widthMode: "uniform" as const } : {}),
			...(this.pressureProfile && !tap ? { pressureProfile: this.pressureProfile } : {}),
		};
	}

	private releaseFilteredPointGroups(): InkPoint[][] {
		if (this.points.length === 0) return [];
		const groups: InkPoint[][] = [];
		let groupStart = 0;
		let confidentContactSeen = false;
		let i = 0;

		while (i < this.points.length) {
			const arrival = this.releasePressure(i);
			if (arrival >= CONFIDENT_CONTACT_PRESSURE) confidentContactSeen = true;
			if (!confidentContactSeen || arrival > RELEASE_PRESSURE_MAX) {
				i++;
				continue;
			}

			const gapStart = i;
			let recoveryConfirmed = -1;
			for (let j = i + 1; j < this.points.length; j++) {
				if (this.releasePressure(j) >= CONFIDENT_CONTACT_PRESSURE) {
					recoveryConfirmed = j;
					break;
				}
			}

			// Contact comes back with no lift between: the pen never left the
			// glass, so the light samples are ink drawn in contact (a pressure dip,
			// not a release). The run stays in the stroke whole, and the stroke
			// stays one stroke.
			if (recoveryConfirmed >= 0) {
				i = recoveryConfirmed + 1;
				continue;
			}

			// No recovery: the light run reaches the end of the contact, a tail.
			const gapEnd = this.points.length - 1;
			// Include the edge entering the low-pressure run. On the captured
			// hardware that first sample can contain most of the false travel.
			const releaseEdge = Math.max(groupStart, gapStart - 1);
			const duration = this.points[gapEnd]!.t - this.points[releaseEdge]!.t;
			const travel = this.pathLength(releaseEdge, gapEnd);
			// The run's span reaches the last sample it would remove. A terminal
			// gap can end in samples above the release band that never reach
			// confident contact; they ride with the run, so their time counts.
			const lightSpan = this.points[gapEnd]!.t - this.points[gapStart]!.t;
			// Longer than a bounce, a light ending is writing: not release, so it
			// stays in this group.
			const provenRelease =
				duration >= RELEASE_MIN_MS &&
				travel >= RELEASE_MIN_TRAVEL &&
				lightSpan <= RELEASE_MAX_MS;
			if (!provenRelease) break;

			groups.push(this.points.slice(groupStart, gapStart));
			groupStart = this.points.length;
			break;
		}

		if (groupStart < this.points.length) groups.push(this.points.slice(groupStart));
		return groups.filter((points) => points.length > 0);
	}

	private releasePressure(i: number): number {
		return Math.max(this.arrivalPressure[i] ?? 0, this.latestPressure[i] ?? 0);
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
