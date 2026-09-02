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

import { setIcon } from "obsidian";
import {
	ToolbarCorner,
	allToolbarCornerClasses,
	toolbarCornerClass,
} from "./ToolbarCorner";
import { stripEscapeVerdict } from "./StripEscape";
import { penSeenThisSession } from "./PenToolsMode";
import { DEFAULT_PEN, HIGHLIGHTER_PEN } from "../ink/PenStyle";

export interface MobileToolsHost {
	/** Execute a command by its full id (e.g. "handwriting:inline-tool-pen"). */
	exec(commandId: string): void;
	/** The active nib: "pen" or "highlighter". */
	activeTool(): string;
	/** Whether eraser mode currently overrides the nib. */
	eraserOn(): boolean;
	/** Eraser behavior, so the pop's Stroke | Reticle chips can show and flip it. */
	eraserWholeStroke(): boolean;
	setEraserWholeStroke(on: boolean): void;
	/** Whether lasso mode makes the tip lasso. */
	lassoOn(): boolean;
	/** Whether insert-space mode makes the tip plant a divider. */
	spaceOn(): boolean;
	/** Whether pan mode makes the tip drag the view. */
	panOn(): boolean;
	/** The active tool's current ink color, for the tinted palette button. */
	activeColor(): string;
	/** Eraser radius in screen px, for the slider. */
	eraserRadiusPx(): number;
	/** Live while dragging; commit=true on release persists. */
	setEraserRadiusPx(px: number, commit: boolean): void;
	/** Nib size multiplier for a tool, for the ink sliders. */
	inkSizeMult(tool: string): number;
	setInkSizeMult(tool: string, mult: number, commit: boolean): void;
	/** Editor history state, so undo/redo can dim when they would no-op. */
	canUndo(): boolean;
	canRedo(): boolean;
	/** Whether the ink clipboard holds anything, so paste can dim. */
	canPasteInk(): boolean;
	/** Mouse ink: on for people writing with a mouse instead of a pen. */
	mouseInkOn(): boolean;
	setMouseInk(on: boolean): void;
	/** Arm without a toast: for arming that rides inside a tool click. */
	armMouseInkQuietly(): void;
	/** Bug-report recording state, for the strip's dot. */
	recordingOn(): boolean;
	/** Whether a lasso selection exists, so copy and trash can dim. */
	hasInkSelection(): boolean;
	/** The active tool's palette, for the swatch pop. */
	palette(): ReadonlyArray<{ name: string; hex: string }>;
	/** A swatch was tapped: apply the color, pick up its nib, toast it. */
	pickColor(name: string, hex: string): void;
}

/**
 * The tip inks only when nothing has taken it over. A nib button asked
 * only whether the eraser was on, so turning on lasso - or insert space,
 * which copied lasso's shape - left Pen lit alongside the mode that had
 * actually claimed the tip, and the strip showed two active tools at once
 * (alan, 2026-08-27). Every mode that steals the tip belongs in here.
 */
const tipInks = (h: MobileToolsHost): boolean =>
	!h.eraserOn() && !h.lassoOn() && !h.spaceOn() && !h.panOn();

/**
 * Whether a nib button's LIGHT (and the collapsed pill) should show it lit:
 * the tip must nominally hold this tool AND the tip must actually ink with
 * it - true once a pen has been seen this session, or for a mouse user only
 * while mouse ink is armed. Pulled out as a pure function of (host, tool) -
 * MobileTools has no test harness (DOM-heavy, cannot be constructed under
 * the suite) but this needs only a fake MobileToolsHost, so MobileTools.test.ts
 * pins it directly. See ButtonSpec.isLit for why this is a separate read
 * from isActive, which the click chain still branches on.
 */
export const nibIsLit = (h: MobileToolsHost, tool: "pen" | "highlighter"): boolean =>
	tipInks(h) && h.activeTool() === tool && (penSeenThisSession() || h.mouseInkOn());

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
const pxToMult = (px: number, base: number): number => Math.round((px / base) * 1000) / 1000;
const multToPx = (mult: number, base: number): number => Math.round(mult * base * 1000) / 1000;
/** Same formatter shape as the eraser's `${v}px` - rounded to 1dp so a
 * sub-pixel base (the pen's) never prints a wall of decimals. */
const pxLabel = (v: number): string => `${Math.round(v * 10) / 10}px`;

interface ButtonSpec {
	icon: string;
	/** Two-char fallback shown when the icon set has no such glyph. */
	glyph: string;
	label: string;
	commandId: string;
	/** Marks the button active from current state; omitted = never marked. */
	isActive?: (host: MobileToolsHost) => boolean;
	/**
	 * What the LIGHT (and the collapsed pill) show; omitted = same as
	 * isActive. Split from isActive because the click chain below branches
	 * on isActive to disarm/re-arm mouse ink (:570-680-ish) - collapsing the
	 * two into one predicate made the second click of "click the lit pen
	 * button, click it again" land on a different branch with a different
	 * toast than today (alan, 2026-09-02, traced by hand before this was
	 * written). isActive keeps meaning "the nominal tool"; isLit answers
	 * "does the tip actually ink with this right now" - the tip only inks
	 * for a mouse user when mouse ink is armed, or for anyone once a pen has
	 * been seen this session (penSeenThisSession, PenToolsMode.ts).
	 */
	isLit?: (host: MobileToolsHost) => boolean;
	/** Dims the button when false; omitted = always enabled. */
	isEnabled?: (host: MobileToolsHost) => boolean;
	/**
	 * Draw a divider BEFORE this button. The strip carries two different
	 * kinds of control - modes, where exactly one is always winning, and
	 * one-shot actions - and they were laid out identically, so the most
	 * important distinction in the whole strip was invisible.
	 */
	startsGroup?: boolean;
}

/**
 * Four groups, divided by SUBJECT rather than by widget type: the nib and
 * its colour, the other things the tip can be, what to do with a selection,
 * and the note's history. Colour is an action sitting among modes on
 * purpose - it changes whichever nib is active, so it belongs beside them.
 */
