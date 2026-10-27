/**
 * The note surface's pinch core: the pinch phases, the preview scale, the pan reads and writes, the raster column and the
 * preview ink offset. They are methods of InkOverlayPlugin, installed on its prototype when InkOverlay.ts loads.
 */
import { contentOriginLeft } from "./ContentOrigin";
import { anchorTop } from "./DocumentTop";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { InkTool } from "../ink/Stroke";
import { anchoredScroll, MAX_PINCH_SCALE, MAX_VIEWPORT_LAYOUT, PINCH_GIVE, pinchScale } from "./PinchScale";
import { validCameraScale } from "./ZoomScale";
import { type PreviewPaperEnd } from "./PaperPan";
import { scrollProbeExtent } from "./ScrollProbe";
import { installMethods } from "./InstallMethods";
import { settleHostBlank, settlePaintedHost } from "./InkOverlayPanSettle";
import { CONTENT_ORIGIN_EPSILON, inlineInk, type InkOverlayPlugin } from "./InkOverlay";

/**
 * The line under the fingers when a pinch takes over: its document position and its top in CodeMirror's height map, in
 * unscaled px, with the paint scale that top was divided by and the device pixel ratio, both at the takeover. Keyed by the gesture's anchor, then by the settle hold the lift makes from it; the hold's measure write reads
 * it once, after CodeMirror's rebuild at the new scale (InkOverlayZoomApi commitCameraScale).
 */
