/**
 * The standing gesture guard's STYLE half: what "armed" physically writes
 * to the editor's scroller (the decision half is ManipulationGuard, the
 * timers live in InlinePenRouter).
 *
 * Armed means two things, always together:
 *
 *   1. `touch-action: none` as an inline style on `.cm-scroller` itself,
 *      the v0.12.10 cold-contact fix. Chromium snapshots the allowed
 *      gestures from the committed compositor state at contact, so the
 *      opt-out must already be in place before a pen exists.
 *
 *   2. A marker class on the scroller that styles.css turns into
 *      `touch-action: none` on EVERY descendant. Blink re-enables panning
 *      inside every nested scroll container: an element whose own overflow
 *      is auto/scroll gets pan-x/pan-y OR'ed back into the touch-action it
 *      inherits (style_adjuster.cc, AdjustTouchActionForElement: "since
 *      panning is implemented by the scroller it is re-enabled for
 *      scrolling elements"), whether or not it has anything to scroll.
 *      Obsidian's editor has several such containers inside the scroller:
 *      the embedded backlinks pane (`.backlink-pane`, overflow-y: auto),
 *      table widgets, math blocks, callout content, embeds. Inside them
 *      the scroller's `none` was silently `pan-y`/`pan-x` again: a pen
 *      drag with a vertical component past slop became a scroll gesture,
 *      the stroke died with pointercancel, and the band across "Linked
 *      mentions / No backlinks found / Unlinked mentions" read as dead
 *      (hardware, 2026-08-22). No CSS selector can enumerate scroll
 *      containers by computed style, so the rule is universal under the
 *      class (inert for everything that already inherited none, closing
 *      exactly the holes), and the class moves in lock-step with the inline
 *      style so the touch window (native finger panning) still opens
 *      everywhere at once.
 *
 * DOM-free by construction so the pairing is unit-tested.
 */

export const GUARD_SUBTREE_CLASS = "handwriting-touch-guard";

export interface GuardStyleTarget {
	setCssStyles(styles: { touchAction: string }): void;
	classList: { add(name: string): void; remove(name: string): void };
}

/** Arm: inline `none` on the scroller plus the subtree class. */
/**
 * `none` suits an editor, where the plugin replaces finger scrolling with its
 * own 1:1 assist pan and owes the browser nothing back. A pdf viewer is
 * different: nothing here implements a pinch, so `none` does not merely
 * disable zooming - it hands the raw two-finger touches to the app, which
 * reads their sideways component as its open-the-sidebar swipe. That surface
 * passes `pinch-zoom`: single-finger panning stays denied, which is the
 * arbitration a cold pen contact has to survive, while the browser owns
 * two-finger gestures and consumes them (hardware, ipad, 2026-08-29 -
 * unreliable pinch, and a backlinks panel that kept appearing).
 */
export function armGuardStyle(el: GuardStyleTarget, touchAction = "none"): void {
	el.setCssStyles({ touchAction });
	el.classList.add(GUARD_SUBTREE_CLASS);
}

/** Disarm: put back what the inline style carried before, drop the class. */
export function disarmGuardStyle(el: GuardStyleTarget, restoreTo: string): void {
	el.setCssStyles({ touchAction: restoreTo });
	el.classList.remove(GUARD_SUBTREE_CLASS);
}
