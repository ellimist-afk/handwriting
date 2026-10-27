import { installInlineInkStorePersist } from "./InlineInkStorePersist";
import { InkStroke } from "../ink/Stroke";
import { PageData, type NotePaperKind } from "../model/PageData";
import type { NoteChoiceKind, NoteChoices } from "./NoteChoiceHint";
import type { ExternalAdoptionPrep, LoadResult, PreparedExternalAdoption } from "../persistence/PageStore";
import { installInlineInkStoreLoad } from "./InlineInkStoreLoad";
import { installInlineInkStoreCommit } from "./InlineInkStoreCommit";

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
	loadSidecar(pageId: string): Promise<LoadResult | null>;
	scheduleSidecar(pageId: string, page: PageData): void;
	/**
	 * Write now, no quiet period: the first save after an identity claim.
	 * Resolves when the attempt is over (landed, or re-queued for retry).
	 * Optional: a host without it falls back to scheduleSidecar.
	 */
	scheduleSidecarNow?(pageId: string, page: PageData): Promise<void>;
	/**
	 * Make both revisions independently recoverable before an external
	 * adoption, and acknowledge the captured one afterwards. See
	 * `adoptExternal`, and PageStore for what each step does and does not
	 * promise.
	 *
	 * OPTIONAL, as a pair: a host with neither keeps today's behaviour exactly,
	 * which is what the headless suites and the poll harnesses rely on. A host
	 * with only one of them is treated as having neither - half of this route
	 * is the loss it exists to prevent.
	 */
	prepareExternalAdoption?(pageId: string, outgoing: PageData): Promise<ExternalAdoptionPrep>;
	acceptExternalAdoption?(prepared: PreparedExternalAdoption): void;
	/**
	 * Has another device changed this page's sidecar since the session last
	 * read or wrote it? Asked when a note whose ink is already in the session
	 * is opened again (`ensureLoaded`). Optional: a host without it serves the
	 * session copy as it always has.
	 */
	sidecarChanged?(pageId: string): Promise<boolean>;
	/**
	 * Is a save for this page waiting to be written? A reopen does not adopt
	 * another device's revision over one: the queued page was built before the
	 * adoption, and once the adoption lands it would replace the other device's
	 * file with no copy kept. Optional, as the sync poll's own check is.
	 */
	hasQueuedWrite?(pageId: string): boolean;
	/**
	 * Is every pane bound to this note quiet (no pen, eraser, lasso or gesture
	 * in flight)? A reopen adopts only then, as the sync poll does. Optional: a
	 * host without it has no panes to ask.
	 */
	panesQuiet?(path: string): boolean;
	notify(message: string): void;
}

/**
 * What `adoptExternal` did.
 *
 *  - `adopted`     both revisions are recoverable and the incoming one is now
 *                  the visible page. `changed` says whether the ink differs,
 *                  so an identical revision does not repaint on every poll.
 *  - `held`        nothing was adopted and nothing acknowledged: current ink,
 *                  base, history and save safety are exactly as they were, and
 *                  `reason` records why the external revision remains for a
 *                  later poll or guarded local save.
 *  - `unavailable` there is no existing record for this adoption operation.
 *                  Initial loading remains ensureLoaded/loadRecord's job.
 */
export type ExternalAdoptionHeldReason =
	| "missing-capability"
	| "admission-changed"
	| "unsettled"
	| "existing-lock"
	| "no-snapshot"
	| "preservation-unavailable"
	| "stale"
	| "io-failure";

export type ExternalAdoptionResult =
	| {
			readonly outcome: "adopted";
			readonly changed: boolean;
			readonly reason?: never;
			/** Absent when the adoption lost nothing and no recovery pair was written. */
			readonly outgoingPath?: string;
			readonly incomingPath?: string;
	  }
	| {
			readonly outcome: "held";
			readonly changed: false;
			readonly reason: ExternalAdoptionHeldReason;
			readonly outgoingPath?: never;
			readonly incomingPath?: never;
	  }
	| {
			readonly outcome: "unavailable";
			readonly changed: false;
			readonly reason?: never;
			readonly outgoingPath?: never;
			readonly incomingPath?: never;
	  };

