/**
 * A COPY'S DUPLICATE REPAIR ON A PDF'S ID KEEPS THE PDF'S QUEUED SAVE.
 *
 * A note's page-id line is free text: a copied property, a template or a hand edit can make it name a PDF's ink id
 * (`pdf-<hex>`), and "Make a copy" of that note gives two notes on the PDF's id. When the copy is seen, the duplicate
 * repair gives it a fresh id. With the owner note not open, the repair takes that as proof that the copy was the only
 * writer under the shared id and drops the id's queued save with no write. Under a PDF's id the PDF is a writer too:
 * the stroke drawn on the PDF in the 700 ms before is in that queued save. The PDF's record still holds the stroke, but
 * closing the PDF's pane forgets the record once nothing is queued, and a quit finds nothing queued to write. The
 * stroke is on no disk.
 *
 * The correct behaviour: the stroke is in the PDF's ink file after the pane closes and after a quit, and the PDF
 * reopens with it. The control cells have the owner note open: the repair re-queues the owner's own record (which
 * writes nothing on a PDF's page) and drops nothing.
 *
 * Real PageStore over FakeAdapter, real PdfInkStore wired as the plugin wires it (PluginSettings.ts: loads and saves
 * through the page store), real identity code (census, identity check, duplicate repair), the plugin's own PDF release
 * (releasePdfId) and quit hook (flushOnQuit). The rig is NoteIdMoveKeepsPdfInk.test.ts's, with the PDF's store added.
 *
 * Assertions state the CORRECT behaviour: green = no bug, red = bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { emptyPage, type PageData, parsePage, serializePage } from "../model/PageData";
import { FakeAdapter } from "./FakeAdapter";
import { PageStore } from "./PageStore";
import { PdfInkStore } from "../pdf/PdfInkStore";
import type { InkStroke } from "../ink/Stroke";

const OWNER = "Owner.md";
const COPY = "Owner 1.md";
/** A PDF's ink id. */
const P = "pdf-3fa9c0de";
const PDF_PATH = "Doc.pdf";
/** How long the app's close waits on unsaved ink (PluginLifecycle.ts QUIT_CAP_MS). */
const QUIT_CAP_MS = 3000;
/** The PDF's pane, as the plugin keys it. */
const PANE = {} as HTMLElement;

function stroke(id: string, x: number): InkStroke {
	return {
		id,
		color: "#000",
		width: 2,
		tool: "pen",
		points: [
			{ x, y: 10, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: x - 2, y: 8, width: 16, height: 16 },
		createdAt: 1,
		page: 1,
	} as InkStroke;
}

/** The PDF's ink page: its strokes on page 1, and its claim on the document. */
function pdfPage(strokeIds: string[], id = P): string {
	const p = { ...emptyPage(id), surface: "pdf", coordSpace: "page-css@1", pdfPaths: [PDF_PATH] } as PageData;
	p.strokes = strokeIds.map((s, i) => stroke(s, 30 + 20 * i));
	return serializePage(p);
}

const file = (id: string): string => `.handwriting/${id}.json`;

const note = (id: string, body: string): string => `---\nhandwriting-page-id: ${id}\n---\n${body}\n`;

function frontmatterOf(text: string): Record<string, string> | undefined {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines[0] !== "---") return undefined;
	const close = lines.indexOf("---", 1);
	if (close < 0) return undefined;
	const out: Record<string, string> = {};
	for (const line of lines.slice(1, close)) {
		if (line.trim() === "") continue;
		const i = line.indexOf(":");
		if (i <= 0) return undefined;
		out[line.slice(0, i)] = line.slice(i + 1).trim();
	}
	return out;
}

function cacheOf(text: string) {
	const lines = text.split("\n");
	const block = lines[0] === "---" && lines.indexOf("---", 1) > 0;
	const sections = [...(block ? [{ type: "yaml" }] : []), { type: "paragraph" }];
	const frontmatter = frontmatterOf(text);
	return frontmatter === undefined ? { sections } : { frontmatter, sections };
}

const tfile = (path: string): TFile => Object.assign(new TFile(), { path, extension: "md", basename: path.slice(0, -3) });

interface RigOptions {
	/** The PDF's ink id (default P). */
	pdfId?: string;
	/** The id both notes' id lines name (default the PDF's id). */
	noteId?: string;
	/** The PDF's ink file is on disk with stroke p1 (default true). False: the PDF's first save is still to come. */
	pdfFile?: boolean;
}

