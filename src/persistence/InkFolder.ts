/**
 * Where the ink sidecars live, and how to move them without losing any.
 *
 * `.handwriting` was chosen so the ink stays out of the way: dot-folders are
 * invisible in the file explorer and Obsidian does not index them. The cost
 * only showed up once people had two devices - **Obsidian Sync ignores
 * dot-folders**, so ink written on a tablet never reached the desktop and
 * looked like data loss (reported on release day, 2026-08-27, by a user who
 * diagnosed it himself and moved his ink to an ordinary folder).
 *
 * So the folder becomes a setting. The default does not change, because
 * changing where existing vaults keep their ink without being asked is worse
 * than the problem. Anyone who wants their ink synced points this at a name
 * without the leading dot.
 *
 * Everything here is pure or takes its filesystem as an argument, so the
 * rules that protect the files are testable without a vault.
 */

export const DEFAULT_INK_FOLDER = ".handwriting";

/**
 * Where the ink goes when someone asks for it to sync: the same name without
 * the dot. Not configurable, because the only question worth asking is
 * "should Obsidian Sync be able to see this", and a free-text path invites
 * typos into a setting that moves files.
 */
export const SYNCED_INK_FOLDER = "handwriting";

/**
 * A settings field is a text box, and a text box eventually contains
 * anything. This is the only thing standing between a typo and the plugin
 * writing ink outside the vault, so it is deliberately strict: no absolute
 * paths, no `..`, no drive letters, no empty string. Anything it cannot make
 * safe becomes the default rather than an error, because the failure mode of
 * refusing is a plugin that cannot save at all.
 */
export function normalizeInkFolder(raw: unknown): string {
	if (typeof raw !== "string") return DEFAULT_INK_FOLDER;
	const cleaned = raw.trim().replace(/\\/g, "/");
	if (cleaned === "") return DEFAULT_INK_FOLDER;
	if (/^[a-zA-Z]:/.test(cleaned)) return DEFAULT_INK_FOLDER;
	const parts = cleaned.split("/").filter((p) => p !== "" && p !== ".");
	if (parts.length === 0) return DEFAULT_INK_FOLDER;
	if (parts.some((p) => p === "..")) return DEFAULT_INK_FOLDER;
	return parts.join("/");
}

/**
 * Which folder to start on when there is no `data.json` to ask.
 *
 * The folder choice lives ONLY in `data.json`, and Obsidian Sync does not
 * carry that file unless plugin settings are switched on. So the second
 * device in a sync-compatibility vault - or the first one after a settings
 * file is lost, a vault is copied, or the plugin is reinstalled - starts on
 * `.handwriting` while every sidecar sits in `handwriting/` beside it. It
 * reads nothing, and then writes a SECOND sidecar for every page id it is
 * asked to save. `PageStore.findSidecar` keeps the existing ink visible (there
 * is no `readPath`, and has not been for some time); this is what stops the
 * fork, by pointing writes at the folder the vault is plainly already using.
 *
 * The question asked is "which folder HOLDS INK", not "which folder
 * exists". Existence is the wrong test because anything at all can create
 * `.handwriting` - the OCR line downloads its local model into it - and an
 * empty folder appearing beside a populated `handwriting/` used to hand the
 * vault straight back to the default and re-arm the fork this function
 * exists to stop. A folder counts when it holds at least one LIVE PAGE FILE;
 * a model blob, a stray `.md`, or nothing at all does not count.
 *
 * Nor does the wreckage of an earlier fork. `*.json` was too loose: a
 * `.handwriting/X.conflict-<mtime>.json` or `.damaged-<mtime>.json` is
 * exactly what the shipped 1.4.9-1.4.11 fork and the external-revision guard
 * leave behind, so a dot-folder holding nothing but one of those was read as
 * "this vault keeps its ink here" and the device adopted `.handwriting`
 * although every real page sat in `handwriting/`. Every NEW page id on that
 * device then went to the unsynced folder and forked on the next device -
 * the very sequence adoption exists to end. `isLiveSidecarName` is the
 * filter `PageStore.listIds` uses to enumerate pages, shared so the two can
 * never drift apart.
 *
 * `.handwriting` still wins when BOTH hold pages - deliberately unchanged.
 * Two populated folders is a state somebody has to look at, and picking the
 * default keeps that decision where the settings tab can make it; the read
 * fallback means neither folder's ink is hidden meanwhile.
 *
 * An adapter that cannot list, or a folder that will not enumerate, falls
 * back to plain existence, which is exactly the answer this function gave
 * before. Not being able to look inside is no reason to change the choice.
 */
