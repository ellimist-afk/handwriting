/**
 * Where note space starts on the screen VERTICALLY: the top of the document,
 * as the text is actually laid out - which is not always the number
 * CodeMirror will tell you.
 *
 * `ContentOrigin.ts` is this file's other half. Ink is anchored to exactly
 * two numbers (`UnsettledDocumentTop.test.ts` derives the identity through
 * the real router and the real `syncCamera`): the text column's left edge,
 * which that file answers, and the document top, which is this one.
 *
 *     world.y = (clientY - documentTop) / scale
 *
 * CODEMIRROR'S ANSWER, AND WHEN IT IS WRONG. `view.documentTop` is one sum
 * (@codemirror/view/dist/index.js:8036-8037):
 *
 *     contentDOM.getBoundingClientRect().top + viewState.paddingTop
 *
 * The rect is read live and is always current. `viewState.paddingTop` is a
 * BELIEF: it is 0 from construction (:5929) and stays 0 until the first
 * measure cycle writes `(parseInt(getComputedStyle(contentDOM).paddingTop) ||
 * 0) * scaleY` into it (:6065-6070). That cycle is reached only from the rAF
 * the constructor requests (:7617, and again after `document.fonts.ready` at
 * :7619), so between construction and the next frame CodeMirror reports a
 * document top that is short by the whole top padding.
 *
 * THE CSS PADDING IS IN FORCE THE WHOLE TIME. Only the number is late. So
 * during that window the text sits `padding` px lower than CodeMirror says
 * the document does, and a stroke stored against `documentTop` is stored
 * that far off the line it was drawn on - permanently, because the store is
 * what persists. Measured on a real editor in
 * `test/render/UnsettledTopMechanisms.test.ts` (mechanism P): with Minimal's
 * 8px top padding the belief is 0 while the stylesheet already says 8, one
 * frame later `documentTop` has moved by exactly 8, and the `.cm-line` has
 * not moved at all.
 *
 * WHAT THIS IS NOT FOR, and the distinction is the whole reason the fix is
 * shaped this way. When something ABOVE `.cm-content` in the scroller grows -
 * Obsidian's inline title, its properties block, a font swap - the RECT term
 * moves, and `.cm-content` and every line inside it move by the same amount.
 * A stroke stored before that is still at the right offset from its line and
 * must not be touched (mechanism R in the same file, where "correcting" it
 * would leave the ink an inch above the words for good). This function
 * changes only the PADDING term, so the rect term passes through untouched
 * and a block growing above the content moves nothing.
 *
 * WHY THE COMPUTED STYLE AND NOT `view.documentPadding`. `documentPadding`
 * returns `viewState.paddingTop` (:8042-8044) - it is the belief itself, the
 * same number already inside `documentTop`, so it can only ever restate the
 * error. CodeMirror's own source for the truth is the computed style, and
 * this evaluates CodeMirror's formula against it VERBATIM, `parseInt` and
 * `scaleY` included. That exactness is load-bearing twice over: once the
 * measure cycle has run, the value computed here is bit-for-bit the value
 * CodeMirror latched, so the anchor this returns is bit-for-bit
 * `view.documentTop` and every settled frame is arithmetically identical to
 * what shipped - no drift, and no spurious repaint from a camera that
 * wobbled in its last decimals. During an unmeasured uniform CSS zoom, the
 * caller supplies the live horizontal scale so the cached Y/X ratio can
 * follow that zoom before new input is stored. Once CM measures, its exact
 * scale is retained. A `parseFloat` here would disagree with the
 * belief by half a pixel forever at any fractional padding.
 */

/**
 * CodeMirror's padding formula, evaluated against a computed style now:
 * what `viewState.paddingTop` already is, or is about to become.
 *
 * `null` for "cannot say" - no style object was held, or the value did not
 * parse. CodeMirror's own expression maps an unparseable value to 0, but it
 * only ever evaluates it inside a measure cycle on a mounted element; here
 * an unreadable style means a caller that should keep whatever anchor it
 * already had, and assuming zero padding would move ink for no reason.
 */
export function declaredPaddingTop(
	cssPaddingTop: string | undefined,
	scaleY: number
): number | null {
	if (cssPaddingTop === undefined) return null;
	const px = Number.parseInt(cssPaddingTop, 10);
	if (!Number.isFinite(px)) return null;
	// Callers may supply a live correction for an unmeasured uniform zoom.
	// Invalid scale retains the prior unscaled fallback.
	const scale = Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1;
	return px * scale;
}

/** The shape of `EditorView` this needs, and nothing else. */
export interface TopAnchorView {
	/** `.cm-content`: its border-box top is the rect term of `documentTop`. */
	readonly contentDOM: { getBoundingClientRect(): { readonly top: number } };
	/** CodeMirror's own answer, used verbatim when the padding cannot be read. */
	readonly documentTop: number;
	/** `view.scaleY`, the factor CodeMirror scales the CSS padding by. */
	readonly scaleY: number;
	/** Cached horizontal scale, used to identify an unmeasured uniform zoom. */
	readonly scaleX?: number;
}

/**
 * The document top the TEXT is laid out with, in visual px: the live rect top
 * plus the padding the stylesheet is actually applying.
 *
 * ONE rect read on either branch, which is what `view.documentTop` costs
 * today - the getter reads the same rect. The style value is passed in
 * rather than fetched: the overlay already holds a live
 * `getComputedStyle(contentDOM)` object and already reads `fontSize` off it
 * once per sync, so this adds a property read to a path that has just forced
 * layout for its own rects and no `getComputedStyle` call anywhere.
 */
export function anchorTop(view: TopAnchorView, cssPaddingTop: string | undefined, currentScaleX?: number): number {
	let scaleY = view.scaleY;
	const cachedX = view.scaleX;
	// Owned zoom scales both axes uniformly before CodeMirror measures again.
	// Carry its last Y/X ratio forward using the live X scale. Once measured,
	// retain CM's exact Y (including its layout-height rounding) as before.
	if (currentScaleX !== undefined && Number.isFinite(currentScaleX) && currentScaleX > 0 &&
		cachedX !== undefined && Number.isFinite(cachedX) && cachedX > 0 &&
		Number.isFinite(scaleY) && scaleY > 0 && Math.abs(currentScaleX - cachedX) > cachedX * 1e-3) {
		scaleY *= currentScaleX / cachedX;
	}
	const declared = declaredPaddingTop(cssPaddingTop, scaleY);
	if (declared === null) return view.documentTop;
	return view.contentDOM.getBoundingClientRect().top + declared;
}
