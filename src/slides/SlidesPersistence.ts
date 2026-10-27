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
		adoptSidecar(sidecarId: string, replaceAdopted?: boolean): Promise<{ remapped: number; hashesChanged: number } | null>;
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
					path = candidate;
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
		if (!this.saveAfterLoad) return;
		this.saveAfterLoad = false;
		log("flushing the stroke(s) drawn while the sidecar was still loading");
		this.persist();
	}

	async function adoptSidecar(
		this: SlidesDeck,
		sidecarId: string,
		replaceAdopted = false
	): Promise<{ remapped: number; hashesChanged: number } | null> {
		const persistedIds = replaceAdopted && this.host.hasQueuedSidecar?.(sidecarId) === false
			? new Set(this.queuedIds) : new Set<string>();
		const beforeIds = new Set<string>();
		if (replaceAdopted) {
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
			if (replaceAdopted) return null;
			result = { data: emptyPage(sidecarId), recovered: true, damaged: true, problem: String(err) };
		} finally {
			// Remember read-window erases even when the read fails, so a retry
			// cannot bring an erased local stroke back from its saved copy.
			if (replaceAdopted && !this.stale()) {
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
				this.noticeReadOnly(
					"Handwriting: this presentation's ink file could not be read, so new ink is not being saved."
				);
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
		// The first load has now happened: the actions its failed read blocked are back.
		if (this.coldReadPending) {
			this.actionsReadBlocked = false;
			// A hold the reader was never told about heals as quietly as it came.
			if (this.transientNoticed && result.futureVersion === undefined) this.host.notify(TRANSIENT_HEALED);
		}
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
			this.noticeReadOnly(
				"Handwriting: this presentation's ink was written by a newer Handwriting. " +
					"It is shown here but new ink is not being saved."
			);
		}
		// Close the current gesture against its original model before starting
		// the authoritative history boundary. Its write remains parked behind
		// this reload; the merged state below is what finishLoad persists.
		// Failed/refused reads leave both the gesture and its history intact.
		if (replaceAdopted && !this.futureLocked && this.session.phase === "drawing") {
			await new Promise<void>(resolve => { this.reloadAfterStroke = resolve; });
			if (this.stale()) return null;
		}
		if (replaceAdopted && !this.futureLocked) this.endStrokeForSlideChange();
		// Only the store can distinguish a saved snapshot from a queued one.
		// Capture its state before the read: ink drawn during the await is local.
		for (const id of persistedIds) this.adoptedIds.add(id);
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
			if (erased.has(s.id)) continue;
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
		this.queuedIds = new Set(page.strokes.map(stroke => stroke.id));
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
		// Nothing was adopted yet when the first read threw: this read is the
		// first load, with its merge of ink drawn meanwhile and its undo history.
		const loading = this.adoptSidecar(sidecarId, !this.coldReadPending)
			.then((result) => {
				if (!this.stale() && result) changed = this.strokeFingerprint() !== before;
			})
			.finally(() => {
				this.loadInFlight = null;
				const deferredSave = this.saveAfterLoad;
				if (!this.stale()) this.finishLoad();
				if (changed && this.dirty && !deferredSave && !this.disposed && !this.reloadDamaged) this.save(false);
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
	});
}
