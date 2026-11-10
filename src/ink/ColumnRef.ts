/**
 * THE WIDTH A NOTE'S TEXT COLUMN IS HELD AT.
 *
 * Ink is drawn against the text as it wrapped then. A line anchor (Stroke.ts) is honoured only at the content width it was
 * taken at, so a note opened at another width (an app zoom, a wider window, a sidebar closed) re-wraps its text and shows its
 * ink at its page position: under the wrong words, a row or more off. With Infinite Canvas on, the note surface keeps the
 * column at one width instead, and the page stores that width as `columnRefPx` beside `fontRefPx` (PageData.ts).
 *
 * A note that predates the field takes the width most of its anchors carry, the first stroke in the file breaking a tie, and
 * keeps it at its next ordinary save. A note with no anchored stroke has no width, and nothing is held.
 */
import type { InkStroke } from "./Stroke";

/** A width that can be held: a whole number of layout px above zero. */
export function validColumnRef(px: unknown): px is number {
	return typeof px === "number" && Number.isInteger(px) && px > 0;
}

/** The width most of these strokes' anchors carry; a tie goes to the width met first. Undefined when no stroke has one. */
export function columnRefOf(strokes: readonly InkStroke[]): number | undefined {
	const counts = new Map<number, number>();
	for (const s of strokes) {
		const w = s.lineAnchor?.width;
		if (validColumnRef(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
	}
	let best: number | undefined, most = 0;
	// Map order is the order each width was first met, so the first width to reach the top count wins a tie.
	for (const [w, n] of counts) {
		if (n > most) {
			best = w;
			most = n;
		}
	}
	return best;
}

/**
 * A page just read from its file gives the record its width when neither holds one yet: the anchors as the file has them,
 * before this session re-takes any at another width. Writes nothing; the width rides the next ordinary save.
 */
export function takeColumnRef(rec: { columnRefPx?: number }, page: { readonly columnRefPx?: number; readonly strokes: readonly InkStroke[] }): void {
	if (page.columnRefPx !== undefined || rec.columnRefPx !== undefined) return;
	const w = columnRefOf(page.strokes);
	if (w !== undefined) rec.columnRefPx = w;
}
