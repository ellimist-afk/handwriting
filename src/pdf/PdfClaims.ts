/**
 * PDF claims: which sidecar a PDF pane draws into, the panes' ink controllers, a PDF identified again after its bytes
 * change, claims moved on rename and retired on delete, and the ranged head read the id comes from. The methods are
 * methods of HandwritingPlugin, installed on its prototype when main.ts loads (installPdfClaims at its bottom). Bodies
 * moved unchanged from main.ts. This file imports only types from main.
 */
import { Notice, Platform, TFile, type WorkspaceLeaf } from "obsidian";
import { runGatedCommand } from "../CommandPaletteSplit";
import { installMethods } from "../inline/InstallMethods";
import { RECYCLE_GRACE_MS } from "../ink/RecycleOnDelete";
import type { InkStroke } from "../ink/Stroke";
import { emptyPage, parsePage, type PageData } from "../model/PageData";
import { InkFolderListingFailed } from "../persistence/InkFolder";
import { calibrationStrokes } from "./PdfCalibration";
import { readPdfHead, type HeadSource, type RangedHandle } from "./PdfHead";
import { chooseInstance, familiesToReadForOpen, familyOf, mayPairOnOpen, pdfInkIdFromHead, type FreshPaths, type InstanceClaim, type WaitingDeletion } from "./PdfIdentity";
import { setViewTurnSource } from "./PdfInkBand";
import { PdfInkController } from "./PdfInkController";
import { holdHistory, releaseHistory } from "./PdfInkCommit";
import { applyOp } from "./PdfInkHistory";
import type { LeaveTie, PdfDeleteContext } from "./PdfInkStore";
import { readViewTurn } from "./PdfViewerProbe";
import { runDetached } from "../util/Detached";
import type { HandwritingPlugin } from "../main";

declare module "../main" {
	interface HandwritingPlugin {
		syncPdfControllers(): void;
		releasePdfId(id: string): void;
		schedulePdfModified(path: string, panes?: ReadonlySet<HTMLElement>): void;
		movePdfModifiedOnRename(oldPath: string, newPath: string): void;
		onPdfModified(path: string, panes?: ReadonlySet<HTMLElement> | null): Promise<void>;
		resolvePdfId(leaf: WorkspaceLeaf, root: HTMLElement, controller: PdfInkController, carryOld?: boolean, chain?: readonly string[]): Promise<void>;
		carryFromOldContent(family: string, path: string, now: string, current: () => boolean, skip?: readonly string[]): Promise<boolean | "kept" | "none" | "unlisted">;
		/** Fresh ids an opening chose whose carry of the old version's ink has not run to its end (resolvePdfId). */
		pdfCarryOwed?: Set<string>;
		/** Per id, the opening that carries into it, settled when that opening ends however it ends (resolvePdfId). */
		pdfOpeningCarry?: Map<string, Promise<void>>;
		pdfHeadSource(file: TFile): HeadSource;
		movePdfClaimOnRename(file: TFile, oldPath: string): Promise<void>;
		/**
		 * A PDF renamed off `oldPath` while a pane holds its claim: every other claim of the file's ink on that name moves
		 * to the file's name. `atRename`: the deletion waiting at `oldPath` when the rename was heard; `owed`: the inks of
		 * the leaves owed off the file then, whose claims moveOwedClaims moves (taken at the call when not given).
		 */
		movePdfClaimsBesidePane(file: TFile, oldPath: string, atRename: object | undefined, owed?: ReadonlySet<string>): Promise<void>;
		/** The rename handler's start of movePdfClaimsBesidePane, in the background: a pane holds the claim of `file`. */
		pdfRenamedWithPane(file: TFile, oldPath: string, atRename: object | undefined): void;
		/**
		 * The rename handler moved pane `root`'s file off `oldPath`, `deletion` waiting there when the rename was heard;
		 * `moved`: the id it moved off that name with the file, if the pane had one. Kept for an identification of the
		 * pane that is running (resolvePdfId's claim step).
		 */
		notePdfPaneRenamed(root: HTMLElement, oldPath: string, deletion: object | undefined, moved: string | undefined): void;
		pdfIdForPath(path: string): string | null;
		pdfPaneHoldsClaim(path: string): boolean;
		pdfInkSnapshot(id: string): string | null;
		/**
		 * The other inks a whole-PDF clear of `path` from a pane on `id` reaches while a leave of the path is owed. An
		 * entry with `reachedIf` is one whose claims are not read yet: reached only when that ink's claims pass it.
		 */
		pdfInkOwedWith(path: string, id: string): { id: string; keep: string[] | null; reachedIf?: (claims: readonly string[]) => boolean }[];
		pdfControllerWithSelection(path: string): PdfInkController | null;
		pdfDeleteContext(): PdfDeleteContext;
		attachPdfPendingDeletes(): void;
		moveBlankPanes(path: string, id: string): void;
		pairedInkLeaves(id: string, path: string, from: string): Promise<void>;
		/**
		 * The candidates of an open of `path` put in the order the owed leaves need: a pane a change check met
		 * on found ink keeps it; any other open takes the ink that keeps the path before the ink that is to leave it.
		 */
		pdfOwedFirst?(path: string, root: HTMLElement, family: string, candidates: InstanceClaim[]): void;
		/** Whether ink `id`'s owed leaves run now (releasePdfId): its file may go to the trash at any await. */
		pdfLeaving?(id: string): boolean;
		/** Whether a leave run moved ink `id`'s file to the trash in this session (pairedInkLeaves). */
		pdfLeftForTrash?(id: string): boolean;
	}
}

/** The per-vault local store key for PDF deletions still in their grace at quit. */
const PDF_PENDING_DELETES_KEY = "handwriting-pdf-pending-deletes";
/**
 * The per-vault, per-device local store key for ink found for a PDF path that still has to leave it (leaveWhenLetGo)
 * at quit. Its own key, beside the deletions': a build without it never reads it, and with none saved nothing is owed.
 */
const PDF_OWED_LEAVES_KEY = "handwriting-pdf-owed-leaves";

/**
 * How long a PDF's bytes must stay still after a change before the panes
 * showing it are identified again. A sync can land one file in more than one
 * write, and the id is read from the file's head and length, so identifying
 * between writes reads a document that never existed.
 */
const PDF_MODIFY_SETTLE_MS = 1_000;
const CARRIED_NOTICE = "Handwriting: this PDF changed on disk. Your ink was carried over to its new version.";
const KEPT_NOTICE = "Handwriting: this PDF changed on disk. Ink drawn before the change is kept in its old ink file; new ink goes to a new one.";
/** Per plugin, per new ink id: the ids of every stroke carried into it from an older version (carryInk). */
const carriedInto = new WeakMap<HandwritingPlugin, Map<string, Set<string>>>();
/**
 * The mark of an identification running for a pane (resolvePdfId), gone once it ends. `opening`: it may carry ink from
 * an older version of the PDF on a fresh open (carryOld). `fresh`: the id it chose that no ink file had, once chosen.
 * `chain`: the fresh ids chosen by the earlier openings of the pane that a change check met still running, oldest first;
 * this identification may carry into one as it would into a fresh id, and none is a source of the old ink. `said`: it
 * carried and said so, so the check that started it says nothing more. `renamed`: the first rename of the pane's file
 * heard while it runs (notePdfPaneRenamed).
 */
interface Identifying { opening: boolean; fresh?: string; chain?: readonly string[]; said?: boolean; renamed?: PaneRenamed }
/**
 * The first rename of a pane's file heard while an identification of the pane runs, for the open's own claim move
 * (resolvePdfId's claim step): the name the file left, the deletion waiting there when the rename was heard, and the ids
 * the rename handler moved off that name with the file.
 */
interface PaneRenamed { from: string; deletion: object | undefined; moved: Set<string> }
const identifying = new WeakMap<HTMLElement, Identifying>();
/** One pane's ink as a change check read it before identifying the pane again (onPdfModified). */
interface Carry { was: string; strokes: readonly InkStroke[]; from: PageData | null; sound: boolean }
/** What a change check took for one pane, and the token of the identification it started for the pane (resolvePdfId). */
interface Handed { carries: readonly Carry[]; token: object | undefined }
/**
 * Per plugin, per pane: what the newest change check took for the pane. A newer check that finds the pane still on
 * that check's identification takes it over, beside the pane's own ink, and the older check leaves the carry to it. The
 * check that carries deletes it, so nothing here outlives its check.
 */
const handedOn = new WeakMap<HandwritingPlugin, WeakMap<HTMLElement, Handed>>();
/** Per pane: the path a change check met its view with no file at, until a check or the sync meets its file. */
const noFileAt = new WeakMap<HTMLElement, string>();
/**
 * Per path, per pane there on a blank opened before the vault's list was full: the ink a retirement or an open then
 * found for the path (moveBlankPanes), until the change check that identifies the pane again meets it idle, or finds
 * it gone.
 */
const pairMoves = new WeakMap<HandwritingPlugin, Map<string, Map<HTMLElement, { from: string; to: string }>>>();
/**
 * Per path, the panes a change check that met new bytes held (busy, or with no file) and asked again: still owed an
 * identification for those bytes, so the check asked again identifies them even when it meets their pairing's move
 * (onPdfModified). Follows a rename with the wait (movePdfModifiedOnRename).
 */
const changeOwed = new WeakMap<HandwritingPlugin, Map<string, Set<HTMLElement>>>();
/**
 * One path ink found for it is to leave, for the blank `from` drawn on before its pane moved (pairedInkLeaves). `had`:
 * the ids of the strokes the found ink held when the leave was first owed, and of every stroke carried from it into
 * `from` since; the others were drawn on it since, and go into `from` before it leaves. Unset while the
 * found ink was not read when the leave was owed: then its file is read once on its own (hadOnDisk), and `had` is what
 * that file held and the strokes drawn in this session before the owe. `was`: the names the copy had before a rename
 * while the leave was owed (movePdfModifiedOnRename), oldest first. The claim move at a rename passes over an ink whose
 * claims cannot be read then; that ink still claims one of them, and it moves to `path` later (wasName). `keptPaths`
 * and `foundPaths`: the paths `from` and the found ink claimed when the leave was owed (unset when they were not read
 * then), under the names this session's renames gave them since. With them a run tells a rename made where the leave is
 * not held from a delete (leaveMovedTo).
 */
interface OwedLeave { path: string; from: string; had?: string[]; was?: string[]; keptPaths?: string[]; foundPaths?: string[] }

/**
 * A name `leave` was owed under before a rename that `claims` still holds, not a deleted file's claim kept for its
 * retirement, and whether it is sure to move to the leave's path: no file is at it now, or the copy is still at the
 * leave's path (a file at the former name is then another one, come there since). With a file at the former name and
 * none at the leave's path, the copy may be the file at the former name (moved back by a sync tool): not sure, and the
 * leave stays owed. Undefined when there is none.
 */
function wasName(
	plugin: HandwritingPlugin,
	id: string,
	leave: OwedLeave | undefined,
	claims: readonly string[]
): { name: string; sure: boolean } | undefined {
	const name = leave?.was?.find((w) => claims.includes(w) && !plugin.pdfStore.claimHeldByDeletion(id, w, leave.path));
	if (leave === undefined || name === undefined) return undefined;
	const vault = plugin.app.vault;
	return { name, sure: vault.getFileByPath(name) === null || vault.getFileByPath(leave.path) !== null };
}
/** Per owed leave: the read of the found ink's file made when it was owed with that ink not read (hadOnDisk). */
const hadReads = new WeakMap<OwedLeave, Promise<void>>();

/**
 * The ids of the strokes in the file the found ink `id`'s own read took in, once a read out now lands sound (the record
 * read, ready), or null. That base is the file whole as it was read (carrySource); no write of `id` lands while its read
 * is out (a save waits for it), so it is what the file held when the read started. Taken as the read settles, not
 * later: an adoption or a fresh read of a changed file replaces the base with strokes drawn since.
 */
async function baseAtLoad(plugin: HandwritingPlugin, id: string, leave: OwedLeave): Promise<string[] | null> {
	for (let pass = 0; pass < 8; pass++) {
		if (plugin.unloaded || plugin.pdfStore.inkReady(id)) break;
		const drained = await plugin.pdfStore.settle();
		if (drained || owedLeaveOf(plugin, id, leave.path, leave.from) !== leave) break;
	}
	if (plugin.unloaded || !plugin.pdfStore.inkReady(id)) return null;
	return (plugin.pdfStore.carrySource(id)?.strokes ?? []).map((s) => s.id);
}

/**
 * What an owed leave's carry off the found ink `id` hands beside the strokes drawn on it since the owe (carryInk's
 * `from`): the unknown entries of its file's objects, nothing else of that file, or null when it is not read. carriedBase
 * copies an entry only for a stroke the carry adds, so a stroke keeps the fields a later build wrote on it, the tool it
 * was written with included, and the found ink's other fields, pageless strokes and the entries of the strokes it held
 * at the owe stay with it, as before. With no entry for an added stroke the carry brings the strokes alone, and the
 * kept ink's file is written as before. Taken beside the strokes, at the same moment: a read of the found ink landing
 * later replaces its base whole.
 */
function strokeEntriesOf(plugin: HandwritingPlugin, id: string): PageData | null {
	const base = plugin.pdfStore.carrySource(id);
	return base === null ? null : { ...emptyPage(id), unknownByObject: base.unknownByObject };
}

/**
 * A leave owed while the found ink `id` is not read yet (a pane has its id, its read still out): the strokes it held at
 * the owe are the ones its file held then and the ones drawn on it in this session so far. The file it held then is the
 * one its own read takes in (baseAtLoad). With no sound read landing (no file, a damaged or locked one), the file is
 * read here on its own, as readPdfPaths reads one: not taken as seen, no recovery, nothing written, no notice; no ink
 * is saved to it in this session meanwhile. Neither: `had` stays unset, and the run takes the strokes the ink holds
 * then, as before.
 */
function hadOnDisk(plugin: HandwritingPlugin, id: string, leave: OwedLeave): void {
	const before = plugin.pdfStore.strokes(id).map((s) => s.id);
	const disk = (async (): Promise<string[] | null> => {
		try {
			const adapter = plugin.app.vault.adapter;
			const final = await plugin.store.resolvePath(id);
			if (!(await adapter.exists(final))) return null;
			const page = parsePage(await adapter.read(final), id);
			return page.damaged ? null : page.data.strokes.map((s) => s.id);
		} catch {
			return null;
		}
	})();
	const read = (async () => {
		const base = await baseAtLoad(plugin, id, leave);
		const held = base ?? (await disk);
		if (held === null || leave.had !== undefined || plugin.unloaded) return;
		leave.had = [...new Set([...held, ...before])];
		if (owedLeaveOf(plugin, id, leave.path, leave.from) === leave) saveOwedLeaves(plugin);
	})();
	hadReads.set(leave, read);
}
/**
 * Per ink id: the paths it was to leave for a blank drawn on before its pane moved (pairedInkLeaves), while a pane
 * showed it. It leaves them once no pane shows it (releasePdfId). Kept until a leave has run, and saved across a quit
 * under its own key (PDF_OWED_LEAVES_KEY), so a leave that could not run, or was owed at a quit, runs again by the next
 * launch.
 */
const leaveWhenLetGo = new WeakMap<HandwritingPlugin, Map<string, OwedLeave[]>>();
/**
 * Per plugin, per found ink id: the leaves owed no more in this session (they ran, or had nothing left to do). An open
 * that read the found ink's file before its run wrote it, and chooses after the run forgot the leave, still holds the
 * path the run dropped (an open takes in what it read from disk); the ink that keeps the path is still taken first
 * (pdfOwedFirst). Session memory only: the next launch reads the files as the run left them.
 */
const leavesGone = new WeakMap<HandwritingPlugin, Map<string, OwedLeave[]>>();
/** Per plugin: the found inks whose owed leaves run now (releasePdfId); the run releases the record at its end. */
const leavesRunning = new WeakMap<HandwritingPlugin, Set<string>>();
/**
 * Per plugin: the found inks a leave run moved to the trash in this session. An open that listed one before the move and
 * reads it after the run ended finds no file: that ink left, its file is not unreadable. Session memory only.
 */
const leftForTrash = new WeakMap<HandwritingPlugin, Set<string>>();
/**
 * Per plugin: the found inks let go again while their run was going (a pane came onto one during the run and closed
 * before it ended). That run looks again at its end, so a leave that waited for that pane does not wait for the next
 * let-go or launch.
 */
const letGoWhileRunning = new WeakMap<HandwritingPlugin, Set<string>>();
/**
 * Per pane: the found ink it showed when a change check identified it again, with the token of that identification. The
 * pane keeps it through the check, as a pane on the found ink keeps it until it closes, and the leave waits.
 */
const keepFound = new WeakMap<HTMLElement, { id: string; token: object | undefined }>();

/**
 * Per plugin: the claim moves of PDFs renamed while no pane showed them (movePdfClaimOnRename) that have not landed,
 * each with the file (its path read at each use) and the name the file had. Until a move lands, the file's ink may
 * still claim that name. Session memory only.
 */
const claimMovesWaiting = new WeakMap<HandwritingPlugin, Set<ClaimMove>>();

/**
 * One waiting claim move. `family`: the content family its latest try read from the file's head, kept before that
 * try lists the ink folder, so a try that fails there still names it; undefined until a head read ends.
 */
interface ClaimMove {
	file: TFile;
	oldPath: string;
	family?: string;
	/**
	 * The deletion waiting at the old name at the rename, if any (PdfInkStore.deletionAt). One waiting there when the
	 * move lands that is not this one is a later file's, made at the name since and deleted: the move leaves it to its
	 * grace.
	 */
	deletionAtRename?: object;
	/**
	 * A move made beside a pane that holds the file's claim (movePdfClaimsBesidePane), with the inks of the leaves owed
	 * off the file at the rename: those inks are passed over, moveOwedClaims moves their claims. Such a move is not in
	 * claimMovesWaiting.
	 */
	besidePane?: ReadonlySet<string>;
}

/**
 * Per plugin and file: the claim moves of renames heard while a pane on the file was being identified, each with the
 * name the file left, the deletion waiting there at the rename and the owed leaves' inks then. Started once no pane on
 * the file is being identified (markPdfIdentification). Session memory only.
 */