const BUTTONS: ButtonSpec[] = [
	{
		icon: "pen",
		glyph: "P",
		label: "Pen",
		commandId: "handwriting:inline-tool-pen",
		isActive: (h) => tipInks(h) && h.activeTool() === "pen",
		// alan, 2026-09-02: "can we make sure that the pen button unhilights
		// when we click it with mouse and moes ink turns off?" A mouse click
		// on the lit pen button turns mouse ink off (:570 below) and the
		// mouse goes back to text; the light must follow that, not just the
		// nominal tool. Pen/touch users always have penSeenThisSession()
		// true from their first stroke, so this reduces to isActive for
		// them - only a mouse-without-a-pen user ever sees it diverge.
		isLit: (h) => nibIsLit(h, "pen"),
	},
	{
		icon: "highlighter",
		glyph: "H",
		label: "Highlighter",
		commandId: "handwriting:inline-tool-highlighter",
		isActive: (h) => tipInks(h) && h.activeTool() === "highlighter",
		isLit: (h) => nibIsLit(h, "highlighter"),
	},
	// The colour belongs with the nibs it changes; it used to sit four
	// unrelated buttons away, between Paste and Undo.
	{ icon: "palette", glyph: "Cl", label: "Ink color", commandId: "handwriting:ink-color-cycle" },
	{
		icon: "eraser",
		glyph: "E",
		label: "Eraser",
		commandId: "handwriting:inline-tool-eraser",
		isActive: (h) => h.eraserOn(),
		startsGroup: true,
	},
	{
		icon: "lasso",
		glyph: "L",
		label: "Lasso",
		commandId: "handwriting:inline-tool-lasso",
		isActive: (h) => h.lassoOn(),
	},
	{
		icon: "unfold-vertical",
		glyph: "S",
		label: "Insert space",
		commandId: "handwriting:inline-tool-space",
		isActive: (h) => h.spaceOn(),
	},
	{
		icon: "hand",
		glyph: "M",
		label: "Pan",
		commandId: "handwriting:inline-tool-pan",
		isActive: (h) => h.panOn(),
	},
	{
		icon: "trash-2",
		glyph: "D",
		label: "Delete selection",
		startsGroup: true,
		commandId: "handwriting:delete-selected-ink",
		isEnabled: (h) => h.hasInkSelection(),
	},
	{
		icon: "copy",
		glyph: "Cp",
		label: "Copy selected ink",
		commandId: "handwriting:copy-selected-ink",
		isEnabled: (h) => h.hasInkSelection(),
	},
	{
		icon: "clipboard-paste",
		glyph: "V",
		label: "Paste ink",
		commandId: "handwriting:paste-ink",
		isEnabled: (h) => h.canPasteInk(),
	},
	{
		icon: "undo-2",
		glyph: "U",
		label: "Undo",
		commandId: "editor:undo",
		isEnabled: (h) => h.canUndo(),
		startsGroup: true,
	},
	{ icon: "redo-2", glyph: "R", label: "Redo", commandId: "editor:redo", isEnabled: (h) => h.canRedo() },
];

/**
 * Collapsed is a SESSION preference, not a per-note one: collapsing the
 * strip in one note means "get out of my way", and it would be rude to
 * reappear full-size on the next note. New strips are born matching it.
 */
let collapsedSession = false;

export class MobileTools {
	private el: HTMLElement;
	private buttons: Array<{ el: HTMLElement; spec: ButtonSpec }> = [];
	private slider!: { pop: HTMLElement; input: HTMLInputElement; val: HTMLElement };
	private penSlider!: { pop: HTMLElement; input: HTMLInputElement; val: HTMLElement };
	private hlSlider!: { pop: HTMLElement; input: HTMLInputElement; val: HTMLElement };
	/** Which nib's size slider is open; tap the active tool again to toggle. */
	private openInkSlider: "pen" | "highlighter" | null = null;
	private sliderHoverTimer: number | null = null;
	private recordingDot!: HTMLElement;
	private collapseBtn!: HTMLElement;
	/** True when HOVER opened the slider - only those evaporate on leave.
	 * A clicked-open slider is a decision and stays until a click, a tap
	 * elsewhere, or writing closes it (the pen LEAVES a button it just
	 * tapped, and 300ms later the slider it asked for was gone). */
	private sliderFromHover = false;

	/** Whether the color swatch pop is open. */
	private colorsOpen = false;
	private strokeChip!: HTMLElement;
	private reticleChip!: HTMLElement;
	private colorPop!: HTMLElement;

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
	 * now flips this bit directly too, the way the nib buttons' `isActive`
	 * branches flip `openInkSlider` for pen and highlighter.
	 */
	private eraserPopClosed = false;

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
	private eraserPopFromHover = false;

	/** The `eraserOn()` seen on the last `refreshNow`, so the eraser pop's
	 * OFF-to-ON edge can be told apart from "still on" - see
	 * `eraserPopClosed`. */
	private wasEraserOn = false;

	private pill: HTMLElement;

	/**
	 * The ctor's `parent`, kept by name. Escape's ownership test needs the
	 * pane itself, not just the elements built inside it (§5p): a strip
	 * consumes Escape only when the event's target sits inside its OWN pane,
	 * `this.pane.contains(...)`, never `this.el` alone (the pill and the
	 * strip are both children of it, and so is everything the editor draws).
	 */
	private readonly pane: HTMLElement;

	/**
	 * Whether the eraser's size/behavior pop is currently showing - the
	 * SAME condition `refreshNow`'s `hangUnder` call uses to drive its
	 * `is-showing` class (below), not a second copy of it: `eraserOn()`
	 * gates the pop the way `openInkSlider`/`colorsOpen` gate the others,
	 * and `eraserPopClosed` is the one bit this object adds to suppress it
	 * without touching the tool.
	 */
	private eraserPopOpen(): boolean {
		return this.host.eraserOn() && !this.colorsOpen && !this.eraserPopClosed;
	}

