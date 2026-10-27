import {
	PageData,
	ParseResult,
	SAVE_SLICE_MS,
	parsePage,
	serializePage,
} from "../model/PageData";
import { installPageStoreLoad } from "./PageStoreLoad";
import { installPageStorePaths } from "./PageStorePaths";
import { installPageStoreAdopt } from "./PageStoreAdopt";
import { installPageStoreWrite } from "./PageStoreWrite";
import { installPageStoreSchedule } from "./PageStoreSchedule";
import { installPageStoreRemove } from "./PageStoreRemove";

/**
 * The slice of the vault adapter the store uses. Structural, so tests can
 * inject a fake filesystem and fail every call deliberately. Obsidian's App
 * satisfies it as-is.
 */
export interface PageAdapterLike {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	stat(path: string): Promise<{ mtime: number } | null>;
	/** Obsidian provides this; the test doubles do not all need to. */
	list?(path: string): Promise<{ files: string[]; folders: string[] }>;
}

export interface PageStoreHost {
	vault: { adapter: PageAdapterLike };
}

/**
 * Opaque identity for ONE in-process writer of a page.
 *
 * The store is shared and the model is not: `main.ts` builds a single
 * `PageStore` and hands it to every view, but each `HandwritingPageView` holds
 * its own `PageDocument`. Two panes on one canvas page therefore reach
 * `schedule(pageId, ownPage)` with two different, independently composed
 * pages, and the second one's page never saw the first one's strokes.
 *
 * NOTHING ELSE IN THE STORE CAN TELL THEM APART. `knownMtime` and `knownHash`
 * are one pair per pageId for the whole process, and `load` stamps them too, so
 * a second pane's OPEN re-stamps them exactly as a write does. The external
 * guard asks "is the file on disk the one this session last read or wrote", and
 * a second in-process writer IS the same session. Writer identity is the only
 * thing that separates them, and it has to come from the caller.
 *
 * Callers that genuinely share their model - `InlineInkStore` (notes) and
 * `PdfInkStore` - pass nothing. Undefined means "unidentified", and an
 * unidentified writer never triggers any of this, so their behaviour and the
 * single-document behaviour are untouched.
 */
export type PageWriter = string;

let writerSeq = 0;

/** A fresh writer identity. One per view, for the life of the view. */
export function newPageWriter(label = "writer"): PageWriter {
	return `${label}#${++writerSeq}`;
}

/** Bounded, event-driven retry of a failed write. Not polling. */
export const WRITE_RETRY_MS = 1500;
export const WRITE_MAX_RETRIES = 3;
/** Attempts before the write error is raised: the first write and every retry. */
export const WRITE_ATTEMPTS = 1 + WRITE_MAX_RETRIES;

/**
 * Cheap content identity for the external-change guard. Mtime alone has a
 * hole: filesystem stamps are coarse (FAT is 2s; everything rounds to ms
 * here), and sync tools routinely PRESERVE the source file's mtime, so an
 * external replacement can carry exactly the mtime we recorded. Two FNV-1a
 * passes with independent seeds plus the length make an accidental collision
 * (~2⁻⁶⁴) not worth reasoning about; this is corruption/creation detection,
 * not cryptography.
 */
export function contentStamp(s: string): string {
	let a = 0x811c9dc5;
	let b = 0x811c9dc5 ^ 0xdeadbeef;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193);
		b = Math.imul(b ^ c, 0x01000197);
	}
	return `${s.length}:${a >>> 0}:${b >>> 0}`;
}

/**
 * contentStamp taken in parts: begin, push each part in order, end. The same arithmetic in the same order, so `end`
 * equals contentStamp of the parts joined, however the text is split. The save stamps its new text as the sliced
 * serializer builds it and the file it replaces in slices (contentStampSliced): on a 25 MB page each whole-text stamp
 * held the main thread 24 to 46 ms.
 */
export interface ContentStampStream {
	/** Feeds `s` from `from` up to `to`, the whole of it by default. */
	push(s: string, from?: number, to?: number): void;
	end(): string;
}

export function beginContentStamp(): ContentStampStream {
	let a = 0x811c9dc5;
	let b = 0x811c9dc5 ^ 0xdeadbeef;
	let length = 0;
	return {
		push(s: string, from = 0, to = s.length): void {
			let x = a;
			let y = b;
			for (let i = from; i < to; i++) {
				const c = s.charCodeAt(i);
				x = Math.imul(x ^ c, 0x01000193);
				y = Math.imul(y ^ c, 0x01000197);
			}
			a = x;
			b = y;
			length += to - from;
		},
		end: () => `${length}:${a >>> 0}:${b >>> 0}`,
	};
}

/** Code units contentStampSliced stamps between two looks at the clock: about 0.1 ms on a desktop CPU. */
const STAMP_CHUNK = 1 << 16;

/**
 * contentStamp(s), `sliceMs` at a time, awaiting `pause` between slices as the sliced serializer does. The same value
 * as contentStamp(s).
 */
export async function contentStampSliced(
	s: string,
	pause: () => Promise<void>,
	sliceMs: number = SAVE_SLICE_MS
): Promise<string> {
	const stamp = beginContentStamp();
	let since = performance.now();
	for (let at = 0; at < s.length; at += STAMP_CHUNK) {
		if (at > 0 && performance.now() - since >= sliceMs) {
			await pause();
			since = performance.now();
		}
		stamp.push(s, at, Math.min(s.length, at + STAMP_CHUNK));
	}
	return stamp.end();
}

