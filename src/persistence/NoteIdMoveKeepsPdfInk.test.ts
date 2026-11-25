/**
 * A NOTE'S ID MOVE NEVER TAKES A PDF'S INK.
 *
 * A note's page-id line is free text: a copied property, a template or a hand edit can make it name a PDF's ink id
 * (`pdf-<hex>`). When that note then leaves the id (a merge into it, an id edit synced in or typed), its id move set
 * the PDF's ink file beside the id the note ends on: the PDF opened blank and its ink sat under a note's id. The other
 * way round, a note that ends on a PDF's id set its own ink file under or beside the PDF's.
 *
 * The correct behaviour: a PDF's ink id is never a note's own. The note still lets the id go, and no move runs: the
 * PDF's file stays under its id with its strokes, its id and its claim, and nothing of the note's goes under or beside
 * it. Every road into the store's keepAsideUnder is asked: the closed note's leave (a merge, both orders), the open
 * note's follow (off the PDF's id and onto it), the launch's finish of a move an older build kept, that finish's
 * fallback after a throw, and a save that lands under an id the launch moved.
 *
 * The same rule at a note's delete. The delete handler refuses to recycle a PDF's id and to unlock a note on one, but
 * it asked in lower case only: a note whose line names the PDF's id in capitals, deleted on a disk that does not tell
 * case apart, sent the PDF's ink file to the ink trash after the grace, and the PDF opened blank. The id is asked
 * case-blind now: the PDF's file stays under its id, none of it in the trash, and an ordinary note's ink still goes.
 *
 * Real PageStore over FakeAdapter, real identity code (census, identity check, the grace timer, the follow), the real
 * delete handler for the trash. The rig is MergeKeepsTargetInk.test.ts's, with a PDF's page added.
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
import { slidesSidecarId } from "../slides/SlidesSections";
import type { InkStroke } from "../ink/Stroke";

const TARGET = "Target.md";
const SOURCE = "Source.md";
const PB = "page-of-target";
const PA = "page-of-source";
const E = "page-edited";
/** A PDF's ink id, and the same id as a hand edit can type it. */
const P = "pdf-3fa9c0de";
const P_CAPS = "pdf-3FA9C0DE";
const PDF_PATH = "Doc.pdf";

type Order = "target-heard-first" | "source-trashed-first";
const ORDERS: Order[] = ["target-heard-first", "source-trashed-first"];

function stroke(id: string, x = 10, page?: number): InkStroke {
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
		...(page !== undefined ? { page } : {}),
	} as InkStroke;
}

function inlinePage(id: string, strokeId: string): string {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = [stroke(strokeId, 5)];
	return serializePage(p);
}

function slidesPage(id: string, strokeId: string): string {
	const p = { ...emptyPage(slidesSidecarId(id)), surface: "slides", coordSpace: "slide-logical", deck: { width: 960, height: 700 } } as PageData;
	p.strokes = [stroke(strokeId, 40, 1)];
	return serializePage(p);
}

/** A PDF's ink page: its strokes on page 1, and its claim on the document. */
function pdfPageData(id: string, strokeIds: string[]): PageData {
	const p = { ...emptyPage(id), surface: "pdf", coordSpace: "page-css@1", pdfPaths: [PDF_PATH] } as PageData;
	p.strokes = strokeIds.map((s, i) => stroke(s, 30 + 20 * i, 1));
	return p;
}

const pdfPage = (id: string, strokeIds: string[]): string => serializePage(pdfPageData(id, strokeIds));

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

/** A disk that does not tell case apart in a name (Windows, macOS): a path finds the file whose name matches it case-blind. */
class CaseBlindAdapter extends FakeAdapter {
	private key(path: string): string {
		const low = path.toLowerCase();
		for (const k of this.files.keys()) if (k.toLowerCase() === low) return k;
		return path;
	}
	override async exists(path: string): Promise<boolean> {
		return super.exists(this.key(path));
	}
	override async read(path: string): Promise<string> {
		return super.read(this.key(path));
	}
	override async write(path: string, data: string): Promise<void> {
		return super.write(this.key(path), data);
	}
	override async rename(from: string, to: string): Promise<void> {
		return super.rename(this.key(from), this.key(to));
	}
	override async remove(path: string): Promise<void> {
		return super.remove(this.key(path));
	}
	override async stat(path: string): Promise<{ mtime: number; size?: number } | null> {
		return super.stat(this.key(path));
	}
}

type Vault = {
	fake: FakeAdapter;
	texts: Map<string, string>;
	files: Map<string, TFile>;
	listed: Set<string>;
	cached: Set<string>;
};

/** The target names `targetId`, the source `sourceId`; `ink` is every ink file, by id. */
function vaultWith(targetId: string, sourceId: string, ink: Record<string, string>, fake: FakeAdapter = new FakeAdapter()): Vault {
	for (const [id, text] of Object.entries(ink)) fake.files.set(file(id), text);
	const texts = new Map<string, string>([
		[TARGET, note(targetId, "Target body")],
		[SOURCE, note(sourceId, "Source body")],
	]);
	const files = new Map<string, TFile>();
	for (const path of texts.keys()) files.set(path, Object.assign(new TFile(), { path, extension: "md", basename: path.slice(0, -3) }));
	return { fake, texts, files, listed: new Set(texts.keys()), cached: new Set(texts.keys()) };
}

/**
 * One app session over `vault`; `settings` carries what the last session kept (a launch). Every call into
 * keepAsideUnder is recorded in `moves`, from every road: the identity code's and the store's own. `failFirstMove`:
 * the first such call throws. `onMove`: called with each such call before it runs.
 */
