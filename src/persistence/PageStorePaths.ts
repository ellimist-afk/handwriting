/**
 * The page store's paths: the sidecar names, the folder search, a page's resolved home, the trash names and the two-folder fork.
 * They are methods of PageStore, installed on its prototype when PageStore.ts loads.
 */
import { normalizePath } from "obsidian";
import { DEFAULT_INK_FOLDER, isLiveSidecarName, SYNCED_INK_FOLDER } from "./InkFolder";
import { isSafePageId, parsePage } from "../model/PageData";
import { installMethods } from "../inline/InstallMethods";
import { contentStamp, folderOf, type PageStore } from "./PageStore";

declare module "./PageStore" {
	interface PageStore {
		pathIn(folder: string, pageId: string): string;
		path(pageId: string): string;
		searchFolders(): string[];
		listIds(prefix: string): Promise<string[]>;
		inkFolder(): string;
		inkFolders(): string[];
		holdWrites(): void;
		releaseWrites(): void;
		useInkFolder(folder: string): void;
		findSidecar(pageId: string): Promise<{ path: string; found: boolean }>;
		chooseBetweenFolders(pageId: string, primary: string, second: string): Promise<{ path: string; found: true }>;
		preserveTwoFolderFork(pageId: string, final: string, winnerText: string): Promise<void>;
		resolvePath(pageId: string): Promise<string>;
		resolveFor(pageId: string): Promise<{ path: string; found: boolean }>;
		findElsewhere(pageId: string, not: string): Promise<string | null>;
		pinnedPath(pageId: string): string;
		tmpFor(final: string): string;
		trashDirIn(folder: string): string;
		trashDirOf(final: string): string;
		trashFolderFor(pageId: string): Promise<string>;
		freeTrashPath(pageId: string, folder: string, tag?: string): Promise<string>;
	}
}


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
	function pathIn(this: PageStore, folder: string, pageId: string): string {
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
	function path(this: PageStore, pageId: string): string {
		return this.pathIn(this.folder, pageId);
	}

	/**
	 * The folders a page can be served from, configured one first. The order
	 * `findSidecar` searches, and the order `listIds` and the trash sweep
	 * enumerate, because every one of them has to agree with the lookup.
	 */
	function searchFolders(this: PageStore): string[] {
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
	async function listIds(this: PageStore, prefix: string): Promise<string[]> {
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
	function inkFolder(this: PageStore): string {
		return this.folder;
	}

	/**
	 * Every folder a page can be served from, configured one first. A fork
	 * found at load is preserved beside the copy that was served, which can be
	 * the other well-known folder, so the fork command looks in all of them.
	 */
	function inkFolders(this: PageStore): string[] {
		return this.searchFolders();
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
	function holdWrites(this: PageStore): void {
		this.migrating = true;
	}

	/** Release the hold. Always from a `finally`; see `changeFolder`. */
	function releaseWrites(this: PageStore): void {
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
	function useInkFolder(this: PageStore, folder: string): void {
		this.contentCheckedAt.clear();
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
	async function findSidecar(this: PageStore, pageId: string): Promise<{ path: string; found: boolean }> {
		const primary = this.path(pageId);
		const others = [DEFAULT_INK_FOLDER, SYNCED_INK_FOLDER].filter((f) => f !== this.folder);
		const adapter = this.app.vault.adapter;
		if (await adapter.exists(primary)) {
			for (const folder of others) {
				const second = normalizePath(`${folder}/${pageId}.json`);
				if (await adapter.exists(second)) return this.chooseBetweenFolders(pageId, primary, second);
			}
			return { path: primary, found: true };
		}
		for (const folder of others) {
			const fallback = normalizePath(`${folder}/${pageId}.json`);
			if (await adapter.exists(fallback)) return { path: fallback, found: true };
		}
		return { path: primary, found: false };
	}

	/**
	 * ONE PAGE, TWO WELL-KNOWN FOLDERS. Reached only when both hold the page;
	 * the ordinary single-folder open never gets here and reads nothing extra.
	 *
	 * It happens when this device wrote a page before the synced copy arrived
	 * (the note synced before its ink) and the session ended before live reload
	 * adopted the synced one, and after an interrupted folder move. The
	 * configured folder used to win every time, so a restart served this
	 * device's early copy for good: the other device's ink hidden, and new ink
	 * written to a file the other device never sees.
	 *
	 *  - Identical bytes: the configured folder, as before.
	 *  - One copy holds every stroke the other has: that copy, whichever folder
	 *    it is in. The other is moved aside as a conflict copy by the next
	 *    write, and announced; never deleted (see absorbProvisional).
	 *  - Neither holds the other: a real fork. The copy in the synced folder is
	 *    served, and `load` preserves the other as this device's side of a fork
	 *    pair, so "fix ink de-sync" offers the decision.
	 *
	 * A copy that cannot be read or parsed decides nothing: the configured
	 * folder is served, as before.
	 */
	async function chooseBetweenFolders(this: PageStore,
		pageId: string,
		primary: string,
		second: string
	): Promise<{ path: string; found: true }> {
		const adapter = this.app.vault.adapter;
		let a: string;
		let b: string;
		try {
			[a, b] = await Promise.all([adapter.read(primary), adapter.read(second)]);
		} catch {
			return { path: primary, found: true };
		}
		if (a === b) return { path: primary, found: true };
		const pa = parsePage(a, pageId);
		const pb = parsePage(b, pageId);
		if (pa.damaged || pb.damaged) return { path: primary, found: true };
		const idsA = new Set(pa.data.strokes.map((s) => s.id));
		const idsB = new Set(pb.data.strokes.map((s) => s.id));
		const aHoldsB = [...idsB].every((id) => idsA.has(id));
		const bHoldsA = [...idsA].every((id) => idsB.has(id));
		let winner = primary;
		let loser = second;
		if (!aHoldsB && bHoldsA) [winner, loser] = [second, primary];
		if (!aHoldsB && !bHoldsA) {
			if (folderOf(second) === SYNCED_INK_FOLDER) [winner, loser] = [second, primary];
			this.twoFolderForks.set(pageId, loser);
		}
		this.displacedProvisional.set(pageId, loser);
		return { path: winner, found: true };
	}

	/** Write the fork pair for a two-folder fork, on the page's chain. */
	async function preserveTwoFolderFork(this: PageStore, pageId: string, final: string, winnerText: string): Promise<void> {
		const loser = this.twoFolderForks.get(pageId);
		if (loser === undefined) return;
		this.twoFolderForks.delete(pageId);
		try {
			await this.chain(pageId, async () => {
				const text = await this.app.vault.adapter.read(loser);
				const parsed = parsePage(text, pageId);
				if (parsed.damaged) return;
				await this.preserveAdoptionPair(pageId, final, parsed.data, contentStamp(winnerText), winnerText);
			});
		} catch (err) {
			// The losing copy stays where it is, still a live file, so nothing is
			// lost; the next session finds both folders again and retries.
			console.error("[handwriting] could not preserve a copy of this page from another folder", pageId, err);
		}
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
	async function resolvePath(this: PageStore, pageId: string): Promise<string> {
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
	async function resolveFor(this: PageStore, pageId: string): Promise<{ path: string; found: boolean }> {
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
	async function findElsewhere(this: PageStore, pageId: string, not: string): Promise<string | null> {
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
	function pinnedPath(this: PageStore, pageId: string): string {
		return this.resolved.get(pageId) ?? this.path(pageId);
	}

	/** The scratch file for a save, always a SIBLING of the file it becomes. */
	function tmpFor(this: PageStore, final: string): string {
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
	function trashDirIn(this: PageStore, folder: string): string {
		return normalizePath(`${folder}/trash`);
	}

	/** The trash beside a page's file: the one rule every trash write follows. */
	function trashDirOf(this: PageStore, final: string): string {
		return this.trashDirIn(folderOf(final));
	}

	/**
	 * The trash directory a copy of this page goes to right now: beside the
	 * file the page is served from, which is not always the configured folder.
	 */
	async function trashFolderFor(this: PageStore, pageId: string): Promise<string> {
		return this.trashDirOf(await this.resolvePath(pageId));
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
	 *
	 * `tag`, when given, is appended to every candidate name (the counter
	 * above still disambiguates within it) and marks the generation as one
	 * `restoreFromTrash` must never auto-promote — see its own comment.
	 */
	async function freeTrashPath(this: PageStore, pageId: string, folder: string, tag?: string): Promise<string> {
		const adapter = this.app.vault.adapter;
		const suffix = tag ? `-${tag}` : "";
		const base = `${this.trashDirIn(folder)}/${pageId}-${this.now()}`;
		let candidate = normalizePath(`${base}${suffix}.json`);
		for (let n = 2; await adapter.exists(candidate); n++) {
			candidate = normalizePath(`${base}-${n}${suffix}.json`);
		}
		return candidate;
	}

export function installPageStorePaths(proto: PageStore): void {
	installMethods(proto, {
		pathIn,
		path,
		searchFolders,
		listIds,
		inkFolder,
		inkFolders,
		holdWrites,
		releaseWrites,
		useInkFolder,
		findSidecar,
		chooseBetweenFolders,
		preserveTwoFolderFork,
		resolvePath,
		resolveFor,
		findElsewhere,
		pinnedPath,
		tmpFor,
		trashDirIn,
		trashDirOf,
		trashFolderFor,
		freeTrashPath,
	});
}
