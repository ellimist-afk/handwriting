/**
 * The pdf surface's band, sync and paint: the page boxes the viewer reports, the committed canvas of each live page, the shared wet pair,
 * and the band they cover. They are methods of PdfInkController, installed on its prototype when PdfInkController.ts loads.
 */
import { CameraState } from "../camera/coordinates";
import { InkStroke } from "../ink/Stroke";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { TailRenderer } from "../ink/TailRenderer";
import { drawStroke } from "../ink/StrokeRenderer";
import { livePages, PageBox } from "./PageMap";
import { bandBacking, bandFor, bandNeedsMove, PageBandBox, pageBandFor, scrollerSizeOf, viewportAt, wholePage } from "./PageBand";
import { installMethods } from "../inline/InstallMethods";
import { isDarkTheme } from "../ink/InkTheme";
import { getInlineTool } from "../inline/InkOverlay";
import { pageDrawFinished, readCanvasDark, wholePageCanvasOf } from "./PdfViewerProbe";
import type { Attached, PenFrame, WetPair, PdfInkController } from "./PdfInkController";

declare module "./PdfInkController" {
	interface PdfInkController {
		sync(): void;
		pageWidthPt(pageNumber: number, wPx: number, hPx: number, scale: number): number;
		isRotated(pageNumber: number): boolean;
		viewTurn(): ViewTurn | null;
		frameBox(pageNumber: number): PageBox | null;
		owns(pageNumber: number): boolean;
		ensureOverlay(pageNumber: number): void;
		pageElement(scroller: HTMLElement, pageNumber: number): HTMLElement | null;
		wetOn(pageNumber: number): WetPair | null;
		backingFor(pageEl: HTMLElement, box: PageBox): { pageW: number; pageH: number; band: PageBandBox; w: number; h: number; backing: number; } | null;
		bandBoxFor(page: { leftPx: number; topPx: number; widthPx: number; heightPx: number; }): PageBandBox | null;
		surfaceBacking(dpr: number): number;
		wetGestureLive(): boolean;
		syncBand(scroller: HTMLElement): boolean;
		attachPair(pageEl: HTMLElement, box: PageBox): WetPair | null;
		placeBanded(canvas: HTMLCanvasElement, band: PageBandBox, pageW: number, pageH: number): void;
		bandTransform(canvas: HTMLCanvasElement, band: PageBandBox, backing: number): void;
		detachPairFrom(pageNumber: number): void;
		dropPair(): void;
		restoreSelectionOutline(pageEl: HTMLElement, box: PageBox): void;
		paint(pageEl: HTMLElement, box: PageBox, scale: number, zoomed: boolean): void;
		drawCommitted(ctx: CanvasRenderingContext2D, cam: CameraState, strokes: readonly InkStroke[]): void;
		highlightLayered(pageNumber: number): boolean;
		ensureHighlightLayer(pageEl: HTMLElement, attached: Attached): HighlightLayer;
		dropHighlightLayer(attached: Attached | undefined): boolean;
		pairHome(pageEl: HTMLElement, pageNumber: number): HTMLElement;
		seatPair(pageEl: HTMLElement, pageNumber: number): void;
		drawHighlights(ctx: CanvasRenderingContext2D, cam: CameraState, strokes: readonly InkStroke[]): void;
	}
}

export const OVERLAY_CLASS = "handwriting-pdf-ink";

/**
 * A page's saved highlights, as one layer under its saved pen ink.
 *
 * The group carries the wash once (styles.css: the highlighter's alpha,
 * blended multiply), so the page's own text stays dark under a highlight and white
 * paper takes the same colour one translucent fill gave it. Inside, the
 * highlights are painted opaque on a canvas of their own, so two crossing
 * highlights are one flat wash rather than a darker seam. A live
 * highlighter stroke draws inside the same group (see `pairHome`), so the
 * lift changes nothing on screen.
 *
 * Both elements carry OVERLAY_CLASS: the viewer probe skips our canvases by
 * that class, and the group's own childList writes are ours to the root
 * observer by it. Only a page that holds a highlight, or has one being
 * drawn, has a layer; a page with pen ink alone allocates nothing new.
 */
export interface HighlightLayer {
	group: HTMLElement;
	canvas: HTMLCanvasElement;
	/** Whether `paint` has drawn the saved highlights onto it since it was made. */
	painted: boolean;
}

export const HIGHLIGHT_GROUP_CLASS = "handwriting-pdf-highlight-group";
export const HIGHLIGHT_CANVAS_CLASS = "handwriting-pdf-highlight";

/** One layer per page overlay; it lives and goes with that overlay. */
const highlightLayers = new WeakMap<Attached, HighlightLayer>();

/**
 * What a viewer's whole-page canvas was found to be, kept for that element
 * only. A new element (every re-render, every zoom settle) starts with none.
 *
 * - "unread": seen while the app had not made the pages dark, not read yet.
 * - "dark" / "light": read once. A canvas that could not be read is "light"
 *   and is never tried again.
 * - "unseen-dark": first seen while the app had made the pages dark. Never
 *   read; light. A page past the viewer's canvas cap is not drawn again when
 *   the app's dark pages are turned off, so this element can still hold the
 *   pixels the app darkened.
 */
type CanvasShade = "unread" | "dark" | "light" | "unseen-dark";
const canvasShades = new WeakMap<HTMLCanvasElement, CanvasShade>();

/**
 * Each live page's whole-page viewer canvas as the last sync found it: where
 * a page's answer is looked up between syncs (pen-down, the snip), which read
 * no layout. Rebuilt at every sync; the answer itself is the element's.
 */
const pageCanvases = new WeakMap<PdfInkController, Map<number, HTMLCanvasElement>>();

/** The answer a gesture's page had at pen-down, held until the lift. */
const heldShades = new WeakMap<PdfInkController, { frame: PenFrame; page: number; dark: boolean }>();

/** Is this page's canvas, as the last sync found it, read dark? */
function keptDark(controller: PdfInkController, page: number): boolean {
	const canvas = pageCanvases.get(controller)?.get(page);
	return canvas !== undefined && canvasShades.get(canvas) === "dark";
}

/**
 * The gesture in progress and its page's answer, taken the first time it is
 * asked for (pen-down's own dressing, or the first sync after the pen went
 * down), from what was kept before the pen went down. Keyed by the gesture's
 * frame, which every pen-down makes new and every lift clears, so it ends with
 * the gesture however the gesture ends.
 */
function gestureShade(controller: PdfInkController): { page: number; dark: boolean } | null {
	const frame = controller.frame;
	if (frame === null) return null;
	const held = heldShades.get(controller);
	if (held && held.frame === frame) return held;
	const page = controller.strokePageNumber;
	const fresh = { frame, page, dark: keptDark(controller, page) };
	heldShades.set(controller, fresh);
	return fresh;
}

/**
 * Has the PDF file itself drawn this page dark? The kept read of the page's
 * whole canvas; the page a gesture is on keeps its pen-down answer until the
 * lift. Reads no pixels and no layout.
 */
function fileDarkPage(controller: PdfInkController, page: number): boolean {
	const held = gestureShade(controller);
	if (held && held.page === page) return held.dark;
	return keptDark(controller, page);
}

/**
 * Read the pages that need an answer, once per canvas element, at sync and
 * before anything is written, so the layout reads here cost nothing new.
 *
 * Only while the app has not made the pages dark: then those classes decide,
 * and every canvas first seen under them is marked never to be read. Only the
 * pages that hold a highlight, plus every live page while the highlighter is
 * the tool, and the strokes are asked first. Only a finished page; a page
 * still drawing is light meanwhile and is read at the sync after its draw.
 * None while a pen or finger is down; those are read at the lift's own sync.
 */
