/**
 * The inline ink store's loading methods: bringing a note's ink into the session, the sidecar adoption and retry paths, the
 * delete-all capture and its checks, and the lookups by page id and history identity. They are methods of InlineInkStore, installed on
 * its prototype when InlineInkStore.ts loads.
 */
import { InkStroke } from "../ink/Stroke";
import { emptyPage, PageData, parsePage, serializePage } from "../model/PageData";
import { scaleStroke } from "../objects/Selection";
import { notifyInkChanged } from "./InkEvents";
import { installMethods } from "./InstallMethods";
import { choicesKeyOf, inkFingerprint, type InlineDeleteCapture, type InlineDeleteReadiness, type InlineDeleteTarget, type NoteRecord, PARSER_INVENTED_STROKE_FIELDS, type InlineInkStore } from "./InlineInkStore";

declare module "./InlineInkStore" {
	interface InlineInkStore {
		isLoaded(path: string): boolean;
		ensureLoaded(path: string): Promise<boolean>;
		refreshOnReopen(path: string, rec: NoteRecord): Promise<boolean>;
		loadRecord(path: string, rec: NoteRecord, fallback?: Pick<NoteRecord, "basePage">): Promise<boolean>;
		trackLoad(rec: NoteRecord, work: () => Promise<boolean>): Promise<boolean>;
		retryDamaged(rec: NoteRecord): Promise<boolean>;
		holdUnreadQuietly(rec: NoteRecord): void;
		adoptSidecar(rec: NoteRecord, id: string): Promise<boolean>;
		captureHistoryIdentity(path: string): symbol;
		pathForHistoryIdentity(identity: symbol): string | null;
		pageIdOf(path: string): string | null;
		pathForPageId(pageId: string): string | null;
		isDamagedLocked(path: string): boolean;
		deleteAllReadiness(path: string): InlineDeleteReadiness;
		captureDeleteAll(path: string): InlineDeleteCapture | null;
		currentMatchesCapture(capture: InlineDeleteCapture): boolean;
		backupMatchesCapture(capture: InlineDeleteCapture, page: PageData, raw?: unknown): boolean;
		throughCodec(capture: InlineDeleteCapture): unknown[] | null;
		isHandwritingPage(path: string): boolean;
	}
}

/** How long a note whose file keeps failing to read stays silent. */
const TRANSIENT_SILENCE_MS = 60_000;

