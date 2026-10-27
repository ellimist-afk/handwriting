/**
 * The pdf surface's instruments: the pen-trace lines written at pen-down, pen-raw and pen-up and the reticle-outcome tally behind them, the pen-down
 * debug record and the controller's text report, and the stroke frame ticker and the end of a gesture's measurement. They are methods of
 * PdfInkController, installed on its prototype when PdfInkController.ts loads.
 */
import { StrokeMetrics } from "../ink/StrokeMetrics";
import { ribbonCacheStats } from "../ink/StrokeRenderer";
import { getInlineTool, penReticleEnabled } from "../inline/InkOverlay";
import { traceSurface } from "../inline/InlinePenRouter";
import { describeEl } from "../inline/PenHitProbe";
import { PenSample } from "../input/PointerRouter";
import { PenContactIntent, tipMode } from "../inline/TipMode";
import { PageBox, toPagePoint } from "./PageMap";
import { ProbedViewer, probeViewer } from "./PdfViewerProbe";
import { installMethods } from "../inline/InstallMethods";
import type { ReticleOutcome, PdfInkController } from "./PdfInkController";

declare module "./PdfInkController" {
	interface PdfInkController {
		recordDown(ev: PointerEvent | undefined, sample: PenSample, box: PageBox, scale: number, scroller: HTMLElement, content: { x: number; y: number }): void;
		recordDownUnsafe(ev: PointerEvent | undefined, sample: PenSample, box: PageBox, scale: number, scroller: HTMLElement, content: { x: number; y: number }): void;
		describe(): string;
		tracePenDown(ev: PointerEvent | undefined, box: PageBox, scale: number, intent: PenContactIntent, probed: ProbedViewer): void;
		traceRawBatch(branch: string, sampleCount: number, ev: PointerEvent | undefined, reticleNote: string): void;
		describeReticleOutcome(outcome: ReticleOutcome | null): string;
		recordReticleOutcome(outcome: ReticleOutcome | null): void;
		startFrameTicker(): void;
		stopFrameTicker(): void;
		endMetrics(): void;
		tracePenUp(ev: PointerEvent | undefined): void;
	}
}

/**
 * A `penRaw` batch is traced once for the first 5 of a gesture, then every
 * 25th - a long drag can run into the hundreds of batches, and a report
 * with one line per batch is not one anybody reads. `penUp` forces one more
 * line for whichever batch this rate limit last skipped, so the gesture's
 * final state always reaches the report even when its index was not a
 * multiple of 25.
 */