function shadePages(controller: PdfInkController, pages: ReadonlyArray<readonly [PageBox, HTMLElement | null]>): void {
	// Before this sync's reads: a gesture keeps what it had at pen-down.
	gestureShade(controller);
	const appDark = appDarkPages(controller);
	const reading = !appDark && controller.pageAssumption() !== "lighten";
	// No pixel is read while a pen or finger is down: one read of a big page
	// can take a whole frame, and the stroke needs every frame. The canvas
	// stays unread, so light, and is read at the first sync after the lift,
	// which clears the frame before its own sync.
	const contact = controller.frame !== null;
	const highlighter = getInlineTool() === "highlighter";
	const found = new Map<number, HTMLCanvasElement>();
	for (const [box, pageEl] of pages) {
		if (!pageEl) continue;
		// Under the app's dark pages every live canvas is looked at, to be
		// marked; otherwise only a page whose answer can be asked for.
		const asked = reading && (highlighter || controller.strokes(box.pageNumber).some((s) => s.tool === "highlighter"));
		if (!appDark && !asked) continue;
		const canvas = wholePageCanvasOf(pageEl);
		if (!canvas) continue;
		found.set(box.pageNumber, canvas);
		let shade = canvasShades.get(canvas);
		if (shade === undefined) {
			shade = appDark ? "unseen-dark" : "unread";
			canvasShades.set(canvas, shade);
		}
		if (shade !== "unread" || !asked || contact || !pageDrawFinished(pageEl)) continue;
		canvasShades.set(canvas, readCanvasDark(canvas) === true ? "dark" : "light");
	}
	pageCanvases.set(controller, found);
}

/** Is this node part of a page's highlight layer? Read by the root observer's own-write filter. */
export function isHighlightLayerNode(node: Node): boolean {
	const list = (node as Partial<Element>).classList;
	return list !== undefined && (list.contains(HIGHLIGHT_GROUP_CLASS) || list.contains(HIGHLIGHT_CANVAS_CLASS));
}

/** A turn the viewer applies to every page, clockwise, in degrees. */
export type ViewTurn = 0 | 90 | 180 | 270;

/**
 * Where each controller reads the viewer's page turn from. Registered by the
 * code that builds the controller; a controller with no source, or a source
 * that answers null, behaves exactly as it did before turns were handled:
 * an aspect flip refuses ink and the page paints upright.
 */
const turnSources = new WeakMap<PdfInkController, () => number | null>();

export function setViewTurnSource(controller: PdfInkController, source: () => number | null): void {
	turnSources.set(controller, source);
}

/** Any multiple of 90 to one of the four turns; anything else is unknown. */
export function normalTurn(deg: number | null): ViewTurn | null {
	if (deg === null || !Number.isFinite(deg) || deg % 90 !== 0) return null;
	return (((deg % 360) + 360) % 360) as ViewTurn;
}

/**
 * The turn the viewer reported when each committed canvas was last painted,
 * so a turn that leaves the box the same size (180 degrees), or that arrives
 * before the box has turned, still defeats the repaint skip - and the repaint
 * is what marks the page refused. Absent means upright, which keeps the
 * upright skip test exactly as it was.
 */
const paintedTurns = new WeakMap<object, ViewTurn>();

/**
 * The matrix that carries the upright page's css px onto the page as the
 * viewer shows it turned clockwise by `turn`. `pageW` and `pageH` are the
 * TURNED box (the element being filled).
 */
function turnMatrix(turn: ViewTurn, pageW: number, pageH: number): [number, number, number, number, number, number] {
	switch (turn) {
		case 90:
			return [0, 1, -1, 0, pageW, 0];
		case 180:
			return [-1, 0, 0, -1, pageW, pageH];
		case 270:
			return [0, -1, 1, 0, 0, pageH];
		default:
			return [1, 0, 0, 1, 0, 0];
	}
}

/**
 * The turn a page is painted at. A quarter turn is painted only once the box
 * has turned with it: the viewer can report the new turn a moment before the
 * page div is resized, and until the box agrees it is still the upright box,
 * so the page paints upright on it. Same test as the aspect check in
 * `pageWidthPt`, against the upright size cached there; a page with no size
 * yet, or too square to tell, is taken as turned.
 */
function turnToPaint(turn: ViewTurn | null, known: { wPt: number; hPt: number } | undefined, wPx: number, hPx: number): ViewTurn {
	if (turn === null) return 0;
	if ((turn !== 90 && turn !== 270) || !known) return turn;
	const expected = (known.hPt - known.wPt) * (wPx + hPx) / (known.wPt + known.hPt);
	const observed = wPx - hPx;
	const disagrees = expected * observed < 0 && Math.abs(expected) > 1.5 && Math.abs(observed) > 1.5;
	return disagrees ? 0 : turn;
}

/**
 * Device pixels one page overlay may hold - a backstop, not a policy.
 *
 * It used to be 4M and it used to be the thing that decided resolution: the
 * canvas covered the WHOLE page, so at high zoom the area it was asked for
 * was tens of millions of css px, the cap divided the backing down to well
 * under one device pixel per css pixel, and the ink was rasterised below
 * screen resolution and stretched. pdf.js's own page canvas has a much larger
 * budget, so the page stayed sharp underneath and only the ink went soft
 * ("at max zoom, pretty blurry still" - alan, hardware, 2026-09-04).
 *
 * The canvases now cover a BAND (see `PageBand`), whose area is bounded by
 * the viewport instead of by the zoom, so this number stops being reached in
 * ordinary use and goes back to being what a cap is for: refusing an
 * allocation the browser would refuse anyway, silently, leaving a blank
 * canvas nobody can debug. Raised to the note surface's `MAX_BACKING_AREA`,
 * because it is now guarding the same thing that budget guards and there is
 * no reason for the two surfaces to disagree about how big a canvas may be.
 */
const MAX_OVERLAY_PX = 10_000_000;


