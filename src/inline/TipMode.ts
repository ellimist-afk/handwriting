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

/**
 * What the pen is at CONTACT, as one value: the whole arbitration between the
 * hardware the pen has and the mode the strip is in.
 *
 * The header above states this rule in prose - eraser end erases, side button
 * lassos, tip inks, and each meaning also has an explicit mode for hardware
 * that has neither, "only one can win". It was implemented TWICE, once per ink
 * surface, in `InkOverlay.penDown` and `PdfInkController.penDown`, and the two
 * copies were written months apart. Both copies were right on the day this was
 * factored out; that is not the point. The point is that the side button was
 * one of them once already - the pdf checked only the toolbar mode, so holding
 * the button over a pdf did nothing at all, on the surface where the toolbar is
 * hardest to reach (hardware, 2026-08-29) - and a rule with two implementations
 * is a rule that can diverge again. This one now has one.
 *
 * PURE and DOM-free, taking the two `PointerEvent` fields rather than the
 * event: it is the same shape as `bandEraserIntent` (InlinePenRouter.ts), it
 * keeps this module testable, and it lets the pdf surface - whose `penDown`
 * takes `ev` as optional, because its own teardown paths call it without one -
 * pass `ev?.buttons ?? 0, ev?.button ?? -1` and get exactly the answer its
 * hand-written `ev ? ... : false` ternaries gave.
 *
 * `button` is -1 for a "no button changed" event, which is the value the DOM
 * itself uses and the reason -1 is the right default rather than 0 (0 is the
 * primary button).
 *
 * What this does NOT decide, deliberately: whether a bare tip landing inside a
 * live selection should GRAB it instead of inking. That answer needs the
 * selection's bounds in the surface's own coordinate space - note space on one
 * surface, page space on the other - so it stays at both call sites, where the
 * geometry is. Both consult `intent === "erase"` first, because an eraser is
 * not a bare tip; that part is here.
 */
export type PenContactIntent = "erase" | "lasso" | "pan" | "space" | "ink";

export function penContactIntent(buttons: number, button: number, m: TipMode): PenContactIntent {
	// The eraser end, first and above everything: a pen turned over is an
	// unambiguous statement of intent and must not need the toolbar to agree
	// with it. `buttons & 32` is the eraser held; `button === 5` is the
	// transition that reports it.
	if ((buttons & 32) !== 0 || button === 5 || m === "eraser") return "erase";
	// Then the side button, held at contact. `buttons & 2` is the secondary
	// button, and "lasso" is the mode that gives the same meaning to hardware
	// with no side button - every apple pencil, every mouse.
	if ((buttons & 2) !== 0 || m === "lasso") return "lasso";
	// The remaining modes only reach the tip once no button has spoken for it.
	if (m === "pan") return "pan";
	if (m === "space") return "space";
	return "ink";
}

/** Test seam. */
export function resetTipModeForTest(): void {
	mode = "nib";
	listener = null;
}
