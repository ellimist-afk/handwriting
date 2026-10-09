/**
 * A NOTE'S OWN PAPER AND CANVAS CHOICES LIVE IN ITS INK FILE, NOT ITS PROPERTIES.
 *
 * The documents promise one Handwriting line in a note's properties, the page
 * id. Choosing a paper background or Infinite Canvas for one note wrote a
 * second and third line into the note. The choices now go into the note's ink
 * file as two optional fields; each device keeps a small local hint so the
 * first paint already knows them; a note that still carries the old lines keeps
 * its look, and the old line goes only when that choice is next changed.
 *
 * Assertions state the CORRECT behaviour: green = no bug, red = bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile, type App } from "obsidian";
import HandwritingPlugin from "../main";
import { inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { NotePaper, NOTE_PAPER_ATTRIBUTE } from "./NotePaper";
import { CanvasNoteOverride } from "./CanvasNoteOverride";
import { PageIdIndex } from "../model/PageIdIndex";
import { emptyPage, serializePage } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkStroke } from "../ink/Stroke";
import * as Old from "../../test/fixtures/PageData-1.4.22";

const NOTE = "Note.md";
const ID = "page-with-choices";
const HINT_KEY = "handwriting-note-choices";

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

/** `key: value` lines between `---` fences, in order; undefined when there is no block. */
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

/** What processFrontMatter does to the file, for the keys these tests use. */
function rewriteFrontmatter(text: string, change: (fm: Record<string, unknown>) => void): string {
	const fm: Record<string, unknown> = { ...(frontmatterOf(text) ?? {}) };
	const lines = text.split("\n");
	const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
	const body = close > 0 ? lines.slice(close + 1).join("\n") : text;
	change(fm);
	const keys = Object.keys(fm);
	if (keys.length === 0) return body;
	return ["---", ...keys.map((k) => `${k}: ${String(fm[k])}`), "---", body].join("\n");
}

function cacheOf(text: string) {
	const frontmatter = frontmatterOf(text);
	const sections = [...(frontmatter ? [{ type: "yaml" }] : []), { type: "paragraph" }];
	return frontmatter === undefined ? { sections } : { frontmatter, sections };
}

function rig(noteText: string, inkFile?: Record<string, unknown>) {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never);
	if (inkFile) fake.files.set(`.handwriting/${ID}.json`, JSON.stringify(inkFile));
	const texts = new Map<string, string>([[NOTE, noteText]]);
	const file = Object.assign(new TFile(), { path: NOTE, extension: "md", basename: "Note" });
	const files = new Map<string, TFile>([[NOTE, file]]);
	const local = new Map<string, unknown>();
	const leaves: Array<{ view: { file: TFile; containerEl: unknown } }> = [];
	const processFrontMatter = vi.fn(async (f: TFile, change: (fm: Record<string, unknown>) => void) => {
		texts.set(f.path, rewriteFrontmatter(texts.get(f.path)!, change));
	});
	const vault = {
		adapter: fake,
		getFileByPath: (p: string) => files.get(p) ?? null,
		getAbstractFileByPath: (p: string) => files.get(p) ?? null,
		getMarkdownFiles: () => [...files.values()],
		read: async (f: TFile) => texts.get(f.path)!,
		process: async (f: { path: string }, fn: (data: string) => string) => {
			await Promise.resolve();
			const after = fn(texts.get(f.path)!);
			texts.set(f.path, after);
			return after;
		},
	};
	const metadataCache = {
		getCache: (p: string) => (texts.has(p) ? cacheOf(texts.get(p)!) : null),
		getFileCache: (f: { path: string }) => (texts.has(f.path) ? cacheOf(texts.get(f.path)!) : null),
		on: () => ({}),
	};
	const app = {
		vault,
		metadataCache,
		fileManager: { processFrontMatter },
		workspace: { getLeavesOfType: () => leaves, on: () => ({}), onLayoutReady: (cb: () => void) => cb() },
		loadLocalStorage: (key: string) => local.get(key) ?? null,
		saveLocalStorage: (key: string, value: unknown) => {
			if (value === null || value === undefined) local.delete(key);
			else local.set(key, value);
		},
	} as unknown as App;
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
		app,
	});
	const host: InlineInkHost = {
		readPageId: (path) => plugin.notePageId(path),
		claimId: (path, proposedId) => plugin.claimNotePageId(path, proposedId),
		loadSidecar: (pageId) => store.load(pageId),
		scheduleSidecar: (pageId, page) => store.schedule(pageId, page),
		scheduleSidecarNow: (pageId, page) => store.saveNow(pageId, page),
		// The sync adoption route, wired as main.ts wires it: without these two the
		// store holds every adoption as missing-capability.
		prepareExternalAdoption: (pageId, outgoing) => store.prepareExternalAdoption(pageId, outgoing),
		acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
		notify: (m) => void notices.push(m),
	};
	inlineInk.attachHost(host);
	const paper = new NotePaper(app, () => {});
	const canvas = new CanvasNoteOverride(app);
	/** The raw top-level object of the note's ink file, under whatever id the note names now. */
	const inkTop = (): Record<string, unknown> | null => {
		const id = frontmatterOf(texts.get(NOTE)!)?.["handwriting-page-id"];
		const raw = id === undefined ? undefined : fake.files.get(`.handwriting/${id}.json`);
		return raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>);
	};
	/** Opens the note in a pane and starts the paper, as the plugin does; returns the pane's container. */
	const showNote = () => {
		const attributes = new Map<string, string>();
		const containerEl = {
			getAttribute: (name: string) => attributes.get(name) ?? null,
			setAttribute: (name: string, value: string) => void attributes.set(name, value),
			removeAttribute: (name: string) => void attributes.delete(name),
		};
		leaves.push({ view: { file, containerEl } });
		paper.start({ registerEvent: () => {}, register: () => {} } as never);
		return containerEl;
	};
	return { fake, store, texts, file, local, processFrontMatter, app, paper, canvas, inkTop, notices, showNote };
}

