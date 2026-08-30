/**
 * Claimed pen events are cancelled before Chromium can focus CodeMirror.
 * Restore that focus explicitly so Delete and the editor's undo/redo keys
 * still belong to the note the pen just acted on. Do it only when needed;
 * repeated focus calls during ordinary writing buy nothing.
 *
 * `suppress` exists for touch devices. Focusing a contenteditable on iOS IS
 * the gesture that raises the software keyboard, and this runs on every
 * pen-down - so a stroke summoned the keyboard, and hiding it blurred the
 * editor so the next stroke summoned it again. Reported twice from iPads
 * (2026-08-30), including "it pops up every time".
 *
 * What suppressing costs: the keys this restores are Delete and undo, which
 * a touch device without a hardware keyboard cannot send anyway. With one
 * attached, iOS does not raise the software keyboard on focus - so the case
 * that loses something is the case that never had the bug, and it loses only
 * the routing of two shortcuts after a pen stroke.
 */
export function focusClaimedPenEditor(
	view: { readonly hasFocus: boolean; focus(): void },
	suppress = false
): void {
	if (suppress || view.hasFocus) return;
	view.focus();
}
