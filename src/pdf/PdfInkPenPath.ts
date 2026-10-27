/**
 * The pen path of the PDF ink controller (pen down, raw samples, predicted tail, wet draw, erase), moved from PdfInkController.ts. Each is a method of PdfInkController, installed on its prototype when PdfInkController.ts loads.
 * Bodies moved unchanged. Frame path: the call lines in PdfInkController.ts and the prototype lookup are unchanged.
 */
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { CameraState } from "../camera/coordinates";
import { InkPoint, InkStroke } from "../ink/Stroke";
import { markPenHardwareSeen, markPenSeen } from "../inline/PenToolsMode";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { adaptiveCaps, buildTail, correctionError, EINK_CAPS } from "../ink/Prediction";
import { presentLagMs, recordPresentAge } from "../ink/LatencyEstimate";
import { predictionEinkOn, predictionEnabled } from "../inline/StrokePrediction";
import { rowsOf, snapLine, strokeIdsBelow } from "../inline/InsertSpace";
import { DEFAULT_PEN, HIGHLIGHTER_PEN } from "../ink/PenStyle";
import { getInkColorHex } from "../ink/InkColor";
import { getInkSizeMult, getInlineTool } from "../inline/InkOverlay";
import { PenSample } from "../input/PointerRouter";
import { newStrokeId } from "../ink/Stroke";
import { splitStrokeByCircle, strokesHitByCircle } from "../ink/Eraser";
import { getEraserRadiusPx, getEraserWholeStrokes } from "../inline/InkOverlay";
import { stripPenDown, stripPenFocus } from "../inline/StripPenChrome";
import { penContactIntent, tipMode } from "../inline/TipMode";
import { PAN_EDGE_CLEAR, panBatchDelta, panEdgeContact, panScrollLimit, panScrollNext } from "./PanScroll";
import { coalescedCount, recordPdfPanMove } from "./PdfPanTrace";
import { pageAt, PageBox, toPagePoint } from "./PageMap";
import { scrollerSizeOf } from "./PageBand";
import { installMethods } from "../inline/InstallMethods";
import { freshPdfTraceState, isTypingTarget, pdfPenWidth, pointerScale, type ReticleOutcome, type WetPair, type PdfInkController } from "./PdfInkController";

