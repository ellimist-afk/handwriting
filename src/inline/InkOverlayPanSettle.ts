/**
 * The note surface's pan settle: the pan floor and its write, the anchor that
 * settles a pan or pinch, the reanchor and the scroll the surface owns (the
 * box is in InkOverlayViewportBox.ts, the margin in InkOverlayColumnMargin.ts).
 * They are methods of InkOverlayPlugin, installed on its prototype when
 * InkOverlay.ts loads. The pan readers, and the bounce cancel, stranded-pan
 * resume and settle retire that a plain ink stroke calls, stay in the class.
 */
import { installMethods } from "./InstallMethods";
import type { SelectionRange } from "@codemirror/state";
import { contentOriginLeft } from "./ContentOrigin";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { MAX_VIEWPORT_LAYOUT } from "./PinchScale";
import { validCameraScale } from "./ZoomScale";
import { surfaceExtents } from "./SurfaceExtent";
import { scrollProbeExtent } from "./ScrollProbe";
import { settleLineApplied } from "./InkOverlayZoomApi";

/** Where the last preview frame painted the page, per settle hold, kept for the re-aim of that settle's ease on each attempt. */
const settlePaintedBefore = new WeakMap<object, { x: number; y: number }>();
/** The same capture against the editor's parent, per plugin, taken beside previewPaintedBlank (InkOverlayPinch, the settle). */
export const settlePaintedHost = new WeakMap<object, { x: number; y: number }>();
/**
 * WHERE THE PAGE IS PAINTED, against the editor's parent and not the scroller. The host transform on the editor carries
 * the scroll's sub-pixel residual (InkOverlayViewportBox, hostTransform), so the scroller itself moves when a settle
 * rounds the scroll; a read against the scroller does not see that move. Measured on the zoom round-trip cell at the
 * k 4 lift: the scroller's top went from -1.17 at the capture to 1.33 at the landing, and an ease taken against it
 * started the page 2.5 px off the last preview frame.
 */
