/**
 * The page store's removal path: the copy of a page's sidecar for a duplicated note, the drop of a queued save, the recycle of a removed page's files into the trash, and the recycle of a write that failed after its page was removed.
 * They are methods of PageStore, installed on its prototype when PageStore.ts loads.
 */
import { ensureFolder } from "./InkFolder";
import { PageData, parsePage, serializePage } from "../model/PageData";
import { runDetached } from "../util/Detached";
import { installMethods } from "../inline/InstallMethods";
import { contentStamp, folderOf, WRITE_RETRY_MS, type PageStore } from "./PageStore";

declare module "./PageStore" {
	interface PageStore {
		clone(fromId: string, toId: string): Promise<"cloned" | "none" | "unreadable" | "exists">;
		discardPending(pageId: string): void;
		remove(pageId: string): Promise<void>;
		recycleFailedWrite(pageId: string, data: PageData, home: string | undefined, retriesLeft: number, tag?: string): void;
	}
}

/**
 * A note's own paper or canvas choice is content: a file holding only that
 * is recycled like any other page, never deleted, so a note brought back
 * from the trash keeps it. An older build reaches the same answer, because
 * it reads the two fields as unknown top-level ones.
 */
function holdsChoice(page: PageData): boolean {
	return page.noteCanvas !== undefined || page.notePaper !== undefined;
}


	/**
	 * Clone a page's sidecar for note duplication: the COPY note gets an
	 * independent sidecar under its fresh id, the source is never touched.
	 * The pageId inside the payload is re-stamped through the normal
	 * parse/serialize round trip, which preserves unknown fields by
	 * construction. Fails closed: a damaged or newer-format source is not
	 * cloneable (serializing a placeholder would fabricate data), and an
	 * existing destination is never overwritten. Chained on the write queue.
	 *
	 * THE COPY LANDS BESIDE ITS SOURCE. Writing it to the configured folder
	 * forked the duplicate on the spot in the population this release is for: a
	 * device configured for `.handwriting` whose ink is all in `handwriting/`
	 * duplicated a note, wrote `.handwriting/<newId>.json`, and sync - which
	 * ignores dot-folders - carried the new `.md` and its fresh pageId to the
	 * other device but not the ink. That device opened the copy blank and its
	 * first stroke wrote `handwriting/<newId>.json`. Two live sidecars under
	 * one id, from an ordinary duplicate.
	 */
	async function clone(this: PageStore, fromId: string, toId: string): Promise<"cloned" | "none" | "unreadable" | "exists"> {
		const adapter = this.app.vault.adapter;
		let result: "cloned" | "none" | "unreadable" | "exists" = "none";
		const run = async (): Promise<void> => {
			// The SOURCE is wherever the page actually is, and the destination
			// is BESIDE IT: the duplicate belongs to the same family, so it
			// lives in the same folder and reaches (or does not reach) the
			// other devices exactly as its source does.
			const src = await this.resolvePath(fromId);
			if (!(await adapter.exists(src))) {
				result = "none";
				return;
			}
			const home = folderOf(src);
			const dest = this.pathIn(home, toId);
			if (await adapter.exists(dest)) {
				result = "exists";
				return;
			}
			let text: string;
			try {
				text = await adapter.read(src);
			} catch {
				result = "unreadable";
				return;
			}
			const parsed = parsePage(text, fromId);
			if (parsed.damaged || parsed.futureVersion !== undefined) {
				result = "unreadable";
				return;
			}
			const out = serializePage({ ...parsed.data, pageId: toId });
			await ensureFolder(adapter, home);
			const tmp = this.tmpFor(dest);
			await adapter.write(tmp, out);
			await adapter.rename(tmp, dest);
			// The destination id is brand new and the file provably exists at
			// `dest` now, so that is where it lives; record it rather than
			// making the copy's first save look it up again.
			this.resolved.set(toId, dest);
			const st = await adapter.stat(dest).catch(() => null);
			if (st) this.knownMtime.set(toId, st.mtime);
			this.knownHash.set(toId, contentStamp(out));
			result = "cloned";
		};
		// The copy reads one page and writes another: it must not
		// interleave with either page's own writes, so it rides the source
		// tail and the target tail records it too.
		const chained = this.chain(fromId, async () => {
			await run();
		});
		this.tails.set(toId, chained.catch(() => undefined));
		await chained;
		return result;
	}

	/**
	 * Drop a page's queued save without writing it. ONLY safe when the caller
	 * can prove the queued state is orphaned, e.g. it was produced by a note
	 * that has just been re-identified to a different page id and no other
	 * live note writes under this id. Used by duplicate resolution.
	 */
	function discardPending(this: PageStore, pageId: string): void {
		this.pending.delete(pageId);
		this.pendingWriter.delete(pageId);
		this.pendingCovers.delete(pageId);
		this.clearTimers(pageId);
	}

	async function remove(this: PageStore, pageId: string): Promise<void> {
		this.removals.set(pageId, (this.removals.get(pageId) ?? 0) + 1);
		const adapter = this.app.vault.adapter;
		// Captured before it is dropped: a stroke scheduled inside the 700ms
		// debounce (audit-fixes-design.md 5i I1) has not reached disk yet, so
		// it is the ONE copy of itself. It is newer than whatever `final`
		// holds by construction - pending only exists because it postdates
		// the last write - so below it is what gets recycled, not the disk
		// file.
		const queued = this.pending.get(pageId);
		if (queued !== undefined) this.removedWithQueued.set(pageId, this.removals.get(pageId) ?? 0);
		const queuedCovers = this.pendingCovers.get(pageId);
		const carrierWritten = this.carriersWritten.get(pageId);
		this.pending.delete(pageId);
		this.pendingWriter.delete(pageId);
		this.pendingCovers.delete(pageId);
		this.contentCheckedAt.delete(pageId);
		this.observedMissing.delete(pageId);
		// The page is gone; a later page under this id is a different page,
		// and must not be reconciled against a writer that predates it.
		this.lastWriter.delete(pageId);
		this.consumedSeq.delete(pageId);
		// Where it lived goes with it, but the path itself is kept for the
		// recycle below: this method is what makes the file stop being there.
		const pinned = this.resolved.get(pageId);
		this.resolved.delete(pageId);
		// Both are claims about that pin, and the pin is going.
		this.provisional.delete(pageId);
		this.displacedProvisional.delete(pageId);
		this.clearTimers(pageId);
		// Deleting the NOTE is recoverable (Obsidian's trash); deleting the
		// ink outright would not be. Recycle the sidecar instead. A restored
		// note finds its ink waiting in .handwriting/trash/, as its own generation
		// (RC4), so an earlier delete-all copy is never displaced.
		//
		// Chained on the write queue: an unchained remove could race a save
		// mid tmp/rename dance, which would re-create the sidecar right after
		// the recycle moved it: a live ink file for a deleted note.
		const run = async (): Promise<void> => {
			// The stamp of the bytes this session last read or wrote, taken and
			// dropped here, after any save already on its way to disk: that save
			// still checks the live file against them, and without them it took
			// this session's own last file for another device's, a false conflict
			// copy for a note just deleted. With a save queued, the disk file is
			// removed only if it is still exactly those bytes.
			const knownHash = this.knownHash.get(pageId);
			this.knownMtime.delete(pageId);
			this.knownHash.delete(pageId);
			// Declared out here so the scratch-file sweep below names the same
			// file the recycle did, even when the recycle threw.
			let final: string | undefined = pinned;
			let recycled = false;
			try {
				// Wherever the page actually is, like load. Recycling only
				// what the configured folder holds left the real sidecar
				// behind for a vault mid-migration, so a deleted note's ink
				// stayed live under an id nothing carries any more.
				//
				// And the pin is re-proven first, as resolveFor does: it is a
				// hint, and sync can have moved the file since it was made.
				// Trusting it blindly recycled the vanished old path and left
				// the live sidecar untouched, under an id nothing carries.
				// Proven here, inside the queued operation, against the disk
				// at that moment. A page found nowhere keeps its last known
				// home, so a queued payload is recycled beside where it lived.
				if (final === undefined || !(await adapter.exists(final))) {
					const now = await this.findSidecar(pageId);
					if (now.found || final === undefined) final = now.path;
				}
				if (queued !== undefined) {
					// Recycle unless the queued state is PROVABLY empty, same
					// rule as the disk path below. A snapshot straight from
					// memory is never "unreadable", so there is no catch arm
					// to mirror.
					const empty =
						queued.strokes.length === 0 &&
						queued.textBoxes.length === 0 &&
						queued.images.length === 0 &&
						Object.keys(queued.unknownTop).length === 0 &&
						!holdsChoice(queued);
					if (!empty) {
						// Beside the file it replaces, so the generation and
						// the page it came from stay in one folder.
						const home = folderOf(final);
						await ensureFolder(adapter, this.trashDirIn(home));
						await adapter.write(await this.freeTrashPath(pageId, home), serializePage(queued));
					}
					// The disk file is older than the generation just recycled
					// ONLY if it is still the bytes this session last read or
					// wrote. A queued save is exactly what holds the live-reload
					// poll off, so another device's revision can have synced in
					// unseen; deleting it lost that device's strokes.
					// Anything else - another revision, or bytes
					// that cannot be read - goes to the trash as its own
					// generation, tagged so a restore never prefers it.
					if (await adapter.exists(final)) {
						const text = await adapter.read(final).catch(() => null);
						if (text !== null && knownHash !== undefined && contentStamp(text) === knownHash) {
							await adapter.remove(final);
						} else {
							const home = folderOf(final);
							await ensureFolder(adapter, this.trashDirIn(home));
							await adapter.rename(final, await this.freeTrashPath(pageId, home, "external"));
						}
					}
				} else if (await adapter.exists(final)) {
					// Recycle unless the outgoing page is PROVABLY empty.
					// Generational names (RC4) mean an empty page could no
					// longer clobber an earlier copy, but the guard stays on
					// its own merit: recycling emptiness loses nothing and
					// would only litter the trash with useless generations.
					// Anything unreadable IS recycled: damaged bytes may still
					// be recoverable.
					let empty = false;
					try {
						const parsed = parsePage(await adapter.read(final), pageId);
						empty =
							!parsed.damaged &&
							parsed.data.strokes.length === 0 &&
							parsed.data.textBoxes.length === 0 &&
							parsed.data.images.length === 0 &&
							Object.keys(parsed.data.unknownTop).length === 0 &&
							!holdsChoice(parsed.data);
					} catch {
						/* unreadable → recycle it */
					}
					if (empty) {
						await adapter.remove(final);
					} else {
						const home = folderOf(final);
						await ensureFolder(adapter, this.trashDirIn(home));
						// Never a name that already exists: no `remove(dest)`
						// here any more, which is exactly what used to destroy
						// the previous generation.
						await adapter.rename(final, await this.freeTrashPath(pageId, home));
					}
				}
				recycled = true;
			} catch (err) {
				console.error("[handwriting] sidecar recycle failed", pageId, err);
				// The queued state was the only copy of the newest strokes, and
				// it reached neither the trash nor the disk. Queue it again, so
				// the next flush writes it where the page lived, rather than
				// dropping it. A newer schedule wins.
				if (queued !== undefined && !this.pending.has(pageId)) {
					this.pending.set(pageId, queued);
					this.pendingCovers.set(pageId, queuedCovers);
				}
			}
			// The scratch files beside the page's OWN sidecar, not beside a
			// configured path the page may never have used. Only after a
			// recycle that landed: when it failed, the .tmp can be the one
			// copy of the newest strokes.
			//
			// Recycled, not deleted (R1). A .tmp left by a save that never
			// replaced the live file, or a flush carrier whose save never
			// landed - from this session or an earlier one, on a note deleted
			// without being opened - holds ink no other file has. The one
			// exception is judged: a carrier this session wrote whose
			// generation the queued page just recycled above already holds.
			if (final !== undefined && recycled) {
				const home = folderOf(final);
				const tmp = this.tmpFor(final);
				const carrier = this.carrierFor(final);
				try {
					if (await adapter.exists(tmp)) {
						await ensureFolder(adapter, this.trashDirIn(home));
						await adapter.rename(tmp, await this.freeTrashPath(pageId, home, "tmp"));
					}
				} catch (err) {
					console.error("[handwriting] could not recycle an interrupted save", tmp, err);
				}
				// The page is gone, so the name is no longer this store's own.
				// A failed save marked it and only a landed save unmarks it;
				// left marked, a .tmp another device or process leaves at this
				// name later skips the stranded-save guard and is overwritten
				// by the next save to the same id. A .tmp the rename above
				// could not move is then kept as a conflict copy: kept, not lost.
				this.ownTmp.delete(tmp);
				try {
					if (await adapter.exists(carrier)) {
						const covered =
							queued !== undefined &&
							carrierWritten !== undefined &&
							queuedCovers !== undefined &&
							queuedCovers >= carrierWritten;
						if (covered) {
							await adapter.remove(carrier);
						} else {
							await ensureFolder(adapter, this.trashDirIn(home));
							const dest = await this.freeTrashPath(pageId, home, "flush");
							// A recycled generation is a sidecar the user can restore: the
							// carrier's page, not its wrapper. A carrier that does not
							// parse keeps its bytes as they are.
							const parsed = this.parseCarrier(await adapter.read(carrier), pageId);
							if (parsed !== null) {
								await adapter.write(dest, serializePage(parsed.page));
								await adapter.remove(carrier);
							} else {
								await adapter.rename(carrier, dest);
							}
						}
					}
				} catch (err) {
					console.error("[handwriting] could not recycle a background flush", carrier, err);
				}
			}
		};
		await this.chain(pageId, run);
	}

	/**
	 * A write that failed after its page was removed. The only place for its
	 * payload is the trash, as a generation of its own beside the page's last
	 * known home. Never a live file, never `pending`: either one brings a
	 * deleted note's ink file back. Untagged, it is the newest state and a
	 * restored note opens it; with `tag`, the removal recycled a newer queued
	 * state, and the tag keeps a restore from opening this one over it.
	 *
	 * Chained on the page's write queue, so it lands after `remove`'s own
	 * recycle and is the newer generation. The recycle gets the retries the
	 * write had left, at the write's spacing, so a short failure loses no more
	 * than it did when the write retried; after the last, the user is told
	 * once. An empty payload is not written, the same rule as `remove`.
	 */
	function recycleFailedWrite(this: PageStore,
		pageId: string,
		data: PageData,
		home: string | undefined,
		retriesLeft: number,
		tag?: string
	): void {
		const empty =
			data.strokes.length === 0 &&
			data.textBoxes.length === 0 &&
			data.images.length === 0 &&
			Object.keys(data.unknownTop).length === 0 &&
			!holdsChoice(data);
		if (empty) return;
		const adapter = this.app.vault.adapter;
		const run = async (): Promise<void> => {
			let folder = home;
			try {
				if (folder === undefined) folder = folderOf((await this.findSidecar(pageId)).path);
				await ensureFolder(adapter, this.trashDirIn(folder));
				await adapter.write(await this.freeTrashPath(pageId, folder, tag), serializePage(data));
			} catch (err) {
				console.error("[handwriting] recycle of a save that failed after its note was deleted failed", pageId, err);
				if (retriesLeft > 0) {
					window.setTimeout(() => this.recycleFailedWrite(pageId, data, folder, retriesLeft - 1, tag), WRITE_RETRY_MS);
				} else {
					this.onWriteError?.(pageId, String(err));
				}
			}
		};
		runDetached(this.chain(pageId, run), `recycle a save that failed after its note was deleted ${pageId}`);
	}

export function installPageStoreRemove(proto: PageStore): void {
	installMethods(proto, {
		clone,
		discardPending,
		remove,
		recycleFailedWrite,
	});
}