/**
 * Sidecar storage (handoff §19, §21, §64).
 *
 * One JSON file per page under `.handwriting/<page-id>.json`, keyed by the page's
 * stable UUID rather than its filename, so renaming or moving the note in
 * Obsidian, or outside it, never orphans the ink.
 *
 * Writes are debounced (§64) and never happen on the pen path (§65). A write
 * goes to a `.tmp` sibling first and is renamed into place, so an interrupted
 * write cannot leave a half-written page: if the rename never happened, `load`
 * finds the `.tmp` and recovers from it. When the main file is corrupt and
 * its own `.tmp` is a complete page for the same id, the `.tmp` is promoted
 * and the corrupt bytes are kept beside it (persistence gate, 2026-08-22).
 *
 * Saves wait for a 700 ms quiet period, but a batch of changes is written at
 * the latest MAX_DIRTY_MS after its first change, so continuous writing is
 * never more than a few seconds from disk. Neither timer writes while a pen is
 * down (see pensDown): a batch past MAX_DIRTY_MS is written at the first pen
 * lift, and MAX_DIRTY_MS after that at the latest, pen or no pen, so the worst
 * case from the first change to the write is 2 x MAX_DIRTY_MS.
 */

/**
 * Sort key for one trash generation, from `<pageId>-<stamp>[-<n>].json`.
 *
 * The stamp is a wall clock in ms and the counter disambiguates two
 * destructions inside the same millisecond, so newest is the largest pair.
 * Lexical order would be wrong the moment the counter reached two digits.
 * A name that does not fit the shape sorts oldest rather than throwing:
 * something else put it there, and it is not ours to rank.
 */
/**
 * A sidecar path with its `.json` taken off, so the recovery copies can be
 * named as SIBLINGS OF THE FILE rather than of the configured folder. A page
 * being served from the other well-known folder used to have its conflict and
 * damaged copies written into the configured one, which scattered one page's
 * history across two directories.
 */
export function stripJson(path: string): string {
	return path.endsWith(".json") ? path.slice(0, -".json".length) : path;
}

/** The folder a sidecar path sits in; "" when it names no folder at all. */
export function folderOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i <= 0 ? "" : path.slice(0, i);
}
/**
 * Maximum dirty interval, anchored to the FIRST unsaved change of a batch and
 * never re-armed by later ones. The quiet-period debounce alone restarted on
 * every stroke, so a stroke every few hundred ms deferred the write
 * indefinitely (persistence gate, 2026-08-22). When it fires with a pen down
 * the batch is written at the first pen lift instead, and a second
 * MAX_DIRTY_MS caps that wait: 10 s from the first change at the worst.
 */
export const MAX_DIRTY_MS = 5000;

/**
 * ONE PREPARED EXTERNAL ADOPTION: the incoming revision, parsed and ready to
 * become the visible page, plus the two recovery artifacts that make the swap
 * non-destructive.
 *
 * `mtime` and `stamp` identify the EXACT incoming generation this preparation
 * captured. Nothing about it is acknowledged until this object is handed back
 * to `acceptExternalAdoption`, so a preparation that is never accepted leaves
 * the store exactly as it found it and the next poll sees the change again.
 */
export interface PreparedExternalAdoption {
	readonly pageId: string;
	/** The parsed incoming revision. Clean, inline, this build's schema. */
	readonly data: PageData;
	/**
	 * The recovery pair, or absent when the outgoing revision held nothing the
	 * incoming one lacks: no pair is written for an ordinary sync that only
	 * added to the page (see `outgoingDiverges`).
	 */
	readonly outgoingPath?: string;
	readonly incomingPath?: string;
	/** The pair was already on disk and verified; no new artifact was made. */
	readonly reused: boolean;
	readonly mtime: number;
	readonly stamp: string;
}

/**
 * What preparing an external adoption produced. Three cases, deliberately
 * distinct, because a caller must treat them differently:
 *
 *  - `prepared`    both revisions are on disk and independently recoverable.
 *  - `stale`       nothing is wrong, but the world moved while the I/O ran: a
 *                  newer external generation arrived. Every artifact already
 *                  written is KEPT, nothing is acknowledged, and the newer
 *                  revision is still detectable by the next poll. Say nothing.
 *  - `unavailable` no live sidecar is currently readable, or the incoming
 *                  revision is damaged, legacy or from a newer build. For an
 *                  established record this is a hold, never reload authority.
 *
 * A genuine FAILURE is deliberately not in this union: it throws. Preservation
 * that could not be completed must never arrive as a state a caller can
 * proceed from - that is the shape the loss this exists to prevent had.
 */
export type ExternalAdoptionPrep =
	| { readonly kind: "prepared"; readonly prepared: PreparedExternalAdoption }
	| { readonly kind: "stale"; readonly why: string }
	| {
			readonly kind: "unavailable";
			readonly why: string;
			/**
			 * A typed diagnostic for the hold path. It is not replacement
			 * authority: both values leave an established record untouched.
			 * The missing-live case alone starts the existing quiet notice.
			 */
			readonly reason: "no-live-sidecar" | "incoming-unusable";
	  };

/** A typed live-reload observation; only a proven missing path may say missing. */
export type ExternalChangeObservation = "changed" | "unchanged" | "missing-live-sidecar";

/**
 * What `load` returns. `transient` is set only with `damaged`, when the read
 * threw rather than returning bytes that did not parse.
 */
export type LoadResult = ParseResult & { transient?: true };

