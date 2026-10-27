/**
 * The note surface's lifecycle: mount and unmount, the pen tools strip and finger ink, the backings' release,
 * loading a note's ink and its font reference, the page class, the remembered camera, and destroy. They are
 * methods of InkOverlayPlugin, installed on its prototype when InkOverlay.ts loads.
 */
import { redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { Notice, Platform, editorInfoField } from "obsidian";
import { runGatedCommand } from "../CommandPaletteSplit";
import { unmountDocumentAnchor } from "./DocumentAnchor";
import { noteCameras } from "./NoteCamera";
import { tipMode } from "./TipMode";
import { MobileTools, ensureNoteZoomControls, destroyNoteZoomControls } from "./MobileTools";
import { clipboardSize } from "./InkClipboard";
import { getPenToolsMode, penSeenThisSession, penToolsVisible } from "./PenToolsMode";
import { deviceHasTouch } from "./DeviceInput";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { routineNoticesVisible } from "../diag/RoutineNotices";
import { HIGHLIGHTER_ALPHA } from "../ink/PenStyle";
import { colorsFor, getInkColorHex } from "../ink/InkColor";
import { applyInkPreset, forgetInkPreset, inkPresetsFor, starInkPreset } from "../ink/InkPresets";
import { InkTool } from "../ink/Stroke";
import { TailRenderer } from "../ink/TailRenderer";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { runDetached } from "../util/Detached";
import { lassoDeleteNotice } from "./InlineSelectionDelete";
import { clearMetadataVisibility, isMetadataMutation, updateMetadataVisibility } from "./MetadataVisibility";
import { inkChangeRearmsNotice } from "./EmptyPageNotice";
import { setKeyboardFocus } from "./InlineFocus";
import { onInkChanged } from "./InkEvents";
import { discardUndoTrace } from "../diag/UndoHistoryTrace";
import { MIN_PINCH_SCALE } from "./PinchScale";
import { canvasForNote, onCanvasOverrideChanged } from "./CanvasNoteOverride";
import { visualToNote } from "./ZoomScale";
import { InlinePenRouter, bandEraserIntent } from "./InlinePenRouter";
import { mouseInkEnabled, toolPickedHere } from "./MouseInk";
import { penInkEnabled } from "./PenInk";
import { fingerInkEligible } from "./FingerInk";
import { setHitProbeContext } from "./PenHitProbe";
import { surfaceExtents, ZERO_EXTENT } from "./SurfaceExtent";
import { scrollProbeScroll, scrollProbeWheel } from "./ScrollProbe";
import { installMethods } from "./InstallMethods";
import { applyToolbarPlacement, armMouseInkQuietlyEverywhere, commitEraserRadius, copySelectionNotice, copySelectionNoticeIsRoutine, cutSelectionNotice, cutSelectionNoticeIsRoutine, enabled, getEraserRadiusPx, getEraserWholeStrokes, getInkSizeMult, getInlineEraserMode, getInlineLassoMode, getInlinePanMode, getInlineSpaceMode, getInlineTool, INLINE_DESYNCHRONIZED, inlineInk, inlineTool, instances, metrics, OVERSCROLL_GIVE_PX, persistEraserMode, persistInkSize, pickStripColor, PINCH_SCROLL_QUIET_MS, releaseMouseInkQuietlyEverywhere, scrollExpansionEnabled, setEraserRadiusPx, setEraserWholeStrokes, setInkSizeMult, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		mount(): void;
		loadInk(path: string | null): void;
		adoptStoredFontRef(path: string): void;
		releaseHeldFontRef(): number;
		updateHandwritingPageClass(): void;
		ensurePenTools(): void;
		prepareFingerInk(): void;
		ensurePenToolsInner(): void;
		releaseBackings(): void;
		unmount(): void;
		destroy(): void;
		saveNoteCamera(): void;
		armNoteCameraRestore(path: string | null): void;
		restoreNoteCamera(path: string): void;
	}
}

	function mount(this: InkOverlayPlugin): void {
		// Destroyed: out of `instances` for good (its popout closed, closeInlineInkDocument).
		// A late editor update must not mount it again: CodeMirror's own destroy() returns
		// early for an overlay no longer registered, so nothing would ever release that mount.
		if (this.container || !enabled || this.destroyed) return;
		this.retiring = false;
		// Not a file-backed markdown editor (e.g. a bare CM instance): stay inert.
		// An owner with no file (a Canvas text card) has nowhere to save ink:
		// claiming the pen there dropped every stroke at lift (audit #13).
		const info = this.view.state.field(editorInfoField, false);
		if (info === undefined || !info.file) return;
		if (!this.ownsMarkdownEditorRoot()) return;
		this.invalidateReloadBindings(this.lastPath, this.filePath());
		this.reloadCameraSettlement = null;

		const host = this.view.dom;
		if (this.winRef.getComputedStyle(host).position === "static") {
			host.setCssStyles({ position: "relative" });
			this.hostPositionPatched = true;
		}
		// The lost 2026-08-20 build carried this class (reconstruction gap,
		// found via the census counter reading 0). No stylesheet references
		// it. Restoring it is render-inert and gives diagnostics a selector.
		//
		// The overlay lives INSIDE the scroller, positioned in content
		// coordinates, so the compositor scrolls ink and text together and no
		// main-thread lateness can separate them. See ScrollBand for why the
		// viewport-anchored version could not be made to keep up.
		const scroller = this.view.scrollDOM;
		if (this.winRef.getComputedStyle(scroller).position === "static") {
			scroller.setCssStyles({ position: "relative" });
			this.scrollPositionPatched = true;
		}
		// K1: the line numbers travel with the text for as long as the plugin holds the note, at 100% as zoomed
		// (InkOverlayViewportBox, writeGutterTravel); the unmount takes the class off, a note switch keeps it.
		this.writeGutterTravel(1);
		const container = scroller.createDiv({ cls: "handwriting-ink-overlay" });
		this.container = container;
		// Zero until syncBand writes the first box: an absolutely positioned
		// child extends scrollable overflow, and a full-height band placed
		// before the clamp is applied would inflate the scrollHeight that the
		// clamp then reads.
		container.setCssStyles({
			position: "absolute",
			left: "0",
			top: "0",
			width: "0",
			height: "0",
			overflow: "hidden",
			pointerEvents: "none",
			// As a child of `.cm-editor` this sat above the whole editor by
			// DOM order alone. Inside the scroller it is a sibling of the
			// content, and CodeMirror gives `.cm-gutters` z-index 200 - so
			// without this, ink drawn left of the text column would vanish
			// behind the fold gutter. Ink paints above the Markdown; that
			// rule is older than where this element happens to live.
			zIndex: "250",
		});

		// The canvases sit in an inner layer that fills the band. Between
		// v0.13.5 and the ScrollBand change the layer was the thing scroll
		// events translated, chasing the text from the main thread. It does
		// not move any anymore - the band it lives in is scrolled by the
		// compositor along with the text - so `will-change: transform` was
		// left behind pointing at a transform that no longer exists.
		//
		// Dropped, on the theory that folding five canvases into one promoted
		// layer is what keeps the wet canvas off the low-latency path it was
		// granted: ink is on the canvas ~1.5ms after the pen moves and ~30ms
		// before it is on screen, and that whole gap is compositing.
		//
		// If it costs scrolling smoothness, put it back - that is the trade
		// being tested, and the two are measured by different numbers
		// (age@present in the ink metrics against how the scroll feels).
		// The overscroll spring sets it for its own length only (startOverscrollBounce, cancelOverscrollBounce);
		// a contact cancels a spring first, so none lives during one and the pen path is untouched.
		const layer = container.createDiv({ cls: "handwriting-ink-layer" });
		this.inkLayer = layer;
		layer.setCssStyles({
			position: "absolute",
			inset: "0",
			pointerEvents: "none",
		});

		const canvas = (): HTMLCanvasElement => {
			const c = layer.createEl("canvas");
			c.setCssStyles({
				position: "absolute",
				inset: "0",
				pointerEvents: "none",
			});
			return c;
		};
		// Highlighter layers first: on the inline surface all ink paints above
		// the Markdown (the editor owns the DOM under it), so the stacking that
		// matters is highlight-under-PEN: a highlight never dims ink lines.
		// The v0.6.0 rule is unchanged where it counts: strokes are painted
		// OPAQUE and the whole layer carries one alpha, so a highlight crossing
		// itself stays a single flat wash instead of double-blending into seams.
		this.highlightCanvas = canvas();
		this.highlightWetCanvas = canvas();
		this.highlightCanvas.setCssStyles({ opacity: String(HIGHLIGHTER_ALPHA) });
		this.highlightWetCanvas.setCssStyles({ opacity: String(HIGHLIGHTER_ALPHA) });
		this.committedCanvas = canvas();
		this.wetCanvas = canvas();
		this.wetTileCanvas = canvas();
		this.tailCanvas = canvas();
		this.tailWashed = false;

		const ctx = this.committedCanvas.getContext("2d");
		const hctx = this.highlightCanvas.getContext("2d");
		if (!ctx || !hctx) {
			this.unmount();
			return;
		}
		this.committedCtx = ctx;
		this.highlightCtx = hctx;
		// Frozen pipeline: synchronized canvas (desynchronized: false), smoothed tail.
		this.wet = new WetInkRenderer(this.wetCanvas, INLINE_DESYNCHRONIZED);
		this.wet.smooth = true;
		this.wet.shape = true; // pen ink takes the shaped width law (InkShape)
		this.highlightWet = new WetInkRenderer(this.highlightWetCanvas, INLINE_DESYNCHRONIZED);
		this.highlightWet.smooth = true;
		// No backing for the highlight pair until the note needs it (see
		// highlightPairDeferred). A new canvas starts at 300x150.
		this.highlightPairDeferred = true;
		for (const c of [this.highlightCanvas, this.highlightWetCanvas]) {
			c.width = 0;
			c.height = 0;
		}
		this.highlightWet.noteBackingCleared();
		this.highlightBlank = true;
		// The wet canvas is sized by the resize path as ever; a scroll releases it (wetDeferred).
		this.wetDeferred = false;
		this.wetReleaseOff = (this.winRef as unknown as { HW_ARM_W_OFF?: unknown } | undefined)?.HW_ARM_W_OFF === true;
		this.activeWet = this.wet;
		// NOT desynchronized, and that is a hardware finding rather than an
		// oversight. The reasoning for giving the tip layer the low-latency
		// path is sound - it carries the stub that reaches the nib, while the
		// wet layer below it is by construction already behind the pen - and
		// it was tried on 2026-08-28. It produced SECONDS of lag: a second
		// desynchronized canvas in this stack does not present faster, it
		// queues, and at pen sample rates the queue never drains.
		//
		// The wet layer keeps the flag because it demonstrably works there.
		// One low-latency surface in the stack is apparently the budget.
		this.tail = new TailRenderer(this.tailCanvas);

		// The reticle belongs to the pointer's client frame, outside the editor's
		// pinch transform and scrolling raster band. Use this window's document.
		this.penCursorEl = container.ownerDocument.body.createDiv({ cls: "handwriting-pen-cursor" });
		this.penCursorEl.setCssStyles({ position: "fixed", left: "0", top: "0", zIndex: "10000", display: "block", opacity: "0" });
		this.penCursorPinned = true;
		this.penCursorEl.setAttribute("aria-hidden", "true");
		this.eraserEl = container.createDiv({ cls: "handwriting-eraser-cursor" });
		this.eraserEl.setAttribute("aria-hidden", "true");

		// Pen tools strip: on mobile the palette hides with the keyboard, so
		// the strip is the only path; on desktop it appears once a pen is
		// actually seen (PenToolsMode owns the rule). Mount-time check plus
		// re-checks from pen events, so a Surface picking up its pen mid-
		// session gets the strip without a remount.
		//
		// BULKHEADED (1.0.1): this call sits before the router is created,
		// so a throw here would kill the pen entirely while text kept
		// working - the exact iPad symptom reported on release day. Chrome
		// must never take the ink down with it.
		try {
			this.ensurePenTools();
		} catch (err) {
			console.error("[handwriting] pen tools strip failed to mount", err);
		}

		this.router = new InlinePenRouter(
			this.view.scrollDOM,
			container,
			{
				onPenDown: (s, ev) => this.penDown(s, ev),
				// Every contact (pen, finger or mouse) lands here first, a pen-down included: a preview paper riding a bounce comes down.
				// A give still easing back to the cap is NOT finished here - a two-finger contact takes the
				// zoom over from the scale on screen (pinch "start"), which is what keeps the page from jumping.
				// A CONTACT INSIDE A ZOOM LIFT'S FIRST MEASURE runs that measure first. The lift commit asks CodeMirror for a measure,
				// and the hold's first write there moves the scroll by what the line under the fingers moved in the rebuild; a pen
				// down before it retired the hold and the line kept its jump (4.27 note px at 32 percent). Only while a scale-changing
				// hold waits for its first write, at most once per contact; the router's rect is read again so the down maps after it.
				onViewportInput: () => { const lift = this.panAnchorHold; if (lift?.outcome === "pending" && lift.attempts === 0 && lift.toScale !== lift.fromScale) { (this.view as unknown as { measure(): void }).measure(); this.router?.refreshRect(); } if (!this.pinchPreview) this.endPreviewPaper("input"); this.cancelOverscrollBounce(); this.retirePanSettle("viewport input"); },
				onBeforePenDown: () => this.beforePenDown(),
				// The pointerType is PASSED ON. The interface has always
				// declared it (onPenHover(sample, pointerType?)) and the
				// router has always supplied it; this call site dropped it,
				// so the hover path could not tell a pen from a mouse and
				// marked a pen seen for both - `mouseActsAsPen` lets a plain
				// mouse move reach here whenever mouse ink is armed. That is
				// one of the two writers that made nibIsLit's flag a constant
				// for a mouse-only user (alan, 2026-09-02).
				onPenHover: (s, pt) => this.showPenCursor(s, pt),
				onPenLeave: () => this.hidePenCursor(),
				// A finger just landed with nothing else on the glass, so a
				// mouse's hover ring is the only thing that can be lit - and
				// it is not wanted while the hand writes (alan, 1.4.12: "hide
				// the mouse reticle when a finger or pen is active"). The
				// router asks only on that edge, so this cannot blink a pen's
				// ring; `InlinePenRouter.onHandOnGlass` carries the whole rule.
				//
				// `hidePenCursor` and not a narrower hide, deliberately: it is
				// the one teardown every abandon path already goes through,
				// and it takes `PEN_HOVER_CLASS`'s `cursor: none` off with the
				// ring, so the reader is left with the native cursor rather
				// than with no pointer at all.
				onHandOnGlass: () => this.hidePenCursor(),
				onPinch: (phase, ratio, centroid) => this.pinch(phase, ratio, centroid),
				// THE GIVE BELONGS TO INFINITE CANVAS (Alan: the bounce shows you cannot
				// go further, and the lack of it shows the direction is infinite). With the canvas
				// off the note scrolls like any other Obsidian note and answers zero, which also
				// switches off the router's edge re-arm - both predicates read this number.
				// With it on, the page's OWN top and left are real ends and give; the far ends are
				// room, and the ceiling-only clamps below are what keep the give off them.
				overscrollAllowancePx: () =>
					this.canvasMode ? OVERSCROLL_GIVE_PX * (this.viewportLayout?.externalScale ?? 1) : 0,
				onOverscrollPull: (x, y) => this.holdOverscrollGive(x, y),
				onOverscrollRelease: () => this.releaseOverscrollGive(),
				onPenRaw: (samples, ev) => this.penRaw(samples, ev),
				onPenMove: (_ev, count) => metrics.recordEvent("move", count, 0, false),
				// The lift event is PASSED ON - see `penUp`'s own header. The
				// pan branch reads the pointer's position off it to put the
				// reticle back where the hand actually is.
				onPenUp: (ev) => this.penUp(ev),
				onAllContactsLifted: () => this.resumeStrandedPan(),
				// Ordinary-note iPhone only. The predicate is read at contact,
				// after a toolbar command has explicitly picked the current nib.
				// PDF supplies no callback, so its touch behavior cannot widen.
				fingerInk: () =>
					fingerInkEligible({
						isIosApp: Platform.isIosApp,
						isPhone: Platform.isPhone,
						toolPicked: toolPickedHere(),
						penInkEnabled: penInkEnabled(),
						tipMode: tipMode(),
						tool: inlineTool,
					}),
				onFingerInkCancelled: () => this.cancelFingerInkForPinch(),
				// A two-finger gesture is only ours while the Infinite Canvas is on. With it off the
				// overlay already ignores every pinch phase, and this is what stops the router
				// claiming the contacts in the first place, so the host's own pinch is what the note gets.
				// PDF supplies no callback and keeps the router's existing behaviour.
				pinchZoom: () => this.canvasMode,
			// PEN OFF (PenInk.ts, design §5): the note surface is the only
			// one that answers this. Off means the router claims nothing, so
			// the pen is a native pointer here - taps place the caret and
			// raise the keyboard on a touch device, which is what two e-ink
			// users asked for. `PdfInkController` leaves this member
			// undefined, which reads as "never off", because there is no
			// keyboard use case on a pdf and taking the pen away there would
			// answer a request nobody made.
			penOff: () => !penInkEnabled() || this.scaleGeometryValid === false,
			claimBandContact: (ev) =>
				bandEraserIntent(
					ev.pointerType,
					ev.buttons,
					ev.button,
					tipMode() === "eraser",
					mouseInkEnabled()
				),
			// Trace-only (InlinePenRouter's window mirror calls this ONLY
			// while composing a trace line for a scroller-missing pen down -
			// see InlinePenCallbacks.describeChrome). The router holds no
			// reference to the strip by design, so this is the seam: ask
			// MobileTools for a snapshot of its own DOM, since only it has
			// the real element references to classify a hit against.
			describeChrome: (target) => this.mobileTools?.traceState(target) ?? "no strip mounted",
			// See `strokeAbandoned`. A named method rather than the body
			// inline: the surface registry's check for this wiring is a scan
			// of raw source text, which a comment satisfies, so the body needs
			// to be somewhere a test can call - and nothing in this repo can
			// construct an InkOverlayPlugin to reach a closure.
			onStrokeAbandoned: () => this.strokeAbandoned(),
			},
			() => this.cssScale,
			"none",
			// The pen's client point is in the frame the ink is painted in.
			// Subtract only the pan still carried by the layer's transform.
			// Settled pan is already represented by the raster camera.
			() => {
				this.rasterInputPan.x = this.inkInputPanX(); this.rasterInputPan.y = this.inkInputPanY();
				return this.rasterInputPan;
			}
		);

		this.router.setCanvasMomentumDisabled(this.canvasMode);
		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(host);
		this.contentResizeObserver = new ResizeObserver((entries) => this.onContentResize(entries?.at(-1)?.contentRect.width));
		this.contentResizeObserver.observe(this.view.contentDOM);
		// Created with no target: `syncCamera` arms it against whichever line
		// the origin scan picks, and `handleResize` below reaches `syncCamera`
		// on this very call. The body is a named method rather than a closure
		// like the one above it, because what it decides - repaint or not - is
		// the difference between a scroll costing one partial repaint and
		// costing a full re-raster of every visible stroke, and a decision
		// that load-bearing has to be reachable by a test that CALLS it rather
		// than by one that greps for it.
		this.originLineObserver = new ResizeObserver(() => this.originLineResized());
		this.handleResize();

		// Hit-probe context: what note-space point and granted extent this
		// overlay would assign to a client coordinate right now.
		setHitProbeContext((clientX, clientY) => {
			if (!this.container) return null;
			const rect = this.container.getBoundingClientRect();
			const w = this.camera.screenToWorld(
				visualToNote(clientX - rect.left - this.inkInputPanX(), this.cssScale),
				visualToNote(clientY - rect.top - this.inkInputPanY(), this.cssScale)
			);
			const path = this.filePath();
			const granted = path ? surfaceExtents.get(path) : ZERO_EXTENT;
			return {
				noteX: w.x,
				noteY: w.y,
				scrollLeft: this.view.scrollDOM.scrollLeft,
				scrollTop: this.view.scrollDOM.scrollTop,
				grantedX: granted.x,
				grantedY: granted.y,
				scale: this.scale,
			};
		}, this.view.dom);

		this.scrollFn = () => {
			this.clearSnapPreview();
			const during = this.router?.isStroking ?? false;
			if (during) this.scrollsDuringStroke++;
			this.releaseWetIfIdle();
			// Nothing here moves the ink any more. The layer is a child of
			// the scroller in content coordinates, so this scroll has already
			// moved it, on the compositor, together with the text. All that
			// is left is to notice when the viewport has eaten far enough
			// into the band's margin to need a wider one drawn - which
			// repaint() decides, through syncBand.
			const scroller = this.view.scrollDOM;
			const scrollLeft = scroller.scrollLeft;
			const scrollTop = scroller.scrollTop;
			// The preview paper is outside the scroller: a scroll while it is up moves the text, so it takes the scroll too.
			if (this.previewPaperEl && (scrollLeft !== this.paperScrollLeft || scrollTop !== this.paperScrollTop)) {
				this.paperScrollLeft = scrollLeft; this.paperScrollTop = scrollTop; this.writePaperPan();
			}
			// The overlay is inside the scroller now, so its client rect moves
			// with every scroll - and the router caches that rect to map
			// pointer coordinates. It used to be safe to cache across scrolls
			// because the overlay did not move; it is not any more. Stale by a
			// scroll delta shows up as the hover reticle sitting away from the
			// pen tip, and as lasso and insert-space landing where the ink was
			// a moment ago.
			//
			// A stroke in flight keeps the rect it froze at pen-down. That is
			// the same coordinate frame the camera froze with, and refreshing
			// one without the other is exactly the forward/inverse mismatch
			// the frozen pipeline exists to prevent.
			// Only producer readbacks may compensate a settle. An unmatched
			// scroll belongs to navigation, including programmatic scrolling.
			const hold = this.panAnchorHold;
			if (hold && (scrollLeft !== hold.left || scrollTop !== hold.top)) this.retirePanSettle("a scroll off the settle target");
			// A scroll the overlay did not write moves the page by whole px, so the residual still holds the offset's
			// fraction and stays. Except at either end of an axis: there the residual would hold the page past its edge.
			const residual = this.scrollResidual;
			if (residual && (residual.x !== 0 || residual.y !== 0) && (scrollLeft !== residual.left || scrollTop !== residual.top)) {
				const atEnd = (v: number, max: number) => v <= 0 || v >= max;
				this.setScrollResidual(atEnd(scrollLeft, scroller.scrollWidth - scroller.clientWidth) ? 0 : residual.x,
					atEnd(scrollTop, scroller.scrollHeight - scroller.clientHeight) ? 0 : residual.y, scrollLeft, scrollTop);
			}
			if (!during) this.router?.refreshRect();
			if (diagnosticsEnabled()) {
				scrollProbeScroll(scrollLeft, scrollTop, during);
			}
			// A live pinch writes the scroll itself, every frame, and any
			// camera motion makes repaint() re-raster every visible stroke.
			// Zooming OUT grows the visible set, so the gesture stuttered in
			// exactly one direction. Mid-pinch the repaint buys nothing: the
			// canvases sit inside the transformed host, so the raster the
			// note already has scales with it, and the settle re-rasters
			// crisply once.
			//
			// A TIME WINDOW, not a flag. The first cut was a boolean cleared
			// on pinch-end, and a pinch that never delivered its end left it
			// stuck - suppressing every repaint for the rest of the session,
			// so the camera went stale and the reticle drew far from the pen
			// (alan, 1.3.1, hardware). This cannot wedge: it expires on its
			// own a few frames after the last pinch-driven scroll, whatever
			// happens to the gesture.
			if (performance.now() - this.pinchScrollAt < PINCH_SCROLL_QUIET_MS) return;
			const path = this.filePath();
			if (path) this.scrollExpansion?.sample(path, this.canvasMode, scrollLeft, scrollTop);
			if (path && surfaceExtents.owesShrinkX(path)) this.shrinkWhenScrollIsQuiet();
			this.scheduleRepaint("scroll");
		};
		this.view.scrollDOM.addEventListener("scroll", this.scrollFn, { passive: true });
		// Log-only wheel tap on the ACTUAL trigger path of the touchpad dead
		// zone: two-finger precision-touchpad scrolling arrives here, not as
		// touch pointers. Passive + capture: sees everything, changes nothing.
		// Wholly diagnostic, so the whole body is behind the switch (RC4).
		this.wheelFn = (e: WheelEvent) => {
			if (!this.pinchPreview) this.endPreviewPaper("input");
			// Alan: "a scroll should perform the elastic bounce/settle". A WHEEL OR TOUCHPAD
			// SCROLL NO LONGER KILLS AN EASE THAT IS ALREADY PLAYING. This called cancelOverscrollBounce(),
			// which puts the offset on 0 in ONE frame. Measured mid-ease with 153.8 px still owed, the frame
			// series after a wheel was [153.8, 0, 0, ...]: the whole correction closed as a single step, so the
			// page arrived by a jump and the ease the contract promises stopped happening. With the call gone
			// the same drive reads [0, 32.4, 14.4, 13.1, 12.1, 20.9, 9, 8.1, ...] decaying to zero.
			// The ease is a transform on the page and a wheel moves the scroller: they do not contend.
			// PEN DOWN STILL CANCELS: that path is onViewportInput (:2225), untouched, pinned by
			// OverscrollBounce.test.ts "PEN DOWN MID-BOUNCE" - a contact must be read against the page where it
			// rests, which is not the same question as a scroll passing over a playing ease.
			// NOTHING IS OWED AT THE END OF A SCROLL RUN ITSELF: scrollFn (:2359) never writes viewportPan and
			// the native scroller clamps scrollLeft/scrollTop at zero, so no wheel, touchpad or one-finger touch
			// scroll can leave the canvas's left or top edge inside the pane (read on the device, 1.4.20).
			this.retirePanSettle("wheel");
			if (!diagnosticsEnabled()) return;
			scrollProbeWheel(
				e,
				this.view.scrollDOM.scrollLeft,
				this.view.scrollDOM.scrollTop,
				this.router?.isStroking ?? false
			);
		};
		this.view.scrollDOM.addEventListener("wheel", this.wheelFn, {
			capture: true,
			passive: true,
		});
		// THE SECOND WHEEL LISTENER, AND THE ONLY NON-PASSIVE ONE. The
		// diagnostic tap above cannot take this job: it is registered passive,
		// so it may not `preventDefault`, and Obsidian's quick font size is
		// exactly what has to be prevented. Registered after it so the probe
		// still records every wheel event, including the ones zoomed here.
		this.ctrlWheelFn = (e: WheelEvent) => this.wheelZoom(e);
		this.view.scrollDOM.addEventListener("wheel", this.ctrlWheelFn, {
			capture: true,
			passive: false,
		});
		this.watchResolution();
		// Every committed mutation that reaches an event drops the cached
		// frontier for that note; the two that do not (erase, lasso move)
		// invalidate by hand at their gesture end. §5g/G1.
		// ...and the empty-page refusal it has already made about that note is
		// spent: ink arriving (or the last of it leaving) is exactly the event
		// that makes the sentence worth saying again. Same subscription, so
		// the two cannot drift apart over which notes they heard about.
		// This note's own canvas answer, and a re-apply whenever its frontmatter choice moves.
		this.canvasMode = canvasForNote(this.filePath(), scrollExpansionEnabled);
		this.router?.setCanvasMomentumDisabled(this.canvasMode);
		this.offCanvasOverride = onCanvasOverrideChanged((p) => { if (p === this.filePath()) this.applyCanvasMode(); });
		this.offInkChanged = onInkChanged((p) => {
			this.frontierCache.invalidate(p);
			// ...but ONLY when ink ARRIVED. The sentence above said "or the
			// last of it leaving", and that half was wrong on a user's screen:
			// an eraser scrub re-lands the nib every few hundred ms, each
			// re-land a fresh pointerdown, so erasing the last stroke re-armed
			// this gate and the very next landing of the SAME scrub announced
			// that there was no ink to erase - to the person who had just
			// erased it (alan, 1.4.12: "flip to erase end worked but it also
			// gave me the toast for no ink to erase"). Emptying a page is the
			// one ink change that must NOT make the sentence worth saying
			// again: the user knows, they did it. Ink arriving still re-arms,
			// which is the case the gate exists for - a note that gains ink and
			// later loses it elsewhere should speak again.
			if (inkChangeRearmsNotice(inlineInk.inkPresence(p))) this.emptyNotice.forget(p);
			this.pruneSelectionOnInkChange(p);
		});
		this.lastPath = this.filePath();
		this.lastFile = this.currentFile();
		this.armNoteCameraRestore(this.lastPath);
		this.updateHandwritingPageClass();
		this.loadInk(this.lastPath);
		// The layout the line anchors are taken and honoured under, read in the first measure.
		this.requestLineSignature();
	}

	/** Persisted ink arrives lazily; an untouched note costs one cache lookup. */
	function loadInk(this: InkOverlayPlugin, path: string | null): void {
		if (!path) return;
		// The read starts first: its synchronous part makes the note's record,
		// so the font size the adoption below latches when nothing is stored
		// yet reaches the store (setFontRefPx). Ink drawn before the read lands
		// is in that frame, and the store moves it into the stored one when
		// the file arrives.
		const loaded = inlineInk.ensureLoaded(path);
		this.adoptStoredFontRef(path);
		runDetached(
			loaded.then((changed) => {
				// A read that finishes after unmount must not revive the page-class
				// observer on a torn-down editor (audit 110).
				if (this.filePath() === path && !this.retiring && this.container) {
					this.adoptStoredFontRef(path);
					// A restore the measure could not commit gets one more try, with the font reference and ink in.
					this.restoreNoteCamera(path);
					this.mobileTools?.refresh();
					this.noteZoomControls?.refresh();
					this.updateHandwritingPageClass();
					if (changed) this.scheduleRepaint();
					this.lineAnchorInkLoaded(path);
				}
			}),
			`load inline ink for ${path}`
		);
	}

	/**
	 * Read the open note's ink in the frame of the font size stored with it
	 * (audit 46). Every stored coordinate is expressed against a reference
	 * size, and the reference used to be whatever the editor measured first,
	 * so a note reopened at another size, or opened second in the same
	 * editor, read its ink in the wrong frame. Runs when a note opens (mount
	 * and note switch both come through loadInk) and again once its sidecar
	 * has loaded, since the stored value often arrives after the first
	 * measurement. A stored reference that differs from the latch replaces
	 * it and the scale is re-measured. With none stored the latch is cleared,
	 * never carried over from the note open before: the re-measure latches
	 * this note's own size, and the store takes it once to ride its next save.
	 */
	function adoptStoredFontRef(this: InkOverlayPlugin, path: string): void {
		const stored = inlineInk.fontRefPx(path);
		if (stored !== null && stored === this.refFontPx) return;
		// A contact owns its coordinate frame (see `frame`): the stroke in
		// flight is in the old one. Held to the lift, where the finished
		// strokes are moved into the new frame before they are stored or
		// painted (`releaseHeldFontRef`).
		if (this.frame.locked) {
			this.heldFontRef = path;
			return;
		}
		this.refFontPx = stored ?? 0;
		// syncCamera recomputes fontZoom only on a font change it has not seen.
		this.lastSyncFontStr = "";
		if (this.container) this.handleResize();
	}

	/**
	 * Run an adoption held while a contact owned the frame, now that it is
	 * over. Returns the factor that takes ink drawn in the frame before into
	 * the frame after (1 when nothing was held or nothing changed).
	 */
	function releaseHeldFontRef(this: InkOverlayPlugin): number {
		const path = this.heldFontRef;
		this.heldFontRef = null;
		// `!path`, not `=== null`: a unit rig built with Object.create never runs the initialiser.
		// An overlay on its way out (unmount) drops the hold and re-measures nothing.
		if (!path || this.retiring || path !== this.filePath()) return 1;
		const before = this.refFontPx;
		this.adoptStoredFontRef(path);
		const after = this.refFontPx;
		return before > 0 && after > 0 ? after / before : 1;
	}

	/**
	 * Presentation only: mark the editor chrome of a note that IS a Handwriting
	 * page (`handwriting-page` on the markdown view, for scoped CSS hooks like the
	 * backlinks divider), and mark the scroller once Handwriting has actually made
	 * it horizontally scrollable (`handwriting-hscroll`, for the visible horizontal
	 * scrollbar). Reads session state and cheap metadata; never mutates the
	 * note.
	 */
	function updateHandwritingPageClass(this: InkOverlayPlugin): void {
		if (!this.pageClassHost) {
			this.pageClassHost =
				this.view.dom.closest(".markdown-source-view") ?? this.view.dom;
			if (typeof MutationObserver !== "undefined") {
				this.metadataObserver = new MutationObserver((records) => {
					// This root is the whole editor, and CodeMirror recycles
					// line DOM, so most batches arriving here cannot have
					// changed a Properties block: gate first, then coalesce
					// the survivors into ONE frame's work. §5g/G2.
					if (!records.some(isMetadataMutation)) return;
					if (this.metadataFrame !== null) return;
					this.metadataFrame = this.winRef.requestAnimationFrame(() => {
						this.metadataFrame = null;
						if (this.pageClassHost)
							updateMetadataVisibility(this.pageClassHost, this.headFrontmatterKeys);
					});
				});
				// The Properties container moves to the reading view beside this
				// editor; keep observing both without moving the page class.
				this.metadataObserver.observe(this.pageClassHost.closest(".view-content") ?? this.pageClassHost, {
					childList: true,
					subtree: true,
					attributes: true,
					attributeFilter: ["data-property-key"],
				});
			}
		}
		const path = this.filePath();
		this.pageClassHost.classList.toggle(
			"handwriting-page",
			!!path && inlineInk.isHandwritingPage(path)
		);
		updateMetadataVisibility(this.pageClassHost, this.headFrontmatterKeys);
	}

	/**
	 * Create or destroy the strip to match the visibility rule. Called at
	 * mount, from pen sightings, and by the mode command via
	 * refreshPenToolsAll. Cheap when nothing changes.
	 */
	function ensurePenTools(this: InkOverlayPlugin): void {
		try {
			this.ensurePenToolsInner();
		} catch (err) {
			console.error("[handwriting] pen tools strip failed", err);
		}
	}

	/** One eligibility-scoped entry shared by commands and this note's strip. */
	function prepareFingerInk(this: InkOverlayPlugin): void {
		if (
			!fingerInkEligible({
				isIosApp: Platform.isIosApp,
				isPhone: Platform.isPhone,
				toolPicked: toolPickedHere(),
				penInkEnabled: penInkEnabled(),
				tipMode: tipMode(),
				tool: inlineTool,
			})
		) return;
		this.router?.prepareFingerInk();
	}

	function ensurePenToolsInner(this: InkOverlayPlugin): void {
		// Note zoom belongs to the editor, even when the pen strip is hidden.
		this.noteZoomControls = ensureNoteZoomControls(this.noteZoomControls, this.container, () => this.chromeHost(), {
				noteViewport: {
					getNoteViewportState: () => this.getNoteViewportState(),
					zoomNoteBy: factor => this.zoomNoteBy(factor),
					resetNoteZoom: () => this.resetNoteZoom(),
					fitHandwriting: () => this.fitHandwriting(),
				},
				notePath: () => this.filePath(),
		});
		const want =
			this.container !== null &&
			penToolsVisible(getPenToolsMode(), Platform.isMobileApp, penSeenThisSession());
		// A strip whose BUILD-TIME answers have moved is rebuilt, not left
		// standing. `ButtonSpec.shownOn` is read once per strip, and one of
		// the facts it reads has an edge - the first real pen contact latches
		// `penHardwareEverSeen`, which is what gives the device a Keyboard
		// button. (Since 1.4.12 that latch is also restored at load, before
		// any strip is built, from THIS DEVICE's local store under
		// `handwriting-device-pen-hardware-seen` - not from settings: an old
		// `data.json` key is deliberately ignored, because that file syncs
		// and a pen on one machine is not a pen on this one. So a device
		// that has already held a pen never reaches this edge at all.) On
		// mobile the strip already
		// exists by then (`penToolsVisible` is unconditionally true there), so
		// the create-or-destroy test below would answer "no change" and the
		// button would never appear. Dropping the strip here puts it through
		// the build path on the next line, which is the only path that reads
		// `shownOn` at all. At most once per session per strip: the latch
		// cannot go back down and a device does not grow a digitizer.
		if (want && this.mobileTools?.stale()) {
			this.mobileTools.destroy();
			this.mobileTools = null;
		}
		if (want === (this.mobileTools !== null)) return;
		if (!want) {
			this.mobileTools?.destroy();
			this.mobileTools = null;
			return;
		}
		const info = this.view.state.field(editorInfoField, false);
		const app = info?.app as
			| { commands?: { executeCommandById(id: string): void } }
			| undefined;
		if (!app?.commands) return;
		const commands = app.commands;
		this.mobileTools = new MobileTools(this.chromeHost(), {
			exec: (id) => {
				{
					// "editor:undo" and "editor:redo" are NOT Obsidian
					// commands - undo/redo are native keybindings - so
					// executeCommandById returned false and did nothing,
					// silently, on every build that ever shipped. Nobody
					// noticed because everyone presses Ctrl+Z; the tracker's
					// first real issue was the first person who tapped the
					// button before the keys (issue #1, fixed on the release
					// line as 7b5aa20, ported here). Dispatched straight into
					// this view's own history, which also makes the button
					// definitionally equal to Ctrl+Z.
					if (id === "editor:undo") undo(this.view);
					else if (id === "editor:redo") redo(this.view);
					// The trash acts on THIS overlay, never on whichever editor
					// `overlayForPath` would pick. That lookup answers the FIRST
					// mounted editor showing the note, so with two editors open
					// on the same file and this one active, routing the button
					// through the registered command (which resolves the
					// surface via `overlayForPath`) deleted - or refused to find
					// - the OTHER editor's selection instead of this strip's
					// own. The pdf strip's `stripExec` faced the identical
					// thing first (PdfInkController.ts) and answers it the same
					// way: the button knows its own overlay and asks it
					// directly. Same notice the registered command shows, off
					// the same `lassoDeleteNotice`, so the two paths can never
					// drift into two sentences for one outcome.
					else if (id === "handwriting:delete-selected-ink") {
						const said = lassoDeleteNotice(this.deleteSelectedInk());
						if (said) new Notice(said);
					}
					// Copy and cut for the same reason and by the same route. Cut is
					// the one that mattered most: routed through the command it
					// DELETED from whichever editor `overlayForPath` answered first,
					// which is not the one the button is sitting in. Both take their
					// sentence from the same helper the registered command uses, so
					// no wording is written twice.
					else if (id === "handwriting:copy-selected-ink") {
						// The copy runs either way; only the success sentence is routine.
						const copied = this.copySelectedInk();
						if (routineNoticesVisible() || !copySelectionNoticeIsRoutine(copied))
							new Notice(copySelectionNotice(copied));
					}
					else if (id === "handwriting:cut-selected-ink") {
						const outcome = this.cutSelectedInk();
						if (routineNoticesVisible() || !cutSelectionNoticeIsRoutine(outcome))
							new Notice(cutSelectionNotice(outcome));
					}
					// The eraser, lasso, insert-space and pan buttons run
					// commands that "Extra commands for hotkeys" keeps out of
					// the palette while it is off - executeCommandById would
					// find nothing and the buttons would be dead on a default
					// install. `runGatedCommand` holds exactly the actions
					// that were not registered, so it answers true only for
					// them (CommandPaletteSplit.ts).
					else if (!runGatedCommand(id)) commands.executeCommandById(id);
				}
			},
			activeTool: () => getInlineTool(),
			// The strip was dragged to an anchor: the same road the settings
			// dropdown takes, so the placement moves everywhere AND survives
			// a restart. The pdf host wires the identical call.
			setPlacement: (corner) => applyToolbarPlacement(corner),
			eraserOn: () => getInlineEraserMode(),
			eraserWholeStroke: () => getEraserWholeStrokes(),
			setEraserWholeStroke: (on) => {
				setEraserWholeStrokes(on);
				persistEraserMode?.(on);
			},
			lassoOn: () => getInlineLassoMode(),
			spaceOn: () => getInlineSpaceMode(),
			panOn: () => getInlinePanMode(),
			toolColor: (tool) => getInkColorHex(tool as InkTool),
			eraserRadiusPx: () => getEraserRadiusPx(),
			setEraserRadiusPx: (px, commit) => {
				setEraserRadiusPx(px);
				if (commit) commitEraserRadius();
			},
			canUndo: () => undoDepth(this.view.state) > 0,
			canRedo: () => redoDepth(this.view.state) > 0,
			canPasteInk: () => clipboardSize() > 0,
			recordingOn: () => diagnosticsEnabled(),
			hasInkSelection: () => !this.selection.isEmpty,
			mouseInkOn: () => mouseInkEnabled(),
			armMouseInkQuietly: () => armMouseInkQuietlyEverywhere(),
			disarmMouseInkQuietly: () => releaseMouseInkQuietlyEverywhere(),
			toast: (message) => {
				new Notice(message);
			},
			paletteFor: (tool) => colorsFor(tool as InkTool),
			pickColor: (name, hex) => pickStripColor(name, hex),
			// Quick pens: the list, and the three actions main registered.
			// Same wiring on the pdf strip, so a preset starred on a note is
			// the same preset on a pdf.
			presetsFor: (tool) => inkPresetsFor(tool as InkTool),
			applyPreset: (tool, index) => applyInkPreset(tool as InkTool, index),
			starPreset: (tool) => starInkPreset(tool as InkTool),
			forgetPreset: (tool, index) => forgetInkPreset(tool as InkTool, index),
			inkSizeMult: (tool) => getInkSizeMult(tool as InkTool),
			setInkSizeMult: (tool, mult, commit) => {
				setInkSizeMult(tool as InkTool, mult);
				if (commit) persistInkSize?.(tool as InkTool, getInkSizeMult(tool as InkTool));
			},
			// The pen-off button's other half: focus this editor inside the
			// button's own click so the software keyboard rises, blur it when
			// the pen comes back. `setKeyboardFocus` (InlineFocus.ts) rather
			// than a `.focus()` here - the note's focus rules live in that
			// module and StripPenChrome.test.ts's sweep is what keeps them
			// there.
			setEditorFocus: (focused) => setKeyboardFocus(this.view, focused),
			// This router gates on the flag (`penOff` above), so the flag is
			// the honest answer to "does the pen ink here" - the pdf host
			// answers the same read for the same reason (MobileTools.ts's
			// `penInksHere`, design §5).
			penInksHere: () => penInkEnabled(),
			// Capability, not current mode: Keyboard remains reachable after it
			// turns pen input off. PDF deliberately supplies no such capability.
			fingerInkAvailable: () => Platform.isIosApp && Platform.isPhone,
			// Close any native-scroll window while the toolbar contact is still
			// between gestures. Doing this at the next note pointerdown is too late:
			// WebKit has already snapshotted touch-action for that contact.
			prepareFingerInk: () => this.prepareFingerInk(),
			// The DEVICE's digitizer, not this pane's anything - the rule and
			// its reasoning live in DeviceInput.ts, and both surfaces read the
			// one implementation so a phone cannot get a different answer on a
			// note than it gets on a pdf.
			hasTouch: () => deviceHasTouch(),
		});
		// A strip born mid-session starts in the configured corner, not the
		// default one: ensurePenTools creates it on the first pen contact,
		// long after settings were read.
		this.applyToolbarCorner();
	}

	/** Drop the six ink canvases and the extent raster to 0x0, releasing their backing memory now. */
	function releaseBackings(this: InkOverlayPlugin): void {
		this.dropStandIn();
		// The extent raster and a build in progress are whole-note copies of the ink, as big as the layers; the next whole repaint
		// after a re-show paints by path, and builds again only where extentBuildAllowed() holds.
		this.dropExtentBuild();
		const ext = this.extentRaster;
		this.extentRaster = null;
		for (const c of [
			ext?.pen,
			ext?.hl,
			this.committedCanvas,
			this.wetCanvas,
			this.wetTileCanvas,
			this.tailCanvas,
			this.highlightCanvas,
			this.highlightWetCanvas,
		]) {
			if (!c) continue;
			c.width = 0;
			c.height = 0;
		}
	}

	function unmount(this: InkOverlayPlugin): void {
		// Before anything below moves the camera: the zoom and scroll the note leaves with come back when it reopens.
		this.saveNoteCamera();
		this.noteCameraRestore = null;
		this.retiring = true;
		this.endPreviewPaper("unmount");
		this.cancelOverscrollBounce();
		this.retirePanSettle("unmount");
		this.invalidateReloadBindings(this.lastPath, this.filePath());
		this.reloadCameraSettlement = null;
		if (diagnosticsEnabled() && this.undoIdentity) discardUndoTrace(this.undoIdentity);
		// An ink or highlighter stroke in flight when the view goes (a pane or pop-out closed
		// mid-stroke) is committed, as a window blur commits it. Only while a stroke builder
		// exists: an insert space, an erase or a selection drag cut off by the close is rolled
		// back by resetGestureState below, as a file switch rolls it back.
		if (this.builder) this.router?.finishActiveStroke();
		this.router?.dispose();
		this.router = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.contentResizeObserver?.disconnect();
		this.contentResizeObserver = null;
		this.originLineObserver?.disconnect();
		this.originLineObserver = null;
		this.originLine = null;
		if (this.scrollFn) {
			this.view.scrollDOM.removeEventListener("scroll", this.scrollFn);
			this.scrollFn = null;
		}
		if (this.shrinkIdleTimer !== null) {
			this.winRef.clearTimeout(this.shrinkIdleTimer);
			this.shrinkIdleTimer = null;
		}
		if (this.lineAnchorPassTimer > 0) {
			this.winRef.clearTimeout(this.lineAnchorPassTimer);
			this.lineAnchorPassTimer = 0;
		}
		this.lineAnchorPassWaits = false;
		// Edits made while unmounted never reach the anchors: what they logged is applied, and no height on record is trusted.
		this.lineAnchorState?.detached();
		if (this.wheelFn) {
			this.view.scrollDOM.removeEventListener("wheel", this.wheelFn, { capture: true });
			this.wheelFn = null;
		}
		if (this.ctrlWheelFn) {
			this.view.scrollDOM.removeEventListener("wheel", this.ctrlWheelFn, { capture: true });
			this.ctrlWheelFn = null;
		}
		if (this.wheelZoomTimer !== 0) {
			this.winRef.clearTimeout(this.wheelZoomTimer);
			this.wheelZoomTimer = 0;
		}
		this.dropExtentBuild();
		this.dropStandIn();
		// No end step on the way out: the overlay is going, and `pinch` refuses
		// once `retiring` is set anyway.
		this.wheelZoomRun.cancel();
		this.unwatchResolution();
		this.offInkChanged?.();
		this.offInkChanged = null;
		this.offCanvasOverride?.();
		this.offCanvasOverride = null;
		this.lastExtentInputs = null;
		this.cameraOriginY = null;
		setHitProbeContext(null, this.view.dom);
		this.spacer?.remove();
		this.spacer = null;
		this.spacerLeft = Number.NaN;
		this.spacerTop = Number.NaN;
		this.dropLeftReserve();
		this.removeGridPaperBox();
		this.stopPaperKindWatch();
		this.view.scrollDOM.classList.remove("handwriting-hscroll");
		this.metadataObserver?.disconnect();
		this.metadataObserver = null;
		if (this.metadataFrame !== null) {
			this.winRef.cancelAnimationFrame(this.metadataFrame);
			this.metadataFrame = null;
		}
		if (this.pageClassHost) clearMetadataVisibility(this.pageClassHost);
		this.pageClassHost?.classList.remove("handwriting-page");
		this.pageClassHost = null;
		this.restoreScrollableAxis();
		this.axisChecked = false;
		this.lastReach = null;
		if (this.scrollPositionPatched) {
			this.view.scrollDOM.setCssStyles({ position: "" });
			this.scrollPositionPatched = false;
		}
		this.clearHoverWatchdog();
		// A stroke interrupted by teardown never reaches pen-up, so the
		// ticker rAF would keep rescheduling itself against a dead overlay.
		this.stopFrameTicker();
		this.restorePinchLayers();
		// Zero the backings before the container goes. Detached canvases hold
		// their full-size memory until collection, and a same-tab note switch
		// rebuilds the overlay, so a quick run of switches on an iPad stacked
		// five full-size backings per note behind the collector.
		if (this.container) this.releaseBackings();
		this.container?.remove();
		this.container = null;
		this.inkLayer = null;
		this.band = null;
		// A give easing past teardown would drive pinch frames against a dead overlay.
		if (this.pinchGive) { if (this.pinchGive.raf !== 0) this.winRef.cancelAnimationFrame(this.pinchGive.raf); this.pinchGive = null; }
		// A pinch frame outliving the overlay would touch a torn-down editor.
		if (this.pinchRaf !== 0) {
			this.winRef.cancelAnimationFrame(this.pinchRaf);
			this.pinchRaf = 0;
		}
		if (this.resizeOutOfUpdateRaf) { this.winRef.cancelAnimationFrame(this.resizeOutOfUpdateRaf); this.resizeOutOfUpdateRaf = 0; }
		// A preview torn down mid-gesture gives CodeMirror its measuring back;
		// the make-up measure waits a frame, since this can run inside
		// CodeMirror's own update.
		this.releaseMeasures(true);
		// OUTSIDE that guard: a teardown can find a deferred-repaint timer
		// armed with no pinch rAF in flight, and the timer would then be
		// left running. Inert today - the callback bails on a missing
		// container - but the contract is that the latch and the timer are
		// cleared together, and relying on a bail in the other file is how
		// that contract quietly stops holding.
		this.clearDeferredRepaint();
		// Same shape, and pre-existing: the insert-space feedback frame was
		// only ever cancelled by clearSpaceFeedback, never at teardown, so a
		// detach mid-hover left it queued against a dead overlay
		// (release-1.4.19, ec802917).
		if (this.spaceFeedbackRaf != null) {
			this.winRef.cancelAnimationFrame(this.spaceFeedbackRaf);
			this.spaceFeedbackRaf = null;
		}
		this.pinchPending = null;
		// Hand the editor back the way it was found. The transform, the
		// counter-sized box and the origin all live on view.dom, which
		// OUTLIVES this overlay: unmounting while zoomed used to leave the
		// editor painted at scale in a fraction-width box, with the only
		// code that could undo it now unloaded.
		this.restoreViewportLayout();
		// The line-number travel class is on view.dom too, written at mount; it comes off here and only here, so a note
		// switch in the same editor keeps the numbers with the text.
		this.writeGutterTravel(1,true);
		// The camera anchor lives in the editor's own DOM, beside the content,
		// and the editor OUTLIVES this overlay: a plugin disable or reload
		// would otherwise leave the wrapper and its rungs in the note, and the
		// next load would add another beside it.
		unmountDocumentAnchor(this.view);
		this.pinchScaleNow = 1;
		this.zoomFloor = MIN_PINCH_SCALE;
		this.pinchRasterScale = 1;
		this.rasterColumnLocal = null;
		this.previewAnchorStale = false;
		this.pinchRefScale = null;
		this.pinchAnchor = null;
		this.pinchScrollAt = 0;
		this.builder = null;
		if (this.penCursorPinned) this.penCursorEl?.remove();
		this.penCursorEl = null;
		this.penCursorPinned = false;
		this.penCursorShown = false;
		this.penCursorClient = null;
		this.eraserEl = null;
		this.mobileTools?.destroy();
		this.mobileTools = null;
		this.noteZoomControls = destroyNoteZoomControls(this.noteZoomControls);
		this.resetGestureState();
		// A remount puts a genuinely fresh screen in front of the reader, so
		// the refusal is allowed to speak once more on it.
		this.emptyNotice.forgetAll();
		if (this.hostPositionPatched) {
			this.view.dom.setCssStyles({ position: "" });
			this.hostPositionPatched = false;
		}
		if (this.chromeHostPatched) {
			this.chromeHostPatched.setCssStyles({ position: "" });
			this.chromeHostPatched = null;
		}
	}

	function destroy(this: InkOverlayPlugin): void {
		if (!instances.delete(this)) return;
		this.destroyed = true;
		this.releasePenHold();
		this.unmount();
	}

	/**
	 * Keep the zoom and scroll of the note leaving this editor (issue 9: Back reloads a note, or leaves it and comes
	 * back, and it must return where it was). Skipped where the reading would not be the note at rest: nothing mounted,
	 * a live pinch preview, invalid scale geometry, or a hidden pane, whose scroller reads 0 and would overwrite the
	 * camera the note really has.
	 */
	function saveNoteCamera(this: InkOverlayPlugin): void {
		const path = this.lastPath;
		if (!path || !this.container || this.pinchPreview || this.scaleGeometryValid === false) return;
		const scroller = this.view.scrollDOM;
		if (scroller.clientHeight === 0) return;
		noteCameras.save(path, { zoom: this.pinchScaleNow, left: scroller.scrollLeft, top: scroller.scrollTop });
	}

	/**
	 * A note opening in this editor: if it has a remembered camera, restore it in CodeMirror's next measure. Mount and
	 * the note switch run inside CodeMirror's update, where a commit may not run; the measure runs after the update and
	 * before that frame is painted, so no frame shows the note at the default camera first. A remembered note was read
	 * this session, so its ink and font reference are in the store already.
	 */
	function armNoteCameraRestore(this: InkOverlayPlugin, path: string | null): void {
		this.noteCameraRestore = path !== null && noteCameras.get(path) !== null ? path : null;
		if (this.noteCameraRestore === null) return;
		const armed = this.noteCameraRestore;
		this.view.requestMeasure({ key: this.noteCameraMeasure, read: () => null, write: () => this.restoreNoteCamera(armed) });
	}

	/**
	 * Put a reopened note back at its remembered zoom and scroll, through the camera commit the pinch settle and Fit
	 * use, so the box, extent, band and paper are written as one settled camera. Only onto the note as it opened: a
	 * reader who has already zoomed or scrolled it wins. bypassFloor carries a remembered zoom back exactly as it was
	 * saved, which can be one Fit reached below the manual floor; nothing else passes the floor this way. A commit the
	 * camera refuses (geometry not valid yet) stays armed, and the ink read's continuation tries once more. Never on
	 * the pen path.
	 */
	function restoreNoteCamera(this: InkOverlayPlugin, path: string): void {
		if (this.noteCameraRestore !== path || this.filePath() !== path || !this.container || this.retiring) return;
		const camera = noteCameras.get(path);
		const scroller = this.view.scrollDOM;
		if (!camera || this.pinchScaleNow !== 1 || scroller.scrollLeft !== 0 || scroller.scrollTop !== 0) {
			this.noteCameraRestore = null;
			return;
		}
		if (this.commitCameraScale(camera.zoom, { left: camera.left, top: camera.top }, undefined, false, true, true)) this.noteCameraRestore = null;
	}

export function installLifecycle(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		mount,
		loadInk,
		adoptStoredFontRef,
		releaseHeldFontRef,
		updateHandwritingPageClass,
		ensurePenTools,
		prepareFingerInk,
		ensurePenToolsInner,
		releaseBackings,
		unmount,
		destroy,
		saveNoteCamera,
		armNoteCameraRestore,
		restoreNoteCamera,
	});
}
