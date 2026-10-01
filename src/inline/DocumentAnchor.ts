/**
 * A DOCUMENT-TOP ANCHOR THAT IS NEVER A BIG NUMBER.
 *
 * `DocumentTop.ts` answers "where does the document start on screen" by
 * reading `.cm-content`'s rect. That rect is correct and it is also the
 * problem: at Alan's extent it is 17223 visual px above the screen at 15%
 * zoom, and a browser rect is rounded at the magnitude it lands on - float32,
 * so one ulp at 17223 is 2^-9 = 1.95e-3 displayed CSS px, twice the camera
 * stabilizer's whole 1/1024 cap. The camera origin then wobbles with the
 * rounding, the stabilizer refuses to hold it, and every frame of a scroll
 * costs a camera-only full redraw: 7-11 per round, 57-133 ms of repaint
 * (measured at the far extent).
 *
 * MEASURED, AND IT DECIDES THE SHAPE OF THIS FILE. The rounding follows the SCREEN coordinate, not the element's offset
 * inside the scrolled content. Two zero-size probes at the same far extent:
 * one 200 px inside the viewport whose offset inside the content was 17418 to
 * 46123 px read 9.3e-6 to 1.2e-5 displayed px of noise; one sitting ON the
 * document top, whose own offset in the content was 4 px, read 1.17e-3 to
 * 2.34e-3 - the same number the `.cm-content` rect read, to the last digit.
 * Both fit 0.6-0.8 ulp32 of their own screen top and nothing else.
 *
 * SO: read a rung that is ON THE SCREEN and carry the distance to the
 * document top as an exact integer instead of measuring it.
 *
 *     cameraY_layout = k x 2048 + (overlay.top - rect(rung_k).top + panY) / cssScale
 *
 * `k x 2048` is an exact integer count of layout px from the document top,
 * because the browser was told to put that rung there. The only quantity
 * divided by a BELIEVED scale is the residual `overlay.top - rect(rung).top`,
 * at most half the rung spacing plus a viewport, so a scale error of relative
 * e costs e x 1024 layout px instead of e x 114822.
 *
 * WHY A FIXED LADDER AND NOT ONE PROBE THAT MOVES.
 * A single probe would have to be re-placed as the reader scrolls, and every
 * re-placement is a `style.top` write inside `contentDOM`. Measured on
 * @codemirror/view 6.38.6: `DOMObserver.flush` calls `view.requestMeasure()`
 * even when the read finds no document change (dist 7143-7147), and widget
 * views ignore the mutation for content purposes (956, 1669) - so the measure
 * is the write's only effect, and it lands on the scroll path. In the spacer
 * regime, where the viewport is far below the last text line, CodeMirror's
 * scroll anchoring then has a lever on the surface. The builder's own first
 * attempt at this probe collapsed scrollTop from 114820 to 9630 that way.
 * A ladder is chosen arithmetically per frame and writes nothing: k is a
 * calculation, not a placement. A wrong k costs DISTANCE, never correctness,
 * because the identity above holds for every k.
 *
 * WHERE THE LADDER LIVES, and why not inside `contentDOM`.
 *
 * The first build put it in a CodeMirror block widget at position 0, because
 * `ContentView.sync` removes every `contentDOM` child CodeMirror does not own
 * and an appended child resolves against the SCROLLER (InkOverlay sets the
 * scroller `position: relative`; the app stylesheet puts no position rule on
 * `.cm-content` or `.cm-sizer`), which would stop it following a reflow above
 * the content. That construction is correct arithmetically - the parity check read 0
 * at both extents - and it REGRESSED two suites: `InsertSpacePrecision`'s
 * insert-space boundary moved an extra stroke, and three `retained-pan` arms
 * stored no stroke at all. A/B on the same tree, extension removed vs present,
 * attributed both to the widget's presence; an inline-widget variant failed
 * identically, so the shape was not the cause - being a position CodeMirror
 * can land on near the document top is (L1e/E-RESULT.md).
 *
 * So the wrapper is the plugin's own element, inserted IMMEDIATELY BEFORE
 * `.cm-content` in `.cm-content`'s own parent (in Obsidian that happens to be
 * `.cm-contentContainer`, but the invariant is the sibling relationship, not
 * the class name - `anchorIsLive` checks it every sync). That parent is
 * Obsidian's, not CodeMirror's:
 * `ContentView.sync` only manages `contentDOM`'s children, so nothing removes
 * it, and `posAtCoords`/`coordsAtPos` cannot land on it because it is not in
 * the document at all. It is still in the scrolled, scaled flow, so a title or
 * properties block growing above the content moves it with the content.
 *
 * THE PADDING TERM IS NOT A PRICE. `anchorTop` has always been
 * `contentDOM rect top + declaredPaddingTop(cssPaddingTop, scaleY)`; the
 * position-0 widget merely absorbed that term into its own rect by sitting
 * after the padding. The wrapper sits at `.cm-content`'s BORDER-BOX top, so the
 * term returns explicitly - the same helper, the same inputs, a computed-style
 * float64 read that adds no rect noise, and `contentStyle.paddingTop` is
 * already a basis term. `anchorPaddingTop` is shared with `anchorTop` so the
 * two agree bit-for-bit, and when it cannot be read the anchor gives up and
 * `anchorTop` answers, exactly as it did before.
 *
 * NO CONTAINER, NO LADDER. A bare CodeMirror whose `.cm-content` sits directly
 * in the scroller gets no anchor and keeps the shipped path unchanged. Obsidian
 * always has the sizer; a fixture may not.
 *
 * TWO GUARDS THAT LOOK COSMETIC AND ARE NOT.
 *  - the wrapper's own height stays 0, so nothing below it moves.
 *  - `overflow: hidden` on the wrapper. Absolutely positioned descendants can
 *    extend a scroller's scrollable overflow, and the top rung sits at the far
 *    end of the spacer; the ladder must add no scroll range of its own.
 *    The ladder growth test plants its removal.
 */

