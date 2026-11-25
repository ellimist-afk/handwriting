/**
 * A FORK CHOICE ON A PAGE THE STORE SERVES FROM ANOTHER FOLDER.
 *
 * The page is in both well-known ink folders. The copy in the other folder holds every stroke of the one beside the fork
 * and one more, so the store serves that copy. A fork choice judges, and reads back, the page beside the fork; a write
 * lands on the page the store serves. So a choice that would write is refused before anything is copied, written,
 * renamed or removed: the open note keeps its strokes, the fork stays listed, and the next stroke still lands on the
 * page the store serves.
 *
 * With the page in one folder, keep mine and take the other still write the chosen side and retire the fork.
 *
 * In-memory adapter, fake timers, the real PageStore, InlineInkStore and fork host; no Obsidian and no sync tool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { InlineInkStore } from "../inline/InlineInkStore";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";
import { applyForkDecision, forkHostFor, resetForks, type ForkHost, type ForkRecord } from "./ForkResolution";

const DEBOUNCE_MS = 700;
const PATH = "note.md";
const ID = "p1";
/** The configured ink folder, and the other well-known one. */
const CONFIGURED = ".handwriting";
const OTHER_FOLDER = "handwriting";
/** The page beside the fork, in the configured folder. */
const BESIDE = `${CONFIGURED}/p1.json`;
/** The page in the other well-known folder. */
const OTHER = `${OTHER_FOLDER}/p1.json`;

/** A stroke whose geometry follows its id, so the same id is the same stroke in every page that holds it. */
function stroke(id: string): InkStroke {
	const x = 1 + (id.charCodeAt(id.length - 1) % 10) * 20;
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x, y: 2, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 6, pressure: 0.5, t: 8 },
		],
		bbox: { x, y: 2, width: 10, height: 4 },
		createdAt: 0,
	};
}

function bytes(ids: string[]): string {
	const p: PageData = emptyPage(ID);
	p.surface = "inline";
	p.strokes = ids.map(stroke);
	return serializePage(p);
}

let fake: FakeAdapter;

interface Device {
	store: PageStore;
	ink: InlineInkStore;
	/** Pages handed to the open surface by the fork host. */
	restoredOpen: string[][];
	host: ForkHost;
}

/** One device: its PageStore and InlineInkStore over the fake adapter, and the fork host the plugin builds over them. */
function device(): Device {
	const store = new PageStore({ vault: { adapter: fake } } as never, CONFIGURED, () => 5_000_000);
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
	const restoredOpen: string[][] = [];
	const host = forkHostFor({
		adapter: fake,
		store,
		restoreOpen: async (pageId: string, data: PageData) => {
			restoredOpen.push(data.strokes.map((s) => s.id));
			return (await ink.restoreRevision(pageId, data)) !== null;
		},
	});
	return { store, ink, restoredOpen, host };
}

async function drain(): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
	for (let i = 0; i < 80; i++) await vi.advanceTimersByTimeAsync(0);
}

function put(path: string, text: string): void {
	fake.files.set(path, text);
	fake.mtimes.set(path, ++fake.clock);
}

/** A preserved pair beside the page in `folder`, as an adoption would have left it. */
function pairOnDisk(folder: string, outgoing: string[], incoming: string[]): ForkRecord {
	const o = `${folder}/p1.conflict-external-00000000000000a1-outgoing.json`;
	const i = `${folder}/p1.conflict-external-00000000000000a1-incoming.json`;
	put(o, bytes(outgoing));
	put(i, bytes(incoming));
	return { pageId: ID, path: PATH, outgoingPath: o, incomingPath: i, at: 1 };
}

/** A copy the save guard kept beside the page in the configured folder. */
function keptCopyOnDisk(ids: string[]): ForkRecord {
	const copy = `${CONFIGURED}/p1.conflict-1701.json`;
	put(copy, bytes(ids));
	return { pageId: ID, path: ID, outgoingPath: BESIDE, incomingPath: copy, at: 1, kept: true };
}

/** Every ink file on the adapter with the ids of the strokes it holds, by path. */
function strokeIdsByFile(): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [path, text] of fake.files) {
		if (path.endsWith(".json")) out[path] = parsePage(text, ID).data.strokes.map((s) => s.id);
	}
	return out;
}

