/**
 * The strip's drag to anchor: arming a handle, the drop on the nearest anchor, the flight, the cancel and the click swallow.
 * They are methods of MobileTools, installed on its prototype when MobileTools.ts loads.
 */
import { dragPassedThreshold, nearestAnchor, TOOLBAR_ANCHOR_INSET_PX } from "./ToolbarDrag";
import { installMethods } from "./InstallMethods";
import { ANCHOR_FLIGHT_MS, type ToolbarDragState, type MobileTools } from "./MobileTools";

declare module "./MobileTools" {
	interface MobileTools {
		armDrag(handle: HTMLElement): void;
		visibleBox(): HTMLElement;
		dropDrag(drag: ToolbarDragState): void;
		flyInto(box: HTMLElement, before: { left: number; top: number }): void;
		endAnchorFlight(): void;
		cancelDrag(liftFollows: boolean): void;
		consumeDragClick(): boolean;
	}
}


	/**
	 * DRAG TO ANCHOR (1.4.12). Pick the toolbar up by its handle, put it
	 * anywhere, and on release it flies to the nearest of the nine placements
	 * and writes that placement to settings.
	 *
	 * ONLY THE HANDLES ARE DRAGGABLE, and that is the whole design. Alan's
	 * convention here is Apple's pencil palette, where the palette itself is
	 * draggable because it has no buttons to confuse a drag with; this strip
	 * is thirteen buttons, and a drag that could start on one of them would
	 * mean every mis-swiped tool press moved the toolbar instead. So the
	 * expanded strip grows a grip at its leading end and the collapsed pill -
	 * which is one button and IS the whole control - is its own handle.
	 *
	 * Pointer capture, so the gesture keeps arriving here once the finger has
	 * left the 24px of grip it started on, which it does immediately. Pen,
	 * finger and mouse alike: only the second-finger test below reads
	 * `pointerType`, because a drag is a drag whatever is doing it and the
	 * three differ only in how much they jitter - which is what the
	 * threshold is for.
	 */
	function armDrag(this: MobileTools, handle: HTMLElement): void {
		handle.addEventListener("pointerdown", (ev: PointerEvent) => {
			// One at a time. A second finger landing on the grip mid-drag is
			// not a second drag, and taking it would leave the first one's
			// pointer captured with nothing left to end it.
			if (this.drag !== null) return;
			// LEFT BUTTON, AND NOT A SECOND FINGER. A right- or middle-button
			// press on the grip is a menu gesture, not a drag, and a secondary
			// contact of a multi-touch is not one either; either would otherwise
			// travel six px and commit a placement the hand never asked for.
			// Touch only: Windows reports a pen as not primary whenever a second
			// mouse is live beside it, and that pen is still the only hand on it.
			if ((ev.button ?? 0) !== 0 || (ev.isPrimary === false && ev.pointerType === "touch")) return;
			// A tap that is about to be a tap: nothing is painted, no pop is
			// closed, and the pill's click still fires, until the pointer has
			// travelled far enough to say otherwise.
			this.dragClickArmed = false;
			// A contact during the last few px of a flight takes the strip
			// back off the transition, so the new drag tracks the pointer
			// instead of chasing it 160ms behind.
			this.endAnchorFlight();
			ev.preventDefault();
			this.drag = {
				pointerId: ev.pointerId,
				handle,
				startX: ev.clientX,
				startY: ev.clientY,
				moved: false,
				box: { left: 0, top: 0, right: 0, bottom: 0 },
				dodge: { x: 0, y: 0 },
			};
			// Wrapped for the reason the resize observer is: a real engine
			// refuses capture for a pointer it no longer believes is down,
			// and a tree that has no such method at all throws the same way.
			// Losing capture costs the drag its moves once the finger leaves
			// the handle, which the document-level end below cleans up after;
			// throwing here would cost the press entirely.
			try {
				handle.setPointerCapture(ev.pointerId);
			} catch {
				/* no capture: the drag still works while the pointer stays on the handle */
			}
		});
		handle.addEventListener("pointermove", (ev: PointerEvent) => {
			const drag = this.drag;
			if (!drag || ev.pointerId !== drag.pointerId) return;
			const dx = ev.clientX - drag.startX;
			const dy = ev.clientY - drag.startY;
			if (!drag.moved) {
				if (!dragPassedThreshold(dx, dy)) return;
				drag.moved = true;
				// THE POPS AND THE FOLDED ROW GO FIRST, BEFORE THE MEASURE. They
				// hang off the strip's edges and would fly around with it, and a
				// menu the user is no longer looking at is not one they still want
				// open - but the ORDER is the load-bearing part. The folded row is
				// IN FLOW inside the strip (`.handwriting-mobile-tools-more`,
				// styles.css), so with the chevron open the strip stands roughly
				// twice as tall. Measured before this closes, the box below would
				// carry a height that is gone by the next frame, and the centre
				// every drop is judged by would sit half a second row too low -
				// biasing an open-chevron drag toward the bottom anchors, at the
				// phone widths that are the only place that row exists at all.
				this.closeInkSliders();
				this.setMoreOpen(false);
				// MEASURED HERE, once, and before the lift goes on: this is
				// the strip's resting box with whatever dodge it carries, and
				// every later question - its size, its centre - is this box
				// plus the offset, which is arithmetic rather than a second
				// forced layout on a pointermove.
				const box = this.visibleBox().getBoundingClientRect();
				drag.box = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
				// The dodge that box carries, kept with it: the drop compares
				// this box against anchor centres that have no dodge in them,
				// so it has to be able to take this one back out again.
				drag.dodge = { x: this.dodge.x, y: this.dodge.y };
				for (const el of [this.el, this.pill]) el.addClass("is-dragging");
			}
			this.dragOffset = { x: dx, y: dy };
			this.paintTransform();
		});
	}

	/** Whichever of the two is on screen - the pill, when the strip is folded
	 * away and `display: none` with a zero box. The same choice
	 * `applyHeaderClearance` makes, and for the same reason. */
	function visibleBox(this: MobileTools): HTMLElement {
		return this.el.classList.contains("is-collapsed") ? this.pill : this.el;
	}

	/**
	 * Put the strip down: choose the anchor, tell the plugin, and fly the
	 * last few px.
	 */
	function dropDrag(this: MobileTools, drag: ToolbarDragState): void {
		const pane = this.pane.getBoundingClientRect();
		const size = {
			width: drag.box.right - drag.box.left,
			height: drag.box.bottom - drag.box.top,
		};
		// IN THE ANCHORS' OWN FRAME, which is the un-dodged one. `drag.box` was
		// read off the live element and carries the actions-row dodge; the nine
		// resting centres this is about to be compared against are where the
		// stylesheet would put the strip, dodge or no dodge. Taking the dodge
		// back out here is what makes the two comparable - and it is taken out
		// HERE rather than added to all nine, because the strip is one box and
		// the anchors are nine predictions of it.
		const centre = {
			x: (drag.box.left + drag.box.right) / 2 + this.dragOffset.x - drag.dodge.x,
			y: (drag.box.top + drag.box.bottom) / 2 + this.dragOffset.y - drag.dodge.y,
		};
		const corner = nearestAnchor({
			centre,
			pane,
			size,
			inset: TOOLBAR_ANCHOR_INSET_PX,
			current: this.corner,
		});
		// The lift comes off BEFORE the measurement, so `before` is the box
		// and not the box plus 4%. `this.drag` is cleared in the same breath:
		// `paintTransform` reads it for the lift, and everything from here on
		// is a landing rather than a drag.
		const box = this.visibleBox();
		this.drag = null;
		for (const el of [this.el, this.pill]) el.removeClass("is-dragging");
		this.paintTransform();
		const before = box.getBoundingClientRect();
		// A DRAG IS NOT A TAP: the release that ends a drag on the pill also
		// synthesizes a click on it, and the pill's click expands the strip.
		// ONLY for a drag that ended on the pill, because the pill is a real
		// <button> and a keyboard Enter reaches its click with no pointerdown
		// to clear the flag first - a grip drag arming this would swallow
		// that later keypress.
		this.dragClickArmed = drag.handle === this.pill;
		// THE DRAG'S OWN OFFSET GOES HERE, not on the rebound from
		// `setPlacement`. That call does reach this strip's `setCorner` on
		// both real surfaces, and the `applyHeaderClearance` inside it would
		// repaint - but a strip whose translate is only ever cleared by
		// something else calling back into it is a strip stuck at the far end
		// of a gesture the moment a fan-out changes shape. It clears its own.
		this.dragOffset = { x: 0, y: 0 };
		this.paintTransform();
		// THE SAME ROAD THE DROPDOWN TAKES. `setPlacement` persists the
		// placement and moves every open strip on both surfaces, which is
		// what brings this one to its new anchor - including this call's own
		// `setCorner`, and the `applyHeaderClearance` inside it.
		this.host.setPlacement(corner);
		this.flyInto(box, before);
	}

	/**
	 * Animate the last few px, from where the strip was let go to where the
	 * anchor put it.
	 *
	 * MEASURED, NOT COMPUTED. The distance is `before` minus `after`, both
	 * read off the real element, so safe-area insets, android's shade
	 * constant, the pill's concentric offsets and a dodge that changed with
	 * the corner are all in the answer without this function knowing any of
	 * them exist. The alternative - animating towards the resting centre the
	 * anchor rule predicted - would trust a prediction that the stylesheet is
	 * free to disagree with, and would land the strip in the wrong place on
	 * exactly the phones the insets are for.
	 *
	 * `prefers-reduced-motion` is answered in the stylesheet rather than
	 * here: `.is-anchoring` carries the transition and the media query turns
	 * it off, so the class goes on and off the same way either way and the
	 * strip simply arrives.
	 */
	function flyInto(this: MobileTools, box: HTMLElement, before: { left: number; top: number }): void {
		const after = box.getBoundingClientRect();
		const dx = before.left - after.left;
		const dy = before.top - after.top;
		// Nothing to fly - the drop landed where it already was, or the
		// element cannot be measured (the suite, a detached pane). Half a
		// pixel because a sub-pixel flight is a repaint that shows nothing.
		if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
		// A flight already in the air is over: its class comes off before the
		// start value below is written, so this one really does start where
		// it says it does.
		this.endAnchorFlight();
		// Back to where it was let go, with NO transition on yet...
		this.dragOffset = { x: dx, y: dy };
		this.paintTransform();
		// ...a forced style read, so the browser has a start value to animate
		// FROM rather than coalescing both writes into one paint...
		void box.getBoundingClientRect();
		// ...and then the transition, and the trip home.
		for (const el of [this.el, this.pill]) el.addClass("is-anchoring");
		this.dragOffset = { x: 0, y: 0 };
		this.paintTransform();
		this.anchorTimer = window.setTimeout(() => {
			this.anchorTimer = null;
			for (const el of [this.el, this.pill]) el.removeClass("is-anchoring");
		}, ANCHOR_FLIGHT_MS + 40);
	}

	/**
	 * Take the transition back off, whether or not it has run its course.
	 *
	 * The class must not outlive the flight: `transform` is also what the
	 * actions-row dodge writes, and a strip left with `.is-anchoring` on
	 * would animate a resize's dodge over 160ms instead of applying it.
	 * `window` is only reached when a timer is actually armed, which is the
	 * same guard `cancelSliderClose` and the hold timers rely on to be safe
	 * in a suite that has no window at all.
	 */
	function endAnchorFlight(this: MobileTools): void {
		if (this.anchorTimer !== null) window.clearTimeout(this.anchorTimer);
		this.anchorTimer = null;
		for (const el of [this.el, this.pill]) el.removeClass("is-anchoring");
	}

	/**
	 * Abandon a live drag and leave the strip where it started.
	 *
	 * The previous anchor needs no restoring because it was never left: a
	 * drag paints a translate and nothing else, and the placement is written
	 * only on a drop. So cancelling is exactly "put the offset back to zero".
	 *
	 * `liftFollows` says whether a real pointer lift is still coming, and
	 * it is the whole reason this takes an argument. Escape cancels a drag
	 * whose finger is STILL DOWN: that finger lifts a moment later, and on
	 * the pill that lift synthesizes a click which must not expand the
	 * strip - so the swallow is armed. A `pointercancel` IS the lift going
	 * away (the system took the pointer), and no click follows it; arming
	 * there leaves the flag standing with nothing to eat, and the pill is a
	 * real button, so the next Enter or Space on it - a keyboard press,
	 * which reaches `click` with no pointerdown to clear the flag first -
	 * would be swallowed instead, and the strip would silently fail to open
	 * once. Teardown passes false for the same reason: nothing follows it.
	 */
	function cancelDrag(this: MobileTools, liftFollows: boolean): void {
		if (!this.drag) return;
		const drag = this.drag;
		this.drag = null;
		try {
			drag.handle.releasePointerCapture(drag.pointerId);
		} catch {
			/* already released, or never taken */
		}
		this.dragOffset = { x: 0, y: 0 };
		for (const el of [this.el, this.pill]) el.removeClass("is-dragging");
		this.paintTransform();
		// Only when a lift is still coming, and only on the pill: that is
		// the one handle whose lift synthesizes a click, and Escape is the
		// one cancel a lift still follows. See the header.
		this.dragClickArmed = liftFollows && drag.moved && drag.handle === this.pill;
	}

	/** Did a drag just end on this element? Consumes the answer. */
	function consumeDragClick(this: MobileTools): boolean {
		const was = this.dragClickArmed;
		this.dragClickArmed = false;
		return was;
	}

export function installMobileToolsDrag(proto: MobileTools): void {
	installMethods(proto, {
		armDrag,
		visibleBox,
		dropDrag,
		flyInto,
		endAnchorFlight,
		cancelDrag,
		consumeDragClick,
	});
}
