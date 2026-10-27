/**
 * What happens when a vault file is deleted: a PDF's claim is retired after its grace, and a note's ink is recycled
 * into .handwriting/trash only if the note has not come back by the end of RECYCLE_GRACE_MS. The methods are methods
 * of HandwritingPlugin, installed on its prototype when main.ts loads (installRecycleOnDelete at its bottom). Bodies
 * moved unchanged from main.ts, which imports RECYCLE_GRACE_MS back. This file imports only types from main.
 */
import { TFile, type TAbstractFile } from "obsidian";
import { installMethods } from "../inline/InstallMethods";
import { inlineInk } from "../inline/InkOverlay";
import { isPdfInkId } from "../pdf/PdfIdentity";
import { runDetached } from "../util/Detached";
import { isMarkdownPath, stripMarkdownExtension } from "../util/MarkdownPath";
import type { HandwritingPlugin } from "../main";

declare module "../main" {
	interface HandwritingPlugin {
		onFileDeleted(file: TAbstractFile): Promise<void>;
		scheduleRecycle(pageId: string, deletedPath: string): void;
		recycleIfStillGone(pageId: string, deletedPath: string): Promise<void>;
		stemTwinExists(deletedPath: string): boolean;
	}
}

/**
 * How long a deleted note has to come back before its ink is recycled.
 *
 * Sync tools and git express a rename or a branch switch as delete+create,
 * and the pair can be seconds apart on a slow vault. Long enough to cover
 * that; short enough that a real delete's ink reaches the trash while the
 * user still remembers deleting it. Nothing is destroyed either way - the
 * recycle is a move into .handwriting/trash.
 */
export const RECYCLE_GRACE_MS = 10_000;

	async function onFileDeleted(this: HandwritingPlugin, file: TAbstractFile): Promise<void> {
		if (file instanceof TFile && file.extension === "pdf") {
			this.pdfStore.markDeletedPath(file.path, this.pdfDeleteContext());
			return;
		}
		if (!(file instanceof TFile) || file.extension !== "md") return;
		// The metadata cache is already gone by now, so read the id we stored
		// in settings-free fashion: scan our camera map is not enough, so we
		// simply leave unknown sidecars alone rather than risk deleting data.
		const freed = this.pageIds.handleDelete(file.path);
		const pageId = this.recentPageIdFor(file) ?? freed[0];
		if (!pageId) return;
		// A note's frontmatter is free text and can name ANY id. One naming a
		// PDF's - a copied property, a hand edit, a template - meant deleting
		// that NOTE recycled the PDF's ink, taking a document's annotations
		// with a note that never owned them. A note never legitimately holds
		// a pdf id, so this is a refusal, not a heuristic.
		if (isPdfInkId(pageId)) return;
		// Duplicate guard: if ANOTHER note still carries this id (an
		// unresolved duplicate pair), the sidecar still belongs to a living
		// note. Recycling it now would take that note's ink with this one.
		const survivor = this.findOtherCarrier(pageId, file.path);
		if (survivor) {
			this.pageIds.claimOwnership(pageId, survivor);
			this.ambiguousIds.delete(pageId);
			inlineInk.clearDuplicateLock(survivor);
			this.persistOwners();
			return;
		}
		this.ambiguousIds.delete(pageId);
		this.scheduleRecycle(pageId, file.path);
	}

	/**
	 * Recycle a deleted note's ink, but not yet.
	 *
	 * Obsidian Sync, git and every folder-syncing tool express a rename, a
	 * branch switch or a conflict resolution as DELETE followed by CREATE.
	 * Recycling on the delete therefore took the ink out from under a note
	 * that was about to come straight back - on every device at once, since
	 * every device sees the same pair. The note returns with its page id
	 * intact, finds no sidecar, and opens blank.
	 *
	 * A real delete is still a delete: the ink goes to the trash a few
	 * seconds later. Waiting costs nothing (the sidecar is not in anyone's
	 * way meanwhile) and the failure it prevents is silent.
	 */
	function scheduleRecycle(this: HandwritingPlugin, pageId: string, deletedPath: string): void {
		const existing = this.pendingRecycle.get(pageId);
		if (existing !== undefined) window.clearTimeout(existing.timer);
		this.pendingRecycle.set(pageId, {
			path: deletedPath,
			timer: window.setTimeout(() => {
				this.pendingRecycle.delete(pageId);
				runDetached(this.recycleIfStillGone(pageId, deletedPath), `recycle ink for ${pageId}`);
			}, RECYCLE_GRACE_MS),
		});
	}

	/**
	 * The grace period is over: recycle only if the note really is gone.
	 *
	 * Asked by ID, not by path, because the create half of a sync's
	 * delete+create can land at a DIFFERENT name - that is exactly what a
	 * rename arriving over sync looks like from here.
	 */
	async function recycleIfStillGone(this: HandwritingPlugin, pageId: string, deletedPath: string): Promise<void> {
		// No path is excluded from the search - the deleted one is gone, and
		// any file carrying this id now is the note come back.
		if (this.findOtherCarrier(pageId, "") !== null) return;
		// An encryption plugin turns note.md into note.mdenc: a synced device
		// sees the .md deleted and the other file created, and the id search
		// cannot read an encrypted file. A file at the note's own folder and
		// name with another extension is that note, so its ink stays.
		if (this.stemTwinExists(deletedPath)) return;
		await this.store.remove(pageId);
		delete this.settings.cameras[pageId];
		delete this.settings.pageOwners[pageId];
		this.settingsDirty = true;
		await this.flushSettings();
	}

	/**
	 * Is there a file in the same folder, with the same name and an
	 * extension other than md, as the deleted note? A false yes leaves an
	 * orphaned sidecar, which is recoverable; a false no recycles ink that
	 * belongs to a note still in the vault.
	 */
	function stemTwinExists(this: HandwritingPlugin, deletedPath: string): boolean {
		if (!isMarkdownPath(deletedPath)) return false;
		const stem = stripMarkdownExtension(deletedPath);
		for (const f of this.app.vault.getFiles()) {
			if (f.extension === "md") continue;
			const dot = f.path.lastIndexOf(".");
			if (dot > f.path.lastIndexOf("/") && f.path.slice(0, dot) === stem) return true;
		}
		return false;
	}

export function installRecycleOnDelete(proto: HandwritingPlugin): void {
	installMethods(proto, {
		onFileDeleted,
		scheduleRecycle,
		recycleIfStillGone,
		stemTwinExists,
	});
}
