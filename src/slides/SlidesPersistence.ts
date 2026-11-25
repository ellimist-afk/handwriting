/**
 * The slides surface's load and persistence methods: the first read of the note's sidecar, adopting and remapping its
 * slides onto the deck, the reload a quiet deck takes when the file changes outside, the save and the notices that
 * belong to it. They are methods of SlidesDeck, installed on its prototype when SlidesInkSurface.ts loads.
 */
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import type { InkStroke } from "../ink/Stroke";
import { emptyPage, type PageData } from "../model/PageData";
import type { LoadResult } from "../persistence/PageStore";
import {
	deckSectionText,
	keptSlides,
	normaliseSectionText,
	noteMatchesDeck,
	pageOfSlide,
	remapSlides,
	remapStrokes,
	renderedNoteText,
	sectionHash,
	slideOfPage,
	slidesSidecarId,
	splitSlideSections,
	type StoredSlide,
} from "./SlidesSections";
import { installMethods } from "../inline/InstallMethods";
import { log, type SlidesDeck } from "./SlidesInkSurface";

declare module "./SlidesInkSurface" {
	interface SlidesDeck {
		startInitialLoad(): Promise<void>;
		loadSidecar(): Promise<void>;
		finishLoad(): void;
		adoptSidecar(sidecarId: string, replaceAdopted?: boolean, keepErased?: boolean, noFile?: () => void): Promise<{ remapped: number; hashesChanged: number } | null>;
		noteMemoryOnly(why: string, plain?: string): void;
		persist(): void;
		snapshot(): PageData | null;
		save(immediate: boolean): void;
		noticeSaveFailure(): void;
		noticeReadOnly(message: string): void;
		noticeTransient(): void;
		stale(): boolean;
		inFlightWork(): Promise<unknown>[];
		reloadCandidateSidecarId(): string | null;
		reloadExternal(sidecarId: string): Promise<boolean>;
		strokeFingerprint(): string;
		noteIdChanged(path: string, wasLocked: boolean, known?: string, keepHeld?: boolean, slidesTaken?: boolean): void;
		followPageId(pageId: string): void;
		carryOwnStrokes(pageId?: string, dropAll?: boolean): void;
		handOverInk(sidecarId: string, landed: boolean): void;
		receiveInk(ink: HandedInk): void;
		takeHandedInk(): boolean;
		liftHeld(): boolean;
		readOwedLift(): Promise<void>;
	}
}

/**
 * What a closed deck's drain hands the live deck on the same sidecar once its write has landed or been refused: the
 * ink it holds that the live deck's read may have missed, and the file ink it erased. `landed` is whether that ink is
 * in the file now.
 */
export interface HandedInk {
	sidecarId: string;
	strokes: InkStroke[];
	dropped: string[];
	landed: boolean;
}

/** Hand-overs a deck has been sent and not yet taken: it was still reading, or not yet on the sidecar's id. */
const handedInk = new WeakMap<SlidesDeck, HandedInk[]>();

/**
 * The strokes a deck last read from its Slides file or last handed to a save, by id: what it takes the file to hold. A
 * stroke here the deck no longer holds is a cut or erase not yet handed to a save, as a locked deck's are.
 */
const syncedInk = new WeakMap<SlidesDeck, Map<string, InkStroke>>();

/** The last read's drop: strokes the deck changed that the file no longer holds, and where each one's first remain sat. */
const lastDrop = new WeakMap<SlidesDeck, { gone: InkStroke[]; anchors: Map<string, number> }>();

/**
 * A lift whose read has not landed (in flight, failed or put off): the next read that lands orders the deck and saves
 * it as the lift would. A read that throws meanwhile holds the deck's writes and tells the reader once when ink drawn
 * here is not in the file yet; a close reads once more before giving up.
 */
const liftOwed = new WeakSet<SlidesDeck>();

/**
 * A deck that has given the words a lift's read owes it (a damaged or newer-format file under ink drawn while locked).
 * Their own once-flag: the lock's notice spends `readOnlyNoticed` before the lift, and must not spend these.
 */
const liftNoticed = new WeakSet<SlidesDeck>();

/**
 * A duplicate lock stood on the deck's note and lifted (slidesLockLifted), and no read since the lift has landed. With a
 * lock standing at a read's start, it is what arms a read to keep a stroke this deck saved that the file lacks
 * (keepSaved). A deck no lock stood on is never armed: the word for a note left on its id (liftOwed) arms nothing.
 */
const lockStood = new WeakSet<SlidesDeck>();

/** Ids of the strokes this deck drew or cut and handed to a save (not read from the file), for the deck's life. */
const savedHere = new WeakMap<SlidesDeck, Set<string>>();

/**
 * Ids in savedHere that a read took off the deck (another side's erase or cut, read in), not the deck's own act. Filled
 * by difference at each read's merge; an id leaves once the deck holds it again or a save holds it.
 */
const readTook = new WeakMap<SlidesDeck, Set<string>>();

/** A deck whose close has read once for its lift: liftHeld then asks only for ink the file never had. */
const closeReadTried = new WeakSet<SlidesDeck>();

/** The words a lift's read owes a deck holding ink drawn while locked, once a deck. */
function noticeLift(deck: SlidesDeck, message: string): void {
	if (liftNoticed.has(deck)) return;
	liftNoticed.add(deck);
	deck.host.notify(message);
}

/** Does the deck hold ink the file does not have: a stroke not read or saved, or a read or saved stroke it no longer holds? */
function holdsUnsaved(deck: SlidesDeck): boolean {
	const synced = syncedInk.get(deck);
	let held = 0;
	for (const list of deck.strokes.values()) {
		for (const s of list) {
			if (!synced?.has(s.id)) return true;
			held++;
		}
	}
	return synced !== undefined && held !== synced.size;
}

/**
 * Does the deck still hold a stroke it drew or cut and handed to a save? Read back since or not, the file a later read
 * finds may lack it, and an armed read keeps it.
 */
function holdsSavedHere(deck: SlidesDeck): boolean {
	const saved = savedHere.get(deck);
	if (!saved || saved.size === 0) return false;
	for (const list of deck.strokes.values()) for (const s of list) if (saved.has(s.id)) return true;
	return false;
}

/**
 * An armed read (a lock stood on the deck's note): a stroke the deck drew or cut and saved, still on the deck, that
 * the file lacks stays the deck's once, and the lift saves it. Where a file stroke the deck does not hold is a piece of
 * it, moved or not, the other side cut it: it leaves the deck, adopted or not, so its line is not drawn twice. Called
 * after the read's persisted ids are counted as adopted and before adopted ink is replaced.
 */
function keepSaved(deck: SlidesDeck, held: ReadonlySet<string>, file: readonly InkStroke[]): void {
	const saved = savedHere.get(deck);
	if (!saved || saved.size === 0) return;
	const fileIds = new Set(file.map((s) => s.id));
	const others = file.filter((r) => !held.has(r.id) && !saved.has(r.id));
	let kept = 0;
	let cut = 0;
	for (const list of deck.strokes.values()) {
		for (const s of list) {
			if (!saved.has(s.id) || fileIds.has(s.id)) continue;
			if (others.some((r) => pieceOf(r, s) || movedPieceOf(r, s))) {
				deck.adoptedIds.add(s.id);
				cut++;
			} else if (deck.adoptedIds.delete(s.id)) kept++;
		}
	}
	if (kept > 0) deck.dirty = true;
	if (kept + cut > 0) log(`lift read: ${kept} stroke(s) saved here and missing from the file kept, ${cut} cut by the other side left out`);
}

/**
 * An armed read: a stroke the deck drew or cut and saved, that the deck no longer holds and no read took off it, left by
 * the deck's own act (its eraser, whole or cut, an undo or redo, a clear). The file's copy is not taken back: the id goes
 * with the strokes the deck erased (`erased`), and stays out of later reads as they do. Called after keepSaved and
 * before adopted ink is replaced.
 */
function keepOwnRemovals(deck: SlidesDeck, held: ReadonlySet<string>, file: readonly InkStroke[], erased: Set<string>): void {
	const saved = savedHere.get(deck);
	if (!saved || saved.size === 0) return;
	const took = readTook.get(deck);
	const fileIds = new Set(file.map((s) => s.id));
	let left = 0;
	for (const id of saved) {
		if (held.has(id) || took?.has(id) || !fileIds.has(id) || erased.has(id)) continue;
		erased.add(id);
		deck.adoptedIds.add(id);
		left++;
	}
	if (left > 0) log(`lift read: ${left} stroke(s) saved here and taken off the deck here left out`);
}

/** After a read's merge: strokes saved here that it took off the deck, and those it put back. */
function noteReadTook(deck: SlidesDeck, held: ReadonlySet<string>): void {
	const saved = savedHere.get(deck);
	if (!saved || saved.size === 0) return;
	const now = new Set<string>();
	for (const list of deck.strokes.values()) for (const s of list) now.add(s.id);
	const took = readTook.get(deck) ?? new Set<string>();
	for (const id of saved) {
		if (now.has(id)) took.delete(id);
		else if (held.has(id)) took.add(id);
	}
	readTook.set(deck, took);
}

/** Where the live deck is found. SlidesController.ts, which holds it, sets this when it loads. */
let liveDeck: () => SlidesDeck | null = () => null;

export function setSlidesLiveDeck(source: () => SlidesDeck | null): void {
	liveDeck = source;
}

