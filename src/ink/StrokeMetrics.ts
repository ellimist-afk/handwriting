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
 * indistinguishable from a clean result. Say which one it is. Landed on the
 * release line for 1.3.9; folded back here so the public tree never loses it.
 */
function statText(s: StatSummary, unit = "ms"): string {
	return s.n === 0 ? "(not recorded)" : `${s.avg}/${s.max}${unit}`;
}

/**
 * Same convention as statText, for a rate rather than a distribution:
 * zero events did not measure a zero rate - nothing measured it. Without
 * this, an uncounted rate and a genuine zero rate print the identical
 * `0Hz` - which is exactly what the PDF surface printed for the life of
 * its `onPenMove: () => {}` (fixed in `beb6fbb`), because moveHz/rawHz are
 * bare numbers with no sample count attached.
 *
 * Stated honestly: this gate is on the EVENT COUNT, not the rate. It
 * proves "nothing counted this". It does not and cannot distinguish that
 * from "counted, but slow" - a real 0Hz is still reachable with events
 * present over a long enough duration, and that case correctly prints
 * `0Hz` here, not "(not recorded)".
 */
function rateText(events: number, durationMs: number): string {
	return events === 0 ? "(not recorded)" : `${round2((events * 1000) / durationMs)}Hz`;
}

/** One script inside a long animation frame, as the browser attributes it. */
export interface LoafScript {
	invoker: string;
	sourceURL: string;
	sourceFunctionName: string;
	sourceCharPosition: number;
	duration: number;
	/** Style and layout this script forced synchronously, ms; 0 where it forced none. */
	forcedStyleAndLayoutMs: number;
}

/** A long animation frame: one that took 50 ms or more from start to paint. */
export interface LoafFrame {
	startTime: number;
	duration: number;
	blockingDuration: number;
	/** The frame's own style and layout, frame end less `styleAndLayoutStart`, ms; null where the entry has none. */
	styleAndLayoutMs: number | null;
	scripts: LoafScript[];
}

export interface LoafSummary {
	/** False where the browser has no long-animation-frame entries: nothing measured, not zero. */
	supported: boolean;
	frames: LoafFrame[];
}

/**
 * Where a stroke's long frames come from. The browser's source below in the
 * plugin; a fake in the tests, which run in Node with no such entry type.
 */
export interface LoafSource {
	supported(): boolean;
	/** Idempotent. Called once per stroke from `begin`, never per pointer event. */
	start(): void;
	/** Frames overlapping [from, to), in the performance.now() clock, after taking any entries still queued. */
	framesBetween(from: number, to: number): LoafFrame[];
	/**
	 * Hands `add` each frame overlapping [from, to) that is delivered after this call, as it is delivered, until
	 * a frame starting at or after `to` shows every overlapping frame has come. Called once per stroke from `end`.
	 */
	watch(from: number, to: number, add: (frame: LoafFrame) => void): void;
}

/**
 * Long-animation-frame entries (Chromium 123+) through one shared observer.
 *
 * Cost: the observer's callback runs only when a frame is already long, so
 * a smooth stroke pays nothing per event. `begin` pays one flag check;
 * `end` pays a takeRecords and a filter over at most KEEP frames. Nothing
 * here is created until the first stroke starts.
 *
 * A stroke's window stays open after `end` until a frame past it arrives, so
 * the frame spanning the lift, which is queued only once it completes, lands
 * in that stroke's summary however many frames follow it. At most WATCH
 * windows stay open; the oldest is closed first.
 */
class BrowserLoafSource implements LoafSource {
	private static readonly KEEP = 64;
	private static readonly WATCH = 16;
	private observer: PerformanceObserver | null = null;
	private recent: LoafFrame[] = [];
	private open: { from: number; to: number; add: (frame: LoafFrame) => void }[] = [];
	private known: boolean | null = null;