/**
 * How long adoption may keep failing before the user hears about it.
 *
 * The poll retries every second, and the overwhelmingly common failure is a
 * sync client holding the file mid-transfer - gone by the next tick. Speaking
 * then is alarming for nothing: the note is untouched, both revisions are on
 * disk, and the retry is automatic. So the notice waits long enough for a
 * transfer to finish and only speaks if the condition is still there, which is
 * the case that genuinely means "this note has stopped receiving your other
 * device's ink".
 *
 * EIGHT seconds (alan, 1.4.13). It was thirty, then ten, and he cut it
 * twice. The person who sees this is, by construction, someone whose other
 * device's ink is NOT arriving - when it arrives it simply appears and nobody
 * needed telling. So the window is not protecting them from noise; it is
 * protecting them from a message about something already fixed. His words for
 * the moment it should land: "just at the point where theyre like uhhhhhh
 * itnot working??" - which is seconds, not half a minute. Eight sits past a
 * sync client's mid-write blip and inside the span where the message still
 * connects to what they just did. One constant, retunable in one place.
 */
export const ADOPTION_QUIET_MS = 8_000;
/**
 * A failure run is unbroken only while failures keep arriving at poll speed
 * (the live-reload poll's longest stride is 5 s). A longer silence between
 * two failures means the poll saw the sidecar unchanged in between and never
 * called adoptExternal, so the trouble ended without a success to say so
 * (audit 128, the unchanged-poll end of a run). 15 s is three strides.
 */
export const ADOPTION_RUN_GAP_MS = 15_000;

/**
 * ALAN'S WORDING, VERBATIM (1.4.13), including the lower case and the trailing
 * ellipsis, which is doing work: it says the thing is ongoing, which is what
 * stops someone restarting Obsidian or hunting through settings. It retries
 * every second, so "still trying" is true and not a hedge.
 *
 * It appears on the RECEIVING device - the one where the ink is not showing up,
 * not the one that drew - so "from your other device" is right from the
 * reader's side. And it deliberately promises no action: the recovery copies
 * live in a folder Obsidian will not show them, so there is nothing for them
 * to go and do.
 *
 * "your ink is safe" rather than "nothing is lost": the smaller claim is the
 * one they can check on their own screen, and someone whose sync is genuinely
 * broken will not believe the larger one.
 *
 * The blank line is a block break. `InlineInkHost.notify` takes a string, and
 * a newline in a Notice does NOT become a line break without a white-space
 * rule we do not own - so the host splits blank-line-separated blocks into
 * divs. See `blockNotice` in main.ts.
 */
export const ADOPTION_STILL_FAILING =
	"ink not appearing on this device?\n\nyour ink is safe. still trying to load from your other device...";

/**
 * In place of the words above when the note's own ink file is not on disk.
 * It claims no device and no restore: the ink is on screen and the next save
 * writes the file again (`PageStore.resolveFor`, found nowhere). A default:
 * Alan was asked for these words on 2026-10-04 and had none, so they are his
 * to change on sight; `ForkCopyApproved.test.ts` pins them with the fork
 * screen's other defaults.
 */
export const INK_FILE_MISSING =
	"this note's ink file is missing.\n\nyour ink is still on screen. your next stroke saves it again.";

/**
 * Whether a note's ink may be deleted, and on what terms. Four states because
 * they are four different actions; see `InlineInkStore.deleteAllReadiness`.
 */
export type InlineDeleteReadiness =
	| { readonly kind: "ready" }
	| { readonly kind: "damaged" }
	| { readonly kind: "blocked"; readonly lock: "future" | "duplicate" | "legacy" | "transient" }
	/** Loading, claiming or reloading: what this record holds is not yet settled. */
	| { readonly kind: "unsettled" }
	| { readonly kind: "unknown" };

/** One stroke a delete-all would destroy, with the page keys that ride beside it. */
export interface InlineDeleteTarget {
	readonly stroke: InkStroke;
	readonly unknown: Record<string, unknown> | null;
}

