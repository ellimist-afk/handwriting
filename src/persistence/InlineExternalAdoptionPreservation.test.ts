/**
 * INLINE EXTERNAL ADOPTION MUST NOT DESTROY THE OUTGOING REVISION.
 *
 * The loss, in one line: a sidecar replaced by another device was adopted by
 * rebuilding the record from disk, and that rebuild also moved the save
 * baseline to the incoming file - so the revision this device held stopped
 * existing anywhere, silently.
 *
 * `mergePages` is NOT the fix and is deliberately not called. Its own docstring
 * says this layer cannot distinguish a stroke the other device DELETED from one
 * it never SAW, and across devices offline for hours the second case is
 * ordinary. A blind union would resurrect real deletions - the intentional
 * delete control below is the red against exactly that.
 *
 * So the guarantee this suite pins is narrower and stronger: BOTH revisions
 * become independently recoverable siblings BEFORE either is released, and the
 * live synced file is never rewritten. It does NOT make the two converge, and
 * nothing here claims it does.
 *
 * WHAT THIS SUITE CANNOT PROVE, stated so no reader borrows more than it has:
 * it runs on an in-memory adapter. There is no Syncthing, no atomic replace, no
 * preserved-mtime delivery, no real device, no closed application. "Durable"
 * here means the adapter write resolved, the bytes read back identical, and the
 * artifact parsed on its own - not fsync and not power loss.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore, PageAdapterLike, contentStamp } from "./PageStore";
import { FakeAdapter, gate } from "./FakeAdapter";
import {
	ADOPTION_QUIET_MS,
	ADOPTION_STILL_FAILING,
	InlineInkStore,
} from "../inline/InlineInkStore";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";
import { installLiveReloadPoll } from "../testUtils/LiveReloadTestHarness";

const DEBOUNCE_MS = 700;
const PATH = "note.md";
const PAGE_ID = "p1";
const LIVE = ".handwriting/p1.json";

/** The sibling shape the contract fixes: `.conflict-`, random token, two legs. */
const PAIR_NAME = /^\.handwriting\/p1\.conflict-external-[0-9a-f]{16}-(outgoing|incoming)\.json$/;

/**
 * Where the outgoing artifact carries its exact, unrounded capture. Written as
 * a literal here ON PURPOSE: this key is part of the artifact's ON-DISK format,
 * which is what a recovery tool reads, so the test pins it rather than
 * importing whatever production currently calls it. It also lets these cases
 * compile and run against the uncorrected object, which is how they red.
 */
const EXACT_KEY = "handwriting:exactOutgoing";

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 1, y: 2, pressure: 0.5, t: 0 },
			{ x: 11, y: 6, pressure: 0.5, t: 8 },
		],
		bbox: { x: 1, y: 2, width: 10, height: 4 },
		createdAt: 0,
	};
}

/**
 * A page carrying every kind of content the contract names: strokes in a
 * defined order, a text box, an image, and unknown fields at both levels - the
 * fields written by a build we do not have, which a lossy copy would drop
 * silently and which nobody would notice until that build read the file again.
 */
function page(strokeIds: string[], pageId = PAGE_ID): PageData {
	const p = emptyPage(pageId);
	p.surface = "inline";
	p.textBoxes = [{ id: "tb1", x: 12, y: 34, width: 200, z: 1 }];
	p.images = [{ id: "im1", x: 5, y: 6, width: 100, height: 80, z: 2 }];
	p.strokes = strokeIds.map(stroke);
	p.unknownTop = { futureTopField: { note: "written by a newer build" } };
	p.unknownByObject = {
		tb1: { futureBoxField: 11 },
		im1: { futureImageField: "keep me" },
		...Object.fromEntries(strokeIds.map((id) => [id, { futureStrokeField: `${id}-extra` }])),
	};
	return p;
}

/** Serialized bytes for a page, as another device would have written them. */
function bytes(strokeIds: string[], pageId = PAGE_ID): string {
	return serializePage(page(strokeIds, pageId));
}

let fake: FakeAdapter;

/**
 * An adapter that delegates to the fake and can fail or pause one named
 * operation. Test-only and local to this file: the production adapter is
 * untouched, and every hook is expressed as "this exact path, this exact op",
 * so a failure injected for the second artifact cannot land on the first.
 */
interface Hooks {
	exists?: (path: string) => Promise<boolean | undefined> | boolean | undefined;
	failWrite?: (path: string) => boolean;
	failRead?: (path: string) => boolean;
	beforeWrite?: (path: string) => Promise<void> | void;
	afterWrite?: (path: string) => Promise<void> | void;
	beforeRead?: (path: string) => Promise<void> | void;
}

function hooked(base: FakeAdapter, hooks: Hooks): PageAdapterLike {
	return {
		async exists(p) {
			const override = await hooks.exists?.(p);
			return override === undefined ? base.exists(p) : override;
		},
		async read(p) {
			await hooks.beforeRead?.(p);
			if (hooks.failRead?.(p)) throw new Error(`EIO injected read ${p}`);
			return base.read(p);
		},
		async write(p, d) {
			await hooks.beforeWrite?.(p);
			if (hooks.failWrite?.(p)) throw new Error(`EIO injected write ${p}`);
			await base.write(p, d);
			await hooks.afterWrite?.(p);
		},
		rename: (a, b) => base.rename(a, b),
		remove: (p) => base.remove(p),
		mkdir: (p) => base.mkdir(p),
		stat: (p) => base.stat(p),
	};
}

interface Device {
	store: PageStore;
	ink: InlineInkStore;
	notices: string[];
	/** What was true at the exact instant the baseline was acknowledged. */
	atAccept: Array<{
		outgoingOnDisk: string | undefined;
		incomingOnDisk: string | undefined;
		visibleIds: string[];
		noticesSoFar: number;
	}>;
	accepts: number;
}

/**
 * ONE DEVICE: its own PageStore and its own InlineInkStore over the shared
 * vault. Two of these is what the contract means by two devices - not two
 * writers sharing one store, which is a different bug with a different fix
 * (reconcileInProcess) and would prove nothing about this one.
 *
 * `route: false` builds a host WITHOUT the preservation pair, which is the
 * sensitivity control: identical production code with only the new route
 * unavailable.
 */
function device(
	adapter: PageAdapterLike,
	route = true,
	pageIds: Record<string, string> = { [PATH]: PAGE_ID }
): Device {
	const store = new PageStore({ vault: { adapter } } as never, ".handwriting", () => 5_000_000);
	const ink = new InlineInkStore();
	const notices: string[] = [];
	const d: Device = { store, ink, notices, atAccept: [], accepts: 0 };
	ink.attachHost({
		readPageId: (p: string) => pageIds[p] ?? null,
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: (id: string) => store.load(id),
		scheduleSidecar: (id: string, p: PageData) => store.schedule(id, p),
		scheduleSidecarNow: (id: string, p: PageData) => store.saveNow(id, p),
		...(route
			? {
					prepareExternalAdoption: (id: string, outgoing: PageData) =>
						store.prepareExternalAdoption(id, outgoing),
					acceptExternalAdoption: (prepared: never) => {
						// Observed BEFORE the record swaps and before any notice:
						// acceptance is the instant the incoming revision becomes
						// the baseline, so everything the contract requires to be
						// already true must be true here.
						const p = prepared as unknown as {
							outgoingPath: string;
							incomingPath: string;
						};
						d.accepts++;
						d.atAccept.push({
							outgoingOnDisk: fake.files.get(p.outgoingPath),
							incomingOnDisk: fake.files.get(p.incomingPath),
							visibleIds: ink.strokes(PATH).map((s) => s.id),
							noticesSoFar: notices.length,
						});
						store.acceptExternalAdoption(prepared);
					},
				}
			: {}),
		notify: (m: string) => notices.push(m),
	} as never);
	return d;
}

/** Every recovery artifact currently on disk, sorted for stable comparison. */
function artifacts(): string[] {
	return [...fake.files.keys()].filter((k) => k.includes(".conflict-external-")).sort();
}

function legs(): { outgoing: string; incoming: string } {
	const found = artifacts();
	const outgoing = found.find((p) => p.endsWith("-outgoing.json"));
	const incoming = found.find((p) => p.endsWith("-incoming.json"));
	if (!outgoing || !incoming) throw new Error(`no artifact pair: ${found.join(", ")}`);
	return { outgoing, incoming };
}

async function drain(): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
	for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(0);
}

/**
 * Device A, loaded and settled, holding `[a, local]` on disk and in the
 * record. This is the "already loaded, clean inline page after settled writes"
 * the contract starts from.
 */
async function settledDeviceA(adapter: PageAdapterLike = fake): Promise<Device> {
	fake.files.set(LIVE, bytes(["a"]));
	fake.mtimes.set(LIVE, ++fake.clock);
	const a = device(adapter);
	await a.ink.ensureLoaded(PATH);
	a.ink.commit(PATH, stroke("local"));
	await drain();
	expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local"]);
	// Settled: the live file holds what the record holds and nothing is queued.
	expect(a.store.hasQueuedWrite(PAGE_ID)).toBe(false);
	expect(parsePage(fake.files.get(LIVE)!, PAGE_ID).data.strokes.map((s) => s.id)).toEqual([
		"a",
		"local",
	]);
	return a;
}

/** Another device replaces the whole file, as a completed sync would. */
function externalReplacement(strokeIds: string[]): string {
	const text = bytes(strokeIds);
	fake.externalWrite(LIVE, text);
	return text;
}

/** The reported two-device shape: incoming green replaces settled outgoing blue. */
function greenReplacement(path = LIVE, pageId = PAGE_ID, id = "green"): string {
	const incoming = page(["a", id], pageId);
	const green = incoming.strokes.find((s) => s.id === id)!;
	green.color = "#20a464";
	const text = serializePage(incoming);
	fake.externalWrite(path, text);
	return text;
}

function futureIncoming(): string {
	const raw = JSON.parse(bytes(["a", "future"])) as Record<string, unknown>;
	raw.schemaVersion = Number.MAX_SAFE_INTEGER;
	return JSON.stringify(raw);
}

function wrongSurfaceIncoming(): string {
	const incoming = page(["a", "wrong-surface"]);
	incoming.surface = "pdf";
	return serializePage(incoming);
}

function cleanEmptyIncoming(): string {
	const incoming = emptyPage(PAGE_ID);
	incoming.surface = "inline";
	return serializePage(incoming);
}

