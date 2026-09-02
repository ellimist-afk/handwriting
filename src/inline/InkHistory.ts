import { invertedEffects } from "@codemirror/commands";
import { Annotation, StateEffect } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { InkStroke } from "../ink/Stroke";

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
 * Optional because an unclaimed note has no id yet, and because ops recorded
 * by an older build are still in the editor's history after an update; both
 * fall back to `path`, which is what they always used.
 */
export interface InkOpIdentity {
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
		{
			type: "replace",
			path,
			removed: [freehand],
			removedAt: [at],
			inserted: snapped,
			insertedAt: [at],
		},
	];
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
		// pageId travels through every inverse: an op that loses it on the
		// way to the undo stack is one rename away from the bug it exists to
		// prevent, and redo would be the leg that got it wrong.
		case "add":
			return {
				type: "remove",
				path: op.path,
				pageId: op.pageId,
				strokes: op.strokes,
				indices: op.indices ?? [],
			};
		case "remove":
			return {
				type: "add",
				path: op.path,
				pageId: op.pageId,
				strokes: op.strokes,
				indices: op.indices,
			};
		case "move":
			return {
				type: "move",
				path: op.path,
				pageId: op.pageId,
				strokeIds: op.strokeIds,
				dx: -op.dx,
				dy: -op.dy,
			};
		case "replace":
			return {
				type: "replace",
				path: op.path,
				pageId: op.pageId,
				removed: op.inserted,
				removedAt: op.insertedAt,
				inserted: op.removed,
				insertedAt: op.removedAt,
			};
	}
}

/** The facet registration that makes the editor history invert ink ops. */
export function inkHistorySupport(): Extension {
	return invertedEffects.of((tr) => {
		const inverted: StateEffect<InkOp>[] = [];
		for (const effect of tr.effects) {
			if (effect.is(inkEffect)) inverted.push(inkEffect.of(invertInkOp(effect.value)));
		}
		return inverted;
	});
}
