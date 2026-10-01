/**
 * Fork decisions judged by what the strokes ARE, not only by their ids, and
 * forks found in every folder a page can be served from.
 *
 * Driven through the real PageStore, the real InlineInkStore, the real main.ts
 * poll block, the real fork register and the real ForkResolutionModal, with its
 * buttons clicked. What is asserted is what the screen lists and what is on
 * disk afterwards.
 *
 * Three gaps, each reachable on a real device:
 * - The other device lasso-moves a stroke. Preservation keeps this device's
 *   version (same id, different place), but the list asked only "is one of my
 *   ids missing", so the command said there was nothing to fix.
 * - "Take the other" after a lasso move of the other device's stroke: the ids
 *   still matched, so nothing was written and the fork was closed, with the
 *   moved ink left live. A failed write read back the same way.
 * - A page found in both folders with different ink is preserved beside the
 *   synced copy, and the command looked only in the configured folder.
 *
 * Controls: a pair where the other device only added, a byte-identical pair,
 * and a pair that differs only below the saved precision are not listed; a
 * decision whose revision is already live writes nothing; this device's
 * unrounded capture reads back as its own rounded write.
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

import { EXACT_OUTGOING_KEY, PageStore, PageAdapterLike } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { InlineInkStore } from "../inline/InlineInkStore";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";
import { installLiveReloadPoll } from "../testUtils/LiveReloadTestHarness";
import {
	FORK_COPY_PLACEHOLDER as COPY,
	ForkHost,
	applyForkDecision,
	forkHostFor,
	listForks,
	refreshForks,
	resetForks,
} from "./ForkResolution";
import { ForkResolutionModal } from "./ForkResolutionModal";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";

const DEBOUNCE_MS = 700;
const PATH = "note.md";
const PAGE_ID = "p1";
const HIDDEN = ".handwriting";
const SYNCED = "handwriting";

function stroke(id: string, dx = 0, dy = 0): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 1 + dx, y: 2 + dy, pressure: 0.5, t: 0 },
			{ x: 11 + dx, y: 6 + dy, pressure: 0.5, t: 8 },
		],
		bbox: { x: 1 + dx, y: 2 + dy, width: 10, height: 4 },
		createdAt: 0,
	};
}

function pageOf(strokes: InkStroke[]): PageData {
	const p: PageData = emptyPage(PAGE_ID);
	p.surface = "inline";
	p.strokes = strokes;
	return p;
}

function bytes(strokes: InkStroke[]): string {
	return serializePage(pageOf(strokes));
}

let fake: FakeAdapter;

type Device = { store: PageStore; ink: InlineInkStore };

function device(adapter: PageAdapterLike, folder = HIDDEN): Device {
	const store = new PageStore({ vault: { adapter } } as never, folder, () => 5_000_000);
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
function pollBridge(d: Device): { tick: () => Promise<void> } {
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
function forkHost(d: Device): ForkHost {
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

/** What the resolve-ink-fork command does: scan the store's ink folders, then open the modal. */
async function runFixInkDesync(d: Device): Promise<Opened> {
	const host = forkHost(d);
	for (const folder of d.store.inkFolders()) await refreshForks(host, folder);
	const modal = new ForkResolutionModal({} as never, host);
	const content = new FakeEl("div", new FakeDoc());
	(modal as unknown as { contentEl: FakeEl }).contentEl = content;
	await modal.onOpen();
	return { texts: () => textsOf(content), button: (label) => findButton(content, label) };
}

async function click(opened: Opened, label: string): Promise<void> {
	const btn = opened.button(label);
	expect(btn, `precondition: the modal shows a "${label}" button`).not.toBeNull();
	btn!.fire("click");
	await drain();
}