const besidePaneWaiting = new WeakMap<HandwritingPlugin, Map<TFile, { oldPath: string; atRename: object | undefined; owed: ReadonlySet<string> }[]>>();

/** The found and kept inks of each leave owed off `path` now: at a rename with a pane, moveOwedClaims moves their claims. */
function owedLeaveInksOff(plugin: HandwritingPlugin, path: string): Set<string> {
	const ids = new Set<string>();
	for (const [found, list] of leaveWhenLetGo.get(plugin) ?? []) {
		for (const o of list) {
			if (o.path !== path) continue;
			ids.add(found);
			ids.add(o.from);
		}
	}
	return ids;
}

/** `path` is a name the file now at `at` had before a rename whose claim move has not landed (claimMovesWaiting). */
function renamedFromWaiting(plugin: HandwritingPlugin, path: string, at: string): boolean {
	for (const move of claimMovesWaiting.get(plugin) ?? []) if (move.oldPath === path && move.file.path === at) return true;
	return false;
}

/** The old name and the family read of each claim move onto the file now at `path` that has not landed. */
function movesOnto(plugin: HandwritingPlugin, path: string): { oldPath: string; family: string }[] {
	const out: { oldPath: string; family: string }[] = [];
	for (const move of claimMovesWaiting.get(plugin) ?? []) {
		if (move.file.path === path && move.oldPath !== path && move.family !== undefined) out.push({ oldPath: move.oldPath, family: move.family });
	}
	return out;
}

/**
 * Per plugin: each owed leave's claim move (moveOwedClaims), from its rename until it ends, however it ends: the name it
 * moves the leave's inks off, the name the copy is at now (followed at each later rename, movePdfModifiedOnRename),
 * and the content families of those inks. Session memory only.
 */
const owedMovesWaiting = new WeakMap<HandwritingPlugin, Set<{ oldPath: string; at: string; families: readonly string[] }>>();

/**
 * familiesRenamedOff for the owed leaves' claim moves: until such a move ends, the leave's inks may still claim the
 * name the copy was renamed off, and the copy stands under its new name.
 */
function owedFamiliesRenamedOff(plugin: HandwritingPlugin, path: string, except?: string): string[] {
	const out: string[] = [];
	for (const move of owedMovesWaiting.get(plugin) ?? []) {
		if (move.oldPath !== path || move.at === path || move.at === except) continue;
		if (plugin.app.vault.getFileByPath(move.at)) out.push(...move.families);
	}
	return out;
}

/**
 * The content families of files renamed off `path` whose claim moves have not landed, each standing elsewhere now:
 * ink of such a family that claims `path` is that live file's, neither the ink of a file that leaves `path` nor an
 * older version of one saved there. A move with no family read yet names none. A move whose file was at `except` is
 * passed over: a deleted file's own move keeps the name it was deleted at, and another file renamed onto that name
 * would stand in for it. An owed leave's claim move counts as a no-pane move does (owedFamiliesRenamedOff).
 */
function familiesRenamedOff(plugin: HandwritingPlugin, path: string, except?: string): string[] {
	const out: string[] = [];
	for (const move of claimMovesWaiting.get(plugin) ?? []) {
		if (move.oldPath !== path || move.family === undefined || move.file.path === path || move.file.path === except) continue;
		if (plugin.app.vault.getFileByPath(move.file.path)) out.push(move.family);
	}
	return [...out, ...owedFamiliesRenamedOff(plugin, path, except)];
}

/**
 * The inks of `family` that a leave owed off `path` in this session names, or one owed no more in it (leavesGone): its
 * found ink and its kept ink. The open takes the kept one first (pdfOwedFirst).
 */
function owedInksAt(plugin: HandwritingPlugin, path: string, family: string): string[] {
	const ids: string[] = [];
	for (const byId of [leaveWhenLetGo.get(plugin), leavesGone.get(plugin)]) {
		for (const [found, list] of byId ?? []) {
			for (const o of list) if (o.path === path) ids.push(found, o.from);
		}
	}
	return ids.filter((id) => familyOf(id) === family);
}

/**
 * Another PDF in the vault than `file` is the document `family` names. Only those whose size, as the vault last saw it,
 * is `byteLength` (or is not known) are read and hashed, as an open hashes them, stopping at the first that is. One that
 * cannot be read counts as one: nothing rules it out. Read only by an open whose ink folder would not list.
 */
async function copyInVault(plugin: HandwritingPlugin, file: TFile, family: string, byteLength: number): Promise<boolean> {
	for (const other of plugin.app.vault.getFiles()) {
		if (other.extension !== "pdf" || other.path === file.path) continue;
		const size = (other as { stat?: { size?: number } }).stat?.size;
		if (typeof size === "number" && size !== byteLength) continue;
		try {
			const read = await readPdfHead(plugin.pdfHeadSource(other));
			if ((await pdfInkIdFromHead(read.head, read.byteLength, window.crypto)) === family) return true;
		} catch {
			return true;
		}
	}
	return false;
}

/** A pane shows `id`, or is being identified again by a change check and keeps it (keepFound). */
function showsInk(plugin: HandwritingPlugin, id: string): boolean {
	if ([...plugin.pdfIds.values()].includes(id)) return true;
	for (const root of plugin.pdfFiles.keys()) if (keepFound.get(root)?.id === id) return true;
	return false;
}

/** Write the owed leaves where the next launch finds them; none owed, the key goes. */
function saveOwedLeaves(plugin: HandwritingPlugin): void {
	const saved = [...(leaveWhenLetGo.get(plugin) ?? [])].flatMap(([id, list]) =>
		list.map((o) => ({
			id,
			path: o.path,
			from: o.from,
			...(o.had !== undefined ? { had: [...o.had] } : {}),
			...(o.was !== undefined && o.was.length > 0 ? { was: [...o.was] } : {}),
			...(o.keptPaths !== undefined ? { keptPaths: [...o.keptPaths] } : {}),
			...(o.foundPaths !== undefined ? { foundPaths: [...o.foundPaths] } : {}),
		}))
	);
	plugin.app.saveLocalStorage(PDF_OWED_LEAVES_KEY, saved.length > 0 ? JSON.stringify(saved) : null);
}

/** The owed leave of `id` off `path` for `from`, or undefined. */
function owedLeaveOf(plugin: HandwritingPlugin, id: string, path: string, from: string): OwedLeave | undefined {
	return leaveWhenLetGo.get(plugin)?.get(id)?.find((o) => o.path === path && o.from === from);
}

/** The leave of `id` off `path` for `from` is owed no more: it ran, or there is nothing left for it to do. */
function forgetOwedLeave(plugin: HandwritingPlugin, id: string, path: string, from: string): void {
	const byId = leaveWhenLetGo.get(plugin);
	const list = byId?.get(id);
	if (!byId || !list) return;
	const left = list.filter((o) => !(o.path === path && o.from === from));
	if (left.length === list.length) return;
	if (left.length > 0) byId.set(id, left);
	else byId.delete(id);
	let gone = leavesGone.get(plugin);
	if (!gone) leavesGone.set(plugin, (gone = new Map<string, OwedLeave[]>()));
	gone.set(id, [...(gone.get(id) ?? []).filter((o) => !(o.path === path && o.from === from)), { path, from }]);
	saveOwedLeaves(plugin);
}

/**
 * Each leave owed off `path` that `id` is the found ink or the kept ink of, with the names the copy had before a rename
 * while it was owed; a leave owed under no other name ties nothing (PdfInkStore's retirement of a deleted path).
 */
function owedLeaveTies(plugin: HandwritingPlugin, id: string, path: string): LeaveTie[] {
	const ties: LeaveTie[] = [];
	for (const [found, list] of leaveWhenLetGo.get(plugin) ?? []) {
		for (const o of list) {
			if (o.path !== path || o.was === undefined || o.was.length === 0) continue;
			if (found === id || o.from === id) ties.push({ found, kept: o.from, was: [...o.was] });
		}
	}
	return ties;
}

/**
 * The retirement of the deleted `path` moved `id`'s claim onto `next`, a name the copy had while a leave `id` is a side of
 * was owed off `path`: the copy moved back by a delete and a create. Each such leave is owed off `next` now, `path` among
 * the names it had, and its claims at the owe moved from `path` to `next` with it, as movePdfModifiedOnRename moves
 * them at a rename; saved at once.
 */
function moveLeavesBack(plugin: HandwritingPlugin, id: string, path: string, next: string): void {
	let moved = false;
	for (const [found, list] of leaveWhenLetGo.get(plugin) ?? []) {
		for (const o of list) {
			if (o.path !== path || (found !== id && o.from !== id) || o.was?.includes(next) !== true) continue;
			o.was = [...o.was.filter((p) => p !== path && p !== next), path];
			o.path = next;
			if (o.keptPaths !== undefined) o.keptPaths = o.keptPaths.map((p) => (p === path ? next : p));
			if (o.foundPaths !== undefined) o.foundPaths = o.foundPaths.map((p) => (p === path ? next : p));
			moved = true;
		}
	}
	if (moved) saveOwedLeaves(plugin);
}

/** Each leave owed off `path`, under any name the copy had: its found ink and its kept ink. */
function owedLeavesOff(plugin: HandwritingPlugin, path: string): { found: string; kept: string }[] {
	const out: { found: string; kept: string }[] = [];
	for (const [found, list] of leaveWhenLetGo.get(plugin) ?? []) for (const o of list) if (o.path === path) out.push({ found, kept: o.from });
	return out;
}

/**
 * The deleted `path`'s ink `kept` moved onto `next`, by its retirement or an open, while the leave of `found` off `path`
 * for it was owed: the leave is owed off `next` now, `path` among the names the copy had, and its claims at the owe moved
 * with it, as movePdfModifiedOnRename moves them at a rename; saved at once. It runs there once `found` is let go.
 */
function leaveFollowedOnto(plugin: HandwritingPlugin, found: string, kept: string, path: string, next: string): void {
	const o = owedLeaveOf(plugin, found, path, kept);
	if (o === undefined || owedLeaveOf(plugin, found, next, kept) !== undefined) return;
	o.was = [...(o.was ?? []).filter((p) => p !== path && p !== next), path];
	o.path = next;
	if (o.keptPaths !== undefined) o.keptPaths = o.keptPaths.map((p) => (p === path ? next : p));
	if (o.foundPaths !== undefined) o.foundPaths = o.foundPaths.map((p) => (p === path ? next : p));
	saveOwedLeaves(plugin);
	let followed = followedOnto.get(plugin);
	if (!followed) followedOnto.set(plugin, (followed = new Set<string>()));
	followed.add(found);
}

/** Per plugin: the found inks whose claim followed their kept ink off a deleted path in this session (leaveFollowedOnto). */
const followedOnto = new WeakMap<HandwritingPlugin, Set<string>>();

/**
 * The found inks of the leaves owed for `kept` off a path whose deletion is in its grace. An open whose choice adopts
 * `kept` reads them in first, so each follows it (PdfInkStore.claimPath), and lets them go after, so the leave runs on
 * the path the open is at.
 */
function foundLeavingWith(plugin: HandwritingPlugin, kept: string): string[] {
	const waiting = plugin.pdfStore.pendingClaims();
	const ids: string[] = [];
	for (const [found, list] of leaveWhenLetGo.get(plugin) ?? []) {
		if (found !== kept && list.some((o) => o.from === kept && waiting.has(o.path))) ids.push(found);
	}
	return ids;
}

/**
 * The owed leaves saved at the last quit, back in session memory now, so an open before the layout is ready puts the
 * kept ink first (pdfOwedFirst); each runs once the layout is ready if no pane shows its ink then (releasePdfId), or
 * waits for its let-go as in a session. A store without the key, or with one this build cannot read, owes nothing.
 */
function restoreOwedLeaves(plugin: HandwritingPlugin): void {
	let raw = plugin.app.loadLocalStorage(PDF_OWED_LEAVES_KEY) as unknown;
	try {
		if (typeof raw === "string") raw = JSON.parse(raw);
	} catch {
		raw = null;
	}
	if (!Array.isArray(raw)) return;
	let byId = leaveWhenLetGo.get(plugin);
	for (const entry of raw as unknown[]) {
		const e = entry as { id?: unknown; path?: unknown; from?: unknown; had?: unknown; was?: unknown; keptPaths?: unknown; foundPaths?: unknown } | null;
		if (typeof e?.id !== "string" || typeof e.path !== "string" || typeof e.from !== "string") continue;
		if (!byId) leaveWhenLetGo.set(plugin, (byId = new Map<string, OwedLeave[]>()));
		const list = byId.get(e.id) ?? [];
		if (list.some((o) => o.path === e.path && o.from === e.from)) continue;
		const strings = (a: unknown): string[] | undefined => (Array.isArray(a) ? a.filter((s): s is string => typeof s === "string") : undefined);
		const had = strings(e.had);
		const was = strings(e.was) ?? [];
		const keptPaths = strings(e.keptPaths);
		const foundPaths = strings(e.foundPaths);
		list.push({
			path: e.path,
			from: e.from,
			...(had !== undefined ? { had } : {}),
			...(was.length > 0 ? { was } : {}),
			...(keptPaths !== undefined ? { keptPaths } : {}),
			...(foundPaths !== undefined ? { foundPaths } : {}),
		});
		byId.set(e.id, list);
	}
	for (const id of [...(byId?.keys() ?? [])]) plugin.releasePdfId(id);
}

/** Per plugin: the ids with leaves owed let go before the app's layout was ready, each let go again once it is. */
const letGoAtLayout = new WeakMap<HandwritingPlugin, Set<string>>();

/**
 * Whether the let-go of `id`, with leaves owed, waits for the app's layout: the workspace not ready and the store's
 * wait for it not come yet. Then `id` is let go again (releasePdfId) from the one start the store hands its layout
 * hook, unless the plugin unloaded first. Registered, never awaited: the load goes on.
 *
 * `id` is in the set before the start is registered: past the app's first layout (a saved workspace's load clears the
 * layout, the flag false again) the hook runs the start at once, inside the registration, and the id is let go again
 * there: its run starts then, or is held as any let-go's is. So this let-go is done: true either way.
 */
function waitedForLayout(plugin: HandwritingPlugin, id: string): boolean {
	if (!plugin.pdfStore.waitsForLayout() || plugin.app.workspace.layoutReady) return false;
	const ids = letGoAtLayout.get(plugin);
	if (ids) {
		ids.add(id);
		return true;
	}
	const waiting = new Set<string>([id]);
	letGoAtLayout.set(plugin, waiting);
	plugin.pdfStore.whenLayoutReady(() => {
		letGoAtLayout.delete(plugin);
		if (plugin.unloaded) return;
		for (const each of waiting) plugin.releasePdfId(each);
	});
	return true;
}

/** Per plugin: the claim moves of owed leaves, in rename order; how many wait or run; the ids to let go after the last. */
const claimMoves = new WeakMap<HandwritingPlugin, { tail: Promise<unknown>; waiting: number; release: Set<string> }>();

/**
 * The copy renamed while a pane holds its claim, leaves owed off the old name (now off the new one): the rename moved
 * the claims of the panes' own ids only. The found ink and the kept ink of each such leave move theirs here, as
 * movePdfClaimOnRename moves them for a PDF no pane holds. Left on the old name, the leave's next run found the new
 * name unclaimed by them and forgot the leave, and the strokes drawn on the found ink since the owe never reached the
 * kept ink. Each record loaded here is released, and each found ink let go, only once every claim moved: a let-go
 * runs the leave (releasePdfId), or marks a run going to look again at its end, or waits while a pane shows the ink.
 *
 * An ink whose first read is already running (a leave run's, or another move's) has no claims in memory until that read
 * lands, and ensureLoaded answers at once: the move waits it out (readied) before it reads them. The moves run one at a
 * time in rename order, and the lets-go wait for the last: a second rename inside one read found the first name still
 * on disk and passed the ink over, and a let-go between the two ran the leave at the last name with the ink claiming
 * the one between.
 */
function moveOwedClaims(
	plugin: HandwritingPlugin,
	leaves: readonly { id: string; from: string }[],
	oldPath: string,
	newPath: string,
	// The deletion waiting at the old name at the rename (PdfInkStore.deletionAt), taken by the caller then, not when
	// this move's turn comes: a move waiting behind another would take a later file's deletion as its own.
	atRename: object | undefined
): Promise<void> {
	let line = claimMoves.get(plugin);
	if (!line) claimMoves.set(plugin, (line = { tail: Promise.resolve(), waiting: 0, release: new Set<string>() }));
	const mine = line;
	mine.waiting++;
	// Counted from the rename until it ends (owedFamiliesRenamedOff): until then the leave's inks may claim the old name.
	const owed = owedMovesWaiting.get(plugin) ?? new Set();
	owedMovesWaiting.set(plugin, owed);
	const waits = { oldPath, at: newPath, families: [...new Set(leaves.flatMap((l) => [familyOf(l.from), familyOf(l.id)]))] };
	owed.add(waits);
	const run = mine.tail
		.then(() => moveClaimsOnce(plugin, leaves, oldPath, newPath, mine.release, atRename))
		.finally(() => {
			owed.delete(waits);
			if (--mine.waiting > 0 || plugin.unloaded) return;
			const ids = [...mine.release];
			mine.release.clear();
			for (const id of ids) plugin.releasePdfId(id);
		});
	mine.tail = run.catch(() => undefined);
	return run;
}

/** One rename's claim move (moveOwedClaims); the ids it loaded and the leaves' found inks go into `release`. */
async function moveClaimsOnce(
	plugin: HandwritingPlugin,
	leaves: readonly { id: string; from: string }[],
	oldPath: string,
	newPath: string,
	release: Set<string>,
	atRename: object | undefined
): Promise<void> {
	const heldPaths = (id: string) => plugin.pdfStore.claimedInstances((i) => i === id)[0]?.paths;
	// A deletion waiting at the old name now that was not there at the rename is a later file's, made at the name since
	// and deleted: the move passes over it (renamePath's missed road), and it goes on to its grace, as the no-pane move's.
	const later = (): boolean => {
		const now = plugin.pdfStore.deletionAt(oldPath);
		return now !== undefined && now !== atRename;
	};
	try {
		for (const id of new Set(leaves.flatMap((l) => [l.from, l.id]))) {
			const claimed = heldPaths(id) ?? (await plugin.store.readPdfPaths(id));
			if (plugin.unloaded) return;
			if (!claimed?.includes(oldPath)) continue;
			// The deleted file's claim on a path another file was renamed onto stays for its retirement.
			if (plugin.pdfStore.claimHeldByDeletion(id, oldPath, newPath)) continue;
			release.add(id);
			// Read, a read already running waited out: the record's own claims are the ones to trust.
			if (!(await readied(plugin, id))) continue;
			// Asked at the call, after this id's last await: a later deletion made during a read is seen.
			if (heldPaths(id)?.includes(oldPath)) plugin.pdfStore.renamePath(id, oldPath, newPath, later());
		}
	} finally {
		for (const l of leaves) release.add(l.id);
	}
}

