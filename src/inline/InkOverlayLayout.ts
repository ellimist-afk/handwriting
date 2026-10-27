/**
 * The note surface's resize and column layout: the resolution watch for a
 * zoom change no resize reports, the pane resize and its replay after a
 * stroke, the text column's left edge and the origin line watch, the owned
 * column layout, the canonical camera y with its anchor parity gate, and the
 * float32 exactness test for the zoom host. They are methods of
 * InkOverlayPlugin, installed on its prototype when InkOverlay.ts loads.
 */
import { Platform } from "obsidian";
import { contentOriginLeft } from "./ContentOrigin";
import { anchorTop } from "./DocumentTop";
import { anchorParityBar, refuseDocumentAnchor } from "./DocumentAnchor";
import { stableCameraOriginY } from "./CameraOriginY";
import { computeCanvasSize } from "../diag/Raster";
import { MAX_VIEWPORT_LAYOUT } from "./PinchScale";
import { backingScale, canvasLayerBox, fontZoomFactor, ownedEffectiveScale, rasterScale } from "./ZoomScale";
import { scrollProbeExtent } from "./ScrollProbe";
import { installMethods } from "./InstallMethods";
import { CONTENT_ORIGIN_EPSILON, SCALE_EPSILON, bumpCanvasReallocs, inlineInk, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		watchResolution(): void;
		unwatchResolution(): void;
		replayDeferredResize(): void;
		handleResize(): void;
		resolveColumnLeft(left: number | null): number;
		columnLeft(): number;
		originLineResized(): void;
		watchOriginLine(line: Element | null, left: number): void;
		originStyle(el: Element): CSSStyleDeclaration;
		ownedColumnLayoutLeft(line: Element | null): number | null;
		canonicalCameraY(raw: number, adopt: boolean): number;
		gateAnchorParity(reason: string, implied: number, rungTopLayout: number): void;
		anchorTopExactOnZoomHost(overlayTop: number): boolean;
		zoomRectExactLimit(): number;
		/** A reallocation inside a camera commit left the whole repaint to the commit (see handleResize); the commit pays it once. */
		commitRepaintOwed?: boolean;
	}
}

	/**
	 * Obsidian's Ctrl+/Ctrl- is Electron page zoom, which changes
	 * devicePixelRatio without necessarily changing anything's CSS-px size,
	 * so neither the ResizeObserver nor a CodeMirror geometry update is
	 * guaranteed to fire. This listener is: a resolution media query flips
	 * exactly when the zoom factor does. Re-arms itself for the new dpr.
	 */
	function watchResolution(this: InkOverlayPlugin): void {
		this.unwatchResolution();
		const dpr = this.winRef.devicePixelRatio || 1;
		const mq = this.winRef.matchMedia(`(resolution: ${dpr}dppx)`);
		const fn = () => {
			this.handleResize();
			this.watchResolution();
		};
		this.mediaQuery = mq;
		this.mediaFn = fn;
		mq.addEventListener("change", fn);
	}

	function unwatchResolution(this: InkOverlayPlugin): void {
		if (this.mediaQuery && this.mediaFn) {
			this.mediaQuery.removeEventListener("change", this.mediaFn);
		}
		this.mediaQuery = null;
		this.mediaFn = null;
	}

	/** The pen is up: run the pane resize a stroke held back (see handleResize). */
	function replayDeferredResize(this: InkOverlayPlugin): void {
		if (!this.resizeDeferred) return;
		this.resizeDeferred = false;
		if (this.container && !this.frame.locked) this.handleResize();
	}

	function handleResize(this: InkOverlayPlugin): void {
  if(this.deferPinchRaster())return;
		this.restorePinchLayers();
  this.mobileTools?.refresh();
  this.noteZoomControls?.refresh();
  // A mechanical band resize must retain forward demand admitted by scroll.
  this.scrollExpansion?.rebase(this.view.scrollDOM.scrollLeft,this.view.scrollDOM.scrollTop,true);
  const layout=this.viewportLayout;
  if(layout&&layout.parent.clientWidth>0&&layout.parent.clientHeight>0&&this.viewportStyleDirty)this.scheduleViewportStyleRefresh();
  // A stroke owns the frame, so the zoomed layout cannot follow the pane now.
  // Remember it: the lift replays this resize, or the pane kept a blank strip
  // or a clipped edge until something else resized it.
  this.resizeDeferred=!!layout&&this.frame.locked&&layout.parent.clientWidth>0&&layout.parent.clientHeight>0&&
   (layout.parent.clientWidth!==layout.paneWidth||layout.parent.clientHeight!==layout.paneHeight);
  if(layout && !this.frame.locked && layout.parent.clientWidth>0 && layout.parent.clientHeight>0 &&
   (layout.parent.clientWidth!==layout.paneWidth||layout.parent.clientHeight!==layout.paneHeight)) {
   const width=layout.width+layout.parent.clientWidth-layout.paneWidth;
   const height=layout.height+layout.parent.clientHeight-layout.paneHeight;
   if(width>0&&height>0&&width/this.pinchScaleNow<=MAX_VIEWPORT_LAYOUT&&height/this.pinchScaleNow<=MAX_VIEWPORT_LAYOUT) {
    // Measure the natural column with ownership removed below. A fixed-left
    // column does not follow half the width delta; a theme can change its cap.
    // Preserve native scroll across this temporary unscaled-width layout.
    const savedLeft=this.view.scrollDOM.scrollLeft,savedTop=this.view.scrollDOM.scrollTop;
        layout.width=width;layout.height=height;layout.paneWidth=layout.parent.clientWidth;layout.paneHeight=layout.parent.clientHeight;
    const natural=this.measureNaturalColumn({width,height});
    if(natural.column>0){layout.column=natural.column;layout.columnBox=natural.columnBox;layout.lineContent=natural.lineContent;layout.gutterX=natural.gutterX;layout.sizerColumn=natural.sizerColumn;layout.columnInset=natural.columnInset;layout.ownLines=natural.ownLines;layout.left=natural.left;layout.right=natural.right;}
    layout.columnLocal=natural.columnLocal;layout.columnReserve=natural.columnReserve;
    layout.columnAuto=natural.columnAuto;
    // Hidden editors release their backings and invalidate geometry. Restore
    // the full physical viewport before navigation can reject that stale state,
    // then let the common resize path measure and rebuild the visible surface.
    this.applyViewportBox(this.pinchScaleNow);
    this.view.scrollDOM.scrollLeft=savedLeft;this.view.scrollDOM.scrollTop=savedTop;
    if(this.scaleGeometryValid!==false&&this.commitCameraScale(this.pinchScaleNow, undefined, undefined, true))return;
   }
  }
		// UNDER THE HOLD (D-COV, AD-4 i): a resize that did not commit above
		// reallocates nothing and moves no band; the raster keeps the basis the
		// preview translate was solved against until the settle re-rasters.
		if (this.pinchPreview) return;
		this.clearSnapPreview();
		if (!this.container) return;
		if (this.canvasMode) this.lastExtentInputs = null;
		// The container no longer inherits the editor's box, so its size is
		// whatever syncBand last wrote. Resize it FIRST or every measurement
		// below - including the zero-size check that releases the backings in
		// a background tab - reads the previous viewport's band.
		this.syncBand();
		const prevScale = this.scale;
		const rect = this.container.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) {
			if (!this.frame.locked) {
				this.scaleGeometryValid = false;
				this.router?.cameraTransformChanged();
			}
			// A background tab keeps its editor - and this overlay - alive
			// at zero size. Five full-size backings on an invisible surface
			// are ~70MB at high dpr (seen live: a 0x0 editor holding a
			// 2239x1620 backing), and it climbs with every background tab
			// over a session. Release them; the ResizeObserver refires when
			// the tab fronts, and the non-zero path reallocates and
			// repaints synchronously, so nothing is ever shown blank.
			if (!this.frame.locked && this.committedCanvas.width > 0) this.releaseBackings();
			return;
		}
		const paintedDpr = this.dpr;
		this.dpr = this.winRef.devicePixelRatio || 1;
		// The canvases live INSIDE whatever is scaled, so their coordinate
		// space is layout px, the same unit ink is stored in. Size them from
		// the untransformed box and give the backing store the extra device
		// pixels the scale demands, so ink stays crisp instead of being
		// upscaled by the compositor.
		const measuredCssScale = ownedEffectiveScale({
			visualWidth: rect.width,
			layoutWidth: this.container.offsetWidth,
			cmScaleX: this.view.scaleX,
		}, this.pinchScaleNow);
		if (measuredCssScale === null) {
			if (!this.frame.locked) {
				this.scaleGeometryValid = false;
				this.router?.cameraTransformChanged();
			}
			return;
		}
		// Quick-font-size zoom (Ctrl+scroll / touchpad pinch) is a reflow:
		// dpr and the transform scale both stay put while the text grows.
		// The current/mount-time font ratio is the missing zoom factor.
		this.contentStyle ??= this.winRef.getComputedStyle(this.view.contentDOM);
		this.lastFontStr = this.contentStyle.fontSize;
		const fontPx = Number.parseFloat(this.lastFontStr);
		if (this.refFontPx <= 0 && Number.isFinite(fontPx) && fontPx > 0) {
			this.refFontPx = fontPx;
			// The open note keeps this as its reference, once (audit 46). Only
			// with an editor state to name the note: a bare rig has none.
			const path = this.view.state ? this.filePath() : null;
			if (path !== null) inlineInk.setFontRefPx(path, fontPx);
		}
		const measuredFontZoom = fontZoomFactor(fontPx, this.refFontPx);
		// A STROKE IN FLIGHT OWNS ITS COORDINATE FRAME, and `cssScale` is
		// half of that frame: the router divides every sample by it
		// (`scaleProvider`, InlinePenRouter.sampleFrom) and the camera that
		// inverts the result is frozen at pen-down. Writing it here moved the
		// divisor under a stroke that could not follow, so every sample after
		// the resize landed at a different note point than the same finger
		// position did before it - the rest of the letter jumping toward the
		// top-left, mid-stroke. That is the same shear `scrollFn` refuses by
		// not refreshing the router's rect mid-stroke and `syncBand` refuses
		// by returning early, and this method was the one geometry path left
		// that did it anyway. `UnsettledDocumentTop.test.ts` pins it: a 1.5x
		// resize under a planted pen moved one client point 66.7 note px.
		//
		// Nothing is deferred for long. `syncCamera` re-measures the scale
		// from its own rect read on every sync rather than trusting anything
		// cached here (see its comment below), so the first unlocked sync
		// after pen-up adopts both numbers - which pen-up reaches through the
		// commit's own repaint. The BACKING below is computed from the
		// measured values regardless, so canvas resolution is unaffected and
		// the reallocation path behaves exactly as it did.
		if (!this.frame.locked) {
			this.scaleGeometryValid = true;
			if (Math.abs(measuredCssScale - this.cssScale) > this.cssScale * SCALE_EPSILON)
				this.router?.cameraTransformChanged();
			this.cssScale = measuredCssScale;
   if(this.viewportLayout && Math.abs(measuredCssScale/this.pinchScaleNow-this.viewportLayout.externalScale)>SCALE_EPSILON) this.viewportLayout.externalScale=measuredCssScale/this.pinchScaleNow;
			// A font change: the line anchors' signature is read again.
			if (measuredFontZoom !== this.fontZoom) this.requestLineSignature();
			this.fontZoom = measuredFontZoom;
			this.scale = this.cssScale * this.fontZoom;
			// The paper follows the text's size as just read, and the thickness the
			// scale just measured.
			this.paperFontPx = fontPx;
			this.paperRestZoom = Number.NaN;
			this.updatePaperSpacing();
		}
		// A canvas-off reset refused while the tab had no box runs now the geometry is back. Its commit has already
		// sized the canvases through its own handleResize, from the scale it set; going on here would size them
		// again from the scale measured above, before the reset.
		if (this.retryCanvasOffReset()) return;
		const layoutW = this.container.offsetWidth || rect.width;
		const layoutH = this.container.offsetHeight || rect.height;
		// Backing resolution: device px per SCREEN css px. The font zoom is
		// GEOMETRY (applied by the camera before rasterization), not
		// resolution. Folding it in here was the part-2 bug's sibling.
		// The backing, the canvas boxes and both live-canvas grids take the
		// owned scale when the measured one differs from it only by the
		// rounding of offsetWidth (`rasterScale`): off in its sixth decimal,
		// the measured scale has no pixel grid and the wet tile and compact
		// tail were off at 100%.
		const raster = rasterScale(measuredCssScale, this.pinchScaleNow, SCALE_EPSILON);
		const backing = backingScale(
			this.dpr,
			raster,
			layoutW,
			layoutH,
			Platform.isMobileApp
		);
		const size = computeCanvasSize(layoutW, layoutH, backing);
		// Same backing, same box: reallocating would blank four full canvases
		// for nothing (setting width clears a canvas even to the same
		// value). The ios keyboard animation streams resize ticks, and
		// every needless blank was a visible flicker frame.
		// Scale is part of "unchanged": a pinch or ctrl-scroll zoom reflows
		// the text and moves this.scale WITHOUT touching the canvas size,
		// and skipping its repaint left ink painted at the old zoom (the
		// 1.0.9 regression this guard shipped with).
		const unchanged =
			this.scale === prevScale &&
			this.committedCanvas.width === size.backingW &&
			this.committedCanvas.height === size.backingH &&
			this.cssWidth === size.cssW &&
			this.cssHeight === size.cssH;
		this.cssWidth = size.cssW;
		this.cssHeight = size.cssH;
		if (unchanged) {
			// Not while a stroke owns the frame, for the reason below and for
			// `scrollFn`'s: the rect the router maps through and the camera
			// that inverts the result froze together at pen-down, and
			// refreshing one without the other IS the mismatch the frozen
			// pipeline exists to prevent. The next pen-down refreshes it
			// (:2776), which is the same guarantee the scroll handler relies
			// on.
			if (!this.frame.locked) this.router?.refreshRect();
			// `ResizeObserver` fires on SIZE changes only. Readable line length
			// caps `.cm-content` at `--file-line-width` and centres it in the
			// scroller, so opening or closing a sidebar at constant pane width
			// re-centres the column without moving anything `unchanged` just
			// compared - band, canvas dims and cssWidth/cssHeight all stay put,
			// and neither ResizeObserver's callback fires either (nothing sized).
			// This is the only path left that runs on every geometry-relevant
			// tick, so it is where a shifted COLUMN actually gets noticed.
			// The other half of the origin, the document top, is NOT checked
			// here and could not usefully be: it moves with nothing resizing
			// at all, so this callback is not reached in its failing case.
			// `syncCamera` notices that one, against the camera the pixels
			// were painted with.
			// Same frame guard as contentResizeObserver's callback: a stroke in
			// flight owns its coordinate frame and must not have the camera
			// moved under it.
			if (!this.frame.locked) {
				const contentLeft = this.columnLeft();
				if (Math.abs(contentLeft - this.lastSyncContentLeft) > CONTENT_ORIGIN_EPSILON) {
					this.syncCamera();
					this.scheduleRepaint("content-resize");
				}
			}
			return;
		}
		this.takeStandIn(paintedDpr, backing);
		for (const c of [
			this.committedCanvas,
			this.wetCanvas,
			this.highlightCanvas,
			this.highlightWetCanvas,
		]) {
			// Counted, because "the canvases are being reallocated every frame"
			// is a claim that should be a number rather than an argument. Each
			// assignment here throws away and re-allocates a backing store the
			// size of the viewport times the backing scale, four times over.
			// A deferred highlight pair, and a released wet canvas, keep their 0x0 backing and take only the box.
			const deferred = (this.highlightPairDeferred && (c === this.highlightCanvas || c === this.highlightWetCanvas)) ||
				(this.wetDeferred && c === this.wetCanvas);
			if (!deferred) {
				bumpCanvasReallocs();
				c.width = size.backingW;
				c.height = size.backingH;
			}
			// A reallocated backing is blank, even at the same size.
			if (this.standIn) this.standIn.mark = null;
			// The compositor's layer follows this box, not the backing: keep it
			// at the visual size and stretch it over the band (canvasLayerBox).
			// Under a zoom-shrunk host the inherited zoom already does that, so
			// the same call returns the plain band box and no transform.
			const box = canvasLayerBox(size.cssW, size.cssH, raster, this.zoomFormAt(this.pinchScaleNow));
			c.setCssStyles({ width: `${box.width}px`, height: `${box.height}px`, transform: box.transform, transformOrigin: box.transform ? "0 0" : "" });
		}
		// The backing just allocated against the device pixels the container
		// really occupies. `rect` is the read this method already made and
		// nothing since has moved the container, so this costs no second forced
		// layout. They disagree when the box and the backing were computed from
		// different geometry, which resamples the ink: a host whose zoom came
		// from injected CSS rather than the overlay's own write. Recorded for
		// the suites, never logged.
		const rectBackingW = Math.round(rect.width * this.dpr);
		this.backingBoxMismatch = Math.abs(size.backingW - rectBackingW) > 1
			? { backingW: size.backingW, rectBackingW }
			: null;
		this.committedCtx.setTransform(backing, 0, 0, backing, 0, 0);
		this.committedBacking = backing;
		// A deferred pair is 0x0: no context call (allocateHighlightPair sets this transform when it sizes the pair).
		if (!this.highlightPairDeferred) this.highlightCtx.setTransform(backing, 0, 0, backing, 0, 0);
		this.wet.applyDpr(backing);
		this.highlightWet.applyDpr(backing);
		this.tail.applyDpr(backing);
		this.wet.noteBackingCleared?.();
		this.wet.dropWetTile?.();
		this.highlightWet.noteBackingCleared?.();
		this.tail.noteBackingCleared?.();
		this.tail.configureInlineBacking(size.cssW, size.cssH, backing, raster, this.zoomFormAt(this.pinchScaleNow));
		this.wet.tileTranslate = this.translateSupported();
		this.wet.configureWetTile?.(this.wetTileCanvas, size.cssW, size.cssH, backing, raster, this.zoomFormAt(this.pinchScaleNow));
		this.committedBlank = this.highlightBlank = true;
		// Same guard as the unchanged arm's: re-basing the router's rect
		// mid-stroke shifts every sample after it while the camera stays
		// frozen. The backings above are reallocated either way - that blanks
		// pixels, which the repaint below restores, and moves nothing.
		if (!this.frame.locked) this.router?.refreshRect();
		this.axisChecked = false;
		// Reallocation blanked the canvases: the ledger and the camera latch
		// must both know, or the sync repaint below would paint nothing.
		this.damage.addAll();
		this.indexDirty = true;
		this.lastPaintCam = null;
		// Reallocation just blanked the backing. Painting NOW, in the same
		// task, means no frame is ever presented empty; the scheduled path
		// waits for the next animation frame and shows one blank frame per
		// resize event - a sustained flicker under the ios keyboard's
		// animation. Mid-gesture keeps the scheduled path: the frozen
		// frame owns the coordinate space until pen-up.
		// Inside a camera commit the commit reallocates more than once in the same task (its resize, then again once the band has
		// moved to the settled scroll), and each paint here drew every stroke by path: two whole repaints in the lift's task on a
		// pinch, 0.9 s on a 28,358-stroke note. The commit owes one paint instead and pays it after its last reallocation, still in this task,
		// so no frame is presented blank.
		if ((this.commitDepth || 0) > 0) {
			this.commitRepaintOwed = true;
		} else if (this.builder === null && this.mode === "ink") {
			this.repaint();
		} else {
			this.scheduleRepaint("resize");
		}
	}

	/**
	 * Turn the scan's answer into the number the camera can actually use.
	 *
	 * ONE rule for six call sites. `contentOrigin` reports COLUMN NOT FOUND
	 * (`left: null`) when nothing in the rendered viewport has a width - a
	 * viewport of collapsed markers, a detached editor, a fixture. Before
	 * 1.4.10 it answered `.cm-content`'s own left there, which under a theme
	 * that caps `.cm-content` is the same number and under Minimal is the PANE
	 * edge: a 380px jump at a 1400px pane, applied to a camera that was
	 * correct a frame earlier. Keeping the last origin the scan DID find is
	 * strictly better, because the column has not moved just because this
	 * frame could not see it. The `.cm-content` fallback survives only for the
	 * very first sync, where there is no last good value and a wrong guess is
	 * still better than NaN.
	 */
	function resolveColumnLeft(this: InkOverlayPlugin, left: number | null): number {
		if (left !== null) {
			this.lastGoodColumnLeft = left;
			return left;
		}
		return (
			this.lastGoodColumnLeft ?? this.view.contentDOM.getBoundingClientRect().left
		);
	}

	/**
	 * `resolveColumnLeft` over a fresh scan, for the sites that only paint.
	 *
	 * UNPANNED, and every caller wants it that way: the camera this feeds paints
	 * into the ink layer. Its raster camera and transform together carry the
	 * focal pan. De-panned BEFORE `resolveColumnLeft` so the
	 * cached last-good value is in the same frame as the live ones - a cache
	 * holding a panned number would come back out against a different pan.
	 */
	function columnLeft(this: InkOverlayPlugin): number {
		return this.resolveColumnLeft(this.unpanX(contentOriginLeft(this.view.contentDOM)));
	}

	/**
	 * The origin line changed size. Re-sync the camera, and repaint ONLY if
	 * the column actually moved.
	 *
	 * The guard is the one `handleResize`'s `unchanged` arm already uses, and
	 * it is here for the same reason it is there, only more urgently.
	 *
	 * This observer is re-pointed from `syncCamera`, and
	 * `ResizeObserver.observe` delivers one callback for a NEWLY observed
	 * element on the next frame whatever its size - the spec starts its
	 * `lastReportedSize` at 0x0, so the first delivery is unconditional. Every
	 * frame that re-points the watch therefore also arms a callback. Under a
	 * theme where the sampled lines share a left edge the scan's tie rule
	 * (strict `>`) keeps the FIRST sampled line, and CodeMirror replaces the
	 * leading `.cm-line` div on every viewport re-render, so a scroll re-points
	 * the watch several times a second.
	 *
	 * Repainting unconditionally from here cost `damage.addAll()` plus
	 * `indexDirty = true` on each of those - a full re-rasterization of every
	 * visible stroke and an index rebuild - per viewport re-render during a
	 * scroll, and again on a cursor move that changes the first line's height
	 * (a heading, or a wrapping paragraph revealing its markup). Before this
	 * observer existed a scroll cost one "scroll" repaint. It costs one again.
	 *
	 * A callback where the column really did move still repaints, which is the
	 * entire reason the observer exists: `MinimalResync.test.ts` measures three
	 * routes by which Minimal moves the column while nothing else fires.
	 */
	function originLineResized(this: InkOverlayPlugin): void {
		if (!this.container || this.frame.locked) return;
		const before = this.lastSyncContentLeft;
		this.syncCamera();
		if (Math.abs(this.lastSyncContentLeft - before) > CONTENT_ORIGIN_EPSILON) {
			this.scheduleRepaint("content-resize");
		}
	}

	/**
	 * Point `originLineObserver` at the line the origin scan just picked.
	 *
	 * Called from `syncCamera` on every sync, which is the cheapest place it
	 * can live: the scan has already run, so this is a reference comparison
	 * and, on the rare frame where CodeMirror recycled the line out from
	 * under us, one `unobserve` plus one `observe`. Nothing here reads
	 * layout, nothing scales with the length of the note, and it is never
	 * reached from a pointermove or a keystroke path that does not already
	 * sync the camera.
	 *
	 * `left` is the column edge THIS sync measured. It is passed rather than
	 * re-read because the scan already has it, and because the comparison
	 * below has to happen before `syncCamera` overwrites
	 * `lastSyncContentLeft` with it.
	 */
	function watchOriginLine(this: InkOverlayPlugin, line: Element | null, left: number): void {
		if (line === this.originLine) return;
		const observer = this.originLineObserver;
		// Not mounted, or already torn down: leave `originLine` alone so a
		// late sync cannot leave a stale element recorded as watched.
		if (!observer) return;
		// COLUMN NOT FOUND this frame. The watch is the only thing that will
		// tell us the column moved, so dropping it here would disarm the
		// re-sync for exactly as long as the viewport stays unmeasurable -
		// and the element we were watching is usually still the column, just
		// scrolled out of a viewport full of collapsed markers. Keep it while
		// it is still in the document; a recycled or removed line is dropped.
		if (line === null && this.originLine?.isConnected) return;
		// A DIFFERENT element at the SAME left edge. That is the ordinary
		// scrolling case rather than a moved column: CodeMirror replaces the
		// leading `.cm-line` div on every viewport re-render, and where the
		// sampled lines share a left edge the scan's tie rule (strict `>`)
		// keeps whichever one it saw first - so the scan hands back a
		// scroll-fresh div at the identical position several times a second.
		// Re-pointing there costs an `unobserve` and an `observe` per tick,
		// and `observe()` arms a delivery for a newly observed element on the
		// next frame no matter what its size, so the churn is what was
		// manufacturing the callbacks in the first place. Keeping the
		// observation stops them at the source; `originLineResized`'s epsilon
		// guard is what makes the ones that still arrive cheap.
		//
		// `lastSyncContentLeft` is the PREVIOUS sync's answer - the edge the
		// still-observed line was measured at - and `left` is this sync's, so
		// the comparison costs no rect read of its own. A line that has left
		// the document is not kept: a stale observation on a detached div is a
		// watch on nothing, and the next sync re-points it.
		if (
			line !== null &&
			this.originLine?.isConnected &&
			Math.abs(left - this.lastSyncContentLeft) <= CONTENT_ORIGIN_EPSILON
		) {
			return;
		}
		if (this.originLine) observer.unobserve(this.originLine);
		this.originLine = line;
		if (line) observer.observe(line);
	}

	function originStyle(this: InkOverlayPlugin, el: Element): CSSStyleDeclaration {
		this.originStyles ??= new WeakMap<Element, CSSStyleDeclaration>();
		let value = this.originStyles.get(el);
		if (!value) { value = this.winRef.getComputedStyle(el); this.originStyles.set(el, value); }
		return value;
	}

	/** Untransformed column position for the owned normal-flow sizer tree.
	 * A transformed DOM rect loses precision as it crosses the viewport; its
	 * de-panned value cannot be made stable by rearranging subtraction. Read
	 * resolved fractional margins and insets in the same layout coordinates
	 * as band.left instead. Unsupported positioning keeps the live DOM path.
	 */
	function ownedColumnLayoutLeft(this: InkOverlayPlugin, line: Element | null): number | null {
		if (!this.viewportLayout || !this.band || !line) return null;
		const scroller = this.view.scrollDOM, sizer = this.panSizer();
		if (!sizer || !sizer.contains(line)) return null;
		// THE LEFT RESERVE'S TRANSLATE DOES NOT SEND THIS MEASURE TO THE DOM PATH. Refusing it did, and that path read
		// the column about 3450 local px right of the owned layout at 10% (reserve about 3980): the re-measure booked it
		// as a changed column, the margin debt paid it into the scroll, and the page jumped about 350 px in one frame.
		// Matched to 0.01 px, not exactly: a float miss would drop back to the DOM path and bring the jump back unseen.
		const reserve = this.leftReserveHeld > 0 ? this.leftReserveHeld : 0;
		const isReserve = (translate: string): boolean => {
			const parts = translate.trim().split(/\s+/);
			return reserve > 0 && parts.length === 1 && Math.abs(parseFloat(parts[0]!) - reserve) <= 0.01;
		};

		let x = 0;
		for (let el: Element | null = line; el && el !== scroller; el = el.parentElement) {
			const parent: Element | null = el.parentElement;
			if (!parent) return null;
			const cs = this.originStyle(el), ps = this.originStyle(parent);
			if (cs.direction !== 'ltr' || cs.writingMode !== 'horizontal-tb' || cs.cssFloat !== 'none' ||
				(cs.position !== 'static' && cs.position !== 'relative') ||
				(cs.position === 'relative' && ((cs.left !== 'auto' && parseFloat(cs.left) !== 0) || (cs.right !== 'auto' && parseFloat(cs.right) !== 0))) ||
				(el !== sizer && cs.transform !== 'none') || (cs.translate !== 'none' && !(el === sizer && isReserve(cs.translate))) || cs.rotate !== 'none' || cs.scale !== 'none' ||
				(cs.display !== 'block' && cs.display !== 'flow-root' && cs.display !== 'flex') || ps.display.includes('grid') ||
				(cs.zoom !== '1' && cs.zoom !== 'normal') || (ps.zoom !== '1' && ps.zoom !== 'normal')) return null;
			if (ps.display.includes('flex')) {
				const row = ps.flexDirection === 'row';
				const alignment = cs.alignSelf === 'auto' ? ps.alignItems : cs.alignSelf;
				if (ps.flexWrap !== 'nowrap' || cs.order !== '0') return null;
				if (row && ps.justifyContent !== 'normal' && ps.justifyContent !== 'start' && ps.justifyContent !== 'flex-start' && ps.justifyContent !== 'left') return null;
				if (!row && (ps.flexDirection !== 'column' || (alignment !== 'normal' && alignment !== 'stretch' && alignment !== 'start' && alignment !== 'flex-start'))) return null;
				if (row) for (let sibling: Element | null = parent.firstElementChild; sibling; sibling = sibling.nextElementSibling) {
					if (sibling === el) continue;
					const ss = this.originStyle(sibling);
					if (ss.display !== 'none' && ss.position !== 'absolute' && ss.position !== 'fixed') return null;
				}
			}
			const margin = parseFloat(cs.marginLeft), padding = parseFloat(ps.paddingLeft), border = parent === scroller ? 0 : parseFloat(ps.borderLeftWidth);
			if (!Number.isFinite(margin) || !Number.isFinite(padding) || !Number.isFinite(border)) return null;
			x += margin + padding + border;
			// The sizer's translate is the left reserve and nothing else. It is painted, so the column carries it here as it
			// does in `holdLeftReserve`, which shifts the owned layout's column by the same amount.
			if (el === sizer && cs.translate !== 'none') x += reserve;
			if (parent === scroller) return x;
		}
		return null;
	}

	/** Keep scroll-only rect rounding out of the camera shared by paint/input.
	 * A changed basis accepts raw geometry immediately. Unobserved flow changes
	 * still compare against the retained reference and cannot accumulate drift.
	 */
	function canonicalCameraY(this: InkOverlayPlugin, raw: number, adopt: boolean): number {
		const canvases = [this.committedCanvas, this.highlightCanvas, this.wetCanvas, this.highlightWetCanvas, this.tailCanvas];
		const backing = Math.max(...canvases.map(c => c ? Math.max(c.width / this.cssWidth, c.height / this.cssHeight) : NaN));
		if (!this.viewportLayout || !this.band || !this.scaleGeometryValid || !Number.isFinite(raw) || !Number.isFinite(backing)) {
			if (adopt) this.cameraOriginY = null;
			return raw;
		}
		// NOT `viewportGeneration`. That counter is continuation OWNERSHIP: a
		// pen-down, a pinch start, `restoreViewportLayout` and a navigation each
		// bump it so a pending async measure can tell it no longer owns the
		// view. None of the four is a geometry input in its own right, and every
		// geometry a bump could stand for is already a term here - the band,
		// both pans, both scales, the padding, the dpr, the backing, the layout
		// object. With it in the basis every pen-down reseeded the retained
		// origin, so the first stroke after a scroll adopted a raw Y that sat
		// INSIDE both caps and re-rasterised the whole note for it: measured at
		// 6-17 ms a stroke, one per round at 0.15 and one per scroll at 0.10,
		// near and far alike, and every sub-cap basis reset in that measurement
		// was attributed to this term and to nothing else.
		// Removing it does not disable the rule at a pen-down; it stops a
		// pen-down from disabling the rule.
		const basis = [this.filePath(), this.view.contentDOM, this.container, this.panSizer(), this.band,
			this.cssScale, this.fontZoom, this.panX(), this.panY(), this.rasterPan?.x, this.rasterPan?.y,
			this.contentStyle?.paddingTop, this.view.scaleX, this.view.scaleY, this.dpr, backing,
			this.viewportLayout];
		// Did this call ADOPT a raw that differs from the retained one?
		// That is either a basis reset or a raw beyond the cap, and both are the
		// moments the anchor has to be re-proved against `anchorTop` - a theme
		// switch that displaces the wrapper by a constant looks exactly like
		// genuine text movement otherwise. Recorded here, acted on by
		// `syncCamera`, because the gate costs a rect read and this method is
		// called by the read-only twin too.
		const priorY = this.cameraOriginY ? this.cameraOriginY.y : null;
		const y = stableCameraOriginY(raw, this.cameraOriginY, basis, this.cssScale, this.fontZoom, backing);
		if (adopt) this.anchorAdoptionEvent = priorY === null || (y === raw && raw !== priorY);
		if (adopt && (y === raw || !this.cameraOriginY)) this.cameraOriginY = { y, basis };
		return y;
	}

	/**
	 * Prove the ladder still stands for the same document top `anchorTop`
	 * reports, and take it out of service for this view's lifetime if not.
	 *
	 * ONE `contentDOM` rect read, and only at the events that already cost a
	 * full redraw or a mount - `basisResets` measures 0 per round on the far
	 * arms, so this is never on the steady scroll path. Every consumer falls
	 * back together because the ladder itself is unmounted: the camera, the
	 * read-only twin and the diagnostics all ask `documentAnchorLadder` first.
	 */
	function gateAnchorParity(this: InkOverlayPlugin, reason: string, implied: number, rungTopLayout: number): void {
		const shipped = anchorTop(this.view, this.contentStyle?.paddingTop, this.cssScale);
		const contentTop = this.view.contentDOM.getBoundingClientRect().top;
		const bar = anchorParityBar(contentTop, rungTopLayout, this.cssScale);
		if (Number.isFinite(implied) && Number.isFinite(shipped) && Math.abs(implied - shipped) <= bar) return;
		refuseDocumentAnchor(this.view, { implied, shipped, bar, reason });
		scrollProbeExtent(`document anchor refused (${reason}): implied ${implied} vs anchorTop ${shipped}, delta ${Math.abs(implied - shipped)} > bar ${bar}`);
	}

	/**
	 * Z10: WHERE THE LADDER IS THE DEFECT, NOT THE CURE.
	 *
	 * The ladder exists because a large rect is rounded at its magnitude: on the
	 * transform host `.cm-content`'s top is a float32 far from the screen, and
	 * that rounding moved the camera every frame. On a css-zoom host the same
	 * rect is not rounded at all. Blink stores zoomed positions as LayoutUnits
	 * (1/64 of a layout-zoom px) and the web-exposed scroll offset is a whole
	 * px, so the rect top is an exact dyadic value that float32 carries without
	 * loss - and `anchorTop` is exact.
	 *
	 * The ladder, on that host, is not. The rung's zoomed top is TRUNCATED to
	 * 1/64 (`LayoutUnit(float)`), so its implied document top is off by the
	 * dropped part, plus `rungTop x (zoom - cssScale)` where the measured scale
	 * is itself a truncated width over an integer offsetWidth. At adoption
	 * `gateAnchorParity` sees that difference, refuses the ladder, the next sync
	 * falls back to `anchorTop`, and the camera moves back: two camera-only
	 * whole-world redraws per refusal (LagAtLowZoom's far and fractional arms;
	 * recorded per sync in `test/render/z10Recorder.ts`).
	 *
	 * So the ladder is bypassed exactly where `anchorTop` is exact, and nowhere
	 * else - everywhere else the ladder path runs as it did:
	 *  - the host form in force is css zoom, with no transform of its own, and
	 *    the measured scale is the host's zoom and nothing more. An ancestor
	 *    transform would put a non-dyadic factor into the rect; the measured
	 *    quotient is within 2/offsetWidth of the product when it is only the
	 *    width's own truncation (the fd04036e bound);
	 *  - the layout zoom factor is 1 or 2. Page zoom and display scaling enter
	 *    Blink as a layout zoom factor the rect is divided by; at 1.25 the rect
	 *    reads 11468.7998046875 where 1 and 2 read 11468.796875 (measured,
	 *    real device scale factor). `devicePixelRatio` is how that factor is
	 *    seen from here;
	 *  - the coordinate is inside float32's exact range at that grid:
	 *    24 bits of mantissa over a 1/(64 x dpr) px grid is 2^18 / dpr px.
	 */
	function anchorTopExactOnZoomHost(this: InkOverlayPlugin, overlayTop: number): boolean {
		const layout = this.viewportLayout;
		if (!layout || !this.container || !this.zoomFormAt(this.pinchScaleNow)) return false;
		if (layout.baseTransform !== "none" && layout.baseTransform !== "") return false;
		if (this.dpr !== 1 && this.dpr !== 2) return false;
		const width = this.container.offsetWidth;
		const own = layout.baseZoom * this.pinchScaleNow;
		if (!(width > 0) || !(own > 0) || !Number.isFinite(this.cssScale)) return false;
		if (Math.abs(this.cssScale / own - 1) > 2 / width) return false;
		return Math.abs(this.view.scrollDOM.scrollTop * this.cssScale) + Math.abs(overlayTop) < this.zoomRectExactLimit() / this.dpr;
	}

	/**
	 * float32's exact range for a 1/64 px grid, in zoomed px. A method rather
	 * than a constant so a render cell can plant a lower limit on the prototype
	 * and read the ladder path take over above it.
	 */
	function zoomRectExactLimit(this: InkOverlayPlugin): number {
		return 2 ** 18;
	}

export function installLayout(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		watchResolution,
		unwatchResolution,
		replayDeferredResize,
		handleResize,
		resolveColumnLeft,
		columnLeft,
		originLineResized,
		watchOriginLine,
		originStyle,
		ownedColumnLayoutLeft,
		canonicalCameraY,
		gateAnchorParity,
		anchorTopExactOnZoomHost,
		zoomRectExactLimit,
	});
}
