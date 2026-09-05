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
 * How many `.cm-line`s the rect budget is spent on at each END of the line
 * list. The class walk that finds them is free (no layout), so the budget
 * does not have to be spent on the LEADING lines - and spending it there was
 * the defect: a note whose viewport opens with twelve `.cm-line`s that each
 * carry a rendered table ("twelve table lines" in
 * `test/render/MinimalNoteShapes.test.ts`) put twelve wide lines in front of
 * the scan and the ordinary line thirteenth, 16px away from where the origin
 * landed. Six at each end is `SCAN_LIMIT` total, so the cost is unchanged and
 * a leading run of any kind can no longer monopolise the sample.
 */
const SAMPLE_END = SCAN_LIMIT / 2;

/**
 * A `.cm-line` that matches this is carrying a BLOCK WIDGET, and Minimal
 * gives those their own width. Live Preview renders a table, an image embed,
 * a Bases view, a dataview block, an iframe or a canvas INSIDE the line div
 * that holds its source, and theme.css:2171-2199 / 2224-2229 size that line
 * from `--line-width-wide` or `--container-img-width` rather than from
 * `--line-width`. Under the default helpers such a line starts LEFT of the
 * column, which the maximum rule stepped over harmlessly. Under `wide` and
 * `max` it does not: the column itself widens and moves left while the table
 * keeps a margin built from the un-widened `--content-margin-start`
 * (theme.css:1981), so the table line ends up to the RIGHT of the text and
 * wins the maximum outright - +71.5px under `wide`, +280px under `max`,
 * measured in `test/render/MinimalSettingsSweep.test.ts`. A line carrying one
 * of these is therefore not evidence about where the text column is, and is
 * dropped before its rect is ever read.
 *
 * THE PROBE IS IMMEDIATE CHILDREN ONLY, and both halves of that matter.
 *
 * COST. This ran as one `querySelector` per sampled line, and the substring
 * arm `[class*="block-language-"]` forces a full subtree walk on every line
 * that does NOT match - which is every ordinary line, twelve of them, on a
 * path `repaint` reaches through `syncCamera` and `update` schedules on
 * `docChanged`. That is per keystroke and per scroll tick, scaling with how
 * much markup the line holds.
 *
 * CORRECTNESS. `.image-embed` and `canvas` also occur INLINE. `text
 * ![[img.png]] text` renders a `span.internal-embed.image-embed` in the
 * middle of an ordinary line, and a subtree probe rejects that line - whose
 * left edge IS the column's. Under `cssclasses: wide` or `max`, a viewport
 * where every sampled line carries an inline image left phase A with nothing
 * and handed the answer to phase B, which measures the wide table line
 * sitting RIGHT of the text: +71.5px and +280px, the very defect the block
 * probe was added to fix. Obsidian renders an inline embed as a `span` and a
 * block one as a `div`, so the tag is the discriminator and it is free.
 */
const BLOCK_WIDGET_CLASSES = ["cm-table-widget", "image-embed", "bases-embed"];
const BLOCK_LANGUAGE_PREFIX = "block-language-";

/**
 * Is this `.cm-line` carrying a block widget? Immediate children only; see
 * `BLOCK_WIDGET_CLASSES` for why.
 *
 * No allocation and no descent. A line's immediate children are its inline
 * runs - a `span` per formatted stretch - so this is small and, unlike the
 * subtree query it replaces, does not grow with how deeply nested the line's
 * markup is.
 */
function carriesBlockWidget(line: Element): boolean {
	const kids = line.children;
	for (let i = 0; i < kids.length; i++) {
		const kid = kids[i];
		if (!kid) continue;
		const tag = kid.tagName;
		// Shapes that are block by their tag alone. A `<canvas>` or an
		// `<iframe>` in the middle of a sentence is not a thing Obsidian
		// renders; a `<table>` cannot be one by the parser's own rules.
		if (tag === "TABLE" || tag === "IFRAME" || tag === "CANVAS") return true;
		// An inline embed. Live Preview spells it `span`, and the line around
		// it is ordinary text whose left edge is the column's.
		if (tag === "SPAN") continue;
		const classes = kid.classList;
		if (!classes) continue;
		for (const name of BLOCK_WIDGET_CLASSES) {
			if (classes.contains(name)) return true;
		}
		// Dataview, Tasks and every other fenced renderer. A prefix scan over
		// the classes this element actually has, rather than a substring
		// selector that made the browser walk the subtree to answer.
		for (let c = 0; c < classes.length; c++) {
			const name = classes[c];
			if (name !== undefined && name.startsWith(BLOCK_LANGUAGE_PREFIX)) return true;
		}
	}
	return false;
}