	supported(): boolean {
		if (this.known === null) {
			this.known =
				typeof PerformanceObserver !== "undefined" &&
				(PerformanceObserver.supportedEntryTypes ?? []).includes("long-animation-frame");
		}
		return this.known;
	}

	start(): void {
		if (this.observer || !this.supported()) return;
		this.observer = new PerformanceObserver((list) => this.take(list.getEntries()));
		this.observer.observe({ type: "long-animation-frame", buffered: true });
	}

	framesBetween(from: number, to: number): LoafFrame[] {
		// The entry for the frame that ended the stroke may still be queued.
		if (this.observer) this.take(this.observer.takeRecords());
		return this.framesSeen(from, to);
	}

	private framesSeen(from: number, to: number): LoafFrame[] {
		return this.recent.filter((f) => f.startTime < to && f.startTime + f.duration > from);
	}

	watch(from: number, to: number, add: (frame: LoafFrame) => void): void {
		if (!this.observer) return;
		this.open.push({ from, to, add });
		if (this.open.length > BrowserLoafSource.WATCH) this.open.shift();
	}

	private take(entries: PerformanceEntryList): void {
		for (const e of entries) {
			const f = loafFrameOf(e);
			this.recent.push(f);
			if (this.open.length > 0) this.hand(f);
		}
		if (this.recent.length > BrowserLoafSource.KEEP) this.recent.splice(0, this.recent.length - BrowserLoafSource.KEEP);
	}

	/** Frames arrive in the order they end, and frames do not overlap, so one starting at or past `to` closes the window. */
	private hand(f: LoafFrame): void {
		this.open = this.open.filter((w) => {
			if (f.startTime < w.to && f.startTime + f.duration > w.from) w.add(f);
			return f.startTime < w.to;
		});
	}
}

/** The fields this report prints, copied out of the live entry. */
function loafFrameOf(e: PerformanceEntry): LoafFrame {
	const f = e as PerformanceEntry & {
		blockingDuration?: number;
		styleAndLayoutStart?: number;
		scripts?: (Partial<Omit<LoafScript, "forcedStyleAndLayoutMs">> & { forcedStyleAndLayoutDuration?: number })[];
	};
	// 0 is the entry's "no style and layout phase", not a time.
	const sl = f.styleAndLayoutStart;
	return {
		startTime: e.startTime,
		duration: e.duration,
		blockingDuration: f.blockingDuration ?? 0,
		styleAndLayoutMs: typeof sl === "number" && sl > 0 ? Math.max(0, e.startTime + e.duration - sl) : null,
		scripts: (f.scripts ?? []).map((s) => ({
			invoker: s.invoker ?? "",
			sourceURL: s.sourceURL ?? "",
			sourceFunctionName: s.sourceFunctionName ?? "",
			sourceCharPosition: s.sourceCharPosition ?? -1,
			duration: s.duration ?? 0,
			forcedStyleAndLayoutMs: s.forcedStyleAndLayoutDuration ?? 0,
		})),
	};
}

const browserLoaf = new BrowserLoafSource();

/**
 * A stroke's long frames. The frame that spans the lift is queued only once it completes, which is after
 * `end` has run, so a snapshot taken at `end` would miss it for good. The source hands the summary each
 * later frame in its window as it is delivered, so the report holds it whenever it is read, even after the
 * source's own buffer has moved past it. Nothing is done per pointer event.
 */
function loafSummaryFor(source: LoafSource, from: number, to: number): LoafSummary {
	const frames = source.framesBetween(from, to);
	source.watch(from, to, (f) => {
		if (!frames.some((g) => g.startTime === f.startTime)) frames.push(f);
	});
	return { supported: true, frames };
}