function session(vault: Vault, settings: Record<string, unknown> = { pageOwners: {}, cameras: {} }, opts: { failFirstMove?: boolean; onMove?: (from: string, to: string, store: PageStore) => void } = {}) {
	const { fake, texts, files, listed, cached } = vault;
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const moves: [string, string][] = [];
	const real = store.keepAsideUnder.bind(store);
	let failNext = opts.failFirstMove === true;
	store.keepAsideUnder = (async (from: string, to: string, own?: string, named?: () => boolean) => {
		moves.push([from, to]);
		opts.onMove?.(from, to, store);
		if (failNext) {
			failNext = false;
			throw new Error("the move threw");
		}
		return real(from, to, own, named);
	}) as PageStore["keepAsideUnder"];
	const plugin: any = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		pageIdWatchReady: true,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		declaimTimers: new Map<string, number>(),
		declaimedPaths: new Set<string>(),
		resolvingDuplicates: new Set<TFile>(),
		pendingRecycle: new Map(),
		settings,
		settingsDirty: false,
		settingsTimer: null,
		flushSettings: async () => undefined,
		persistOwners: () => {},
		store,
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
	return { ...vault, store, plugin, moves };
}

type Rig = ReturnType<typeof session>;

function rig(targetId: string, sourceId: string, ink: Record<string, string>, fake?: FakeAdapter): Rig {
	return session(vaultWith(targetId, sourceId, ink, fake));
}

async function pastEveryTimer(): Promise<void> {
	for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2000);
}

async function settled(r: Rig): Promise<void> {
	await pastEveryTimer();
	await r.store.flush();
}

/** Note composer's merge: the source's id over the target's, the source's text after the target's. */
function merge(r: Rig, sourceId: string): void {
	const body = r.texts.get(TARGET)!.split("\n---\n")[1];
	r.texts.set(TARGET, `---\nhandwriting-page-id: ${sourceId}\n---\n${body}\nSource body\n`);
}

/** The source goes to the trash: out of the listing and the cache, then the plugin's delete handler and the ink store's. */
async function trashSource(r: Rig): Promise<void> {
	r.listed.delete(SOURCE);
	r.cached.delete(SOURCE);
	const handled = r.plugin.onFileDeleted(r.files.get(SOURCE));
	inlineInk.handleDelete(SOURCE);
	await handled;
}

/** The id the target carries now. */
const endId = (r: Rig): string => frontmatterOf(r.texts.get(TARGET)!)!["handwriting-page-id"]!;

/** Merge, trash and identity checks in one of the two orders the app can hear them; the timers not run yet. */
async function mergeIn(r: Rig, order: Order, sourceId: string): Promise<void> {
	merge(r, sourceId);
	if (order === "target-heard-first") {
		r.plugin.checkPageIdentity(TARGET);
		// The duplicate's repair runs: a fresh id and a copy of the source's ink, written into the target's id line.
		await vi.advanceTimersByTimeAsync(50);
		r.plugin.checkPageIdentity(TARGET);
		await trashSource(r);
	} else {
		await trashSource(r);
		r.plugin.checkPageIdentity(TARGET);
	}
}

async function mergedAndSettled(r: Rig, order: Order, sourceId: string, ownId: string): Promise<string> {
	await mergeIn(r, order, sourceId);
	await settled(r);
	const end = endId(r);
	expect(end, "precondition: the target ends on another id than its own").not.toBe(ownId);
	if (order === "source-trashed-first") expect(end, "precondition: the target ends on the source's id").toBe(sourceId);
	else expect(end, "precondition: the target ends on a fresh id").not.toBe(sourceId);
	return end;
}

function idsIn(r: Rig, path: string, id: string): string[] | null {
	const t = r.fake.files.get(path);
	return t === undefined ? null : parsePage(t, id).data.strokes.map((s) => s.id);
}

/** Every file in the vault whose page holds stroke `strokeId`, by name. */
function holders(r: Rig, strokeId: string): string[] {
	return [...r.fake.files.entries()]
		.filter(([path, text]) => path.endsWith(".json") && parsePage(text, "any").data.strokes.some((s) => s.id === strokeId))
		.map(([path]) => path)
		.sort();
}

/** Every file in the ink folder named for `id`: its live file, a copy beside it, its Slides file and theirs. */
function namedFor(r: Rig, id: string): string[] {
	return [...r.fake.files.keys()].filter((k) => k.toLowerCase().startsWith(`.handwriting/${id}`.toLowerCase())).sort();
}

/** The PDF's file as the cell set it: the same bytes, and, read back, its strokes, its own id and its claim. */
function expectPdfWhole(r: Rig, before: string, strokes: string[] = ["p1"]): void {
	const text = r.fake.files.get(file(P));
	expect.soft(text, "the PDF's ink file is not under its own id as it was").toBe(before);
	if (text === undefined) return;
	const raw = JSON.parse(text) as { pageId?: string; pdfPaths?: string[] };
	expect.soft(parsePage(text, P).data.strokes.map((s) => s.id), "the PDF's file lost its strokes").toEqual(strokes);
	expect.soft(raw.pageId, "the PDF's file does not declare its own id").toBe(P);
	expect.soft(raw.pdfPaths, "the PDF's file lost its claim on the document").toEqual([PDF_PATH]);
}

/** keepAsideUnder calls naming the PDF's id on either side, or onto its Slides id, case-blind (off it, that file is a note's). */
function pdfMoves(r: Rig): [string, string][] {
	const [pdf, pdfSlides] = [P, slidesSidecarId(P)].map((id) => id.toLowerCase());
	return r.moves.filter(([from, to]) => from.toLowerCase() === pdf || to.toLowerCase() === pdf || to.toLowerCase() === pdfSlides);
}

/** What an older build kept in the settings for the launch: a move of the target's files from `held` to `id`, left part done. */
const keptFollow = (held: string, id: string): Record<string, unknown> => ({
	pageOwners: {},
	cameras: {},
	partDoneFollows: { [TARGET]: { held, id, rounds: 1, keptLive: false } },
});

const partDone = (r: Rig): Record<string, { held: string; id: string }> =>
	(r.plugin.settings.partDoneFollows ?? {}) as Record<string, { held: string; id: string }>;

