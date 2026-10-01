import { UnreadableFrontmatterError } from "./InlineClaim";
import { InkStroke } from "../ink/Stroke";
import { PageData, emptyPage, newPageId, parsePage, serializePage } from "../model/PageData";
import type { ExternalAdoptionPrep, LoadResult, PreparedExternalAdoption } from "../persistence/PageStore";
import { forkFromAdoption, recordFork } from "../persistence/ForkResolution";
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

const ADOPTION_UNAVAILABLE: ExternalAdoptionResult = { outcome: "unavailable", changed: false };

/** How long a note whose file keeps failing to read stays silent. */
const TRANSIENT_SILENCE_MS = 60_000;
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

/** `freezePage`'s copy, for anything that is not a whole page. */
function deepCopy<T>(value: T): T {
	return typeof structuredClone === "function"
		? structuredClone(value)
		: (JSON.parse(JSON.stringify(value)) as T);
}

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
 * Today that is `createdAt` alone: `PageData.ts:813` is
 * `createdAt: num(s.createdAt) ?? Date.now()`, so two parses of identical
 * bytes at different moments disagree about it. A field like that cannot be
 * compared between memory and an artifact, because neither value came from the
 * user's data.
 *
 * THIS LIST IS THE STALE-PRONE PART AND IT IS POLICED BY A TEST, not by care.
 * `InlineDeleteAllRouting.test.ts` parses one sidecar under two clocks and
 * requires the set of fields that differ to be exactly this set - so a second
 * clock-defaulted field added to the parser fails that case and names itself,
 * instead of quietly reopening the refuse-forever bug this closes. It cannot
 * catch a default that is non-deterministic in some other way; nothing here
 * pretends otherwise.
 */
export const PARSER_INVENTED_STROKE_FIELDS: Readonly<
	Record<string, (raw: unknown) => boolean>
> = {
	// KEYED ON WHAT THE PARSER WOULD INVENT, NOT ON WHETHER THE KEY IS THERE.
	// The first version of this asked `!(f in stroke)`, which is a different
	// question and a narrower one: `PageData.ts` invents whenever `num()`
	// cannot READ the value, so `createdAt: null`, `"1700000000000"` or NaN is
	// stamped with `Date.now()` exactly like an absent one. Keying on absence
	// left those refusing forever - the same refuse-forever bug this exists to
	// close, one condition away.
	createdAt: (raw) => typeof raw !== "number" || !Number.isFinite(raw),
};

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

const EMPTY: readonly InkStroke[] = [];

/** Cheap identity of a note's ink: which strokes, where they sit. */
function inkFingerprint(strokes: readonly InkStroke[]): string {
	return strokes.map((s) => `${s.id}:${s.bbox.x},${s.bbox.y}`).join("|");
}

type LoadState = "no" | "loading" | "yes";

/**
 * What the store knows about a note's ink. See `InlineInkStore.inkPresence`
 * for why "unknown" is a state a caller has to handle rather than a boolean
 * it can round off.
 */
export type InkPresence = "ink" | "none" | "unknown";

