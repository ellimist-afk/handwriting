/**
 * The page store's external-change adoption: the preserved copy of the outgoing revision, the prepared adoption and its pair of recovery files.
 * They are methods of PageStore, installed on its prototype when PageStore.ts loads.
 */
import { INK_FOLDER_MOVING_TEXT } from "../util/DeleteAllBackupNotice";
import { ensureFolder } from "./InkFolder";
import { PageData, parsePage, serializePage } from "../model/PageData";
import { installMethods } from "../inline/InstallMethods";
import { ADOPTED_BY_KEY, contentStamp, EXACT_OUTGOING_KEY, type ExternalAdoptionPrep, folderOf, outgoingDiverges, type PreparedExternalAdoption, stripJson, type PageStore } from "./PageStore";

declare module "./PageStore" {
	interface PageStore {
		preserve(pageId: string): Promise<string | null>;
		prepareExternalAdoption(pageId: string, outgoing: PageData, expectedSurface?: "inline" | "pdf"): Promise<ExternalAdoptionPrep>;
		acceptExternalAdoption(prepared: PreparedExternalAdoption): void;
		preserveAdoptionPair(pageId: string, final: string, outgoing: PageData, incomingStamp: string, incomingText: string): Promise<{ outgoingPath: string; incomingPath: string; reused: boolean }>;
		reuseAdoptionPair(pageId: string, key: string, outgoingText: string, incomingText: string): Promise<{ outgoingPath: string; incomingPath: string; reused: true } | null>;
		writeAdoptionPair(pageId: string, final: string, key: string, outgoingText: string, incomingText: string, outgoing: PageData): Promise<{ outgoingPath: string; incomingPath: string; reused: false }>;
	}
}

/**
 * The outgoing artifact's bytes: a valid sidecar carrying its own exact
 * capture. Nothing else in the plugin writes a page this way, and no ordinary
 * save reaches it - `serializePage` and the live-sidecar path are untouched.
 */
function serializeExactOutgoing(outgoing: PageData, adoptedBy: string | null): string {
	return serializePage({
		...outgoing,
		unknownTop: {
			...outgoing.unknownTop,
			[EXACT_OUTGOING_KEY]: outgoing,
			...(adoptedBy ? { [ADOPTED_BY_KEY]: adoptedBy } : {}),
		},
	});
}

/**
 * A cryptographically random token for one preservation pair.
 *
 * A runtime with no CSPRNG REFUSES preservation rather than falling back to a
 * time-only name. Two devices whose clocks agree to the millisecond would
 * otherwise choose the same sibling name for different ink, and the existence
 * probe cannot see a write that has not landed yet - so the fallback would
 * quietly reintroduce, between devices, exactly the overwrite this prevents.
 */