/** The PDF's page, the source's inked page and its Slides page: the vault a merge into a PDF's id runs on. */
const pdfAndSource = (): Record<string, string> => ({
	[P]: pdfPage(P, ["p1"]),
	[PA]: inlinePage(PA, "s1"),
	[slidesSidecarId(PA)]: slidesPage(PA, "ss1"),
});

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	for (const p of [TARGET, SOURCE]) inlineInk.handleDelete(p);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("a closed note that names a PDF's id is merged into", () => {
	for (const order of ORDERS) {
		it(`${order}: the PDF's ink file stays under its id, whole, and the note lets the id go`, async () => {
			const r = rig(P, PA, pdfAndSource());
			const before = r.fake.files.get(file(P))!;
			expect(r.plugin.pageIds.owner(P), "precondition: the census made the note the PDF id's owner").toBe(TARGET);
			const end = await mergedAndSettled(r, order, PA, P);
			expectPdfWhole(r, before);
			expect.soft(holders(r, "p1"), "the PDF's strokes are in a file under or beside the note's id").toEqual([file(P)]);
			expect.soft(idsIn(r, file(end), end), "the page the note ends on is not the source's ink").toEqual(["s1"]);
			expect.soft(r.plugin.pageIds.owner(P), "the note did not let the PDF's id go").toBeUndefined();
			expect.soft(pdfMoves(r), "a move named the PDF's id").toEqual([]);
		});
	}

	it("the note names the PDF's id in capitals, on a disk blind to case: the PDF's file stays", async () => {
		const r = rig(P_CAPS, PA, pdfAndSource(), new CaseBlindAdapter());
		const before = r.fake.files.get(file(P))!;
		expect(r.plugin.pageIds.owner(P_CAPS), "precondition: the census made the note the capital id's owner").toBe(TARGET);
		expect(await r.fake.exists(file(P_CAPS)), "precondition: the disk finds the PDF's file by the capital name").toBe(true);
		await mergedAndSettled(r, "source-trashed-first", PA, P_CAPS);
		expectPdfWhole(r, before);
		expect.soft(holders(r, "p1"), "the PDF's strokes are in a file under or beside the note's id").toEqual([file(P)]);
		expect.soft(r.plugin.pageIds.owner(P_CAPS), "the note did not let the capital id go").toBeUndefined();
		expect.soft(pdfMoves(r), "a move named the PDF's id").toEqual([]);
	});
});

describe("a note open on a PDF's id, its id line edited", () => {
	for (const live of [true, false]) {
		it(`the edited id ${live ? "has" : "has no"} file: the PDF's ink file stays, and the note follows its new id`, async () => {
			const r = rig(P, PA, { [P]: pdfPage(P, ["p1"]), ...(live ? { [E]: inlinePage(E, "e1") } : {}) });
			const before = r.fake.files.get(file(P))!;
			const editedBefore = r.fake.files.get(file(E));
			await inlineInk.ensureLoaded(TARGET);
			expect(inlineInk.pageIdOf(TARGET), "precondition: the note's record is on the PDF's id").toBe(P);
			r.texts.set(TARGET, note(E, "Target body"));
			r.plugin.checkPageIdentity(TARGET);
			await settled(r);
			expectPdfWhole(r, before);
			expect.soft(holders(r, "p1"), "the PDF's strokes are in a file under or beside the note's id").toEqual([file(P)]);
			expect.soft(r.fake.files.get(file(E)), "the edited id's file changed").toBe(editedBefore);
			expect.soft(r.plugin.pageIds.owner(P), "the note did not let the PDF's id go").toBeUndefined();
			expect.soft(inlineInk.pageIdOf(TARGET), "the note's record did not follow its edited id").toBe(E);
			expect.soft(pdfMoves(r), "a move named the PDF's id").toEqual([]);
		});
	}

	it("a note open on its own id, its line edited onto the PDF's id: nothing of the note's goes under or beside it", async () => {
		const r = rig(PB, PA, { [P]: pdfPage(P, ["p1"]), [PB]: inlinePage(PB, "t1"), [slidesSidecarId(PB)]: slidesPage(PB, "ts1") });
		const before = new Map([P, PB, slidesSidecarId(PB)].map((id) => [id, r.fake.files.get(file(id))!]));
		await inlineInk.ensureLoaded(TARGET);
		expect(inlineInk.pageIdOf(TARGET), "precondition: the note's record is on its own id").toBe(PB);
		r.texts.set(TARGET, note(P, "Target body"));
		r.plugin.checkPageIdentity(TARGET);
		await settled(r);
		expectPdfWhole(r, before.get(P)!);
		expect.soft(r.fake.files.get(file(PB)), "the note's ink file left its own id, or changed").toBe(before.get(PB));
		expect.soft(r.fake.files.get(file(slidesSidecarId(PB))), "the note's Slides file left its own id, or changed").toBe(
			before.get(slidesSidecarId(PB))
		);
		expect.soft(holders(r, "t1"), "the note's strokes are in a file under or beside the PDF's id").toEqual([file(PB)]);
		expect.soft(holders(r, "ts1"), "the note's Slides strokes are in another file").toEqual([file(slidesSidecarId(PB))]);
		expect.soft(namedFor(r, P), "a file was set under or beside the PDF's id").toEqual([file(P)]);
		expect.soft(pdfMoves(r), "a move named the PDF's id").toEqual([]);
	});
});

