/**
 * The note surface's paper and pinch preview methods: the preview paper box,
 * the grid paper box, the paper's pan and spacing, the pinch constraint and
 * its give, and the pinch layers. They are methods of InkOverlayPlugin,
 * installed on its prototype when InkOverlay.ts loads. The pinch gesture
 * itself and the paper and layer members a plain ink stroke calls stay in the
 * class.
 */
import type { BBox, InkStroke } from "../ink/Stroke";
import type { HeldTile } from "./InkOverlayAttachedLayer";
import { installMethods } from "./InstallMethods";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { MAX_VIEWPORT_LAYOUT } from "./PinchScale";
import { validCameraScale } from "./ZoomScale";
import { surfaceExtents } from "./SurfaceExtent";
import { paperPlan, type PaperPlan } from "./PaperPlan";
import { copyPreviewPaperBackground, foldIntoPitch, fractionOf, previewPaperCopyable, previewPaperPhase, previewPaperPitch, type PreviewPaperEnd, type PreviewPaperSource } from "./PaperPan";
import { scrollProbeExtent } from "./ScrollProbe";
import { pageGuidePitch } from "./PageGuides";

/** The guides' box, and its own class while a preview lives (styles.css blanks it under that class). */
const PAGE_GUIDES_CLASS = "handwriting-page-guides";
const PAGE_GUIDES_PREVIEWING = "handwriting-page-guides-previewing";
import { PAN_MIN_VISIBLE_PX, PAN_FIT_SLACK_PX, OVERSCROLL_BOUNCE_MS, PAPER_PROPERTIES, committedFloorFor, inkLookKey, inlineInk, type RasterCamera, standInFactorFits, type InkOverlayPlugin } from "./InkOverlay";
import { HIGHLIGHTER_ALPHA } from "../ink/PenStyle";

/**
 * The extent raster, or the stand-in, shown through a zoom preview: its own pen and highlighter canvases in one
 * element right after the scroller. `scroll` is the scroller's scroll at put-up (a preview writes none); the inner box takes the
 * band's place in the scroller's padding box less that scroll, plus the ink layer's own translate, each frame. `box` is the committed canvas's style the raster's canvases were
 * sized from, so a change of host form (placeCanvasLayers) is followed by style writes alone. `src` is the picture's canvases; `f` is
 * its CSS size against the committed canvas's per device px (1 for the extent raster, start zoom over the stand-in's zoom for it).
 * `rasterScale` is the scale the gesture started from (pinchAnchor.fromScale), the one the committed layer was painted at: a preview
 * that ends there paints no whole layer. NaN when no anchor was live. `shownMoves` is the picture's own (equal to the overlay's at
 * put-up): a later shown move leaves its strokes at the old places, and writeHeldRaster takes it down. `penTiles` and `hlTiles` are the
 * attached layer's sprite tiles put up beside the picture (heldTiles), the highlight ones in `hlWrap` at the highlighter's alpha.
 */
