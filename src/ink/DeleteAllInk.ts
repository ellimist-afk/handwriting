/**
 * Delete all ink: the note and PDF wipes behind the command, the refusal and result notices, the confirm dialog, the
 * store's recovery notices and the page-name lookups those notices use. The methods are methods of HandwritingPlugin,
 * installed on its prototype when main.ts loads (installDeleteAllInk at its bottom). Bodies moved unchanged from main.ts,
 * which imports bindRecoveryNotices and ConfirmDeleteInkModal back and re-exports the names tests import from it. This
 * file imports only types from main.
 */
import { installMethods } from "../inline/InstallMethods";
import { App, Modal, Notice, TFile } from "obsidian";
import { SLIDES_SIDECAR_SUFFIX } from "../slides/SlidesInkSurface";
import { deleteAllInkOn, inlineInk, InkOverlayPlugin, overlayForActiveEditor } from "../inline/InkOverlay";
import { deleteAllBackupFailureText } from "../util/DeleteAllBackupNotice";
import { type InkStroke } from "./Stroke";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import type { InkPresence, InlineDeleteCapture } from "../inline/InlineInkStore";
import { PageStore } from "../persistence/PageStore";
import { runDetached } from "../util/Detached";
import type { HandwritingPlugin } from "../main";

declare module "../main" {
	interface HandwritingPlugin {
		deleteAllPdfInk(id: string): Promise<void>;
		deleteAllInkOrSaySo(path: string, overlay?: InkOverlayPlugin | null): void;
		captureDeleteAllTarget(path: string, overlay?: InkOverlayPlugin | null): DeleteAllTarget;
		sameDeleteAllTarget(target: DeleteAllTarget): boolean;
		qualifiedDeleteAllPresence(target: DeleteAllTarget): InkPresence | "invalid-target";
		deleteAllInkNow(target: DeleteAllTarget): void;
		confirmDeleteAllInk(target: DeleteAllTarget): void;
		confirmedDeleteAllInk(target: DeleteAllTarget): void;
		deleteAllInk(target: DeleteAllTarget): Promise<void>;
		noteNameFor(pageId: string): string;
		notePathFor(pageId: string): string | null;
	}
}

/**
 * The two refusals "Delete all ink" can give a PDF, written once because the
 * first of them is used from three places and three copies of a sentence are
 * three things that drift apart.
 *
 * TWO NARROW RULINGS, AND THEY ARE BOTH ABOUT PUNCTUATION AND CASING ONLY.
 *
 * 1. APPROVED BY ALAN, 2026-09-08: sentence case after the "Handwriting:"
 *    prefix - a sentence starts lowercase, "Handwriting" keeps its capital
 *    wherever it appears, and a command keeps its own name, which is why
 *    "Delete all ink" below is still capitalised.
 *
 * 2. APPROVED BY ALAN, 2026-09-09 18:41 CDT, shown both strings as they were
 *    and as they would be and asked yes or no with no wording touched either
 *    way. His answer, verbatim: "last period off, ones between sentences
 *    stay". So the TRAILING period came off both; both internal periods in
 *    the second string remain. Same rule as `DELETE_ALL_TEMPORARY`.
 *
 * 3. AND HE PUT THE TRAILING PERIOD BACK THE SAME DAY, 2026-09-09 17:14 CDT,
 *    which is the state below. Verbatim: "ehhhhhhhhhhhhhhhh we hsould be
 *    consistent, put a period back at end".
 *
 *    WHY, because the reason bounds it: a read found that OTHER messages on
 *    this same command always carried trailing periods and had never been
 *    shown to him - "open the note in editing view to delete its ink.",
 *    "removed N strokes. Undo restores them.", the disk-error line. Shown
 *    both readings, he chose consistency in the direction of RESTORING
 *    periods rather than stripping more. The unruled sentences therefore
 *    need nothing.
 *
 *    THE INTERNAL PERIODS ARE UNTOUCHED BY THIS - his 17:18 "yes that's fine
 *    good call" still binds - and no wording changed. One character each.
 *
 *    DO NOT STRIP THESE AGAIN ON THE STRENGTH OF THE 18:41 ENTRY. It is still
 *    on the record and still says the opposite; this paragraph is why. The
 *    authority is the decision recorded 2026-09-09 17:14 CDT, not this
 *    comment.
 *
 *    ONE SENTENCE IS RULED THE OTHER WAY and is not in this file: the
 *    ink-trash restore line stays BARE, because it ends in a file path where
 *    a period reads as part of the path. That asymmetry is deliberate.
 *
 * HE HAS NEVER SEEN THE WORDING OF EITHER SENTENCE, and neither ruling above
 * says anything about it. They are a casing convention and a trailing
 * character. DO NOT READ THIS BLOCK AS APPROVAL OF THE SENTENCES - two narrow
 * rulings stacked under one heading is exactly how an unapproved string comes
 * to look approved, and the shortest route to that is a third one added
 * without this paragraph.
 *
 * Still open with him and NOT to be pre-empted here: the delete-all refusal
 * reason `changed-during-backup` maps onto the second string below, on the
 * note surface it has an approved sentence, and whether that sentence should
 * be extended to this surface is his to rule.
 */
const PDF_INK_NOT_READY = "Handwriting: this PDF's ink storage is not ready. nothing was deleted.";
/** The note path's two backup refusals, worded for a PDF. */
const PDF_INK_NO_BACKUP = "Handwriting: this PDF's ink cannot be deleted.";
const PDF_INK_BACKUP_UNVERIFIED =
	"Handwriting: this PDF's ink cannot be deleted right now. try again in a moment.";
const PDF_INK_CHANGED_DURING_BACKUP =
	"Handwriting: the ink changed while its backup was being made. nothing was deleted. run Delete all ink again if you still want to remove it.";

/**
 * Read the artifact `preserve` actually returned and check it holds the
 * captured ink, at the ordinary persisted precision a trash copy is
 * written with. A copy of a damaged or newer-schema file is not a copy we
 * may claim, and neither is one whose ink differs from what is on screen.
 */
