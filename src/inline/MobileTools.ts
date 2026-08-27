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
	/** Whether a lasso selection exists, so copy and trash can dim. */
	hasInkSelection(): boolean;
	/** The active tool's palette, for the swatch pop. */
	palette(): ReadonlyArray<{ name: string; hex: string }>;
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
	/** Whether the color swatch pop is open. */
	private colorsOpen = false;
	private strokeChip!: HTMLElement;
	private reticleChip!: HTMLElement;
	private colorPop!: HTMLElement;

	private pill: HTMLElement;

	constructor(parent: HTMLElement, private host: MobileToolsHost) {
		// The collapsed form: one small pen button that brings the strip back.
		this.pill = parent.createEl("button", {
			cls: "handwriting-pen-pill",
			attr: { "aria-label": "Pen tools", type: "button" },
		});
		setIcon(this.pill, "pen");
		if (!this.pill.querySelector("svg")) this.pill.setText("P");
		// Buttons must not take focus from the editor: undo/redo route to the
		// active editor, and a focus-stealing toolbar makes that a coin flip.
		const noFocus = (el: HTMLElement) =>
			el.addEventListener("pointerdown", (ev) => ev.preventDefault());
		noFocus(this.pill);
		this.pill.addEventListener("click", (ev) => {
			ev.preventDefault();
			this.setCollapsed(false);
		});
		this.el = parent.createDiv({ cls: "handwriting-mobile-tools" });
		const collapse = this.el.createEl("button", {
			cls: "handwriting-mobile-tool handwriting-tools-collapse",
			attr: { "aria-label": "Collapse pen tools", type: "button" },
		});
		setIcon(collapse, "chevron-right");
		if (!collapse.querySelector("svg")) collapse.setText(">");
		noFocus(collapse);
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
			b.addEventListener("click", (ev) => {
				ev.preventDefault();
				// The GoodNotes pattern: tapping the tool you are already
				// holding opens its options instead of re-picking it.
				const nib =
					spec.commandId === "handwriting:inline-tool-pen"
						? "pen"
						: spec.commandId === "handwriting:inline-tool-highlighter"
							? "highlighter"
							: null;
				if (nib && spec.isActive?.(this.host)) {
					this.openInkSlider = this.openInkSlider === nib ? null : nib;
				} else if (spec.commandId === "handwriting:ink-color-cycle") {
					// The palette button opens SWATCHES: picking a color you
					// can see beats cycling one you cannot.
					this.colorsOpen = !this.colorsOpen;
					this.openInkSlider = null;
				} else {
					this.openInkSlider = null;
					this.colorsOpen = false;
					this.host.exec(spec.commandId);
				}
				this.refresh();
			});
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
		for (const { el, spec } of this.buttons) {
			el.classList.toggle("is-active", spec.isActive?.(this.host) ?? false);
			el.classList.toggle("is-disabled", !(spec.isEnabled?.(this.host) ?? true));
			// The palette button answers "which color" by BEING it.
			if (spec.commandId === "handwriting:ink-color-cycle") {
				el.setCssStyles({ color: this.host.activeColor() });
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
				const right = this.el.offsetWidth - btn.offsetLeft - btn.offsetWidth;
				slider.pop.setCssStyles({ right: `${Math.max(0, right - 4)}px` });
			}
		};
		const whole = this.host.eraserWholeStroke();
		this.strokeChip.toggleClass("is-current", whole);
		this.reticleChip.toggleClass("is-current", !whole);
		hangUnder(
			this.slider,
			"handwriting:inline-tool-eraser",
			this.host.eraserOn(),
			this.host.eraserRadiusPx(),
			(v) => `${v}px`
		);
		const nib = this.host.eraserOn() ? null : this.openInkSlider;
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
					this.host.exec(`handwriting:ink-color-${c.name}`);
					this.colorsOpen = false;
					this.refresh();
				});
			}
			const btn = this.buttons.find(
				(b) => b.spec.commandId === "handwriting:ink-color-cycle"
			)?.el;
			if (btn) {
				const right = this.el.offsetWidth - btn.offsetLeft - btn.offsetWidth;
				this.colorPop.setCssStyles({ right: `${Math.max(0, right - 4)}px` });
			}
		}
	}

	/** Writing started: nib-size drop-downs get out of the way. */
	closeInkSliders(): void {
		if (this.openInkSlider === null && !this.colorsOpen) return;
		this.openInkSlider = null;
		this.colorsOpen = false;
		this.refresh();
	}

	/**
	 * The chrome steps aside while the pen is down: anything overlapping a
	 * desynchronized canvas can demote it off the low-latency path, so
	 * during a stroke nothing overlaps it at all. Pure class toggles - no
	 * reads, nothing forced, safe inside the pen-down handler.
	 */
	setInking(on: boolean): void {
		this.el.toggleClass("is-inking", on);
		this.pill.toggleClass("is-inking", on);
	}

	setCollapsed(on: boolean): void {
		collapsedSession = on;
		this.el.toggleClass("is-collapsed", on);
		this.pill.toggleClass("is-showing", on);
	}

	destroy(): void {
		this.el.remove();
		this.pill.remove();
		this.buttons = [];
	}

	/** Test seam / debugging: the currently open nib slider, if any. */
	get openNibSlider(): "pen" | "highlighter" | null {
		return this.openInkSlider;
	}
}