export async function adoptInkFolder(
	adapter: Pick<MigrationAdapter, "exists" | "list">
): Promise<string> {
	if (await holdsSidecars(adapter, DEFAULT_INK_FOLDER)) return DEFAULT_INK_FOLDER;
	if (await holdsSidecars(adapter, SYNCED_INK_FOLDER)) return SYNCED_INK_FOLDER;
	// Neither holds a page. The folders themselves are still the best hint
	// available about which one this vault means to use.
	if (await adapter.exists(DEFAULT_INK_FOLDER)) return DEFAULT_INK_FOLDER;
	if (await adapter.exists(SYNCED_INK_FOLDER)) return SYNCED_INK_FOLDER;
	return DEFAULT_INK_FOLDER;
}

/**
 * The name of a LIVE page file: what `PageStore.listIds` counts as a sidecar,
 * and what `adoptInkFolder` counts as evidence that a folder holds ink.
 *
 * The recovery copies are deliberately NOT live pages. `<id>.conflict-<mtime>`
 * and `<id>.damaged-<mtime>` (PageStore.ts freeConflictPath, freeDamagedPath)
 * are the residue of an accident, one of them being the residue of the very
 * fork this release closes; a folder holding only residue holds no pages.
 * `.json.tmp` fails the suffix test and is excluded with them.
 *
 * Separate from `isSidecarFile`, which answers a different question - "is this
 * file ours to MOVE when the folder changes" - where the answer for the
 * recovery copies is yes, because they are what someone reaches for after an
 * accident and orphaning them is how they get lost.
 */
export function isLiveSidecarName(name: string): boolean {
	return name.endsWith(".json") && !name.includes(".conflict-") && !name.includes(".damaged-");
}

/** Is there ink in this folder - a live page file, not merely a directory? */
async function holdsSidecars(
	adapter: Pick<MigrationAdapter, "exists" | "list">,
	folder: string
): Promise<boolean> {
	if (!(await adapter.exists(folder))) return false;
	if (!adapter.list) return true;
	try {
		const listing = await adapter.list(folder);
		return listing.files.some((f) => isLiveSidecarName(baseName(f)));
	} catch {
		return true;
	}
}

/**
 * Will a folder of this name reach other devices? Dot-folders do not: that
 * is the whole reason this setting exists, and the settings tab says so
 * rather than making people find out by losing a week of notes.
 */
export function inkFolderSyncs(folder: string): boolean {
	return !folder.split("/").some((p) => p.startsWith("."));
}

/**
 * Files this plugin owns in its folder.
 *
 * Pages and interrupted writes, plus the recovery copies: `.damaged-<mtime>`
 * holds bytes that would not parse and `.conflict-<mtime>` holds a revision
 * that arrived from elsewhere. Those are exactly what someone reaches for
 * after an accident, so a folder change must take them along rather than
 * orphan them in a hidden directory the user believes they moved out of.
 */
export function isSidecarFile(name: string): boolean {
	// A damaged or conflict copy is named `<id>.damaged-<mtime>.json` or
	// `<id>.conflict-<mtime>[-<n>].json` (PageStore.ts freeDamagedPath,
	// freeConflictPath) - always ending in ".json", so the first clause
	// already accepts it. There is no separate case to match here; a
	// `/\.(damaged|conflict)-\d+$/` clause (no trailing ".json") could never
	// have matched a name the store actually produces (audit-fixes-design.md
	// 5i I3).
	return name.endsWith(".json") || name.endsWith(".json.tmp");
}

/**
 * Create a folder and every parent it needs.
 *
 * The setting accepts nested paths like `assets/ink`, and a single mkdir of
 * the whole path fails when the parent does not exist - which would leave
 * every sidecar write failing with the ink only in memory. Each segment is
 * created in turn, and an existing segment is left alone.
 */