async function backupHoldsCapture(
capture: InlineDeleteCapture,
at: string,
read: (path: string) => Promise<string>
): Promise<boolean> {
	try {
	const text = await read(at);
		const raw: unknown = JSON.parse(text);
		// THE ARTIFACT MUST DECLARE THE CAPTURED PAGE ITSELF, checked on the
		// RAW bytes and before the parse. `parsePage`'s third argument is a
		// fallback id, and `PageData.ts:646` substitutes it whenever the file
		// omits `pageId` or carries an unsafe one - so the parsed page would
		// come back wearing the very id it is about to be compared against, and
		// bytes that never named this page could pass as its backup.
		if ((raw as { pageId?: unknown } | null)?.pageId !== capture.pageId) return false;
		const parsed = parsePage(text, capture.pageId);
		if (parsed.damaged || parsed.futureVersion !== undefined) return false;
		// The artifact's own JSON goes on to the comparison too, so it can tell
		// a field the FILE never carried from one the copy lost. Without it a
		// sidecar written without `createdAt` is refused on every press,
		// forever, and each refusal leaves another trash generation behind.
		return inlineInk.backupMatchesCapture(capture, parsed.data, raw);
	} catch (err) {
		console.error("[handwriting] could not read back the delete-all backup", at, err);
		return false;
	}
}

/**
 * Read the PDF copy `preserve` returned and check it holds the ink that was
 * on screen when the wipe began, at the precision a saved file is written with.
 */
async function backupHoldsStrokes(
	pageId: string,
	strokes: readonly InkStroke[],
	at: string,
	read: (path: string) => Promise<string>
): Promise<boolean> {
	try {
		const raw: unknown = JSON.parse(await read(at));
		if ((raw as { pageId?: unknown } | null)?.pageId !== pageId) return false;
		const copy = parsePage(JSON.stringify(raw), pageId);
		if (copy.damaged || copy.futureVersion !== undefined) return false;
		const expected = emptyPage(pageId);
		expected.strokes = [...strokes];
		const asSaved = parsePage(serializePage(expected), pageId);
		if (asSaved.damaged) return false;
		return JSON.stringify(copy.data.strokes) === JSON.stringify(asSaved.data.strokes);
	} catch (err) {
		console.error("[handwriting] could not read back the PDF delete-all backup", at, err);
		return false;
	}
}

/**
 * The note a delete-all was invoked on: the object AND the path it was
 * invoked under, captured together before any await.
 *
 * BOTH HALVES, because either alone lies after a rename. The path alone stops
 * naming this note; the object alone survives a rename and would follow the
 * note to its new name, deleting ink the user never confirmed. `null` means
 * the command started on something that is not a file in the vault.
 */
type DeleteAllTarget = Readonly<{ file: TFile; path: string; overlay?: InkOverlayPlugin | null }> | null;

/**
 * Why an inline delete-all refused. One reason per refusal return in
 * `deleteAllInk`, so a refusal can be reported without being inferred.
 */
export type DeleteAllRefusal =
	| "locked-future"
	| "locked-duplicate"
	| "locked-legacy"
	/** The note's ink file could not be read yet: nothing is cleared, it may be healthy. */
	| "locked-transient"
	/** No identity, and no ink in the record either: a note never drawn on. */
	| "unknown-readiness"
	/** No identity, but the record DOES hold ink - drawn before the claim landed. */
	| "unknown-holds-ink"
	/**
	 * The note was renamed, deleted or replaced while the backup ran.
	 *
	 * SEPARATE FROM `readiness-lost` BECAUSE THE SENTENCE DIFFERS. Readiness
	 * can be lost for reasons that really do clear - a lock arriving, a load
	 * starting - and Alan ruled those temporary. This one is not temporary in
	 * any sense: the note is gone, or the path now holds a different note, and
	 * telling that user to try again in a moment is false.
	 */
	| "target-lost"
	| "unsettled-record"
	| "no-capture"
	| "backup-missing"
	| "backup-unverified"
	| "readiness-lost"
	| "changed-during-backup";

/**
 * APPROVED BY ALAN, 2026-09-08, shown the ten refusal reasons and asked for a
 * line each - "okay delete-all just sy something like, your ink cannot be
 * deleted". Put back to him as the exact sentence below and not amended.
 *
 * SOURCE: the decision stamped 2026-09-09 09:12 CDT,
 * which also carries the second string below. An earlier revision of this
 * marker said the words had only been relayed and were not on the record; they
 * are now, and this line points at them instead.
 *
 * ONE SENTENCE AT NEARLY EVERY CALL SITE, and the sameness is the ruling
 * rather than an economy. The part that makes it safe: it claims NOTHING about
 * a copy in either direction. Some of these fire before anything has been
 * written and must not imply one exists; three fire after a trash generation
 * was kept and must not imply one does not.
 *
 * DO NOT VARY IT per reason, per surface, or because it reads oddly somewhere.
 * If a call site makes it read wrong, that is Alan's to rule on: name the call
 * site and leave the string alone. That is exactly how the second string below
 * came to exist.
 *
 * THE TRAILING PERIOD IS HIS, AND SO WAS ITS ABSENCE. The whole arc, because
 * half of it invites the next reader to undo the other half:
 *
 *   The period was OURS - added when the constants were formed, never typed by
 *   him. Shown that, he ruled it off all three on 2026-09-09 17:09: "get the
 *   periods OUT", then "GET EM OUT".
 *
 *   He then RESTORED it the same day, 17:14/17:21: "ehhhhhhhhhhhhhhhh we
 *   hsould be consistent, put a period back at end". The reason bounds it -
 *   other sentences on this same command still carry trailing periods because
 *   he was never shown them ("open the note in editing view to delete its
 *   ink.", "removed N strokes. Undo restores them.", the disk-error notice).
 *   Offered per-string or per-command, he chose consistency, restoring rather
 *   than stripping.
 *
 * Both decisions are recorded at their source, and
 * the earlier one still says the opposite - so read the date before acting on
 * either. A test asserts the BARE form appears in no shipped file.
 *
 * NOT EVERY APPROVED STRING ENDS IN A PERIOD. The trash-restore line is ruled
 * bare - "leave that last one bare" - because it ends in a file path where a
 * period reads as part of the path. It is another owner's, and nothing here
 * may assert a rule that would force it to match these three.
 */
export const DELETE_ALL_REFUSED = "Handwriting: your ink cannot be deleted.";