/**
 * Where the outgoing recovery artifact carries its EXACT capture.
 *
 * The persisted codec is lossy on purpose: `packPointsV2` quantizes x/y to 1e-2
 * and pressure to 1e-3 and rounds `t` to whole ms, and `serializePage` rounds
 * widths and geometry. That is right for a live sidecar - it is the storage
 * format, and every save has always written it.
 *
 * It is wrong for THIS artifact. A recovery copy exists to give back the
 * revision that was captured, and a copy that gives back a rounded one is
 * answering a different question. So the artifact is written as an ordinary,
 * fully valid sidecar - it parses, and a user can rename it into place - with
 * the unrounded capture carried verbatim in an unknown top-level field, which
 * `serializePage`/`parsePage` preserve by construction for exactly this reason.
 *
 * The key is part of the on-disk format that a recovery tool reads, so it is
 * pinned by the acceptance suite as a literal rather than imported from here.
 */
export const EXACT_OUTGOING_KEY = "handwriting:exactOutgoing";

/**
 * The device that wrote a pair, on its outgoing leg. The pair sits beside the
 * live file and syncs with it, and its legs are named for the ADOPTING device:
 * "outgoing" is that device's revision. Another device reading the pair needs
 * to know it did not write it, or it offers the adopter's ink as its own. A
 * per-install id, kept in the device's own local storage, never synced.
 */
export const ADOPTED_BY_KEY = "handwriting:adoptedBy";

/**
 * Reopen a recovery artifact the way a recovery tool should: the exact capture
 * when the artifact carries one, and the ordinary parsed page otherwise (an
 * artifact written before this existed, or the incoming leg, which is the other
 * device's bytes verbatim and has no capture of ours to carry).
 */
export function recoverExactPage(parsed: PageData): PageData {
	const exact = parsed.unknownTop?.[EXACT_OUTGOING_KEY];
	return exact !== undefined && exact !== null ? (exact as PageData) : parsed;
}

/**
 * Would adopting `incoming` lose anything `outgoing` holds? True when the
 * outgoing revision has a stroke, text box or image whose id the incoming one
 * lacks, or has under the same id in a different persisted form.
 *
 * Compared as the persisted codec writes them, both sides parsed the same
 * way: the live file never held more precision than that, so a difference
 * below it is not ink anyone had. False is the ordinary sync - the other
 * device only added - and there is then nothing to recover and no pair to
 * write. Every revision used to write a full pair of files, forever.
 */
export function outgoingDiverges(outgoing: PageData, incoming: PageData): boolean {
	const mine = parsePage(serializePage(outgoing), outgoing.pageId).data;
	return (
		lostFrom(mine.strokes, incoming.strokes) ||
		lostFrom(mine.textBoxes, incoming.textBoxes) ||
		lostFrom(mine.images, incoming.images)
	);
}

function lostFrom(mine: readonly { id: string }[], theirs: readonly { id: string }[]): boolean {
	const byId = new Map(theirs.map((t) => [t.id, JSON.stringify(t)]));
	return mine.some((m) => byId.get(m.id) !== JSON.stringify(m));
}

export class PageStore {
	pending = new Map<string, PageData>();
	/**
	 * Who composed the payload sitting in `pending`. See PageWriter: this is
	 * the only thing that distinguishes two panes on one canvas page, because
	 * every other identity the store keeps is per-pageId.
	 */
	pendingWriter = new Map<string, PageWriter | undefined>();
	/**
	 * The newest flush-carrier generation the payload sitting in `pending`
	 * holds, recorded when that payload entered `pending` and carried with it
	 * through every requeue. Never re-read from `carriersWritten` when the
	 * payload is consumed: a failed older save put back into `pending` would
	 * then claim a carrier written from a newer snapshot. See carriersWritten.
	 */
	pendingCovers = new Map<string, number | undefined>();
	/** Who composed the bytes currently in the live sidecar. */
	lastWriter = new Map<string, PageWriter | undefined>();
	/** Writers that have gone for good; see `retireWriter`. */
	retiredWriters = new Set<PageWriter>();
	timers = new Map<string, number>();
	/** One-shot maximum-dirty-interval timer per page; see MAX_DIRTY_MS. */
	maxTimers = new Map<string, number>();
	/**
	 * PENS DOWN RIGHT NOW, by pointer id. A save serializes the whole page on the main thread in one task (20 to 40 ms
	 * at 3000 strokes), and the bounded-dirty timer fires 5 s into continuous writing, so on a big note it landed
	 * inside a stroke: a hitch every 5 s. Neither save timer writes while a pen is down. A page the quiet timer found
	 * with a pen down takes a fresh quiet period when the last pen lifts; a page past its MAX_DIRTY_MS bound is
	 * written at that first lift, and MAX_DIRTY_MS after its bound at the latest, pen or no pen (a lift that never
	 * arrives). Pen pointers only. Watched on the main window from the first `schedule` until `flush` (page switch,
	 * view close, plugin unload); a pen in a popout window, mouse ink and finger ink save as before.
	 */
	pensDown = new Set<number>();
	/** Pages the quiet timer found with a pen down; they take a fresh quiet period when the last pen lifts. */
	heldForPen = new Set<string>();
	/** Pages past their MAX_DIRTY_MS bound with a pen down: written at the first lift, or by their cap timer. */
	heldPastBound = new Map<string, number>();
	/** Saves parked for a pen in the middle of their serialization (see penPause): each wakes at the last lift, its ceiling, or a flush. */
	parked = new Set<() => void>();
	/** Pages a flush, flushPage or keepAsideUnder is writing now, with a count each (null: every page, for flush); see beginFlush. */
	flushing = new Map<string | null, number>();
	penWatch: (() => void) | null = null;
	/**
	 * One tail PER PAGE, not one for the store. The tmp/rename dance must
	 * never interleave for the SAME page - that was always the invariant -
	 * but a store-wide chain also made every page wait behind every other,
	 * which is exactly what the background/freeze flush cannot afford: with
	 * one stalled write, nothing else ever reached the adapter. Different
	 * pages are different files; they owe each other no ordering.
	 */
	tails = new Map<string, Promise<void>>();

