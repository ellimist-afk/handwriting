/**
 * INFINITE CANVAS PER NOTE - the plumbing half.
 *
 * The Infinite Canvas setting becomes the DEFAULT, and any note may override it
 * for itself in its own frontmatter (`handwriting-canvas: true` / `false`),
 * exactly as `handwriting-paper` overrides the paper background. This file is
 * the frontmatter side of that and nothing else: it reads the key, follows the
 * metadata cache, writes the key back, and answers one question -
 * `canvasForNote(path, globalDefault)`. It paints nothing, owns no DOM, and
 * knows nothing about zoom, momentum or the zoom bar; the overlay and the
 * toolbar are wired separately.
 *
 * The shape is `NotePaper`'s, deliberately and with its queue duplicated rather
 * than extracted: see the note on `save` below.
 */
import { TFile, type App, type CachedMetadata, type Plugin } from "obsidian";

export const NOTE_CANVAS_KEY = "handwriting-canvas";

/** On, off, or no opinion - in which case the global setting decides. */
export type NoteCanvasChoice = true | false | "default";

/**
 * What counts as an override in frontmatter.
 *
 * YAML booleans (`handwriting-canvas: true`) arrive here as real booleans, and
 * a quoted value (`handwriting-canvas: "true"`) arrives as a string, so both
 * are accepted, case-insensitively for the string form.
 *
 * `yes`, `no`, `on` and `off` are NOT accepted and fall back to the default
 * as ruled. YAML 1.1 read those as booleans and YAML 1.2 reads them as
 * plain strings; Obsidian's parser is the one that decides, not this file, so a
 * note written with `handwriting-canvas: yes` would mean one thing today and
 * possibly another after an upstream bump. A value this file does not
 * recognise is not an error and is not repaired: the note simply has no
 * override, which is the safe reading of a key we do not understand.
 */
export function noteCanvasChoice(raw: unknown): NoteCanvasChoice {
	if (raw === true || raw === false) return raw;
	if (typeof raw === "string") {
		const lower = raw.trim().toLowerCase();
		if (lower === "true") return true;
		if (lower === "false") return false;
	}
	return "default";
}

/** Resolve one note against the global default. The whole point of the file. */
export function resolveCanvas(choice: NoteCanvasChoice, globalDefault: boolean): boolean {
	return choice === "default" ? globalDefault : choice;
}

/**
 * Per-note overrides of the Infinite Canvas mode. One instance per plugin load;
 * `started` below is what the module-level `canvasForNote` reads, so the
 * overlay can ask its question without being handed an instance - the same way
 * it reads the global flag today.
 */
export class CanvasNoteOverride {
	private stopped = false;
	/** Optimistic values for files this session has just written; see `save`. */
	private readonly saved = new Map<TFile, NoteCanvasChoice>();
	private readonly writes = new Map<TFile, Promise<void>>();
	private readonly revisions = new Map<TFile, number>();
	private revision = 0;
	private readonly listeners = new Set<(path: string) => void>();

	constructor(private app: App) {}

	start(owner: Plugin): void {
		owner.registerEvent(this.app.metadataCache.on("changed", (file, data, cache) => {
			void this.metadataChanged(file, data, cache);
		}));
		owner.register(() => this.destroy());
		setStarted(this);
	}

	/** The note's own value, or "default" when it has none. */
	choice(path: string): NoteCanvasChoice {
		const file = this.fileAt(path);
		if (!file) return "default";
		const optimistic = this.saved.get(file);
		if (optimistic !== undefined) return optimistic;
		return noteCanvasChoice(this.app.metadataCache.getFileCache(file)?.frontmatter?.[NOTE_CANVAS_KEY]);
	}

	/** The question the overlay asks: this note's mode, the global unless it says otherwise. */
	canvasForNote(path: string | null, globalDefault: boolean): boolean {
		if (this.stopped || !path) return globalDefault;
		return resolveCanvas(this.choice(path), globalDefault);
	}

