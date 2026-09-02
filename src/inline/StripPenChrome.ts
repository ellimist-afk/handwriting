import type { MobileTools } from "./MobileTools";

/**
 * Pen-contact and pen-lift chrome for a MobileTools strip, plus the keyboard
 * claim that goes with a claimed pen gesture - shared by both ink surfaces
 * (note: InkOverlay.ts; pdf: PdfInkController.ts) so a fix to one is a fix to
 * both. Every entry on this list is a release where the note surface got a
 * fix and the pdf surface did not: the pen reticle, the selection commands,
 * the strip dispatch, the pen-down chrome (tools-59, 2026-09-02: "selecting
 * eraser and then touching it to pdf to erase doesnt close the slider/
 * selection box" - the pdf's `penDown` called neither `setInking` nor
 * `closeInkSliders` at all), and now the FIFTH, keyboard focus (alan, device,
 * 2026-09-02: "lasso'd it, trashcan lit up, hit delete, trashcan and undo
 * dimed, but nothing deleted" - he never said whether "delete" was the key or
 * the trash button, and this seam covers only the key - see `stripPenFocus`).
 * Each hand-copy is another chance to diverge, so both surfaces call only
 * these functions;
 * StripPenChrome.test.ts asserts nothing else in either source file calls
 * `setInking(`, `closeInkSliders(` or `.focus(` directly.
 */

/**
 * A gesture is starting, whichever one: the strip steps aside and its
 * drop-down chrome closes. This sat in the note's ink branch alone until
 * 2026-08-27, so the toolbar stayed put under an eraser and covered the ink
 * being rubbed out; the pdf surface never got either call at all until this.
 * `stripPenUp`, below, restores it for every gesture already, so only the
 * hide was one-sided.
 */
export function stripPenDown(tools: MobileTools | null | undefined): void {
	tools?.setInking(true);
	// Which pops close on pen contact: every one closeInkSliders knows about,
	// the eraser's included (alan, 2026-09-02, reversing Slice Q's exception:
	// "you eraser pop should close when pen touches down... we did it for
	// other tools but never did it for eraser"). The decision of WHICH pops
	// that is lives entirely inside MobileTools.closeInkSliders - this is the
	// one call, not a list, so both surfaces follow it without a second
	// divergence if it ever changes again.
	tools?.closeInkSliders();
}

/**
 * The stroke is over: the strip returns (a beat later, so an eraser scrub's
 * rapid lift-and-reland does not strobe it) and its buttons catch up with
 * what undo can do now. The catch-up is a microtask, NOT immediate: every
 * gesture dispatches its own ops after pen-up runs, so a synchronous
 * refresh here would read the history depth from BEFORE the gesture -
 * after the first stroke on a fresh note, a working undo button kept
 * wearing the disabled look that issue #1 was filed about. The microtask
 * runs once pen-up (and everything it dispatched) has returned, whichever
 * gesture it was.
 */
export function stripPenUp(tools: MobileTools | null | undefined): void {
	tools?.setInking(false);
	queueMicrotask(() => tools?.refresh());
}

/**
 * Make a non-editor ink surface focusable, once, at mount.
 *
 * `tabindex="-1"` is focusable by script and never by Tab: the pane is not a
 * control and must not join the tab order. The keys this exists for are
 * pressed by a hand already holding a pen over this pane, so script focus is
 * the only entry it needs.
 */
export function armStripPenFocus(root: HTMLElement | null | undefined): void {
	// Duck-typed and forgiving, for the same reason `ensureTools` swallows a
	// strip that cannot mount: chrome must never be the thing that takes the
	// ink down with it. A controller can also be built without a real root -
	// PdfInkController.test.ts constructs one with a bare object.
	if (!root || typeof root.setAttribute !== "function") return;
	if (typeof root.hasAttribute === "function" && root.hasAttribute("tabindex")) return;
	root.setAttribute("tabindex", "-1");
}

/**
 * The keyboard follows the pen, on a surface that is not an editor.
 *
 * The note's half of this is `focusClaimedPenEditor` (InlineFocus.ts), whose
 * header says it exists so "Delete and the editor's undo/redo keys still
 * belong to the note the pen just acted on": `InlinePenRouter.armOwnership`
 * preventDefaults `mousedown` window-wide for the whole claimed gesture, and
 * preventDefault on mousedown is exactly what suppresses native focus, so a
 * claimed pen focuses nothing and the surface has to ask for it back. The pdf
 * surface never asked - it contained no `focus()` call at all - and its
 * Delete/Backspace/Escape/undo keys are not commands but a keydown CAPTURE
 * listener bound to its own root, which therefore only fires when focus is
 * already inside that pane. So after a pen lasso on a pdf the key went to
 * `document.body`, or in a split to the note in the other pane where
 * Backspace edits text, and Delete over a visible lasso did nothing (alan,
 * device, 2026-09-02). Pen-specific: a finger or a mouse tap is not claimed
 * and does focus the pane, which is why it looked intermittent and why no
 * desktop mouse test reproduced it.
 *
 * Called on EVERY pen-down that starts a gesture, not only on a lasso, for
 * the reason the note's header gives: undo/redo is half of what focus buys,
 * and those follow an ink stroke as much as Delete follows a selection.
 * Narrowing it to the selection gestures would leave Ctrl+Z after inking a
 * pdf going wherever focus happened to be - a sixth divergence, in the file
 * written to stop them.
 *
 * No `suppress` twin of the note's: that flag exists because focusing a
 * CONTENTEDITABLE on iOS is the gesture that raises the software keyboard.
 * A root carrying `tabindex="-1"` is not editable and raises nothing.
 */
export function stripPenFocus(root: HTMLElement | null | undefined): void {
	if (!root || typeof root.focus !== "function" || typeof root.contains !== "function") return;
	// "Do it only when needed", the same guard `focusClaimedPenEditor` states
	// as `view.hasFocus` - asked here of containment, because what holds the
	// focus may be a descendant. A pdf pane still contains places to type:
	// the viewer's find bar and the document's own form fields, the two the
	// keydown listener's `isTypingTarget` check already names. Both are
	// inside the root, so this never takes the caret out from under someone
	// typing in this pane. A typing target OUTSIDE the root is in another
	// pane, which a pen landing on THIS one is deliberately leaving - the
	// same thing a tap there would have done natively.
	if (root.contains(root.ownerDocument.activeElement)) return;
	// preventScroll because there is nothing to scroll into view: the pen is
	// on the glass over this pane already. Without it, focus() asks every
	// scrollable ancestor to reveal the root, and on a phone the leaf stack
	// IS a horizontal scroller - a pen-down that slid the workspace to a
	// different pane would be a worse bug than the one this fixes.
	root.focus({ preventScroll: true });
}
