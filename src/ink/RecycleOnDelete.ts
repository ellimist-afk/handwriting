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
import { slidesLockLifted, slidesNoteIdChanged } from "../slides/SlidesPersistence";
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
		// At app start the plugin hears the delete before Obsidian's cache, so
		// the cache still names the note's id. A plugin turned on or updated
		// while Obsidian runs hears it after: the cache answers nothing, and the
		// id is known only if the note owned it in the ledger.
		const freed = this.pageIds.handleDelete(file.path);
		const pageId = this.recentPageIdFor(file) ?? freed[0];
		if (!pageId) {
			// The id is not proven, so its ink file stays. A note locked as a
			// duplicate of the deleted one may be alone on its id now.
			liftLocksLeftAlone(this, file);
			return;
		}
		// A note's frontmatter is free text and can name ANY id. One naming a
		// PDF's - a copied property, a hand edit, a template - meant deleting
		// that NOTE recycled the PDF's ink, taking a document's annotations
		// with a note that never owned them. A note never legitimately holds
		// a pdf id, so this is a refusal, not a heuristic.
		if (isPdfInkId(pageId.toLowerCase())) return; // case-blind: a disk that ignores case finds the PDF's file by a capital name
		// Duplicate guard: if ANOTHER note still carries this id (an
		// unresolved duplicate pair), the sidecar still belongs to a living
		// note. Recycling it now would take that note's ink with this one.
		const carriers = carriersOf(this, pageId, file);
		if (carriers.length === 1) {
			liftSoleCarrier(this, pageId, carriers[0]!);
			return;
		}
		// Two or more notes still carry it: none is the note, so every lock
		// stands and none gets the id. An id nobody owns now is listed as
		// shared, as the census lists its pairs: a note's id line deleted or
		// edited then counts the notes left on it, and one left owns it and
		// is unlocked. Before the census those doors are off and the census
		// lists the id itself; an entry made here would outlive it.
		if (carriers.length > 1) {
			if (this.pageIdWatchReady && this.pageIds.owner(pageId) === undefined) this.ambiguousIds.set(pageId, carriers);
			return;
		}
		this.ambiguousIds.delete(pageId);
		this.scheduleRecycle(pageId, file.path);
	}

	/**
	 * The notes carrying `id` now, read from what each note's frontmatter says.
	 * The deleted file is out of the vault's listing by the time its delete is
	 * heard; it is skipped as a file, not by its path, because a sync's create
	 * at the same path is the note come back and does carry the id.
	 */
	function carriersOf(plugin: HandwritingPlugin, id: string, deleted: TFile): string[] {
		const out: string[] = [];
		for (const f of plugin.app.vault.getMarkdownFiles()) {
			if (f !== deleted && plugin.recentPageIdFor(f) === id) out.push(f.path);
		}
		return out;
	}

	/** The only note left on `id`: it owns the id, and its duplicate lock lifts. */
	function liftSoleCarrier(plugin: HandwritingPlugin, id: string, path: string): void {
		// Not while the id's owner is still in the vault and does not carry the
		// id now: its id line was edited, or emptied on the way to a new value,
		// and that edit's grace has not ended (or a sync batch brought this
		// delete before the edit was heard). The edit decides where the id goes:
		// the owner lets it go once its files have moved, and the notes left on
		// it are counted then (or declaimed, if the line stays empty). Giving
		// this note the id now would leave the owner's files where they are, so
		// the owner opens blank and this note takes its ink. The owner's grace
		// starts here if its change was not heard yet.
		const owner = plugin.pageIds.owner(id);
		if (owner !== undefined && owner !== path) {
			const ownerFile = plugin.app.vault.getFileByPath(owner);
			if (ownerFile && plugin.recentPageIdFor(ownerFile) !== id) {
				plugin.declaimLater(owner);
				return;
			}
		}
		plugin.pageIds.claimOwnership(id, path);
		plugin.ambiguousIds.delete(id);
		// Returns at once while a clear of this note is already reading its
		// file, so a second lift of the same note tells nothing twice.
		// A presentation open on the note is told a lock stood, so its next read is the lift's.
		const wasLocked = inlineInk.isDuplicateLocked(path);
		inlineInk.clearDuplicateLock(path);
		if (wasLocked) slidesLockLifted(path);
		slidesNoteIdChanged(path);
		// Before the census the ledger holds only this session's claims;
		// saving it then would drop every remembered original.
		if (plugin.pageIdWatchReady) plugin.persistOwners();
	}

	/**
	 * A note was deleted whose id cannot be read any more. Whatever it shared
	 * is read from the notes left: no path or id was stored for it, since a
	 * rename, an id edit or a census naming one of three would make that stale.
	 */
	function liftLocksLeftAlone(plugin: HandwritingPlugin, deleted: TFile): void {
		// A pair the census found. The notes left are counted in the vault, not
		// on the census's list: a copy made since carries the id too. One left
		// owns the id; none left, the entry goes, or it blocks later id follows;
		// two or more, every lock stands.
		for (const [aid, paths] of [...plugin.ambiguousIds]) {
			if (!paths.includes(deleted.path)) continue;
			const carriers = carriersOf(plugin, aid, deleted);
			if (carriers.length === 1) liftSoleCarrier(plugin, aid, carriers[0]!);
			else if (carriers.length === 0) plugin.ambiguousIds.delete(aid);
		}
		// A note locked as the copy of an owned note, or the owner locked:
		// it lifts only if no other note carries its id now.
		for (const f of plugin.app.vault.getMarkdownFiles()) {
			if (f === deleted || !inlineInk.isDuplicateLocked(f.path)) continue;
			const id = plugin.recentPageIdFor(f);
			if (id === undefined || isPdfInkId(id.toLowerCase())) continue; // case-blind, as at the delete above
			// The note's id line was edited since its ink was read: following
			// that edit is the declaim's move, not this one's.
			const held = inlineInk.pageIdOf(f.path);
			if (held !== null && held !== id) continue;
			if (carriersOf(plugin, id, deleted).length === 1) liftSoleCarrier(plugin, id, f.path);
		}
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
		// A slow sync can put the note back while its ink file is being
		// moved; it registers, and its owner entry is saved. Ask again: its
		// load takes the ink back from the trash, and it keeps the rest.
		if (this.findOtherCarrier(pageId, "") !== null) return;
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
