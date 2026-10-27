/**
 * `Delete all ink` on a note the store may not write NOW REFUSES.
 *
 * WHAT THIS FILE WAS, because the history is the reason the cases are shaped
 * the way they are. It was written as a CHARACTERISATION of a defect: the
 * command consulted exactly one lock, `damagedLocked`, and only to decide
 * whether to attempt the trash copy. Under any of the other three -
 * `legacyLocked`, `futureLocked`, `duplicateLocked` - `applyRemove` called
 * `take` unconditionally, so the strokes left memory and the note went blank;
 * the write it scheduled was dropped, because `snapshot` returns null for all
 * four locks; and `clearAllInk` returned the count it had taken BEFORE any of
 * that, so the command announced a successful wipe. The file on disk still
 * held every stroke, so nothing was lost - it was a false REPORT rather than a
 * data-loss defect - but the user was told the ink was gone and it came back
 * on the next load.
 *
 * WHAT IT IS NOW. That behaviour is ruled out. `deleteAllReadiness` is the
 * command's gate and it answers a typed reason; future, duplicate and legacy
 * are blocked, an unsettled record is refused, `unknown` is refused, and a
 * refusal produces NO preservation, no trash write, no session change, no live
 * bytes, no history entry and no success notice. The cases below were
 * converted in place rather than deleted, so each one still carries the
 * evidence it was written with and now asserts the ruled outcome instead of
 * the defect.
 *
 * DAMAGED REMAINS THE ONE EXPLICIT EXCEPTION, session-only by design: the file
 * on disk is already the artifact being protected and the wipe writes nothing
 * there. It is kept here as the control that the refusal is a decision about
 * writability and not a blanket "never delete".
 *
 * SILENCE IS NOT THE RULED END STATE. Every refusal routes through the
 * command's reporter, and every reason currently maps to null because Alan has
 * approved no wording for them. Assertions here therefore pin that nothing is
 * SAID rather than claiming that saying nothing is correct - when copy is
 * approved, those assertions are the ones that must change.
 *
 * The strings asserted here are the SHIPPED ones. Copy is Alan's; this file
 * names what is said today and proposes nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { inkApplied, inkEffect, inkHistorySupport } from "./InkHistory";
import type { InlineInkHost } from "./InlineInkStore";
import persistSrc from "./InlineInkStorePersist.ts?raw";
import { codeOnly } from "../CodeOnly";
import { emptyPage, parsePage, serializePage, type PageData } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const notices = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			constructor(message: string) {
				notices.list.push(message);
			}
			hide(): void {
				/* no-op */
			}
		},
	};
});

import HandwritingPlugin from "../main";

const PATH = "locked-note.md";
const PAGE_ID = "locked-note-id";
/** Higher than anything this build writes, which is what arms `futureLocked`. */
const FUTURE_SCHEMA = 9_999;

let teardown: Array<() => void> = [];

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	notices.list.length = 0;
	vi.spyOn(InkOverlayPlugin.prototype, "mount").mockImplementation(() => {});
});

afterEach(() => {
	for (const undo of teardown.splice(0)) undo();
	inlineInk.handleDelete(PATH);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 10, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 10 },
		createdAt: 0,
	};
}

/** Which lock the sidecar arms, if any. */
type Mode = "plain" | "future" | "legacy";

/**
 * A loaded note plus a registered overlay. `future` seeds the sidecar with a
 * schema this build cannot write; `legacy` seeds a canvas-surface page. Both
 * are what the store latches on, and they latch in DIFFERENT PLACES - see the
 * legacy case below, where the saved ink never reaches memory at all.
 */
