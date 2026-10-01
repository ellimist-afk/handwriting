import { PageData, parsePage, serializePage } from "../model/PageData";
import { ADOPTED_BY_KEY, outgoingDiverges, recoverExactPage } from "./PageStore";

/**
 * WHAT THE USER DOES ABOUT A FORK, once the store has preserved both sides.
 *
 * Adoption already keeps both revisions - `prepareExternalAdoption` writes the
 * outgoing and incoming artifacts before the incoming becomes the live page,
 * and `adoptExternal` hands their paths back on its result. Nothing then tells
 * the user, and nothing can: both artifacts live in the ink folder, which
 * Obsidian will not browse. Preservation without resolution is a safe dead
 * end, and this module is the resolution half.
 *
 * IT IS NOT A MERGE. Ruled at 14:15 that an honest user-facing
 * fork-resolution decision satisfies convergence and that automatic union is
 * not required; the union design was rejected at 16:35. Nothing here unions,
 * compares geometry, or decides anything on the user's behalf. It reports what
 * each side holds and applies the choice the user makes.
 *
 * A decision that changes the live page writes it through the host's
 * `restore` (copy the current page aside, then write through the open note)
 * and reads it back before claiming it happened; a decided pair is renamed so
 * it is not listed again. See `applyForkDecision`.
 */

/** One preserved fork, as `adoptExternal` reported it. */
export interface ForkRecord {
	readonly pageId: string;
	/** The note this page belongs to, for showing a person something they know. */
	readonly path: string;
	/** This device's revision at the moment the other one arrived. */
	readonly outgoingPath: string;
	/** The revision that arrived and became the live page. */
	readonly incomingPath: string;
	readonly at: number;
}

/** What one side of a fork holds, or why it cannot be read. */
export interface ForkSide {
	readonly path: string;
	readonly strokes: number;
	readonly mtime: number;
	/**
	 * False when the artifact is gone, unreadable, or does not parse. The count
	 * is then meaningless and must not be shown as if it were a fact.
	 */
	readonly readable: boolean;
}

/** Enough to choose between two revisions, and nothing more. */
export interface ForkAccount {
	readonly pageId: string;
	readonly path: string;
	readonly at: number;
	/** This device's revision - the one that was displaced. */
	readonly mine: ForkSide;
	/** The other device's revision - the one now on screen. */
	readonly theirs: ForkSide;
	/** Stroke ids this device had that the arriving revision does not. */
	readonly mineOnly: number;
	/** Stroke ids the arriving revision brought that this device did not have. */
	readonly theirsOnly: number;
	/**
	 * Whether there is anything to decide.
	 *
	 * Adoption now writes a pair only when the incoming revision would lose
	 * something, but pairs written by older builds on every sync are still on
	 * disk: there the incoming is a superset, adopting was plainly right, and a
	 * question would be noise. That is the case the success-silence rule
	 * (`d50534a`) exists for and this must not undo it. Only a revision holding
	 * a stroke the other lacks is a fork a person needs to answer.
	 *
	 * False when either side is unreadable: nothing can be claimed about a
	 * count that could not be taken.
	 */
	readonly needsDecision: boolean;
}

export type ForkDecision = "keep-mine" | "take-theirs" | "keep-both";

export interface ForkOutcome {
	readonly kind: "applied" | "refused";
	/** True only when the decision actually wrote the live page. */
	readonly wrote: boolean;
	/** True when the fork stays listed afterwards, so it can be reached again. */
	readonly stillListed: boolean;
	readonly why?: string;
}

/**
 * The I/O this module needs, injected rather than imported, so the decision
 * logic can be executed in a test without a vault.
 */
