/**
 * The mouse's half of shape snap: an OFFER, never a correction.
 *
 * THE DEFECT (Alan, hardware, 2026-09-05, verbatim): "it's correcting into a
 * straight line", "one stub". Shape snap measures its dwell as time since the
 * last raw pointer MOVE, with no device term in it. A pen leaving the glass
 * keeps producing movement, so a pen's dwell really is a deliberate hold. A
 * mouse does not move at all while the button comes up - the cursor sits
 * exactly where it stopped - so an ordinary deliberate stroke ends with a
 * >= DWELL_MS "hold" nobody performed, the recognizer runs, and the freehand
 * is replaced by a fitted figure whose ends are the fit's extremes rather
 * than the pen's. That is why it reads as a line drawn back past where the
 * stroke started. Shape snap is on by default, so every mouse user has it.
 *
 * ALAN'S RULING (verbatim): "i dont like teaching hotkeys, this must be the
 * only one required", and then "yeah that sounds great, chip on a certain
 * dwell sounds great as long as it doesnt get in the way during normal
 * handwriting OR drawing art". So: no modifier key, no new setting, and
 * nothing at all on an ordinary mouse stroke. A mouse that dwells AND that
 * the fitter would accept gets its stroke committed exactly as drawn, plus
 * this one small button beside where the stroke ended. Handwriting stays
 * quiet because letters end on the move - no dwell, no chip.
 *
 * PEN AND FINGER ARE UNTOUCHED. They keep the hold-still snap they have had
 * since 1.2.0, including its two-op history. Nothing in this module runs for
 * them.
 *
 * WHY A MODULE OF ITS OWN, and why it is duck-typed rather than typed against
 * the DOM: `InkOverlay.ts` imports `obsidian` and so cannot be constructed
 * under vitest at all, and the suite runs on node with no DOM. The handful of
 * element calls the chip makes are declared as structural interfaces below,
 * which is exactly what the fake element tree the inline tests already use
 * (MobileTools.test.ts's `FakeEl`) satisfies - so the chip's whole lifecycle,
 * including its four dismissals, is tested by being run rather than by being
 * grepped.
 *
 * THE CLICK HAS TO SURVIVE THE PEN ROUTER. The chip is planted inside the ink
 * overlay, which is inside the scroller, and `InlinePenRouter` registers its
 * `pointerdown` on the scroller in the CAPTURE phase - so with mouse ink armed
 * (which it must be, or the stroke that raised this chip could not have been
 * drawn) that listener would claim the contact, `preventDefault` it and start
 * a one-point stroke ON the button. Registering our own capture listener on
 * the scroller cannot beat it: same node, and the router registered first.
 * So the guard sits one node OUT - `guardRoot`, the scroller's parent - where
 * the capture phase genuinely runs first, and it does exactly one thing to a
 * contact aimed at the chip: `stopPropagation()`. NOT `preventDefault()`: the
 * chip is activated by a real click, and the click is a default action of the
 * contact this would otherwise be cancelling.
 */

/** The plugin's own class on the chip. Styled in styles.css, both themes. */
export const SNAP_CHIP_CLASS = "handwriting-snap-chip";

/** The whole of its copy. No hotkey in it, and no jargon. */
export const SNAP_CHIP_LABEL = "Snap";

/**
 * How long an unanswered offer stands. Long enough to notice and reach, short
 * enough that it is gone before it can be mistaken for chrome - and every
 * other dismissal (a new contact, a key, a scroll) beats it in practice.
 */
export const SNAP_CHIP_MS = 2000;

/**
 * Down and to the right of the last point, so the chip never covers the end
 * of the stroke it is offering to replace - the one part of the drawing the
 * reader is looking at while deciding.
 */
export const SNAP_CHIP_OFFSET = 14;

/**
 * The chip's box, for the CLAMP only - it is never written onto the element,
 * which sizes itself from its text and padding. A number here that is smaller
 * than the real pill would let a corner of it past the pane edge; larger
 * simply pulls it in sooner. These match the padding and font in styles.css
 * with room to spare in the direction that cannot hurt.
 */
