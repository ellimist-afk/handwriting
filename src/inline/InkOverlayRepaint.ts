/**
 * The overlay's committed repaint: the committed layer a finished stroke belongs to, the drawing of committed ink for one frame, and the repaint that chooses what to draw.
 * They are methods of InkOverlayPlugin, installed on its prototype when InkOverlay.ts loads.
 */
import { Platform } from "obsidian";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { paintPurgeSentinel, purgeDetected, purgeProbeArmed, purgeProbeDue, readPurgeSentinel } from "../ink/PurgeSentinel";
import { BBox, InkStroke, InkTool } from "../ink/Stroke";
import { drawCommitted, drawRegion } from "../ink/StrokeRenderer";
import { scrollProbeRepaint } from "./ScrollProbe";
import { installMethods } from "./InstallMethods";
import { committedFloorFor, committedRepaintPlan, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		committedCtxFor(tool: InkTool): CanvasRenderingContext2D;
		paintCommittedWork(cam: { x: number; y: number; zoom: number }, work: "all" | BBox[], strokes: readonly InkStroke[]): boolean;
		repaint(): void;
	}
}


	// ---- committed repaint --------------------------------------------------

	/** The committed layer a finished stroke belongs to. */
	function committedCtxFor(this: InkOverlayPlugin, tool: InkTool): CanvasRenderingContext2D {
		return tool === "highlighter" ? this.highlightCtx : this.committedCtx;
	}

	/**
	 * Draw committed ink for one frame: everything at `cam` when `work` is
	 * "all", else the damaged rects through the stroke index. Shared by the
	 * ordinary repaint and the repaint under a pinch hold, which paints at
	 * the RETAINED camera (see `repaint`). Returns whether the purge probe
	 * is armed, for the heal check that follows an ordinary repaint.
	 */
	function paintCommittedWork(this: InkOverlayPlugin, cam: { x: number; y: number; zoom: number }, work: "all" | BBox[], strokes: readonly InkStroke[]): boolean {
		const probeArmed = purgeProbeArmed(Platform.isMobileApp, diagnosticsEnabled());
		// One source for both branches: a partial repaint must match a full
		// one, or ink would visibly change width between a damage frame and
		// the next full one. See fillRibbon/WidthFloor.ts.
		const floor = committedFloorFor(this.committedBacking, this.dpr);
		const mayBuild = this.extentMayBuild;
		this.extentMayBuild = false;
		// An insert space release asks one arm: the drag let the raster go (the store changed under it), and the release no longer
		// repaints whole, which was the frame that armed the next build. Taken once here, never per drag frame: an arm on every drag
		// frame would rescan every stroke's box per frame, and the next drag frame lets the raster go again. Kept by a paint that
		// may not build (a pen down within a frame of the lift), so the next paint that may build still arms it.
		const armAsked = this.extentArmAsked;
		if (mayBuild) this.extentArmAsked = false;
		if (armAsked && work !== "all" && mayBuild && !this.usableExtent(cam, strokes)) this.armExtentBuild(cam, strokes, floor);
		if (work === "all") {
			// Read before the paint marks below clear it.
			const mark = this.standIn?.mark ?? null;
			// A note holding a highlighter stroke needs the pair; one without it
			// leaves the pair at 0x0 and skips its draw.
			if (this.highlightPairDeferred && strokes.some(stroke => stroke.tool === "highlighter")) this.allocateHighlightPair();
			this.markCommittedPaint("highlighter");
			this.markCommittedPaint("pen");
			const ext = this.usableExtent(cam, strokes);
			// No raster at this scale: the frame shows the stand-in if one holds, else paints by path; the raster is built after it, in pieces.
			if (!ext && mayBuild) this.armExtentBuild(cam, strokes, floor);
			// A stand-in no build will replace is let go here (the build did not fit, or there is nothing to build).
			if (this.standIn && (ext || (mayBuild && !this.extentBuild))) this.dropStandIn();
			// A whole repaint that may not build (a stroke being built, a pan's own frame) keeps the stand-in and starts
			// nothing, and once that ends nothing else asks: the stand-in would stay on screen, cut where its picture ends, until the next zoom.
			if (this.standIn && !ext && !mayBuild && !this.extentBuild) this.retryStandInLater();
			const stand = !ext && this.standIn ? this.usableStandIn(strokes, true, cam) : null;
			if (ext && this.copyFromExtent(ext, cam, null)) {
				if (probeArmed) paintPurgeSentinel(this.committedCtx);
			} else if (stand && !this.inQueuedFrame) {
				// A whole repaint outside the queued frame (a zoom commit runs two to four, each after a backing write, in its own task)
				// draws nothing: the whole layer goes back on the damage and the queued frame copies the stand-in once, before that
				// frame paints, so no blank frame is shown and the commit's repaints coalesce into one copy.
				this.standInDeferrals++;
				this.damage.addAll();
				this.scheduleRepaint("partial");
			} else if (stand && this.inQueuedFrame && mark && this.standInMarkHolds(mark, cam, strokes)) {
				// The layers still hold this stand-in's last whole copy at this camera, backing, size and stroke set (a zoom commit asks
				// a second whole repaint a frame after its copy, with nothing changed): paint nothing, keep the mark.
				stand.mark = mark;
			} else if (stand && this.copyFromStandIn(stand, cam, null, strokes, floor)) {
				if (probeArmed) paintPurgeSentinel(this.committedCtx);
			} else {
				if (!this.highlightPairDeferred) drawCommitted(this.highlightCtx, cam, strokes, this.cssWidth, this.cssHeight, true, "highlighter", undefined, floor);
				drawCommitted(this.committedCtx, cam, strokes, this.cssWidth, this.cssHeight, true, "pen", probeArmed, floor);
			}
			this.highlightBlank = !strokes.some(stroke => stroke.tool === "highlighter");
			this.committedBlank = !probeArmed && !strokes.some(stroke => stroke.tool !== "highlighter");
		} else if (work.length > 0) {
			// A deferred highlight layer stays blank: marked painted, its 0x0
			// canvas would count as an occupied layer in the pinch composite.
			if (!this.highlightPairDeferred) this.markCommittedPaint("highlighter");
			this.markCommittedPaint("pen");
			if (this.indexDirty) {
				this.strokeIndex.rebuild(strokes);
				this.indexDirty = false;
			}
			const ext = this.usableExtent(cam, strokes);
			const stand = !ext && this.standIn ? this.usableStandIn(strokes, false, cam) : null;
			for (const rect of work) {
				if (ext && this.copyFromExtent(ext, cam, rect)) continue;
				if (stand && this.copyFromStandIn(stand, cam, rect, strokes, floor)) continue;
				// Only the part of the rect the canvas covers. An insert space drag damages the whole moving band, from the seam to
				// the note's end; on a heavy note the index returned every stroke in it (about 22000 of 28555) and each one was
				// stroked under a clip that showed none of them. Off the canvas nothing can paint, so the pixels are the same.
				const left = Math.max(rect.x, cam.x), top = Math.max(rect.y, cam.y);
				const right = Math.min(rect.x + rect.width, cam.x + this.cssWidth / cam.zoom), bottom = Math.min(rect.y + rect.height, cam.y + this.cssHeight / cam.zoom);
				if (!(right > left && bottom > top)) continue;
				// The clip on whole device pixels, outward. A clip edge between device pixels (page zoom 91.3 percent is a device pixel
				// ratio of 1.8257) drew every stroke under it with fainter edges than a whole repaint draws, so a partial repaint left
				// the ink lighter than the next whole one, which the insert space release's whole repaint was hiding. Outward only
				// adds pixels that are redrawn as they were.
				const k = cam.zoom * (this.committedCanvas.width / this.cssWidth);
				const out = (v: number, o: number, f: (n: number) => number) => (k > 0 && Number.isFinite(k) ? o + f((v - o) * k) / k : v);
				const sl = out(left, cam.x, Math.floor), st = out(top, cam.y, Math.floor);
				const sr = out(right, cam.x, Math.ceil), sb = out(bottom, cam.y, Math.ceil);
				const onCanvas = { x: sl, y: st, width: sr - sl, height: sb - st };
				const hit = this.strokeIndex.query(onCanvas);
				// A highlighter stroke reaching a deferred layer (undo, paste, sync)
				// gets a fresh blank backing: paint the whole highlight layer once.
				if (this.highlightPairDeferred && hit.some(stroke => stroke.tool === "highlighter")) {
					this.allocateHighlightPair();
					this.markCommittedPaint("highlighter");
					drawCommitted(this.highlightCtx, cam, strokes, this.cssWidth, this.cssHeight, true, "highlighter", undefined, floor);
				}
				if (!this.highlightPairDeferred) drawRegion(this.highlightCtx, cam, hit, onCanvas, true, "highlighter", floor);
				drawRegion(this.committedCtx, cam, hit, onCanvas, true, "pen", floor);
			}
			// A damage rect covering the band corner clears the marker, and
			// `drawRegion` has no reason to know about it. Repainting is
			// idempotent, so this needs no test for whether it was hit.
			if (probeArmed) paintPurgeSentinel(this.committedCtx);
		}
		// Only a whole-world paint puts every stroke of the store on the raster; a partial one draws the strokes in its rects.
		if (work === "all") this.paintedStrokeCount = strokes.length;
		return probeArmed;
	}

	function repaint(this: InkOverlayPlugin): void {
		if (this.deferPinchRaster()) {
			// The queued frame is CONSUMED here: `scheduleRepaint`'s rAF clears
			// `repaintQueued` before calling this. During an active pinch
			// `pinchScrollAt` is re-stamped every preview frame, so this stays
			// true for the whole gesture and damage pending when the deferral
			// began would never be drawn. The case that matters is a stroke
			// committing mid-gesture: `drawCommitted` clears the preview offset
			// and marks the layer dirty synchronously so the new stroke lands
			// right, but the REST of the layer would keep showing the pre-gesture
			// raster, untranslated, for the rest of the pinch - the original
			// slide, re-introduced by the fix for it.
			//
			// A LATCH AND ONE TIMER, not a re-armed rAF. Re-arming per frame is a
			// requestAnimationFrame loop for the duration of the gesture, on the
			// path the deferral exists to keep free. Settle needs nothing:
			// `commitCameraScale` re-rasters and clears the latch. What is left is
			// a pause past the quiet window or a lost end event, and one timer
			// covers both.
			if (!this.damage.isEmpty) this.armDeferredRepaint();
			return;
		}
		this.restorePinchLayers();
		if (!this.container) return;
		// UNDER THE HOLD (D-COV): no band move, no reallocation,
		// no camera re-base, no offset clearing. The raster keeps the basis the
		// preview translate was solved against, and damage that arrived
		// mid-gesture (a stroke committing) paints into the retained backing at
		// that camera, so the new ink lands where the pen put it and the rest
		// of the layer stays put. Measured on e355b259 (2026-09-13): a stroke
		// committing in a held zoom-in at k 0.75 sent this frame through
		// syncBand and handleResize, which re-sized the band from the unpanned
		// viewport (6000 -> 1601 layout px tall), and the mark at rows
		// 2372-2612 fell outside it until the settle. What a bigger band would
		// show waits for the settle, which re-rasters against the settled column.
		if (this.pinchPreview && this.lastPaintCam !== null) {
			const work = this.damage.take();
			if (work === "all" || work.length > 0) {
				const path = this.filePath();
				this.paintCommittedWork(this.lastPaintCam, work, path ? this.committedStrokes(this.noteStrokes(path)) : []);
			}
			return;
		}
		if ((this.winRef.devicePixelRatio || 1) !== this.dpr) {
			this.handleResize();
			return;
		}
		// Position, then measure, then draw - all inside this one frame. That
		// ordering is what makes the ink's position independent of timing: a
		// late repaint costs coverage at a band edge, never a displacement.
		// A resize reallocates the backings and repaints synchronously, so
		// this frame's work is done there; carrying on would paint twice at
		// the same camera. Same shape as the dpr check above.
		// Diagnostic only: the scroll probe's repaint line reads the carry and the two spans timed below. With the switch
		// off this costs one boolean read and one field write.
		const diag = diagnosticsEnabled();
		this.bandCarriedThisFrame = false;
		const bandMove = this.syncBand();
		if (bandMove === "resized") {
			this.handleResize();
			return;
		}
		// Diagnostic only, for the probe's repaint line: whether this frame baked a settled pan.
		const panBaked = this.rasterPanNeedsBake();
		if (panBaked) {
			// A settled pan must move ink within the bounded raster, not move
			// every canvas away from part of the writable editor. Change the
			// camera and input origin together. The bake adds no damage of its
			// own: the repaint plan below redraws the whole layer when the camera
			// moved past the sub-pixel bar, and a bake that leaves the camera
			// inside the bar moved no ink, so it paints nothing (at 34 percent
			// a still bake redrew 28,358 strokes in 192 ms).
			// The rest, not a bounce passing through: the ink layer's translate carries the bounce, and baking each of its
			// frames would re-raster the world a dozen times for an animation that ends where it began.
			this.rasterPan = this.rasterPanTarget();
			this.writeInkLayerTransform();
			this.wet.clear(this.cssWidth, this.cssHeight);
			this.highlightWet.clear(this.cssWidth, this.cssHeight);
			this.tail.clearAll(this.cssWidth, this.cssHeight);
			this.tail.prepareLive(null, null);
			this.spaceFeedbackKey = null;
			this.router?.refreshRect();
		}
		const syncAt = diag ? performance.now() : 0;
		this.syncCamera();
		const syncCameraMs = diag ? performance.now() - syncAt : 0;
		const path = this.filePath();
		const strokes = path ? this.committedStrokes(this.noteStrokes(path)) : [];
		const cam = this.camera.snapshot;
		if (panBaked && this.cssScale < 1) this.carryBakedPan(cam, strokes.length);
		const last = this.lastPaintCam;
		// A successful carry already moved the overlap by whole backing pixels
		// and recorded the camera those pixels sit at; its frame gets the same
		// sub-pixel bar as every other (committedRepaintPlan).
		const damageIn = this.damage.take();
		const plan = committedRepaintPlan(last, cam, damageIn, this.committedBacking ?? 0);
		const work = plan.work;
		this.lastPaintCam = plan.painted;
		// This frame redraws the committed layer against the CURRENT column, so
		// any preview translation is now baked into the pixels and must come
		// off, and the anchor must describe this raster rather than the one it
		// replaced. Reachable mid-gesture: holding a pinch still past
		// PINCH_SCROLL_QUIET_MS lets deferPinchRaster go false and a repaint
		// through.
		if (this.pinchPreview) {
			this.clearPreviewInkOffset();
			// INVALIDATE, do not re-latch here. The anchor has to be read while
			// the host still carries the scale the raster was drawn at, and by
			// the time the NEXT preview frame calls this method
			// `applyViewportBox` has already moved the column. Re-latching from
			// inside repaint measured the column one box-change too late and
			// put a constant 855 host-local px into the anchor - measured as a
			// residual that decayed exactly in proportion to k (-256.4 at 0.30,
			// -170.9 at 0.20, -128.2 at 0.15, -85.5 at 0.10; all -855 * k).
			this.previewAnchorStale = true;
		}
		// The purged-canvas marker, and everything about it, is off unless
		// this is a mobile surface with diagnostics recording (PurgeSentinel.ts
		// says why it is not on for everyone yet). Desktop pays one boolean.
		const paintAt = diag ? performance.now() : 0;
		this.extentMayBuild = this.extentBuildAllowed();
		const probeArmed = this.paintCommittedWork(cam, work, strokes);
		const paintMs = diag ? performance.now() - paintAt : 0;
		// ---- the purge heal (1.4.12-design.md §14, cause B) -----------------
		// A scroll repaint with no work drew nothing, which is correct while
		// the camera is still and catastrophic if WebKit has quietly taken the
		// canvas's pixels: nothing would ask for them again until the band
		// moved. Read the marker back; a zero means they are gone, and
		// `scheduleRepaint` with any via but "scroll"/"partial" is what
		// asserts `damage.addAll()` and puts the world back on screen.
		if (
			purgeProbeDue({
				armed: probeArmed,
				scrollRepaint: this.repaintScrollOnly,
				foundWork: work === "all" || work.length > 0,
				strokeOwnsFrame: this.frame.locked,
				noteHasInk: strokes.length > 0,
				now: performance.now(),
				lastProbe: this.lastPurgeProbe,
			})
		) {
			this.lastPurgeProbe = performance.now();
			if (purgeDetected(readPurgeSentinel(this.committedCtx))) {
				this.scheduleRepaint("purge-heal");
			}
		}
		// Selection chrome lives in world coordinates: scrolling and reflow
		// repaint it at the strokes' current position.
		if (!this.selection.isEmpty || this.lassoActive || this.spaceLineY !== null || this.spacePreview)
			this.redrawSelectionUI();
		// While a stroke is active this repaint ran with the LOCKED pen-down
		// camera (syncCamera above was a no-op); measure how far that frame
		// has diverged from a fresh read: the ink layer's on-screen error.
		if (diagnosticsEnabled()) {
			let driftX = 0;
			let driftY = 0;
			if (this.frame.locked) {
				const fresh = this.freshFrame();
				if (fresh) {
					driftX = fresh.x - this.camera.x;
					driftY = fresh.y - this.camera.y;
				}
			}
			scrollProbeRepaint({
				camX: this.camera.x,
				camY: this.camera.y,
				documentTop: this.lastSyncDocumentTop,
				contentLeft: this.lastSyncContentLeft,
				rectLeft: this.lastSyncRectLeft,
				rectTop: this.lastSyncRectTop,
				scale: this.scale,
				scrollLeft: this.view.scrollDOM.scrollLeft,
				scrollTop: this.view.scrollDOM.scrollTop,
				strokesDrawn: strokes.length,
				locked: this.frame.locked,
				driftX,
				driftY,
				work: work === "all" ? "all" : `${work.length} rect`,
				allFrom: plan.sources.join("+"),
				panBaked,
				damageIn: damageIn === "all" ? "all" : `${damageIn.length} rect`,
				camDeltaX: last ? cam.x - last.x : undefined,
				camDeltaY: last ? cam.y - last.y : undefined,
				bandMoved: bandMove === "moved",
				carried: this.bandCarriedThisFrame,
				syncCameraMs,
				paintMs,
			});
		}
		this.updateExtent();
	}

export function installInkOverlayRepaint(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		committedCtxFor,
		paintCommittedWork,
		repaint,
	});
}