export function settleHostBlank(view: { contentDOM: HTMLElement; scrollDOM: HTMLElement; dom: HTMLElement }): { x: number; y: number } {
	const content = view.contentDOM.getBoundingClientRect(), host = (view.dom.parentElement ?? view.scrollDOM).getBoundingClientRect();
	return { x: content.left - host.left, y: content.top - host.top };
}
import { PAN_MIN_VISIBLE_PX, PAN_DRAG_SCALE_EPS, PAN_DRAG_FRAME_EPS, PAN_DRAG_WINDOW, PAN_FIT_SLACK_PX, PAN_SETTLE_ZOOM_BAND, OVERSCROLL_GIVE_PX, gutterPanMode, onDeviceGrid, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		panFloor(room: number, extent: number): number;
		writeViewportPan(deferPaper?: boolean): void;
		observeAboveContent(): void;
		anchorPanTo(next: number, a: { focalX: number; focalY: number; targetX?: number; targetY?: number; hostLeft: number; hostTop: number; columnLocal: number | null; contentTopLocal: number | null; fromScale: number; scrollLeft: number; scrollTop: number }, columnLocal: number | null, contentTopLocal?: number | null, settleBound?: boolean, settling?: boolean): void;
		settleBlank(): { x: number; y: number };
		panAxisWindow(size: number, span: number): { fits: boolean; min: number; max: number };
		dragGateReadout(): { dragFrame: boolean; neverZoomed: boolean; steady: boolean; next: number; fromScale: number; fromScaleValid: boolean; rawX: number; cx: number; rawY: number; cy: number; restCeilX: number; startX: number; startY: number; lastX: number; lastY: number; bounded: boolean; settling: boolean; floorX: number; floorY: number };
		panFitReadout(): { fitsX: boolean; fitsY: boolean; contentX: number; contentY: number; viewportX: number; viewportY: number; boundHits: number; boundMaxPx: number };
		reanchorPan(): void;
		ownScrollRange(range: SelectionRange, owner: object): SelectionRange | null;
		consumeViewportScroll(range: SelectionRange): boolean;
		ownsPanSettle(hold: NonNullable<InkOverlayPlugin["panAnchorHold"]>): boolean;
		clearViewportPan(): void;
		columnMarginLocal(layout: NonNullable<InkOverlayPlugin["viewportLayout"]>): number | null;
	}
}

	/** The far end's floor, negative where the page is bigger than its room (room - extent), 0 where it fits. */
	function panFloor(this: InkOverlayPlugin, room: number, extent: number): number {
		return Math.min(0, room - extent);
	}

	/**
	 * The pan goes on the SCROLLER'S CHILDREN, never on the host and never on
	 * the scroller.
	 *
	 * The host contains the scroller, so panning the host moves the scroller's
	 * own box off the pane - and a pointer at a fixed client point then lands
	 * outside the hit surface entirely. That is the low-zoom input-death class,
	 * where the pen stops reaching the note at all; measured on the first
	 * attempt as "input outside scroller 710,350" at 0.1 zoom. Translating the
	 * children instead leaves the scroller exactly where it was, so it stays the
	 * hit surface at every scale.
	 *
	 * BOTH children, at the same level, or the cure is worse than the disease.
	 * `.cm-sizer` carries the text; the ink rides on the layer inside the band.
	 * Panning one without the other would slide ink across the words, which is
	 * the defect this whole lane exists to fix. Moving them together is also why
	 * this is invisible to the written-ink drift guard: that measures the ink
	 * canvas RELATIVE TO a `.cm-line`, and a shared translate cancels out of a
	 * difference.
	 *
	 * THE BAND ITSELF IS NOT TOUCHED, and that is load-bearing rather than
	 * incidental: `syncCamera` derives the camera from
	 * `this.container.getBoundingClientRect()`, so a pan on the band is absorbed
	 * into the camera and then applied a second time by the transform. Measured
	 * with the band carrying it: the focal drift went from 2.25/3.14 to
	 * 11.86/16.02/4.11 against a 2px threshold.
	 */
	function writeViewportPan(this: InkOverlayPlugin, deferPaper = false): void {
		const k = this.cssScale;
		const s = Number.isFinite(k) && k > 0 ? 1 / k : 0;
		const x = this.panX() * s, y = this.panY() * s;
		const sizer = this.panSizer();
		const translate = x === 0 && y === 0 ? "" : `translate(${x}px,${y}px)`;
		let gutters = this.panGuttersEl;
		if (!gutters?.isConnected) {
			// Stock CodeMirror keeps the gutters beside the sizer; Obsidian nests them in `.cm-contentContainer`.
			gutters = this.panGuttersEl = this.view?.scrollDOM?.querySelector?.<HTMLElement>(
				":scope > .cm-gutters, :scope > .cm-sizer > .cm-contentContainer > .cm-gutters") ?? null;
			this.panGuttersWritten = "";
		}
		// Re-read after an empty pan or a column margin write cleared it; the read holds with the sizer already panned.
		if (translate !== "" && this.panGuttersMode === null && gutters) {
			this.panGuttersMode = gutterPanMode(sizer, gutters, this.view?.scrollDOM);
		}
		if (sizer?.style) sizer.style.transform = translate;
		const mode = this.panGuttersMode;
		const gutterTransform = translate === "" || !mode ? "" : mode.kind === "ride" ? translate : mode.kind === "counter" ? mode.translate : "";
		if (gutters?.style && gutterTransform !== this.panGuttersWritten) {
			gutters.style.transform = gutterTransform;
			this.panGuttersWritten = gutterTransform;
		}
		if (translate === "") this.panGuttersMode = null;
		// The sizer and ink layer above are stamped either way - a caller that defers the paper still needs the
		// scale it just changed reflected on those. Only the preview paper's own write can wait for anchorPanTo,
		// which runs synchronously before paint on the one caller that passes true (the live pinch frame).
		if (deferPaper) this.previewPaperBoxDirty = true;
		else this.writePaperPan();
		this.writeInkLayerTransform();
	}

	/**
	 * THE CONTENT'S TOP MOVES WHEN A BLOCK ABOVE IT REWRAPS, and a pinch preview
	 * does not look. During a live pinch `syncCamera` and the camera re-read are
	 * deferred (deferPinchRaster) and the committed raster is reused, so the ink
	 * keeps the content top it was drawn at. The inline title (and properties)
	 * sit in `.cm-sizer` above `.cm-contentContainer`, in normal flow: the pinch
	 * narrows the host, the title gains or loses a line, and every text line
	 * moves by that line's height at once while the ink does not - 25 note px
	 * per title line in the fixture, until the gesture ends.
	 *
	 * NO READ PER FRAME. A ResizeObserver delivers each watched block's new
	 * border-box size after the layout that changed it, before paint, with no
	 * forced layout of its own; a delivered HEIGHT difference is added to the
	 * preview raster's vertical offset through the one transform writer. The
	 * delivery is per frame, not per rewrap: the observer fires whenever the
	 * box changes, width included, and a pinch narrows the title on every
	 * frame. Measured on the render fixture (Readable line length off): 30
	 * callbacks over a 30-frame pinch, 0.2 ms of callback time in total, none
	 * during the settle. The callback only compares heights, so the transform
	 * write happens once per rewrap (2 in a gesture that rewraps twice).
	 * Outside a preview the new height is recorded and nothing moves: the
	 * ordinary camera path already reads the content's top.
	 *
	 * RECONCILED WHERE THE COLUMN OFFSET IS: the settle and a mid-gesture
	 * repaint redraw the raster against the moved content and clear both
	 * offsets together (clearPreviewInkOffset).
	 *
	 * The blocks are the sizer's children before the content container, taken
	 * at takeover; a block added later (properties appearing) is picked up at
	 * the next takeover, and until then a rewrap inside it is the old behaviour.
	 */
	function observeAboveContent(this: InkOverlayPlugin): void {
		if (this.aboveContentObserver || typeof ResizeObserver !== "function") return;
		const sizer = this.panSizer();
		const container = this.view?.contentDOM?.parentElement;
		if (!sizer || !container || container.parentElement !== sizer) return;
		const blocks: Element[] = [];
		for (let el = sizer.firstElementChild; el && el !== container; el = el.nextElementSibling) blocks.push(el);
		if (!blocks.length) return;
		this.aboveContentHeights = new WeakMap();
		const observer = new ResizeObserver(entries => {
			let dH = 0;
			for (const entry of entries) {
				const box = entry.borderBoxSize?.[0];
				const height = box ? box.blockSize : entry.contentRect.height;
				const before = this.aboveContentHeights.get(entry.target);
				this.aboveContentHeights.set(entry.target, height);
				if (before !== undefined) dH += height - before;
			}
			if (dH === 0 || !this.pinchPreview) return;
			this.previewInkOffsetY = (this.previewInkOffsetY || 0) + dH;
			this.aboveContentShifts = (this.aboveContentShifts || 0) + 1;
			this.writeInkLayerTransform();
			// The paper moves with the text too, on its own account: its shift is spent where the origin is next
			// re-measured (capturePaperOrigin), not where the ink's raster is redrawn.
			this.paperRewrapY += dH;
			this.writePaperPan();
		});
		for (const block of blocks) observer.observe(block);
		this.aboveContentObserver = observer;
	}

	/**
	 * Hold the note under the fingers, for this frame, with a translate.
	 *
	 * THE ONE INVARIANT: the note point that was under the focal point when the
	 * gesture started is still under it now. Written as an ABSOLUTE target and
	 * not as an increment - every term comes from an element the pan is not
	 * written to, or has had the live pan taken back out of it, so the answer is
	 * the whole pan rather than a correction to it. That is what makes a
	 * `syncCamera` during a deferral lapse (a pause past PINCH_SCROLL_QUIET_MS)
	 * harmless: there is no state here for it to absorb and re-apply, and a
	 * suppressed or re-derived frame cannot accumulate into the next.
	 *
	 * Horizontally the anchored point is held COLUMN-RELATIVE. Host-local is not
	 * a fixed frame: with Readable line length on, `.cm-sizer`'s auto margins
	 * re-centre the column inside the counter-sized host, so one note point has
	 * a different host-local x at every scale. `p` below - the point's offset
	 * from the column's left edge - does not, at any scale or scroll.
	 *
	 * Vertically there is no column, and none is needed: the content's top is a
	 * constant host-local offset while the scroll is constant, and a constant
	 * cancels out of the difference entirely. That is why the per-frame path
	 * reads the host's origin and nothing else for y.
	 */
	function anchorPanTo(this: InkOverlayPlugin,
		next: number,
		a: { focalX: number; focalY: number; targetX?: number; targetY?: number; hostLeft: number; hostTop: number; columnLocal: number | null; contentTopLocal: number | null; fromScale: number; scrollLeft: number; scrollTop: number },
		columnLocal: number | null,
		contentTopLocal?: number | null,
		/** Only the settle of a gesture that changed the scale asks for the fitting bound; a preview frame must keep the note under the focal point. */
		settleBound = false,
		/** Every settle, drag or zoom (the settle runs with the preview down): a centred column that fits goes back to its rest (columnRestPan). */
		settling = !this.pinchPreview
	): void {
		if (!validCameraScale(next) || !validCameraScale(a.fromScale)) return;
		// NO SIZER, NO PAN. The text half of the pan goes on `.cm-sizer`; a
		// surface without one takes the ink half and nothing else, which is ink
		// sliding off the words - the very defect this lane exists to fix.
		//
		// It is also unrecoverable rather than merely partial. Every term here
		// is measured against a column that has had the LIVE pan subtracted from
		// it, on the understanding that the column carries that pan; when it does
		// not, each frame subtracts a displacement the text never received and
		// asks for it again on top. Measured on the edge-audit fixture, whose
		// editor has no sizer: a 0.2 -> 0.1 pinch with identical inputs on every
		// frame walked the column read 0, -1612.5, -3225, -4837.5, -6160 and the
		// pan 161.25, 322.5, 483.75, 616 (clamped), 616 - a pane-sized
		// displacement out of a gesture that needed 161. Refusing here leaves
		// `previewPanEngaged` false. Preview remains scale-only on such hosts;
		// settle uses the existing `anchoredScroll` fallback.
		if (!this.panSizer()) return;
		const origin = this.previewHostOrigin;
		// The unit fixtures drive `pinch` against partial objects built with
		// Object.create, which reach the methods but not the class fields.
		const pan = this.viewportPan;
		if (!origin?.valid || !pan) return;
		// THE VERTICAL ORIGIN IS MEASURED, every frame, and the closed form it
		// replaces is worth naming because it looks right and is not. That form
		// assumed the content's top is a fixed host-local offset for the whole
		// gesture, on the grounds that no preview frame writes the scroll. The
		// scroll moves anyway, for two reasons a `scrollTop` delta cannot tell
		// apart: zooming OUT grows the scroller's client box inside the
		// counter-sized host, the reachable range shrinks with it and the browser
		// clamps `scrollTop` down - the content really has moved; zooming IN makes
		// CodeMirror re-anchor its own scroll to hold the visible text still - the
		// content has NOT moved, and correcting for that scroll is pure error.
		// Measured on the render fixture at scrollTop 2000: the closed form alone
		// left 9.60px on the zoom-out arms, and the scroll-delta correction that
		// fixes those put 144px on the zoom-in ones. The rect answers both.
		//
		// The cost is ONE `getBoundingClientRect` on `.cm-content` and NO extra
		// forced layout: `columnLocalAt` has already flushed the layout on this
		// frame, so this reads a clean tree. Callers with nothing to measure pass
		// null and get the closed form, which is exact for them.
		const y = contentTopLocal !== undefined && contentTopLocal !== null && a.contentTopLocal !== null
			? (a.targetY ?? a.focalY) - (origin.top + (contentTopLocal + ((a.focalY - a.hostTop) / a.fromScale - a.contentTopLocal)) * next)
			: (a.targetY ?? a.focalY) - origin.top - (a.focalY - a.hostTop) * (next / a.fromScale);
		// Without a column measurement at BOTH ends there is no column-relative
		// frame to hold, and a host-local fallback would silently reintroduce
		// the centring term. Hold y, leave x where it is: a partial anchor is
		// visible, a wrong one is a drift nobody can attribute.
		const x = columnLocal === null || a.columnLocal === null
			? pan.x
			: (a.targetX ?? a.focalX) - (origin.left + (columnLocal + ((a.focalX - a.hostLeft) / a.fromScale - a.columnLocal)) * next);
		// THE PAPER'S SHARE OF THE COLUMN'S RE-CENTRING. `x` holds the text column under the fingers, so while the column
		// re-centres inside the host (Readable line length under a zoom-in) the text moves against the scroller by exactly
		// that re-centring, in the painted px this formula uses, and the paper, which lives on the scroller, moves with
		// it. Preview frames only: the settle re-measures the origin instead (capturePaperOrigin).
		// THE SCROLL TAKEN UNDER THE FINGERS IS NOT RE-CENTRING. The column is read off a client rect, so a scroll of s
		// layout px moves columnLocal by s outer px, and the preview paper's offset already takes that scroll through
		// paperScrollLeft. Counted in both, the vertical rules slid off the column by the scroll times the zoom: 6 device
		// px at dpr 2 for a 3 px touch scroll during a pinch (GridPinchMidPage, the scrolled-sideways arms). The scroll's
		// share is put back here, in outer px and before the multiplication by the scale, the convention of the settle.
		const nativeLeft = this.view.scrollDOM.scrollLeft, nativeTop = this.view.scrollDOM.scrollTop;
		let paperDriftMoved = false;
		if (this.pinchPreview) {
			const outer = this.viewportLayout?.externalScale ?? 1;
			const drift = columnLocal === null || a.columnLocal === null ? 0 : (columnLocal - a.columnLocal + (nativeLeft - a.scrollLeft) * outer) * next;
			paperDriftMoved = Number.isFinite(drift) && drift !== this.paperColumnDrift;
			if (paperDriftMoved) this.paperColumnDrift = drift;
		}
		// KEEP THE NOTE ON THE PANE. The translate has no clamp of its own and
		// the scroller does not move with it, so an unbounded pan can carry the
		// whole note off screen with nothing to bring it back.
		const layout = this.viewportLayout;
		const bx = layout ? Math.max(0, layout.paneWidth * layout.externalScale - PAN_MIN_VISIBLE_PX) : MAX_VIEWPORT_LAYOUT;
		const by = layout ? Math.max(0, layout.paneHeight * layout.externalScale - PAN_MIN_VISIBLE_PX) : MAX_VIEWPORT_LAYOUT;
		const path = this.filePath(), extent = path ? surfaceExtents.get(path) : { x: 0, y: 0 };
		const effective = layout ? next * layout.externalScale : next;
		// Bound the NOTE's visible overlap, not the translation's magnitude.
		// After scrolling, a pan larger than the pane can still leave the note
		// covering it. A symmetric pane-sized clamp broke the next zoom there.
		const left = columnLocal === null ? 0 : columnLocal * next;
		const top = contentTopLocal == null ? 0 : contentTopLocal * next;
		const width = Math.max(layout?.columnBox ?? 0, extent.x * this.fontZoom) * effective;
		const height = Math.max(this.view.contentHeight, extent.y * this.fontZoom) * effective;
		const minX = width > 0 ? PAN_MIN_VISIBLE_PX - left - width : -bx;
		const minY = height > 0 ? PAN_MIN_VISIBLE_PX - top - height : -by;
		// Only native scroll may be spent into right/down pan. At scroll zero
		// the content stays at its natural inset, including column/title margins.
		// Use the same origin-first precedence as the ordered input reducer.
		// The preview paper's offset is taken against this scroll (zooming out clamps it); the read is this frame's already.
		if (this.previewPaperEl) { this.paperScrollLeft = nativeLeft; this.paperScrollTop = nativeTop; }
		// The scroller's CONTENT box: the page is laid out inside it, and the scrollbar is not room the column may use.
		// PREVIEW-TOUCHING (anchorPanTo, called at :5620 inside the preview frame body), so this reads the
		// LAST STORED gutterScreen. Staleness bound: one gesture - it is refreshed at every settle, and a
		// gesture's previews sit between two settles. Preview carries no width test since 24649b64, so the
		// pan window is the only consumer of this span here.
		const spanX = layout ? layout.width * layout.externalScale - layout.gutterScreen : NaN;
		// EXCEPT A COLUMN INSET THAT FITS. With Readable line length on, the blank either side of the column is the setting's
		// centring, not the note's origin edge, and the column's margin is frozen in host px (styles.css, the note viewport's
		// sizer), so at scroll zero the cap above anchored every zoom-out at the pane's left edge: the column slid out from
		// under the fingers while they were down, measured 524 px at 25% about the pane's centre. Where the column fits the
		// pane, the pan may carry it right as far as the pane's own edge - the settle's fitting window - so the fingers keep
		// it. Readable line length off has no inset (columnRestPan is null) and keeps the cap.
		// THE KEY IS THE FIT, not how a theme spells its column: where the page's own box sits inside the pane, the blank
		// beside it is the room a readable width leaves and the pan may carry the page right as far as the pane's edge.
		// SUPERSEDED (Alan, direct: "just get rid of the settle. page is where you leave it"). The
		// settle no longer has a rest to return to, so `rest`/`columnRestPan` and the `fitsX` room-beside-
		// the-column question they were asked with are both gone from this path. `columnRestPan` itself
		// stays: the scroll-zero path above still reads it.
		// THE SAME QUESTION, ASKED AGAIN ONE STEP LATER. `reducePinchConstraint` frees the target; this bound
		// then decides whether the pan may reach it. `width` is the page OR the room Infinite Canvas has
		// granted around it, whichever is larger - right for the overlap bound above, wrong here - so with
		// the setting on `fitsX` went false and the ceiling collapsed to the scroller's own position, which
		// is 0 because no preview frame writes the scroll. Freeing the target alone does nothing: measured,
		// reverting this line while keeping the constraint fix put all eight frames back, the full 786.09 px.
		// Both terms are the same mistake about the same quantity, one step apart.
		const pageX = this.pageContentWidth() * effective;
		const fitsPageX = (layout?.columnInset ?? false) && pageX > 0 && Number.isFinite(spanX) && pageX <= spanX + PAN_FIT_SLACK_PX;
		// PREVIEW AND SETTLE ALIKE. The settle was left on `fitsX` on the understanding that the commit
		// would convert the pan into scroll, so a refused ceiling there cost nothing. It does not: at the
		// commit the conversion wants scrollLeft -3144.375 from a scroller sitting at 0, because the pan
		// carried the page RIGHT and the scroll that would hold it is BELOW zero - a direction that does
		// not exist. `maxScrollLeft` is 0 at that moment (the 4796 in the frame sample is read after the
		// commit re-grants extent), so there is no range in any direction to spend it into either.
		//
		// The refused remainder is meant to come back as pan here, and this bound is what threw it away:
		// measured at the settle, x wanted 786.09, `fitsX` false on width 2496 against span 1383, ceiling
		// 0, pan 0 - the page dropped the whole hold in one frame. The page's own box is 175. The setting-
		// off arm, asking the same question of the same page, carries 267.66 against a ceiling of 604.26
		// and eases onto its rest.
		//
		// `restX` deliberately still reads `fitsX`: whether a page with room granted beside it returns to
		// the centred rest is Alan's open question, and `columnRestPan` is null in that regime anyway.
		// This changes what the settle may HOLD, not where it decides to land.
		// SETTLE ONLY. While the fingers are down there is no ceiling at all: the preview pays in pan
		// whatever the page's width, and the settle - which is where this bound belongs - eases to a
		// position it computes from the true content box. Measured with a ceiling still in the preview
		// path on an inked note: 7 frames off, up to 925.95 px, because a page wider than the pane was
		// refused the pan and nothing else carries it mid-gesture.
		const carriesX = fitsPageX;
		const carryWidth = pageX;
		// UNDER INFINITE CANVAS THE SETTLE'S TARGET IS B CLAMPED TO THE WORLD:
		// the page stays where the fingers left it, and the one thing it may not keep is blank to the LEFT
		// of its own natural margin. Infinite Canvas grants room to the right and below - room the user is
		// entitled to - and nothing is ever granted left of the natural margin, so blank there is not canvas.
		//
		// This ceiling was +Infinity here, which is what left 200 px of margin standing on the pane after
		// the page had settled: measured at e27fbcf0, zoom-out-settled and reachable-settled both 200.00 on
		// corner / Readable line length on / Infinite Canvas on, and the same shape on every setting-on cell
		// of the family. With the setting OFF no *-settled row was ever red, which is the asymmetry that
		// names the cause: the clamp is missing on one side of a boolean, not wrong everywhere.
		//
		// THE EDGE HALF ONLY, never the centring half. The ceiling is the natural margin itself, so the ease
		// travels the MINIMUM distance that closes the exposure and stops there; a page that settles inside
		// the world is not touched, which is what keeps B. The fitting window's re-centring stays off under
		// the setting - that is what jumped an inked note 907.69 px when it was applied here, and it is a
		// different question from the edge.
		//
		// Y already reads exactly this way one line below, unconditionally, and no *-settled row on the Y
		// axis was ever red. X is now the same shape.
		//
		// With the setting OFF the ceiling is the no-room law and stays: the page eases back to the
		// position the bounds allow, which is what ships today.
		const rightX = !settling ? Number.POSITIVE_INFINITY
			: this.canvasMode ? nativeLeft * effective
			: carriesX ? Math.max(nativeLeft * effective, -left + Math.max(0, spanX - carryWidth)) : nativeLeft * effective;
		// Y TAKES THE SAME SHAPE, and the reason the older note here gave for exempting it does not survive the
		// measurement. That note said a hold carried down through the preview came back as a jump at the lift, so
		// y kept its cap on every frame. The jump it describes is not the cap's absence - it is the cap's
		// correction never reaching the ease, which is fixed one screen below. With the correction delivered, the
		// preview may hold the page under the fingers on y exactly as it does on x, and the settle closes it.
		// Measured at 678b74e2 on an Infinite-Canvas-on cell, fingers down: y = 450.000 asked, nativeTop * effective
		// = 0.000, rawY = 0.000. The cap ate the whole request on every preview frame, which is why the page did not
		// move vertically at all and `reverse-75` read 0 instead of -75.
		const bottomY = !settling ? Number.POSITIVE_INFINITY : nativeTop * effective;
		// THE POSITION BEFORE THE EDGE CAP, kept on both axes because the ease needs it. The difference between it
		// and the committed pan IS the correction the edge applied, and that difference is what the bounce travels.
		const uncappedX = columnLocal !== null && Number.isFinite(nativeLeft)
			? Math.max(this.canvasMode ? (nativeLeft - MAX_VIEWPORT_LAYOUT) * effective : minX, x) : pan.x;
		const uncappedY = contentTopLocal != null && Number.isFinite(nativeTop)
			? Math.max(this.canvasMode ? (nativeTop - MAX_VIEWPORT_LAYOUT) * effective : minY, y) : pan.y;
		const rawX = columnLocal !== null && Number.isFinite(nativeLeft) ? Math.min(rightX, uncappedX) : pan.x;
		const rawY = contentTopLocal != null && Number.isFinite(nativeTop) ? Math.min(bottomY, uncappedY) : pan.y;
		// THE SETTLE'S TARGET, and only it: where the page fits the viewport on an axis, the pan it lands on is held to
		// the TIGHTER of what this bound already allows and the page's own box inside the pane (panAxisWindow). The
		// gesture's own frames are not touched - the note stays under the focal point while the fingers are down.
		// SEVENTH SITE, and the last of them: the settle's pan window. It is the third clamp on the same
		// frame, and under Infinite Canvas it is off for the same reason as the other two - there the
		// settle's target IS where the fingers left it, so nothing may pull the page off it.
		// Measured on a fresh note, setting on, Readable line length off: the pan needed to hold the
		// fingers was 786.09, nothing else clamped it, and this window cut it to 615.01 - exactly the
		// 171.08 px the page missed B by. Routing it through the page box instead of the granted extent
		// fixed that arm and broke two others, because with ink the page box is nearly the whole span
		// and the window then closed to ~27 px: B went to -925.94 with the page easing 24.16 px after
		// the lift. The width was never the question on this path; the SETTING is.
		//
		// THE WINDOW IS GONE WITH THE SETTLE. Its two jobs were the fitting clamp, which Alan removed
		// outright, and the near-side bound, which was kept and which `-left`/`-top` state directly below
		// without a fits test and without a max side. `panAxisWindow` itself stays: `panFitReadout` and the
		// preview paths still read it.
		// THE ONE BOUND ALAN KEPT, and nothing else. "Bounded by the top and left": the
		// drawing canvas's own left and top edge may not come to rest inside the pane. No rest, no fitting
		// clamp, no margin payment, nothing at the right or bottom, in every regime.
		//
		// A CEILING ON THE PAN, not a floor, and the ceiling is the HOST'S OWN LAYOUT: pan 0. Positive pan
		// carries the page right of where the layout puts it, which is the blank Alan's bound forbids;
		// negative pan is the hang past the pane, which he allows. So `Math.min(raw, 0)` per axis.
		//
		// NOT `-left`, which is the PANE edge. With Readable line
		// length on, `left = columnLocal * next` is the column's native margin and is positive, so a bound
		// at `-left` would drag the column out of its margin and onto the pane edge at every lift - Alan's
		// "jumps left". With the setting off `left` is 0 and the two forms are the same expression.
		//
		// SETTLE ONLY, on `settling` - the gate `rawX`/`rawY` themselves take through `rightX`/`bottomY`.
		// `settleBound` is narrower, true only for the lift of a gesture that changed the scale, and the
		// bound is owed at every settle. A preview frame keeps the note under the fingers, untouched.
		const bounded = settling && columnLocal !== null && contentTopLocal != null;
		// THE FAR END EASES BACK, "like OneNote's bounce back" (Alan direct). A page
		// pushed past the far end of its room stays where the fingers left it at the lift, then
		// eases back until it is within its room - the ceiling above is unchanged, the bound is now
		// two-sided. floor = 0 where the page fits its room already (Infinite Canvas off, room is
		// bx/by against the page's own width/height); floor = room - extent, negative, where the
		// page is bigger than its room, so the far edge may still come to rest flush with the pane.
		// IC on keeps the ceiling-only bound 3578f29e had. IC off only, the floor.
		const floorX = this.panFloor(bx, width);
		const floorY = this.panFloor(by, height);
		// Read-only: the bound's own numbers, so a cell can derive the rest
		// puts the page on instead of pinning a measured constant. Four property writes, no read.
		this.boundReadout.floorX = floorX; this.boundReadout.floorY = floorY;
		this.boundReadout.bx = bx; this.boundReadout.width = width;
		// THE PREVIEW GETS THE SAME BOUND, PLUS THE GIVE. Measured at 4e4738f8 on this file's two
		// allowance rows: a preview frame had no near-side bound of any kind, so the committed pan WAS the
		// geometric ask - drift 0.00, margin 0.00 and raw == ask on all 60 preview frames of both arms, the
		// page following the fingers to -391.55 and 381.60 against a floor of -50.49 and a ceiling of 0.
		// Alan's contract is that it stops: the same two-sided bound the settle takes, widened by the give,
		// so the page passes its room by the allowance and no further, and the lift's existing bounce eases
		// that give back to the bound itself.
		//
		// A DRAG ONLY, and Infinite Canvas off only. A frame that is changing the scale keeps the note under
		// the focal point with no bound - `PAN_DRAG_SCALE_EPS` is what separates the two, and skipping that
		// gate is what broke the focal hold at 3884c642. With Infinite Canvas on the preview stays exactly as
		// it was, for the same reason the settle's floor is off there: the page is where the fingers
		// left it and nothing may pull it off that.
		const give = OVERSCROLL_GIVE_PX * (layout?.externalScale ?? 1);
		// A frame is a drag frame when the scale has held over the last PAN_DRAG_WINDOW frames (within
		// PAN_DRAG_FRAME_EPS of the scale that many frames ago), whatever the gesture did before. A zoom, even a
		// slow one, moves more than that over the window and keeps the note under the focal point with no
		// bound; a held spread does not.
		let steady = false;
		if (!settling) {
			const h = this.pinchBand.history;
			if (h.length === PAN_DRAG_WINDOW) steady = validCameraScale(h[0]!) && Math.abs(next / h[0]! - 1) < PAN_DRAG_FRAME_EPS;
			h.push(next);
			if (h.length > PAN_DRAG_WINDOW) h.shift();
		}
		// A gesture that has never zoomed (within PAN_DRAG_SCALE_EPS of its start) is a drag from its first frame,
		// as before; the window is what catches a drag AFTER a zoom in the same gesture.
		const neverZoomed = validCameraScale(a.fromScale) && Math.abs(next / a.fromScale - 1) < PAN_DRAG_SCALE_EPS;
		// A drag frame in EITHER mode; the bound it takes below is what the mode decides.
		const dragFrame = !settling && Number.isFinite(give) &&
			columnLocal !== null && contentTopLocal != null && (neverZoomed || steady);
		// THE X CEILING IS THE COLUMN'S OWN REST, not 0. With Readable line length on and a
		// column that fits, the settle leaves the page on a centred rest whose pan is not zero, and a ceiling
		// of 0 + give pulls that legitimate rest back and hands the difference to the bounce - measured as the
		// "next touch does not bounce" cell of RllColumnFocalHold going red, a file that is 24/24 green
		// without this band. `columnRestPan` is arithmetic on this path, no forced read on a preview frame,
		// and is null everywhere the rest is 0, so the `?? 0` is the old form unchanged. Computed on a drag
		// frame only, so a zoom frame pays nothing.
		const restCeilX = dragFrame ? (this.columnRestPan(next, effective) ?? 0) : 0;
		// THE BAND STOPS TRAVEL, IT NEVER MOVES A RESTING PAGE. Measured after a zoom-button
		// commit to 50% with Readable line length on: viewportPan.x was 0 and the next touch still bounced,
		// because the ceiling clamped a frame the page was already legally sitting on. The last frame's pan
		// below keeps that page where it stands. THE ALLOWANCE IS MEASURED FROM THE BOUND, NOT FROM THE START:
		// a regrab mid-spring starts on the pan the cancelled spring folded in, and a ceiling of start plus the
		// allowance let each regrab go a further allowance out, so sixty regrabs walked the page more than a
		// thousand px past its top and left (the one-finger pull was fixed for the same walk on 2026-09-20).
		// The start pan is kept for the readout only.
		const startX = Number.isFinite(this.pinchStartPan.x) ? this.pinchStartPan.x : 0;
		const startY = Number.isFinite(this.pinchStartPan.y) ? this.pinchStartPan.y : 0;
		// The band's edges are widened to where the page ALREADY stands (the last frame's pan), so
		// engaging mid-gesture moves nothing; travel back inside the band is always allowed.
		const lastX = this.pinchBand.lastPan.x, lastY = this.pinchBand.lastPan.y;
		// CEILING SIDE ONLY. The band's floor term was the far end's give, and in canvas mode the far
		// side is room the page grows into, not a boundary - measured, the grow rule keeps headroom ahead of
		// the frontier on both axes, so there is nothing there to spring back from. The ceiling side is the
		// page's own origin edge, which the direction check measured as the POSITIVE side (a finger dragging
		// right at scrollLeft 0 pulls +96).
		// CANVAS OFF TAKES THE PLAIN BOUND ON A DRAG FRAME, floor and ceiling, no give. Leaving the
		// preview unbounded there drifted the page 21.21 px past the fingers on a fitting page (measured, every
		// travel, ScrollColumnAnchorPinch tiny arm), and stock scrolling is exactly "the page never moves where
		// the fingers did not ask". A bound that stops at the edge also leaves the settle nothing to close.
		const plainX = Math.max(floorX, Math.min(rawX, 0)), plainY = Math.max(floorY, Math.min(rawY, 0));
		// A NON-DRAG FRAME IS UNTOUCHED IN BOTH MODES: a zoom frame keeps the note under the focal point and
		// carries no bound of its own, which is what the focal-hold cells measure.
		// THE SETTLE'S CORRECTION IS A WHOLE NUMBER OF DEVICE PX. The scroll commit rounds, so the pan it
		// leaves can sit a fraction of a px past the bound; clamping that fraction away moved the text by
		// 0.633 px at 150 percent, off the device grid the ink is rastered on, and the ink then read a
		// quarter px off its line. The correction is the largest whole number of device px not above the exact
		// clamp move, so the page keeps the grid it was on and never moves further than the bound asked; it can
		// rest under one device px past the bound, which is not a visible overscroll. Settle only; preview and
		// drag frames are untouched.
		const cx = bounded ? onDeviceGrid(rawX, this.canvasMode ? Math.min(rawX, 0) : plainX, this.dpr)
			: dragFrame ? (this.canvasMode ? Math.min(rawX, Math.max(restCeilX + give, lastX)) : plainX)
			: rawX;
		const cy = bounded ? onDeviceGrid(rawY, this.canvasMode ? Math.min(rawY, 0) : plainY, this.dpr)
			: dragFrame ? (this.canvasMode ? Math.min(rawY, Math.max(give, lastY)) : plainY)
			: rawY;
		if (!settling) { this.pinchBand.lastPan.x = cx; this.pinchBand.lastPan.y = cy; }
		this.boundReadout.rawX = rawX; this.boundReadout.cx = cx; this.boundReadout.rawY = rawY; this.boundReadout.cy = cy;
		this.boundReadout.dragFrame = dragFrame; this.boundReadout.neverZoomed = neverZoomed; this.boundReadout.steady = steady;
		this.boundReadout.next = next; this.boundReadout.fromScale = a.fromScale; this.boundReadout.fromScaleValid = validCameraScale(a.fromScale);
		this.boundReadout.restCeilX = restCeilX; this.boundReadout.startX = startX; this.boundReadout.startY = startY;
		this.boundReadout.lastX = lastX; this.boundReadout.lastY = lastY; this.boundReadout.bounded = bounded; this.boundReadout.settling = settling;
		if (bounded) {
			this.notePanBound(cx !== rawX, rawX, cx);
			this.notePanBound(cy !== rawY, rawY, cy);
		}
		if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
		this.previewPanEngaged = true;
		// The clamp's correction becomes the bounce: the page starts where the gesture left it and eases onto its rest.
		// EVERY CORRECTION ON THE AXIS, not only the window's. The edge cap (`rightX`, `bottomY`) also moves the
		// committed pan, and its correction was not handed over - so at the lift the page did not ease closed, it
		// SNAPPED. Measured at 678b74e2 on an Infinite-Canvas-on cell at the lift: x = 200.000 asked, rightX = 0,
		// cx = 0.000, and the bounce was handed 0.000 - the whole 200 px closed in one frame. On the screen that is
		// 200 px of blank held open while the fingers are down and then swallowed in a single frame at the lift,
		// where the rule says the page holds under the fingers and eases closed.
		// Measuring the correction from the position BEFORE the cap covers both: where only the window moved the
		// pan, `uncapped` equals `raw` and this is the old expression; where the edge moved it, the edge's share is
		// now included; where nothing moved it, the difference is zero and no bounce starts.
		// ANY SETTLE WITH A CORRECTION EASES. The gate this replaces was `settleBound || restX` - the fitting
		// window, or the rest. Both are real reasons to ease and neither is the only one: the edge caps
		// (`rightX`, `bottomY`) also move the committed pan, and on a drag settle they are the ONLY thing that
		// moves it, so those arms were refused the call outright. Measured on an Infinite-Canvas-on cell with
		// the corrections already delivered: `repeat-0-lift` and `reachable-lift` ran with settling true,
		// settleBound false, a correction of 450.00 and 200.00 waiting, and no bounce started - the page closed
		// the whole distance in one frame, while `zoom-out-lift` (settleBound true) eased.
		// The rule draws no line between a drag's settle and a zoom's settle, so neither does this.
		// `settleBound` keeps its own meaning - the fitting window - and is untouched.
		// PREVIEW FRAMES ARE NOT TOUCHED: off the settle both caps are +Infinity and both rests are off, so
		// every correction below is zero and this cannot fire while the fingers are down.
		// THE EDGE CAP'S SHARE IS NOT HANDED TO THE EASE. Measuring the correction from the position
		// BEFORE the cap displaced the ink: six `draws across the expanded right viewport` cells stored
		// strokes up to 652.331 px from the pen, and on `scroll-fast` and `scroll-zero` that distance was
		// EXACTLY the correction handed to this call - 652.331 against hypot(544.000, 360.000) and
		// 374.401 against hypot(224.000, 300.000), both to the digit. A term-by-term read of the mapping
		// at every pointer event found no displaced term to fix instead: pan, rest, bounce, raster and
		// ink pan were all zero and constant while the error stood. So the edge's share comes back out,
		// the window's and the rest's stay, and the edge close is a same-frame write again - the same
		// shape it already has with Infinite Canvas off.
		// THE FLAG STILL APPLIES, on its own merits: only the settle that closes a preview may ease at
		// all, so the second and third settling passes for one lift write their target instead of
		// re-running the ease from a position the page has left.
		const owesPreviewEase = settling && this.previewSettleOwed;
		if (settling) this.previewSettleOwed = false;
		// The correction is whatever the one bound actually moved, and the ease fires when there is
		// one. The old gate read `restX || windowX.fits` - proxies for "something might have moved" - and
		// started a bounce on `settleBound` alone, which under the no-settle rule is an ease with nothing to correct.
		// THE CORRECTION IS THE DISTANCE THE PAGE ACTUALLY TRAVELLED, painted px against the scroller.
		// Three earlier shapes failed on the quantity: `rawX - cx` hands over only what the bound moved
		// and leaves the rest to the commit, a 15 px jump at the lift; `pan.x - cx` hands over a PAN
		// number, 98 where the page moves 15 px on screen; and a painted read taken HERE reads 79 or 0,
		// because the scroll has already been spent by the time this runs. The painted position comes
		// from the capture at the settle-close path instead, and the landed position is read here.
		//
		// SAME TASK: the write, the second read and the ease, with no await and no animation frame
		// between them, so nothing paints at the landed position before the offset is set.
		// KEPT ON THE HOLD, not spent here. This first settling pass runs in the commit, before CodeMirror's measure; the
		// hold's attempts re-pan after it, against the layout that measure moved, and each re-aims the same ease from this
		// capture against where the page then lands. Measured on the zoom round-trip cell: the page landed 2.12 px off the
		// last preview frame at a 600 percent lift (the scroll rounded 84.35 to 84) and glided back to it. Settling passes
		// only: a preview frame never reads or writes it.
		// The re-aim reads against the editor's parent (settleHostBlank); the commit's own first ease keeps its scroller read.
		const reaim = settling && !owesPreviewEase && settlePaintedBefore.has(a);
		const paintedBefore = owesPreviewEase ? this.previewPaintedBlank : reaim ? settlePaintedBefore.get(a)! : null;
		const paintedHost = owesPreviewEase ? settlePaintedHost.get(this) : undefined;
		// One settle close, one capture: the hold object outlives its gesture, so the last gesture's capture goes here.
		if (owesPreviewEase) { settlePaintedHost.delete(this); settlePaintedBefore.delete(a); }
		// Kept only once the commit's own ease has started (below): a re-aim re-aims that ease and never starts one the commit
		// did not. Measured on the right/down expansion arm at zoom 0.1 (cadence zero, no frame painted): the commit pass takes
		// the early return below with no ease, and a re-aim that could start one eased the whole 800 px drag back.
		const keep = (): void => { if (owesPreviewEase && paintedHost) settlePaintedBefore.set(a, paintedHost); };
		this.previewPaintedBlank = null;
		// IC on keeps the gate, consumption and early bounce start 3578f29e had.
		// IC off: starting a bounce here on the bound's share alone, before `landed` can be
		// read below, is what made the later carry read a position the running ease already hid (the
		// paper arm). The IC-off ease is deferred whole to the merged call after the pan write.
		const legacyX = this.canvasMode && !paintedBefore && owesPreviewEase && cx !== rawX ? rawX - cx : 0;
		const legacyY = this.canvasMode && !paintedBefore && owesPreviewEase && cy !== rawY ? rawY - cy : 0;
		const legacyBounced = (legacyX !== 0 || legacyY !== 0) && this.startOverscrollBounce(a, legacyX, legacyY);
		// A settle whose bound target already equals the standing pan still owes the
		// ease for whatever the scroll commit moved - the second settle of a round trip lands here
		// with cx === pan.x and an owed capture. Returning there dropped that ease. The pan write
		// below is the only thing this return saves, so with a capture owed it is skipped instead.
		if (cx === pan.x && cy === pan.y && !(paintedBefore && (!this.canvasMode || reaim))) {
			if (legacyBounced) this.writeViewportPan();
			else if (paperDriftMoved || this.previewPaperBoxDirty) this.writePaperPan();
			this.previewPaperBoxDirty = false;
			return;
		}
		// Mutated, not replaced: this runs once per preview frame, and a fresh
		// object per frame is an allocation on the one path the pinch deferral
		// exists to keep free of them.
		pan.x = cx; pan.y = cy;
		this.writeViewportPan();
		this.previewPaperBoxDirty = false;
		if (!paintedBefore) return;
		// On a re-aim the running ease is on the page: where the page lands is the read less that offset.
		// THE LINE CORRECTION IS NOT THE EASE'S. The hold's attempts move the scroll by what the line under the fingers moved
		// in the height-map rebuild (InkOverlayZoomApi, settleLineApplied, unscaled px), so the page lands that far up in painted
		// px (times cssScale, the outer scale times the pinch scale) and the line stays where the preview painted it. Easing
		// that distance back put the line off by the whole correction on the first settled frame (380 to 928 px on the zoom
		// round-trip cell at 29820cac), so it is added back to where the page lands before the ease is taken.
		const blank = reaim ? settleHostBlank(this.view) : this.settleBlank(), live = reaim ? this.bounceOffset : null;
		const corrected = reaim ? (settleLineApplied.get(a) ?? 0) * this.cssScale : 0;
		const landed = reaim ? { x: blank.x - (live?.x ?? 0), y: blank.y - (live?.y ?? 0) + corrected } : blank;
		if (this.canvasMode) {
			// IC on only. The rule is 3578f29e's; the re-aim and the ease's start rule (easedDistances) were added since.
			const correctionX = paintedBefore.x - landed.x, correctionY = paintedBefore.y - landed.y;
			// The device probe's settle line: what the preview painted and where the commit landed, with the outer scale, dpr and pane.
			if (diagnosticsEnabled()) { const l = this.viewportLayout; scrollProbeExtent(`settle blank painted ${paintedBefore.x.toFixed(2)},${paintedBefore.y.toFixed(2)} landed ${landed.x.toFixed(2)},${landed.y.toFixed(2)} outer ${l ? l.externalScale.toFixed(4) : "-"} dpr ${this.winRef.devicePixelRatio} pane ${l ? `${l.paneWidth.toFixed(1)},${l.paneHeight.toFixed(1)}` : "-"}`); }
			if ((reaim || correctionX !== 0 || correctionY !== 0) && this.startOverscrollBounce(a, correctionX, correctionY, true, reaim)) { keep(); this.writeViewportPan(); }
			return;
		}
		// IC off - the ease is the carry ALONE. `landed` is read here, after the pan
		// write and before any ease is live, so `paintedBefore - landed` is already the WHOLE distance
		// the commit moved the page, the bound's own share included. Adding `rawX - cx` on top counted
		// that share twice: measured on EDGE INSIDE THE PANE (LEFT), carry 34 against a travel of 34,
		// share 19, ease started at 53. Standing pan is
		// `cx` alone, already written above; nothing is added to pan directly (an earlier error).
		const easeX = paintedBefore.x - landed.x;
		const easeY = paintedBefore.y - landed.y;
		if ((reaim || easeX !== 0 || easeY !== 0) && this.startOverscrollBounce(a, easeX, easeY, false, reaim)) { keep(); this.writeViewportPan(); }
	}

	/**
	 * THE PAGE'S BLANK INSIDE ITS PANE, painted px, both axes from one read pair. Positive means the
	 * canvas's edge sits inside the pane, which is the case the left-and-top bound corrects. Against the
	 * SCROLLER and not the viewport: the settle writes scroll as well as pan, so an absolute rect moves
	 * by the scroll too and reports a distance the page never travelled. The sizer is not read - the
	 * intermediates carry their own offsets.
	 */
	function settleBlank(this: InkOverlayPlugin): { x: number; y: number } {
		const content = this.view.contentDOM.getBoundingClientRect(), scroller = this.view.scrollDOM.getBoundingClientRect();
		return { x: content.left - scroller.left, y: content.top - scroller.top };
	}

	/**
	 * THE WINDOW A SETTLED PAN MAY SIT IN on one axis, as offsets from the
	 * position the content sits at with no pan (its leading edge against the
	 * viewport's).
	 *
	 * A pinch holds the note with a translate because above the scale the
	 * content fits at, the scroller's range runs out before the gesture does.
	 * The bound on that translate is the note's VISIBLE OVERLAP: drag until only
	 * 24 px of the note is left on the pane. That is right for a page bigger
	 * than its viewport, and wrong for a page smaller than it - there the same
	 * rule lets a gesture leave the whole note hanging off the pane's edge with
	 * nothing to bring it back, because at that scale there is no scroll range
	 * to undo it either. What the user saw: pinch in, pinch back out somewhere
	 * else, and at 100% the note sits off to the left with its first characters
	 * past the edge until a Fit, a zoom button or a file switch (measured:
	 * 226.67 px past it with readable line length off).
	 *
	 * ONLY A SETTLE THAT CHANGED THE SCALE IS BOUND BY THIS. While the fingers
	 * are down the note stays under the focal point - that is the gesture's
	 * contract and it is pinned by its own cells - so the preview's pan and the
	 * ordered constraint reducer are left alone. The settle of a zoom already
	 * moves the frame it commits; clamping its TARGET means the correction rides
	 * that motion instead of arriving as a jump after it. A pure two-finger pan
	 * has no such motion to ride: a page dragged past the pane's edge stays
	 * where the fingers left it, as it always has, and a clamp there would be a
	 * spring-back on the most common gesture (800 px, measured, before this
	 * condition). "Changed the scale" is a band, not equality
	 * (PAN_SETTLE_ZOOM_BAND): a drag whose spread drifted, and an in-then-out
	 * pinch that comes back near its start, both read as pans and are not
	 * clamped.
	 */
	function panAxisWindow(this: InkOverlayPlugin, size: number, span: number): { fits: boolean; min: number; max: number } {
		if (!(Number.isFinite(size) && Number.isFinite(span))) return { fits: false, min: -MAX_VIEWPORT_LAYOUT, max: MAX_VIEWPORT_LAYOUT };
		if (size > 0 && size <= span + PAN_FIT_SLACK_PX) return { fits: true, min: 0, max: Math.max(0, span - size) };
		const visible = Math.max(0, span - PAN_MIN_VISIBLE_PX);
		return { fits: false, min: size > 0 ? PAN_MIN_VISIBLE_PX - size : -visible, max: visible };
	}

	/** Read-only: the drag-frame gate's inputs on the last preview frame. */
	function dragGateReadout(this: InkOverlayPlugin): { dragFrame: boolean; neverZoomed: boolean; steady: boolean; next: number; fromScale: number; fromScaleValid: boolean;
		rawX: number; cx: number; rawY: number; cy: number; restCeilX: number; startX: number; startY: number; lastX: number; lastY: number;
		bounded: boolean; settling: boolean; floorX: number; floorY: number } {
		const b = this.boundReadout;
		return { dragFrame: b.dragFrame, neverZoomed: b.neverZoomed, steady: b.steady, next: b.next, fromScale: b.fromScale,
			fromScaleValid: b.fromScaleValid, rawX: b.rawX, cx: b.cx, rawY: b.rawY, cy: b.cy, restCeilX: b.restCeilX,
			startX: b.startX, startY: b.startY, lastX: b.lastX, lastY: b.lastY, bounded: b.bounded, settling: b.settling,
			floorX: b.floorX, floorY: b.floorY };
	}

	/**
	 * The fit quantities the settle bounds by, read-only, for a fixture that has
	 * to check its own regime against the code's rather than re-derive it from
	 * the DOM. Sizes are painted px at the scale in force.
	 */
	function panFitReadout(this: InkOverlayPlugin): { fitsX: boolean; fitsY: boolean; contentX: number; contentY: number; viewportX: number; viewportY: number; boundHits: number; boundMaxPx: number } {
		const layout = this.viewportLayout;
		const path = this.filePath(), extent = (path ? surfaceExtents.get(path) : null) ?? { x: 0, y: 0 };
		const effective = layout ? this.pinchScaleNow * layout.externalScale : this.pinchScaleNow;
		// THE SAME QUANTITY THE PREDICATE TAKES. A readout that answers "does it fit" from a different
		// width than the code does agrees with the product exactly until the two definitions diverge,
		// which is the case this whole fix is about - and a fixture reading it would inherit the lie.
		const contentX = this.pageContentWidth() * effective;
		const contentY = Math.max(this.view?.contentHeight ?? 0, extent.y * this.fontZoom) * effective;
		const viewportX = layout ? layout.width * layout.externalScale - layout.gutterScreen : 0;
		const viewportY = layout ? layout.paneHeight * layout.externalScale : 0;
		return { fitsX: this.panAxisWindow(contentX, viewportX).fits, fitsY: this.panAxisWindow(contentY, viewportY).fits,
			contentX, contentY, viewportX, viewportY, boundHits: this.panBoundHits, boundMaxPx: this.panBoundMaxPx };
	}

	/**
	 * Put back, as pan, whatever the scroll write could not deliver.
	 *
	 * The browser clamps `scrollLeft`/`scrollTop` to the range the surface has
	 * actually grown into, and positions what it does accept on whole pixels -
	 * both silently. A settle that asked for more than that would otherwise land
	 * the note somewhere the preview never showed: a jump at pinch end, in the
	 * direction of the clamp. Re-measuring here and re-deriving the pan makes
	 * the settled frame agree with the last preview frame whether the scroll
	 * arrived in full, in part, or not at all - and leaves the pan at zero in
	 * the ordinary case where it did.
	 */
	function reanchorPan(this: InkOverlayPlugin): void {
		const hold = this.panAnchorHold;
		if (!hold) return;
		if (!this.ownsPanSettle(hold)) { if (this.panAnchorHold === hold) this.retirePanSettle("ownership lost before the anchor pan"); return; }
		// Read the owned column without its pan. Subtracting a full-precision
		// pan from the browser's rounded transformed rect feeds a small error
		// back into every iteration and can prevent exact convergence.
		const sizer = this.panSizer();
		if (!sizer) return;
		const transform = sizer.style.transform;
		let local: number | null = null, top: number | null = null;
		try {
			sizer.style.removeProperty("transform");
			const host = this.view.dom.getBoundingClientRect();
			const column = contentOriginLeft(this.view.contentDOM);
			const content = this.view.contentDOM.getBoundingClientRect();
			this.previewHostOrigin = { left: host.left, top: host.top, valid: true };
			local = column === null ? null : (column - host.left) / hold.toScale;
			top = (content.top - host.top) / hold.toScale;
		} finally { sizer.style.transform = transform; }
		const ratio = hold.toScale / hold.fromScale;
		const zoomed = Number.isFinite(ratio) && (ratio < PAN_SETTLE_ZOOM_BAND.below || ratio > PAN_SETTLE_ZOOM_BAND.above);
		this.anchorPanTo(hold.toScale, hold, local, top, zoomed);
		hold.left = this.view.scrollDOM.scrollLeft; hold.top = this.view.scrollDOM.scrollTop;
	}

	/** Preserve the public range value while carrying provenance through the
	 * actual mapping performed by CM. Only the private wrapper is registered;
	 * a fresh foreign range with identical positions remains unrelated.
	 */
	function ownScrollRange(this: InkOverlayPlugin, range: SelectionRange, owner: object): SelectionRange | null {
		if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from < 0 || range.to > this.view.state.doc.length) return null;
		const wrappers = new WeakMap<SelectionRange, SelectionRange>();
		const wrap = (original: SelectionRange): SelectionRange => {
			const existing = wrappers.get(original);
			if (existing) return existing;
			const map = (...args: Parameters<SelectionRange["map"]>): SelectionRange =>
				wrap(original.map(...args));
			const wrapped = new Proxy(original, {
				get: (target, key, receiver): unknown => key === "map" ? map : Reflect.get(target, key, receiver),
			});
			wrappers.set(original, wrapped);
			this.scrollRangeOwners.set(wrapped, owner);
			return wrapped;
		};
		return wrap(range);
	}

	/** A receipt survives cancellation so its pending request cannot become a
	 * default scroll. This consumer never changes geometry or dispatches.
	 */
	function overlayConsumeViewportScroll(this: InkOverlayPlugin, range: SelectionRange): boolean {
		const owner = this.scrollRangeOwners.get(range);
		if (!owner) { this.retirePanSettle("a scroll request the overlay did not issue"); return false; }
		const hold = this.panAnchorHold;
		if (hold === owner) {
			if (!this.ownsPanSettle(hold) || this.view.scrollDOM.scrollLeft !== hold.left || this.view.scrollDOM.scrollTop !== hold.top) hold.outcome = "cancelled";
			else if (!hold.ready) { hold.outcome = "failed"; console.warn("Pinch settlement consumed before convergence"); }
			else hold.outcome = "converged";
			this.retirePanSettle("consumed");
		}
		return true;
	}

	function ownsPanSettle(this: InkOverlayPlugin, hold: NonNullable<InkOverlayPlugin["panAnchorHold"]>): boolean {
		return this.panAnchorHold === hold && hold.generation === this.viewportGeneration &&
			hold.path === this.filePath() && hold.container === this.container && !!this.container &&
			!this.retiring && !this.frame.locked;
	}

	/** Take the pan off the children; every exit from a gesture lands here. */
	function clearViewportPan(this: InkOverlayPlugin): void {
		this.cancelOverscrollBounce();
		this.restorePinchLayers();
		this.previewPanEngaged = false;
		this.retirePanSettle("the pan was cleared");
		this.previewColumnLocal = null;
		if (this.previewHostOrigin) this.previewHostOrigin.valid = false;
		const pan = this.viewportPan;
		const had = !pan || pan.x !== 0 || pan.y !== 0;
		if (pan) { pan.x = 0; pan.y = 0; }
		// Written even when the pan was already zero on the `!pan` branch: the
		// unit fixtures have no field to read, and a stale transform left on a
		// real `.cm-sizer` outlives this overlay.
		if (had) this.writeViewportPan();
		if (this.panGuttersEl?.style && this.panGuttersWritten !== "") this.panGuttersEl.style.removeProperty("transform");
		this.panSizerEl = null;
		this.panGuttersEl = null;
		this.panGuttersMode = null;
		this.panGuttersWritten = "";
	}

 /** The column's margin in host-local px: its painted position less the left reserve's translate. */
 function columnMarginLocal(this: InkOverlayPlugin, layout:NonNullable<InkOverlayPlugin["viewportLayout"]>):number|null {
  // `> 0`, not the field alone: a unit rig builds the layout by hand without it.
  return layout.columnLocal===null?null:layout.columnLocal-(layout.columnReserve>0?layout.columnReserve:0);
 }

export function installPanSettle(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		panFloor,
		writeViewportPan,
		observeAboveContent,
		anchorPanTo,
		settleBlank,
		panAxisWindow,
		dragGateReadout,
		panFitReadout,
		reanchorPan,
		ownScrollRange,
		consumeViewportScroll: overlayConsumeViewportScroll,
		ownsPanSettle,
		clearViewportPan,
		columnMarginLocal,
	});
}
