/**
 * A note copied while Obsidian runs gets its own ink id, and its saved ink
 * files are copied to the new id. A note can hold Slides ink and no inline
 * ink at all. The copy of such a note must still get a copy of its Slides
 * ink, or its Slides view opens blank; the original and its files are never
 * written.
 *
 * These cells reach the real duplicate repair through the metadata
 * "changed" handler, on the real page store over a fake adapter.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { parseMarkdownPage } from "../model/MarkdownPage";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { FakeAdapter } from "./FakeAdapter";
import { PageStore } from "./PageStore";
import { slidesSidecarId } from "../slides/SlidesInkSurface";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const shown = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class Notice {
		constructor(message: string) {
			shown.push(message);
		}
	}
	return { ...actual, Notice };
});

const A = "Deck.md";
const B = "Deck 1.md";
const SHARED = "page-0123456789abcdef";
const COPIED_INK = " and an independent copy of the ink.";

function stroke(id: string, x = 10): InkStroke {
	const width = 2;
	const points = [
		{ x, y: 10, pressure: 0.5, t: 0 },
		{ x: x + 10, y: 20, pressure: 0.5, t: 8 },
	];
	return { id, color: "#000", width, tool: "pen", points, bbox: computeBBox(points, width * 2), createdAt: 1 } as InkStroke;
}

function frontmatter(text: string): Record<string, string> | undefined {
	const lines = text.split("\n");
	if (lines[0] !== "---") return undefined;
	const close = lines.indexOf("---", 1);
	if (close < 0) return undefined;
	const out: Record<string, string> = {};
	for (const line of lines.slice(1, close)) {
		const i = line.indexOf(":");
		if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
	}
	return out;
}

function rig(files: { inline: boolean; slides: boolean }) {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never);
	if (files.inline) {
		const page = emptyPage(SHARED);
		page.surface = "inline";
		page.strokes = [stroke("inline-original", 5)];
		fake.files.set(`.handwriting/${SHARED}.json`, serializePage(page));
	}
	if (files.slides) {
		const id = slidesSidecarId(SHARED);
		const page = emptyPage(id);
		page.surface = "slides";
		page.coordSpace = "slide-logical";
		page.deck = { width: 960, height: 700 };
		page.slides = [{ index: 0, hash: "1a2b3c4d" }];
		page.strokes = [stroke("slide-original", 30), stroke("slide-second", 60)];
		fake.files.set(`.handwriting/${id}.json`, serializePage(page));
	}
	const texts = new Map<string, string>([
		[A, `---\nhandwriting-page-id: ${SHARED}\n---\n# Deck\n`],
		[B, `---\nhandwriting-page-id: ${SHARED}\n---\n# Deck\n`],
	]);
	const notes = new Map([A, B].map((p) => [p, { path: p, extension: "md", basename: p.slice(0, -3) }]));
	const cache = (p: string) => {
		const t = texts.get(p);
		if (t === undefined) return null;
		const f = frontmatter(t);
		return f ? { frontmatter: f, sections: [{ type: "yaml" }] } : { sections: [] };
	};
	const plugin: any = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		pageIdWatchReady: true,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		declaimTimers: new Map<string, number>(),
		declaimedPaths: new Set<string>(),
		resolvingDuplicates: new Set<unknown>(),
		settings: { pageOwners: {}, cameras: {} },
		persistOwners: () => {},
		store,
		app: {
			vault: {
				adapter: fake,
				getFileByPath: (p: string) => notes.get(p) ?? null,
				getAbstractFileByPath: (p: string) => notes.get(p) ?? null,
				getMarkdownFiles: () => [...notes.values()],
				process: async (f: { path: string }, fn: (data: string) => string) => {
					await Promise.resolve();
					const after = fn(texts.get(f.path)!);
					texts.set(f.path, after);
					return after;
				},
			},
			metadataCache: {
				getCache: (p: string) => cache(p),
				getFileCache: (f: { path: string }) => cache(f.path),
			},
		},
	});
	const host: InlineInkHost = {
		readPageId: (path) => plugin.notePageId(path),
		claimId: (path, proposedId) => plugin.claimNotePageId(path, proposedId),
		loadSidecar: (pageId) => store.load(pageId),
		scheduleSidecar: (pageId, page) => store.schedule(pageId, page),
		scheduleSidecarNow: (pageId, page) => store.saveNow(pageId, page),
		notify: () => {},
	};
	inlineInk.attachHost(host);
	return { plugin, texts, fake };
}

/** The original is known; the copy's metadata "changed" event reaches the real repair. */
async function duplicateWhileRunning(r: ReturnType<typeof rig>): Promise<string> {
	r.plugin.pageIds.register(A, SHARED);
	const repair = vi.spyOn(r.plugin, "resolveDuplicate");
	r.plugin.checkPageIdentity(B);
	expect(repair, "the metadata handler did not reach the duplicate repair").toHaveBeenCalledTimes(1);
	await repair.mock.results[0]!.value;
	for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(2000);
	const id = parseMarkdownPage(r.texts.get(B)!).pageId;
	expect(id, "the copy was not given an ink id of its own").toBeTruthy();
	expect(id).not.toBe(SHARED);
	expect(parseMarkdownPage(r.texts.get(A)!).pageId, "the original's id was changed").toBe(SHARED);
	return id!;
}

