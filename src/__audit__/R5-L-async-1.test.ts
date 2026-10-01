/**
 * AUDIT PROBE R5-L-async-1 (1.4.21, tag 1a05f62c). Read-only probe, not a fix.
 *
 * Claim: a blind write's displaced sidecar is only moved aside by a LATER
 * write. Live reload adopts the synced copy without writing, so the blind
 * `.handwriting/X.json` stays live; after a restart `findSidecar` hits the
 * configured folder first and the page is served from the blind copy for
 * good, hiding the synced ink that was on screen before the restart.
 *
 * Real production code only: PageStore, InlineInkStore, and one tick of the
 * real live-reload poll extracted from main.ts by LiveReloadTestHarness.
 * Assertions state the CORRECT behaviour; the probe goes red only if the
 * claimed fork is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { InlineInkStore } from "../inline/InlineInkStore";
import { PageData, emptyPage, serializePage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";
import { installLiveReloadPoll } from "../testUtils/LiveReloadTestHarness";

const DEBOUNCE_MS = 700;
const PATH = "note.md";
const ID = "X";
const BLIND = ".handwriting/X.json";
const SYNCED = "handwriting/X.json";

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
	const p = emptyPage(ID);
	p.surface = "inline";
	p.strokes = ids.map(stroke);
	return p;
}

let fake: FakeAdapter;

interface Device {
	store: PageStore;
	ink: InlineInkStore;
}

/** One Obsidian session on this device: host wiring copied from main.ts:2032-2046. */
function session(): Device {
	const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
	const ink = new InlineInkStore();
	ink.attachHost({
		readPageId: (p: string) => (p === PATH ? ID : null),
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

async function drain(): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
	for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(0);
}

/** One tick of the REAL main.ts live-reload poll (same bridge as InlineExternalAdoptionPreservation.test.ts). */
function pollBridge(d: Device): { tick: () => Promise<void>; painted: string[] } {
	const painted: string[] = [];
	const paths = [PATH];
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
		(p: string) => (paths.includes(p) ? () => paths.includes(p) : null)
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

function liveSidecars(): string[] {
	return [...fake.files.keys()]
		.filter((p) => p.endsWith(`/${ID}.json`) && !p.includes("/trash/"))
		.sort();
}

function ids(d: Device): string[] {
	return d.ink.strokes(PATH).map((s) => s.id);
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("R5-L-async-1: blind write, synced copy adopted, restart", () => {
	it("adopting the synced copy moves the blind file aside in the same session, keeping its ink", async () => {
		const s1 = session();
		await s1.ink.ensureLoaded(PATH);
		s1.ink.commit(PATH, stroke("local"));
		await drain();
		expect(liveSidecars(), "precondition: the blind write landed").toEqual([BLIND]);
		fake.externalWrite(SYNCED, serializePage(page(["remote1", "remote2"])));
		const poll = pollBridge(s1);
		await poll.tick();
		expect(ids(s1), "precondition: the synced copy was adopted").toEqual(["remote1", "remote2"]);
		// No write followed the adoption, and still only the synced file is live.
		expect(liveSidecars(), "the blind file is still a live sidecar after adoption").toEqual([SYNCED]);
		const keeping = [...fake.files.entries()].filter(([k, v]) => k !== SYNCED && v.includes('"local"')).map(([k]) => k);
		expect(keeping, "the blind file's ink was not kept anywhere").not.toEqual([]);
	});

	it("after a restart the note still shows the synced ink it showed before, and new ink goes to the synced file", async () => {
		// Session 1. The note arrived before its sidecar: nothing anywhere.
		const s1 = session();
		await s1.ink.ensureLoaded(PATH);
		expect(ids(s1)).toEqual([]);
		expect(liveSidecars()).toEqual([]);

		// The user draws one stroke: a blind write into the configured folder.
		s1.ink.commit(PATH, stroke("local"));
		await drain();
		// PRECONDITION: the blind write landed.
		expect(liveSidecars()).toEqual([BLIND]);
		expect(fake.files.get(BLIND)).toContain('"local"');

		// Sync delivers the other device's sidecar into `handwriting/`.
		fake.externalWrite(SYNCED, serializePage(page(["remote1", "remote2"])));

		// One tick of the real live-reload poll adopts it.
		const poll = pollBridge(s1);
		await poll.tick();
		// PRECONDITION: live reload adopted the synced copy; it is on screen.
		expect(poll.painted).toContain(PATH);
		expect(ids(s1)).toEqual(["remote1", "remote2"]);
		const liveAfterAdoption = liveSidecars();
		const writesAfterAdoption = fake.writes();

		// The user draws nothing more on this note and restarts Obsidian.
		const s2 = session();
		await s2.ink.ensureLoaded(PATH);

		// CORRECT: the note shows the ink it showed before the restart.
		expect
			.soft(ids(s2), `after restart; live sidecars at restart ${JSON.stringify(liveAfterAdoption)}; writes so far ${JSON.stringify(writesAfterAdoption)}`)
			.toEqual(["remote1", "remote2"]);

		// CORRECT: the next stroke lands in the synced file, one live sidecar.
		s2.ink.commit(PATH, stroke("after-restart"));
		await drain();
		expect.soft(fake.files.get(SYNCED) ?? "", "synced file after a post-restart stroke").toContain("after-restart");
		expect.soft(liveSidecars(), "live sidecars after a post-restart stroke").toEqual([SYNCED]);
	});

	it("variant: synced sidecar lands after the blind-writing session ended; the next session takes the synced copy", async () => {
		const s1 = session();
		await s1.ink.ensureLoaded(PATH);
		s1.ink.commit(PATH, stroke("local"));
		await drain();
		// PRECONDITION: the blind write landed.
		expect(liveSidecars()).toEqual([BLIND]);

		// Obsidian closed; sync then delivers the other device's copy.
		fake.externalWrite(SYNCED, serializePage(page(["remote1", "remote2"])));
		expect(liveSidecars()).toEqual([BLIND, SYNCED]);

		// Next session opens the note and the user draws.
		const s2 = session();
		await s2.ink.ensureLoaded(PATH);
		const loaded = ids(s2);
		s2.ink.commit(PATH, stroke("after-restart"));
		await drain();

		// CORRECT (the running-session contract of PageStore.test.ts:1311-1336):
		// ONE live sidecar, the synced one, carrying the new ink.
		expect.soft(liveSidecars(), `live sidecars after a stroke; session 2 loaded ${JSON.stringify(loaded)}`).toEqual([SYNCED]);
		expect.soft(fake.files.get(SYNCED) ?? "", "synced file after the stroke").toContain("after-restart");
	});
});
