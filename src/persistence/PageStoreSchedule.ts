/**
 * The page store's save scheduling: the quiet-period and maximum-dirty timers, the pen watch that holds a write while a pen is down, the immediate and background flushes, and the move of a page's file aside under a new id.
 * They are methods of PageStore, installed on its prototype when PageStore.ts loads.
 */
import { ensureFolder } from "./InkFolder";
import { PageData, serializePage } from "../model/PageData";
import { runDetached } from "../util/Detached";
import { installMethods } from "../inline/InstallMethods";
import { contentStamp, folderOf, MAX_DIRTY_MS, type PageWriter, type PageStore } from "./PageStore";

/**
 * Where keepAsideUnder put the old id's file. `stamp`, on a move that made it the new id's live file: the content stamp
 * (contentStamp) of the exact text that move wrote there, for a later round of the same move to pass back as `own`.
 */
export type KeptAside = { kind: "moved"; to: string; stamp?: string } | { kind: "absent" } | { kind: "held" };

declare module "./PageStore" {
	interface PageStore {
		schedule(pageId: string, data: PageData, writer?: PageWriter): void;
		armQuiet(pageId: string): void;
		saveUnlessPenDown(pageId: string, label: string): void;
		saveAtBound(pageId: string): void;
		releaseHeld(): void;
		watchPens(): void;
		unwatchPens(): void;
		saveNow(pageId: string, data: PageData, writer?: PageWriter): Promise<void>;
		displaceForeignBatch(pageId: string, writer: PageWriter | undefined): void;
		clearTimers(pageId: string): void;
		flushDispatch(): void;
		writeTmpNow(pageId: string, data: PageData): Promise<void> | null;
		flushPage(pageId: string): Promise<boolean>;
		flush(): Promise<void>;
		beginFlush(pageId: string | null): () => void;
		flushingPage(pageId: string): boolean;
		keepAsideUnder(oldId: string, newId: string, own?: string, named?: () => boolean): Promise<KeptAside>;
		keepAsideUnderNow(oldId: string, newId: string, own?: string): Promise<KeptAside>;
	}
}

