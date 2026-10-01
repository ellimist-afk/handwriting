import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Notices are captured through the REAL `obsidian` binding, so what is counted
 * below is what the plugin would actually show. `EmptyPageNotices.test.ts`
 * established this idiom.
 */
const notices = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			constructor(message: string) {
				notices.messages.push(message);
			}
		},
	};
});

import { installFakeWindow } from "../test/routerHarness";
installFakeWindow();

import { Notice } from "obsidian";
import { PageStore } from "./persistence/PageStore";
import { FakeAdapter, gate } from "./persistence/FakeAdapter";
import { emptyPage, serializePage } from "./model/PageData";
import { bindRecoveryNotices } from "./main";
import { inlineInk } from "./inline/InkOverlay";
import type { InkStroke } from "./ink/Stroke";

/**
 * ONE TRASH-RESTORE NOTICE PER ACTUAL RESTORATION, DRIVEN THROUGH THE REAL
 * CALLER - not modelled, not read off the source.
 *
 * The store raises `onInkTrashRestored`; the plugin's binding is the SOLE
 * SPEAKER for that event on every surface.
 *
 * WHAT THESE CASES DRIVE. The real `PageStore` over a real adapter, the real
 * `bindRecoveryNotices` from `main.ts` (the same function `onload` calls), and
 * the real inline surface: `inlineInk.ensureLoaded`, whose host `loadSidecar`
 * is `store.load`, exactly as `main.ts` wires it. Every decision under test is
 * production code; nothing here re-implements a predicate or a sentence.
 *
 * `fromInkTrash` IS PROVENANCE, NOT A COMPLETED RESTORE. It is also set on the
 * failed-restore return, where the rename did not happen and no callback is
 * raised - that case must claim neither a restoration nor an interrupted save,
 * and the case below pins exactly that.
 *
 * THE CANVAS HALF IS GONE WITH THE CANVAS PAGE. These cases used to be
 * driven through the deleted canvas page view's `loadPage`, and the doubling
 * they guarded against was that view's own bare interrupted-save notice, firing
 * for an event
 * the store had already announced. The view, its notice and its
 * `&& !result.fromInkTrash` discriminator were deleted with the surface, so
 * that second speaker no longer exists to be re-introduced. What remains, and
 * is driven here, is the store-and-binding half: one event, one sentence, one
 * notice, and the surface adding nothing of its own. Two claims that could only
 * be shown through the view are listed by name in the removal evidence.
 */

const PAGE_ID = "recovered-trash-restore";
const HOME = ".handwriting";
const NOTE_LABEL = "My Note";

/** `restoreFromTrash` needs an adapter that can enumerate; FakeAdapter cannot. */
class ListingAdapter extends FakeAdapter {
	/** Set to make the restore's rename fail, leaving the ink in the trash. */
	failRename = false;
	private heldTrashRestore: {
		claimed: boolean;
		reached: ReturnType<typeof gate>;
		release: ReturnType<typeof gate>;
	} | null = null;

	/** Hold only the first real trash-to-live rename, and report when it arrives. */
	holdFirstTrashRestoreRename(): { reached: Promise<void>; release: () => void } {
		const held = { claimed: false, reached: gate(), release: gate() };
		this.heldTrashRestore = held;
		return { reached: held.reached.promise, release: held.release.release };
	}

	async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = dir.endsWith("/") ? dir : dir + "/";
		const files = [...this.files.keys()].filter((p) => p.startsWith(prefix));
		if (files.length === 0 && !this.dirs.has(dir)) throw new Error("no such folder: " + dir);
		return { files, folders: [] };
	}

	async rename(from: string, to: string): Promise<void> {
		if (this.failRename) throw new Error("rename refused (fixture)");
		const held = this.heldTrashRestore;
		if (
			held &&
			!held.claimed &&
			from.startsWith(`${HOME}/trash/${PAGE_ID}-`) &&
			to === `${HOME}/${PAGE_ID}.json`
		) {
			held.claimed = true;
			held.reached.release();
			await held.release.promise;
		}
		return super.rename(from, to);
	}

	/** Every path currently on disk, for the "no added copy" assertions. */
	paths(): string[] {
		return [...this.files.keys()].sort();
	}
}

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2,
		createdAt: 1,
		points: [
			{ x: 10, y: 20, pressure: 0.5, t: 0 },
			{ x: 30, y: 40, pressure: 0.5, t: 8 },
		],
		bbox: { x: 10, y: 20, width: 20, height: 20 },
	};
}