export interface ForkHost {
	read(path: string): Promise<string | null>;
	stat(path: string): Promise<{ mtime: number } | null>;
	saveNow(pageId: string, data: PageData): Promise<void>;
	/**
	 * Make a revision the live page: keep a copy of the current live page
	 * first, then write through whichever open note or PDF holds the page, so
	 * screen, memory and disk agree. THROWS when the copy cannot be made, and
	 * then nothing is written. A host without it writes through `saveNow`.
	 */
	restore?(pageId: string, data: PageData): Promise<void>;
	/**
	 * Rename a file. Used to mark a decided pair so no later scan lists it
	 * again; a host without it cannot make a decision stick past the session.
	 */
	rename?(from: string, to: string): Promise<void>;
	/** Filenames in the ink folder. Absent hosts simply cannot scan. */
	list?(folder: string): Promise<string[]>;
	/**
	 * The note or PDF a page id belongs to, or null when nothing open or
	 * known this session says. A scanned pair carries only the id, so this is
	 * how the list names it.
	 */
	nameFor?(pageId: string): Promise<string | null>;
	/**
	 * This install's id. A scanned pair written by a different install has its
	 * legs the other way round for this device (see `scanForForks`).
	 */
	readonly deviceId?: string;
}

/** What `forkHostFor` builds the plugin's fork host from. */
export interface ForkHostSources {
	adapter: {
		read(path: string): Promise<string>;
		stat(path: string): Promise<{ mtime: number } | null>;
		rename?(from: string, to: string): Promise<void>;
		list?(folder: string): Promise<{ files: string[] }>;
	};
	store: {
		saveNow(pageId: string, data: PageData): Promise<void>;
		/** Copy the current live page aside; throws when it cannot. */
		preserve(pageId: string): Promise<string | null>;
	};
	/** The note a page id belongs to, or null. */
	pathForNote?(pageId: string): string | null;
	/** The PDF a page id belongs to, or null. It may read the sidecar, so it is async. */
	pathForPdf?(pageId: string): Promise<string | null>;
	/** Hand a restored page to the open surface holding it; true when it wrote it. */
	restoreOpen?(pageId: string, data: PageData): Promise<boolean>;
	/** This install's id; see `ForkHost.deviceId`. */
	deviceId?: string;
}

/**
 * The fork host the plugin uses, in one place so the command and the cells
 * that exercise it build the same thing.
 */
export function forkHostFor(src: ForkHostSources): ForkHost {
	const list = src.adapter.list?.bind(src.adapter);
	const rename = src.adapter.rename?.bind(src.adapter);
	const pathForNote = src.pathForNote?.bind(src);
	const pathForPdf = src.pathForPdf?.bind(src);
	return {
		...(pathForNote || pathForPdf
			? {
					nameFor: async (pageId: string) =>
						pathForNote?.(pageId) ?? (await pathForPdf?.(pageId).catch(() => null)) ?? null,
				}
			: {}),
		...(src.deviceId ? { deviceId: src.deviceId } : {}),
		...(rename ? { rename: (from: string, to: string) => rename(from, to) } : {}),
		read: (p) => src.adapter.read(p),
		stat: async (p) => {
			const s = await src.adapter.stat(p);
			return s ? { mtime: s.mtime } : null;
		},
		saveNow: (pageId, data) => src.store.saveNow(pageId, data),
		restore: async (pageId, data) => {
			// The current live page can hold ink drawn after the fork, in no
			// other file. Copied first, and a failed copy stops the restore.
			await src.store.preserve(pageId);
			if (await src.restoreOpen?.(pageId, data)) return;
			await src.store.saveNow(pageId, data);
		},
		...(list ? { list: async (folder: string) => (await list(folder)).files } : {}),
	};
}

/**
 * `<pageId>.conflict-external-<token>-outgoing.json`, and the incoming twin.
 * The shape `writeAdoptionPair` produces (`PageStore.ts`), and the only thing
 * on disk that identifies a preserved pair - there is no index, no manifest
 * and no persisted register anywhere in the plugin.
 */
const ARTIFACT = /^(.+)\.conflict-external-(.+)-(outgoing|incoming)\.json$/;