/** The record of `id` read, waiting out a read already running for it (another pane's open) as ensureLoaded does not. */
async function readied(plugin: HandwritingPlugin, id: string): Promise<boolean> {
	await plugin.pdfStore.ensureLoaded(id);
	if (!plugin.pdfStore.inkReady(id) && !plugin.unloaded) await plugin.pdfStore.settle();
	return !plugin.unloaded && plugin.pdfStore.inkReady(id);
}

/**
 * Where the leave off `path` now belongs, once one of its inks no longer claims `path` (`keptNow`: the claims of the
 * ink that keeps the path, `foundNow`: of the found ink). A rename made where the leave is not held (another device,
 * another build, a session that never owed it) moves the claims and not the leave. The new name is told only from
 * the claims at the owe (`keptPaths`, `foundPaths`): `path` is no file now, every ink that left it claims exactly one
 * path no ink claimed at the owe, the same one, and that path is a file. Neither ink claiming `path` and neither
 * claiming a path new since the owe: a delete, "gone". The found ink alone left `path` with no new name, or with
 * its claims at the owe not known, "gone" as well: it has nothing left to leave there. Anything else, or the kept
 * ink's claims at the owe not known: "unsure", and nothing is dropped or moved. Reads memory only.
 */
function leaveMovedTo(
	plugin: HandwritingPlugin,
	leave: OwedLeave,
	path: string,
	keptNow: readonly string[],
	foundNow: readonly string[]
): { to: string } | "gone" | "unsure" {
	const keptLeft = !keptNow.includes(path);
	const foundLeft = !foundNow.includes(path);
	const atOwe = new Set([...(leave.keptPaths ?? []), ...(leave.foundPaths ?? [])]);
	const fresh = (now: readonly string[]) => now.filter((p) => !atOwe.has(p));
	const isFile = (p: string) => plugin.app.vault.getFileByPath(p) !== null;
	const pathThere = isFile(path);
	const one = (moved: readonly string[]): { to: string } | "unsure" => {
		const to = moved[0];
		return moved.length === 1 && to !== undefined && isFile(to) ? { to } : "unsure";
	};
	if (!keptLeft) {
		if (pathThere || leave.foundPaths === undefined) return "gone";
		const moved = fresh(foundNow);
		return moved.length === 0 ? "gone" : one(moved);
	}
	if (leave.keptPaths === undefined || pathThere) return "unsure";
	const keptMoved = fresh(keptNow);
	if (!foundLeft) return one(keptMoved);
	if (leave.foundPaths === undefined) return "unsure";
	const foundMoved = fresh(foundNow);
	if (keptMoved.length === 0 && foundMoved.length === 0) return "gone";
	if (keptMoved.length !== 1 || foundMoved.length !== 1 || keptMoved[0] !== foundMoved[0]) return "unsure";
	return one(keptMoved);
}

/**
 * The name the run of `found`'s leave `o` moves it to, told now from memory alone, or undefined when the run would not
 * move it (it would run at `o.path`, leave it owed, or forget it). `keptNow` and `foundNow`: the claims of `o.from` and of
 * `found` as they are now. Asked in the run's own order (pairedInkLeaves): first a name the leave was owed under before
 * that the kept ink still claims (wasName), moved to `o.path` when sure and stopping the run when not; the kept ink off
 * `o.path` with its claims at the owe not known stops it; then the same for the found ink; both inks on `o.path` runs it
 * there; else where the leave belongs now (leaveMovedTo). Nothing is moved, read or written.
 */
function leaveRunMovesTo(
	plugin: HandwritingPlugin,
	found: string,
	o: OwedLeave,
	keptNow: readonly string[],
	foundNow: readonly string[]
): string | undefined {
	// As renamePath moves a claim: the old name and the new one taken off, the new one put last.
	const movedOnto = (claims: readonly string[], name: string): string[] => [...claims.filter((p) => p !== name && p !== o.path), o.path];
	let kept: readonly string[] = keptNow;
	const was = wasName(plugin, o.from, o, kept);
	if (was !== undefined && !was.sure && !kept.includes(o.path)) return undefined;
	if (was?.sure === true) kept = movedOnto(kept, was.name);
	if (!kept.includes(o.path) && o.keptPaths === undefined) return undefined;
	let foundAt: readonly string[] = foundNow;
	const idWas = foundAt.includes(o.path) ? undefined : wasName(plugin, found, o, foundAt);
	if (idWas !== undefined && !idWas.sure) return undefined;
	if (idWas !== undefined) foundAt = movedOnto(foundAt, idWas.name);
	if (kept.includes(o.path) && foundAt.includes(o.path)) return undefined;
	const moved = leaveMovedTo(plugin, o, o.path, kept, foundAt);
	return typeof moved === "object" ? moved.to : undefined;
}

/** Every ink file's claims, with the claims this open counts for its own family's candidates taken in. */
function withClaims(claims: ReadonlyMap<string, readonly string[]>, candidates: readonly InstanceClaim[]): Map<string, string[]> {
	const out = new Map([...claims].map(([id, paths]) => [id, [...paths]]));
	for (const c of candidates) out.set(c.id, [...new Set([...(out.get(c.id) ?? []), ...c.paths])]);
	return out;
}

/** The slice of node's `fs` this needs, typed locally to avoid node typings. */
interface NodeFileHandle {
	read(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number
	): Promise<{ bytesRead: number }>;
	stat(): Promise<{ size: number }>;
	close(): Promise<void>;
}

/**
 * Open a file on disk for the ranged head read (PdfHead.ts).
 *
 * Obsidian ships an Electron renderer whose preload exposes `require`, which
 * is how PresentProbe.ts reaches @electron/remote (:180-191) and the pattern
 * copied here. It must stay a GUARDED, runtime require: a top-level `import`
 * from "fs" would be emitted into the bundle unconditionally and throw on
 * mobile the moment the plugin loads, taking every surface down with it.
 *
 * Throwing is a supported outcome - readPdfHead catches anything from here
 * and reads the whole file instead, which is what 1.4.5 always did.
 */
