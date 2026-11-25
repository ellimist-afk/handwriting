/**
 * "FIX INK DE-SYNC" ON A PDF KEEPS THE PDF'S OWN CLAIM.
 *
 * A PDF's ink file names the vault paths it belongs to (`pdfPaths`). A copy of it kept before the PDF was renamed
 * names the old path. Taking that copy (or keeping this device's leg of a pair) wrote the copy's whole page, its
 * claim included, over the live ink file: the restored PDF could open blank and another PDF at the old name wear the
 * ink. The read-back compared strokes, text boxes, images and attachments, never the claim.
 *
 * A decision on a PDF page now changes its ink, never its claim: the live file's list before is its list after,
 * read again once the queued save has landed. The read-back fails when the claim on disk is another list. Where the
 * live list cannot be read (no live file, text that is not JSON) the page is written as before. A read that throws
 * refuses the decision, nothing written. Note pages are written as before, byte for byte.
 *
 * The decisions run the fork host the plugin builds, sliced out of RegisterCommands.ts as ForkPdfInkHeld.test.ts
 * does, over the real PageStore and PdfInkStore and an in-memory adapter. No Obsidian.
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
import { PdfInkStore } from "../pdf/PdfInkStore";
import { chooseInstance, familyOf } from "../pdf/PdfIdentity";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";
import { applyForkDecision, forkHostFor, recordFork, resetForks, type ForkHost, type ForkRecord } from "./ForkResolution";

const DEBOUNCE_MS = 700;
const FOLDER = ".handwriting";
const ID = "pdf-9f2c41d07a5e6b38";
const NOTE = "3b7d9e21-0c4a-4f6e-8a15-2d9c7b4e6f80";
const live = (id: string) => `${FOLDER}/${id}.json`;
const PAGE = live(ID);
const NEW = "Papers/New.pdf";
const OLD = "Papers/Old.pdf";
/** The live page's strokes, and the copy's: one more stroke. */
const LIVE_INK = ["s1"];
const COPY_INK = ["s1", "s3"];

/** A PDF stroke on page 1 whose geometry follows its id. */
function stroke(id: string, pdf = true): InkStroke {
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
		...(pdf ? { page: 1 } : {}),
	};
}

/** A page's bytes: its strokes, and its claim when given (none = no `pdfPaths` key). */
function bytes(ids: string[], claim: string[] | null, id = ID): string {
	const p: PageData = emptyPage(id);
	p.surface = id === NOTE ? "inline" : "pdf";
	p.strokes = ids.map((s) => stroke(s, id !== NOTE));
	if (claim !== null) p.pdfPaths = claim;
	return serializePage(p);
}

let fake: FakeAdapter;
/** Paths whose read throws while the file is there, as an adapter error does. */
let readThrows: Set<string>;

function put(path: string, text: string): void {
	fake.files.set(path, text);
	fake.mtimes.set(path, ++fake.clock);
}

/** The file's claim as written: the `pdfPaths` key, or null when there is none; undefined when there is no file. */
function claimAt(path: string): string[] | null | undefined {
	const text = fake.files.get(path);
	if (text === undefined) return undefined;
	const top = JSON.parse(text) as { pdfPaths?: string[] };
	return top.pdfPaths ?? null;
}

function idsAt(path: string, id = ID): string[] | null {
	const text = fake.files.get(path);
	return text === undefined ? null : parsePage(text, id).data.strokes.map((s) => s.id);
}

/** The plugin's fork host: the forkHostFor call in RegisterCommands.ts, run with `this` and the ink store stood in. */
function pluginHost(self: unknown, ink: InlineInkStore): ForkHost {
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
		() => {},
		() => false,
	) as ForkHost;
}

interface Device {
	store: PageStore;
	pdf: PdfInkStore;
	host: ForkHost;
}