function snapshot(fake: FakeAdapter): Map<string, string> {
	return new Map(fake.files);
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
	shown.length = 0;
});

afterEach(() => {
	inlineInk.handleDelete(A);
	inlineInk.handleDelete(B);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("a copy of a note with Slides ink and no inline ink gets its own copy of the Slides ink", async () => {
	const r = rig({ inline: false, slides: true });
	const before = snapshot(r.fake);
	const originalNote = r.texts.get(A);
	const source = parsePage(before.get(`.handwriting/${slidesSidecarId(SHARED)}.json`)!, slidesSidecarId(SHARED)).data;

	const id = await duplicateWhileRunning(r);

	const copyText = r.fake.files.get(`.handwriting/${slidesSidecarId(id)}.json`);
	expect.soft(copyText, "the copy's Slides ink was not copied, so its Slides view opens blank").toBeDefined();
	if (copyText !== undefined) {
		const copy = parsePage(copyText, slidesSidecarId(id)).data;
		expect.soft(JSON.stringify(copy.strokes), "the copy's Slides strokes differ from the original's").toBe(
			JSON.stringify(source.strokes)
		);
		expect.soft(copy.surface).toBe("slides");
		expect.soft(copy.deck).toEqual(source.deck);
		expect.soft(copy.slides).toEqual(source.slides);
	}
	expect.soft(r.fake.files.has(`.handwriting/${id}.json`), "an inline ink file was made for the copy").toBe(false);
	for (const [path, bytes] of before) expect.soft(r.fake.files.get(path), `the original's file ${path} changed`).toBe(bytes);
	expect.soft(r.texts.get(A), "the original note was written").toBe(originalNote);
	expect.soft(shown.filter((m) => m.includes("was a copy of another Handwriting note")).length).toBe(1);
	expect.soft(shown.some((m) => m.endsWith(COPIED_INK)), "the notice did not say the ink was copied").toBe(true);
});

it("control: a copy of a note with no ink files is given its own id and no file is made", async () => {
	const r = rig({ inline: false, slides: false });
	await duplicateWhileRunning(r);
	expect([...r.fake.files.keys()].filter((k) => k.endsWith(".json")), "a file was made").toEqual([]);
	expect(shown.some((m) => m.endsWith(COPIED_INK)), "the notice claimed ink was copied").toBe(false);
});

it("control: a copy of a note with inline and Slides ink gets copies of both", async () => {
	const r = rig({ inline: true, slides: true });
	const before = snapshot(r.fake);
	const id = await duplicateWhileRunning(r);
	const inline = r.fake.files.get(`.handwriting/${id}.json`);
	const slides = r.fake.files.get(`.handwriting/${slidesSidecarId(id)}.json`);
	expect(inline && parsePage(inline, id).data.strokes.map((s) => s.id)).toEqual(["inline-original"]);
	expect(slides && parsePage(slides, slidesSidecarId(id)).data.strokes.map((s) => s.id)).toEqual([
		"slide-original",
		"slide-second",
	]);
	for (const [path, bytes] of before) expect(r.fake.files.get(path), `the original's file ${path} changed`).toBe(bytes);
	expect(shown.some((m) => m.endsWith(COPIED_INK))).toBe(true);
});
