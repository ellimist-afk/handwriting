/**
 * A PDF's ink, for the session and for the disk.
 *
 * A deliberate sibling of `InlineInkStore` rather than a generalization of it.
 * The note store carries locks that were each paid for with a bug - page-id
 * claiming, frontmatter round-trips, legacy canvas surfaces, duplicate-id
 * detection - and none of them apply here: a PDF's id comes from its own
 * bytes, so there is nothing to claim, nothing to write into the file, and no
 * older format to refuse. Sharing the code would mean carrying five
 * conditions that are always false, and risking the store that already works.
 *
 * What IS carried over, because they are not incidental:
 *
 * - **Never snapshot mid-load.** A save while the sidecar is still being read
 *   would hold only this session's strokes and, written, replace the ones on
 *   disk. Every mutation path defers behind the read.
 * - **Fail closed on an unreadable sidecar.** If the bytes could not be
 *   understood, `data` is a placeholder rather than the user's ink, and
 *   writing it would destroy what the file held. Locked, with one notice.
 * - **Refuse a future schema.** A sidecar from a newer version is not ours to
 *   rewrite.
 *
 * Strokes are stored flat and filtered by page on read. A hundred-page
 * document holds one record, not a hundred: the page is a property of the
 * stroke (see `InkStroke.page`), which is what makes "move this stroke to
 * another page" a field change rather than a migration.
 */

import { InkStroke } from "../ink/Stroke";
import { PageData, ParseResult, emptyPage, parsePage, serializePage } from "../model/PageData";
import { ADOPTION_QUIET_MS, ADOPTION_RUN_GAP_MS, ADOPTION_STILL_FAILING } from "../inline/InlineInkStore";
import type {
	ExternalAdoptionHeldReason,
	ExternalAdoptionResult,
} from "../inline/InlineInkStore";
import type { ExternalAdoptionPrep, PreparedExternalAdoption } from "../persistence/PageStore";
import { contentStamp } from "../persistence/PageStore";
import { InkFolderListingFailed } from "../persistence/InkFolder";
import { runDetached } from "../util/Detached";
import { applyOp } from "./PdfInkHistory";
import { carriedBase } from "./PdfCarryBase";
import type { InkOp } from "../inline/InkHistory";
import { timerHost } from "../util/RuntimeScheduler";
import {
	familyOf,
	isDeletedClaim,
	isLeavingClaim,
	isNewFor,
	isPdfInkId,
	offeredPaths,
	pairWaiting,
	pairsByName,
	waitingClaims,
	waitingKey,
	type WaitingDeletion,
} from "./PdfIdentity";

const EMPTY: readonly InkStroke[] = [];
/** The wait before a deferred deletion's first retry. Each later wait is twice the last, up to the ceiling below. */
const DEFERRED_RETRY_FIRST_MS = 10_000;
/** The longest wait between two retries of a deferred deletion. */
const DEFERRED_RETRY_MOST_MS = 5 * 60_000;
/**
 * How long a PDF's create counts as new at a delete. A sync tool may send a rename as the new name first and the
 * old name's removal up to a minute later. The cost: a same-bytes copy made this close before its original is
 * deleted takes the original's ink. The wait after a delete is the context's grace, apart from this.
 */
const PDF_CREATE_MARK_MS = 90_000;
const MISSING_INK_FILE = "this PDF's ink file is missing.\n\nyour ink is still on screen. your next stroke saves it again.";

/**
 * What the visible ink looks like, for deciding whether a reload changed
 * anything worth repainting.
 *
 * Ids and positions, not a count: an erase-to-empty, a paste and a move all
 * have to register, and identical content must not. A blanket "something was
 * read" makes every poll tick repaint, and on a platform whose file times are
 * approximate that is a flicker once a second forever.
 */
function inkFingerprint(strokes: readonly InkStroke[]): string {
	return strokes.map((s) => `${s.page}/${s.id}:${s.bbox.x},${s.bbox.y}`).join("|");
}

/** A detached lossless copy captured before preservation begins awaiting I/O. */
function freezePage(page: PageData): PageData | null {
	return typeof structuredClone === "function" ? structuredClone(page) : null;
}

function adoptionHeld(reason: ExternalAdoptionHeldReason): ExternalAdoptionResult {
	return { outcome: "held", changed: false, reason };
}

const ADOPTION_UNAVAILABLE: ExternalAdoptionResult = { outcome: "unavailable", changed: false };

/**
 * The coordinate convention every pdf stroke is written in: page-local css px
 * at scale 1.0, top-left origin of the page div.
 *
 * Stamped on every write so a later migration can be versioned. Both this and
 * PDF user units produce plausible-looking numbers, so a file that does not
 * say which one it used cannot be told apart afterwards - the stamp is the
 * only thing that would make such a migration safe rather than a guess.
 */
export const PDF_COORD_SPACE = "page-css@1";

/**
 * The persistence this store needs. `PageStore` satisfies it as-is.
 *
 * `schedule` takes NO writer, and that is load-bearing rather than an
 * omission. `PageStore.reconcileInProcess` unions the page on disk with the
 * one being written whenever a DIFFERENT in-process writer of the same store
 * has already written that id. A union is correct there: two canvas panes are
 * peers, neither is authoritative, and a stroke either holds is one the user
 * made and nobody deliberately removed.
 *
 * It is wrong for anything that can receive an EXTERNAL revision. A revision
 * that arrives by sync is a different authority, not a peer - erase a stroke
 * on one device and a union resurrects it from the other's copy, on every
 * sync, silently.
 *
 * PDFs cannot reach the union today only because they pass no writer through
 * this signature. That containment is an accident of the interface, not a
 * stated rule. Add a writer parameter here and PDFs inherit the union with no
 * other change - and it would present as a sync bug rather than as the
 * interface change that caused it.
 */
export interface PdfInkHost {
	load(id: string, options?: { restore?: boolean }): Promise<ParseResult | null>;
	schedule(id: string, data: PageData): void;
	notice(message: string): void;
	prepareExternalAdoption?(id: string, outgoing: PageData): Promise<ExternalAdoptionPrep>;
	acceptExternalAdoption?(prepared: PreparedExternalAdoption): void;
}

/** Only the claim and recycle operations needed for a deleted PDF. */
interface PdfClaimStore {
	listIds(prefix: string): Promise<string[]>;
	readPdfPaths(id: string): Promise<string[] | null>;
	/** Null when there is no live ink file; used here only to tell that from one whose claim cannot be read. */
	readPdfClaim(id: string): Promise<{ paths: string[] | null; mtime: number } | null>;
	/** True when no live ink file is left for `id`; false when the move into the trash failed or the page is queued again. */
	remove(id: string): Promise<boolean>;
	/** Where the ink file for `id` is. */
	resolvePath(id: string): Promise<string>;
	readText(path: string): Promise<string>;
	/** The content stamp of the bytes this session last read or wrote for each id. A failed write does not move it. */
	readonly knownHash: ReadonlyMap<string, string>;
	hasQueuedWrite(id: string): boolean;
}

/** What retiring a deleted PDF's claim reads from the vault and the sidecars. */
export interface PdfDeleteContext {
	store: PdfClaimStore;
	listPdfPaths: () => string[];
	familyForPath: (path: string) => Promise<string | null>;
	graceMs: number;
	/**
	 * Let go of a record the retirement loaded, once what it holds is on disk,
	 * unless a pane shows it. Only the host knows the panes.
	 */
	release: (id: string) => void;
	/**
	 * The retirement put ink `id`'s claim on `path`, a new name for the deleted file. A pane there still on a blank
	 * opened before the vault's list was full moves to it. Only the host knows the panes.
	 */
	inkPairedOnto?: (path: string, id: string) => void;
	/**
	 * Each leave owed off `path` that ink `id` is a side of (the found ink that is to leave the path, or the kept ink it
	 * leaves it to), with the names the copy had before a rename while the leave was owed. Read from the owed leaves at
	 * each call; nothing of it is kept on the deletion. Only the host knows the leaves.
	 */
	leaveTies?: (id: string, path: string) => LeaveTie[];
	/**
	 * The retirement moved ink `id`'s claim off the deleted `path` onto `next`, a name the copy had while a leave was owed
	 * off `path`: the copy moved back by a delete and a create. Each such leave `id` is a side of is owed off `next` now,
	 * as a rename moves it. Only the host knows the leaves.
	 */
	leaveMovedBack?: (id: string, path: string, next: string) => void;
	/**
	 * Each leave owed off `path`, under any name the copy had: its found ink and its kept ink. Read at each call; nothing of
	 * it is kept on the deletion. Only the host knows the leaves.
	 */
	leavesOff?: (path: string) => { found: string; kept: string }[];
	/**
	 * The ink `kept` moved off the deleted `path` onto `next`, its next name, while the leave of `found` off `path` for it was
	 * owed: that leave is owed off `next` now, `path` among the names the copy had, as a rename moves it. Only the host
	 * knows the leaves.
	 */
	leaveFollowed?: (found: string, kept: string, path: string, next: string) => void;
	/**
	 * Each name the file at `path` had before a rename whose claim move has not landed, with the content family that
	 * move read from the file, asked at the delete: the deleted file's ink may still claim that name. A move with no
	 * family read yet is not named. Only the host knows the moves.
	 */
	renamedFrom?: (path: string) => { path: string; family: string }[];
	/**
	 * The content families of files renamed off `path` whose claim moves have not landed and that stand elsewhere now,
	 * asked at the delete: ink of such a family that claims `path` is that live file's, not the deleted file's. Only the
	 * host knows the moves.
	 */
	keptFor?: (path: string) => string[];
	/**
	 * The content families of files renamed off `oldPath` whose claim moves have not landed, each standing now at a path
	 * other than `deletedPath`, asked at the retirement: ink of such a family on `oldPath` is that live file's, and its
	 * own move carries it. A move whose file was at `deletedPath` is the deleted file's own and is passed over. Only the
	 * host knows the moves.
	 */
	renamedOffStanding?: (oldPath: string, deletedPath: string) => string[];
}

/** A leave owed off a path: its found ink, its kept ink, and the names the copy had before a rename while it was owed. */
export interface LeaveTie {
	found: string;
	kept: string;
	was: readonly string[];
}

/**
 * Where deletions still in their grace are kept across a restart, and what
 * retiring a restored one needs. Without it a deletion still in its grace at
 * quit is forgotten, as it always was.
 */
export interface PdfPendingDeleteStore {
	load(): unknown;
	save(saved: string | null): void;
	context(): PdfDeleteContext;
}

/** One deletion still in its grace, as kept across a restart. */
interface SavedPendingDelete {
	path: string;
	existingPaths: string[];
	/** PendingPdfDeletion.held; absent when empty, and in lists saved before it. */
	held?: string[];
	/** PendingPdfDeletion.paired; absent when false, and in lists saved before it. */
	paired?: true;
	/** PendingPdfDeletion.arrived; absent when empty, and in lists saved before it. */
	arrived?: string[];
	/**
	 * PendingPdfDeletion.moved; written, empty or not, for a file renamed onto the path with ink arrived there (`onto`
	 * and `arrived`), absent otherwise and in lists saved before it. Absent there, the list is an earlier build's: it
	 * took every arrived ink as come with the file, so it is read as all moved.
	 */
	moved?: string[];
	/** PendingPdfDeletion.newAtDefer; absent until its retirement deferred, and in lists saved before it. */
	deferred?: string[];
	/**
	 * Set when existingPaths holds the deleted path: a file that existed at the delete was renamed onto it. Absent in
	 * lists an older build saved, whose existingPaths could hold the deleted path only because the vault still listed
	 * it when the delete was heard.
	 */
	onto?: true;
}

