/**
 * A FORK CHOICE ON A PDF WHOSE INK IS HELD BACK FROM ITS FILE.
 *
 * A PDF's ink file can read as damaged (a sync tool mid-write), come from a newer version of the plugin, or be still
 * being read. While it is, the PDF store writes nothing to it: ink drawn then lives only in the store's memory, and
 * the file's bytes are left as they are. "Fix ink de-sync" on a clash for that PDF wrote anyway: it copied the file
 * aside, replaced the store's strokes with the chosen side and wrote that side over the file, so the ink drawn under
 * the lock was in no file and in no copy, and a damaged or newer file was overwritten. Made while a read had taken
 * the file and not landed, the read then merged the file under the chosen side, and the next save wrote back strokes
 * that side had erased.
 *
 * A choice that would write is now refused before anything is copied, written, renamed or removed, as the refusals
 * beside it are: the clash stays listed, the store keeps its strokes, the file keeps its bytes, and the ink drawn
 * under the lock is still saved by the next sound read. Once the file reads, the same choice applies. A choice that
 * writes nothing, a PDF with no ink held back, and a lock on another PDF are as before.
 *
 * Under the damaged lock alone it is narrowed: when the store holds no stroke the chosen page lacks and owes
 * nothing, the choice goes through, the damaged bytes set aside first, and the next read lifts the lock. That is the
 * way out of a file that stays damaged. Strokes held in memory that the page lacks, ink owed under the lock, the
 * newer-version lock and a read in flight are still refused.
 *
 * Every cell runs the fork host the plugin builds, sliced out of RegisterCommands.ts and run with stand-ins for the
 * plugin, over the real PageStore and PdfInkStore (wired as the plugin wires them) on an in-memory adapter with fake
 * timers. No Obsidian, no sync tool.
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
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";
import { applyForkDecision, forkHostFor, resetForks, type ForkHost, type ForkRecord } from "./ForkResolution";

const DEBOUNCE_MS = 700;
const FOLDER = ".handwriting";
const ID = "pdfdoc";
const OTHER_ID = "otherpdf";
/** The PDF's live ink file. */
const PAGE = `${FOLDER}/${ID}.json`;
const OTHER_PAGE = `${FOLDER}/${OTHER_ID}.json`;
/** The page before the choice, and the side "keep mine" chooses. */
const BEFORE = ["s1", "s2"];
const CHOSEN = ["s1", "s3"];
/** The bytes a read during a sync tool's write sees: cut off mid-stroke. */
const DAMAGED = `{"schemaVersion":1,"pageId":"${ID}","surface":"pdf","strokes":[{"id":"s1","points":[{"x":1,`;

/** A PDF stroke on page 1 whose geometry follows its id, so the same id is the same stroke in every file. */
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
		page: 1,
	};
}

function bytes(ids: string[], id = ID, version?: number): string {
	const p: PageData = emptyPage(id);
	p.surface = "pdf";
	p.strokes = ids.map(stroke);
	return serializePage(p, version);
}

let fake: FakeAdapter;

function put(path: string, text: string): void {
	fake.files.set(path, text);
	fake.mtimes.set(path, ++fake.clock);
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
	/** Page ids the store was asked to copy aside: a restore does that before it writes. */
	preserved: string[];
	/**
	 * The PDF store's next read waits until release(). With `readNow`, it takes the file's bytes now and lands them at
	 * release(), as a read that has read the file and not yet landed.
	 */
	hold(readNow?: boolean): void;
	release(): void;
	/** The stroke ids a `readNow` hold's read took from the file, null until it has. */
	taken(): string[] | null;
	/** Run once the store has copied the live page aside, before the restore goes on. */
	afterCopy: (() => void) | null;
}

