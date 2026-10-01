/**
 * Audit probe R5-L-async-2 (1.4.21, tag 1a05f62c). Read-only verifier probe.
 *
 * Claim: a note closed and reopened later in the session is served from its
 * cached InlineInkStore record (ensureLoaded returns early for load="yes"), so
 * another device's newer sidecar is not read on reopen; a stroke committed
 * before the next live-reload check queues a write, the poll refuses while it
 * is queued, and writeNow's external guard renames the other device's file to
 * a conflict copy while the stale record plus the new stroke becomes live.
 *
 * Production pieces: the REAL PageStore over the house FakeAdapter, the REAL
 * InlineInkStore wired as main.ts:2036-2037 wires it, and the REAL live-reload
 * poll extracted from main.ts by LiveReloadTestHarness. The only thing modelled
 * is which notes have a mounted editor (inlineReloadCandidates): [] while the
 * note is closed, [PATH] after it is reopened. Reopen = what InkOverlay.loadInk
 * (InkOverlay.ts:2721) does for the new plugin instance: inlineInk.ensureLoaded.
 *
 * Assertions state the CORRECT behaviour, so a red means the bug is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
	Notice: class {},
}));

import { installLiveReloadPoll } from "../testUtils/LiveReloadTestHarness";
import { PageStore, type PreparedExternalAdoption } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { InlineInkStore } from "../inline/InlineInkStore";
import { PageData, emptyPage, serializePage, parsePage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";

const DEBOUNCE_MS = 700;
const PATH = "note.md";
const PAGE_ID = "p1";

function stroke(id: string): InkStroke {
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
	} as InkStroke;
}

function pageWith(...ids: string[]): PageData {
	const p = emptyPage(PAGE_ID);
	p.surface = "inline";
	p.strokes = ids.map(stroke);
	return p;
}

let fake: FakeAdapter;
let store: PageStore;
let inlineInk: InlineInkStore;
let fireTick!: () => void;
let pending: Promise<void> = Promise.resolve();
let pollErrors: unknown[][] = [];
let conflicts: Array<[string, string]> = [];
let livePath!: string;
/** Which notes have a mounted editor right now (InkOverlay instances). */
let mounted: string[] = [];

function idsInSession(): string[] {
	return inlineInk.strokes(PATH).map((s) => s.id);
}

function idsOnDisk(path: string): string[] {
	const raw = fake.files.get(path);
	if (raw === undefined) return [];
	return parsePage(raw, PAGE_ID).data.strokes.map((s) => s.id);
}

function conflictCopies(): string[] {
	return [...fake.files.keys()].filter(
		(k) => k !== livePath && k.includes(PAGE_ID) && !k.endsWith(".tmp")
	);
}

async function tick(): Promise<void> {
	fireTick();
	await pending;
	await vi.advanceTimersByTimeAsync(0);
}

