/**
 * A NOTE'S OWN PAPER AND CANVAS CHOICES: where the two readers get them.
 *
 * The truth is the note's ink file (PageData `noteCanvas`, `notePaper`), held
 * by the ink store. An ink file is read after the note shows, so each device
 * also keeps a small hint, page id to the two choices, in the app's local
 * storage: read at the first paint, rewritten whenever the store knows the
 * truth. When the file disagrees with the hint (another device changed the
 * choice), the note changes once, when the file is read.
 *
 * NotePaper and CanvasNoteOverride read the store through `noteChoiceSource`
 * rather than importing the overlay module, which imports them.
 */
import type { App } from "obsidian";
import type { NotePaperKind } from "../model/PageData";

export type NoteChoiceKind = "canvas" | "paper";

export interface NoteChoices {
	/** False while the note's ink file has not been read this session. */
	known: boolean;
	canvas?: boolean;
	paper?: NotePaperKind;
}

/** What the readers need of the ink store. */
export interface NoteChoiceSource {
	noteChoices(path: string): NoteChoices;
	setNoteChoice(path: string, kind: NoteChoiceKind, value: boolean | NotePaperKind | "default"): Promise<boolean>;
	onNoteChoicesChanged(listener: (path: string) => void): () => void;
	/** False in the store's session-memory mode, where nothing can be saved. */
	hasHost(): boolean;
}

let source: NoteChoiceSource | null = null;

/** Set once, beside the store's creation. Null in suites that never load the overlay. */
export function setNoteChoiceSource(next: NoteChoiceSource | null): void {
	source = next;
}

/**
 * The store, when it can keep a choice. A store with no host (session-memory
 * mode: a suite that loads the overlay but never attaches a vault) cannot
 * save one, so the readers keep the property path there, as with no store.
 */
export function noteChoiceSource(): NoteChoiceSource | null {
	return source && source.hasHost() ? source : null;
}

export const NOTE_CHOICE_HINT_KEY = "handwriting-note-choices";
const PAGE_ID_KEY = "handwriting-page-id";

type Hint = Record<string, { c?: boolean; p?: string }>;

function readHints(app: App): Hint {
	try {
		const raw = app.loadLocalStorage(NOTE_CHOICE_HINT_KEY) as unknown;
		const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
		return parsed && typeof parsed === "object" ? (parsed as Hint) : {};
	} catch {
		return {};
	}
}

/** The note's page id from its properties, or null. */
export function pageIdForPath(app: App, path: string): string | null {
	const file = app.vault.getAbstractFileByPath(path);
	if (!file) return null;
	const id = app.metadataCache.getFileCache(file as never)?.frontmatter?.[PAGE_ID_KEY] as unknown;
	return typeof id === "string" && id !== "" ? id : null;
}

/** This device's last known choices for a page, or null. */
export function readHint(app: App, pageId: string): { c?: boolean; p?: string } | null {
	return readHints(app)[pageId] ?? null;
}

/** Record what the store now knows for a note; a note with no choice leaves the hint. */
export function writeHint(app: App, path: string, choices: NoteChoices): void {
	if (!choices.known) return;
	const pageId = pageIdForPath(app, path);
	if (!pageId) return;
	const hints = readHints(app);
	const entry = {
		...(choices.canvas !== undefined ? { c: choices.canvas } : {}),
		...(choices.paper !== undefined ? { p: choices.paper } : {}),
	};
	const had = JSON.stringify(hints[pageId] ?? null);
	if (Object.keys(entry).length === 0) delete hints[pageId];
	else hints[pageId] = entry;
	if (JSON.stringify(hints[pageId] ?? null) === had) return;
	try {
		app.saveLocalStorage(NOTE_CHOICE_HINT_KEY, JSON.stringify(hints));
	} catch {
		/* the hint is a convenience; the ink file stays the truth */
	}
}
