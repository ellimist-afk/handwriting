/**
 * Page identity and ownership: the startup census of page ids, edit and removal tracking, the duplicate-id resolution, the
 * persisted owner memory, the recent-id lookup, the split-ink report and the note page-id claim. The methods are methods of
 * HandwritingPlugin, installed on its prototype when main.ts loads (installPageIdentity at its bottom). Bodies moved
 * unchanged from the class. This file imports only types from main.
 */
import { Notice, TFile } from "obsidian";
import { slidesSidecarId } from "../slides/SlidesInkSurface";
import { slidesNoteIdChanged } from "../slides/SlidesPersistence";
import { inkExternallyReloaded, inlineInk } from "../inline/InkOverlay";
import { claimMarkdown, hasEmptyFrontmatterBlock, hasFrontmatterBlock, reassignMarkdown, UnreadableFrontmatterError } from "../inline/InlineClaim";
import { notifyInkChanged } from "../inline/InkEvents";
import { DiagnosticTextModal } from "../diag/DiagnosticTextModal";
import { isSafePageId, newPageId } from "../model/PageData";
import { RegisterVerdict } from "../model/PageIdIndex";
import { runDetached } from "../util/Detached";
import { findSplitInk, type SplitInkReport, splitInkReportText } from "./SplitInk";
import { installMethods } from "../inline/InstallMethods";
import type { HandwritingPlugin } from "../main";
import type { PageStore } from "./PageStore";
import type { PartDoneFollow } from "../settings/SettingsModel";

declare module "../main" {
	interface HandwritingPlugin {
		buildPageIdIndex(): void;
		checkPageIdentity(path: string): void;
		declaimLater(path: string): void;
		followEditedId(path: string, id: string): void;
		declaimNow(path: string): void;
		resolveIdentityCollision(path: string, id: string, v: Extract<RegisterVerdict, { kind: "duplicate" }>): void;
		recheckCollision(id: string): void;
		findOtherCarrier(id: string, exceptPath: string): string | null;
		resolveDuplicate(copyPath: string, id: string, ownerPath: string): Promise<void>;
		persistOwners(): void;
		recentPageIdFor(file: TFile): string | undefined;
		reportSplitInk(): Promise<void>;
		noteNamesForPages(pageIds: string[]): Map<string, string>;
		warnUnusablePageId(path: string): void;
		installId(): string;
		notePageId(path: string): string | null;
		claimNotePageId(path: string, proposedId: string, guard?: { file: TFile; markdown: string; current: () => boolean }): Promise<{ pageId: string; futureVersion?: number; content?: string }>;
	}
}

/**
 * How long a note's page id may be unreadable before we believe it is gone.
 *
 * Long enough to cover a frontmatter block being edited - Obsidian re-parses
 * on every keystroke and an unfinished property reports no frontmatter at all
 * - and short enough that a genuine removal frees the id while the user is
 * still doing whatever prompted it.
 *
 * Longer than Obsidian's own save-and-index delay: the editor saves on a 2 s
 * debounce and indexes a moment later, so a fix typed just after the block
 * went invalid is only readable ~2.35 s on. A 2 s grace declaimed first and
 * dropped the note's ink. A real removal waits 3 s longer, which
 * costs nothing.
 */