interface PendingPdfDeletion {
	existingPaths: Set<string>;
	listPdfPaths: () => string[];
	familyForPath: (path: string) => Promise<string | null>;
	store: PdfClaimStore;
	release: (id: string) => void;
	inkPairedOnto?: (path: string, id: string) => void;
	leaveTies?: (id: string, path: string) => LeaveTie[];
	leaveMovedBack?: (id: string, path: string, next: string) => void;
	leavesOff?: (path: string) => { found: string; kept: string }[];
	leaveFollowed?: (found: string, kept: string, path: string, next: string) => void;
	renamedOffStanding?: (oldPath: string, deletedPath: string) => string[];
	timer: number;
	/**
	 * Its retirement has paired, or this deletion was one of two or more of
	 * its family pending at once, at a retirement or at an open that paired
	 * by name (markPaired). Kept once set, across a restart too: the last of
	 * them to retire is alone by then, and taking the first new file in vault
	 * order would hand it a path the pairing left to nobody.
	 */
	paired: boolean;
	/**
	 * New paths an open paired by name and found unpaired, so opened blank
	 * (PdfIdentity.chooseInstance), while this claim was one it paired. Each
	 * still counts for this claim though its blank instance claims it, and is
	 * never given this claim's ink: otherwise the file it tied with took that
	 * ink by elimination. Kept for as long as this deletion is pending, and
	 * across a restart with it; it never looks at the blank's strokes or pane.
	 */
	held: Set<string>;
	/**
	 * Ink ids that came to claim the deleted path after another file that
	 * existed at the delete was renamed onto it (the path is then in its own
	 * existingPaths while that file is on it: notePdfRenamed). They are that
	 * file's ink, or the blank it opened with, never the deleted file's: its
	 * retirement passes them by and an open may use them. Kept across a
	 * restart; not carried into a deletion that replaces this one.
	 */
	arrived: Set<string>;
	/**
	 * The arrived ids moved onto the path from the old name of the file renamed onto it (renamePath): the ink it came
	 * with. With none, ink of that file's bytes claiming the path is that file's too, in whatever order it reached
	 * this device (ontoFamily); with one, only `arrived` is. Kept across a restart, as `arrived` is.
	 */
	moved: Set<string>;
	/**
	 * The content family of the file renamed onto the path, read while it is on it. Undefined until read, or when the
	 * read failed. Session memory only: read again after a restart, and by every retirement.
	 */
	ontoFamily?: string | null;
	/** Counts the reads of ontoFamily, so a read that ends after the file left the path, or after a newer read, is dropped. */
	ontoReads: number;
	/**
	 * Every name a file renamed onto the deleted path has had since it was
	 * renamed off it again in this session. The path left existingPaths with
	 * it, but the claim move that rename started may still be running, and it
	 * must not take the deleted file's claim along (claimHeldByDeletion).
	 * Session memory only: a claim move does not outlive its session.
	 */
	leftTo: Set<string>;
	/**
	 * Set at its retirement's first defer, on a new path it could not read: the paths new for it then. From then
	 * on only these, under the names vault renames give them (notePdfRenamed), are new for it, at a retry and at an
	 * open; a path created after is not (PdfIdentity.isNewFor). Kept across a restart, saved as `deferred`. A
	 * deletion that replaces this one does not take it, but every path in it stays new there (pathsAtDeletion). A
	 * path in it moved again by a sync delete and create is not followed: a known gap, its ink goes to the trash.
	 */
	newAtDefer?: Set<string>;
	/** The wait before its next retry once deferred: 0 before the first. Session memory only. */
	retryMs: number;
	/**
	 * Each ink file its retirement found still the bytes the session last read or wrote (isOwnRevision), by their
	 * stamp. A remove lets go of the store's stamp before its move into the trash, and a failed move does not give it
	 * back: a retry knows the same bytes by this. Session memory only.
	 */
	ownStamps: Map<string, string>;
	/**
	 * The names the deleted file had before a rename whose claim move had not landed at the delete, each with the
	 * family that move read (PdfDeleteContext.renamedFrom). Ink of that family still claiming such a name, with no file
	 * there now, is the deleted file's too, whatever became of the move. Session memory only, not saved: a relaunch
	 * before the retirement retires the path alone, as before.
	 */
	oldNames: readonly { path: string; family: string }[];
	/**
	 * The families of files renamed off the path that stood elsewhere at the delete, their claim moves not landed
	 * (PdfDeleteContext.keptFor). Their ink on the path is theirs: the retirement leaves it. Session memory only, not
	 * saved, as `oldNames`.
	 */
	keptFamilies: ReadonlySet<string>;
}

interface PdfRecord {
	strokes: InkStroke[];
	/** Monotonic session generation; catches A -> B -> A across an await. */
	mutationGeneration: number;
	load: "no" | "loading" | "yes";
	/** The parsed sidecar, kept so unknown keys survive a round-trip. */
	basePage: PageData | null;
	/**
	 * The vault paths this sidecar belongs to - instance identity's anchor
	 * (see PdfIdentity.chooseInstance). Null until a claim or a load sets
	 * it; authoritative once set, and written out as `pdfPaths`.
	 */
	claimedPaths: string[] | null;
	loadInFlight: Promise<void> | null;
	/** The sidecar could not be read; writing would destroy it. */
	unreadableLocked: boolean;
	/** Written by a newer Handwriting; not ours to rewrite. */
	futureLocked: boolean;
	/** The unreadable lock's notice was shown. */
	noticed: boolean;
	/** The newer-version lock's notice was shown: its own flag, so a record that was unreadable first still says it. */
	futureNoticed: boolean;
	/**
	 * The other device's ink failing to load, as a note keeps it: the first
	 * failure of a run, the last one, and whether this run has spoken. See
	 * noteAdoptionFailure.
	 */
	adoptionNoticed: boolean;
	adoptionFailingSince: number | null;
	adoptionLastFailureAt: number | null;
	/**
	 * One page's strokes while a live erase runs on it; see applyLivePage.
	 * `slots` are the positions that page's strokes held in `strokes` when the
	 * gesture began, and `list` is that page as the gesture has left it.
	 * `strokes` is stale for this page until `materialize` folds `list` back.
	 */
	live: { page: number; slots: number[]; list: InkStroke[] } | null;
	/** Strokes by page, for the `strokes` array and length it was built from. */
	byPage: { from: InkStroke[]; length: number; pages: Map<number, InkStroke[]> } | null;
}

function freshRecord(): PdfRecord {
	return {
		strokes: [],
		mutationGeneration: 0,
		load: "no",
		basePage: null,
		claimedPaths: null,
		loadInFlight: null,
		unreadableLocked: false,
		futureLocked: false,
		noticed: false,
		futureNoticed: false,
		adoptionNoticed: false,
		adoptionFailingSince: null,
		adoptionLastFailureAt: null,
		live: null,
		byPage: null,
	};
}

/**
 * Records whose ink changed while their file could not be read, so a save was refused. The pen, paste, delete, a
 * dragged selection and undo all end in that one refusal, and so does a rename's claim move. The next sound read
 * saves them once, merged with the file. The mark is dropped only where persist hands that save off: parked behind
 * the read (parkedInk counts it from there) or given to the host's schedule (the page store carries it from there).
 * Under either lock persist returns before both, so the ink stays owed and counts at the exits (owedAtExit).
 */
const unsavedWhileUnreadable = new WeakSet<PdfRecord>();

/**
 * The names a locked record's claim was renamed off. The save was refused, so the file still names them. The sound
 * read that lifts the lock takes them off the file's names before joining those with the session's, and drops the
 * set. Joined whole, the old name came back with that read and its save, and a same-bytes file at the old name
 * opened wearing this ink.
 */
const renamedOffUnderLock = new WeakMap<PdfRecord, Set<string>>();

/**
 * Fold a live page back into the document list. Every stroke that survived
 * the gesture stays in its own slot, and new pieces follow the survivor before
 * them (or come first, at the page's first slot); a removed stroke's slot is
 * dropped. Keeping survivors in place is what lets the pen-up diff describe
 * the gesture as removals and insertions alone, so undo puts a restored
 * stroke back under the strokes it was under. Every other page is untouched.
 */
function materialize(rec: PdfRecord): void {
	const live = rec.live;
	if (!live) return;
	rec.live = null;
	const { slots, list } = live;
	if (slots.length === 0) {
		rec.strokes = [...rec.strokes, ...list];
		return;
	}
	const kept = keepSlots(rec.strokes, slots, list);
	if (kept) {
		rec.strokes = kept;
		return;
	}
	// The page's survivors changed order, which an erase never does: fill the
	// slots in list order instead, extra pieces after the last slot.
	const out: InkStroke[] = [];
	let next = 0;
	let slot = 0;
	for (let i = 0; i < rec.strokes.length; i++) {
		if (slot < slots.length && slots[slot] === i) {
			if (slot === slots.length - 1) while (next < list.length) out.push(list[next++]!);
			else if (next < list.length) out.push(list[next++]!);
			slot++;
		} else out.push(rec.strokes[i]!);
	}
	rec.strokes = out;
}

/**
 * The document with the live page folded back, survivors in their own slots;
 * null when the page's survivors are not in slot order.
 *
 * The survivors cut the page into gaps. A new piece belongs to the gap it sits
 * in within `list`, and takes that gap's removed slots in order; pieces beyond
 * them follow the gap's last removed slot, and a gap with no removed slot puts
 * its pieces at the next survivor's slot, or after the last survivor.
 */
function keepSlots(strokes: readonly InkStroke[], slots: readonly number[], list: readonly InkStroke[]): InkStroke[] | null {
	const slotOf = new Map<string, number>();
	slots.forEach((i, k) => slotOf.set(strokes[i]!.id, k));
	const survivor = new Set<number>();
	const pieces: InkStroke[][] = [[]];
	let last = -1;
	for (const s of list) {
		const k = slotOf.get(s.id);
		if (k !== undefined && !survivor.has(k)) {
			if (k < last) return null;
			last = k;
			survivor.add(k);
			pieces.push([]);
		} else pieces[pieces.length - 1]!.push(s);
	}
	// Per gap, its removed slots.
	const removed: number[][] = pieces.map(() => []);
	let gap = 0;
	for (let k = 0; k < slots.length; k++) {
		if (survivor.has(k)) gap++;
		else removed[gap]!.push(k);
	}
	const out: InkStroke[] = [];
	const used = pieces.map(() => 0);
	const flush = (g: number) => {
		out.push(...pieces[g]!.slice(used[g]));
		used[g] = pieces[g]!.length;
	};
	let k = 0;
	gap = 0;
	for (let i = 0; i < strokes.length; i++) {
		if (k < slots.length && slots[k] === i) {
			if (survivor.has(k)) {
				if (removed[gap]!.length === 0) flush(gap);
				out.push(strokes[i]!);
				gap++;
				if (gap === pieces.length - 1 && removed[gap]!.length === 0) flush(gap);
			} else {
				const g = removed[gap]!;
				if (used[gap]! < pieces[gap]!.length) out.push(pieces[gap]![used[gap]!++]!);
				if (g[g.length - 1] === k) flush(gap);
			}
			k++;
		} else out.push(strokes[i]!);
	}
	return out;
}

function strokeCount(rec: PdfRecord): number {
	return rec.live ? rec.strokes.length - rec.live.slots.length + rec.live.list.length : rec.strokes.length;
}

export class PdfInkStore {
	private byId = new Map<string, PdfRecord>();
	private host: PdfInkHost | null = null;
	private pendingDeleted = new Map<string, PendingPdfDeletion>();
	/**
	 * When each PDF this session saw created was created, once the layout was
	 * ready. Session memory only: a sync rename can land its new file just
	 * before it deletes the old one, and a file that new must not count as
	 * having existed at the delete.
	 */
	private readonly createdAt = new Map<string, number>();
	/** Retirements run one at a time: each reads the claims after the one before has written. */
	private retiring: Promise<void> = Promise.resolve();
	/** Where the deletions above outlive a restart; none until the plugin attaches one. */
	private pendingStore: PdfPendingDeleteStore | null = null;
	/** Saves parked behind a sidecar read, until each has run. */
	private parkedPersists = new Set<Promise<void>>();
	/** How many of those saves each document has waiting. An adoption is held while its document has one. */
	private parkedById = new Map<string, number>();
	/** When the deletions restored from the last session start their grace; see the constructor. */
	private readonly afterLayout: ((start: () => void) => void) | undefined;
	/** What waits for the layout, run in order by the one start handed to `afterLayout` (whenLayoutReady). */
	private layoutWaiting: (() => void)[] | undefined;
	/** That start has run: the layout is ready. */
	private layoutCame = false;
	/**
	 * Set from the restore of last session's deletions until their `start` runs: the vault may not list every file yet,
	 * so an open that pairs by name decides nothing (WaitingDeletion.beforeList). Session memory only.
	 */
	private listPending = false;
	/** Ids opened blank while the list was pending; each counts as such while it stays blank and unwritten (earlyBlank). */
	private readonly openedBeforeList = new Set<string>();

	/**
	 * `afterLayout` is handed one `start` for the deletions restored from the
	 * last session and runs it once the app's layout is ready: the app lists
	 * the vault only after every plugin has loaded, so a grace timed from the
	 * load could end while the vault still listed no file, and read a PDF back
	 * at its name, or a sync rename's new name, as gone. With none, as every
	 * harness that builds the store bare, `start` runs at once.
	 */
	constructor(opts: { afterLayout?: (start: () => void) => void } = {}) {
		this.afterLayout = opts.afterLayout;
	}

	/**
	 * Best-effort unload: wait (bounded) for in-flight sidecar reads. A stroke
	 * committed during a read parks its persist as a `then` on that read's
	 * promise, so it reaches the host's `schedule` only once the read lands - a
	 * store flush that runs first finds nothing to write for it. Waiting on the
	 * read is enough: the parked `then` runs before this wait resumes, and the
	 * passes re-check for a read that started meanwhile.
	 * `InlineInkStore.settle`'s shape and reasons: bounded so a hung read cannot
	 * wedge shutdown. TRUE only when everything drained. Not crash durability.
	 */
	async settle(maxWaitMs = 2000): Promise<boolean> {
		let expire: (v: boolean) => void = () => {};
		const deadline = new Promise<boolean>((r) => {
			expire = r;
		});
		const scheduler = timerHost();
		const timer = scheduler.setTimeout(() => expire(true), maxWaitMs);
		try {
			for (let pass = 0; pass < 4; pass++) {
				const inFlight: Promise<unknown>[] = [];
				for (const rec of this.byId.values()) if (rec.loadInFlight) inFlight.push(rec.loadInFlight);
				if (inFlight.length === 0) return true;
				const timedOut = await Promise.race([Promise.all(inFlight).then(() => false), deadline]);
				if (timedOut) return false;
			}
			return false;
		} finally {
			scheduler.clearTimeout(timer);
		}
	}