interface HeldRaster {
	src: { pen: HTMLCanvasElement; hl: HTMLCanvasElement | null };
	f: number;
	path: string;
	count: number;
	generation: number;
	shownMoves: number;
	inner: HTMLElement;
	scroll: { x: number; y: number };
	offX: number;
	offY: number;
	rasterScale: number;
	box: string;
	transform: string;
	hidden: [HTMLCanvasElement, string][];
	penTiles: HeldTile[];
	hlTiles: HeldTile[];
	hlWrap: HTMLElement | null;
}

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		refreshPinchConstraint(columnLocal: number | null, contentTopLocal: number | null): void;
		reducePinchConstraint(next: number, settling: boolean): void;
		hideBlankPinchLayers(): void;
		preparePinchComposite(): boolean;
		armPinchLayerRestore(): void;
		writePaperPan(): void;
		beginPreviewPaper(): void;
		writeGridBoxPan(ax: string): void;
		traceSettlePaper(stage: string): void;
		traceSettlePaperFrames(): void;
		watchPaperKind(): void;
		syncGridPaperBox(): void;
		removeGridPaperBox(): void;
		syncPageGuideBox(): void;
		removePageGuideBox(): void;
		markPageGuidesPreview(on: boolean): void;
		stopPaperKindWatch(): void;
		clearScrollerPan(scroller: HTMLElement): void;
		gridBoxPaperStyle(pitch: number): PreviewPaperSource | null;
		measurePreviewPaperBox(deferPaper?: boolean): void;
		movePreviewPaper(x: number, y: number): void;
		rebasePreviewPaper(): void;
		previewPaperReadout(): { present: boolean; held: boolean; swaps: number; ended: PreviewPaperEnd | null; pitch: number; inset: string; transform: string };
		startPinchGive(from: number, to: number, centroid: { x: number; y: number }): void;
		pinchGiveStep(give: NonNullable<InkOverlayPlugin["pinchGive"]>): void;
		pausePinchGive(): void;
		resumePinchGive(): void;
		pinchGiveFrame(scale: number, give: NonNullable<InkOverlayPlugin["pinchGive"]>): void;
		finishPinchGive(): void;
		updatePaperSpacing(): void;
		writePaperVars(plan: PaperPlan): boolean;
		clearOwnPaperVars(): void;
		heldRaster?: HeldRaster | null;
		heldRasterClip?: HTMLElement | null;
		heldRasterHlWrap?: HTMLElement | null;
		putUpHeldRaster(clipOnly?: boolean): void;
		heldRasterSource(path: string, cam: RasterCamera, strokes: readonly InkStroke[]): { src: HeldRaster["src"]; f: number; offX: number; offY: number; count: number; generation: number; shownMoves: number; world: BBox; clip: boolean } | null;
		placeHeldRasterCanvases(h: HeldRaster): void;
		writeHeldRaster(x: number, y: number): void;
		landHeldRaster(deferred: boolean): void;
		takeDownHeldRaster(): void;
	}
}

	/** Snapshot only at existing geometry reads, never for each pointer event. */
	function refreshPinchConstraint(this: InkOverlayPlugin, columnLocal: number | null, contentTopLocal: number | null): void {
		const constraint = this.pinchAnchor?.constraint, layout = this.viewportLayout, origin = this.previewHostOrigin;
		if (!constraint) return;
		constraint.geometry = null;
		if (!layout || !origin?.valid || !this.panSizer()) return;
		const path = this.filePath(), extent = path ? surfaceExtents.get(path) : { x: 0, y: 0 };
		const width = Math.max(layout.columnBox, extent.x * this.fontZoom);
		const height = Math.max(this.view.contentHeight, extent.y * this.fontZoom);
		const scrollLeft = this.view.scrollDOM.scrollLeft, scrollTop = this.view.scrollDOM.scrollTop;
		// THE SCROLL THE COLUMN WAS MEASURED UNDER, ACROSS: the whole scroll plus the residual the host transform carries. The
		// column is measured under that transform, so adding back the whole scroll alone left the residual inside the inset,
		// and the settle landed as if the translate stayed when the commit's scroll write replaced it (1.5 px at k 5.981 for
		// a 0.28 px residual). DOWN keeps the whole scroll: measured, the text does not step by the residual on y, and adding
		// it there moved the ink off its text line by the residual's translate (WrappedTitlePinch, 0.167 note px at k 1.5).
		// `scrollLeft` below stays whole: the settle reads the live whole scroll against it.
		const residual = this.scrollResidual;
		const paintedLeft = scrollLeft + (residual && residual.left === scrollLeft ? residual.x : 0);
		const naturalLeft = columnLocal === null ? null : columnLocal + paintedLeft * layout.externalScale;
		const naturalTop = contentTopLocal === null ? null : contentTopLocal + scrollTop * layout.externalScale;
		if (![origin.left, origin.top, layout.width, layout.paneHeight, layout.gutterScreen, width, height, layout.externalScale].every(Number.isFinite) ||
			layout.width <= 0 || layout.paneHeight <= 0 || layout.gutterScreen < 0 || !validCameraScale(layout.externalScale) || width < 0 || height < 0) return;
		// PREVIEW-TOUCHING (refreshPinchConstraint, called at :5618). `layout.width` (computed style, fractional)
		// rather than `layout.paneWidth` (parent.clientWidth, integer): measured 1397.5 against the scroller's own
		// 1397.48 screen px, and paneWidth - width is 0.5 on all 2333 frames sampled. The gutter is carried
		// through MEASURED and in screen px, so the consumer subtracts it without applying a scale of its own.
		constraint.geometry = { left: origin.left, top: origin.top, paneWidth: layout.width, paneHeight: layout.paneHeight, gutterScreen: layout.gutterScreen,
			// `width` is the page OR the room Infinite Canvas has granted around it, whichever is larger. That is
			// the right quantity for an overlap bound and the wrong one for "does the page fit the pane", so the
			// page's own box travels beside it. See the fit test in `reducePinchConstraint`.
			width, pageWidth: this.pageContentWidth(), height, external: layout.externalScale, x: naturalLeft !== null && Number.isFinite(naturalLeft), naturalLeft,
			y: naturalTop !== null && Number.isFinite(naturalTop), naturalTop, scrollLeft, scrollTop };
	}

	/** Consume blocked motion in input order while leaving rendering coalesced.
	 * The measured column/content origin cancels from effective-target bounds.
	 * Offsets are painted pixels, including when a scale change hits a bound.
	 * A new snapshot reconciles the accepted target once; it cannot reconstruct
	 * unobserved intermediate layout changes. Settle receives only the final target.
	 */
	function reducePinchConstraint(this: InkOverlayPlugin, next: number, settling: boolean): void {
		const anchor = this.pinchAnchor, constraint = anchor?.constraint;
		if (!anchor || !constraint) return;
		const geometry = constraint.geometry, layout = this.viewportLayout;
		if (geometry && layout && !this.frame.locked && this.scaleGeometryValid !== false &&
			validCameraScale(next) && validCameraScale(next * geometry.external) &&
			validCameraScale(next, layout.width, layout.height) &&
			[layout.width / next, layout.height / next].every(n => Number.isFinite(n) && n >= 0 && n <= MAX_VIEWPORT_LAYOUT)) {
			const axis = (client: number, offset: number, focal: number, host: number, local: number | null,
				origin: number, pane: number, gutter: number, extent: number, measured: boolean, naturalInset?: number | null, inset = false,
				/** The PAGE's own box on this axis. Defaults to `extent`, so an axis that does not distinguish them is unchanged. */
				pageExtent = extent): number => {
				if (local === null || !measured) return offset;
				const q = (focal - host) / anchor.fromScale - local;
				// `gutter` arrives already in screen px (measured at the last settle), so it is subtracted after the
				// pane is scaled and is NOT multiplied by `next` - the defect this replaces was a scale applied to a
				// quantity that had already been measured in the target units.
				const span = pane * geometry.external - gutter;
				const visible = Math.max(0, span - PAN_MIN_VISIBLE_PX);
				const size = extent * next * geometry.external;
				const lower = this.canvasMode && naturalInset != null
					? origin + (q + naturalInset) * next - MAX_VIEWPORT_LAYOUT * next * geometry.external
					: origin + q * next + (size > 0 ? PAN_MIN_VISIBLE_PX - size : -visible);
				// The same raised edge as anchorPanTo's: a column inset that fits may be carried as far right as the pane's edge.
				//
				// ASKED OF THE PAGE, NOT OF THE ROOM BESIDE IT. With Infinite Canvas on, `size` is the granted
				// canvas, it never fits the pane, and the target was pinned to the column's natural inset on
				// every preview frame - which walks away from the fingers by exactly the displacement the scroll
				// was expected to absorb later, and no preview frame writes the scroll. Measured on the focal arm
				// zooming out from 1 to 0.25, Readable line length on: the target went 1243.31, 1086.09, 928.88,
				// 824.06 against a finger that never moved from 1348.12, and froze at 824.06 once the granted
				// extent ran out. `anchorPanTo` then had nothing to do - the note was already at the target - so
				// it wrote no pan at all and the column slid out from under the fingers, 786.09 px by the settle.
				// The SAME column with the setting off keeps target == focal on every frame and holds the point
				// to 0.00 px. The page fits the pane in both; only the blank beside it differs.
				const pageSize = pageExtent * next * geometry.external;
				const fits = inset && naturalInset != null && pageSize > 0 && pageSize <= span + PAN_FIT_SLACK_PX;
				// NO WIDTH TEST, AND NO INSET PIN, WHILE THE FINGERS ARE DOWN. A preview frame's one job is
				// to keep the note under them; bounds belong at the settle, which knows the true width and
				// can ease to it. This clamp WAS the Family C defect at its source: pinned to the column's
				// natural inset, the target walked away from the finger by exactly the displacement the
				// scroll was expected to absorb later - measured 1243.31, 1086.09, 928.88, 824.06 against a
				// finger that never moved from 1348.12 - and no preview frame writes the scroll. A live
				// frame is now held only by what keeps the note visible.
				// AND NO SETTLE CLAMP UNDER INFINITE CANVAS EITHER: there the settle's target IS where
				// the fingers left it, so clamping the target to the column's natural inset moves the page
				// exactly as the preview clamp used to. Measured with this clamp still applied at the
				// settle: the preview held the note to 0 on every frame, then `anchorPanTo` was handed a
				// pan of 907.69 and computed a wanted pan of -0.00, because the note was already sitting
				// on the clamped target - so it dropped the whole hold and the page jumped 907.69 px. The
				// pan was never refused; the target had already moved.
				const upper = origin + q * next + (!settling || this.canvasMode || naturalInset == null ? visible
					: fits ? Math.max(naturalInset * next, span - pageSize) : naturalInset * next);
				const requested = client + offset;
				if (![lower, upper, requested].every(Number.isFinite)) return offset;
				// Natural left/top origins win if a tiny note cannot supply the
				// minimum opposite-edge overlap.
				// Consume rejected movement even when the accepted position is unchanged.
				const accepted = naturalInset == null ? Math.max(lower, Math.min(upper, requested)) : Math.min(upper, Math.max(lower, requested));
				return accepted === requested ? offset : accepted - client;
			};
			constraint.offsetX = axis(constraint.clientX, constraint.offsetX, anchor.focalX, anchor.hostLeft, anchor.columnLocal,
				geometry.left, geometry.paneWidth, geometry.gutterScreen, geometry.width, geometry.x, geometry.naturalLeft, layout.columnInset, geometry.pageWidth);
			constraint.offsetY = axis(constraint.clientY, constraint.offsetY, anchor.focalY, anchor.hostTop, anchor.contentTopLocal,
				geometry.top, geometry.paneHeight, 0, geometry.height, geometry.y, geometry.naturalTop);
		}
		anchor.targetX = constraint.clientX + constraint.offsetX;
		anchor.targetY = constraint.clientY + constraint.offsetY;
	}

	function hideBlankPinchLayers(this: InkOverlayPlugin): void {
		this.restorePinchLayers();
		if (this.preparePinchComposite()) return;
		const layers: [HTMLCanvasElement | undefined, boolean | undefined][] = [
			[this.committedCanvas, this.committedBlank], [this.highlightCanvas, this.highlightBlank],
			[this.attachedLayer?.pen, this.attachedLayer?.penBlank], [this.attachedLayer?.hl, this.attachedLayer?.hlBlank],
			[this.wetCanvas, this.wet?.provenBlank], [this.highlightWetCanvas, this.highlightWet?.provenBlank],
			[this.tailCanvas, this.tail?.provenBlank], [this.wetTileCanvas, this.wet?.provenBlank],
		];
		for (const [canvas, blank] of layers) if (blank && canvas?.style && canvas.style.visibility !== "hidden") {
			this.pinchHiddenCanvases.set(canvas,canvas.style.visibility);
			canvas.setCssStyles({ visibility: "hidden" });
		}
		if (this.pinchHiddenCanvases.size) this.armPinchLayerRestore();
	}
	/** Reuse an empty wet backing; originals remain intact until preview ends. */
	function preparePinchComposite(this: InkOverlayPlugin): boolean {
		const target = this.wetCanvas;
		if (this.frame.locked || this.builder !== null || !this.wet?.provenBlank || !target?.style || !this.winRef?.getComputedStyle) return false;
		// Attached ink in its stacking place: its highlight over the committed highlight, its pen over the committed pen.
		const att = this.attachedLayer;
		const layers: [HTMLCanvasElement, boolean][] = [
			[this.highlightCanvas, this.highlightBlank], [this.highlightWetCanvas, this.highlightWet.provenBlank],
			...(att ? [[att.hl, att.hlBlank] as [HTMLCanvasElement, boolean]] : []),
			[this.committedCanvas, this.committedBlank],
			...(att ? [[att.pen, att.penBlank] as [HTMLCanvasElement, boolean]] : []),
			[this.tailCanvas, this.tail.provenBlank],
		];
		const occupied = layers.filter(([,blank]) => !blank);
		if (occupied.length < 2) return false;
		// A raster the first preview frame holds up takes the composite down again (putUpHeldRaster): engaged here it would only give a
		// released wet canvas its backing inside the gesture and draw a picture nobody sees.
		const cam = this.lastPaintCam, path = cam ? this.filePath() : null;
		if (cam && path && this.heldRasterSource(path, cam, this.committedStrokes(this.freeStrokes(path)))) return false;
		// The composite engages: a released wet canvas gets its backing now, before the first preview frame.
		this.allocateWet();
		if (!(target.width > 0)) return false;
		const targetStyle = this.winRef.getComputedStyle(target);
		// A transform is fine as long as every input carries the SAME one: the
		// composite draws backings into a backing, and the five canvases share
		// one box and one transform, whichever the path wrote - the counter-scale
		// below 1.0, or none at all under a zoom-shrunk host (canvasLayerBox).
		// Equality against the target is the check, not equality against a
		// constant, so neither path needs naming here and any canvas placed
		// differently from the target still refuses.
		// Filters, blend modes and clips would change the pixels.
		const supported = (style: CSSStyleDeclaration) => style.filter === "none" &&
			style.mixBlendMode === "normal" && style.clipPath === "none";
		if (!supported(targetStyle) || targetStyle.opacity !== "1" || targetStyle.visibility !== "visible" || targetStyle.display === "none") return false;
		const inputs: { canvas: HTMLCanvasElement; opacity: number }[] = [];
		for (const [canvas] of occupied) {
			if (canvas.width !== target.width || canvas.height !== target.height) return false;
			const style = this.winRef.getComputedStyle(canvas), opacity = Number(style.opacity);
			if (style.visibility !== "visible" || style.display === "none") continue;
			if (!supported(style) || !Number.isFinite(opacity) || opacity < 0 || opacity > 1 ||
				style.width !== targetStyle.width || style.height !== targetStyle.height ||
				style.left !== targetStyle.left || style.top !== targetStyle.top ||
				// Equal PLACEMENT, not only an equal `transform` string: the origin
				// and the individual translate/rotate/scale properties move
				// pixels too and are not part of the computed `transform`.
				style.transform !== targetStyle.transform || style.transformOrigin !== targetStyle.transformOrigin ||
				style.translate !== targetStyle.translate || style.rotate !== targetStyle.rotate || style.scale !== targetStyle.scale) return false;
			inputs.push({canvas, opacity});
		}
		if (inputs.length < 2) return false;
		const ctx = target.getContext("2d");
		if (!ctx) return false;
		this.pinchComposite = true;
		ctx.save();
		try {
			ctx.setTransform(1,0,0,1,0,0);ctx.globalCompositeOperation = "source-over";ctx.filter = "none";
			for (const {canvas,opacity} of inputs) { ctx.globalAlpha = opacity;ctx.drawImage(canvas,0,0); }
		} catch {
			ctx.restore();this.restorePinchLayers();return false;
		}
		ctx.restore();this.wet.notePixelsChanged();
		// A canvas already hidden (a landing's held raster hides the committed pair until its whole paint) is left alone, as in
		// hideBlankPinchLayers: recording its 'hidden' let the pinch end write it back after the first preview frame's take-down had
		// shown it, and the free ink stayed hidden until the note was reopened.
		for (const [canvas] of layers) if (canvas.style.visibility !== "hidden") { this.pinchHiddenCanvases.set(canvas,canvas.style.visibility);canvas.setCssStyles({ visibility: "hidden" }); }
		// The wet tile is blank here (the composite needs a blank wet layer); it hides with the rest.
		if (this.wetTileCanvas?.style && this.wetTileCanvas.style.visibility !== "hidden") { this.pinchHiddenCanvases.set(this.wetTileCanvas,this.wetTileCanvas.style.visibility);this.wetTileCanvas.setCssStyles({ visibility: "hidden" }); }
		this.armPinchLayerRestore();
		return true;
	}
	function armPinchLayerRestore(this: InkOverlayPlugin): void {
		const restore = () => this.restorePinchLayers();
		this.wet.beforeWrite = restore;this.highlightWet.beforeWrite = restore;this.tail.beforeWrite = restore;
	}

	/**
	 * THE PAPER MOVES AS ONE WITH THE TEXT. The paper is the scroller's own
	 * background, and the scroller is the one element the pan may not move, so
	 * the translate `.cm-sizer` was just given is handed to the background as two
	 * registered, non-inherited properties the gradient stops (lines, grid) and
	 * the dot tile position (dots) read. Same units as the sizer's translate: the
	 * scroller's layout px, inside the zoom host. Two things move the text against
	 * the scroller during a preview that the pan does not carry, and the paper
	 * takes both: a title rewrap above the content (y) and the column re-centring
	 * under Readable line length (x). Two style writes when the values change,
	 * none when they do not, no read; zero removes them.
	 */
	function writePaperPan(this: InkOverlayPlugin): void {
		const scroller = this.view?.scrollDOM;
		if (!scroller?.style) return;
		const k = this.cssScale;
		const s = Number.isFinite(k) && k > 0 ? 1 / k : 0;
		const carry = this.pinchPreview ? this.paperSnapResidual : null;
		const x = (this.panX() + this.paperColumnDrift) * s - (carry?.x ?? 0), y = this.panY() * s + this.paperRewrapY - (carry?.y ?? 0);
		// While the preview paper is up it carries the pan, and the scroller's pan properties stay off.
		if (this.previewPaperEl) { this.movePreviewPaper(x, y); return; }
		// Folded by the pitch this overlay planned; a pitch the host owns is not known here, so its values go unfolded.
		const pitch = Number.parseFloat(this.paperWritten?.get("--handwriting-paper-pitch") ?? "");
		const ax = x === 0 ? "" : `${foldIntoPitch(x, pitch)}px`, ay = y === 0 ? "" : `${foldIntoPitch(y, pitch)}px`;
		const last = this.paperPanWritten;
		if (last ? last.x === ax && last.y === ay : !ax && !ay) return;
		if (ax) scroller.style.setProperty("--handwriting-paper-pan-x", ax); else scroller.style.removeProperty("--handwriting-paper-pan-x");
		if (ay) scroller.style.setProperty("--handwriting-paper-pan-y", ay); else scroller.style.removeProperty("--handwriting-paper-pan-y");
		this.paperPanWritten = ax || ay ? { x: ax, y: ay } : null;
		// The grid's vertical box reads its own copy - the property is registered `inherits: false`, so the
		// scroller's does not reach a child. Same value, same call, so both axes move on the same frame.
		this.writeGridBoxPan(ax);
	}

	/**
	 * PUT THE PREVIEW PAPER UP, on a preview's first frame: an element about a pitch (see movePreviewPaper) beyond the scroller's
	 * padding box on every side, under the scroller in the host, carrying the scroller's own resolved background.
	 *
	 * COPIED, NOT RE-DERIVED. The scroller's computed image, size, position, repeat and colour are what every stylesheet
	 * rule (global paper, a note's override, a theme) resolved to, so `none` shows nothing and a note's own tile survives
	 * a global one. The pan properties come off FIRST: the computed stops carry phase plus pan, and the element's transform
	 * carries the pan, so a copy taken with them on would move the paper by a standing pan twice.
	 *
	 * NOT PUT UP, and the scroller's own route carries the note: no paper; a layer that is not a gradient attached `local`
	 * (not the paper's); a pitch that is not a px length (the property is not registered, so a theme's `2.5rem` computes
	 * to the text "2.5rem", which is not a pitch); a scroller that is not left-to-right, whose scroll origin is not the
	 * one the offset below is derived for.
	 *
	 * One forced style read per gesture; the preview frame before it has already flushed layout.
	 */
	function beginPreviewPaper(this: InkOverlayPlugin): void {
		const host = this.view?.dom, scroller = this.view?.scrollDOM;
		if (this.previewPaperEl || !host?.style || !scroller?.style || scroller.parentElement !== host || !this.winRef?.getComputedStyle) return;
		// Live: every read below resolves the style as it stands at that read.
		const cs = this.winRef.getComputedStyle(scroller);
		// The guides go quiet on every paper, before any paper reason to stop here; after the one read, so the class
		// write does not make that read resolve style again.
		this.markPageGuidesPreview(true);
		const pitch = previewPaperPitch(cs);
		if (pitch === null || cs.direction !== "ltr" || !previewPaperCopyable(cs, pitch)) return;
		// Under grid the vertical rules live on their own box inside the scroller, so the copy takes that
		// layer too - the preview paints both axes on one pane-sized box, which is the shape measured clean.
		const grid = this.gridBoxPaperStyle(pitch);
		if (this.paperGridBox && !grid) return;
		this.clearScrollerPan(scroller);
		// OFF THE PAGE, and that is the whole point of the global helper here rather than `host.createDiv`: the
		// element takes its nine background properties below, and on an element already in the page each one is a
		// style write inside the preview frame - PaperZoomHost ZERO WRITES reads 11 that way against its cap of 2.
		// `insertBefore` adopts it into the host's document at the end of this call, as the native form did.
		const el = createDiv({ cls: "handwriting-paper-preview" });
		copyPreviewPaperBackground(el, cs, grid);
		this.previewPaperEl = el;
		this.previewPaperPitch = pitch;
		this.previewPaperPhaseX = previewPaperPhase(cs, "--handwriting-paper-phase-x");
		this.previewPaperPhaseY = previewPaperPhase(cs, "--handwriting-paper-phase");
		this.previewPaperInset = "";
		this.previewPaperTransform = "";
		this.paperScrollLeft = scroller.scrollLeft;
		this.paperScrollTop = scroller.scrollTop;
		this.measurePreviewPaperBox();
		host.insertBefore(el, scroller);
		scroller.classList.add("handwriting-paper-previewing");
		this.previewPaperSwaps++;
		this.writePaperPan();
	}

	/** The grid box's own horizontal pan, written only when it changes; "" removes it. */
	function writeGridBoxPan(this: InkOverlayPlugin, ax: string): void {
		const box = this.paperGridBox;
		if (!box?.style || ax === this.paperGridBoxPanX) return;
		if (ax) box.style.setProperty("--handwriting-paper-pan-x", ax); else box.style.removeProperty("--handwriting-paper-pan-x");
		this.paperGridBoxPanX = ax;
	}

	/**
	 * THE "settle paper" TRACE LINE: every layer that can move the paper, in one line, so a device trace names on which
	 * frame each one moved and by how much. Written in the settle task, at each settle measure attempt and on the 12
	 * frames after the lift. Call sites hold it behind `diagnosticsEnabled()`; it writes nothing and moves nothing.
	 */
	function traceSettlePaper(this: InkOverlayPlugin, stage: string): void {
		const scroller = this.view?.scrollDOM, host = this.view?.dom;
		if (!scroller?.style || !host?.style) return;
		const n = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? "-" : v.toFixed(2);
		const v = (s: string | undefined | null) => s ? s.replace(/\s+/g, "") : "-";
		const t = performance.now(), since = Number.isFinite(this.settlePaperT0) ? t - this.settlePaperT0 : Number.NaN;
		const el = this.previewPaperEl, anchor = this.pinchAnchor ?? this.panAnchorHold;
		scrollProbeExtent(`settle paper ${stage} t ${t.toFixed(1)} since ${n(since)} scroll ${n(scroller.scrollLeft)},${n(scroller.scrollTop)}`
			+ ` sizer ${v(this.panSizer()?.style.transform)} ink ${v(this.inkLayer?.style.transform)}`
			+ ` pan ${v(scroller.style.getPropertyValue("--handwriting-paper-pan-x"))},${v(scroller.style.getPropertyValue("--handwriting-paper-pan-y"))}`
			+ ` phase ${v(host.style.getPropertyValue("--handwriting-paper-phase-x"))},${v(host.style.getPropertyValue("--handwriting-paper-phase"))}`
			+ ` preview ${el ? (el.isConnected ? "up" : "held") : "down"} transform ${v(this.previewPaperTransform)} inset ${v(this.previewPaperInset)}`
			+ ` gridbox ${this.paperGridBox ? this.paperGridBoxPanX || "0" : "none"} origin ${n(this.paperOriginLeft)},${n(this.paperOriginLayout)}`
			+ ` drift ${n(this.paperColumnDrift)},${n(this.paperRewrapY)} residual ${n(this.paperSnapResidual.x)},${n(this.paperSnapResidual.y)}`
			+ ` viewpan ${n(this.panX())},${n(this.panY())} scale ${this.cssScale.toFixed(4)}`
			+ ` column preview ${n(this.previewColumnLocal)} anchor ${n(anchor?.columnLocal)} anchorScroll ${n(anchor?.scrollLeft)}`);
	}

	/** The same line on each of the 12 frames after a settle; a newer settle restarts the count. Diagnostics only. */
	function traceSettlePaperFrames(this: InkOverlayPlugin): void {
		const win = this.winRef;
		if (!win?.requestAnimationFrame) return;
		if (this.settlePaperRaf !== 0) win.cancelAnimationFrame(this.settlePaperRaf);
		let frame = 0;
		const step = (): void => {
			this.settlePaperRaf = 0;
			if (!diagnosticsEnabled() || !this.view?.scrollDOM) return;
			this.traceSettlePaper(`frame ${++frame}`);
			if (frame < 12) this.settlePaperRaf = win.requestAnimationFrame(step);
		};
		this.settlePaperRaf = win.requestAnimationFrame(step);
	}

	/** One frame's worth of the watch's work, however many mutations arrived. */
	function watchPaperKind(this: InkOverlayPlugin): void {
		const doc = this.view?.dom?.ownerDocument;
		if (this.paperKindWatch.length || !doc?.body || typeof MutationObserver === "undefined") return;
		// IN THE MUTATION'S OWN TASK, not on the next frame: the scroller gives up its vertical layer under the class
		// this call adds, so a frame between the paper changing and the box arriving would paint the whole grid on the
		// scroller and then split it - a visible double step, and a state the paper cells read as the wrong image. A
		// paper change is rare (a command, the picker, a note switch), so the style read it costs is not a hot path.
		const queue = (): void => { this.syncGridPaperBox(); };
		const body = new MutationObserver(queue);
		body.observe(doc.body, { attributes: true, attributeFilter: ["class"] });
		const note = new MutationObserver(queue);
		note.observe(doc.body, { attributes: true, attributeFilter: ["data-handwriting-paper"], subtree: true });
		this.paperKindWatch = [body, note];
	}

	/**
	 * THE GRID'S VERTICAL BOX, made, sized or taken away. Grid paper only: the stylesheet states
	 * `--handwriting-paper-grid` on the scroller for every paper kind, so a note's own choice beats a global one by
	 * the ordinary cascade and this reads the answer rather than re-deriving it.
	 *
	 * THE SIZE IS THE CONTENT AND THE GRANTED EXTENT, never `scrollWidth` or `scrollHeight`: the box is inside the
	 * scroller, so a size taken from the scroll range would feed the range it was taken from and grow on every pass.
	 * The sizer's own box is the content; the extent spacer's position is what this overlay has granted beyond it;
	 * the client box covers a note shorter than its pane. Nothing here can make the scroller scroll further than the
	 * spacer already does.
	 *
	 * NOT ON A PREVIEW FRAME, and nothing calls it on one: while a preview lives the paper is the preview element,
	 * which carries both axes itself, and this box is quiet under the previewing class. So a pinch adds no read and
	 * no write here. A scroll adds none either: scrolling changes neither the content nor the grant.
	 */
	function syncGridPaperBox(this: InkOverlayPlugin): void {
		const scroller = this.view?.scrollDOM;
		if (!scroller?.isConnected) { this.removeGridPaperBox(); return; }
		if (this.pinchPreview || !this.winRef?.getComputedStyle) return;
		this.watchPaperKind();
		const wanted = this.winRef.getComputedStyle(scroller).getPropertyValue("--handwriting-paper-grid").trim() === "1";
		if (!wanted) { this.removeGridPaperBox(); return; }
		if (!this.paperGridBox) {
			// The same patch the extent spacer makes, for the same reason: an absolutely placed child of a static
			// scroller would take its place from the pane instead.
			if (this.winRef.getComputedStyle(scroller).position === "static") {
				scroller.setCssStyles({ position: "relative" });
				this.scrollPositionPatched = true;
			}
			// `createDiv` appends, so the box is moved to the front in the same task: it is the scroller's FIRST child
			// on every frame that paints, and absolute from its first, so the append itself adds nothing to the flow.
			const box = scroller.createDiv({ cls: "handwriting-paper-grid-column" });
			scroller.insertBefore(box, scroller.firstChild);
			// FAIL SAFE: the stylesheet paints both axes on the scroller by default, because the box is
			// this overlay's and a grid scroller without one would otherwise show lined paper. The scroller gives up its
			// vertical layer only under this class, added in the SAME call that puts the box in the page and removed in
			// the same call that takes it out, so no frame paints the axis twice and none paints it not at all.
			scroller.classList.add("handwriting-paper-grid-split");
			this.paperGridBox = box;
			this.paperGridBoxSize = null;
			this.paperGridBoxPanX = "";
			const pan = this.paperPanWritten;
			if (pan?.x) this.writeGridBoxPan(pan.x);
		}
		const { w, h } = paperBoxArea(this, scroller);
		const size = `${w},${h}`;
		if (size === this.paperGridBoxSize) return;
		this.paperGridBoxSize = size;
		this.paperGridBox.setCssStyles({ width: `${w}px`, height: `${h}px` });
	}

	/**
	 * The area a box behind the text covers, layout px: the content and the granted extent, never `scrollWidth` or
	 * `scrollHeight` (see `syncGridPaperBox`). The sizer is the first child that is neither box.
	 */
	function paperBoxArea(o: InkOverlayPlugin, scroller: HTMLElement): { w: number; h: number } {
		let sizer: Element | null = scroller.firstElementChild;
		while (sizer && (sizer === o.paperGridBox || sizer === o.pageGuideBox)) sizer = sizer.nextElementSibling;
		const contentW = sizer instanceof HTMLElement ? sizer.offsetLeft + sizer.offsetWidth : 0;
		const contentH = sizer instanceof HTMLElement ? sizer.offsetTop + sizer.offsetHeight : 0;
		const grantedW = Number.isFinite(o.spacerLeft) ? o.spacerLeft + 1 : 0;
		const grantedH = Number.isFinite(o.spacerTop) ? o.spacerTop + 1 : 0;
		return { w: Math.max(scroller.clientWidth, contentW, grantedW), h: Math.max(scroller.clientHeight, contentH, grantedH) };
	}

	/**
	 * THE PAGE GUIDES' BOX, made, sized or taken away. Infinite Canvas on, with the text column measured: faint lines at
	 * every page height (PageGuides.ts) from the note's top edge, on every paper, at every zoom.
	 *
	 * SCREEN ONLY AND INERT: absolutely placed behind the text (z-index -1, no pointer events), sized like the grid box
	 * from the content and the grant, so it adds no scroll room; its top is the note origin the paper's phase is planned
	 * from, so page 1 starts where the note does and no line sits at its top edge. It draws, clips and moves nothing,
	 * and the print path never reads it.
	 *
	 * QUIET WHILE A PREVIEW LIVES: the stylesheet blanks it under its own previewing class (markPageGuidesPreview), set
	 * and cleared where the preview paper begins and ends, so it goes quiet on paper `none` too, where the scroller's
	 * class never comes on; it paints again at the settle. A box made while a preview lives takes the class at once.
	 * Not called on a preview frame: like the grid box, it reads and writes nothing there.
	 *
	 * After the grid box in the scroller, before the content: both are behind the text, and the guides paint over the
	 * grid's vertical rules rather than under them.
	 */
	function syncPageGuideBox(this: InkOverlayPlugin): void {
		const scroller = this.view?.scrollDOM;
		if (!scroller?.isConnected) { this.removePageGuideBox(); return; }
		if (this.pinchPreview || !this.winRef?.getComputedStyle) return;
		const column = this.viewportLayout?.columnBox ?? 0;
		const pitch = this.canvasMode && column > 0 ? pageGuidePitch(column) : Number.NaN;
		if (!(pitch > 0)) { this.removePageGuideBox(); return; }
		if (!this.pageGuideBox) {
			if (this.winRef.getComputedStyle(scroller).position === "static") {
				scroller.setCssStyles({ position: "relative" });
				this.scrollPositionPatched = true;
			}
			const box = scroller.createDiv({ cls: PAGE_GUIDES_CLASS });
			if (this.pageGuidesPreviewing) box.classList.add(PAGE_GUIDES_PREVIEWING);
			scroller.insertBefore(box, this.paperGridBox?.parentElement === scroller ? this.paperGridBox.nextElementSibling : scroller.firstElementChild);
			this.pageGuideBox = box;
			this.pageGuideBoxKey = null;
		}
		const { w, h } = paperBoxArea(this, scroller);
		const origin = this.paperOriginLayout;
		const top = origin !== null && Number.isFinite(origin) && origin > 0 ? origin : 0;
		const px = Math.round(pitch * 1000) / 1000;
		const key = `${w},${h},${top},${px}`;
		if (key === this.pageGuideBoxKey) return;
		this.pageGuideBoxKey = key;
		this.pageGuideBox.setCssStyles({ width: `${w}px`, height: `${Math.max(0, h - top)}px`, top: `${top}px` });
		this.pageGuideBox.style.setProperty("--handwriting-page-guide-pitch", `${px}px`);
	}

	/**
	 * The guides' own previewing class, on or off: written only when it changes. Kept as state too, so a box made while a
	 * preview lives starts quiet, and the box going and coming leaves the preview's word standing.
	 */
	function markPageGuidesPreview(this: InkOverlayPlugin, on: boolean): void {
		if (this.pageGuidesPreviewing === on) return;
		this.pageGuidesPreviewing = on;
		this.pageGuideBox?.classList.toggle(PAGE_GUIDES_PREVIEWING, on);
	}

	/** The guides' box goes: the canvas off, the column gone, a note switch, a release. */
	function removePageGuideBox(this: InkOverlayPlugin): void {
		if (!this.pageGuideBox) return;
		this.pageGuideBox.remove();
		this.pageGuideBox = null;
		this.pageGuideBoxKey = null;
	}

	/** The box goes: paper switched away from grid, a note switch, a release. Its own state goes with it. */
	function removeGridPaperBox(this: InkOverlayPlugin): void {
		if (!this.paperGridBox) return;
		// The class goes first and in this same task: the scroller is painting one axis while the box paints the
		// other, so the box may not leave before the scroller has taken its own layer back.
		this.paperGridBox.parentElement?.classList.remove("handwriting-paper-grid-split");
		this.paperGridBox.remove();
		this.paperGridBox = null;
		this.paperGridBoxSize = null;
		this.paperGridBoxPanX = "";
	}

	/** The release: the watch and its owed frame go with the box. */
	function stopPaperKindWatch(this: InkOverlayPlugin): void {
		for (const observer of this.paperKindWatch) observer.disconnect();
		this.paperKindWatch = [];
		if (this.paperKindFrame !== null) { this.winRef?.cancelAnimationFrame?.(this.paperKindFrame); this.paperKindFrame = null; }
	}

	/** The scroller's pan properties off, each only if it is set: a removal of nothing is still a style call. */
	function clearScrollerPan(this: InkOverlayPlugin, scroller: HTMLElement): void {
		if (scroller.style.getPropertyValue("--handwriting-paper-pan-x")) scroller.style.removeProperty("--handwriting-paper-pan-x");
		if (scroller.style.getPropertyValue("--handwriting-paper-pan-y")) scroller.style.removeProperty("--handwriting-paper-pan-y");
		this.paperPanWritten = null;
		// The grid's vertical box carries its own copy. Left set, the next
		// writePaperPan at zero pan finds nothing to do and the vertical rules
		// keep the old offset while the horizontal ones come back.
		this.writeGridBoxPan("");
	}

	/**
	 * The grid box's own resolved background, for a preview copy, or null when there is no box or its layer is
	 * not the paper this overlay planned. The previewing class is not on yet at this read (begin) or is taken off
	 * around it (rebase), exactly as the scroller's own copy is taken.
	 */
	function gridBoxPaperStyle(this: InkOverlayPlugin, pitch: number): PreviewPaperSource | null {
		const box = this.paperGridBox;
		if (!box?.isConnected || !this.winRef?.getComputedStyle) return null;
		const cs = this.winRef.getComputedStyle(box);
		return previewPaperCopyable({ backgroundImage: cs.backgroundImage, backgroundAttachment: "local", backgroundSize: cs.backgroundSize }, pitch) ? cs : null;
	}

	/**
	 * The scroller's padding box inside the host, as insets, layout px. Insets rather than a size: the counter-sized host
	 * of a zoom preview, and a pane resize, move the host's edges and the scroller's together, and the element follows
	 * both without a write. Re-read on each preview frame where the column is read, so a change in what sits between the
	 * host and the scroller is followed too; the frame has already flushed its layout, so the reads force none.
	 */
	function measurePreviewPaperBox(this: InkOverlayPlugin, deferPaper = false): void {
		const host = this.view?.dom, scroller = this.view?.scrollDOM;
		if (!this.previewPaperEl || !host || !scroller) return;
		const top = scroller.offsetTop + scroller.clientTop, left = scroller.offsetLeft + scroller.clientLeft;
		const right = host.clientWidth - (left + scroller.clientWidth), bottom = host.clientHeight - (top + scroller.clientHeight);
		const box = this.previewPaperBox, kd = this.cssScale * (this.dpr || 1);
		if (box && box.top === top && box.right === right && box.bottom === bottom && box.left === left && kd === this.previewPaperKd) return;
		this.previewPaperBox = { top, right, bottom, left };
		this.previewPaperKd = kd;
		if (deferPaper) { this.previewPaperBoxDirty = true; return; }
		this.writePaperPan();
	}

	/**
	 * THE PREVIEW PAPER'S PLACE for the pan `x`, `y` (layout px, as the scroller's pan properties would take it).
	 *
	 * The scroller's background is attached `local`: a stop at `phase + n x pitch` sits at `pan - scroll` in the
	 * scroller's box. The element's copy draws the stop at `phase + n x pitch` from its own edge, which is `margin` above
	 * and left of that box, so its offset is `pan - scroll + margin`, folded into one pitch (a repeating pattern moved by a
	 * pitch is the same pattern) and then placed on the device px grid.
	 *
	 * FOLD FIRST, THEN ROUND. A composited layer at a fractional device px is resampled, and a one-device-px rule becomes
	 * two half rows. Where the pitch is not a whole number of device px (28 layout px at 30 percent and DPR 2 is 16.8), a
	 * fold after the rounding would take a fractional device px back off.
	 *
	 * WHAT IS ROUNDED IS WHERE THE RULES LAND, not the offset alone: the copy's phase was put on the device px grid of the
	 * zoom it was planned at, and mid-zoom it is off this zoom's grid by a fraction, so the offset takes that fraction back
	 * out. The rules then land on whole device px (hard) at most half a device px from the text, the nearest whole px to
	 * the text's own place, which is where the settle's snap puts them: the lift moves them by nothing. On a drag the
	 * fraction is 0 and the offset itself is whole.
	 *
	 * The margin is a pitch rounded up to whole device px, plus one, so a rounded offset never uncovers the edge.
	 */
	function movePreviewPaper(this: InkOverlayPlugin, x: number, y: number): void {
		const el = this.previewPaperEl, box = this.previewPaperBox, pitch = this.previewPaperPitch;
		const kd = this.cssScale * (this.dpr || 1);
		if (!el || !box || !(pitch > 0) || !(Number.isFinite(kd) && kd > 0)) return;
		const margin = (Math.ceil(pitch * kd - 1e-6) + 1) / kd;
		const inset = `${box.top - margin}px ${box.right - margin}px ${box.bottom - margin}px ${box.left - margin}px`;
		if (inset !== this.previewPaperInset) { el.style.inset = inset; this.previewPaperInset = inset; }
		const scroller = this.view?.scrollDOM;
		if (!Number.isFinite(this.paperScrollLeft) || !Number.isFinite(this.paperScrollTop)) { this.paperScrollLeft = scroller?.scrollLeft ?? 0; this.paperScrollTop = scroller?.scrollTop ?? 0; }
		const fx = fractionOf(this.previewPaperPhaseX * kd), fy = fractionOf(this.previewPaperPhaseY * kd);
		const tx = (Math.round(foldIntoPitch(x - this.paperScrollLeft + margin, pitch) * kd + fx) - fx) / kd;
		const ty = (Math.round(foldIntoPitch(y - this.paperScrollTop + margin, pitch) * kd + fy) - fy) / kd;
		const transform = `translate(${tx}px, ${ty}px)`;
		if (transform !== this.previewPaperTransform) { el.style.transform = transform; this.previewPaperTransform = transform; }
	}

	/**
	 * A SETTLE THAT STARTS A BOUNCE keeps the preview paper up, but the settle has re-planned the paper at the new zoom
	 * (a rule floored to a device px, a phase on the new device px grid) and spent the pan into the scroll. The copy is
	 * taken again from the scroller, with the suppressing class off for the one read, and the offset re-derived from the
	 * settled scroll, all in the settle's own task, so no frame paints the old zoom's rules.
	 */
	function rebasePreviewPaper(this: InkOverlayPlugin): void {
		const el = this.previewPaperEl, scroller = this.view?.scrollDOM;
		if (!el || !scroller?.style || !this.winRef?.getComputedStyle) return;
		scroller.classList.remove("handwriting-paper-previewing");
		this.clearScrollerPan(scroller);
		const cs = this.winRef.getComputedStyle(scroller);
		const pitch = previewPaperPitch(cs);
		const grid = pitch === null ? null : this.gridBoxPaperStyle(pitch);
		const copyable = pitch !== null && previewPaperCopyable(cs, pitch) && !(this.paperGridBox && !grid);
		if (copyable) copyPreviewPaperBackground(el, cs, grid);
		scroller.classList.add("handwriting-paper-previewing");
		if (!copyable) { this.endPreviewPaper("settle"); return; }
		this.previewPaperPitch = pitch;
		this.previewPaperPhaseX = previewPaperPhase(cs, "--handwriting-paper-phase-x");
		this.previewPaperPhaseY = previewPaperPhase(cs, "--handwriting-paper-phase");
		this.paperScrollLeft = scroller.scrollLeft;
		this.paperScrollTop = scroller.scrollTop;
		this.previewPaperBox = null;
		this.measurePreviewPaperBox();
	}

	/** The preview paper as it stands, read-only, for a fixture that has to see it rather than infer it from pixels. */
	function previewPaperReadout(this: InkOverlayPlugin): { present: boolean; held: boolean; swaps: number; ended: PreviewPaperEnd | null; pitch: number; inset: string; transform: string } {
		return { present: !!this.previewPaperEl?.isConnected, held: !!this.previewPaperEl, swaps: this.previewPaperSwaps, ended: this.previewPaperEnded,
			pitch: this.previewPaperEl ? this.previewPaperPitch : 0, inset: this.previewPaperInset, transform: this.previewPaperTransform };
	}

	/**
	 * The fingers lifted with the preview past the cap. Drive the SAME preview path from
	 * the overshoot back to the cap on the bounce's curve, one move per frame, then lift for real at the
	 * cap. No second scale in flight, no per-frame commit: each frame is a preview frame exactly like
	 * a slow pinch, and the single settle runs at `to`, inside the committed range.
	 */
	function startPinchGive(this: InkOverlayPlugin, from: number, to: number, centroid: { x: number; y: number }): void {
		if (this.pinchRaf !== 0) { this.winRef.cancelAnimationFrame(this.pinchRaf); this.pinchRaf = 0; }
		const sd = this.view.scrollDOM;
		const give = { from, to, startedAt: performance.now(), raf: 0, centroid: { x: centroid.x, y: centroid.y }, stepping: false, scrollLeft: sd.scrollLeft, scrollTop: sd.scrollTop, paused: false };
		this.pinchGive = give;
		give.raf = this.winRef.requestAnimationFrame(() => this.pinchGiveStep(give));
	}

	/** One tick of the give: the eased scale for this instant, painted, and the next tick requested. */
	function pinchGiveStep(this: InkOverlayPlugin, give: NonNullable<InkOverlayPlugin["pinchGive"]>): void {
		if (this.pinchGive !== give || give.paused) return;
		give.raf = 0;
		const t = Math.min(1, Math.max(0, (performance.now() - give.startedAt) / OVERSCROLL_BOUNCE_MS));
		if (t >= 1) { this.finishPinchGive(); return; }
		// Ease out, the bounce's own curve: fast off the overshoot, gently onto the cap, never past it.
		this.pinchGiveFrame(give.to + (give.from - give.to) * (1 - t) ** 3, give);
		if (this.pinchGive === give && !give.paused) give.raf = this.winRef.requestAnimationFrame(() => this.pinchGiveStep(give));
	}

	/** Hold the ease where it stands for a pen stroke; the preview stays up at this scale, nothing moves. */
	function pausePinchGive(this: InkOverlayPlugin): void {
		const give = this.pinchGive;
		if (!give || give.paused) return;
		if (give.raf !== 0) { this.winRef.cancelAnimationFrame(give.raf); give.raf = 0; }
		give.paused = true;
	}

	/** After the stroke, ease on from the scale on screen to the cap over a fresh half second. */
	function resumePinchGive(this: InkOverlayPlugin): void {
		const give = this.pinchGive;
		if (!give || !give.paused) return;
		give.paused = false;
		give.from = this.pinchScaleNow;
		give.startedAt = performance.now();
		if (Math.abs(give.from - give.to) < 1e-9) { this.finishPinchGive(); return; }
		give.raf = this.winRef.requestAnimationFrame(() => this.pinchGiveStep(give));
	}

	/** One frame of the give: a move at `scale` through `pinch`, painted now rather than on the frame it would request. */
	function pinchGiveFrame(this: InkOverlayPlugin, scale: number, give: NonNullable<InkOverlayPlugin["pinchGive"]>): void {
		const ref = this.pinchRefScale ?? this.pinchScaleNow;
		if (!Number.isFinite(ref) || ref <= 0) return;
		give.stepping = true;
		try {
			// `pinch` divides a move's ratio by `pinchRatioBase`; hand it the ratio that lands on `scale`.
			this.pinch("move", (scale / ref) * (this.pinchRatioBase || 1), give.centroid);
			if (this.pinchRaf !== 0) { this.winRef.cancelAnimationFrame(this.pinchRaf); this.pinchRaf = 0; this.flushPinch(false); }
		} finally { give.stepping = false; }
	}

	/** End the give now: the settle runs at the cap, the way the lift would have without it. */
	function finishPinchGive(this: InkOverlayPlugin): void {
		const give = this.pinchGive;
		if (!give) return;
		if (give.raf !== 0) { this.winRef.cancelAnimationFrame(give.raf); give.raf = 0; }
		this.pinchGive = null;
		if (this.retiring) return;
		// A scroll that ran under the ease (one finger, a wheel) moved the scroller; the settle anchors on the
		// gesture's start scroll, so that movement is folded into the anchor or the settle would take it back.
		const a = this.pinchAnchor, sd = this.view.scrollDOM;
		if (a) { a.scrollLeft += sd.scrollLeft - give.scrollLeft; a.scrollTop += sd.scrollTop - give.scrollTop; }
		this.pinchPending = { next: give.to };
		// The give's last eased frame painted a hair above the cap; its settle lands the cap itself, once.
		this.pinchGiveEnding = true;
		try { this.pinch("end", 1, give.centroid); } finally { this.pinchGiveEnding = false; }
	}

 /**
  * The lined, grid and dotted paper: pitch, phase, rule and dot thickness in
  * layout px; the arithmetic is PaperPlan.ts. The pitch takes the text's size
  * and the phase the note origin, never the zoom's scale (the host's CSS zoom
  * scales the background with the note). The zoom reaches thickness, so it
  * never goes under a device px, and the phase's device px grid, both at the
  * INTENDED zoom: the external scale times the camera's own, not the measured
  * read-back. Planned on the refresh path and the camera sync when the text
  * size is read, when updateExtent captures a moved origin, when a note switch
  * opens another note, and at a commit, where a thickness can change and the
  * phase moves at most half a device px onto the new grid. Never on a preview
  * frame. In the task that read its
  * inputs, so the first paint after any of them already has it.
  */
 function updatePaperSpacing(this: InkOverlayPlugin):void {
  // A detached editor gets nothing.
  if(!this.view?.dom?.isConnected)return;
  const layout=this.viewportLayout;
  const zoom=layout?layout.externalScale*this.pinchScaleNow:Number.isFinite(this.paperRestZoom)?this.paperRestZoom:this.cssScale;
  const plan=paperPlan(this.paperFontPx,this.paperOriginLayout,(this.dpr||1)*zoom,this.paperOriginLeft);
  if(!plan)return;
  // A re-plan while the preview paper rides a bounce (its settle's measure, say) is copied onto it at once; the settle re-copies its own.
  if(this.writePaperVars(plan)&&this.previewPaperEl&&!this.pinchPreview&&!this.previewPaperSettling)this.rebasePreviewPaper();
  // The snap's residual, only for a phase this overlay wrote: what a preview carries back out.
  const residual=(phase:number|null,origin:number|null,name:string):number=>{
   if(phase===null||origin===null||!Number.isFinite(origin)||this.paperWritten?.get(name)!==`${phase}px`)return 0;
   const t=((origin%plan.pitch)+plan.pitch)%plan.pitch;
   const d=phase-t;
   return d>plan.pitch/2?d-plan.pitch:d<-plan.pitch/2?d+plan.pitch:d;
  };
  this.paperSnapResidual={x:residual(plan.phaseX,this.paperOriginLeft,"--handwriting-paper-phase-x"),y:residual(plan.phase,this.paperOriginLayout,"--handwriting-paper-phase")};
  // A pan written while a residual was carried is re-written once the preview has ended.
  if(this.paperPanWritten)this.writePaperPan();
  // The paper kind can have changed with the plan (a note switch, the picker, the cycle command), and the
  // content can have grown since the last pass. Never on a preview frame: this method is not called on one.
  this.syncGridPaperBox();
  this.syncPageGuideBox();
 }

 /**
  * The paper's properties on the host, each only when it changes; a plan
  * with no phase keeps the last one. A value the host holds that the overlay did
  * not write (a theme's, or one with a priority) is never replaced, at rest or
  * zoomed: the paper needs no write to follow a zoom, so there is nothing to
  * override it for.
  */
 function writePaperVars(this: InkOverlayPlugin, plan:PaperPlan):boolean {
  const host=this.view.dom;
  let wrote=false;
  for(const [name,px] of [["--handwriting-paper-pitch",plan.pitch],["--handwriting-paper-rule",plan.rule],["--handwriting-paper-dot",plan.dot],["--handwriting-paper-phase",plan.phase],["--handwriting-paper-phase-x",plan.phaseX]] as const) {
   if(px===null)continue;
   const value=`${px}px`,current=host.style.getPropertyValue(name);
   if(current===value)continue;
   if(current&&(host.style.getPropertyPriority(name)||current!==this.paperWritten?.get(name)))continue;
   host.style.setProperty(name,value);this.paperWritten?.set(name,value);wrote=true;
  }
  return wrote;
 }

 /**
  * Takes the overlay's own paper values off the editor at a release. The
  * editor outlives the overlay: a zoomed plan left inline stands until the
  * next at-rest plan, and an overlay mounted later on the same editor (a
  * plugin reload) takes it for the host's own and never replaces it. Until
  * the at-rest plan lands the stylesheet's fallback shows. A value that is
  * not the one written here, or carries a priority, is the host's and stays.
  */
 function clearOwnPaperVars(this: InkOverlayPlugin):void {
  const host=this.view?.dom;
  if(host)for(const name of PAPER_PROPERTIES){const own=this.paperWritten?.get(name);if(own&&host.style.getPropertyValue(name)===own&&!host.style.getPropertyPriority(name))host.style.removeProperty(name);}
  this.paperWritten?.clear();
  // The pan properties live on the scroller and are only ever this overlay's.
  const scroller=this.view?.scrollDOM;
  if(scroller?.style){scroller.style.removeProperty("--handwriting-paper-pan-x");scroller.style.removeProperty("--handwriting-paper-pan-y");}
  this.paperPanWritten=null;this.paperRewrapY=0;this.paperColumnDrift=0;this.paperSnapResidual={x:0,y:0};
  this.writeGridBoxPan("");
 }

	/**
	 * THE INK THE START VIEW DID NOT HOLD. A zoom out shows note the committed layer never painted; the extent raster holds all of it
	 * at the start zoom. On the preview's first frame, when that raster still holds (extentHolds, no side effect) and the camera
	 * moved by whole device px since it was built (copyFromExtent's own test), or else the stand-in a landing kept while the next
	 * raster builds still pictures the layer's strokes (heldRasterSource, its CSS size scaled once here), its two canvases go up in one element right after
	 * the scroller, at the scroller's own stacking and under the same host scale, and the pane's committed and highlight canvases are
	 * hidden in the same call; the extent raster after a move off whole device px, and on a zoom out with neither held the overview
	 * picture, go up the same way but cut off the start view, and the pane's canvases stay shown. Nothing is drawn and no canvas is made: the element is kept across gestures, every style is written while it
	 * is off the page, and the reads are the ones measurePreviewPaperBox makes on a frame whose layout is already flushed. The pinch
	 * composite, if it engaged at the gesture's start, is undone first: under the element it would paint the ink twice.
	 * `clipOnly`: a later frame's try puts up a clipped pick only, never one that hides the pane's canvases mid-gesture.
	 */
	function putUpHeldRaster(this: InkOverlayPlugin, clipOnly = false): void {
		if (this.heldRaster) this.takeDownHeldRaster();
		const host = this.view?.dom, scroller = this.view?.scrollDOM, container = this.container, cam = this.lastPaintCam;
		if (!cam || !host?.style || !scroller?.style || scroller.parentElement !== host || !container?.style) return;
		const path = this.filePath();
		if (!path) return;
		const committed = this.committedCanvas, cw = committed?.width ?? 0, ch = committed?.height ?? 0;
		if (!(cw > 0) || !(ch > 0) || !(this.cssWidth > 0) || !(this.cssHeight > 0)) return;
		const pick = this.heldRasterSource(path, cam, this.committedStrokes(this.freeStrokes(path)));
		if (!pick || (clipOnly && !pick.clip)) return;
		if (!bandPlace(container)) return;
		if (this.pinchComposite) this.restorePinchLayers();
		const clip = this.heldRasterClip ?? makeHeldRasterClip();
		this.heldRasterClip = clip;
		const inner = clip.firstElementChild as HTMLElement;
		const top = scroller.offsetTop + scroller.clientTop, left = scroller.offsetLeft + scroller.clientLeft;
		const right = host.clientWidth - (left + scroller.clientWidth), bottom = host.clientHeight - (top + scroller.clientHeight);
		clip.setCssStyles({ top: `${top}px`, left: `${left}px`, right: `${right}px`, bottom: `${bottom}px` });
		const h: HeldRaster = {
			src: pick.src, f: pick.f, path, count: pick.count, generation: pick.generation, shownMoves: pick.shownMoves, inner,
			scroll: { x: scroller.scrollLeft, y: scroller.scrollTop },
			offX: pick.offX, offY: pick.offY, rasterScale: this.pinchAnchor?.fromScale ?? Number.NaN, box: "", transform: "", hidden: [],
			penTiles: [], hlTiles: [], hlWrap: null,
		};
		// Attached ink in its stacking place: the groups the picture's world rect meets, from their current sprites (heldTiles). The
		// raster holds free ink only; without the tiles the wash paints over attached pen and a group off the start view pops in.
		const att = this.attachedLayer, groups = att?.live ? this.attachedGroups(path) : [];
		const tiles = att && groups.length > 0 ? att.heldTiles(cam, groups, pick.world, committedFloorFor(this.committedBacking, this.dpr), this.committedBacking ?? 0) : null;
		if (tiles) {
			h.penTiles = tiles.pen;
			h.hlTiles = tiles.hl;
			if (tiles.hl.length > 0) {
				const wrap = this.heldRasterHlWrap ?? makeHeldRasterHlWrap();
				this.heldRasterHlWrap = wrap;
				for (const t of tiles.hl) wrap.appendChild(t.c);
				h.hlWrap = wrap;
			}
		}
		this.placeHeldRasterCanvases(h);
		// A clipped pick (the overview, or the extent raster off whole device px) goes up beside the pane's canvases, so it is cut off
		// the start view they paint (inner px 0 to the layer's CSS size, the committed canvas's own box): an even-odd ring, one write
		// here and none per frame. Any other source clears it. The attached tiles sit in the same inner box, so the ring cuts them too.
		const ring = pick.clip ? `polygon(evenodd, -1e7px -1e7px, 1e7px -1e7px, 1e7px 1e7px, -1e7px 1e7px, -1e7px -1e7px, 0px 0px, 0px ${this.cssHeight}px, ${this.cssWidth}px ${this.cssHeight}px, ${this.cssWidth}px 0px, 0px 0px)` : "";
		if (inner.style.clipPath !== ring) inner.style.clipPath = ring;
		// Inner order, as the pane stacks its layers: free highlight, attached highlight under one alpha, free pen, attached pen.
		if (h.src.hl) inner.appendChild(h.src.hl);
		if (h.hlWrap) inner.appendChild(h.hlWrap);
		inner.appendChild(h.src.pen);
		for (const t of h.penTiles) inner.appendChild(t.c);
		this.heldRaster = h;
		this.writeHeldRaster(0, 0);
		// The first write takes the raster down when the store no longer counts what the layer paints (a drag snapshot lifts strokes
		// out): nothing is put up then, and the pane's canvases stay shown.
		if (this.heldRaster !== h) return;
		host.insertBefore(clip, scroller.nextSibling);
		if (pick.clip) return;
		// The attached canvases hide with the committed pair when the tiles stand in for them; with none (a group the start view
		// shows has no current sprite) they stay shown, under the picture, as before.
		for (const c of [committed, this.highlightCanvas, ...(tiles && att ? [att.pen, att.hl] : [])]) {
			if (!c?.style) continue;
			// The resting visibility, not a pinch's own 'hidden': a pinch hides a blank canvas only for the pinch (pinchHiddenCanvases) and
			// its end puts the resting value back. Recording 'hidden' here let the take-down write it again after that restore, and the
			// highlight canvas stayed hidden after a touch pinch on a pen-only note (a later highlighter stroke painted into it unseen).
			h.hidden.push([c, this.pinchHiddenCanvases.get(c) ?? c.style.visibility]);
			c.setCssStyles({ visibility: "hidden" });
		}
	}

	/**
	 * What a zoom preview may hold up, with no side effect: the extent raster while it still holds (extentHolds), in place of the pane's
	 * canvases when the camera moved by whole device px since it was built (copyFromExtent's own test), else beside them and clipped off
	 * the start view, at its fractional offset; else the stand-in while it pictures exactly the strokes the
	 * committed layer paints (none added since: those are drawn by path, and would be hidden under it) at the shown places it was
	 * painted at (no shown move since, the extent branch's own test) and at a copy factor that fits; else, on a zoom out, the overview.
	 * `off` is the picture's device px under committed device px 0, at the committed layer's scale; `f` the picture's size factor.
	 */
	function heldRasterSource(this: InkOverlayPlugin, path: string, cam: RasterCamera, strokes: readonly InkStroke[]):
		{ src: HeldRaster["src"]; f: number; offX: number; offY: number; count: number; generation: number; shownMoves: number; world: BBox; clip: boolean } | null {
		const ext = this.extentRaster;
		if (ext && this.extentHolds(ext, cam, strokes)) {
			const k = cam.zoom * ext.backing;
			const whole = (v: number) => Number.isFinite(v) && Math.abs(v - Math.round(v)) < 1 / 16;
			const mx = (cam.x - ext.cam0.x) * k, my = (cam.y - ext.cam0.y) * k;
			const world = { x: ext.world.x0, y: ext.world.y0, width: ext.world.x1 - ext.world.x0, height: ext.world.y1 - ext.world.y0 };
			if (whole(mx) && whole(my))
				return { src: ext, f: 1, offX: Math.round(mx) - ext.kx, offY: Math.round(my) - ext.ky, count: ext.count, generation: ext.generation, shownMoves: ext.shownMoves, world, clip: false };
			// Moved off whole device px (a pan of 150 CSS px at dsf 1.37 moves it 205.5): the layer's start view is not this raster's
			// grid, so the raster goes up the overview's way, beside the pane's canvases and clipped off the start view they paint, at
			// its fractional offset. Returning null here held nothing up: an extent build drops the overview, and the stand-in lives only
			// after a landing.
			if (!Number.isFinite(mx) || !Number.isFinite(my)) return null;
			return { src: ext, f: 1, offX: mx - ext.kx, offY: my - ext.ky, count: ext.count, generation: ext.generation, shownMoves: ext.shownMoves, world, clip: true };
		}
		const backing = this.committedBacking ?? 0;
		const scaled = (at: { x: number; y: number; zoom: number }, atBacking: number) => {
			const kn = cam.zoom * backing, ko = at.zoom * atBacking, f = kn / ko;
			if (!(kn > 0) || !(ko > 0) || !Number.isFinite(f) || !standInFactorFits(f)) return null;
			const offX = (cam.x - at.x) * kn, offY = (cam.y - at.y) * kn;
			return Number.isFinite(offX) && Number.isFinite(offY) ? { f, offX, offY, ko } : null;
		};
		const st = this.standIn;
		if (st && st.path === path && st.dpr === this.dpr && st.look === inkLookKey() && st.strokes === strokes && strokes.length === st.count &&
			st.generation === inlineInk.generation(path) && st.shownMoves === this.shownMoves && this.cssScale < 1 && !(st.hl && this.highlightPairDeferred) &&
			st.pen.width !== 0 &&
			// A stand-in with no highlighter picture would hide highlighter ink the pane's own layer shows.
			(st.hl || this.highlightPairDeferred || !strokes.some(s => s.tool === "highlighter"))) {
			const at = scaled(st.at, st.backing);
			if (!at) return null;
			const world = { x: st.at.x, y: st.at.y, width: st.pen.width / at.ko, height: st.pen.height / at.ko };
			return { src: st, f: at.f, offX: at.offX, offY: at.offY, count: st.count, generation: st.generation, shownMoves: st.shownMoves, world, clip: false };
		}
		// Nothing else held: on a zoom out only (this frame's scale under the gesture's start), the overview picture, beside the pane's
		// own canvases and clipped off the start view, so it needs no highlighter picture of its own to hide anything. It holds free
		// ink only, as the extent raster does; the shown moves it is put up at are the overlay's own, so a later move takes it down.
		const ov = this.overview, anchor = this.pinchAnchor;
		if (!ov || !anchor || !(this.pinchScaleNow < anchor.fromScale) || ov.pen.width === 0 || !this.overviewHolds(ov, strokes)) return null;
		const at = scaled(ov.at, ov.backing);
		if (!at) return null;
		const world = { x: ov.at.x, y: ov.at.y, width: ov.pen.width / at.ko, height: ov.pen.height / at.ko };
		return { src: ov, f: at.f, offX: at.offX, offY: at.offY, count: ov.count, generation: ov.generation, shownMoves: this.shownMoves, world, clip: true };
	}

	/**
	 * The raster's canvases at their world place in the inner box, whose origin is the committed canvas's: committed device px d shows
	 * extent px d + off, as copyFromExtent copies it (a stand-in's px (d + off) / f, as copyFromStandIn copies it). Each takes the
	 * committed canvas's own layer box scaled by the size ratio and by f, and its transform, so both rasterise alike under either host form.
	 */
	function placeHeldRasterCanvases(this: InkOverlayPlugin, h: HeldRaster): void {
		const committed = this.committedCanvas, cw = committed.width, ch = committed.height;
		const bw = Number.parseFloat(committed.style.width), bh = Number.parseFloat(committed.style.height);
		const fx = this.cssWidth / cw, fy = this.cssHeight / ch;
		h.box = `${committed.style.width} ${committed.style.height}`;
		h.transform = committed.style.transform;
		for (const c of [h.src.hl, h.src.pen]) {
			if (!c) continue;
			// The picture's canvases are clones of the committed canvas, and a stand-in shrunk at a landing is cloned while a preview
			// hides it: the clone's own visibility is cleared here, or the sibling would hold an invisible picture.
			c.setCssStyles({
				position: "absolute", visibility: "", left: `${-h.offX * fx}px`, top: `${-h.offY * fy}px`, pointerEvents: "none",
				width: `${(bw * c.width * h.f) / cw}px`, height: `${(bh * c.height * h.f) / ch}px`, transform: h.transform, transformOrigin: h.transform ? "0 0" : "",
				opacity: c === h.src.hl ? String(HIGHLIGHTER_ALPHA) : "",
			});
		}
		// A tile at the attached layer's device px, on the committed canvas's grid: placed as the picture is at f 1, its alpha the wrapper's.
		for (const t of [...h.hlTiles, ...h.penTiles]) {
			t.c.setCssStyles({
				position: "absolute", visibility: "", left: `${t.x * fx}px`, top: `${t.y * fy}px`, pointerEvents: "none", opacity: "",
				width: `${(bw * t.c.width) / cw}px`, height: `${(bh * t.c.height) / ch}px`, transform: h.transform, transformOrigin: h.transform ? "0 0" : "",
			});
		}
	}

	/**
	 * The ink layer's translate (writeInkLayerTransform's own numbers) on the inner box, one style write when it moves. A raster no
	 * longer held (let go and not the stand-in, freed, the note's ink changed, or a shown move since put-up) comes down here instead.
	 */
	function writeHeldRaster(this: InkOverlayPlugin, x: number, y: number): void {
		const h = this.heldRaster;
		if (!h) return;
		// The raster holds free ink only: its count is the store's less the attached members it holds, which the free list's length
		// is (an erased member stays in its group's ids until the next load, so the group's id count would overcount).
		if ((h.src.pen !== this.extentRaster?.pen && h.src.pen !== this.standIn?.pen && h.src.pen !== this.overview?.pen) || h.src.pen.width === 0 ||
			inlineInk.generation(h.path) !== h.generation || this.freeStrokes(h.path).length !== h.count ||
			this.shownMoves !== h.shownMoves) { this.takeDownHeldRaster(); return; }
		const committed = this.committedCanvas;
		if (committed.style.transform !== h.transform || `${committed.style.width} ${committed.style.height}` !== h.box) this.placeHeldRasterCanvases(h);
		const band = this.container ? bandPlace(this.container) : null;
		if (!band) { this.takeDownHeldRaster(); return; }
		const t = `translate(${band.x - h.scroll.x + x}px,${band.y - h.scroll.y + y}px)`;
		if (h.inner.style.transform !== t) h.inner.style.transform = t;
	}

	/** A whole paint of the committed layer: once it really painted (not deferred to the queued frame) with no preview live, the pane's canvases show it. */
	function landHeldRaster(this: InkOverlayPlugin, deferred: boolean): void {
		if (deferred || this.pinchPreview) return;
		this.takeDownHeldRaster();
	}

	/** Down: the pane's canvases shown and the raster's moved back out, in one call. The element is kept for the next gesture. */
	function takeDownHeldRaster(this: InkOverlayPlugin): void {
		const h = this.heldRaster;
		if (!h) return;
		this.heldRaster = null;
		for (const [c, visibility] of h.hidden) c.style.visibility = visibility;
		this.heldRasterClip?.remove();
		h.src.pen.remove();
		h.src.hl?.remove();
		for (const t of [...h.penTiles, ...h.hlTiles]) t.c.remove();
		h.hlWrap?.remove();
	}