	/**
	 * How many write attempts for this page have been CLAIMED but have not yet
	 * settled. Absent means none.
	 *
	 * `pending`/`timers`/`maxTimers` describe a batch that is still WAITING.
	 * They say nothing about a batch that has left the queue and is on its way
	 * to the adapter, because `writePending` consumes all three synchronously
	 * and only then awaits the write. For that whole span the ink existed only
	 * in memory while `busy` and `hasQueuedWrite` both answered "nothing
	 * queued" - so `externallyChanged` let the live-reload poll adopt another
	 * device's copy and discard the local stroke, and the stalled write then
	 * landed carrying its pre-reload snapshot over that device's ink with no
	 * conflict copy, because the reload had refreshed the known mtime.
	 *
	 * A COUNT, deliberately, and not the `tails` map:
	 *
	 *  - Not a boolean. Two batches for one page can be outstanding at once (a
	 *    saveNow chained behind a stalled debounced write). An earlier one
	 *    settling would clear a flag the later one still needs, re-opening the
	 *    window it exists to close.
	 *  - Not `tails`. `clone` records its chained promise under the
	 *    DESTINATION id and never removes it, so a tails-based observer reports
	 *    that page queued - and the store busy - for the rest of the session,
	 *    indefinitely suppressing its live reload and global idle. That trades
	 *    one silent failure for another.
	 *
	 * Claimed synchronously in `writePending` BEFORE the batch is consumed, so
	 * it also covers an attempt waiting behind another operation in the page
	 * chain, and released in a `finally` so no outcome - success, failure or
	 * throw - can leak a permanent block. A failed write re-queues into
	 * `pending` inside `writeNow`, before its promise settles, so the two
	 * states overlap and there is no idle instant between them. The retry is a
	 * fresh `writePending` call with its own claim; nothing is double-counted.
	 */
	private outstandingWrites = new Map<string, number>();

	/**
	 * The page each write attempt that has left `pending` but not landed is
	 * carrying, by consume sequence. While a write is queued `load` answers
	 * from here (or `pending`) instead of reading disk, so a reload cannot
	 * move the baseline to another revision under ink that exists only in
	 * memory. Pushed in `writePending` right after the batch leaves `pending`,
	 * with no await between, and dropped in the same `finally` that releases
	 * the outstanding claim.
	 */
	inFlight = new Map<string, { seq: number; data: PageData }[]>();

	/**
	 * The newest batch each writer has taken off the queue, per page: a number
	 * from `consumeSeq`, stamped in `writePending` when the batch is consumed.
	 *
	 * A failed write used to be put back whenever `pending` was empty. But a
	 * batch leaves `pending` before it waits for the page's earlier write, so a
	 * newer batch B from the same writer could already be on its way while the
	 * older A failed: A went back into the queue and its retry landed over B
	 * (the live file's known mtime was B's, so the guard saw nothing), or B then
	 * failed too and was dropped because A held the slot. Either way the user's
	 * newest strokes were gone with no message.
	 *
	 * A failed or held batch is put back only when no LATER batch from the SAME
	 * writer has left the queue (`superseded`). Per writer, because two panes on
	 * one canvas page write different pages (see PageWriter): one pane's newer
	 * batch says nothing about the other's.
	 */
	consumedSeq = new Map<string, Map<PageWriter | undefined, number>>();
	consumeSeq = 0;
	/**
	 * Bumped by `remove` before it drops anything. A write reads it when it
	 * starts: one that fails after its page was removed must not go back to
	 * `pending`, because `remove` has just deleted the `consumedSeq` entry
	 * that `superseded` would read, and a retry from there writes a live
	 * sidecar for a note that no longer exists. See `recycleFailedWrite`.
	 */
	removals = new Map<string, number>();
	/**
	 * The `removals` count at which `remove` recycled a queued state. That
	 * state was scheduled after any write already running, so it is newer
	 * than that write's payload: a write that fails after such a removal is
	 * filed as a tagged generation, which a restore never opens over it.
	 */
	removedWithQueued = new Map<string, number>();

	/** A later batch from this writer has already left the queue for this page. */
	superseded(pageId: string, writer: PageWriter | undefined, seq: number | undefined): boolean {
		if (seq === undefined) return false;
		const newest = this.consumedSeq.get(pageId)?.get(writer);
		return newest !== undefined && newest > seq;
	}

	/** Claim an attempt. Synchronous, and always paired with a release. */
	beginOutstandingWrite(pageId: string): void {
		this.outstandingWrites.set(pageId, (this.outstandingWrites.get(pageId) ?? 0) + 1);
	}

