/**
 * Snips and flatten: the free-path lookup for numbered exports, the snip of note ink or a PDF region to an
 * image file with its embed and backlink put on the clipboard, and the flatten of a PDF with its ink into a copy.
 * The methods are methods of HandwritingPlugin, installed on its prototype when main.ts loads (installSnips at
 * its bottom). Bodies moved unchanged from the class. This file imports only types from main.
 */
import { normalizePath, Notice, TFile } from "obsidian";
import { InkOverlayPlugin } from "../inline/InkOverlay";
import { stripMarkdownExtension } from "../util/MarkdownPath";
import { appendInkToPdf, flattenedPdfPath } from "../ink/InkPdfAppend";
import { createFreshFile } from "./CreateFreshFile";
import { PdfInkController } from "../pdf/PdfInkController";
import { installMethods } from "../inline/InstallMethods";
import type { HandwritingPlugin } from "../main";

declare module "../main" {
	interface HandwritingPlugin {
		firstFreePath(candidate: (n: number) => string): Promise<string>;
		snipBacklink(file: TFile, subpath?: string, alias?: string): string;
		snipNote(file: TFile, overlay: InkOverlayPlugin): Promise<void>;
		snipPdf(file: TFile, controller: PdfInkController): Promise<void>;
		flattenPdf(file: TFile, id: string): Promise<void>;
	}
}

	/**
	 * The first path in a numbered series that nothing occupies yet.
	 * `candidate(1)` is the plain name; the count only shows once it must.
	 *
	 * Asked of the adapter rather than the vault index: a file another
	 * device dropped in through sync exists on disk before the index has
	 * seen it, and the index saying "free" would have this overwrite it.
	 *
	 * This alone does not close the gap between choosing a name and writing
	 * it - two exports started close together can still land on the same
	 * answer. Every write site calls this through `createFreshFile`
	 * (src/export/CreateFreshFile.ts), which re-asks on a create failure
	 * instead of trusting a single answer from here; the guarantee that a
	 * second export does not overwrite the first lives there, not in this
	 * function.
	 */
	async function firstFreePath(this: HandwritingPlugin, candidate: (n: number) => string): Promise<string> {
		for (let n = 1; ; n++) {
			const path = normalizePath(candidate(n));
			if (!(await this.app.vault.adapter.exists(path))) return path;
		}
	}

	/**
	 * The backlink both snips paste under the embed. Obsidian writes it, not
	 * this file: a bare `file.name` gave a second file of that name in another
	 * folder the link. The source path is empty because the paste lands in a
	 * note this code cannot see; linking from the file to itself would collapse
	 * to a self-link. The link is written verbatim. A name holding # ^ [ ] | has
	 * no working link in Obsidian, in either link mode, and Obsidian's own
	 * rename refuses those names, so nothing here tries to rescue one.
	 */
	function snipBacklink(this: HandwritingPlugin, file: TFile, subpath?: string, alias?: string): string {
		return this.app.fileManager.generateMarkdownLink(file, "", subpath, alias);
	}

	/** The note twin of snipPdf: ink on white, counted name, embed copied. */
	async function snipNote(this: HandwritingPlugin, file: TFile, overlay: InkOverlayPlugin): Promise<void> {
		const snip = await overlay.snipSelection();
		if (!snip.ok) {
			new Notice(`Handwriting: ${snip.reason}`);
			return;
		}
		const base = stripMarkdownExtension(file.path);
		// The bytes are already rendered and belong to THIS invocation; the turn
		// below only decides when they are written, never what they are.
		//
		// `copied` starts false rather than true: a chooser that rejects never
		// reaches the clipboard at all, and the failure notice must not then
		// claim an embed is sitting there waiting.
		let copied = false;
		try {
			const { path: out } = await createFreshFile(
				() => this.firstFreePath((n) => `${base}.snip-${n}.png`),
				async (path) => {
					// Built for the destination this turn was actually given. A name
					// predicted before queueing is a name another caller may take.
					const name = path.split("/").pop() ?? path;
					const taken = this.app.metadataCache.getFirstLinkpathDest(name, file.path) !== null;
					const md = `![[${taken ? path : name}]]
${this.snipBacklink(file)}`;
					try {
						// The focused window's clipboard: in a popout the main one refuses (audit 60).
						await (typeof activeWindow === "undefined" ? navigator : activeWindow.navigator).clipboard.writeText(md);
						copied = true;
					} catch {
						copied = false;
					}
					return this.app.vault.createBinary(path, snip.bytes.buffer as ArrayBuffer);
				},
				// One attempt, as this caller always made. The helper's default of
				// eight is for callers with no side effect to repeat; retrying here
				// would ask the clipboard again on every round.
				1
			);
			const name = out.split("/").pop() ?? out;
			new Notice(
				copied
					? `Handwriting: snipped to ${name}; the embed is on your clipboard`
					: `Handwriting: snipped to ${name}; the clipboard refused the embed`
			);
		} catch (e) {
			console.error("[handwriting] snip the selection", e);
			new Notice(
				copied
					? "Handwriting: the snip could not be written; the embed on your clipboard has nowhere to point"
					: "Handwriting: the snip could not be written"
			);
		}
	}

	/**
	 * Write the snip beside its PDF and put the markdown on the clipboard.
	 * The name counts up rather than overwriting: two snips of one figure
	 * are two attempts, and the second should not eat the first.
	 *
	 * The clipboard is written BEFORE the file. Everything the markdown
	 * needs is known once the name is chosen, and on iPadOS the clipboard
	 * only accepts a write while the tap that ran the command is still
	 * fresh; put it after the disk write and it refuses there every time,
	 * with nothing to say why. Should the write then fail, the notice says
	 * so and the embed on the clipboard points at a file that is not there
	 * - visible and recoverable, where the other order was a silent no.
	 *
	 * The embed is the bare name only while the vault has no other file by
	 * that name. Two `intro.pdf` in different folders both snip to
	 * `intro.snip-1.png`, and Obsidian resolves a bare name to whichever it
	 * finds first - the second paper's note would show the first paper's
	 * figure. The full path is unambiguous, so it is used exactly when the
	 * short one is not. The write goes through the vault so the file is
	 * indexed as it lands: an adapter write is invisible to link resolution
	 * until the watcher catches up, and the paste comes sooner than that.
	 */
	async function snipPdf(this: HandwritingPlugin, file: TFile, controller: PdfInkController): Promise<void> {
		const snip = await controller.snipSelection();
		if (!snip.ok) {
			new Notice(`Handwriting: ${snip.reason}`);
			return;
		}
		const base = file.path.replace(/\.pdf$/i, "");
		// The page number and the bytes belong to THIS invocation and are read
		// before the turn, so a snip that waits still describes what it captured.
		let copied = false;
		try {
			const { path: out } = await createFreshFile(
				() => this.firstFreePath((n) => `${base}.snip-${n}.png`),
				async (path) => {
					const name = path.split("/").pop() ?? path;
					const taken = this.app.metadataCache.getFirstLinkpathDest(name, file.path) !== null;
					const md = `![[${taken ? path : name}]]
${this.snipBacklink(file, `#page=${snip.pageNumber}`, `${file.basename} p.${snip.pageNumber}`)}`;
					try {
						// The focused window's clipboard: in a popout the main one refuses (audit 60).
						await (typeof activeWindow === "undefined" ? navigator : activeWindow.navigator).clipboard.writeText(md);
						copied = true;
					} catch {
						copied = false;
					}
					return this.app.vault.createBinary(path, snip.bytes.buffer as ArrayBuffer);
				},
				1
			);
			const name = out.split("/").pop() ?? out;
			new Notice(
				copied
					? `Handwriting: snipped to ${name}; the embed is on your clipboard`
					: `Handwriting: snipped to ${name}; the clipboard refused the embed`
			);
		} catch (e) {
			console.error("[handwriting] snip the selection", e);
			new Notice(
				copied
					? "Handwriting: the snip could not be written; the embed on your clipboard has nowhere to point"
					: "Handwriting: the snip could not be written"
			);
		}
	}

	/**
	 * A copy of this PDF with its ink drawn in.
	 *
	 * A COPY, and the only step that ever puts ink inside a PDF. Everywhere
	 * else the document on disk stays exactly as it arrived and the ink is an
	 * overlay above it - which is why the viewer's thumbnail sidebar shows
	 * clean pages while the main view shows marked-up ones. That difference is
	 * load-bearing rather than cosmetic: inked thumbnails mean the file itself
	 * carries the ink, so this command's output is distinguishable at a glance
	 * from the original it came from. See PAGE_SELECTOR in PdfViewerProbe.
	 *
	 * The bytes are re-read here rather than kept from the open view: sync may
	 * have replaced the document on disk since it was opened, and flattening
	 * onto a stale copy writes a file that matches neither.
	 *
	 * A refusal is shown and nothing is written. `appendInkToPdf` says why in
	 * words, and its reasons are things the reader can act on - an encrypted
	 * document, a format this cannot restate - so they are repeated rather
	 * than flattened into "it did not work".
	 */
	async function flattenPdf(this: HandwritingPlugin, file: TFile, id: string): Promise<void> {
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		const result = appendInkToPdf(
			bytes,
			this.pdfStore.strokes(id),
			this.settings.inkPdfColorMode
		);
		if (!result.ok) {
			new Notice(`Handwriting: this PDF cannot be flattened - ${result.reason}`);
			return;
		}
		// Counted, not overwritten - the snip's bargain, now this one's too:
		// two flattens are two attempts, and the second must not eat the
		// first (alan, 2026-08-30). The plain name goes first; the count only
		// appears once it must.
		const base = flattenedPdfPath(file.path).replace(/\.pdf$/, "");
		const { path: out } = await createFreshFile(
			() => this.firstFreePath((n) => (n === 1 ? `${base}.pdf` : `${base}-${n}.pdf`)),
			(path) => this.app.vault.createBinary(path, result.bytes.buffer as ArrayBuffer)
		);
		new Notice(`Handwriting: exported ${out}`);
	}

export function installSnips(proto: HandwritingPlugin): void {
	installMethods(proto, {
		firstFreePath,
		snipBacklink,
		snipNote,
		snipPdf,
		flattenPdf,
	});
}