const INCOMPATIBLE_INCOMING = [
	{
		name: "malformed JSON",
		text: "{ this is not a page",
		firstLoadIds: [] as string[],
		damaged: true,
	},
	{
		name: "future-schema data",
		text: futureIncoming(),
		firstLoadIds: ["a", "future"],
		damaged: false,
	},
	{
		name: "a different surface",
		text: wrongSurfaceIncoming(),
		firstLoadIds: [] as string[],
		damaged: false,
	},
];

/**
 * The narrow scheduling seam for the unavailable-preparation race. After arming, the poll first
 * proves the pinned file for externallyChanged, then prepare proves the pin
 * again. The third live-path exists is prepareExternalAdoption's explicit
 * pre-artifact check. Only there, remove the file, run the real adapter check,
 * and restore the same incoming bytes and mtime before the false result returns.
 */
function missingAtPrepare(base: FakeAdapter, livePath = LIVE): {
	adapter: PageAdapterLike;
	arm(): void;
	fired(): boolean;
} {
	let armed = false;
	let liveExists = 0;
	let didFire = false;
	return {
		adapter: hooked(base, {
			exists: async (path) => {
				if (!armed || path !== livePath) return undefined;
				liveExists++;
				if (liveExists !== 3) return undefined;
				const text = base.files.get(path);
				const mtime = base.mtimes.get(path);
				if (text === undefined || mtime === undefined) {
					throw new Error(`race expected a live incoming file at ${path}`);
				}
				base.files.delete(path);
				base.mtimes.delete(path);
				const absent = await base.exists(path);
				base.files.set(path, text);
				base.mtimes.set(path, mtime);
				didFire = true;
				return absent;
			},
		}),
		arm: () => {
			armed = true;
			liveExists = 0;
		},
		fired: () => didFire,
	};
}

/** Hide the live file at the preparation check on every poll, then restore it. */
function persistentlyMissingAtPrepare(base: FakeAdapter): {
	adapter: PageAdapterLike;
	stop(): void;
} {
	let liveExists = 0;
	let active = true;
	return {
		adapter: hooked(base, {
			exists: async (path) => {
				if (!active || path !== LIVE || ++liveExists % 3 !== 0) return undefined;
				const text = base.files.get(path);
				const mtime = base.mtimes.get(path);
				if (text === undefined || mtime === undefined) {
					throw new Error(`persistent race expected a live incoming file at ${path}`);
				}
				base.files.delete(path);
				base.mtimes.delete(path);
				const absent = await base.exists(path);
				base.files.set(path, text);
				base.mtimes.set(path, mtime);
				return absent;
			},
		}),
		stop: () => {
			active = false;
		},
	};
}

/**
 * ONE TICK OF THE REAL POLL, extracted from main.ts and executed. This is the
 * production bridge, not a paraphrase of it: if the poll stops calling the
 * preserving route, these tests stop passing.
 */
function pollBridge(
	d: Device,
	paths: string[] = [PATH]
): { tick: () => Promise<void>; painted: string[] } {
	const painted: string[] = [];
	let fire!: () => void;
	let pending = Promise.resolve();
	const host = {
		store: d.store,
		pdfInk: new Map(),
		pdfIds: new Map(),
		pdfStore: { reloadExternal: async () => false },
		pollStats: { ticks: 0, hidden: 0, spaced: 0, checks: 0 },
		registerInterval: (h: number) => h,
	};
	installLiveReloadPoll.call(
		host,
		{
			setInterval(fn: () => void) {
				fire = fn;
				return 1;
			},
		},
		{ hidden: false },
		(promise: Promise<void>) => {
			pending = promise.catch(() => {});
		},
		() => paths,
		d.ink,
		(p: string) => painted.push(p),
		() => {},
		() => null,
		async () => false,
		{ error: () => {} },
		(p: string) => paths.includes(p) ? () => paths.includes(p) : null
	);
	return {
		painted,
		async tick() {
			fire();
			await pending;
			await drain();
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("CALLER ADMISSION", () => {
	it.each([
		{ name: "missing", canAdopt: undefined },
		{ name: "false", canAdopt: () => false },
		{ name: "throwing", canAdopt: () => { throw new Error("pane is no longer available"); } },
	])("holds a $name predicate before preservation without changing ink, history or baseline", async ({ canAdopt }) => {
		const a = await settledDeviceA();
		const identity = a.ink.captureHistoryIdentity(PATH);
		const visible = a.ink.strokes(PATH);
		const incoming = greenReplacement();
		const writesBefore = fake.writeAttempts;
		const prepare = vi.spyOn(a.store, "prepareExternalAdoption");

		// Admission is caller-owned: a loaded, writable record alone does not
		// prove that its pane has no uncommitted interaction.
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = canAdopt === undefined
				? await a.ink.adoptExternal(PATH)
				: await a.ink.adoptExternal(PATH, canAdopt);
			expect(result, "unadmitted callers must hold before preservation").toEqual({
				outcome: "held",
				changed: false,
				reason: "admission-changed",
			});
			expect(prepare).not.toHaveBeenCalled();
			expect(fake.writeAttempts).toBe(writesBefore);
			expect(artifacts()).toEqual([]);
			expect(a.accepts).toBe(0);
			expect(a.atAccept).toEqual([]);
			expect(a.ink.strokes(PATH)).toBe(visible);
			expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local"]);
			expect(a.ink.captureHistoryIdentity(PATH)).toBe(identity);
			expect(a.store.hasQueuedWrite(PAGE_ID)).toBe(false);
			expect(await a.store.externallyChanged(PAGE_ID)).toBe(true);
			expect(fake.files.get(LIVE)).toBe(incoming);
			expect(a.notices).toEqual([]);
			// Repeated benign admission holds never become preservation warnings.
			vi.setSystemTime(Date.now() + ADOPTION_QUIET_MS + 1);
		}
	});

	it("retains both artifacts when an uncommitted pane becomes busy during preservation, then adopts on a quiet retry", async () => {
		const reachedIncomingWrite = gate();
		const resumeIncomingWrite = gate();
		let paused = false;
		const adapter = hooked(fake, {
			beforeWrite: async (path) => {
				if (paused || !path.endsWith("-incoming.json")) return;
				paused = true;
				reachedIncomingWrite.release();
				await resumeIncomingWrite.promise;
			},
		});
		const a = await settledDeviceA(adapter);
		const identity = a.ink.captureHistoryIdentity(PATH);
		const visible = a.ink.strokes(PATH);
		const incoming = greenReplacement();
		let quiet = true;
		const canAdopt = vi.fn(() => quiet);
		const pending = a.ink.adoptExternal(PATH, canAdopt);

		await reachedIncomingWrite.promise;
		try {
			expect(artifacts()).toHaveLength(1);
			expect(a.accepts).toBe(0);
			// The pane starts an interaction without committing any store edit.
			// Every existing record-generation/content guard still sees equality.
			quiet = false;
		} finally {
			resumeIncomingWrite.release();
		}
		const held = await pending;

		expect(held, "pane admission must be checked again after preservation I/O").toEqual({
			outcome: "held",
			changed: false,
			reason: "admission-changed",
		});
		expect(canAdopt).toHaveBeenCalledTimes(2);
		expect(a.accepts).toBe(0);
		expect(a.atAccept).toEqual([]);
		expect(a.ink.strokes(PATH)).toBe(visible);
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local"]);
		expect(a.ink.captureHistoryIdentity(PATH)).toBe(identity);
		expect(a.store.hasQueuedWrite(PAGE_ID)).toBe(false);
		expect(await a.store.externallyChanged(PAGE_ID)).toBe(true);
		expect(fake.files.get(LIVE)).toBe(incoming);
		expect(a.notices).toEqual([]);
		const preserved = artifacts().map((path) => [path, fake.files.get(path)] as const);
		expect(preserved).toHaveLength(2);
		const pair = legs();
		expect(reopenExact(fake.files.get(pair.outgoing)!).strokes.map((s) => s.id)).toEqual(["a", "local"]);
		expect(fake.files.get(pair.incoming)).toBe(incoming);

		// Ending the interaction is sufficient; no local edit or new external
		// revision is needed to release the held adoption.
		quiet = true;
		const adopted = await a.ink.adoptExternal(PATH, canAdopt);
		expect(adopted).toMatchObject({ outcome: "adopted", changed: true });
		expect(canAdopt).toHaveBeenCalledTimes(4);
		expect(a.accepts).toBe(1);
		expect(a.atAccept[0]!.visibleIds).toEqual(["a", "local"]);
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "green"]);
		expect(a.ink.captureHistoryIdentity(PATH)).toBe(identity);
		expect(a.store.hasQueuedWrite(PAGE_ID)).toBe(false);
		expect(await a.store.externallyChanged(PAGE_ID)).toBe(false);
		expect(fake.files.get(LIVE)).toBe(incoming);
		expect(a.notices).toEqual([]);
		for (const [path, text] of preserved) expect(fake.files.get(path)).toBe(text);
	});
});