/** Is a canvas already covering exactly this box? Part of the repaint skip. */
function sameBand(a: PageBandBox | null, b: PageBandBox): boolean {
	return a !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}



	function sync(this: PdfInkController): void {
		if (!this.mounted) return;
		// Stamped here, not in scheduleThrottled: the floor is between syncs
		// that actually ran, and this is the work being spaced out. Without
		// it `lastSyncAt` stayed 0 forever, every gap measured as "longer
		// ago than the floor", and the throttle passed everything straight
		// through even once it was being called.
		this.lastSyncAt = Date.now();
		const probed = this.probe();
		if (!probed) return;
		// The viewer was rebuilt under us. Rebind the pen before anything else,
		// or this pane never sees another pointer event; and our overlays lived
		// in the subtree that just went, so they are gone whatever we believe.
		if (probed.scroller !== this.boundScroller) {
			// A live gesture cannot survive the rebuild, but its samples are
			// page units and CAN: end it honestly, committing what was drawn,
			// instead of discarding the half-stroke - the same rule the
			// mid-stroke zoom already follows. The store write is DOM-free,
			// so the dying scroller costs it nothing.
			//
			// Every gesture, not only a stroke or an erase: pen-down hid the
			// strip for a pan, a lasso and a space move too, and the router
			// being replaced below never delivers their lift. `frame` is set
			// at every pen-down, straight after the strip steps aside, and
			// only penUp and resetGestureState clear it, so it is the one
			// field that says a contact is open whatever its mode.
			if (this.frame !== null || this.builder !== null || this.erasing) this.penUp();
			this.dropOverlays();
			this.resetGestureState();
			this.bindTo(probed.scroller);
		}
		if (probed.scaleFactor === null) return;
		const scale = probed.scaleFactor;
		const boxes: PageBox[] = probed.pages.map((p) => ({
			pageNumber: p.pageNumber,
			leftPx: p.leftPx,
			topPx: p.topPx,
			widthPx: p.widthPx,
			heightPx: p.heightPx,
		}));
		const hasCanvas = new Set(probed.pages.filter((p) => p.hasCanvas).map((p) => p.pageNumber));
		const live = livePages(boxes, (n) => hasCanvas.has(n));
		const liveNumbers = new Set(live.map((b) => b.pageNumber));
		// Each live page's div, found once for this sync, and the page reads
		// (`shadePages`) done here, before the first write below.
		const pages = live.map((box) => [box, this.pageElement(probed.scroller, box.pageNumber)] as const);
		shadePages(this, pages);

		// Evict first: a page the viewer let go of should not keep a canvas
		// alive, and doing this before attaching keeps the peak count at the
		// window size rather than the sum of both sets.
		//
		// Never the page a gesture is on: it hosts the wet pair, and evicting it
		// mid-stroke un-parents the pair, so the stroke vanishes until pen-up.
		// The two drop branches in `paint` ask the same question. The page goes
		// at the first sync after the lift.
		//
		// Sized to nothing before it goes, as the off-band branch in `paint`
		// does: the backing store is held until the collector reaches it. The
		// page's highlight layer goes the same way.
		for (const [pageNumber, a] of [...this.overlays]) {
			if (!liveNumbers.has(pageNumber) && !this.owns(pageNumber)) {
				this.dropHighlightLayer(a);
				a.canvas.width = 0;
				a.canvas.height = 0;
				a.canvas.remove();
				this.detachPairFrom(pageNumber);
				this.overlays.delete(pageNumber);
			}
		}

		// Before the paints, so they all see one band and cut the same box out
		// of it.
		//
		// A zoom arrives here through the ResizeObserver, and this used to
		// claim `bandNeedsMove` catches it: the page boxes changed, so
		// `scrollHeight` and `clientHeight` changed, so the size branch takes
		// it. Only `clientHeight` does not change under a zoom - the pane is
		// the same size, the document inside it is not - and `bandNeedsMove`'s
		// size branch compares the BAND's own width and height, which are
		// derived from `clientWidth`/`clientHeight` alone. `scrollHeight`
		// moves the band's clamped bottom at the very end of a document and
		// nowhere else. So a zoom in the middle of a pdf can leave the band
		// exactly where it was and `syncBand` can honestly answer false.
		//
		// What actually keeps the canvases correct through a zoom is `zoomed`
		// below - `scale !== this.lastScale` - which defeats the repaint skip
		// in `paint` for every page. The band does not need to move for a
		// zoom; the raster inside it does, because the ink is drawn at the
		// page's new scale.
		//
		// The one place the scroller's size is measured. `sync` has already
		// forced layout by this point (the probe reads every page div), so the
		// four reads are free here in a way they never are in a scroll
		// listener - and a resize or a zoom cannot reach the band without
		// coming through here first.
		this.scrollerSize = scrollerSizeOf(probed.scroller);
		this.syncBand(probed.scroller);
		const zoomed = scale !== this.lastScale;
		this.lastScale = scale;
		for (const [box, pageEl] of pages) {
			if (!pageEl) continue;
			this.paint(pageEl, box, scale, zoomed);
		}
	}

	/**
	 * The page's intrinsic width in points - a property of the DOCUMENT, not
	 * of the zoom, so it is learned once and reused.
	 *
	 * Caching it is what breaks the dependence on a live scale factor: the
	 * first settled reading defines the page, and every later paint measures
	 * only the box. A document whose pages differ in size would need this per
	 * page; the fixture and the overwhelming majority of PDFs do not, and the
	 * report's `stride` line is what would show otherwise.
	 */
	function pageWidthPt(this: PdfInkController, pageNumber: number, wPx: number, hPx: number, scale: number): number {
		// A known quarter turn shows the page on its side: its box is the
		// upright box with the sides swapped. Swapped back here, every reading
		// below - the cached size, the aspect check - is of the upright page,
		// which is the frame the stored ink is in. An unknown turn leaves the
		// box as measured, as before.
		const turn = this.viewTurn();
		if (turn === 90 || turn === 270) [wPx, hPx] = [hPx, wPx];
		const known = this.pageSize.get(pageNumber);
		if (known) {
			if (!Number.isFinite(wPx) || !Number.isFinite(hPx) || wPx <= 0 || hPx <= 0) return known.wPt;
			// The page div reports integer pixels. A near-square page can tie at
			// one zoom, so a sign flip alone does not prove rotation. The two
			// differences must each clear rounding noise before we refuse ink.
			const expected = (known.wPt - known.hPt) * (wPx + hPx) / (known.wPt + known.hPt);
			const observed = wPx - hPx;
			const flipped = expected * observed < 0 && Math.abs(expected) > 1.5 && Math.abs(observed) > 1.5;
			// Turned pages still refuse new ink: the pen and the snip map
			// through the upright frame only.
			if (flipped || (turn !== null && turn !== 0)) this.rotated.add(pageNumber);
			else {
				this.rotated.delete(pageNumber);
				this.warnedRotated.delete(pageNumber);
			}
			return known.wPt;
		}
		if (!Number.isFinite(scale) || scale <= 0 || wPx <= 0 || hPx <= 0) return 0;
		const size = { wPt: wPx / scale, hPt: hPx / scale };
		this.pageSize.set(pageNumber, size);
		// A page can be first seen already turned: the viewer reopens a
		// document at the turn it was left at.
		if (turn !== null && turn !== 0) this.rotated.add(pageNumber);
		return size.wPt;
	}

	/** Is this page one we refuse to ink? See `rotated`. */
	function isRotated(this: PdfInkController, pageNumber: number): boolean {
		return this.rotated.has(pageNumber);
	}

	/** The viewer's page turn right now, or null when it cannot be read. */
	function viewTurn(this: PdfInkController): ViewTurn | null {
		const source = turnSources.get(this);
		if (!source) return null;
		try {
			return normalTurn(source());
		} catch {
			return null;
		}
	}

	/** A live page's measured box, for clearing the wet layer at its size. */
	function frameBox(this: PdfInkController, pageNumber: number): PageBox | null {
		const probed = this.probe();
		const p = probed?.pages.find((x) => x.pageNumber === pageNumber);
		return p
			? {
					pageNumber: p.pageNumber,
					leftPx: p.leftPx,
					topPx: p.topPx,
					widthPx: p.widthPx,
					heightPx: p.heightPx,
				}
			: null;
	}

	/**
	 * Is a gesture in progress on this page?
	 *
	 * Every gesture that draws on the wet pair: a stroke, an erase, a lasso
	 * loop, a selection drag and an insert-space move - `!idle`, the same set
	 * `wetGestureLive` reads. A stroke and an erase alone left the other three
	 * exposed: the viewer dropping their page took the loop, the box or the
	 * divider off the screen while the pen was down, and after the lift the
	 * selection was held with no box drawn round it.
	 *
	 * A pan is not one: it scrolls, holds nothing on the wet layer, and can go
	 * on for a long time, so it must not keep a page the viewer let go of.
	 */
	function owns(this: PdfInkController, pageNumber: number): boolean {
		return pageNumber === this.strokePageNumber && !this.idle;
	}

	/**
	 * Make sure this page has somewhere to draw, before the first sample.
	 *
	 * A page with no stored ink has no overlay - there was nothing to paint -
	 * so the first stroke on a clean page had nowhere to go and stayed
	 * invisible until pen-up put a stroke in the store and a repaint built the
	 * canvas. It looked like the pen did not work until you had already used
	 * it once (hardware, 2026-08-29).
	 */
	function ensureOverlay(this: PdfInkController, pageNumber: number): void {
		const probed = this.probe();
		if (!probed) return;
		const pageEl = this.pageElement(probed.scroller, pageNumber);
		const box = probed.pages.find((p) => p.pageNumber === pageNumber);
		if (!pageEl || !box || probed.scaleFactor === null) return;
		this.paint(
			pageEl,
			{
				pageNumber: box.pageNumber,
				leftPx: box.leftPx,
				topPx: box.topPx,
				widthPx: box.widthPx,
				heightPx: box.heightPx,
			},
			probed.scaleFactor,
			false
		);
	}

	function pageElement(this: PdfInkController, scroller: HTMLElement, pageNumber: number): HTMLElement | null {
		return scroller.querySelector(`div.page[data-page-number="${pageNumber}"]`);
	}

	/**
	 * The pair, but only while it is parented into this page.
	 *
	 * The same reading the per-page fields gave: a page's wet canvas was
	 * drawable iff that page had an overlay, and only the gesture's page was
	 * ever drawn on. Asking for the wet layer of a page the pair has left
	 * answers nothing, exactly as a blank per-page canvas answered nothing.
	 */
	function wetOn(this: PdfInkController, pageNumber: number): WetPair | null {
		return this.pair !== null && this.wetHostPage === pageNumber ? this.pair : null;
	}

	/**
	 * Where this page's canvases sit and how big their backing stores are.
	 *
	 * One law, two callers: the committed canvas in `paint` and the shared
	 * pair in `attachPair`. Both must agree or the wet stroke is drawn at a
	 * different resolution, or in a different place, from the committed one
	 * that replaces it - and both of those are visible the instant the pen
	 * lifts.
	 *
	 * Two sizes come back and the distinction is load-bearing:
	 *
	 * - `pageW`/`pageH` is the page div, read from the element and never
	 *   written into it, exactly as before. Everything that thinks in PAGE
	 *   coordinates - the drawing scale, the clears, `pageWidthPt` - keeps
	 *   using it, so page units stay page units.
	 * - `band` is the sub-rectangle of that page the canvas actually covers,
	 *   and it IS written into the element, which is the one contract this
	 *   change breaks. The stylesheet's `inset: 0; width/height: 100%` is
	 *   overridden per canvas; the note left here used to say the size was
	 *   never written, and the three bugs it warned about were all numbers
	 *   going stale under a re-render. The protection against that is
	 *   unchanged in kind: the band is recomputed from a fresh probe on every
	 *   paint and rewritten, never remembered across one.
	 *
	 * A page outside the band gets null, which drops its canvas - the same
	 * answer an evicted page gets, and the reason the total pixel count across
	 * every page is now the band's area rather than the sum of the pages'.
	 */
	function backingFor(this: PdfInkController,
		pageEl: HTMLElement,
		box: PageBox
	): {
		pageW: number;
		pageH: number;
		band: PageBandBox;
		w: number;
		h: number;
		backing: number;
	} | null {
		const pageW = pageEl.clientWidth;
		const pageH = pageEl.clientHeight;
		if (pageW <= 0 || pageH <= 0) return null;
		// The probe reports the page's box in content coordinates; the element
		// reports its own size. They agree when the viewer is settled and the
		// element is the one that must be believed about its own pixels, so
		// the band is cut against the element's size at the probe's offset.
		const band = this.bandBoxFor({
			leftPx: box.leftPx,
			topPx: box.topPx,
			widthPx: pageW,
			heightPx: pageH,
		});
		if (!band) return null;
		const dpr = this.win.devicePixelRatio || 1;
		// The SURFACE's backing, not this page's. See `bandBackingPx`. The
		// fallback is the pre-band law and belongs only to the pre-band case:
		// no measured band means `bandBoxFor` handed back the whole page, and
		// the whole page is what the cap then has to hold.
		const surface = this.surfaceBacking(dpr);
		const backing = surface > 0 ? surface : bandBacking(band.width, band.height, dpr, MAX_OVERLAY_PX);
		return {
			pageW,
			pageH,
			band,
			w: Math.max(1, Math.round(band.width * backing)),
			h: Math.max(1, Math.round(band.height * backing)),
			backing,
		};
	}

	/**
	 * The band for one page, in that page's own css px.
	 *
	 * While ink is live the FROZEN band is handed back, because `syncBand`
	 * refuses to move it (see `wetGestureLive`). The pen froze its frame at
	 * pen-down and every sample maps through that frame; moving the canvas
	 * under it would shear the stroke being drawn, and re-sizing it would
	 * throw away the wet pixels drawn so far. The note surface refuses the same
	 * reason (`syncBand`: "skipped while a stroke owns the frame"), and it
	 * accepts the same quiet failure in exchange - a stroke dragged past the
	 * band's edge runs off the drawn area until pen-up, when the committed
	 * repaint on a fresh band puts all of it back. Ink briefly missing at an
	 * edge is a far quieter kind of wrong than ink that shears.
	 */
	function bandBoxFor(this: PdfInkController, page: {
		leftPx: number;
		topPx: number;
		widthPx: number;
		heightPx: number;
	}): PageBandBox | null {
		const band = this.band;
		// NOT MEASURED YET is not the same answer as MEASURED EMPTY, and
		// conflating them was worth 200MB.
		//
		// Null means no sync has read the scroller: we do not know what is on
		// screen, so the honest degradation is the whole page - precisely what
		// shipped before the band existed. Soft ink at high zoom is the defect
		// being fixed; no ink at all would be a worse one.
		if (!band) return wholePage(page);
		// A band with no area is a MEASUREMENT, and a deliberate one:
		// `bandFor` answers `emptyBand()` for a scroller reporting zero
		// clientWidth/clientHeight, which is how a pane in a background tab
		// releases its canvases instead of holding them on an invisible
		// surface (ScrollBand.ts). Reading that as "unknown" and painting
		// whole pages inverted it - five live pages at the raised 10M cap is
		// 200MB of backing store for a tab nobody is looking at.
		if (band.width <= 0 || band.height <= 0) return null;
		return pageBandFor(band, page);
	}

	/**
	 * The one backing every canvas in the current band is drawn at.
	 *
	 * Zero when there is no measured band, which is the caller's signal to
	 * fall back to the per-page law - the only case where per-page is the
	 * honest answer, because that is also the case where the canvases cover
	 * whole pages.
	 *
	 * Cached because `bandBacking` is a multiply and a square root and this is
	 * asked once per page per paint, and invalidated on the two inputs that
	 * can change it: the band (in `syncBand`) and the display's dpr.
	 */
	function surfaceBacking(this: PdfInkController, dpr: number): number {
		const band = this.band;
		if (!band || band.width <= 0 || band.height <= 0) return 0;
		if (this.bandBackingPx > 0 && this.bandBackingDpr === dpr) return this.bandBackingPx;
		this.bandBackingPx = bandBacking(band.width, band.height, dpr, MAX_OVERLAY_PX);
		this.bandBackingDpr = dpr;
		return this.bandBackingPx;
	}

	/**
	 * Is a gesture holding pixels on the wet layer right now?
	 *
	 * This, and not `frame`, is what the band freeze is allowed to test.
	 * `frame` is set at pen-down for EVERY gesture including the two that are
	 * not ink - a pan and an insert-space - so gating on it froze the band on
	 * the one gesture whose entire purpose is to move the viewport. Worse, it
	 * outlived the gesture (see `penUp`), and a frozen band is not merely
	 * stale: every page outside it fails `pageBandFor`, so `paint` DROPS the
	 * committed canvas of every page scrolled to afterwards. One pan and the
	 * document went blank for the life of the view.
	 *
	 * The set is "who owns live pixels on the shared wet/head pair", which is
	 * exactly who a reposition would shear: a stroke (`builder`), an erase, a
	 * selection drag, a lasso loop being traced, an insert-space divider. A
	 * pan is deliberately absent - it scrolls, so the band must follow it.
	 *
	 * Field-for-field `!idle` (see its own header just above this one) - the
	 * same five things that would be torn by a store swap underneath them are
	 * exactly the ones a band reposition would shear out from under a live
	 * gesture. One field list, read two ways, rather than a second one to
	 * drift out of sync with it.
	 */
	function wetGestureLive(this: PdfInkController): boolean {
		return !this.idle;
	}

	/**
	 * Put the band where this viewport needs it. True when it actually moved.
	 *
	 * Lazy on purpose, and this is the whole of the hot-path rule: a scroll
	 * that stays inside the margin answers false out of `bandNeedsMove` -
	 * O(1), one short-lived object, no content scaling - and nothing else
	 * runs. Only a scroll that has eaten into the margin costs a reposition,
	 * and a reposition costs a re-raster of every stroke on every page the
	 * band touches, which is why it is bought this reluctantly.
	 */
	function syncBand(this: PdfInkController, scroller: HTMLElement): boolean {
		// Frozen while ink is live; see `bandBoxFor`.
		if (this.wetGestureLive()) return false;
		// O(1) and cheap, which is the whole hot-path claim - not free of
		// layout. The four size fields are layout reads - `clientWidth`,
		// `clientHeight`, `scrollWidth`, `scrollHeight` all flush pending
		// layout when it is dirty - and in Blink so are `scrollLeft` and
		// `scrollTop`: reading either kind goes through the same layout
		// update. What makes the two offsets cheap here is that the size
		// fields already forced layout clean earlier in the frame (they
		// change only on a resize or a zoom, both of which are already
		// observed and both of which reach `sync`, where the cache is
		// refreshed) - so a scroll event reads two offsets against an
		// already-clean layout, then calls `viewportAt` and a
		// `bandNeedsMove` comparison: O(1), two short-lived objects at most
		// (`viewportAt` always, `bandFor` only when the band actually
		// moves), no content scaling. It used to read all six fields off the
		// element, which is four layout reads per scroll event on a surface
		// that fires them continuously.
		const size = this.scrollerSize ?? (this.scrollerSize = scrollerSizeOf(scroller));
		const viewport = viewportAt(size, scroller.scrollLeft, scroller.scrollTop);
		if (!bandNeedsMove(this.band, viewport)) return false;
		this.band = bandFor(viewport);
		// A new band is a new area, so the one backing derived from it is
		// stale. Dropped rather than recomputed: nothing needs it until the
		// first `backingFor` of the repaint this move is about to trigger.
		this.bandBackingPx = 0;
		return true;
	}

	/**
	 * Put the one pair on the page this gesture is on, sized to it.
	 *
	 * Called at every pen-down, and the parentage is checked against the DOM
	 * rather than against `wetHostPage`: a gesture that never got its pen-up
	 * (pointercancel, a viewer re-render) leaves the pair on the old page, and
	 * bookkeeping that believed otherwise would strand the wet ink there. The
	 * re-append is skipped only when the DOM already says the pair is this
	 * page's last two children - which is the same DOM, not a belief about it.
	 * Skipping it matters: moving a node is a childList mutation on the page
	 * div, which our own observer cannot tell from the viewer's writes, so an
	 * unconditional move would invalidate the probe and schedule a full sync
	 * at the start of every stroke.
	 *
	 * Last two children on purpose. All three canvases share `z-index: 2`
	 * (styles.css), so DOM order is what puts the wet ink above the committed
	 * ink. While a highlighter is down the pair's place is the last two
	 * children of the page's highlight group instead (`pairHome`), and a pair
	 * already there is left alone.
	 */
	function attachPair(this: PdfInkController, pageEl: HTMLElement, box: PageBox): WetPair | null {
		const pageNumber = box.pageNumber;
		const size = this.backingFor(pageEl, box);
		if (!size) return this.pair;
		let pair = this.pair;
		if (!pair) {
			const wetCanvas = pageEl.createEl("canvas", { cls: OVERLAY_CLASS });
			wetCanvas.setAttribute("aria-hidden", "true");
			const headCanvas = pageEl.createEl("canvas", { cls: OVERLAY_CLASS });
			headCanvas.setAttribute("aria-hidden", "true");
			const wet = new WetInkRenderer(wetCanvas, false);
			const tail = new TailRenderer(headCanvas);
			// ON, with a known cost this surface has not yet paid off.
			//
			// A smoothed wet layer holds the SETTLED tail only and leaves the
			// head that reaches the nib to the caller, on a layer of its own.
			// The note surface draws that head (TailRenderer); this one never
			// has, so the live stroke sits one sample behind the pointer -
			// about 4ms at pen rates, invisible; a visible trail at mouse
			// rates.
			//
			// Turning smoothing OFF instead was tried (2026-08-30) and
			// reverted the same day: the unsmoothed path draws per-segment
			// strokes whose anti-aliased end caps overlap at every sample,
			// and the stacked edges read as a fuzzy line at zoom. The real
			// fix is porting the head layer; until then the lag is the
			// smaller of the two evils.
			wet.smooth = true;
			// The same shaped width law the committed layer uses. Without it
			// the live stroke is drawn one way and redrawn another at pen-up,
			// and the ends visibly pull back as the taper appears (hardware,
			// 2026-08-29).
			//
			// The resting state only. This pair outlives every stroke drawn on
			// it, and the device is not a property of the pair, so `penDown`
			// rewrites this per stroke from `mouseStroke` - the same split the
			// note surface has (InkOverlay.ts, construction then pen-down).
			// Do not read this line as the whole answer.
			wet.shape = true;
			pair = { wetCanvas, headCanvas, wet, tail };
			this.pair = pair;
		} else {
			this.seatPair(pageEl, pageNumber);
		}
		if (pair.wetCanvas.width !== size.w || pair.wetCanvas.height !== size.h) {
			pair.wetCanvas.width = size.w;
			pair.wetCanvas.height = size.h;
			pair.headCanvas.width = size.w;
			pair.headCanvas.height = size.h;
			pair.wet.applyDpr(size.backing);
			pair.tail.applyDpr(size.backing);
		}
		this.placeBanded(pair.wetCanvas, size.band, size.pageW, size.pageH);
		this.placeBanded(pair.headCanvas, size.band, size.pageW, size.pageH);
		// The band, into the context transform, on EVERY attach and not only
		// on a resize: the pair keeps its backing store across pages and
		// gestures, so a same-sized band at a different offset would otherwise
		// inherit the previous gesture's translation and draw the whole stroke
		// displaced by the difference.
		//
		// This is also the entire reason nothing above `drawWet` had to
		// change. Every wet caller - the stroke, the head, the lasso loop, the
		// insert-space divider - keeps working in the page's own css px, and
		// the one place that knows a band exists is this transform. `cameraFor`
		// is untouched, so hit-testing, erase and selection could not drift
		// even if this arithmetic were wrong.
		this.bandTransform(pair.wetCanvas, size.band, size.backing);
		this.bandTransform(pair.headCanvas, size.band, size.backing);
		// A different page is a different, blank canvas as far as anything on
		// screen is concerned - that is what a pair per page gave for free.
		// The same page keeps its pixels: the lasso's outline lives on the wet
		// layer between gestures, and grabbing a selection must not blink it
		// off before the first move redraws it.
		//
		// Cleared at the PAGE's size, not the band's. The context is in page
		// coordinates now, so the band occupies `left..left+width` there; a
		// clear of `0..width` would miss most of it on any page scrolled into
		// from the left. Over-clearing costs nothing - a clearRect past the
		// canvas is clipped away.
		//
		// `!sameBand(this.pairBand, size.band)` alongside the page check: the
		// transform above is rewritten unconditionally, but the pixels already
		// on the pair are not - they stay wherever they were rasterised. A
		// same-sized band that has simply translated (a tall page at high
		// zoom, pen landing on the same page) hit neither the size check above
		// nor the page check here, so the transform moved on ahead while any
		// standing pixels (a lasso outline) stayed put in canvas space and
		// were re-presented displaced by exactly the band's delta the next
		// time anything drew. Harmless today only because every wet writer
		// this surface has begins its own gesture with a full clearRect.
		if (this.wetHostPage !== pageNumber || !sameBand(this.pairBand, size.band)) {
			pair.wet.clear(size.pageW, size.pageH);
			pair.tail.clearAll(size.pageW, size.pageH);
		}
		this.wetHostPage = pageNumber;
		this.pairBand = size.band;
		return pair;
	}

	/**
	 * Write a canvas's box inside the page div.
	 *
	 * The stylesheet stretches `.handwriting-pdf-ink` over the whole page with
	 * `inset: 0; width: 100%; height: 100%`. Inline `left/top/width/height`
	 * beat it, and `right`/`bottom` are then over-constrained and dropped by
	 * the box model - but only in one writing direction, so both are set to
	 * `auto` rather than relying on that.
	 *
	 * PERCENTAGES of the page, not px, and that is the whole of what this
	 * method decides. Absolute px detach the canvas from the page div the
	 * instant the viewer resizes it, and our repaint is behind the viewer by
	 * up to `SYNC_MIN_GAP_MS` (120) because it arrives through
	 * `scheduleThrottled`. A ctrl+wheel zoom is a burst of such resizes, and
	 * between each one and our catching up the ink sat at the wrong offset AND
	 * the wrong scale - for a tenth of a second, per step, which on a zoom
	 * gesture is the whole gesture. A percentage box stretches with the page
	 * exactly as the stylesheet's `inset: 0` did, so a stale band is merely
	 * slightly the wrong size instead of somewhere else entirely.
	 *
	 * The band stays integer-edged for the TRANSFORM (`bandTransform`), which
	 * is what the integer rounding in `pageBandFor` was for: the backing store
	 * is a whole number of device pixels and the raster inside it must line up
	 * with them. The percentage is derived from those same integers at paint
	 * time, so a settled page resolves it back to the integer it came from.
	 */
	function placeBanded(this: PdfInkController, canvas: HTMLCanvasElement, band: PageBandBox, pageW: number, pageH: number): void {
		const pct = (v: number, of: number): string => `${of > 0 ? (v / of) * 100 : 0}%`;
		canvas.setCssStyles({
			left: pct(band.left, pageW),
			top: pct(band.top, pageH),
			right: "auto",
			bottom: "auto",
			width: pct(band.width, pageW),
			height: pct(band.height, pageH),
		});
	}

	/**
	 * Point a canvas's context at PAGE coordinates, wherever its band sits.
	 *
	 * The translation is applied in device pixels (`-left * backing`) because
	 * `setTransform` replaces the matrix rather than composing with it, so the
	 * offset is expressed after the scale, not before it.
	 */
	function bandTransform(this: PdfInkController, canvas: HTMLCanvasElement, band: PageBandBox, backing: number): void {
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(backing, 0, 0, backing, -band.left * backing, -band.top * backing);
	}

	/**
	 * Take the pair off a page that is going away - an eviction, or an overlay
	 * being rebuilt because the viewer replaced the page's children. The
	 * renderers and their backing stores survive; only the parentage goes, and
	 * the next pen-down re-parents.
	 */
	function detachPairFrom(this: PdfInkController, pageNumber: number): void {
		if (this.wetHostPage !== pageNumber) return;
		this.pair?.wetCanvas.remove();
		this.pair?.headCanvas.remove();
		this.wetHostPage = 0;
		this.pairBand = null;
	}

	/** Destroy the pair: unmount, or a viewer rebuild that took our subtree. */
	function dropPair(this: PdfInkController): void {
		this.pair?.wetCanvas.remove();
		this.pair?.headCanvas.remove();
		this.pair = null;
		this.wetHostPage = 0;
		this.pairBand = null;
	}

	/**
	 * Put a live selection's outline back on a page that has just re-entered
	 * the band.
	 *
	 * The outline is drawn on the wet layer, and the wet layer is ONE pair for
	 * the whole surface. A page leaving the band takes `detachPairFrom` with
	 * it, which un-parents the pair and zeroes `wetHostPage` - but `selected`
	 * and `selectionPage` are untouched, because they are a statement about
	 * ink and not about pixels. So the selection stayed live, the toolbar
	 * stayed lit, delete and snip still worked, and the dashed box around the
	 * chosen ink was simply gone: scroll away from your selection and back and
	 * you could not see what you had picked up.
	 *
	 * REDRAWN rather than cleared, and that is the choice. Clearing on scroll
	 * would be quieter to implement and much worse to use - a selection is an
	 * object the reader made deliberately, and scrolling is not a decision to
	 * throw it away. Nothing else about a selection depends on being in view.
	 *
	 * Never while a gesture is live: there is one pair, the gesture owns it,
	 * and yanking it to another page mid-stroke would strand the wet ink.
	 */
	function restoreSelectionOutline(this: PdfInkController, pageEl: HTMLElement, box: PageBox): void {
		if (this.selected.length === 0 || this.selectionPage !== box.pageNumber) return;
		if (this.wetHostPage === box.pageNumber || this.wetGestureLive()) return;
		this.attachPair(pageEl, box);
		this.drawLasso(box);
	}

	function paint(this: PdfInkController, pageEl: HTMLElement, box: PageBox, scale: number, zoomed: boolean): void {
		const strokes = this.strokes(box.pageNumber);
		let attached = this.overlays.get(box.pageNumber);
		if (strokes.length === 0 && !this.owns(box.pageNumber)) {
			// Nothing to draw: drop the canvas rather than keep an empty one.
			// Unless a gesture is on this page - the FIRST stroke on a clean
			// page has nothing stored yet, and dropping its canvas would leave
			// the wet ink with nowhere to go until pen-up.
			if (attached) {
				this.dropHighlightLayer(attached);
				attached.canvas.remove();
				this.detachPairFrom(box.pageNumber);
				this.overlays.delete(box.pageNumber);
			}
			return;
		}
		// We are a guest inside someone else's element, and the host rewrites
		// it. On re-render the viewer can replace a page's children - taking
		// our canvas with them - and it can rewrite the page div's style
		// attribute, dropping the `position: relative` that our absolutely
		// positioned overlay resolves against. Either one leaves us believing
		// we are attached while we are detached, or positioned against some
		// ancestor far away. That is why the marks survived one zoom and then
		// went for good (hardware).
		//
		// So neither is assumed once. Both are re-checked every paint: the
		// page is re-positioned if it lost it, and an overlay that is no
		// longer OUR page's child is discarded and rebuilt rather than
		// painted into invisibly.
		if (this.win.getComputedStyle(pageEl).position === "static") {
			pageEl.setCssStyles({ position: "relative" });
		}
		// The pair stays this page's while a gesture is on it. The rebuild
		// below puts it back over the new canvas when `wetHostPage` still names
		// this page, the same re-append the first stroke on a clean page takes;
		// detaching it here instead left a live stroke, loop, box or divider
		// with nowhere to draw until the next pen-down.
		if (attached && attached.canvas.parentElement !== pageEl) {
			this.dropHighlightLayer(attached);
			attached.canvas.remove();
			if (!this.owns(box.pageNumber)) this.detachPairFrom(box.pageNumber);
			this.overlays.delete(box.pageNumber);
			attached = undefined;
		}
		// Measured BEFORE the canvas exists, and before the skip test.
		//
		// Before the skip test because the band is part of what makes a canvas
		// correct: a scroll that repositions it changes neither the scale nor
		// the stroke count, and skipping on those alone would leave the old
		// raster sitting in the new place. The measurement is a `clientWidth`
		// read on an element this method has already forced layout on
		// (`getComputedStyle`, above), so it adds no new class of cost - and
		// the skip below still fires whenever the band is where it was, which
		// is every sync that is not a scroll past the margin.
		//
		// Before the canvas because most pages of a zoomed pdf are OFF the
		// band, and the answer for those is null. Creating the canvas first
		// meant every one of them was built, given an attribute, appended -
		// two childList mutations on a page div our own observer cannot tell
		// from the viewer's writes - and then discovered to be off band and
		// removed, per page, per sync. Asking first costs nothing and the
		// off-band page never touches the DOM at all.
		const size = this.backingFor(pageEl, box);
		if (!size) {
			// The page is outside the band entirely, or the surface has been
			// measured and has no area at all (a pane in a background tab).
			// Drop its canvas rather than hold a full backing store for
			// something nobody can see - this is what makes the total pixel
			// count across a document the band's area instead of the sum of
			// every live page's. Unless a gesture is on it, for the reason the
			// empty-page branch above gives.
			if (attached && !this.owns(box.pageNumber)) {
				// Sized to nothing before it goes. A detached canvas is
				// collectible, but its backing store is held until the
				// collector gets to it, and the whole point of dropping it
				// here is the memory - the snip's own `finally` releases the
				// same way for the same reason.
				this.dropHighlightLayer(attached);
				attached.canvas.width = 0;
				attached.canvas.height = 0;
				attached.canvas.remove();
				this.detachPairFrom(box.pageNumber);
				this.overlays.delete(box.pageNumber);
			}
			return;
		}
		// A page that had no canvas is a page that had left the band (or has
		// only just become live). Remembered because a live selection's
		// outline lives on the wet layer, which went with it; see
		// `restoreSelectionOutline` at the end of this method.
		const rebuilt = !attached;
		if (!attached) {
			const canvas = pageEl.createEl("canvas", { cls: OVERLAY_CLASS });
			canvas.setAttribute("aria-hidden", "true");
			attached = { canvas, paintedScale: 0, paintedCount: -1, paintedBand: null };
			this.overlays.set(box.pageNumber, attached);
		}
		// The page's highlight layer, below the saved pen canvas: wanted while
		// the page holds a highlight or a highlighter is drawing on it, and
		// never on dark pages (`highlightLayered`), which keep the plain wash
		// on the pen canvas exactly as before. A layer that
		// came or went this paint defeats the skip below.
		const hadLayer = highlightLayers.has(attached);
		const wantLayer =
			(strokes.some((s) => s.tool === "highlighter") || (this.wetHighlighter && this.wetHostPage === box.pageNumber)) &&
			this.highlightLayered(box.pageNumber);
		const layer = wantLayer ? this.ensureHighlightLayer(pageEl, attached) : null;
		const dropped = !wantLayer && this.dropHighlightLayer(attached);
		// The highlights left with the layer and go onto the pen canvas below.
		// A paint that stops short of that (no 2d context, no page width yet)
		// must not let the next one skip as already correct.
		if (dropped) attached.paintedCount = -1;
		// The committed canvas was just appended, so it is on top of a
		// pair that is already on this page - the first stroke on a clean
		// page builds the overlay AFTER the pair went on. All three share
		// one z-index, so putting the pair back last is what keeps the wet
		// ink visible over the committed ink (§5h/H1). A highlighter's pair
		// goes back into the page's highlight group instead.
		if (this.wetHostPage === box.pageNumber && this.pair && (rebuilt || (layer !== null && !hadLayer))) {
			this.seatPair(pageEl, box.pageNumber);
		}
		const reported = this.viewTurn() ?? 0;
		const turn = turnToPaint(reported, this.pageSize.get(box.pageNumber), size.pageW, size.pageH);
		if (
			!zoomed &&
			attached.paintedScale === scale &&
			attached.paintedCount === strokes.length &&
			sameBand(attached.paintedBand, size.band) &&
			(paintedTurns.get(attached) ?? 0) === reported &&
			!dropped &&
			(layer === null || layer.painted)
		) {
			return; // already correct; the commonest case while scrolling
		}

		// The overlay's PAGE size is read from the box it is filling, never
		// written into it - the stylesheet stretches it and three separate
		// bugs in one afternoon came from writing numbers that then went stale
		// under a re-render. What IS written is the band: which part of that
		// page this canvas covers. The staleness argument is answered the same
		// way it always was, by never remembering the value - the band is
		// recomputed from the element on every paint and rewritten here.
		const { pageW, pageH, band, w, h, backing } = size;
		const canvas = attached.canvas;
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		this.placeBanded(canvas, band, pageW, pageH);
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		// Page coordinates, offset to the band's origin. Everything below this
		// line - the clear, the camera, `drawCommitted` - is written exactly as
		// it was when the canvas covered the whole page, which is the point:
		// page units stay page units and only where the pixels live moved.
		ctx.setTransform(backing, 0, 0, backing, -band.left * backing, -band.top * backing);
		ctx.clearRect(0, 0, pageW, pageH);
		// The drawing scale comes from the box we are filling divided by the
		// page's size in points - NOT from `--scale-factor` directly. The two
		// agree when the viewer is settled, and during a zoom they do not:
		// the scale factor updates on its own schedule while the box is
		// whatever it is right now. Deriving from the box means the ink always
		// fills the same fraction of the page it is drawn on, settled or not.
		const pageWidthPt = this.pageWidthPt(box.pageNumber, pageW, pageH, scale);
		if (pageWidthPt <= 0) return;
		// On a page the viewer turned a quarter, the upright width is the box's
		// HEIGHT, so the scale comes from that side; then the frame is turned
		// with the page. Upright pages take neither branch.
		const uprightW = turn === 90 || turn === 270 ? pageH : pageW;
		if (turn !== 0) ctx.transform(...turnMatrix(turn, pageW, pageH));
		const cam = { x: 0, y: 0, zoom: uprightW / pageWidthPt };
		if (layer) {
			// The highlights, opaque, on their own canvas: the same backing,
			// band, clear and turn as the pen canvas, so the two line up pixel
			// for pixel. The group above them carries the one wash.
			const hc = layer.canvas;
			if (hc.width !== w || hc.height !== h) {
				hc.width = w;
				hc.height = h;
			}
			this.placeBanded(hc, band, pageW, pageH);
			const hctx = hc.getContext("2d");
			if (hctx) {
				hctx.setTransform(backing, 0, 0, backing, -band.left * backing, -band.top * backing);
				hctx.clearRect(0, 0, pageW, pageH);
				if (turn !== 0) hctx.transform(...turnMatrix(turn, pageW, pageH));
				this.drawHighlights(hctx, cam, strokes);
			}
			layer.painted = true;
			// No context for the highlight canvas (a browser at its canvas
			// memory cap answers null): the pen canvas keeps the highlights
			// at the plain wash, as before the layer, rather than drop them.
			this.drawCommitted(ctx, cam, hctx ? strokes.filter((s) => s.tool !== "highlighter") : strokes);
		} else {
			this.drawCommitted(ctx, cam, strokes);
		}
		if (reported !== 0) paintedTurns.set(attached, reported);
		else paintedTurns.delete(attached);
		attached.paintedScale = scale;
		attached.paintedCount = strokes.length;
		attached.paintedBand = band;
		if (rebuilt) this.restoreSelectionOutline(pageEl, box);
	}

	/**
	 * Committed ink onto a context, in the one order every surface uses:
	 * highlighter washes first and translucent, then the ink over them.
	 * Shared by the overlay and the snip so the picture a reader takes
	 * away is the picture they were looking at.
	 */
	function drawCommitted(this: PdfInkController, ctx: CanvasRenderingContext2D, cam: CameraState, strokes: readonly InkStroke[]): void {
		ctx.globalAlpha = 0.35;
		for (const s of strokes) if (s.tool === "highlighter") drawStroke(ctx, cam, s, undefined, true);
		ctx.globalAlpha = 1;
		for (const s of strokes) if (s.tool !== "highlighter") drawStroke(ctx, cam, s, undefined, true);
	}

	/**
	 * The highlights alone, opaque, for a layer that applies the wash once
	 * (the page's highlight group, the snip's composite).
	 */
	function drawHighlights(this: PdfInkController, ctx: CanvasRenderingContext2D, cam: CameraState, strokes: readonly InkStroke[]): void {
		ctx.globalAlpha = 1;
		for (const s of strokes) if (s.tool === "highlighter") drawStroke(ctx, cam, s, undefined, true);
	}

	/**
	 * Do highlights get a layer of their own here? Not on dark pages: a
	 * multiply wash over a dark page leaves no colour band, so those pages
	 * keep the plain wash on the pen canvas, on screen and in the snip,
	 * exactly as before. Dark is what the reader declares ("Lighten for dark
	 * pages"), or what the app has made the pages (`appDarkPages`), or, past
	 * those two, what the PDF file itself draws on this page (`fileDarkPage`).
	 */
	function highlightLayered(this: PdfInkController, pageNumber: number): boolean {
		return this.pageAssumption() !== "lighten" && !appDarkPages(this) && !fileDarkPage(this, pageNumber);
	}

	/**
	 * Has the app rendered this viewer's pages dark? The PDF view's "Adapt to
	 * theme" under a dark theme does, and marks it two ways: `mod-themed` on
	 * the viewer's `.pdf-container`, and `theme-dark` on the body of the
	 * window it is in. The body is read through the container, so a PDF in a
	 * popout reads the popout's.
	 *
	 * Read live at every ask, never kept, because both change under an open
	 * PDF, and the repaint for each is already there: the option's own click
	 * toggles the container's class, a record for the root observer (which
	 * watches `class` under the leaf), and a theme switch is `css-change`,
	 * whose fan-out refreshes every open PDF.
	 *
	 * A scroller with no `closest` is not an element the app could have
	 * themed, so it reads as not dark rather than throwing inside a paint.
	 */
	function appDarkPages(controller: PdfInkController): boolean {
		const scroller = controller.boundScroller;
		if (typeof scroller?.closest !== "function") return false;
		const container = scroller.closest(".pdf-container");
		const doc = container?.ownerDocument;
		if (!container || !doc) return false;
		const themed = container.classList.contains("mod-themed");
		const dark = isDarkTheme(doc);
		return themed && dark;
	}

	/**
	 * This page overlay's highlight layer, made if it has none, and kept just
	 * below the saved pen canvas so pen ink always shows over a highlight.
	 */
	function ensureHighlightLayer(this: PdfInkController, pageEl: HTMLElement, attached: Attached): HighlightLayer {
		const had = highlightLayers.get(attached);
		if (had && had.group.parentElement === pageEl) {
			if (had.group.nextElementSibling !== attached.canvas && attached.canvas.parentElement === pageEl) {
				pageEl.insertBefore(had.group, attached.canvas);
			}
			return had;
		}
		if (had) this.dropHighlightLayer(attached);
		const group = pageEl.createDiv({ cls: `${OVERLAY_CLASS} ${HIGHLIGHT_GROUP_CLASS}` });
		group.setAttribute("aria-hidden", "true");
		if (attached.canvas.parentElement === pageEl) pageEl.insertBefore(group, attached.canvas);
		const canvas = group.createEl("canvas", { cls: `${OVERLAY_CLASS} ${HIGHLIGHT_CANVAS_CLASS}` });
		canvas.setAttribute("aria-hidden", "true");
		const layer: HighlightLayer = { group, canvas, painted: false };
		highlightLayers.set(attached, layer);
		return layer;
	}

	/**
	 * Take a page's highlight layer down, its backing store sized to nothing
	 * first, as every drop of the pen canvas does. A live pair inside it goes
	 * back onto the page rather than out of the document with it. True when
	 * there was a layer.
	 */
	function dropHighlightLayer(this: PdfInkController, attached: Attached | undefined): boolean {
		const layer = attached ? highlightLayers.get(attached) : undefined;
		if (!attached || !layer) return false;
		const pair = this.pair;
		const page = layer.group.parentElement;
		if (pair && pair.wetCanvas.parentElement === layer.group && page) {
			page.appendChild(pair.wetCanvas);
			page.appendChild(pair.headCanvas);
			markOwnMove(this, pair.wetCanvas, pair.headCanvas);
		}
		layer.canvas.width = 0;
		layer.canvas.height = 0;
		layer.group.remove();
		highlightLayers.delete(attached);
		return true;
	}

	/**
	 * Where the shared pair belongs on this page right now: inside the page's
	 * highlight group while a highlighter is drawing (the live wash is then
	 * the same one layer as the saved highlights, before and after the lift),
	 * and on the page itself, over the saved pen ink, for everything else.
	 */
	function pairHome(this: PdfInkController, pageEl: HTMLElement, pageNumber: number): HTMLElement {
		if (!this.wetHighlighter || !this.highlightLayered(pageNumber)) return pageEl;
		const attached = this.overlays.get(pageNumber);
		if (!attached || attached.canvas.parentElement !== pageEl) return pageEl;
		return this.ensureHighlightLayer(pageEl, attached).group;
	}

	/**
	 * Put the pair as the last two children of its home, and leave it alone
	 * when it already is: a node move is a childList write the root observer
	 * sees. A move between a page and its own highlight group is marked as
	 * ours for the observer; any other move is left for it to see, as before.
	 */
	function seatPair(this: PdfInkController, pageEl: HTMLElement, pageNumber: number): void {
		const pair = this.pair;
		if (!pair) return;
		const home = this.pairHome(pageEl, pageNumber);
		if (pair.wetCanvas.parentElement === home && home.lastElementChild === pair.headCanvas) return;
		const from = pair.wetCanvas.parentElement;
		const groupMove =
			(home !== pageEl && (from === pageEl || from === home)) ||
			(home === pageEl && from !== null && from.parentElement === pageEl && isHighlightLayerNode(from));
		home.appendChild(pair.wetCanvas);
		home.appendChild(pair.headCanvas);
		if (groupMove) markOwnMove(this, pair.wetCanvas, pair.headCanvas);
	}