function sidecarText(): string {
	// `surface: "inline"`, and load-bearing: a sidecar without it is a
	// canvas page era file, and the inline surface refuses to adopt one
	// (`adoptSidecar`'s legacy lock). The note under test here is an
	// ordinary one, so its sidecar says so.
	const page = { ...emptyPage(PAGE_ID), surface: "inline" as const };
	page.strokes.push(stroke("s0"));
	return serializePage(page);
}

/** A different note path per open: the inline store keeps one record per path. */
let opens = 0;
const freshPath = () => `Recovered-${++opens}.md`;

/**
 * A store with the REAL production notice bindings installed, and the real
 * inline surface reading through it. `noteNameFor` is resolved from the
 * EVENT's pageId, never from an active leaf, which is what the contract
 * requires.
 *
 * The host is the wiring `main.ts` gives `inlineInk.attachHost`, narrowed to
 * the members a read reaches: the page id comes from the note's metadata and
 * the sidecar read is `store.load`. Nothing here decides anything - every
 * recovery decision is inside the store, and every sentence inside the binding.
 */
function rig(seed: (adapter: ListingAdapter) => void) {
	const adapter = new ListingAdapter();
	seed(adapter);
	const store = new PageStore({ vault: { adapter } });
	bindRecoveryNotices(store, (pageId) => (pageId === PAGE_ID ? NOTE_LABEL : `other:${pageId}`));

	inlineInk.attachHost({
		readPageId: () => PAGE_ID,
		claimId: async () => ({ pageId: PAGE_ID }),
		loadSidecar: (pageId) => store.load(pageId),
		scheduleSidecar: (pageId, page) => store.schedule(pageId, page),
		// main.ts sends this to `blockNotice`, which shows a Notice. Counted
		// with the rest: a recovery sentence from the surface is a second
		// speaker, which is exactly what these cases forbid.
		notify: (message) => {
			new Notice(message);
		},
	});

	return {
		adapter,
		store,
		/** One editor opening one note: the real inline read of this page. */
		open: async () => {
			const path = freshPath();
			await inlineInk.ensureLoaded(path);
			return path;
		},
		strokeIds: (path: string) => inlineInk.strokes(path).map((s) => s.id),
	};
}

const seedTrash = (a: ListingAdapter) =>
	a.externalWrite(`${HOME}/trash/${PAGE_ID}-1.json`, sidecarText());
const seedCorrupt = (a: ListingAdapter) => {
	a.externalWrite(`${HOME}/${PAGE_ID}.json`, "{ this is not json");
	a.externalWrite(`${HOME}/${PAGE_ID}.json.tmp`, sidecarText());
};
/** No live sidecar and no corrupt main: the bare interrupted-save recovery. */
const seedBareInterrupted = (a: ListingAdapter) =>
	a.externalWrite(`${HOME}/${PAGE_ID}.json.tmp`, sidecarText());
const seedClean = (a: ListingAdapter) => a.externalWrite(`${HOME}/${PAGE_ID}.json`, sidecarText());

const TRASH_SENTENCE = `Handwriting restored the ink on “${NOTE_LABEL}” from trash. the file is at ${HOME}/${PAGE_ID}.json`;

const isTrashNotice = (m: string) => m.includes("from trash");
const isCorruptPromotion = (m: string) => m.includes("The unreadable file is kept as");

beforeEach(() => {
	notices.messages.length = 0;
});
afterEach(() => {
	notices.messages.length = 0;
});

