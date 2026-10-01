/**
 * Audit probe Model-1 (1.4.21, 1a05f62c). Read-only probe of the REAL
 * PageStore + InlineInkStore + the real main.ts live-reload poll block
 * (installLiveReloadPoll) + the real ForkResolution register + the real
 * ForkResolutionModal.onOpen.
 *
 * Claim: a real ink fork (this device's strokes displaced by a sync) becomes
 * unreachable from "fix ink de-sync" once the other device syncs the same note
 * again, because the register keeps one pair per page and the routine superset
 * pair replaces the real one.
 *
 * Asserts the CORRECT behaviour (the displaced strokes stay listed), so a red
 * means the bug is real. Scaffolding (device(), pollBridge(), drain()) copied
 * from src/persistence/InlineExternalAdoptionPreservation.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
	Modal: class {
		app: unknown;
		constructor(app: unknown) {
			this.app = app;
		}
	},
	Notice: class {},
}));

import { PageStore, PageAdapterLike } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { InlineInkStore } from "../inline/InlineInkStore";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";
import { installLiveReloadPoll } from "../testUtils/LiveReloadTestHarness";
import {
	FORK_COPY_PLACEHOLDER as COPY,
	ForkHost,
	describeFork,
	listForks,
	refreshForks,
	resetForks,
} from "../persistence/ForkResolution";
import { ForkResolutionModal } from "../persistence/ForkResolutionModal";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";

const DEBOUNCE_MS = 700;
const PATH = "note.md";
const PAGE_ID = "p1";
const FOLDER = ".handwriting";
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
	const p: PageData = emptyPage(PAGE_ID);
	p.surface = "inline";
	p.strokes = ids.map(stroke);
	return serializePage(p);
}

let fake: FakeAdapter;

function device(adapter: PageAdapterLike): { store: PageStore; ink: InlineInkStore } {
	const store = new PageStore({ vault: { adapter } } as never, FOLDER, () => 5_000_000);
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

async function drain(): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
	for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(0);
}

/** One tick of the REAL main.ts poll block, as the adoption suite runs it. */
function pollBridge(d: { store: PageStore; ink: InlineInkStore }): { tick: () => Promise<void> } {
	let fire!: () => void;
	let pending = Promise.resolve();
	const paths = [PATH];
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

/** The ForkHost main.ts builds for the command, over the same adapter. */
function forkHost(store: PageStore, order: (names: string[]) => string[] = (n) => n): ForkHost {
	return {
		read: async (p) => (fake.files.has(p) ? fake.files.get(p)! : null),
		stat: async (p) => fake.stat(p),
		saveNow: (pageId, data) => store.saveNow(pageId, data),
		// Obsidian's adapter.list(folder).files: vault-relative paths.
		list: async (folder) => order([...fake.files.keys()].filter((k) => k.startsWith(`${folder}/`))),
	};
}

/** What the command does: refreshForks, then the modal's onOpen. Returns the modal's text. */
async function runFixInkDesync(host: ForkHost, folder: string): Promise<string[]> {
	await refreshForks(host, folder);
	const modal = new ForkResolutionModal({} as never, host);
	const content = new FakeEl("div", new FakeDoc());
	(modal as unknown as { contentEl: FakeEl }).contentEl = content;
	await modal.onOpen();
	const texts: string[] = [];
	const walk = (el: FakeEl): void => {
		if (el.textContent) texts.push(el.textContent);
		for (const c of el.children) walk(c);
	};
	walk(content);
	return texts;
}

function pairs(): Array<{ token: string; outgoing: string; incoming: string }> {
	const out = new Map<string, { token: string; outgoing?: string; incoming?: string }>();
	for (const k of fake.files.keys()) {
		const m = /^\.handwriting\/p1\.conflict-external-([0-9a-f]+)-(outgoing|incoming)\.json$/.exec(k);
		if (!m) continue;
		const e = out.get(m[1]!) ?? { token: m[1]! };
		if (m[2] === "outgoing") e.outgoing = k;
		else e.incoming = k;
		out.set(m[1]!, e);
	}
	return [...out.values()].map((e) => ({ token: e.token, outgoing: e.outgoing!, incoming: e.incoming! }));
}

function ids(path: string): string[] {
	return parsePage(fake.files.get(path)!, PAGE_ID).data.strokes.map((s) => s.id);
}

/**
 * Device A: loaded, drew "local" (never synced to B), settled on disk.
 * B's first sync [a, b1] arrives (lacks "local": a real fork), the poll adopts.
 * B's second sync [a, b1, b2] arrives (routine superset), the poll adopts.
 * The routine sync loses nothing, so it writes no pair of its own; before the
 * fix it wrote one, and that pair replaced the real fork's register entry.
 * Returns the one pair, identified by content.
 */
async function scenario(): Promise<{
	d: { store: PageStore; ink: InlineInkStore };
	p1: { token: string; outgoing: string; incoming: string };
	textAfterFirst: string[];
}> {
	fake.files.set(LIVE, bytes(["a"]));
	fake.mtimes.set(LIVE, ++fake.clock);
	const d = device(fake);
	await d.ink.ensureLoaded(PATH);
	d.ink.commit(PATH, stroke("local"));
	await drain();
	expect(ids(LIVE)).toEqual(["a", "local"]);
	expect(d.store.hasQueuedWrite(PAGE_ID)).toBe(false);
	const poll = pollBridge(d);

	// Sync 1 from B: B never saw "local".
	fake.externalWrite(LIVE, bytes(["a", "b1"]));
	await poll.tick();
	expect(d.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "b1"]);
	expect(pairs()).toHaveLength(1);
	// Control: right after the real fork, the command lists it.
	const textAfterFirst = await runFixInkDesync(forkHost(d.store), d.store.inkFolder());

	// Sync 2 from B: B drew b2. A drew nothing in between (no save of its own).
	expect(d.store.hasQueuedWrite(PAGE_ID)).toBe(false);
	fake.externalWrite(LIVE, bytes(["a", "b1", "b2"]));
	await poll.tick();
	expect(d.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "b1", "b2"]);

	const all = pairs();
	expect(all, "the routine sync writes no pair of its own").toHaveLength(1);
	const p1 = all[0]!;
	expect(ids(p1.outgoing)).toEqual(["a", "local"]);
	expect(ids(p1.incoming)).toEqual(["a", "b1"]);
	// Nothing else holds "local" any more: live file and record are B's.
	expect(ids(LIVE)).toEqual(["a", "b1", "b2"]);
	return { d, p1, textAfterFirst };
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	resetForks();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	resetForks();
});

