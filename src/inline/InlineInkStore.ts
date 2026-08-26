import { InkStroke } from "../ink/Stroke";
import { PageData, ParseResult, emptyPage, newPageId } from "../model/PageData";
import { translateStroke } from "../objects/Selection";
import { runDetached } from "../util/Detached";
import { notifyInkChanged } from "./InkEvents";

/**
 * Ink for the inline overlay: session state plus (M1) sidecar persistence,
 * keyed by vault file path.
 *
 * The path is the key because that is the only identity an unclaimed note has
 * (identity rule #1). That makes the vault's rename/delete events part of
 * this store's contract, not an optional nicety:
 *
 * - RENAME moves the ink with the note. Without this, retitling "Untitled 1"
 *   strands its ink under the old path, and the NEXT "Untitled 1" the user
 *   creates inherits a dead note's ink. That exact leak shipped in v0.9.0.
 * - DELETE drops the ink. A path freed by deletion is a fresh note's name.
 *
 * Persistence follows the two standing identity rules exactly:
 *
 * - The reference must exist before the referent: the first commit on an
 *   unclaimed note AWAITS the `handwriting-page-id` write into the Markdown before
 *   any sidecar keyed by that id is scheduled. Commits racing the claim are
 *   chained behind it.
 * - Absence of an id never means anything but "not claimed yet". If the claim
 *   discovers the file already carries an id (another pane, another device,
 *   or a metadata cache we read too early), that id WINS, and its existing
 *   sidecar is loaded and merged BEFORE our strokes can overwrite it.
 *
 * Coordinate worlds never mix: a sidecar without `surface: "inline"` is a
 * legacy canvas page. The inline layer neither renders nor overwrites it.
 * Ink drawn there stays session-only, and the user is told so once.
 */

/** The slice of Obsidian this store needs, kept narrow so tests can fake it. */
export interface InlineInkHost {
	/** The note's persisted page id, from cheap metadata (no file read). */
	readPageId(path: string): string | null;
	/** Atomically stamp (or discover) the page id in the Markdown. */
	claimId(path: string, proposedId: string): Promise<{
		pageId: string;
		futureVersion?: number;
	}>;
	loadSidecar(pageId: string): Promise<ParseResult | null>;
	scheduleSidecar(pageId: string, page: PageData): void;
	/**
	 * Write now, no quiet period: the first save after an identity claim.
	 * Resolves when the attempt is over (landed, or re-queued for retry).
	 * Optional: a host without it falls back to scheduleSidecar.
	 */
	scheduleSidecarNow?(pageId: string, page: PageData): Promise<void>;
	notify(message: string): void;
}

const EMPTY: readonly InkStroke[] = [];

type LoadState = "no" | "loading" | "yes";

interface NoteRecord {
	strokes: InkStroke[];
	pageId: string | null;
	load: LoadState;
	/** The loaded sidecar, kept as the save basis so unknown fields survive. */
	basePage: PageData | null;
	/** A canvas-world sidecar exists under this id: never write, never render it. */
	legacyLocked: boolean;
	/**
	 * The persisted payload was UNREADABLE. Fail closed: the file stays
	 * exactly as it is on disk, and Handwriting refuses to persist for this note.
	 * Writing would replace whatever the damaged file still holds with a
	 * blank page. New session ink renders but is not saved, and the user is
	 * told so once, in plain language.
	 */
	damagedLocked: boolean;
	/** Written by a newer Handwriting: render nothing extra, write nothing. */
	futureLocked: boolean;
	/**
	 * This note shares its page id with another note and no safe owner could
	 * be established (ambiguous startup duplicate). Fail closed: ink renders
	 * but nothing persists from THIS note, because a write would go into a
	 * sidecar another note also owns. Cleared when the collision resolves.
	 */
	duplicateLocked: boolean;
	claimInFlight: Promise<void> | null;
	/** The sidecar read in progress; a mutation racing it waits for the merge. */
	loadInFlight: Promise<void> | null;
	/** The post-claim first write is armed once per claim, not once per stroke. */
	claimFollowUpArmed: boolean;
	noticed: boolean;
}

function freshRecord(): NoteRecord {
	return {
		strokes: [],
		pageId: null,
		load: "no",
		basePage: null,
		legacyLocked: false,
		damagedLocked: false,
		futureLocked: false,
		duplicateLocked: false,
		claimInFlight: null,
		loadInFlight: null,
		claimFollowUpArmed: false,
		noticed: false,
	};
}

