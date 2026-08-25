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

export type InkOp =
	| {
			type: "add";
			path: string;
			strokes: InkStroke[];
			/** Insert positions for z-order restore; omitted = append. */
			indices?: number[];
	  }
	| { type: "remove"; path: string; strokes: InkStroke[]; indices: number[] }
	| { type: "move"; path: string; strokeIds: string[]; dx: number; dy: number }
	/**
	 * Partial erase (v0.13.13): strokes came out and their surviving pieces
	 * went in, as ONE step. Undo has to put the original back and take the
	 * pieces away together, which neither add nor remove can express alone.
	 * Symmetric by construction: the inverse just swaps the two halves.
	 */
	| {
			type: "replace";
			path: string;
			removed: InkStroke[];
			removedAt: number[];
			inserted: InkStroke[];
			insertedAt: number[];
	  };

export const inkEffect = StateEffect.define<InkOp>();

/** Marks a dispatch whose change is already in the store (the live gesture). */
export const inkApplied = Annotation.define<boolean>();

export function invertInkOp(op: InkOp): InkOp {
	switch (op.type) {
		case "add":
			return {
				type: "remove",
				path: op.path,
				strokes: op.strokes,
				indices: op.indices ?? [],
			};
		case "remove":
			return { type: "add", path: op.path, strokes: op.strokes, indices: op.indices };
		case "move":
			return {
				type: "move",
				path: op.path,
				strokeIds: op.strokeIds,
				dx: -op.dx,
				dy: -op.dy,
			};
		case "replace":
			return {
				type: "replace",
				path: op.path,
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
