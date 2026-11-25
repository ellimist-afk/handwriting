import type { TFile } from "obsidian";
import { diagnosticsEnabled } from "./DiagSwitch";
import { tr } from "../inline/InlinePenRouterTrace";

/** Pen-trace row types for a note opening, its camera restore, a page-id write, a duplicate sighting and repair, and an ink reload or dropped record. */
export const NOTE_OPEN_ROW = "note-open";
export const CAMERA_RESTORE_ROW = "camera-restore";
export const PAGE_ID_WRITE_ROW = "page-id-write";
export const DUPLICATE_SEEN_ROW = "duplicate-seen";
export const DUPLICATE_REPAIR_ROW = "duplicate-repair";
export const INK_RELOAD_ROW = "ink-reload";
export const INK_DROPPED_ROW = "ink-dropped";

/** What one try to put a note's remembered camera back did. */
export type CameraRestoreOutcome =
	| "skipped"
	| "restored"
	| "refused"
	| "dropped: no camera"
	| "dropped: zoomed already"
	| "dropped: scrolled already"
	| "dropped: canvas off, zoomed camera";

const yn = (b: boolean): string => (b ? "yes" : "no");

function row(type: string, note: string): void {
	try {
		tr(type, null, note);
	} catch {
		// A failed row never reaches the caller.
	}
}

/** A note opened in an editor, by a switch or a mount. */
export function traceNoteOpen(via: "switch" | "mount", cameraRemembered: boolean, editorFocused: boolean): void {
	if (!diagnosticsEnabled()) return;
	row(NOTE_OPEN_ROW, `via ${via}: camera remembered=${yn(cameraRemembered)}, editor focused=${yn(editorFocused)}`);
}

/** One restore try and what it did, named by its caller. */
export function traceCameraRestore(caller: "measure" | "ink read", outcome: CameraRestoreOutcome): void {
	if (!diagnosticsEnabled()) return;
	const what = outcome === "refused" ? "refused, still armed" : outcome.startsWith("dropped: ") ? `dropped (${outcome.slice(9)})` : outcome;
	row(CAMERA_RESTORE_ROW, `from ${caller}: ${what}`);
}

/** A page-id write to a note's text, after the write. */
export function tracePageIdWrite(kind: "claim" | "reassign", changed: boolean): void {
	if (!diagnosticsEnabled()) return;
	row(PAGE_ID_WRITE_ROW, `${kind}, changed=${yn(changed)}`);
}

/** What a duplicate sighting does next. */
export type DuplicateSeenThen = "repair" | "transfer" | "wait for owner";

/** The plugin parts the sighting row reads; page ids are compared, never printed. */
export interface DuplicateSeenHost {
	readonly app: {
		readonly workspace?: { getLastOpenFiles(): string[] };
		readonly vault: { getFileByPath(path: string): TFile | null };
	};
	recentPageIdFor(file: TFile): string | undefined;
}

/** A note seen carrying an id another note owns: whether the note open before it carries that id, and what follows. */
export function traceDuplicateSeen(then: DuplicateSeenThen, copyPath: string, id: string, host: DuplicateSeenHost): void {
	if (!diagnosticsEnabled()) return;
	let same = "?";
	try {
		const ws = host.app.workspace;
		for (const p of ws ? ws.getLastOpenFiles() : []) {
			if (p === copyPath) continue;
			const f = host.app.vault.getFileByPath(p);
			if (!f) continue;
			same = yn(host.recentPageIdFor(f) === id);
			break;
		}
	} catch {
		// A read that throws leaves "?".
	}
	row(DUPLICATE_SEEN_ROW, `seen: same id as the note open before=${same}, then ${then}`);
}

/** How a duplicate repair ended. */
export type DuplicateRepairEnd =
	| "repaired"
	| "id line gone"
	| "threw"
	| "locked: save not flushed"
	| "locked: slides clone exists"
	| "locked: slides clone unreadable"
	| "locked: flush or clone threw"
	| "locked: clone exists"
	| "locked: newer format";

/** A duplicate repair starting: whether the copy is the active note and whether it is duplicate-locked. */
export function traceDuplicateRepairStart(
	copyPath: string,
	app: { readonly workspace?: { getActiveFile(): { path: string } | null } },
	ink: { isDuplicateLocked(path: string): boolean }
): void {
	if (!diagnosticsEnabled()) return;
	let active = "?";
	let locked = "?";
	try {
		const ws = app.workspace;
		if (ws) active = yn(ws.getActiveFile()?.path === copyPath);
	} catch {
		// A workspace read that throws leaves "?".
	}
	try {
		locked = yn(ink.isDuplicateLocked(copyPath));
	} catch {
		// A lock read that throws leaves "?".
	}
	row(DUPLICATE_REPAIR_ROW, `start: copy active=${active}, copy locked=${locked}`);
}

/** The copy's id line about to be rewritten by a duplicate repair. */
export function traceDuplicateRewrite(): void {
	if (!diagnosticsEnabled()) return;
	row(DUPLICATE_REPAIR_ROW, "rewriting the copy's id line");
}

/** A duplicate repair ending, and how. */
export function traceDuplicateRepairEnd(how: DuplicateRepairEnd): void {
	if (!diagnosticsEnabled()) return;
	row(DUPLICATE_REPAIR_ROW, `end: ${how}`);
}

/** The open note's ink read again from disk. */
export function traceInkReload(strokesChanged: boolean): void {
	if (!diagnosticsEnabled()) return;
	row(INK_RELOAD_ROW, `ink reread from disk, strokes changed=${yn(strokesChanged)}`);
}

/** A note's ink record dropped because the note no longer carries its page id. */
export function traceInkDropped(duplicateLocked: boolean): void {
	if (!diagnosticsEnabled()) return;
	row(INK_DROPPED_ROW, `ink record dropped (page id gone), duplicate locked=${yn(duplicateLocked)}`);
}

/** The editor view parts the caret read uses; each is optional. */
export interface CaretView {
	readonly state?: { selection: { main: { head: number } }; doc: { lineAt(pos: number): { number: number } } };
	lineBlockAt?(pos: number): { top: number };
	readonly documentTop?: number;
}

/** The selection head's line and its top in the scroller's content, as `line=N top=T`; `?` where it cannot be read. */
export function caretNote(view: CaretView, scroller: { scrollTop: number; getBoundingClientRect?(): { top: number } } | null): string {
	let line = "?";
	let top = "?";
	try {
		const state = view.state;
		if (!state) return `line=${line} top=${top}`;
		const head = state.selection.main.head;
		line = String(state.doc.lineAt(head).number);
		if (scroller?.getBoundingClientRect && view.lineBlockAt) {
			const docTop = view.documentTop;
			const at = view.lineBlockAt(head).top + (docTop ?? Number.NaN) - scroller.getBoundingClientRect().top + scroller.scrollTop;
			if (Number.isFinite(at)) top = String(Math.round(at));
		}
	} catch {
		// A view torn down mid-read gives what was read so far.
	}
	return `line=${line} top=${top}`;
}
