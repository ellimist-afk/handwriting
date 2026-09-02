/**
 * B1 — CANVAS DATA LOSS, REPRODUCED. One `PageStore`, two `PageDocument`s, one
 * pageId. A reproduction only: nothing here is fixed, and one test is knowingly
 * red (see THE KNOWN-FAILING IDIOM below).
 *
 * THE ARRANGEMENT IS THE SHIPPED TOPOLOGY, not an invented wiring. `main.ts`
 * builds ONE `PageStore` and hands it to every view through
 * `HandwritingHost.store`, while each `HandwritingPageView` holds its OWN
 * `PageDocument` (its `doc` field, replaced in `openFrom`/`clear`). So the
 * canvas shares the WRITER and not the MODEL — unlike notes (`InlineInkStore`)
 * and PDFs (`PdfInkStore`), which share the strokes themselves. Two panes on one
 * canvas page therefore both reach `store.schedule(pageId, ownPage)` with their
 * own composed page, and `PageStore.schedule` does `pending.set(pageId, data)`:
 * last writer wins, and the loser's strokes are gone.
 *
 * THE GUARD IS THE MECHANISM, NOT A MITIGATION. `writeNow`'s external-revision
 * guard computes `external` from `st.mtime !== knownMtime`, then compares
 * `contentStamp(current)` to `knownHash` — and this same store set BOTH right
 * after its own rename. One store in the process means the second in-process
 * writer looks like the same session: `external` stays false and no `.conflict-`
 * copy is taken. The guard's own comment states its question — "the file on disk
 * is not the one this session last read or wrote" — and a second in-process
 * writer IS the same session. It answers its own question correctly and the
 * wrong question silently.
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT. It proves that the
 * store-and-document layer loses data when driven this way: a second document
 * scheduling its own page under the same id destroys the first document's
 * strokes, with no conflict copy, no callback and no error. It does NOT prove
 * that Obsidian instantiates two `HandwritingPageView`s for one file in a split.
 * That is well supported by `onLoadFile`'s leaf-reuse handling, but it is a
 * claim about the host, and nothing here establishes it. `HandwritingPageView`
 * is not practically constructible in a test (canvases, a `PointerRouter`, a
 * `TextLayer`), so no call below routes through the view; instead every call is
 * one the view makes verbatim — `store.load` then `applySidecar` on open
 * (`loadPage`), and `page.strokes.push(...)` then
 * `store.schedule(this.pageId, this.page)` on a stroke (`saveSpatial` →
 * `scheduleSidecar`).
 *
 * THE SEED IS LOAD-BEARING — THOUGH NOT FOR THE REASON THE DESIGN PREDICTED.
 * Every scenario starts with one write from this same store, settled, so
 * `knownMtime` and `knownHash` describe the file on disk before either pane
 * opens: the state a real session is in by the time a second pane exists. The
 * 1.4.7 design expected that without it the guard would take a conflict copy and
 * the file would go "falsely green in a way that makes the defect look
 * self-healing". Measured against this code, it does not. Both alternatives were
 * run, and the loss reproduces in every one of them:
 *   - with no seed AND no sidecar on disk, A's write CREATES the file, so the
 *     guard's `exists(final)` branch never runs at all; B then overwrites, and
 *     no conflict copy is taken — the same loss as below;
 *   - with the sidecar seeded BEHIND the store's back (bytes this store never
 *     wrote), A's write DOES take a conflict copy — of the SEED, from before A
 *     had drawn anything — and B's write then destroys A's stroke with no
 *     second copy. The loss reproduces there too. Only the supporting
 *     `.conflict-` assertion below would flip, and it would flip MISLEADINGLY:
 *     it would read as though the guard had answered the two-pane collision,
 *     when it had merely rescued a file it did not recognise.
 * So the seed is what keeps the guard assertion honest. It is not what makes the
 * defect appear, and the defect does not self-heal without it.
 *
 * THE PAGE HANDED TO `schedule` IS A LIVE REFERENCE, not a snapshot: `pending`
 * holds `doc.page` itself. So each step's strokes are pushed BEFORE its
 * `schedule` call. Pushing afterwards would let the payload mutate under the
 * queue and the file would report a mechanism it never exercised.
 *
 * THE KNOWN-FAILING IDIOM. The repo had none — no `it.fails`, `it.skip` or
 * `todo` anywhere in `src/` before this file. `it.fails` is the choice, because
 * it keeps the assertion executing and stated in its TRUE form ("A's stroke is
 * still on disk"), records that today it does not hold, and turns RED the moment
 * a fix makes it hold, so the fixer must come back here. `it.skip` was rejected:
 * a skipped test proves nothing and rots silently. The known cost of `it.fails`
 * is that it passes if ANY error escapes the body, including a broken harness
 * (P3, a harness that cannot fail) — so the setup it depends on is asserted
 * separately, in the first test below, from the same helper. Break the harness
 * and that one goes red.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore, PageWriter, newPageWriter } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageDocument } from "../model/PageDocument";
import { PageData, emptyPage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";
import viewSource from "../view/HandwritingPageView.ts?raw";

const PAGE_ID = "p1";
const FINAL = ".handwriting/p1.json";
const TMP_WRITE = "write .handwriting/p1.json.tmp";
const WIDTH = 320;

/** Stroke ids, chosen so a raw `toContain` on the serialized sidecar is unambiguous. */
const SEED_INK = "seed-stroke";
const A_INK = "pane-A-stroke";
const B_INK = "pane-B-stroke";

