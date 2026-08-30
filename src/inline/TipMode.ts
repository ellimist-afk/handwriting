/**
 * What the pen TIP currently is, as one value.
 *
 * The pen decides what it is at contact and needs no mode at all: eraser end
 * erases, side button lassos, tip inks. That only works on hardware that HAS an
 * eraser end and a side button; plenty has neither, so each of those meanings also
 * has an explicit mode that gives it to the tip. Only one can win.
 *
 * This was four independent booleans kept mutually exclusive by hand, and
 * every new mode had to be added to three setters, two predicates, the strip
 * host, three gesture branches and the reticle chain. Pan reached ten of those
 * eleven places; `setInlineTool` was the one that got missed, so "Switch
 * between pen and highlighter" left the tip panning while announcing a nib
 * change. One value makes exclusivity structural rather than a rule four
 * setters have to remember, and the next mode (a ruler is on the roadmap) is
 * one arm of a union instead of an eleventh edit.
 *
 * DOM-free by construction, which is what lets it be unit-tested at all -
 * `InkOverlay` imports `obsidian` and cannot be. Same reason GuardStyle.ts
 * and PenToolsMode.ts are shaped this way.
 */

export type TipMode = "nib" | "eraser" | "lasso" | "space" | "pan";

let mode: TipMode = "nib";
let listener: (() => void) | null = null;

/**
 * Called whenever the mode changes. The modes are global, so every open
 * editor's toolbar goes stale at once: pressing Escape in one pane used to
 * leave another pane's strip lighting a tool that no longer had the tip.
 */
export function setTipModeListener(fn: (() => void) | null): void {
	listener = fn;
}

export function tipMode(): TipMode {
	return mode;
}

/** True while any mode has taken the tip away from the nib. */
export function tipModeHeld(): boolean {
	return mode !== "nib";
}

export function setTipMode(next: TipMode): void {
	if (mode === next) return;
	mode = next;
	listener?.();
}

/**
 * Turn one mode on, or off.
 *
 * Turning a mode OFF only does something when that mode is the one holding
 * the tip: `setEraser(false)` while lassoing must not silently cancel the
 * lasso, which is what a naive `if (!on) mode = "nib"` would do.
 */
export function toggleTipMode(kind: Exclude<TipMode, "nib">, on: boolean): void {
	if (on) setTipMode(kind);
	else if (mode === kind) setTipMode("nib");
}

/** Hand the tip back to the active nib, whichever mode was holding it. */
export function releaseTipMode(): void {
	setTipMode("nib");
}

/** Test seam. */
export function resetTipModeForTest(): void {
	mode = "nib";
	listener = null;
}