beforeEach(async () => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	pollErrors = [];
	conflicts = [];
	mounted = [];
	store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
	store.onConflict = (pageId, keptAs) => {
		conflicts.push([pageId, keptAs]);
	};
	inlineInk = new InlineInkStore();
	inlineInk.attachHost({
		readPageId: (path: string) => (path === PATH ? PAGE_ID : null),
		claimId: async (_path: string, proposedId: string) => ({ pageId: proposedId }),
		loadSidecar: (pageId: string) => store.load(pageId),
		scheduleSidecar: (pageId: string, page: PageData) => store.schedule(pageId, page),
		scheduleSidecarNow: (pageId: string, page: PageData) => store.saveNow(pageId, page),
		prepareExternalAdoption: (pageId: string, outgoing: PageData) =>
			store.prepareExternalAdoption(pageId, outgoing),
		acceptExternalAdoption: (prepared: PreparedExternalAdoption) =>
			store.acceptExternalAdoption(prepared),
		// As main.ts wires it: a reopened note asks whether its sidecar changed.
		sidecarChanged: (pageId: string) => store.externallyChanged(pageId),
		notify: () => {},
	} as never);

	const host = {
		store,
		pdfInk: new Map(),
		pdfIds: new Map(),
		pollStats: { ticks: 0, hidden: 0, spaced: 0, checks: 0 },
		registerInterval(handle: number) {
			return handle;
		},
	};
	installLiveReloadPoll.call(
		host,
		{
			setInterval(fn: () => void) {
				fireTick = fn;
				return 1;
			},
		},
		{ hidden: false },
		(promise: Promise<void>) => {
			pending = promise.catch((e: unknown) => {
				pollErrors.push([e]);
			});
		},
		() => [...mounted],
		inlineInk,
		() => {},
		() => {},
		() => null,
		async () => false,
		{ error: (...args: unknown[]) => pollErrors.push(args) },
		() => () => true
	);

	// Device A: the note's sidecar exists and the note is opened, so its ink
	// loads into the module-level session record.
	store.schedule(PAGE_ID, pageWith("s1"));
	await vi.runAllTimersAsync();
	livePath = [...fake.files.keys()].find((k) => k.includes(PAGE_ID) && !k.endsWith(".tmp"))!;
	expect(livePath).toBeTruthy();
	mounted = [PATH];
	await inlineInk.ensureLoaded(PATH);
	expect(idsInSession()).toEqual(["s1"]);
	expect(inlineInk.isLoaded(PATH)).toBe(true);

	// Device A leaves the note (tab switch / close): no mounted editor. The
	// record is NOT dropped (only rename/delete/declaim remove it).
	mounted = [];
	// Device B, on the same synced vault, adds s3; sync delivers the file.
	fake.externalWrite(livePath, serializePage(pageWith("s1", "s3")));
	// The poll keeps running while the note is closed: no candidate, no read.
	for (let i = 0; i < 6; i++) await tick();
	expect(idsOnDisk(livePath)).toEqual(["s1", "s3"]); // precondition: newer ink is on disk
	expect(idsInSession()).toEqual(["s1"]); // still closed; nothing adopted yet
});

describe("R5-L-async-2: reopening a note after another device wrote its sidecar", () => {
	it("reopen shows the other device's newer ink (ensureLoaded re-reads or checks freshness)", async () => {
		mounted = [PATH];
		// What InkOverlay.loadInk does for the rebuilt plugin on reopen.
		await inlineInk.ensureLoaded(PATH);
		expect(pollErrors).toEqual([]);
		expect(idsInSession()).toContain("s3");
	});

	it("a stroke drawn right after reopen does not push the other device's ink into a conflict copy", async () => {
		mounted = [PATH];
		await inlineInk.ensureLoaded(PATH);
		// User writes before the next live-reload check lands.
		inlineInk.commit(PATH, stroke("s2"));
		expect(store.hasQueuedWrite(PAGE_ID)).toBe(true); // precondition: a write is queued
		// A poll tick in the debounce window (a check refuses on hasQueuedWrite,
		// or it is a spaced tick): either way it must not be what saves s3.
		await tick();
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
		await vi.runAllTimersAsync();
		expect(pollErrors).toEqual([]);
		expect(store.hasQueuedWrite(PAGE_ID)).toBe(false); // the write landed
		// Correct: the live sidecar holds both devices' ink and nothing was
		// shunted aside into a conflict file.
		const live = idsOnDisk(livePath);
		const copies = conflictCopies().map((k) => ({ k, ids: idsOnDisk(k) }));
		expect(
			{ live, copies, conflicts: conflicts.length },
			"live sidecar after reopen + stroke"
		).toEqual({ live: expect.arrayContaining(["s1", "s2", "s3"]), copies: [], conflicts: 0 });
	});

	it("CONTROL (expected green): if the poll checks before the stroke, the same stroke keeps both devices' ink", async () => {
		mounted = [PATH];
		await inlineInk.ensureLoaded(PATH);
		// Let the poll reach a real check while the record is clean.
		for (let i = 0; i < 6 && !idsInSession().includes("s3"); i++) await tick();
		expect(idsInSession()).toContain("s3");
		inlineInk.commit(PATH, stroke("s2"));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
		await vi.runAllTimersAsync();
		expect(pollErrors).toEqual([]);
		expect(idsOnDisk(livePath)).toEqual(expect.arrayContaining(["s1", "s2", "s3"]));
		expect(conflicts.length).toBe(0);
	});
});
