/**
 * A FORK CHOICE WHILE A DUPLICATE LOCK STANDS ON THE PAGE.
 *
 * Two notes carry one page id, and a duplicate lock stands on one of them or on both. A restore then cannot reach the
 * notes' records: one of them keeps the page the choice replaced and writes it back later, when the open note's next
 * stroke saves it (only the copy locked) or when the lock clears (both locked). The chosen ink would be left only in
 * the renamed fork files. So a choice that would write is refused before anything is copied, written or renamed, the
 * fork stays listed, and the page is the one the note had. That holds for a locked note that was never opened too,
 * and for the note's Slides page, which carries the note's id with ".slides" after it.
 *
 * Once the lock is gone the same choice applies and survives the next stroke, and a lock on another page id refuses
 * nothing.
 *
 * Every cell runs the fork host the plugin builds, sliced out of RegisterCommands.ts and run with stand-ins for the
 * plugin, over the real PageStore and InlineInkStore on an in-memory adapter with fake timers. No Obsidian, no sync tool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { transformSync } from "esbuild";
import commandsSource from "../commands/RegisterCommands.ts?raw";
import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { InlineInkStore } from "../inline/InlineInkStore";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";
import { applyForkDecision, forkHostFor, resetForks, type ForkHost, type ForkRecord } from "./ForkResolution";

const DEBOUNCE_MS = 700;
const FOLDER = ".handwriting";
const ID = "p1";
/** The live page both notes point at. */
const PAGE = `${FOLDER}/p1.json`;
/** The original note and its copy: one page id. */
const ORIGINAL = "note.md";
const COPY = "note copy.md";
/** Two other notes sharing another page id. */
const OTHER_ID = "p9";
const OTHER = "other.md";
const OTHER_COPY = "other copy.md";
const IDS: Record<string, string> = { [ORIGINAL]: ID, [COPY]: ID, [OTHER]: OTHER_ID, [OTHER_COPY]: OTHER_ID };
/** The page before the choice, and the side "keep mine" chooses. */
const BEFORE = ["s1", "s2"];
const CHOSEN = ["s1", "s3"];

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

/** The original note's Slides page: the note's id with ".slides" after it, beside the note's own page. */
const SLIDES_ID = `${ID}.slides`;
const SLIDES = `${FOLDER}/${SLIDES_ID}.json`;

function slidesBytes(ids: string[]): string {
	const p: PageData = emptyPage(SLIDES_ID);
	p.surface = "slides";
	p.strokes = ids.map(stroke);
	return serializePage(p);
}

/** A copy of the Slides page the save guard kept beside it: "take the other" chooses the copy. */
function keptSlidesCopyOnDisk(): ForkRecord {
	const copy = `${FOLDER}/${SLIDES_ID}.conflict-1701.json`;
	put(SLIDES, slidesBytes(["s1"]));
	put(copy, slidesBytes(["s1", "s9"]));
	return { pageId: SLIDES_ID, path: SLIDES_ID, outgoingPath: SLIDES, incomingPath: copy, at: 1, kept: true };
}

let fake: FakeAdapter;

function put(path: string, text: string): void {
	fake.files.set(path, text);
	fake.mtimes.set(path, ++fake.clock);
}

/** The plugin's fork host: the forkHostFor call in RegisterCommands.ts, run with `this` and the ink store stood in. */
function pluginHost(self: unknown, ink: InlineInkStore, reloaded: string[]): ForkHost {
	const from = "const host: ForkHost = forkHostFor({";
	const to = "// Every folder a page can be served from";
	const source = commandsSource.replace(/\r\n/g, "\n");
	expect(source.split(from), "the fork host is built once in RegisterCommands.ts").toHaveLength(2);
	const at = source.indexOf(from);
	const end = source.indexOf(to, at);
	expect(end, "the fork host's sources end where the folder scan starts").toBeGreaterThan(at);
	const js = transformSync(`${source.slice(at, end)}\nreturn host;`, { loader: "ts" }).code;
	return new Function("self", "forkHostFor", "inlineInk", "inkExternallyReloaded", "slidesDeckHolds", js.replace(/\bthis\b/g, "self"))(
		self,
		forkHostFor,
		ink,
		(path: string) => reloaded.push(path),
		(pageId: string) => deckAnswer(pageId),
	) as ForkHost;
}

/** The Slides surface's answer to "does an open presentation hold this page?", as the plugin's fork host asks it. */
let deckAnswer: (pageId: string) => boolean = () => false;

interface Device {
	store: PageStore;
	ink: InlineInkStore;
	host: ForkHost;
	/** Notes the plugin told to repaint after a restore went through them. */
	reloaded: string[];
	/** Page ids the store was asked to copy aside: a restore does that before it writes. */
	preserved: string[];
}