/** One device: its PageStore, its PdfInkStore wired to it as the plugin wires it, and the plugin's fork host. */
function device(): Device {
	const store = new PageStore({ vault: { adapter: fake } } as never, FOLDER, () => 5_000_000);
	const pdf = new PdfInkStore();
	pdf.attachHost({
		load: (id, options) => store.load(id, options),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => {},
	});
	const ink = new InlineInkStore();
	ink.attachHost({
		readPageId: () => null,
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: (id: string) => store.load(id),
		scheduleSidecar: (id: string, p: PageData) => store.schedule(id, p),
		scheduleSidecarNow: (id: string, p: PageData) => store.saveNow(id, p),
		notify: () => {},
	} as never);
	const self = {
		app: { vault: { adapter: fake, getFileByPath: () => null } },
		store,
		installId: () => "this-device",
		notePathFor: () => null,
		pdfStore: pdf,
		pdfInk: new Map(),
		pdfIds: new Map(),
	};
	return { store, pdf, host: pluginHost(self, ink) };
}

async function drain(): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
	for (let i = 0; i < 80; i++) await vi.advanceTimersByTimeAsync(0);
}

/** A copy of the live file the save guard kept beside it (or a cut-off save's copy): take the other chooses it. */
function keptCopy(claim: string[] | null, name = `${ID}.conflict-1701.json`, id = ID): ForkRecord {
	const copy = `${FOLDER}/${name}`;
	put(copy, bytes(COPY_INK, claim, id));
	return { pageId: id, path: `${id}.pdf`, outgoingPath: live(id), incomingPath: copy, at: 1, kept: true };
}

/** A pair beside the live file, as an adoption leaves it: keep mine chooses the outgoing leg. */
function pair(outgoingClaim: string[] | null, incomingClaim: string[] | null): ForkRecord {
	const o = `${FOLDER}/${ID}.conflict-external-00000000000000a1-outgoing.json`;
	const i = `${FOLDER}/${ID}.conflict-external-00000000000000a1-incoming.json`;
	put(o, bytes(COPY_INK, outgoingClaim));
	put(i, bytes(LIVE_INK, incomingClaim));
	return { pageId: ID, path: `${ID}.pdf`, outgoingPath: o, incomingPath: i, at: 1 };
}

async function decide(d: Device, rec: ForkRecord, decision: "keep-mine" | "take-theirs") {
	recordFork(rec);
	return applyForkDecision(d.host, rec, decision);
}

