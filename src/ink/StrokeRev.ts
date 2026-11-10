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

let list = 0;

/**
 * The stroke-list revision: moves when a store's list changes in place (an add, a remove, a replace), never when a stroke
 * moves or takes a new shape in place. A list kept beside this number holds the same objects in the same places while it
 * stands.
 */
export function inkListRevision(): number {
	return list;
}

/** Record that a stroke list changed in place: which objects it holds, or where. */
export function bumpInkListRevision(): void {
	list++;
}

/** The stroke's current revision. Never mutated = 0. */
export function strokeRev(stroke: InkStroke): number {
	return revs.get(stroke) ?? 0;
}

const sources = new WeakMap<InkStroke, InkStroke>();

/**
 * Record that `copy` shows `of` moved (a line or group correction): a cache keyed on the store's stroke reads
 * the copy's source and that source's revision. A copy of a copy names the first source.
 */
export function markCopy(copy: InkStroke, of: InkStroke): void {
	sources.set(copy, sources.get(of) ?? of);
}

/** The store stroke a shown copy was made from; the stroke itself when it is no copy. */
export function sourceOf(stroke: InkStroke): InkStroke {
	return sources.get(stroke) ?? stroke;
}

/** Record that this stroke's geometry changed under its own identity. */
export function bumpStrokeRev(stroke: InkStroke): void {
	revs.set(stroke, (revs.get(stroke) ?? 0) + 1);
	ink++;
}

/**
 * Record that a shown copy moved in place (a group's correction changed): its own revision moves, so the
 * ribbon caches draw it at its new place, and the ink revision does not, as no store stroke or store list changed. Lists
 * of shown copies are keyed on the follow's generation, which the move bumps.
 */
export function bumpCopyRev(copy: InkStroke): void {
	revs.set(copy, (revs.get(copy) ?? 0) + 1);
}
