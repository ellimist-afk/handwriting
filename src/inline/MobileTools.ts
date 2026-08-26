/**
 * The floating tool strip for mobile inline notes.
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
 */

import { setIcon } from "obsidian";

export interface MobileToolsHost {
	/** Execute a command by its full id (e.g. "handwriting:inline-tool-pen"). */
	exec(commandId: string): void;
	/** The active nib: "pen" or "highlighter". */
	activeTool(): string;
	/** Whether eraser mode currently overrides the nib. */
	eraserOn(): boolean;
}

interface ButtonSpec {
	icon: string;
	label: string;
	commandId: string;
	/** Marks the button active from current state; omitted = never marked. */
	isActive?: (host: MobileToolsHost) => boolean;
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
	{ icon: "palette", label: "Ink color", commandId: "handwriting:ink-color-cycle" },
	{ icon: "circle-dot", label: "Ink size", commandId: "handwriting:ink-size-cycle" },
	{ icon: "undo-2", label: "Undo", commandId: "editor:undo" },
	{ icon: "redo-2", label: "Redo", commandId: "editor:redo" },
];

export class MobileTools {
	private el: HTMLElement;
	private buttons: Array<{ el: HTMLElement; spec: ButtonSpec }> = [];

	constructor(parent: HTMLElement, private host: MobileToolsHost) {
		this.el = parent.createDiv({ cls: "handwriting-mobile-tools" });
		for (const spec of BUTTONS) {
			const b = this.el.createEl("button", {
				cls: "handwriting-mobile-tool",
				attr: { "aria-label": spec.label, type: "button" },
			});
			setIcon(b, spec.icon);
			b.addEventListener("click", (ev) => {
				ev.preventDefault();
				this.host.exec(spec.commandId);
				this.refresh();
			});
			this.buttons.push({ el: b, spec });
		}
		this.refresh();
	}

	/** Re-mark active buttons from current state. Cheap; called per tap. */
	refresh(): void {
		for (const { el, spec } of this.buttons) {
			el.classList.toggle("is-active", spec.isActive?.(this.host) ?? false);
		}
	}

	destroy(): void {
		this.el.remove();
		this.buttons = [];
	}
}