/** An immutable, ordered record of exactly what a delete-all would destroy. */
export interface InlineDeleteCapture {
	readonly path: string;
	readonly pageId: string;
	readonly identity: symbol;
	/**
	 * The record's mutation counter when the capture was taken.
	 *
	 * THIS IS THE ABA GUARD, and no content comparison can stand in for it:
	 * ink removed and re-added during the await compares IDENTICAL, because it
	 * is identical. What changed is that the destructive operation the user
	 * confirmed no longer describes the same act - the strokes on screen are a
	 * different generation of the same drawing, and the history the wipe would
	 * bury is not the history it was authorized against.
	 */
	readonly generation: number;
	readonly targets: readonly InlineDeleteTarget[];
}

/**
 * Stroke fields `parsePage` INVENTS when the file omits them, rather than
 * reading them.
 *
 * Today that is NONE. `createdAt` used to be the one: the parser stamped a
 * stroke that had none with `Date.now()`, so two parses of identical bytes at
 * different moments disagreed about it. The fallback is a fixed 0 now, so memory and a byte copy of the file agree about a missing `createdAt`
 * and nothing needs skipping.
 *
 * THE LIST STAYS, EMPTY, BECAUSE THE ALARM ON IT STAYS. A field like this
 * cannot be compared between memory and an artifact, because neither value
 * came from the user's data, and a second clock-defaulted field added to the
 * parser would reopen the refuse-forever bug. `InlineDeleteAllRouting.test.ts`
 * parses one sidecar under two clocks and requires the set of fields that
 * differ to be exactly this set - so such a field fails that case and names
 * itself. It cannot catch a default that is non-deterministic in some other
 * way; nothing here pretends otherwise.
 *
 * To declare a field here, key the predicate on what the parser would invent,
 * not on whether the key is present: the parser invents whenever it cannot READ
 * the value, so `null`, a numeric string or NaN is invented like an absent one.
 */
export const PARSER_INVENTED_STROKE_FIELDS: Readonly<
	Record<string, (raw: unknown) => boolean>
> = {};

const EMPTY: readonly InkStroke[] = [];

/** Cheap identity of a note's ink: which strokes, where they sit. */
export function inkFingerprint(strokes: readonly InkStroke[]): string {
	return strokes.map((s) => `${s.id}:${s.bbox.x},${s.bbox.y}`).join("|");
}

type LoadState = "no" | "loading" | "yes";

/**
 * What the store knows about a note's ink. See `InlineInkStore.inkPresence`
 * for why "unknown" is a state a caller has to handle rather than a boolean
 * it can round off.
 */
export type InkPresence = "ink" | "none" | "unknown";