/**
 * The pair canvases this controller has just moved between a page and its
 * highlight group, held until the root observer has been handed that move's
 * records. Each mark is made AFTER its move and taken off in a microtask
 * queued then: the move's first record queued the observer's delivery (or
 * joined one already queued), so the delivery runs first and sees the mark,
 * and a later move by anything else does not. Counted, so one move's
 * microtask cannot take off another's mark of the same canvas.
 */
const ownMoves = new WeakMap<PdfInkController, Map<Node, number>>();

function markOwnMove(controller: PdfInkController, ...nodes: Node[]): void {
	let marked = ownMoves.get(controller);
	if (!marked) {
		marked = new Map();
		ownMoves.set(controller, marked);
	}
	const held = marked;
	for (const n of nodes) held.set(n, (held.get(n) ?? 0) + 1);
	queueMicrotask(() => {
		for (const n of nodes) {
			const left = (held.get(n) ?? 0) - 1;
			if (left > 0) held.set(n, left);
			else held.delete(n);
		}
	});
}

/**
 * Is this childList record only a highlight layer appearing or going, or the
 * pair moving between a page and its highlight group? Read by
 * `isOwnMutation`; every other record is judged exactly as before.
 */
export function isOwnLayerRecord(controller: PdfInkController, record: MutationRecord): boolean {
	if (record.type !== "childList") return false;
	const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
	if (nodes.length === 0) return false;
	const marked = ownMoves.get(controller);
	return nodes.every((n) => isHighlightLayerNode(n) || (marked?.get(n) ?? 0) > 0);
}

export function installPdfBand(proto: PdfInkController): void {
	installMethods(proto, {
		sync,
		pageWidthPt,
		isRotated,
		viewTurn,
		frameBox,
		owns,
		ensureOverlay,
		pageElement,
		wetOn,
		backingFor,
		bandBoxFor,
		surfaceBacking,
		wetGestureLive,
		syncBand,
		attachPair,
		placeBanded,
		bandTransform,
		detachPairFrom,
		dropPair,
		restoreSelectionOutline,
		paint,
		drawCommitted,
		highlightLayered,
		ensureHighlightLayer,
		dropHighlightLayer,
		pairHome,
		seatPair,
		drawHighlights,
	});
}