/** One app session: the owner note on the PDF's id at the census, the PDF's ink file with stroke p1. */
function rig(options: RigOptions = {}) {
	const pdfId = options.pdfId ?? P;
	const noteId = options.noteId ?? pdfId;
	const fake = new FakeAdapter();
	if (options.pdfFile !== false) fake.files.set(file(pdfId), pdfPage(["p1"], pdfId));
	const texts = new Map<string, string>([[OWNER, note(noteId, "Owner body")]]);
	const files = new Map<string, TFile>([[OWNER, tfile(OWNER)]]);
	const listed = new Set<string>([OWNER]);
	const cached = new Set<string>([OWNER]);
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const pdf = new PdfInkStore();
	pdf.attachHost({
		load: (id, options) => store.load(id, options),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => undefined,
	});
	const plugin: any = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		pageIdWatchReady: true,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		declaimTimers: new Map<string, number>(),
		declaimedPaths: new Set<string>(),
		resolvingDuplicates: new Set<TFile>(),
		pendingRecycle: new Map(),
		settings: { pageOwners: {}, cameras: {} },
		settingsDirty: false,
		settingsTimer: null,
		flushSettings: async () => undefined,
		persistOwners: () => {},
		unloaded: false,
		store,
		pdfStore: pdf,
		pdfIds: new Map<HTMLElement, string>(),
		pdfFiles: new Map<HTMLElement, string>(),
		pdfInk: new Map(),
		app: {
			vault: {
				adapter: fake,
				getFileByPath: (p: string) => (listed.has(p) ? files.get(p)! : null),
				getAbstractFileByPath: (p: string) => (listed.has(p) ? files.get(p)! : null),
				getMarkdownFiles: () => [...listed].map((p) => files.get(p)!),
				getFiles: () => [...listed].map((p) => files.get(p)!),
				process: async (f: { path: string }, fn: (data: string) => string) => {
					await Promise.resolve();
					const after = fn(texts.get(f.path)!);
					texts.set(f.path, after);
					return after;
				},
			},
			metadataCache: {
				getCache: (p: string) => (cached.has(p) && texts.has(p) ? cacheOf(texts.get(p)!) : null),
				getFileCache: (f: { path: string }) => (cached.has(f.path) && texts.has(f.path) ? cacheOf(texts.get(f.path)!) : null),
			},
		},
	});
	const host: InlineInkHost = {
		readPageId: (path) => plugin.notePageId(path),
		claimId: (path, proposedId) => plugin.claimNotePageId(path, proposedId),
		loadSidecar: (pageId) => store.load(pageId),
		scheduleSidecar: (pageId, page) => store.schedule(pageId, page),
		scheduleSidecarNow: (pageId, page) => store.saveNow(pageId, page),
		notify: () => undefined,
	};
	inlineInk.attachHost(host);
	plugin.buildPageIdIndex();
	return { fake, texts, files, listed, cached, store, pdf, plugin, pdfId, noteId };
}

type Rig = ReturnType<typeof rig>;

async function pastEveryTimer(): Promise<void> {
	for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2000);
}

/** The stroke ids in an ink file on disk: by default the PDF's. */
function onDisk(r: Rig, id: string = r.pdfId): string[] {
	const text = r.fake.files.get(file(id));
	return text === undefined ? [] : parsePage(text, id).data.strokes.map((s) => s.id);
}

/** A pane opens on the PDF: the plugin keys the pane to the PDF's id and the PDF store reads its ink. */
async function openPdf(r: Rig): Promise<void> {
	r.plugin.pdfIds.set(PANE, r.pdfId);
	r.plugin.pdfFiles.set(PANE, PDF_PATH);
	await r.pdf.ensureLoaded(r.pdfId);
}

/** The PDF's pane closes, as the plugin's window close lets a pane go: off the maps, then releasePdfId. */
function closePdf(r: Rig): void {
	r.plugin.pdfIds.delete(PANE);
	r.plugin.pdfFiles.delete(PANE);
	r.plugin.releasePdfId(r.pdfId);
}

/** "Make a copy" of the owner note: a new note with the same text, listed and indexed. */
function makeCopy(r: Rig): void {
	r.texts.set(COPY, r.texts.get(OWNER)!);
	r.files.set(COPY, tfile(COPY));
	r.listed.add(COPY);
	r.cached.add(COPY);
}

