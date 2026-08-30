/**
 * Per-stroke latency instrumentation for the A/B pipeline test.
 * All timing uses event.timeStamp / performance.now(), which share a clock.
 */

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

/**
 * A stat with no samples did not measure zero - nothing measured it.
 *
 * `frame 0/0ms` printed for every inline stroke while a flicker was being
 * hunted with exactly that number (alan, hardware, 2026-08-30). It reads as
 * "frames were perfect", which is the failure mode where a dead instrument is
 * indistinguishable from a clean result. Say which one it is.
 */
function statText(s: StatSummary, unit = "ms"): string {
	return s.n === 0 ? "(not recorded)" : `${s.avg}/${s.max}${unit}`;
}

export interface StatSummary {
	avg: number;
	max: number;
	n: number;
}

class Stat {
	n = 0;
	sum = 0;
	max = 0;

	add(v: number): void {
		this.n++;
		this.sum += v;
		if (v > this.max) this.max = v;
	}

	get avg(): number {
		return this.n ? this.sum / this.n : 0;
	}

	reset(): void {
		this.n = 0;
		this.sum = 0;
		this.max = 0;
	}

	summary(): StatSummary {
		return { avg: round2(this.avg), max: round2(this.max), n: this.n };
	}
}

export interface StrokeSummary {
	mode: string;
	durationMs: number;
	moveEvents: number;
	rawEvents: number;
	moveHz: number;
	rawHz: number;
	samples: number;
	accepted: number;
	deduped: number;
	coalescedPerEvent: StatSummary;
	deliveryAgeMs: StatSummary;
	handlerMs: StatSummary;
	drawMs: StatSummary;
	ageAtDrawMs: StatSummary;
	ageAtPresentMs: StatSummary;
	frameIntervalMs: StatSummary;
	// ---- prediction experiment (v0.1.3) ----
	predMode: string;
	predApi: string;
	predTails: number;
	predSuppressed: number;
	predPointsPerTail: StatSummary;
	predHorizonMs: StatSummary;
	predTipDistPx: StatSummary;
	predCorrectionPx: StatSummary;
}

export class StrokeMetrics {
	active = false;
	private mode = "";
	private startedAt = 0;

	private moveEvents = 0;
	private rawEvents = 0;
	private samples = 0;
	private accepted = 0;

	private coalesced = new Stat();
	private deliveryAge = new Stat();
	private handler = new Stat();
	private draw = new Stat();
	private drawAge = new Stat();
	private presentAge = new Stat();
	private frameInterval = new Stat();
	private lastFrameTs = 0;

	private predMode = "off";
	private predApi = "unknown";
	private predTails = 0;
	private predSuppressed = 0;
	private predPoints = new Stat();
	private predHorizon = new Stat();
	private predTip = new Stat();
	private predCorrection = new Stat();

	summaries: StrokeSummary[] = [];
	/** Never reset, never capped: the honest count of strokes that ended. */
	totalEnded = 0;

	begin(mode: string, now: number): void {
		this.predTails = 0;
		this.predSuppressed = 0;
		this.predPoints.reset();
		this.predHorizon.reset();
		this.predTip.reset();
		this.predCorrection.reset();
		this.mode = mode;
		this.startedAt = now;
		this.moveEvents = 0;
		this.rawEvents = 0;
		this.samples = 0;
		this.accepted = 0;
		this.coalesced.reset();
		this.deliveryAge.reset();
		this.handler.reset();
		this.draw.reset();
		this.drawAge.reset();
		this.presentAge.reset();
		this.frameInterval.reset();
		this.lastFrameTs = 0;
		this.active = true;
	}

	recordEvent(
		source: "move" | "raw",
		coalescedCount: number,
		deliveryAgeMs: number,
		isInkSource: boolean
	): void {
		if (!this.active) return;
		if (source === "move") this.moveEvents++;
		else this.rawEvents++;
		if (isInkSource) {
			this.coalesced.add(coalescedCount);
			this.deliveryAge.add(deliveryAgeMs);
			this.samples += coalescedCount;
		}
	}

	recordAccepted(n: number): void {
		if (this.active) this.accepted += n;
	}

	recordHandler(ms: number): void {
		if (this.active) this.handler.add(ms);
	}

	recordDraw(ms: number, ageAtDrawEnd: number): void {
		if (!this.active) return;
		this.draw.add(ms);
		this.drawAge.add(ageAtDrawEnd);
	}