	/**
	 * Ink is waiting to be saved: a stroke's save parked behind a read. A settle that gave up with none parked left
	 * only a read open, and no ink rides on it; the unload notice asks this.
	 */
	parkedInk(): boolean {
		return this.parkedPersists.size > 0;
	}

	/** No host = session-memory mode, which is how the tests run it. */
	attachHost(host: PdfInkHost): void {
		this.host = host;
	}

	/**
	 * Deletions that were still in their grace when Obsidian last quit. Each
	 * one gets its grace again and goes on blocking adoption meanwhile.
	 * Dropped at quit, as they used to be, the deleted copy's sidecar claimed
	 * only a path that no longer existed, and the next session handed it -
	 * ink and all - to the first same-byte file opened, usually the template
	 * the copy was made from.
	 *
	 * Each is restored now, so it blocks adoption from the load on, but its
	 * grace starts at `afterLayout` (the constructor). A live delete of the
	 * same path before then replaces it and keeps its own grace; one an open or
	 * a rename cancelled is gone. `start` arms only an entry still the one
	 * restored here.
	 */
	attachPendingDeletes(store: PdfPendingDeleteStore): void {
		this.pendingStore = store;
		const context = store.context();
		let raw = store.load();
		try {
			if (typeof raw === "string") raw = JSON.parse(raw);
		} catch {
			raw = null;
		}
		if (!Array.isArray(raw)) return;
		const restored: [string, PendingPdfDeletion][] = [];
		for (const entry of raw as unknown[]) {
			const saved = entry as Partial<SavedPendingDelete> | null;
			if (typeof saved?.path !== "string" || !Array.isArray(saved.existingPaths)) continue;
			let existing = saved.existingPaths.filter((p): p is string => typeof p === "string");
			// Saved by an older build: its list took in whatever the vault still listed at the delete, the deleted name
			// too, and nothing in the entry says a file was renamed onto the name, so the name is not in the list. This
			// build marks a rename onto the name (onto); an entry with a field only later builds write (held, paired,
			// arrived, deferred) keeps its list as saved.
			const old =
				saved.onto !== true &&
				saved.held === undefined &&
				saved.paired === undefined &&
				saved.arrived === undefined &&
				saved.moved === undefined &&
				saved.deferred === undefined;
			if (old) existing = existing.filter((p) => p !== saved.path);
			const held = Array.isArray(saved.held) ? saved.held.filter((p): p is string => typeof p === "string") : [];
			const arrived = Array.isArray(saved.arrived) ? saved.arrived.filter((p): p is string => typeof p === "string") : [];
			const deferred = Array.isArray(saved.deferred) ? saved.deferred.filter((p): p is string => typeof p === "string") : undefined;
			const moved = Array.isArray(saved.moved)
				? saved.moved.filter((p): p is string => typeof p === "string" && arrived.includes(p))
				: saved.onto === true
					? arrived
					: [];
			const pending = this.recordDeletion(saved.path, context, existing, held, saved.paired === true, arrived, deferred);
			for (const id of moved) pending.moved.add(id);
			this.readOnto(saved.path, pending);
			restored.push([saved.path, pending]);
			this.savePendingDeletes();
		}
		if (restored.length === 0) return;
		const start = (): void => {
			this.listPending = false;
			for (const [path, pending] of restored) {
				if (this.pendingDeleted.get(path) === pending) this.armRetirement(path, pending, context.graceMs);
			}
		};
		if (this.afterLayout) {
			this.listPending = true;
			this.whenLayoutReady(start);
		} else start();
	}

	/**
	 * Run `fn` once the app's layout is ready, after what was handed here before it. `afterLayout` is handed one start
	 * for all of them, the first time one waits, and runs it then; from that start on, and with no `afterLayout` (as
	 * every harness that builds the store bare), `fn` runs at once. Never waited on: the app makes the layout ready only
	 * once every plugin's load has ended.
	 */
	whenLayoutReady(fn: () => void): void {
		if (!this.afterLayout || this.layoutCame) return fn();
		if (this.layoutWaiting) {
			this.layoutWaiting.push(fn);
			return;
		}
		const waiting = [fn];
		this.layoutWaiting = waiting;
		this.afterLayout(() => {
			this.layoutCame = true;
			this.layoutWaiting = undefined;
			for (const f of waiting) f();
		});
	}

	/** Something waits for the app's layout (whenLayoutReady) and its start has not run yet. */
	waitsForLayout(): boolean {
		return this.afterLayout !== undefined && !this.layoutCame;
	}

	/** Write the deletions in their grace where the next session will find them. */
	private savePendingDeletes(): void {
		if (!this.pendingStore) return;
		const saved: SavedPendingDelete[] = [...this.pendingDeleted].map(([path, p]) => ({
			path,
			existingPaths: [...p.existingPaths],
			...(p.held.size > 0 ? { held: [...p.held] } : {}),
			...(p.paired ? { paired: true as const } : {}),
			...(p.arrived.size > 0 ? { arrived: [...p.arrived] } : {}),
			...(p.moved.size > 0 || (p.existingPaths.has(path) && p.arrived.size > 0) ? { moved: [...p.moved] } : {}),
			...(p.newAtDefer ? { deferred: [...p.newAtDefer] } : {}),
			...(p.existingPaths.has(path) ? { onto: true as const } : {}),
		}));
		this.pendingStore.save(saved.length > 0 ? JSON.stringify(saved) : null);
	}

	strokes(id: string): readonly InkStroke[] {
		return this.held(id)?.strokes ?? EMPTY;
	}

	/**
	 * This page's strokes, in the order they were drawn. Served from a
	 * by-page index built once per change of the document list, so a caller
	 * asking at input rate pays for the page, not for every page's ink.
	 */
	strokesOnPage(id: string, page: number): InkStroke[] {
		const rec = this.byId.get(id);
		if (!rec) return [];
		if (rec.live?.page === page) return [...rec.live.list];
		let index = rec.byPage;
		if (!index || index.from !== rec.strokes || index.length !== rec.strokes.length) {
			const pages = new Map<number, InkStroke[]>();
			for (const s of rec.strokes) {
				const list = pages.get(s.page as number);
				if (list) list.push(s);
				else pages.set(s.page as number, [s]);
			}
			index = rec.byPage = { from: rec.strokes, length: rec.strokes.length, pages };
		}
		return [...(index.pages.get(page) ?? [])];
	}

	hasInk(id: string): boolean {
		const rec = this.byId.get(id);
		return !!rec && strokeCount(rec) > 0;
	}

	/** A destructive gesture needs the first sound sidecar read in hand. */
	inkReady(id: string): boolean {
		const rec = this.byId.get(id);
		return !!rec && rec.load === "yes" && !rec.loadInFlight && !rec.unreadableLocked && !rec.futureLocked;
	}

	/**
	 * Apply one live op of a gesture on a single page, without writing: the
	 * eraser's per-sample path. The op's indices are positions in that page's
	 * stroke list, not the document's. The first op of a gesture takes the
	 * page out of the document list once; every op after it costs the page
	 * alone, however much ink the other pages hold. Anything that reads the
	 * whole document folds the page back first.
	 */
	applyLivePage(id: string, op: InkOp): void {
		if (op.type !== "replace") throw new Error("Handwriting: applyLivePage takes a single-page replace");
		const page = (op.removed[0] ?? op.inserted[0])?.page;
		if (typeof page !== "number") return;
		const rec = this.record(id, false);
		if (rec.live && rec.live.page !== page) materialize(rec);
		if (!rec.live) {
			const slots: number[] = [];
			for (let i = 0; i < rec.strokes.length; i++) if (rec.strokes[i]!.page === page) slots.push(i);
			rec.live = { page, slots, list: slots.map((i) => rec.strokes[i]!) };
		}
		rec.live.list = applyOp(rec.live.list, op);
		rec.mutationGeneration++;
	}

	/** The record with any live page folded back, for readers of the whole document. */
	private held(id: string): PdfRecord | undefined {
		const rec = this.byId.get(id);
		if (rec) materialize(rec);
		return rec;
	}

	/**
	 * Can this document's ink reach the disk right now?
	 *
	 * A read-only question, asked by destructive commands that need to know
	 * their safety copy is worth anything. It reports existing state and
	 * changes none: no host is attached, no load is started or finished, no
	 * lock is cleared, no write is scheduled, no identity is invented.
	 *
	 * The conditions are `persist`'s own refusals asked positively. Session
	 * memory, an unfinished read, and the two locks are exactly the states in
	 * which a scheduled write never lands - so the ink on screen is not in the
	 * file and a copy of that file does not contain it. `reloadExternal`
	 * refuses on the same three flags, for the neighbouring reason. The
	 * completed load is the fourth: a record that has not read its sidecar
	 * cannot say what is in it yet.
	 *
	 * Deliberately NOT a question about queued writes. `preserve` settles
	 * those on purpose, and treating a pending save as unready would refuse
	 * every ordinary deletion.
	 */
	canPersist(id: string): boolean {
		const rec = this.byId.get(id);
		if (!rec) return false; // never touched: nothing is loaded
		return (
			this.host !== null &&
			rec.load === "yes" &&
			!rec.loadInFlight &&
			!rec.unreadableLocked &&
			!rec.futureLocked
		);
	}

	/** Diagnostics: documents held, and how much ink between them. */
	stats(): { documents: number; strokes: number } {
		let strokes = 0;
		for (const rec of this.byId.values()) strokes += strokeCount(rec);
		return { documents: this.byId.size, strokes };
	}

	private record(id: string, fold = true): PdfRecord {
		let rec = this.byId.get(id);
		if (!rec) {
			rec = freshRecord();
			this.byId.set(id, rec);
		}
		if (fold) materialize(rec);
		return rec;
	}

	/**
	 * Bring a document's ink into the session, once.
	 *
	 * Resolves true when the visible strokes changed, so a caller can repaint
	 * only when there is something new to show.
	 */
	async ensureLoaded(id: string): Promise<boolean> {
		return this.loadRecord(id);
	}

	private async loadRecord(id: string, recoverUnadopted?: () => void): Promise<boolean> {
		const rec = this.record(id);
		// A damaged first read is locked against writes, but a later open may
		// retry it. Keep the lock until a sound read has actually landed.
		if (!this.host || rec.load === "loading" || (rec.load === "yes" && !rec.unreadableLocked)) return false;
		rec.load = "loading";
		let settle = (): void => {};
		rec.loadInFlight = new Promise<void>((resolve) => {
			settle = resolve;
		});
		try {
			const result = await this.host.load(id, { restore: false });
			if (!result) return false;
			// `damaged` means the bytes could not be understood and `data` is a
			// PLACEHOLDER, not the user's ink. Writing it would overwrite what
			// the file actually held, so this is the fail-closed case.
			if (result.damaged) {
				rec.unreadableLocked = true;
				this.noteOnce(
					rec,
					"noticed",
					"Handwriting: this PDF's ink file could not be read yet. New ink on it is not saved until it loads."
				);
				return false;
			}
			rec.unreadableLocked = false;
			// The parser reports a newer schema rather than making us compare
			// version numbers ourselves, and it is authoritative about it.
			if (result.futureVersion !== undefined) {
				// Locked, and still rendered. Returning here showed no ink at
				// all for a document whose sidecar came from a newer build,
				// which reads as loss; the parser has already migrated what
				// this build understands and persist() refuses for a
				// future-locked record, so the ink can be shown safely. Same
				// change as the inline surface, same reason.
				rec.futureLocked = true;
				this.noteOnce(
					rec,
					"futureNoticed",
					"Handwriting: this PDF's ink was written by a newer version of Handwriting. ink drawn on it is not saved."
				);
				// Zero strokes out of a schema we do not fully understand is
				// ambiguous - erased, or written in a form we cannot decode -
				// and adopting on the second reading would blank the document.
				// What is on screen stays. See the inline surface for the
				// longer version of this.
				if (result.data.strokes.length === 0) return false;
			}
			rec.basePage = result.data;
			// Claims made before the read landed survive it: the disk's paths
			// and the session's are one set, less the names this session
			// renamed the claim off while the file was locked.
			const off = renamedOffUnderLock.get(rec);
			renamedOffUnderLock.delete(rec);
			const disk = (result.data.pdfPaths ?? []).filter((p) => !off?.has(p));
			rec.claimedPaths = [...new Set([...disk, ...(rec.claimedPaths ?? [])])];
			// Session strokes drawn while the read was in flight come FIRST in
			// time but must not be lost to it, so the persisted set is merged
			// underneath them rather than replacing them.
			const persisted = result.data.strokes.filter((s) => typeof s.page === "number");
			materialize(rec);
			const seen = new Set(rec.strokes.map((s) => s.id));
			rec.strokes = [...persisted.filter((s) => !seen.has(s.id)), ...rec.strokes];
			rec.mutationGeneration++;
			// Ink changed while the file could not be read was never written. Save it now: the read is still in
			// flight here, so the save waits for it to settle, and it is written once, over the merged page. The
			// mark goes where persist hands the save off; under the newer lock persist returns first and it stays.
			if (unsavedWhileUnreadable.has(rec)) this.persist(id, rec);
			return persisted.length > 0;
		} finally {
			// A reload must recover before queued writes can snapshot the record,
			// including when the read throws. A valid empty page was adopted too.
			if (rec.basePage === null) recoverUnadopted?.();
			rec.load = "yes";
			rec.loadInFlight = null;
			settle();
		}
	}

