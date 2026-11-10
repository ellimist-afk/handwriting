/**
 * A first stroke on a new note can land after the layout is ready and
 * before Obsidian's metadata "resolved" event, so before the startup census
 * has run. The claim registers the new note in the ownership ledger. If it
 * also writes the ledger to the saved owner memory at that point, the saved
 * memory shrinks to that one claim, and the census that follows can no
 * longer tell which note of a copied pair is the original: the pair is
 * locked instead of the copy being repaired.
 *
 * These cells run the real claim, the real owner memory write and the real
 * census on a plugin built without its constructor.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import { PageIdIndex } from "../model/PageIdIndex";
import { parseMarkdownPage } from "../model/MarkdownPage";

const ORIGINAL = "Notes/Original.md";
const COPY = "Notes/Original 1.md";
const NEW = "Notes/New.md";
const A = "page-0123456789abcdef";
const FRESH = "page-fedcba9876543210";

type Note = { file: { path: string; extension: string; basename: string }; text: string };

function fm(text: string): Record<string, string> | undefined {
	const lines = text.split("\n");
	if (lines[0] !== "---") return undefined;
	const close = lines.indexOf("---", 1);
	if (close < 0) return undefined;
	const out: Record<string, string> = {};
	for (const line of lines.slice(1, close)) {
		const i = line.indexOf(":");
		if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
	}
	return Object.keys(out).length === 0 ? undefined : out;
}

function setup(watchReady: boolean) {
	const notes = new Map<string, Note>();
	const add = (path: string, text: string) =>
		notes.set(path, { file: { path, extension: "md", basename: path.slice(6, -3) }, text });
	add(ORIGINAL, `---\nhandwriting-page-id: ${A}\n---\n# Original\n`);
	add(COPY, `---\nhandwriting-page-id: ${A}\n---\n# Original\n`);
	add(NEW, "# New\n");
	const cache = (path: string) => {
		const n = notes.get(path);
		if (!n) return null;
		const f = fm(n.text);
		return f ? { frontmatter: f } : {};
	};
	const repaired: { path: string; id: string; owner: string }[] = [];
	const plugin: any = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		pageIdWatchReady: watchReady,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		settings: { pageOwners: { [A]: ORIGINAL } as Record<string, string>, cameras: {} },
		settingsReadFailed: false,
		settingsDirty: false,
		settingsTimer: null,
		flushSettings: async () => {},
		resolveDuplicate: async (path: string, id: string, owner: string) => {
			repaired.push({ path, id, owner });
		},
		app: {
			vault: {
				getFileByPath: (p: string) => notes.get(p)?.file ?? null,
				getMarkdownFiles: () => [...notes.values()].map((n) => n.file),
				process: async (f: { path: string }, fn: (data: string) => string) => {
					await Promise.resolve();
					const n = notes.get(f.path)!;
					n.text = fn(n.text);
					return n.text;
				},
			},
			metadataCache: {
				getCache: (p: string) => cache(p),
				getFileCache: (f: { path: string }) => cache(f.path),
			},
		},
	});
	return { plugin, notes, repaired };
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(() => {
	for (const p of [ORIGINAL, COPY, NEW]) inlineInk.handleDelete(p);
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("a claim before the census leaves the saved owner of a copied pair alone, and the copy is repaired", async () => {
	const { plugin, notes, repaired } = setup(false);

	const out = await plugin.claimNotePageId(NEW, FRESH);
	expect(out.pageId).toBe(FRESH);
	expect(parseMarkdownPage(notes.get(NEW)!.text).pageId, "the new note was not stamped").toBe(FRESH);
	expect.soft(plugin.settings.pageOwners[A], "the claim replaced the saved owner memory").toBe(ORIGINAL);

	// The metadata index resolves: the census runs.
	plugin.pageIdWatchReady = true;
	plugin.buildPageIdIndex();

	expect.soft(plugin.settings.pageOwners[A], "the census lost the original as owner").toBe(ORIGINAL);
	expect.soft(plugin.settings.pageOwners[FRESH], "the new note does not own its own id").toBe(NEW);
	expect.soft([...plugin.ambiguousIds.keys()], "the copied pair was locked as ambiguous").toEqual([]);
	expect.soft(repaired, "the copy was not sent for repair against the original").toEqual([
		{ path: COPY, id: A, owner: ORIGINAL },
	]);
});

it("a claim after the census still writes owner memory for the new note", async () => {
	const { plugin } = setup(true);
	plugin.buildPageIdIndex();
	await plugin.claimNotePageId(NEW, FRESH);
	expect(plugin.settings.pageOwners[FRESH]).toBe(NEW);
	expect(plugin.settings.pageOwners[A]).toBe(ORIGINAL);
	expect(plugin.settingsDirty).toBe(true);
});
