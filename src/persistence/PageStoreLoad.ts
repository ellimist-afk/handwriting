/**
 * The page store's load and recovery methods: reading a page from disk, the interrupted-save and trash lookups, the flush-carrier
 * recovery and the free-name helpers they use. They are methods of PageStore, installed on its prototype when PageStore.ts loads.
 */
import { ensureFolder } from "./InkFolder";
import { emptyPage, PageData, parsePage, ParseResult, serializePage } from "../model/PageData";
import { installMethods } from "../inline/InstallMethods";
import { contentStamp, folderOf, type LoadResult, stripJson, type PageStore } from "./PageStore";

declare module "./PageStore" {
	interface PageStore {
		load(pageId: string, options?: { restore?: boolean }): Promise<LoadResult | null>;
		loadFromDisk(pageId: string, options: { restore?: boolean }): Promise<LoadResult | null>;
		findInterruptedSave(pageId: string, final: string): Promise<{ tmp: string; live: string; text: string; result: ParseResult } | null>;
		restoreFromTrash(pageId: string): Promise<ParseResult | null>;
		restoreFirstOf(pageId: string, candidates: Array<{ file: string; home: string }>): Promise<ParseResult | null>;
		promoteTmpOverDamaged(pageId: string, final: string, damagedMtime: number, damagedStamp: string): Promise<ParseResult | null>;
		carrierFor(final: string): string;
		parseCarrier(text: string, pageId: string): { page: PageData; base: string | null; inFlight: Array<string | null> | null } | null;
		recoverFlushCarrier(pageId: string, final: string, liveMtime: number, liveStamp: string | null): Promise<ParseResult | null>;
		freeDamagedPath(final: string, mtime: number): Promise<string>;
		freeKeptPath(final: string, label: string, mtime: number): Promise<string>;
	}
}

function generationOf(file: string, prefix: string): number {
	const name = (file.split("/").pop() ?? "").slice(prefix.length, -".json".length);
	const m = /^(\d+)(?:-(\d+))?$/.exec(name);
	if (!m) return -1;
	return Number(m[1]) * 1000 + Number(m[2] ?? 1);
}

/**
 * The same sort key for a copy `remove` set aside because another device
 * wrote it: `<pageId>-<stamp>[-<n>]-external.json` reads as the plain name
 * would, any other name -1.
 */
function externalGenerationOf(file: string, prefix: string): number {
	const name = file.split("/").pop() ?? "";
	const tag = "-external.json";
	if (!name.endsWith(tag)) return -1;
	return generationOf(name.slice(0, -tag.length) + ".json", prefix);
}

/**
 * Does `page` hold every stroke id of the live file's page? False when the
 * live bytes do not parse whole: a partial read proves nothing. A page in a
 * newer format than this build reads is a partial read too, even when every
 * stroke it shows decoded (parsePage reports it without `damaged`).
 */
