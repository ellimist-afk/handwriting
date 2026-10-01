import { invertedEffects } from "@codemirror/commands";
import { Annotation, Prec, StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { InkStroke } from "../ink/Stroke";
import { diagnosticsEnabled, diagnosticsEpoch } from "../diag/DiagSwitch";
import { queueUndoPostObservation, recordUndoObservation, undoTraceIdentityForView } from "../diag/UndoHistoryTrace";

/**
 * Ink operations as CodeMirror history citizens.
 *
 * Obsidian's editor undo IS CodeMirror's history, so the way to make normal
 * Ctrl+Z / Redo cover ink, without a separate Handwriting command and without
 * breaking Markdown undo, is to make every ink operation a history entry in
 * the editor it happened in. Each finished gesture (a stroke, an erase, a
 * lasso move) is dispatched as a doc-less transaction carrying one `inkEffect`;
 * the `invertedEffects` facet below tells the history how to invert it, and
 * from there undo/redo re-dispatch the (inverse) effects in true chronological
 * order, interleaved with text edits exactly the way a user expects "normal
 * undo" to behave.
 *
 * Two rules keep this honest:
 *
 * - **Ops capture their operands.** An add/remove carries the full stroke
 *   objects (and original indices, so z-order survives); a move carries the
 *   id list frozen at gesture end. Undo never consults the live selection,
 *   the exact failure the canvas-era move op was rebuilt to prevent.
 * - **Ops capture their note.** The `path` rides in the op, so an undo pressed
 *   after the pane switched files still acts on the note where the ink lives,
 *   never on whatever happens to be on screen.
 *
 * The original gesture applies its change to the store directly (the wet →
 * committed handoff must not wait a frame), so original dispatches carry the
 * `inkApplied` annotation and the applier skips them. Undo/redo dispatches
 * come from the history without the annotation and are applied. Idempotence
 * is therefore by construction, not by guesswork.
 */

/**
 * The note an op belongs to, by IDENTITY rather than by location.
 *
 * `path` is where the note was when the op was recorded, and an op outlives
 * that: the editor keeps its history across a rename, so an undo pressed
 * afterwards named a path nothing lives at any more. The ink was not
 * restored on the real note, and a note later created at the old name
 * inherited it. The page id does not move when the file does.
 *
 * Live inline ops carry a session-only record token, available before the
 * first durable claim. It follows renames and page-id reassignment without
 * retaining the record or its ink arrays. Removing the record invalidates
 * the token; replay must then skip, even if the path or page id is reused.
 *
 * Both fields are optional for legacy and PDF callers: without a token,
 * resolve the page id when supplied, otherwise use the captured path.
 */
export interface InkOpIdentity {
	historyIdentity?: symbol;
	pageId?: string;
}

export type InkOp =
	| ({
			type: "add";
			path: string;
			strokes: InkStroke[];
			/** Insert positions for z-order restore; omitted = append. */
			indices?: number[];
	  } & InkOpIdentity)
	| ({ type: "remove"; path: string; strokes: InkStroke[]; indices: number[] } & InkOpIdentity)
	| ({ type: "move"; path: string; strokeIds: string[]; dx: number; dy: number } & InkOpIdentity)
	/**
	 * Partial erase (v0.13.13): strokes came out and their surviving pieces
	 * went in, as ONE step. Undo has to put the original back and take the
	 * pieces away together, which neither add nor remove can express alone.
	 * Symmetric by construction: the inverse just swaps the two halves.
	 */
	| ({
			type: "replace";
			path: string;
			removed: InkStroke[];
			removedAt: number[];
			inserted: InkStroke[];
			insertedAt: number[];
	  } & InkOpIdentity);

/**
 * The history a shape snap leaves behind: TWO steps, not one.
 *
 * The snap commits the clean shape straight to the store, so the freehand
 * the pen actually drew never existed there. Publishing only the `replace`
 * (the shipped behaviour through 1.2.0) therefore recorded a swap whose
 * "before" side was never added by anything: the first undo dutifully put
 * the freehand back, and then there was no second step to press, so the
 * stroke sat in the note un-removable by undo (alan, 2026-08-27).
 *
 * Two ops fix it by making the history tell the truth about what happened:
 * the stroke landed, then the snap replaced it. Undo peels them off in
 * order - first back to freehand, then gone - and redo re-lays them the
 * same way.
 */
export function snapHistoryOps(
	path: string,
	freehand: InkStroke,
	snapped: InkStroke[],
	at: number
): InkOp[] {
	return [
		{ type: "add", path, strokes: [freehand], indices: [at] },
		snapReplaceOp(path, freehand, snapped, at),
	];
}

/**
 * The swap itself: the freehand out, the fitted figure in, at the same depth.
 *
 * Named once and reached two ways, because a MOUSE takes the same snap by a
 * different route (SnapChip.ts). The pen's dwell replaces the stroke before
 * it is ever committed, so its history has to invent the landing as well as
 * the swap - that is what `snapHistoryOps` above is. A mouse stroke is
 * committed as drawn first and its `add` has already gone into the history by
 * the time the Snap chip is pressed, so the chip publishes THIS op alone and
 * the two undo steps Alan gets are the same two: back to the freehand, then
 * gone. What must never happen is a second, separately-written replace
 * drifting from this one - the un-snap is the half that has already been got
 * wrong once (alan, 2026-08-27).
 */
export function snapReplaceOp(
	path: string,
	freehand: InkStroke,
	snapped: InkStroke[],
	at: number
): InkOp {
	return {
		type: "replace",
		path,
		removed: [freehand],
		removedAt: [at],
		inserted: snapped,
		insertedAt: [at],
	};
}

export const inkEffect = StateEffect.define<InkOp>();

/** Marks a dispatch whose change is already in the store (the live gesture). */
export const inkApplied = Annotation.define<boolean>();

/**
 * Where the strokes an erase gesture removed sat BEFORE it started.
 *
 * The eraser takes strokes out one pointer sample at a time, and each removal
 * reports the position the stroke held in whatever the list contained at that
 * instant. Those numbers do not share a frame of reference: the second stroke
 * a drag crossed was recorded against a list already short by the first, so
 * undoing a multi-stroke erase put the ink back at the wrong depth - and the
 * more a single drag erased, the further out it got.
 *
 * A `replace` op's indices have to name ONE list, and the only one that means
 * anything when the op is applied or inverted is the list as the gesture
 * found it. A stroke missing from that list keeps the index its removal
 * reported, which is what this always used.
 */
export function eraseRemovalIndices(
	before: readonly InkStroke[],
	erased: ReadonlyArray<{ stroke: InkStroke; index: number }>
): number[] {
	return erased.map((e) => {
		const at = before.indexOf(e.stroke);
		return at >= 0 ? at : e.index;
	});
}

export function invertInkOp(op: InkOp): InkOp {
	switch (op.type) {
		// Both identities travel through every inverse, including redo.
		case "add":
			return {
				type: "remove",
				path: op.path,
				historyIdentity: op.historyIdentity,
				pageId: op.pageId,
				strokes: op.strokes,
				indices: op.indices ?? [],
			};
		case "remove":
			return {
				type: "add",
				path: op.path,
				historyIdentity: op.historyIdentity,
				pageId: op.pageId,
				strokes: op.strokes,
				indices: op.indices,
			};
		case "move":
			return {
				type: "move",
				path: op.path,
				historyIdentity: op.historyIdentity,
				pageId: op.pageId,
				strokeIds: op.strokeIds,
				dx: -op.dx,
				dy: -op.dy,
			};
		case "replace":
			return {
				type: "replace",
				path: op.path,
				historyIdentity: op.historyIdentity,
				pageId: op.pageId,
				removed: op.inserted,
				removedAt: op.insertedAt,
				inserted: op.removed,
				insertedAt: op.removedAt,
			};
	}
}

/**
 * Is this an ink step, including one a previous load of the plugin wrote?
 *
 * An update, or switching the plugin off and on with a note open, runs
 * main.js again and defines a new `inkEffect` type, but the editor's history
 * keeps the entries the old one wrote. Those can no longer be applied or
 * inverted, and their undo changes nothing on the page; what it must not do is
 * move the caret and scroll to where the caret was when that ink was drawn
 * (audit 161). So the viewport guard below also knows an ink op by its shape.
 */
function isInkStep(effect: StateEffect<unknown>): boolean {
	if (effect.is(inkEffect)) return true;
	const op = effect.value as Record<string, unknown> | null;
	if (!op || typeof op !== "object" || typeof op.path !== "string") return false;
	switch (op.type) {
		case "add":
		case "remove":
			return Array.isArray(op.strokes);
		case "move":
			return Array.isArray(op.strokeIds) && typeof op.dx === "number" && typeof op.dy === "number";
		case "replace":
			return Array.isArray(op.removed) && Array.isArray(op.inserted);
		default:
			return false;
	}
}

/** The facet registration that makes the editor history invert ink ops. */
export function inkHistorySupport(): Extension {
	return [invertedEffects.of((tr) => {
		const inverted: StateEffect<InkOp>[] = [];
		for (const effect of tr.effects) {
			if (effect.is(inkEffect)) inverted.push(inkEffect.of(invertInkOp(effect.value)));
		}
		return inverted;
	}), Prec.highest(EditorView.updateListener.of((update) => {
		const [tr] = update.transactions;
		const diagnostic = diagnosticsEnabled();
		if (diagnostic) {
			for (const [index, transaction] of update.transactions.entries()) {
				const userEvent = transaction.isUserEvent("undo") ? "undo" : transaction.isUserEvent("redo") ? "redo" : "other";
				const inkEffectCount = transaction.effects.filter((effect) => effect.is(inkEffect)).length;
				recordUndoObservation(undoTraceIdentityForView(update.view.dom), {
					phase: "transaction",
					transaction: {
						sequence: index + 1,
						count: update.transactions.length,
						userEvent,
						docChanged: transaction.docChanged,
						inkEffectCount,
						foreignEffectCount: transaction.effects.length - inkEffectCount,
					},
				});
			}
		}
		if (diagnostic) {
			let reason:
				| "stale-view"
				| "multiple-transactions"
				| "no-transaction"
				| "document-change"
				| "non-history-transaction"
				| "no-effects"
				| "foreign-effects"
				| null = null;
			if (update.view.state !== update.state) reason = "stale-view";
			else if (update.transactions.length !== 1) reason = "multiple-transactions";
			else if (!tr) reason = "no-transaction";
			else if (tr.docChanged) reason = "document-change";
			else if (!(tr.isUserEvent("undo") || tr.isUserEvent("redo"))) reason = "non-history-transaction";
			else if (tr.effects.length === 0) reason = "no-effects";
			else if (!tr.effects.every(isInkStep)) reason = "foreign-effects";
			if (reason) {
				recordUndoObservation(undoTraceIdentityForView(update.view.dom), { phase: "transaction", guard: { decision: "skip", stage: "observed", reason } });
				return;
			}
		}
		if (!diagnostic && (update.view.state !== update.state || update.transactions.length !== 1 || !tr ||
			tr.docChanged || !(tr.isUserEvent("undo") || tr.isUserEvent("redo")) ||
			tr.effects.length === 0 || !tr.effects.every(isInkStep))) return;
		// History bypasses transaction filters. Its effect-only undo still
		// asks the view to reveal the old text caret, which may be pages away
		// from the ink. Replace that pending scroll with the current viewport
		// before the view measures it; no timer or extra history step.
		// A later listener's transaction takes precedence over this update.
		if (diagnostic) recordUndoObservation(undoTraceIdentityForView(update.view.dom), {
			phase: "transaction",
			guard: { decision: "restore", stage: "request", reason: "effect-only-history" },
		});
		update.view.dispatch({
			selection: update.startState.selection,
			effects: update.view.scrollSnapshot(),
			annotations: Transaction.addToHistory.of(false),
		});
		if (diagnostic) {
			const view = update.view;
			const identity = undoTraceIdentityForView(view.dom);
			const epoch = diagnosticsEpoch();
			queueUndoPostObservation(identity, epoch, () => ({
					phase: "post",
					guard: { decision: "restore", stage: "observed", reason: "effect-only-history" },
					selection: {
						from: view.state.selection.main.from,
						to: view.state.selection.main.to,
						anchor: view.state.selection.main.anchor,
						head: view.state.selection.main.head,
						empty: view.state.selection.main.empty,
					},
					scroll: { x: view.scrollDOM.scrollLeft, y: view.scrollDOM.scrollTop, phase: "after", axes: "" },
			}));
		}
	}))];
}
