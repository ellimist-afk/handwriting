import { PageData } from "../model/PageData";

/**
 * Union two revisions of ONE page so that nothing already on disk is dropped.
 *
 * WHY THIS EXISTS. The canvas shares the `PageStore` but not the model: each
 * `HandwritingPageView` holds its own `PageDocument`, so two panes on one page
 * both call `store.schedule(pageId, ownPage)` and the second one's page never
 * saw the first one's strokes. `PageStore`'s external-revision guard cannot see
 * that — it asks "is the file on disk the one this session last read or wrote",
 * and a second IN-PROCESS writer is the same session, so it answers correctly
 * and silently answers the wrong question. See PageStoreTwoDocuments.test.ts.
 *
 * THE RULE. `mine` wins for everything it has an opinion about: every scalar
 * field, and every object whose id it carries. `disk` contributes exactly the
 * objects `mine` does not have by id. So the result is `mine` plus whatever the
 * other writer added since the two last agreed.
 *
 * THE PROPERTY THAT MAKES THIS SAFE, and the reason it is a union rather than
 * something cleverer: the result is always a SUPERSET of `mine`, and `mine` is
 * exactly what today's code writes. A merge can therefore only ADD content
 * relative to the behaviour it replaces — it can never remove any. Whatever it
 * gets wrong, it cannot lose ink, which is the one unrecoverable failure.
 *
 * THE COST, stated rather than discovered later: a DELETE by one writer that
 * the other writer has not seen is undone. Pane A erases a stroke and saves;
 * pane B still shows it (there is no cross-pane fan-out on the canvas — that is
 * the same defect) and saves; the stroke comes back. That is NOT a regression:
 * today B's write resurrects it too, because B's page still holds it. It is the
 * same outcome by a different route, and distinguishing "deleted" from "never
 * seen" needs per-writer version vectors, which this layer does not have.
 *
 * Only called when the store knows the file was last written by a DIFFERENT
 * in-process writer. One writer's saves never come through here, so a single
 * open pane deleting a stroke deletes it.
 */
export function mergePages(disk: PageData, mine: PageData): PageData {
	const strokes = keepMissing(disk.strokes, mine.strokes);
	const textBoxes = keepMissing(disk.textBoxes, mine.textBoxes);
	const images = keepMissing(disk.images, mine.images);
	if (strokes.length === 0 && textBoxes.length === 0 && images.length === 0) {
		// Nothing on disk that `mine` lacks: the writers agree about content,
		// so hand back the caller's own object untouched rather than an equal
		// copy. `pending` holds live references and identity is cheap to keep.
		return mine;
	}
	return {
		...mine,
		// Appended, not interleaved. Array order is paint order for strokes, so
		// the other writer's ink lands on top of ours; z governs boxes and
		// images, so their order here does not matter. Interleaving would need
		// a shared clock the two documents do not have.
		strokes: [...mine.strokes, ...strokes],
		textBoxes: [...mine.textBoxes, ...textBoxes],
		images: [...mine.images, ...images],
		// A newer build's fields, per §"unknownTop": ours wins key by key, and
		// the disk copy contributes keys we do not carry. Both documents were
		// parsed from the same file, so in practice these are equal; the merge
		// is written so that an unequal pair still loses nothing.
		unknownTop: { ...disk.unknownTop, ...mine.unknownTop },
		// Keyed by object id, so the entries that travel with a recovered
		// object must travel with it. Ours still wins on a shared id.
		unknownByObject: { ...disk.unknownByObject, ...mine.unknownByObject },
	};
}

/** The entries of `theirs` whose id no entry of `ours` already carries. */
function keepMissing<T extends { id: string }>(theirs: readonly T[], ours: readonly T[]): T[] {
	if (theirs.length === 0) return [];
	const have = new Set(ours.map((o) => o.id));
	return theirs.filter((t) => !have.has(t.id));
}
