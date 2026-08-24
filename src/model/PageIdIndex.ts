/**
 * Who owns which `handwriting-page-id`: the duplicate-detection ledger.
 *
 * A page id must map to exactly one note: the sidecar, the camera, the trash
 * and conflict copies are all keyed by it. Copying a note (Obsidian's "Make a
 * copy", a filesystem copy, a sync tool's "conflicted copy") duplicates the
 * frontmatter and with it the id, and from that moment both notes silently
 * read and WRITE the same `.handwriting/<id>.json`. This index exists to catch that
 * before the first shared write.
 *
 * Ownership evidence, in order of strength:
 *
 * 1. LIFECYCLE. While the session runs, the note that already held the id
 *    when a second one appears is the original; the newcomer is the copy.
 *    That is real evidence (the copy did not exist a moment ago), not
 *    iteration order.
 * 2. MEMORY. Across sessions, the owner map persisted in settings names the
 *    path that held each id last time. A duplicate discovered at startup
 *    (copy made while the app was closed) resolves against it.
 * 3. NOTHING. Two notes carry the id, no session saw either first, no
 *    memory matches. There is no safe way to pick; the caller must fail
 *    closed (lock both, tell the user) rather than guess destructively.
 *
 * Pure bookkeeping: this class never touches files. The caller does the
 * re-identification and cloning; the index only says who owns what.
 */

export type RegisterVerdict =
	| { kind: "registered" } // first sighting: path now owns the id
	| { kind: "same" } // path already owns it
	| { kind: "duplicate"; ownerPath: string }; // someone else owns it

export interface RebuildResult {
	/** ids carried by exactly one note, registered as owners. */
	registered: number;
	/** ids carried by MORE than one note: id → every path carrying it. */
	collisions: Map<string, string[]>;
}

export class PageIdIndex {
	private byId = new Map<string, string>();

	owner(id: string): string | undefined {
		return this.byId.get(id);
	}

	/** Snapshot for the settings-persisted owner memory. */
	snapshot(): Record<string, string> {
		return Object.fromEntries(this.byId);
	}

	/**
	 * Startup census from cached metadata. Unique ids register; colliding
	 * ids register NO owner (deciding here would be iteration order; the
	 * caller resolves against persisted memory or fails closed).
	 */
	rebuild(entries: Iterable<{ path: string; id: string }>): RebuildResult {
		this.byId.clear();
		const seen = new Map<string, string[]>();
		for (const { path, id } of entries) {
			const paths = seen.get(id);
			if (paths) paths.push(path);
			else seen.set(id, [path]);
		}
		const collisions = new Map<string, string[]>();
		let registered = 0;
		for (const [id, paths] of seen) {
			if (paths.length === 1) {
				this.byId.set(id, paths[0]!);
				registered++;
			} else {
				collisions.set(id, paths);
			}
		}
		return { registered, collisions };
	}

	/** A live sighting of `id` on `path` (claim, load, metadata change). */
	register(path: string, id: string): RegisterVerdict {
		const owner = this.byId.get(id);
		if (owner === undefined) {
			this.byId.set(id, path);
			return { kind: "registered" };
		}
		if (owner === path) return { kind: "same" };
		return { kind: "duplicate", ownerPath: owner };
	}

	/** The caller established that ownership moves (owner de-claimed/gone). */
	transfer(id: string, toPath: string): void {
		this.byId.set(id, toPath);
	}

	/** Resolve an unowned collision: memory (or the caller) picked the owner. */
	claimOwnership(id: string, ownerPath: string): void {
		this.byId.set(id, ownerPath);
	}

	handleRename(oldPath: string, newPath: string): void {
		for (const [id, path] of this.byId) {
			if (path === oldPath) this.byId.set(id, newPath);
		}
	}

	/** Ids owned by a deleted path are freed. Returns the freed ids. */
	handleDelete(path: string): string[] {
		const freed: string[] = [];
		for (const [id, owner] of this.byId) {
			if (owner === path) {
				this.byId.delete(id);
				freed.push(id);
			}
		}
		return freed;
	}

	/** The path stopped carrying this id (user edited the line away). */
	release(path: string, id: string): void {
		if (this.byId.get(id) === path) this.byId.delete(id);
	}
}