/**
 * APPROVED BY ALAN, 2026-09-09 09:12 CDT, and SCOPED TO ONE REASON.
 *
 * An attack found the sentence above is FALSE in one place: at
 * `unknown-readiness` on a note that has never been inked and is open in
 * editing view, there is no ink, so nothing "cannot be deleted" - the old code
 * said "removed 0 strokes" there. His ruling, verbatim: "okay, on a note
 * you've never inked you can say 'no ink on this note'", then "yes, correct
 * you got it" on this exact form.
 *
 * `unknown-readiness` ONLY. Every other refusal keeps the sentence above, and
 * the four cases where it reads as permanent when the truth is "not right now"
 * - `unsettled-record`, `readiness-lost`, `changed-during-backup`,
 * `backup-unverified` - are NOT ruled and must not borrow this one. It would
 * be false at all four: those notes DO have ink.
 *
 * THE PERIOD CAME OFF AND WENT BACK ON, both on his word. The history matters
 * more than the final form here, which is why it is recorded rather than
 * quietly shown - and it has now reversed twice:
 *
 *   His words this morning had no period: "you can say 'no ink on this note'".
 *   WE added one when the string was formed, and his "yes, correct you got it"
 *   was given to the form he was shown, not to punctuation he chose. Shown it
 *   later beside the bare version already live on the ordinary path, he ruled
 *   "no period" (2026-09-09 16:58).
 *
 *   Then, told that other sentences on this same command still carry trailing
 *   periods because he was never shown them, he restored it for consistency
 *   (17:14/17:21): "ehhhhhhhhhhhhhhhh we hsould be consistent, put a period
 *   back at end".
 *
 * All decisions are recorded at their source, and the
 * middle one still says the opposite - read the date before acting on either.
 * A test asserts the BARE form appears in no shipped file.
 */
export const DELETE_ALL_NO_INK = "Handwriting: no ink on this note.";

/**
 * APPROVED BY ALAN, 2026-09-09 12:34 CDT, and SCOPED TO FOUR REASONS.
 *
 * SOURCE: the 12:34 decision, recorded before the work began. The sentence below IS his
 * answer - he was shown all eleven reasons rendered as the notices a user
 * actually sees, plus three candidate sentences, and typed this one back
 * himself rather than directing anyone to write it.
 *
 * THE LOWERCASE `try` IS HIS AND IS NOT A TYPO. It matches his other lowercase
 * rulings the same night. No capital T, no em dash, no "please", no rewording.
 *
 * WHAT IT FIXES: at these four the general sentence reads as PERMANENT when
 * the truth is "not right now" - the note is still settling, it stopped being
 * ready mid-delete, or its ink moved while the copy was being made. Trying
 * again works, and the old wording told the user it would not.
 *
 * AND HE WAS OFFERED THE COPY-KEPT VARIANT AND DID NOT TAKE IT. One candidate
 * named the trash generation that three of these four keep. He passed over it
 * and chose the temporary-only sentence, so NOTHING here mentions a copy - not
 * in any form, however true it is of those three. That is recorded because it
 * is the clause a later reader is most likely to "improve" back in.
 *
 * The rule that produced three strings instead of one, kept verbatim because
 * following it twice is what got the wording right: if a call site makes an
 * approved string read wrong, NAME THE CALL SITE AND LEAVE THE STRING ALONE.
 *
 * TWO PERIODS, AND THE INTERNAL ONE NEVER MOVED. He ruled the trailing periods
 * off all three sentences on 2026-09-09 17:09 - "get the periods OUT", then
 * "GET EM OUT" - and RESTORED them the same day at 17:14/17:21 for consistency
 * with the sentences on this command he had never been shown:
 * "ehhhhhhhhhhhhhhhh we hsould be consistent, put a period back at end".
 *
 * Through both reversals the INTERNAL period after "right now" stayed. It
 * separates two sentences: removing it gives "cannot be deleted right now try
 * again in a moment", which is not a punctuation change but a different and
 * worse sentence, and a re-write is his to type rather than ours to attempt.
 * That reading was recorded in the 17:09 entry for him to veto and he did not.
 *
 * The lowercase `try` is his and did not move either.
 */
export const DELETE_ALL_TEMPORARY =
	"Handwriting: your ink cannot be deleted right now. try again in a moment.";

/**
 * WHAT EACH REFUSAL SAYS TO THE USER.
 *
 * Every reason maps to the one approved sentence. The table stays a table
 * rather than collapsing into a single constant at the call site, because it
 * is what makes a NEW reason a build error instead of a silent refusal: the
 * `Record<DeleteAllRefusal, ...>` type will not compile without an entry, and
 * the test beside it asserts every entry carries the approved string. Whoever
 * adds the eleventh reason has to decide, in the open, what it says.
 *
 * WHY THE STRING MATTERED MORE THAN "the user is confused". Refusals at the
 * verification steps happen AFTER `preserve` has written a trash generation,
 * which is kept on purpose, and `freeTrashPath` has no cap - so a button that
 * silently did nothing cost one more file on every press. Nothing downstream
 * mistook that silence for success (`runDetached` is clean), so it was an
 * unbounded-file-growth problem rather than a correctness one.
 */
const DELETE_ALL_REFUSAL_TEXT: Record<DeleteAllRefusal, string | null> = {
	"locked-future": DELETE_ALL_REFUSED,
	"locked-duplicate": DELETE_ALL_REFUSED,
	"locked-legacy": DELETE_ALL_REFUSED,
	"locked-transient":
		"Handwriting: this note's ink file could not be read yet. New ink on it is not saved until it loads.",
	// THE ONE THAT DIFFERS, and it differs because the other sentence was FALSE
	// here rather than merely awkward: this note has no ink at all.
	"unknown-readiness": DELETE_ALL_NO_INK,
	// The same readiness, but this note HAS ink - so the never-inked sentence
	// would be false here and it keeps the general one.
	"unknown-holds-ink": DELETE_ALL_REFUSED,
	// THE FOUR HE RULED TEMPORARY, and only these four. At each of them trying
	// again works, which the general sentence denied. Three of them keep a
	// trash generation and say nothing about it: he was shown that variant and
	// passed over it.
	"unsettled-record": DELETE_ALL_TEMPORARY,
	"readiness-lost": DELETE_ALL_TEMPORARY,
	"changed-during-backup": DELETE_ALL_TEMPORARY,
	"backup-unverified": DELETE_ALL_TEMPORARY,
	// NOT temporary, deliberately: `no-capture` and `backup-missing` are not
	// states that clear by waiting, and he was not shown them for this ruling.
	"no-capture": DELETE_ALL_REFUSED,
	"backup-missing": DELETE_ALL_REFUSED,
	// Nor this one, and it is the reason this key exists apart from
	// `readiness-lost`: a renamed, deleted or replaced note does not come back
	// in a moment, so the temporary sentence would be false about it.
	"target-lost": DELETE_ALL_REFUSED,
};