/** One device: its PageStore, its PdfInkStore wired to it as the plugin wires it, and the plugin's fork host. */
function device(): Device {
	const store = new PageStore({ vault: { adapter: fake } } as never, FOLDER, () => 5_000_000);
	const pdf = new PdfInkStore();
	let gate: Promise<void> | null = null;
	let readNow = false;
	let taken: string[] | null = null;
	let open = (): void => {};
	pdf.attachHost({
		load: async (id, options) => {
			if (gate && readNow) {
				const landing = gate;
				const read = await store.load(id, options);
				taken = read ? read.data.strokes.map((s) => s.id) : null;
				await landing;
				return read;
			}
			if (gate) await gate;
			return store.load(id, options);
		},
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
	const d: Device = {
		store,
		pdf,
		host: undefined as unknown as ForkHost,
		preserved: [],
		hold(now = false): void {
			readNow = now;
			gate = new Promise<void>((resolve) => {
				open = (): void => {
					gate = null;
					readNow = false;
					resolve();
				};
			});
		},
		release: (): void => open(),
		taken: (): string[] | null => taken,
		afterCopy: null,
	};
	const preserve = store.preserve.bind(store);
	store.preserve = async (pageId: string) => {
		d.preserved.push(pageId);
		const kept = await preserve(pageId);
		d.afterCopy?.();
		return kept;
	};
	const self = {
		app: { vault: { adapter: fake, getFileByPath: () => null } },
		store,
		installId: () => "this-device",
		notePathFor: () => null,
		pdfStore: pdf,
		pdfInk: new Map(),
		pdfIds: new Map(),
	};
	d.host = pluginHost(self, ink);
	return d;
}

async function drain(): Promise<void> {
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
	for (let i = 0; i < 80; i++) await vi.advanceTimersByTimeAsync(0);
}

/** A preserved pair beside the PDF's ink file, as an adoption would have left it: "keep mine" chooses CHOSEN. */
function pairOnDisk(id = ID): ForkRecord {
	const o = `${FOLDER}/${id}.conflict-external-00000000000000a1-outgoing.json`;
	const i = `${FOLDER}/${id}.conflict-external-00000000000000a1-incoming.json`;
	put(o, bytes(CHOSEN, id));
	put(i, bytes(BEFORE, id));
	return { pageId: id, path: `${id}.pdf`, outgoingPath: o, incomingPath: i, at: 1 };
}

/** A copy of the PDF's ink file the save guard kept beside it: "take the other" chooses the copy. */
function keptCopyOnDisk(): ForkRecord {
	const copy = `${FOLDER}/${ID}.conflict-1701.json`;
	put(copy, bytes(CHOSEN));
	return { pageId: ID, path: `${ID}.pdf`, outgoingPath: PAGE, incomingPath: copy, at: 1, kept: true };
}

function idsAt(path: string): string[] | null {
	const text = fake.files.get(path);
	return text === undefined ? null : parsePage(text, ID).data.strokes.map((s) => s.id);
}

const held = (d: Device): string[] => d.pdf.strokes(ID).map((s) => s.id);

/** The decision on the fork, and everything a refusal must leave as it was: the files byte for byte, and the store. */
async function refusedWithNothingTouched(
	d: Device,
	rec: ForkRecord,
	decision: "keep-mine" | "take-theirs" = "keep-mine",
): Promise<void> {
	const mark = fake.log.length;
	const filesBefore = new Map(fake.files);
	const inStoreBefore = held(d);
	const out = await applyForkDecision(d.host, rec, decision);
	await drain();
	expect(out, "refused, nothing written, the fork still listed").toMatchObject({ kind: "refused", wrote: false, stillListed: true, why: "not saved" });
	expect(d.preserved, "the live page is not copied aside").toEqual([]);
	expect(
		fake.log.slice(mark).filter((l) => /^(write|rename|remove) /.test(l)),
		"the decision writes, renames and removes nothing",
	).toEqual([]);
	expect(new Map(fake.files), "every file holds the bytes it had, none added or gone").toEqual(filesBefore);
	expect(held(d), "the PDF store keeps the strokes it held").toEqual(inStoreBefore);
}

/**
 * The decision on a fork of a PDF under the damaged lock alone, whose record holds no stroke the chosen page
 * lacks and owes nothing: it goes through. The damaged bytes are set aside first, the chosen page is the live file,
 * the fork is no longer listed, and the next read of the file (the live-reload poll) reads it soundly and lifts the
 * lock, so a stroke drawn then is saved. Every want is soft, so each is read even when the first is red.
 */
async function appliedOverDamaged(d: Device, rec: ForkRecord, decision: "keep-mine" | "take-theirs"): Promise<void> {
	const out = await applyForkDecision(d.host, rec, decision);
	await drain();
	expect.soft(out, "applied, written, no longer listed").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
	expect.soft(d.preserved, "the live page was copied aside first").toEqual([ID]);
	expect.soft(
		[...fake.files].some(([path, text]) => path.includes("/trash/") && text === DAMAGED),
		"the damaged bytes are in no copy set aside",
	).toBe(true);
	expect.soft(idsAt(PAGE), "the live page is the chosen side").toEqual(CHOSEN);

	await d.pdf.reloadExternal(ID);
	await drain();
	expect.soft(d.pdf.inkReady(ID), "the next read of the chosen page did not lift the lock").toBe(true);
	expect.soft(held(d), "the store does not show the chosen side").toEqual(CHOSEN);
	d.pdf.commit(ID, stroke("next"));
	await drain();
	expect.soft(idsAt(PAGE), "a stroke drawn after is not saved with the chosen side").toEqual([...CHOSEN, "next"]);
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

describe("a fork choice that would write, on a PDF whose ink is held back from its file", () => {
	it("the ink file damaged, a stroke drawn since: refused, and the next sound read saves the stroke", async () => {
		put(PAGE, DAMAGED);
		const rec = pairOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		d.pdf.commit(ID, stroke("owed"));
		await drain();
		expect(d.pdf.inkReady(ID), "premise: the damaged read locked the PDF").toBe(false);
		expect(held(d), "premise: the store holds the stroke drawn under the lock").toEqual(["owed"]);
		expect(fake.files.get(PAGE), "premise: nothing was written over the damaged file").toBe(DAMAGED);

		await refusedWithNothingTouched(d, rec);

		put(PAGE, bytes(BEFORE));
		await d.pdf.reloadExternal(ID);
		await drain();
		expect(idsAt(PAGE), "the sound read saves the stroke drawn under the lock, with the file's own").toEqual([...BEFORE, "owed"]);
	});

	it("the ink file damaged, nothing drawn, take the other on a kept copy: applied, the damaged bytes set aside, and the next read lifts the lock", async () => {
		put(PAGE, DAMAGED);
		const rec = keptCopyOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		await drain();
		expect(d.pdf.inkReady(ID), "premise: the damaged read locked the PDF").toBe(false);
		expect(held(d), "premise: the store holds no stroke").toEqual([]);

		await appliedOverDamaged(d, rec, "take-theirs");
	});

	it("the ink file written by a newer version: refused, the newer file as it was", async () => {
		const newer = bytes(BEFORE, ID, 3);
		put(PAGE, newer);
		const rec = pairOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		await drain();
		expect(d.pdf.inkReady(ID), "premise: the newer file locked the PDF").toBe(false);
		expect(held(d), "premise: the newer file's ink is shown").toEqual(BEFORE);

		await refusedWithNothingTouched(d, rec);
		expect(fake.files.get(PAGE), "the newer file keeps its bytes").toBe(newer);
	});

	it("the ink file still being read, a stroke drawn meanwhile: refused, and the read's end saves the stroke", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = pairOnDisk();
		const d = device();
		d.hold();
		void d.pdf.ensureLoaded(ID);
		await drain();
		d.pdf.commit(ID, stroke("owed"));
		await drain();
		expect(d.pdf.inkReady(ID), "premise: the read is in flight").toBe(false);
		expect(held(d), "premise: the store holds the stroke drawn during the read").toEqual(["owed"]);

		await refusedWithNothingTouched(d, rec);

		d.release();
		await drain();
		expect(idsAt(PAGE), "the read's end saves the stroke drawn during it, with the file's own").toEqual([...BEFORE, "owed"]);
	});

	it("a read starts while the live page is being copied aside: the chosen side is not written, the file as it was", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = pairOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		await drain();
		expect(d.pdf.inkReady(ID), "premise: the PDF read soundly").toBe(true);
		d.afterCopy = () => {
			d.afterCopy = null;
			d.hold();
			void d.pdf.reloadExternal(ID);
		};
		const mark = fake.log.length;

		const out = await applyForkDecision(d.host, rec, "keep-mine");
		await drain();
		expect(out, "refused, nothing written, the fork still listed").toMatchObject({ kind: "refused", wrote: false, stillListed: true, why: "not saved" });
		expect(fake.log.slice(mark).filter((l) => l === `write ${PAGE}`), "the chosen side was written over the PDF's ink file").toEqual([]);
		expect(fake.files.has(rec.outgoingPath) && fake.files.has(rec.incomingPath), "both fork files keep their fork names").toBe(true);

		d.release();
		await drain();
		expect(idsAt(PAGE), "the PDF's ink file as it was").toEqual(BEFORE);
		expect(held(d), "the store shows the file as it was").toEqual(BEFORE);
	});

	it("a PDF never read is opened while the live page is being copied aside: the chosen side is not written, the file as it was", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = pairOnDisk();
		const d = device();
		expect(d.pdf.generation(ID), "premise: the store holds no record of the PDF").toBeNull();
		d.afterCopy = () => {
			d.afterCopy = null;
			d.hold();
			void d.pdf.ensureLoaded(ID);
		};
		const mark = fake.log.length;

		const out = await applyForkDecision(d.host, rec, "keep-mine");
		await drain();
		expect(d.preserved, "premise: the live page was copied aside, so the open came after the first answer").toEqual([ID]);
		expect(out, "refused, nothing written, the fork still listed").toMatchObject({ kind: "refused", wrote: false, stillListed: true, why: "not saved" });
		expect(fake.log.slice(mark).filter((l) => l === `write ${PAGE}`), "the chosen side was written over the PDF's ink file").toEqual([]);
		expect(fake.files.has(rec.outgoingPath) && fake.files.has(rec.incomingPath), "both fork files keep their fork names").toBe(true);

		d.release();
		await drain();
		expect(idsAt(PAGE), "the PDF's ink file as it was").toEqual(BEFORE);
		expect(held(d), "the store shows the file as it was").toEqual(BEFORE);
	});

	it("the PDF store's answer throws: refused before anything is copied or written", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = pairOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		await drain();
		d.pdf.inkReady = () => {
			throw new Error("injected");
		};

		await refusedWithNothingTouched(d, rec);
		expect(idsAt(PAGE), "the PDF's ink file as it was").toEqual(BEFORE);
	});

	it("the ink file read and not yet landed, take the other on a copy that erased a stroke: refused, and once read the same choice keeps it erased", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = keptCopyOnDisk();
		const d = device();
		d.hold(true);
		void d.pdf.ensureLoaded(ID);
		await drain();
		expect(d.taken(), "premise: the read has taken the file's strokes and not landed them").toEqual(BEFORE);
		expect(d.pdf.inkReady(ID), "premise: the read is in flight").toBe(false);
		expect(BEFORE.filter((s) => !CHOSEN.includes(s)), "premise: the file holds a stroke the chosen copy erased").toEqual(["s2"]);

		await refusedWithNothingTouched(d, rec, "take-theirs");

		d.release();
		await drain();
		expect(held(d), "the read lands the file as it was").toEqual(BEFORE);
		expect(idsAt(PAGE), "the PDF's ink file as it was").toEqual(BEFORE);

		const out = await applyForkDecision(d.host, rec, "take-theirs");
		await drain();
		expect(out, "once read, the same choice applies").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(d.preserved, "the live page was copied aside first").toEqual([ID]);
		expect(held(d), "the store shows the chosen copy").toEqual(CHOSEN);
		d.pdf.commit(ID, stroke("next"));
		await drain();
		expect(idsAt(PAGE), "the next save keeps the erased stroke out").toEqual([...CHOSEN, "next"]);
	});
});