/**
 * Find preserved pairs by looking, because nothing else can find them.
 *
 * THE REGISTER ABOVE IS PER-SESSION and a fork outlives the session that made
 * it. There is no enumeration path anywhere in the plugin to fall back on:
 * `preservedAdoptions` is a private in-memory map for pair reuse, and every
 * existing folder sweep skips these files on purpose - `isLiveSidecarName`
 * excludes anything containing `.conflict-`. So without this scan the surface
 * would only ever show a fork to the one session that happened to be running
 * when it occurred, which for a sync that lands overnight is nobody.
 *
 * Read-only: it lists and pairs, and writes nothing. Pairs missing a leg are
 * skipped - one artifact alone is not a decision anyone can be offered.
 */
export async function scanForForks(host: ForkHost, folder: string): Promise<ForkRecord[]> {
	if (!host.list) return [];
	let names: string[];
	try {
		names = await host.list(folder);
	} catch {
		return [];
	}
	const pairs = new Map<string, { pageId: string; outgoing?: string; incoming?: string }>();
	for (const name of names) {
		const base = name.slice(name.lastIndexOf("/") + 1);
		const m = ARTIFACT.exec(base);
		if (!m) continue;
		const [, pageId, token, leg] = m;
		const key = `${pageId}::${token}`;
		const entry = pairs.get(key) ?? { pageId: pageId! };
		if (leg === "outgoing") entry.outgoing = `${folder}/${base}`;
		else entry.incoming = `${folder}/${base}`;
		pairs.set(key, entry);
	}
	const out: ForkRecord[] = [];
	for (const e of pairs.values()) {
		if (!e.outgoing || !e.incoming) continue;
		const st = await host.stat(e.outgoing).catch(() => null);
		// A pair another install wrote: its "outgoing" leg is THAT device's
		// revision and its "incoming" leg is this one's, so this device reads
		// them the other way round. A pair with no writer recorded (written
		// before this existed) reads as it always has.
		if (host.deviceId) {
			const writer = await writerOf(host, e.outgoing);
			if (writer !== null && writer !== host.deviceId) [e.outgoing, e.incoming] = [e.incoming, e.outgoing];
		}
		out.push({
			pageId: e.pageId,
			// THE NOTE PATH IS NOT RECOVERABLE FROM THE FILENAME - the artifact
			// is named for the page id and nothing else. A fork registered live
			// this session carries the real path; a scanned one falls back to
			// the id, which is at least stable and searchable. `describeFork`
			// names it through `ForkHost.nameFor` when the host can.
			path: e.pageId,
			outgoingPath: e.outgoing,
			incomingPath: e.incoming,
			at: st?.mtime ?? 0,
		});
	}
	return out;
}

/** The install that wrote a pair, from its outgoing leg, or null when none is recorded or it cannot be read. */
async function writerOf(host: ForkHost, outgoingPath: string): Promise<string | null> {
	try {
		const text = await host.read(outgoingPath);
		if (text === null) return null;
		const top = JSON.parse(text) as Record<string, unknown>;
		const writer = top[ADOPTED_BY_KEY];
		return typeof writer === "string" && writer.length > 0 ? writer : null;
	} catch {
		return null;
	}
}

/**
 * Merge scanned pairs into the register, without displacing a live record.
 *
 * A record made this session knows the note path; a scanned one only knows the
 * id. Where both exist the live one wins.
 */
export async function refreshForks(host: ForkHost, folder: string): Promise<void> {
	for (const found of await scanForForks(host, folder)) {
		const key = pairKey(found);
		if (!forks.has(key)) forks.set(key, found);
	}
}

// ---- the register -----------------------------------------------------------

/**
 * Forks this session has seen, ONE ENTRY PER PAIR.
 *
 * It was one per page, newest wins, so a later adoption on the same page
 * replaced a real fork's entry, and after a restart the scan kept whichever
 * pair it met first. A routine pair then hid a real one and the command said
 * there was nothing to fix. Every pair is kept; which of a page's pairs is put
 * to the user is the surface's choice (the newest one needing a decision).
 *
 * In memory on purpose. A fork is only actionable while the artifacts it names
 * are still on disk, and persisting the list would mean a second thing to keep
 * true about files this module does not own. A restart loses the list, not the
 * ink: both artifacts survive, and the next adoption on that page re-registers.
 */