export interface NoteRecord {
	/** Session identity follows this record, including before its durable claim. */
	readonly historyIdentity: symbol;
	strokes: InkStroke[];
	/** IDs changed through session operations since the last clean reread began.
	 * An absent changed ID is a local deletion, not missing cached ink. */
	localStrokeIds: Set<string>;
	pageId: string | null;
	load: LoadState;
	/** A joining viewer must await adoption before painting cached reload ink. */
	reloading: boolean;
	/** The loaded sidecar, kept as the save basis so unknown fields survive. */
	basePage: PageData | null;
	/** A canvas-world sidecar exists under this id: never write, never render it. */
	legacyLocked: boolean;
	/**
	 * The persisted payload was UNREADABLE. Fail closed: the file stays
	 * exactly as it is on disk, and Handwriting refuses to persist for this note.
	 * Writing would replace whatever the damaged file still holds with a
	 * blank page. New session ink renders but is not saved, and the user is
	 * told so once, in words they can act on.
	 */
	damagedLocked: boolean;
	/**
	 * The lock is on only because the read threw: the file may be
	 * healthy and not readable yet. Saving is refused exactly as for damage,
	 * but the user has not been told, and a heal says nothing either.
	 */
	damageSilent: boolean;
	/** When this record first failed a read with a throw, for the 60 s bound. Null otherwise. */
	transientSince: number | null;
	/** The "could not be read yet" notice was shown for the current transient lock. */
	transientNoticed: boolean;
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
	/** The claim was refused on frontmatter Obsidian cannot read; strokes are held. */
	claimRefused: boolean;
	/** The sidecar read in progress; a mutation racing it waits for the merge. */
	loadInFlight: Promise<boolean> | null;
	/** The post-claim first write is armed once per claim, not once per stroke. */
	claimFollowUpArmed: boolean;
	noticed: boolean;
	/**
	 * COUNTS EVERY LOCAL OPERATION that can change what a save would write.
	 * `adoptExternal` reads it before its first await and re-reads it before
	 * adopting: a different value means ink moved while the preservation I/O
	 * ran, and the prepared adoption is refused rather than allowed to replace
	 * a page it never saw. Bumped by the primitives every mutation path goes
	 * through - pen completion, add, remove, move - so history replay counts
	 * too, since undo and redo reach disk through exactly those.
	 */
	mutationGeneration: number;
	/** The external-adoption failure has been reported once for this record. */
	adoptionNoticed: boolean;
	/** When this run of adoption failures began, or null while it is succeeding. */
	adoptionFailingSince: number | null;
	/** When the latest failure of the current run happened. */
	adoptionLastFailureAt: number | null;
	/**
	 * Set by every `adoptSidecar` call: true when `loadSidecar` returned
	 * anything at all (readable, damaged, legacy or future), false when it
	 * found nothing - the file is simply gone. `retryDamaged` reads this to
	 * tell "repaired" from "removed": a damaged file that vanished is not
	 * "readable again", and nothing was "restored".
	 */
	lastAdoptFound: boolean;
	/** A font reference set this session, before any sidecar carried one (audit 46). */
	fontRefPx?: number;
	/**
	 * This note's paper and canvas choices as set this session, over the
	 * file's: undefined keeps the file's value, null clears it (the note
	 * follows the setting), a value replaces it.
	 */
	choices?: { canvas?: boolean | null; paper?: NotePaperKind | null };
}

/** A record's paper and canvas choices: the session's over the file's. */
function choicesOf(rec: NoteRecord): NoteChoices {
	const base = rec.basePage;
	const canvas = rec.choices?.canvas === undefined ? base?.noteCanvas : rec.choices.canvas ?? undefined;
	const paper = rec.choices?.paper === undefined ? base?.notePaper : rec.choices.paper ?? undefined;
	return {
		known: rec.load === "yes" || rec.basePage !== null || rec.choices !== undefined,
		...(canvas !== undefined ? { canvas } : {}),
		...(paper !== undefined ? { paper } : {}),
	};
}

export function choicesKeyOf(rec: NoteRecord): string {
	const c = choicesOf(rec);
	return `${String(c.known)}|${String(c.canvas)}|${String(c.paper)}`;
}

function freshRecord(): NoteRecord {
	return {
		historyIdentity: Symbol("inline ink history"),
		strokes: [],
		localStrokeIds: new Set(),
		pageId: null,
		load: "no",
		reloading: false,
		basePage: null,
		legacyLocked: false,
		damagedLocked: false,
		damageSilent: false,
		transientSince: null,
		transientNoticed: false,
		futureLocked: false,
		duplicateLocked: false,
		claimInFlight: null,
		claimRefused: false,
		loadInFlight: null,
		claimFollowUpArmed: false,
		noticed: false,
		mutationGeneration: 0,
		adoptionNoticed: false,
		adoptionFailingSince: null,
		adoptionLastFailureAt: null,
		lastAdoptFound: false,
	};
}

export class InlineInkStore {
	byPath = new Map<string, NoteRecord>();
	host: InlineInkHost | null = null;
	/** First writes after a claim, still in flight; settle() waits for them. */
	firstWrites = new Set<Promise<void>>();
	/** Save continuations remain tracked until their snapshot has been scheduled. */
	pendingPersists = new Set<Promise<void>>();

	/** No host = session-memory mode (headless tests). */
	attachHost(host: InlineInkHost): void {
		this.host = host;
	}