describe("UNAVAILABLE PRESERVATION NEVER FALLS THROUGH TO PLAIN RELOAD", () => {
	it("keeps settled outgoing blue when the real prepare sees the live path absent", async () => {
		const race = missingAtPrepare(fake);
		const a = await settledDeviceA(race.adapter);
		greenReplacement();
		race.arm();
		const reload = vi.spyOn(a.ink, "reloadExternal");
		const poll = pollBridge(a);

		await poll.tick();

		expect(race.fired()).toBe(true);
		// Before the fix, the unsafe fallback replaced [a, local] with [a, green].
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local"]);
		expect(reload).not.toHaveBeenCalled();
		expect(a.accepts).toBe(0);
		expect(artifacts()).toEqual([]);
		expect(poll.painted).toEqual([]);
		expect(a.notices.filter((n) => n.includes("preserved both versions"))).toEqual([]);
		// No acknowledgement: the unchanged external baseline remains retryable.
		expect(await a.store.externallyChanged(PAGE_ID)).toBe(true);
	});

	it("retries the same green revision and adopts it only after a real pair exists", async () => {
		const race = missingAtPrepare(fake);
		const a = await settledDeviceA(race.adapter);
		const incoming = greenReplacement();
		race.arm();
		const reload = vi.spyOn(a.ink, "reloadExternal");
		const poll = pollBridge(a);

		await poll.tick(); // unavailable: must hold, without acknowledging green
		expect(race.fired()).toBe(true);
		await poll.tick(); // the unchanged green file is eligible now

		// Before the fix, fallback acknowledged green on tick one, so tick two saw
		// no change and creates no preservation pair.
		expect(artifacts()).toHaveLength(2);
		const { outgoing, incoming: incomingLeg } = legs();
		expect(parsePage(fake.files.get(outgoing)!, PAGE_ID).data.strokes.map((s) => s.id)).toEqual([
			"a",
			"local",
		]);
		expect(fake.files.get(incomingLeg)).toBe(incoming);
		expect(a.accepts).toBe(1);
		expect(reload).not.toHaveBeenCalled();
		// Remote absence is intentional: local stays recoverable in the artifact,
		// not resurrected into the adopted visible revision.
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "green"]);
	});

	it("keeps editing available after the hold and preserves green on the next save", async () => {
		const race = missingAtPrepare(fake);
		const a = await settledDeviceA(race.adapter);
		greenReplacement();
		race.arm();
		const reload = vi.spyOn(a.ink, "reloadExternal");
		const conflicts: string[] = [];
		a.store.onConflict = (_id, keptAs) => conflicts.push(keptAs);

		await pollBridge(a).tick();
		// A held external adoption is not an edit lock.
		a.ink.commit(PATH, stroke("after-held"));
		expect(a.ink.strokes(PATH).some((s) => s.id === "after-held")).toBe(true);
		await drain();

		// Before the fix, plain reload advanced the baseline, so the subsequent save
		// sees no conflict and the original outgoing blue is already gone.
		expect(conflicts).toHaveLength(1);
		expect(parsePage(fake.files.get(conflicts[0]!)!, PAGE_ID).data.strokes.map((s) => s.id)).toEqual([
			"a",
			"green",
		]);
		expect(parsePage(fake.files.get(LIVE)!, PAGE_ID).data.strokes.map((s) => s.id)).toEqual([
			"a",
			"local",
			"after-held",
		]);
		expect(reload).not.toHaveBeenCalled();
	});

	it("leaves ordinary first load on the existing loadRecord path", async () => {
		greenReplacement();
		const a = device(fake);
		await a.ink.ensureLoaded(PATH);
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "green"]);
		expect(a.accepts).toBe(0);
		expect(artifacts()).toEqual([]);
	});

	it("a held first note does not starve an eligible second candidate", async () => {
		const path2 = "other.md";
		const pageId2 = "p2";
		const live2 = ".handwriting/p2.json";
		fake.files.set(LIVE, bytes(["a"]));
		fake.mtimes.set(LIVE, ++fake.clock);
		fake.files.set(live2, bytes(["a"], pageId2));
		fake.mtimes.set(live2, ++fake.clock);
		const race = missingAtPrepare(fake);
		const a = device(race.adapter, true, { [PATH]: PAGE_ID, [path2]: pageId2 });
		await a.ink.ensureLoaded(PATH);
		await a.ink.ensureLoaded(path2);
		a.ink.commit(PATH, stroke("local"));
		a.ink.commit(path2, stroke("local-2"));
		await drain();
		greenReplacement();
		greenReplacement(live2, pageId2, "green-2");
		race.arm();

		await pollBridge(a, [PATH, path2]).tick();

		expect(race.fired()).toBe(true);
		expect(a.ink.strokes(path2).map((s) => s.id)).toEqual(["a", "green-2"]);
		expect(a.accepts).toBe(1);
		expect(artifacts().filter((p) => p.includes("p2.conflict-external-"))).toHaveLength(2);
	});

	it.each(INCOMPATIBLE_INCOMING)(
		"holds $name on an established record, then the guarded save preserves its exact bytes",
		async ({ text }) => {
			const a = await settledDeviceA();
			const identity = a.ink.captureHistoryIdentity(PATH);
			fake.externalWrite(LIVE, text);
			const reload = vi.spyOn(a.ink, "reloadExternal");
			const conflicts: string[] = [];
			a.store.onConflict = (_id, keptAs) => conflicts.push(keptAs);

			await pollBridge(a).tick();

			// An incompatible external sample is not authority to rebuild an
			// already-good record. Its base and history stay available to save.
			expect(reload).not.toHaveBeenCalled();
			expect(a.accepts).toBe(0);
			expect(artifacts()).toEqual([]);
			expect(a.ink.captureHistoryIdentity(PATH)).toBe(identity);
			expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local"]);
			expect(await a.store.externallyChanged(PAGE_ID)).toBe(true);

			vi.setSystemTime(Date.now() + ADOPTION_QUIET_MS + 1);
			await pollBridge(a).tick();
			expect(a.notices).not.toContain(ADOPTION_STILL_FAILING);

			a.ink.commit(PATH, stroke("after-held"));
			await a.store.flush();

			// The real PageStore guard parks the unparsed incoming bytes first,
			// then writes the local composition. No parse or reserialization may
			// weaken this evidence check.
			expect(conflicts).toHaveLength(1);
			expect(fake.files.get(conflicts[0]!)).toBe(text);
			expect(parsePage(fake.files.get(LIVE)!, PAGE_ID).data.strokes.map((s) => s.id)).toEqual([
				"a",
				"local",
				"after-held",
			]);
			expect(a.store.hasQueuedWrite(PAGE_ID)).toBe(false);
		}
	);

	it("keeps incompatible incoming bytes and local ink pending when the save conflict rename fails", async () => {
		const a = await settledDeviceA();
		const incoming = futureIncoming();
		fake.externalWrite(LIVE, incoming);
		const reload = vi.spyOn(a.ink, "reloadExternal");
		const conflicts: string[] = [];
		a.store.onConflict = (_id, keptAs) => conflicts.push(keptAs);

		await pollBridge(a).tick();
		expect(reload).not.toHaveBeenCalled();
		a.ink.commit(PATH, stroke("after-held"));
		fake.failRenameTimes = 1;
		fake.failRenameWhen = (from, to) =>
			from === LIVE && to.includes(".conflict-") && !to.includes(".conflict-external-");

		await a.store.flush();

		// A failed preservation rename is a failed save, never overwrite
		// authority. The retry remains queued with the visible local stroke.
		expect(fake.files.get(LIVE)).toBe(incoming);
		expect(conflicts).toEqual([]);
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local", "after-held"]);
		expect(a.store.hasQueuedWrite(PAGE_ID)).toBe(true);
	});

	it.each(INCOMPATIBLE_INCOMING)(
		"keeps the ordinary first-load lock for $name",
		async ({ text, firstLoadIds, damaged }) => {
			fake.externalWrite(LIVE, text);
			const a = device(fake);

			await a.ink.ensureLoaded(PATH);
			expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(firstLoadIds);
			expect(a.ink.isDamagedLocked(PATH)).toBe(damaged);

			a.ink.commit(PATH, stroke("first-load-local"));
			await a.store.flush();
			expect(fake.files.get(LIVE)).toBe(text);
			expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual([
				...firstLoadIds,
				"first-load-local",
			]);
			expect(a.store.hasQueuedWrite(PAGE_ID)).toBe(false);
		}
	);

	it("reserves unavailable for no record and types an existing record without a snapshot as held", async () => {
		const a = device(fake, true, {});
		expect(await a.ink.adoptExternal(PATH, () => true)).toEqual({ outcome: "unavailable", changed: false });

		await a.ink.ensureLoaded(PATH);
		expect(await a.ink.adoptExternal(PATH, () => true)).toEqual({
			outcome: "held",
			changed: false,
			reason: "no-snapshot",
		});
	});

	it("announces a persistent missing-live hold once, without weakening later save preservation", async () => {
		const missing = persistentlyMissingAtPrepare(fake);
		const a = await settledDeviceA(missing.adapter);
		const incoming = greenReplacement();
		const conflicts: string[] = [];
		a.store.onConflict = (_id, keptAs) => conflicts.push(keptAs);
		const poll = pollBridge(a);

		await poll.tick();
		expect(a.notices).toEqual([]);
		expect(artifacts()).toEqual([]);
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local"]);

		await vi.advanceTimersByTimeAsync(ADOPTION_QUIET_MS + 1_000);
		await poll.tick();
		expect(a.notices).toEqual([ADOPTION_STILL_FAILING]);
		expect(artifacts()).toEqual([]);
		expect(a.accepts).toBe(0);

		await vi.advanceTimersByTimeAsync(ADOPTION_QUIET_MS + 1_000);
		await poll.tick();
		expect(a.notices).toEqual([ADOPTION_STILL_FAILING]);

		// The notice is not an adoption, a lock or a save. Editing remains live,
		// and the real write guard still preserves the exact incoming bytes.
		missing.stop();
		a.ink.commit(PATH, stroke("after-notice"));
		await a.store.flush();
		expect(conflicts).toHaveLength(1);
		expect(fake.files.get(conflicts[0]!)).toBe(incoming);
		expect(parsePage(fake.files.get(LIVE)!, PAGE_ID).data.strokes.map((s) => s.id)).toEqual([
			"a",
			"local",
			"after-notice",
		]);
	});

	it("announces a continuously absent live sidecar once while retaining the settled record", async () => {
		const a = await settledDeviceA();
		const identity = a.ink.captureHistoryIdentity(PATH);
		const poll = pollBridge(a);
		fake.files.delete(LIVE);
		fake.mtimes.delete(LIVE);

		await poll.tick();
		expect(a.notices).toEqual([]);
		expect(a.ink.captureHistoryIdentity(PATH)).toBe(identity);
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local"]);
		expect(a.accepts).toBe(0);
		expect(artifacts()).toEqual([]);

		await vi.advanceTimersByTimeAsync(ADOPTION_QUIET_MS + 1_000);
		await poll.tick();
		expect(a.notices).toEqual([ADOPTION_STILL_FAILING]);
		expect(a.ink.captureHistoryIdentity(PATH)).toBe(identity);
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local"]);
		expect(a.accepts).toBe(0);
		expect(artifacts()).toEqual([]);

		await vi.advanceTimersByTimeAsync(ADOPTION_QUIET_MS + 1_000);
		await poll.tick();
		expect(a.notices).toEqual([ADOPTION_STILL_FAILING]);
		expect(fake.files.has(LIVE)).toBe(false);

		// The hold retained the settled base as well as the visible strokes:
		// an explicit later save republishes the same non-stroke and unknown data.
		a.ink.save(PATH);
		await a.store.flush();
		const saved = parsePage(fake.files.get(LIVE)!, PAGE_ID).data;
		expect(saved.strokes.map((s) => s.id)).toEqual(["a", "local"]);
		expect(saved.textBoxes).toEqual(page([]).textBoxes);
		expect(saved.images).toEqual(page([]).images);
		expect(saved.unknownTop).toEqual(page([]).unknownTop);
		expect(artifacts()).toEqual([]);
	});
});