	/**
	 * The newest page this store holds for `pageId` that has not landed on
	 * disk: the queued batch if there is one, else the newest consumed
	 * attempt still writing. Null when nothing is held, including a queued
	 * write whose payload is gone, which then reads disk as it always did.
	 */
	latestUnlanded(pageId: string): PageData | null {
		const queued = this.pending.get(pageId);
		if (queued) return queued;
		const attempts = this.inFlight.get(pageId);
		if (!attempts || attempts.length === 0) return null;
		let newest = attempts[0]!;
		for (const a of attempts) if (a.seq > newest.seq) newest = a;
		return newest.data;
	}

	/** Release one attempt; the key goes when the last one does, so `size` counts pages. */
	endOutstandingWrite(pageId: string): void {
		const left = (this.outstandingWrites.get(pageId) ?? 0) - 1;
		if (left > 0) this.outstandingWrites.set(pageId, left);
		else this.outstandingWrites.delete(pageId);
	}

	/**
	 * Recovery's seat in the queue is behind EVERY page's writes, not just
	 * its own - the gate tests stage exactly this: the decision must be
	 * re-proven after waiting, whatever the queue held. Everything else
	 * chains per page.
	 */
	chainBehindAll<T>(pageId: string, run: () => Promise<T>): Promise<T> {
		// The page's own tail is already among the joined ones, so seeding
		// the slot with the join loses nothing and orders run after it all.
		const all = Promise.all([...this.tails.values()]).then(() => undefined);
		this.tails.set(pageId, all);
		return this.chain(pageId, run);
	}

	/** Serialize run behind the page's own tail; the map stays bounded. */
	chain<T>(pageId: string, run: () => Promise<T>): Promise<T> {
		const tail = this.tails.get(pageId) ?? Promise.resolve();
		const chained = tail.then(run);
		const kept = chained.then(() => undefined, () => undefined).then(() => {
			if (this.tails.get(pageId) === kept) this.tails.delete(pageId);
		});
		this.tails.set(pageId, kept);
		return chained;
	}
	/**
	 * The sidecar mtime this session last saw (at load, or after its own
	 * write). If the file's mtime differs at write time, something else
	 * (sync, another device, another process) changed it since. The external
	 * revision is preserved as a conflict file instead of being overwritten.
	 */
	knownMtime = new Map<string, number>();
	/** A completed load found no sidecar; unlike an ID we have never opened. */
	observedMissing = new Set<string>();
	/** Stamp of the content this session last read or wrote (see contentStamp). */
	knownHash = new Map<string, string>();
	/** Bound same-mtime content reads to once per five seconds per polled page. */
	contentCheckedAt = new Map<string, number>();
	/**
	 * Pages whose last load could not be used: the stamp of the bytes that were
	 * read and did not parse, or null when the read itself threw. The poll
	 * watches these even though no known mtime exists for them, so a damaged or
	 * not-yet-readable page heals when its file changes instead of waiting for a
	 * reopen. Cleared by any load that is not damaged.
	 */
	unreadable = new Map<string, string | null>();
	/**
	 * WHERE EACH PAGE LIVES: the path a page's sidecar was found at, or was
	 * last written to. One page id, one live sidecar.
	 *
	 * This map is the whole fix for the two-device fork. Reads have fallen
	 * back to the other well-known folder for a while (see `findSidecar`), but
	 * writes went to `path()` - the CONFIGURED folder - so a device whose
	 * data.json names the other folder read the ink from where it is and then
	 * wrote a SECOND sidecar under the same id next door. Worse, the
	 * external-revision guard sat inside `if (exists(final))`, and `final` was
	 * the empty configured path, so the fork happened silently: nothing
	 * preserved, nothing announced. Pinning the resolved path makes that
	 * sequence impossible by construction rather than by a check.
	 *
	 * Only a path that was FOUND (or written) is pinned. A page that exists
	 * nowhere stays unpinned, so ink that arrives later by sync is adopted on
	 * the next resolve instead of being forked past.
	 */
	resolved = new Map<string, string>();
	/**
	 * PINS MADE BY A WRITE THAT FOUND NOTHING. A guess, not a fact.
	 *
	 * A page found on disk pins where it was found; a page found NOWHERE is
	 * written to the configured folder and pins itself the moment the rename
	 * lands. That second pin is not evidence about where the page lives - it is
	 * evidence about where this device wrote blind - and treating the two the
	 * same forked a fresh install on the exact ordering sync produces: the note
	 * arrives before its sidecar. Adoption ran with neither folder present and
	 * chose `.handwriting`; the user opened page X (correctly unpinned, nothing
	 * found), drew, and the write created and pinned `.handwriting/X.json`; sync
	 * then delivered `handwriting/X.json`. `resolvePath` short-circuits on a
	 * live pin, so the second copy was never looked for again - and after a
	 * restart the configured folder is searched first anyway. Two live sidecars
	 * for good, and this device's copy is the one that never syncs back.
	 *
	 * So a provisional pin is re-checked against the OTHER well-known folders on
	 * every resolve, and stays provisional until either a copy appears there
	 * (that copy is the synced one and becomes the page's home) or a LOAD reads
	 * the pinned file and finds nothing elsewhere, which confirms it. Ordinary
	 * pins never enter this set and cost exactly what they always did.
	 */
	provisional = new Set<string>();
	/**
	 * A provisional file that has just lost its page to a copy found elsewhere,
	 * waiting to be preserved beside the winner.
	 *
	 * It holds ink this device wrote, so it is never deleted; it is treated
	 * exactly as the external-revision guard treats a foreign revision - moved
	 * to a `.conflict-<mtime>.json` beside the winner and announced - which is
	 * done on the write path, where the announcement can honestly follow a
	 * completed save (see `absorbProvisional` and `pendingConflict`).
	 */
	displacedProvisional = new Map<string, string>();
	/**
	 * The `.tmp` paths this store wrote and has not yet renamed into place
	 * (R4). A `.tmp` that is NOT in here is a save that never replaced the live
	 * file - this device's earlier session killed or locked out between the two
	 * steps, or another process - and it can be the only copy of its ink. Load
	 * leaves it alone beside a readable live file (it never chooses between two
	 * valid files), so the next save used to write the same name over it and
	 * those strokes were gone with no message. A save
	 * now keeps such a file as a conflict copy before it reuses the name.
	 */
	ownTmp = new Set<string>();
	/** This install's id, written into the pairs it preserves (see ADOPTED_BY_KEY). */
	deviceId: string | null = null;

