/**
 * The note surface's keyboard handlers and the mouse Snap chip: key down, key up and paste, and the chip
 * offered after a snapped mouse stroke, taken by click or by key. They are methods of InkOverlayPlugin,
 * installed on its prototype when InkOverlay.ts loads.
 */
import { Notice } from "obsidian";
import { markerIsCurrent, markerToken } from "./InkClipboard";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { routineNoticesVisible } from "../diag/RoutineNotices";
import { InkStroke } from "../ink/Stroke";
import { snapReplaceOp } from "./InkHistory";
import { beginUndoWindow, isUndoRedoKey, registerUndoTraceView, unregisterUndoTraceView } from "../diag/UndoHistoryTrace";
import { installMethods } from "./InstallMethods";
import { cutSelectionNotice, cutSelectionNoticeIsRoutine, inlineInk, peelInkEscapeFloor, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		handleKeyDown(event: KeyboardEvent): boolean;
		handlePaste(event: ClipboardEvent): boolean;
		handleKeyUp(event: KeyboardEvent): boolean;
		offerSnapChip(path: string, freehand: InkStroke, snapped: InkStroke): void;
		takeSnapOffer(path: string, freehand: InkStroke, snapped: InkStroke): void;
	}
}

	function handleKeyDown(this: InkOverlayPlugin, event: KeyboardEvent): boolean {
		if (event.key === "Escape" && event.defaultPrevented) return false;
		this.retirePanSettle("keyboard");
		const undoKind = diagnosticsEnabled() ? isUndoRedoKey(event) : null;
		if (undoKind) {
			if (this.undoIdentityStale) {
				unregisterUndoTraceView(this.view.dom);
				this.undoIdentityStale = false;
			}
			this.undoIdentity ??= registerUndoTraceView(this.view.dom, {});
			const selection = this.view.state.selection.main;
			const target = event.target instanceof Element && this.view.dom.contains(event.target) ? "editor" : "other";
			beginUndoWindow(this.undoIdentity, {
				kind: undoKind,
				key: {
					key: event.key.toLowerCase() as "z" | "y",
					ctrl: event.ctrlKey,
					meta: event.metaKey,
					shift: event.shiftKey,
					alt: event.altKey,
					defaultPrevented: event.defaultPrevented,
					target,
				},
				selection: {
					from: selection.from,
					to: selection.to,
					anchor: selection.anchor,
					head: selection.head,
					empty: selection.empty,
				},
				scroll: { x: this.view.scrollDOM.scrollLeft, y: this.view.scrollDOM.scrollTop, phase: "before", axes: "" },
			});
		}
		// Escape deselects, like everywhere else lassos exist.
		if (event.key === "Escape" && !this.selection.isEmpty) {
			this.selection.clear();
			this.redrawSelectionUI();
			this.mobileTools?.refresh();
			event.preventDefault();
			return true;
		}
		// ...and with nothing selected, Escape leaves whatever mode has the
		// tip. Landing in pan or insert space used to strand you until you
		// found the Pen button; Escape is what a hand reaches for, and the
		// nib it returns to is the one that was already chosen.
		if (peelInkEscapeFloor(event)) return true;
		// Ctrl/Cmd+C and X act on lassoed INK while any is selected: that is
		// what a lasso means everywhere else (orion 2026-08-26: ctrl+c after
		// a lasso copied nothing, and a stale ink clipboard pasted a page).
		// Mod-V stays the editor's - pasting text with nothing selected is
		// normal, so ink paste keeps its command and its strip button.
		// Only while the EDITOR's own selection is empty: someone who lassoed
		// ink and then swept text with the mouse means the text when they
		// press ctrl+c, and stealing that copy would be the worse surprise.
		if (
			(event.ctrlKey || event.metaKey) &&
			!event.altKey &&
			!this.selection.isEmpty &&
			this.view.state.selection.main.empty
		) {
			const k = event.key.toLowerCase();
			if (k === "c" || k === "x") {
				if (k === "c") {
					const n = this.copySelectedInk();
					if (n > 0) {
						event.preventDefault();
						if (routineNoticesVisible()) new Notice(`Handwriting: copied ${n} stroke(s)`);
						// The strip's paste button wakes now, without waiting for
						// the next tap or stroke.
						this.mobileTools?.refresh();
						return true;
					}
				} else {
					// Cut answers an outcome now, not a count: a copy that worked
					// followed by a removal that did not is neither a cut nor an
					// empty lasso, and `cutSelectionNotice` is what says so.
					const outcome = this.cutSelectedInk();
					if (outcome.kind !== "empty") {
						event.preventDefault();
						if (routineNoticesVisible() || !cutSelectionNoticeIsRoutine(outcome))
							new Notice(cutSelectionNotice(outcome));
						this.mobileTools?.refresh();
						return true;
					}
				}
			}
		}
		return this.selectionDeleteKeys.keydown(event);
	}

	/**
	 * Ctrl+V (and right-click paste, and a clipboard manager's history)
	 * pastes INK when the system clipboard carries our marker. Anything
	 * else is somebody's text and passes straight through, which is what
	 * makes this safe: copying text after ink pastes the text.
	 */
	function handlePaste(this: InkOverlayPlugin, event: ClipboardEvent): boolean {
		const text = event.clipboardData?.getData("text/plain") ?? "";
		if (text === "" || markerToken(text) === null) return false;
		// Ours either way now: the marker is bookkeeping, and letting it
		// land in a note as literal text would be the worse outcome.
		event.preventDefault();
		event.stopPropagation();
		if (!markerIsCurrent(text)) {
			// A marker outliving the ink it named: a clipboard manager
			// replaying an entry from a previous run of the app.
			new Notice("Handwriting: that ink was copied before the app restarted");
			return true;
		}
		const n = this.pasteInkHere();
		if (n > 0 && routineNoticesVisible()) new Notice(`Handwriting: pasted ${n} stroke(s)`);
		return true;
	}

	function handleKeyUp(this: InkOverlayPlugin, event: KeyboardEvent): boolean {
		return this.selectionDeleteKeys.keyup(event);
	}

	/**
	 * Put the Snap button beside a mouse stroke that just landed.
	 *
	 * The coordinates are `rawLastMoveX/Y` - the last place the pointer
	 * actually MOVED, in the overlay container's own space, the same space the
	 * hover reticle is translated in. For the stroke that raises this chip
	 * they ARE the end of the stroke: a mouse that dwelled did not move again
	 * before the button came up, which is the whole reason the dwell fired.
	 * Using the raw layer rather than the stored points also skips the
	 * builder's min-distance filter, which discards exactly the stationary
	 * samples at the end.
	 */
	function offerSnapChip(this: InkOverlayPlugin, path: string, freehand: InkStroke, snapped: InkStroke): void {
		const parent = this.container;
		if (!parent) return;
		this.snapChip.offer(
			{
				parent,
				// One node OUT from the scroller: the pen router's own
				// pointerdown is a CAPTURE listener on the scroller itself, and
				// a second capture listener on the same node would run after
				// it. SnapChip.ts's header says what that would cost.
				guardRoot: this.view.dom,
				scroller: this.view.scrollDOM,
				keyRoot: this.view.dom.ownerDocument,
				pane: this.visibleBandArea(parent),
				// The EDITOR's window, not the global one: a popped-out pane
				// has its own, and a timer from the wrong one is a timer that
				// keeps running over a closed window.
				clock: this.winRef,
			},
			this.rawLastMoveX,
			this.rawLastMoveY,
			() => this.takeSnapOffer(path, freehand, snapped)
		);
	}

	/**
	 * The offer accepted: the freehand comes out, the fitted figure goes in at
	 * the same depth, and the history gets THE SAME `replace` the pen's dwell
	 * snap publishes (`snapReplaceOp`, InkHistory.ts).
	 *
	 * One op and not two, and that is not a shortcut: the mouse's freehand was
	 * committed as drawn, so its `add` already went into the history at
	 * pen-up. The pen's snap has to invent that landing because its freehand
	 * never reached the store at all. Either way the reader gets the same two
	 * presses - the first undo un-snaps back to the freehand, the second
	 * removes it.
	 *
	 * REFUSES A STALE OFFER. Between the chip appearing and the click, the
	 * stroke can be undone or erased from another pane. `findIndex` answering
	 * -1 means the thing this offer was about is gone, and replacing nothing
	 * would insert the figure out of nowhere.
	 */
	function takeSnapOffer(this: InkOverlayPlugin, path: string, freehand: InkStroke, snapped: InkStroke): void {
		const at = inlineInk.strokes(path).findIndex((s) => s.id === freehand.id);
		if (at < 0) return;
		// Same order as `applyInkOp`'s replace leg, for the reason written
		// there: out first, or the index the op carries names a list that no
		// longer exists.
		// The clean shape sits on the freehand stroke's line.
		if (freehand.lineAnchor && !snapped.lineAnchor) this.lineAnchors.inherit(snapped, freehand);
		inlineInk.takeLive(path, [freehand.id]);
		inlineInk.applyAddLive(path, [snapped], [at]);
		// Publish once, after the complete replacement is visible to subscribers.
		inlineInk.save(path);
		// The eraser answers from `strokeIndex`, and a swap it never heard
		// about leaves it hit-testing a stroke that is gone - the 1.4.6 defect
		// `InlineEraseFresh.test.ts` exists over.
		this.indexDirty = true;
		this.dispatchInk(snapReplaceOp(path, freehand, [snapped], at));
		this.scheduleRepaint();
		this.repaintPath(path);
		this.updateExtent(true);
	}

export function installKeys(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		handleKeyDown,
		handlePaste,
		handleKeyUp,
		offerSnapChip,
		takeSnapOffer,
	});
}