	/** Add a finished stroke and persist. */
	commit(id: string, stroke: InkStroke): void {
		const rec = this.record(id);
		rec.strokes.push(stroke);
		rec.mutationGeneration++;
		this.persist(id, rec);
	}

	/**
	 * Replace this document's whole stroke set and persist.
	 *
	 * The blunt path, used by erase, lasso edits and undo. Blunt on purpose:
	 * the alternative is a diff protocol between the controller and the store,
	 * and the sidecar is rewritten whole either way.
	 */
	replaceAll(id: string, strokes: readonly InkStroke[]): void {
		const rec = this.record(id);
		rec.live = null;
		rec.strokes = [...strokes];
		rec.mutationGeneration++;
		this.persist(id, rec);
	}

	/**
	 * The parsed file a carry from this document takes its other fields from (PdfCarryBase), or null when none was
	 * read. Read only: nothing is folded, counted or written, so the record's release still finds it unchanged. A
	 * read or adoption replaces the base whole and never edits it, so the object stays as it was when asked for.
	 */
	carrySource(id: string): PageData | null {
		return this.byId.get(id)?.basePage ?? null;
	}

	/**
	 * Carry ink into this document (PdfClaims.carryInk): the placed strokes `added` go after its own, and what `from`
	 * holds beside its placed strokes goes into its base, in one step, then one save. A carry that brings anything
	 * beside the strokes, even to an empty file, is refused, writing nothing, while this record's read is out or it is
	 * locked: the read's landing replaces the base, and the strokes would be written without what was carried beside
	 * them. One that brings the strokes alone (an old file of placed strokes only, as every PDF ink file is today) is
	 * not refused: the landing merges the read's strokes under the session's (loadRecord), as for a stroke drawn
	 * meanwhile, so it carries as it did before this rule. True when carried.
	 */
	carryInto(id: string, added: readonly InkStroke[], from: PageData | null): boolean {
		const beside = from !== null && carriedBase(null, id, from, added) !== null;
		if (beside && !this.inkReady(id)) return false;
		// A record let go (or never read in) would be made fresh here: its save writes the carried strokes alone, claiming
		// nothing, over the file, and the file's own strokes are gone. Refused, writing nothing, so a later carry can still
		// make it.
		const held = this.byId.get(id);
		if (held === undefined || held.load === "no") return false;
		const rec = this.record(id);
		const base = from && beside ? carriedBase(rec.basePage, id, from, added) : null;
		if (base) rec.basePage = base;
		rec.live = null;
		rec.strokes = [...rec.strokes, ...added];
		rec.mutationGeneration++;
		this.persist(id, rec);
		return true;
	}

	/**
	 * Replace the stroke set WITHOUT writing: the live half of a gesture.
	 *
	 * The eraser, the lasso drag and insert-space each apply an op per
	 * pointer sample, and every one of those went through replaceAll - a
	 * scheduled sidecar write per sample, on top of the copies applyOp and
	 * replaceAll each make of the whole document. The screen has to keep up
	 * with the pen; the disk does not. `save` is the single write at pen-up.
	 */
	replaceAllLive(id: string, strokes: readonly InkStroke[]): void {
		const rec = this.record(id);
		rec.live = null;
		rec.strokes = [...strokes];
		rec.mutationGeneration++;
	}

	/**
	 * A restored revision replaces what a loaded record shows, so the record's
	 * next save does not write the replaced revision back over it. Writes
	 * nothing: the caller writes the restored page. True when a loaded record
	 * held this document.
	 *
	 * A page an erase holds live belongs to the replaced revision: it goes with
	 * it, as in replaceAll, or the page read would go on serving it and the next
	 * fold would put it back into the restored one at its old positions. The
	 * eraser's next sample reads the restored page and goes live on that.
	 */
	restoreRevision(id: string, page: PageData): boolean {
		const rec = this.byId.get(id);
		if (!rec) return false;
		rec.live = null;
		rec.strokes = page.strokes.slice();
		rec.mutationGeneration++;
		return true;
	}

	/** Write the current state now: the end of a live gesture. */
	save(id: string): void {
		this.persist(id, this.record(id));
	}

	/**
	 * Re-read a document's sidecar because something else wrote it.
	 *
	 * True when the visible ink actually changed, so the caller repaints only
	 * then. This is what makes ink drawn on a tablet appear on a desktop: the
	 * sidecars live in a folder the vault does not index, so nothing tells us
	 * they changed and the caller polls.
	 *
	 * Refuses while a read is in flight or the record is locked, for the same
	 * reason `persist` does: dropping the record would reset the lock, and the
	 * next stroke would write into a file we had already decided not to touch.
	 */
	async reloadExternal(id: string): Promise<boolean> {
		const rec = this.held(id);
		if (!rec || rec.load !== "yes") return false;
		if (rec.loadInFlight || rec.futureLocked) return false;
		if (rec.unreadableLocked) {
			const before = inkFingerprint(rec.strokes);
			await this.ensureLoaded(id);
			return !rec.unreadableLocked && inkFingerprint(this.strokes(id)) !== before;
		}
		const before = inkFingerprint(rec.strokes);
		// Kept, because clearing first is only safe if the re-read succeeds. A
		// sidecar being written by a sync client at this moment reads as damaged,
		// and the poll picks exactly those moments: it fires BECAUSE the file
		// just changed. Losing the session copy there empties the screen, and if
		// the file has gone rather than merely being unreadable it throws away
		// the only remaining copy of the ink.
		const kept = rec.strokes;
		const keptPage = rec.basePage;
		let restored = false;
		rec.mutationGeneration++;
		rec.load = "no";
		rec.strokes = [];
		rec.basePage = null;
		await this.loadRecord(id, () => {
			// No page was adopted. Preserve edits made while reading, with the
			// current session version winning any repeated stroke ID. Keep the
			// old page's unknown data and any locks set by the unsuccessful read.
			materialize(rec);
			const seen = new Set(rec.strokes.map((s) => s.id));
			rec.strokes = [...kept.filter((s) => !seen.has(s.id)), ...rec.strokes];
			rec.basePage = keptPage;
			rec.mutationGeneration++;
			restored = true;
		});
		if (restored) return false;
		return inkFingerprint(this.strokes(id)) !== before;
	}

	/** Forget a document's session state. The file is untouched. */
	forget(id: string): void {
		this.byId.delete(id);
	}

	/** The record's mutation generation, or null when none is held. See forgetIfUnchanged. */
	generation(id: string): number | null {
		return this.byId.get(id)?.mutationGeneration ?? null;
	}

	/**
	 * Forget a document no pane shows any more, once what it held is on disk,
	 * so the next open reads the sidecar as it is then. Kept while a read is in
	 * flight, while either lock is set (writes are refused, so the session copy
	 * is all there is), and when anything changed since `generation` was taken.
	 * True when forgotten.
	 */
	forgetIfUnchanged(id: string, generation: number): boolean {
		const rec = this.byId.get(id);
		if (!rec || rec.loadInFlight || rec.unreadableLocked || rec.futureLocked) return false;
		if (rec.mutationGeneration !== generation) return false;
		this.byId.delete(id);
		return true;
	}

	/**
	 * The held ids whose read was damaged and that hold ink drawn or a claim moved since, not written: the session copy
	 * is the only one. The live-reload poll reads these again when no pane shows them (the pane closed under the lock,
	 * or the PDF's bytes changed and its pane moved to a new ink file). Reads only.
	 */
	lockedWithUnsavedInk(): string[] {
		const out: string[] = [];
		for (const [id, rec] of this.byId) if (rec.unreadableLocked && unsavedWhileUnreadable.has(rec)) out.push(id);
		return out;
	}

	/**
	 * Ink is owed to disk at an exit: a held record changed while its file could not be read and no save of it has been
	 * handed off, under whatever lock it is now (a later read can find the file newer, or empty and newer), or a save is
	 * parked behind a read. Quit and unload ask this; the poll keeps lockedWithUnsavedInk. Reads only.
	 */
	owedAtExit(): boolean {
		for (const rec of this.byId.values()) if (unsavedWhileUnreadable.has(rec)) return true;
		return this.parkedInk();
	}

	/**
	 * Would writing `page` over this document's file lose nothing the session holds? True only under the damaged lock
	 * alone - the read landed damaged, no read is in flight, the file is not locked as newer - with nothing owed to the
	 * file (lockedWithUnsavedInk does not list it) and every stroke the record holds in `page`. A record that read
	 * soundly and then met a damaged poll keeps its strokes in memory only and is never owed, so the strokes are
	 * compared too. An empty record passes. Reads only: a live page is read where it is, not folded back.
	 *
	 * A stroke is in `page` when `page` holds one with its id and its content as the ink file stores a stroke (the
	 * serializer's own rounding: points to 0.01, pressure to 0.001). A stroke moved, resized or recoloured keeps its id
	 * and is not the stroke `page` holds; one drawn and saved this session is, though memory keeps it unrounded.
	 */
	damagedLockLosesNothing(id: string, page: { readonly strokes: readonly InkStroke[] }): boolean {
		const rec = this.byId.get(id);
		if (!rec || !rec.unreadableLocked || rec.futureLocked) return false;
		if (rec.load !== "yes" || rec.loadInFlight) return false;
		if (unsavedWhileUnreadable.has(rec)) return false;
		const blank = emptyPage(id);
		const filed = (s: InkStroke): string => serializePage({ ...blank, strokes: [s] });
		const written = new Set(page.strokes.map(filed));
		const held = rec.live ? [...rec.strokes, ...rec.live.list] : rec.strokes;
		return held.every((s) => written.has(filed(s)));
	}

	/**
	 * The instances this session holds whose id matches, with the paths each
	 * claims - including a fresh instance whose sidecar is not on disk yet, so
	 * a byte-identical copy opened beside it is not handed the same id.
	 */
	claimedInstances(match: (id: string) => boolean): { id: string; paths: string[] }[] {
		const out: { id: string; paths: string[] }[] = [];
		for (const [id, rec] of this.byId) {
			if (!match(id) || rec.claimedPaths === null) continue;
			out.push({ id, paths: [...rec.claimedPaths], ...(this.earlyBlank(id) ? { beforeList: true } : {}) });
		}
		return out;
	}

	/**
	 * Opened blank while the vault's list was pending, and still blank: nothing drawn, nothing written. Its claim names
	 * no deleted ink's new path, at an open or at the retirement (InstanceClaim.beforeList).
	 */
	private earlyBlank(id: string): boolean {
		if (!this.openedBeforeList.has(id)) return false;
		const rec = this.byId.get(id);
		if (rec && rec.basePage === null && strokeCount(rec) === 0 && !rec.unreadableLocked && !rec.futureLocked) return true;
		this.openedBeforeList.delete(id);
		return false;
	}

	/**
	 * Another record this session holds claims `path`, and is no blank opened before the list was full. The retirement
	 * reads every claim once, then awaits; a pane's first stroke on its blank inside those awaits makes that blank ink
	 * of the path's own, and the deleted ink does not move onto it, as for a blank drawn on before. A record in `except`
	 * does not count. Reads only.
	 */
	private heldByOtherInk(id: string, path: string, except?: ReadonlySet<string>): boolean {
		for (const [other, rec] of this.byId) {
			if (other !== id && except?.has(other) !== true && rec.claimedPaths?.includes(path) === true && !this.earlyBlank(other)) return true;
		}
		return false;
	}

	/**
	 * Whether `id` is a blank opened before the vault's list was full, never drawn on (earlyBlank). Reads only, but
	 * a blank drawn on since is dropped from the list, as earlyBlank does.
	 */
	isEarlyBlank(id: string): boolean {
		return this.earlyBlank(id);
	}

	/** Whether this session opened any blank before the vault's list was full (earlyBlank), drawn on since or not. */
	hasEarlyBlanks(): boolean {
		return this.openedBeforeList.size > 0;
	}

	/**
	 * Take `path` off a sound record's claims: ink paired onto a path whose pane drew on its blank before it moved
	 * (PdfClaims.moveBlankPanes). Written when a claim is left. With none left nothing is written, so no file that
	 * claims nothing is left for any copy to adopt: the caller moves the file into the trash. The claims left, or null
	 * when no sound record is held.
	 */
	dropClaim(id: string, path: string): string[] | null {
		const rec = this.byId.get(id);
		if (!rec || rec.claimedPaths === null || !this.inkReady(id)) return null;
		const left = rec.claimedPaths.filter((p) => p !== path);
		rec.claimedPaths = left;
		rec.mutationGeneration++;
		if (left.length > 0) this.persist(id, rec);
		return left;
	}

