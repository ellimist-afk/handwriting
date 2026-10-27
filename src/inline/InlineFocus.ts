import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { tr } from "./InlinePenRouterTrace";

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
 *
 * WINDOWS IN TABLET MODE has the same keyboard without the iOS answer. There
 * the desktop app runs, nothing is suppressed, and focus arriving in the
 * editor during a pen gesture raises the touch keyboard; the window shrinks
 * and the old caret is scrolled into view, far from where the pen is. It
 * happens whenever something outside the editor took focus first - a button
 * on the page is enough - and the next stroke brings focus back. So the focus
 * stays, and the editor is told first that this focus wants no keyboard:
 * `inputmode="none"` for as long as the pen owns it. The editor gets its
 * ordinary keyboard back on blur, on the next contact inside it that is not a
 * pen, and when the pen-off button asks for the keyboard (`setKeyboardFocus`).
 */
export function focusClaimedPenEditor(
	view: {
		readonly hasFocus: boolean;
		focus(): void;
		readonly contentDOM?: HTMLElement;
		readonly dom?: HTMLElement;
	},
	suppress = false
): void {
	if (suppress || view.hasFocus) return;
	if (view.contentDOM) quietKeyboardForPen(view.contentDOM, view.dom ?? view.contentDOM);
	view.focus();
}

/**
 * The hold goes on at every pen-down in the editor, not only the one that has
 * to bring focus back. A pen-down on an editor that already has focus, and a
 * pen contact nothing claims, used to reach Chromium with the ordinary
 * keyboard setting: the touch keyboard rose and the window shrank under the
 * pen. The listener sits on the editor root in the capture phase, so it runs
 * before anything below the root handles or ends the event.
 * `skip` answers why this surface wants no hold now, or null when it wants
 * one: not once the overlay is gone, not on a touch device, not while the pen
 * is off.
 *
 * Every pen-down also leaves one row in the pen trace, whatever happens to
 * it after: the editor's focus, its inputmode before and after, and whether
 * the hold was placed. Whether the router claimed the contact is on the
 * router's own row for the same event.
 *
 * Returns what takes the listener off the root again. The root outlives the
 * overlay when the editor is reconfigured, so the owner calls it on destroy.
 */
export function holdKeyboardForEveryPen(
	view: { readonly hasFocus: boolean; readonly contentDOM?: HTMLElement; readonly dom?: HTMLElement },
	skip: () => string | null
): () => void {
	if (typeof view.dom?.addEventListener !== "function" || !view.contentDOM) return () => {};
	const root = view.dom;
	const content = view.contentDOM;
	const onPenDown = (ev: PointerEvent) => {
		if (ev.pointerType !== "pen") return;
		const before = content.getAttribute("inputmode");
		const focused = view.hasFocus;
		const why = skip();
		const held = penQuietKeyboard.has(content);
		if (why === null) quietKeyboardForPen(content, root);
		if (diagnosticsEnabled()) {
			const shown = (v: string | null) => (v === null ? "(unset)" : `"${v}"`);
			tr(
				"guard",
				ev,
				`keyboard at pen-down: editor focused=${focused ? "yes" : "no"}, inputmode before=${shown(before)} after=${shown(content.getAttribute("inputmode"))}, ` +
					`hold=${why !== null ? `no (${why})` : held ? "already" : "placed"}`
			);
		}
	};
	root.addEventListener("pointerdown", onPenDown, true);
	return () => root.removeEventListener("pointerdown", onPenDown, true);
}

/** Editors whose keyboard is held down for the pen, and how to give it back. */
const penQuietKeyboard = new WeakMap<object, () => void>();

function quietKeyboardForPen(content: HTMLElement, root: HTMLElement): void {
	if (penQuietKeyboard.has(content)) return;
	const prior = content.getAttribute("inputmode");
	content.setAttribute("inputmode", "none");
	const onDown = (e: Event) => {
		if ((e as PointerEvent).pointerType !== "pen") release();
	};
	const release = () => {
		penQuietKeyboard.delete(content);
		content.removeEventListener("blur", release);
		root.removeEventListener("pointerdown", onDown, true);
		// Changed by someone else since: theirs now, leave it.
		if (content.getAttribute("inputmode") !== "none") return;
		if (prior === null) content.removeAttribute("inputmode");
		else content.setAttribute("inputmode", prior);
	};
	content.addEventListener("blur", release);
	// Capture, so the editor's own handling of a finger or mouse tap already
	// sees the ordinary keyboard setting.
	root.addEventListener("pointerdown", onDown, true);
	penQuietKeyboard.set(content, release);
}

/** Give the editor its ordinary keyboard back, if the pen was holding it down. */
function releasePenKeyboardQuiet(content: object): void {
	penQuietKeyboard.get(content)?.();
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
 *
 * The keyboard hold `focusClaimedPenEditor` puts on the editor is released
 * BEFORE the focus call, or the button that asks for the keyboard would focus
 * an editor that still says it wants none.
 */
export function setKeyboardFocus(
	view: { focus(): void; readonly contentDOM: { blur(): void } },
	wanted: boolean
): void {
	if (wanted) {
		releasePenKeyboardQuiet(view.contentDOM);
		view.focus();
	} else view.contentDOM.blur();
}