describe("a closed note merged with a source that names a PDF's id", () => {
	for (const live of [true, false]) {
		it(`source-trashed-first, the PDF's id ${live ? "with" : "without"} a file: the note's files stay under its own id`, async () => {
			const r = rig(PB, P, {
				[PB]: inlinePage(PB, "t1"),
				[slidesSidecarId(PB)]: slidesPage(PB, "ts1"),
				...(live ? { [P]: pdfPage(P, ["p1"]) } : {}),
			});
			const before = new Map([PB, slidesSidecarId(PB), P].map((id) => [id, r.fake.files.get(file(id))]));
			await mergedAndSettled(r, "source-trashed-first", P, PB);
			expect.soft(r.fake.files.get(file(PB)), "the note's ink file left its own id, or changed").toBe(before.get(PB));
			expect.soft(r.fake.files.get(file(slidesSidecarId(PB))), "the note's Slides file left its own id, or changed").toBe(
				before.get(slidesSidecarId(PB))
			);
			expect.soft(holders(r, "t1"), "the note's strokes are in another file (set beside the PDF's id, or trashed)").toEqual([file(PB)]);
			expect.soft(holders(r, "ts1"), "the note's Slides strokes are in another file").toEqual([file(slidesSidecarId(PB))]);
			if (live) expectPdfWhole(r, before.get(P)!);
			expect.soft(namedFor(r, P), "a file was set under or beside the PDF's id").toEqual(live ? [file(P)] : []);
			expect.soft(r.plugin.pageIds.owner(PB), "the note did not let its old id go").toBeUndefined();
			expect.soft(pdfMoves(r), "a move named the PDF's id").toEqual([]);
		});
	}
});

describe("the launch finishes a move an older build kept part done (roads 1, 2 and the save after them)", () => {
	it("a kept move off the PDF's id: the launch drops it, and the PDF's file stays", async () => {
		const v = vaultWith(E, PA, { [P]: pdfPage(P, ["p1"]) });
		const before = v.fake.files.get(file(P))!;
		const r = session(v, keptFollow(P, E));
		await settled(r);
		expectPdfWhole(r, before);
		expect.soft(holders(r, "p1"), "the PDF's strokes are in a file under or beside the note's id").toEqual([file(P)]);
		expect.soft(namedFor(r, E), "a file was set under or beside the note's id").toEqual([]);
		expect.soft(partDone(r)[TARGET], "the kept move outlived the launch").toBeUndefined();
		expect.soft(pdfMoves(r), "a move named the PDF's id").toEqual([]);
	});

	it("a kept move onto the PDF's id: the launch drops it, and the note's files stay under its own id", async () => {
		const v = vaultWith(P, PA, { [P]: pdfPage(P, ["p1"]), [PB]: inlinePage(PB, "t1"), [slidesSidecarId(PB)]: slidesPage(PB, "ts1") });
		const before = new Map([P, PB, slidesSidecarId(PB)].map((id) => [id, v.fake.files.get(file(id))!]));
		const r = session(v, keptFollow(PB, P));
		await settled(r);
		expectPdfWhole(r, before.get(P)!);
		expect.soft(r.fake.files.get(file(PB)), "the note's ink file left its own id, or changed").toBe(before.get(PB));
		expect.soft(r.fake.files.get(file(slidesSidecarId(PB))), "the note's Slides file left its own id, or changed").toBe(
			before.get(slidesSidecarId(PB))
		);
		expect.soft(holders(r, "t1"), "the note's strokes are in a file under or beside the PDF's id").toEqual([file(PB)]);
		expect.soft(namedFor(r, P), "a file was set under or beside the PDF's id").toEqual([file(P)]);
		expect.soft(partDone(r)[TARGET], "the kept move outlived the launch").toBeUndefined();
		expect.soft(pdfMoves(r), "a move named the PDF's id").toEqual([]);
	});

	it("the launch's move throws: its fallback sets nothing of the PDF's beside the note's page", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const v = vaultWith(E, PA, { [P]: pdfPage(P, ["p1"]) });
		const before = v.fake.files.get(file(P))!;
		const r = session(v, keptFollow(P, E), { failFirstMove: true });
		await settled(r);
		expectPdfWhole(r, before);
		expect.soft(holders(r, "p1"), "the PDF's strokes are in a file under or beside the note's id").toEqual([file(P)]);
		expect.soft(namedFor(r, E), "a file was set under or beside the note's id").toEqual([]);
		expect.soft(pdfMoves(r), "a move named the PDF's id").toEqual([]);
	});

	it("a save under the PDF's id after the launch stays under it", async () => {
		const v = vaultWith(E, PA, { [P]: pdfPage(P, ["p1"]) });
		const r = session(v, keptFollow(P, E));
		await settled(r);
		// The PDF's pane saves the strokes it holds and one more, under its own id, as the PDF store saves.
		await r.store.load(P);
		await r.store.saveNow(P, pdfPageData(P, ["p1", "p2"]));
		await settled(r);
		expect.soft(idsIn(r, file(P), P), "the PDF's save is not under its id").toEqual(["p1", "p2"]);
		expect.soft(holders(r, "p2"), "the PDF's save is in a file under or beside the note's id").toEqual([file(P)]);
		expect.soft(namedFor(r, E), "a file was set under or beside the note's id").toEqual([]);
		expect.soft(pdfMoves(r), "a move named the PDF's id").toEqual([]);
	});
});

type DeleteOrder = "cache-empty" | "app-start";
const DELETE_ORDERS: DeleteOrder[] = ["cache-empty", "app-start"];

/**
 * `path` is deleted as Obsidian deletes it: out of the listing, the cache's entry gone before the plugin's handler (a
 * plugin turned on while Obsidian runs) or after it (app start), then the inline store's handler.
 */
async function deleteNote(r: Rig, path: string, order: DeleteOrder = "cache-empty"): Promise<void> {
	r.listed.delete(path);
	if (order === "cache-empty") r.cached.delete(path);
	const handled = r.plugin.onFileDeleted(r.files.get(path));
	if (order === "app-start") r.cached.delete(path);
	inlineInk.handleDelete(path);
	await handled;
}

/** Every file in the ink trash. */
const trashed = (r: Rig): string[] => [...r.fake.files.keys()].filter((k) => k.startsWith(".handwriting/trash/")).sort();

