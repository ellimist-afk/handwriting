/**
 * The inline ink store's adoption, persistence and vault lifecycle methods: the external-change adoption and reload, the save path (persist, claim, snapshot, schedule, settle),
 * the vault rename, delete and duplicate-id handling, and the carry of a note's own ink. They are methods of InlineInkStore, installed on its prototype when InlineInkStore.ts loads.
 */
import { UnreadableFrontmatterError } from "./InlineClaim";
import { emptyPage, newPageId, PageData } from "../model/PageData";
import { type ExternalAdoptionPrep } from "../persistence/PageStore";
import { forkFromAdoption, recordFork } from "../persistence/ForkResolution";
import { runDetached } from "../util/Detached";
import { notifyInkChanged } from "./InkEvents";
import { installMethods } from "./InstallMethods";
import { ADOPTION_QUIET_MS, ADOPTION_RUN_GAP_MS, ADOPTION_STILL_FAILING, type ExternalAdoptionHeldReason, type ExternalAdoptionResult, INK_FILE_MISSING, inkFingerprint, type NoteRecord, InlineInkStore } from "./InlineInkStore";

declare module "./InlineInkStore" {
	interface InlineInkStore {
		reloadExternal(path: string): Promise<boolean>;
		adoptExternal(path: string, canAdopt?: () => boolean): Promise<ExternalAdoptionResult>;
		noteAdoptionFailure(rec: NoteRecord, fileMissing?: boolean): void;
		cacheStats(): { notes: number; strokes: number; points: number };
		restoreRevision(pageId: string, page: PageData): Promise<string | null>;
		save(path: string): void;
		persist(path: string, rec: NoteRecord): void;
		trackPersist(work: Promise<void>, label: string): void;
		claim(path: string, rec: NoteRecord): Promise<void>;
		retryRefusedClaim(path: string): void;
		snapshot(rec: NoteRecord): PageData | null;
		schedule(rec: NoteRecord): void;
		scheduleFirst(rec: NoteRecord): void;
		settle(maxWaitMs?: number): Promise<boolean>;
		noteOnce(rec: NoteRecord, message: string): void;
		noticeTransient(rec: NoteRecord): void;
		handleRename(oldPath: string, newPath: string): void;
		dropRenamesTouching(path: string): void;
		consumeRename(from: string, to: string): boolean;
		handleDelete(path: string): void;
		markDuplicateLocked(path: string, otherPath: string): void;
		clearDuplicateLock(path: string): void;
		isDuplicateLocked(path: string): boolean;
		handleDeclaimed(path: string): void;
		carryOwnInk(path: string, rec: NoteRecord): void;
		reassignPage(copyPath: string, newId: string, ownerPath: string): "rescheduled-owner" | "old-queue-orphaned";
		scheduleLoaded(path: string, rec: NoteRecord): void;
	}
}

const ADOPTION_UNAVAILABLE: ExternalAdoptionResult = { outcome: "unavailable", changed: false };

const TRANSIENT_NOTICE =
	"Handwriting: this note's ink file could not be read yet. New ink on it is not saved until it loads.";

function adoptionHeld(reason: ExternalAdoptionHeldReason): ExternalAdoptionResult {
	return { outcome: "held", changed: false, reason };
}

/** Only a current, synchronous caller qualification can authorize adoption. */
function admissionAllowed(canAdopt: (() => boolean) | undefined): boolean {
	try {
		return canAdopt?.() === true;
	} catch {
		// An unavailable pane binding is a hold, never authority to replace ink.
		return false;
	}
}

/**
 * An immutable copy of a page, for preservation across an await.
 *
 * The record's strokes are LIVE objects - `moveStrokes` translates them in
 * place - so handing the record's own arrays to an awaited write would preserve
 * whatever the ink BECAME while that write ran, filed under the name of the
 * revision it started as. A deep copy is not a codec step: this is the same
 * plain JSON payload that goes to disk, with no quantisation and no schema
 * migration, so nothing is lost by making it.
 */
function freezePage(page: PageData): PageData {
	return typeof structuredClone === "function"
		? structuredClone(page)
		: (JSON.parse(JSON.stringify(page)) as PageData);
}