export const SNAP_CHIP_W = 56;
export const SNAP_CHIP_H = 26;

/**
 * What a listener is handed. Only `target`, `stopPropagation` and (on the
 * chip's own mousedown) `preventDefault` are ever touched, and all are
 * optional so the fake events the tests fire are as
 * valid an input as a real `PointerEvent` - which satisfies this shape
 * exactly, which is what makes the real DOM assignable to the interfaces
 * below without a cast anywhere.
 */
export interface ChipEvent {
	target?: unknown;
	stopPropagation?(): void;
	preventDefault?(): void;
}

/** The one element call the chip's parent has to answer. */
export interface ChipParent {
	createDiv(opts: { cls: string; text?: string }): ChipEl;
}

/** ...and the ones the chip itself does. */
export interface ChipEl {
	setCssStyles(styles: Record<string, string>): void;
	setAttribute(name: string, value: string): void;
	addEventListener(type: string, fn: (ev: ChipEvent) => void): void;
	contains(node: unknown): boolean;
	remove(): void;
}

/** A listener target: the guard root, the scroller and the document. */
export interface ChipTarget {
	addEventListener(type: string, fn: (ev: ChipEvent) => void, options?: unknown): void;
	removeEventListener(type: string, fn: (ev: ChipEvent) => void, options?: unknown): void;
}

/** The editor's own window, for the timer - never the global one. */
export interface ChipClock {
	setTimeout(fn: () => void, ms: number): number;
	clearTimeout(id: number): void;
}

/**
 * Everything one offer needs, handed in fresh each time rather than held.
 *
 * The overlay's container, pane box and window are all replaced by a remount,
 * and a chip that cached them would be planting itself in a detached tree the
 * first time a note was reopened.
 */
export interface SnapChipDeps {
	/** The ink overlay container: the chip's coordinates are ITS coordinates. */
	parent: ChipParent;
	/** The scroller's PARENT. See the module header: capture order is the point. */
	guardRoot: ChipTarget;
	/** The scroller. A scroll under a standing offer withdraws it. */
	scroller: ChipTarget;
	/** The document. Any key withdraws it. */
	keyRoot: ChipTarget;
	/**
	 * The area the chip may sit in, in `parent`'s own css px. For the note
	 * overlay that is the part of its ink band (ScrollBand.ts) the scroller
	 * shows: the band is deliberately larger than the visible pane, by its
	 * scroll margin, and a chip clamped to the band could land below or right
	 * of the pane, where scrolling to it withdraws it. Without `left`/`top`
	 * the area starts at the parent's corner.
	 */
	pane: { left?: number; top?: number; width: number; height: number };
	clock: ChipClock;
}

/**
 * Where the chip sits, given the stroke's last point and the pane.
 *
 * Pure, and exported, because "it never covers the end of the stroke" and "it
 * never leaves the pane" are two claims a test should be able to make about
 * arithmetic rather than about a rendered box. A pane too small to hold the
 * chip clamps to its top-left rather than going negative.
 *
 * `pane.left` and `pane.top` place the visible area inside the parent when it
 * does not start at the parent's corner: the note overlay's parent is its
 * scroll band, which reaches up to a margin past the visible pane on every
 * side, and a chip clamped only to the band could sit where the pane cannot
 * show it.
 */
export function snapChipOrigin(
	x: number,
	y: number,
	pane: { left?: number; top?: number; width: number; height: number }
): { left: number; top: number } {
	const left0 = pane.left ?? 0, top0 = pane.top ?? 0;
	return {
		left: Math.max(left0, Math.min(x + SNAP_CHIP_OFFSET, left0 + pane.width - SNAP_CHIP_W)),
		top: Math.max(top0, Math.min(y + SNAP_CHIP_OFFSET, top0 + pane.height - SNAP_CHIP_H)),
	};
}

/**
 * One surface's snap offer. At most one chip exists per surface at a time: a
 * new offer takes the standing one down first, so a run of mouse strokes
 * never leaves a trail of buttons behind it.
 */