function pdfRawShouldEmitBatch(index: number): boolean {
	return index <= 5 || index % 25 === 0;
}


	/**
	 * Every term of one pointer-to-page conversion, and the round trip back
	 * through the OVERLAY's real screen rectangle. The delta on the last line
	 * is the offset the person is seeing, decomposed: if it is zero here and
	 * visible on screen, the drawing is elsewhere than the overlay; if it is
	 * nonzero, one of these numbers names the term that put it there.
	 */
	function recordDown(this: PdfInkController,
		ev: PointerEvent | undefined,
		sample: PenSample,
		box: PageBox,
		scale: number,
		scroller: HTMLElement,
		content: { x: number; y: number }
	): void {
		// A diagnostic must never take the gesture down with it: the test
		// harness has no layout, and a real pane can be mid-teardown.
		try {
			this.recordDownUnsafe(ev, sample, box, scale, scroller, content);
		} catch {
			this.lastDownDebug = "  (unreadable this time)";
		}
	}

	function recordDownUnsafe(this: PdfInkController,
		ev: PointerEvent | undefined,
		sample: PenSample,
		box: PageBox,
		scale: number,
		scroller: HTMLElement,
		content: { x: number; y: number }
	): void {
		const r = (v: number): string => v.toFixed(2);
		const p = toPagePoint(box, scale, content.x, content.y);
		const rect = scroller.getBoundingClientRect();
		const overlay = this.overlays.get(box.pageNumber)?.canvas.getBoundingClientRect() ?? null;
		const lines = [
			`  client (${ev ? r(ev.clientX) : "?"}, ${ev ? r(ev.clientY) : "?"})  type ${ev?.pointerType ?? "?"}`,
			`  sample (${r(sample.x)}, ${r(sample.y)})  scroller rect (${r(rect.left)}, ${r(rect.top)})` +
				`  scroll (${r(scroller.scrollLeft)}, ${r(scroller.scrollTop)})`,
			`  content (${r(content.x)}, ${r(content.y)})  box page ${box.pageNumber}` +
				` at (${r(box.leftPx)}, ${r(box.topPx)}) size ${r(box.widthPx)}x${r(box.heightPx)}`,
			`  scale ${scale.toFixed(6)} (viewer says ${this.probe()?.scaleFactor?.toFixed(6) ?? "?"})` +
				`  page point (${p ? r(p.x) : "?"}, ${p ? r(p.y) : "?"})`,
		];
		if (overlay && p) {
			// Where the ink will actually be painted, measured off the live
			// overlay element rather than believed from the box numbers.
			const sx = overlay.left + p.x * (overlay.width / box.widthPx) * scale;
			const sy = overlay.top + p.y * (overlay.height / box.heightPx) * scale;
			lines.push(
				`  overlay rect (${r(overlay.left)}, ${r(overlay.top)}) size ${r(overlay.width)}x${r(overlay.height)}`,
				`  ink lands at client (${r(sx)}, ${r(sy)})` +
					(ev ? `  DELTA (${r(sx - ev.clientX)}, ${r(sy - ev.clientY)})` : "")
			);
		} else {
			lines.push(`  overlay: ${overlay ? "present" : "NOT ATTACHED YET"}  page point: ${p ? "ok" : "null"}`);
		}
		this.lastDownDebug = lines.join("\n");
	}

	/**
	 * Diagnostics: what the last sync actually decided, per page.
	 *
	 * "The marks did not appear" has several possible causes that look
	 * identical on screen - the page never went live, it went live and we
	 * asked for no strokes, or we painted and something covered it - and this
	 * separates them without another build.
	 */
	function describe(this: PdfInkController): string {
		// Uncached: a diagnostic that reports a cached reading is reporting on
		// itself.
		const probed = probeViewer(this.root, this.win);
		if (!probed) return "  controller: viewer not recognized";
		const live = probed.pages.filter((p) => p.hasCanvas).map((p) => p.pageNumber);
		const attached = [...this.overlays.keys()].sort((a, b) => a - b);
		const asked = probed.pages
			.filter((p) => this.strokes(p.pageNumber).length > 0)
			.map((p) => p.pageNumber);
		return [
			`  document id: ${this.documentId() ?? "(not identified yet - strokes are refused)"}`,
			`  viewer probes: ${this.probeReads} read, ${
				this.probeServed + this.probeInStroke
			} avoided (${this.probeInStroke} inside a stroke, ${this.probeServed} from cache)`,
			`  bound element: ${
				this.boundScroller === probed.scroller
					? "current"
					: "STALE - the viewer was replaced, rebinding"
			}`,
			`  live pages (viewer): ${live.join(", ") || "(none)"}`,
			`  pages with strokes to draw: ${asked.join(", ") || "(none)"}`,
			`  overlays attached: ${attached.join(", ") || "(none)"}`,
			`  overlays detached by the viewer: ${this.orphanCount}`,
			`  pages refused as rotated: ${[...this.rotated].join(", ") || "(none)"}`,
			`  palm touches shielded: ${this.palmShield.rejected}`,
			`  recent touch contacts (radius px, shield verdict):` +
				(this.palmShield.recent.length > 0
					? "\n" +
						this.palmShield.recent
							.map(
								(c, i) =>
									`    ${i + 1}. rX=${c.radiusX.toFixed(1)} rY=${c.radiusY.toFixed(1)} -> ${
										c.swallowed ? "swallowed (palm)" : "let through"
									}`
							)
							.join("\n")
					: " (none this session)"),
			`  pinches bridged: ${this.pinchBridge.bridged}`,
			`  ribbon cache (all surfaces): ${ribbonCacheStats().hits} hit / ${ribbonCacheStats().misses} miss`,
			`  ink metrics (${this.metrics.summaries.length} stroke(s) this session):` +
				(this.metrics.summaries.length > 0
					? "\n" +
						StrokeMetrics.summaryText(this.metrics.summaries[this.metrics.summaries.length - 1]!)
							.split("\n")
							.map((line) => `    ${line}`)
							.join("\n")
					: " (none yet - draw a stroke first)"),
			`  last pen-down:${this.lastDownDebug ? "\n" + this.lastDownDebug : " (none this session)"}`,
			`  pen trace: this surface writes pdf-pendown / pdf-raw / pdf-penup / pdf-hover lines into the shared handwriting pen trace above (Diagnostics: begin recording, then Bug report: show as text) - search for "pdf-" there, not here.`,
		].join("\n");
	}

	/**
	 * `pdf-pendown`: one line, at the point in `penDown` where every field
	 * below is already in scope and decided - `probed` has already been
	 * checked non-null with a real `scaleFactor` (the early returns above
	 * this call site cover "no viewer"/"no id"/"no box"/"rotated page" with
	 * their own user-facing notices, so this line does not chase them; see
	 * the report's "Unfinished" section for that gap, named rather than
	 * silently dropped). Caller already gated on `diagnosticsEnabled()`.
	 */
	function tracePenDown(this: PdfInkController,
		ev: PointerEvent | undefined,
		box: PageBox,
		scale: number,
		intent: PenContactIntent,
		probed: ProbedViewer
	): void {
		const tool = getInlineTool();
		const cursorParentIsScroller = this.cursorEl?.parentElement === probed.scroller;
		const note =
			`ptr=${ev?.pointerType ?? "?"} intent=${intent} mouseStroke=${this.mouseStroke} ` +
			`erasing=${this.erasing} tip=${tipMode()} tool=${tool} page=${box.pageNumber} ` +
			`scale=${scale.toFixed(6)} probe=ok scaleFactor=${probed.scaleFactor?.toFixed(6) ?? "null"} ` +
			`scroller=${describeEl(probed.scroller)} cursorEl=${this.cursorEl ? "present" : "none"} ` +
			`cursorParentIsScroller=${cursorParentIsScroller} reticleEnabled=${penReticleEnabled()}`;
		traceSurface("pdf-pendown", ev ?? null, note);
	}

	/**
	 * `pdf-raw`: one line for a `penRaw` batch, rate-limited by
	 * `pdfRawShouldEmitBatch` so a long drag does not flood the report.
	 * Every batch still updates `pdfTrace.lastNote`/`lastEv` regardless of
	 * the rate limit, so `penUp` can force out whichever batch this limit
	 * last skipped - the gesture's final state always reaches the report.
	 */
	function traceRawBatch(this: PdfInkController, branch: string, sampleCount: number, ev: PointerEvent | undefined, reticleNote: string): void {
		const index = this.pdfTrace.batchIndex;
		const note = `batch=${index} n=${sampleCount} branch=${branch} ${reticleNote}`;
		this.pdfTrace.lastNote = note;
		this.pdfTrace.lastEv = ev ?? null;
		if (pdfRawShouldEmitBatch(index)) {
			this.pdfTrace.lastEmittedIndex = index;
			traceSurface("pdf-raw", ev ?? null, note);
		}
	}

	/**
	 * The human half of a `ReticleOutcome`: `wrote` reads back
	 * `lastCursorTransform` (never recomputes it), everything else names
	 * the reason. `null` means the branch never asked the reticle for
	 * anything this batch - a pen draw, which hides its dot by design - and
	 * that is reported as a fact, not folded into "skipped".
	 */
	function describeReticleOutcome(this: PdfInkController, outcome: ReticleOutcome | null): string {
		if (outcome === null) return "reticle=not-attempted";
		if (outcome === "wrote") return `reticle=wrote transform=${this.lastCursorTransform ?? "?"}`;
		return `reticle=skipped reason=${outcome}`;
	}

	/** Tallies this gesture's erase/draw reticle outcomes for `pdf-penup`'s "dominant reason". */
	function recordReticleOutcome(this: PdfInkController, outcome: ReticleOutcome | null): void {
		this.pdfTrace.reticleAttempts++;
		const key = outcome ?? "not-attempted";
		this.pdfTrace.reticleOutcomeCounts[key] = (this.pdfTrace.reticleOutcomeCounts[key] ?? 0) + 1;
	}

	/** Feed recordFrame while a gesture is live; see the note surface's twin. */
	function startFrameTicker(this: PdfInkController): void {
		if (this.frameTicking) return;
		this.frameTicking = true;
		const tick = (ts: number): void => {
			if (!this.frameTicking) return;
			this.metrics.recordFrame(ts);
			this.win.requestAnimationFrame(tick);
		};
		this.win.requestAnimationFrame(tick);
	}

	function stopFrameTicker(this: PdfInkController): void {
		this.frameTicking = false;
	}

	/** Close the live gesture's measurement, if one is open. */
	function endMetrics(this: PdfInkController): void {
		this.stopFrameTicker();
		if (!this.metricsLive) return;
		this.metricsLive = false;
		this.metrics.end(performance.now());
	}

	/**
	 * `pdf-penup`, plus the forced `pdf-raw` line for whichever batch the
	 * rate limit in `traceRawBatch` last skipped - so the gesture's final
	 * batch always reaches the report even when its index was not one of
	 * the first 5 or a multiple of 25. Caller already gated on
	 * `diagnosticsEnabled()`.
	 */
	function tracePenUp(this: PdfInkController, ev: PointerEvent | undefined): void {
		if (this.pdfTrace.batchIndex > 0 && this.pdfTrace.lastEmittedIndex !== this.pdfTrace.batchIndex) {
			traceSurface(
				"pdf-raw",
				this.pdfTrace.lastEv,
				`${this.pdfTrace.lastNote} (forced at pen-up, rate limit had skipped it)`
			);
		}
		const wasErasing = this.erasing;
		// Mirrors the GUARD each branch below already checks, not its body:
		// every one of these branches calls its own hide*Cursor before it
		// can return, and the plain draw/ink path (none of them) is the one
		// case with no unconditional hide.
		const cursorHidden =
			wasErasing ||
			this.panLast !== null ||
			this.spaceLineY !== null ||
			this.dragFrom !== null ||
			this.lassoPts.length > 0;
		const counts = this.pdfTrace.reticleOutcomeCounts;
		const wrote = counts["wrote"] ?? 0;
		const skipped = this.pdfTrace.reticleAttempts - wrote;
		let dominant = "n/a";
		let dominantCount = 0;
		for (const key of Object.keys(counts)) {
			if (key === "wrote") continue;
			const n = counts[key] ?? 0;
			if (n > dominantCount) {
				dominant = key;
				dominantCount = n;
			}
		}
		traceSurface(
			"pdf-penup",
			ev ?? null,
			`wasErasing=${wasErasing} cursorHidden=${cursorHidden} batches=${this.pdfTrace.batchIndex} ` +
				`reticleSkipped=${skipped}/${this.pdfTrace.reticleAttempts} dominantSkipReason=${dominant}`
		);
	}

export function installPdfTrace(proto: PdfInkController): void {
	installMethods(proto, {
		recordDown,
		recordDownUnsafe,
		describe,
		tracePenDown,
		traceRawBatch,
		describeReticleOutcome,
		recordReticleOutcome,
		startFrameTicker,
		stopFrameTicker,
		endMetrics,
		tracePenUp,
	});
}
