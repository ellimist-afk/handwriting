/**
 * A PAGE ID CHANGED ON THE OTHER DEVICE IS FOLLOWED BY THE NOTE OPEN HERE.
 *
 * Two devices can each claim an id for the same note before sync settles, and
 * the note then arrives here carrying the other device's id. The open note
 * kept writing under the id it had: this device's next stroke went to a file
 * the note no longer names, the poll watched that file, and after a restart
 * the note read the new id and the ink drawn here sat where nothing names it.
 * Only a duplicate-locked copy followed an edited id.
 *
 * The correct behaviour: once the edited id has settled, the note follows it,
 * so the next stroke is saved to the file the note names, and the file under
 * the old id, which holds this device's ink, is listed by fix ink de-sync as a
 * fork against the new page.
 *
 * Assertions state the CORRECT behaviour: green = no bug, red = bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import { applyForkDecision, forkHostFor, listForks, refreshForks, resetForks } from "../persistence/ForkResolution";
import type { InkStroke } from "../ink/Stroke";

const NOTE = "Shared note.md";
const OLD = "id-claimed-here";
const NEW = "id-claimed-there";

function stroke(id: string, x = 10): InkStroke {
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
	} as InkStroke;
}

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

function rig() {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const mine = emptyPage(OLD);
	mine.surface = "inline";
	mine.strokes = [stroke("drawn-here", 5)];
	fake.files.set(`.handwriting/${OLD}.json`, serializePage(mine));
	const texts = new Map<string, string>([[NOTE, `---\nhandwriting-page-id: ${OLD}\n---\nBody\n`]]);
	const files = new Map([[NOTE, { path: NOTE, extension: "md", basename: NOTE.slice(0, -3) }]]);
	const notices: string[] = [];
	const plugin: any = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		pageIdWatchReady: true,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		declaimTimers: new Map<string, number>(),
		declaimedPaths: new Set<string>(),
		resolvingDuplicates: new Set<string>(),
		settings: { pageOwners: {}, cameras: {} },
		persistOwners: () => {},
		store,
		app: {
			vault: {
				adapter: fake,
				getFileByPath: (p: string) => files.get(p) ?? null,
				getAbstractFileByPath: (p: string) => files.get(p) ?? null,
				getMarkdownFiles: () => [...files.values()],
				process: async (f: { path: string }, fn: (data: string) => string) => {
					await Promise.resolve();
					const after = fn(texts.get(f.path)!);
					texts.set(f.path, after);
					return after;
				},
			},
			metadataCache: {
				getCache: (p: string) => (texts.has(p) ? cacheOf(texts.get(p)!) : null),
				getFileCache: (f: { path: string }) => (texts.has(f.path) ? cacheOf(texts.get(f.path)!) : null),
			},
		},
	});
	const host: InlineInkHost = {
		readPageId: (path) => plugin.notePageId(path),
		claimId: (path, proposedId) => plugin.claimNotePageId(path, proposedId),
		loadSidecar: (pageId) => store.load(pageId),
		scheduleSidecar: (pageId, page) => store.schedule(pageId, page),
		scheduleSidecarNow: (pageId, page) => store.saveNow(pageId, page),
		notify: (m) => void notices.push(m),
	};
	inlineInk.attachHost(host);
	const onDisk = (id: string): string[] | null => {
		const t = fake.files.get(`.handwriting/${id}.json`);
		return t === undefined ? null : parsePage(t, id).data.strokes.map((s) => s.id);
	};
	return { plugin, texts, notices, onDisk, store, fake };
}

async function pastEveryTimer(): Promise<void> {
	for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2000);
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	inlineInk.handleDelete(NOTE);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	resetForks();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** The note open here under OLD; the other device's id and ink file arrive by sync. */
async function idChangedThere() {
	const r = rig();
	await inlineInk.ensureLoaded(NOTE);
	r.plugin.buildPageIdIndex();
	expect(inlineInk.pageIdOf(NOTE), "precondition: the note is open under the id claimed here").toBe(OLD);
	expect(inlineInk.strokes(NOTE).map((s) => s.id)).toEqual(["drawn-here"]);
	const theirs = emptyPage(NEW);
	theirs.surface = "inline";
	theirs.strokes = [stroke("drawn-there", 60)];
	r.fake.externalWrite(`.handwriting/${NEW}.json`, serializePage(theirs));
	r.texts.set(NOTE, `---\nhandwriting-page-id: ${NEW}\n---\nBody\n`);
	r.plugin.checkPageIdentity(NOTE);
	await pastEveryTimer();
	return r;
}