/**
 * The id code changed what the note at `path` carries, or lifted its duplicate lock: a copy was given a fresh id, its
 * id line was deleted, or the other carrier went away. The live deck for that note follows at the same moment inline
 * ink does. `wasLocked` is whether the note was duplicate-locked just before the change. `pageId`, when the caller
 * has just written it, is the note's new id: the metadata cache may still answer with the old text for a moment.
 * `keepHeld` false: the old id's Slides file did not become the new id's live file (it was set aside beside a file the
 * new id already had, or it is another note's), so the strokes the deck holds from it leave the deck.
 * `slidesTaken`: the note was left alone on its id because another note's id edit moved that id's Slides file away in
 * this session; a clean deck whose lift read then finds no file saves what it shows under the id, once. Handed on only
 * when true: every other word reaches the deck as before.
 */
export function slidesNoteIdChanged(path: string, wasLocked = false, pageId?: string, keepHeld = true, slidesTaken = false): void {
	const deck = liveDeck();
	if (slidesTaken) deck?.noteIdChanged(path, wasLocked, pageId, keepHeld, true);
	else deck?.noteIdChanged(path, wasLocked, pageId, keepHeld);
}

/**
 * The duplicate lock on the note at `path` stood and was just cleared. Sent before slidesNoteIdChanged, and only when
 * the note was locked just before the clear. The deck on that note keeps, at the first read that lands after this, the
 * strokes it saved that the file lacks, unless the file holds a piece of one.
 */
export function slidesLockLifted(path: string): void {
	const decks = new Set<SlidesDeck>(pathDecks);
	const live = liveDeck();
	if (live) decks.add(live);
	for (const deck of decks) if (!deck.stale() && deck.path === path) lockStood.add(deck);
}

/**
 * Does an open presentation hold the Slides page `sidecarId`: the live deck or a closed one still draining on it, or one
 * loading or claiming on the note that carries its page id? Such a deck keeps the page and its next save writes it back.
 */
export function slidesDeckHolds(sidecarId: string): boolean {
	const decks = new Set<SlidesDeck>(pathDecks);
	const live = liveDeck();
	if (live) decks.add(live);
	for (const deck of decks) {
		if (deck.stale()) continue;
		if (deck.sidecarId === sidecarId) return true;
		if ((!deck.loadInFlight && !deck.claimInFlight) || !deck.path) continue;
		const pageId = deck.host.readPageId(deck.path);
		if (pageId && slidesSidecarId(pageId) === sidecarId) return true;
	}
	return false;
}

/**
 * Decks that may still ask a question by their note's path: the live one, and a closed one whose drain is still running.
 * A rename or a delete reaches each (slidesNoteRenamed, slidesNoteLeft). A deck that is gone leaves at the next event.
 */
const pathDecks = new Set<SlidesDeck>();

/**
 * The renames a deck has seen, in order, the newest few. A read that awaited with a path in hand follows it through the
 * renames made since (followPath), or it would go on asking for the note at its old name.
 */
const pathMoves = new WeakMap<SlidesDeck, Array<{ seq: number; from: string; to: string }>>();
const PATH_MOVES_KEPT = 32;
let moveSeq = 0;

/**
 * A deck whose note was duplicate-locked when it left its path with no rename (deleted, deleted and made again by a sync,
 * renamed away from Markdown), and the other note's name for the notice. Held as locked: a lock record missing at the
 * deck's path is never a lift. Only the id route's word for the deck's own note lifts it (noteIdChanged). Following a
 * note made again at another path is not done: the deck holds instead, as the lock's notice already says.
 */
const leftLocked = new WeakMap<SlidesDeck, string>();

function trackPath(deck: SlidesDeck): void {
	for (const d of pathDecks) if (d.stale()) pathDecks.delete(d);
	pathDecks.add(deck);
}

/** `path` as it is now, after the renames this deck has seen since `since`. */
function followPath(deck: SlidesDeck, path: string, since: number): string {
	for (const m of pathMoves.get(deck) ?? []) if (m.seq > since && m.from === path) path = m.to;
	return path;
}

/** The other note the deck's own note shares its page id with, or null: the lock as it stands at `path`, or a held leave. */
function lockedWith(deck: SlidesDeck, path: string | null): string | null {
	const left = leftLocked.get(deck);
	if (left !== undefined) return left;
	return path ? (deck.host.duplicateLockedWith?.(path) ?? null) : null;
}

/**
 * The vault renamed or moved a note (the rename hook, after inline ink has moved its record). A deck on that note asks
 * every question by path (the lock, the first stroke's claim, the id route) for the note where it is now. A deck on any
 * other note is not changed.
 */
export function slidesNoteRenamed(oldPath: string, newPath: string): void {
	const seq = ++moveSeq;
	for (const deck of [...pathDecks]) {
		if (deck.stale()) {
			pathDecks.delete(deck);
			continue;
		}
		const moves = pathMoves.get(deck) ?? [];
		moves.push({ seq, from: oldPath, to: newPath });
		if (moves.length > PATH_MOVES_KEPT) moves.shift();
		pathMoves.set(deck, moves);
		if (deck.path !== oldPath) continue;
		deck.path = newPath;
		log(`note renamed: ${oldPath} is now ${newPath}; the presentation asks for it there`);
	}
}

/**
 * A note left its path with no rename: deleted, or renamed away from Markdown. Called before inline ink drops the note's
 * record, while its lock still answers. A deck on a locked note stays held (leftLocked); on an unlocked note nothing
 * changes, so a sync's delete then create keeps saving under the note's id as it does today.
 */
export function slidesNoteLeft(path: string): void {
	for (const deck of [...pathDecks]) {
		if (deck.stale()) {
			pathDecks.delete(deck);
			continue;
		}
		if (deck.path !== path || leftLocked.has(deck)) continue;
		const other = deck.host.duplicateLockedWith?.(path) ?? null;
		if (other === null) continue;
		leftLocked.set(deck, other);
		log(`note left ${path} while it shared its page id with ${other}: the presentation's ink stays held`);
	}
}

/** How long a deck held on a thrown first read stays silent while reads keep throwing (the note surface's bound). */
const TRANSIENT_SILENCE_MS = 60_000;
const TRANSIENT_NOTICE =
	"Handwriting: this presentation's ink file could not be read yet. New ink on it is not saved until it loads.";
const TRANSIENT_HEALED =
	"Handwriting: this presentation's ink file is readable again. The saved ink is restored and saving is back on.";
const TRANSIENT_GONE =
	"Handwriting: this presentation's ink file is gone. The presentation starts fresh, and saving is back on.";