	/** Name the install that writes this store's recovery pairs. */
	useDeviceId(id: string): void {
		this.deviceId = id;
	}
	/** True between `holdWrites` and `releaseWrites`; see those. */
	migrating = false;
	failures = new Map<string, number>();
	errorNotified = new Set<string>();
	/** Pages whose change-check has already reported a read failure once. */
	private changeCheckLogged = new Set<string>();
	/** Typed result of each page's latest completed boolean change check. */
	private externalChangeObservations = new Map<string, ExternalChangeObservation>();
	/**
	 * An external revision this session moved aside but has NOT yet replaced
	 * with a successful write (RC4). The aside-rename necessarily happens
	 * before the write, so announcing it at that moment would assert a save
	 * that has not happened. The announcement waits here until the final
	 * rename lands. If the write fails for good, this entry is what tells the
	 * user where their other version went, because the live path is empty by
	 * then.
	 *
	 * A LIST per page (R8): one save can keep more than one copy - a blind local
	 * file (absorbProvisional), the revision the guard moved aside, and one that
	 * landed at the live path after that move - and a single slot let the
	 * second overwrite the first, so one kept copy was never named. Each is
	 * announced once, after the save lands. See parkConflict.
	 */
	pendingConflict = new Map<string, string[]>();

	/** Park a kept copy for the announcement that follows a landed save. */
	parkConflict(pageId: string, kept: string): void {
		const list = this.pendingConflict.get(pageId);
		if (list === undefined) this.pendingConflict.set(pageId, [kept]);
		else list.push(kept);
	}
	/**
	 * The recovery pair most recently completed for a page, with the identity
	 * of the exact revision pair it preserves. See `reuseAdoptionPair`: a
	 * preparation that is refused comes back on the next poll with both
	 * revisions unchanged, and it must reuse this rather than write a second
	 * identical copy. Verified evidence, not a cache - it is re-proved against
	 * disk before it is reused.
	 */
	preservedAdoptions = new Map<
		string,
		{ key: string; outgoingPath: string; incomingPath: string }
	>();
	/**
	 * Surface a persistent write failure to the user (set by the plugin).
	 * `preservedAs` is set when an external revision was moved aside for a
	 * write that then failed.
	 */
	onWriteError:
		| ((pageId: string, problem: string, preservedAs?: string) => void)
		| null = null;
	/**
	 * Surface a preserved external revision to the user (set by the plugin).
	 * Fires ONLY after this session's replacement has been renamed into place,
	 * so the message may state that both versions are on disk.
	 */
	onConflict: ((pageId: string, keptAs: string) => void) | null = null;
	/**
	 * Surface a recovery (set by the plugin): the main file was corrupt, its
	 * own interrupted save was complete and was promoted, and the corrupt
	 * bytes are kept at `keptAs`.
	 */
	onRecovered: ((pageId: string, keptAs: string) => void) | null = null;
	/**
	 * Surface an ink-TRASH RESTORE (set by the plugin): no live sidecar
	 * existed, a readable generation was found in the trash, and it has been
	 * renamed back into place at `restoredTo`.
	 *
	 * SEPARATE FROM `onRecovered` BECAUSE THE TWO EVENTS CANNOT SHARE A
	 * SENTENCE. `onRecovered`'s is about a file that WAS unreadable and is now
	 * quarantined under a new name; that is accurate for the corrupt-file
	 * promotion and false here. This path was raising `onRecovered` and so
	 * announced a restore as an interrupted save, and named the note's own
	 * live sidecar - after the rename, the ONLY copy of its ink - as the
	 * unreadable one.
	 *
	 * `restoredTo` IS NOT A KEPT COPY. It is where the ink now lives, which is
	 * the same value the old call passed; only the claim made about it was
	 * wrong. Alan's wording ("the file is at ...") is accurate for it as it
	 * stands, so no path is chosen or invented here.
	 */
	onInkTrashRestored: ((pageId: string, restoredTo: string) => void) | null = null;
	/**
	 * Surface a background-flush carrier that was NOT promoted (set by the
	 * plugin): it was built on other bytes and lacks a stroke the live page
	 * has, so the live page stands and the carrier's page is kept at `keptAs`.
	 * Those are this device's own newest strokes; without a word they sit in a
	 * file nobody knows to look for.
	 */
	onFlushKeptAside: ((pageId: string, keptAs: string) => void) | null = null;
	/**
	 * Surface a background-flush carrier that WAS promoted over a live page
	 * (set by the plugin): the carrier's page is now live, and the page it
	 * replaced is kept at `keptAs`. Not `onRecovered`, whose sentence calls
	 * the kept file unreadable; the replaced page here was perfectly readable.
	 */
	onFlushPromoted: ((pageId: string, keptAs: string) => void) | null = null;

