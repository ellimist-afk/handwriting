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

/**
 * The pen-off toggle's half of the same seam, and the exact opposite of the
 * `suppress` flag above: here raising the software keyboard IS the request.
 *
 * Turning the pen off means the user wants to type (PenInk.ts, and the report
 * it came from - "I couldn't see how to toggle it off or activate the
 * keyboard input when I needed it"). On iOS and Android the only thing that
 * raises the soft keyboard is focusing a contenteditable INSIDE A USER
 * GESTURE, which is why the strip button calls this from its click handler
 * rather than the command doing it after the fact - a focus call from a
 * hotkey or the palette has no gesture behind it and both platforms ignore
 * it. Turning the pen back on blurs instead, so the keyboard goes down and
 * gives the glass back to the ink.
 *
 * NO `hasFocus` GUARD on the way in, unlike its neighbour. That guard is
 * there because repeated focus during ordinary writing buys nothing; this
 * runs once per deliberate button press, and the case that most needs it is
 * an editor that already reads as focused with the keyboard dismissed.
 *
 * Lives here rather than at the two hosts for the reason this module exists:
 * StripPenChrome.test.ts sweeps the whole tree for `.focus(` and allows it
 * only in the shared claim helpers, precisely so a surface cannot hand-roll
 * its own focus rule and diverge. This is the note's helper; the pdf has no
 * editor to focus and its host implements the same seam as a no-op.
 */
export function setKeyboardFocus(
	view: { focus(): void; readonly contentDOM: { blur(): void } },
	wanted: boolean
): void {
	if (wanted) view.focus();
	else view.contentDOM.blur();
}