/**
 * What the scan found: the element whose left edge IS the text column's, and
 * that edge in visual px.
 *
 * Both are returned together because both callers want the same scan. The
 * left edge is what the camera paints against; the element is what a
 * `ResizeObserver` has to watch to be told the column moved at all, under a
 * theme that moves the LINES and holds `.cm-content` still. Deriving them
 * from two separate calls would double the forced layout reads below for
 * nothing, and would let the two disagree across a frame boundary.
 */
export interface ContentOrigin {
	/**
	 * The measured element, or `null` when the scan found nothing usable.
	 * `Element` rather than `HTMLElement` so the scan keeps admitting exactly
	 * what it admitted before - it never tested for `HTMLElement`, and
	 * `ResizeObserver.observe` takes an `Element` anyway.
	 */
	line: Element | null;
	/**
	 * The left edge of the text column in visual px, or `null` for COLUMN NOT
	 * FOUND: nothing in the rendered viewport has a width, so no scan of any
	 * length can say where the column is.
	 *
	 * `null` rather than `.cm-content`'s own left, which is what this returned
	 * before. Under a theme that caps `.cm-content` those two are the same
	 * number, so the fallback cost nothing; under Minimal `.cm-content` is the
	 * PANE edge, so the fallback was a 380px guess (measured at a 1400px pane,
	 * `MinimalNoteShapes.test.ts`) that moved the camera away from ink that
	 * was sitting correctly a frame earlier. A caller that already knows where
	 * the column was has a strictly better answer than this function does, and
	 * `null` is how it gets told to use it.
	 *
	 * `line === null` exactly when `left === null`: the element returned is
	 * always the element the number was read from.
	 */
	left: number | null;
}

/**
 * The left edge of the text column, in visual px, for a CodeMirror
 * `contentDOM`, together with the element it was read from.
 *
 * Robustness, in the order the hazards actually appear:
 *
 * - `.cm-content`'s children are NOT uniformly text lines. Movable text boxes
 *   render zero-WIDTH block-marker widgets, and a zero-width element under
 *   `margin-inline: auto` centres to a point rather than to a column, so its
 *   left edge is meaningless. Zero-width rects are skipped. Zero-HEIGHT ones
 *   are NOT: a flat block with a real width - the shape a hidden HTML embed
 *   takes in Live Preview - is centred by the same rule as a line and its
 *   left edge IS the column's, to within half a pixel on every one of the
 *   twelve children of the "hidden html embeds" shapes. Rejecting those cost
 *   380px of origin error for a note built out of them.
 * - Minimal deliberately makes SOME block children wider than the text:
 *   `--line-width-wide` (`--line-width` + 12.5%) for tables, bases and
 *   dataview blocks (theme.css:2171-2199). A wide block starts further LEFT
 *   than the column, so taking the maximum left over the scanned lines picks
 *   the ordinary text column and ignores them. Nothing in these rules pushes
 *   a text line further right than the column, so the maximum is safe in the
 *   other direction.
 * - `.cm-line` is CodeMirror's own mark for "this is a line of text", and the
 *   class check forces no layout, so phase A finds the lines by walking in
 *   from each END of the child list and spends the rect budget on lines only.
 *   Each walk stops the moment its own quota is full, so a viewport of lines
 *   - which is what a viewport normally is - costs `SAMPLE_END` child visits
 *   at each end and never touches the middle. The
 *   twelve-child window it replaces was the single biggest source of error in
 *   the shape sweep: a note that opens with twelve tables, twelve dataview
 *   blocks or twelve image embeds closed the window before the first line and
 *   measured the widened blocks instead - -16px at Minimal's defaults,
 *   -87.5px under `cssclasses: img-wide`, -380px under `img-100`, all at a
 *   1400px pane. The text line those notes need was the thirteenth child.
 * - Phase B, the any-child pass, exists so a viewport holding only widgets
 *   still measures something better than nothing, and it is still the first
 *   `SCAN_LIMIT` children.
 * - An empty document, a detached editor, or a jsdom fixture yields no usable
 *   child at all and reports COLUMN NOT FOUND (`left: null`, `line: null`),
 *   so a caller keeps whatever origin it already trusted and arms nothing
 *   rather than watching the wrong element.
 *
 * Ties keep the FIRST maximum, which is what `Math.max` over the collected
 * lefts did before this returned an element as well.
 *
 * WHAT ONE CALL COSTS, counted, since `repaint` reaches this through
 * `syncCamera` and `update` schedules a repaint on `docChanged` and
 * `viewportChanged` - which is per keystroke and per scroll tick:
 *
 * - Child visits: `2 * SAMPLE_END` in the common case, where the children
 *   near each end are lines, plus `SCAN_LIMIT` if phase B runs. NOT one per
 *   child of the viewport, which is what the collect-then-slice pass cost.
 *   The walks only go deeper when the ends are NOT lines, and then only as
 *   far as it takes to find `SAMPLE_END` of them.
 * - Rect reads: at most `SCAN_LIMIT` USABLE ones, plus the degenerate reads
 *   that were not charged for. Bounded above by the sample sizes, so at most
 *   `2 * SAMPLE_END + SCAN_LIMIT` reads in the pathological case where every
 *   sampled child is zero-width; twelve in the ordinary one.
 * - Widget probes: at most `2 * SAMPLE_END`, each a loop over ONE line's
 *   immediate children with no descent into their subtrees.
 * - Allocations: none. No index array, no slices, no spread, no set of seen
 *   indices - the two walks meet at `headStop` and that is the whole
 *   bookkeeping.
 */