async function openRangedFile(fullPath: string): Promise<RangedHandle> {
	const w = window as { require?: (mod: string) => unknown };
	if (typeof w.require !== "function") throw new Error("no require: not an Electron renderer");
	const fs = w.require("fs") as { promises: { open(p: string, flags: string): Promise<NodeFileHandle> } };
	const handle = await fs.promises.open(fullPath, "r");
	return {
		read: async (into, at) => (await handle.read(into, 0, into.length, at)).bytesRead,
		// The size from THIS handle, never `file.stat.size`: the vault's
		// cached stat can lag an external write, and a length that disagrees
		// with the bytes being hashed changes the id - which would point a
		// document at a sidecar that does not exist.
		size: async () => Number((await handle.stat()).size),
		close: () => handle.close(),
	};
}

	/**
	 * Attach an ink controller to every open PDF view, and drop the ones whose
	 * views are gone.
	 *
	 * Keyed by root element, and swept by checking `isConnected`, because a
	 * leaf outlives the file in it: closing a PDF and opening another reuses
	 * the leaf, and a map keyed on the leaf would hand the new document the
	 * old document's overlays.
	 */
	function syncPdfControllers(this: HandwritingPlugin): void {
		const seen = new Set<HTMLElement>();
		for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
			const root = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl;
			if (!root) continue;
			seen.add(root);
			const path = (leaf.view as unknown as { file?: TFile }).file?.path ?? "";
			const existing = this.pdfInk.get(root);
			if (existing) {
				// Same pane, different document: forget the old id and hash the
				// new one before anything can be written under the wrong key.
				//
				// An EMPTY path is "not known yet", never "a different
				// document". `leaf.view.file` is momentarily undefined while
				// the viewer re-renders, on a layout change, and as a leaf
				// becomes active - all three of which run this sync - so a
				// bare `!==` read that transient as a document switch and
				// forgot the id, the history AND the selection under a user
				// who had done nothing but lasso some ink: "lasso'd it,
				// trashcan lit up, hit delete, trashcan and undo dimed, but
				// nothing deleted" (Alan, 2026-09-02). forgetHistory is the
				// only thing that empties the ring and the selection together,
				// which is why both lights went out at once.
				//
				// `resolvePdfId` already reads empty the same way: it returns
				// at `if (!file) return` rather than resolving an id for "",
				// and its post-await guards compare against a path that is
				// therefore always non-empty. Leaving the stored path alone
				// here keeps an in-flight resolution matching its own document
				// instead of aborting on a "" that was never a document.
				//
				// A pane whose PDF really closes is not lost by this: a leaf
				// that stops being a pdf leaf is not in `seen`, so the sweep
				// below unmounts it and drops both maps. A pdf leaf left
				// EMPTY keeps its stale id, which nothing can write under
				// while there is no document rendered to draw on, and the
				// next real path - any file, including a different one -
				// differs from the stored path and reclaims it.
				// A view a change check met with no file, its file back at the same path: the pane is checked again.
				if (path !== "" && noFileAt.get(root) === path && this.pdfFiles.get(root) === path) {
					noFileAt.delete(root);
					this.schedulePdfModified(path, new Set([root]));
				}
				if (path !== "" && this.pdfFiles.get(root) !== path) {
					noFileAt.delete(root);
					this.pdfFiles.set(root, path);
					const was = this.pdfIds.get(root);
					this.pdfIds.delete(root);
					if (was) this.releasePdfId(was);
					existing.forgetHistory();
					releaseHistory(existing);
					runDetached(this.resolvePdfId(leaf, root, existing), "identify a pdf for ink", () =>
						new Notice("Handwriting: could not identify this PDF - ink is disabled for it. Reopening the file retries.")
					);
				}
				continue;
			}
			this.pdfFiles.set(root, path);
			const win = root.ownerDocument.defaultView ?? window;
			const controller = new PdfInkController(
				root,
				win,
				(page) => {
					if (this.pdfCalibration) return calibrationStrokes(page);
					const id = this.pdfIds.get(root);
					return id ? this.pdfStore.strokesOnPage(id, page) : [];
				},
				// No id yet means the file is still being hashed. The controller
				// asks before every gesture and does nothing without one:
				// dropping a stroke is wrong and storing it under a guessed id
				// is worse.
				() => this.pdfIds.get(root) ?? null,
				// The whole document, in store order. This is the list the sink
				// below applies every op against, so it is the list the op's
				// indices have to be positions in. The page-filtered source
				// above is for hit-testing and painting only.
				() => {
					if (this.pdfCalibration) return [];
					const id = this.pdfIds.get(root);
					return id ? this.pdfStore.strokes(id) : [];
				},
				(op, mode) => {
					// The op's OWN document, never the pane's current one. An
					// undo pressed after this pane opened a different PDF must
					// act on the document the ink lives in; using whatever is on
					// screen would put strokes back into the wrong file.
					const id = op.path;
					if (!id) return;
					// The eraser's per-sample op: its indices are the page's, and
					// the store applies it to that page alone.
					if (mode === "live-page") {
						this.pdfStore.applyLivePage(id, op);
						return;
					}
					// One path for drawing, erasing and undoing: the op says what
					// changed, applyOp works out the resulting stroke list, and
					// the store writes it. Undo is then just the inverse op
					// arriving through the same door.
					const next = applyOp(this.pdfStore.strokes(id), op);
					// "live" means the gesture is still running: the screen
					// needs the new list, the disk does not. The controller
					// writes once at pen-up through the persist callback below.
					if (mode === "live") {
						this.pdfStore.replaceAllLive(id, next);
						return;
					}
					this.pdfStore.replaceAll(id, next);
					// Notes get this for free: InkOverlay's repaintPath fires at
					// every one of its twelve call sites, including the stroke
					// commit, and repaints every OTHER pane on the same note at
					// once. The PDF surface had no equivalent, so a second pane
					// on this document only learned ink had changed when the
					// disk poll below noticed a changed mtime - and that poll's
					// own backoff (reloadStride) stretches to five seconds once
					// it has been quiet, which writing in the first pane is
					// exactly what makes it. THE POLL IS NOT AT FAULT: it exists
					// to notice another DEVICE's write, and its backoff is
					// deliberate and argued in its own comment. The defect was
					// leaning on it as an in-process event bus instead of
					// telling the other pane directly, the way notes do.
					//
					// Mirrors repaintPath in the two places notes and PDFs
					// differ: COMMIT only, never "live" (the early return
					// above) - repaintPath also fires at gesture boundaries,
					// and a per-sample fan-out would repaint the other pane's
					// whole overlay dozens of times a second for a difference
					// nobody can see. And keyed on the document ID, not the
					// path - two panes can hold the same PDF under different
					// leaves, and the id is what the store is keyed by.
					//
					// One thing repaintPath has no equivalent of: a pane can be
					// mid-gesture. refresh() invalidates every overlay and
					// reschedules, and swapping ink under a live lasso, drag or
					// stroke tears it - the same reason the poll checks
					// `controller.idle` before reloading. A non-idle pane is
					// skipped here for the same reason and gets the same
					// fallback it already had: the next poll tick notices the
					// write, no worse off than before this fix existed.
					for (const [otherRoot, other] of this.pdfInk) {
						if (otherRoot === root) continue;
						if (this.pdfIds.get(otherRoot) !== id) continue;
						if (!other.idle) continue;
						other.refresh();
					}
				},
				// `commands` is not on the public App type, so it is reached
				// the way the note surface reaches it: a narrow cast behind a
				// typeof guard, and nothing happens if it is absent.
				(commandId) => {
					// A strip button whose command sits behind "Extra commands
					// for hotkeys" has no entry in the registry while the
					// setting is off, and executeCommandById would do nothing
					// at all. `runGatedCommand` holds exactly the actions that
					// were kept OUT of the palette, so it answers true only in
					// that case: the setting hides commands, it does not
					// remove tools. See CommandPaletteSplit.ts.
					if (runGatedCommand(commandId)) return;
					const commands = (this.app as unknown as {
						commands?: { executeCommandById(id: string): void };
					}).commands;
					if (typeof commands?.executeCommandById === "function") {
						commands.executeCommandById(commandId);
					}
				},
				// The controller does not import Notice - it observes the DOM
				// and nothing else, which is what keeps it constructible in a
				// test. Saying things is the plugin's job.
				(message) => {
					new Notice(message);
				},
				// The one write at the end of a gesture whose ops were applied
				// live. The controller decides when; the store decides how.
				// Live ops return before the other-pane refresh in the op sink
				// above, so the end of the gesture is where another pane on the
				// same PDF hears of it: an erase, lasso move or insert-space
				// otherwise left that pane showing the old ink. With one pane
				// open this is the save and one size check, nothing more.
				(id) => {
					this.pdfStore.save(id);
					if (this.pdfInk.size < 2) return;
					for (const [otherRoot, other] of this.pdfInk) {
						if (otherRoot === root || this.pdfIds.get(otherRoot) !== id || !other.idle) continue;
						other.refresh();
					}
				},
				// Both sources above are substituted under calibration, so the
				// document the controller reads is made up and nothing it works
				// out from it may be written. Set HERE, next to the
				// substitution, so a third synthetic source is one line from
				// being covered instead of one id prefix from being missed.
				() => this.pdfCalibration,
				// The page colour a snip's ink is made readable against: the
				// flatten's setting, read at each snip so a change applies to
				// the next one.
				() => this.settings.inkPdfColorMode,
				() => {
					const id = this.pdfIds.get(root);
					return id !== undefined && this.pdfStore.inkReady(id);
				},
				// An opening on this pane's path that chose a fresh id and has not ended: pdfIdForPath's
				// first test, read live, so it lifts with the mark on every way the opening ends.
				() => {
					const here = this.pdfFiles.get(root);
					if (here === undefined) return false;
					for (const [other, at] of this.pdfFiles) {
						const mark = at === here ? identifying.get(other) : undefined;
						if (mark?.opening === true && mark.fresh !== undefined) return true;
					}
					return false;
				},
				() => this.pdfFiles.get(root) || null
			);
			// The viewer's page turn, read off the leaf live at every paint.
			setViewTurnSource(controller, () => readViewTurn(leaf.view, root));
			controller.mount();
			this.pdfInk.set(root, controller);
			// The tab dragged to another window, or back: Obsidian moves this same root there and calls with the
			// window it went to, and the controller follows it (follow). The watch ends with the controller.
			if ("onWindowMigrated" in root) controller.disposers.push(root.onWindowMigrated((to) => controller.follow(to)));
			runDetached(this.resolvePdfId(leaf, root, controller), "identify a pdf for ink", () =>
				new Notice("Handwriting: could not identify this PDF - ink is disabled for it. Reopening the file retries.")
			);
		}
		for (const [root, controller] of [...this.pdfInk]) {
			if (seen.has(root) && root.isConnected) continue;
			controller.unmount();
			const was = this.pdfIds.get(root);
			this.pdfInk.delete(root);
			this.pdfIds.delete(root);
			this.pdfFiles.delete(root);
			if (was) this.releasePdfId(was);
		}
	}

	/**
	 * No pane shows this PDF id any more: once its ink is on disk, forget the
	 * session record, so the next open reads the sidecar as it is then - with
	 * whatever another device synced in meanwhile - instead of drawing on a
	 * stale copy whose next save would write over it. Kept when a pane shows
	 * the id again before this settles, when the write did not land, and in
	 * every case PdfInkStore.forgetIfUnchanged refuses.
	 */
	function releasePdfId(this: HandwritingPlugin, id: string): void {
		if (showsInk(this, id)) return;
		// A run of its owed leaves is going: that run releases the record at its end, and looks again first.
		let running = leavesRunning.get(this);
		if (running?.has(id)) {
			let again = letGoWhileRunning.get(this);
			if (!again) letGoWhileRunning.set(this, (again = new Set()));
			again.add(id);
			return;
		}
		// The last pane on ink found for a path whose blank was drawn on before its pane moved let it go: it leaves the
		// path now (pairedInkLeaves), then is released as any closed pane's record is. Each leave is owed until it ran:
		// one that fails or cannot run yet stays owed, saved, and stops no other; it runs again at the next let-go or
		// launch, not in this run.
		const owed = leaveWhenLetGo.get(this)?.get(id);
		if (owed !== undefined && owed.length > 0) {
			// Not before the app's layout is ready: the vault lists its files only then, and the run's checks of the copy's
			// names would read a file not listed yet as none. The leave stays owed, the record held; the id is let go
			// again once the layout is ready, and its run starts then, here. A later clear of the layout (a saved
			// workspace's load) leaves the vault listed: the run starts at once there, and a pane the new layout opens on
			// the id meanwhile keeps the record, as a reopen does (releaseRecord looks again).
			if (waitedForLayout(this, id)) return;
			if (!running) leavesRunning.set(this, (running = new Set()));
			running.add(id);
			const mine = running;
			runDetached(
				(async () => {
					try {
						for (const o of [...owed]) {
							if (this.unloaded) return;
							try {
								await this.pairedInkLeaves(id, o.path, o.from);
							} catch (err) {
								console.error(`[handwriting] ${id} could not leave ${o.path} yet; it is tried again later`, err);
							}
						}
					} finally {
						mine.delete(id);
					}
					if (this.unloaded) return;
					// Let go again during the run: a leave that waited for the pane that went is run again now, once per
					// such let-go (a leave that fails stays owed for the next let-go or launch, as before).
					if (letGoWhileRunning.get(this)?.delete(id) === true) return this.releasePdfId(id);
					releaseRecord(this, id);
				})(),
				`take ${id} off the paths it was to leave, no pane showing it`
			);
			return;
		}
		releaseRecord(this, id);
	}

	/** releasePdfId's plain half: no pane shows `id`, and nothing is owed to run first. */
	function releaseRecord(plugin: HandwritingPlugin, id: string): void {
		if ([...plugin.pdfIds.values()].includes(id)) return;
		const generation = plugin.pdfStore.generation(id);
		if (generation === null) return;
		runDetached(
			(async () => {
				await plugin.pdfStore.settle();
				if (!(await plugin.store.flushPage(id))) return;
				if ([...plugin.pdfIds.values()].includes(id)) return;
				plugin.pdfStore.forgetIfUnchanged(id, generation);
			})(),
			"forget a closed pdf's ink record"
		);
	}

	/**
	 * A PDF's bytes changed on disk: identify its panes again once the file is
	 * still. `panes` narrows that to the panes named; a wait already asking
	 * for every pane keeps asking for every pane.
	 */
	function schedulePdfModified(this: HandwritingPlugin, path: string, panes?: ReadonlySet<HTMLElement>): void {
		const timers = (this.pdfModifyTimers ??= new Map<string, { timer: number; panes: Set<HTMLElement> | null }>());
		const pending = timers.get(path);
		if (pending !== undefined) window.clearTimeout(pending.timer);
		let waiting: Set<HTMLElement> | null = null;
		if (panes && pending?.panes !== null) waiting = new Set([...(pending?.panes ?? []), ...panes]);
		timers.set(path, {
			timer: window.setTimeout(() => {
				timers.delete(path);
				runDetached(this.onPdfModified(path, waiting), `identify ${path} again after it changed`);
			}, PDF_MODIFY_SETTLE_MS),
			panes: waiting,
		});
	}

	/**
	 * A PDF renamed while a change waits to settle: the wait follows it, for the
	 * same panes, and its settle starts again at the rename. Left at the old
	 * path, it ran there, matched no pane, and every pane stayed on the old
	 * version's id: ink drawn after went to that version's file and was not
	 * there when the PDF reopened.
	 */
	function movePdfModifiedOnRename(this: HandwritingPlugin, oldPath: string, newPath: string): void {
		// An owed leave's claim move still waiting follows its copy to the new name: the copy stands there now.
		for (const move of owedMovesWaiting.get(this) ?? []) if (move.at === oldPath) move.at = newPath;
		// A leave owed off the old name is owed off the new one: the claims it drops moved with the file.
		const renamed: { id: string; from: string }[] = [];
		let claimsMoved = false;
		for (const [id, list] of leaveWhenLetGo.get(this) ?? []) {
			for (const o of list) {
				// The claims at the owe follow the name too, so a later rename made elsewhere is told from the new name.
				for (const key of ["keptPaths", "foundPaths"] as const) {
					const paths = o[key];
					if (paths === undefined || !paths.includes(oldPath)) continue;
					o[key] = paths.map((p) => (p === oldPath ? newPath : p));
					claimsMoved = true;
				}
				if (o.path !== oldPath) continue;
				o.was = [...(o.was ?? []).filter((p) => p !== oldPath && p !== newPath), oldPath];
				o.path = newPath;
				renamed.push({ id, from: o.from });
			}
		}
		if (renamed.length > 0 || claimsMoved) saveOwedLeaves(this);
		// A pane holds the new name's claim: the rename moves the panes' own claims (PluginOnload), the leaves' inks move
		// theirs here, and movePdfClaimsBesidePane moves every other, passing these inks over. With no pane holding it,
		// movePdfClaimOnRename moves every claim.
		if (renamed.length > 0 && this.pdfPaneHoldsClaim(newPath)) {
			// The deletion waiting at the old name now, after notePdfRenamed (PluginOnload): the move tells a later one from it.
			const atRename = this.pdfStore.deletionAt(oldPath);
			runDetached(moveOwedClaims(this, renamed, oldPath, newPath, atRename), `move the claims of the leaves owed off ${oldPath} to ${newPath}`);
		}
		// The pairing's moves and the panes owed an identification for new bytes follow the file with the wait. Left at the
		// old name, the check at the new one never met the drawn pane's move, and the found ink kept the path; or it met
		// the move with the new bytes forgotten, and passed the drawn pane over.
		const moves = pairMoves.get(this);
		const movesThere = moves?.get(oldPath);
		if (moves !== undefined && movesThere !== undefined) {
			moves.delete(oldPath);
			moves.set(newPath, new Map([...(moves.get(newPath) ?? []), ...movesThere]));
		}
		const owed = changeOwed.get(this);
		const owedThere = owed?.get(oldPath);
		if (owed !== undefined && owedThere !== undefined) {
			owed.delete(oldPath);
			owed.set(newPath, new Set([...(owed.get(newPath) ?? []), ...owedThere]));
		}
		const pending = this.pdfModifyTimers?.get(oldPath);
		if (pending === undefined) return;
		window.clearTimeout(pending.timer);
		this.pdfModifyTimers?.delete(oldPath);
		this.schedulePdfModified(newPath, pending.panes ?? undefined);
	}

	/**
	 * The ink id is made from the file's content, so new bytes are a new
	 * document, and every pane showing the file is identified again the way a
	 * pane that switches file is. Kept, a pane replaced under it (a sync, a
	 * re-export over the file) went on drawing into the old content's
	 * sidecar, and that ink was gone when the file reopened under its new
	 * content. A pane mid-gesture is left alone and asked again after another
	 * settle, so the document never changes under a live stroke. Only that
	 * pane is asked again: identifying a pane forgets its undo, and a second
	 * pane on the file that was identified already would lose the undo of
	 * every stroke drawn in it since.
	 *
	 * The plugin's own PDF writes never arrive here: flatten, snip and export
	 * all create a new file beside the source and never modify one. A flattened
	 * copy saved over its own PDF by the user does arrive, as another program's
	 * write, and the old version's ink is carried into it as for any other
	 * change; its pages hold that ink already, so the ink shows twice.
	 */
	async function onPdfModified(this: HandwritingPlugin, path: string, panes?: ReadonlySet<HTMLElement> | null): Promise<void> {
		const resolutions: Promise<void>[] = [];
		const held = new Set<HTMLElement>();
		// The held panes asked again after the settle; a view met with no file twice is held and not asked.
		const again = new Set<HTMLElement>();
		// The marks of the openings this check identifies again: one that carried has said so.
		const openings: Identifying[] = [];
		// The panes with ink to carry, each with what this check took for it: the ink its old id held, with the parsed
		// file it came with and whether its record was sound, read before releasePdfId (the release forgets the old
		// record detached, and it can finish before the new id lands, so asking after the await can miss them), and
		// the token its identification here took (resolvePdfId), to know at the carry that the pane's id is still the
		// one this check's own identification chose.
		const inked: { root: HTMLElement; mine: Handed }[] = [];
		// A carry off found ink whose leave of this path is owed (pairedInkLeaves) names that leave, with the strokes it
		// held at the owe as known then (`had`). What goes into the new version's ink is what the path keeps: the kept
		// ink's strokes and those drawn on the found ink since the owe, never the found ink's older strokes, which leave
		// with it. Those drawn since go with the unknown entries the found ink's file holds for them (its `from`,
		// strokeEntriesOf), taken here beside the strokes; nothing else of that file goes. On the carry itself, so a carry
		// a newer check takes over (handedOn) keeps the rule.
		type OwedCarry = Carry & { owed?: { leave: OwedLeave; had: readonly string[] | undefined } };
		// The panes on blanks waiting to move to ink found for this path (moveBlankPanes), and that ink leaving the path
		// for a blank drawn on before its pane moved, once per ink.
		const moves = pairMoves.get(this)?.get(path);
		// The panes an earlier check that met new bytes held, owed an identification for them (changeOwed), and those this
		// check holds the same way.
		const owedChange = changeOwed.get(this)?.get(path);
		const changedAgain = new Set<HTMLElement>();
		const leaving = new Set<string>();
		const leave = (move: { from: string; to: string }): void => {
			if (leaving.has(move.to)) return;
			leaving.add(move.to);
			runDetached(this.pairedInkLeaves(move.to, path, move.from), `take ${move.to} off ${path}, drawn on before it moved`);
		};
		let handed = handedOn.get(this);
		if (!handed) handedOn.set(this, (handed = new WeakMap<HTMLElement, Handed>()));
		// The leave of every pairing move met here on a drawn blank is owed before any pane is identified again, busy
		// panes' too (the found ink leaves whenever such a move is met), so a pane on the found ink takes the owed carry in
		// any order. Met first with none owed, that pane took the found ink whole, older strokes too, and let it go
		// before the leave began: the leave read the found ink's file again, the claim it held only in memory gone.
		for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
			const root = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl;
			if (!root || this.pdfFiles.get(root) !== path || (panes && !panes.has(root)) || !this.pdfInk.has(root)) continue;
			if (!(leaf.view as unknown as { file?: TFile }).file) continue;
			const move = moves?.get(root);
			if (move !== undefined && move.from === this.pdfIds.get(root) && !this.pdfStore.isEarlyBlank(move.from)) leave(move);
		}
		for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
			const root = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl;
			if (!root || this.pdfFiles.get(root) !== path) continue;
			if (panes && !panes.has(root)) continue;
			const controller = this.pdfInk.get(root);
			if (!controller) continue;
			// Met for new bytes: this check asks every pane (a real change), or an earlier one held this pane through them.
			const changed = !panes || owedChange?.delete(root) === true;
			if (!controller.idle) {
				held.add(root);
				again.add(root);
				if (changed) changedAgain.add(root);
				continue;
			}
			// A view with no file now is held, as a busy pane is; met so again, it is asked no more, and the sync asks
			// again once its file is back at the same path.
			if (!(leaf.view as unknown as { file?: TFile }).file) {
				held.add(root);
				if (noFileAt.get(root) !== path) {
					noFileAt.set(root, path);
					again.add(root);
					if (changed) changedAgain.add(root);
				}
				continue;
			}
			noFileAt.delete(root);
			// Met for ink found for its path (moveBlankPanes). Still on that blank, it is identified again below and ends
			// on the ink. Drawn on since: no carry, no notice; the pane, its stroke and the path stay the blank's, and the
			// ink found leaves the path (pairedInkLeaves), as for a blank drawn on before.
			const move = moves?.get(root);
			moves?.delete(root);
			if (move !== undefined && move.from === this.pdfIds.get(root) && !this.pdfStore.isEarlyBlank(move.from)) {
				leave(move);
				// New bytes too: the pane is identified again for them, as every pane is, and the carry below takes its strokes
				// from the blank into the new version's ink. Passed over, it went on drawing into the old version's ink file,
				// and those strokes were hidden once the PDF reopened on the new version.
				if (!changed) continue;
			}
			// A pane whose opening still runs is identified again as an opening, so its carry from the old version runs.
			const mark = identifying.get(root);
			const opening = mark?.opening === true;
			const was = this.pdfIds.get(root);
			// A check still running took ink for this pane, and no identification of the pane has started since that
			// check's own (a switch starts one, syncPdfControllers; a rename does not): the pane stayed on this PDF,
			// so what that check took passes to this one, beside the pane's own ink.
			const earlier = handed.get(root);
			const carries: OwedCarry[] = earlier !== undefined && earlier.token === this.pdfResolveTokens?.get(root) ? [...earlier.carries] : [];
			// On found ink whose leave of this path is owed: the pane keeps it through this check, and the
			// release below is no let-go, so the leave waits.
			const owedHere = was === undefined ? undefined : leaveWhenLetGo.get(this)?.get(was)?.find((o) => o.path === path);
			if (was && this.pdfStore.hasInk(was)) {
				const sound = this.pdfStore.inkReady(was);
				if (owedHere === undefined) carries.push({ was, strokes: this.pdfStore.strokes(was), from: this.pdfStore.carrySource(was), sound });
				else carries.push({ was, strokes: this.pdfStore.strokes(was), from: strokeEntriesOf(this, was), sound, owed: { leave: owedHere, had: owedHere.had?.slice() } });
			}
			const keeps = owedHere !== undefined;
			if (keeps && was !== undefined) keepFound.set(root, { id: was, token: undefined });
			this.pdfIds.delete(root);
			if (was) this.releasePdfId(was);
			controller.forgetHistory();
			releaseHistory(controller);
			let resolved: Promise<void> = this.resolvePdfId(leaf, root, controller, opening, opening ? [...(mark?.chain ?? []), ...(mark?.fresh !== undefined ? [mark.fresh] : [])] : undefined).catch(() => {
				new Notice("Handwriting: could not identify this PDF - ink is disabled for it. Reopening the file retries.");
			});
			if (keeps && was !== undefined) {
				const kept = { id: was, token: this.pdfResolveTokens?.get(root) };
				keepFound.set(root, kept);
				resolved = resolved.finally(() => {
					if (keepFound.get(root) !== kept) return;
					keepFound.delete(root);
					// Not back on the found ink (its bytes are another document now, or the pane went): that is its let-go.
					if (!this.unloaded) this.releasePdfId(kept.id);
				});
			}
			resolutions.push(resolved);
			// The mark is set before resolvePdfId's first await, so it is there now.
			const started = opening ? identifying.get(root) : undefined;
			if (started) openings.push(started);
			if (carries.length === 0) continue;
			// The token is taken before resolvePdfId's first await, so it is there now.
			const mine: Handed = { carries, token: this.pdfResolveTokens?.get(root) };
			handed.set(root, mine);
			inked.push({ root, mine });
		}
		// A pane that waited to move and is gone, or shows another file now: a blank it drew on before it went keeps the
		// path, as an open pane's does (pairedInkLeaves); one never drawn on leaves the ink found where it is.
		for (const [root, move] of moves ?? []) {
			if (root.isConnected && this.pdfFiles.get(root) === path) continue;
			moves?.delete(root);
			leave(move);
		}
		if (moves?.size === 0) pairMoves.get(this)?.delete(path);
		// Held through new bytes and asked again: owed an identification for them at that check, even with its pairing's
		// move met there. A pane gone, or showing another file now, owes none.
		const owedNow = new Set([...(owedChange ?? []), ...changedAgain].filter((root) => root.isConnected && this.pdfFiles.get(root) === path));
		let owedByPath = changeOwed.get(this);
		if (owedNow.size > 0) {
			if (!owedByPath) changeOwed.set(this, (owedByPath = new Map<string, Set<HTMLElement>>()));
			owedByPath.set(path, owedNow);
		} else owedByPath?.delete(path);
		if (again.size > 0) this.schedulePdfModified(path, again);
		// A pane left busy keeps its undo ring on its old ink file. Once another pane has taken that file's ink to carry,
		// a step there would write the old file behind the carry, and the busy pane's own carry adds only what the new
		// file lacks: the step is lost, or an undone erase comes back over its own pieces. Its undo and redo are refused
		// until it is identified again, with the ink as it was (holdHistory). Before the await, so a press while the carry
		// is still being made is refused too; on the carry being taken, not on it landing, so one kept back refuses too.
		if (held.size > 0 && inked.length > 0) {
			const taken = new Set(inked.flatMap(({ mine }) => mine.carries.map((c) => c.was)));
			for (const root of held) {
				const id = this.pdfIds.get(root);
				const controller = this.pdfInk.get(root);
				if (id !== undefined && controller !== undefined && taken.has(id)) holdHistory(controller, id);
			}
		}
		await Promise.all(resolutions);
		// New content means a new ink file (PdfIdentity). The ink drawn before the change is copied into it when
		// the old record was sound, so the page keeps its ink; the copy is the same stroke objects, so saved ink
		// looks exactly as it did. The old record and its file are never written. A pane busy during the change
		// is identified later, after another pane already carried the ink: its copy adds only the strokes drawn
		// since, by id (carryInk). A new file that already has ink of its own, and was not filled by a carry this
		// session (the bytes went back to a version that has its own ink file), keeps the old ink where it is,
		// as does a locked old record. Said once per file, not once per pane. No id means the resolution failed
		// and has said so already. Only into the id this check's own identification of the pane chose: a pane
		// switched to another PDF meanwhile was identified again by the switch (syncPdfControllers), under a newer
		// token, and that PDF gets no stroke, no write and no notice; the ink is carried at the changed PDF's next
		// open (carryFromOldContent). A rename keeps the pane's token, so a renamed pane is carried. A pane that
		// changed again while this check ran, and stayed, was taken over by the newer check, which carries this
		// check's ink with its own: this check leaves it.
		//
		// A carry off found ink whose leave is owed takes the kept ink's strokes and the found ink's strokes drawn since the
		// owe. Owed with the found ink not read, what it held then is known once its read settles (hadOnDisk): waited for
		// first, as the leave run waits; still unknown, every stroke it holds counts as held then, as in the leave run. The
		// kept ink not readable: its strokes stay in its file and the leave stays owed; the late strokes are carried still.
		// Nothing here drops a claim or moves a file into the trash: the found ink's leave run does, at its let-go, and reads
		// the store's answer there.
		//
		// The kept ink's strokes come from its record when one is read. With none read, a record another holds whose read
		// is out lands first; with no record, they come from its page as the store still holds it unlanded, else from its
		// file read on its own, as hadOnDisk reads one: not taken as seen, no recovery, nothing written, no notice (a load
		// would tell the user a damaged file is damaged, while the pane shows another ink). No record is taken here, so
		// nothing here lets the kept ink go: the found ink's leave run, which this check's own let-go starts, may be
		// carrying into that record and saving it, and a let-go then would forget it under the run.
		const owedCarries = inked
			.filter(({ root, mine }) => handed.get(root) === mine)
			.flatMap(({ mine }) => (mine.carries as readonly OwedCarry[]).flatMap((c) => (c.owed !== undefined ? [c.owed] : [])));
		const keptOnItsOwn = async (id: string): Promise<PageData | null> => {
			const held = this.store.latestUnlanded(id);
			if (held !== null) return { ...held, textBoxes: held.textBoxes.map((t) => ({ ...t })), images: held.images.map((i) => ({ ...i })), strokes: held.strokes.map((s) => ({ ...s })) };
			try {
				const adapter = this.app.vault.adapter;
				const final = await this.store.resolvePath(id);
				if (!(await adapter.exists(final))) return null;
				const page = parsePage(await adapter.read(final), id);
				// A newer build's file is not this build's to read: as the store refuses it, it stays in its file, as an
				// unreadable one does.
				return page.damaged || page.futureVersion !== undefined ? null : page.data;
			} catch {
				return null;
			}
		};
		const keptPages = new Map<string, PageData>();
		for (const { leave } of owedCarries) {
			const reading = hadReads.get(leave);
			if (reading !== undefined) await reading;
		}
		for (const from of new Set(owedCarries.map((o) => o.leave.from))) {
			if (!this.pdfStore.inkReady(from) && this.pdfStore.generation(from) !== null) await this.pdfStore.settle();
			if (this.pdfStore.inkReady(from)) continue;
			const page = await keptOnItsOwn(from);
			if (page !== null) keptPages.set(from, page);
		}
		if (owedCarries.length > 0 && this.unloaded) return;
		// The ink each pane's new id holds, read before any carry below is made. A flattened copy saved over its PDF
		// carries here as any other change does: its pages hold the old ink already, so that ink shows twice.
		const inkBefore = new Map<HTMLElement, { now: string; ink: boolean }>();
		for (const { root, mine } of inked) {
			if (handed.get(root) !== mine) continue;
			const now = this.pdfIds.get(root);
			if (now === undefined || this.pdfResolveTokens?.get(root) !== mine.token) continue;
			inkBefore.set(root, { now, ink: this.pdfStore.hasInk(now) });
		}
		let kept = false, carried = false;
		for (const { root, mine } of inked) {
			if (handed.get(root) !== mine) continue;
			handed.delete(root);
			const now = this.pdfIds.get(root);
			if (now === undefined || this.pdfResolveTokens?.get(root) !== mine.token) continue;
			// The carries this check or an earlier one took (handedOn): each is an OwedCarry, its rule on it.
			const carries = mine.carries as readonly OwedCarry[];
			const before = inkBefore.get(root);
			for (const c of carries) {
				const { was, strokes, from, sound, owed } = c;
				if (now === was) continue;
				const carryTarget = !(before?.now === now ? before.ink : this.pdfStore.hasInk(now)) || carriedInto.get(this)?.has(now) === true;
				if (!sound || !this.pdfStore.inkReady(now) || !carryTarget) {
					kept = true;
					continue;
				}
				if (owed === undefined) {
					carried = carryInk(this, now, strokes, from) || carried;
					continue;
				}
				const keptInk = owed.leave.from;
				if (now !== keptInk) {
					const page = keptPages.get(keptInk);
					if (this.pdfStore.inkReady(keptInk)) carried = carryInk(this, now, this.pdfStore.strokes(keptInk), this.pdfStore.carrySource(keptInk)) || carried;
					else if (page !== undefined) carried = carryInk(this, now, page.strokes.filter((s) => typeof s.page === "number"), page) || carried;
					else kept = true;
				}
				const had = new Set(owed.had ?? owed.leave.had ?? strokes.map((s) => s.id));
				carried = carryInk(this, now, strokes.filter((s) => !had.has(s.id)), from) || carried;
			}
		}
		if (carried) {
			if (!openings.some((m) => m.said === true)) new Notice(CARRIED_NOTICE);
		} else if (kept) new Notice(KEPT_NOTICE);
	}

	/**
	 * Copy the ink an older version of a PDF holds into its new ink file, adding
	 * only the strokes the new file does not have and has not been given before.
	 * The second half is the ledger: a stroke carried once and then erased in
	 * the new file stays erased when a later copy from the same old file (a
	 * pane that was busy during the change) arrives. True when anything was
	 * added. The strokes are the old record's own objects, written unchanged.
	 *
	 * `from` is the old record's parsed file: what a plain save of it writes beside its placed strokes goes with
	 * them, where the new file lacks it (PdfCarryBase). A carry that adds no placed stroke writes nothing, as
	 * before. One the store refuses (the new record's read is out) gives no stroke to the ledger, so a later carry
	 * can still make it.
	 */
	function carryInk(plugin: HandwritingPlugin, now: string, strokes: readonly InkStroke[], from: PageData | null): boolean {
		let ledger = carriedInto.get(plugin);
		if (!ledger) carriedInto.set(plugin, (ledger = new Map<string, Set<string>>()));
		let given = ledger.get(now);
		if (!given) ledger.set(now, (given = new Set()));
		const present = new Set(plugin.pdfStore.strokes(now).map((s) => s.id));
		const added = strokes.filter((s) => !present.has(s.id) && !given.has(s.id));
		if (added.length > 0 && !plugin.pdfStore.carryInto(now, added, from)) return false;
		for (const s of strokes) given.add(s.id);
		if (added.length === 0) return false;
		for (const [pane, id] of plugin.pdfIds) if (id === now) plugin.pdfInk.get(pane)?.refresh();
		return true;
	}

	/** Per plugin, a path and its old ink files whose kept notice an open already said this app session (carryFromOldContent). */
	const keptSaid = new WeakMap<HandwritingPlugin, Set<string>>();

	/**
	 * A PDF opened under a fresh ink id whose path an older version's ink file
	 * still claims: its bytes changed while no pane showed it (another program,
	 * a sync, or while Obsidian was closed), so onPdfModified had no pane to
	 * carry the ink for. The claimant is found here, among the other content
	 * families' ink files, and its ink is carried the same way. Each past change
	 * leaves its old file claiming the path, so the newest file decides, even
	 * when it holds no ink; a tie goes to the larger stroke count, then the id.
	 * The old file is loaded to read it and released, never written. `skip`:
	 * ids that are no source (an earlier opening's fresh ids). "none" when no
	 * other ink file claims the path, also for a pane that left. A deleted PDF's
	 * claim on a path another file was renamed onto in the grace is no source
	 * either: that file is another document (claimTakenByRename); nor, in its
	 * deletion's grace, is the claim of a PDF renamed off the path and deleted
	 * before its claim move landed. True when ink was
	 * carried; "kept" when the claimant's ink was not ready after one wait, once
	 * per app session for one path and one set of old ink files (keptSaid);
	 * false again after that. An old file written by a newer plugin stays
	 * locked, so without the once every open and switch back said it again.
	 * A flattened copy saved over the PDF carries as any other change does:
	 * its pages hold that ink already, so the ink shows twice.
	 *
	 * Cost: one listing of the ink folders and one stat per other PDF ink file
	 * on each fresh open; a file is read and parsed only the first time this
	 * session, or again once it changed on disk (PageStore.readPdfClaim). No
	 * other family, no stat. "unlisted" when the ink folder would not list:
	 * nothing is known, so the carry stays owed and the next open tries again.
	 */
	async function carryFromOldContent(this: HandwritingPlugin, family: string, path: string, now: string,
		current: () => boolean, skip?: readonly string[]): Promise<boolean | "kept" | "none" | "unlisted"> {
		let listed: string[];
		try {
			listed = await this.store.listIds("pdf-");
		} catch (e) {
			if (e instanceof InkFolderListingFailed) return "unlisted";
			throw e;
		}
		const others = listed.filter((id) => familyOf(id) !== family && skip?.includes(id) !== true);
		// "none": no old ink file claims the path, known whether or not the pane is still here, so nothing is owed.
		if (others.length === 0) return "none";
		const claimants: { id: string; mtime: number }[] = [];
		// Ink of the family a waiting claim move onto this file read, claiming the name the file had before that rename:
		// this file's ink, its claim not moved yet. The bytes changed since, so it is an older version's, as a claim on
		// this path is.
		const renamedOnto = movesOnto(this, path);
		// The families of PDFs renamed off this path and deleted before their claim moves landed (PdfInkStore oldNames).
		const deletedOff = new Set([...this.pdfStore.waitingOldNames().values()].flatMap((names) => names.filter((o) => o.path === path).map((o) => o.family)));
		for (const id of others) {
			const claim = await this.store.readPdfClaim(id);
			const claimsHere = (p: string) => p === path || renamedOnto.some((m) => m.oldPath === p && m.family === familyOf(id));
			if (!claim?.paths?.some(claimsHere)) continue;
			// A deleted PDF's claim on a path another file was renamed onto: that file is another document, not a new version.
			if (this.pdfStore.claimTakenByRename(id, path)) continue;
			// The claim of a PDF renamed off the path whose claim move has not landed: that PDF still lives, under its new
			// name, so this is another document, not its new version.
			if (familiesRenamedOff(this, path).includes(familyOf(id))) continue;
			// The same, the PDF deleted since, its deletion in its grace: that file is gone, not saved here again, so this
			// is another document too. The retirement takes the name off that ink.
			if (deletedOff.has(familyOf(id))) continue;
			claimants.push({ id, mtime: claim.mtime });
		}
		if (claimants.length === 0) return "none";
		if (!current()) return false;
		const newest = Math.max(...claimants.map((c) => c.mtime));
		const tied = claimants.filter((c) => c.mtime === newest).map((c) => c.id);
		const loaded: string[] = [];
		try {
			for (const id of tied) {
				await this.pdfStore.ensureLoaded(id);
				loaded.push(id);
				if (!current()) return false;
			}
			// A load another identification started may still run (ensureLoaded then returns at once): wait for it, once.
			if (!tied.every((id) => this.pdfStore.inkReady(id))) {
				await this.pdfStore.settle();
				if (!current()) return false;
			}
			// The kept notice, once per app session for this path and these old ink files.
			const keptOnce = (): false | "kept" => {
				const key = [path, ...[...tied].sort()].join("\n");
				let said = keptSaid.get(this);
				if (!said) keptSaid.set(this, (said = new Set()));
				if (said.has(key)) return false;
				said.add(key);
				return "kept";
			};
			// Still not ready after the wait (a load past settle's cap, or a locked old record): nothing is carried.
			if (!tied.every((id) => this.pdfStore.inkReady(id))) return keptOnce();
			const source = [...tied].sort((a, b) =>
				this.pdfStore.strokes(b).length - this.pdfStore.strokes(a).length || (a < b ? -1 : a > b ? 1 : 0))[0]!;
			// The ink to carry, with its old record's parsed file. A flattened copy saved over the PDF carries too: its
			// pages hold that ink already, so the ink shows twice.
			const strokes = this.pdfStore.strokes(source);
			const from = this.pdfStore.carrySource(source);
			return carryInk(this, now, strokes, from);
		} finally {
			for (const id of loaded) this.releasePdfId(id);
		}
	}

	/**
	 * The plugin's resolvePdfId: the pane marked as being identified from the
	 * call until resolvePdfId ends, however it ends. A rename while it runs
	 * leaves the pane's claim to its own claim step; a pane whose identification
	 * ended with no id has its claim moved at the rename (pdfPaneHoldsClaim).
	 * A newer identification of the pane takes the mark, and the older one's
	 * end leaves it. The file's other inks' claims on a name it left while a
	 * pane on it was being identified move once none is (besidePaneWaiting):
	 * by then each such pane's claim step has moved its own claim, so the move
	 * passes it over, and moves no claim twice.
	 */
	async function markPdfIdentification(this: HandwritingPlugin,
		leaf: WorkspaceLeaf,
		root: HTMLElement,
		controller: PdfInkController,
		carryOld = true,
		chain?: readonly string[]
	): Promise<void> {
		const file = (leaf.view as unknown as { file?: TFile }).file;
		const mark: Identifying = { opening: carryOld, chain };
		identifying.set(root, mark);
		try {
			await resolvePdfId.call(this, leaf, root, controller, carryOld, mark);
		} finally {
			if (identifying.get(root) === mark) identifying.delete(root);
			startClaimMovesBesidePane(this, file, this.pdfFiles.get(root));
		}
	}

	/**
	 * The claim moves waiting for a file's panes to be identified (besidePaneWaiting), started once none is: those of
	 * the file the identification read, and of the file at the pane's name now (the rename handler moved it there).
	 */
	function startClaimMovesBesidePane(plugin: HandwritingPlugin, file: TFile | undefined, at: string | undefined): void {
		const byFile = besidePaneWaiting.get(plugin);
		if (!byFile || plugin.unloaded) return;
		for (const [waiting, moves] of [...byFile]) {
			if (waiting !== file && waiting.path !== at) continue;
			if (paneIdentifying(plugin, waiting.path)) continue;
			byFile.delete(waiting);
			for (const { oldPath, atRename, owed } of moves) {
				runDetached(plugin.movePdfClaimsBesidePane(waiting, oldPath, atRename, owed), `move the other ink claims of ${oldPath} to ${waiting.path}`);
			}
		}
	}

	/**
	 * Work out which sidecar this PDF's ink belongs in, then show it.
	 *
	 * Content-keyed, so this reads the file rather than any metadata - see
	 * PdfIdentity for why a PDF cannot carry an id of its own. Asynchronous by
	 * nature, which is why the controller mounts first and renders nothing
	 * until this lands: a blank page for a moment is fine, ink under the wrong
	 * id is not.
	 */
	async function resolvePdfId(this: HandwritingPlugin,
		leaf: WorkspaceLeaf,
		root: HTMLElement,
		controller: PdfInkController,
		carryOld = true,
		mark?: Identifying
	): Promise<void> {
		const file = (leaf.view as unknown as { file?: TFile }).file;
		if (!file) return;
		// The path the pane opened with, read before the first await. Never a
		// guard (those read file.path fresh, below): only the claim step uses it,
		// so a rename while the file is identified moves the claim instead of
		// leaving the old name in the ink file beside the new one.
		const started = file.path;
		const token = {};
		const tokens = (this.pdfResolveTokens ??= new WeakMap<HTMLElement, object>());
		tokens.set(root, token);
		// The guard after every await. The plugin can also be unloaded across
		// one: the continuation then outlives onunload and registered a path
		// claim, an id and a repaint for a plugin that is gone. Claims are
		// session memory, so stopping is enough; nothing needs releasing.
		const current = () => !this.unloaded && root.isConnected && this.pdfFiles.get(root) === file.path && tokens.get(root) === token;
		// `file.path` is read fresh at every step, never kept: a rename during
		// identification moves the same TFile, and the rename handler moves
		// pdfFiles with it, so the live path still matches the pane. A copy of
		// the old path stopped matching at the next guard and the pane was left
		// with no id until the PDF was reopened.
		// The head and the file's length, which is all the id is made of.
		// This used to be `readBinary(file)` - the whole document, so a
		// 200 MB scan was read into memory on every open to hash its first
		// 64 KiB. PdfHead reads just that much where the platform allows it
		// and falls back to the whole read everywhere else.
		const { head, byteLength } = await readPdfHead(this.pdfHeadSource(file));
		// Several awaits, and the pane can change document across any of
		// them. Checking only `isConnected` catches a closed view but not a
		// switched one: two resolutions racing in the same pane could finish
		// out of order and stamp the earlier document's id onto the later
		// one - so the guard repeats after every await.
		if (!current()) return;
		const family = await pdfInkIdFromHead(head, byteLength, window.crypto);
		if (!current()) return;
		// Which INSTANCE of the content family this file is. Byte-identical
		// copies are one family, but each vault file is its own instance -
		// launch day proved why: a re-export of an unchanged OneNote page
		// arrived already wearing the original's ink (2026-09-01). The
		// sidecars' own path claims decide; see PdfIdentity.chooseInstance.
		// Read without taking the sidecar as seen: a record still held for this
		// id must not have its write baseline moved to a revision it never
		// loaded (PageStore.readPdfPaths).
		const candidates: InstanceClaim[] = [];
		// The ink folder would not list: the family's ids are looked up by name, in every folder a page can be served
		// from: its own name, then its second, third and on, up to the first of those with no file; and the inks of a
		// leave owed off this path (owedInksAt): the kept ink is taken first, as when the folder lists, and past a gap it
		// is found no other way. What that rules out is checked once the choice is made, below. Cost, only on such an
		// open: one lookup per id of that run and one past it, one per owed ink not in it, and the hashes below.
		let unlisted: InkFolderListingFailed | undefined;
		let familyOnDisk = false;
		let listed: string[];
		try {
			listed = await this.store.listIds(family);
		} catch (e) {
			if (!(e instanceof InkFolderListingFailed)) throw e;
			unlisted = e;
			listed = [];
			for (let n = 1; ; n++) {
				const id = n === 1 ? family : `${family}-${n}`;
				const there = (await this.store.findSidecar(id)).found;
				if (!current()) return;
				if (there) listed.push(id);
				else if (n > 1) break;
			}
			for (const id of new Set(owedInksAt(this, file.path, family))) {
				if (listed.includes(id)) continue;
				const there = (await this.store.findSidecar(id)).found;
				if (!current()) return;
				if (there) listed.push(id);
			}
			familyOnDisk = listed.includes(family);
		}
		for (const cid of listed.filter((i) => familyOf(i) === family)) {
			const paths = (await this.store.readPdfPaths(cid));
			// Found ink moving to the trash now, its leave run (releasePdfId), or moved there by one in this session: gone
			// between the list and the read.
			if (paths === null && (this.pdfLeaving?.(cid) === true || this.pdfLeftForTrash?.(cid) === true)) continue;
			// An unreadable claim is not a legacy claimless sidecar. Choosing
			// an instance from a partial list can give another file this ink.
			if (paths === null) throw new Error(`could not read PDF ink claims for ${cid}`);
			candidates.push({ id: cid, paths });
		}
		// Unlisted, ink found by name that claims no file in the vault, or no path at all, may be adopted below: the ink of
		// a file renamed or moved while Obsidian was closed, or written before claims were kept. Any copy of the same bytes
		// would find it the same way, so whether the vault holds one (copyInVault) is read here, before the choice, which
		// stays in one synchronous run with its reservation. Not read when found ink claims this file.
		let copyHere: boolean | undefined;
		if (unlisted && !candidates.some((c) => c.paths.includes(file.path) || c.paths.some((p) => renamedFromWaiting(this, p, file.path)))
			&& candidates.some((c) => c.paths.every((p) => this.app.vault.getFileByPath(p) === null))) {
			copyHere = await copyInVault(this, file, family, byteLength);
			if (!current()) return;
		}
		// A file at a name a deletion in its grace takes off ink of this family (waitingOldNames) is read as the retirement
		// reads it: another document there (a family not this one) is no file of this ink, and frees the name for this
		// open, below. A file that cannot be read decides nothing. Only in such a grace, one read per name.
		const otherAtOld = new Set<string>();
		const readAtOld = new Set<string>();
		for (const names of this.pdfStore.waitingOldNames().values()) {
			for (const old of names) {
				if (old.family !== family || readAtOld.has(old.path) || this.app.vault.getFileByPath(old.path) === null) continue;
				readAtOld.add(old.path);
				let there: string | null | undefined;
				try { there = await this.pdfDeleteContext().familyForPath(old.path); }
				catch { there = undefined; }
				if (!current()) return;
				if (typeof there === "string" && there !== family) otherAtOld.add(old.path);
			}
		}
		// Such a name has no file for this ink: it does not exist for the choice, and waits in oldNames as a free name does.
		const freedOld = new Set<string>();
		// And the instances this session already handed out, whose claim may
		// not be on disk yet: an un-inked original has no sidecar, and without
		// its claim here a byte-identical copy was given the same id.
		for (const held of this.pdfStore.claimedInstances((i) => familyOf(i) === family)) {
			const known = candidates.find((c) => c.id === held.id);
			if (known) known.paths = [...new Set([...known.paths, ...held.paths])];
			else candidates.push(held);
		}
		// And the choices other panes have made but not claimed yet, because
		// their sidecar is still loading. Two copies of one template opened
		// together (a restored workspace, two quick tabs) otherwise both chose
		// the first free instance and shared one sidecar.
		const resolving = (this.pdfResolving ??= new Map<HTMLElement, { id: string; path: string }>());
		for (const [other, inFlight] of resolving) {
			if (other === root || familyOf(inFlight.id) !== family) continue;
			// The pane's path NOW, not when it chose: a rename during its load
			// moves pdfFiles, and a new file at the old name must not be handed
			// the renamed file's choice.
			const path = this.pdfFiles.get(other) ?? inFlight.path;
			const known = candidates.find((c) => c.id === inFlight.id);
			if (known) known.paths = [...new Set([...known.paths, path])];
			else candidates.push({ id: inFlight.id, paths: [path] });
		}
		if (!current()) return;
		// An open inside a deletion's grace that pairs by name (two or more inks of
		// this family waiting, or one already paired) names the ink the retirement
		// would. It needs the vault's paths, every ink file's claims as the
		// retirement counts them, and the family of every path offered to a waiting
		// claim. Read here, so the choice itself stays synchronous. Any other open,
		// and every open with no deletion in its grace, lists no paths and reads
		// nothing.
		// A name a file of this family was renamed off counts as taken while its claim move waits and that file stands
		// elsewhere: ink claiming it is that file's (familiesRenamedOff), never a copy's to adopt. Not for the renamed
		// file's own open, whose ink it is (renamedFromWaiting).
		const exists = (p: string) =>
			(this.app.vault.getFileByPath(p) !== null && !freedOld.has(p)) ||
			(familiesRenamedOff(this, p).includes(family) && !renamedFromWaiting(this, p, file.path));
		// An ink file another pane is opening now still counts its waiting claims, as the retirement counts them.
		let fresh: FreshPaths | undefined;
		const waitingNow = this.pdfStore.waitingDeletions();
		if (waitingNow.size > 0 && mayPairOnOpen(family, candidates, waitingNow)) {
			const deleteContext = this.pdfDeleteContext();
			const paths = deleteContext.listPdfPaths();
			const read = await this.pdfStore.inkClaims(this.store);
			if (!current()) return;
			const toRead = familiesToReadForOpen(
				family,
				file.path,
				candidates,
				this.pdfStore.waitingDeletions(),
				paths,
				withClaims(read, candidates)
			);
			const families = new Map<string, string | null>();
			for (const q of toRead) {
				// A path that cannot be read is left out: it decides nothing here, as at the retirement.
				try { families.set(q, await deleteContext.familyForPath(q)); }
				catch { families.delete(q); }
			}
			if (!current()) return;
			// Those reads await, and another pane of this family can choose meanwhile.
			// Its choice and the session's claims are taken in again, as above, or two
			// files given a blank instance each were given the same one.
			for (const late of this.pdfStore.claimedInstances((i) => familyOf(i) === family)) {
				const known = candidates.find((c) => c.id === late.id);
				if (known) known.paths = [...new Set([...known.paths, ...late.paths])];
				else candidates.push(late);
			}
			for (const [other, lateChoice] of resolving) {
				if (other === root || familyOf(lateChoice.id) !== family) continue;
				const path = this.pdfFiles.get(other) ?? lateChoice.path;
				const known = candidates.find((c) => c.id === lateChoice.id);
				if (known) known.paths = [...new Set([...known.paths, path])];
				else candidates.push({ id: lateChoice.id, paths: [path] });
			}
			fresh = { paths, families, claims: withClaims(read, candidates) };
		}
		// Unlisted: ink that claims a name this file had before a rename made in this session with no pane, whose claim move
		// waits for the listing, is this file's (renamedFromWaiting). It counts as claiming this path for the choice, and is
		// taken first, below, ahead of any other ink that claims this path, but for the order an owed leave sets after it.
		// Obsidian renames only onto a free name, so other ink claiming it at this open is a gone file's: a copy's deleted
		// while Obsidian was closed, or a blank handed out for the name before the vault was listed (a deletion still in its
		// grace that holds the name is paired by its claims, which refuses while the listing fails). Left to the choice,
		// stale ink of the same bytes listed first (that copy's, or ink that claims no path) was used or adopted instead.
		const renamedHere = unlisted ? candidates.filter((c) => c.paths.some((p) => renamedFromWaiting(this, p, file.path))) : [];
		for (const c of renamedHere) if (!c.paths.includes(file.path)) c.paths = [...c.paths, file.path];
		if (renamedHere.length > 0) {
			const others = candidates.filter((c) => !renamedHere.includes(c));
			candidates.splice(0, candidates.length, ...renamedHere, ...others);
		}
		// While ink found for this path waits to leave it, the ink that keeps the path is taken first, after the above: the
		// leave follows a rename, and its found ink and kept ink can both claim the name the file had.
		this.pdfOwedFirst?.(file.path, root, family, candidates);
		// A deletion in its grace also takes, off ink of this family, a name the deleted file had before a rename whose
		// claim move had not landed (PdfInkStore oldNames). With no file there, that name waits for this open as the
		// deleted path does: a file that stood at the delete is never a new name for the ink, and one made in the grace
		// may be (adoptsPending). Only adoption reads it: ink that claims the deleted path too has one waiting claim, not
		// two, as the retirement counts it, so the open pairs by name only where the retirement does. Another document
		// there, as read above, waits as no file does (freedOld), and the claim below takes the name off the ink with it.
		const waiting = this.pdfStore.waitingDeletions();
		const oldNames = new Map<string, WaitingDeletion>();
		for (const [deleted, names] of this.pdfStore.waitingOldNames()) {
			const w = waiting.get(deleted);
			if (!w) continue;
			for (const old of names) {
				if (old.family !== family || waiting.has(old.path)) continue;
				if (otherAtOld.has(old.path)) freedOld.add(old.path);
				if (this.app.vault.getFileByPath(old.path) === null || freedOld.has(old.path)) oldNames.set(old.path, w);
			}
		}
		const choice = chooseInstance(family, file.path, candidates, exists, waiting, fresh, oldNames);
		// Unlisted, a choice stands only where no other copy's ink can be in play: ink that claims this path (with the ink
		// that claims a name this file had before such a rename, counted above as claiming it and taken first), or the
		// family's own name with no file there and nothing in this session holding it, or ink adopted because no file in the
		// vault has its claims (or it has none) while no other PDF in the vault is this document: no other file could be
		// its. Any other id may be a live ink file the listing did not show, or another copy's, so the open is refused with
		// the listing's error (the shipped notice), before anything is claimed, and reopening retries. As in 1.5.1, this
		// PDF's own ink past a gap in the run looked up is not found: the family's name opened blank can hide it, and so can
		// the ink of a copy of the same bytes deleted while Obsidian was closed, which claims only that copy's name and is
		// adopted. A stroke on the blank then makes a second claimant, and once the listing works the first listed is shown.
		if (unlisted) {
			const chosen = candidates.find((c) => c.id === choice.id);
			const own = chosen !== undefined && chosen.paths.includes(file.path);
			const blankOnFamily = choice.id === family && !familyOnDisk && chosen === undefined;
			const unclaimed = chosen !== undefined && choice.action === "adopt" && chosen.paths.every((p) => !exists(p) && !waiting.has(p) && !oldNames.has(p));
			if (!own && !blankOnFamily && !(unclaimed && copyHere === false)) throw unlisted;
		}
		// Paired by name: every deletion it paired over stays paired, at once, before this open's rename ends any of them.
		if (choice.action !== "use" && choice.pairedOver) this.pdfStore.markPaired(choice.pairedOver);
		this.pdfStore.noteArrived(file.path, choice.id);
		// Opened blank by the pairing: those inks keep counting this file, at once, before any retirement can run.
		if (choice.action === "fresh" && choice.heldFor) this.pdfStore.holdTiedPath(file.path, choice.heldFor);
		// The fresh id, or an earlier opening's fresh id chosen again (resumed), is this identification's to carry into.
		// An opening's fresh id stays owed the old version's ink until a carry into it runs to its end (pdfCarryOwed):
		// a pane that left before then and comes back, or a second pane on the path, uses the id and carries.
		const resumed = mark?.chain?.includes(choice.id) === true || (carryOld && this.pdfCarryOwed?.has(choice.id) === true);
		const freshHere = choice.action === "fresh" || resumed;
		if (mark && freshHere) mark.fresh = choice.id;
		this.pdfIds.set(root, choice.id);
		// Kept past the pane: a save that fails or a conflict copy can be reported after the pane
		// closed and its own id and path maps were dropped, and the notice must still name the file.
		(this.pdfPathById ??= new Map()).set(choice.id, file.path);
		// Owed from the choice, in the same synchronous run as the reservation below: a pane that takes this id from the
		// reservation while its record loads finds it owed. This opening's promise (pdfOpeningCarry) settles when it
		// ends, however it ends; a later opening on the id waits on it before its own carry.
		if (carryOld && choice.action === "fresh") (this.pdfCarryOwed ??= new Set()).add(choice.id);
		let ended: () => void = () => {};
		const opening = new Promise<void>((done) => (ended = done));
		const carries = (this.pdfOpeningCarry ??= new Map<string, Promise<void>>());
		if (carryOld && freshHere && !carries.has(choice.id)) carries.set(choice.id, opening);
		try {
			// Held only across the load: every return before this point comes
			// before the reservation, and the guard after it comes after the
			// release, so no path out of here leaves a choice reserved.
			const mine = { id: choice.id, path: file.path };
			resolving.set(root, mine);
			try {
				await this.pdfStore.ensureLoaded(choice.id);
			} finally {
				if (resolving.get(root) === mine) resolving.delete(root);
			}
			// The fourth await, and the guard the first three already carry: the
			// pane can change document across this one too, and what follows is
			// the durable half - claimPath writes this path into that sidecar, and
			// the refresh paints its ink. Without the re-check a resolution that
			// lost the race stamped the earlier document's path onto the later
			// document's sidecar. The id set above is deliberately before the
			// await - the controller must be able to ask for it the moment the
			// choice is made - and a stale one is corrected by the next sync,
			// which is what clears pdfIds when the pane's file changes.
			if (!current()) return;
			// Always claimed: an adoption becomes durable at once, a fresh
			// instance merely remembers until its first stroke, and a repeat
			// claim is a no-op. Renamed since the pane opened: the handler had no id
			// to move, or the ink file's load merged the old name back, so the claim
			// moves here.
			if (file.path !== started) {
				// A late move, as at the other late moves: a deletion waiting at the old name now that was not waiting there
				// when the rename off it was heard is a later file's, and goes on to its grace (renamePath's missed road).
				// When the handler moved this id off the old name, it did what the rename owed the deletion there (an id
				// that came with the file taken off it, or the deletion ended), so the repeat ends none.
				const renamed = mark?.renamed?.from === started ? mark.renamed : undefined;
				const now = this.pdfStore.deletionAt(started);
				const missed = renamed !== undefined && (renamed.moved.has(choice.id) || (now !== undefined && now !== renamed.deletion));
				this.pdfStore.renamePath(choice.id, started, file.path, missed);
			} else {
				// Ink that keeps a deleted path for an owed leave, adopted here: each found ink of those leaves is read in
				// first, so its claim follows (claimPath), and let go after, so the leave runs on this path. Left on the
				// deleted path, a found ink claimed a name no file has, and a later copy of these bytes opened on it.
				const followers = choice.action === "adopt" ? foundLeavingWith(this, choice.id) : [];
				for (const f of followers) await this.pdfStore.ensureLoaded(f);
				const letGo = (): void => {
					for (const f of followers) if (!showsInk(this, f)) this.releasePdfId(f);
				};
				if (!current()) return letGo();
				this.pdfStore.claimPath(choice.id, file.path, freedOld);
				letGo();
			}
			// Ink found for the path: a pane there still on a blank opened before the list was full moves to it. No such
			// blank this session, no pane to look for.
			if (this.pdfStore.hasEarlyBlanks() && !this.pdfStore.isEarlyBlank(choice.id)) this.moveBlankPanes(file.path, choice.id);
			// onPdfModified carries for the panes it identifies again; this is the open of a file that changed
			// while no pane showed it.
			// A resumed id may hold a stroke drawn while the earlier opening's carry waited; the carry still goes in beside it
			// (carryInk adds only what it lacks), and that id is no source of the old ink. Not carried: the kept notice.
			// Another opening carries into this id: wait for it to end. It awaited the old ink file's whole load, so this
			// one never ends kept at the capped wait while that load runs. Then carry only if the id is still owed (that
			// opening was cut off); if it carried, kept, or found nothing, nothing more is carried or said.
			if (carryOld && freshHere) {
				for (let other = carries.get(choice.id); other !== undefined && other !== opening; other = carries.get(choice.id)) {
					await other;
					if (!current()) return;
				}
				if (!carries.has(choice.id)) carries.set(choice.id, opening);
			}
			const owed = mark?.chain?.includes(choice.id) === true || this.pdfCarryOwed?.has(choice.id) === true;
			if (carryOld && freshHere && owed && this.pdfStore.inkReady(choice.id) && (resumed || !this.pdfStore.hasInk(choice.id))) {
				const carried = await this.carryFromOldContent(family, file.path, choice.id, current, mark?.chain);
				// Synchronous after the carry, before this opening's promise settles: a waiter reads owed after this.
				// Unlisted, nothing was learned: still owed, the next open carries.
				if (carried === true || carried === "none" || (current() && carried !== "unlisted")) this.pdfCarryOwed?.delete(choice.id);
				if (carried === true) {
					new Notice(CARRIED_NOTICE);
					if (mark) mark.said = true;
				} else if (carried === "kept") new Notice(KEPT_NOTICE);
				if (!current()) return;
			}
			controller.refresh();
			// canPasteInk flips the moment documentId() stops being null, but
			// nothing repaints the strip for it: refresh() above only repaints
			// ink, and the only other PDF-wide refresh is the addStripSurface
			// fan-out on setting changes (§5f). Without this the paste button
			// worked as soon as identification finished but went on looking
			// dimmed until something unrelated redrew the strip (1.4.6-design.md
			// 5m/AF2).
			controller.refreshStrip();
		} finally {
			ended();
			if (carries.get(choice.id) === opening) carries.delete(choice.id);
		}
	}

	/**
	 * Where this PDF's head can be read from, cheapest route first.
	 *
	 * `whole` is the vault read that has always worked and always will. The
	 * ranged route is offered only on desktop, where Obsidian is Electron and
	 * node `fs` exists, and only when the vault is on a real filesystem the
	 * adapter can name - a `FileSystemAdapter`. Anything else (mobile, a
	 * sandboxed build with no `require`, an adapter that keeps files
	 * somewhere that is not a path) leaves `openRanged` undefined and the
	 * read behaves exactly as it did in 1.4.5.
	 *
	 * Detected by the presence of `getFullPath` rather than `instanceof
	 * FileSystemAdapter`: `test/obsidian-stub.ts` does not export that class
	 * (nothing in the plugin needed it before), and an `instanceof` against
	 * an undefined import throws at runtime, which would break every test
	 * that loads this module rather than fail some check. Duck-typing also
	 * happens to be the honest test here - what is needed is an absolute
	 * path, not a class.
	 */
	function pdfHeadSource(this: HandwritingPlugin, file: TFile): HeadSource {
		const whole = () => this.app.vault.readBinary(file);
		if (!Platform.isDesktopApp) return { whole };
		const adapter = this.app.vault.adapter as unknown as {
			getFullPath?: (path: string) => string;
		};
		if (typeof adapter.getFullPath !== "function") return { whole };
		const full = adapter.getFullPath(file.path);
		if (typeof full !== "string" || full.length === 0) return { whole };
		return { openRanged: () => openRangedFile(full), whole };
	}

	/**
	 * A PDF renamed while no pane shows it: the sidecar claiming the old name
	 * now claims the new one. Left on the old name, the claim outlived the
	 * file: a file saved there later opened wearing this ink, and erasing on
	 * either erased both. Identification's own adoption keeps every claim, as
	 * it must - a claimed path can be missing only because that file has not
	 * synced here yet - so the move happens here, where the rename is known.
	 * Found by content, the way identification finds it. A rename made while
	 * Obsidian was closed, or by another program, sends no event and is not
	 * covered.
	 *
	 * The ink folder would not list: the move is tried again later, each wait
	 * twice the last up to a ceiling, while the plugin is loaded. Moving only
	 * what a lookup by name finds would miss the ink of any copy past the
	 * family's first, and nothing would try again. The file's path is read at
	 * each try, so a later rename is followed; a relaunch before the listing
	 * works leaves the claim on the old name, as before. Until the move lands,
	 * an open of the file while the listing fails takes ink found by name that
	 * claims the old name as its own (claimMovesWaiting, resolvePdfId).
	 */
	async function movePdfClaimOnRename(this: HandwritingPlugin, file: TFile, oldPath: string): Promise<void> {
		let waiting = claimMovesWaiting.get(this);
		if (!waiting) claimMovesWaiting.set(this, (waiting = new Set()));
		const atRename = this.pdfStore.deletionAt(oldPath);
		const move: ClaimMove = { file, oldPath, ...(atRename ? { deletionAtRename: atRename } : {}) };
		waiting.add(move);
		return moveClaimTrying(this, move, 0);
	}

	/**
	 * A PDF renamed while a pane holds its claim. The rename handler moves the
	 * claims of the panes' ids, an identification still running moves its own at
	 * its claim step, and moveOwedClaims those of the leaves' inks. Every other
	 * ink of the file's bytes that claims the old name moves here, as
	 * movePdfClaimOnRename moves it for a PDF no pane holds: left there, a PDF
	 * made at the old name later opened wearing that ink, carried over as an
	 * older version's. An ink of other bytes, and an older
	 * version's ink file, keep the name, as with no pane.
	 *
	 * While a pane on the file is being identified, the move waits until none is
	 * (besidePaneWaiting, markPdfIdentification): its choice is not known before,
	 * and a move made then took the ink it then chose off the name before its own
	 * claim step, which moved it again. An ink whose first read is already running
	 * is waited out (readied): with no claims in memory yet, it was passed over.
	 * The deleted file's claim a deletion holds stays for its retirement, and a
	 * later file's deletion at the old name goes on to its grace, as with no pane.
	 * A try that lands once the deletion waiting at the old name at the rename
	 * has ended moves nothing more: the claims that deletion held were settled
	 * by its retirement, and are not known after it. The file's other inks then
	 * keep the old name, as with a pane before this move.
	 *
	 * Cost: none beyond movePdfClaimOnRename's for a closed PDF: one head read,
	 * one listing, one claim read per ink of the bytes not in memory, and a load
	 * only of an ink that still claims the old name.
	 */
	async function movePdfClaimsBesidePane(
		this: HandwritingPlugin,
		file: TFile,
		oldPath: string,
		atRename: object | undefined,
		owed: ReadonlySet<string> = owedLeaveInksOff(this, file.path)
	): Promise<void> {
		if (paneIdentifying(this, file.path)) {
			let byFile = besidePaneWaiting.get(this);
			if (!byFile) besidePaneWaiting.set(this, (byFile = new Map<TFile, { oldPath: string; atRename: object | undefined; owed: ReadonlySet<string> }[]>()));
			const moves = byFile.get(file) ?? [];
			// A later rename while the same identification runs leaves no ink of the file on the name between.
			if (!moves.some((m) => m.oldPath === oldPath)) moves.push({ oldPath, atRename, owed });
			byFile.set(file, moves);
			return;
		}
		const move: ClaimMove = { file, oldPath, besidePane: owed, ...(atRename ? { deletionAtRename: atRename } : {}) };
		return moveClaimTrying(this, move, 0);
	}

	/**
	 * The rename handler's start of movePdfClaimsBesidePane, in the background, as its other steps are the plugin's
	 * own calls. Called only while a pane holds the claim of the file at its new name (pdfPaneHoldsClaim).
	 */
	function pdfRenamedWithPane(this: HandwritingPlugin, file: TFile, oldPath: string, atRename: object | undefined): void {
		runDetached(this.movePdfClaimsBesidePane(file, oldPath, atRename), `move the other ink claims of ${oldPath} to ${file.path}`);
	}

	const RENAME_RETRY_FIRST_MS = 10_000;
	const RENAME_RETRY_MOST_MS = 5 * 60_000;

	async function moveClaimTrying(plugin: HandwritingPlugin, move: ClaimMove, waited: number): Promise<void> {
		try {
			await moveClaimOnce.call(plugin, move);
		} catch (e) {
			if (!(e instanceof InkFolderListingFailed) || plugin.unloaded) {
				claimMovesWaiting.get(plugin)?.delete(move);
				throw e;
			}
			const wait = Math.min(waited > 0 ? waited * 2 : RENAME_RETRY_FIRST_MS, RENAME_RETRY_MOST_MS);
			window.setTimeout(() => {
				if (!plugin.unloaded) runDetached(moveClaimTrying(plugin, move, wait), "move a PDF ink claim on rename");
			}, wait);
			return;
		}
		claimMovesWaiting.get(plugin)?.delete(move);
	}

	async function moveClaimOnce(this: HandwritingPlugin, move: ClaimMove): Promise<void> {
		const { file, oldPath } = move;
		// The plugin can be unloaded across any await below. The continuation
		// then outlived onunload: it moved a claim and released a record for a
		// plugin that is gone. Claims are session memory, so stopping is enough.
		// The head is read at every try: a file gone since drops the move.
		const { head, byteLength } = await readPdfHead(this.pdfHeadSource(file));
		if (this.unloaded) return;
		// The family the first read hashed is kept, before the listing, which can fail: a delete of the file while the move
		// waits reads it (pdfDeleteContext), and every later try looks in it. The bytes can change while the move waits (a
		// new version saved in place): the ink that claims the old name is of the bytes the file had at the rename.
		const family = move.family ?? (await pdfInkIdFromHead(head, byteLength, window.crypto));
		if (this.unloaded) return;
		move.family = family;
		const heldPaths = (id: string) => this.pdfStore.claimedInstances((i) => i === id)[0]?.paths;
		const ids = new Set((await this.store.listIds(family)).filter((i) => familyOf(i) === family));
		if (this.unloaded) return;
		for (const held of this.pdfStore.claimedInstances((i) => familyOf(i) === family)) ids.add(held.id);
		// Loaded here for a PDF no pane may show. Kept, the record stood in for
		// the sidecar at the next open, and ink another device added meanwhile
		// was missing. Released once what it holds is on disk; releasePdfId
		// keeps it while a pane shows it. Released only once every claim on the
		// old name has moved: a release can run an owed leave off the new name
		// (pairedInkLeaves), and that run reads the claims of the ink that keeps
		// it. Released before that ink's claim moved, the run found the new name
		// unclaimed by it and forgot the leave.
		const loaded: string[] = [];
		// A deletion waiting at the old name now that was not there at the rename is a later file's: the move passes
		// over it (renamePath's missed road), and it goes on to its grace, as at the retirement.
		const later = (): boolean => {
			const now = this.pdfStore.deletionAt(oldPath);
			return now !== undefined && now !== move.deletionAtRename;
		};
		// Beside a pane (movePdfClaimsBesidePane): the owed leaves' inks are moveOwedClaims' to move.
		const passOver = move.besidePane;
		try {
			for (const id of ids) {
				if (passOver?.has(id)) continue;
				const claimed = heldPaths(id) ?? (await this.store.readPdfPaths(id));
				if (this.unloaded) return;
				if (!claimed?.includes(oldPath)) continue;
				// Beside a pane, once the deletion that waited at the old name at the rename has ended (a listing that failed
				// and was tried again past its grace, an identification that outlasted it), nothing more moves: its
				// retirement settled the claims it held there, and which those were is not known after it.
				if (passOver !== undefined && move.deletionAtRename !== undefined && this.pdfStore.deletionAt(oldPath) !== move.deletionAtRename) return;
				// The deleted file's claim on a path another file was renamed onto stays for its retirement.
				if (this.pdfStore.claimHeldByDeletion(id, oldPath, file.path)) continue;
				loaded.push(id);
				// Beside a pane, a read of the ink already running (another pane's open, a leave's run) is waited out.
				if (passOver !== undefined) {
					if (!(await readied(this, id))) continue;
				} else await this.pdfStore.ensureLoaded(id);
				// Loaded, the record's own claims are the ones to trust.
				if (!this.unloaded && heldPaths(id)?.includes(oldPath)) this.pdfStore.renamePath(id, oldPath, file.path, later());
			}
		} finally {
			if (!this.unloaded) for (const id of loaded) this.releasePdfId(id);
		}
	}

	/**
	 * The ink id of an open PDF, or null while it is still being hashed.
	 *
	 * By path rather than by pane, because the command acts on the active
	 * FILE. The same document open in two panes resolves to the same id, so
	 * which one answers does not matter.
	 *
	 * Also null while an opening on the path that chose a fresh id has not
	 * ended: its id is set before it carries an older version's ink in, so
	 * until then that id may lack the ink the user sees coming, and Flatten
	 * or Delete all would act on it as if it had none. The mark goes in
	 * markPdfIdentification's finally, so every way the opening ends lifts
	 * this.
	 */
	function pdfIdForPath(this: HandwritingPlugin, path: string): string | null {
		for (const [root, at] of this.pdfFiles) {
			const mark = at === path ? identifying.get(root) : undefined;
			if (mark?.opening === true && mark.fresh !== undefined) return null;
		}
		for (const [root, at] of this.pdfFiles) {
			if (at === path) return this.pdfIds.get(root) ?? null;
		}
		return null;
	}

	function notePdfPaneRenamed(this: HandwritingPlugin, root: HTMLElement, oldPath: string, deletion: object | undefined, moved: string | undefined): void {
		const mark = identifying.get(root);
		if (!mark) return;
		// The first rename heard is the one off the name the identification started on (its claim step checks). A later
		// rename's deletion is another name's, and the handler's move off another name is not the move off that one.
		const renamed = (mark.renamed ??= { from: oldPath, deletion, moved: new Set() });
		if (moved !== undefined && renamed.from === oldPath) renamed.moved.add(moved);
	}

	/**
	 * Does a pane on `path` hold the PDF's claim: an id, or an identification
	 * still running (resolvePdfId), which moves its own claim at a rename?
	 * False when no pane shows the path, and when the panes that do failed to
	 * identify it: a rename then moves the claim as for a closed PDF
	 * (movePdfClaimOnRename). True: the panes move their own claims, and
	 * movePdfClaimsBesidePane every other. Reads only.
	 */
	function pdfPaneHoldsClaim(this: HandwritingPlugin, path: string): boolean {
		for (const [root, at] of this.pdfFiles) {
			if (at === path && (this.pdfIds.has(root) || identifying.has(root))) return true;
		}
		return false;
	}

	/** Is a pane on `path` being identified now (resolvePdfId still running)? Reads only. */
	function paneIdentifying(plugin: HandwritingPlugin, path: string): boolean {
		for (const [root, at] of plugin.pdfFiles) {
			if (at === path && identifying.has(root)) return true;
		}
		return false;
	}

	/**
	 * The whole of a PDF's ink as one comparable value, or null if it cannot
	 * be taken.
	 *
	 * Text, not a copy of the objects, because both mutation shapes defeat a
	 * copy: `commit` pushes into the live array in place, and
	 * `replaceAllLive` swaps the array for another. A reference compares
	 * equal to itself after the first, and a shallow copy shares the stroke
	 * objects with both. Serializing captures every point's coordinates,
	 * pressure and time along with style, page and anything else a stroke
	 * carries - which is the point, since the change this guards against can
	 * be one interior coordinate that the on-disk rounding would hide.
	 *
	 * Nothing here touches the live objects: no freeze, no sort, no mutation.
	 *
	 * Null when the ink cannot be serialized at all, and the caller then
	 * refuses the clear. "Cannot compare" must not read as "did not change" -
	 * that is the direction that loses ink.
	 */
	function pdfInkSnapshot(this: HandwritingPlugin, id: string): string | null {
		try {
			return JSON.stringify(this.pdfStore.strokes(id));
		} catch (err) {
			console.error("[handwriting] delete-all-pdf-ink could not read current ink", err);
			return null;
		}
	}

	/**
	 * The other inks a whole-PDF clear of `path` from a pane on ink `id` must reach while ink found for the path owes its
	 * leave of it (pairedInkLeaves), each with the strokes it keeps. The kept ink of each such leave goes whole: the next
	 * open of the path takes it first (pdfOwedFirst). The found ink keeps the strokes it held when the leave was owed
	 * (`had`): its run takes those as held and carries the others into the kept ink, so the others go. With `had` unset
	 * the run takes every stroke the found ink holds as held and carries none, so it is not reached.
	 *
	 * Found from the leave records, not from the claims on the path: a kept ink still on a name the leave was owed under
	 * before (wasName) is found all the same. Never `id`; each ink once (whole over kept, and kept only the strokes every
	 * leave keeps); in leave order.
	 *
	 * A leave owed off another name, with `id` one of its two inks: its run may move it to `path` first (a rename made
	 * where the leave is not held, a delete and a create moving it back), and then carry into the kept ink what the clear
	 * left on the found ink. The other ink is reached, as above, when that run, asked now from both inks' claims
	 * (leaveRunMovesTo), moves the leave to `path`. Not when it is not sure, or runs anywhere else. With the other ink's
	 * claims not read, it cannot be asked yet: that ink comes after the others with `reachedIf`, the same question put to
	 * its claims once they are read. Read only: nothing is read from disk, loaded, saved or written.
	 */
	function pdfInkOwedWith(
		this: HandwritingPlugin,
		path: string,
		id: string
	): { id: string; keep: string[] | null; reachedIf?: (claims: readonly string[]) => boolean }[] {
		const out = new Map<string, string[] | null>();
		const reach = (ink: string, keep: readonly string[] | null): void => {
			if (ink === id) return;
			const was = out.get(ink);
			if (!out.has(ink)) out.set(ink, keep === null ? null : [...keep]);
			else if (was !== null && was !== undefined) out.set(ink, keep === null ? null : was.filter((s) => keep.includes(s)));
		};
		// An ink's claims, when its record is read; else not known.
		const claimsOf = (ink: string): readonly string[] | undefined =>
			this.pdfStore.inkReady(ink) ? (this.pdfStore.claimedInstances((i) => i === ink)[0]?.paths ?? []) : undefined;
		const unread: { id: string; keep: string[] | null; reachedIf: (claims: readonly string[]) => boolean }[] = [];
		for (const [found, list] of leaveWhenLetGo.get(this) ?? []) {
			for (const o of list) {
				if (o.path === path) {
					reach(o.from, null);
					if (o.had !== undefined) reach(found, o.had);
					continue;
				}
				if (id !== found && id !== o.from) continue;
				const other = id === found ? o.from : found;
				// The kept ink goes whole; the found ink keeps what it held at the owe, and with that not known its run
				// carries nothing, so it is not reached.
				const keep = other === o.from ? null : o.had;
				if (keep === undefined) continue;
				const mine = claimsOf(id);
				if (mine === undefined) continue;
				// Asked when called, not now: a leave moved to `path` since (o.path is the record's) is reached as above.
				const at = (theirs: readonly string[]): boolean => {
					const to = leaveRunMovesTo(this, found, o, id === o.from ? mine : theirs, id === o.from ? theirs : mine);
					return o.path === path || to === path;
				};
				const theirs = claimsOf(other);
				if (theirs === undefined) unread.push({ id: other, keep: keep === null ? null : [...keep], reachedIf: at });
				else if (at(theirs)) reach(other, keep);
			}
		}
		return [...[...out].map(([ink, keep]) => ({ id: ink, keep })), ...unread];
	}

	/**
	 * The controller holding a selection ON THIS FILE, or null.
	 *
	 * Scoped to the file's own panes, where the first version scanned every
	 * open view and returned the first selection anywhere: two PDFs open,
	 * selection in the background one, and the snip rendered that selection
	 * while writing the image - and the embed link - beside the ACTIVE file.
	 * Wrong document, wrong backlink, silently. Pairing through the path
	 * makes divergence impossible, and the same file open twice still snips:
	 * either pane's selection is that document's ink.
	 */
	function pdfControllerWithSelection(this: HandwritingPlugin, path: string): PdfInkController | null {
		for (const [root, at] of this.pdfFiles) {
			if (at !== path) continue;
			const c = this.pdfInk.get(root);
			if (c?.hasSelection) return c;
		}
		return null;
	}

	/**
	 * What retiring a deleted PDF's claim needs, for a deletion seen now and
	 * for one restored from the session before.
	 */
	function pdfDeleteContext(this: HandwritingPlugin): PdfDeleteContext {
		return {
			store: this.store,
			listPdfPaths: () => this.app.vault.getFiles().filter((f) => f.extension === "pdf").map((f) => f.path),
			familyForPath: async (path) => {
				const found = this.app.vault.getFileByPath(path);
				if (!found || found.extension !== "pdf") return null;
				const { head, byteLength } = await readPdfHead(this.pdfHeadSource(found));
				return pdfInkIdFromHead(head, byteLength, window.crypto);
			},
			graceMs: RECYCLE_GRACE_MS,
			release: (id) => this.releasePdfId(id),
			inkPairedOnto: (path, id) => this.moveBlankPanes(path, id),
			leaveTies: (id, path) => owedLeaveTies(this, id, path),
			leaveMovedBack: (id, path, next) => moveLeavesBack(this, id, path, next),
			leavesOff: (path) => owedLeavesOff(this, path),
			leaveFollowed: (found, kept, path, next) => leaveFollowedOnto(this, found, kept, path, next),
			// One file holds a path at a time: at the delete, a waiting move whose file is at the path is the deleted file's.
			renamedFrom: (path) => {
				const out: { path: string; family: string }[] = [];
				for (const move of claimMovesWaiting.get(this) ?? []) {
					if (move.file.path === path && move.family !== undefined) out.push({ path: move.oldPath, family: move.family });
				}
				return out;
			},
			// A file renamed off the path whose move has not landed, standing elsewhere now: its ink still claims the path.
			keptFor: (path) => familiesRenamedOff(this, path),
			// Asked at the retirement: a copy renamed off an old name before the delete or inside the grace counts.
			renamedOffStanding: (oldPath, deletedPath) => familiesRenamedOff(this, oldPath, deletedPath),
		};
	}

	/**
	 * Ink `id` now claims `path`, found for it by a retirement or an open. Each pane there still on a blank opened
	 * before the vault's list was full is identified again once the PDF is still, as for a change on disk
	 * (schedulePdfModified), and so ends on that ink. Left on its blank, its first stroke claimed the path beside it.
	 */
	function moveBlankPanes(this: HandwritingPlugin, path: string, id: string): void {
		const panes = new Set<HTMLElement>();
		let byPath = pairMoves.get(this);
		for (const [root, at] of this.pdfFiles) {
			if (at !== path) continue;
			const was = this.pdfIds.get(root);
			if (was === undefined || was === id || !this.pdfStore.isEarlyBlank(was)) continue;
			if (!byPath) pairMoves.set(this, (byPath = new Map<string, Map<HTMLElement, { from: string; to: string }>>()));
			let moves = byPath.get(path);
			if (!moves) byPath.set(path, (moves = new Map<HTMLElement, { from: string; to: string }>()));
			moves.set(root, { from: was, to: id });
			panes.add(root);
		}
		if (panes.size > 0) this.schedulePdfModified(path, panes);
	}

	/**
	 * A pane drew on blank `from` after ink `id` was found for its path and before it moved: the stroke and the path
	 * stay the blank's, and `id` leaves the path, as when the blank was drawn on before the pairing. With no claim left,
	 * its file goes to the trash whole. Not while a pane shows `id`, nor when `from` is still a blank or claims nothing
	 * there (a blank never drawn on, its pane closed). While a pane shows `id`, it keeps it; `id` leaves once no pane
	 * shows it (releasePdfId).
	 *
	 * Owed from the first time it cannot run, and kept owed (and saved, PDF_OWED_LEAVES_KEY) until it ran: first every
	 * stroke drawn on `id` since it was owed goes into `from` by the carry (carryInk), and `from`'s file is written; only
	 * then is the claim dropped and the file moved to the trash, whole. A carry that cannot land, a write that fails or a
	 * remove that fails (the store's answer: the move into the trash logged as failed, not thrown) leaves it owed, the
	 * strokes in both files; the next run carries nothing twice (`had`).
	 */
	async function pairedInkLeaves(this: HandwritingPlugin, id: string, path: string, from: string): Promise<void> {
		if (this.pdfStore.isEarlyBlank(from)) return forgetOwedLeave(this, id, path, from);
		const owe = (): void => {
			if (owedLeaveOf(this, id, path, from) !== undefined) return;
			let byId = leaveWhenLetGo.get(this);
			if (!byId) leaveWhenLetGo.set(this, (byId = new Map<string, OwedLeave[]>()));
			const ready = this.pdfStore.inkReady(id);
			const had = ready ? this.pdfStore.strokes(id).map((s) => s.id) : undefined;
			// The claims of both inks now, as this run read them: the names a later run tells a rename made elsewhere by.
			const keptPaths = claims !== null ? [...claims] : undefined;
			const foundPaths = ready ? [...(this.pdfStore.claimedInstances((i) => i === id)[0]?.paths ?? [])] : undefined;
			const entry: OwedLeave = {
				path,
				from,
				...(had !== undefined ? { had } : {}),
				...(keptPaths !== undefined ? { keptPaths } : {}),
				...(foundPaths !== undefined ? { foundPaths } : {}),
			};
			byId.set(id, [...(byId.get(id) ?? []), entry]);
			saveOwedLeaves(this);
			if (had === undefined) hadOnDisk(this, id, entry);
		};
		// The leave owed when this run began. A rename of the copy moves its path at once (movePdfModifiedOnRename), the
		// claims later. Moved while this run waits before it owes, the leave stays owed under the new name, and runs
		// there once the claims moved (movePdfClaimOnRename releases the found ink). Gone on here, the run owed it a
		// second time under the old name with every stroke the found ink holds as held, and that ink went to the trash
		// with the strokes drawn on it since the first owe.
		const begun = owedLeaveOf(this, id, path, from);
		const renamed = (): boolean => begun !== undefined && begun.path !== path;
		let claims = this.pdfStore.claimedInstances((i) => i === from)[0]?.paths ?? (await this.store.readPdfPaths(from));
		if (this.unloaded || renamed()) return;
		// No claims read: the file's own read tells which. No file: nothing keeps the path, so the leave is forgotten. A
		// file that does not parse is never loaded here (that would tell the user it is damaged): the leave stays owed.
		if (claims === null) {
			const claim = await this.store.readPdfClaim(from);
			if (this.unloaded || renamed()) return;
			if (claim === null) return forgetOwedLeave(this, id, path, from);
			if (claim.paths === null) return owe();
			claims = claim.paths;
		}
		// The copy renamed while the kept ink's claims could not be read: the claim move passed over it, and it still claims
		// the name the leave was owed under before (wasName). It moves to the leave's name here, as that move would have
		// moved it, and the leave goes on. Left there, the run found the new name unclaimed by it and forgot the leave: the
		// found ink kept the copy, and a file at the old name later opened wearing the kept ink. A file come to the old name
		// since does not stop it while the copy is at the leave's name; not sure which file is the copy, the leave stays owed.
		// The move is the rename's own claim move, made late: a deletion waiting at the old name now is another file's.
		const was = wasName(this, from, begun, claims);
		if (was !== undefined && !was.sure && !claims.includes(path)) return;
		if (was?.sure === true) {
			if (!(await readied(this, from)) || renamed()) return;
			const held = this.pdfStore.claimedInstances((i) => i === from)[0]?.paths ?? [];
			if (held.includes(was.name)) this.pdfStore.renamePath(from, was.name, path, true);
			claims = this.pdfStore.claimedInstances((i) => i === from)[0]?.paths ?? claims;
			if (!showsInk(this, from)) this.releasePdfId(from);
		}
		// The kept ink no longer claims the path. Nothing owed yet: nothing keeps it, forgotten as before. Owed with its
		// claims at the owe not known (a build before them): not sure where it went, it stays owed. Known: told below,
		// with the found ink's claims.
		if (!claims.includes(path)) {
			if (begun === undefined) return forgetOwedLeave(this, id, path, from);
			if (begun.keptPaths === undefined) return;
		}
		if (showsInk(this, id)) return owe();
		// ensureLoaded answers false for ink already read (as when its last pane just closed): what counts is that it is read.
		if (!(await readied(this, id)) || renamed()) return;
		if (showsInk(this, id)) return owe();
		// Let go as that check answered: its claims would read as none, and the leave be forgotten while its file still
		// claims the copy. It stays owed and runs at the next let-go or launch.
		if (!this.pdfStore.inkReady(id)) return owe();
		// The copy renamed while the found ink's claims could not be read: the claim move passed over it too, and it still
		// claims the name the leave was owed under before. It moves to the leave's name here, as the kept ink's does above.
		// Left there, the run forgot the leave: the strokes drawn on the found ink since the owe stayed off the copy, in a
		// live file claiming a name no file has. Not sure which file is the copy (wasName), the leave stays owed.
		const idClaims = this.pdfStore.claimedInstances((i) => i === id)[0]?.paths ?? [];
		const idWas = idClaims.includes(path) ? undefined : wasName(this, id, begun, idClaims);
		if (idWas !== undefined && !idWas.sure) return;
		if (idWas !== undefined) this.pdfStore.renamePath(id, idWas.name, path, true);
		const foundNow = this.pdfStore.claimedInstances((i) => i === id)[0]?.paths ?? [];
		if (!claims.includes(path) || !foundNow.includes(path)) {
			const moved = begun === undefined ? "gone" : leaveMovedTo(this, begun, path, claims, foundNow);
			if (moved === "unsure") return;
			if (moved === "gone") {
				forgetOwedLeave(this, id, path, from);
				this.releasePdfId(id);
				return;
			}
			return movedLeave(this, id, path, from, moved.to, claims.includes(path) ? from : foundNow.includes(path) ? id : null);
		}
		// From here a failure leaves it owed. Owed now with nothing drawn since, it carries nothing (`had`).
		owe();
		const leave = owedLeaveOf(this, id, path, from);
		if (leave === undefined) return;
		// Owed with the found ink not read: the file its own read took in (else its file's read) tells what it held then.
		const reading = hadReads.get(leave);
		if (reading !== undefined) {
			await reading;
			if (this.unloaded || showsInk(this, id) || owedLeaveOf(this, id, path, from) !== leave) return;
		}
		if (leave.had === undefined) {
			leave.had = this.pdfStore.strokes(id).map((s) => s.id);
			saveOwedLeaves(this);
		}
		const had = new Set(leave.had);
		let drawn = this.pdfStore.strokes(id).filter((s) => !had.has(s.id));
		if (drawn.length > 0) {
			if (!(await readied(this, from)) || showsInk(this, id)) return;
			// Read again after that wait: a stroke cleared meanwhile (Delete all on the kept ink reaches the found ink) is
			// not carried back onto the copy.
			drawn = this.pdfStore.strokes(id).filter((s) => !had.has(s.id));
			// Into `from` by the existing carry: its own strokes and fields, beside the strokes it lacks and the unknown
			// entries the found ink's file holds for them (strokeEntriesOf), taken with them. A carry bringing an entry asks
			// for `from` read in, as readied just answered, with no wait since.
			carryInk(this, from, drawn, strokeEntriesOf(this, id));
			const given = carriedInto.get(this)?.get(from);
			const present = new Set(this.pdfStore.strokes(from).map((s) => s.id));
			if (!drawn.every((s) => present.has(s.id) || given?.has(s.id) === true)) return;
			if (!(await this.store.flushPage(from)) || this.unloaded) return;
			leave.had = [...leave.had, ...drawn.map((s) => s.id)];
			saveOwedLeaves(this);
			if (!showsInk(this, from)) this.releasePdfId(from);
			if (showsInk(this, id)) return;
		}
		// The found ink's claim moved to this path since its file was written, by a retirement or an open it followed
		// (leaveFollowedOnto): that save, still queued, is written first. Queued at the remove, it went into the trash in
		// the file's place, and a move into the trash that failed left the older file live, claiming a name no file has: a
		// later copy of these bytes opened on it. Any other save still queued goes into the trash as before.
		const followed = followedOnto.get(this);
		if (followed?.has(id) === true && this.store.hasQueuedWrite(id)) {
			if (!(await this.store.flushPage(id)) || this.unloaded || showsInk(this, id)) return;
			followed.delete(id);
		}
		const left = this.pdfStore.dropClaim(id, path);
		if (left === null) return;
		if (left.length > 0) {
			if (!(await this.store.flushPage(id)) || this.unloaded) return;
			forgetOwedLeave(this, id, path, from);
			this.releasePdfId(id);
			return;
		}
		// Taken from memory as a closed pane's record is (releasePdfId): not under a lock or a read, nor once it changed.
		const generation = this.pdfStore.generation(id);
		// The store's own answer. A move into the trash that failed (logged, not thrown) leaves the file live, still
		// claiming the copy: the leave stays owed (saved above) and runs again at the next let-go or launch, and the
		// record claims the copy again, as its file does.
		if (!(await this.store.remove(id))) {
			this.pdfStore.restoreClaim(id, path);
			return;
		}
		let trashed = leftForTrash.get(this);
		if (!trashed) leftForTrash.set(this, (trashed = new Set<string>()));
		trashed.add(id);
		if (this.unloaded) return;
		forgetOwedLeave(this, id, path, from);
		if (!showsInk(this, id) && generation !== null) this.pdfStore.forgetIfUnchanged(id, generation);
	}

	/**
	 * The copy at `path` was renamed to `to` where the leave was not held (leaveMovedTo). The ink whose claim stayed on the
	 * old name (`lagging`, null when both moved) follows it, as this session's own claim move would have taken it, and its
	 * file is written; then the leave is owed off `to`, saved, and runs there. A read or write that fails, or a rename here
	 * meanwhile, leaves it owed off `path`, nothing dropped: the next run tells it again.
	 */
	async function movedLeave(
		plugin: HandwritingPlugin,
		id: string,
		path: string,
		from: string,
		to: string,
		lagging: string | null
	): Promise<void> {
		const leave = owedLeaveOf(plugin, id, path, from);
		if (leave === undefined || owedLeaveOf(plugin, id, to, from) !== undefined) return;
		if (lagging !== null) {
			if (!(await readied(plugin, lagging)) || owedLeaveOf(plugin, id, path, from) !== leave) return;
			// The move is the rename's own claim move, made late: a deletion waiting at the old name now is another file's.
			if (plugin.pdfStore.claimedInstances((i) => i === lagging)[0]?.paths.includes(path)) plugin.pdfStore.renamePath(lagging, path, to, true);
			if (!(await plugin.store.flushPage(lagging)) || plugin.unloaded || owedLeaveOf(plugin, id, path, from) !== leave) return;
			if (lagging === from && !showsInk(plugin, from)) plugin.releasePdfId(from);
		}
		leave.path = to;
		if (leave.keptPaths !== undefined) leave.keptPaths = leave.keptPaths.map((p) => (p === path ? to : p));
		if (leave.foundPaths !== undefined) leave.foundPaths = leave.foundPaths.map((p) => (p === path ? to : p));
		saveOwedLeaves(plugin);
		return plugin.pairedInkLeaves(id, to, from);
	}

	/**
	 * The candidates of an open of `path`, put in the order the owed leaves need. A pane a change check is
	 * identifying again on found ink that keeps the path keeps it (keepFound). Any other open takes the ink that keeps
	 * the path (`from`) before the found ink that is to leave it, whatever order the ink folder listed them in, and
	 * still once that leave is owed no more in this session (leavesGone). In place; nothing owed or gone, nothing moves.
	 */
	function pdfLeaving(this: HandwritingPlugin, id: string): boolean {
		return leavesRunning.get(this)?.has(id) === true;
	}

	function pdfLeftForTrash(this: HandwritingPlugin, id: string): boolean {
		return leftForTrash.get(this)?.has(id) === true;
	}

	function pdfOwedFirst(this: HandwritingPlugin, path: string, root: HTMLElement, family: string, candidates: InstanceClaim[]): void {
		const first = (id: string): void => {
			const at = candidates.findIndex((c) => c.id === id);
			if (at > 0) candidates.unshift(...candidates.splice(at, 1));
		};
		const keep = keepFound.get(root);
		if (keep !== undefined && keep.token === this.pdfResolveTokens?.get(root) && familyOf(keep.id) === family) {
			if (candidates.some((c) => c.id === keep.id && c.paths.includes(path))) return first(keep.id);
		}
		// Owed now, or owed no more in this session: an open that read the found ink's file before its run wrote it still
		// holds the path the run dropped (leavesGone).
		for (const byId of [leaveWhenLetGo.get(this), leavesGone.get(this)]) {
			for (const [id, list] of byId ?? []) {
				if (familyOf(id) !== family) continue;
				for (const o of list) {
					if (o.path !== path) continue;
					// The kept ink still on a name the leave was owed under before (wasName): its claim did not move at the
					// rename, and its run moves it. Counted here as on the path, so an open before that run ends on it.
					const behind = candidates.find((c) => c.id === o.from && !c.paths.includes(path));
					if (behind !== undefined && wasName(this, o.from, o, behind.paths)?.sure === true) behind.paths = [...behind.paths, path];
					const kept = candidates.findIndex((c) => c.id === o.from && c.paths.includes(path));
					const found = candidates.findIndex((c) => c.id === id);
					if (kept > found && found >= 0) candidates.splice(found, 0, ...candidates.splice(kept, 1));
				}
			}
		}
	}

	/**
	 * PDF deletions still in their grace, kept per vault and per device: the
	 * app's local store, not data.json, which syncs and would hand one
	 * device's deletions to another, and not raw localStorage, which every
	 * vault on this device shares.
	 */
	function attachPdfPendingDeletes(this: HandwritingPlugin): void {
		this.pdfStore.attachPendingDeletes({
			load: () => this.app.loadLocalStorage(PDF_PENDING_DELETES_KEY) as unknown,
			save: (saved) => this.app.saveLocalStorage(PDF_PENDING_DELETES_KEY, saved),
			context: () => this.pdfDeleteContext(),
		});
		// The leaves owed at the last quit, under their own key: each runs once no pane shows its ink.
		restoreOwedLeaves(this);
	}

export function installPdfClaims(proto: HandwritingPlugin): void {
	installMethods(proto, {
		syncPdfControllers,
		releasePdfId,
		schedulePdfModified,
		movePdfModifiedOnRename,
		onPdfModified,
		resolvePdfId: markPdfIdentification,
		carryFromOldContent,
		pdfHeadSource,
		movePdfClaimOnRename,
		movePdfClaimsBesidePane,
		pdfRenamedWithPane,
		notePdfPaneRenamed,
		pdfIdForPath,
		pdfPaneHoldsClaim,
		pdfInkSnapshot,
		pdfInkOwedWith,
		pdfControllerWithSelection,
		pdfDeleteContext,
		attachPdfPendingDeletes,
		moveBlankPanes,
		pairedInkLeaves,
		pdfOwedFirst,
		pdfLeaving,
		pdfLeftForTrash,
	});
}