const DECLAIM_GRACE_MS = 5_000;

	// ---- duplicate page ids (v0.13.6) ---------------------------------------

	/**
	 * Startup census from the fully-resolved metadata cache. Unique ids
	 * register their owner. Collisions resolve against the persisted owner
	 * memory when it names one of the carriers (the copy was made while the
	 * app was closed); with no memory there is NO safe way to pick an
	 * original, so every carrier fails closed with a notice instead of
	 * either note or sidecar being rewritten on a guess.
	 */
	function buildPageIdIndex(this: HandwritingPlugin): void {
		const entries: { path: string; id: string }[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			const id = this.recentPageIdFor(f);
			if (id) entries.push({ path: f.path, id });
		}
		const { collisions } = this.pageIds.rebuild(entries);
		for (const [id, paths] of collisions) {
			const remembered = this.settings.pageOwners[id];
			if (remembered && paths.includes(remembered)) {
				this.pageIds.claimOwnership(id, remembered);
				for (const p of paths) {
					if (p !== remembered) {
						runDetached(
							this.resolveDuplicate(p, id, remembered),
							`repair duplicate page identity for ${p}`
						);
					}
				}
			} else {
				this.ambiguousIds.set(id, [...paths]);
				for (const p of paths) {
					const other = paths.find((q) => q !== p) ?? "another note";
					inlineInk.markDuplicateLocked(p, other);
				}
			}
		}
		resumeFollowsAtLaunch(this);
		this.persistOwners();
	}

	/**
	 * A page id move the app quit in the middle of (kept in the settings by
	 * followEditedId) is finished here, at the census, before anything else
	 * asks for the note's ink by its new id: the late ink and the deck are
	 * otherwise left under the old id where nothing reads them.
	 *
	 * The note is the one that carries the new id now. With no such note, the
	 * old id another note's, either id ambiguous, or the note locked, the entry
	 * is dropped and no file is touched. Otherwise both moves run as the timer
	 * rounds run them (moveIdFiles). Done, the note's ink is read again if it is
	 * already loaded, and an open deck is pointed at the new file, as follow()
	 * does. A move that throws sets what is left beside the new page as a listed
	 * copy (keepAsideUnder with no stamp); if that throws too, or the move asks
	 * to try again, the entry waits for the next launch.
	 */
	function resumeFollowsAtLaunch(plugin: HandwritingPlugin): void {
		// Settings not read through settingsFrom may lack the key: nothing kept.
		const kept = plugin.settings.partDoneFollows;
		if (plugin.settingsReadFailed || !kept) return;
		for (const [keptPath, entry] of Object.entries(kept)) {
			const { held, id } = entry;
			const path = plugin.pageIds.owner(id);
			const blocked = (): boolean => {
				const heldOwner = plugin.pageIds.owner(held);
				return (heldOwner !== undefined && heldOwner !== path) || plugin.ambiguousIds.has(held) || plugin.ambiguousIds.has(id) || (path !== undefined && inlineInk.isDuplicateLocked(path));
			};
			if (path === undefined || blocked()) {
				delete kept[keptPath];
				continue;
			}
			const forget = (): void => {
				if (kept[keptPath] !== entry) return;
				delete kept[keptPath];
				plugin.persistOwners();
			};
			const interrupted = (): "moved-on" | "retry" | null => {
				if (plugin.pageIds.owner(id) !== path) return "moved-on";
				if (blocked()) return "retry";
				return null;
			};
			const state: MoveState = { wrote: entry.wrote, keptLive: entry.keptLive, keepHeld: true, done: 0 };
			// A note names the old id again (its id set back, or a copy that carries it): its saves are its own, not late ones.
			const named = (): boolean => plugin.pageIds.owner(held) !== undefined || plugin.ambiguousIds.has(held);
			runDetached(
				moveIdFiles(plugin.store, path, held, id, state, interrupted, named).then(
					(outcome) => {
						if (outcome === "retry") return undefined;
						forget();
						if (outcome !== "moved") return undefined;
						const loaded = inlineInk.pageIdOf(path) !== null;
						if (loaded) inlineInk.handleDeclaimed(path);
						slidesNoteIdChanged(path, false, id, state.keepHeld);
						if (!loaded) return undefined;
						return inlineInk.ensureLoaded(path).then(() => {
							inkExternallyReloaded(path);
							notifyInkChanged(path);
						});
					},
					async (err) => {
						console.error("[handwriting] could not finish the page id move left part done at the last quit; setting the rest beside the new page", path, held, id, err);
						const pairs = ([[held, id], [slidesSidecarId(held), slidesSidecarId(id)]] as const).slice(state.done);
						try {
							for (const [from, to] of pairs) await plugin.store.keepAsideUnder(from, to);
						} catch (again) {
							console.error("[handwriting] could not set the old id's ink beside the new page; will try again at the next launch", path, held, id, again);
							return;
						}
						forget();
					}
				),
				`finish the page id move of ${path} left part done at the last quit`
			);
		}
	}

	/** A note's cached frontmatter changed: keep the ownership ledger true. */
	function checkPageIdentity(this: HandwritingPlugin, path: string): void {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		// Obsidian can read the frontmatter again, or the block is gone: a
		// claim refused on it goes ahead now and the strokes held since save.
		// A block Obsidian cannot parse still yields a first section of type
		// "yaml" and no frontmatter; while that holds, nothing is retried, so
		// a still-broken note is not rewritten or re-announced on every edit.
		const cache = this.app.metadataCache.getCache(path);
		if (cache && (cache.frontmatter !== undefined || cache.sections?.[0]?.type !== "yaml")) {
			inlineInk.retryRefusedClaim(path);
		}
		const id = this.recentPageIdFor(file);
		if (!id) {
			// NOT immediately. See declaimLater: an id that has merely gone
			// unreadable for a keystroke must not take the note's ink off
			// the screen.
			this.declaimLater(path);
			return;
		}
		// It is back, or it never went: cancel anything waiting to declaim.
		const pending = this.declaimTimers.get(path);
		if (pending !== undefined) {
			window.clearTimeout(pending);
			this.declaimTimers.delete(path);
		}
		// The note now carries another id than its record: the copy of an
		// ambiguous duplicate was fixed by editing its id value (the original's
		// lock lifts below), or the other device gave the note its own id. The
		// record still names the old one. Follow the new value once the edit
		// has settled, the same grace a deleted line gets: each half-typed id
		// is a value.
		const held = inlineInk.pageIdOf(path);
		if (held !== null && held !== id) {
			this.declaimLater(path);
		}
		// It came back after the grace ran out: frontmatter that stayed
		// unparseable longer than Obsidian's save-and-index delay. The record
		// was dropped, so read the sidecar again and repaint, rather than
		// leaving the note blank until it is reopened.
		if (this.declaimedPaths.delete(path)) {
			runDetached(
				inlineInk.ensureLoaded(path).then((changed) => {
					if (!changed) return;
					inkExternallyReloaded(path);
					notifyInkChanged(path);
				}),
				`reload ink for ${path} after its page id returned`
			);
		}
		// The note now carries a different id than an ambiguous one it shared:
		// the copy was fixed by editing its value. Re-check that collision, or
		// the original stays read-only all session.
		for (const [aid, paths] of [...this.ambiguousIds]) {
			if (aid !== id && paths.includes(path)) this.recheckCollision(aid);
		}
		const v = this.pageIds.register(path, id);
		if (v.kind === "registered") {
			this.persistOwners();
			return;
		}
		if (v.kind === "same") return;
		this.resolveIdentityCollision(path, id, v);
	}

	/**
	 * Give up a note's identity, but only once it stays given up.
	 *
	 * `handwriting-page-id` lives in YAML frontmatter, and Obsidian re-parses
	 * that on every keystroke. Adding a property, or fixing a typo, makes the
	 * block momentarily invalid - and an unparseable block reports NO
	 * frontmatter, which is indistinguishable here from "the id line was
	 * deleted". Acting on it dropped the session record, so the note's ink
	 * vanished mid-edit and did not come back until it was reopened.
	 *
	 * A real declaim is not urgent: nothing is lost by confirming it a moment
	 * later, and the confirmation is just asking again.
	 *
	 * The same timer settles a duplicate-locked copy's edited id value.
	 */
	function declaimLater(this: HandwritingPlugin, path: string): void {
		if (this.declaimTimers.has(path)) return;
		this.declaimTimers.set(
			path,
			window.setTimeout(() => {
				this.declaimTimers.delete(path);
				const file = this.app.vault.getFileByPath(path);
				if (!file) return;
				const id = this.recentPageIdFor(file);
				if (id) this.followEditedId(path, id); // it came back, or was edited
				else this.declaimNow(path);
			}, DECLAIM_GRACE_MS)
		);
	}

	/**
	 * A follow left part done, per plugin and note: the move it retries, how
	 * many timer rounds it has had, whether an earlier round already made the
	 * old Slides file the new id's live file, and the stamp of the bytes an
	 * earlier round made the new id's live inline file. Dropped once the move is
	 * done or the note moved on.
	 */
	const partDoneFollows = new WeakMap<HandwritingPlugin, Map<string, { held: string; id: string; rounds: number; keptLive: boolean; wrote?: string }>>();
	/** Timer retries of a part-done move; after them it waits for the next identity check (a text edit) or the next launch. */
	const PART_DONE_RETRIES = 3;

	/** The settings copy of a part-done move, for the next launch (resumeFollowsAtLaunch); null removes it. Rides persistOwners' write. */
	function keepFollowForLaunch(plugin: HandwritingPlugin, path: string, entry: PartDoneFollow | null): void {
		if (plugin.settingsReadFailed) return;
		const kept = plugin.settings.partDoneFollows as Record<string, PartDoneFollow> | undefined;
		if (entry === null) {
			if (!kept || !(path in kept)) return;
			delete kept[path];
		} else {
			(plugin.settings.partDoneFollows = kept ?? {})[path] = { held: entry.held, id: entry.id, rounds: entry.rounds, keptLive: entry.keptLive, ...(entry.wrote !== undefined ? { wrote: entry.wrote } : {}) };
		}
		plugin.persistOwners();
	}

	/**
	 * What one move carries across its steps: the stamp of what it last made the
	 * new id's live inline file, whether the old Slides file became the new
	 * id's live file (in this round or an earlier one), whether the deck's
	 * strokes are then the new id's own, and how many of the two files it has
	 * moved so far.
	 */
	type MoveState = { wrote?: string; keptLive: boolean; keepHeld: boolean; done: number };

	/**
	 * Both moves of a page id change, in order: the note's inline file, then
	 * its Slides file, each made the new id's live file or set beside it
	 * (PageStore.keepAsideUnder). `interrupted` is asked after each file: the
	 * note moved on, or the old id is no longer only this note's. Used by the
	 * timer rounds (followEditedId) and by the launch (resumeFollowsAtLaunch).
	 * `named` (the launch only): the store remembers each move, and follows a
	 * save that lands under the old id later only while this says no note
	 * names that id.
	 */
	async function moveIdFiles(
		store: PageStore,
		path: string,
		held: string,
		id: string,
		state: MoveState,
		interrupted: () => "moved-on" | "retry" | null,
		named?: () => boolean
	): Promise<"moved" | "retry" | "moved-on"> {
		const slidesHeld = slidesSidecarId(held);
		// The saves asked for under each old id so far. One asked for during the moves and already written lands a
		// new old-id file that nothing names, and leaves no queued write behind to say so.
		const asked = [held, slidesHeld].map((from) => store.scheduled.get(from) ?? 0);
		for (const [from, to] of [[held, id], [slidesHeld, slidesSidecarId(id)]] as const) {
			const kept = await store.keepAsideUnder(from, to, from === held ? state.wrote : undefined, named);
			if (from === held && kept.kind === "moved") state.wrote = kept.stamp;
			if (kept.kind !== "held") state.done++;
			const stopped = interrupted();
			if (stopped) return stopped;
			if (from === slidesHeld) {
				const live = kept.kind === "moved" && (await store.resolvePath(to)) === kept.to;
				state.keptLive = state.keptLive || live;
				state.keepHeld = kept.kind === "absent" || state.keptLive;
				const late = interrupted();
				if (late) return late;
			}
			// A stroke drawn while the file moved is queued under the old
			// id; the retry a grace later moves what it writes.
			if (kept.kind === "held" || store.hasQueuedWrite(from)) {
				console.error("[handwriting] could not move the old id's ink beside the new page; will try again", path, from, to);
				return "retry";
			}
		}
		// A note stroke lifted while the Slides file moved is saved under the old inline id, which the Slides step's
		// check does not ask about: ask about every step's old id once more before the follow, whether its save is
		// still queued or has already landed. The retry sets the new old-id file beside the new page.
		for (const [i, from] of [held, slidesHeld].entries()) {
			if (store.hasQueuedWrite(from) || (store.scheduled.get(from) ?? 0) !== asked[i]) {
				console.error("[handwriting] could not move the old id's ink beside the new page; will try again", path, from);
				return "retry";
			}
		}
		return "moved";
	}

	/**
	 * The note carries an id its record does not: the record moves to it and
	 * the note repaints from it.
	 *
	 * A duplicate-locked copy keeps the ink drawn on it while locked, and the
	 * shared id's file stays the original's. Any other record wrote this
	 * device's ink under the old id, and nothing names that file now: it is
	 * set beside the new page first (PageStore.keepAsideUnder), listed by fix
	 * ink de-sync against it, unless another note still names the old id, in
	 * which case it is that note's. The note's Slides file moves the same way,
	 * and an open presentation of it follows the new id.
	 *
	 * THE MOVE COMES FIRST. The record lets go of the old id only once both
	 * files have moved: a queue that will not write, or a stroke queued under
	 * the old id while a file moved, leaves the note writing under the old id,
	 * and the declaim timer tries again a grace later, with no text edit
	 * needed, up to PART_DONE_RETRIES times; after that, and after a move that
	 * throws, the next identity check tries again. The old id passing to
	 * another note during the move stops the round before its next file, and
	 * the retry takes the route that leaves that note's files where they are.
	 *
	 * Between the rounds the note keeps saving its whole page under the old id.
	 * When an earlier round made the old inline file the new id's live file and
	 * that file still holds what the round wrote, the retry puts the newer old
	 * file in its place, with no copy set aside: ink drawn or erased between the
	 * rounds stays as it is on screen. Changed since, the live file is kept and
	 * the old file set beside it, as for any file the new id already had.
	 *
	 * The open presentation keeps the strokes it holds when the old id's Slides
	 * file became the new id's live file, in this round or an earlier one. A
	 * later round then finds the deck's own save under the old id and sets it
	 * beside the live file as a listed copy; the deck keeps its strokes and its
	 * next save puts them in the live file too. Set aside beside a file the new
	 * id already had, or another note's, they leave the deck, or its next save
	 * writes them under the new id.
	 */
	function followEditedId(this: HandwritingPlugin, path: string, id: string): void {
		const held = inlineInk.pageIdOf(path);
		if (held === null || held === id) return;
		// The old id is this note's own: not locked, not another note's, not ambiguous.
		const ownsHeld = (): boolean => {
			const owner = this.pageIds.owner(held);
			return !inlineInk.isDuplicateLocked(path) && (owner === undefined || owner === path) && !this.ambiguousIds.has(held);
		};
		const keepAside = ownsHeld();
		const follow = (keepHeld: boolean): Promise<void> => {
			if (keepAside) {
				this.pageIds.release(path, held);
				this.persistOwners();
			}
			// Read before the declaim drops the record that holds the lock.
			const wasLocked = inlineInk.isDuplicateLocked(path);
			inlineInk.handleDeclaimed(path);
			// An open presentation of this note writes under the new id from now on; a locked copy's takes only the
			// ink drawn here, as its inline ink does. `keepHeld` false: the deck's strokes are not the new id's.
			slidesNoteIdChanged(path, wasLocked, id, keepHeld);
			return inlineInk.ensureLoaded(path).then(() => {
				inkExternallyReloaded(path);
				notifyInkChanged(path);
			});
		};
		let partDone = partDoneFollows.get(this);
		if (!partDone) {
			partDone = new Map();
			partDoneFollows.set(this, partDone);
		}
		const tracked = partDone;
		const prior = tracked.get(path);
		const earlier = prior !== undefined && prior.held === held && prior.id === id ? prior : null;
		if (!keepAside) {
			tracked.delete(path);
			keepFollowForLaunch(this, path, null);
			// The old id's Slides file is another note's, or shared: not this note's under the new id.
			runDetached(follow(false), `reload ink for ${path} under its edited page id`);
			return;
		}
		// The note's Slides ink sits in its own file under the old id and moves
		// the same way, or its presentation opens without the ink drawn here.
		// keepHeld: whether the old id's Slides file became the new id's live file (or there was none): the deck's strokes
		// are then the new id's own. keptLive: a round that made it the live file counts for every later round of the same
		// move. wrote: the stamp of what this move last made the new id's live inline file, in this round or an earlier one.
		const state: MoveState = { wrote: earlier?.wrote, keptLive: earlier?.keptLive ?? false, keepHeld: true, done: 0 };
		// The note moved on meanwhile (another edit, a close): this round is not
		// its follow any more. The old id passed to another note: stop before
		// the next file, and let the retry take the route that leaves it there.
		const interrupted = (): "moved-on" | "retry" | null => {
			if (inlineInk.pageIdOf(path) !== held) return "moved-on";
			if (!ownsHeld()) return "retry";
			return null;
		};
		runDetached(
			moveIdFiles(this.store, path, held, id, state, interrupted).then(
				(outcome) => {
					if (outcome !== "retry") {
						tracked.delete(path);
						keepFollowForLaunch(this, path, null);
					}
					if (outcome === "moved") return follow(state.keepHeld);
					if (outcome === "moved-on") return undefined;
					// Part done: the record stays on the old id. Try again a grace later, not at the next text edit,
					// a bounded number of times. The settings keep it too, so a quit before then leaves it to the next launch.
					const rounds = (earlier?.rounds ?? 0) + 1;
					const entry = { held, id, rounds, keptLive: state.keptLive, wrote: state.wrote };
					tracked.set(path, entry);
					keepFollowForLaunch(this, path, entry);
					if (rounds <= PART_DONE_RETRIES) this.declaimLater(path);
					return undefined;
				},
				(err) => {
					console.error("[handwriting] could not move the old id's ink beside the new page; will try again", path, held, id, err);
				}
			),
			`follow the edited page id of ${path}`
		);
	}

	function declaimNow(this: HandwritingPlugin, path: string): void {
		{
			// The id line really is gone (duplicate resolution by hand, or an
			// external edit). Free anything this path owned, drop its stale
			// session record, and re-check collisions it participated in.
			// Ink a duplicate lock held back is carried to a fresh id.
			const freed = this.pageIds.handleDelete(path);
			const wasLocked = inlineInk.isDuplicateLocked(path);
			inlineInk.handleDeclaimed(path);
			// An open Slides deck on this note follows at the same moment.
			slidesNoteIdChanged(path, wasLocked);
			if (inlineInk.hasInk(path)) {
				runDetached(
					inlineInk.ensureLoaded(path).then(() => {
						inkExternallyReloaded(path);
						notifyInkChanged(path);
					}),
					`repaint ink carried off ${path}'s shared page id`
				);
			}
			this.declaimedPaths.add(path);
			for (const fid of freed) {
				const other = this.findOtherCarrier(fid, path);
				if (other) {
					this.pageIds.claimOwnership(fid, other);
					inlineInk.clearDuplicateLock(other);
					slidesNoteIdChanged(other);
				}
			}
			for (const [aid, paths] of [...this.ambiguousIds]) {
				if (paths.includes(path)) this.recheckCollision(aid);
			}
			if (freed.length > 0) this.persistOwners();
			return;
		}
	}

	function resolveIdentityCollision(this: HandwritingPlugin,
		path: string,
		id: string,
		v: Extract<RegisterVerdict, { kind: "duplicate" }>
	): void {
		// Duplicate sighting. Verify the recorded owner still exists and
		// still carries the id. If not, ownership transfers instead.
		const ownerFile = this.app.vault.getFileByPath(v.ownerPath);
		const ownerId = ownerFile ? this.recentPageIdFor(ownerFile) : null;
		if (ownerId !== id) {
			this.pageIds.transfer(id, path);
			this.persistOwners();
			return;
		}
		runDetached(
			this.resolveDuplicate(path, id, v.ownerPath),
			`repair duplicate page identity for ${path}`
		);
	}

	/** Ambiguous set changed: if exactly one carrier remains, it owns the id. */
	function recheckCollision(this: HandwritingPlugin, id: string): void {
		const paths = this.ambiguousIds.get(id);
		if (!paths) return;
		const carriers = paths.filter((p) => {
			const f = this.app.vault.getFileByPath(p);
			return f !== null && this.recentPageIdFor(f) === id;
		});
		if (carriers.length === 1) {
			this.ambiguousIds.delete(id);
			this.pageIds.claimOwnership(id, carriers[0]!);
			inlineInk.clearDuplicateLock(carriers[0]!);
			slidesNoteIdChanged(carriers[0]!);
			this.persistOwners();
		} else if (carriers.length === 0) {
			this.ambiguousIds.delete(id);
		}
	}

	/** Cached-metadata scan for another note carrying `id` (event paths only). */
	function findOtherCarrier(this: HandwritingPlugin, id: string, exceptPath: string): string | null {
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (f.path === exceptPath) continue;
			if (this.recentPageIdFor(f) === id) return f.path;
		}
		return null;
	}

	/**
	 * The copy at `copyPath` shares `id` with the original at `ownerPath`.
	 * Resolution order is chosen so no step can lose ink: the shared sidecar
	 * is CLONED under a fresh id first (source read-only; an interrupted run
	 * leaves at worst an orphan clone), then the copy's frontmatter is
	 * re-identified atomically, then live session state follows. The
	 * original note and its sidecar are never written.
	 *
	 * Every step after an await names the copy by `file.path`, not
	 * `copyPath`: the copy can be renamed while the clone or the rewrite is in
	 * flight, the TFile follows the rename, and the live record has already
	 * moved to the new path (the vault "rename" handler).
	 */
	async function resolveDuplicate(this: HandwritingPlugin,
		copyPath: string,
		id: string,
		ownerPath: string
	): Promise<void> {
		const file = this.app.vault.getFileByPath(copyPath);
		if (!file) return;
		if (this.resolvingDuplicates.has(file)) return;
		this.resolvingDuplicates.add(file);
		try {
			const newId = newPageId();
			let cloned: "cloned" | "none" | "unreadable" | "exists";
			let slidesCloned = false;
			try {
				// A save queued under the shared id that no live record names
				// the id for - the copy has no record on this id (a sync deleted
				// and recreated the note, which dropped the record that drew it)
				// and the owner has no live record either - holds strokes no file
				// has yet, and the old id's queue is dropped further down. Write
				// it under its own id first, the save it was going to make
				// anyway, so the clone below reads them and nothing is lost. The
				// write guard still keeps a newer external file aside. A queue
				// the copy's own record made follows that record to the new id
				// (reassignPage). A live owner's record saves its own waiting
				// stroke under the shared id, and the copy is the shared page as
				// it stood on disk: both are left alone exactly as before. The
				// owner is the one the ledger names now (it follows a rename),
				// and live is reassignPage's own test: a record with a page id.
				const ownerNow = this.pageIds.owner(id) ?? ownerPath;
				const ownerLive = ownerNow !== file.path && !!inlineInk.pageIdOf(ownerNow);
				if (!ownerLive && inlineInk.pageIdOf(file.path) !== id && this.store.hasQueuedWrite(id)) {
					if (!(await this.store.flushPage(id))) {
						inlineInk.markDuplicateLocked(file.path, ownerPath);
						return; // the save is re-queued for its retry: never clone without it
					}
				}
				cloned = await this.store.clone(id, newId);
				// A note can hold Slides ink and no inline ink: its Slides
				// file is copied too, or the copy's Slides view opens blank.
				if (cloned === "cloned" || cloned === "none") {
					const slides = await this.store.clone(slidesSidecarId(id), slidesSidecarId(newId));
					if (slides === "exists" || slides === "unreadable") {
						inlineInk.markDuplicateLocked(file.path, ownerPath);
						return;
					}
					slidesCloned = slides === "cloned";
				}
			} catch (err) {
				console.error("[handwriting] duplicate sidecar clone failed", err);
				inlineInk.markDuplicateLocked(file.path, ownerPath);
				return; // fail closed: locked beats half-resolved
			}
			if (cloned === "exists") {
				inlineInk.markDuplicateLocked(file.path, ownerPath);
				return;
			}
			let outcome: { changed: boolean; futureVersion?: number } = { changed: false };
			await this.app.vault.process(file, (data) => {
				const r = reassignMarkdown(data, newId);
				outcome = { changed: r.changed, futureVersion: r.futureVersion };
				return r.content;
			});
			if (!outcome.changed) {
				// The id line vanished meanwhile (nothing to do) or the note
				// declares a newer format (never write): clean the unused clone.
				if (cloned === "cloned") await this.store.remove(newId).catch(() => undefined);
				if (slidesCloned) await this.store.remove(slidesSidecarId(newId)).catch(() => undefined);
				if (outcome.futureVersion !== undefined) {
					inlineInk.markDuplicateLocked(file.path, ownerPath);
				}
				return;
			}
			// The original can be renamed while the clone or the rewrite is in
			// flight, too: the id ledger follows the rename, so ask it where the
			// owner is now. The copy itself never counts as the owner: then
			// there is none, and no note has the empty path.
			const current = this.pageIds.owner(id) ?? ownerPath;
			const owner = current === file.path ? "" : current;
			this.pageIds.register(file.path, newId);
			const verdict = inlineInk.reassignPage(file.path, newId, owner);
			slidesNoteIdChanged(file.path, false, newId);
			// Anything the copy queued under the OLD id before resolution is
			// orphaned. Discard it only when this session provably has no other
			// writer for that id (no live owner record).
			if (verdict === "old-queue-orphaned") {
				this.store.discardPending(id);
			}
			const cam = this.settings.cameras[id];
			if (cam) this.settings.cameras[newId] = { ...cam };
			this.persistOwners();
			new Notice(
				`Handwriting: "${file.basename}" was a copy of another Handwriting note. It now has its own ink identity` +
					(cloned === "cloned" || slidesCloned
						? " and an independent copy of the ink."
						: cloned === "unreadable"
							? ". Its ink could not be copied because the source file is unreadable. The original was left untouched."
							: ".")
			);
		} finally {
			this.resolvingDuplicates.delete(file);
		}
	}

	/** Ownership memory rides the ordinary debounced settings flush. */
	function persistOwners(this: HandwritingPlugin): void {
		this.settings.pageOwners = this.pageIds.snapshot();
		// The file could not be read at launch: writing it would put this
		// session's defaults over the settings it still holds.
		if (this.settingsReadFailed) return;
		this.settingsDirty = true;
		if (this.settingsTimer !== null) window.clearTimeout(this.settingsTimer);
		this.settingsTimer = window.setTimeout(
			() => runDetached(this.flushSettings(), "flush ownership settings"),
			2000
		);
	}

	/**
	 * Best-effort page id for a file that has just been deleted. Deliberately
	 * conservative: if we cannot prove which sidecar belongs to it, we keep the
	 * sidecar. An orphaned file is recoverable; deleted ink is not.
	 */
	function recentPageIdFor(this: HandwritingPlugin, file: TFile): string | undefined {
		const cache = this.app.metadataCache.getCache(file.path);
		const fm = cache?.frontmatter;
		const id: unknown = fm?.["handwriting-page-id"];
		// The other frontmatter ingress, and the one the ownership ledger,
		// the duplicate check and sidecar deletion all read through. An id
		// that cannot be a path name is not an identity here either; see
		// isSafePageId.
		return isSafePageId(id) ? id : undefined;
	}

	/**
	 * Look for notes whose ink ended up in two folders, and show what was
	 * found. LOOKS ONLY - see SplitInk.ts. The adapter handed to the
	 * detector carries exists, list and read and nothing else, so no code
	 * path from this command can write, rename, create or delete anything.
	 *
	 * The three outcomes are deliberately three DIFFERENT reports. "Could
	 * not look" must never render as "nothing found": a vault whose adapter
	 * will not enumerate is exactly the vault most likely to be carrying the
	 * fork, and telling its owner they are clean is the worst answer
	 * available.
	 */
	async function reportSplitInk(this: HandwritingPlugin): Promise<void> {
		const adapter = this.app.vault.adapter;
		let report: SplitInkReport;
		try {
			report = await findSplitInk(
				{
					exists: (p) => adapter.exists(p),
					list:
						typeof adapter.list === "function" ? (p) => adapter.list(p) : undefined,
					read: (p) => adapter.read(p),
				},
				this.settings.inkFolder
			);
		} catch (err) {
			// Even a thrown scan is an "I could not look", never a clean bill.
			console.error("[handwriting] split-ink check failed", err);
			report = {
				folders: [],
				scanned: 0,
				split: [],
				identicalOnly: 0,
				unreadable: [],
				enumerable: false,
			};
		}
		const names = this.noteNamesForPages(report.split.map((p) => p.pageId));
		new DiagnosticTextModal(
			this.app,
			"Ink split across folders",
			splitInkReportText(report, names)
		).open();
		new Notice(
			!report.enumerable
				? "Handwriting: could not list this vault, so nothing was checked"
				: report.split.length === 0
					? "Handwriting: no ink is split across folders"
					: "Handwriting: ink is split across folders - nothing was changed"
		);
	}

	/**
	 * Vault paths for the notes carrying these page ids.
	 *
	 * The sweep is over every markdown file's cached frontmatter, so it runs
	 * ONLY for pages already known to be split - never once per sidecar. On
	 * a clean vault (the overwhelmingly common case) the id list is empty
	 * and this returns without touching the file list at all.
	 */
	function noteNamesForPages(this: HandwritingPlugin, pageIds: string[]): Map<string, string> {
		const out = new Map<string, string>();
		const wanted = new Set(pageIds);
		if (wanted.size === 0) return out;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const id = this.recentPageIdFor(file);
			if (id !== undefined && wanted.has(id) && !out.has(id)) out.set(id, file.path);
		}
		return out;
	}

	/**
	 * Say once, per note, that its `handwriting-page-id` cannot be used.
	 *
	 * Once, because readPageId runs on every attach and every frontmatter
	 * change: a notice per call would be a wall. The note is otherwise
	 * untouched - nothing is rewritten until the user actually draws.
	 */
	function warnUnusablePageId(this: HandwritingPlugin, path: string): void {
		if (this.badPageIds.has(path)) return;
		this.badPageIds.add(path);
		new Notice(
			`Handwriting: the handwriting-page-id in ${path} is not a usable id, so this note counts as having no ink yet. Drawing on it will assign a new one.`
		);
	}

	/**
	 * This install's id: made once, kept in Obsidian's per-device local
	 * storage (never data.json, which syncs). Names the device that wrote a
	 * recovery pair, so a device reading a synced pair knows its own side.
	 */
	function installId(this: HandwritingPlugin): string {
		const key = "handwriting-install-id";
		const known = this.app.loadLocalStorage(key) as unknown;
		if (typeof known === "string" && known.length > 0) return known;
		const id = newPageId();
		this.app.saveLocalStorage(key, id);
		return id;
	}

	/**
	 * Read a note's claimed page id out of frontmatter, or null.
	 *
	 * Lifted out of the inline host's own closure when the slides surface
	 * arrived, so the two surfaces read the id through ONE function: a note
	 * presented as slides and a note written on directly must agree about
	 * what its id is, and two copies of this predicate would be the shape of
	 * the divergence InkSurfaces.ts is about.
	 */
	function notePageId(this: HandwritingPlugin, path: string): string | null {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return null;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const id = fm?.["handwriting-page-id"] as unknown;
		// Frontmatter is text a person or a sync peer typed, and this
		// id goes straight into a sidecar path. Anything outside
		// isSafePageId is not "a page with an odd name": the note
		// counts as unclaimed, so the next stroke mints a fresh id
		// and the ink lands in the ink folder like everyone else's.
		if (typeof id === "string" && id.length > 0 && !isSafePageId(id)) {
			this.warnUnusablePageId(path);
			return null;
		}
		return isSafePageId(id) ? id : null;
	}

	/**
	 * Atomically stamp (or discover) a note's page id. The ONE Markdown write
	 * the ink model makes, and the only one - shared by the inline surface and
	 * the slides surface so a note claimed by drawing on a slide is claimed
	 * exactly the way a note claimed by writing on it is.
	 */
	async function claimNotePageId(this: HandwritingPlugin,
		path: string,
		proposedId: string,
		guard?: { file: TFile; markdown: string; current: () => boolean }
	): Promise<{ pageId: string; futureVersion?: number; content?: string }> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) throw new Error(`Handwriting: no file at ${path}`);
		let out: { pageId: string; futureVersion?: number; content?: string } = { pageId: proposedId };
		await this.app.vault.process(file, (data) => {
			if (guard && (file !== guard.file || !guard.current() || data !== guard.markdown))
				throw new Error("This canvas changed before its page identity could be saved.");
			// A block Obsidian cannot parse: refuse rather than write an id no
			// read will ever see. An empty block reports no frontmatter too,
			// but it is valid and an id written into it is read.
			if (
				this.app.metadataCache.getFileCache(file)?.frontmatter === undefined &&
				hasFrontmatterBlock(data) &&
				!hasEmptyFrontmatterBlock(data)
			) {
				throw new UnreadableFrontmatterError();
			}
			const r = claimMarkdown(data, proposedId);
			out = { pageId: r.pageId, futureVersion: r.futureVersion, content: r.content };
			return r.content;
		});
		// A claim is a first sighting for the ownership ledger. The note
		// that mints an id owns it (duplicate detection, v0.13.6). Before the
		// startup census the ledger holds only such claims, and saving it
		// would replace the owner memory the census still has to read; the
		// census saves the whole ledger, this claim included, when it runs.
		if (out.futureVersion === undefined) {
			if (this.pageIds.register(path, out.pageId).kind === "registered" && this.pageIdWatchReady) {
				this.persistOwners();
			}
		}
		return out;
	}

export function installPageIdentity(proto: HandwritingPlugin): void {
	installMethods(proto, {
		buildPageIdIndex,
		checkPageIdentity,
		declaimLater,
		followEditedId,
		declaimNow,
		resolveIdentityCollision,
		recheckCollision,
		findOtherCarrier,
		resolveDuplicate,
		persistOwners,
		recentPageIdFor,
		reportSplitInk,
		noteNamesForPages,
		warnUnusablePageId,
		installId,
		notePageId,
		claimNotePageId,
	});
}