/**
 * Report a refused delete-all. THE ONLY THING IT DOES IS SPEAK.
 *
 * It reads no state that could change one, and it clears, persists, snapshots
 * and resets nothing - the old warning that reached the user as a side effect
 * of the wipe attempting to persist is not a reporting path, it was a symptom,
 * and it stopped firing the moment the command started refusing before it
 * touched the store.
 */
function reportDeleteAllRefusal(reason: DeleteAllRefusal): void {
	const text = DELETE_ALL_REFUSAL_TEXT[reason];
	if (text !== null) new Notice(text);
}

/** Every reason, for coverage that the table and the union stay in step. */
export const DELETE_ALL_REFUSALS = Object.keys(DELETE_ALL_REFUSAL_TEXT) as DeleteAllRefusal[];

/** The approved text for a refusal, or null while none has been approved. */
export function deleteAllRefusalText(reason: DeleteAllRefusal): string | null {
	return DELETE_ALL_REFUSAL_TEXT[reason];
}

/** The clear, the history entry and the notice: the only side effects. */
function finishDeleteAllInk(path: string, kept: string | null, overlay?: InkOverlayPlugin | null): void {
	if (overlay === undefined) {
		const n = deleteAllInkOn(path);
		reportDeleteAllResult(n, kept);
		return;
	}
	reportDeleteAllResult(deleteAllInkOn(path, overlay), kept);
}

function reportDeleteAllResult(n: number | null, kept: string | null): void {
	if (n === null) {
		new Notice("Handwriting: open the note in editing view to delete its ink.");
		return;
	}
	const what = n === 1 ? "1 stroke" : `${n} strokes`;
	new Notice(
		kept
			? `Handwriting: removed ${what}. Undo restores them; a copy is kept in ${kept}.`
			: `Handwriting: removed ${what}. Undo restores them.`
	);
}

/**
 * The store's two RECOVERY notices, which are two different events.
 *
 * `onRecovered` is the corrupt-file promotion: the main file could not be read,
 * its own complete interrupted save was promoted, and the corrupt bytes are
 * quarantined under a new name. Its sentence is accurate for that and unchanged.
 *
 * `onInkTrashRestored` is an ink-trash restore: no live sidecar existed, a
 * readable generation was found in the trash and renamed back into place.
 * `restoredTo` is that live file - the restore is a rename, so there is no kept
 * copy to name. Its sentence is Alan's, approved 2026-09-09; the authority is
 * the decision stamped 2026-09-09 18:26 CDT, not this
 * comment. Lowercase `the`, curly quotes around the note, internal period kept,
 * no final period.
 *
 * EXTRACTED FROM `onload` ONLY so a test can execute the REAL callbacks rather
 * than a copy of them: built inline they were unreachable, and a test that
 * re-implements a notice proves nothing about the one that ships. It is called
 * from `onload` and nowhere else; there is no test-only formatter.
 */