/** One device: its PageStore and InlineInkStore over the fake adapter, and the plugin's fork host over them. */
function device(): Device {
	const store = new PageStore({ vault: { adapter: fake } } as never, FOLDER, () => 5_000_000);
	const ink = new InlineInkStore();
	ink.attachHost({
		readPageId: (p: string) => IDS[p] ?? null,
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: (id: string) => store.load(id),
		scheduleSidecar: (id: string, p: PageData) => store.schedule(id, p),
		scheduleSidecarNow: (id: string, p: PageData) => store.saveNow(id, p),
		prepareExternalAdoption: (id: string, outgoing: PageData) => store.prepareExternalAdoption(id, outgoing),
		acceptExternalAdoption: (prepared: never) => store.acceptExternalAdoption(prepared),
		notify: () => {},
	} as never);
	const preserved: string[] = [];
	const preserve = store.preserve.bind(store);
	store.preserve = (pageId: string) => (preserved.push(pageId), preserve(pageId));
	const reloaded: string[] = [];
	const self = {
		app: { vault: { adapter: fake, getFileByPath: () => null } },
		store,
		installId: () => "this-device",
		notePathFor: () => null,
		pdfStore: { restoreRevision: () => false, generation: () => null },
		pdfInk: new Map(),
		pdfIds: new Map(),
	};
	return { store, ink, host: pluginHost(self, ink, reloaded), reloaded, preserved };
}

async function drain(): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
	for (let i = 0; i < 80; i++) await vi.advanceTimersByTimeAsync(0);
}

/** A preserved pair beside the page, as an adoption would have left it: "keep mine" chooses CHOSEN. */
function pairOnDisk(): ForkRecord {
	const o = `${FOLDER}/p1.conflict-external-00000000000000a1-outgoing.json`;
	const i = `${FOLDER}/p1.conflict-external-00000000000000a1-incoming.json`;
	put(o, bytes(CHOSEN));
	put(i, bytes(BEFORE));
	return { pageId: ID, path: ORIGINAL, outgoingPath: o, incomingPath: i, at: 1 };
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

function shown(d: Device, path: string): string[] {
	return d.ink.strokes(path).map((s) => s.id);
}

/** The decision ("keep mine" unless named) on the fork, and everything a refusal must leave as it was. */
async function refusedWithNothingTouched(
	d: Device,
	rec: ForkRecord,
	decision: "keep-mine" | "take-theirs" = "keep-mine",
): Promise<void> {
	const mark = fake.log.length;
	const filesBefore = strokeIdsByFile();
	const out = await applyForkDecision(d.host, rec, decision);
	await drain();
	expect(out, "refused, nothing written, the fork still listed").toMatchObject({ kind: "refused", wrote: false, stillListed: true, why: "not saved" });
	expect(d.preserved, "the live page is not copied aside").toEqual([]);
	expect(
		fake.log.slice(mark).filter((l) => /^(write|rename|remove) /.test(l)),
		"the decision writes, renames and removes nothing",
	).toEqual([]);
	expect(Object.keys(strokeIdsByFile()).sort(), "no file added or gone, the trash folder included").toEqual(Object.keys(filesBefore).sort());
	expect(strokeIdsByFile(), "every ink file holds the same strokes").toEqual(filesBefore);
	expect(fake.files.has(rec.outgoingPath) && fake.files.has(rec.incomingPath), "both fork files keep their fork names").toBe(true);
	expect(d.reloaded, "no note is told the page was restored").toEqual([]);
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	resetForks();
});

afterEach(() => {
	deckAnswer = () => false;
	vi.useRealTimers();
});