function idsAt(path: string): string[] | null {
	const text = fake.files.get(path);
	return text === undefined ? null : parsePage(text, ID).data.strokes.map((s) => s.id);
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	resetForks();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a fork choice on a page the store serves from the other ink folder", () => {
	it.each([
		{
			row: "keep mine on a pair",
			beside: ["s1", "s2"],
			served: ["s1", "s2", "s4"],
			fork: () => pairOnDisk(CONFIGURED, ["s1", "s3"], ["s1", "s2"]),
			decision: "keep-mine" as const,
		},
		{
			row: "take the other on a pair",
			beside: ["s1", "s2"],
			served: ["s1", "s2", "s4"],
			fork: () => pairOnDisk(CONFIGURED, ["s1", "s2"], ["s1", "s3"]),
			decision: "take-theirs" as const,
		},
		{
			row: "take the other on a kept copy",
			beside: ["s1"],
			served: ["s1", "s5"],
			fork: () => keptCopyOnDisk(["s1", "s9"]),
			decision: "take-theirs" as const,
		},
	])("$row: refused before anything is written, and the open note keeps its strokes", async ({ beside, served, fork, decision }) => {
		put(BESIDE, bytes(beside));
		put(OTHER, bytes(served));
		const rec = fork();
		const d = device();
		await d.ink.ensureLoaded(PATH);
		await drain();
		expect(await d.store.resolvePath(ID), "precondition: the store serves the page in the other folder").toBe(OTHER);
		expect(d.ink.strokes(PATH).map((s) => s.id), "precondition: the open note shows the served page").toEqual(served);

		const mark = fake.log.length;
		const filesBefore = strokeIdsByFile();
		const out = await applyForkDecision(d.host, rec, decision);
		await drain();

		expect(out, "refused, nothing written, the fork still listed").toMatchObject({ kind: "refused", wrote: false, stillListed: true });
		expect(
			fake.log.slice(mark).filter((l) => /^(write|rename|remove) /.test(l)),
			"the decision writes, renames and removes nothing",
		).toEqual([]);
		expect(Object.keys(strokeIdsByFile()).sort(), "no file added or gone, the trash folders included").toEqual(Object.keys(filesBefore).sort());
		expect(strokeIdsByFile(), "every ink file holds the same strokes").toEqual(filesBefore);
		expect(d.restoredOpen, "nothing handed to the open note or PDF").toEqual([]);
		expect(d.ink.strokes(PATH).map((s) => s.id), "the open note keeps its strokes").toEqual(served);

		d.ink.commit(PATH, stroke("s8"));
		await drain();
		expect(idsAt(OTHER), "the next stroke lands on the served page, with every stroke it had").toEqual([...served, "s8"]);
	});
});

describe("a fork choice on a page in one ink folder", () => {
	it.each([
		{
			row: "keep mine on a pair",
			folder: CONFIGURED,
			live: ["s1", "s2"],
			fork: () => pairOnDisk(CONFIGURED, ["s1", "s3"], ["s1", "s2"]),
			decision: "keep-mine" as const,
			want: ["s1", "s3"],
		},
		{
			row: "take the other on a pair",
			folder: CONFIGURED,
			live: ["s1", "s3"],
			fork: () => pairOnDisk(CONFIGURED, ["s1", "s3"], ["s1", "s2"]),
			decision: "take-theirs" as const,
			want: ["s1", "s2"],
		},
		{
			row: "take the other on a kept copy",
			folder: CONFIGURED,
			live: ["s1"],
			fork: () => keptCopyOnDisk(["s1", "s9"]),
			decision: "take-theirs" as const,
			want: ["s1", "s9"],
		},
		{
			row: "keep mine on a pair, in the other well-known folder",
			folder: OTHER_FOLDER,
			live: ["s1", "s2"],
			fork: () => pairOnDisk(OTHER_FOLDER, ["s1", "s3"], ["s1", "s2"]),
			decision: "keep-mine" as const,
			want: ["s1", "s3"],
		},
	])("$row: applies, writes the chosen side and retires the fork", async ({ folder, live, fork, decision, want }) => {
		const page = `${folder}/p1.json`;
		put(page, bytes(live));
		const rec = fork();
		const d = device();
		await d.ink.ensureLoaded(PATH);
		await drain();
		expect(await d.store.resolvePath(ID), "precondition: the store serves the page beside the fork").toBe(page);

		const out = await applyForkDecision(d.host, rec, decision);
		await drain();

		expect(out, "applied, written, no longer listed").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(page), "the live page is the chosen side").toEqual(want);
		expect(d.restoredOpen, "handed to the open note once").toEqual([want]);
		expect(d.ink.strokes(PATH).map((s) => s.id), "the open note shows the chosen side").toEqual(want);
		expect(fake.files.has(rec.incomingPath), "the fork's file is renamed to a resolved name").toBe(false);
	});
});
