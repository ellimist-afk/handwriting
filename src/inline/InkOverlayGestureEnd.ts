/**
 * The note surface's gesture end and history: a contact that ends without a lift, a live erase or selection drag
 * put back when its gesture is torn down, the gesture state reset, and Delete all ink as one undoable step. They are
 * methods of InkOverlayPlugin, installed on its prototype when InkOverlay.ts loads.
 */
import { stripPenUp } from "./StripPenChrome";
import { HIGHLIGHTER_ALPHA } from "../ink/PenStyle";
import { eraseRemovalIndices } from "./InkHistory";
import { installMethods } from "./InstallMethods";
import { inlineInk, metrics, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		strokeAbandoned(): void;
		contactEndedWithoutLift(replayBand: boolean): void;
		endLiveGestureForHistory(): void;
		rollbackLiveGesture(): void;
		restoredByRollback(path: string): void;
		cancelFingerInkForPinch(): void;
		resetGestureState(): void;
		clearAllInk(path: string): number | null;
	}
}

	/**
	 * A live gesture was torn down inside the router with no pointerup: a
	 * window blur (alt-tab, a system dialog, the on-screen keyboard).
	 *
	 * The blur twin of update()'s path-change branch, which is where each of
	 * these lines comes from - the same stale state, reached without a switch,
	 * and the branch that repairs it can never run because no path changed.
	 *
	 * NOT THE WINDOW BLUR ANY MORE (alan, 2026-09-04: "alt tab mid stroke -
	 * sure make it consistent"). A blur mid-stroke now COMMITS what was drawn,
	 * through the router's `finishActiveStroke()` -> `onPenUp` -> `penUp()`,
	 * which is the rule `docs/manual.md` already states for the pdf viewer
	 * rebuilding under the pen. What this method is FOR is the teardown that
	 * really does DROP a stroke - a note switch, where the editor is already
	 * showing a different note and the old note's fragment has nowhere to
	 * land. The pdf surface's twin carries the same split for the same reason.
	 *
	 * Nothing reaches it today, and that is worth saying out loud rather than
	 * leaving for a reader to discover with a grep. Its only caller is
	 * `onStrokeAbandoned`, and the router's one remaining call site for that
	 * callback (the blur handler's second branch) can only run when no stroke
	 * was live, which is exactly when `abandonActiveStroke()` returns false.
	 * The note switch that WOULD want this runs the same teardown inline
	 * instead - `update()`'s path-change branch: `resetGestureState()`, then
	 * `stripPenUp` gated on the boolean, then the wet/tail clears and the
	 * highlighter opacity. Kept as a method, kept wired, and kept executed by
	 * `AbandonedGestureStandsDown.test.ts`, because the callback's contract is
	 * "a stroke was really torn down" and a future caller of that branch could
	 * satisfy it; on the pdf the twin is live code, called by `forgetHistory`.
	 *
	 * The strip first. Such a teardown happens inside the router, where the
	 * `stripPenDown` the contact ran left `is-inking` on the strip and its
	 * collapsed pill (styles.css: opacity 0 AND visibility hidden, so
	 * unhit-testable) until some later stroke completed. Deliberately not
	 * `penUp()`, which commits ink - and committing is exactly what a dropped
	 * stroke must not do.
	 *
	 * THEN THE SURFACE'S OWN STATE, which the chrome-only version left
	 * untouched for two releases. `builder` stays live, the half-drawn stroke
	 * stays painted on the wet layer over a note nobody drew it on, and -
	 * worst of the three because it outlives the gesture - the stroke frame
	 * stays LOCKED, which freezes the camera and every repaint until the next
	 * pen-down (the v0.13.6 lifecycle rule `resetGestureState` states in its
	 * own header). The pdf surface has the identical body under the identical
	 * name, for the identical reason.
	 */
	function strokeAbandoned(this: InkOverlayPlugin): void {
		const replayBand = this.bandSyncDeferred;
		stripPenUp(this.mobileTools, this.noteZoomControls);
		this.resetGestureState();
		this.contactEndedWithoutLift(replayBand);
	}

	/**
	 * The one tail for a contact that ends without a lift: a window blur, finger
	 * ink turned into a pinch (both through strokeAbandoned) and undo with the
	 * pen down (endLiveGestureForHistory). What the contact deferred runs now,
	 * as the lift would have run it: the band update and the pane resize the
	 * frozen frame skipped, and a zoom ease paused for the pen eases on to the
	 * cap instead of standing past it until the watchdog. A pinch that starts on
	 * the same fingers drops that ease itself (pinch, "start"), so the two do
	 * not fight. Not in resetGestureState: a note switch and an unmount run that
	 * too, and neither owes a replay.
	 *
	 * `replayBand` is read by the caller before resetGestureState clears it.
	 */
	function contactEndedWithoutLift(this: InkOverlayPlugin, replayBand: boolean): void {
		if (replayBand) this.scheduleRepaint("scroll");
		this.replayDeferredResize();
		if (this.pinchGive?.paused) this.resumePinchGive();
		this.wet.clear(this.cssWidth, this.cssHeight);
		this.highlightWet.clear(this.cssWidth, this.cssHeight);
		// A teardown mid-handoff would otherwise strand the wet highlighter
		// element hidden for every later stroke - update()'s path-change
		// branch carries this same line for the same reason.
		this.highlightWetCanvas.setCssStyles({ opacity: String(HIGHLIGHTER_ALPHA) });
		this.tail.clearAll(this.cssWidth, this.cssHeight);
		this.tail.prepareLive(null, null);
	}

	/**
	 * Undo or redo arrived with an erase, a selection drag or an insert-space
	 * drag in flight (Ctrl+Z with the pen still down). Each changes the store
	 * live and records its own step only at the lift, against a snapshot taken
	 * at pen-down that the op is about to make stale. So the gesture is put
	 * back and ended first, with the teardown a note switch uses for a gesture
	 * torn down with the pen still down (update()'s path-change branch):
	 * resetGestureState rolls the live change back and clears the gesture's
	 * state (the selection too), and the router drops the rest of the contact.
	 * The op then meets the strokes as history recorded them, and the lift has
	 * nothing to record, so the redo stack survives. An ink stroke in flight
	 * and a pan are left as they are: neither has changed the store.
	 */
	function endLiveGestureForHistory(this: InkOverlayPlugin): void {
		if (this.mode !== "erase" && this.mode !== "lasso" && this.mode !== "space") return;
		const replayBand = this.bandSyncDeferred;
		this.resetGestureState();
		this.stopFrameTicker();
		// abandonActiveStroke never calls onPenUp (the router's contract), so the
		// overlay's own state is reset above, before the router lets go.
		if (this.router?.abandonActiveStroke()) {
			stripPenUp(this.mobileTools, this.noteZoomControls);
		}
		this.contactEndedWithoutLift(replayBand);
	}

	/**
	 * An erase or a selection drag torn down with the pen still down: a file
	 * switch, a rename, a close, a window blur. Both change the store live and
	 * save and record their undo step only at pen-up, which never comes, so the
	 * change stayed on screen, reached the disk with the next save, and no undo
	 * could take it back. Put the note back as the gesture found it, as
	 * rollbackSpaceMove does for insert space, in the note the gesture began in.
	 */
	function rollbackLiveGesture(this: InkOverlayPlugin): void {
		const eraseIdentity = this.eraseHistoryIdentity, dragIdentity = this.dragHistoryIdentity;
		this.eraseHistoryIdentity = null;
		this.dragHistoryIdentity = null;
		const erasePath = eraseIdentity && this.erased.length ? inlineInk.pathForHistoryIdentity(eraseIdentity) : null;
		if (erasePath) {
			// The pieces this gesture cut come out; the originals go back where
			// the pre-gesture list had them.
			inlineInk.takeLive(erasePath, [...this.erasePieces]);
			inlineInk.applyAddLive(
				erasePath,
				this.erased.map((e) => e.stroke),
				eraseRemovalIndices(this.eraseFrom, this.erased)
			);
			this.restoredByRollback(erasePath);
		}
		const moved = this.dragTotal;
		const dragPath = dragIdentity && moved && (moved.dx !== 0 || moved.dy !== 0) && this.dragIds.length
			? inlineInk.pathForHistoryIdentity(dragIdentity) : null;
		if (dragPath && moved) {
			inlineInk.moveStrokes(dragPath, this.dragIds, -moved.dx, -moved.dy);
			this.restoredByRollback(dragPath);
		}
		this.dragIds = [];
	}

	/** A live change was undone behind the history: persist it and repaint every pane on the note. */
	function restoredByRollback(this: InkOverlayPlugin, path: string): void {
		// Persist even if another save observed the live coordinates. Store
		// guards still own write eligibility.
		inlineInk.save(path);
		this.frontierCache.invalidate(path);
		this.repaintPath(path);
		if (path === this.filePath()) this.scheduleRepaint();
	}

	/**
	 * A second finger changes intent from drawing to pinch. Clear every
	 * provisional surface without entering penUp: there is no persistence,
	 * no undo record, and no ghost wet/tail frame left behind.
	 */
	function cancelFingerInkForPinch(this: InkOverlayPlugin): void {
		// penUp normally balances both of these, but pinch cancellation must
		// never enter penUp because that commits. End only the instrumentation
		// lifecycle before clearing the provisional surface state below.
		metrics.end(performance.now(), this.tail?.resizeTotal);
		this.stopFrameTicker();
		this.strokePenGesture = false;
		this.strokeAbandoned();
	}

	function resetGestureState(this: InkOverlayPlugin): void {
		this.rollbackSpaceMove();
		this.rollbackLiveGesture();
		this.clearSnapPreview();
		// Lifecycle rule (v0.13.6 fix): every gesture-state reset releases the
		// stroke frame lock. File switch and unmount reach here mid-stroke;
		// leaving the lock held froze the NEXT note's camera and repaints
		// until its first pen-down. A cancelled frame never leaks forward.
		this.frame.cancel();
		// A font reference adoption held for this contact runs now, after the
		// cancel: while the frame is locked adoptStoredFontRef would hold it
		// again. The stroke in flight is dropped here, so nothing is reframed;
		// the note's ink takes its stored frame when the contact ends rather
		// than jumping at some later lift.
		this.releaseHeldFontRef();
		this.bandSyncDeferred = false;
		// A lift's "the band may wait" mark belongs to the note it was made on. Obsidian reuses the editor across notes, so
		// a switch reaches here without an unmount, and the next note's sideways margin must not wait for a scroll.
		this.bandGrowthMayWait = false;
		// A standing snap offer belongs to the note and the stroke it was made
		// about, and this method is every way both of those go away: a file
		// switch, an unmount (which is also what `destroy` and plugin unload
		// run) and an abandoned gesture. It takes the element out of the tree
		// AND unhooks the three listeners and the timer, none of which the
		// container's own removal would reach - they sit on the editor root,
		// the scroller and the document, all of which outlive this overlay.
		// Optional-chained because the harnesses that drive `penUp` through
		// `Object.create(prototype)` never run a field initialiser.
		this.snapChip?.dismiss();
		this.builder = null;
		this.mode = "ink";
		this.erased = [];
		// The other three erase-gesture fields, wiped here for the same reason
		// `erased` is: a file switch, an unmount or an abandoned gesture (window
		// blur, in-place switch) all reach this method with an erase mid-flight,
		// and none of them ever reach the erase pen-up that would otherwise be
		// the only place clearing them. Left alone, `erasePieces` carries the
		// abandoned gesture's minted ids into the next erase - so a stroke this
		// NEW gesture cuts for the first time is misread as a survivor rather
		// than a loss - and `eraseFrom` carries its stale pre-gesture list into
		// an undo op built for a note that isn't live anymore (deferral 3,
		// 1.4.10 design doc). `eraseWhole` is reset alongside them because it's
		// the same gesture's flag and pen-down sets all three together.
		this.erasePieces.clear();
		this.eraseFrom = [];
		this.eraseWhole = false;
		this.selection.clear();
		this.lassoPts = [];
		this.lassoActive = false;
		this.dragFrom = null;
		this.dragTotal = null;
		this.dragBox = null;
		this.spaceLineY = null;
		this.spaceIds = [];
		this.spaceBounds = null;
		this.spacePlan = null;
		this.spaceTotalDy = 0;
		this.spaceRows = null;
		this.spaceSteps = [];
		this.panLast = null;
		// The gesture is over, so the device that started it stops answering
		// for the wrappers. Reset here rather than at pen-up for the reason
		// the field's own comment gives, and in the same place the pdf's
		// `resetGestureState` resets its own.
		this.mouseStroke = false;
		this.selectionDeleteKeys.reset();
		// The empty-page refusal is NOT forgotten here, and that is the point.
		// This method is the ABANDON path too (`strokeAbandoned`: a window
		// blur, an alt-tab, a system dialog mid-scrub), and re-arming the gate
		// there brings back the spam the gate exists to stop - alt-tab away
		// mid-scrub, come back, scrub on, and the toast says it all over again,
		// on the same note with the same tool. EmptyPageNotice.ts header lists
		// what makes the sentence news again, and an interrupted gesture is not
		// on it. The two callers that really do put a fresh screen in front of
		// the reader - update()s path-change branch and unmount() - call
		// emptyNotice.forgetAll() themselves, right after this.
		this.hidePenCursor();
		this.hideEraserCursor();
	}

	/**
	 * Wipe every committed stroke on this editor's note as ONE undoable
	 * history op (the delete-all command). Same machinery as an erase: the
	 * store change is applied directly, the op captures the full strokes and
	 * indices, and undo restores everything in original z-order. The caller
	 * (main.ts) has already made the .handwriting/trash/ safety copy.
	 */
	function clearAllInk(this: InkOverlayPlugin, path: string): number | null {
		if (this.filePath() !== path) return null;
		// An erase, selection drag or insert-space drag in flight records its step at the lift, after this one, and
		// its teardown would put erased ink back: end it first, put back as undo does, so the wipe is the last step.
		this.endLiveGestureForHistory();
		const strokes = [...inlineInk.strokes(path)];
		if (strokes.length === 0) return 0;
		const indices = strokes.map((_, i) => i);
		inlineInk.applyRemove(
			path,
			strokes.map((s) => s.id)
		);
		this.dispatchInk({ type: "remove", path, strokes, indices });
		if (this.selection.clear()) this.redrawSelectionUI();
		this.scheduleRepaint();
		this.repaintPath(path);
		return strokes.length;
	}

export function installGestureEnd(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		strokeAbandoned,
		contactEndedWithoutLift,
		endLiveGestureForHistory,
		rollbackLiveGesture,
		restoredByRollback,
		cancelFingerInkForPinch,
		resetGestureState,
		clearAllInk,
	});
}