describe("Model-1: a real fork stays reachable after a later routine sync", () => {
	it("same session: 'fix ink de-sync' still lists the displaced strokes after B syncs again", async () => {
		const { d, p1, textAfterFirst } = await scenario();

		// Precondition/control: after the first sync alone, the modal listed a fork.
		expect(textAfterFirst).not.toContain(COPY.empty);
		expect(textAfterFirst).toContain(COPY.headline);

		// Precondition: P1 on its own IS a fork that needs a decision.
		const p1Account = await describeFork(forkHost(d.store), {
			pageId: PAGE_ID,
			path: PATH,
			outgoingPath: p1.outgoing,
			incomingPath: p1.incoming,
			at: 0,
		});
		expect(p1Account.needsDecision).toBe(true);
		expect(p1Account.mineOnly).toBe(1);

		// Correct behaviour: the command still offers the displaced "local" stroke.
		const text = await runFixInkDesync(forkHost(d.store), d.store.inkFolder());
		const registered = listForks().map((r) => r.outgoingPath);
		console.log("MODAL TEXT:", JSON.stringify(text), "REGISTER:", JSON.stringify(registered));
		expect.soft(
			registered,
			"register must still hold the pair with this device's displaced strokes"
		).toContain(p1.outgoing);
		expect.soft(text, "modal must not say there is nothing to fix").not.toContain(COPY.empty);
	});

	it("after restart: the scan still offers the displaced strokes when an older build's routine pair sorts first", async () => {
		// Force token order so P2's files sort ahead of P1's in a name-sorted listing.
		const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
		const fills = [0xff];
		vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((arr: Uint8Array) => {
			if (arr instanceof Uint8Array && arr.length === 8 && fills.length > 0) {
				arr.fill(fills.shift()!);
				return arr;
			}
			return real(arr as never);
		}) as never);
		const { d, p1 } = await scenario();
		expect(p1.token).toBe("ffffffffffffffff");
		// A routine pair an older build wrote for the second sync, still on disk:
		// not listed, not deleted, and it must not hide the real fork.
		const old = (leg: string) => LIVE.replace(/\.json$/, `.conflict-external-0000000000000000-${leg}.json`);
		fake.files.set(old("outgoing"), bytes(["a", "b1"]));
		fake.files.set(old("incoming"), bytes(["a", "b1", "b2"]));

		// Restart: the in-memory register is gone, the files are all on disk.
		resetForks();
		const text = await runFixInkDesync(forkHost(d.store, (n) => [...n].sort()), d.store.inkFolder());
		const registered = listForks().map((r) => r.outgoingPath);
		console.log("MODAL TEXT:", JSON.stringify(text), "REGISTER:", JSON.stringify(registered));
		expect.soft(
			registered,
			"after restart the scan must still reach the pair with the displaced strokes"
		).toContain(p1.outgoing);
		expect.soft(text, "modal must not say there is nothing to fix").not.toContain(COPY.empty);
	});
});