	/**
	 * Fires when a note's override may have changed, with that note's path.
	 * Returns its own unsubscribe, as `onInkChanged` does.
	 *
	 * The overlay needs this: without it a frontmatter edit changes nothing
	 * until the note is remounted, which is the same defect as a setting that
	 * only applies on restart. What the overlay does about it - commit to 100
	 * percent, hide the zoom bar, restore a saved zoom - is slice B's, not this
	 * file's.
	 */
	onChanged(listener: (path: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Write the override into the note's frontmatter, through the same
	 * `processFrontMatter` writer the paper picker uses.
	 *
	 * THE QUEUE, THE REVISION GUARD AND THE OPTIMISTIC MAP ARE `NotePaper`'s,
	 * COPIED (NotePaper.ts :99-:119, ruled: duplicate with a citation, do
	 * not extract - extraction would edit NotePaper.ts, which this slice does
	 * not own). Each part earns itself there and here alike: writes to one file
	 * are serialised so two quick toggles cannot interleave inside
	 * `processFrontMatter`; the file is re-checked against the vault because a
	 * note can be deleted or replaced between the click and the write; and the
	 * value is held in `saved` until the metadata cache catches up, so a read
	 * in that window returns what the user just chose rather than the stale
	 * cache.
	 */
	async save(file: TFile, choice: NoteCanvasChoice): Promise<void> {
		const previous = this.writes.get(file) ?? Promise.resolve();
		const write = previous.catch(() => {}).then(async () => {
			if (this.stopped) return;
			if (this.app.vault.getAbstractFileByPath(file.path) !== file) throw new Error("Infinite canvas override target no longer exists");
			await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				if (choice === "default") delete frontmatter[NOTE_CANVAS_KEY];
				else frontmatter[NOTE_CANVAS_KEY] = choice;
			});
			if (this.stopped) return;
			this.revisions.delete(file);
			this.saved.set(file, choice);
			if (noteCanvasChoice(this.app.metadataCache.getFileCache(file)?.frontmatter?.[NOTE_CANVAS_KEY]) === choice) {
				this.saved.delete(file);
			}
			this.emit(file.path);
		});
		this.writes.set(file, write);
		try { await write; }
		finally { if (this.writes.get(file) === write) this.writes.delete(file); }
	}

	/**
	 * `save` by path, for the command and the toolbar toggle, which hold a path
	 * and not a file. False when the path is not a markdown file in the vault -
	 * a missing note is not an error worth throwing at a toolbar button.
	 */
	async saveForPath(path: string, choice: NoteCanvasChoice): Promise<boolean> {
		const file = this.fileAt(path);
		if (!file) return false;
		await this.save(file, choice);
		return true;
	}

	private fileAt(path: string): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile && file.extension === "md" ? file : null;
	}

	/**
	 * The cache changed. `NotePaper`'s guard, for its reason: a cache event
	 * queued before our own write must not undo the value the user just chose,
	 * but a genuinely newer external edit must win. While our optimistic value
	 * is still standing, the event is checked against the file on disk; if the
	 * file no longer matches the event's data, the event is stale and dropped.
	 */
	private async metadataChanged(file: TFile, data: string, cache: CachedMetadata): Promise<void> {
		if (this.stopped || file.extension !== "md") return;
		const revision = ++this.revision;
		this.revisions.set(file, revision);
		const choice = noteCanvasChoice(cache.frontmatter?.[NOTE_CANVAS_KEY]);
		if (this.saved.has(file) && this.saved.get(file) !== choice) {
			try {
				if (await this.app.vault.read(file) !== data) {
					if (this.revisions.get(file) === revision) this.revisions.delete(file);
					return;
				}
			} catch {
				if (this.revisions.get(file) === revision) this.revisions.delete(file);
				return;
			}
		}
		if (this.stopped || this.revisions.get(file) !== revision) return;
		this.revisions.delete(file);
		this.saved.delete(file);
		this.emit(file.path);
	}

	private emit(path: string): void {
		// A copy: a listener that unsubscribes inside its own call must not
		// disturb the iteration it is standing in.
		for (const listener of [...this.listeners]) listener(path);
	}

	destroy(): void {
		this.stopped = true;
		this.saved.clear();
		this.revisions.clear();
		this.listeners.clear();
		if (started === this) started = null;
	}
}

/** The live instance, set by `start`. Null before the plugin loads and after it unloads. */
let started: CanvasNoteOverride | null = null;

/** For tests and for a host that drives the override itself. */
export function setCanvasNoteOverrideForTest(instance: CanvasNoteOverride | null): void {
	setStarted(instance);
}

/** The one write to `started`: `start` may not assign `this` to it directly. */
function setStarted(instance: CanvasNoteOverride | null): void {
	started = instance;
}

/**
 * THE GETTER THE OVERLAY CALLS. Before the plugin has started, for a note with
 * no override, or for a path this override does not recognise, the global
 * default is the answer - so a caller can use this everywhere it reads the
 * global flag today without a null check of its own.
 */
export function canvasForNote(path: string | null, globalDefault: boolean): boolean {
	return started ? started.canvasForNote(path, globalDefault) : globalDefault;
}

/** Subscribe to override changes; returns its own unsubscribe. No-op before `start`. */
export function onCanvasOverrideChanged(listener: (path: string) => void): () => void {
	return started ? started.onChanged(listener) : () => {};
}
