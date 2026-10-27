/**
 * Page identity and ownership: the startup census of page ids, edit and removal tracking, the duplicate-id resolution, the
 * persisted owner memory, the recent-id lookup, the split-ink report and the note page-id claim. The methods are methods of
 * HandwritingPlugin, installed on its prototype when main.ts loads (installPageIdentity at its bottom). Bodies moved
 * unchanged from the class. This file imports only types from main.
 */
import { Notice, TFile } from "obsidian";
import { slidesSidecarId } from "../slides/SlidesInkSurface";
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
		this.persistOwners();
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
	 * The note carries an id its record does not: the record moves to it and
	 * the note repaints from it.
	 *
	 * A duplicate-locked copy keeps the ink drawn on it while locked, and the
	 * shared id's file stays the original's. Any other record wrote this
	 * device's ink under the old id, and nothing names that file now: it is
	 * set beside the new page first (PageStore.keepAsideUnder), listed by fix
	 * ink de-sync against it, unless another note still names the old id, in
	 * which case it is that note's.
	 *
	 * THE MOVE COMES FIRST. The record lets go of the old id only once the
	 * file has moved: a move that fails, or a queue that will not write,
	 * leaves the note writing under the old id, and the next identity check
	 * (the note still carries another id than its record) tries again.
	 */
	function followEditedId(this: HandwritingPlugin, path: string, id: string): void {
		const held = inlineInk.pageIdOf(path);
		if (held === null || held === id) return;
		const owner = this.pageIds.owner(held);
		const keepAside =
			!inlineInk.isDuplicateLocked(path) &&
			(owner === undefined || owner === path) &&
			!this.ambiguousIds.has(held);
		const follow = (): Promise<void> => {
			if (keepAside) {
				this.pageIds.release(path, held);
				this.persistOwners();
			}
			inlineInk.handleDeclaimed(path);
			return inlineInk.ensureLoaded(path).then(() => {
				inkExternallyReloaded(path);
				notifyInkChanged(path);
			});
		};
		if (!keepAside) {
			runDetached(follow(), `reload ink for ${path} under its edited page id`);
			return;
		}
		runDetached(
			this.store.keepAsideUnder(held, id).then(
				(kept) => {
					// The note moved on meanwhile (another edit, a close): this
					// round is not its follow any more.
					if (inlineInk.pageIdOf(path) !== held) return;
					// A stroke drawn while the file moved is queued under the old
					// id; the next identity check moves what it writes.
					if (kept.kind === "held" || this.store.hasQueuedWrite(held)) {
						console.error("[handwriting] could not move the old id's ink beside the new page; will try again", path, held, id);
						return;
					}
					return follow();
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
			inlineInk.handleDeclaimed(path);
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
				cloned = await this.store.clone(id, newId);
				if (cloned === "cloned") {
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
			this.pageIds.register(file.path, newId);
			const verdict = inlineInk.reassignPage(file.path, newId, ownerPath);
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
					(cloned === "cloned"
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
		// that mints an id owns it (duplicate detection, v0.13.6).
		if (out.futureVersion === undefined) {
			if (this.pageIds.register(path, out.pageId).kind === "registered") {
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
