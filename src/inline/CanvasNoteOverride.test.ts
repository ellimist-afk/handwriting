/**
 * The frontmatter side of per-note Infinite Canvas. What a note says, what
 * the global says when the note says nothing, what reaches the listener, and the
 * three things `NotePaper`'s write queue was built for.
 *
 * The fixture is `NotePaper.test.ts`'s, trimmed to this file's surface: no
 * leaves, no modal, no DOM attribute.
 */
import { describe, expect, it, vi } from "vitest";
import { type App, type CachedMetadata, type Plugin, TFile } from "obsidian";
import {
	CanvasNoteOverride,
	NOTE_CANVAS_KEY,
	canvasForNote,
	noteCanvasChoice,
	onCanvasOverrideChanged,
	resolveCanvas,
	setCanvasNoteOverrideForTest,
} from "./CanvasNoteOverride";

function fixture() {
	const a = Object.assign(new TFile(), { path: "a.md", extension: "md" });
	const b = Object.assign(new TFile(), { path: "b.md", extension: "md" });
	const notes = Object.assign(new TFile(), { path: "notes.txt", extension: "txt" });
	const files = new Map<string, TFile>([[a.path, a], [b.path, b], [notes.path, notes]]);
	const metadata = new Map<TFile, CachedMetadata>([
		[a, { frontmatter: { title: "A", [NOTE_CANVAS_KEY]: true } }],
		[b, { frontmatter: { title: "B" } }],
	]);
	const disk = new Map<TFile, Record<string, unknown>>([...metadata].map(([file, cache]) => [file, { ...cache.frontmatter }]));
	const contents = new Map<TFile, string>([[a, "a initial"], [b, "b initial"]]);
	const events = new Map<string, (...args: any[]) => unknown>();
	const cleanups: (() => void)[] = [];
	// The real `processFrontMatter` reads, edits and writes the file, and it is not
	// instant. This fake yields in the middle of that and records whether a second
	// call ever started while the first was still inside it - which is the thing
	// the write queue exists to prevent, and which a synchronous fake can never see.
	let inFlight = 0;
	let overlapped = false;
	const processFrontMatter = vi.fn(async (file: TFile, change: (fm: Record<string, unknown>) => void) => {
		if (inFlight > 0) overlapped = true;
		inFlight++;
		try {
			await new Promise(resolve => setTimeout(resolve, 0));
			change(disk.get(file)!);
			contents.set(file, JSON.stringify(disk.get(file)));
		} finally {
			inFlight--;
		}
	});
	const app = {
		metadataCache: {
			getFileCache: (file: TFile) => metadata.get(file),
			on: (name: string, callback: (...args: any[]) => unknown) => { events.set(name, callback); return {}; },
		},
		fileManager: { processFrontMatter },
		vault: {
			read: vi.fn(async (file: TFile) => contents.get(file)!),
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
		},
	} as unknown as App;
	const override = new CanvasNoteOverride(app);
	override.start({ registerEvent: () => {}, register: (cleanup: () => void) => cleanups.push(cleanup) } as unknown as Plugin);
	const changed = (file: TFile, fm: Record<string, unknown>, data = contents.get(file)!) => {
		const cache = { frontmatter: fm };
		metadata.set(file, cache);
		return events.get("changed")!(file, data, cache) as Promise<void> | undefined;
	};
	const seen: string[] = [];
	const stop = override.onChanged(path => seen.push(path));
	return { a, b, notes, app, override, metadata, disk, contents, processFrontMatter, events, changed, seen, stop, cleanups, overlapped: () => overlapped };
}

describe("noteCanvasChoice", () => {
	it("takes YAML booleans and the quoted strings, either case", () => {
		expect(noteCanvasChoice(true)).toBe(true);
		expect(noteCanvasChoice(false)).toBe(false);
		expect(noteCanvasChoice("true")).toBe(true);
		expect(noteCanvasChoice("FALSE")).toBe(false);
		expect(noteCanvasChoice(" True ")).toBe(true);
	});

	it.each([undefined, null, "yes", "no", "on", "off", "maybe", 1, 0, {}, []])(
		"leaves %s to the global rather than guessing an override",
		value => {
			expect(noteCanvasChoice(value)).toBe("default");
		},
	);
});

describe("resolveCanvas", () => {
	it("the note wins when it has an opinion, the global when it does not", () => {
		expect(resolveCanvas(true, false)).toBe(true);
		expect(resolveCanvas(false, true)).toBe(false);
		expect(resolveCanvas("default", true)).toBe(true);
		expect(resolveCanvas("default", false)).toBe(false);
	});
});

