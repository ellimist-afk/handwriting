/**
 * The slides surface's pointer path: pointerdown, move and end, the eraser, the rested-contact, hold and quiet timers, and the stroke commit.
 * They are methods of SlidesDeck, installed on its prototype when SlidesInkSurface.ts loads.
 */
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { markPenHardwareSeen } from "../inline/PenToolsMode";
import { mouseInkEnabled } from "../inline/MouseInk";
import { predictionEinkOn } from "../inline/StrokePrediction";
import { tipMode } from "../inline/TipMode";
import { DEFAULT_ERASER_RADIUS_PX } from "../ink/EraserSize";
import { newStrokeId } from "../ink/Stroke";
import { coarseGridFor, StrokeBuilder } from "../ink/StrokeBuilder";
import { pageOfSlide } from "./SlidesSections";
import { SILENT_LIFT_QUIET_MS, silentLift, STROKE_HOLD_MS, type StrokeEndReason, strokeSessionReducer } from "./SlidesStrokeSession";
import { installMethods } from "../inline/InstallMethods";
import { contactBecameStroke, describe, eraserHitsInSlide, eraserIntent, insideRect, type Layers, log, mapScreenToSlide, now, partialEraseInSlide, type RestedContact, slideEraseCircle, slideScale, type SlideNib, type SlidesDeck } from "./SlidesInkSurface";