	/**
	 * Put back the claim on `path` that dropClaim took, when the move of the file into the trash that was to follow
	 * failed: the file is still live and still claims `path`. A record left claiming nothing would read as one that
	 * already left `path`, and a save from it would write a file that claims nothing. Nothing is written here: the
	 * file already claims it.
	 */
	restoreClaim(id: string, path: string): void {
		const rec = this.byId.get(id);
		if (!rec || rec.claimedPaths === null || rec.claimedPaths.includes(path)) return;
		rec.claimedPaths = [...rec.claimedPaths, path];
		rec.mutationGeneration++;
	}

	/** A deleted claim still blocks older same-byte files during the grace. */
	pendingClaims(): ReadonlyMap<string, ReadonlySet<string>> {
		return new Map([...this.pendingDeleted].map(([path, p]) => [path, p.existingPaths]));
	}

	/** Per deleted claim in its grace, the new paths tied opens hold for it (PendingPdfDeletion.held). */
	heldPaths(): ReadonlyMap<string, ReadonlySet<string>> {
		return new Map([...this.pendingDeleted].filter(([, p]) => p.held.size > 0).map(([path, p]) => [path, new Set(p.held)]));
	}

	/** Every deletion in its grace, as an open and the retirement read it to name a waiting ink's new path. */
	waitingDeletions(): ReadonlyMap<string, WaitingDeletion> {
		return new Map([...this.pendingDeleted].map(([path, p]) => [path, this.waitingOf(path, p)]));
	}

	/** Per deletion in its grace, the names it takes off ink of a family besides its path (PendingPdfDeletion.oldNames). */
	waitingOldNames(): ReadonlyMap<string, readonly { path: string; family: string }[]> {
		return new Map([...this.pendingDeleted].filter(([, p]) => p.oldNames.length > 0).map(([path, p]) => [path, p.oldNames]));
	}

	/** One deletion in its grace, as an open and the retirement read it. */
	private waitingOf(path: string, p: PendingPdfDeletion): WaitingDeletion {
		const onto = p.existingPaths.has(path);
		const leaving = new Map<string, string[]>();
		for (const l of p.leavesOff?.(path) ?? []) leaving.set(l.found, [...(leaving.get(l.found) ?? []), l.kept]);
		return {
			...(leaving.size > 0 ? { leaving } : {}),
			existing: p.existingPaths,
			held: p.held,
			paired: p.paired,
			arrived: p.arrived,
			...(onto && p.moved.size > 0 ? { cameWithInk: true as const } : {}),
			...(onto && p.moved.size === 0 && typeof p.ontoFamily === "string" ? { ontoFamily: p.ontoFamily } : {}),
			newAtDefer: p.newAtDefer,
			...(this.listPending ? { beforeList: true } : {}),
		};
	}

	/**
	 * Read the family of the file renamed onto a deleted path, in the background: an open of another path, and a
	 * claim move, then know ink of its bytes there is its. Until read, and if the read fails, that ink counts as the
	 * deleted file's at those readers, as before; the open of the path itself knows the family, and the retirement
	 * reads it again.
	 */
	private readOnto(path: string, pending: PendingPdfDeletion): void {
		const read = ++pending.ontoReads;
		pending.ontoFamily = undefined;
		if (!pending.existingPaths.has(path)) return;
		const kept = (): boolean => pending.ontoReads === read && this.pendingDeleted.get(path) === pending && pending.existingPaths.has(path);
		pending.familyForPath(path).then(
			(family) => {
				if (kept()) pending.ontoFamily = family;
			},
			() => {}
		);
	}

	/**
	 * Every PDF ink file's claims: what each file on disk claims, with what
	 * this session's record holds. The retirement counts these, and an open
	 * that pairs by name counts the same. A file whose claim cannot be read
	 * and that no record holds is left out; listed, its id goes in `unread`.
	 */
	async inkClaims(store: PdfClaimStore, unread?: Set<string>): Promise<Map<string, string[]>> {
		const listed = new Set((await store.listIds("pdf-")).filter(isPdfInkId));
		const ids = new Set(listed);
		for (const id of this.byId.keys()) if (isPdfInkId(id)) ids.add(id);
		const claims = new Map<string, string[]>();
		for (const id of ids) {
			const disk = await store.readPdfPaths(id);
			// A blank opened before the list was full claims for nothing yet: its path stays offered to the deleted inks.
			const held = this.earlyBlank(id) ? [] : (this.byId.get(id)?.claimedPaths ?? []);
			if (disk !== null || held.length) claims.set(id, [...new Set([...(disk ?? []), ...held])]);
			else if (listed.has(id)) unread?.add(id);
		}
		return claims;
	}

	/**
	 * An open paired `path` by name with these deleted claims and found it
	 * unpaired (InstanceChoice.heldFor): it opened blank, and each of them
	 * keeps counting it, so the file it tied with cannot take that ink by
	 * elimination.
	 */
	holdTiedPath(path: string, deletedPaths: readonly string[]): void {
		let changed = false;
		for (const d of deletedPaths) {
			const pending = this.pendingDeleted.get(d);
			if (!pending || pending.held.has(path)) continue;
			pending.held.add(path);
			changed = true;
		}
		if (changed) this.savePendingDeletes();
	}

	/**
	 * These deleted claims were paired over together, at an open that paired
	 * by name or at a retirement: each stays paired for as long as its
	 * deletion is pending, and across a restart with it.
	 */
	markPaired(deletedPaths: readonly string[]): void {
		let changed = false;
		for (const d of deletedPaths) {
			const pending = this.pendingDeleted.get(d);
			if (!pending || pending.paired) continue;
			pending.paired = true;
			changed = true;
		}
		if (changed) this.savePendingDeletes();
	}

	/**
	 * The vault renamed a PDF. A rename keeps a file existing: every deletion
	 * in its grace that counted it at `oldPath` counts it at `newPath` too,
	 * whatever that name is. So a file that existed at a delete never becomes
	 * a new path that deleted ink could follow, and one renamed onto the
	 * deleted path itself puts that path in its own deletion's list: the path
	 * is the other file's now, and only the grace ends that deletion. Renamed
	 * off it again, that file takes the path out of the list: the deletion is
	 * as it was before the file came, so the path created again inside the
	 * grace is the deleted file's own return. A file new since the delete is
	 * in no existing list. Its renames carry only what a deletion keeps for
	 * that path: new for a deferred deletion (newAtDefer), or held for it by
	 * a tied open (held), so the copy it tied with cannot take that ink by
	 * elimination.
	 */
	notePdfRenamed(oldPath: string, newPath: string): void {
		let changed = false;
		for (const [path, pending] of this.pendingDeleted) {
			if (pending.leftTo.has(oldPath)) pending.leftTo.add(newPath);
			// A path new for a deferred deletion stays new for it under the name a vault rename gives it.
			if (pending.newAtDefer?.delete(oldPath)) {
				pending.newAtDefer.add(newPath);
				changed = true;
			}
			// A path a tied open holds for this deletion stays held under the name a vault rename gives it.
			if (pending.held.delete(oldPath)) {
				pending.held.add(newPath);
				changed = true;
			}
			if (!pending.existingPaths.has(oldPath)) continue;
			if (!pending.existingPaths.has(newPath)) {
				pending.existingPaths.add(newPath);
				changed = true;
			}
			if (oldPath === path) {
				pending.existingPaths.delete(path);
				pending.leftTo.add(newPath);
				pending.moved.clear();
				changed = true;
			}
			// The file now on the path, or none: what is of its bytes there is read again.
			if (oldPath === path || newPath === path) this.readOnto(path, pending);
		}
		if (changed) this.savePendingDeletes();
	}

	/** The deletion of `path` while another file that existed at the delete, renamed onto it, is on it. */
	private deletionRenamedOnto(path: string): PendingPdfDeletion | undefined {
		const pending = this.pendingDeleted.get(path);
		return pending?.existingPaths.has(path) ? pending : undefined;
	}

	/**
	 * Whether `id`'s claim on `path` is the deleted file's while another file,
	 * renamed onto the path inside the grace, is on it: `id` did not arrive
	 * with that file, so its ink is not that file's to carry.
	 */
	claimTakenByRename(id: string, path: string): boolean {
		const pending = this.deletionRenamedOnto(path);
		return pending !== undefined && isDeletedClaim(this.waitingOf(path, pending), id);
	}

	/**
	 * Ink id `id` came to claim `path` after a file that existed at its
	 * delete was renamed onto it: it is that file's, not the deleted file's.
	 * An open notes its choice here at once, before its load, so a second
	 * pane opening the same file meanwhile uses the same id.
	 */
	noteArrived(path: string, id: string): void {
		const pending = this.deletionRenamedOnto(path);
		if (!pending || pending.arrived.has(id)) return;
		pending.arrived.add(id);
		this.savePendingDeletes();
	}

	/** The ink ids that came to claim `path` since a file was renamed onto it inside its deletion's grace. */
	arrivedAt(path: string): ReadonlySet<string> | undefined {
		return this.pendingDeleted.get(path)?.arrived;
	}

	/**
	 * Whether `id`'s claim on `path` is the deleted file's, kept for its
	 * retirement, as the file at `path` is renamed to `newPath`: the path was
	 * deleted, another file was renamed onto it in the grace and is the one
	 * leaving it now (or one is on it still), and `id` did not arrive with that
	 * file. Renaming that file on does not move this claim.
	 */
	claimHeldByDeletion(id: string, path: string, newPath: string): boolean {
		const pending = this.pendingDeleted.get(path);
		if (!pending || !isDeletedClaim(this.waitingOf(path, pending), id)) return false;
		return pending.existingPaths.has(path) || pending.leftTo.has(newPath);
	}

	/** The deletion waiting at `path` now, as a token only: a later delete there, or one that replaces it, is another. */
	deletionAt(path: string): object | undefined {
		return this.pendingDeleted.get(path);
	}

	/**
	 * The vault created a PDF at `path`: once the layout is ready, or before it at a path this device never saw (the
	 * vault's own load is not a create).
	 */
	notePdfCreated(path: string, at = Date.now()): void {
		this.createdAt.set(path, at);
	}

	/**
	 * The vault has removed a PDF. Keep its claim for a sync delete+create
	 * rename, then retire it if no same-family CREATE arrives in the grace.
	 * The snapshot is taken before any await, so an older template is marked
	 * as existing even while the sidecar list is being read elsewhere.
	 */
	markDeletedPath(
		path: string,
		context: PdfDeleteContext,
		/** The paths that existed at deletion, when restoring one from an earlier session. */
		existingAtDeletion?: readonly string[],
		/** Its held paths, when restoring one from an earlier session. */
		heldAtDeletion?: readonly string[],
		/** Whether it was paired, when restoring one from an earlier session. */
		pairedAtDeletion?: boolean,
		/** Its arrived ids, when restoring one from an earlier session. */
		arrivedAtDeletion?: readonly string[],
		/** The paths new for it when its retirement deferred, when restoring one from an earlier session. */
		newAtDeferAtDeletion?: readonly string[]
	): void {
		const pending = this.recordDeletion(path, context, existingAtDeletion, heldAtDeletion, pairedAtDeletion, arrivedAtDeletion, newAtDeferAtDeletion);
		this.armRetirement(path, pending, context.graceMs);
		this.savePendingDeletes();
	}

	/** markDeletedPath's entry, in place of any at `path`, not yet armed and not yet saved. */
	private recordDeletion(
		path: string,
		context: PdfDeleteContext,
		existingAtDeletion?: readonly string[],
		heldAtDeletion?: readonly string[],
		pairedAtDeletion?: boolean,
		arrivedAtDeletion?: readonly string[],
		newAtDeferAtDeletion?: readonly string[]
	): PendingPdfDeletion {
		const replaced = this.pendingDeleted.get(path);
		// A deletion that replaces a deferred one is a new delete: the file was back in the vault. What is new for it
		// is fixed at its own first defer, not taken from the one it replaces; only a restore brings a fixed set. What
		// was new for the one it replaces stays new; every other path counts as at a fresh delete (pathsAtDeletion).
		this.cancelPending(path);
		const pending: PendingPdfDeletion = {
			existingPaths: new Set(existingAtDeletion ?? this.pathsAtDeletion(path, context, replaced)),
			listPdfPaths: context.listPdfPaths,
			familyForPath: context.familyForPath,
			store: context.store,
			release: context.release,
			inkPairedOnto: context.inkPairedOnto,
			leaveTies: context.leaveTies,
			leaveMovedBack: context.leaveMovedBack,
			leavesOff: context.leavesOff,
			leaveFollowed: context.leaveFollowed,
			renamedOffStanding: context.renamedOffStanding,
			timer: 0,
			// A deletion that replaces one in its grace is the same claim: its pairing and its holds stay.
			paired: pairedAtDeletion ?? replaced?.paired ?? false,
			held: new Set(heldAtDeletion ?? replaced?.held ?? []),
			arrived: new Set(arrivedAtDeletion ?? []),
			moved: new Set(),
			ontoReads: 0,
			leftTo: new Set(),
			newAtDefer: newAtDeferAtDeletion ? new Set(newAtDeferAtDeletion) : undefined,
			retryMs: 0,
			ownStamps: new Map(),
			// Read at the delete itself, never at a restore: the moves are this session's.
			oldNames: existingAtDeletion === undefined ? (context.renamedFrom?.(path) ?? []) : [],
			keptFamilies: new Set(existingAtDeletion === undefined ? (context.keptFor?.(path) ?? []) : []),
		};
		this.pendingDeleted.set(path, pending);
		return pending;
	}