/** The container's place in the scroller from its own style (bandPlacement: whole px in left and top, the fraction in a translate). No layout read. */
function bandPlace(container: HTMLElement): { x: number; y: number } | null {
	const l = Number.parseFloat(container.style.left), t = Number.parseFloat(container.style.top);
	const m = /translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\)/.exec(container.style.transform);
	const x = l + (m ? Number(m[1]) : 0), y = t + (m ? Number(m[2]) : 0);
	return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** The held raster's element, made off the page with every style set (styles.css untouched): a clip at the scroller's padding box, one inner box. */
function makeHeldRasterClip(): HTMLElement {
	const clip = createDiv({ cls: "handwriting-ink-held" });
	// Stacked where the scroller's own ink paints (z-index 0, right after it), under the note's chrome: at the band's z-index the
	// picture painted over the zoom controls.
	clip.setCssStyles({ position: "absolute", overflow: "hidden", pointerEvents: "none", zIndex: "0" });
	clip.createDiv().setCssStyles({ position: "absolute", left: "0", top: "0" });
	return clip;
}

/** The held raster's attached highlight wrapper, made once: the tiles in it paint opaque and it carries the one alpha, as the layer does. */
function makeHeldRasterHlWrap(): HTMLElement {
	const wrap = createDiv({ cls: "handwriting-ink-held-attached-hl" });
	wrap.setCssStyles({ position: "absolute", left: "0", top: "0", pointerEvents: "none", opacity: String(HIGHLIGHTER_ALPHA) });
	return wrap;
}

export function installPaperPinch(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		refreshPinchConstraint,
		reducePinchConstraint,
		hideBlankPinchLayers,
		preparePinchComposite,
		armPinchLayerRestore,
		writePaperPan,
		beginPreviewPaper,
		writeGridBoxPan,
		traceSettlePaper,
		traceSettlePaperFrames,
		watchPaperKind,
		syncGridPaperBox,
		removeGridPaperBox,
		syncPageGuideBox,
		removePageGuideBox,
		markPageGuidesPreview,
		stopPaperKindWatch,
		clearScrollerPan,
		gridBoxPaperStyle,
		measurePreviewPaperBox,
		movePreviewPaper,
		rebasePreviewPaper,
		previewPaperReadout,
		startPinchGive,
		pinchGiveStep,
		pausePinchGive,
		resumePinchGive,
		pinchGiveFrame,
		finishPinchGive,
		updatePaperSpacing,
		writePaperVars,
		clearOwnPaperVars,
		putUpHeldRaster,
		heldRasterSource,
		placeHeldRasterCanvases,
		writeHeldRaster,
		landHeldRaster,
		takeDownHeldRaster,
	});
}