const forks = new Map<string, ForkRecord>();

/**
 * One pair, whichever leg a record calls this device's: the two legs share
 * their name up to `-outgoing` / `-incoming`.
 */
function pairKey(rec: ForkRecord): string {
	const base = (p: string) => p.replace(/-(outgoing|incoming)\.json$/, "");
	const [a, b] = [base(rec.outgoingPath), base(rec.incomingPath)].sort();
	return `${rec.pageId}|${a}|${b}`;
}

/** Record a fork the store just preserved. The same pair again replaces its entry. */
export function recordFork(rec: ForkRecord): void {
	forks.set(pairKey(rec), rec);
}

/** Every unresolved fork, newest first. */
export function listForks(): ForkRecord[] {
	return [...forks.values()].sort((a, b) => b.at - a.at);
}

/** Drop one pair, once the user has decided about it. */
export function forgetPair(rec: ForkRecord): void {
	forks.delete(pairKey(rec));
}

/** Drop every pair of one page. */
export function forgetFork(pageId: string): void {
	for (const [key, rec] of forks) if (rec.pageId === pageId) forks.delete(key);
}

/** Test seam, and the teardown path. */
export function resetForks(): void {
	forks.clear();
}

// ---- describing -------------------------------------------------------------

/**
 * The fork an adoption produced, or null when it produced none.
 *
 * Pure, and separated from the poll wiring so the boundary can be executed:
 * an adoption that was held, was unavailable, or came back without both
 * artifacts registers nothing at all.
 */
export function forkFromAdoption(
	pageId: string | null,
	path: string,
	result: { outcome: string; outgoingPath?: string; incomingPath?: string },
	at: number
): ForkRecord | null {
	if (!pageId) return null;
	if (result.outcome !== "adopted") return null;
	if (!result.outgoingPath || !result.incomingPath) return null;
	return { pageId, path, outgoingPath: result.outgoingPath, incomingPath: result.incomingPath, at };
}

async function pageAt(host: ForkHost, pageId: string, path: string): Promise<PageData | null> {
	let text: string | null = null;
	try {
		text = await host.read(path);
	} catch {
		return null;
	}
	if (text === null) return null;
	const parsed = parsePage(text, pageId);
	if (parsed.damaged) return null;
	return parsed.data;
}

async function sideOf(host: ForkHost, pageId: string, path: string): Promise<ForkSide> {
	const st = await host.stat(path).catch(() => null);
	let text: string | null = null;
	try {
		text = await host.read(path);
	} catch {
		text = null;
	}
	if (text === null) return { path, strokes: 0, mtime: st?.mtime ?? 0, readable: false };
	const parsed = parsePage(text, pageId);
	// `damaged` means the bytes did not come back whole, so the stroke count is
	// whatever survived rather than what the file holds. Reporting it as a
	// count would be the lie this whole surface exists to stop telling.
	if (parsed.damaged) return { path, strokes: 0, mtime: st?.mtime ?? 0, readable: false };
	return { path, strokes: parsed.data.strokes.length, mtime: st?.mtime ?? 0, readable: true };
}

/**
 * What each side of a fork holds. Reads both artifacts; changes nothing.
 */
