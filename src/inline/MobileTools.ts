/**
 * The floating pen-tools strip for inline notes.
 *
 * Every Handwriting control lives in the command palette, and on an iPad the
 * palette lives in the toolbar above the keyboard - and the stylus fix keeps
 * the keyboard DOWN, which is correct for writing and fatal for discovery: a
 * pencil-only user has no path to the eraser, the highlighter, or anything
 * else. This strip is that path. It invents nothing: every button executes
 * the same command id the palette would, so persistence, notices and behavior
 * stay in one place.
 *
 * Where it mounts matters. It sits on the EDITOR element (`view.dom`), a
 * sibling of the scroller, not inside it - the router's capture listeners
 * live on the scroller, so a pencil tap on a button never enters the pen
 * pipeline and lands as an ordinary click. Top-right, because the writing
 * palm owns the bottom of the glass and a palm-planted strip would switch
 * tools mid-word.
 *
 * The host hands in command execution and current-state reads so this file
 * imports nothing from InkOverlay (no import cycle).
 *
 * Collapse: the strip minimizes to a single pen pill (the PencilKit move -
 * every serious note app keeps tools permanently reachable but shrinkable).
 * The collapsed state is per-strip and per-session: chrome preference, not
 * document state, and not worth a setting.
 */

import {
	ToolbarCorner,
} from "./ToolbarCorner";
import { stripEscapeVerdict } from "./StripEscape";
import { getPenToolsMode } from "./PenToolsMode";
import { describeEl } from "./PenHitProbe";
import { traceStripClick } from "./InlinePenRouter";
import { DEFAULT_FOLD_ORDER, normalizeFoldOrder, type ButtonSpec } from "./MobileToolsButtons";
import { installMobileToolsBuild } from "./MobileToolsBuild";
import { installMobileToolsDrag } from "./MobileToolsDrag";
import { installMobileToolsPaint } from "./MobileToolsPaint";
import { installMobileToolsLayout } from "./MobileToolsLayout";
import { installMobileToolsBuildRest } from "./MobileToolsBuildRest";
import type { MobileToolsHost } from "./MobileToolsHost";
import { NoteZoomControls, StepAside } from "./NoteZoomControls";
import { installMobileToolsPops } from "./MobileToolsPops";
export { collapsedSession } from "./MobileToolsPops";
export { refreshNoteZoomControlsAll, NoteZoomControls, ensureNoteZoomControls, destroyNoteZoomControls } from "./NoteZoomControls";
export type { MobileToolsHost } from "./MobileToolsHost";
export { PEN_INK_TOGGLE, DEFAULT_FOLD_ORDER, normalizeFoldOrder, stripButtonFace, stripBuildsButton, NEVER_FOLDING_FACES, nibIsLit, nibInkColor } from "./MobileToolsButtons";
export type { StripButtonFace } from "./MobileToolsButtons";


/**
 * Pixel<->multiplier conversion for the nib sliders (Alan, 2026-09: "aligning
 * the stroke width and eraser slider to either both be pixel or both be
 * multiplier" - PIXELS, matching "Eraser size"). The STORED setting is
 * unchanged: setInkSizeMult/getInkSizeMult (InkOverlay.ts) and
 * this.settings.inkSizes (main.ts) still hold a multiplier, clamped there
 * exactly as before by clampInkSize (InkSize.ts) - only what this control
 * shows and drags in changes, converting at the edges. Rounded to 3dp:
 * DEFAULT_PEN.baseWidth (2.2) is not an integer, so raw px/base division
 * carries float noise (2.2 * 3 === 6.6000000000000005 in JS) that would
 * otherwise leak into the stored multiplier and the slider's own bounds.
 */
export const pxToMult = (px: number, base: number): number => Math.round((px / base) * 1000) / 1000;
export const multToPx = (mult: number, base: number): number => Math.round(mult * base * 1000) / 1000;
/**
 * What a built slider hands back: its parts.
 *
 * THE VALUE READOUT, AND WHY IT CAN EXIST AGAIN. One went with the rotated
 * slider in 1.4.12 because it was what made the pop judder:
 *
 * "Weird distortion on the pen slider as i slide it up and down, like the
 * slider is just vibrating" (alan, on hardware, 2026-09-02) - and it was the
 * POP that moved, not the thumb. The pop was a centred column with no width
 * of its own, so its width was its widest child, which was the readout; and
 * `hangUnder` re-centres the pop from its own measured `offsetWidth` on every
 * refresh. So any change in the readout's text width slid the whole pop, and
 * the slider inside it, sideways under the finger. `constantWidthLabel` -
 * fixed decimals plus U+2007 FIGURE SPACE padding - made every label the same
 * run of digit-width glyphs so that could not happen, and `.handwriting-
 * slider-val` pinned a monospace family so a serif theme could not undo it.
 *
 * The number is BACK on the owner's ruling (2026-09-06, asked whether the
 * value should return: "as well"), because a slider with no readout leaves a
 * user on glass with only the thumb's position to go on - "if the number is
 * there then it is easier to set on ones liking", "it will be difficult to
 * remember one like" (a second user, the same day).
 *
 * It cannot judder now, for two independent reasons. The flat pop DECLARES
 * its own width (styles.css), so the pop's width no longer depends on
 * anything the pop CONTAINS - a stronger guarantee than a constant-width
 * string was, since it holds for the preset row, the swatch grid and the
 * eraser's mode chips too, none of which the label trick ever covered. And
 * the readout sits on its OWN ROW under the track, in a box of fixed width
 * (`.handwriting-slider-num`), so the track's width and left edge do not
 * depend on the digits either. Both are measured, separately, in
 * `test/render/PopGeometry.test.ts`.
 *
 * So `constantWidthLabel` is not needed and does not return: a padded string
 * was a way of holding a width still from the inside, and the width is held
 * still from the outside now. The readout says the input's value verbatim.
 */
