/**
 * Undo and redo for ink on a PDF.
 *
 * Notes get this for free: their ink operations are dispatched into
 * CodeMirror's history, so Ctrl+Z already interleaves ink with text edits in
 * true chronological order. There is no CodeMirror under a PDF, so the ring
 * lives here.
 *
 * Two decisions, both taken by looking at what the note surface already does
 * rather than by reasoning from first principles:
 *
 * - **Per view, not per document.** CodeMirror's history is per editor view,
 *   so two panes on one note already have separate histories while sharing
 *   one set of ink. Making PDFs behave differently would be a worse surprise
 *   than the rare cross-pane one, because "why does undo work differently
 *   here" is a question every user can ask and few can answer.
 * - **Every op carries its document.** `InkOp.path` holds the pdf id. The
 *   note surface's rule is that "ops capture their note ... so an undo
 *   pressed after the pane switched files still acts on the note where the
 *   ink lives, never on whatever happens to be on screen". The same hazard
 *   exists here and is worse: putting strokes back into the wrong PDF is
 *   silent corruption, not a surprise.
 *
 * The ring is bounded. An unbounded one is a memory leak that only shows up
 * after a long session, which is exactly when losing work hurts most.
 */

import { InkStroke } from "../ink/Stroke";
import { InkOp, invertInkOp } from "../inline/InkHistory";

/** How many operations one view remembers. */
export const HISTORY_LIMIT = 100;

/**
 * Apply one operation to a stroke list, returning a new list.
 *
 * Pure, and the reason the rest of this is testable: undo correctness is
 * entirely about whether the inverse of an op restores the list exactly,
 * z-order included, and that is a property of arrays rather than of canvases.
 */
export function applyOp(strokes: readonly InkStroke[], op: InkOp): InkStroke[] {
	const out = [...strokes];
	switch (op.type) {
		case "add": {
			// Indices restore z-order: a stroke that was third stays third, or
			// undoing an erase would bring ink back on top of what covered it.
			if (!op.indices) return [...out, ...op.strokes];
			const pairs = op.strokes.map((s, i) => ({ s, at: op.indices![i] ?? out.length }));
			pairs.sort((a, b) => a.at - b.at);
			for (const { s, at } of pairs) out.splice(Math.min(at, out.length), 0, s);
			return out;
		}
		case "remove": {
			const gone = new Set(op.strokes.map((s) => s.id));
			return out.filter((s) => !gone.has(s.id));
		}
		case "move": {
			const moving = new Set(op.strokeIds);
			return out.map((s) =>
				moving.has(s.id)
					? {
							...s,
							points: s.points.map((p) => ({ ...p, x: p.x + op.dx, y: p.y + op.dy })),
							bbox: { ...s.bbox, x: s.bbox.x + op.dx, y: s.bbox.y + op.dy },
						}
					: s
			);
		}
		case "replace": {
			const gone = new Set(op.removed.map((s) => s.id));
			const kept = out.filter((s) => !gone.has(s.id));
			const pairs = op.inserted.map((s, i) => ({ s, at: op.insertedAt[i] ?? kept.length }));
			pairs.sort((a, b) => a.at - b.at);
			for (const { s, at } of pairs) kept.splice(Math.min(at, kept.length), 0, s);
			return kept;
		}
	}
}

/**
 * One view's operation ring.
 *
 * Records what happened; hands back the INVERSE to apply. The caller owns the
 * strokes and applies the result, so this never touches a store - which is
 * what keeps it pure enough to test the interesting property directly: that
 * undo then redo lands exactly where it started.
 */
export class PdfInkHistory {
	private done: InkOp[] = [];
	private undone: InkOp[] = [];

	/** A gesture happened. Anything that was undone is no longer reachable. */
	record(op: InkOp): void {
		this.done.push(op);
		if (this.done.length > HISTORY_LIMIT) this.done.shift();
		// A new action after an undo forks the timeline. Keeping the redo
		// stack would let Ctrl+Y paste in work from a branch the user
		// abandoned, on top of what they did instead.
		this.undone = [];
	}

	/** The operation to apply to undo the last one, or null. */
	undo(): InkOp | null {
		const op = this.done.pop();
		if (!op) return null;
		this.undone.push(op);
		return invertInkOp(op);
	}

	/** The operation to apply to redo, or null. */
	redo(): InkOp | null {
		const op = this.undone.pop();
		if (!op) return null;
		this.done.push(op);
		return op;
	}

	get depth(): { done: number; undone: number } {
		return { done: this.done.length, undone: this.undone.length };
	}

	clear(): void {
		this.done = [];
		this.undone = [];
	}
}
