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

interface ButtonSpec {
	icon: string;
	/** Two-char fallback shown when the icon set has no such glyph. */
	glyph: string;
	label: string;
	commandId: string;
	/** Marks the button active from current state; omitted = never marked. */
	isActive?: (host: MobileToolsHost) => boolean;
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
	},
	{
		icon: "highlighter",
		glyph: "H",
		label: "Highlighter",
		commandId: "handwriting:inline-tool-highlighter",
		isActive: (h) => tipInks(h) && h.activeTool() === "highlighter",
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

	private pill: HTMLElement;

	/**
	 * The ctor's `parent`, kept by name. Escape's ownership test needs the
	 * pane itself, not just the elements built inside it (§5p): a strip
	 * consumes Escape only when the event's target sits inside its OWN pane,
	 * `this.pane.contains(...)`, never `this.el` alone (the pill and the
	 * strip are both children of it, and so is everything the editor draws).
	 */
	private readonly pane: HTMLElement;

	/** Something open enough that Escape (or a stray tap) should close it. */
	private hasOpenPop(): boolean {
		return this.openInkSlider !== null || this.colorsOpen;
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
				if (!hoverNib || !spec.isActive?.(this.host)) return;
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
		this.penSlider = dropSlider("Pen size", "0.3", "3", "0.05", (v) => `${v.toFixed(2)}x`, (v, c) =>
			this.host.setInkSizeMult("pen", v, c)
		);
		// The highlighter runs a narrower range: its base is already wide,
		// and past 1.5x it stops being a highlighter and starts being paint.
		this.hlSlider = dropSlider(
			"Highlighter size",
			"0.25",
			"1.5",
			"0.05",
			(v) => `${v.toFixed(2)}x`,
			(v, c) => this.host.setInkSizeMult("highlighter", v, c)
		);
		this.colorPop = this.el.createDiv({ cls: "handwriting-slider-pop handwriting-color-pop" });
		for (const pop of [this.penSlider.pop, this.hlSlider.pop]) {
			pop.addEventListener("pointerenter", (ev: PointerEvent) => {
				if (ev.pointerType !== "touch") this.cancelSliderClose();
			});
			pop.addEventListener("pointerleave", (ev: PointerEvent) => {
				if (ev.pointerType !== "touch") this.scheduleSliderClose();
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
			// The mouse is just a pen here; pointer type is not state.
			el.classList.toggle("is-active", spec.isActive?.(this.host) ?? false);
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
			const active = this.buttons.find(({ spec }) => spec.isActive?.(this.host));
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
		hangUnder(
			this.slider,
			"handwriting:inline-tool-eraser",
			// The eraser slider rides the MODE, not a toggle, so it was still
			// hanging there when the palette opened next to it. While the
			// palette is up it steps aside; closing the palette brings it
			// straight back, because the mode never changed.
			this.host.eraserOn() && !this.colorsOpen,
			this.host.eraserRadiusPx(),
			(v) => `${v}px`
		);
		const nib = this.host.eraserOn() || this.colorsOpen ? null : this.openInkSlider;
		hangUnder(
			this.penSlider,
			"handwriting:inline-tool-pen",
			nib === "pen" && this.host.activeTool() === "pen",
			this.host.inkSizeMult("pen"),
			(v) => `${v.toFixed(2)}x`
		);
		hangUnder(
			this.hlSlider,
			"handwriting:inline-tool-highlighter",
			nib === "highlighter" && this.host.activeTool() === "highlighter",
			this.host.inkSizeMult("highlighter"),
			(v) => `${v.toFixed(2)}x`
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
	/** Returns whether anything was actually open; Escape needs to know. */
	closeInkSliders(): boolean {
		if (!this.hasOpenPop()) return false;
		this.openInkSlider = null;
		this.colorsOpen = false;
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
			if (this.openInkSlider !== null && this.sliderFromHover) {
				this.openInkSlider = null;
				this.refresh();
			}
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
