/**
 * The note surface's paper and pinch preview methods: the preview paper box,
 * the grid paper box, the paper's pan and spacing, the pinch constraint and
 * its give, and the pinch layers. They are methods of InkOverlayPlugin,
 * installed on its prototype when InkOverlay.ts loads. The pinch gesture
 * itself and the paper and layer members a plain ink stroke calls stay in the
 * class.
 */
import { installMethods } from "./InstallMethods";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { MAX_VIEWPORT_LAYOUT } from "./PinchScale";
import { validCameraScale } from "./ZoomScale";
import { surfaceExtents } from "./SurfaceExtent";
import { paperPlan, type PaperPlan } from "./PaperPlan";
import { copyPreviewPaperBackground, foldIntoPitch, fractionOf, previewPaperCopyable, previewPaperPhase, previewPaperPitch, type PreviewPaperEnd, type PreviewPaperSource } from "./PaperPan";
import { scrollProbeExtent } from "./ScrollProbe";
import { PAN_MIN_VISIBLE_PX, PAN_FIT_SLACK_PX, OVERSCROLL_BOUNCE_MS, PAPER_PROPERTIES, type InkOverlayPlugin } from "./InkOverlay";

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
		const layers: [HTMLCanvasElement, boolean][] = [
			[this.highlightCanvas, this.highlightBlank], [this.highlightWetCanvas, this.highlightWet.provenBlank],
			[this.committedCanvas, this.committedBlank], [this.tailCanvas, this.tail.provenBlank],
		];
		const occupied = layers.filter(([,blank]) => !blank);
		if (occupied.length < 2) return false;
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
		for (const [canvas] of layers) { this.pinchHiddenCanvases.set(canvas,canvas.style.visibility);canvas.setCssStyles({ visibility: "hidden" }); }
		// The wet tile is blank here (the composite needs a blank wet layer); it hides with the rest.
		if (this.wetTileCanvas?.style) { this.pinchHiddenCanvases.set(this.wetTileCanvas,this.wetTileCanvas.style.visibility);this.wetTileCanvas.setCssStyles({ visibility: "hidden" }); }
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
		const sizer = scroller.firstElementChild === this.paperGridBox ? this.paperGridBox.nextElementSibling : scroller.firstElementChild;
		const contentW = sizer instanceof HTMLElement ? sizer.offsetLeft + sizer.offsetWidth : 0;
		const contentH = sizer instanceof HTMLElement ? sizer.offsetTop + sizer.offsetHeight : 0;
		const grantedW = Number.isFinite(this.spacerLeft) ? this.spacerLeft + 1 : 0;
		const grantedH = Number.isFinite(this.spacerTop) ? this.spacerTop + 1 : 0;
		const w = Math.max(scroller.clientWidth, contentW, grantedW);
		const h = Math.max(scroller.clientHeight, contentH, grantedH);
		const size = `${w},${h}`;
		if (size === this.paperGridBoxSize) return;
		this.paperGridBoxSize = size;
		this.paperGridBox.setCssStyles({ width: `${w}px`, height: `${h}px` });
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
	});
}
