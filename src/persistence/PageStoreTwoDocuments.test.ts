/**
 * B1 — TWO IN-PROCESS WRITERS, ONE PAGE ID. One `PageStore`, two pages composed
 * independently from the same bytes, one pageId.
 *
 * THE ARRANGEMENT IS A SHIPPED ONE, not an invented wiring. `main.ts` builds
 * ONE `PageStore` and hands it to every surface. A surface that shares its
 * model — notes (`InlineInkStore`) and PDFs (`PdfInkStore`) share the strokes
 * themselves — has one writer per page id and cannot collide with itself. A
 * surface that shares the WRITER and not the MODEL composes its own page per
 * holder, and two holders then both reach `store.schedule(pageId, ownPage)`
 * while `PageStore.schedule` does `pending.set(pageId, data)`: last writer
 * wins, and the loser's strokes are gone. That is the collision reproduced and
 * fixed here, and it is the store's rule, not any one surface's.
 *
 * WHERE THIS CAME FROM. The case was found on the canvas page view, which held
 * one document per pane. That view was deleted. The store rule it
 * exposed is untouched and is what these cases drive; the one claim that could
 * only be made about the view is listed by name in the removal evidence.
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
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT. It proves what the store does
 * when two identified writers save one page id: without the fix the second
 * one's save destroys the first's strokes, with no conflict copy, no callback
 * and no error; with it the store reads the live file back and unions them. It
 * does NOT prove that any particular surface really opens two holders on one
 * file — that is a claim about a host, and nothing here establishes it. Each
 * holder below does exactly what a surface does: `store.load` on open, then
 * `page.strokes.push(...)` and `store.schedule(pageId, page, writer)` on a
 * stroke.
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
import { PageData, emptyPage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";
import mainSource from "../main.ts?raw";
import { codeOnly } from "../CodeOnly";

/**
 * The shipped surface's CODE, without the shipped surface's prose.
 *
 * The last test in this file reads production source as text, and its own
 * comment says it took "the `?raw` idiom StripPenChrome.test.ts established" -
 * it inherited the idiom and it inherited the hole with it. A
 * file read as text is a document: it carries the schedule calls and the
 * paragraphs about the schedule calls, and a regex cannot tell them apart.
 *
 * Demonstrated on this branch rather than argued. Both real sites were moved
 * behind a helper and the old lines left behind as `// was: …` comments - the
 * ordinary way a refactor leaves a file. The view then had ZERO schedule sites
 * and passed no writer identity anywhere, and the assertion below still found
 * two calls, both "carrying" `this.writer`, and passed. So did the whole suite.
 * Its anti-vacuity guard - "a rename or a refactor that voided this regex
 * fails here rather than silently asserting nothing" - was the assertion the
 * comments propped up, which is the worst one to lose.
 *
 * `codeOnly` (src/CodeOnly.ts) is the shared stripper, imported not copied.
 * Counting code can only find FEWER call sites, so no real site stops being
 * checked; what stops being counted is a call that was only ever a sentence.
 */
const mainCode = codeOnly(mainSource);

/** The writer token `startSlidesInk` makes once, quoted as production spells it. */
const SLIDES_WRITER = 'newPageWriter("slides")';

/** Every schedule/saveNow call in a piece of source, comments excluded. */
function scheduleCalls(src: string): string[] {
	return codeOnly(src).match(/store\.(?:schedule|saveNow)\([^)]*\)/g) ?? [];
}

const PAGE_ID = "p1";
const FINAL = ".handwriting/p1.json";
const TMP_WRITE = "write .handwriting/p1.json.tmp";

