/**
 * AUDIT PROBE main-2-1 (read-only audit of 1.4.21, tag 1a05f62c).
 *
 * Claim: "Keep this device's ink" writes the sidecar through PageStore.saveNow
 * behind the live InlineInkStore record, so the screen keeps the other
 * device's ink and the next edit rewrites the live sidecar from that stale
 * record, undoing the restore.
 *
 * Production code driven: PageStore, InlineInkStore (host wired as main.ts
 * wires it), the real live-reload poll sliced out of main.ts, and
 * applyForkDecision (the modal's click handler body). The ForkHost is built
 * exactly as main.ts:2502-2510 builds it, and the probe asserts that line is
 * still the production source.
 *
 * Assertions state the CORRECT behaviour: green = no bug, red = bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import mainSource from "../main.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { InlineInkStore } from "../inline/InlineInkStore";
import {
	ForkHost,
	applyForkDecision,
	describeFork,
	listForks,
	resetForks,
	forkHostFor,
} from "../persistence/ForkResolution";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";
import { installLiveReloadPoll } from "../testUtils/LiveReloadTestHarness";

const DEBOUNCE_MS = 700;
const PATH = "note.md";
const PAGE_ID = "p1";
const LIVE = ".handwriting/p1.json";

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

function bytes(ids: string[]): string {
	const p = emptyPage(PAGE_ID);
	p.surface = "inline";
	p.strokes = ids.map(stroke);
	return serializePage(p);
}

function liveIds(): string[] {
	return parsePage(fake.files.get(LIVE)!, PAGE_ID).data.strokes.map((s) => s.id);
}

let fake: FakeAdapter;

async function drain(): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
	for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(0);
}

/** One device: PageStore + InlineInkStore, host wired as main.ts:2033-2046. */
function device(): { store: PageStore; ink: InlineInkStore } {
	const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
	const ink = new InlineInkStore();
	ink.attachHost({
		readPageId: (p: string) => (p === PATH ? PAGE_ID : null),
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: (id: string) => store.load(id),
		scheduleSidecar: (id: string, p: PageData) => store.schedule(id, p),
		scheduleSidecarNow: (id: string, p: PageData) => store.saveNow(id, p),
		prepareExternalAdoption: (id: string, outgoing: PageData) =>
			store.prepareExternalAdoption(id, outgoing),
		acceptExternalAdoption: (prepared: never) => store.acceptExternalAdoption(prepared),
		notify: () => {},
	} as never);
	return { store, ink };
}

/** The real poll block from main.ts, one tick at a time. */
function pollBridge(store: PageStore, ink: InlineInkStore): { tick: () => Promise<void>; painted: string[] } {
	const painted: string[] = [];
	let fire!: () => void;
	let pending = Promise.resolve();
	const host = {
		store,
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
		() => [PATH],
		ink,
		(p: string) => painted.push(p),
		() => {},
		() => null,
		async () => false,
		{ error: () => {} },
		(p: string) => (p === PATH ? () => true : null)
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
	resetForks();
});

afterEach(() => {
	vi.useRealTimers();
	resetForks();
});

describe("main-2-1: keep this device's ink after a fork", () => {
	it("the kept ink reaches the screen and survives the next edit", async () => {
		// Production wiring precondition: the command builds its host with
		// forkHostFor and restores through the open note, as the probe does below.
		const main = mainSource.replace(/\r\n/g, "\n");
		expect(main).toContain("const host: ForkHost = forkHostFor({");
		expect(main).toContain("const path = await inlineInk.restoreRevision(pageId, data);");

		// Device A: loaded, draws "local", settled on disk.
		fake.files.set(LIVE, bytes(["a"]));
		fake.mtimes.set(LIVE, ++fake.clock);
		const { store, ink } = device();
		await ink.ensureLoaded(PATH);
		ink.commit(PATH, stroke("local"));
		await drain();
		expect(liveIds()).toEqual(["a", "local"]);
		expect(store.hasQueuedWrite(PAGE_ID)).toBe(false);

		// Sync delivers the other device's revision, which lacks "local".
		fake.externalWrite(LIVE, bytes(["a", "theirs"]));
		const poll = pollBridge(store, ink);
		await poll.tick();

		// PRECONDITION: adopted, the screen shows theirs, and a fork is listed
		// that needs a decision (this device holds "local", theirs does not).
		expect(ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "theirs"]);
		const forks = listForks();
		expect(forks).toHaveLength(1);
		const rec = forks[0]!;

		// The fork host main.ts builds (forkHostFor), with its open-note restore.
		const host: ForkHost = forkHostFor({
			adapter: { read: (p) => fake.read(p), stat: (p) => fake.stat(p), list: async () => ({ files: [...fake.files.keys()] }) },
			store,
			restoreOpen: async (pageId, data) => (await ink.restoreRevision(pageId, data)) !== null,
		});
		const account = await describeFork(host, rec);
		expect(account.needsDecision).toBe(true);
		expect(account.mineOnly).toBe(1);

		// The user clicks "Keep this device's ink".
		const out = await applyForkDecision(host, rec, "keep-mine");
		expect(out).toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		// PRECONDITION: the restore reached disk.
		expect(liveIds()).toEqual(["a", "local"]);
		expect(listForks()).toHaveLength(0);

		// Give the live-reload poll every chance: one tick inside the 5 s
		// content-check window and one well past it.
		await poll.tick();
		await vi.advanceTimersByTimeAsync(6000);
		await poll.tick();
		const shownAfterPolls = ink.strokes(PATH).map((s) => s.id);
		const diskAfterPolls = liveIds();

		// The user draws one more stroke on the note.
		ink.commit(PATH, stroke("next"));
		await drain();
		const diskAfterEdit = liveIds();

		const report = { shownAfterPolls, diskAfterPolls, diskAfterEdit, painted: poll.painted.length };

		// CORRECT BEHAVIOUR 1: the screen shows the ink the user chose to keep.
		expect(shownAfterPolls, `screen after keep-mine ${JSON.stringify(report)}`).toContain("local");
		// CORRECT BEHAVIOUR 2: the next edit does not undo the restore.
		expect(diskAfterEdit, `live sidecar after next stroke ${JSON.stringify(report)}`).toContain("local");
	});
});