const DEBOUNCE_MS = 700;


	/**
	 * Queue a save. Safe to call on every mutation.
	 *
	 * Every call restarts the quiet-period timer. The FIRST change of a batch
	 * also arms the maximum-dirty-interval timer, which later changes never
	 * touch; whichever fires first writes the latest complete snapshot and
	 * clears both. Changes arriving during a write start a new batch and wait
	 * for the next write; writes for one page stay serialized on the queue.
	 */
	function schedule(this: PageStore, pageId: string, data: PageData, writer?: PageWriter): void {
		this.scheduled.set(pageId, (this.scheduled.get(pageId) ?? 0) + 1);
		this.displaceForeignBatch(pageId, writer);
		this.pending.set(pageId, data);
		this.pendingWriter.set(pageId, writer);
		// The newest state of the page: every carrier written so far holds it
		// or an older one.
		this.pendingCovers.set(pageId, this.carriersWritten.get(pageId));
		const existing = this.timers.get(pageId);
		if (existing !== undefined) window.clearTimeout(existing);
		this.watchPens();
		this.armQuiet(pageId);
		if (!this.maxTimers.has(pageId)) {
			this.maxTimers.set(
				pageId,
				window.setTimeout(() => {
					this.maxTimers.delete(pageId);
					this.saveAtBound(pageId);
				}, MAX_DIRTY_MS)
			);
		}
	}

	/** The quiet-period timer: DEBOUNCE_MS from now, replacing any running one. */
	function armQuiet(this: PageStore, pageId: string): void {
		const existing = this.timers.get(pageId);
		if (existing !== undefined) window.clearTimeout(existing);
		this.timers.set(
			pageId,
			window.setTimeout(() => {
				this.timers.delete(pageId);
				this.saveUnlessPenDown(pageId, `write queued sidecar ${pageId}`);
			}, DEBOUNCE_MS)
		);
	}

	/** A save timer's write, held while a pen is down (see pensDown). The batch stays in `pending` either way. */
	function saveUnlessPenDown(this: PageStore, pageId: string, label: string): void {
		// `?.`: a unit rig built with Object.create never runs the field initialisers.
		if ((this.pensDown?.size ?? 0) > 0) {
			this.heldForPen.add(pageId);
			return;
		}
		runDetached(this.writePending(pageId, true), label);
	}

	/**
	 * The MAX_DIRTY_MS bound: written now, or with a pen down at the first lift, with a cap timer MAX_DIRTY_MS out.
	 * The cap writes pen or no pen and forgets every pen believed down: a lift that never arrived is not waited for
	 * again, and the next real contact is tracked afresh.
	 */
	function saveAtBound(this: PageStore, pageId: string): void {
		if ((this.pensDown?.size ?? 0) === 0) {
			runDetached(this.writePending(pageId, true), `write bounded-dirty sidecar ${pageId}`);
			return;
		}
		if (this.heldPastBound.has(pageId)) return;
		this.heldPastBound.set(
			pageId,
			window.setTimeout(() => {
				this.heldPastBound.delete(pageId);
				this.pensDown.clear();
				runDetached(this.writePending(pageId), `write capped sidecar ${pageId}`);
			}, MAX_DIRTY_MS)
		);
	}

	/**
	 * The last pen lifted (or the window lost focus). Pages past their bound are written in a task after the lift's own
	 * handlers, which commit the stroke the lift ends, so the write carries it; no new quiet period. Pages held by the
	 * quiet timer alone take a fresh quiet period.
	 */
	function releaseHeld(this: PageStore): void {
		for (const wake of [...(this.parked ?? [])]) wake();
		const held = [...this.heldForPen];
		this.heldForPen.clear();
		for (const pageId of held) if (this.pending.has(pageId) && !this.heldPastBound.has(pageId)) this.armQuiet(pageId);
		const bound = [...this.heldPastBound.keys()];
		if (bound.length === 0) return;
		window.setTimeout(() => {
			for (const pageId of bound) {
				if (!this.heldPastBound.has(pageId)) continue;
				runDetached(this.writePending(pageId, true), `write bounded-dirty sidecar at the lift ${pageId}`);
			}
		}, 0);
	}

	/** Listen for pen contacts on the main window, once; capture phase, so no handler below can hide one. */
	function watchPens(this: PageStore): void {
		if (this.penWatch || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
		const win = window;
		const down = (e: PointerEvent): void => {
			if (e.pointerType === "pen") this.pensDown.add(e.pointerId);
		};
		const up = (e: PointerEvent): void => {
			if (e.pointerType !== "pen" || !this.pensDown.delete(e.pointerId)) return;
			if (this.pensDown.size === 0) this.releaseHeld();
		};
		const lost = (): void => {
			this.pensDown.clear();
			this.releaseHeld();
		};
		win.addEventListener("pointerdown", down, true);
		win.addEventListener("pointerup", up, true);
		win.addEventListener("pointercancel", up, true);
		win.addEventListener("blur", lost);
		this.penWatch = () => {
			win.removeEventListener("pointerdown", down, true);
			win.removeEventListener("pointerup", up, true);
			win.removeEventListener("pointercancel", up, true);
			win.removeEventListener("blur", lost);
		};
	}

	function unwatchPens(this: PageStore): void {
		this.penWatch?.();
		this.penWatch = null;
		this.pensDown?.clear();
		for (const wake of [...(this.parked ?? [])]) wake();
		this.heldForPen?.clear();
		for (const cap of this.heldPastBound?.values() ?? []) window.clearTimeout(cap);
		this.heldPastBound?.clear();
	}

	/**
	 * Write this state now, with no quiet period: the first save after an
	 * identity claim, where the 700 ms were already spent waiting for the id.
	 * Serialized on the queue like every other write. Resolves when the
	 * attempt is over: the rename has landed, or the failure has re-queued
	 * the state for the bounded retry path. Counted in `scheduled` like a
	 * queued save, so an id move that asks what was saved under the old id
	 * meanwhile (a deck's teardown flush) sees this one too.
	 */
	async function saveNow(this: PageStore, pageId: string, data: PageData, writer?: PageWriter): Promise<void> {
		this.scheduled.set(pageId, (this.scheduled.get(pageId) ?? 0) + 1);
		this.displaceForeignBatch(pageId, writer);
		this.pending.set(pageId, data);
		this.pendingWriter.set(pageId, writer);
		this.pendingCovers.set(pageId, this.carriersWritten.get(pageId));
		this.clearTimers(pageId);
		await this.writePending(pageId);
	}

	/**
	 * The debounce collapses a batch to its NEWEST state, which is right for
	 * one writer and is the mechanism of the two-pane loss for two: the second
	 * pane's `pending.set` replaces the first pane's payload and `clearTimeout`
	 * cancels its timer, so the first pane's bytes never reach the adapter at
	 * all. Nothing downstream can recover them - by the time any write runs,
	 * the only record that they existed is gone.
	 *
	 * So the collapse is made PER WRITER rather than per page: a foreign
	 * writer's queued batch is dispatched instead of dropped, and the incoming
	 * batch queues behind it (writes for one page are already serialized). The
	 * two payloads then meet on disk, where `reconcileInProcess` can union
	 * them, which is the one place both are still available.
	 *
	 * `writePending` consumes `pending` and clears both timers SYNCHRONOUSLY -
	 * everything before its first await - so the caller may set its own state
	 * and arm its own timers immediately after this returns.
	 *
	 * Does nothing unless both writers are identified and differ, so a single
	 * document and every unidentified caller keep today's collapse exactly.
	 */
	function displaceForeignBatch(this: PageStore, pageId: string, writer: PageWriter | undefined): void {
		if (writer === undefined) return;
		const queued = this.pendingWriter.get(pageId);
		if (queued === undefined || queued === writer) return;
		if (!this.pending.has(pageId)) return;
		runDetached(this.writePending(pageId), `write a displaced batch for ${pageId}`);
	}

	function clearTimers(this: PageStore, pageId: string): void {
		const quiet = this.timers.get(pageId);
		if (quiet !== undefined) {
			window.clearTimeout(quiet);
			this.timers.delete(pageId);
		}
		const max = this.maxTimers.get(pageId);
		if (max !== undefined) {
			window.clearTimeout(max);
			this.maxTimers.delete(pageId);
		}
		// A held page's batch is consumed with its timers: nothing is left for a lift or a cap to write.
		const cap = this.heldPastBound?.get(pageId);
		if (cap !== undefined) {
			window.clearTimeout(cap);
			this.heldPastBound.delete(pageId);
		}
		this.heldForPen?.delete(pageId);
	}

	/**
	 * Hand every dirty sidecar's FLUSH CARRIER to the adapter in one synchronous
	 * sweep, then chain the normal write behind each one.
	 *
	 * The background path on iOS and Android: the webview freezes on
	 * backgrounding with no further JS, so flush()'s one-at-a-time awaits
	 * only ever dispatch the FIRST write before the freeze lands.
	 *
	 * Until 2026-09-02 this method claimed the sweep already reached the
	 * adapter and it did not. `writePending` -> `chain` -> `writeNow`, and
	 * `writeNow`'s first statement is `await ensureFolder(...)` - an
	 * `adapter.exists` - with `adapter.write(tmp, ...)` behind that await
	 * and behind `chain`'s own microtask. What reached the platform before
	 * the freeze was a folder check per page: no ink on disk, and the next
	 * launch found nothing to recover. See audit-fixes-design.md section 4
	 * (B1), correction 3.
	 *
	 * Exactly ONE call has to beat the freeze: `adapter.write(tmp, ...)`.
	 * Since 2026-09-01 (commit "the save sequence never has nothing on
	 * disk") `writeNow` writes the tmp before the external-revision guard
	 * and the aside-rename, and `load()` PROMOTES a recovered tmp - so a
	 * tmp alone is a complete, recoverable copy of the page. Everything
	 * after it (guard, conflict rename, rename into place) is a bonus if
	 * the platform lets it run and a safe no-op if it does not.
	 *
	 * The normal write is chained BEHIND the dispatched tmp write, for two
	 * reasons: it must not race the raw write for the same tmp path, and it
	 * re-reads `pending` when it runs, so a snapshot scheduled after the
	 * sweep is the one that lands. Disk state only moves forward.
	 *
	 * Completion is deliberately not awaited, because nothing after a
	 * freeze runs to hear about it.
	 */
	function flushDispatch(this: PageStore): void {
		for (const pageId of new Set([...this.timers.keys(), ...this.maxTimers.keys()])) {
			this.clearTimers(pageId);
		}
		for (const id of [...this.pending.keys()]) {
			const data = this.pending.get(id);
			// The entry stays in `pending` on purpose: nothing is durable
			// until the rename, and a freeze here must leave the state
			// queued for the next flush, retry or unload.
			const dispatched = data === undefined ? null : this.writeTmpNow(id, data);
			if (dispatched === null) {
				runDetached(this.writePending(id), `background flush of ${id}`);
				continue;
			}
			runDetached(
				// The tmp write's own failure is not the chained write's
				// business: it retries through the normal path, which
				// ensures the folder and reports like any other save.
				dispatched.then(
					() => this.writePending(id),
					() => this.writePending(id)
				),
				`background flush of ${id}`
			);
		}
		// A save that has left `pending` and not landed: writePending takes the
		// batch out before its first await, so its ink has no copy on disk until
		// that save's own tmp lands. Its carrier is written too, from the newest
		// attempt still writing. Nothing is chained behind it, since nothing is
		// queued: the save is still running, and removes the carrier when it
		// lands, once this write has settled (see carriedInFlight). A page
		// with a newer batch queued was written above.
		for (const id of [...this.inFlight.keys()]) {
			if (this.pending.has(id)) continue;
			const data = this.latestUnlanded(id);
			if (data === null) continue;
			const dispatched = this.writeTmpNow(id, data);
			if (dispatched === null) continue;
			const written = dispatched.then(
				() => undefined,
				(err: unknown) => console.error("[handwriting] background flush of a save in flight failed", id, err)
			);
			this.carriedInFlight.set(id, { generation: this.carriersWritten.get(id)!, data, written });
		}
	}

	/**
	 * The one call that has to reach the platform before a freeze: the
	 * page's tmp file, written with NO await in front of it. Returns the
	 * adapter's promise (unawaited, for the caller to chain behind), or
	 * null when the write could not even be dispatched.
	 *
	 * No `ensureFolder` here, deliberately - it is the await that stood in
	 * front of the write (audit-fixes-design.md section 4, B1). The doc
	 * offers a cached "folder known to exist" flag instead; a session-scoped
	 * flag would SKIP the synchronous write in the common case where the
	 * folder has existed on disk for months but this session has not
	 * written yet - a fresh app start, ink drawn, the app backgrounded
	 * inside the 800 ms debounce - which is precisely the case the fix is
	 * for. Attempting the write unconditionally is right instead: on a
	 * genuinely missing folder it rejects, which is exactly today's outcome
	 * (nothing on disk), and the chained normal write then creates the
	 * folder and writes properly.
	 *
	 * Note the doc's premise for skipping is wrong against the code: a page
	 * reaches `pending` by being SCHEDULED, not by being saved, so a page
	 * can be pending with no folder ever created.
	 */
	function writeTmpNow(this: PageStore, pageId: string, data: PageData): Promise<void> | null {
		try {
			// path() asserts on an unsafe id and serializePage can throw on a
			// malformed page; both must fail into the normal path rather than
			// out of a visibilitychange handler.
			// The PINNED path, not the configured one: this write must land
			// beside the file the page actually lives in, or load() would not
			// look where the freeze left it. Nothing may be awaited here, so
			// an unresolved page falls back to the configured folder - which
			// is where an unresolved page would be written anyway.
			// Its OWN file, never the shared .tmp: a .tmp
			// beside a valid live file cannot say which bytes it followed, so
			// load could never safely prefer it. The carrier records the stamp
			// of the live bytes this session loaded or wrote, and the saves in
			// flight now: each one's stamp, or null when its bytes are not known
			// yet. Older builds read past the extra field.
			const carrier = this.carrierFor(this.pinnedPath(pageId));
			const base = this.knownHash.get(pageId) ?? null;
			const inFlight = [...(this.savesInFlight.get(pageId) ?? [])].map((f) => f.stamp);
			const text = `{"flushBase":${JSON.stringify(base)},"flushInFlight":${JSON.stringify(inFlight)},"page":${serializePage(data)}}`;
			const generation = ++this.carrierGeneration;
			this.carriersWritten.set(pageId, generation);
			// The carrier is written from the payload in `pending`, so that
			// payload now holds this generation.
			if (this.pending.get(pageId) === data) this.pendingCovers.set(pageId, generation);
			return this.app.vault.adapter.write(carrier, text);
		} catch (err) {
			console.error("[handwriting] background tmp write could not be dispatched", pageId, err);
			return null;
		}
	}

	/**
	 * Write what is queued for this one page now and wait for it. True when
	 * nothing is left queued for it; a failed write re-queues its state for the
	 * bounded retry, and answers false.
	 */
	async function flushPage(this: PageStore, pageId: string): Promise<boolean> {
		const end = this.beginFlush(pageId);
		try {
			this.clearTimers(pageId);
			if (this.pending.has(pageId)) await this.writePending(pageId);
			await this.tails.get(pageId);
		} finally {
			end();
		}
		return !this.pending.has(pageId) && !this.timers.has(pageId);
	}

	/**
	 * Write everything queued right now: quit, plugin unload, the ink-folder move. On return every page still queued
	 * has a live quiet or bound timer, except one whose retries are spent and whose user has been told.
	 */
	async function flush(this: PageStore): Promise<void> {
		const end = this.beginFlush(null);
		try {
			for (const pageId of new Set([...this.timers.keys(), ...this.maxTimers.keys()])) {
				this.clearTimers(pageId);
			}
			// Every page's save starts now and they are awaited together: the unload does not wait for this, and one page
			// after another left a process that ended partway with the later pages never started. Each page's own saves
			// still run in order on its chain.
			const ids = [...this.pending.keys()];
			await Promise.all(ids.map((id) => this.writePending(id)));
			await Promise.all([...this.tails.values()]);
			// The pen watch, every hold and every cap go; the next `schedule` watches again.
			this.unwatchPens();
			// A batch scheduled while the writes above were awaited is not in `ids`. Its quiet timer may have fired into a
			// pen hold and its bound timer into a cap, and both just went, which left it queued with no timer at all. A
			// fresh quiet period for each such page, once: it writes it with the pen watch gone, and a user who is still
			// drawing schedules again at the lift. A page whose retries are spent waits, as it did, for the next schedule
			// or flush.
			for (const pageId of this.pending.keys()) {
				if (this.timers.has(pageId) || this.maxTimers.has(pageId) || this.errorNotified.has(pageId)) continue;
				this.armQuiet(pageId);
			}
		} finally {
			end();
		}
	}

	/**
	 * A flush, flushPage or keepAsideUnder of `pageId` (null: every page) begins. It waits on the page's write chain,
	 * which may hold a timer's save parked for a pen, so every parked save wakes now, and until the returned function
	 * runs a save of that page goes on with the pen down (see penPause). A woken save of another page parks again.
	 */
	function beginFlush(this: PageStore, pageId: string | null): () => void {
		// `??=`: a unit rig built with Object.create never runs the field initialisers.
		const flushing = (this.flushing ??= new Map());
		flushing.set(pageId, (flushing.get(pageId) ?? 0) + 1);
		for (const wake of [...(this.parked ?? [])]) wake();
		return () => {
			const left = (flushing.get(pageId) ?? 1) - 1;
			if (left > 0) flushing.set(pageId, left);
			else flushing.delete(pageId);
		};
	}

	/** Is a flush, flushPage or keepAsideUnder writing this page now? Its saves then never park (see beginFlush). */
	function flushingPage(this: PageStore, pageId: string): boolean {
		return (this.flushing?.size ?? 0) > 0 && (this.flushing.has(null) || this.flushing.has(pageId));
	}

	/**
	 * The content stamp of a file's text now, as keepAsideUnder compares it across rounds; null when it cannot be read.
	 * The bytes, not the modified time and size: a sync tool sets the other device's write time, and a revision of the
	 * same length written at the same time is another revision all the same.
	 */
	async function liveStamp(adapter: PageStore["app"]["vault"]["adapter"], path: string): Promise<string | null> {
		const text = await adapter.read(path).catch(() => null);
		return text === null ? null : contentStamp(text);
	}

	/**
	 * A note open here now names `newId`, an id the other device gave it, and
	 * the ink this device drew sits in `oldId`'s file. Nothing names that file
	 * any more, so it is set beside the new page where fix ink de-sync finds
	 * it: as `<newId>.conflict-<mtime>.json`, a kept copy listed against the
	 * new live page (ForkResolution.scanForForks). When the new id has no live
	 * file yet there is no other revision to choose against, and the old file
	 * becomes the new id's live file instead, declaring the new id, so the
	 * note keeps its ink.
	 *
	 * Anything still queued for `oldId` is written first, and the move runs on
	 * its write chain, so it moves the newest bytes. A queue that will not
	 * write leaves the file where it is. Answers where the file went, that
	 * there was nothing to move, or that it stayed because the queue did not
	 * land; a failed read, write or rename throws and moves nothing further.
	 *
	 * `own`: the stamp of the file an earlier round of the same move made the
	 * new id's live file (`stamp` in that round's answer): the content stamp of
	 * the text it wrote, taken from that text, not from a read after the write.
	 * While that file is unchanged since (the same text) it is no other revision,
	 * only this move's own older copy of the old file: the old file takes its
	 * place the same way it would with no live file, and no copy is set aside.
	 * Changed since, by another device or a sync tool, it is kept and the old
	 * file set beside it. No stamp to compare keeps it too.
	 */
	async function keepAsideUnder(this: PageStore,
		oldId: string,
		newId: string,
		own?: string,
		named?: () => boolean
	): Promise<KeptAside> {
		const end = this.beginFlush(oldId);
		// `??=`: a unit rig built with Object.create never runs the field initialisers.
		const moving = (this.moving ??= new Map());
		moving.set(oldId, (moving.get(oldId) ?? 0) + 1);
		try {
			const kept = await this.keepAsideUnderNow(oldId, newId, own);
			// Remembered for a save that lands under the old id later (writePending): the round's own stamp, or, when this
			// round set the file beside the live one as a copy, the stamp an earlier round of the same move left there. `named`
			// is kept with it: writePending follows the move only while no note names the old id.
			if (named !== undefined && kept.kind === "moved") {
				const movedIds = (this.movedIds ??= new Map());
				const before = movedIds.get(oldId);
				const stamp = kept.stamp ?? (before?.to === newId ? before.stamp : undefined);
				movedIds.set(oldId, { to: newId, named, ...(stamp !== undefined ? { stamp } : {}) });
			}
			return kept;
		} finally {
			const left = (moving.get(oldId) ?? 1) - 1;
			if (left > 0) moving.set(oldId, left);
			else moving.delete(oldId);
			end();
		}
	}

	async function keepAsideUnderNow(this: PageStore,
		oldId: string,
		newId: string,
		own?: string
	): Promise<KeptAside> {
		this.clearTimers(oldId);
		await this.writePending(oldId);
		if (this.pending.has(oldId)) return { kind: "held" };
		const adapter = this.app.vault.adapter;
		return this.chain(oldId, async () => {
			const old = await this.findSidecar(oldId);
			if (!old.found) return { kind: "absent" as const };
			const target = await this.resolveFor(newId);
			// The new id's live file is still what an earlier round of this move wrote there.
			const ours = target.found && own !== undefined && (await liveStamp(adapter, target.path)) === own;
			let to: string;
			let stamp: string | undefined;
			if (target.found && !ours) {
				const st = await adapter.stat(old.path).catch(() => null);
				to = await this.freeConflictPath(target.path, st?.mtime ?? 0);
				await adapter.rename(old.path, to);
			} else {
				// MOVE, THEN JUDGE, as writeNow does. The old file is first moved
				// whole to a free copy name beside the new page, and only THOSE
				// bytes are read: nothing else writes that name, so the bytes read
				// are the bytes later removed, and from this instant on the ink is
				// a listed copy of the new page whatever happens next. Read in
				// place and removed in place, a sync write landing in between was
				// deleted.
				await ensureFolder(adapter, folderOf(target.path));
				const st = await adapter.stat(old.path).catch(() => null);
				const aside = await this.freeConflictPath(target.path, st?.mtime ?? 0);
				await adapter.rename(old.path, aside);
				// It becomes the new id's page, so it declares the new id: a
				// reload under the new path reads the id the note names. Only
				// that one top-level value changes.
				const text = await adapter.read(aside);
				let raw: Record<string, unknown> | null = null;
				try {
					const parsed: unknown = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
				} catch {
					raw = null;
				}
				if (raw === null) {
					// Bytes that do not parse are never rewritten: they stay as
					// they are, the copy beside where the new page will live, so
					// the note can follow its id and nothing is lost.
					to = aside;
				} else {
					to = target.path;
					raw.pageId = newId;
					const written = JSON.stringify(raw);
					// The stamp of what this round wrote, never of what a look after the write finds: a file another device lands
					// there in between is then no match for the next round, and is kept.
					stamp = contentStamp(written);
					// The new text goes to a tmp first and is renamed into place
					// last; writing straight over the new path wrote over any
					// revision a sync tool landed there meanwhile. The tmp is a
					// name only this move makes: a page id has no "+", so no
					// save's tmp and no conflict copy is ever this name. The new
					// id's own tmp was shared with a save of the new id, which
					// runs on another queue: its bytes were renamed into place
					// here and the old ink's copy then removed.
					const tmp = `${to.replace(/\.json$/, "")}+from-${oldId}.json.tmp`;
					await adapter.write(tmp, written);
					// The new id's live file now, moved aside and judged by those
					// bytes: an earlier round's own file (`own`) is removed, any
					// other revision stays as a copy beside the new page.
					if (await adapter.exists(to)) {
						const lst = await adapter.stat(to).catch(() => null);
						const live = await this.freeConflictPath(to, lst?.mtime ?? 0);
						await adapter.rename(to, live);
						const cur = own === undefined ? null : await adapter.read(live).catch(() => null);
						if (cur !== null && contentStamp(cur) === own) await adapter.remove(live);
					}
					// Anything at the live path now landed after that move: it is
					// kept the same way. A file landing after this check makes the
					// rename below fail (the vault adapter refuses an existing
					// destination), and the copies made so far keep every byte.
					if (await adapter.exists(to)) {
						const lst = await adapter.stat(to).catch(() => null);
						await adapter.rename(to, await this.freeConflictPath(to, lst?.mtime ?? 0));
					}
					await adapter.rename(tmp, to);
					// The copy holds exactly the bytes just written under the new id.
					await adapter.remove(aside);
				}
			}
			// A revision of the old id's file that landed after the move took it
			// would sit where nothing names it: it is set beside the new page too.
			if (await adapter.exists(old.path)) {
				const lst = await adapter.stat(old.path).catch(() => null);
				await ensureFolder(adapter, folderOf(target.path));
				await adapter.rename(old.path, await this.freeConflictPath(target.path, lst?.mtime ?? 0));
			}
			// The old id's file is gone from where this store pinned it.
			this.resolved.delete(oldId);
			this.provisional.delete(oldId);
			this.displacedProvisional.delete(oldId);
			this.knownMtime.delete(oldId);
			this.knownHash.delete(oldId);
			this.contentCheckedAt.delete(oldId);
			this.observedMissing.delete(oldId);
			this.lastWriter.delete(oldId);
			this.consumedSeq.delete(oldId);
			return { kind: "moved" as const, to, ...(stamp !== undefined ? { stamp } : {}) };
		});
	}

export function installPageStoreSchedule(proto: PageStore): void {
	installMethods(proto, {
		schedule,
		armQuiet,
		saveUnlessPenDown,
		saveAtBound,
		releaseHeld,
		watchPens,
		unwatchPens,
		saveNow,
		displaceForeignBatch,
		clearTimers,
		flushDispatch,
		writeTmpNow,
		flushPage,
		flush,
		beginFlush,
		flushingPage,
		keepAsideUnder,
		keepAsideUnderNow,
	});
}