async function note(mode: Mode): Promise<{
	writes: string[];
	said: string[];
	undoOnce: () => boolean;
	reload: () => Promise<void>;
}> {
	const page = emptyPage(PAGE_ID);
	// A canvas page over the editor is the legacy lock's trigger, checked in
	// `adoptSidecar` BEFORE the version and before the merge.
	//
	// "canvas" IS NOT IN TODAY'S `surface` UNION ("inline" | "pdf" | "slides"),
	// so this build cannot write one - which is precisely why the lock exists
	// and why the cast is right rather than a convenience. The value has to be
	// forced past the type the same way an older build's JSON arrives past it.
	// The runtime guard is `surface !== "inline"`, so it is broader than
	// "canvas" alone.
	page.surface = (mode === "legacy" ? "canvas" : "inline") as PageData["surface"];
	page.strokes = [stroke("s1"), stroke("s2")];
	const bytes = serializePage(page, mode === "future" ? FUTURE_SCHEMA : undefined);
	const writes: string[] = [];
	// The store's OWN channel. `noteOnce` speaks through `host.notify`, not
	// through `Notice`, and stubbing it away hides half of what a user sees.
	const said: string[] = [];

	const host = {
		readPageId: (p: string) => (p === PATH ? PAGE_ID : null),
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: async () => parsePage(bytes, PAGE_ID),
		// EVERY write the store asks for, so "the file was never touched" is a
		// recorded fact rather than an absence nobody looked for.
		scheduleSidecar: (id: string) => void writes.push(id),
		notify: (m: string) => void said.push(m),
	} as unknown as InlineInkHost;
	inlineInk.attachHost(host);
	await inlineInk.ensureLoaded(PATH);

	let state = EditorState.create({
		doc: "body",
		extensions: [history(), inkHistorySupport()],
	});
	const view = {
		get state() {
			return state;
		},
		dispatch(input: Transaction | TransactionSpec) {
			const tr = input instanceof Transaction ? input : state.update(input);
			state = tr.state;
			for (const e of tr.effects) {
				if (e.is(inkEffect) && !tr.annotation(inkApplied)) {
					(overlay as unknown as { applyInkOp(op: unknown): void }).applyInkOp(e.value);
				}
			}
		},
	};
	const overlay = new InkOverlayPlugin(view as never);
	Object.assign(overlay, {
		filePath: () => PATH,
		selection: { clear() {}, prune() {} },
		scheduleRepaint() {},
		repaintPath() {},
		redrawSelectionUI() {},
		unmount() {},
	});
	teardown.push(() => (overlay as unknown as { destroy(): void }).destroy());
	/**
	 * Drop the session record and read the sidecar again through the same
	 * host - a store-level reload, not an Obsidian restart. `bytes` is
	 * captured above and never rewritten, so what comes back is exactly what
	 * is on disk.
	 */
	const reload = async (): Promise<void> => {
		inlineInk.handleDelete(PATH);
		inlineInk.attachHost(host);
		await inlineInk.ensureLoaded(PATH);
	};

	// The delete-all pushes ONE history op carrying the stroke objects, so
	// whether the session's unsaved ink is recoverable is a question about
	// this, not about the disk.
	return { writes, said, undoOnce: () => undo(view as never), reload };
}

/**
 * The capture `deleteAllInkOrSaySo` makes, and the vault that backs it.
 *
 * The command now carries a captured note object rather than a path, so a
 * rename cannot retarget it. These fixtures are about LOCKS, not identity,
 * so they supply a target that is simply valid throughout.
 */
const noteFile = { path: PATH, extension: "md" };
const targetForPath = { file: noteFile, path: PATH };
const vaultBits = {
	unloaded: false,
	app: {
		vault: {
			getFileByPath: (p: string) => (p === PATH ? noteFile : null),
			getAbstractFileByPath: (p: string) => (p === PATH ? noteFile : null),
		},
		metadataCache: { getFileCache: () => ({}) },
	},
};

type Deleter = { deleteAllInk(target: unknown): Promise<void> };

/**
 * The command now READS BACK the artifact `preserve` returned, so a stub that
 * only answers with a path is a claim about a file that does not exist. This
 * rig writes a real copy of the note's current ink and serves it back, so the
 * writable path is exercised rather than stubbed past.
 *
 * On a LOCKED note none of it is reached: the readiness guard returns before
 * `preserve` is called at all, which is what these cases now assert.
 */