describe("CALIBRATION: the fixture really is a fork, and the codec really is lossless", () => {
	it("the two revisions each hold ink the other does not", () => {
		const out = parsePage(bytes(["a", "local"]), PAGE_ID).data.strokes.map((s) => s.id);
		const inc = parsePage(bytes(["a", "remote"]), PAGE_ID).data.strokes.map((s) => s.id);
		expect(out).toEqual(["a", "local"]);
		expect(inc).toEqual(["a", "remote"]);
		// Neither is a superset of the other: this is the case a plain reload
		// destroys, and the case a blind union gets wrong in the other
		// direction.
		expect(out).not.toContain("remote");
		expect(inc).not.toContain("local");
	});

	it("one serialize/parse pass preserves every value the fidelity checks read", () => {
		const p = parsePage(bytes(["a"]), PAGE_ID).data;
		expect(p.strokes[0]!.points).toEqual([
			{ x: 1, y: 2, pressure: 0.5, t: 0 },
			{ x: 11, y: 6, pressure: 0.5, t: 8 },
		]);
		expect(p.textBoxes).toEqual([{ id: "tb1", x: 12, y: 34, width: 200, z: 1 }]);
		expect(p.images).toEqual([{ id: "im1", x: 5, y: 6, width: 100, height: 80, z: 2 }]);
		expect(p.unknownTop).toEqual({ futureTopField: { note: "written by a newer build" } });
		expect(p.unknownByObject.a).toEqual({ futureStrokeField: "a-extra" });
	});
});

describe("PRESERVATION HAPPENS BEFORE ADOPTION, through the real poll", () => {
	it("writes and verifies both revisions before the baseline moves, then adopts", async () => {
		const a = await settledDeviceA();
		const incoming = externalReplacement(["a", "remote"]);
		const poll = pollBridge(a);
		await poll.tick();

		// Observed AT the acknowledgement, not after it.
		expect(a.accepts).toBe(1);
		const at = a.atAccept[0]!;
		// The outgoing leg was complete and already reopened to the captured
		// revision at that instant. It is NOT compared to the previous live
		// bytes: the artifact deliberately carries more than the live file did,
		// because the live file was rounded and the capture is not.
		expect(at.outgoingOnDisk).toBeDefined();
		expect(reopenExact(at.outgoingOnDisk!).strokes.map((s) => s.id)).toEqual(["a", "local"]);
		expect(parsePage(at.outgoingOnDisk!, PAGE_ID).damaged).toBeFalsy();
		expect(at.incomingOnDisk).toBe(incoming);
		// The record still held the outgoing ink at that instant: the swap is
		// strictly after preservation completed.
		expect(at.visibleIds).toEqual(["a", "local"]);
		// And nothing had been announced yet.
		expect(at.noticesSoFar).toBe(0);

		// After: incoming semantics are visible, the pair is on disk, and the
		// SYNCED LIVE FILE WAS NEVER REWRITTEN.
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "remote"]);
		expect(fake.files.get(LIVE)).toBe(incoming);
		expect(artifacts()).toHaveLength(2);
		for (const p of artifacts()) expect(p).toMatch(PAIR_NAME);
		expect(poll.painted).toEqual([PATH]);
	});

	it("adopting twice over does not re-announce or re-copy an unchanged pair", async () => {
		const a = await settledDeviceA();
		externalReplacement(["a", "remote"]);
		const poll = pollBridge(a);
		await poll.tick();
		const first = artifacts();
		// Success is SILENT (alan, 1.4.13: "kill the second message
		// definitely") - the ordinary two-device path says nothing at all.
		// The property under test is idempotence, not the announcement.
		const noticesAfterFirst = a.notices.length;
		expect(noticesAfterFirst).toBe(0);
		// Nothing changed on disk, so the next ticks find nothing to do.
		await poll.tick();
		await poll.tick();
		expect(artifacts()).toEqual(first);
		expect(a.notices).toHaveLength(noticesAfterFirst);
	});
});

describe("FULL FIDELITY: each artifact reopens alone", () => {
	it("the outgoing leg carries every id, point, box, image and unknown field", async () => {
		const a = await settledDeviceA();
		externalReplacement(["a", "remote"]);
		await pollBridge(a).tick();
		const { outgoing, incoming } = legs();

		// WITHOUT the live file and WITHOUT its pair: recovery may not depend
		// on either. Both are removed before the artifact is read.
		const text = fake.files.get(outgoing)!;
		fake.files.delete(LIVE);
		fake.files.delete(incoming);

		const parsed = parsePage(text, PAGE_ID);
		expect(parsed.damaged).toBeFalsy();
		expect(parsed.data.pageId).toBe(PAGE_ID);
		expect(parsed.data.surface).toBe("inline");
		// Order is content: the strokes come back in the order they were in.
		expect(parsed.data.strokes.map((s) => s.id)).toEqual(["a", "local"]);
		for (const s of parsed.data.strokes) {
			expect(s.points).toEqual([
				{ x: 1, y: 2, pressure: 0.5, t: 0 },
				{ x: 11, y: 6, pressure: 0.5, t: 8 },
			]);
			expect(s.color).toBe("#4b7bec");
			expect(s.width).toBe(2.2);
			expect(s.tool).toBe("pen");
		}
		expect(parsed.data.textBoxes).toEqual([{ id: "tb1", x: 12, y: 34, width: 200, z: 1 }]);
		expect(parsed.data.images).toEqual([
			{ id: "im1", x: 5, y: 6, width: 100, height: 80, z: 2 },
		]);
		// The newer build's field survives verbatim...
		expect(parsed.data.unknownTop.futureTopField).toEqual({
			note: "written by a newer build",
		});
		// ...alongside the artifact's own exact capture, which is the one thing
		// this file carries that an ordinary sidecar does not.
		expect(parsed.data.unknownTop[EXACT_KEY]).toBeDefined();
		expect(parsed.data.unknownByObject.a).toEqual({ futureStrokeField: "a-extra" });
		// `local` was drawn in this session, so it has no unknown fields to
		// carry - unknown fields belong to what a newer build wrote and this
		// build loaded. Its ink is what matters, and it is above.
		expect(parsed.data.unknownByObject.tb1).toEqual({ futureBoxField: 11 });
		expect(parsed.data.unknownByObject.im1).toEqual({ futureImageField: "keep me" });
	});

	it("the incoming leg is the other device's EXACT bytes", async () => {
		const a = await settledDeviceA();
		const incomingText = externalReplacement(["a", "remote"]);
		await pollBridge(a).tick();
		const { outgoing, incoming } = legs();
		const text = fake.files.get(incoming)!;
		fake.files.delete(LIVE);
		fake.files.delete(outgoing);
		// Byte equality, not semantic equality: the incoming leg is a copy, and
		// a re-serialization would be this layer's opinion of another build's
		// file rather than the file.
		expect(text).toBe(incomingText);
		expect(parsePage(text, PAGE_ID).data.strokes.map((s) => s.id)).toEqual(["a", "remote"]);
	});

	it("an outgoing-only and an incoming-only addition survive as separate revisions", async () => {
		const a = await settledDeviceA();
		externalReplacement(["a", "remote"]);
		await pollBridge(a).tick();
		const { outgoing, incoming } = legs();
		const out = parsePage(fake.files.get(outgoing)!, PAGE_ID).data.strokes.map((s) => s.id);
		const inc = parsePage(fake.files.get(incoming)!, PAGE_ID).data.strokes.map((s) => s.id);
		expect(out).toEqual(["a", "local"]);
		expect(inc).toEqual(["a", "remote"]);
		// The live record follows incoming semantics; the outgoing-only stroke
		// is recoverable rather than visible. That is the whole bargain.
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "remote"]);
	});
});

describe("THE INTENTIONAL-DELETE CONTROL: the red against a blind union", () => {
	it("a clean empty incoming page adopts as empty without resurrecting outgoing ink", async () => {
		const a = await settledDeviceA();
		const empty = cleanEmptyIncoming();
		fake.externalWrite(LIVE, empty);

		await pollBridge(a).tick();

		expect(a.accepts).toBe(1);
		expect(a.ink.strokes(PATH)).toEqual([]);
		expect(fake.files.get(LIVE)).toBe(empty);
		const { outgoing, incoming } = legs();
		expect(parsePage(fake.files.get(outgoing)!, PAGE_ID).data.strokes.map((s) => s.id)).toEqual([
			"a",
			"local",
		]);
		expect(fake.files.get(incoming)).toBe(empty);
	});

	it("a stroke deleted on the other device stays deleted, and is still recoverable", async () => {
		// Both devices saw [a, local]; the other device DELETED `local` and
		// wrote [a]. A union would put it straight back.
		fake.files.set(LIVE, bytes(["a", "local"]));
		fake.mtimes.set(LIVE, ++fake.clock);
		const a = device(fake);
		await a.ink.ensureLoaded(PATH);
		await drain();
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local"]);

		externalReplacement(["a"]);
		await pollBridge(a).tick();

		// THE DELETION HOLDS.
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a"]);
		expect(a.ink.strokes(PATH).map((s) => s.id)).not.toContain("local");
		// And it still holds after a reopen: nothing resurrects it later.
		const reopened = parsePage(fake.files.get(LIVE)!, PAGE_ID).data.strokes.map((s) => s.id);
		expect(reopened).toEqual(["a"]);
		// The older revision remains recoverable, which is what makes refusing
		// to merge acceptable rather than merely safe.
		const { outgoing } = legs();
		expect(parsePage(fake.files.get(outgoing)!, PAGE_ID).data.strokes.map((s) => s.id)).toEqual([
			"a",
			"local",
		]);
	});
});