export function contentOrigin(contentDOM: HTMLElement): ContentOrigin {
	const children = contentDOM.children;
	const count = children.length;

	let bestLine: Element | null = null;
	let bestLeft = 0;
	// The rect budget, shared by both phases.
	let rects = SCAN_LIMIT;
	const consider = (child: Element): void => {
		if (rects <= 0) return;
		const rect = child.getBoundingClientRect();
		// An unrendered widget or a collapsed block marker is zero-width, and
		// a zero-width box centres to its own midpoint under `auto` margins:
		// it would report a column half a pane too far right. Zero HEIGHT is
		// not disqualifying - see the doc comment above.
		//
		// The budget is spent AFTER that test, not before. Twelve zero-width
		// block markers - the shape a note of movable text boxes takes - used
		// to exhaust it on rects that taught the scan nothing and leave phase
		// B unable to measure the thirteenth child, which reported COLUMN NOT
		// FOUND for a viewport that was perfectly measurable.
		if (rect.width <= 0) return;
		rects--;
		if (bestLine === null || rect.left > bestLeft) {
			bestLine = child;
			bestLeft = rect.left;
		}
	};

	// Phase A: the first `SAMPLE_END` lines and the last `SAMPLE_END`, found
	// by walking in from each end and stopping the moment the quota is full.
	// Head AND tail, because a leading run of widened blocks is exactly what
	// goes wrong; two ends rather than one collected list, because collecting
	// every line's index and then slicing it visited every child of the
	// viewport and allocated an array to do it, on a path that runs per
	// keystroke.
	//
	// `headStop` is the meeting point: the tail walk never re-visits a child
	// the head walk already consumed, so a short note is sampled once and not
	// twice, and no set of seen indices has to be carried to say so.
	let headStop = 0;
	let taken = 0;
	while (headStop < count && taken < SAMPLE_END) {
		const child = children[headStop];
		headStop++;
		if (!child || !child.classList.contains("cm-line")) continue;
		// A widget line spends its SAMPLE slot, exactly as it did when the
		// sample was a slice: it is one of the lines at this end of the note,
		// and pretending otherwise would let a run of tables pull the sample
		// deeper into the document than the budget is meant to reach.
		taken++;
		// Before the rect, not after: a rejected line must cost no layout, or
		// a note whose every sampled line carries a table would spend the
		// whole budget learning nothing and leave phase B nothing to spend.
		if (carriesBlockWidget(child)) continue;
		consider(child);
	}
	taken = 0;
	for (let i = count - 1; i >= headStop && taken < SAMPLE_END; i--) {
		const child = children[i];
		if (!child || !child.classList.contains("cm-line")) continue;
		taken++;
		if (carriesBlockWidget(child)) continue;
		consider(child);
	}
	if (bestLine !== null) return { line: bestLine, left: bestLeft };

	// Phase B: no usable line anywhere in the viewport. Measure the leading
	// children of any kind, as this did before there was a phase A.
	const scanned = Math.min(children.length, SCAN_LIMIT);
	for (let i = 0; i < scanned; i++) {
		const child = children[i];
		if (child) consider(child);
	}
	if (bestLine !== null) return { line: bestLine, left: bestLeft };

	// Phase C: nothing in the viewport can be measured.
	return { line: null, left: null };
}

/**
 * The column's left edge alone, for the five call sites that paint with it
 * and never re-arm anything. A wrapper rather than a second scan, so there is
 * one rule for "where is the column" and it cannot drift. `null` carries the
 * COLUMN NOT FOUND outcome through unchanged; `InkOverlay` resolves it in one
 * place (`resolveColumnLeft`).
 */
export function contentOriginLeft(contentDOM: HTMLElement): number | null {
	return contentOrigin(contentDOM).left;
}
