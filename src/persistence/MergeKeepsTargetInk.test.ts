/**
 * A NOTE MERGED INTO ANOTHER LEAVES THE TARGET'S OWN INK NAMED BY NOTHING.
 *
 * Note composer's merge writes the source note's page id over the target's, appends the source's text, and trashes
 * the source. The target was not open. Five seconds later the target lets its own id go with no move: its ink file
 * and its Slides file stay under that id, named by no note and listed by nothing. Two orders reach it: the target's
 * change heard while the source is still there (the duplicate is given a fresh id with a copy of the source's ink),
 * or the source trashed first (the target ends on the source's id).
 *
 * The correct behaviour: before the target lets its old id go, its files are set beside the id it ends on, the way a
 * note open here follows an id edited on another device. With a live file there, the target's file is a copy listed
 * by fix ink de-sync against that page; with none, the target's file becomes that id's live file and the note opens
 * on its own ink.
 *
 * Real PageStore over FakeAdapter, real identity code (census, identity check, the grace timer, the follow), the real
 * delete handler for the trash, the real fork scan. The target is never loaded unless a cell says so.
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
import { forkHostFor, listForks, refreshForks, resetForks } from "./ForkResolution";
import { slidesSidecarId } from "../slides/SlidesSections";
import type { InkStroke } from "../ink/Stroke";

const TARGET = "Target.md";
const SOURCE = "Source.md";
const COPY = "Copy of target.md";
const PB = "page-of-target";
const PA = "page-of-source";

type Source = "inked" | "slides-only" | "none";
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

const file = (id: string): string => `.handwriting/${id}.json`;

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

/** The fake adapter seen through a folder listing, as the fork scan needs. */
function listing(fake: FakeAdapter): FakeAdapter {
	return Object.assign(Object.create(fake) as FakeAdapter, {
		async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
			const prefix = dir.endsWith("/") ? dir : dir + "/";
			return { files: [...fake.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")), folders: [] };
		},
	});
}

type Vault = {
	fake: FakeAdapter;
	texts: Map<string, string>;
	files: Map<string, TFile>;
	listed: Set<string>;
	cached: Set<string>;
};

function vaultWith(source: Source, targetFiles: boolean): Vault {
	const fake = new FakeAdapter();
	if (targetFiles) {
		fake.files.set(file(PB), inlinePage(PB, "t1"));
		fake.files.set(file(slidesSidecarId(PB)), slidesPage(PB, "ts1"));
	}
	if (source === "inked") fake.files.set(file(PA), inlinePage(PA, "s1"));
	if (source !== "none") fake.files.set(file(slidesSidecarId(PA)), slidesPage(PA, "ss1"));
	const texts = new Map<string, string>([
		[TARGET, `---\nhandwriting-page-id: ${PB}\n---\nTarget body\n`],
		[SOURCE, `---\nhandwriting-page-id: ${PA}\n---\nSource body\n`],
	]);
	const files = new Map<string, TFile>();
	for (const path of texts.keys()) files.set(path, Object.assign(new TFile(), { path, extension: "md", basename: path.slice(0, -3) }));
	return { fake, texts, files, listed: new Set(texts.keys()), cached: new Set(texts.keys()) };
}

/** One app session over `vault`; `settings` carries what the last session kept (a launch). */
function session(vault: Vault, settings: Record<string, unknown> = { pageOwners: {}, cameras: {} }) {
	const { fake, texts, files, listed, cached } = vault;
	const store = new PageStore({ vault: { adapter: fake } } as never);
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
	return { ...vault, store, plugin };
}

type Rig = ReturnType<typeof session>;

function rig(source: Source = "inked", targetFiles = true): Rig {
	return session(vaultWith(source, targetFiles));
}

async function pastEveryTimer(): Promise<void> {
	for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2000);
}