	constructor(
		readonly app: PageStoreHost,
		public folder = ".handwriting",
		/** Injectable clock so trash-generation naming is testable. */
		readonly now: () => number = Date.now
	) {}

	/**
	 * A two-folder fork found by `chooseBetweenFolders`, waiting for `load` to
	 * preserve the losing copy as this device's side of a fork pair.
	 */
	twoFolderForks = new Map<string, string>();

	/**
	 * Is anything at all still waiting to be written?
	 *
	 * For callers that must know the folder is quiet before they move it, as
	 * opposed to asking about one page. A failed write re-queues, so this can
	 * still be true straight after a flush - which is the answer the caller
	 * needs, not a detail to paper over.
	 */
	get busy(): boolean {
		return (
			this.pending.size > 0 ||
			this.timers.size > 0 ||
			this.maxTimers.size > 0 ||
			// A write already on its way to the adapter is not durable either.
			this.outstandingWrites.size > 0 ||
			// An ink-folder move is running. Nothing need be queued for the
			// store to be busy: a second move settles, asks this, and must be
			// told to wait, or it lists and renames the same files again.
			this.migrating
		);
	}

	/** An ink-folder move is running (held from the hold to the release). */
	get movingFolder(): boolean {
		return this.migrating;
	}

	/** The text of a file the store wrote, for reading a copy back. */
	readText(path: string): Promise<string> {
		return this.app.vault.adapter.read(path);
	}

	/**
	 * Is a write for this page queued right now? Synchronous on purpose.
	 *
	 * `externallyChanged` asks this before it stats, so a half-landed save of
	 * our own never reads as an external edit. A caller must ask AGAIN,
	 * synchronously, immediately before it acts on that answer: the stat is
	 * awaited, and a pen can land in the gap. A stroke committed there queues
	 * a write holding a pre-reload snapshot; the reload then updates the known
	 * mtime, so the write-path conflict guard sees nothing wrong and that
	 * stale snapshot goes over the other device's ink with no conflict copy
	 * and nothing said.
	 */
	hasQueuedWrite(pageId: string): boolean {
		return (
			this.pending.has(pageId) ||
			this.timers.has(pageId) ||
			this.maxTimers.has(pageId) ||
			// AND a write that has left the queue but not landed: the ink is
			// still only in memory, so a reload here would discard it.
			(this.outstandingWrites.get(pageId) ?? 0) > 0
		);
	}

	/** Is any page's write still queued or on its way to the adapter? */
	hasAnyQueuedWrite(): boolean {
		return (
			this.pending.size > 0 ||
			this.timers.size > 0 ||
			this.maxTimers.size > 0 ||
			[...this.outstandingWrites.values()].some((n) => n > 0)
		);
	}

	/**
	 * Cheap poll primitive for live reload: has the sidecar on disk changed
	 * behind our back? Changed mtimes are checked immediately. Unchanged
	 * mtimes get a content check at most once per five seconds per polled
	 * page, because sync can replace bytes without changing mtime or size.
	 * This method never enumerates pages; callers supply eligible open IDs.
	 * Never answers while a write for this page is queued - a half-landed
	 * save of our own must not read as an external edit - and never for a
	 * page this store has not read or written. A completed missing load is a
	 * baseline too: the first JSON may arrive after the document was opened.
	 * The write-path conflict guard stays the last word either way.
	 *
	 * See hasQueuedWrite above for why a caller must re-ask synchronously.
	 */
	private async observeExternalChange(pageId: string, includeUntracked = false): Promise<ExternalChangeObservation> {
		if (this.hasQueuedWrite(pageId)) return "unchanged";
		if (this.unreadable.has(pageId)) return this.observeUnreadable(pageId);
		const known = this.knownMtime.get(pageId);
		const knownHash = this.knownHash.get(pageId);
		const folder = this.folder;
		if (known === undefined && !this.observedMissing.has(pageId) && !includeUntracked) return "unchanged";
		const adapter = this.app.vault.adapter;
		let observation: ExternalChangeObservation;
		try {
			// The file this session would READ, not the one it would write.
			// Watching only the configured folder meant a page being served
			// from the other one never appeared to change, so live reload
			// silently stopped for exactly the vaults the fallback exists for.
			const watched = await this.resolveFor(pageId);
			if (!watched.found) {
				// `resolveFor` checked every eligible path with `exists`. This is
				// positive absence, unlike a failed stat/read, and lets the inline
				// caller start its hold notice without changing the shared boolean.
				observation = known === undefined ? "unchanged" : "missing-live-sidecar";
			} else {
				const st = await adapter.stat(watched.path).catch(() => null);
				const now = performance.now();
				const checkedAt = this.contentCheckedAt.get(pageId);
				if (!st) {
					observation = "unchanged";
				} else if (st.mtime === known && checkedAt !== undefined && now - checkedAt < 5000) {
					// A skipped read is not recovery from a previously failed read.
					return "unchanged";
				} else {
					// Record the attempt before I/O, including failed reads. A
					// broken adapter or refused adoption must not cause a full
					// same-mtime read every tick. Neither baseline is accepted here.
					this.contentCheckedAt.set(pageId, now);
					const stamp = contentStamp(await adapter.read(watched.path));
					if (this.folder !== folder || this.hasQueuedWrite(pageId) || this.knownMtime.get(pageId) !== known || this.knownHash.get(pageId) !== knownHash) return "unchanged";
					if (stamp === knownHash) {
						// mtime churn without content change (a sync tool touching
						// the file): remember it so the next poll stays one stat.
						this.knownMtime.set(pageId, st.mtime);
						observation = "unchanged";
					} else {
						observation = "changed";
					}
				}
			}
		} catch (err) {
			// False means "nothing changed", which is the SAFE direction: it
			// declines to reload and so never discards local state. But this
			// runs on a one-second poll, so a page whose read keeps failing
			// would silently stop receiving another device's ink forever, and
			// say nothing. Once per page, not once per second.
			if (!this.changeCheckLogged.has(pageId)) {
				this.changeCheckLogged.add(pageId);
				console.error(
					`[handwriting] change check failed for ${pageId}; live reload is paused for this page`,
					err
				);
			}
			return "unchanged";
		}
		// Cleared on ANY completed check, not just one that found a change.
		// Clearing only on `true` left a page that failed, recovered, and then
		// simply never changed again holding the latch forever - so a genuinely
		// new failure later would say nothing, which is the exact silence this
		// latch exists to break.
		this.changeCheckLogged.delete(pageId);
		return observation;
	}