describe("a fork choice on a PDF with no ink held back, or that writes nothing: as before", () => {
	it("control: the damaged file then reads soundly: the same choice applies", async () => {
		put(PAGE, DAMAGED);
		const rec = pairOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		d.pdf.commit(ID, stroke("owed"));
		put(PAGE, bytes(BEFORE));
		await d.pdf.reloadExternal(ID);
		await drain();
		expect(d.pdf.inkReady(ID), "premise: the sound read lifted the lock").toBe(true);
		expect(idsAt(PAGE), "premise: the stroke drawn under the lock is saved").toEqual([...BEFORE, "owed"]);

		const out = await applyForkDecision(d.host, rec, "keep-mine");
		await drain();
		expect(out, "applied, written, no longer listed").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(PAGE), "the live page is the chosen side").toEqual(CHOSEN);
		expect(held(d), "the store shows the chosen side").toEqual(CHOSEN);
		expect(d.preserved, "the live page was copied aside first").toEqual([ID]);
	});

	it("control: the PDF read soundly and open: the choice applies through the store", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = pairOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		await drain();

		const out = await applyForkDecision(d.host, rec, "keep-mine");
		await drain();
		expect(out).toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(PAGE)).toEqual(CHOSEN);
		expect(held(d)).toEqual(CHOSEN);
	});

	it("control: a PDF this session never read: the choice applies", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = pairOnDisk();
		const d = device();
		expect(d.pdf.generation(ID), "premise: the store holds no record of the PDF").toBeNull();

		const out = await applyForkDecision(d.host, rec, "keep-mine");
		await drain();
		expect(out).toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(PAGE)).toEqual(CHOSEN);
	});

	it("control: another PDF's ink file damaged: the choice on this one applies", async () => {
		put(PAGE, bytes(BEFORE));
		put(OTHER_PAGE, DAMAGED.replace(ID, OTHER_ID));
		const rec = pairOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(OTHER_ID);
		await d.pdf.ensureLoaded(ID);
		await drain();
		expect(d.pdf.inkReady(OTHER_ID), "premise: the other PDF is locked").toBe(false);

		const out = await applyForkDecision(d.host, rec, "keep-mine");
		await drain();
		expect(out).toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(idsAt(PAGE)).toEqual(CHOSEN);
	});

	it("control: keep mine on a kept copy while the file is damaged: refused as damaged before any write, as before", async () => {
		put(PAGE, DAMAGED);
		const rec = keptCopyOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		await drain();
		expect(d.pdf.inkReady(ID), "premise: the damaged read locked the PDF").toBe(false);

		// Keep mine reads the live file first, and a file that does not parse is refused there, before the check
		// for ink held back is reached: the kept copy is never retired over a live file that cannot be read.
		const out = await applyForkDecision(d.host, rec, "keep-mine");
		await drain();
		expect(out, "refused as damaged, nothing written, still listed").toMatchObject({ kind: "refused", wrote: false, stillListed: true, why: "damaged" });
		expect(fake.files.get(PAGE), "the damaged file keeps its bytes").toBe(DAMAGED);
		expect(fake.files.has(rec.incomingPath), "the kept copy is not renamed").toBe(true);
	});
});

