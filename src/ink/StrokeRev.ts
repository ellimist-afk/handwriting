import { InkStroke } from "./Stroke";

/**
 * A revision number per stroke OBJECT, so a cache keyed on a stroke can tell
 * "the same stroke" from "the same stroke, moved".
 *
 * Why this exists: committed strokes are MUTATED IN PLACE. A lasso drag, an
 * insert-space drag and the undo/redo of either all translate the points of
 * the very objects already in the store rather than replacing them
 * (`translateStroke`, objects/Selection.ts, reached from
 * `InlineInkStore.moveStrokes` and `ObjectOps.moveObjects`). Anything that
 * remembers derived geometry against object identity alone - the ribbon cache
 * in StrokeRenderer is the first - would therefore serve geometry computed at
 * the old position, and the ink would render where it WAS. The revision is
 * the key that makes such a cache correct: bump it wherever a stroke changes
 * under its own identity, and every cache keyed on it misses exactly once.
 *
 * The registry is a WeakMap, so it holds nothing alive: a stroke that is
 * erased, or a note that is closed, takes its entry with it. A stroke with no
 * entry reads 0, which is why nothing has to seed newly built strokes.
 *
 * The rule for anyone adding a mutation: if you write `stroke.points`,
 * `stroke.bbox`, `stroke.width` or `stroke.color` on a stroke that is already
 * in a store, bump here in the same breath. Building a NEW stroke object
 * (the eraser's surviving pieces, a shape snap's clean shape, a sidecar
 * parse) needs no bump - a new object is a new key.
 */

const revs = new WeakMap<InkStroke, number>();

/**
 * One revision for all ink. Every stroke's bump moves it, and so does every
 * in-place change to a stroke list a store hands out (an add, a remove, a
 * replace). A cache that holds the same list object at the same length and
 * the same ink revision therefore holds the same strokes at the same
 * revisions, and confirms that in one compare instead of one per stroke.
 * It is shared by every note: a change in another note costs a cache one
 * full check, never a wrong answer.
 */
let ink = 0;

/** The ink revision: moves whenever any stroke or any store's list changes. */
export function inkRevision(): number {
	return ink;
}

/** Record that a stroke list changed in place (an add, a remove, a replace). */
export function bumpInkRevision(): void {
	ink++;
}

/** The stroke's current revision. Never mutated = 0. */
export function strokeRev(stroke: InkStroke): number {
	return revs.get(stroke) ?? 0;
}

/** Record that this stroke's geometry changed under its own identity. */
export function bumpStrokeRev(stroke: InkStroke): void {
	revs.set(stroke, (revs.get(stroke) ?? 0) + 1);
	ink++;
}