	/** Run this deletion's retirement in `ms`, in turn with every other retirement. */
	private armRetirement(path: string, pending: PendingPdfDeletion, ms: number): void {
		pending.timer = timerHost().setTimeout(() => {
			const run = this.retiring.then(() => this.retireDeletedPath(path, pending));
			this.retiring = run.catch(() => {});
			runDetached(run, `retire PDF ink claim for ${path}`);
		}, ms);
	}

	/**
	 * The PDFs that count as existing when a PDF is deleted: what the vault
	 * holds, less any file created less than PDF_CREATE_MARK_MS before the
	 * delete, which may be the new name of this very file, synced in ahead of
	 * the delete.
	 * When this deletion replaces one still in its grace (the same path came
	 * back and went again), a path new for that one stays new for this one.
	 * Once that one deferred, only its fixed set was (PdfIdentity.isNewFor):
	 * a file made after it deferred counts as at a fresh delete, existing
	 * once it is PDF_CREATE_MARK_MS old. The deleted path itself never counts, whether
	 * or not the vault still lists it when the delete is heard: only a file
	 * renamed onto it puts it in the list.
	 */
	private pathsAtDeletion(path: string, context: PdfDeleteContext, replaced: PendingPdfDeletion | undefined): string[] {
		const now = Date.now();
		for (const [p, at] of this.createdAt) if (now - at >= PDF_CREATE_MARK_MS) this.createdAt.delete(p);
		const newForReplaced = (p: string) =>
			replaced !== undefined && isNewFor({ existing: replaced.existingPaths, newAtDefer: replaced.newAtDefer }, p);
		return context
			.listPdfPaths()
			.filter((p) => p !== path && !this.createdAt.has(p) && !newForReplaced(p));
	}

	/**
	 * Unload stops the grace and retry timers but keeps the saved list: the
	 * next session restores each deletion, a deferred one's paths new at its
	 * defer too, and gives it its grace again.
	 */
	cancelPendingDeletes(): void {
		for (const pending of this.pendingDeleted.values()) timerHost().clearTimeout(pending.timer);
		this.pendingDeleted.clear();
	}

	private cancelPending(path: string): void {
		const pending = this.pendingDeleted.get(path);
		if (!pending) return;
		timerHost().clearTimeout(pending.timer);
		this.pendingDeleted.delete(path);
		this.savePendingDeletes();
	}

	private async retireDeletedPath(path: string, pending: PendingPdfDeletion): Promise<void> {
		// Records loaded here are for PDFs no pane may show. Kept, one stood in
		// for its sidecar at the next open, and ink another device added
		// meanwhile was missing. Every one is released at every exit, except a
		// record this retirement deleted along with its sidecar.
		const loaded = new Set<string>();
		try {
			await this.retireDeletedPathLoading(path, pending, loaded);
		} finally {
			for (const id of loaded) pending.release(id);
		}
	}

	private async retireDeletedPathLoading(path: string, pending: PendingPdfDeletion, loaded: Set<string>): Promise<void> {
		if (this.pendingDeleted.get(path) !== pending) return;
		const now = pending.listPdfPaths();
		// A same-path recreation is the same claim. It needs no rewrite. A file that existed at the delete and was
		// renamed onto the path is another file: the deleted claim goes on to retire.
		if (now.includes(path) && !pending.existingPaths.has(path)) { this.cancelPending(path); return; }
		// The file renamed onto the path, with no ink of its own: ink of its bytes there is its, read now. Unread, no
		// claim can be told from the deleted file's, so none is acted on.
		let ontoUnread = false;
		// With no file on the path now, there is none whose bytes to read: every claim on it is the deleted file's.
		if (pending.existingPaths.has(path) && pending.moved.size === 0 && now.includes(path)) {
			const read = ++pending.ontoReads;
			try { pending.ontoFamily = await pending.familyForPath(path); }
			catch { pending.ontoFamily = undefined; ontoUnread = true; }
			if (this.pendingDeleted.get(path) !== pending) return;
			if (pending.ontoReads !== read || !pending.existingPaths.has(path)) ontoUnread = true;
		}
		let claims: Map<string, string[]>;
		const unread = new Set<string>();
		try {
			claims = await this.inkClaims(pending.store, unread);
		} catch (e) {
			if (!(e instanceof InkFolderListingFailed)) throw e;
			// The ink folder would not list: no claim can be counted, so none is acted on. It waits, saved, and is tried
			// again as a deferred one is. What is new for it is fixed at its first wait, as at a defer: a PDF made after
			// is another file, as when the listing works and this ends at its grace.
			if (this.pendingDeleted.get(path) !== pending) return;
			pending.newAtDefer ??= new Set(pending.listPdfPaths().filter((p) => p !== path && isNewFor({ existing: pending.existingPaths }, p)));
			pending.retryMs = Math.min(pending.retryMs > 0 ? pending.retryMs * 2 : DEFERRED_RETRY_FIRST_MS, DEFERRED_RETRY_MOST_MS);
			this.armRetirement(path, pending, pending.retryMs);
			this.savePendingDeletes();
			return;
		}
		// A listed ink file whose claim was not read and that no record holds: what it claims is not known, and it may be
		// this deletion's ink. Each is given the last look's test. On a look that failed no claim is acted on, as when the
		// folder would not list: the deletion waits, saved, and is tried again. No file, or bytes that do not parse or
		// decode with loss, count for nothing, as before. The limit: one whose look keeps failing keeps every deletion
		// waiting until it works.
		for (const id of unread) {
			const look = await this.unreadClaim(pending.store, id);
			if (this.pendingDeleted.get(path) !== pending) return;
			if (look !== "failed") continue;
			pending.newAtDefer ??= new Set(pending.listPdfPaths().filter((p) => p !== path && isNewFor({ existing: pending.existingPaths }, p)));
			pending.retryMs = Math.min(pending.retryMs > 0 ? pending.retryMs * 2 : DEFERRED_RETRY_FIRST_MS, DEFERRED_RETRY_MOST_MS);
			this.armRetirement(path, pending, pending.retryMs);
			this.savePendingDeletes();
			return;
		}
		const freshPaths = now.filter((p) => isNewFor({ existing: pending.existingPaths, newAtDefer: pending.newAtDefer }, p));
		const families = new Map<string, string | null>();
		const unreadableFamilies = new Set<string>();
		const readFamily = async (next: string): Promise<void> => {
			if (families.has(next) || unreadableFamilies.has(next)) return;
			try { families.set(next, await pending.familyForPath(next)); }
			catch { unreadableFamilies.add(next); }
		};
		const claimedByOther = (id: string, next: string, except: ReadonlySet<string>) =>
			[...claims].some(([other, ps]) => other !== id && !except.has(other) && ps.includes(next));
		let deferred = false;
		// A found ink whose leave of the path is owed, its kept ink claiming the path too, is walked after every other ink:
		// its claim is not counted while the kept ink's walk pairs or moves it (PdfIdentity.isLeavingClaim), and the found
		// ink follows a kept ink that moved (followLeaves). Reached with the kept ink not moved, the found ink's claim counts
		// as it did before the leave was owed, and its walk ends as it did then. Walked in the listing order, a found ink
		// listed first moved alone, or tied the kept ink's claim, and both went to the trash.
		const atStart = this.waitingOf(path, pending);
		const leavingIds = new Set([...claims.keys()].filter((id) => isLeavingClaim(atStart, path, id, (k) => claims.get(k))));
		const walk = [...claims.keys()].filter((id) => !leavingIds.has(id)).concat([...leavingIds]);
		for (const id of walk) {
			const paths = claims.get(id)!;
			// The names this deletion takes off this ink: the path, and each name the deleted file had before a rename whose
			// claim move had not landed, when the ink is of the family that move read, unless a file of that family stands at
			// the name now: those bytes put back keep it. Another document there takes nothing from the deleted file. A file
			// there that cannot be read could be either: nothing is acted on for the ink, and the deletion waits.
			// A file of that family renamed off the name, its claim move not landed, standing now at a path other than the
			// deleted one, keeps the name too, whether it was renamed off before the delete or inside the grace: the ink is
			// that live file's, and its own move carries it (PdfDeleteContext.renamedOffStanding, asked here, not at the
			// delete). A move with no family read yet keeps nothing, and at a restore there are no old names, as before.
			const gone = new Set([path]);
			let oldUnread = false;
			for (const old of pending.oldNames) {
				if (old.family !== familyOf(id) || !paths.includes(old.path)) continue;
				if (now.includes(old.path)) {
					await readFamily(old.path);
					if (unreadableFamilies.has(old.path)) { oldUnread = true; continue; }
					if (families.get(old.path) === old.family) continue;
				}
				if (pending.renamedOffStanding?.(old.path, path).includes(old.family)) continue;
				gone.add(old.path);
			}
			if (!oldUnread && !paths.some((p) => gone.has(p))) continue;
			if (this.pendingDeleted.get(path) !== pending) return;
			// Ink of a file renamed off the path, standing elsewhere at the delete, its claim move not landed: that file's.
			if (pending.keptFamilies.has(familyOf(id))) continue;
			// The ink of the file renamed onto the path, or its blank, or ink of its bytes: not this deletion's.
			if (!isDeletedClaim(this.waitingOf(path, pending), id)) continue;
			if (ontoUnread || oldUnread) { deferred = true; continue; }
			let moved = false;
			let unknown = false;
			// Every waiting claim of this ink's family. Two or more share the same new files by content, so their
			// names pair them; an open counts the same claims and offers the same paths (PdfIdentity.waitingClaims).
			const waiting = this.waitingDeletions();
			const deleted = waitingClaims(familyOf(id), claims, waiting, leavingIds.has(id) ? id : undefined);
			// The found inks whose leave of the path is owed for this ink, each claiming the path too: they follow it.
			const followers = this.leavingWith(pending, id, path, leavingIds);
			if (pairsByName(deleted, waiting)) {
				this.markPaired(deleted.map((d) => d.deleted));
				// A path a tied open holds for a claim still counts for it, though its blank claims it.
				const offered = offeredPaths(deleted, now, claims, waiting);
				for (const q of new Set(offered.flatMap((o) => o.fresh))) await readFamily(q);
				if (this.pendingDeleted.get(path) !== pending) return;
				// A failed read cannot rule a path in or out of the pairing; keep this claim pending.
				if (offered.some((o) => o.fresh.some((q) => unreadableFamilies.has(q)))) { deferred = true; continue; }
				// Never onto a held path: the pair is dropped, and this claim pairs nothing lower.
				const next = pairWaiting(offered, (q) => families.get(q) === familyOf(id), waiting).get(waitingKey({ id, deleted: path }));
				if (next !== undefined) {
					loaded.add(id);
					await this.ensureLoaded(id);
					await this.loadFollowers(followers, loaded);
					if (this.pendingDeleted.get(path) !== pending) return;
					// Not onto a path a pane's ink came to claim during the awaits (heldByOtherInk).
					if (this.inkReady(id) && !this.heldByOtherInk(id, next)) {
						this.renameGone(id, path, gone, paths, next);
						claims.set(id, paths.filter((p) => !gone.has(p)).concat(next));
						moved = true;
						this.followLeaves(pending, id, path, next, followers, claims);
						pending.inkPairedOnto?.(next, id);
					}
				}
			} else {
				// A leave owed off this path ties this ink to another (PdfClaims.pairedInkLeaves). The copy moved back by a
				// delete here and a create at a name it had while the leave was owed: the other ink of the leave may still
				// claim that name, its claim passed over at the rename. That claim is the leave's own, not another
				// document's, so it does not keep the path from this ink. Skipped, this ink went to the trash and the other
				// was left with the leave owed for good.
				const ties = pending.leaveTies?.(id, path) ?? [];
				// The other ink of such a leave already left this path: a rename made where the leave is not held moved only
				// that ink's claim. Its one name is the copy's, though a file stood there at the delete: this ink, walked as
				// the deleted file's, follows it there, tried first, and the other ink's claim does not keep the name from it.
				// Another document there, no file, or one unread ends as at a fresh path below. The leave stays owed off this
				// path, and its run carries it to that name (PdfClaims.leaveMovedTo). Skipped, this ink went to the trash
				// with the deletion, and the leave was owed for good.
				const partner = this.partnerName(pending, id, path, gone, claims);
				const tries = partner === undefined ? freshPaths : [partner.name, ...freshPaths.filter((p) => p !== partner.name)];
				for (const next of tries) {
					const back = ties.filter((t) => t.was.includes(next));
					const tied = new Set(back.map((t) => (t.found === id ? t.kept : t.found)));
					const follows = partner !== undefined && next === partner.name ? partner : undefined;
					if (follows) for (const other of follows.others) tied.add(other);
					if (claimedByOther(id, next, tied)) continue;
					await readFamily(next);
					if (unreadableFamilies.has(next)) { unknown = true; continue; }
					if (families.get(next) !== familyOf(id)) continue;
					loaded.add(id);
					await this.ensureLoaded(id);
					await this.loadFollowers(followers, loaded);
					if (this.pendingDeleted.get(path) !== pending) return;
					if (!this.inkReady(id)) break;
					if (this.heldByOtherInk(id, next, tied)) continue;
					// On the partner's name, where no leave's `was` holds it, the claim moves as the rename's own claim move
					// made late, as the leave's run makes it (PdfClaims movedLeave): the deletion is not ended by it, goes on
					// to the inks after this one, and ends at the end of the walk. Ended here, an ink listed after this one,
					// the made PDF's, was never walked and stayed live. No leave follows it there: every other ink of the
					// leaves owed off this path already left it (partnerName), and the leave stays owed off this path for
					// its own run, as above. Moved here, the leave was saved as owed off the new name at once, before its
					// run. Where a leave's `was` holds the name, the copy moved back: the move is the copy's own, ends the
					// deletion, and the leave follows, as on any other name.
					const late = follows !== undefined && back.length === 0;
					this.renameGone(id, path, gone, paths, next, late);
					claims.set(id, paths.filter((p) => !gone.has(p)).concat(next));
					moved = true;
					if (!late) this.followLeaves(pending, id, path, next, followers, claims);
					// The leave moves with the claim, as at a rename, and its found ink is let go at the end (`loaded`), so
					// the leave runs now on the name the copy is at, not at the next launch.
					if (back.length > 0) {
						pending.leaveMovedBack?.(id, path, next);
						for (const t of back) loaded.add(t.found);
					}
					// Its found ink is let go at the end (`loaded`), so the leave's run tells the name now; before the layout,
					// at the layout.
					if (follows) for (const f of follows.found) loaded.add(f);
					pending.inkPairedOnto?.(next, id);
					break;
				}
			}
			if (moved) continue;
			// A failed read cannot rule out a rename; keep this claim pending.
			if (unknown) { deferred = true; continue; }
			loaded.add(id);
			await this.ensureLoaded(id);
			if (this.pendingDeleted.get(path) !== pending) return;
			if (!this.inkReady(id)) {
				// A newer version's file is shown and never written: leave it alone, as before.
				if (this.byId.get(id)?.futureLocked) continue;
				// No file, or bytes that do not parse or decode with loss: leave it alone, as before. A read that failed is
				// a failed look, as the last look's below: the deletion waits and is tried again, the file read in again.
				const look = await this.unreadClaim(pending.store, id);
				if (this.pendingDeleted.get(path) !== pending) return;
				if (look === "failed") deferred = true;
				continue;
			}
			// The last look at the ink file before acting on it. The record can be older than the file: another
			// device renamed the PDF and the ink file, now claiming the new name, synced in while this session
			// held the record without taking that revision in.
			const disk = await this.claimOnDisk(pending.store, id);
			if (this.pendingDeleted.get(path) !== pending) return;
			// The file is there but its claim cannot be read: leave it alone, as an unreadable record is above.
			if (disk === "unreadable") continue;
			// The look failed: what the file claims is not known. Left alone, the ink still claims only the deleted path,
			// and a deletion that ended here left it for a copy of the same bytes to open on. It waits, as after a read
			// above that failed, and an open does not take a waiting deletion's ink.
			if (disk === "failed") {
				deferred = true;
				continue;
			}
			// Let go during that read (its last pane closed), the record is gone: one made fresh here would write the file
			// with no strokes. The deletion stays waiting and is tried again, the file read in again first.
			let rec = this.inkReady(id) ? this.held(id) : undefined;
			if (rec === undefined) {
				deferred = true;
				continue;
			}
			// A file that claims no path, still the very bytes this record was read from, while the record claims the
			// deleted path: the record's own claim never reached it. It is this record's file, not another revision.
			const own =
				disk !== "none" && disk.length === 0 && (rec.claimedPaths ?? paths).some((p) => gone.has(p)) && (await this.isOwnRevision(pending, id));
			if (this.pendingDeleted.get(path) !== pending) return;
			// A file of these bytes opened during that read can claim its own name on this record, the deletion still
			// waiting, so what the record claims is read only now. Its pane can also close during the read and let the
			// record go, and the next open read it in again: the record is taken again, as after the reads above, so the
			// one held now is counted and written, never the one let go.
			rec = this.inkReady(id) ? this.held(id) : undefined;
			if (rec === undefined) {
				deferred = true;
				continue;
			}
			const held = rec.claimedPaths ?? paths;
			// A path only the file claims is still claimed.
			const left = [...new Set([...(disk === "none" ? [] : disk), ...held])].filter((p) => !gone.has(p));
			// Any other file that claims no path at all is a legacy one that any copy of these bytes can still adopt.
			const legacy = disk !== "none" && disk.length === 0 && !own;
			// Written over only when the file claims the deleted path and nothing the record does not hold.
			const writable = own || disk === "none" || (disk.some((p) => gone.has(p)) && disk.every((p) => held.includes(p)));
			if (left.length === 0 && !legacy) {
				const removed = await pending.store.remove(id); // never leave [] for legacy adoption
				// The store's own answer: the move into the trash failed (logged, not thrown), or the page is queued
				// again to be written where it lived. The file is not gone. The deletion stays waiting, and saved, so
				// no copy of these bytes adopts it, and is tried again.
				if (this.pendingDeleted.get(path) === pending && !removed) {
					deferred = true;
					continue;
				}
				// A file with the same bytes can open during that await and adopt
				// this record (claimPath, then renamePath, which cancels this
				// deletion). The record is then an open pane's; deleting it took
				// the ink off that pane's screen. The sidecar is already gone, so
				// the kept record is written back now, whole, rather than at its
				// next edit.
				if (this.pendingDeleted.get(path) !== pending) {
					const kept = this.byId.get(id);
					if (kept) this.persist(id, kept);
					return;
				}
				// Such an open can also take the record and claim its own name while the deletion goes on waiting. The
				// record is then that pane's: it keeps what it claims outside the names gone, and is written back whole,
				// as above. It is not dropped here; `loaded` lets go of it at the end unless a pane shows it.
				const kept = this.byId.get(id);
				const keptLeft = kept?.claimedPaths?.filter((p) => !gone.has(p)) ?? [];
				if (kept && keptLeft.length > 0) {
					kept.claimedPaths = keptLeft;
					kept.mutationGeneration++;
					this.persist(id, kept);
					continue;
				}
				this.byId.delete(id);
				loaded.delete(id);
			} else if (left.length > 0 && writable) {
				rec.claimedPaths = left;
				rec.mutationGeneration++;
				this.persist(id, rec);
			} else {
				// The file is a revision this record has not taken in. The record counts its claims with its own,
				// less the deleted path, and nothing is written: a save from here would set the newer file aside.
				rec.claimedPaths = left;
			}
		}
		if (this.pendingDeleted.get(path) !== pending) return;
		if (!deferred) {
			this.cancelPending(path);
			return;
		}
		// Kept pending, it is tried again without a relaunch, each wait twice the last up to a ceiling. What is new for
		// it is fixed at its first defer: a path created after is not, at a retry or at an open (PdfIdentity.isNewFor).
		pending.newAtDefer ??= new Set(
			pending.listPdfPaths().filter((p) => p !== path && isNewFor({ existing: pending.existingPaths }, p))
		);
		pending.retryMs = Math.min(pending.retryMs > 0 ? pending.retryMs * 2 : DEFERRED_RETRY_FIRST_MS, DEFERRED_RETRY_MOST_MS);
		this.armRetirement(path, pending, pending.retryMs);
		this.savePendingDeletes();
	}