declare module "./SlidesInkSurface" {
	interface SlidesDeck {
		onPointerDown(ev: PointerEvent): void;
		beginInkAt(l: Layers, nib: SlideNib, sample: { clientX: number; clientY: number; pressure: number; timeStamp: number; pointerType: string }, fromMouse: boolean): void;
		eraserRadiusPx(): number;
		eraseAt(clientX: number, clientY: number): boolean;
		markErased(): void;
		flushErase(): void;
		capture(pointerId: number): void;
		promoteToStroke(pointerId: number): void;
		startRestedContact(ev: PointerEvent, rest: RestedContact, at: { x: number; y: number; t: number; pressure: number }, promoted: boolean): boolean;
		liftAfterRest(ev: PointerEvent, rest: RestedContact): void;
		onPointerMove(ev: PointerEvent): void;
		onPointerMoveBody(ev: PointerEvent): void;
		onPointerEnd(ev: PointerEvent, kind: "up" | "cancel" | "lost-capture" | "got-capture"): void;
		onHoldExpired(): void;
		syncHoldTimer(): void;
		endSilentLift(pointerId: number, t: number): void;
		armQuietTimer(waitMs: number): void;
		clearQuietTimer(): void;
		onQuietExpired(): void;
		logStrokeEndFocus(): void;
		commitStroke(pointerId: number, reason: StrokeEndReason, samples: number): void;
		totalStrokes(): number;
	}
}

	function onPointerDown(this: SlidesDeck, ev: PointerEvent): void {
		if (this.disposed) return;
		if (this.controlEvent(ev)) {
			if (ev.pointerType !== "touch") {
				this.finishGesture();
				this.dropPenGuard();
				this.penContactPending = false;
			}
			return;
		}
		// THE DECISION, RECORDED. This runs before the same contact's
		// `touchstart`, which is the whole basis of the route - see
		// `armGestureGuard`. It must be before the claim check, because a pen
		// the surface does not claim (a deck with nothing mounted) must still
		// not be arbitrated as a pan.
		this.penContactPending = ev.pointerType === "pen";
		if (ev.pointerType === "pen") markPenHardwareSeen();
		if (ev.pointerType === "pen") this.armContactGuard();
		if (!this.claims(ev) || this.session.phase === "drawing") return;
		const l = this.layers;
		if (!l) {
			log("UNEXPECTED pen down with nothing mounted (no slide marked present); ignored");
			return;
		}
		if (!insideRect(ev.clientX, ev.clientY, this.revealEl.getBoundingClientRect())) return;
		// preventDefault, never stopPropagation (S4): this suppresses the
		// compatibility mouse events and the text selection drag, while the
		// event still bubbles to `.reveal` and keeps the deck focused so the
		// arrow keys keep working. FIRST, before anything that could yield -
		// there is no await on this path and there must never be one, because a
		// preventDefault after the task that delivered the event is ignored.
		ev.preventDefault();
		// B1: the tail eraser end erases, and so does the tip while the
		// palette's Eraser mode is on - a pen without a tail end has no other
		// way to take ink off a slide. Everything else, including a held
		// barrel button (no lasso here), inks. Same test as InlinePenRouter's
		// `bandEraserIntent`, read once at contact - plus the mouse's own arm,
		// once mouse ink is on (`eraserIntent`, above).
		const erasing = eraserIntent(
			ev.pointerType,
			ev.buttons,
			ev.button,
			tipMode() === "eraser",
			mouseInkEnabled()
		);
		this.erasing = erasing;
		this.gestureBefore = { index: l.index, strokes: (this.strokes.get(l.index) ?? []).slice() };
		// Once per CONTACT, not per sample: a layout may have moved under the
		// deck without firing any of the events `refresh` listens for, and the
		// pen-down is the last moment that is cheap to be sure at.
		this.measureGeometry();
		this.armPenGuard(ev.pointerId);
		// A1: an erase contact waits on §3.3's slop/clock test exactly like an
		// ink one now - manual.md promises a pen TAP still turns the page or
		// closes the presentation, and that has to hold with the eraser end
		// down too, or the reader loses the close button the moment they pick
		// up the eraser. Until it is promoted (a move past the slop, or the
		// TAP_MS clock at the end) it is only a candidate erase and touches
		// nothing.
		this.penStroke = false;
		this.contactStart = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp, pressure: ev.pressure };
		this.contactNib = null;
		this.ensureDeckFocused();
		// A3: capture is NOT taken here unless the contact is already a stroke.
		// `setPointerCapture` retargets every later event for this pointer to
		// `.reveal`, so the browser computes the compatibility `click` from the
		// common ancestor of the pointerdown target (`.navigate-right`) and the
		// retargeted pointerup target (`.reveal`) - which is `.reveal` itself,
		// never the button. Reveal's Controls bind `click` on the buttons, so
		// the tap passed through (correctly, A1) and then landed on nothing.
		// An erase contact is promoted the same way, so it is just as capable
		// of being a tap and stays uncaptured until then.
		this.capturedContact = false;
		if (this.penStroke) this.capture(ev.pointerId);
		// A new contact on the surface: whatever a rest remembered is over.
		this.restedContact = null;
		this.session = strokeSessionReducer(this.session, {
			kind: "down",
			pointerId: ev.pointerId,
			t: ev.timeStamp,
			captured: this.capturedContact,
		}).state;
		// The other half of the silent lift: a contact that stops reporting
		// altogether has no sample left for `silentLift` to read, so the only
		// witness is the clock. Armed for every claimed contact, ink or erase,
		// tap or stroke - a tap can be abandoned exactly as easily, and it
		// leaves the same stale session behind it (`onPointerDown` returns
		// early while one is live, so the reader's NEXT stroke is the one that
		// is lost).
		//
		// Pens only. A mouse held still sends nothing while its button is
		// down, so silence proves nothing about it: the deadline ended a held
		// dot as a lift (the dot vanished) and ended a drag that paused, so
		// the rest of it drew nothing. A mouse always sends its button-up,
		// and the tap-or-stroke test at that button-up decides the dot.
		if (ev.pointerType === "pen") this.armQuietTimer(SILENT_LIFT_QUIET_MS);
		if (erasing) {
			// B1: no hit test yet - promotion (on move or at TAP_MS) decides
			// whether this contact ever touches the slide's ink at all.
			this.erasedCount = 0;
			return;
		}
		const nib = this.host.nib();
		this.contactNib = nib;
		this.beginInkAt(l, nib, ev, ev.pointerType === "mouse");
	}

	/**
	 * Start the live ink for a contact at one sample: dress the wet layer, open the
	 * builder, begin the wet stroke and put the contact dot on screen. The tail of
	 * `onPointerDown`, taken out so a contact that the silence deadline ended can
	 * start its next stroke the same way, at the sample that proved the nib never left.
	 */
	function beginInkAt(
		this: SlidesDeck,
		l: Layers,
		nib: SlideNib,
		sample: { clientX: number; clientY: number; pressure: number; timeStamp: number; pointerType: string },
		fromMouse: boolean
	): void {
		this.dressWet(l, nib.tool);
		this.activeStyle = this.style(nib);
		const { rect, layoutWidth, camera: cam } = this.geometry();
		const p = mapScreenToSlide(sample.clientX, sample.clientY, rect, layoutWidth, this.samplePoint);
		// The wet layer's shaping follows the DEVICE, per stroke, exactly as
		// the editor sets it at pen-down (`this.wet.shape = !fromMouse`,
		// InkOverlay.ts): a mouse stroke draws flat live, the same way it will
		// commit. `shape` was set once at MOUNT here, so a mouse stroke drew
		// SHAPED - velocity thinning and start taper, off a constant 0.5
		// pressure that is evidence for neither - while the hand moved, and
		// then turned flat the instant it committed, because
		// `StrokeRenderer.drawStroke` already exempts `stroke.device ===
		// "mouse"` and that is the tag the builder below writes. One stroke,
		// drawn two different ways. Set BEFORE `beginStroke`, which is where
		// `WetInkRenderer` latches it (`shapingThisStroke`) for the stroke.
		l.wet.shape = !fromMouse;
		// `device: "mouse"` (StrokeBuilder's own arg) tags the stroke the same
		// way the editor's does (InkOverlay.ts ~4835, ~7070): a mouse's steady
		// 0.5 pressure is not evidence to shape a width law from, and PageData
		// only round-trips the tag for a device it recognises as one.
		this.builder = new StrokeBuilder(
			nib.tool,
			nib.color,
			nib.width,
			undefined,
			fromMouse ? "mouse" : undefined
		);
		// Device px per slide unit: the screen's device px per CSS px times the
		// slide's CSS px per slide unit. A mouse stroke passes no grid.
		const dpr = this.win().devicePixelRatio || 1;
		this.builder.start(sample.timeStamp, fromMouse ? undefined : coarseGridFor("slides", sample.pointerType, dpr, dpr * slideScale(rect, layoutWidth)));
		this.builder.add(p.x, p.y, sample.pressure, sample.timeStamp);
		l.wet.beginStroke(
			{ x: p.x, y: p.y, pressure: sample.pressure, t: sample.timeStamp },
			this.activeStyle,
			nib.tool === "highlighter",
			this.builder.resolvedPressureProfile
		);
		// The contact point, on screen from the first event. The wet layer
		// paints nothing until a segment settles - and when it does, it starts
		// at mid(p0, p1) - so without this the stroke's first half-segment is
		// missing live and arrives whole at pen-up, reading as a stub sprayed
		// backwards out of the pen. AFTER `beginStroke`, which is where the
		// shaper resets: `contactHalfWidth` reads it.
		//
		// This is the ONE head draw not gated on `head()`, so for a tap it is
		// the entire visible mark - hence `contactHalfWidth`, whose floor lives
		// in the wet layer and is not recomputed here (InkOverlay ~9002).
		l.tail.clear();
		l.tail.drawHead(
			cam,
			this.activeStyle,
			{ x: p.x, y: p.y },
			{ x: p.x, y: p.y },
			sample.pressure,
			l.wet.contactHalfWidth(this.activeStyle, sample.pressure)
		);
	}

	/**
	 * The live eraser radius from the host, falling back to the same default
	 * the inline surface starts at if the host ever answers something the
	 * circle math cannot use - a stale setting, not a reason to erase nothing.
	 */
	function eraserRadiusPx(this: SlidesDeck): number {
		const r = this.host.eraserRadiusPx();
		return Number.isFinite(r) && r > 0 ? r : DEFAULT_ERASER_RADIUS_PX;
	}

	/**
	 * B1: erase whatever the eraser circle at this screen point touches on the
	 * CURRENT slide only - an erase gesture cannot outlive a slide change
	 * because it holds the navigation guard for its whole life (S6/A1 above).
	 *
	 * AMENDED 2026-09-05 (slide change): the guard is not the reason, and on
	 * its own it was never enough. It swallows POINTER and CLICK navigation,
	 * and the two commonest ways to turn a slide mid-gesture reach Reveal
	 * through neither: a presenter clicker is a keyboard, and so is the arrow
	 * key beside it. What makes the sentence true now is
	 * `endStrokeForSlideChange`, which ends the gesture as the index moves, so
	 * "the CURRENT slide" is still the only slide this ever touches - it just
	 * gets there by ending the gesture rather than by refusing the change.
	 *
	 * Whole-stroke or partial, whichever the NOTE surface is set to: the host
	 * answers `eraseWholeStrokes()` from the same `getEraserWholeStrokes()` the
	 * inline eraser reads, so the eraser behaves one way across the plugin
	 * rather than being silently whole-stroke-only on a deck. The two branches
	 * are `InkOverlay.eraseAt`'s two branches; the partial one is
	 * `partialEraseInSlide`, above.
	 *
	 * A2: this does NOT repaint. It answers whether the slide's ink changed and
	 * the CALLER repaints once, because a single pointermove carries several
	 * coalesced samples and repainting inside here fired a whole-canvas clear
	 * and redraw of every surviving stroke several times over inside one JS
	 * turn, before the browser painted once. Blank slide still costs nothing.
	 */
	function eraseAt(this: SlidesDeck, clientX: number, clientY: number): boolean {
		const l = this.layers;
		if (!l) return false;
		const list = this.strokes.get(l.index);
		if (!list || list.length === 0) return false;
		const { rect, layoutWidth } = this.geometry();
		const radiusPx = this.eraserRadiusPx();
		const hits = eraserHitsInSlide(list, clientX, clientY, rect, layoutWidth, radiusPx);
		if (hits.length === 0) return false;
		if (this.host.eraseWholeStrokes()) {
			const hitSet = new Set(hits);
			const remaining = list.filter((s) => !hitSet.has(s.id));
			if (remaining.length === list.length) return false;
			this.erasedCount += list.length - remaining.length;
			this.strokes.set(l.index, remaining);
			return true;
		}
		// The SAME ring the hit test just used: `eraserHitsInSlide` is this
		// call plus `strokesHitByCircle`, so the circle the split cuts with
		// cannot drift from the circle that reported the hit.
		const circle = slideEraseCircle(clientX, clientY, rect, layoutWidth, radiusPx);
		const cut = partialEraseInSlide(list, hits, circle, newStrokeId);
		if (cut.touched === 0) return false;
		this.erasedCount += cut.touched;
		this.strokes.set(l.index, cut.strokes);
		return true;
	}

	/**
	 * The current slide's ink changed under the eraser: paint it, once, on the
	 * next frame.
	 *
	 * Coalescing the repaint per MOVE was the first fix and it is not enough. A
	 * pen delivers moves at 120-240 Hz and the browser paints at 60, so a scrub
	 * across a busy slide still ran two, three, four full clear-and-redraw
	 * passes over every surviving stroke between one frame and the next, all
	 * but the last of which nobody ever saw. A dirty flag plus one
	 * `requestAnimationFrame` makes the work per FRAME, which is the rate the
	 * reader can actually perceive, and the cost stops scaling with the pen's
	 * report rate.
	 */
	function markErased(this: SlidesDeck): void {
		this.eraseDirty = true;
		if (this.eraseFrame !== null) return;
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		this.eraseFrame = win.requestAnimationFrame(() => {
			this.eraseFrame = null;
			if (!this.eraseDirty || this.disposed) return;
			this.eraseDirty = false;
			this.repaint();
		});
	}

	/**
	 * Paint the pending erase NOW, cancelling its frame.
	 *
	 * At the lift and at teardown: the gesture is over, and leaving the last
	 * hit to a frame that a disposed deck will never run would show the reader
	 * ink that is no longer there.
	 */
	function flushErase(this: SlidesDeck): void {
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		if (this.eraseFrame !== null) {
			win.cancelAnimationFrame(this.eraseFrame);
			this.eraseFrame = null;
		}
		if (!this.eraseDirty) return;
		this.eraseDirty = false;
		this.repaint();
	}

	/** setPointerCapture, with the refusal logged rather than swallowed. */
	function capture(this: SlidesDeck, pointerId: number): void {
		try {
			this.revealEl.setPointerCapture(pointerId);
			this.capturedContact = true;
		} catch (e) {
			log(`setPointerCapture refused: ${String(e)}`);
		}
	}

	/**
	 * The contact just became a stroke (A1). Capture it - once, whichever of
	 * the two promotion sites got there first: the slop test on a move, or the
	 * TAP_MS test when a motionless contact ends.
	 *
	 * A tap never reaches here, and that is the point: it runs its whole life
	 * uncaptured so its `click` is still aimed at the arrow it was aimed at.
	 */
	function promoteToStroke(this: SlidesDeck, pointerId: number): void {
		// The contact just became ink, which is the moment the frame clock
		// starts mattering. Before the switch is gated inside `begin`, so a
		// reader who never turned diagnostics on never starts a rAF loop.
		if (diagnosticsEnabled() && !this.moveTrace.active) this.moveTrace.begin();
		if (this.capturedContact) return;
		this.capture(pointerId);
	}

	/**
	 * A contact that the silence deadline ended starts writing again.
	 *
	 * The deadline committed what was drawn and freed the session. Silence alone
	 * proves nothing more: a still nib sends nothing. A new contact always sends a
	 * pointerdown, so a pointermove from the pointer the deadline ended that is not
	 * a hover proves the nib never left, and `resumeAfterRest` starts a NEW stroke
	 * (or erase) at that sample with the contact's own tool, already promoted. Two
	 * strokes and two undo steps for a pause in the middle, no point invented
	 * across the gap. The first stroke keeps the end shape the deadline gave it.
	 */
	function startRestedContact(
		this: SlidesDeck,
		ev: PointerEvent,
		rest: RestedContact,
		at: { x: number; y: number; t: number; pressure: number },
		promoted: boolean
	): boolean {
		const l = this.layers;
		if (!l) return false;
		if (!rest.erasing && !rest.nib) return false;
		this.restedContact = null;
		this.erasing = rest.erasing;
		this.gestureBefore = { index: l.index, strokes: (this.strokes.get(l.index) ?? []).slice() };
		this.measureGeometry();
		this.armPenGuard(ev.pointerId);
		this.penStroke = promoted;
		this.contactStart = { x: at.x, y: at.y, t: at.t, pressure: at.pressure };
		this.contactNib = rest.nib;
		this.capturedContact = false;
		if (this.penStroke) this.promoteToStroke(ev.pointerId);
		this.session = strokeSessionReducer(this.session, {
			kind: "down",
			pointerId: ev.pointerId,
			t: at.t,
			captured: this.capturedContact,
		}).state;
		this.armQuietTimer(SILENT_LIFT_QUIET_MS);
		if (diagnosticsEnabled()) {
			log(
				`contact resumed after a rest on slide ${l.index}: pointer ${ev.pointerId}, ` +
					`${rest.erasing ? "erase" : "ink"}, ${promoted ? "new stroke" : "held contact"}`
			);
		}
		if (rest.erasing) {
			this.erasedCount = 0;
			if (promoted && this.eraseAt(at.x, at.y)) this.markErased();
			return true;
		}
		const nib = rest.nib;
		if (!nib) return false;
		this.beginInkAt(l, nib, { clientX: at.x, clientY: at.y, pressure: at.pressure, timeStamp: at.t, pointerType: ev.pointerType }, false);
		return true;
	}

	/**
	 * The pointerup of a pointer the deadline ended (memory ends here).
	 *
	 * Ink or an erase the deadline already saved: its lift presses no arrow, so the
	 * navigation guard is raised again for exactly this lift (`holdPenGuard` let it
	 * go at the deadline, and the click rides just behind this event). A contact
	 * that had not become a stroke yet saves nothing at the deadline; here it is
	 * given back its session so the ordinary lift below takes its tap-or-dot test
	 * (`contactBecameStroke`) and saves the held dot, or erases under a held eraser.
	 */
	function liftAfterRest(this: SlidesDeck, ev: PointerEvent, rest: RestedContact): void {
		this.restedContact = null;
		if (rest.promoted) {
			this.armPenGuard(ev.pointerId);
			this.penStroke = true;
			return;
		}
		if (rest.start) this.startRestedContact(ev, rest, rest.start, false);
	}

	/**
	 * The timed wrapper around the move handler.
	 *
	 * Separated from the body so the measurement brackets the WHOLE handler -
	 * the reducer step, the hold timer, the mapping loop, the ribbon fills
	 * and the head - rather than whichever part somebody already suspected.
	 * When the recorder is off `markHandlerStart` returns undefined after one
	 * boolean read and the body is called exactly as it was before.
	 */
	function onPointerMove(this: SlidesDeck, ev: PointerEvent): void {
		// A pen HOVER arms the listener before the tip ever lands. Unlike the
		// touch-action route this is not load-bearing - the pointerdown above
		// arms in time on its own, because the decision is made at contact
		// rather than committed before it. It only means the very first pen
		// contact on a never-seen-a-pen device is covered too.
		if (ev.pointerType === "pen") markPenHardwareSeen();
		if (ev.pointerType === "pen") this.armContactGuard();
		const startedAt = this.moveTrace.markHandlerStart();
		if (startedAt === undefined) {
			this.onPointerMoveBody(ev);
			return;
		}
		try {
			this.onPointerMoveBody(ev);
		} finally {
			this.moveTrace.endHandler(startedAt);
		}
	}

	function onPointerMoveBody(this: SlidesDeck, ev: PointerEvent): void {
		if (this.guardPointerId === ev.pointerId) this.lastPointerAt = now();
		const rest = this.restedContact;
		if (rest !== null && rest.pointerId === ev.pointerId && this.session.phase === "idle") {
			// A hover sample: the nib is off the glass, so the memory ends here.
			if (ev.pointerType === "pen" && silentLift(ev.pressure, ev.buttons)) {
				this.restedContact = null;
				return;
			}
			this.startRestedContact(
				ev,
				rest,
				{ x: ev.clientX, y: ev.clientY, t: ev.timeStamp, pressure: ev.pressure },
				true
			);
			ev.preventDefault();
			return;
		}
		if (this.session.pointerId !== ev.pointerId) return;
		// A mouse move with the primary button up: the release went to something
		// other than `.reveal` (the pen strip, the rest of Obsidian), so this
		// surface never heard it. A held mouse always reports the button, so this
		// sample is a hover and the stroke it would extend is over.
		const mouseButtonUp = ev.pointerType === "mouse" && (ev.buttons & 1) === 0;
		// The lift that delivered no `pointerup` (`silentLift`), read before a
		// single thing is done with the sample - it is a hover sample, and the
		// builder, the wet ribbon and the head must never see one. Here rather
		// than in the guard listener that feeds `lastPenHoverAt`: that listener
		// runs AFTER these handlers on the same element (registration order),
		// so by the time it saw the hover the nib's flight would already be
		// inked. The hover KEY stays where it is, fed once from the raw stream
		// it needs, because it answers about a pointer that owns no session.
		if ((ev.pointerType === "pen" && silentLift(ev.pressure, ev.buttons)) || mouseButtonUp) {
			this.endSilentLift(ev.pointerId, ev.timeStamp);
			return;
		}
		const l = this.layers;
		if (!l) return;
		const step = strokeSessionReducer(this.session, {
			kind: "move",
			pointerId: ev.pointerId,
			t: ev.timeStamp,
		});
		this.session = step.state;
		this.syncHoldTimer();
		if (step.recapture) this.capture(ev.pointerId);
		// A1: has the contact earned the right to be a stroke - ink or erase
		// alike? An erase contact takes exactly the same slop/clock test now
		// (B1), rather than the immediate promotion this used to give it.
		const start = this.contactStart;
		if (!this.penStroke && start) {
			this.penStroke = contactBecameStroke(
				ev.clientX - start.x,
				ev.clientY - start.y,
				ev.timeStamp - start.t
			);
			// A3: and with it, the capture that was withheld at pointerdown.
			// The pointer is still active, so this is legal here.
			if (this.penStroke) {
				this.promoteToStroke(ev.pointerId);
				// B1: ink folds its pointerdown point into the stroke regardless
				// of when promotion lands (`builder.add` at pointerdown, above) -
				// an erase has to do the same or the reader sees a gap exactly
				// where the promotion was decided, one hit test for the point
				// the contact started at, on top of whatever this move covers.
				if (this.erasing && this.eraseAt(start.x, start.y)) this.markErased();
			}
		}
		if (this.erasing) {
			// B1: still a candidate tap until promoted - touch nothing yet, and
			// leave its default action (and the click behind it) alone.
			if (this.penStroke) {
				// B1: scrub as the pen drags, one hit test per coalesced sample -
				// the same reason the ink path reads getCoalescedEvents. A2: the
				// hits accumulate across the whole loop the way `erasedCount`
				// does and the canvas is repainted ONCE after it, not once per
				// sample.
				const samples = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [];
				const list = samples.length > 0 ? samples : [ev];
				let erased = false;
				for (const s of list) {
					if (this.eraseAt(s.clientX, s.clientY)) erased = true;
				}
				if (erased) this.markErased();
			}
			ev.preventDefault();
			return;
		}
		if (!this.builder) return;
		const style = this.activeStyle;
		if (!style) return;
		// The cached measurement, taken at pen-down and at every layout move:
		// zero `getBoundingClientRect` on this path (A2, §3.2).
		const { rect, layoutWidth, camera: cam } = this.geometry();
		// Coalesced events matter more here than on the editor surface: the
		// deck runs its own rAF work and there is no prediction, so the dropped
		// samples would be visible as corners.
		const samples = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [];
		const list = samples.length > 0 ? samples : [ev];
		// Reported from here rather than re-derived by the wrapper: a second
		// `getCoalescedEvents()` would sit inside the timed window and inflate
		// the number this trace exists to establish.
		this.moveTrace.countSamples(list.length);
		for (const s of list) {
			const p = mapScreenToSlide(s.clientX, s.clientY, rect, layoutWidth, this.samplePoint);
			const point = this.builder.add(p.x, p.y, s.pressure, s.timeStamp);
			if (point) l.wet.appendPoint(cam, style, point);
		}
		// The live raw head, at the width the ribbon under it is being laid
		// down at - the wet layer reports it rather than the head guessing
		// from raw pressure (InkOverlay ~9073). `head()` answers undefined
		// when this stroke's centerline is raw, and then the wet ribbon
		// already reaches the nib and there is nothing to add.
		l.tail.clear();
		const head = l.wet.head();
		if (head) {
			l.tail.drawHead(
				cam,
				style,
				head.from,
				head.to,
				head.pressure,
				l.wet.liveHalfWidth(style, head.pressure)
			);
		}
		ev.preventDefault();
	}

	/**
	 * Every event that could end a stroke, plus the two capture events, funnel
	 * here so exactly one place decides - and logs - what happened.
	 *
	 * AMENDED 2026-09-05 (silent lift): "every event" is now every event that
	 * ANNOUNCES an ending. A hover sample ends a stroke too and arrives as a
	 * `pointermove` (`silentLift`, `onPointerMoveBody`), and the silence
	 * deadline ends one with no event at all (`onQuietExpired`). What is still
	 * true, and is the part that matters, is that all three run the same
	 * `commitStroke` - one place decides what a stroke's ending DOES, even
	 * though three places now recognise one.
	 */
	function onPointerEnd(
		this: SlidesDeck,
		ev: PointerEvent,
		kind: "up" | "cancel" | "lost-capture" | "got-capture"
	): void {
		// The contact is over, so the answer recorded for it expires with it.
		// Hygiene rather than a known hole: every contact fires pointerdown
		// before touchstart, so the flag is always rewritten before it is
		// read - but a stale `true` outliving its pen would swallow the next
		// finger's gesture, and that is not a failure worth leaving available.
		if (ev.pointerType === "pen") this.penContactPending = false;
		// The pointer the deadline ended. Only its pointerup or a cancel say the nib
		// left; `lostpointercapture` is the surface's own release at the deadline.
		const rested = this.restedContact;
		if (rested !== null && rested.pointerId === ev.pointerId && this.session.phase === "idle") {
			if (kind === "up") this.liftAfterRest(ev, rested);
			else if (kind === "cancel") this.restedContact = null;
		}
		if (this.guardPointerId === ev.pointerId) {
			this.lastPointerAt = now();
			// The lift, whatever the stroke did. It is checked BEFORE the
			// session, because the stroke may already have been committed by a
			// hold expiry or a leave and this is still the event whose `click`
			// would navigate.
			//
			// The lift is also where the PALM half of the guard starts its own
			// tail (PEN_RELEASE_TAIL_MS): the nib leaves first and the heel of
			// the hand follows, so the moves the hand makes on its way up are
			// the ones that reach Reveal's swipe. Recorded here rather than
			// inside `releasePenGuard`, which declines to run at all when a
			// hold expiry already dropped the guard - the palm is on the glass
			// either way.
			if (kind === "up") {
				this.lastPenLiftAt = now();
				this.releasePenGuard();
			}
		}
		if (this.session.phase !== "drawing" || this.session.pointerId !== ev.pointerId) return;
		const before = this.session;
		const step = strokeSessionReducer(before, {
			kind,
			pointerId: ev.pointerId,
			t: ev.timeStamp,
		});
		this.session = step.state;
		this.syncHoldTimer();
		// Keep the DOM truth beside the reducer's belief: a theft means we no
		// longer hold it (the next move re-acquires, `step.recapture`), and a
		// grant means we do.
		if (kind === "lost-capture" || kind === "cancel") this.capturedContact = false;
		if (kind === "got-capture") {
			this.capturedContact = true;
			return;
		}
		if (!step.end) return;
		// A tap that lasted past TAP_MS is ink (or an erase) even though it
		// never moved: the deliberate dot, or the held eraser. Decided here
		// as well as on move because a motionless contact produces no move
		// events at all.
		const start = this.contactStart;
		if (!this.penStroke && start) {
			this.penStroke = contactBecameStroke(
				ev.clientX - start.x,
				ev.clientY - start.y,
				ev.timeStamp - start.t
			);
			// A3: the second promotion site. Today this only ever runs on the
			// `pointerup` that ends a motionless hold, so the capture it takes
			// is immediately released below and it is the pen guard, not the
			// capture, that stops that click reaching an arrow. It is taken
			// anyway so that "a contact that becomes a stroke is captured"
			// holds at BOTH sites rather than at whichever one is live today.
			if (this.penStroke) this.promoteToStroke(ev.pointerId);
			// B1: a held eraser promoted here has never run a hit test - no
			// move ever fired for it - so this is the one chance to erase
			// what is sitting under the point before the gesture commits.
			if (this.penStroke && this.erasing) {
				if (this.eraseAt(ev.clientX, ev.clientY)) this.markErased();
			}
		}
		this.commitStroke(ev.pointerId, step.end, before.samples);
	}

	/** The hold deadline fired: nothing more arrived, so the stroke is over. */
	function onHoldExpired(this: SlidesDeck): void {
		if (this.disposed) return;
		const before = this.session;
		const step = strokeSessionReducer(before, { kind: "tick", t: now() });
		this.session = step.state;
		this.syncHoldTimer();
		if (!step.end || before.pointerId === null) return;
		this.commitStroke(before.pointerId, step.end, before.samples);
	}

	/** Mirror the reducer's `holdSince` onto a real timer. Idempotent. */
	function syncHoldTimer(this: SlidesDeck): void {
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		if (this.session.holdSince === null) {
			if (this.holdTimer !== null) {
				win.clearTimeout(this.holdTimer);
				this.holdTimer = null;
			}
			return;
		}
		if (this.holdTimer !== null) return;
		this.holdTimer = win.setTimeout(() => {
			this.holdTimer = null;
			this.onHoldExpired();
		}, STROKE_HOLD_MS);
	}

	/**
	 * The nib is off the glass and no `pointerup` said so. End the stroke the
	 * way a lift ends it.
	 *
	 * The same three lines every other ending runs - the reducer decides, the
	 * hold timer is re-synced, `commitStroke` does the rest (capture released,
	 * the guard handed to its tail, both live canvases cleared, persist) - so a
	 * silent lift and a real one differ in the log line and nowhere else.
	 */
	function endSilentLift(this: SlidesDeck, pointerId: number, t: number): void {
		const before = this.session;
		const step = strokeSessionReducer(before, { kind: "silent-lift", pointerId, t });
		this.session = step.state;
		this.syncHoldTimer();
		if (!step.end) return;
		this.commitStroke(pointerId, step.end, before.samples);
	}

	/** Arm (or re-arm) the silence deadline. Idempotent; the last arm wins. */
	function armQuietTimer(this: SlidesDeck, waitMs: number): void {
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		if (this.quietTimer !== null) win.clearTimeout(this.quietTimer);
		this.quietTimer = win.setTimeout(() => {
			this.quietTimer = null;
			this.onQuietExpired();
		}, Math.max(0, waitMs));
	}

	function clearQuietTimer(this: SlidesDeck): void {
		if (this.quietTimer === null) return;
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		win.clearTimeout(this.quietTimer);
		this.quietTimer = null;
	}

	/**
	 * The silence deadline fired: is the contact really silent, or did it just
	 * outlive the arm that was taken at pen-down?
	 *
	 * The deadline is armed ONCE per contact and asks `lastPointerAt` - the
	 * timestamp the move path already keeps for the guard - rather than being
	 * re-armed per sample. A pen that has been heard from since simply gets the
	 * remainder of its window and this costs one timer per 300 ms of stroke.
	 */
	function onQuietExpired(this: SlidesDeck): void {
		if (this.disposed) return;
		const before = this.session;
		if (before.phase !== "drawing" || before.pointerId === null) return;
		const since = now() - this.lastPointerAt;
		if (Number.isFinite(since) && since < SILENT_LIFT_QUIET_MS) {
			this.armQuietTimer(SILENT_LIFT_QUIET_MS - since);
			return;
		}
		const start = this.contactStart;
		const rest: RestedContact = {
			pointerId: before.pointerId,
			erasing: this.erasing,
			nib: this.contactNib,
			start: start ? { ...start } : null,
			promoted: this.penStroke,
		};
		this.endSilentLift(before.pointerId, now());
		// The silence ended the contact; the pointer may still be down and still writing.
		if (this.session.phase === "idle") this.restedContact = rest;
	}

	/**
	 * The diagnostic Alan's mouse-only machine could not get by hand: what has
	 * the keyboard the instant a stroke ends, and does Reveal's own focus
	 * plugin (the `focused` class, its `keyboardCondition`) agree with the DOM.
	 */
	function logStrokeEndFocus(this: SlidesDeck): void {
		if (diagnosticsEnabled()) {
			const active = this.revealEl.ownerDocument.activeElement;
			log(
				`focus at stroke end: active=${active ? describe(active) : "none"}, ` +
					`insideDeck=${active ? this.revealEl.contains(active) : false}, ` +
					`revealFocused=${this.revealEl.classList.contains("focused")}`
			);
		}
	}

	function commitStroke(this: SlidesDeck, pointerId: number, reason: StrokeEndReason, samples: number): void {
		const resumeReload = this.reloadAfterStroke;
		this.reloadAfterStroke = null;
		resumeReload?.();
		const builder = this.builder;
		this.builder = null;
		this.activeStyle = null;
		const wasStroke = this.penStroke;
		const wasErasing = this.erasing;
		this.erasing = false;
		this.contactStart = null;
		// The contact is over however it ended, so its silence deadline is too.
		// Here rather than at each ending: this is the one funnel.
		this.clearQuietTimer();
		// The endings that are NOT a lift - a hold that expired, a leave, a
		// silent lift, a slide change - hand the guard to its tail rather than
		// dropping it: the pen may still be down, and its eventual `pointerup`
		// carries a `click` that would turn the page. A real lift has already
		// released it, above.
		//
		// AMENDED 2026-09-05: a silent lift is the one ending here where the
		// nib is known to be OFF the glass, and it still takes the tail. The
		// pen is hovering, the reader's hand is still over the deck, and the
		// tail costs a pen tap 300 ms of patience it would otherwise have spent
		// finishing the stroke that never ended. Dropping the guard on the spot
		// would be arguable; taking the tail is what makes "a commit is not a
		// lift" one rule instead of five.
		this.holdPenGuard();
		// A3: a tap runs uncaptured from end to end, so "nothing to release"
		// is a normal ending here, not a fault. The flag keeps this from
		// being a call the browser has to refuse on every tap.
		if (this.capturedContact) {
			this.capturedContact = false;
			try {
				this.revealEl.releasePointerCapture(pointerId);
			} catch {
				/* already released with the pointer */
			}
		}
		const l = this.layers;
		if (l) {
			// THE HANDOFF ORDER, named because it is the OPPOSITE of the note
			// surface's and was never written down (GAP 11). `StrokeHandoff.ts`
			// (`handoffFinishedStroke`) draws the committed stroke FIRST and
			// clears the transient layers after it - "never clear what replaces
			// a thing before the replacement exists" - and this surface clears
			// here, ~100 lines before `repaint()` puts the committed stroke on
			// the glass. That is deliberate and it is safe HERE for one reason
			// that has to stay true: `SLIDES_DESYNCHRONIZED` is false, so the
			// wet, tail and committed canvases are all plain canvases that
			// present together, and everything between this clear and that
			// repaint is synchronous in one task - no await, no rAF, no yield
			// (the 0 ms focus timer below is only SCHEDULED). Both halves land
			// in the same frame, so there is no frame in which the ink the
			// reader just drew is missing. Two changes break that and they are
			// the two to watch: flipping `SLIDES_DESYNCHRONIZED` back to true,
			// or putting anything that yields between here and the repaint. If
			// either happens, adopt `handoffFinishedStroke`'s order instead of
			// keeping this one - but note that the ordering is not free to
			// simply invert, because the tap and erase branches below RETURN
			// after this clear with no committed paint at all, and each would
			// need its own clear. Pinned by a clear-order test rather than left
			// to this comment.
			//
			// Boox mode clears the stroke's own box; everyone else keeps the
			// full clear until an e-ink user has confirmed the box on hardware.
			// The note surface's pen-up (`InkOverlay`, `predictionEinkOn()`)
			// and the pdf's make the identical split, and this surface has more
			// to lose by not making it: e-ink refreshes the region a frame
			// damaged, this wet canvas is the WHOLE VIEWPORT rather than the
			// note's editor column (see the backing-store note at the top of
			// this file), so a whole-canvas clearRect at every lift is a
			// whole-screen refresh - the ~800 ms freeze per stroke a NoteAir
			// reported (2026-09-01, `WetInkRenderer.clearStroke`). Off e-ink
			// `predictionEinkOn()` is false and this is byte-for-byte what it
			// always did.
			//
			// AMENDED (GAP 8): the sentence beside the tail clear used to read
			// "and whole rather than dirty-rect: every ending funnels through
			// here (a lift, a cancel, a hold expiry, a leave, the teardown), so
			// this is the one place that has to guarantee no head outlives the
			// stroke it belonged to". The guarantee stands and is still the
			// reason this is here; "whole rather than dirty-rect" is what is no
			// longer true in Boox mode. `TailRenderer.clear()` erases the box
			// it last painted, and the head is redrawn through that same dirty
			// rect on every pointer event (the two `l.tail.clear()` calls on
			// the contact and the live-head paths), so the box it holds at this
			// instant IS the head that would otherwise outlive the stroke.
			// `clearAll` stays the answer everywhere else, where a stale
			// dirty-rect costs nothing to over-clear.
			if (predictionEinkOn()) {
				l.wet.clearStroke(l.cssWidth, l.cssHeight);
				l.tail.clear();
			} else {
				l.wet.clear(l.cssWidth, l.cssHeight);
				l.tail.clearAll(l.cssWidth, l.cssHeight);
			}
		}
		// The stroke is over: stop the frame clock and print the one line.
		// Called on the `active` flag rather than on the switch, so a stroke
		// that started recording and had diagnostics turned off under it
		// still stops its rAF loop instead of running for the session.
		// `console.debug` and not `log()` - the prefix is part of the line the
		// pure formatter is tested against, and log() would double it.
		if (this.moveTrace.active) {
			const line = this.moveTrace.end({
				cssWidth: l?.cssWidth ?? 0,
				cssHeight: l?.cssHeight ?? 0,
				dpr: this.win().devicePixelRatio || 1,
			});
			if (line) console.debug(line);
		}
		// Alan, same machine, caret NOT in the note: arrows worked before the
		// stroke and stopped after it, so something ELSE also lets go of focus
		// somewhere between pen-down and here. Not diagnosed - but every
		// ending (a lift, a cancel, a hold expiry, a leave, the teardown) funnels
		// through this one place, so re-taking focus here covers it either way.
		// Focus recovery remains unconditional before and after the timer;
		// only the diagnostic recording inside `logStrokeEndFocus` is opt-in.
		this.logStrokeEndFocus();
		this.ensureDeckFocused();
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		// A pointerup's default action, or a click handler it triggers, can run
		// AFTER this handler and move focus again - the same race
		// `InkOverlay.focusEditorSoon` closes for the note editor. The 0ms
		// timer undoes whatever that later default did.
		win.setTimeout(() => {
			if (this.disposed) return;
			this.logStrokeEndFocus();
			this.ensureDeckFocused();
		}, 0);
		if (wasErasing) {
			if (!wasStroke) {
				// A1: an erase contact that never crossed the slop or the clock
				// is a tap, exactly like the ink branch below - nothing was
				// touched (there is nothing to flush; `eraseAt` never ran) and
				// the click passed through to Reveal or the close button.
				if (l) {
					if (diagnosticsEnabled()) {
						log(
							`erase end on slide ${l.index}: reason=tap, samples=${samples}, ` +
								`nothing touched (click passed through)`
						);
					}
				}
				return;
			}
			// The gesture is over: whatever the last frame did not get to is
			// painted now, and only then is the result saved.
			this.flushErase();
			// B1: one persist per gesture, at lift, never on the erase hot
			// path - the note surface's rule (InkOverlay.eraseAt/penUp).
			const erased = this.erasedCount;
			this.erasedCount = 0;
			if (!l) return;
			if (erased === 0) {
				if (diagnosticsEnabled()) {
					log(`erase end on slide ${l.index}: reason=${reason}, samples=${samples}, nothing touched`);
				}
				return;
			}
			if (diagnosticsEnabled()) {
				log(
					`erase end on slide ${l.index}: reason=${reason}, samples=${samples}, ` +
						`-${erased}, slide total ${this.strokes.get(l.index)?.length ?? 0}, ` +
						`deck total ${this.totalStrokes()}`
				);
			}
			this.recordGesture("Erase");
			this.persist();
			return;
		}
		if (!builder || !l) return;
		if (!wasStroke) {
			// A1: a TAP. Nothing is recorded and nothing was swallowed, so the
			// click that follows reaches Reveal's arrow or Obsidian's close
			// button exactly as a mouse click would.
			if (diagnosticsEnabled()) {
				log(`stroke end on slide ${l.index}: reason=tap, samples=${samples}, +0 (click passed through)`);
			}
			return;
		}
		// The inline surface's release filter, not plain `finish()`: the same
		// pens are in the room, and a stroke that ends with a hook of release
		// travel would look like a bug rather than the hardware artefact it is.
		// On a proven coarse grid each stored point is the mean of its raw
		// sample and the one before, so the stroke ended half its last step
		// short of the lift. The last raw sample is the stroke's last point;
		// builder only, as on the note surface. The wet layer was cleared above
		// and the repaint below draws the stroke, lift point included, in the
		// same frame. A mouse stroke has no grid, so this stores nothing.
		builder.flushRaw();
		const finished = builder.finishReleaseFiltered();
		if (finished.length > 0) {
			for (const s of finished) s.page = pageOfSlide(this.visualSlots.get(l.index) ?? l.index);
			const list = this.strokes.get(l.index) ?? [];
			list.push(...finished);
			this.strokes.set(l.index, list);
		}
		this.repaint();
		if (diagnosticsEnabled()) {
			log(
				`stroke end on slide ${l.index}: reason=${reason}, samples=${samples}, ` +
					`+${finished.length}, slide total ${this.strokes.get(l.index)?.length ?? 0}, ` +
					`deck total ${this.totalStrokes()}`
			);
		}
		if (finished.length > 0) {
			this.recordGesture("Draw");
			this.persist();
		}
	}

	function totalStrokes(this: SlidesDeck): number {
		let n = 0;
		for (const list of this.strokes.values()) n += list.length;
		return n;
	}

export function installSlidesPointerPath(proto: SlidesDeck): void {
	installMethods(proto, {
		onPointerDown,
		beginInkAt,
		eraserRadiusPx,
		eraseAt,
		markErased,
		flushErase,
		capture,
		promoteToStroke,
		startRestedContact,
		liftAfterRest,
		onPointerMove,
		onPointerMoveBody,
		onPointerEnd,
		onHoldExpired,
		syncHoldTimer,
		endSilentLift,
		armQuietTimer,
		clearQuietTimer,
		onQuietExpired,
		logStrokeEndFocus,
		commitStroke,
		totalStrokes,
	});
}