/** `invoker  function file:char`, the file cut to its last path segment. */
function loafScriptText(s: LoafScript): string {
	const file = s.sourceURL.split(/[\\/]/).pop() || "(no source)";
	const at = s.sourceCharPosition >= 0 ? `${file}:${s.sourceCharPosition}` : file;
	const forced = s.forcedStyleAndLayoutMs > 0 ? `  forced style/layout ${Math.round(s.forcedStyleAndLayoutMs)}ms` : "";
	return `  script ${Math.round(s.duration)}ms  ${s.invoker || "(unknown)"}  ${s.sourceFunctionName || "(anonymous)"} ${at}${forced}`;
}

/** Three longest frames, three longest scripts each: the text stays readable. */
function loafText(l: LoafSummary): string[] {
	if (!l.supported) return ["long frames (not recorded)"];
	if (l.frames.length === 0) return ["long frames 0"];
	const d = l.frames.map((f) => f.duration);
	const blocking = l.frames.reduce((a, f) => a + f.blockingDuration, 0);
	const lines = [
		`long frames ${l.frames.length}  ${round2(d.reduce((a, v) => a + v, 0) / d.length)}/${round2(Math.max(...d))}ms  blocking ${round2(blocking)}ms`,
	];
	for (const f of [...l.frames].sort((a, b) => b.duration - a.duration).slice(0, 3)) {
		const sl = f.styleAndLayoutMs === null ? "(not recorded)" : `${Math.round(f.styleAndLayoutMs)}ms`;
		lines.push(`  frame ${Math.round(f.duration)}ms  blocking ${Math.round(f.blockingDuration)}ms  style/layout ${sl}`);
		for (const s of [...f.scripts].sort((a, b) => b.duration - a.duration).slice(0, 3)) lines.push(loafScriptText(s));
	}
	return lines;
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
	queueDepthMax: number;
	/** Resize operations on the initiating inline tail during this stroke; null when unmeasured. */
	tailBackingResizes: number | null;
	// ---- prediction experiment (v0.1.3) ----
	predMode: string;
	predApi: string;
	/** Horizon ceiling the caps allowed, ms. Adapts per machine; see adaptiveCaps. */
	predCapMs: number;
	predTails: number;
	predSuppressed: number;
	predPointsPerTail: StatSummary;
	predHorizonMs: StatSummary;
	predTipDistPx: StatSummary;
	predCorrectionPx: StatSummary;
	/** Long animation frames that overlapped this stroke. */
	loaf: LoafSummary;
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
	private queueMax = 0;
	private lastFrameTs = 0;
	private tailResizeStart: number | null = null;

	private predMode = "off";
	private predApi = "unknown";
	private predCapMs = 0;
	private predTails = 0;
	private predSuppressed = 0;
	private predPoints = new Stat();
	private predHorizon = new Stat();
	private predTip = new Stat();
	private predCorrection = new Stat();

	summaries: StrokeSummary[] = [];
	/** Never reset, never capped: the honest count of strokes that ended. */
	totalEnded = 0;

	constructor(private readonly loafSource: LoafSource = browserLoaf) {}

	begin(mode: string, now: number, tailResizeTotal?: number): void {
		// Per stroke, like every other prediction field. Left standing, the
		// FIRST stroke that ever predicted made every later report say
		// "pred on" - including strokes drawn with the setting off, which
		// then read as prediction running and producing nothing. It sent a
		// flicker hunt after a feature that was not even switched on
		// (alan, hardware, 2026-08-30).
		this.predMode = "off";
		this.predApi = "unknown";
		this.predCapMs = 0;
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
		this.queueMax = 0;
		this.lastFrameTs = 0;
		this.tailResizeStart = tailResizeTotal ?? null;
		this.loafSource.start();
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

	recordQueue(depth: number): void {
		if (this.active && depth > this.queueMax) this.queueMax = depth;
	}

	setPrediction(mode: string, api: string, capMs = 0): void {
		this.predMode = mode;
		this.predApi = api;
		this.predCapMs = capMs;
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

	end(now: number, tailResizeTotal?: number): StrokeSummary {
		this.active = false;
		const durationMs = Math.max(1, now - this.startedAt);
		const tailBackingResizes = this.tailResizeStart === null || tailResizeTotal === undefined
			? null : tailResizeTotal - this.tailResizeStart;
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
			queueDepthMax: this.queueMax,
			tailBackingResizes,
			predMode: this.predMode,
			predApi: this.predApi,
			predCapMs: round2(this.predCapMs),
			predTails: this.predTails,
			predSuppressed: this.predSuppressed,
			predPointsPerTail: this.predPoints.summary(),
			predHorizonMs: this.predHorizon.summary(),
			predTipDistPx: this.predTip.summary(),
			predCorrectionPx: this.predCorrection.summary(),
			loaf: this.loafSource.supported()
				? loafSummaryFor(this.loafSource, this.startedAt, now)
				: { supported: false, frames: [] },
		};
		this.totalEnded++;
		this.summaries.push(summary);
		if (this.summaries.length > 20) this.summaries.shift();
		return summary;
	}

	/**
	 * Uncalled - confirmed by grep, one hit, this definition. Not dead code
	 * to prune: it is the live counterpart to summaryText, an instance
	 * method that reads the counters directly so metrics can be sampled
	 * DURING a stroke, which summaryText structurally cannot do because it
	 * formats an already-finished StrokeSummary. It is also the only live
	 * consumer of statText. Deleting it would lose the one sampling path a
	 * future in-progress HUD would need; kept deliberately until that HUD
	 * exists.
	 */
	liveText(): string {
		return [
			`mode ${this.mode}`,
			`move ${this.moveEvents} raw ${this.rawEvents} samples ${this.samples} (acc ${this.accepted})`,
			`delivery ${round2(this.deliveryAge.avg)}ms  handler ${round2(this.handler.avg)}ms  draw ${round2(this.draw.avg)}ms`,
			`age@draw ${round2(this.drawAge.avg)}ms  age@present ${round2(this.presentAge.avg)}ms`,
			`frame ${statText(this.frameInterval.summary())}  queueMax ${this.queueMax}`,
		].join("\n");
	}

	static summaryText(s: StrokeSummary): string {
		const lines = [
			`[${s.mode}] ${s.durationMs}ms  move ${rateText(s.moveEvents, s.durationMs)} raw ${rateText(s.rawEvents, s.durationMs)}`,
			`samples ${s.samples} (acc ${s.accepted} / dedup ${s.deduped})  coalesced avg ${s.coalescedPerEvent.avg} max ${s.coalescedPerEvent.max}`,
			`delivery ${s.deliveryAgeMs.avg}/${s.deliveryAgeMs.max}ms  handler ${s.handlerMs.avg}/${s.handlerMs.max}ms  draw ${s.drawMs.avg}/${s.drawMs.max}ms`,
			`age@draw ${s.ageAtDrawMs.avg}/${s.ageAtDrawMs.max}ms  age@present ${s.ageAtPresentMs.avg}/${s.ageAtPresentMs.max}ms`,
			`frame ${statText(s.frameIntervalMs)}  queueMax ${s.queueDepthMax}`,
			`tail backing resizes ${s.tailBackingResizes ?? "(not recorded)"}`,
		];
		if (s.predMode !== "off") {
			lines.push(
				`pred ${s.predMode} (api ${s.predApi})  cap ${s.predCapMs}ms  tails ${s.predTails} suppressed ${s.predSuppressed}`,
				`  pts ${s.predPointsPerTail.avg}/${s.predPointsPerTail.max}  horizon ${s.predHorizonMs.avg}/${s.predHorizonMs.max}ms` +
					`  tip ${s.predTipDistPx.avg}/${s.predTipDistPx.max}px  err ${s.predCorrectionPx.avg}/${s.predCorrectionPx.max}px`
			);
		}
		lines.push(...loafText(s.loaf));
		return lines.join("\n");
	}
}