	/**
	 * An ink file's claim as it is on disk now: the paths, or what `unreadClaim` makes of a file whose claim was not read.
	 */
	private async claimOnDisk(store: PdfClaimStore, id: string): Promise<string[] | "none" | "unreadable" | "failed"> {
		const paths = await store.readPdfPaths(id);
		return paths !== null ? paths : this.unreadClaim(store, id);
	}

	/**
	 * An ink file whose claim was not read: "none" when there is no file; "unreadable" when the file is there and its
	 * bytes, read in hand, do not parse or decode with loss; "failed" for any other answer, the look at it failed: the
	 * read throws, or the bytes parse whole, so the read before failed and what the file claims is not known.
	 */
	private async unreadClaim(store: PdfClaimStore, id: string): Promise<"none" | "unreadable" | "failed"> {
		// Null is no file; a look that failed is not.
		if ((await store.readPdfClaim(id)) === null) return "none";
		try {
			return parsePage(await store.readText(await store.resolvePath(id)), id).damaged ? "unreadable" : "failed";
		} catch {
			return "failed";
		}
	}

	/**
	 * Whether the ink file for `id` is still the bytes this session last read or wrote for it, or, once a remove let
	 * go of that stamp, the bytes this deletion found to be so before. False with no such bytes known, or when the
	 * file cannot be read: then it may be a revision another device synced in.
	 */
	private async isOwnRevision(pending: PendingPdfDeletion, id: string): Promise<boolean> {
		const store = pending.store;
		const known = store.knownHash.get(id) ?? pending.ownStamps.get(id);
		if (known === undefined) return false;
		let stamp: string;
		try {
			stamp = contentStamp(await store.readText(await store.resolvePath(id)));
		} catch {
			return false;
		}
		if (stamp !== known) return false;
		pending.ownStamps.set(id, stamp);
		return true;
	}

	/**
	 * Preserve both external-adoption revisions before replacing a settled PDF
	 * record. Every established-record refusal is a typed hold; initial loading
	 * is the only unavailable state.
	 */
	async adoptExternal(
		id: string,
		stillEligible?: () => boolean
	): Promise<ExternalAdoptionResult> {
		const rec = this.held(id);
		if (!rec) return ADOPTION_UNAVAILABLE;
		const host = this.host;
		if (!host) return adoptionHeld("missing-capability");
		const prepare = host.prepareExternalAdoption?.bind(host);
		const accept = host.acceptExternalAdoption?.bind(host);
		if (!prepare || !accept || !stillEligible) return adoptionHeld("missing-capability");
		if (rec.load !== "yes" || rec.loadInFlight) return adoptionHeld("unsettled");
		if (rec.unreadableLocked || rec.futureLocked) return adoptionHeld("existing-lock");
		// A save of this document asked for and not yet written is this session's ink on its way to the file: parked
		// behind a read (known here), or queued with the host (the caller's `stillEligible` asks). Preparing now would
		// find the record holding what the file lacks and write a recovery pair for a fork that is not one, listed by
		// "fix ink de-sync" on every synced device. Held before anything is written; the save lands, and a later poll
		// compares again.
		if (this.parkedById.has(id)) return adoptionHeld("unsettled");
		try {
			if (!stillEligible()) return adoptionHeld("unsettled");
		} catch {
			return adoptionHeld("unsettled");
		}
		const outgoing = this.snapshot(id, rec);
		if (!outgoing) return adoptionHeld("no-snapshot");
		// Capture both content and the monotonic generation before the first await.
		// Content proves exact present state; generation catches A -> B -> A.
		const frozen = freezePage(outgoing);
		if (!frozen) return adoptionHeld("missing-capability");
		const capturedJson = JSON.stringify(frozen);
		const generation = rec.mutationGeneration;
		const before = JSON.stringify(rec.strokes);

		let prep: ExternalAdoptionPrep;
		try {
			prep = await prepare(id, frozen);
		} catch (err) {
			console.error("[handwriting] pdf external adoption could not be prepared", id, err);
			this.noteAdoptionFailure(rec);
			return adoptionHeld("io-failure");
		}
		if (prep.kind === "unavailable") {
			// A missing live file can be sync mid-replace; a note speaks on it
			// once it persists, and so does a PDF.
			if (prep.reason === "no-live-sidecar") this.noteAdoptionFailure(rec, MISSING_INK_FILE);
			return adoptionHeld("preservation-unavailable");
		}
		// Every return below follows a round whose disk read succeeded, so a
		// quiet period armed by an earlier failure does not survive it.
		rec.adoptionFailingSince = null;
		if (prep.kind === "stale") return adoptionHeld("stale");
		if (prep.prepared.pageId !== id) return adoptionHeld("stale");

		// No await follows these checks. The baseline acknowledgement and record
		// replacement are one synchronous commit after both store and host state
		// have been requalified.
		if (this.byId.get(id) !== rec) return adoptionHeld("unsettled");
		if (rec.load !== "yes" || rec.loadInFlight) return adoptionHeld("unsettled");
		if (rec.unreadableLocked || rec.futureLocked) return adoptionHeld("existing-lock");
		if (rec.mutationGeneration !== generation) return adoptionHeld("unsettled");
		const current = this.snapshot(id, rec);
		if (!current || JSON.stringify(current) !== capturedJson) return adoptionHeld("unsettled");
		try {
			if (!stillEligible()) return adoptionHeld("unsettled");
		} catch {
			return adoptionHeld("unsettled");
		}

		accept(prep.prepared);
		rec.adoptionNoticed = false;
		rec.basePage = prep.prepared.data;
		rec.live = null;
		rec.strokes = prep.prepared.data.strokes.filter((s) => typeof s.page === "number");
		const incomingPaths = prep.prepared.data.pdfPaths ?? [];
		rec.claimedPaths = [...new Set([...incomingPaths, ...(rec.claimedPaths ?? [])])];
		rec.mutationGeneration++;
		return {
			outcome: "adopted",
			changed: JSON.stringify(rec.strokes) !== before,
			outgoingPath: prep.prepared.outgoingPath,
			incomingPath: prep.prepared.incomingPath,
		};
	}