/** A canvas page as it sits on disk: no `surface` field (absent = free world space). */
function markdown(): string {
	return [
		"---",
		"handwriting: page",
		"handwriting-version: 1",
		`handwriting-page-id: ${PAGE_ID}`,
		"---",
		"",
		"<!-- handwriting:textbox id=tb-1 -->",
		"first",
		"<!-- /handwriting:textbox -->",
		"",
	].join("\n");
}

function strokeNamed(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 0 },
		createdAt: 0,
	};
}

let fake: FakeAdapter;
let store: PageStore;

beforeEach(() => {
	vi.useFakeTimers();
	// `schedule` arms `window.setTimeout`; there is no DOM in this suite.
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	store = new PageStore({ vault: { adapter: fake } });
});

afterEach(() => {
	vi.useRealTimers();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2000);
}

function completedTmpWrites(): number {
	return fake.log.filter((l) => l.startsWith(TMP_WRITE)).length;
}

/**
 * One write from THIS store, settled, so `knownMtime` and `knownHash` describe
 * the file on disk. See THE SEED IS LOAD-BEARING in the header.
 */
async function seed(): Promise<void> {
	const first = emptyPage(PAGE_ID);
	first.strokes.push(strokeNamed(SEED_INK));
	store.schedule(PAGE_ID, first);
	await settle();
}

/**
 * One open pane: its own `PageDocument`, and its own writer identity.
 *
 * The identity is the FIX's half of the shipped topology, and is passed here
 * for the same reason `HandwritingPageView` passes it - one token per view, for
 * the life of the view. Without it the store has nothing to tell two panes
 * apart with: `knownMtime`/`knownHash` are one pair per pageId and `store.load`
 * stamps them too, so pane B's OPEN below re-stamps the store exactly as pane
 * A's write did. That the shipped view really passes one is asserted
 * separately, from its source, in "the shipped canvas view carries a writer
 * identity" below - otherwise this file could go green over a plugin whose view
 * had never been fixed.
 */
interface Pane {
	doc: PageDocument;
	writer: PageWriter;
}

/** What a view does on open: `store.load`, then `applySidecar` (`loadPage`). */
async function openPane(): Promise<Pane> {
	const doc = new PageDocument();
	const parsed = doc.loadMarkdown(markdown());
	const result = await store.load(doc.pageId);
	doc.applySidecar(result?.data, parsed.blocks, parsed.images, WIDTH);
	return { doc, writer: newPageWriter("pane") };
}

/**
 * Regime (b) — `separated` — leaves more than the 700 ms debounce between the
 * two schedules, so A's write completes and B overwrites a durable file.
 * Regime (a) — `overlapping` — puts both inside the window, so B replaces A's
 * payload in `pending` and cancels A's timer before A ever reaches the adapter.
 */