describe("a note that names a PDF's id is deleted, and the grace runs out", () => {
	for (const order of DELETE_ORDERS) {
		it(`${order}: the id in capitals on a disk blind to case: the PDF's file stays whole and nothing goes to the trash`, async () => {
			const r = rig(P_CAPS, PA, { [P]: pdfPage(P, ["p1"]), [PA]: inlinePage(PA, "s1") }, new CaseBlindAdapter());
			const before = r.fake.files.get(file(P))!;
			expect(r.plugin.pageIds.owner(P_CAPS), "precondition: the census made the note the capital id's owner").toBe(TARGET);
			expect(await r.fake.exists(file(P_CAPS)), "precondition: the disk finds the PDF's file by the capital name").toBe(true);
			await deleteNote(r, TARGET, order);
			await settled(r);
			expectPdfWhole(r, before);
			expect.soft(holders(r, "p1"), "the PDF's strokes are in another file (the trash)").toEqual([file(P)]);
			expect.soft(trashed(r), "a file went to the ink trash").toEqual([]);
			expect.soft(idsIn(r, file(PA), PA), "the other note's ink file changed").toEqual(["s1"]);
		});
	}

	it("the id in lower case on a disk blind to case: the PDF's file stays whole, as it did", async () => {
		const r = rig(P, PA, { [P]: pdfPage(P, ["p1"]), [PA]: inlinePage(PA, "s1") }, new CaseBlindAdapter());
		const before = r.fake.files.get(file(P))!;
		expect(r.plugin.pageIds.owner(P), "precondition: the census made the note the PDF id's owner").toBe(TARGET);
		await deleteNote(r, TARGET);
		await settled(r);
		expectPdfWhole(r, before);
		expect.soft(holders(r, "p1"), "the PDF's strokes are in another file (the trash)").toEqual([file(P)]);
		expect.soft(trashed(r), "a file went to the ink trash").toEqual([]);
	});

	it("an ordinary note on a disk blind to case: its ink goes to the trash, and the PDF's file stays", async () => {
		const r = rig(PB, PA, { [P]: pdfPage(P, ["p1"]), [PB]: inlinePage(PB, "t1") }, new CaseBlindAdapter());
		const before = r.fake.files.get(file(P))!;
		await deleteNote(r, TARGET);
		await settled(r);
		expect.soft(r.fake.files.has(file(PB)), "the deleted note's ink file is still live").toBe(false);
		const held = holders(r, "t1");
		expect.soft(held.length === 1 && held[0]!.startsWith(".handwriting/trash/"), `the note's ink is not in the trash once: [${held.join(", ")}]`).toBe(true);
		expectPdfWhole(r, before);
		expect.soft(holders(r, "p1"), "the PDF's strokes are in another file (the trash)").toEqual([file(P)]);
	});

	it("the named limit: on a disk that tells case apart, a note's own file under a capital PDF-shaped id stays", async () => {
		const r = rig(P_CAPS, PA, { [P_CAPS]: inlinePage(P_CAPS, "t1"), [PA]: inlinePage(PA, "s1") });
		const own = r.fake.files.get(file(P_CAPS))!;
		expect(r.plugin.pageIds.owner(P_CAPS), "precondition: the census made the note the capital id's owner").toBe(TARGET);
		await deleteNote(r, TARGET);
		await settled(r);
		expect.soft(r.fake.files.get(file(P_CAPS)), "the note's own file left its id").toBe(own);
		expect.soft(trashed(r), "a file went to the ink trash").toEqual([]);
	});
});

describe("a note on a PDF's id, locked, its copy deleted after the cache dropped it", () => {
	for (const [id, how] of [
		[P_CAPS, "in capitals"],
		[P, "in lower case"],
	] as const) {
		it(`a locked note on the PDF's id ${how}, its copy deleted: the note stays locked and the PDF's file stays`, async () => {
			// The copy carries no id at the census, so the delete cannot name one: the handler asks the locked notes left.
			const r = rig(id, "", { [P]: pdfPage(P, ["p1"]) }, new CaseBlindAdapter());
			const before = r.fake.files.get(file(P))!;
			expect(r.plugin.pageIds.owner(id), "precondition: the census made the note the id's owner").toBe(TARGET);
			// The copy's id line as the cache indexed it, and the owner locked beside it (DeleteWithCacheGone.test.ts's
			// "the note left is the registered owner and locked").
			r.texts.set(SOURCE, note(id, "Source body"));
			expect(r.plugin.recentPageIdFor(r.files.get(SOURCE)), "precondition: the copy carries the id").toBe(id);
			inlineInk.markDuplicateLocked(TARGET, SOURCE);
			expect(inlineInk.isDuplicateLocked(TARGET), "precondition: the note is locked").toBe(true);
			await deleteNote(r, SOURCE);
			await settled(r);
			expect.soft(inlineInk.isDuplicateLocked(TARGET), "the note on the PDF's id was unlocked by its copy's delete").toBe(true);
			expectPdfWhole(r, before);
			expect.soft(trashed(r), "a file went to the ink trash").toEqual([]);
		});
	}
});

/**
 * The note's deck page (stroke `strokeId`) followed the note onto `id`: in one file, `id`'s Slides file when `id` had
 * none (`theirs` undefined), else a copy beside that file (`<id's Slides name>.conflict-<mtime>.json`, which fix ink
 * de-sync lists) with that file as it was. Nothing is left under the PDF id's Slides name, asked case-blind.
 */
function expectDeckPageFollowed(r: Rig, id: string, strokeId: string, theirs?: string): void {
	const held = holders(r, strokeId);
	const live = file(slidesSidecarId(id));
	if (theirs === undefined) {
		expect.soft(held, "the note's deck page is not the edited id's Slides file").toEqual([live]);
	} else {
		const beside = `.handwriting/${slidesSidecarId(id)}.conflict-`;
		expect.soft(held.length === 1 && held[0]!.startsWith(beside), `the note's deck page is not one copy beside the edited id's Slides file: [${held.join(", ")}]`).toBe(true);
		expect.soft(r.fake.files.get(live), "the edited id's own Slides file changed").toBe(theirs);
	}
	expect.soft(namedFor(r, slidesSidecarId(P)), "a Slides file is left under the PDF's id, where nothing names it").toEqual([]);
}