	private persist(id: string, rec: PdfRecord): void {
		if (!this.host) return; // session-memory mode
		if (rec.unreadableLocked) {
			// Already noticed. Saved at the next sound read.
			unsavedWhileUnreadable.add(rec);
			return;
		}
		if (rec.futureLocked) return; // already noticed
		if (rec.loadInFlight) {
			// The sidecar is still being read. A snapshot now would hold only
			// this session's strokes and, written, replace the persisted ones.
			// Persist again once the merge has happened; every mutation path
			// arrives here, so nothing is dropped by waiting. Owed ink is handed off here: parkedInk counts it until
			// the parked save has scheduled the page.
			unsavedWhileUnreadable.delete(rec);
			const parked: Promise<void> = rec.loadInFlight
				.then(() => this.persist(id, rec))
				.finally(() => {
					this.parkedPersists.delete(parked);
					const left = (this.parkedById.get(id) ?? 1) - 1;
					if (left > 0) this.parkedById.set(id, left);
					else this.parkedById.delete(id);
				});
			this.parkedPersists.add(parked);
			this.parkedById.set(id, (this.parkedById.get(id) ?? 0) + 1);
			runDetached(parked, `persist pdf ink after loading ${id}`);
			return;
		}
		const page = this.snapshot(id, rec);
		if (!page) return;
		// Handed to the page store, which carries it until it lands, a failed write included.
		unsavedWhileUnreadable.delete(rec);
		this.host.schedule(id, page);
	}

	/** One composition function for writes and exact adoption qualification. */
	private snapshot(id: string, rec: PdfRecord): PageData | null {
		if (rec.unreadableLocked || rec.futureLocked) return null;
		materialize(rec);
		const base = rec.basePage ?? emptyPage(id);
		// Strokes the read could not place are carried through untouched. They
		// are filtered out of the session because a stroke with no page cannot be
		// drawn on one - but filtering is not deleting, and this record already
		// keeps unknown KEYS for exactly this reason. A stroke we cannot explain
		// is the last thing to throw away.
		const unplaceable = base.strokes.filter((s) => typeof s.page !== "number");
		return {
			...base,
			pageId: id,
			surface: "pdf",
			coordSpace: PDF_COORD_SPACE,
			...(rec.claimedPaths !== null ? { pdfPaths: rec.claimedPaths } : {}),
			strokes: [...unplaceable, ...rec.strokes],
		};
	}

	/**
	 * Record that the file at `path` belongs to this sidecar. Persisted at
	 * once when the sidecar already exists on disk (an adoption must be
	 * durable before the next device resolves), but only REMEMBERED for a
	 * fresh instance - its sidecar is born with the first stroke, exactly
	 * as before, so merely opening a PDF still writes nothing. `freed`: names
	 * at which the open read another document (PdfClaims), no file of this ink.
	 */
	claimPath(id: string, path: string, freed?: ReadonlySet<string>): void {
		const rec = this.record(id);
		if (rec.claimedPaths?.includes(path)) {
			// A path a file was renamed onto in its deletion's grace stays that deletion's until the grace ends.
			if (!this.deletionRenamedOnto(path)) this.cancelPending(path);
			return;
		}
		this.noteArrived(path, id);
		// A blank's first claim while the vault's list is pending (earlyBlank).
		if (this.listPending && rec.claimedPaths === null && rec.basePage === null && strokeCount(rec) === 0) {
			this.openedBeforeList.add(id);
		}
		const moved = rec.claimedPaths?.find((old) => {
			const pending = this.pendingDeleted.get(old);
			return pending && !pending.existingPaths.has(path);
		});
		if (moved) {
			// The file taking the ink is the deleted file's next name, and this ends that deletion. The names the deletion
			// takes off this ink besides its path (oldNames: of the family that move read, claimed, with no file there now)
			// go with it, as the retirement's pairing moves them (renameGone). Left, the ink kept such a name with no
			// deletion to take it, and another document saved there later took the ink as an older version's. With a file
			// there, the name goes too only when the open read another document there (`freed`): a file the open did not
			// read is kept, as it may be the same bytes put back.
			const deleted = this.pendingDeleted.get(moved);
			const listed = deleted && deleted.oldNames.length > 0 ? deleted.listPdfPaths() : [];
			const olds = (deleted?.oldNames ?? []).filter((o) => o.family === familyOf(id) && rec.claimedPaths?.includes(o.path) === true && (!listed.includes(o.path) || freed?.has(o.path) === true));
			// A leave owed off the deleted path for this ink: its found ink follows, as at the retirement (followLeaves).
			const found = [...new Set((deleted?.leavesOff?.(moved) ?? []).filter((l) => l.kept === id && l.found !== id).map((l) => l.found))];
			this.renamePath(id, moved, path);
			for (const o of olds) this.renamePath(id, o.path, path, true);
			if (deleted) this.followLeaves(deleted, id, moved, path, found);
			return;
		}
		rec.claimedPaths = [...(rec.claimedPaths ?? []), path];
		rec.mutationGeneration++;
		if (rec.basePage !== null || strokeCount(rec) > 0) this.persist(id, rec);
	}

	/**
	 * A retirement of `path` paired ink `id` onto `next`: each name in `gone` the ink claims moves there. The deleted path
	 * first, which ends this deletion as before, unless `missed`: then it moves as a claim a rename passed over, and the
	 * deletion goes on; then each old name of the deleted file, as a claim its rename passed over (`missed`), which
	 * leaves a deletion waiting at that name alone.
	 */
	private renameGone(id: string, path: string, gone: ReadonlySet<string>, paths: readonly string[], next: string, missed = false): void {
		if (paths.includes(path)) this.renamePath(id, path, next, missed);
		for (const old of gone) if (old !== path && paths.includes(old)) this.renamePath(id, old, next, true);
	}

	/** The found inks of the leaves owed off the deleted `path` for `kept`, each among `leaving` (PdfIdentity.isLeavingClaim). */
	private leavingWith(pending: PendingPdfDeletion, kept: string, path: string, leaving: ReadonlySet<string>): string[] {
		return [...new Set((pending.leavesOff?.(path) ?? []).filter((l) => l.kept === kept && l.found !== kept && leaving.has(l.found)).map((l) => l.found))];
	}

	/**
	 * The one name the other ink of each leave owed off the deleted `path` that `id` is a side of claims, once that ink left
	 * the path, with those other inks and the leaves' found inks. Undefined when no leave is owed off the path for `id`,
	 * when an other ink's claims were not counted, when one still claims the path or claims nothing outside `gone` (the
	 * names this deletion takes), or when they claim more than one name. `claims`: the counts of the retirement.
	 */
	private partnerName(
		pending: { leavesOff?: (path: string) => { found: string; kept: string }[] },
		id: string,
		path: string,
		gone: ReadonlySet<string>,
		claims: ReadonlyMap<string, readonly string[]>
	): { name: string; others: string[]; found: string[] } | undefined {
		const others = new Set<string>();
		const found = new Set<string>();
		const names = new Set<string>();
		for (const l of pending.leavesOff?.(path) ?? []) {
			if (l.found === l.kept || (l.found !== id && l.kept !== id)) continue;
			const other = l.found === id ? l.kept : l.found;
			const counted = claims.get(other);
			if (counted === undefined || counted.includes(path)) return undefined;
			const left = counted.filter((p) => !gone.has(p));
			if (left.length === 0) return undefined;
			for (const p of left) names.add(p);
			others.add(other);
			found.add(l.found);
		}
		const [name] = names;
		return names.size === 1 && name !== undefined ? { name, others: [...others], found: [...found] } : undefined;
	}

	/** Each found ink read in before its kept ink moves, so its claim moves with it (followLeaves); let go at the end. */
	private async loadFollowers(found: readonly string[], loaded: Set<string>): Promise<void> {
		for (const f of found) {
			loaded.add(f);
			await this.ensureLoaded(f);
		}
	}

	/**
	 * The ink `kept` moved off the deleted `path` onto `next`, and the leave of each of `found` off `path` for it was owed: the
	 * found ink's claim on `path` moves to `next` too, as a claim the move passed over, and the leave is owed off `next` (the
	 * host's leaveFollowed). Left on `path`, the found ink claimed a name no file has and no deletion waits at, and a copy
	 * of these bytes made anywhere took it as moved there; moved alone, it took the kept ink's place. A found ink not read
	 * keeps its claim, and the leave's run moves it from the names the copy had (PdfClaims wasName). `claims`: the counts
	 * of the retirement, moved with the record.
	 */
	private followLeaves(
		pending: { leaveFollowed?: (found: string, kept: string, path: string, next: string) => void },
		kept: string,
		path: string,
		next: string,
		found: readonly string[],
		claims?: Map<string, string[]>
	): void {
		for (const f of found) {
			if (this.inkReady(f) && this.byId.get(f)?.claimedPaths?.includes(path) === true) {
				this.renamePath(f, path, next, true);
				const counted = claims?.get(f);
				if (counted !== undefined) claims!.set(f, counted.filter((p) => p !== path).concat(next));
			}
			pending.leaveFollowed?.(f, kept, path, next);
		}
	}

	/**
	 * The file moved: its old claim is a lie now, the new one replaces it. `missed`: a claim the rename passed over (the
	 * record's claims could not be read then), moved later. The old name's deletion bookkeeping is the rename's, made when
	 * the file left it; a deletion waiting there now is a later file's, one that came to the name since and went, and goes
	 * on to its grace.
	 */
	renamePath(id: string, oldPath: string, newPath: string, missed = false): void {
		// An id that arrived at a path a file was renamed onto leaves with that file: the deletion there is the
		// deleted file's, and goes on to its grace.
		const left = missed ? undefined : this.pendingDeleted.get(oldPath);
		if (left?.arrived.delete(id)) {
			left.moved.delete(id);
			this.savePendingDeletes();
		} else if (!missed) this.cancelPending(oldPath);
		this.noteArrived(newPath, id);
		// The ink the file renamed onto a deleted path came with, from its old name.
		const onto = this.deletionRenamedOnto(newPath);
		if (onto && !onto.moved.has(id)) {
			onto.moved.add(id);
			this.savePendingDeletes();
		}
		const rec = this.record(id);
		const kept = (rec.claimedPaths ?? []).filter((p) => p !== oldPath && p !== newPath);
		rec.claimedPaths = [...kept, newPath];
		rec.mutationGeneration++;
		// Under the lock the file still names the old path. It is taken off at the sound read that lifts the lock, and
		// the move is unsaved as ink drawn there is, so that read is made and its save writes the move, pane or no
		// pane, with nothing drawn.
		if (rec.unreadableLocked) {
			renamedOffUnderLock.set(rec, (renamedOffUnderLock.get(rec) ?? new Set<string>()).add(oldPath));
		}
		if (rec.basePage !== null || strokeCount(rec) > 0 || rec.unreadableLocked) this.persist(id, rec);
	}

	/**
	 * A missing ink file or failed read, said once per run, after the same
	 * quiet period a note waits (InlineInkStore.noteAdoptionFailure): one
	 * failure is usually sync mid-transfer and gone a second later; one that
	 * persists means this PDF has stopped receiving that device's ink.
	 */
	private noteAdoptionFailure(rec: PdfRecord, message = ADOPTION_STILL_FAILING): void {
		if (rec.adoptionNoticed) return;
		const now = Date.now();
		if (
			rec.adoptionFailingSince !== null &&
			rec.adoptionLastFailureAt !== null &&
			now - rec.adoptionLastFailureAt > ADOPTION_RUN_GAP_MS
		) {
			rec.adoptionFailingSince = null;
		}
		rec.adoptionLastFailureAt = now;
		if (rec.adoptionFailingSince === null) {
			rec.adoptionFailingSince = now;
			return;
		}
		if (now - rec.adoptionFailingSince < ADOPTION_QUIET_MS) return;
		rec.adoptionNoticed = true;
		this.host?.notice(message);
	}

	/** One notice per lock kind per record: `flag` names the kind's own latch. */
	private noteOnce(rec: PdfRecord, flag: "noticed" | "futureNoticed", message: string): void {
		if (rec[flag] || !this.host) return;
		rec[flag] = true;
		this.host.notice(message);
	}
}