/** Stroke ids, chosen so a raw `toContain` on the serialized sidecar is unambiguous. */
const SEED_INK = "seed-stroke";
const A_INK = "pane-A-stroke";
const B_INK = "pane-B-stroke";

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
 * One open holder: its own page, and its own writer identity.
 *
 * The identity is the FIX's half, and is passed here for the same reason a
 * surface passes it - one token per holder, for the life of the holder.
 * Without it the store has nothing to tell two holders apart with:
 * `knownMtime`/`knownHash` are one pair per pageId and `store.load` stamps
 * them too, so holder B's OPEN below re-stamps the store exactly as holder A's
 * write did. That a shipped surface really passes one is asserted separately,
 * from production source, in "the shipped surface carries a writer identity"
 * below - otherwise this file could go green over a plugin whose surfaces had
 * never been fixed.
 */
interface Pane {
	page: PageData;
	writer: PageWriter;
}

/**
 * What a surface does on open: `store.load`. Each call parses the file again,
 * so the two holders below hold the same bytes as two separate models - which
 * is the arrangement under test, not a convenience.
 */
async function openPane(): Promise<Pane> {
	const result = await store.load(PAGE_ID);
	return { page: result?.data ?? emptyPage(PAGE_ID), writer: newPageWriter("pane") };
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

	// Two holders of one file. Same store, one page each.
	const paneA = await openPane();
	const paneB = await openPane();

	// A draws. Push BEFORE scheduling: `pending` keeps this very array.
	paneA.page.strokes.push(strokeNamed(A_INK));
	store.schedule(PAGE_ID, paneA.page, paneA.writer);

	if (regime === "separated") await settle();
	else await vi.advanceTimersByTimeAsync(100);
	const afterA = fake.files.get(FINAL);

	// B writes, carrying B's own page — which never saw A's stroke. In a
	// shipped surface this needs no drawing in B at all: any edit that reaches
	// every open holder ends in a save. A stroke is simply the shortest way to
	// make B's page differ here.
	paneB.page.strokes.push(strokeNamed(B_INK));
	store.schedule(PAGE_ID, paneB.page, paneB.writer);
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

describe("one store, two holders, one pageId — two in-process writers", () => {
	it("the harness holds: both panes load the seeded ink, and A's write lands on disk", async () => {
		// This is the setup proof for the `it.fails` below, kept in its own
		// green test on purpose: `it.fails` passes on ANY error, so a harness
		// that broke would hide the reproduction rather than report it.
		await seed();
		expect(fake.files.get(FINAL)).toContain(SEED_INK);

		const paneA = await openPane();
		const paneB = await openPane();
		// Separate models: the same bytes parsed twice, not one shared array.
		expect(paneA.page).not.toBe(paneB.page);
		// And separate identities, which is what the store now reconciles on.
		expect(paneA.writer).not.toBe(paneB.writer);
		expect(paneA.page.strokes.map((s) => s.id)).toEqual([SEED_INK]);
		expect(paneB.page.strokes.map((s) => s.id)).toEqual([SEED_INK]);

		paneA.page.strokes.push(strokeNamed(A_INK));
		store.schedule(PAGE_ID, paneA.page, paneA.writer);
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
		// acceptance criterion for B1. If it ever reads `it.fails` again, a
		// two-holder surface is losing ink.
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
		// ink. Holder A erases s2 and saves; holder B still shows s2 (a surface
		// with no cross-holder fan-out, which is this same defect) and saves;
		// s2 comes back.
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

	it("audit 125: a retired writer no longer claims the file, so the next writer's erase is not merged back", async () => {
		const a = newPageWriter("slides");
		store.schedule(PAGE_ID, pageWith("s1", "s2"), a);
		await settle();
		store.retireWriter(a); // slides ink switched off
		const b = newPageWriter("slides"); // ...and on again
		store.schedule(PAGE_ID, pageWith("s1"), b); // erase s2, close quickly
		await settle();
		expect(fake.files.get(FINAL)).toContain("s1");
		expect(fake.files.get(FINAL)).not.toContain("s2");
	});

	it("audit 125: a save of the retired writer that lands AFTER the retire does not claim the file either", async () => {
		const a = newPageWriter("slides");
		store.schedule(PAGE_ID, pageWith("s1", "s2"), a);
		store.retireWriter(a); // still inside the debounce: the write has not landed
		await settle();
		expect(fake.files.get(FINAL)).toContain("s2"); // it did land
		const b = newPageWriter("slides");
		store.schedule(PAGE_ID, pageWith("s1"), b);
		await settle();
		expect(fake.files.get(FINAL)).not.toContain("s2");
	});

	it("audit 125: switching slides ink off retires the writer it made (main.ts wiring)", () => {
		expect(mainCode).toMatch(/setSlidesInk\(false\);[\s\S]{0,200}this\.store\.retireWriter\(this\.slidesWriter\)/);
		expect(mainCode).toContain("this.slidesWriter = writer;");
	});

	it("audit 125: a writer that is NOT retired is still reconciled (the known cost above stands)", async () => {
		const a = newPageWriter("pane-a");
		const b = newPageWriter("pane-b");
		store.schedule(PAGE_ID, pageWith("s1", "s2"), a);
		await settle();
		store.schedule(PAGE_ID, pageWith("s1"), b);
		await settle();
		expect(fake.files.get(FINAL)).toContain("s2");
	});

	it("the shipped surface carries a writer identity at every schedule site", async () => {
		// THE GAP THIS CLOSES. Every test above hands the store an identity of
		// its own making, so they would all stay green over a plugin whose
		// surfaces still called `schedule` with two arguments - the fix would
		// be present in the store and absent from the surface that needs it.
		// Slides is that surface after the removal: one deck, its own composed page
		// per sidecar id, and a writer token made once in `startSlidesInk`.
		// Read from production source instead, in the `?raw` idiom
		// StripPenChrome.test.ts established - but from its CODE, not its
		// text. See the note on `mainCode` at the top of this file: read raw,
		// this assertion was satisfied by comments over a surface that had
		// stopped scheduling altogether.
		expect(mainCode).toContain(SLIDES_WRITER);
		const calls = scheduleCalls(mainSource).filter((c) => c.includes("sidecarId"));
		// Anti-vacuity: the surface really does schedule sidecars, so a rename
		// or a refactor that voided this regex fails here rather than silently
		// asserting nothing. This is the half comments used to prop up.
		expect(calls.length).toBeGreaterThanOrEqual(2);
		expect(calls.filter((c) => !c.includes("writer"))).toEqual([]);
	});
});

/**
 * Fixtures over the scanner, so the assertion above is evidence rather than a
 * coincidence, and so the defeat is pinned in a form nobody has to reconstruct.
 */
describe("the source scan reads schedule calls, not sentences about them", () => {
	const REAL = "\t\tthis.host.store.schedule(this.pageId, this.page, this.writer);\r\n";

	it("finds a real schedule call and keeps its arguments", () => {
		expect(scheduleCalls(REAL)).toEqual(["store.schedule(this.pageId, this.page, this.writer)"]);
	});

	it("still catches a real call that dropped the writer identity", () => {
		// The assertion's original job, unchanged. Reading code must not have
		// cost it anything.
		const dropped = "\t\tthis.host.store.schedule(this.pageId, this.page);\r\n";
		expect(scheduleCalls(dropped).filter((c) => !c.includes("this.writer"))).toHaveLength(1);
	});

	it("does NOT count a call that survives only as a comment", () => {
		// THE DEFEAT, verbatim: the shape a refactor leaves behind.
		const moved = `\t\t// moved to the shared persist helper; was:\r\n\t\t//   this.host.store.schedule(this.pageId, this.page, this.writer)\r\n\t\tthis.host.persistPage(this.pageId, this.page);\r\n`;
		expect(scheduleCalls(moved)).toEqual([]);
	});

	it("does NOT let a doc comment supply the writer field either", () => {
		const explained = `\t/**\r\n\t * Every save goes through ${SLIDES_WRITER}.\r\n\t */\r\n`;
		expect(codeOnly(explained)).not.toContain("newPageWriter(");
	});
});