declare module "./PdfInkController" {
	interface PdfInkController {
		toContent(sample: PenSample, scroller: HTMLElement): { x: number; y: number };
		penDown(sample: PenSample, ev?: PointerEvent): void;
		penRaw(samples: PenSample[], ev?: PointerEvent): void;
		drawPredictedTail(ev: PointerEvent, box: PageBox, scale: number, scroller: HTMLElement): void;
		scaleFor(box: PageBox, fallback: number): number;
		cameraFor(box: PageBox): CameraState | null;
		drawContact(pair: WetPair, cam: CameraState, point: InkPoint): void;
		drawHead(pair: WetPair, cam: CameraState): void;
		drawWet(box: PageBox, point: InkPoint): void;
		opList(): readonly InkStroke[];
		eraseAt(box: PageBox, scale: number, sample: PenSample, scroller: HTMLElement): void;
		recordErase(id: string): void;
	}
}


	// ---- pen ----------------------------------------------------------------

	/**
	 * Scroller-relative sample to scroller-CONTENT coordinates.
	 *
	 * The router measures against the scroller's client box; page boxes are
	 * measured in its content box. The scroll offset is the whole difference,
	 * and forgetting it puts every stroke on page 1.
	 */
	function toContent(this: PdfInkController, sample: PenSample, scroller: HTMLElement): { x: number; y: number } {
		return { x: sample.x + scroller.scrollLeft, y: sample.y + scroller.scrollTop };
	}

	/**
	 * Bind the stroke to one page, once, and freeze the geometry it will use.
	 *
	 * Read once here and never again during the stroke: re-reading per sample
	 * would let a scroll or a zoom mid-stroke change the conversion halfway
	 * through and shear the line. The note surface freezes its camera at
	 * pen-down for exactly this reason.
	 */
	function penDown(this: PdfInkController, sample: PenSample, ev?: PointerEvent): void {
		// A fresh gesture starts here, whichever one it turns out to be -
		// so its trace bookkeeping resets here too, before any early return
		// below can leave a later `penRaw`/`penUp` reading a stale count
		// left over from the last gesture. Field write only; no gate needed.
		this.pdfTrace = freshPdfTraceState();
		// A pen on the glass is proof of a pen, and on much hardware it is the
		// ONLY proof: an Apple Pencil without hover support never fires
		// onPenHover, so a strip built only from the hover path was never built
		// at all and the toolbar simply did not exist (hardware, ipad,
		// 2026-08-29). Ahead of the id gate, because a pen that cannot draw yet
		// still wants its tools - and the dimmed reticle explains the refusal.
		//
		// VISIBILITY IS UNCONDITIONAL HERE AND STAYS THAT WAY, and it is not
		// the same ruling as the hover site's above. Contact is a deliberate
		// act: a mouse only reaches this line when mouse ink is already armed
		// (InlinePenRouter's `mouseActsAsPen`) and its owner has just drawn on
		// the page, which is a request for the tools in a way a mouse drifting
		// across the pane is not. `showCursor` gates because a hover is not an
		// act; this does not because a stroke is. So the strip appears for
		// every stroke on a PDF exactly as it did before, and the note surface
		// does the same at its own `penDown`.
		//
		// The HARDWARE claim is a different question and it is gated, because
		// a mouse stroke is not a pen. This is the divergence `cff850d` left
		// behind: it split the flags and taught InkOverlay's two sites the
		// difference, and this file kept calling the visibility function at
		// both of its own - so nothing a PDF-only user did with a real pen
		// ever set `penHardware`, and `nibIsLit` held their pen and
		// highlighter buttons dark unless mouse ink was on.
		//
		// The earlier comment on `showCursor` said this line "fires only on
		// real pen contact". It does not, and never did - that claim is why
		// the ungated call read as correct. Corrected in place, the way the
		// Pen spec's comment was, rather than deleted.
		if (ev?.pointerType === "pen") markPenHardwareSeen();
		else markPenSeen();
		// A pen on a viewer whose markup we do not recognise inks nothing, and
		// until now said nothing: from the outside that is indistinguishable
		// from the plugin being broken. It happens to a pane Obsidian has not
		// finished building - a tab restored but never opened - so the advice
		// is real rather than an apology.
		if (!this.probe()) {
			if (!this.warnedNoViewer) {
				this.warnedNoViewer = true;
				this.notify(
					"Handwriting: this PDF pane is not ready for ink - click the page once, or reopen the file."
				);
			}
			return;
		}
		this.warnedNoViewer = false;
		this.ensureTools();
		// Nothing starts before the document has been identified. Drawing
		// anyway means wet ink appears under the nib and then vanishes at
		// pen-up when there is no id to store it under - a stroke silently
		// lost, which is worse than a stroke that never began.
		//
		// SAYING SO is the other half. Refusing in silence is indistinguishable
		// from a broken plugin: notes drew, PDFs did not, and nothing on screen
		// said why (hardware, 2026-08-29). The wait is short, so the notice is
		// said once and then the reticle carries it.
		if (!this.documentId()) {
			if (!this.warnedNoId) {
				this.warnedNoId = true;
				this.notify("Handwriting: still identifying this PDF, ink starts in a moment");
			}
			return;
		}
		this.warnedNoId = false;
		const probed = this.probe();
		if (!probed || probed.scaleFactor === null) return;
		const scroller = probed.scroller;
		const boxes: PageBox[] = probed.pages.map((p) => ({
			pageNumber: p.pageNumber,
			leftPx: p.leftPx,
			topPx: p.topPx,
			widthPx: p.widthPx,
			heightPx: p.heightPx,
		}));
		const content = this.toContent(sample, scroller);
		const box = pageAt(boxes, content.x, content.y);
		if (!box) return;
		if (this.rotated.has(box.pageNumber)) {
			if (!this.warnedRotated.has(box.pageNumber)) {
				this.warnedRotated.add(box.pageNumber);
				this.notify("Handwriting: ink on a rotated PDF page is not supported");
			}
			return;
		}
		const intent = penContactIntent(ev?.buttons ?? 0, ev?.button ?? -1, tipMode());
		if (intent !== "ink" && intent !== "pan" && !this.inkReady()) {
			if (!this.warnedInkNotReady) {
				this.warnedInkNotReady = true;
				this.notify("Handwriting: this PDF's ink is not ready - try again in a moment");
			}
			return;
		}
		this.warnedInkNotReady = false;
		// A gesture is starting, whichever one: the strip steps aside and its
		// drop-down chrome closes, the same as a note (StripPenChrome.ts,
		// §5o) - this surface never called either half of that before.
		stripPenDown(this.tools);
		// A pinch the hand was already making ends here, with the gesture it
		// gives way to: its preview comes off the viewer and its lift fires no
		// zoom, so the page does not scale or jump under the pen. Here, after
		// every refusal above, so a contact that never takes leaves it alone.
		this.pinchBridge.cancel();
		// And the keyboard comes with it: the router cancelled the mousedown
		// that would have focused this pane, and Delete/Escape/undo here are a
		// keydown listener on this root rather than commands, so without this
		// the key went wherever focus already was (StripPenChrome.ts). Placed
		// with the strip chrome, after every early return that can refuse the
		// gesture: a pen on a pane with no viewer, no id or no page under the
		// sample has not acted on anything, and taking the keyboard away from
		// wherever it was would be a theft that bought nothing.
		const priorFocus = scroller.ownerDocument?.activeElement;
		// The find bar may live outside the scroll container but inside this pane.
		if (!(isTypingTarget(priorFocus ?? null) && this.root.contains?.(priorFocus ?? null))) {
			stripPenFocus(scroller);
			if (this.focusBinding?.scroller === scroller && priorFocus !== scroller && scroller.ownerDocument?.activeElement === scroller) {
				this.focusBinding.priorFocus = priorFocus as HTMLElement | null;
			}
		}
		// Frozen for the stroke, as it always was - but frozen from the box
		// rather than from the viewer variable that lags behind it.
		const scale = this.scaleFor(box, probed.scaleFactor);
		this.frame = { boxes, scale, scroller };
		this.recordDown(ev, sample, box, scale, scroller, content);
		this.strokePageNumber = box.pageNumber;
		// The one wet/head pair moves onto this page before any branch below
		// can draw on it: the lasso's loop and the space divider both return
		// early and both live on the wet layer (§5h/H1).
		const strokePageEl = this.pageElement(scroller, box.pageNumber);
		if (strokePageEl) this.attachPair(strokePageEl, box);
		this.mouseStroke = ev?.pointerType === "mouse";
		// Under a pen the dot comes off at contact: the hand is at the nib
		// and a dot under it reads as a smudge. Under a mouse the dot IS the
		// nib, so it stays on and follows the ink instead.
		if (!this.mouseStroke) this.hideCursor();
		// Decided once, at contact: reading this per sample would let a
		// mid-gesture toggle turn half a stroke into an erase.
		//
		// The pen's own eraser end counts as well as the mode, the side button
		// lassos exactly as it does on a note, and the strip's modes give both
		// meanings to hardware that has neither button. That is one rule, and
		// it lived here as a hand-written copy of the note surface's - which
		// is how the side button came to be checked on one surface and not the
		// other (hardware, 2026-08-29). `penContactIntent` (TipMode.ts) is now
		// the single implementation both surfaces call.
		//
		// `ev` is optional here because this surface's own teardown paths call
		// penDown without one; `?? 0` / `?? -1` are exactly what the `ev ? ...
		// : false` ternaries this replaced computed - no eraser end and no
		// side button, leaving the strip mode to decide alone. -1 is the DOM's
		// own "no button changed" value, and 0 would be the primary button.
		this.erasing = intent === "erase";
		// One line per contact that gets this far - past the no-viewer,
		// no-id, no-box and rotated-page refusals above, which have their
		// own notices already and are not this ticket's job. This is the
		// setup the mouse-eraser-ring investigation needed and did not
		// have: what the controller decided BEFORE the first `penRaw`
		// batch, in the same timeline as the router's own pointerdown line.
		if (diagnosticsEnabled()) this.tracePenDown(ev, box, scale, intent, probed);
		if (intent === "lasso") {
			this.lassoDown(box, scale, sample, probed.scroller);
			return;
		}
		// A BARE tip landing inside an active selection drags it - onenote's
		// grammar (alan, 2026-08-27), which the note surface has had since the
		// ruling and this surface never got. Here the only ways into a drag
		// were the side button and the toolbar's lasso mode, so a tip that
		// landed on ink the user had just selected drew a stroke straight
		// across it. Outside the bounds nothing changes: the tip dissolves the
		// selection below and inks.
		//
		// BARE is the load-bearing word. An eraser is not a bare tip, and the
		// note surface paid for learning it: left out of the test, lassoed ink
		// became the one ink on the page the eraser could not reach, because
		// every contact dragged the selection instead. `this.erasing` is
		// already decided above, from the pen's eraser end or the mode, and
		// this branch stands behind it.
		//
		// Above pan and space for the same reason the note surface puts it
		// above them: the selection is an object, and reaching for it should
		// not depend on which mode the strip was left in.
		if (!this.erasing && this.selected.length > 0) {
			const p = toPagePoint(box, scale, content.x, content.y);
			if (p && this.selectionGrabbed(box.pageNumber, p, scale)) {
				this.lassoDown(box, scale, sample, probed.scroller);
				return;
			}
		}
		// Pan and space, before anything inks. Both buttons are on this
		// surface's strip and both modes silently DREW here - a control that
		// looks alive and does the wrong thing is worse than one that is
		// missing (alan, 2026-08-30). Pan drags the viewer's own scroller;
		// space is refused with the reason, because a pdf page cannot grow.
		if (intent === "pan") {
			this.clearSelection();
			// THE ONE SCROLL READ OF THE WHOLE DRAG, taken here where it is off
			// the move path and where `probe()` above has already forced layout
			// clean. Everything after this is arithmetic on the carried value;
			// see `panLast` and `PanScroll.ts`.
			this.panLast = {
				x: sample.x,
				y: sample.y,
				scrollX: scroller.scrollLeft,
				scrollY: scroller.scrollTop,
			};
			// No edge held from whatever the last drag ended against.
			this.panEdge = PAN_EDGE_CLEAR;
			// The ring goes away and the grabbing hand goes on, ONCE, here -
			// not per sample, and not the other way round from the erase
			// branch below by accident. A pan is the one gesture on this
			// surface that is not marking anything, so it is the one gesture
			// with nothing to put under the tip; see `beginPanDragCursor`.
			// AFTER `panLast` is set, because the gate that keeps the ring
			// down for the rest of the drag reads it.
			this.beginPanDragCursor(scroller);
			return;
		}
		if (intent === "space") {
			this.clearSelection();
			// The page cannot grow, but the ink can make room: everything in
			// the rows below the divider follows the pen, the same gesture -
			// and the same pure membership rule - the note surface uses.
			// Page-scoped: a divider on page 3 is a statement about page 3.
			const p = toPagePoint(box, scale, content.x, content.y);
			if (!p) return;
			const here = this.strokes(box.pageNumber);
			this.spaceIds = strokeIdsBelow(here, p.y);
			if (this.spaceIds.length === 0) {
				// A gesture that moves nothing is indistinguishable from a
				// broken one; the note surface paid hardware time to learn it.
				this.notify("Handwriting: no ink below the line");
				return;
			}
			// Snapped out of any row the line was drawn through, and DRAWN
			// where it snapped: the seam shown is the seam that will cut.
			this.spaceLineY = snapLine(rowsOf(here), p.y);
			this.spaceLastY = p.y;
			this.spaceTotalDy = 0;
			this.drawSpaceLine(box);
			// Same watchdog problem as pan and the eraser: the divider reticle
			// was drawn on the wet canvas above, but the DOT reticle
			// (`cursorEl`) only ever moved on hover, so it went stale and then
			// vanished mid-drag without this.
			this.showSpaceCursor(sample);
			return;
		}
		// Any other contact puts a selection away. Leaving it live while ink
		// is drawn over it is how a later drag moves something the user had
		// forgotten was picked up.
		this.clearSelection();
		if (this.erasing) {
			this.eraseFrom = [...this.opList()];
			// PAGE-scoped, not `eraseFrom` (document-wide): the note surface's
			// "page" is the whole file, but a pdf page is one of many, and a
			// page with no ink of its own can never be touched by this
			// gesture even while other pages carry ink. Checking the document
			// list here would stay silent on exactly that page. Same lesson
			// insert-space paid hardware time to learn, said once per page
			// (ruled 2026-09-14) rather than once per contact.
			this.sayIfPageEmpty(box.pageNumber, "erase");
			this.metrics.begin("pdf-erase", performance.now());
			this.metricsLive = true;
			this.startFrameTicker();
			// Drive the reticle through the erase, the way the note surface
			// does (InkOverlay's own penDown erase branch calls
			// `showEraserCursor` right here). `showCursor` already sizes
			// itself to the eraser - `mode === "eraser" ? getEraserRadiusPx()
			// : ...` - and its header has promised since it was written that
			// "size follows the mode, the way it does on a note". It did, on
			// HOVER. Nothing called it once the pen was DOWN, so the 1000ms
			// watchdog fired mid-erase and took the ring away: the eraser
			// worked and you could not see what it was about to take (alan,
			// hardware, 2026-09-03, checklist item 5 on a PDF).
			//
			// No pointerType: the hardware and pen-seen claims belong to the
			// hover and the pen-down that already happened, not to every
			// sample of a stroke in flight. `pointerRaisesPenTools(undefined)`
			// is false, so this cannot mark anything by accident.
			this.showEraserCursor(sample);
			this.eraseAt(box, scale, sample, probed.scroller);
			return;
		}
		const tool = getInlineTool();
		this.strokeStyle = {
			...(tool === "highlighter" ? HIGHLIGHTER_PEN : DEFAULT_PEN),
			color: getInkColorHex(tool),
			// Divided by a fixed reference, because widths here are stored in
			// PAGE units and the renderer multiplies by the live scale.
			// Undivided, a note's 2.2 landed as 4.1 css px on a page shown at
			// 1.87: pdf ink was close to twice as thick as note ink at a
			// document's ordinary view. The taper is proportional to width, so
			// it ate twice the share of a stroke too - measured at 27% of a
			// short stroke against 14% on a note, which is the end looking
			// clipped.
			//
			// The divisor was the LIVE scale for a while, which fixed that
			// reading and inverted the law it was supposed to serve: the scale
			// cancelled against the renderer's, so a stroke was `baseWidth`
			// css px at the instant it was drawn and nothing else. Drawn zoomed
			// to 3x it stored a third of a nib, so it was a hairline while you
			// wrote it and still a hairline zoomed back out (alan, hardware,
			// 2026-09-04). A FIXED reference keeps the width constant in page
			// points, which is what "stored in page units" was always meant to
			// say: ink weighs the same on the page whatever zoom it was laid
			// down at, and thickens with the text when you zoom in - the note
			// surface's law, on this surface at last.
			baseWidth: pdfPenWidth(
				tool === "highlighter" ? HIGHLIGHTER_PEN.baseWidth : DEFAULT_PEN.baseWidth,
				getInkSizeMult(tool)
			),
		};
		// Fifth argument, past `minDistWorld`'s default: it sets `stroke.device`,
		// and `device !== "mouse"` is the gate that lets velocity shaping run
		// (StrokeOutline.ts, StrokeRenderer.ts). `mouseStroke` was already
		// worked out at pen-down and then never reached the stroke, so a mouse
		// drawn over a pdf was shaped while the same gesture on a note was not
		// (InkOverlay.ts passes it; 1.4.7-design.md C6).
		this.builder = new StrokeBuilder(
			tool,
			this.strokeStyle.color,
			this.strokeStyle.baseWidth,
			undefined,
			this.mouseStroke ? "mouse" : undefined
		);
		// Before the first sample, as the note and slides surfaces do: a point stores its time
		// from the stroke's first sample, not the browser's absolute event time.
		this.builder.start(sample.timestamp);
		this.predReal = [];
		this.predLastTail = [];
		this.metrics.begin("pdf-ink", performance.now());
		this.metricsLive = true;
		this.startFrameTicker();
		this.wetFrom = null;
		this.wetBegun = false;
		// Read here and not off the wet layer: the pair is shared between the
		// pen and the highlighter, so only the stroke knows which tool it is.
		this.wetFlat = tool === "highlighter";
		// Before the first sample, so a clean page has a canvas to draw on.
		this.ensureOverlay(box.pageNumber);
		const pair = this.wetOn(box.pageNumber);
		if (pair) {
			pair.wet.clear(box.widthPx, box.heightPx);
			// Per stroke, from the device, exactly as the note surface does it
			// (InkOverlay.ts). The layer is built with shaping ON and that is
			// still its resting state; a mouse stroke turns it off for the one
			// stroke, because the commit will not shape it either
			// (`stroke.device !== "mouse"`, StrokeRenderer.ts). Set once at the
			// pair's construction it was merely wrong-and-consistent while the
			// commit shaped mice too; since 1c4b250 stopped shaping them, the
			// live stroke was drawn shaped and redrawn flat at pen-up - the
			// reshape-under-the-nib this whole path exists to prevent.
			//
			// After `this.mouseStroke` above and before the first sample, which
			// is where `beginStroke` latches it into `shapingThisStroke`
			// (WetInkRenderer). Written after the latch it would change nothing.
			pair.wet.shape = !this.mouseStroke;
		}
		this.wetHighlighter = tool === "highlighter";
		this.dressWet(this.overlays.get(box.pageNumber));
		// With its event, so the down sample's delivery is stamped like every
		// other's - without it the summary counted one more acceptance than it
		// had samples and printed dedup -1.
		this.penRaw([sample], ev);
	}

	function penRaw(this: PdfInkController, samples: PenSample[], ev?: PointerEvent): void {
		const frame = this.frame;
		const builder = this.builder;
		// Read once per call, not once per branch below: THE CALL-SITE RULE
		// (DiagSwitch.ts) says the gate must sit ahead of every string this
		// batch's trace line would build, and one boolean read shared by all
		// eight branches costs less than eight.
		const diagOn = diagnosticsEnabled();
		if (diagOn) this.pdfTrace.batchIndex++;
		if (!frame) {
			if (diagOn) this.traceRawBatch("dropped-no-frame", samples.length, ev, "reticle=n/a");
			return;
		}
		// No probe here. The scroller was frozen with the rest of the geometry
		// at pen-down, and probeViewer reads clientWidth, offsetTop and a rect
		// off EVERY page div - which pdf.js does not virtualise, so a hundred
		// page document meant a hundred forced layout reads per pointer event,
		// at pen rates, for the one thing wanted here: scroll offsets, which
		// are read live off the element.
		const scroller = frame.scroller;
		this.probeInStroke++;
		if (this.panLast !== null) {
			// Content follows the pen: the page moves WITH the hand, so the
			// scroll offsets move against the sample deltas. 1:1 and direct -
			// no glide, no curve - because the pen is literally holding the
			// page. Viewport-relative samples are already scroll-independent.
			//
			// `from` is where this batch found the hand AND the page. Nothing
			// below writes to it - `this.panLast` is rebound past it - so the
			// trace can still say what the batch actually applied. It is a
			// reference to an object that already exists, so it costs nothing
			// when the trace is off.
			const from = this.panLast;
			// The pan latency instrument (PdfPanTrace.ts). The only thing
			// between it and the pan path is `diagOn` - the ONE
			// `diagnosticsEnabled()` read this call already made at the top
			// for its eight trace branches. With diagnostics off that is a
			// test of a local and nothing else: no clock read, no coalesced
			// list, no entry object, no animation frame requested.
			const panT0 = diagOn ? performance.now() : 0;
			// ONE WRITE PER AXIS PER MOVE, AND NO READ. What stood here was a
			// loop of `scroller.scrollLeft -= smp.x - last.x` - a read and a
			// write for every sample in the batch - and the read is the half
			// that can force layout across every page div pdf.js has left in
			// the DOM. The batch collapses to one delta (`panBatchDelta`, and
			// its header on why that is equal and not merely close), the delta
			// lands on a total this drag has carried since pen-down, and the
			// total is clamped to what the scroller can actually do because
			// the browser's own clamp is no longer in the loop to do it.
			const batch = panBatchDelta(from, samples);
			const start = { x: from.scrollX, y: from.scrollY };
			let limit = panScrollLimit(this.scrollerSize);
			let to = panScrollNext(start, batch, limit);
			// THE ONE PLACE THE SIZE CACHE IS ALLOWED TO BE WRONG. It is
			// measured in `sync`, a scroll does not reach `sync`, and pdf.js can
			// grow `scrollHeight` between two of them. One measure per edge
			// ARRIVAL and never per move; `panEdgeContact` is the whole rule.
			let edge = panEdgeContact(to, limit, this.panEdge);
			if (edge.remeasure) {
				this.scrollerSize = scrollerSizeOf(scroller);
				limit = panScrollLimit(this.scrollerSize);
				to = panScrollNext(start, batch, limit);
				edge = panEdgeContact(to, limit, edge.latch);
			}
			this.panEdge = edge.latch;
			scroller.scrollLeft = to.x;
			scroller.scrollTop = to.y;
			this.panLast = { x: batch.last.x, y: batch.last.y, scrollX: to.x, scrollY: to.y };
			// NO CURSOR WORK HERE ANY MORE; see beginPanDragCursor, and the
			// gate in showCursor that keeps it out. This branch used to call
			// `showPanCursor(lastPan)` on every batch, which repainted the
			// ring and re-armed a 1000ms watchdog for a marker the drag has no
			// business showing at all.
			if (diagOn) {
				// The handler number is now the two scroll writes and the
				// arithmetic that decided them - the whole of what a pan move
				// costs, because there is nothing else left in the branch.
				recordPdfPanMove(
					{
						t: panT0,
						handlerMs: performance.now() - panT0,
						// THE DELTA ACTUALLY WRITTEN, which is not always the
						// one the batch asked for: a drag already at the top
						// of the document asks for more and gets clamped to
						// nothing. Measured across the carried position rather
						// than the samples, so the column stays true whatever
						// the clamp did - and negated already, since the
						// scroller moves against the hand.
						dx: to.x - from.scrollX,
						dy: to.y - from.scrollY,
						samples: samples.length,
						coalesced: coalescedCount(ev),
						ptr: ev?.pointerType ?? "",
					},
					this.win
				);
				this.traceRawBatch("pan", samples.length, ev, "reticle=n/a");
			}
			return;
		}
		const box = frame.boxes.find((b) => b.pageNumber === this.strokePageNumber);
		if (!box) {
			if (diagOn) this.traceRawBatch("dropped-no-box", samples.length, ev, "reticle=n/a");
			return;
		}
		if (this.spaceLineY !== null) {
			const id = this.documentId();
			for (const s of samples) {
				const content = this.toContent(s, scroller);
				const p = toPagePoint(box, frame.scale, content.x, content.y);
				if (!p) continue;
				const dy = p.y - this.spaceLastY;
				if (dy === 0) continue;
				this.spaceLastY = p.y;
				this.spaceTotalDy += dy;
				// The line rides with the pen, leading the ink it pushes.
				this.spaceLineY += dy;
				// Vertical only: the divider is a seam, not a joystick. Applied
				// live and unrecorded, one op into history at release - the
				// lasso drag's shape exactly.
				if (id) this.queueEditFrame(box, "space", id, this.strokePageNumber, this.spaceIds, 0, dy);
			}
			// Last sample only, same reasoning as pan and erase.
			const lastSpace = samples[samples.length - 1];
			if (lastSpace) this.showSpaceCursor(lastSpace);
			if (diagOn) this.traceRawBatch("space", samples.length, ev, "reticle=n/a");
			return;
		}
		// A lasso runs with no builder and no eraser, so it has to be routed
		// before the guard that requires one of them. Below that guard the
		// whole gesture was unreachable: every sample returned early, so no
		// loop was ever drawn and pen-up closed a one-point polygon that
		// selected nothing.
		if (this.lassoPts.length > 0 || this.dragFrom) {
			for (const s of samples) this.lassoMove(box, frame.scale, s, scroller);
			// Last sample only, same reasoning as pan and erase.
			const lastLasso = samples[samples.length - 1];
			if (lastLasso) this.showLassoCursor(lastLasso);
			if (diagOn) this.traceRawBatch("lasso", samples.length, ev, "reticle=n/a");
			return;
		}
		if (!builder && !this.erasing) {
			if (diagOn) this.traceRawBatch("dropped-no-builder", samples.length, ev, "reticle=n/a");
			return;
		}
		if (this.erasing) {
			for (const s of samples) this.eraseAt(box, frame.scale, s, scroller);
			// The LAST sample only, matching the note surface's erase branch:
			// the ring is one element and only its final position in this
			// batch is ever seen, so painting it once per batch costs one DOM
			// write instead of one per coalesced sample. Keeping it alive here
			// is also what holds the watchdog off for the length of the
			// stroke, since every call re-arms that timer.
			const last = samples[samples.length - 1];
			const outcome = last ? this.showEraserCursor(last) : null;
			if (diagOn) {
				this.recordReticleOutcome(outcome);
				this.traceRawBatch("erase", samples.length, ev, this.describeReticleOutcome(outcome));
			}
			return;
		}
		if (!builder) return;
		const t0 = performance.now();
		if (ev) this.metrics.recordEvent("raw", samples.length, t0 - ev.timeStamp, true);
		let accepted = 0;
		// Only a mouse stroke ever calls the reticle in this loop (below) -
		// a pen's hand covers the dot, so `penDown` hid it for the gesture
		// and nothing here reshows it. `null` stays "not attempted" for a
		// pen draw, which is a real, honest outcome and not a skip.
		let lastDrawOutcome: ReticleOutcome | null = null;
		for (const s of samples) {
			const content = this.toContent(s, scroller);
			// Converted against the STROKE'S page, whatever page the sample is
			// over now. A descender that runs past the page edge belongs to the
			// letter it came from; see PageMap.strokePage.
			const p = toPagePoint(box, frame.scale, content.x, content.y);
			if (!p) continue;
			const point = builder.add(p.x, p.y, s.pressure, s.timestamp, s.tiltX, s.tiltY);
			// The last REAL reading, for the lift point to inherit. This field was
			// declared and nulled and never once written, so addFinalPoint fell
			// through to its 0.5 default on every stroke: the closing point was
			// laid down at mid pressure however hard you were pressing, and the
			// end pulled thin as the committed stroke replaced the wet one.
			this.wetFrom = { x: p.x, y: p.y, pressure: s.pressure };
			// What prediction extrapolates from. Bounded: the caps only ever
			// look at the last handful, and an unbounded list on a long
			// stroke is a leak nobody notices until a page of writing.
			this.predReal.push({ ...s, x: p.x, y: p.y });
			if (this.predReal.length > 12) this.predReal.shift();
			if (point) {
				this.drawWet(box, point);
				accepted++;
			}
			// The dot rides the newest sample, so a mouse always has a nib.
			if (this.mouseStroke) lastDrawOutcome = this.showCursor(s, "mouse");
		}
		// Rejected jitter still changes prediction. Clear the old tail while
		// retaining the accepted head, even when no wet point was appended.
		if (accepted === 0 && builder.lastPoint) {
			const pair = this.wetOn(box.pageNumber);
			const cam = this.cameraFor(box);
			if (pair && cam) {
				if (builder.pointCount === 1) this.drawContact(pair, cam, builder.lastPoint);
				else this.drawHead(pair, cam);
			}
		}
		// The predicted tail rides on top of the head, from the newest real
		// sample outward. Fed in PAGE units like everything else here: the
		// caps are in css px and the two differ by the page scale, so the
		// samples are converted on the way in and the result converted back.
		if (ev && predictionEnabled()) this.drawPredictedTail(ev, box, frame.scale, scroller);
		const drawEnd = performance.now();
		const newestTs = samples[samples.length - 1]?.timestamp ?? t0;
		this.metrics.recordAccepted(accepted);
		this.metrics.recordDraw(drawEnd - t0, drawEnd - newestTs);
		// age@present: from the newest sample's own stamp to the frame after
		// this handler - the same probe the note surface runs, so the two
		// surfaces' numbers can be laid side by side and mean the same thing.
		if (!this.presentProbePending) {
			this.presentProbePending = true;
			this.win.requestAnimationFrame(() => {
				this.presentProbePending = false;
				const presentAge = performance.now() - newestTs;
				recordPresentAge(presentAge);
				this.metrics.recordPresent(presentAge);
			});
		}
		if (diagOn) {
			// Only tallied for a mouse stroke: a pen draw never asked the
			// reticle for anything this batch (see `lastDrawOutcome` above),
			// and counting that as a "skip" would blame the wrong branch for
			// the eraser-ring investigation this exists to serve.
			if (this.mouseStroke) this.recordReticleOutcome(lastDrawOutcome);
			this.traceRawBatch("draw", samples.length, ev, this.describeReticleOutcome(lastDrawOutcome));
		}
	}

	/**
	 * The disposable guess ahead of the nib.
	 *
	 * Never added to the stroke - `builder.add` has already seen every real
	 * sample by the time this runs, and these points touch nothing but the
	 * head canvas, which is cleared on the next event regardless. A stroke
	 * saved mid-prediction is the stroke that would have been saved without
	 * it.
	 *
	 * Screen space, not page space. `Prediction`'s caps are css px and ms -
	 * "never guess more than 10px ahead" means ten pixels of glass, at any
	 * zoom - so the samples go in multiplied by the page scale and the
	 * result comes back divided by it. The note surface does not have to do
	 * this because its sample space already IS css px.
	 *
	 * Scoring runs first, against the tail drawn last event: the sample that
	 * just arrived is the ground truth for the guess made before it, and once
	 * `predLastTail` is overwritten that comparison is gone.
	 */
	function drawPredictedTail(this: PdfInkController, ev: PointerEvent, box: PageBox, scale: number, scroller: HTMLElement): void {
		const pair = this.wetOn(box.pageNumber);
		const cam = this.cameraFor(box);
		const newest = this.predReal[this.predReal.length - 1];
		if (!pair || !cam || !newest) return;
		const toScreen = (s: PenSample): PenSample => ({ ...s, x: s.x * scale, y: s.y * scale });
		if (this.predLastTail.length > 0) {
			const err = correctionError(this.predLastTail.map(toScreen), toScreen(newest));
			if (err !== undefined) this.metrics.recordCorrection(err);
		}
		// Chromium's predicted samples are scroller-relative css px, like
		// every router sample - and the real samples here have already been
		// converted to page units. Mixing the two origins put the predicted
		// tail wherever the scroll offset happened to be. The conversion the
		// real samples walk (toContent, toPagePoint, then toScreen) collapses
		// for these to one subtraction per axis: page units times `scale` is
		// content px measured from the page box's corner.
		const predicted = (this.router?.predictedSamples(ev) ?? []).map((pr) => ({
			...pr,
			x: pr.x + scroller.scrollLeft - box.leftPx,
			y: pr.y + scroller.scrollTop - box.topPx,
		}));
		// Boox mode's e-ink horizon applies HERE too - writing on pdfs is
		// the headline use, and the caps switch must not be an inline-only
		// courtesy.
		const caps = predictionEinkOn() ? EINK_CAPS : adaptiveCaps(presentLagMs());
		const result = buildTail(
			this.predReal.map(toScreen),
			predicted,
			predicted.length > 0 ? "chromium" : "extrap",
			caps
		);
		this.metrics.setPrediction("on", result.source, caps.maxHorizonMs);
		// Page units for SCORING only - the next event compares in screen
		// space after mapping back through toScreen. The DRAW takes screen
		// px directly: TailRenderer.draw has no camera (drawHead converts
		// for itself; draw does not), so handing it page units painted the
		// tail at 1/scale toward the page corner - the tiny stray dot
		// up-left of every pen contact (alan, 2026-08-31).
		this.predLastTail = result.points.map((s) => ({ ...s, x: s.x / scale, y: s.y / scale }));
		if (result.suppressed || result.points.length === 0) {
			this.metrics.recordTailSuppressed();
			return;
		}
		this.metrics.recordTail(result.points.length, result.horizonMs, result.tipDistPx);
		pair.tail.draw(
			newest.x * scale,
			newest.y * scale,
			result.points,
			this.strokeStyle.color,
			pair.wet.liveWidthPx(cam, this.strokeStyle, newest.pressure)
		);
	}

	/**
	 * The scale a POINTER sample is converted with.
	 *
	 * From the box, exactly as the drawing scale is, and for the same reason:
	 * `--scale-factor` updates on its own schedule while the box is whatever
	 * it is right now, so during a zoom the two disagree. Converting input
	 * with one and drawing with the other put the ink where the pointer USED
	 * to be - an offset that grew with how far the zoom had moved and then
	 * healed itself once the viewer settled and the two agreed again (alan,
	 * on hardware, 2026-08-30).
	 *
	 * The fallback is the viewer's own number, for a page whose size in
	 * points has not been measured yet. That page has never been painted, so
	 * there is nothing better to ask, and it is right whenever the viewer is
	 * settled - which is every moment except the one this exists for.
	 */
	function scaleFor(this: PdfInkController, box: PageBox, fallback: number): number {
		return pointerScale(box.widthPx, this.pageSize.get(box.pageNumber)?.wPt ?? 0, fallback);
	}

	/** The camera a page's ink is drawn with: page units to css px. */
	function cameraFor(this: PdfInkController, box: PageBox): CameraState | null {
		const wPt = this.pageSize.get(box.pageNumber)?.wPt ?? 0;
		if (wPt <= 0) return null;
		return { x: 0, y: 0, zoom: box.widthPx / wPt };
	}

	/**
	 * Draw the contact dot: the mark a pen-down makes before anything moves.
	 *
	 * A SECOND call site, and that is the whole mechanism. The one below
	 * serves the MOVING head and has to keep tapering; this one serves the
	 * first accepted sample, where the dot is the entire visible mark. The
	 * note surface splits the same job the same way - its pen-down draw and
	 * its raw draw are separate calls - and the split is what lets each ask
	 * for the width its case needs without the other knowing about it.
	 *
	 * Ungated on `head()`, deliberately: the smoother has nothing to report
	 * at pen-down, and with smoothing off (boox) it never will. The segment
	 * is the contact point to itself, and the width is `contactHalfWidth` -
	 * the shaped width floored at the nib (alan, 2026-09-02), so a light tap
	 * draws the nib rather than the 12% sliver the shaper resets to.
	 */
	function drawContact(this: PdfInkController, pair: WetPair, cam: CameraState, point: InkPoint): void {
		pair.tail.clear();
		pair.tail.drawHead(
			cam,
			this.strokeStyle,
			{ x: point.x, y: point.y },
			{ x: point.x, y: point.y },
			point.pressure,
			pair.wet.contactHalfWidth(this.strokeStyle, point.pressure)
		);
	}

	/**
	 * Redraw the stub between the settled curve and the nib.
	 *
	 * After every appended sample: the wet layer's smoothed tail is always
	 * one segment behind by construction, and this is the piece that reaches
	 * the pen. Cleared and redrawn whole each time - it is a few dozen
	 * pixels, and TailRenderer clears only the last draw's bounding box.
	 */
	function drawHead(this: PdfInkController, pair: WetPair, cam: CameraState): void {
		const head = pair.wet.head();
		pair.tail.clear();
		if (head) {
			// The width comes from the wet layer, not from raw pressure, so
			// the stub and the ribbon it continues are the same thickness.
			// This surface's world unit is a PDF point, but nothing here is
			// converted - a world half-width is a world half-width on
			// whatever surface produced it.
			pair.tail.drawHead(
				cam,
				this.strokeStyle,
				head.from,
				head.to,
				head.pressure,
				pair.wet.liveHalfWidth(this.strokeStyle, head.pressure)
			);
		}
	}

	/**
	 * Extend the live stroke: draw the newest segment onto the page's wet
	 * overlay, exactly as it will look once committed.
	 *
	 * This surface has had a wet canvas of its own since the pen survived the
	 * viewer being rebuilt underneath it. What it still lacks is the note
	 * surface's third layer for the unsmoothed head, which is why the live
	 * stroke here sits one sample behind the pointer.
	 *
	 * Smoothing is left ON, not off. (This comment said the opposite, and
	 * pointed at the line that disproves it - see where `smooth` is set.)
	 * Turning it off was tried on 2026-08-30 and reverted the same day: the
	 * unsmoothed path draws per-segment strokes whose anti-aliased end caps
	 * overlap at every sample, and the stacked edges read as a fuzzy line at
	 * zoom. The lag is the smaller of the two evils until the head layer is
	 * ported.
	 */
	function drawWet(this: PdfInkController, box: PageBox, point: InkPoint): void {
		const pair = this.wetOn(box.pageNumber);
		const cam = this.cameraFor(box);
		if (!pair || !cam) return;
		if (this.wetBegun) {
			pair.wet.appendPoint(cam, this.strokeStyle, point);
		} else {
			// The first accepted sample of the stroke. `appendPoint` used to
			// take it too, which drew nothing (it has no previous point) but
			// also told the renderer nothing: the smoothed-centerline and
			// shaped-width decisions are made here, per stroke, from the
			// TOOL - never from the layer, which is one pair for both tools.
			this.wetBegun = true;
			pair.wet.beginStroke(point, this.strokeStyle, this.wetFlat, this.builder!.resolvedPressureProfile);
			// The contact draw, not the moving one. One shared call site meant
			// this surface asked for the bare live width on the FIRST sample
			// too, so a tap came out at the shaper's tip floor; swapping that
			// shared site to `contactHalfWidth` would have floored the moving
			// head as well and killed the taper. Two sites, one per case.
			this.drawContact(pair, cam, point);
			return;
		}
		this.drawHead(pair, cam);
	}

	/**
	 * The list op indices are measured against. See `allStrokes`.
	 *
	 * An empty answer is an ANSWER: a document with no ink has no positions to
	 * name. Wherever the two sources agree, an empty document is also an empty
	 * page, so the erase gets no hit and the lasso no selection and no caller
	 * below ever asks for an index into it.
	 *
	 * This used to fall back to the page list when the document list came back
	 * empty, for the benefit of a caller that supplied no document source;
	 * `allStrokes` is required now, so that caller cannot exist, and what
	 * remained of the fallback fired only where the two sources genuinely
	 * DISAGREE - substituting page-local indices into a splice against the
	 * document, which is the defect `allStrokes` was added to fix.
	 * main.ts's calibration wiring is one such disagreement: with
	 * `pdfCalibration` on, the page source answers with synthetic crosses and
	 * the document source answers empty, on purpose.
	 */
	function opList(this: PdfInkController): readonly InkStroke[] {
		return this.allStrokes();
	}

	/**
	 * Erase under the nib, as one operation per contact point.
	 *
	 * Two modes, the same two the note surface has, chosen by the strip's
	 * Stroke | Reticle toggle:
	 *
	 * - **Reticle** (partial): a stroke the circle crosses comes out and its
	 *   surviving pieces go back in, as a single `replace`, so undo restores
	 *   the original rather than the fragments.
	 * - **Stroke** (whole): the whole stroke goes, indices kept so undo puts
	 *   it back at its original depth rather than on top of everything.
	 */
	function eraseAt(this: PdfInkController, box: PageBox, scale: number, sample: PenSample, scroller: HTMLElement): void {
		const id = this.documentId();
		if (!id) return;
		const content = this.toContent(sample, scroller);
		const p = toPagePoint(box, scale, content.x, content.y);
		if (!p) return;
		// Hit-tested and indexed against the PAGE: the nib can only reach what is
		// on it, and the op is a page-local live op ("live-page"), so nothing
		// here reads the document list. The gesture's single history entry is
		// built against the document at pen-up (recordErase).
		const onPage = [...this.strokes(box.pageNumber)];
		// The radius is screen px; page units are screen px divided by scale,
		// so the nib covers the same physical area at any zoom.
		const r = getEraserRadiusPx() / scale;
		const hitIds = new Set(strokesHitByCircle(onPage, p.x, p.y, r));
		if (hitIds.size === 0) return;
		const removed: InkStroke[] = [];
		const removedAt: number[] = [];
		const inserted: InkStroke[] = [];
		const insertedAt: number[] = [];
		const whole = getEraserWholeStrokes();
		// applyOp splices the pieces into the list AFTER every removal, in
		// order of position, so a piece's position is where its stroke sat once
		// the strokes removed before it are gone and the pieces placed before it
		// are in. Using the stroke's original index instead lifts the pieces one
		// slot per earlier removal, above ink drawn after them.
		let taken = 0;
		for (let at = 0; at < onPage.length; at++) {
			const stroke = onPage[at]!;
			if (!hitIds.has(stroke.id)) continue;
			removed.push(stroke);
			removedAt.push(at);
			if (!whole) {
				// nothing survives a whole-stroke erase; there are no pieces to put back
				for (const piece of splitStrokeByCircle(stroke, p.x, p.y, r, newStrokeId)) {
					insertedAt.push(at - taken + inserted.length);
					inserted.push({ ...piece, page: box.pageNumber });
				}
			}
			taken++;
		}
		// Applied, not recorded. The gesture's single history entry is built at
		// pen-up from the snapshot taken when it started.
		this.apply(
			{ type: "replace", path: id, removed, removedAt, inserted, insertedAt },
			box.pageNumber,
			"live-page"
		);
	}

	/** One history entry for a whole erase gesture, or none if nothing went. */
	function recordErase(this: PdfInkController, id: string): void {
		// Both snapshots are of the DOCUMENT list, or the indices in this op
		// would not name positions applyOp can splice at. See allStrokes.
		const before = this.eraseFrom ?? [];
		const after = this.opList();
		const afterIds = new Set(after.map((s) => s.id));
		const beforeIds = new Set(before.map((s) => s.id));
		const removedAt: number[] = [];
		const removed = before.filter((s, i) => !afterIds.has(s.id) && removedAt.push(i) > 0);
		if (removed.length === 0) return;
		const insertedAt: number[] = [];
		const inserted = after.filter((s, i) => !beforeIds.has(s.id) && insertedAt.push(i) > 0);
		this.recordOp({ type: "replace", path: id, removed, removedAt, inserted, insertedAt });
	}

export function installPdfInkPenPath(proto: PdfInkController): void {
	installMethods(proto, {
		toContent,
		penDown,
		penRaw,
		drawPredictedTail,
		scaleFor,
		cameraFor,
		drawContact,
		drawHead,
		drawWet,
		opList,
		eraseAt,
		recordErase,
	});
}
