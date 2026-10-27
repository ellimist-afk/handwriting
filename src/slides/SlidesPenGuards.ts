/**
 * The slides surface's pen and palm guards: which events belong to the deck's own controls, which contacts the pen claims,
 * the listener that swallows Reveal's navigation events while a pen or a palm owns the glass, the context menu refusal, the
 * guard's arm, hold and release timers, and the focus the deck takes before a stroke. They are methods of SlidesDeck,
 * installed on its prototype when SlidesInkSurface.ts loads.
 */
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { mouseInkEnabled } from "../inline/MouseInk";
import { isSlidesControl } from "./SlidesActions";
import { installMethods } from "../inline/InstallMethods";
import {
	PEN_CONTACT_GUARDED_EVENTS,
	PEN_GUARD_TAIL_MS,
	claimsContact,
	describe,
	isPenHoverEvent,
	isTextEntryElement,
	log,
	now,
	palmShapedContact,
	penIsNear,
	suppressDeckContextMenu,
	swallowDuringPenContact,
	withinPalmReleaseTail,
	type SlidesDeck,
} from "./SlidesInkSurface";

declare module "./SlidesInkSurface" {
	interface SlidesDeck {
		controlEvent(ev: Event): boolean;
		claims(ev: PointerEvent): boolean;
		onGuardedEvent(ev: Event): void;
		penOwnsGlass(at: number): boolean;
		onDeckContextMenu(ev: Event): void;
		armPenGuard(pointerId: number): void;
		clearGuardTimers(): void;
		releasePenGuard(): void;
		holdPenGuard(): void;
		dropPenGuard(): void;
		ensureDeckFocused(): void;
		logDeckTookFocus(from: Element | null): void;
	}
}

	function controlEvent(this: SlidesDeck, ev: Event): boolean {
		return isSlidesControl(ev.target, this.revealEl) ||
			(ev.composedPath?.().some(node => isSlidesControl(node, this.revealEl)) ?? false);
	}

	function claims(this: SlidesDeck, ev: PointerEvent): boolean {
		return claimsContact(ev.pointerType, ev.isPrimary, ev.buttons, mouseInkEnabled());
	}

	/**
	 * A1 + the palm guard: swallow Reveal's navigation events - the ones a live
	 * pen STROKE produces, and every touch-shaped one for as long as a pen owns
	 * the contact at all.
	 */
	function onGuardedEvent(this: SlidesDeck, ev: Event): void {
		const touchEvent = (ev as PointerEvent).pointerType === "touch" || ev.type.startsWith("touch");
		if (this.controlEvent(ev) && (!touchEvent || !this.penOwnsGlass(now()))) return;
		// `pointerType` is a PointerEvent member and this handler takes plain
		// Events: `click` and the `touch*` three simply do not have one, and
		// `undefined` is what the predicate's touch rows are written to expect.
		const pe = ev as PointerEvent;
		const pointerType = pe.pointerType;
		// The hover key, fed here rather than from `onPointerMove`: that one
		// returns early for every pointer that is not the active contact, and
		// a hovering nib is never the active contact. This listener sees the
		// raw stream because `pointermove` is in PEN_CONTACT_GUARDED_EVENTS.
		if (isPenHoverEvent(ev.type, pointerType, pe.buttons)) this.lastPenHoverAt = now();
		const at = now();
		// Shape first, and independent of the pen: this is the arm that works
		// with no pen in the room at all. Touch only, so S4's pen/mouse
		// pointerdown promise is untouched.
		if (
			this.palmShieldLive &&
			pointerType === "touch" &&
			PEN_CONTACT_GUARDED_EVENTS.includes(ev.type) &&
			palmShapedContact(pe.width, pe.height)
		) {
			ev.stopPropagation();
			return;
		}
		const swallow = swallowDuringPenContact(
			this.penOwnsGlass(at),
			this.penContact && this.penStroke,
			ev.type,
			pointerType
		);
		if (!swallow) return;
		ev.stopPropagation();
	}

	/**
	 * Is the glass the pen's right now - down, near, or just lifted?
	 *
	 * The three windows S4 names, in one place so the guard listener and the
	 * contextmenu listener cannot disagree about them. Only `penContact` is
	 * state the surface sets; the other two are subtractions.
	 */
	function penOwnsGlass(this: SlidesDeck, at: number): boolean {
		if (this.penContact) return true;
		if (penIsNear(this.lastPenHoverAt, at)) return true;
		return withinPalmReleaseTail(this.lastPenLiftAt, at);
	}

	/**
	 * The native menu over a live deck (`suppressDeckContextMenu`).
	 *
	 * Its own listener, not a row in `PEN_GUARDED_EVENTS`: `onGuardedEvent`
	 * ends in `stopPropagation` alone, and a context menu is a DEFAULT ACTION -
	 * only `preventDefault` can refuse it. Cancelling the pointerdown does not
	 * reach it either, per InlinePenRouter's hardware finding: Windows
	 * synthesises `contextmenu` AFTER pointerup, so it is not that
	 * pointerdown's default action to cancel.
	 *
	 * `stopPropagation` as well as `preventDefault`, matching the note
	 * surface: Obsidian's own menu is raised by a listener, not by the browser,
	 * and only the first of the two can refuse that. Capture on `.reveal`
	 * reaches every listener below it; a document-level handler above `.reveal`
	 * is out of this listener's range, which is a known and deliberate limit of
	 * binding here rather than on the window (the wiring comment above says why
	 * `.reveal` is the element this surface uses).
	 */
	function onDeckContextMenu(this: SlidesDeck, ev: Event): void {
		const at = now();
		if (
			!suppressDeckContextMenu({
				penDown: this.penContact,
				strokeLive: this.penContact && this.penStroke,
				penNear: penIsNear(this.lastPenHoverAt, at),
				pointerType: (ev as PointerEvent).pointerType,
			})
		) {
			return;
		}
		ev.preventDefault();
		ev.stopPropagation();
	}

	function armPenGuard(this: SlidesDeck, pointerId: number): void {
		this.clearGuardTimers();
		this.penContact = true;
		this.guardPointerId = pointerId;
		this.lastPointerAt = now();
	}

	function clearGuardTimers(this: SlidesDeck): void {
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		if (this.penGuardRelease !== null) {
			win.clearTimeout(this.penGuardRelease);
			this.penGuardRelease = null;
		}
		if (this.penGuardTail !== null) {
			win.clearTimeout(this.penGuardTail);
			this.penGuardTail = null;
		}
	}

	/**
	 * Let go of the guard one tick after the contact ended.
	 *
	 * Not synchronously: the `click` that navigates is dispatched AFTER the
	 * pointerup, so a guard released in the pointerup handler would let through
	 * the one event it exists to stop - and a guard released a tick late is
	 * what lets a TAP's click reach the arrow, because a tap never set
	 * `penStroke` in the first place.
	 */
	function releasePenGuard(this: SlidesDeck): void {
		if (!this.penContact || this.penGuardRelease !== null) return;
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		if (this.penGuardTail !== null) {
			win.clearTimeout(this.penGuardTail);
			this.penGuardTail = null;
		}
		this.penGuardRelease = win.setTimeout(() => {
			this.penGuardRelease = null;
			this.dropPenGuard();
		}, 0);
	}

	/**
	 * Keep the guard up after a stroke that ended WITHOUT a lift.
	 *
	 * A commit is not a lift: a cancel that outlived its hold window, or a
	 * `leave`, ends the stroke while the pen may still be on the glass, and the
	 * `pointerup` that eventually comes brings the `click` that turns the page.
	 * So the guard stands until that lift, or until the pointer has said
	 * nothing for PEN_GUARD_TAIL_MS - measured from the LAST event for it, not
	 * from here, because a hold expiry already spent its own 300 ms waiting.
	 */
	function holdPenGuard(this: SlidesDeck): void {
		if (!this.penContact || this.penGuardRelease !== null) return;
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		if (this.penGuardTail !== null) win.clearTimeout(this.penGuardTail);
		const waited = now() - this.lastPointerAt;
		const wait = Math.max(0, PEN_GUARD_TAIL_MS - (Number.isFinite(waited) ? waited : 0));
		this.penGuardTail = win.setTimeout(() => {
			this.penGuardTail = null;
			this.dropPenGuard();
		}, wait);
	}

	function dropPenGuard(this: SlidesDeck): void {
		this.penContact = false;
		this.penStroke = false;
		this.guardPointerId = null;
	}

	/**
	 * Make sure Reveal's deck already holds focus before we claim.
	 *
	 * Reveal's focus plugin focuses the deck FROM the pointerdown, and a
	 * document-level pointerdown outside `.reveal` blurs it. Doing it ourselves
	 * first, in the capture phase, means Reveal's own bubble-phase handler
	 * finds the deck already focused and the focus/blur cycle does not straddle
	 * the start of the stroke.
	 *
	 * Belt and braces: taking focus can still be a no-op - some snippet's CSS, a
	 * detached element, a browser quirk - and Reveal's own keydown handler
	 * returns early for `document.activeElement.isContentEditable` (or an
	 * input/textarea/select) regardless of whether `.reveal` itself ever took
	 * DOM focus. So when the active element is STILL outside `.reveal` after
	 * the attempt, and it is one of those, it is blurred: a deck that cannot
	 * take focus must at least free the keyboard.
	 */
	function ensureDeckFocused(this: SlidesDeck): void {
		const doc = this.revealEl.ownerDocument;
		const before = doc.activeElement;
		if (before && this.revealEl.contains(before)) return;
		try {
			this.revealEl.focus({ preventScroll: true });
		} catch {
			/* not focusable; nothing to recover */
		}
		const after = doc.activeElement;
		if (after && this.revealEl.contains(after)) {
			this.logDeckTookFocus(before);
			return;
		}
		if (after && isTextEntryElement(after)) {
			after.blur();
			this.logDeckTookFocus(before);
		}
	}

	/** Once per deck, not once per pointerdown - `ensureDeckFocused` runs on every contact. */
	function logDeckTookFocus(this: SlidesDeck, from: Element | null): void {
		if (this.deckFocusLogged) return;
		this.deckFocusLogged = true;
		if (diagnosticsEnabled()) log(`deck took focus from ${from ? describe(from) : "none"}`);
	}

export function installSlidesPenGuards(proto: SlidesDeck): void {
	installMethods(proto, {
		controlEvent,
		claims,
		onGuardedEvent,
		penOwnsGlass,
		onDeckContextMenu,
		armPenGuard,
		clearGuardTimers,
		releasePenGuard,
		holdPenGuard,
		dropPenGuard,
		ensureDeckFocused,
		logDeckTookFocus,
	});
}