export class SnapChip {
	private el: ChipEl | null = null;
	private timer: number | null = null;
	private clock: ChipClock | null = null;
	/** Every listener this offer added, each paired with its own removal. */
	private undo: Array<() => void> = [];

	/** Is an offer standing? Read by tests and by the overlay's teardown. */
	get showing(): boolean {
		return this.el !== null;
	}

	/**
	 * Offer the snap beside (x, y), in the parent's coordinates.
	 *
	 * `take` runs on a click and nothing else, and runs at most ONCE: the chip
	 * is taken down in a `finally`, so neither a throw inside `take` nor a
	 * second click on an element some caller kept a reference to can leave the
	 * button standing or apply the swap twice.
	 */
	offer(deps: SnapChipDeps, x: number, y: number, take: () => void): void {
		this.dismiss();
		const el = deps.parent.createDiv({ cls: SNAP_CHIP_CLASS, text: SNAP_CHIP_LABEL });
		const at = snapChipOrigin(x, y, deps.pane);
		el.setCssStyles({
			position: "absolute",
			left: `${at.left}px`,
			top: `${at.top}px`,
			// The overlay container is `pointer-events: none` so ink never eats
			// a click meant for the text under it. The chip is the one thing in
			// there that IS pressable, and it says so itself rather than the
			// container relaxing the rule for everything it holds.
			pointerEvents: "auto",
		});
		// Not in the tab order: this is a transient offer that expires in two
		// seconds, and a focus stop that vanishes under the cursor is worse
		// than no focus stop. `role`/`aria-label` still name it for a reader
		// that lands on it some other way.
		el.setAttribute("tabindex", "-1");
		el.setAttribute("role", "button");
		el.setAttribute("aria-label", SNAP_CHIP_LABEL);
		this.el = el;
		this.clock = deps.clock;

		// A mouse press on a focusable element focuses it by default, and the
		// chip is focusable (tabindex -1). Taking the chip down then drops focus
		// on the body, and Ctrl/Cmd+Z no longer reaches the note (audit 171).
		// Cancelling the mousedown keeps focus where it was; the click that
		// takes the snap still fires, since it is not mousedown's default.
		el.addEventListener("mousedown", (ev) => ev.preventDefault?.());
		el.addEventListener("click", () => {
			// `this.el === el` is the once-only latch: a click arriving on a
			// chip this object has already taken down is a click on a stale
			// element, and taking the snap again would replace a stroke that
			// is no longer there.
			if (this.el !== el) return;
			try {
				take();
			} finally {
				this.dismiss();
			}
		});

		// The chip never takes pointer capture, and it does not need to: the
		// gesture it answers is one click on itself.
		const onDown = (ev: ChipEvent): void => {
			if (this.el?.contains(ev.target ?? null)) {
				// Ours. Keep the offer standing and keep the pen router off it -
				// see the module header for why stopPropagation and nothing more.
				ev.stopPropagation?.();
				return;
			}
			this.dismiss();
		};
		const onAway = (): void => this.dismiss();
		this.listen(deps.guardRoot, "pointerdown", onDown, true);
		this.listen(deps.keyRoot, "keydown", onAway, true);
		// Passive: a scroll is only ever being observed here, never cancelled.
		this.listen(deps.scroller, "scroll", onAway, { passive: true });

		this.timer = deps.clock.setTimeout(() => {
			this.timer = null;
			this.dismiss();
		}, SNAP_CHIP_MS);
	}

	/**
	 * Take the offer down with NO change to the note, and leave nothing
	 * running. Idempotent: unmount calls it over a chip that has already
	 * expired, and every dismissal path calls it exactly once more than it
	 * strictly has to.
	 */
	dismiss(): void {
		if (this.timer !== null) {
			this.clock?.clearTimeout(this.timer);
			this.timer = null;
		}
		this.clock = null;
		for (const off of this.undo) off();
		this.undo = [];
		this.el?.remove();
		this.el = null;
	}

	private listen(
		target: ChipTarget,
		type: string,
		fn: (ev: ChipEvent) => void,
		options: unknown
	): void {
		target.addEventListener(type, fn, options);
		this.undo.push(() => target.removeEventListener(type, fn, options));
	}
}