function inkFileWith(...strokes: InkStroke[]): Record<string, unknown> {
	const page = emptyPage(ID);
	page.surface = "inline";
	page.strokes = strokes;
	return JSON.parse(serializePage(page)) as Record<string, unknown>;
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
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("a note's paper and canvas choices", () => {
	it("on a note with ink: no property line is written, and both choices are in the ink file", async () => {
		const before = `---\nhandwriting-page-id: ${ID}\n---\nBody\n`;
		const r = rig(before, inkFileWith(stroke("drawn")));
		await inlineInk.ensureLoaded(NOTE);

		await r.paper.save(r.file, "grid");
		await r.canvas.save(r.file, true);
		await pastEveryTimer();
		await r.store.flush();

		expect(r.texts.get(NOTE), "the note itself was edited").toBe(before);
		expect(r.inkTop()?.notePaper, "the paper choice is not in the ink file").toBe("grid");
		expect(r.inkTop()?.noteCanvas, "the canvas choice is not in the ink file").toBe(true);
	});

	it("on a note never written on: only the page id line is added, and an ink file with no strokes holds the choice", async () => {
		const r = rig("Body\n");

		await r.paper.save(r.file, "dots");
		await pastEveryTimer();
		await r.store.flush();

		const fm = frontmatterOf(r.texts.get(NOTE)!);
		expect(Object.keys(fm ?? {}), "the note gained a line other than the page id").toEqual(["handwriting-page-id"]);
		const top = r.inkTop();
		expect(top, "no ink file was written").not.toBeNull();
		expect(top?.notePaper).toBe("dots");
		expect(top?.strokes).toEqual([]);
	});

	it("the first paint after a restart already knows the note's canvas choice, from this device's hint", () => {
		const r = rig(`---\nhandwriting-page-id: ${ID}\n---\nBody\n`);
		r.local.set(HINT_KEY, JSON.stringify({ [ID]: { c: true } }));

		expect(r.canvas.canvasForNote(NOTE, false), "the note opened in the global mode, not its own").toBe(true);
	});

	it("another device's ink file with a different paper is adopted: the note's paper follows, and so does the hint", async () => {
		const r = rig(`---\nhandwriting-page-id: ${ID}\n---\nBody\n`, inkFileWith(stroke("drawn")));
		await inlineInk.ensureLoaded(NOTE);
		expect(r.paper.choice(r.file)).toBe("default");
		const pane = r.showNote();
		expect(pane.getAttribute(NOTE_PAPER_ATTRIBUTE), "the open note showed a paper before the adoption").toBeNull();

		r.fake.externalWrite(`.handwriting/${ID}.json`, JSON.stringify({ ...inkFileWith(stroke("drawn")), notePaper: "dots" }));
		// The live-reload poll asks with the panes quiet; nothing here is mid-gesture.
		await inlineInk.adoptExternal(NOTE, () => true);
		await pastEveryTimer();

		expect(r.paper.choice(r.file), "the other device's paper was not taken").toBe("dots");
		const hint = JSON.parse(String(r.local.get(HINT_KEY) ?? "{}")) as Record<string, { p?: string }>;
		expect(hint[ID]?.p, "the hint did not follow").toBe("dots");
		expect(pane.getAttribute(NOTE_PAPER_ATTRIBUTE), "the open note's paper did not change on screen").toBe("dots");
	});

	it("another device's ink file with a different canvas choice is adopted: the store, the note's mode and the hint follow, and the overlay hears it", async () => {
		const r = rig(`---\nhandwriting-page-id: ${ID}\n---\nBody\n`, inkFileWith(stroke("drawn")));
		await inlineInk.ensureLoaded(NOTE);
		expect(r.canvas.canvasForNote(NOTE, false)).toBe(false);
		const heard: string[] = [];
		r.canvas.onChanged((path) => void heard.push(path));

		r.fake.externalWrite(`.handwriting/${ID}.json`, JSON.stringify({ ...inkFileWith(stroke("drawn")), noteCanvas: true }));
		// The live-reload poll asks with the panes quiet; nothing here is mid-gesture.
		await inlineInk.adoptExternal(NOTE, () => true);
		await pastEveryTimer();

		expect(inlineInk.noteChoices(NOTE).canvas, "the store did not take the other device's canvas choice").toBe(true);
		expect(r.canvas.canvasForNote(NOTE, false), "the note did not open in the other device's mode").toBe(true);
		const hint = JSON.parse(String(r.local.get(HINT_KEY) ?? "{}")) as Record<string, { c?: boolean }>;
		expect(hint[ID]?.c, "the hint did not follow").toBe(true);
		expect(heard, "the overlay was not told the note's mode changed").toContain(NOTE);
	});

	it("a note with the old paper line keeps its look, and changing the choice removes that line and nothing else", async () => {
		const before = `---\nhandwriting-page-id: ${ID}\ntitle: Kept\nhandwriting-paper: grid\n---\nBody\n`;
		const r = rig(before, inkFileWith(stroke("drawn")));
		await inlineInk.ensureLoaded(NOTE);
		expect(r.paper.choice(r.file), "the old line no longer sets the paper").toBe("grid");

		await r.paper.save(r.file, "dots");
		await pastEveryTimer();
		await r.store.flush();

		expect(r.texts.get(NOTE), "more than the old paper line changed in the note").toBe(
			`---\nhandwriting-page-id: ${ID}\ntitle: Kept\n---\nBody\n`
		);
		expect(r.inkTop()?.notePaper).toBe("dots");
	});

	it("control: the 1.4.22 parser keeps both fields and writes them back unchanged", () => {
		const raw = JSON.stringify({ ...inkFileWith(stroke("drawn")), noteCanvas: true, notePaper: "lines" });

		const back = JSON.parse(Old.serializePage(Old.parsePage(raw, ID).data)) as Record<string, unknown>;

		expect(back.noteCanvas).toBe(true);
		expect(back.notePaper).toBe("lines");
	});

	it("control: a paper kind this build does not know reads as the setting and survives a save", async () => {
		const r = rig(`---\nhandwriting-page-id: ${ID}\n---\nBody\n`, { ...inkFileWith(stroke("drawn")), notePaper: "stars" });
		await inlineInk.ensureLoaded(NOTE);
		expect(r.paper.choice(r.file)).toBe("default");

		inlineInk.commit(NOTE, stroke("more", 60));
		await pastEveryTimer();
		await r.store.flush();

		expect(r.inkTop()?.notePaper, "the unknown paper kind was dropped").toBe("stars");
	});

	it("control: deleting a note whose ink file holds only a choice puts that file in the ink trash", async () => {
		const r = rig(`---\nhandwriting-page-id: ${ID}\n---\nBody\n`, { ...inkFileWith(), notePaper: "dots" });

		await r.store.remove(ID);

		expect(r.fake.files.has(`.handwriting/${ID}.json`)).toBe(false);
		const trashed = [...r.fake.files.keys()].filter((p) => p.startsWith(`.handwriting/trash/${ID}-`));
		expect(trashed, "the file was deleted, not recycled").toHaveLength(1);
		expect((JSON.parse(r.fake.files.get(trashed[0]!)!) as Record<string, unknown>).notePaper).toBe("dots");
	});

	it("following the setting on a note never written on writes nothing anywhere", async () => {
		const r = rig("Body\n");

		await r.paper.save(r.file, "default");
		await r.canvas.save(r.file, "default");
		await pastEveryTimer();
		await r.store.flush();

		expect(r.texts.get(NOTE)).toBe("Body\n");
		expect(r.processFrontMatter, "the note was rewritten").not.toHaveBeenCalled();
		expect([...r.fake.files.keys()]).toEqual([]);
	});
});