	recordPresent(age: number): void {
		// May arrive one frame after pen-up; accept it anyway so the last
		// draw's presentation is counted.
		this.presentAge.add(age);
	}

	recordFrame(ts: number): void {
		if (!this.active) return;
		if (this.lastFrameTs > 0) this.frameInterval.add(ts - this.lastFrameTs);
		this.lastFrameTs = ts;
	}

	setPrediction(mode: string, api: string): void {
		this.predMode = mode;
		this.predApi = api;
	}

	recordTail(pointCount: number, horizonMs: number, tipDistPx: number): void {
		if (!this.active) return;
		this.predTails++;
		this.predPoints.add(pointCount);
		this.predHorizon.add(horizonMs);
		this.predTip.add(tipDistPx);
	}

	recordTailSuppressed(): void {
		if (this.active) this.predSuppressed++;
	}

	recordCorrection(errPx: number): void {
		if (this.active) this.predCorrection.add(errPx);
	}

	end(now: number): StrokeSummary {
		this.active = false;
		const durationMs = Math.max(1, now - this.startedAt);
		const summary: StrokeSummary = {
			mode: this.mode,
			durationMs: Math.round(durationMs),
			moveEvents: this.moveEvents,
			rawEvents: this.rawEvents,
			moveHz: round2((this.moveEvents * 1000) / durationMs),
			rawHz: round2((this.rawEvents * 1000) / durationMs),
			samples: this.samples,
			accepted: this.accepted,
			deduped: this.samples - this.accepted,
			coalescedPerEvent: this.coalesced.summary(),
			deliveryAgeMs: this.deliveryAge.summary(),
			handlerMs: this.handler.summary(),
			drawMs: this.draw.summary(),
			ageAtDrawMs: this.drawAge.summary(),
			ageAtPresentMs: this.presentAge.summary(),
			frameIntervalMs: this.frameInterval.summary(),
			predMode: this.predMode,
			predApi: this.predApi,
			predTails: this.predTails,
			predSuppressed: this.predSuppressed,
			predPointsPerTail: this.predPoints.summary(),
			predHorizonMs: this.predHorizon.summary(),
			predTipDistPx: this.predTip.summary(),
			predCorrectionPx: this.predCorrection.summary(),
		};
		this.totalEnded++;
		this.summaries.push(summary);
		if (this.summaries.length > 20) this.summaries.shift();
		return summary;
	}

	liveText(): string {
		return [
			`mode ${this.mode}`,
			`move ${this.moveEvents} raw ${this.rawEvents} samples ${this.samples} (acc ${this.accepted})`,
			`delivery ${round2(this.deliveryAge.avg)}ms  handler ${round2(this.handler.avg)}ms  draw ${round2(this.draw.avg)}ms`,
			`age@draw ${round2(this.drawAge.avg)}ms  age@present ${round2(this.presentAge.avg)}ms`,
			`frame ${statText(this.frameInterval.summary())}`,
		].join("\n");
	}

	static summaryText(s: StrokeSummary): string {
		const lines = [
			`[${s.mode}] ${s.durationMs}ms  move ${s.moveHz}Hz raw ${s.rawHz}Hz`,
			`samples ${s.samples} (acc ${s.accepted} / dedup ${s.deduped})  coalesced avg ${s.coalescedPerEvent.avg} max ${s.coalescedPerEvent.max}`,
			`delivery ${s.deliveryAgeMs.avg}/${s.deliveryAgeMs.max}ms  handler ${s.handlerMs.avg}/${s.handlerMs.max}ms  draw ${s.drawMs.avg}/${s.drawMs.max}ms`,
			`age@draw ${s.ageAtDrawMs.avg}/${s.ageAtDrawMs.max}ms  age@present ${s.ageAtPresentMs.avg}/${s.ageAtPresentMs.max}ms`,
			`frame ${statText(s.frameIntervalMs)}`,
		];
		if (s.predMode !== "off") {
			lines.push(
				`pred ${s.predMode} (api ${s.predApi})  tails ${s.predTails} suppressed ${s.predSuppressed}`,
				`  pts ${s.predPointsPerTail.avg}/${s.predPointsPerTail.max}  horizon ${s.predHorizonMs.avg}/${s.predHorizonMs.max}ms` +
					`  tip ${s.predTipDistPx.avg}/${s.predTipDistPx.max}px  err ${s.predCorrectionPx.avg}/${s.predCorrectionPx.max}px`
			);
		}
		return lines.join("\n");
	}
}