describe("a fork choice while a duplicate lock stands on the page", () => {
	it("only the copy locked, both open, the copy read first: refused, and the original's next stroke keeps its page", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = pairOnDisk();
		const d = device();
		d.ink.markDuplicateLocked(COPY, ORIGINAL);
		await d.ink.ensureLoaded(COPY);
		await d.ink.ensureLoaded(ORIGINAL);
		await drain();
		expect([...d.ink.byPath.keys()], "precondition: the copy's record comes first").toEqual([COPY, ORIGINAL]);
		expect(d.ink.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
		expect(d.ink.isDuplicateLocked(ORIGINAL), "precondition: the original is not").toBe(false);
		expect(d.ink.byPath.get(COPY)?.load, "precondition: the copy is loaded").toBe("yes");
		expect(d.ink.byPath.get(ORIGINAL)?.load, "precondition: the original is loaded").toBe("yes");
		expect(shown(d, ORIGINAL), "precondition: the original shows the page").toEqual(BEFORE);

		await refusedWithNothingTouched(d, rec);
		expect(shown(d, ORIGINAL), "the original keeps its strokes").toEqual(BEFORE);

		d.ink.commit(ORIGINAL, stroke("s8"));
		await drain();
		expect(idsAt(PAGE), "the next stroke on the original lands on the page it had").toEqual([...BEFORE, "s8"]);
	});

	it("both locked as the start-up census locks them, both open: refused, and clearing the lock keeps the page", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = pairOnDisk();
		const d = device();
		d.ink.markDuplicateLocked(ORIGINAL, COPY);
		d.ink.markDuplicateLocked(COPY, ORIGINAL);
		await d.ink.ensureLoaded(ORIGINAL);
		await d.ink.ensureLoaded(COPY);
		await drain();
		expect(d.ink.isDuplicateLocked(ORIGINAL), "precondition: the original is locked").toBe(true);
		expect(d.ink.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
		expect(d.ink.byPath.get(ORIGINAL)?.load, "precondition: the original is loaded").toBe("yes");
		expect(d.ink.byPath.get(COPY)?.load, "precondition: the copy is loaded").toBe("yes");
		expect(shown(d, ORIGINAL), "precondition: the original shows the page").toEqual(BEFORE);

		await refusedWithNothingTouched(d, rec);

		d.ink.clearDuplicateLock(ORIGINAL);
		await drain();
		expect(d.ink.isDuplicateLocked(ORIGINAL), "the original's lock is gone").toBe(false);
		expect(idsAt(PAGE), "clearing the lock leaves the page it had").toEqual(BEFORE);
	});

	it("the locked copy never opened this session: refused all the same", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = pairOnDisk();
		const d = device();
		d.ink.markDuplicateLocked(COPY, ORIGINAL);
		await d.ink.ensureLoaded(ORIGINAL);
		await drain();
		const copy = d.ink.byPath.get(COPY);
		expect(copy?.duplicateLocked, "precondition: the copy is locked").toBe(true);
		expect(copy?.pageId, "precondition: the copy's record has no page id yet").toBeNull();
		expect(copy?.load, "precondition: the copy is not loaded").toBe("no");
		expect(d.ink.isDuplicateLocked(ORIGINAL), "precondition: the original is not locked").toBe(false);
		expect(d.ink.byPath.get(ORIGINAL)?.load, "precondition: the original is loaded").toBe("yes");
		expect(shown(d, ORIGINAL), "precondition: the original shows the page").toEqual(BEFORE);

		await refusedWithNothingTouched(d, rec);
		expect(shown(d, ORIGINAL), "the original keeps its strokes").toEqual(BEFORE);
	});

	it("the note's Slides page, both notes locked, the original open: take the other on its kept copy is refused", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = keptSlidesCopyOnDisk();
		const d = device();
		d.ink.markDuplicateLocked(ORIGINAL, COPY);
		d.ink.markDuplicateLocked(COPY, ORIGINAL);
		await d.ink.ensureLoaded(ORIGINAL);
		await drain();
		expect(d.ink.isDuplicateLocked(ORIGINAL), "precondition: the original is locked").toBe(true);
		expect(d.ink.isDuplicateLocked(COPY), "precondition: the copy is locked").toBe(true);
		expect(d.ink.byPath.get(ORIGINAL)?.load, "precondition: the original is loaded").toBe("yes");
		expect(d.ink.byPath.get(ORIGINAL)?.pageId, "precondition: the original's record carries the note's id").toBe(ID);
		expect(
			[...d.ink.byPath.values()].some((r) => r.pageId === SLIDES_ID),
			"precondition: no record carries the Slides page id",
		).toBe(false);
		expect(idsAt(SLIDES), "precondition: the live Slides page").toEqual(["s1"]);
		expect(idsAt(rec.incomingPath), "precondition: the kept copy holds the other side").toEqual(["s1", "s9"]);

		await refusedWithNothingTouched(d, rec, "take-theirs");
		expect(idsAt(SLIDES), "the Slides page is the one it had").toEqual(["s1"]);
	});
});

