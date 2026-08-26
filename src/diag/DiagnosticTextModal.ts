import { App, Modal, Notice, Platform } from "obsidian";

/**
 * A selectable diagnostics report, with two ways off the device.
 *
 * v0.13.12 and earlier said "the report is selected, press Ctrl+C" and relied
 * on a programmatic `select()` over a read-only textarea. Both halves of that
 * assume a desktop: an iPad has no Ctrl key unless a keyboard case is
 * attached, and iOS doesn't reliably raise its Copy affordance for a selection
 * the page made instead of one the user made. If a remote tester runs every
 * gesture and then can't get the report off the device, the whole session was
 * wasted, so the report leaves by an explicit button now, and by a file in the
 * vault when the clipboard won't play.
 */
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
			text: Platform.isMobileApp
				? "Tap Copy, then paste it into a message. Save to vault writes it to a note instead."
				: "Press Copy, or select the text and press Ctrl+C.",
		});
		const field = this.contentEl.createEl("textarea", {
			cls: "handwriting-diagnostic-text",
			attr: { "aria-label": this.heading },
		});
		field.readOnly = true;
		field.value = this.text;

		const controls = this.contentEl.createDiv({ cls: "handwriting-diagnostic-text-controls" });

		const copy = controls.createEl("button", { text: "Copy", cls: "mod-cta" });
		copy.addEventListener("click", () => {
			void this.copyToClipboard(field, copy);
		});

		const save = controls.createEl("button", { text: "Save to vault" });
		save.addEventListener("click", () => {
			void this.saveToVault();
		});

		const close = controls.createEl("button", { text: "Close" });
		close.addEventListener("click", () => this.close());

		// Selecting on open is a desktop convenience; on iOS it summons the
		// selection UI (and sometimes the keyboard) over the buttons the
		// tester is being told to press.
		if (!Platform.isMobileApp) {
			window.setTimeout(() => {
				field.focus();
				field.select();
			}, 0);
		}
	}

	/**
	 * The clipboard write has to happen inside the click handler to count as a
	 * user gesture in WKWebView. `execCommand` is the fallback for hosts where
	 * the async API is missing or blocked; it is deprecated and still the only
	 * thing that works in some embedded webviews.
	 */
	private async copyToClipboard(
		field: HTMLTextAreaElement,
		button: HTMLButtonElement
	): Promise<void> {
		const done = () => {
			button.setText("Copied");
			window.setTimeout(() => button.setText("Copy"), 1500);
		};
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(this.text);
				done();
				return;
			}
		} catch {
			/* fall through to the selection path */
		}
		try {
			field.readOnly = false;
			field.focus();
			field.setSelectionRange(0, this.text.length);
			const ok = document.execCommand("copy");
			field.readOnly = true;
			if (ok) {
				done();
				return;
			}
		} catch {
			field.readOnly = true;
		}
		new Notice("Could not copy. Use Save to vault instead.", 8000);
	}

	/**
	 * The fallback that cannot fail silently: the report becomes a note. A
	 * tester who can reach their vault can always get the file out, and it
	 * survives the modal being closed by accident.
	 */
	private async saveToVault(): Promise<void> {
		const base = `handwriting-diagnostics-${stamp()}`;
		try {
			let path = `${base}.md`;
			let n = 2;
			while (this.app.vault.getAbstractFileByPath(path)) {
				path = `${base}-${n++}.md`;
			}
			await this.app.vault.create(path, this.text);
			new Notice(`Saved to ${path}`, 8000);
		} catch (err) {
			new Notice(`Could not save the report: ${String(err)}`, 10000);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Filename-safe local timestamp. No colons: they are illegal on Windows. */
function stamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
		`-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
	);
}

export function showDiagnosticText(app: App, heading: string, text: string): void {
	new DiagnosticTextModal(app, heading, text).open();
}