/** Note composer's merge: the source's id over the target's, the source's text after the target's. */
function merge(r: Rig): void {
	const body = r.texts.get(TARGET)!.split("\n---\n")[1];
	r.texts.set(TARGET, `---\nhandwriting-page-id: ${PA}\n---\n${body}\nSource body\n`);
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
async function mergeIn(r: Rig, order: Order): Promise<void> {
	merge(r);
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

async function mergedAndSettled(r: Rig, order: Order): Promise<string> {
	await mergeIn(r, order);
	await pastEveryTimer();
	await r.store.flush();
	const end = endId(r);
	expect(end, "precondition: the target ends on another id than its own").not.toBe(PB);
	if (order === "source-trashed-first") expect(end, "precondition: the target ends on the source's id").toBe(PA);
	else expect(end, "precondition: the target ends on a fresh id").not.toBe(PA);
	return end;
}

function idsIn(r: Rig, path: string, id: string): string[] | null {
	const t = r.fake.files.get(path);
	return t === undefined ? null : parsePage(t, id).data.strokes.map((s) => s.id);
}

/** Stroke ids of each kept copy beside `id`'s live file, by file name. */
function copiesBeside(r: Rig, id: string): string[][] {
	const prefix = `.handwriting/${id}.conflict-`;
	return [...r.fake.files.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => idsIn(r, k, id) ?? []);
}

/** What fix ink de-sync lists against `id`: the stroke ids of each listed copy. */
async function listedAgainst(r: Rig, id: string): Promise<string[][]> {
	const host = forkHostFor({ adapter: listing(r.fake), store: r.store } as never);
	resetForks();
	await refreshForks(host, ".handwriting");
	return listForks()
		.filter((f) => f.pageId === id)
		.map((f) => idsIn(r, f.incomingPath, id) ?? []);
}

function declaredId(r: Rig, id: string): string | null {
	const t = r.fake.files.get(file(id));
	return t === undefined ? null : ((JSON.parse(t) as { pageId?: string }).pageId ?? null);
}

const partDone = (r: Rig): Record<string, { held: string; id: string }> =>
	(r.plugin.settings.partDoneFollows ?? {}) as Record<string, { held: string; id: string }>;

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	for (const p of [TARGET, SOURCE, COPY]) inlineInk.handleDelete(p);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	resetForks();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("a note merged into another, the target not open", () => {
	for (const order of ORDERS) {
		it(`${order}: the target's own ink is listed against the page it ends on, and the source's ink stays that page`, async () => {
			const r = rig();
			const end = await mergedAndSettled(r, order);
			expect.soft(r.fake.files.has(file(PB)), "the target's ink file stayed under an id no note names").toBe(false);
			expect.soft(await listedAgainst(r, end), "the target's own ink is in no listed copy").toContainEqual(["t1"]);
			expect.soft(idsIn(r, file(end), end), "the page the target ends on is not the source's ink").toEqual(["s1"]);
			await inlineInk.ensureLoaded(TARGET);
			expect.soft(
				inlineInk.strokes(TARGET).map((s) => s.id),
				"the merged note does not show what it showed before the fix"
			).toEqual(["s1"]);
		});

		it(`${order}: the target's Slides ink is set beside the Slides page it ends on, and listed there`, async () => {
			const r = rig();
			const end = await mergedAndSettled(r, order);
			const slidesEnd = slidesSidecarId(end);
			expect.soft(r.fake.files.has(file(slidesSidecarId(PB))), "the target's Slides file stayed under an id no note names").toBe(
				false
			);
			expect.soft(copiesBeside(r, slidesEnd), "no copy of the target's Slides ink sits beside the Slides page").toEqual([["ts1"]]);
			expect.soft(idsIn(r, file(slidesEnd), slidesEnd), "the Slides page it ends on is not the source's").toEqual(["ss1"]);
			expect.soft(await listedAgainst(r, slidesEnd), "the copy of the target's Slides ink is not listed").toContainEqual(["ts1"]);
		});
	}
});

describe("a move of the target's file that fails", () => {
	it("keeps the old id and a part-done entry, and the next round moves the file", async () => {
		const r = rig();
		r.fake.failRenameTimes = 1;
		r.fake.failRenameWhen = (from) => from === file(PB);
		await mergeIn(r, "source-trashed-first");
		await vi.advanceTimersByTimeAsync(5100);
		expect.soft(r.fake.failRenameTimes, "no move of the target's file was tried").toBe(0);
		expect.soft(r.plugin.pageIds.owner(PB), "the old id was let go with its file not moved").toBe(TARGET);
		expect.soft(r.fake.files.has(file(PB)), "the file was lost").toBe(true);
		expect.soft(partDone(r)[TARGET], "no part-done entry was kept for the next round or launch").toMatchObject({ held: PB, id: PA });

		await pastEveryTimer();
		await r.store.flush();
		expect.soft(r.fake.files.has(file(PB)), "the next round did not move the file").toBe(false);
		expect.soft(copiesBeside(r, PA), "the target's ink is not beside the page it ends on").toEqual([["t1"]]);
		expect.soft(r.plugin.pageIds.owner(PB), "the old id was kept after the move").toBeUndefined();
		expect.soft(partDone(r)[TARGET], "the part-done entry outlived the move").toBeUndefined();
	});

	it("every round fails: the next launch finishes the move from the kept entry", async () => {
		const r = rig();
		r.fake.failRenameTimes = 99;
		r.fake.failRenameWhen = (from) => from === file(PB);
		await mergeIn(r, "source-trashed-first");
		await pastEveryTimer();
		await pastEveryTimer();
		expect.soft(r.fake.files.has(file(PB)), "the file was lost").toBe(true);
		const kept = JSON.parse(JSON.stringify({ ...r.plugin.settings, pageOwners: r.plugin.pageIds.snapshot() })) as Record<string, unknown>;
		expect.soft((kept.partDoneFollows ?? {}) as Record<string, unknown>, "the settings kept nothing for the next launch").toHaveProperty(
			[TARGET],
			expect.objectContaining({ held: PB, id: PA })
		);

		// Quit, then launch: a new session over the same vault and the kept settings, rename working again.
		for (const p of [TARGET, SOURCE]) inlineInk.handleDelete(p);
		r.fake.failRenameTimes = 0;
		const next = session(r, kept);
		await pastEveryTimer();
		await next.store.flush();
		expect.soft(next.fake.files.has(file(PB)), "the launch did not move the file").toBe(false);
		expect.soft(copiesBeside(next, PA), "the target's ink is not beside the page it ends on").toEqual([["t1"]]);
		expect.soft(partDone(next)[TARGET], "the entry outlived the launch's move").toBeUndefined();
		expect.soft(next.plugin.pageIds.owner(PB), "the old id is still owned after the launch").toBeUndefined();
	});
});

describe("what stays as it is", () => {
	it("another note still carries the target's old id: the file stays under it, that note's", async () => {
		const r = rig();
		// A copy of the target, synced in before the merge and not heard yet.
		r.texts.set(COPY, `---\nhandwriting-page-id: ${PB}\n---\nTarget body\n`);
		r.files.set(COPY, Object.assign(new TFile(), { path: COPY, extension: "md", basename: COPY.slice(0, -3) }));
		r.listed.add(COPY);
		r.cached.add(COPY);
		await mergedAndSettled(r, "source-trashed-first");
		expect.soft(idsIn(r, file(PB), PB), "the copy's ink file was moved away from it").toEqual(["t1"]);
		expect.soft(idsIn(r, file(slidesSidecarId(PB)), slidesSidecarId(PB)), "the copy's Slides file was moved away from it").toEqual([
			"ts1",
		]);
		expect.soft(copiesBeside(r, PA), "the copy's ink was set beside the target's page").toEqual([]);
		expect.soft(r.plugin.pageIds.owner(PB), "the note left on the old id does not own it").toBe(COPY);
	});

	it("the target has no ink file of its own: nothing is written or moved, and the old id is let go", async () => {
		const r = rig("inked", false);
		const before = [...r.fake.files.entries()].sort();
		await mergedAndSettled(r, "source-trashed-first");
		expect.soft([...r.fake.files.entries()].sort(), "a file was written, moved or removed").toEqual(before);
		expect.soft(r.plugin.pageIds.owner(PB), "the old id was kept").toBeUndefined();
		expect.soft(partDone(r)[TARGET], "a part-done entry was left").toBeUndefined();
	});

	it("the target is left duplicate-locked on the source's id: its old id and files stay, and no timer waits", async () => {
		const r = rig();
		vi.spyOn(r.store, "clone").mockRejectedValueOnce(new Error("the clone failed"));
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		merge(r);
		r.plugin.checkPageIdentity(TARGET);
		await vi.advanceTimersByTimeAsync(50);
		expect(inlineInk.isDuplicateLocked(TARGET), "precondition: the repair failed closed").toBe(true);
		const before = new Map([PB, slidesSidecarId(PB)].map((id) => [id, r.fake.files.get(file(id))]));
		await pastEveryTimer();
		await r.store.flush();
		expect.soft(r.plugin.pageIds.owner(PB), "the locked target let its old id go").toBe(TARGET);
		for (const [id, text] of before) expect.soft(r.fake.files.get(file(id)), `the file under ${id} was moved or changed`).toBe(text);
		expect.soft(partDone(r)[TARGET], "a part-done entry was left").toBeUndefined();
		expect.soft(r.plugin.declaimTimers.has(TARGET), "a timer still waits on the locked target").toBe(false);
	});

	it("the grace runs out before the duplicate's repair: nothing moves then, and the repair's id takes the move", async () => {
		const r = rig();
		const real = r.store.clone.bind(r.store);
		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		vi.spyOn(r.store, "clone").mockImplementationOnce(async (from: string, to: string) => {
			await gate;
			return real(from, to);
		});
		merge(r);
		r.plugin.checkPageIdentity(TARGET);
		await pastEveryTimer();
		expect(endId(r), "precondition: the target still carries the source's id").toBe(PA);
		expect.soft(r.plugin.pageIds.owner(PB), "the old id was let go while the target carries an id it does not own").toBe(TARGET);
		expect.soft(idsIn(r, file(PB), PB), "the file moved while the target carries an id it does not own").toEqual(["t1"]);

		open();
		await vi.advanceTimersByTimeAsync(50);
		r.plugin.checkPageIdentity(TARGET);
		await trashSource(r);
		await pastEveryTimer();
		await r.store.flush();
		const end = endId(r);
		expect(end, "precondition: the repair gave the target a fresh id").not.toBe(PA);
		expect.soft(r.fake.files.has(file(PB)), "the file stayed under an id no note names").toBe(false);
		expect.soft(copiesBeside(r, end), "the target's ink is not beside the page it ends on").toEqual([["t1"]]);
		expect.soft(r.plugin.pageIds.owner(PB), "the old id was kept after the move").toBeUndefined();
	});
});

describe("the source has an id and no inline file of its own", () => {
	for (const source of ["slides-only", "none"] as const) {
		for (const order of ORDERS) {
			it(`${source} source, ${order}: the target's file becomes the page it ends on, and the note shows its own ink`, async () => {
				const r = rig(source);
				const end = await mergedAndSettled(r, order);
				expect.soft(r.fake.files.has(file(PB)), "the target's ink file stayed under an id no note names").toBe(false);
				expect.soft(idsIn(r, file(end), end), "the page the target ends on is not the target's ink").toEqual(["t1"]);
				expect.soft(declaredId(r, end), "the moved page does not declare the id it is under").toBe(end);
				await inlineInk.ensureLoaded(TARGET);
				expect.soft(inlineInk.strokes(TARGET).map((s) => s.id), "the merged note does not show its own ink").toEqual(["t1"]);
				const slidesEnd = slidesSidecarId(end);
				expect.soft(r.fake.files.has(file(slidesSidecarId(PB))), "the target's Slides file stayed under an id no note names").toBe(
					false
				);
				if (source === "slides-only") {
					expect.soft(idsIn(r, file(slidesEnd), slidesEnd), "the source's Slides ink is not the live Slides page").toEqual(["ss1"]);
					expect.soft(copiesBeside(r, slidesEnd), "the target's Slides ink is not beside the Slides page").toEqual([["ts1"]]);
				} else {
					expect.soft(idsIn(r, file(slidesEnd), slidesEnd), "the target's Slides ink is not the Slides page it ends on").toEqual([
						"ts1",
					]);
				}
			});
		}
	}

	it("the target opened inside the grace, blank: once its file moves the note shows its own ink, and its next save keeps one file", async () => {
		const r = rig("slides-only");
		await mergeIn(r, "source-trashed-first");
		await vi.advanceTimersByTimeAsync(1000);
		await inlineInk.ensureLoaded(TARGET);
		expect(inlineInk.pageIdOf(TARGET), "precondition: the note opened on the id it ends on").toBe(PA);
		expect(inlineInk.strokes(TARGET), "precondition: the page it ends on has no ink yet").toEqual([]);
		await pastEveryTimer();
		await r.store.flush();
		expect.soft(inlineInk.strokes(TARGET).map((s) => s.id), "the open note still shows a blank page").toEqual(["t1"]);
		inlineInk.commit(TARGET, stroke("after", 120));
		await pastEveryTimer();
		await r.store.flush();
		expect.soft(copiesBeside(r, PA), "the note's next save set its own ink aside").toEqual([]);
		expect.soft(idsIn(r, file(PA), PA), "the page does not hold the note's ink and the new stroke").toEqual(["t1", "after"]);
	});
});
