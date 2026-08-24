/**
 * Claimed pen events are cancelled before Chromium can focus CodeMirror.
 * Restore that focus explicitly so Delete and the editor's undo/redo keys
 * still belong to the note the pen just acted on. Do it only when needed;
 * repeated focus calls during ordinary writing buy nothing.
 */
export function focusClaimedPenEditor(view: { readonly hasFocus: boolean; focus(): void }): void {
	if (!view.hasFocus) view.focus();
}