export interface SliderParts {
	pop: HTMLElement;
	input: HTMLInputElement;
	/** Which nib's pop this is, or null for the eraser's. */
	tool: "pen" | "highlighter" | null;
	/** The swatch row inside a nib's pop; null where `tool` is. */
	colors: HTMLElement | null;
	/** The quick-pen chips, ABOVE the swatches; null where `tool` is. */
	presets: HTMLElement | null;
	/** The live value under the track; painted by `paintValue`. */
	num: HTMLElement;
	/**
	 * How many decimals this slider's readout shows, taken from THIS
	 * slider's own step - see `paintValue`. Carried per slider because the
	 * three pops do not agree: the nibs step by 0.1 and the eraser by 1.
	 */
	decimals: number;
}

/**
 * Paint the slider's value into its readout, IN PIXELS AND SAYING SO.
 *
 * This is the format the shipped 1.4.11 pop used - `${v.toFixed(decimals)}px`
 * at MobileTools.ts:252 on that tag - restored on the owner's ruling. The
 * unit is accurate rather than decorative: the nibs' bounds are built with
 * `multToPx` and the callback converts back with `pxToMult`, and the
 * eraser's slider is identity pixels, so every number here is a real width.
 *
 * THE DECIMALS COME FROM THE CONTROL'S OWN STEP, which is the half that
 * matters. `input.value` can carry precision the slider cannot be set to -
 * a stored multiplier converts to 2.86 on a 2.2 base - and printing it raw
 * is how a bare "2.86" reached the owner's screen. Rounding to the step
 * makes the number one a reader can return to deliberately, which is the
 * whole reason it is on screen: "it's just to make sure they can get the
 * same exact width" (alan), for the user who asked for it (samuel).
 *
 * Still ONE textContent write and no layout read. This runs on every input
 * event of a drag and a style flush here would be under the finger; a
 * `toFixed` on a number already in hand is not one. The compare stays, so
 * a drag inside one step does not touch the DOM at all.
 */
export const paintValue = (s: SliderParts): void => {
	const text = `${Number(s.input.value).toFixed(s.decimals)}px`;
	if (s.num.textContent !== text) s.num.textContent = text;
};

/**
 * How a strip differs from the one the editor builds. Empty for a real strip.
 */
export interface MobileToolsOptions {
	/** Surface capabilities are fixed for one mounted strip. */
	supportedCommands?: ReadonlySet<string>;
	additionalButtons?: readonly ButtonSpec[];
	/**
	 * A strip built to be LOOKED AT rather than used: the settings tab's
	 * fold-order preview, and nothing else today.
	 *
	 * It changes exactly two things, and both are about what a strip reaches
	 * OUTSIDE its own parent:
	 *
	 *  - the collapsed state is neither inherited nor, and this is the half
	 *    that matters, WRITTEN. `setCollapsed` is the session's setter - it
	 *    assigns `collapsedSession` - so a preview calling it to make itself
	 *    visible would collapse or expand every real strip in the window. A
	 *    preview born collapsed is `display: none`, measures zero and folds
	 *    nothing, which is a preview of nothing; a preview that fixed that by
	 *    calling the setter would be a settings tab quietly changing the
	 *    editor. So it simply never asks.
	 *
	 *  - the header clearance is skipped on the two paths this flag controls,
	 *    the first pass and the resize observer. It hunts `.view-actions` in the
	 *    parent and dodges it; a settings pane has no such row, so on every
	 *    resize frame it would clear two transforms and measure nothing. NOT
	 *    skipped everywhere: `setCorner` calls it unguarded, so a preview does
	 *    run it once, harmlessly - it returns at the missing `.view-actions`
	 *    before it measures anything.
	 *
	 * Everything else is the real strip ON PURPOSE: the same buttons, the same
	 * `layoutOverflow`, the same `overflowPlan`. A preview drawn any other way
	 * is a drawing, and a drawing is free to disagree with the strip.
	 */
	preview?: boolean;
}

/**
 * The live fold order, and every strip currently showing one.
 *
 * The same shape as `setToolbarCorner` (InkOverlay.ts): a module variable the
 * setting writes, then pushed into every strip already on screen so a change
 * lands at once instead of waiting for the next rebuild. It lives HERE rather
 * than beside that setter because this file deliberately does not import
 * InkOverlay - the fold order is a fact about the strip, and the import would
 * be a cycle.
 *
 * `liveStrips` is what makes the push possible, and it is a leak if it is
 * wrong: a strip registers once it is in the tree and drops itself in
 * `destroy()`, the same lifetime its resize observer and its three document
 * listeners already have. A strip left in this set would be re-folded after
 * its pane had gone.
 *
 * Normalised on the way in as well as on the way off disk. It costs nothing
 * and it means this setter is safe for a caller that has not normalised -
 * a future settings control, say - rather than trusting every call site to
 * remember.
 */
