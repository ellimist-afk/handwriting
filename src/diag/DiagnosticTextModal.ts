import { App, Modal, Notice, Platform } from "obsidian";
import { endRecordingForReport } from "./DiagSwitch";

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
		private readonly text: string,
		/**
		 * When present, the modal offers an Upload button that sends the
		 * text to the developer and resolves to a short receipt id. Only
		 * the replay-JSON command passes this: a report a stranger on an
		 * e-ink tablet can send with ONE tap, because copy-pasting a
		 * megabyte of JSON through a Boox on-screen keyboard is where bug
		 * reports go to die.
		 */
		private readonly upload?: (text: string) => Promise<string>,
		/**
		 * Fired once, on the FIRST successful delivery - copy, save to
		 * vault, or upload. "Delivering the report ends the recording" is
		 * the rule; which door it left through is irrelevant. Failed
		 * attempts never fire it.
		 */
		private readonly onDelivered?: () => void
	) {
		super(app);
	}

	private deliveredOnce = false;

	private delivered(): void {
		if (this.deliveredOnce) return;
		this.deliveredOnce = true;
		this.onDelivered?.();
	}

	/** Set once an upload succeeds; blocks accidental duplicates. */
	private uploadedId: string | null = null;

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass("handwriting-diagnostic-text-modal");
		this.contentEl.createEl("h2", { text: this.heading });
		this.contentEl.createEl("p", {
			text: Platform.isMobileApp
				? this.upload
					? "Tap Copy to paste it into a message, Upload to send it straight to the developer, or Save to vault for a note instead."
					: "Tap Copy, then paste it into a message. Save to vault writes it to a note instead."
				: this.upload
					? "Press Copy, or select the text and Ctrl+C. Upload sends it straight to the developer."
					: "Press Copy, or select the text and press Ctrl+C.",
		});
		// With an Upload button present the reporter's job is one tap; the
		// raw data is a wall of JSON that buries the tap. It collapses behind
		// a toggle - still there for Copy and for anyone who wants to look,
		// no longer the first thing on screen.
		let summary: HTMLElement | null = null;
		if (this.upload) {
			summary = this.contentEl.createEl("p", { cls: "handwriting-diagnostic-summary" });
			try {
				const parsed = JSON.parse(this.text) as {
					events?: Array<{ cs?: unknown[] }>;
				};
				const events = parsed.events?.length ?? 0;
				const samples =
					parsed.events?.reduce((n, e) => n + (Array.isArray(e.cs) ? e.cs.length : 0), 0) ?? 0;
				summary.setText(`${events} events captured, ${samples} pen samples`);
			} catch {
				summary.setText("recording ready");
			}
		}
		const field = this.contentEl.createEl("textarea", {
			cls: "handwriting-diagnostic-text",
			attr: { "aria-label": this.heading },
		});
		field.readOnly = true;
		field.value = this.text;
		if (this.upload) field.addClass("handwriting-diagnostic-collapsed");

		const controls = this.contentEl.createDiv({ cls: "handwriting-diagnostic-text-controls" });
		// A clicked button held keyboard focus, and themes animate the
		// focus ring - the upload button sat there sparkling in a square
		// after every press. Click means done; the ring is for keyboards.
		controls.addEventListener("click", (ev) => {
			(ev.target as HTMLElement | null)?.blur?.();
		});

		if (this.upload) {
			// Primary and FIRST: the whole flow exists for this tap. Copy was
			// wearing the accent while Upload sat third and plain.
			const up = controls.createEl("button", { text: "Upload to developer", cls: "mod-cta" });
			up.addEventListener("click", () => {
				if (this.uploadedId) return; // one recording, one upload
				up.disabled = true;
				up.setText("Uploading…");
				this.upload!(this.text)
					.then((id) => {
						this.uploadedId = id;
						this.delivered();
						up.setText("Uploaded");
						// The id used to live ONLY in a ten-second toast: look
						// away to start writing the report and it was gone,
						// unrecoverable. It lands in the modal now and stays.
						const done = this.contentEl.createDiv({ cls: "handwriting-upload-done" });
						done.createSpan({ text: "id " });
						done.createSpan({ cls: "handwriting-upload-id", text: id });
						summary?.setText("uploaded");
						new Notice(`Handwriting: uploaded - id ${id}`, 10000);
					})
					.catch(() => {
						up.disabled = false;
						up.setText("Upload to developer");
						new Notice("Handwriting: upload failed - Copy or Save to vault instead");
					});
			});
		}

		const copy = controls.createEl("button", { text: "Copy", cls: this.upload ? "" : "mod-cta" });
		copy.addEventListener("click", () => {
			void this.copyToClipboard(field, copy);
		});

		const save = controls.createEl("button", { text: "Save to vault" });
		save.addEventListener("click", () => {
			void this.saveToVault();
		});

		if (this.upload) {
			const details = controls.createEl("button", { text: "Show data" });
			details.addEventListener("click", () => {
				const hidden = field.classList.toggle("handwriting-diagnostic-collapsed");
				details.setText(hidden ? "Show data" : "Hide data");
			});
			this.contentEl.createEl("p", {
				cls: "handwriting-diagnostic-upload-note",
				text:
					"Upload sends this recording - pen coordinates, timing and device info, never your note text - " +
					"to the developer. Copy and Save to vault never touch the network.",
			});
		}

		const close = controls.createEl("button", { text: "Close" });
		close.addEventListener("click", () => this.close());

		// Selecting on open is a desktop convenience; on iOS it summons the
		// selection UI (and sometimes the keyboard) over the buttons the
		// tester is being told to press.
		if (!Platform.isMobileApp && !this.upload) {
			window.setTimeout(() => {
				field.focus();
				field.select();
			}, 0);
		}
	}

	/**
	 * The clipboard write has to happen inside the click handler to count as a
	 * user gesture in WKWebView. When the async API is missing or blocked the
	 * Save to vault button is the fallback; the old execCommand path retired
	 * with the directory review (both real platforms take the API path).
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
				this.delivered();
				return;
			}
		} catch {
			/* fall through to the selection path */
		}
		// No execCommand fallback: it is deprecated, the directory flags
		// it, and both real platforms take the clipboard API path (verified
		// on the ipads 2026-08-26). Anything left over has Save to vault.
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
			this.delivered();
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
	// Every diagnostics report comes through here, so this is the one place
	// that has to end the capture. The text was already gathered above, so
	// what the reader sees is unaffected.
	const stopped = endRecordingForReport();
	new DiagnosticTextModal(app, heading, text).open();
	if (stopped) new Notice("Handwriting: recording stopped");
}
