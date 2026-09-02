/**
 * A PDF's ink, for the session and for the disk.
 *
 * A deliberate sibling of `InlineInkStore` rather than a generalization of it.
 * The note store carries locks that were each paid for with a bug - page-id
 * claiming, frontmatter round-trips, legacy canvas surfaces, duplicate-id
 * detection - and none of them apply here: a PDF's id comes from its own
 * bytes, so there is nothing to claim, nothing to write into the file, and no
 * older format to refuse. Sharing the code would mean carrying five
 * conditions that are always false, and risking the store that already works.
 *
 * What IS carried over, because they are not incidental:
 *
 * - **Never snapshot mid-load.** A save while the sidecar is still being read
 *   would hold only this session's strokes and, written, replace the ones on
 *   disk. Every mutation path defers behind the read.
 * - **Fail closed on an unreadable sidecar.** If the bytes could not be
 *   understood, `data` is a placeholder rather than the user's ink, and
 *   writing it would destroy what the file held. Locked, with one notice.
 * - **Refuse a future schema.** A sidecar from a newer version is not ours to
 *   rewrite.
 *
 * Strokes are stored flat and filtered by page on read. A hundred-page
 * document holds one record, not a hundred: the page is a property of the
 * stroke (see `InkStroke.page`), which is what makes "move this stroke to
 * another page" a field change rather than a migration.
 */

import { InkStroke } from "../ink/Stroke";
import { PageData, ParseResult, emptyPage } from "../model/PageData";
import { runDetached } from "../util/Detached";

const EMPTY: readonly InkStroke[] = [];

/**
 * What the visible ink looks like, for deciding whether a reload changed
 * anything worth repainting.
 *
 * Ids and positions, not a count: an erase-to-empty, a paste and a move all
 * have to register, and identical content must not. A blanket "something was
 * read" makes every poll tick repaint, and on a platform whose file times are
 * approximate that is a flicker once a second forever.
 */
function inkFingerprint(strokes: readonly InkStroke[]): string {
	return strokes.map((s) => `${s.page}/${s.id}:${s.bbox.x},${s.bbox.y}`).join("|");
}

/**
 * The coordinate convention every pdf stroke is written in: page-local css px
 * at scale 1.0, top-left origin of the page div.
 *
 * Stamped on every write so a later migration can be versioned. Both this and
 * PDF user units produce plausible-looking numbers, so a file that does not
 * say which one it used cannot be told apart afterwards - the stamp is the
 * only thing that would make such a migration safe rather than a guess.
 */
export const PDF_COORD_SPACE = "page-css@1";

/** The persistence this store needs. `PageStore` satisfies it as-is. */
export interface PdfInkHost {
	load(id: string): Promise<ParseResult | null>;
	schedule(id: string, data: PageData): void;
	notice(message: string): void;
}

interface PdfRecord {
	strokes: InkStroke[];
	load: "no" | "loading" | "yes";
	/** The parsed sidecar, kept so unknown keys survive a round-trip. */
	basePage: PageData | null;
	/**
	 * The vault paths this sidecar belongs to - instance identity's anchor
	 * (see PdfIdentity.chooseInstance). Null until a claim or a load sets
	 * it; authoritative once set, and written out as `pdfPaths`.
	 */
	claimedPaths: string[] | null;
	loadInFlight: Promise<void> | null;
	/** The sidecar could not be read; writing would destroy it. */
	unreadableLocked: boolean;
	/** Written by a newer Handwriting; not ours to rewrite. */
	futureLocked: boolean;
	noticed: boolean;
}

function freshRecord(): PdfRecord {
	return {
		strokes: [],
		load: "no",
		basePage: null,
		claimedPaths: null,
		loadInFlight: null,
		unreadableLocked: false,
		futureLocked: false,
		noticed: false,
	};
}

export class PdfInkStore {
	private byId = new Map<string, PdfRecord>();
	private host: PdfInkHost | null = null;

	/** No host = session-memory mode, which is how the tests run it. */
	attachHost(host: PdfInkHost): void {
		this.host = host;
	}

	strokes(id: string): readonly InkStroke[] {
		return this.byId.get(id)?.strokes ?? EMPTY;
	}

	/** This page's strokes, in the order they were drawn. */
	strokesOnPage(id: string, page: number): InkStroke[] {
		return (this.byId.get(id)?.strokes ?? []).filter((s) => s.page === page);
	}