/** Word for word the notice inline ink gives the same two notes (InlineInkStorePersist.markDuplicateLocked). */
const duplicateNotice = (otherPath: string): string =>
	`Handwriting: this note and "${otherPath}" carry the same handwriting-page-id, so they point at the same ink file. Ink on both is read-only until that is resolved. Delete the handwriting-page-id line from the copy (its next stroke gets a fresh id), or delete one of the notes.`;

	/** Track one initial-load attempt, retaining failures for a later public retry. */
	function startInitialLoad(this: SlidesDeck): Promise<void> {
		if (this.loadInFlight) return this.loadInFlight;
		this.initialLoadFailed = false;
		const loading = this.loadSidecar()
			.catch((err) => {
				log(`sidecar load failed: ${String(err)}`);
				if (!this.loaded) {
					this.initialLoadFailed = true;
					if (this.saveAfterLoad || this.dirty) this.noticeSaveFailure();
				}
			})
			.finally(() => {
				if (this.loadInFlight === loading) this.loadInFlight = null;
				this.actionsChanged();
			});
		this.loadInFlight = loading;
		return loading;
	}

	/**
	 * Section hashes first, then the sidecar, then the remap.
	 *
	 * In that order because the remap needs both, and because the hashes are
	 * worth computing even when there is no sidecar: they are what the FIRST
	 * save writes, and without them the first presentation's ink would come
	 * back with no identity but its index.
	 */
	async function loadSidecar(this: SlidesDeck): Promise<void> {
		// From here a rename reaches this deck, and a path held across an await below is followed through it.
		trackPath(this);
		const since = moveSeq;
		let path = this.path;
		let sections: string[] | null = null;
		if (this.host.candidatePaths) {
			const deckTexts = this.sections().map(s => deckSectionText(s));
			for (const candidate of new Set(this.host.candidatePaths())) {
				if (!candidate) continue;
				try {
					const source = await this.host.readSource(candidate);
					if (this.stale()) return;
					if (source === null) continue;
					const parsed = splitSlideSections(source);
					if (!noteMatchesDeck(parsed, deckTexts)) continue;
					path = followPath(this, candidate, since);
					sections = parsed;
					break;
				} catch (err) {
					log(`could not read ${candidate} for slide identity: ${String(err)}`);
				}
			}
			if (!path) {
				this.noteMismatch = true;
				this.noteMemoryOnly("no candidate note matches the deck on screen");
				this.finishLoad();
				return;
			}
			this.path = path;
			if (diagnosticsEnabled()) log(`file resolved: ${path}`);
		}
		if (!path) {
			this.noteMemoryOnly(
				"no active file when the presentation opened",
				"the note it belongs to could not be identified"
			);
			this.finishLoad();
			return;
		}
		if (!this.host.candidatePaths) {
			try {
				const source = await this.host.readSource(path);
				if (source !== null) sections = splitSlideSections(source);
				else this.sourceUncertain = true;
			} catch (err) {
				// A note we cannot read still takes ink; it just keeps its slides
				// by index alone until the next presentation reads it.
				this.sourceUncertain = true;
				log(`could not read ${path} for section hashes: ${String(err)}`);
			}
			// Renamed during that read: the id below is read from the note where it is now.
			path = followPath(this, path, since);
		}
		if (this.stale()) return;
		if (sections) {
			// §3.5: the note was a guess until here. Everything downstream of
			// this line writes Markdown or a sidecar keyed off it, so the guess
			// is checked BEFORE the first claim rather than after the wrong note
			// has been stamped.
			// Without the rendered frontmatter: Obsidian puts the note's own
			// properties into the FIRST slide's group, and every note that has
			// been inked carries `handwriting-page-id` there.
			const deckTexts = this.sections().map((s) => deckSectionText(s));
			if (!noteMatchesDeck(sections, deckTexts)) {
				// The counts alone never said WHICH side was wrong. The two
				// fingerprints do, and this runs once per presentation.
				const noteHead = normaliseSectionText(renderedNoteText(sections[0] ?? "")).slice(0, 40);
				const deckHead = normaliseSectionText(deckTexts[0] ?? "").slice(0, 40);
				log(
					`note check failed: ${path}, deck ${deckTexts.length} sections vs ` +
						`note ${sections.length}; ink kept in memory; ` +
						`note "${noteHead}" vs deck "${deckHead}"`
				);
				this.noteMismatch = true;
				this.noteMemoryOnly("the resolved note does not match the deck on screen");
				// No load either: the sidecar under that note's id is some other
				// presentation's ink and painting it here would be the same
				// mistake in the other direction.
				this.finishLoad();
				return;
			}
			this.hashes = sections.map(sectionHash);
		}
		const pageId = this.host.readPageId(path);
		if (!pageId) {
			// Unclaimed. Nothing to load - the first stroke claims - and that
			// is not a failure, it is a note nobody has drawn on yet.
			if (diagnosticsEnabled()) log(`sidecar loaded: none (${path} carries no page id yet)`);
			this.finishLoad();
			return;
		}
		// A LOCAL, not the field: `this.sidecarId` is what `persist()` writes
		// through, and publishing it before the store has answered is what let
		// a stroke drawn in the load window overwrite the whole sidecar.
		const sidecarId = slidesSidecarId(pageId);
		const remapResult = await this.adoptSidecar(sidecarId);
		if (this.stale()) return;
		this.pageId = pageId;
		this.sidecarId = sidecarId;
		this.finishLoad();
		// The remap's INPUT is the stored hashes, and the remap itself never
		// writes: skip this and a note edited twice between presentations is
		// matched against hashes two edits stale next time. `finishLoad` may
		// already have flushed (a stroke landed during the load window), in
		// which case `this.strokes`/`this.hashes` - already current above -
		// rode that write and a second one here would be a bare duplicate.
		if (remapResult && !this.dirty && (remapResult.remapped > 0 || remapResult.hashesChanged > 0)) {
			this.persist();
			log(
				`remap persisted: ${remapResult.remapped} stroke(s) moved, ` +
					`${remapResult.hashesChanged} hash(es) changed`
			);
		}
	}

	/**
	 * The load is over: writes are allowed, and one that arrived early runs now.
	 *
	 * The early stroke is already MERGED rather than merging here: it went into
	 * `this.strokes` at commit time and `adoptSidecar` appends the stored ink to
	 * those same per-slide lists, so `snapshot()` sees both. All this has to do
	 * is let the write it deferred happen.
	 */
	function finishLoad(this: SlidesDeck): void {
		if (this.loaded) return;
		this.loaded = true;
		// Ink a closed deck handed over while this one was reading goes in before the flush, so the flush or one
		// persist saves it with this deck's own.
		const handed = this.takeHandedInk();
		if (!this.saveAfterLoad) {
			if (handed) this.persist();
			return;
		}
		this.saveAfterLoad = false;
		log("flushing the stroke(s) drawn while the sidecar was still loading");
		this.persist();
	}

	async function adoptSidecar(
		this: SlidesDeck,
		sidecarId: string,
		replaceAdopted = false,
		// An id follow keeps the deck's ink on screen (no replace), but ink erased during its read must not come back
		// from the file it reads, which holds that ink: the same erased-id rule as a live reload.
		keepErased = false, noFile?: () => void
	): Promise<{ remapped: number; hashesChanged: number } | null> {
		const trackErased = replaceAdopted || keepErased;
		// Armed: a lock stood on the deck's note, standing now or lifted with no read landed since. Asked at the start: a
		// read already running when the lock lifts is not the lift's, and does not end the mark.
		const liftMarked = replaceAdopted && lockStood.has(this);
		const armed = liftMarked || (replaceAdopted && lockedWith(this, this.path) != null);
		const persistedIds = replaceAdopted && this.host.hasQueuedSidecar?.(sidecarId) === false
			? new Set(this.queuedIds) : new Set<string>();
		const beforeIds = new Set<string>();
		if (trackErased) {
			for (const id of this.adoptedIds) beforeIds.add(id);
			for (const list of this.strokes.values()) for (const s of list) beforeIds.add(s.id);
		}
		let result: LoadResult | null = null;
		const erased = new Set<string>();
		try {
			result = await this.host.loadSidecar(sidecarId);
		} catch (err) {
			this.actionsReadBlocked = true;
			log(`sidecar load failed for ${sidecarId}: ${String(err)}`);
			// A rejected reload keeps the already adopted model. An initial
			// rejection has no trusted model and must retain the write lock.
			if (replaceAdopted) {
				// A lift's read that rejects holds writes as a thrown one does: the deck has not read the file it
				// would write over.
				if (liftOwed.has(this) && !this.stale()) {
					this.reloadDamaged = true;
					if (holdsUnsaved(this)) this.noticeTransient();
				}
				return null;
			}
			result = { data: emptyPage(sidecarId), recovered: true, damaged: true, problem: String(err) };
		} finally {
			// Remember read-window erases even when the read fails, so a retry
			// cannot bring an erased local stroke back from its saved copy.
			if (trackErased && !this.stale()) {
				const remaining = new Set<string>();
				for (const list of this.strokes.values()) for (const s of list) remaining.add(s.id);
				for (const id of beforeIds) if (!remaining.has(id)) {
					erased.add(id);
					this.adoptedIds.add(id);
				}
			}
		}
		if (this.stale()) return null;
		if (!result) {
			noFile?.();
			// No file: nothing to merge, the deck's ink saves as it is, and the lift's read is done.
			if (liftMarked) lockStood.delete(this);
			if (replaceAdopted) this.actionsReadBlocked = true;
			if (this.coldReadPending) {
				// The file a thrown read held the deck on is GONE (removed, or a
				// sync client took it away). InlineInkStore.retryDamaged's rule:
				// nothing is left to read, so the hold lifts, the ink drawn while
				// held starts a fresh file (finishLoad runs its deferred write),
				// and only a reader who was told hears that saving is back.
				this.reloadDamaged = false;
				this.actionsReadBlocked = false;
				this.coldReadPending = false;
				this.transientSince = null;
				if (this.transientNoticed) this.host.notify(TRANSIENT_GONE);
				this.transientNoticed = false;
				log(`sidecar loaded: none (${sidecarId} is gone); the held deck starts fresh`);
				return null;
			}
			if (diagnosticsEnabled()) log(`sidecar loaded: none (${sidecarId} has no file yet)`);
			return null;
		}
		if (result.damaged && result.transient) {
			// The read threw. Hold writes, say nothing: telling the reader a
			// healthy file is broken, and locking the deck for the rest of the
			// presentation, is the defect. The poll re-reads it; ink drawn
			// meanwhile waits in memory and is saved once a read succeeds.
			this.reloadDamaged = true;
			this.actionsReadBlocked = true;
			if (!replaceAdopted) {
				this.coldReadPending = true;
				// The silence is bounded, as on a note: a stroke (persist) or
				// 60 s of reads that keep throwing gives one plain notice. A
				// stroke drawn while this read was in flight reaches persist
				// through finishLoad now, so held ink is told before any close.
				const now = Date.now();
				if (this.transientSince === null) this.transientSince = now;
				if (now - this.transientSince >= TRANSIENT_SILENCE_MS) this.noticeTransient();
			} else if (liftOwed.has(this) && holdsUnsaved(this)) {
				// A lift's read: the ink drawn while locked is held and was never saved. Told now, once.
				this.noticeTransient();
			}
			log(`sidecar load deferred: ${sidecarId} could not be read yet`);
			return null;
		}
		if (result.damaged) {
			if (replaceAdopted) {
				this.reloadDamaged = true;
				this.actionsReadBlocked = true;
				log(`sidecar reload deferred: damaged read for ${sidecarId}`);
				// Writes are held from here and teardown writes nothing, so the
				// reader hears it once (the read-only rule) rather than finding
				// the ink gone the next time the deck opens.
				const damagedWords = "Handwriting: this presentation's ink file could not be read, so new ink is not being saved.";
				if (liftOwed.has(this) && !this.stale() && holdsUnsaved(this)) {
					// A lift's read under ink drawn while locked: the words once, though the lock's notice was given, and
					// a read that lands later says "readable again".
					noticeLift(this, damagedWords);
					this.transientNoticed = true;
				} else this.noticeReadOnly(damagedWords);
				return null;
			}
			// Fail closed, the store's own rule, and there is genuinely nothing
			// to draw: `parsePage`'s catch arm hands back `emptyPage`, which is
			// a placeholder rather than the reader's ink. Ink still flows; it
			// just does not overwrite what we could not read.
			this.futureLocked = true;
			log(`sidecar loaded: REFUSED (damaged); ink this session is not saved`);
			this.noticeReadOnly(
				"Handwriting: this presentation's ink file could not be read, so new ink is not being saved."
			);
			return null;
		}
		this.reloadDamaged = false;
		// The read the lift owed has landed: later reads are not armed by it.
		if (liftMarked) lockStood.delete(this);
		// The first load has now happened: the actions its failed read blocked are back.
		if (this.coldReadPending) this.actionsReadBlocked = false;
		// A hold the reader was never told about heals as quietly as it came. A first read or a lift's read.
		if (this.transientNoticed && result.futureVersion === undefined) this.host.notify(TRANSIENT_HEALED);
		this.coldReadPending = false;
		this.transientSince = null;
		this.transientNoticed = false;
		if (result.futureVersion !== undefined) {
			// READ-ONLY, NOT INVISIBLE - InlineInkStore's rule, on the same
			// evidence ("this used to return here, so a note whose sidecar came
			// from a newer build showed NO ink at all - which reads as the data
			// loss the lock exists to prevent"). `parsePage` has already
			// migrated as much of the newer page as this build understands, and
			// `snapshot()` refuses outright for a future-locked deck, so
			// putting that ink on screen cannot lead to writing it back.
			//
			// The note surface's one exception - refusing to adopt ZERO strokes
			// out of a schema it does not fully understand - has no analogue
			// here: adoption APPENDS to the per-slide lists rather than
			// replacing them, so adopting nothing changes nothing.
			this.futureLocked = true;
			log(
				`sidecar loaded: READ-ONLY (schema v${result.futureVersion}); ` +
					`stored ink is shown, ink this session is not saved`
			);
			const newerWords =
				"Handwriting: this presentation's ink was written by a newer Handwriting. " +
				"It is shown here but new ink is not being saved.";
			// A lift's read under ink drawn while locked: the words once, though the lock's notice was given.
			if (liftOwed.has(this) && replaceAdopted && holdsUnsaved(this)) noticeLift(this, newerWords);
			else this.noticeReadOnly(newerWords);
		}
		// Close the current gesture against its original model before starting
		// the authoritative history boundary. Its write remains parked behind
		// this reload; the merged state below is what finishLoad persists.
		// Failed/refused reads leave both the gesture and its history intact.
		if (replaceAdopted && !this.futureLocked && this.session.phase === "drawing") {
			await new Promise<void>(resolve => { this.reloadAfterStroke = resolve; });
			if (this.stale()) return null;
			// The eraser may have taken more stored ink while this read waited
			// for the lift. Recount with the finally block's rule, or the disk
			// copy of that ink comes back below.
			const remaining = new Set<string>();
			for (const list of this.strokes.values()) for (const s of list) remaining.add(s.id);
			for (const id of beforeIds) if (!remaining.has(id)) {
				erased.add(id);
				this.adoptedIds.add(id);
			}
		}
		if (replaceAdopted && !this.futureLocked) this.endStrokeForSlideChange();
		// Only the store can distinguish a saved snapshot from a queued one.
		// Capture its state before the read: ink drawn during the await is local.
		for (const id of persistedIds) this.adoptedIds.add(id);
		// Strokes this deck read or saved and no longer holds: its cuts and erases not yet handed to a save.
		const synced = syncedInk.get(this);
		const held = new Set<string>();
		for (const list of this.strokes.values()) for (const s of list) held.add(s.id);
		const changedHere = synced ? [...synced.values()].filter((s) => !held.has(s.id)) : [];
		if (armed && !this.futureLocked) {
			keepSaved(this, held, result.data.strokes);
			keepOwnRemovals(this, held, result.data.strokes, erased);
		}
		// A live reload keeps the displayed ink until this read has succeeded.
		// Its starting ids also identify any ink erased during the await:
		// those ids must not be resurrected by the older disk snapshot.
		if (replaceAdopted) {
			for (const [index, list] of this.strokes) {
				const local = list.filter((s) => !this.adoptedIds.has(s.id));
				if (local.length > 0) this.strokes.set(index, local);
				else this.strokes.delete(index);
			}
			// Keep erased ids across later polls of the same older disk snapshot.
			this.adoptedIds = new Set(erased);
		}
		const page = result.data;
		// The copy's version wins: a stroke this deck cut or erased and has not
		// saved, which the file no longer holds, was cut by the other side too. The file's pieces of it are not taken, or
		// its line would be drawn twice. A change already handed to a save is in `synced` no more and drops nothing.
		const fileIds = new Set(page.strokes.map((s) => s.id));
		const gone = changedHere.filter((s) => !fileIds.has(s.id));
		const remains = new Set<string>();
		const anchors = new Map<string, number>();
		if (gone.length > 0) {
			page.strokes.forEach((r, i) => {
				if (synced?.has(r.id) || held.has(r.id)) return;
				const source = gone.find((f) => pieceOf(r, f));
				if (!source) return;
				remains.add(r.id);
				if (!anchors.has(source.id)) anchors.set(source.id, i);
			});
			if (remains.size > 0) log(`sidecar read: ${remains.size} piece(s) of ink changed here and not yet saved left out`);
		}
		lastDrop.set(this, { gone, anchors });
		// The dropped pieces stay out of later reads until a save: the changed strokes stay in `synced`, the pieces not.
		const nextSynced = new Map<string, InkStroke>();
		for (const s of page.strokes) if (!remains.has(s.id)) nextSynced.set(s.id, s);
		for (const s of gone) nextSynced.set(s.id, s);
		syncedInk.set(this, nextSynced);
		this.basePage = page;
		if (page.deck) this.deckSize = page.deck;
		const stored = page.slides ?? [];
		const moved = this.hashes.length > 0 ? remapSlides(stored, this.hashes) : new Map<number, number>();
		this.retainedSlides = new Map(stored
			.filter(slide => this.hashes[slide.index] !== slide.hash && !moved.has(slide.index))
			.map(slide => [slide.index, slide]));
		this.visualSlots.clear();
		const used = new Set(this.hashes.map((_, index) => index)
			.filter(index => !this.retainedSlides.has(index)));
		let next = Math.max(this.hashes.length - 1, ...stored.map(slide => slide.index)) + 1;
		for (let index = 0; index < this.hashes.length; index++) {
			if (!this.retainedSlides.has(index)) continue;
			const hash = this.hashes[index]!;
			const matches = stored.filter(slide => slide.hash === hash);
			const slot = matches.length === 1 && !used.has(matches[0]!.index)
				? matches[0]!.index : next++;
			this.visualSlots.set(index, slot);
			used.add(slot);
		}
		// Resolve local pre-load ink by its visible slide, before adding disk ink.
		// Share replacements with history so undo/redo cannot revive old slots.
		const resolvedLocal = new Map<InkStroke, InkStroke>();
		const resolveLocal = (stroke: InkStroke, index: number): InkStroke => {
			const page = pageOfSlide(this.visualSlots.get(index) ?? index);
			if (stroke.page === page) return stroke;
			let resolved = resolvedLocal.get(stroke);
			if (!resolved) {
				resolved = { ...stroke, page };
				resolvedLocal.set(stroke, resolved);
			}
			return resolved;
		};
		if (!replaceAdopted) {
			for (const [index, list] of this.strokes) {
				this.strokes.set(index, list.map(stroke => resolveLocal(stroke, index)));
			}
		}
		const strokes = page.strokes.slice();
		const remapped = remapStrokes(strokes, moved);
		// Ids already on screen are SKIPPED, not appended. On a cold load this
		// is inert (nothing is on screen yet); on a live reload it is what
		// stops the reader's own ink - already written to the sidecar the other
		// device then edited - coming back a second time under the same id.
		const present = new Set<string>();
		for (const list of this.strokes.values()) for (const s of list) present.add(s.id);
		const additions = new Map<number, InkStroke[]>();
		const visualBySlot = new Map([...this.visualSlots].map(([visual, slot]) => [slot, visual]));
		for (const s of strokes) {
			if (erased.has(s.id) || remains.has(s.id)) continue;
			if (present.has(s.id)) {
				// A local stroke becomes disk-owned once it has round-tripped.
				// A later remote erase must be able to remove it.
				this.adoptedIds.add(s.id);
				continue;
			}
			const slot = slideOfPage(s.page);
			const index = visualBySlot.get(slot) ?? slot;
			const list = this.strokes.get(index) ?? [];
			list.push(s);
			this.strokes.set(index, list);
			this.adoptedIds.add(s.id);
			const added = additions.get(index) ?? [];
			added.push(s);
			additions.set(index, added);
		}
		noteReadTook(this, held);
		// §3.6's "keep the index" is two different outcomes and only the log can
		// tell them apart: ink parked past the end of the deck is invisible and
		// harmless, while ink kept at an index the edit has since filled with
		// OTHER content is now drawn on a slide it was not drawn on. Neither is
		// a data loss and neither earns a Notice, but a reader who sees ink in
		// the wrong place deserves a line that explains it.
		const { kept, visible } = this.hashes.length > 0
			? keptSlides(stored, this.hashes, moved)
			: { kept: 0, visible: 0 };
		log(
			`sidecar loaded: ${sidecarId}, ${strokes.length} stroke(s), ` +
				`${stored.length} slide(s), remapped ${remapped}` +
				(kept > 0
					? `, kept ${kept} slide(s) at their old index (ambiguous or no match), ` +
						`${visible} of them on a slide this deck still shows`
					: "")
		);
		if (replaceAdopted && !this.futureLocked) {
			this.actionsReadBlocked = false;
			this.history.clear();
		} else if (!replaceAdopted) {
			this.history.rebaseInitial(additions, resolveLocal);
			const gesture = this.gestureBefore;
			if (gesture) {
				gesture.strokes = gesture.strokes.map(stroke => resolveLocal(stroke, gesture.index));
				const ids = new Set(gesture.strokes.map(s => s.id));
				gesture.strokes.push(...(additions.get(gesture.index) ?? []).filter(s => !ids.has(s.id)));
			}
		}
		this.actionsChanged();
		this.repaint();
		// The remap's INPUT, not its output: `stored` is what the deck was
		// matched against just now, `this.hashes` is what it would be matched
		// against next time. Different lengths count as different at every
		// index past the shorter list's end - an added or removed slide is
		// exactly the case a stale sidecar must not paper over.
		let hashesChanged = 0;
		const hashCount = Math.max(stored.length, this.hashes.length);
		for (let i = 0; i < hashCount; i++) {
			if (stored[i]?.hash !== this.hashes[i]) hashesChanged++;
		}
		return { remapped, hashesChanged };
	}

	function noteMemoryOnly(this: SlidesDeck, why: string, plain = "the note does not match the deck"): void {
		if (this.memoryOnlyLogged) return;
		this.memoryOnlyLogged = true;
		// The log line is unchanged - it is what found the comment bug - and it
		// is no longer the ONLY signal. The failure matrix used to spend this
		// arm's Notice on the grounds that a reader who opened a presentation
		// from nowhere did not ask to be interrupted; the owner then drew
		// sixteen items across a presentation whose note held a `%%` comment
		// and lost all of it at Escape, having been told nothing (2026-09-06).
		// Silence is only kind when nothing is at stake, and here the whole
		// presentation's ink is. Once per deck, `noticeReadOnly`'s discipline,
		// and reset with the flag when a new deck is built.
		log(`memory only: ${why}; ink drawn here is not saved`);
		this.host.notify(
			`Handwriting: ink on this presentation is not being saved (${plain}). ` +
				"Close and reopen the presentation."
		);
	}

	/**
	 * Save, claiming the note's page id first if this is the first stroke.
	 *
	 * The reference must exist before the referent (InlineClaim's rule): the
	 * sidecar write waits for the id to be in the note's frontmatter. Strokes
	 * committed meanwhile ride the same record, so the one write that follows
	 * carries all of them.
	 */
	function persist(this: SlidesDeck): void {
		if (this.futureLocked) return;
		// §3.5, before the path check: a mismatched note is not "no note", it is
		// the WRONG note, and the difference is a Markdown write on a file the
		// reader is not looking at.
		if (this.noteMismatch) {
			this.noteMemoryOnly("the resolved note does not match the deck on screen");
			return;
		}
		// The load window. Not `sidecarId`: the id is the thing being loaded
		// AGAINST, and writing on the strength of it alone is the overwrite this
		// gate exists to stop. `finishLoad` runs this again the moment the store
		// has answered, by which time `basePage` and the fail-closed lock are
		// both real.
		// Ink drawn on a deck held on a thrown first read is not saved until a
		// read succeeds: say so now, once, rather than let it go silently.
		if (this.coldReadPending) this.noticeTransient();
		if (!this.loaded || this.reloadDamaged) {
			this.saveAfterLoad = true;
			if (this.initialLoadFailed && !this.loadInFlight && !this.disposed) void this.startInitialLoad();
			return;
		}
		const path = this.path;
		if (!path) {
			this.noteMemoryOnly(
				"no active file when the presentation opened",
				"the note it belongs to could not be identified"
			);
			return;
		}
		// The note shares its page id with another and no owner is decided:
		// inline ink on both is read-only, and a slides write here would land in
		// the other note's slides ink. The strokes stay in memory and the first
		// save after the duplicate is resolved writes them; `snapshot` refuses
		// meanwhile, so teardown's flush holds too.
		const other = lockedWith(this, path);
		if (other !== null) {
			this.dirty = true;
			log(`save held: ${path} shares its page id with ${other}; ink stays in memory`);
			this.noticeReadOnly(duplicateNotice(other));
			return;
		}
		if (this.sidecarId) {
			this.save(false);
			return;
		}
		if (this.claimInFlight) return;
		const proposed = this.host.newPageId();
		this.claimInFlight = this.host
			.claimId(path, proposed)
			.then(async (result) => {
				// `stale()`, not `disposed`: teardown DRAINS this claim rather
				// than abandoning it, because the stroke that opened it is
				// still only in memory (§ the `dirty` gate below).
				if (this.stale()) return;
				if (result.futureVersion !== undefined) {
					this.futureLocked = true;
					this.noticeReadOnly(
						"Handwriting: this note declares a newer Handwriting format. Ink drawn on it is not saved."
					);
					return;
				}
				this.pageId = result.pageId;
				// A LOCAL until the merge is done - the same fix the load path
				// carries (see `loaded` above). `persist()` tests `sidecarId`
				// BEFORE `claimInFlight`, so publishing it one line early let a
				// stroke lifted inside the awaited adopt schedule a write whose
				// `snapshot()` had no `basePage` yet: this session's strokes
				// alone, over the other device's whole sidecar, with the
				// store's conflict guard already disarmed by the read.
				const sidecarId = slidesSidecarId(result.pageId);
				// The note may already have had an id we never saw (another
				// pane, another device, a cold metadata cache). Its sidecar can
				// hold ink; merge it BEFORE our first write can overwrite it.
				if (result.pageId !== proposed) await this.adoptSidecar(sidecarId);
				if (this.stale()) return;
				this.sidecarId = sidecarId;
				// A closed deck's drain may have handed ink over for this id before it was published here. The save
				// below writes it.
				this.takeHandedInk();
				// Disposed, but draining: the id is published (teardown's own
				// flush needs it) and the write is teardown's to make, once,
				// with the whole snapshot.
				if (this.disposed) return;
				this.save(true);
			})
			.catch((err) => {
				log(`save failed: could not claim a page id for ${path}: ${String(err)}`);
				this.noticeSaveFailure();
			})
			.finally(() => {
				this.claimInFlight = null;
				this.actionsChanged();
			});
	}

	/** The page this deck would write right now, or null if it must not write. */
	function snapshot(this: SlidesDeck): PageData | null {
		const sidecarId = this.sidecarId;
		if (!sidecarId || this.futureLocked || this.reloadDamaged) return null;
		if (lockedWith(this, this.path) != null) return null;
		const base = this.basePage ?? emptyPage(sidecarId);
		const strokes: InkStroke[] = [];
		for (const list of this.strokes.values()) strokes.push(...list);
		return {
			...base,
			pageId: sidecarId,
			surface: "slides",
			coordSpace: "slide-logical",
			...(this.deckSize ? { deck: this.deckSize } : {}),
			...(this.hashes.length > 0
				? { slides: Array.from(new Map<number, StoredSlide>([
					...this.hashes.map((hash, index): [number, StoredSlide] => {
						const slot = this.visualSlots.get(index) ?? index;
						return [slot, { index: slot, hash }];
					}),
					...this.retainedSlides.entries(),
				]).values()).sort((a, b) => a.index - b.index) }
				: {}),
			strokes,
		};
	}

	function save(this: SlidesDeck, immediate: boolean): void {
		// Every caller reached here because something changed - a stroke
		// committed, an erase removed one, or a load-window write was deferred
		// and is running now. Teardown reads this to decide whether it has
		// anything to flush at all.
		this.dirty = true;
		// After teardown the DRAIN is the only writer. A parked claim or load
		// that lands post-dispose still runs through here (that is the point of
		// draining it), and a second, debounced copy of the same bytes would
		// only churn the sidecar's mtime behind the drain's immediate write.
		if (this.disposed) return;
		const page = this.snapshot();
		const sidecarId = this.sidecarId;
		if (!page || !sidecarId) return;
		// Drawn or cut here and handed to a save: what an armed read keeps when the file lacks it (keepSaved).
		const mine = savedHere.get(this) ?? new Set<string>();
		for (const s of page.strokes) if (!this.adoptedIds.has(s.id)) mine.add(s.id);
		savedHere.set(this, mine);
		const took = readTook.get(this);
		if (took) for (const s of page.strokes) took.delete(s.id);
		this.queuedIds = new Set(page.strokes.map(stroke => stroke.id));
		// Handed to a save: from here the deck's cuts and erases are the file's, and no later read drops for them.
		syncedInk.set(this, new Map(page.strokes.map((s) => [s.id, s])));
		if (!immediate) {
			this.host.scheduleSidecar(sidecarId, page);
			if (diagnosticsEnabled()) log(`save scheduled: ${sidecarId}, ${page.strokes.length} stroke(s)`);
			return;
		}
		if (diagnosticsEnabled()) {
			log(`save scheduled: ${sidecarId}, ${page.strokes.length} stroke(s) (first write after claim)`);
		}
		void this.host.saveSidecarNow(sidecarId, page).catch((err) => {
			log(`save failed: ${sidecarId}: ${String(err)}`);
			this.noticeSaveFailure();
		});
	}

	/** One Notice per presentation (failure matrix), and one log line each time. */
	function noticeSaveFailure(this: SlidesDeck): void {
		if (this.saveFailureNoticed) return;
		this.saveFailureNoticed = true;
		this.host.notify("Handwriting: this presentation's ink could not be saved.");
	}

	/**
	 * The read-only locks say their piece ONCE, `noticeSaveFailure`'s rule.
	 *
	 * One flag for all three (damaged, future sidecar, future note) rather than
	 * one each: they are the same sentence to the reader - "this is shown but
	 * not saved" - and a deck that hits two of them in one presentation would
	 * otherwise stack Notices over the projected slide. A live reload re-reads
	 * the same sidecar every time the poll sees it change, which is exactly the
	 * repeat this guard exists to swallow.
	 */
	function noticeReadOnly(this: SlidesDeck, message: string): void {
		if (this.readOnlyNoticed) return;
		this.readOnlyNoticed = true;
		this.host.notify(message);
	}

	/** The one notice a deck held on a thrown first read gives, when its silence ends. */
	function noticeTransient(this: SlidesDeck): void {
		if (this.transientNoticed) return;
		this.transientNoticed = true;
		this.host.notify(TRANSIENT_NOTICE);
	}

	/**
	 * The deck is gone AND nothing parked is still being drained for it.
	 *
	 * Every continuation that outlives `dispose()` asks this instead of
	 * `disposed`: a claim or a load that the reader's own stroke is waiting
	 * behind has to be allowed to finish, publish its id and merge, or the
	 * stroke that opened it is lost. A bare `disposed` is still right for the
	 * last step - the WRITE - which teardown makes itself, once.
	 */
	function stale(this: SlidesDeck): boolean {
		return this.disposed && !this.draining;
	}

	/** Everything a shutdown must wait for before it flushes the store. */
	function inFlightWork(this: SlidesDeck): Promise<unknown>[] {
		const out: Promise<unknown>[] = [];
		if (this.claimInFlight) out.push(this.claimInFlight);
		if (this.loadInFlight) out.push(this.loadInFlight);
		if (this.teardownDrain) out.push(this.teardownDrain);
		return out;
	}

	/**
	 * The sidecar this deck would let the live-reload poll re-read, or null.
	 *
	 * Deliberately narrow, and it is the poll's own re-check (main.ts) that
	 * makes it worth anything: the answer is a tick old by the time the stat
	 * comes back, so the caller asks again in the same microtask as the adopt.
	 */
	function reloadCandidateSidecarId(this: SlidesDeck): string | null {
		if (this.disposed || this.draining) return null;
		// Not loaded yet, or mid-claim: the cold load is the reload, and
		// re-entering `adoptSidecar` underneath it would interleave two merges
		// into the same per-slide lists.
		if (!this.loaded || this.loadInFlight || this.claimInFlight) return null;
		// Fail closed, both directions: a memory-only deck has no sidecar it is
		// entitled to read, and a future-locked one must not drop the lock by
		// re-reading (InlineInkStore.reloadExternal refuses for the same set).
		if (this.noteMismatch || this.futureLocked) return null;
		// A duplicate-locked deck holds the page it loaded, as a locked note does (InlineInkStore.reloadExternal): the
		// other note's ink reaches it when the lock lifts, which reads the file again. A deck still waiting on a read that
		// failed keeps retrying, or it would stay blank.
		if (lockedWith(this, this.path) != null && !this.coldReadPending && !this.reloadDamaged) return null;
		// A pen on the glass. Swapping the committed lists under a live stroke
		// is the one thing a reload can do that the reader would see.
		if (this.session.phase === "drawing" || this.erasing || this.eraseDirty) return null;
		return this.sidecarId;
	}

	/**
	 * Re-read a quiet deck through the cold load's adoption and save gate.
	 * Keep the live lists intact during I/O, then replace adopted ink only if
	 * the read succeeds. Local ink and erases made during the read survive.
	 * The tracked completion includes adoption and deferred saves so teardown
	 * can drain it, and a second poll cannot start an overlapping read.
	 */
	async function reloadExternal(this: SlidesDeck, sidecarId: string): Promise<boolean> {
		if (this.reloadCandidateSidecarId() !== sidecarId) return false;
		const before = this.strokeFingerprint();
		this.loaded = false;
		let changed = false;
		let lifted = false;
		let none = false;
		// Nothing was adopted yet when the first read threw: this read is the
		// first load, with its merge of ink drawn meanwhile and its undo history.
		const loading = this.adoptSidecar(sidecarId, !this.coldReadPending, false, () => { none = true; })
			.then((result) => {
				if (this.stale()) return;
				// A deck held by a thrown reload (a live reload's or a lift's) whose file is now gone: nothing is left to read,
				// so the hold lifts as the first read's no-file rule lifts it, the ink drawn while held starts a fresh file, and
				// only a reader who was told hears that saving is back. A lift still owed ends here and saves a dirty deck.
				if (none && this.reloadDamaged) {
					this.reloadDamaged = false;
					this.actionsReadBlocked = false;
					this.transientSince = null;
					if (this.transientNoticed) this.host.notify(TRANSIENT_GONE);
					this.transientNoticed = false;
					if (liftOwed.delete(this)) lifted = true;
					log(`sidecar loaded: none (${sidecarId} is gone); the held deck starts fresh`);
				}
				if (!result) return;
				// The lift's own read failed or was put off: this read does what it would have, order and save.
				if (liftOwed.has(this)) {
					liftOwed.delete(this);
					lifted = true;
					orderAfterLift(this);
				}
				changed = this.strokeFingerprint() !== before;
			})
			.finally(() => {
				this.loadInFlight = null;
				const deferredSave = this.saveAfterLoad;
				if (!this.stale()) this.finishLoad();
				if ((changed || lifted) && this.dirty && !deferredSave && !this.disposed && !this.reloadDamaged) this.save(false);
				this.actionsChanged();
			});
		this.loadInFlight = loading;
		this.actionsChanged();
		await loading;
		return changed;
	}

	/** Ids and slide numbers, in a stable order: does a reload change anything? */
	function strokeFingerprint(this: SlidesDeck): string {
		const parts: string[] = [];
		for (const [index, list] of this.strokes) {
			for (const s of list) parts.push(`${index}:${s.id}`);
		}
		return parts.sort().join(",");
	}

	/**
	 * The note's id changed under the open deck, or its duplicate lock lifted (slidesNoteIdChanged). Inline ink acts on
	 * the same route at the same moment; this does the same for the deck:
	 *  - a fresh id: the deck writes under it from now on, merging that id's file first; when the old id's file did not
	 *    become that id's live file (`keepHeld` false), the strokes held from the old id leave the deck first;
	 *  - the id line gone from a locked note: only ink drawn here goes on, under a fresh id the next save claims;
	 *  - a locked note's id edited: only ink drawn here goes on, merged into the new id's file;
	 *  - the id unchanged and the lock lifted: held ink saves now, not at the next stroke or the close.
	 */
	function noteIdChanged(this: SlidesDeck, path: string, wasLocked: boolean, known?: string, keepHeld = true, slidesTaken = false): void {
		if (this.disposed || path !== this.path) return;
		// The id route's word for the deck's own note: a held leave ends here, and the lock is asked of the note as it is.
		// A held leave is a lock that stood: the read that follows is the lift's.
		if (leftLocked.delete(this)) lockStood.add(this);
		// A load, reload or claim still running answers from the id it read before the change: look again once it lands,
		// at the note's path then.
		const busy = this.loadInFlight ?? this.claimInFlight;
		if (busy) {
			const since = moveSeq;
			const again = (): void => this.noteIdChanged(followPath(this, path, since), wasLocked, known, keepHeld, slidesTaken);
			void busy.then(again, again);
			return;
		}
		// A deck held on a damaged read: the poll's retry merges and saves, and does the lift's ordering when it lands.
		if (this.reloadDamaged && this.loaded && !this.noteMismatch && !this.futureLocked && (known === undefined || known === this.pageId)) liftOwed.add(this);
		// A deck that has adopted nothing yet reads the id on its next load; a memory-only or read-only one writes nothing.
		if (!this.loaded || this.noteMismatch || this.futureLocked || this.reloadDamaged) return;
		// The id the caller just wrote wins over the cache, which can still hold the note's old text.
		const pageId = known !== undefined ? known : this.host.readPageId(path);
		if (pageId === this.pageId) {
			const sidecarId = this.sidecarId;
			if (pageId === null || !sidecarId || this.host.duplicateLockedWith?.(path) != null) return;
			// The lock lifted on a deck holding the page it loaded, while the other note kept writing the file: read it
			// again first, as a live reload does (ink drawn or erased here stays, the file's own ink is taken again),
			// then save. A clean deck reads too: polls skip a locked deck, so its page is older than the file, and a
			// stroke saved on it would set the file's newer ink aside. No file (never made, or gone) leaves nothing to
			// merge: the deck's ink saves as it is, and the actions stay as they were before the read. A read that fails
			// saves nothing now; the deck stays dirty, and the next read that lands orders and saves it. The lift is owed
			// from before the read, so a read that throws knows it is the lift's.
			const blocked = this.actionsReadBlocked;
			let read = false;
			let none = false;
			liftOwed.add(this);
			const loading: Promise<void> = this.adoptSidecar(sidecarId, true, false, () => { none = true; })
				.then(
					(result) => {
						read = result !== null;
						if (this.stale()) return;
						if (none) {
							this.actionsReadBlocked = blocked;
							liftOwed.delete(this);
						}
						if (!read) return;
						liftOwed.delete(this);
						orderAfterLift(this);
					},
					(err) => {
						log(`could not read ${sidecarId} again after the duplicate lock lifted: ${String(err)}`);
					}
				)
				.finally(() => {
					if (this.loadInFlight === loading) this.loadInFlight = null;
					if (!this.stale()) {
						const deferred = this.saveAfterLoad;
						this.finishLoad();
						// The note's id lost its Slides file to this session's move (`slidesTaken`) and the read found none:
						// a clean deck saves what it shows under the id, or that ink is in no file. Any other lift whose
						// read finds no file saves only a dirty deck, as before.
						const shownOnly = slidesTaken && none && !this.dirty && this.totalStrokes() > 0;
						if ((read || none) && !deferred && (this.dirty || shownOnly) && !this.disposed && !this.reloadDamaged) {
							const synced = syncedInk.get(this);
							this.persist();
							// save() sets dirty for good though nothing was drawn here: set it back right after the persist,
							// in the same synchronous span (no await between them), and only once the page was handed to a
							// save (syncedInk replaced), so a later no-file read and the close write nothing again.
							if (shownOnly && syncedInk.get(this) !== synced) this.dirty = false;
						}
					}
					this.actionsChanged();
				});
			this.loaded = false;
			this.loadInFlight = loading;
			this.actionsChanged();
			return;
		}
		// No id yet: the first stroke's claim reads the note's id itself and merges its file.
		if (this.pageId === null) return;
		// A locked note's adopted ink is the other note's: only ink drawn here goes on, to the new id or a fresh one.
		if (wasLocked) this.carryOwnStrokes(pageId ?? undefined);
		// The old id's file is now the new id's live file: what the deck holds is that file, so it stays on screen.
		else if (pageId !== null && keepHeld) this.followPageId(pageId);
		// It was set aside, or it is another note's: its strokes leave the deck, or the next save writes them under the new id.
		else if (pageId !== null) this.carryOwnStrokes(pageId, true);
	}

	/**
	 * Move the deck to the note's new id. The load gate is held while that id's file is read, as a live reload holds it,
	 * so a stroke drawn meanwhile waits and is written under the new id when the read lands. The id is published only
	 * after the merge, the claim path's rule.
	 */
	function followPageId(this: SlidesDeck, pageId: string): void {
		const sidecarId = slidesSidecarId(pageId);
		const loading: Promise<void> = this.adoptSidecar(sidecarId, false, true)
			.then(() => {
				if (this.stale()) return;
				this.pageId = pageId;
				this.sidecarId = sidecarId;
				log(`page id followed: ${this.path ?? "?"} now writes ${sidecarId}`);
			})
			.catch((err) => {
				// Fail closed: the deck is no longer on the old shared id, and the new id's file was not merged, so
				// it writes nothing from here, and says so once.
				this.futureLocked = true;
				log(`could not read ${sidecarId} after the note's id changed: ${String(err)}`);
				this.noticeReadOnly(
					"Handwriting: this presentation's ink file could not be read, so new ink is not being saved."
				);
			})
			.finally(() => {
				if (this.loadInFlight === loading) this.loadInFlight = null;
				if (!this.stale()) {
					const deferred = this.saveAfterLoad;
					this.finishLoad();
					// Ink not yet written goes to the new id now, as inline ink reschedules the copy's record.
					if (!deferred && this.dirty && !this.disposed && this.sidecarId === sidecarId) this.persist();
				}
				this.actionsChanged();
			});
		this.loaded = false;
		this.loadInFlight = loading;
		this.actionsChanged();
	}

	/**
	 * The id line was deleted from this note while it was locked. Ink adopted from the shared file is the other note's
	 * and leaves the deck, as it leaves an inline note; ink drawn here stays, and the next save claims a fresh id for it
	 * (persist's claim merges whatever that id already holds). When the locked note's id was edited instead, `pageId`
	 * is that new id: the deck reads its file and writes the ink drawn here there, never under the old shared id.
	 *
	 * `dropAll`: an unlocked note's id was edited and the old id's file did not become the new id's live file. Every
	 * stroke the deck holds is on disk or queued under the old id already, so none is carried and the deck is not
	 * dirty: it shows the new id's file only.
	 */
	function carryOwnStrokes(this: SlidesDeck, pageId?: string, dropAll = false): void {
		let carried = 0;
		for (const [index, list] of [...this.strokes]) {
			const page = pageOfSlide(index);
			const own = dropAll
				? []
				: list.filter((s) => !this.adoptedIds.has(s.id)).map((s) => (s.page === page ? s : { ...s, page }));
			if (own.length > 0) this.strokes.set(index, own);
			else this.strokes.delete(index);
			carried += own.length;
		}
		this.pageId = null;
		this.sidecarId = null;
		this.basePage = null;
		this.adoptedIds = new Set();
		this.queuedIds = new Set();
		syncedInk.delete(this);
		lastDrop.delete(this);
		liftOwed.delete(this);
		lockStood.delete(this);
		savedHere.delete(this);
		readTook.delete(this);
		closeReadTried.delete(this);
		this.retainedSlides.clear();
		this.visualSlots.clear();
		this.history.clear();
		if (dropAll) log(`page id edited on ${this.path ?? "?"}: held ink of the old id dropped from the deck, ${pageId ?? "?"} read next`);
		else log(`shared id left by ${this.path ?? "?"}: ${carried} stroke(s) drawn here kept for ${pageId ?? "a fresh id"}, shared ink dropped`);
		this.actionsChanged();
		this.repaint();
		if (pageId !== undefined) {
			// followPageId saves a dirty deck once the new id's file is merged; only carried ink makes it dirty now.
			this.dirty = carried > 0;
			this.followPageId(pageId);
			return;
		}
		if (carried > 0) this.persist();
	}

	/**
	 * A closed deck's drain has written its page (`landed`) or had the write refused: hand the live deck on the same
	 * sidecar what its read may have missed. That deck read the file before this write, so its lists lack this deck's
	 * own ink and still show the file ink this deck erased, and its next save would write over both. Sent every time,
	 * even with nothing in it: the drain's immediate write can take the place of the live deck's queued page.
	 */
	function handOverInk(this: SlidesDeck, sidecarId: string, landed: boolean): void {
		const live = liveDeck();
		if (!live || live === this || live.disposed) return;
		const present = new Set<string>();
		const strokes: InkStroke[] = [];
		for (const list of this.strokes.values()) {
			for (const s of list) {
				present.add(s.id);
				// File ink and ink already in the store's queue reached the live deck's read; this deck's own did not.
				if (!this.adoptedIds.has(s.id) && !this.queuedIds.has(s.id)) strokes.push(s);
			}
		}
		// adoptSidecar's erased rule: file ink this deck no longer holds.
		const dropped = [...this.adoptedIds].filter((id) => !present.has(id));
		log(`teardown: ${strokes.length} stroke(s) and ${dropped.length} erase(s) handed to the live deck on ${sidecarId}`);
		live.receiveInk({ sidecarId, strokes, dropped, landed });
	}

	/** Take a hand-over now if this deck is loaded on its sidecar, or keep it for the load or the claim that gets there. */
	function receiveInk(this: SlidesDeck, ink: HandedInk): void {
		if (this.loaded && this.sidecarId !== null && this.sidecarId !== ink.sidecarId) return;
		const queue = handedInk.get(this) ?? [];
		queue.push(ink);
		handedInk.set(this, queue);
		if (!this.loaded || this.sidecarId !== ink.sidecarId) return;
		const changed = this.takeHandedInk();
		// The drain's write may have taken the place of this deck's queued page in the store.
		if (changed || this.dirty) this.persist();
	}

	/**
	 * Merge the hand-overs kept for this deck's sidecar into its lists. Returns whether the lists changed.
	 *
	 * A stroke already in the lists is skipped. The others keep their page and go on the slide the cold load would put
	 * them on; they count as file ink only when the drain's write landed. A dropped id leaves the lists only where this
	 * deck holds it as file ink, never this deck's own ink. Added ink is put into the undo history and the open
	 * gesture's snapshot, as the cold load does. History has no rebase that drops ink, so a removal clears it, the
	 * class's rule for adopting outside ink.
	 */
	function takeHandedInk(this: SlidesDeck): boolean {
		const queue = handedInk.get(this);
		const id = this.sidecarId;
		if (!queue || !this.loaded || !id) return false;
		if (this.futureLocked || this.reloadDamaged || this.noteMismatch) return false;
		handedInk.delete(this);
		const present = new Set<string>();
		for (const list of this.strokes.values()) for (const s of list) present.add(s.id);
		const visualBySlot = new Map([...this.visualSlots].map(([visual, slot]) => [slot, visual]));
		const additions = new Map<number, InkStroke[]>();
		const drop = new Set<string>();
		for (const ink of queue) {
			if (ink.sidecarId !== id) continue;
			for (const s of ink.strokes) {
				if (present.has(s.id)) continue;
				present.add(s.id);
				const slot = slideOfPage(s.page);
				const index = visualBySlot.get(slot) ?? slot;
				const list = this.strokes.get(index) ?? [];
				list.push(s);
				this.strokes.set(index, list);
				readTook.get(this)?.delete(s.id);
				if (ink.landed) this.adoptedIds.add(s.id);
				const added = additions.get(index) ?? [];
				added.push(s);
				additions.set(index, added);
			}
			for (const dropped of ink.dropped) if (this.adoptedIds.has(dropped)) drop.add(dropped);
		}
		let removed = false;
		if (drop.size > 0) {
			for (const [index, list] of [...this.strokes]) {
				const kept = list.filter((s) => !drop.has(s.id));
				if (kept.length === list.length) continue;
				removed = true;
				if (kept.length > 0) this.strokes.set(index, kept);
				else this.strokes.delete(index);
			}
		}
		if (additions.size === 0 && !removed) return false;
		const gesture = this.gestureBefore;
		if (additions.size > 0) {
			this.history.rebaseInitial(additions);
			if (gesture) {
				const ids = new Set(gesture.strokes.map((s) => s.id));
				gesture.strokes.push(...(additions.get(gesture.index) ?? []).filter((s) => !ids.has(s.id)));
			}
		}
		if (removed) {
			this.history.clear();
			if (gesture) gesture.strokes = gesture.strokes.filter((s) => !drop.has(s.id));
		}
		log(`hand-over taken on ${id}: ${[...additions.values()].reduce((n, l) => n + l.length, 0)} stroke(s) added, ` +
			`${removed ? "erased file ink removed, undo history cleared" : "nothing removed"}`);
		this.actionsChanged();
		this.repaint();
		return true;
	}

	/** Is the deck holding ink drawn while locked because its lift's read has not landed? A close reads once more. */
	function liftHeld(this: SlidesDeck): boolean {
		if (!liftOwed.has(this) || !this.reloadDamaged || this.sidecarId === null) return false;
		// Also a stroke saved here before the lock, which the lift's read keeps if the file lacks it: the close reads once
		// for it. After that read fails, only ink the file never had holds the deck.
		return holdsUnsaved(this) || (lockStood.has(this) && !closeReadTried.has(this) && holdsSavedHere(this));
	}

	/**
	 * The deck is closing while its lift's read is owed: read once more, as a deck whose first read failed does at a close.
	 * Landed, the deck is ordered and merged as at the lift, and teardown's drain writes it; no file, nothing to merge, and
	 * the drain writes the deck's ink as it is (the lift's own rule); failed, the hold stands and the drain tells the reader.
	 */
	function readOwedLift(this: SlidesDeck): Promise<void> {
		const sidecarId = this.sidecarId!;
		closeReadTried.add(this);
		let none = false;
		const loading: Promise<void> = this.adoptSidecar(sidecarId, true, false, () => { none = true; })
			.then(
				(result) => {
					if (this.stale()) return;
					if (none) {
						this.reloadDamaged = false;
						liftOwed.delete(this);
					}
					if (!result) return;
					liftOwed.delete(this);
					orderAfterLift(this);
				},
				(err) => {
					log(`could not read ${sidecarId} again at the close: ${String(err)}`);
				}
			)
			.finally(() => {
				if (this.loadInFlight === loading) this.loadInFlight = null;
				if (!this.stale()) this.finishLoad();
			});
		this.loaded = false;
		this.loadInFlight = loading;
		return loading;
	}

