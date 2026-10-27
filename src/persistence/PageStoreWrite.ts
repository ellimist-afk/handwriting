/**
 * The page store's write path: the queued write, its in-flight retry loop, the writer registry and the conflict paths.
 * They are methods of PageStore, installed on its prototype when PageStore.ts loads.
 */
import { ensureFolder } from "./InkFolder";
import { PageData, parsePage, serializePageSlicedStamped } from "../model/PageData";
import { mergePages } from "./PageMerge";
import { runDetached } from "../util/Detached";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { scrollProbeSave } from "../inline/ScrollProbe";
import { installMethods } from "../inline/InstallMethods";
import { beginContentStamp, contentStampSliced, folderOf, MAX_DIRTY_MS, type PageWriter, recoverExactPage, stripJson, WRITE_MAX_RETRIES, WRITE_RETRY_MS, type PageStore } from "./PageStore";

declare module "./PageStore" {
	interface PageStore {
		writeVerified(pageId: string, path: string, text: string, exact?: PageData): Promise<void>;
		penPause(yieldToPen: boolean, pageId: string): () => Promise<void>;
		writePending(pageId: string, yieldToPen?: boolean): Promise<void>;
		retireWriter(writer: PageWriter): void;
		reconcileInProcess(pageId: string, data: PageData, writer: PageWriter | undefined, final: string): Promise<PageData>;
		writeNow(pageId: string, data: PageData, writer?: PageWriter, coversCarrier?: number, seq?: number, yieldToPen?: boolean): Promise<void>;
		writeNowInFlight(flight: { stamp: string | null }, pageId: string, data: PageData, writer?: PageWriter, coversCarrier?: number, seq?: number, yieldToPen?: boolean): Promise<void>;
		absorbProvisional(pageId: string, final: string): Promise<void>;
		freeConflictPath(final: string, mtime: number): Promise<string>;
	}
}

/**
 * The carrier generation a payload put back into `pending` holds: its own, or the generation of a carrier a background
 * flush wrote from this very payload while it was in flight (carriedInFlight), whichever is newer.
 */
function coversWithCarried(store: PageStore, pageId: string, data: PageData, coversCarrier: number | undefined): number | undefined {
	const carried = store.carriedInFlight.get(pageId);
	if (carried === undefined || carried.data !== data) return coversCarrier;
	return coversCarrier === undefined ? carried.generation : Math.max(coversCarrier, carried.generation);
}

