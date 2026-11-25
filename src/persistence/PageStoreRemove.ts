/**
 * The page store's removal path: the copy of a page's sidecar for a duplicated note, the drop of a queued save, the recycle of a removed page's files into the trash, and the recycle of a write that failed after its page was removed.
 * They are methods of PageStore, installed on its prototype when PageStore.ts loads.
 */
import { ensureFolder } from "./InkFolder";
import { PageData, parsePage, serializePage } from "../model/PageData";
import { runDetached } from "../util/Detached";
import { installMethods } from "../inline/InstallMethods";
import { contentStamp, folderOf, WRITE_MAX_RETRIES, WRITE_RETRY_MS, type PageStore } from "./PageStore";
import { carrierSucceeds } from "./PageStoreLoad";

declare module "./PageStore" {
	interface PageStore {
		clone(fromId: string, toId: string): Promise<"cloned" | "none" | "unreadable" | "exists">;
		discardPending(pageId: string): void;
		remove(pageId: string): Promise<boolean>;
		recycleFailedWrite(pageId: string, data: PageData, home: string | undefined, retriesLeft: number, tag?: string): void;
		dropLiveMoveRetry(pageId: string): void;
		dropLiveMoveRetries(): void;
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
 * Do two pages hold the same content? Both as the store writes a page it has
 * read, so a field a read fills in (a stroke's createdAt, say) compares equal
 * whether or not the page in memory carried it.
 */
function samePage(read: PageData, inMemory: PageData, pageId: string): boolean {
	return serializePage(read) === serializePage(parsePage(serializePage(inMemory), pageId).data);
}

/**
 * The waiting moves (PageStore.liveMoveRetries' `take`) whose move of the live file into the trash landed. A delete
 * that makes a waiting move itself reads its answer here: the move logs a failure and does not throw.
 */
const landedMoves = new WeakSet<() => Promise<void>>();


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

	/**
	 * Recycle a deleted page's files into the trash. True when no live file is left where the page lived. False when
	 * one is: the move of the live file into the trash failed (the store logs that and does not throw), or the page's
	 * newest state is queued again to be written there. A caller that acts on "the file is gone" reads this answer.
	 */
	async function remove(this: PageStore, pageId: string): Promise<boolean> {
		// A move an earlier delete of this page still had to try again is this delete's to make now: no timer makes it.
		// One an earlier delete still ahead on the queue arms after this call is taken in `run`.
		let waiting = this.liveMoveRetries.get(pageId);
		this.dropLiveMoveRetry(pageId);
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
		//
		// The answer: whether no live file is left. Only a recycle that landed sets it true.
		let gone = false;
		const run = async (): Promise<void> => {
			// The stamp of the bytes this session last read or wrote, taken and
			// dropped here, after any save already on its way to disk: that save
			// still checks the live file against them, and without them it took
			// this session's own last file for another device's, a false conflict
			// copy for a note just deleted. With a save queued, the disk file is
			// removed only if it is still exactly those bytes.
			const knownHash = this.knownHash.get(pageId);
			const knownMtime = this.knownMtime.get(pageId);
			this.knownMtime.delete(pageId);
			this.knownHash.delete(pageId);
			// Declared out here so the scratch-file sweep below names the same
			// file the recycle did, even when the recycle threw.
			let final: string | undefined = pinned;
			let recycled = false;
			// Set once the queued page is in the trash or was judged empty: from then on this delete has let go of it.
			let queuedLetGo = false;
			// With no queued page: the live bytes this delete moved to the trash, null when there was no live file, and
			// undefined when they are not known (the read failed). A carrier beside the page is judged against them.
			let liveMoved: string | null | undefined;
			// Every file this delete lets go of is MOVED into the trash first and
			// judged there: the bytes read are the bytes that go. Judged where it
			// lay and then unlinked there, a revision another device synced in
			// between the read and the unlink was the file deleted. Moved first,
			// a revision landing before the move goes with it into the trash and
			// is judged as itself; one landing after it stays live.
			//
			// A judged copy that cannot be removed stays in the trash: kept, not
			// lost.
			const dropJudged = async (path: string): Promise<void> => {
				try {
					await adapter.remove(path);
				} catch (err) {
					console.error("[handwriting] could not remove a judged copy from the trash", path, err);
				}
			};
			// The live file, after the queued page was let go of: the disk file is older than the generation recycled
			// ONLY if it is still the bytes this session last read or wrote. A queued save is exactly what holds the
			// live-reload poll off, so another device's revision can have synced in unseen; deleting it lost that
			// device's strokes. Anything else - another revision, or bytes that cannot be read - stays in the trash as
			// its own generation, tagged so a restore never prefers it.
			const moveLive = async (at: string): Promise<void> => {
				if (!(await adapter.exists(at))) return;
				const home = folderOf(at);
				await ensureFolder(adapter, this.trashDirIn(home));
				const moved = await this.freeTrashPath(pageId, home, "external");
				await adapter.rename(at, moved);
				const text = await adapter.read(moved).catch(() => null);
				if (text !== null && knownHash !== undefined && contentStamp(text) === knownHash) await dropJudged(moved);
			};
			// The scratch files beside the page's OWN sidecar, not beside a configured path the page may never have used.
			// Only after a recycle that landed: when it failed, the .tmp can be the one copy of the newest strokes.
			//
			// Recycled, not deleted (R1). A .tmp left by a save that never replaced the live file, or a flush carrier
			// whose save never landed - from this session or an earlier one, on a note deleted without being opened -
			// holds ink no other file has. The one exception is judged on the moved bytes: a carrier this session wrote
			// whose page is the queued page just recycled above.
			//
			// With no queued page and no live file, the .tmp is what opening the note would have shown: load promotes a
			// .tmp that is this page's own whole page and judges the carrier against it. Moved to the trash as -tmp
			// first and judged there; such a .tmp is then a plain generation, and the carrier is judged against its
			// bytes. An empty one is kept too: removed, a restore would open an older generation, not the empty page
			// opening the note shows. Damaged, unreadable or another page's, it stays -tmp, which a restore never
			// opens, and the carrier is judged as with no file. Only the .tmp beside `at`: one in the other ink folder
			// stays where it is, and load promotes it when the note comes back.
			const recycleScratch = async (at: string): Promise<void> => {
				const home = folderOf(at);
				const tmp = this.tmpFor(at);
				const carrier = this.carrierFor(at);
				// The .tmp's bytes once they are a plain generation; undefined otherwise.
				let tmpOpens: string | undefined;
				try {
					if (await adapter.exists(tmp)) {
						await ensureFolder(adapter, this.trashDirIn(home));
						const moved = await this.freeTrashPath(pageId, home, "tmp");
						await adapter.rename(tmp, moved);
						if (queued === undefined && liveMoved === null) {
							const text = await adapter.read(moved).catch(() => null);
							const parsed = text === null ? null : parsePage(text, pageId);
							if (text !== null && parsed !== null && !parsed.damaged && parsed.data.pageId === pageId) {
								const plain = await this.freeTrashPath(pageId, home);
								await adapter.rename(moved, plain);
								tmpOpens = text;
							}
						}
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
							carrierWritten !== undefined && queuedCovers !== undefined && queuedCovers >= carrierWritten;
						await ensureFolder(adapter, this.trashDirIn(home));
						const dest = await this.freeTrashPath(pageId, home, "flush");
						await adapter.rename(carrier, dest);
						// A recycled generation is a sidecar the user can restore: the
						// carrier's page, not its wrapper, written to a name of its
						// own. The moved bytes are the carrier's only copy until that
						// write lands, so they go only after it: written over them, a
						// write that fails or is cut off (the adapter empties the file
						// first) left neither. A carrier that does not parse keeps its
						// bytes as they are.
						const parsed = this.parseCarrier(await adapter.read(dest), pageId);
						if (parsed !== null && covered && queued !== undefined && samePage(parsed.page, queued, pageId)) {
							await dropJudged(dest);
						} else if (parsed !== null) {
							// With no queued page, judged as load judges it against the live bytes moved above, or the
							// .tmp's when it became a plain generation: where load would open it, its page is the newest
							// plain generation, so a restored note opens what opening the note and then deleting it would
							// have. Otherwise it stays under -flush.
							const base = tmpOpens ?? liveMoved;
							const opens = queued === undefined && base !== undefined && carrierSucceeds(parsed, base, pageId);
							await adapter.write(await this.freeTrashPath(pageId, home, opens ? undefined : "flush"), serializePage(parsed.page));
							await dropJudged(dest);
						}
					}
				} catch (err) {
					console.error("[handwriting] could not recycle a background flush", carrier, err);
				}
			};
			// The queued page is in the trash, or was judged empty, and the live file could not be moved after it: a
			// restored note would open that older file. The move is tried again at the write retry spacing, as many
			// times as a write is, and only while nothing has loaded, scheduled or pinned the page since (each of those
			// drops the try, as a later delete and the plugin's unload do). A try that lands recycles the scratch files
			// as a recycle that landed does. Every try failing leaves the live file where it is, as one failure did.
			//
			// A try moves only the bytes the failed move found (`found`, their stamp, read just after it failed): a
			// revision another device synced in since stays live, as one landing after a move that worked does, and the
			// tries end. A live file a try cannot read is not moved, and that try counts as failed. With `found` unknown
			// (that read failed too), a try moves what is there, as the delete would have: tagged unless it is this
			// session's own last bytes.
			//
			// A delete of the page again while a try waits makes that try itself (`take`), as the delete it takes over
			// would: whatever is live goes, tagged or dropped, never as a page a restore opens over the queued one. A
			// take that fails leaves the tries the entry had left, judged against what that failed move found.
			const stampAt = async (at: string): Promise<string | undefined> => {
				try {
					return contentStamp(await adapter.read(at));
				} catch {
					return undefined;
				}
			};
			const retryMove = (at: string, left: number, found: string | undefined): void => {
				// In landedMoves once the move landed.
				const take = async (): Promise<void> => {
					try {
						await moveLive(at);
					} catch (err) {
						console.error("[handwriting] sidecar recycle failed again", pageId, err);
						if (left > 1) retryMove(at, left - 1, await stampAt(at));
						return;
					}
					landedMoves.add(take);
					await recycleScratch(at);
				};
				const entry = { timer: 0, at, take };
				entry.timer = window.setTimeout(() => {
					const again = async (): Promise<void> => {
						if (this.liveMoveRetries.get(pageId) !== entry) return;
						if (this.pending.has(pageId) || this.resolved.has(pageId)) {
							this.liveMoveRetries.delete(pageId);
							return;
						}
						if (found !== undefined && (await adapter.exists(at))) {
							const now = await stampAt(at);
							if (now === undefined) {
								if (left > 1 && this.liveMoveRetries.get(pageId) === entry) retryMove(at, left - 1, found);
								else if (this.liveMoveRetries.get(pageId) === entry) this.liveMoveRetries.delete(pageId);
								return;
							}
							if (now !== found) {
								if (this.liveMoveRetries.get(pageId) === entry) this.liveMoveRetries.delete(pageId);
								return;
							}
						}
						try {
							await moveLive(at);
						} catch (err) {
							console.error("[handwriting] sidecar recycle failed again", pageId, err);
							if (left > 1 && this.liveMoveRetries.get(pageId) === entry) retryMove(at, left - 1, found);
							else if (this.liveMoveRetries.get(pageId) === entry) this.liveMoveRetries.delete(pageId);
							return;
						}
						if (this.liveMoveRetries.get(pageId) === entry) this.liveMoveRetries.delete(pageId);
						await recycleScratch(at);
					};
					runDetached(this.chain(pageId, again), `move a deleted note's ink file into the trash again ${pageId}`);
				}, WRITE_RETRY_MS);
				this.liveMoveRetries.set(pageId, entry);
			};
			// Armed after this delete was asked for, by an earlier delete that was still ahead of it on the queue.
			const armed = this.liveMoveRetries.get(pageId);
			if (armed !== undefined) {
				this.dropLiveMoveRetry(pageId);
				waiting = armed;
			}
			// Set when this delete made the earlier delete's waiting move: that move recycled the scratch files.
			let took = false;
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
					queuedLetGo = true;
					await moveLive(final);
				} else if (waiting !== undefined && waiting.at === final) {
					// An earlier delete's move of this file still waits: made here, as that try would make it. Filed as a
					// plain generation instead, the older live file was the page a restore opens, over the queued one.
					took = true;
					await waiting.take();
					gone = landedMoves.has(waiting.take);
				} else if (await adapter.exists(final)) {
					// Recycle unless the outgoing page is PROVABLY empty.
					// Generational names (RC4) mean an empty page could no
					// longer clobber an earlier copy, but the guard stays on
					// its own merit: recycling emptiness loses nothing and
					// would only litter the trash with useless generations.
					// Anything unreadable IS recycled: damaged bytes may still
					// be recoverable. An empty page is removed from the trash
					// once it is judged there. A page a newer build wrote is
					// never judged empty: it reads without what this build
					// cannot decode, so it is recycled.
					const home = folderOf(final);
					await ensureFolder(adapter, this.trashDirIn(home));
					// Never a name that already exists: no `remove(dest)`
					// here any more, which is exactly what used to destroy
					// the previous generation.
					const moved = await this.freeTrashPath(pageId, home);
					await adapter.rename(final, moved);
					let empty = false;
					try {
						const text = await adapter.read(moved);
						liveMoved = text;
						const parsed = parsePage(text, pageId);
						empty =
							!parsed.damaged &&
							parsed.futureVersion === undefined &&
							parsed.data.strokes.length === 0 &&
							parsed.data.textBoxes.length === 0 &&
							parsed.data.images.length === 0 &&
							Object.keys(parsed.data.unknownTop).length === 0 &&
							!holdsChoice(parsed.data);
					} catch {
						/* unreadable → recycle it */
					}
					if (empty) await dropJudged(moved);
				} else {
					liveMoved = null;
				}
				if (!took) gone = true;
				recycled = true;
			} catch (err) {
				console.error("[handwriting] sidecar recycle failed", pageId, err);
				// Short of the queued page let go, the live file is as it was: this session's stamps of it go back,
				// unless a read since took new ones. Without them, the next save of the page (a pane come onto it, the
				// queued state put back below) took this session's own file for another device's revision and set it
				// aside as a conflict copy, a second live ink file claiming what this one claims.
				if (!queuedLetGo) {
					if (knownMtime !== undefined && !this.knownMtime.has(pageId)) this.knownMtime.set(pageId, knownMtime);
					if (knownHash !== undefined && !this.knownHash.has(pageId)) this.knownHash.set(pageId, knownHash);
				}
				// The queued state was the only copy of the newest strokes, and
				// it reached neither the trash nor the disk. Queue it again, so
				// the next flush writes it where the page lived, rather than
				// dropping it. A newer schedule wins. Once it is in the trash, or
				// was judged empty, nothing goes back: queued again, the next
				// flush wrote a live file for the deleted note.
				if (queued !== undefined && !queuedLetGo && !this.pending.has(pageId)) {
					this.pending.set(pageId, queued);
					this.pendingCovers.set(pageId, queuedCovers);
				} else if (queuedLetGo && final !== undefined) {
					retryMove(final, WRITE_MAX_RETRIES, await stampAt(final));
				}
			}
			if (final !== undefined && recycled && !took) await recycleScratch(final);
		};
		await this.chain(pageId, run);
		return gone;
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

	/** A delete's move of this page's live file still to be tried again is dropped: the page was loaded, scheduled or deleted again. */
	function dropLiveMoveRetry(this: PageStore, pageId: string): void {
		const entry = this.liveMoveRetries.get(pageId);
		if (entry === undefined) return;
		window.clearTimeout(entry.timer);
		this.liveMoveRetries.delete(pageId);
	}

	/** Every move still to be tried again is dropped, at unload: none runs after the plugin is gone. */
	function dropLiveMoveRetries(this: PageStore): void {
		for (const entry of this.liveMoveRetries.values()) window.clearTimeout(entry.timer);
		this.liveMoveRetries.clear();
	}

export function installPageStoreRemove(proto: PageStore): void {
	installMethods(proto, {
		clone,
		discardPending,
		remove,
		recycleFailedWrite,
		dropLiveMoveRetry,
		dropLiveMoveRetries,
	});
}