export async function describeFork(host: ForkHost, rec: ForkRecord): Promise<ForkAccount> {
	// A scanned record carries the page id where a path belongs. Name it from
	// the host when the host can; a record that already carries a real path,
	// and an id nothing knows, are left as they are.
	const path = rec.path === rec.pageId ? ((await host.nameFor?.(rec.pageId).catch(() => null)) ?? rec.path) : rec.path;
	const [mine, theirs, minePage, theirsPage] = await Promise.all([
		sideOf(host, rec.pageId, rec.outgoingPath),
		sideOf(host, rec.pageId, rec.incomingPath),
		pageAt(host, rec.pageId, rec.outgoingPath),
		pageAt(host, rec.pageId, rec.incomingPath),
	]);
	const both = minePage !== null && theirsPage !== null;
	const mineIds = new Set(minePage?.strokes.map((s) => s.id));
	const theirsIds = new Set(theirsPage?.strokes.map((s) => s.id));
	const mineOnly = both ? [...mineIds].filter((id) => !theirsIds.has(id)).length : 0;
	const theirsOnly = both ? [...theirsIds].filter((id) => !mineIds.has(id)).length : 0;
	return {
		pageId: rec.pageId,
		path,
		at: rec.at,
		mine,
		theirs,
		mineOnly,
		theirsOnly,
		// The question preservation asked when it kept the pair: does this
		// device's revision hold anything the other lacks, by id or under the
		// same id in another form? A stroke the other device moved keeps its
		// id, so counting missing ids alone hid that pair from the list. The
		// legs are compared as parsed; the nested exact capture on the
		// outgoing leg is not a stroke and is not compared.
		needsDecision: both && outgoingDiverges(minePage, theirsPage),
	};
}

// ---- deciding ---------------------------------------------------------------

/**
 * Apply the user's decision.
 *
 * `keep-mine` makes this device's preserved revision the live page.
 * `take-theirs` makes the other device's revision the live page when the live
 * page is no longer that revision (after an earlier keep-mine, or ink drawn
 * since); when it already is, it writes nothing. `keep-both` writes nothing
 * and keeps the fork listed so the person can come back to it.
 *
 * A write goes through `restore` when the host has it: the current live page
 * is copied aside first, and the page goes through the open note, so the
 * screen, the session and the disk hold the same revision.
 *
 * A DECISION STICKS. `keep-mine` and `take-theirs` rename both legs of the
 * pair to a resolved name that no scan lists, on this device and on any other
 * that syncs the folder. The pair was only forgotten in memory before, so the
 * next run of the command listed the same fork again.
 *
 * NOTHING IS EVER DELETED. Both legs stay on disk under every decision, so a
 * decision made in error is still recoverable from the files.
 */
export async function applyForkDecision(
	host: ForkHost,
	rec: ForkRecord,
	decision: ForkDecision
): Promise<ForkOutcome> {
	if (decision === "keep-both") {
		return { kind: "applied", wrote: false, stillListed: true };
	}
	const leg = decision === "keep-mine" ? rec.outgoingPath : rec.incomingPath;
	let text: string | null = null;
	try {
		text = await host.read(leg);
	} catch {
		text = null;
	}
	if (text === null) {
		// The artifact is gone. Refuse rather than write something else, and
		// keep the fork listed: the other side is still there and still a
		// choice the user can make.
		return { kind: "refused", wrote: false, stillListed: true, why: "unreadable" };
	}
	const parsed = parsePage(text, rec.pageId);
	if (parsed.damaged) {
		// Fail closed, the store's own rule: a damaged parse hands back a
		// placeholder, and writing it would overwrite the live page with less
		// than either side actually holds.
		return { kind: "refused", wrote: false, stillListed: true, why: "damaged" };
	}
	// THE TWO ARTIFACTS ARE NOT THE SAME KIND OF OBJECT, so restoring is not a
	// symmetric action. The incoming leg is the other device's bytes verbatim;
	// the OUTGOING leg is a valid sidecar that additionally nests a whole
	// second copy of the page under `EXACT_OUTGOING_KEY`, so a recovery tool
	// can read back the unrounded capture. Unknown top-level keys ride through
	// `parsePage` by design, so writing `parsed.data` straight back would put
	// that nested copy into the user's live sidecar permanently - roughly
	// doubling it, for ever, silently. `recoverExactPage` is the reader the
	// store wrote for exactly this: it returns the nested capture when there is
	// one and the ordinary page otherwise, and the capture does not carry the
	// key itself.
	const restored = recoverExactPage(parsed.data);
	// Take the other with the other revision already live: nothing to write.
	const write = decision === "keep-mine" || !(await livePageHolds(host, rec, restored));
	if (write) {
		try {
			if (host.restore) await host.restore(rec.pageId, restored);
			else await host.saveNow(rec.pageId, restored);
		} catch (err) {
			// The copy of the current page could not be made, or the write
			// threw: nothing is claimed, and the fork stays listed.
			console.error("[handwriting] could not restore a revision", rec.pageId, err);
			return { kind: "refused", wrote: false, stillListed: true, why: "not saved" };
		}
		// A save that fails is caught by the store and queued for a retry, so
		// returning from the write does not mean the page is on disk. Reading
		// it back does: until the chosen revision is the live page, the
		// decision has not happened, and the fork stays listed.
		if (!(await livePageHolds(host, rec, restored))) {
			return { kind: "refused", wrote: false, stillListed: true, why: "not saved" };
		}
	}
	forgetPair(rec);
	await markResolved(host, rec);
	return { kind: "applied", wrote: write, stillListed: false };
}