export class InlineInkStore {
	private byPath = new Map<string, NoteRecord>();
	private host: InlineInkHost | null = null;
	/** First writes after a claim, still in flight; settle() waits for them. */
	private firstWrites = new Set<Promise<void>>();

	/** No host = session-memory mode (headless tests). */
	attachHost(host: InlineInkHost): void {
		this.host = host;
	}

	strokes(path: string): readonly InkStroke[] {
		return this.byPath.get(path)?.strokes ?? EMPTY;
	}

	hasInk(path: string): boolean {
		return (this.byPath.get(path)?.strokes.length ?? 0) > 0;
	}

	private record(path: string): NoteRecord {
		let rec = this.byPath.get(path);
		if (!rec) {
			rec = freshRecord();
			this.byPath.set(path, rec);
		}
		return rec;
	}

	// ---- loading --------------------------------------------------------------

	/**
	 * Bring a note's persisted ink into the session, once. Resolves true when
	 * the visible strokes changed (the caller repaints).
	 *
	 * An untouched note costs exactly one metadata lookup: no id → no sidecar
	 * can exist (they are keyed by id) → zero file I/O, zero writes.
	 */
	async ensureLoaded(path: string): Promise<boolean> {
		const rec = this.record(path);
		if (!this.host) return false;
		if (rec.load === "yes" && rec.damagedLocked) return this.retryDamaged(rec);
		if (rec.load !== "no") return false;
		rec.load = "loading";
		const id = this.host.readPageId(path);
		if (!id) {
			rec.load = "yes";
			return false;
		}
		rec.pageId = id;
		return this.trackLoad(rec, async () => {
			const changed = await this.adoptSidecar(rec, id);
			rec.load = "yes";
			return changed;
		});
	}

