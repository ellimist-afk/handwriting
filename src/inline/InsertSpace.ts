/**
 * Insert space: the divider gesture's pure core.
 *
 * The gesture is overlay state (a world y, a frozen id list, an accumulated
 * dy) driving the SAME machinery the lasso drag uses: `moveStrokes` live,
 * one `move` op at release. What is genuinely new is the membership rule -
 * which strokes a divider takes with it - and that rule wants to be pure
 * and tested, because it is the part a user disagrees with when the gesture
 * "split the letters".
 *
 * Two rules were tried and both were wrong, for the same reason:
 *
 *   1. bbox TOP - tore a row apart, because a written row is not a band of
 *      uniform height and a divider in the gap between rows still sits
 *      below the tops of the taller letters in the lower row.
 *   2. the ink's centroid - better, and still wrong, because a letter is
 *      not always ONE stroke. The dot of an `i`, the cross of a `t`, the
 *      bar of an `A`: each is its own stroke with its own centroid, and a
 *      line drawn between a dot and its stem separates them.
 *
 * Both failed because they judge strokes INDIVIDUALLY. Any horizontal line
 * through a page of handwriting passes through something. So membership is
 * decided a ROW at a time instead: the strokes are grouped into rows of
 * writing, the divider snaps to the nearest gap BETWEEN rows, and whole
 * rows move. A letter cannot come apart because nothing ever cuts through
 * a row - which is also what the gesture means when a person draws it.
 */

import type { BBox, InkStroke } from "../ink/Stroke";

/** A row of writing: its vertical extent and the strokes that make it up. */
export interface InkRow {
	top: number;
	bottom: number;
	ids: string[];
}

function extentOf(stroke: InkStroke): { top: number; bottom: number } {
	const pts = stroke.points;
	if (pts.length === 0) return { top: stroke.bbox.y, bottom: stroke.bbox.y + stroke.bbox.height };
	let top = Infinity;
	let bottom = -Infinity;
	for (const p of pts) {
		if (p.y < top) top = p.y;
		if (p.y > bottom) bottom = p.y;
	}
	return { top, bottom };
}

/**
 * Group strokes into rows of writing, top to bottom.
 *
 * Two passes. First, a stroke joins the row above it when their vertical
 * extents OVERLAP - which covers most of a line of writing, since letters
 * on a line share a band. Rows that merely touch stay separate, which is
 * what lets two lines written tight against each other be pulled apart.
 *
 * Then the floating marks are attached: a dot never touches its stem, so
 * overlap alone strands it as a row of its own. See the second pass.
 */
export function rowsOf(strokes: readonly InkStroke[]): InkRow[] {
	const spans = new Map<string, { left: number; right: number }>();
	for (const s of strokes) spans.set(s.id, { left: s.bbox.x, right: s.bbox.x + s.bbox.width });
	const items = strokes
		.map((s) => ({ id: s.id, ...extentOf(s) }))
		.sort((a, b) => a.top - b.top);

	const rows: InkRow[] = [];
	for (const it of items) {
		const cur = rows[rows.length - 1];
		if (cur && it.top < cur.bottom) {
			cur.ids.push(it.id);
			if (it.bottom > cur.bottom) cur.bottom = it.bottom;
			continue;
		}
		rows.push({ top: it.top, bottom: it.bottom, ids: [it.id] });
	}

	// Second pass: attach floating marks to the row they belong to.
	//
	// A dot never touches its stem and a `t` bar often clears its own row's
	// tallest letter, so overlap alone leaves them stranded as rows of their
	// own - which is exactly how a letter came apart. Such a mark is small,
	// sits directly OVER one letter of the row beneath it, and is closer to
	// that row than a line of writing would be. Two genuine rows never match
	// all three: they are the same width as each other, not a fraction of it.
	for (let i = rows.length - 2; i >= 0; i--) {
		const mark = rows[i]!;
		const host = rows[i + 1]!;
		const gap = host.top - mark.bottom;
		if (gap < 0 || gap > host.bottom - host.top) continue;
		const m = xSpan(mark.ids, spans);
		const h = xSpan(host.ids, spans);
		if (m === null || h === null) continue;
		const narrow = m.right - m.left <= (h.right - h.left) * 0.34;
		const over = m.left >= h.left - 1 && m.right <= h.right + 1;
		if (!narrow || !over) continue;
		host.ids.push(...mark.ids);
		host.top = mark.top;
		rows.splice(i, 1);
	}
	return rows;
}