type Regime = "separated" | "overlapping";

interface Collision {
	/** The sidecar between the two schedules. */
	afterA: string | undefined;
	/** The sidecar once everything has settled. */
	afterB: string | undefined;
	/** Any `.conflict-` copy the guard took, by path. */
	conflictFiles: string[];
	/** Anything the store announced through `onConflict`. */
	conflictCalls: string[];
	/** Writes that ENTERED the adapter after the seed, successful or not. */
	writeAttempts: number;
	/** Completed tmp writes after the seed. */
	tmpWrites: number;
}

/** Two panes on one canvas page: A draws, then B writes. */
async function collide(regime: Regime): Promise<Collision> {
	await seed();
	const attemptsBefore = fake.writeAttempts;
	const tmpBefore = completedTmpWrites();
	const conflictCalls: string[] = [];
	store.onConflict = (_id, keptAs) => conflictCalls.push(keptAs);

	// Two views of one file. Same store, one `PageDocument` each.
	const paneA = await openPane();
	const paneB = await openPane();

	// A draws. Push BEFORE scheduling: `pending` keeps this very array.
	paneA.doc.page.strokes.push(strokeNamed(A_INK));
	store.schedule(paneA.doc.pageId, paneA.doc.page, paneA.writer);

	if (regime === "separated") await settle();
	else await vi.advanceTimersByTimeAsync(100);
	const afterA = fake.files.get(FINAL);

	// B writes, carrying B's own page — which never saw A's stroke. In the
	// shipped plugin this needs no drawing in B at all: Obsidian's text push
	// reaches every open view and the reconcile branch ends in `saveSpatial()`
	// whenever containers changed. A stroke is simply the shortest way to make
	// B's page differ here.
	paneB.doc.page.strokes.push(strokeNamed(B_INK));
	store.schedule(paneB.doc.pageId, paneB.doc.page, paneB.writer);
	await settle();

	return {
		afterA,
		afterB: fake.files.get(FINAL),
		conflictFiles: [...fake.files.keys()].filter((p) => p.includes(".conflict-")),
		conflictCalls,
		writeAttempts: fake.writeAttempts - attemptsBefore,
		tmpWrites: completedTmpWrites() - tmpBefore,
	};
}

