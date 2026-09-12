import { normalizePath } from "obsidian";
import {
	DEFAULT_INK_FOLDER,
	SYNCED_INK_FOLDER,
	ensureFolder,
	isLiveSidecarName,
} from "./InkFolder";
import {
	PageData,
	ParseResult,
	emptyPage,
	isSafePageId,
	parsePage,
	serializePage,
} from "../model/PageData";
import { mergePages } from "./PageMerge";
import { runDetached } from "../util/Detached";

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
const WRITE_RETRY_MS = 1500;
const WRITE_MAX_RETRIES = 3;

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
 * never more than a few seconds from disk.
 */

const DEBOUNCE_MS = 700;

/**
 * Sort key for one trash generation, from `<pageId>-<stamp>[-<n>].json`.
 *
 * The stamp is a wall clock in ms and the counter disambiguates two
 * destructions inside the same millisecond, so newest is the largest pair.
 * Lexical order would be wrong the moment the counter reached two digits.
 * A name that does not fit the shape sorts oldest rather than throwing:
 * something else put it there, and it is not ours to rank.
 */
function generationOf(file: string, prefix: string): number {
	const name = (file.split("/").pop() ?? "").slice(prefix.length, -".json".length);
	const m = /^(\d+)(?:-(\d+))?$/.exec(name);
	if (!m) return -1;
	return Number(m[1]) * 1000 + Number(m[2] ?? 1);
}

/**
 * A sidecar path with its `.json` taken off, so the recovery copies can be
 * named as SIBLINGS OF THE FILE rather than of the configured folder. A page
 * being served from the other well-known folder used to have its conflict and
 * damaged copies written into the configured one, which scattered one page's
 * history across two directories.
 */
function stripJson(path: string): string {
	return path.endsWith(".json") ? path.slice(0, -".json".length) : path;
}

/** The folder a sidecar path sits in; "" when it names no folder at all. */
function folderOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i <= 0 ? "" : path.slice(0, i);
}
/**
 * Maximum dirty interval, anchored to the FIRST unsaved change of a batch and
 * never re-armed by later ones. The quiet-period debounce alone restarted on
 * every stroke, so a stroke every few hundred ms deferred the write
 * indefinitely (persistence gate, 2026-08-22).
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
	readonly outgoingPath: string;
	readonly incomingPath: string;
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
 * The outgoing artifact's bytes: a valid sidecar carrying its own exact
 * capture. Nothing else in the plugin writes a page this way, and no ordinary
 * save reaches it - `serializePage` and the live-sidecar path are untouched.
 */
function serializeExactOutgoing(outgoing: PageData): string {
	return serializePage({
		...outgoing,
		unknownTop: { ...outgoing.unknownTop, [EXACT_OUTGOING_KEY]: outgoing },
	});
}

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
 * A cryptographically random token for one preservation pair.
 *
 * A runtime with no CSPRNG REFUSES preservation rather than falling back to a
 * time-only name. Two devices whose clocks agree to the millisecond would
 * otherwise choose the same sibling name for different ink, and the existence
 * probe cannot see a write that has not landed yet - so the fallback would
 * quietly reintroduce, between devices, exactly the overwrite this prevents.
 */