export let foldOrder: readonly string[] = DEFAULT_FOLD_ORDER;
export const liveStrips = new Set<MobileTools>();
/** The strip whose own Eraser button is behind the current eraser switch, if any. The eraser
 * mode is global and every pane's strip sees its OFF-to-ON edge, but only the pane the user
 * tapped should drop its size pop; a hotkey or the palette has no owner and opens it in every
 * strip, as before. Cleared when the eraser goes off or its strip is destroyed. */
export const eraserEdge: { owner: MobileTools | null } = { owner: null };

export function setStripFoldOrder(order: readonly string[]): void {
	foldOrder = normalizeFoldOrder(order);
	for (const strip of liveStrips) strip.applyFoldOrder();
}







/**
 * How long the strip takes to fly from where it was dropped to the anchor it
 * landed on. Declared here and in `styles.css`'s `.is-anchoring` rule, which
 * is the pair a test pins: this number only decides when the class comes back
 * OFF, and a value shorter than the transition would cut the flight short.
 */
export const ANCHOR_FLIGHT_MS = 160;

/** One live drag of the toolbar by a handle. See `armDrag`. */
export interface ToolbarDragState {
	pointerId: number;
	handle: HTMLElement;
	startX: number;
	startY: number;
	/** Has it passed the threshold? Until it has, this is still a tap. */
	moved: boolean;
	/** The box the strip rested in when the drag began, measured once. */
	box: { left: number; top: number; right: number; bottom: number };
	/**
	 * The actions-row dodge that was IN that box when it was measured.
	 *
	 * `box` comes off the live element, so it carries whatever
	 * `applyHeaderClearance` had translated the strip by - up to a hundred px
	 * on a pdf whose three-dots row the strip's corner sits under. The anchor
	 * rule knows nothing about that dodge: `anchorRestingCentre` answers where
	 * the STYLESHEET puts a strip, with no dodge term in it. Comparing the one
	 * against the other compares two different frames, and a ten-px nudge on
	 * the grip was landing a hundred px from where the drop was aimed - far
	 * enough to change the answer for a gesture that expressed no move at all.
	 *
	 * Kept from the MEASUREMENT rather than read again at the drop, because
	 * the dodge can change mid-drag (the pdf surface reaches `setCorner` on
	 * every strip refresh) and the strip moves with it: subtracting today's
	 * dodge from a box measured under yesterday's would put the error back in
	 * with the opposite sign.
	 */
	dodge: { x: number; y: number };
}