describe("one store, two documents, one pageId — the shipped canvas topology", () => {
	it("the harness holds: both panes load the seeded ink, and A's write lands on disk", async () => {
		// This is the setup proof for the `it.fails` below, kept in its own
		// green test on purpose: `it.fails` passes on ANY error, so a harness
		// that broke would hide the reproduction rather than report it.
		await seed();
		expect(fake.files.get(FINAL)).toContain(SEED_INK);

		const paneA = await openPane();
		const paneB = await openPane();
		expect(paneA.doc.pageId).toBe(PAGE_ID);
		expect(paneB.doc.pageId).toBe(PAGE_ID);
		// Separate models: the same bytes parsed twice, not one shared array.
		expect(paneA.doc.page).not.toBe(paneB.doc.page);
		// And separate identities, which is what the store now reconciles on.
		expect(paneA.writer).not.toBe(paneB.writer);
		expect(paneA.doc.strokes.map((s) => s.id)).toEqual([SEED_INK]);
		expect(paneB.doc.strokes.map((s) => s.id)).toEqual([SEED_INK]);

		paneA.doc.page.strokes.push(strokeNamed(A_INK));
		store.schedule(paneA.doc.pageId, paneA.doc.page, paneA.writer);
		await settle();
		expect(fake.files.get(FINAL)).toContain(A_INK);
	});

	it("regime (b): A's write is durable on disk right up until B writes", async () => {
		const c = await collide("separated");
		// Pins the timing: A really did reach the platform, so what follows is
		// an overwrite of a durable file, not a race that never started.
		expect(c.afterA).toContain(A_INK);
		expect(c.tmpWrites).toBe(2);
		expect(c.afterB).toContain(B_INK);
	});

	it("B1 FIXED: A's stroke survives B's write", async () => {
		const c = await collide("separated");
		// The whole defect in one line, and now the whole fix. B's page was
		// composed before A drew, so B's save still carries stale strokes -
		// but the store knows a DIFFERENT in-process writer wrote the live
		// file, reads it back, and unions the two before serializing. Nothing
		// A drew is dropped.
		//
		// This was `it.fails` from d6094dd until the fix landed, and it is the
		// acceptance criterion for B1. If it ever reads `it.fails` again, the
		// canvas is losing ink.
		expect(c.afterB).toContain(A_INK);
	});

	it("the sidecar ends holding BOTH panes' state, in the one live file", async () => {
		const c = await collide("separated");
		// The full end state, stated positively so the outcome is legible
		// without reading a failure. Until the fix this test asserted the
		// OPPOSITE - `not.toContain(A_INK)`, and no copy of A anywhere on disk -
		// because it was written to make the defect legible. It is inverted
		// rather than deleted: it and the assertion above are the pair that
		// says the behaviour here changed deliberately.
		expect(c.afterB).toContain(SEED_INK);
		expect(c.afterB).toContain(B_INK);
		expect(c.afterB).toContain(A_INK);
		// And in the LIVE sidecar, not rescued into a sibling the user has to
		// go and find: exactly one file on disk holds A's stroke, and it is the
		// one the next open reads.
		const survivors = [...fake.files.entries()]
			.filter(([, text]) => text.includes(A_INK))
			.map(([path]) => path);
		expect(survivors).toEqual([FINAL]);
	});

	it("no .conflict- copy is taken, and the fix does not start taking one", async () => {
		const c = await collide("separated");
		// The external guard still cannot see this collision, and is not asked
		// to: `knownMtime` and `knownHash` both describe A's file because THIS
		// store wrote it, so `external` stays false. It answers its own
		// question correctly; the reconcile answers the other one.
		//
		// This test reads the same as it did before the fix, for the opposite
		// reason - then nothing WAS preserved, now nothing NEEDS preserving.
		// Routing the collision through the conflict branch instead would have
		// satisfied "no silent loss" too, and would have started dropping
		// `.conflict-` files into vaults where a split view is ordinary. It is
		// asserted rather than left implicit because that was a real choice.
		expect(c.afterB).toContain(B_INK);
		expect(c.afterB).toContain(A_INK);
		expect(c.conflictFiles).toEqual([]);
		expect(c.conflictCalls).toEqual([]);
	});

	it("regime (a): inside the debounce, A's queued batch is dispatched, not dropped", async () => {
		const c = await collide("overlapping");
		// KEPT AS ITS OWN CASE, deliberately. Both regimes end the same way,
		// but the MECHANISMS differ and only this one exercises the
		// schedule-side half of the fix. Before it, `schedule` replaced A's
		// payload in `pending` and `clearTimeout` cancelled A's timer, so A's
		// bytes were never handed to the platform and no later reconcile could
		// recover them - by write time the only record that they existed was
		// gone. The write-side union alone leaves this regime lossy.
		//
		// Now a foreign writer's queued batch is dispatched rather than
		// replaced, so both payloads reach disk and meet there. Two writes
		// after the seed where there was one.
		expect(c.writeAttempts).toBe(2);
		expect(c.tmpWrites).toBe(2);
		// A's write is triggered BY B's schedule, which has not happened when
		// `afterA` is sampled 100 ms in - so this pair is unchanged by the fix
		// and still pins that the two schedules really were inside one window.
		expect(c.afterA).toContain(SEED_INK);
		expect(c.afterA).not.toContain(A_INK);
		expect(c.afterB).toContain(B_INK);
		expect(c.afterB).toContain(A_INK);
		// Same end state as regime (b), and no conflict copy in either.
		expect(c.conflictFiles).toEqual([]);
	});
});

