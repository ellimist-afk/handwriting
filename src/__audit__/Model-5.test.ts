/**
 * Audit probe Model-5 (1.4.21, 1a05f62c). Read-only probe of the REAL
 * PageStore + InlineInkStore + the real main.ts live-reload poll block
 * (installLiveReloadPoll) + the real ForkResolution register + the real
 * ForkResolutionModal (onOpen and its three buttons, clicked).
 *
 * Claim: fork decisions do not stick. forgetFork only drops the in-memory
 * entry, the command re-scans the ink folder (refreshForks) on every run and
 * the artifacts are never deleted, so a resolved fork comes back on the next
 * run. And "Take the other" writes nothing, so after "Keep this device's ink"
 * it is a silent no-op that leaves this device's ink live.
 *
 * Asserts the CORRECT behaviour, so a red means the bug is real. Scaffolding
 * (device(), pollBridge(), drain(), forkHost()) copied from Model-1.test.ts,
 * which copied it from src/persistence/InlineExternalAdoptionPreservation.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
	Modal: class {
		app: unknown;
		constructor(app: unknown) {
			this.app = app;
		}
	},
	Notice: class {
		constructor(msg: string) {
			notices.push(msg);
		}
	},
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
	forkHostFor,
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

/** The fork host main.ts builds for the command (forkHostFor), over the same adapter. */
function forkHost(d: { store: PageStore; ink: InlineInkStore }): ForkHost {
	return forkHostFor({
		adapter: {
			read: (p) => fake.read(p),
			stat: (p) => fake.stat(p),
			rename: (from, to) => fake.rename(from, to),
			// Obsidian's adapter.list(folder).files: vault-relative paths.
			list: async (folder) => ({ files: [...fake.files.keys()].filter((k) => k.startsWith(`${folder}/`)) }),
		},
		store: d.store,
		restoreOpen: async (pageId, data) => (await d.ink.restoreRevision(pageId, data)) !== null,
	});
}

interface Opened {
	content: FakeEl;
	texts(): string[];
	button(label: string): FakeEl | null;
}

function textsOf(content: FakeEl): string[] {
	const out: string[] = [];
	const walk = (el: FakeEl): void => {
		if (el.textContent) out.push(el.textContent);
		for (const c of el.children) walk(c);
	};
	walk(content);
	return out;
}

function findButton(el: FakeEl, label: string): FakeEl | null {
	for (const c of el.children) {
		if (c.tagName === "button" && c.textContent === label) return c;
		const deep = findButton(c, label);
		if (deep) return deep;
	}
	return null;
}

/** What the command callback (main.ts:2501-2517) does: refreshForks, then open the modal. */
async function runFixInkDesync(d: { store: PageStore; ink: InlineInkStore }): Promise<Opened> {
	const host = forkHost(d);
	await refreshForks(host, d.store.inkFolder());
	const modal = new ForkResolutionModal({} as never, host);
	const content = new FakeEl("div", new FakeDoc());
	(modal as unknown as { contentEl: FakeEl }).contentEl = content;
	await modal.onOpen();
	return {
		content,
		texts: () => textsOf(content),
		button: (label) => findButton(content, label),
	};
}

/** Click a modal button and let the decision and the modal's re-render settle. */
async function click(opened: Opened, label: string): Promise<void> {
	const btn = opened.button(label);
	expect(btn, `precondition: the modal shows a "${label}" button`).not.toBeNull();
	btn!.fire("click");
	await drain();
}

function pairs(): Array<{ outgoing: string; incoming: string }> {
	const out = new Map<string, { outgoing?: string; incoming?: string }>();
	for (const k of fake.files.keys()) {
		const m = /^\.handwriting\/p1\.conflict-external-([0-9a-f]+)-(outgoing|incoming)\.json$/.exec(k);
		if (!m) continue;
		const e = out.get(m[1]!) ?? {};
		if (m[2] === "outgoing") e.outgoing = k;
		else e.incoming = k;
		out.set(m[1]!, e);
	}
	return [...out.values()].map((e) => ({ outgoing: e.outgoing!, incoming: e.incoming! }));
}

function ids(path: string): string[] {
	return parsePage(fake.files.get(path)!, PAGE_ID).data.strokes.map((s) => s.id);
}

/**
 * Device A: loaded, drew "local" (never synced to B), settled on disk.
 * B's sync [a, b1] arrives (lacks "local": a real fork), the poll adopts it.
 */
async function realFork(): Promise<{
	d: { store: PageStore; ink: InlineInkStore };
	poll: { tick: () => Promise<void> };
	pair: { outgoing: string; incoming: string };
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

	fake.externalWrite(LIVE, bytes(["a", "b1"]));
	await poll.tick();
	expect(d.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "b1"]);
	const all = pairs();
	expect(all, "precondition: the adoption preserved exactly one pair").toHaveLength(1);
	const pair = all[0]!;
	expect(ids(pair.outgoing)).toEqual(["a", "local"]);
	expect(ids(pair.incoming)).toEqual(["a", "b1"]);
	expect(ids(LIVE)).toEqual(["a", "b1"]);
	return { d, poll, pair };
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	notices.length = 0;
	resetForks();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	resetForks();
});