export class MobileTools {
	el!: HTMLElement;
	buttons: Array<{ el: HTMLElement; spec: ButtonSpec }> = [];
	/**
	 * The command ids this strip was actually BUILT with, so `stale()` can
	 * tell a changed `shownOn` answer from an unchanged one. A set of ids
	 * rather than a recorded snapshot of the predicates: what matters is
	 * which buttons are on the strip, and a future `shownOn` is covered
	 * without this field learning anything about it.
	 */
	readonly built = new Set<string>();
	/**
	 * The second row, and the "More" button that opens it (item 4).
	 *
	 * Both always exist; the row is empty and the chevron hidden whenever the
	 * first row fits, which is every desktop and every tablet. Built rather
	 * than created on demand because `layoutOverflow` runs from a
	 * ResizeObserver callback, and a path that may or may not have an element
	 * to move a button into is a path that will one day not.
	 */
	moreRow!: HTMLElement;
	moreBtn!: HTMLElement;
	/** Whether the second row is showing. Closed by a tool pick and by a tap
	 * outside, per the brief; not wired into `hasOpenPop`, because Escape's
	 * job there is the pops and a folded row is not one. */
	moreOpen = false;
	/**
	 * Every node of the first row in its canonical order - dividers and
	 * buttons alike - so a button coming BACK from the second row lands
	 * between the right neighbours instead of at the end.
	 *
	 * Without this the restore would have to reason about which divider a
	 * returning button belongs after, which is exactly the bookkeeping
	 * `startsGroup` exists to avoid anybody doing by hand.
	 */
	readonly rowOrder: HTMLElement[] = [];
	/** The plan last APPLIED, so an unchanged one costs no DOM moves. */
	appliedPlan = "";
	appliedOrder = "";
	/**
	 * The grid last WRITTEN - `"<columns>:<cell px>"` - for the same reason
	 * `appliedPlan` exists. Both custom properties are re-derived on every
	 * resize frame and change on almost none of them, and a style write that
	 * sets a property to the value it already holds still invalidates it.
	 */
	appliedGrid = "";
	resizeWatch: { disconnect(): void } | null = null;
	inking = false;
	private readonly stepAside = new StepAside(() => [this.el, this.pill]);
	stopModeWatch: (() => void) | null = null;
	/**
	 * The corner this strip is parked in, kept because item 5's clearance
	 * needs to know which way to dodge and `setCorner` otherwise wrote the
	 * answer straight into a class and forgot it.
	 */
	corner: ToolbarCorner = "top-right";
	/**
	 * THE TWO WRITERS OF `transform`, kept as numbers so that ONE function
	 * writes the property.
	 *
	 * `applyHeaderClearance` sets an inline transform to dodge the pane's
	 * actions row and REPLACES the whole property while doing it - that is
	 * documented in `CornerSafeArea.test.ts`, which pins the middles to auto
	 * margins precisely because a `translateX(-50%)` in the stylesheet would
	 * be erased by it. A drag wants to write the same property, and the two
	 * would clobber each other: the resize observer fires
	 * `applyHeaderClearance` on rotation, on a split being dragged and on the
	 * sidebar opening, every one of which can happen with a finger still on
	 * the grip, and the dodge landing mid-drag would put the strip back where
	 * the pointer is not.
	 *
	 * So neither of them writes `transform`. They write these, and
	 * `paintTransform` composes the one string. The dodge is a translate the
	 * strip keeps whether or not it is being dragged; the drag is a DELTA
	 * from wherever the strip already was, which is what makes composing them
	 * by addition the right answer rather than a compromise - the strip
	 * tracks the pointer exactly, and a dodge that changes mid-drag moves it
	 * by the amount the actions row actually moved.
	 */
	dodge: { x: number; y: number } = { x: 0, y: 0 };
	dragOffset: { x: number; y: number } = { x: 0, y: 0 };
	/**
	 * The live drag, or null. `moved` is the threshold: until it flips this
	 * is a contact that may yet turn out to be a tap, and nothing has been
	 * painted, no pop has been closed and the pill's click still works.
	 */
	drag: ToolbarDragState | null = null;
	/**
	 * A drag ended on a handle, so the click the browser synthesizes from
	 * that same release must not be taken as a tap. Set on the drop, cleared
	 * by the pill's click and by the next contact, so it can never outlive
	 * the gesture that armed it.
	 */
	dragClickArmed = false;
	/** The `.is-anchoring` sweep-off, so a second drop cannot leave the
	 * class on and animate the next dodge. */
	anchorTimer: number | null = null;
	/** The grip: six dots at the strip's leading end, and the drag handle. */
	grip!: HTMLElement;
	slider!: SliderParts;
	penSlider!: SliderParts;
	hlSlider!: SliderParts;
	/** Which nib's size slider is open; tap the active tool again to toggle. */
	openInkSlider: "pen" | "highlighter" | null = null;
	sliderHoverTimer: number | null = null;
	/**
	 * THE HOLD TIMERS, held here rather than in the closures that arm them.
	 *
	 * Both were `let holdTimer` inside the listener that started them, which
	 * meant nothing outside that closure could stop them - and this class is
	 * destroyed and rebuilt on a pen edge (`stale()`), so a 600ms hold armed
	 * just before a rebuild fired against a strip that no longer existed. The
	 * preset one is the defect with teeth: `paintPresets` empties and rebuilds
	 * the chip row, so a hold armed on a chip that has since been redrawn
	 * fired `forgetPreset` against an INDEX that now names a different pen -
	 * a starred pen deleted after the finger lifted (review, 2026-09-05).
	 */
	recordingHoldTimer: number | null = null;
	presetHoldTimer: number | null = null;
	/** Set true the instant a hold-timer forgets a preset, before the finger
	 * has physically lifted. `paintPresets` empties and rebuilds the row right
	 * there, so the button under the finger is destroyed and whatever now
	 * sits at that screen position (often the former neighbour) is a BRAND
	 * NEW button with its own fresh `held = false` closure. On Windows the
	 * release still fires a contextmenu after the hold, and it lands on that
	 * new button - which has no memory of the hold that just ran, and would
	 * forget a second preset (item 73 audit, "press-and-hold delete on a
	 * preset chip also deletes its neighbour"). This flag lives on the strip,
	 * not on a chip closure, so it survives the rebuild the closure does not. */
	suppressNextPresetContextMenu = false;
	/** The same hold, the release's CLICK: it lands on the rebuilt chip (or the star) under the
	 * finger, whose own `held` is false, so the strip remembers the hold for it. */
	suppressNextPresetClick = false;
	recordingDot!: HTMLElement;
	/** Whether the dot was last drawn lit, so a flip can re-plan the fold. */
	recordingShown = false;
	collapseBtn!: HTMLElement;
	/** True when HOVER opened the slider - only those evaporate on leave.
	 * A clicked-open slider is a decision and stays until a click, a tap
	 * elsewhere, or writing closes it (the pen LEAVES a button it just
	 * tapped, and 300ms later the slider it asked for was gone). */
	sliderFromHover = false;

	/**
	 * The slider input under a finger right now, or null.
	 *
	 * `hangUnder` will not write a value into this one. Writing into a
	 * control the user is holding is wrong whatever the value is: the thumb
	 * is answering to two masters, and on any engine where an assignment
	 * disturbs a drag in flight the two take turns setting it - "weird
	 * distortion on the pen slider as i slide it up and down, like the
	 * slider is just vibrating" (alan, on hardware, 2026-09-02).
	 *
	 * Held by input IDENTITY rather than a flag per slider, so the release
	 * is one document listener for all three and a fourth slider inherits
	 * the guard just by being built through `dropSlider`. A drag flag, not
	 * `document.activeElement`: a range input keeps focus after the pointer
	 * lifts, so an activeElement test would suppress every later write-back
	 * until focus moved on, and focus is the part least likely to behave the
	 * same in an Android WebView as it does on desktop.
	 */
	heldSlider: HTMLInputElement | null = null;