/**
 * A NOTE'S OWN SLIDES PAGE UNDER A PDF'S ID FOLLOWS THE NOTE OFF IT.
 *
 * A note whose line names a PDF's id and draws in its presentation saves that deck page under the id's Slides name. No
 * PDF ever has a Slides file, so that file is always a note's own. When the note's id line then changes to another id
 * (a fix of a pasted id, a merge, a synced edit), the deck page goes with the note, as for any id: it becomes the new
 * id's Slides file, or a copy beside the one the new id already has, which fix ink de-sync lists. None of it is left
 * under the PDF's id, where nothing names it and the presentation opens without it. The PDF's own file still never
 * moves. Open note (its record on the PDF's id: the follow's road) and closed note (no record: the leave's road), each
 * past every timer.
 */
describe("a note on a PDF's id with its own Slides page, its id line edited off it", () => {
	for (const open of [true, false]) {
		for (const live of [false, true]) {
			it(`${open ? "open" : "closed"} note, the edited id ${live ? "has" : "has no"} Slides file: the note's deck page follows it, none left under the PDF's id`, async () => {
				const r = rig(P, PA, {
					[P]: pdfPage(P, ["p1"]),
					[slidesSidecarId(P)]: slidesPage(P, "ps1"),
					...(live ? { [slidesSidecarId(E)]: slidesPage(E, "es1") } : {}),
				});
				const before = r.fake.files.get(file(P))!;
				const theirs = r.fake.files.get(file(slidesSidecarId(E)));
				expect(r.plugin.pageIds.owner(P), "precondition: the census made the note the PDF id's owner").toBe(TARGET);
				if (open) {
					await inlineInk.ensureLoaded(TARGET);
					expect(inlineInk.pageIdOf(TARGET), "precondition: the note's record is on the PDF's id").toBe(P);
				} else {
					expect(inlineInk.pageIdOf(TARGET), "precondition: the note is closed, with no record").toBeNull();
				}
				r.texts.set(TARGET, note(E, "Target body"));
				r.plugin.checkPageIdentity(TARGET);
				await settled(r);
				expectDeckPageFollowed(r, E, "ps1", theirs);
				expectPdfWhole(r, before);
				expect.soft(holders(r, "p1"), "the PDF's strokes are in a file under or beside the note's id").toEqual([file(P)]);
				expect.soft(r.plugin.pageIds.owner(P), "the note did not let the PDF's id go").toBeUndefined();
				if (open) expect.soft(inlineInk.pageIdOf(TARGET), "the note's record did not follow its edited id").toBe(E);
			});
		}
	}

	it("open note naming the PDF's id in capitals, on a disk blind to case: the note's deck page follows it, none left under the PDF's id", async () => {
		const r = rig(P_CAPS, PA, { [P]: pdfPage(P, ["p1"]), [slidesSidecarId(P_CAPS)]: slidesPage(P_CAPS, "ps1") }, new CaseBlindAdapter());
		const before = r.fake.files.get(file(P))!;
		expect(r.plugin.pageIds.owner(P_CAPS), "precondition: the census made the note the capital id's owner").toBe(TARGET);
		await inlineInk.ensureLoaded(TARGET);
		expect(inlineInk.pageIdOf(TARGET), "precondition: the note's record is on the capital id").toBe(P_CAPS);
		r.texts.set(TARGET, note(E, "Target body"));
		r.plugin.checkPageIdentity(TARGET);
		await settled(r);
		expectDeckPageFollowed(r, E, "ps1");
		expectPdfWhole(r, before);
		expect.soft(holders(r, "p1"), "the PDF's strokes are in a file under or beside the note's id").toEqual([file(P)]);
		expect.soft(r.plugin.pageIds.owner(P_CAPS), "the note did not let the capital id go").toBeUndefined();
		expect.soft(inlineInk.pageIdOf(TARGET), "the note's record did not follow its edited id").toBe(E);
	});
});

/**
 * Onto another PDF's id (another `pdf-<hex>`, or another instance of the same PDF, `<id>-2`), nothing of the note's
 * moves, its Slides page too: that name is a PDF's, and the note's deck page under the first PDF's id stays where it is.
 */
describe("a note on a PDF's id with its own Slides page, its id line edited onto another PDF's id", () => {
	for (const [other, how] of [
		["pdf-77aa0b1c", "another PDF's id"],
		[`${P}-2`, "another instance of the same PDF"],
	] as const) {
		for (const open of [true, false]) {
			it(`${open ? "open" : "closed"} note, onto ${how}: nothing of the note's moves, its Slides page too`, async () => {
				const r = rig(P, PA, { [P]: pdfPage(P, ["p1"]), [slidesSidecarId(P)]: slidesPage(P, "ps1"), [other]: pdfPage(other, ["q1"]) });
				const before = r.fake.files.get(file(P))!;
				const theirs = r.fake.files.get(file(other))!;
				expect(r.plugin.pageIds.owner(P), "precondition: the census made the note the PDF id's owner").toBe(TARGET);
				if (open) {
					await inlineInk.ensureLoaded(TARGET);
					expect(inlineInk.pageIdOf(TARGET), "precondition: the note's record is on the PDF's id").toBe(P);
				} else {
					expect(inlineInk.pageIdOf(TARGET), "precondition: the note is closed, with no record").toBeNull();
				}
				r.texts.set(TARGET, note(other, "Target body"));
				r.plugin.checkPageIdentity(TARGET);
				await settled(r);
				expect.soft(holders(r, "ps1"), "the note's deck page left the first PDF's id").toEqual([file(slidesSidecarId(P))]);
				expect.soft(namedFor(r, slidesSidecarId(other)), "a file was set under or beside the other PDF id's Slides name").toEqual([]);
				expectPdfWhole(r, before);
				expect.soft(r.fake.files.get(file(other)), "the other PDF's ink file changed").toBe(theirs);
				expect.soft(r.plugin.pageIds.owner(P), "the note did not let the PDF's id go").toBeUndefined();
				if (open) expect.soft(inlineInk.pageIdOf(TARGET), "the note's record did not follow its edited id").toBe(other);
				const onto = r.moves.filter((pair) => pair.some((id) => id.toLowerCase().startsWith(other)));
				expect.soft(onto, "a move named the other PDF's id").toEqual([]);
				expect.soft(pdfMoves(r), "a move named the PDF's id").toEqual([]);
			});
		}
	}
});

