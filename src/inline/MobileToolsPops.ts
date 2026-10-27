/**
 * The strip's pops: the more row, the slider pops and their timers, the hover tips, the collapse, the fold order and the stale check.
 * They are methods of MobileTools, installed on its prototype when MobileTools.ts loads.
 */
import { setIcon } from "obsidian";
import { installMethods } from "./InstallMethods";
import { BUTTONS, type ButtonSpec } from "./MobileToolsButtons";
import type { MobileTools } from "./MobileTools";

/**
 * Collapsed is a SESSION preference, not a per-note one: collapsing the
 * strip in one note means "get out of my way", and it would be rude to
 * reappear full-size on the next note. New strips are born matching it.
 */
export let collapsedSession = false;

/**
 * The specs whose presence is a QUESTION, precomputed.
 *
 * `stale()` runs on paths a pointer can drive - the pdf surface calls
 * `ensureTools` from its cursor path - so it walks these two rather than all
 * thirteen buttons, and allocates nothing while doing it. Derived from
 * `BUTTONS` rather than listed by hand, so a third `shownOn` is covered by
 * adding the field and nothing else.
 */
export const CONDITIONAL_BUTTONS: readonly ButtonSpec[] = BUTTONS.filter(
	(spec) => spec.shownOn !== undefined
);

