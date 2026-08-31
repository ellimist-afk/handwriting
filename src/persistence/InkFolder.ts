/**
 * Where the ink sidecars live, and how to move them without losing any.
 *
 * `.handwriting` was chosen so the ink stays out of the way: dot-folders are
 * invisible in the file explorer and Obsidian does not index them. The cost
 * only showed up once people had two devices - **Obsidian Sync ignores
 * dot-folders**, so ink written on a tablet never reached the desktop and
 * looked like data loss (reported on release day, 2026-08-27, by a user who
 * diagnosed it himself and moved his ink to a plain folder).
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
	return (
		name.endsWith(".json") ||
		name.endsWith(".json.tmp") ||
		/\.(damaged|conflict)-\d+$/.test(name)
	);
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
}

/**
 * Move every sidecar from one folder to another.
 *
 * Rules, in the order they matter:
 *
 * 1. Never overwrite. A name already present at the destination is left
 *    alone and counted as skipped - two files claiming one page id is a
 *    problem to be looked at, not resolved by clobbering one of them.
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
	to: string
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
	for (const file of sidecars) {
		const target = `${to}/${baseName(file)}`;
		if (await adapter.exists(target)) {
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
	return { moved, skipped, unsupported: false };
}

export interface FolderChangeSteps {
	/** Resolves false when writes are still in flight. */
	settle(): Promise<boolean>;
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
 * 2. Move before repointing. Repointing first sends reads to a folder the
 *    files have not reached yet.
 * 3. Persist last, so a failed save cannot claim a move that did not happen.
 *
 * None of it is load-bearing for the user's data - `PageStore.readPath` falls
 * back to the default folder, so an interruption anywhere leaves pages
 * readable - but the sequence should still be right, and now it is testable.
 */
export async function changeFolder(
	steps: FolderChangeSteps,
	from: string,
	to: string
): Promise<FolderChangeOutcome> {
	if (from === to) return { kind: "unchanged" };
	if (!(await steps.settle())) return { kind: "busy" };
	const result = await steps.migrate(from, to);
	if (result.unsupported) return { kind: "unsupported" };
	steps.repoint(to);
	await steps.persist(to);
	return { kind: "moved", result };
}