describe("a trash restore, driven through the real caller", () => {
	// THE HARNESS PROOF, green and first. If the drive is not really running,
	// every count below is meaningless.
	it("the harness holds: the real loadPage runs, the ink comes back, nothing throws", async () => {
		const { open, adapter } = rig(seedTrash);
		await expect(open()).resolves.toBeTruthy();

		// The ink is on disk at the live path, restored by a rename.
		const live = await adapter.read(`${HOME}/${PAGE_ID}.json`);
		expect(JSON.parse(live).strokes.map((s: { id: string }) => s.id)).toEqual(["s0"]);
		// And at least one notice was produced, so a zero below would be real.
		expect(notices.messages.length).toBeGreaterThan(0);
	});

	it("says Alan's approved sentence, with the real note label and the real restored path", async () => {
		const { open } = rig(seedTrash);
		await open();

		expect(notices.messages).toContain(TRASH_SENTENCE);
		// The label came from the EVENT's pageId, not from any active leaf.
		expect(TRASH_SENTENCE).toContain(NOTE_LABEL);
	});

	/**
	 * THE ACCEPTANCE CASE. Exactly one notice belongs to one restoration.
	 *
	 * A count over real emitted notices - not a fingerprint, not a copied
	 * predicate, not a thrown fixture. It reds if the store raises twice for
	 * one restoration, if the binding speaks on a path that is not one, or if
	 * the inline surface starts announcing recoveries of its own.
	 */
	it("ONE notice per restoration, and no corrupt-promotion notice", async () => {
		const { open } = rig(seedTrash);
		await open();

		expect(notices.messages).toHaveLength(1);
		expect(notices.messages.filter(isCorruptPromotion)).toEqual([]);
	});

	it("adds no copy of the ink: the trash generation is consumed, not duplicated", async () => {
		const { open, adapter } = rig(seedTrash);
		await open();

		expect(adapter.paths()).toEqual([`${HOME}/${PAGE_ID}.json`]);
	});
});

describe("the events that must NOT be swept up with it", () => {
	// Without this, "exactly one notice" could be satisfied by suppressing
	// every recovery notice there is.
	// The bare interrupted-save recovery: a .tmp beside no live sidecar. The
	// store recovers it; only the deleted canvas page view ever announced it, so
	// after the view went the recovery is silent and no trash notice may appear either.
	it("CONTROL: a bare interrupted-save recovery claims no trash restore", async () => {
		const { open } = rig(seedBareInterrupted);
		await open();

		expect(notices.messages.filter(isTrashNotice)).toEqual([]);
	});

	it("CONTROL: a corrupt-file promotion keeps its own quarantine notice", async () => {
		const { open } = rig(seedCorrupt);
		await open();

		expect(notices.messages.filter(isCorruptPromotion)).toHaveLength(1);
		expect(notices.messages.filter(isTrashNotice)).toEqual([]);
	});

	it("CONTROL: an ordinary clean load announces nothing at all", async () => {
		const { open } = rig(seedClean);
		await open();

		expect(notices.messages).toEqual([]);
	});
});

describe("repeat behaviour: once per restoration, and never a permanent silence", () => {
	it("an ordinary reload of the restored file adds no further notice", async () => {
		const { open } = rig(seedTrash);
		await open();
		const afterRestore = notices.messages.length;

		// The file is now an ordinary live sidecar; opening it again is not a
		// restoration and must say nothing more.
		await open();
		expect(notices.messages).toHaveLength(afterRestore);
	});

	it("a LATER genuine restoration of the same page to the same path announces AGAIN", async () => {
		const { open, adapter } = rig(seedTrash);
		await open();
		const first = notices.messages.filter(isTrashNotice).length;
		expect(first).toBe(1);

		// The page is deleted to the trash again and restored again: a new
		// event, same pageId, same path. No suppression set may swallow it.
		await adapter.rename(`${HOME}/${PAGE_ID}.json`, `${HOME}/trash/${PAGE_ID}-2.json`);
		await open();

		expect(notices.messages.filter(isTrashNotice)).toHaveLength(2);
	});

	it("overlapping opens complete one trash restore without losing the live ink", async () => {
		const { open, adapter, strokeIds } = rig(seedTrash);
		const held = adapter.holdFirstTrashRestoreRename();
		const firstOpen = open();
		await held.reached;

		// A second real editor read reaches the shared store while the first
		// actual restore rename is still held.
		const secondOpen = open();
		try {
			await expect(secondOpen).resolves.toBeTruthy();
		} finally {
			held.release();
		}
		const paths = await Promise.all([firstOpen, secondOpen]);

		expect(
			adapter.log.filter(
				(entry) =>
					entry ===
					`rename ${HOME}/trash/${PAGE_ID}-1.json -> ${HOME}/${PAGE_ID}.json`
			)
		).toHaveLength(1);
		expect(notices.messages).toEqual([TRASH_SENTENCE]);
		expect(notices.messages.filter(isCorruptPromotion)).toEqual([]);

		const live = await adapter.read(`${HOME}/${PAGE_ID}.json`);
		expect(JSON.parse(live).strokes.map((s: { id: string }) => s.id)).toEqual(["s0"]);
		// And the next editor to open the note reads the restored ink, not an
		// empty page. (What the two RACING readers hold is deliberately not
		// asserted: each read its own copy at a different point in the
		// rename, which is the store's business and not this file's claim.)
		expect(paths).toHaveLength(2);
		expect(strokeIds(await open())).toEqual(["s0"]);
	});
});