/**
 * `<id>.conflict-external-<token>-<leg>.json` becomes
 * `<id>.conflict-resolved-<token>-<leg>.json`: the same file, under a name the
 * scan does not match. A failed rename keeps the decision for this session
 * only; the next run lists the fork again, which is safe.
 */
async function markResolved(host: ForkHost, rec: ForkRecord): Promise<void> {
	if (!host.rename) return;
	for (const leg of [rec.outgoingPath, rec.incomingPath]) {
		const to = leg.replace(".conflict-external-", ".conflict-resolved-");
		if (to === leg) continue;
		try {
			await host.rename(leg, to);
		} catch (err) {
			console.error("[handwriting] could not mark a decided fork", leg, err);
		}
	}
}

/** The live sidecar beside a pair: the store writes both legs next to it. */
function livePathBeside(rec: ForkRecord): string {
	const slash = rec.outgoingPath.lastIndexOf("/");
	const folder = slash < 0 ? "" : rec.outgoingPath.slice(0, slash + 1);
	return `${folder}${rec.pageId}.json`;
}

/**
 * Does the live sidecar now hold exactly this page's strokes, text boxes and
 * images, in this order and in this form?
 *
 * Ids alone are not enough: a lasso move keeps a stroke's id, so a moved
 * stroke read as the chosen revision and "Take the other" wrote nothing, and a
 * failed write read back as done. Both sides go through the codec, so the
 * unrounded capture this device restores matches its own rounded write.
 */
async function livePageHolds(host: ForkHost, rec: ForkRecord, page: PageData): Promise<boolean> {
	let text: string | null = null;
	try {
		text = await host.read(livePathBeside(rec));
	} catch {
		return false;
	}
	if (text === null) return false;
	const parsed = parsePage(text, rec.pageId);
	if (parsed.damaged) return false;
	const onDisk = parsePage(serializePage(parsed.data), rec.pageId).data;
	const wanted = parsePage(serializePage(page), rec.pageId).data;
	const same = (a: readonly unknown[], b: readonly unknown[]): boolean =>
		a.length === b.length && a.every((x, i) => JSON.stringify(x) === JSON.stringify(b[i]));
	return (
		same(onDisk.strokes, wanted.strokes) &&
		same(onDisk.textBoxes, wanted.textBoxes) &&
		same(onDisk.images, wanted.images)
	);
}

// ---- copy -------------------------------------------------------------------

