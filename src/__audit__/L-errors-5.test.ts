/**
 * AUDIT PROBE L-errors-5 (read-only audit of tag 1a05f62c).
 *
 * Claim: a note rendered once while it had no handwriting-page-id is cached by
 * InlineInkStore as load="yes" with pageId=null. When sync later delivers the
 * id (frontmatter) and the sidecar another device wrote, nothing re-reads it:
 * ensureLoaded returns early at :531, the live-reload poll skips the note
 * because pageIdOf is null (main.ts:2312-2313), and inkPresence answers "none".
 *
 * Drive: a REAL InlineInkStore, a REAL PageStore over the in-memory FakeAdapter,
 * and the REAL live-reload poll block sliced out of main.ts. The host's
 * readPageId reads a mutable "frontmatter" flag, standing in for the metadata
 * cache before and after sync delivers the id.
 *
 * Asserts the CORRECT behaviour (the other device's ink shows once its id and
 * sidecar are on disk). Goes red only if the stale load="yes" record holds.
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
const PAGE_ID = "p1";
const LIVE = ".handwriting/p1.json";

function stroke(id: string): InkStroke {
	const points = Array.from({ length: 12 }, (_, k) => ({
		x: 100 + k * 1.37,
		y: 200 + k * 0.91,
		pressure: 0.5,
		t: k * 8,
	}));
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points,
		bbox: { x: 100, y: 200, width: 16, height: 11 },
		createdAt: 0,
	};
}

function page(ids: string[]): PageData {
	const p = emptyPage(PAGE_ID);
	p.surface = "inline";
	p.strokes = ids.map((id) => stroke(id));
	return p;
}

let fake: FakeAdapter;

async function drain(): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
	for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(0);
}

function makeStores(frontmatter: { id: string | null }) {
	const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
	const ink = new InlineInkStore();
	const readPageIdCalls: string[] = [];
	ink.attachHost({
		readPageId: (p: string) => {
			readPageIdCalls.push(p);
			return p === PATH ? frontmatter.id : null;
		},
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: (id: string) => store.load(id),
		scheduleSidecar: (id: string, p: PageData) => store.schedule(id, p),
		scheduleSidecarNow: (id: string, p: PageData) => store.saveNow(id, p),
		prepareExternalAdoption: (id: string, outgoing: PageData) =>
			store.prepareExternalAdoption(id, outgoing),
		acceptExternalAdoption: (prepared: never) => store.acceptExternalAdoption(prepared),
		notify: () => {},
	} as never);
	return { store, ink, readPageIdCalls };
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("L-errors-5: note rendered before it had a page id, then synced ink arrives", () => {
	it("CONTROL: the same synced sidecar loads when the id is already there at first render", async () => {
		fake.externalWrite(LIVE, serializePage(page(["t1", "t2"])));
		const { ink } = makeStores({ id: PAGE_ID });
		await ink.ensureLoaded(PATH);
		await drain();
		expect(ink.strokes(PATH).map((s) => s.id)).toEqual(["t1", "t2"]);
		expect(ink.pageIdOf(PATH)).toBe(PAGE_ID);
		expect(ink.inkPresence(PATH)).toBe("ink");
	});

	it("reopening the note after sync delivered id + sidecar shows the other device's ink", async () => {
		const frontmatter: { id: string | null } = { id: null };
		const { ink, readPageIdCalls } = makeStores(frontmatter);

		// Desktop renders the untouched note (open, reading view or an embed).
		await ink.ensureLoaded(PATH);
		await drain();
		// PRECONDITION: the cached state the claim describes.
		expect(ink.isLoaded(PATH), "precondition: record is load=yes").toBe(true);
		expect(ink.pageIdOf(PATH), "precondition: pageId null").toBe(null);
		expect(ink.strokes(PATH)).toEqual([]);
		expect(readPageIdCalls.length).toBe(1);

		// Tablet inks the note for the first time; sync delivers both files.
		fake.externalWrite(LIVE, serializePage(page(["t1", "t2"])));
		frontmatter.id = PAGE_ID;

		// The user reopens the note: InkOverlay.loadInk -> ensureLoaded(path).
		const changed = await ink.ensureLoaded(PATH);
		await drain();
		const callsAfterReopen = readPageIdCalls.length;
		console.log(
			`[L-errors-5] reopen: changed=${changed} readPageId calls=${callsAfterReopen} ` +
				`pageIdOf=${ink.pageIdOf(PATH)} strokes=${ink.strokes(PATH).length} ` +
				`inkPresence=${ink.inkPresence(PATH)}`
		);
		// The mechanism: the reopen did not even ask metadata again.
		expect(callsAfterReopen, "reopen re-read the id from metadata").toBeGreaterThan(1);
		// CORRECT BEHAVIOUR.
		expect(ink.strokes(PATH).map((s) => s.id), "other device's ink after reopen").toEqual([
			"t1",
			"t2",
		]);
	});

	it("inkPresence does not answer a certain \"none\" once the id and sidecar exist", async () => {
		const frontmatter: { id: string | null } = { id: null };
		const { ink } = makeStores(frontmatter);
		await ink.ensureLoaded(PATH);
		await drain();
		expect(ink.isLoaded(PATH)).toBe(true);
		fake.externalWrite(LIVE, serializePage(page(["t1", "t2"])));
		frontmatter.id = PAGE_ID;
		// Eraser / Delete all ink ask this; "none" means "certainly empty".
		expect(ink.inkPresence(PATH)).not.toBe("none");
	});

	it("the real live-reload poll picks up the synced ink while the note stays open", async () => {
		const frontmatter: { id: string | null } = { id: null };
		const { store, ink } = makeStores(frontmatter);
		await ink.ensureLoaded(PATH);
		await drain();
		expect(ink.isLoaded(PATH)).toBe(true);
		expect(ink.pageIdOf(PATH)).toBe(null);

		const statted: string[] = [];
		const realChanged = store.externallyChanged.bind(store);
		(store as unknown as { externallyChanged: typeof realChanged }).externallyChanged = (
			id: string,
			inc?: boolean
		) => {
			statted.push(id);
			return realChanged(id, inc);
		};

		let fire!: () => void;
		let pending: Promise<void> = Promise.resolve();
		const errors: unknown[][] = [];
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
			{ setInterval(fn: () => void) { fire = fn; return 1; } },
			{ hidden: false },
			(promise: Promise<void>) => { pending = promise.catch((e) => { errors.push([e]); }); },
			() => [PATH],
			ink,
			() => {},
			() => {},
			() => null,
			async () => false,
			{ error: (...a: unknown[]) => errors.push(a) },
			(p: string) => (p === PATH ? () => true : null)
		);

		fake.externalWrite(LIVE, serializePage(page(["t1", "t2"])));
		frontmatter.id = PAGE_ID;

		for (let i = 0; i < 5; i++) {
			fire();
			await pending;
			await drain();
		}
		console.log(
			`[L-errors-5] poll: ticks=${host.pollStats.ticks} statted=${JSON.stringify(statted)} ` +
				`pageIdOf=${ink.pageIdOf(PATH)} strokes=${ink.strokes(PATH).length} errors=${errors.length}`
		);
		expect(host.pollStats.ticks, "precondition: poll ticked").toBeGreaterThan(0);
		expect(errors).toEqual([]);
		// CORRECT BEHAVIOUR.
		expect(ink.strokes(PATH).map((s) => s.id), "other device's ink via live reload").toEqual([
			"t1",
			"t2",
		]);
	});
});