/**
 * The PDF's pane saves under the PDF's id while the note's deck page moves off it. The move asks only about the file it
 * moves: a PDF save it does not take is no late save of the note's, and the move finishes. The PDF's save stays under
 * the PDF's id, with its strokes and its claim.
 */
describe("a PDF's pane saves under its id while a note's deck page moves off it", () => {
	for (const open of [true, false]) {
		it(`${open ? "open" : "closed"} note: the note follows its new id, and the PDF's save stays under its id`, async () => {
			const v = vaultWith(P, PA, { [P]: pdfPage(P, ["p1"]), [slidesSidecarId(P)]: slidesPage(P, "ps1") });
			const pdfSlides = slidesSidecarId(P).toLowerCase();
			const r = session(v, undefined, {
				onMove: (from, _to, store) => {
					if (from.toLowerCase() === pdfSlides) store.schedule(P, pdfPageData(P, ["p1", "p2"]));
				},
			});
			expect(r.plugin.pageIds.owner(P), "precondition: the census made the note the PDF id's owner").toBe(TARGET);
			if (open) {
				await inlineInk.ensureLoaded(TARGET);
				expect(inlineInk.pageIdOf(TARGET), "precondition: the note's record is on the PDF's id").toBe(P);
			}
			r.texts.set(TARGET, note(E, "Target body"));
			r.plugin.checkPageIdentity(TARGET);
			await settled(r);
			expectDeckPageFollowed(r, E, "ps1");
			expect.soft(r.plugin.pageIds.owner(P), "the note did not let the PDF's id go").toBeUndefined();
			if (open) expect.soft(inlineInk.pageIdOf(TARGET), "the note's record did not follow its edited id").toBe(E);
			expect.soft(partDone(r)[TARGET], "the move is still kept part done").toBeUndefined();
			const text = r.fake.files.get(file(P));
			expect.soft(text === undefined ? null : idsIn(r, file(P), P), "the PDF's save is not under its id").toEqual(["p1", "p2"]);
			const raw = JSON.parse(text ?? "{}") as { pageId?: string; pdfPaths?: string[] };
			expect.soft(raw.pageId, "the PDF's file does not declare its own id").toBe(P);
			expect.soft(raw.pdfPaths, "the PDF's file lost its claim on the document").toEqual([PDF_PATH]);
			expect.soft(holders(r, "p2"), "the PDF's save is in a file under or beside the note's id").toEqual([file(P)]);
		});
	}
});

/**
 * A quit in the middle of the note's Slides move off a PDF's id: the launch finishes it, as the timer rounds run it. The
 * PDF's own file is in no step, so a launch's move or its fallback after a throw never takes it.
 */
describe("the launch finishes a note's Slides move off a PDF's id left part done", () => {
	it("the note's deck page goes to the new id's Slides file, and the PDF's file stays", async () => {
		const v = vaultWith(E, PA, { [P]: pdfPage(P, ["p1"]), [slidesSidecarId(P)]: slidesPage(P, "ps1") });
		const before = v.fake.files.get(file(P))!;
		const r = session(v, keptFollow(P, E));
		await settled(r);
		expectDeckPageFollowed(r, E, "ps1");
		expectPdfWhole(r, before);
		expect.soft(holders(r, "p1"), "the PDF's strokes are in a file under or beside the note's id").toEqual([file(P)]);
		expect.soft(partDone(r)[TARGET], "the kept move outlived the launch").toBeUndefined();
		expect.soft(pdfMoves(r), "a move named the PDF's id").toEqual([]);
	});

	it("the launch's move throws: its fallback sets the note's deck page by the new id's page, and the PDF's file stays", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const v = vaultWith(E, PA, { [P]: pdfPage(P, ["p1"]), [slidesSidecarId(P)]: slidesPage(P, "ps1") });
		const before = v.fake.files.get(file(P))!;
		const r = session(v, keptFollow(P, E), { failFirstMove: true });
		await settled(r);
		expectDeckPageFollowed(r, E, "ps1");
		expectPdfWhole(r, before);
		expect.soft(holders(r, "p1"), "the PDF's strokes are in a file under or beside the note's id").toEqual([file(P)]);
		expect.soft(partDone(r)[TARGET], "the kept move outlived the launch").toBeUndefined();
		expect.soft(pdfMoves(r), "a move named the PDF's id").toEqual([]);
	});
});

/** Each kept-moves value the settings held when the plugin asked to save them (persistOwners), from now on. */
function keptSnapshots(r: Rig): { held: string; id: string }[] {
	const seen: { held: string; id: string }[] = [];
	r.plugin.persistOwners = () => {
		for (const e of Object.values(partDone(r))) seen.push({ held: e.held, id: e.id });
	};
	return seen;
}

/** No kept move names a PDF-shaped id (PdfIdentity's form), in any case: a build that reads it with no PDF test would move the PDF's file. */
function expectNoPdfIdKept(entries: { held: string; id: string }[]): void {
	const pdfShaped = entries.flatMap((e) => [e.held, e.id]).filter((id) => /^pdf-[0-9a-f]+(?:-\d+)?$/.test(id.toLowerCase()));
	expect.soft(pdfShaped, "a kept move names a PDF's id, which an older build moves at launch").toEqual([]);
}

