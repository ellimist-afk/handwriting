/**
 * The export, PDF and selection commands: the exports, the PDF ink commands, the selection commands and the delete-all
 * commands, in the order registerCommands registered them. registerExportSelectionCommands is a method of
 * HandwritingPlugin, installed on its prototype when main.ts loads and called once from registerCommands at the point
 * the registrations held before. Body moved unchanged.
 */
import { installMethods } from "../inline/InstallMethods";
import { Notice } from "obsidian";
import { copySelectionNotice, copySelectionNoticeIsRoutine, cutSelectionNotice, cutSelectionNoticeIsRoutine, inlineInk } from "../inline/InkOverlay";
import { lassoDeleteNotice } from "../inline/InlineSelectionDelete";
import { stripMarkdownExtension } from "../util/MarkdownPath";
import { routineNoticesVisible } from "../diag/RoutineNotices";
import { inkToSvg } from "../ink/SvgExport";
import { inkToPdf } from "../ink/InkPdf";
import { bytesOf } from "../pdf/PdfSyntax";
import { createFreshFile } from "../export/CreateFreshFile";
import { clipboardSize } from "../inline/InkClipboard";
import { runDetached } from "../util/Detached";
import { ConfirmDeleteInkModal } from "../ink/DeleteAllInk";
import type { HandwritingPlugin } from "../main";