	hasInk(id: string): boolean {
		return (this.byId.get(id)?.strokes.length ?? 0) > 0;
	}

	/** Diagnostics: documents held, and how much ink between them. */
	stats(): { documents: number; strokes: number } {
		let strokes = 0;
		for (const rec of this.byId.values()) strokes += rec.strokes.length;
		return { documents: this.byId.size, strokes };
	}

	private record(id: string): PdfRecord {
		let rec = this.byId.get(id);
		if (!rec) {
			rec = freshRecord();
			this.byId.set(id, rec);
		}
		return rec;
	}

	/**
	 * Bring a document's ink into the session, once.
	 *
	 * Resolves true when the visible strokes changed, so a caller can repaint
	 * only when there is something new to show.
	 */
	async ensureLoaded(id: string): Promise<boolean> {
		const rec = this.record(id);
		if (!this.host || rec.load !== "no") return false;
		rec.load = "loading";
		let settle = (): void => {};
		rec.loadInFlight = new Promise<void>((resolve) => {
			settle = resolve;
		});
		try {
			const result = await this.host.load(id);
			if (!result) return false;
			// `damaged` means the bytes could not be understood and `data` is a
			// PLACEHOLDER, not the user's ink. Writing it would overwrite what
			// the file actually held, so this is the fail-closed case.
			if (result.damaged) {
				rec.unreadableLocked = true;
				this.noteOnce(
					rec,
					"Handwriting: this PDF's ink file could not be read. Ink drawn on it is not saved."
				);
				return false;
			}
			// The parser reports a newer schema rather than making us compare
			// version numbers ourselves, and it is authoritative about it.
			if (result.futureVersion !== undefined) {
				// Locked, and still rendered. Returning here showed no ink at
				// all for a document whose sidecar came from a newer build,
				// which reads as loss; the parser has already migrated what
				// this build understands and persist() refuses for a
				// future-locked record, so the ink can be shown safely. Same
				// change as the inline surface, same reason.
				rec.futureLocked = true;
				this.noteOnce(
					rec,
					"Handwriting: this PDF's ink was written by a newer version of Handwriting. Ink drawn on it is not saved."
				);
				// Zero strokes out of a schema we do not fully understand is
				// ambiguous - erased, or written in a form we cannot decode -
				// and adopting on the second reading would blank the document.
				// What is on screen stays. See the inline surface for the
				// longer version of this.
				if (result.data.strokes.length === 0) return false;
			}
			rec.basePage = result.data;
			// Claims made before the read landed survive it: the disk's paths
			// and the session's are one set.
			const disk = result.data.pdfPaths ?? [];
			rec.claimedPaths = [...new Set([...disk, ...(rec.claimedPaths ?? [])])];
			// Session strokes drawn while the read was in flight come FIRST in
			// time but must not be lost to it, so the persisted set is merged
			// underneath them rather than replacing them.
			const persisted = result.data.strokes.filter((s) => typeof s.page === "number");
			const seen = new Set(rec.strokes.map((s) => s.id));
			rec.strokes = [...persisted.filter((s) => !seen.has(s.id)), ...rec.strokes];
			return persisted.length > 0;
		} finally {
			rec.load = "yes";
			rec.loadInFlight = null;
			settle();
		}
	}

	/** Add a finished stroke and persist. */
	commit(id: string, stroke: InkStroke): void {
		const rec = this.record(id);
		rec.strokes.push(stroke);
		this.persist(id, rec);
	}

	/**
	 * Replace this document's whole stroke set and persist.
	 *
	 * The blunt path, used by erase, lasso edits and undo. Blunt on purpose:
	 * the alternative is a diff protocol between the controller and the store,
	 * and the sidecar is rewritten whole either way.
	 */
	replaceAll(id: string, strokes: readonly InkStroke[]): void {
		const rec = this.record(id);
		rec.strokes = [...strokes];
		this.persist(id, rec);
	}

	/**
	 * Replace the stroke set WITHOUT writing: the live half of a gesture.
	 *
	 * The eraser, the lasso drag and insert-space each apply an op per
	 * pointer sample, and every one of those went through replaceAll - a
	 * scheduled sidecar write per sample, on top of the copies applyOp and
	 * replaceAll each make of the whole document. The screen has to keep up
	 * with the pen; the disk does not. `save` is the single write at pen-up.
	 */
	replaceAllLive(id: string, strokes: readonly InkStroke[]): void {
		this.record(id).strokes = [...strokes];
	}