function holdsEveryStroke(page: PageData, liveText: string | null, pageId: string): boolean {
	if (liveText === null) return false;
	const live = parsePage(liveText, pageId);
	if (live.damaged || live.futureVersion !== undefined) return false;
	const ids = new Set(page.strokes.map((s) => s.id));
	return live.data.strokes.every((s) => ids.has(s.id));
}


	/**
	 * `restore: false` skips the trash lookup and answers null as if the trash
	 * were empty, leaving it untouched. For ids that must never come back from
	 * the trash: a PDF id is content-derived, so a new same-bytes file would
	 * otherwise revive a retired copy's ink.
	 *
	 * A result with `transient` set means the read itself threw: the file may
	 * be healthy and simply not readable yet (a sync client mid-write, a cloud
	 * placeholder). It still carries `damaged`, so every caller keeps failing
	 * closed, and the poll keeps watching the page (see observeUnreadable).
	 */
	async function load(this: PageStore, pageId: string, options: { restore?: boolean } = {}): Promise<LoadResult | null> {
		// A page with a write queued is live in memory and disk is behind it.
		// Reading disk here would move the baseline to whatever revision is
		// there now (another device's, a rename's) and the queued write would
		// then land over it with no conflict copy. So the answer is the page
		// held in memory, a copy because the writer still hashes its own, and
		// disk, the trash lookup and the baseline are not touched. This covers
		// every call: `restore` only decides the trash lookup for a missing
		// file, and a page with a queued write is not missing.
		const held = this.latestUnlanded(pageId);
		if (held) {
			return {
				data: {
					...held,
					textBoxes: held.textBoxes.map((t) => ({ ...t })),
					images: held.images.map((i) => ({ ...i })),
					strokes: held.strokes.map((st) => ({ ...st })),
				},
				recovered: false,
			};
		}
		const result = await this.loadFromDisk(pageId, options);
		if (!result?.damaged) this.unreadable.delete(pageId);
		return result;
	}

	async function loadFromDisk(this: PageStore, pageId: string, options: { restore?: boolean }): Promise<LoadResult | null> {
		const adapter = this.app.vault.adapter;
		let readFrom: string | undefined;
		try {
			// Not `path()` alone: a page can still be sitting in the default
			// folder if a folder change was interrupted, or because this device's
			// data.json never named the folder the vault actually uses. See
			// resolvePath - which also PINS what it finds, so the save that
			// follows this load writes to the file the load read. Inside the
			// try because it builds paths, and path() asserts.
			const final = await this.resolvePath(pageId);
			readFrom = final;
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
					// A LOAD HIT confirms the pin. `resolveFor` has just proven
					// no copy exists in any other well-known folder, and the
					// page has now been READ from this one, so it is no longer
					// merely where this device wrote blind - it is where the
					// page is. Later resolves stop paying for the extra look.
					this.provisional.delete(pageId);
					// Both well-known folders held this page and neither copy
					// held the other: keep the one not served as a fork pair.
					await this.preserveTwoFolderFork(pageId, final, text);
					// A background flush (`flushDispatch`) left its carrier and the
					// app was killed before the chained save landed: the carrier
					// holds the newest strokes.
					return (await this.recoverFlushCarrier(pageId, final, st?.mtime ?? 0, contentStamp(text))) ?? result;
				}
				// The main file is corrupt. Exactly one recovery case: its own
				// interrupted save is a complete, current-format page for this
				// id. Anything less keeps the read-only lock.
				this.unreadable.set(pageId, contentStamp(text));
				// Not when the only fault is ink under a key this build does not
				// read: that file is most likely a newer build's, and a leftover
				// save put in its place would become the page on every device.
				// It keeps its place, locked, as when no save was left behind.
				if (result.onlyUnknownPointKeys) return { ...result, damagedPath: final };
				return (
					(await this.promoteTmpOverDamaged(pageId, final, st?.mtime ?? 0, contentStamp(text))) ?? {
						...result,
						damagedPath: final,
					}
				);
			}
			// No live sidecar. An interrupted save's .tmp is looked for beside
			// the resolved path first, then beside the page's name in every
			// other folder it can be served from (findInterruptedSave).
			//
			// The .tmp is judged BEFORE a background flush's carrier (R2). The
			// carrier used to be promoted first, unconditionally, so a carrier
			// from an older flush beat the newer save whose .tmp was waiting
			// beside it and the newest strokes were gone with no message.
			// A usable .tmp is promoted below and the carrier
			// is then judged against it exactly as against a live file. With no
			// usable .tmp the carrier is promoted, as an interrupted save would be.
			const save = await this.findInterruptedSave(pageId, final);
			if (save === null || save.result.damaged) {
				const carried = await this.recoverFlushCarrier(pageId, final, 0, null);
				if (carried !== null) return carried;
			}
			if (save !== null) {
				const { tmp, live, text, result } = save;
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
				if (result.damaged) this.unreadable.set(pageId, contentStamp(text));
				if (!result.damaged) {
					try {
						// Into the .tmp's OWN folder: a save interrupted in the
						// other well-known folder comes back there, where the
						// vault's other devices can see it.
						await adapter.rename(tmp, live);
						// The page now exists, so where it exists is settled -
						// a fact, not a provisional guess.
						this.resolved.set(pageId, live);
						this.provisional.delete(pageId);
						const st = await adapter.stat(live).catch(() => null);
						if (st) this.knownMtime.set(pageId, st.mtime);
						this.knownHash.set(pageId, contentStamp(text));
						// A carrier beside it is now judged against the promoted
						// page: built on its bytes, or holding every stroke it has,
						// the carrier is promoted and this page kept as superseded;
						// otherwise the carrier's page is kept aside and announced.
						const carried = await this.recoverFlushCarrier(pageId, live, st?.mtime ?? 0, contentStamp(text));
						if (carried !== null) return carried;
					} catch (err) {
						// The content is in hand either way; the caller gets it
						// and the next save will write it out properly.
						console.error("[handwriting] could not promote a recovered .tmp", pageId, err);
					}
				}
				return {
					...result,
					recovered: true,
					problem: result.problem ?? "recovered from interrupted write",
					...(result.damaged ? { damagedPath: tmp } : {}),
				};
			}
		} catch (err) {
			// Nothing usable came back, so callers must still fail closed
			// (render nothing, write nothing) or this placeholder becomes the
			// file's new contents. But a THROW is not a bad payload: the file
			// may be healthy and not readable yet - a sync client mid-write, a
			// cloud placeholder, a busy disk at vault open. Reporting it as
			// damage told users a good file was broken and locked the note
			// until a reopen. It is `transient`: still `damaged` for
			// every caller that fails closed on that flag, and watched by the
			// poll so the next successful read heals it.
			this.unreadable.set(pageId, null);
			return {
				data: emptyPage(pageId),
				recovered: true,
				damaged: true,
				problem: String(err),
				transient: true as const,
				...(readFrom !== undefined ? { damagedPath: readFrom } : {}),
			};
		}
		// No live sidecar and no interrupted write. Before calling this page
		// blank, look in our own trash: a note restored from Obsidian's
		// .trash, or undeleted by a sync client, comes back carrying the id
		// its ink is filed under, and that ink was recycled when the note
		// went. Nothing ever brought it back, so the note reopened empty and
		// the next stroke began a SECOND sidecar under the same id, diverging
		// from the copy sitting in the trash folder.
		const restored = options.restore === false ? null : await this.restoreFromTrash(pageId);
		if (restored === null) this.observedMissing.add(pageId);
		return restored;
	}

	/**
	 * The interrupted save to recover from when no live sidecar exists, or
	 * null: the `.tmp` beside `final` (the resolved path) first, then the
	 * `.tmp` beside the page's name in every other folder a page can be
	 * served from, in `searchFolders` order.
	 *
	 * A page served from the OTHER well-known folder is saved there, beside
	 * the file the write found (writeNow), and after a restart nothing
	 * remembers that: the pin is gone, `findSidecar` sees only final names
	 * and answers the configured folder, and only THAT folder's `.tmp` was
	 * checked. The intact save next door was never considered, so a page
	 * whose new bytes sat complete on disk read as absent, and the next
	 * stroke started a second sidecar beside them.
	 *
	 * The first candidate that is a complete page for THIS id wins, so the
	 * resolved path keeps the precedence it has today and a scratch file for
	 * some other page is never promoted under this one's name. A candidate
	 * that will not parse is reported only when no candidate does, and is
	 * never promoted (load explains why). Costs one `exists` per extra
	 * folder, only on a load that found no live sidecar.
	 */
	async function findInterruptedSave(this: PageStore,
		pageId: string,
		final: string
	): Promise<{ tmp: string; live: string; text: string; result: ParseResult } | null> {
		const adapter = this.app.vault.adapter;
		const candidates = [final];
		for (const folder of this.searchFolders()) {
			const live = this.pathIn(folder, pageId);
			if (!candidates.includes(live)) candidates.push(live);
		}
		let damaged: { tmp: string; live: string; text: string; result: ParseResult } | null = null;
		for (const live of candidates) {
			const tmp = this.tmpFor(live);
			if (!(await adapter.exists(tmp))) continue;
			const text = await adapter.read(tmp);
			const result = parsePage(text, pageId);
			if (result.damaged) {
				damaged ??= { tmp, live, text, result };
				continue;
			}
			if (result.data.pageId !== pageId) continue;
			return { tmp, live, text, result };
		}
		return damaged;
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
	 *
	 * EVERY well-known folder's trash is searched, and the page is restored
	 * into the folder whose trash held it - not into the configured one. A
	 * device configured for `.handwriting` restoring a note whose ink was
	 * recycled from `handwriting/` used to put the live file in `.handwriting/`,
	 * where sync cannot see it, while the other device (which had the deletion)
	 * opened the note blank and started a second sidecar on its first stroke.
	 *
	 * An `-external` copy is the fallback: the live file `remove` found
	 * written by another device and set aside. It is tried, newest first and
	 * through the same checks, only when no plain generation restores, so a
	 * note whose live ink came from another device comes back with that ink
	 * instead of opening blank. When a plain one restores, every `-external`
	 * copy stays in the trash.
	 *
	 * Every other TAGGED generation is never a candidate here. A
	 * `-wipe` one is preserve()'s own Delete-all safety copy: it exists so the
	 * user's own trash still holds ink they deliberately wiped. Deleting a
	 * note right after a wipe recycles nothing new (the live file is provably
	 * empty), so without this exclusion the wipe copy would be the only
	 * generation on disk and restoring the note would silently bring back ink
	 * the user chose to erase. The others are what `remove` found beside the
	 * page: `-tmp` an interrupted save, `-flush` a background-flush carrier,
	 * `-superseded` a save that failed after the delete, older than the
	 * queued state the delete recycled. Each is kept for the user to recover
	 * by hand; none is this page's last live state, and promoting one would
	 * put an unfinished or older save in the live file with no message.
	 */
	async function restoreFromTrash(this: PageStore, pageId: string): Promise<ParseResult | null> {
		const adapter = this.app.vault.adapter;
		if (typeof adapter.list !== "function") return null;
		const list = adapter.list.bind(adapter);
		const prefix = `${pageId}-`;
		// Tagged with the folder that owns the trash, because that folder is
		// where the page goes back to.
		const plain: Array<{ file: string; home: string; gen: number }> = [];
		const external: Array<{ file: string; home: string; gen: number }> = [];
		for (const home of this.searchFolders()) {
			let files: string[];
			try {
				files = (await list(this.trashDirIn(home))).files;
			} catch {
				continue; // no trash there yet, or it cannot be enumerated
			}
			for (const f of files) {
				const name = f.split("/").pop() ?? "";
				if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
				// A plain generation, `<pageId>-<stamp>[-<n>].json`, or an
				// `-external` one. Every other tagged name reads -1 in both.
				const gen = generationOf(f, prefix);
				if (gen >= 0) {
					plain.push({ file: f, home, gen });
					continue;
				}
				const ext = externalGenerationOf(f, prefix);
				if (ext >= 0) external.push({ file: f, home, gen: ext });
			}
		}
		// Newest first, ACROSS the folders. The names carry a wall-clock stamp
		// and a counter, so lexical order is wrong once the counter reaches two
		// digits; the generations are few, so this compares the numbers. Equal
		// stamps keep the folder order above, which is the configured folder
		// first - the same tie-break every other lookup here makes.
		plain.sort((a, b) => b.gen - a.gen);
		external.sort((a, b) => b.gen - a.gen);
		return (await this.restoreFirstOf(pageId, plain)) ?? (await this.restoreFirstOf(pageId, external));
	}

	/**
	 * The first candidate, in the order given, that parses undamaged with this
	 * page id is renamed back onto the live path in its own folder. Null when
	 * none does.
	 */
	async function restoreFirstOf(this: PageStore,
		pageId: string,
		candidates: Array<{ file: string; home: string }>,
	): Promise<ParseResult | null> {
		const adapter = this.app.vault.adapter;
		for (const { file, home } of candidates) {
			let text: string;
			try {
				text = await adapter.read(file);
			} catch {
				continue;
			}
			const parsed = parsePage(text, pageId);
			if (parsed.damaged || parsed.data.pageId !== pageId) continue;
			const final = this.pathIn(home, pageId);
			try {
				await ensureFolder(adapter, home);
				await adapter.rename(file, final);
			} catch (err) {
				// The ink is still in the trash and still readable; returning
				// it un-restored is better than failing the load.
				console.error("[handwriting] could not restore recycled ink", pageId, err);
				return { ...parsed, recovered: true, fromInkTrash: true, problem: "recovered from the ink trash" };
			}
			const st = await adapter.stat(final).catch(() => null);
			// Restored into the folder its own trash belongs to, and that is
			// now where the page lives: this path is only reached when it lived
			// nowhere. A file that provably exists: not a provisional pin.
			this.resolved.set(pageId, final);
			this.provisional.delete(pageId);
			if (st) this.knownMtime.set(pageId, st.mtime);
			this.knownHash.set(pageId, contentStamp(text));
			// The RESTORE's own callback, not the corrupt-file promotion's.
			// Raising `onRecovered` here announced a trash restore as an
			// interrupted save and called `final` - the live sidecar the ink
			// was just renamed back into, and the only copy of it - the
			// unreadable file. Same value, correct claim.
			this.onInkTrashRestored?.(pageId, final);
			return { ...parsed, recovered: true, fromInkTrash: true, problem: "restored from the ink trash" };
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
	async function promoteTmpOverDamaged(this: PageStore,
		pageId: string,
		/** The file load() actually read - not necessarily the configured one. */
		final: string,
		damagedMtime: number,
		damagedStamp: string
	): Promise<ParseResult | null> {
		const adapter = this.app.vault.adapter;
		const tmp = this.tmpFor(final);

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
			const keptAs = await this.freeDamagedPath(final, damagedMtime);
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

	/** The background flush's own file beside `final`; never the shared .tmp. */
	function carrierFor(this: PageStore, final: string): string {
		return `${final}.flush`;
	}

	/**
	 * Read a flush carrier: the page it holds, the stamp of the live bytes it
	 * was built on (null when there was no live file yet), and the saves that
	 * were in flight when it was written (null when it cannot say: an older
	 * build's carrier has no such list). Null when it is not a complete,
	 * current-format page for this id.
	 */
	function parseCarrier(this: PageStore,
		text: string,
		pageId: string
	): { page: PageData; base: string | null; inFlight: Array<string | null> | null } | null {
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			return null;
		}
		if (!raw || typeof raw !== "object") return null;
		const { flushBase, flushInFlight, page } = raw as { flushBase?: unknown; flushInFlight?: unknown; page?: unknown };
		if (flushBase !== null && typeof flushBase !== "string") return null;
		const inFlight =
			Array.isArray(flushInFlight) && flushInFlight.every((s) => s === null || typeof s === "string")
				? (flushInFlight as Array<string | null>)
				: null;
		if (!page || typeof page !== "object") return null;
		const parsed = parsePage(JSON.stringify(page), pageId);
		if (parsed.damaged || parsed.futureVersion !== undefined || parsed.data.pageId !== pageId) return null;
		return { page: parsed.data, base: flushBase, inFlight };
	}

	/**
	 * A background flush's carrier beside the page.
	 *
	 * With a valid live file (`liveStamp` its bytes): a carrier built on
	 * exactly those bytes is their successor, so it is promoted and the old
	 * live file is kept beside it as `<name>.superseded-<mtime>.json`. A carrier
	 * built on anything else is not chosen over the live file - timestamps are
	 * not evidence, sync keeps mtimes - so its page is kept aside as
	 * `<name>.flush-conflict-<mtime>.json` and the live file stands. With no
	 * live file (`liveStamp` null) the carrier is promoted, as an interrupted
	 * save is. A carrier built on other bytes is promoted too when a save in
	 * flight when it was written landed first: it holds every stroke of the
	 * live page AND names the live bytes among its saves in flight, or cannot
	 * say (an older build's carrier, or a save whose bytes were not known
	 * yet). Stroke ids alone cannot tell that save from another device's edit
	 * that moved a stroke. Nothing is deleted except the carrier itself, and only
	 * once its page is written elsewhere. Null when there is no usable
	 * carrier, when either file changed under us, or when the carrier was
	 * kept aside (announced through `onFlushKeptAside`).
	 */
	async function recoverFlushCarrier(this: PageStore,
		pageId: string,
		final: string,
		liveMtime: number,
		liveStamp: string | null
	): Promise<ParseResult | null> {
		const adapter = this.app.vault.adapter;
		const carrier = this.carrierFor(final);
		if (!(await adapter.exists(carrier))) return null;
		type Outcome =
			| { kind: "promoted"; keptAs: string | null; text: string }
			| { kind: "aside"; keptAs: string }
			| { kind: "none" };
		const run = async (): Promise<Outcome> => {
			if (!(await adapter.exists(carrier))) return { kind: "none" };
			const carrierText = await adapter.read(carrier);
			const parsed = this.parseCarrier(carrierText, pageId);
			if (parsed === null) return { kind: "none" };
			const liveText = (await adapter.exists(final)) ? await adapter.read(final) : null;
			const liveNow = liveText === null ? null : contentStamp(liveText);
			if (liveNow !== liveStamp) return { kind: "none" };
			const pageText = serializePage(parsed.page);
			// Built on other bytes, it is still the successor when a save that was
			// already in flight when the carrier was written landed first and moved
			// the live file on: it holds every stroke the live page has, and it
			// names the live bytes among its saves in flight or cannot say. Stroke
			// ids alone also match bytes another device wrote after moving a stroke,
			// and promoting those would move the stroke back. Anything else stays
			// aside, and is named to the user.
			const accounted =
				parsed.inFlight === null || parsed.inFlight.includes(null) || parsed.inFlight.includes(liveStamp);
			if (
				liveStamp !== null &&
				parsed.base !== liveStamp &&
				!(accounted && holdsEveryStroke(parsed.page, liveText, pageId))
			) {
				const mtime = (await adapter.stat(carrier).catch(() => null))?.mtime ?? 0;
				const aside = await this.freeKeptPath(final, "flush-conflict", mtime);
				await adapter.write(aside, pageText);
				await adapter.remove(carrier);
				console.warn("[handwriting] background flush was built on other bytes; kept it as", aside);
				return { kind: "aside", keptAs: aside };
			}
			let keptAs: string | null = null;
			if (liveStamp !== null) {
				keptAs = await this.freeKeptPath(final, "superseded", liveMtime);
				await adapter.rename(final, keptAs);
			} else {
				await ensureFolder(adapter, folderOf(final));
			}
			await adapter.write(final, pageText);
			await adapter.remove(carrier);
			const after = await adapter.stat(final).catch(() => null);
			if (after) this.knownMtime.set(pageId, after.mtime);
			this.knownHash.set(pageId, contentStamp(pageText));
			return { kind: "promoted", keptAs, text: pageText };
		};
		let outcome: Outcome;
		try {
			outcome = await this.chainBehindAll(pageId, run);
		} catch (err) {
			console.error("[handwriting] background flush recovery failed", pageId, err);
			return null;
		}
		if (outcome.kind === "aside") this.onFlushKeptAside?.(pageId, outcome.keptAs);
		if (outcome.kind !== "promoted") return null;
		if (outcome.keptAs !== null) this.onFlushPromoted?.(pageId, outcome.keptAs);
		return {
			...parsePage(outcome.text, pageId),
			recovered: true,
			problem: "recovered strokes from an interrupted background save",
		};
	}

	/** A never-taken name for a corrupt main file that is being moved aside. */
	async function freeDamagedPath(this: PageStore, final: string, mtime: number): Promise<string> {
		return this.freeKeptPath(final, "damaged", mtime);
	}

	/** A never-taken `<name>.<label>-<mtime>.json` beside `final`. */
	async function freeKeptPath(this: PageStore, final: string, label: string, mtime: number): Promise<string> {
		const adapter = this.app.vault.adapter;
		const base = `${stripJson(final)}.${label}-${mtime}`;
		let candidate = `${base}.json`;
		for (let n = 2; await adapter.exists(candidate); n++) {
			candidate = `${base}-${n}.json`;
		}
		return candidate;
	}

export function installPageStoreLoad(proto: PageStore): void {
	installMethods(proto, {
		load,
		loadFromDisk,
		findInterruptedSave,
		restoreFromTrash,
		restoreFirstOf,
		promoteTmpOverDamaged,
		carrierFor,
		parseCarrier,
		recoverFlushCarrier,
		freeDamagedPath,
		freeKeptPath,
	});
}