	/** Something open enough that Escape (or a stray tap) should close it. */
	private hasOpenPop(): boolean {
		return this.openInkSlider !== null || this.colorsOpen || this.eraserPopOpen();
	}

	/** Closes open pops when a tap lands anywhere that is not the strip. */
	private readonly outsideTap = (ev: PointerEvent): void => {
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
		// On glass there is no pen-down-over-the-page moment to hide behind:
		// a slider opened with a finger just STAYED, over whatever the next
		// tap was about, until another tool was pressed (ipad, 2026-08-30).
		// Desktop never felt it because writing closes the pops.
		this.closeInkSliders();
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
	private readonly escapeKey = (ev: KeyboardEvent): void => {
		const verdict = stripEscapeVerdict({
			key: ev.key,
			defaultPrevented: ev.defaultPrevented,
			anyOpen: this.hasOpenPop(),
			ownsTarget: this.pane.contains(ev.target as Node | null),
		});
		if (verdict === "ignore") return;
		// closePops used to exist here because Escape alone took the eraser
		// pop; now closeInkSliders takes every pop (pen contact and an
		// outside tap included, alan, 2026-09-02), so Escape has nothing
		// left to add and calls the same close everything else does.
		this.closeInkSliders();
		if (verdict === "close-consume") {
			ev.preventDefault();
			ev.stopPropagation();
		}
	};

	constructor(parent: HTMLElement, private host: MobileToolsHost) {
		this.pane = parent;
		// The collapsed form: one small pen button that brings the strip back.
		this.pill = parent.createEl("button", {
			cls: "handwriting-pen-pill",
			attr: { "aria-label": "Pen tools", type: "button" },
		});
		setIcon(this.pill, "pen");
		if (!this.pill.querySelector("svg")) this.pill.setText("P");
		// Buttons must not take focus from the editor: undo/redo route to the
		// active editor, and a focus-stealing toolbar makes that a coin flip.
		// preventDefault here kills the compat mouse events that drive CSS
		// :active, so a pressed button showed NOTHING on touch until the click
		// landed at finger-lift (emulation, 2026-08-30). The pressed state is
		// a class managed on the same events instead.
		const noFocus = (el: HTMLElement) => {
			el.addEventListener("pointerdown", (ev) => {
				ev.preventDefault();
				el.classList.add("is-pressed");
				// A contact is a decision, not a hover preview: the diagnosis's
				// probe found a direct-manipulation pen (no hover) fires
				// pointerenter AT CONTACT, marking whatever pop that opened as
				// hover-opened even though the pen has already landed. Clearing
				// both flags here, rather than waiting for the click that
				// normally does it (below), means the close timer armed by this
				// same press's own pointerleave - or by a click that is late or
				// never arrives at all (pointercancel from tap drift) - has
				// nothing left to close.
				this.sliderFromHover = false;
				this.eraserPopFromHover = false;
			});
			const release = () => el.classList.remove("is-pressed");
			el.addEventListener("pointerup", release);
			el.addEventListener("pointerleave", release);
			el.addEventListener("pointercancel", release);
		};
		noFocus(this.pill);
		this.attachTip(this.pill);
		this.pill.addEventListener("click", (ev) => {
			ev.preventDefault();
			this.setCollapsed(false);
		});
		parent.ownerDocument.addEventListener("pointerdown", this.outsideTap, { capture: true });
		parent.ownerDocument.addEventListener("keydown", this.escapeKey, { capture: true });
		this.el = parent.createDiv({ cls: "handwriting-mobile-tools" });
		// The recording indicator lives HERE, not the status bar: status
		// bars get hidden by themes and snippets, and an indicator nobody
		// can see indicates nothing. The strip is the plugin's own chrome.
		// An INDICATOR, not a button - it appears when recording starts and
		// disappears when recording ends, and does nothing when touched.
		this.recordingDot = this.el.createSpan({
			cls: "handwriting-recording-dot",
			attr: {
				"aria-label":
					"from Alan: records how your pen behaves - nothing from your notes 🙈 press and hold to stop",
			},
		});
		// Obsidian's tooltip machinery answers MOUSE hover only - a hovering
		// pen showed nothing (surface, windows ink). And it was not just the
		// dot: EVERY strip button relied on aria-label, so the whole toolbar
		// explained nothing on hover. One shared tip serves them all now,
		// driven by pointerenter, which every input fires. Text comes from
		// each element's aria-label - one source, editable in one place.
		this.tip = this.el.createDiv({ cls: "handwriting-strip-tip" });
		this.recordingDot.setText("●");
		this.attachTip(this.recordingDot);
		// Touch has no hover and deserves an exit: press and HOLD the dot to
		// stop recording. A hold, not a tap, so a stray finger cannot end a
		// recording someone is mid-way through reproducing a bug for. Runs
		// the real toggle command so every indicator syncs.
		let holdTimer: number | null = null;
		const cancelHold = () => {
			if (holdTimer !== null) window.clearTimeout(holdTimer);
			holdTimer = null;
		};
		this.recordingDot.addEventListener("pointerdown", (ev) => {
			ev.preventDefault();
			cancelHold();
			holdTimer = window.setTimeout(() => {
				holdTimer = null;
				this.host.exec("handwriting:toggle-diagnostics");
			}, 600);
		});
		this.recordingDot.addEventListener("pointerup", cancelHold);
		this.recordingDot.addEventListener("pointerleave", cancelHold);
		this.recordingDot.addEventListener("pointercancel", cancelHold);
		const collapse = this.el.createEl("button", {
			cls: "handwriting-mobile-tool handwriting-tools-collapse",
			attr: { "aria-label": "Collapse pen tools", type: "button" },
		});
		this.collapseBtn = collapse;
		setIcon(collapse, "chevron-right");
		if (!collapse.querySelector("svg")) collapse.setText(">");
		noFocus(collapse);
		this.attachTip(collapse);
		collapse.addEventListener("click", (ev) => {
			ev.preventDefault();
			this.setCollapsed(true);
		});
		for (const spec of BUTTONS) {
			if (spec.startsGroup) {
				this.el.createDiv({ cls: "handwriting-mobile-tools-divider" });
			}
			const b = this.el.createEl("button", {
				cls: "handwriting-mobile-tool",
				attr: { "aria-label": spec.label, type: "button" },
			});
			setIcon(b, spec.icon);
			// If the icon set yields no svg, the button says its initial.
			if (!b.querySelector("svg")) b.setText(spec.glyph);
			noFocus(b);
			b.addEventListener("pointerenter", (ev) => {
				if (ev.pointerType === "touch") return;
				const hoverNib =
					spec.commandId === "handwriting:inline-tool-pen"
						? "pen"
						: spec.commandId === "handwriting:inline-tool-highlighter"
							? "highlighter"
							: null;
				if (hoverNib && spec.isActive?.(this.host)) {
					// A hover is a preview, not a decision: crossing this button on
					// the way to the palette must not close what a CLICK opened.
					// While the palette is up, hover keeps its hands off entirely.
					if (this.colorsOpen) return;
					this.cancelSliderClose();
					if (this.openInkSlider !== hoverNib) {
						this.openInkSlider = hoverNib;
						this.sliderFromHover = true;
						this.refresh();
					}
					return;
				}
				// The eraser has no slot in `hoverNib` - its pop rides
				// `eraserPopClosed`, not `openInkSlider` - so it needs its own
				// preview branch, and MOUSE ONLY (§5p AI CONFIRMED, item 1).
				// Pen is not excluded above, only touch is, so a pen reaches
				// this point too; it is turned away here on purpose. The
				// eraser's tap branch below (already built, ptr !== "mouse")
				// TOGGLES `eraserPopClosed` on every pen/touch press - unlike
				// the nib case above, whose pen branch just confirms the
				// slider open rather than toggling it. Letting pen hover open
				// the pop first would make a real pen tap immediately toggle
				// it straight back shut, silently breaking that already-
				// confirmed pen behaviour.
				if (
					ev.pointerType === "mouse" &&
					spec.commandId === "handwriting:inline-tool-eraser" &&
					spec.isActive?.(this.host)
				) {
					if (this.colorsOpen) return;
					this.cancelSliderClose();
					if (this.eraserPopClosed) {
						this.eraserPopClosed = false;
						this.eraserPopFromHover = true;
						this.refresh();
					}
				}
			});
			b.addEventListener("pointerleave", (ev) => {
				if (ev.pointerType === "touch") return;
				this.scheduleSliderClose();
			});
			b.addEventListener("click", (ev) => {
				ev.preventDefault();
				// A button drawn as unavailable must BE unavailable. Delete,
				// copy, paste, undo and redo dim to 0.35 when their predicate
				// says no, but nothing used to stop the click: the command ran
				// and answered with a toast saying what the dimming had
				// already said - "lasso some ink first" on a button greyed out
				// precisely because there is no selection. Worse, the press
				// animation is suppressed for a dimmed button, so it felt dead
				// and then scolded you.
				//
				// Guarded here rather than with pointer-events: none, which
				// would also take the tooltip away. A disabled control that
				// still explains itself on hover is the more useful one.
				if (!(spec.isEnabled?.(this.host) ?? true)) return;
				// The GoodNotes pattern: tapping the tool you are already
				// holding opens its options instead of re-picking it.
				const nib =
					spec.commandId === "handwriting:inline-tool-pen"
						? "pen"
						: spec.commandId === "handwriting:inline-tool-highlighter"
							? "highlighter"
							: null;
				// A mouse only draws because its owner has no pen, so for
				// them the nib button IS the mode: clicking the active tool
				// hands the mouse back to text. Pen and touch keep the tap
				// (hover already opened the slider for anything that hovers).
				const ptr = ev.pointerType;
				if (nib && spec.isActive?.(this.host) && ptr === "mouse" && this.host.mouseInkOn()) {
					// Clicking the tool you are drawing with hands the mouse
					// back to text. Click it again and it draws again.
					this.host.setMouseInk(false);
					this.openInkSlider = null;
					this.colorsOpen = false;
				} else if (nib && spec.isActive?.(this.host) && ptr === "mouse") {
					// Cold or warm: clicking the ACTIVE tool with a mouse is
					// meaningless for a pen (it is already selected), so it can
					// only mean "give the mouse this tool". Clicking again hands
					// the mouse back - the branch above. The toggle's own toast
					// names the tool picked up.
					//
					// This pair is Alan's rule for every mouse-without-a-pen
					// branch here, not just this one - the eraser's
					// ptr !== "mouse" guard below reads the same way. His
					// words, in order (alan, 2026-09-02): "yes tapping a tool
					// should turn it off", then "yes for mouse users without
					// a pen" - the second sentence scopes the first. Tapping
					// an active tool turns it off for a mouse without a pen;
					// pen and touch keep what they have. A mouse has nothing
					// to put the tool DOWN to; a pen does - putting a tool
					// down means picking the nib back up, and the nib buttons
					// already do that, which is why re-tapping a nib was
					// never allowed to deselect it (alan, 2026-08-31: "the
					// nib buttons pick, they never put down"). Lasso,
					// insert-space and pan need no branch of their own: for a
					// mouse their command is still a plain toggle
					// (toggleTipMode in TipMode.ts), so tapping the active
					// one already lands on off.
					this.host.setMouseInk(true);
					this.openInkSlider = nib;
					this.sliderFromHover = false;
					this.colorsOpen = false;
				} else if (nib && spec.isActive?.(this.host) && ptr === "touch") {
					// Touch has no hover, so the tap is the toggle.
					this.openInkSlider = this.openInkSlider === nib ? null : nib;
					this.sliderFromHover = false;
					// One pop at a time: a size slider sliding out from under
					// the open palette read as the strip coming apart.
					this.colorsOpen = false;
				} else if (nib && spec.isActive?.(this.host)) {
					this.sliderFromHover = false;
					// A pen hovers BEFORE it taps, so hover has already opened
					// the slider; a toggle here would flash it shut under the
					// nib. The tap just makes sure it is open. Re-tapping the
					// tool you already hold RESELECTS it - a deselect-to-pen
					// was tried and unwanted (alan, 2026-08-31): the nib
					// buttons pick, they never put down.
					this.openInkSlider = nib;
					this.colorsOpen = false;
				} else if (
					spec.commandId === "handwriting:inline-tool-eraser" &&
					spec.isActive?.(this.host) &&
					ptr !== "mouse"
				) {
					// Mirrors the nib branches above: pressing the tool you
					// already hold reopens its pop instead of picking it again.
					// The eraser command is a plain toggle in main.ts
					// (on = !getInlineEraserMode()), so without this branch it
					// fell to the generic exec() below on every press and the
					// only way back to the pop once AH's pen-contact close had
					// hidden it was two taps through the OFF->ON edge
					// eraserPopClosed clears on, below (alan, 2026-09-02,
					// design doc 5p). A mouse keeps switching the tool off
					// instead ("mouse sould disable", alan, ~19:52): a mouse
					// only draws because its owner has no pen, so for them the
					// eraser button IS the mode, exactly the reasoning the
					// nibs' ptr === "mouse" branches give above - it falls
					// through to exec() untouched.
					this.eraserPopClosed = this.eraserPopOpen();
					// A tap is a decision, same as the nib branches' own
					// `sliderFromHover = false`: whatever hover was previewing
					// is settled now, so the leave timer must not later undo it.
					this.eraserPopFromHover = false;
					// One pop at a time, same reason as the nib branches.
					this.colorsOpen = false;
				} else if (spec.commandId === "handwriting:ink-color-cycle") {
					// The palette button opens SWATCHES: picking a color you
					// can see beats cycling one you cannot.
					this.colorsOpen = !this.colorsOpen;
					this.openInkSlider = null;
				} else {
					// Selecting a nib leaves its slider OUT: the pointer is
					// already sitting on the button it just clicked, so no
					// pointerenter will ever fire to open it - the slider
					// needed a leave-and-return to appear (glass, 2026-08-31).
					this.openInkSlider = nib;
					this.sliderFromHover = false;
					this.colorsOpen = false;
					// A mouse picking a tool it cannot use means "give the
					// mouse this tool" - nib, eraser, lasso, space or pan
					// alike. Without arming, the mode switched but the mouse
					// still could not use it: a dead-looking button (glass,
					// 2026-08-31). Only on the way IN - clicking an active
					// mode toggles it off, and turning a thing off must not
					// claim the mouse. The exec's own toast names what was
					// picked; the arming is silent beside it.
					const claimsTip =
						nib !== null ||
						spec.commandId === "handwriting:inline-tool-eraser" ||
						spec.commandId === "handwriting:inline-tool-lasso" ||
						spec.commandId === "handwriting:inline-tool-space" ||
						spec.commandId === "handwriting:inline-tool-pan";
					const wasActive = spec.isActive?.(this.host) ?? false;
					this.host.exec(spec.commandId);
					if (claimsTip && !wasActive && ptr === "mouse" && !this.host.mouseInkOn()) {
						// Quietly: the exec above already toasted the tool.
						// One click, one toast (alan, 2026-08-31).
						this.host.armMouseInkQuietly();
					}
				}
				this.refresh();
			});
			this.attachTip(b);
			this.buttons.push({ el: b, spec });
		}
		// Drop-down sliders. No noFocus here: a range input needs its native
		// pointerdown to start a drag on webkit. Focus loss is tolerable for
		// a slider; a slider that will not slide is not.
		// Each slider rides in a pop with a live value readout: on glass
		// without hover there is otherwise NO feedback while dragging.
		const dropSlider = (
			aria: string,
			min: string,
			max: string,
			step: string,
			format: (v: number) => string,
			onValue: (v: number, commit: boolean) => void
		): { pop: HTMLElement; input: HTMLInputElement; val: HTMLElement } => {
			const pop = this.el.createDiv({ cls: "handwriting-slider-pop" });
			// The slot owns the layout (28x104); the input centers inside it,
			// so whatever app.css does to range inputs cannot move the pop.
			const slot = pop.createDiv({ cls: "handwriting-slider-slot" });
			const input = slot.createEl("input", {
				cls: "handwriting-eraser-slider",
				attr: { type: "range", min, max, step, "aria-label": aria },
			});
			const val = pop.createDiv({ cls: "handwriting-slider-val" });
			const show = () => {
				val.setText(format(Number(input.value)));
			};
			input.addEventListener("input", () => {
				show();
				onValue(Number(input.value), false);
			});
			input.addEventListener("change", () => onValue(Number(input.value), true));
			show();
			return { pop, input, val };
		};
		this.slider = dropSlider("Eraser size", "3", "64", "1", (v) => `${v}px`, (v, c) =>
			this.host.setEraserRadiusPx(v, c)
		);
		// The eraser's pop leads with its behavior: Stroke deletes what the
		// ring touches whole, Reticle takes only what it covers. Same
		// setting as the tab, so the two always agree.
		{
			const chips = this.slider.pop.createDiv({ cls: "handwriting-mode-chips" });
			this.slider.pop.insertBefore(chips, this.slider.pop.firstChild);
			const chip = (label: string, whole: boolean): HTMLElement => {
				const el = chips.createEl("button", {
					cls: "handwriting-mode-chip",
					text: label,
					attr: { type: "button" },
				});
				el.addEventListener("pointerdown", (ev) => ev.preventDefault());
				el.addEventListener("click", (ev) => {
					ev.preventDefault();
					this.host.setEraserWholeStroke(whole);
					this.refresh();
				});
				return el;
			};
			this.strokeChip = chip("Stroke", true);
			this.reticleChip = chip("Reticle", false);
		}
		// Bounds are the OLD slider's own multiplier range (0.3-3) times the
		// pen's base width, so dragging to either end of this px slider
		// produces exactly the multiplier the old slider produced at that
		// same end - never a mult outside what clampInkSize already allows.
		// Step 0.1px, not a mechanically converted 0.05 mult (0.11px): the
		// pen's whole range is under 6px, where 0.1px is already a finer
		// grain than the eye can place, and it reads as a round number.
		this.penSlider = dropSlider(
			"Pen size",
			String(multToPx(0.3, DEFAULT_PEN.baseWidth)),
			String(multToPx(3, DEFAULT_PEN.baseWidth)),
			"0.1",
			pxLabel,
			(v, c) => this.host.setInkSizeMult("pen", pxToMult(v, DEFAULT_PEN.baseWidth), c)
		);
		// The highlighter runs a narrower range: its base is already wide,
		// and past 1.5x it stops being a highlighter and starts being paint.
		// Its OWN multiplier bounds (0.25-1.5), not the pen's (0.3-3) - each
		// nib's pixel range is its own base times its own existing range,
		// not one shared range. Step 1px, same grain as the eraser's own
		// integer-px slider, over a 4-24px span wide enough to want it.
		this.hlSlider = dropSlider(
			"Highlighter size",
			String(multToPx(0.25, HIGHLIGHTER_PEN.baseWidth)),
			String(multToPx(1.5, HIGHLIGHTER_PEN.baseWidth)),
			"1",
			pxLabel,
			(v, c) => this.host.setInkSizeMult("highlighter", pxToMult(v, HIGHLIGHTER_PEN.baseWidth), c)
		);
		this.colorPop = this.el.createDiv({ cls: "handwriting-slider-pop handwriting-color-pop" });
		for (const pop of [this.penSlider.pop, this.hlSlider.pop]) {
			pop.addEventListener("pointerenter", (ev: PointerEvent) => {
				if (ev.pointerType !== "touch") this.cancelSliderClose();
			});
			pop.addEventListener("pointerleave", (ev: PointerEvent) => {
				if (ev.pointerType !== "touch") this.scheduleSliderClose();
			});
			// Same rule as the button's `noFocus` pointerdown above: a contact
			// on the pop itself - dragging the slider, tapping a mode chip - is
			// a decision too. Without this, a hover-opened pop still died 300ms
			// after the pen lifted OFF THE SLIDER: this pop's own pointerleave
			// (above) re-armed the close timer, and nothing had told it the
			// preview was over. The native pointerdown the range input needs
			// for its own drag (see dropSlider's comment) bubbles here first.
			pop.addEventListener("pointerdown", (ev: PointerEvent) => {
				if (ev.pointerType !== "touch") this.sliderFromHover = false;
			});
		}
		this.refreshNow();
		this.setCollapsed(collapsedSession);
	}

	private refreshQueued = false;

	/**
	 * Coalesced, off-the-input-handler refresh: pen-up and pen-down call
	 * this from latency-critical handlers, and the body does forced layout
	 * reads (hangUnder measures offsets). One rAF defers the work past the
	 * stroke's frame and collapses bursts into a single pass.
	 */
	refresh(): void {
		if (this.refreshQueued) return;
		this.refreshQueued = true;
		// The strip's own window, so a popout editor ticks on its own frames.
		(this.el.ownerDocument.defaultView ?? window).requestAnimationFrame(() => {
			this.refreshQueued = false;
			this.refreshNow();
		});
	}

	/** The synchronous body; the constructor uses it before first paint. */
	refreshNow(): void {
		this.recordingDot.toggleClass("is-recording", this.host.recordingOn());
		for (const { el, spec } of this.buttons) {
			// The lights follow the TOOL state and nothing else. They used to
			// dim for a text-mode mouse, keyed off the last pointer type seen
			// - but hover events on a Surface arrive mouse-flavoured even
			// from a pen, so the eraser's light died under a hovering pen and
			// came back when the nib touched the editor (glass, 2026-08-31).
			// The mouse is just a pen here; pointer type is not state. isLit
			// (falling back to isActive) rather than isActive alone: a mouse
			// user who just clicked the lit pen button to hand the mouse back
			// to text must see the light go out too (alan, 2026-09-02) - see
			// isLit's doc comment on ButtonSpec for why this is a separate
			// field from the one the click chain below still branches on.
			el.classList.toggle("is-active", (spec.isLit ?? spec.isActive)?.(this.host) ?? false);
			const enabled = spec.isEnabled?.(this.host) ?? true;
			el.classList.toggle("is-disabled", !enabled);
			// The dimming is for eyes only; this is the same fact for anything
			// that cannot see it. aria-disabled rather than the disabled
			// property on purpose: a disabled button is skipped by the
			// keyboard and stops firing hover, and the tooltip explaining WHY
			// it is unavailable is the part worth keeping.
			el.setAttribute("aria-disabled", enabled ? "false" : "true");
			// The palette button answers "which color" by BEING it.
			if (spec.commandId === "handwriting:ink-color-cycle") {
				const hex = this.host.activeColor();
				el.setCssStyles({ color: hex });
				// The tooltip names the color too - "Ink color" told a hover
				// nothing the tinted icon had not already said (alan,
				// 2026-08-31). The label is read at hover time, so keeping
				// the dataset current is all it takes; the sr-only span is
				// the same name for screen readers.
				const name = this.host.palette().find((c) => c.hex.toLowerCase() === hex.toLowerCase())?.name;
				const label = name ? name.charAt(0).toUpperCase() + name.slice(1) : "Ink color";
				if (el.dataset.tipLabel !== label) {
					el.dataset.tipLabel = label;
					const sr = el.querySelector(".handwriting-sr-only");
					if (sr) sr.textContent = label;
				}
			}
		}
		// The collapsed pill wears the tool in hand.
		//
		// It used to be a pen, set once when the strip was built and never
		// touched again, labelled "Pen tools" forever. The pill is what is on
		// screen WHILE YOU WRITE - the strip is collapsed precisely then - so
		// the one moment the active tool matters most was the one moment
		// nothing said what it was, while the open strip goes to real trouble
		// to show it (the palette button is tinted with the live color and
		// names it on hover).
		//
		// Taken from the button that reports itself active rather than from a
		// second switch on the modes: one source of truth, and a tool added to
		// BUTTONS later is carried here without anyone remembering to.
		{
			// Same isLit-falls-back-to-isActive read as the per-button light
			// above (literally the same expression there, so it moves here
			// too): the pill must not keep wearing "Pen" once a mouse click
			// has handed the mouse back to text and no nib is actually
			// inking - it falls through to the generic "Pen tools" default
			// below, same as when eraser/lasso/space/pan all read false.
			const active = this.buttons.find(({ spec }) => (spec.isLit ?? spec.isActive)?.(this.host));
			const icon = active?.spec.icon ?? "pen";
			const label = active ? `${active.spec.label} tools` : "Pen tools";
			if (this.pill.dataset.icon !== icon) {
				this.pill.dataset.icon = icon;
				// setIcon replaces the button's children, which takes the
				// sr-only name attachTip left there with it. Put it back in
				// the same move, or the pill goes quiet for a screen reader
				// the first time the tool changes.
				setIcon(this.pill, icon);
				if (!this.pill.querySelector("svg")) this.pill.setText(active?.spec.glyph ?? "P");
				this.pill.createSpan({ cls: "handwriting-sr-only", text: label });
			}
			// The tooltip reads this, not aria-label: ownName moves the name
			// off the attribute so the tip and the screen reader do not say it
			// twice.
			if (this.pill.dataset.tipLabel !== label) {
				this.pill.dataset.tipLabel = label;
				const sr = this.pill.querySelector(".handwriting-sr-only");
				if (sr) sr.textContent = label;
			}
		}
		// Hang a drop-down under its button, measured live so it survives
		// the strip wrapping on narrow screens.
		const hangUnder = (
			slider: { pop: HTMLElement; input: HTMLInputElement; val: HTMLElement },
			commandId: string,
			show: boolean,
			value: number,
			format: (v: number) => string
		) => {
			slider.pop.toggleClass("is-showing", show);
			if (!show) return;
			slider.input.value = String(value);
			slider.val.setText(format(value));
			const btn = this.buttons.find((b) => b.spec.commandId === commandId)?.el;
			if (btn) {
				// Measured rects, and CENTERED under the button: the offset
				// arithmetic drifted a full button's width in the bottom-left
				// corner (glass, 2026-08-31). The pop is visible by here, so
				// its width is real.
				const stripR = this.el.getBoundingClientRect();
				const btnR = btn.getBoundingClientRect();
				const right = stripR.right - btnR.right + (btnR.width - slider.pop.offsetWidth) / 2;
				slider.pop.setCssStyles({ right: `${Math.max(0, right)}px` });
			}
		};
		const whole = this.host.eraserWholeStroke();
		this.strokeChip.toggleClass("is-current", whole);
		this.reticleChip.toggleClass("is-current", !whole);
		// The strip button's own click handler now resets `eraserPopClosed`
		// too (a re-tap while active toggles it, mirroring the nib
		// branches), but that only covers the strip: the palette command and
		// a hotkey both call `handwriting:inline-tool-eraser` directly
		// (main.ts's `on = !getInlineEraserMode()`, the "inline-tool-eraser"
		// command) without passing through this file at all. The OFF-to-ON
		// edge watched here is what catches those two paths alike; the strip
		// button's own click just gets there first.
		const eraserOn = this.host.eraserOn();
		if (eraserOn && !this.wasEraserOn) {
			this.eraserPopClosed = false;
			// A fresh activation opened this, not a hover in flight - a stale
			// `true` here would let a leave timer from a previous session
			// wrongly close the pop this edge just opened.
			this.eraserPopFromHover = false;
		}
		this.wasEraserOn = eraserOn;
		hangUnder(
			this.slider,
			"handwriting:inline-tool-eraser",
			// The eraser slider rides the MODE, not a toggle, so it was still
			// hanging there when the palette opened next to it. While the
			// palette is up it steps aside; closing the palette brings it
			// straight back, because the mode never changed. eraserPopOpen
			// folds in the same eraserOn()/colorsOpen check plus the one bit
			// closeInkSliders sets to suppress it without touching the mode
			// (hasOpenPop, above; every caller of closeInkSliders - pen
			// contact, an outside tap, Escape - sets it alike now).
			this.eraserPopOpen(),
			this.host.eraserRadiusPx(),
			(v) => `${v}px`
		);
		const nib = this.host.eraserOn() || this.colorsOpen ? null : this.openInkSlider;
		hangUnder(
			this.penSlider,
			"handwriting:inline-tool-pen",
			nib === "pen" && this.host.activeTool() === "pen",
			multToPx(this.host.inkSizeMult("pen"), DEFAULT_PEN.baseWidth),
			pxLabel
		);
		hangUnder(
			this.hlSlider,
			"handwriting:inline-tool-highlighter",
			nib === "highlighter" && this.host.activeTool() === "highlighter",
			multToPx(this.host.inkSizeMult("highlighter"), HIGHLIGHTER_PEN.baseWidth),
			pxLabel
		);
		// Swatches: rebuilt per refresh (the palette is tiny), current color
		// ringed, each executes the existing per-name color command.
		this.colorPop.toggleClass("is-showing", this.colorsOpen);
		if (this.colorsOpen) {
			this.colorPop.empty();
			const current = this.host.activeColor();
			for (const c of this.host.palette()) {
				const sw = this.colorPop.createEl("button", {
					cls: "handwriting-color-swatch",
					attr: { "aria-label": c.name, type: "button" },
				});
				sw.setCssStyles({ backgroundColor: c.hex });
				sw.toggleClass("is-current", c.hex.toLowerCase() === current.toLowerCase());
				sw.addEventListener("pointerdown", (ev) => ev.preventDefault());
				sw.addEventListener("click", (ev) => {
					ev.preventDefault();
					// Not through the per-name commands: those live behind an
					// off-by-default setting, and a palette that only works
					// when a hidden toggle is on is a dead palette.
					this.host.pickColor(c.name, c.hex);
					this.colorsOpen = false;
					this.refresh();
				});
			}
			const btn = this.buttons.find(
				(b) => b.spec.commandId === "handwriting:ink-color-cycle"
			)?.el;
			if (btn) {
				// Measured rects and centered, like the sliders - the offset
				// arithmetic drifted in the bottom-left corner.
				const stripR = this.el.getBoundingClientRect();
				const btnR = btn.getBoundingClientRect();
				const right = stripR.right - btnR.right + (btnR.width - this.colorPop.offsetWidth) / 2;
				this.colorPop.setCssStyles({ right: `${Math.max(0, right)}px` });
			}
		}
	}

	/** Writing started: nib-size drop-downs get out of the way. */
	/** Returns whether anything was actually open; Escape needs to know.
	 * Closes every pop the strip can show, the eraser's included - pen-down,
	 * outsideTap and Escape all route through here now (alan, 2026-09-02:
	 * "you eraser pop should close when pen touches down... we did it for
	 * other tools but never did it for eraser"). There used to be a second
	 * method, `closePops`, that Escape alone called to also take the eraser
	 * pop; once this closed it too, `closePops` had nothing left to add over
	 * this and was removed. */
	closeInkSliders(): boolean {
		if (!this.hasOpenPop()) return false;
		this.openInkSlider = null;
		this.colorsOpen = false;
		// The one bit `eraserPopOpen` checks (below) - set unconditionally,
		// same as the two lines above, rather than gated on `eraserPopOpen()`
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
		this.el.toggleClass("is-inking", on);
		this.pill.toggleClass("is-inking", on);
	}

	/**
	 * Park the strip and its pill in a corner. Both move together: they are
	 * one control in two sizes, and the old classes come off first so a
	 * change cannot leave two corners asserted at once.
	 */
	setCorner(corner: ToolbarCorner): void {
		const stale = allToolbarCornerClasses();
		const want = toolbarCornerClass(corner);
		for (const el of [this.el, this.pill]) {
			for (const c of stale) el.classList.remove(c);
			el.classList.add(want);
		}
		// The chevron points at the corner the strip collapses INTO; a
		// hardwired chevron-right pointed off-screen from a left corner.
		// Emptied FIRST: setIcon does not clear the button, and setCorner
		// runs on every bind, so the chevrons stacked up side by side
		// (glass, 2026-08-31, bottom corners). The tooltip's sr-only name
		// goes back in after the sweep.
		const left = corner.endsWith("left");
		this.collapseBtn.empty();
		setIcon(this.collapseBtn, left ? "chevron-left" : "chevron-right");
		if (!this.collapseBtn.querySelector("svg")) this.collapseBtn.setText(left ? "<" : ">");
		const label = this.collapseBtn.dataset.tipLabel;
		if (label) this.collapseBtn.createSpan({ cls: "handwriting-sr-only", text: label });
	}

	setCollapsed(on: boolean): void {
		collapsedSession = on;
		this.el.toggleClass("is-collapsed", on);
		this.pill.toggleClass("is-showing", on);
	}

	/** Leaving the button or its pop closes the slider, after a beat so
	 * the pointer can travel the gap between them. */
	private scheduleSliderClose(): void {
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

	private tip!: HTMLElement;
	private tipTimer: number | null = null;

	/** OS-style tooltip: a beat of hover shows it, anything else hides it.
	 * Touch is skipped - a tap would flash the tip under the finger while
	 * the button acts, explaining nothing and covering the pops. */
	/**
	 * Obsidian renders its own tooltip from aria-label on MOUSE hover, so
	 * every control showed two bubbles - Obsidian's and ours. The name
	 * moves into a visually-hidden span (screen readers read content), the
	 * attribute goes, and our tip - which also answers PEN hover - is the
	 * only one left.
	 */
	private ownName(el: HTMLElement): void {
		const label = el.getAttribute("aria-label");
		if (!label) return;
		el.removeAttribute("aria-label");
		el.dataset.tipLabel = label;
		el.createSpan({ cls: "handwriting-sr-only", text: label });
	}

	private attachTip(el: HTMLElement): void {
		this.ownName(el);
		const hide = () => {
			if (this.tipTimer !== null) window.clearTimeout(this.tipTimer);
			this.tipTimer = null;
			this.tip.removeClass("is-showing");
		};
		el.addEventListener("pointerenter", (ev: PointerEvent) => {
			if (ev.pointerType === "touch") return;
			hide();
			this.tipTimer = window.setTimeout(() => {
				this.tipTimer = null;
				const text = el.dataset.tipLabel ?? el.getAttribute("aria-label");
				if (!text) return;
				this.tip.setText(text);
				// Aligned to the hovered control and clamped by the tip's
				// MEASURED width - the old guess of 180px let a long label
				// (the recording dot's) run 80px past the strip's edge.
				// Shown first, so the width is real when read.
				this.tip.addClass("is-showing");
				const left = Math.max(
					0,
					Math.min(el.offsetLeft, this.el.offsetWidth - this.tip.offsetWidth)
				);
				this.tip.setCssStyles({ left: `${left}px`, right: "auto" });
			}, 350);
		});
		el.addEventListener("pointerleave", hide);
		el.addEventListener("pointercancel", hide);
		el.addEventListener("pointerdown", hide);
	}

	private cancelSliderClose(): void {
		if (this.sliderHoverTimer !== null) {
			window.clearTimeout(this.sliderHoverTimer);
			this.sliderHoverTimer = null;
		}
	}

	destroy(): void {
		this.cancelSliderClose();
		this.el.ownerDocument.removeEventListener("pointerdown", this.outsideTap, { capture: true });
		this.el.ownerDocument.removeEventListener("keydown", this.escapeKey, { capture: true });
		this.el.remove();
		this.pill.remove();
		this.buttons = [];
	}

	/** Test seam / debugging: the currently open nib slider, if any. */
	get openNibSlider(): "pen" | "highlighter" | null {
		return this.openInkSlider;
	}
}