	/**
	 * There is no `colorsOpen` any more, and its absence is the whole of item
	 * 1: the swatches used to live in a pop of their own, hung under an "Ink
	 * color" button, and exactly one pop could be open at a time - so every
	 * branch that opened a size slider closed the colours, and vice versa.
	 * The swatches are now a ROW INSIDE each nib's size pop, so opening a
	 * nib's options IS opening its colours and there is no second state to
	 * keep in step with the first.
	 */
	strokeChip!: HTMLElement;
	reticleChip!: HTMLElement;

	/**
	 * The eraser's size/behavior pop (`this.slider`, built at :561 by the
	 * same `dropSlider` helper as the pen/highlighter pops) is a third
	 * object Slice P never knew about: `hangUnder`'s call for it (refreshNow,
	 * :768) shows it for as long as `eraserOn()` is true, full stop, so
	 * Escape found nothing to consume while erasing (alan, 2026-09-02).
	 * `closeInkSliders` sets this now, the same as every other pop it closes
	 * - pen contact, an outside tap and Escape all put the eraser pop away
	 * exactly like the size and colour pops (alan, 2026-09-02: "you eraser
	 * pop should close when pen touches down... we did it for other tools
	 * but never did it for eraser" - the "leave it alone for pen-down and
	 * outside taps" reasoning this comment used to give was the omission he
	 * meant, not a decision). It clears itself the next time the eraser is
	 * switched ON - the false-to-true edge `refreshNow` watches below -
	 * covering the strip button, the palette command and a hotkey alike,
	 * since none of those paths run through this object's own click handler.
	 * That edge was the only way back to the pop once contact closed it
	 * until §5p (alan, 2026-09-02: "pressing the eraser while it is already
	 * active should reopen its size pop, not switch the tool off" - a mouse
	 * excepted, "mouse sould disable"): the click handler's eraser branch
	 * now CLEARS this bit directly too, so the way back is one tap. It only
	 * clears - it never sets - because a press made while the pop is already
	 * showing is not asking for the pop, and is left to switch the tool off
	 * the way it always did. So the only things that SET it are
	 * `closeInkSliders` and the hover-leave timer in `scheduleSliderClose`,
	 * and the only things that clear it are the activation edge, the
	 * mouse-hover preview and that tap.
	 */
	eraserPopClosed = false;

	/** True when HOVER is what opened the eraser pop - mirrors
	 * `sliderFromHover` above, kept as a separate bit rather than folded
	 * into that field because the eraser was never a member of the union
	 * it protects (`openInkSlider` is `"pen" | "highlighter" | null`); the
	 * eraser's pop is driven by `eraserPopClosed` instead, so "don't
	 * auto-close what a tap opened" needs a flag pointed at that bit
	 * specifically (§5p AI CONFIRMED, item 1). Set only by the eraser's
	 * mouse-only hover-open in the `pointerenter` handler below - see
	 * there for why pen does not share this path - and consumed the same
	 * way `sliderFromHover` is, in `scheduleSliderClose`. */
	eraserPopFromHover = false;

	/** The `eraserOn()` seen on the last `refreshNow`, so the eraser pop's
	 * OFF-to-ON edge can be told apart from "still on" - see
	 * `eraserPopClosed`. Seeded from the host in the constructor, NOT left at
	 * this default: the mode is global and this bit is per-strip, so a strip
	 * that mounts into an eraser session is arriving mid-mode and has watched
	 * no switch at all. */
	wasEraserOn = false;

	pill!: HTMLElement;

	/**
	 * The ctor's `parent`, kept by name. Escape's ownership test needs the
	 * pane itself, not just the elements built inside it (§5p): a strip
	 * consumes Escape only when the event's target sits inside its OWN pane,
	 * `this.pane.contains(...)`, never `this.el` alone (the pill and the
	 * strip are both children of it, and so is everything the editor draws).
	 */
	readonly pane: HTMLElement;

	/**
	 * Whether the eraser's size/behavior pop is currently showing - the
	 * SAME condition `refreshNow`'s `hangUnder` call uses to drive its
	 * `is-showing` class (below), not a second copy of it: `eraserOn()`
	 * gates the pop the way `openInkSlider` gates the others, and
	 * `eraserPopClosed` is the one bit this object adds to suppress it
	 * without touching the tool.
	 *
	 * The `!colorsOpen` conjunct that used to sit here has gone with the
	 * colour pop it protected: the swatches are a row inside the nib pops
	 * now, so nothing can be showing over the eraser's pop that the eraser's
	 * own mode does not already exclude.
	 */
	eraserPopOpen(): boolean {
		return this.host.eraserOn() && !this.eraserPopClosed;
	}

	/** Something open enough that Escape (or a stray tap) should close it. */
	hasOpenPop(): boolean {
		return this.openInkSlider !== null || this.eraserPopOpen();
	}