/**
 * Under the damaged lock alone, a choice that would write goes through when
 * the store's record holds no stroke the written page lacks and owes nothing to the file. Anything else is refused as
 * before: strokes in memory only that the chosen page lacks (a sound read, then a damaged poll), ink owed
 * under the lock, the newer-version lock, a read in flight.
 */
describe("a fork choice that would write while the PDF's ink file is damaged", () => {
	it("nothing drawn, keep mine on a pair: applied, the damaged bytes set aside, and the next read lifts the lock", async () => {
		put(PAGE, DAMAGED);
		const rec = pairOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		await drain();
		expect(d.pdf.inkReady(ID), "premise: the damaged read locked the PDF").toBe(false);
		expect(held(d), "premise: the store holds no stroke").toEqual([]);

		await appliedOverDamaged(d, rec, "keep-mine");
	});

	it("read soundly, then a damaged poll, every stroke held in the chosen side: applied", async () => {
		put(PAGE, bytes(["s1"]));
		const rec = pairOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		put(PAGE, DAMAGED);
		await d.pdf.reloadExternal(ID);
		await drain();
		expect(d.pdf.inkReady(ID), "premise: the damaged poll locked the PDF").toBe(false);
		expect(held(d), "premise: the store keeps the sound read's stroke").toEqual(["s1"]);
		expect(CHOSEN, "premise: the chosen side holds it").toContain("s1");

		await appliedOverDamaged(d, rec, "keep-mine");
	});

	it("refused: read soundly, then a damaged poll, a stroke held in memory that the chosen side lacks", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = pairOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		put(PAGE, DAMAGED);
		await d.pdf.reloadExternal(ID);
		await drain();
		expect(d.pdf.inkReady(ID), "premise: the damaged poll locked the PDF").toBe(false);
		expect(held(d), "premise: the store keeps the sound read's strokes, in memory only").toEqual(BEFORE);
		expect(d.pdf.lockedWithUnsavedInk(), "premise: nothing is owed").toEqual([]);
		expect(BEFORE.filter((s) => !CHOSEN.includes(s)), "premise: the chosen side lacks a stroke the store holds").toEqual(["s2"]);

		await refusedWithNothingTouched(d, rec);
		expect(fake.files.get(PAGE), "the damaged file keeps its bytes").toBe(DAMAGED);
	});

	it("refused: a stroke drawn under the lock is owed, though the chosen side holds the same stroke", async () => {
		put(PAGE, DAMAGED);
		const rec = pairOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		d.pdf.commit(ID, stroke("s3"));
		await drain();
		expect(d.pdf.inkReady(ID), "premise: the damaged read locked the PDF").toBe(false);
		expect(held(d), "premise: the store holds the stroke drawn under the lock").toEqual(["s3"]);
		expect(CHOSEN, "premise: the chosen side holds a stroke of that id").toContain("s3");
		expect(d.pdf.lockedWithUnsavedInk(), "premise: the stroke is owed").toEqual([ID]);

		await refusedWithNothingTouched(d, rec);
		expect(fake.files.get(PAGE), "the damaged file keeps its bytes").toBe(DAMAGED);
	});

	it("pin: the newer-version lock, every stroke held in the chosen side: refused, the newer file as it was", async () => {
		const newer = bytes(["s1"], ID, 3);
		put(PAGE, newer);
		const rec = pairOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		await drain();
		expect(d.pdf.inkReady(ID), "premise: the newer file locked the PDF").toBe(false);
		expect(held(d), "premise: the newer file's ink is shown").toEqual(["s1"]);

		await refusedWithNothingTouched(d, rec);
		expect(fake.files.get(PAGE), "the newer file keeps its bytes").toBe(newer);
	});

	it("pin: a first read in flight, nothing drawn: refused, and the read lands the file as it was", async () => {
		put(PAGE, bytes(BEFORE));
		const rec = pairOnDisk();
		const d = device();
		d.hold();
		void d.pdf.ensureLoaded(ID);
		await drain();
		expect(d.pdf.inkReady(ID), "premise: the read is in flight").toBe(false);
		expect(held(d), "premise: the store holds no stroke").toEqual([]);

		await refusedWithNothingTouched(d, rec);

		d.release();
		await drain();
		expect(idsAt(PAGE), "the PDF's ink file as it was").toEqual(BEFORE);
		expect(held(d), "the read lands the file as it was").toEqual(BEFORE);
	});

	it("pin: the file damaged and read again, that read in flight, nothing drawn: refused", async () => {
		put(PAGE, DAMAGED);
		const rec = pairOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		await drain();
		expect(held(d), "premise: the store holds no stroke").toEqual([]);
		d.hold();
		void d.pdf.reloadExternal(ID);
		await drain();
		expect(d.pdf.inkReady(ID), "premise: the PDF is locked, its read again in flight").toBe(false);

		await refusedWithNothingTouched(d, rec);
		expect(fake.files.get(PAGE), "the damaged file keeps its bytes").toBe(DAMAGED);
		d.release();
		await drain();
	});
});

