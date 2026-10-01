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
import { PageData, ParseResult, emptyPage } from "../model/PageData";
import type {
	ExternalAdoptionHeldReason,
	ExternalAdoptionResult,
} from "../inline/InlineInkStore";
import type { ExternalAdoptionPrep, PreparedExternalAdoption } from "../persistence/PageStore";
import { runDetached } from "../util/Detached";
import { applyOp } from "./PdfInkHistory";
import type { InkOp } from "../inline/InkHistory";
import { timerHost } from "../util/RuntimeScheduler";
import { familyOf, isPdfInkId } from "./PdfIdentity";

const EMPTY: readonly InkStroke[] = [];

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
	remove(id: string): Promise<void>;
}

interface PendingPdfDeletion {
	existingPaths: Set<string>;
	listPdfPaths: () => string[];
	familyForPath: (path: string) => Promise<string | null>;
	store: PdfClaimStore;
	timer: number;
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
	noticed: boolean;
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
		live: null,
		byPage: null,
	};
}

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

	/** No host = session-memory mode, which is how the tests run it. */
	attachHost(host: PdfInkHost): void {
		this.host = host;
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
					"Handwriting: this PDF's ink file could not be read. ink drawn on it is not saved."
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
			// and the session's are one set.
			const disk = result.data.pdfPaths ?? [];
			rec.claimedPaths = [...new Set([...disk, ...(rec.claimedPaths ?? [])])];
			// Session strokes drawn while the read was in flight come FIRST in
			// time but must not be lost to it, so the persisted set is merged
			// underneath them rather than replacing them.
			const persisted = result.data.strokes.filter((s) => typeof s.page === "number");
			materialize(rec);
			const seen = new Set(rec.strokes.map((s) => s.id));
			rec.strokes = [...persisted.filter((s) => !seen.has(s.id)), ...rec.strokes];
			rec.mutationGeneration++;
			return persisted.length > 0;
		} finally {
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
	 */
	restoreRevision(id: string, page: PageData): boolean {
		const rec = this.byId.get(id);
		if (!rec) return false;
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
		rec.mutationGeneration++;
		rec.load = "no";
		rec.strokes = [];
		rec.basePage = null;
		await this.ensureLoaded(id);
		if (rec.basePage === null) {
			// Nothing was read: damaged, future-locked, or the file is gone. Put
			// the session back. Damaged and future both leave the record locked,
			// so the file is not touched; if the file vanished, the next save
			// restores it from what is still on screen.
			rec.strokes = kept;
			return false;
		}
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
	 * The instances this session holds whose id matches, with the paths each
	 * claims - including a fresh instance whose sidecar is not on disk yet, so
	 * a byte-identical copy opened beside it is not handed the same id.
	 */
	claimedInstances(match: (id: string) => boolean): { id: string; paths: string[] }[] {
		const out: { id: string; paths: string[] }[] = [];
		for (const [id, rec] of this.byId) {
			if (match(id) && rec.claimedPaths !== null) out.push({ id, paths: [...rec.claimedPaths] });
		}
		return out;
	}

	/** A deleted claim still blocks older same-byte files during the grace. */
	pendingClaims(): ReadonlyMap<string, ReadonlySet<string>> {
		return new Map([...this.pendingDeleted].map(([path, p]) => [path, p.existingPaths]));
	}

	/**
	 * The vault has removed a PDF. Keep its claim for a sync delete+create
	 * rename, then retire it if no same-family CREATE arrives in the grace.
	 * The snapshot is taken before any await, so an older template is marked
	 * as existing even while the sidecar list is being read elsewhere.
	 */
	markDeletedPath(
		path: string,
		store: PdfClaimStore,
		listPdfPaths: () => string[],
		familyForPath: (path: string) => Promise<string | null>,
		graceMs: number
	): void {
		this.cancelPending(path);
		const pending: PendingPdfDeletion = {
			existingPaths: new Set(listPdfPaths()),
			listPdfPaths,
			familyForPath,
			store,
			timer: 0,
		};
		this.pendingDeleted.set(path, pending);
		pending.timer = timerHost().setTimeout(() => {
			runDetached(this.retireDeletedPath(path, pending), `retire PDF ink claim for ${path}`);
		}, graceMs);
	}

	/** Unload leaves a sync pair unresolved, just as the note grace timer does. */
	cancelPendingDeletes(): void {
		for (const path of this.pendingDeleted.keys()) this.cancelPending(path);
	}

	private cancelPending(path: string): void {
		const pending = this.pendingDeleted.get(path);
		if (!pending) return;
		timerHost().clearTimeout(pending.timer);
		this.pendingDeleted.delete(path);
	}

	private async retireDeletedPath(path: string, pending: PendingPdfDeletion): Promise<void> {
		if (this.pendingDeleted.get(path) !== pending) return;
		const now = pending.listPdfPaths();
		// A same-path recreation is the same claim. It needs no rewrite.
		if (now.includes(path)) { this.cancelPending(path); return; }
		const ids = new Set((await pending.store.listIds("pdf-")).filter(isPdfInkId));
		for (const id of this.byId.keys()) if (isPdfInkId(id)) ids.add(id);
		const claims = new Map<string, string[]>();
		for (const id of ids) {
			const disk = await pending.store.readPdfPaths(id);
			const held = this.byId.get(id)?.claimedPaths ?? [];
			if (disk !== null || held.length) claims.set(id, [...new Set([...(disk ?? []), ...held])]);
		}
		const freshPaths = now.filter((p) => !pending.existingPaths.has(p));
		const families = new Map<string, string | null>();
		for (const [id, paths] of claims) {
			if (!paths.includes(path)) continue;
			if (this.pendingDeleted.get(path) !== pending) return;
			let moved = false;
			for (const next of freshPaths) {
				if ([...claims].some(([other, ps]) => other !== id && ps.includes(next))) continue;
				if (!families.has(next)) {
					try { families.set(next, await pending.familyForPath(next)); }
					catch { families.set(next, null); }
				}
				if (families.get(next) !== familyOf(id)) continue;
				await this.ensureLoaded(id);
				if (this.pendingDeleted.get(path) !== pending) return;
				if (!this.inkReady(id)) break;
				this.renamePath(id, path, next);
				claims.set(id, paths.filter((p) => p !== path).concat(next));
				moved = true;
				break;
			}
			if (moved) continue;
			await this.ensureLoaded(id);
			if (this.pendingDeleted.get(path) !== pending) return;
			if (!this.inkReady(id)) continue; // unreadable or future sidecar: leave it alone
			const rec = this.record(id);
			const left = (rec.claimedPaths ?? paths).filter((p) => p !== path);
			if (left.length === 0) {
				await pending.store.remove(id); // never leave [] for legacy adoption
				this.byId.delete(id);
			} else {
				rec.claimedPaths = left;
				rec.mutationGeneration++;
				this.persist(id, rec);
			}
		}
		if (this.pendingDeleted.get(path) === pending) this.cancelPending(path);
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
			return adoptionHeld("io-failure");
		}
		if (prep.kind === "unavailable") return adoptionHeld("preservation-unavailable");
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
		if (rec.unreadableLocked || rec.futureLocked) return; // already noticed
		if (rec.loadInFlight) {
			// The sidecar is still being read. A snapshot now would hold only
			// this session's strokes and, written, replace the persisted ones.
			// Persist again once the merge has happened; every mutation path
			// arrives here, so nothing is dropped by waiting.
			runDetached(
				rec.loadInFlight.then(() => this.persist(id, rec)),
				`persist pdf ink after loading ${id}`
			);
			return;
		}
		const page = this.snapshot(id, rec);
		if (page) this.host.schedule(id, page);
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
	 * as before, so merely opening a PDF still writes nothing.
	 */
	claimPath(id: string, path: string): void {
		const rec = this.record(id);
		if (rec.claimedPaths?.includes(path)) { this.cancelPending(path); return; }
		const moved = rec.claimedPaths?.find((old) => {
			const pending = this.pendingDeleted.get(old);
			return pending && !pending.existingPaths.has(path);
		});
		if (moved) { this.renamePath(id, moved, path); return; }
		rec.claimedPaths = [...(rec.claimedPaths ?? []), path];
		rec.mutationGeneration++;
		if (rec.basePage !== null || strokeCount(rec) > 0) this.persist(id, rec);
	}

	/** The file moved: its old claim is a lie now, the new one replaces it. */
	renamePath(id: string, oldPath: string, newPath: string): void {
		this.cancelPending(oldPath);
		const rec = this.record(id);
		const kept = (rec.claimedPaths ?? []).filter((p) => p !== oldPath && p !== newPath);
		rec.claimedPaths = [...kept, newPath];
		rec.mutationGeneration++;
		if (rec.basePage !== null || strokeCount(rec) > 0) this.persist(id, rec);
	}

	private noteOnce(rec: PdfRecord, message: string): void {
		if (rec.noticed || !this.host) return;
		rec.noticed = true;
		this.host.notice(message);
	}
}