describe("a fork choice with no duplicate lock on the page", () => {
	it("the copy's lock cleared before the choice: applies, and survives the original's next stroke", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = pairOnDisk();
		const d = device();
		d.ink.markDuplicateLocked(COPY, ORIGINAL);
		await d.ink.ensureLoaded(ORIGINAL);
		d.ink.clearDuplicateLock(COPY);
		await drain();
		expect(d.ink.byPath.has(COPY), "precondition: the copy has a record").toBe(true);
		expect(d.ink.isDuplicateLocked(COPY), "precondition: the copy's lock is gone").toBe(false);
		expect(shown(d, ORIGINAL), "precondition: the original shows the page").toEqual(BEFORE);

		const out = await applyForkDecision(d.host, rec, "keep-mine");
		await drain();
		expect(out, "applied, written, no longer listed").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(PAGE), "the live page is the chosen side").toEqual(CHOSEN);
		expect(shown(d, ORIGINAL), "the original shows the chosen side").toEqual(CHOSEN);
		expect(d.reloaded, "the restore went through the original").toEqual([ORIGINAL]);

		d.ink.commit(ORIGINAL, stroke("s8"));
		await drain();
		expect(idsAt(PAGE), "the next stroke keeps the chosen side").toEqual([...CHOSEN, "s8"]);
	});

	it("a lock on two notes sharing another page id: applies, and survives the original's next stroke", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = pairOnDisk();
		const d = device();
		d.ink.markDuplicateLocked(OTHER, OTHER_COPY);
		d.ink.markDuplicateLocked(OTHER_COPY, OTHER);
		await d.ink.ensureLoaded(OTHER);
		await d.ink.ensureLoaded(ORIGINAL);
		await drain();
		expect(d.ink.isDuplicateLocked(OTHER), "precondition: the other note is locked").toBe(true);
		expect(d.ink.isDuplicateLocked(OTHER_COPY), "precondition: its copy is locked").toBe(true);
		expect(d.ink.byPath.get(OTHER)?.pageId, "precondition: the open locked note carries the other id").toBe(OTHER_ID);
		expect(d.ink.byPath.get(OTHER_COPY)?.load, "precondition: its copy is not loaded").toBe("no");
		expect(d.ink.isDuplicateLocked(ORIGINAL), "precondition: the original is not locked").toBe(false);
		expect(shown(d, ORIGINAL), "precondition: the original shows the page").toEqual(BEFORE);

		const out = await applyForkDecision(d.host, rec, "keep-mine");
		await drain();
		expect(out, "applied, written, no longer listed").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(PAGE), "the live page is the chosen side").toEqual(CHOSEN);
		expect(shown(d, ORIGINAL), "the original shows the chosen side").toEqual(CHOSEN);

		d.ink.commit(ORIGINAL, stroke("s8"));
		await drain();
		expect(idsAt(PAGE), "the next stroke keeps the chosen side").toEqual([...CHOSEN, "s8"]);
	});

	it("the note's Slides page with no lock, the original open: take the other on its kept copy applies", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = keptSlidesCopyOnDisk();
		const d = device();
		await d.ink.ensureLoaded(ORIGINAL);
		await drain();
		expect(d.ink.isDuplicateLocked(ORIGINAL), "precondition: the original is not locked").toBe(false);
		expect(d.ink.isDuplicateLocked(COPY), "precondition: the copy is not locked").toBe(false);
		expect(d.ink.byPath.get(ORIGINAL)?.pageId, "precondition: the original's record carries the note's id").toBe(ID);
		expect(idsAt(SLIDES), "precondition: the live Slides page").toEqual(["s1"]);

		const out = await applyForkDecision(d.host, rec, "take-theirs");
		await drain();
		expect(out, "applied, written, no longer listed").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(SLIDES), "the live Slides page is the kept copy's side").toEqual(["s1", "s9"]);
	});
});

describe("a fork choice on a Slides page an open presentation holds, through the plugin's fork host", () => {
	it("take the other on the Slides page's kept copy, the presentation open: refused before anything is copied or written", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = keptSlidesCopyOnDisk();
		const d = device();
		const asked: string[] = [];
		deckAnswer = (pageId) => (asked.push(pageId), pageId === SLIDES_ID);
		expect(idsAt(SLIDES), "precondition: the live Slides page").toEqual(["s1"]);

		await refusedWithNothingTouched(d, rec, "take-theirs");
		expect(asked, "the plugin's fork host did not ask the Slides surface about the page").toContain(SLIDES_ID);
		expect(idsAt(SLIDES), "the Slides page is the one it had").toEqual(["s1"]);
	});

	it("the Slides surface's answer throws: take the other is refused before anything is copied or written", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = keptSlidesCopyOnDisk();
		const d = device();
		deckAnswer = () => {
			throw new Error("injected");
		};

		await refusedWithNothingTouched(d, rec, "take-theirs");
		expect(idsAt(SLIDES), "the Slides page is the one it had").toEqual(["s1"]);
	});

	it("pin: the presentation holds another page: take the other on this Slides page's kept copy applies", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = keptSlidesCopyOnDisk();
		const d = device();
		deckAnswer = (pageId) => pageId === "another-page.slides";

		const out = await applyForkDecision(d.host, rec, "take-theirs");
		await drain();
		expect(out, "applied, written, no longer listed").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(SLIDES), "the live Slides page is the kept copy's side").toEqual(["s1", "s9"]);
	});
});