export function bindRecoveryNotices(
	store: PageStore,
	noteNameFor: (pageId: string) => string
): void {
	store.onRecovered = (pageId, keptAs) => {
		new Notice(
			`Handwriting recovered the ink on "${noteNameFor(pageId)}" from an interrupted save. The unreadable file is kept as ${keptAs}.`,
			15000
		);
	};
	// NO TRAILING PERIOD, AND THAT IS RULED - not drafted, not an oversight.
	//
	// Alan restored the trailing period on six other approved strings the same
	// day ("put a period back at end", 2026-09-09 17:14 CDT) and was then asked
	// about this one specifically. His answer: "leave that last one bare"
	// (17:21 CDT). THE REASON IS THE PATH: this sentence ends in a file path,
	// and a period there reads as part of the path.
	//
	// SO THE ASYMMETRY IS DELIBERATE. Six punctuated, this one bare. Anyone
	// checking consistency will find this string the odd one and be tempted to
	// "fix" it - that is what this comment is for. The authority is the 17:21
	// decision as recorded, not this comment,
	// and `RecoveredAnnouncesTrashRestore.test.ts` reds if a period appears.
	//
	// The INTERNAL period after "trash" stays, as it always has.
	store.onInkTrashRestored = (pageId, restoredTo) => {
		new Notice(
			`Handwriting restored the ink on “${noteNameFor(pageId)}” from trash. the file is at ${restoredTo}`,
			15000
		);
	};
	// The two background-flush sentences end in a path too, so no trailing
	// period, as above.
	store.onFlushPromoted = (pageId, keptAs) => {
		new Notice(
			`Handwriting restored ink on "${noteNameFor(pageId)}" from a save that was cut off. The page as it was before is kept as ${keptAs}`,
			15000
		);
	};
	store.onFlushKeptAside = (pageId, keptAs) => {
		new Notice(
			`Handwriting found ink on "${noteNameFor(pageId)}" from a save that was cut off. It does not match the saved page, so the page was left as it was. That ink is kept as ${keptAs}`,
			15000
		);
	};
}

	/**
	 * The confirmed pdf wipe. Same permanence invariant as the note wipe: the
	 * trash copy is made FIRST and a failed copy aborts everything -
	 * Handwriting never deletes ink it could not preserve. `preserve` also
	 * flushes any pending write, so the copy holds today's ink, not
	 * yesterday's file.
	 *
	 * The controllers' undo history is cleared rather than left holding ops
	 * against strokes that no longer exist: an undo replayed across the wipe
	 * would restore a fragment and call it the past. The trash copy is the
	 * recovery path, and the dialog said so.
	 *
	 * "Made FIRST" was doing more work than it could carry. The copy is made
	 * first in TIME, but `preserve` is awaited, and the wipe used to read the
	 * document again on the other side of that await - so ink drawn during the
	 * copy was cleared from the live file and absent from the copy, while the
	 * notice named the copy as the recovery path. The two guards below close
	 * that: the store must be able to write at all, and the ink must be the
	 * same ink, both immediately before anything is cleared.
	 */
	async function deleteAllPdfInk(this: HandwritingPlugin, id: string): Promise<void> {
		// The trash copy is only a safety net if the store can actually write.
		// In session-memory mode, mid-read, or under either lock, `persist`
		// drops every scheduled write: this session's ink has never reached
		// the disk and never will, so `preserve` copies a file that does not
		// contain it - or finds no file at all and returns null - and the
		// clear below destroys the only remaining copy while the notice says
		// one was kept. A locked document has already been told its ink is not
		// being saved; being told a copy was kept immediately after is the
		// same lie twice. Refuse before making the claim, not after.
		if (!this.pdfStore.canPersist(id)) {
			new Notice(PDF_INK_NOT_READY);
			return;
		}
		// What is on screen RIGHT NOW, frozen before the await. Everything
		// below reads the stroke array again once `preserve` has resolved, and
		// a stroke finished inside that gap is in neither copy: the backup was
		// taken before it existed, and the clear removes it from the live
		// document. Only a full-content value sees that. A count, an id set or
		// a bounding box all miss a stroke that replaced another, and
		// `inkFingerprint` is lossy by construction.
		const before = this.pdfInkSnapshot(id);
		if (before === null) {
			new Notice(PDF_INK_NOT_READY);
			return;
		}
		let kept: string | null = null;
		try {
			kept = await this.store.preserve(id);
		} catch (err) {
			console.error("[handwriting] delete-all-pdf-ink backup failed", err);
			new Notice(deleteAllBackupFailureText(err, "PDF"));
			return;
		}
		// Read the copy back NOW, the one await after the copy, and judge it
		// below once the two guards have had their say: a copy that does not
		// exist, or does not hold the ink that was on screen, is not a copy.
		const kept0 = kept;
		const copyOk =
			(JSON.parse(before) as InkStroke[]).length === 0 ||
			(kept0 !== null &&
				kept0.trim() !== "" &&
				(await backupHoldsStrokes(id, JSON.parse(before) as InkStroke[], kept0, (p) => this.store.readText(p))));
		// Both guards again, and NOTHING may await between here and the clear.
		// Readiness is rechecked because the wait is long enough to lose it: a
		// poll that finds the sidecar half-written by a sync client locks the
		// record while the backup is in flight, and a copy taken before that
		// lock is not a copy of what is on screen now.
		if (!this.pdfStore.canPersist(id)) {
			new Notice(PDF_INK_NOT_READY);
			return;
		}
		// The copy that did complete is left where it is - it is a real
		// generation of real ink and deleting it would be its own small loss -
		// but nothing here claims it holds the strokes drawn since.
		if (this.pdfInkSnapshot(id) !== before) {
			new Notice(PDF_INK_CHANGED_DURING_BACKUP);
			return;
		}
		if (!copyOk) {
			new Notice(kept === null || kept.trim() === "" ? PDF_INK_NO_BACKUP : PDF_INK_BACKUP_UNVERIFIED);
			return;
		}
		const n = this.pdfStore.strokes(id).length;
		this.pdfStore.replaceAll(id, []);
		for (const [root, controller] of this.pdfInk) {
			if (this.pdfIds.get(root) === id) {
				controller.forgetHistory();
				controller.refresh();
			}
		}
		const what = n === 1 ? "1 stroke" : `${n} strokes`;
		new Notice(
			kept
				? `Handwriting: removed ${what}. A copy is kept in ${kept}.`
				: `Handwriting: removed ${what}.`
		);
	}

	/**
	 * "Delete all ink" once the command has decided the note qualifies:
	 * either the confirm dialog, or the refusal that says why not.
	 *
	 * THE REFUSAL MUST NOT BE A GUESS. `hasInk` is a read of the session
	 * cache, and the cache is empty for every note whose sidecar has not been
	 * read yet - so on a note opened moments ago, or one this pane has never
	 * shown, the old code answered "Handwriting: no ink on this note" about a
	 * note full of ink. `inkPresence` separates "certainly empty" from "not
	 * looked up yet" (InlineInkStore.inkPresence), and the second one is
	 * answered by GOING AND LOOKING: one `ensureLoaded`, then the same
	 * decision on real information. The load is the cheap path in the common
	 * case - a note with no `handwriting-page-id` is already "none" off a
	 * metadata lookup, no file I/O - so this costs a read exactly when a read
	 * is the only honest way to answer.
	 *
	 * Deliberately still LISTED on every note, per the command's own comment:
	 * the fix is to stop lying in the refusal, not to hide the command.
	 */
	function deleteAllInkOrSaySo(this: HandwritingPlugin, path: string, overlay?: InkOverlayPlugin | null): void {
		// THE TARGET, captured before any await, as an object AND the path it
		// was invoked under. A string does not follow a rename, so every later
		// step compares against this pair rather than trusting the name.
		const target = this.captureDeleteAllTarget(path, overlay);
		if (target?.overlay === null) {
			new Notice("Handwriting: open the note in editing view to delete its ink.");
			return;
		}
		if (this.qualifiedDeleteAllPresence(target) === "unknown") {
			runDetached(
				// ONE attempt, and it requalifies the SAME capture afterwards.
				// An unresolved load must not become no-ink, and must not loop.
				inlineInk.ensureLoaded(path).then(() => this.deleteAllInkNow(target)),
				`read ink before deleting all of it on ${path}`
			);
			return;
		}
		this.deleteAllInkNow(target);
	}

	/**
	 * The note and pane this command was invoked on. The pane is captured before
	 * the confirmation or backup can yield, so a focus change cannot move undo
	 * into another editor. Older direct callers without a workspace editor keep
	 * the path-only behavior; product commands supply a pane or explicit null.
	 *
	 * `null` when the command started on something that is not a Markdown file
	 * in the vault, which is not a note we may delete ink from either.
	 */
	function captureDeleteAllTarget(this: HandwritingPlugin, path: string, overlay?: InkOverlayPlugin | null): DeleteAllTarget {
		const file = this.app.vault.getFileByPath(path);
		if (file === null) return null;
		const active = this.app.workspace?.activeEditor;
		const selected = overlay !== undefined
			? overlay
			: active
				? active.editor && active.file === file
					? overlayForActiveEditor(active.editor, file)
					: null
				: undefined;
		return { file, path, overlay: selected };
	}

	/**
	 * Is the captured target STILL the current one, synchronously, right now?
	 *
	 * Four clauses, and each is load-bearing (ruled 2026-09-09T07:31:28):
	 *
	 *  - `!this.unloaded` - the plugin itself is still live. Acting after
	 *    unload writes through a store nobody is maintaining.
	 *  - `extension === "md"` - it is still a note.
	 *  - `file.path === target.path` - NOT RENAMED. Obsidian moves the same
	 *    `TFile` object and updates its `path`, so the object surviving is not
	 *    evidence the name did.
	 *  - the vault entry AT that path IS that object - NOT REPLACED. Path
	 *    equality alone is insufficient: delete-then-recreate at the same path
	 *    produces a different `TFile` wearing the same name, and following the
	 *    string there would retarget the deletion at somebody else's ink.
	 *
	 * `getActiveFile()` is deliberately not consulted. The target is the note
	 * the command was invoked on, never whatever happens to be focused when the
	 * user finally clicks.
	 */
	function sameDeleteAllTarget(this: HandwritingPlugin, target: DeleteAllTarget): boolean {
		if (target === null) return false;
		return (
			!this.unloaded &&
			target.file.extension === "md" &&
			target.file.path === target.path &&
			this.app.vault.getAbstractFileByPath(target.path) === target.file
		);
	}

	/**
	 * Presence, but only when it is evidence about THIS note.
	 *
	 * `inkPresence` answers a question about a path; this answers a question
	 * about a target, and the difference is the whole seam. Three ways a bare
	 * `none` is not evidence of an empty note:
	 *
	 *  - THE TARGET IS GONE OR IS SOMEBODY ELSE. A note renamed away leaves no
	 *    record and no metadata under its old path, which is precisely the
	 *    shape `InlineInkStore.ts:453` answers `none` for. Identity first.
	 *  - NO HOST. Session-memory mode has nothing to look in, so `none` there
	 *    means "nothing looked", not "nothing to find".
	 *  - NO METADATA. A missing file cache cannot testify that the note has no
	 *    ink id; absent metadata is the absence of evidence. Metadata that IS
	 *    available and carries no ink id is real evidence and may be `none`.
	 *
	 * Returns `"invalid-target"` rather than throwing, so the caller decides
	 * what to say - and the caller says the generic refusal, never no-ink.
	 */
	function qualifiedDeleteAllPresence(this: HandwritingPlugin, target: DeleteAllTarget): InkPresence | "invalid-target" {
		if (!this.sameDeleteAllTarget(target)) return "invalid-target";
		if (!inlineInk.hasHost()) return "unknown";
		const presence = inlineInk.inkPresence(target!.path);
		if (presence !== "none") return presence;
		const cache = this.app.metadataCache.getFileCache(target!.file);
		return cache === null || cache === undefined ? "unknown" : "none";
	}

	/**
	 * The decision itself, on information already in hand.
	 *
	 * THE ORDINARY PATH USES ALAN'S SENTENCE TOO, on his ruling of 2026-09-09
	 * 16:49 - "yeah both use mine". This site and the `unknown-readiness`
	 * refusal were one character apart, and the difference was never a
	 * decision: the constant simply had not been carried here. He was told the
	 * two do not differ beyond the period, and that HIS sentence was on the
	 * rare path while the older wording was on the common one - so the ruling
	 * is about REACH, not wording.
	 *
	 * It stops at the note surface. The PDF sentence is still open with him.
	 *
	 * AND NO-INK IS NOW TWO CONDITIONS, NOT ONE. Alan's sentence says something
	 * about a specific note, so it may only be said when this is still that
	 * note AND its presence is a qualified `none`.
	 *
	 * `inkPresence` ALONE CANNOT CARRY IT, which is the trap in this seam and
	 * is why the identity check is not belt-and-braces. `InlineInkStore.ts:453`
	 * answers `none` when there is no record and the note carries no page id -
	 * and a note that has been renamed away has exactly that shape: no record
	 * under the old string, no metadata under it either. So `none` means both
	 * "a real empty note" and "no longer there", and only the captured object
	 * tells them apart. Swapping `hasInk` for `inkPresence` would have looked
	 * like the fix and left the seam open.
	 *
	 * `unknown` does not reach the sentence either: an unread record with an
	 * empty cache is not evidence of emptiness, it is the absence of evidence.
	 */
	function deleteAllInkNow(this: HandwritingPlugin, target: DeleteAllTarget): void {
		const presence = this.qualifiedDeleteAllPresence(target);
		if (presence === "ink") this.confirmDeleteAllInk(target);
		else if (presence === "none") new Notice(DELETE_ALL_NO_INK);
		else new Notice(DELETE_ALL_REFUSED);
	}

	/**
	 * "Delete all ink": confirm first. The count in the dialog is live.
	 *
	 * THE MODAL IS THE LONGEST AWAIT IN THIS COMMAND - it is however long the
	 * user takes - so the identity is checked again inside the callback,
	 * immediately before the wipe is dispatched. Checking only at the start
	 * would authorise a deletion against a note and then perform it against
	 * whatever holds that path by the time they click.
	 */
	export function confirmDeleteAllInk(this: HandwritingPlugin, target: DeleteAllTarget): void {
		if (target === null) return;
		const count = inlineInk.strokes(target.path).length;
		if (count === 0) return;
		const id = inlineInk.pageIdOf(target.path);
		// The dialog names the folder the copy will go to.
		new ConfirmDeleteInkModal(this.app, count, "note", () =>
			this.confirmedDeleteAllInk(target)
		, () => (id ? this.store.trashFolderFor(id) : Promise.resolve(`${this.store.inkFolder()}/trash`))).open();
	}

	/**
	 * What the confirmation button actually does.
	 *
	 * A NAMED METHOD RATHER THAN AN INLINE CLOSURE, so the re-check has a
	 * caller a test can reach: `ConfirmDeleteInkModal` is not exported and
	 * nothing in the suite drives it, so a check living inside its callback
	 * could only ever be pinned by reading the source. This is the same
	 * decision, one indirection out, and it is executed instead.
	 */
	function confirmedDeleteAllInk(this: HandwritingPlugin, target: DeleteAllTarget): void {
		// A CONFIRMED CALL WITHOUT ITS ORIGINAL CAPTURE IS INVALID, and that is
		// not permission to reacquire one by path: the whole point of the
		// capture is that the path may no longer mean what it meant.
		if (!target || !this.sameDeleteAllTarget(target)) {
			new Notice(DELETE_ALL_REFUSED);
			return;
		}
		runDetached(this.deleteAllInk(target), `delete all ink on ${target.path}`);
	}

	/**
	 * The confirmed wipe. Order matters and follows the permanence invariant:
	 * the .handwriting/trash/ safety copy is made BEFORE anything is removed, and a
	 * failed copy aborts the wipe entirely. Handwriting never deletes ink it could
	 * not first preserve. A damaged (unreadable) sidecar skips the copy: the
	 * file on disk is already the artifact being protected, the wipe writes
	 * nothing there (fail-closed lock), and only session strokes are cleared.
	 */
	async function deleteAllInk(this: HandwritingPlugin, target: DeleteAllTarget): Promise<void> {
		// (0) THE TARGET, BEFORE THE READINESS. A confirmed call arriving
		// without its original capture is invalid, and reacquiring one from the
		// path would defeat the capture's whole purpose.
		if (!target || !this.sameDeleteAllTarget(target)) {
			reportDeleteAllRefusal("target-lost");
			return;
		}
		const path = target.path;

		// (1) READINESS BEFORE ANYTHING. A blocked note gets NO side effects at
		// all: no preservation, no trash write, no session change, no live
		// bytes, no history entry and no success notice. Not a quieter
		// success - nothing. Under these locks `snapshot()` refuses, so every
		// write this command would make dies silently, and a note that has
		// already been told its ink is not being saved must not then be told a
		// copy was kept.
		//
		// NO NOTICE IS RAISED HERE, deliberately. The store's own lock
		// reporting is the approved wording and it has already spoken; no new
		// copy is authorized for this path, and inventing one - or borrowing
		// the pdf route's - is out of scope. Named in the handback as the one
		// thing this repair leaves owed.
		const readiness = inlineInk.deleteAllReadiness(path);
		if (readiness.kind === "blocked") {
			reportDeleteAllRefusal(`locked-${readiness.lock}`);
			return;
		}

		// `unknown` REFUSES, on the 18:21 ruling, and this reverses what an
		// earlier revision of this command did. The measurement that revision
		// rested on still stands - an unclaimed record's ink has no sidecar and
		// cannot compose one, so there is nothing on disk to lose - but the
		// ruling is about what an UNPROVEN state may be permitted to do, which
		// is a different question: unknown does not prove eligibility, a valid
		// capture, an empty target or an adequate backup, so it may not reach a
		// destructive clear, a history entry or a success notice.
		//
		// NO EMPTINESS PROBE HERE, deliberately: discovering the target was
		// empty by calling the registry IS invoking the wipe. The
		// non-destructive no-op for an empty note already exists upstream in
		// `confirmDeleteAllInk`, which returns before the modal when the count
		// is zero, and it is untouched.
		if (readiness.kind === "unknown") {
			// TWO DIFFERENT NOTES REACH THIS ONE READINESS, and Alan's second
			// string is true of only one of them. He ruled on "a note you've
			// never inked"; `unknown` also covers a note that HAS been drawn on
			// but whose identity claim has not landed yet - a state measured in
			// this file's `unknown` cases, holding real strokes. Telling that
			// user "no ink on this note" would be a second false sentence of
			// exactly the kind the first one was corrected for, so the reason is
			// split here rather than the string being stretched to cover it.
			//
			// QUALIFIED PRESENCE, NOT A STROKE COUNT. An empty `strokes(path)`
			// is the same shape for "a note never drawn on" and for "a note
			// that is no longer there", and only the first of those may be
			// told there is no ink on it. So ONLY a qualified `none` takes the
			// no-ink arm; `ink`, `unknown` and an invalid target all take the
			// generic refusal.
			//
			// It remains a pure lookup: it inspects, and it does not invoke the
			// wipe to discover whether the target was empty.
			const presence = this.qualifiedDeleteAllPresence(target);
			reportDeleteAllRefusal(presence === "none" ? "unknown-readiness" : "unknown-holds-ink");
			return;
		}

		// AN UNSETTLED RECORD REFUSES FOR THE SAME REASON, and it is the arm
		// that matters most: mid-load its memory is empty while the sidecar can
		// be full, so the capture is empty, and an empty capture is the one the
		// backup verification below does not run. Letting it through would read
		// "I have not looked yet" as "there is nothing to preserve".
		if (readiness.kind === "unsettled") {
			reportDeleteAllRefusal("unsettled-record");
			return;
		}

		// `damaged` remains the EXISTING intentional session-only branch, kept
		// as a distinct explicit exception: the file on disk is already the
		// artifact being protected and the wipe writes nothing there.
		if (readiness.kind !== "ready") {
			finishDeleteAllInk(path, null, target.overlay);
			return;
		}

		// (2) THE CAPTURE, at the same boundary as the readiness check and
		// before any await: ordered, deep, immutable, and carrying each
		// targeted stroke's `unknownByObject` entry.
		//
		// A null capture REFUSES rather than clearing. `ready` already implies
		// a record with a page id so this is not reachable through readiness,
		// but "no valid capture" and "safe to destroy" must not be the same
		// branch: the ruling names a valid capture as one of the things an
		// unproven state does not establish.
		const capture = inlineInk.captureDeleteAll(path);
		if (capture === null) {
			reportDeleteAllRefusal("no-capture");
			return;
		}

		let kept: string | null = null;
		try {
			kept = await this.store.preserve(capture.pageId);
		} catch (err) {
			console.error("[handwriting] delete-all-ink backup failed", err);
			new Notice(deleteAllBackupFailureText(err, "note"));
			return;
		}

		// (3) THE BACKUP THAT CAME BACK HAS TO HOLD THE INK. `preserve` copies
		// whatever is at the live path and returns where it put it; its return
		// value does not certify that the file equals what is on screen. A
		// non-empty target therefore requires a real returned path AND a
		// readback that matches the capture at ordinary saved precision.
		// The empty-target case skips the verification below because there was
		// nothing to preserve - and that is only true because readiness has
		// already refused every unsettled record. An empty capture on a record
		// that has not finished loading means "not looked at yet", not "empty".
		if (capture.targets.length > 0) {
			// A REAL PATH, not merely a non-null one. `preserve` answering with
			// an empty or blank string is not a location a copy can be at, and
			// treating it as one would let "I could not preserve this" pass for
			// "preserved, carry on".
			if (kept === null || kept.trim() === "") {
				reportDeleteAllRefusal("backup-missing");
				return;
			}
			if (!(await backupHoldsCapture(capture, kept, (p) => this.app.vault.adapter.read(p)))) {
				reportDeleteAllRefusal("backup-unverified");
				return;
			}
		}

		// (4) AND NOTHING MAY AWAIT FROM HERE TO THE CLEAR. Readiness can be
		// lost during the copy, and content can change under it - including by
		// less than the persisted codec can represent, which is why the
		// current-content check is exact and unrounded while the backup check
		// above is not.
		//
		// On any refusal here the backup STAYS. It is a real generation of
		// real ink; deleting it to tidy up would be its own small loss, and
		// "no trash copy" stops being a truthful postcondition the moment
		// preservation has run.
		// THE SAME TARGET, RECHECKED HERE AND NOT EARLIER. Preservation is an
		// await, and a rename, delete or replacement during it leaves the path
		// naming a different note - or none. This is the last synchronous
		// moment before the mutation, so it is the only place the check is
		// worth anything.
		//
		// The backup already produced STAYS, and is neither retargeted nor
		// removed: it is a real generation of this note's real ink, and the
		// note having moved does not make it less so.
		if (!target || !this.sameDeleteAllTarget(target)) {
			// `target-lost`, NOT `readiness-lost`. Both refuse and both keep the
			// backup, but they say different things, and only one of them is
			// true here: the note is not coming back in a moment.
			reportDeleteAllRefusal("target-lost");
			return;
		}
		if (inlineInk.deleteAllReadiness(path).kind !== "ready") {
			reportDeleteAllRefusal("readiness-lost");
			return;
		}
		if (!inlineInk.currentMatchesCapture(capture)) {
			reportDeleteAllRefusal("changed-during-backup");
			return;
		}

		finishDeleteAllInk(path, kept, target.overlay);
	}

	/**
	 * The note a page id belongs to, for user-facing messages (RC4).
	 *
	 * The ownership ledger is the cheap answer and is right whenever the note
	 * has been seen this session. It can miss (a census that has not run, an
	 * id freed by a hand edit), so the vault is the fallback, and a page id
	 * that resolves to nothing at all degrades to the short id rather than
	 * printing an empty name. There is genuinely nothing better to say then.
	 */
	export function noteNameFor(this: HandwritingPlugin, pageId: string): string {
		return this.notePathFor(pageId) ?? `an unnamed page (${pageId.slice(0, 8)}…)`;
	}

	/** The lookup half of `noteNameFor`: the note or open PDF a page id belongs to, or null. */
	export function notePathFor(this: HandwritingPlugin, pageId: string): string | null {
		// A slides deck keeps its ink in `<note id>.slides`: the note is the file.
		const noteId = pageId.endsWith(SLIDES_SIDECAR_SUFFIX)
			? pageId.slice(0, -SLIDES_SIDECAR_SUFFIX.length)
			: pageId;
		const known = this.pageIds.owner(noteId);
		if (known) return known;
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (this.recentPageIdFor(f) === noteId) return f.path;
		}
		// An open PDF: its ink id is held per pane, next to the path it was read from.
		for (const [root, id] of this.pdfIds) {
			const at = id === pageId ? this.pdfFiles.get(root) : undefined;
			if (at) return at;
		}
		// A PDF whose pane has closed: the path this session resolved its id from.
		return this.pdfPathById?.get(pageId) ?? null;
	}

