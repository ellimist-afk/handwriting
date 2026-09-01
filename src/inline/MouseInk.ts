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