	/** Closes open pops when a tap lands anywhere that is not the strip. */
	readonly outsideTap = (ev: PointerEvent): void => {
		// `contains`, never instanceof: a popout window's elements belong to
		// another realm and instanceof refuses them, so this returned early
		// on every tap in a popout and the pops never dismissed there. The
		// note below describes fixing exactly that on glass - it was only
		// ever fixed for the main window. Same rule the routers already
		// spell out twice (InlinePenRouter: "a popout window's elements
		// belong to another realm"); contains works across realms.
		const t = ev.target as Node | null;
		if (!t) return;
		if (this.el.contains(t) || this.pill.contains(t)) return;
		// The folded row is a menu and dismisses like one (item 4: "tapping
		// outside or picking a tool closes it"). Here rather than inside
		// `closeInkSliders`, because that call is also what a PEN CONTACT
		// makes, and Escape's consume-or-ignore verdict is computed from
		// whether a POP was open - folding a row into that would have Escape
		// swallowed by a strip whose only open thing is a menu.
		//
		// Not in the settings preview: its More row is opened on purpose by the
		// fold-order control to show what folds there, and any tap elsewhere in
		// Settings (the scroll that reaches the preview, say) used to close it.
		if (!this.isPreview) this.setMoreOpen(false);
		// On glass there is no pen-down-over-the-page moment to hide behind:
		// a slider opened with a finger just STAYED, over whatever the next
		// tap was about, until another tool was pressed (ipad, 2026-08-30).
		// Desktop never felt it because writing closes the pops.
		this.closeInkSliders();
	};

	/**
	 * Trace-only: did a click reach the strip or the pill? Diagnosis for the
	 * tool-dependent strip-tap bug (InlinePenRouter.ts's window mirror):
	 * when a pen tap's `window-pointerdown` trace line says the composed
	 * path missed the editor scroller - the strip's normal position, since
	 * it mounts as a SIBLING of the scroller - that line alone cannot tell
	 * "the pointerdown hit the strip but no click was ever synthesized"
	 * from "a click arrived and the strip's own handler did nothing". This
	 * is the other half: a capture-phase listener on this strip's own pane,
	 * same as `outsideTap` beside it, so it sees the click before anything
	 * on the strip could stop it. `traceStripClick` gates on whether tracing
	 * is actually running, so the cost here while it is not is two cheap
	 * `contains()` calls - the same shape `outsideTap` already pays on
	 * every pointerdown in the document, unconditionally.
	 */
	readonly traceClick = (ev: MouseEvent): void => {
		const t = ev.target as Node | null;
		if (!t || !(this.el.contains(t) || this.pill.contains(t))) return;
		traceStripClick(t as Element);
	};

	/**
	 * A slider drag ends wherever the pointer happens to be, and for a
	 * 28x104 slot that is very often NOT on the input: the pen lifts past
	 * the edge of the slot, or a gesture cancels the pointer outright.
	 * Listening on the document, in capture beside outsideTap and torn down
	 * beside it, is what keeps a slider from staying "held" for the rest of
	 * the session and silently suppressing every write-back after it.
	 */
	readonly releaseSlider = (): void => {
		this.heldSlider = null;
	};

	/**
	 * Escape closes an open pop, the way it dismisses everything else
	 * transient here: a lasso selection and a held tip mode both already go
	 * that way (InkOverlay), and so does the pdf selection. The size and
	 * colour pops were the exception - once open, only a tap somewhere else
	 * would put them away, which is fine on glass and wrong on a keyboard
	 * (alan, hardware, 2026-09-02: "esc should close the slider").
	 *
	 * Consumed ONLY when a pop was actually open. Escape has other jobs in
	 * this editor, and a toolbar that swallows it whenever the strip exists
	 * would take the key away from clearing a selection - trading one missing
	 * dismissal for a worse one.
	 *
	 * Capture, beside outsideTap and torn down beside it, so it is heard
	 * before anything in the editor can stop it. No realm check is possible
	 * or needed: this reads the key, never the target.
	 *
	 * Split view is why "a pop was open" is not enough to consume. Every
	 * pane has its own MobileTools and its own capture listener on the SAME
	 * document, so one press reaches every strip in the window. A pop open
	 * in pane A and Escape pressed while working in pane B must close A's
	 * pop AND still let B's own Escape handling (its selection, its held
	 * tip) see the key - if A consumed it, B's selection would never clear.
	 * `stripEscapeVerdict` (`StripEscape.ts`, §5p) is what tells A apart
	 * from B: ownership, `this.pane.contains(ev.target)`, decides who is
	 * allowed to consume, not who happened to have something open.
	 */
	readonly escapeKey = (ev: KeyboardEvent): void => {
		// A LIVE DRAG TAKES ESCAPE FIRST, and takes it unconditionally.
		//
		// `stripEscapeVerdict`'s ownership rule exists because every strip in
		// a window hears every Escape, so a pop open in pane A must not eat a
		// key meant for pane B. A drag has no such ambiguity: exactly one
		// strip in the window has a pointer captured on its handle, and it is
		// this one. Asking `ownsTarget` here would refuse the key whenever
		// focus sat in the editor - which is where it sits during every drag
		// ever made, since a strip button never takes focus.
		if (ev.key === "Escape" && !ev.defaultPrevented && this.drag?.moved === true) {
			this.cancelDrag(true);
			ev.preventDefault();
			ev.stopPropagation();
			return;
		}
		const verdict = stripEscapeVerdict({
			key: ev.key,
			defaultPrevented: ev.defaultPrevented,
			anyOpen: this.hasOpenPop() || this.moreOpen,
			ownsTarget: this.pane.contains(ev.target as Node | null),
		});
		if (verdict === "ignore") return;
		// The More row is an Escape layer without changing pen-contact dismissal.
		this.setMoreOpen(false);
		this.closeInkSliders();
		if (verdict === "close-consume") {
			ev.preventDefault();
			ev.stopPropagation();
		}
	};