	/** Write the current state now: the end of a live gesture. */
	save(id: string): void {
		this.persist(id, this.record(id));
	}

	/**
	 * Re-read a document's sidecar because something else wrote it.
	 *
	 * True when the visible ink actually changed, so the caller repaints only
	 * then. This is what makes ink drawn on a tablet appear on a desktop: the
	 * sidecars live in a folder the vault does not index, so nothing tells us
	 * they changed and the caller polls.
	 *
	 * Refuses while a read is in flight or the record is locked, for the same
	 * reason `persist` does: dropping the record would reset the lock, and the
	 * next stroke would write into a file we had already decided not to touch.
	 */
	async reloadExternal(id: string): Promise<boolean> {
		const rec = this.byId.get(id);
		if (!rec || rec.load !== "yes") return false;
		if (rec.loadInFlight || rec.unreadableLocked || rec.futureLocked) return false;
		const before = inkFingerprint(rec.strokes);
		// Kept, because clearing first is only safe if the re-read succeeds. A
		// sidecar being written by a sync client at this moment reads as damaged,
		// and the poll picks exactly those moments: it fires BECAUSE the file
		// just changed. Losing the session copy there empties the screen, and if
		// the file has gone rather than merely being unreadable it throws away
		// the only remaining copy of the ink.
		const kept = rec.strokes;
		rec.load = "no";
		rec.strokes = [];
		rec.basePage = null;
		await this.ensureLoaded(id);
		if (rec.basePage === null) {
			// Nothing was read: damaged, future-locked, or the file is gone. Put
			// the session back. Damaged and future both leave the record locked,
			// so the file is not touched; if the file vanished, the next save
			// restores it from what is still on screen.
			rec.strokes = kept;
			return false;
		}
		return inkFingerprint(this.strokes(id)) !== before;
	}

	/** Forget a document's session state. The file is untouched. */
	forget(id: string): void {
		this.byId.delete(id);
	}

	private persist(id: string, rec: PdfRecord): void {
		if (!this.host) return; // session-memory mode
		if (rec.unreadableLocked || rec.futureLocked) return; // already noticed
		if (rec.loadInFlight) {
			// The sidecar is still being read. A snapshot now would hold only
			// this session's strokes and, written, replace the persisted ones.
			// Persist again once the merge has happened; every mutation path
			// arrives here, so nothing is dropped by waiting.
			runDetached(
				rec.loadInFlight.then(() => this.persist(id, rec)),
				`persist pdf ink after loading ${id}`
			);
			return;
		}
		const base = rec.basePage ?? emptyPage(id);
		// Strokes the read could not place are carried through untouched. They
		// are filtered out of the session because a stroke with no page cannot be
		// drawn on one - but filtering is not deleting, and this record already
		// keeps unknown KEYS for exactly this reason. A stroke we cannot explain
		// is the last thing to throw away.
		const unplaceable = base.strokes.filter((s) => typeof s.page !== "number");
		this.host.schedule(id, {
			...base,
			pageId: id,
			surface: "pdf",
			coordSpace: PDF_COORD_SPACE,
			...(rec.claimedPaths !== null ? { pdfPaths: rec.claimedPaths } : {}),
			strokes: [...unplaceable, ...rec.strokes],
		});
	}

	/**
	 * Record that the file at `path` belongs to this sidecar. Persisted at
	 * once when the sidecar already exists on disk (an adoption must be
	 * durable before the next device resolves), but only REMEMBERED for a
	 * fresh instance - its sidecar is born with the first stroke, exactly
	 * as before, so merely opening a PDF still writes nothing.
	 */
	claimPath(id: string, path: string): void {
		const rec = this.record(id);
		if (rec.claimedPaths?.includes(path)) return;
		rec.claimedPaths = [...(rec.claimedPaths ?? []), path];
		if (rec.basePage !== null) this.persist(id, rec);
	}

	/** The file moved: its old claim is a lie now, the new one replaces it. */
	renamePath(id: string, oldPath: string, newPath: string): void {
		const rec = this.record(id);
		const kept = (rec.claimedPaths ?? []).filter((p) => p !== oldPath && p !== newPath);
		rec.claimedPaths = [...kept, newPath];
		if (rec.basePage !== null) this.persist(id, rec);
	}

	private noteOnce(rec: PdfRecord, message: string): void {
		if (rec.noticed || !this.host) return;
		rec.noticed = true;
		this.host.notice(message);
	}
}