declare module "./MobileTools" {
	interface MobileTools {
		setMoreOpen(on: boolean): void;
		closeInkSliders(): boolean;
		setCollapsed(on: boolean): void;
		scheduleSliderClose(): void;
		ownName(el: HTMLElement): void;
		attachTip(el: HTMLElement, tipOf?: () => HTMLElement): void;
		placePillTip(pill: HTMLElement, tip: HTMLElement): void;
		cancelSliderClose(): void;
		cancelRecordingHold(): void;
		cancelPresetHold(): void;
		cancelTipTimer(): void;
		applyFoldOrder(): void;
		stale(): boolean;
	}
}


	/**
	 * Show or hide the folded row. The chevron flips with it - down means
	 * "there is more below", up means "put it away" - which is the only thing
	 * on the strip that tells a user the row is openable at all.
	 */
	function setMoreOpen(this: MobileTools, on: boolean): void {
		if (this.moreOpen === on) return;
		this.moreOpen = on;
		this.el.toggleClass("is-more-open", on);
		// Emptied FIRST: setIcon APPENDS, it does not replace - the same trap
		// the pill and the collapse chevron are both written around, and the
		// same fix. The tooltip's sr-only name goes back in after the sweep.
		this.moreBtn.empty();
		setIcon(this.moreBtn, on ? "chevron-up" : "chevron-down");
		if (!this.moreBtn.querySelector("svg")) this.moreBtn.setText(on ? "^" : "v");
		const label = this.moreBtn.dataset.tipLabel;
		if (label) this.moreBtn.createSpan({ cls: "handwriting-sr-only", text: label });
	}

	/** Writing started: nib-size drop-downs get out of the way.
	 *
	 * Returns whether anything was actually open; Escape needs to know.
	 * Closes every pop the strip can show, the eraser's included - pen-down,
	 * outsideTap and Escape all route through here now (alan, 2026-09-02:
	 * "you eraser pop should close when pen touches down... we did it for
	 * other tools but never did it for eraser"). There used to be a second
	 * method, `closePops`, that Escape alone called to also take the eraser
	 * pop; once this closed it too, `closePops` had nothing left to add over
	 * this and was removed. */
	function closeInkSliders(this: MobileTools): boolean {
		if (!this.hasOpenPop()) return false;
		// The nib pops carry the swatches now, so closing a nib's slider
		// closes its colours with it - the `colorsOpen = false` that used to
		// stand beside this line had a second pop to put away and there is no
		// second pop.
		this.openInkSlider = null;
		// The one bit `eraserPopOpen` checks (below) - set unconditionally,
		// same as the line above, rather than gated on `eraserPopOpen()`
		// first: harmless when the eraser pop was not showing, and it saves
		// a second read of `eraserOn()` here for the common case where it
		// was not the eraser that had anything open.
		this.eraserPopClosed = true;
		// The eraser pop has no timer of its own (see eraserPopOpen), but
		// `sliderHoverTimer` is shared with the pen/highlighter pops this
		// same call just closed; cancel it here too so a hover-away already
		// in flight for one of them cannot reopen a pop this call just put
		// away.
		this.cancelSliderClose();
		this.refresh();
		return true;
	}

	function setCollapsed(this: MobileTools, on: boolean): void {
		collapsedSession = on;
		// A collapsing strip takes its folded row with it. The row is a child
		// of the strip and would go with it anyway; closing it means the strip
		// comes BACK the way it was last chosen to be seen, rather than
		// re-opening a menu somebody dismissed by collapsing the whole thing.
		if (on) this.setMoreOpen(false);
		// Folding hides any open ink pop along with the rest of the strip
		// (display:none), but leaves `hasOpenPop()` true - so the first Escape
		// pressed after folding is swallowed with nothing visible to show for
		// it (item 101). Close pops here so folding and closing them happen
		// together.
		if (on) this.closeInkSliders();
		this.el.toggleClass("is-collapsed", on);
		this.pill.toggleClass("is-showing", on);
		// Expanding is the moment the strip has widths again - it was
		// `display: none` until this line - so the fold is recomputed here
		// rather than waiting for a resize that may never come. Collapsing
		// skips it, by the guard at the top of `layoutOverflow`.
		this.layoutOverflow();
		// The corner's occupant just changed size - a 34px pill where a full
		// strip was, or the other way - so whether it clears the pane's
		// three-dots changed with it (item 5).
		this.applyHeaderClearance();
	}

	/** Leaving the button or its pop closes the slider, after a beat so
	 * the pointer can travel the gap between them. */
	function scheduleSliderClose(this: MobileTools): void {
		this.cancelSliderClose();
		this.sliderHoverTimer = window.setTimeout(() => {
			this.sliderHoverTimer = null;
			let changed = false;
			if (this.openInkSlider !== null && this.sliderFromHover) {
				this.openInkSlider = null;
				changed = true;
			}
			// Same protection, aimed at the eraser's own bit: only close it
			// if it is still open AND hover is what opened it - a tap-opened
			// pop (`eraserPopFromHover` false) is a decision, not a preview,
			// and this timer leaves it alone exactly like it leaves a
			// tap-opened nib slider alone above.
			if (!this.eraserPopClosed && this.eraserPopFromHover) {
				this.eraserPopFromHover = false;
				this.eraserPopClosed = true;
				changed = true;
			}
			if (changed) this.refresh();
		}, 300);
	}

	/**
	 * Obsidian renders its own tooltip from aria-label on MOUSE hover, so
	 * every control showed two bubbles - Obsidian's and ours. The name
	 * moves into a visually-hidden span (screen readers read content), the
	 * attribute goes, and our tip - which also answers PEN hover - is the
	 * only one left.
	 */
	function ownName(this: MobileTools, el: HTMLElement): void {
		const label = el.getAttribute("aria-label");
		if (!label) return;
		el.removeAttribute("aria-label");
		el.dataset.tipLabel = label;
		el.createSpan({ cls: "handwriting-sr-only", text: label });
	}

	/** OS-style tooltip: a beat of hover shows it, anything else hides it.
	 * Touch is skipped - a tap would flash the tip under the finger while
	 * the button acts, explaining nothing and covering the pops. */
	function attachTip(this: MobileTools, el: HTMLElement, tipOf: () => HTMLElement = () => this.tip): void {
		this.ownName(el);
		const hide = () => {
			if (this.tipTimer !== null) window.clearTimeout(this.tipTimer);
			this.tipTimer = null;
			this.tip?.removeClass("is-showing");
			this.pillTip?.removeClass("is-showing");
		};
		el.addEventListener("pointerenter", (ev: PointerEvent) => {
			if (ev.pointerType === "touch") return;
			hide();
			this.tipTimer = window.setTimeout(() => {
				this.tipTimer = null;
				const text = el.dataset.tipLabel ?? el.getAttribute("aria-label");
				if (!text) return;
				const tip = tipOf();
				tip.setText(text);
				// Aligned to the hovered control and clamped by the tip's
				// MEASURED width - the old guess of 180px let a long label
				// (the recording dot's) run 80px past the strip's edge.
				// Shown first, so the width is real when read.
				tip.addClass("is-showing");
				if (tip === this.pillTip) {
					this.placePillTip(el, tip);
					return;
				}
				const left = Math.max(
					0,
					Math.min(el.offsetLeft, this.el.offsetWidth - tip.offsetWidth)
				);
				tip.setCssStyles({ left: `${left}px`, right: "auto" });
			}, 350);
		});
		el.addEventListener("pointerleave", hide);
		el.addEventListener("pointercancel", hide);
		el.addEventListener("pointerdown", hide);
	}

	/**
	 * Put the pill's tip beside the pill, in the parent's coordinates: below it, or above it when the pill hangs
	 * at a bottom corner (the strip's own tip flips the same way), clamped inside the parent by its measured width.
	 */
	function placePillTip(this: MobileTools, pill: HTMLElement, tip: HTMLElement): void {
		const parent = pill.parentElement;
		const room = parent ? parent.clientWidth - tip.offsetWidth : 0;
		const left = Math.max(0, Math.min(pill.offsetLeft, room));
		const above = ["left", "center", "right"].some((x) => pill.classList.contains(`handwriting-corner-bottom-${x}`));
		const top = above ? pill.offsetTop - tip.offsetHeight - 6 : pill.offsetTop + pill.offsetHeight + 6;
		tip.setCssStyles({ left: `${left}px`, top: `${top}px`, right: "auto", bottom: "auto" });
	}

	function cancelSliderClose(this: MobileTools): void {
		if (this.sliderHoverTimer !== null) {
			window.clearTimeout(this.sliderHoverTimer);
			this.sliderHoverTimer = null;
		}
	}

	/** The recording dot's press-and-hold, cancelled from anywhere. */
	function cancelRecordingHold(this: MobileTools): void {
		if (this.recordingHoldTimer !== null) window.clearTimeout(this.recordingHoldTimer);
		this.recordingHoldTimer = null;
	}

	/**
	 * The quick-pen chip's press-and-hold. Called by the chip's own
	 * pointerup/leave/cancel, by `paintPresets` before it rebuilds the row,
	 * and by `destroy`.
	 */
	function cancelPresetHold(this: MobileTools): void {
		if (this.presetHoldTimer !== null) window.clearTimeout(this.presetHoldTimer);
		this.presetHoldTimer = null;
	}

	/** The hover tooltip's beat. */
	function cancelTipTimer(this: MobileTools): void {
		if (this.tipTimer !== null) window.clearTimeout(this.tipTimer);
		this.tipTimer = null;
	}

	/**
	 * The fold order changed under a strip that is already on screen.
	 *
	 * The chevron closes first, and that is the whole reason this is a method
	 * rather than a bare `layoutOverflow()` from the setter: the second row's
	 * contents are about to change, and a row left open would silently redraw
	 * under the user's hand holding different buttons than the tap that opened
	 * it asked for.
	 */
	function applyFoldOrder(this: MobileTools): void {
		this.setMoreOpen(false);
		this.layoutOverflow();
	}

	/**
	 * Would a strip built RIGHT NOW carry a different set of buttons than
	 * this one does?
	 *
	 * `shownOn` is read once, at build (see `ButtonSpec.shownOn`), and one of
	 * the two facts it reads has an edge: the pen latch goes false-to-true
	 * the first time real pen hardware touches this device. Nothing else in
	 * this class would notice. `refreshNow` repaints the buttons that exist
	 * and cannot conjure one that does not, and both surfaces' ensure-calls
	 * return early unless the strip is being created or destroyed - so
	 * without this, a phone (where the strip exists from mount, `penToolsVisible`
	 * being unconditionally true on mobile) would get no Keyboard button on
	 * its first pen contact, and none until something else happened to
	 * recreate the strip. That is the bug this method exists to make
	 * impossible, not a theoretical one: it is the exact shape of the phone
	 * case the ruling was made for.
	 *
	 * The surfaces destroy and rebuild on a true answer. A rebuild is cheap
	 * and rare - at most once per session per strip, since the latch cannot
	 * go back down and the device's digitizer cannot change - and it costs
	 * only open pops, which a pen contact was closing anyway.
	 *
	 * Allocation-free, and walking `CONDITIONAL_BUTTONS` rather than all of
	 * them: the pdf surface reaches its `ensureTools` from a cursor path.
	 */
	function stale(this: MobileTools): boolean {
		for (const spec of CONDITIONAL_BUTTONS) {
			const want = spec.shownOn?.(this.host) ?? true;
			if (want !== this.built.has(spec.commandId)) return true;
		}
		return false;
	}

export function installMobileToolsPops(proto: MobileTools): void {
	installMethods(proto, {
		setMoreOpen,
		closeInkSliders,
		setCollapsed,
		scheduleSliderClose,
		ownName,
		attachTip,
		placePillTip,
		cancelSliderClose,
		cancelRecordingHold,
		cancelPresetHold,
		cancelTipTimer,
		applyFoldOrder,
		stale,
	});
}