	viewportControls: NoteZoomControls | null = null;
	/** The settings "Toolbar buttons" preview, not a live strip. */
	private readonly isPreview: boolean;

	constructor(parent: HTMLElement, readonly host: MobileToolsHost, opts: MobileToolsOptions = {}) {
		// Read once into a local: the flag is consulted from the resize
		// observer's callback, which outlives this call, and a closure over one
		// boolean is cheaper to reason about than a field nothing else reads.
		const preview = opts.preview === true;
		this.isPreview = preview;
		this.pane = parent;
  if (host.noteViewport && !preview) this.viewportControls = new NoteZoomControls(parent, host);

		this.buildChrome(parent, host, opts);
		this.buildPops();
		this.finishBuild(parent, host, preview);
	}

	refreshQueued = false;

	/**
	 * The chrome steps aside while the pen is down. The original reason was
	 * that anything overlapping a desynchronized canvas can demote it off the
	 * low-latency path; that flag is off now (see INLINE_DESYNCHRONIZED), so
	 * the behaviour rests on the simpler reason instead - a toolbar over the
	 * page is a toolbar in the way of the nib.
	 *
	 * Pure class toggles - no reads, nothing forced, safe inside the pen-down
	 * handler.
	 */
	setInking(on: boolean): void {
		this.inking = on;
		this.stepAside.set(on && getPenToolsMode() === "auto");
		// The zoom bar mirrors the same step-aside, on its own mode. Pure class
		// toggle, no reads - same hot path as the two above.
		this.viewportControls?.setInking(on);
	}

	/**
	 * Re-ask both halves of the rule and re-run the step-aside, exactly as the
	 * mode listener does. Public for `refreshNoteZoomControlsAll`.
	 */
	refreshNoteZoomControls(): void {
		this.viewportControls?.refresh();
	}

	/**
	 * The pointer came up. A drag that never passed the threshold was a tap
	 * and is left alone; one that did is dropped on the nearest anchor.
	 *
	 * Reached from the DOCUMENT, in capture, beside the held slider's release
	 * and for the same reason: a gesture very often ends with the pointer
	 * somewhere else, and on an engine that refused pointer capture the
	 * handle would never hear the lift at all - leaving a drag live forever,
	 * which is the one failure here with no way back for the user.
	 */
	readonly endDrag = (ev: PointerEvent): void => {
		const drag = this.drag;
		if (!drag) return;
		// A second finger's lift is not this drag's lift. This listener is
		// document-wide, so it hears every pointer in the window.
		if (ev.pointerId !== drag.pointerId) return;
		try {
			drag.handle.releasePointerCapture(drag.pointerId);
		} catch {
			/* already released, or never taken */
		}
		if (ev.type === "pointercancel") {
			this.cancelDrag(false);
			return;
		}
		if (!drag.moved) {
			this.drag = null;
			return;
		}
		this.dropDrag(drag);
	};

	/** True once, for the click a hold-to-delete release sends to the control now under the
	 * finger. A click with no press behind it (`detail` 0: Enter, Space, a screen reader) is a
	 * decision of its own and is never swallowed, so the flag cannot eat a keyboard activation
	 * on a device that sends no release click. */
	consumePresetHoldClick(ev: Event): boolean {
		if (!this.suppressNextPresetClick) return false;
		this.suppressNextPresetClick = false;
		return (ev as MouseEvent).detail !== 0;
	}

	tip!: HTMLElement;
	/** The folded pill's tooltip: on the strip's parent, because `tip` is inside the strip and hidden with it. */
	pillTip!: HTMLElement;
	tipTimer: number | null = null;

	destroy(): void {
		this.stopModeWatch?.();
		this.stopModeWatch = null;
		this.cancelSliderClose();
		this.stepAside.cancel();
		// Every timer this strip can have armed, cancelled before the elements
		// they would touch are removed. A strip is destroyed and rebuilt on a
		// pen edge, so each of these is a real window, not a theoretical one.
		this.cancelRecordingHold();
		this.cancelPresetHold();
		this.cancelTipTimer();
		// A strip is destroyed and rebuilt on a pen edge, which can land
		// inside a drag - the pen's first contact of the session while the
		// other hand is moving the toolbar. The offset is cleared with it, so
		// nothing is left translated on elements about to be removed.
		this.cancelDrag(false);
		this.endAnchorFlight();
		// The observer outlives the elements it watches unless it is told
		// not to, and this class is now destroyed and rebuilt on a pen edge
		// (`stale()`), so a leak here would accumulate one dead observer per
		// pen-first-contact per pane rather than one per session.
		liveStrips.delete(this);
		if (eraserEdge.owner === this) eraserEdge.owner = null;
		this.resizeWatch?.disconnect();
		this.resizeWatch = null;
		this.el.ownerDocument.removeEventListener("pointerdown", this.outsideTap, { capture: true });
		this.el.ownerDocument.removeEventListener("keydown", this.escapeKey, { capture: true });
		this.el.ownerDocument.removeEventListener("pointerup", this.releaseSlider, { capture: true });
		this.el.ownerDocument.removeEventListener("pointercancel", this.releaseSlider, {
			capture: true,
		});
		this.el.ownerDocument.removeEventListener("pointerup", this.endDrag, { capture: true });
		this.el.ownerDocument.removeEventListener("pointercancel", this.endDrag, { capture: true });
		this.el.ownerDocument.removeEventListener("click", this.traceClick, { capture: true });
		this.heldSlider = null;
		this.el.remove();
		this.pill.remove();
		this.pillTip.remove();
		this.viewportControls?.destroy();
		this.viewportControls = null;
		this.buttons = [];
	}