/**
 * After a lock lifts (or the read that stands in for its failed one lands): each slide's strokes in the file's order,
 * then the ones drawn here on top, in their order. A piece the eraser cut here from a stroke was not drawn over
 * anything: it goes where that stroke sits in the file, or, when the file holds only the other side's pieces of it
 * (left out by the read), where the first of those sat. Otherwise it would draw over the strokes that crossed it.
 */
function orderAfterLift(deck: SlidesDeck): void {
	const file = deck.basePage?.strokes ?? [];
	const order = new Map(file.map((s, i) => [s.id, i]));
	const drop = lastDrop.get(deck);
	const sources = file.map((s, key) => ({ s, key }));
	for (const s of drop?.gone ?? []) {
		const key = drop!.anchors.get(s.id);
		if (key !== undefined) sources.push({ s, key });
	}
	const keyOf = cutSources(sources, deck.strokes);
	for (const [index, list] of deck.strokes) {
		const keyed = list.map((s, i) => ({ s, i, key: order.get(s.id) ?? keyOf(s) ?? order.size + i }));
		deck.strokes.set(index, keyed.sort((a, b) => a.key - b.key || a.i - b.i).map((k) => k.s));
	}
	deck.repaint();
}

/**
 * Where a piece on the deck goes, from the stroke it was cut from: the source is a stroke the deck no longer holds, and
 * the piece lies on its line (pieceOf). A piece cut again lies on the first source's line too, so it follows it.
 * Nothing is stored: once a save lands, the order is the file's. A piece with no source keeps the place a new stroke takes.
 */
