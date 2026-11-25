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

/** Font sizes this close are one (as LineAnchor.ts): a file holds the size to a thousandth of a px. */
const FONT_SLACK = 1e-3;

/**
 * The width most of these strokes' anchors carry; a tie goes to the width met first. Undefined when no stroke has one.
 *
 * With the note's font reference: the anchors taken at that size vote; with none at it, every anchor's width moved to that
 * size (width x fontRef / the anchor's size, rounded) votes the same way. Each is the natural column at its size, so the
 * width is the note's at its own. Without the reference, every width votes as it is.
 */
export function columnRefOf(strokes: readonly InkStroke[], fontRefPx?: number | null): number | undefined {
	const ref = typeof fontRefPx === "number" && Number.isFinite(fontRefPx) && fontRefPx > 0 ? fontRefPx : null;
	if (ref === null) return vote(strokes, (a) => a.width);
	return vote(strokes, (a) => (Math.abs(a.fontPx - ref) <= FONT_SLACK ? a.width : undefined)) ??
		vote(strokes, (a) => (a.fontPx > 0 && Number.isFinite(a.width) ? Math.round((a.width * ref) / a.fontPx) : undefined));
}

/** The most common valid width among the strokes' anchors as `widthOf` reads them; a tie goes to the width met first. */
function vote(strokes: readonly InkStroke[], widthOf: (a: { readonly width: number; readonly fontPx: number }) => number | undefined): number | undefined {
	const counts = new Map<number, number>();
	for (const s of strokes) {
		const w = s.lineAnchor ? widthOf(s.lineAnchor) : undefined;
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
export function takeColumnRef(rec: { columnRefPx?: number },
	page: { readonly columnRefPx?: number; readonly fontRefPx?: number; readonly strokes: readonly InkStroke[] }): void {
	if (page.columnRefPx !== undefined || rec.columnRefPx !== undefined) return;
	const w = columnRefOf(page.strokes, page.fontRefPx);
	if (w !== undefined) rec.columnRefPx = w;
}