describe("FAILURE INJECTION: every failure keeps the ink and moves no baseline", () => {
	/** Nothing adopted, nothing acknowledged, and a later poll still possible. */
	async function expectHeld(a: Device, identityBefore: symbol): Promise<void> {
		expect(a.accepts).toBe(0);
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local"]);
		expect(a.ink.captureHistoryIdentity(PATH)).toBe(identityBefore);
		// The baseline did not move: the change is still detectable.
		expect(await a.store.externallyChanged(PAGE_ID)).toBe(true);
		// And the note can still save.
		expect(a.ink.isDamagedLocked(PATH)).toBe(false);
	}

	it("the FIRST preservation write failing keeps everything", async () => {
		const adapter = hooked(fake, { failWrite: (p) => p.endsWith("-outgoing.json") });
		const a = await settledDeviceA(adapter);
		const identity = a.ink.captureHistoryIdentity(PATH);
		externalReplacement(["a", "remote"]);
		const result = await a.ink.adoptExternal(PATH, () => true);
		expect(result.outcome).toBe("held");
		expect(artifacts()).toHaveLength(0);
		await expectHeld(a, identity);
		// QUIET on the first failure (alan, 1.4.13: "then dont do a toast").
		// One failure is usually a sync client mid-write; it is gone by the
		// next tick and the user never needed telling. See the window tests.
		expect(a.notices).toEqual([]);
	});

	it("the SECOND preservation write failing keeps everything, and keeps the first artifact", async () => {
		const adapter = hooked(fake, { failWrite: (p) => p.endsWith("-incoming.json") });
		const a = await settledDeviceA(adapter);
		const identity = a.ink.captureHistoryIdentity(PATH);
		externalReplacement(["a", "remote"]);
		const result = await a.ink.adoptExternal(PATH, () => true);
		expect(result.outcome).toBe("held");
		// The completed leg of a partial attempt is RETAINED: it is ink, and
		// this slice adds no cleanup policy.
		const found = artifacts();
		expect(found).toHaveLength(1);
		expect(found[0]).toMatch(PAIR_NAME);
		expect(parsePage(fake.files.get(found[0]!)!, PAGE_ID).data.strokes.map((s) => s.id)).toEqual(
			["a", "local"]
		);
		await expectHeld(a, identity);
	});

	it("the incoming READ failing keeps everything", async () => {
		let armed = false;
		const adapter = hooked(fake, { failRead: (p) => armed && p === LIVE });
		const a = await settledDeviceA(adapter);
		const identity = a.ink.captureHistoryIdentity(PATH);
		externalReplacement(["a", "remote"]);
		armed = true;
		const result = await a.ink.adoptExternal(PATH, () => true);
		expect(result.outcome).toBe("held");
		expect(artifacts()).toHaveLength(0);
		armed = false;
		await expectHeld(a, identity);
	});

	it("an explicit reload of an incoming revision that will not parse still applies the damage lock", async () => {
		const a = await settledDeviceA();
		fake.externalWrite(LIVE, "{ this is not a page");
		const result = await a.ink.adoptExternal(PATH, () => true);
		// This direct-store control proves reloadExternal's lock behavior. It is
		// not authority for the production poll to call that weaker route after
		// a preserving adoption declines an established record.
		expect(result).toMatchObject({ outcome: "held", reason: "preservation-unavailable" });
		expect(artifacts()).toHaveLength(0);
		expect(a.accepts).toBe(0);
		// An explicit reload applies the lock and KEEPS the ink on screen.
		await a.ink.reloadExternal(PATH);
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local"]);
		expect(a.ink.isDamagedLocked(PATH)).toBe(true);
		expect(await a.ink.adoptExternal(PATH, () => true)).toMatchObject({
			outcome: "held",
			reason: "existing-lock",
		});
	});

	it("the final REVALIDATION finding a newer revision refuses, keeps both artifacts, and stays detectable", async () => {
		let replaced = false;
		const adapter = hooked(fake, {
			afterWrite(p) {
				// A third revision lands exactly while the copies are written.
				if (p.endsWith("-incoming.json") && !replaced) {
					replaced = true;
					fake.externalWrite(LIVE, bytes(["a", "newest"]));
				}
			},
		});
		const a = await settledDeviceA(adapter);
		const identity = a.ink.captureHistoryIdentity(PATH);
		externalReplacement(["a", "remote"]);
		const result = await a.ink.adoptExternal(PATH, () => true);
		expect(result.outcome).toBe("held");
		// THE CAPTURED GENERATION IS STILL PRESERVED - no generation vanishes
		// merely because an await completed late.
		expect(artifacts()).toHaveLength(2);
		const { incoming } = legs();
		expect(parsePage(fake.files.get(incoming)!, PAGE_ID).data.strokes.map((s) => s.id)).toEqual([
			"a",
			"remote",
		]);
		await expectHeld(a, identity);
		// The NEWEST generation is detected on the next poll and adopted.
		const poll = pollBridge(a);
		await poll.tick();
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "newest"]);
		// A silent refusal, not a failure: nothing was wrong.
		expect(a.notices.filter((n) => n.includes("could not safely load"))).toHaveLength(0);
	});
});

describe("A LOCAL MUTATION DURING PRESERVATION REJECTS THE PREPARATION", () => {
	/**
	 * The pen lands while the copies are being written. The prepared adoption
	 * describes a record that no longer exists, so it must be dropped - and the
	 * new ink must survive and still be able to reach disk.
	 */
	async function mutateDuring(hooks: (commit: () => void) => Hooks): Promise<Device> {
		let committed = false;
		let a!: Device;
		const commit = (): void => {
			if (committed) return;
			committed = true;
			a.ink.commit(PATH, stroke("mid"));
		};
		const adapter = hooked(fake, hooks(commit));
		a = await settledDeviceA(adapter);
		externalReplacement(["a", "remote"]);
		const result = await a.ink.adoptExternal(PATH, () => true);
		expect(committed).toBe(true);
		expect(result.outcome).toBe("held");
		expect(a.accepts).toBe(0);
		// The new stroke is visible and the outgoing ink is intact.
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local", "mid"]);
		// Its save safety is not weakened: the new ink is queued for disk. The
		// poll deliberately answers "nothing changed" while a write is queued,
		// so detectability is asserted after that write lands, in the test
		// below - where the existing write-path guard has to preserve the
		// external revision, which it can only do because this refusal left the
		// known baseline where it was.
		expect(a.store.hasQueuedWrite(PAGE_ID)).toBe(true);
		return a;
	}

	it("a stroke during the FIRST artifact write", async () => {
		const a = await mutateDuring((commit) => ({
			beforeWrite: (p) => {
				if (p.endsWith("-outgoing.json")) commit();
			},
		}));
		expect(artifacts().length).toBeGreaterThan(0);
	});

	it("a stroke during the SECOND artifact write", async () => {
		await mutateDuring((commit) => ({
			beforeWrite: (p) => {
				if (p.endsWith("-incoming.json")) commit();
			},
		}));
	});

	it("a stroke during the final revalidation read", async () => {
		let written = 0;
		await mutateDuring((commit) => ({
			afterWrite: (p) => {
				if (p.includes(".conflict-external-")) written++;
			},
			beforeRead: (p) => {
				if (p === LIVE && written === 2) commit();
			},
		}));
	});

	it("the ink added during a refused preparation still reaches disk", async () => {
		const a = await mutateDuring((commit) => ({
			beforeWrite: (p) => {
				if (p.endsWith("-outgoing.json")) commit();
			},
		}));
		await drain();
		// The guarded save path still works.
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local", "mid"]);
		const live = parsePage(fake.files.get(LIVE)!, PAGE_ID).data.strokes.map((s) => s.id);
		expect(live).toContain("mid");
		// AND THE EXTERNAL REVISION IS STILL NOT LOST. The refusal left the
		// known baseline describing the outgoing revision, so the write-path
		// conflict guard saw the file as foreign and preserved it - which it
		// could not have done had the preparation acknowledged the incoming
		// generation on its way out.
		const conflicts = [...fake.files.keys()].filter(
			(k) => k.includes(".conflict-") && !k.includes(".conflict-external-")
		);
		expect(conflicts).toHaveLength(1);
		expect(
			parsePage(fake.files.get(conflicts[0]!)!, PAGE_ID).data.strokes.map((s) => s.id)
		).toEqual(["a", "remote"]);
	});

	/**
	 * THE TWO QUALIFICATIONS ARE NOT ONE. The counter and the content
	 * comparison overlap on every ordinary mutation, so each needs a case only
	 * it can catch - otherwise deleting either one later breaks nothing that
	 * anybody notices.
	 */
	it("a remove-and-restore leaving IDENTICAL content is still rejected (only the counter sees this)", async () => {
		let once = false;
		const adapter = hooked(fake, {
			beforeWrite: (p) => {
				if (p.endsWith("-incoming.json") && !once) {
					once = true;
					// Out and straight back at the same index: the serialized
					// page is byte-identical afterwards, so the content
					// comparison cannot tell this happened. The contract is
					// that ANY mutation across an await invalidates the
					// preparation, and the generation counter is what knows.
					const removed = a.ink.applyRemove(PATH, ["local"]);
					a.ink.applyAdd(
						PATH,
						removed.map((r) => r.stroke),
						removed.map((r) => r.index)
					);
				}
			},
		});
		const a = await settledDeviceA(adapter);
		externalReplacement(["a", "remote"]);
		const result = await a.ink.adoptExternal(PATH, () => true);
		expect(once).toBe(true);
		// The list really is identical again - this is not a disguised change.
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local"]);
		expect(result.outcome).toBe("held");
		expect(a.accepts).toBe(0);
	});

	it("ink edited through a held reference, with no counted operation, is still rejected (only the comparison sees this)", async () => {
		let once = false;
		const adapter = hooked(fake, {
			beforeWrite: (p) => {
				if (p.endsWith("-incoming.json") && !once) {
					once = true;
					// Exactly the future caller the contract warns about: a
					// mutable reference changing what a save would write
					// without passing any operation that could bump a counter.
					const live = a.ink.strokes(PATH) as InkStroke[];
					live[1]!.points[0]!.x = 999;
				}
			},
		});
		const a = await settledDeviceA(adapter);
		externalReplacement(["a", "remote"]);
		const result = await a.ink.adoptExternal(PATH, () => true);
		expect(once).toBe(true);
		expect(result.outcome).toBe("held");
		expect(a.accepts).toBe(0);
		// The edited ink is still there and still edited.
		expect(a.ink.strokes(PATH).find((s) => s.id === "local")!.points[0]!.x).toBe(999);
	});

	it("a stroke MOVED in place is caught even though the stroke list is unchanged", async () => {
		// moveStrokes translates objects the record holds by reference. The
		// list is identical afterwards, so only a content comparison sees it.
		let moved = false;
		const adapter = hooked(fake, {
			beforeWrite: (p) => {
				if (p.endsWith("-incoming.json") && !moved) {
					moved = true;
					a.ink.moveStrokes(PATH, ["local"], 25, 25);
				}
			},
		});
		const a = await settledDeviceA(adapter);
		externalReplacement(["a", "remote"]);
		const result = await a.ink.adoptExternal(PATH, () => true);
		expect(moved).toBe(true);
		expect(result.outcome).toBe("held");
		expect(a.accepts).toBe(0);
		// The moved ink is still the ink on screen, at its new place.
		const local = a.ink.strokes(PATH).find((s) => s.id === "local")!;
		expect(local.points[0]).toMatchObject({ x: 26, y: 27 });
	});
});