function hasChoice(rec: NoteRecord): boolean {
	return (rec.choices?.canvas ?? null) !== null || (rec.choices?.paper ?? null) !== null;
}


	/**
	 * Adopt an external sidecar edit (another device, via sync) by
	 * rebuilding the record through the NORMAL load path, so the damage,
	 * future-version and legacy-surface locks all re-apply and basePage is
	 * replaced wholesale from the fresh parse. Only a settled, clean record
	 * reloads: the caller has verified the disk actually changed and that
	 * no gesture is active; this guards the record's own state. CM ink
	 * history survives a reload - an op that no longer matches skips its
	 * missing ids, which is bounded weirdness, and clearing a user's undo
	 * because another machine wrote would be worse.
	 */
	async function reloadExternal(this: InlineInkStore, path: string): Promise<boolean> {
		const rec = this.byPath.get(path);
		if (!rec || rec.load !== "yes") return false;
		if (rec.loadInFlight || rec.claimInFlight) return false;
		// duplicateLocked included: dropping the record resets the lock to
		// false and the next stroke would write into the SHARED sidecar -
		// the exact corruption the lock fails closed against (ultrareview).
		if (rec.damagedLocked || rec.legacyLocked || rec.futureLocked || rec.duplicateLocked) {
			return false;
		}
		// Repaint only when the INK differs. The adopted-strokes flag from
		// the load reads an erase-to-empty as a non-event; a blanket true
		// (the first fix) made every reload repaint, and a platform whose
		// stat misfires (ios mtime quirks) then flickers every poll tick.
		// The fingerprint covers ids and positions, so erase, add, paste
		// and move all repaint, and identical content never does.
		const before = inkFingerprint(rec.strokes);
		// The record is KEPT, because clearing first is only safe if the
		// re-read succeeds. A sidecar being written by a sync client at this
		// moment reads as damaged, and the poll picks exactly those moments:
		// it fires BECAUSE the file just changed. Dropping the record there
		// emptied the note on screen and, since the fresh record has no page
		// id until the next claim, disabled saving until the note was
		// reopened - and if the file had gone rather than merely being
		// unreadable, that session copy was the only ink left.
		// PdfInkStore.reloadExternal has guarded this since it was written, on
		// this same evidence - but NOT by the same mechanism, and the two have
		// diverged. That store still takes the old route: it saves the strokes
		// aside and empties the record (`const kept = rec.strokes;`,
		// PdfInkStore.ts:285), then puts them back if the re-read fails. This
		// one no longer clears at all, so there is no window to restore FROM
		// and no failure path that can leave the record empty - strictly the
		// stronger of the two. Do not read the pdf store's clear-and-restore as
		// the pattern to copy here, and if you are hardening THAT store, this
		// is the shape to move it toward rather than the other way round.
		// (Comment corrected 2026-09-07: it claimed the two guards were the
		// same. The evidence above is unchanged and is why either exists.)
		// Keep visible strokes available to move/erase operations during I/O.
		// The caller established a clean record, so only mutations from here
		// onward can override the freshly read page.
		rec.localStrokeIds.clear();
		rec.reloading = true;
		// The BASE PAGE is kept for the same reason and was not, which cost
		// more than the strokes would have. It carries the text boxes, the
		// images and every forward-compatible field this build does not know
		// about, and `snapshot()` spreads it into the next write: a record put
		// back with `basePage` still null falls to `emptyPage(pageId)` there
		// and the next save writes `textBoxes: []` over the disk copy.
		const keptBase = rec.basePage;
		rec.basePage = null;
		await this.loadRecord(path, rec, { basePage: keptBase });
		// Joining viewers need the restored picture even when existing panes
		// still show identical ink. Only actual changes notify the poller.
		return inkFingerprint(this.strokes(path)) !== before;
	}

	/**
	 * ADOPT AN EXTERNAL SIDECAR EDIT WITHOUT LOSING THE OUTGOING REVISION.
	 *
	 * `reloadExternal` above rebuilds the record from whatever is on disk. That
	 * is correct when the incoming file is a superset, and it is silent data
	 * loss when it is not: the outgoing revision leaves the record and the save
	 * baseline moves to the incoming one, so nothing anywhere still holds what
	 * this device had. Across devices that were offline for hours, "not a
	 * superset" is the ordinary case.
	 *
	 * This route does not make the two revisions converge - it makes losing
	 * either one impossible. When the incoming revision would lose anything the
	 * outgoing one holds, both are written as independently recoverable
	 * siblings FIRST; only then does the record release the outgoing one. When
	 * it loses nothing, there is nothing to recover and no pair is written. What
	 * the user sees afterwards is still a single revision, and reconciling the
	 * fork is a separate question that needs per-writer version vectors this
	 * layer does not have.
	 *
	 * TWO PHASES, because the preservation is I/O and a pen does not wait. The
	 * record is untouched while it runs; everything the adoption is allowed to
	 * assume is captured before the first await and re-proved after it, in one
	 * synchronous run with the adoption itself. Any mutation, any lock, any
	 * newer external generation, any failure: the prepared result is dropped,
	 * the artifacts already written are kept, and current ink, base, local
	 * mutation markers and history are exactly as they were.
	 */
	async function adoptExternal(this: InlineInkStore, path: string, canAdopt?: () => boolean): Promise<ExternalAdoptionResult> {
		const rec = this.byPath.get(path);
		const host = this.host;
		if (!rec) return ADOPTION_UNAVAILABLE;
		if (!host) return adoptionHeld("missing-capability");
		// Both halves or neither: half of this route is the loss it prevents.
		const prepare = host.prepareExternalAdoption?.bind(host);
		const accept = host.acceptExternalAdoption?.bind(host);
		if (!prepare || !accept) return adoptionHeld("missing-capability");
		// An established record must also be settled and writable before capture.
		if (rec.load !== "yes" || rec.loadInFlight || rec.claimInFlight) {
			return adoptionHeld("unsettled");
		}
		// A damaged (or not-yet-readable) record has nothing adopted to
		// preserve: its file changed, so re-read it through the heal path,
		// which merges the saved ink ahead of anything drawn while locked and
		// saves it. Still unreadable: the lock re-arms and this holds.
		if (rec.damagedLocked && !rec.legacyLocked && !rec.futureLocked && !rec.duplicateLocked) {
			if (!admissionAllowed(canAdopt)) return adoptionHeld("admission-changed");
			const changed = await this.retryDamaged(rec);
			if (rec.damagedLocked) return adoptionHeld("existing-lock");
			return { outcome: "adopted", changed };
		}
		if (rec.damagedLocked || rec.legacyLocked || rec.futureLocked || rec.duplicateLocked) {
			return adoptionHeld("existing-lock");
		}
		// The caller owns pane gestures, selections and queued-write eligibility.
		// Missing qualification holds too; record stability cannot prove them.
		if (!admissionAllowed(canAdopt)) return adoptionHeld("admission-changed");
		const id = rec.pageId;
		const outgoing = this.snapshot(rec);
		if (!id || !outgoing) return adoptionHeld("no-snapshot");
		// CAPTURED BEFORE THE FIRST AWAIT. The frozen copy is what gets
		// preserved, so the artifact is the revision this decision was made
		// about and not whatever the ink became while the write ran.
		const generation = rec.mutationGeneration;
		const basePage = rec.basePage;
		const frozen = freezePage(outgoing);
		// THE CAPTURE, COMPARED AS CONTENT AND NOT AS PERSISTED BYTES. This was
		// `serializePage(frozen)`, which put the qualification behind the same
		// lossy codec the live file uses: a mutation below the codec's
		// resolution - x by 0.0004, pressure by 0.0004, t by less than a
		// millisecond - serialized to identical bytes, so the comparison
		// answered "unchanged" and a stale preparation replaced the mutated
		// record. There is no "too small to count" mutation here; the record
		// being replaced is the mutated one either way.
		//
		// JSON of the same-shaped snapshot is a sound content comparison: both
		// sides are built by `snapshot()` in one order, so equal strings mean
		// equal content, and anything else refuses. It errs toward refusing,
		// which is the safe direction - a refusal costs one poll tick.
		const capturedJson = JSON.stringify(frozen);
		const before = inkFingerprint(rec.strokes);
		let prep: ExternalAdoptionPrep;
		try {
			prep = await prepare(id, frozen);
		} catch (err) {
			// Preservation could not be completed. Nothing was adopted and
			// nothing acknowledged, so the note is exactly where it was, both
			// versions are still on disk, and THE NEXT POLL TRIES AGAIN a
			// second later.
			//
			// QUIET WHILE IT IS STILL TRYING, then speak once if it does not
			// recover (alan, 1.4.13: "then dont do a toast", "we dont
			// wanna terrify them for no reason", then "yes the middle option").
			//
			// A single failure is usually a sync client mid-transfer, and it
			// is gone a second later. Telling the user then is alarming for
			// nothing: their ink is on screen, both versions are on disk, and
			// the retry is automatic. But a failure that PERSISTS is different
			// - it means this note has quietly stopped receiving the other
			// device's ink, which is exactly the silence that reads as sync
			// being broken. So the notice waits for the difference between
			// those two to show itself.
			//
			// The console line is unconditional, so a real fault is
			// diagnosable from the first occurrence even while the UI is quiet.
			console.error("[handwriting] could not preserve both versions of this note's ink", path, err);
			this.noteAdoptionFailure(rec);
			return adoptionHeld("io-failure");
		}
		if (prep.kind === "unavailable") {
			// A missing live sidecar can be a sync replacement between unlink and
			// rename. Hold it like every preservation refusal, but use the typed
			// diagnostic to start the existing quiet-period/once-only notice. The
			// prose `why` is deliberately not control flow.
			// An incoming file this note cannot use (damaged, a newer schema,
			// another surface) is held too; held for long, it says so.
			if (prep.reason === "no-live-sidecar") this.noteAdoptionFailure(rec, true);
			else if (prep.reason === "incoming-unusable") this.noteAdoptionFailure(rec);
			return adoptionHeld("preservation-unavailable");
		}
		// Stale is the benign race, not a fault: a newer revision landed while
		// the copies were being written, every artifact is kept, and the newer
		// one is still detectable. Saying nothing is the honest answer.
		//
		// It is also PROOF the disk read this round succeeded - `prepare`
		// above did real I/O and came back with an answer. A quiet period
		// armed by an earlier failure must not survive a round that proves
		// the trouble is over, or one unrelated blip much later shows the
		// notice at once instead of waiting through the quiet period again
		// (audit 128). Every return below this point shares that proof.
		if (prep.kind === "stale") {
			rec.adoptionFailingSince = null;
			return adoptionHeld("stale");
		}
		// SYNCHRONOUS FROM HERE TO THE ADOPTION. Not one await may separate
		// these checks from the assignment below.
		if (
			this.byPath.get(path) !== rec ||
			rec.pageId !== id ||
			rec.basePage !== basePage ||
			rec.mutationGeneration !== generation ||
			rec.load !== "yes" ||
			rec.loadInFlight ||
			rec.claimInFlight ||
			rec.damagedLocked ||
			rec.legacyLocked ||
			rec.futureLocked ||
			rec.duplicateLocked
		) {
			// LOCAL SUPERSEDES: the record moved on while preparation ran (a
			// mutation, a new claim, a lock). Disk I/O still succeeded.
			rec.adoptionFailingSince = null;
			return adoptionHeld("unsettled");
		}
		// SECOND QUALIFICATION, because the counter alone trusts every mutation
		// to announce itself. `moveStrokes` translates stroke objects the
		// record still holds by reference, so a snapshot can change content
		// without the list changing. Comparing the whole serialized page closes
		// that by construction rather than by an inventory of callers.
		const current = this.snapshot(rec);
		if (!current || JSON.stringify(current) !== capturedJson) {
			rec.adoptionFailingSince = null; // local supersedes, same as above
			return adoptionHeld("unsettled");
		}
		// Preservation awaited: an uncommitted gesture can start without changing
		// the record. Recheck the caller immediately before acknowledging bytes.
		if (!admissionAllowed(canAdopt)) {
			rec.adoptionFailingSince = null; // local supersedes, same as above
			return adoptionHeld("admission-changed");
		}
		accept(prep.prepared);
		// The existing clean-adoption semantics: the incoming revision becomes
		// the base and the visible ink. No union of missing ids - that is the
		// deliberate non-solution, and the outgoing ids stay recoverable from
		// the artifact instead.
		const choicesBefore = this.choicesKey(path);
		rec.basePage = prep.prepared.data;
		rec.strokes = prep.prepared.data.strokes.slice();
		rec.localStrokeIds.clear();
		// The other device's choices come with its file, as its strokes do:
		// the last device to save wins.
		rec.choices = undefined;
		if (this.choicesKey(path) !== choicesBefore) this.emitChoices(path);
		// The incoming file's reference is the frame its ink is in. The record's
		// own latch follows it, so a later read of this record does not move ink
		// drawn after the adoption by the old ratio.
		const incomingRef = prep.prepared.data.fontRefPx;
		if (incomingRef !== undefined && incomingRef > 0) rec.fontRefPx = incomingRef;
		rec.adoptionNoticed = false;
		rec.adoptionFailingSince = null;
		// NO NOTICE ON SUCCESS (alan, 1.4.13: "kill the second message
		// definitely"). This is the ORDINARY path - it runs every time two
		// devices touch the same note, which in a synced vault is routine - and
		// it told the user so, naming two `.handwriting/` filenames they cannot
		// browse to from Obsidian. Announcing that everything worked, with
		// paths, on every sync, is noise that teaches people to dismiss our
		// notices unread; and the next one they dismiss might be the one that
		// mattered.
		//
		// The paths are still returned on the result for the caller and still
		// logged, so nothing became undiagnosable - only unannounced.
		const adopted: ExternalAdoptionResult = {
			outcome: "adopted",
			changed: inkFingerprint(rec.strokes) !== before,
			outgoingPath: prep.prepared.outgoingPath,
			incomingPath: prep.prepared.incomingPath,
		};
		// REGISTERED HERE RATHER THAN AT THE POLL, and not for tidiness: the
		// poll's adoption block is sliced out of main.ts verbatim and executed
		// by `LiveReloadTestHarness` with a fixed list of injected names, so a
		// new identifier in that block is undefined in four suites at runtime.
		// This is the other place that holds the page id, the note path and
		// both artifact paths at once.
		//
		// Recording is a map write and no I/O, and only an adoption that wrote a
		// pair records anything (an adoption that lost nothing wrote none).
		// Whether a fork is put to the user is still decided when the surface is
		// opened. Nothing here is announced - the success-silence rule
		// (`d50534a`) is settled and this does not touch it.
		const fork = forkFromAdoption(id, path, adopted, Date.now());
		if (fork) recordFork(fork);
		return adopted;
	}

	/**
	 * The external-adoption failure notice, once per record. The poll runs
	 * every second and a failing disk keeps failing, so an unlatched notice
	 * would bury the screen. Cleared by a successful adoption, so a later,
	 * different failure can still speak. `fileMissing`: the note's live ink
	 * file is not on disk, which has its own words; a read failure keeps the
	 * slow-load ones.
	 */
	function noteAdoptionFailure(this: InlineInkStore, rec: NoteRecord, fileMissing = false): void {
		if (rec.adoptionNoticed) return;
		const now = Date.now();
		// The clock starts on the FIRST failure of this run, not on the notice.
		// Cleared by a successful adoption, so a transfer that settles resets
		// the patience rather than spending it.
		if (
			rec.adoptionFailingSince !== null &&
			rec.adoptionLastFailureAt !== null &&
			now - rec.adoptionLastFailureAt > ADOPTION_RUN_GAP_MS
		) {
			// The run ended quietly (unchanged polls); this is a new one.
			rec.adoptionFailingSince = null;
		}
		rec.adoptionLastFailureAt = now;
		if (rec.adoptionFailingSince === null) {
			rec.adoptionFailingSince = now;
			return;
		}
		if (now - rec.adoptionFailingSince < ADOPTION_QUIET_MS) return;
		rec.adoptionNoticed = true;
		this.host?.notify(fileMissing ? INK_FILE_MISSING : ADOPTION_STILL_FAILING);
	}

	/** Diagnostics: what the session cache holds (it never evicts). */
	function cacheStats(this: InlineInkStore): { notes: number; strokes: number; points: number } {
		let strokes = 0;
		let points = 0;
		for (const rec of this.byPath.values()) {
			strokes += rec.strokes.length;
			for (const s of rec.strokes) points += s.points.length;
		}
		return { notes: this.byPath.size, strokes, points };
	}

	/**
	 * Put a restored revision into the note that holds this page, and write it
	 * from there: "Keep this device's ink" on the fork surface.
	 *
	 * Writing the file alone left the loaded record holding the other device's
	 * revision. The screen never changed, the live-reload poll saw the store's
	 * own write and read nothing, and the next stroke wrote the record back over
	 * the restored page. Going through the record makes screen, memory and disk
	 * the same revision.
	 *
	 * Returns the note path when a loaded, writable record held the page, and
	 * null otherwise; the caller then writes the file itself.
	 */
	async function restoreRevision(this: InlineInkStore, pageId: string, page: PageData): Promise<string | null> {
		for (const [path, rec] of this.byPath) {
			if (rec.pageId !== pageId || rec.load !== "yes") continue;
			if (rec.damagedLocked || rec.legacyLocked || rec.futureLocked || rec.duplicateLocked) return null;
			rec.basePage = page;
			rec.strokes = page.strokes.slice();
			rec.localStrokeIds.clear();
			rec.mutationGeneration++;
			const snap = this.snapshot(rec);
			const host = this.host;
			if (snap && host) {
				if (host.scheduleSidecarNow) await host.scheduleSidecarNow(pageId, snap);
				else host.scheduleSidecar(pageId, snap);
			}
			notifyInkChanged(path);
			return path;
		}
		return null;
	}

	/** Persist the current state of a note (gesture end, or an applied op). */
	function save(this: InlineInkStore, path: string): void {
		this.persist(path, this.record(path));
		// The in-memory strokes are already the truth even when the disk
		// write is deferred, so rendered embeds repaint from here.
		notifyInkChanged(path);
	}

	function persist(this: InlineInkStore, path: string, rec: NoteRecord): void {
		if (!this.host) return; // session-memory mode
		// Ink drawn on a note whose file has not been read yet will not be
		// saved until it is: say so now, once, rather than let it go silently.
		if (rec.damagedLocked && rec.damageSilent) this.noticeTransient(rec);
		// Nothing was ever persisted and nothing remains: claiming an id here
		// would stamp a note whose ink came and went entirely in-session
		// (draw + erase, or draw + undo). An untouched-in-the-end note stays
		// untouched. A CLAIMED note skips this and persists emptiness: the id
		// line stays, and erasing your last stroke never un-claims a note.
		if (!rec.pageId && rec.strokes.length === 0 && !rec.basePage && !hasChoice(rec)) return;
		if (rec.legacyLocked) {
			this.noteOnce(
				rec,
				"Handwriting: this note has a canvas page from an older layout. Ink drawn on it in the editor is not saved."
			);
			return;
		}
		if (rec.futureLocked) {
			this.noteOnce(
				rec,
				"Handwriting: this page was written by a newer version of Handwriting. Ink drawn on it is not saved."
			);
			return;
		}
		if (rec.loadInFlight) {
			// The sidecar is still being read. A snapshot now would hold only
			// the session's strokes and, written, replace the persisted ones.
			// Persist again once the merge has happened; every mutation path
			// (commit, erase, move, undo) comes through here.
			this.trackPersist(
				rec.loadInFlight.then(() => this.persist(path, rec)),
				`persist inline ink after loading ${path}`
			);
			return;
		}
		// Refused on unreadable frontmatter: hold the strokes in memory, and
		// do not rewrite the note on every stroke; retryRefusedClaim resumes.
		if (!rec.pageId && rec.claimRefused) return;
		if (!rec.pageId && !rec.claimInFlight) {
			rec.claimInFlight = this.claim(path, rec).finally(() => {
				rec.claimInFlight = null;
			});
		}
		if (rec.claimInFlight) {
			// The reference must exist before the referent: the sidecar write
			// waits for the id to be on disk. Strokes committed meanwhile ride
			// the same record, so the one write that follows carries all of
			// them. Armed once per claim, and written at once when the claim
			// lands: the quiet period was already spent waiting for the id.
			if (!rec.claimFollowUpArmed) {
				rec.claimFollowUpArmed = true;
				this.trackPersist(
					rec.claimInFlight.then(() => {
						rec.claimFollowUpArmed = false;
						this.scheduleFirst(rec);
					}),
					`save inline ink after claiming ${path}`
				);
			}
			return;
		}
		this.schedule(rec);
	}

	function trackPersist(this: InlineInkStore, work: Promise<void>, label: string): void {
		const pending = work.finally(() => this.pendingPersists.delete(pending));
		this.pendingPersists.add(pending);
		runDetached(pending, label);
	}

	async function claim(this: InlineInkStore, path: string, rec: NoteRecord): Promise<void> {
		if (!this.host) return;
		try {
			const proposed = newPageId();
			const result = await this.host.claimId(path, proposed);
			if (result.futureVersion !== undefined) {
				rec.futureLocked = true;
				this.noteOnce(
					rec,
					"Handwriting: this note declares a newer Handwriting format. Ink drawn on it is not saved."
				);
				return;
			}
			rec.pageId = result.pageId;
			if (result.pageId !== proposed) {
				// The file already had an id we did not see at load (another
				// pane, another device, a cold metadata cache). Its sidecar may
				// hold ink; merge it BEFORE our first write can overwrite it.
				await this.adoptSidecar(rec, result.pageId);
			}
		} catch (err) {
			if (err instanceof UnreadableFrontmatterError) {
				// No id written; the strokes stay on screen and in memory, and
				// the claim is retried once Obsidian can read the block.
				rec.claimRefused = true;
				this.noteOnce(
					rec,
					"Handwriting: Obsidian cannot read this note's frontmatter, so its ink is not being saved. Fix the frontmatter to save it."
				);
				return;
			}
			console.error("[handwriting] inline claim failed", err);
			this.noteOnce(rec, "Handwriting: could not write the page id into this note, so its ink is not being saved.");
		}
	}

	/** Obsidian can read the note's frontmatter again: claim now and save what was held. */
	function retryRefusedClaim(this: InlineInkStore, path: string): void {
		const rec = this.byPath.get(path);
		if (!rec || !rec.claimRefused || rec.pageId) return;
		rec.claimRefused = false;
		rec.noticed = false;
		this.persist(path, rec);
	}

	/** The page to write for a record, or null when the record must not write. */
	function snapshot(this: InlineInkStore, rec: NoteRecord): PageData | null {
		if (!this.host || !rec.pageId) return null;
		if (rec.legacyLocked || rec.futureLocked || rec.damagedLocked) return null;
		if (rec.duplicateLocked) return null;
		const base = rec.basePage ?? emptyPage(rec.pageId);
		const fontRefPx = base.fontRefPx ?? rec.fontRefPx;
		const page: PageData = {
			...base,
			pageId: rec.pageId,
			surface: "inline",
			strokes: rec.strokes,
			...(fontRefPx !== undefined ? { fontRefPx } : {}),
		};
		// A choice set this session replaces the file's, including a value
		// this build could not read (kept in unknownTop until now).
		const c = rec.choices;
		if (c && (c.canvas !== undefined || c.paper !== undefined)) {
			page.unknownTop = { ...base.unknownTop };
			if (c.canvas !== undefined) {
				delete page.unknownTop.noteCanvas;
				if (c.canvas === null) delete page.noteCanvas;
				else page.noteCanvas = c.canvas;
			}
			if (c.paper !== undefined) {
				delete page.unknownTop.notePaper;
				if (c.paper === null) delete page.notePaper;
				else page.notePaper = c.paper;
			}
		}
		return page;
	}

	function schedule(this: InlineInkStore, rec: NoteRecord): void {
		const page = this.snapshot(rec);
		if (!this.host || !page || !rec.pageId) return;
		this.host.scheduleSidecar(rec.pageId, page);
	}

	/** The first write after a claim: immediate, and tracked for settle(). */
	function scheduleFirst(this: InlineInkStore, rec: NoteRecord): void {
		const page = this.snapshot(rec);
		if (!this.host || !page || !rec.pageId) return;
		if (!this.host.scheduleSidecarNow) {
			this.host.scheduleSidecar(rec.pageId, page);
			return;
		}
		const write = this.host.scheduleSidecarNow(rec.pageId, page).catch((err) => {
			console.error("[handwriting] first sidecar write failed", err);
		});
		this.firstWrites.add(write);
		runDetached(
			write.finally(() => this.firstWrites.delete(write)),
			"finish tracking the first inline sidecar write"
		);
	}

	/**
	 * Best-effort unload: wait (bounded) for in-flight sidecar reads, identity
	 * claims and the first writes that follow them. Their saves are only
	 * scheduled once they settle, so a flush that runs before this finds
	 * nothing to write. Bounded so a hung vault write cannot wedge shutdown;
	 * several passes, because a load may end by starting a claim. This is not
	 * crash durability: a process killed before the I/O finishes can still
	 * lose pending ink.
	 *
	 * Returns TRUE when everything drained and FALSE when the deadline won -
	 * callers that are about to move files need to know the difference,
	 * because proceeding after a timeout can race a write into a directory
	 * being emptied.
	 */
	async function settle(this: InlineInkStore, maxWaitMs = 2000): Promise<boolean> {
		let expire: (v: boolean) => void = () => {};
		const deadline = new Promise<boolean>((r) => {
			expire = r;
		});
		const timer = window.setTimeout(() => expire(true), maxWaitMs);
		try {
			for (let pass = 0; pass < 4; pass++) {
				const inFlight: Promise<unknown>[] = [...this.firstWrites, ...this.pendingPersists];
				for (const rec of this.byPath.values()) {
					if (rec.claimInFlight) inFlight.push(rec.claimInFlight);
					if (rec.loadInFlight) inFlight.push(rec.loadInFlight);
				}
				if (inFlight.length === 0) return true;
				const timedOut = await Promise.race([
					Promise.all(inFlight).then(() => false),
					deadline,
				]);
				if (timedOut) return false;
			}
			// Four passes and still work arriving: treat it as unsettled.
			return false;
		} finally {
			window.clearTimeout(timer);
		}
	}

	function noteOnce(this: InlineInkStore, rec: NoteRecord, message: string): void {
		if (rec.noticed) return;
		rec.noticed = true;
		this.host?.notify(message);
	}

	/** The one notice a transient lock gives, when its silence runs out. */
	function noticeTransient(this: InlineInkStore, rec: NoteRecord): void {
		if (rec.transientNoticed) return;
		rec.transientNoticed = true;
		rec.damageSilent = false;
		this.noteOnce(rec, TRANSIENT_NOTICE);
	}

	// ---- vault lifecycle --------------------------------------------------------

	/** The note moved. Its ink and its identity (the id is in the file) move too. */
	function handleRename(this: InlineInkStore, oldPath: string, newPath: string): void {
		// Remembered for the editor showing the note: its next update sees the new path and must know it is the
		// same note renamed, not a switch to another one (consumeRename). A to B then B to C keeps only B to C, and
		// renames of notes no editor shows are never consumed, so the oldest entries fall out past the cap.
		this.dropRenamesTouching(oldPath);
		this.renames.set(oldPath, newPath);
		while (this.renames.size > InlineInkStore.RENAMES_CAP) this.renames.delete(this.renames.keys().next().value!);
		const rec = this.byPath.get(oldPath);
		if (!rec) return;
		this.byPath.delete(oldPath);
		this.byPath.set(newPath, rec);
	}

	/** Entries the path is either end of. */
	function dropRenamesTouching(this: InlineInkStore, path: string): void {
		for (const [from, to] of this.renames) if (from === path || to === path) this.renames.delete(from);
	}

	/** True, once, when the vault renamed `from` to `to` since the last ask. */
	function consumeRename(this: InlineInkStore, from: string, to: string): boolean {
		if (this.renames.get(from) !== to) return false;
		this.renames.delete(from);
		return true;
	}

	/** The note is gone; a future note reusing its path starts clean. */
	function handleDelete(this: InlineInkStore, path: string): void {
		const had = this.byPath.delete(path);
		this.dropRenamesTouching(path);
		// Embed layers of a note that held ink must stop drawing it.
		if (had) notifyInkChanged(path);
	}

	// ---- duplicate page ids -------------------------------------------------

	/**
	 * Fail closed on an ambiguous duplicate: this note's writes are blocked
	 * (its id is shared and no safe owner exists) and the user is told once,
	 * with the fix spelled out. Rendering is untouched.
	 */
	function markDuplicateLocked(this: InlineInkStore, path: string, otherPath: string): void {
		const rec = this.record(path);
		if (rec.duplicateLocked) return;
		rec.duplicateLocked = true;
		this.noteOnce(
			rec,
			`Handwriting: this note and "${otherPath}" carry the same handwriting-page-id, so they point at the same ink file. Ink on both is read-only until that is resolved. Delete the handwriting-page-id line from the copy (its next stroke gets a fresh id), or delete one of the notes.`
		);
	}

	/** The collision resolved (an id line was removed, or a note deleted). */
	function clearDuplicateLock(this: InlineInkStore, path: string): void {
		const rec = this.byPath.get(path);
		if (!rec || !rec.duplicateLocked) return;
		rec.duplicateLocked = false;
		rec.noticed = false;
		this.host?.notify("Handwriting: duplicate resolved. Ink on this note saves again.");
		// Strokes drawn while locked were refused at the snapshot and are in
		// memory only. Save them now, or they are gone at restart. An erase
		// down to nothing leaves no strokes but still differs from disk: the
		// changed ids say so.
		if (rec.strokes.length > 0 || rec.localStrokeIds.size > 0) this.persist(path, rec);
	}

	function isDuplicateLocked(this: InlineInkStore, path: string): boolean {
		return this.byPath.get(path)?.duplicateLocked ?? false;
	}

	/**
	 * The note's frontmatter no longer carries an id (the user removed the
	 * line to resolve a duplicate, or edited it away externally). The session
	 * record is stale: its pageId would keep writing into a sidecar the note
	 * no longer references. Drop it; the note starts over as unclaimed, and
	 * its on-screen ink (which belongs to the id's real owner) clears on the
	 * next repaint.
	 *
	 * Also called when a duplicate-locked copy was fixed by editing its id
	 * value: the record still names the shared id the note no longer carries.
	 *
	 * A duplicate lock refused every write, so ink drawn on THIS note while
	 * locked is in memory only, and dropping the record lost it. That ink is
	 * carried into a fresh record, which reads the note's id afresh (the
	 * edited value, or a fresh claim when the line is gone) and saves it
	 * there. Ink that came from the shared sidecar is not carried: it is the
	 * other note's. A record is left for this path only when ink was carried.
	 */
	function handleDeclaimed(this: InlineInkStore, path: string): void {
		const rec = this.byPath.get(path);
		if (!rec || !rec.pageId) return;
		this.byPath.delete(path);
		if (rec.duplicateLocked) this.carryOwnInk(path, rec);
		// Last, once any carried ink is on the new record: embed layers of this
		// note repaint from what `strokes()` answers now.
		notifyInkChanged(path);
	}

	/** The ink a duplicate copy drew itself moves to a fresh record under its own id. */
	function carryOwnInk(this: InlineInkStore, path: string, rec: NoteRecord): void {
		const shared = new Set((rec.basePage?.strokes ?? []).map((s) => s.id));
		const own = rec.strokes.filter((s) => rec.localStrokeIds.has(s.id) && !shared.has(s.id));
		if (own.length === 0) return;
		const fresh = this.record(path);
		fresh.strokes = own;
		for (const s of own) fresh.localStrokeIds.add(s.id);
		fresh.mutationGeneration++;
		// Read first, then persist: the write waits on the read (persist), so
		// the carried ink merges in after whatever the new id's sidecar holds.
		this.trackPersist(
			this.ensureLoaded(path).then(() => undefined),
			`load ${path} for the ink carried off its shared page id`
		);
		this.persist(path, fresh);
	}

	/**
	 * Duplicate resolution: the COPY at `copyPath` has been re-identified to
	 * `newId` (its sidecar clone already exists). Point its live record at
	 * the new id and persist its current state there. Then make the OLD id's
	 * disk state authoritative again: if the owner has a live record, its
	 * state is re-scheduled (latest-wins replaces anything the copy queued
	 * under the old id before resolution); if not, the caller may safely
	 * discard the old id's queue, because the copy's record was provably the
	 * only writer this session.
	 *
	 * Returns whether the owner had a live record ("rescheduled-owner") or
	 * not ("old-queue-orphaned").
	 */
	function reassignPage(this: InlineInkStore,
		copyPath: string,
		newId: string,
		ownerPath: string
	): "rescheduled-owner" | "old-queue-orphaned" {
		const rec = this.byPath.get(copyPath);
		if (rec) {
			rec.pageId = newId;
			rec.duplicateLocked = false;
			// basePage came from the shared sidecar. The clone has the same
			// content under the new id, so it remains the correct save basis
			// (unknown fields survive through it).
			this.scheduleLoaded(copyPath, rec);
		}
		const owner = this.byPath.get(ownerPath);
		if (owner && owner.pageId) {
			this.scheduleLoaded(ownerPath, owner);
			return "rescheduled-owner";
		}
		return "old-queue-orphaned";
	}

	/**
	 * Schedule a record only when its snapshot is built on what the sidecar
	 * holds. A record still loading waits for the load (through persist); a
	 * record that never read the sidecar - never loaded, or loaded while the
	 * note had no id, so basePage is null - has nothing of the file's in it,
	 * and its snapshot would write an empty page over the ink.
	 * Such a record reads the sidecar afresh on its next load; its own
	 * strokes, if any, ride the persist after that load.
	 */
	function scheduleLoaded(this: InlineInkStore, path: string, rec: NoteRecord): void {
		if (rec.loadInFlight) {
			this.persist(path, rec);
			return;
		}
		if (rec.load !== "yes") return;
		if (rec.basePage === null) {
			rec.load = "no";
			if (rec.strokes.length > 0) {
				this.trackPersist(
					this.ensureLoaded(path).then(() => this.persist(path, rec)),
					`persist inline ink after reloading ${path}`
				);
			}
			return;
		}
		this.schedule(rec);
	}

export function installInlineInkStorePersist(proto: InlineInkStore): void {
	installMethods(proto, {
		reloadExternal,
		adoptExternal,
		noteAdoptionFailure,
		cacheStats,
		restoreRevision,
		save,
		persist,
		trackPersist,
		claim,
		retryRefusedClaim,
		snapshot,
		schedule,
		scheduleFirst,
		settle,
		noteOnce,
		noticeTransient,
		handleRename,
		dropRenamesTouching,
		consumeRename,
		handleDelete,
		markDuplicateLocked,
		clearDuplicateLock,
		isDuplicateLocked,
		handleDeclaimed,
		carryOwnInk,
		reassignPage,
		scheduleLoaded,
	});
}