export async function ensureFolder(adapter: MigrationAdapter, folder: string): Promise<void> {
	const parts = folder.split("/").filter((p) => p !== "");
	let sofar = "";
	for (const part of parts) {
		sofar = sofar === "" ? part : `${sofar}/${part}`;
		if (!(await adapter.exists(sofar))) {
			try {
				await adapter.mkdir(sofar);
			} catch (err) {
				// Per-page write chains run different pages' first writes
				// concurrently, so two of these can both see "missing" and
				// both mkdir. Losing the race to CREATE the folder is
				// winning: it exists. Anything else is a real failure.
				if (!(await adapter.exists(sofar))) throw err;
			}
		}
	}
}

/** The last path segment, for moving a file between folders by name. */
export function baseName(path: string): string {
	const parts = path.replace(/\\/g, "/").split("/");
	return parts[parts.length - 1] ?? path;
}

export interface MigrationAdapter {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	list?(path: string): Promise<{ files: string[]; folders: string[] }>;
}

export interface MigrationResult {
	moved: number;
	/** Left where they were because the destination already had that name. */
	skipped: number;
	/** True when the adapter cannot enumerate, so nothing was attempted. */
	unsupported: boolean;
	/** Startup collisions relocated as recovery files, never as live pages. */
	preserved?: number;
}

/**
 * Move every sidecar from one folder to another.
 *
 * Rules, in the order they matter:
 *
 * 1. Never overwrite. A name already present at the destination is left
 *    alone and counted as skipped - two files claiming one page id is a
 *    problem to be looked at, not resolved by clobbering one of them.
 *    Automatic startup reconciliation opts into preserving those collisions
 *    under recovery names, so a retry cannot recreate a removed live file.
 * 2. Move, never copy-then-delete. A rename either happened or did not; a
 *    copy that fails halfway through leaves two partial truths.
 * 3. Only our own files. `isSidecarFile` gates it, so a folder someone
 *    shares with other content keeps that content.
 * 4. The recovery copies and `trash/` travel with the pages - they are what
 *    someone reaches for after an accident, and leaving them in a hidden
 *    folder the user thinks they moved out of is how they get lost.
 * 5. The old DIRECTORY is never deleted, only emptied of our files. Removing
 *    a folder the user may have put something in is not our business.
 *
 * A throw part-way leaves every unmoved file exactly where it was, which is
 * why the caller can surface the error and let the user try again.
 */
export async function migrateInkFolder(
	adapter: MigrationAdapter,
	from: string,
	to: string,
	options: { preserveCollisions?: boolean } = {}
): Promise<MigrationResult> {
	const idle: MigrationResult = { moved: 0, skipped: 0, unsupported: false };
	if (from === to) return idle;
	if (!adapter.list) return { ...idle, unsupported: true };
	if (!(await adapter.exists(from))) return idle;
	const listing = await adapter.list(from);
	const sidecars = listing.files.filter((f) => isSidecarFile(baseName(f)));
	// The destination is created even when there is nothing to move, so the
	// folder the completion notice names is a folder that exists.
	await ensureFolder(adapter, to);
	let moved = 0;
	let skipped = 0;
	let preserved = 0;
	for (const file of sidecars) {
		const target = `${to}/${baseName(file)}`;
		if (await adapter.exists(target) || (options.preserveCollisions && target.endsWith(".json.tmp") && await adapter.exists(target.slice(0, -4)))) {
			if (options.preserveCollisions) {
				// Startup retries must not later promote a rejected revision when
				// sync removes the live destination. Retire its live (or .tmp)
				// name by rename, retaining every byte under a recovery name.
				const base = `${target.replace(/\.json(?:\.tmp)?$/, "")}.conflict-migration-${Date.now()}`;
				let recovery = `${base}.json`, n = 1;
				while (await adapter.exists(recovery)) recovery = `${base}-${n++}.json`;
				await adapter.rename(file, recovery);
				preserved++;
				continue;
			}
			skipped++;
			continue;
		}
		await adapter.rename(file, target);
		moved++;
	}
	// The trash holds the pre-delete safety copies. It travels too, for the
	// same reason the damaged copies do: it is what recovery uses.
	const trash = `${from}/trash`;
	if (listing.folders.includes(trash) && (await adapter.exists(trash))) {
		const inTrash = await adapter.list(trash);
		if (inTrash.files.length > 0) {
			await ensureFolder(adapter, `${to}/trash`);
			for (const file of inTrash.files) {
				const target = `${to}/trash/${baseName(file)}`;
				if (await adapter.exists(target)) {
					skipped++;
					continue;
				}
				await adapter.rename(file, target);
				moved++;
			}
		}
	}
	return { moved, skipped, unsupported: false, ...(preserved > 0 ? { preserved } : {}) };
}

