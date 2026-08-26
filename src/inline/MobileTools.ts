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
	/** Whether lasso mode makes the tip lasso. */
	lassoOn(): boolean;
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
}

interface ButtonSpec {
	icon: string;
	label: string;
	commandId: string;
	/** Marks the button active from current state; omitted = never marked. */
	isActive?: (host: MobileToolsHost) => boolean;
	/** Dims the button when false; omitted = always enabled. */
	isEnabled?: (host: MobileToolsHost) => boolean;
}

const BUTTONS: ButtonSpec[] = [
	{
		icon: "pen",
		label: "Pen",
		commandId: "handwriting:inline-tool-pen",
		isActive: (h) => !h.eraserOn() && h.activeTool() === "pen",
	},
	{
		icon: "highlighter",
		label: "Highlighter",
		commandId: "handwriting:inline-tool-highlighter",
		isActive: (h) => !h.eraserOn() && h.activeTool() === "highlighter",
	},
	{
		icon: "eraser",
		label: "Eraser",
		commandId: "handwriting:inline-tool-eraser",
		isActive: (h) => h.eraserOn(),
	},
	{
		icon: "lasso",
		label: "Lasso",
		commandId: "handwriting:inline-tool-lasso",
		isActive: (h) => h.lassoOn(),
	},
	{
		icon: "trash-2",
		label: "Delete selection",
		commandId: "handwriting:delete-selected-ink",
		isEnabled: (h) => h.hasInkSelection(),
	},
	{
		icon: "copy",
		label: "Copy selected ink",
		commandId: "handwriting:copy-selected-ink",
		isEnabled: (h) => h.hasInkSelection(),
	},
	{
		icon: "clipboard-paste",
		label: "Paste ink",
		commandId: "handwriting:paste-ink",
		isEnabled: (h) => h.canPasteInk(),
	},
	{ icon: "palette", label: "Ink color", commandId: "handwriting:ink-color-cycle" },
	{ icon: "undo-2", label: "Undo", commandId: "editor:undo", isEnabled: (h) => h.canUndo() },
	{ icon: "redo-2", label: "Redo", commandId: "editor:redo", isEnabled: (h) => h.canRedo() },
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

	private pill: HTMLElement;

	constructor(parent: HTMLElement, private host: MobileToolsHost) {
		// The collapsed form: one small pen button that brings the strip back.
		this.pill = parent.createEl("button", {
			cls: "handwriting-pen-pill",
			attr: { "aria-label": "Pen tools", type: "button" },
		});
		setIcon(this.pill, "pen");
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
		noFocus(collapse);
		collapse.addEventListener("click", (ev) => {
			ev.preventDefault();
			this.setCollapsed(true);
		});
		for (const spec of BUTTONS) {
			const b = this.el.createEl("button", {
				cls: "handwriting-mobile-tool",
				attr: { "aria-label": spec.label, type: "button" },
			});
			setIcon(b, spec.icon);
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
				} else {
					this.openInkSlider = null;
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
			const input = pop.createEl("input", {
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
		this.refresh();
		this.setCollapsed(collapsedSession);
	}

	/** Re-mark active buttons, tint the color button, show/size the slider. */
	refresh(): void {
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
	}

	/** Writing started: nib-size drop-downs get out of the way. */
	closeInkSliders(): void {
		if (this.openInkSlider === null) return;
		this.openInkSlider = null;
		this.refresh();
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