/** The app quits: the plugin's quit hook, and every task it adds run as the window runs them, capped. */
async function quit(r: Rig): Promise<void> {
	const tasks: (() => Promise<void>)[] = [];
	r.plugin.flushOnQuit({ add: (fn: () => Promise<void>) => void tasks.push(fn) });
	for (const task of tasks) {
		const done = task();
		await vi.advanceTimersByTimeAsync(QUIT_CAP_MS);
		await done;
	}
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	for (const p of [OWNER, COPY]) inlineInk.handleDelete(p);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("a copy of a note on a PDF's id is repaired while the PDF's last stroke waits to save", () => {
	for (const ownerOpen of [false, true]) {
		for (const exit of ["close", "quit"] as const) {
			const who = ownerOpen ? "control, the owner note open" : "the owner note closed";
			const then = exit === "close" ? "the PDF's pane then closes" : "the app then quits";
			it(`${who}, ${then}: the PDF's ink file holds the stroke`, async () => {
				const r = rig();
				expect(r.plugin.pageIds.owner(P), "precondition: the census made the owner note the PDF id's owner").toBe(OWNER);
				await openPdf(r);
				expect(r.pdf.strokes(P).map((s) => s.id), "precondition: the PDF's pane shows its ink").toEqual(["p1"]);
				if (ownerOpen) {
					await inlineInk.ensureLoaded(OWNER);
					expect(inlineInk.pageIdOf(OWNER), "precondition: the owner's record is on the PDF's id").toBe(P);
				} else {
					expect(inlineInk.pageIdOf(OWNER), "precondition: the owner note is not open").toBeNull();
				}
				makeCopy(r);
				await inlineInk.ensureLoaded(COPY);
				expect(inlineInk.pageIdOf(COPY), "precondition: the copy's record is on the PDF's id").toBe(P);

				r.pdf.commit(P, stroke("p2", 70));
				expect(r.store.hasQueuedWrite(P), "precondition: the PDF's stroke waits in its save").toBe(true);
				expect(onDisk(r), "precondition: the PDF's save has not landed").toEqual(["p1"]);

				r.plugin.checkPageIdentity(COPY);
				await vi.advanceTimersByTimeAsync(50);
				const copyId = frontmatterOf(r.texts.get(COPY)!)?.["handwriting-page-id"];
				expect(copyId, "precondition: the repair gave the copy its own id").not.toBe(P);
				expect(r.plugin.pageIds.owner(P), "precondition: the owner note still owns the PDF's id").toBe(OWNER);
				expect
					.soft(r.store.hasQueuedWrite(P) || onDisk(r).includes("p2"), "the repair dropped the PDF's queued save with no write")
					.toBe(true);

				if (exit === "close") {
					await pastEveryTimer();
					closePdf(r);
					await pastEveryTimer();
					expect.soft(onDisk(r), "the PDF's ink file lost the stroke drawn before its pane closed").toEqual(["p1", "p2"]);
					await openPdf(r);
					expect.soft(r.pdf.strokes(P).map((s) => s.id), "the PDF reopens without the stroke").toEqual(["p1", "p2"]);
				} else {
					await quit(r);
					expect.soft(onDisk(r), "the PDF's ink file lost the stroke drawn before the app quit").toEqual(["p1", "p2"]);
				}
			});
		}
	}
});

/** The same PDF's second instance in the vault: an id isPdfInkId takes (PdfIdentity.ts INSTANCE). */
const P_INSTANCE = "pdf-3fa9c0de-2";
/** The PDF's id in capitals, as an id line can name it. */
const P_CAPS = "PDF-3FA9C0DE";
/** A note's own id, in newPageId's shape. */
const N = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
/** A note's id with the PDF prefix that is not a PDF's (no hex after it): isPdfInkId says no. */
const N_PDF_WORD = "pdf-notes";

/** The identity check sees the copy, and the repair gives it its own id: that id. */
async function repairCopy(r: Rig): Promise<string> {
	r.plugin.checkPageIdentity(COPY);
	await vi.advanceTimersByTimeAsync(50);
	const copyId = frontmatterOf(r.texts.get(COPY)!)?.["handwriting-page-id"];
	expect(typeof copyId === "string" && copyId !== r.noteId, "precondition: the repair gave the copy its own id").toBe(true);
	expect(r.plugin.pageIds.owner(r.noteId), "precondition: the owner note still owns the shared id").toBe(OWNER);
	return copyId!;
}

/** The PDF's pane closes after every save timer has run, and every timer after it runs too. */
async function closeAfterTimers(r: Rig): Promise<void> {
	await pastEveryTimer();
	closePdf(r);
	await pastEveryTimer();
}

describe("the repair keeps a PDF's queued save in every shape, and drops a note id's as before", () => {
	it("the PDF's first save, no ink file yet, the copy open and the owner note closed: the PDF's ink file holds the stroke after its pane closes", async () => {
		const r = rig({ pdfFile: false });
		expect(r.plugin.pageIds.owner(P), "precondition: the census made the owner note the PDF id's owner").toBe(OWNER);
		await openPdf(r);
		expect(r.pdf.strokes(P), "precondition: the PDF has no ink yet").toEqual([]);
		expect(inlineInk.pageIdOf(OWNER), "precondition: the owner note is not open").toBeNull();
		makeCopy(r);
		await inlineInk.ensureLoaded(COPY);
		expect(inlineInk.pageIdOf(COPY), "precondition: the copy's record is on the PDF's id").toBe(P);
		expect(inlineInk.record(COPY).legacyLocked, "precondition: with no file to read, the copy's record is not locked").toBe(false);

		// The copy does not draw: a note's stroke under the PDF's id would replace the PDF's queued save on its own.
		r.pdf.commit(P, stroke("p1", 30));
		expect(r.store.hasQueuedWrite(P), "precondition: the PDF's first stroke waits in its save").toBe(true);
		expect(r.fake.files.has(file(P)), "precondition: the PDF's first save has not landed").toBe(false);

		await repairCopy(r);
		expect
			.soft(r.store.hasQueuedWrite(P) || onDisk(r).includes("p1"), "the repair dropped the PDF's first save with no write")
			.toBe(true);
		await closeAfterTimers(r);
		expect.soft(onDisk(r), "the PDF's ink file lost its first stroke drawn before its pane closed").toEqual(["p1"]);
		await openPdf(r);
		expect.soft(r.pdf.strokes(P).map((s) => s.id), "the PDF reopens without its first stroke").toEqual(["p1"]);
	});

	for (const step of ["clone", "rewrite"] as const) {
		const during = step === "clone" ? "while the repair clones the ink" : "while the repair rewrites the copy's id line";
		it(`the copy closed and the owner note closed, a PDF stroke committed ${during}: the PDF's ink file holds it after its pane closes`, async () => {
			const r = rig();
			await openPdf(r);
			makeCopy(r);
			expect(inlineInk.pageIdOf(OWNER), "precondition: the owner note is not open").toBeNull();
			expect(inlineInk.pageIdOf(COPY), "precondition: the copy is not open").toBeNull();
			r.pdf.commit(P, stroke("p2", 70));
			expect(r.store.hasQueuedWrite(P), "precondition: the PDF's stroke waits in its save").toBe(true);

			let diskInside: string[] | null = null;
			const commitInside = (): void => {
				if (diskInside !== null) return;
				diskInside = onDisk(r);
				r.pdf.commit(P, stroke("p3", 110));
			};
			if (step === "clone") {
				const clone = r.store.clone.bind(r.store);
				vi.spyOn(r.store, "clone").mockImplementation(async (fromId: string, toId: string) => {
					if (fromId === P) commitInside();
					return clone(fromId, toId);
				});
			} else {
				const process = r.plugin.app.vault.process;
				r.plugin.app.vault.process = (f: { path: string }, fn: (data: string) => string) =>
					process(f, (data: string) => {
						if (f.path === COPY) commitInside();
						return fn(data);
					});
			}

			await repairCopy(r);
			expect(diskInside, `precondition: the PDF's stroke was committed inside the ${step}, after the repair wrote the queued save`).toEqual(["p1", "p2"]);
			expect
				.soft(r.store.hasQueuedWrite(P) || onDisk(r).includes("p3"), `the repair dropped the PDF's stroke committed during the ${step}`)
				.toBe(true);
			await closeAfterTimers(r);
			expect.soft(onDisk(r), `the PDF's ink file lost the stroke committed during the ${step}`).toEqual(["p1", "p2", "p3"]);
			await openPdf(r);
			expect.soft(r.pdf.strokes(P).map((s) => s.id), "the PDF reopens without the stroke").toEqual(["p1", "p2", "p3"]);
		});
	}

	it("both notes name the PDF's id in capitals and the copy draws, the owner note closed: the capital name's queued save is not dropped, and lands", async () => {
		const r = rig({ noteId: P_CAPS });
		expect(r.plugin.pageIds.owner(P_CAPS), "precondition: the census made the owner note the capital id's owner").toBe(OWNER);
		expect(r.fake.files.has(file(P_CAPS)), "precondition: this disk tells case apart and has no file under the capital name").toBe(false);
		makeCopy(r);
		await inlineInk.ensureLoaded(COPY);
		expect(inlineInk.pageIdOf(COPY), "precondition: the copy's record is on the capital id").toBe(P_CAPS);
		expect(inlineInk.record(COPY).legacyLocked, "precondition: the copy's record is a note's, not locked").toBe(false);
		inlineInk.commit(COPY, stroke("c1", 50));
		expect(r.store.hasQueuedWrite(P_CAPS), "precondition: the copy's stroke waits under the capital name").toBe(true);

		const copyId = await repairCopy(r);
		expect
			.soft(r.store.hasQueuedWrite(P_CAPS) || onDisk(r, P_CAPS).includes("c1"), "the repair dropped the save queued under the PDF's id in capitals")
			.toBe(true);
		await pastEveryTimer();
		expect.soft(onDisk(r, P_CAPS), "the save queued under the PDF's id in capitals never landed").toEqual(["c1"]);
		expect(onDisk(r, copyId), "precondition: the copy's stroke followed it to its own id").toContain("c1");
		expect(onDisk(r), "precondition: the PDF's own ink file is untouched").toEqual(["p1"]);
	});

	for (const id of [N, N_PDF_WORD]) {
		const which = id === N ? "a note's own id" : `a note id with the PDF prefix that is not a PDF's (${id})`;
		it(`${which}, the copy draws, the owner note closed: the shared id's queued save is dropped as before, and the stroke follows the copy`, async () => {
			const r = rig({ noteId: id });
			expect(r.plugin.pageIds.owner(id), "precondition: the census made the owner note the id's owner").toBe(OWNER);
			makeCopy(r);
			await inlineInk.ensureLoaded(COPY);
			expect(inlineInk.pageIdOf(COPY), "precondition: the copy's record is on the shared id").toBe(id);
			inlineInk.commit(COPY, stroke("c1", 50));
			expect(r.store.hasQueuedWrite(id), "precondition: the copy's stroke waits under the shared id").toBe(true);

			const copyId = await repairCopy(r);
			expect.soft(r.store.hasQueuedWrite(id), "the repair kept the copy's save queued under the shared id").toBe(false);
			await pastEveryTimer();
			expect.soft(onDisk(r, id), "the copy's stroke landed in the owner note's ink file").toEqual([]);
			expect.soft(onDisk(r, copyId), "the copy's stroke did not follow it to its own id").toEqual(["c1"]);
		});
	}

	it("an instance id of the PDF, the owner note closed, the PDF's pane then closes: the PDF's ink file holds the stroke", async () => {
		const r = rig({ pdfId: P_INSTANCE });
		expect(r.plugin.pageIds.owner(P_INSTANCE), "precondition: the census made the owner note the instance id's owner").toBe(OWNER);
		await openPdf(r);
		expect(r.pdf.strokes(P_INSTANCE).map((s) => s.id), "precondition: the PDF's pane shows its ink").toEqual(["p1"]);
		expect(inlineInk.pageIdOf(OWNER), "precondition: the owner note is not open").toBeNull();
		makeCopy(r);
		await inlineInk.ensureLoaded(COPY);
		expect(inlineInk.pageIdOf(COPY), "precondition: the copy's record is on the instance id").toBe(P_INSTANCE);

		r.pdf.commit(P_INSTANCE, stroke("p2", 70));
		expect(r.store.hasQueuedWrite(P_INSTANCE), "precondition: the PDF's stroke waits in its save").toBe(true);
		expect(onDisk(r), "precondition: the PDF's save has not landed").toEqual(["p1"]);

		await repairCopy(r);
		expect
			.soft(r.store.hasQueuedWrite(P_INSTANCE) || onDisk(r).includes("p2"), "the repair dropped the PDF's queued save with no write")
			.toBe(true);
		await closeAfterTimers(r);
		expect.soft(onDisk(r), "the PDF's ink file lost the stroke drawn before its pane closed").toEqual(["p1", "p2"]);
		await openPdf(r);
		expect.soft(r.pdf.strokes(P_INSTANCE).map((s) => s.id), "the PDF reopens without the stroke").toEqual(["p1", "p2"]);
	});
});