/** A turn of the event loop: input, frames and timers queued meanwhile run first. */
const nextTask = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 0));


	/**
	 * ADAPTER-LEVEL DURABILITY, and exactly no more than that. The write is
	 * awaited, the bytes are read back and compared exactly, and the result is
	 * parsed on its own - so an artifact that exists is known to be complete
	 * and independently recoverable.
	 *
	 * It does NOT certify fsync, power loss or real-device durability. No such
	 * primitive is exposed here, and a stronger claim would be a lie told about
	 * the one thing a user would rely on.
	 */
	async function writeVerified(this: PageStore,
		pageId: string,
		path: string,
		text: string,
		exact?: PageData
	): Promise<void> {
		const adapter = this.app.vault.adapter;
		await adapter.write(path, text);
		const back = await adapter.read(path);
		if (back !== text) {
			throw new Error(`Handwriting: the recovery copy at ${path} did not read back identical`);
		}
		const parsed = parsePage(back, pageId);
		if (parsed.damaged) {
			throw new Error(`Handwriting: the recovery copy at ${path} does not parse on its own`);
		}
		// PARSED SEMANTIC EQUALITY TO THE IMMUTABLE CAPTURE, for the outgoing
		// leg. Byte-identical readback proves the bytes landed; it says nothing
		// about whether those bytes still describe what was captured, because
		// the bytes were already rounded before the comparison began. Reopening
		// the artifact and comparing the recovered capture is the check that
		// actually asserts the guarantee this artifact exists to make.
		if (exact !== undefined) {
			const recovered = recoverExactPage(parsed.data);
			if (JSON.stringify(recovered) !== JSON.stringify(exact)) {
				throw new Error(
					`Handwriting: the recovery copy at ${path} did not reopen with the ink that was captured`
				);
			}
		}
	}

	/**
	 * Between two slices of a save's serialization (serializePageSliced): a turn of the event loop, so a pen-down that
	 * arrives is handled within one slice. A timer's save (`yieldToPen`) then waits while a pen is down and goes on in a
	 * task after the last lift, after the lift's own handlers. Every other save (a flush, a capped write, a page switch)
	 * never waits. The wait has the bound's ceiling: MAX_DIRTY_MS after the save first waits it stops checking the pen,
	 * as the cap does, so a lift that never arrives does not hold the page. A flush, flushPage or keepAsideUnder of the
	 * page wakes it at once, and it goes on with the pen still down (see beginFlush).
	 */
	function penPause(this: PageStore, yieldToPen: boolean, pageId: string): () => Promise<void> {
		let until = 0;
		// `??=`: a unit rig built with Object.create never runs the field initialisers.
		const parked = (this.parked ??= new Set());
		return async () => {
			await nextTask();
			while (yieldToPen && !this.flushingPage(pageId) && (this.pensDown?.size ?? 0) > 0) {
				const now = Date.now();
				if (until === 0) until = now + MAX_DIRTY_MS;
				if (now >= until) return;
				await new Promise<void>((resolve) => {
					const wake = (): void => {
						window.clearTimeout(timer);
						parked.delete(wake);
						resolve();
					};
					const timer = window.setTimeout(wake, until - now);
					parked.add(wake);
				});
				await nextTask();
			}
		};
	}

	/** `yieldToPen`: a timer's save, whose serialization waits for a pen to lift (see penPause). */
	async function writePending(this: PageStore, pageId: string, yieldToPen = false): Promise<void> {
		const data = this.pending.get(pageId);
		if (!data) return;
		const writer = this.pendingWriter.get(pageId);
		// Stamped as it is consumed: anything this writer consumed before it is
		// now older, whether it is still waiting its turn or already in flight.
		const seq = ++this.consumeSeq;
		let byWriter = this.consumedSeq.get(pageId);
		if (byWriter === undefined) {
			byWriter = new Map();
			this.consumedSeq.set(pageId, byWriter);
		}
		byWriter.set(writer, seq);
		// Claimed BEFORE the batch is consumed and before any await, so this
		// page is never observably quiet while its ink is only in memory - not
		// during the write, and not while this attempt waits its turn in the
		// page chain. See outstandingWrites.
		this.beginOutstandingWrite(pageId);
		try {
			// The carrier generation this snapshot holds travels with it, from
			// when it entered `pending`. Reading `carriersWritten` here instead
			// let a requeued older snapshot claim a newer snapshot's carrier.
			const covers = this.pendingCovers.get(pageId);
			this.pending.delete(pageId);
			this.pendingWriter.delete(pageId);
			this.pendingCovers.delete(pageId);
			this.clearTimers(pageId); // the batch is consumed, both timers with it
			// Held for `load` until the attempt ends; see inFlight.
			let attempts = this.inFlight.get(pageId);
			if (!attempts) {
				attempts = [];
				this.inFlight.set(pageId, attempts);
			}
			attempts.push({ seq, data });
			// Serialize writes so two saves for the same page can't interleave
			// their tmp/rename dance.
			await this.chain(pageId, () => this.writeNow(pageId, data, writer, covers, seq, yieldToPen));
		} finally {
			// Every outcome, including a throw: a leaked claim would block this
			// page's live reload for the rest of the session. A failed write
			// has already put the batch back in `pending` by now, so the guard
			// is continuous across the handover.
			this.endOutstandingWrite(pageId);
			const left = (this.inFlight.get(pageId) ?? []).filter((a) => a.seq !== seq);
			if (left.length > 0) this.inFlight.set(pageId, left);
			else this.inFlight.delete(pageId);
		}
	}

	/**
	 * A writer that will never save again (slides ink switched off; the next
	 * switch-on makes a new one). Without this the live file stays attributed
	 * to it, and the new writer's first save is merged against the file as a
	 * "second in-process writer", which puts back strokes it just erased
	 * (audit 125). Also covers a save of the retired writer that lands after
	 * this call: it no longer claims the file.
	 */
	function retireWriter(this: PageStore, writer: PageWriter): void {
		this.retiredWriters.add(writer);
		for (const [pageId, last] of this.lastWriter) {
			if (last === writer) this.lastWriter.set(pageId, undefined);
		}
	}

	/**
	 * Fold in whatever a DIFFERENT in-process writer put on disk since this
	 * writer last agreed with it. Returns `data` untouched in every other
	 * case, including every single-document write and every unidentified
	 * caller, so the common path costs nothing - not even the read.
	 *
	 * `mergePages` is a union: the result is always a superset of `data`, and
	 * `data` is exactly what the unfixed code wrote. So this can only ever add
	 * content relative to the behaviour it replaces, never remove any. That is
	 * the property that makes it safe to put on the save path.
	 *
	 * Fails toward the existing machinery rather than toward cleverness: an
	 * unreadable, damaged or future-schema file is handed back unmerged, and
	 * the external-revision guard below then does what it always did (an
	 * unreadable file reads as external and is preserved as a conflict copy).
	 */
	async function reconcileInProcess(this: PageStore,
		pageId: string,
		data: PageData,
		writer: PageWriter | undefined,
		final: string
	): Promise<PageData> {
		if (writer === undefined) return data;
		const last = this.lastWriter.get(pageId);
		if (last === undefined || last === writer) return data;
		const adapter = this.app.vault.adapter;
		try {
			if (!(await adapter.exists(final))) return data;
			const parsed = parsePage(await adapter.read(final), pageId);
			if (parsed.damaged || parsed.futureVersion !== undefined) return data;
			return mergePages(parsed.data, data);
		} catch (err) {
			console.error("[handwriting] could not reconcile a second writer's sidecar", pageId, err);
			return data;
		}
	}

	async function writeNow(this: PageStore,
		pageId: string,
		data: PageData,
		writer?: PageWriter,
		coversCarrier?: number,
		/** When this batch left the queue; see consumedSeq. */
		seq?: number,
		yieldToPen = false
	): Promise<void> {
		// In flight from here until it settles, whatever the exit; a carrier
		// written meanwhile names it (savesInFlight).
		const flight: { stamp: string | null } = { stamp: null };
		let flights = this.savesInFlight.get(pageId);
		if (!flights) this.savesInFlight.set(pageId, (flights = new Set()));
		flights.add(flight);
		try {
			await this.writeNowInFlight(flight, pageId, data, writer, coversCarrier, seq, yieldToPen);
		} finally {
			flights.delete(flight);
			if (flights.size === 0 && this.savesInFlight.get(pageId) === flights) this.savesInFlight.delete(pageId);
		}
	}

	async function writeNowInFlight(this: PageStore,
		flight: { stamp: string | null },
		pageId: string,
		data: PageData,
		writer?: PageWriter,
		coversCarrier?: number,
		seq?: number,
		yieldToPen = false
	): Promise<void> {
		const adapter = this.app.vault.adapter;
		const removalsAtStart = this.removals.get(pageId) ?? 0;
		let home: string | undefined;
		// The ink folder is being moved. Nothing may be written until the move
		// and the repoint are done, or it lands in the folder being emptied.
		// REQUEUE, synchronously and before any await, so the state is never
		// the queue's only copy for an instant: it goes straight back into
		// `pending` (unless something newer is already there) and the ordinary
		// retry timer brings it back. Not a failure - no retry is counted and
		// nothing is reported. A batch a later one from its writer has already
		// superseded is not put back: that later one carries everything it had.
		if (this.migrating) {
			if (this.superseded(pageId, writer, seq)) return;
			if (!this.pending.has(pageId)) {
				this.pending.set(pageId, data);
				this.pendingWriter.set(pageId, writer);
				this.pendingCovers.set(pageId, coversWithCarried(this, pageId, data, coversCarrier));
			}
			if (!this.timers.has(pageId)) {
				this.timers.set(
					pageId,
					window.setTimeout(() => {
						this.timers.delete(pageId);
						runDetached(this.writePending(pageId), `write held for the folder move ${pageId}`);
					}, WRITE_RETRY_MS)
				);
			}
			return;
		}
		try {
			// WHERE THIS PAGE LIVES, resolved BEFORE anything is written. A
			// page already loaded is pinned, so this is free; a page written
			// with no prior load (paste into a fresh note) is looked up here,
			// which is what makes the read-from-X-write-to-Y fork impossible
			// by construction rather than by a guard that can be skipped. Only
			// a page that exists in no well-known folder resolves to the
			// configured one, which is exactly the "never seen before" rule.
			const { path: final, found } = await this.resolveFor(pageId);
			home = folderOf(final);
			// The folder of THAT file. When the page is being served from the
			// other well-known folder, ensuring the configured one instead
			// created an empty directory and left the write's own folder
			// unchecked.
			await ensureFolder(adapter, folderOf(final));
			const tmp = this.tmpFor(final);
			// A second in-process writer's payload is stale by construction:
			// it was composed by a document that never saw the other one's
			// strokes. Union it with the live file BEFORE the tmp is written,
			// so every byte this sequence puts on disk is already complete.
			// The ORIGINAL `data` is what the failure path re-queues, so a
			// retry reconciles again from whatever disk holds by then rather
			// than baking one attempt's merge into the queue.
			const effective = await this.reconcileInProcess(pageId, data, writer, final);
			// External-revision guard: if the file on disk is not the one this
			// session last read or wrote (Sync, another device, another
			// process), preserve it. Both states survive, ours proceeds.
			// Two layers: mtime first (free), then content identity when the
			// mtime matches, because a same-mtime replacement (coarse fs
			// stamps, sync tools preserving mtimes) must not slip past the
			// guard. Both run
			// on the save queue, never the pen path. A false conflict is
			// recoverable; a missed one is silent loss.
			//
			// MOVE, THEN JUDGE (R5). The guard used to judge the live file in
			// place and delete it several awaits later: a sync write landing in
			// between was deleted with no conflict copy.
			// Now the live file is first moved to a never-taken conflict
			// name, and the judgement reads THOSE bytes, which nothing else
			// writes: the bytes judged are the bytes deleted. Reads per save are
			// unchanged - the content layer already read the whole file.
			//
			// The tmp is written BEFORE any of it. The conflict rename below
			// moves the live file out of the way, and writing after that
			// meant a kill in between left no live file AND no tmp: the page
			// read as absent, and the conflict copy it had been moved to was
			// never announced, because the announcement waits on the rename
			// at the end. Writing first means every instant of this sequence
			// has a complete copy of the ink somewhere load() already looks.
			// In slices, the same bytes as serializePage: a big page held the main thread for the whole stringify
			// (40 to 80 ms at 3000 strokes) and the next pen-down landed inside it.
			// The stamp is taken in the same slices, not over the whole text after them.
			const pause = this.penPause(yieldToPen, pageId);
			const { text: serialized, stamp } = await serializePageSlicedStamped(effective, pause, beginContentStamp);
			flight.stamp = stamp;
			if (!this.ownTmp.has(tmp) && (await adapter.exists(tmp))) {
				const tst = await adapter.stat(tmp).catch(() => null);
				const stranded = await this.freeConflictPath(final, tst?.mtime ?? 0);
				await adapter.rename(tmp, stranded);
				this.parkConflict(pageId, stranded);
			}
			// A pen that came down since the last slice: a timer's save writes after its lift, in the same task as that
			// check, so no stroke starts between them.
			if (yieldToPen && (this.pensDown?.size ?? 0) > 0) await pause();
			// Marked BEFORE the write: a write that creates the file and then throws
			// (a full disk) leaves a partial .tmp that is still this store's own, and
			// the retry overwrites it rather than keeping it as a conflict copy.
			this.ownTmp.add(tmp);
			// Diagnostics: the synchronous part of the write call and of the read-back below (the string's encode runs in
			// the write call before its first await). Off, this is the one switch read per save.
			const diag = diagnosticsEnabled();
			let readSyncMs: number | null = null;
			const writeAt = diag ? performance.now() : 0;
			const written = adapter.write(tmp, serialized);
			const writeSyncMs = diag ? performance.now() - writeAt : 0;
			await written;
			// A blind local file this page has just been taken away from is
			// preserved beside its new home before anything else touches the
			// folder - never discarded, and never left as a second live sidecar
			// in a folder nothing syncs.
			await this.absorbProvisional(pageId, final);
			if (await adapter.exists(final)) {
				const st = await adapter.stat(final).catch(() => null);
				const aside = await this.freeConflictPath(final, st?.mtime ?? 0);
				await adapter.rename(final, aside);
				const known = this.knownMtime.get(pageId);
				// A stat that FAILS proves nothing, and it used to prove "not
				// external": the null fell through both checks, and the save
				// replaced whatever was on disk with no conflict copy. A
				// metadata failure never grants permission to overwrite. With
				// no stat, identity has to come from the content, and a file
				// whose identity cannot be established is preserved.
				let external = st === null || st.mtime !== known;
				if (st === null || !external) {
					const knownHash = this.knownHash.get(pageId);
					if (knownHash !== undefined) {
						const readAt = diag ? performance.now() : 0;
						const reading = adapter.read(aside);
						if (diag) readSyncMs = performance.now() - readAt;
						const cur = await reading.catch(() => null);
						// Unreadable-but-present errs toward preserving it. Stamped in slices that yield one task each and
						// never wait for a lift: the live file is aside until the rename below. Whole, a 25 MB file held the
						// main thread 46 ms.
						external = cur === null || (await contentStampSliced(cur, this.penPause(false, pageId))) !== knownHash;
					}
				}
				if (external) {
					// NOT announced here (RC4). Everything below can still
					// throw, and the old message asserted "this session's ink
					// was saved normally" while the save had not been
					// attempted. The fact is parked until the rename lands.
					this.parkConflict(pageId, aside);
				} else {
					// This session's own last bytes. A failed delete leaves an
					// extra copy of them under a conflict name, never a loss, so
					// it does not fail the save.
					await adapter.remove(aside).catch((err) => {
						console.error("[handwriting] could not remove the replaced sidecar", aside, err);
					});
				}
			}
			if (diag) scrollProbeSave({ writeSyncMs, readSyncMs, len: serialized.length });
			// Anything at the live path now arrived after the move above: it is
			// not this session's by definition, so it is kept the same way. A
			// file landing after this check makes the rename below fail
			// (Obsidian's adapters refuse an existing destination, "Destination
			// file already exists!"), and the retry then keeps it.
			if (await adapter.exists(final)) {
				const st = await adapter.stat(final).catch(() => null);
				const kept = await this.freeConflictPath(final, st?.mtime ?? 0);
				await adapter.rename(final, kept);
				this.parkConflict(pageId, kept);
			}
			await adapter.rename(tmp, final);
			this.ownTmp.delete(tmp);
			const st = await adapter.stat(final).catch(() => null);
			// The page provably lives here now, so a page written with no
			// prior load pins itself the moment its first save lands.
			this.resolved.set(pageId, final);
			// But WHAT KIND of pin. A write that found the page nowhere guessed
			// the configured folder, and that guess must keep being re-checked
			// against the other well-known folders until something proves it -
			// otherwise a sidecar sync delivers a moment later is never seen.
			//
			// A write NEVER confirms a provisional pin, however many times it
			// lands: it re-reads nothing and proves nothing except that the file
			// this device made is still the file this device made. Only a
			// findSidecar hit or a LOAD clears the mark (resolveFor, load).
			if (!found) this.provisional.add(pageId);
			if (st) this.knownMtime.set(pageId, st.mtime);
			this.knownHash.set(pageId, stamp);
			// The save has landed, so a flush carrier it supersedes is stale. A
			// carrier written after this snapshot was taken holds newer ink and
			// stays until the save that covers it lands.
			// A carrier written while this very save was writing holds its page
			// too; that carrier write is not chained behind anything, so it
			// settles first, or the remove races it and leaves it on disk.
			const carrier = this.carriersWritten.get(pageId);
			const carried = this.carriedInFlight.get(pageId);
			const mine = carried !== undefined && carried.generation === carrier && carried.data === data;
			if (mine) await carried.written;
			if (carrier !== undefined && this.carriersWritten.get(pageId) === carrier &&
				((coversCarrier !== undefined && coversCarrier >= carrier) || mine)) {
				this.carriersWritten.delete(pageId);
				this.carriedInFlight.delete(pageId);
				await adapter.remove(this.carrierFor(final)).catch(() => undefined);
			}
			// Recorded only once the rename has landed, so it always names the
			// writer whose composition the live file actually holds.
			this.lastWriter.set(pageId, writer !== undefined && this.retiredWriters.has(writer) ? undefined : writer);
			this.failures.delete(pageId);
			this.errorNotified.delete(pageId);
			// The write is durable as of the rename above: now, and only now,
			// may a message speak about this session's ink.
			const kept = this.pendingConflict.get(pageId);
			if (kept !== undefined) {
				this.pendingConflict.delete(pageId);
				for (const path of kept) this.onConflict?.(pageId, path);
			}
		} catch (err) {
			console.error("[handwriting] sidecar write failed", pageId, err);
			const removalsNow = this.removals.get(pageId) ?? 0;
			if (removalsNow !== removalsAtStart) {
				// The note was deleted while this write ran: its payload goes
				// to the trash, never live. It is the newest state of that
				// note unless the removal recycled a queued state, which was
				// drawn after this write started; then it is kept aside,
				// tagged, so a restore opens the queued state instead.
				const failures = (this.failures.get(pageId) ?? 0) + 1;
				const superseded = this.removedWithQueued.get(pageId) === removalsNow;
				this.recycleFailedWrite(pageId, data, home, WRITE_MAX_RETRIES - failures + 1, superseded ? "superseded" : undefined);
				return;
			}
			// A later batch from this writer has already left the queue: it holds
			// everything this one did, and its own outcome decides what happens
			// next (it lands, or it fails and is put back itself). Putting this
			// one back would land it over that newer save, or take the slot that
			// newer save needs if it fails. Not counted against the retry budget
			// either: the write that matters is still in flight. See consumedSeq.
			if (this.superseded(pageId, writer, seq)) return;
			// A failed write is NOT durable: keep the state queued (unless a
			// newer state has already been scheduled), retry a bounded number
			// of times, then tell the user once. The data also stays in the
			// pending map, so any later schedule() or flush() retries it.
			if (!this.pending.has(pageId)) {
				this.pending.set(pageId, data);
				// Its writer with it: an unattributed retry would skip the
				// reconcile and put this writer's stale page back on disk.
				this.pendingWriter.set(pageId, writer);
				// And the carrier generation it holds, not the newest one: a
				// newer carrier may have been written while this one was in
				// flight, and this payload does not hold it.
				this.pendingCovers.set(pageId, coversWithCarried(this, pageId, data, coversCarrier));
			}
			const n = (this.failures.get(pageId) ?? 0) + 1;
			this.failures.set(pageId, n);
			if (n <= WRITE_MAX_RETRIES) {
				if (!this.timers.has(pageId)) {
					this.timers.set(
						pageId,
						window.setTimeout(() => {
							this.timers.delete(pageId);
							runDetached(this.writePending(pageId, true), `retry sidecar write ${pageId}`);
						}, WRITE_RETRY_MS)
					);
				}
			} else if (!this.errorNotified.has(pageId)) {
				this.errorNotified.add(pageId);
				// If an external revision was moved aside for THIS write, the
				// live path is now empty and the user has to be told where the
				// surviving copy is. The pending entry is deliberately kept:
				// a later retry that succeeds still owes them the conflict
				// message, and it will now be a true one.
				// The first kept copy is named; any others are announced, with it,
				// when a later retry lands.
				this.onWriteError?.(pageId, String(err), this.pendingConflict.get(pageId)?.[0]);
			}
		}
	}

	/**
	 * The blind local file a provisional pin has just lost its page to, moved
	 * to a `.conflict-<mtime>.json` BESIDE THE WINNER.
	 *
	 * Two things must both be true and only this does both: the folder that
	 * cannot sync must stop holding a live sidecar for this id (or it is the
	 * fork, permanently, with this device's copy the one nobody else sees), and
	 * the ink in it - written by this device, possibly never read since - must
	 * not be discarded. So it is treated exactly as the external-revision guard
	 * treats a foreign revision: preserved under a name that is never already
	 * taken, and announced through `pendingConflict`, which fires only once the
	 * save that follows has actually landed.
	 *
	 * Failures here are not fatal to the save: the worst case is the blind copy
	 * staying where it is, which is the state we started in, and the write
	 * itself still lands on the winner.
	 */
	async function absorbProvisional(this: PageStore, pageId: string, final: string): Promise<void> {
		const stale = this.displacedProvisional.get(pageId);
		if (stale === undefined) return;
		this.displacedProvisional.delete(pageId);
		if (stale === final) return;
		const adapter = this.app.vault.adapter;
		try {
			if (!(await adapter.exists(stale))) return;
			const st = await adapter.stat(stale).catch(() => null);
			const kept = await this.freeConflictPath(final, st?.mtime ?? 0);
			await adapter.rename(stale, kept);
			this.parkConflict(pageId, kept);
		} catch (err) {
			console.error("[handwriting] could not preserve a blind local sidecar", pageId, err);
		}
	}

	/**
	 * A same-mtime conflict can want the same conflict name twice. Never
	 * overwrite an earlier conflict copy; find a free sibling name instead.
	 */
	async function freeConflictPath(this: PageStore, final: string, mtime: number): Promise<string> {
		const adapter = this.app.vault.adapter;
		const base = `${stripJson(final)}.conflict-${mtime}`;
		let candidate = `${base}.json`;
		for (let n = 2; await adapter.exists(candidate); n++) {
			candidate = `${base}-${n}.json`;
		}
		return candidate;
	}

export function installPageStoreWrite(proto: PageStore): void {
	installMethods(proto, {
		writeVerified,
		penPause,
		writePending,
		retireWriter,
		reconcileInProcess,
		writeNow,
		writeNowInFlight,
		absorbProvisional,
		freeConflictPath,
	});
}
