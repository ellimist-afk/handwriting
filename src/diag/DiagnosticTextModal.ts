import { App, Modal } from "obsidian";

/** A selectable diagnostics report. Copying remains the user's normal Ctrl+C. */
export class DiagnosticTextModal extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly text: string
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass("handwriting-diagnostic-text-modal");
		this.contentEl.createEl("h2", { text: this.heading });
		this.contentEl.createEl("p", {
			text: "The report is selected. Press Ctrl+C to copy it.",
		});
		const field = this.contentEl.createEl("textarea", {
			cls: "handwriting-diagnostic-text",
			attr: { "aria-label": this.heading },
		});
		field.readOnly = true;
		field.value = this.text;
		const controls = this.contentEl.createDiv({ cls: "handwriting-diagnostic-text-controls" });
		const close = controls.createEl("button", { text: "Close" });
		close.addEventListener("click", () => this.close());
		window.setTimeout(() => {
			field.focus();
			field.select();
		}, 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export function showDiagnosticText(app: App, heading: string, text: string): void {
	new DiagnosticTextModal(app, heading, text).open();
}
