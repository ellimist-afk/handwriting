/**
 * The page side of CanvasOverrideRoundTrip.test.ts. Runs the per-note
 * Infinite Canvas override in a real browser against a fake vault whose
 * frontmatter is written, re-parsed and read back, so the read / listen / write
 * loop is exercised end to end rather than mocked at each seam.
 *
 * The fake app is `notePaperPage`'s, with one difference that matters: its
 * `processFrontMatter` here actually mutates a stored frontmatter object and
 * then feeds a `changed` event back, the way Obsidian's metadata cache does
 * after a write. What this cannot prove is Obsidian's own YAML: see the cell
 * header.
 */
import { TFile, type App, type CachedMetadata, type Plugin } from "obsidian";
import {
	CanvasNoteOverride,
	NOTE_CANVAS_KEY,
	canvasForNote,
	onCanvasOverrideChanged,
	type NoteCanvasChoice,
} from "../../src/inline/CanvasNoteOverride";

export function canvasOverrideProbe() {
	// REAL `TFile` INSTANCES, not object literals shaped like one. `notePaperPage`
	// gets away with literals because nothing it calls asks what class they are;
	// `CanvasNoteOverride.fileAt` does - `file instanceof TFile` is how it refuses
	// a folder or a non-note - so a literal is answered as "no such note" and every
	// read falls back to the global. The first run of this row failed all four
	// rows exactly that way, which is the row working: it reaches the real getter.
	const a = Object.assign(new TFile(), { path: "a.md", extension: "md" });
	const b = Object.assign(new TFile(), { path: "b.md", extension: "md" });
	const files = new Map<string, TFile>([[a.path, a], [b.path, b]]);
	/** The "disk": what a reopened vault would parse out of each note. */
	const disk = new Map<TFile, Record<string, unknown>>([[a, { title: "A" }], [b, { title: "B", [NOTE_CANVAS_KEY]: false }]]);
	/** The metadata cache, which trails the disk until an event says otherwise. */
	const cache = new Map<TFile, CachedMetadata>([...disk].map(([file, fm]) => [file, { frontmatter: { ...fm } }]));
	const events = new Map<string, (...args: any[]) => void>();
	const contents = new Map<TFile, string>([...disk].map(([file, fm]) => [file, JSON.stringify(fm)]));

	const app = {
		metadataCache: {
			getFileCache: (file: TFile) => cache.get(file),
			on: (event: string, cb: (...args: any[]) => void) => { events.set(event, cb); return {}; },
		},
		fileManager: {
			processFrontMatter: async (file: TFile, change: (fm: Record<string, unknown>) => void) => {
				await new Promise(resolve => setTimeout(resolve, 0));
				change(disk.get(file)!);
				contents.set(file, JSON.stringify(disk.get(file)));
			},
		},
		vault: {
			read: async (file: TFile) => contents.get(file)!,
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
		},
	} as unknown as App;

	const override = new CanvasNoteOverride(app);
	override.start({ registerEvent: () => {}, register: () => {} } as unknown as Plugin);
	const heard: string[] = [];
	onCanvasOverrideChanged(path => heard.push(path));

	/** Obsidian noticing the write: the cache catches up and the event fires. */
	const reparse = async (file: TFile): Promise<void> => {
		const next = { frontmatter: { ...disk.get(file)! } };
		cache.set(file, next);
		await events.get("changed")!(file, contents.get(file)!, next);
	};

	/** The whole loop for one note: write the choice, let the vault catch up, read it back. */
	const roundTrip = async (path: string, choice: NoteCanvasChoice, globalDefault: boolean) => {
		const file = files.get(path)!;
		const before = canvasForNote(path, globalDefault);
		const saved = await override.saveForPath(path, choice);
		const afterWrite = canvasForNote(path, globalDefault);
		const onDisk = { ...disk.get(file)! };
		await reparse(file);
		return { before, saved, afterWrite, onDisk, afterReparse: canvasForNote(path, globalDefault), heard: [...heard] };
	};

	return {
		roundTrip,
		/** An edit made outside the plugin: the user types the key into the note themselves. */
		external: async (path: string, frontmatter: Record<string, unknown>, globalDefault: boolean) => {
			const file = files.get(path)!;
			disk.set(file, frontmatter);
			contents.set(file, JSON.stringify(frontmatter));
			await reparse(file);
			return { value: canvasForNote(path, globalDefault), heard: [...heard] };
		},
		/** Both notes at once under one global, which is the side-by-side case in one reader. */
		both: (globalDefault: boolean) => ({
			a: canvasForNote("a.md", globalDefault),
			b: canvasForNote("b.md", globalDefault),
			unknown: canvasForNote("missing.md", globalDefault),
		}),
		destroy: () => override.destroy(),
	};
}

(window as any).canvasOverride = canvasOverrideProbe;
