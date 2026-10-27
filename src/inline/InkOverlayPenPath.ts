/**
 * The note surface's pen path: pen down, the raw samples, pen up and the end of the gesture, the snap preview, the predicted tail,
 * the present probe, the camera anchor and the visible band area. They are methods of InkOverlayPlugin, installed on its prototype
 * when InkOverlay.ts loads.
 */
import { Platform } from "obsidian";
import { CameraState } from "../camera/coordinates";
import { contentOrigin } from "./ContentOrigin";
import { anchorPaddingTop, anchorTop } from "./DocumentTop";
import { cameraOriginYLayout, documentAnchorLadder, impliedDocumentTop, rungIndexFor } from "./DocumentAnchor";
import { penContactIntent, tipMode } from "./TipMode";
import { stripPenDown, stripPenUp } from "./StripPenChrome";
import { markPenHardwareSeen, markPenSeen } from "./PenToolsMode";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { DEFAULT_PEN, HIGHLIGHTER_ALPHA, HIGHLIGHTER_PEN } from "../ink/PenStyle";
import { getInkColorHex } from "../ink/InkColor";
import { InkStroke } from "../ink/Stroke";
import { coarseGridFor, StrokeBuilder } from "../ink/StrokeBuilder";
import { type StrokeWidthMode, strokeWidthPolicy } from "../ink/StrokeWidth";
import { drawStroke } from "../ink/StrokeRenderer";
import { PenSample, silentLift } from "../input/PointerRouter";
import { SnapPreview, SnapPreviewCanvas } from "./SnapPreview";
import { padBBox, pointInBBox, scaleStroke } from "../objects/Selection";
import { eraseRemovalIndices, snapHistoryOps } from "./InkHistory";
import { adaptiveCaps, buildTail, correctionError, EINK_CAPS } from "../ink/Prediction";
import { presentLagMs, recordPresentAge } from "../ink/LatencyEstimate";
import { predictionEinkOn, predictionEnabled } from "./StrokePrediction";
import { handoffFinishedStroke } from "./StrokeHandoff";
import { focusClaimedPenEditor } from "./InlineFocus";
import { normalizeInlinePenPressure } from "./PenPressure";
import { observeStrokeMax, strokeGain } from "../ink/PressureGain";
import { DWELL_MS, snapStroke } from "../ink/ShapeSnap";
import { noteToVisual, visualToNote } from "./ZoomScale";
import { isPenProbeEnabled, noteProbeStroke } from "./PenProbe";
import { scrollProbePenDown } from "./ScrollProbe";
import { installMethods } from "./InstallMethods";
import { eraserWholeStrokes, getInkSizeMult, inlineTool, shapeSnapOn } from "./InkOverlayToolState";
import { committedFloorFor, inlineInk, metrics, PRED_HISTORY, SELECTION_GRAB_PAD, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		penDown(sample: PenSample, ev: PointerEvent): void;
		beginSnapPreview(sample: Pick<PenSample, "x" | "y">, ev: PointerEvent): void;
		clearSnapPreview(): void;
		penRaw(samples: PenSample[], ev: PointerEvent): void;
		planPredictedTail(ev: PointerEvent, cam: CameraState): { fromX: number; fromY: number; points: readonly PenSample[]; lineWidthPx: number } | null;
		schedulePresentProbe(newestTs: number): void;
		freshFrame(): { x: number; y: number } | null;
		anchorCameraY(overlayTop: number): { layout: number; rung: number; impliedTop: number } | null;
		recordPenDownState(sample: PenSample): void;
		gainedPressure(raw: number): number;
		penUp(ev?: PointerEvent): void;
		endPenGesture(ev?: PointerEvent): void;
		visibleBandArea(band: HTMLElement): { left: number; top: number; width: number; height: number };
	}
}

	function penDown(this: InkOverlayPlugin, sample: PenSample, ev: PointerEvent): void {
		// A new owned gesture invalidates any previous camera/reveal continuation.
		this.viewportGeneration++;
		this.clearSnapPreview();
		// The router cancels pointerdown so the pen cannot move CodeMirror's
		// caret. That also cancels native focus. Give keyboard ownership back to
		// this editor before freezing geometry, or Delete and undo go wherever
		// focus happened to be before the pen landed.
		if (ev.pointerType !== "touch") {
			focusClaimedPenEditor(this.view, Platform.isMobileApp);
		}
		// Hide the DOT only. The hover class stays on: it is what holds
		// `cursor: none` over the scroller, and dropping it here handed every
		// stroke to CodeMirror's I-beam - the reticle "flickered" because each
		// pen-down swapped it for a text cursor and each pen-up swapped it
		// back. The class comes off when the pen leaves (onPenLeave), not
		// when it touches down.
		this.concealPenCursor();
		this.penCursorClient = null;
		// The only layout reads on the whole stroke happen here, once. From
		// here the frame is frozen until pen-up.
		this.frame.end();
		// The band is deliberately NOT moved here. The sample this was handed
		// was already mapped by the router against the box as it stands, and
		// moving it now would leave that ONE point in a different coordinate
		// frame from every sample that follows - which draws as a straight
		// line from nowhere into the stroke (alan, hardware: writing near the
		// bottom of a page, where the end-of-document clamp makes the move a
		// large one). Nothing is lost by leaving it: the band is guaranteed to
		// cover the viewport at every scroll position that has been checked,
		// and pen-down does not move the viewport.
		this.syncCamera();
		this.router?.refreshRect();
		this.frame.begin();
		if (isPenProbeEnabled()) this.captureProbeGeometry();
		this.recordPenDownState(sample);

		// A gesture is starting, whichever one: the strip steps aside and its
		// drop-down chrome closes. This sat in the ink branch alone, so the
		// toolbar stayed put under an eraser and covered the ink being
		// rubbed out (alan, 2026-08-27). penUp restores it for every gesture
		// already, so only the hide was one-sided. Shared with the pdf
		// surface (StripPenChrome.ts, §5o) so the two cannot diverge again.
		stripPenDown(this.mobileTools, this.noteZoomControls);

		// The pen decides what it is at contact (§52/§53, mode-free):
		// eraser end erases, side button held lassos/moves, tip inks - and
		// each of those meanings also has a strip mode, for hardware that has
		// neither button. The whole arbitration is `penContactIntent`
		// (TipMode.ts), ONE implementation shared with the pdf surface, which
		// had its own hand-written copy of these three lines. It answers with
		// the mode too, so the pan and space branches further down read the
		// same value rather than re-asking `tipMode()` behind their own
		// `!eraser` guards.
		// Before the branches, so the three in-gesture reticle wrappers can
		// read it whichever gesture this turns out to be - the pdf writes its
		// own in the same place, ahead of its own `penContactIntent` call.
		this.mouseStroke = ev.pointerType === "mouse";
		const intent = penContactIntent(ev.buttons, ev.button, tipMode());
		const eraser = intent === "erase";
		if (intent === "lasso") {
			this.mode = "lasso";
			this.lassoDown(sample);
			return;
		}
		// A bare tip landing INSIDE an active selection drags it - OneNote's
		// grammar (alan, 2026-08-27): the side button selects, then either
		// the tip or the held side button moves. Outside, the tip dissolves the
		// selection and inks, same as always. Esc backs out without a move.
		//
		// BARE is the load-bearing word and the test below did not carry it:
		// an eraser is not a bare tip, so it must not be swallowed here. Left
		// out, the ink a user had just lassoed was the one ink on the page the
		// eraser could not reach - it dragged the selection instead, on every
		// contact, with no way out but dismissing the selection first. The
		// rule was already written three lines down ("Tip and eraser return
		// the pen to normal behavior"); only the code disagreed with it.
		if (ev.pointerType !== "touch" && !eraser && !this.selection.isEmpty) {
			const w = this.camera.screenToWorld(sample.x, sample.y);
			const bounds = this.selectionBounds();
			if (
				bounds &&
				pointInBBox(w.x, w.y, padBBox(bounds, visualToNote(SELECTION_GRAB_PAD, this.scale)))
			) {
				this.mode = "lasso";
				this.lassoDown(sample);
				return;
			}
		}
		// Tip and eraser return the pen to normal behavior: selection dissolves.
		if (this.selection.clear()) this.redrawSelectionUI();
		if (eraser) {
			this.mode = "erase";
			this.erased = [];
			// The list as it stands BEFORE the gesture. Indices for the undo
			// op are taken against this at pen-up, not against the list as it
			// is being emptied: takeLive reports each stroke's position in
			// whatever the list held at that instant, so the second stroke a
			// drag crossed recorded a position already short by the first,
			// and undoing a multi-stroke erase put the ink back at the wrong
			// depth. The op's indices have to name one stable list, and the
			// only one that means anything to `replace` is the pre-gesture
			// one. This is the note surface's version of what
			// PdfInkController.recordErase does with eraseFrom.
			const here = this.filePath();
			this.eraseFrom = here ? [...inlineInk.strokes(here)] : [];
			this.eraseHistoryIdentity = here ? inlineInk.captureHistoryIdentity(here) : null;
			if (this.eraseFrom.length === 0) {
				// A gesture that touches nothing is indistinguishable from a
				// broken one - the same lesson insert-space paid an evening of
				// hardware testing to learn. This page has no ink at all, so
				// the whole gesture is guaranteed to find nothing, whichever
				// way the eraser moves; say so once, right here, rather than
				// leaving the eraser to look dead for however long it drags.
				//
				// ONCE PER PAGE, not once per contact, and only when the store
				// is CERTAIN the page is empty. An empty `eraseFrom` used to
				// be treated as proof of both, and it is proof of neither: an
				// eraser scrub re-lands the nib every few hundred ms (each
				// re-land a fresh pointerdown, and so a fresh toast), and a
				// note whose sidecar has not been read yet holds zero strokes
				// here while showing ink on screen. Both halves of Alan's
				// 1.4.12 report - the spam, and "even though there is" - are
				// in this one line; the rules are in EmptyPageNotice.ts and
				// `InlineInkStore.inkPresence`.
				this.sayIfPageEmpty(here, "erase");
			}
			// Stroke or reticle is a property of the ERASER, whichever way
			// it was reached (eraser end or the mode). The radius still
			// decides what counts as touched either way.
			this.eraseWhole = eraserWholeStrokes;
			metrics.begin("erase", performance.now(), this.tail?.resizeTotal);
			this.startFrameTicker();
			this.showEraserCursor(sample);
			this.eraseAt(sample);
			return;
		}
		if (intent === "pan") {
			this.mode = "pan";
			// A pan MOVES the surface under the ink, so the frame must stay
			// live: the lock exists to stop reflow shearing a stroke, and
			// here there is no stroke - freezing it would leave the ink
			// behind the scroll until pen-up.
			this.frame.cancel();
			this.panLast = { x: ev.clientX, y: ev.clientY };
			// NO RETICLE THROUGH A PAN, unlike the eraser and the lasso above.
			// The ring used to be driven from here and from every raw batch,
			// and it flung itself away from the nib as the drag went on
			// (alan, 2026-09-05, hardware: "pan reticle allows you to like
			// fling it away from the point of pan and it flickers"). The whole
			// mechanism, and the rule that replaced it, is written down once
			// at `penReticleShown` (PenCursor.ts); the short version is that a
			// pan is the one gesture that scrolls the overlay out from under
			// the frozen rect its samples are mapped through, so there is no
			// coordinate here worth painting. The grabbing hand says what the
			// ring was there to say.
			this.beginPanDragCursor();
			return;
		}
		if (intent === "space") {
			this.mode = "space";
			this.spaceDown(sample, ev);
			return;
		}
		this.mode = "ink";
		metrics.begin("ink", performance.now(), this.tail?.resizeTotal);
		this.startFrameTicker();
		// Bind the nib once: the raw loop never asks which tool is active.
		const tool = inlineTool;
		this.activeStyle = tool === "highlighter" ? this.highlighterStyle : this.penStyle;
		// Nib size and color: bound per stroke from the current selection.
		// The stroke stores both, so later selection changes never touch it.
		this.activeStyle.baseWidth =
			(tool === "highlighter" ? HIGHLIGHTER_PEN.baseWidth : DEFAULT_PEN.baseWidth) *
			getInkSizeMult(tool);
		this.activeStyle.color = getInkColorHex(tool);
		const fromMouse = this.mouseStroke;
		const fromFinger = ev.pointerType === "touch";
		const widthMode: StrokeWidthMode | undefined = fromFinger ? "uniform" : undefined;
		const widthPolicy = strokeWidthPolicy(this.activeStyle, widthMode);
		this.activeStyle = widthPolicy.style;
		// Same split as showPenCursor: the strip appears for any stroke, but
		// only a real pen proves the tip inks without mouse ink. A mouse
		// stroke reaches here whenever mouse ink is armed, and marking that
		// as hardware is the second of the two writers that left the nib
		// light stuck on. The iPhone finger reaches this same ink path now,
		// but it proves neither pen hardware nor mouse intent and marks neither.
		if (ev.pointerType === "pen") markPenHardwareSeen();
		else if (ev.pointerType === "mouse") markPenSeen();
		this.ensurePenTools();
		// The strip stepped aside at contact, above; a strip only just created
		// by ensurePenTools has not heard that yet, so tell it now.
		// stripPenDown, not a bare setInking: closeInkSliders is a no-op on a
		// strip that was just built (nothing on it can be open yet), so
		// calling the pair again here is exactly today's behaviour.
		stripPenDown(this.mobileTools, this.noteZoomControls);
		// Before the first wet pixel, in this task: the stroke must land on a sized layer.
		if (tool === "highlighter") this.allocateHighlightPair();
		else this.allocateWet();
		this.activeWet = tool === "highlighter" ? this.highlightWet : this.wet;
		// The dot, the head and the predicted tail are this stroke drawn on the
		// tail canvas; a highlighter's must wear its wash there too, or an
		// opaque disc rides the tip over the text until the pen lifts.
		this.dressTail(tool === "highlighter");
		// The wet layer's shaping follows the device per stroke: a mouse
		// stroke draws flat live, exactly as it will commit.
		// The same question `mouseStroke` was just asked, read back rather than
		// re-derived: two spellings of one fact in one method is how they come
		// apart.
		this.wet.shape = widthPolicy.shapeWidth && !fromMouse;
		// A mouse's constant 0.5 is neither evidence about the pen hardware
		// nor something to amplify: gain 1, and its max is never reported.
		this.strokeGain = fromMouse || fromFinger ? 1 : strokeGain();
		this.strokeRawMax = 0;
		this.strokePenGesture = !fromMouse && !fromFinger;
		this.rawLastMoveT = sample.timestamp;
		this.rawLastMoveX = sample.x;
		this.rawLastMoveY = sample.y;
		// Prediction never carries across strokes: extrapolating a new stroke
		// from the tail of the last one would guess a direction from a pen
		// that has been lifted and put down somewhere else.
		this.predReal = [];
		this.predLastTail = [];
		this.builder = new StrokeBuilder(
			tool,
			this.activeStyle.color,
			this.activeStyle.baseWidth,
			undefined,
			fromMouse ? "mouse" : undefined,
			widthMode
		);
		// Device px per world unit: the screen's device px per CSS px times the
		// camera's CSS px per world unit (font zoom rides on the camera). A mouse
		// stroke passes no grid.
		const dpr = this.view?.dom?.ownerDocument?.defaultView?.devicePixelRatio || 1;
		this.builder.start(sample.timestamp, fromMouse ? undefined : coarseGridFor("note", ev.pointerType, dpr, dpr * this.camera.zoom));
		const w = this.camera.screenToWorld(sample.x, sample.y);
		const point = this.builder.add(
			w.x,
			w.y,
			this.gainedPressure(sample.pressure),
			sample.timestamp,
			sample.tiltX,
			sample.tiltY
		);
		if (point) {
			// The tool's flatness travels with the stroke. Inferring it from
			// the layer's `shape` made every MOUSE stroke look flat, so mouse
			// ink drew smoothed and committed raw whenever the setting was
			// off - the case the line above exists to protect.
			this.ribbonPressure = point.pressure;
			this.activeWet.beginStroke(point, this.activeStyle, tool === "highlighter", this.builder.resolvedPressureProfile);
			// A tap that never moves produces no rawupdate, so without this the
			// dot only appears at pen-up. Draw the contact point immediately.
			//
			// This is the ONE head draw that is not gated on `head()`, so for
			// a tap it is the whole visible mark - which is why it asks for
			// `contactHalfWidth` and not the bare live width. The floor lives
			// in there; nothing about it is computed here.
			const contactHalfWidth = this.activeWet.contactHalfWidth(this.activeStyle, point.pressure);
			this.tail.clear();
			this.tail.prepareLive({
				cam: this.camera.snapshot, style: this.activeStyle,
				from: { x: point.x, y: point.y }, to: { x: point.x, y: point.y },
				pressure: point.pressure, hwWorld: contactHalfWidth,
			}, null);
			this.tail.drawHead(
				this.camera.snapshot,
				this.activeStyle,
				{ x: point.x, y: point.y },
				{ x: point.x, y: point.y },
				point.pressure,
				contactHalfWidth
			);
			this.probeSample(sample, ev, point, 1, true, "down");
		}
		this.beginSnapPreview(sample, ev);
		noteProbeStroke();
	}

	/** The builder and note are captured once; a stale timer cannot follow either. */
	function beginSnapPreview(this: InkOverlayPlugin, sample: Pick<PenSample, "x" | "y">, ev: PointerEvent): void {
		this.clearSnapPreview();
		if (!shapeSnapOn || ev.pointerType !== "pen" || !this.strokePenGesture || !this.builder || !this.container) return;
		const builder = this.builder;
		const path = this.filePath();
		if (!path) return;
		const tool = inlineTool;
		const color = getInkColorHex(tool);
		const size = getInkSizeMult(tool);
		this.snapContactId = ev.pointerId;
		this.snapCanvas ??= new SnapPreviewCanvas();
		this.snapPreview = new SnapPreview({
			clock: this.winRef,
			valid: () => shapeSnapOn && this.builder === builder && this.strokePenGesture && this.mode === "ink" &&
				this.filePath() === path && !!this.container && inlineTool === tool &&
				getInkColorHex(tool) === color && getInkSizeMult(tool) === size,
			snapshot: () => builder.snapshotReleaseFiltered(),
			show: stroke => !!this.container && this.snapCanvas!.show(this.container, this.camera.snapshot,
				stroke, this.cssWidth, this.cssHeight, this.backingNow()),
			hide: () => this.snapCanvas?.clear(),
		});
		this.snapPreview.start(sample.x, sample.y);
	}

	function clearSnapPreview(this: InkOverlayPlugin): void {
		this.snapPreview?.clear();
		this.snapPreview = null;
		this.snapContactId = null;
		this.snapCanvas?.clear();
	}

	function penRaw(this: InkOverlayPlugin, samples: PenSample[], ev: PointerEvent): void {
		if (this.mode === "lasso") {
			this.lassoMove(samples);
			// Last sample only, matching the erase branch below: one DOM
			// write per batch, and every call re-arms the watchdog for the
			// length of the drag.
			const last = samples[samples.length - 1];
			if (last) this.showLassoCursor(last);
			return;
		}
		if (this.mode === "space") {
			this.spaceMove(samples);
			// Last sample only, same reasoning as lasso and erase.
			const last = samples[samples.length - 1];
			if (last) this.showSpaceCursor(last);
			return;
		}
		if (this.mode === "pan") {
			// SCROLLS AND NOTHING ELSE. Unlike the lasso and space branches
			// above, this handler positions no reticle - it is the handler
			// that made the ring fly, because `samples` are mapped through the
			// rect the router froze at pen-down and this line is what scrolls
			// the overlay out from under it. `penReticleShown` (PenCursor.ts)
			// carries the reasoning and Alan's rule; `GestureReticlePersists.test.ts`
			// drives a real pan drag and fails if the ring paints mid-drag.
			this.panMove(ev);
			return;
		}
		if (this.mode === "erase") {
			for (const s of samples) this.eraseAt(s);
			const last = samples[samples.length - 1];
			if (last) this.showEraserCursor(last);
			return;
		}
		if (!this.builder || samples.length === 0) return;
		const t0 = performance.now();
		metrics.recordEvent("raw", samples.length, t0 - ev.timeStamp, true);
		const cam = this.camera.snapshot;
		const drawStart = performance.now();
		let accepted = 0;
		let lastAccepted: { x: number; y: number } | undefined;
		for (const s of samples) {
			this.snapPreview?.move(s.x, s.y);
			if (Math.hypot(s.x - this.rawLastMoveX, s.y - this.rawLastMoveY) > 4) {
				this.rawLastMoveT = s.timestamp;
				this.rawLastMoveX = s.x;
				this.rawLastMoveY = s.y;
			}
			const w = this.camera.screenToWorld(s.x, s.y);
			const point = this.builder.add(
				w.x,
				w.y,
				this.gainedPressure(s.pressure),
				s.timestamp,
				s.tiltX,
				s.tiltY
			);
			if (point) {
				this.ribbonPressure = point.pressure;
				this.activeWet.appendPoint(cam, this.activeStyle, point);
				lastAccepted = point;
				accepted++;
			}
		}
		const drawEnd = performance.now();
		const newestTs = samples[samples.length - 1]!.timestamp;
		metrics.recordAccepted(accepted);
		metrics.recordDraw(drawEnd - drawStart, drawEnd - newestTs);

		// Live raw head, exactly as the approved pipeline draws it - and at
		// the width the ribbon under it is being laid down at, which the wet
		// layer reports rather than the head guessing from raw pressure.
		const head = this.activeWet.head();
		let prediction: { fromX: number; fromY: number; points: readonly PenSample[]; lineWidthPx: number } | null = null;
		if (predictionEnabled()) {
			this.predReal.push(...samples);
			if (this.predReal.length > PRED_HISTORY) {
				this.predReal.splice(0, this.predReal.length - PRED_HISTORY);
			}
			prediction = this.planPredictedTail(ev, cam);
		}
		const liveHead = head ? {
			cam, style: this.activeStyle, from: head.from, to: head.to,
			pressure: head.pressure,
			hwWorld: this.activeWet.liveHalfWidth(this.activeStyle, head.pressure),
		} : null;
		this.tail.clear();
		this.tail.prepareLive(liveHead, prediction);
		if (head) {
			this.tail.drawHead(
				cam,
				this.activeStyle,
				head.from,
				head.to,
				head.pressure,
				liveHead!.hwWorld
			);
		}
		// The predicted tail goes on the same canvas, after the head, so the
		// one `clear()` above erases both: its dirty rect covers whatever was
		// drawn last event, whether that was real or a guess.
		if (prediction) this.tail.draw(prediction.fromX, prediction.fromY,
			prediction.points, this.activeStyle.color, prediction.lineWidthPx);
		// Probe AFTER the head is drawn: `head()` is then exactly the geometry
		// on screen, so the recorded endpoint is the rendered endpoint.
		if (isPenProbeEnabled()) {
			const newest = samples[samples.length - 1]!;
			this.probeSample(
				newest,
				ev,
				lastAccepted,
				samples.length,
				lastAccepted !== undefined,
				samples.length > 1 ? "coalesced" : "rawupdate"
			);
		}
		this.schedulePresentProbe(newestTs);
	}

	/**
	 * Draw a short disposable tail ahead of the newest real sample.
	 *
	 * Never added to the stroke: `builder.add` has already seen every real
	 * sample by the time this runs, and these points touch nothing but the
	 * transient canvas. A stroke saved mid-prediction is exactly the stroke
	 * that would have been saved without it.
	 *
	 * The scoring happens FIRST, against the tail drawn last event: the sample
	 * that just arrived is the ground truth for the guess made before it, and
	 * once `predLastTail` is overwritten that comparison is gone. It is what
	 * turns "does prediction overshoot on my handwriting" into a number in the
	 * ink metrics rather than an argument.
	 */
	function planPredictedTail(this: InkOverlayPlugin, ev: PointerEvent, cam: CameraState):
		{ fromX: number; fromY: number; points: readonly PenSample[]; lineWidthPx: number } | null {
		const real = this.predReal;
		const newest = real[real.length - 1];
		if (!newest) return null;
		if (this.predLastTail.length > 0) {
			const err = correctionError(this.predLastTail, newest);
			if (err !== undefined) metrics.recordCorrection(err);
		}
		const predicted = this.router?.predictedSamples(ev) ?? [];
		const mode = predicted.length > 0 ? "chromium" : "extrap";
		// Boox mode keeps its fixed e-ink horizon; everyone else gets one
		// sized from what this machine's own frames measured.
		const caps = predictionEinkOn() ? EINK_CAPS : adaptiveCaps(presentLagMs());
		const result = buildTail(real, predicted, mode, caps);
		metrics.setPrediction("on", result.source, caps.maxHorizonMs);
		this.predLastTail = result.points;
		if (result.suppressed || result.points.length === 0) {
			metrics.recordTailSuppressed();
			return null;
		}
		metrics.recordTail(result.points.length, result.horizonMs, result.tipDistPx);
		// Sample space IS canvas css px: a sample is the client offset from the
		// container divided by the css scale, and drawHead's own screen
		// arithmetic - (world - cam) * zoom - lands on the same number.
		return { fromX: newest.x, fromY: newest.y, points: result.points,
			// The width the ribbon is actually laying down, not one derived
			// from raw pressure: with shaping on those differ by a lot at
			// speed, and the tail was drawing the fatter of the two.
			//
			// `ribbonPressure`, not `newest.pressure`: the ribbon is fed
			// `gainedPressure`, so raw pressure is an input it never saw and
			// the two disagree wherever the gain is not 1. The argument is
			// dead on the shaped branch - `liveHalfWidth` returns
			// `shaper.last()` there - so what this corrects is the UNSHAPED
			// branch: every mouse stroke and every highlighter.
			lineWidthPx: this.activeWet.liveWidthPx(cam, this.activeStyle, this.ribbonPressure) };
	}

	/**
	 * While a stroke's frame ticker runs, the probe rides it: the tick reads
	 * the present age on the next frame, so the frame pays one callback, not
	 * two that neither draw. Outside a ticking stroke it asks for its own.
	 */
	function schedulePresentProbe(this: InkOverlayPlugin, newestTs: number): void {
		if (this.presentProbePending) return;
		this.presentProbePending = true;
		if (this.frameTicking) {
			this.presentProbeTs = newestTs;
			return;
		}
		this.winRef.requestAnimationFrame(() => {
			this.presentProbePending = false;
			const presentAge = performance.now() - newestTs;
			recordPresentAge(presentAge);
			metrics.recordPresent(presentAge);
		});
	}

	/**
	 * What syncCamera WOULD produce right now, without touching the camera.
	 * Read-only diagnostic twin of syncCamera: while frameLocked freezes the
	 * stroke's frame, the difference between this and the live camera is the
	 * exact on-screen displacement of the ink layer relative to the document.
	 *
	 * Through `anchorTop`, for the same reason every other word here says
	 * "twin": a diagnostic that took its y from a different anchor than the
	 * camera does would report a displacement of the padding on the one frame
	 * where the two numbers disagree, and there is nothing displaced there.
	 */
	function freshFrame(this: InkOverlayPlugin): { x: number; y: number } | null {
		if (!this.container) return null;
		const overlay = this.container.getBoundingClientRect();
		const origin = contentOrigin(this.view.contentDOM);
		const contentLeft = this.resolveColumnLeft(this.unpanX(origin.left));
		// The twin reads the anchor the same way and RE-PLACES NOTHING: a
		// read-only diagnostic that moved the probe would be a write.
		const anchor = this.anchorCameraY(overlay.top);
		const documentTopPanned = anchor ? anchor.impliedTop : anchorTop(this.view, this.contentStyle?.paddingTop, this.cssScale);
		const layoutColumn = this.ownedColumnLayoutLeft(origin.line);
		return {
			x: (layoutColumn === null ? visualToNote(origin.left === null ? overlay.left - contentLeft : (overlay.left - origin.left) + this.panX(), this.scale) : (this.band!.left - layoutColumn) / this.fontZoom) - (this.rasterPan?.x ?? 0) / this.fontZoom,
			y: this.canonicalCameraY(anchor
				? anchor.layout / this.fontZoom - (this.rasterPan?.y ?? 0) / this.fontZoom
				: visualToNote((overlay.top - documentTopPanned) + this.panY(), this.scale) - (this.rasterPan?.y ?? 0) / this.fontZoom, false),
		};
	}

	/**
	 * E's Y origin from the anchor probe, or `null` to fall back.
	 *
	 * ONE rect read, replacing the `.cm-content` rect read `anchorTop` would
	 * have done, so the layout-read count per sync is unchanged. Read-only:
	 * the re-placement is a separate call the twin does not make.
	 */
	function anchorCameraY(this: InkOverlayPlugin, overlayTop: number): { layout: number; rung: number; impliedTop: number } | null {
		// Z10: on a css-zoom host `anchorTop` is already exact, and the ladder is
		// what moves the camera. See `anchorTopExactOnZoomHost`.
		if (this.anchorTopExactOnZoomHost(overlayTop)) return null;
		const held = documentAnchorLadder(this.view);
		if (!held) return null;
		// The wrapper sits at `.cm-content`'s BORDER-BOX top, so the document's
		// own padding edge is this much lower. Shared with `anchorTop` so the two
		// agree bit-for-bit; `null` means give up and let `anchorTop` answer.
		const padding = anchorPaddingTop(this.view, this.contentStyle?.paddingTop, this.cssScale);
		if (padding === null) return null;
		// WHICH RUNG, arithmetically and with no layout read of its own: where
		// the camera was left last sync, or - on the very first one - the scroll
		// offset. A wrong answer costs distance and never correctness.
		const from = Number.isFinite(this.anchorCameraYLayout) ? this.anchorCameraYLayout : this.view.scrollDOM.scrollTop;
		const k = rungIndexFor(from, held.spacing, held.rungs.length);
		const rungTopLayout = k * held.spacing;
		const rungRectTop = held.rungs[k]!.getBoundingClientRect().top;
		const layout = cameraOriginYLayout(rungTopLayout, overlayTop, rungRectTop, this.panY(), this.cssScale, padding);
		if (layout === null) return null;
		return { layout, rung: k, impliedTop: impliedDocumentTop(rungTopLayout, rungRectTop, this.cssScale, padding) };
	}

	/** One scroll-probe row per acquisition: everything the mapping read. */
	function recordPenDownState(this: InkOverlayPlugin, sample: PenSample): void {
		this.scrollsDuringStroke = 0;
		if (!diagnosticsEnabled()) return;
		const scroller = this.view.scrollDOM;
		const w = this.camera.screenToWorld(sample.x, sample.y);
		scrollProbePenDown({
			clientX: this.lastSyncRectLeft + noteToVisual(sample.x, this.cssScale),
			clientY: this.lastSyncRectTop + noteToVisual(sample.y, this.cssScale),
			noteX: w.x,
			noteY: w.y,
			scrollLeft: scroller.scrollLeft,
			scrollTop: scroller.scrollTop,
			rectLeft: this.lastSyncRectLeft,
			rectTop: this.lastSyncRectTop,
			cssW: this.cssWidth,
			cssH: this.cssHeight,
			camX: this.camera.x,
			camY: this.camera.y,
			scale: this.scale,
			spacerLeft: this.spacerLeft,
			spacerTop: this.spacerTop,
			axisPatched: this.axisGuard.patched,
			scrollWidth: scroller.scrollWidth,
			scrollHeight: scroller.scrollHeight,
			clientWidth: scroller.clientWidth,
			clientHeight: scroller.clientHeight,
		});
	}

	/** Adaptive gain, then the existing clamp; tracks the raw per-stroke max. */
	function gainedPressure(this: InkOverlayPlugin, raw: number): number {
		if (Number.isFinite(raw) && raw > this.strokeRawMax) this.strokeRawMax = raw;
		return normalizeInlinePenPressure(raw * this.strokeGain);
	}

	/**
	 * `ev` is the pointerup/pointercancel that ended the gesture, ABSENT when
	 * it ended without one (`finishActiveStroke`: a window blur, a note
	 * switch). This call site used to drop it - `onPenUp: () => this.penUp()`
	 * - and the pan branch needs it: the one place the pointer's CURRENT
	 * position exists at release is that event. A blur has no lift and no
	 * position, which is what `undefined` says, and nothing is synthesised in
	 * its place (the callback's own header, InlinePenRouter.ts, argues that at
	 * length for the pdf's final stroke point).
	 */
	function penUp(this: InkOverlayPlugin, ev?: PointerEvent): void {
		// `> 0`, not the field alone: a unit rig built with Object.create never runs the initialiser.
		const reserveBefore = this.leftReserveHeld > 0 ? this.leftReserveHeld : 0;
		this.endPenGesture(ev);
		// A canvas-off reset refused while this contact owned the frame. The
		// retry at the top of endPenGesture serves the gestures that hold no
		// stroke builder; an ink stroke's builder is cleared only once its
		// strokes are finished, and the retry refuses while one is set. Here
		// every branch is done, and the page is at 100 percent before any
		// stranded pan resumes below.
		this.retryCanvasOffReset();
		// Alan: nothing moves unless the page is past its edge, then it eases
		// back - no infinite blank standing forever. A pen that catches a bounce mid-flight and draws holds
		// the page still for the stroke (the fold, unchanged); after it lifts, a page still standing past
		// its bound resumes the same way the touch side does. A page already inside its room has nowhere to
		// ease to, so this is a no-op for it - OverscrollBounce.test.ts's "PEN DOWN MID-BOUNCE" row now
		// asserts both regimes.
		// AFTER the gesture's own work, on every branch, so the resume reads the world the extent pass left:
		// a stroke left of the page lands its left reserve in that pass, and the room it opens is what the
		// resume pays the standing pan into. Run before it, the resume saw no reserve and no scroll and eased
		// the page to the old edge, hiding the stroke it had just made room for.
		this.resumeStrandedPan();
		// THE COMMITTED LAYER FOLLOWS THE RESERVE IN THE SAME FRAME. The stroke was drawn on it at the camera from
		// before the reserve, and the reserve then shifted the layer with the column, so until the next frame's
		// repaint the new stroke showed about R * k left of the pen - measured about 400 px at 10%. Only when the
		// reserve moved; `repaint` here is the one the queued frame would have run, with the resume already applied.
		if ((this.leftReserveHeld > 0 ? this.leftReserveHeld : 0) !== reserveBefore) {
			this.damage.addAll();
			this.repaint();
		}
	}

	/** Everything a pen lift does before the page may resume: the gesture's branches, each ending in its extent pass. */
	function endPenGesture(this: InkOverlayPlugin, ev?: PointerEvent): void {
		// Whatever the gesture was, it is over: the frame is live again and
		// re-reads the editor's current origin.
		this.frame.end();
		// A canvas-off reset refused while this stroke owned the frame runs now.
		this.retryCanvasOffReset();
		// A font reference adoption held through this contact: a gesture that
		// leaves no stroke takes it now; the ink branch below takes it after
		// its strokes are finished, so it can move them with it.
		if (this.mode !== "ink") this.releaseHeldFontRef();
		// Complete a band update skipped while the contact froze its geometry.
		if (this.bandSyncDeferred) {
			this.bandSyncDeferred = false;
			this.scheduleRepaint("scroll");
		}
		// And a pane resize the zoomed layout skipped for the same reason.
		this.replayDeferredResize();
		if(this.viewportStyleDirty)this.scheduleViewportStyleRefresh();
		// The stroke is over: the strip returns (a beat later, so an eraser
		// scrub's rapid lift-and-reland does not strobe it) and its buttons
		// catch up with what undo can do now. The catch-up is a microtask,
		// NOT immediate: every branch below this line dispatches its ops
		// later in this same method, so a synchronous refresh here reads the
		// history depth from BEFORE the gesture - after the first stroke on
		// a fresh note, a working undo button kept wearing the disabled look
		// that issue #1 was filed about. The microtask runs once penUp and
		// all its dispatches have returned, whichever branch they took.
		// Shared with the pdf surface (StripPenChrome.ts, §5o).
		stripPenUp(this.mobileTools, this.noteZoomControls);
		// The stranded pan resumes in `penUp`, after this method returns.
		// A give paused for the stroke eases on to the cap now that the pen is up.
		if (this.pinchGive?.paused) this.resumePinchGive();
		if (this.mode === "pan") {
			// The mode goes back FIRST, before the reticle is restored below:
			// `showPenCursor` refuses to paint while `mode` says a pan drag is
			// live (`penReticleShown`), which is the whole point of that gate.
			this.mode = "ink";
			this.panLast = null;
			// Takes the grabbing hand off with it - `hidePenCursor` drops both
			// scroller classes - so the surface is left in exactly the state a
			// hover would find it in, and the restore below puts the ring back
			// under the pointer.
			this.hidePenCursor();
			this.restoreReticleAfterPan(ev);
			this.updateExtent(true);
			return;
		}
		if (this.mode === "space") {
			this.mode = "ink";
			// The preview goes without a draw of its own: every way out of spaceUp draws the selection layer, and dropping it
			// in hideSpaceCursor drew the layer a first time.
			this.clearSpaceFeedback(false);
			// Same reasoning as pan above.
			this.hideSpaceCursor();
			this.spaceUp();
			this.updateExtent(true);
			return;
		}
		if (this.mode === "lasso") {
			this.mode = "ink";
			// Same reasoning as pan and space above.
			this.hideLassoCursor();
			this.lassoUp();
			this.updateExtent(true);
			return;
		}
		if (this.mode === "erase") {
			this.mode = "ink";
			metrics.end(performance.now(), this.tail?.resizeTotal);
			this.stopFrameTicker();
			this.hideEraserCursor();
			const erased = this.erased;
			const eraseFrom = this.eraseFrom;
			this.erased = [];
			this.eraseFrom = [];
			this.eraseHistoryIdentity = null;
			const path = this.filePath();
			if (erased.length === 0 || !path) return;
			// One persist per gesture, at pen-up. Never on the erase hot path.
			inlineInk.save(path);
			// What survived the gesture, at the positions it now occupies.
			const inserted: InkStroke[] = [];
			const insertedAt: number[] = [];
			inlineInk.strokes(path).forEach((st, i) => {
				if (this.erasePieces.has(st.id)) {
					inserted.push(st);
					insertedAt.push(i);
				}
			});
			this.erasePieces.clear();
			const removed = erased.map((e) => e.stroke);
			const removedAt = eraseRemovalIndices(eraseFrom, erased);
			this.dispatchInk({
				type: "replace",
				path,
				removed,
				removedAt,
				inserted,
				insertedAt,
			});
			// The gesture is over and the splices are in. Not per sample:
			// mid-gesture the frontier can only shrink, and a stale LARGER
			// frontier only over-grants a scroll range that never shrinks
			// anyway. §5g/G1.
			this.frontierCache.invalidate(path);
			// The erase changed the note, so the extent raster no longer holds it; the gesture's own frames may not build one.
			// Ask the first repaint after the lift to arm a build, over the box of everything the gesture took, as the lasso
			// and space lifts do. Without it a wide erase zoomed out left later pans drawing by path.
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			for (const { stroke } of erased) {
				const b = this.lineAnchors.shownOf(stroke).bbox;
				x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
				x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
			}
			this.extentArmAsked = true;
			this.damage.addRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
			this.scheduleRepaint("partial");
			this.repaintPath(path);
			// The successful erase already explained why this note is empty.
			// Consume the episode after save/change notifications have settled.
			if (inlineInk.inkPresence(path) === "none") this.emptyNotice.claim(path, "erase");
			return;
		}
		metrics.end(performance.now(), this.tail?.resizeTotal);
		this.stopFrameTicker();
		const builder = this.builder;
		const wasPen = this.strokePenGesture;
		// Finish before clearing the wet layer. Release filtering may produce
		// several stored strokes from one contact, but every committed segment
		// is drawn underneath the still-visible wet pixels before they clear.
		if (this.strokePenGesture) observeStrokeMax(this.strokeRawMax);
		// A mouse's samples come through a moving average that lags the pointer
		// and is never flushed, so a dash released while moving ended short of
		// the release. The pointerup carries the real position: it is the
		// stroke's last point, as the pdf's addFinalPoint does (audit 98).
		if (builder && this.mouseStroke && ev?.type === "pointerup") {
			const at = this.router?.sampleAt(ev);
			if (at) {
				const w = this.camera.screenToWorld(at.x, at.y);
				// Builder only: the wet layer clears once the commit below has
				// drawn the stroke, release point included, underneath it.
				builder.add(w.x, w.y, this.gainedPressure(at.pressure), at.timestamp, at.tiltX, at.tiltY);
			}
		}
		// On a proven coarse grid each stored point is the mean of its raw sample
		// and the one before, so the stroke ended half its last step short of the
		// lift. The last raw sample is the stroke's last point.
		if (builder && !this.mouseStroke) {
			// Builder only: the wet layer clears once the commit below has
			// drawn the stroke, lift point included, underneath it.
			builder.flushRaw();
		}
		let strokes = builder?.finishReleaseFiltered() ?? [];
		const lift = !!ev && ev.pointerType === "pen" && ev.pointerId === this.snapContactId &&
			(ev.type === "pointerup" || ((ev.type === "pointermove" || ev.type === "pointerrawupdate") && silentLift(ev)));
		const visibleSnap = this.snapPreview?.take(strokes, lift) ?? null;
		this.clearSnapPreview();
		this.builder = null;
		this.strokePenGesture = false;
		// Hold the pen still at the end and the figure snaps to the clean
		// shape it meant (line, triangle, rectangle, circle, ellipse). The
		// dwell is the request; an ordinary lift never gets here.
		let snapReplaced: InkStroke | null = null;
		// A MOUSE'S snap, waiting to be asked for rather than taken. Set only
		// on the mouse branch below; the offer is made after the commit, since
		// what the chip replaces is the stroke that has already landed.
		let snapOffered: InkStroke | null = null;
		if (wasPen && visibleSnap && strokes.length === 1) {
			snapReplaced = strokes[0]!;
			strokes = [{ ...visibleSnap, createdAt: strokes[0]!.createdAt }];
		}
		// Mouse offers and finger input retain the existing release behavior.
		if (!wasPen && shapeSnapOn && strokes.length === 1) {
			// One clock: the last move is stamped from the samples, in the clock of
			// the note's own window, so the hold is read there too. The global
			// clock is the main window's, and in a popout its origin differs, so
			// every stroke read as held (audit 116).
			// Read defensively: unit rigs build the overlay with no view, or a
			// window stand-in with no clock.
			const clock = this.view?.dom?.ownerDocument?.defaultView?.performance ?? performance;
			const heldMs = clock.now() - this.rawLastMoveT;
			if (heldMs >= DWELL_MS) {
				const snapped = snapStroke(strokes[0]!, true);
				if (snapped) {
					// A MOUSE NEVER SNAPS ON ITS OWN. The dwell above is not
					// evidence of intent from a mouse: a mouse sits exactly
					// where it stopped while the button comes up, so an
					// ordinary deliberate stroke always clears DWELL_MS and
					// the figure was being replaced by one nobody asked for
					// ("it's correcting into a straight line", alan,
					// 2026-09-05). The same two facts - the hold and a fit the
					// recognizer will stand behind - become an OFFER instead.
					// SnapChip.ts carries the reasoning and the ruling; the
					// pen and the finger below are untouched by it.
					if (this.mouseStroke) {
						snapOffered = snapped;
					} else {
						// Kept for history: undo UN-SNAPS back to the freehand
						// (replace inverts to replace), a second undo removes.
						snapReplaced = strokes[0]!;
						strokes = [snapped];
					}
				}
			}
		}
		// A font reference adoption held through this contact runs before
		// anything is stored or painted. The finished strokes are in the frame
		// the contact began in; they move into the note's stored frame with
		// the rest of its ink, so the stroke lands where the wet ink showed it.
		const reframe = this.releaseHeldFontRef();
		if (reframe !== 1) {
			const moved = (s: InkStroke): InkStroke => {
				const copy = structuredClone(s);
				scaleStroke(copy, reframe);
				return copy;
			};
			strokes = strokes.map(moved);
			if (snapReplaced) snapReplaced = moved(snapReplaced);
			if (snapOffered) snapOffered = moved(snapOffered);
		}
		const stroke = strokes.at(-1);
		const path = stroke ? this.filePath() : null;
		// Paint ground truth, part 1: was the WET ink actually in the backing
		// store? Sampled over the stroke's screen bbox (clamped to canvas).
		let wetPx = -1;
		let sample = { x: 0, y: 0, w: 0, h: 0, clippedPct: 0 };
		// Before the live layers are cleared: whether this stroke drew into
		// the small live canvases or the full-size ones.
		if (diagnosticsEnabled()) this.probeStrokeLayers();
		if (diagnosticsEnabled() && stroke && path) {
			sample = this.strokeScreenSample(stroke);
			wetPx = this.activeWet.countPainted(
				sample.x,
				sample.y,
				sample.w,
				sample.h,
				this.backingNow()
			);
		}
		if (!stroke || !path) {
			// Every device clears the stroke's own box (see clearTransient below
			// for why the gate went, and why the tail keeps one).
			this.activeWet.clearStroke(this.cssWidth, this.cssHeight);
			this.tail.clear(this.cssWidth, this.cssHeight);
			this.tail.prepareLive(null, null);
			this.highlightWetCanvas.setCssStyles({ opacity: String(HIGHLIGHTER_ALPHA) });
			return;
		}
		handoffFinishedStroke({
			store: () => {
				const extentHeld = this.extentHoldsStore(path);
				// Each new stroke remembers the line under it, as laid out now.
				for (const s of strokes) this.lineAnchors.anchorNew(path, s);
				inlineInk.commitGesture(path, strokes);
				if (extentHeld) this.drawIntoExtent(path, strokes);
				// The index has to hear about the stroke, and the commit is
				// the one mutation that reaches this view's store without
				// passing through scheduleRepaint's full-repaint branch: it
				// paints straight onto the committed canvas below, and
				// repaintPath is every pane EXCEPT this one. Left unsaid,
				// eraseCandidates kept answering from an index that predates
				// the stroke, so eraseAt returned early on an empty hit list -
				// ink present at open erased, ink drawn since did not,
				// silently (user report, Android 1.4.6; not a 1.4.6
				// regression). Set beside the store call rather than after the
				// handoff so the mutation and its invalidation cannot drift.
				this.indexDirty = true;
				this.updateHandwritingPageClass();
			},
			// Paint underneath the still-visible wet layer. Long strokes can
			// take long enough to flatten that clearing the wet canvas first
			// produces a visible blank frame, especially over Moonlight. That
			// was sharpest while the wet layer was desynchronized, which it no
			// longer is (see INLINE_DESYNCHRONIZED); the ordering is kept
			// because painting before clearing is right either way.
			//
			// That works because pen ink is OPAQUE: the same pixels land twice
			// and nobody can tell. The highlighter is not - both its canvases
			// carry opacity 0.35, so an overlap composites two translucent
			// copies of one stroke into something much darker, and a quick
			// series of strokes strobes (alan, 2026-08-27). Taking the wet
			// element out of the composite in the SAME frame the committed
			// stroke lands keeps the atomicity without the double-paint: the
			// style write and the draw are presented together, and the
			// desynchronized canvas cannot show what it is no longer showing.
			drawCommitted: () => {
				// A stroke can commit while a pinch preview is live - a pen
				// landing during a touch pinch, or a preview left standing by a
				// lost end event. This path writes the committed canvas WITHOUT
				// going through `repaint`, so nothing here would otherwise drop
				// the preview offset or invalidate its anchor.
				//
				// It is drawn at the CURRENT camera, which already accounts for
				// where the column is now, so the layer's translation would put
				// it dx away from the pen - permanently, since the pixels are
				// committed. Clearing that translation first is therefore not
				// optional.
				//
				// And clearing alone is not enough: the loop below draws only
				// `strokes`, while the rest of the layer still holds pixels
				// rasterised when the translation WAS in force. So ask for a
				// full frame as well, and let repaint's own guard re-latch the
				// anchor. One frame of inconsistency against a stroke that
				// would otherwise sit wrong until the gesture ended.
				// UNDER THE HOLD (D-COV, AD-4 i) the stroke is drawn at the camera
				// the raster already has, so it lands consistently with every
				// other pixel under the same translation; nothing is cleared,
				// invalidated or re-rastered. The paragraph above describes the
				// re-base this replaced (2026-09-13: it culled the panned-in ink).
				const paintCam = this.pinchPreview && this.lastPaintCam ? this.lastPaintCam : this.camera.snapshot;
				if (this.activeWet === this.highlightWet) {
					this.highlightWetCanvas.setCssStyles({ opacity: "0" });
				}
				for (const finished of strokes) {
					this.markCommittedPaint(finished.tool);
					drawStroke(
						this.committedCtxFor(finished.tool),
						paintCam,
						finished,
						undefined,
						true,
						undefined,
						committedFloorFor(this.committedBacking, this.dpr)
					);
				}
			},
			clearTransient: () => {
				// The wet layer clears the stroke's OWN BOX on every device.
				//
				// This used to be Boox-only, "until an e-ink user has confirmed
				// the box on hardware". Nobody on this project has an e-ink
				// device, so that confirmation was never going to arrive, and
				// the whole-canvas clearRect stayed on the default path where
				// it damages the entire canvas once per pen-up. What replaced
				// the confirmation is a pixel proof: every one of the four
				// `appendPoint` branches, over four path shapes, at both zooms,
				// both device pixel ratios and both pens' width laws - 128
				// cases - drawn in real Chromium and read back EXHAUSTIVELY
				// (every pixel, no stride) leaves nothing behind, each against
				// a paired control that does leave a rim. See
				// `test/measure/WetClearBox.test.ts`. `clearStroke` also falls
				// back to clearing everything when it has no box or a NaN one,
				// so the failure mode is the old behaviour, not stale ink.
				//
				// The TAIL takes its dirty rect here too, and for the same
				// reason - leaving it on `clearAll` would have kept a
				// whole-canvas damage per pen-up on the layer above, which
				// defeats most of the change below it. It has its own proof
				// (`test/measure/TailClearBox.test.ts`): the head and the
				// head-plus-prediction states are erased completely by the
				// dirty rect at both zooms and both device pixel ratios.
				//
				// It is conditional on the FALLBACK. The two classes were not
				// symmetric: `clear()` was `if (!this.dirty) return;`, and
				// three paths here paint and then null the box without leaving
				// one - so against a nulled box it erased nothing at all. It
				// now falls back to the whole canvas when handed a size, which
				// is why a size is handed to it here and not on the per-event
				// callers. See `TailRenderer.clear`.
				this.activeWet.clearStroke(this.cssWidth, this.cssHeight);
				this.tail.clear(this.cssWidth, this.cssHeight);
				this.tail.prepareLive(null, null);
				// Cleared, so it is safe to be visible again for the next
				// stroke. Restoring here rather than on the next pen-down
				// keeps the element's resting state honest.
				if (this.activeWet === this.highlightWet) {
					this.highlightWetCanvas.setCssStyles({ opacity: String(HIGHLIGHTER_ALPHA) });
				}
			},
			publishHistory: () => {
				if (snapReplaced) {
					// Two steps, isolated from each other: the stroke landing
					// and the snap over it. One op could not express both, and
					// undo used to strand the un-snapped freehand.
					const at = inlineInk.strokes(path).length - 1;
					for (const op of snapHistoryOps(path, snapReplaced, strokes, at)) {
						this.dispatchInk(op);
					}
				} else {
					this.dispatchInk({ type: "add", path, strokes });
				}
			},
		});
		// The mouse's offer, made only now: the chip replaces a stroke that is
		// already in the note and already in the history, which is the whole
		// difference between it and the pen's dwell snap. `stroke` is that
		// stroke - `strokes` was left exactly as drawn on this branch.
		if (snapOffered) this.offerSnapChip(path, stroke, snapOffered);
		// Diagnostics (explicitly enabled only): paint ground truth part 2
		// (did the commit draw reach the committed backing store?), plus the
		// frame-desync measure and the COMMIT trace row. Ordinary writing
		// skips every readback and layout read in this block.
		if (diagnosticsEnabled()) this.recordCommitDiagnostics(stroke, path, wetPx, sample);
		this.scrollsDuringStroke = 0;
		// Presentation-probe target: NOTE-space bbox (pen-width padded) plus
		// identity, so later probes can re-locate the ink under whatever
		// camera is current and verify the backing before judging anything.
		const pad = 4;
		this.lastCommitNote = {
			x: stroke.bbox.x - pad,
			y: stroke.bbox.y - pad,
			w: stroke.bbox.width + pad * 2,
			h: stroke.bbox.height + pad * 2,
		};
		this.lastCommitPath = path;
		this.lastCommitId = stroke.id;
		this.lastCommitColor = stroke.color;
		this.lastCommitAt = performance.now();
		// A second pane on the same note shows the new ink too.
		this.repaintPath(path);
		this.updateExtent(true);
	}

	/**
	 * The part of the ink band the scroller shows, in the band's own css px.
	 * The band reaches up to a scroll margin past the pane on every side, so
	 * its own box is not what the reader can see. Two layout reads, once per
	 * snap offer; the whole band when either box has no size.
	 */
	function visibleBandArea(this: InkOverlayPlugin, band: HTMLElement): { left: number; top: number; width: number; height: number } {
		const whole = { left: 0, top: 0, width: this.cssWidth, height: this.cssHeight };
		const scroller = this.view.scrollDOM;
		const b = band.getBoundingClientRect(), s = scroller.getBoundingClientRect();
		const k = this.cssWidth > 0 ? b.width / this.cssWidth : 0;
		if (!(k > 0) || !(s.width > 0) || !(s.height > 0)) return whole;
		// The scroller's client box: inside its border, without its scrollbars,
		// in screen px (its own layout px times whatever scales it).
		const sx = s.width / (scroller.offsetWidth || s.width), sy = s.height / (scroller.offsetHeight || s.height);
		const x0 = s.left + scroller.clientLeft * sx, y0 = s.top + scroller.clientTop * sy;
		const left = Math.max(0, (x0 - b.left) / k), top = Math.max(0, (y0 - b.top) / k);
		const right = Math.min(this.cssWidth, (x0 + scroller.clientWidth * sx - b.left) / k);
		const bottom = Math.min(this.cssHeight, (y0 + scroller.clientHeight * sy - b.top) / k);
		if (!(right > left) || !(bottom > top)) return whole;
		return { left, top, width: right - left, height: bottom - top };
	}

export function installPenPath(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		penDown,
		beginSnapPreview,
		clearSnapPreview,
		penRaw,
		planPredictedTail,
		schedulePresentProbe,
		freshFrame,
		anchorCameraY,
		recordPenDownState,
		gainedPressure,
		penUp,
		endPenGesture,
		visibleBandArea,
	});
}