/** `freezePage`'s copy, for anything that is not a whole page. */
function deepCopy<T>(value: T): T {
	return typeof structuredClone === "function"
		? structuredClone(value)
		: (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Per stroke id, which fields the parser would have INVENTED for this artifact.
 *
 * `null` when there is no artifact JSON to ask - the caller then compares
 * everything, which is the safe direction.
 */
function inventedFieldsIn(raw: unknown): Map<string, Set<string>> | null {
	const strokes = (raw as { strokes?: unknown } | null | undefined)?.strokes;
	if (!Array.isArray(strokes)) return null;
	const out = new Map<string, Set<string>>();
	for (const s of strokes) {
		if (!s || typeof s !== "object") continue;
		const rec = s as Record<string, unknown>;
		const id = rec.id;
		if (typeof id !== "string") continue;
		const invented = new Set<string>();
		for (const [field, wouldInvent] of Object.entries(PARSER_INVENTED_STROKE_FIELDS)) {
			if (wouldInvent(rec[field])) invented.add(field);
		}
		out.set(id, invented);
	}
	return out;
}

/** One compared stroke with `drop`'s fields removed from it. */
function withoutFields(entry: unknown, drop: Set<string> | undefined): unknown {
	if (!drop || drop.size === 0) return entry;
	const { stroke, unknown } = entry as { stroke: InkStroke; unknown: unknown };
	const kept = { ...(stroke as unknown as Record<string, unknown>) };
	for (const field of drop) delete kept[field];
	return { stroke: kept, unknown };
}


	// ---- loading --------------------------------------------------------------

	/**
	 * Is this note's ink already in the session?
	 *
	 * `ensureLoaded` is async even when it has nothing to do, and a promise
	 * that resolves on a microtask is still too late for a caller that is
	 * about to serialize the DOM - which is what an export does. This lets
	 * such a caller paint synchronously in the common case (the note is open,
	 * so its ink was loaded long ago) and fall back to awaiting only when
	 * there is a real file read to wait for.
	 *
	 * False while a load is in flight and false for a damaged sidecar awaiting
	 * retry: in both cases `strokes()` would answer with an incomplete set,
	 * and a partial picture is worse than a late one.
	 */
	function isLoaded(this: InlineInkStore, path: string): boolean {
		const rec = this.byPath.get(path);
		return rec !== undefined && rec.load === "yes" && !rec.damagedLocked;
	}

	/**
	 * Bring a note's persisted ink into the session, once. Resolves true when
	 * the visible strokes changed (the caller repaints).
	 *
	 * An untouched note costs exactly one metadata lookup: no id → no sidecar
	 * can exist (they are keyed by id) → zero file I/O, zero writes.
	 */
	async function ensureLoaded(this: InlineInkStore, path: string): Promise<boolean> {
		this.gainedPageId(path);
		const rec = this.record(path);
		if (!this.host) return false;
		// Every viewer waiting on this read needs its completion result. Returning
		// false while loading leaves a joining editor blank until another repaint.
		if (rec.load === "loading") return rec.loadInFlight ?? false;
		if (rec.load === "yes" && rec.damagedLocked) {
			const changed = await this.retryDamaged(rec);
			// A repaired file read back on reopen: embeds of the note are not the
			// editor that asked, so tell them as the reopen path does.
			if (changed) notifyInkChanged(path);
			return changed;
		}
		if (rec.load === "yes") return this.refreshOnReopen(path, rec);
		if (rec.load !== "no") return false;
		return this.loadRecord(path, rec);
	}

	/**
	 * A note opened again later in the session is served from its record,
	 * which the session never drops. Live reload only watches notes with an
	 * open editor, so another device's ink that synced while the note was
	 * closed was never read: the reopened note showed the old ink, and a
	 * stroke made before the next poll check wrote that old ink back as the
	 * live page and pushed the newer file aside as a conflict copy.
	 *
	 * So a reopen asks whether the sidecar changed, and if it did, takes the
	 * newer revision through the same preserving adoption the poll uses. A
	 * stroke that lands while the answer is awaited refuses the adoption (the
	 * generation moves), and the poll then handles it as it always has.
	 */
	async function refreshOnReopen(this: InlineInkStore, path: string, rec: NoteRecord): Promise<boolean> {
		const id = rec.pageId;
		const host = this.host;
		if (!id || !host?.sidecarChanged) return false;
		const generation = rec.mutationGeneration;
		let changed = false;
		try {
			changed = await host.sidecarChanged(id);
		} catch {
			return false;
		}
		// The same admission the sync poll uses: the ink did not change while the
		// answer was awaited, the note still has its page id, no save is queued and
		// every pane on the note is quiet, now and at the adoption's last step.
		const admitted = (): boolean => rec.mutationGeneration === generation && this.pageIdOf(path) === id &&
			!host.hasQueuedWrite?.(id) && (host.panesQuiet?.(path) ?? true);
		if (!changed || this.byPath.get(path) !== rec || !admitted()) return false;
		const adopted = await this.adoptExternal(path, admitted);
		if (adopted.outcome !== "adopted" || !adopted.changed) return false;
		// Embeds and reading views of this note are not the editor that asked;
		// the caller repaints its own pane from the result, so tell the rest.
		notifyInkChanged(path);
		return true;
	}

	/** Complete adoption or fallback restoration before releasing waiting viewers. */
	function loadRecord(this: InlineInkStore,
		path: string,
		rec: NoteRecord,
		fallback?: Pick<NoteRecord, "basePage">
	): Promise<boolean> {
		const finish = (changed: boolean): boolean => {
			if (fallback && rec.basePage === null) {
				// A failed reread keeps the prior page and any ink added while
				// waiting. The same completion releases viewers and pending saves.
				rec.basePage = fallback.basePage;
				changed = rec.strokes.length > 0;
			}
			rec.load = "yes";
			rec.reloading = false;
			return changed;
		};
		rec.load = "loading";
		const id = this.host?.readPageId(path);
		if (!id) return Promise.resolve(finish(false));
		rec.pageId = id;
		return this.trackLoad(rec, async () => {
			try {
				return finish(await this.adoptSidecar(rec, id));
			} catch (err) {
				// A rejected load leaves no base page: a save now would write the
				// session's strokes alone over a file that may hold the rest. Held
				// like a read that threw; the poll and a reopen read it again.
				console.error("[handwriting] ink file load rejected", err);
				this.holdUnreadQuietly(rec);
				finish(false);
				// The caller still sees the failure, as before; the note no longer
				// waits on a read that is over.
				throw err;
			}
		});
	}

	/**
	 * Run a sidecar read with the record marked as loading. A mutation that
	 * races the read must not be snapshotted yet: the snapshot would hold
	 * only the session's strokes and, written, replace the persisted ones
	 * (persistence gate, 2026-08-22). persist() waits on this promise and
	 * runs again after the merge.
	 */
	function trackLoad(this: InlineInkStore, rec: NoteRecord, work: () => Promise<boolean>): Promise<boolean> {
		const run = work();
		rec.loadInFlight = run
			.then(
				(changed) => changed,
				() => false
			)
			.finally(() => {
				rec.loadInFlight = null;
			});
		return run;
	}

	/**
	 * The damaged notice promises "until the file is repaired, restored, or
	 * removed", so reopening the note RE-READS a damage-locked sidecar
	 * instead of trusting a verdict from earlier in the session. Heal path:
	 * the lock lifts, the saved ink merges back in ahead of anything drawn
	 * while locked, and that locked-era ink is scheduled so it finally
	 * becomes durable. Still damaged: the lock re-arms, silently (the one
	 * notice already stands). Removed entirely: the lock lifts and session
	 * ink starts a fresh file, which is exactly what "or removed" offered.
	 */
	async function retryDamaged(this: InlineInkStore, rec: NoteRecord): Promise<boolean> {
		if (!this.host || !rec.pageId) return false;
		rec.load = "loading";
		rec.damagedLocked = false; // adoptSidecar re-arms it if still damaged
		const id = rec.pageId;
		const changed = await this.trackLoad(rec, async () => {
			const before = inkFingerprint(rec.strokes);
			const c = await this.adoptSidecar(rec, id);
			rec.load = "yes";
			// A valid empty repair can remove cached ink. Joining viewers may
			// already have painted that cache, so deletion must request paint
			// through the same shared completion as restored non-empty ink.
			return c || inkFingerprint(rec.strokes) !== before;
		});
		if (!rec.damagedLocked && !rec.legacyLocked && !rec.futureLocked) {
			// A lock the user was never told about heals as quietly as it came.
			const told = !rec.damageSilent;
			rec.damageSilent = false;
			rec.transientSince = null;
			rec.transientNoticed = false;
			rec.noticed = false; // a future, different problem may speak again
			// "Restored" is only true when something was actually read back.
			// The file can also simply be GONE (removed, per the notice's own
			// "or removed" offer) - loadSidecar then finds nothing, no lock
			// re-arms, and the note starts fresh. That is not a repair.
			if (told) this.host.notify(
				rec.lastAdoptFound
					? "Handwriting: this note's ink file is readable again. The saved ink is restored and saving is back on."
					: "Handwriting: this note's damaged ink file is gone. The note starts fresh, and saving is back on."
			);
			if (rec.strokes.length > 0 || rec.localStrokeIds.size > 0) this.schedule(rec);
		}
		return changed;
	}

	/**
	 * Lock a note whose ink file could not be read, without telling the user a
	 * good file is broken: the same hold for a read that threw (answered
	 * transient) and for a load that rejected.
	 */
	function holdUnreadQuietly(this: InlineInkStore, rec: NoteRecord): void {
		rec.damagedLocked = true;
		const now = Date.now();
		if (rec.transientSince === null) rec.transientSince = now;
		if (!rec.transientNoticed) {
			rec.damageSilent = true;
			if (now - rec.transientSince >= TRANSIENT_SILENCE_MS) this.noticeTransient(rec);
		}
	}

	/** Load a sidecar into the record, merging ahead of any session strokes. */
	async function adoptSidecar(this: InlineInkStore, rec: NoteRecord, id: string): Promise<boolean> {
		if (!this.host) return false;
		const result = await this.host.loadSidecar(id);
		rec.lastAdoptFound = result !== null;
		if (!result) return false;
		if (result.damaged && result.transient) {
			// The read threw: not damage, "not loaded yet". Locked
			// all the same - with no base page, a save would write the session's
			// strokes over a file that may be perfectly healthy - but silent,
			// because telling the user a good file is broken is the reported
			// defect. The poll re-reads it. Silence is bounded: a stroke on the
			// note (persist) or 60 s of reads that keep throwing gives one plain
			// notice.
			this.holdUnreadQuietly(rec);
			return false;
		}
		if (result.damaged) {
			rec.damagedLocked = true;
			rec.damageSilent = false;
			rec.transientSince = null;
			// The plain "not read yet" notice does not cover real damage.
			if (rec.transientNoticed) {
				rec.transientNoticed = false;
				rec.noticed = false;
			}
			this.noteOnce(
				rec,
				"Handwriting cannot read the saved ink for this note (" +
					(result.damagedPath ?? ".handwriting/" + id + ".json") +
					"). The file has not been overwritten. New ink on this note will not be saved until that file is repaired, restored from a backup or sync copy, or removed."
			);
			return false;
		}
		if (result.data.surface !== "inline") {
			// A legacy canvas page. Its geometry means nothing over the editor
			// and our writes would destroy it. Hands off in both directions.
			// Checked BEFORE the version, because this one really is
			// unrenderable here whatever schema wrote it.
			rec.legacyLocked = true;
			return false;
		}
		if (result.futureVersion !== undefined) {
			// Read-only, not invisible. This used to return here, so a note
			// whose sidecar came from a newer build showed NO ink at all -
			// which reads as the data loss the lock exists to prevent. The
			// canvas view has always rendered what it recognises while
			// refusing to write ("it opens read-only so nothing is lost"),
			// and parsePage has already migrated exactly that much. persist()
			// refuses outright for a future-locked record, so putting the ink
			// on screen cannot lead to writing it back.
			rec.futureLocked = true;
			// One exception, and it is the whole reason this is not simply a
			// deleted `return`: decoding ZERO strokes out of a schema we do
			// not fully understand is ambiguous. The newer build may have
			// erased everything, or may have written the strokes in a form
			// this build cannot read, and nothing here can tell those apart.
			// Adopting would blank the note on the second reading, so
			// whatever is already on screen stays.
			if (result.data.strokes.length === 0) return false;
		}
		const choicesBefore = choicesKeyOf(rec);
		rec.basePage = result.data;
		if (choicesKeyOf(rec) !== choicesBefore) this.emitChoicesOf(rec);
		// Ink drawn while this read was in flight is in the frame of the size the
		// editor latched then (`rec.fontRefPx`, through setFontRefPx). From here
		// on the size stored with the note wins (fontRefPx), so that ink moves
		// into it, in place, once: the latch then names the stored size, and a
		// later adoption of the same record finds nothing left to move. Without
		// this the stroke jumped by stored/latched after it landed and was saved
		// at the wrong place.
		const stored = result.data.fontRefPx;
		const latched = rec.fontRefPx;
		let reframed = false;
		if (stored !== undefined && latched !== undefined && stored > 0 && latched > 0 && stored !== latched) {
			const savedIds = new Set(result.data.strokes.map((stroke) => stroke.id));
			for (const stroke of rec.strokes) {
				if (!rec.localStrokeIds.has(stroke.id) || savedIds.has(stroke.id)) continue;
				scaleStroke(stroke, stored / latched);
				reframed = true;
			}
			rec.fontRefPx = stored;
		}
		// The remote page owns saved order and unchanged cached IDs. Only an
		// actual session operation may override its copy of an ID; a missing
		// locally changed ID is a deletion. Cached strokes absent remotely do
		// not resurrect. New local ink follows the remote ink in session order.
		const local = new Map(rec.strokes.map((stroke) => [stroke.id, stroke]));
		const merged: InkStroke[] = [];
		const seen = new Set<string>();
		for (const saved of result.data.strokes) {
			if (seen.has(saved.id)) continue;
			seen.add(saved.id);
			const stroke = rec.localStrokeIds.has(saved.id) ? local.get(saved.id) : saved;
			if (stroke) merged.push(stroke);
		}
		for (const stroke of rec.strokes) {
			if (!seen.has(stroke.id) && rec.localStrokeIds.has(stroke.id)) {
				merged.push(stroke);
				seen.add(stroke.id);
			}
		}
		rec.strokes = merged;
		return result.data.strokes.length > 0 || reframed;
	}

	/** Capture only an in-memory identity; this never claims or loads a note. */
	function captureHistoryIdentity(this: InlineInkStore, path: string): symbol {
		return this.record(path).historyIdentity;
	}

	/** A removed record cannot resolve, even if its path or durable id is reused. */
	function pathForHistoryIdentity(this: InlineInkStore, identity: symbol): string | null {
		for (const [path, rec] of this.byPath) {
			if (rec.historyIdentity === identity) return path;
		}
		return null;
	}

	/** The page id the session knows for this note (post-load/claim), if any. */
	function pageIdOf(this: InlineInkStore, path: string): string | null {
		return this.byPath.get(path)?.pageId ?? null;
	}

	/**
	 * Where the note carrying this page id lives NOW, or null.
	 *
	 * The inverse of pageIdOf, and the reason ops carry an identity: a rename
	 * re-keys this map, so an op recorded before it names a path nothing
	 * lives at. A scan, because renames and undos are not hot paths and the
	 * map holds only notes this session has touched.
	 */
	function pathForPageId(this: InlineInkStore, pageId: string): string | null {
		for (const [path, rec] of this.byPath) {
			if (rec.pageId === pageId) return path;
		}
		return null;
	}

	/** Fail-closed flag: the persisted payload was unreadable (see NoteRecord). */
	function isDamagedLocked(this: InlineInkStore, path: string): boolean {
		return this.byPath.get(path)?.damagedLocked ?? false;
	}

	/**
	 * Whether this note's ink may be deleted, and on what terms.
	 *
	 * A DISCRIMINATOR, not a boolean, because the four states are four
	 * different actions and a caller that rounds them together produces the
	 * defect this exists to fix: a note whose save lock silently drops every
	 * write, told that a copy was kept.
	 *
	 * - `ready`    the ordinary writable note.
	 * - `damaged`  the EXISTING intentional session-only branch. The file on
	 *              disk is the artifact being protected, the wipe writes
	 *              nothing there, and only session strokes clear. Kept
	 *              distinct rather than folded into `blocked`.
	 * - `blocked`  a lock under which `snapshot()` refuses, so nothing this
	 *              command does can reach disk.
	 * - `unknown`  no record, no host, or no page id: nothing to say.
	 *
	 * FUTURE AND DUPLICATE TAKE PRECEDENCE OVER DAMAGED, deliberately: a note
	 * can carry both, and the session-only branch is only correct when the
	 * damage is the ONLY reason the write would not land.
	 *
	 * `legacy` is reported as blocked alongside them. The 17:22 ruling
	 * names future and duplicate explicitly and does not name legacy; it is
	 * included here because `snapshot()` refuses for it identically, so the
	 * write dies in exactly the same place - and because a legacy note's
	 * saved ink never reaches memory at all (`adoptSidecar` returns before the
	 * merge), which makes a "copy is kept" claim about it doubly untrue. Named
	 * in the handback as an extension beyond the literal ruling rather than
	 * folded in silently.
	 */
	function deleteAllReadiness(this: InlineInkStore, path: string): InlineDeleteReadiness {
		const rec = this.byPath.get(path);
		if (!rec || !this.host) return { kind: "unknown" };

		// KNOWN LOCKS ARE ANSWERED BEFORE MISSING IDENTITY, and the order is
		// the point rather than a tidy-up. A future-locked or duplicate-locked
		// record that has no page id yet is a REACHABLE state, and testing the
		// id first reported it as `unknown` - collapsing a lock this store
		// already knows about into "we know nothing", and losing the typed
		// reason a refusal is supposed to be able to name.
		if (rec.futureLocked) return { kind: "blocked", lock: "future" };
		if (rec.duplicateLocked) return { kind: "blocked", lock: "duplicate" };
		if (rec.legacyLocked) return { kind: "blocked", lock: "legacy" };

		if (!rec.pageId) return { kind: "unknown" };

		// SETTLED, OR NOTHING. A record still loading, claiming or reloading
		// can qualify as ready and then change under the command's own awaits,
		// and the two ends of this command do not even read the same list:
		// `captureDeleteAll` certifies RAW `rec.strokes`, while the clear runs
		// through `strokes(path)`, which filters to local ids while `reloading`.
		//
		// The dangerous shape is the EMPTY one. An unsettled record holds no
		// strokes in memory yet its sidecar can be full of ink, so a capture
		// taken there is empty - and an empty capture is exactly the case the
		// command lets past its backup verification, on the reasoning that
		// there was nothing to preserve. That reasoning is only true once the
		// record is settled; before that it is "I have not looked", which is
		// the fail-open shape: could-not-preserve read as nothing-to-preserve.
		if (
			rec.load !== "yes" ||
			rec.loadInFlight !== null ||
			rec.claimInFlight !== null ||
			rec.reloading
		) {
			return { kind: "unsettled" };
		}

		// A lock from a read that threw is not damage: the file may be healthy,
		// so the session-only clear that damage allows would discard ink the
		// user was told is only waiting to be saved. Refuse instead.
		if (rec.damagedLocked && (rec.damageSilent || rec.transientNoticed)) {
			return { kind: "blocked", lock: "transient" };
		}
		if (rec.damagedLocked) return { kind: "damaged" };
		return { kind: "ready" };
	}

	/**
	 * An immutable, ordered record of exactly the ink a delete-all would
	 * destroy, taken synchronously before any await.
	 *
	 * INCLUDES EACH TARGETED STROKE'S `unknownByObject` ENTRY. A stroke's
	 * forward-compatible keys are content this command is about to destroy
	 * just as much as its points are, and they are not carried on the stroke
	 * object - they sit beside it on the page, keyed by id. Comparing only
	 * `page.strokes` would certify a backup that had dropped them.
	 *
	 * Deep-copied through the same helper the adoption route uses, because the
	 * record's stroke objects are LIVE - `moveStrokes` translates them in
	 * place - so a shallow capture would silently follow the ink it is
	 * supposed to be a fixed record of.
	 */
	function captureDeleteAll(this: InlineInkStore, path: string): InlineDeleteCapture | null {
		const rec = this.byPath.get(path);
		if (!rec || !rec.pageId) return null;
		const unknown = rec.basePage?.unknownByObject ?? {};
		const targets: InlineDeleteTarget[] = rec.strokes.map((s) => ({
			stroke: deepCopy(s),
			unknown: unknown[s.id] ? deepCopy(unknown[s.id]!) : null,
		}));
		return {
			path,
			pageId: rec.pageId,
			identity: rec.historyIdentity,
			generation: rec.mutationGeneration,
			targets,
		};
	}

	/**
	 * Does the note RIGHT NOW hold exactly the ink the capture recorded?
	 *
	 * EXACT AND UNROUNDED, on purpose. This is the post-await qualification,
	 * and its job is to refuse when anything changed while the backup ran -
	 * including a change too small for the persisted codec to represent. A
	 * comparison at saved precision would call a sub-codec edit "unchanged"
	 * and clear ink the backup does not describe.
	 *
	 * AND THE GENERATION IS CHECKED ALONGSIDE THE CONTENT, not instead of it.
	 * The two catch opposite things and neither is redundant: the counter
	 * catches remove-and-re-add of identical ink, which compares equal because
	 * it IS equal; the content comparison catches a held stroke reference
	 * mutated in place, which leaves the counter alone. A guard that kept only
	 * one of them would pass exactly the case the other exists for.
	 */
	function currentMatchesCapture(this: InlineInkStore, capture: InlineDeleteCapture): boolean {
		const rec = this.byPath.get(capture.path);
		if (!rec || rec.pageId !== capture.pageId) return false;
		if (rec.historyIdentity !== capture.identity) return false;
		if (rec.mutationGeneration !== capture.generation) return false;
		const now = this.captureDeleteAll(capture.path);
		if (!now) return false;
		return JSON.stringify(now.targets) === JSON.stringify(capture.targets);
	}

	/**
	 * Does `page`, read back from the artifact `preserve` actually returned,
	 * contain the captured ink?
	 *
	 * AT PERSISTED PRECISION, and that asymmetry with the check above is the
	 * point: the trash copy is an ordinary save, so the only honest question
	 * is whether it holds what an ordinary save of the capture would have
	 * held. Comparing the raw capture against saved bytes would refuse every
	 * correct backup for rounding the codec is supposed to do.
	 *
	 * Payloads, not ids or counts: the capture is put through the real codec
	 * and the results compared whole, including each stroke's unknown keys.
	 *
	 * `raw` IS THE ARTIFACT'S OWN JSON, and it is what stops this refusing
	 * correct backups forever. `preserve` copies the sidecar's BYTES, while the
	 * capture is memory - and memory came from a parser that could invent values
	 * for fields the file omits (it stamped a missing `createdAt` with
	 * `Date.now()` before the fallback became a fixed 0). Memory then held the value stamped when the
	 * note opened, the readback held the value stamped at delete time, and no
	 * amount of round-tripping brought those together: the difference was WHEN
	 * each was invented, not how many times it was encoded. Measured, not
	 * assumed - putting both sides through one more codec pass leaves the case
	 * failing exactly as it did.
	 *
	 * So an INVENTED field the artifact does not carry is not compared. It
	 * cannot have been lost by a byte copy of a file that never held it, and a
	 * restore will re-invent it exactly as the open did. Everything else is
	 * compared in full, and a field the artifact DOES carry is compared even
	 * when it is one of these.
	 *
	 * ONLY `PARSER_INVENTED_STROKE_FIELDS` IS SKIPPED, deliberately, rather
	 * than every key the file happens to lack. The file and memory do not share
	 * a vocabulary - a v1 sidecar stores `pts` where this build writes `ptsd`,
	 * and neither is the in-memory `points` - so "skip what the artifact does
	 * not name" would drop a stroke's whole geometry on an older file and call
	 * an empty copy a match.
	 *
	 * Omitting `raw` compares everything, which is the correct answer for a
	 * caller that has no artifact text to speak for.
	 */
	function backupMatchesCapture(this: InlineInkStore, capture: InlineDeleteCapture, page: PageData, raw?: unknown): boolean {
		if (page.surface !== "inline") return false;
		if (page.pageId !== capture.pageId) return false;
		const asSaved = this.throughCodec(capture);
		if (asSaved === null) return false;
		const absent = inventedFieldsIn(raw);
		const got = page.strokes.map((s) => ({
			stroke: s,
			unknown: page.unknownByObject?.[s.id] ?? null,
		}));
		if (got.length !== asSaved.length) return false;
		return got.every((entry, i) => {
			const drop = absent?.get(entry.stroke.id);
			return (
				JSON.stringify(withoutFields(entry, drop)) ===
				JSON.stringify(withoutFields(asSaved[i], drop))
			);
		});
	}

	/** The capture as the ordinary persisted codec would have written it. */
	function throughCodec(this: InlineInkStore, capture: InlineDeleteCapture): unknown[] | null {
		try {
			const page = emptyPage(capture.pageId);
			page.surface = "inline";
			page.strokes = capture.targets.map((t) => t.stroke);
			for (const t of capture.targets) {
				if (t.unknown) page.unknownByObject[t.stroke.id] = t.unknown;
			}
			const round = parsePage(serializePage(page), capture.pageId);
			if (round.damaged) return null;
			return round.data.strokes.map((s) => ({
				stroke: s,
				unknown: round.data.unknownByObject?.[s.id] ?? null,
			}));
		} catch (err) {
			console.error("[handwriting] could not round-trip the delete-all capture", err);
			return null;
		}
	}

	/**
	 * Is this note a Handwriting page, meaning it carries spatial state? True when the
	 * session has strokes or an id for it, or the note's frontmatter already
	 * carries a `handwriting-page-id` (cheap metadata read, no file I/O). Drives
	 * presentation only (the `handwriting-page` class); never mutates anything.
	 */
	function isHandwritingPage(this: InlineInkStore, path: string): boolean {
		const rec = this.byPath.get(path);
		if (rec && (rec.strokes.length > 0 || rec.pageId)) return true;
		return (this.host?.readPageId(path) ?? null) !== null;
	}

export function installInlineInkStoreLoad(proto: InlineInkStore): void {
	installMethods(proto, {
		isLoaded,
		ensureLoaded,
		refreshOnReopen,
		loadRecord,
		trackLoad,
		retryDamaged,
		holdUnreadQuietly,
		adoptSidecar,
		captureHistoryIdentity,
		pathForHistoryIdentity,
		pageIdOf,
		pathForPageId,
		isDamagedLocked,
		deleteAllReadiness,
		captureDeleteAll,
		currentMatchesCapture,
		backupMatchesCapture,
		throughCodec,
		isHandwritingPage,
	});
}
