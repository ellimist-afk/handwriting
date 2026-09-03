import { normalizePath } from "obsidian";
import { DEFAULT_INK_FOLDER, SYNCED_INK_FOLDER, ensureFolder } from "./InkFolder";
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
 * Maximum dirty interval, anchored to the FIRST unsaved change of a batch and
 * never re-armed by later ones. The quiet-period debounce alone restarted on
 * every stroke, so a stroke every few hundred ms deferred the write
 * indefinitely (persistence gate, 2026-08-22).
 */
export const MAX_DIRTY_MS = 5000;

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
	/** Stamp of the content this session last read or wrote (see contentStamp). */
	private knownHash = new Map<string, string>();
	private failures = new Map<string, number>();
	private errorNotified = new Set<string>();
	/** Pages whose change-check has already reported a read failure once. */
	private changeCheckLogged = new Set<string>();
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

	constructor(
		private app: PageStoreHost,
		private folder = ".handwriting",
		/** Injectable clock so trash-generation naming is testable. */
		private now: () => number = Date.now
	) {}

	/**
	 * The sidecar path for `pageId` - and the base every other name here is
	 * built from (tmp, trash, damaged, conflict).
	 *
	 * The assert is the last line, not the first: `isSafePageId` runs at both
	 * frontmatter ingress points and inside `parsePage`, so an id reaching
	 * here unsafe means one of those was bypassed. Throwing keeps the bug
	 * inside the store's own error handling - `load` reports damage, `writeNow`
	 * retries and then tells the user - rather than letting an interpolated
	 * `..` walk out of the ink folder and write there.
	 */
	path(pageId: string): string {
		if (!isSafePageId(pageId)) {
			throw new Error(`Handwriting: refusing to build a sidecar path for ${JSON.stringify(pageId)}`);
		}
		return normalizePath(`${this.folder}/${pageId}.json`);
	}

	/**
	 * Every sidecar id in the folder starting with `prefix` - the instance
	 * enumeration behind pdf identity. Conflict, damaged and tmp artifacts
	 * are not sidecars and are not listed. An adapter without list() (test
	 * doubles, an exotic platform) yields none, which degrades resolution
	 * to "first instance" rather than failing anything.
	 */
	async listIds(prefix: string): Promise<string[]> {
		const adapter = this.app.vault.adapter;
		if (typeof adapter.list !== "function") return [];
		try {
			const l = await adapter.list(this.folder);
			return l.files
				.map((f) => f.split("/").pop() ?? "")
				.filter(
					(n) =>
						n.startsWith(prefix) &&
						n.endsWith(".json") &&
						!n.includes(".conflict-") &&
						!n.includes(".damaged-")
				)
				.map((n) => n.slice(0, -".json".length));
		} catch {
			return [];
		}
	}

	/** Where sidecars are being kept right now. */
	inkFolder(): string {
		return this.folder;
	}

	/**
	 * Point the store at a different folder. Writes go here from now on.
	 *
	 * Reads keep a fallback (see `readPath`), which is what makes a folder
	 * change safe to interrupt: a move that half-finished, or a settings save
	 * that never landed, leaves pages readable from wherever they actually
	 * are instead of invisible.
	 */
	useInkFolder(folder: string): void {
		this.folder = folder;
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
	private async readPath(pageId: string): Promise<string> {
		const primary = this.path(pageId);
		const others = [DEFAULT_INK_FOLDER, SYNCED_INK_FOLDER].filter((f) => f !== this.folder);
		if (others.length === 0) return primary;
		const adapter = this.app.vault.adapter;
		if (await adapter.exists(primary)) return primary;
		for (const folder of others) {
			const fallback = normalizePath(`${folder}/${pageId}.json`);
			if (await adapter.exists(fallback)) return fallback;
		}
		return primary;
	}

	private tmpPath(pageId: string): string {
		return `${this.path(pageId)}.tmp`;
	}

	private trashDir(): string {
		return normalizePath(`${this.folder}/trash`);
	}

	/**
	 * A never-taken name for the next trash generation (RC4).
	 *
	 * Before RC4 the trash held ONE slot per page id, so a second "delete all
	 * ink", or a delete-all followed by a note delete, silently overwrote the
	 * first recovery copy. Generations are stamped with the wall clock and
	 * disambiguated with a counter, because two destructions inside the same
	 * millisecond are entirely possible (and are exercised by the tests).
	 * Every candidate is probed, so an existing file is never the destination.
	 */
	private async freeTrashPath(pageId: string): Promise<string> {
		const adapter = this.app.vault.adapter;
		const base = `${this.trashDir()}/${pageId}-${this.now()}`;
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
		return this.pending.size > 0 || this.timers.size > 0 || this.maxTimers.size > 0;
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
		return this.pending.has(pageId) || this.timers.has(pageId) || this.maxTimers.has(pageId);
	}

	/**
	 * Cheap poll primitive for live reload: has the sidecar on disk changed
	 * behind our back? One stat on the fast path; a read only when the mtime
	 * moved (sync tools preserve mtimes, so the content stamp decides).
	 * Never answers while a write for this page is queued - a half-landed
	 * save of our own must not read as an external edit - and never for a
	 * page this store has not read or written (nothing to compare against).
	 * The write-path conflict guard stays the last word either way.
	 *
	 * See hasQueuedWrite above for why a caller must re-ask synchronously.
	 */
	async externallyChanged(pageId: string): Promise<boolean> {
		if (this.hasQueuedWrite(pageId)) return false;
		const known = this.knownMtime.get(pageId);
		if (known === undefined) return false;
		const adapter = this.app.vault.adapter;
		let changed: boolean;
		try {
			// The file this session would READ, not the one it would write.
			// Watching only the configured folder meant a page being served
			// from the other one never appeared to change, so live reload
			// silently stopped for exactly the vaults the fallback exists for.
			const watched = await this.readPath(pageId);
			const st = await adapter.stat(watched).catch(() => null);
			if (!st || st.mtime === known) {
				changed = false;
			} else {
				const stamp = contentStamp(await adapter.read(watched));
				if (stamp === this.knownHash.get(pageId)) {
					// mtime churn without content change (a sync tool touching
					// the file): remember it so the next poll stays one stat.
					this.knownMtime.set(pageId, st.mtime);
					changed = false;
				} else {
					changed = true;
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
			return false;
		}
		// Cleared on ANY completed check, not just one that found a change.
		// Clearing only on `true` left a page that failed, recovered, and then
		// simply never changed again holding the latch forever - so a genuinely
		// new failure later would say nothing, which is the exact silence this
		// latch exists to break.
		this.changeCheckLogged.delete(pageId);
		return changed;
	}

	async load(pageId: string): Promise<ParseResult | null> {
		const adapter = this.app.vault.adapter;
		try {
			// Not `path()` alone: a page can still be sitting in the default
			// folder if a folder change was interrupted. See readPath. Inside
			// the try because readPath builds paths, and path() asserts.
			const final = await this.readPath(pageId);
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
					return result;
				}
				// The main file is corrupt. Exactly one recovery case: its own
				// interrupted save is a complete, current-format page for this
				// id. Anything less keeps the read-only lock.
				return (
					(await this.promoteTmpOverDamaged(pageId, st?.mtime ?? 0, contentStamp(text))) ??
					result
				);
			}
			const tmp = this.tmpPath(pageId);
			if (await adapter.exists(tmp)) {
				const text = await adapter.read(tmp);
				const result = parsePage(text, pageId);
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
						await adapter.rename(tmp, this.path(pageId));
						const st = await adapter.stat(this.path(pageId)).catch(() => null);
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
		return await this.restoreFromTrash(pageId);
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
	 */
	private async restoreFromTrash(pageId: string): Promise<ParseResult | null> {
		const adapter = this.app.vault.adapter;
		if (typeof adapter.list !== "function") return null;
		let files: string[];
		try {
			files = (await adapter.list(this.trashDir())).files;
		} catch {
			return null; // no trash folder yet, or it cannot be enumerated
		}
		const prefix = `${pageId}-`;
		const candidates = files
			.filter((f) => {
				const name = f.split("/").pop() ?? "";
				return name.startsWith(prefix) && name.endsWith(".json");
			})
			// Newest first. The names carry a wall-clock stamp and a counter,
			// so lexical order is wrong once the counter reaches two digits;
			// the generations are few, so this compares the numbers.
			.sort((a, b) => generationOf(b, prefix) - generationOf(a, prefix));
		for (const file of candidates) {
			let text: string;
			try {
				text = await adapter.read(file);
			} catch {
				continue;
			}
			const parsed = parsePage(text, pageId);
			if (parsed.damaged || parsed.data.pageId !== pageId) continue;
			const final = this.path(pageId);
			try {
				await ensureFolder(adapter, this.folder);
				await adapter.rename(file, final);
			} catch (err) {
				// The ink is still in the trash and still readable; returning
				// it un-restored is better than failing the load.
				console.error("[handwriting] could not restore recycled ink", pageId, err);
				return { ...parsed, recovered: true, problem: "recovered from the ink trash" };
			}
			const st = await adapter.stat(final).catch(() => null);
			if (st) this.knownMtime.set(pageId, st.mtime);
			this.knownHash.set(pageId, contentStamp(text));
			this.onRecovered?.(pageId, final);
			return { ...parsed, recovered: true, problem: "restored from the ink trash" };
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
		damagedMtime: number,
		damagedStamp: string
	): Promise<ParseResult | null> {
		const adapter = this.app.vault.adapter;
		const final = this.path(pageId);
		const tmp = this.tmpPath(pageId);

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
			const keptAs = await this.freeDamagedPath(pageId, damagedMtime);
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
	private async freeDamagedPath(pageId: string, mtime: number): Promise<string> {
		const adapter = this.app.vault.adapter;
		const base = normalizePath(`${this.folder}/${pageId}.damaged-${mtime}`);
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
			const tmp = this.tmpPath(pageId);
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
			// The flush itself failed (writeNow re-queued the state): the
			// copy below would then preserve a STALE file while the caller
			// tells the user it holds today's ink. Refuse instead. The caller
			// aborts the wipe, and nothing is lost.
			throw new Error("Handwriting: the newest ink could not be written to disk");
		}
		const adapter = this.app.vault.adapter;
		let dest: string | null = null;
		const run = async (): Promise<void> => {
			// readPath, like load: the page may be sitting in the other
			// well-known folder (an interrupted migration, or a device that
			// lost data.json). Preserving only what the CONFIGURED folder
			// holds meant the safety copy silently covered nothing, right
			// before the caller wiped the note.
			const final = await this.readPath(pageId);
			if (!(await adapter.exists(final))) return;
			const trashDir = this.trashDir();
			await ensureFolder(adapter, trashDir);
			const text = await adapter.read(final);
			const to = await this.freeTrashPath(pageId);
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

	private async writePending(pageId: string): Promise<void> {
		const data = this.pending.get(pageId);
		if (!data) return;
		const writer = this.pendingWriter.get(pageId);
		this.pending.delete(pageId);
		this.pendingWriter.delete(pageId);
		this.clearTimers(pageId); // the batch is consumed, both timers with it
		// Serialize writes so two saves for the same page can't interleave
		// their tmp/rename dance.
		await this.chain(pageId, () => this.writeNow(pageId, data, writer));
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
		try {
			await ensureFolder(adapter, this.folder);
			const final = this.path(pageId);
			const tmp = this.tmpPath(pageId);
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
			if (await adapter.exists(final)) {
				const st = await adapter.stat(final).catch(() => null);
				const known = this.knownMtime.get(pageId);
				let external = st !== null && st.mtime !== known;
				if (!external && st !== null) {
					const knownHash = this.knownHash.get(pageId);
					if (knownHash !== undefined) {
						const cur = await adapter.read(final).catch(() => null);
						// Unreadable-but-present errs toward preserving it.
						external = cur === null || contentStamp(cur) !== knownHash;
					}
				}
				if (external) {
					const kept = await this.freeConflictPath(pageId, st?.mtime ?? 0);
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
	 * A same-mtime conflict can want the same conflict name twice. Never
	 * overwrite an earlier conflict copy; find a free sibling name instead.
	 */
	private async freeConflictPath(pageId: string, mtime: number): Promise<string> {
		const adapter = this.app.vault.adapter;
		const base = normalizePath(`${this.folder}/${pageId}.conflict-${mtime}`);
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
	 */
	async clone(fromId: string, toId: string): Promise<"cloned" | "none" | "unreadable" | "exists"> {
		const adapter = this.app.vault.adapter;
		let result: "cloned" | "none" | "unreadable" | "exists" = "none";
		const run = async (): Promise<void> => {
			// The SOURCE is wherever the page actually is; the destination is
			// always the configured folder, because that is where writes go.
			const src = await this.readPath(fromId);
			if (!(await adapter.exists(src))) {
				result = "none";
				return;
			}
			const dest = this.path(toId);
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
			await ensureFolder(adapter, this.folder);
			const tmp = this.tmpPath(toId);
			await adapter.write(tmp, out);
			await adapter.rename(tmp, dest);
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
		this.knownHash.delete(pageId);
		// The page is gone; a later page under this id is a different page,
		// and must not be reconciled against a writer that predates it.
		this.lastWriter.delete(pageId);
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
			try {
				// Wherever the page actually is, like load. Recycling only
				// what the configured folder holds left the real sidecar
				// behind for a vault mid-migration, so a deleted note's ink
				// stayed live under an id nothing carries any more.
				const final = await this.readPath(pageId);
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
						const trashDir = this.trashDir();
						await ensureFolder(adapter, trashDir);
						await adapter.write(await this.freeTrashPath(pageId), serializePage(queued));
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
						const trashDir = this.trashDir();
						await ensureFolder(adapter, trashDir);
						// Never a name that already exists: no `remove(dest)`
						// here any more, which is exactly what used to destroy
						// the previous generation.
						await adapter.rename(final, await this.freeTrashPath(pageId));
					}
				}
			} catch (err) {
				console.error("[handwriting] sidecar recycle failed", pageId, err);
			}
			for (const p of [this.tmpPath(pageId)]) {
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