describe("NAMING, COLLISION AND IDEMPOTENCE", () => {
	const realCrypto = globalThis.crypto;

	afterEach(() => {
		Object.defineProperty(globalThis, "crypto", {
			value: realCrypto,
			configurable: true,
			writable: true,
		});
	});

	/** Force the token stream, so a collision can be staged deterministically. */
	function tokens(...values: number[]): void {
		let call = 0;
		Object.defineProperty(globalThis, "crypto", {
			value: {
				getRandomValues: (arr: Uint8Array) => {
					arr.fill(values[Math.min(call, values.length - 1)]!);
					call++;
					return arr;
				},
			},
			configurable: true,
			writable: true,
		});
	}

	it("names both legs with a random token, outside isLiveSidecarName", async () => {
		const a = await settledDeviceA();
		externalReplacement(["a", "remote"]);
		await a.ink.adoptExternal(PATH, () => true);
		const { outgoing, incoming } = legs();
		expect(outgoing).toMatch(PAIR_NAME);
		expect(incoming).toMatch(PAIR_NAME);
		// One token, two legs: the pair is identifiable as a pair.
		const token = /-external-([0-9a-f]{16})-/.exec(outgoing)![1];
		expect(incoming).toContain(token);
		// `.conflict-` is what keeps both out of the live-sidecar namespace.
		expect(outgoing).toContain(".conflict-");
		expect(incoming).toContain(".conflict-");
	});

	it("a taken name is never overwritten: both are probed and a fresh pair allocated", async () => {
		tokens(0x11, 0x22);
		const a = await settledDeviceA();
		// A leftover artifact from an earlier attempt, holding ink.
		const taken = `.handwriting/p1.conflict-external-${"11".repeat(8)}-outgoing.json`;
		fake.files.set(taken, "an earlier attempt's ink");
		fake.mtimes.set(taken, ++fake.clock);
		externalReplacement(["a", "remote"]);
		const result = await a.ink.adoptExternal(PATH, () => true);
		expect(result.outcome).toBe("adopted");
		// The earlier artifact is untouched.
		expect(fake.files.get(taken)).toBe("an earlier attempt's ink");
		// And the new pair used the SECOND token.
		expect(result.outgoingPath).toContain("22".repeat(8));
		expect(result.incomingPath).toContain("22".repeat(8));
	});

	/**
	 * Found by an independent acceptance run: the committed collision
	 * fixture occupied the OUTGOING name only, so nothing proved the incoming
	 * leg is probed as well. It is - but that was luck rather than evidence
	 * until this case existed.
	 */
	it("a taken INCOMING name is probed too, not just the outgoing one", async () => {
		tokens(0x33, 0x44);
		const a = await settledDeviceA();
		const taken = `.handwriting/p1.conflict-external-${"33".repeat(8)}-incoming.json`;
		fake.files.set(taken, "an earlier attempt's incoming bytes");
		fake.mtimes.set(taken, ++fake.clock);
		externalReplacement(["a", "remote"]);
		const result = await a.ink.adoptExternal(PATH, () => true);
		expect(result.outcome).toBe("adopted");
		expect(fake.files.get(taken)).toBe("an earlier attempt's incoming bytes");
		expect(result.outgoingPath).toContain("44".repeat(8));
		expect(result.incomingPath).toContain("44".repeat(8));
	});

	it("no secure random source REFUSES preservation rather than naming by time", async () => {
		const a = await settledDeviceA();
		externalReplacement(["a", "remote"]);
		Object.defineProperty(globalThis, "crypto", {
			value: undefined,
			configurable: true,
			writable: true,
		});
		const result = await a.ink.adoptExternal(PATH, () => true);
		expect(result.outcome).toBe("held");
		expect(artifacts()).toHaveLength(0);
		expect(a.accepts).toBe(0);
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local"]);
	});

	it("an unchanged revision pair reuses its verified evidence instead of copying again", async () => {
		// The first attempt is refused by a stroke, so the pair exists but was
		// never adopted; the second attempt must reuse it.
		let once = false;
		const adapter = hooked(fake, {
			beforeWrite: (p) => {
				if (p.endsWith("-incoming.json") && !once) {
					once = true;
					a.ink.commit(PATH, stroke("mid"));
				}
			},
		});
		const a = await settledDeviceA(adapter);
		externalReplacement(["a", "remote"]);
		expect((await a.ink.adoptExternal(PATH, () => true)).outcome).toBe("held");
		const afterFirst = artifacts();
		expect(afterFirst).toHaveLength(2);
		// Undo the local change so the outgoing revision matches again.
		a.ink.applyRemove(PATH, ["mid"]);
		const second = await a.ink.adoptExternal(PATH, () => true);
		expect(second.outcome).toBe("adopted");
		// SAME pair, not a second copy of the same two revisions.
		expect(artifacts()).toEqual(afterFirst);
		expect(second.outgoingPath).toBe(afterFirst.find((p) => p.endsWith("-outgoing.json")));
	});

	it("concurrent attempts do not double-copy or overwrite", async () => {
		const a = await settledDeviceA();
		externalReplacement(["a", "remote"]);
		const [first, second] = await Promise.all([
			a.ink.adoptExternal(PATH, () => true),
			a.ink.adoptExternal(PATH, () => true),
		]);
		// One adopts; the other finds the record already moved on.
		const outcomes = [first.outcome, second.outcome].sort();
		expect(outcomes).toEqual(["adopted", "held"]);
		expect(artifacts()).toHaveLength(2);
		expect(a.accepts).toBe(1);
	});
});

describe("NOTIFICATION TIMING", () => {
	it("says NOTHING on success, and both artifacts still exist and parse", async () => {
		const a = await settledDeviceA();
		externalReplacement(["a", "remote"]);
		await pollBridge(a).tick();
		const { outgoing, incoming } = legs();
		// The announcement is gone; the GUARANTEE it used to announce is not.
		// Both revisions are on disk and independently readable - that is the
		// property, and it is worth asserting without a sentence attached.
		expect(a.notices).toEqual([]);
		expect(parsePage(fake.files.get(outgoing)!, PAGE_ID).damaged).toBeFalsy();
		expect(parsePage(fake.files.get(incoming)!, PAGE_ID).damaged).toBeFalsy();
		expect(a.accepts).toBe(1);
	});

	it("says nothing on a refusal, a stale preparation or a partial attempt", async () => {
		// Partial attempt: the second leg fails.
		const adapter = hooked(fake, { failWrite: (p) => p.endsWith("-incoming.json") });
		const a = await settledDeviceA(adapter);
		externalReplacement(["a", "remote"]);
		await a.ink.adoptExternal(PATH, () => true);
		expect(a.notices.filter((n) => n.includes("preserved both versions"))).toHaveLength(0);
	});

	it("stays quiet while it is still retrying, then speaks ONCE when it persists", async () => {
		const adapter = hooked(fake, { failWrite: (p) => p.endsWith("-outgoing.json") });
		const a = await settledDeviceA(adapter);
		externalReplacement(["a", "remote"]);

		// Inside the window: three failures, nothing said. This is the sync
		// client mid-write case, and it is the common one.
		await a.ink.adoptExternal(PATH, () => true);
		await a.ink.adoptExternal(PATH, () => true);
		await a.ink.adoptExternal(PATH, () => true);
		expect(a.notices).toEqual([]);

		// Past the window: it has stopped being a blip, so it says so - and
		// then keeps quiet however many more times it fails.
		vi.setSystemTime(Date.now() + 8_001);
		await a.ink.adoptExternal(PATH, () => true);
		await a.ink.adoptExternal(PATH, () => true);
		expect(a.notices).toHaveLength(1);
		// Alan's wording, and the BLANK LINE is part of it rather than
		// formatting: `blockNotice` in main.ts splits on it to render blocks,
		// and he asked for the break because it helps the toast be read at all
		// ("i want the line break it helps with visibility"). A single-line
		// version would pass a looser assertion and lose that.
		expect(a.notices[0]).toBe(
			"ink not appearing on this device?\n\nyour ink is safe. still trying to load from your other device..."
		);
	});

	it("a success inside the window resets the patience rather than spending it", async () => {
		// Fail once, wait most of the window, succeed, then fail again: the
		// clock must have restarted, so the late failure is still quiet.
		const failing = { on: true };
		const adapter = hooked(fake, {
			failWrite: (p) => failing.on && p.endsWith("-outgoing.json"),
		});
		const a = await settledDeviceA(adapter);
		externalReplacement(["a", "remote"]);
		await a.ink.adoptExternal(PATH, () => true);
		expect(a.notices).toEqual([]);

		vi.setSystemTime(Date.now() + 7_000);
		failing.on = false;
		externalReplacement(["a", "remote2"]);
		await a.ink.adoptExternal(PATH, () => true);
		expect(a.notices).toEqual([]);

		failing.on = true;
		externalReplacement(["a", "remote3"]);
		await a.ink.adoptExternal(PATH, () => true);
		vi.setSystemTime(Date.now() + 2_000);
		await a.ink.adoptExternal(PATH, () => true);
		// 9s since the FIRST failure, but only 2s since the run restarted.
		expect(a.notices).toEqual([]);
	});

	it("a run that ends WITHOUT adopting still resets the patience, same as a success (audit 128)", async () => {
		// Fail once (arms the quiet-period clock), then a run that neither
		// fails NOR adopts - a local edit supersedes the prepared adoption
		// mid-flight, same mechanism as "A LOCAL MUTATION DURING
		// PRESERVATION". That round still proves the disk pipe is healthy:
		// `prepare` did real I/O and came back with an answer. The clock
		// must restart there too, not only on a completed adoption, or one
		// unrelated blip long afterwards shows the notice at once instead
		// of waiting through the quiet period again.
		const failing = { on: true };
		let committed = false;
		let a!: Device;
		const adapter = hooked(fake, {
			failWrite: (p) => failing.on && p.endsWith("-outgoing.json"),
			beforeWrite: (p) => {
				if (!committed && !failing.on && p.endsWith("-outgoing.json")) {
					committed = true;
					a.ink.commit(PATH, stroke("mid"));
				}
			},
		});
		a = await settledDeviceA(adapter);
		externalReplacement(["a", "remote"]);
		await a.ink.adoptExternal(PATH, () => true);
		expect(a.notices).toEqual([]); // still inside the window

		vi.setSystemTime(Date.now() + 7_000);
		failing.on = false;
		externalReplacement(["a", "remote2"]);
		const held = await a.ink.adoptExternal(PATH, () => true);
		expect(held.outcome).toBe("held"); // superseded locally, not adopted
		expect(committed).toBe(true);
		expect(a.notices).toEqual([]);

		failing.on = true;
		externalReplacement(["a", "remote3"]);
		await a.ink.adoptExternal(PATH, () => true);
		vi.setSystemTime(Date.now() + 2_000);
		await a.ink.adoptExternal(PATH, () => true);
		// 9s since the FIRST failure, but only 2s since the held run.
		expect(a.notices).toEqual([]);
	});

	it("a failure run that ends in silence (unchanged polls) restarts the patience (audit 128)", async () => {
		const adapter = hooked(fake, { failWrite: (p) => p.endsWith("-outgoing.json") });
		const a = await settledDeviceA(adapter);
		externalReplacement(["a", "remote"]);
		await a.ink.adoptExternal(PATH, () => true);
		expect(a.notices).toEqual([]);

		// The poll saw the sidecar unchanged for a minute and never called
		// adoptExternal. One later blip is a new run, not the old one.
		vi.setSystemTime(Date.now() + 60_000);
		externalReplacement(["a", "remote2"]);
		await a.ink.adoptExternal(PATH, () => true);
		expect(a.notices).toEqual([]);

		// A run that keeps failing at poll speed still speaks, once.
		vi.setSystemTime(Date.now() + 8_001);
		await a.ink.adoptExternal(PATH, () => true);
		expect(a.notices).toHaveLength(1);
	});

	it("a stale preparation resets the patience too", async () => {
		const failing = { on: true };
		let bump = false;
		const adapter = hooked(fake, {
			failWrite: (p) => failing.on && p.endsWith("-outgoing.json"),
			afterWrite: (p) => {
				// A newer external revision lands while the copies are written.
				if (bump && p.endsWith("-outgoing.json")) {
					bump = false;
					externalReplacement(["a", "newer"]);
				}
			},
		});
		const a = await settledDeviceA(adapter);
		externalReplacement(["a", "remote"]);
		await a.ink.adoptExternal(PATH, () => true);
		expect(a.notices).toEqual([]);

		vi.setSystemTime(Date.now() + 7_000);
		failing.on = false;
		bump = true;
		externalReplacement(["a", "remote2"]);
		const held = await a.ink.adoptExternal(PATH, () => true);
		expect(held.outcome).toBe("held");
		expect(bump).toBe(false); // the stale path really ran

		failing.on = true;
		externalReplacement(["a", "remote3"]);
		await a.ink.adoptExternal(PATH, () => true);
		vi.setSystemTime(Date.now() + 2_000);
		await a.ink.adoptExternal(PATH, () => true);
		// 9s since the FIRST failure, but only 2s since the stale round.
		expect(a.notices).toEqual([]);
	});
});

