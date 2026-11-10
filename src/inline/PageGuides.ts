/**
 * PAGE GUIDES ON AN INFINITE CANVAS NOTE: the arithmetic. Faint lines at every page height from the note's top edge,
 * screen only. A guide draws, clips and moves nothing: it is one background on a box behind the text (the overlay's
 * `syncPageGuideBox`), and no export draws it.
 *
 * The page is the one the Export to PDF dialog last saved (its page area: the paper less its margins, over its
 * downscale, at 96 css px an inch, as `paperWidthFor` and `paperHeightFor` read it for the export), else Letter
 * portrait at the dialog's default margin.
 *
 * The pitch is where an export of the note at its column would cut the pages. The export lays the text out at the
 * column width and shrinks it to the paper when the column is the wider (EmbedInkPrint `fitPrintColumn`, never above
 * 100 percent), so a page holds the page area's height of column px, or more when the column was shrunk:
 * height times the larger of 1 and column over page width.
 */
import { paperHeightFor, paperWidthFor, savedPaperSettings } from "./EmbedInkPrint";

/** Letter portrait at the dialog's default margin (0.4 in a side), css px at 96 an inch: 7.7 in by 10.2 in. */
export const LETTER_PAGE_AREA: Readonly<{ w: number; h: number }> = { w: (8.5 - 0.8) * 96, h: (11 - 0.8) * 96 };

/** The page area the guides mark, css px: the export dialog's saved page when it reads, else Letter portrait. */
export function guidePageArea(saved: unknown): { w: number; h: number } {
	const w = paperWidthFor(saved), h = paperHeightFor(saved);
	if (w !== null && h !== null && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { w, h };
	return { ...LETTER_PAGE_AREA };
}

/** One page's height in the note's layout px for a text column `column` px wide; NaN when the column has no width. */
export function guidePitch(column: number, page: { w: number; h: number }): number {
	if (!Number.isFinite(column) || column <= 0 || !(page.w > 0) || !(page.h > 0)) return Number.NaN;
	return page.h * Math.max(1, column / page.w);
}

/** The guides' pitch for a column now, from the dialog's saved settings as they stand. */
export function pageGuidePitch(column: number): number {
	return guidePitch(column, guidePageArea(savedPaperSettings()));
}
