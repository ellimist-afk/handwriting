/**
 * AUDIT PROBE L-errors-1 (read-only audit of 1.4.21 tag 1a05f62c).
 *
 * Claim: "Keep this device's ink" (applyForkDecision keep-mine) writes the
 * restored revision straight through PageStore.saveNow, behind the loaded
 * InlineInkStore record. The record keeps the adopted incoming revision, the
 * live-reload poll sees the store's own stamps and never re-reads, so the
 * screen never changes and the next edit writes incoming + new ink over the
 * restored revision.
 *
 * Production code only: real PageStore, real InlineInkStore, the real poll
 * block sliced from main.ts (LiveReloadTestHarness), real applyForkDecision,
 * and a ForkHost shaped exactly like main.ts:2502-2510. The assertions state
 * the CORRECT behaviour, so a red means the bug is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore, PageAdapterLike } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { InlineInkStore } from "../inline/InlineInkStore";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";
import { installLiveReloadPoll } from "../testUtils/LiveReloadTestHarness";
import {
	ForkHost,
	applyForkDecision,
	describeFork,
	listForks,
	resetForks,
	forkHostFor,
} from "../persistence/ForkResolution";

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

function page(ids: string[]): PageData {
	const p = emptyPage(PAGE_ID);
	p.surface = "inline";
	p.strokes = ids.map(stroke);
	return p;
}

function diskIds(fake: FakeAdapter): string[] {
	return parsePage(fake.files.get(LIVE)!, PAGE_ID).data.strokes.map((s) => s.id);
}

let fake: FakeAdapter;

async function drain(): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
	for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(0);
}

/** One device, wired the way main.ts:2033-2046 wires inlineInk.attachHost. */
function device(adapter: PageAdapterLike) {
	const store = new PageStore({ vault: { adapter } } as never, ".handwriting", () => 5_000_000);
	const ink = new InlineInkStore();
	ink.attachHost({
		readPageId: (p: string) => (p === PATH ? PAGE_ID : null),
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: (id: string) => store.load(id),
		scheduleSidecar: (id: string, p: PageData) => store.schedule(id, p),
		scheduleSidecarNow: (id: string, p: PageData) => store.saveNow(id, p),
		prepareExternalAdoption: (id: string, outgoing: PageData) => store.prepareExternalAdoption(id, outgoing),
		acceptExternalAdoption: (prepared: never) => store.acceptExternalAdoption(prepared),
		notify: () => {},
	} as never);
	return { store, ink };
}

/** One tick of the real live-reload poll block sliced from main.ts. */
function pollBridge(d: { store: PageStore; ink: InlineInkStore }, paths: string[] = [PATH]) {
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
		() => {},
		() => {},
		() => null,
		async () => false,
		{ error: () => {} },
		(p: string) => (paths.includes(p) ? () => paths.includes(p) : null)
	);
	return {
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

describe("L-errors-1: keep-mine on a loaded note", () => {
	it("shows the kept revision and the next edit keeps it on disk", async () => {
		// This device: note loaded, has drawn "local" on top of "a", settled.
		fake.files.set(LIVE, serializePage(page(["a"])));
		fake.mtimes.set(LIVE, ++fake.clock);
		const d = device(fake);
		await d.ink.ensureLoaded(PATH);
		d.ink.commit(PATH, stroke("local"));
		await drain();
		expect(diskIds(fake)).toEqual(["a", "local"]);
		expect(d.store.hasQueuedWrite(PAGE_ID)).toBe(false);

		// The other device replaced the sidecar with ["a", "green"] (sync).
		fake.externalWrite(LIVE, serializePage(page(["a", "green"])));
		const poll = pollBridge(d);
		await poll.tick();

		// PRECONDITION: the real poll adopted the incoming revision and
		// registered a fork the user must decide.
		expect(d.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "green"]);
		const forks = listForks();
		expect(forks.map((f) => f.pageId)).toEqual([PAGE_ID]);

		// The fork host main.ts builds (forkHostFor), with its open-note restore.
		const host: ForkHost = forkHostFor({
			adapter: {
				read: (p) => fake.read(p),
				stat: (p) => fake.stat(p),
				list: async (folder) => ({ files: [...fake.files.keys()].filter((k) => k.startsWith(folder + "/")) }),
			},
			store: d.store,
			restoreOpen: async (pageId, data) => (await d.ink.restoreRevision(pageId, data)) !== null,
		});
		const account = await describeFork(host, forks[0]!);
		expect(account.needsDecision).toBe(true);
		expect(account.mineOnly).toBe(1);
		expect(account.theirsOnly).toBe(1);

		// The user clicks "Keep this device's ink".
		const out = await applyForkDecision(host, forks[0]!, "keep-mine");
		expect(out).toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		// PRECONDITION: keep-mine did put this device's revision on disk.
		expect(diskIds(fake)).toEqual(["a", "local"]);
		const filesAfterKeep = [...fake.files.keys()].sort();

		// Live-reload keeps running (once inside the 5 s window, once after).
		await poll.tick();
		vi.setSystemTime(Date.now() + 6000);
		await vi.advanceTimersByTimeAsync(6000);
		await poll.tick();

		const screenAfterKeep = d.ink.strokes(PATH).map((s) => s.id);
		console.log("[L-errors-1] screen after keep-mine + 2 poll ticks:", JSON.stringify(screenAfterKeep));
		console.log("[L-errors-1] disk after keep-mine + 2 poll ticks:", JSON.stringify(diskIds(fake)));

		// The user draws one more stroke on the note.
		d.ink.commit(PATH, stroke("new"));
		await drain();
		const diskAfterEdit = diskIds(fake);
		const filesAfterEdit = [...fake.files.keys()].sort();
		console.log("[L-errors-1] disk after next edit:", JSON.stringify(diskAfterEdit));
		console.log("[L-errors-1] files after keep:", JSON.stringify(filesAfterKeep));
		console.log("[L-errors-1] files after edit:", JSON.stringify(filesAfterEdit));

		// CORRECT BEHAVIOUR 1: the screen shows the revision the user kept.
		expect.soft(screenAfterKeep, "screen after keep-mine").toEqual(["a", "local"]);
		// CORRECT BEHAVIOUR 2: the next edit builds on the kept revision; the
		// kept stroke survives on the live sidecar and the rejected one does
		// not come back.
		expect(diskAfterEdit, "live sidecar after the next edit").toContain("local");
		expect(diskAfterEdit, "live sidecar after the next edit").not.toContain("green");
	});
});