export const settleAnchorLines = new WeakMap<object, { readonly pos: number; readonly top: number; readonly paintScale: number; readonly dpr: number }>();

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		pinch(phase: "start" | "move" | "end", ratio: number, centroid: { x: number; y: number }): void;
		flushPinch(settle: boolean): void;
		applyPinchScale(next: number, settle: boolean): void;
		columnLocalAt(scale: number): number | null;
		contentTopLocalAt(scale: number): number | null;
		rasterPanTarget(): { x: number; y: number };
		bakeCanCarry(): boolean;
		rasterPanNeedsBake(): boolean;
		restorePinchLayers(): void;
		markCommittedPaint(tool: InkTool): void;
		unpanX(value: number | null): number | null;
		documentTopUnpanned(): number;
		captureRasterColumn(scale: number): void;
		applyPreviewInkOffset(next: number): void;
		writeInkLayerTransform(): void;
		onContentResize(width?: number): void;
		endPreviewPaper(reason: PreviewPaperEnd): void;
		panSizer(): HTMLElement | null;
		clearPreviewInkOffset(): void;
		pageContentWidth(): number;
	}
}

	// ---- eraser (canvas semantics: whole-stroke, hit-circle, live) -----------

	/**
	 * Two-finger pinch magnifies the editor without changing stored coordinates.
	 * Layout and raster changes wait until the gesture ends. Scale is computed
	 * from what was captured at "start", so an unconstrained pinch out and back
	 * lands exactly where it began. Visibility bounds discard blocked motion.
	 */
	function pinch(this: InkOverlayPlugin,
		phase: "start" | "move" | "end",
		ratio: number,
		centroid: { x: number; y: number }
	): void {
		if (this.retiring) return;
		// With the canvas off a two-finger gesture is not a zoom. Every phase is ignored here, so
		// no preview starts, nothing settles and nothing is left pending; the router keeps its own
		// touch bookkeeping (two fingers still count as two) and the page does not move.
		if (!this.canvasMode) return;
		// The router's ratios are relative to ITS gesture start. A preview the
		// watchdog settled in place re-anchors mid-gesture (`rebasePinch`), so
		// from then on they divide by the ratio at which that happened.
		// A lift's give still easing back to the cap: its own frames come through here as moves. A new
		// pinch engaging mid-ease TAKES THE ZOOM OVER from the scale on screen: the ease is dropped, nothing
		// settles, and the gesture starts with the preview still up (the same shape as a pinch that never
		// lifted), so the page does not move under the fingers; its own lift eases past-cap scale back
		// again. A second end while it eases finishes in place.
		if (this.pinchGive && !this.pinchGive.stepping) {
			if (phase === "move") return;
			if (phase === "end") { this.finishPinchGive(); return; }
			const give = this.pinchGive;
			if (give.raf !== 0) { this.winRef.cancelAnimationFrame(give.raf); give.raf = 0; }
			this.pinchGive = null;
		}
		if (phase === "start") { this.pinchRatioBase = 1; this.pinchLastRatio = 1; }
		else if (phase === "move") { this.pinchLastRatio = ratio; ratio = ratio / (this.pinchRatioBase || 1); }
		if (phase === "start") {
			if(this.getNoteViewportState().busy) return;
			// A new gesture anchors on the page where it rests, not on a bounce passing through.
			this.cancelOverscrollBounce();
			this.retirePanSettle("a new pinch");
			this.hideBlankPinchLayers();
			// Invalidate an earlier navigation's pending measure write.
			this.viewportGeneration++;
			this.pinchRefScale = this.pinchScaleNow;
			// The anchor is captured ONCE, here. Every frame of the gesture
			// is then computed from this state, so the view cannot chase the
			// fingers as they drift and rounding cannot accumulate.
			const scroller = this.view.scrollDOM;
			const rect = scroller.getBoundingClientRect();
			// COLUMN-RELATIVE, because host-local is not a fixed frame: under
			// Readable line length `.cm-sizer`'s auto margins re-centre the
			// column as the counter-sized host grows, so the same note point
			// has a different host-local x at every scale. Measured ONCE here;
			// `columnLocalAt` leaves the host's painted origin in
			// `previewHostOrigin`, so this costs the gesture one read and the
			// frames after it none.
			this.previewPanEngaged = false;
			const columnLocal = this.columnLocalAt(this.pinchScaleNow);
			const origin = this.previewHostOrigin;
			const contentTopLocal = this.contentTopLocalAt(this.pinchScaleNow);
			this.pinchStartPan.x = this.viewportPan?.x ?? 0; this.pinchStartPan.y = this.viewportPan?.y ?? 0;
			this.pinchBand.history.length = 0;
			this.pinchBand.lastPan.x = this.pinchStartPan.x; this.pinchBand.lastPan.y = this.pinchStartPan.y;
			this.pinchPaintedTarget = null;
			this.pinchPaintedValid = false;
			this.pinchAnchor = {
				scrollLeft: scroller.scrollLeft,
				scrollTop: scroller.scrollTop,
				offsetX: centroid.x - rect.left,
				offsetY: centroid.y - rect.top,
				focalX: centroid.x,
				focalY: centroid.y,
				// The PANNED origin: `columnLocalAt` and `contentTopLocalAt`
				// both subtract the live pan, so folding it back in here is what
				// makes the pair describe where the note was actually painted
				// when the fingers went down. A gesture that starts on top of a
				// residual pan is then the same arithmetic with no special case.
				hostLeft: (origin?.valid ? origin.left : rect.left) + this.panX(),
				hostTop: (origin?.valid ? origin.top : rect.top) + this.panY(),
				columnLocal,
				contentTopLocal,
				fromScale: this.pinchScaleNow,
				constraint: { clientX: centroid.x, clientY: centroid.y, offsetX: 0, offsetY: 0, geometry: null },
			};
			// THE LINE UNDER THE FINGERS, where it is PAINTED, read once here (the takeover reads layout already). A scale change
			// makes CodeMirror rebuild its height map, and the blocks it has not drawn take a one-line estimate, so the lines above
			// can change height at the lift; the settle reads this line's block again after that rebuild and moves the scroll by
			// what it moved. The painted top, not the height map's: the map can already be off the page here, and the fingers
			// hold the text they see. Top in document layout px, the units of lineBlockAt().top / scaleY:
			// (line rect top - documentTop) / cssScale: the scale the page is painted at, outer zoom included, which CodeMirror's
			// scaleY can miss until it next measures (an outer 0.75 read as 1 put a 100 percent line 114 px off its block).
			// Only a line the fingers are on: the canvas space beside or below the text is no line, and there the settle keeps
			// its target as it is.
			const fingerPos = this.view.posAtCoords({ x: centroid.x, y: centroid.y }, false);
			let fingerEl: Node | null = fingerPos === null ? null : this.view.domAtPos(fingerPos).node;
			while (fingerEl && !(fingerEl.nodeType === 1 && (fingerEl as Element).classList.contains("cm-line"))) fingerEl = fingerEl.parentNode === this.view.contentDOM ? null : fingerEl.parentNode;
			const fingerRect = fingerEl && fingerEl.nodeType === 1 ? (fingerEl as Element).getBoundingClientRect() : null;
			if (fingerPos !== null && fingerRect && centroid.y >= fingerRect.top && centroid.y < fingerRect.bottom) {
				const paintScale = Number.isFinite(this.cssScale) && this.cssScale > 0 ? this.cssScale : (this.view.scaleY || 1);
				const painted = (fingerRect.top - this.view.documentTop) / paintScale;
				if (Number.isFinite(painted)) settleAnchorLines.set(this.pinchAnchor, { pos: this.view.state.doc.lineAt(fingerPos).from, top: painted, paintScale, dpr: this.dpr });
			}
			// Capture the geometry once before coalescing can discard an input.
			// Preparing the layout records its dimensions; it does not paint a zoom.
			if (this.panSizer() && this.prepareViewportLayout()) this.refreshPinchConstraint(columnLocal, contentTopLocal);
			return;
		}
		const anchor = this.pinchAnchor;
		const constraint = anchor?.constraint;
		const targetMoved = !!anchor && Number.isFinite(centroid.x) && Number.isFinite(centroid.y) &&
			(centroid.x !== (constraint?.clientX ?? anchor.targetX ?? anchor.focalX) || centroid.y !== (constraint?.clientY ?? anchor.targetY ?? anchor.focalY));
		// THE LIFT LANDS THE FRAME THE USER LAST SAW. A finger reading that arrives after the last preview frame is never
		// painted; committing it moved the page at the lift - on Alan's Orion run, a 0.1 to 0.2 percent scale step at scroll
		// offsets in the thousands moved it 2.85 to 8.38 px, and the settle eased it back. With a frame painted, the lift
		// takes that frame's scale and target and drops the unpainted reading. With none painted, the lift is unchanged.
		const landPainted = phase === "end" && !!anchor && this.pinchPreview && this.pinchPaintedValid && !this.pinchGiveEnding;
		if (landPainted) {
			this.pinchPending = null;
			if (constraint) {
				constraint.clientX = this.pinchPaintedX; constraint.clientY = this.pinchPaintedY;
				constraint.offsetX = this.pinchPaintedOffsetX; constraint.offsetY = this.pinchPaintedOffsetY;
			} else { anchor.targetX = this.pinchPaintedX; anchor.targetY = this.pinchPaintedY; }
		}
		// A live frame may reach past the cap by PINCH_GIVE (preview only); the lift below eases it back.
		let next = phase === "end" ? this.pinchPending?.next ?? this.pinchScaleNow : pinchScale(this.pinchRefScale ?? this.pinchScaleNow, ratio, this.zoomFloor, true);
		if (phase === "end" && anchor && this.pinchRefScale !== null && this.pinchGive === null) {
			// The scale the old lift would have settled at: the same clamp, without the give.
			const cap = pinchScale(this.pinchRefScale, next / this.pinchRefScale, this.zoomFloor);
			if (Number.isFinite(cap) && Math.abs(cap - next) > 1e-9) {
				// Painted past the cap: ease the preview back to it over the bounce's half second, then settle there.
				if (this.pinchPreview) { this.startPinchGive(next, cap, landPainted ? { x: this.pinchPaintedX, y: this.pinchPaintedY } : centroid); return; }
				// Nothing painted past the cap yet (the lift beat the frame): settle inside the range, as before.
				this.pinchPending = { next: cap };
				next = cap;
			}
		}
		if (landPainted) this.reducePinchConstraint(next, true);
		else if (anchor && Number.isFinite(centroid.x) && Number.isFinite(centroid.y)) {
			if (constraint) { constraint.clientX = centroid.x; constraint.clientY = centroid.y; }
			else { anchor.targetX = centroid.x; anchor.targetY = centroid.y; }
			this.reducePinchConstraint(next, phase === "end");
		}
		if (phase === "end") {
			if (landPainted) this.pinchPending = { next: this.pinchScaleNow };
			else if (targetMoved && this.pinchPending === null) this.pinchPending = { next: this.pinchScaleNow };
			// Nothing may still be queued behind the settle: a live frame
			// running after it would write the mid-gesture styles back.
			if (this.pinchRaf !== 0) {
				this.winRef.cancelAnimationFrame(this.pinchRaf);
				this.pinchRaf = 0;
				this.clearDeferredRepaint();
			}
			try {
				// Settle while the gesture-start anchor and scale are still
				// available to the final coalesced move.
				this.flushPinch(true);
			} finally {
				this.restorePinchLayers();
				this.pinchRefScale = null;
				this.pinchAnchor = null;
				this.pinchPreview = false;
				this.pinchPaintedValid = false;
				// A preview that ended without its settle (cancelled, refused, or thrown) takes its paper down here.
				if (!this.previewPaperHandoff) this.endPreviewPaper("cancel");
				this.previewPaperHandoff = false;
				// A cancelled preview drops the snap's residual it was carrying.
				if (this.paperPanWritten) this.writePaperPan();
				this.releaseMeasures();
				if (this.viewportStyleDirty) this.scheduleViewportStyleRefresh();
			}
			return;
		}
		if (this.pinchRefScale === null || this.pinchAnchor === null) return;
		if (next === this.pinchScaleNow && this.pinchPending === null && !targetMoved) return;
		// Coalesce to one update per FRAME. Two fingers deliver pointermoves
		// faster than the display refreshes, and the work below is not the
		// kind you do twice for one frame.
		this.pinchPending = { next };
		if (this.pinchRaf === 0) {
			this.pinchRaf = this.winRef.requestAnimationFrame(() => {
				this.pinchRaf = 0;
				this.flushPinch(false);
			});
		}
	}

	/**
	 * Apply the pinch that this frame is owed.
	 *
	 * Live frames keep the physical viewport fixed with a counter-sized box,
	 * transform and anchored scroll. The fixed text column does not rewrap.
	 * `handleResize`, canvas allocation and rerasterization wait for lift.
	 *
	 * Doing all of it per pointermove is what made the gesture jagged and
	 * laggy on hardware (alan, 2026-08-27): a forced layout read, a full
	 * editor reflow and a complete ink re-raster, several times per frame.
	 * The cost of deferring is that the ink is a scaled raster mid-gesture -
	 * very slightly soft until release, which is what every canvas app does
	 * and what the eye forgives; a stuttering pinch is not.
	 */
	function flushPinch(this: InkOverlayPlugin, settle: boolean): void {
		if (!this.container) return;
		const pending = this.pinchPending;
		this.pinchPending = null;
		if (!pending && !settle) return;
		if (pending) this.applyPinchScale(pending.next, settle);
		else if (settle && (this.pinchPreview || this.pinchScaleNow !== this.pinchRasterScale))
			this.applyPinchScale(this.pinchScaleNow, true);
		// Only the probe reads this; with diagnostics off nothing is kept.
		const anchor = this.pinchAnchor;
		if (!settle && pending && anchor && diagnosticsEnabled())
			this.pinchPaintedTarget = { x: anchor.targetX ?? anchor.focalX, y: anchor.targetY ?? anchor.focalY, scale: pending.next,
				columnLocal: this.previewColumnLocal, geometry: anchor.constraint?.geometry ? { ...anchor.constraint.geometry } : null };
	}

	/**
	 * Magnify this editor, anchored under the fingers.
	 *
	 * The transform goes on the element the overlay hangs off, so text, ink and
	 * the overlay itself scale as one object and no stored coordinate moves.
	 * The overlay picks the new scale up on its own: `effectiveScale` measures
	 * painted width against layout width, which is exactly what a transform
	 * changes. This path retains the current magnification-only layout.
	 */
	function applyPinchScale(this: InkOverlayPlugin, next: number, settle: boolean): void {
		const anchor = this.pinchAnchor;
		if (!anchor) return;
		// Both scales come from the GESTURE, not from the previous frame: the
		// reference the gesture started at, and where it is being asked to go.
		const from = this.pinchRefScale ?? this.pinchScaleNow;
		const external=this.cssScale/this.pinchScaleNow;

		if (settle) {
			// SPEND THE PAN INTO THE SCROLL, as far as the surface reaches. The
			// preview holds the note with a translate, which needs no scroll
			// range; the settle would rather carry it as scroll, because scroll
			// is the state every other part of the camera already understands -
			// and because the browser positions a scroll to whole pixels, which
			// is where the mid-gesture fractions go to die. Moving the scroll by
			// dS shifts painted content by -dS * effective, so a pan of P is
			// worth a scroll of -P/effective. Whatever the clamp refuses, and
			// whatever fraction the whole-pixel scroll cannot express, comes
			// straight back as pan in `reanchorPan` - which is what keeps the
			// settled frame standing exactly where the last preview frame stood.
			const effScale = external * next;
			const pan = this.previewPanEngaged ? this.viewportPan : null;
			// WHERE THE PAGE WAS PAINTED, captured here and nowhere later. The settle owes
			// the ease the distance from the last preview frame's painted position to where the page lands,
			// and this is the last point at which that position can be read: measured, the blank reads
			// +15.00 here, 79.00 by `reanchorPan`'s entry with the sizer's transform BYTE-IDENTICAL, so it
			// is the scroll commit in between that moves the edge, not the preview coming off. Capturing
			// while the transform is still on is necessary and not sufficient; it must be before that
			// commit, which is here (measured in a device trace).
			// One forced layout per settle, never per preview frame.
			// INFINITE CANVAS OFF ONLY. The thirteen expanded-right-viewport arms that guard
			// committed ink are all Infinite-Canvas-ON, and the true-travel ease displaces ink on five of
			// them: the ease moves the page by its offset while the ink's baked raster does not follow
			// (`inkPanX()` is `panX() - rasterPan.x * cssScale`). With the setting on, the settle keeps the
			// correction it has always had; making the ink mapping ride the ease there is owed.
			// On Alan's "i want it all in 1.4.20": THE CAPTURE RUNS UNDER THE CANVAS TOO.
			// An earlier rule took this branch canvas-off only because the ease moves the page while the ink's baked
			// raster does not follow it. That left the canvas lift with no true-travel measurement, so the whole
			// correction landed in the commit's own turn.
			this.previewPaintedBlank = this.settleBlank();
			// The same place against the editor's parent, for the hold's re-aim of this ease (InkOverlayPanSettle, settleHostBlank).
			settlePaintedHost.set(this, settleHostBlank(this.view));
			if (diagnosticsEnabled()) { this.settlePaperT0 = performance.now(); this.traceSettlePaper("settle before commit"); }
			const spendable = !!pan && Number.isFinite(effScale) && effScale > 0;
			// FROM WHERE THE PREVIEW PAINTED THE PAGE: the whole scroll plus the residual the host transform carried (a scroll
			// target keeps only whole px; the rest rides the host as a translate, scaled by the preview's k). Derived from the
			// whole scroll alone, the commit dropped that residual and wrote its own in its place, so the page stepped by their
			// difference times k at the lift (1.5 px at k 5.98 for a 0.28 px residual). The residual counts only while it
			// belongs to the scroll the gesture started from. ACROSS only: DOWN keeps the whole scroll, as the constraint's
			// geometry does (refreshPinchConstraint): the text does not step by the residual on y, and adding it there moved the
			// ink off its text line by the residual's translate (WrappedTitlePinch anchor path, 0.167 note px at the 150% settle).
			const residual = this.scrollResidual;
			const paintedLeft = anchor.scrollLeft + (residual && residual.left === anchor.scrollLeft ? residual.x : 0);
			const paintedTop = anchor.scrollTop;
			let nextLeft = spendable && Number.isFinite(pan.x)
				? Math.max(0, paintedLeft - pan.x / effScale)
				: anchoredScroll(paintedLeft, anchor.offsetX, from*external, next*external);
			let nextTop = spendable && Number.isFinite(pan.y)
				? Math.max(0, paintedTop - pan.y / effScale)
				: anchoredScroll(paintedTop, anchor.offsetY, from*external, next*external);
			// The accepted target includes the final coalesced input, even if no
			// preview frame has painted. Derive its equivalent native offset from
			// the same zero-scroll snapshot used by the ordered constraint reducer.
			const geometry = anchor.constraint?.geometry;
			const offset = (focal: number, host: number, local: number | null, target: number,
				origin: number, inset: number | null, measured: boolean): number | null => {
				if (!measured || local === null || inset === null) return null;
				const q = (focal - host) / anchor.fromScale - local;
				const result = (origin + (q + inset) * next - target) / effScale;
				return Number.isFinite(result) ? Math.max(0, Math.min(MAX_VIEWPORT_LAYOUT, result)) : null;
			};
			// THE SCROLL TAKEN SINCE THE LAST PREVIEW FRAME. The snapshot is that frame's, so offset() lands the page where
			// that frame painted it; but the fingers' own touch scroll kept moving the page after it, with no frame to
			// re-pan, and the lift is where the user left it. That scroll, in scroller px, goes on into the target at the
			// same scale it was taken at. Measured on the rig: 5.00 scroller px after the last frame, a 5.42 px slide.
			const sx = this.view.scrollDOM.scrollLeft, sy = this.view.scrollDOM.scrollTop;
			const carry = (v: number | null, late: number): number | null =>
				v === null || !Number.isFinite(late) ? v : Math.max(0, Math.min(MAX_VIEWPORT_LAYOUT, v + late));
			const lateX = geometry ? sx - geometry.scrollLeft : 0, lateY = geometry ? sy - geometry.scrollTop : 0;
			const left = carry(this.canvasMode && geometry ? offset(anchor.focalX, anchor.hostLeft, anchor.columnLocal,
				anchor.targetX ?? anchor.focalX, geometry.left, geometry.naturalLeft, geometry.x) : null, lateX);
			const top = carry(this.canvasMode && geometry ? offset(anchor.focalY, anchor.hostTop, anchor.contentTopLocal,
				anchor.targetY ?? anchor.focalY, geometry.top, geometry.naturalTop, geometry.y) : null, lateY);
			if (left !== null) nextLeft = left;
			// THE SETTLE DOES NOT SCROLL INTO THE LEFT RESERVE. That scroll is room for ink left of the page, reached by
			// scrolling, so the fingers' place is written into the scroll no further left than the reserve, or than where
			// the scroll already stood if the user had scrolled into it. What the fingers took past that stays a pan, and
			// the settle's own ease takes it back to the page's edge, as a pen lift does.
			const reserveLeft = this.leftReserveHeld > 0 ? this.leftReserveHeld : 0;
			nextLeft = Math.max(nextLeft, Math.min(anchor.scrollLeft, reserveLeft));
			if (top !== null) nextTop = top;
			// The device probe's commit line: which path set the target, the scroll taken since the anchor, and the
			// commit's target and scale against what the last preview frame painted, in screen px and in scroller px.
			// Then the geometry inputs, as the last preview frame read them and as the commit holds them, so a device's lines
			// name the term if a landing still slides.
			if (diagnosticsEnabled()) { const p = this.pinchPaintedTarget, l = this.viewportLayout, n = (v: number | null | undefined) => v == null ? "-" : v.toFixed(2);
				const tx = anchor.targetX ?? anchor.focalX, ty = anchor.targetY ?? anchor.focalY, dx = p ? tx - p.x : NaN, dy = p ? ty - p.y : NaN;
				scrollProbeExtent(`settle commit path ${left !== null ? "geometry" : "anchor"},${top !== null ? "geometry" : "anchor"} drift ${(sx - anchor.scrollLeft).toFixed(2)},${(sy - anchor.scrollTop).toFixed(2)} late ${lateX.toFixed(2)},${lateY.toFixed(2)} target-painted ${dx.toFixed(2)},${dy.toFixed(2)} screen ${(dx / effScale).toFixed(2)},${(dy / effScale).toFixed(2)} scroller scale ${next.toFixed(4)} painted ${p ? p.scale.toFixed(4) : "-"}`);
				const g = p?.geometry;
				scrollProbeExtent(`settle geom paint gutterScreen ${n(g?.gutterScreen)} naturalLeft ${n(g?.naturalLeft)} naturalTop ${n(g?.naturalTop)} columnLocal ${n(p?.columnLocal)} contentTopLocal ${n(g && g.naturalTop !== null ? g.naturalTop - g.scrollTop * g.external : null)} paneWidth ${n(g?.paneWidth)} paneHeight ${n(g?.paneHeight)} pageWidth ${n(g?.pageWidth)} external ${g ? g.external.toFixed(4) : "-"} scale ${p ? p.scale.toFixed(4) : "-"} scroll ${n(g?.scrollLeft)},${n(g?.scrollTop)}`);
				scrollProbeExtent(`settle geom commit gutterScreen ${n(l?.gutterScreen)} naturalLeft ${n(geometry?.naturalLeft)} naturalTop ${n(geometry?.naturalTop)} columnLocal ${n(anchor.columnLocal)} contentTopLocal ${n(anchor.contentTopLocal)} paneWidth ${n(l?.width)} paneHeight ${n(l?.paneHeight)} pageWidth ${n(this.pageContentWidth())} external ${external.toFixed(4)} scale ${next.toFixed(4)} scroll ${n(sx)},${n(sy)} target ${n(nextLeft)},${n(nextTop)}`); }
			// This settle, and only this one, closes a preview this gesture painted.
			this.previewSettleOwed = true;
			this.pinchPreview = false;
			this.releaseMeasures();
			this.clearDeferredRepaint();
			// The commit below re-rasters against the settled column, so the
			// preview's translation must come off first or it would be applied
			// twice - once in the pixels, once in the transform.
			this.clearPreviewInkOffset();
			// Keep authority through geometry convergence and the owned scroll
			// request's consumption. New input or navigation retires it first.
			this.panAnchorHold = this.panSizer() ? {
				expansion: this.canvasMode && (left !== null || top !== null) ? {
					left: left ?? this.view.scrollDOM.scrollLeft, top: top ?? this.view.scrollDOM.scrollTop,
				} : null,
				focalX: anchor.focalX, focalY: anchor.focalY, targetX: anchor.targetX, targetY: anchor.targetY,
				hostLeft: anchor.hostLeft, hostTop: anchor.hostTop,
				columnLocal: anchor.columnLocal, contentTopLocal: anchor.contentTopLocal,
				fromScale: anchor.fromScale, scrollLeft: anchor.scrollLeft, scrollTop: anchor.scrollTop, toScale: next,
				generation: this.viewportGeneration + 1, path: this.filePath(), container: this.container,
				left: this.view.scrollDOM.scrollLeft, top: this.view.scrollDOM.scrollTop, ready: false, outcome: "pending", attempts: 0, request: null, issuance: [],
			} : null;
			const fingerLine = settleAnchorLines.get(anchor);
			if (this.panAnchorHold && fingerLine) settleAnchorLines.set(this.panAnchorHold, fingerLine);
			// The final transaction establishes the range before its scroll writes.
			// Its commit ends the preview; the preview paper stays up until this settle decides below.
			this.previewPaperSettling = true;
			let committed = false;
			try { committed = this.commitCameraScale(next, {left:nextLeft,top:nextTop}, this.panAnchorHold); } finally { this.previewPaperSettling = false; }
			// A REFUSED SETTLE IS AN EXIT PATH. Nothing downstream is going to
			// re-derive this pan, so it must not be left on the children with
			// no gesture tracking it.
			if (!committed) { this.endPreviewPaper("cancel"); this.retirePanSettle("the settle commit was refused"); this.clearViewportPan(); return; }
			this.pinchRasterScale = next;
			// The commit has written the scroll, with its own corrections to x (the page box, the margin debt, a fitting
			// column), and re-anchored the pan to it. Writing nextLeft again here put the scroll back to before those
			// corrections until the settle's measure restored them: a sideways flicker of the page for one frame.
			// The preview paper comes down with the settle - unless a bounce is already playing, which happens when this
			// settle's own commit started one: then the element rides it, re-copied here at the settled zoom. A bounce begun
			// later, by the hold's measure or a convergence pass, puts its own element up (startOverscrollBounce), so
			// nothing here has to guess whether one is still coming.
			this.previewPaperHandoff = true;
			if (this.bounceState) this.rebasePreviewPaper();
			else this.endPreviewPaper("settle");
			if (diagnosticsEnabled()) { this.traceSettlePaper("settle after commit"); this.traceSettlePaperFrames(); }
		} else {
			const effective = external * next;
			// The preview's ceiling is the given one; the commit guard (commitCameraScale) keeps the bare cap.
			if (this.frame.locked || this.scaleGeometryValid === false || next > MAX_PINCH_SCALE * PINCH_GIVE ||
				!validCameraScale(next) || !validCameraScale(effective) || !this.prepareViewportLayout()) return;
			const layout = this.viewportLayout!;
			// The scroll target is no longer in this guard because a preview
			// frame no longer writes one: the anchoring is a translate, and its
			// own bound is in `anchorPanTo`. What is left is the counter-sized
			// box, which this frame does write.
			if (!validCameraScale(next, layout.width, layout.height) ||
				![layout.width / next, layout.height / next]
					.every(n => Number.isFinite(n) && n >= 0 && n <= MAX_VIEWPORT_LAYOUT)) return;
			// FIRST frame of this gesture: latch the column against the raster
			// now on screen, while the host still carries the old scale. After
			// applyViewportBox below, that state is gone.
			// The hold goes on BEFORE the capture below and before the box
			// write: a CodeMirror measure between them would move the scroll
			// under the column the capture reads (`holdMeasures`).
			this.holdMeasures();
			if (!this.pinchPreview || this.previewAnchorStale) {
				this.captureRasterColumn(this.pinchScaleNow);
				this.previewAnchorStale = false;
			}
			// A new gesture cancels any ease the previous lift never collected.
			this.previewSettleOwed = false;
			this.previewPaintedBlank = null;
			// The paper leaves the scroller for its preview element on the first frame, before this frame's box write.
			if (!this.pinchPreview) this.beginPreviewPaper();
			this.pinchPreview = true;
			this.pinchScrollAt = performance.now();
			this.pinchScaleNow = next;
			this.cssScale = effective;
			this.scale = effective * this.fontZoom;
			this.router?.cameraTransformChanged();
			// Keep the scroller's physical viewport fixed while magnifying its
			// contents. Reuse the raster; observers cannot allocate it mid-move.
			// The preview paper's own write is deferred to anchorPanTo below, which runs synchronously before
			// paint, in this same task - so this call's old-pan/new-scale write of it would never be seen.
			this.applyViewportBox(next, true);
			// THIS FRAME'S READS ONLY. Both are filled by the single
			// `columnLocalAt` below; clearing them first is what stops
			// `anchorPanTo` anchoring against a rect from an earlier frame on a
			// frame that could not measure (a detached view, a unit fixture).
			if (this.previewHostOrigin) this.previewHostOrigin.valid = false;
			this.previewColumnLocal = null;
			// ...and keep that reused raster on the column, which the box above
			// has just re-centred under Readable line length.
			this.applyPreviewInkOffset(next);
			// THE FOCAL ANCHOR, and it deliberately does not touch the scroll.
			// A preview frame that wrote the scroll could only ever anchor in
			// the directions the surface already extends into - measured on
			// 547fd8b4, that was none of them on zoom-out, because the target
			// was negative on every frame. The translate reaches every
			// direction and costs no layout of its own; the settle above turns
			// as much of it as the surface allows back into scroll.
			const contentTopLocal = this.contentTopLocalAt(next);
			// Deferred, same reason as applyViewportBox above: anchorPanTo below is this frame's one real write of
			// the preview paper, synchronous and before paint. Two more immediate writers ahead of it - this one
			// and applyViewportBox's - were what actually produced three records for one frame's reposition.
			this.measurePreviewPaperBox(true);
			// Reconcile only the latest accepted target against this fresh geometry.
			// Earlier inputs were reduced against their own snapshot, not replayed.
			this.refreshPinchConstraint(this.previewColumnLocal, contentTopLocal);
			this.reducePinchConstraint(next, false);
			this.anchorPanTo(next, anchor, this.previewColumnLocal, contentTopLocal);
			// anchorPanTo has early returns ahead of its own tail (the flush that normally clears this flag); on a
			// frame that takes one, the deferred re-stamp above would otherwise go unpainted - exactly the frame at
			// the previous scale's quotient the re-stamp exists to prevent. No-op when anchorPanTo already wrote.
			if (this.previewPaperBoxDirty) { this.writePaperPan(); this.previewPaperBoxDirty = false; }
			// This frame painted: record where it held the fingers, for the lift.
			const held = anchor.constraint;
			this.pinchPaintedX = held ? held.clientX : anchor.targetX ?? anchor.focalX;
			this.pinchPaintedY = held ? held.clientY : anchor.targetY ?? anchor.focalY;
			this.pinchPaintedOffsetX = held ? held.offsetX : 0;
			this.pinchPaintedOffsetY = held ? held.offsetY : 0;
			this.pinchPaintedValid = true;
		}
		this.refreshPenCursor();
		// Stamp AFTER the writes: the scroll events they queue are the ones
		// the handler above should let pass without a repaint.
		this.pinchScrollAt = performance.now();
	}

	/**
	 * The column's left edge in HOST-LOCAL px, or null when it cannot be read.
	 *
	 * VIEWPORT-RELATIVE IS THE WRONG FRAME, and that was a real defect: both
	 * `contentOriginLeft` and `getBoundingClientRect().left` are measured from
	 * the viewport, so a difference of two of them taken at different scales
	 * keeps a `hostLeft * (1 - k/k0)` term. With a sidebar open (host left ~300)
	 * a zoom to 10% put +270px of drift on EVERY pinch, Readable line length off
	 * included. Subtracting the host's own left first removes that term at the
	 * source; dividing by the scale in force puts the answer in the host's
	 * untransformed units, where it can be compared across scales at all.
	 */
	function columnLocalAt(this: InkOverlayPlugin, scale: number): number | null {
		const host = this.view?.dom;
		if (!host || !this.view?.contentDOM || !validCameraScale(scale)) return null;
		// THE HOST RECT FIRST, and kept. The host is the one element in this
		// chain the focal pan is NOT written to, so its painted origin is the
		// unpanned frame everything else is measured against - and reading it
		// before the column scan means a frame where the scan finds nothing
		// still leaves a usable origin for the vertical anchor. A second
		// `getBoundingClientRect` for that would double the per-frame forced
		// layout on the one path `deferPinchRaster` exists to keep cheap.
		const rect = host.getBoundingClientRect();
		const origin = this.previewHostOrigin;
		if (origin) { origin.left = rect.left; origin.top = rect.top; origin.valid = true; }
		const column = contentOriginLeft(this.view.contentDOM);
		if (column === null) return null;
		// UNPANNED. `.cm-content` sits inside `.cm-sizer`, which carries the
		// text half of the focal pan, so a raw read moves with the pan - and
		// the preview ink offset computed from it would then apply the pan a
		// second time on the layer that is already carrying it.
		const local = (column - this.panX() - rect.left) / scale;
		return Number.isFinite(local) ? local : null;
	}

	/**
	 * The content's top in HOST-LOCAL px, against the host origin the last
	 * `columnLocalAt` read. Measured only where the scroll moves under the
	 * anchor - gesture start and settle - never per preview frame, where the
	 * scroll is constant and the term cancels out of the difference entirely.
	 */
	function contentTopLocalAt(this: InkOverlayPlugin, scale: number): number | null {
		const content = this.view?.contentDOM, origin = this.previewHostOrigin;
		if (!content || !origin?.valid || !validCameraScale(scale)) return null;
		const local = (content.getBoundingClientRect().top - this.panY() - origin.top) / scale;
		return Number.isFinite(local) ? local : null;
	}
	/**
	 * The raster pan a bake moves to, in layout px: the resting pan, with the move from the raster pan now snapped to
	 * whole backing (device) px, so the bake can carry the painted pixels exactly (carryBakedPan). The part under one
	 * backing px stays in the ink layer's translate (writeInkLayerTransform), where the pen's mapping reads it too.
	 * With no usable backing the target is the resting pan itself.
	 */
	function rasterPanTarget(this: InkOverlayPlugin): { x: number; y: number } {
		const k = this.cssScale, from = this.rasterPan ?? { x: 0, y: 0 };
		const x = this.restPanX() / k, y = this.restPanY() / k;
		const backing = this.committedBacking ?? 0;
		if (!(backing > 0) || !Number.isFinite(backing)) return { x, y };
		// Below 100 percent only, and only when carryBakedPan will carry: there a whole-layer bake is the lag (every edge
		// bounce at 10 percent re-rastered all of the visible ink). Everywhere else the bake goes to the exact resting pan and
		// redraws, as before.
		if (!(k < 1) || !this.bakeCanCarry()) return { x, y };
		const sx = from.x + Math.round((x - from.x) * backing) / backing, sy = from.y + Math.round((y - from.y) * backing) / backing;
		// A move of whole backing px carries exactly: the exact pan is the target.
		if (Math.abs(sx - x) * backing < 1e-3 && Math.abs(sy - y) * backing < 1e-3) return { x, y };
		// Part of a pixel left in the translate shows the carried ink resampled, a little soft, until a whole redraw. Only a
		// page held past its top or left edge takes that: it goes back to the edge, where its snapped moves cancel to the
		// exact pan and the ink is sharp again. A page at rest bakes to the exact pan and redraws.
		return this.restPanX() > 0 || this.restPanY() > 0 ? { x: sx, y: sy } : { x, y };
	}
	/** carryBakedPan's guard, read before the bake: a raster of the zoom now held, painted while the store held this many strokes. */
	function bakeCanCarry(this: InkOverlayPlugin): boolean {
		const last = this.lastPaintCam, path = this.filePath();
		return !!last && last.zoom === this.camera.snapshot.zoom && this.paintedStrokeCount === (path ? inlineInk.strokes(path).length : 0);
	}
	/** A bake is owed when the snapped target differs from the raster pan, never for the remainder the target leaves. */
	function rasterPanNeedsBake(this: InkOverlayPlugin): boolean {
		if (this.frame.locked || this.builder !== null || this.pinchPreview || !Number.isFinite(this.cssScale) || !(this.cssScale > 0)) return false;
		const to = this.rasterPanTarget(), from = this.rasterPan ?? { x: 0, y: 0 };
		return to.x !== from.x || to.y !== from.y;
	}
	function restorePinchLayers(this: InkOverlayPlugin): void {
		if (this.wet) this.wet.beforeWrite = undefined;
		if (this.highlightWet) this.highlightWet.beforeWrite = undefined;
		if (this.tail) this.tail.beforeWrite = undefined;
		if (this.pinchComposite) {
			this.pinchComposite = false;
			// A renderer callback may have already begun the next stroke.
			// Remove only the borrowed pixels, preserving its new gesture state.
			const ctx = this.wetCanvas.getContext("2d");
			if (ctx) {
				ctx.save();ctx.setTransform(1,0,0,1,0,0);
				ctx.clearRect(0,0,this.wetCanvas.width,this.wetCanvas.height);ctx.restore();
				this.wet.noteBackingCleared();
			}
		}
		for (const [canvas,visibility] of this.pinchHiddenCanvases ?? []) canvas.style.visibility = visibility;
		this.pinchHiddenCanvases?.clear();
	}
	function markCommittedPaint(this: InkOverlayPlugin, tool: InkTool): void {
		// Any paint onto the committed layers: they no longer hold only the stand-in's last whole copy.
		if (this.standIn) this.standIn.mark = null;
		this.restorePinchLayers();
		if (tool === "highlighter") this.highlightBlank = false; else this.committedBlank = false;
	}
	/** A painted x read, moved back into the unpanned frame the camera uses. */
	function unpanX(this: InkOverlayPlugin, value: number | null): number | null {
		return value === null ? null : value - this.panX();
	}

	/**
	 * `view.documentTop` in the same unpanned frame as `columnLeft`.
	 *
	 * CodeMirror computes it as `contentDOM.getBoundingClientRect().top +
	 * paddingTop`, and `.cm-content` rides inside `.cm-sizer`, which carries the
	 * text half of the focal pan. The two callers below pair it with
	 * `columnLeft`, which is de-panned, to build ONE surface origin: a panned
	 * top against an unpanned left is not a frame at all, it is the pan sitting
	 * on one axis of a pair that is then differenced against scroll numbers the
	 * pan never touched. Both consumers - Fit's reachable-region clip and the
	 * extent grow - produce absolute scroll targets, and a scroll target is
	 * spent through `commitCameraScale`, which CLEARS the pan on its way: the
	 * frame those targets have to be right in is the one with no pan in it.
	 */
	function documentTopUnpanned(this: InkOverlayPlugin): number {
		// anchorTop, not `view.documentTop`: CodeMirror scales the padding it adds by the scale it last MEASURED, and it
		// only measures content with a size. An empty note's content box is 0 wide, so there the padding stayed at its
		// 100 percent value and every settle off 100 percent planned the paper's phase (and Fit's reachable edge)
		// padding x (1/k - 1) layout px off the text. anchorTop is what the ink camera already uses.
		return anchorTop(this.view, this.contentStyle?.paddingTop, this.cssScale) - this.panY();
	}

	/** Latch where the column was when the raster now on screen was drawn. */
	function captureRasterColumn(this: InkOverlayPlugin, scale: number): void {
		this.rasterColumnLocal = this.columnLocalAt(scale);
		this.rasterColumnScroll = this.view?.scrollDOM?.scrollLeft ?? 0;
	}

	/**
	 * Keep the REUSED preview raster sitting on the text column.
	 *
	 * A pinch preview deliberately does not re-rasterise: it scales the raster
	 * the note already has (see the scroll handler's suppression comment). That
	 * is correct only while the column's position is a pure scaling of where it
	 * was - true when the column starts at the host's origin, false when Readable
	 * line length auto-centres `.cm-sizer` inside it.
	 *
	 * `applyViewportBox` re-lays the host out at `layout.width / k`, so the
	 * centring margin is recomputed every preview frame and the column lands at
	 * `(W - lineWidth*k) / 2`, while the raster merely scales about the origin.
	 * The gap is `W * (k/k0 - 1) / 2`: zero at k = k0, negative zooming out,
	 * growing the further the gesture goes, healed at pinch end because
	 * `commitCameraScale` re-rasters against the settled column. Measured in the
	 * render harness before this existed: at W 1398, k0 1 -> k 0.1 the ink sat
	 * 629.125 px LEFT of the column - W * 0.45 to three decimals - and healed to
	 * exactly 0 at settle. Alan, Orion, Readable line length ON: "the ink moves
	 * when zooming out".
	 *
	 * BOTH TERMS ARE HOST-LOCAL AND CAPTURED ATOMICALLY. The first cut compared
	 * `lastSyncContentLeft` against `pinchRasterScale`, two fields written by
	 * different methods at different moments: hold a pinch still past
	 * `PINCH_SCROLL_QUIET_MS` and `deferPinchRaster` goes false, any of six
	 * `syncCamera` callers rewrites the column at the CURRENT scale while the
	 * stored scale still describes the raster, and the offset is then wrong by
	 * the whole ratio. `rasterColumnLocal` is latched in one statement from one
	 * DOM state, at the moment the raster it describes was drawn, and re-latched
	 * whenever a repaint actually redraws that raster.
	 *
	 * READABLE LINE LENGTH OFF IS UNTOUCHED, by construction rather than by a
	 * flag: the column is then a fixed offset inside the host (zero, or the
	 * scrollbar gutter), so the local value is scale-invariant, the difference is
	 * exactly 0 and no transform is written. The same holds for any constant
	 * local inset.
	 *
	 * COLUMN NOT FOUND leaves the offset alone: a frame where the scan cannot see
	 * the column has no better answer than the one already on screen.
	 *
	 * WHAT A PREVIEW FRAME COSTS, counted rather than estimated. ONE forced
	 * synchronous layout: this reads after `applyViewportBox` has written, and it
	 * must, because the column it needs is the post-box one. Rect reads are 12 in
	 * the ordinary case, 24 bounded, 36 if phase B runs (ContentOrigin.ts:59, :72,
	 * :244-247). A latch frame does 2 reads and still only 1 forced layout. The
	 * host rect is NOT cached across the gesture: a pan moves the host.
	 *
	 * The deferred-repaint latch beside this costs at most ONE timer per
	 * PINCH_SCROLL_QUIET_MS while a repaint is being held - about 8 wake-ups a
	 * second, and zero when nothing is pending - against the 60/s a re-armed
	 * requestAnimationFrame would have cost for the whole gesture.
	 *
	 * This spends on exactly the path `deferPinchRaster` exists to keep cheap, so
	 * it is worth saying plainly that it is a layout read per gesture frame and
	 * nothing outside a preview. Computing the column from the layout box instead
	 * of measuring it would remove the read entirely; that is a post-1.4.19
	 * option and should be gated on a profile, not on this comment.
	 */
	function applyPreviewInkOffset(this: InkOverlayPlugin, next: number): void {
		const band = this.inkLayer;
		// `pinch` is driven in unit fixtures against partial objects that carry
		// the overlay's fields without a real DOM - the pinch-end unit fixtures build
		// a container with no `style` and a view with no `contentDOM`. Nothing
		// here is worth a throw: with nothing to measure or move, leaving the
		// raster where it is IS the right answer.
		if (!band || !band.style) return;
		// ONE read per preview frame, and it happens before the early returns
		// below because the focal anchor needs its by-product (the host origin)
		// on exactly the frames this runs on.
		const localNow = this.columnLocalAt(next);
		this.previewColumnLocal = localNow;
		const anchor = this.rasterColumnLocal;
		if (anchor === null || localNow === null) return;
		// THE COLUMN'S MOVE IN CONTENT COORDINATES, not in host-local ones.
		// `columnLocalAt` reads host-local px, which fall as the scroller
		// scrolls right; the layer this offset is written to sits inside the
		// scroller and has already moved by exactly that scroll. Measured on
		// the pixel arm (2026-09-13): with Readable line length on, a
		// zoom-out preview that moved scrollLeft 93 -> 52 -> 0 wrote +41 and
		// +52 layer px here and the committed ink sat that far right of its
		// text until the next repaint. Adding the scroll change since the latch
		// leaves only the centring margin's own move, which is what the raster
		// needs to follow; the zoom-in compensation above 1.0 keeps its value
		// because there the column really moves.
		//
		// UNITS. `columnLocalAt` divides the client difference by the OWNED
		// scale only, so its px still carry the host's external scale, while
		// the layer this offset is written to counts layout px (the same way
		// `viewportLayout.columnLocal` divides by the external scale before it
		// adds `scrollLeft`). So the column term is divided by that scale and
		// the scroll delta, already layout px, is added as it is. Measured at
		// external scale 0.8 (2026-09-13): with the factor on the scroll term
		// instead, a genuine column move on zoom-in to 1.6 was applied at 0.8
		// of its size and the ink sat 34 device px off its text; scroll-only
		// frames cancel in either form, which is why the zoom-out cells could
		// not tell the two apart. At external scale 1 the two are identical.
		const scrollNow = this.view?.scrollDOM?.scrollLeft ?? this.rasterColumnScroll;
		const external = this.viewportLayout?.externalScale ?? (Number.isFinite(this.cssScale) && this.pinchScaleNow > 0 ? this.cssScale / this.pinchScaleNow : 1);
		const e = Number.isFinite(external) && external > 0 ? external : 1;
		const dx = (localNow - anchor) / e + (scrollNow - this.rasterColumnScroll);
		if (!Number.isFinite(dx)) return;
		this.previewInkOffset = dx;
		// Host-local units already: the band lives inside the scaled host, so no
		// second division by `k` belongs here.
		this.writeInkLayerTransform();
	}

	/**
	 * THE ONE WRITER for the ink layer's transform, and it must stay the only
	 * one.
	 *
	 * Two different corrections land on this element and neither may clobber the
	 * other: the column offset that keeps a REUSED preview raster on a column
	 * the centring margin has moved, and the focal pan that holds the note under
	 * the fingers. Two methods each assigning `style.transform` is not two
	 * corrections, it is whichever ran last - which is how the first attempt at
	 * this lane lost the column offset on every frame the pan moved. Summing
	 * them in one place is the whole fix.
	 *
	 * UNITS. The offset is already in the layer's own px (`columnLocalAt`
	 * divided the scale out, and the layer rides inside the scaled host). The
	 * pan is in PAINTED px, because that is the frame a finger is in, so it is
	 * divided by the painted scale on the way in.
	 */
	function writeInkLayerTransform(this: InkOverlayPlugin): void {
		const layer = this.inkLayer;
		if (!layer?.style) return;
		const k = this.cssScale;
		const s = Number.isFinite(k) && k > 0 ? 1 / k : 0;
		const x = this.previewInkOffset + this.panX() * s - (this.rasterPan?.x ?? 0);
		const y = (this.previewInkOffsetY || 0) + this.panY() * s - (this.rasterPan?.y ?? 0);
		layer.style.transform = x === 0 && y === 0 ? "" : `translate(${x}px,${y}px)`;
		this.releaseWetIfIdle();
	}

	/**
	 * The content box changed size: every Enter, wrap and line-height fix lands here.
	 *
	 * A full repaint clears and redraws all visible ink and rebuilds the index, so it is kept for a resize that
	 * actually moved the camera, the column or the origin; a still camera takes the cheap frame (bands and the
	 * extent pass only). The grid's vertical box is sized from the content, and nothing else on this path re-sizes
	 * it when no extent spacer moves (Infinite Canvas off, no ink): the rules stopped partway down a grown note, or
	 * left blank scroll room under a shortened one. The box keeps its size unless it changed, so this is a read.
	 */
	function onContentResize(this: InkOverlayPlugin, width?: number): void {
		// The content's width moved (a pane resize, a readable-length change): the line anchors' signature is read here, where
		// layout is done, and taken at once; no measure is asked for. Its height moves on every re-measure and reads nothing here.
		if (width !== undefined && width !== this.contentWidthSeen) {
			this.contentWidthSeen = width;
			this.lineSignatureMeasured(this.readLineSignature(this.view));
		}
		if (!this.container || this.frame.locked) return;
		const left = this.lastSyncContentLeft, top = this.lastSyncDocumentTop, scale = this.scale;
		this.syncCamera();
		const moved =
			Math.abs(this.lastSyncContentLeft - left) > CONTENT_ORIGIN_EPSILON ||
			Math.abs(this.lastSyncDocumentTop - top) > CONTENT_ORIGIN_EPSILON ||
			this.scale !== scale;
		if (this.paperGridBox) this.syncGridPaperBox();
		this.scheduleRepaint(moved ? "content-resize" : "scroll");
	}

	/**
	 * TAKE THE PREVIEW PAPER DOWN: the one place it comes down, whichever path ends its life. The scroller's paper comes
	 * back in the same task, its pan properties rewritten from the pan in force, so no frame shows neither or both.
	 */
	function endPreviewPaper(this: InkOverlayPlugin, reason: PreviewPaperEnd): void {
		const el = this.previewPaperEl;
		if (!el) return;
		this.previewPaperEl = null;
		this.previewPaperBox = null;
		this.previewPaperInset = "";
		this.previewPaperTransform = "";
		this.paperScrollLeft = Number.NaN;
		this.paperScrollTop = Number.NaN;
		this.previewPaperEnded = reason;
		el.remove();
		this.view?.scrollDOM?.classList.remove("handwriting-paper-previewing");
		this.paperPanWritten = null;
		this.writePaperPan();
	}

	/** `.cm-sizer`, found once and re-found only if it leaves the document. */
	function panSizer(this: InkOverlayPlugin): HTMLElement | null {
		const cached = this.panSizerEl;
		if (cached && cached.isConnected) return cached;
		const found = this.view?.dom?.querySelector?.<HTMLElement>(".cm-sizer");
		this.panSizerEl = found && found.style ? found : null;
		return this.panSizerEl;
	}

	/** Drop the preview offset; the committed raster is drawn on the column. */
	function clearPreviewInkOffset(this: InkOverlayPlugin): void {
		if (this.previewInkOffset === 0 && !this.previewInkOffsetY) return;
		this.previewInkOffset = 0;
		this.previewInkOffsetY = 0;
		this.writeInkLayerTransform();
	}

	/**
	 * THE PAGE'S CONTENT BOX on x, note px: the text column, or the ink, whichever reaches further
	 * Every SETTLE-TIME width test reads this and nothing else. No preview-time test reads
	 * any width at all - while the fingers are down the note is held, and bounds belong at the settle.
	 *
	 * NOT the granted extent. `surfaceExtents` is grown from the ink claim OR the zoom and scroll
	 * grants, whichever is largest, then quantised up to a 256 px block: measured, an ink frontier of
	 * 10116 is stored as 10496. A fit test reading that asks "is there room beside the page", which is
	 * a different question - at k = 0.134 it called a 1355.54 px page non-fitting in a 1383 px span and
	 * left it 309.06 px off its own rest.
	 *
	 * ONE FUNCTION, SIX CALLERS, deliberately. The first cut of this fix wrote the page's box at two
	 * sites by hand and left four more reading the conflated field; two had to be found by
	 * instrumenting, and one of those - the site that SPENDS the rest - disagreed with the site that
	 * COMPUTES it about whether a rest existed at all.
	 */
	function pageContentWidth(this: InkOverlayPlugin): number {
		return Math.max(this.viewportLayout?.columnBox ?? 0, this.pageInkX * this.fontZoom);
	}

export function installPinch(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		pinch,
		flushPinch,
		applyPinchScale,
		columnLocalAt,
		contentTopLocalAt,
		rasterPanTarget,
		bakeCanCarry,
		rasterPanNeedsBake,
		restorePinchLayers,
		markCommittedPaint,
		unpanX,
		documentTopUnpanned,
		captureRasterColumn,
		applyPreviewInkOffset,
		writeInkLayerTransform,
		onContentResize,
		endPreviewPaper,
		panSizer,
		clearPreviewInkOffset,
		pageContentWidth,
	});
}