/** Which ink an open of `path` takes when only this ink file and the two PDFs exist. */
function openAt(path: string): { id: string; action: string } {
	const claim = claimAt(PAGE) ?? [];
	return chooseInstance(familyOf(ID), path, [{ id: ID, paths: claim }], (p) => p === NEW || p === OLD);
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new FakeAdapter();
	readThrows = new Set();
	const read = fake.read.bind(fake);
	fake.read = async (path: string) => {
		if (readThrows.has(path) && fake.files.has(path)) throw new Error(`EIO injected read ${path}`);
		return read(path);
	};
	resetForks();
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("a decision on a PDF page keeps the live file's claim", () => {
	it("take the other on a kept copy from before a rename: the ink is the copy's, the claim stays the live file's, and the PDF at the old name opens blank", async () => {
		put(PAGE, bytes(LIVE_INK, [NEW]));
		const rec = keptCopy([OLD]);
		const d = device();
		expect(claimAt(rec.incomingPath), "premise: the copy names the old path").toEqual([OLD]);

		const out = await decide(d, rec, "take-theirs");
		expect(out, "applied and written").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(PAGE), "the live file holds the copy's ink").toEqual(COPY_INK);
		expect(claimAt(PAGE), "the live file claims what it claimed before").toEqual([NEW]);
		expect(openAt(NEW), "the restored PDF opens with its ink").toEqual({ id: ID, action: "use" });
		expect(openAt(OLD).action, "the PDF at the old name does not wear this ink").not.toBe("use");
	});

	it("take the other on a copy with no claim: the live file keeps its claim", async () => {
		put(PAGE, bytes(LIVE_INK, [NEW]));
		const rec = keptCopy(null);
		const d = device();
		expect(claimAt(rec.incomingPath), "premise: the copy has no claim").toBeNull();

		const out = await decide(d, rec, "take-theirs");
		expect(out, "applied and written").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(PAGE), "the live file holds the copy's ink").toEqual(COPY_INK);
		expect(claimAt(PAGE), "the live file claims what it claimed before").toEqual([NEW]);
	});

	it("take the other, the live file has no claim and the copy names the old path: no claim before, none after", async () => {
		put(PAGE, bytes(LIVE_INK, null));
		const rec = keptCopy([OLD]);
		const d = device();
		expect(claimAt(PAGE), "premise: the live file has no claim key").toBeNull();

		const out = await decide(d, rec, "take-theirs");
		expect(out, "applied and written").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(PAGE), "the live file holds the copy's ink").toEqual(COPY_INK);
		expect(claimAt(PAGE), "no claim before, none after").toBeNull();
	});

	it("keep mine on a two-device pair whose leg names the old path: the live file keeps its claim", async () => {
		put(PAGE, bytes(LIVE_INK, [NEW]));
		const rec = pair([OLD], [NEW]);
		const d = device();

		const out = await decide(d, rec, "keep-mine");
		expect(out, "applied and written").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(PAGE), "the live file holds this device's leg").toEqual(COPY_INK);
		expect(claimAt(PAGE), "the live file claims what it claimed before").toEqual([NEW]);
	});

	it("take the other on a cut-off save's copy that names the old path: the live file keeps its claim", async () => {
		put(PAGE, bytes(LIVE_INK, [NEW]));
		const rec = keptCopy([OLD], `${ID}.flush-conflict-1702.json`);
		const d = device();

		const out = await decide(d, rec, "take-theirs");
		expect(out, "applied and written").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(PAGE), "the live file holds the copy's ink").toEqual(COPY_INK);
		expect(claimAt(PAGE), "the live file claims what it claimed before").toEqual([NEW]);
	});

	it("a rename still queued when the decision is made: the live file claims the new name the rename gave it", async () => {
		put(PAGE, bytes(LIVE_INK, [OLD]));
		const d = device();
		await d.pdf.ensureLoaded(ID);
		await drain();
		expect(d.pdf.inkReady(ID), "premise: the PDF read soundly").toBe(true);
		const rec = keptCopy([OLD]);
		d.pdf.renamePath(ID, OLD, NEW);
		expect(claimAt(PAGE), "premise: the rename's save is still queued").toEqual([OLD]);

		const out = await decide(d, rec, "take-theirs");
		expect(out, "applied and written").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(PAGE), "the live file holds the copy's ink").toEqual(COPY_INK);
		expect(claimAt(PAGE), "the live file claims the name the rename gave it").toEqual([NEW]);
	});

	it("the write lands with another claim: not saved, and the row stays listed", async () => {
		put(PAGE, bytes(LIVE_INK, [NEW]));
		const rec = keptCopy([OLD]);
		const d = device();
		const saveNow = d.store.saveNow.bind(d.store);
		d.store.saveNow = (id: string, data: PageData) => saveNow(id, { ...data, pdfPaths: [OLD] });

		const out = await decide(d, rec, "take-theirs");
		expect(claimAt(PAGE), "premise: the write put another claim on disk").toEqual([OLD]);
		expect(out, "not saved, the row still listed").toMatchObject({ kind: "refused", wrote: false, stillListed: true, why: "not saved" });
	});

	it("the live file damaged, its JSON whole: its claim is kept", async () => {
		// One stroke entry that is not an object: the file parses as JSON and reads as damaged (PageMigrate counts it).
		const whole = JSON.parse(bytes(LIVE_INK, [NEW])) as { strokes: unknown[] };
		const damaged = JSON.stringify({ ...whole, strokes: [...whole.strokes, 7] });
		put(PAGE, damaged);
		expect(parsePage(damaged, ID).damaged, "premise: the live file reads as damaged").toBe(true);
		const rec = keptCopy([OLD]);
		const d = device();

		const out = await decide(d, rec, "take-theirs");
		expect(out, "applied and written").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(PAGE), "the live file holds the copy's ink").toEqual(COPY_INK);
		expect(claimAt(PAGE), "the live file claims what it claimed before").toEqual([NEW]);
	});

	it("the claim read throws: refused, nothing written, renamed or removed, the row still listed", async () => {
		put(PAGE, bytes(LIVE_INK, [NEW]));
		const rec = keptCopy([OLD]);
		const d = device();
		const before = new Map(fake.files);
		const mark = fake.log.length;
		readThrows.add(PAGE);

		const out = await decide(d, rec, "take-theirs");
		expect(out, "refused, the row still listed").toMatchObject({ kind: "refused", wrote: false, stillListed: true, why: "not saved" });
		expect(fake.log.slice(mark), "nothing written, renamed or removed").toEqual([]);
		expect(new Map(fake.files), "every file as it was").toEqual(before);
	});

	it("keep mine on a kept copy, the claim's stat throws after the page is read: applied, nothing written", async () => {
		put(PAGE, bytes(LIVE_INK, [NEW]));
		const rec = keptCopy([OLD]);
		const d = device();
		let pageRead = false;
		const read0 = fake.read.bind(fake);
		fake.read = async (p: string) => {
			const t = await read0(p);
			if (p === PAGE) pageRead = true;
			return t;
		};
		const stat0 = fake.stat.bind(fake);
		fake.stat = async (p: string) => {
			if (p === PAGE && pageRead) throw new Error(`EIO injected stat ${p}`);
			return stat0(p);
		};

		const out = await decide(d, rec, "keep-mine");
		expect(out, "applied, nothing written").toMatchObject({ kind: "applied", wrote: false, stillListed: false });
		expect(claimAt(PAGE), "the live file as it was").toEqual([NEW]);
	});
});