import type { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";

/**
 * Layout px between rungs. Worst distance from the band to the nearest rung is
 * half of this, so the residual the believed scale divides is at most 1024
 * layout px: at cssScale 1 that is 1024 screen px, ulp32 6.1e-5, about 5e-5 of
 * noise at the measured 0.6-0.8 ulp - five times under cap/4. At 0.10 to 0.15
 * it is 100 to 150 screen px, which is the regime the first measurement read directly.
 */
export const RUNG_SPACING = 2048;

/** Beyond this the ladder doubles its spacing instead of growing.
 * Alan's 114822 layout px note needs 57 rungs; four times it needs 225. */
export const MAX_RUNGS = 1024;

/** The wrapper CodeMirror owns and the ladder inside it. */
export interface DocumentAnchorLadder {
	readonly wrapper: HTMLElement;
	/** Rung k sits at `k * spacing` layout px below the document top. */
	rungs: HTMLElement[];
	spacing: number;
}

const ladders = new WeakMap<EditorView, DocumentAnchorLadder>();

/**
 * `null` whenever the extension is absent, the widget has not rendered yet or
 * the view was torn down - every caller falls back to the shipped `anchorTop`.
 * A stale entry after a teardown would answer with a detached element's rect,
 * which is all zeros and would move ink.
 */
export function documentAnchorLadder(view: EditorView): DocumentAnchorLadder | null {
	const held = ladders.get(view);
	return held && held.rungs.length > 0 && anchorIsLive(held.wrapper, view) ? held : null;
}

/**
 * Is the wrapper still where the arithmetic assumes, checked with DOM
 * PROPERTIES ONLY - no rect, no computed style, no layout.
 *
 * The invariant is not "it exists" but "it is the in-flow element immediately
 * before contentDOM in contentDOM's own parent". Anything that re-parents the
 * content, or inserts between the two, breaks the identity silently; this is
 * what makes the break loud. A failure falls back to the shipped `anchorTop`
 * for that sync - it never repairs anything on the scroll path.
 */
export function anchorIsLive(wrapper: HTMLElement, view: EditorView): boolean {
	return wrapper.isConnected && wrapper.nextSibling === view.contentDOM && wrapper.parentNode === view.contentDOM.parentNode;
}

function makeRung(index: number, spacing: number): HTMLElement {
	// Obsidian's own DOM helper, not the raw DOM call the plugin checker
	// refuses. The render harness installs the same globals, so production and
	// fixture build this node the same way.
	const rung = createDiv();
	rung.className = "handwriting-document-anchor-rung";
	rung.setAttribute("aria-hidden", "true");
	rung.style.cssText = `position:absolute;left:0;top:${index * spacing}px;width:0;height:0;pointer-events:none`;
	return rung;
}

/**
 * Create the anchor for this view, or do nothing when there is nowhere safe to
 * put it. Called once when the overlay attaches; `unmountDocumentAnchor` is its
 * pair. Idempotent: a second call with a live wrapper keeps the one it has.
 */
export function mountDocumentAnchor(view: EditorView): DocumentAnchorLadder | null {
	// Once refused, never again for this note in this view.
	if (documentAnchorRefused(view)) return null;
	const held = ladders.get(view);
	if (held && anchorIsLive(held.wrapper, view)) return held;
	const host = view.contentDOM.parentElement;
	// The scroller is the one parent this must never use: it is
	// `position: relative` (InkOverlay sets it), so the rungs would resolve
	// against the VIEWPORT's scroll box and stop following the document.
	if (!host || host === view.scrollDOM) return null;
	// RE-INSERT rather than leave a second one behind: the placement check can fail because
	// something re-parented the content, and the old wrapper is then a detached
	// or misplaced element answering with the wrong rect.
	held?.wrapper.remove();
	// And any wrapper this module does not know about: one left by an earlier
	// load of the plugin whose teardown never ran. It is inert - out of flow,
	// zero size, not the live sibling - but it would accumulate once per load.
	// Mount runs only from an idle extent update, never on the scroll path.
	for (const stale of Array.from(host.children)) {
		if (stale !== view.contentDOM && stale.classList.contains("handwriting-document-anchor")) stale.remove();
	}
	const wrapper = createDiv();
	wrapper.className = "handwriting-document-anchor";
	wrapper.contentEditable = "false";
	wrapper.setAttribute("aria-hidden", "true");
	// The placement rule exactly. `position: relative` makes the wrapper the rungs' containing
	// block, so their `top` counts from the content's own top edge and not from
	// the scroller. `display: flow-root` stops a child's margin escaping into
	// the gap between this and `.cm-content`. Height, margin, padding and border
	// are all zero so nothing below moves. `overflow: hidden` keeps the rungs
	// out of the scroller's range (kept as insurance - the ladder growth test did not show it
	// load-bearing, so it is not claimed to be).
	// OUT OF FLOW, with every offset AUTO.
	//
	// `position: relative` cost us U2. The sibling clause in
	// `ownedColumnLayoutLeft` (InkOverlay.ts 4113-4117) returns null for any
	// sibling of a flex ROW that is neither `display: none` nor
	// `position: absolute|fixed`, and `.cm-contentContainer` IS a flex row under
	// obsidian-1.13.7-app.css. An in-flow relative wrapper therefore made that
	// method answer null 23-26 times per round, the X origin fell back to the
	// rect difference, and the noise the Y anchor had just removed came back on
	// X as 23-26 camera-only full redraws (L1e ISOLATION-RESULT.md). Absolute is
	// one of the two kinds that clause already excludes, so the shipped X path
	// is untouched and U2 stands.
	//
	// AUTO OFFSETS, not `top: 0`. Auto leaves the box at its STATIC position -
	// where it would have sat in flow, which in this flex container is the
	// content box's start edge, the same edge `.cm-content` begins on. `top: 0`
	// resolves against the nearest POSITIONED ancestor instead, which is the
	// scroller, and the anchor then stops following the document: measured, with
	// `top: 0` a 1 px growth above the content moves `.cm-content` by 1 and the
	// rung by 0, where `auto` moves both by 1.
	//
	// Out of flow it takes no flex slot and cannot move `.cm-content`; the
	// static position still rides the parent's content box, so title and
	// properties growth moves it exactly as before.
	// `align-self: flex-start` pins the CROSS axis
	// in a flex row whatever the container's `align-items` happens to be. An
	// out-of-flow box still takes its static position from the container, and a
	// `center` or `end` alignment would put that position somewhere other than
	// the edge `.cm-content` starts on. `.cm-contentContainer` computes
	// `align-items: stretch` today (measured), which is harmless for a
	// zero-height box - this makes it not matter.
	wrapper.style.cssText = "position:absolute;top:auto;left:auto;right:auto;bottom:auto;align-self:flex-start;" +
		"width:0;height:0;margin:0;padding:0;border:0;overflow:hidden;pointer-events:none;user-select:none";
	wrapper.appendChild(makeRung(0, RUNG_SPACING));
	// Placement: IMMEDIATELY BEFORE contentDOM in contentDOM's own parent. Not
	// `firstChild` of a class-named container - the invariant is the sibling
	// relationship, and `anchorIsLive` checks exactly that every sync.
	host.insertBefore(wrapper, view.contentDOM);
	const made: DocumentAnchorLadder = { wrapper, rungs: [wrapper.firstElementChild as HTMLElement], spacing: RUNG_SPACING };
	ladders.set(view, made);
	return made;
}

/** Remove the anchor and forget it. A detached wrapper would answer with a
 * rect of zeros, which would move ink, so this is not optional on teardown. */
export function unmountDocumentAnchor(view: EditorView): void {
	ladders.get(view)?.wrapper.remove();
	ladders.delete(view);
}

/**
 * Views whose anchor failed the parity gate, with the note that was
 * open when it failed. The refusal lasts while that note stays open - a theme
 * that displaces the wrapper would otherwise mount and unmount it on every
 * extent update - and a fixed theme is allowed to take effect on the next note
 * open instead. Keyed by the note as well as the view because Obsidian reuses
 * one view for every note a tab opens: a refusal held by the view alone kept
 * the whole tab on the shipped path for its life (audit 117).
 */
const refused = new WeakMap<EditorView, string | null>();

/** The note a view is showing, as the refusal records it. */
function refusalNote(view: EditorView): string | null {
	return view.state.field(editorInfoField, false)?.file?.path ?? null;
}

/**
 * The parity bar, per extent, in displayed CSS px. The design's form: the
 * irreducible rect noise of the operand E exists to remove, plus the rung's
 * own conversion. A flat 2.5e-5 is not reachable at any distance and never was.
 */
export function anchorParityBar(contentTop: number, rungTopLayout: number, cssScale: number): number {
	const ulp32 = (x: number) => { const a = Math.abs(x); return a > 0 && Number.isFinite(a) ? 2 ** (Math.floor(Math.log2(a)) - 23) : 0; };
	return 2.5e-5 + 2 * ulp32(contentTop) + ulp32(rungTopLayout) * cssScale;
}

/**
 * What the gate last refused, for diagnostics and for the test that proves the
 * gate fires. Not a switch: nothing reads it to decide anything.
 */
export const anchorRefusals: { count: number; last: { implied: number; shipped: number; bar: number; delta: number; reason: string } | null } = { count: 0, last: null };

/**
 * The ladder disagreed with `anchorTop` by more than the bar, so it is
 * taken out of service for this view and every consumer - the camera, its
 * read-only twin, the diagnostics - falls back to the shipped path TOGETHER.
 *
 * Correctness over latency, said plainly: a refused ladder means this note
 * keeps the shipped lag under this theme, and keeps correct ink. The record
 * below is what makes that visible rather than silent.
 */
export function refuseDocumentAnchor(view: EditorView, detail: { implied: number; shipped: number; bar: number; reason: string }): void {
	refused.set(view, refusalNote(view));
	unmountDocumentAnchor(view);
	anchorRefusals.count++;
	anchorRefusals.last = { ...detail, delta: Math.abs(detail.implied - detail.shipped) };
}

/** Has this view's anchor been taken out of service for the note it shows? */
export function documentAnchorRefused(view: EditorView): boolean {
	return refused.has(view) && refused.get(view) === refusalNote(view);
}

/**
 * How many rungs an extent needs, and at what spacing, under the cap.
 * Pure, so the doubling rule is testable without a DOM.
 */
export function ladderShape(extentLayoutPx: number): { count: number; spacing: number } {
	let spacing = RUNG_SPACING;
	const extent = Number.isFinite(extentLayoutPx) && extentLayoutPx > 0 ? extentLayoutPx : 0;
	let count = Math.floor(extent / spacing) + 1;
	while (count > MAX_RUNGS) { spacing *= 2; count = Math.floor(extent / spacing) + 1; }
	return { count, spacing };
}

/**
 * Bring the ladder up to the extent the plugin has just granted.
 *
 * CALLED FROM `updateExtent` AND NOWHERE ELSE: that is already a write
 * moment, so the one childList mutation it makes costs the CodeMirror measure
 * that any mutation costs, on a frame that was doing layout work anyway. The
 * widget's height is 0 estimated and 0 measured, so the height map does not
 * change and scroll anchoring has nothing to move.
 *
 * Returns the ladder's rung count, or 0 when there is no ladder to grow.
 */
export function growDocumentAnchorLadder(view: EditorView, extentLayoutPx: number): number {
	// The placement check's repair point: `updateExtent` is a quiet plugin write moment, so a
	// wrapper that lost its place is re-inserted HERE and never on a scroll.
	const held = mountDocumentAnchor(view);
	if (!held) return 0;
	const want = ladderShape(extentLayoutPx);
	if (want.spacing === held.spacing && want.count <= held.rungs.length) return held.rungs.length;
	if (want.spacing !== held.spacing) {
		// Respacing rebuilds, still in ONE childList mutation: a fragment swap
		// rather than a rung at a time.
		const fragment = createFragment();
		const rungs: HTMLElement[] = [];
		for (let i = 0; i < want.count; i++) { const rung = makeRung(i, want.spacing); rungs.push(rung); fragment.appendChild(rung); }
		held.wrapper.replaceChildren(fragment);
		held.rungs = rungs;
		held.spacing = want.spacing;
		return rungs.length;
	}
	const fragment = createFragment();
	for (let i = held.rungs.length; i < want.count; i++) { const rung = makeRung(i, held.spacing); held.rungs.push(rung); fragment.appendChild(rung); }
	held.wrapper.appendChild(fragment);
	return held.rungs.length;
}

/**
 * WHICH RUNG TO READ, arithmetically. A wrong answer costs distance and
 * never correctness, so this clamps rather than refusing: an out-of-range k
 * would read a rung that does not exist, and the nearest one that does is
 * always a legal anchor.
 */
export function rungIndexFor(cameraYLayout: number, spacing: number, count: number): number {
	if (!Number.isFinite(cameraYLayout) || !(spacing > 0) || count <= 0) return 0;
	return Math.min(count - 1, Math.max(0, Math.round(cameraYLayout / spacing)));
}

/**
 * The camera's Y origin in LAYOUT px, from rung `k`.
 *
 * `null` for "cannot say", which is every caller's signal to keep using
 * `anchorTop`: a non-finite rect, or a scale that is not positive. Returning a
 * number here on bad input would move ink.
 */
export function cameraOriginYLayout(
	rungTopLayout: number, overlayTop: number, rungRectTop: number, panY: number, cssScale: number, paddingTop: number,
): number | null {
	if (![rungTopLayout, overlayTop, rungRectTop, panY, cssScale, paddingTop].every(Number.isFinite) || cssScale <= 0) return null;
	// `paddingTop` is the term the wrapper sits ABOVE: it is at the content's
	// border-box top, the document starts at its padding edge. A few px, divided
	// by the believed scale like the residual - never the large rect.
	return rungTopLayout + (overlayTop - rungRectTop + panY - paddingTop) / cssScale;
}

/**
 * The screen coordinate of the document top this anchor IMPLIES, for
 * diagnostics and for the parity check against `anchorTop`. The camera never
 * forms this large number; only a diagnostic does.
 */
export function impliedDocumentTop(rungTopLayout: number, rungRectTop: number, cssScale: number, paddingTop: number): number {
	return rungRectTop - rungTopLayout * cssScale + paddingTop;
}