/** The note's deck page, as its open deck schedules it again under `id`'s Slides name. */
const deckSave = (id: string): PageData => parsePage(slidesPage(id, "ps1"), slidesSidecarId(id)).data;

/**
 * A MOVE OFF A PDF'S ID LEFT PART DONE IS KEPT UNDER THE TWO SLIDES IDS.
 *
 * The settings keep a part-done move for the next launch. An older build reads any two ids there as a whole move, with
 * no PDF test, so a kept move naming the PDF's id would take the PDF's file at its launch (a rollback, or a second
 * device on that build reading the synced settings). Off a PDF's id the kept move names the two Slides ids instead: an
 * older build finds no note for a Slides id and drops it, touching no file, and this build reads it back as the Slides
 * move. A raw pair an older build kept is kept from the launch on under the Slides ids too. Each road that keeps one.
 */
describe("a move off a PDF's id left part done is kept under the two Slides ids", () => {
	it("open note, its round asks to try again: the kept move names the Slides ids, and the next round finishes", async () => {
		const v = vaultWith(P, PA, { [P]: pdfPage(P, ["p1"]), [slidesSidecarId(P)]: slidesPage(P, "ps1") });
		const before = v.fake.files.get(file(P))!;
		let once = true;
		// The open deck saves under the old Slides id while its file moves: the round asks to try again.
		const r = session(v, undefined, {
			onMove: (from, _to, store) => {
				if (once && from.toLowerCase() === slidesSidecarId(P)) {
					once = false;
					store.schedule(slidesSidecarId(P), deckSave(P));
				}
			},
		});
		const seen = keptSnapshots(r);
		await inlineInk.ensureLoaded(TARGET);
		expect(inlineInk.pageIdOf(TARGET), "precondition: the note's record is on the PDF's id").toBe(P);
		r.texts.set(TARGET, note(E, "Target body"));
		r.plugin.checkPageIdentity(TARGET);
		await settled(r);
		expect(seen.length, "precondition: a round was kept part done for the launch").toBeGreaterThan(0);
		expectNoPdfIdKept(seen);
		expect.soft(seen[0], "the kept move does not name the two Slides ids").toEqual({ held: slidesSidecarId(P), id: slidesSidecarId(E) });
		expectDeckPageFollowed(r, E, "ps1");
		expectPdfWhole(r, before);
		expect.soft(partDone(r)[TARGET], "the kept move outlived the finished move").toBeUndefined();
		expect.soft(inlineInk.pageIdOf(TARGET), "the note's record did not follow its edited id").toBe(E);
	});

	for (const [id, how, disk] of [
		[P, "in lower case", (): FakeAdapter => new FakeAdapter()],
		[P_CAPS, "in capitals, on a disk blind to case", (): FakeAdapter => new CaseBlindAdapter()],
	] as const) {
		it(`closed note on the PDF's id ${how}, its move throws: the kept move names the Slides ids, and the next round finishes`, async () => {
			vi.spyOn(console, "error").mockImplementation(() => undefined);
			const v = vaultWith(id, PA, { [P]: pdfPage(P, ["p1"]), [slidesSidecarId(id)]: slidesPage(id, "ps1") }, disk());
			const before = v.fake.files.get(file(P))!;
			const r = session(v, undefined, { failFirstMove: true });
			const seen = keptSnapshots(r);
			r.texts.set(TARGET, note(E, "Target body"));
			r.plugin.checkPageIdentity(TARGET);
			await settled(r);
			expect(seen.length, "precondition: a round was kept part done for the launch").toBeGreaterThan(0);
			expectNoPdfIdKept(seen);
			expect.soft(seen[0], "the kept move does not name the two Slides ids").toEqual({ held: slidesSidecarId(id), id: slidesSidecarId(E) });
			expectDeckPageFollowed(r, E, "ps1");
			expectPdfWhole(r, before);
			expect.soft(partDone(r)[TARGET], "the kept move outlived the finished move").toBeUndefined();
		});
	}

	it("the launch reads an older build's kept move off the PDF's id and its round asks to try again: it stays kept under the Slides ids", async () => {
		const v = vaultWith(E, PA, { [P]: pdfPage(P, ["p1"]), [slidesSidecarId(P)]: slidesPage(P, "ps1") });
		const before = v.fake.files.get(file(P))!;
		const r = session(v, keptFollow(P, E), {
			onMove: (from, _to, store) => {
				if (from.toLowerCase() === slidesSidecarId(P)) store.schedule(slidesSidecarId(P), deckSave(P));
			},
		});
		await settled(r);
		const kept = partDone(r)[TARGET];
		expect(kept, "precondition: the launch's round asked to try again, and the move waits for the next launch").toBeDefined();
		expectNoPdfIdKept([kept!]);
		expect.soft({ held: kept!.held, id: kept!.id }, "the kept move does not name the two Slides ids").toEqual({ held: slidesSidecarId(P), id: slidesSidecarId(E) });
		expectPdfWhole(r, before);
		expect.soft(pdfMoves(r), "a move named the PDF's id").toEqual([]);
	});

	it("the launch reads its own kept move, the two Slides ids: it finishes the Slides move, and the PDF's file stays", async () => {
		const v = vaultWith(E, PA, { [P]: pdfPage(P, ["p1"]), [slidesSidecarId(P)]: slidesPage(P, "ps1") });
		const before = v.fake.files.get(file(P))!;
		const r = session(v, keptFollow(slidesSidecarId(P), slidesSidecarId(E)));
		await settled(r);
		expectDeckPageFollowed(r, E, "ps1");
		expectPdfWhole(r, before);
		expect.soft(holders(r, "p1"), "the PDF's strokes are in a file under or beside the note's id").toEqual([file(P)]);
		expect.soft(partDone(r)[TARGET], "the kept move outlived the launch").toBeUndefined();
		expect.soft(pdfMoves(r), "a move named the PDF's id").toEqual([]);
	});
});