describe("MISSING CAPABILITY: external replacement never falls back to unpreserved reload", () => {
	/**
	 * The control that gives every green above its meaning. Identical
	 * production code, identical fixture, identical poll - the ONLY difference
	 * is a host without the preservation pair, which is exactly the route this
	 * slice adds. Production is not edited, so there is nothing to restore and
	 * no way for a restore to be imperfect.
	 */
	it("holds the outgoing revision and leaves the incoming generation retryable", async () => {
		fake.files.set(LIVE, bytes(["a"]));
		fake.mtimes.set(LIVE, ++fake.clock);
		const a = device(fake, false);
		await a.ink.ensureLoaded(PATH);
		a.ink.commit(PATH, stroke("local"));
		await drain();
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local"]);

		externalReplacement(["a", "remote"]);
		expect(await a.ink.adoptExternal(PATH, () => true)).toMatchObject({
			outcome: "held",
			reason: "missing-capability",
		});
		const poll = pollBridge(a);
		await poll.tick();

		// No preserving capability means no authority to replace an existing
		// record. Before the fix this received [a, remote] through reloadExternal.
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "local"]);
		// No route means no falsely claimed pair either.
		expect(artifacts()).toHaveLength(0);
		// The baseline does not move, so a later capable poll can retry.
		expect(await a.store.externallyChanged(PAGE_ID)).toBe(true);
	});

	it("and with the route enabled, the same sequence keeps it", async () => {
		const a = await settledDeviceA();
		externalReplacement(["a", "remote"]);
		await pollBridge(a).tick();
		const { outgoing } = legs();
		expect(fake.files.get(outgoing)).toContain('"id":"local"');
		expect(parsePage(fake.files.get(outgoing)!, PAGE_ID).data.strokes.map((s) => s.id)).toEqual([
			"a",
			"local",
		]);
	});
});

/**
 * A stroke whose values sit BELOW the persisted codec's resolution. The
 * committed fixture above deliberately used integers and `pressure: 0.5`, which
 * survive `packPointsV2` untouched - so its "one serialize/parse pass preserves
 * every value" calibration was true of that fixture and hid this. An independent
 * acceptance run found it; these are its two reds.
 */
function preciseStroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2.23456,
		points: [
			{ x: 1.234567, y: 2.345678, pressure: 0.123456, t: 9.876 },
			{ x: 11.987654, y: 6.543211, pressure: 0.987654, t: 21.499 },
		],
		bbox: { x: 1.234567, y: 2.345678, width: 10.753087, height: 4.197533 },
		createdAt: 0,
	};
}

/**
 * Reopen a recovery artifact the way a recovery tool would: parse it, and take
 * the exact capture if the artifact carries one. Written so it compiles and
 * runs against the uncorrected object too - there it simply finds no exact
 * block and falls back to the quantized strokes, which is the red.
 */
function reopenExact(text: string): PageData {
	const parsed = parsePage(text, PAGE_ID).data;
	const exact = parsed.unknownTop?.[EXACT_KEY] as PageData | undefined;
	return exact ?? parsed;
}

/** Device A settled with a sub-resolution stroke in the record. */
async function settledPreciseA(adapter: PageAdapterLike = fake): Promise<Device> {
	fake.files.set(LIVE, bytes(["a"]));
	fake.mtimes.set(LIVE, ++fake.clock);
	const a = device(adapter);
	await a.ink.ensureLoaded(PATH);
	a.ink.commit(PATH, preciseStroke("local"));
	await drain();
	expect(a.store.hasQueuedWrite(PAGE_ID)).toBe(false);
	return a;
}

describe("LOSSLESS CAPTURE: the artifact must return what was captured", () => {
	it("the outgoing artifact reopens with EVERY captured value, not the rounded ones", async () => {
		const a = await settledPreciseA();
		// What the record actually holds, in memory, at capture time.
		const captured = a.ink.strokes(PATH).find((s) => s.id === "local")!;
		expect(captured.points[0]!.x).toBe(1.234567);

		externalReplacement(["a", "remote"]);
		await pollBridge(a).tick();
		const { outgoing } = legs();

		const recovered = reopenExact(fake.files.get(outgoing)!);
		const local = recovered.strokes.find((s) => s.id === "local")!;
		// The artifact exists to make the outgoing revision recoverable. If it
		// gives back a rounded stroke, it is not the revision that was captured.
		expect(local.points[0]!.x).toBe(1.234567);
		expect(local.points[0]!.y).toBe(2.345678);
		expect(local.points[0]!.pressure).toBe(0.123456);
		expect(local.points[0]!.t).toBe(9.876);
		expect(local.points[1]!.x).toBe(11.987654);
		expect(local.points[1]!.t).toBe(21.499);
		expect(local.width).toBe(2.23456);
	});

	it("a held-reference mutation BELOW persisted rounding is still rejected", async () => {
		let once = false;
		const adapter = hooked(fake, {
			beforeWrite: (p) => {
				if (p.endsWith("-incoming.json") && !once) {
					once = true;
					// +0.0004 on x: no counted operation, and it rounds away
					// entirely in the persisted codec, so a comparison made
					// through that codec cannot see it.
					const live = a.ink.strokes(PATH) as InkStroke[];
					live.find((s) => s.id === "local")!.points[0]!.x += 0.0004;
				}
			},
		});
		const a = await settledPreciseA(adapter);
		externalReplacement(["a", "remote"]);
		const result = await a.ink.adoptExternal(PATH, () => true);
		expect(once).toBe(true);
		// Any mutation across an await invalidates the preparation. There is no
		// "too small to count" clause, and there must not be one: the record
		// that gets replaced is the mutated one.
		expect(result.outcome).toBe("held");
		expect(a.accepts).toBe(0);
		expect(a.ink.strokes(PATH).find((s) => s.id === "local")!.points[0]!.x).toBe(1.234967);
	});

	/**
	 * THE SEVERITY CONTROL, and the reason this defect is a fidelity bug rather
	 * than an ink-loss bug. `serializePage` is the ONLY writer of sidecars, so
	 * the live file has always held the rounded values too. The artifact was
	 * never less faithful than the file it protects - which is why nothing a
	 * user could ever have persisted was at risk.
	 */
	it("an ordinary settled save rounds identically, so the artifact never lost persistable ink", async () => {
		const a = await settledPreciseA();
		const live = parsePage(fake.files.get(LIVE)!, PAGE_ID).data;
		const saved = live.strokes.find((s) => s.id === "local")!;
		// The ordinary save path already rounded to the codec's resolution.
		expect(saved.points[0]!.x).toBe(1.23);
		expect(saved.points[0]!.pressure).toBe(0.123);
		expect(saved.points[0]!.t).toBe(10);
		expect(saved.width).toBe(2.235);
		// And the in-memory record still holds full precision, which is the
		// only place the extra digits ever existed.
		expect(a.ink.strokes(PATH).find((s) => s.id === "local")!.points[0]!.x).toBe(1.234567);
	});

	it("ordinary live-sidecar normalization is UNTOUCHED: the exact block is recovery-only", async () => {
		const a = await settledPreciseA();
		// An ordinary settled save writes a plain sidecar, exactly as before.
		expect(fake.files.get(LIVE)).not.toContain(EXACT_KEY);

		const incoming = externalReplacement(["a", "remote"]);
		await pollBridge(a).tick();

		// The synced live file is still the other device's bytes, unrewritten
		// and uncontaminated by the recovery format.
		expect(fake.files.get(LIVE)).toBe(incoming);
		expect(fake.files.get(LIVE)).not.toContain(EXACT_KEY);
		// The incoming leg is a verbatim copy of those bytes, so it carries no
		// capture of ours either - only the outgoing leg does.
		const { incoming: incomingLeg, outgoing } = legs();
		expect(fake.files.get(incomingLeg)).toBe(incoming);
		expect(fake.files.get(incomingLeg)).not.toContain(EXACT_KEY);
		expect(fake.files.get(outgoing)).toContain(EXACT_KEY);
	});
});

