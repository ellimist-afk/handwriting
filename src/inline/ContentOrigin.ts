/**
 * Where note space starts on the screen: the LEFT EDGE OF THE TEXT COLUMN.
 *
 * The overlay paints `screen_x = origin + x * scale`, so this one number is
 * half of everything that can separate ink from the words under it. It used
 * to be spelled `view.contentDOM.getBoundingClientRect().left` inline at
 * four call sites, on the assumption that `.cm-content` IS the text column.
 *
 * THAT ASSUMPTION IS THEME-DEPENDENT, and the Minimal theme does not hold it.
 * Stock Obsidian caps `.cm-content` at `--file-line-width` and centres that
 * element, so its own left edge is the column's. Minimal instead forces
 * `.cm-content` to full width and centres the LINES inside it - verbatim,
 * from `themes/Minimal/theme.css` (Minimal 8.1.1, lines 1852-1867):
 *
 *     .markdown-source-view.mod-cm6.is-readable-line-width .cm-content,
 *     .markdown-source-view.mod-cm6.is-readable-line-width .cm-sizer {
 *       max-width: 100%;
 *       width: 100%;
 *     }
 *     ...
 *     .markdown-source-view.mod-cm6.is-readable-line-width
 *       .cm-contentContainer.cm-contentContainer > .cm-content > div, ... {
 *       max-width: var(--max-width);
 *       width: var(--line-width);
 *       margin-inline: var(--content-margin) !important;
 *     }
 *
 * with `--content-margin: auto` (theme.css:1832), `--line-width: 40rem` and
 * `--max-width: 88%` (theme.css:53,56). The file contains no `max-width` rule
 * that narrows `.cm-content` and no reference to `--file-line-width` at all.
 *
 * The consequence is the whole defect. Under Minimal, toggling Readable line
 * length re-centres the text while `.cm-content` stays pinned to the pane: it
 * does not change SIZE, so neither ResizeObserver fires, and it does not
 * MOVE, so `handleResize`'s content-origin compare never trips either. Both
 * fixes that shipped for this bug (a8209dc, e0649ea) are structurally blind
 * to a theme that moves the column without moving `.cm-content`, because both
 * of them watch `.cm-content`. The element that actually carries the text is
 * the line box inside it, and that is what this function returns.
 *
 * WHAT THIS COSTS. Under stock Obsidian the two readings are the same number
 * to the pixel - a line box is a block child, so its border-box left IS the
 * content box left of `.cm-content`, which has no horizontal padding - and
 * the render suite asserts that equality rather than assuming it, because it
 * is what keeps every already-persisted stroke meaning what it meant. Ink
 * previously written under a column-centring theme DOES move once, by the
 * centring margin, since it was stored against an origin that was never the
 * column. That is a one-time correction of coordinates that were already
 * wrong the moment the pane changed width, and there is no way to have both.
 */

/**
 * How many children may be measured. `getBoundingClientRect` on every line in
 * the CodeMirror viewport would be a hundred-odd forced reads inside
 * `syncCamera`, which runs on resize and scroll ticks and at pen-down. The
 * leading run is enough to step over a widget or a table and reach ordinary
 * text; if it is not, the fallback below is still the old behaviour.
 */
const SCAN_LIMIT = 12;

/**
 * The left edge of the text column, in visual px, for a CodeMirror
 * `contentDOM`.
 *
 * Robustness, in the order the hazards actually appear:
 *
 * - `.cm-content`'s children are NOT uniformly text lines. Movable text boxes
 *   render zero-height block-marker widgets, and a zero-height or zero-width
 *   element under `margin-inline: auto` centres to a point rather than to a
 *   column, so its left edge is meaningless. Degenerate rects are skipped.
 * - Minimal deliberately makes SOME block children wider than the text:
 *   `--line-width-wide` (`--line-width` + 12.5%) for tables, bases and
 *   dataview blocks (theme.css:2171-2199). A wide block starts further LEFT
 *   than the column, so taking the maximum left over the scanned lines picks
 *   the ordinary text column and ignores them. Nothing in these rules pushes
 *   a text line further right than the column, so the maximum is safe in the
 *   other direction.
 * - `.cm-line` is preferred when present because it is CodeMirror's own mark
 *   for "this is a line of text"; the any-child pass exists so a viewport
 *   holding only widgets still measures something better than nothing.
 * - An empty document, a detached editor, or a jsdom fixture yields no usable
 *   child and falls back to `.cm-content`'s own left - the pre-1.4.9
 *   behaviour, which is correct under every theme that caps `.cm-content`.
 */
export function contentOriginLeft(contentDOM: HTMLElement): number {
	const lines: number[] = [];
	const others: number[] = [];
	const children = contentDOM.children;
	const scanned = Math.min(children.length, SCAN_LIMIT);
	for (let i = 0; i < scanned; i++) {
		const child = children[i];
		if (!child) continue;
		const rect = child.getBoundingClientRect();
		// A block marker is zero-height and an unrendered widget can be
		// zero-width; either one centres to its own midpoint under `auto`
		// margins and would report a column that is half a pane too far right.
		if (rect.width <= 0 || rect.height <= 0) continue;
		(child.classList.contains("cm-line") ? lines : others).push(rect.left);
	}
	const candidates = lines.length > 0 ? lines : others;
	if (candidates.length === 0) return contentDOM.getBoundingClientRect().left;
	return Math.max(...candidates);
}