describe("the reconcile is per WRITER, and only ever adds", () => {
	/** A page composed by one writer, from the ids it should hold. */
	function pageWith(...ids: string[]): PageData {
		const page = emptyPage(PAGE_ID);
		for (const id of ids) page.strokes.push(strokeNamed(id));
		return page;
	}

	it("one writer's rapid saves still collapse to a single write of the newest state", async () => {
		// The invariant PageStore.test.ts pins for the unidentified caller,
		// re-pinned for an identified one. The collapse is what makes the
		// two-pane loss possible, so making it per-writer must not switch it
		// off for the case it is right for: one pane, three strokes, one write.
		const w = newPageWriter("solo");
		store.schedule(PAGE_ID, pageWith("s1"), w);
		store.schedule(PAGE_ID, pageWith("s1", "s2"), w);
		store.schedule(PAGE_ID, pageWith("s1", "s2", "s3"), w);
		await settle();
		expect(completedTmpWrites()).toBe(1);
		expect(fake.files.get(FINAL)).toContain("s3");
	});

	it("one writer's DELETE is honoured: the reconcile never runs against itself", async () => {
		// The anti-resurrection guard, and the reason the reconcile is keyed on
		// writer identity rather than on content. A single pane erasing a
		// stroke composes a page that LACKS it, which is indistinguishable from
		// a stale page by content alone - so a store that merged on content
		// would make the eraser stop working. Same writer, no merge.
		const w = newPageWriter("solo");
		store.schedule(PAGE_ID, pageWith("s1", "s2"), w);
		await settle();
		expect(fake.files.get(FINAL)).toContain("s2");
		store.schedule(PAGE_ID, pageWith("s1"), w);
		await settle();
		expect(fake.files.get(FINAL)).toContain("s1");
		expect(fake.files.get(FINAL)).not.toContain("s2");
	});

	it("an UNIDENTIFIED writer is never reconciled: notes and pdfs are untouched", async () => {
		// `InlineInkStore` and `PdfInkStore` share their model, so they have no
		// second in-process writer to reconcile with and pass no identity. An
		// undefined identity must therefore behave exactly as it did: last
		// write wins, delete deletes.
		store.schedule(PAGE_ID, pageWith("s1", "s2"));
		await settle();
		store.schedule(PAGE_ID, pageWith("s1"));
		await settle();
		expect(fake.files.get(FINAL)).toContain("s1");
		expect(fake.files.get(FINAL)).not.toContain("s2");
	});

	it("THE KNOWN COST: a delete by one pane is undone by the other pane's stale save", async () => {
		// Pinned rather than left to be discovered. Two panes, no shared model
		// and no version vector, so "deleted" and "never seen" are the same
		// page to the store, and the union resolves both toward keeping the
		// ink. Pane A erases s2 and saves; pane B still shows s2 (there is no
		// cross-pane fan-out on the canvas, which is this same defect) and
		// saves; s2 comes back.
		//
		// Not a regression: the UNFIXED code resurrects it too, because B's
		// page still carries it and B's page becomes the file wholesale. The
		// merge only ever adds to what today's code writes, so no reachable
		// case loses something that used to survive.
		const a = newPageWriter("pane-a");
		const b = newPageWriter("pane-b");
		store.schedule(PAGE_ID, pageWith("s1", "s2"), a);
		await settle();
		store.schedule(PAGE_ID, pageWith("s1"), a); // A erases s2
		await settle();
		expect(fake.files.get(FINAL)).not.toContain("s2");
		store.schedule(PAGE_ID, pageWith("s1", "s2"), b); // B never saw the erase
		await settle();
		expect(fake.files.get(FINAL)).toContain("s2");
	});

	it("the shipped canvas view carries a writer identity at every schedule site", async () => {
		// THE GAP THIS CLOSES. Every test above hands the store an identity of
		// its own making, because `HandwritingPageView` is not constructible
		// here (canvases, a `PointerRouter`, a `TextLayer`). So they would all
		// stay green over a plugin whose view still called `schedule` with two
		// arguments - the fix would be present in the store and absent from the
		// only surface that needs it. Read from the view's source instead, in
		// the `?raw` idiom StripPenChrome.test.ts established.
		expect(viewSource).toContain("newPageWriter(");
		const calls = viewSource.match(/store\.(?:schedule|saveNow)\([^)]*\)/g) ?? [];
		// Anti-vacuity: the view really does schedule sidecars, so a rename or
		// a refactor that voided this regex fails here rather than silently
		// asserting nothing.
		expect(calls.length).toBeGreaterThanOrEqual(2);
		expect(calls.filter((c) => !c.includes("this.writer"))).toEqual([]);
	});
});