function cutSources(sources: ReadonlyArray<{ s: InkStroke; key: number }>, held: ReadonlyMap<number, readonly InkStroke[]>): (s: InkStroke) => number | null {
	const onDeck = new Set<string>();
	for (const list of held.values()) for (const s of list) onDeck.add(s.id);
	const byTime = new Map<number, Array<{ s: InkStroke; key: number }>>();
	for (const c of sources) {
		if (onDeck.has(c.s.id)) continue;
		const same = byTime.get(c.s.createdAt);
		if (same) same.push(c);
		else byTime.set(c.s.createdAt, [c]);
	}
	return (s) => {
		for (const c of byTime.get(s.createdAt) ?? []) if (pieceOf(s, c.s)) return c.key;
		return null;
	};
}

/** Saved points are kept to 0.01 (PageData), so a piece and its source agree to within that. */
const NEAR = 0.02;

/**
 * Is `piece` a piece the eraser cut from `f` (splitStrokeByCircle), or a piece of such a piece? A piece keeps every
 * field of its source but the id and points, and its points are a run of the source's samples with at most one point on
 * the ring at each end, which lies on the source's segment there. So: the same time, tool, colour and width; the inner
 * points are consecutive samples of `f`; each end lies on the segment beside that run. A stroke that is all of `f` is
 * not a piece of it. Ink drawn along `f` later has its own time; a sibling cut earlier from the same stroke shares the
 * time but holds none of `f`'s samples. A box test cannot tell either apart.
 */