	/**
	 * Is a host attached at all?
	 *
	 * READ-ONLY, and it exists for ONE caller: the delete-all preflight, which
	 * must not read a `none` from `inkPresence` as evidence of an empty note
	 * when there is no host to have looked. `inkPresence` itself answers `none`
	 * without a host by design - session-memory mode genuinely has no sidecar -
	 * and that behaviour is deliberately untouched here. The distinction the
	 * preflight needs is "nothing to find" versus "nothing looked", and only
	 * the caller knows which of those it may act on.
	 */
	hasHost(): boolean {
		return this.host !== null;
	}

	/** How many times this note's strokes have changed in this session: a raster drawn at one count is stale at another. -1 with no record. */
	generation(path: string): number {
		return this.byPath.get(path)?.mutationGeneration ?? -1;
	}

	strokes(path: string): readonly InkStroke[] {
		const rec = this.byPath.get(path);
		if (!rec) return EMPTY;
		return rec.reloading
			? rec.strokes.filter((stroke) => rec.localStrokeIds.has(stroke.id))
			: rec.strokes;
	}

	/**
	 * The editor font size (px) this note's ink was drawn against, or null when
	 * none is stored yet (audit 46). The sidecar's value wins over one set this
	 * session, so a reference that reached disk never changes.
	 */
	fontRefPx(path: string): number | null {
		const rec = this.byPath.get(path);
		return rec?.basePage?.fontRefPx ?? rec?.fontRefPx ?? null;
	}

	/**
	 * Record the font reference for a note, once. False when one is already
	 * held or `px` is not a finite number above zero. Writes nothing: it rides
	 * the note's next ordinary save (never a mount alone).
	 */
	setFontRefPx(path: string, px: number): boolean {
		if (!Number.isFinite(px) || px <= 0) return false;
		const rec = this.byPath.get(path);
		if (!rec || this.fontRefPx(path) !== null) return false;
		rec.fontRefPx = px;
		return true;
	}

	/**
	 * The note's own paper and canvas choices, from its ink file and anything
	 * set this session. `known` is false while the file has not been read:
	 * the caller then answers from what it already knows, and hears again
	 * through onNoteChoicesChanged once the file is read.
	 */
	noteChoices(path: string): NoteChoices {
		const rec = this.byPath.get(path);
		return rec ? choicesOf(rec) : { known: false };
	}

	/**
	 * Set or clear one choice, in the note's ink file. Waits for the note's
	 * file to be read, then saves through the ordinary path: a note with no
	 * page id is claimed first, the same one line the first stroke writes.
	 * Clearing a choice on a note with no page id writes nothing. False when
	 * nothing could be set (no host, or the note cannot be written).
	 */
	async setNoteChoice(path: string, kind: NoteChoiceKind, value: boolean | NotePaperKind | "default"): Promise<boolean> {
		if (!this.host) return false;
		await this.ensureLoaded(path);
		const rec = this.record(path);
		if (rec.legacyLocked || rec.futureLocked || rec.damagedLocked || rec.duplicateLocked) return false;
		if (value === "default" && !rec.pageId) return true;
		const before = this.choicesKey(path);
		const choices = { ...(rec.choices ?? {}) };
		if (kind === "canvas") choices.canvas = value === "default" ? null : (value as boolean);
		else choices.paper = value === "default" ? null : (value as NotePaperKind);
		rec.choices = choices;
		rec.mutationGeneration++;
		this.persist(path, rec);
		if (rec.claimInFlight) await rec.claimInFlight.catch(() => undefined);
		if (this.choicesKey(path) !== before) this.emitChoices(path);
		return true;
	}

	private readonly choiceListeners = new Set<(path: string) => void>();

	/** Fires with a note's path when its paper or canvas choice may have changed. */
	onNoteChoicesChanged(listener: (path: string) => void): () => void {
		this.choiceListeners.add(listener);
		return () => this.choiceListeners.delete(listener);
	}

	choicesKey(path: string): string {
		const rec = this.byPath.get(path);
		return rec ? choicesKeyOf(rec) : "";
	}

	/** The read path holds the record, not its path: find the path to announce. */
	emitChoicesOf(rec: NoteRecord): void {
		for (const [path, r] of this.byPath) if (r === rec) this.emitChoices(path);
	}