function adoptionToken(): string {
	const source = typeof crypto === "undefined" ? undefined : crypto;
	if (!source || typeof source.getRandomValues !== "function") {
		throw new Error("Handwriting: no secure random source for the recovery copies");
	}
	const bytes = new Uint8Array(8);
	source.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}


	/**
	 * Copy the page's CURRENT state to a fresh `.handwriting/trash/` generation,
	 * leaving the live sidecar untouched. Any pending save is flushed first,
	 * so the copy is the newest state, not a stale one. This is the safety net
	 * behind "Delete all ink": the wipe that follows overwrites the live file,
	 * and this copy keeps today's ink recoverable anyway.
	 *
	 * RC4: the destination is `<id>-<stamp>[-n].json` and is never an existing
	 * file, so a second delete-all can no longer destroy the first one's copy.
	 * The bytes are copied verbatim. Unknown fields survive by construction,
	 * because nothing here parses or re-serializes the payload.
	 *
	 * Returns the copy's path, or null when the page has nothing on disk.
	 * THROWS when the copy itself cannot be made. The caller must then refuse
	 * the wipe rather than proceed without the net.
	 */
	async function preserve(this: PageStore, pageId: string): Promise<string | null> {
		this.clearTimers(pageId);
		await this.writePending(pageId); // no-op when nothing is queued
		if (this.pending.has(pageId)) {
			// The flush did not land (writeNow re-queued the state): the copy
			// below would then preserve a STALE file while the caller tells the
			// user it holds today's ink. Refuse instead. The caller aborts the
			// wipe, and nothing is lost.
			//
			// TWO REASONS IT DID NOT LAND, and the message must not claim the
			// wrong one. A real write failure is one. The other, since writes
			// are held across an ink-folder move, is that the move is still
			// running - the queue is intact, the ink is fine, and trying again
			// in a moment simply works. Blaming the disk for that sends someone
			// looking for a fault that is not there.
			throw new Error(
				this.migrating
					? INK_FOLDER_MOVING_TEXT
					: "Handwriting: the newest ink could not be written to disk"
			);
		}
		const adapter = this.app.vault.adapter;
		let dest: string | null = null;
		const run = async (): Promise<void> => {
			// Re-asked on the chain. A save already dequeued before the check
			// above could still be in flight; if it failed, it re-queued the
			// newest state while this copy waited its turn, and the file below
			// is older than it. The queued state is what gets copied then, so
			// the backup holds the ink the caller is about to wipe.
			const queued = this.pending.get(pageId);
			if (queued !== undefined) {
				const final = await this.resolvePath(pageId);
				await ensureFolder(adapter, this.trashDirOf(final));
				const to = await this.freeTrashPath(pageId, folderOf(final), "wipe");
				await adapter.write(to, serializePage(queued));
				dest = to;
				return;
			}
			// The resolved path, like load: the page may be sitting in the other
			// well-known folder (an interrupted migration, or a device that
			// lost data.json). Preserving only what the CONFIGURED folder
			// holds meant the safety copy silently covered nothing, right
			// before the caller wiped the note.
			const final = await this.resolvePath(pageId);
			if (!(await adapter.exists(final))) return;
			// The trash beside the FILE, not beside the configured folder: a
			// generation dropped into the other folder's trash is invisible to
			// the restore path that vault's other devices will take.
			const trashDir = this.trashDirOf(final);
			await ensureFolder(adapter, trashDir);
			const text = await adapter.read(final);
			const to = await this.freeTrashPath(pageId, folderOf(final), "wipe");
			await adapter.write(to, text);
			dest = to;
		};
		// Ride the write chain so the copy can't interleave with a save, but
		// keep the chain alive if the copy fails. The failure is the CALLER's
		// signal (abort the wipe), not a reason to wedge future saves.
		const chained = this.chain(pageId, run);
		await chained;
		return dest;
	}

	/**
	 * PREPARE AN EXTERNAL ADOPTION WITHOUT ACKNOWLEDGING IT.
	 *
	 * The loss this closes: a sidecar replaced by another device is adopted by
	 * rebuilding the record through `load`, and `load` stamps `knownMtime` and
	 * `knownHash` with the incoming file. From that instant the outgoing
	 * revision has no representation anywhere - it is out of the record and the
	 * write-path guard no longer has a reason to preserve anything. Merging the
	 * two is NOT the fix and is not attempted here: `mergePages` is a union,
	 * and its own docstring says this layer cannot tell a stroke the other
	 * device DELETED from one it never SAW. Across devices that are offline for
	 * hours the second case is ordinary, so a blind union would resurrect real
	 * deletions - a zombie bug traded for a loss bug.
	 *
	 * So both revisions are made independently recoverable FIRST, and the swap
	 * happens only after that succeeded. Neither artifact depends on the live
	 * file or on its pair to be read back.
	 *
	 * `preserve(pageId)` is deliberately not reused: it reads the file that is
	 * there NOW - which after a replacement is the incoming one - and it may
	 * first flush a queued write. It answers a different question.
	 *
	 * Nothing here touches the synced live sidecar, and nothing here updates
	 * the known baseline. Both are `acceptExternalAdoption`'s job, and it is
	 * synchronous so no await can separate the caller's re-qualification from
	 * the acknowledgement.
	 *
	 * `expectedSurface` is caller authority, not a globally widened clause: an
	 * inline caller must never adopt a PDF page merely because this shared
	 * preservation mechanism also serves the PDF store.
	 */
	async function prepareExternalAdoption(this: PageStore,
		pageId: string,
		outgoing: PageData,
		expectedSurface: "inline" | "pdf" = "inline"
	): Promise<ExternalAdoptionPrep> {
		const adapter = this.app.vault.adapter;
		// On the page's own write chain: the artifacts must not interleave with
		// a save, and the live file must not be rewritten under the capture.
		return await this.chain(pageId, async (): Promise<ExternalAdoptionPrep> => {
			const final = await this.resolvePath(pageId);
			if (!(await adapter.exists(final))) {
				return { kind: "unavailable", why: "no live sidecar", reason: "no-live-sidecar" };
			}
			// Stat BEFORE the read, for the reason `load` states: a stamp taken
			// after the bytes can record an mtime that belongs to a revision
			// this never saw.
			const st = await adapter.stat(final).catch(() => null);
			const incomingText = await adapter.read(final);
			const incomingStamp = contentStamp(incomingText);
			const parsed = parsePage(incomingText, pageId);
			const surfaceMatches = parsed.data.surface === expectedSurface;
			if (
				parsed.damaged ||
				parsed.futureVersion !== undefined ||
				!surfaceMatches
			) {
				// Damage, a newer schema and a legacy canvas page are not adopted
				// here. Hand it back untouched. At a cold open each has a lock
				// that fails closed; on a note already open there is none, and
				// the record stays writable so ink drawn here is not dropped.
				// The next save's guard then keeps these bytes as
				// `<id>.conflict-<mtime>.json` before writing this device's page,
				// and fix ink de-sync lists that copy as a fork
				// (`scanForForks`).
				return {
					kind: "unavailable",
					why: "the incoming revision is not a clean inline page",
					reason: "incoming-unusable",
				};
			}
			// The artifact carries its own unrounded capture; see
			// EXACT_OUTGOING_KEY. The dedup key is taken from these bytes, so a
			// mutation too small for the persisted codec still changes the pair
			// identity and correctly earns a fresh pair rather than reusing one
			// that describes a revision the record no longer holds.
			//
			// A pair only when the incoming revision would lose something the
			// outgoing one holds. An ordinary sync, where the other device only
			// added, writes nothing and records no fork.
			const pair = outgoingDiverges(outgoing, parsed.data)
				? await this.preserveAdoptionPair(pageId, final, outgoing, incomingStamp, incomingText)
				: null;
			// REVALIDATE THE CAPTURED GENERATION after the awaited I/O. A third
			// revision can have landed while the artifacts were being written.
			// Everything already written STAYS - it is ink, and it is complete -
			// but the captured generation is not adopted and not acknowledged,
			// so the newer one is still there for the next poll to find.
			const after = await adapter.read(final).catch(() => null);
			if (after === null || contentStamp(after) !== incomingStamp) {
				return { kind: "stale", why: "a newer external revision arrived during preservation" };
			}
			// The synced copy being adopted may have displaced a local file this
			// device wrote before it arrived. Adoption writes nothing live, so
			// nothing else would move that file aside, and after a restart it
			// would be found first and served for good. Moved beside the winner
			// now; the outgoing artifact above already holds its ink as well.
			await this.absorbProvisional(pageId, final);
			return {
				kind: "prepared",
				prepared: {
					pageId,
					data: parsed.data,
					outgoingPath: pair?.outgoingPath,
					incomingPath: pair?.incomingPath,
					reused: pair?.reused ?? false,
					// A failed stat proves nothing, and 0 is the safe value: the
					// next check finds a mismatch, compares the CONTENT stamp,
					// and settles it. It can cost one extra read; it can never
					// suppress a real change.
					mtime: st?.mtime ?? 0,
					stamp: incomingStamp,
				},
			};
		});
	}

	/**
	 * ACKNOWLEDGE a prepared adoption: this exact captured generation becomes
	 * the baseline the next save is measured against.
	 *
	 * Synchronous, and that is the whole point. The caller re-qualifies its
	 * record immediately before calling, and an await between that check and
	 * this line is precisely the gap a finished stroke lands in - which is how
	 * the in-flight-write loss worked.
	 */
	function acceptExternalAdoption(this: PageStore, prepared: PreparedExternalAdoption): void {
		this.knownMtime.set(prepared.pageId, prepared.mtime);
		this.knownHash.set(prepared.pageId, prepared.stamp);
		// The live bytes were composed by ANOTHER device, so no in-process
		// writer owns them now. A stale writer left here would let
		// reconcileInProcess skip its read and put a stale page back on disk.
		this.lastWriter.delete(prepared.pageId);
	}

	/** The recovery pair for one adoption: reused when already on disk, else written. */
	async function preserveAdoptionPair(this: PageStore,
		pageId: string,
		final: string,
		outgoing: PageData,
		incomingStamp: string,
		incomingText: string
	): Promise<{ outgoingPath: string; incomingPath: string; reused: boolean }> {
		const outgoingText = serializeExactOutgoing(outgoing, this.deviceId);
		const key = `${contentStamp(outgoingText)}|${incomingStamp}`;
		return (
			(await this.reuseAdoptionPair(pageId, key, outgoingText, incomingText)) ??
			(await this.writeAdoptionPair(pageId, final, key, outgoingText, incomingText, outgoing))
		);
	}

	/**
	 * The pair already written for this exact outgoing/incoming revision pair,
	 * RE-PROVED against disk, or null.
	 *
	 * Repeat attempts are ordinary rather than exceptional: a preparation that
	 * goes stale, or that the record rejects because a stroke landed, comes
	 * back on the next poll with both revisions unchanged. Writing a fresh pair
	 * each time would fill the folder with identical copies. Remembering alone
	 * is not enough either - an artifact deleted or edited since is no longer
	 * evidence, and this page then gets a fresh pair rather than a claim about
	 * a file that is gone.
	 */
	async function reuseAdoptionPair(this: PageStore,
		pageId: string,
		key: string,
		outgoingText: string,
		incomingText: string
	): Promise<{ outgoingPath: string; incomingPath: string; reused: true } | null> {
		const seen = this.preservedAdoptions.get(pageId);
		if (!seen || seen.key !== key) return null;
		const adapter = this.app.vault.adapter;
		const o = await adapter.read(seen.outgoingPath).catch(() => null);
		const i = await adapter.read(seen.incomingPath).catch(() => null);
		if (o !== outgoingText || i !== incomingText) return null;
		return { outgoingPath: seen.outgoingPath, incomingPath: seen.incomingPath, reused: true };
	}

	/**
	 * Write and verify one fresh pair of recovery artifacts beside the live
	 * file. `.conflict-` keeps both out of `isLiveSidecarName`, so nothing
	 * treats either as the page.
	 *
	 * BOTH names are probed and neither is ever overwritten: a token collision
	 * is not worth reasoning about, but a leftover artifact from an earlier
	 * attempt is ordinary and it holds ink. The probe is NOT a cross-process
	 * reservation and is not claimed to be - two processes can still probe the
	 * same free name in the same instant. The random token, not the probe, is
	 * what makes that vanishingly unlikely.
	 */
	async function writeAdoptionPair(this: PageStore,
		pageId: string,
		final: string,
		key: string,
		outgoingText: string,
		incomingText: string,
		outgoing: PageData
	): Promise<{ outgoingPath: string; incomingPath: string; reused: false }> {
		const adapter = this.app.vault.adapter;
		const base = stripJson(final);
		let outgoingPath = "";
		let incomingPath = "";
		for (let attempt = 0; attempt < 8 && outgoingPath === ""; attempt++) {
			const token = adoptionToken();
			const o = `${base}.conflict-external-${token}-outgoing.json`;
			const i = `${base}.conflict-external-${token}-incoming.json`;
			if (await adapter.exists(o)) continue;
			if (await adapter.exists(i)) continue;
			outgoingPath = o;
			incomingPath = i;
		}
		if (outgoingPath === "") {
			throw new Error("Handwriting: could not allocate a free pair of recovery copies");
		}
		await ensureFolder(adapter, folderOf(final));
		// Either order leaves, at every instant, a complete copy of at least
		// one revision plus the untouched live file. A partial attempt's
		// artifact is kept: this slice adds no cleanup policy, because the
		// thing being cleaned up would be somebody's ink.
		await this.writeVerified(pageId, outgoingPath, outgoingText, outgoing);
		await this.writeVerified(pageId, incomingPath, incomingText);
		this.preservedAdoptions.set(pageId, { key, outgoingPath, incomingPath });
		return { outgoingPath, incomingPath, reused: false };
	}

export function installPageStoreAdopt(proto: PageStore): void {
	installMethods(proto, {
		preserve,
		prepareExternalAdoption,
		acceptExternalAdoption,
		preserveAdoptionPair,
		reuseAdoptionPair,
		writeAdoptionPair,
	});
}
