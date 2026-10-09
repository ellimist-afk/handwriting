import { afterEach, beforeEach, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { parseMarkdownPage } from "../model/MarkdownPage";
import { parsePage } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkStroke } from "../ink/Stroke";

const NOTE = "Lecture.md";

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

/** YAML of the leading block; a block with no mapping entries parses to null => no frontmatter. */
function obsidianCache(text: string) {
	const lines = text.split("\n");
	const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
	const sections = [...(close > 0 ? [{ type: "yaml" }] : []), { type: "paragraph" }];
	if (close < 0) return { sections };
	const out: Record<string, string> = {};
	for (const line of lines.slice(1, close)) {
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		const i = line.indexOf(":");
		if (i <= 0) return { sections };
		out[line.slice(0, i)] = line.slice(i + 1).trim();
	}
	return Object.keys(out).length === 0 ? { sections } : { frontmatter: out, sections };
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

it("a note with an empty frontmatter block saves its first stroke", async () => {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const file = { path: NOTE, extension: "md", basename: "Lecture" };
	const note = { text: "---\n---\n# Lecture 3\n\nNotes.\n" };
	const notices: string[] = [];
	const plugin: any = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		pageIdWatchReady: true,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		declaimTimers: new Map<string, number>(),
		declaimedPaths: new Set<string>(),
		persistOwners: () => {},
		store,
		app: {
			vault: {
				adapter: fake,
				getFileByPath: (p: string) => (p === NOTE ? file : null),
				getAbstractFileByPath: (p: string) => (p === NOTE ? file : null),
				getMarkdownFiles: () => [file],
				process: async (_f: unknown, fn: (data: string) => string) => {
					await Promise.resolve();
					const before = note.text;
					note.text = fn(before);
					if (note.text !== before) window.setTimeout(() => plugin.checkPageIdentity(NOTE), 20);
					return note.text;
				},
			},
			metadataCache: {
				getCache: (p: string) => (p === NOTE ? obsidianCache(note.text) : null),
				getFileCache: (f: unknown) => (f === file ? obsidianCache(note.text) : null),
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

	await inlineInk.ensureLoaded(NOTE);
	inlineInk.commit(NOTE, stroke("s1"));
	for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(2000);
	await store.flush();

	expect(notices.filter((n) => n.includes("cannot read this note's frontmatter")), "a valid empty block was called unreadable").toEqual([]);
	const id = parseMarkdownPage(note.text).pageId;
	expect(id, "the page id was never written, so the stroke has nowhere to live").toBeTruthy();
	const onDisk = fake.files.get(`.handwriting/${id}.json`);
	expect(onDisk && parsePage(onDisk, id!).data.strokes.map((s) => s.id)).toEqual(["s1"]);
	expect(note.text).toBe(`---\nhandwriting-page-id: ${id}\n---\n# Lecture 3\n\nNotes.\n`);
});