declare module "../main" {
	interface HandwritingPlugin {
		registerExportSelectionCommands(): void;
	}
}

	function registerExportSelectionCommands(this: HandwritingPlugin): void {
		// Delete all ink on the active note: explicit, and recoverable three
		// ways. The confirm dialog in front, a .handwriting/trash/ copy made FIRST,
		// and one Ctrl+Z (a single history entry) while the session lives.
		// Export: the ink's first existence outside the plugin. Same geometry
		// as the committed layer, written as an .svg BESIDE the note so vault
		// search and sync treat it as an ordinary attachment.
		this.addCommand({
			id: "export-ink-svg",
			// Named for what it is. "Export this note's ink as SVG" reads as a
			// page export to anyone not thinking about the distinction, and what
			// comes out is the drawing alone, cropped to itself, on no background.
			name: "Export ink as SVG (drawing only)",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const strokes = file ? inlineInk.strokes(file.path) : undefined;
				if (!file || file.extension !== "md" || !strokes?.some((stroke) => stroke.points.length > 0)) {
					return false;
				}
				if (!checking) {
					const svg = inkToSvg(strokes);
					if (!svg) {
						new Notice("Handwriting: no ink to export on this note");
						return true;
					}
					// Counted like the snip and the flatten: two exports are two
					// attempts, and the second must not eat the first.
					const svgBase = stripMarkdownExtension(file.path) + ".ink";
					runDetached(
						createFreshFile(
							() => this.firstFreePath((n) => (n === 1 ? `${svgBase}.svg` : `${svgBase}-${n}.svg`)),
							(path) => this.app.vault.create(path, svg)
						).then(({ path: out }) => {
							new Notice(`Handwriting: exported ${out}`);
						}),
						"export ink as svg",
						() => new Notice("Handwriting: the SVG export could not be written")
					);
				}
				return true;
			},
		});
		// The same export as a PDF, for the places that will not take an SVG -
		// which is most of them outside a browser. ONE page, sized to the ink:
		// a PDF page may be any size up to 200 inches, so the drawing never
		// has to be cut into pieces or clipped to a paper size it was never
		// drawn for. That sidesteps both failures of printing through the
		// reading view.
		//
		// Ink only, and the name says so. Text would need a font embedded in
		// the file, which needs a subsetter, which is its own project; the
		// SVG export has the same problem and degrades to substitution rather
		// than failure. See pdf-plan.md, P2.
		this.addCommand({
			id: "export-ink-pdf",
			name: "Export ink as PDF (drawing only)",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const strokes = file ? inlineInk.strokes(file.path) : undefined;
				if (!file || file.extension !== "md" || !strokes?.some((stroke) => stroke.points.length > 0)) {
					return false;
				}
				if (!checking) {
					const pdf = inkToPdf(strokes);
					if (!pdf) {
						new Notice("Handwriting: no ink to export on this note");
						return true;
					}
					// Beside the note, like the SVG, and counted like every
					// other export now: the second must not eat the first.
					const pdfBase = stripMarkdownExtension(file.path) + ".ink";
					runDetached(
						createFreshFile(
							() => this.firstFreePath((n) => (n === 1 ? `${pdfBase}.pdf` : `${pdfBase}-${n}.pdf`)),
							(path) => this.app.vault.createBinary(path, bytesOf(pdf).buffer as ArrayBuffer)
						).then(({ path: out }) => {
							new Notice(`Handwriting: exported ${out}`);
						}),
						"export ink as pdf",
						() => new Notice("Handwriting: the PDF export could not be written")
					);
				}
				return true;
			},
		});
		// Flatten: the same idea for a PDF, and the thing that makes ink on
		// one a feature rather than a private note to self. A document
		// annotated here is trapped here - copy the file anywhere and the
		// marks are gone, because they live in a sidecar. This writes a copy
		// with the ink drawn into the page, which anybody can open.
		this.addCommand({
			id: "flatten-pdf-ink",
			name: "Flatten ink into a copy of this PDF",
			checkCallback: (checking) => {
				// Listed on every pdf, the lesson the wipe command already
				// carries: a command hidden by a has-ink gate reads as "does
				// not exist" to someone searching for it - and it did, on the
				// first fresh vault anyone tried (emulation, 2026-08-30).
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension.toLowerCase() !== "pdf") return false;
				if (!checking) {
					const id = this.pdfIdForPath(file.path);
					if (!id) {
						new Notice("Handwriting: still identifying this PDF - try again in a moment");
						return true;
					}
					if (this.pdfStore.strokes(id).length === 0) {
						new Notice("Handwriting: no ink on this PDF to flatten");
						return true;
					}
					runDetached(
						this.flattenPdf(file, id),
						"flatten pdf ink",
						() => new Notice("Handwriting: the flattened PDF could not be written")
					);
				}
				return true;
			},
		});
		// Snip: the selected region leaves the PDF as an image a note can
		// hold. The lasso already marks the box; this renders page and ink
		// inside it to a PNG beside the PDF and puts the embed markdown on
		// the clipboard, with a link back to the page it came from - so the
		// figure lands in a note still knowing where it lives.
		this.addCommand({
			id: "snip-pdf-selection",
			name: "Snip the selection to an image",
			checkCallback: (checking) => {
				// One command, both surfaces: a snip is a snip whether the
				// lasso was drawn on a pdf page or a note.
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (file.extension.toLowerCase() === "pdf") {
					// Listed whenever a pdf is open, the flatten command's own
					// lesson: a command hidden by a has-selection gate reads
					// as "does not exist" to the person searching for it - and
					// it did, on the first pdf anyone tried to snip from the
					// palette. No selection is an ANSWER, not an absence.
					const controller = this.pdfControllerWithSelection(file.path);
					if (!checking && !controller) {
						new Notice("Handwriting: lasso the ink to snip first");
						return true;
					}
					if (!checking && controller) {
						runDetached(
							this.snipPdf(file, controller),
							"snip the selection",
							() => new Notice("Handwriting: the snip could not be written")
						);
					}
					return true;
				}
				if (file.extension === "md") {
					const surface = this.activeInkSurface();
					const overlay = surface?.kind === "inline" ? surface.overlay : null;
					if (!overlay) return false;
					if (!checking && !overlay.hasSelection) {
						new Notice("Handwriting: lasso the ink to snip first");
						return true;
					}
					if (!checking && overlay.hasSelection) {
						runDetached(
							this.snipNote(file, overlay),
							"snip the selection",
							() => new Notice("Handwriting: the snip could not be written")
						);
					}
					return true;
				}
				return false;
			},
		});
		// The pdf twin of "Delete all ink on this note", for the same reason
		// that one exists: erasing a document's worth of test scribbles one
		// lasso at a time is how ink never gets cleaned up at all.
		this.addCommand({
			id: "delete-all-pdf-ink",
			name: "Delete all ink on this PDF",
			checkCallback: (checking) => {
				// Listed on every pdf, like the note command on every note: a
				// command hidden by a has-ink gate reads as "does not exist"
				// to someone searching for it.
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension.toLowerCase() !== "pdf") return false;
				if (!checking) {
					const id = this.pdfIdForPath(file.path);
					if (!id) {
						new Notice("Handwriting: still identifying this PDF - try again in a moment");
					} else {
						const count = this.pdfStore.strokes(id).length;
						if (count === 0) new Notice("Handwriting: no ink on this PDF");
						else {
							new ConfirmDeleteInkModal(this.app, count, "PDF", () => {
								runDetached(this.deleteAllPdfInk(id), `delete all ink on ${file.path}`);
							}, () => this.store.trashFolderFor(id)).open();
						}
					}
				}
				return true;
			},
		});
		// Copy/paste ink, across notes too. The clipboard is the session's,
		// never the system's: note-space coordinates mean nothing to other
		// applications (the SVG export is for leaving the vault).
		this.addCommand({
			id: "delete-selected-ink",
			name: "Lasso: delete selection",
			checkCallback: (checking) => {
				const surface = this.activeInkSurface();
				if (!surface) return false;
				if (!checking) {
					if (surface.kind === "inline") {
						// Two different failures, two different sentences; see
						// `lassoDeleteNotice`, which owns both strings so they are
						// pinned by execution rather than by reading this file.
						const said = lassoDeleteNotice(surface.overlay.deleteSelectedInk());
						if (said) new Notice(said);
					} else {
						// Notifies itself: an unidentified PDF and an empty
						// lasso both stop a delete, and only the controller
						// knows which (audit doc §5k/AD4).
						surface.controller.deleteSelectionCommand();
					}
				}
				return true;
			},
		});
		this.addCommand({
			id: "copy-selected-ink",
			name: "Lasso: copy selection",
			checkCallback: (checking) => {
				const surface = this.activeInkSurface();
				if (!surface) return false;
				if (!checking) {
					if (surface.kind === "inline") {
						// One owner for both sentences; see `copySelectionNotice`.
						// The strings are unchanged - this moved where they live so
						// the strip button cannot drift from the command.
						// The copy itself runs either way; only the success sentence is routine.
						const copied = surface.overlay.copySelectedInk();
						if (routineNoticesVisible() || !copySelectionNoticeIsRoutine(copied))
							new Notice(copySelectionNotice(copied));
					} else {
						// Notifies itself, all three outcomes.
						surface.controller.copySelection();
					}
				}
				return true;
			},
		});
		this.addCommand({
			id: "cut-selected-ink",
			name: "Lasso: cut selection",
			checkCallback: (checking) => {
				const surface = this.activeInkSurface();
				if (!surface) return false;
				if (!checking) {
					if (surface.kind === "inline") {
						// Three outcomes, not two; see `cutSelectionNotice`,
						// which owns all three sentences so they are pinned by
						// execution rather than by reading this file.
						const outcome = surface.overlay.cutSelectedInk();
						if (routineNoticesVisible() || !cutSelectionNoticeIsRoutine(outcome))
							new Notice(cutSelectionNotice(outcome));
					} else {
						// Notifies itself, for the same reason delete does.
						surface.controller.cutSelectionCommand();
					}
				}
				return true;
			},
		});
		this.addCommand({
			id: "paste-ink",
			name: "Lasso: paste",
			checkCallback: (checking) => {
				// Listed whenever a note or PDF is open: a paste hidden by an
				// empty clipboard reads as broken, and the empty case can just
				// say so.
				const surface = this.activeInkSurface();
				if (!surface) return false;
				// Not offered until the document has an id, audit doc §5k/AD4:
				// syncPdfControllers inserts the controller before resolvePdfId
				// finishes, so the command listed itself in that window and
				// then pasted nothing, in silence.
				if (surface.kind === "pdf" && !surface.controller.identified) return false;
				if (!checking) {
					if (clipboardSize() === 0) {
						new Notice("Handwriting: the ink clipboard is empty, copy selected ink first");
					} else if (surface.kind === "inline") {
						const n = surface.overlay.pasteInkHere();
						if (n > 0 && routineNoticesVisible()) new Notice(`Handwriting: pasted ${n} stroke(s)`);
					} else {
						// Notifies itself (success, or the note-ink-on-a-pdf refusal).
						surface.controller.pasteFromClipboard();
					}
				}
				return true;
			},
		});
		this.addCommand({
			id: "delete-all-ink",
			name: "Delete all ink on this note",
			checkCallback: (checking) => {
				// Listed on every note: a command hidden by a hasInk gate
				// reads as "does not exist" to someone searching for it.
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) {
					const surface = this.activeInkSurface();
					this.deleteAllInkOrSaySo(file.path, surface?.kind === "inline" ? surface.overlay : null);
				}
				return true;
			},
		});
		this.addCommand({
			id: "check-split-ink",
			name: "Check for ink split across folders",
			callback: () => {
				void this.reportSplitInk();
			},
		});
	}

export function installRegisterExportCommands(proto: HandwritingPlugin): void {
	installMethods(proto, {
		registerExportSelectionCommands,
	});
}