/** Every unresolved pair on disk for the page, in any folder. */
function pairs(): Array<{ outgoing: string; incoming: string }> {
	const out = new Map<string, { outgoing?: string; incoming?: string }>();
	for (const k of fake.files.keys()) {
		const m = /^(.*)\/p1\.conflict-external-([0-9a-f]+)-(outgoing|incoming)\.json$/.exec(k);
		if (!m) continue;
		const key = `${m[1]}/${m[2]}`;
		const e = out.get(key) ?? {};
		if (m[3] === "outgoing") e.outgoing = k;
		else e.incoming = k;
		out.set(key, e);
	}
	return [...out.values()].map((e) => ({ outgoing: e.outgoing!, incoming: e.incoming! }));
}

function strokesAt(path: string): string {
	return JSON.stringify(parsePage(fake.files.get(path)!, PAGE_ID).data.strokes);
}

function idsAt(path: string): string[] {
	return parsePage(fake.files.get(path)!, PAGE_ID).data.strokes.map((s) => s.id);
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

const LIVE = `${HIDDEN}/p1.json`;

describe("a same-id change the other device made is put to the user", () => {
	/**
	 * This device holds [a, s] on disk. The other device lasso-moved s and its
	 * revision arrives. Preservation keeps this device's s (the same id in a
	 * different place), so there is a pair, and the list must offer it.
	 */
	it("a stroke the other device moved is listed, live and after a restart's scan", async () => {
		fake.files.set(LIVE, bytes([stroke("a"), stroke("s")]));
		fake.mtimes.set(LIVE, ++fake.clock);
		const d = device(fake);
		await d.ink.ensureLoaded(PATH);
		const poll = pollBridge(d);

		fake.externalWrite(LIVE, bytes([stroke("a"), stroke("s", 40, 30)]));
		await poll.tick();
		const all = pairs();
		expect(all, "precondition: preservation kept this device's version of s").toHaveLength(1);
		expect(idsAt(all[0]!.outgoing)).toEqual(["a", "s"]);
		expect(idsAt(all[0]!.incoming)).toEqual(["a", "s"]);
		expect(strokesAt(all[0]!.outgoing)).not.toBe(strokesAt(all[0]!.incoming));

		const first = await runFixInkDesync(d);
		expect(first.texts(), "the moved stroke's pair is offered").toContain(COPY.headline);

		resetForks();
		const again = await runFixInkDesync(device(fake));
		expect(again.texts(), "a restart finds it by scanning").toContain(COPY.headline);
	});

	/** Pairs written before preservation became selective sit on disk forever. */
	function seedPair(outgoing: string, incoming: string): void {
		fake.files.set(LIVE, incoming);
		fake.mtimes.set(LIVE, ++fake.clock);
		fake.files.set(`${HIDDEN}/p1.conflict-external-0a0a-outgoing.json`, outgoing);
		fake.mtimes.set(`${HIDDEN}/p1.conflict-external-0a0a-outgoing.json`, ++fake.clock);
		fake.files.set(`${HIDDEN}/p1.conflict-external-0a0a-incoming.json`, incoming);
		fake.mtimes.set(`${HIDDEN}/p1.conflict-external-0a0a-incoming.json`, ++fake.clock);
	}

	/** An outgoing leg as the store writes it: the page, plus its unrounded capture nested. */
	function outgoingLeg(page: PageData): string {
		return serializePage({ ...page, unknownTop: { ...page.unknownTop, [EXACT_OUTGOING_KEY]: page } });
	}

	for (const [label, outgoing, incoming] of [
		["the other device only added", outgoingLeg(pageOf([stroke("a")])), bytes([stroke("a"), stroke("b")])],
		["the two revisions are identical", outgoingLeg(pageOf([stroke("a"), stroke("b")])), bytes([stroke("a"), stroke("b")])],
		["they differ only below the saved precision", outgoingLeg(pageOf([stroke("a", 0.0012, 0.0034)])), bytes([stroke("a")])],
	] as const) {
		it(`control: a pair where ${label} is not listed`, async () => {
			seedPair(outgoing, incoming);
			const d = device(fake);
			await d.ink.ensureLoaded(PATH);
			const opened = await runFixInkDesync(d);
			expect(listForks(), "precondition: the scan found the pair").toHaveLength(1);
			expect(opened.texts()).toEqual([COPY.empty]);
		});
	}
});

/**
 * A listed fork: this device drew "local" that the other never had, the other
 * drew b1. After the adoption, [a, b1] is live and the pair is on disk.
 */
async function realFork(): Promise<{ d: Device; poll: { tick: () => Promise<void> }; incoming: string }> {
	fake.files.set(LIVE, bytes([stroke("a")]));
	fake.mtimes.set(LIVE, ++fake.clock);
	const d = device(fake);
	await d.ink.ensureLoaded(PATH);
	d.ink.commit(PATH, stroke("local"));
	await drain();
	const poll = pollBridge(d);
	fake.externalWrite(LIVE, bytes([stroke("a"), stroke("b1")]));
	await poll.tick();
	const all = pairs();
	expect(all, "precondition: the adoption preserved one pair").toHaveLength(1);
	expect(idsAt(LIVE)).toEqual(["a", "b1"]);
	return { d, poll, incoming: all[0]!.incoming };
}

describe("'Take the other' checks the strokes, not only their ids", () => {
	it("after 'Keep both' and a lasso move of the other device's stroke, 'Take the other' writes its revision", async () => {
		const { d, incoming } = await realFork();
		const theirs = strokesAt(incoming);
		const theirPoints = JSON.stringify(parsePage(fake.files.get(incoming)!, PAGE_ID).data.strokes.map((s) => s.points));

		const first = await runFixInkDesync(d);
		await click(first, COPY.keepBoth);
		d.ink.moveStrokes(PATH, ["b1"], 25, 15);
		d.ink.save(PATH);
		await drain();
		expect(idsAt(LIVE), "precondition: the ids are unchanged").toEqual(["a", "b1"]);
		expect(strokesAt(LIVE), "precondition: the moved stroke is on disk").not.toBe(theirs);
		const moved = strokesAt(LIVE);

		const second = await runFixInkDesync(d);
		await click(second, COPY.takeTheirs);

		expect(notices).toEqual([]);
		expect(strokesAt(LIVE), "the other device's revision is live").toBe(theirs);
		expect(JSON.stringify(d.ink.strokes(PATH).map((s) => s.points)), "and on screen").toBe(theirPoints);
		const kept = [...fake.files.entries()].filter(([k]) => !k.includes(".conflict-external-") && !k.includes(".conflict-resolved-") && k !== LIVE);
		expect(
			kept.some(([, text]) => JSON.stringify(parsePage(text, PAGE_ID).data.strokes) === moved),
			"the moved ink was copied aside before the write"
		).toBe(true);
	});

	it("a failed write is not read back as done when the live page has the same ids and other strokes", async () => {
		const { d } = await realFork();
		const first = await runFixInkDesync(d);
		await click(first, COPY.keepBoth);
		d.ink.moveStrokes(PATH, ["b1"], 25, 15);
		d.ink.save(PATH);
		await drain();
		const moved = strokesAt(LIVE);

		// The restore's write to the live file (its .tmp, renamed into place)
		// fails; the copy aside succeeds.
		const write = fake.write.bind(fake);
		let failLive = true;
		fake.write = async (p: string, data: string) => {
			if (failLive && (p === LIVE || p === `${LIVE}.tmp`)) {
				failLive = false;
				throw new Error("EIO injected");
			}
			return write(p, data);
		};
		const rec = listForks().find((r) => r.pageId === PAGE_ID)!;
		const out = await applyForkDecision(forkHost(d), rec, "take-theirs");

		expect(failLive, "precondition: the live write was attempted and failed").toBe(false);
		expect(strokesAt(LIVE), "precondition: the moved ink is still what is on disk").toBe(moved);
		expect(out.kind).toBe("refused");
		expect(listForks().some((r) => r.pageId === PAGE_ID), "the fork stays listed").toBe(true);
		expect(pairs(), "the pair keeps its unresolved names").toHaveLength(1);
	});

	it("control: 'Take the other' with the other device's revision already live writes nothing", async () => {
		const { d } = await realFork();
		await runFixInkDesync(d);
		const rec = listForks().find((r) => r.pageId === PAGE_ID)!;
		const before = fake.log.length;
		const out = await applyForkDecision(forkHost(d), rec, "take-theirs");
		expect(out).toEqual({ kind: "applied", wrote: false, stillListed: false });
		expect(fake.log.slice(before).filter((l) => l.startsWith("write "))).toEqual([]);
	});

	it("control: 'Keep this device's ink' with an unrounded capture reads back as its own rounded write", async () => {
		fake.files.set(LIVE, bytes([stroke("a")]));
		fake.mtimes.set(LIVE, ++fake.clock);
		const d = device(fake);
		await d.ink.ensureLoaded(PATH);
		d.ink.commit(PATH, stroke("local", 0.0012, 0.0034));
		await drain();
		const poll = pollBridge(d);
		fake.externalWrite(LIVE, bytes([stroke("a"), stroke("b1")]));
		await poll.tick();

		const first = await runFixInkDesync(d);
		await click(first, COPY.keepMine);
		expect(notices, "no refusal").toEqual([]);
		expect(idsAt(LIVE)).toEqual(["a", "local"]);
		expect(first.texts()).toEqual([COPY.empty]);
	});
});

describe("a fork made at load from a page in both folders is found", () => {
	/**
	 * .handwriting is configured; the page is in both folders and neither copy
	 * holds the other. The synced copy is served and the pair is written beside
	 * it, in handwriting/. The command must find it there, and again after a
	 * restart, when nothing is registered.
	 */
	it("with .handwriting configured, the pair beside handwriting/ is listed, and again after a restart", async () => {
		fake.files.set(`${HIDDEN}/p1.json`, bytes([stroke("a"), stroke("mine")]));
		fake.mtimes.set(`${HIDDEN}/p1.json`, 42);
		fake.files.set(`${SYNCED}/p1.json`, bytes([stroke("a"), stroke("theirs")]));
		fake.mtimes.set(`${SYNCED}/p1.json`, 43);
		const d = device(fake, HIDDEN);
		await d.ink.ensureLoaded(PATH);
		await drain();
		expect(d.ink.strokes(PATH).map((s) => s.id), "precondition: the synced copy is served").toEqual(["a", "theirs"]);
		const all = pairs();
		expect(all, "precondition: one pair").toHaveLength(1);
		expect(all[0]!.outgoing.startsWith(`${SYNCED}/`), "precondition: beside the served copy").toBe(true);
		expect(listForks(), "precondition: the load registered nothing").toEqual([]);

		const first = await runFixInkDesync(d);
		expect(first.texts()).toContain(COPY.headline);
		expect(listForks(), "listed once").toHaveLength(1);

		resetForks();
		const again = await runFixInkDesync(device(fake, HIDDEN));
		expect(again.texts()).toContain(COPY.headline);
	});

	it("control: with handwriting/ configured, the same pair is listed once", async () => {
		fake.files.set(`${HIDDEN}/p1.json`, bytes([stroke("a"), stroke("mine")]));
		fake.mtimes.set(`${HIDDEN}/p1.json`, 42);
		fake.files.set(`${SYNCED}/p1.json`, bytes([stroke("a"), stroke("theirs")]));
		fake.mtimes.set(`${SYNCED}/p1.json`, 43);
		const d = device(fake, SYNCED);
		await d.ink.ensureLoaded(PATH);
		await drain();
		expect(pairs(), "precondition: one pair").toHaveLength(1);

		const opened = await runFixInkDesync(d);
		expect(opened.texts()).toContain(COPY.headline);
		expect(listForks()).toHaveLength(1);
	});
});