function pieceOf(piece: InkStroke, f: InkStroke): boolean {
	if (piece.createdAt !== f.createdAt || piece.tool !== f.tool || piece.color !== f.color || piece.width !== f.width) return false;
	const p = piece.points, q = f.points;
	if (p.length < 2 || q.length < 2) return false;
	if (p.length === q.length && p.every((pt, i) => same(pt, q[i]!))) return false;
	const inner = p.slice(1, -1);
	if (inner.length === 0) {
		// Both ends on the ring, or a lone survivor: on one segment of f.
		for (let i = 0; i < q.length - 1; i++) if (onSegment(p[0]!, q[i]!, q[i + 1]!) && onSegment(p[1]!, q[i]!, q[i + 1]!)) return true;
		return false;
	}
	for (let k = 1; k + inner.length < q.length; k++) {
		if (!inner.every((pt, j) => same(pt, q[k + j]!))) continue;
		if (onSegment(p[0]!, q[k - 1]!, q[k]!) && onSegment(p[p.length - 1]!, q[k + inner.length - 1]!, q[k + inner.length]!)) return true;
	}
	return false;
}

/**
 * Is `piece` a piece of `f` that was then moved whole (a lasso move keeps the id and shifts every point by one
 * offset)? The offset is read from the piece's first inner point against each of f's inner samples in turn, and
 * pieceOf is asked of f shifted by it. A piece of two points has no inner point to fix an offset: false. A whole
 * stroke shifted is not a piece (pieceOf's own rule).
 */