describe("a FAILED restoration claims nothing", () => {
	it("no restore notice, no interrupted-save notice, and the ink stays in the trash", async () => {
		const { open, adapter } = rig((a) => {
			seedTrash(a);
			a.failRename = true;
		});
		await open();

		// No callback was raised, so nothing may claim a restoration...
		expect(notices.messages.filter(isTrashNotice)).toEqual([]);
		// ...and it must not be announced as a corrupt-file promotion either.
		expect(notices.messages.filter(isCorruptPromotion)).toEqual([]);

		// The ink is where it was: still in the trash, no live copy invented.
		expect(adapter.paths()).toEqual([`${HOME}/trash/${PAGE_ID}-1.json`]);
	});

	it("and the result still reports the trash as its provenance", async () => {
		const adapter = new ListingAdapter();
		seedTrash(adapter);
		adapter.failRename = true;
		const store = new PageStore({ vault: { adapter } });
		const result = await store.load(PAGE_ID);

		// Provenance, not a completed restore: a surface that read this result
		// learns the ink came from the trash and that nothing was restored.
		expect(result!.fromInkTrash).toBe(true);
		expect(result!.recovered).toBe(true);
	});
});

/**
 * THE RESTORE LINE IS RULED BARE, AND IT IS THE ONLY ONE.
 *
 * Alan restored the trailing period on six other approved strings on
 * 2026-09-09 ("put a period back at end", 17:14 CDT) and was then asked about
 * this one specifically. His answer: "leave that last one bare" (17:21 CDT).
 * THE REASON IS THE PATH - this sentence ends in a file path, where a trailing
 * period reads as part of the path.
 *
 * PINNED SEPARATELY AND BY NAME, deliberately. There is no rule "approved
 * strings end in a period" and a guard that asserted one would be wrong about
 * this string. Six are punctuated and pinned where they live; this one is bare
 * and pinned here. Two rules, not one exception to one rule.
 *
 * Without this the bareness is only IMPLICIT - it lives inside the expected
 * sentence and reads like a typo to anyone checking the six for consistency.
 */
describe("the trash-restore line is ruled bare, unlike the six", () => {
	it("the approved sentence has no trailing period, and ends in the path", () => {
		expect(TRASH_SENTENCE.endsWith(".")).toBe(false);
		// The reason, asserted rather than asserted-about: the last thing in the
		// sentence is the restored file's path.
		expect(TRASH_SENTENCE.endsWith(`${HOME}/${PAGE_ID}.json`)).toBe(true);
	});

	it("the INTERNAL period stays: it separates the two sentences", () => {
		// Never reversed - "yes that's fine good call" (2026-09-09 17:18 CDT).
		expect(TRASH_SENTENCE).toContain("from trash. the file is at");
	});

	it("DRIVEN: the notice the plugin actually emits ends bare", async () => {
		const { open } = rig(seedTrash);
		await open();

		const line = notices.messages.find(isTrashNotice);
		expect(line, "no trash-restore notice was emitted at all").toBeDefined();
		// Not a claim about the constant - about the string a user would read.
		expect(line!.endsWith(".")).toBe(false);
		expect(line).toBe(TRASH_SENTENCE);
	});
});