export interface FolderChangeSteps {
	/** Resolves false when writes are still in flight. */
	settle(): Promise<boolean>;
	/**
	 * Hold writes for the duration of the move: they requeue instead of
	 * landing in the folder being emptied. Settling is not enough on its own -
	 * it drains the queue ONCE, and the move that follows spans a list plus a
	 * rename per file with a pen still able to land in between.
	 */
	holdWrites?(): void;
	/** Release the hold. Called from a `finally`, so it always runs. */
	releaseWrites?(): void;
	migrate(from: string, to: string): Promise<MigrationResult>;
	/** Send reads and writes to the new folder. */
	repoint(to: string): void;
	/** Persist the choice. May reject. */
	persist(to: string): Promise<void>;
}

export type FolderChangeOutcome =
	| { kind: "unchanged" }
	| { kind: "busy" }
	| { kind: "unsupported" }
	| { kind: "moved"; result: MigrationResult };

/**
 * The folder change, as a sequence that can be asserted.
 *
 * The order is the safety story and it is enforced by nothing but statement
 * order, which is exactly the kind of guarantee a later edit quietly breaks:
 *
 * 1. Settle first. A write still in flight can land in the folder about to be
 *    emptied, stranding the newest strokes.
 * 2. HOLD writes across the move and the repoint. Settling drains the queue
 *    once; the move that follows spans a list plus a rename per file, and a
 *    pen landing in that window recreated the sidecar in the folder being
 *    emptied - after which the repoint cleared the pins, the next resolve
 *    served the older migrated copy, and the newest ink was orphaned.
 * 3. Move before repointing. Repointing first sends reads to a folder the
 *    files have not reached yet.
 * 4. Persist last, so a failed save cannot claim a move that did not happen.
 *
 * WHAT AN INTERRUPTION ACTUALLY COSTS. This used to claim "an interruption
 * anywhere leaves pages readable", on the strength of the read fallback. That
 * is true for a move between the two WELL-KNOWN folders and false for a custom
 * one: `PageStore.findSidecar` searches the configured folder plus
 * `.handwriting` and `handwriting`, and nothing else. So a move to
 * `assets/ink` that dies between the migration and the settings save leaves
 * the store pointed at the old folder while the files sit in the new one, and
 * those pages read as ABSENT - which the plugin shows as blank notes.
 *
 * Nothing is lost: every file is exactly where the migration put it. The
 * recovery is one step, and it is the user's: set the ink folder to the
 * destination in Settings. The pages come back on the next open; nothing has
 * to be moved by hand.
 *
 * Widening the read search to arbitrary remembered folders is deliberately NOT
 * the fix - it would put a speculative probe on every miss, for a window that
 * only opens if a settings save fails. The ordering above is the guarantee,
 * and unlike the old claim it is testable.
 */
export async function changeFolder(
	steps: FolderChangeSteps,
	from: string,
	to: string
): Promise<FolderChangeOutcome> {
	if (from === to) return { kind: "unchanged" };
	if (!(await steps.settle())) return { kind: "busy" };
	// Held across BOTH the move and the repoint, and released in a finally so
	// a migration that throws cannot leave the store unable to save.
	steps.holdWrites?.();
	let result: MigrationResult;
	try {
		result = await steps.migrate(from, to);
		if (result.unsupported) return { kind: "unsupported" };
		steps.repoint(to);
	} finally {
		steps.releaseWrites?.();
	}
	await steps.persist(to);
	return { kind: "moved", result };
}
