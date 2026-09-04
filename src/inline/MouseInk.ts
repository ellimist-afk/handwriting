/**
 * The mouse-ink switch (roadmap: mouse input).
 *
 * The router's founding contract says "Mouse -> never touched": on an
 * ordinary note the editor owns the mouse, and claiming it would break text
 * selection for everyone to serve the people without a pen. So mouse inking
 * is an explicit MODE, off by default, flipped by a command and persisted in
 * settings. While it is on, the LEFT button inks exactly the way a pen tip
 * does (Chromium reports pressure 0.5 for a pressed mouse, so the width law
 * has something honest to chew on) and text selection by mouse is knowingly
 * given up. Right and middle stay native: no lasso-by-right-drag, because
 * the context menu owns that button and fighting it helps nobody.
 *
 * DiagSwitch's shape: module state, two functions, no obsidian import.
 */

let enabled = false;
export function mouseInkEnabled(): boolean {
	return enabled;
}

export function setMouseInk(on: boolean): void {
	enabled = on;
}

/**
 * Is this pointer a mouse that is currently standing in for a pen?
 *
 * The whole of the mode's meaning, in one place. `InlinePenRouter` has carried
 * this expression as a private method since the mode was added and it is the
 * gate on every one of that file's pen paths; it now calls this, and so does
 * `pointerRaisesPenTools` (PenToolsMode.ts), which is what the two ink
 * surfaces read. Written once because a rule implemented twice is this
 * project's most expensive recurring defect and it would be a poor joke to
 * add another while closing one.
 *
 * Takes the TYPE rather than the event: the strip and the surfaces have a
 * `pointerType` string in hand and no event, and the router has both.
 */
export function mouseActsAsPen(pointerType?: string): boolean {
	return pointerType === "mouse" && enabled;
}

/**
 * Persistence hook, the eraser slider's pattern: main registers a writer so
 * the strip can arm mouse ink QUIETLY as part of a tool click - one click,
 * one toast (alan, 2026-08-31) - without losing the setting on restart.
 * The toggle command stays the loud path.
 */
let persist: ((on: boolean) => void) | null = null;
export function setPersistMouseInk(fn: (on: boolean) => void): void {
	persist = fn;
}
export function armMouseInkQuietly(): void {
	if (enabled) return;
	enabled = true;
	persist?.(true);
}

/**
 * The other direction, and the same silence: putting a tool DOWN with a mouse
 * hands the pointer back to text.
 *
 * ALAN, 2026-09-03. Clicking the tool you are holding already dropped mouse
 * ink for the two nibs, but the eraser, lasso, insert-space and pan only
 * toggled back to the last nib - which for a mouse is not putting anything
 * down, since the pointer is still claimed and still cannot select text. The
 * only way back to the cursor from the eraser was to click a button you were
 * not using. His words: "much more consistent for them all to be dropped and
 * revert back to mouse cursor".
 *
 * Quiet for the reason `armMouseInkQuietly` is: the tool command that runs
 * beside this already toasts, and one click owes one toast (alan,
 * 2026-08-31). The toggle command stays the loud path.
 *
 * Callers must also put the nib light out - turning mouse ink off darkens it
 * "at any point" - which is why the two are paired once in
 * `releaseMouseInkQuietly` (PenToolsMode.ts) rather than at each call site.
 * This module cannot do it itself: `PenToolsMode` imports `mouseActsAsPen`
 * from here, so importing it back would be a real cycle.
 */
export function disarmMouseInkQuietly(): void {
	if (!enabled) return;
	enabled = false;
	persist?.(false);
}

/**
 * Told to the tool's own toggle command: THIS particular off-toggle is a
 * mouse put-down, not a pen or touch tap.
 *
 * The strip's put-down branch (MobileTools.ts, `disarmMouseInkQuietly`'s
 * caller) still has to run the eraser/lasso/insert-space/pan command itself
 * - that command is what actually reverts the mode, `enterTipMode`'s half of
 * it - and that command still shows exactly one Notice, same as any other
 * press of it (one click, one toast). The trouble is which words: that
 * Notice was written for the OTHER caller of the same off edge, a pen or
 * touch tap that really did just pick the nib the tip fell back to, and
 * says so - "Handwriting: highlighter". A mouse put-down picked nothing; it
 * got its cursor back, and the correct words for that are already sitting in
 * the loud mouse-ink-toggle command's own off branch, "Handwriting: mouse
 * ink off" - alan's device finding, 2026-09-03 ("toast is incorrect ... it
 * says highlighter after doing it").
 *
 * The command has no other way to tell a mouse put-down apart from an
 * ordinary toggle: it never sees a pointer, so `mouseInkEnabled()` alone
 * cannot answer this - a pen user hitting the eraser hotkey with mouse ink
 * left on from an earlier session must NOT get the mouse's wording. Only the
 * strip's click handler knows the pointer type, so it sets this immediately
 * before calling exec, and the command consumes (reads and clears) it while
 * building its own Notice. Read-and-clear, not a plain flag, so a stray
 * later toggle - hotkey, palette, another pointer - can never inherit a
 * signal meant for the one press that set it.
 */
let mousePutDown = false;
export function markMousePutDown(): void {
	mousePutDown = true;
}
export function consumeMousePutDown(): boolean {
	const was = mousePutDown;
	mousePutDown = false;
	return was;
}