describe("a page id changed on the other device", () => {
	it("is followed: the next stroke drawn here is saved to the file the note names", async () => {
		const r = await idChangedThere();
		inlineInk.commit(NOTE, stroke("after-the-change", 120));
		await pastEveryTimer();
		await r.store.flush();
		expect(inlineInk.pageIdOf(NOTE), "the open note still writes under the id it had").toBe(NEW);
		expect(r.onDisk(NEW) ?? [], "the stroke drawn after the change went to a file the note does not name").toContain(
			"after-the-change"
		);
		expect(r.onDisk(NEW) ?? [], "the other device's ink was written over").toContain("drawn-there");
	});

	it("the ink drawn here under the old id is listed by fix ink de-sync as a fork against the new page", async () => {
		const r = await idChangedThere();
		await r.store.flush();
		const host = forkHostFor({ adapter: listing(r.fake), store: r.store } as never);
		resetForks();
		await refreshForks(host, ".handwriting");
		const rec = listForks().find((f) => f.pageId === NEW);
		expect(rec, "this device's ink sits in a file nothing lists").toBeDefined();
		expect(parsePage(r.fake.files.get(rec!.incomingPath)!, NEW).data.strokes.map((s) => s.id)).toEqual(["drawn-here"]);
	});

	it("taking that ink from the list writes it as the new page, under the id the note names", async () => {
		const r = await idChangedThere();
		await r.store.flush();
		const host = forkHostFor({ adapter: listing(r.fake), store: r.store } as never);
		resetForks();
		await refreshForks(host, ".handwriting");
		const rec = listForks().find((f) => f.pageId === NEW);
		expect(rec, "this device's ink sits in a file nothing lists").toBeDefined();
		const out = await applyForkDecision(host, rec!, "take-theirs");
		expect(out.kind, `the decision was refused: ${out.why}`).toBe("applied");
		const live = JSON.parse(r.fake.files.get(`.handwriting/${NEW}.json`)!) as { pageId: string };
		expect(live.pageId, "the live page now declares the old id inside the new id's file").toBe(NEW);
		expect(r.onDisk(NEW)).toEqual(["drawn-here"]);
	});

	it("when the new id's ink has not arrived yet, the ink drawn here becomes the new page, declaring the new id", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(NOTE);
		r.plugin.buildPageIdIndex();
		const oldStrokes = (JSON.parse(r.fake.files.get(`.handwriting/${OLD}.json`)!) as { strokes: unknown }).strokes;
		r.texts.set(NOTE, `---\nhandwriting-page-id: ${NEW}\n---\nBody\n`);
		r.plugin.checkPageIdentity(NOTE);
		await pastEveryTimer();
		await r.store.flush();
		expect(inlineInk.pageIdOf(NOTE), "the open note still writes under the id it had").toBe(NEW);
		expect(r.fake.files.has(`.handwriting/${OLD}.json`), "the old id's file stayed where nothing names it").toBe(false);
		const moved = JSON.parse(r.fake.files.get(`.handwriting/${NEW}.json`) ?? "null") as { pageId: string; strokes: unknown } | null;
		expect(moved?.pageId, "the moved page still declares the old id").toBe(NEW);
		expect(JSON.stringify(moved?.strokes), "the moved strokes are not the bytes drawn here").toBe(JSON.stringify(oldStrokes));
		expect(inlineInk.strokes(NOTE).map((s) => s.id)).toEqual(["drawn-here"]);
	});

	it("and when the other device's ink file for the new id lands later, the next save keeps it and fix ink de-sync lists it", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(NOTE);
		r.plugin.buildPageIdIndex();
		r.texts.set(NOTE, `---\nhandwriting-page-id: ${NEW}\n---\nBody\n`);
		r.plugin.checkPageIdentity(NOTE);
		await pastEveryTimer();
		await r.store.flush();
		expect(inlineInk.pageIdOf(NOTE), "precondition: the note follows the new id").toBe(NEW);
		const theirs = emptyPage(NEW);
		theirs.surface = "inline";
		theirs.strokes = [stroke("drawn-there", 60)];
		r.fake.externalWrite(`.handwriting/${NEW}.json`, serializePage(theirs));
		inlineInk.commit(NOTE, stroke("after-it-landed", 120));
		await pastEveryTimer();
		await r.store.flush();
		const host = forkHostFor({ adapter: listing(r.fake), store: r.store } as never);
		resetForks();
		await refreshForks(host, ".handwriting");
		const rec = listForks().find((f) => f.pageId === NEW);
		expect(rec, "the other device's ink sits in a file nothing lists").toBeDefined();
		expect(parsePage(r.fake.files.get(rec!.incomingPath)!, NEW).data.strokes.map((s) => s.id)).toEqual(["drawn-there"]);
	});

	it("a move of the old file that fails keeps the note on the old id, and the next identity check moves it", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(NOTE);
		r.plugin.buildPageIdIndex();
		const theirs = emptyPage(NEW);
		theirs.surface = "inline";
		theirs.strokes = [stroke("drawn-there", 60)];
		r.fake.externalWrite(`.handwriting/${NEW}.json`, serializePage(theirs));
		r.fake.failRenameTimes = 1;
		r.fake.failRenameWhen = (from) => from === `.handwriting/${OLD}.json`;
		r.texts.set(NOTE, `---\nhandwriting-page-id: ${NEW}\n---\nBody\n`);
		r.plugin.checkPageIdentity(NOTE);
		await pastEveryTimer();
		expect(r.fake.failRenameTimes, "precondition: the move failed once").toBe(0);
		expect(r.fake.files.has(`.handwriting/${OLD}.json`), "the old file was lost").toBe(true);
		expect(inlineInk.pageIdOf(NOTE), "a failed move left the note with no record").toBe(OLD);

		r.plugin.checkPageIdentity(NOTE);
		await pastEveryTimer();
		await r.store.flush();
		expect(inlineInk.pageIdOf(NOTE), "the next identity check did not follow the new id").toBe(NEW);
		const host = forkHostFor({ adapter: listing(r.fake), store: r.store } as never);
		resetForks();
		await refreshForks(host, ".handwriting");
		const rec = listForks().find((f) => f.pageId === NEW);
		expect(rec, "after the retry the ink drawn here is still in a file nothing lists").toBeDefined();
		expect(parsePage(r.fake.files.get(rec!.incomingPath)!, NEW).data.strokes.map((s) => s.id)).toEqual(["drawn-here"]);
	});

	it("an old file that does not parse, with no new page to sit beside, is kept byte for byte and the note still follows", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(NOTE);
		r.plugin.buildPageIdIndex();
		const damaged = "{ this is not a page";
		r.fake.files.set(`.handwriting/${OLD}.json`, damaged);
		r.texts.set(NOTE, `---\nhandwriting-page-id: ${NEW}\n---\nBody\n`);
		r.plugin.checkPageIdentity(NOTE);
		await pastEveryTimer();
		expect(inlineInk.pageIdOf(NOTE), "a damaged old file kept the note off its new id for good").toBe(NEW);
		expect(
			[...r.fake.files.entries()].filter(([k]) => k.startsWith(`.handwriting/${NEW}.conflict-`)).map(([, v]) => v),
			"the damaged bytes were rewritten or lost"
		).toEqual([damaged]);
		expect(r.fake.files.has(`.handwriting/${OLD}.json`)).toBe(false);
	});

	it("when another note still names the old id, the old file stays where it is: it is that note's", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(NOTE);
		r.plugin.buildPageIdIndex();
		const theirs = emptyPage(NEW);
		theirs.surface = "inline";
		theirs.strokes = [stroke("drawn-there", 60)];
		r.fake.externalWrite(`.handwriting/${NEW}.json`, serializePage(theirs));
		r.texts.set(NOTE, `---\nhandwriting-page-id: ${NEW}\n---\nBody\n`);
		r.plugin.checkPageIdentity(NOTE);
		// Before the edit settles, the old id passes to another note.
		r.plugin.pageIds.transfer(OLD, "Other note.md");
		await pastEveryTimer();
		await r.store.flush();
		expect(inlineInk.pageIdOf(NOTE), "the note did not follow its new id").toBe(NEW);
		expect(r.onDisk(OLD), "the other note's file was moved away from it").toEqual(["drawn-here"]);
		expect(
			[...r.fake.files.keys()].filter((k) => k.startsWith(`.handwriting/${NEW}.conflict-`)),
			"the other note's file was set aside as this note's fork"
		).toEqual([]);
	});
});
