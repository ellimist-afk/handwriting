/**
 * A note can be deleted after the layout is ready and before Obsidian's
 * metadata "resolved" event, so before the startup census has run. When
 * another note still carries the deleted note's id, the delete handler hands
 * the id to that survivor. If it also writes the ownership ledger to the
 * saved owner memory at that point, the saved memory shrinks to that one
 * survivor: every other copied pair loses its remembered original, and the
 * census that follows locks both notes of the pair instead of repairing the
 * copy.
 *
 * These cells run the real delete handler, the real owner memory write and
 * the real census on a plugin built without its constructor.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import HandwritingPlugin from "../main";
import { inlineInk } from "../inline/InkOverlay";
import { PageIdIndex } from "../model/PageIdIndex";

const ORIGINAL = "Notes/Original.md";
const COPY = "Notes/Original 1.md";
const TWIN = "Notes/Twin.md";
const TWIN_COPY = "Notes/Twin 1.md";
const A = "page-0123456789abcdef";
const B = "page-fedcba9876543210";

type File = { path: string; extension: string; basename: string };

function setup(watchReady: boolean) {
	const ids = new Map<string, string>([
		[ORIGINAL, A],
		[COPY, A],
		[TWIN, B],
		[TWIN_COPY, B],
	]);
	const files = new Map<string, File>();
	for (const path of ids.keys()) {
		files.set(path, Object.assign(new TFile(), { path, extension: "md", basename: path.slice(6, -3) }));
	}
	// Obsidian's delete event fires while the metadata cache still holds the
	// deleted note's frontmatter; the vault listing no longer has the file.
	const listed = new Set(ids.keys());
	const cache = (path: string) => {
		const id = ids.get(path);
		return id ? { frontmatter: { "handwriting-page-id": id } } : null;
	};
	const saved: Record<string, string>[] = [];
	const repaired: { path: string; id: string; owner: string }[] = [];
	const plugin: any = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		pageIdWatchReady: watchReady,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		settings: { pageOwners: { [A]: ORIGINAL, [B]: TWIN } as Record<string, string>, cameras: {} },
		settingsReadFailed: false,
		settingsDirty: false,
		settingsTimer: null,
		flushSettings: async () => {
			saved.push({ ...plugin.settings.pageOwners });
		},
		resolveDuplicate: async (path: string, id: string, owner: string) => {
			repaired.push({ path, id, owner });
		},
		scheduleRecycle: () => {
			throw new Error("a note whose id another note carries was sent to the recycle");
		},
		app: {
			vault: {
				getFileByPath: (p: string) => (listed.has(p) ? files.get(p)! : null),
				getMarkdownFiles: () => [...listed].map((p) => files.get(p)!),
			},
			metadataCache: {
				getCache: (p: string) => cache(p),
				getFileCache: (f: { path: string }) => cache(f.path),
			},
		},
	});
	const remove = async (path: string) => {
		listed.delete(path);
		await plugin.onFileDeleted(files.get(path));
	};
	return { plugin, saved, repaired, remove };
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(() => {
	for (const p of [ORIGINAL, COPY, TWIN, TWIN_COPY]) inlineInk.handleDelete(p);
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("deleting one note of a copied pair before the census keeps every saved owner, and the other pair is repaired", async () => {
	const { plugin, saved, repaired, remove } = setup(false);

	await remove(TWIN_COPY);
	expect.soft({ ...plugin.settings.pageOwners }, "the delete shrank the owner memory in settings").toEqual({
		[A]: ORIGINAL,
		[B]: TWIN,
	});
	await vi.advanceTimersByTimeAsync(2500);
	for (const s of saved) {
		expect.soft(s, "the delete shrank the owner memory in the saved data").toEqual({ [A]: ORIGINAL, [B]: TWIN });
	}

	// The metadata index resolves: the census runs.
	plugin.pageIdWatchReady = true;
	plugin.buildPageIdIndex();
	await vi.advanceTimersByTimeAsync(2500);

	expect.soft([...plugin.ambiguousIds.keys()], "the other copied pair was locked as ambiguous").toEqual([]);
	expect.soft(repaired, "the copy was not sent for repair against the original").toEqual([
		{ path: COPY, id: A, owner: ORIGINAL },
	]);
	expect.soft(saved.at(-1), "the census did not save the whole ledger").toEqual({ [A]: ORIGINAL, [B]: TWIN });
});

it("deleting one note of a copied pair after the census still saves the survivor as owner", async () => {
	const { plugin, saved, remove } = setup(true);
	plugin.buildPageIdIndex();
	await vi.advanceTimersByTimeAsync(2500);
	saved.length = 0;

	await remove(TWIN);
	expect(plugin.settings.pageOwners[B]).toBe(TWIN_COPY);
	expect(plugin.settingsDirty).toBe(true);
	await vi.advanceTimersByTimeAsync(2500);
	expect(saved.at(-1)?.[B], "the survivor was not saved as owner").toBe(TWIN_COPY);
});