	/**
	 * The poll's view of a page whose last load could not be used.
	 * There is no known mtime to compare, so the bytes are compared with the
	 * ones that failed, at most once per five seconds. Different bytes are
	 * "changed" and the owner re-reads through its heal path. The same bad bytes
	 * are "unchanged". A read that threw is "changed" again only while the read
	 * keeps throwing, so the owner's retry runs and can time how long the note
	 * has gone unread; nothing here writes, and the owner's lock still holds.
	 */
	private async observeUnreadable(pageId: string): Promise<ExternalChangeObservation> {
		const failed = this.unreadable.get(pageId) ?? null;
		const folder = this.folder;
		const now = performance.now();
		const checkedAt = this.contentCheckedAt.get(pageId);
		if (checkedAt !== undefined && now - checkedAt < 5000) return "unchanged";
		this.contentCheckedAt.set(pageId, now);
		let stamp: string | null = null;
		try {
			const watched = await this.resolveFor(pageId);
			// No live file: a damaged .tmp stays as it is until a live file lands.
			if (!watched.found) return failed === null ? "changed" : "unchanged";
			stamp = contentStamp(await this.app.vault.adapter.read(watched.path));
		} catch {
			stamp = null;
		}
		if (this.folder !== folder || this.hasQueuedWrite(pageId) || this.unreadable.get(pageId) !== failed) {
			return "unchanged";
		}
		if (stamp === null) return failed === null ? "changed" : "unchanged";
		return stamp === failed ? "unchanged" : "changed";
	}

	async externallyChanged(pageId: string, includeUntracked = false): Promise<boolean> {
		const observation = await this.observeExternalChange(pageId, includeUntracked);
		this.externalChangeObservations.set(pageId, observation);
		return observation === "changed";
	}

	/** Typed detail from the latest `externallyChanged` call for this page. */
	externalChangeObservation(pageId: string): ExternalChangeObservation {
		return this.externalChangeObservations.get(pageId) ?? "unchanged";
	}

	/**
	 * The vault paths a PDF sidecar claims, read without taking the file as
	 * seen. `load` records the file's mtime and hash as the baseline the next
	 * write is checked against; a read made only to choose an instance must
	 * not, or a revision no record has loaded is taken as known and the next
	 * save from a stale record writes over it with no conflict copy. No
	 * recovery either: that belongs to the load of the instance chosen. Null
	 * when there is no readable live sidecar.
	 */
	async readPdfPaths(pageId: string): Promise<string[] | null> {
		const adapter = this.app.vault.adapter;
		try {
			const final = await this.resolvePath(pageId);
			if (!(await adapter.exists(final))) return null;
			const result = parsePage(await adapter.read(final), pageId);
			return result.damaged ? null : (result.data.pdfPaths ?? []);
		} catch {
			return null;
		}
	}

	/**
	 * Pages whose flush carrier this session wrote, each with the generation
	 * of the newest one. A landed save removes the carrier only when its
	 * snapshot holds that generation (pendingCovers): a save already in flight
	 * when the carrier was written holds OLDER ink, and so does a failed older
	 * save put back into `pending` behind it. Landing either must not delete
	 * the only disk copy of the newer strokes.
	 */
	carriersWritten = new Map<string, number>();
	carrierGeneration = 0;
	/**
	 * Per page, the carrier a background flush wrote for a save that had left
	 * `pending` and not landed (flushDispatch): its generation, the page that
	 * save carries, and the carrier write itself, settled either way. That
	 * save, or its retry, makes the carrier's ink durable, so its landing
	 * removes the carrier once the carrier write has settled.
	 */
	carriedInFlight = new Map<string, { generation: number; data: PageData; written: Promise<void> }>();
	/**
	 * The saves in flight for each page. writeNow enters here at its start,
	 * records the stamp of the bytes it will write once they exist, and leaves
	 * on every exit. A carrier written meanwhile names them, so recovery can
	 * tell a live file this session's own save moved on from one that arrived
	 * from elsewhere (recoverFlushCarrier).
	 */
	savesInFlight = new Map<string, Set<{ stamp: string | null }>>();
}

installPageStorePaths(PageStore.prototype);
installPageStoreAdopt(PageStore.prototype);
installPageStoreWrite(PageStore.prototype);
installPageStoreSchedule(PageStore.prototype);
installPageStoreRemove(PageStore.prototype);
installPageStoreLoad(PageStore.prototype);
