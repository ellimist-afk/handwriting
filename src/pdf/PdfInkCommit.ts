/**
 * Pen up and op emit of the PDF ink controller, moved from PdfInkController.ts. Each is a method of PdfInkController, installed on its prototype when PdfInkController.ts loads.
 * Bodies moved unchanged. Frame path: the call lines in PdfInkController.ts and the prototype lookup are unchanged.
 */
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { HIGHLIGHTER_ALPHA } from "../ink/PenStyle";
import { InkOp } from "../inline/InkHistory";
import { stripPenUp } from "../inline/StripPenChrome";
import { toPagePoint } from "./PageMap";
import { ProbedViewer, probeViewer } from "./PdfViewerProbe";
import { installMethods } from "../inline/InstallMethods";
import { type Attached, INK_OVER_CLASS, type OpMode, OWN_CLASSES, OWN_TOOLBAR_SELECTOR, type PenFrame, PROBE_MAX_AGE_MS, removedByHistory, SYNC_MIN_GAP_MS, type PdfInkController } from "./PdfInkController";

declare module "./PdfInkController" {
	interface PdfInkController {
		penUp(ev?: PointerEvent): void;
		dressWet(attached: Attached | undefined): void;
		undressWet(attached: Attached | undefined): void;
		addFinalPoint(ev: PointerEvent, frame: PenFrame): void;
		emitOp(op: InkOp, mode?: OpMode): boolean;
		recordOp(op: InkOp): void;
		apply(op: InkOp, onlyPage?: number, mode?: OpMode): boolean;
		persistLive(): void;
		refreshPage(pageNumber: number): void;
		historyStep(redo: boolean): boolean;
		emit(op: InkOp): boolean;
		probe(): ProbedViewer | null;
		isOwnMutation(record: MutationRecord): boolean;
		invalidateProbe(): void;
		dropOverlays(): void;
		scheduleThrottled(): void;
		schedule(): void;
	}
}


	function penUp(this: PdfInkController, ev?: PointerEvent): void {
		this.flushEditFrame(false);
		const editTarget = this.editTarget;
		this.editTarget = null;
		this.endMetrics();
		// Whatever the gesture was, it is over: the strip returns, the same
		// as a note (StripPenChrome.ts, §5o). The router funnels pointerup
		// AND pointercancel here (InlinePenRouter.pointerUpOrCancel), and the
		// two manual call sites below also route through this one method, so
		// one call covers every teardown.
		stripPenUp(this.tools);
		// One line per gesture end, whichever branch below actually closes
		// it out - traced here, before any of them can return, so pan and
		// space (which return before `wasErasing` would otherwise be read)
		// get one too. `this.erasing` is still this gesture's value; it is
		// not cleared until the erase branch below runs.
		if (diagnosticsEnabled()) this.tracePenUp(ev);
		// The frozen frame is released HERE, above every branch, because two
		// of them return before the release that used to sit further down.
		// `frame` is set unconditionally at pen-down, so a pan or an
		// insert-space left it set for the life of the view; nothing else
		// clears it but `resetGestureState` (a file switch, an abandoned
		// stroke, a viewer rebuild). It is read by `penRaw` as the gate that
		// says a gesture is live, so a stale one also made the NEXT pan's
		// samples look like a stroke's.
		//
		// Handed to `addFinalPoint` rather than left on the field for it: the
		// lift's own position still has to map through the frame the stroke
		// was drawn in, and that is the only reader below this line.
		const frame = this.frame;
		this.frame = null;
		if (this.panLast !== null) {
			this.panLast = null;
			// Take the grabbing hand off with the gesture rather than leaving
			// it to a watchdog that guards the reticle and not the cursor.
			// AFTER `panLast` is cleared: `hideCursor` is a reticle path and
			// the gate in `showCursor` reads that field, so clearing first is
			// what lets the next hover paint a ring again.
			this.endPanDragCursor();
			return;
		}
		if (this.spaceLineY !== null) {
			// Same reasoning as the pan branch above and the erase branch
			// below: the gesture is over, so the reticle goes with it rather
			// than waiting on the watchdog.
			this.hideSpaceCursor();
			const spaceId = this.documentId();
			if (spaceId && this.spaceTotalDy !== 0 && this.spaceIds.length > 0) {
				// Recorded but not re-applied: the moves already landed live.
				this.recordOp({
					type: "move",
					path: spaceId,
					strokeIds: this.spaceIds,
					dx: 0,
					dy: this.spaceTotalDy,
				});
			}
			this.spaceLineY = null;
			this.spaceIds = [];
			this.persistLive();
			const spaceBox = this.frameBox(this.strokePageNumber);
			const spacePair = this.wetOn(this.strokePageNumber);
			if (spacePair && spaceBox) spacePair.wet.clear(spaceBox.widthPx, spaceBox.heightPx);
			return;
		}
		// The lift itself. `pointerup` carries a position that never arrives
		// through onPenRaw, so without this the stroke ends at the last
		// SAMPLED point and the tail between there and where the pen actually
		// left the glass is missing - visible as ends being cut off
		// (hardware, 2026-08-29). The note surface closes the same gap.
		if (ev?.type === "pointerup" && frame && this.builder && !this.erasing) this.addFinalPoint(ev, frame);
		const builder = this.builder;
		const page = this.strokePageNumber;
		const id = this.documentId();
		this.builder = null;
		this.wetFrom = null;
		this.wetBegun = false;
		const wasErasing = this.erasing;
		this.erasing = false;
		// Put the eraser ring away with the stroke, exactly as the note
		// surface does at its own erase pen-up. Not left to the watchdog: that
		// would strand a full-size eraser ring on screen for a second after
		// the lift, and if the pen is still in hover range the very next hover
		// sample brings the reticle back at the RIGHT size for whatever the
		// tip is now - which is the behaviour the hover path already owns.
		if (wasErasing) this.hideEraserCursor();
		if (this.dragFrom) {
			// Same reasoning as the pan and erase branches: the gesture is
			// over, put its reticle away rather than leaving it for the
			// watchdog.
			this.hideLassoCursor();
			this.dragFrom = null;
			const { dx, dy } = this.dragTotal;
			// One op for the whole drag, recorded but NOT re-applied: the
			// moves already landed live, sample by sample.
			if (id && editTarget?.path === id && (dx !== 0 || dy !== 0) && editTarget.strokeIds.length > 0) {
				this.recordOp({ type: "move", path: id, strokeIds: editTarget.strokeIds, dx, dy });
			}
			this.persistLive();
			const box = this.frameBox(page);
			if (box) this.drawLasso(box);
			return;
		}
		if (this.lassoPts.length > 0) {
			this.hideLassoCursor();
			this.lassoUp(page);
			return;
		}
		if (wasErasing) {
			if (id && page > 0) this.recordErase(id);
			this.eraseFrom = null;
			// The gesture's ops were applied live; this is its one write.
			this.persistLive();
			return;
		}
		if (!builder || page <= 0 || !id) return;
		const stroke = builder.finish();
		// The committed layer takes over now, so the wet trail comes off. Done
		// after `emit` below would leave both drawn for a frame; done here, the
		// repaint that emit triggers puts the committed stroke straight back.
		const attached = this.overlays.get(page);
		const pair = this.wetOn(page);
		const box = this.frameBox(page);
		// Nothing to hand off to, so the trail is simply taken off - the same
		// clear an abandoned stroke needs, which is why it is a method now
		// (`clearWetTrail`) rather than a block here and a copy there.
		if (!stroke) {
			this.clearWetTrail(page);
			return;
		}
		// The page is the stroke's, from pen-down. Everything downstream - the
		// store, the sidecar, the render filter - keys on this one field.
		this.emit({ type: "add", path: id, strokes: [{ ...stroke, page }] });
		// Committed first, wet second, both in THIS frame. Clearing first left a
		// frame with neither drawn, because emit only schedules the repaint - and
		// the two layers do not agree at the ends: the wet layer applies the start
		// taper only, by design, so the end taper appears for the first time when
		// the committed stroke lands. Wet ink is opaque, so painting under it and
		// then lifting it costs nothing and nobody can see the double paint. The
		// note surface calls this the handoff and has done it this way since
		// v0.13.6; this surface never got it.
		// ...and that is true of pen ink only. Both copies of a highlighter
		// stroke are translucent, so the frame they share composites the wash
		// twice and flashes dark - a fast series of strokes strobes. Taking
		// the wet element out of the composite in the same frame keeps the
		// handoff atomic without the double paint, which is what the note
		// surface does (InkOverlay, drawCommitted).
		if (pair && this.wetHighlighter) pair.wetCanvas.setCssProps({ opacity: "0" });
		this.sync();
		if (pair && box) {
			// The wet layer clears the stroke's OWN BOX on every device.
			//
			// This used to be Boox-only, "until an e-ink user has confirmed the
			// box on hardware" - a confirmation nobody on this project has the
			// device to give, so the whole-canvas clearRect stayed on the
			// default path, damaging the entire canvas once per pen-up. A pixel
			// proof replaced it: all four `appendPoint` branches x four path
			// shapes x both zooms x both device pixel ratios x both pens' width
			// laws, 128 cases, drawn in real Chromium and read back
			// EXHAUSTIVELY - every pixel, no stride - leave nothing, each
			// against a paired control that does leave a rim
			// (`test/measure/WetClearBox.test.ts`). `clearStroke` still falls
			// back to a whole-canvas clear when it has no box or a NaN one, so
			// the failure mode is the old behaviour rather than stale ink.
			//
			// The TAIL takes its dirty rect here too. Leaving it on `clearAll`
			// would have kept a whole-canvas damage per pen-up on the layer
			// above, defeating most of the change below it. Its own proof is
			// `test/measure/TailClearBox.test.ts`: the head and the
			// head-plus-prediction states are erased completely by the dirty
			// rect at both zooms and both device pixel ratios - CONDITIONAL on
			// the fallback, because `clear()` used to return outright on a
			// null box and three paths on that class paint and then null it.
			// The size handed in is what selects the fallback.
			pair.wet.clearStroke(box.widthPx, box.heightPx);
			pair.tail.clear(box.widthPx, box.heightPx);
		}
		this.undressWet(attached);
	}

	/**
	 * Dress the wet layer for the tool about to draw on it.
	 *
	 * One canvas serves both tools here, unlike the note surface, which gives
	 * the highlighter a layer pair of its own. So this canvas has to be told
	 * twice over what the committed painter already knows: a highlighter is a
	 * WASH, drawn at HIGHLIGHTER_ALPHA, and it belongs UNDER the ink it marks.
	 * Untold, a highlighter stroke was opaque and above everything while it
	 * was being drawn and dropped to a wash underneath the instant it landed
	 * (alan, on hardware, 2026-08-30).
	 *
	 * The committed canvas is raised rather than the wet one lowered. Both
	 * sit over a page whose own layers this plugin does not control, and
	 * moving ours DOWN is the move that can put ink behind the page; moving
	 * ours up cannot.
	 */
	function dressWet(this: PdfInkController, attached: Attached | undefined): void {
		const alpha = this.wetHighlighter ? String(HIGHLIGHTER_ALPHA) : "1";
		if (this.pair) {
			this.pair.wetCanvas.setCssProps({ opacity: alpha });
			// The head is the same stroke, one segment further on - it wears
			// the same wash or a highlighter's tip runs darker than its trail.
			this.pair.headCanvas.setCssProps({ opacity: alpha });
		}
		// The raise is the COMMITTED canvas's, so it is per page and stays
		// with the overlay; the pair being shared changes nothing about which
		// page's ink has to come up over the wash (§5h/H1).
		attached?.canvas.toggleClass(INK_OVER_CLASS, this.wetHighlighter);
	}

	/**
	 * Back to the resting state, once the stroke is committed and cleared.
	 *
	 * Here rather than at the next pen-down, so the element is honest between
	 * strokes: the lasso draws on this same canvas, and a wash left over from
	 * a highlighter would render its loop at a third of its brightness.
	 */
	function undressWet(this: PdfInkController, attached: Attached | undefined): void {
		this.wetHighlighter = false;
		this.dressWet(attached);
	}

	/**
	 * Add the pen-up position to the stroke in progress.
	 *
	 * Measured the way the router measures: against the scroller, at scale 1,
	 * which is what it was given as its rect element. Doing it here rather
	 * than asking the router for a sample keeps the one coordinate convention
	 * in one place - client px minus the scroller's box, then into content
	 * and page units exactly like every other sample.
	 */
	function addFinalPoint(this: PdfInkController, ev: PointerEvent, frame: PenFrame): void {
		const builder = this.builder;
		if (!builder) return;
		// The stroke's own frozen scroller, like every other sample.
		const scroller = frame.scroller;
		const box = frame.boxes.find((b) => b.pageNumber === this.strokePageNumber);
		if (!box) return;
		const rect = scroller.getBoundingClientRect();
		const content = {
			x: ev.clientX - rect.left + scroller.scrollLeft,
			y: ev.clientY - rect.top + scroller.scrollTop,
		};
		const p = toPagePoint(box, frame.scale, content.x, content.y);
		if (!p) return;
		// Pressure at lift is unreliable - it is often already zero - so the
		// last real reading is carried across rather than tapering the stroke
		// to nothing on a value the hardware reports on the way up.
		const pressure = this.wetFrom?.pressure ?? 0.5;
		const point = builder.add(p.x, p.y, pressure, ev.timeStamp);
		if (point) this.drawWet(box, point);
		// Close the smoothed curve out to the final sample, so the wet stroke
		// reaches the nib before the committed one replaces it.
		const cam = this.cameraFor(box);
		const pair = this.wetOn(box.pageNumber);
		if (cam && pair) pair.wet.finishStroke(cam, this.strokeStyle);
	}

	/**
	 * The ONE door every op leaves this controller by. False means refused.
	 *
	 * Gated here rather than in the gestures because every mutating path -
	 * the eraser, lasso delete, the lasso drag, insert-space, cut and paste -
	 * funnels through `apply` or `historyStep`, and a guard per gesture is a
	 * guard the next gesture will not have. A write that does not come
	 * through here is outside the guard; that is the invariant this pair
	 * exists to make greppable.
	 */
	function emitOp(this: PdfInkController, op: InkOp, mode?: OpMode): boolean {
		if (this.syntheticSources()) return false;
		this.onOp(op, mode);
		return true;
	}

	/**
	 * The other door: into the undo ring.
	 *
	 * A refused op must not be recorded either, or the delayed leg reopens
	 * the same hole - `invertInkOp` turns a `remove` into an `add`, so an
	 * undo pressed after the sources went back to normal would splice the
	 * crosses into the real document that the delete itself never touched.
	 */
	function recordOp(this: PdfInkController, op: InkOp): void {
		if (this.syntheticSources()) return;
		this.history.record(op);
	}

	/**
	 * Apply an op and repaint what it touched.
	 *
	 * `onlyPage` is the gesture hot path. A drag and an erase fire an op per
	 * pointer sample, and a full `refresh` invalidates every attached overlay
	 * - the whole window of canvases the viewer is holding - when the only
	 * page whose ink can have changed is the one under the nib.
	 */
	function apply(this: PdfInkController, op: InkOp, onlyPage?: number, mode: OpMode = "commit"): boolean {
		// A refused op is not applied, not marked dirty and not repainted.
		// There is nothing to repaint: a synthetic source is a pure function
		// of the page number, so it regenerates the same marks whatever the
		// gesture believed it had done to them.
		if (!this.emitOp(op, mode)) return false;
		if (mode === "live" || mode === "live-page") this.liveDirty = true;
		if (onlyPage === undefined) this.refresh();
		else this.refreshPage(onlyPage);
		return true;
	}

	/**
	 * The single write at the end of a live gesture. See OpMode.
	 *
	 * Idempotent and cheap, so every gesture end can call it without first
	 * proving something changed - but it does nothing when no live op ran,
	 * which keeps a gesture that moved nothing from touching the file.
	 */
	function persistLive(this: PdfInkController): void {
		if (!this.liveDirty) return;
		this.liveDirty = false;
		const id = this.documentId();
		if (id) this.persist(id);
	}

	/**
	 * Mark one page for repaint.
	 *
	 * The freshness check compares stroke COUNTS, which a move does not
	 * change, so the page has to be invalidated explicitly or the drag would
	 * not draw at all.
	 */
	function refreshPage(this: PdfInkController, pageNumber: number): void {
		const attached = this.overlays.get(pageNumber);
		// Invalidate if it is attached, but schedule EITHER WAY: a page with no
		// overlay yet is exactly the page whose first stroke needs the sync that
		// attaches one. Returning early here left that to the next viewer
		// mutation to fix.
		if (attached) attached.paintedCount = -1;
		this.schedule();
	}

	/** One undo or redo step, shared by Ctrl+Z and the strip's buttons. */
	function historyStep(this: PdfInkController, redo: boolean): boolean {
		// Ahead of the pop, not after it: a refusal further down would consume
		// the entry and report a step that never happened. The ring can still
		// hold ops recorded before the sources went synthetic.
		if (!this.idle || this.syntheticSources()) return false;
		this.clearSelection();
		let op = redo ? this.history.redo() : this.history.undo();
		if (!op) return false;
		if (op.type === "remove") {
			const here = new Set(this.allStrokes().map((st) => st.id));
			removedByHistory.set(op.strokes, new Set(op.strokes.filter((st) => here.has(st.id)).map((st) => st.id)));
		} else if (op.type === "add") {
			const took = removedByHistory.get(op.strokes);
			if (took) {
				const strokes = op.strokes;
				const pick = (_: unknown, i: number): boolean => took.has(strokes[i]!.id);
				op = { ...op, strokes: strokes.filter(pick), indices: op.indices?.filter(pick) };
				// The undo took nothing that is still owed: nothing to write.
				if (op.strokes.length === 0) {
					this.refreshStrip();
					return true;
				}
			}
		} else if (op.type === "replace") {
			// Whole or not at all, as the note surface does (InkOverlay.applyInkOp).
			// A stroke this step would take out is gone (another device erased or
			// split it and the sync poll adopted that): taking only the rest loses
			// ink, and putting the inserted strokes back lays them over what is there.
			const here = new Set(this.allStrokes().map((st) => st.id));
			if (!op.removed.every((st) => here.has(st.id))) {
				this.refreshStrip();
				return true;
			}
		}
		if (!this.emitOp(op)) return false;
		this.refresh();
		this.refreshStrip();
		return true;
	}

	/** Apply an op, remember it for undo, and repaint. False means refused. */
	function emit(this: PdfInkController, op: InkOp): boolean {
		if (!this.apply(op)) return false;
		this.recordOp(op);
		return true;
	}

	/** The viewer geometry, re-read only when it can have changed. */
	function probe(this: PdfInkController): ProbedViewer | null {
		const now = Date.now();
		if (this.probedValid && now - this.probedAt < PROBE_MAX_AGE_MS) {
			this.probeServed++;
			return this.probedCache;
		}
		this.probeReads++;
		this.probedCache = probeViewer(this.root, this.win);
		this.probedAt = now;
		this.probedValid = true;
		return this.probedCache;
	}

	/**
	 * Is this mutation record one of OUR writes inside `this.root`, not the
	 * viewer's?
	 *
	 * Audit doc §5b/D1: the observer's `attributeFilter` includes `class`
	 * and `style`, and this controller writes both on every hover move (the
	 * cursor reticle's transform, the scroller's hover class) - each one
	 * landing back in the same observer it is bound to and invalidating a
	 * probe cache that was still correct. Exact match, not a heuristic: the
	 * target is `this.cursorEl` (everything we ever write on it, including
	 * `style`, is ours); or the target is an Element carrying one of
	 * `OWN_CLASSES` (the overlay canvases, the wet/head canvases, the
	 * cursor div itself - all created by us, so nothing else can carry
	 * those classes); or the record is an `attributes` record on the bound
	 * scroller with `attributeName === "class"` (the hover class we
	 * toggle). The scroller's OWN `style` writes (`position: relative`) are
	 * deliberately excluded - that attribute is not one of ours to own, and
	 * a viewer restyle there must still invalidate.
	 */
	function isOwnMutation(this: PdfInkController, record: MutationRecord): boolean {
		if (record.target === this.cursorEl) return true;
		if (record.target.instanceOf(Element)) {
			if (record.target.closest(OWN_TOOLBAR_SELECTOR)) return true;
			for (const cls of OWN_CLASSES) {
				if (record.target.classList.contains(cls)) return true;
			}
		}
		if (
			record.type === "attributes" &&
			record.attributeName === "class" &&
			record.target === this.boundScroller
		) {
			return true;
		}
		return false;
	}

	/**
	 * The next read must go to the DOM: something restyled or resized.
	 *
	 * Called from the two observers, which is where a zoom, a re-render or a
	 * page appearing arrives. Scrolling deliberately does NOT invalidate:
	 * page offsets are scroll-independent, and scroll offsets are read live
	 * off the element rather than cached here.
	 */
	function invalidateProbe(this: PdfInkController): void {
		this.probedValid = false;
	}

	/** Forget every page overlay, removing the canvases we can still reach. */
	function dropOverlays(this: PdfInkController): void {
		for (const { canvas } of this.overlays.values()) canvas.remove();
		this.overlays.clear();
		// The pair goes with them. Both callers - unmount and a viewer that
		// was rebuilt under us - mean every element we were holding is gone or
		// going, and a renderer bound to an orphaned canvas is not reusable.
		this.dropPair();
	}


	/**
	 * Mutation-driven syncs, throttled to a floor between them.
	 *
	 * A sync re-reads layout off every page div in the document, and pdf.js
	 * does not virtualise those - a hundred-page file has a hundred. During a
	 * pinch it restyles the pages on every frame, so every frame invalidated
	 * the cache, scheduled a sync, and forced a full reflow while the zoom was
	 * trying to animate. Reported from an ipad as the zoom not looking smooth.
	 *
	 * The first mutation still syncs immediately, so a page rendering as you
	 * scroll gets its ink without waiting. Everything arriving inside the floor
	 * collapses into one trailing sync, which is what turns sixty reflows a
	 * second into about eight. The overlays are absolutely positioned at the
	 * page's full size, so they scale WITH the page in the meantime: the ink
	 * goes a little soft during the gesture and sharpens when it settles,
	 * rather than stuttering throughout.
	 */
	function scheduleThrottled(this: PdfInkController): void {
		const now = Date.now();
		const since = now - this.lastSyncAt;
		if (since >= SYNC_MIN_GAP_MS) {
			this.schedule();
			return;
		}
		if (this.trailingSync !== null) return;
		this.trailingSync = this.win.setTimeout(() => {
			this.trailingSync = null;
			this.schedule();
		}, SYNC_MIN_GAP_MS - since);
	}
	function schedule(this: PdfInkController): void {
		if (!this.mounted || this.syncQueued) return;
		this.syncQueued = true;
		this.win.requestAnimationFrame(() => {
			this.syncQueued = false;
			this.sync();
		});
	}

export function installPdfInkCommit(proto: PdfInkController): void {
	installMethods(proto, {
		penUp,
		dressWet,
		undressWet,
		addFinalPoint,
		emitOp,
		recordOp,
		apply,
		persistLive,
		refreshPage,
		historyStep,
		emit,
		probe,
		isOwnMutation,
		invalidateProbe,
		dropOverlays,
		scheduleThrottled,
		schedule,
	});
}