interface NoteRecord {
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
	private byPath = new Map<string, NoteRecord>();
	private host: InlineInkHost | null = null;
	/** First writes after a claim, still in flight; settle() waits for them. */
	private firstWrites = new Set<Promise<void>>();
	/** Save continuations remain tracked until their snapshot has been scheduled. */
	private pendingPersists = new Set<Promise<void>>();

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
	isLoaded(path: string): boolean {
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
	async ensureLoaded(path: string): Promise<boolean> {
		this.gainedPageId(path);
		const rec = this.record(path);
		if (!this.host) return false;
		// Every viewer waiting on this read needs its completion result. Returning
		// false while loading leaves a joining editor blank until another repaint.
		if (rec.load === "loading") return rec.loadInFlight ?? false;
		if (rec.load === "yes" && rec.damagedLocked) return this.retryDamaged(rec);
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
	private async refreshOnReopen(path: string, rec: NoteRecord): Promise<boolean> {
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
		if (!changed || this.byPath.get(path) !== rec || rec.mutationGeneration !== generation) return false;
		const adopted = await this.adoptExternal(path, () => rec.mutationGeneration === generation);
		return adopted.outcome === "adopted" && adopted.changed;
	}

	/** Complete adoption or fallback restoration before releasing waiting viewers. */
	private loadRecord(
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
		return this.trackLoad(rec, async () => finish(await this.adoptSidecar(rec, id)));
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
	private async retryDamaged(rec: NoteRecord): Promise<boolean> {
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

	/** Load a sidecar into the record, merging ahead of any session strokes. */
	private async adoptSidecar(rec: NoteRecord, id: string): Promise<boolean> {
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
			rec.damagedLocked = true;
			const now = Date.now();
			if (rec.transientSince === null) rec.transientSince = now;
			if (!rec.transientNoticed) {
				rec.damageSilent = true;
				if (now - rec.transientSince >= TRANSIENT_SILENCE_MS) this.noticeTransient(rec);
			}
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
		rec.basePage = result.data;
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
		return result.data.strokes.length > 0;
	}

	/** Capture only an in-memory identity; this never claims or loads a note. */
	captureHistoryIdentity(path: string): symbol {
		return this.record(path).historyIdentity;
	}

	/** A removed record cannot resolve, even if its path or durable id is reused. */
	pathForHistoryIdentity(identity: symbol): string | null {
		for (const [path, rec] of this.byPath) {
			if (rec.historyIdentity === identity) return path;
		}
		return null;
	}

	/** The page id the session knows for this note (post-load/claim), if any. */
	pageIdOf(path: string): string | null {
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
	pathForPageId(pageId: string): string | null {
		for (const [path, rec] of this.byPath) {
			if (rec.pageId === pageId) return path;
		}
		return null;
	}

	/** Fail-closed flag: the persisted payload was unreadable (see NoteRecord). */
	isDamagedLocked(path: string): boolean {
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
	deleteAllReadiness(path: string): InlineDeleteReadiness {
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
	captureDeleteAll(path: string): InlineDeleteCapture | null {
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
	currentMatchesCapture(capture: InlineDeleteCapture): boolean {
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
	 * capture is memory - and memory came from a parser that invents values for
	 * fields the file omits (`PageData.ts:813` stamps a missing `createdAt`
	 * with `Date.now()`). Memory therefore holds the value stamped when the
	 * note opened, the readback holds the value stamped at delete time, and no
	 * amount of round-tripping brings those together: the difference is WHEN
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
	backupMatchesCapture(capture: InlineDeleteCapture, page: PageData, raw?: unknown): boolean {
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
	private throughCodec(capture: InlineDeleteCapture): unknown[] | null {
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
		for (const stroke of strokes) {
			const at = rec.strokes.findIndex((saved) => saved.id === stroke.id);
			if (at < 0) rec.strokes.push(stroke);
			else rec.strokes[at] = stroke;
			rec.localStrokeIds.add(stroke.id);
		}
		rec.mutationGeneration++;
		this.persist(path, rec);
		// Once per pen gesture: the most common mutation of all was the one
		// path that never told the embed layers (ultrareview 2026-08-26).
		notifyInkChanged(path);
	}

	// ---- ink operations (eraser / lasso / history) ------------------------------
	//
	// These are the do/undo/redo primitives. They take captured operands (full
	// strokes or frozen id lists), never live UI state, and every one persists.
	// An undone erase that only changed the screen would resurrect on reload.

	/** Insert strokes (idempotent by id; indices restore z-order on un-erase). */
	applyAdd(path: string, strokes: readonly InkStroke[], indices?: readonly number[]): void {
		const rec = this.record(path);
		this.insert(rec, strokes, indices);
		this.persist(path, rec);
	}

	/**
	 * Live-erase reinsertion: the same splice, NO persistence. The partner to
	 * takeLive, and the reason it exists.
	 *
	 * A partial erase takes each covered stroke out and puts its survivors
	 * back at the same index, once per pointer sample. Going through applyAdd
	 * meant every sample scheduled a write - a serialize of the whole page
	 * behind a debounce, at input rate, during the one gesture that is
	 * already doing splitting and repainting. The eraser's pen-up already
	 * calls save() and says so in a comment; this is what makes that true.
	 */
	applyAddLive(path: string, strokes: readonly InkStroke[], indices?: readonly number[]): void {
		this.insert(this.record(path), strokes, indices);
	}

	/**
	 * Put back what one live partial erase left of the strokes `takeLive` just
	 * took, each stroke's pieces where that stroke was.
	 *
	 * The indices `takeLive` returns are positions in the list BEFORE any of
	 * the strokes came out. Putting each stroke's pieces back at its own index,
	 * one stroke at a time, placed the second stroke's pieces among the first
	 * stroke's: two strokes erased in one pass came back reordered, so a later
	 * stroke's surviving ink could paint under an earlier one's. Here every
	 * group is placed in one pass, shifted by the strokes taken before it and
	 * the pieces already put back before it.
	 *
	 * `groups` holds one entry for every stroke `takeLive` returned, with
	 * empty `pieces` for a stroke the eraser took whole: the shift counts
	 * entries as strokes taken, so a missing entry moves the rest too far.
	 */
	reinsertLive(
		path: string,
		groups: ReadonlyArray<{ readonly index: number; readonly pieces: readonly InkStroke[] }>
	): void {
		const sorted = [...groups].sort((a, b) => a.index - b.index);
		const strokes: InkStroke[] = [];
		const at: number[] = [];
		let placed = 0;
		sorted.forEach((group, taken) => {
			group.pieces.forEach((piece, i) => {
				strokes.push(piece);
				at.push(group.index - taken + placed + i);
			});
			placed += group.pieces.length;
		});
		if (strokes.length > 0) this.insert(this.record(path), strokes, at);
	}

	private insert(
		rec: NoteRecord,
		strokes: readonly InkStroke[],
		indices?: readonly number[]
	): void {
		// Only the incoming ids can clash, so only they are looked up. A Set of
		// every id in the note was built here on each call, and the partial
		// eraser calls this once per hit: on a long note that was an array and
		// a Set of thousands of entries per pointer sample.
		const incoming = new Set<string>();
		for (const s of strokes) incoming.add(s.id);
		const present = new Set<string>();
		for (const s of rec.strokes) if (incoming.has(s.id)) present.add(s.id);
		const insertions: Array<{ stroke: InkStroke; at: number | undefined }> = [];
		strokes.forEach((stroke, i) => {
			if (present.has(stroke.id)) return;
			present.add(stroke.id);
			insertions.push({ stroke, at: indices?.[i] });
		});
		// Captured indices share the pre-erase list, regardless of scrub order.
		// Deduplicate first so sorting cannot replace the first original operand.
		// Partial or malformed metadata keeps the existing traversal/fallback.
		// A lone insertion cannot be out of order, and the live eraser hands
		// over one stroke per sample: the hot path skips the scan and the sort.
		if (insertions.length > 1 && indices?.length === strokes.length &&
			strokes.every((_, i) => Number.isInteger(indices[i]) && indices[i]! >= 0)) {
			insertions.sort((a, b) => a.at! - b.at!);
		}
		insertions.forEach(({ stroke, at }) => {
			rec.localStrokeIds.add(stroke.id);
			if (at !== undefined && at >= 0 && at <= rec.strokes.length) {
				rec.strokes.splice(at, 0, stroke);
			} else {
				rec.strokes.push(stroke);
			}
		});
		// Only a real insertion counts. The live eraser hands over strokes that
		// are already present at input rate, and a generation that moved
		// without the page changing would refuse adoptions for no reason.
		if (insertions.length > 0) rec.mutationGeneration++;
	}

	/** Remove strokes by id. Returns what was removed, with original indices. */
	applyRemove(
		path: string,
		ids: readonly string[]
	): Array<{ stroke: InkStroke; index: number }> {
		const removed = this.take(path, ids);
		if (removed.length > 0) {
			this.persist(path, this.record(path));
			// Deletes are never on the erase hot path (that is applyAdd
			// putting pieces back), so notifying here covers selection
			// delete, delete all, and the remove leg of undo/redo ops.
			notifyInkChanged(path);
		}
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
			rec.localStrokeIds.add(s.id);
			rec.strokes.splice(i, 1);
		}
		if (removed.length > 0) rec.mutationGeneration++;
		removed.reverse(); // ascending original indices
		return removed;
	}

	/** Translate exactly the listed strokes. Missing ids are skipped. */
	moveStrokes(path: string, ids: readonly string[], dx: number, dy: number): void {
		if (dx === 0 && dy === 0) return;
		const rec = this.record(path);
		const wanted = new Set(ids);
		let moved = 0;
		for (const s of rec.strokes) {
			if (wanted.has(s.id)) {
				translateStroke(s, dx, dy);
				rec.localStrokeIds.add(s.id);
				moved++;
			}
		}
		// This is the mutation that changes a stroke IN PLACE rather than
		// changing the list, so it is the one a reference-holding snapshot
		// would miss. See adoptExternal's second qualification.
		if (moved > 0) rec.mutationGeneration++;
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
	async reloadExternal(path: string): Promise<boolean> {
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
	async adoptExternal(path: string, canAdopt?: () => boolean): Promise<ExternalAdoptionResult> {
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
			if (prep.reason === "no-live-sidecar") this.noteAdoptionFailure(rec);
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
		rec.basePage = prep.prepared.data;
		rec.strokes = prep.prepared.data.strokes.slice();
		rec.localStrokeIds.clear();
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
	 * different failure can still speak.
	 */
	private noteAdoptionFailure(rec: NoteRecord): void {
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
		this.host?.notify(ADOPTION_STILL_FAILING);
	}

	/** Diagnostics: what the session cache holds (it never evicts). */
	cacheStats(): { notes: number; strokes: number; points: number } {
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
	async restoreRevision(pageId: string, page: PageData): Promise<string | null> {
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
	save(path: string): void {
		this.persist(path, this.record(path));
		// The in-memory strokes are already the truth even when the disk
		// write is deferred, so rendered embeds repaint from here.
		notifyInkChanged(path);
	}

	private persist(path: string, rec: NoteRecord): void {
		if (!this.host) return; // session-memory mode
		// Ink drawn on a note whose file has not been read yet will not be
		// saved until it is: say so now, once, rather than let it go silently.
		if (rec.damagedLocked && rec.damageSilent) this.noticeTransient(rec);
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

	private trackPersist(work: Promise<void>, label: string): void {
		const pending = work.finally(() => this.pendingPersists.delete(pending));
		this.pendingPersists.add(pending);
		runDetached(pending, label);
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
	retryRefusedClaim(path: string): void {
		const rec = this.byPath.get(path);
		if (!rec || !rec.claimRefused || rec.pageId) return;
		rec.claimRefused = false;
		rec.noticed = false;
		this.persist(path, rec);
	}

	/** The page to write for a record, or null when the record must not write. */
	private snapshot(rec: NoteRecord): PageData | null {
		if (!this.host || !rec.pageId) return null;
		if (rec.legacyLocked || rec.futureLocked || rec.damagedLocked) return null;
		if (rec.duplicateLocked) return null;
		const base = rec.basePage ?? emptyPage(rec.pageId);
		const fontRefPx = base.fontRefPx ?? rec.fontRefPx;
		return {
			...base,
			pageId: rec.pageId,
			surface: "inline",
			strokes: rec.strokes,
			...(fontRefPx !== undefined ? { fontRefPx } : {}),
		};
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
	 *
	 * Returns TRUE when everything drained and FALSE when the deadline won -
	 * callers that are about to move files need to know the difference,
	 * because proceeding after a timeout can race a write into a directory
	 * being emptied.
	 */
	async settle(maxWaitMs = 2000): Promise<boolean> {
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

	private noteOnce(rec: NoteRecord, message: string): void {
		if (rec.noticed) return;
		rec.noticed = true;
		this.host?.notify(message);
	}

	/** The one notice a transient lock gives, when its silence runs out. */
	private noticeTransient(rec: NoteRecord): void {
		if (rec.transientNoticed) return;
		rec.transientNoticed = true;
		rec.damageSilent = false;
		this.noteOnce(rec, TRANSIENT_NOTICE);
	}

	// ---- vault lifecycle --------------------------------------------------------

	/** The note moved. Its ink and its identity (the id is in the file) move too. */
	handleRename(oldPath: string, newPath: string): void {
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

	private renames = new Map<string, string>();
	private static readonly RENAMES_CAP = 256;

	/** Entries the path is either end of. */
	private dropRenamesTouching(path: string): void {
		for (const [from, to] of this.renames) if (from === path || to === path) this.renames.delete(from);
	}

	/** Pending renames not yet consumed; read by tests. */
	get pendingRenameCount(): number {
		return this.renames.size;
	}

	/** True, once, when the vault renamed `from` to `to` since the last ask. */
	consumeRename(from: string, to: string): boolean {
		if (this.renames.get(from) !== to) return false;
		this.renames.delete(from);
		return true;
	}

	/** The note is gone; a future note reusing its path starts clean. */
	handleDelete(path: string): void {
		this.byPath.delete(path);
		this.dropRenamesTouching(path);
	}

	// ---- duplicate page ids -------------------------------------------------

	/**
	 * Fail closed on an ambiguous duplicate: this note's writes are blocked
	 * (its id is shared and no safe owner exists) and the user is told once,
	 * with the fix spelled out. Rendering is untouched.
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
		// Strokes drawn while locked were refused at the snapshot and are in
		// memory only. Save them now, or they are gone at restart.
		if (rec.strokes.length > 0) this.persist(path, rec);
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
	private scheduleLoaded(path: string, rec: NoteRecord): void {
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
}