/**
 * The same choice where a stroke the store holds has the id of one in the chosen side but not its content, or where
 * an erase is still live on the page. A stroke moved, resized or recoloured keeps its id; the store's version of it
 * is in no file under the damaged lock, so the choice is refused. A stroke the file holds as the store does, to the
 * file's own grain (points to 0.01), is the same stroke.
 */
describe("a fork choice under the damaged lock: the strokes held compared as the file stores them", () => {
	it("refused: a stroke moved in place (same id) read soundly, then a damaged poll; the chosen side holds that id where it was", async () => {
		const s1 = stroke("s1");
		const moved: InkStroke = {
			...s1,
			points: s1.points.map((p) => ({ ...p, x: p.x + 300 })),
			bbox: { ...s1.bbox, x: s1.bbox.x + 300 },
		};
		const p = emptyPage(ID);
		p.surface = "pdf";
		p.strokes = [moved];
		put(PAGE, serializePage(p));
		const rec = pairOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		put(PAGE, DAMAGED);
		await d.pdf.reloadExternal(ID);
		await drain();
		const movedX = moved.points[0]!.x;
		expect(d.pdf.inkReady(ID), "premise: the damaged poll locked the PDF").toBe(false);
		expect(d.pdf.lockedWithUnsavedInk(), "premise: nothing is owed").toEqual([]);
		expect(d.pdf.strokes(ID).map((s) => [s.id, s.points[0]!.x]), "premise: the store holds s1 where it was moved").toEqual([["s1", movedX]]);
		expect(CHOSEN, "premise: the chosen side holds s1").toContain("s1");
		expect(s1.points[0]!.x, "premise: the chosen side's s1 is where it was before the move").not.toBe(movedX);

		await refusedWithNothingTouched(d, rec);
		expect(fake.files.get(PAGE), "the damaged file keeps its bytes").toBe(DAMAGED);
		expect(d.pdf.strokes(ID).map((s) => s.points[0]!.x), "the store keeps s1 where it was moved").toEqual([movedX]);
	});

	it("applied: a stroke drawn off the file's grain and saved, then a damaged poll; the chosen side holds it as the file stored it", async () => {
		put(PAGE, bytes([]));
		const rec = pairOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		const s1 = stroke("s1");
		const drawn: InkStroke = {
			...s1,
			points: s1.points.map((p, i) => ({ ...p, x: p.x + 0.004 + i * 0.0013, y: p.y + 0.0071, pressure: 0.50037 })),
		};
		d.pdf.commit(ID, drawn);
		await drain();
		const saved = fake.files.get(PAGE)!;
		const filed = parsePage(saved, ID).data;
		expect(filed.strokes.map((s) => s.id), "premise: the drawn stroke was saved").toEqual(["s1"]);
		expect(filed.strokes[0]!.points[0]!.x, "premise: the file keeps the point to its grain, not as drawn").not.toBe(drawn.points[0]!.x);
		// The chosen side: the file as it was saved, with s3 beside it.
		filed.strokes.push(stroke("s3"));
		put(rec.outgoingPath, serializePage(filed));
		put(PAGE, DAMAGED);
		await d.pdf.reloadExternal(ID);
		await drain();
		expect(d.pdf.inkReady(ID), "premise: the damaged poll locked the PDF").toBe(false);
		expect(d.pdf.lockedWithUnsavedInk(), "premise: nothing is owed").toEqual([]);
		expect(d.pdf.strokes(ID).map((s) => s.points[0]!.x), "premise: the store holds s1 as drawn").toEqual([drawn.points[0]!.x]);

		await appliedOverDamaged(d, rec, "keep-mine");
	});

	it("refused: a live erase cut a held stroke into a piece the chosen side lacks; nothing copied or written", async () => {
		put(PAGE, bytes(["s1"]));
		const rec = pairOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		put(PAGE, DAMAGED);
		await d.pdf.reloadExternal(ID);
		await drain();
		const s1 = stroke("s1");
		const piece: InkStroke = { ...stroke("s1"), id: "s1-piece" };
		d.pdf.applyLivePage(ID, { type: "replace", path: ID, removed: [s1], removedAt: [0], inserted: [piece], insertedAt: [0] } as never);
		expect(d.pdf.inkReady(ID), "premise: the damaged poll locked the PDF").toBe(false);
		expect(d.pdf.lockedWithUnsavedInk(), "premise: nothing is owed, the erase is live").toEqual([]);
		expect(d.pdf.strokesOnPage(ID, 1).map((s) => s.id), "premise: the live page holds the piece").toEqual(["s1-piece"]);
		expect(CHOSEN, "premise: the chosen side lacks the piece").not.toContain("s1-piece");
		const mark = fake.log.length;

		const out = await applyForkDecision(d.host, rec, "keep-mine");
		await drain();
		expect.soft(out, "refused, nothing written, the fork still listed").toMatchObject({ kind: "refused", wrote: false, stillListed: true, why: "not saved" });
		expect.soft(d.preserved, "the live page is not copied aside").toEqual([]);
		expect.soft(fake.log.slice(mark).filter((l) => /^(write|rename|remove) /.test(l)), "the decision writes, renames and removes nothing").toEqual([]);
		expect.soft(fake.files.get(PAGE), "the damaged file keeps its bytes").toBe(DAMAGED);
		expect.soft(d.pdf.strokesOnPage(ID, 1).map((s) => s.id), "the live page still holds the piece").toEqual(["s1-piece"]);
	});

	it("applied: a live erase took a held stroke whole, every id in the chosen side; the store holds the chosen side whole", async () => {
		put(PAGE, bytes(CHOSEN));
		const rec = pairOnDisk();
		const d = device();
		await d.pdf.ensureLoaded(ID);
		put(PAGE, DAMAGED);
		await d.pdf.reloadExternal(ID);
		await drain();
		const s3 = stroke("s3");
		d.pdf.applyLivePage(ID, { type: "replace", path: ID, removed: [s3], removedAt: [1], inserted: [], insertedAt: [] } as never);
		expect(d.pdf.inkReady(ID), "premise: the damaged poll locked the PDF").toBe(false);
		expect(d.pdf.strokesOnPage(ID, 1).map((s) => s.id), "premise: the erase is live on page 1").toEqual(["s1"]);

		const out = await applyForkDecision(d.host, rec, "keep-mine");
		await drain();
		expect.soft(out, "applied, written, no longer listed").toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect.soft(idsAt(PAGE), "the live file is the chosen side").toEqual(CHOSEN);
		expect.soft(d.pdf.strokesOnPage(ID, 1).map((s) => s.id), "the page read serves the chosen side").toEqual(CHOSEN);
		expect.soft(held(d), "a whole read holds the chosen side whole").toEqual(CHOSEN);
	});
});
