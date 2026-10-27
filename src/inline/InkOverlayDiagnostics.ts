/**
 * The note surface's diagnostics: the zoom, latency and surface reports, the
 * router counters, the region census and presentation capture, and the
 * per-stroke commit readback and layer probe. Each runs on a diagnostics
 * command, or at a pen-down or lift with diagnostics or the pen probe on.
 * They are methods of InkOverlayPlugin, installed on its prototype when
 * InkOverlay.ts loads. The pen probe's per-sample recorder and the
 * present-age probe, which feeds prediction, stay in the class.
 */
import { installMethods } from "./InstallMethods";
import { countPaintedPixels } from "../diag/Raster";
import type { InkStroke } from "../ink/Stroke";
import { describeEl } from "./PenHitProbe";
import { setProbeGeometry } from "./PenProbe";
import { capturePresented, parseHexColor, regionCensus, type ProbeBox } from "./PresentProbe";
import { bboxVisibleInViewport, scrollProbeCommit, scrollProbeLayers } from "./ScrollProbe";
import { ZERO_EXTENT, inkFrontier, isScrollableOverflow, surfaceExtents, type Extent } from "./SurfaceExtent";
import { noteToVisual, rasterScale } from "./ZoomScale";
import { SCALE_EPSILON, canvasReallocs, inlineInk, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		zoomReport(): string;
		routerCounters(): { downs: number; ups: number; backstops: number; silentLifts: number; palms: number };
		latencyReport(): string;
		currentTargetBox(): { canvas: ProbeBox; client: ProbeBox } | null;
		censusReport(liveContainers: Element[]): string | null;
		presentationReport(): Promise<string | null>;
		recordCommitDiagnostics(stroke: InkStroke, path: string, wetPx: number, sample: { x: number; y: number; w: number; h: number; clippedPct: number }): void;
		probeStrokeLayers(): void;
		strokeScreenSample(stroke: InkStroke): { x: number; y: number; w: number; h: number; clippedPct: number };
		topElementAtStroke(sample: { x: number; y: number; w: number; h: number }): string;
		captureProbeGeometry(): void;
		surfaceReport(): string;
	}
}

	/** Everything needed to identify the zoom mechanism from hardware. */
	function zoomReport(this: InkOverlayPlugin): string {
		const rect = this.container?.getBoundingClientRect();
		const content = this.view.contentDOM.getBoundingClientRect();
		const originLeft = this.columnLeft();
		const cs = this.winRef.getComputedStyle(this.view.contentDOM);
		return [
			`file: ${this.filePath() ?? "(none)"}`,
			`devicePixelRatio: ${this.winRef.devicePixelRatio}`,
			`measured scale: ${this.scale}  (cssScale ${this.cssScale} × fontZoom ${this.fontZoom}; CM scaleX ${this.view.scaleX}, scaleY ${this.view.scaleY})`,
			`font: current ${this.lastFontStr || "(unread)"} reference ${this.refFontPx}px  camera zoom ${this.camera.zoom}`,
			`overlay rect: ${rect?.width.toFixed(2)} x ${rect?.height.toFixed(2)} (visual px)`,
			`overlay offset: ${this.container?.offsetWidth} x ${this.container?.offsetHeight} (layout px)`,
			`content rect left/width: ${content.left.toFixed(2)} / ${content.width.toFixed(2)}` +
				`  origin (column left, camera-facing): ${originLeft.toFixed(2)}`,
			`content offsetWidth: ${this.view.contentDOM.offsetWidth}`,
			`content font-size / line-height: ${cs.fontSize} / ${cs.lineHeight}`,
			`documentTop: ${this.view.documentTop.toFixed(2)}  contentHeight: ${this.view.contentHeight.toFixed(2)}`,
			`canvas backing: ${this.committedCanvas?.width} x ${this.committedCanvas?.height}` +
				`  css: ${this.cssWidth.toFixed(2)} x ${this.cssHeight.toFixed(2)}`,
			`camera origin (note space): ${this.camera.x.toFixed(2)}, ${this.camera.y.toFixed(2)}`,
			`strokes on this note: ${this.filePath() ? inlineInk.strokes(this.filePath()!).length : 0}`,
			`canvas reallocations since load (all editors): ${canvasReallocs}` +
				"  (4 per resize; a pinch should add ~4 in total, not ~4 per frame)",
		].join("\n");
	}

	function routerCounters(this: InkOverlayPlugin): {
		downs: number;
		ups: number;
		backstops: number;
		silentLifts: number;
		palms: number;
	} {
		return {
			downs: this.router?.penDowns ?? 0,
			ups: this.router?.penUps ?? 0,
			backstops: this.router?.fallbackEnds ?? 0,
			silentLifts: this.router?.silentLiftEnds ?? 0,
			palms: this.router?.palmsBlocked ?? 0,
		};
	}

	/** What the two latency-critical canvases actually got, not what was asked. */
	function latencyReport(this: InkOverlayPlugin): string {
		return `canvas latency: wet [${this.wet.describe()}]  ${this.tail.describeLatency()}`;
	}

	/**
	 * The last committed stroke's box under the CURRENT camera, clamped to
	 * the canvas. Null when there is no target or it left the viewport.
	 */
	function currentTargetBox(this: InkOverlayPlugin): { canvas: ProbeBox; client: ProbeBox } | null {
		if (!this.lastCommitNote || !this.container) return null;
		const n = this.lastCommitNote;
		const z = this.camera.zoom;
		const sx = (n.x - this.camera.x) * z;
		const sy = (n.y - this.camera.y) * z;
		const x = Math.max(0, sx);
		const y = Math.max(0, sy);
		const w = Math.min(this.cssWidth, sx + n.w * z) - x;
		const h = Math.min(this.cssHeight, sy + n.h * z) - y;
		if (w <= 0 || h <= 0) return null;
		return {
			canvas: { x, y, w, h },
			client: {
				x: this.lastSyncRectLeft + noteToVisual(x, this.cssScale),
				y: this.lastSyncRectTop + noteToVisual(y, this.cssScale),
				w: noteToVisual(w, this.cssScale),
				h: noteToVisual(h, this.cssScale),
			},
		};
	}

	/** Region census at the last commit's current screen box. */
	function censusReport(this: InkOverlayPlugin, liveContainers: Element[]): string | null {
		const t = this.currentTargetBox();
		if (!t || !this.container) return null;
		const b = t.client;
		// Pad a little so near-miss overlays are listed too.
		return regionCensus(
			{ x: b.x - 8, y: b.y - 8, w: b.w + 16, h: b.h + 16 },
			this.container,
			liveContainers
		);
	}

	/**
	 * Composited frame vs committed backing, note-anchored. HARD VALIDITY
	 * GATE: no verdict unless the committed backing contains pixels at the
	 * target at the moment of capture.
	 */
	async function presentationReport(this: InkOverlayPlugin): Promise<string | null> {
		if (!this.lastCommitNote) return null;
		const header = `Handwriting presentation capture: stroke ${this.lastCommitId.slice(0, 8)}, committed ${((performance.now() - this.lastCommitAt) / 1000).toFixed(1)}s ago, note box (${this.lastCommitNote.x.toFixed(0)},${this.lastCommitNote.y.toFixed(0)} ${this.lastCommitNote.w.toFixed(0)}x${this.lastCommitNote.h.toFixed(0)})`;
		if (this.filePath() !== this.lastCommitPath) {
			return `${header}\nINVALID: this pane no longer shows ${this.lastCommitPath ?? "(unknown)"}; no verdict.`;
		}
		const t = this.currentTargetBox();
		if (!t) {
			return `${header}\nINVALID: target is outside the viewport under the current camera (scroll it into view and rerun); no verdict.`;
		}
		const backingNow = countPaintedPixels(
			this.committedCtx,
			t.canvas.x,
			t.canvas.y,
			t.canvas.w,
			t.canvas.h,
			this.backingNow()
		);
		if (backingNow <= 0) {
			return `${header}\nINVALID: committed backing has ${backingNow === 0 ? "no pixels" : "unreadable pixels"} at the recomputed target (canvas box ${t.canvas.x.toFixed(0)},${t.canvas.y.toFixed(0)} ${t.canvas.w.toFixed(0)}x${t.canvas.h.toFixed(0)}); no verdict. A repaint may not have run since a camera move. Nudge scroll by one notch and rerun.`;
		}
		const inkRGB = parseHexColor(this.lastCommitColor);
		const cap = await capturePresented(t.client, inkRGB, this.winRef);
		const inkPresent = inkRGB ? cap.inkMatchedPx > 0 : cap.presentedPx > 0;
		const verdict = !cap.ok
			? "NO VERDICT: capture unavailable; census + eyes remain the instruments"
			: !inkPresent
				? "*** VERDICT: BACKING HAS INK, COMPOSITED FRAME DOES NOT. The compositor dropped the layer content (or an exact-background occluder; cross-check census). ***"
				: "*** VERDICT: COMPOSITED FRAME CONTAINS THE INK. If the glass still shows nothing, the loss is BELOW the compositor (DComp/DWM presentation). ***";
		return [
			header,
			`target (current camera)   : canvas (${t.canvas.x.toFixed(0)},${t.canvas.y.toFixed(0)} ${t.canvas.w.toFixed(0)}x${t.canvas.h.toFixed(0)})  client (${t.client.x.toFixed(0)},${t.client.y.toFixed(0)} ${t.client.w.toFixed(0)}x${t.client.h.toFixed(0)})`,
			`committed backing (now)   : ${backingNow} painted px  (VALID target)`,
			`composited frame (capture): ${cap.presentedPx} / ${cap.sampledPx} non-background px, ${cap.inkMatchedPx} matching the stroke's own color ${this.lastCommitColor || "(unknown)"}`,
			`capture detail            : ${cap.detail}`,
			verdict,
		].join("\n");
	}

	/** Diagnostics-only (explicitly enabled): commit readback + COMMIT row. */
	function recordCommitDiagnostics(this: InkOverlayPlugin,
		stroke: InkStroke,
		path: string,
		wetPx: number,
		sample: { x: number; y: number; w: number; h: number; clippedPct: number }
	): void {
		// Paint ground truth, part 2: did the commit draw reach the committed
		// backing store?
		const committedPx = countPaintedPixels(
			this.committedCtxFor(stroke.tool),
			sample.x,
			sample.y,
			sample.w,
			sample.h,
			this.backingNow()
		);
		// Frame-desync measure: the stroke was committed with the PEN-DOWN
		// camera; if the scroller moved during the stroke, a fresh frame
		// differs by exactly the visible snap-back distance.
		const fresh = this.freshFrame();
		scrollProbeCommit({
			strokeId: stroke.id,
			points: stroke.points.length,
			bboxX: stroke.bbox.x,
			bboxY: stroke.bbox.y,
			bboxW: stroke.bbox.width,
			bboxH: stroke.bbox.height,
			visible: bboxVisibleInViewport(
				stroke.bbox,
				this.camera.snapshot,
				this.cssWidth / this.camera.zoom,
				this.cssHeight / this.camera.zoom
			),
			storeCount: inlineInk.strokes(path).length,
			camX: this.camera.x,
			camY: this.camera.y,
			scrollLeft: this.view.scrollDOM.scrollLeft,
			scrollTop: this.view.scrollDOM.scrollTop,
			driftX: fresh ? fresh.x - this.camera.x : 0,
			driftY: fresh ? fresh.y - this.camera.y : 0,
			scrollsDuring: this.scrollsDuringStroke,
			wetPx,
			committedPx,
			sampleW: sample.w,
			sampleH: sample.h,
			clippedPct: sample.clippedPct,
			topEl: this.topElementAtStroke(sample),
		});
	}

	/** The scroll probe's per-stroke line: the scales, the backing, and the live canvases' grids and backing sizes. */
	function probeStrokeLayers(this: InkOverlayPlugin): void {
		const tail = this.tail?.inlineGrid ?? null;
		scrollProbeLayers({
			cssScale: this.cssScale,
			rasterScale: rasterScale(this.cssScale, this.pinchScaleNow, SCALE_EPSILON),
			backing: this.committedBacking ?? this.backingNow(),
			tileW: this.wetTileCanvas?.width ?? 0,
			tileH: this.wetTileCanvas?.height ?? 0,
			tileGrid: this.wet?.tileGrid ?? null,
			tailW: this.tailCanvas?.width ?? 0,
			tailH: this.tailCanvas?.height ?? 0,
			tailGrid: tail?.grid ?? null,
			tailMode: tail?.mode ?? "none",
			bandW: this.committedCanvas?.width ?? 0,
			bandH: this.committedCanvas?.height ?? 0,
			dpr: this.winRef.devicePixelRatio,
		});
	}

	/**
	 * The stroke's screen-space bbox (camera frame, CSS px), padded by the
	 * pen width and clamped to the canvas. `clippedPct` is how much of the
	 * padded bbox fell OUTSIDE the canvas, a direct measure of edge
	 * clipping at the viewport boundary.
	 */
	function strokeScreenSample(this: InkOverlayPlugin, stroke: InkStroke): {
		x: number;
		y: number;
		w: number;
		h: number;
		clippedPct: number;
	} {
		const pad = 4;
		const z = this.camera.zoom;
		const sx = (stroke.bbox.x - this.camera.x) * z - pad;
		const sy = (stroke.bbox.y - this.camera.y) * z - pad;
		const sw = stroke.bbox.width * z + pad * 2;
		const sh = stroke.bbox.height * z + pad * 2;
		const x = Math.max(0, sx);
		const y = Math.max(0, sy);
		const w = Math.min(this.cssWidth, sx + sw) - x;
		const h = Math.min(this.cssHeight, sy + sh) - y;
		const fullArea = sw * sh;
		const clampedArea = Math.max(0, w) * Math.max(0, h);
		return {
			x,
			y,
			w: Math.max(0, w),
			h: Math.max(0, h),
			clippedPct: fullArea > 0 ? 1 - clampedArea / fullArea : 0,
		};
	}

	/** Top hit-testable element at the stroke sample's center, at commit. */
	function topElementAtStroke(this: InkOverlayPlugin, sample: { x: number; y: number; w: number; h: number }): string {
		const cx = this.lastSyncRectLeft + noteToVisual(sample.x + sample.w / 2, this.cssScale);
		const cy = this.lastSyncRectTop + noteToVisual(sample.y + sample.h / 2, this.cssScale);
		try {
			return describeEl(this.view.dom.ownerDocument.elementFromPoint(cx, cy));
		} catch {
			return "(err)";
		}
	}

	function captureProbeGeometry(this: InkOverlayPlugin): void {
		const rect = this.container?.getBoundingClientRect();
		setProbeGeometry({
			rectLeft: rect?.left ?? 0,
			rectTop: rect?.top ?? 0,
			scale: this.cssScale,
			dpr: this.dpr,
			backing: this.backingNow(),
			canvasCssW: this.cssWidth,
			canvasCssH: this.cssHeight,
			canvasBackingW: this.committedCanvas?.width ?? 0,
			canvasBackingH: this.committedCanvas?.height ?? 0,
			camX: this.camera.x,
			camY: this.camera.y,
			camZoom: this.camera.zoom,
			contentLeft: this.columnLeft(),
			documentTop: this.view.documentTop,
			desynchronizedRequested: this.wet?.requested ?? false,
			desynchronizedActual: String(this.wet?.actualDesynchronized),
		});
	}

	function surfaceReport(this: InkOverlayPlugin): string {
		const path = this.filePath();
		const scroller = this.view.scrollDOM;
		const granted: Extent = path ? surfaceExtents.get(path) : ZERO_EXTENT;
		const frontier = path ? inkFrontier(this.noteStrokes(path)) : ZERO_EXTENT;
		const reach = this.lastReach;
		return [
			`file: ${path ?? "(none)"}`,
			`ink frontier (note units): ${frontier.x.toFixed(1)}, ${frontier.y.toFixed(1)}`,
			`granted extent: ${granted.x}, ${granted.y}`,
			`spacer: ${this.spacer ? `present at ${this.spacerLeft}, ${this.spacerTop}` : "none"}  parent: ${this.spacer?.parentElement?.className ?? "-"}`,
			`scroller: client ${scroller.clientWidth} x ${scroller.clientHeight}  scroll ${scroller.scrollWidth} x ${scroller.scrollHeight}  at ${scroller.scrollLeft}, ${scroller.scrollTop}`,
			`computed overflow-x: ${this.winRef.getComputedStyle(scroller).overflowX}  overflow-y: ${this.winRef.getComputedStyle(scroller).overflowY}  position: ${this.winRef.getComputedStyle(scroller).position}`,
			`axis asserted by Handwriting: ${this.axisGuard.patched}`,
			reach
				? `last reconcile: required ${reach.required}, scrollWidth ${reach.scrollWidth}, client ${reach.clientWidth}: ` +
					(reach.scrollWidth >= reach.required
						? isScrollableOverflow(reach.overflowX)
							? "REACHABLE"
							: `EXTENT PRESENT BUT NOT USER-SCROLLABLE (overflow-x: ${reach.overflowX})`
						: "EXTENT MISSING: scrollWidth did not grow")
				: "last reconcile: (none yet)",
		].join("\n");
	}

export function installDiagnostics(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		zoomReport,
		routerCounters,
		latencyReport,
		currentTargetBox,
		censusReport,
		presentationReport,
		recordCommitDiagnostics,
		probeStrokeLayers,
		strokeScreenSample,
		topElementAtStroke,
		captureProbeGeometry,
		surfaceReport,
	});
}