/**
 * The native confirm in front of "Delete all ink". A command this destructive
 * is never one accidental palette hit away. Cancel holds focus, so Enter
 * dismisses rather than deletes.
 */
export class ConfirmDeleteInkModal extends Modal {
	constructor(
		app: App,
		private count: number,
		private noun: "note" | "PDF",
		private onConfirm: () => void,
		private trashDir: () => Promise<string>
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText(`Delete all ink on this ${this.noun}?`);
		const trashDir = await this.trashDir();
		const what = this.count === 1 ? "1 stroke" : `${this.count} strokes`;
		// The promises differ because the recovery paths do. Note ink is one
		// pane's history away; pdf ink is wiped across every page and its
		// history is cleared with it, so the trash copy is the whole net and
		// the dialog must not promise more than that.
		this.contentEl.createEl("p", {
			text:
				this.noun === "note"
					? `${what} will be removed. Undo (Ctrl+Z) restores them while the ` +
						"note stays open, and a copy of the saved ink is kept in the " +
						`vault's ${trashDir} folder.`
					: `${what} will be removed from every page of this document. ` +
						"A copy of the saved ink is kept in the vault's " +
						`${trashDir} folder.`,
		});
		const row = this.contentEl.createDiv({ cls: "modal-button-container" });
		const del = row.createEl("button", { text: "Delete all ink", cls: "mod-warning" });
		del.addEventListener("click", () => {
			this.close();
			this.onConfirm();
		});
		const cancel = row.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
		cancel.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export function installDeleteAllInk(proto: HandwritingPlugin): void {
	installMethods(proto, {
		deleteAllPdfInk,
		deleteAllInkOrSaySo,
		captureDeleteAllTarget,
		sameDeleteAllTarget,
		qualifiedDeleteAllPresence,
		deleteAllInkNow,
		confirmDeleteAllInk,
		confirmedDeleteAllInk,
		deleteAllInk,
		noteNameFor,
		notePathFor,
	});
}