/**
 * EVERY USER-FACING STRING THIS SURFACE SHOWS, IN ONE PLACE. ALL TEN ARE NOW
 * ALAN'S OWN WORDS, APPROVED 2026-09-09.
 *
 * He wrote them live from a rendered presentation of the screen; nothing here
 * is not this comment's to change. THE AUTHORITY IS THE RECORDED DECISION,
 * "2026-09-09 10:04 CDT ... ALL TEN FORK-SCREEN STRINGS ARE APPROVED". Read it
 * there before changing any string below.
 *
 * NEW: `commandName`, `empty`, `keepMine`, `refused`. KEPT AS DRAFTED:
 * `headline`, `unreadable`, `takeTheirs`, `keepBoth`.
 *
 * `headline` HAS A TRAILING PERIOD AND THE WHOLE ARC MATTERS, because two
 * entries on the record say the opposite of the state below.
 *
 * It shipped with one, and that period was NEVER ALAN'S: he typed the sentence
 * bare and it was punctuated when this constant was formed. When the two forms
 * were put to him one character apart, the perioded one was labelled as his -
 * *"you werent clear which one was mine"* - and he then ruled *"get the periods
 * OUT"* / *"GET EM OUT"* (2026-09-09 17:09 CDT). It came off.
 *
 * THEN HE PUT IT BACK THE SAME DAY, and that is the state below. Verbatim:
 * *"ehhhhhhhhhhhhhhhh we hsould be consistent, put a period back at end"*
 * (2026-09-09 17:14 CDT). The reason bounds it: other messages on the same
 * delete-all command always carried trailing periods and had never been shown
 * to him, so he chose consistency in the direction of RESTORING rather than
 * stripping more. The authority is that 17:14 decision, not this comment.
 *
 * DO NOT STRIP IT AGAIN ON THE STRENGTH OF THE 17:09 ENTRY. It is still on the
 * record, it still says the opposite, and it was correctly executed at the
 * time - this paragraph is the only thing standing between a later reader and
 * a third round trip.
 *
 * AND ONE RULED SENTENCE GOES THE OTHER WAY, deliberately: the ink-trash
 * restore line stays BARE, because it ends in a file path where a trailing
 * period reads as part of the path (2026-09-09 17:21 CDT, *"leave that last
 * one bare"*). Not every approved string ends in a period, and a sweep that
 * assumed so would be wrong. `ForkCopyApproved.test.ts` pins the punctuated
 * set and that bare one separately, by name.
 *
 * `commandName` CARRIES NO "Handwriting:" PREFIX ON PURPOSE. He wrote one, and
 * it comes out because Obsidian prefixes the plugin name itself - it would
 * have read "Handwriting: Handwriting: ..." - and no other command in this
 * plugin carries one. He also removed the word "note" himself on learning the
 * screen covers PDFs too: preservation runs on the pdf surface, `scanForForks`
 * pairs files by name (it opens a pair only to read which install wrote it),
 * so a PDF fork lists beside a note fork. Slides has no preservation route
 * and produces none.
 *
 * `mine` AND `theirs` ARE CORRECT AND WERE NEVER CHANGED. It was observed that
 * the revision labelled "The other device" is the one currently on screen, and
 * relayed as "the labels read backwards". They do not. Alan settled it in one
 * line - "PALADIN IS THE OTHER DEVICE" - he reads this on Orion, and the other
 * device is the other device. Do not swap them.
 *
 * THE MARKER IS NOW GONE FROM EVERY STRING, AND IT IS ENFORCED RATHER THAN
 * PROMISED. The version of this docstring that shipped before said the marker
 * existed "so an unapproved string cannot reach a release build unnoticed" -
 * which was not true of anything that existed: no test asserted it, and the
 * build did not scan for it. `ForkCopyApproved.test.ts` is that gate now, over
 * this object and over every shipped source file.
 */
export const FORK_COPY_PLACEHOLDER = {
	/** Command palette entry that opens the list. */
	commandName: "fix ink de-sync",
	/** Shown when the list is empty. */
	empty: "no ink de-sync to fix",
	/**
	 * One line naming what happened, per fork.
	 *
	 * TRAILING PERIOD, RESTORED BY ALAN - see the header. It is the only string
	 * in this object that has one, and the only one that ever did.
	 */
	headline: "This note was edited on two devices and both versions were kept.",
	/** Label for this device's preserved revision. */
	mine: "This device",
	/** Label for the revision that arrived. */
	theirs: "The other device",
	/** Shown against a side whose artifact cannot be read. */
	unreadable: "cannot be read",
	/** The three decisions. */
	keepMine: "Keep this device's ink",
	takeTheirs: "Take the other",
	keepBoth: "Keep both",
	/** After a refused keep-mine. */
	refused: "Could not keep this device's ink",
} as const;