function movedPieceOf(piece: InkStroke, f: InkStroke): boolean {
	if (piece.createdAt !== f.createdAt) return false;
	const p = piece.points, q = f.points;
	if (p.length < 3 || q.length < 3) return false;
	const first = p[1]!;
	for (let k = 1; k < q.length - 1; k++) {
		const dx = first.x - q[k]!.x, dy = first.y - q[k]!.y;
		if (Math.abs(dx) <= NEAR && Math.abs(dy) <= NEAR) continue;
		if (pieceOf(piece, { ...f, points: q.map((pt) => ({ ...pt, x: pt.x + dx, y: pt.y + dy })) })) return true;
	}
	return false;
}

function same(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
	return Math.abs(a.x - b.x) <= NEAR && Math.abs(a.y - b.y) <= NEAR;
}

function onSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): boolean {
	const dx = b.x - a.x, dy = b.y - a.y;
	const len = dx * dx + dy * dy;
	const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) <= NEAR;
}

export function installSlidesPersistence(proto: SlidesDeck): void {
	installMethods(proto, {
		startInitialLoad,
		loadSidecar,
		finishLoad,
		adoptSidecar,
		noteMemoryOnly,
		persist,
		snapshot,
		save,
		noticeSaveFailure,
		noticeReadOnly,
		noticeTransient,
		stale,
		inFlightWork,
		reloadCandidateSidecarId,
		reloadExternal,
		strokeFingerprint,
		noteIdChanged,
		followPageId,
		carryOwnStrokes,
		handOverInk,
		receiveInk,
		takeHandedInk,
		liftHeld,
		readOwedLift,
	});
}