describe("CanvasNoteOverride", () => {
	it("answers with the note's value, and with the global where the note is silent", () => {
		const f = fixture();
		expect(f.override.choice("a.md")).toBe(true);
		expect(f.override.choice("b.md")).toBe("default");
		expect(f.override.canvasForNote("a.md", false)).toBe(true);
		expect(f.override.canvasForNote("b.md", false)).toBe(false);
		expect(f.override.canvasForNote("b.md", true)).toBe(true);
	});

	it("gives the global for a path it does not have, a non-markdown file, or no path at all", () => {
		const f = fixture();
		expect(f.override.canvasForNote("missing.md", true)).toBe(true);
		expect(f.override.canvasForNote("notes.txt", true)).toBe(true);
		expect(f.override.canvasForNote(null, false)).toBe(false);
	});

	it("tells its listener which note changed, and stops when unsubscribed", async () => {
		const f = fixture();
		await f.changed(f.b, { [NOTE_CANVAS_KEY]: false });
		expect(f.seen).toEqual(["b.md"]);
		expect(f.override.canvasForNote("b.md", true)).toBe(false);
		f.stop();
		await f.changed(f.b, { [NOTE_CANVAS_KEY]: true });
		expect(f.seen).toEqual(["b.md"]);
	});

	it("writes the note's own key, and removes it for default, leaving the rest of the frontmatter alone", async () => {
		const f = fixture();
		await f.override.save(f.b, true);
		expect(f.disk.get(f.b)).toEqual({ title: "B", [NOTE_CANVAS_KEY]: true });
		await f.override.save(f.b, false);
		expect(f.disk.get(f.b)).toEqual({ title: "B", [NOTE_CANVAS_KEY]: false });
		await f.override.save(f.b, "default");
		expect(f.disk.get(f.b)).toEqual({ title: "B" });
		expect(f.seen).toEqual(["b.md", "b.md", "b.md"]);
	});

	it("reads back what was just written before the metadata cache has caught up", async () => {
		const f = fixture();
		// The cache still says nothing for b: the optimistic value is what a read must see.
		await f.override.save(f.b, true);
		expect(f.metadata.get(f.b)?.frontmatter?.[NOTE_CANVAS_KEY]).toBeUndefined();
		expect(f.override.canvasForNote("b.md", false)).toBe(true);
		// Once the cache agrees, the optimistic value is dropped and the cache answers.
		await f.changed(f.b, { title: "B", [NOTE_CANVAS_KEY]: true });
		expect(f.override.canvasForNote("b.md", false)).toBe(true);
	});

	it("does not let a cache event queued before the write undo the value the user just chose", async () => {
		const f = fixture();
		await f.override.save(f.b, true);
		// A stale event: it carries the file's PREVIOUS contents, which no longer match the vault.
		await f.changed(f.b, { title: "B" }, "b initial");
		expect(f.override.canvasForNote("b.md", false)).toBe(true);
		// A genuinely newer external edit carries the current contents and wins.
		await f.changed(f.b, { title: "B" }, f.contents.get(f.b)!);
		expect(f.override.canvasForNote("b.md", false)).toBe(false);
	});

	it("serialises two quick toggles of the same note, so the last one is what the file holds", async () => {
		const f = fixture();
		const first = f.override.save(f.b, true);
		const second = f.override.save(f.b, false);
		await Promise.all([first, second]);
		expect(f.processFrontMatter).toHaveBeenCalledTimes(2);
		expect(f.overlapped(), "the second write started while the first was still inside processFrontMatter").toBe(false);
		expect(f.disk.get(f.b)).toEqual({ title: "B", [NOTE_CANVAS_KEY]: false });
		expect(f.override.canvasForNote("b.md", true)).toBe(false);
	});

	it("refuses to write a note that is no longer the file at that path", async () => {
		const f = fixture();
		const ghost = Object.assign(new TFile(), { path: "gone.md", extension: "md" });
		await expect(f.override.save(ghost, true)).rejects.toThrow(/no longer exists/);
		expect(f.processFrontMatter).not.toHaveBeenCalled();
	});

	it("saveForPath finds the file, and says false rather than throwing at a missing note", async () => {
		const f = fixture();
		expect(await f.override.saveForPath("b.md", true)).toBe(true);
		expect(f.disk.get(f.b)).toEqual({ title: "B", [NOTE_CANVAS_KEY]: true });
		expect(await f.override.saveForPath("missing.md", true)).toBe(false);
		expect(await f.override.saveForPath("notes.txt", true)).toBe(false);
	});

	it("after destroy it answers the global, writes nothing and calls no listener", async () => {
		const f = fixture();
		for (const cleanup of f.cleanups) cleanup();
		expect(f.override.canvasForNote("a.md", false)).toBe(false);
		await f.override.save(f.b, true);
		expect(f.processFrontMatter).not.toHaveBeenCalled();
		await f.changed(f.b, { [NOTE_CANVAS_KEY]: true });
		expect(f.seen).toEqual([]);
	});
});

describe("the module getter the overlay calls", () => {
	it("is the global default before any override has started", () => {
		setCanvasNoteOverrideForTest(null);
		expect(canvasForNote("a.md", true)).toBe(true);
		expect(canvasForNote("a.md", false)).toBe(false);
		expect(onCanvasOverrideChanged(() => {})).toBeTypeOf("function");
	});

	it("routes to the started instance, and back to the global once it is gone", async () => {
		const f = fixture();
		const seen: string[] = [];
		const stop = onCanvasOverrideChanged(path => seen.push(path));
		expect(canvasForNote("a.md", false)).toBe(true);
		await f.changed(f.b, { [NOTE_CANVAS_KEY]: false });
		expect(seen).toEqual(["b.md"]);
		stop();
		for (const cleanup of f.cleanups) cleanup();
		expect(canvasForNote("a.md", false)).toBe(false);
	});
});