function adoptionToken(): string {
	const source = typeof crypto === "undefined" ? undefined : crypto;
	if (!source || typeof source.getRandomValues !== "function") {
		throw new Error("Handwriting: no secure random source for the recovery copies");
	}
	const bytes = new Uint8Array(8);
	source.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class PageStore {
	private pending = new Map<string, PageData>();
	/**
	 * Who composed the payload sitting in `pending`. See PageWriter: this is
	 * the only thing that distinguishes two panes on one canvas page, because
	 * every other identity the store keeps is per-pageId.
	 */
	private pendingWriter = new Map<string, PageWriter | undefined>();
	/** Who composed the bytes currently in the live sidecar. */
	private lastWriter = new Map<string, PageWriter | undefined>();
	private timers = new Map<string, number>();
	/** One-shot maximum-dirty-interval timer per page; see MAX_DIRTY_MS. */
	private maxTimers = new Map<string, number>();
	/**
	 * One tail PER PAGE, not one for the store. The tmp/rename dance must
	 * never interleave for the SAME page - that was always the invariant -
	 * but a store-wide chain also made every page wait behind every other,
	 * which is exactly what the background/freeze flush cannot afford: with
	 * one stalled write, nothing else ever reached the adapter. Different
	 * pages are different files; they owe each other no ordering.
	 */
	private tails = new Map<string, Promise<void>>();

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

	/** Claim an attempt. Synchronous, and always paired with a release. */
	private beginOutstandingWrite(pageId: string): void {
		this.outstandingWrites.set(pageId, (this.outstandingWrites.get(pageId) ?? 0) + 1);
	}

	/** Release one attempt; the key goes when the last one does, so `size` counts pages. */
	private endOutstandingWrite(pageId: string): void {
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
	private chainBehindAll<T>(pageId: string, run: () => Promise<T>): Promise<T> {
		// The page's own tail is already among the joined ones, so seeding
		// the slot with the join loses nothing and orders run after it all.
		const all = Promise.all([...this.tails.values()]).then(() => undefined);
		this.tails.set(pageId, all);
		return this.chain(pageId, run);
	}

	/** Serialize run behind the page's own tail; the map stays bounded. */
	private chain<T>(pageId: string, run: () => Promise<T>): Promise<T> {
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
	private knownMtime = new Map<string, number>();
	/** A completed load found no sidecar; unlike an ID we have never opened. */
	private observedMissing = new Set<string>();
	/** Stamp of the content this session last read or wrote (see contentStamp). */
	private knownHash = new Map<string, string>();
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
	private resolved = new Map<string, string>();
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
	private provisional = new Set<string>();
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
	private displacedProvisional = new Map<string, string>();
	/** True between `holdWrites` and `releaseWrites`; see those. */
	private migrating = false;
	private failures = new Map<string, number>();
	private errorNotified = new Set<string>();
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
	 */
	private pendingConflict = new Map<string, string>();
	/**
	 * The recovery pair most recently completed for a page, with the identity
	 * of the exact revision pair it preserves. See `reuseAdoptionPair`: a
	 * preparation that is refused comes back on the next poll with both
	 * revisions unchanged, and it must reuse this rather than write a second
	 * identical copy. Verified evidence, not a cache - it is re-proved against
	 * disk before it is reused.
	 */
	private preservedAdoptions = new Map<
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

	constructor(
		private app: PageStoreHost,
		private folder = ".handwriting",
		/** Injectable clock so trash-generation naming is testable. */
		private now: () => number = Date.now
	) {}

	/**
	 * This page's sidecar name INSIDE a named folder.
	 *
	 * The assert is the last line, not the first: `isSafePageId` runs at both
	 * frontmatter ingress points and inside `parsePage`, so an id reaching
	 * here unsafe means one of those was bypassed. Throwing keeps the bug
	 * inside the store's own error handling - `load` reports damage, `writeNow`
	 * retries and then tells the user - rather than letting an interpolated
	 * `..` walk out of the ink folder and write there.
	 */
	private pathIn(folder: string, pageId: string): string {
		if (!isSafePageId(pageId)) {
			throw new Error(`Handwriting: refusing to build a sidecar path for ${JSON.stringify(pageId)}`);
		}
		return normalizePath(`${folder}/${pageId}.json`);
	}

	/**
	 * The sidecar path for a page in the CONFIGURED folder - the default for a
	 * page that has never been seen anywhere, and nothing else.
	 *
	 * It used to be the base every other name was built from (tmp, trash,
	 * damaged, conflict, clone destination, trash restore), and that was the
	 * defect: a page whose ink lives in the OTHER well-known folder had its
	 * trash generations, its duplicate's sidecar and its restored file planted
	 * in the configured folder instead, which is a second live sidecar for one
	 * page id the moment sync sees only one of the two folders. A page's
	 * family - trash, conflict and damaged copies, and the sidecar a duplicate
	 * gets - stays in the folder the page was FOUND in; see `folderOf`,
	 * `trashDirIn` and `resolvePath`.
	 */
	path(pageId: string): string {
		return this.pathIn(this.folder, pageId);
	}

	/**
	 * The folders a page can be served from, configured one first. The order
	 * `findSidecar` searches, and the order `listIds` and the trash sweep
	 * enumerate, because every one of them has to agree with the lookup.
	 */
	private searchFolders(): string[] {
		return [
			this.folder,
			...[DEFAULT_INK_FOLDER, SYNCED_INK_FOLDER].filter((f) => f !== this.folder),
		];
	}

	/**
	 * Every sidecar id starting with `prefix`, across EVERY folder a page can
	 * be served from - the instance enumeration behind pdf identity. Conflict,
	 * damaged and tmp artifacts are not sidecars and are not listed. An adapter
	 * without list() (test doubles, an exotic platform) yields none, which
	 * degrades resolution to "first instance" rather than failing anything.
	 *
	 * The folders are the ones `findSidecar` searches, in its order, because
	 * the enumeration has to agree with the lookup: `load` on any id returned
	 * here resolves across both well-known folders already, so listing only the
	 * configured one was the READ-side half of the two-device fork. A device
	 * whose data.json names `.handwriting` while the ink sits in `handwriting/`
	 * enumerated NOTHING, so `chooseInstance` saw no candidate claiming this
	 * file's path, called a document that already had ink a fresh copy, and
	 * handed it an id `nextInstanceId` believed was free - an id the unseen
	 * sidecar next door may already own. Missing candidates do not degrade
	 * identity gracefully; they fork it.
	 *
	 * Each id ONCE, and only the id: the same page id present in both folders
	 * is one page, and which file it is served from stays `resolvePath`'s
	 * answer (the pin if there is one, otherwise `findSidecar`), exactly as it
	 * is for every other caller. Nothing is pinned here - enumerating a folder
	 * is not evidence about a page the caller has not touched.
	 *
	 * A folder that will not enumerate is skipped rather than fatal, PER
	 * FOLDER: a vault with only one ink folder has the other one throw ENOENT
	 * on every call, so a single try around the whole sweep would have made
	 * the ordinary case return nothing.
	 */
	async listIds(prefix: string): Promise<string[]> {
		const adapter = this.app.vault.adapter;
		if (typeof adapter.list !== "function") return [];
		const list = adapter.list.bind(adapter);
		const folders = this.searchFolders();
		const seen = new Set<string>();
		const ids: string[] = [];
		for (const folder of folders) {
			let files: string[];
			try {
				files = (await list(folder)).files;
			} catch {
				continue;
			}
			for (const file of files) {
				const n = file.split("/").pop() ?? "";
				// The same predicate `adoptInkFolder` decides by, shared so the
				// two can never drift: a conflict or damaged copy is residue,
				// not a page, in both answers.
				if (!n.startsWith(prefix) || !isLiveSidecarName(n)) continue;
				const id = n.slice(0, -".json".length);
				if (seen.has(id)) continue;
				seen.add(id);
				ids.push(id);
			}
		}
		return ids;
	}

	/** Where sidecars are being kept right now. */
	inkFolder(): string {
		return this.folder;
	}

	/**
	 * WRITES ARE HELD WHILE THE INK FOLDER IS BEING MOVED.
	 *
	 * `changeFolder` settles the queue first, but settling drains it ONCE and
	 * the move that follows spans a list plus a rename per file, with the store
	 * still pointed at the old folder and every pin intact. A stroke landing in
	 * that window recreated the sidecar in the folder being emptied: the pin's
	 * file had already been renamed away, `findSidecar` cannot see a custom
	 * destination, so `pinned ?? path` named `from/X.json` and the write made
	 * it. Then `repoint` cleared the pins, the next resolve served the older
	 * copy the migration had moved, and the newest ink sat orphaned in a folder
	 * the user believes they emptied.
	 *
	 * Held, not dropped: `writeNow` puts the state back in `pending` and arms
	 * the ordinary retry timer, so the write lands in the DESTINATION once the
	 * move and the repoint are done. `busy` and `hasQueuedWrite` stay true
	 * throughout, which is the truth.
	 */
	holdWrites(): void {
		this.migrating = true;
	}

	/** Release the hold. Always from a `finally`; see `changeFolder`. */
	releaseWrites(): void {
		this.migrating = false;
	}

	/**
	 * Point the store at a different folder. Writes go here from now on.
	 *
	 * Reads keep a fallback (see `findSidecar`), which is what makes a move
	 * between the TWO WELL-KNOWN folders safe to interrupt: half-finished, or
	 * with a settings save that never landed, pages stay readable from
	 * wherever they actually are instead of invisible. A CUSTOM destination
	 * is not searched, so there the recovery is to set the folder again in
	 * Settings; nothing is lost either way.
	 *
	 * The resolved-path map is CLEARED here, and that is not a detail. This is
	 * `changeFolder`'s `repoint` step, which runs AFTER `migrate` has already
	 * renamed every sidecar into the new folder (InkFolder.ts changeFolder,
	 * main.ts changeInkFolder). Every pinned path therefore names a file that
	 * the migration just moved away; keeping them would send the next write
	 * back to the emptied folder, re-creating exactly the second sidecar this
	 * map exists to prevent. Cleared, each page resolves again on its next
	 * touch and finds itself in the new folder. Startup's repoint (main.ts,
	 * before any note opens) clears an empty map, which costs nothing.
	 */
	useInkFolder(folder: string): void {
		this.folder = folder;
		this.resolved.clear();
		// Both are statements ABOUT the pins, so they go with them: a
		// provisional mark on a pin that no longer exists would make the next
		// resolve of a freshly re-resolved page pay for a search it does not
		// need, and a displaced file waiting to be preserved beside a winner
		// that has just been migrated names a path nothing will look at.
		this.provisional.clear();
		this.displacedProvisional.clear();
	}

	/**
	 * Where to READ a page from: the configured folder, or either of the two
	 * well-known ones if the file is not there.
	 *
	 * The fallback used to run one way only, from a configured folder down to
	 * `.handwriting`, on the reasoning that every vault's ink starts life
	 * there. That is true of the FILES and not of the SETTING. The folder
	 * choice lives only in `data.json`, which Obsidian Sync does not carry
	 * unless plugin settings are enabled - so a second device in a
	 * sync-compatibility vault reads `.handwriting`, finds none of the ink
	 * sitting in `handwriting/` right beside it, shows blank pages, and then
	 * writes a SECOND set of sidecars under the same page ids. The ink is
	 * intact and forked, which is worse than missing.
	 *
	 * Both directions, therefore, and a custom folder falls back to both.
	 * Costs one `exists` on a hit and two on a miss; loads are not the pen
	 * path. See adoptInkFolder for the other half - reading is what keeps
	 * the ink visible, adopting is what stops the fork.
	 */
	private async findSidecar(pageId: string): Promise<{ path: string; found: boolean }> {
		const primary = this.path(pageId);
		const others = [DEFAULT_INK_FOLDER, SYNCED_INK_FOLDER].filter((f) => f !== this.folder);
		const adapter = this.app.vault.adapter;
		if (await adapter.exists(primary)) return { path: primary, found: true };
		for (const folder of others) {
			const fallback = normalizePath(`${folder}/${pageId}.json`);
			if (await adapter.exists(fallback)) return { path: fallback, found: true };
		}
		return { path: primary, found: false };
	}

	/**
	 * THE path for this page: pinned if we have already found or written it
	 * AND the file is still there, otherwise whatever `findSidecar` turns up
	 * now.
	 *
	 * A pin is a hint, not a fact: sync can move or remove the file the pin
	 * names while a session sits open (another device migrated the note to a
	 * different folder, or deleted it), and blindly trusting a stale pin is
	 * exactly the fork this map exists to prevent - the next write would
	 * recreate the sidecar at the empty pinned path while the real one lives
	 * elsewhere, leaving two live files under one id. So a pinned path is
	 * re-proven with one `exists` before it is trusted; the external-revision
	 * guard on the write path stats the same file again immediately after, so
	 * this costs nothing extra there.
	 *
	 * Every path-taking operation goes through here - load, the write, the
	 * external-revision guard, the change poll, preserve, remove - so a page
	 * is read from and written to ONE file. A page that exists nowhere
	 * resolves to the configured folder and is deliberately NOT pinned, so
	 * "never seen before goes to the configured folder" is unchanged, and a
	 * sidecar that turns up later (sync landing it while the note sits open)
	 * is still adopted rather than written past.
	 */
	private async resolvePath(pageId: string): Promise<string> {
		return (await this.resolveFor(pageId)).path;
	}

	/**
	 * `resolvePath` plus the fact the write path needs: was the page PROVEN to
	 * exist somewhere, or is this only where it would go?
	 *
	 * A write that resolves to a proven file confirms the pin. A write that
	 * resolves to nothing is writing blind, and the pin it leaves behind is
	 * provisional (see `provisional`).
	 */
	private async resolveFor(pageId: string): Promise<{ path: string; found: boolean }> {
		const pinned = this.resolved.get(pageId);
		if (pinned !== undefined && (await this.app.vault.adapter.exists(pinned))) {
			if (!this.provisional.has(pageId)) return { path: pinned, found: true };
			// A PROVISIONAL pin: this file exists because this device wrote it
			// blind, never because anything found the page here. One `exists`
			// per other well-known folder settles whether the real, synced copy
			// has since arrived; ordinary pins never reach this branch.
			const arrived = await this.findElsewhere(pageId, pinned);
			if (arrived === null) return { path: pinned, found: true };
			// It has. That copy is the page's home from here on - it is the one
			// the vault's other devices can see - and the blind local file is
			// kept beside it rather than discarded (absorbProvisional).
			this.resolved.set(pageId, arrived);
			this.provisional.delete(pageId);
			this.displacedProvisional.set(pageId, pinned);
			return { path: arrived, found: true };
		}
		const { path, found } = await this.findSidecar(pageId);
		if (found) {
			this.resolved.set(pageId, path);
			// Found on disk: the pin is now a fact whatever it was before.
			this.provisional.delete(pageId);
			return { path, found: true };
		}
		// Found nowhere. A page never seen before still goes to the configured
		// folder (`path` names it, `pinned` is undefined). A page whose pin
		// just went missing keeps its last known home instead of being
		// redirected there: the page's last known home, and a page deleted on
		// the other device is recreated where it lived - today's behaviour,
		// deliberately unchanged.
		return { path: pinned ?? path, found: false };
	}

	/**
	 * The page's sidecar in some folder OTHER than the one `not` sits in, or
	 * null. Only ever asked about a provisional pin, so the ordinary resolve
	 * still costs exactly one `exists`.
	 */
	private async findElsewhere(pageId: string, not: string): Promise<string | null> {
		const home = folderOf(not);
		const adapter = this.app.vault.adapter;
		for (const folder of this.searchFolders()) {
			if (folder === home) continue;
			const candidate = this.pathIn(folder, pageId);
			if (await adapter.exists(candidate)) return candidate;
		}
		return null;
	}

	/**
	 * The pin without the lookup, for the one caller that cannot await: the
	 * background flush's raw tmp write (see writeTmpNow). Falls back to the
	 * configured folder, which is where an unresolved page would be written
	 * anyway, and the normal write chained behind it resolves properly.
	 */
	private pinnedPath(pageId: string): string {
		return this.resolved.get(pageId) ?? this.path(pageId);
	}

	/** The scratch file for a save, always a SIBLING of the file it becomes. */
	private tmpFor(final: string): string {
		return `${final}.tmp`;
	}

	/**
	 * ONE TRASH PER INK FOLDER, not one per store.
	 *
	 * The trash used to be `<configured folder>/trash` whatever folder the page
	 * itself lived in, so deleting a note whose ink sits in `handwriting/`
	 * recycled it into `.handwriting/trash/` - and restoring it then planted
	 * the live file in `.handwriting/` too. Sync, which had already carried the
	 * deletion of `handwriting/X.json` to the other device, never sees either,
	 * so that device opens the restored note blank and its first stroke starts
	 * a SECOND live sidecar under the same id. A page's whole family stays in
	 * the folder the page was found in.
	 */
	private trashDirIn(folder: string): string {
		return normalizePath(`${folder}/trash`);
	}

	/**
	 * A never-taken name for the next trash generation (RC4), in the trash that
	 * belongs to the page's OWN folder.
	 *
	 * Before RC4 the trash held ONE slot per page id, so a second "delete all
	 * ink", or a delete-all followed by a note delete, silently overwrote the
	 * first recovery copy. Generations are stamped with the wall clock and
	 * disambiguated with a counter, because two destructions inside the same
	 * millisecond are entirely possible (and are exercised by the tests).
	 * Every candidate is probed, so an existing file is never the destination.
	 */
	private async freeTrashPath(pageId: string, folder: string): Promise<string> {
		const adapter = this.app.vault.adapter;
		const base = `${this.trashDirIn(folder)}/${pageId}-${this.now()}`;
		let candidate = normalizePath(`${base}.json`);
		for (let n = 2; await adapter.exists(candidate); n++) {
			candidate = normalizePath(`${base}-${n}.json`);
		}
		return candidate;
	}

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
			this.outstandingWrites.size > 0
		);
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

	/**
	 * Cheap poll primitive for live reload: has the sidecar on disk changed
	 * behind our back? One stat on the fast path; a read only when the mtime
	 * moved (sync tools preserve mtimes, so the content stamp decides).
	 * Never answers while a write for this page is queued - a half-landed
	 * save of our own must not read as an external edit - and never for a
	 * page this store has not read or written. A completed missing load is a
	 * baseline too: the first JSON may arrive after the document was opened.
	 * The write-path conflict guard stays the last word either way.
	 *
	 * See hasQueuedWrite above for why a caller must re-ask synchronously.
	 */
	private async observeExternalChange(pageId: string): Promise<ExternalChangeObservation> {
		if (this.hasQueuedWrite(pageId)) return "unchanged";
		const known = this.knownMtime.get(pageId);
		if (known === undefined && !this.observedMissing.has(pageId)) return "unchanged";
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
				if (!st || st.mtime === known) {
					observation = "unchanged";
				} else {
					const stamp = contentStamp(await adapter.read(watched.path));
					if (stamp === this.knownHash.get(pageId)) {
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

	async externallyChanged(pageId: string): Promise<boolean> {
		const observation = await this.observeExternalChange(pageId);
		this.externalChangeObservations.set(pageId, observation);
		return observation === "changed";
	}

	/** Typed detail from the latest `externallyChanged` call for this page. */
	externalChangeObservation(pageId: string): ExternalChangeObservation {
		return this.externalChangeObservations.get(pageId) ?? "unchanged";
	}

	async load(pageId: string): Promise<ParseResult | null> {
		const adapter = this.app.vault.adapter;
		try {
			// Not `path()` alone: a page can still be sitting in the default
			// folder if a folder change was interrupted, or because this device's
			// data.json never named the folder the vault actually uses. See
			// resolvePath - which also PINS what it finds, so the save that
			// follows this load writes to the file the load read. Inside the
			// try because it builds paths, and path() asserts.
			const final = await this.resolvePath(pageId);
			if (await adapter.exists(final)) {
				// Stat BEFORE read, deliberately: if an external writer lands
				// between the two, the recorded mtime is then OLDER than the
				// file, and the next write sees a mismatch and preserves the
				// external state as a conflict. The reverse order (read, then
				// stat) records THEIR mtime against OUR content, and the guard
				// would then miss the revision and clobber it. A false
				// conflict is recoverable; a missed one is not.
				const st = await adapter.stat(final).catch(() => null);
				const text = await adapter.read(final);
				const result = parsePage(text, pageId);
				if (!result.damaged) {
					if (st) this.knownMtime.set(pageId, st.mtime);
					this.knownHash.set(pageId, contentStamp(text));
					// A LOAD HIT confirms the pin. `resolveFor` has just proven
					// no copy exists in any other well-known folder, and the
					// page has now been READ from this one, so it is no longer
					// merely where this device wrote blind - it is where the
					// page is. Later resolves stop paying for the extra look.
					this.provisional.delete(pageId);
					return result;
				}
				// The main file is corrupt. Exactly one recovery case: its own
				// interrupted save is a complete, current-format page for this
				// id. Anything less keeps the read-only lock.
				return (
					(await this.promoteTmpOverDamaged(pageId, final, st?.mtime ?? 0, contentStamp(text))) ??
					result
				);
			}
			// No live sidecar. An interrupted save's .tmp is looked for beside
			// the resolved path first, then beside the page's name in every
			// other folder it can be served from (findInterruptedSave).
			const save = await this.findInterruptedSave(pageId, final);
			if (save !== null) {
				const { tmp, live, text, result } = save;
				// PROMOTED, not just read. Recovering the content and leaving
				// it in the .tmp meant the only copy on disk was still the
				// scratch file the next save writes to - so that save opened
				// by overwriting the very bytes it had just recovered from,
				// and a failure mid-write took them with it. Renaming makes
				// the recovered page a real sidecar first, and the next save
				// then has something to fall back to like any other page.
				//
				// Damage is not promoted: it may still be recoverable by hand,
				// and a corrupt file in the live path is worse than one in a
				// .tmp nobody is reading.
				if (!result.damaged) {
					try {
						// Into the .tmp's OWN folder: a save interrupted in the
						// other well-known folder comes back there, where the
						// vault's other devices can see it.
						await adapter.rename(tmp, live);
						// The page now exists, so where it exists is settled -
						// a fact, not a provisional guess.
						this.resolved.set(pageId, live);
						this.provisional.delete(pageId);
						const st = await adapter.stat(live).catch(() => null);
						if (st) this.knownMtime.set(pageId, st.mtime);
						this.knownHash.set(pageId, contentStamp(text));
					} catch (err) {
						// The content is in hand either way; the caller gets it
						// and the next save will write it out properly.
						console.error("[handwriting] could not promote a recovered .tmp", pageId, err);
					}
				}
				return { ...result, recovered: true, problem: result.problem ?? "recovered from interrupted write" };
			}
		} catch (err) {
			// The payload exists but cannot be read: that is DAMAGE, not an
			// empty page. Callers must fail closed (render nothing, write
			// nothing) or this placeholder becomes the file's new contents.
			return { data: emptyPage(pageId), recovered: true, damaged: true, problem: String(err) };
		}
		// No live sidecar and no interrupted write. Before calling this page
		// blank, look in our own trash: a note restored from Obsidian's
		// .trash, or undeleted by a sync client, comes back carrying the id
		// its ink is filed under, and that ink was recycled when the note
		// went. Nothing ever brought it back, so the note reopened empty and
		// the next stroke began a SECOND sidecar under the same id, diverging
		// from the copy sitting in the trash folder.
		const restored = await this.restoreFromTrash(pageId);
		if (restored === null) this.observedMissing.add(pageId);
		return restored;
	}

	/**
	 * The interrupted save to recover from when no live sidecar exists, or
	 * null: the `.tmp` beside `final` (the resolved path) first, then the
	 * `.tmp` beside the page's name in every other folder a page can be
	 * served from, in `searchFolders` order.
	 *
	 * A page served from the OTHER well-known folder is saved there, beside
	 * the file the write found (writeNow), and after a restart nothing
	 * remembers that: the pin is gone, `findSidecar` sees only final names
	 * and answers the configured folder, and only THAT folder's `.tmp` was
	 * checked. The intact save next door was never considered, so a page
	 * whose new bytes sat complete on disk read as absent, and the next
	 * stroke started a second sidecar beside them.
	 *
	 * The first candidate that is a complete page for THIS id wins, so the
	 * resolved path keeps the precedence it has today and a scratch file for
	 * some other page is never promoted under this one's name. A candidate
	 * that will not parse is reported only when no candidate does, and is
	 * never promoted (load explains why). Costs one `exists` per extra
	 * folder, only on a load that found no live sidecar.
	 */
	private async findInterruptedSave(
		pageId: string,
		final: string
	): Promise<{ tmp: string; live: string; text: string; result: ParseResult } | null> {
		const adapter = this.app.vault.adapter;
		const candidates = [final];
		for (const folder of this.searchFolders()) {
			const live = this.pathIn(folder, pageId);
			if (!candidates.includes(live)) candidates.push(live);
		}
		let damaged: { tmp: string; live: string; text: string; result: ParseResult } | null = null;
		for (const live of candidates) {
			const tmp = this.tmpFor(live);
			if (!(await adapter.exists(tmp))) continue;
			const text = await adapter.read(tmp);
			const result = parsePage(text, pageId);
			if (result.damaged) {
				damaged ??= { tmp, live, text, result };
				continue;
			}
			if (result.data.pageId !== pageId) continue;
			return { tmp, live, text, result };
		}
		return damaged;
	}

	/**
	 * The newest trashed generation for this page, moved back into place.
	 *
	 * Only ever reached when the live path and the .tmp are both absent, so
	 * this can never displace a real file. Candidates are matched by name and
	 * then CONFIRMED by the pageId inside them, because the name alone is
	 * ambiguous: pdf instance ids are `pdf-<hex>` and `pdf-<hex>-2`, so one
	 * page's trash prefix can match another page's generations.
	 *
	 * A generation that will not parse is left where it is. It may still be
	 * recoverable by hand, and promoting damage over a page the caller would
	 * otherwise treat as absent turns a recoverable problem into a locked one.
	 *
	 * EVERY well-known folder's trash is searched, and the page is restored
	 * into the folder whose trash held it - not into the configured one. A
	 * device configured for `.handwriting` restoring a note whose ink was
	 * recycled from `handwriting/` used to put the live file in `.handwriting/`,
	 * where sync cannot see it, while the other device (which had the deletion)
	 * opened the note blank and started a second sidecar on its first stroke.
	 */
	private async restoreFromTrash(pageId: string): Promise<ParseResult | null> {
		const adapter = this.app.vault.adapter;
		if (typeof adapter.list !== "function") return null;
		const list = adapter.list.bind(adapter);
		const prefix = `${pageId}-`;
		// Tagged with the folder that owns the trash, because that folder is
		// where the page goes back to.
		const candidates: Array<{ file: string; home: string }> = [];
		for (const home of this.searchFolders()) {
			let files: string[];
			try {
				files = (await list(this.trashDirIn(home))).files;
			} catch {
				continue; // no trash there yet, or it cannot be enumerated
			}
			for (const f of files) {
				const name = f.split("/").pop() ?? "";
				if (name.startsWith(prefix) && name.endsWith(".json")) candidates.push({ file: f, home });
			}
		}
		// Newest first, ACROSS the folders. The names carry a wall-clock stamp
		// and a counter, so lexical order is wrong once the counter reaches two
		// digits; the generations are few, so this compares the numbers. Equal
		// stamps keep the folder order above, which is the configured folder
		// first - the same tie-break every other lookup here makes.
		candidates.sort((a, b) => generationOf(b.file, prefix) - generationOf(a.file, prefix));
		for (const { file, home } of candidates) {
			let text: string;
			try {
				text = await adapter.read(file);
			} catch {
				continue;
			}
			const parsed = parsePage(text, pageId);
			if (parsed.damaged || parsed.data.pageId !== pageId) continue;
			const final = this.pathIn(home, pageId);
			try {
				await ensureFolder(adapter, home);
				await adapter.rename(file, final);
			} catch (err) {
				// The ink is still in the trash and still readable; returning
				// it un-restored is better than failing the load.
				console.error("[handwriting] could not restore recycled ink", pageId, err);
				return { ...parsed, recovered: true, fromInkTrash: true, problem: "recovered from the ink trash" };
			}
			const st = await adapter.stat(final).catch(() => null);
			// Restored into the folder its own trash belongs to, and that is
			// now where the page lives: this path is only reached when it lived
			// nowhere. A file that provably exists: not a provisional pin.
			this.resolved.set(pageId, final);
			this.provisional.delete(pageId);
			if (st) this.knownMtime.set(pageId, st.mtime);
			this.knownHash.set(pageId, contentStamp(text));
			// The RESTORE's own callback, not the corrupt-file promotion's.
			// Raising `onRecovered` here announced a trash restore as an
			// interrupted save and called `final` - the live sidecar the ink
			// was just renamed back into, and the only copy of it - the
			// unreadable file. Same value, correct claim.
			this.onInkTrashRestored?.(pageId, final);
			return { ...parsed, recovered: true, fromInkTrash: true, problem: "restored from the ink trash" };
		}
		return null;
	}

	/**
	 * Corrupt main file, complete interrupted save beside it: keep the corrupt
	 * bytes under a collision-proof name, promote the .tmp, and record the
	 * promoted content as this session's own so the next save is not a false
	 * conflict. Refuses (returns null; the caller stays read-only) when the
	 * .tmp is missing, corrupt, for another page id, or a newer schema. Never
	 * chooses between two VALID files.
	 *
	 * The decision is made TWICE. The screening below runs off the queue, so
	 * a hopeless candidate never queues work behind pending writes; but by the
	 * time our turn arrives a save, a sync, or another device can have
	 * replaced either file. Acting on the first reading is how a main file
	 * that has since become readable gets renamed away as "damaged" and
	 * overwritten by a stale snapshot. So every condition is proven again
	 * inside the queued operation, immediately before either rename, against
	 * the bytes on disk at that moment. If either file has moved on, neither
	 * is touched: the newly observed state is returned when there is one, and
	 * otherwise the note stays read-only.
	 */
	private async promoteTmpOverDamaged(
		pageId: string,
		/** The file load() actually read - not necessarily the configured one. */
		final: string,
		damagedMtime: number,
		damagedStamp: string
	): Promise<ParseResult | null> {
		const adapter = this.app.vault.adapter;
		const tmp = this.tmpFor(final);

		// Screening, off the queue. Everything here is proven again in `run`.
		if (!(await adapter.exists(tmp))) return null;
		let text: string;
		try {
			text = await adapter.read(tmp);
		} catch {
			return null;
		}
		const candidate = parsePage(text, pageId);
		if (candidate.damaged) return null;
		if (candidate.futureVersion !== undefined) return null;
		if (candidate.data.pageId !== pageId) return null;
		const tmpStamp = contentStamp(text);

		type Outcome =
			| { kind: "promoted"; keptAs: string; text: string }
			| { kind: "observed"; result: ParseResult }
			| { kind: "abandoned" };

		const run = async (): Promise<Outcome> => {
			// (1) the main file is still there.
			if (!(await adapter.exists(final))) return { kind: "abandoned" };
			// (2) and still holds the exact bytes that were judged corrupt.
			// Stat before read, for the reason load() documents.
			const st = await adapter.stat(final).catch(() => null);
			const finalText = await adapter.read(final);
			if (contentStamp(finalText) !== damagedStamp) {
				// Those bytes are gone. Whatever replaced them is the answer,
				// and the .tmp is left exactly where it is. A readable
				// replacement also becomes this session's baseline, since this
				// is the read that observed it.
				const reparsed = parsePage(finalText, pageId);
				if (!reparsed.damaged) {
					if (st) this.knownMtime.set(pageId, st.mtime);
					this.knownHash.set(pageId, contentStamp(finalText));
				}
				return { kind: "observed", result: reparsed };
			}
			// (3) the interrupted save is still there and unchanged.
			if (!(await adapter.exists(tmp))) return { kind: "abandoned" };
			const tmpText = await adapter.read(tmp);
			if (contentStamp(tmpText) !== tmpStamp) return { kind: "abandoned" };
			// (4) and is still a complete, current-format page for this id.
			const recheck = parsePage(tmpText, pageId);
			if (recheck.damaged) return { kind: "abandoned" };
			if (recheck.futureVersion !== undefined) return { kind: "abandoned" };
			if (recheck.data.pageId !== pageId) return { kind: "abandoned" };
			// (5) both files are what was inspected. Only now does anything move.
			const keptAs = await this.freeDamagedPath(final, damagedMtime);
			await adapter.rename(final, keptAs);
			await adapter.rename(tmp, final);
			const after = await adapter.stat(final).catch(() => null);
			if (after) this.knownMtime.set(pageId, after.mtime);
			this.knownHash.set(pageId, contentStamp(tmpText));
			return { kind: "promoted", keptAs, text: tmpText };
		};

		const chained = this.chainBehindAll(pageId, run);
		let outcome: Outcome;
		try {
			outcome = await chained;
		} catch (err) {
			// Whatever landed stays where it is: a kept copy, a missing main
			// file and an intact .tmp are all recoverable by a later load.
			console.error("[handwriting] sidecar recovery failed", pageId, err);
			return null;
		}
		if (outcome.kind === "abandoned") return null;
		if (outcome.kind === "observed") return outcome.result;
		this.onRecovered?.(pageId, outcome.keptAs);
		return {
			...parsePage(outcome.text, pageId),
			recovered: true,
			problem: "main file unreadable; recovered the interrupted save",
			damagedKeptAs: outcome.keptAs,
		};
	}

	/** A never-taken name for a corrupt main file that is being moved aside. */
	private async freeDamagedPath(final: string, mtime: number): Promise<string> {
		const adapter = this.app.vault.adapter;
		const base = `${stripJson(final)}.damaged-${mtime}`;
		let candidate = `${base}.json`;
		for (let n = 2; await adapter.exists(candidate); n++) {
			candidate = `${base}-${n}.json`;
		}
		return candidate;
	}

	/**
	 * Queue a save. Safe to call on every mutation.
	 *
	 * Every call restarts the quiet-period timer. The FIRST change of a batch
	 * also arms the maximum-dirty-interval timer, which later changes never
	 * touch; whichever fires first writes the latest complete snapshot and
	 * clears both. Changes arriving during a write start a new batch and wait
	 * for the next write; writes for one page stay serialized on the queue.
	 */
	schedule(pageId: string, data: PageData, writer?: PageWriter): void {
		this.displaceForeignBatch(pageId, writer);
		this.pending.set(pageId, data);
		this.pendingWriter.set(pageId, writer);
		const existing = this.timers.get(pageId);
		if (existing !== undefined) window.clearTimeout(existing);
		this.timers.set(
			pageId,
			window.setTimeout(() => {
				this.timers.delete(pageId);
				runDetached(this.writePending(pageId), `write queued sidecar ${pageId}`);
			}, DEBOUNCE_MS)
		);
		if (!this.maxTimers.has(pageId)) {
			this.maxTimers.set(
				pageId,
				window.setTimeout(() => {
					this.maxTimers.delete(pageId);
					runDetached(this.writePending(pageId), `write bounded-dirty sidecar ${pageId}`);
				}, MAX_DIRTY_MS)
			);
		}
	}

	/**
	 * Write this state now, with no quiet period: the first save after an
	 * identity claim, where the 700 ms were already spent waiting for the id.
	 * Serialized on the queue like every other write. Resolves when the
	 * attempt is over: the rename has landed, or the failure has re-queued
	 * the state for the bounded retry path.
	 */
	async saveNow(pageId: string, data: PageData, writer?: PageWriter): Promise<void> {
		this.displaceForeignBatch(pageId, writer);
		this.pending.set(pageId, data);
		this.pendingWriter.set(pageId, writer);
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
	private displaceForeignBatch(pageId: string, writer: PageWriter | undefined): void {
		if (writer === undefined) return;
		const queued = this.pendingWriter.get(pageId);
		if (queued === undefined || queued === writer) return;
		if (!this.pending.has(pageId)) return;
		runDetached(this.writePending(pageId), `write a displaced batch for ${pageId}`);
	}

	private clearTimers(pageId: string): void {
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
	}

	/**
	 * Hand every dirty sidecar's TMP FILE to the adapter in one synchronous
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
	flushDispatch(): void {
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
	private writeTmpNow(pageId: string, data: PageData): Promise<void> | null {
		try {
			// path() asserts on an unsafe id and serializePage can throw on a
			// malformed page; both must fail into the normal path rather than
			// out of a visibilitychange handler.
			// The PINNED path, not the configured one: this write must land
			// beside the file the page actually lives in, or load() would not
			// look where the freeze left it. Nothing may be awaited here, so
			// an unresolved page falls back to the configured folder - which
			// is where an unresolved page would be written anyway.
			const tmp = this.tmpFor(this.pinnedPath(pageId));
			const serialized = serializePage(data);
			return this.app.vault.adapter.write(tmp, serialized);
		} catch (err) {
			console.error("[handwriting] background tmp write could not be dispatched", pageId, err);
			return null;
		}
	}

	/** Write everything queued right now: page switch, view close, plugin unload. */
	async flush(): Promise<void> {
		for (const pageId of new Set([...this.timers.keys(), ...this.maxTimers.keys()])) {
			this.clearTimers(pageId);
		}
		const ids = [...this.pending.keys()];
		for (const id of ids) await this.writePending(id);
		await Promise.all([...this.tails.values()]);
	}

	/**
	 * Copy the page's CURRENT state to a fresh `.handwriting/trash/` generation,
	 * leaving the live sidecar untouched. Any pending save is flushed first,
	 * so the copy is the newest state, not a stale one. This is the safety net
	 * behind "Delete all ink": the wipe that follows overwrites the live file,
	 * and this copy keeps today's ink recoverable anyway.
	 *
	 * RC4: the destination is `<id>-<stamp>[-n].json` and is never an existing
	 * file, so a second delete-all can no longer destroy the first one's copy.
	 * The bytes are copied verbatim. Unknown fields survive by construction,
	 * because nothing here parses or re-serializes the payload.
	 *
	 * Returns the copy's path, or null when the page has nothing on disk.
	 * THROWS when the copy itself cannot be made. The caller must then refuse
	 * the wipe rather than proceed without the net.
	 */
	async preserve(pageId: string): Promise<string | null> {
		this.clearTimers(pageId);
		await this.writePending(pageId); // no-op when nothing is queued
		if (this.pending.has(pageId)) {
			// The flush did not land (writeNow re-queued the state): the copy
			// below would then preserve a STALE file while the caller tells the
			// user it holds today's ink. Refuse instead. The caller aborts the
			// wipe, and nothing is lost.
			//
			// TWO REASONS IT DID NOT LAND, and the message must not claim the
			// wrong one. A real write failure is one. The other, since writes
			// are held across an ink-folder move, is that the move is still
			// running - the queue is intact, the ink is fine, and trying again
			// in a moment simply works. Blaming the disk for that sends someone
			// looking for a fault that is not there.
			throw new Error(
				this.migrating
					? "Handwriting: the ink folder is still moving - try again in a moment"
					: "Handwriting: the newest ink could not be written to disk"
			);
		}
		const adapter = this.app.vault.adapter;
		let dest: string | null = null;
		const run = async (): Promise<void> => {
			// The resolved path, like load: the page may be sitting in the other
			// well-known folder (an interrupted migration, or a device that
			// lost data.json). Preserving only what the CONFIGURED folder
			// holds meant the safety copy silently covered nothing, right
			// before the caller wiped the note.
			const final = await this.resolvePath(pageId);
			if (!(await adapter.exists(final))) return;
			// The trash beside the FILE, not beside the configured folder: a
			// generation dropped into the other folder's trash is invisible to
			// the restore path that vault's other devices will take.
			const trashDir = this.trashDirIn(folderOf(final));
			await ensureFolder(adapter, trashDir);
			const text = await adapter.read(final);
			const to = await this.freeTrashPath(pageId, folderOf(final));
			await adapter.write(to, text);
			dest = to;
		};
		// Ride the write chain so the copy can't interleave with a save, but
		// keep the chain alive if the copy fails. The failure is the CALLER's
		// signal (abort the wipe), not a reason to wedge future saves.
		const chained = this.chain(pageId, run);
		await chained;
		return dest;
	}

	/**
	 * PREPARE AN EXTERNAL ADOPTION WITHOUT ACKNOWLEDGING IT.
	 *
	 * The loss this closes: a sidecar replaced by another device is adopted by
	 * rebuilding the record through `load`, and `load` stamps `knownMtime` and
	 * `knownHash` with the incoming file. From that instant the outgoing
	 * revision has no representation anywhere - it is out of the record and the
	 * write-path guard no longer has a reason to preserve anything. Merging the
	 * two is NOT the fix and is not attempted here: `mergePages` is a union,
	 * and its own docstring says this layer cannot tell a stroke the other
	 * device DELETED from one it never SAW. Across devices that are offline for
	 * hours the second case is ordinary, so a blind union would resurrect real
	 * deletions - a zombie bug traded for a loss bug.
	 *
	 * So both revisions are made independently recoverable FIRST, and the swap
	 * happens only after that succeeded. Neither artifact depends on the live
	 * file or on its pair to be read back.
	 *
	 * `preserve(pageId)` is deliberately not reused: it reads the file that is
	 * there NOW - which after a replacement is the incoming one - and it may
	 * first flush a queued write. It answers a different question.
	 *
	 * Nothing here touches the synced live sidecar, and nothing here updates
	 * the known baseline. Both are `acceptExternalAdoption`'s job, and it is
	 * synchronous so no await can separate the caller's re-qualification from
	 * the acknowledgement.
	 *
	 * `expectedSurface` is caller authority, not a globally widened clause: an
	 * inline caller must never adopt a PDF page merely because this shared
	 * preservation mechanism also serves the PDF store.
	 */
	async prepareExternalAdoption(
		pageId: string,
		outgoing: PageData,
		expectedSurface: "inline" | "pdf" = "inline"
	): Promise<ExternalAdoptionPrep> {
		const adapter = this.app.vault.adapter;
		// On the page's own write chain: the artifacts must not interleave with
		// a save, and the live file must not be rewritten under the capture.
		return await this.chain(pageId, async (): Promise<ExternalAdoptionPrep> => {
			const final = await this.resolvePath(pageId);
			if (!(await adapter.exists(final))) {
				return { kind: "unavailable", why: "no live sidecar", reason: "no-live-sidecar" };
			}
			// Stat BEFORE the read, for the reason `load` states: a stamp taken
			// after the bytes can record an mtime that belongs to a revision
			// this never saw.
			const st = await adapter.stat(final).catch(() => null);
			const incomingText = await adapter.read(final);
			const incomingStamp = contentStamp(incomingText);
			const parsed = parsePage(incomingText, pageId);
			if (
				parsed.damaged ||
				parsed.futureVersion !== undefined ||
				parsed.data.surface !== expectedSurface
			) {
				// Damage, a newer schema and a legacy canvas page each have an
				// existing lock that fails closed, and those locks are better
				// than anything this route could do. Hand it back untouched.
				return {
					kind: "unavailable",
					why: "the incoming revision is not a clean inline page",
					reason: "incoming-unusable",
				};
			}
			// The artifact carries its own unrounded capture; see
			// EXACT_OUTGOING_KEY. The dedup key is taken from these bytes, so a
			// mutation too small for the persisted codec still changes the pair
			// identity and correctly earns a fresh pair rather than reusing one
			// that describes a revision the record no longer holds.
			const outgoingText = serializeExactOutgoing(outgoing);
			const key = `${contentStamp(outgoingText)}|${incomingStamp}`;
			const pair =
				(await this.reuseAdoptionPair(pageId, key, outgoingText, incomingText)) ??
				(await this.writeAdoptionPair(pageId, final, key, outgoingText, incomingText, outgoing));
			// REVALIDATE THE CAPTURED GENERATION after the awaited I/O. A third
			// revision can have landed while the artifacts were being written.
			// Everything already written STAYS - it is ink, and it is complete -
			// but the captured generation is not adopted and not acknowledged,
			// so the newer one is still there for the next poll to find.
			const after = await adapter.read(final).catch(() => null);
			if (after === null || contentStamp(after) !== incomingStamp) {
				return { kind: "stale", why: "a newer external revision arrived during preservation" };
			}
			return {
				kind: "prepared",
				prepared: {
					pageId,
					data: parsed.data,
					outgoingPath: pair.outgoingPath,
					incomingPath: pair.incomingPath,
					reused: pair.reused,
					// A failed stat proves nothing, and 0 is the safe value: the
					// next check finds a mismatch, compares the CONTENT stamp,
					// and settles it. It can cost one extra read; it can never
					// suppress a real change.
					mtime: st?.mtime ?? 0,
					stamp: incomingStamp,
				},
			};
		});
	}

	/**
	 * ACKNOWLEDGE a prepared adoption: this exact captured generation becomes
	 * the baseline the next save is measured against.
	 *
	 * Synchronous, and that is the whole point. The caller re-qualifies its
	 * record immediately before calling, and an await between that check and
	 * this line is precisely the gap a finished stroke lands in - which is how
	 * the in-flight-write loss worked.
	 */
	acceptExternalAdoption(prepared: PreparedExternalAdoption): void {
		this.knownMtime.set(prepared.pageId, prepared.mtime);
		this.knownHash.set(prepared.pageId, prepared.stamp);
		// The live bytes were composed by ANOTHER device, so no in-process
		// writer owns them now. A stale writer left here would let
		// reconcileInProcess skip its read and put a stale page back on disk.
		this.lastWriter.delete(prepared.pageId);
	}

	/**
	 * The pair already written for this exact outgoing/incoming revision pair,
	 * RE-PROVED against disk, or null.
	 *
	 * Repeat attempts are ordinary rather than exceptional: a preparation that
	 * goes stale, or that the record rejects because a stroke landed, comes
	 * back on the next poll with both revisions unchanged. Writing a fresh pair
	 * each time would fill the folder with identical copies. Remembering alone
	 * is not enough either - an artifact deleted or edited since is no longer
	 * evidence, and this page then gets a fresh pair rather than a claim about
	 * a file that is gone.
	 */
	private async reuseAdoptionPair(
		pageId: string,
		key: string,
		outgoingText: string,
		incomingText: string
	): Promise<{ outgoingPath: string; incomingPath: string; reused: true } | null> {
		const seen = this.preservedAdoptions.get(pageId);
		if (!seen || seen.key !== key) return null;
		const adapter = this.app.vault.adapter;
		const o = await adapter.read(seen.outgoingPath).catch(() => null);
		const i = await adapter.read(seen.incomingPath).catch(() => null);
		if (o !== outgoingText || i !== incomingText) return null;
		return { outgoingPath: seen.outgoingPath, incomingPath: seen.incomingPath, reused: true };
	}

	/**
	 * Write and verify one fresh pair of recovery artifacts beside the live
	 * file. `.conflict-` keeps both out of `isLiveSidecarName`, so nothing
	 * treats either as the page.
	 *
	 * BOTH names are probed and neither is ever overwritten: a token collision
	 * is not worth reasoning about, but a leftover artifact from an earlier
	 * attempt is ordinary and it holds ink. The probe is NOT a cross-process
	 * reservation and is not claimed to be - two processes can still probe the
	 * same free name in the same instant. The random token, not the probe, is
	 * what makes that vanishingly unlikely.
	 */
	private async writeAdoptionPair(
		pageId: string,
		final: string,
		key: string,
		outgoingText: string,
		incomingText: string,
		outgoing: PageData
	): Promise<{ outgoingPath: string; incomingPath: string; reused: false }> {
		const adapter = this.app.vault.adapter;
		const base = stripJson(final);
		let outgoingPath = "";
		let incomingPath = "";
		for (let attempt = 0; attempt < 8 && outgoingPath === ""; attempt++) {
			const token = adoptionToken();
			const o = `${base}.conflict-external-${token}-outgoing.json`;
			const i = `${base}.conflict-external-${token}-incoming.json`;
			if (await adapter.exists(o)) continue;
			if (await adapter.exists(i)) continue;
			outgoingPath = o;
			incomingPath = i;
		}
		if (outgoingPath === "") {
			throw new Error("Handwriting: could not allocate a free pair of recovery copies");
		}
		await ensureFolder(adapter, folderOf(final));
		// Either order leaves, at every instant, a complete copy of at least
		// one revision plus the untouched live file. A partial attempt's
		// artifact is kept: this slice adds no cleanup policy, because the
		// thing being cleaned up would be somebody's ink.
		await this.writeVerified(pageId, outgoingPath, outgoingText, outgoing);
		await this.writeVerified(pageId, incomingPath, incomingText);
		this.preservedAdoptions.set(pageId, { key, outgoingPath, incomingPath });
		return { outgoingPath, incomingPath, reused: false };
	}

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
	private async writeVerified(
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

	private async writePending(pageId: string): Promise<void> {
		const data = this.pending.get(pageId);
		if (!data) return;
		const writer = this.pendingWriter.get(pageId);
		// Claimed BEFORE the batch is consumed and before any await, so this
		// page is never observably quiet while its ink is only in memory - not
		// during the write, and not while this attempt waits its turn in the
		// page chain. See outstandingWrites.
		this.beginOutstandingWrite(pageId);
		try {
			this.pending.delete(pageId);
			this.pendingWriter.delete(pageId);
			this.clearTimers(pageId); // the batch is consumed, both timers with it
			// Serialize writes so two saves for the same page can't interleave
			// their tmp/rename dance.
			await this.chain(pageId, () => this.writeNow(pageId, data, writer));
		} finally {
			// Every outcome, including a throw: a leaked claim would block this
			// page's live reload for the rest of the session. A failed write
			// has already put the batch back in `pending` by now, so the guard
			// is continuous across the handover.
			this.endOutstandingWrite(pageId);
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
	private async reconcileInProcess(
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

	private async writeNow(
		pageId: string,
		data: PageData,
		writer?: PageWriter
	): Promise<void> {
		const adapter = this.app.vault.adapter;
		// The ink folder is being moved. Nothing may be written until the move
		// and the repoint are done, or it lands in the folder being emptied.
		// REQUEUE, synchronously and before any await, so the state is never
		// the queue's only copy for an instant: it goes straight back into
		// `pending` (unless something newer is already there) and the ordinary
		// retry timer brings it back. Not a failure - no retry is counted and
		// nothing is reported.
		if (this.migrating) {
			if (!this.pending.has(pageId)) {
				this.pending.set(pageId, data);
				this.pendingWriter.set(pageId, writer);
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
			// The tmp is written BEFORE any of it. The conflict rename below
			// moves the live file out of the way, and writing after that
			// meant a kill in between left no live file AND no tmp: the page
			// read as absent, and the conflict copy it had been moved to was
			// never announced, because the announcement waits on the rename
			// at the end. Writing first means every instant of this sequence
			// has a complete copy of the ink somewhere load() already looks.
			const serialized = serializePage(effective);
			await adapter.write(tmp, serialized);
			// A blind local file this page has just been taken away from is
			// preserved beside its new home before anything else touches the
			// folder - never discarded, and never left as a second live sidecar
			// in a folder nothing syncs.
			await this.absorbProvisional(pageId, final);
			if (await adapter.exists(final)) {
				const st = await adapter.stat(final).catch(() => null);
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
						const cur = await adapter.read(final).catch(() => null);
						// Unreadable-but-present errs toward preserving it.
						external = cur === null || contentStamp(cur) !== knownHash;
					}
				}
				if (external) {
					const kept = await this.freeConflictPath(final, st?.mtime ?? 0);
					await adapter.rename(final, kept);
					// NOT announced here (RC4). Everything below can still
					// throw, and the old message asserted "this session's ink
					// was saved normally" while the save had not been
					// attempted. The fact is parked until the rename lands.
					this.pendingConflict.set(pageId, kept);
				}
			}
			if (await adapter.exists(final)) await adapter.remove(final);
			await adapter.rename(tmp, final);
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
			this.knownHash.set(pageId, contentStamp(serialized));
			// Recorded only once the rename has landed, so it always names the
			// writer whose composition the live file actually holds.
			this.lastWriter.set(pageId, writer);
			this.failures.delete(pageId);
			this.errorNotified.delete(pageId);
			// The write is durable as of the rename above: now, and only now,
			// may a message speak about this session's ink.
			const kept = this.pendingConflict.get(pageId);
			if (kept !== undefined) {
				this.pendingConflict.delete(pageId);
				this.onConflict?.(pageId, kept);
			}
		} catch (err) {
			console.error("[handwriting] sidecar write failed", pageId, err);
			// A failed write is NOT durable: keep the state queued (unless a
			// newer state has already been scheduled), retry a bounded number
			// of times, then tell the user once. The data also stays in the
			// pending map, so any later schedule() or flush() retries it.
			if (!this.pending.has(pageId)) {
				this.pending.set(pageId, data);
				// Its writer with it: an unattributed retry would skip the
				// reconcile and put this writer's stale page back on disk.
				this.pendingWriter.set(pageId, writer);
			}
			const n = (this.failures.get(pageId) ?? 0) + 1;
			this.failures.set(pageId, n);
			if (n <= WRITE_MAX_RETRIES) {
				if (!this.timers.has(pageId)) {
					this.timers.set(
						pageId,
						window.setTimeout(() => {
							this.timers.delete(pageId);
							runDetached(this.writePending(pageId), `retry sidecar write ${pageId}`);
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
				this.onWriteError?.(pageId, String(err), this.pendingConflict.get(pageId));
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
	private async absorbProvisional(pageId: string, final: string): Promise<void> {
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
			this.pendingConflict.set(pageId, kept);
		} catch (err) {
			console.error("[handwriting] could not preserve a blind local sidecar", pageId, err);
		}
	}

	/**
	 * A same-mtime conflict can want the same conflict name twice. Never
	 * overwrite an earlier conflict copy; find a free sibling name instead.
	 */
	private async freeConflictPath(final: string, mtime: number): Promise<string> {
		const adapter = this.app.vault.adapter;
		const base = `${stripJson(final)}.conflict-${mtime}`;
		let candidate = `${base}.json`;
		for (let n = 2; await adapter.exists(candidate); n++) {
			candidate = `${base}-${n}.json`;
		}
		return candidate;
	}

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
	async clone(fromId: string, toId: string): Promise<"cloned" | "none" | "unreadable" | "exists"> {
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
	discardPending(pageId: string): void {
		this.pending.delete(pageId);
		this.pendingWriter.delete(pageId);
		this.clearTimers(pageId);
	}

	async remove(pageId: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		// Captured before it is dropped: a stroke scheduled inside the 700ms
		// debounce (audit-fixes-design.md 5i I1) has not reached disk yet, so
		// it is the ONE copy of itself. It is newer than whatever `final`
		// holds by construction - pending only exists because it postdates
		// the last write - so below it is what gets recycled, not the disk
		// file.
		const queued = this.pending.get(pageId);
		this.pending.delete(pageId);
		this.pendingWriter.delete(pageId);
		this.knownMtime.delete(pageId);
		this.observedMissing.delete(pageId);
		this.knownHash.delete(pageId);
		// The page is gone; a later page under this id is a different page,
		// and must not be reconciled against a writer that predates it.
		this.lastWriter.delete(pageId);
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
		const run = async (): Promise<void> => {
			// Declared out here so the scratch-file sweep below names the same
			// file the recycle did, even when the recycle threw.
			let final: string | undefined = pinned;
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
						Object.keys(queued.unknownTop).length === 0;
					if (!empty) {
						// Beside the file it replaces, so the generation and
						// the page it came from stay in one folder.
						const home = folderOf(final);
						await ensureFolder(adapter, this.trashDirIn(home));
						await adapter.write(await this.freeTrashPath(pageId, home), serializePage(queued));
					}
					// Whatever is on disk is now strictly older than the
					// generation just recycled (or discarded as empty) above -
					// not a second copy worth keeping, just gone.
					if (await adapter.exists(final)) {
						await adapter.remove(final);
					}
				} else if (await adapter.exists(final)) {
					// Recycle unless the outgoing page is PROVABLY empty.
					// Generational names (RC4) mean an empty page could no
					// longer clobber an earlier copy, but the guard stays on
					// its own merit: recycling emptiness loses nothing and
					// would only litter the trash with useless generations.
					// Anything unreadable IS recycled: damaged bytes may still
					// be recoverable.
					let empty = false;
					try {
						const parsed = parsePage(await adapter.read(final), pageId);
						empty =
							!parsed.damaged &&
							parsed.data.strokes.length === 0 &&
							parsed.data.textBoxes.length === 0 &&
							parsed.data.images.length === 0 &&
							Object.keys(parsed.data.unknownTop).length === 0;
					} catch {
						/* unreadable → recycle it */
					}
					if (empty) {
						await adapter.remove(final);
					} else {
						const home = folderOf(final);
						await ensureFolder(adapter, this.trashDirIn(home));
						// Never a name that already exists: no `remove(dest)`
						// here any more, which is exactly what used to destroy
						// the previous generation.
						await adapter.rename(final, await this.freeTrashPath(pageId, home));
					}
				}
			} catch (err) {
				console.error("[handwriting] sidecar recycle failed", pageId, err);
			}
			// The scratch file beside the page's OWN sidecar, not beside a
			// configured path the page may never have used.
			for (const p of final === undefined ? [] : [this.tmpFor(final)]) {
				try {
					if (await adapter.exists(p)) await adapter.remove(p);
				} catch (err) {
					console.error("[handwriting] sidecar remove failed", p, err);
				}
			}
		};
		await this.chain(pageId, run);
	}
}
