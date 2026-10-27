/**
 * The note surface's scroll band and extent: the band of the committed layers that follows the scroll, the carries of the baked pixels, the
 * extent of the scrollable area with its sideways shrink and left reserve, and the scroll-axis guard. They are methods of InkOverlayPlugin,
 * installed on its prototype when InkOverlay.ts loads.
 */
import { growDocumentAnchorLadder } from "./DocumentAnchor";
import { penSeenThisSession } from "./PenToolsMode";
import { PenSample } from "../input/PointerRouter";
import { Band, bandCovers, bandFor, bandMargin, bandNeedsMove, BandViewport } from "./ScrollBand";
import { ExtentInputs, sameExtentInputs } from "./FrontierCache";
import { shiftPlan } from "../ink/DamageLedger";
import { Extent, inkClaimX, leftReserve, onScreenFloorX, ScrollExpansionDemand, SHRINK_SCROLL_IDLE_MS, shrunkAxis, spacerPosition, surfaceExtents, surfaceOriginInScroller, writeFrontier, writeFrontierApplies, ZERO_EXTENT, zoomFrontier } from "./SurfaceExtent";
import { scrollProbeExtent } from "./ScrollProbe";
import { installMethods } from "./InstallMethods";
import { CAMERA_STILL_BACKING_PX, cameraWithin, inlineInk, instances, type RasterCamera, travelledEaseRoom, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		syncBand(): "none" | "moved" | "resized";
		carryBakedPan(cam: RasterCamera, strokeCount: number): void;
		slideCommittedPixels(shiftX: number, shiftY: number, backing: number): void;
		carryBandUnderLock(want: Band): "none" | "moved";
		updateExtent(force?: boolean, navigation?: { left: number; top: number }): void;
		shrinkSideways(path: string, ink: Extent, granted: Extent, neededX: number, originLeft: number, scroller: HTMLElement, force: boolean): Extent;
		shrinkWhenScrollIsQuiet(): void;
		bandPlacement(left: number, top: number): { left: string; top: string; transform: string };
		releaseBandMargin(scroller: HTMLElement, spacerRight: number): void;
		measureBandFreeHeight(scroller: HTMLElement, reported: number): number | null;
		holdLeftReserve(path: string, origin: { left: number; top: number }): number;
		dropLeftReserve(): void;
		ensureScrollableAxis(scroller: HTMLElement): void;
		restoreScrollableAxis(): void;
		measureReach(scroller: HTMLElement, required: number): void;
		/** Set by a lasso lift: the band's sideways margin may wait for the scroll that needs it (sidewaysMarginCanWait). */
		bandGrowthMayWait?: boolean;
	}
}

	/**
	 * Put the ink band where this viewport needs it, and say whether it moved.
	 *
	 * The band is the box the canvases cover, in the scroller's own content
	 * coordinates. It is deliberately LAZY: the whole point of living inside
	 * the scroller is that ordinary scrolling needs no work at all, so this
	 * writes nothing until the viewport has eaten into the margin. Moving it
	 * is what costs a full re-rasterization, and doing that per scroll event
	 * is what the viewport-anchored layer used to do.
	 *
	 * Skipped while a stroke owns the frame. The pen froze its camera at
	 * pen-down and every sample maps through that frozen frame; moving the
	 * box under it would shear the stroke being drawn. Nothing is lost by
	 * waiting - the band scrolls with the text on its own.
	 */
	function syncBand(this: InkOverlayPlugin): "none" | "moved" | "resized" {
		if (!this.container) return "none";
		const scroller = this.view.scrollDOM;
		const viewport: BandViewport = {
			scrollLeft: scroller.scrollLeft,
			scrollTop: scroller.scrollTop,
			clientWidth: scroller.clientWidth,
			clientHeight: scroller.clientHeight,
			scrollWidth: this.bandFreeScrollWidth ?? scroller.scrollWidth,
			scrollHeight: scroller.scrollHeight,
			// The band's margin is headroom for a fling, and a fling is measured
			// in the px the reader sees. Below 1.0 the host is counter-sized, so
			// the scroller's own px are worth `cssScale` of those - without this
			// term the margin shrinks with the zoom and the band is re-pinned on
			// every frame of a flick, each one a whole-world rasterisation.
			scale: this.cssScale,
		};
		// AN EASE BACK TO THE PAGE'S EDGE SHOWS ROOM LEFT OF THE SCROLL. The bounce moves the layer by a translate, and
		// the band is placed from the scroll alone, so while a page slides back from right of its edge the pane shows
		// scroll the band does not hold - ink in the left reserve, just drawn there, painted nowhere until the ease has
		// carried it off the pane. The band is widened to cover both ends of the ease, once: the width is taken at the
		// first sync of the bounce, rounded up to a whole px, and held while that bounce lives. Recomputed per sync it is
		// divided by a cssScale read back from the band's own rect, which each resize moves by a few millionths - a new
		// width, another resize, measured 1821 of them in one ease at 7% before the renderer died. Nothing lies left of
		// scroll zero, so the widening stops there: an ease on a page with no scroll to its left moves no band.
		// FOUR SIDES, NOT ONE. An ease from left of the edge (a negative start offset) shows room right of the scroll,
		// and one from above or below shows room under or over it, the same way: a settle that landed the page 192 px
		// left of where the preview showed it at outer scale 1.25 refused its ease against a band 111 px past the pane's
		// right, and the page jumped at the lift. Each side is widened by its own start offset, stopped at the scroll
		// range on that side as the left one stops at zero, so the band never adds scroll range (bandFor). The right and
		// bottom sides also stop at one maximal band margin, the bound the settle eases within (travelledEaseRoom).
		const bounce = this.bounceState;
		if (!bounce || (!bounce.fromX && !bounce.fromY) || !(this.cssScale > 0)) this.bandEase = null;
		else if (this.bandEase?.bounce !== bounce) this.bandEase = {
			bounce, x: Math.sign(bounce.fromX) * Math.ceil(Math.abs(bounce.fromX) / this.cssScale), y: Math.sign(bounce.fromY) * Math.ceil(Math.abs(bounce.fromY) / this.cssScale),
		};
		const ease = this.bandEase, room = ease && (ease.x < 0 || ease.y < 0) ? travelledEaseRoom(viewport) : null;
		if (ease && ease.x > 0) { const e = Math.min(ease.x, viewport.scrollLeft); viewport.scrollLeft -= e; viewport.clientWidth += e; }
		else if (ease && ease.x < 0 && room) viewport.clientWidth += Math.min(-ease.x, room.x);
		if (ease && ease.y > 0) { const e = Math.min(ease.y, viewport.scrollTop); viewport.scrollTop -= e; viewport.clientHeight += e; }
		else if (ease && ease.y < 0 && room) viewport.clientHeight += Math.min(-ease.y, room.y);
		if (this.frame.locked) {
			// A stroke owns the frame. The band may stay where it is ONLY while
			// every pixel the viewport shows is inside it: deferring past that
			// point leaves the pen walking off the canvas edge, drawing wet ink
			// nowhere (Orion 2026-09-13, 10% far down and right: the mark that
			// lands before the frame that would have followed the last scroll
			// sits on a band one scroll behind, and its right-hand end is never
			// painted). A size change is still deferred: a reallocation blanks
			// five canvases and cannot be carried.
			if (!this.band || bandCovers(this.band, viewport)) { this.bandSyncDeferred = true; return "none"; }
			const want = bandFor(viewport);
			if (want.width !== this.band.width || want.height !== this.band.height) { this.bandSyncDeferred = true; return "none"; }
			return this.carryBandUnderLock(want);
		}
		this.bandSyncDeferred = false;
		this.bandFreeScrollWidth = null;
		// The note got shorter under a band that holds the scroll's end: place the band against the height the note
		// has without it, and as if the scroll had already clamped into that range (audit 178). Past the hysteresis,
		// because a shrink between half a margin and one and a half margins asks no move of bandNeedsMove.
		const freeHeight = this.measureBandFreeHeight(scroller, viewport.scrollHeight);
		if (freeHeight !== null) {
			viewport.scrollHeight = freeHeight;
			if (viewport.scrollTop > freeHeight - viewport.clientHeight) viewport.scrollTop = Math.max(0, freeHeight - viewport.clientHeight);
		} else if (this.bandGrowthMayWait && this.band && sidewaysMarginCanWait(this.band, viewport)) return "none";
		else {
			// The pane left the band, or another size asks: the wait is over, taken with this sync.
			this.bandGrowthMayWait = false;
			if (!bandNeedsMove(this.band, viewport)) return "none";
		}
		const band = bandFor(viewport);
		// A SIZE change has to reach handleResize, and the ResizeObserver will
		// not carry it: that observer watches the editor, so it fires when the
		// viewport changes and never when we resize our own container.
		//
		// Vertically that gap is invisible, because the band's height only
		// changes when the viewport's does - which the observer sees. The
		// width is the one that bites: it changes when the surface becomes
		// horizontally scrollable, which INK causes, not a resize. The
		// container widened to hold the margin while the canvases stayed at
		// their old width, so every stroke past the old right edge was drawn
		// outside the canvas and simply never appeared (alan, hardware:
		// "drawing breaks on the right extended canvas ... no ink comes out").
		const resized = this.band === null || this.band.width !== band.width || this.band.height !== band.height;
		// A MOVE OF THE SAME BOX CARRIES ITS PIXELS, AT REST AS UNDER A STROKE. Placing the box and re-rastering the
		// world cost 7 to 10 ms per move with 1500 strokes on the pane, four moves per 300 px fling (ScrollCost, the
		// canvas-on finger-right arm). The carry slides the painted pixels by a whole number of device px and owes only
		// the strips the move uncovers. A shift that snaps to zero device px moves the box the old way. So does a raster
		// that may not hold what the store holds: one not of the camera now held, inside the sub-pixel bar (at rest a camera change can be waiting
		// for its repaint), or one painted when the store held a different number of strokes (a load that asked for no
		// repaint). The full redraw of the old path is what showed that ink; a carry would keep it missing for good.
		const last = this.lastPaintCam;
		if (!resized && last) {
			const held = this.camera.snapshot, path = this.filePath();
			if (cameraWithin(last.x, last.y, last.zoom, held.x, held.y, held.zoom, this.committedBacking ?? 0, CAMERA_STILL_BACKING_PX)
				&& this.paintedStrokeCount === (path ? inlineInk.strokes(path).length : 0)) {
				if (this.carryBandUnderLock(band) === "moved") {
					this.bandCarriedThisFrame = true;
					return "moved";
				}
				this.bandSyncDeferred = false;
			}
		}
		this.band = band;
		this.container.setCssStyles({
			...this.bandPlacement(band.left, band.top),
			width: `${band.width}px`,
			height: `${band.height}px`,
		});
		// The box just moved under the router's cached rect. The scroll
		// handler refreshes it for the scrolling itself, but that runs BEFORE
		// this frame repositions the band, so without this the rect stays
		// stale by exactly the reposition - the hover reticle drifting off the
		// pen tip after every band move. Safe unconditionally: this method
		// returns early while a stroke owns the frame, so a refresh here can
		// never disturb a frozen one.
		this.router?.refreshRect();
		return resized ? "resized" : "moved";
	}

	/**
	 * AFTER A LASSO LIFT THE SIDEWAYS MARGIN WAITS FOR THE SCROLL THAT NEEDS IT. Ink moved to the right grows the extent,
	 * the range passes the pane's width, and bandFor spends a sideways margin: the band it wants is the current one plus a
	 * margin each side. Taken at once that is a resize, four backings reallocated and the whole layer painted (26 to
	 * 31 ms at a lasso lift on a heavy note), for pixels no one can see yet. So it waits while the current band, with no
	 * sideways margin of its own, covers every pixel the pane shows: the rule syncBand keeps under a stroke. No
	 * half-margin slack: the range that grew sideways usually grew downwards too, and a band whose bottom sat on the old
	 * end of the note has the pane's bottom on its edge, a move bandNeedsMove calls due though nothing new shows. The
	 * first sync that finds the pane past any edge of the band takes the growth and the move together, before that frame
	 * paints; that scroll would have moved the band anyway.
	 *
	 * Only after a lift (bandGrowthMayWait, set by commitLiveDrag and cleared by the sync that takes the growth). A note
	 * arriving grows its range the same way, and there the margin is taken at once as before: a wide note's first
	 * sideways scroll must not pay the resize, and the margin covers the pane's scrollbar gutter under a zoom.
	 *
	 * Nothing else waits: the height never changes here, and a band with sideways margin already, a pane that changed
	 * size or scale, or a range that narrowed asks for some other size, which resizes as before.
	 */
	function sidewaysMarginCanWait(current: Band, v: BandViewport): boolean {
		const want = bandFor(v), margin = bandMargin(v.clientHeight, v.scale);
		if (current.width !== v.clientWidth || want.height !== current.height || want.width !== current.width + 2 * margin) return false;
		return bandCovers(current, v);
	}


	/**
	 * A BAKE AT THE SAME ZOOM CARRIES ITS PIXELS, as a band move does. The bake moved the camera by the snapped raster
	 * pan (rasterPanTarget), a whole number of backing px, so the painted pixels slide by that much, exactly, and only
	 * the strips the slide uncovers are owed. Orion at 34 percent: every whole-layer bake redrew 28,358 strokes in 130
	 * to 270 ms, at the start of every edge bounce among them; a band move that carries costs 2.5 to 16 ms.
	 *
	 * The guard is syncBand's: a raster of the zoom now held, painted while the store held this many strokes.
	 * Otherwise, or when the slide is wider than the layer, nothing is carried and the repaint plan redraws the whole
	 * layer as before. The record is the camera the slid pixels sit at; the plan compares the camera now against it
	 * with the usual sub-pixel bar, so a re-measure a hair off the snapped move still reads as still.
	 */
	function carryBakedPan(this: InkOverlayPlugin, cam: RasterCamera, strokeCount: number): void {
		const last = this.lastPaintCam, backing = this.committedBacking ?? 0;
		if (!last || last.zoom !== cam.zoom || !(cam.zoom > 0) || !(backing > 0) || !Number.isFinite(backing)) return;
		if (this.paintedStrokeCount !== strokeCount) return;
		const moveX = (last.x - cam.x) * cam.zoom * backing, moveY = (last.y - cam.y) * cam.zoom * backing;
		// The move is carried when it is whole backing px within the plan's own sub-pixel bar (committedRepaintPlan): the
		// painted camera may already stand a tolerated part of a pixel off the camera, and that part rides along as it did.
		// A move further off a whole pixel leaves the plan to redraw at the camera now.
		const bar = CAMERA_STILL_BACKING_PX;
		if (Math.abs(moveX - Math.round(moveX)) >= bar || Math.abs(moveY - Math.round(moveY)) >= bar) return;
		const shiftX = Math.round(moveX) / backing, shiftY = Math.round(moveY) / backing;
		if (shiftX === 0 && shiftY === 0) return;
		const dx = -shiftX / cam.zoom, dy = -shiftY / cam.zoom;
		const at = { x: last.x + dx, y: last.y + dy, zoom: cam.zoom };
		const plan = shiftPlan(dx, dy, cam.zoom, at.x, at.y, this.cssWidth, this.cssHeight);
		if (plan === null) return;
		this.slideCommittedPixels(plan.shiftX, plan.shiftY, backing);
		this.lastPaintCam = at;
		for (const rect of plan.exposed) this.damage.addRect(rect);
	}

	/** Slide the committed and highlight layers by (shiftX, shiftY) css px, a whole number of backing px. */
	function slideCommittedPixels(this: InkOverlayPlugin, shiftX: number, shiftY: number, backing: number): void {
		for (const [ctx, canvas] of [[this.committedCtx, this.committedCanvas], [this.highlightCtx, this.highlightCanvas]] as const) {
			// drawImage throws on a 0x0 source; a deferred layer has nothing to carry.
			if (canvas === this.highlightCanvas && this.highlightPairDeferred) continue;
			ctx.save();
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.globalCompositeOperation = "copy";
			ctx.drawImage(canvas, Math.round(shiftX * backing), Math.round(shiftY * backing));
			ctx.restore();
		}
	}

	/**
	 * Move the band under a live stroke without moving anything the reader
	 * sees, and without a whole-world raster on the pen's own frame. The
	 * same carry serves a band move at rest (syncBand), for the same reason:
	 * the pixels are already right, only their box moved.
	 *
	 * The frozen pipeline's rule stands: the camera and the router's rect
	 * froze together at pen-down and are moved together here, by one delta.
	 * The band container slides by (dx, dy) layout px; the camera's world
	 * origin moves by the same amount, so every sample after this maps to the
	 * same world point it would have before; the router re-reads the
	 * container's rect once, so the client point the pen reports is measured
	 * against the box where it now is. Ink already painted on the five
	 * canvases is slid by the opposite amount, a WHOLE number of device px
	 * (the delta is snapped to the backing grid first), so it is pixel-exact,
	 * not resampled. The strips the move uncovers are the only committed work
	 * left, and they go through the ordinary partial-repaint path; the last
	 * painted camera is advanced so repaint() does not read the shift as a
	 * camera move and re-raster the world mid-contact.
	 *
	 * Wet ink that was never painted because it lay past the old edge is not
	 * recovered here; the commit redraws the stroke from its world points.
	 */
	function carryBandUnderLock(this: InkOverlayPlugin, want: Band): "none" | "moved" {
		const current = this.band!, container = this.container;
		if (!container) return "none";
		const backing = this.committedBacking ?? this.backingNow();
		if (!(backing > 0) || !Number.isFinite(backing)) { this.bandSyncDeferred = true; return "none"; }
		// Snap to the backing grid: an integer device-px blit is exact.
		const dx = Math.round((want.left - current.left) * backing) / backing;
		const dy = Math.round((want.top - current.top) * backing) / backing;
		if (dx === 0 && dy === 0) { this.bandSyncDeferred = true; return "none"; }
		const cam = this.camera.snapshot;
		// UNITS. The band and the blit are layout px; the camera is note units
		// with the font zoom as its zoom (syncCamera divides the band offset by
		// fontZoom before setState). A layout delta enters the camera divided
		// by the same factor, and shiftPlan multiplies it back out for the
		// css-px blit, so the two agree at every font size and not only at 1.
		const f = Number.isFinite(this.fontZoom) && this.fontZoom > 0 ? this.fontZoom : 1;
		const camX = cam.x + dx / f, camY = cam.y + dy / f;
		const plan = shiftPlan(dx / f, dy / f, cam.zoom, camX, camY, this.cssWidth, this.cssHeight);
		if (plan === null) { this.bandSyncDeferred = true; return "none"; }
		this.band = { left: current.left + dx, top: current.top + dy, width: current.width, height: current.height };
		container.setCssStyles(this.bandPlacement(this.band.left, this.band.top));
		this.camera.setState(camX, camY, cam.zoom);
		this.slideCommittedPixels(plan.shiftX, plan.shiftY, backing);
		this.wet.carry(plan.shiftX, plan.shiftY);
		if (!this.highlightPairDeferred) this.highlightWet.carry(plan.shiftX, plan.shiftY);
		this.tail.carry(plan.shiftX, plan.shiftY);
		// Prediction history is in the same canvas px as the tail it drew. Left
		// behind, the next guess extrapolated from points one carry away and
		// the tail vanished or pointed the wrong way. New objects: the samples
		// may be shared with the stroke being built.
		const carried = (s: PenSample): PenSample => ({ ...s, x: s.x + plan.shiftX, y: s.y + plan.shiftY });
		this.predReal = this.predReal.map(carried);
		this.predLastTail = this.predLastTail.map(carried);
		// The pixels moved with the camera: the next repaint owes only the
		// uncovered strips, not the world. The record is the camera the slid
		// pixels sit at - the painted one plus the shift - which can sit inside
		// the sub-pixel bar of the camera held; recording the held one instead
		// would let that gap stack up across carries.
		const base = this.lastPaintCam ?? cam;
		this.lastPaintCam = { x: base.x + dx / f, y: base.y + dy / f, zoom: cam.zoom };
		for (const rect of plan.exposed) this.damage.addRect(rect);
		this.router?.refreshRect();
		this.bandSyncDeferred = false;
		return "moved";
	}

	// ---- surface extent -----------------------------------------------------
	//
	// Reconstructed from the 2026-08-20 deployed hardware build (its source
	// was lost with the session container). The note surface must be
	// SCROLLABLE wherever ink lives, including below the last line and right
	// of the content column: an invisible 1×1 spacer inside the scroller,
	// positioned at (note origin + granted extent) in scroller-content
	// coordinates, extends scrollWidth/scrollHeight so native scrolling
	// (finger, touchpad, scrollbar) reaches all of it. Obsidian ships the
	// scroller with `overflow-x: hidden`, so the axis guard flips exactly
	// that property to `auto` while ink needs it.
	//
	// This is the one piece of Handwriting that changes what SCROLLING itself can
	// do, and wheel input (the touchpad pipeline) can pan a scrollable x-axis
	// that an axis-locked touch drag never touches. That made it the first
	// suspect in the 2026-08 touchpad dead-zone investigation, which is why
	// every mutation here is traced.

	function updateExtent(this: InkOverlayPlugin, force = false, navigation?: { left: number; top: number }): void {
		if (this.deferPinchRaster()) return;
		if (!this.container || this.frame.locked) return;
		const path = this.filePath();
		if (!path) return;
		// Repaint ends here, so this runs on every scrolled frame. Nothing
		// below can grant a different extent while the ink frontier and the
		// camera/zoom/viewport inputs all stand still, and everything below
		// forces layout - two getBoundingClientRect, the origin, the spacer
		// position. Skip it. Gesture ends pass force and never skip. §5g/G1.
		const cam = this.camera.snapshot;
		// Written-on: ink present, or the pen has been seen this session (the
		// same predicate the strip uses, InkOverlay.ts:1270 - PenToolsMode's
		// flag can flip true on pen contact alone, before any stroke exists).
		// Carried as its own ExtentInputs field, not folded into `frontier`:
		// that flip changes no stroke count, so `frontier` would stay the same
		// object and the G1 skip guard below would hold the pre-contact extent
		// for a whole gesture (1.4.6 §5n).
		const writtenOn = inlineInk.strokes(path).length > 0 || penSeenThisSession();
		const scroller = this.view.scrollDOM;
		const expansion = this.scrollExpansion ?? (this.canvasMode ? (this.scrollExpansion = new ScrollExpansionDemand()) : null);
		const scrollRevision = expansion?.sample(path, this.canvasMode, scroller.scrollLeft, scroller.scrollTop) ?? 0;
		const inputs: ExtentInputs = {
			scrollRevision,
			granted: surfaceExtents.get(path),
			path,
			frontier: (() => { const f = this.frontierCache.get(path, this.noteStrokes(path)); this.pageInkX = f.x; return f; })(),
			writtenOn,
			camX: cam.x,
			camY: cam.y,
			camZoom: cam.zoom,
			fontZoom: this.fontZoom,
			pinchScale: this.pinchScaleNow,
			cssScale: this.cssScale,
			cssWidth: this.cssWidth,
			cssHeight: this.cssHeight,
		};
		if (!force && sameExtentInputs(this.lastExtentInputs, inputs)) return;
		this.lastExtentInputs = inputs;
		// FIRST OF TWO: the ladder must cover the surface that already
		// exists, not only the one the spacer invents. A long note with Infinite
		// Canvas off never reaches the spacer branch below at all, and its own
		// scroll height is the whole distance the anchor has to span. This is
		// past the skip above, so it is not on the scroll path, and the method
		// has already forced layout for its own reads.
		growDocumentAnchorLadder(this.view, scroller.scrollHeight);
		// The origin is needed BEFORE growing now: the zoom frontier is
		// origin-relative, and it joins the ink frontier in one grow so a
		// magnified note's overhang is scrollable (see zoomFrontier).
		const contentRect = this.view.contentDOM.getBoundingClientRect();
		const preRect = scroller.getBoundingClientRect();
		const origin = surfaceOriginInScroller({
			contentLeftVisual: this.columnLeft(),
			documentTopVisual: this.documentTopUnpanned(),
			scrollRectLeft: preRect.left,
			scrollRectTop: preRect.top,
			scrollLeft: scroller.scrollLeft,
			scrollTop: scroller.scrollTop,
			scale: this.cssScale,
		});
		// Room left of the column first: it moves the origin in the scroller's
		// content px, and everything below is placed from the origin. Held under
		// a pinch zoom too: the owned layout lasts until a file switch or an
		// unmount, so a reserve lifted for it would be gone for the note's life.
		const reserveDelta = this.holdLeftReserve(path, origin);
		// The paper's phase follows this origin: read here, where the extent has
		// already paid for the layout, and never on a preview frame.
		this.capturePaperOrigin(origin.top, origin.left);
		const ink = inputs.frontier;
		// Shared with writeFrontier below - both need the same document-bottom
		// number and neither may re-read layout to get it.
		// Content extent is unpanned, just like the origin above. Including
		// residual pan here makes settling change its own native scroll range.
		const contentBottom = (contentRect.bottom - this.panY() - preRect.top) / this.cssScale + scroller.scrollTop;
		const zoom = this.viewportLayout ? ZERO_EXTENT : zoomFrontier({
			clientWidth: scroller.clientWidth,
			clientHeight: scroller.clientHeight,
			contentBottom,
			origin,
			pinchScale: this.pinchScaleNow,
			fontZoom: this.fontZoom,
		});
		// Room to write at the top of the screen (1.4.6 §5n): granted while the
		// surface is being written on, and while the note viewport is zoomed
		// out, which is a handwriting act of its own. A typing-only note at 1.0
		// keeps a byte-identical extent.
		const write = writeFrontierApplies(inputs)
			? writeFrontier({
					// WHICH VIEWPORT the 0.75 is a fraction OF. Zoomed out, the
					// scroller is counter-sized and CSS-scaled back down, so the
					// takeover pane height is a TENTH of a screenful at 0.1 - the
					// grant it buys is ~60 visual px, which is the same "nothing
					// below the text" the frontier is here to fix. Below 1.0 the
					// screenful IS the scroller's client box, so measure against
					// that; written-on notes have the same need and take the same
					// term. At and above 1.0 the term is unchanged, so zoom-in and
					// 100% stay byte-identical.
					clientHeight: inputs.pinchScale < 1 ? scroller.clientHeight : (this.viewportLayout?.height ?? scroller.clientHeight),
					contentBottom,
					origin,
					fontZoom: this.fontZoom,
				})
			: ZERO_EXTENT;
		const scroll = this.canvasMode && expansion ? expansion.reserve({
			left: scroller.scrollLeft, top: scroller.scrollTop,
			nativeWidth: scroller.clientWidth, nativeHeight: scroller.clientHeight,
			width: scroller.clientWidth,
			height: scroller.clientHeight,
			edgeX: scroller.scrollWidth, edgeY: scroller.scrollHeight,
			origin, fontZoom: this.fontZoom, pinchScale: this.pinchScaleNow,
		}, navigation) : ZERO_EXTENT;
		// Sideways room is the ink's to ask for only when it reaches past the pane,
		// unless Infinite Canvas is on (inkClaimX).
		const inkX = inkClaimX({
			frontierX: ink.x,
			originLeft: origin.left,
			clientWidth: scroller.clientWidth,
			fontZoom: this.fontZoom,
			infiniteCanvas: this.canvasMode,
		});
		const grown = surfaceExtents.grow(path, {
			x: Math.max(inkX, zoom.x, scroll.x),
			y: Math.max(ink.y, zoom.y, write.y, scroll.y),
		});
		const granted = this.shrinkSideways(path, ink, grown, Math.max(inkX, zoom.x), origin.left, scroller, force);
		if (!this.spacer && granted.x === 0 && granted.y === 0 && !(this.leftReserveHeld > 0)) return;
		if (!this.spacer) {
			if (this.winRef.getComputedStyle(scroller).position === "static") {
				scroller.setCssStyles({ position: "relative" });
				this.scrollPositionPatched = true;
			}
			this.spacer = scroller.createDiv({ cls: "handwriting-surface-extent" });
			this.spacer.setCssStyles({
				position: "absolute",
				width: "1px",
				height: "1px",
				visibility: "hidden",
				pointerEvents: "none",
			});
			scrollProbeExtent("spacer created");
		}
		// The origin computed above, and the granted extent (note px)
		// converted with the font zoom, so the scroll range tracks the
		// ink's rendered size.
		const atGrant = spacerPosition(origin, {
			x: granted.x * this.fontZoom,
			y: granted.y * this.fontZoom,
		});
		// A reserve needs a full view of range past it, or the scroll that pays for
		// it is clamped and the column moves. The view is the scroller's OUTER
		// width: with its x overflow hidden the engine stops the scroll short of the
		// range by the vertical scrollbar's gutter (measured: scrollLeft 218 asked,
		// 203 given, scrollWidth 723, clientWidth 505, offsetWidth 520). The cost,
		// stated: where the x overflow scrolls, the range while a reserve is held
		// reaches up to one gutter further right than the view needs. That room is
		// right of the page, never blank left of the ink.
		const pos = this.leftReserveHeld > 0
			? { left: Math.max(atGrant.left, Math.ceil(this.leftReserveHeld + Math.max(scroller.clientWidth, scroller.offsetWidth || 0)) - 1), top: atGrant.top }
			: atGrant;
		expansion?.applied(pos.left + 1, pos.top + 1);
		let moved = false;
		if (pos.left !== this.spacerLeft) {
			this.spacerLeft = pos.left;
			this.spacer.setCssStyles({ left: `${pos.left}px` });
			moved = true;
		}
		if (pos.top !== this.spacerTop) {
			this.spacerTop = pos.top;
			this.spacer.setCssStyles({ top: `${pos.top}px` });
			moved = true;
		}
		if (moved) scrollProbeExtent(`spacer -> (${pos.left},${pos.top})`);
		// The reserve's scroll, now that the range holds it: the column comes back
		// to where it was on screen in the same pass that shifted it.
		if (reserveDelta !== 0) {
			scroller.scrollLeft = Math.max(0, scroller.scrollLeft + reserveDelta);
			expansion?.rebase(scroller.scrollLeft, scroller.scrollTop, true);
			scrollProbeExtent(`left reserve ${this.leftReserveHeld} (moved ${reserveDelta})`);
		}
		// The grant is one of the box's two size terms, so it follows the spacer - only when the spacer moved,
		// which is not a scrolled frame.
		if (moved) this.syncGridPaperBox();
		// The grant shrank since this editor's last pass, here or in another pane
		// showing the note. Not on first sight of a note: a note switch is not a shrink.
		const shrinks = surfaceExtents.shrinkCount(path), shrinksSeen = this.shrinksSeen.get(path);
		this.shrinksSeen.set(path, shrinks);
		// AND AFTER A SCALE COMMIT, whether or not the grant moved: the band's margin is sized for the viewport it was
		// pinned in, so a zoom-out pins it for the counter-sized one and the settle back used to leave that margin holding
		// range nothing had granted (measured on a blank note, 100 -> 25 -> 100: 200 px of it, with the grant 0 throughout).
		const releaseAfterCommit = this.bandMarginReleasePending;
		this.bandMarginReleasePending = false;
		if ((shrinksSeen !== undefined && shrinks !== shrinksSeen) || releaseAfterCommit) this.releaseBandMargin(scroller, pos.left + 1);
		// SECOND OF TWO: the spacer's own demand, which can exceed the
		// scroll height the browser has applied so far. Growth is monotonic and
		// idempotent, so the two calls cannot fight; between them the ladder
		// covers whichever of the two surfaces is longer, and it never reaches
		// past the surface that exists.
		//
		// HERE AND NOWHERE ELSE (with the call above): this frame is already a
		// write moment and has already forced layout, so the one childList
		// mutation costs the CodeMirror measure that any mutation costs on a
		// frame that was doing that work anyway - instead of putting a measure
		// on the scroll path, which is what the design ruled out.
		growDocumentAnchorLadder(this.view, pos.top);
		scroller.classList.toggle("handwriting-hscroll", granted.x > 0 || this.leftReserveHeld > 0);
		// AFTER the class rather than twenty-one lines before it. ORDER IS NOT THE
		// MECHANISM, and saying so was wrong: measured on read, `handwriting-hscroll`
		// styles only the horizontal scrollbar (styles.css:2198-2211); the property
		// the guard reads is changed by `handwriting-hscroll-axis`, which the guard
		// itself adds. So the pre-class read saw the same `overflow-x` the post-class
		// read sees, and moving the call cannot by itself have fixed anything. It is
		// kept because reading the state a pass established, in that pass, is the
		// honest order - not because it was the defect.
		//
		// THE DEFECT IS THE LATCH BELOW, and that one is on the read: the check
		// marked itself done without a verdict, so a pass with nothing to open
		// spent the only attempt the note ever got. The
		// axis then stayed shut for the life of the note, and the only things
		// that re-arm it are teardown and handleResize's reallocation, which is
		// exactly why toggling the setting off and on was the cure and nothing
		// else was (alan: "i cannot scroll to the right because i havent toggled
		// infinite canvas off and then on").
		//
		// Left ink only, which is what made it look arbitrary: the surface never
		// goes negative, so ink to the RIGHT is reachable without granting an x
		// extent at all and never needs the axis. A stroke left of the column is
		// the one case that does.
		this.ensureScrollableAxis(scroller);
		if (moved || !this.lastReach) this.measureReach(scroller, pos.left + 1);
	}

	/**
	 * The x grant comes back down to what the ink and the zoom still need, when
	 * one is due: ink was removed (erase, lasso delete, Delete all ink, an undo),
	 * noticed here as the frontier getting smaller, which writing never does, so
	 * the chunked growth that keeps a scrollbar from pumping per stroke is
	 * untouched; or Infinite Canvas was turned off (setScrollExpansionEnabled),
	 * which takes back the room scrolling had demanded.
	 *
	 * Never under what is on screen: not in this editor, and not in any other
	 * editor showing the note, since the grant is the note's and every pane's
	 * spacer follows it. The part off to the right of every view goes now; the
	 * rest stays due until the views move left or a later pass finds it clear.
	 * The vertical grant is not touched. While Infinite Canvas is on nothing
	 * shrinks: the grant holds room scrolling demanded, which no frontier knows.
	 *
	 * WHEN. A shrink takes its first step at the pass that made it due, which
	 * follows the removal or the setting. What a view held back steps again only
	 * at the end of a gesture: a forced pass (a pen, pan, space or pinch
	 * settle), or once a scroll has been quiet for SHRINK_SCROLL_IDLE_MS. Never
	 * on a scrolled frame, so a scroll in progress never has its range move.
	 */
	function shrinkSideways(this: InkOverlayPlugin, path: string, ink: Extent, granted: Extent, neededX: number, originLeft: number, scroller: HTMLElement, force: boolean): Extent {
		const seen = this.extentFrontierSeen.get(path);
		if (seen !== undefined && ink.x < seen) surfaceExtents.oweShrinkX(path);
		this.extentFrontierSeen.set(path, ink.x);
		this.sidewaysView = { path, scrollLeft: scroller.scrollLeft, clientWidth: scroller.clientWidth, originLeft, fontZoom: this.fontZoom };
		const due = surfaceExtents.shrinkDue(path);
		if (due === undefined) return granted;
		if (this.canvasMode) {
			surfaceExtents.settleShrinkX(path);
			return granted;
		}
		if (this.shrinkStepped.get(path) === due && !force) return granted;
		this.shrinkStepped.set(path, due);
		let floor = 0;
		for (const p of instances) {
			const view = p.sidewaysView;
			if (view && view.path === path) floor = Math.max(floor, onScreenFloorX(view));
		}
		const shrunk = shrunkAxis(granted.x, neededX, floor);
		if (shrunk.complete) surfaceExtents.settleShrinkX(path);
		if (shrunk.value === granted.x) return granted;
		scrollProbeExtent(`x grant ${granted.x} -> ${shrunk.value}${shrunk.complete ? "" : " (held by a view)"}`);
		const next = surfaceExtents.shrinkX(path, shrunk.value);
		// Every other pane showing the note moves its spacer to the new grant.
		for (const p of instances) if (p !== this && p.filePath() === path) p.scheduleRepaint("extent-shrink");
		return next;
	}

	/** Take a held shrink's next step once the scroll has been quiet a moment; re-armed by every scroll event. */
	function shrinkWhenScrollIsQuiet(this: InkOverlayPlugin): void {
		if (this.shrinkIdleTimer !== null) this.winRef.clearTimeout(this.shrinkIdleTimer);
		this.shrinkIdleTimer = this.winRef.setTimeout(() => {
			this.shrinkIdleTimer = null;
			const path = this.filePath();
			if (this.view?.dom?.isConnected && path && surfaceExtents.owesShrinkX(path)) this.updateExtent(true);
		}, SHRINK_SCROLL_IDLE_MS);
	}

	/**
	 * THE BAND'S POSITION ON THE CONTAINER: whole px in left and top, the fraction in a translate. The band sits on the
	 * backing grid (syncBand), so its left and top carry quarter and half px. Under the transform form the compositor
	 * places the container at a whole px of the scaled host's own space and drops that fraction, and the host's scale
	 * and the device ratio multiply it: measured 0.25 host-local px, the painted ink up to 1.9 device px right of
	 * where its own rect says at k 2 under an external 0.8. A translate keeps its fraction. The getBoundingClientRect the input reads includes the translate,
	 * so the pen maps exactly as before. The only writer of the container's transform, and it writes one on every band
	 * write, translate(0px, 0px) when the band is whole, so the container's stacking context does not come and go.
	 */
	function bandPlacement(this: InkOverlayPlugin, left: number, top: number): { left: string; top: string; transform: string } {
		const l = Math.floor(left), t = Math.floor(top);
		return { left: `${l}px`, top: `${t}px`, transform: `translate(${left - l}px, ${top - t}px)` };
	}

	/**
	 * The band is an absolutely positioned child of the scroller too, and while
	 * the range was wider it took a sideways margin (bandFor) reaching past where
	 * the spacer now stands. After a shrink that margin alone holds the range at
	 * the band's right edge, and every band sync reads back the range it is
	 * holding up and keeps it: measured, a note scrolled home after its far ink
	 * was deleted kept a margin's width of sideways scroll for good. So measure
	 * the range once without the band's margin and let the next sync place the
	 * band against that. Only on the first pass after the note's grant shrank,
	 * never on a scroll.
	 *
	 * NOT FOR ANY OTHER SPACER MOVE. A spacer that moved left for another reason
	 * is left to the band, as before: on the note-switch lifecycle cell in
	 * ScrollColumnAnchorPinch (10 percent) a switch moved the spacer's right edge
	 * to 342 px against a 1383 px view, a release there re-pinned the band to the
	 * view's own width, and the band stopped covering the pane.
	 *
	 * And never when the range without the band would end short of the view,
	 * which layout would answer by clamping scrollLeft. A shrink never does that
	 * (onScreenFloorX); this is the guard that it stays so.
	 *
	 * The band is slid left, not hidden, so its right edge meets the spacer while
	 * its size and top stay put: the range read is everything else's, and the
	 * vertical range, which the band's bottom can touch, is not disturbed.
	 */
	function releaseBandMargin(this: InkOverlayPlugin, scroller: HTMLElement, spacerRight: number): void {
		const band = this.band, container = this.container;
		if (!band || !container || band.left + band.width <= Math.max(scroller.clientWidth, spacerRight)) return;
		if (Math.max(scroller.clientWidth, spacerRight) < scroller.scrollLeft + scroller.clientWidth) return;
		container.setCssStyles(this.bandPlacement(spacerRight - band.width, band.top));
		const free = scroller.scrollWidth;
		container.setCssStyles(this.bandPlacement(band.left, band.top));
		this.bandFreeScrollWidth = free;
		scrollProbeExtent(`band margin released: range without the band ${free}`);
		this.scheduleRepaint("extent-shrink");
	}

	/**
	 * The vertical twin of releaseBandMargin. Near the end of a note bandFor puts the band's bottom on the
	 * scroller's reported height, and the band is an absolutely positioned child of the scroller, so that height
	 * already counts the band: after the note shrinks the scroller keeps reporting the old height, the band asks
	 * for the old bottom again, and the blank room below the last line never goes (audit 178).
	 *
	 * So when CodeMirror's content height has dropped since the last sync AND the band's bottom is what holds
	 * the scroll's end, the band is slid wholly above the scroll origin for one read of scrollHeight and put back.
	 * Returns that band-free height when it is shorter than the band's bottom, else null.
	 *
	 * COST. The gate is a compare against a number CodeMirror already holds, so a scroll frame on an unchanged
	 * note adds no layout read. Only a shrink with the band at the end pays one forced layout.
	 */
	function measureBandFreeHeight(this: InkOverlayPlugin, scroller: HTMLElement, reported: number): number | null {
		const contentHeight = this.view.contentHeight;
		const seen = this.bandContentHeight;
		this.bandContentHeight = contentHeight;
		// `typeof`, not `!== null`: a unit rig built with Object.create never runs the initialiser.
		if (typeof seen !== "number" || !(contentHeight < seen)) return null;
		const band = this.band, container = this.container;
		if (!band || !container || band.top + band.height < reported - 1) return null;
		// Both writes through bandPlacement: a raw top keeps the last band write's translate and puts the box at the
		// top plus that fraction a second time until the next band write.
		container.setCssStyles(this.bandPlacement(band.left, -band.height));
		const free = scroller.scrollHeight;
		container.setCssStyles(this.bandPlacement(band.left, band.top));
		scrollProbeExtent(`band bottom released: height without the band ${free}`);
		return free < band.top + band.height ? free : null;
	}

	/**
	 * Hold exactly the room ink left of the origin needs beside the column, at
	 * rest and unzoomed: measured against the margin the column has without it,
	 * so a pane that widens stops holding any and one that narrows holds the
	 * shortfall. Shifts the pan carrier and moves `origin` with it; returns the
	 * change, which the caller scrolls by once the range can hold it.
	 */
	function holdLeftReserve(this: InkOverlayPlugin, path: string, origin: { left: number; top: number }): number {
		const sizer = this.panSizer();
		const reach = this.frontierCache.leftReach(path, this.noteStrokes(path));
		// `> 0`, not the field alone: a unit rig built with Object.create never runs the initialiser.
		const held = this.leftReserveHeld > 0 ? this.leftReserveHeld : 0;
		const want = sizer ? leftReserve({ reachNote: reach, naturalMargin: origin.left - held, fontZoom: this.fontZoom }) : 0;
		const delta = want - held;
		if (delta === 0) return 0;
		if (sizer) {
			if (want > 0) sizer.style.setProperty("translate", `${want}px`);
			else if (sizer.style.getPropertyValue("translate") === `${held}px`) sizer.style.removeProperty("translate");
		}
		this.leftReserveHeld = want;
		origin.left += delta;
		// Under a pinch zoom the frozen column is painted where it was measured
		// plus the new shift; its margin does not move.
		const layout = this.viewportLayout;
		if (layout && layout.columnLocal !== null) {
			layout.columnLocal += delta;
			layout.columnReserve = want;
		}
		return delta;
	}

	/** Teardown: the carrier's shift comes off and the scroll that paid for it with it. */
	function dropLeftReserve(this: InkOverlayPlugin): void {
		const held = this.leftReserveHeld;
		if (!(held > 0)) return;
		this.leftReserveHeld = 0;
		const sizer = this.panSizer();
		if (sizer && sizer.style.getPropertyValue("translate") === `${held}px`) sizer.style.removeProperty("translate");
		const scroller = this.view.scrollDOM;
		scroller.scrollLeft = Math.max(0, scroller.scrollLeft - held);
	}

	function ensureScrollableAxis(this: InkOverlayPlugin, scroller: HTMLElement): void {
		if (this.axisChecked || this.axisGuard.patched) return;
		// LATCHED ONLY ON A VERDICT. Setting this before knowing the outcome spent
		// the single check on a pass that had nothing to open, and no later pass
		// could try again. The guard is idempotent - `assert` returns immediately
		// once `patched` - so leaving it unlatched costs one early-out per extent
		// pass and buys back every retry.
		const overflowX = this.winRef.getComputedStyle(scroller).overflowX;
		this.axisGuard.assert(scroller, overflowX);
		if (this.axisGuard.patched) {
			this.axisChecked = true;
			scrollProbeExtent(`axis guard: overflow-x "${overflowX}" -> auto`);
		}
	}

	function restoreScrollableAxis(this: InkOverlayPlugin): void {
		this.axisGuard.restore(this.view.scrollDOM);
	}

	function measureReach(this: InkOverlayPlugin, scroller: HTMLElement, required: number): void {
		this.lastReach = {
			required,
			scrollWidth: scroller.scrollWidth,
			clientWidth: scroller.clientWidth,
			overflowX: this.winRef.getComputedStyle(scroller).overflowX,
			patched: this.axisGuard.patched,
		};
	}

export function installBand(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		syncBand,
		carryBakedPan,
		slideCommittedPixels,
		carryBandUnderLock,
		updateExtent,
		shrinkSideways,
		shrinkWhenScrollIsQuiet,
		bandPlacement,
		releaseBandMargin,
		measureBandFreeHeight,
		holdLeftReserve,
		dropLeftReserve,
		ensureScrollableAxis,
		restoreScrollableAxis,
		measureReach,
	});
}
