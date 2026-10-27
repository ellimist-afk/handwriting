/**
 * The overlay's camera pin: the sync that holds the camera on the note surface for one frame, from the scroll, the zoom and the document top.
 * They are methods of InkOverlayPlugin, installed on its prototype when InkOverlay.ts loads.
 */
import { contentOrigin } from "./ContentOrigin";
import { anchorTop } from "./DocumentTop";
import { RUNG_SPACING } from "./DocumentAnchor";
import { fontZoomFactor, ownedEffectiveScale, visualToNote } from "./ZoomScale";
import { installMethods } from "./InstallMethods";
import { CAMERA_STILL_BACKING_PX, cameraWithin, SCALE_EPSILON, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		syncCamera(): void;
	}
}


	/**
	 * Pin the camera so world == note surface: the camera holds the surface
	 * point currently at the overlay's top-left. `documentTop` is CM's public
	 * "top of the document in screen coordinates", so this is two subtractions.
	 * No scrollTop bookkeeping; padding is handled by CM - see `anchorTop` for
	 * the one frame in which CM's own answer for it is not yet true.
	 */
	function syncCamera(this: InkOverlayPlugin): void {
		if (this.deferPinchRaster()) return;
		if (!this.container) return;
		// A stroke in flight owns its coordinate frame until it ends.
		if (this.frame.locked) return;
		const overlay = this.container.getBoundingClientRect();
		// One scan, two uses: the number the camera paints against, and the
		// element that has to be watched for it to change. CodeMirror recycles
		// `.cm-line` divs, so the watch is re-pointed from here rather than
		// installed once - and since the scan has just run anyway, the re-arm
		// costs one reference comparison on the frames where it did not move.
		const origin = contentOrigin(this.view.contentDOM);
		// De-panned, like every other camera-facing column read: `.cm-content`
		// rides inside `.cm-sizer`, which carries the text half of the focal
		// pan. The raster camera below accounts only for its baked portion;
		// the ink layer carries the rest. Letting raw pan into this read is the double-apply a
		// deferral lapse - a finger held still past PINCH_SCROLL_QUIET_MS, which
		// lets this method run mid-gesture - would otherwise produce.
		const contentLeft = this.resolveColumnLeft(this.unpanX(origin.left));
		this.watchOriginLine(origin.line, contentLeft);
		// THE ANCHOR THE TEXT IS LAID OUT WITH, which for one frame is not the
		// anchor CodeMirror reports.
		//
		// `view.documentTop` is `contentDOM.getBoundingClientRect().top +
		// viewState.paddingTop`, and that second term is a BELIEF: 0 from
		// construction until CodeMirror's first measure cycle writes the
		// computed value into it, a cycle reached only from the rAF the
		// constructor requests. The CSS padding is in force the whole time, so
		// in that window the top is short by the padding while the text has not
		// moved at all - and a stroke stored there is stored that far off its
		// own line, for good, because the store is what persists. Measured on a
		// real editor at `test/render/UnsettledTopMechanisms.test.ts`: with
		// Minimal's 8px the belief is 0, the stylesheet says 8, one frame later
		// the top has moved by exactly 8, and the `.cm-line` has not moved.
		//
		// The heal at the end of this method cannot reach it. That compare
		// re-rasterizes so the picture and the eraser agree about where the ink
		// IS; it cannot put the ink back on the line, because by then the wrong
		// number is already in the stored coordinate. This is the half that has
		// to be right at store time.
		//
		// Only the PADDING term is replaced. The rect term passes through
		// untouched on purpose: when something above `.cm-content` grows, the
		// content and every line in it move together, so ink stored before it
		// is still on its line and correcting for that would move correct ink
		// off the words (mechanism R in the same file).
		//
		// `this.contentStyle` is the live `getComputedStyle(contentDOM)` object
		// `handleResize` already holds and this method already reads `fontSize`
		// off a few lines down, so the cost is one more property read after the
		// rects above have forced layout, and no `getComputedStyle` call. Absent
		// only before the first `handleResize` has run, and `anchorTop` falls
		// back to CodeMirror's own answer there.

		// Measure the SCALE from the same rect read as the camera, every
		// time, instead of trusting the value handleResize last cached.
		//
		// The cache was the bug (alan, hardware, zoom report): after a pinch
		// it read 2.1730 while the editor was really scaled 1.7115 - the
		// overlay's own 2389.26 visual over 1396 layout px, which CM's scaleX
		// and the content element both agreed with. The pen divides by this
		// number, so every coordinate came out at 0.788 of where it belonged,
		// compressed toward the top-left. Which code path failed to refill
		// the cache stopped mattering once the pen measures for itself: the
		// scale and the camera now come from one read and cannot disagree.
		const measured = ownedEffectiveScale({
			visualWidth: overlay.width,
			layoutWidth: this.container.offsetWidth,
			cmScaleX: this.view.scaleX,
		}, this.pinchScaleNow);
		if (measured === null) {
			this.scaleGeometryValid = false;
			this.router?.cameraTransformChanged();
			return;
		}
		this.scaleGeometryValid = true;
		// Adopt it only when it MEANS something. Rect widths are fractional,
		// so this quotient wobbles in its last decimals every frame; letting
		// that through moved the camera origin every frame, and repaint()
		// treats any camera motion as a full re-rasterization of every
		// stroke - turning the damage-rect fast path off entirely, and
		// defeating handleResize's unchanged guard so five 10-megapixel
		// canvases could be reallocated for nothing. A real zoom step is
		// thousands of times larger than this threshold, so nothing that
		// matters is filtered out.
		if (Math.abs(measured - this.cssScale) > this.cssScale * SCALE_EPSILON) {
			this.router?.cameraTransformChanged();
			this.cssScale = measured;
   if(this.viewportLayout && Math.abs(measured/this.pinchScaleNow-this.viewportLayout.externalScale)>SCALE_EPSILON) this.viewportLayout.externalScale=measured/this.pinchScaleNow;
		}
		// And the FONT zoom, which until 1.4.10 only `handleResize` ever
		// wrote. The two observers do not fire together: changing the editor
		// font size makes the lines taller, which resizes `.cm-content` and
		// not `.cm-editor`, so `contentResizeObserver` fires alone and lands
		// here with `this.fontZoom` still describing the old font. The camera
		// was then rebuilt with a scale short by the whole font ratio - 48px
		// of displacement at a 1400px pane going 16px to 20px, measured in
		// `test/render/MinimalCameraScale.test.ts`, and theme-independent:
		// Minimal and stock produce the same number to six places.
		//
		// One string compare against the style object `handleResize` already
		// holds, so a sync where the font did not change costs a property read
		// and a comparison and no new style object. `refFontPx` is NOT touched
		// here: it latches at mount and is what every persisted coordinate on
		// the note is expressed against.
		//
		// Against `lastSyncFontStr` and not `lastFontStr`: that field is how
		// `update()` decides to call `handleResize` on a font change, and
		// writing it here consumed the difference before `update()` could see
		// it. See the field's own comment.
		const fontStr = this.contentStyle?.fontSize;
		if (fontStr !== undefined && fontStr !== this.lastSyncFontStr) {
			this.lastSyncFontStr = fontStr;
			this.fontZoom = fontZoomFactor(Number.parseFloat(fontStr), this.refFontPx);
			// The paper too, on the same change and no other: this is the one
			// place a font change lands without the refresh path.
			this.paperFontPx = Number.parseFloat(fontStr);
			this.updatePaperSpacing();
			// And the line anchors' signature.
			this.requestLineSignature();
		}
		// Unconditionally, not inside the epsilon branch above: the font zoom
		// can move on a frame where the css scale did not, and leaving
		// `this.scale` stale there was half of the same defect.
		this.scale = this.cssScale * this.fontZoom;
		// Use the adopted scale in both this method and its read-only twin.
		// ONE rect read, and it is the ANCHOR PROBE's rather than
		// `.cm-content`'s - see DocumentAnchor.ts for why the large rect is the
		// defect. `anchorTop` is still the fallback and is still what the
		// number below means, so nothing downstream changes shape.
		const anchor = this.anchorCameraY(overlay.top);
		const documentTopPanned = anchor ? anchor.impliedTop : anchorTop(this.view, this.contentStyle?.paddingTop, this.cssScale);
		const documentTop = documentTopPanned - this.panY();
		// Stashed for the scroll probe: read once, here, never re-read there.
		this.lastSyncRectLeft = overlay.left;
		this.lastSyncRectTop = overlay.top;
		this.lastSyncContentLeft = contentLeft;
		this.lastSyncDocumentTop = documentTop;
		// Stashed for the scroll probe, in the same synchronous block as the
		// rects above so a diagnostic can never blame a mismatch on having
		// read the two at different moments.
		this.lastSyncScrollLeft = this.view.scrollDOM.scrollLeft;
		this.lastSyncScrollTop = this.view.scrollDOM.scrollTop;
		// Both reads are visual px; the difference becomes note space by
		// dividing out the scale. At scale 1 this is arithmetically identical
		// to what shipped, so persisted coordinates keep their meaning.
		// Both reads are visual px. The camera origin is the overlay's WORLD
		// coordinate, so the division is by the TOTAL factor (cssScale × font
		// zoom). The font zoom itself rides on the camera as a real zoom:
		// worldToScreen multiplies by it, screenToWorld divides by it, so the
		// forward and inverse transforms are inverses by construction.
		// Subtract the two scrolling rects before adding the pan. Removing it
		// from only one operand first rounds differently as both rects scroll,
		// creating camera motion and a full repaint while the band is still.
		const layoutColumn = this.ownedColumnLayoutLeft(origin.line);
		this.camera.setState(
			(layoutColumn === null ? visualToNote(origin.left === null ? overlay.left - contentLeft : (overlay.left - origin.left) + this.panX(), this.scale) : (this.band!.left - layoutColumn) / this.fontZoom) - (this.rasterPan?.x ?? 0) / this.fontZoom,
			// THE ANCHORED FORM, when the ladder answered: the rung's own offset
			// enters as an exact integer of layout px, and only the residual -
			// at most half a rung spacing from where the camera was left - is
			// divided by the believed cssScale. The fallback is the shipped
			// expression, unchanged, so a view without the widget is
			// arithmetically what it was.
			this.canonicalCameraY(anchor
				? anchor.layout / this.fontZoom - (this.rasterPan?.y ?? 0) / this.fontZoom
				: visualToNote((overlay.top - documentTopPanned) + this.panY(), this.scale) - (this.rasterPan?.y ?? 0) / this.fontZoom, true),
			this.fontZoom
		);
		// Where the next sync starts looking for a rung. A stored number, not a
		// DOM write: nothing inside contentDOM is touched on the scroll path.
		if (anchor) this.anchorCameraYLayout = anchor.layout;
		// The parity gate runs at mount, at every basis reset and at every adoption. All
		// three already cost a mount or a full redraw, and `basisResets` measures
		// 0 per round on the far arms, so the gate's one rect read is never on
		// the steady scroll path.
		if (anchor && (this.anchorGateDue || this.anchorAdoptionEvent)) {
			const why = this.anchorGateDue ? "mount" : "adoption";
			this.anchorGateDue = false;
			this.gateAnchorParity(why, anchor.impliedTop, anchor.rung * RUNG_SPACING);
		}
		this.anchorAdoptionEvent = false;
		// THE ORIGIN MOVED SINCE THE PIXELS WERE DRAWN. Ask for the frame that
		// redraws them.
		//
		// Ink is anchored to two numbers and nothing else - the text column's
		// left edge and the document top - and both of them are in this
		// camera (`UnsettledDocumentTop.test.ts` derives that identity through
		// this method and the router). The column has had a compare since
		// Minimal: `handleResize`'s unchanged arm and `originLineResized`,
		// both against `lastSyncContentLeft`, both scheduling a repaint. The
		// document top had NONE, and that was a real defect rather than a
		// theoretical one. CodeMirror's `viewState.paddingTop` is 0 until its
		// first measure cycle, and Obsidian's inline title, its properties
		// block and any font swap all sit ABOVE `.cm-content` and settle on
		// their own schedule - so on a fresh mount the top moves at a fixed
		// scroll position, and something above `.cm-content` growing does not
		// RESIZE `.cm-content`, `.cm-editor` or the watched `.cm-line`. No
		// observer fires. The camera then adopted the new top at the next
		// sync for any reason, NOTHING repainted, and committed ink went on
		// being drawn where the old top put it - so the eraser probed where
		// the ink is not, found nothing, and returned silently on a page
		// whose store is not empty (alan, relaying the owner, 1.4.11).
		//
		// AGAINST `lastPaintCam`, AND NOT AGAINST `lastSyncDocumentTop`. The
		// document top is a SCREEN coordinate: `contentDOM
		// .getBoundingClientRect().top + paddingTop`, which CodeMirror
		// documents as going negative when the editor is scrolled down. It
		// moves by the whole delta on every scroll, so comparing it directly
		// would ask for a repaint on every scrolled frame - and, with a via
		// that asserts damage, a full re-rasterization of every visible
		// stroke plus an index rebuild per frame, on a plugin that runs on
		// e-ink. Measured against the tests below, that cut asked for twelve
		// repaints where this one asks for two. The camera origin is that
		// number minus the band's own rect top, and the band lives INSIDE the
		// scroller, so both terms move together and the origin is exactly
		// still through a scroll. It moves when the anchor really moved,
		// which is the event this is for.
		//
		// `lastPaintCam` is the camera the committed layer was last drawn
		// with (set in `repaint`, cleared when a reallocation blanks the
		// canvases), so this compares what the pixels say against what the
		// camera now says, on the same three fields and the same bar `repaint`
		// uses to decide the same question one step later. Absent means
		// nothing has been painted yet, and nothing painted cannot be stale;
		// truthiness rather than `!== null` because the prototype-built
		// fixtures that exercise this method leave the field off entirely,
		// and "no recorded paint" is the right reading of that too.
		//
		// "scroll" as the via ON PURPOSE. It asserts no damage and does not
		// dirty the index (the index is in world space; the camera cannot
		// stale it), and `repaint` upgrades any camera motion past the bar to a
		// full redraw by itself. So the frame this queues costs a full re-raster
		// exactly when one is needed, and costs an empty callback when this
		// call was already inside the repaint that is about to fix it.
		// The three getters and not `camera.snapshot`: that one spreads a
		// fresh object every call, and this runs on every scrolled frame.
		//
		// NOT WHILE AN EDGE BOUNCE PLAYS. The camera is built from rects that
		// ride the bounce's translate plus a pan that carries the same live
		// offset; the two cancel on paper and not bit for bit, so the exact
		// compare of the time found a new camera on every bounce frame and each repaint's
		// own sync queued the next - a full re-raster per frame for the whole
		// half second (Orion scroll probe, 2026-09-29). The camera still syncs
		// here; the bounce's last frame syncs once more, with no bounce live,
		// and that sync asks for the one repaint a real move owes.
		//
		// The same sub-pixel bar as `repaint` (committedRepaintPlan): a camera a
		// hair off the painted one owes no repaint here either.
		const painted = this.lastPaintCam;
		if (
			painted &&
			!this.bounceState &&
			!cameraWithin(painted.x, painted.y, painted.zoom, this.camera.x, this.camera.y, this.camera.zoom,
				this.committedBacking ?? 0, CAMERA_STILL_BACKING_PX)
		) {
			this.scheduleRepaint("scroll");
		}
	}

export function installInkOverlayCamera(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		syncCamera,
	});
}