	/**
	 * The ids on the SECOND ROW right now, in the order they read there.
	 *
	 * The settings preview draws its fold line and its caption from this, so
	 * both come from the plan the strip ACTUALLY APPLIED rather than from a
	 * second call to `overflowPlan` with the control's own idea of how wide a
	 * button is. That second call is exactly how a preview and a strip come to
	 * disagree, and disagreeing is the only thing a preview can do wrong.
	 *
	 * Read back off `appliedPlan` - the same string `layoutOverflow` compares
	 * against before it moves anything - so it cannot drift from what is on
	 * screen. Empty whenever the row fits, which is every desktop, and empty
	 * on a strip that has never had a width to measure.
	 */
	get foldedIds(): string[] {
		return this.appliedPlan === "" ? [] : this.appliedPlan.split(",");
	}

	/** Test seam / debugging: the currently open nib slider, if any. */
	get openNibSlider(): "pen" | "highlighter" | null {
		return this.openInkSlider;
	}

	/**
	 * Trace-only snapshot of this strip's hit-testability, for
	 * InlinePenRouter's window mirror (InlinePenCallbacks.describeChrome).
	 * `target` is the pointerdown's actual hit element - classified against
	 * THIS strip's real element references rather than a caller guessing
	 * selector strings, because the router deliberately holds none of them
	 * (InlinePenRouter.ts: "the router doesn't know chrome exists, by
	 * design"). Deliberately NOT `instanceof Element` anywhere below - a
	 * popout window's elements belong to another realm and instanceof
	 * refuses them (see `outsideTap`'s own note on this, above); `contains`
	 * and `classList` work across realms and duck-type fine in a test's
	 * hand-rolled element fakes too. Read-only: getComputedStyle calls and
	 * class/field reads, never a write - and it only ever runs while the
	 * router is already composing a trace line, which is itself gated on
	 * `diagnosticsEnabled`, so this costs nothing on the ordinary path.
	 */
	traceState(target: Element | null): string {
		const style = (el: Element | null): string => {
			if (!el) return "(none)";
			const cs = getComputedStyle(el);
			return `vis=${cs.visibility} pe=${cs.pointerEvents} op=${cs.opacity} disp=${cs.display}`;
		};
		const part = ((): string => {
			if (!target) return "none";
			if (this.pill.contains(target)) return "pill";
			// Three pops, not four: the colour pop is gone and its swatches
			// live inside the two nib pops already named here, so a tap on a
			// swatch still classifies as "slider-pop" - the same answer a
			// trace line gave before, reached through the pop that now
			// contains it.
			if (
				this.penSlider.pop.contains(target) ||
				this.hlSlider.pop.contains(target) ||
				this.slider.pop.contains(target)
			) {
				return "slider-pop";
			}
			if (this.buttons.some(({ el }) => el.contains(target))) return "button";
			if (this.el.contains(target)) return "strip-root";
			return "none";
		})();
		const openPop = this.eraserPopOpen() ? "eraser" : (this.openInkSlider ?? "none");
		// Named rather than a bare boolean: which element is stuck, not just
		// whether one is, is the part worth reading off a trace line - a
		// resting finger's lost pointerup (the same shape abandonActiveStroke
		// exists for) would strand this class on exactly one button or the
		// pill, forever, with nothing else in this file's own state to say so.
		const stuckPressed = [this.pill, ...this.buttons.map((b) => b.el)]
			.filter((el) => el.classList.contains("is-pressed"))
			.map((el) => describeEl(el));
		return (
			`hit=${describeEl(target)} strip-part=${part} ` +
			`hitStyle[${style(target)}] stripStyle[${style(this.el)}] pillStyle[${style(this.pill)}] ` +
			`is-inking=${this.el.classList.contains("is-inking")} ` +
			`is-collapsed=${this.el.classList.contains("is-collapsed")} ` +
			`openPop=${openPop} stuckPressed=${stuckPressed.length ? stuckPressed.join(",") : "none"} ` +
			`activeTool=${this.host.activeTool()}`
		);
	}
}

installMobileToolsBuild(MobileTools.prototype);

installMobileToolsDrag(MobileTools.prototype);
installMobileToolsPaint(MobileTools.prototype);
installMobileToolsLayout(MobileTools.prototype);
installMobileToolsBuildRest(MobileTools.prototype);
installMobileToolsPops(MobileTools.prototype);
