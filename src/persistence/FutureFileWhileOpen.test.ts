/**
 * A NEWER BUILD'S INK FILE THAT ARRIVES WHILE THE NOTE IS OPEN IS KEPT AND LISTED.
 *
 * Opening a note whose ink file was written by a newer build locks it: the ink
 * this build understands is shown, nothing drawn here is written back, and the
 * newer file stays the live file for the build that wrote it.
 *
 * The same file synced in while the note is already open takes a different
 * road, by design: the live-reload poll declines to adopt it, the note stays
 * writable so ink drawn here is not dropped, and the next save keeps the newer
 * file byte for byte in a copy beside the page and writes this build's page.
 * Both revisions are then on disk, and that is a fork. The fix ink de-sync
 * list did not show that copy, because it only scanned adoption pairs, so the
 * newer build's ink sat in a file nothing in Obsidian can reach.
 *
 * Assertions state the CORRECT behaviour: green = no bug, red = bug. The cold
 * open is the control: same bytes, same stroke, same store.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { InlineInkStore } from "../inline/InlineInkStore";
import { applyForkDecision, describeFork, forkHostFor, listForks, refreshForks, resetForks } from "./ForkResolution";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";
import { installLiveReloadPoll } from "../testUtils/LiveReloadTestHarness";

const DEBOUNCE_MS = 700;
const PATH = "note.md";
const PAGE_ID = "p1";
const LIVE = ".handwriting/p1.json";

let fake: FakeAdapter;

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

/** The same ink, as a build with a newer schema would have written it. */
function newerBuildFile(strokeIds: string[]): string {
	const raw = JSON.parse(serializePage(page(strokeIds))) as Record<string, unknown>;
	raw.schemaVersion = Number.MAX_SAFE_INTEGER;
	return JSON.stringify(raw);
}

interface Device {
	store: PageStore;
	ink: InlineInkStore;
	notices: string[];
}

/** One device: the real PageStore and InlineInkStore, wired as the plugin wires them. */
function device(): Device {
	const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
	const ink = new InlineInkStore();
	const notices: string[] = [];
	ink.attachHost({
		readPageId: (p: string) => (p === PATH ? PAGE_ID : null),
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: (id: string) => store.load(id),
		scheduleSidecar: (id: string, p: PageData) => store.schedule(id, p),
		scheduleSidecarNow: (id: string, p: PageData) => store.saveNow(id, p),
		prepareExternalAdoption: (id: string, outgoing: PageData) => store.prepareExternalAdoption(id, outgoing),
		acceptExternalAdoption: (prepared: never) => store.acceptExternalAdoption(prepared),
		notify: (m: string) => notices.push(m),
	} as never);
	return { store, ink, notices };
}

async function drain(): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
	for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(0);
}

/** The plugin's live-reload poll over one open note, one tick per call. */
function poll(d: Device): () => Promise<void> {
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
		() => [PATH],
		d.ink,
		() => {},
		() => {},
		() => null,
		async () => false,
		{ error: () => {} },
		(p: string) => (p === PATH ? () => true : null)
	);
	return async () => {
		fire();
		await pending;
		await drain();
	};
}

/** The same files through an adapter that can list a folder, as the fork scan needs. */
function listingView(): FakeAdapter {
	return Object.assign(Object.create(fake) as FakeAdapter, {
		async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
			const prefix = dir.endsWith("/") ? dir : dir + "/";
			return { files: [...fake.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")), folders: [] };
		},
	});
}

/** Every file beside the live one that holds this page's bytes under another name. */
function copiesAside(): string[] {
	return [...fake.files.keys()].filter((k) => k.startsWith(".handwriting/p1.") && k !== LIVE).sort();
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
});

afterEach(() => {
	resetForks();
	vi.useRealTimers();
});

describe("a newer build's ink file stays reachable whether it is there at open or arrives while the note is open", () => {
	it("control: at a cold open, the stroke drawn next is shown and the newer file stays live, untouched", async () => {
		const newer = newerBuildFile(["a", "from-newer-build"]);
		fake.externalWrite(LIVE, newer);
		const d = device();
		await d.ink.ensureLoaded(PATH);
		expect(d.ink.strokes(PATH).map((s) => s.id), "precondition: the ink this build understands is shown").toEqual([
			"a",
			"from-newer-build",
		]);

		d.ink.commit(PATH, stroke("drawn-here"));
		await d.store.flush();
		await drain();

		expect(fake.files.get(LIVE), "the newer build's file was rewritten").toBe(newer);
		expect(copiesAside(), "the newer build's file was moved aside").toEqual([]);
		expect(d.ink.strokes(PATH).map((s) => s.id)).toEqual(["a", "from-newer-build", "drawn-here"]);
	});

	it("arriving while the note is open, the copy the next save keeps of it is listed by fix ink de-sync", async () => {
		fake.files.set(LIVE, serializePage(page(["a"])));
		fake.mtimes.set(LIVE, ++fake.clock);
		const d = device();
		await d.ink.ensureLoaded(PATH);
		d.ink.commit(PATH, stroke("local"));
		await drain();
		expect(
			parsePage(fake.files.get(LIVE)!, PAGE_ID).data.strokes.map((s) => s.id),
			"precondition: the note is open, settled and saved"
		).toEqual(["a", "local"]);
		expect(d.store.hasQueuedWrite(PAGE_ID), "precondition: nothing queued").toBe(false);

		// Another device running a newer build saves this note, and sync delivers it.
		const newer = newerBuildFile(["a", "local", "from-newer-build"]);
		fake.externalWrite(LIVE, newer);
		await poll(d)();
		expect(fake.files.get(LIVE), "precondition: the poll itself wrote nothing").toBe(newer);

		d.ink.commit(PATH, stroke("drawn-here"));
		await d.store.flush();
		await drain();
		expect(
			copiesAside().map((p) => fake.files.get(p)),
			"precondition: the newer build's file is kept byte for byte beside the page"
		).toEqual([newer]);

		const host = forkHostFor({ adapter: listingView(), store: d.store } as never);
		resetForks();
		await refreshForks(host, ".handwriting");
		const rec = listForks().find((r) => r.pageId === PAGE_ID);
		expect(rec, "the newer build's ink sits in a copy nothing lists").toBeDefined();
		expect(fake.files.get(rec!.incomingPath), "the listed copy is not the newer build's file").toBe(newer);
		const account = await describeFork(host, rec!);
		expect(account.theirs.readable, "a newer build's copy is offered as one this build can restore").toBe(false);
		expect(account.needsDecision, "the fork is listed but not put to the user").toBe(true);
		expect(d.ink.strokes(PATH).map((s) => s.id), "the stroke drawn here left the screen").toContain("drawn-here");

		// Keeping either version is refused for a copy this build cannot read,
		// and the copy stays listed with its bytes as they were.
		expect((await applyForkDecision(host, rec!, "keep-mine")).kind, "keeping Version A was not refused").toBe("refused");
		expect((await applyForkDecision(host, rec!, "take-theirs")).kind, "keeping Version B was not refused").toBe("refused");
		expect(fake.files.get(rec!.incomingPath), "a refused keep changed the newer build's copy").toBe(newer);
		resetForks();
		await refreshForks(host, ".handwriting");
		expect(listForks().some((r) => r.pageId === PAGE_ID), "after a refused keep the copy is no longer listed").toBe(true);
	});
});