	emitChoices(path: string): void {
		for (const listener of [...this.choiceListeners]) listener(path);
	}

	hasInk(path: string): boolean {
		return (this.byPath.get(path)?.strokes.length ?? 0) > 0;
	}

	/**
	 * Does this note have ink - and do we actually KNOW yet?
	 *
	 * `hasInk` is two questions collapsed into one boolean, and its `false`
	 * answers the wrong one. The store is a cache of the sidecar, filled by
	 * `ensureLoaded` on a real file read; until that read lands, a note whose
	 * sidecar is full of ink holds zero strokes here and `hasInk` says "no
	 * ink" about it. Every caller that turns that `false` into a sentence for
	 * a human ("no ink on this note", "no ink on the page to erase") then
	 * states as fact something the store has not looked up.
	 *
	 * Alan, hardware, on 1.4.12: "touching eraser end to screen spams toast
	 * notification - there is no ink on the note to erase, even though there
	 * is". "Even though there is" is the whole bug: the answer was not wrong
	 * about the strokes in memory, it was wrong to be given at all.
	 *
	 * So the three states are named instead:
	 *
	 * - "ink"     strokes are in the session right now. Certain.
	 * - "none"    the record is LOADED and empty, or the note carries no
	 *             `handwriting-page-id` at all - and no id means no sidecar
	 *             can exist, because sidecars are keyed by id. Certain, and
	 *             the second case costs one metadata lookup, no file I/O.
	 * - "unknown" not loaded, mid-load, or the sidecar is damaged and locked.
	 *             The honest answer is "ask me after a read".
	 *
	 * `hasInk` is deliberately left exactly as it was rather than made to
	 * guess in the other direction: a caller that wants "certainly empty"
	 * must say so, and one that only wants the session's strokes still gets
	 * them without a lie in either direction.
	 *
	 * NO HOST is the headless session-memory mode (`attachHost` never called,
	 * which is most of this repo's tests and the calibration harness). There
	 * is no sidecar behind the session there, so the session IS the whole
	 * truth and "none" is certain.
	 */
	inkPresence(path: string): InkPresence {
		this.gainedPageId(path);
		const rec = this.byPath.get(path);
		if ((rec?.strokes.length ?? 0) > 0) return "ink";
		if (!this.host) return "none";
		if (rec !== undefined && rec.load === "yes" && !rec.damagedLocked) return "none";
		// Not read yet. One cheap metadata lookup settles the common case:
		// a note with no id has no sidecar, so it is certainly empty, and an
		// untouched note must not cost a caller a file read to be told so.
		if (rec === undefined || rec.load === "no") {
			return this.host.readPageId(path) === null ? "none" : "unknown";
		}
		return "unknown";
	}

	/**
	 * A record loaded while its note had no id is an empty "yes" that nothing
	 * reloads: another device's first ink, synced with the id line, stayed
	 * invisible all session. When the note has since gained an id
	 * - and this record holds nothing of its own - send it back to "no", so
	 * the next load reads the sidecar. One metadata lookup, and only for such
	 * records. True when it reset one.
	 */
	gainedPageId(path: string): boolean {
		const rec = this.byPath.get(path);
		if (!rec || !this.host || rec.load !== "yes" || rec.pageId !== null) return false;
		if (rec.strokes.length > 0 || rec.claimInFlight || rec.basePage !== null) return false;
		if (this.host.readPageId(path) === null) return false;
		rec.load = "no";
		return true;
	}

	record(path: string): NoteRecord {
		let rec = this.byPath.get(path);
		if (!rec) {
			rec = freshRecord();
			this.byPath.set(path, rec);
		}
		return rec;
	}

	renames = new Map<string, string>();
	static readonly RENAMES_CAP = 256;

	/** Pending renames not yet consumed; read by tests. */
	get pendingRenameCount(): number {
		return this.renames.size;
	}
}

installInlineInkStorePersist(InlineInkStore.prototype);
installInlineInkStoreCommit(InlineInkStore.prototype);
installInlineInkStoreLoad(InlineInkStore.prototype);
