/**
 * A note that turns into an encrypted file of the same name is not gone.
 *
 * An encryption plugin rewrites `note.md` as `note.mdenc`. The device that
 * encrypts sees a rename; a synced device sees the .md deleted and the
 * .mdenc created. The id search cannot read an encrypted file, so the delete
 * path used to decide the note was gone and moved its ink to the trash ten
 * seconds later, on every device. The ink belongs to a note that is still
 * there, under a name the id search cannot open, so it stays.
 *
 * Drives the real `onFileDeleted` -> grace -> recycle path on a prototype
 * rig; only the vault, the metadata cache and the store are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(_message: string) {}
	},
}));

import HandwritingPlugin from "./main";
import { TFile } from "obsidian";
import { PageIdIndex } from "./model/PageIdIndex";

const ID = "a1b2c3d4-0000-4000-8000-000000000001";
const GRACE_PAST_MS = 10_001;

function tfile(path: string): TFile {
	const name = path.split("/").pop()!;
	const dot = name.lastIndexOf(".");
	return Object.assign(new TFile(), {
		path,
		name,
		// Obsidian lower-cases the extension; the path keeps its case.
		extension: dot >= 0 ? name.slice(dot + 1).toLowerCase() : "",
		basename: dot >= 0 ? name.slice(0, dot) : name,
	});
}

/** A vault holding `note` with the page id in its frontmatter, and a plugin over it. */
function rig(note: string) {
	const files = new Set<string>([note]);
	const ids = new Map<string, string>([[note, ID]]);
	const remove = vi.fn(async (_pageId: string) => {});
	const app = {
		vault: {
			getFiles: () => [...files].map(tfile),
			getMarkdownFiles: () => [...files].map(tfile).filter((f) => f.extension === "md"),
			getFileByPath: (p: string) => (files.has(p) ? tfile(p) : null),
		},
		metadataCache: {
			// The cache for a deleted file can still answer, as it does in
			// the app for the moment the delete event runs.
			getCache: (p: string) => (ids.has(p) ? { frontmatter: { "handwriting-page-id": ids.get(p) } } : null),
		},
	};
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown> & {
		onFileDeleted(file: TFile): Promise<void>;
	};
	const pageIds = new PageIdIndex();
	pageIds.rebuild([{ path: note, id: ID }]);
	Object.assign(plugin, {
		app,
		store: { remove },
		pageIds,
		ambiguousIds: new Map(),
		pendingRecycle: new Map(),
		settings: { cameras: { [ID]: { x: 0, y: 0, zoom: 1 } }, pageOwners: { [ID]: note } },
		settingsDirty: false,
		flushSettings: vi.fn(async () => {}),
		persistOwners: vi.fn(),
	});
	return {
		plugin,
		remove,
		/** The vault drops the file, then the plugin's real delete handler runs. */
		async deleteFile(path: string) {
			files.delete(path);
			await plugin.onFileDeleted(tfile(path));
			// After the event, the cache no longer knows the file.
			ids.delete(path);
		},
		createFile(path: string) {
			files.add(path);
		},
	};
}

beforeEach(() => {
	// The plugin arms its grace timer on `window`; here that is the global the fake timers replace.
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("an encrypted file at the note's own name keeps the ink", () => {
	it("note.md deleted and note.mdenc created at the same stem: the ink is not recycled", async () => {
		const r = rig("Notes/note.md");
		await r.deleteFile("Notes/note.md");
		r.createFile("Notes/note.mdenc");
		await vi.advanceTimersByTimeAsync(GRACE_PAST_MS);
		expect(r.remove).not.toHaveBeenCalled();
	});

	it("an upper-case .MD note keeps its ink the same way", async () => {
		const r = rig("Notes/README.MD");
		await r.deleteFile("Notes/README.MD");
		r.createFile("Notes/README.mdenc");
		await vi.advanceTimersByTimeAsync(GRACE_PAST_MS);
		expect(r.remove).not.toHaveBeenCalled();
	});

	it("the encrypted file arriving before the delete also keeps it", async () => {
		const r = rig("note.md");
		r.createFile("note.mdenc");
		await r.deleteFile("note.md");
		await vi.advanceTimersByTimeAsync(GRACE_PAST_MS);
		expect(r.remove).not.toHaveBeenCalled();
	});
});

describe("a real delete still recycles", () => {
	it("nothing left at the stem: the ink goes to the trash after the grace", async () => {
		const r = rig("Notes/note.md");
		await r.deleteFile("Notes/note.md");
		await vi.advanceTimersByTimeAsync(GRACE_PAST_MS);
		expect(r.remove).toHaveBeenCalledTimes(1);
		expect(r.remove).toHaveBeenCalledWith(ID);
	});

	it("the same name in another folder is not the note", async () => {
		const r = rig("Notes/note.md");
		await r.deleteFile("Notes/note.md");
		r.createFile("Other/note.mdenc");
		await vi.advanceTimersByTimeAsync(GRACE_PAST_MS);
		expect(r.remove).toHaveBeenCalledWith(ID);
	});

	it("another name in the same folder is not the note", async () => {
		const r = rig("Notes/note.md");
		await r.deleteFile("Notes/note.md");
		r.createFile("Notes/note 2.mdenc");
		r.createFile("Notes/notes.mdenc");
		await vi.advanceTimersByTimeAsync(GRACE_PAST_MS);
		expect(r.remove).toHaveBeenCalledWith(ID);
	});

	it("an .md at the same stem is the id search's to judge, not this rule's", async () => {
		// The note comes back as .md without its id: the id search finds no
		// carrier, and an .md is not an encrypted twin, so it recycles as before.
		const r = rig("Notes/note.md");
		await r.deleteFile("Notes/note.md");
		r.createFile("Notes/note.md");
		await vi.advanceTimersByTimeAsync(GRACE_PAST_MS);
		expect(r.remove).toHaveBeenCalledWith(ID);
	});
});