describe("Model-5: fork decisions stick", () => {
	for (const [label, decision] of [
		[COPY.takeTheirs, "take-theirs"],
		[COPY.keepMine, "keep-mine"],
	] as const) {
		it(`a fork resolved with "${label}" is not listed again on the next 'fix ink de-sync'`, async () => {
			const { d, pair } = await realFork();

			// First run: the real fork is listed with its three buttons.
			const first = await runFixInkDesync(d);
			expect(first.texts(), "precondition: the first run lists the fork").toContain(COPY.headline);

			await click(first, label);
			// Precondition: the decision was applied (no refusal) and the same
			// modal re-rendered from the register with the fork gone.
			expect(notices, "precondition: no refusal notice").toEqual([]);
			expect(first.texts(), "precondition: the open modal drops the fork after the decision").toEqual([COPY.empty]);
			if (decision === "keep-mine") {
				expect(ids(LIVE), "precondition: keep-mine wrote this device's revision live").toEqual(["a", "local"]);
			} else {
				expect(ids(LIVE), "precondition: take-theirs left the other revision live").toEqual(["a", "b1"]);
			}
			// The artifacts are kept, never deleted: renamed to the resolved name.
			const resolved = (p: string) => p.replace(".conflict-external-", ".conflict-resolved-");
			expect(fake.files.has(resolved(pair.outgoing)) && fake.files.has(resolved(pair.incoming))).toBe(true);

			// Correct behaviour: the next run of the command does not re-list it.
			const second = await runFixInkDesync(d);
			const texts = second.texts();
			console.log(`[${decision}] SECOND RUN TEXT:`, JSON.stringify(texts), "REGISTER:", JSON.stringify(listForks().map((r) => r.outgoingPath)));
			expect.soft(texts, "a decided fork must not come back on the next run").not.toContain(COPY.headline);
			expect.soft(texts, "the next run must say there is nothing to fix").toEqual([COPY.empty]);
		});
	}

	// Restated: a decided fork is no longer listed again, so "Take the other"
	// after "Keep this device's ink" cannot be reached. The case that remains is
	// "Keep both", ink drawn since, then "Take the other": the live page is no
	// longer the other device's revision, so taking it must write it, and the
	// ink drawn since must survive in a file.
	it("'Take the other' after 'Keep both' and new ink writes the other device's revision and keeps the new ink in a file", async () => {
		const { d, poll, pair } = await realFork();

		const first = await runFixInkDesync(d);
		await click(first, COPY.keepBoth);
		expect(notices, "precondition: keep both was not refused").toEqual([]);
		d.ink.commit(PATH, stroke("since"));
		await drain();
		expect(ids(LIVE), "precondition: the new stroke is live").toEqual(["a", "b1", "since"]);

		// The note stays open, the poll keeps running. Its own write is not a
		// new external revision, so no new pair appears.
		await poll.tick();
		expect(pairs(), "precondition: still the one original pair").toHaveLength(1);

		// The user runs the command again; the kept fork is still listed.
		const second = await runFixInkDesync(d);
		expect(second.texts(), "precondition: the command lists the kept fork").toContain(COPY.headline);
		const rec = listForks().find((r) => r.pageId === PAGE_ID)!;
		expect(rec.outgoingPath).toBe(pair.outgoing);
		expect(rec.incomingPath).toBe(pair.incoming);

		await click(second, COPY.takeTheirs);
		console.log("AFTER TAKE-THEIRS: live", JSON.stringify(ids(LIVE)), "notices", JSON.stringify(notices), "modal", JSON.stringify(second.texts()));
		// The modal treated it as applied: no refusal notice, fork dropped.
		expect(notices, "precondition: take-theirs reported no refusal").toEqual([]);
		expect(second.texts(), "precondition: the modal treated take-theirs as applied").toEqual([COPY.empty]);

		// Correct behaviour: the live page is now the other device's revision.
		expect.soft(ids(LIVE), "after 'Take the other' the live sidecar must hold the other device's revision").toEqual(["a", "b1"]);
		expect.soft(ids(LIVE), "this device's stroke must no longer be the live page").not.toContain("local");
		// The screen agrees, and the stroke drawn since is still in some file.
		expect.soft(d.ink.strokes(PATH).map((s) => s.id), "the screen must show the revision taken").toEqual(["a", "b1"]);
		const holding = [...fake.files.entries()].filter(([k, v]) => k !== LIVE && v.includes('"since"')).map(([k]) => k);
		expect.soft(holding, "the stroke drawn before 'Take the other' must survive in a file").not.toEqual([]);
	});
});
