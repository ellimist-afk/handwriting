/**
 * Audit probe L-persist-3 (1.4.21, 1a05f62c). Runs the REAL InlineInkStore,
 * PageStore, ForkResolution and the real main.ts live-reload poll (sliced and
 * executed by LiveReloadTestHarness) over an in-memory vault.
 *
 * Trigger: a fork is adopted on an open note, the user draws a2, then runs
 * "fix ink de-sync" and picks "Keep this device's ink".
 *
 * Asserts the CORRECT behaviour, so a red means the claimed bug is real:
 *  1. after keep-mine the note on screen agrees with the live sidecar;
 *  2. ink drawn after the fork (a2) is still in some file on disk;
 *  3. the next stroke does not silently undo the kept revision.
 *
 * Device setup and the poll bridge are copied from
 * src/persistence/InlineExternalAdoptionPreservation.test.ts (scaffolding, not
 * logic under test). The ForkHost mirrors main.ts:2501-2510 one line for one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore, PageAdapterLike, recoverExactPage } from "../persistence/PageStore";
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

function page(strokeIds: string[]): PageData {
	const p = emptyPage(PAGE_ID);
	p.surface = "inline";
	p.strokes = strokeIds.map(stroke);
	return p;
}

let fake: FakeAdapter;

interface Device {
	store: PageStore;
	ink: InlineInkStore;
}

function device(adapter: PageAdapterLike): Device {
	const store = new PageStore({ vault: { adapter } } as never, ".handwriting", () => 5_000_000);
	const ink = new InlineInkStore();
	// Same wiring as main.ts:2033-2046.
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

async function drain(): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
	for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(0);
}

/** One tick of the real main.ts poll (copied bridge from the adoption suite). */
function pollBridge(d: Device, paths: string[] = [PATH]): { tick: () => Promise<void> } {
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

function idsIn(text: string): string[] {
	const parsed = parsePage(text, PAGE_ID);
	return recoverExactPage(parsed.data).strokes.map((s) => s.id);
}

function liveIds(): string[] {
	return idsIn(fake.files.get(LIVE)!);
}

/** Every file in the ink folder (live, artifacts, conflict copies) that holds `id`. */
function filesHolding(id: string): string[] {
	const out: string[] = [];
	for (const [path, text] of fake.files) {
		if (!path.startsWith(".handwriting/") || !path.endsWith(".json")) continue;
		const parsed = parsePage(text, PAGE_ID);
		const plain = parsed.data.strokes.map((s) => s.id);
		const exact = recoverExactPage(parsed.data).strokes.map((s) => s.id);
		if (plain.includes(id) || exact.includes(id)) out.push(path);
	}
	return out;
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	resetForks();
});

afterEach(() => {
	resetForks();
	vi.useRealTimers();
});

describe("L-persist-3: keep-mine on an open note", () => {
	it("keeps screen, disk and post-fork ink consistent", async () => {
		// Device A: note open, sidecar [a], draws `local` (this device's side).
		fake.files.set(LIVE, serializePage(page(["a"])));
		fake.mtimes.set(LIVE, ++fake.clock);
		const a = device(fake);
		await a.ink.ensureLoaded(PATH);
		a.ink.commit(PATH, stroke("local"));
		await drain();
		expect(liveIds()).toEqual(["a", "local"]);
		expect(a.store.hasQueuedWrite(PAGE_ID)).toBe(false);

		// The other device's revision lands via sync: [a, green], no `local`.
		fake.externalWrite(LIVE, serializePage(page(["a", "green"])));

		// The real poll adopts it and registers the fork.
		const poll = pollBridge(a);
		await poll.tick();
		expect(a.ink.strokes(PATH).map((s) => s.id), "precondition: adopted").toEqual(["a", "green"]);
		const rec = listForks().find((r) => r.pageId === PAGE_ID);
		expect(rec, "precondition: fork registered").toBeDefined();

		// User keeps working: draws a2 after the fork.
		a.ink.commit(PATH, stroke("a2"));
		await drain();
		expect(liveIds(), "precondition: a2 saved").toEqual(["a", "green", "a2"]);
		expect(a.store.hasQueuedWrite(PAGE_ID)).toBe(false);

		// "fix ink de-sync": the host main.ts builds (forkHostFor), with its open-note restore.
		const host: ForkHost = forkHostFor({
			adapter: { read: (p) => fake.read(p), stat: (p) => fake.stat(p) },
			store: a.store,
			restoreOpen: async (pageId, data) => (await a.ink.restoreRevision(pageId, data)) !== null,
		});
		const account = await describeFork(host, rec!);
		expect(account.needsDecision, "precondition: the modal offers this fork").toBe(true);
		expect(account.mineOnly).toBe(1);

		const conflictCopiesBefore = [...fake.files.keys()].filter((k) => k.includes(".conflict") && !k.includes("-external-"));
		const out = await applyForkDecision(host, rec!, "keep-mine");
		expect(out).toMatchObject({ kind: "applied", wrote: true });
		await drain();
		const liveAfterKeep = liveIds();
		const conflictCopiesAfter = [...fake.files.keys()].filter((k) => k.includes(".conflict") && !k.includes("-external-"));
		// Readout for the verifier.
		console.log("live after keep-mine:", JSON.stringify(liveAfterKeep));
		console.log("screen after keep-mine:", JSON.stringify(a.ink.strokes(PATH).map((s) => s.id)));
		console.log("non-artifact conflict copies before/after:", JSON.stringify(conflictCopiesBefore), JSON.stringify(conflictCopiesAfter));
		console.log("externallyChanged after keep-mine:", await a.store.externallyChanged(PAGE_ID));

		// The poll runs again; nothing should be left inconsistent after it.
		await poll.tick();
		console.log("screen after next poll tick:", JSON.stringify(a.ink.strokes(PATH).map((s) => s.id)));
		console.log("files holding a2:", JSON.stringify(filesHolding("a2")));
		console.log("queued write after keep-mine + tick (what an unload flush would write):", a.store.hasQueuedWrite(PAGE_ID));

		// CORRECT 1: the open note shows what the live sidecar holds.
		expect.soft(a.ink.strokes(PATH).map((s) => s.id), "screen must match the live file after keep-mine").toEqual(liveIds());
		// CORRECT 2: ink drawn after the fork is still in some file.
		expect.soft(filesHolding("a2"), "a2 (drawn after the fork) must survive in some file").not.toEqual([]);

		// User draws again.
		a.ink.commit(PATH, stroke("a3"));
		await drain();
		console.log("live after next stroke:", JSON.stringify(liveIds()));
		// CORRECT 3: the kept revision's stroke is not silently dropped by the next edit.
		expect.soft(liveIds(), "next stroke must not undo keep-mine").toContain("local");
	});
});