describe("pins: where the live claim cannot be read, and note pages, the page is written as before", () => {
	it("no live file, keep mine on a pair: applied, the leg's own claim written", async () => {
		const rec = pair([OLD], [NEW]);
		const d = device();
		expect(fake.files.has(PAGE), "premise: no live file").toBe(false);

		const out = await decide(d, rec, "keep-mine");
		expect(out, "applied and written").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(PAGE), "the live file holds this device's leg").toEqual(COPY_INK);
		expect(claimAt(PAGE), "the leg's own claim, as before").toEqual([OLD]);
	});

	it("the live file's text is not JSON: applied, the copy's own claim written", async () => {
		const cut = bytes(LIVE_INK, [NEW]).slice(0, 40);
		put(PAGE, cut);
		const rec = keptCopy([OLD]);
		const d = device();

		const out = await decide(d, rec, "take-theirs");
		expect(out, "applied and written").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(PAGE), "the live file holds the copy's ink").toEqual(COPY_INK);
		expect(claimAt(PAGE), "the copy's own claim, as before").toEqual([OLD]);
	});

	it("the PDF open at the decision: its record keeps its path, and the next save writes it", async () => {
		put(PAGE, bytes(LIVE_INK, [NEW]));
		const d = device();
		await d.pdf.ensureLoaded(ID);
		await drain();
		expect(d.pdf.inkReady(ID), "premise: the PDF read soundly").toBe(true);
		const rec = keptCopy([OLD]);

		const out = await decide(d, rec, "take-theirs");
		expect(out, "applied and written").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(d.pdf.strokes(ID).map((s) => s.id), "the open PDF holds the copy's ink").toEqual(COPY_INK);
		d.pdf.commit(ID, stroke("s5"));
		await drain();
		expect(idsAt(PAGE), "the next save keeps the restored ink").toEqual([...COPY_INK, "s5"]);
		expect(claimAt(PAGE), "the next save names the open PDF's path").toContain(NEW);
	});

	it("a note page whose copy carries a claim: the copy's page written as before, claim and all", async () => {
		put(live(NOTE), bytes(LIVE_INK, null, NOTE));
		const rec = keptCopy(["Stray.pdf"], `${NOTE}.conflict-1701.json`, NOTE);
		const d = device();

		const out = await decide(d, rec, "take-theirs");
		expect(out, "applied and written").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(live(NOTE), NOTE), "the live page holds the copy's ink").toEqual(COPY_INK);
		expect(claimAt(live(NOTE)), "the copy's own key, as before").toEqual(["Stray.pdf"]);
	});

	it("a note page: the copy's page written as before, no claim key", async () => {
		put(live(NOTE), bytes(LIVE_INK, null, NOTE));
		const rec = keptCopy(null, `${NOTE}.conflict-1701.json`, NOTE);
		const d = device();

		const out = await decide(d, rec, "take-theirs");
		expect(out, "applied and written").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(live(NOTE), NOTE), "the live page holds the copy's ink").toEqual(COPY_INK);
		expect(claimAt(live(NOTE)), "no claim key").toBeNull();
	});
});