const TRASH = ".handwriting/trash/kept.json";
const runDeleteAll = (): Promise<void> => {
	const files = new Map<string, string>();
	return (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(
		Object.assign(Object.create(HandwritingPlugin.prototype) as object, vaultBits, {
			store: {
				preserve: async () => {
					const page = emptyPage(inlineInk.pageIdOf(PATH) ?? PAGE_ID);
					page.surface = "inline";
					page.strokes = [...inlineInk.strokes(PATH)];
					files.set(TRASH, serializePage(page));
					return TRASH;
				},
			},
			app: {
				...vaultBits.app,
				vault: {
					...vaultBits.app.vault,
					adapter: {
						read: async (at: string) => {
							const text = files.get(at);
							if (text === undefined) throw new Error(`no such file: ${at}`);
							return text;
						},
					},
				},
			},
		}) as unknown as HandwritingPlugin,
		targetForPath
	);
};

/**
 * Every notice, flattened and CASE-FOLDED.
 *
 * Alan has ruled on notice casing twice on 2026-09-08 - the four pdf notices
 * into sentence case, then "nothing was deleted" lowercased in the two
 * trash-copy failure notices - and his rule is "sentence case after the
 * 'Handwriting:' prefix". A test that hard-codes capitalisation blocks the
 * next such ruling from landing, which is exactly what happened here: an
 * assertion in this file held up his own approved copy.
 *
 * So these assert WHAT the user was told, not how it was capitalised.
 *
 * THE NEGATIVES MATTER MORE THAN THE POSITIVES. A stale positive assertion
 * FAILS, which is loud and gets fixed. A stale NEGATIVE silently PASSES and
 * quietly stops detecting the thing it was written for - so `not.toContain`
 * is the shape that must be case-folded, even though it is not the shape that
 * blocked anything today.
 */
const told = (): string => notices.list.join(" ").toLowerCase();

describe("delete all ink on a note the store may not write", () => {
	it("CONTROL: an unlocked note really is wiped, and the write is scheduled", async () => {
		const { writes } = await note("plain");

		await runDeleteAll();

		expect(inlineInk.strokes(PATH)).toHaveLength(0);
		expect(writes.length).toBeGreaterThan(0); // the file was asked to change
		expect(told()).toContain("removed 2 strokes");
	});

	it("RULED: a future-locked note is REFUSED - no clear, no history, no success", async () => {
		const { writes, said } = await note("future");

		await runDeleteAll();

		// NOTHING IS SAID ON EITHER CHANNEL, and this is the sharpest form of
		// the copy this repair owes. The store's "not saved" warning used to
		// arrive as a SIDE EFFECT of the delete: the clear called `persist`,
		// `persist` hit the lock and spoke. Refusing before any of that means
		// the warning never fires, so a user who picks Delete-all on a locked
		// note now sees no response whatsoever.
		//
		// That is strictly better than the old false success and still not
		// good enough. It is pinned rather than papered over because the
		// wording is Alan's and none is approved for this path.
		expect(said).toEqual([]);

		// AND NOTHING ELSE IS SAID. The success sentence is gone, because
		// there was no success: under this lock every write dies in
		// `snapshot`, so a copy-kept claim would be the same lie twice.
		expect(told()).not.toContain("removed");
		expect(told()).not.toContain("a copy is kept");

		// No side effects at all - the initially-blocked contract. The ink is
		// still on screen and the file was never asked to change.
		expect(inlineInk.strokes(PATH)).toHaveLength(2);
		expect(writes).toEqual([]);
	});

	it("THE COMMAND NOW SPEAKS: the store is silent, and the refusal says so itself", async () => {
		// `noteOnce` latches on `rec.noticed`, so the store says this at most
		// ONCE per record per session. Drawing on the note first - the
		// overwhelmingly likely thing to do before deleting its ink - spends
		// it. The delete-all that follows says only that it succeeded.
		const { writes, said } = await note("future");
		inlineInk.applyAdd(PATH, [stroke("s3")]);
		expect(said).toHaveLength(1); // spent here, by an ordinary draw

		const before = said.length;
		await runDeleteAll();

		// Nothing further from the store, and the file still untouched.
		expect(said).toHaveLength(before);
		expect(writes).toEqual([]);
		// AND THE COMMAND ANSWERS FOR ITSELF NOW. This case used to pin the
		// SILENCE and say so in its title, because refusing without a word was
		// correct behaviour with no approved wording behind it. Alan has since
		// ruled the wording, so the gap it existed to make visible is closed
		// and the case pins the sentence instead of the absence.
		expect(told()).not.toContain("removed");
		expect(told().length, "the refusal is not silent any more").toBeGreaterThan(0);
		expect(inlineInk.strokes(PATH)).toHaveLength(3);
	});

	it("the strokes now STAY in memory: nothing is cleared under the lock", async () => {
		// `applyRemove` calls `take` before it ever tries to persist, so the
		// screen agrees with the notice and only the disk disagrees. This is
		// the half that makes the report convincing.
		await note("future");

		await runDeleteAll();

		expect(inlineInk.strokes(PATH)).toHaveLength(2);
	});

	it("SETTLES IT: session ink drawn under the lock is no longer wiped at all", async () => {
		// Ink still FLOWS under the lock - the notices only say it is not being
		// saved - so there is real, unsaved ink here to lose.
		const { writes, undoOnce } = await note("future");
		inlineInk.applyAdd(PATH, [stroke("session-only")]);
		expect(inlineInk.strokes(PATH).map((x) => x.id)).toContain("session-only");
		expect(writes).toEqual([]); // and it never reached disk

		await runDeleteAll();

		// STILL THERE. Previously this ink left memory and only an undo the
		// user had to think of brought it back; now the command declines and
		// there is nothing to restore.
		expect(inlineInk.strokes(PATH).map((x) => x.id)).toContain("session-only");

		// NO HISTORY ENTRY EITHER - part of "no side effects". An undo here
		// belongs to whatever the user did before, not to a delete that did
		// not happen.
		expect(undoOnce()).toBe(false);
		expect(writes).toEqual([]);
	});

	it("the await gap is closed: a locked note never reaches `preserve` at all", async () => {
		// This used to be the gap - a stroke finished during the copy was in
		// neither the trash file nor the note. On a LOCKED note the readiness
		// guard now returns before `preserve` is called, so the window does
		// not open. The writable-note version of this race is covered in
		// InlineDeleteAllRouting.test.ts by the capture/re-compare cases.
		const { undoOnce } = await note("future");
		let preserveCalled = false;
		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(
			Object.assign(Object.create(HandwritingPlugin.prototype) as object, vaultBits, {
				store: {
					preserve: async () => {
						preserveCalled = true;
						inlineInk.applyAdd(PATH, [stroke("finished-in-the-gap")]);
						return TRASH;
					},
				},
			}) as unknown as HandwritingPlugin,
			targetForPath
		);

		expect(preserveCalled, "the guard returns before any preservation").toBe(false);
		expect(inlineInk.strokes(PATH)).toHaveLength(2);
		expect(undoOnce()).toBe(false);
	});

	it("RULED: all four locks are consulted, through one typed gate rather than one predicate", async () => {
		// THIS CASE USED TO SAY THE OPPOSITE, and the evidence it was built on
		// is kept because it explains the defect: `isDamagedLocked` was the
		// single lock the command asked about, and there is still no public
		// predicate for `futureLocked` or `legacyLocked` at all - which is
		// exactly why a per-lock predicate was the wrong thing to gate on.
		await note("future");

		const store = inlineInk as unknown as Record<string, unknown>;
		expect(typeof store.isDamagedLocked).toBe("function");
		expect(typeof store.isDuplicateLocked).toBe("function");
		expect(store.isFutureLocked, "still no predicate for this one").toBeUndefined();
		expect(store.isLegacyLocked, "nor this one").toBeUndefined();

		// The gate is `deleteAllReadiness`, and it answers with the REASON.
		// A future-locked note is not merely "not damaged" any more; it is
		// blocked, and it can say which lock blocked it.
		expect(inlineInk.isDamagedLocked(PATH), "still not the damaged lock").toBe(false);
		const answer = inlineInk.deleteAllReadiness(PATH);
		expect(answer.kind).toBe("blocked");
		expect((answer as { lock: string }).lock).toBe("future");
	});

	it("LEGACY: refused like the others, and the saved ink still never loads", async () => {
		// The legacy lock is armed in a DIFFERENT PLACE from the future one:
		// `adoptSidecar` sets it and returns BEFORE the merge, so a canvas
		// page's saved strokes never reach memory at all. A future-locked note
		// shows its ink read-only; a legacy-locked note shows none.
		const { writes, said } = await note("legacy");
		expect(inlineInk.strokes(PATH)).toHaveLength(0);

		// So the only ink here is the session's, and drawing it spends the
		// warning exactly as the future case does.
		inlineInk.applyAdd(PATH, [stroke("session-only")]);
		expect(said).toEqual([
			"Handwriting: this note has a canvas page from an older layout. Ink drawn on it in the editor is not saved.",
		]);
		expect(writes).toEqual([]);

		await runDeleteAll();

		// REFUSED. Legacy was NOT named in the 17:22 ruling, which blocks
		// future and duplicate, and was handed back as a declared extension;
		// It was ACCEPTED at 18:21 as a typed blocked reason, so it is no
		// longer an extension awaiting a decision. The reasoning that earned
		// it: `snapshot()` refuses for it identically, so the write dies in the
		// same place - and because a legacy note's saved ink never reaches
		// memory at all, which makes a copy-kept claim about it doubly untrue.
		// Flagged in the handback as an extension beyond the literal ruling.
		expect(inlineInk.strokes(PATH).map((x) => x.id)).toEqual(["session-only"]);
		expect(writes).toEqual([]);
		expect(told()).not.toContain("removed");
		expect(told()).not.toContain("a copy is kept");
	});

	it("DUPLICATE: refused, so the loaded ink is no longer wiped from memory", async () => {
		// This lock is set by the caller rather than by the sidecar, so the
		// file loads normally first - both saved strokes really are in memory
		// and really are wiped, while the file keeps them.
		const { writes, said } = await note("plain");
		expect(inlineInk.strokes(PATH).map((x) => x.id)).toEqual(["s1", "s2"]);

		inlineInk.markDuplicateLocked(PATH, "copy.md");
		expect(inlineInk.isDuplicateLocked(PATH)).toBe(true);
		expect(said).toHaveLength(1); // the lock speaks ONCE, at lock time
		writes.length = 0; // discard the writes the note made while unlocked

		inlineInk.applyAdd(PATH, [stroke("session-only")]);
		expect(writes).toEqual([]); // and from here nothing is written at all

		await runDeleteAll();

		expect(inlineInk.strokes(PATH)).toHaveLength(3);
		expect(writes).toEqual([]);
		// Nothing further from the store: its one notice was spent when the
		// lock was marked, which is BEFORE the user does anything at all. So
		// this is the quietest lock AND the quietest refusal - the two silences
		// compound, and the copy owed above is owed most sharply here.
		expect(said).toHaveLength(1);
		expect(told()).not.toContain("removed");
	});

	it("the duplicate lock is the quietest of the four: persist never names it, only snapshot does", () => {
		// Where each lock is enforced is the reason the duplicate case above is
		// silent by default rather than after a spent warning.
		const src = codeOnly(persistSrc);
		const region = (start: string): string => {
			const at = src.indexOf(start);
			expect(at, start + " not found").toBeGreaterThanOrEqual(0);
			// The next member declaration. Comments are blanked, so a
			// `function` inside one cannot end the region early.
			const ends = ["\n\tfunction ", "\n\tasync function "]
				.map((end) => src.indexOf(end, at + start.length))
				.filter((i) => i > 0);
			return src.slice(at, ends.length > 0 ? Math.min(...ends) : src.length);
		};
		const persist = region("function persist(");
		const snapshot = region("function snapshot(");

		// `persist` refuses legacy and future BY NAME, each with its own notice.
		expect(persist).toContain("legacyLocked");
		expect(persist).toContain("futureLocked");
		// It says nothing about duplicate, so the write falls through to
		// `snapshot`, which returns null - dropped with no notice from the
		// write path at all. (Comments are blanked, so this is code.)
		expect(persist).not.toContain("duplicateLocked");
		expect(snapshot).toContain("duplicateLocked");
	});

	it("RELOAD: nothing was written and nothing was lost, so a reload changes nothing", async () => {
		// The one claim in this file that previously rested on the file being
		// unwritten rather than on a reload being watched. This watches it.
		const { writes, reload } = await note("future");
		inlineInk.applyAdd(PATH, [stroke("session-only")]);
		expect(inlineInk.strokes(PATH).map((x) => x.id)).toEqual(["s1", "s2", "session-only"]);

		await runDeleteAll();
		// Refused: everything is exactly where it was.
		expect(inlineInk.strokes(PATH).map((x) => x.id)).toEqual(["s1", "s2", "session-only"]);
		expect(writes).toEqual([]);

		// A store-level reload through the same host, over the same bytes -
		// not an Obsidian restart, but the same read the next open performs.
		await reload();

		// The saved ink is still there, as it always was. What this case used
		// to catch was the SURPRISE: a user told the note was wiped and a copy
		// kept, who reopened and found the ink back. There is no surprise left
		// to catch, because nothing was cleared and nothing was claimed.
		expect(inlineInk.strokes(PATH).map((x) => x.id)).toEqual(["s1", "s2"]);
		// The session's unsaved ink still does not survive a reload - it never
		// reached disk and this repair does not change that. It is no longer
		// DESTROYED by the delete, which is the part that was fixable here.
		expect(inlineInk.strokes(PATH).map((x) => x.id)).not.toContain("session-only");
	});
});