	/**
	 * Run a sidecar read with the record marked as loading. A mutation that
	 * races the read must not be snapshotted yet: the snapshot would hold
	 * only the session's strokes and, written, replace the persisted ones
	 * (persistence gate, 2026-08-22). persist() waits on this promise and
	 * runs again after the merge.
	 */
	private trackLoad(rec: NoteRecord, work: () => Promise<boolean>): Promise<boolean> {
		const run = work();
		rec.loadInFlight = run
			.then(
				() => undefined,
				() => undefined
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
	private async retryDamaged(rec: NoteRecord): Promise<boolean> {
		if (!this.host || !rec.pageId) return false;
		rec.load = "loading";
		rec.damagedLocked = false; // adoptSidecar re-arms it if still damaged
		const id = rec.pageId;
		const changed = await this.trackLoad(rec, async () => {
			const c = await this.adoptSidecar(rec, id);
			rec.load = "yes";
			return c;
		});
		if (!rec.damagedLocked && !rec.legacyLocked && !rec.futureLocked) {
			rec.noticed = false; // a future, different problem may speak again
			this.host.notify(
				"Handwriting: this note's ink file is readable again. The saved ink is restored and saving is back on."
			);
			if (rec.strokes.length > 0) this.schedule(rec);
		}
		return changed;
	}

	/** Load a sidecar into the record, merging ahead of any session strokes. */
	private async adoptSidecar(rec: NoteRecord, id: string): Promise<boolean> {
		if (!this.host) return false;
		const result = await this.host.loadSidecar(id);
		if (!result) return false;
		if (result.damaged) {
			rec.damagedLocked = true;
			this.noteOnce(
				rec,
				"Handwriting cannot read the saved ink for this note (.handwriting/" +
					id +
					".json). The file has not been overwritten. New ink on this note will not be saved until that file is repaired, restored from a backup or sync copy, or removed."
			);
			return false;
		}
		if (result.futureVersion !== undefined) {
			rec.futureLocked = true;
			return false;
		}
		if (result.data.surface !== "inline") {
			// A legacy canvas page. Its geometry means nothing over the editor
			// and our writes would destroy it. Hands off in both directions.
			rec.legacyLocked = true;
			return false;
		}
		rec.basePage = result.data;
		if (result.data.strokes.length === 0) return false;
		rec.strokes = [...result.data.strokes, ...rec.strokes];
		return true;
	}

	/**
	 * Is this note a Handwriting page, meaning it carries spatial state? True when the
	 * session has strokes or an id for it, or the note's frontmatter already
	 * carries a `handwriting-page-id` (cheap metadata read, no file I/O). Drives
	 * presentation only (the `handwriting-page` class); never mutates anything.
	 */
	/** The page id the session knows for this note (post-load/claim), if any. */
	pageIdOf(path: string): string | null {
		return this.byPath.get(path)?.pageId ?? null;
	}

	/** Fail-closed flag: the persisted payload was unreadable (see NoteRecord). */
	isDamagedLocked(path: string): boolean {
		return this.byPath.get(path)?.damagedLocked ?? false;
	}

	isHandwritingPage(path: string): boolean {
		const rec = this.byPath.get(path);
		if (rec && (rec.strokes.length > 0 || rec.pageId)) return true;
		return (this.host?.readPageId(path) ?? null) !== null;
	}

	// ---- committing -----------------------------------------------------------

	/** A finished stroke: visible immediately, persisted behind the id rules. */
	commit(path: string, stroke: InkStroke): void {
		this.commitGesture(path, [stroke]);
	}

	/** One pen contact, possibly split around release travel: persist once. */
	commitGesture(path: string, strokes: readonly InkStroke[]): void {
		if (strokes.length === 0) return;
		const rec = this.record(path);
		rec.strokes.push(...strokes);
		this.persist(path, rec);
	}

	// ---- ink operations (eraser / lasso / history) ------------------------------
	//
	// These are the do/undo/redo primitives. They take captured operands (full
	// strokes or frozen id lists), never live UI state, and every one persists.
	// An undone erase that only changed the screen would resurrect on reload.

	/** Insert strokes (idempotent by id; indices restore z-order on un-erase). */
	applyAdd(path: string, strokes: readonly InkStroke[], indices?: readonly number[]): void {
		const rec = this.record(path);
		const present = new Set(rec.strokes.map((s) => s.id));
		strokes.forEach((stroke, i) => {
			if (present.has(stroke.id)) return;
			const at = indices?.[i];
			if (at !== undefined && at >= 0 && at <= rec.strokes.length) {
				rec.strokes.splice(at, 0, stroke);
			} else {
				rec.strokes.push(stroke);
			}
		});
		this.persist(path, rec);
	}

	/** Remove strokes by id. Returns what was removed, with original indices. */
	applyRemove(
		path: string,
		ids: readonly string[]
	): Array<{ stroke: InkStroke; index: number }> {
		const removed = this.take(path, ids);
		if (removed.length > 0) this.persist(path, this.record(path));
		return removed;
	}

	/**
	 * Live-erase removal: same capture, NO persistence. The eraser passes over
	 * strokes at input rate, and disk scheduling belongs at pen-up, not on the
	 * hot path. The caller persists once via save().
	 */
	takeLive(
		path: string,
		ids: readonly string[]
	): Array<{ stroke: InkStroke; index: number }> {
		return this.take(path, ids);
	}

	private take(
		path: string,
		ids: readonly string[]
	): Array<{ stroke: InkStroke; index: number }> {
		const rec = this.record(path);
		const wanted = new Set(ids);
		const removed: Array<{ stroke: InkStroke; index: number }> = [];
		for (let i = rec.strokes.length - 1; i >= 0; i--) {
			const s = rec.strokes[i]!;
			if (!wanted.has(s.id)) continue;
			removed.push({ stroke: s, index: i });
			rec.strokes.splice(i, 1);
		}
		removed.reverse(); // ascending original indices
		return removed;
	}

	/** Translate exactly the listed strokes. Missing ids are skipped. */
	moveStrokes(path: string, ids: readonly string[], dx: number, dy: number): void {
		if (dx === 0 && dy === 0) return;
		const rec = this.record(path);
		const wanted = new Set(ids);
		for (const s of rec.strokes) {
			if (wanted.has(s.id)) translateStroke(s, dx, dy);
		}
	}

	/** Persist the current state of a note (gesture end, or an applied op). */
	save(path: string): void {
		this.persist(path, this.record(path));
		// The in-memory strokes are already the truth even when the disk
		// write is deferred, so rendered embeds repaint from here.
		notifyInkChanged(path);
	}

	private persist(path: string, rec: NoteRecord): void {
		if (!this.host) return; // session-memory mode
		// Nothing was ever persisted and nothing remains: claiming an id here
		// would stamp a note whose ink came and went entirely in-session
		// (draw + erase, or draw + undo). An untouched-in-the-end note stays
		// untouched. A CLAIMED note skips this and persists emptiness: the id
		// line stays, and erasing your last stroke never un-claims a note.
		if (!rec.pageId && rec.strokes.length === 0 && !rec.basePage) return;
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
			runDetached(
				rec.loadInFlight.then(() => this.persist(path, rec)),
				`persist inline ink after loading ${path}`
			);
			return;
		}
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
				runDetached(
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

	private async claim(path: string, rec: NoteRecord): Promise<void> {
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
			console.error("[handwriting] inline claim failed", err);
			this.noteOnce(rec, "Handwriting: could not write the page id into this note, so its ink is not being saved.");
		}
	}

	/** The page to write for a record, or null when the record must not write. */
	private snapshot(rec: NoteRecord): PageData | null {
		if (!this.host || !rec.pageId) return null;
		if (rec.legacyLocked || rec.futureLocked || rec.damagedLocked) return null;
		if (rec.duplicateLocked) return null;
		const base = rec.basePage ?? emptyPage(rec.pageId);
		return { ...base, pageId: rec.pageId, surface: "inline", strokes: rec.strokes };
	}

	private schedule(rec: NoteRecord): void {
		const page = this.snapshot(rec);
		if (!this.host || !page || !rec.pageId) return;
		this.host.scheduleSidecar(rec.pageId, page);
	}

	/** The first write after a claim: immediate, and tracked for settle(). */
	private scheduleFirst(rec: NoteRecord): void {
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
	 */
	async settle(maxWaitMs = 2000): Promise<void> {
		let expire: (v: boolean) => void = () => {};
		const deadline = new Promise<boolean>((r) => {
			expire = r;
		});
		const timer = window.setTimeout(() => expire(true), maxWaitMs);
		try {
			for (let pass = 0; pass < 4; pass++) {
				const inFlight: Promise<unknown>[] = [...this.firstWrites];
				for (const rec of this.byPath.values()) {
					if (rec.claimInFlight) inFlight.push(rec.claimInFlight);
					if (rec.loadInFlight) inFlight.push(rec.loadInFlight);
				}
				if (inFlight.length === 0) return;
				const timedOut = await Promise.race([
					Promise.all(inFlight).then(() => false),
					deadline,
				]);
				if (timedOut) return;
			}
		} finally {
			window.clearTimeout(timer);
		}
	}

	private noteOnce(rec: NoteRecord, message: string): void {
		if (rec.noticed) return;
		rec.noticed = true;
		this.host?.notify(message);
	}

	// ---- vault lifecycle --------------------------------------------------------

	/** The note moved. Its ink and its identity (the id is in the file) move too. */
	handleRename(oldPath: string, newPath: string): void {
		const rec = this.byPath.get(oldPath);
		if (!rec) return;
		this.byPath.delete(oldPath);
		this.byPath.set(newPath, rec);
	}

	/** The note is gone; a future note reusing its path starts clean. */
	handleDelete(path: string): void {
		this.byPath.delete(path);
	}

	// ---- duplicate page ids -------------------------------------------------

	/**
	 * Fail closed on an ambiguous duplicate: this note's writes are blocked
	 * (its id is shared and no safe owner exists) and the user is told once,
	 * with the fix in plain language. Rendering is untouched.
	 */
	markDuplicateLocked(path: string, otherPath: string): void {
		const rec = this.record(path);
		if (rec.duplicateLocked) return;
		rec.duplicateLocked = true;
		this.noteOnce(
			rec,
			`Handwriting: this note and "${otherPath}" carry the same handwriting-page-id, so they point at the same ink file. Ink on both is read-only until that is resolved. Delete the handwriting-page-id line from the copy (its next stroke gets a fresh id), or delete one of the notes.`
		);
	}

	/** The collision resolved (an id line was removed, or a note deleted). */
	clearDuplicateLock(path: string): void {
		const rec = this.byPath.get(path);
		if (!rec || !rec.duplicateLocked) return;
		rec.duplicateLocked = false;
		rec.noticed = false;
		this.host?.notify("Handwriting: duplicate resolved. Ink on this note saves again.");
	}

	isDuplicateLocked(path: string): boolean {
		return this.byPath.get(path)?.duplicateLocked ?? false;
	}

	/**
	 * The note's frontmatter no longer carries an id (the user removed the
	 * line to resolve a duplicate, or edited it away externally). The session
	 * record is stale: its pageId would keep writing into a sidecar the note
	 * no longer references. Drop it; the note starts over as unclaimed, and
	 * its on-screen ink (which belongs to the id's real owner) clears on the
	 * next repaint.
	 */
	handleDeclaimed(path: string): void {
		const rec = this.byPath.get(path);
		if (!rec || !rec.pageId) return;
		this.byPath.delete(path);
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
	reassignPage(
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
			this.schedule(rec);
		}
		const owner = this.byPath.get(ownerPath);
		if (owner && owner.pageId) {
			this.schedule(owner);
			return "rescheduled-owner";
		}
		return "old-queue-orphaned";
	}
}