describe("TWO REAL STORES: the incoming revision is composed by another device's own store", () => {
	it("adopts a revision a second PageStore wrote, and preserves this device's", async () => {
		// DEVICE B has its own adapter - its own replica of the vault - its own
		// PageStore and its own InlineInkStore, and it never sees device A's
		// file. That is what being another device means, and it is why this is
		// not the two-writers-one-store case (which is a different bug with a
		// different fix, reconcileInProcess).
		const bFake = new FakeAdapter();
		bFake.files.set(LIVE, bytes(["a"]));
		bFake.mtimes.set(LIVE, ++bFake.clock);
		const b = device(bFake);
		await b.ink.ensureLoaded(PATH);
		b.ink.commit(PATH, stroke("remote"));
		await drain();
		const composedByB = bFake.files.get(LIVE)!;
		expect(parsePage(composedByB, PAGE_ID).data.strokes.map((s) => s.id)).toEqual([
			"a",
			"remote",
		]);

		// DEVICE A, its own store, holding its own revision.
		const a = await settledDeviceA();
		// Sync delivers B's file whole over A's. This is the completed external
		// replacement the containment contract starts from.
		fake.externalWrite(LIVE, composedByB);
		await pollBridge(a).tick();

		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "remote"]);
		// A never rewrote what B composed.
		expect(fake.files.get(LIVE)).toBe(composedByB);
		const { outgoing, incoming } = legs();
		expect(parsePage(fake.files.get(outgoing)!, PAGE_ID).data.strokes.map((s) => s.id)).toEqual([
			"a",
			"local",
		]);
		// The incoming leg is B's bytes exactly, not A's re-serialization of
		// its opinion of them.
		expect(fake.files.get(incoming)).toBe(composedByB);
	});
});

describe("CLEAR PAGE ACROSS TWO REAL REPLICAS", () => {
	function seed(base: FakeAdapter, text: string): void {
		base.files.set(LIVE, text);
		base.mtimes.set(LIVE, ++base.clock);
	}

	async function open(base: FakeAdapter, adapter: PageAdapterLike = base): Promise<Device> {
		const d = device(adapter);
		await d.ink.ensureLoaded(PATH);
		return d;
	}

	async function clearWithStore(base: FakeAdapter, adapter: PageAdapterLike = base): Promise<{
		device: Device;
		bytes: string;
	}> {
		const d = await open(base, adapter);
		const ids = d.ink.strokes(PATH).map((s) => s.id);
		expect(ids.length, "the producer starts with real ink to remove").toBeGreaterThan(0);
		d.ink.applyRemove(PATH, ids);
		await d.store.flush();
		const text = base.files.get(LIVE);
		if (text === undefined) throw new Error("the producer did not publish a live sidecar");
		return { device: d, bytes: text };
	}

	it("holds through the missing interval, then adopts B's real empty file once, with both revisions recoverable", async () => {
		const common = bytes(["a", "shared"]);
		seed(fake, common);
		const a = await open(fake);
		const poll = pollBridge(a);

		// An independent replica: its own adapter, PageStore and InlineInkStore.
		const bFake = new FakeAdapter();
		seed(bFake, common);
		const produced = await clearWithStore(bFake);
		const producedPage = parsePage(produced.bytes, PAGE_ID).data;
		expect(producedPage.strokes).toEqual([]);
		// Clearing strokes is not clearing the page container.
		expect(producedPage.textBoxes).toEqual(page([]).textBoxes);
		expect(producedPage.images).toEqual(page([]).images);
		expect(producedPage.unknownTop).toEqual(page([]).unknownTop);
		expect(producedPage.unknownByObject.tb1).toEqual({ futureBoxField: 11 });
		expect(producedPage.unknownByObject.im1).toEqual({ futureImageField: "keep me" });

		// Sync's unlink/replace interval is not a deletion signal. A must retain
		// its settled ink until an independently parseable incoming file exists.
		fake.files.delete(LIVE);
		fake.mtimes.delete(LIVE);
		await poll.tick();
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "shared"]);
		expect(a.accepts).toBe(0);
		expect(artifacts()).toEqual([]);

		// THE OPPOSING SENSITIVITY, AND IT WAS RUN RATHER THAN ASSERTED.
		// Replacing this delivery with another unlink - `files.delete(LIVE)` and
		// `mtimes.delete(LIVE)` in place of the write below - fails the next
		// assertion: `accepts` stays 0 where 1 is required. Measured 2026-09-08.
		//
		// So what this case proves is that a real, final empty JSON generation
		// propagates - NOT that absence is read as empty, and not that it is
		// read as anything at all. The unlink arm is deliberately left
		// UNPINNED: whether a raw unlink should ever mean deletion is an open
		// product question, and a test asserting either answer here would
		// freeze a policy nobody has ruled.
		fake.externalWrite(LIVE, produced.bytes);
		await poll.tick();

		expect(a.accepts).toBe(1);
		expect(a.ink.strokes(PATH)).toEqual([]);
		expect(fake.files.get(LIVE)).toBe(produced.bytes);
		const firstPair = artifacts();
		expect(firstPair).toHaveLength(2);
		const { outgoing, incoming } = legs();
		const outgoingPage = reopenExact(fake.files.get(outgoing)!);
		expect(outgoingPage.strokes.map((s) => s.id)).toEqual(["a", "shared"]);
		expect(outgoingPage.textBoxes).toEqual(page([]).textBoxes);
		expect(outgoingPage.images).toEqual(page([]).images);
		expect(outgoingPage.unknownTop.futureTopField).toEqual(page([]).unknownTop.futureTopField);
		expect(fake.files.get(incoming)).toBe(produced.bytes);

		// The same delivered generation is content-identical even if sync gives
		// it another mtime. It neither recopies nor acknowledges twice.
		fake.externalWrite(LIVE, produced.bytes);
		await poll.tick();
		expect(a.accepts).toBe(1);
		expect(artifacts()).toEqual(firstPair);

		// Reopen from the live namespace. Recovery siblings are evidence, never
		// inputs to ordinary load, so the outgoing ink cannot resurrect.
		a.ink.handleDelete(PATH);
		const reopened = await open(fake);
		expect(reopened.ink.strokes(PATH)).toEqual([]);
		expect(artifacts()).toEqual(firstPair);
	});

	it("an interrupted producer publication remains queued and a real retry emits the final empty JSON", async () => {
		const common = bytes(["a", "shared"]);
		const bFake = new FakeAdapter();
		seed(bFake, common);
		let failFirstTmp = true;
		const adapter = hooked(bFake, {
			failWrite: (path) => {
				if (!failFirstTmp || !path.endsWith(".tmp")) return false;
				failFirstTmp = false;
				return true;
			},
		});
		const b = await open(bFake, adapter);
		vi.spyOn(console, "error").mockImplementation(() => {});
		b.ink.applyRemove(PATH, ["a", "shared"]);

		await b.store.flush();
		expect(failFirstTmp).toBe(false);
		expect(b.store.hasQueuedWrite(PAGE_ID)).toBe(true);
		expect(parsePage(bFake.files.get(LIVE)!, PAGE_ID).data.strokes.map((s) => s.id)).toEqual([
			"a",
			"shared",
		]);

		await b.store.flush();
		expect(b.store.hasQueuedWrite(PAGE_ID)).toBe(false);
		const published = parsePage(bFake.files.get(LIVE)!, PAGE_ID).data;
		expect(published.strokes).toEqual([]);
		expect(published.textBoxes).toEqual(page([]).textBoxes);
		expect(published.images).toEqual(page([]).images);
		expect(published.unknownTop).toEqual(page([]).unknownTop);
	});

	it("a receiver that cannot complete the artifact pair holds A's ink and retries the same empty generation", async () => {
		const common = bytes(["a", "shared"]);
		const bFake = new FakeAdapter();
		seed(bFake, common);
		const produced = await clearWithStore(bFake);

		seed(fake, common);
		let refuseOutgoing = true;
		const adapter = hooked(fake, {
			failWrite: (path) => refuseOutgoing && path.endsWith("-outgoing.json"),
		});
		const a = await open(fake, adapter);
		vi.spyOn(console, "error").mockImplementation(() => {});
		fake.externalWrite(LIVE, produced.bytes);
		const poll = pollBridge(a);

		await poll.tick();
		expect(a.accepts).toBe(0);
		expect(a.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "shared"]);
		expect(artifacts()).toEqual([]);
		expect(await a.store.externallyChanged(PAGE_ID)).toBe(true);

		refuseOutgoing = false;
		await poll.tick();
		expect(a.accepts).toBe(1);
		expect(a.ink.strokes(PATH)).toEqual([]);
		expect(artifacts()).toHaveLength(2);
		expect(legs().incoming).toBeDefined();
		expect(fake.files.get(legs().incoming)).toBe(produced.bytes);
	});
});

describe("THE LIVE SIDECAR IS NEVER REWRITTEN BY CONTAINMENT", () => {
	it("byte-identical through a full adopt, and its stamp becomes the baseline", async () => {
		const a = await settledDeviceA();
		const incoming = externalReplacement(["a", "remote"]);
		await pollBridge(a).tick();
		expect(fake.files.get(LIVE)).toBe(incoming);
		// The accepted generation is exactly what is on disk, so the next poll
		// finds nothing and the next save is measured against the right file.
		expect(await a.store.externallyChanged(PAGE_ID)).toBe(false);
		expect(contentStamp(fake.files.get(LIVE)!)).toBe(contentStamp(incoming));
		// No write of the live path happened during containment.
		expect(fake.log.filter((l) => l === `write ${LIVE}`)).toHaveLength(0);
	});
});