function xSpan(
	ids: readonly string[],
	spans: ReadonlyMap<string, { left: number; right: number }>
): { left: number; right: number } | null {
	let left = Infinity;
	let right = -Infinity;
	for (const id of ids) {
		const s = spans.get(id);
		if (!s) continue;
		if (s.left < left) left = s.left;
		if (s.right > right) right = s.right;
	}
	return left === Infinity ? null : { left, right };
}

/**
 * Where the cut actually lands: the divider snaps out of any row it was
 * drawn through, to whichever edge of that row is nearer.
 *
 * Drawing through a row is not ambiguous about intent - a person putting a
 * line halfway down a word means "make room around this line", not "tear
 * this word in half" - so the row goes wholly above or wholly below, and
 * the drawn line moves to say which. Everything else is left alone.
 */
export function snapLine(rows: readonly InkRow[], lineY: number): number {
	for (const row of rows) {
		if (lineY > row.top && lineY < row.bottom) {
			const toTop = lineY - row.top;
			const toBottom = row.bottom - lineY;
			return toBottom <= toTop ? row.bottom : row.top;
		}
	}
	return lineY;
}

/**
 * Which strokes an insert-space divider at world y moves, in store order.
 *
 * The line is snapped first, so this can only ever take whole rows. A row
 * exactly meeting the line moves: the divider reads as "everything from
 * here down".
 */
export function strokeIdsBelow(strokes: readonly InkStroke[], lineY: number): string[] {
	const rows = rowsOf(strokes);
	const cut = snapLine(rows, lineY);
	const moving = new Set<string>();
	for (const row of rows) {
		if (row.top >= cut) for (const id of row.ids) moving.add(id);
	}
	// Store order, so z-order and the op's id list stay in the store's terms.
	return strokes.filter((s) => moving.has(s.id)).map((s) => s.id);
}

/** The union box of the named strokes, or null when none are named. */
export function boundsOf(strokes: readonly InkStroke[], ids: readonly string[]): BBox | null {
	const wanted = new Set(ids);
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let found = false;
	for (const s of strokes) {
		if (!wanted.has(s.id)) continue;
		found = true;
		const b = s.bbox;
		if (b.x < minX) minX = b.x;
		if (b.y < minY) minY = b.y;
		if (b.x + b.width > maxX) maxX = b.x + b.width;
		if (b.y + b.height > maxY) maxY = b.y + b.height;
	}
	if (!found) return null;
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The region a vertical shift of `dy` dirties: where the ink was, plus
 * where it lands, as ONE rect.
 *
 * Marking the whole page dirty per frame re-rasterized every stroke in the
 * note and the drag went visibly jagged on a full page. The moved ink is a
 * contiguous band travelling straight down, so its swept region is exactly
 * one rectangle - the shape the damage ledger is cheapest at, and the one
 * the lasso drag has always used.
 */
export function sweptRect(bounds: BBox, dy: number): BBox {
	return {
		x: bounds.x,
		y: dy < 0 ? bounds.y + dy : bounds.y,
		width: bounds.width,
		height: bounds.height + Math.abs(dy),
	};
}

/**
 * How many text lines a vertical shift is worth.
 *
 * Ink is world-anchored and text is not, so the two only stay aligned if
 * the ink lands on a whole number of line heights: the drag runs smooth,
 * and the release quantizes to the nearest line. Half a line of slack at
 * the end is invisible next to text and ink disagreeing forever.
 */
export function lineSteps(dyNote: number, lineHeightNote: number): number {
	if (!(lineHeightNote > 0)) return 0;
	return Math.round(dyNote / lineHeightNote);
}

/**
 * How many blank lines directly above `lineNumber` (1-based) may be taken
 * back, capped at `want`.
 *
 * Closing a gap must never eat writing. Dragging up removes only the empty
 * lines a previous insert-space put there; the moment a line has anything
 * on it the removal stops, and the ink simply moves further than the text
 * does - wrong by a line, where deleting a sentence would be unforgivable.
 */
export function blankLinesAbove(
	lines: readonly string[],
	lineNumber: number,
	want: number
): number {
	let n = 0;
	let i = lineNumber - 2; // 0-based index of the line above
	while (n < want && i >= 0 && (lines[i] ?? "").trim() === "") {
		n++;
		i--;
	}
	return n;
}
